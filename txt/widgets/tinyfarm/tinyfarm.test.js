/* Headless checks for the Tiny Farm engine (growth, weather, offline replay, economy, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/tinyfarm/tinyfarm.test.js */
'use strict';
var assert = require('assert');

var E = require('./tinyfarm.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./tinyfarm.js')];
require('./tinyfarm.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var T0 = Date.UTC(2026, 3, 6, 9, 0, 0);          // a Monday morning, UTC
function farm(opts) {
  opts = opts || {};
  var s = E.newSave(T0, opts.seed || 1234, 0);
  if (opts.wx !== false) s._wx = opts.wx || 'sun';
  if (opts.ev !== true) s._noEv = true;
  s.coins = opts.coins == null ? 10000 : opts.coins;
  s.xp = opts.xp || 0; s.lv = E.levelOf(s.xp);
  return s;
}
function seq(vals) { var i = 0; return function () { return vals[i++ % vals.length]; }; }
var NOGOLD = function () { return 0.99; }, GOLD = function () { return 0; };

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Tiny Farm' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'tinyfarm.css');
  assert.strictEqual(widget._engine.VERSION, E.VERSION);
});

test('data tables are well formed', function () {
  var ids = {};
  E.CROPS.forEach(function (c) {
    assert.ok(!ids[c.id], 'unique ' + c.id); ids[c.id] = 1;
    assert.ok(c.grow > 0 && c.cost > 0 && c.sell > 0 && c.y > 0 && c.xp > 0 && c.lv >= 1 && c.sea > 0 && c.sea <= 15, c.id);
    assert.strictEqual(c.a.length, 3); assert.strictEqual(c.m.length, 3);
    for (var r = 0; r < 3; r++) {
      assert.strictEqual(c.a[r].length, 5, c.id + ' art row ' + r);
      assert.strictEqual(c.m[r].length, 5, c.id + ' mask row ' + r);
      for (var k = 0; k < 5; k++) assert.strictEqual(c.a[r][k] === ' ', c.m[r][k] === ' ', c.id + ' mask matches art ' + r + ':' + k);
    }
    if (c.re) assert.ok(c.re < c.grow && c.reN > 1);
    // a harvest always beats its seed
    assert.ok(c.sell * c.y * (c.reN || 1) > c.cost * 1.15, c.id + ' is profitable');
  });
  E.STAGES.forEach(function (st) { st.a.forEach(function (l) { assert.strictEqual(l.length, 5); }); });
  // every season has something to sow, at level 1 at least cress
  for (var se = 0; se < 4; se++) assert.ok(E.CROPS.filter(function (c) { return E.inSeason(c, se) && c.lv <= 2; }).length >= 2, 'season ' + se);
  E.UPGRADES.forEach(function (u) { assert.strictEqual(u.cost.length, u.max); assert.strictEqual(u.lv.length, u.max); assert.strictEqual(u.val.length, u.max + 1); });
  E.ANIMALS.forEach(function (a) { assert.strictEqual(a.cost.length, a.max); });
});

test('a crop ripens on time, dry', function () {
  var s = farm();
  assert.ok(E.plant(s, 0, 'cress', T0).ok);
  var G = E.CROP.cress.grow * 1000;
  assert.strictEqual(E.stageOf(s.plots[0]), 0);
  E.tick(s, T0 + G * 0.3);
  assert.strictEqual(E.stageOf(s.plots[0]), 1);
  E.tick(s, T0 + G - 500);
  assert.ok(!E.isReady(s.plots[0]));
  assert.strictEqual(E.stageOf(s.plots[0]), 2);
  var rep = E.tick(s, T0 + G);
  assert.ok(E.isReady(s.plots[0]));
  assert.deepStrictEqual(rep.ripe, [0]);
  assert.strictEqual(E.stageOf(s.plots[0]), 3);
});

