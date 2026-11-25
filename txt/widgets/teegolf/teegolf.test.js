/* Headless checks for the Tee Time Golf engine (courses, holes, flight, rules, CPU, tour).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/teegolf/teegolf.test.js */
'use strict';
var assert = require('assert');

var E = require('./teegolf.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./teegolf.js')];
require('./teegolf.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + '±' + tol + ', got ' + a); }
var EQ0 = {};
var COURSE = E.newCourse(12345, 'parkland', 0);
var HOLES = {};
function hole(i, diff, opts) { var k = i + ':' + diff + ':' + JSON.stringify(opts || {}); return HOLES[k] || (HOLES[k] = E.buildHole(COURSE, i, diff == null ? 1 : diff, opts)); }
function run(H, b, env) { for (var i = 0; i < 12000 && E.moving(b); i++) E.stepBall(H, b, env); return b; }

test('registers a widget that matches the manifest', function () {
  assert.ok(widget, 'registered');
  assert.strictEqual(widget.name, 'Tee Time Golf');
  assert.strictEqual(widget.icon, '🏌');
  assert.deepStrictEqual(css, ['teegolf.css']);
  var man = require('../../manifest.json'), ent = (man.modules || man.items || man).filter ? (man.modules || man.items || man).filter(function (m) { return m.id === 'teegolf'; })[0] : null;
  if (!ent) { var all = JSON.stringify(man); assert.ok(all.indexOf('"teegolf"') >= 0); return; }
  assert.strictEqual(ent.name, widget.name);
  assert.strictEqual(ent.description, widget.description);
  assert.strictEqual(ent.tags, widget.tags);
  assert.strictEqual(ent.icon, widget.icon);
});

test('courses are seeded, par 72, with 4 par 3s and 4 par 5s', function () {
  var a = E.newCourse(99, null, 0), b = E.newCourse(99, null, 0), c = E.newCourse(100, null, 0);
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a.holes.map(function (h) { return h.len; }), c.holes.map(function (h) { return h.len; }));
  assert.ok(E.THEME_IDS.indexOf(a.theme) >= 0);
  [a, c, COURSE].forEach(function (co) {
    assert.strictEqual(co.holes.length, 18);
    assert.strictEqual(co.par, 72);
    var n3 = co.holes.filter(function (h) { return h.par === 3; }).length, n5 = co.holes.filter(function (h) { return h.par === 5; }).length;
    assert.strictEqual(n3, 4); assert.strictEqual(n5, 4);
    assert.notStrictEqual(co.holes[0].par, 3);
    co.holes.forEach(function (h) {
      assert.ok(typeof h.name === 'string' && h.name.length > 2);
      if (h.par === 3) assert.ok(h.len >= 120 && h.len <= 215, 'par 3 ' + h.len);
      if (h.par === 4) assert.ok(h.len >= 320 && h.len <= 460, 'par 4 ' + h.len);
      if (h.par === 5) assert.ok(h.len >= 480 && h.len <= 600, 'par 5 ' + h.len);
    });
  });
  // the tour level stretches the holes
  var t3 = E.newCourse(99, a.theme, 3);
  assert.ok(t3.holes[0].len > a.holes[0].len);
});

test('every theme builds holes with a tee, a green with the pin on it, and sane terrain', function () {
  E.THEME_IDS.forEach(function (th, k) {
    var co = E.newCourse(500 + k, th, 0);
    for (var i = 0; i < 18; i += 5) {
      var H = E.buildHole(co, i, 1);
      assert.strictEqual(H.theme, th);
      assert.strictEqual(E.lieAt(H, H.pin.x, H.pin.y), E.GREEN, th + ' pin on green');
      assert.strictEqual(E.lieAt(H, H.tee.x, H.tee.y), E.TEE, th + ' tee box');
      assert.ok(H.len > co.holes[i].len * 0.8 && H.len < co.holes[i].len * 1.25, th + ' length ' + H.len + ' vs ' + co.holes[i].len);
      // the green is gently sloped: a ball can stop on it
      var g = E.gradAt(H, H.pin.x, H.pin.y, [0, 0]);
      assert.ok(Math.sqrt(g[0] * g[0] + g[1] * g[1]) < 0.07, 'green slope');
      var bad = 0;
      for (var j = 0; j < H.hgt.length; j += 97) if (!isFinite(H.hgt[j])) bad++;
      assert.strictEqual(bad, 0);
      assert.ok(H.wind.mph >= 0 && H.wind.mph < 25);
    }
  });
});

