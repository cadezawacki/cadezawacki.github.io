/* Headless checks for the Space Trader engine (galaxy, markets, shipyard, combat, missions, rival, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/spacetrader/spacetrader.test.js */
'use strict';
var assert = require('assert');

var E = require('./spacetrader.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./spacetrader.js')];
require('./spacetrader.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function gi(id) { for (var k = 0; k < E.GOODS.length; k++) if (E.GOODS[k].id === id) return k; return -1; }
function sysWhere(G, fn) { for (var k = 0; k < G.sys.length; k++) if (fn(G.sys[k], k)) return k; return -1; }
function govIdx(id) { for (var k = 0; k < E.GOVS.length; k++) if (E.GOVS[k].id === id) return k; return -1; }
// Put the current trip into a chosen encounter.
function forceEnc(G, kind) {
  var p = G.players[0], to = E.neighbours(G.sys, p.loc, E.rangeOf(p.ship))[0];
  p.ship.fuel = E.rangeOf(p.ship);
  assert.strictEqual(E.warp(G, 0, to), '');
  G.trip.q = [kind];
  return E.nextEnc(G);
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Space Trader' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'spacetrader.css');
  assert.strictEqual(widget._engine.VERSION, E.VERSION);
});

test('galaxy: 26 connected systems, unique names and map cells, deterministic', function () {
  for (var seed = 1; seed < 40; seed++) {
    var S = E.genGalaxy(seed * 977);
    assert.strictEqual(S.length, E.NSYS);
    assert.ok(E.connected(S, 13), 'connected ' + seed);
    var names = {}, cells = {};
    S.forEach(function (s) {
      assert.ok(!names[s.name], 'dup name'); names[s.name] = 1;
      var c = E.cellOf(s.x, s.y), key = c.c + ',' + c.r;
      assert.ok(!cells[key], 'dup cell'); cells[key] = 1;
      assert.ok(s.x >= 0 && s.x <= E.MAP_W && s.y >= 0 && s.y <= E.MAP_H);
      assert.ok(s.tl >= 0 && s.tl <= 7 && E.GOVS[s.gov] && E.SPECS[s.spec]);
    });
    assert.ok(S.filter(function (s) { return s.tl >= 6; }).length >= 4, 'moon worlds');
    var G = E.newGame({ seed: seed * 977 });
    assert.ok(E.neighbours(G.sys, G.start, E.SHIPS[0].range).length >= 1, 'start has a neighbour');
  }
  assert.deepStrictEqual(E.genGalaxy(5), E.genGalaxy(5));
  assert.notDeepStrictEqual(E.genGalaxy(5), E.genGalaxy(6));
});

test('prices: tech gradient, contraband markets, specialty and events', function () {
  var G = E.newGame({ seed: 4242 }), r = gi('robots'), ore = gi('ore'), arms = gi('arms');
  // raw goods are dearer on high-tech worlds, manufactured goods cheaper (before noise / mods)
  var a = G.sys[0], b = G.sys[1];
  a.tl = 7; b.tl = 4; a.gov = b.gov = govIdx('democracy'); a.spec = b.spec = 0;
  G.ev[0] = G.ev[1] = null;
  assert.ok(E.fair(G, 0, r) < E.fair(G, 1, r) * 0.97, 'robots cheaper at tech 7');
  assert.ok(E.fair(G, 0, ore) > E.fair(G, 1, ore), 'ore dearer at tech 7');
  b.tl = 1;
  assert.strictEqual(E.fair(G, 1, ore), 0, 'no ore market at tech 1');
  assert.strictEqual(E.fair(G, 0, arms), 0, 'contraband is not traded under a democracy');
  a.gov = govIdx('anarchy');
  assert.ok(E.fair(G, 0, arms) > 0, 'anarchy has a black market');
  a.gov = govIdx('democracy');
  var w = gi('water'), base = E.fair(G, 0, w);
  G.ev[0] = { e: 0, until: 99 };   // drought
  assert.ok(Math.abs(E.fair(G, 0, w) / base - 2.2) < 1e-9);
  G.ev[0] = null; a.spec = 1;       // ice moons: cheap water
  assert.ok(E.fair(G, 0, w) < base * 0.7);
  var q = E.quote(G, 0, w);
  assert.ok(q.buy > q.sell && q.avail > 0);
});

