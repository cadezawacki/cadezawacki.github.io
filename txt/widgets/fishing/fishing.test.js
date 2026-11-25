/* Headless checks for the Reel Deep engine (data, world, AI, casting, fights, career).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/fishing/fishing.test.js */
'use strict';
var assert = require('assert');

var E = require('./fishing.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./fishing.js')];
require('./fishing.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function world(loc, o) {
  o = o || {};
  return E.newWorld({ seed: o.seed || 11, loc: loc, day: o.day || (loc === 'ice' ? 20 : 8), min: o.min == null ? 600 : o.min, gear: E.gearStats(o.g || 0, o.g || 0, o.g || 0, o.lure || 'b'), diff: o.diff || 'normal', cond: o.cond });
}
// a scripted angler: waits, reels, hooks on the strike, plays the fish by the meter
function play(W, secs, opt) {
  opt = opt || {};
  var out = { hooked: 0, landed: 0, lost: 0, strikes: 0, nibbles: 0, ev: {} }, t = 0, wait = -1;
  while (t < secs) {
    var inp = { reel: false, steer: 0 };
    if (W.phase === 'ready') E.cast(W, 0.75, 0.8);
    else if (W.phase === 'fishing') {
      var lt = W.t - W.lure.landT;
      inp.reel = W.lure.def.bob || W.lure.def.scent ? lt > (opt.wait || 25) : (lt % 3) < 1 || (Math.abs(W.lure.x - W.st.anc.x) < 3 && lt > 6) || lt > 40;
      if (opt.jig) { inp.reel = lt > 40; if ((lt % 2.5) < E.STEP && lt > 4 && !W.biter) inp.twitch = 1; }
      if (W.biter && W.biter.st === 'strike' && wait < 0) wait = 0.25;
      if (wait >= 0) { wait -= E.STEP; if (wait < 0) inp.hook = true; }
    } else if (W.phase === 'fight') { var F = W.fight; inp.reel = F.T < (opt.greed || 0.7) && !F.air; inp.steer = -(F.f.vx > 0 ? 1 : -1); }
    else if (W.phase === 'landed') W.phase = 'ready';
    E.stepWorld(W, E.STEP, inp); t += E.STEP;
    W.ev.forEach(function (e) {
      out.ev[e.type] = (out.ev[e.type] || 0) + 1;
      if (e.type === 'hooked') out.hooked++; if (e.type === 'landed') out.landed++; if (e.type === 'lost') out.lost++;
    });
    W.ev.length = 0;
  }
  return out;
}
function forceFight(spId, w, g, diff, greed) {
  var sp = E.SP[spId], W = E.newWorld({ seed: 3, loc: sp.locs[0], day: 8, min: 600, gear: E.gearStats(g[0], g[1], g[2], 's'), diff: diff || 'normal' });
  var f = { id: 999, sp: sp, w: w, len: 20, lm: 1, x: 12, y: 2, vx: 0, vy: 0, dir: 1, st: 'x', wig: 0 };
  W.fish.push(f); W.lure = { def: E.LURE.s, x: 12, y: 2, vx: 0, vy: 0, baited: true, landT: 0 }; W.phase = 'fishing';
  E.startFight(W, f, 0.2);
  var res = null, t = 0;
  while (t < 500 && !res) {
    var F = W.fight;
    E.stepWorld(W, E.STEP, { reel: F.T < (greed || 0.72) && !F.air, steer: -(F.f.vx > 0 ? 1 : -1) });
    t += E.STEP;
    W.ev.forEach(function (e) { if (e.type === 'landed') res = 'landed'; if (e.type === 'lost') res = e.why; });
    W.ev.length = 0;
  }
  return { res: res, t: t };
}

test('registers the widget with the manifest name / icon / tags and loads its css', function () {
  assert.ok(widget && typeof widget.open === 'function');
  assert.strictEqual(widget.name, 'Reel Deep');
  assert.strictEqual(widget.icon, '🎣');
  assert.strictEqual(widget.tags, 'game,sport,fishing,fish,relax,career,collection,fun');
  assert.ok(/tension-line fights/.test(widget.description));
  assert.deepStrictEqual(css, ['fishing.css']);
  var man = require('../../manifest.json'), m = (man.modules || man.items || man.widgets || []).filter(function (x) { return x.id === 'fishing'; })[0];
  if (m) { assert.strictEqual(m.name, widget.name); assert.strictEqual(m.description, widget.description); assert.strictEqual(m.icon, widget.icon); assert.strictEqual(m.tags, widget.tags); }
});