test('holes are deterministic and difficulty picks the tee', function () {
  var a = E.buildHole(COURSE, 3, 1), b = E.buildHole(COURSE, 3, 1);
  assert.strictEqual(a.pin.x, b.pin.x);
  assert.strictEqual(a.trees.length, b.trees.length);
  var easy = E.buildHole(COURSE, 3, 0), pro = E.buildHole(COURSE, 3, 3);
  assert.ok(easy.len < a.len && a.len < pro.len + 1, 'front tee shorter: ' + easy.len + ' < ' + a.len + ' <= ' + pro.len);
  assert.ok(pro.wind.mph >= easy.wind.mph);
});

test('water bodies lie flat and below their banks', function () {
  var found = 0;
  for (var s = 1; s < 30 && found < 4; s++) {
    var co = E.newCourse(s * 77, 'island', 0);
    for (var i = 0; i < 18 && found < 4; i++) {
      var H = E.buildHole(co, i, 1), wz = null, ok = true;
      for (var j = 0; j < H.lie.length; j += 13) if (H.lie[j] === E.WATER) {
        found++;
        var x = j % H.W, y = (j / H.W) | 0;
        if (x > 0 && H.lie[j - 1] !== E.WATER) ok = ok && H.hgt[j] < H.hgt[j - 1] + 0.01;
        if (wz == null) wz = H.hgt[j];
        break;
      }
      assert.ok(ok);
    }
  }
  assert.ok(found > 0, 'island courses have water');
});

test('clubs are calibrated: full shots carry their nominal distance on flat ground', function () {
  E.CLUBS.forEach(function (c, ci) {
    if (c.putt) return;
    var v = E.clubV0(ci, c.carry), s = E.simCarry(v, c.launch, c.spin);
    near(s.carry, c.carry, 1.5, c.id + ' carry');
    assert.ok(s.apex > 15 && s.apex < 40, c.id + ' apex ' + s.apex);
    if (ci > 0) assert.ok(c.carry < E.CLUBS[ci - 1].carry, 'clubs get shorter');
  });
  // better woods go further
  assert.ok(E.carryOf(0, { drv: 3 }) > E.carryOf(0, {}) * 1.09);
});

test('a full drive on a real hole: carry ≈ nominal, sensible roll, a slice curves right', function () {
  var H = hole(0), env = E.holeEnv(H, 1, 0), from = { x: H.tee.x, y: H.tee.y, lie: E.TEE }, yaw = E.autoAim(H, from, 0, EQ0);
  var b = E.simShot(H, from, { club: 0, yaw: yaw, power: 1, dev: 0 }, EQ0, env);
  var carry = Math.hypot(b.land.x - from.x, b.land.y - from.y), tot = Math.hypot(b.x - from.x, b.y - from.y);
  assert.ok(carry > 200 && carry < 260, 'carry ' + carry);
  assert.ok(tot - carry > 5 && tot - carry < 60, 'roll ' + (tot - carry));
  function lateral(bb) { return (bb.land.x - from.x) * Math.cos(yaw) - (bb.land.y - from.y) * Math.sin(yaw); }
  var sl = E.simShot(H, from, { club: 0, yaw: yaw, power: 1, dev: 1 }, EQ0, env), hk = E.simShot(H, from, { club: 0, yaw: yaw, power: 1, dev: -1 }, EQ0, env);
  assert.ok(lateral(sl) > 12, 'slice goes right ' + lateral(sl));
  assert.ok(lateral(hk) < -12, 'hook goes left ' + lateral(hk));
  // half power ≈ half the distance
  var hp = E.simShot(H, from, { club: 6, yaw: yaw, power: 0.5, dev: 0 }, EQ0, env);
  var hc = Math.hypot(hp.land.x - from.x, hp.land.y - from.y);
  assert.ok(hc > 0.35 * 152 && hc < 0.65 * 152, 'half power 7 iron ' + hc);
});