test('watering doubles the speed while it lasts', function () {
  var s = farm();
  var G = E.CROP.radish.grow;            // 300 s dry, fits in one 10-minute watering
  E.plant(s, 0, 'radish', T0);
  assert.ok(E.water(s, 0, T0));
  assert.ok(!E.water(s, 0, T0 + 1000), 'still wet: no double watering');
  assert.strictEqual(s.plots[0].w, T0 + 10 * E.MIN);
  assert.ok(Math.abs(E.etaOf(s, 0) - G / 2 * 1000) < 2);
  E.tick(s, T0 + (G / 2 - 1) * 1000);
  assert.ok(!E.isReady(s.plots[0]));
  E.tick(s, T0 + (G / 2 + 1) * 1000);
  assert.ok(E.isReady(s.plots[0]));
  // water runs out part way through: 600 s wet (= 1200 s of growth), the rest dry
  var s3 = farm();
  var C = E.CROP.corn.grow;
  s3.plots[0].c = 'corn'; s3.plots[0].g = 0; E.water(s3, 0, T0);
  var eta = 600 + (C - 1200);
  assert.ok(Math.abs(E.etaOf(s3, 0) - eta * 1000) < 2);
  E.tick(s3, T0 + (eta - 1) * 1000); assert.ok(!E.isReady(s3.plots[0]));
  E.tick(s3, T0 + (eta + 1) * 1000); assert.ok(E.isReady(s3.plots[0]));
});

test('rain waters everything, snow slows non-winter crops, sprinklers cover the first plots', function () {
  var s = farm({ wx: 'rain' });
  E.plant(s, 0, 'cress', T0);
  E.tick(s, T0 + E.CROP.cress.grow * 500 + 1);
  assert.ok(E.isReady(s.plots[0]));
  var w = farm({ wx: 'snow' });
  w.xp = E.xpFor(3); w.lv = 3;
  // pretend it's winter for planting kale: season gating is checked separately
  w.plots[0].c = 'radish'; w.plots[0].g = 0;
  w.plots[1].c = 'kale'; w.plots[1].g = 0;
  E.tick(w, T0 + 60 * 1000);
  assert.ok(Math.abs(w.plots[0].g - 30) < 1e-6, 'radish at half speed in snow');
  assert.ok(Math.abs(w.plots[1].g - 60) < 1e-6, 'kale shrugs off the snow');
  var k = farm();
  k.upg.sprinkler = 1;
  E.plant(k, 2, 'cress', T0); E.plant(k, 5, 'cress', T0);
  assert.ok(!E.water(k, 2, T0), 'sprinkled plots need no can');
  assert.ok(!E.needsWater(k, 2, T0) && E.needsWater(k, 5, T0));
  E.tick(k, T0 + E.CROP.cress.grow * 500 + 1);
  assert.ok(E.isReady(k.plots[2]) && !E.isReady(k.plots[5]));
});

test('weather is deterministic, varies, and follows the season tables', function () {
  var s = E.newSave(T0, 99, 0), seen = {}, i;
  for (i = 0; i < 400; i++) {
    var t = T0 + i * E.WX_BLOCK, w = E.weatherAt(s, t);
    assert.strictEqual(w, E.weatherAt(s, t + E.WX_BLOCK - 1), 'constant within a block');
    seen[w] = 1;
    if (E.seasonOf(s, t) !== 3) assert.notStrictEqual(w, 'snow');
  }
  assert.ok(seen.sun && seen.rain && seen.cloud && seen.snow, JSON.stringify(seen));
  var s2 = E.newSave(T0, 99, 0);
  assert.strictEqual(E.weatherAt(s2, T0 + 77 * E.HOUR), E.weatherAt(s, T0 + 77 * E.HOUR));
});

test('seasons turn every 7 days; planting is season and level gated', function () {
  var s = farm({ xp: 0 });
  assert.strictEqual(E.seasonOf(s, T0), 0);
  assert.strictEqual(E.seasonDay(s, T0), 1);
  assert.strictEqual(E.seasonOf(s, T0 + 7 * E.DAY), 1);
  assert.strictEqual(E.seasonOf(s, T0 + 21 * E.DAY), 3);
  assert.strictEqual(E.seasonOf(s, T0 + 28 * E.DAY), 0);
  assert.strictEqual(E.year(s, T0 + 28 * E.DAY), 2);
  assert.strictEqual(E.canPlant(s, 'tomato', T0), 'level');
  s.xp = E.xpFor(4); s.lv = 4;
  assert.strictEqual(E.canPlant(s, 'tomato', T0), 'season');
  assert.strictEqual(E.canPlant(s, 'tomato', T0 + 8 * E.DAY), '');
  assert.strictEqual(E.plant(s, 0, 'tomato', T0).err, 'season');
  assert.strictEqual(E.canPlant(s, 'nope', T0), 'unknown');
  // timezone: a farm in UTC+10 sees the day turn 10 hours earlier
  var a = E.newSave(T0, 1, -600);
  assert.strictEqual(E.dayOf(a, T0) - E.dayOf(E.newSave(T0, 1, 0), T0), 0);
  assert.ok(Math.abs(E.hourOf(a, T0) - 19) < 1e-9);
});