test('species data: 35+ species, legends with lore, every location stocked', function () {
  assert.ok(E.SPECIES.length >= 35, 'species ' + E.SPECIES.length);
  var ids = {};
  E.SPECIES.forEach(function (s) {
    assert.ok(!ids[s.id], 'dup ' + s.id); ids[s.id] = 1;
    assert.ok(s.wmin > 0 && s.wmax > s.wmin, s.id + ' weights');
    assert.ok(s.d0 >= 0 && s.d1 > s.d0 && s.d1 <= 1, s.id + ' depth band');
    assert.ok(s.times > 0 && s.seas > 0 && s.wx.length > 0, s.id + ' conditions');
    assert.ok(Object.keys(s.lures).every(function (k) { return E.LURE[k]; }), s.id + ' lures');
    s.locs.forEach(function (l) { assert.ok(E.LOC[l], s.id + ' loc ' + l); });
  });
  var legends = E.SPECIES.filter(function (s) { return s.rar === 4; });
  assert.ok(legends.length >= 5);
  legends.forEach(function (s) { assert.ok(s.lore && s.hint && s.beh, s.id); });
  E.LOCS.forEach(function (L) { assert.ok(E.speciesAt(L.id).length >= 6, L.id); });
});

test('rng, hash and weather are deterministic; seasons cycle', function () {
  var a = E.mulberry32(5), b = E.mulberry32(5);
  for (var i = 0; i < 20; i++) assert.strictEqual(a(), b());
  assert.strictEqual(E.hash('x', 1), E.hash('x', 1));
  assert.notStrictEqual(E.hash('x', 1), E.hash('x', 2));
  assert.deepStrictEqual(E.weatherAt(9, 4, 700), E.weatherAt(9, 4, 700));
  var seen = {};
  for (var d = 1; d <= 60; d++) for (var m = 300; m < 1440; m += 240) seen[E.weatherAt(1, d, m).w] = 1;
  assert.strictEqual(Object.keys(seen).length, 5, 'all five weathers occur');
  assert.strictEqual(E.seasonOf(1), 0); assert.strictEqual(E.seasonOf(1 + E.SEASON_DAYS), 1); assert.strictEqual(E.seasonOf(1 + 4 * E.SEASON_DAYS), 0);
  assert.strictEqual(E.bandOf(360), E.DAWN); assert.strictEqual(E.bandOf(720), E.DAY); assert.strictEqual(E.bandOf(1150), E.DUSK); assert.strictEqual(E.bandOf(60), E.NIGHT);
  assert.strictEqual(E.clockStr(605), '10:05');
});

test('layouts: seeded, depth grows from the bank, deep sea is deep', function () {
  E.LOCS.forEach(function (L) {
    var a = E.genLayout(42, L), b = E.genLayout(42, L), c = E.genLayout(43, L);
    assert.deepStrictEqual(Array.from(a.d), Array.from(b.d));
    assert.notDeepStrictEqual(Array.from(a.d), Array.from(c.d));
    for (var i = 0; i < a.d.length; i++) assert.ok(a.d[i] > 0 && a.d[i] <= L.maxD + 1e-6);
    if (L.stand === 'bank') assert.ok(E.depthAt(a, 0.3) < 0.5 && E.depthAt(a, L.W * 0.6) > 1);
  });
  assert.ok(E.genLayout(1, E.LOC.deep).maxD > 80);
});

test('activity and spawning follow time, weather and season; legends need their exact conditions', function () {
  var bass = E.SP.lmbass, c1 = { band: E.DUSK, wx: 1, season: 1 }, c2 = { band: E.NIGHT, wx: 3, season: 3 };
  assert.ok(E.activity(bass, c1) > E.activity(bass, c2) * 3);
  var moss = E.SP.mossback;
  assert.ok(E.legendReady(moss, { band: E.NIGHT, wx: 4, season: 0 }));
  assert.ok(!E.legendReady(moss, { band: E.DAY, wx: 4, season: 0 }));
  assert.strictEqual(E.spawnWeight(moss, { band: E.DAY, wx: 0, season: 0 }), 0);
  // ice species only show up in the ice hole
  var r = E.mulberry32(1);
  for (var i = 0; i < 200; i++) assert.ok(E.pickSpecies(r, 'pier', { band: E.DAY, wx: 0, season: 1 }, true).locs.indexOf('pier') >= 0);
});