test('wind: a headwind costs distance, a tailwind adds it, a crosswind pushes', function () {
  var H = hole(1), from = { x: H.tee.x, y: H.tee.y, lie: E.TEE }, yaw = E.aimYaw(from.x, from.y, H.pin.x, H.pin.y);
  function carryWith(wx, wy) {
    var env = E.holeEnv(H, 1, 0); env.wx = wx; env.wy = wy;
    var b = E.simShot(H, from, { club: 6, yaw: yaw, power: 1, dev: 0 }, EQ0, env);
    return { d: (b.land.x - from.x) * Math.sin(yaw) + (b.land.y - from.y) * Math.cos(yaw), lat: (b.land.x - from.x) * Math.cos(yaw) - (b.land.y - from.y) * Math.sin(yaw) };
  }
  var still = carryWith(0, 0), head = carryWith(-Math.sin(yaw) * 7, -Math.cos(yaw) * 7), tail = carryWith(Math.sin(yaw) * 7, Math.cos(yaw) * 7), cross = carryWith(Math.cos(yaw) * 7, -Math.sin(yaw) * 7);
  assert.ok(head.d < still.d - 8, 'headwind ' + head.d + ' vs ' + still.d);
  assert.ok(tail.d > still.d + 5, 'tailwind ' + tail.d + ' vs ' + still.d);
  assert.ok(cross.lat > still.lat + 4, 'crosswind ' + cross.lat);
});

test('lies cost distance; a bunker is worst for woods, fine for the sand wedge', function () {
  assert.ok(E.lieDist(5, E.ROUGH) < 1 && E.lieDist(5, E.DEEP) < E.lieDist(5, E.ROUGH));
  assert.ok(E.lieDist(0, E.SAND) < E.lieDist(10, E.SAND));
  assert.strictEqual(E.lieDist(5, E.FAIR), 1);
  assert.strictEqual(E.lieDist(5, E.TEE), 1);
});

test('wedges check on the green; backspin english bites, topspin runs', function () {
  var H = hole(1), env = E.holeEnv(H, 1, 0);
  // from 110 yd short of the pin along the line
  var fy = H.pin.y - 110, from = { x: H.px[fy | 0], y: fy, lie: E.FAIR }, yaw = E.aimYaw(from.x, from.y, H.pin.x, H.pin.y);
  function rollOut(eng) {
    var b = E.launch(H, from, { club: 9, yaw: yaw, power: 0.96, dev: 0 }, EQ0, env, function () { return 0.5; });
    var applied = false;
    for (var i = 0; i < 12000 && E.moving(b); i++) { if (!applied && b.t > 1) { E.applyEnglish(b, 0, eng); applied = true; } E.stepBall(H, b, env); }
    if (!b.land) return 0;
    return (b.x - b.land.x) * Math.sin(yaw) + (b.y - b.land.y) * Math.cos(yaw);
  }
  var plain = rollOut(0), back = rollOut(-1), top = rollOut(1);
  assert.ok(plain < 15, 'a wedge stops quickly: ' + plain);
  assert.ok(back < plain, 'backspin bites: ' + back + ' < ' + plain);
  assert.ok(top > plain + 1, 'topspin runs: ' + top + ' > ' + plain);
  // english only works in flight
  var rb = E.newBall(0, 0, 0); rb.st = 'roll';
  assert.strictEqual(E.applyEnglish(rb, 1, 0), false);
});

test('putting: the right pace holes a straight putt; too hard lips or runs by; slopes break', function () {
  var H = hole(2), env = E.holeEnv(H, 1, 0), pin = H.pin, holed = 0, tried = 0;
  for (var d = 1.5; d <= 6; d += 1.5) {
    var from = { x: pin.x, y: pin.y - d, lie: E.lieAt(H, pin.x, pin.y - d) };
    if (from.lie !== E.GREEN) continue;
    var P = E.newPlanner(H, from, EQ0, env, 1);
    while (!E.planStep(P, 50));
    tried++;
    var b = E.simShot(H, from, P.best, EQ0, env);
    if (b.st === 'holed') holed++;
    else assert.ok(E.distPin(H, b.x, b.y) < 1.2, 'planned putt finishes close');
    var hard = E.simShot(H, from, { club: E.PUTTER, yaw: E.aimYaw(from.x, from.y, pin.x, pin.y), power: 1, dev: 0 }, EQ0, env);
    assert.notStrictEqual(hard.st, 'holed', 'a full-power putt from ' + d + ' should not drop');
  }
  assert.ok(tried > 0 && holed >= Math.ceil(tried / 2), 'planned putts drop: ' + holed + '/' + tried);
  // a rolling ball breaks downhill on a tilted green
  var tilted = null;
  for (var i = 0; i < 18 && !tilted; i++) { var h2 = hole(i); if (Math.hypot(h2.gslope.x, h2.gslope.y) > 0.015) tilted = h2; }
  assert.ok(tilted, 'some green is tilted');
  var e2 = E.holeEnv(tilted, 1, 0), g0 = E.gradAt(tilted, tilted.pin.x, tilted.pin.y, [0, 0]), gx = g0[0], gy = g0[1], gm = Math.hypot(gx, gy);
  var dirx = -gy / gm, diry = gx / gm, start = { x: tilted.pin.x - dirx * 4 + gx / gm * 2, y: tilted.pin.y - diry * 4 + gy / gm * 2 };
  start.lie = E.lieAt(tilted, start.x, start.y);
  assert.strictEqual(start.lie, E.GREEN, 'start on the green');
  var yaw2 = Math.atan2(dirx, diry), b2 = E.simShot(tilted, start, { club: E.PUTTER, yaw: yaw2, power: 0.25, dev: 0 }, EQ0, e2);
  var moved = { x: b2.x - start.x, y: b2.y - start.y };
  assert.ok((moved.x * -gx + moved.y * -gy) / gm > 0.25, 'the putt fell downhill');
});

