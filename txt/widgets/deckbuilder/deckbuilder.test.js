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

test('boss uses its half-health move once', function () {
  var R = fight(['rootmaw'], []);
  var e = R.c.e[0];
  R.c.p.hp = R.c.p.mhp = 9999;
  e.hp = Math.floor(e.mhp / 2) - 1;
  E.endTurn(R); while (E.enemyStep(R));
  assert.strictEqual(e.mv, E.ENEMIES.rootmaw.ai.half);
  E.endTurn(R); while (E.enemyStep(R));
  assert.notStrictEqual(e.mv, E.ENEMIES.rootmaw.ai.half);
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
  [null, 5, 'x', {}, { v: 1 }, { v: 99, deck: [] }].forEach(function (j) { assert.strictEqual(E.normRun(j), null); });
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

console.log(passed + ' passed');