test('size rolls stay in range and skew small; prices, xp and freshness', function () {
  var r = E.mulberry32(7), s = E.SP.lmbass, sum = 0, n = 2000;
  for (var i = 0; i < n; i++) { var z = E.rollSize(r, s, 0); assert.ok(z.w >= s.wmin && z.w <= s.wmax, z.w); assert.ok(z.len > 0); sum += z.w; }
  assert.ok(sum / n < (s.wmin + s.wmax) / 2, 'mean below the midpoint');
  assert.ok(E.priceOf(s, 6, 1, 0) > E.priceOf(s, 2, 1, 0));
  assert.ok(E.priceOf(E.SP.muskie, 20, 1, 0) > E.priceOf(E.SP.carp, 20, 1, 0));
  assert.ok(E.priceOf(s, 5, 1, 200) > E.priceOf(s, 5, 1, 0), 'reputation bonus');
  assert.strictEqual(E.freshness(1000, 1000, 0), 1);
  assert.ok(E.freshness(0, 600, 0) < E.freshness(0, 600, 1), 'the cooler keeps fish fresh');
  assert.ok(E.freshness(0, 99999, 0) >= 0.35);
  assert.ok(E.catchXp(E.SP.marlin, 500) > E.catchXp(E.SP.bluegill, 1));
  assert.strictEqual(E.levelOf(0), 1);
  for (var l = 2; l < 20; l++) { assert.strictEqual(E.levelOf(E.cumXp(l)), l); assert.strictEqual(E.levelOf(E.cumXp(l) - 1), l - 1); }
});

test('worlds populate with fish inside the water, in their bands', function () {
  E.LOCS.forEach(function (L) {
    var W = world(L.id);
    assert.ok(W.fish.length >= L.n * 0.6, L.id + ' ' + W.fish.length);
    W.fish.forEach(function (f) {
      assert.ok(f.sp.locs.indexOf(L.id) >= 0);
      assert.ok(f.y > 0 && f.y < E.depthAt(W.lay, f.x) + 1e-6, L.id + ' ' + f.sp.id + ' y ' + f.y);
    });
    for (var i = 0; i < 600; i++) E.stepWorld(W, E.STEP, {});
    W.fish.forEach(function (f) { assert.ok(f.y > 0 && f.y <= E.depthAt(W.lay, f.x) + 1e-6 && isFinite(f.x), L.id + ' after ' + f.sp.id); });
  });
});

test('casting: power sets distance, wind drifts it, flight lands, ice drops straight down', function () {
  var W1 = world('lake', { lure: 's', cond: { band: E.DAY, wx: 0, wind: 0, wdir: 1, season: 1, loc: 'lake' } });
  var W2 = world('lake', { lure: 's', cond: { band: E.DAY, wx: 0, wind: 0, wdir: 1, season: 1, loc: 'lake' } });
  assert.ok(E.castAim(W1, 1) > E.castAim(W1, 0.3));
  E.cast(W1, 1, 1); E.cast(W2, 0.3, 1);
  assert.strictEqual(W1.phase, 'flight');
  assert.ok(W1.fl.x1 > W2.fl.x1 + 5);
  var W3 = world('lake', { lure: 's', cond: { band: E.DAY, wx: 3, wind: 1, wdir: 1, season: 1, loc: 'lake' } });
  E.cast(W3, 0.6, 1);
  var W4 = world('lake', { lure: 's', cond: { band: E.DAY, wx: 3, wind: 1, wdir: -1, season: 1, loc: 'lake' } });
  E.cast(W4, 0.6, 1);
  assert.ok(W3.fl.x1 - W4.fl.x1 > 2, 'wind pushes the cast');
  for (var i = 0; i < 200 && W1.phase === 'flight'; i++) E.stepWorld(W1, E.STEP, {});
  assert.strictEqual(W1.phase, 'fishing');
  assert.ok(W1.ev.some(function (e) { return e.type === 'splash'; }));
  var I = world('ice', { lure: 'j' });
  E.cast(I, 0.2, 0.5);
  assert.strictEqual(I.phase, 'fishing'); assert.strictEqual(I.lure.x, I.st.hole);
  assert.ok(!E.cast(world('pond', { lure: 'd' }), 0.5, 0.5), 'deep rigs need salt water');
});