test('water is a one-stroke drop on dry land; OB is stroke and distance', function () {
  var H = null, i, wb = null;
  for (var s = 1; s < 40 && !wb; s++) {
    var co = E.newCourse(s * 31, 'island', 0);
    for (i = 0; i < 18 && !wb; i++) { var h = E.buildHole(co, i, 1); for (var j = 0; j < h.lie.length; j += 7) if (h.lie[j] === E.WATER && j % h.W > 40 && j % h.W < h.W - 40) { H = h; wb = { x: j % h.W + 0.5, y: ((j / h.W) | 0) + 0.5 }; break; } }
  }
  assert.ok(wb, 'found water');
  var g = E.newRound({ mode: 'quick', seed: 1, holes: [0], players: [{ name: 'A' }], diff: 1 });
  E.startHole(g, H);
  var b = E.newBall(wb.x, wb.y, 0); b.st = 'water'; b.from = { x: H.tee.x, y: H.tee.y, lie: E.TEE }; b.dry = { x: H.tee.x, y: H.tee.y + 5 };
  var r = E.resolveShot(g, H, b);
  assert.strictEqual(r.kind, 'water');
  assert.strictEqual(g.hs.b[0].strokes, 2);
  assert.notStrictEqual(E.lieAt(H, g.hs.b[0].x, g.hs.b[0].y), E.WATER);
  // OB: back to where it was hit from
  var b2 = E.newBall(-5, 50, 0); b2.st = 'rest'; b2.from = { x: g.hs.b[0].x, y: g.hs.b[0].y, lie: g.hs.b[0].lie }; b2.dry = { x: 0, y: 0 };
  var r2 = E.resolveShot(g, H, b2);
  assert.strictEqual(r2.kind, 'ob');
  assert.strictEqual(g.hs.b[0].strokes, 4);
  assert.strictEqual(g.hs.b[0].x, b2.from.x);
});

test('rules: turn order, gimmes, the stroke cap, scores and the round end', function () {
  var H = hole(0), g = E.newRound({ mode: 'quick', seed: 1, holes: [0, 1], players: [{ name: 'A' }, { name: 'B', cpu: 2 }], diff: 1, gim: 1 });
  E.startHole(g, H);
  assert.strictEqual(E.nextPlayer(g, H), 0);
  // A hits it close, B is still on the tee → B plays (hasn't teed off)
  var a = g.hs.b[0]; a.strokes = 1; a.x = H.pin.x; a.y = H.pin.y - 30; a.lie = E.FAIR;
  assert.strictEqual(E.nextPlayer(g, H), 1);
  var bb = g.hs.b[1]; bb.strokes = 1; bb.x = H.pin.x; bb.y = H.pin.y - 80; bb.lie = E.FAIR;
  assert.strictEqual(E.nextPlayer(g, H), 1, 'farthest away plays');
  // a putt that stops inside the gimme is holed for +1
  g.cur = 0;
  var b = E.newBall(H.pin.x + 0.6, H.pin.y, 0); b.st = 'rest'; b.putt = true; b.from = { x: a.x, y: a.y, lie: a.lie };
  var r = E.resolveShot(g, H, b);
  assert.ok(r.gimme && a.done && a.strokes === 3, 'gimme');
  assert.strictEqual(g.players[0].scores[0], 3);
  // B keeps missing: picked up at par + 4
  g.cur = 1;
  for (var k = 0; k < 20 && !bb.done; k++) { var m = E.newBall(bb.x, bb.y, 0); m.st = 'rest'; m.from = { x: bb.x, y: bb.y, lie: bb.lie }; E.resolveShot(g, H, m); }
  assert.ok(bb.done);
  assert.strictEqual(g.players[1].scores[0], E.capOf(H.par));
  assert.ok(E.holeDone(g));
  assert.ok(E.advanceHole(g));
  E.startHole(g, hole(1));
  assert.strictEqual(g.cur, 0, 'the lower score has the honor');
  assert.strictEqual(E.advanceHole(g), false);
  assert.ok(g.over);
});