test('seeds come from the bag first, then are bought on the spot', function () {
  var s = farm({ coins: 10 });
  assert.strictEqual(s.seeds.cress, 6);
  var r = E.plant(s, 0, 'cress', T0);
  assert.ok(r.ok && !r.bought && s.seeds.cress === 5 && s.coins === 10);
  assert.strictEqual(E.plant(s, 0, 'cress', T0).err, 'busy');
  s.seeds = {};
  r = E.plant(s, 1, 'cress', T0);
  assert.ok(r.ok && r.bought && s.coins === 8);
  s.coins = 1;
  assert.strictEqual(E.plant(s, 2, 'cress', T0).err, 'coins');
  assert.ok(!E.buySeeds(s, 'cress', 5));
  s.coins = 100;
  assert.ok(E.buySeeds(s, 'radish', 5) && s.seeds.radish === 5 && s.coins === 75);
  assert.ok(!E.buySeeds(s, 'starfruit', 1), 'locked seeds are not for sale');
  var pa = E.plantAll(s, 'radish', T0);
  assert.strictEqual(pa.n, 4);
  assert.ok(!s.seeds.radish || s.seeds.radish === 1);
});

test('harvest: yield into the barn, xp, regrowing crops, golden crops, a full barn', function () {
  var s = farm();
  s.xp = E.xpFor(4); s.lv = 4;
  var TG = E.CROP.tomato.grow;
  s.plots[0].c = 'tomato'; s.plots[0].g = TG;
  var xp0 = s.xp, r = E.harvest(s, 0, T0, NOGOLD);
  assert.ok(r.ok && r.n === 2 && !r.gold && r.regrow);
  assert.strictEqual(s.inv.tomato, 2);
  assert.strictEqual(s.xp, xp0 + 5);
  assert.strictEqual(s.plots[0].g, TG - E.CROP.tomato.re);
  assert.strictEqual(s.plots[0].h, 1);
  for (var k = 0; k < 3; k++) { s.plots[0].g = TG; assert.ok(E.harvest(s, 0, T0, NOGOLD).ok); }
  assert.strictEqual(s.plots[0].c, null, 'tomato done after 4 harvests');
  assert.strictEqual(s.inv.tomato, 8);
  s.plots[1].c = 'cress'; s.plots[1].g = 999;
  r = E.harvest(s, 1, T0, GOLD);
  assert.ok(r.gold && s.inv['cress*'] === 1 && s.st.gold === 1);
  assert.ok(Math.abs(E.priceOf(s, 'cress*', T0) - 5 * E.priceOf(s, 'cress', T0)) <= 3, 'golden is worth 5x');
  assert.strictEqual(E.harvest(s, 2, T0).err, 'notready');
  // barn capacity (40 at tier 0)
  s.inv = { wheat: 39 };
  s.plots[2].c = 'cress'; s.plots[2].g = 999;
  assert.ok(E.harvest(s, 2, T0, NOGOLD).ok);
  s.plots[3].c = 'cress'; s.plots[3].g = 999;
  assert.strictEqual(E.harvest(s, 3, T0, NOGOLD).err, 'full');
  assert.ok(E.buyUpg(s, 'barn') && E.barnCap(s) === 80);
  var all = E.harvestAll(s, T0, NOGOLD);
  assert.ok(all.n === 1 && !all.full);
  assert.ok(s.st.crops.tomato && s.st.crops.cress && s.st.seasons[0]);
});