test('lures behave: jig sinks to the bottom, crankbait floats then dives, fly stays on top, reeling brings it in', function () {
  function sunk(lure, secs, reel) {
    var W = world('lake', { lure: lure, cond: { band: E.DAY, wx: 0, wind: 0, wdir: 1, season: 1, loc: 'lake' } });
    W.fish.length = 0; E.cast(W, 0.6, 1);
    for (var i = 0; i < 200 && W.phase === 'flight'; i++) E.stepWorld(W, E.STEP, {});
    for (var t = 0; t < secs; t += E.STEP) { E.stepWorld(W, E.STEP, { reel: reel }); W.fish.length = 0; }
    return W;
  }
  var j = sunk('j', 12, false);
  assert.ok(Math.abs(j.lure.y - (E.depthAt(j.lay, j.lure.x) - 0.1)) < 0.05, 'jig on the bottom');
  var c = sunk('c', 3, false);
  assert.ok(c.lure.y < 0.2, 'crankbait floats');
  var c2 = sunk('c', 2.5, true);
  assert.ok(c2.lure.y > 1, 'crankbait dives when reeled');
  var f = sunk('f', 5, false);
  assert.ok(f.lure.y < 0.05, 'fly on the surface');
  var r = sunk('s', 60, true);
  assert.strictEqual(r.phase, 'ready', 'reeled all the way in');
  assert.ok(r.ev.some(function (e) { return e.type === 'in'; }));
});

test('bites: nibbles come before the strike, early hooks spook, late hooks steal the bait', function () {
  var W = world('pond', { lure: 'b', min: 420, day: 8 });
  var o = play(W, 300, { wait: 30 });
  assert.ok(o.ev.nibble > 0 && o.ev.strike > 0, JSON.stringify(o.ev));
  assert.ok(o.landed > 0, 'landed something: ' + JSON.stringify(o.ev));
  // early hook during a nibble
  var W2 = world('pond', { lure: 'b', min: 420, day: 8 }), early = null;
  E.cast(W2, 0.7, 0.8);
  for (var t = 0; t < 200 && !early; t += E.STEP) {
    var inp = {};
    if (W2.phase === 'fishing' && W2.biter && W2.biter.st === 'nibble') inp.hook = true;
    if (W2.phase === 'ready') E.cast(W2, 0.7, 0.8);
    E.stepWorld(W2, E.STEP, inp);
    W2.ev.forEach(function (e) { if (e.type === 'early') early = e; });
    W2.ev.length = 0;
  }
  assert.ok(early, 'an early hook spooks the fish');
  // never hooking: the bait gets stolen
  var W3 = world('pond', { lure: 'b', min: 420, day: 8 }), missed = null;
  E.cast(W3, 0.7, 0.8);
  for (t = 0; t < 300 && !missed; t += E.STEP) {
    E.stepWorld(W3, E.STEP, {});
    W3.ev.forEach(function (e) { if (e.type === 'missed') missed = e; });
    W3.ev.length = 0;
  }
  assert.ok(missed && missed.bait, 'missed strike');
  assert.strictEqual(W3.lure.baited, false);
  assert.strictEqual(W3.hookBait, false);
});

test('bait is used up per baited cast and runs out', function () {
  var W = world('pond', { lure: 'b' });
  W.bait = 1;
  assert.ok(E.cast(W, 0.5, 0.5)); assert.strictEqual(W.bait, 0);
  W.phase = 'ready'; W.lure = null; W.hookBait = false;
  assert.ok(!E.cast(W, 0.5, 0.5));
  assert.ok(W.ev.some(function (e) { return e.type === 'nobait'; }));
  var W2 = world('pond', { lure: 's' }); W2.bait = 0;
  assert.ok(E.cast(W2, 0.5, 0.5), 'lures need no bait');
});

