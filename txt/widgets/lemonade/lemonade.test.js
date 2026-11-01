/* Headless checks for the Lemonade Stand engine (market, weather, taste, the day, saves, records, charts).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/lemonade/lemonade.test.js */
'use strict';
var assert = require('assert');

var E = require('./lemonade.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./lemonade.js')];
require('./lemonade.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function stockUp(g) {
  E.buySupply(g, 'lemons', 1); E.buySupply(g, 'sugar', 1); E.buySupply(g, 'cups', 1); E.buySupply(g, 'ice', 1);
}
// A sensible player: keeps ~a day of stock, a balanced recipe, ice by the forecast, a fair price.
function bot(g) {
  var f = E.forecastFor(g, g.day, 0), est = E.trafficFor(g, f.i, f.temp, g.day);
  E.setRecipe(g, 'L', 5); E.setRecipe(g, 'S', 4); E.setRecipe(g, 'ice', Math.round(E.idealIce(f.temp)));
  E.setRecipe(g, 'price', f.temp > 85 ? 45 : f.i >= 3 ? 25 : 35);
  var want = Math.ceil(est * 0.85), cpp = E.cupsPerPitcher(g), guard = 0;
  while (guard++ < 20 && E.cupsPossible(g) < want) {
    var before = g.cash;
    if (g.inv.cups < want) E.buySupply(g, 'cups', 0);
    else if (E.lemonCount(g) < Math.ceil(want / cpp) * g.rec.L) E.buySupply(g, 'lemons', 0);
    else E.buySupply(g, 'sugar', 0);
    if (g.cash === before) break;
  }
  if (g.inv.ice < want * g.rec.ice) E.buySupply(g, 'ice', g.rec.ice * want > 300 ? 2 : 1);
  ['radio', 'sign', 'cooler', 'awning', 'juicer'].forEach(function (u) { if (g.cash > E.UPG[u].price * 3) E.buyUpgrade(g, u); });
}
function playSeason(seed, diff, player) {
  var g = E.newGame({ seed: seed, diff: diff || 'normal' }), days = 0;
  while (g.phase !== 'over' && days < 200) {
    if (g.phase === 'plan') { (player || bot)(g); E.simDay(g); days++; }
    else E.nextDay(g);
  }
  return g;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Lemonade Stand' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'lemonade.css');
  assert.strictEqual(widget._engine.SEASON, 30);
});

test('a new game starts by difficulty', function () {
  var g = E.newGame({ seed: 1 });
  assert.strictEqual(g.cash, 2000); assert.strictEqual(g.day, 1); assert.strictEqual(g.phase, 'plan'); assert.strictEqual(g.mode, 'season');
  assert.strictEqual(E.newGame({ seed: 1, diff: 'easy' }).cash, 3000);
  assert.strictEqual(E.newGame({ seed: 1, diff: 'hard' }).cash, 1200);
  assert.strictEqual(E.newGame({ seed: 1, diff: 'bogus' }).diff, 'normal');
  assert.strictEqual(E.newGame({ seed: 1, mode: 'endless' }).mode, 'endless');
  assert.strictEqual(E.cupsPossible(g), 0);
});

test('buying supplies costs cash, packs get cheaper per unit', function () {
  var g = E.newGame({ seed: 2 });
  var c0 = E.packCost(g, 'lemons', 0), c2 = E.packCost(g, 'lemons', 2);
  assert.ok(c2 / 48 < c0 / 12, 'bulk discount');
  var cost = E.buySupply(g, 'lemons', 0);
  assert.strictEqual(cost, c0); assert.strictEqual(g.cash, 2000 - c0); assert.strictEqual(E.lemonCount(g), 12); assert.strictEqual(g.spent, c0);
  E.buySupply(g, 'lemons', 0);
  assert.strictEqual(g.inv.lemons.length, 1, 'same-day lots merge');
  assert.strictEqual(E.buySupply(g, 'nope', 0), 0);
  assert.strictEqual(E.buySupply(g, 'cups', 7), 0);
  g.cash = 5;
  assert.strictEqual(E.buySupply(g, 'cups', 2), 0, 'cannot overspend');
  assert.strictEqual(g.cash, 5);
});