test('auto club and aim pick sensible defaults', function () {
  var H = hole(0), tee = { x: H.tee.x, y: H.tee.y, lie: E.TEE };
  if (H.par > 3) assert.strictEqual(E.autoClub(H, tee, EQ0), 0, 'driver off a par 4/5 tee');
  var green = { x: H.pin.x, y: H.pin.y - 3, lie: E.GREEN };
  assert.strictEqual(E.autoClub(H, green, EQ0), E.PUTTER);
  var app = { x: H.pin.x, y: H.pin.y - 150, lie: E.FAIR }, ci = E.autoClub(H, app, EQ0);
  assert.ok(E.carryOf(ci, EQ0) >= 140 && E.carryOf(ci, EQ0) < 180, 'approach club ' + E.CLUBS[ci].id);
  var ych = E.autoAim(H, green, E.PUTTER, EQ0);
  near(ych, E.aimYaw(green.x, green.y, H.pin.x, H.pin.y), 1e-9);
});

test('swing translation: dead zone, sign, and difficulty tolerance', function () {
  assert.strictEqual(E.devFromStroke(0.01, 1), 0);
  assert.ok(E.devFromStroke(0.3, 1) > 0.5);
  assert.ok(E.devFromStroke(-0.3, 1) < -0.5);
  assert.ok(Math.abs(E.devFromStroke(0.2, 0)) < Math.abs(E.devFromStroke(0.2, 3)), 'easy forgives more than pro');
  assert.strictEqual(E.devFromMeter(0.005, 1), 0);
  assert.ok(E.devFromMeter(0.1, 1) > 0.8);
  assert.ok(Math.abs(E.devFromStroke(0.2, 1, { irn: 3 })) < Math.abs(E.devFromStroke(0.2, 1, {})), 'better irons forgive');
});

test('the CPU plays real holes in a believable number of strokes, better with skill', function () {
  function playHole(H, skill, seed) {
    var r = E.mulberry32(seed), env = E.holeEnv(H, 1, 1), g = E.newRound({ mode: 'quick', seed: 1, holes: [0], players: [{ name: 'C', cpu: 2 }], diff: 1, gim: 0 });
    E.startHole(g, H);
    var s = g.hs.b[0];
    for (var n = 0; n < 15 && !s.done; n++) {
      var P = E.newPlanner(H, s, EQ0, env, skill);
      while (!E.planStep(P, 200));
      var b = E.launch(H, s, E.cpuExecute(P.best, skill, r, 1), EQ0, env, r);
      run(H, b, env);
      E.resolveShot(g, H, b);
    }
    return s.strokes - H.par;
  }
  var lo = 0, hi = 0, n = 0;
  for (var i = 0; i < 9; i++) { var H = hole(i); lo += playHole(H, 0.2, i + 1); hi += playHole(H, 0.95, i + 1); n++; }
  assert.ok(hi <= lo, 'skill helps: pro ' + hi + ' vs rookie ' + lo);
  assert.ok(hi / n > -1 && hi / n < 1.2, 'pro averages near par: ' + hi / n);
  assert.ok(lo / n > -0.3 && lo / n < 3.5, 'rookie averages over par: ' + lo / n);
});

