/* Headless checks for the Factory Lines engine (rules, machines, logistics, levels, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/factory/factory.test.js */
'use strict';
var assert = require('assert');

// The module exports its pure engine for node (no DOM, no Cade needed)…
var E = require('./factory.js');
// …and registers the same engine on the widget when a Cade core is present.
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./factory.js')];
require('./factory.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}

// Reference solutions, one per level (rows of tokens: '.' or piece code + arrow).
var SOL = {
  belt: ['', '', '. e> b> b> b> b> b> . .'],
  detour: ['. . . b> b> b> bv . .', '. e> b> b^ . . bv . .', '. . . . . . bv . .', '. . . . . . b> . .'],
  merge: ['', '. e> m> b> b> b> b> b> bv .', '. . b^ . . . . . bv .', '. . b^', '. . b^', '. e> b^'],
  smelt: ['', '. ev', '. Sv', '. b> b> b> b> b> b> b> b>'],
  rich: ['', '', '. e> b> b> b> b> b> b> bv', '. . . . . . . . b> s> Sv', '. . . . . . . . . S>'],
  twin: ['', '', '. . . . . . . . . S^', '. e> b> b> b> b> b> b> b> s>', '. . . . . . . . . Sv'],
  gears: ['', '. e> S> C> b> b> b> b> b> bv', '. . . . . . . . . bv', '. . . . . . . . . bv', '. . . . . . . . . b<'],
  wire: ['', '. ev', '. Sv', '. Cv', '. bv', '. bv', '. b> b> b> b> b> b> b> b> b> b^'],
  cross: ['', '. e> b> b> b> b> bv . . . b>', '. . . . . . bv . . . b^', '. b> b> b> b> b> x> b> b> b> b^', '. e^ . . . . b> b> b> b> b>', ''],
  motor: ['', '. e> S> C> b> b> b> b> b> bv', '. . . . . . . . . bv', '. . . . . . . . . bv', '. . . . . . . . . A>', '. . . . . . . . . b^', '. e> S> C> b> b> b> b> b> b^'],
  lamp: ['. . . . . . b> b> b> bv', '. e> S> b> b> b> b^ . . bv', '. . . . . . . . . bv', '. . . . . . . . . bv', '. . . . . . b> b> b> A>', '. . . . . . b^', '. e> S> C> b> b> b^'],
  paint: ['', '. e> S> C> b> b> b> b> bv', '. . . . . . . . bv', '. . . . . . . . P>', '. . . . . . . . b^', '. e> b> b> b> b> b> b> b^'],
  twotone: ['', '. e> b> b> b> b> b> b> b> b> P>', '. . . . . . . . . . b^', '. . . . . . . . . . b^', '. e> S> C> b> b> b> b> b> b> s>', '. . . . . . . . . . bv', '. . . . . . . . . . bv', '. e> b> b> b> b> b> b> b> b> P>'],
  frame: ['', '. e> S> b> b> b> b> b> b> b> bv', '. . . . . . . . . . bv', '. . . . . . . . . b> A>', '. . . C> b> b> b> b> b> b^ b^', '. e> S> s> b> b> b> b> b> b> b^'],
  double: ['', '. e> S> C> b> b> b> b> b> b> b> b> bv', '. . . . . . . . . . . . sv bv', '. . . . . . . . . . . b> Av bv', '. . . . . . . . . . . b^ . bv', '. . . . . . . . . . . b^ A^ b<', '. . . . . . . . . . . b^ s^', '. e> S> C> b> b> b> b> b> b> b> b> b^'],
  robot: ['', '. e> S> C> b> b> b> b> b> b> b> bv', '. . . . . . . . . . . bv', '. . . . . . . . . . . bv', '. e> S> C> b> b> b> b> b> b> bv bv', '. . . . . . . . bv b< sv bv', '. . . . . . . . bv . b> Av', '. e> S> b> b> b> b> b> x> b> A> A>', '. . . . . . . . b> b> b^', '']
};
// a scratch level from map rows (sandbox rules unless goals given)
function mk(map, goals) { return { id: 't', name: 't', map: map, tools: E.PIECE_ORDER, goals: goals || [], sandbox: !goals, par: { cost: 0, tiles: 0 } }; }
function run(lv, rows, n) { var L = E.fromRows(lv, rows), sim = E.newSim(lv, L); for (var i = 0; i < n; i++) E.step(sim); return sim; }
function box(sim, k) { return sim.box[k] || 0; }

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Factory Lines' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'factory.css');
  assert.strictEqual(widget._engine.LEVELS.length, E.LEVELS.length);
});

