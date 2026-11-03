/* Headless checks for the Deck Delve engine (content, maps, combat rules, AI, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/deckbuilder/deckbuilder.test.js */
'use strict';
var assert = require('assert');

var E = require('./deckbuilder.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; }, asset: function (p) { return p; } } };
delete require.cache[require.resolve('./deckbuilder.js')];
require('./deckbuilder.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
// a fight against chosen enemies with a chosen hand, no relic noise
function fight(enc, hand, opts) {
  var R = E.newRun(opts && opts.seed || 1);
  R.relics = (opts && opts.relics) || [];
  E.startFight(R, 'fight', enc);
  var C = R.c;
  if (hand) {
    C.draw = C.draw.concat(C.hand); C.hand = [];
    hand.forEach(function (id) { C.hand.push({ id: id, u: 0, k: R.nk++ }); });
  }
  C.en = 3;
  return R;
}
function walk(seed, picker, steps) {
  var R = E.newRun(seed), k = 0;
  E.autoRun(R, picker || function (n) { return (k++ * 7) % n; }, steps || 6000);
  return R;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Deck Delve' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'deckbuilder.css');
  assert.strictEqual(widget._engine.VERSION, E.VERSION);
});

test('content: 60+ cards, 20+ enemies, 3 bosses, 20+ relics, 10+ events', function () {
  var cards = Object.keys(E.CARDS).filter(function (id) { var d = E.CARDS[id]; return d.t !== 'sts' && d.t !== 'crs'; });
  assert.ok(cards.length >= 60, 'cards ' + cards.length);
  var en = Object.keys(E.ENEMIES), bosses = en.filter(function (id) { return E.ENEMIES[id].boss; });
  assert.ok(en.length - bosses.length >= 20, 'enemies');
  assert.strictEqual(bosses.length, 3);
  assert.ok(Object.keys(E.RELICS).length >= 20);
  assert.ok(Object.keys(E.EVENTS).length >= 10);
  var names = {};
  cards.forEach(function (id) { var n = E.CARDS[id].n; assert.ok(!names[n], 'duplicate name ' + n); names[n] = 1; });
});

test('every card has text, a sane cost, and a real upgrade', function () {
  Object.keys(E.CARDS).forEach(function (id) {
    var d = E.CARDS[id], c = { id: id, u: 0 }, t = E.cardText(c);
    assert.ok(t.length > 3, id + ' text');
    assert.ok(E.cardShort(c).length > 0, id + ' short');
    if (d.t !== 'sts' && d.t !== 'crs') {
      assert.ok(typeof d.c === 'number' && d.c >= -1 && d.c <= 3, id + ' cost');
      assert.ok(d.u, id + ' has an upgrade');
      var up = { id: id, u: 1 };
      assert.ok(E.cardText(up) !== t || E.cdef(up).c !== d.c, id + ' upgrade changes something');
      assert.ok(['e', 'all', 'none'].indexOf(d.tg) >= 0, id + ' target');
    }
    d.a.forEach(function (a) { if (a[0] === 'add') assert.ok(E.CARDS[a[1]], id + ' adds a real card'); });
  });
});

test('enemies: moves, AI indices and encounters are valid', function () {
  var KINDS = { atk: 1, blk: 1, blkAll: 1, st: 1, pst: 1, heal: 1, add: 1 };
  Object.keys(E.ENEMIES).forEach(function (id) {
    var d = E.ENEMIES[id];
    assert.ok(d.hp[0] > 0 && d.hp[1] >= d.hp[0], id + ' hp');
    assert.ok(d.art.length >= 3, id + ' art');
    d.m.forEach(function (m) { m.a.forEach(function (a) { assert.ok(KINDS[a[0]], id + ' action ' + a[0]); if (a[0] === 'add') assert.ok(E.CARDS[a[1]]); if (a[0] === 'st' || a[0] === 'pst') assert.ok(E.ST[a[1]], a[1]); }); });
    var ai = d.ai, n = d.m.length;
    assert.ok(ai.cyc || ai.w, id + ' ai');
    if (ai.cyc) ai.cyc.forEach(function (i) { assert.ok(i >= 0 && i < n); });
    if (ai.w) assert.strictEqual(ai.w.length, n);
    if (ai.first != null) assert.ok(ai.first < n);
    if (ai.half != null) assert.ok(ai.half < n);
  });
  [1, 2, 3].forEach(function (a) {
    ['weak', 'strong', 'elite'].forEach(function (k) { E.ENC[a][k].forEach(function (enc) { enc.forEach(function (id) { assert.ok(E.ENEMIES[id], id); }); }); });
    assert.ok(E.ENEMIES[E.ENC[a].boss[0]].boss);
  });
});

test('maps: connected, non-crossing, typed by the rules', function () {
  for (var seed = 1; seed < 40; seed++) {
    var R = E.newRun(seed * 31);
    R.maps.forEach(function (M) {
      var N = M.nodes, reach = {};
      assert.ok(N.some(function (n) { return n.r === 0; }));
      N.forEach(function (n, i) {
        if (n.r === 0) reach[i] = 1;
        assert.ok(n.c >= 0 && n.c < E.COLS && n.r >= 0 && n.r < E.ROWS);
        if (n.r < E.ROWS - 1) assert.ok(n.nx.length > 0, 'dead end');
        n.nx.forEach(function (j) { assert.strictEqual(N[j].r, n.r + 1); assert.ok(Math.abs(N[j].c - n.c) <= 1); });
        if (n.r === 0) assert.strictEqual(n.t, 'fight');
        if (n.r === E.ROWS - 1) assert.strictEqual(n.t, 'rest');
        if (n.r < 4) assert.ok(n.t !== 'elite' && n.t !== 'rest', 'early ' + n.t);
      });
      N.forEach(function (n, i) { if (reach[i]) n.nx.forEach(function (j) { reach[j] = 1; }); });
      N.forEach(function (n, i) { assert.ok(reach[i], 'unreachable node'); });
      // no two edges cross
      N.forEach(function (a) {
        a.nx.forEach(function (j) {
          var b = N[j];
          N.forEach(function (c) { if (c.r === a.r && c.c === a.c + (b.c - a.c) && b.c !== a.c) c.nx.forEach(function (k) { assert.ok(!(N[k].c === a.c), 'crossing'); }); });
        });
      });
    });
  }
});

test('seeds: deterministic runs; codes round-trip; daily seed is per date', function () {
  var a = walk(12345), b = walk(12345), c = walk(54321);
  assert.deepStrictEqual(clone(a.maps), clone(b.maps));
  assert.strictEqual(a.floor, b.floor);
  assert.strictEqual(a.gold, b.gold);
  assert.deepStrictEqual(a.deck.map(function (x) { return x.id; }), b.deck.map(function (x) { return x.id; }));
  assert.notDeepStrictEqual(clone(a.maps), clone(c.maps));
  [0, 1, 36, 123456789, 4294967295].forEach(function (n) { assert.strictEqual(E.parseSeed(E.seedCode(n)), n); });
  assert.strictEqual(E.parseSeed('  '), null);
  assert.strictEqual(E.parseSeed('hello world'), E.parseSeed('HELLO WORLD'));
  assert.strictEqual(E.dailySeed('2026-10-31'), E.dailySeed('2026-10-31'));
  assert.notStrictEqual(E.dailySeed('2026-10-31'), E.dailySeed('2026-11-01'));
  assert.strictEqual(E.dateKey(new Date(2026, 0, 5)), '2026-01-05');
});

test('damage: strength, weak, vulnerable, block and thorns', function () {
  var src = { st: { str: 2 } }, tgt = { st: {} };
  assert.strictEqual(E.atkDmg(6, src, tgt), 8);
  tgt.st.vuln = 1; assert.strictEqual(E.atkDmg(6, src, tgt), 12);
  src.st.weak = 1; assert.strictEqual(E.atkDmg(6, src, tgt), 9);
  var R = fight(['mossRat'], ['strike', 'strike']);
  var e = R.c.e[0]; e.hp = e.mhp = 50; e.blk = 4;
  assert.strictEqual(E.playCard(R, 0, 0), '');
  assert.strictEqual(e.hp, 48, 'block soaks 4 of 6');
  assert.strictEqual(e.blk, 0);
  e.st.thorns = 3;
  var hp = R.c.p.hp;
  E.playCard(R, 0, 0);
  assert.strictEqual(R.c.p.hp, hp - 3, 'thorns bite back');
});

test('cards: energy, X cost, unplayables, exhaust, powers', function () {
  var R = fight(['caveSlug'], ['cataclysm', 'wound', 'whirl', 'bandage', 'innerFire']);
  var C = R.c; C.e[0].hp = C.e[0].mhp = 200;
  C.en = 2;
  assert.strictEqual(E.playCard(R, 0, 0), 'Not enough energy');
  assert.strictEqual(E.playCard(R, 1, 0), 'Unplayable');
  C.en = 3;
  E.playCard(R, 4, 0); // inner fire: power, gone from the fight
  assert.strictEqual(C.p.st.str, 2);
  assert.strictEqual(C.exh.length + C.disc.length, 0);
  C.p.hp = 50;
  E.playCard(R, 3, 0); // bandage: exhausts
  assert.strictEqual(C.p.hp, 54);
  assert.strictEqual(C.exh[0].id, 'bandage');
  var before = C.e[0].hp;
  E.playCard(R, C.hand.findIndex(function (c) { return c.id === 'whirl'; }), 0);
  assert.strictEqual(C.en, 0, 'X spends everything');
  assert.strictEqual(before - C.e[0].hp, 2 * (5 + 2), 'X=2 hits with strength');
});

test('block: dexterity, frail, expiry and Stone Stance', function () {
  var R = fight(['mossRat'], ['guard', 'guard', 'guard']);
  var C = R.c;
  C.p.st.dex = 2;
  E.playCard(R, 0);
  assert.strictEqual(C.p.blk, 7);
  C.p.st.frail = 2;
  E.playCard(R, 0);
  assert.strictEqual(C.p.blk, 7 + 5);
  C.e[0].hp = C.e[0].mhp = 500;
  E.endTurn(R); while (E.enemyStep(R));
  assert.strictEqual(C.phase, 'player');
  assert.strictEqual(C.p.blk, 0, 'block expires');
  assert.strictEqual(C.p.st.frail, 1, 'frail ticks down');
  C.p.st.keepBlock = 1; C.p.blk = 9;
  C.e[0].mv = 1; // scurry: block + small attack
  E.endTurn(R); while (E.enemyStep(R));
  assert.ok(C.p.blk > 0, 'stone stance keeps block');
});

test('poison ticks at the start of its owner turn and fades', function () {
  var R = fight(['mossRat'], ['coatBlade']);
  var C = R.c, e = C.e[0];
  e.hp = e.mhp = 40;
  E.playCard(R, 0, 0);
  assert.strictEqual(e.st.poison, 5);
  E.endTurn(R); E.enemyStep(R);
  assert.strictEqual(e.hp, 35);
  assert.strictEqual(e.st.poison, 4);
  while (E.enemyStep(R));
  assert.strictEqual(C.turn, 2);
});

test('intents show real damage; AI picks legal moves; no move three times running', function () {
  var R = fight(['bonePup'], []);
  var C = R.c, e = C.e[0];
  e.mv = 0; e.st.str = 2;
  assert.strictEqual(E.intentOf(R, e).dmg, 7);
  C.p.st.vuln = 1;
  assert.strictEqual(E.intentOf(R, e).dmg, 10);
  Object.keys(E.ENEMIES).forEach(function (id) {
    var R2 = fight([id], []), en = R2.c.e[0], d = E.ENEMIES[id];
    en.hp = en.mhp = 100000;
    R2.c.p.hp = R2.c.p.mhp = 100000;
    for (var t = 0; t < 30 && R2.phase === 'combat'; t++) {
      assert.ok(en.mv >= 0 && en.mv < d.m.length, id + ' move');
      assert.ok(E.intentOf(R2, en), id + ' intent');
      E.endTurn(R2); while (E.enemyStep(R2));
    }
    if (d.ai.w) for (var i = 2; i < en.hist.length; i++) assert.ok(!(en.hist[i] === en.hist[i - 1] && en.hist[i] === en.hist[i - 2]), id + ' repeats');
    if (d.ai.first != null) assert.ok(d.ai.first >= 0);
  });
});

test('boss uses its half-health move once (even if it got there without a hit, e.g. an old save)', function () {
  var R = fight(['rootmaw'], []);
  var e = R.c.e[0], low = E.ENEMIES.rootmaw.react.low;
  R.c.p.hp = R.c.p.mhp = 9999;
  e.hp = Math.floor(e.mhp / 2) - 1;
  E.endTurn(R); while (E.enemyStep(R));
  assert.strictEqual(e.mv, low);
  E.endTurn(R); while (E.enemyStep(R));
  assert.notStrictEqual(e.mv, low);
});

test('relics fire: whetstone, oak ward, marked map, ember heart, tally stick', function () {
  var R = fight(['caveSlug'], ['strike'], { relics: ['whetstone', 'oakWard', 'markedMap'] });
  // relics apply at fight start; fight() set them after newRun, so start again
  E.startFight(R, 'fight', ['caveSlug']);
  assert.strictEqual(R.c.p.st.str, 1);
  assert.strictEqual(R.c.p.blk, 10);
  assert.strictEqual(R.c.e[0].st.vuln, 1);
  var R2 = E.newRun(3); R2.hp = 50;
  E.startFight(R2, 'fight', ['mossRat']);
  R2.c.e[0].hp = 1;
  R2.c.hand = [{ id: 'strike', u: 0, k: 999 }]; R2.c.en = 1;
  E.playCard(R2, 0, 0);
  assert.strictEqual(R2.phase, 'reward');
  assert.strictEqual(R2.hp, 56, 'ember heart heals 6');
  var R3 = fight(['caveSlug'], ['strike'], { relics: ['tallyStick'] });
  R3.counters.atk = 9; R3.c.e[0].hp = R3.c.e[0].mhp = 99;
  E.playCard(R3, 0, 0);
  assert.strictEqual(R3.c.e[0].hp, 99 - 12);
});

test('winning a fight gives gold, a card choice; elites a relic; bosses advance the act', function () {
  var R = E.newRun(77);
  E.chooseNode(R, E.nextNodes(R)[0]);
  assert.strictEqual(R.phase, 'combat');
  var g = R.gold;
  R.c.e.forEach(function (e) { e.hp = 1; });
  R.c.hand = [{ id: 'sweep', u: 0, k: 9999 }]; R.c.en = 1;
  E.playCard(R, 0, 0);
  assert.strictEqual(R.phase, 'reward');
  assert.ok(R.gold > g);
  assert.ok(R.rew.cards.length === 3);
  var n = R.deck.length;
  assert.ok(E.takeCard(R, 1));
  assert.ok(!E.takeCard(R, 0), 'only one card');
  assert.strictEqual(R.deck.length, n + 1);
  assert.ok(E.proceed(R));
  assert.strictEqual(R.phase, 'map');
  // elite
  E.startFight(R, 'elite');
  R.c.e.forEach(function (e) { e.hp = 1; });
  R.c.hand = [{ id: 'sweep', u: 0, k: 9998 }]; R.c.en = 1;
  E.playCard(R, 0, 0);
  assert.ok(R.rew.relic);
  var nr = R.relics.length;
  E.proceed(R);
  assert.strictEqual(R.relics.length, nr + 1, 'unclaimed relic is taken on leaving');
  // boss
  R.pos = R.maps[0].nodes.findIndex(function (x) { return x.r === E.ROWS - 1; });
  assert.deepStrictEqual(E.nextNodes(R), [-2]);
  E.chooseNode(R, -2);
  assert.ok(R.c.e[0].id === 'rootmaw');
  R.c.e[0].hp = 1; R.c.hand = [{ id: 'sweep', u: 0, k: 9997 }]; R.c.en = 1;
  E.playCard(R, 0, 0);
  assert.strictEqual(R.rew.boss.length, 3);
  assert.ok(R.rew.cards.every(function (c) { return E.CARDS[c.id].r === 'rare'; }));
  E.takeBossRelic(R, 0);
  assert.strictEqual(E.energyMax(R) >= 3, true);
  E.proceed(R);
  assert.strictEqual(R.act, 2);
  assert.strictEqual(R.pos, -1);
  assert.strictEqual(R.hp, R.mhp);
});

test('shop: prices, no overspending, removal; rest: heal or upgrade', function () {
  var SH = E.newRun(5); SH.gold = 60;
  SH.phase = 'map';
  // force a shop
  var M = SH.maps[0];
  var shopIdx = M.nodes.findIndex(function (n) { return n.t === 'shop'; });
  if (shopIdx < 0) { M.nodes[0].t = 'shop'; shopIdx = 0; }
  SH.pos = -1;
  M.nodes[shopIdx].r === 0 || (SH.pos = M.nodes.findIndex(function (n) { return n.nx.indexOf(shopIdx) >= 0; }));
  assert.ok(E.chooseNode(SH, shopIdx));
  assert.strictEqual(SH.phase, 'shop');
  assert.strictEqual(SH.shop.cards.length, 5);
  var cheap = SH.shop.cards.reduce(function (a, c, i) { return E.shopPrice(SH, c.p) < E.shopPrice(SH, SH.shop.cards[a].p) ? i : a; }, 0);
  var dear = SH.shop.cards.findIndex(function (c) { return E.shopPrice(SH, c.p) > 60; });
  if (dear >= 0) assert.ok(!E.buyCard(SH, dear), 'cannot overspend');
  SH.gold = 500;
  var g = SH.gold, n = SH.deck.length;
  assert.ok(E.buyCard(SH, cheap));
  assert.ok(!E.buyCard(SH, cheap), 'sold out');
  assert.strictEqual(SH.gold, g - E.shopPrice(SH, SH.shop.cards[cheap].p));
  assert.strictEqual(SH.deck.length, n + 1);
  var rc = E.removeCost(SH);
  assert.ok(E.buyRemove(SH));
  assert.strictEqual(SH.phase, 'pick');
  g = SH.gold;
  assert.ok(E.pickCard(SH, 0));
  assert.strictEqual(SH.gold, g - rc);
  assert.strictEqual(SH.deck.length, n);
  assert.strictEqual(SH.phase, 'shop');
  assert.ok(!E.buyRemove(SH), 'one removal per shop');
  // rest
  var RS = E.newRun(6);
  RS.phase = 'rest'; RS.rest = { done: false }; RS.hp = 20;
  assert.ok(E.restHeal(RS));
  assert.strictEqual(RS.hp, 20 + Math.floor(80 * 0.3));
  assert.ok(!E.restHeal(RS));
  RS.rest = { done: false };
  assert.ok(E.restUpgrade(RS));
  var idx = RS.deck.findIndex(E.canUpgrade);
  E.pickCard(RS, idx);
  assert.strictEqual(RS.deck[idx].u, 1);
  assert.ok(RS.rest.done && RS.phase === 'rest');
  assert.ok(!E.pickCard(RS, idx));
});

test('every event option resolves cleanly', function () {
  Object.keys(E.EVENTS).forEach(function (id) {
    E.EVENTS[id].opts(E.newRun(1)).forEach(function (o, i) {
      var R = E.newRun(i + 10);
      R.gold = 200; R.addCard = null;
      E.addCard(R, 'regret');
      R.phase = 'event'; R.evt = { id: id, done: false, msg: '', cards: null };
      var opts = E.eventOptions(R);
      if (!opts[i].ok) return;
      assert.ok(E.eventChoose(R, i), id + ' ' + i);
      if (R.phase === 'pick') { assert.ok(E.pickCard(R, R.deck.findIndex(function (c) { return E.pickable(R, c); }))); assert.strictEqual(R.phase, 'event'); }
      if (R.phase === 'event' && R.evt.cards) E.eventTakeCard(R, 0);
      if (R.phase === 'combat') { assert.ok(R.c.e.length > 0); return; }
      assert.ok(R.evt.done, id + ' done');
      assert.ok(R.evt.msg.length > 0, id + ' msg');
      assert.ok(R.hp > 0 && R.hp <= R.mhp && R.gold >= 0);
      assert.ok(E.proceed(R));
    });
  });
});

test('saves: JSON round trip mid-fight continues identically; junk is rejected', function () {
  var R = E.newRun(999);
  E.chooseNode(R, E.nextNodes(R)[0]);
  E.autoTurn(R);
  var copy = E.normRun(JSON.parse(JSON.stringify(R)));
  assert.ok(copy, 'valid save');
  E.autoRun(R, function () { return 0; }, 400);
  E.autoRun(copy, function () { return 0; }, 400);
  assert.strictEqual(copy.floor, R.floor);
  assert.strictEqual(copy.hp, R.hp);
  assert.strictEqual(copy.gold, R.gold);
  [null, 5, 'x', {}, { v: 1 }, { v: 2 }, { v: 99, deck: [] }].forEach(function (j) { assert.strictEqual(E.normRun(j), null); });
  var bad = JSON.parse(JSON.stringify(E.newRun(3)));
  bad.deck[0].id = 'nonesuch';
  assert.strictEqual(E.normRun(bad), null);
  bad = JSON.parse(JSON.stringify(E.newRun(3)));
  bad.hp = 1e9; bad.gold = -5;
  var n = E.normRun(bad);
  assert.strictEqual(n.hp, n.mhp);
  assert.strictEqual(n.gold, 0);
  bad = JSON.parse(JSON.stringify(E.newRun(3)));
  bad.phase = 'combat'; bad.c = { e: [] };
  assert.strictEqual(E.normRun(bad), null);
});

test('stats: record runs, bests, streaks, daily; normalise junk', function () {
  var s = E.normStats(null);
  assert.strictEqual(s.runs, 0);
  var R = walk(4242);
  R.daily = '2026-10-31';
  var r = E.recordRun(s, R, 1000);
  assert.strictEqual(s.runs, 1);
  assert.ok(r.newBest);
  assert.ok(s.daily['2026-10-31']);
  var again = E.normStats(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(again, s);
  var junk = E.normStats({ runs: 'x', hist: [null, 5, { floor: 'q', act: 9 }], daily: { nope: 1, '2026-01-01': { score: -4 } } });
  assert.strictEqual(junk.runs, 0);
  assert.strictEqual(junk.hist.length, 1);
  assert.strictEqual(junk.hist[0].act, 3);
  assert.strictEqual(junk.daily['2026-01-01'].score, 0);
  assert.ok(!junk.daily.nope);
});

test('whole runs: no crashes, invariants hold, every run ends', function () {
  var acts = [0, 0, 0, 0];
  for (var seed = 1; seed <= 120; seed++) {
    var k = seed;
    var R = walk(seed * 2654435761 >>> 0, function (n) { k = (k * 1103515245 + 12345) >>> 0; return k % n; }, 8000);
    assert.ok(R.over, 'run ' + seed + ' ended (' + R.phase + ')');
    assert.ok(R.hp >= 0 && R.hp <= R.mhp, 'hp');
    assert.ok(R.gold >= 0, 'gold');
    assert.ok(R.deck.length > 0);
    assert.ok(R.won || R.killedBy, 'death has a cause');
    acts[R.act]++;
    var sv = E.normRun(JSON.parse(JSON.stringify(R)));
    assert.ok(sv, 'finished runs normalise');
  }
  assert.ok(acts[2] + acts[3] > 0, 'some runs reach act 2');
});

test('the act 1 starting deck can beat the first fights', function () {
  var won = 0;
  for (var s = 1; s <= 60; s++) {
    var R = E.newRun(s);
    E.chooseNode(R, E.nextNodes(R)[0]);
    for (var t = 0; t < 40 && R.phase === 'combat'; t++) E.autoTurn(R);
    if (R.phase === 'reward') won++;
  }
  assert.ok(won >= 55, 'won ' + won + '/60');
});

test('statuses never show as upgraded; picks can be cancelled; transform and duplicate', function () {
  assert.strictEqual(E.cardName({ id: 'wound', u: 1 }), 'Wound');
  assert.strictEqual(E.cardName({ id: 'strike', u: 1 }), 'Strike+');
  var R = E.newRun(8);
  R.phase = 'event'; R.evt = { id: 'smith', done: false, msg: '', cards: null };
  E.eventChoose(R, 1);
  assert.strictEqual(R.phase, 'pick');
  var n = R.deck.length, before = R.deck[0].id;
  assert.ok(E.pickCard(R, 0));
  assert.strictEqual(R.deck.length, n);
  assert.notStrictEqual(R.deck[0].id, before, 'transformed');
  assert.ok(R.evt.done && /Transformed/.test(R.evt.msg));
  R.phase = 'event'; R.evt = { id: 'mirror', done: false, msg: '', cards: null };
  E.eventChoose(R, 0);
  assert.ok(E.cancelPick(R));
  assert.strictEqual(R.phase, 'event');
  assert.ok(R.evt.done);
  assert.strictEqual(R.deck.length, n, 'nothing copied');
});

test('a save made in the middle of the enemy turn resumes it', function () {
  var R = E.newRun(31337);
  E.startFight(R, 'fight', ['mossRat', 'bonePup', 'sporePuff']);
  R.c.p.hp = R.c.p.mhp = 500;
  E.endTurn(R);
  E.enemyStep(R);
  var S = E.normRun(JSON.parse(JSON.stringify(R)));
  assert.strictEqual(S.c.phase, 'enemy');
  while (E.enemyStep(R));
  while (E.enemyStep(S));
  assert.strictEqual(S.c.turn, 2);
  assert.strictEqual(S.c.p.hp, R.c.p.hp);
  assert.deepStrictEqual(S.c.hand.map(function (c) { return c.k; }), R.c.hand.map(function (c) { return c.k; }));
});

test('phoenix feather saves you once', function () {
  var R = fight(['mossRat'], [], { relics: ['phoenix'] });
  R.c.p.hp = 3;
  R.c.e[0].mv = 0; R.c.e[0].st.str = 20;
  E.endTurn(R); while (E.enemyStep(R));
  assert.strictEqual(R.phase, 'combat');
  assert.ok(R.phoenixUsed && R.c.p.hp > 30);
  R.c.p.hp = 3;
  R.c.e[0].mv = 0;
  E.endTurn(R); while (E.enemyStep(R));
  assert.strictEqual(R.phase, 'over');
  assert.strictEqual(R.killedBy, 'Moss Rat');
});

test('backing out of a paid event choice refunds the price', function () {
  var R = E.newRun(31);
  R.gold = 100; R.phase = 'event'; R.evt = { id: 'altar', done: false, msg: '', cards: null };
  assert.ok(E.eventChoose(R, 1));
  assert.strictEqual(R.phase, 'pick'); assert.strictEqual(R.gold, 40);
  assert.ok(E.cancelPick(R));
  assert.strictEqual(R.gold, 100); assert.strictEqual(R.phase, 'event'); assert.ok(R.evt.done);
  // pay and go through with it: no refund, a card is gone
  var R2 = E.newRun(31), n = R2.deck.length;
  R2.gold = 100; R2.phase = 'event'; R2.evt = { id: 'altar', done: false, msg: '', cards: null };
  E.eventChoose(R2, 1); assert.ok(E.pickCard(R2, 0));
  assert.strictEqual(R2.gold, 40); assert.strictEqual(R2.deck.length, n - 1);
  // the pool's dive costs HP; backing out gives it back (capped at max)
  var R3 = E.newRun(32);
  R3.hp = 50; R3.phase = 'event'; R3.evt = { id: 'pool', done: false, msg: '', cards: null };
  E.eventChoose(R3, 1); assert.strictEqual(R3.hp, 44);
  E.cancelPick(R3); assert.strictEqual(R3.hp, 50);
  // the refund survives a save
  var R4 = E.newRun(33);
  R4.gold = 70; R4.phase = 'event'; R4.evt = { id: 'altar', done: false, msg: '', cards: null };
  E.eventChoose(R4, 1);
  R4 = E.normRun(clone(R4)); assert.ok(R4);
  E.cancelPick(R4); assert.strictEqual(R4.gold, 70);
});

test('Blood Crown can end a run at the start of a fight (the run is over, not stuck)', function () {
  var R = E.newRun(41);
  R.relics.push('bloodCrown'); R.hp = 3;
  var nx = E.nextNodes(R);
  assert.ok(E.chooseNode(R, nx[0]));
  assert.ok(R.over && !R.won); assert.strictEqual(R.phase, 'over');
  var st = E.newStats(), res = E.recordRun(st, R, 1);
  assert.strictEqual(st.runs, 1); assert.ok(res.summary.by.length > 0);
});

test('random legal play over many seeds keeps every invariant (and saves reload)', function () {
  var x = 7;
  function rr(n) { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % n; }
  for (var run = 0; run < 60; run++) {
    var R = E.newRun(run * 977 + 5); R.mhp = R.hp = 500;
    for (var s = 0; s < 4000 && !R.over; s++) {
      if (rr(25) === 0) { R = E.normRun(clone(R)); assert.ok(R, 'save reloads'); }
      var ph = R.phase;
      if (ph === 'map') { var nx = E.nextNodes(R); E.chooseNode(R, nx[rr(nx.length)]); }
      else if (ph === 'combat') {
        var C = R.c;
        if (C.phase === 'enemy') E.enemyStep(R);
        else {
          var pl = C.hand.map(function (c, i) { return E.whyNot(R, c) ? -1 : i; }).filter(function (i) { return i >= 0; });
          if (pl.length && rr(7)) assert.strictEqual(E.playCard(R, pl[rr(pl.length)], rr(C.e.length)), '');
          else E.endTurn(R);
        }
        if (R.c) {
          assert.ok(R.c.hand.length <= E.MAX_HAND && R.c.en >= 0 && R.c.p.hp <= R.c.p.mhp && R.c.p.blk >= 0);
          R.c.e.forEach(function (e) { assert.ok(e.dead || (e.mv >= 0 && e.mv < E.ENEMIES[e.id].m.length)); assert.ok(e.hp <= e.mhp && e.blk >= 0); });
        }
      } else if (ph === 'reward') { if (R.rew.cards && rr(2)) E.takeCard(R, rr(R.rew.cards.length)); if (R.rew.boss) E.takeBossRelic(R, rr(R.rew.boss.length)); E.proceed(R); }
      else if (ph === 'rest') { if (!(rr(2) ? E.restUpgrade(R) : E.restHeal(R))) E.restHeal(R); if (R.phase === 'rest') E.proceed(R); }
      else if (ph === 'pick') { var ok = R.deck.map(function (c, i) { return E.pickable(R, c) ? i : -1; }).filter(function (i) { return i >= 0; }); if (!ok.length || rr(5) === 0 || !E.pickCard(R, ok[rr(ok.length)])) E.cancelPick(R); }
      else if (ph === 'event') {
        if (R.evt.cards) E.eventTakeCard(R, rr(R.evt.cards.length));
        else if (!R.evt.done) { var os = E.eventOptions(R).map(function (o, i) { return o.ok ? i : -1; }).filter(function (i) { return i >= 0; }); assert.ok(E.eventChoose(R, os[rr(os.length)])); }
        else E.proceed(R);
      } else if (ph === 'shop') { var k = rr(4); if (k === 0) E.buyCard(R, rr(5)); else if (k === 1) E.buyRelic(R, rr(3)); else if (k === 2) E.buyRemove(R); else E.proceed(R); }
      else if (ph === 'treasure') E.proceed(R);
      assert.ok(isFinite(R.hp) && R.hp <= R.mhp && R.gold >= 0, 'hp/gold sane');
    }
    assert.ok(R.over || R.act >= 1);
  }
});

// ================= hand retention, hidden / changing intents, scouting, Blindfold =================
function ids(a) { return a.map(function (c) { return c.id; }); }
function endRound(R) { E.endTurn(R); while (E.enemyStep(R)); }
function tough(R) { R.c.p.hp = R.c.p.mhp = 9999; R.c.e.forEach(function (e) { e.hp = e.mhp = 9999; }); }

test('retention: unplayed cards stay; Ethereal exhausts; statuses and curses are discarded', function () {
  var R = fight(['mossRat'], ['strike', 'guard', 'dazed', 'wound', 'regret', 'ooze', 'clumsy', 'burn']);
  tough(R);
  var C = R.c, hp = C.p.hp;
  E.playCard(R, 0, 0);                 // play the Strike, keep the Guard
  var guardK = C.hand[0].k;
  endRound(R);
  assert.strictEqual(C.turn, 2);
  assert.strictEqual(C.hand[0].k, guardK, 'the guard is still in hand (first)');
  assert.strictEqual(C.hand[0].kept, 2, 'marked as held into turn 2');
  assert.ok(C.hand.slice(1).every(function (c) { return !c.kept; }), 'fresh draws are not marked');
  assert.deepStrictEqual(ids(C.exh).sort(), ['clumsy', 'dazed'], 'ethereal cards exhausted');
  ['wound', 'regret', 'ooze', 'burn', 'strike'].forEach(function (id) { assert.ok(ids(C.disc).indexOf(id) >= 0, id + ' discarded'); });
  // Regret counted the cards in hand at the end of the turn (7), Burn dealt 2
  assert.ok(C.p.hp <= hp - 7 - 2, 'regret + burn hurt');
});

test('retention: the draw tops the hand up to 5 but always draws at least 2', function () {
  var R = fight(['mossRat'], null);
  tough(R);
  var C = R.c;
  assert.strictEqual(C.hand.length, 5, 'turn 1 draws 5');
  assert.strictEqual(E.RULES.first, 5); assert.strictEqual(E.RULES.to, 5); assert.strictEqual(E.RULES.min, 2);
  // hold everything: 5 held -> draw 2
  endRound(R);
  assert.strictEqual(C.hand.length, 7, '5 held + 2 drawn');
  assert.strictEqual(C.hand.filter(function (c) { return c.kept === C.turn; }).length, 5);
  // play down to 1 card: next turn draws 4
  C.en = 99;
  while (C.hand.length > 1) { var i = C.hand.findIndex(function (c) { return !E.whyNot(R, c); }); if (i < 0) break; E.playCard(R, i, 0); }
  var held = C.hand.length;
  endRound(R);
  assert.strictEqual(C.hand.length, Math.max(held + 2, 5));
  // relics / powers add to the draw
  R.relics.push('deepPockets'); C.p.st.drawP = 1;
  C.hand = []; assert.strictEqual(E.drawCount(R), 5 + 2);
  C.hand = [{ id: 'strike', u: 0, k: 1 }, { id: 'strike', u: 0, k: 2 }, { id: 'strike', u: 0, k: 3 }, { id: 'strike', u: 0, k: 4 }];
  assert.strictEqual(E.drawCount(R), 2 + 2);
});

test('retention: the hand never holds more than 10; extra draws stay in the draw pile', function () {
  var R = fight(['mossRat'], ['guard', 'guard', 'guard', 'guard', 'guard', 'guard', 'guard', 'guard', 'guard', 'rummage']);
  tough(R);
  var C = R.c, pile = C.draw.length;
  assert.strictEqual(E.playCard(R, 9), '');   // Rummage: draw 2 from a hand of 9 -> 1 drawn, then full
  assert.strictEqual(C.hand.length, E.MAX_HAND);
  assert.strictEqual(C.draw.length, pile - 1, 'only one card left the draw pile');
  assert.strictEqual(C.full, C.turn);
  assert.ok(C.log.some(function (x) { return x.k === 'full'; }), 'logged for the UI');
  endRound(R);
  assert.strictEqual(C.hand.length, E.MAX_HAND, 'held ten, drew none');
  assert.strictEqual(C.draw.length, pile - 1, 'turn-start draws stay in the pile');
  // random legal play never breaks the cap
  for (var s = 1; s <= 12; s++) {
    var R2 = E.newRun(s), x = s;
    E.startFight(R2, 'fight', ['caveSlug']); tough(R2);
    for (var t = 0; t < 30; t++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      if (x % 4 === 0) { var pl = R2.c.hand.findIndex(function (c) { return !E.whyNot(R2, c); }); if (pl >= 0) E.playCard(R2, pl, 0); }
      endRound(R2);
      assert.ok(R2.c.hand.length <= E.MAX_HAND);
    }
  }
});

test('hidden intents never leak through intentOf / incoming, but the engine plays the real move', function () {
  var R = fight(['cutpurse', 'inkEel', 'mossRat'], []);
  var C = R.c, cp = C.e[0], eel = C.e[1], rat = C.e[2];
  cp.mv = 0; eel.mv = 0; rat.mv = 0;   // Stab 8, Lash 7x2, Bite 6
  var a = E.intentOf(R, cp), b = E.intentOf(R, eel), c = E.intentOf(R, rat);
  assert.strictEqual(a.hide, 'amount'); assert.ok(a.atk); assert.strictEqual(a.dmg, null); assert.strictEqual(a.hits, null); assert.strictEqual(a.n, '?');
  assert.strictEqual(b.hide, 'all'); assert.strictEqual(b.n, '?');
  ['atk', 'def', 'buf', 'dbf', 'heal', 'add'].forEach(function (k) { assert.strictEqual(b[k], false, 'all-hidden ' + k); });
  assert.ok(!/Stab|Lash|Ink/.test(JSON.stringify([a, b])), 'no move names');
  assert.strictEqual(c.hide, ''); assert.strictEqual(c.dmg, 6);
  assert.strictEqual(E.incoming(R), 6, 'only the visible attack counts');
  assert.deepStrictEqual(E.incomingInfo(R), { dmg: 6, unknown: 2 });
  // the engine still knows
  assert.strictEqual(E.realIntent(R, cp).dmg, 8);
  assert.strictEqual(E.realIntent(R, eel).hits, 2);
  C.p.hp = C.p.mhp = 200; C.p.blk = 0;
  E.endTurn(R); while (E.enemyStep(R));
  assert.strictEqual(C.p.hp, 200 - 8 - 14 - 6, 'hidden moves really happened');
  // the text for a tapped enemy is built from intentOf only; cardText never reveals either
  assert.ok(Object.keys(E.ENEMIES).filter(function (id) { return E.ENEMIES[id].hide; }).length >= 6, 'hidden enemies across the acts');
});

test('every act has hidden and changing enemies; elites/bosses included', function () {
  [1, 2, 3].forEach(function (act) {
    var pool = [];
    ['weak', 'strong', 'elite'].forEach(function (k) { E.ENC[act][k].forEach(function (enc) { pool = pool.concat(enc); }); });
    pool.push(E.ENC[act].boss[0]);
    assert.ok(pool.some(function (id) { return E.ENEMIES[id].hide; }), 'act ' + act + ' hides');
    assert.ok(pool.some(function (id) { return E.ENEMIES[id].react; }), 'act ' + act + ' reacts');
    assert.ok(E.ENEMIES[E.ENC[act].boss[0]].react.low != null, 'boss phase change');
  });
  assert.ok(Object.keys(E.ENEMIES).some(function (id) { var d = E.ENEMIES[id]; return (d.elite || d.boss) && (d.hide || (d.react && d.react.hideLow)); }));
  Object.keys(E.ENEMIES).forEach(function (id) {
    var d = E.ENEMIES[id];
    if (d.hide) assert.ok(d.hide === 'all' || d.hide === 'amount', id);
    if (d.react) ['low', 'dbf'].forEach(function (k) { if (d.react[k] != null) assert.ok(d.react[k] >= 0 && d.react[k] < d.m.length, id + ' ' + k); });
  });
});

test('changing intents: dropping under half HP switches the plan at once (and only once)', function () {
  var R = fight(['thornBeetle'], ['heavyBlow', 'strike', 'strike']);
  var C = R.c, e = C.e[0];
  C.p.hp = C.p.mhp = 999;
  e.hp = e.mhp = 40; e.mv = 1;          // Ram
  E.playCard(R, 1, 0);                  // 6: 34 left, still over half
  assert.strictEqual(e.mv, 1);
  assert.ok(!E.intentOf(R, e).chg);
  C.en = 3;
  E.playCard(R, 0, 0);                  // heavy blow 14: 20 left -> not under half yet (20 = 50%)
  assert.strictEqual(e.mv, 1);
  E.playCard(R, 0, 0);                  // 14 left: under half -> Harden
  assert.strictEqual(e.mv, E.ENEMIES.thornBeetle.react.low);
  assert.ok(E.intentOf(R, e).chg, 'flagged as changed for the UI');
  assert.ok(C.log.some(function (x) { return x.k === 'intent' && x.t === 0; }));
  assert.ok(e.halfUsed);
  E.endTurn(R); while (E.enemyStep(R));
  assert.ok(e.blk > 0, 'it really hardened');
  e.mv = 1; C.hand = [{ id: 'strike', u: 0, k: 990 }]; C.en = 1;
  E.playCard(R, 0, 0);
  assert.strictEqual(e.mv, 1, 'no second reaction');
});

test('changing intents: Weak / Vulnerable make some enemies switch, once per turn', function () {
  var R = fight(['bonePup'], ['hamstring', 'expose', 'lunge']);
  var C = R.c, e = C.e[0];
  tough(R); C.en = 9;
  e.mv = 0;                              // Snap
  E.playCard(R, 0, 0);                   // Hamstring: Weak -> Howl
  assert.strictEqual(e.mv, E.ENEMIES.bonePup.react.dbf);
  e.mv = 0;
  E.playCard(R, 0, 0);                   // Expose: already reacted this turn
  assert.strictEqual(e.mv, 0);
  endRound(R);
  e.mv = 0; C.en = 9;
  C.hand.push({ id: 'expose', u: 0, k: 991 });
  E.playCard(R, C.hand.length - 1, 0);
  assert.strictEqual(e.mv, 1, 'reacts again on a later turn');
  // an enemy without a debuff reaction ignores it
  var R2 = fight(['mossRat'], ['expose']); R2.c.e[0].mv = 0; E.playCard(R2, 0, 0); assert.strictEqual(R2.c.e[0].mv, 0);
});

test('changing intents: a reaction during its own turn (thorns) becomes its next move; bosses change phase', function () {
  var R = fight(['graveColossus'], []);
  var C = R.c, e = C.e[0];
  C.p.hp = C.p.mhp = 999; C.p.st.thorns = 30;
  e.hp = e.mhp = 100; e.mv = 0; e.hist = [0]; // Quake (one hit): the thorns drop it to 70%, not under half
  E.endTurn(R); while (E.enemyStep(R));
  assert.ok(!e.halfUsed);
  e.hp = 60; e.mv = 0; e.hist = [0]; e.cy = 1; // next cycle step would be Rest (1)
  E.endTurn(R); while (E.enemyStep(R));
  assert.ok(e.halfUsed, 'thorns pushed it under half while it attacked');
  assert.strictEqual(e.mv, E.ENEMIES.graveColossus.react.low, 'it keeps the new plan for its next turn');
  // the Hollow Monarch hides its numbers in its second phase
  var M = fight(['hollowMonarch'], ['cataclysm']);
  var m = M.c.e[0];
  M.c.p.hp = M.c.p.mhp = 999; m.hp = Math.floor(m.mhp / 2) + 20; m.mv = 1; M.c.en = 3;
  assert.strictEqual(E.intentOf(M, m).hide, '');
  E.playCard(M, 0, 0);
  assert.strictEqual(m.mv, E.ENEMIES.hollowMonarch.react.low);
  assert.strictEqual(m.hide, 'amount');
  assert.strictEqual(E.intentOf(M, m).hide, 'amount');
});

test('scouting: Scout reveals this turn only; Foresight for the fight; Spyglass on turn 1 and every 3rd', function () {
  var R = fight(['inkEel', 'cutpurse'], ['scout', 'foresight']);
  var C = R.c;
  tough(R);
  assert.strictEqual(E.intentOf(R, C.e[0]).hide, 'all');
  var n = C.hand.length;
  E.playCard(R, 0);
  assert.strictEqual(E.intentOf(R, C.e[0]).hide, '');
  assert.strictEqual(E.intentOf(R, C.e[1]).hide, '');
  assert.ok(E.intentOf(R, C.e[1]).dmg != null);
  assert.strictEqual(C.hand.length, n, 'played one, drew one');
  assert.strictEqual(E.incomingInfo(R).unknown, 0);
  endRound(R);
  assert.strictEqual(E.intentOf(R, C.e[0]).hide, 'all', 'hidden again next turn');
  C.en = 3;
  E.playCard(R, C.hand.findIndex(function (c) { return c.id === 'foresight'; }));
  endRound(R); endRound(R);
  assert.strictEqual(E.intentOf(R, C.e[0]).hide, '', 'foresight lasts');
  var S = fight(['inkEel'], null, { relics: ['spyglass'] });
  S.relics = ['spyglass']; E.startFight(S, 'fight', ['inkEel']); tough(S);
  var seen = [];
  for (var t = 1; t <= 6; t++) { seen.push(E.intentOf(S, S.c.e[0]).hide === '' ? 1 : 0); endRound(S); }
  assert.deepStrictEqual(seen, [1, 0, 1, 0, 0, 1]);
});

test('Counterplay blocks a (hidden) attack, capped; otherwise it draws; Bide counts your hand', function () {
  var R = fight(['cutpurse'], ['counterplay', 'counterplay', 'strike', 'strike', 'strike']);
  var C = R.c, e = C.e[0];
  tough(R);
  e.mv = 0; e.st.str = 2;               // Stab 8 + 2, hidden amount
  E.playCard(R, 0, 0);
  assert.strictEqual(C.p.blk, 10);
  assert.strictEqual(E.intentOf(R, e).hide, '', 'it also reveals that enemy');
  e.st.str = 40;
  E.playCard(R, 0, 0);
  assert.strictEqual(C.p.blk, 10 + 14, 'capped');
  var R2 = fight(['cutpurse'], ['counterplay']);
  R2.c.e[0].mv = 1;                      // Feint: no attack
  var n = R2.c.hand.length;
  E.playCard(R2, 0, 0);
  assert.strictEqual(R2.c.hand.length, n - 1 + 2);
  var B = fight(['mossRat'], ['bide', 'strike', 'strike', 'strike', 'guard']);
  E.playCard(B, 0);
  assert.strictEqual(B.c.p.blk, 8, '2 per other card (4)');
  var BT = fight(['mossRat'], ['bide', 'strike', 'strike', 'strike', 'guard']);
  assert.ok(/^Gain 8 Block/.test(E.cardText(BT.c.hand[0], { R: BT })), 'live text counts the other cards');
  assert.ok(/per other card/.test(E.cardText({ id: 'bide', u: 0 })));
  ['scout', 'foresight', 'counterplay', 'bide'].forEach(function (id) { assert.ok(E.POOL[E.CARDS[id].r].indexOf(id) >= 0, id + ' in the reward/shop pool'); });
  assert.strictEqual(E.RELICS.spyglass.r, 'uncommon');
});

test('Blindfold: every intent of every enemy is hidden all run; scouting still works; daily is never blind', function () {
  var R = E.newRun(4242, { blind: true });
  assert.ok(R.blind);
  Object.keys(E.ENEMIES).forEach(function (id) {
    E.startFight(R, 'fight', [id]);
    var e = R.c.e[0], o = E.intentOf(R, e);
    assert.strictEqual(o.hide, 'all', id);
    assert.strictEqual(E.incoming(R), 0);
    R.c.scout = R.c.turn;
    assert.strictEqual(E.intentOf(R, e).hide, '', id + ' scouted');
  });
  assert.ok(!E.newRun(1, { blind: true, daily: '2026-11-02' }).blind, 'daily runs stay normal');
  // a whole blindfolded run plays out and is deterministic
  var a = E.newRun(99, { blind: true }), b = E.newRun(99, { blind: true });
  E.autoRun(a, function () { return 0; }, 6000); E.autoRun(b, function () { return 0; }, 6000);
  assert.ok(a.over);
  assert.strictEqual(a.floor, b.floor); assert.strictEqual(a.hp, b.hp); assert.deepStrictEqual(ids(a.deck), ids(b.deck));
  assert.ok(E.normRun(JSON.parse(JSON.stringify(E.newRun(5, { blind: true })))).blind, 'saved with the run');
});

test('Blindfold scores more and keeps separate records and history tags', function () {
  var A = walk(777), B = E.newRun(777, { blind: true });
  B.floor = A.floor; B.stats = JSON.parse(JSON.stringify(A.stats)); B.won = A.won; B.hp = A.hp; B.mhp = A.mhp; B.over = true; B.killedBy = 'x';
  assert.strictEqual(E.score(B), Math.round(E.score(A) * E.BLIND_BONUS));
  var s = E.newStats();
  E.recordRun(s, A, 1); E.recordRun(s, B, 2);
  assert.strictEqual(s.runs, 1, 'normal records exclude blindfold runs');
  assert.strictEqual(s.blind.runs, 1);
  assert.strictEqual(s.blind.bestScore, E.score(B));
  assert.strictEqual(s.bestScore, E.score(A));
  assert.ok(s.hist[0].blind && !s.hist[1].blind);
  var back = E.normStats(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(back, s);
  // stats saved before Blindfold existed
  var old = E.normStats({ runs: 3, wins: 1, hist: [{ seed: 1, floor: 4, act: 1, score: 30 }] });
  assert.deepStrictEqual(old.blind, { runs: 0, wins: 0, bestFloor: 0, bestScore: 0, streak: 0, bestStreak: 0 });
  assert.strictEqual(old.hist[0].blind, false);
});

test('saves from before this update (v1) load mid-fight and carry on', function () {
  var R = E.newRun(2024);
  E.startFight(R, 'fight', ['cutpurse', 'bonePup']);
  var old = JSON.parse(JSON.stringify(R));
  // strip everything v2 added
  old.v = 1; delete old.blind;
  delete old.c.scout; delete old.c.full;
  old.c.e.forEach(function (e) { delete e.hide; delete e.rt; delete e.acted; delete e.held; delete e.chg; });
  old.c.hand.forEach(function (c) { delete c.kept; });
  var N = E.normRun(old);
  assert.ok(N, 'v1 save accepted');
  assert.strictEqual(N.v, E.VERSION);
  assert.strictEqual(N.blind, false);
  assert.strictEqual(N.c.e[0].hide, 'amount', 'hidden-ness restored from the enemy');
  assert.strictEqual(N.c.scout, 0);
  assert.strictEqual(E.intentOf(N, N.c.e[0]).hide, 'amount');
  N.c.p.hp = N.c.p.mhp = 999;
  endRound(N); endRound(N);
  assert.strictEqual(N.c.turn, 3);
  E.autoRun(N, function () { return 0; }, 3000);
  assert.ok(N.over || N.floor > 1);
  // a v1 save between fights
  var M = JSON.parse(JSON.stringify(E.newRun(5))); M.v = 1; delete M.blind;
  assert.ok(E.normRun(M));
  // junk in the new fields is cleaned
  var J = JSON.parse(JSON.stringify(R)); J.c.e[0].hide = '<script>'; J.c.scout = 'x'; J.blind = 'yes'; J.daily = '2026-01-01';
  J = E.normRun(J);
  assert.strictEqual(J.c.e[0].hide, 'amount'); assert.strictEqual(J.c.scout, 0); assert.strictEqual(J.blind, false);
});

test('determinism: the same seed plays out the same with the new rules (fights, reactions, hidden moves)', function () {
  function trace(seed, blind) {
    var R = E.newRun(seed, { blind: blind }), out = [];
    E.autoRun(R, function (n) { return n - 1; }, 5000);
    out.push(R.floor, R.hp, R.gold, R.stats.turns, R.stats.played, ids(R.deck).join());
    return JSON.stringify(out);
  }
  [3, 77, 4096].forEach(function (s) {
    assert.strictEqual(trace(s, false), trace(s, false));
    assert.strictEqual(trace(s, true), trace(s, true));
  });
  var A = E.newRun(31), B = E.newRun(31);
  E.chooseNode(A, E.nextNodes(A)[0]); E.chooseNode(B, E.nextNodes(B)[0]);
  assert.deepStrictEqual(ids(A.c.hand), ids(B.c.hand));
});

console.log(passed + ' passed');