test('recipe is clamped and the price steps by 5', function () {
  var g = E.newGame({ seed: 3 });
  assert.strictEqual(E.setRecipe(g, 'L', 99), 12); assert.strictEqual(E.setRecipe(g, 'L', -3), 1);
  assert.strictEqual(E.setRecipe(g, 'S', -1), 0); assert.strictEqual(E.setRecipe(g, 'ice', 11), 10);
  assert.strictEqual(E.setRecipe(g, 'price', 33), 35); assert.strictEqual(E.setRecipe(g, 'price', 0), 5);
  assert.strictEqual(E.setRecipe(g, 'price', 'abc'), 5);
});

test('upgrades: bought once, cash permitting; juicer makes more cups', function () {
  var g = E.newGame({ seed: 4, diff: 'easy' });
  assert.ok(!E.buyUpgrade(g, 'juicer'), 'too expensive');
  g.cash = 10000;
  assert.strictEqual(E.cupsPerPitcher(g), 10);
  assert.ok(E.buyUpgrade(g, 'juicer')); assert.ok(!E.buyUpgrade(g, 'juicer'), 'only once');
  assert.strictEqual(E.cupsPerPitcher(g), 14); assert.strictEqual(g.cash, 6000); assert.strictEqual(g.upSpent, 4000);
  assert.strictEqual(E.lemonLife(g), 4); E.buyUpgrade(g, 'cooler'); assert.strictEqual(E.lemonLife(g), 7);
  assert.ok(E.meltRate(g, 90) < E.meltRate(E.newGame({ seed: 4 }), 90));
});

test('taste: a balanced recipe beats extremes; complaints point the right way', function () {
  var good = E.taste({ L: 5, S: 4, ice: 3 }, 75);
  assert.ok(good.score > 0.95, 'balanced ' + good.score);
  assert.strictEqual(E.taste({ L: 1, S: 1, ice: 3 }, 75).issue, 'watery');
  assert.strictEqual(E.taste({ L: 6, S: 0, ice: 3 }, 75).issue, 'sour');
  assert.strictEqual(E.taste({ L: 5, S: 11, ice: 3 }, 75).issue, 'sweet');
  assert.strictEqual(E.taste({ L: 5, S: 4, ice: 0 }, 100).issue, 'warm');
  assert.strictEqual(E.taste({ L: 5, S: 4, ice: 10 }, 55).issue, 'icy');
  assert.ok(E.taste({ L: 12, S: 0, ice: 10 }, 50).score < 0.4);
  assert.ok(E.idealIce(95) > E.idealIce(65));
});

test('weather and forecasts are deterministic; confidence matters', function () {
  var g = E.newGame({ seed: 77 }), h = E.newGame({ seed: 77 });
  for (var d = 1; d <= 30; d++) {
    assert.deepStrictEqual(E.weatherFor(g, d), E.weatherFor(h, d));
    assert.deepStrictEqual(E.forecastFor(g, d, 0), E.forecastFor(h, d, 0));
    var w = E.weatherFor(g, d);
    assert.ok(w.temp >= 45 && w.temp <= 108 && w.i >= 0 && w.i < E.WX.length);
  }
  // across many seeds, same-day forecasts beat 2-day outlooks, and the radio helps
  var hit0 = 0, hit2 = 0, hitR = 0, N = 0;
  for (var s = 1; s <= 120; s++) {
    var a = E.newGame({ seed: s * 31 }), b = E.newGame({ seed: s * 31 });
    b.up.radio = true;
    for (var dd = 1; dd <= 30; dd++) {
      var wi = E.weatherFor(a, dd).i;
      if (E.forecastFor(a, dd, 0).i === wi) hit0++;
      if (E.forecastFor(a, dd, 2).i === wi) hit2++;
      if (E.forecastFor(b, dd, 0).i === wi) hitR++;
      N++;
    }
  }
  assert.ok(hit0 / N > 0.65 && hit0 / N < 0.85, 'same day ' + hit0 / N);
  assert.ok(hit2 < hit0 - N * 0.15, 'outlook shakier');
  assert.ok(hitR > hit0 + N * 0.08, 'radio helps');
  var f = E.forecastFor(g, 3, 0);
  assert.ok(f.lo <= f.temp && f.hi >= f.temp && f.acc >= 30 && f.acc <= 98);
});