test('levels: well-formed maps, goals, tools, unique ids', function () {
  var ids = {};
  assert.ok(E.LEVELS.length >= 15, '15+ levels');
  E.LEVELS.concat([E.SANDBOX]).forEach(function (lv) {
    assert.ok(!ids[lv.id], 'unique id ' + lv.id); ids[lv.id] = 1;
    var w = lv.map[0].length;
    lv.map.forEach(function (r) { assert.strictEqual(r.length, w, lv.id + ' rectangular'); assert.ok(/^[.#iIcsrbP1-4]+$/.test(r), lv.id + ' tiles'); });
    lv.tools.forEach(function (t) { assert.ok(E.PIECES[t], lv.id + ' tool ' + t); });
    lv.goals.forEach(function (g) {
      assert.ok(E.ITEMS[g.item] && g.n > 0 && g.rate > 0, lv.id + ' goal');
      var pc = g.port ? String(g.port) : 'P';
      assert.ok(lv.map.join('').indexOf(pc) >= 0, lv.id + ' has the port for its goal');
    });
    if (!lv.sandbox) assert.ok(lv.goals.length && lv.par.cost > 0 && lv.par.tiles > 0 && lv.intro, lv.id + ' goals/par/intro');
  });
});

test('every level is solvable at par (3 stars) by its reference solution', function () {
  E.LEVELS.forEach(function (lv) {
    var L = E.fromRows(lv, SOL[lv.id]);
    assert.ok(L, lv.id + ' decodes');
    var sim = E.simulate(lv, L, 3000), st = E.stats(L);
    assert.ok(sim.won > 0, lv.id + ' wins');
    assert.ok(sim.won < 400, lv.id + ' wins reasonably fast (' + sim.won + ')');
    assert.strictEqual(st.cost, lv.par.cost, lv.id + ' par cost');
    assert.strictEqual(st.tiles, lv.par.tiles, lv.id + ' par tiles');
    assert.strictEqual(E.starsFor(lv, st), 3);
  });
});

test('a short line misses the rate: the merge level needs both seams', function () {
  var lv = E.levelById('merge');
  var one = E.fromRows(lv, ['', '. e> b> b> b> b> b> b> bv .', '. . . . . . . . bv .']);
  var sim = E.simulate(lv, one, 2000);
  assert.strictEqual(sim.won, 0);
  assert.ok(sim.goals[0].got >= 20, 'count reached');
  assert.strictEqual(E.rateOf(sim.goals[0].ring), 15, 'one extractor is 15/min');
});

test('determinism: same layout, same state; encode/decode round-trips', function () {
  var lv = E.levelById('robot'), L = E.fromRows(lv, SOL.robot);
  var a = E.newSim(lv, L), b = E.newSim(lv, E.decode(lv, E.encode(lv, L)));
  for (var i = 0; i < 400; i++) { E.step(a); E.step(b); }
  assert.strictEqual(E.digest(a), E.digest(b));
  assert.strictEqual(E.encode(lv, E.decode(lv, E.encode(lv, L))), E.encode(lv, L));
  assert.strictEqual(E.decode(lv, 'nope'), null);
  assert.strictEqual(E.decode(lv, E.encode(lv, L).replace('e>', 'Z>')), null);
});

test('placement rules: extractor on ore only; nothing on rock or ports; ports only in the sandbox', function () {
  var lv = E.levelById('detour');
  assert.ok(E.canPlace(lv, 1, 1, 'extractor'));
  assert.ok(!E.canPlace(lv, 2, 1, 'extractor'));
  assert.ok(!E.canPlace(lv, 4, 1, 'belt'), 'rock');
  assert.ok(!E.canPlace(lv, 7, 3, 'belt'), 'port');
  assert.ok(!E.canPlace(lv, 2, 2, 'port'));
  assert.ok(!E.canPlace(lv, -1, 0, 'belt') && !E.canPlace(lv, 99, 0, 'belt'));
  assert.ok(E.canPlace(E.SANDBOX, 0, 0, 'port'));
  // a saved layout with a piece on rock drops that piece
  var str = E.encode(lv, E.emptyLayout(lv)).split('');
  str[(1 * 9 + 4) * 2] = 'b'; str[(1 * 9 + 4) * 2 + 1] = '>';
  var L = E.decode(lv, str.join(''));
  assert.ok(L && !L[1 * 9 + 4]);
});

test('belts move one tile per tick; a packed line carries 60/min', function () {
  var lv = mk(['I.....D'.replace('D', '.')]);
  var sim = run(lv, ['e> b> b> b> b> b> D>'], 200);
  assert.strictEqual(E.rateOf(sim.ents[sim.ents.length - 1].rin), 30, 'rich ore: 30/min');
  // first ore: mined at tick 2, then 6 hops to the port
  var s2 = E.newSim(lv, E.fromRows(lv, ['e> b> b> b> b> b> D>'])), t = 0;
  while (!box(s2, 'fe') && t < 50) { E.step(s2); t++; }
  assert.strictEqual(t, 8);
  // two rich extractors merged fill a belt completely
  var lv2 = mk(['I......', 'I......']);
  var sim2 = run(lv2, ['e> m> b> b> b> b> D>', 'e> m^'], 300);
  // second merger feeds into the first's side
  assert.strictEqual(E.rateOf(sim2.ents.filter(function (e) { return e.t === 'port'; })[0].rin), 60);
});

test('belt input rules: behind first, a corner from one side, never two', function () {
  // a T: two lines from both sides into a belt with nothing behind it — only one is taken (the left)
  var lv = mk(['.i.', '...', '.i.', '...']);
  var sim = run(lv, ['. ev .', '. b> D>', '. e^ .'], 200);
  var b = sim.ents.filter(function (e) { return e.t === 'belt'; })[0];
  assert.strictEqual(b.inSide, 3, 'left of an east belt is north');
  assert.ok(box(sim, 'fe') >= 45, 'the north line flows');
  var south = sim.ents.filter(function (e) { return e.t === 'extractor' && e.y === 2; })[0];
  assert.strictEqual(south.made, 2, 'the other side backs up after two (its buffer)');
  // with a feeder behind, the side is ignored
  var lv2 = mk(['.i..', 'i...', '....']);
  var sim2 = run(lv2, ['. ev . .', 'e> b> D>'], 200);
  var belt = sim2.ents.filter(function (e) { return e.t === 'belt'; })[0];
  assert.strictEqual(belt.inSide, 2);
  assert.strictEqual(box(sim2, 'fe'), 49);
});

test('merger takes its inputs in turn', function () {
  var lv = mk(['I..', '...', 'I..'], null);
  lv.map = ['.I...', '.....', '.I...'];
  var sim = run(lv, ['. ev', '. m> b> D>', '. e^'], 600);
  var ex = sim.ents.filter(function (e) { return e.t === 'extractor'; });
  assert.ok(Math.abs(ex[0].made - ex[1].made) <= 2, 'fair: ' + ex[0].made + ' vs ' + ex[1].made);
  assert.ok(box(sim, 'fe') > 550, 'a full belt');
});

test('splitter deals in turn and skips outputs that refuse the item', function () {
  var lv = mk(['.....', 'I....', '.....']);
  var sim = run(lv, ['. . D^', 'e> b> s> D>', '. . Dv'], 400);
  var ports = sim.ents.filter(function (e) { return e.t === 'port'; });
  var got = ports.map(function (p) { return p.recv; });
  assert.ok(Math.max.apply(null, got) - Math.min.apply(null, got) <= 1, 'even three ways: ' + got);
  // level ports only accept their goal's item: the splitter sorts by skipping the wrong one
  var lv3 = { id: 't3', map: ['...1', 'i...', '.c.2'], goals: [{ item: 'fe', n: 8, rate: 4, port: 1 }, { item: 'cu', n: 8, rate: 4, port: 2 }], tools: E.PIECE_ORDER, par: { cost: 1, tiles: 1 } };
  var s3 = E.newSim(lv3, E.fromRows(lv3, ['. . . .', 'e> m> b> s>', '. e^ . .']));
  for (var i = 0; i < 600 && !s3.won; i++) E.step(s3);
  assert.ok(s3.won > 0, 'mixed line sorted into two typed ports by a splitter');
});

test('a port refuses items it does not want and the line backs up', function () {
  var lv = { id: 't4', map: ['c..P'], goals: [{ item: 'fe', n: 1, rate: 1 }], tools: E.PIECE_ORDER, par: { cost: 1, tiles: 1 } };
  var sim = run(lv, ['e> b> b>'], 200);
  assert.strictEqual(sim.goals[0].got, 0);
  assert.strictEqual(sim.delivered, 0);
  assert.ok(sim.ents[1].item && sim.ents[2].item, 'belts full');
  assert.strictEqual(E.status(sim.ents[0]), 'full');
});

test('machines: timings, two-for-one cutter, recipes, no input from the front', function () {
  var lv = mk(['i......']);
  var sim = run(lv, ['e> S> D>'], 600);
  assert.strictEqual(E.rateOf(sim.ents[2].rin), 15, 'smelter keeps up with an extractor');
  assert.strictEqual(box(sim, 'plate'), sim.ents[1].made - sim.ents[1].out.length);
  var sim2 = run(lv, ['e> S> C> D>'], 600);
  assert.strictEqual(E.rateOf(sim2.ents[3].rin), 20, 'cutter: 10 plates/min into 20 gears/min');
  assert.strictEqual(E.rateOf(sim2.ents[1].ring), 10, 'the smelter is held back to the slower cutter');
  assert.strictEqual(E.rateOf(sim2.ents[0].ring), 10, '…and so is the extractor');
  // a machine facing the line refuses it
  var sim3 = run(mk(['i....']), ['e> S< D>'], 100);
  assert.strictEqual(sim3.ents[1].made, 0);
  // assembler: gear + wire -> motor, glass + 2 wire -> lamp
  var lv4 = mk(['i....', '.....', 'c....']);
  var sim4 = run(lv4, ['e> S> C> bv', '. . . A> D>', 'e> S> C> b^'], 900);
  assert.ok(box(sim4, 'motor') >= 100, 'motors: ' + box(sim4, 'motor'));
  var lv5 = mk(['s....', '.....', 'c....']);
  var sim5 = run(lv5, ['e> S> b> bv', '. . . A> D>', 'e> S> C> b^'], 900);
  assert.ok(box(sim5, 'lamp') > 60 && !box(sim5, 'motor'));
  var a5 = sim5.ents.filter(function (e) { return e.t === 'assembler'; })[0];
  assert.ok(a5.buf.wire <= E.INCAP.assembler.wire && a5.buf.glass <= E.INCAP.assembler.glass, 'buffers capped');
});

test('painter: item + dye; dye colour decides; painted items are not repainted', function () {
  var lv = mk(['i....', '.....', 'b....']);
  var sim = run(lv, ['e> S> C> bv', '. . . P> D>', 'e> b> b> b^'], 600);
  assert.ok(box(sim, 'gear_b') > 80 && !box(sim, 'gear_r'));
  assert.ok(E.INCAP.painter.gear && !E.INCAP.painter.gear_b);
});

test('crossing: two lines pass without mixing', function () {
  var lv = { id: 't5', map: ['.i...', '.....', 'c...1', '.....', '.2...'], goals: [{ item: 'fe', n: 30, rate: 10, port: 2 }, { item: 'cu', n: 30, rate: 10, port: 1 }], tools: E.PIECE_ORDER, par: { cost: 1, tiles: 1 } };
  var L = E.fromRows(lv, ['. ev', '. bv', 'e> x> b> b>', '. bv', '']);
  var sim = E.simulate(lv, L, 1000);
  assert.ok(sim.won > 0, 'both delivered through one crossing');
});

test('a closed belt loop never hangs the tick', function () {
  var lv = mk(['i...', '....', '....']);
  var sim = run(lv, ['e> m> bv', '. b^ b<'], 500);
  assert.strictEqual(sim.tick, 500);
  var held = sim.ents.filter(function (e) { return e.item; }).length;
  assert.ok(held >= 3, 'the loop fills up');
});

test('item conservation along a line', function () {
  var lv = mk(['i.........']);
  var sim = run(lv, ['e> b> b> S> b> b> C> b> b> D>'], 333);
  var ex = sim.ents[0], sm = sim.ents[3], cu = sim.ents[6];
  var onBelt = function (from, to) { var n = 0; for (var i = from; i <= to; i++) if (sim.ents[i].item) n++; return n; };
  // ore: mined = still in the extractor + on belts + in the smelter's buffer + smelted
  var smelted = sm.made + (sm.cur ? 1 : 0);
  assert.strictEqual(ex.made, ex.out.length + onBelt(1, 2) + (sm.buf.fe || 0) + smelted);
  var plates = cu.made / 2 + (cu.cur ? 1 : 0);
  assert.strictEqual(sm.made, sm.out.length + onBelt(4, 5) + (cu.buf.plate || 0) + plates);
  assert.strictEqual(cu.made, cu.out.length + onBelt(7, 8) + box(sim, 'gear'));
});

test('save: normalisation, records keep the best, unlocking', function () {
  var s = E.normSave(null);
  assert.deepStrictEqual(s, E.newSave());
  var lv = E.levelById('belt'), L = E.fromRows(lv, SOL.belt);
  var r = E.record(s, lv, L, 46);
  assert.ok(r.first && r.stars === 3 && s.lv.belt.best);
  var worse = E.fromRows(lv, ['', '', '. e> b> b> b> b> b> . .', '. b> b>']);
  var r2 = E.record(s, lv, worse, 50);
  assert.ok(!r2.newBest && s.lv.belt.cost === 11, 'a worse layout keeps the best');
  var n = E.normSave(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(n, s);
  var bad = E.normSave({ lv: { belt: { stars: 9, best: 'xx', work: 5 }, nope: { stars: 3 }, detour: 'x' }, sb: ['zz', 7], sbWork: 3, last: 'nope', seen: { belt: 1, nope: 1 }, speedIx: 99 });
  assert.ok(!bad.lv.nope && bad.lv.belt.stars === 0 && bad.lv.belt.best === '' && !bad.lv.detour);
  assert.deepStrictEqual(bad.sb, ['', '', '']);
  assert.ok(bad.last === 'belt' && bad.seen.belt && !bad.seen.nope && bad.speedIx === 1);
  // unlocking: the next unsolved level plus one beyond
  var u = E.newSave();
  assert.ok(E.unlocked(u, 0) && E.unlocked(u, 1) && !E.unlocked(u, 2));
  u.lv.belt = { stars: 1, best: E.encode(lv, L) };
  assert.ok(E.unlocked(u, 2) && !E.unlocked(u, 3));
  assert.strictEqual(E.totalStars(u), 1);
});

test('reference solutions only use the pieces their level offers', function () {
  E.LEVELS.forEach(function (lv) {
    E.fromRows(lv, SOL[lv.id]).forEach(function (p) { if (p) assert.ok(lv.tools.indexOf(p.t) >= 0, lv.id + ' offers ' + p.t); });
  });
});

test('a win is reported once, and the line keeps running afterwards', function () {
  var lv = E.levelById('belt'), sim = E.newSim(lv, E.fromRows(lv, SOL.belt)), wins = 0;
  for (var i = 0; i < 300; i++) { E.step(sim); if (sim.events.indexOf('win') >= 0) wins++; }
  assert.strictEqual(wins, 1);
  assert.ok(sim.won > 0 && sim.goals[0].got > 8, 'still delivering after the win');
});

test('an empty or broken layout never wins, and stepping it is safe', function () {
  E.LEVELS.forEach(function (lv) {
    var sim = E.simulate(lv, E.emptyLayout(lv), 200);
    assert.strictEqual(sim.won, 0, lv.id);
  });
  // belts pointing head-on, a splitter with no outputs, a machine with nothing ahead
  var lv2 = mk(['i.....', '......']);
  var sim2 = run(lv2, ['e> b> b< s> S>', '. . . . .'], 300);
  assert.strictEqual(sim2.tick, 300);
  assert.strictEqual(sim2.delivered, 0);
});

test('crossing: head-on lines block each other instead of swapping items', function () {
  var lv = mk(['i...i', '.....']);
  var sim = run(lv, ['e> b> x> b< e<'], 200);
  var x = sim.ents.filter(function (e) { return e.t === 'cross'; })[0];
  assert.ok(x.slots[0], 'one item sits in the crossing');
  assert.strictEqual(sim.delivered, 0);
});

test('painter colours robots and frames too', function () {
  var lv = mk(['......', '......']);
  lv.map = ['i.....', 'r.....'];
  // plates in, red dye in -> red plates
  var sim = run(lv, ['e> S> bv', 'e> b> P> D>'], 400);
  assert.ok(box(sim, 'plate_r') > 30, 'red plates: ' + box(sim, 'plate_r'));
  assert.ok(E.RECIPES.painter.some(function (r) { return r.out === 'robot_b'; }) && E.RECIPES.painter.some(function (r) { return r.out === 'frame_r'; }));
});

test('allSolved only when every level has stars', function () {
  var s = E.newSave();
  assert.ok(!E.allSolved(s));
  E.LEVELS.forEach(function (lv) { s.lv[lv.id] = { stars: 1 }; });
  assert.ok(E.allSolved(s));
  delete s.lv.double;
  assert.ok(!E.allSolved(s));
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