test('supply and demand: buying raises the price, selling lowers it, markets recover', function () {
  var G = E.newGame({ seed: 77 }), p = G.players[0], si = p.loc, g = -1;
  for (var k = 0; k < E.GOODS.length; k++) if (E.produced(G, si, k) && E.quote(G, si, k).buy < 400) { g = k; break; }
  assert.ok(g >= 0);
  p.cr = 1e6;
  var q0 = E.quote(G, si, g), r = E.buy(G, 0, g, 8);
  assert.strictEqual(r.n, 8);
  var q1 = E.quote(G, si, g);
  assert.ok(q1.buy > q0.buy && q1.avail === q0.avail - 8, 'price up, stock down');
  assert.strictEqual(p.cargo[g], 8);
  var cr = p.cr, s = E.sell(G, 0, g, 8);
  assert.strictEqual(s.n, 8);
  assert.ok(p.cr - cr < r.cost, 'a round trip on one market loses the spread');
  assert.ok(s.profit < 0 && p.cargo[g] === 0 && p.paid[g] === 0);
  E.buy(G, 0, g, 8);
  var hi = E.quote(G, si, g).buy;
  for (k = 0; k < 12; k++) E.tickDay(G);
  assert.ok(Math.abs(G.glut[si][g]) < 0.5 && E.quote(G, si, g).buy < hi, 'recovers');
});

test('buying respects cash, hold space and stock; maxBuy agrees', function () {
  var G = E.newGame({ seed: 31 }), p = G.players[0], si = p.loc, g = -1;
  for (var k = 0; k < E.GOODS.length; k++) if (E.produced(G, si, k)) { g = k; break; }
  p.cr = 0;
  assert.strictEqual(E.buy(G, 0, g, 1).why, 'cash');
  p.cr = 1e7;
  var m = E.maxBuy(G, 0, g);
  assert.strictEqual(m, Math.min(E.cargoCap(p.ship), E.quote(G, si, g).avail));
  assert.strictEqual(E.buy(G, 0, g, 999).n, m);
  assert.ok(E.cargoCount(p) <= E.cargoCap(p.ship));
  assert.strictEqual(E.maxBuy(G, 0, g), 0);
  // cash limit
  var G2 = E.newGame({ seed: 31 }), p2 = G2.players[0], q = E.quote(G2, si, g);
  p2.cr = q.buy * 3 + 1;
  var m2 = E.maxBuy(G2, 0, g);
  assert.ok(m2 >= 2 && m2 <= 3);
  E.buy(G2, 0, g, 99);
  assert.ok(p2.cr >= 0 && p2.cargo[g] === m2);
});

test('travel: fuel, range, a day per jump, arrival', function () {
  var G = E.newGame({ seed: 1234 }), p = G.players[0], from = p.loc;
  var nb = E.neighbours(G.sys, from, E.rangeOf(p.ship));
  var far = -1;
  for (var k = 0; k < G.sys.length; k++) if (E.dist(G.sys[from], G.sys[k]) > E.rangeOf(p.ship) + 1) { far = k; break; }
  assert.strictEqual(E.canWarp(G, 0, far), 'out of range');
  assert.strictEqual(E.canWarp(G, 0, from), 'here');
  var to = nb[0], need = E.fuelNeed(G, from, to);
  p.ship.fuel = need - 1;
  assert.strictEqual(E.canWarp(G, 0, to), 'not enough fuel');
  p.ship.fuel = E.rangeOf(p.ship);
  assert.strictEqual(E.warp(G, 0, to), '');
  assert.strictEqual(p.ship.fuel, E.rangeOf(p.ship) - need);
  assert.strictEqual(E.canWarp(G, 0, to), 'busy');
  G.trip.q = [];
  var lines = E.arrive(G);
  assert.ok(Array.isArray(lines) && p.loc === to && !G.trip);
  var day = G.day, r = E.endTurn(G);
  assert.ok(r.day && G.day === day + 1 && G.turn === 0);
});