test('market: daily prices within ±15% (+20% off season), selling pays and records', function () {
  var s = farm({ coins: 0 });
  for (var d = 0; d < 60; d++) {
    var t = T0 + d * E.DAY;
    E.CROPS.forEach(function (c) {
      var p = E.priceOf(s, c.id, t), off = E.inSeason(c, E.seasonOf(s, t)) ? 1 : 1.2;
      assert.ok(p >= Math.floor(c.sell * 0.85 * off) && p <= Math.ceil(c.sell * 1.15 * off), c.id + ' ' + p);
    });
  }
  assert.strictEqual(E.priceOf(s, 'cress', T0), E.priceOf(s, 'cress', T0 + E.HOUR), 'one price all day');
  s.inv = { radish: 3, egg: 2 };
  var g = E.sell(s, 'radish', 1, T0);
  assert.ok(g === E.priceOf(s, 'radish', T0) && s.inv.radish === 2 && s.coins === g && s.st.earned === g);
  var g2 = E.sellAll(s, T0);
  assert.ok(g2 > 0 && E.invCount(s) === 0 && s.coins === g + g2);
  assert.strictEqual(E.sell(s, 'radish', 5, T0), 0);
  assert.strictEqual(E.priceOf(s, 'bogus', T0), 0);
});

test('crows peck unless shooed, bugs stop growth then wander off, events are deterministic', function () {
  var s = farm();
  s.xp = E.xpFor(7); s.lv = 7;
  assert.strictEqual(E.plant(s, 0, 'corn', T0).err, 'season');
  E.plant(s, 0, 'carrot', T0);
  s.plots[0].crow = T0 + E.CROW_WAIT;
  E.tick(s, T0 + E.CROW_WAIT - 1000);
  assert.ok(s.plots[0].crow && Math.abs(s.plots[0].g - 89) < 1e-6);
  E.tick(s, T0 + E.CROW_WAIT + 1000);
  assert.strictEqual(s.plots[0].crow, 0);
  assert.ok(Math.abs(s.plots[0].g - 1) < 1e-6, 'pecked back to 0 then grew 1 s: ' + s.plots[0].g);
  assert.strictEqual(s.st.pecked, 1);
  s.plots[0].crow = s.t + E.CROW_WAIT;
  assert.ok(E.shoo(s, 0) && !s.plots[0].crow && s.st.shoo === 1);
  assert.ok(!E.shoo(s, 0));
  // a bug: no growth while it chews; leaves after PEST_MAX
  var b = farm();
  E.plant(b, 0, 'radish', T0);
  b.plots[0].pest = T0;
  E.tick(b, T0 + E.HOUR);
  assert.strictEqual(b.plots[0].g, 0);
  var rep = E.tick(b, T0 + E.PEST_MAX + 30 * 1000);
  assert.strictEqual(b.plots[0].pest, 0);
  assert.strictEqual(rep.bugsLeft, 1);
  assert.ok(Math.abs(b.plots[0].g - 30) < 1e-6);
  b.plots[0].pest = b.t;
  assert.ok(E.squash(b, 0) && b.st.bugs === 1);
  // random events: same seed + same timeline → same farm
  function sim(seed) {
    var f = E.newSave(T0, seed, 0);
    f.coins = 1e5; f.xp = E.xpFor(8); f.lv = 8;
    for (var i = 0; i < f.plots.length; i++) E.plant(f, i, i % 2 ? 'carrot' : 'lettuce', T0);
    var all = E.newRep();
    E.tick(f, T0 + 3 * E.DAY, all);
    return { f: f, rep: all };
  }
  var a = sim(7), c = sim(7), d = sim(8);
  assert.deepStrictEqual(a.f, c.f);
  assert.ok(a.rep.crows.length + a.rep.pests + a.rep.bees + a.rep.gift > 0, 'something happened in 3 days');
  assert.notDeepStrictEqual(a.f.log, d.f.log);
});