test('the season warms up in the middle', function () {
  var mid = 0, edge = 0;
  for (var s = 1; s <= 60; s++) {
    var g = E.newGame({ seed: s });
    g.events = [];
    mid += E.weatherFor(g, 15).temp; edge += E.weatherFor(g, 1).temp;
  }
  assert.ok(mid / 60 > edge / 60 + 8);
});

test('a day: deterministic, and stock / money are conserved', function () {
  var g = E.newGame({ seed: 9 });
  stockUp(g);
  var g2 = clone(g);
  var cups0 = g.inv.cups, lem0 = E.lemonCount(g), sug0 = g.inv.sugar, cash0 = g.cash;
  var out = E.simDay(g), out2 = E.simDay(g2), r = out.sum;
  assert.deepStrictEqual(out.sum, out2.sum, 'same state, same day');
  assert.strictEqual(out.cust.length, r.n);
  assert.strictEqual(r.sold, out.cust.filter(function (c) { return c.buy; }).length);
  assert.strictEqual(r.rev, r.sold * r.price);
  assert.strictEqual(g.cash, cash0 + r.rev);
  assert.strictEqual(g.inv.cups, cups0 - r.sold);
  assert.strictEqual(lem0 - E.lemonCount(g) - r.spoiled, r.pitchers * r.rec.L);
  assert.strictEqual(sug0 - g.inv.sugar, r.pitchers * r.rec.S);
  assert.ok(r.sold <= r.pitchers * E.cupsPerPitcher(g) && r.poured === r.pitchers * E.cupsPerPitcher(g) - r.sold);
  assert.strictEqual(g.phase, 'report'); assert.strictEqual(g.hist.length, 1); assert.strictEqual(E.simDay(g), null, 'once a day');
  for (var i = 1; i < out.cust.length; i++) assert.ok(out.cust[i].t >= out.cust[i - 1].t, 'time order');
  assert.ok(out.cust.every(function (c) { return c.t >= 0 && c.t < E.DAY_MIN && (c.dir === 1 || c.dir === -1); }));
});

test('no stock: nobody gets served, they leave unhappy', function () {
  var g = E.newGame({ seed: 10 }), rep = g.rep;
  g.events = [{ id: 'heat', s: 1, n: 2 }];
  var r = E.simDay(g).sum;
  assert.strictEqual(r.sold, 0); assert.strictEqual(r.rev, 0);
  assert.ok(r.out > 0 && r.outAt >= 0);
  assert.ok(g.rep < rep, 'reputation drops');
  assert.ok(E.tipsFor(r, g)[0].indexOf('ran out') >= 0);
});

test('price: higher prices sell fewer cups', function () {
  var tot = { 15: 0, 45: 0, 120: 0 };
  for (var s = 1; s <= 40; s++) {
    [15, 45, 120].forEach(function (p) {
      var g = E.newGame({ seed: s });
      g.cash = 1e6; stockUp(g); stockUp(g); stockUp(g);
      E.setRecipe(g, 'price', p);
      tot[p] += E.simDay(g).sum.sold;
    });
  }
  assert.ok(tot[15] > tot[45] && tot[45] > tot[120] * 1.5, JSON.stringify(tot));
});