test('refuel and repair cost credits and stop at full', function () {
  var G = E.newGame({ seed: 9 }), p = G.players[0];
  p.ship.fuel = 2; p.ship.hull = 40; p.cr = 100000;
  var n = E.refuel(G, 0), pr = E.fuelPrice(G, p);
  assert.strictEqual(p.ship.fuel, E.rangeOf(p.ship));
  assert.strictEqual(p.cr, 100000 - n * pr);
  assert.strictEqual(E.refuel(G, 0), 0);
  E.repair(G, 0);
  assert.strictEqual(p.ship.hull, E.hullMax(p.ship));
  p.ship.fuel = 0; p.cr = pr * 3 + 1;
  assert.strictEqual(E.refuel(G, 0), 3);
});

test('shipyard: equipment slots, selling back, engines, pods, hull trade-in', function () {
  var G = E.newGame({ seed: 555 }), p = G.players[0];
  G.sys[p.loc].tl = 7; p.cr = 1e6;
  assert.strictEqual(E.canEquip(G, p, 'w', 'beam'), 'no free slot');        // the Sparrow has one weapon slot
  assert.strictEqual(E.canEquip(G, p, 's', 'deflector'), 'no free slot');   // and no shield slot
  assert.strictEqual(E.buyEquip(G, 0, 'g', 'pods'), '');
  assert.strictEqual(E.cargoCap(p.ship), 16);
  assert.strictEqual(E.buyEquip(G, 0, 'g', 'cells'), 'no free slot');
  var cr = p.cr;
  assert.strictEqual(E.sellEquip(G, 0, 'g', 0), Math.round(3000 * 0.6));
  assert.strictEqual(p.cr, cr + 1800);
  assert.strictEqual(E.upgradeEngine(G, 0), '');
  assert.strictEqual(p.ship.eng, 1);
  assert.strictEqual(E.buyPod(G, 0), '');
  assert.strictEqual(E.buyPod(G, 0), 'already fitted');
  // a bigger hull keeps what fits
  var wd = 4, deal = E.shipDeal(G, p, wd);
  assert.strictEqual(deal.net, E.SHIPS[wd].price - E.tradeIn(p.ship));
  cr = p.cr;
  assert.strictEqual(E.buyShip(G, 0, wd), '');
  assert.strictEqual(p.cr, cr - deal.net);
  assert.ok(p.ship.t === wd && p.ship.w[0] === 'pulse' && p.ship.eng === 1 && p.ship.pod);
  assert.strictEqual(E.buyEquip(G, 0, 's', 'aegis'), '');
  assert.strictEqual(E.shieldMax(p.ship), 140);
  // low tech yards don't sell it
  G.sys[p.loc].tl = 3;
  assert.strictEqual(E.canEquip(G, p, 'w', 'lance'), 'needs tech 7');
  assert.strictEqual(E.shipDeal(G, p, 5).why, 'needs tech 7');
  // cargo must fit the new hull
  G.sys[p.loc].tl = 7;
  p.cargo[0] = 20;
  assert.strictEqual(E.shipDeal(G, p, 0).why, 'cargo would not fit');
});

test('bank: loan limit, daily interest, repayment', function () {
  var G = E.newGame({ seed: 8, diff: 1 }), p = G.players[0];
  var lim = E.maxLoan(G, p);
  assert.ok(lim >= 2000);
  assert.strictEqual(E.borrow(G, 0), lim);
  assert.strictEqual(E.borrow(G, 0), 0);
  var d = p.debt;
  E.tickDay(G);
  assert.strictEqual(p.debt, d + Math.ceil(d * 0.01));
  var cr = p.cr;
  assert.strictEqual(E.repay(G, 0, 500), 500);
  assert.strictEqual(p.cr, cr - 500);
  E.repay(G, 0);
  assert.strictEqual(p.debt, 0);
});