test('offline replay: one big jump equals many small ticks', function () {
  [3, 11, 42].forEach(function (seed) {
    function mk() {
      var f = E.newSave(T0, seed, 0);
      f.coins = 1e5; f.xp = E.xpFor(8); f.lv = 8; f.upg.can = 2; f.upg.scarecrow = 1;
      E.buyAnimal(f, 'chicken', T0); E.buyAnimal(f, 'chicken', T0); E.buyAnimal(f, 'cow', T0);
      var crops = ['cress', 'radish', 'lettuce', 'carrot', 'wheat', 'berry'];
      for (var i = 0; i < f.plots.length; i++) E.plant(f, i, crops[i], T0);
      E.water(f, 0, T0); E.water(f, 3, T0);
      return f;
    }
    var big = mk(), small = mk(), rb = E.newRep(), rs = E.newRep(), end = T0 + 26 * E.HOUR + 1234;
    E.tick(big, end, rb);
    for (var t = T0; t < end; t += 7919) E.tick(small, Math.min(end, t + 7919), rs);
    E.tick(small, end, rs);
    assert.strictEqual(big.t, small.t);
    for (var i = 0; i < big.plots.length; i++) {
      var p = big.plots[i], q = small.plots[i];
      assert.strictEqual(p.c, q.c, 'plot ' + i);
      assert.ok(Math.abs(p.g - q.g) < 1e-3, 'plot ' + i + ' ' + p.g + ' vs ' + q.g);
      assert.strictEqual(p.crow, q.crow); assert.strictEqual(p.pest, q.pest);
    }
    assert.deepStrictEqual(big.an, small.an);
    assert.strictEqual(big.coins, small.coins);
    assert.strictEqual(rb.pecked, rs.pecked);
    assert.strictEqual(rb.ripe.length, rs.ripe.length);
    assert.ok(Math.abs(rb.wetH - rs.wetH) < 1e-6);
  });
});

test('animals produce while away, up to their stash cap; collecting fills the barn', function () {
  var s = farm();
  s.xp = E.xpFor(6); s.lv = 6;
  assert.ok(E.buyAnimal(s, 'chicken', T0) && E.buyAnimal(s, 'chicken', T0));
  assert.strictEqual(s.coins, 10000 - E.ANIMAL.chicken.cost[0] - E.ANIMAL.chicken.cost[1]);
  var rep = E.tick(s, T0 + 61 * E.MIN);
  assert.strictEqual(s.an.chicken.stash, 4);
  assert.strictEqual(rep.prod.egg, 4);
  E.tick(s, T0 + 10 * E.HOUR);
  assert.strictEqual(s.an.chicken.stash, 6, 'capped at 3 each');
  assert.strictEqual(E.waiting(s), 6);
  var c = E.collect(s, s.t, NOGOLD);
  assert.ok(c.egg === 6 && s.inv.egg === 6 && s.st.eggs === 6 && E.waiting(s) === 0);
  assert.strictEqual(s.an.chicken.t, s.t, 'a full coop restarts on collection');
  E.tick(s, s.t + 29 * E.MIN); assert.strictEqual(s.an.chicken.stash, 0);
  E.tick(s, s.t + 2 * E.MIN); assert.strictEqual(s.an.chicken.stash, 2);
  // the barn limits collection
  s.inv = { wheat: 39 };
  c = E.collect(s, s.t, GOLD);
  assert.ok(c.full && c.egg === 1 && s.inv['egg*'] === 1 && s.an.chicken.stash === 1);
  // level / max gating
  var f = farm(); assert.ok(!E.buyAnimal(f, 'cow', T0), 'cows need level 6');
  f.xp = E.xpFor(6); f.lv = 6;
  for (var k = 0; k < 6; k++) assert.ok(E.buyAnimal(f, 'chicken', T0));
  assert.ok(!E.buyAnimal(f, 'chicken', T0) && E.animalCost(f, 'chicken') === -1);
});

test('land and upgrades: costs rise, levels gate, maxed is maxed', function () {
  var s = farm({ coins: 1e6 });
  var last = 0;
  while (E.expandCost(s) > 0) { var c = E.expandCost(s); assert.ok(c > last); last = c; assert.ok(E.expand(s)); }
  assert.strictEqual(s.plots.length, E.MAX_PLOTS);
  assert.ok(!E.expand(s));
  assert.ok(!E.buyUpg(s, 'sprinkler'), 'sprinklers need level 3');
  s.xp = E.xpFor(20); s.lv = 20;
  E.UPGRADES.forEach(function (u) { for (var k = 0; k < u.max; k++) assert.ok(E.buyUpg(s, u.id), u.id + ' ' + k); assert.ok(!E.buyUpg(s, u.id)); assert.strictEqual(E.upgCost(s, u.id), -1); });
  assert.strictEqual(E.sprinkled(s), 24); assert.strictEqual(E.barnCap(s), 640); assert.strictEqual(E.canDur(s), 4 * E.HOUR);
  var poor = farm({ coins: 5 }); assert.ok(!E.expand(poor) && poor.plots.length === 6);
});

