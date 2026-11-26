/* Headless checks for the Deepdelve engine (crawler-engine.js + crawler-data.js).
 * Not loaded by the app. Run: node txt/widgets/crawler/crawler.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var E = require('./crawler-engine.js');
var D = E.D, T = E.T;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function hero(cls, lvl, diff) { var h = E.newHero(cls || 'warrior', 'Test', diff || 'normal', E.rng(7)); if (lvl) h.level = lvl; h.hp = E.stats(h).maxHp; return h; }
// an empty walled arena for combat tests
function arena(h, o) {
  o = o || {};
  var G = E.newRunShell(h, { seed: o.seed || 1 });
  G.depth = o.depth || 3; G.biome = 'crypt'; G.ml = o.ml || G.depth; G.boss = false;
  G.t = []; for (var y = 0; y < G.h; y++) for (var x = 0; x < G.w; x++) G.t.push(x === 0 || y === 0 || x === G.w - 1 || y === G.h - 1 ? T.WALL : T.FLOOR);
  G.seen = G.t.map(function () { return 0; });
  G.p.x = 10; G.p.y = 10; G.start = [10, 10];
  var s = E.stats(h, G); G.p.hp = s.maxHp; G.p.res = s.maxRes;
  E.computeFov(G);
  return G;
}

// ---------------------------------------------------------------- data integrity
test('every class is complete', function () {
  assert.strictEqual(D.CLASS_ORDER.length, 6);
  D.CLASS_ORDER.forEach(function (k) {
    var c = D.CLASSES[k];
    assert.ok(c.res && c.res.name && c.res.max > 0, k + ' resource');
    assert.strictEqual(c.abilities.length, 5, k + ' has 5 abilities');
    c.abilities.forEach(function (a) { assert.ok(D.ABILITIES[a], 'ability ' + a); });
    assert.strictEqual(D.TALENTS[k].length, 5, k + ' talent tiers');
    D.TALENTS[k].forEach(function (tier) { assert.strictEqual(tier.length, 3); tier.forEach(function (t) { assert.ok(t.id && t.name && t.desc && (t.mods || t.flag || t.cheat || t.lowhp), t.id); }); });
    c.weapons.forEach(function (w) { assert.strictEqual(D.BASES[w].slot, 'weapon'); });
    assert.ok(D.BASES[c.kit.weapon] && D.BASES[c.kit.armor]);
  });
});
test('content tables are consistent', function () {
  D.BIOME_ORDER.forEach(function (b) { var B = D.BIOMES[b]; B.mons.forEach(function (m) { assert.ok(D.MONSTERS[m], m); }); assert.ok(D.BOSSES[B.boss], B.boss); B.traps.forEach(function (t) { assert.ok(D.TRAPS[t], t); }); });
  for (var u in D.UNIQUES) assert.ok(D.BASES[D.UNIQUES[u].base], u);
  for (var s in D.SETS) for (var sl in D.SETS[s].pieces) assert.strictEqual(D.BASES[D.SETS[s].pieces[sl][0]].slot, sl, s + ' ' + sl);
  D.EVENT_ORDER.forEach(function (e) { assert.ok(D.EVENTS[e] && D.EVENTS[e].choices.length >= 2, e); });
  assert.strictEqual(D.LORE.length, 25);
  for (var a = 1; a <= 5; a++) assert.strictEqual(D.LORE.filter(function (l) { return l.act === a; }).length, 5);
  for (var q in D.SIDEQUESTS) assert.ok(D.NPCS[D.SIDEQUESTS[q].giver], q);
  D.TOWN_ORDER.forEach(function (n) { assert.ok(D.NPCS[n].lines[0], n); });
});
test('rng is deterministic', function () {
  var a = E.rng(42), b = E.rng(42), xs = [], ys = [];
  for (var i = 0; i < 20; i++) { xs.push(E.rf(a)); ys.push(E.rf(b)); }
  assert.deepStrictEqual(xs, ys);
  assert.ok(xs.every(function (x) { return x >= 0 && x < 1; }));
});

// ---------------------------------------------------------------- puzzles: proven solvable
function solveBoulders(rows) {
  var H = rows.length, W = rows[0].length, start = null, boulders = [], plates = [];
  function wall(x, y) { var c = rows[y] && rows[y][x]; return !c || c === '#' || c === 'G' || c === 'C' || c === 'L' || c === 'T' || c === 'E'; }
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
    var c = rows[y][x];
    if (c === 'E') start = [x + (x === 0 ? 1 : x === W - 1 ? -1 : 0), y + (y === 0 ? 1 : y === H - 1 ? -1 : 0)];
    if (c === 'B') boulders.push(x + ',' + y);
    if (c === '_') plates.push(x + ',' + y);
  }
  var key = function (p, bs) { return p + '|' + bs.slice().sort().join(';'); };
  var q = [[start.join(','), boulders]], seen = {}; seen[key(q[0][0], boulders)] = 1;
  while (q.length) {
    var st = q.shift(), pp = st[0].split(',').map(Number), bs = st[1];
    if (plates.every(function (pl) { return bs.indexOf(pl) >= 0; })) return true;
    for (var k = 0; k < 4; k++) {
      var d = E.DIRS4[k], nx = pp[0] + d[0], ny = pp[1] + d[1];
      if (wall(nx, ny)) continue;
      var nb = bs.slice(), bi = nb.indexOf(nx + ',' + ny);
      if (bi >= 0) { var bx = nx + d[0], by = ny + d[1]; if (wall(bx, by) || nb.indexOf(bx + ',' + by) >= 0) continue; nb[bi] = bx + ',' + by; }
      var kk = key(nx + ',' + ny, nb); if (seen[kk]) continue; seen[kk] = 1;
      q.push([nx + ',' + ny, nb]);
      if (q.length > 300000) return false;
    }
  }
  return false;
}
test('every boulder template (and every flip) is solvable', function () {
  ['boulder1', 'boulder2'].forEach(function (name) {
    [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(function (f) {
      var rows = E.TPL[name].slice(); if (f[1]) rows.reverse(); if (f[0]) rows = rows.map(function (s) { return s.split('').reverse().join(''); });
      assert.ok(solveBoulders(rows), name + ' flip ' + f);
    });
  });
});
test('generated floors are connected, puzzles reachable, nothing walls you in', function () {
  var h = hero('warrior', 10);
  var safe = function (G) { return function (x, y) { var t = E.tile(G, x, y); return E.WALKABLE[t] && t !== T.LAVA && t !== T.CHASM && !(E.blocksObj(G, x, y) && E.blocksObj(G, x, y).k !== 'boulder'); }; };
  for (var d = 1; d <= 30; d++) for (var seed = 1; seed <= 12; seed++) {
    var G = E.startRun(h, d, { seed: seed * 977 + d });
    assert.ok(E.WALKABLE[E.tile(G, G.p.x, G.p.y)], 'start walkable');
    if (G.boss) { assert.strictEqual(G.mons.filter(function (m) { return m.boss; }).length, 1, 'one boss'); continue; }
    assert.ok(G.stairs, 'stairs exist d' + d);
    var reach = E.flood(G, G.start[0], G.start[1], safe(G));
    var sealed = Object.keys(G.pz).some(function (k) { return G.pz[k].kind === 'stairvault' && !G.pz[k].solved; });
    // levers next to reachable floor
    G.objs.filter(function (o) { return o.k === 'lever' && !o.reset; }).forEach(function (o) {
      assert.ok(E.DIRS4.some(function (dd) { return reach[(o.y + dd[1]) * G.w + o.x + dd[0]]; }), 'lever reachable d' + d + ' s' + seed);
    });
    if (!sealed) assert.ok(reach[G.stairs[1] * G.w + G.stairs[0]], 'stairs reachable d' + d + ' s' + seed);
    else {
      // solve every lever puzzle, then the stairs must be reachable
      Object.keys(G.pz).forEach(function (k) { G.pz[k].gates.forEach(function (g) { G.t[g[1] * G.w + g[0]] = T.OGATE; }); });
      var r2 = E.flood(G, G.start[0], G.start[1], safe(G));
      assert.ok(r2[G.stairs[1] * G.w + G.stairs[0]], 'sealed stairs reachable after solving d' + d);
    }
    Object.keys(G.pz).forEach(function (k) {
      var P = G.pz[k];
      if (P.kind === 'rune') { assert.strictEqual(G.objs.filter(function (o) { return o.k === 'rune' && o.pz === +k; }).length, 4); assert.strictEqual(P.order.length, 4); }
    });
  }
});
test('rune puzzle: right order opens the gate, wrong order hurts and resets', function () {
  var h = hero('rogue', 8);
  for (var seed = 1; seed < 400; seed++) {
    var G = E.startRun(h, 7, { seed: seed });
    var pzk = Object.keys(G.pz).filter(function (k) { return G.pz[k].kind === 'rune'; })[0];
    if (!pzk) continue;
    var P = G.pz[pzk], runes = G.objs.filter(function (o) { return o.k === 'rune' && o.pz === +pzk; });
    G.mons = [];
    var bySym = {}; runes.forEach(function (o) { bySym[o.sym] = o; });
    var wrong = bySym[P.order[1]], hp0 = G.p.hp;
    G.p.x = wrong.x; G.p.y = wrong.y; E.act(G, { t: 'wait' }); // standing doesn't press; stepping does
    G.p.x = wrong.x - 1; G.p.y = wrong.y;
    if (E.tile(G, G.p.x, G.p.y) !== T.FLOOR) { G.p.x = wrong.x + 1; }
    E.act(G, { t: 'move', dx: wrong.x - G.p.x, dy: 0 });
    assert.ok(G.p.hp < hp0, 'wrong rune zaps');
    assert.strictEqual(P.prog, 0);
    P.order.forEach(function (sym) { var o = bySym[sym]; G.p.x = o.x; G.p.y = o.y; G.modal = null; E.act(G, { t: 'wait' }); });
    // stepOn only fires on moves; press them properly
    P.order.forEach(function (sym) {
      var o = bySym[sym]; G.modal = null;
      var from = E.DIRS4.map(function (d) { return [o.x - d[0], o.y - d[1], d]; }).filter(function (q) { return E.tile(G, q[0], q[1]) === T.FLOOR && !E.blocksObj(G, q[0], q[1]) && !G.objs.some(function (x) { return x.x === q[0] && x.y === q[1] && x.k === 'rune'; }); })[0];
      G.p.x = from[0]; G.p.y = from[1]; E.act(G, { t: 'move', dx: from[2][0], dy: from[2][1] });
    });
    assert.ok(P.solved, 'solved');
    P.gates.forEach(function (g) { assert.strictEqual(E.tile(G, g[0], g[1]), T.OGATE); });
    return;
  }
  assert.fail('no rune floor found');
});

// ---------------------------------------------------------------- combat
test('armor mitigates, crits and xp work', function () {
  var h = hero('warrior', 5), G = arena(h);
  var m = E.spawnMon(G, 'skeleton', 11, 10, { aware: true });
  var hp0 = m.hp;
  E.act(G, { t: 'move', dx: 1, dy: 0 });
  assert.ok(m.hp < hp0 || m.hp <= 0, 'bump hurts');
  var xp0 = h.xp, lv0 = h.level;
  for (var i = 0; i < 20 && G.mons.indexOf(m) >= 0; i++) { G.p.hp = 999; E.act(G, { t: 'move', dx: 1, dy: 0 }); }
  assert.ok(G.mons.indexOf(m) < 0, 'killed');
  assert.ok(h.xp > xp0 || h.level > lv0, 'xp gained');
  assert.ok(h.bestiary.skeleton >= 1);
  // more armor, less damage
  var a1 = arena(hero('warrior', 5)), soft = E.spawnMon(a1, 'brute', 11, 10, { aware: true });
  var tot1 = 0, tot2 = 0;
  for (i = 0; i < 200; i++) { a1.p.hp = 9999; tot1 += E.strike(a1, soft, a1.p, { mult: 1, kind: 'melee', noDodge: true }); }
  var h2 = hero('warrior', 5); h2.equip.armor = E.makeItem(E.rng(3), { base: 'plate', ilvl: 30, rarity: 'epic' });
  var a2 = arena(h2), soft2 = E.spawnMon(a2, 'brute', 11, 10, { aware: true });
  for (i = 0; i < 200; i++) { a2.p.hp = 9999; tot2 += E.strike(a2, soft2, a2.p, { mult: 1, kind: 'melee', noDodge: true }); }
  assert.ok(tot2 < tot1 * 0.8, 'plate armor reduces damage (' + tot1 + ' vs ' + tot2 + ')');
});
test('level ups raise stats and unlock abilities + talent points', function () {
  var h = hero('mage', 1), s1 = E.stats(h);
  E.gainXp(null, h, 5000);
  var s2 = E.stats(h);
  assert.ok(h.level > 5 && s2.maxHp > s1.maxHp && s2.pow > s1.pow && s2.maxRes > s1.maxRes);
  assert.ok(E.abilitiesFor(h).filter(function (a) { return a.known; }).length >= 4);
  assert.ok(E.talentPoints(h) >= 1);
  assert.ok(E.chooseTalent(h, 0, D.TALENTS.mage[0][0].id));
  assert.ok(!E.chooseTalent(h, 0, D.TALENTS.mage[0][1].id), 'one pick per tier');
  assert.ok(!E.chooseTalent(h, 4, D.TALENTS.mage[4][0].id) || h.level >= 18, 'tier level gate');
  assert.ok(E.stats(h).maxRes > s2.maxRes, 'Arcane Mind raises mana');
});
test('every ability of every class works in an arena', function () {
  D.CLASS_ORDER.forEach(function (cls) {
    var h = hero(cls, 20), G = arena(h, { ml: 8 });
    D.CLASSES[cls].abilities.forEach(function (id) {
      G.mons = []; G.objs = []; G.delayed = []; G.p.cd = {}; G.p.st = {};
      var s = E.stats(h, G); G.p.res = s.maxRes; G.p.hp = s.maxHp; G.p.x = 10; G.p.y = 10;
      var a = E.spawnMon(G, 'skeleton', 11, 10, { aware: true }), b = E.spawnMon(G, 'skeleton', 10, 12, { aware: true }), c = E.spawnMon(G, 'skeleton', 10, 14, { aware: true });
      G.objs.push({ k: 'corpse', x: 12, y: 11, ch: 's', col: '#fff', fam: 'undead', oid: 999 });
      E.computeFov(G);
      var A = D.ABILITIES[id], before = G.p.res, used;
      if (A.target === 'self') used = E.act(G, { t: 'ability', id: id });
      else {
        var tg = E.abilityTargets(G, id);
        assert.ok(tg.def, cls + ':' + id + ' has a default target');
        used = E.act(G, { t: 'ability', id: id, x: tg.def.x, y: tg.def.y });
      }
      assert.ok(used, cls + ':' + id + ' was used');
      assert.ok(G.p.res <= before || A.gain || id === 'quickshot', cls + ':' + id + ' spent its resource');
      if (A.cd) assert.ok(G.p.cd[id] > 0, cls + ':' + id + ' went on cooldown');
    });
  });
});
test('telegraphed slams can be dodged by stepping away', function () {
  var h = hero('warrior', 6), G = arena(h);
  var m = E.spawnMon(G, 'brute', 11, 10, { aware: true }); m.energy = 0; m.cd = {};
  E.act(G, { t: 'wait' });
  assert.ok(m.intent && m.intent.k === 'slam', 'brute winds up');
  assert.ok(m.intent.tiles.some(function (q) { return q[0] === 10 && q[1] === 10; }), 'player tile marked');
  var hp0 = G.p.hp;
  E.act(G, { t: 'move', dx: -1, dy: 0 });   // step out of the 3×3
  assert.ok(!m.intent, 'slam resolved');
  assert.strictEqual(G.p.hp, hp0, 'dodged');
  // and standing in it hurts
  var G2 = arena(hero('warrior', 6)), m2 = E.spawnMon(G2, 'brute', 11, 10, { aware: true }); m2.energy = 0;
  E.act(G2, { t: 'wait' }); var h0 = G2.p.hp; E.act(G2, { t: 'wait' });
  assert.ok(G2.p.hp < h0, 'standing in it hurts');
});
test('stunning a monster interrupts its wind-up', function () {
  var h = hero('warrior', 6), G = arena(h), m = E.spawnMon(G, 'brute', 11, 10, { aware: true }); m.energy = 0;
  E.act(G, { t: 'wait' }); assert.ok(m.intent);
  E.addStatus(G, m, 'stun', 1);
  assert.ok(!m.intent, 'interrupted');
});
test('elites have affixes, more health and drop loot', function () {
  var h = hero('warrior', 30), G = arena(h, { ml: 5 });
  var n = E.spawnMon(G, 'skeleton', 15, 15, {}), e = E.spawnMon(G, 'skeleton', 17, 17, { elite: ['vampiric', 'hasted'] });
  assert.ok(e.maxHp > n.maxHp * 2 && e.spd > n.spd);
  assert.ok(E.displayName(e).indexOf('Vampiric') === 0);
  var items = G.objs.length; e.hp = 1; E.strike(G, G.p, e, { flat: 5, kind: 'true' });
  assert.ok(G.objs.filter(function (o) { return o.k === 'item'; }).length >= 1, 'elite drops an item');
});
test('splitting monsters split', function () {
  var h = hero('warrior', 30), G = arena(h, { ml: 22 });
  var v = E.spawnMon(G, 'voidspawn', 15, 15, { aware: true }); v.hp = 1;
  E.strike(G, G.p, v, { flat: 5, kind: 'true' });
  assert.strictEqual(G.mons.filter(function (m) { return m.k === 'voidspawn'; }).length, 2);
});
test('cheat-death talents save you once per floor', function () {
  var h = hero('warrior', 20); h.talents[4] = 'w_undying';
  var G = arena(h), m = E.spawnMon(G, 'skeleton', 11, 10, { aware: true });
  E.strike(G, m, G.p, { flat: 99999, kind: 'true' });
  assert.ok(!G.over && G.p.hp > 0, 'survived once');
  E.strike(G, m, G.p, { flat: 99999, kind: 'true' });
  assert.strictEqual(G.over, 'dead', 'not twice');
});

// ---------------------------------------------------------------- bosses + story
test('a boss fight: intro, phases, story progress, portal home', function () {
  var h = hero('warrior', 8), G = E.startRun(h, 5, { seed: 11 });
  assert.ok(G.boss);
  var b = G.mons.filter(function (m) { return m.boss; })[0];
  assert.strictEqual(b.boss, 'callum');
  // walk up until the intro triggers
  for (var i = 0; i < 80 && !G.modal; i++) { if (!E.act(G, { t: 'move', dx: 0, dy: -1 })) E.act(G, { t: 'wait' }); G.p.hp = 999; }
  assert.ok(G.modal && G.modal.k === 'dialog' && G.modal.intro, 'intro dialog');
  E.closeModal(G);
  b.hp = Math.round(b.maxHp * 0.6); E.strike(G, G.p, b, { flat: Math.round(b.maxHp * 0.15), kind: 'true' });
  assert.strictEqual(b.phase, 1, 'phase two');
  E.strike(G, G.p, b, { flat: b.maxHp, kind: 'true' });
  assert.strictEqual(h.story.cleared, 1);
  assert.ok(G.modal && G.modal.k === 'dialog' && G.modal.outro);
  var portal = false, stairs = false; for (var k = 0; k < G.t.length; k++) { if (G.t[k] === T.PORTAL) portal = true; if (G.t[k] === T.STAIRS) stairs = true; }
  assert.ok(portal && stairs);
  assert.ok(h.mats.soul >= 1);
});
test('final boss ends the story; New Game+ restarts it harder', function () {
  var h = hero('cleric', 28); h.story.cleared = 4; h.story.deepest = 25;
  var G = E.startRun(h, 25, { seed: 3 }), b = G.mons.filter(function (m) { return m.boss; })[0];
  assert.strictEqual(b.boss, 'aurel');
  E.strike(G, G.p, b, { flat: b.maxHp * 2, kind: 'true' });
  assert.ok(h.story.ended && h.story.cleared === 5 && G.ending);
  var ml1 = G.ml;
  assert.ok(E.newGamePlus(h));
  assert.strictEqual(h.story.ng, 1); assert.strictEqual(h.story.cleared, 0);
  var G2 = E.startRun(h, 1, { seed: 3 });
  assert.ok(G2.ml >= 26, 'NG+ monsters are far stronger');
  var G3 = E.startRun(hero('cleric', 28), 30, { seed: 3 });
  assert.strictEqual(E.biomeAt(30), 'crypt'); assert.ok(G3.ml === 30 && ml1 === 25);
});
test('npc lines evolve with the story', function () {
  var h = hero('warrior', 3);
  var a = E.npcLine(h, 'maren', null); h.story.cleared = 3; var b = E.npcLine(h, 'maren', null);
  assert.notStrictEqual(a, b);
  h.story.ended = true; assert.strictEqual(E.storyStage(h), 6);
});

// ---------------------------------------------------------------- items + town
test('items: rarity, affixes, uniques, sets, upgrades, salvage', function () {
  var r = E.rng(5), counts = {};
  for (var i = 0; i < 600; i++) { var it = E.makeItem(r, { ilvl: 20, luck: 0.5 }); counts[it.rarity] = (counts[it.rarity] || 0) + 1; assert.ok(it.name && D.BASES[it.base]); }
  assert.ok(counts.common && counts.magic && counts.rare && counts.epic, JSON.stringify(counts));
  var u = E.makeItem(r, { rarity: 'legendary', ilvl: 15, act: 3 }); assert.ok(u.uq && D.UNIQUES[u.uq]);
  var st = E.makeItem(r, { rarity: 'set', ilvl: 15, act: 3 }); assert.ok(st.set);
  var h = hero('warrior', 10); h.gold = 99999; h.mats = { scrap: 99, dust: 99, soul: 99 };
  var w = h.equip.weapon, m0 = E.mainValue(w);
  assert.ok(E.upgradeItem(h, w.uid).ok); assert.ok(E.mainValue(w) > m0);
  var junk = E.makeItem(r, { slot: 'armor', ilvl: 12, rarity: 'rare' }); h.bag.push(junk);
  var y = E.salvageItem(h, junk.uid); assert.ok(y.scrap >= 1 && y.dust === 1);
  var w2 = E.makeItem(r, { base: 'axe', ilvl: 30, rarity: 'epic' }); h.bag.push(w2);
  assert.ok(E.equip(h, w2.uid)); assert.strictEqual(h.equip.weapon, w2); assert.ok(h.bag.indexOf(w) >= 0);
  var dag = E.makeItem(r, { base: 'dagger', ilvl: 5 }); h.bag.push(dag); assert.ok(!E.equip(h, dag.uid), 'warriors cannot use daggers');
  var stock = E.shopStock(h); assert.strictEqual(stock.items.length, 6);
  var g0 = h.gold; assert.ok(E.buy(h, stock.cons[0]).ok); assert.ok(h.gold < g0);
});
test('set bonuses apply', function () {
  var h = hero('rogue', 15), r = E.rng(9), s0 = E.stats(h);
  ['helm', 'armor', 'charm'].forEach(function (sl) { var it = E.makeItem(r, { rarity: 'set', slot: sl, ilvl: 15, act: 3 }); });
  var S = D.SETS.shadow;
  h.equip.helm = { uid: 'a', base: S.pieces.helm[0], slot: 'helm', rarity: 'set', set: 'shadow', ilvl: 15, plus: 0, aff: {} };
  h.equip.armor = { uid: 'b', base: S.pieces.armor[0], slot: 'armor', rarity: 'set', set: 'shadow', ilvl: 15, plus: 0, aff: {} };
  var s2 = E.stats(h); assert.ok(s2.dodge > s0.dodge + 0.05, '2-piece dodge');
  h.equip.charm = { uid: 'c', base: S.pieces.charm[0], slot: 'charm', rarity: 'set', set: 'shadow', ilvl: 15, plus: 0, aff: {} };
  assert.ok(E.stats(h).flags.s_shadow, '3-piece flag');
});
test('bounties track progress and pay out', function () {
  var h = hero('warrior', 10); h.quests.board = [];
  E.rollBoard(h); assert.strictEqual(h.quests.board.length, 3);
  var b = { id: 'bx', tpl: 'elite', need: 1, have: 0, done: false, name: 'x', text: 'x', reward: { gold: 100, xp: 10 } };
  h.quests.board[0] = b;
  var G = arena(h), e = E.spawnMon(G, 'skeleton', 12, 10, { elite: ['hasted'] }); e.hp = 1;
  E.strike(G, G.p, e, { flat: 5, kind: 'true' });
  assert.ok(b.done);
  var g0 = h.gold; assert.ok(E.claimBounty(h, 'bx')); assert.strictEqual(h.gold, g0 + 100); assert.strictEqual(h.quests.board.length, 3);
});
test('side quests: accept, find, turn in', function () {
  var h = hero('warrior', 4);
  assert.ok(E.acceptSide(h, 'locket'));
  var found = false;
  for (var seed = 1; seed < 40 && !found; seed++) { var G = E.startRun(h, 4, { seed: seed }); found = G.objs.some(function (o) { return o.k === 'quest' && o.q === 'locket'; }); }
  assert.ok(found, 'quest item spawns on floor 4 of act I');
  h.quests.side.locket = 'found';
  var got = E.turnInSide(h, 'locket'); assert.ok(got && got.length >= 2); assert.strictEqual(h.quests.side.locket, 'done');
});
test('events cost and reward', function () {
  var h = hero('warrior', 10); h.gold = 1000;
  var G = arena(h); G.objs.push({ k: 'event', id: 'bloodaltar', x: 11, y: 10, oid: 77, used: false });
  E.act(G, { t: 'move', dx: 1, dy: 0 });
  assert.ok(G.modal && G.modal.k === 'event');
  var hp0 = G.p.hp, r = E.eventChoice(G, 0);
  assert.ok(r.ok && G.p.hp < hp0 && h.bless.some(function (b) { return b.id === 'might'; }));
  assert.ok(G.objs.filter(function (o) { return o.oid === 77; })[0].used);
  assert.ok(E.stats(h).powPct >= 0.2);
});
test('death costs gold and fresh loot (but not on Relaxed)', function () {
  var h = hero('warrior', 5); h.gold = 1000;
  var it = E.makeItem(E.rng(1), { slot: 'helm', ilvl: 5 }); it.fresh = 1; h.bag.push(it);
  var old = E.makeItem(E.rng(2), { slot: 'helm', ilvl: 5 }); h.bag.push(old);
  var G = arena(h); var lost = E.applyDeath(G);
  assert.strictEqual(lost.gold, 250); assert.deepStrictEqual(lost.items, [it.name]); assert.strictEqual(h.bag.length, 1);
  var r = hero('warrior', 5, 'relaxed'); r.gold = 1000; var it2 = E.makeItem(E.rng(1), { slot: 'helm', ilvl: 5 }); it2.fresh = 1; r.bag.push(it2);
  E.applyDeath(arena(r)); assert.strictEqual(r.bag.length, 1); assert.strictEqual(r.gold, 900);
});

// ---------------------------------------------------------------- saves
test('a run survives a JSON round-trip', function () {
  var h = hero('necro', 9), G = E.startRun(h, 3, { seed: 99 });
  for (var i = 0; i < 30; i++) { var p = E.explorePath(G); if (p) E.act(G, { t: 'move', dx: p[0][0] - G.p.x, dy: p[0][1] - G.p.y }); G.modal = null; }
  var snap = JSON.parse(JSON.stringify(E.serializeRun(G))), G2 = E.loadRun(snap, h);
  assert.ok(G2);
  assert.deepStrictEqual(G2.t, G.t); assert.deepStrictEqual(G2.seen, G.seen);
  assert.strictEqual(G2.mons.length, G.mons.length); assert.strictEqual(G2.p.x, G.p.x); assert.strictEqual(G2.r.s, G.r.s);
  // and it keeps playing identically
  E.act(G, { t: 'wait' }); E.act(G2, { t: 'wait' });
  assert.deepStrictEqual(G2.mons.map(function (m) { return [m.x, m.y, m.hp]; }), G.mons.map(function (m) { return [m.x, m.y, m.hp]; }));
});
test('heroes normalize (and junk is rejected)', function () {
  var h = hero('ranger', 12); h.bag.push(E.makeItem(E.rng(4), { slot: 'charm', ilvl: 9, rarity: 'rare' }));
  var n = E.normHero(JSON.parse(JSON.stringify(h)));
  assert.strictEqual(n.cls, 'ranger'); assert.strictEqual(n.level, 12); assert.strictEqual(n.bag.length, 1); assert.strictEqual(n.equip.weapon.uid, h.equip.weapon.uid);
  var bad = E.normHero({ name: '<script>x', cls: 'pirate', level: 'x', bag: [{ base: 'nope' }], equip: { weapon: { base: 'bow' } }, talents: ['zzz'] });
  assert.strictEqual(bad.cls, 'warrior'); assert.strictEqual(bad.level, 1); assert.strictEqual(bad.bag.length, 0); assert.ok(bad.name.indexOf('<') < 0);
  assert.ok(bad.equip.weapon && D.CLASSES.warrior.weapons.indexOf(bad.equip.weapon.base) >= 0);
});
test('the legacy single hero migrates into a veteran slot', function () {
  var old = { v: 4, name: 'Old Delver', level: 14, xp: 50, gold: 1234, maxDepth: 21, difficulty: 'hard', trophies: ['catacombs', 'wood', 'caves'],
    owned: [{ uid: 'x1', base: 'runeblade', slot: 'weapon', rarity: 'epic', ilvl: 12 }, { uid: 'x2', base: 'plate', slot: 'armor', rarity: 'rare', ilvl: 8 }, { uid: 'x3', base: 'lucky', slot: 'trinket', rarity: 'legendary', ilvl: 10 }],
    stash: [{ uid: 'x4', base: 'staff', slot: 'weapon', rarity: 'magic', ilvl: 5 }], bag: { potion: 4, elixir: 2, bomb: 1, key: 1 }, mats: { herb: 6, crystal: 3, ore: 5 },
    stats: { kills: 321, deaths: 7, floors: 40, runs: 12 }, createdAt: 123 };
  var h = E.migrateLegacy(old);
  assert.ok(h.needsClass && h.flags.veteran);
  assert.strictEqual(h.level, 14); assert.strictEqual(h.gold, 1234); assert.strictEqual(h.difficulty, 'hard');
  assert.strictEqual(h.story.cleared, 3); assert.deepStrictEqual(h.story.waypoints, [1, 6, 11, 16]);
  assert.strictEqual(h.stats.kills, 321); assert.strictEqual(h.legacy.length, 4); assert.strictEqual(h.cons.potion, 4);
  var n = E.normHero(JSON.parse(JSON.stringify(h))); assert.ok(n.needsClass && n.legacy.length === 4, 'survives a save');
  assert.ok(E.setClass(n, 'ranger'));
  assert.ok(!n.needsClass && n.cls === 'ranger' && n.equip.weapon.base === 'bow');
  assert.ok(n.bag.length + 2 >= 4, 'old gear reforged');
  assert.ok(E.migrateLegacy(null) === null && E.migrateLegacy({}) === null);
});
test('roster merge: best copy per hero, deletions win, newer stash, best dailies', function () {
  var a = E.newRoster(), b = E.newRoster();
  var h1 = hero('warrior', 5); h1.id = 'h1'; var h1b = JSON.parse(JSON.stringify(h1)); h1b.level = 9;
  var h2 = hero('mage', 3); h2.id = 'h2';
  a.slots.h1 = h1; a.order = ['h1']; a.active = 'h1';
  b.slots.h1 = h1b; b.slots.h2 = h2; b.order = ['h1', 'h2'];
  a.stash = [E.makeItem(E.rng(1), { slot: 'helm', ilvl: 3 })]; a.stashRev = 5; b.stashRev = 2;
  a.daily.days['2026-01-01'] = { best: 100, tries: 2 }; b.daily.days['2026-01-01'] = { best: 300, tries: 1 };
  var m = E.mergeRoster(a, b);
  assert.strictEqual(m.slots.h1.level, 9); assert.ok(m.slots.h2); assert.strictEqual(m.active, 'h1');
  assert.strictEqual(m.stash.length, 1); assert.strictEqual(m.daily.days['2026-01-01'].best, 300); assert.strictEqual(m.daily.days['2026-01-01'].tries, 2);
  b.deleted = { h2: Date.now() };
  var m2 = E.mergeRoster(m, b); assert.ok(!m2.slots.h2 && m2.order.indexOf('h2') < 0);
  var m3 = E.mergeRoster(m2, m); assert.ok(!m3.slots.h2, 'deletion sticks');
});
test('daily challenge is seeded and records the best', function () {
  var i1 = E.dailyInfo('2026-11-25'), i2 = E.dailyInfo('2026-11-25'), i3 = E.dailyInfo('2026-11-26');
  assert.deepStrictEqual(i1, i2); assert.ok(i1.seed !== i3.seed);
  var h = E.dailyHero(i1), G = E.startRun(h, 1, { daily: i1, seed: i1.seed }), G2 = E.startRun(E.dailyHero(i1), 1, { daily: i1, seed: i1.seed });
  assert.deepStrictEqual(G.t, G2.t, 'same dungeon for everyone');
  assert.strictEqual(G.mode, 'daily'); assert.strictEqual(h.cls, i1.cls);
  var R = E.newRoster(), rec = E.recordDaily(R, i1, 500, 4);
  assert.ok(rec.best && rec.allTime); assert.ok(!E.recordDaily(R, i1, 200, 2).best); assert.strictEqual(R.daily.days[i1.date].tries, 2);
});
test('travel and explore paths are walkable', function () {
  var h = hero('rogue', 6), G = E.startRun(h, 2, { seed: 5 }); G.mons = [];
  for (var i = 0; i < 300; i++) { var p = E.explorePath(G); if (!p) break; assert.strictEqual(Math.abs(p[0][0] - G.p.x) + Math.abs(p[0][1] - G.p.y), 1); E.act(G, { t: 'move', dx: p[0][0] - G.p.x, dy: p[0][1] - G.p.y }); G.modal = null; G.p.hp = 999; }
  var seen = G.seen.reduce(function (a, b) { return a + b; }, 0);
  assert.ok(seen > 300, 'explored a good part of the floor (' + seen + ')');
});

// ---------------------------------------------------------------- clarity: healing, damage attribution, tutorial
test('no passive regeneration: waiting with no enemies does not heal; resting heals slowly and says why', function () {
  var h = hero('warrior', 5), G = arena(h), s = E.stats(h, G);
  G.p.hp = Math.round(s.maxHp * 0.5); var hp0 = G.p.hp;
  for (var i = 0; i < 30; i++) E.act(G, { t: 'wait' });
  assert.strictEqual(G.p.hp, hp0, 'waiting never heals');
  G.ev = [];
  E.act(G, { t: 'rest' });
  var gained = G.p.hp - hp0;
  assert.ok(gained > 0 && gained <= Math.ceil(s.maxHp * 0.04), 'one rest turn heals a little (' + gained + ')');
  var he = G.ev.filter(function (e) { return e.t === 'heal'; })[0];
  assert.ok(he && he.why === 'Rest', 'heal event says why');
  assert.ok(G.log.some(function (l) { return /Rest/.test(l.s) && l.c === 'heal'; }), 'heal is logged');
  // resting next to an awake enemy is just waiting
  var m = E.spawnMon(G, 'skeleton', 14, 10, { aware: true }); m.spd = 0; E.computeFov(G);
  var hp1 = G.p.hp; E.act(G, { t: 'rest' }); assert.strictEqual(G.p.hp, hp1, 'no resting with foes in sight');
});
test('level-ups heal only partly, and visibly', function () {
  var h = hero('mage', 1), G = arena(h), s = E.stats(h, G);
  G.p.hp = 1; G.ev = [];
  E.gainXp(G, h, E.xpForLevel(1));
  assert.ok(G.p.hp > 1 && G.p.hp < E.stats(h, G).maxHp * 0.5, 'partial heal (' + G.p.hp + ')');
  assert.ok(G.ev.some(function (e) { return e.t === 'heal' && e.why === 'Level up'; }));
});
test('every point of damage to the hero carries a source', function () {
  D.CLASS_ORDER.forEach(function (cls, ci) {
    var h = hero(cls, 9);
    for (var d = 1; d <= 12; d += 1) {
      var G = E.startRun(h, d, { seed: 50 + d * 13 + ci });
      for (var t = 0; t < 250 && !G.over; t++) {
        if (G.modal) { if (G.modal.k === 'event') E.eventChoice(G, 0); G.modal = null; continue; }
        var p = E.explorePath(G), hv = E.hostilesVisible(G);
        if (hv.length && Math.abs(hv[0].x - G.p.x) + Math.abs(hv[0].y - G.p.y) === 1) E.act(G, { t: 'move', dx: hv[0].x - G.p.x, dy: hv[0].y - G.p.y });
        else if (p) E.act(G, { t: 'move', dx: p[0][0] - G.p.x, dy: p[0][1] - G.p.y });
        else E.act(G, { t: 'wait' });
        G.ev.forEach(function (e) { if (e.t === 'dmg' && e.p) assert.ok(e.src && e.src !== 'Unknown', 'unattributed damage: ' + JSON.stringify(e)); });
        G.ev = [];
        if (G.p.hp < 30) G.p.hp = 999;
      }
    }
  });
});
test('DoTs name what applied them', function () {
  var h = hero('warrior', 5), G = arena(h), m = E.spawnMon(G, 'ghoul', 11, 10, { aware: true });
  E.addStatus(G, G.p, 'poison', 3, 4, 'Ghoul'); G.ev = [];
  m.spd = 0; E.act(G, { t: 'move', dx: -1, dy: 0 });
  var e = G.ev.filter(function (x) { return x.t === 'dmg' && x.p; })[0];
  assert.ok(e && /Poison \(Ghoul\)/.test(e.src), e && e.src);
  assert.ok(G.p.hits.length && /Poison/.test(G.p.hits[G.p.hits.length - 1].src));
});
test('floors 1–2 are a gentle tutorial', function () {
  for (var seed = 1; seed <= 25; seed++) {
    var h = hero('warrior', 1);
    var G1 = E.startRun(h, 1, { seed: seed });
    var foes1 = G1.mons.filter(function (m) { return !m.ally; });
    assert.ok(foes1.length >= 2 && foes1.length <= 4, 'floor 1 foes ' + foes1.length);
    assert.ok(foes1.every(function (m) { return !m.elite && (m.k === 'rat' || m.k === 'skeleton'); }), 'only rats and skeletons, no elites');
    assert.ok(!G1.objs.some(function (o) { return o.k === 'trap' || o.k === 'event' || o.k === 'vent'; }), 'no traps, events or vents on floor 1');
    assert.ok(G1.objs.some(function (o) { return o.k === 'cons' && o.id === 'potion'; }), 'a potion to find');
    assert.strictEqual(Object.keys(G1.pz).length, 0, 'no puzzle on floor 1');
    var G2 = E.startRun(h, 2, { seed: seed });
    var foes2 = G2.mons.filter(function (m) { return !m.ally; });
    assert.ok(foes2.length <= 6 && foes2.every(function (m) { return !m.elite && ['rat', 'skeleton', 'skarcher'].indexOf(m.k) >= 0; }));
    assert.ok(G2.objs.filter(function (o) { return o.k === 'trap'; }).every(function (o) { return !o.hidden && o.id === 'spike'; }), 'floor 2 traps are visible spikes');
    assert.ok(!G2.objs.some(function (o) { return o.k === 'event'; }));
    assert.ok(Object.keys(G2.pz).every(function (k) { return G2.pz[k].kind === 'vault'; }), 'floor 2: a lever vault, stairs never sealed');
    // hidden traps only from floor 6
    var G5 = E.startRun(hero('warrior', 6), 5 + (seed % 3 === 0 ? 0 : -1), { seed: seed });
    assert.ok(!G5.objs.some(function (o) { return o.k === 'trap' && o.hidden; }), 'no hidden traps before floor 6');
  }
});
test('early floors cap how many foes press the attack', function () {
  var h = hero('warrior', 3), G = arena(h, { depth: 1, ml: 1 }); G.mode = 'story';
  for (var i = 0; i < 6; i++) { var m = E.spawnMon(G, 'skeleton', 15 + i, 10, { aware: true }); m.energy = 0; }
  E.act(G, { t: 'wait' });
  var moved = G.mons.filter(function (m) { return !m.holding; }).length;
  assert.ok(moved <= 2, 'only two advance (' + moved + ')');
});

// ---------------------------------------------------------------- the widget file itself
test('crawler.js registers exactly what the manifest says', function () {
  var widget = null, css = [];
  global.window = { Cade: { loadCSS: function (p) { css.push(p); }, asset: function (p) { return p; }, registerWidget: function (w) { widget = w; } } };
  var src = fs.readFileSync(path.join(__dirname, 'crawler.js'), 'utf8');
  new Function('window', src)(global.window);
  delete global.window;
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === 'crawler'; })[0];
  assert.ok(widget && css[0] === 'crawler.css');
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(widget[k], man[k], k); });
  assert.ok(src.indexOf("'crawler-panel'") > 0);
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