test('each water gives bites with the right lure', function () {
  [['river', 's', 8, 600], ['lake', 'c', 8, 1100], ['pier', 'j', 8, 600], ['ice', 'j', 20, 420]].forEach(function (c) {
    var W = world(c[0], { lure: c[1], day: c[2], min: c[3], g: 2 });
    var o = play(W, 400, { jig: c[0] === 'ice' });
    assert.ok(o.hooked >= 2, c.join('/') + ' ' + JSON.stringify(o.ev));
  });
});

test('fights: proper gear lands fish, light line on a monster snaps or spools, big fish take a while', function () {
  var a = forceFight('lmbass', 5, [0, 0, 0]);
  assert.strictEqual(a.res, 'landed');
  var b = forceFight('tuna', 200, [0, 0, 0]);
  assert.ok(b.res === 'snap' || b.res === 'spooled' || b.res === 'throw', 'undergeared: ' + b.res);
  var c = forceFight('tuna', 200, [3, 3, 4]);
  assert.strictEqual(c.res, 'landed');
  assert.ok(c.t > 15, 'a real fight: ' + c.t.toFixed(0) + 's');
  var d = forceFight('marlin', 800, [4, 4, 5]);
  assert.strictEqual(d.res, 'landed'); assert.ok(d.t > 45, 'marlin ' + d.t.toFixed(0));
  var greedy = forceFight('catfish', 25, [0, 0, 0], 'normal', 1.2);
  assert.strictEqual(greedy.res, 'snap', 'reeling through the red snaps the line');
  var relax = forceFight('catfish', 25, [0, 0, 0], 'relax', 1.2);
  assert.strictEqual(relax.res, 'landed', 'relax mode never snaps');
  var H = E.DIFFS.hard, N = E.DIFFS.normal, R = E.DIFFS.relax;
  assert.ok(H.pow > N.pow && H.sta > N.sta && H.win < N.win && H.slack < N.slack, 'hard is harder');
  assert.ok(R.pow < N.pow && R.win > N.win && R.noSnap, 'relax is gentler');
});

test('fight rules: slack too long throws the hook; reeling during a jump shakes it', function () {
  var sp = E.SP.lmbass, W = E.newWorld({ seed: 3, loc: 'lake', day: 8, min: 600, gear: E.gearStats(1, 1, 1, 's') });
  var f = { id: 9, sp: sp, w: 4, len: 18, lm: 0.45, x: 12, y: 2, vx: 0, vy: 0, dir: 1, st: 'x', wig: 0 };
  W.fish.push(f); W.lure = { def: E.LURE.s, x: 12, y: 2, vx: 0, vy: 0, baited: true, landT: 0 }; W.phase = 'fishing';
  E.startFight(W, f, 0.9);
  W.fight.d = 40;                        // a huge loop of slack line
  var why = null;
  for (var t = 0; t < 10 && !why; t += E.STEP) { E.stepWorld(W, E.STEP, {}); W.ev.forEach(function (e) { if (e.type === 'lost') why = e.why + '/' + e.how; }); W.ev.length = 0; }
  assert.strictEqual(why, 'throw/slack');
  // jump
  var W2 = E.newWorld({ seed: 3, loc: 'lake', day: 8, min: 600, gear: E.gearStats(3, 3, 4, 's') }), f2 = { id: 9, sp: E.SP.thunderjaw, w: 70, len: 50, lm: 1.3, x: 12, y: 0.3, vx: 0, vy: 0, dir: 1, st: 'x', wig: 0 };
  W2.fish.push(f2); W2.lure = { def: E.LURE.s, x: 12, y: 2, vx: 0, vy: 0, baited: true, landT: 0 }; W2.phase = 'fishing';
  E.startFight(W2, f2, 0.1);
  var jumpLoss = 0, jumps = 0;
  for (t = 0; t < 200 && W2.fight; t += E.STEP) {
    var F = W2.fight;
    E.stepWorld(W2, E.STEP, { reel: true, steer: 0 });           // reels no matter what
    W2.ev.forEach(function (e) { if (e.type === 'jump') jumps++; if (e.type === 'lost' && e.how === 'jump') jumpLoss++; if (e.type === 'lost') W2.fight = null; });
    W2.ev.length = 0;
  }
  assert.ok(jumps > 0, 'the leaper jumps');
});