test('levels: thresholds rise, level up is logged', function () {
  for (var lv = 2; lv < 30; lv++) assert.ok(E.xpFor(lv + 1) > E.xpFor(lv));
  assert.strictEqual(E.levelOf(0), 1);
  assert.strictEqual(E.levelOf(E.xpFor(5)), 5);
  assert.strictEqual(E.levelOf(E.xpFor(5) - 1), 4);
  var s = farm();
  s.xp = E.xpFor(2) - 1;
  s.plots[0].c = 'starfruit'; s.plots[0].g = E.CROP.starfruit.grow;
  E.harvest(s, 0, T0, NOGOLD);
  assert.strictEqual(s.lv, E.levelOf(s.xp));
  assert.ok(s.lv >= 2);
  assert.ok(/level/.test(s.log[s.log.length - 1].m));
  var li = E.levelInfo(s); assert.ok(li.frac >= 0 && li.frac <= 1 && li.lv === s.lv);
});

test('daily gift: once a day, streaks grow, a missed day resets', function () {
  var s = farm({ coins: 0 });
  assert.ok(E.canDaily(s, T0));
  var r = E.claimDaily(s, T0);
  assert.ok(r && r.streak === 1 && s.coins === 30 && s.seeds[r.seed] >= 3 && r.seed !== 'cress');
  assert.strictEqual(E.claimDaily(s, T0 + E.HOUR), null);
  for (var d = 1; d < 7; d++) r = E.claimDaily(s, T0 + d * E.DAY);
  assert.ok(r.streak === 7 && r.coins === 20 + 70 + 50 && s.daily.best === 7);
  r = E.claimDaily(s, T0 + 9 * E.DAY);
  assert.strictEqual(r.streak, 1);
  assert.strictEqual(s.daily.best, 7);
  var got = E.checkAch(s, T0);
  assert.ok(got.some(function (a) { return a.id === 'streak'; }));
  assert.strictEqual(E.checkAch(s, T0).length, 0, 'achievements pay once');
});

test('achievements pay their reward once', function () {
  var s = farm({ coins: 0 });
  s.plots[0].c = 'cress'; s.plots[0].g = 120;
  E.harvest(s, 0, T0, GOLD);
  var got = E.checkAch(s, T0).map(function (a) { return a.id; });
  assert.deepStrictEqual(got.sort(), ['first', 'gold']);
  assert.strictEqual(s.coins, 60);
  assert.ok(s.ach.first && s.ach.gold);
});

test('the clock going back neither grows nor breaks the farm; long absences are capped', function () {
  var s = farm();
  E.plant(s, 0, 'cress', T0);
  E.tick(s, T0 + 30 * 1000);
  E.tick(s, T0 - E.DAY);
  assert.strictEqual(s.t, T0 - E.DAY);
  assert.ok(Math.abs(s.plots[0].g - 30) < 1e-9);
  E.tick(s, T0 - E.DAY + 10 * 1000);
  assert.ok(Math.abs(s.plots[0].g - 40) < 1e-9);
  // a year away: replay is capped and quick
  var f = E.newSave(T0, 5, 0);
  f.coins = 1e5; f.xp = E.xpFor(10); f.lv = 10;
  E.buyAnimal(f, 'chicken', T0);
  for (var i = 0; i < 6; i++) E.plant(f, i, 'starfruit', T0);
  var t = Date.now();
  var rep = E.tick(f, T0 + 365 * E.DAY);
  assert.ok(Date.now() - t < 1500, 'replay took ' + (Date.now() - t) + ' ms');
  assert.strictEqual(f.t, T0 + 365 * E.DAY);
  assert.ok(f.plots.every(function (p) { return E.isReady(p); }), 'all ripe after a long time');
  assert.strictEqual(f.an.chicken.stash, 3);
  assert.ok(rep.ripe.length === 6);
  E.tick(f, NaN);
  assert.strictEqual(f.t, T0 + 365 * E.DAY);
});