test('weather: hot sunny days outsell rainy ones; events move the crowd', function () {
  function day(setup) {
    var n = 0;
    for (var s = 1; s <= 30; s++) {
      var g = E.newGame({ seed: s });
      g.events = []; g.cash = 1e6; stockUp(g); stockUp(g); stockUp(g);
      setup(g);
      n += E.simDay(g).sum.n;
    }
    return n;
  }
  var heat = day(function (g) { g.events.push({ id: 'heat', s: 1, n: 2 }); });
  var rain = day(function (g) { g.events.push({ id: 'rain', s: 1, n: 2 }); });
  var fest = day(function (g) { g.events.push({ id: 'festival', s: 1, n: 1 }); });
  var road = day(function (g) { g.events.push({ id: 'construction', s: 1, n: 2 }); });
  var plain = day(function () {});
  assert.ok(heat > rain * 2.5, 'heat ' + heat + ' rain ' + rain);
  assert.ok(fest > plain * 1.6 && road < plain * 0.8, 'fest ' + fest + ' road ' + road + ' plain ' + plain);
  var g = E.newGame({ seed: 5 });
  g.events = [{ id: 'shortage', s: 1, n: 2 }, { id: 'sale', s: 1, n: 2 }];
  assert.ok(E.priceOf(g, 'lemons') > g.px.lemons * 1.5 && E.priceOf(g, 'sugar') < g.px.sugar * 0.7);
});

test('ice melts away overnight unless there is a cooler', function () {
  var g = E.newGame({ seed: 12 }), h = E.newGame({ seed: 12 });
  g.cash = h.cash = 1e5;
  h.up.cooler = true;
  [g, h].forEach(function (x) { E.buySupply(x, 'ice', 2); E.setRecipe(x, 'ice', 0); });
  var rg = E.simDay(g).sum, rh = E.simDay(h).sum;
  assert.strictEqual(g.inv.ice, 0); assert.strictEqual(rg.melted, 500);
  assert.ok(h.inv.ice > 100 && rh.iceKept === h.inv.ice, 'cooler keeps ' + h.inv.ice);
});

test('lemons spoil after 4 days (7 with a cooler)', function () {
  var g = E.newGame({ seed: 13 });
  g.cash = 1e5;
  E.buySupply(g, 'lemons', 0);
  E.setRecipe(g, 'price', 500);   // nobody buys: lemons stay put
  var spoiled = [];
  for (var d = 0; d < 5; d++) { spoiled.push(E.simDay(g).sum.spoiled); E.nextDay(g); if (d === 2) assert.strictEqual(E.spoilingTonight(g), 12); }
  assert.deepStrictEqual(spoiled, [0, 0, 0, 12, 0]);
  var h = E.newGame({ seed: 13 });
  h.cash = 1e5; h.up.cooler = true;
  E.buySupply(h, 'lemons', 0); E.setRecipe(h, 'price', 500);
  for (var k = 0; k < 6; k++) { assert.strictEqual(E.simDay(h).sum.spoiled, 0); E.nextDay(h); }
  assert.strictEqual(E.simDay(h).sum.spoiled, 12);
});

test('prices drift but stay in range; events are announced ahead', function () {
  var g = E.newGame({ seed: 14, mode: 'endless' }), seen = 0;
  g.cash = 1e7;
  for (var d = 0; d < 120; d++) {
    var known = g.events.map(function (e) { return e.id + e.s; });
    E.simDay(g); E.nextDay(g);
    E.SUPPLIES.forEach(function (s) { assert.ok(g.px[s.id] >= s.lo && g.px[s.id] <= s.hi); });
    g.events.forEach(function (e) {
      assert.ok(E.EVT[e.id]);
      if (known.indexOf(e.id + e.s) < 0) { seen++; assert.ok(e.s >= g.day + 2, 'new events start 2+ days out'); }
    });
    var active = 0;
    for (var i = 0; i < g.events.length; i++) if (g.day >= g.events[i].s && g.day < g.events[i].s + g.events[i].n) active++;
    assert.ok(active <= 1, 'one event at a time');
  }
  assert.ok(seen >= 8, 'events happen: ' + seen);
  assert.strictEqual(g.phase, 'plan', 'endless keeps going');
  assert.ok(E.news(g).every(function (n) { return n.when === 'now' || n.when === 'tomorrow' || n.when === 'in 2 days'; }));
});