test('missions: a stable board, courier and contract deliveries, deadlines', function () {
  var G = E.newGame({ seed: 2024 }), p = G.players[0];
  var B = E.board(G, p.loc, 0);
  assert.ok(B.length >= 2);
  assert.deepStrictEqual(E.board(G, p.loc, 0), B, 'same window, same board');
  var c = B.filter(function (m) { return m.k === 'courier'; })[0];
  assert.strictEqual(E.accept(G, 0, c.id), '');
  assert.ok(!E.board(G, p.loc, 0).some(function (m) { return m.id === c.id; }), 'taken offers leave the board');
  assert.strictEqual(E.accept(G, 0, c.id), 'no longer offered');
  var cr = p.cr;
  p.loc = c.to;
  var out = E.deliver(G, 0);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(p.cr, cr + c.pay);
  assert.strictEqual(p.missions.length, 0);
  // contract: needs the goods in the hold
  var m = { id: 'x', k: 'contract', to: p.loc, from: 0, g: 0, n: 5, pay: 900, due: G.day + 3 };
  p.missions.push(m);
  p.cargo[0] = 3;
  assert.strictEqual(E.deliver(G, 0).length, 0);
  p.cargo[0] = 7; p.paid[0] = 70;
  assert.strictEqual(E.deliver(G, 0).length, 1);
  assert.ok(p.cargo[0] === 2 && Math.abs(p.paid[0] - 20) < 1e-9 && p.missions.length === 0);
  // a lapsed deadline fails the mission
  p.missions.push({ id: 'y', k: 'courier', to: 1, from: 0, pay: 100, due: G.day });
  E.tickDay(G);
  assert.strictEqual(p.missions.length, 0);
  assert.ok(p.notes.some(function (t) { return /failed/.test(t); }));
});

test('encounters: pirates fight, flee and rob; police inspect; traders trade', function () {
  var wins = 0, kills = 0;
  for (var seed = 1; seed <= 30; seed++) {
    var G = E.newGame({ seed: seed * 31 }), p = G.players[0];
    p.ship.w = ['lance']; p.ship.hull = 80;
    var e = forceEnc(G, 'pirate');
    assert.ok(e && e.kind === 'pirate');
    for (var r = 0; r < 60 && G.trip.enc && G.trip.enc.st !== 'done'; r++) E.encAct(G, 'attack');
    assert.strictEqual(G.trip.enc.st, 'done');
    if (G.trip.enc.res === 'won') kills++;
    if (p.out !== 'dead') wins++;
    assert.ok(p.ship.hull >= 0 && p.ship.hull <= E.hullMax(p.ship));
    E.encAct(G, 'go');
    assert.strictEqual(G.trip.enc, null);
  }
  assert.ok(kills > 0 && wins > 0);
  // surrender to pirates: they strip the hold
  var G2 = E.newGame({ seed: 4 }), p2 = G2.players[0];
  p2.cargo[0] = 5; p2.paid[0] = 100;
  var e2 = forceEnc(G2, 'pirate');
  if (e2.st !== 'done') {
    E.encAct(G2, 'surrender');
    assert.ok(E.cargoCount(p2) === 0 && G2.trip.enc.st === 'done');
  }
  // police find contraband
  var G3 = E.newGame({ seed: 6 }), p3 = G3.players[0], arms = gi('arms');
  p3.cargo[arms] = 3; p3.paid[arms] = 3000; p3.cr = 5000;
  var e3 = forceEnc(G3, 'police');
  assert.strictEqual(e3.st, 'hail');
  E.encAct(G3, 'submit');
  assert.ok(p3.cargo[arms] === 0 && p3.cr < 5000 && p3.rec < 0);
  // incorruptible governments refuse bribes
  var G4 = E.newGame({ seed: 6 }), p4 = G4.players[0];
  var e4 = forceEnc(G4, 'police');
  G4.sys[G4.trip.to].gov = govIdx('military');
  assert.strictEqual(E.bribeCost(G4, p4, e4), 0);
  E.encAct(G4, 'bribe');
  assert.ok(G4.trip.enc.st === 'hail' && p4.rec < 0);
  G4.sys[G4.trip.to].gov = govIdx('feudal');
  var cr = p4.cr = 50000, cost = E.bribeCost(G4, p4, e4);
  E.encAct(G4, 'bribe');
  assert.ok(G4.trip.enc.st === 'done' && p4.cr === cr - cost);
  // traders
  var G5 = E.newGame({ seed: 12 }), p5 = G5.players[0];
  p5.cr = 1e6;
  var e5 = forceEnc(G5, 'trader');
  assert.ok(e5.offer && e5.offer.price > 0);
  var before = E.cargoCount(p5);
  E.encAct(G5, 'trade');
  assert.ok(G5.trip.enc.st === 'done');
  if (!e5.offer.sell) assert.ok(E.cargoCount(p5) > before);
  // actions outside the menu do nothing
  var G6 = E.newGame({ seed: 12 }), e6 = forceEnc(G6, 'derelict'), log = e6.log.length;
  E.encAct(G6, 'bribe');
  assert.ok(G6.trip.enc.st === 'hail' && e6.log.length === log);
});