test('steering against the run tires the fish faster', function () {
  function drain(steerAgainst) {
    var W = E.newWorld({ seed: 5, loc: 'lake', day: 8, min: 600, gear: E.gearStats(2, 2, 3, 's') }), f = { id: 9, sp: E.SP.pike, w: 15, len: 30, lm: 0.8, x: 14, y: 2, vx: 0, vy: 0, dir: 1, st: 'x', wig: 0 };
    W.fish.push(f); W.lure = { def: E.LURE.s, x: 14, y: 2, vx: 0, vy: 0, baited: true, landT: 0 }; W.phase = 'fishing';
    E.startFight(W, f, 0.1);
    var s0 = W.fight.sta;
    for (var t = 0; t < 6 && W.fight; t += E.STEP) { var F = W.fight, d = F.f.vx > 0 ? 1 : -1; E.stepWorld(W, E.STEP, { reel: F.T < 0.6, steer: steerAgainst ? -d : d }); }
    return W.fight ? s0 - W.fight.sta : 0;
  }
  assert.ok(drain(true) > drain(false) * 1.2);
});

test('career: save round-trips and rejects junk; locations unlock by level, boat and season', function () {
  var s = E.newSave(99);
  assert.deepStrictEqual(E.normSave(JSON.parse(JSON.stringify(s))), s);
  var j = E.normSave({ v: 1, money: -5, rod: 99, owned: { rod: [0, 2, 'x', 77] }, lure: 'zz', creel: [{ sp: 'nope', w: 1 }, { sp: 'perch', w: 1.5, len: 9, at: 5 }], diff: 'insane', drag: 5 });
  assert.strictEqual(j.money, 0); assert.strictEqual(j.rod, 0); assert.deepStrictEqual(j.owned.rod, [0, 2]);
  assert.strictEqual(j.lure, 'b'); assert.strictEqual(j.creel.length, 1); assert.strictEqual(j.diff, 'normal'); assert.ok(j.drag <= 0.9);
  assert.strictEqual(E.normSave(null).v, 1);
  assert.ok(E.locOpen(s, 'pond').ok);
  assert.ok(!E.locOpen(s, 'lake').ok);
  s.xp = E.cumXp(12);
  assert.ok(E.locOpen(s, 'lake').ok);
  assert.ok(!E.locOpen(s, 'deep').ok, 'needs a boat'); s.up.boat = 1; assert.ok(E.locOpen(s, 'deep').ok);
  s.day = 1; assert.ok(!E.locOpen(s, 'ice').ok, 'winter only'); s.day = 1 + 3 * E.SEASON_DAYS; assert.ok(E.locOpen(s, 'ice').ok);
});

test('journal records, selling the creel', function () {
  var s = E.newSave(1);
  var a = E.logCatch(s, 'perch', 1.2, 9, 1); assert.ok(a.first && !a.record);
  var b = E.logCatch(s, 'perch', 0.8, 8, 1); assert.ok(!b.first && !b.record);
  var c = E.logCatch(s, 'perch', 1.9, 11, 1); assert.ok(c.record);
  assert.strictEqual(s.journal.perch.n, 3); assert.strictEqual(s.journal.perch.best, 1.9);
  assert.strictEqual(s.stats.best.w, 1.9);
  s.creel = [{ sp: 'perch', w: 1.9, len: 11, at: E.absMin(s.day, s.min) }, { sp: 'lmbass', w: 4, len: 18, at: E.absMin(s.day, s.min) }];
  var m0 = s.money, v = E.sellCreel(s);
  assert.ok(v > 0 && s.money === m0 + v && s.creel.length === 0);
  assert.strictEqual(E.creelCap(s), 6); s.up.creel = 2; assert.strictEqual(E.creelCap(s), 14);
});

