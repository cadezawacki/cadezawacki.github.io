/* Headless checks for the Uphill Rush engine (physics, vehicles, surfaces, set
 * pieces, tricks, scoring, bots, career data, saves, ghosts).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/uphill/uphill.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');

var E = require('./uphill.js');               // node: the file exports its pure engine
var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function steps(w, secs, ctl) {
  var n = Math.round(secs / E.STEP);
  for (var i = 0; i < n; i++) { if (ctl) ctl(w, i); E.step(w); }
}
function drain(w) { var ev = w.events.slice(); w.events.length = 0; return ev; }
function finite(w) {
  var c = w.c, a = w.wh[0], b = w.wh[1];
  return [c.x, c.y, c.a, c.vx, c.vy, c.w, a.x, a.y, a.om, b.x, b.y, b.om].every(function (v) { return typeof v === 'number' && isFinite(v); });
}
function energy(w) {
  var c = w.c, P = w.P, e = 0.5 * P.mc * (c.vx * c.vx + c.vy * c.vy) + 0.5 * P.ic * c.w * c.w + P.mc * E.G * c.y;
  w.wh.forEach(function (q) { e += P.mw * (0.5 * (q.vx * q.vx + q.vy * q.vy) + E.G * q.y); });
  return e;
}
// Lift the whole machine by dy, set its attitude / spin, and let it fly.
function launch(w, x, dy, angle, spin) {
  E.placeBike(w, x);
  var c = w.c, ca = Math.cos(angle), sa = Math.sin(angle);
  [w.wh[0], w.wh[1]].forEach(function (q) {
    var rx = q.x - c.x, ry = q.y - c.y;
    q.x = c.x + ca * rx - sa * ry; q.y = c.y + sa * rx + ca * ry + dy;
    q.vx = -spin * (q.y - dy - c.y); q.vy = spin * (q.x - c.x);
    q.px = q.x; q.py = q.y;
  });
  c.y += dy; c.a = angle; c.w = spin; c.py = c.y; c.pa = c.a;
  w.state = 'ride'; w.air = false; w.airT = 0; w.airRot = 0;
}
// a bot rider on a track until it finishes (or time runs out)
function botRun(opt, maxT) {
  var w = E.newWorld(opt);
  while (w.state !== 'finish' && w.t < (maxT || 150)) { if (!opt.ai) E.bot(w); E.step(w); w.events.length = 0; }
  return w;
}

test('module exports the engine; the widget registers under the manifest name', function () {
  assert.strictEqual(typeof E.newWorld, 'function');
  assert.strictEqual(typeof E.step, 'function');
  var entry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === 'uphill'; })[0];
  assert.strictEqual(entry.type, 'widget');
  assert.strictEqual(entry.entry, 'widgets/uphill/uphill.js');
  assert.strictEqual(entry.css, 'widgets/uphill/uphill.css');
  var reg = null, css = [];
  var src = fs.readFileSync(path.join(__dirname, 'uphill.js'), 'utf8');
  var fakeWin = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (o) { reg = o; } } };
  new Function('window', 'module', src)(fakeWin, undefined);
  assert.ok(reg, 'registered');
  assert.strictEqual(reg.name, entry.name);
  assert.strictEqual(reg.description, entry.description);
  assert.strictEqual(reg.icon, entry.icon);
  assert.strictEqual(reg.tags, entry.tags);
  assert.strictEqual(typeof reg.open, 'function');
  assert.deepStrictEqual(css, ['uphill.css']);
});

test('terrain lookups: height, slope, surface and segment search on a known polyline', function () {
  var w = E.newWorld({ src: 'f10 l20,5 m4 f10' });   // the start straight runs to x = 10
  assert.ok(Math.abs(E.heightAt(w.ter, 0)) < 1e-9);
  assert.ok(Math.abs(E.heightAt(w.ter, 20)) < 1e-9);
  assert.ok(Math.abs(E.heightAt(w.ter, 40) - 5) < 1e-9);
  var m = E.heightAt(w.ter, 30);
  assert.ok(m > 2.2 && m < 2.8, 'midpoint of the slope ' + m);
  assert.ok(E.slopeAt(w.ter, 30, 0.5) > 0.2, 'climbing');
  assert.strictEqual(E.matAt(w.ter, 30), 0, 'dirt');
  assert.strictEqual(E.matAt(w.ter, 45), 4, 'ice');
  for (var i = 1; i < w.ter.n; i++) assert.ok(w.ter.xs[i] > w.ter.xs[i - 1], 'xs strictly increasing');
  assert.ok(E.groundDist(w.ter, 0, 2, 0.2) > 1.9 && E.groundDist(w.ter, 0, -0.5, 0.2) < 0);
});

test('every vehicle settles at rest on flat ground: upright, no creep, no energy gain', function () {
  E.VEHICLES.forEach(function (v) {
    var w = E.newWorld({ src: 'f100', cfg: { veh: v.key } });
    steps(w, 2);
    var x0 = w.c.x, y0 = w.c.y, e0 = energy(w), maxV = 0, maxDy = 0, eMax = -1e9;
    steps(w, 5, function (w) {
      maxV = Math.max(maxV, Math.abs(w.c.vx), Math.abs(w.c.vy), Math.abs(w.c.w));
      maxDy = Math.max(maxDy, Math.abs(w.c.y - y0));
      eMax = Math.max(eMax, energy(w));
    });
    assert.ok(finite(w), v.key);
    assert.strictEqual(w.state, 'ready');
    assert.ok(Math.abs(w.c.a) < 0.02, v.key + ' upright ' + w.c.a);
    assert.ok(Math.abs(w.c.x - x0) < 1e-3, v.key + ' no creep ' + (w.c.x - x0));
    assert.ok(maxDy < 2e-3, v.key + ' no bounce ' + maxDy);
    assert.ok(maxV < 2e-3, v.key + ' no jitter ' + maxV);
    assert.ok(eMax <= e0 + 1e-3, v.key + ' no energy gain ' + (eMax - e0));
    assert.ok(w.wh[0].touch && w.wh[1].touch, v.key + ' both wheels down');
    assert.strictEqual(w.bodyT, false, v.key + ' rides on its wheels');
  });
});

test('gas accelerates, brakes stop, holding brake from a stop reverses', function () {
  var w = E.newWorld({ src: 'f400' });
  steps(w, 3, function (w) { w.inGas = 1; });
  assert.strictEqual(w.state, 'ride');
  assert.ok(w.c.vx > 13 && w.c.vx < 20, 'speed after 3 s ' + w.c.vx);
  var v0 = w.c.vx;
  steps(w, 1, function (w) { w.inGas = 0; w.inBrake = 1; });
  assert.ok(w.c.vx < v0 - 5, 'braking ' + w.c.vx);
  steps(w, 4, function (w) { w.inGas = 0; w.inBrake = 1; });
  assert.ok(w.c.vx < -1.5, 'reversing ' + w.c.vx);
});

test('vehicles really differ: the Viper outruns the Goat on the flat, the Goat out-climbs it on ice', function () {
  function flat(veh) { var w = E.newWorld({ src: 'f600', cfg: { veh: veh } }); steps(w, 8, function (w) { w.inGas = 1; }); return w.c.x; }
  assert.ok(flat('viper') > flat('goat') + 15, 'top speed');
  function ice(veh) { var w = E.newWorld({ src: 'f4 m4 l40,9 f40', cfg: { veh: veh } }); steps(w, 10, function (w) { E.bot(w); }); return w.c.x; }
  assert.ok(ice('goat') > ice('viper') + 3, 'grip on an icy climb ' + ice('goat') + ' vs ' + ice('viper'));
});

test('every track is finishable by the bot on the starter bike; checkpoints in order', function () {
  E.TRACKS.forEach(function (tr) {
    var w = E.newWorld({ track: tr.key }), seen = [];
    while (w.state !== 'finish' && w.t < 150) {
      E.bot(w); E.step(w);
      drain(w).forEach(function (e) { if (e === 'cp') seen.push(w.cpX); });
    }
    assert.strictEqual(w.state, 'finish', tr.key + ' finished (t ' + w.t.toFixed(1) + ')');
    assert.deepStrictEqual(seen, w.cps.slice(0, seen.length), tr.key + ' checkpoints in order');
    assert.ok(w.final < tr.par[1], tr.key + ' the bot makes two stars: ' + w.final.toFixed(1) + ' vs ' + tr.par[1]);
  });
});

test('rival bots and bosses finish their events', function () {
  E.EVENTS.forEach(function (ev) {
    if (!ev.rivals) return;
    ev.rivals.forEach(function (r) {
      var cs = E.CAST[r[0]], w = botRun({ track: ev.track, cfg: { veh: cs.veh, fx: cs.fx }, ai: { skill: r[1] } }, 180);
      assert.strictEqual(w.state, 'finish', ev.id + ' ' + r[0]);
    });
  });
});

test('a head-first landing is a crash; the stage respawns at the checkpoint', function () {
  var w = E.newWorld({ src: 'f30 c f60' });      // checkpoint at x = 40
  launch(w, 50, 3, Math.PI, 0);
  var ev = [];
  steps(w, 1.2, function (w) { ev = ev.concat(drain(w)); });
  assert.ok(ev.indexOf('crash') >= 0, 'crashed');
  assert.strictEqual(w.why, 'head');
  for (var i = 0; i < E.RAG_N; i++) assert.ok(w.rag[i * 4 + 1] > E.heightAt(w.ter, w.rag[i * 4]) - 0.05);
  for (var j = 0; j < 2 / E.STEP && ev.indexOf('respawn') < 0; j++) { E.step(w); ev = ev.concat(drain(w)); }
  assert.ok(ev.indexOf('respawn') >= 0);
  assert.strictEqual(w.state, 'ride');
  assert.ok(Math.abs(w.c.x - 40) < 1e-9 && Math.abs(w.c.vx) < 1e-9, 'back at the checkpoint, at rest');
});

test('the buggy rolls onto its cage roof: crash; it shrugs off what flips a bike', function () {
  var w = E.newWorld({ src: 'f100', cfg: { veh: 'buggy' } }), ev = [];
  launch(w, 40, 3, Math.PI, 0);
  steps(w, 1.5, function (w) { ev = ev.concat(drain(w)); });
  assert.ok(ev.indexOf('crash') >= 0);
  w = E.newWorld({ src: 'f100', cfg: { veh: 'buggy' } }); ev = [];
  launch(w, 40, 4, 0, 0);
  steps(w, 2, function (w) { ev = ev.concat(drain(w)); });
  assert.strictEqual(ev.indexOf('crash'), -1, 'a flat drop is fine');
});

// Spin rate that lands the bike after one full rotation (bisection on the launch spin).
function flipDrop(dir) {
  var lo = 2, hi = 12, best = null;
  for (var k = 0; k < 30; k++) {
    var mid = (lo + hi) / 2, w = E.newWorld({ src: 'f200' });
    launch(w, 40, 9, 0, dir * mid);
    var rot = null;
    for (var i = 0; i < 4 / E.STEP; i++) {
      E.step(w);
      if (w.airT === 0 && w.c.y < 5) { rot = w.c.a; break; }
    }
    if (rot == null) break;
    best = mid;
    if (Math.abs(rot) < Math.PI * 2) lo = mid; else hi = mid;
    if (Math.abs(Math.abs(rot) - Math.PI * 2) < 0.05) break;
  }
  return best;
}
test('a 360° rotation in the air is a flip (back and front): trick points, a time bonus', function () {
  [1, -1].forEach(function (dir) {
    var spin = flipDrop(dir), w = E.newWorld({ src: 'f200' }), ev = [];
    launch(w, 40, 9, 0, dir * spin);
    steps(w, 3, function (w) { ev = ev.concat(drain(w)); });
    assert.strictEqual(ev.indexOf('crash'), -1, 'clean landing');
    assert.ok(ev.indexOf('flip') >= 0, 'flip event (' + dir + ')');
    assert.strictEqual(w.flips, 1);
    assert.strictEqual(w.lastFlipDir, dir, 'direction');
    assert.ok(w.bonus >= 1, 'stage time bonus');
    var t = w.tricks.filter(function (x) { return /FLIP/.test(x.n); })[0];
    assert.ok(t && t.n === (dir > 0 ? 'BACKFLIP' : 'FRONTFLIP') && t.p >= 300, 'named and scored');
    assert.ok(w.score > 0 && w.comboN === 0, 'the combo banked after landing');
  });
  assert.strictEqual(E.flipName(2, 1), 'DOUBLE BACKFLIP');
  assert.strictEqual(E.flipName(3, -1), 'TRIPLE FRONTFLIP');
});

test('a plain jump is not a flip; over-rotation into the ground is a crash and loses the combo', function () {
  var w = E.newWorld({ src: 'f200' }), ev = [];
  launch(w, 40, 6, 0.3, 1.2);
  steps(w, 3, function (w) { ev = ev.concat(drain(w)); });
  assert.strictEqual(ev.indexOf('flip'), -1);
  w = E.newWorld({ src: 'f200' }); ev = [];
  launch(w, 40, 6, 0, 4.5);
  w.combo = 500; w.comboN = 2;
  steps(w, 3, function (w) { ev = ev.concat(drain(w)); });
  assert.ok(ev.indexOf('crash') >= 0);
  assert.ok(ev.indexOf('bail') >= 0, 'combo lost');
  assert.strictEqual(w.flips, 0);
  assert.strictEqual(w.score, 0);
});

test('wheelies and stoppies score; tricks chain into a multiplied combo', function () {
  var w = E.newWorld({ src: 'f400' });
  steps(w, 7, function (w) {
    w.inGas = 1;
    var a = w.c.a;
    w.inLean = a < 0.45 ? -1 : a > 0.7 ? 1 : 0;
    if (w.t > 4) { w.inLean = 1; w.inGas = 0; }
  });
  var wh = w.tricks.filter(function (t) { return t.k === 'wheelie'; });
  assert.ok(wh.length >= 1, 'wheelie awarded: ' + w.tricks.map(function (t) { return t.n; }));
  assert.ok(w.bestWheelie >= 1, 'a long one ' + w.bestWheelie);
  // combo maths: two tricks, banked ×2
  var c = E.newWorld({ src: 'f100' });
  c.combo = 300; c.comboN = 2;
  E.bankCombo(c);
  assert.strictEqual(c.score, 600);
  assert.strictEqual(c.lastCombo.mul, 2);
});

test('style pose: chosen by the lean, scores when released in the air, bails when held to the ground', function () {
  var w = E.newWorld({ src: 'f200' });
  launch(w, 40, 9, 0, 0);
  steps(w, 2.5, function (w) { w.inLean = w.t < 0.25 ? 1 : 0; w.inTrick = w.t < 0.75 ? 1 : 0; if (w.t > 0.75) { E.bot(w); w.inGas = 0; } });
  assert.strictEqual(w.crashes, 0, 'released in time');
  var t = w.tricks.filter(function (x) { return x.k === 'superman'; });
  assert.strictEqual(t.length, 1, 'superman awarded: ' + w.tricks.map(function (x) { return x.n; }));
  w = E.newWorld({ src: 'f200' });
  launch(w, 40, 9, 0, 0);
  steps(w, 2.5, function (w) { w.inTrick = 1; });
  assert.strictEqual(w.why, 'bail');
  // no poses in a buggy
  w = E.newWorld({ src: 'f200', cfg: { veh: 'buggy' } });
  launch(w, 40, 9, 0, 0);
  steps(w, 1, function (w) { w.inTrick = 1; });
  assert.strictEqual(w.pose, 0);
});

test('repeats are worth less; trick zones double', function () {
  var z = E.newWorld({ src: 'f4 z40 f60' });
  z.inGas = 1;
  steps(z, 2.2, function (w) { w.inGas = 1; });
  assert.ok(z.zoneTrick, 'inside the zone');
  var p1 = E.newWorld({ src: 'f200' }), p2;
  launch(p1, 40, 9, 0, flipDrop(1));
  steps(p1, 3);
  p2 = E.newWorld({ src: 'f20 z200 f200' });
  launch(p2, 40, 9, 0, flipDrop(1));
  steps(p2, 3);
  var f1 = p1.tricks.filter(function (t) { return /FLIP/.test(t.n); })[0], f2 = p2.tricks.filter(function (t) { return /FLIP/.test(t.n); })[0];
  assert.ok(f1 && f2 && f2.p === f1.p * 2 && f2.z === 2, 'double in the zone');
  launch(p1, 80, 9, 0, flipDrop(1));
  steps(p1, 3);
  var flips = p1.tricks.filter(function (t) { return /FLIP/.test(t.n); });
  assert.strictEqual(flips.length, 2);
  assert.ok(flips[1].p < flips[0].p, 'second one worth less');
});

test('surfaces: sand drags, ice slips', function () {
  function dist(src) { var w = E.newWorld({ src: src }); steps(w, 4, function (w) { w.inGas = 1; }); return w.c.x; }
  assert.ok(dist('m1 f200') < dist('f200') - 2, 'sand is slower');
  function climb(src, tyres) { var w = E.newWorld({ src: src, cfg: { parts: { tyres: tyres } } }); steps(w, 8, function (w) { E.bot(w); }); return w.c.x; }
  assert.ok(climb('f4 m4 l30,7 f40') < climb('f4 l30,7 f40') - 5, 'ice climb is harder');
  assert.ok(climb('f4 m4 l30,7 f40', 'studded') > climb('f4 m4 l30,7 f40') + 3, 'studded tyres help on ice');
});

test('set pieces: boost strips, springboards, wind, water, tunnels, crates, boulders', function () {
  function run(src, secs, ctl, cfg) { var w = E.newWorld({ src: src, cfg: cfg }), ev = []; steps(w, secs, function (w, i) { if (ctl) ctl(w, i); else w.inGas = 1; ev = ev.concat(drain(w)); }); w.ev = ev; return w; }
  assert.ok(run('f2 b20 f60', 3).c.x > run('f80', 3).c.x + 3, 'boost');
  var sp = run('f2 j8 f60', 3);
  assert.ok(sp.ev.indexOf('spring') >= 0 && sp.maxAir > 0.8, 'springboard air ' + sp.maxAir);
  var tail = run('f4 k6,2 a40,8 f60', 4), head = run('f4 k6,2 a40,-8 f60', 4);
  assert.ok(tail.c.x > head.c.x + 1, 'wind pushes');
  var wet = run('f4 p10,1 f60', 4);
  assert.ok(wet.ev.indexOf('splash') >= 0 && wet.crashes === 0, 'a shallow pool is passable');
  assert.ok(wet.c.x < run('f80', 4).c.x - 2, 'water slows');
  var lowRoof = run('f4 k4,1.6 t20,2.6 f60', 3);
  assert.strictEqual(lowRoof.why, 'roof', 'a jump into a low tunnel hits the ceiling');
  var tunnel = run('f4 t30,3.1 f60', 4);
  assert.strictEqual(tunnel.crashes, 0, 'a tall enough tunnel is fine');
  var cr = run('f2 x4 f60', 4);
  assert.strictEqual(cr.crates.filter(function (k) { return k.on; }).length, 0, 'crates smashed');
  assert.strictEqual(cr.tricks.filter(function (t) { return t.k === 'crate'; }).length, 4);
  // a boulder: triggered on approach, lands, shatters; arriving just as it lands is a crash
  var rk = E.newWorld({ src: 'f30 q f60' }), hit = false;
  for (var v = 9; v < 26 && !hit; v += 0.5) {
    rk = E.newWorld({ src: 'f30 q f60' });
    E.placeBike(rk, 15); rk.state = 'ride';
    var vv = v;
    steps(rk, 3, function (w) { w.c.vx = vv; w.wh[0].vx = vv; w.wh[1].vx = vv; w.wh[0].om = -vv / 0.38; w.wh[1].om = -vv / 0.38; });
    if (rk.why === 'rock') hit = true;
  }
  assert.ok(hit, 'some approach speed meets the boulder');
  var slow = E.newWorld({ src: 'f30 q f60' }), evs = [];
  steps(slow, 6, function (w) { w.inGas = w.c.vx < 6 ? 1 : 0; evs = evs.concat(drain(w)); });
  assert.ok(evs.indexOf('rockfall') >= 0 && evs.indexOf('rockland') >= 0 && slow.crashes === 0, 'a careful approach lets it fall first');
});

test('suspension trade-off: race valving cases and throws you on a big flat drop, long travel soaks it', function () {
  function drop(s) {
    var w = E.newWorld({ src: 'f10 d-6 f60', cfg: { parts: { susp: s } } }), ev = [];
    steps(w, 4, function (w) { w.inGas = w.c.x < 9 ? 1 : 0; var u = E.wrapPi(w.c.a) * 2 + w.c.w * 0.4; w.inLean = w.air ? (u > 0.2 ? 1 : u < -0.2 ? -1 : 0) : 0; ev = ev.concat(drain(w)); });
    return { cased: ev.indexOf('cased') >= 0, why: w.why, crashes: w.crashes };
  }
  var st = drop('stiff'), pl = drop('plush');
  assert.ok(st.cased && st.why === 'cased', 'stiff: thrown ' + JSON.stringify(st));
  assert.ok(!pl.cased && pl.crashes === 0, 'plush: fine ' + JSON.stringify(pl));
});

test('every tuning option and team is a trade-off', function () {
  E.PARTS.forEach(function (sl) {
    sl.opts.slice(1).forEach(function (o) {
      var up = false, down = false, fx = o.fx || {};
      Object.keys(fx).forEach(function (k) {
        var vals = Array.isArray(fx[k]) ? fx[k] : [fx[k]];
        vals.forEach(function (v) {
          var good = k === 'mass' || k === 'inertia' || k === 'burn' ? v < 1 : k === 'travel' ? true : k === 'nitro' || k === 'hop' ? v > 0 : v > 1;
          var bad = k === 'mass' || k === 'inertia' || k === 'burn' ? v > 1 : k === 'travel' ? false : k === 'nitro' || k === 'hop' ? false : v < 1;
          if (k === 'travel' && v < 0) { good = false; bad = true; }
          if (k === 'wind') { good = v < 1; bad = v > 1; }
          if (k === 'k') { good = true; }
          if (good) up = true;
          if (bad) down = true;
        });
      });
      assert.ok(up && down, sl.slot + '.' + o.key + ' has an upside and a downside');
      assert.ok(o.cost > 0, sl.slot + '.' + o.key + ' costs something');
    });
  });
  E.TEAMS.forEach(function (t) { assert.ok(t.perk && t.cost, t.key); });
  // the params reflect the parts
  var stock = E.bikeParams({}), race = E.bikeParams({ parts: { engine: 'race' } });
  assert.ok(race.omax > stock.omax && race.torque < stock.torque);
  assert.ok(E.bikeParams({ parts: { gadget: 'nitro' } }).nitro === 3 && E.bikeParams({ parts: { gadget: 'nitro' }, team: 'volt' }).nitro === 4);
});

test('gadgets: nitro bursts (limited), hydraulic hop pops off the ground', function () {
  var w = E.newWorld({ src: 'f400', cfg: { parts: { gadget: 'nitro' } } }), n = E.newWorld({ src: 'f400' });
  steps(w, 4, function (w, i) { w.inGas = 1; w.inGadget = (i % 360) < 10 ? 1 : 0; });
  steps(n, 4, function (w) { w.inGas = 1; });
  assert.strictEqual(w.nitro, 0, 'charges used');
  assert.ok(w.c.x > n.c.x + 4, 'faster ' + w.c.x + ' vs ' + n.c.x);
  var h = E.newWorld({ src: 'f400', cfg: { parts: { gadget: 'hop' } } }), air = false;
  steps(h, 2, function (w, i) { w.inGas = 1; w.inGadget = i > 240 && i < 250 ? 1 : 0; if (!w.wh[0].touch && !w.wh[1].touch) air = true; });
  assert.ok(air, 'hopped');
});

test('falling into a gap is a crash', function () {
  var w = E.newWorld({ src: 'f30 g8,0 f30' });
  for (var i = 0; i < 20 / E.STEP; i++) {
    w.inGas = w.c.vx < 5 ? 1 : 0; w.inLean = 0;
    E.step(w); w.events.length = 0;
    if (w.state === 'crash') break;
  }
  assert.strictEqual(w.why, 'gap');
});

test('deterministic: same seed + same inputs → identical run; seeds differ', function () {
  function run(seed) {
    var w = E.newWorld({ endless: true, seed: seed });
    steps(w, 20, function (w, i) { E.bot(w); if ((i >> 7) % 5 === 0) w.inLean = -w.inLean; });
    return [w.c.x, w.c.y, w.c.a, w.c.vx, w.wh[0].om, w.coins, w.fuel, w.dist, w.ter.n].join(',');
  }
  assert.strictEqual(run(42), run(42));
  var a = E.newWorld({ endless: true, seed: 1 }), b = E.newWorld({ endless: true, seed: 2 });
  var same = true;
  for (var x = 20; x < 200; x += 5) if (Math.abs(E.heightAt(a.ter, x) - E.heightAt(b.ter, x)) > 1e-6) same = false;
  assert.ok(!same, 'different seeds → different terrain');
  function race(skill) { return botRun({ track: 'dust1', ai: { skill: skill } }).final; }
  assert.strictEqual(race(0.5), race(0.5), 'bots are deterministic');
  assert.ok(race(0.3) > race(0.9) + 2, 'skill matters');
});

test('fixed step: 60 Hz and 120 Hz frames give the identical simulation', function () {
  function run(hz) {
    var w = E.newWorld({ track: 'dust2' });
    for (var f = 0; f < 6 * hz; f++) { E.bot(w); w.inLean = 0; E.advance(w, 1 / hz); }
    return w;
  }
  var a = run(60), b = run(120);
  assert.strictEqual(a.steps, b.steps);
  assert.strictEqual(a.c.x, b.c.x);
  assert.strictEqual(a.c.a, b.c.a);
  var w = E.newWorld({ src: 'f100' }), s0 = w.steps;
  E.advance(w, 5);
  assert.ok(w.steps - s0 <= 48);
});

test('endless: fuel runs out without cans; coins are collected; biomes change surfaces', function () {
  var w = E.newWorld({ endless: true, seed: 7 }), ev = [];
  assert.ok(w.items.some(function (it) { return it.k === 0; }), 'coins placed');
  assert.ok(w.items.some(function (it) { return it.k === 1; }), 'a fuel can placed');
  steps(w, 30, function (w) { E.bot(w); ev = ev.concat(drain(w)); });
  assert.ok(w.coins > 0 && ev.indexOf('coin') >= 0, 'coins collected ' + w.coins);
  w.items.forEach(function (it) { it.on = 0; });
  w.gen.nextFuel = 1e9;
  w.fuel = 0.02;
  for (var i = 0; i < 40 / E.STEP && w.state !== 'over'; i++) { E.bot(w); E.step(w); ev = ev.concat(drain(w)); }
  assert.ok(ev.indexOf('nofuel') >= 0);
  assert.strictEqual(w.state, 'over');
  assert.strictEqual(w.why, 'fuel');
  var g = E.newWorld({ endless: true, seed: 9 });
  assert.strictEqual(E.biomeAt(g, 100), 0);
  assert.strictEqual(E.biomeAt(g, 800), 1);
  var fixed = E.newWorld({ endless: true, seed: 9, biome: 2 }), mats = {};
  for (var x = 20; x < 200; x += 0.5) mats[E.matAt(fixed.ter, x)] = 1;
  assert.ok(mats[3] || mats[4], 'snow / ice in the frost biome');
});

test('endless: terrain is compacted behind the bike (bounded memory)', function () {
  var w = E.newWorld({ endless: true, seed: 3 });
  for (var i = 0; i < 400 / E.STEP && w.c.x < 3000; i++) {
    E.bot(w); E.step(w); w.events.length = 0;
    if (w.state !== 'ride' && w.state !== 'ready') { E.placeBike(w, w.c.x + 3); w.state = 'ride'; }
    w.fuel = 1;
  }
  assert.ok(w.c.x > 1500, 'rode far ' + w.c.x);
  assert.ok(w.ter.n < w.ter.cap, 'terrain within capacity');
  assert.ok(w.ter.xs[0] > 500, 'old terrain dropped ' + w.ter.xs[0]);
  assert.ok(w.items.length < 600 && w.decos.length < 200 && w.zones.length < 40);
});

test('hill climb: finishes at the goal distance', function () {
  var w = E.newWorld({ endless: true, seed: 5, biome: 0, goal: 120 }), ev = [];
  steps(w, 30, function (w) { E.bot(w); w.fuel = 1; ev = ev.concat(drain(w)); });
  assert.ok(ev.indexOf('finish') >= 0 && ev.indexOf('done') >= 0, 'finished');
  assert.ok(w.dist >= 120);
});

test('ghosts: 5-channel encoding round-trips, decimates when long, and replays', function () {
  var n = 300, a = new Float32Array(n * 5);
  for (var i = 0; i < n; i++) { a[i * 5] = i * 1.37 - 3; a[i * 5 + 1] = Math.sin(i / 9) * 6; a[i * 5 + 2] = Math.cos(i / 13) * 7; a[i * 5 + 3] = (i % 3) - 1; a[i * 5 + 4] = (i % 7) / 7 + 2; }
  var s = E.packGhost(a, n), b = E.decodeGhost(s);
  assert.ok(/^5;[A-Za-z0-9_-]+$/.test(s));
  assert.strictEqual(b.length, n * 5);
  for (i = 0; i < n * 5; i++) assert.ok(Math.abs(a[i] - b[i]) <= (i % 5 === 2 ? 0.006 : 0.026), 'value ' + i);
  assert.strictEqual(E.decodeGhost('!!'), null);
  assert.strictEqual(E.decodeGhost('AAAA'), null, 'old (v1) strings are ignored');
  var big = E.packGhost(a, n, 1200);
  assert.ok(big && big.length <= 1200 && /^5;\d+\./.test(big));
  assert.strictEqual(E.decodeGhost(big).length / 5, n - (n - 1) % (+/^5;(\d+)/.exec(big)[1]));
  // a recorded run replays where the rider was
  var w = E.newWorld({ track: 'dust1' });
  w.rec = new Float32Array(9000 * 5); w.recN = 0;
  steps(w, 1);
  assert.strictEqual(w.recN, 0, 'nothing recorded at the start line');
  steps(w, 6, function (w) { E.bot(w); });
  var gd = E.decodeGhost(E.packGhost(w.rec, w.recN)), q = [0, 0, 0, 0, 0];
  assert.ok(E.ghostAt(gd, 2.0, q) && Math.abs(q[0] - w.rec[20 * 5]) < 0.06);
  assert.ok(Math.abs(E.ghostLead(gd, 2.0, q[0] + 3) - 3) < 1e-6);
  // the crew chief's line exists for every track
  var rg = E.rivalGhost('dust1');
  assert.ok(rg.data.length > 100 * 5 && rg.t > 0);
});

test('judges: more and more varied tricks score higher; crashes cost', function () {
  var base = { score: 0, crashes: 0, bottoms: 0, perfects: 0, flips: 0, maxAir: 0, totalAir: 0, wheelie: 0, unique: 0, repeats: 0 };
  function J(o) { var s = {}; for (var k in base) s[k] = k in o ? o[k] : base[k]; return E.judge(s, 1500); }
  var poor = J({ score: 100 }), good = J({ score: 3000, unique: 6, flips: 3, maxAir: 2, perfects: 3, wheelie: 2 }), crashy = J({ score: 3000, unique: 6, flips: 3, maxAir: 2, crashes: 3 });
  assert.ok(good.total > poor.total + 10, good.total + ' vs ' + poor.total);
  assert.ok(crashy.total < good.total - 3);
  assert.strictEqual(good.cards.length, 3);
  good.cards.forEach(function (c) { assert.ok(c.score >= 0 && c.score <= 10 && c.quip); });
});

test('career data: tracks, cast, prizes and progression rules hang together', function () {
  E.LOCS.forEach(function (L) {
    var evs = E.locEvents(L.key);
    assert.strictEqual(evs.length, 4, L.key);
    assert.strictEqual(evs.filter(E.isBoss).length, 1, L.key + ' one boss');
    assert.ok(E.LOC_INTRO[L.key], L.key + ' intro');
    assert.ok(E.unlockedBy(L.key).length >= 1, L.key + ' boss unlocks something');
  });
  E.EVENTS.forEach(function (ev) {
    if (ev.track) assert.ok(E.trackOf(ev.track), ev.id + ' track');
    (ev.rivals || []).concat(ev.scores || []).forEach(function (r) { assert.ok(E.CAST[r[0]], ev.id + ' cast ' + r[0]); });
    if (ev.bet) assert.ok(E.CAST[ev.bet[0]]);
    assert.ok(ev.intro.length && ev.win.length && ev.lose.length, ev.id + ' story');
    if (ev.type === 'climb' || ev.type === 'time') assert.strictEqual(ev.tiers.length, 3);
    ev.intro.concat(ev.win, ev.lose).forEach(function (l) { assert.ok(E.CAST[l[0]], ev.id + ' speaker ' + l[0]); });
  });
  var sv = E.normSave(null);
  sv.career.team = 'devils';
  assert.ok(E.locOpen(sv, 0) && !E.locOpen(sv, 1));
  assert.ok(!E.bossOpen(sv, 'dust'));
  sv.career.ev['dust-1'] = { p: 2, b: 0, n: 1 }; sv.career.ev['dust-2'] = { p: 3, b: 0, n: 1 };
  assert.ok(E.bossOpen(sv, 'dust'));
  sv.career.boss.dust = 1;
  assert.ok(E.locOpen(sv, 1));
  var ev1 = E.eventOf('dust-2');
  assert.strictEqual(E.entryFee(ev1, 'devils'), Math.round(ev1.fee * 1.3));
  var pay = E.payout(ev1, 1, 'devils', true, true, false);
  assert.strictEqual(pay.prize, Math.round(ev1.prize[0] * 1.25));
  assert.strictEqual(pay.bet, -ev1.bet[1]);
  assert.strictEqual(E.payout(ev1, 1, 'comet', false, false, false).prize, Math.round(Math.round(ev1.prize[0] * 0.5) * 0.75), 'replays pay half');
  assert.strictEqual(E.tierPlace(E.eventOf('dust-3'), 600), 2);
  assert.strictEqual(E.tierPlace(E.eventOf('frost-2'), 99), 4);
  assert.ok(E.vehAvail(sv, E.vehOf('buggy')) && !E.vehAvail(sv, E.vehOf('viper')));
});

test('race helpers: rivals fast-forward to the line; standings order by finish then distance', function () {
  var a = E.newWorld({ track: 'dust1', ai: { skill: 0.9 } }), b = E.newWorld({ track: 'dust1', ai: { skill: 0.3 } });
  var ta = E.simToFinish(a), tb = E.simToFinish(b);
  assert.ok(ta > 0 && tb > ta);
  var c = E.newWorld({ track: 'dust1' }); c.c.x = 50;
  var order = E.standings([{ w: b, id: 'b' }, { w: c, id: 'c' }, { w: a, id: 'a' }]).map(function (r) { return r.id; });
  assert.deepStrictEqual(order, ['a', 'b', 'c']);
});

test('save data: v1 saves migrate (upgrades refunded), v2 normalises, cosmetics and parts gate', function () {
  var m = E.normSave({ v: 1, coins: 10, up: { engine: 2, susp: 1 }, eb: 321, ghost: false, st: { 1: { t: 20, s: 3 } } });
  assert.strictEqual(m.v, 2);
  assert.strictEqual(m.coins, 10 + 40 + 90 + 40);
  assert.strictEqual(m.eb, 321);
  assert.strictEqual(m.ghost, 'off');
  var s = E.normSave({ v: 2, coins: -5, veh: 'viper', owned: { viper: 1, bogus: 1 }, parts: { engine: 'race', tyres: 'slick' }, own: { 'engine.race': 1 },
    look: { paint: 'gold', helmet: 'visor', acc: 'scarf' }, tt: { dust1: { t: 25, s: 3, sc: 900 }, nope: { t: 1, s: 3 } }, career: { team: 'kings', ev: { 'dust-1': { p: 1 } }, boss: { dust: 1 } } });
  assert.strictEqual(s.coins, 0);
  assert.strictEqual(s.veh, 'viper');
  assert.ok(!s.owned.bogus);
  assert.strictEqual(s.parts.engine, 'race');
  assert.strictEqual(s.parts.tyres, 'stock', 'unowned part falls back');
  assert.strictEqual(s.look.paint, 'sig', 'locked paint falls back');
  assert.strictEqual(s.look.helmet, 'classic', 'unbought helmet falls back');
  assert.deepStrictEqual(Object.keys(s.tt), ['dust1']);
  assert.strictEqual(s.career.team, 'kings');
  assert.ok(E.lookOwned(s, 'p', E.find(E.PAINTS, 'sand')), 'boss paint earned');
  assert.ok(!E.ttUnlocked(s, 2) && E.ttUnlocked(s, 1) && E.ttUnlocked(s, 3), 'track unlocks per location');
  var f = E.normSave({ v: 2, tt: { dust1: { t: 25, s: 3 } }, far: { dust1: { d: 80, v: 'mule' }, dust2: { d: 123.4, v: 'nope' }, pine1: { d: -3 } } });
  assert.deepStrictEqual(f.far, { dust2: { d: 123.4, v: 'mule' } }, 'farthest attempts kept only for unfinished tracks');
});

test('time-trial results: a faster run replaces the best; stars pay once; style best tracked', function () {
  var sv = E.normSave(null), tr = E.TRACKS[0];
  var r1 = E.stageResult(sv, tr.key, tr.par[1] + 1, 500);
  assert.ok(r1.newBest && r1.stars === 1 && r1.earned === E.STAR_COINS);
  var r2 = E.stageResult(sv, tr.key, tr.par[0] - 1, 300);
  assert.ok(r2.newBest && r2.stars === 3 && r2.earned === 2 * E.STAR_COINS);
  assert.strictEqual(sv.tt[tr.key].sc, 500, 'best style kept');
  var r3 = E.stageResult(sv, tr.key, tr.par[0] + 0.5, 900);
  assert.ok(!r3.newBest && r3.newScore && r3.earned === 0);
  assert.strictEqual(sv.tt[tr.key].sc, 900);
  assert.strictEqual(sv.coins, 3 * E.STAR_COINS);
});

console.log((process.exitCode ? 'FAILED' : 'ok') + ' — ' + passed + ' passed');