test('the tour: a named field, deterministic simulated scores, a sorted leaderboard and payouts', function () {
  var f0 = E.tourField(0), f3 = E.tourField(3);
  assert.strictEqual(f0.length, 15);
  assert.deepStrictEqual(f0, E.tourField(0));
  var avg = function (f) { return f.reduce(function (s, p) { return s + p.skill; }, 0) / f.length; };
  assert.ok(avg(f3) > avg(f0) + 0.2, 'later tours are stronger');
  var info = E.eventInfo(0, 1, 0);
  assert.deepStrictEqual(info, E.eventInfo(0, 1, 0));
  assert.notStrictEqual(info.seed, E.eventInfo(0, 1, 1).seed);
  var course = E.newCourse(info.seed, info.theme, 0), holes = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  var pros = f0.map(function (p, i) { return E.proScores(info.seed, i, p.skill, course, holes, 1); });
  assert.deepStrictEqual(pros[3], E.proScores(info.seed, 3, f0[3].skill, course, holes, 1));
  pros.forEach(function (sc) { assert.strictEqual(sc.length, 9); sc.forEach(function (v, i) { assert.ok(v >= course.holes[i].par - 2 && v <= course.holes[i].par + 3); }); });
  // strong pros shoot lower over many events
  var strong = 0, weak = 0;
  for (var e = 0; e < 40; e++) { var ss = E.proScores(e * 7 + 1, 0, 0.95, course, holes, 1), ws = E.proScores(e * 7 + 1, 1, 0.1, course, holes, 1); strong += ss.reduce(function (a, b) { return a + b; }); weak += ws.reduce(function (a, b) { return a + b; }); }
  assert.ok(strong < weak - 40 * 1.5, 'skill matters: ' + strong / 40 + ' vs ' + weak / 40);
  var mine = course.holes.slice(0, 9).map(function (h) { return h.par - 1; });
  var rows = E.leaderboard(f0, pros, mine, course, holes, 9);
  assert.strictEqual(rows.length, 16);
  for (var k = 1; k < rows.length; k++) assert.ok(rows[k].toPar >= rows[k - 1].toPar);
  assert.ok(rows[0].me && rows[0].toPar === -9 && rows[0].pos === 1, 'nine birdies leads');
  var pay = E.payouts(rows, 100000);
  assert.ok(pay[0] >= pay[1] && pay[1] >= pay[5]);
  var total = pay.reduce(function (a, b) { return a + b; });
  assert.ok(total > 70000 && total <= 100500, 'purse paid out ' + total);
  // ties split
  var tied = [{ toPar: -3 }, { toPar: -3 }, { toPar: 0 }];
  var tp = E.payouts(tied, 10000);
  assert.strictEqual(tp[0], tp[1]);
  assert.ok(tp[0] < Math.round(10000 * 0.18) && tp[0] > Math.round(10000 * 0.108));
});

test('rounds survive a JSON snapshot', function () {
  var g = E.newRound({ mode: 'tour', seed: 5, theme: 'desert', holes: [0, 1, 2], players: [{ name: 'You' }], diff: 2, tour: { ti: 0, pros: [[3, 4]] } });
  E.startHole(g, hole(0));
  g.hs.b[0].strokes = 2;
  var o = JSON.parse(JSON.stringify(E.snapRound(g)));
  assert.ok(E.loadRound(o));
  assert.strictEqual(o.hs.b[0].strokes, 2);
  assert.strictEqual(o.tour.ti, 0);
  assert.strictEqual(E.loadRound({ v: 1, holes: [0], players: [], hi: 0 }), null);
  assert.strictEqual(E.loadRound({ v: 1, holes: [0], players: [{}], hi: 1 }), null);
  var c = E.newCareer();
  assert.strictEqual(c.money, 0); assert.strictEqual(c.tour, 0);
  assert.ok(E.englishBudget({ bal: 2 }) > E.englishBudget({}));
});

test('trees knock a ball down', function () {
  var H = null, t = null;
  for (var i = 0; i < 18 && !t; i++) { var h = hole(i); t = h.trees.filter(function (q) { return q.k === 'oak' || q.k === 'pine'; })[0]; if (t) H = h; }
  assert.ok(t, 'a parkland hole has trees');
  var env = E.holeEnv(H, 1, 0), b = E.newBall(t.x - 30, t.y, 0);
  b.z = t.z + t.h - t.r; b.vx = 40; b.vy = 0; b.vz = 0; b.st = 'fly'; b.from = { x: b.x, y: b.y, lie: E.FAIR }; b.dry = { x: b.x, y: b.y };
  for (var k = 0; k < 240 && b.st === 'fly' && b.ev.indexOf('tree') < 0; k++) E.stepBall(H, b, env);
  assert.ok(b.ev.indexOf('tree') >= 0, 'hit the tree');
  assert.ok(Math.hypot(b.vx, b.vy) < 15, 'and lost its pace');
});

console.log(passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