test('destruction: the escape pod saves you, otherwise the game ends', function () {
  var G = E.newGame({ seed: 99 }), p = G.players[0];
  p.ship.pod = true; p.ship.hull = 1; p.ship.w = []; p.cargo[0] = 4;
  var e = forceEnc(G, 'bounty:none');
  assert.strictEqual(e, null, 'a stale bounty is skipped');
  G.trip.q = ['pirate'];
  e = E.nextEnc(G);
  if (e.st === 'done') { E.encAct(G, 'go'); G.trip.q = ['pirate']; e = E.nextEnc(G); }
  for (var r = 0; r < 200 && G.trip.enc.st !== 'done'; r++) E.encAct(G, 'flee');
  if (G.trip.enc.res === 'pod') {
    E.encAct(G, 'go');
    E.arrive(G);
    assert.ok(p.ship.t === 0 && !p.ship.pod && E.cargoCount(p) === 0 && !p.out);
  }
  var G2 = E.newGame({ seed: 99 }), p2 = G2.players[0];
  p2.ship.hull = 1; p2.ship.w = []; p2.ship.eng = 0;
  forceEnc(G2, 'police');
  p2.rec = -50; G2.trip.enc.st = 'fight';
  var guard = 0;
  while (G2.trip.enc.st !== 'done' && guard++ < 400) E.encAct(G2, 'flee');
  if (G2.trip.enc.res === 'dead') {
    assert.strictEqual(p2.out, 'dead');
    E.checkOver(G2);
    assert.ok(G2.over && G2.over.winner === -1);
  }
});

test('the goal: buying a moon wins, and scores more than retiring', function () {
  var G = E.newGame({ seed: 3, diff: 1 }), p = G.players[0];
  G.sys[p.loc].tl = 5;
  p.cr = E.moonPrice(G) + 10;
  assert.strictEqual(E.canMoon(G, p), 'only sold at tech 6+ worlds');
  G.sys[p.loc].tl = 6;
  p.debt = 10;
  assert.strictEqual(E.canMoon(G, p), 'pay off your loan first');
  p.debt = 0;
  assert.strictEqual(E.buyMoon(G, 0), '');
  assert.ok(G.over && G.over.winner === 0 && G.over.why === 'moon' && p.moon);
  var won = E.score(G, p);
  var G2 = E.newGame({ seed: 3, diff: 1 }), p2 = G2.players[0];
  p2.cr = E.moonPrice(G2);
  E.retire(G2, 0);
  assert.ok(G2.over && G2.over.why === 'retired');
  assert.ok(won > E.score(G2, p2));
  var R = E.newRecords(), res = E.record(R, G);
  assert.ok(res.rank === 0 && R.wins === 1 && R.games === 1 && R.best[0].how === 'moon');
});

