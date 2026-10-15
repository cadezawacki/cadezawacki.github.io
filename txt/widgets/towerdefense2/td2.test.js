/* Headless checks for Tower Defense V2 (Glyph Defense): the catalog, the maps,
 * wave generation, the damage rules and enemy traits, every tower shape, the
 * economy, save/restore, and deterministic bot playthroughs.
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/towerdefense2/td2.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var E = require('./td2-engine.js'), D = E.D, MP = E.MP, T = E.TKEY;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function near(a, b, eps, msg) { assert.ok(Math.abs(a - b) <= (eps || 1e-6), (msg || '') + ' expected ' + b + ' got ' + a); }
var ALL = E.TOWERS.map(function (t, i) { return i; });
// A game on map mi with every tower allowed in the loadout and plenty of gold.
function game(mi) { var g = E.newGame(mi || 0, {}, []); g.loadout = ALL.slice(); g.gold = 1e7; g.fxOn = false; return g; }
// A fake tower (damage source) at (x, y).
function src(x, y, st) { return { x: x, y: y, st: st || {}, bDmg: 0, armIgnore: 0, dmg: 0, kills: 0, type: 0 }; }
// An enemy on route ri at distance d, centred on the road (wave 1 unless L given).
function enemyAt(g, k, d, o) {
  o = o || {};
  if (g.phase === 'build') g.phase = 'wave';
  g.waveLeft[1] = (g.waveLeft[1] || 0) + 1;
  var e = E.spawnEnemy(g, k, 1, o.L || 1, o.ri || 0, d, o.orig !== false);
  e.lat = 0; e.seg = 0;
  if (o.hp != null) e.hp = e.maxHp = o.hp;
  E.placeEnemy(g, e); e.px = e.x; e.py = e.y;
  E.rebuildBuckets(g);
  return e;
}
function steps(g, sec) { var n = Math.round(sec / E.STEP); for (var i = 0; i < n && g.phase === 'wave'; i++) { E.step(g); g.events.length = 0; } }
// Best buildable cell for a tower type near route 0 (most road within radius 2).
function cellNearRoad(g, ty, ri, avoid) {
  var md = E.mapData(g.map), R = md.routes[ri || 0], best = null, bv = -1;
  for (var y = 0; y < md.h; y++) for (var x = 0; x < md.w; x++) {
    if (!E.canPlace(g, x, y, ty) || (avoid && avoid(x, y))) continue;
    var c = 0;
    for (var d = 0; d < R.len; d += 0.5) { var p = E.routePos(R, d, 0, {}), dx = p.x - x - 0.5, dy = p.y - y - 0.5; if (dx * dx + dy * dy <= 4) c++; }
    if (c > bv) { bv = c; best = [x, y]; }
  }
  return best;
}

// ---------------- registration ----------------
test('registers in the app with the manifest entry\'s name, and lazy-loads its three engine files', function () {
  var widget = null, assets = [];
  global.window = { Cade: { loadCSS: function () {}, asset: function (r) { assets.push(r); return './' + r; }, registerWidget: function (w) { widget = w; } } };
  delete require.cache[require.resolve('./td2.js')];
  require('./td2.js');
  delete global.window;
  assert.ok(widget && typeof widget.open === 'function', 'registered');
  var m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  var entry = m.modules.filter(function (x) { return x.id === 'towerdefense2'; })[0];
  assert.ok(entry, 'in the manifest');
  assert.strictEqual(entry.name, widget.name);
  assert.strictEqual(entry.description, widget.description);
  assert.strictEqual(entry.icon, widget.icon);
  assert.strictEqual(entry.tags, widget.tags);
  assert.strictEqual(entry.type, 'widget');
  assert.strictEqual(entry.entry, 'widgets/towerdefense2/td2.js');
  assert.strictEqual(entry.css, 'widgets/towerdefense2/td2.css');
  assert.deepStrictEqual(assets.sort(), ['td2-data.js', 'td2-engine.js', 'td2-maps.js']);
  entry.precache.forEach(function (p) { assert.ok(fs.existsSync(path.join(__dirname, '..', '..', p)), p); });
  assert.deepStrictEqual(entry.precache.map(function (p) { return p.split('/').pop(); }).sort(), assets);
  assert.ok(m.modules.some(function (x) { return x.id === 'towerdefense'; }), 'the original Tower Defense stays');
});

// ---------------- the catalog ----------------
test('enemies: 74 glyphs — a–z, A–Z, 0–9, ?, ! and ten bosses; rank means strength', function () {
  assert.strictEqual(D.EORDER.length, 74);
  var lower = 'abcdefghijklmnopqrstuvwxyz', bosses = '@Ω₩₼₷&%¶¤※';
  for (var i = 0; i < 26; i++) {
    var a = E.ENEMIES[lower[i]], A = E.ENEMIES[lower[i].toUpperCase()];
    assert.ok(a && A, lower[i]);
    assert.ok(A.cap && A.lower === lower[i] && A.split >= 1 && A.split <= 6, 'capital splits into its lowercase');
    assert.ok(A.hp > a.hp, A.g + ' tougher than ' + a.g);
    assert.ok(A.lives >= A.split * a.lives, A.g + ' leak costs at least its children');
    if (i) { assert.ok(a.hp > E.ENEMIES[lower[i - 1]].hp, a.g + ' outranks ' + lower[i - 1]); assert.ok(A.hp > E.ENEMIES[lower[i - 1].toUpperCase()].hp); }
  }
  for (i = 0; i < 10; i++) assert.ok(E.ENEMIES[String(i)], 'digit ' + i);
  assert.ok(E.ENEMIES['?'] && E.ENEMIES['!']);
  for (i = 0; i < bosses.length; i++) assert.ok(E.ENEMIES[bosses[i]] && E.ENEMIES[bosses[i]].boss, bosses[i]);
  D.EORDER.forEach(function (k) {
    var e = E.ENEMIES[k];
    assert.ok(e.name && e.hp > 0 && e.spd > 0 && e.lives > 0 && e.bounty > 0 && e.threat > 0 && e.note, k);
    assert.ok(e.weak >= -1 && e.weak < 7, k + ' weakness');
    assert.strictEqual(e.res.length, 7);
  });
});
test('towers: 40, each with three upgrades and three final branches; glyphs are theirs alone', function () {
  assert.strictEqual(E.TOWERS.length, 40);
  var keys = {}, glyphs = {}, cats = { atk: 0, ctl: 0, sup: 0, eco: 0 };
  E.TOWERS.forEach(function (Tw, i) {
    assert.ok(!keys[Tw.key] && !glyphs[Tw.g], 'unique ' + Tw.key); keys[Tw.key] = 1; glyphs[Tw.g] = 1;
    assert.ok(!E.ENEMIES[Tw.g], Tw.g + ' is not also an enemy glyph');
    assert.ok(Tw.cat in cats, Tw.key + ' category'); cats[Tw.cat]++;
    assert.ok(/^[GHSW]+$/.test(Tw.land), Tw.key + ' terrain');
    assert.ok(Tw.cost > 0 && Tw.ups.length === 3 && Tw.brs.length === 3, Tw.key);
    Tw.ups.forEach(function (u) { assert.ok(u[0] > 0, Tw.key + ' upgrade cost'); });
    Tw.brs.forEach(function (b) { assert.ok(b[0] && b[1] > 0 && b[2], Tw.key + ' branch'); });
    if (E.isAttack(i)) {
      var t0 = E.towerStat(i, 0), t3 = E.towerStat(i, 3);
      assert.ok(t0.dmg > 0 && t0.int > 0 && t0.range > 0, Tw.key + ' base attack');
      assert.ok(t3.dmg / t3.int > t0.dmg / t0.int, Tw.key + ' upgrades raise damage per second');
      for (var b = 0; b < 3; b++) { var sb = E.towerStat(i, 4, b); assert.ok(sb.dmg > 0 && sb.range > 0, Tw.key + ' branch ' + b); }
    }
  });
  assert.deepStrictEqual(cats, { atk: 20, ctl: 9, sup: 7, eco: 4 });
});
test('tower stats only use keys the engine knows', function () {
  var KNOWN = ('dmg int range minR pspd pierce maxT splash flight multi sec burst burstGap focusT focusB resPen det revealHit slow slowDur freezeN freezeDur ' +
    'brittle brittleDur burn burnDur regenCut corrode corrodeDur armRed armRedDur resCut stun stunCd silence silenceCd chain chainR keep chains cone pen lineW lines ' +
    'retMul fan drones xfer orbitW blades mines mineLife trigR groundMul shieldMul execute ghostB after afterT crater craterDur wake wakeDur cluster every5 tgt shape ' +
    'linger exSlow cap supRed cleanse haste dmgB armIgnore rangeB pspdB echo echoCd ric pads anyPad padRange pulseR armBreak armBreakDur noRegen field fieldDur pull ' +
    'tele strip stripDur strips wet wetDur wetSlow land drain lockSh bossSlow bossSlowDur delay income relief bonds bankCap bankRate bankMax dividend markEvery markDur ' +
    'marks markPay markMax markElite markVuln salvage salvageMax leakPay leakMax auto').split(' ');
  E.TOWERS.forEach(function (Tw) {
    var sets = [Tw.base].concat(Tw.ups.map(function (u) { return u[1]; }), Tw.brs.map(function (b) { return b[3]; }));
    sets.forEach(function (s) { for (var k in s) assert.ok(KNOWN.indexOf(k) >= 0, Tw.key + ' uses unknown stat ' + k); });
  });
});
test('every tower is reachable: the starting eight plus one unlock per map', function () {
  var got = D.START_TOWERS.slice();
  E.MAPS.forEach(function (M) { if (M.unlock) { assert.ok(T[M.unlock] != null, M.id + ' unlock ' + M.unlock); got.push(M.unlock); } });
  assert.strictEqual(got.length, 40);
  assert.deepStrictEqual(got.slice().sort(), E.TOWERS.map(function (t) { return t.key; }).sort());
});

// ---------------- maps ----------------
test('maps: 35 over 7 regions, five each, the fifth is ULTRA; every one validates', function () {
  assert.strictEqual(E.MAPS.length, 35);
  assert.strictEqual(E.REGIONS.length, 7);
  var ids = {};
  E.MAPS.forEach(function (M, i) {
    assert.ok(!ids[M.id], 'unique ' + M.id); ids[M.id] = 1;
    assert.strictEqual(M.region, Math.floor(i / 5), M.id + ' region');
    assert.strictEqual(M.ultra, i % 5 === 4, M.id + ' ultra');
    assert.deepStrictEqual(MP.validate(M.geo), [], M.id);
    assert.ok(D.PLAY[M.id], M.id + ' has rules');
    assert.strictEqual(M.biome, E.REGIONS[M.region].biome, M.id + ' biome');
    if (M.ultra) assert.ok(M.w > 22 || M.h > 26, M.id + ' is bigger than one screen');
    else assert.ok(M.w <= 18 && M.h <= 22, M.id + ' fits a phone');
  });
});
test('map rules: pools, bosses and traits exist; difficulty never steps back', function () {
  var lastL = 0;
  E.MAPS.forEach(function (M, i) {
    M.pool.forEach(function (k) { assert.ok(E.ENEMIES[k] && !E.ENEMIES[k].boss, M.id + ' pool ' + k); });
    M.bosses.forEach(function (k) { assert.ok(E.ENEMIES[k] && E.ENEMIES[k].boss, M.id + ' boss ' + k); });
    M.traits.forEach(function (k) { assert.ok(D.TRAITS[k], M.id + ' trait ' + k); });
    assert.ok(M.waves >= 12 && M.lives > 0 && M.pace > 0, M.id);
    assert.ok(M.lvl >= lastL, M.id + ' starts no easier than the map before');
    lastL = M.lvl;
    // each region's ULTRA finale is a spike: compare with the last ordinary map
    var endL = E.level(i, M.waves), j = i - 1;
    while (j >= 0 && E.MAPS[j].ultra) j--;
    if (j >= 0) assert.ok(endL >= E.level(j, E.MAPS[j].waves), M.id + ' ends harder than ' + E.MAPS[j].id);
    if (M.ultra && i) assert.ok(endL > E.level(i - 1, E.MAPS[i - 1].waves), M.id + ' (ULTRA) is the peak of its region');
  });
});
test('every map can answer its enemies: detection for hidden ones, anti-air for flyers', function () {
  E.MAPS.forEach(function (M, mi) {
    var pool = M.pool.join('') + M.bosses.join(''), ok = ALL.filter(function (t) { return E.allowed(mi, t); });
    assert.ok(ok.length >= 8, M.id + ' allows a full loadout');
    if (/[?tT¤※]/.test(pool)) assert.ok(ok.some(function (t) { var s = E.towerStat(t, 0); return s.det || s.shape === 'reveal'; }), M.id + ' detection');
    if (/[fFwW₩]/.test(pool)) assert.ok(ok.some(function (t) { var s = E.towerStat(t, 0); return E.isAttack(t) && s.tgt !== 'ground'; }), M.id + ' anti-air');
    assert.ok(ok.some(function (t) { return E.TOWERS[t].cost <= E.startGold(mi); }), M.id + ' something affordable');
  });
});

// ---------------- waves ----------------
test('the first wave of the first map is twelve a, 1.4 s apart', function () {
  var s = E.waveSpec(0, 1), n = 0;
  s.groups.forEach(function (G) { assert.strictEqual(G.k, 'a'); n += G.n; near(G.gap, 1.4, 1e-9); });
  assert.strictEqual(n, 12);
  assert.strictEqual(E.startGold(0), 300);
  assert.strictEqual(E.MAPS[0].lives, 30);
});
test('waves: deterministic, budgets grow, a new glyph arrives as four (a capital alone), bosses on schedule', function () {
  E.MAPS.forEach(function (M, mi) {
    var intro = E.poolIntro(mi);
    for (var w = 1; w <= M.waves; w++) {
      var s = E.waveSpec(mi, w);
      assert.ok(s.groups.length >= 1, M.id + ' w' + w);
      s.groups.forEach(function (G) { assert.ok(G.n >= 1 && G.gap > 0 && G.ri >= 0 && G.ri < M.geo.paths.length, M.id + ' w' + w + ' group'); });
      if (s.fresh) {
        var G0 = s.groups.filter(function (G) { return G.k === s.fresh; })[0];
        assert.ok(G0 && G0.n >= (E.ENEMIES[s.fresh].cap ? 1 : 4), M.id + ' teaches ' + s.fresh);
        assert.strictEqual(intro[M.pool.indexOf(s.fresh)], w);
      }
      var boss = s.groups.filter(function (G) { return G.boss; });
      assert.strictEqual(boss.length, E.isBossWave(mi, w) ? 1 : 0, M.id + ' w' + w + ' boss');
      if (w > 1) assert.ok(E.level(mi, w) > E.level(mi, w - 1));
    }
    if (M.bosses.length) assert.ok(E.isBossWave(mi, M.waves), M.id + ' ends on a boss');
  });
  assert.ok(!E.isBossWave(0, 12), 'the tutorial has no boss');
  var a = JSON.stringify(E.waveSpec(7, 9)), b = JSON.stringify(E.waveSpec(7, 9));
  assert.strictEqual(a, b);
  assert.ok(E.budget(20) > E.budget(10) && E.hpScale(31) > E.hpScale(1));
});

// ---------------- damage rules ----------------
test('physical armor subtracts per hit (min 1); a Bulwark\'s front shield adds 18', function () {
  var g = game(0), e = enemyAt(g, 'b', 10, { hp: 1000 }), behind = src(e.x - e.fx * 2, e.y - e.fy * 2), front = src(e.x + e.fx * 2, e.y + e.fy * 2);
  near(E.hurt(g, e, 20, E.PHYS, behind, E.F_HIT), 16, 1e-6, 'behind: 20 - 4');
  near(E.hurt(g, e, 20, E.PHYS, front, E.F_HIT), 1, 1e-6, 'front: min 1');
  near(E.hurt(g, e, 20, E.PHYS, front, E.F_SPLASH), 16, 1e-6, 'splash ignores the front shield');
  near(E.hurt(g, e, 20, E.FIRE, front, E.F_HIT), 20, 1e-6, 'fire ignores armor');
  var pierce = src(e.x - e.fx * 2, e.y - e.fy * 2, { pierce: 0.5 });
  near(E.hurt(g, e, 20, E.PHYS, pierce, E.F_HIT), 18, 1e-6, 'half armor ignored');
});
test('weakness x1.5, resistance, and a Cinder\'s frost window', function () {
  var g = game(0), b = enemyAt(g, 'b', 5, { hp: 1000 }), c = enemyAt(g, 'c', 6, { hp: 1000 }), s0 = src(0, 0);
  near(E.hurt(g, b, 10, E.ACID, s0, E.F_HIT), 15, 1e-6, 'b is weak to acid');
  near(E.hurt(g, c, 100, E.FIRE, s0, E.F_HIT), 25, 1e-6, 'c resists fire 75%');
  near(E.hurt(g, c, 10, E.FROST, s0, E.F_HIT), 15, 1e-6, 'c is weak to frost');
  near(E.hurt(g, c, 100, E.FIRE, s0, E.F_HIT), 100, 1e-6, 'frost opened it');
  E.applyBurn(c, 50, 3, s0, 0);
  assert.strictEqual(c.burnT, 0, 'Cinders don\'t burn');
});
test('shields soak first (shock and sonic tear them faster), then health', function () {
  var g = game(0), e = enemyAt(g, '0', 5), s0 = src(0, 0);
  assert.strictEqual(e.sh, 250); assert.strictEqual(e.hp, 200);
  E.hurt(g, e, 100, E.FIRE, s0, E.F_HIT);
  assert.strictEqual(e.hp, 200); near(e.sh, 150);
  E.hurt(g, e, 50, E.SHOCK, s0, E.F_HIT);
  near(e.sh, 75, 1e-6, 'shock x1.5 on a 0\'s shield');
  E.hurt(g, e, 85, E.FIRE, s0, E.F_HIT);
  assert.strictEqual(e.sh, 0); near(e.hp, 190, 1e-6, 'the rest carries into health');
  var son = enemyAt(g, '0', 6), ring = src(0, 0, { shieldMul: 2 });
  E.hurt(g, son, 50, E.SONIC, ring, E.F_AREA);
  near(son.sh, 150, 1e-6, 'sonic shield multiplier');
});
test('Lattice caps each hit, Ternary Guard every third, damage boosts share a +50% cap', function () {
  var g = game(0), l = enemyAt(g, 'l', 5), s0 = src(0, 0);
  near(E.hurt(g, l, 5000, E.FIRE, s0, E.F_HIT), l.maxHp * 0.2, 0.1, 'lattice: 20% max HP per hit');
  near(E.hurt(g, l, 50, E.FIRE, s0, E.F_DOT), 75, 1e-6, 'damage over time bypasses the cap (fire x1.5)');
  var t = enemyAt(g, '3', 6, { hp: 10000 });
  E.hurt(g, t, 13, E.FIRE, s0, E.F_HIT); E.hurt(g, t, 13, E.FIRE, s0, E.F_HIT); E.hurt(g, t, 13, E.FIRE, s0, E.F_HIT);
  near(E.hurt(g, t, 10, E.FIRE, s0, E.F_HIT), 4, 1e-6, 'guard up: 60% less');
  var a = enemyAt(g, 'a', 7, { hp: 10000 }), amp = src(0, 0); amp.bDmg = 0.4;
  a.britA = 0.3; a.britT = 3;
  near(E.hurt(g, a, 100, E.PHYS, amp, E.F_HIT), 150, 1e-6, '+40% amp +30% brittle capped at +50%');
});
test('capitals split into zero-bounty lowercase; a leaked capital doesn\'t', function () {
  var g = game(0), gold = g.gold, A = enemyAt(g, 'A', 10), n0 = g.enemies.length, left = g.waveLeft[1];
  E.hurt(g, A, 1e6, E.FIRE, src(0, 0), E.F_HIT);
  assert.ok(!A.alive);
  var kids = g.enemies.filter(function (e) { return e.alive && e.k === 'a'; });
  assert.strictEqual(kids.length, 1);
  assert.strictEqual(kids[0].bounty, 0); assert.ok(kids[0].prot > 0, 'briefly untouchable');
  assert.ok(kids[0].d <= 10);
  assert.strictEqual(g.gold, gold + A.bounty, 'the capital pays once');
  assert.strictEqual(g.waveLeft[1], left, 'the child keeps the wave open');
  var B = enemyAt(g, 'B', E.routeOf(g, A).len - 0.01), lives = g.lives;
  steps(g, 0.1);
  assert.strictEqual(g.lives, lives - E.ENEMIES.B.lives);
  assert.ok(!g.enemies.some(function (e) { return e.alive && e.k === 'b'; }), 'no children from a leak');
});
test('ghosts: hidden from towers without true sight; a Lantern reveals them', function () {
  var g = game(0), ty = T.arrow, c = cellNearRoad(g, ty), t = E.build(g, c[0], c[1], ty);
  E.recalc(g);
  var R = E.mapData(0).routes[0], best = 0, bd = 1e9;
  for (var d = 0; d < R.len; d += 0.25) { var p = E.routePos(R, d, 0, {}), dd = Math.pow(p.x - t.x, 2) + Math.pow(p.y - t.y, 2); if (dd < bd) { bd = dd; best = d; } }
  var e = enemyAt(g, '?', best, { hp: 1e6 }); e.disguise = '';
  assert.ok(E.isHidden(e));
  assert.ok(!E.visibleTo(g, t, e, 1), 'an arrow can\'t see it');
  var s = E.build(g, cellNearRoad(g, T.sonic)[0], cellNearRoad(g, T.sonic)[1], T.sonic);
  E.recalc(g);
  assert.ok(E.visibleTo(g, s, e, 1), 'sonic has true sight');
  var lc = cellNearRoad(g, T.lantern), lt = E.build(g, lc[0], lc[1], T.lantern);
  e.spd = 0; steps(g, 0.1);
  if (Math.pow(e.x - lt.x, 2) + Math.pow(e.y - lt.y, 2) <= Math.pow(lt.st.range, 2)) assert.ok(E.visibleTo(g, t, e, 1), 'revealed for everyone');
  var a = enemyAt(g, '?', best + 0.3, { hp: 50 }); a.disguise = 'c'; a.revealT = 1;
  E.hurt(g, a, 999, E.ARCANE, src(0, 0), E.F_HIT);
  var c2 = g.enemies.filter(function (o) { return o.alive && o.k === 'c' && o.ghostT > 0; });
  assert.strictEqual(c2.length, 1, 'a disguised ghost unmasks into its letter');
  assert.strictEqual(c2[0].bounty, 0);
});
test('statuses: bosses shrug off stuns, Goliaths cap slows, Escapists halve stuns, slows cap at 60%', function () {
  var g = game(0), boss = enemyAt(g, '@', 3), go = enemyAt(g, 'g', 4), es = enemyAt(g, 'e', 5), a = enemyAt(g, 'a', 6);
  assert.ok(!E.applyStun(boss, 1)); assert.strictEqual(boss.stunT, 0);
  E.applySlow(go, 0.5, 2); near(go.slowF, 0.25);
  E.applySlow(boss, 0.5, 2); near(boss.slowF, 0.25);
  E.applyStun(es, 1); near(es.stunT, 0.5);
  E.applySlow(a, 0.9, 2); near(a.slowF, 0.6);
  E.applyStun(a, 5); near(a.stunT, 1.5, 1e-9, 'hard control at most 1.5 s');
  a.spd = 0; steps(g, 1.6);
  assert.ok(a.hcImm > 0 && !E.applyStun(a, 1), 'then 4 s of immunity');
  var x = enemyAt(g, 'x', 7); E.applySlow(x, 0.4, 2, true);
  assert.strictEqual(x.slowF, 0, 'Crosswalkers ignore zone slows');
});
test('burn ticks every 0.5 s; corrode strips armor; regeneration waits 3 s', function () {
  var g = game(0), a = enemyAt(g, 'a', 3, { hp: 1000 }), s0 = src(0, 0);
  a.spd = 0;
  E.applyBurn(a, 10, 2, s0, 0);
  steps(g, 0.49); near(a.hp, 1000);
  steps(g, 0.05); near(a.hp, 995, 1e-6, 'first tick');
  var b = enemyAt(g, 'g', 4, { hp: 1000 }); b.spd = 0;
  E.applyCorrode(b, 0, 3, s0, 10, 4);
  near(E.hurt(g, b, 20, E.PHYS, src(0, 0), E.F_HIT), 18, 1e-6, 'armor 12 - 10');
  var r = enemyAt(g, 'r', 5, { hp: 1000 }); r.spd = 0; r.hp = 500;
  steps(g, 2.5); near(r.hp, 500, 1e-6, 'no regen before 3 s');
  steps(g, 1); assert.ok(r.hp > 500, 'then it regrows');
});
test('specials: an 8 comes back once, a 9 releases three a, a 5 steals and refunds', function () {
  var g = game(0), s0 = src(0, 0), e8 = enemyAt(g, '8', 5);
  E.hurt(g, e8, 1e6, E.FIRE, s0, E.F_HIT);
  assert.ok(e8.alive && e8.revT > 0 && e8.hp === Math.ceil(e8.maxHp * 0.5), 'revives at half');
  steps(g, 1.6);
  E.hurt(g, e8, 1e6, E.FIRE, s0, E.F_HIT);
  assert.ok(!e8.alive, 'only once');
  var e9 = enemyAt(g, '9', 5, { hp: 1e6 }); e9.spd = 0;
  var a0 = g.enemies.filter(function (o) { return o.alive && o.k === 'a'; }).length;
  steps(g, 1.5 * 9 + 0.1);
  assert.strictEqual(g.enemies.filter(function (o) { return o.alive && o.k === 'a'; }).length - a0, 3);
  var g2 = game(0); g2.gold = 100; g2.waveLeft[1] = 50;   // (no wave-clear pay mid-check)
  var R = E.mapData(0).routes[0], e5 = enemyAt(g2, '5', R.len * 0.5 + 0.01, { hp: 1e6 });
  steps(g2, 0.05);
  assert.strictEqual(g2.gold, 80); assert.strictEqual(e5.stolen, 20);
  E.hurt(g2, e5, 1e7, E.FIRE, src(0, 0), E.F_HIT);
  assert.strictEqual(g2.gold, 100 + e5.bounty, 'killing it returns the credits');
});
test('bosses: Gate Colossus guards its front, Threshold Judge dampens big hits', function () {
  var g = game(0), om = enemyAt(g, 'Ω', 6, { hp: 1e6 }), front = src(om.x + om.fx * 2, om.y + om.fy * 2), back = src(om.x - om.fx * 2, om.y - om.fy * 2);
  near(E.hurt(g, om, 100, E.FIRE, front, E.F_HIT), 40, 1e-6, 'front guard 60%');
  near(E.hurt(g, om, 100, E.FIRE, back, E.F_HIT), 100, 1e-6, 'rear hits land');
  var pc = enemyAt(g, '%', 7, { hp: 100000 });
  near(E.hurt(g, pc, 5000, E.FIRE, src(0, 0), E.F_HIT), 1000 + 0.25 * 4000, 1e-6, '1% plus a quarter of the rest');
});

// ---------------- towers ----------------
test('every attack tower (and its final form) damages a stream of enemies', function () {
  ALL.forEach(function (ty) {
    if (!E.isAttack(ty)) return;
    [false, true].forEach(function (top) {
      var g = game(0), Tw = E.TOWERS[ty], c = cellNearRoad(g, ty);
      assert.ok(c, Tw.key + ' has a spot');
      var t = E.build(g, c[0], c[1], ty);
      if (top) { E.upgrade(g, t); E.upgrade(g, t); E.upgrade(g, t); assert.ok(E.upgrade(g, t, ty % 3), Tw.key + ' branch'); assert.strictEqual(t.lvl, 4); }
      g.phase = 'wave'; g.wave = 1; g.waveLeft[1] = 1e6;
      for (var s = 0; s < 60 * 30; s++) { if (s % 60 === 0 && s < 60 * 15) E.spawnEnemy(g, Tw.tgt === 'air' ? 'f' : 'a', 1, 3, 0, 0, true); E.step(g); g.events.length = 0; }
      assert.ok(t.dmg > 50, Tw.key + (top ? ' final' : '') + ' dealt ' + t.dmg);
    });
  });
});
test('upgrades: three levels, then the final form needs a branch; selling returns 70%', function () {
  var g = game(0), c = cellNearRoad(g, T.arrow), t = E.build(g, c[0], c[1], T.arrow), g0 = g.gold;
  assert.strictEqual(t.spent, 60);
  E.upgrade(g, t); E.upgrade(g, t); E.upgrade(g, t);
  assert.strictEqual(t.lvl, 3);
  assert.ok(!E.upgrade(g, t), 'no branch, no upgrade');
  assert.ok(E.upgrade(g, t, 2)); assert.strictEqual(t.br, 2); assert.strictEqual(t.lvl, 4);
  assert.strictEqual(E.stats(g, t).multi, 3, 'Forked Quill');
  assert.ok(!E.upgrade(g, t, 0), 'one final form only');
  assert.strictEqual(t.spent, 60 + 45 + 75 + 115 + 230);
  var v = E.sell(g, t);
  assert.strictEqual(v, Math.floor(t.spent * 0.7));
});
test('terrain: towers keep to their ground; ridges block sight for direct fire', function () {
  var g = game(0), md = E.mapData(0), found = 0;
  for (var i = 0; i < md.grid.length; i++) {
    var c = i % md.w, r = Math.floor(i / md.w), tl = md.grid[i];
    if (tl === E.TL.SHORE) { assert.ok(!E.canPlace(g, c, r, T.arrow), 'arrows avoid the shore'); assert.ok(E.canPlace(g, c, r, T.cannon)); found++; }
    if (tl === E.TL.WATER) { assert.ok(E.canPlace(g, c, r, T.frost) && !E.canPlace(g, c, r, T.cannon)); found++; }
    if (tl === E.TL.ROAD || tl === E.TL.RIDGE) assert.ok(!E.canPlace(g, c, r, T.frost));
  }
  assert.ok(found > 0);
  // sight: find a map with a ridge between a buildable cell and a road cell
  var ok = false;
  for (var mi = 0; mi < E.MAPS.length && !ok; mi++) {
    var g2 = game(mi), m2 = E.mapData(mi);
    for (var k = 0; k < m2.grid.length && !ok; k++) {
      if (m2.grid[k] !== E.TL.RIDGE) continue;
      var rc = k % m2.w, rr = Math.floor(k / m2.w);
      var a = [rc - 1, rr], b = [rc + 1, rr];
      if (E.canPlace(g2, a[0], a[1], T.arrow) && E.tileAt(g2, b[0], b[1]) === E.TL.ROAD) {
        var t = E.build(g2, a[0], a[1], T.arrow); E.recalc(g2);
        assert.ok(!E.sees(t, b[0] + 0.5, b[1] + 0.5), 'the ridge blocks it');
        ok = true;
      }
    }
  }
  assert.ok(ok, 'found a ridge to test');
});
test('supports lift the nearest towers up to their capacity; boosts are capped', function () {
  var g = game(0), c = cellNearRoad(g, T.amp), amp = E.build(g, c[0], c[1], T.amp), placed = [];
  for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) if (E.canPlace(g, c[0] + dx, c[1] + dy, T.arrow) && placed.length < 4) placed.push(E.build(g, c[0] + dx, c[1] + dy, T.arrow));
  E.recalc(g);
  assert.strictEqual(placed.filter(function (t) { return t.bDmg > 0; }).length, 2, 'Amplifier: two towers');
  near(placed.filter(function (t) { return t.bDmg > 0; })[0].bDmg, 0.18);
  var h = E.build(g, cellNearRoad(g, T.metronome)[0], cellNearRoad(g, T.metronome)[1], T.metronome);
  for (var i = 0; i < 3; i++) E.upgrade(g, h); E.upgrade(g, h, 0); E.recalc(g);
  placed.forEach(function (t) { if (t.bHaste) near(E.effInt(t), t.st.int / 1.5, 1e-9, 'Double Time +50%'); });
});
test('economy: at most one of each and two in all; Mint pays from the next wave; Bank pays interest', function () {
  var g = game(0), cells = [];
  [T.mint, T.bank, T.bounty].forEach(function (ty) { cells.push(cellNearRoad(g, ty, 0, function (x, y) { return cells.some(function (c) { return c && c[0] === x && c[1] === y; }); })); });
  var m = E.build(g, cells[0][0], cells[0][1], T.mint);
  assert.ok(m);
  assert.ok(!E.build(g, cells[1][0] + 0, cells[1][1], T.mint), 'one Mint');
  var b = E.build(g, cells[1][0], cells[1][1], T.bank);
  assert.ok(b);
  assert.strictEqual(E.build(g, cells[2][0], cells[2][1], T.bounty), null, 'two economy towers at most');
  g.gold = 1000;
  E.nextWave(g);
  assert.strictEqual(b.principal, 250, 'the bank locks its principal');
  assert.strictEqual(g.gold, 750);
  g.enemies.length = 0; g.spawners.length = 0; g.waveLeft[1] = 1;
  var gold = g.gold, pay = E.wavePay(0, 1);
  E.kill(g, { alive: true, k: 'a', w: 1, bounty: 0, orig: 0, x: 0, y: 0, d: 0, ri: 0, hp: 1, maxHp: 1, stolen: 0 }, null);
  assert.strictEqual(g.gold, gold + pay + 20 + 250 + 20, 'wave pay + mint 20 + principal + 8% interest (20)');
});
test('Terraformer raises pads; pads take attack towers; it stays while they\'re occupied', function () {
  var mi = -1;
  for (var i = 0; i < E.MAPS.length && mi < 0; i++) { var md = E.mapData(i); if (md.grid.some(function (t) { return t === E.TL.RIDGE || t === E.TL.WATER; })) mi = i; }
  var g = game(mi), best = null;
  var md2 = E.mapData(mi);
  for (var k = 0; k < md2.grid.length && !best; k++) {
    var c = k % md2.w, r = Math.floor(k / md2.w);
    if (!E.canPlace(g, c, r, T.terra)) continue;
    for (var dy = -2; dy <= 2 && !best; dy++) for (var dx = -2; dx <= 2; dx++) { var tt = E.tileAt(g, c + dx, r + dy); if (tt === E.TL.RIDGE || tt === E.TL.WATER) { best = [c, r]; break; } }
  }
  var tf = E.build(g, best[0], best[1], T.terra), pads = Object.keys(g.pads).filter(function (p) { return g.pads[p] === tf.id; });
  assert.ok(pads.length >= 1 && pads.length <= 2, 'pads raised');
  var pc = +pads[0], px = pc % md2.w, py = Math.floor(pc / md2.w);
  assert.ok(E.canPlace(g, px, py, T.arrow), 'an arrow fits a pad');
  assert.ok(!E.canPlace(g, px, py, T.lantern), 'supports don\'t');
  E.build(g, px, py, T.arrow);
  assert.strictEqual(E.sell(g, tf), -1, 'can\'t sell it under an occupied pad');
});

// ---------------- save / restore ----------------
test('save / restore mid-wave round-trips through JSON and plays on', function () {
  var g = game(9), md = E.mapData(9);
  for (var i = 0; i < 12; i++) { var ty = [T.arrow, T.cannon, T.frost, T.lightning][i % 4], c = cellNearRoad(g, ty, i % md.routes.length); if (c) E.build(g, c[0], c[1], ty); }
  var t0 = g.towers[0]; E.upgrade(g, t0); E.upgrade(g, t0); E.upgrade(g, t0); E.upgrade(g, t0, 1);
  E.nextWave(g); steps(g, 25); E.nextWave(g); steps(g, 8);
  assert.ok(g.enemies.length > 0, 'enemies on the road');
  var o = JSON.parse(JSON.stringify(E.serialize(g))), h = E.restore(o);
  assert.ok(h);
  ['gold', 'lives', 'wave', 'phase', 'kills', 'nextId', 'rs'].forEach(function (k) { assert.deepStrictEqual(h[k], g[k], k); });
  assert.strictEqual(h.towers.length, g.towers.length);
  assert.strictEqual(h.towers[0].lvl, 4); assert.strictEqual(h.towers[0].br, 1);
  assert.strictEqual(h.enemies.length, g.enemies.length);
  var sum = function (x) { return x.enemies.reduce(function (s, e) { return s + e.hp + e.d * 1000; }, 0); };
  near(sum(h), sum(g), 1, 'enemy state');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(E.serialize(h))).enemies.length, o.enemies.length);
  steps(h, 120);
  assert.ok(h.wave >= 3, 'plays on');
  assert.strictEqual(E.restore({ v: 1 }), null, 'rejects other versions');
});
test('fixed step: advance() is frame-rate independent', function () {
  function run(fps) {
    var g = game(0), c = cellNearRoad(g, T.arrow); E.build(g, c[0], c[1], T.arrow); E.nextWave(g);
    for (var t = 0; t < 30; t += 1 / fps) E.advance(g, 1 / fps, 2);
    return g.steps;
  }
  var a = run(60), b = run(30), c = run(144);
  assert.ok(Math.abs(a - b) <= 2 && Math.abs(a - c) <= 2, a + ' ' + b + ' ' + c);
});

// ---------------- whole games ----------------
// A simple bot: builds a fixed mix on the cells that see the most road (spreading
// across roads), upgrades, takes branch A — enough to show early maps are winnable.
function botGame(mi, order) {
  var M = E.MAPS[mi], g = E.newGame(mi, { chest: 1 }, order.map(function (k) { return T[k]; })), md = E.mapData(mi), pts = [], i;
  g.fxOn = false;
  md.routes.forEach(function (R) { for (var d = 0.5; d < R.len; d += 0.5) { var p = E.routePos(R, d, 0, {}); pts.push([p.x, p.y, 0]); } });
  function val(x, y, r) { var v = 0; for (var j = 0; j < pts.length; j++) { var dx = pts[j][0] - x - 0.5, dy = pts[j][1] - y - 0.5; if (dx * dx + dy * dy <= r * r) v += 1 / (1 + 0.6 * pts[j][2]); } return v; }
  var k = 0;
  function spend() {
    for (var guard = 0; guard < 20; guard++) {
      var key = order[k % order.length], ty = T[key], cost = E.TOWERS[ty].cost, up = null;
      g.towers.forEach(function (t) { if (t.lvl < 4 && E.isAttack(t.type) && (!up || t.lvl < up.lvl)) up = t; });
      if (up && g.towers.length > 5 + g.wave && g.gold >= E.upgradeCost(g, up, 0)) { E.upgrade(g, up, 0); continue; }
      if (g.gold < cost || E.canBuildType(g, ty)) { k++; if (g.gold < 60) break; continue; }
      var best = null, bv = 0, r = E.towerStat(ty, 0).range;
      for (var y = 0; y < md.h; y++) for (var x = 0; x < md.w; x++) { if (!E.canPlace(g, x, y, ty)) continue; var v = val(x, y, Math.min(r, 5)); if (v > bv) { bv = v; best = [x, y]; } }
      if (!best) { k++; continue; }
      var t = E.build(g, best[0], best[1], ty);
      for (i = 0; i < pts.length; i++) { var dx = pts[i][0] - t.x, dy = pts[i][1] - t.y; if (dx * dx + dy * dy <= r * r) pts[i][2]++; }
      k++;
    }
  }
  spend(); E.nextWave(g);
  var n = 0;
  while (g.phase === 'wave' && n < 60 * 60 * 40) { E.step(g); g.events.length = 0; if (++n % 120 === 0) spend(); }
  return g;
}
test('bot: the first maps are winnable; every map runs ten waves cleanly', function () {
  var res = [];
  [0, 1, 2, 3].forEach(function (mi) {
    var g = botGame(mi, ['arrow', 'cannon', 'frost', 'arrow', 'cannon', 'flak', 'arrow', 'sonic']);
    res.push(E.MAPS[mi].id + ' ' + g.phase + ' w' + g.wave + ' ♥' + g.lives);
    assert.strictEqual(g.phase, 'won', E.MAPS[mi].id + ' won by the bot (' + g.wave + ', ♥' + g.lives + ')');
  });
  console.log('  bot: ' + res.join(' · '));
  E.MAPS.forEach(function (M, mi) {
    var g = E.newGame(mi, {}, []); g.loadout = ALL.slice(); g.gold = 1e6; g.fxOn = true; g.lives = 1e6;
    for (var i = 0; i < 18; i++) { var ty = ALL[(i * 7) % 40], c = cellNearRoad(g, ty, i % E.mapData(mi).routes.length); if (c) { var t = E.build(g, c[0], c[1], ty); if (t && i % 2) { E.upgrade(g, t); E.upgrade(g, t); E.upgrade(g, t); E.upgrade(g, t, i % 3); } } }
    E.nextWave(g);
    for (var s = 0; s < 60 * 60 * 3 && g.wave < 10; s++) { E.step(g); g.events.length = 0; if (s % 600 === 0 && E.canCallWave(g)) E.nextWave(g); }
    assert.ok(g.wave >= 10 || g.phase === 'won', M.id + ' ran to wave ' + g.wave);
    E.mapData(mi).routes.forEach(function (R) { assert.ok(R.len > 10); });
  });
});

console.log('td2: ' + passed + ' passed' + (process.exitCode ? ' (with failures)' : ''));