test('save normalisation: round trip, garbage, hostile values', function () {
  var s = farm();
  delete s._wx; delete s._noEv;
  s.xp = E.xpFor(6); s.lv = 6;
  E.plant(s, 0, 'carrot', T0); E.water(s, 0, T0); E.buyAnimal(s, 'chicken', T0); E.buyUpg(s, 'barn');
  s.inv = { carrot: 4, 'egg*': 1 }; s.st.crops.carrot = 1; s.st.seasons[2] = 1; s.ach.first = T0;
  E.claimDaily(s, T0);
  var n = E.normSave(JSON.parse(JSON.stringify(s)), T0 + 5000);
  assert.deepStrictEqual(n, s);
  var g = E.normSave(null, T0);
  assert.ok(g.plots.length === E.START_PLOTS && g.coins === E.START_COINS && g.t === T0);
  g = E.normSave('nonsense', T0); assert.strictEqual(g.coins, E.START_COINS);
  var bad = E.normSave({
    t: T0, seed: 3, coins: -50, xp: 'lots', plots: [{ c: 'durian', g: 5 }, { c: 'cress', g: 1e9, h: 7 }, null, 4, 'x', {}, {}],
    seeds: { cress: -3, radish: 2.7, bogus: 4 }, inv: { carrot: 1e12, nope: 3, 'radish*': 2 },
    upg: { can: 99, sprinkler: -1 }, an: { chicken: { n: 40, stash: 900 }, cow: 'moo' }, sel: 'durian',
    daily: { last: 'x' }, st: { harv: -4, crops: { cress: 1, fake: 1 }, seasons: { 9: 1, 1: 1 } }, ach: { first: 1, bogus: 1 },
    log: [{ t: 1, m: 'hi' }, { m: 5 }, null]
  }, T0);
  assert.strictEqual(bad.coins, 0);
  assert.strictEqual(bad.xp, 0);
  assert.strictEqual(bad.plots.length, 8, 'odd plot counts round up to a pair');
  assert.strictEqual(bad.plots[0].c, null);
  assert.ok(bad.plots[1].c === 'cress' && bad.plots[1].g === E.CROP.cress.grow && bad.plots[1].h === 0);
  assert.deepStrictEqual(bad.seeds, { radish: 2 });
  assert.ok(bad.inv.carrot === 1e6 && !bad.inv.nope && bad.inv['radish*'] === 2);
  assert.ok(bad.upg.can === 3 && bad.upg.sprinkler === 0);
  assert.ok(bad.an.chicken.n === 6 && bad.an.chicken.stash === 18 && bad.an.cow.n === 0);
  assert.strictEqual(bad.sel, 'cress');
  assert.strictEqual(bad.daily.last, -1);
  assert.ok(bad.st.harv === 0 && bad.st.crops.cress && !bad.st.crops.fake && bad.st.seasons[1] && !bad.st.seasons[9]);
  assert.ok(bad.ach.first && !bad.ach.bogus);
  assert.deepStrictEqual(bad.log, [{ t: 1, m: 'hi' }]);
  // a normalised farm keeps ticking
  E.tick(bad, T0 + E.DAY);
  assert.ok(E.isReady(bad.plots[1]));
});

test('a new player can play: a day of tapping makes money and levels', function () {
  var s = E.newSave(T0, 2024, 0), t = T0, rnd = seq([0.5, 0.7, 0.9, 0.2]);
  s._noEv = true;
  for (var step = 0; step < 24 * 60; step++) {      // a tap round every minute for a day
    t += E.MIN;
    E.tick(s, t);
    E.harvestAll(s, t, rnd);
    if (E.invCount(s) > 10) E.sellAll(s, t);
    var best = E.CROPS.filter(function (c) { return E.canPlant(s, c.id, t) === '' && c.grow <= 900; }).pop();
    if (best) E.plantAll(s, best.id, t);
    E.waterAll(s, t);
    if (E.expandCost(s) > 0 && s.coins > E.expandCost(s) * 2) E.expand(s);
    E.checkAch(s, t);
  }
  assert.ok(s.lv >= 6, 'level ' + s.lv);
  assert.ok(s.plots.length > 6, 'expanded to ' + s.plots.length);
  assert.ok(s.st.earned > 1000, 'earned ' + s.st.earned);
});