test('the CPU rival trades legally and wins the race on its own', function () {
  var G = E.newGame({ seed: 4711, diff: 0, mode: 'cpu' }), cpu = G.players[1];
  assert.ok(cpu.cpu && !G.players[0].cpu);
  // the human never moves: each endTurn is one round of the rival's
  for (var d = 0; d < 400 && !G.over; d++) {
    var r = E.endTurn(G);
    assert.ok(Array.isArray(r.cpu));
    assert.ok(cpu.cr >= 0, 'never negative');
    assert.ok(E.cargoCount(cpu) <= E.cargoCap(cpu.ship), 'hold fits');
    assert.ok(cpu.ship.fuel >= 0);
    assert.strictEqual(E.contraband(cpu), 0);
  }
  assert.ok(G.over && G.over.winner === 1 && G.over.why === 'moon', 'rival bought its moon by day ' + G.day);
});

test('two captains alternate; the day advances once per round', function () {
  var G = E.newGame({ seed: 515, mode: 'duo', names: ['Ann', 'Bo'] });
  assert.strictEqual(G.players.length, 2);
  assert.strictEqual(G.players[1].name, 'Bo');
  var d = G.day;
  var r = E.endTurn(G);
  assert.ok(G.turn === 1 && !r.day && G.day === d);
  r = E.endTurn(G);
  assert.ok(G.turn === 0 && r.day && G.day === d + 1);
  G.players[1].out = 'dead';
  E.checkOver(G);
  assert.ok(G.over && G.over.winner === 0 && G.over.why === 'last');
});

test('determinism: same seed and moves, same game', function () {
  function play() {
    var G = E.newGame({ seed: 8080, mode: 'cpu', diff: 1 }), p = G.players[0];
    for (var t = 0; t < 25; t++) {
      for (var g = 0; g < E.GOODS.length; g++) if (p.cargo[g] && E.hasMarket(G, p.loc, g)) E.sell(G, 0, g, p.cargo[g]);
      var nb = E.neighbours(G.sys, p.loc, p.ship.fuel);
      E.refuel(G, 0);
      nb = E.neighbours(G.sys, p.loc, p.ship.fuel);
      var g2 = t % E.GOODS.length;
      if (E.produced(G, p.loc, g2)) E.buy(G, 0, g2, 3);
      if (!nb.length || E.warp(G, 0, nb[t % nb.length])) break;
      for (var guard = 0; guard < 50; guard++) {
        var e = E.nextEnc(G);
        if (!e) break;
        var acts = E.encActions(G);
        E.encAct(G, acts[acts.length - 1].a === 'surrender' ? 'flee' : acts[0].a);
      }
      if (p.out) break;
      E.arrive(G);
      E.endTurn(G);
    }
    return JSON.stringify(E.toSave(G));
  }
  assert.strictEqual(play(), play());
});

test('reviewer: galaxy is centred on the map and every system has a free cell', function () {
  for (var seed = 1; seed < 60; seed++) {
    var S = E.genGalaxy(seed * 7919), x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    S.forEach(function (s) { x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y); });
    assert.ok(Math.abs((x0 + x1) / 2 - E.MAP_W / 2) <= 3, 'x centred ' + seed);
    assert.ok(Math.abs((y0 + y1) / 2 - E.MAP_H / 2) <= 5, 'y centred ' + seed);
    S.forEach(function (s) { var c = E.cellOf(s.x, s.y); assert.ok(c.c >= 1 && c.c <= E.COLS - 2 && c.r >= 0 && c.r < E.ROWS); });
    assert.ok(E.connected(S, 13));
  }
});