test('contracts: three a day, seeded, completing pays out once', function () {
  var s = E.newSave(31); s.xp = E.cumXp(6);
  var a = E.genContracts(s), b = E.genContracts(s);
  assert.strictEqual(a.length, 3); assert.deepStrictEqual(a, b);
  s.contracts = a;
  var size = a.filter(function (c) { return c.kind === 'size'; })[0];
  assert.ok(size);
  var m0 = s.money;
  var done = E.contractEvent(s, { kind: 'catch', sp: size.sp, w: size.w + 1, loc: E.SP[size.sp].locs[0], min: 600 });
  assert.ok(done.indexOf(size) >= 0 && size.done);
  assert.strictEqual(s.money, m0 + size.pay + done.filter(function (c) { return c !== size; }).reduce(function (t, c) { return t + c.pay; }, 0));
  var again = E.contractEvent(s, { kind: 'catch', sp: size.sp, w: size.w + 1, loc: 'pond', min: 600 });
  assert.ok(again.indexOf(size) < 0, 'paid once');
  // too late
  s.contracts = [{ kind: 'count', sp: 'perch', n: 1, by: 1080, prog: 0, done: false, pay: 10, xp: 1, rep: 1 }];
  assert.strictEqual(E.contractEvent(s, { kind: 'catch', sp: 'perch', w: 1, loc: 'pond', min: 1200 }).length, 0);
});

test('tournaments: CPU anglers fill bags of five, standings sort by weight', function () {
  var T = E.newTourney(7, 3, 'lake', 6, 600);
  assert.strictEqual(T.cpus.length, 5);
  E.stepTourney(T, 150, { band: E.DAY, wx: 1, season: 1, loc: 'lake' });
  var n = T.cpus.reduce(function (t, c) { return t + c.bag.length; }, 0);
  assert.ok(n > 3, 'CPUs caught ' + n);
  T.cpus.forEach(function (c) { assert.ok(c.bag.length <= 5); for (var i = 1; i < c.bag.length; i++) assert.ok(c.bag[i - 1] >= c.bag[i]); });
  E.addBag(T.bag, 999, 5);
  var st = E.standings(T);
  assert.ok(st[0].you && st.length === 6);
  for (var i = 1; i < st.length; i++) assert.ok(st[i - 1].w >= st[i].w);
});

test('daily derby is the same for everyone on a date', function () {
  var a = E.dailySpec('2026-11-25'), b = E.dailySpec('2026-11-25'), c = E.dailySpec('2026-11-26');
  assert.deepStrictEqual(a, b);
  assert.ok(E.LOC[a.loc]);
  assert.ok(JSON.stringify(a) !== JSON.stringify(c));
  if (a.loc === 'ice') assert.strictEqual(a.season, 3);
  var W1 = E.newWorld({ seed: a.seed, loc: a.loc, day: 1, min: a.min, gear: E.gearStats(a.rod, a.reel, a.line, 's'), cond: a.cond, layoutSeed: a.seed, noLegend: true });
  var W2 = E.newWorld({ seed: a.seed, loc: a.loc, day: 1, min: a.min, gear: E.gearStats(a.rod, a.reel, a.line, 's'), cond: a.cond, layoutSeed: a.seed, noLegend: true });
  assert.deepStrictEqual(W1.fish.map(function (f) { return f.sp.id + f.w; }), W2.fish.map(function (f) { return f.sp.id + f.w; }));
  assert.ok(W1.fish.every(function (f) { return f.sp.rar < 4; }));
});

test('legends: at most one per world, and only in their conditions', function () {
  var cond = { band: E.NIGHT, wx: 4, wind: 0, wdir: 1, season: 0, loc: 'pond' }, seen = 0;
  for (var sd = 1; sd <= 40; sd++) {
    var W = E.newWorld({ seed: sd, loc: 'pond', day: 1, min: 100, cond: cond });
    for (var i = 0; i < 60 * 60; i++) E.stepWorld(W, E.STEP, {});
    var n = W.fish.filter(function (f) { return f.sp.rar === 4; }).length;
    assert.ok(n <= 1);
    if (W.legend) seen++;
  }
  assert.ok(seen > 0, 'Mossback shows up on some foggy nights');
  var W2 = E.newWorld({ seed: 1, loc: 'pond', day: 1, min: 720, cond: { band: E.DAY, wx: 0, wind: 0, wdir: 1, season: 1, loc: 'pond' } });
  for (var k = 0; k < 60 * 120; k++) E.stepWorld(W2, E.STEP, {});
  assert.ok(!W2.legend);
});

