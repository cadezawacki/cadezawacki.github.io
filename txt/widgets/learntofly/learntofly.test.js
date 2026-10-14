/* Headless checks for the Learn to Fly engine (physics, economy, goals).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/learntofly/learntofly.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');

// The module exports its pure engine for node (no DOM, no Cade needed)…
var E = require('./learntofly.js');
// …and registers the same engine on the widget when a Cade core is present.
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./learntofly.js')];
require('./learntofly.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var NONE = { up: false, down: false, boost: false };
function up(r, s, g, k, f, c) { return { ramp: r | 0, sled: s | 0, glider: g | 0, rocket: k | 0, fuel: f | 0, scarf: c | 0 }; }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
// A steady pilot: burn the rocket in a 30° climb, then hold the nose a little
// above the flight path, and flare just before touchdown.
function pilot(f) {
  var inp = { up: false, down: false, boost: false };
  if (f.phase !== 'air') return inp;
  var gam = Math.atan2(f.vy, f.vx), want = gam + 0.12;
  if (f.fuel > 0 && f.g.thrust > 0) { inp.boost = true; want = 0.5; }
  if (E.altOf(f) < 4 && f.vy < -2) want = Math.max(want, gam + 0.22);
  var err = E.wrapA(want - f.th);
  if (err > 0.02) inp.up = true; else if (err < -0.02) inp.down = true;
  return inp;
}
function cheapestFirst(save) {
  var bought = [];
  for (;;) {
    var ids = E.UPGRADES.map(function (u) { return u.id; }).filter(function (id) { return !E.canBuy(save, id); });
    if (!ids.length) return bought;
    ids.sort(function (a, b) { return E.priceOf(save, a) - E.priceOf(save, b); });
    E.buy(save, ids[0]); bought.push(ids[0]);
  }
}
function campaign(pil, maxDays) {
  var s = E.newSave(), firstBuyDay = 0;
  while (!s.won && s.day <= maxDays) {
    var day = s.day, res = E.simulate(s.up, E.flightSeed(s), pil);
    E.settle(s, res);
    if (cheapestFirst(s).length && !firstBuyDay) firstBuyDay = day;
  }
  return { save: s, firstBuyDay: firstBuyDay };
}

test('registration matches the manifest entry', function () {
  assert.ok(widget, 'widget registered');
  assert.strictEqual(widget.name, 'Learn to Fly');
  assert.strictEqual(typeof widget.open, 'function');
  assert.strictEqual(widget._engine.simulate, widget._engine.simulate);
  assert.deepStrictEqual(Object.keys(widget._engine).sort(), Object.keys(E).sort(), 'widget._engine is the node export');
  assert.deepStrictEqual(css, ['learntofly.css'], 'CSS loaded once at module-load time');
  var entry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === 'learntofly'; })[0];
  assert.strictEqual(entry.id, 'learntofly');
  assert.strictEqual(entry.type, 'widget');
  assert.strictEqual(entry.name, widget.name);
  assert.strictEqual(entry.description, widget.description);
  assert.strictEqual(entry.icon, widget.icon);
  assert.strictEqual(entry.tags, widget.tags);
  assert.strictEqual(entry.entry, 'widgets/learntofly/learntofly.js');
  assert.strictEqual(entry.css, 'widgets/learntofly/learntofly.css');
  var m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  var listed = m.modules.filter(function (x) { return x.id === 'learntofly'; })[0];
  if (listed) assert.deepStrictEqual(listed, entry, 'manifest.json entry = MANIFEST_ENTRY.json');
});

test('the ramp is continuous and launches from the lip', function () {
  [8, 20, 58].forEach(function (drop) {
    var rp = E.makeRamp(drop), p = {}, q = {};
    E.rampAt(rp, 0, p);
    assert.ok(Math.abs(p.y - rp.yl - drop) < 1e-6, 'the top is `drop` above the lip');
    for (var s = 0.05; s <= rp.len; s += 0.05) {
      E.rampAt(rp, s - 0.05, q); E.rampAt(rp, s, p);
      assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 0.06, 'no jumps along the ramp');
    }
    E.rampAt(rp, rp.len, p);
    assert.ok(Math.abs(p.x) < 1e-6 && Math.abs(p.y - (E.CLIFF + E.LIP)) < 1e-6, 'ends at the lip');
    assert.ok(Math.abs(E.rampYAt(rp, -0.001) - rp.yl) < 0.01, 'rampYAt agrees at the lip');
  });
});

test('a hands-off flight is deterministic, sane and lands', function () {
  var a = E.simulate(up(), 12345, null), b = E.simulate(up(), 12345, null);
  assert.ok(same(a, b), 'same seed, same flight');
  assert.ok(a.dist > 30 && a.dist < 150, 'day-1 plop distance ' + a.dist);
  assert.ok(a.time > 2 && a.time < 15, 'day-1 flight time ' + a.time);
  var f = E.newFlight(up(), 7), n = 0;
  while (f.phase !== 'done' && n++ < 100000) {
    E.stepFlight(f, NONE);
    [f.x, f.y, f.vx, f.vy, f.th, f.zoom].forEach(function (v) { assert.ok(isFinite(v), 'finite state'); });
    if (f.phase === 'air') assert.ok(f.y >= E.groundY(f.x) - 1e-9, 'never under the snow');
  }
  assert.strictEqual(f.phase, 'done', 'the flight ends');
  assert.ok(f.events.indexOf('launch') !== -1 && f.events.indexOf('done') !== -1);
});

test('same flight at 60, 90, 120 and 144 Hz', function () {
  function run(hz) {
    var f = E.newFlight(up(2, 2, 2, 1, 1), 99), n = 0;
    // input is read on every physics step (as from held keys), whatever the frame rate
    var inp = {
      get boost() { return f.ft > 0.5 && f.ft < 3; },
      get up() { return f.ft > 1 && f.ft < 1.4; },
      get down() { return f.ft > 6 && f.ft < 6.2; }
    };
    while (f.phase !== 'done' && n++ < 200000) E.advance(f, 1 / hz, inp);
    return E.summary(f);
  }
  var a = run(60);
  [90, 120, 144].forEach(function (hz) { var b = run(hz); assert.ok(same(a, b), hz + ' Hz: ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b)); });
  assert.ok(a.dist > 100, 'a real flight: ' + a.dist);
});

test('progression without any input: each cheapest upgrade helps, every tier helps', function () {
  var base = E.simulate(up(), 4242, null).dist;
  ['ramp', 'sled', 'glider'].forEach(function (id) {
    var u = up(); u[id] = 1;
    var d = E.simulate(u, 4242, null).dist;
    assert.ok(d > base, id + ' tier 1: ' + d + ' > ' + base);
  });
  var prev = base;
  for (var t = 1; t <= 5; t++) {
    var d = E.simulate(up(t, t, t), 4242, null).dist;
    assert.ok(d > prev * 1.1, 'all tier ' + t + ': ' + d + ' > ' + prev);
    prev = d;
  }
  // the very first flight pays for an upgrade
  var s = E.newSave();
  E.settle(s, E.simulate(s.up, E.flightSeed(s), null));
  var cheapest = Math.min.apply(null, E.UPGRADES.map(function (u) { return u.tiers[1].price; }));
  assert.ok(s.cash >= cheapest, 'cash after day 1: ' + s.cash + ' ≥ ' + cheapest);
});

test('flying matters: diving gains speed, over-pulling stalls, a rocket climbs', function () {
  function after(inpFn, gearUp, secs) {
    var f = E.newFlight(gearUp || up(2, 2, 2), 5);
    while (f.phase === 'ramp') E.stepFlight(f, NONE);
    var t0 = f.ft, stalled = false;
    while (f.phase === 'air' && f.ft - t0 < secs) { E.stepFlight(f, inpFn(f)); if (f.events.indexOf('stall') !== -1) stalled = true; f.events.length = 0; }
    return { V: E.speedOf(f), y: f.y, stalled: stalled };
  }
  var hands = after(function () { return NONE; }, null, 1.2);
  var dive = after(function (f) { return { up: false, down: f.th > -0.6, boost: false }; }, null, 1.2);
  assert.ok(dive.V > hands.V + 2, 'dive ' + dive.V.toFixed(1) + ' vs hands-off ' + hands.V.toFixed(1));
  var pull = after(function () { return { up: true, down: false, boost: false }; }, null, 1.2);
  assert.ok(pull.stalled, 'holding nose-up stalls');
  var rocket = after(function (f) { return { up: f.th < 0.5, down: f.th > 0.6, boost: true }; }, up(2, 2, 2, 2, 2), 3);
  var glide = after(function (f) { return { up: f.th < 0.5, down: f.th > 0.6, boost: false }; }, up(2, 2, 2, 2, 2), 3);
  assert.ok(rocket.y > glide.y + 10, 'rocket climb ' + rocket.y.toFixed(0) + ' vs ' + glide.y.toFixed(0));
  var p = E.simulate(up(3, 3, 3), 77, pilot), h = E.simulate(up(3, 3, 3), 77, null);
  assert.ok(p.dist > h.dist, 'a pilot beats hands-off: ' + p.dist + ' vs ' + h.dist);
});

test('lift collapses past the stall angle', function () {
  var a = E.ALPHA_S;
  assert.strictEqual(E.liftCoef(0), 0);
  assert.ok(Math.abs(E.liftCoef(a) - 1) < 1e-9);
  assert.ok(E.liftCoef(a + 1e-6) < 0.6, 'the stall drop');
  assert.ok(Math.abs(E.liftCoef(-0.1) + E.liftCoef(0.1)) < 1e-12, 'symmetric');
  E.UPG.glider.tiers.forEach(function (t, i, all) { if (i) assert.ok(E.glideRatio(t) > E.glideRatio(all[i - 1]), 'glide ratio grows'); });
});

test('sky items: deterministic per seed, collected once, pay out', function () {
  var a = [], b = [], c = [];
  E.chunkItems(9, 12, a); E.chunkItems(9, 12, b); E.chunkItems(10, 12, c);
  assert.ok(same(a, b) && a.length > 0, 'same seed, same chunk');
  assert.ok(!same(a, c), 'another seed, another sky');
  for (var i = 0; i < a.length; i++) assert.ok(a[i].y > E.groundY(a[i].x), 'items float above the snow');
  var none = []; E.chunkItems(9, 0, none); E.chunkItems(9, E.WALL_X / E.CHUNK, none); E.chunkItems(9, E.WALL_X / E.CHUNK - 1, none);
  assert.strictEqual(none.length, 0, 'nothing over the ramp or right at the wall');
  // a geared flight picks some up, and each coin is counted once
  var f = E.newFlight(up(4, 4, 4, 4, 4), 31), coins = 0, n = 0;
  while (f.phase !== 'done' && n++ < 100000) {
    E.stepFlight(f, pilot(f));
    coins += f.hitQ.filter(function (it) { return it.kind === 'coin'; }).length;
    f.hitQ.length = 0; f.events.length = 0;
  }
  assert.ok(f.coins > 0, 'collected some coins');
  assert.strictEqual(coins, f.coins);
  assert.ok(f.items.length < 400, 'items far behind are dropped (' + f.items.length + ')');
});

test('shop: prices escalate, fuel needs a rocket, buying spends cash', function () {
  E.UPGRADES.forEach(function (u) {
    for (var i = 2; i < u.tiers.length; i++) assert.ok(u.tiers[i].price > u.tiers[i - 1].price * 1.5, u.id + ' tier ' + i);
  });
  var s = E.newSave();
  assert.strictEqual(E.canBuy(s, 'ramp'), 'cash');
  s.cash = 100000;
  assert.strictEqual(E.canBuy(s, 'fuel'), 'locked');
  assert.ok(E.buy(s, 'rocket'));
  assert.strictEqual(E.canBuy(s, 'fuel'), '');
  var before = s.cash, price = E.priceOf(s, 'fuel');
  assert.ok(E.buy(s, 'fuel'));
  assert.strictEqual(s.cash, before - price);
  while (E.buy(s, 'scarf')) {}
  assert.strictEqual(E.canBuy(s, 'scarf'), 'max');
  assert.strictEqual(E.priceOf(s, 'scarf'), 0);
  assert.strictEqual(E.buy(s, 'scarf'), false);
});

test('settle: itemised pay, scarf bonus, goals pay once, records, day count', function () {
  var s = E.newSave();
  var res = { dist: 120, maxAlt: 60, maxSpeed: 30, time: 9, coins: 2, coinCash: 10, landing: 'smooth', wall: false };
  var card = E.settle(s, res);
  var base = Math.round(120 * 0.5) + Math.round(60 * 0.8) + Math.round(30 * 0.8) + 9 + 10;
  assert.strictEqual(card.base, base);
  var gids = card.goals.map(function (g) { return g.id; }).sort();
  assert.deepStrictEqual(gids, ['a50', 'd100', 's25']);
  assert.strictEqual(card.total, base + 50 + 60 + 50);
  assert.strictEqual(s.cash, card.total);
  assert.strictEqual(s.day, 2);
  assert.ok(card.records.dist && s.best.dist === 120);
  var again = E.settle(s, res);
  assert.strictEqual(again.goals.length, 0, 'no double bonus');
  assert.ok(!again.records.dist, 'not a new record');
  s.up.scarf = 2;
  var c3 = E.settle(s, res);
  assert.strictEqual(c3.bonus, Math.round(base * 0.4));
});

test('saves: garbage in, sane save out', function () {
  [null, 42, 'x', {}, { cash: -5, day: 0, up: { ramp: 99, sled: -3, glider: 'x' }, goals: { d100: 1, bogus: 1 }, best: { dist: 'NaN' } }].forEach(function (o) {
    var s = E.normSave(o);
    assert.ok(s.cash >= 0 && s.day >= 1);
    E.UPGRADES.forEach(function (u) { assert.ok(s.up[u.id] >= 0 && s.up[u.id] < u.tiers.length); });
    assert.ok(!s.goals.bogus);
    assert.ok(isFinite(s.best.dist));
  });
  var s = E.normSave({ cash: 500, day: 7, up: { ramp: 99 }, goals: { d100: 1 } });
  assert.strictEqual(s.up.ramp, E.UPG.ramp.tiers.length - 1);
  assert.strictEqual(s.goals.d100, 1);
  assert.ok(same(E.normSave(JSON.parse(JSON.stringify(s))), s), 'round-trips through JSON');
});

test('a full campaign: a pilot smashes the wall; hands-off still progresses', function () {
  var c = campaign(pilot, 60);
  assert.ok(c.save.won, 'won (day ' + c.save.day + ')');
  assert.ok(c.save.wonDay >= 15 && c.save.wonDay <= 50, 'won on day ' + c.save.wonDay);
  assert.strictEqual(c.firstBuyDay, 1, 'first upgrade after the first flight');
  assert.ok(c.save.goals.wall && c.save.best.dist >= E.WALL_X);
  // never touching the controls still progresses (slowly) as the gear improves…
  var lazy = campaign(null, 10), d10 = lazy.save.best.dist;
  lazy = campaign(null, 30);
  assert.ok(d10 > 80 && lazy.save.best.dist > d10 * 1.3, 'hands-off best: day 10 ' + d10 + ', day 30 ' + lazy.save.best.dist);
  // …but just holding the rocket button (it tips the nose down) never reaches the wall
  var masher = campaign(function () { return { up: false, down: false, boost: true }; }, 40);
  assert.ok(masher.save.best.dist > 300 && !masher.save.won, 'boost-only best ' + masher.save.best.dist);
  var mx = up(5, 5, 5, 5, 5, 4);
  [1, 2, 3].forEach(function (seed) {
    var m = E.simulate(mx, seed, function () { return { up: false, down: false, boost: true }; }, { noWall: true });
    assert.ok(m.dist < E.WALL_X * 0.7, 'boost-only at max gear: ' + m.dist);
  });
});

test('the ice wall ends a winning flight; once it is down you can fly on', function () {
  var maxed = up(5, 5, 5, 5, 5, 4);
  var f = E.newFlight(maxed, 3), n = 0, wallT = -1;
  while (f.phase !== 'done' && n++ < 200000) {
    E.stepFlight(f, pilot(f));
    if (f.events.indexOf('wall') !== -1) { wallT = f.t; assert.ok(f.x >= E.WALL_X && f.x < E.WALL_X + 50); }
    f.events.length = 0; f.hitQ.length = 0;
  }
  assert.ok(wallT > 0, 'reached the wall');
  assert.ok(f.t - wallT < 2.5, 'the flight ends right after the smash');
  var r = E.summary(f);
  assert.ok(r.wall && r.dist >= E.WALL_X && r.dist < E.WALL_X + 300, 'summary ' + r.dist);
  assert.ok(r.time < 150, 'the winning flight takes ' + r.time + ' s');
  var free = E.simulate(maxed, 3, pilot, { noWall: true });
  assert.ok(!free.wall && free.dist > E.WALL_X + 500, 'with the wall down: ' + free.dist);
  assert.ok(E.groundY(E.WALL_X) === 0 && E.groundY(E.WALL_X + 2000) !== 0, 'flat ice at the wall, hills beyond');
});

test('New Game+: fresh gear, +25% pay, keeps the record', function () {
  var s = E.newSave();
  s.cash = 999; s.up.ramp = 3; s.won = true; s.wonDay = 30; s.bestWinDay = 30; s.day = 31;
  var n = E.newGamePlus(s);
  assert.strictEqual(n.ngp, 1); assert.strictEqual(n.cash, 0); assert.strictEqual(n.up.ramp, 0);
  assert.strictEqual(n.day, 1); assert.strictEqual(n.bestWinDay, 30); assert.ok(!n.won);
  var res = { dist: 100, maxAlt: 0, maxSpeed: 0, time: 0, coins: 0, coinCash: 0, landing: 'smooth', wall: false };
  var card = E.settle(n, res);
  assert.strictEqual(card.bonus, Math.round(card.base * 0.25));
  var w = E.newSave(); w.day = 20;
  E.settle(w, { dist: 10050, maxAlt: 0, maxSpeed: 0, time: 0, coins: 0, coinCash: 0, landing: 'smooth', wall: true });
  assert.ok(w.won && w.wonDay === 20 && w.bestWinDay === 20 && w.goals.wall);
});

console.log(passed + ' passed' + (process.exitCode ? ' (with failures)' : ''));