test('reviewer: bad warp targets are refused, not crashes', function () {
  var G = E.newGame({ seed: 99 });
  [undefined, null, -1, 999, 1.5, 'x', NaN].forEach(function (t) { assert.ok(E.canWarp(G, 0, t)); assert.ok(E.warp(G, 0, t)); });
  assert.strictEqual(G.trip, null);
});

test('reviewer: conceding a race hands the win over; waiting passes a day', function () {
  var G = E.newGame({ seed: 77, mode: 'cpu' }), d = G.day;
  E.endTurn(G);                       // wait a day: the rival moves, the day ticks
  assert.strictEqual(G.day, d + 1);
  assert.strictEqual(G.turn, 0);
  assert.strictEqual(E.retire(G, 0), '');
  assert.ok(G.over && G.over.winner === 1 && G.over.why === 'conceded');
  var R = E.newRecords(); E.record(R, G);
  assert.strictEqual(R.wins, 0);
  var D = E.newGame({ seed: 78, mode: 'duo' });
  E.retire(D, 0); E.checkOver(D);
  assert.ok(D.over && D.over.winner === 1 && D.over.why === 'last');
});

test('reviewer: the CPU repays its loan and buys the moon when it can', function () {
  var G = E.newGame({ seed: 4242, mode: 'cpu', diff: 1 }), c = G.players[1];
  var hi = -1; for (var k = 0; k < G.sys.length; k++) if (G.sys[k].tl >= 6) { hi = k; break; }
  c.loc = hi; c.debt = 5000; c.cr = E.moonPrice(G) + 6000;
  E.cpuTurn(G, 1);
  assert.ok(c.moon && c.debt === 0, 'moon bought');
  E.checkOver(G);
  assert.ok(G.over && G.over.winner === 1 && G.over.why === 'moon');
});

test('reviewer: random play fuzz keeps every invariant', function () {
  for (var seed = 1; seed <= 30; seed++) {
    var G = E.newGame({ seed: seed * 313, mode: ['solo', 'cpu', 'duo'][seed % 3], diff: seed % 3 });
    var r = E.rng(seed);
    for (var step = 0; step < 400 && !G.over; step++) {
      var pi = G.turn, p = G.players[pi], x = r();
      if (G.trip) {
        var e = E.nextEnc(G);
        if (e) { var A = E.encActions(G); assert.ok(A.length, 'encounter has actions'); E.encAct(G, A[Math.floor(r() * A.length)].a); E.encAct(G, 'bogus'); }
        else { E.arrive(G); E.endTurn(G); }
      } else if (x < 0.25) E.buy(G, pi, Math.floor(r() * E.GOODS.length), 1 + Math.floor(r() * 8));
      else if (x < 0.4) E.sell(G, pi, Math.floor(r() * E.GOODS.length), 1 + Math.floor(r() * 8));
      else if (x < 0.45) E.refuel(G, pi);
      else if (x < 0.48) E.repair(G, pi);
      else if (x < 0.52) E.buyEquip(G, pi, ['w', 's', 'g'][Math.floor(r() * 3)], ['pulse', 'deflector', 'pods', 'cells'][Math.floor(r() * 4)]);
      else if (x < 0.54) E.sellEquip(G, pi, ['w', 's', 'g'][Math.floor(r() * 3)], 0);
      else if (x < 0.56) E.buyShip(G, pi, Math.floor(r() * E.SHIPS.length));
      else if (x < 0.58) E.borrow(G, pi, 500);
      else if (x < 0.6) E.repay(G, pi, 500);
      else if (x < 0.63) { var B = E.board(G, p.loc, pi); if (B.length) E.accept(G, pi, B[0].id); }
      else if (x < 0.66) E.endTurn(G);
      else {
        var nb = E.neighbours(G.sys, p.loc, p.ship.fuel);
        if (nb.length) E.warp(G, pi, nb[Math.floor(r() * nb.length)]); else { E.borrow(G, pi, 500); E.refuel(G, pi); E.endTurn(G); }
      }
      G.players.forEach(function (q) {
        assert.ok(isFinite(q.cr) && q.cr >= 0, 'cash ' + q.cr);
        assert.ok(q.debt >= 0);
        assert.ok(E.cargoCount(q) <= E.cargoCap(q.ship), 'hold fits');
        q.cargo.forEach(function (n) { assert.ok(n >= 0 && n === Math.floor(n)); });
        assert.ok(q.ship.fuel >= 0 && q.ship.fuel <= E.rangeOf(q.ship));
        assert.ok(q.ship.hull >= 0 && q.ship.hull <= E.hullMax(q.ship));
        assert.ok(q.ship.w.length <= E.SHIPS[q.ship.t].w && q.ship.g.length <= E.SHIPS[q.ship.t].g);
        assert.ok(q.missions.length <= E.MAX_MISSIONS);
      });
      var back = E.normGame(JSON.parse(JSON.stringify(E.toSave(G))));
      assert.ok(back, 'save reloads');
    }
  }
});