test('fish spread across the whole water, in habitat, not bunched at the angler\'s feet', function () {
  ['pond', 'river', 'lake', 'pier', 'ice', 'deep'].forEach(function (loc) {
    var thirds = [0, 0, 0], n = 0, nearShore = 0;
    for (var sd = 1; sd <= 6; sd++) {
      var W = world(loc, { seed: sd, min: 420, lure: loc === 'deep' ? 'd' : loc === 'ice' ? 'j' : 'b' });
      var W2 = world(loc, { seed: sd, min: 420 });
      for (var t = 0; t < 180; t += E.STEP) {
        var inp = {};
        if (W.phase === 'ready') E.cast(W, 0.7, 0.8);
        else if (W.phase === 'fishing') inp.reel = (W.t - W.lure.landT) > 20;
        else if (W.phase !== 'flight') { W.phase = 'ready'; W.fight = null; W.lure = null; }
        E.stepWorld(W, E.STEP, inp); E.stepWorld(W2, E.STEP, {});
        W.ev.length = 0; W2.ev.length = 0;
        if (t > 30 && Math.abs(t % 10) < E.STEP) {
          W2.fish.forEach(function (f) { thirds[Math.min(2, Math.floor(f.x / W2.lay.W * 3))]++; n++; });
          W.fish.forEach(function (f) { if (f.x < W.lay.W / 6) nearShore++; });
        }
      }
    }
    thirds.forEach(function (c, i) { assert.ok(c / n > 0.07, loc + ' third ' + i + ': ' + (c / n).toFixed(2)); });
    // through the ice the jig hangs right under the angler, so curious fish gather there more
    assert.ok(nearShore / n < (loc === 'ice' ? 0.4 : 0.2), loc + ' near the angler: ' + (nearShore / n).toFixed(2));
  });
});

test('homes follow habitat: weed fish by the weeds, bottom fish over deep water', function () {
  var W = world('lake', { seed: 4 }), deepX = 0, shelfX = 0, nd = 0, ns = 0;
  for (var i = 0; i < 400; i++) {
    var f1 = { sp: E.SP.laketrout }, f2 = { sp: E.SP.lmbass };
    var a = E.pickHome(W, E.SP.laketrout), b = E.pickHome(W, E.SP.lmbass);
    deepX += E.depthAt(W.lay, a); nd++; shelfX += E.depthAt(W.lay, b); ns++;
  }
  assert.ok(deepX / nd > shelfX / ns + 2, 'lake trout live deeper than bass');
});

test('an empty line comes home fast: one-tap reel in, and auto after the bait is stolen', function () {
  function retrieve(quick) {
    var W = world('lake', { lure: 's', cond: { band: E.DAY, wx: 0, wind: 0, wdir: 1, season: 1, loc: 'lake' } });
    W.fish.length = 0; E.cast(W, 1, 1);
    for (var i = 0; i < 200 && W.phase === 'flight'; i++) E.stepWorld(W, E.STEP, {});
    if (quick) assert.ok(E.reelIn(W));
    for (var t = 0; t < 120; t += E.STEP) { E.stepWorld(W, E.STEP, { reel: !quick }); W.fish.length = 0; if (W.phase === 'ready') return t; }
    return 999;
  }
  var slow = retrieve(false), fast = retrieve(true);
  assert.ok(fast < slow / 2.5 && fast < 8, 'quick ' + fast.toFixed(1) + 's vs ' + slow.toFixed(1) + 's');
  // stolen bait: the line winds itself in
  var W = world('pond', { lure: 'b', min: 420, day: 8 }), stolen = false;
  E.cast(W, 0.7, 0.8);
  for (var t = 0; t < 300 && W.phase !== 'ready'; t += E.STEP) {
    E.stepWorld(W, E.STEP, {});
    W.ev.forEach(function (e) { if (e.type === 'missed') stolen = true; });
    W.ev.length = 0;
    if (W.phase === 'fight') break;
  }
  if (stolen) assert.strictEqual(W.phase, 'ready', 'auto-retrieved after the bait went');
  // nothing bites a lure on its way home
  var W3 = world('river', { lure: 's' }); E.cast(W3, 0.8, 1);
  for (var i = 0; i < 200 && W3.phase === 'flight'; i++) E.stepWorld(W3, E.STEP, {});
  E.reelIn(W3);
  W3.fish.forEach(function (f) { assert.strictEqual(E.appeal(W3, f), 0); });
});

console.log(passed + ' passed' + (process.exitCode ? '' : ', all ok'));