test('reviewer: eta matches the real ripening time under live weather', function () {
  for (var seed = 1; seed <= 12; seed++) {
    var s = E.newSave(T0, seed * 7919, 0); s._noEv = true; s.coins = 1e6; s.xp = E.xpFor(10); s.lv = E.levelOf(s.xp);
    var id = ['garlic', 'kale', 'mushroom', 'starfruit'][seed % 4];
    E.tick(s, T0 + seed * 21 * E.DAY);                       // land in a variety of seasons
    var t = s.t;
    if (E.canPlant(s, id, t)) { id = 'starfruit'; }
    assert.ok(E.plant(s, 0, id, t).ok, id);
    if (seed % 2) E.water(s, 0, t);
    var eta = E.etaOf(s, 0);
    assert.ok(isFinite(eta) && eta > 0, 'eta ' + eta);
    var a = JSON.parse(JSON.stringify(s)); a._noEv = true;
    E.tick(a, t + eta - 2000);
    assert.ok(!E.isReady(a.plots[0]), 'not ready just before eta (' + id + ')');
    E.tick(a, t + eta + 2000);
    assert.ok(E.isReady(a.plots[0]), 'ready just after eta (' + id + ')');
  }
});

test('reviewer: odd inputs to actions never throw or corrupt', function () {
  var s = farm();
  assert.strictEqual(E.sell(s, 'nothing', 5, T0), 0);
  s.inv.cress = 3;
  assert.strictEqual(E.sell(s, 'cress', -4, T0), 0);
  assert.ok(E.sell(s, 'cress', 99, T0) > 0);
  assert.ok(!s.inv.cress);
  assert.ok(!E.plant(s, 99, 'cress', T0).ok);
  assert.ok(!E.plant(s, 0, 'nope', T0).ok);
  assert.strictEqual(E.water(s, 99, T0), false);
  assert.strictEqual(E.shoo(s, 99), false);
  assert.strictEqual(E.harvest(s, 99, T0).err, 'notready');
  assert.strictEqual(E.buyUpg(s, 'laser'), false);
  assert.strictEqual(E.buyAnimal(s, 'dragon', T0), false);
  var before = JSON.stringify(s);
  E.tick(s, NaN); E.tick(s, Infinity);
  assert.strictEqual(JSON.stringify(s), before);
});

test('reviewer: a crow on a dug-up plot leaves with it; a full barn stops collecting part way', function () {
  var s = farm();
  E.plant(s, 0, 'cress', T0);
  s.plots[0].crow = T0 + E.CROW_WAIT;
  assert.ok(E.dig(s, 0));
  E.tick(s, T0 + E.HOUR);
  assert.strictEqual(s.plots[0].c, null); assert.strictEqual(s.plots[0].crow, 0); assert.strictEqual(s.st.pecked, 0);
  s.xp = E.xpFor(6); s.lv = E.levelOf(s.xp);
  assert.ok(E.buyAnimal(s, 'chicken', s.t));
  s.inv.wheat = E.barnCap(s) - 1;
  E.tick(s, s.t + 3 * E.HOUR);
  assert.strictEqual(E.waiting(s), 3);
  var r = E.collect(s, s.t, NOGOLD);
  assert.ok(r.full && r.egg === 1 && E.waiting(s) === 2 && E.invCount(s) === E.barnCap(s));
});

test('reviewer: normalised saves keep playing (tick + actions) without NaN', function () {
  var junk = [{ t: T0, plots: [{ c: 'corn', g: 'x', w: -5, h: 99, pest: NaN, crow: 'y' }], coins: -1, an: { cow: { n: 99, stash: -3 } } },
    { t: T0, plots: 'no', seeds: [1, 2], inv: null, upg: { can: 99, barn: -1 }, daily: 5, st: { harv: 'lots' } }];
  junk.forEach(function (o) {
    var s = E.normSave(o, T0);
    E.tick(s, T0 + 2 * E.DAY);
    E.harvestAll(s, s.t, NOGOLD); E.waterAll(s, s.t); E.plantAll(s, 'cress', s.t); E.collect(s, s.t, NOGOLD); E.claimDaily(s, s.t); E.checkAch(s, s.t);
    assert.ok(!/NaN|Infinity/.test(JSON.stringify(s)), 'no NaN in the save');
    assert.ok(isFinite(s.coins) && isFinite(s.xp) && s.plots.every(function (p) { return isFinite(p.g) && isFinite(p.w); }));
    assert.ok(s.an.cow.n <= E.ANIMAL.cow.max && s.an.cow.stash >= 0);
  });
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