test('saves: JSON round trip and defensive normalisation', function () {
  var G = E.newGame({ seed: 1357, mode: 'cpu', diff: 2 }), p = G.players[0];
  p.cr = 5555; p.cargo[2] = 4; p.paid[2] = 400;
  E.accept(G, 0, E.board(G, p.loc, 0)[0].id);
  forceEnc(G, 'trader');
  var raw = JSON.stringify(E.toSave(G)), back = E.normGame(JSON.parse(raw));
  assert.ok(back);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(E.toSave(back))), JSON.parse(raw));
  assert.deepStrictEqual(back.sys, G.sys, 'the map is rebuilt from the seed');
  assert.strictEqual(E.normGame(null), null);
  assert.strictEqual(E.normGame({ v: 999 }), null);
  assert.strictEqual(E.normGame({ v: E.VERSION, seed: 5, mode: 'solo', players: [] }), null);
  var junk = E.normGame({
    v: E.VERSION, seed: 5, mode: 'solo', diff: 9, day: -4, turn: 7, glut: 'x', ev: [{ e: 999 }],
    players: [{ name: '', cr: 'lots', cargo: [1e9, -3, 'a'], ship: { t: 99, hull: -5, fuel: 1e9, w: ['nope', 'pulse', 'beam'], g: ['cloak', 'cloak'] }, missions: [{ k: 'evil' }, { k: 'courier', to: 999 }], rec: 1e9 }],
    trip: { pi: 0, to: 2, q: ['pirate', 5], enc: { kind: 'pirate', st: 'fight', ship: null } }
  });
  assert.ok(junk && junk.diff === 2 && junk.day === 1 && junk.turn === 0);
  var jp = junk.players[0];
  assert.ok(jp.name === 'Captain' && jp.cr === E.DIFFS[2].cash);
  assert.ok(jp.cargo[0] === 1000 && jp.cargo[1] === 0 && jp.cargo[2] === 0);
  assert.ok(jp.ship.t === 5 && jp.ship.hull === 1 && jp.ship.fuel === E.rangeOf(jp.ship));
  assert.deepStrictEqual(jp.ship.w, ['pulse', 'beam']);
  assert.ok(jp.missions.length === 0 && jp.rec === 100);
  assert.ok(junk.trip && junk.trip.q.length === 1 && junk.trip.enc.st === 'done');
  assert.ok(junk.ev.every(function (e) { return e === null; }));
  var R = E.normRecords({ games: 'x', best: [{ score: 5, mode: 'zz' }, { score: 'nan' }, null, { score: 50, diff: 9 }] });
  assert.ok(R.games === 0 && R.best.length === 2 && R.best[0].score === 50 && R.best[0].diff === 2 && R.best[1].mode === 'solo');
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