test('a sensible player profits over a season; it ends after day 30', function () {
  var gains = 0;
  for (var s = 1; s <= 8; s++) {
    var g = playSeason(s * 101);
    assert.strictEqual(g.phase, 'over'); assert.strictEqual(g.endReason, 'season'); assert.strictEqual(g.day, 30);
    assert.strictEqual(g.hist.length, 30);
    assert.ok(g.cash > g.start, 'seed ' + s + ' cash ' + g.cash);
    gains += g.cash - g.start;
  }
  assert.ok(gains / 8 > 15000, 'average gain ' + gains / 8);
  assert.ok(gains / 8 < 400000, 'not absurd ' + gains / 8);
});

test('a careless player can go broke', function () {
  var g = playSeason(55, 'hard', function (x) {
    E.setRecipe(x, 'L', 12); E.setRecipe(x, 'S', 12); E.setRecipe(x, 'price', 5);
    while (E.buySupply(x, 'lemons', 2)) {}
    while (E.buySupply(x, 'lemons', 0)) {}
    while (E.buySupply(x, 'ice', 0)) {}
  });
  assert.strictEqual(g.phase, 'over'); assert.strictEqual(g.endReason, 'broke');
  assert.ok(g.day < 30);
});

test('saves round-trip and garbage is normalised', function () {
  var g = E.newGame({ seed: 15 });
  stockUp(g); E.simDay(g); E.nextDay(g); E.buyUpgrade(g, 'radio');
  var back = E.normGame(JSON.parse(JSON.stringify(g)));
  assert.deepStrictEqual(clone(back), clone(g));
  assert.strictEqual(E.normGame(null), null); assert.strictEqual(E.normGame('x'), null); assert.strictEqual(E.normGame({ v: 2 }), null);
  var bad = E.normGame({ v: 1, day: 'x', cash: 'lots', rep: 900, px: { lemons: -5 }, inv: { lemons: [{ n: -2 }, { n: 5, d: 1 }, null], sugar: -4, ice: 'cold', cups: 1e99 },
    rec: { L: 50, price: 3 }, up: { juicer: 'yes', radio: true, laser: true }, events: [{ id: 'aliens', s: 1, n: 1 }, { id: 'heat', s: 2, n: 99 }],
    hist: [null, 5, { d: 1, profit: 'x', w: 9 }], phase: 'nope', last: { day: 1, wx: { i: 99 }, said: { good: 3, hack: 4 } }, tot: { sold: -5 } });
  assert.strictEqual(bad.day, 1); assert.strictEqual(bad.cash, 2000); assert.strictEqual(bad.rep, 100); assert.strictEqual(bad.px.lemons, 4);
  assert.strictEqual(E.lemonCount(bad), 5); assert.strictEqual(bad.inv.sugar, 0); assert.strictEqual(bad.inv.ice, 0); assert.ok(bad.inv.cups <= 1e6);
  assert.strictEqual(bad.rec.L, 12); assert.strictEqual(bad.rec.price, 5);
  assert.deepStrictEqual(bad.up, { radio: true });
  assert.deepStrictEqual(bad.events, [{ id: 'heat', s: 2, n: 10 }]);
  assert.strictEqual(bad.hist.length, 1); assert.strictEqual(bad.hist[0].w, 4); assert.strictEqual(bad.hist[0].profit, 0);
  assert.strictEqual(bad.phase, 'plan'); assert.strictEqual(bad.last.wx.i, 4); assert.deepStrictEqual(bad.last.said, { good: 3 });
  assert.strictEqual(bad.tot.sold, 0);
  // a normalised save still plays
  stockUp(bad); assert.ok(E.simDay(bad)); assert.ok(E.nextDay(bad));
});

