/* Headless checks for the Tower Defense engine (maps, waves, economy, targeting,
 * damage, fixed step, save/restore) plus deterministic whole-game simulations.
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/towerdefense/towerdefense.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var E = require('./towerdefense.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var T = E.TKEY;
function rich(mi) { var g = E.newGame(mi || 0); g.gold = 1e6; g.fxOn = false; return g; }
function run(g, sec) { var n = Math.round(sec / E.STEP); for (var i = 0; i < n && g.phase === 'wave'; i++) { E.step(g); g.events.length = 0; } }
// An enemy placed `d` cells along path `pi` (wave 1 stats unless hp given).
function enemyAt(g, k, d, hp, pi) {
  if (g.phase === 'build') g.phase = 'wave';
  g.waveLeft[1] = (g.waveLeft[1] || 0) + 1;
  var e = E.spawnEnemy(g, k, 1, pi || 0);
  e.ox = e.oy = 0; e.d = d; e.seg = 0;
  if (hp != null) e.hp = e.maxHp = hp;
  // place without walking
  var P = e.fly ? E.mapData(g.map).fly[e.pi] : E.mapData(g.map).paths[e.pi];
  while (e.seg < P.cum.length - 2 && P.cum[e.seg + 1] <= e.d) e.seg++;
  var s = e.seg, f = (e.d - P.cum[s]) / (P.cum[s + 1] - P.cum[s]);
  e.x = e.px = P.x[s] + (P.x[s + 1] - P.x[s]) * f; e.y = e.py = P.y[s] + (P.y[s + 1] - P.y[s]) * f; e.rem = P.len - e.d;
  return e;
}

// ---------- registration ----------
test('registers in the app with the manifest entry\'s name', function () {
  var widget = null;
  global.window = { Cade: { loadCSS: function () {}, registerWidget: function (w) { widget = w; } } };
  delete require.cache[require.resolve('./towerdefense.js')];
  require('./towerdefense.js');
  delete global.window;
  assert.ok(widget, 'registered');
  assert.strictEqual(typeof widget.open, 'function');
  assert.ok(widget._engine && widget._engine.newGame, 'engine exposed');
  var entry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === 'towerdefense'; })[0];
  assert.strictEqual(entry.name, widget.name);
  assert.strictEqual(entry.description, widget.description);
  assert.strictEqual(entry.icon, widget.icon);
  assert.strictEqual(entry.tags, widget.tags);
  assert.strictEqual(entry.id, 'towerdefense');
  assert.strictEqual(entry.type, 'widget');
  assert.strictEqual(entry.entry, 'widgets/towerdefense/towerdefense.js');
  assert.strictEqual(entry.css, 'widgets/towerdefense/towerdefense.css');
  var m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  var inM = m.modules.filter(function (x) { return x.id === 'towerdefense'; })[0];
  if (inM) assert.deepStrictEqual(inM, entry, 'manifest entry matches MANIFEST_ENTRY.json');
});

// ---------- maps ----------
test('maps: 8 maps, 12x16 art whose road matches the waypoints exactly', function () {
  assert.ok(E.MAPS.length >= 8);
  var ids = {};
  E.MAPS.forEach(function (M, mi) {
    assert.ok(!ids[M.id], 'unique id ' + M.id); ids[M.id] = 1;
    assert.ok(M.name && M.diff && M.gold > 0 && M.lives > 0 && M.hp > 0);
    if (M.swap) Object.keys(M.swap).forEach(function (k) { assert.ok(E.ENEMIES[k] && E.ENEMIES[M.swap[k]], M.id + ' swap ' + k); });
    assert.strictEqual(M.art.length, E.ROWS, M.id + ' rows');
    M.art.forEach(function (row) { assert.strictEqual(row.length, E.COLS, M.id + ' row width'); assert.ok(/^[.#^~]+$/.test(row)); });
    var road = {};
    M.paths.forEach(function (pts) {
      for (var i = 1; i < pts.length; i++) assert.ok(pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1], 'axis-aligned');
      var a = pts[0], z = pts[pts.length - 1];
      assert.ok(a[0] < 0 || a[1] < 0 || a[0] >= E.COLS || a[1] >= E.ROWS, M.id + ' enters from off the map');
      assert.ok(z[0] < 0 || z[1] < 0 || z[0] >= E.COLS || z[1] >= E.ROWS, M.id + ' exits off the map');
      E.pathCells(pts).forEach(function (c) { road[c] = 1; });
    });
    for (var r = 0; r < E.ROWS; r++) for (var c = 0; c < E.COLS; c++) {
      assert.strictEqual(M.art[r].charAt(c) === '#', !!road[r * E.COLS + c], M.id + ' road cell ' + c + ',' + r);
    }
    var md = E.mapData(mi), grass = md.grid.filter(function (t) { return t === E.CELL_GRASS; }).length;
    assert.ok(grass >= 80, M.id + ' has room to build (' + grass + ')');
    md.paths.forEach(function (P) { assert.ok(P.len >= 25, M.id + ' path length ' + P.len); });
    assert.strictEqual(md.fly.length, M.paths.length);
  });
  // harder maps: shorter roads (less time under fire)
  var len = E.MAPS.map(function (M, i) { return Math.min.apply(null, E.mapData(i).paths.map(function (P) { return P.len; })); });
  assert.ok(len[0] > len[1] && len[1] > len[2], 'roads shorten: ' + len);
});

// ---------- waves ----------
test('waves: 30 per map, a boss every 10th, escalating; endless keeps growing', function () {
  assert.strictEqual(E.WAVES, 30);
  assert.strictEqual(E.WAVE_TABLE.length, 30);
  function threat(n) {
    return E.waveSpec(n).reduce(function (s, gp) { return s + gp.n * E.ENEMIES[gp.k].hp * E.hpMul(n, 0) * (gp.k === 'O' ? 1.5 : 1); }, 0);
  }
  for (var n = 1; n <= 60; n++) {
    var spec = E.waveSpec(n);
    assert.ok(spec.length >= 1);
    spec.forEach(function (gp) { assert.ok(E.ENEMIES[gp.k], 'type ' + gp.k); assert.ok(gp.n >= 1 && gp.gap > 0); });
    assert.strictEqual(E.waveHasBoss(n), n % 10 === 0, 'boss on wave ' + n);
  }
  // every decade is tougher than the one before (and free play keeps climbing)
  function decade(d) { var s = 0; for (var n = d * 10 + 1; n <= d * 10 + 10; n++) s += threat(n); return s; }
  for (var d = 1; d < 6; d++) assert.ok(decade(d) > decade(d - 1) * 1.3, 'decade ' + d);
  assert.ok(threat(30) > threat(20) && threat(20) > threat(10) && threat(10) > threat(1));
  assert.ok(E.waveCount(45) > E.waveCount(35), 'free-play waves grow');
  // all enemy kinds appear in the 30 waves, each boss on its decade
  var kinds = {};
  for (n = 1; n <= 30; n++) E.waveSpec(n).forEach(function (gp) { kinds[gp.k] = 1; });
  assert.deepStrictEqual(Object.keys(kinds).sort(), Object.keys(E.ENEMIES).sort());
  assert.ok(E.ENEMIES['@'].boss && E.ENEMIES['Ω'].boss && E.ENEMIES['W'].boss && E.ENEMIES['W'].fly);
  // a map's swaps kick in from its swapFrom wave
  var hollow = E.MAPS.map(function (M) { return M.id; }).indexOf('hollow'), M = E.MAPS[hollow];
  assert.ok(hollow >= 0 && M.swapFrom > 1);
  var early = E.waveSpec(4, hollow), late = E.waveSpec(14, hollow);
  assert.ok(early.some(function (gp) { return gp.k === '>'; }), 'runners before the swap');
  assert.ok(!late.some(function (gp) { return gp.k === '>'; }) && late.some(function (gp) { return gp.k === '?'; }), 'ghosts after it');
  assert.strictEqual(late.filter(function (gp) { return gp.k === '?'; })[0].gap, E.ENEMIES['?'].gap);
  assert.strictEqual(E.waveCount(14, hollow), E.waveCount(14), 'same head count');
});

// ---------- economy ----------
test('build / upgrade / sell: costs, valid cells, 70% refund', function () {
  var g = E.newGame(0), start = g.gold;
  assert.strictEqual(E.build(g, 1, 0, T.arrow), null, 'not on the road');
  assert.strictEqual(E.build(g, 4, 1, T.arrow), null, 'not on rock');
  assert.strictEqual(E.build(g, 1, 4, T.arrow), null, 'not on water');
  assert.strictEqual(E.build(g, -1, 4, T.arrow), null, 'not off the map');
  var a = E.build(g, 5, 4, T.arrow);
  assert.ok(a);
  assert.strictEqual(g.gold, start - E.TOWERS[T.arrow].cost[0]);
  assert.strictEqual(E.build(g, 5, 4, T.cannon), null, 'cell taken');
  assert.strictEqual(E.towerAt(g, 5, 4), a);
  g.gold = 10;
  assert.strictEqual(E.build(g, 6, 4, T.sniper), null, 'too poor');
  assert.strictEqual(E.upgrade(g, a), false, 'too poor to upgrade');
  g.gold = 1000;
  assert.ok(E.upgrade(g, a) && E.upgrade(g, a));
  assert.strictEqual(a.lvl, 2);
  assert.strictEqual(E.upgrade(g, a), false, 'max level');
  var spent = E.TOWERS[T.arrow].cost.reduce(function (s, c) { return s + c; }, 0);
  assert.strictEqual(a.spent, spent);
  var before = g.gold, v = E.sell(g, a);
  assert.strictEqual(v, Math.floor(spent * 0.7));
  assert.strictEqual(g.gold, before + v);
  assert.strictEqual(E.towerAt(g, 5, 4), null);
  assert.ok(E.canBuild(g, 5, 4));
  // stats really improve with each level, and both specialisations beat level 3
  function power(s) { return s.dmg * (s.rate || 1) * (1 + s.chain) * Math.max(1, s.multi) * Math.max(1, s.beams) * (1 + s.splash) + s.burn + s.income * 3 + s.buff * 400 + s.slow * 100 + s.detect; }
  E.TOWERS.forEach(function (Tw, ti) {
    assert.ok(Tw.glyph && Tw.name && Tw.role && Tw.spec.length === 2);
    for (var l = 1; l < 3; l++) {
      var s0 = E.towerStat(ti, l - 1), s1 = E.towerStat(ti, l);
      assert.ok(power(s1) > power(s0) && s1.range >= s0.range && s1.rate >= s0.rate, Tw.key + ' lvl ' + l);
    }
    Tw.spec.forEach(function (sp, b) {
      assert.ok(sp.key && sp.name && sp.note && sp.cost > Tw.cost[2], Tw.key + ' spec ' + b);
      assert.ok(power(E.towerStat(ti, 3, b)) > power(E.towerStat(ti, 2)), Tw.key + ' spec ' + sp.key + ' is stronger');
    });
    assert.notDeepStrictEqual(E.towerStat(ti, 3, 0), E.towerStat(ti, 3, 1), Tw.key + ' specs differ');
  });
  assert.strictEqual(E.TOWERS.length, 10);
});

test('specialisation: level 4 is a choice of two, priced per branch', function () {
  var g = E.newGame(0); g.gold = 5000;
  var t = E.build(g, 5, 4, T.tesla);
  assert.ok(E.upgrade(g, t) && E.upgrade(g, t));
  assert.strictEqual(t.lvl, 2);
  assert.strictEqual(E.upgrade(g, t), false, 'no branch, no specialisation');
  assert.strictEqual(E.upgradeCost(t, 0), E.TOWERS[T.tesla].spec[0].cost);
  assert.strictEqual(E.upgradeCost(t, 1), E.TOWERS[T.tesla].spec[1].cost);
  var gold = g.gold;
  assert.ok(E.upgrade(g, t, 1));
  assert.strictEqual(t.lvl, E.MAX_LVL); assert.strictEqual(t.spec, 1);
  assert.strictEqual(g.gold, gold - E.TOWERS[T.tesla].spec[1].cost);
  assert.strictEqual(E.upgrade(g, t, 0), false, 'already specialised');
  assert.strictEqual(E.upgradeCost(t, 0), 0);
  assert.strictEqual(E.stats(g, t).stun, E.TOWERS[T.tesla].spec[1].stun);
  // a spec only overrides what it names; the rest carries over from level 3
  var vol = E.towerStat(T.arrow, 3, 1);
  assert.strictEqual(vol.multi, 3);
  assert.strictEqual(E.towerStat(T.frost, 3, 1).slowDur, 2);
  assert.strictEqual(E.towerStat(T.flame, 3, 0).burnDur, E.TOWERS[T.flame].burnDur[2]);
});

test('waves: start, call early for a bonus, at most two spawning at once, clear bonus', function () {
  var g = E.newGame(0); g.fxOn = false;
  assert.strictEqual(E.earlyBonus(g), 0);
  assert.strictEqual(E.nextWave(g), 0, 'first wave: no bonus');
  assert.strictEqual(g.wave, 1); assert.strictEqual(g.phase, 'wave');
  assert.ok(E.timeToNext(g) > E.WAVE_GAP, 'still spawning: next wave is a gap after the spawns');
  var gold = g.gold, b = E.nextWave(g);
  assert.ok(b > 0, 'early bonus ' + b);
  assert.strictEqual(g.gold, gold + b);
  assert.strictEqual(g.wave, 2);
  assert.strictEqual(E.canCallWave(g), false, 'two waves already spawning');
  assert.strictEqual(E.nextWave(g), -1);
  // waves start by themselves after the countdown
  var g2 = E.newGame(0); g2.fxOn = false; g2.lives = 999; g2.maxLives = 999;
  E.nextWave(g2);
  var t0 = 0;
  while (g2.wave === 1) { E.step(g2); g2.events.length = 0; t0 += E.STEP; }
  var spawnTime = (8 - 1) * E.ENEMIES.o.gap + 0.3;
  assert.ok(Math.abs(t0 - (spawnTime + E.WAVE_GAP)) < 0.1, 'auto start after gap: ' + t0.toFixed(2));
  // clearing a wave pays a bonus
  var g3 = rich(0); E.build(g3, 2, 1, T.sniper); E.build(g3, 0, 1, T.arrow); E.build(g3, 2, 3, T.arrow);
  E.nextWave(g3);
  var ev = [], before = g3.gold, kills = 0;
  while (g3.wave === 1 && g3.phase === 'wave') { E.step(g3); ev = ev.concat(g3.events); g3.events.length = 0; }
  kills = ev.filter(function (x) { return x === 'kill'; }).length;
  assert.strictEqual(kills, 8, 'wave 1 killed');
  assert.ok(ev.indexOf('clear') >= 0, 'clear event');
  assert.strictEqual(g3.gold - before, kills * E.bountyFor('o', 1) + E.clearBonus(1));
});

// ---------- targeting ----------
test('targeting: first / last / strong / close, range, flyers vs cannons', function () {
  var g = rich(0);
  var t = E.build(g, 3, 3, T.arrow);         // near the top road (row 2)
  var a = enemyAt(g, 'o', 4, 10), b = enemyAt(g, 'o', 6, 50), c = enemyAt(g, 'o', 7.6, 20);
  // c is furthest along, b strongest, a least far; close = nearest to (3.5, 3.5)
  t.mode = 0; assert.strictEqual(E.pickTarget(g, t, 9, true), c, 'first');
  t.mode = 1; assert.strictEqual(E.pickTarget(g, t, 9, true), a, 'last');
  t.mode = 2; assert.strictEqual(E.pickTarget(g, t, 9, true), b, 'strong');
  t.mode = 3;
  var near = [a, b, c].reduce(function (m, e) { return Math.hypot(e.x - 3.5, e.y - 3.5) < Math.hypot(m.x - 3.5, m.y - 3.5) ? e : m; });
  assert.strictEqual(E.pickTarget(g, t, 9, true), near, 'close');
  assert.strictEqual(E.pickTarget(g, t, 0.01, true), null, 'out of range');
  // a cannon never targets a flyer; an arrow does
  var g2 = rich(0), f = enemyAt(g2, '&', 3), cn = E.build(g2, 3, 1, T.cannon), ar = E.build(g2, 2, 1, T.arrow);
  assert.ok(Math.hypot(f.x - cn.x, f.y - cn.y) < 2.5, 'flyer in cannon range');
  assert.strictEqual(E.pickTarget(g2, cn, 6.25, false), null);
  assert.strictEqual(E.pickTarget(g2, ar, 6.76, true), f);
  // cycling modes; frost, flame, bank and beacon have none
  assert.strictEqual(E.cycleMode(t), 0);
  var fr = E.build(g, 6, 4, T.frost); assert.strictEqual(E.cycleMode(fr), fr.mode);
  ['flame', 'bank', 'beacon'].forEach(function (k) { assert.strictEqual(E.aims(T[k]), false, k); });
  ['arrow', 'missile', 'beam', 'sniper'].forEach(function (k) { assert.strictEqual(E.aims(T[k]), true, k); });
  assert.strictEqual(E.MODES.length, 4);
});

test('ghosts: hidden until revealed by a beacon, a hit, a burn, or a flicker', function () {
  var g = rich(0);
  var ar = E.build(g, 3, 3, T.arrow), gh = enemyAt(g, '?', 5);
  gh.ph = 1;                                  // mid-fade: not flickering into view
  assert.strictEqual(E.visible(gh), false);
  assert.strictEqual(E.pickTarget(g, ar, 9, true), null, 'arrows can\'t see it');
  gh.ph = 0.1; assert.strictEqual(E.visible(gh), true, 'flickers into view'); gh.ph = 1;
  E.hurt(g, gh, 1, false, null);
  assert.ok(E.visible(gh) && E.pickTarget(g, ar, 9, true) === gh, 'a hit reveals it');
  gh.revealT = 0; gh.burnT = 1; assert.ok(E.visible(gh), 'so does burning'); gh.burnT = 0;
  // a beacon in range keeps it detected while it walks
  var g2 = rich(0), b = E.build(g2, 4, 3, T.beacon), g2h = enemyAt(g2, '?', 4.5, 1e5);
  g2h.ph = 1; g2.spawners.length = 0;
  E.step(g2);
  assert.ok(g2h.det, 'beacon detects');
  assert.ok(E.stats(g2, b).detect >= E.TOWERS[T.beacon].detect[0]);
  // frost (area) hits it unseen
  var g3 = rich(0); g3.phase = 'wave';
  E.build(g3, 3, 3, T.frost); var g3h = enemyAt(g3, '?', 5, 1e4); g3h.ph = 1;
  E.step(g3);
  assert.ok(g3h.hp < 1e4 && g3h.slowF > 0, 'area damage lands');
});

test('missiles pick flyers first and hit them harder', function () {
  var g = rich(0);
  var m = E.build(g, 3, 3, T.missile);
  var gr = enemyAt(g, 'o', 7.6), fl = enemyAt(g, '&', 3);
  m.mode = 0;
  assert.strictEqual(E.pickTarget(g, m, 16, true), fl, 'flyer before the leading grunt');
  var g2 = rich(0); g2.phase = 'wave';
  E.build(g2, 2, 1, T.missile);
  var f2 = enemyAt(g2, '&', 3, 1e4), hp0 = f2.hp; g2.spawners.length = 0;
  for (var i = 0; i < 60; i++) { E.step(g2); g2.events.length = 0; }
  var per = E.TOWERS[T.missile].dmg[0] * E.TOWERS[T.missile].airMul[0];
  assert.ok(hp0 - f2.hp >= per - 1e-6, 'at least one full air hit: ' + (hp0 - f2.hp));
});

// ---------- damage ----------
test('damage: armour, sniper pierce, bounty, splash, chain, slow', function () {
  var g = rich(0), gold = g.gold;
  var tank = enemyAt(g, 'O', 5, 100);
  g.waveLeft[1] += 50;                       // more of the wave to come: no clear bonus here
  E.hurt(g, tank, 7, false, null);
  assert.strictEqual(tank.hp, 100 - 3, 'armour 4 soaks');
  E.hurt(g, tank, 2, false, null);
  assert.strictEqual(tank.hp, 97 - 0.5, 'at least 25% always gets through');
  E.hurt(g, tank, 10, true, null);
  assert.strictEqual(tank.hp, 86.5, 'sniper ignores armour');
  E.hurt(g, tank, 1000, true, null);
  assert.strictEqual(tank.alive, false);
  assert.strictEqual(g.gold, gold + E.bountyFor('O', 1));
  // cannon splash hits a ground crowd, sniper one-shots, tesla chains
  var g2 = rich(0); g2.phase = 'wave';
  var cn = E.build(g2, 3, 3, T.cannon);
  var crowd = [enemyAt(g2, 'o', 5, 500), enemyAt(g2, 'o', 5.3, 500), enemyAt(g2, 'o', 5.6, 500)];
  for (var i = 0; i < 90; i++) { E.step(g2); g2.events.length = 0; }
  crowd.forEach(function (e) { assert.ok(e.hp < 500, 'splashed'); });
  var g3 = rich(0); g3.phase = 'wave';
  var ts = E.build(g3, 3, 3, T.tesla);
  var line = [enemyAt(g3, 'o', 4.6, 500), enemyAt(g3, 'o', 5.6, 500), enemyAt(g3, 'o', 6.6, 500), enemyAt(g3, 'o', 7.6, 500), enemyAt(g3, 'o', 8.6, 500)];
  g3.spawners.length = 0; g3.countdown = 0;
  E.step(g3);
  var hit = line.filter(function (e) { return e.hp < 500; }).length;
  assert.strictEqual(hit, 1 + E.TOWERS[T.tesla].chain[0], 'tesla hits target + ' + E.TOWERS[T.tesla].chain[0]);
  assert.ok(ts.dmg > 0);
  // frost slows (bosses only half as much) and the slow wears off
  var g4 = rich(0); g4.phase = 'wave';
  var fr = E.build(g4, 3, 3, T.frost);
  var gr = enemyAt(g4, 'o', 5, 1e4), bs = enemyAt(g4, '@', 5.5, 1e5);
  E.step(g4);
  assert.strictEqual(gr.slowF, E.TOWERS[T.frost].slow[0]);
  assert.strictEqual(bs.slowF, E.TOWERS[T.frost].slow[0] / 2);
  var d0 = gr.d; E.step(g4);
  assert.ok(Math.abs((gr.d - d0) - gr.spd * (1 - gr.slowF) * E.STEP) < 1e-9, 'moves at the slowed speed');
  E.sell(g4, fr);
  run(g4, 3);
  assert.strictEqual(gr.slowF, 0, 'slow expired');
});

test('abilities: burn stops regen and healing, golems shrug off slows, splitters split', function () {
  // a troll regenerates — unless it's burning
  var g = rich(0); g.phase = 'wave'; g.spawners.length = 0;
  var tr = enemyAt(g, 'T', 5, 1000); tr.hp = 500;
  E.step(g);
  assert.ok(tr.hp > 500, 'regenerates');
  var hp = tr.hp; tr.burnT = 2; tr.burnD = 30;
  E.step(g);
  assert.ok(tr.hp < hp, 'burning: no regen, takes the burn');
  // a healer mends its neighbours, but not burning ones
  var g2 = rich(0); g2.phase = 'wave'; g2.spawners.length = 0;
  var he = enemyAt(g2, 'h', 6, 1000), a = enemyAt(g2, 'o', 6.4, 100), b = enemyAt(g2, 'o', 5.6, 100);
  a.hp = 50; b.hp = 50; b.burnT = 5; b.burnD = 0.0001; he.healT = 0.001;
  E.step(g2);
  assert.ok(a.hp > 60, 'healed ' + a.hp);
  assert.ok(b.hp <= 50, 'burning: not healed');
  // golems ignore frost's slow and tesla's stun
  var g3 = rich(0); g3.phase = 'wave';
  E.build(g3, 3, 3, T.frost); var go = enemyAt(g3, 'M', 5, 1e5);
  E.step(g3);
  assert.strictEqual(go.slowF, 0, 'not slowed');
  // a splitter breaks into three grunts that count towards the wave
  var g4 = rich(0); g4.phase = 'wave';
  var sp = enemyAt(g4, '8', 8, 10), left = g4.waveLeft[1];
  E.hurt(g4, sp, 100, true, null);
  var kids = g4.enemies.filter(function (e) { return e.alive && e.k === 'o'; });
  assert.strictEqual(kids.length, 3);
  assert.strictEqual(g4.waveLeft[1], left - 1 + 3);
  kids.forEach(function (k) { assert.ok(Math.abs(k.d - 8) < 1 && k.bounty === 1 && k.maxHp < E.ENEMIES.o.hp); });
});

test('abilities: shred, brittle, stun, scorch; the warlord calls escorts', function () {
  var g = rich(0); g.phase = 'wave';
  var tk = enemyAt(g, 'O', 5, 1e4); g.waveLeft[1] += 10;
  tk.shred = 3; E.hurt(g, tk, 10, false, null);
  assert.strictEqual(tk.hp, 1e4 - 9, 'armour 4 - 3 shred');
  tk.shred = 0; tk.burnT = 1; tk.scorch = 4; E.hurt(g, tk, 10, false, null);
  assert.strictEqual(tk.hp, 1e4 - 19, 'scorched: no armour while burning');
  tk.burnT = 0; tk.brit = 0.3; tk.britT = 1; E.hurt(g, tk, 14, false, null);
  assert.ok(Math.abs(tk.hp - (1e4 - 19 - 10 * 1.3)) < 1e-9, 'brittle: +30%');
  // a Breaker cannon strips armour
  var g2 = rich(0); g2.phase = 'wave'; g2.spawners.length = 0;
  var c = E.build(g2, 3, 3, T.cannon); E.upgrade(g2, c); E.upgrade(g2, c); E.upgrade(g2, c, 1);
  var t2 = enemyAt(g2, 'O', 5, 1e5);
  for (var i = 0; i < 120; i++) { E.step(g2); g2.events.length = 0; }
  assert.ok(t2.shred > 0, 'shredded');
  // Overload stuns, bosses half as long
  var g3 = rich(0); g3.phase = 'wave'; g3.spawners.length = 0;
  var ts = E.build(g3, 3, 3, T.tesla); E.upgrade(g3, ts); E.upgrade(g3, ts); E.upgrade(g3, ts, 1);
  var gr = enemyAt(g3, 'o', 5, 1e5);
  E.step(g3);
  assert.ok(gr.stunT > 0, 'stunned');
  var d0 = gr.d; E.step(g3);
  assert.strictEqual(gr.d, d0, 'stunned enemies stand still');
  // the warlord's escorts
  var g4 = rich(0); g4.phase = 'wave'; g4.spawners.length = 0;
  var wl = enemyAt(g4, 'Ω', 10, 1e6); wl.sumT = 0.001;
  E.step(g4);
  assert.strictEqual(g4.enemies.filter(function (e) { return e.k === 'o'; }).length, E.ENEMIES['Ω'].summon.n);
});

test('beam ramps up on one target; banks pay each wave; beacons buff neighbours; taxes', function () {
  var g = rich(0); g.phase = 'wave'; g.spawners.length = 0;
  var bm = E.build(g, 3, 3, T.beam), e = enemyAt(g, 'O', 5, 1e6);
  e.spd = 0;
  E.step(g); var first = 1e6 - e.hp;
  for (var i = 0; i < 240; i++) E.step(g);
  var hp = e.hp; E.step(g);
  var later = hp - e.hp, st = E.stats(g, bm);
  assert.ok(Math.abs(first - st.dmg * E.STEP * (1 + (st.ramp - 1) * E.STEP / st.rampT)) < 1e-6, 'starts at base dps, armour ignored');
  assert.ok(Math.abs(later - st.dmg * st.ramp * E.STEP) < 1e-6, 'fully ramped: x' + st.ramp);
  // a bank pays as each wave starts
  var g2 = E.newGame(0); g2.fxOn = false;
  E.build(g2, 5, 4, T.bank);
  var gold = g2.gold;
  E.nextWave(g2);
  assert.strictEqual(g2.gold, gold + E.TOWERS[T.bank].income[0]);
  // a beacon buffs the towers around it (not itself or other support), the best one wins
  var g3 = rich(0);
  var ar = E.build(g3, 5, 4, T.arrow), far = E.build(g3, 9, 8, T.arrow), bk = E.build(g3, 6, 4, T.bank);
  E.build(g3, 5, 5, T.beacon);
  assert.ok(Math.abs(E.stats(g3, ar).dmg - E.TOWERS[T.arrow].dmg[0] * (1 + E.TOWERS[T.beacon].buff[0])) < 1e-9);
  assert.strictEqual(E.stats(g3, far).dmg, E.TOWERS[T.arrow].dmg[0], 'out of the aura');
  assert.strictEqual(E.stats(g3, bk).dmg, 0);
  var w = E.build(g3, 4, 5, T.beacon); E.upgrade(g3, w); E.upgrade(g3, w); E.upgrade(g3, w, 0);
  assert.ok(Math.abs(E.stats(g3, ar).dmg - E.TOWERS[T.arrow].dmg[0] * 1.4) < 1e-9, 'Warcry +40%');
  assert.ok(Math.abs(E.stats(g3, ar).rate - E.TOWERS[T.arrow].rate[0] * 1.15) < 1e-9, 'and +15% speed');
  // a tax office adds 40% to kills in its range
  var g4 = rich(0); g4.phase = 'wave';
  var tx = E.build(g4, 3, 3, T.bank); E.upgrade(g4, tx); E.upgrade(g4, tx); E.upgrade(g4, tx, 1); E.stats(g4, tx);
  var v = enemyAt(g4, 'o', 5, 10); g4.waveLeft[1] += 5;
  var before = g4.gold; E.hurt(g4, v, 100, true, null);
  assert.strictEqual(g4.gold - before, Math.round(v.bounty * 1.4));
});

test('armory perks: costs, caps and what they change', function () {
  assert.ok(E.PERKS.length >= 8);
  assert.deepStrictEqual(E.cleanPerks({ chest: 9, bogus: 3, steel: -1 }), { chest: 3 });
  assert.strictEqual(E.perkCost(E.cleanPerks({ steel: 2, scouts: 1 })), 2 * 2 + 3);
  var total = E.PERKS.reduce(function (s, p) { return s + p.max * p.cost; }, 0);
  assert.ok(total > E.MAPS.length * 3, 'can\'t buy everything: ' + total + ' vs ' + E.MAPS.length * 3 + ' stars');
  var P = { chest: 2, walls: 1, steel: 3, optics: 1, plunder: 2, eng: 2, salvage: 2, scouts: 1, early: 1 };
  var g = E.newGame(0, P), base = E.newGame(0);
  assert.strictEqual(g.gold, base.gold + 100);
  assert.strictEqual(g.maxLives, base.maxLives + 5); assert.strictEqual(g.lives, g.maxLives);
  g.gold = 1e5;
  var a = E.build(g, 5, 4, T.arrow), st = E.stats(g, a);
  assert.ok(Math.abs(st.dmg - E.TOWERS[T.arrow].dmg[0] * 1.18) < 1e-9 && Math.abs(st.range - E.TOWERS[T.arrow].range[0] * 1.06) < 1e-9);
  assert.strictEqual(st.detect, 1.2, 'scouts');
  assert.strictEqual(E.upgradeCost(a), Math.round(E.TOWERS[T.arrow].cost[1] * 0.84));
  assert.strictEqual(E.sellValue(a), Math.floor(a.spent * 0.9));
  g.phase = 'wave';
  var e = E.spawnEnemy(g, 'o', 1, 0);
  assert.strictEqual(e.bounty, Math.round(E.bountyFor('o', 1) * 1.2));
});

test('leaks cost lives (bosses 5) and zero lives loses', function () {
  var g = E.newGame(0); g.fxOn = false; g.phase = 'wave';
  var e = enemyAt(g, 'o', 48.99);
  var lives = g.lives;
  run(g, 0.2);
  assert.strictEqual(g.lives, lives - 1);
  enemyAt(g, '@', 48.99);
  run(g, 0.2);
  assert.strictEqual(g.lives, lives - 1 - E.ENEMIES['@'].lives);
  assert.strictEqual(E.ENEMIES['@'].lives, 5);
  g.lives = 1;
  enemyAt(g, '>', 48.99);
  run(g, 0.2);
  assert.strictEqual(g.lives, 0);
  assert.strictEqual(g.phase, 'lost');
  assert.strictEqual(e.alive, false);
});

// ---------- fixed step ----------
test('fixed 60 Hz step: same game at 30/60/144 Hz frames; speed runs 2x / 3x the steps', function () {
  function sim(fps, speed) {
    var g = rich(0); E.build(g, 5, 4, T.arrow); E.build(g, 6, 8, T.cannon); E.nextWave(g);
    var dt = 1 / fps, frames = Math.round(12 * fps / (speed || 1));
    for (var f = 0; f < frames; f++) E.advance(g, dt, speed || 1);
    g.events.length = 0;
    return JSON.stringify(E.serialize(g));
  }
  var a = sim(60), b = sim(144), c = sim(30);
  var sa = JSON.parse(a).steps, sb = JSON.parse(b).steps, sc = JSON.parse(c).steps;
  assert.ok(Math.abs(sa - 720) <= 1 && Math.abs(sb - 720) <= 1 && Math.abs(sc - 720) <= 1, 'steps ' + sa + ' ' + sb + ' ' + sc);
  var g2 = JSON.parse(sim(60, 2)), g3 = JSON.parse(sim(60, 3));
  assert.ok(Math.abs(g2.steps - 720) <= 2 && Math.abs(g3.steps - 720) <= 3, 'speed x2/x3 covers the same game time');
  // a long stall doesn't fast-forward
  var g = rich(0); E.nextWave(g);
  E.advance(g, 5, 1);
  assert.ok(g.steps <= 8, 'clamped after a stall: ' + g.steps);
});

// ---------- save / restore, determinism, pools ----------
test('save/restore round-trips and rejects junk', function () {
  var g = E.newGame(2); g.fxOn = false; g.gold = 2000;
  E.build(g, 6, 8, T.tesla); E.build(g, 7, 9, T.cannon); E.upgrade(g, E.towerAt(g, 6, 8));
  E.cycleMode(E.towerAt(g, 7, 9));
  E.nextWave(g); run(g, 9); E.nextWave(g); run(g, 3);
  var s = E.serialize(g);
  assert.ok(s.enemies.length > 0 && s.spawners.length > 0);
  var json = JSON.stringify(s), g2 = E.restore(JSON.parse(json));
  assert.ok(g2);
  assert.strictEqual(JSON.stringify(E.serialize(g2)), json);
  assert.strictEqual(E.towerAt(g2, 6, 8).lvl, 1);
  assert.strictEqual(E.towerAt(g2, 7, 9).mode, 1);
  // the restored game plays on (and both copies stay in step for a while without projectiles)
  run(g2, 5);
  assert.ok(g2.t > g.t);
  assert.strictEqual(E.restore(null), null);
  assert.strictEqual(E.restore({ v: 9, map: 0 }), null);
  assert.strictEqual(E.restore({ v: 2, map: 99 }), null);
  // specialisations, perks and the new status effects survive
  var h = E.newGame(5, { steel: 2 }); h.fxOn = false; h.gold = 1e4;
  var sp = E.build(h, 2, 6, T.sniper); E.upgrade(h, sp); E.upgrade(h, sp); E.upgrade(h, sp, 1);
  E.build(h, 4, 6, T.flame);
  E.nextWave(h); run(h, 20);
  var hs = E.serialize(h), hj = JSON.stringify(hs), h2 = E.restore(JSON.parse(hj));
  assert.strictEqual(JSON.stringify(E.serialize(h2)), hj);
  assert.deepStrictEqual(h2.perks, { steel: 2 });
  assert.strictEqual(E.towerAt(h2, 2, 6).spec, 1);
  assert.strictEqual(E.towerAt(h2, 2, 6).lvl, 3);
  // a save from the first version (no perks, no specs, short enemy rows) still loads
  var v1 = JSON.parse(json); v1.v = 1; delete v1.perks;
  v1.towers = v1.towers.map(function (a) { return a.slice(0, 10); });
  v1.enemies = v1.enemies.map(function (a) { return a.slice(0, 10); });
  var old = E.restore(v1);
  assert.ok(old && old.towers.length === s.towers.length && old.enemies.length === s.enemies.length);
  // towers on bad cells are dropped, not crashing
  var bad = JSON.parse(json); bad.towers.push([999, 0, 0, 1, 0, 0, 0, 60, 0, 0]);
  assert.strictEqual(E.restore(bad).towers.length, s.towers.length);
});

// ---------- whole games ----------
// A scripted, human-style build for Meadow: towers in the pockets between the
// road's switchbacks, then upgrades. Each step waits until it's affordable;
// waves come on their own timer (no early calls).
// ('s', c, r, branch) picks a specialisation.
var MEADOW_PLAN = [
  ['b', 'arrow', 5, 4], ['b', 'arrow', 5, 8], ['b', 'cannon', 4, 4], ['b', 'frost', 6, 8],
  ['u', 5, 4], ['u', 5, 8], ['b', 'tesla', 6, 4], ['b', 'sniper', 4, 8],
  ['b', 'beacon', 5, 5], ['u', 4, 4], ['u', 6, 8], ['b', 'flame', 2, 7], ['u', 6, 4], ['u', 4, 8],
  ['b', 'arrow', 8, 11], ['u', 5, 4], ['u', 5, 8], ['b', 'cannon', 7, 4], ['b', 'tesla', 8, 12], ['u', 8, 11],
  ['u', 4, 4], ['u', 7, 4], ['u', 6, 4], ['u', 4, 8], ['s', 4, 8, 0], ['u', 8, 12], ['u', 2, 7],
  ['b', 'sniper', 6, 9], ['s', 6, 4, 0], ['u', 6, 8], ['u', 7, 4], ['u', 8, 11], ['u', 6, 9], ['s', 4, 4, 1],
  ['u', 8, 12], ['u', 6, 9], ['s', 5, 4, 0], ['u', 5, 5], ['b', 'missile', 3, 8], ['u', 3, 8], ['u', 2, 7], ['s', 6, 9, 1], ['u', 3, 8]
];
function playPlan(mi, plan) {
  var g = E.newGame(mi); g.fxOn = false;
  var i = 0;
  function act() {
    while (i < plan.length) {
      var p = plan[i];
      if (p[0] === 'b') {
        var ty = T[p[1]];
        if (g.gold < E.TOWERS[ty].cost[0]) return;
        assert.ok(E.build(g, p[2], p[3], ty), 'plan step ' + i + ' builds');
      } else {
        var t = E.towerAt(g, p[1], p[2]), b = p[0] === 's' ? p[3] : undefined;
        assert.ok(t, 'plan step ' + i + ' has a tower');
        if (g.gold < E.upgradeCost(t, b)) return;
        assert.ok(E.upgrade(g, t, b), 'plan step ' + i + ' upgrades');
      }
      i++;
    }
  }
  act();
  E.nextWave(g);
  while (g.phase === 'wave' && g.steps < 500000) {
    E.step(g); g.events.length = 0;
    if (g.steps % 30 === 0) act();
  }
  return g;
}
test('Meadow is beatable with a reasonable scripted build (deterministic)', function () {
  var g = playPlan(0, MEADOW_PLAN), g2 = playPlan(0, MEADOW_PLAN);
  assert.strictEqual(g.phase, 'won', 'won (wave ' + g.wave + ', lives ' + g.lives + ')');
  assert.strictEqual(g.wave, 30);
  assert.ok(g.lives >= 12, 'lives left ' + g.lives);
  assert.ok(g.towers.filter(function (t) { return t.lvl === E.MAX_LVL; }).length >= 5, 'specialised');
  assert.strictEqual(JSON.stringify(E.serialize(g)), JSON.stringify(E.serialize(g2)), 'deterministic');
  assert.ok(E.starsFor(g.lives, g.maxLives) >= 2);
  console.log('  Meadow scripted build: won with ' + g.lives + '/' + g.maxLives + ' lives, ' + g.kills + ' kills, ' + g.towers.length + ' towers, $' + g.gold + ' left');
});
test('after a win: stars by lives left, then endless free play until the line breaks', function () {
  assert.strictEqual(E.starsFor(20, 20), 3); assert.strictEqual(E.starsFor(18, 20), 3); assert.strictEqual(E.starsFor(17, 20), 2);
  assert.strictEqual(E.starsFor(10, 20), 2); assert.strictEqual(E.starsFor(9, 20), 1); assert.strictEqual(E.starsFor(1, 20), 1);
  var g = playPlan(0, MEADOW_PLAN), lives = g.lives;
  assert.strictEqual(E.stars(g), E.starsFor(lives, 20));
  assert.strictEqual(E.canCallWave(g), false, 'no wave 31 until free play');
  assert.ok(E.goEndless(g));
  assert.strictEqual(g.phase, 'wave'); assert.strictEqual(g.endless, true);
  assert.strictEqual(E.stars(g), E.starsFor(lives, 20), 'stars keep the winning lives');
  while (g.phase === 'wave' && g.steps < 900000) { E.step(g); g.events.length = 0; }
  assert.strictEqual(g.phase, 'lost', 'free play ends eventually');
  assert.ok(g.wave > 30, 'free play reached wave ' + g.wave);
  console.log('  free play after the scripted Meadow win lasted until wave ' + g.wave);
});
test('Meadow is lost with no towers (within the first four waves)', function () {
  var g = playPlan(0, []);
  assert.strictEqual(g.phase, 'lost');
  assert.ok(g.wave <= 4, 'lost at wave ' + g.wave);
  assert.strictEqual(g.lives, 0);
  assert.strictEqual(g.kills, 0);
});

// A generic coverage bot: builds a fixed order of towers on the cells that see
// the most road (and flyer lane), then upgrades the lowest level first.
function coverageCells(g, flyw) {
  var md = E.mapData(g.map), pts = [], out = [];
  md.paths.forEach(function (P) {
    for (var d = 0; d <= P.len; d += 0.5) {
      var s = 0; while (s < P.cum.length - 2 && P.cum[s + 1] <= d) s++;
      var f = (d - P.cum[s]) / (P.cum[s + 1] - P.cum[s]);
      pts.push([P.x[s] + (P.x[s + 1] - P.x[s]) * f, P.y[s] + (P.y[s + 1] - P.y[s]) * f, 1]);
    }
  });
  md.fly.forEach(function (F) { for (var d = 0; d <= F.len; d += 0.5) pts.push([F.x[0] + (F.x[1] - F.x[0]) * d / F.len, F.y[0] + (F.y[1] - F.y[0]) * d / F.len, flyw]); });
  for (var r = 0; r < E.ROWS; r++) for (var c = 0; c < E.COLS; c++) {
    if (E.cellAt(g, c, r) !== E.CELL_GRASS) continue;
    var n = 0;
    pts.forEach(function (p) { if ((p[0] - c - 0.5) * (p[0] - c - 0.5) + (p[1] - r - 0.5) * (p[1] - r - 0.5) <= 2.6 * 2.6) n += p[2]; });
    out.push({ c: c, r: r, n: n });
  }
  return out.sort(function (a, b) { return b.n - a.n || a.r - b.r || a.c - b.c; });
}
var ORDERS = {
  classic: 'arrow,arrow,cannon,frost,arrow,tesla,sniper,cannon,tesla,frost,sniper,cannon,tesla,arrow,sniper,cannon,tesla,frost,sniper,arrow',
  smart: 'arrow,arrow,cannon,frost,sniper,beacon,tesla,missile,cannon,sniper,flame,beam,tesla,missile,frost,sniper,beam,cannon,arrow,tesla',
  eco: 'arrow,bank,arrow,cannon,frost,beacon,bank,tesla,flame,missile,sniper,cannon,beam,tesla,frost,missile,sniper,flame,cannon,beam'
};
// The specialisation each tower takes (a fixed pick; both branches are close in value).
var BRANCH = { arrow: 0, cannon: 1, frost: 1, tesla: 0, sniper: 0, flame: 0, missile: 1, beam: 1, bank: 0, beacon: 0 };
function botGame(mi, order, rate, perks) {
  var g = E.newGame(mi, perks); g.fxOn = false;
  var cells = coverageCells(g, 0.6), seq = ORDERS[order].split(',');
  function act() {
    var want = Math.min(seq.length, 2 + Math.floor(g.wave * rate));
    for (var k = 0; k < 20; k++) {
      if (g.towers.length < want) {
        var ty = T[seq[g.towers.length]], cell = null;
        for (var i = 0; i < cells.length; i++) if (E.canBuild(g, cells[i].c, cells[i].r)) { cell = cells[i]; break; }
        if (!cell || g.gold < E.TOWERS[ty].cost[0]) return;
        E.build(g, cell.c, cell.r, ty);
      } else {
        var best = null;
        g.towers.forEach(function (t) { if (t.lvl < E.MAX_LVL && (!best || t.lvl < best.lvl)) best = t; });
        if (!best) return;
        var b = BRANCH[E.TOWERS[best.type].key];
        if (g.gold < E.upgradeCost(best, b)) return;
        E.upgrade(g, best, b);
      }
    }
  }
  act(); E.nextWave(g);
  while (g.phase === 'wave' && g.steps < 500000) { E.step(g); g.events.length = 0; if (g.steps % 30 === 0) act(); }
  return g;
}
test('balance: every map can be won, harder maps fall to more plans, perks help', function () {
  // win rate of 3 build orders x 2 build paces per map, by difficulty
  var res = E.MAPS.map(function (M, mi) {
    var wins = 0, line = [];
    Object.keys(ORDERS).forEach(function (o) {
      [0.45, 0.6].forEach(function (r) {
        var g = botGame(mi, o, r);
        if (g.phase === 'won') wins++;
        line.push(o + '@' + r + ':' + (g.phase === 'won' ? '♥' + g.lives : 'w' + g.wave));
      });
    });
    return { id: M.id, diff: M.diff, wins: wins, line: line.join(' ') };
  });
  res.forEach(function (r) { assert.ok(r.wins >= 1, r.id + ' can be won: ' + r.line); });
  var byDiff = { easy: [], medium: [], hard: [], expert: [] };
  res.forEach(function (r) { byDiff[r.diff].push(r.wins); });
  function avg(a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; }
  assert.ok(byDiff.easy[0] >= 5, 'Meadow falls to almost any plan: ' + res[0].line);
  assert.ok(avg(byDiff.easy) > avg(byDiff.medium) && avg(byDiff.medium) >= avg(byDiff.hard) && avg(byDiff.hard) > avg(byDiff.expert),
    'difficulty labels hold: ' + JSON.stringify(byDiff));
  // stars spent in the Armory turn a lost expert map around
  var sky = E.MAPS.map(function (M) { return M.id; }).indexOf('sky');
  var plain = botGame(sky, 'smart', 0.45), perked = botGame(sky, 'smart', 0.45, { steel: 3, optics: 2, chest: 3, plunder: 2, eng: 2, walls: 1 });
  assert.strictEqual(plain.phase, 'lost'); assert.strictEqual(perked.phase, 'won');
  console.log('  bot wins (of 6) per map: ' + res.map(function (r) { return r.id + ' ' + r.wins; }).join(' · '));
});

test('pools: enemies, projectiles and effects are reused, not reallocated', function () {
  var g = playPlan(0, MEADOW_PLAN.slice(0, 12));
  // after many waves the pools hold the spare objects; the totals stay small
  assert.ok(g.enemies.length + g.epool.length <= 120, 'enemy objects ' + (g.enemies.length + g.epool.length));
  var g2 = E.newGame(0); g2.gold = 1e5;
  [[5, 4, 'arrow'], [5, 8, 'cannon'], [4, 4, 'arrow'], [6, 8, 'tesla'], [4, 8, 'sniper'], [6, 4, 'frost']].forEach(function (b) { E.build(g2, b[0], b[1], T[b[2]]); });
  E.nextWave(g2);
  var maxP = 0, maxF = 0;
  for (var i = 0; i < 60 * 120 && g2.phase === 'wave'; i++) {
    E.step(g2); g2.events.length = 0;
    maxP = Math.max(maxP, g2.proj.length + g2.ppool.length); maxF = Math.max(maxF, g2.fx.length + g2.fxpool.length);
  }
  assert.ok(maxP <= 160 && maxF <= 240, 'bounded pools: proj ' + maxP + ' fx ' + maxF);
  assert.ok(g2.fxpool.length > 0, 'effects recycled');
});

console.log((process.exitCode ? 'FAILED' : 'ok') + ' — ' + passed + ' passed');