test('records keep the top five per mode', function () {
  var R = E.normRecs({ season: [{ s: 100 }, { s: 'x' }, null], bestDay: -4, games: 'many' });
  assert.strictEqual(R.season.length, 1); assert.strictEqual(R.bestDay, 0); assert.strictEqual(R.games, 0);
  R = E.newRecs();
  var ranks = [];
  [500, 900, 100, 700, 300, 800, 50].forEach(function (c) { var g = E.newGame({ seed: 1 }); g.cash = c; g.phase = 'over'; g.endReason = 'season'; ranks.push(E.addRecord(R, g, 1)); });
  assert.deepStrictEqual(R.season.map(function (e) { return e.s; }), [900, 800, 700, 500, 300]);
  assert.deepStrictEqual(ranks, [1, 1, 3, 2, 4, 2, 0]);
  assert.strictEqual(R.games, 7);
  var ge = E.newGame({ seed: 1, mode: 'endless' }); ge.cash = 1; E.retire(ge);
  assert.strictEqual(E.addRecord(R, ge, 1), 1); assert.strictEqual(R.endless.length, 1); assert.strictEqual(ge.endReason, 'retired');
  assert.ok(E.noteDay(R, { profit: 5000, sold: 10 })); assert.ok(!E.noteDay(R, { profit: 10, sold: 3 }));
  assert.deepStrictEqual(E.normRecs(JSON.parse(JSON.stringify(R))), R);
});

test('ascii charts', function () {
  var sp = E.spark([0, 5, 10]);
  assert.strictEqual(sp.length, 3); assert.strictEqual(sp.charAt(0), '▁'); assert.strictEqual(sp.charAt(2), '█');
  assert.strictEqual(E.spark([]), '');
  var b = E.bars([10, -5, 0, 20, 7], 6);
  assert.ok(b.lines.every(function (l) { return l.length === 5; }));
  assert.strictEqual(b.lines.length, b.posRows + 1 + b.negRows);
  assert.ok(b.negRows >= 1 && b.posRows >= 1);
  assert.notStrictEqual(b.lines[0].charAt(3), ' ', 'the tallest bar reaches the top');
  assert.strictEqual(b.lines[0].charAt(0), ' ');
  assert.strictEqual(b.lines[b.posRows], '─────');
  assert.notStrictEqual(b.lines[b.posRows + 1].charAt(1), ' ', 'the loss hangs below');
  var only = E.bars([3, 4], 4);
  assert.strictEqual(only.negRows, 0);
  assert.strictEqual(E.wxStrip([{ w: 0 }, { w: 3 }, { w: 4 }]), '*/!');
  var g = playSeason(3);
  var sm = E.summary(g);
  assert.strictEqual(sm.days, 30); assert.ok(sm.best.profit >= sm.worst.profit); assert.ok(sm.conv >= 0 && sm.conv <= 100);
});

test('records store days actually played (retire / broke happen the morning after)', function () {
  var R = E.newRecs();
  var g = E.newGame({ seed: 11, mode: 'endless' });
  stockUp(g); E.simDay(g); E.nextDay(g); stockUp(g); E.simDay(g); E.nextDay(g);
  assert.strictEqual(g.day, 3); E.retire(g);
  E.addRecord(R, g, 1);
  assert.strictEqual(R.endless[0].d, 2, 'two days were played');
  var z = E.newGame({ seed: 1, mode: 'endless' }); E.retire(z); E.addRecord(R, z, 1);
  assert.ok(R.endless.some(function (e) { return e.d === 0; }), 'retiring before day 1 opens records 0 days');
  assert.deepStrictEqual(E.normRecs(clone(R)), R);
  var s = playSeason(4);
  var R2 = E.newRecs(); E.addRecord(R2, s, 1);
  assert.strictEqual(R2.season[0].d, 30);
});

test('going broke: no stock and no cash for the smallest packs ends the game', function () {
  var g = E.newGame({ seed: 12, diff: 'hard' });
  E.buySupply(g, 'cups', 0); E.buySupply(g, 'lemons', 0);
  E.setRecipe(g, 'price', 500);
  E.simDay(g);
  g.inv.lemons = []; g.inv.cups = 0; g.cash = 10;
  assert.ok(!E.canOperate(g));
  E.nextDay(g);
  assert.strictEqual(g.phase, 'over'); assert.strictEqual(g.endReason, 'broke');
  // with stock left but no cash, the stand can still trade
  var h = E.newGame({ seed: 12 }); stockUp(h); h.cash = 0;
  assert.ok(E.canOperate(h));
  // sugar-free lemonade is allowed, so no sugar is not bankruptcy
  h.inv.sugar = 0; assert.ok(E.canOperate(h));
});

test('a recipe bigger than the lemon stock serves nobody; short ice is shared out', function () {
  var g = E.newGame({ seed: 13 });
  E.buySupply(g, 'lemons', 0); E.buySupply(g, 'sugar', 0); E.buySupply(g, 'cups', 0);
  E.setRecipe(g, 'L', 12); g.inv.lemons[0].n = 11;
  E.setRecipe(g, 'price', 5);
  assert.strictEqual(E.cupsPossible(g), 0);
  var out = E.simDay(g);
  assert.strictEqual(out.sum.sold, 0); assert.strictEqual(E.lemonCount(g), 11, 'no partial pitcher is made');
  var h = E.newGame({ seed: 14 }); stockUp(h); h.inv.ice = 5; E.setRecipe(h, 'ice', 4); E.setRecipe(h, 'price', 10);
  var o2 = E.simDay(h);
  assert.ok(o2.sum.sold > 2, 'warm lemonade still sells');
  assert.ok(h.inv.ice >= 0 && isFinite(h.inv.ice));
  o2.cust.forEach(function (c) { if (c.buy) assert.ok(c.snap.ice >= 0); });
});

test('a long endless run: one event at a time, history capped, state stays sane', function () {
  var g = E.newGame({ seed: 15, mode: 'endless', diff: 'easy' }), days = 0;
  while (g.phase !== 'over' && days < 450) {
    if (g.phase === 'plan') {
      var on = E.eventsOn(g, g.day);
      assert.ok(on.length <= 1, 'day ' + g.day + ' has ' + on.join(','));
      bot(g); E.simDay(g); days++;
    } else E.nextDay(g);
  }
  assert.ok(days >= 420, 'a sensible endless player survives (' + days + ' days)');
  assert.ok(g.hist.length <= 400);
  assert.ok(isFinite(g.cash) && g.rep >= 0 && g.rep <= 100);
  var back = E.normGame(clone(g));
  assert.strictEqual(back.hist.length, g.hist.length); assert.strictEqual(back.day, g.day);
});

test('a save taken between the day and the report resumes at the report', function () {
  var g = E.newGame({ seed: 16 }); stockUp(g); E.simDay(g);
  var back = E.normGame(clone(g));
  assert.strictEqual(back.phase, 'report'); assert.strictEqual(back.last.sold, g.last.sold);
  assert.ok(E.nextDay(back)); assert.strictEqual(back.day, 2); assert.strictEqual(back.phase, 'plan');
  assert.strictEqual(E.simDay(E.normGame(clone(g))), null, 'a day cannot be replayed from the report');
});

console.log(passed + ' passed');
if (process.exitCode) console.log('FAILURES above');
