/* Headless checks for the Escape Room engine (room data integrity, rules,
 * locks, walkthroughs, hints, timer, records, save normalisation).
 * Not loaded by the app. Run: node txt/widgets/escaperoom/escaperoom.test.js */
'use strict';
var assert = require('assert');

var E = require('./escaperoom.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./escaperoom.js')];
require('./escaperoom.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}

// Walkthroughs: 'look obj', 'use item obj', 'combine a b', 'lock id answer', 'view id'.
function wheelIdx(R, id, answer) {
  var L = R.locks[id], o = E.wheelOpts(L);
  return answer.map(function (a) { var i = o.indexOf(a); assert.ok(i >= 0, id + ': ' + a + ' not on wheel'); return i; });
}
function step(g, line) {
  var R = E.ROOM[g.room], p = line.split(' '), res;
  if (p[0] === 'look') res = E.interact(g, p[1]);
  else if (p[0] === 'use') res = E.interact(g, p[2], p[1]);
  else if (p[0] === 'combine') res = E.combine(g, p[1], p[2]);
  else if (p[0] === 'lock') {
    var L = R.locks[p[1]];
    res = E.tryLock(g, p[1], L.kind === 'wheels' ? wheelIdx(R, p[1], p.slice(2)) : p[2]);
    assert.ok(res.ok, 'lock ' + p[1] + ' should open with ' + p.slice(2).join(' '));
  } else throw new Error('bad step ' + line);
  assert.ok(res.hit, 'step did nothing: ' + line + ' → ' + res.say);
  return res;
}
var WALK = {
  study: [
    'look note', 'look face', 'look drawer', 'lock drawer 4 3 5', 'look coat', 'combine lens frame',
    'use loupe cabinet', 'look books', 'lock cabinet yellow blue red green', 'use crank clockbody',
    'look oddbook', 'combine note_a note_b', 'look tiles', 'lock keypad 2179', 'use brass_key door'],
  glass: [
    'look map', 'lock toolbox UUURRDRRUU', 'use tap_handle tap', 'look can', 'use can tap', 'use can_full potsrow',
    'lock seeds star clover moon sun', 'use can_full planter', 'use trowel planter', 'use gate_key keyhole',
    'lock padlock F E R N S'],
  observatory: [
    'look riddle', 'lock drawer 4 6 2', 'look lantern', 'combine matches lantern', 'use lantern_lit corner', 'look corner',
    'use ball orrery', 'use eyepiece telescope', 'lock aim RING', 'look starchart', 'lock cabinet square diamond circle triangle',
    'use crank hatch', 'lock keypad 3715']
};

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Escape Room' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'escaperoom.css');
  assert.strictEqual(widget._engine.COLS, E.COLS);
});

test('three original rooms with four walls each', function () {
  assert.ok(E.ROOMS.length >= 3);
  E.ROOMS.forEach(function (R) {
    assert.ok(R.views.length >= 4, R.id);
    R.views.forEach(function (V) { assert.strictEqual(V.art.length, E.ROWS, R.id + '/' + V.id + ' rows'); });
    assert.ok(Object.keys(R.locks).length >= 3, R.id + ' locks');
    assert.ok(R.puzzles.length >= 5, R.id + ' puzzles');
  });
});

test('every lock kind is used somewhere', function () {
  var styles = {};
  E.ROOMS.forEach(function (R) { for (var id in R.locks) { var L = R.locks[id]; styles[L.kind === 'wheels' ? L.style : L.kind] = 1; } });
  ['digit', 'colour', 'weather', 'shape', 'letter', 'keypad', 'dir'].forEach(function (k) { assert.ok(styles[k], k); });
});

// Static integrity: every id a rule refers to exists; every flag tested is set somewhere.
test('room data integrity', function () {
  E.ROOMS.forEach(function (R) {
    var sets = {}, tests = [], viewIds = R.views.map(function (v) { return v.id; });
    function acts(a, where) {
      E.toks(a).forEach(function (t) {
        var i = t.indexOf(':'), op = t.slice(0, i), arg = t.slice(i + 1);
        if (op === 'set') sets[arg] = 1;
        else if (op === 'give' || op === 'take') assert.ok(R.items[arg], where + ': item ' + arg);
        else if (op === 'lock') assert.ok(R.locks[arg], where + ': lock ' + arg);
        else if (op === 'zoom') assert.ok(R.zooms[arg], where + ': zoom ' + arg);
        else if (op === 'view') assert.ok(viewIds.indexOf(arg) >= 0, where + ': view ' + arg);
        else if (op !== 'clr' && op !== 'sfx') throw new Error(where + ': bad action ' + t);
      });
    }
    function conds(c, where) {
      E.toks(c).forEach(function (t) {
        t = t.replace(/^!/, '');
        if (t.charAt(0) === '@') assert.ok(R.items[t.slice(1)], where + ': item ' + t);
        else tests.push([t, where]);
      });
    }
    function rules(list, where) { (list || []).forEach(function (r) { conds(r.if, where); acts(r.do, where); }); }
    for (var id in R.objects) {
      var o = R.objects[id], a = o.at;
      assert.ok(viewIds.indexOf(o.view) >= 0, id + ' view');
      assert.ok(a[0] >= 0 && a[1] >= 0 && a[2] > 0 && a[3] > 0 && a[0] + a[2] <= E.COLS && a[1] + a[3] <= E.ROWS, R.id + '/' + id + ' hotspot in bounds');
      assert.ok(o.look && o.look.length, id + ' look');
      // the last look rule is unconditional, so a tap always says something
      assert.ok(!o.look[o.look.length - 1].if || o.look.length === 1, id + ' look fallback');
      conds(o.show, id);
      rules(o.look, id);
      for (var it in (o.use || {})) { assert.ok(R.items[it], id + ' use ' + it); rules(o.use[it], id + '+' + it); }
    }
    R.combos.forEach(function (c) { assert.ok(R.items[c.a] && R.items[c.b]); conds(c.if, 'combo'); acts(c.do, 'combo'); });
    for (var lid in R.locks) {
      var L = R.locks[lid];
      sets['open:' + lid] = 1;
      acts(L.open.do, 'lock ' + lid);
      (L.plates || []).forEach(function (p) { conds(p.if, 'plate'); });
      if (L.kind === 'wheels') assert.strictEqual(L.answer.length, L.n, lid);
      else assert.ok(L.answer.length <= L.n, lid);
    }
    for (var iid in R.items) if (R.items[iid].zoom) assert.ok(R.zooms[R.items[iid].zoom], iid);
    R.views.forEach(function (V) { (V.patches || []).forEach(function (p) { conds(p.if, V.id + ' patch'); }); });
    R.puzzles.forEach(function (p) { conds(p.avail, p.id); conds(p.done, p.id); assert.strictEqual(p.hints.length, 3, p.id + ' hints'); });
    conds(R.exit, 'exit');
    tests.forEach(function (t) { assert.ok(sets[t[0]], R.id + ': flag "' + t[0] + '" (' + t[1] + ') is never set'); });
  });
});

test('every room can be escaped by its walkthrough', function () {
  E.ROOMS.forEach(function (R) {
    var g = E.newGame(R.id), last;
    WALK[R.id].forEach(function (line) { assert.ok(!g.done, R.id + ' done too early at ' + line); last = step(g, line); });
    assert.ok(g.done && last.win, R.id + ' escaped');
    var pr = E.progress(g);
    assert.strictEqual(pr.done, pr.total, R.id + ' all puzzles done');
    assert.strictEqual(E.puzzlesOpen(g).length, 0);
  });
});

test('the walkthroughs touch every hotspot-free path: each lock has a wrong answer that fails', function () {
  E.ROOMS.forEach(function (R) {
    var g = E.newGame(R.id);
    for (var id in R.locks) {
      var L = R.locks[id], bad;
      if (L.kind === 'wheels') { bad = wheelIdx(R, id, L.answer); bad[0] = (bad[0] + 1) % E.wheelOpts(L).length; }
      else if (L.kind === 'keypad') bad = L.answer.slice(0, -1) + ((+L.answer.slice(-1) + 1) % 10);
      else bad = L.answer.slice(1);
      var r = E.tryLock(g, id, bad);
      assert.ok(!r.ok && r.say, R.id + '/' + id + ' rejects a wrong answer');
      assert.ok(!g.flags['open:' + id]);
    }
    assert.ok(g.tries >= Object.keys(R.locks).length);
  });
});

test('locks cannot be skipped: the exit needs every final step', function () {
  E.ROOMS.forEach(function (R) {
    var w = WALK[R.id];
    // drop the last step: still locked in
    var g = E.newGame(R.id);
    w.slice(0, -1).forEach(function (l) { step(g, l); });
    assert.ok(!g.done, R.id + ' not escaped without the last step');
    // an empty room: the exit is locked and tapping everything never escapes
    var g2 = E.newGame(R.id);
    for (var id in R.objects) { E.interact(g2, id); E.interact(g2, id); }
    assert.ok(!g2.done);
  });
});

test('fair clues: the answers are written in the room', function () {
  var S = E.ROOM.study, G = E.ROOM.glass, O = E.ROOM.observatory;
  // study: books' heights in the art (rows where each spine starts) give Y<B<R<G
  var art = S.views[1].art, top = {};
  ['R', 'B', 'G', 'Y'].forEach(function (c) {
    for (var y = 0; y < art.length; y++) { var x = art[y].indexOf('|' + c + '|'); if (x >= 0) { top[c] = y; break; } }
  });
  var order = ['R', 'B', 'G', 'Y'].sort(function (a, b) { return top[b] - top[a]; });
  assert.deepStrictEqual(order.map(function (c) { return { R: 'red', B: 'blue', G: 'green', Y: 'yellow' }[c]; }), S.locks.cabinet.answer);
  // study: tiles ordered by dot count
  var tiles = S.zooms.tiles.art, nums = tiles[1].split('|').slice(1, 5).map(function (s) { return s.trim(); }),
    dots = tiles[2].split('|').slice(1, 5).map(function (s) { return (s.match(/•/g) || []).length; });
  var roman = { I: 1, II: 2, VII: 7, IX: 9 };
  var code = nums.map(function (n, i) { return [dots[i], roman[n]]; }).sort(function (a, b) { return a[0] - b[0]; }).map(function (p) { return p[1]; }).join('');
  assert.strictEqual(code, S.locks.keypad.answer);
  // glass: the acrostic
  assert.strictEqual(G.zooms.poem.art.map(function (l) { return l.trim().charAt(0); }).join(''), G.locks.padlock.answer.join(''));
  // glass: the map path, one move per stone, is the only route from S to X
  var m = G.zooms.map.art.slice(1, 6).map(function (l) { return l.slice(7).split(' '); });
  var sy, sx;
  m.forEach(function (r, y) { r.forEach(function (c, x) { if (c === 'S') { sy = y; sx = x; } }); });
  var seen = {}, path = '', y = sy, x = sx, D = { U: [-1, 0], D: [1, 0], L: [0, -1], R: [0, 1] };
  seen[y + ',' + x] = 1;
  for (var k = 0; k < 40 && m[y][x] !== 'X'; k++) {
    var nexts = Object.keys(D).filter(function (d) {
      var ny = y + D[d][0], nx = x + D[d][1];
      return m[ny] && (m[ny][nx] === 'o' || m[ny][nx] === 'X') && !seen[ny + ',' + nx];
    });
    assert.strictEqual(nexts.length, 1, 'path is unambiguous');
    y += D[nexts[0]][0]; x += D[nexts[0]][1]; seen[y + ',' + x] = 1; path += nexts[0];
  }
  assert.strictEqual(path, G.locks.toolbox.answer);
  // observatory: the riddle has exactly one answer
  var sols = [];
  for (var n = 100; n < 1000; n++) {
    var a = Math.floor(n / 100), b = Math.floor(n / 10) % 10, c = n % 10;
    if (a && b && c && a !== b && b !== c && a !== c && a === 2 * c && b === a + c && a + b + c === 12) sols.push('' + a + b + c);
  }
  assert.deepStrictEqual(sols, [O.locks.drawer.answer.join('')]);
  // observatory: star clusters counted left to right
  var eye = O.zooms.eyepiece.art.slice(0, 4), cols = [], starAt = {};
  eye.forEach(function (l) { for (var i = 0; i < l.length; i++) if (l[i] === '*') { starAt[i] = (starAt[i] || 0) + 1; } });
  Object.keys(starAt).map(Number).sort(function (p, q) { return p - q; }).forEach(function (i) {
    if (!cols.length || i - cols[cols.length - 1].x > 4) cols.push({ x: i, n: 0 });
    var cl = cols[cols.length - 1]; cl.n += starAt[i]; cl.x = i;
  });
  assert.strictEqual(cols.map(function (c) { return c.n; }).join(''), O.locks.keypad.answer);
  // observatory: shapes by rising hour
  var hours = { KITE: 9, LANTERN: 11, RING: 10, TOWER: 8 }, shape = { KITE: 'diamond', LANTERN: 'triangle', RING: 'circle', TOWER: 'square' };
  assert.deepStrictEqual(Object.keys(hours).sort(function (p, q) { return hours[p] - hours[q]; }).map(function (k) { return shape[k]; }), O.locks.cabinet.answer);
});

test('items: combining, examining, using the wrong thing', function () {
  var g = E.newGame('study');
  var r = E.combine(g, 'lens', 'frame');
  assert.ok(!r.hit, 'cannot combine what you do not hold');
  step(g, 'lock drawer 4 3 5');
  assert.deepStrictEqual(g.inv, ['lens', 'note_a']);
  r = E.combine(g, 'lens', 'note_a');
  assert.ok(!r.ok && /don't go together/.test(r.say));
  r = E.interact(g, 'door', 'lens');
  assert.ok(!r.hit && r.say && r.sfx === 'nope');
  r = E.examine(g, 'note_a');
  assert.ok(r.ui && r.ui.zoom === 'note_a');
  step(g, 'look coat');
  r = step(g, 'combine frame lens');   // either order
  assert.deepStrictEqual(g.inv, ['note_a', 'loupe']);
  assert.deepStrictEqual(r.got, ['loupe']);
  // the coat only gives once
  r = E.interact(g, 'coat');
  assert.deepStrictEqual(r.got, []);
});

test('lock plates change with what you know; open locks do not reopen', function () {
  var g = E.newGame('study'), L = E.ROOM.study.locks.cabinet;
  assert.ok(/too small/.test(E.lockPlate(g, L)));
  g.flags.plate_read = true;
  assert.ok(/SHORTEST/.test(E.lockPlate(g, L)));
  var r = E.interact(g, 'drawer');
  assert.deepStrictEqual(r.ui, { lock: 'drawer' });
  step(g, 'lock drawer 4 3 5');
  r = E.interact(g, 'drawer');
  assert.strictEqual(r.ui, null);
  r = E.tryLock(g, 'drawer', [0, 0, 0]);
  assert.ok(r.ok && !r.hit, 'already open');
});

test('wheel positions are remembered and wrap', function () {
  var g = E.newGame('glass');
  assert.deepStrictEqual(E.lockVal(g, 'padlock'), [0, 0, 0, 0, 0]);
  E.setWheel(g, 'padlock', 0, -1);
  E.setWheel(g, 'padlock', 4, 27);
  assert.deepStrictEqual(E.lockVal(g, 'padlock'), [25, 0, 0, 0, 1]);
  assert.strictEqual(E.lockVal(g, 'toolbox'), '');
});

test('hidden things appear only when revealed', function () {
  var g = E.newGame('observatory');
  assert.ok(E.objectsIn(g, 'desk').indexOf('lantern') >= 0);
  step(g, 'look lantern');
  assert.ok(E.objectsIn(g, 'desk').indexOf('lantern') < 0);
  var r = E.interact(g, 'corner');
  assert.ok(/Pitch black/.test(r.say));
  var before = E.renderView(g, 'hatch').ch[9].join('');
  g.inv.push('lantern_lit');
  step(g, 'look corner');
  var after = E.renderView(g, 'hatch').ch[9].join('');
  assert.notStrictEqual(before, after);
  assert.ok(after.indexOf('[  ]') >= 0, 'loose brick drawn');
});

test('renderView: grid size, patches and colours', function () {
  E.ROOMS.forEach(function (R) {
    var g = E.newGame(R.id);
    R.views.forEach(function (V) {
      var r = E.renderView(g, V.id);
      assert.strictEqual(r.ch.length, E.ROWS);
      r.ch.forEach(function (row) { assert.strictEqual(row.length, E.COLS); });
      r.col.forEach(function (row) { row.forEach(function (c) { assert.ok(/^[tmfaygrbowvk]$/.test(c), c); }); });
    });
  });
  var g = E.newGame('study');
  assert.ok(E.renderView(g, 'desk').ch[11].join('').indexOf('(#)') >= 0);
  step(g, 'lock drawer 4 3 5');
  assert.ok(E.renderView(g, 'desk').ch[11].join('').indexOf('(empty)') >= 0);
  assert.strictEqual(E.renderView(g, 'nope'), null);
});

test('hints: three per puzzle, +30 s each, only for open puzzles', function () {
  var g = E.newGame('study');
  var open = E.puzzlesOpen(g).map(function (p) { return p.id; });
  assert.ok(open.indexOf('drawer') >= 0 && open.indexOf('clock') < 0, 'clock hint waits for the crank');
  var h1 = E.takeHint(g, 'drawer'), h2 = E.takeHint(g, 'drawer'), h3 = E.takeHint(g, 'drawer'), h4 = E.takeHint(g, 'drawer');
  assert.ok(h1 && h2 && h3 && h1 !== h2 && h4 === null);
  assert.strictEqual(g.pen, 3 * E.HINT_PEN);
  assert.strictEqual(E.hintsUsed(g), 3);
  assert.strictEqual(E.takeHint(g, 'nope'), null);
  step(g, 'lock drawer 4 3 5');
  assert.ok(E.puzzlesOpen(g).every(function (p) { return p.id !== 'drawer'; }));
});

test('timer, final time, stars and records', function () {
  var g = E.newGame('study');
  E.tick(g, 0.5); E.tick(g, 10); E.tick(g, -3); E.tick(g, 1);   // a 10 s hitch (tab asleep) is ignored
  assert.strictEqual(g.t, 1.5);
  g.t = 600;
  WALK.study.forEach(function (l) { step(g, l); });
  E.tick(g, 1);
  assert.strictEqual(g.t, 600, 'clock stops on escape');
  assert.strictEqual(E.finalTime(g), 600);
  assert.strictEqual(E.stars(g), 3);
  var save = E.newSave();
  save.games.study = g;
  var rec = E.record(save, g);
  assert.ok(rec.isNew && rec.best.t === 600 && !save.games.study);
  var g2 = E.newGame('study'); g2.t = 900; g2.pen = 60; g2.hints = { drawer: 2 }; g2.done = true;
  rec = E.record(save, g2);
  assert.ok(!rec.isNew && save.best.study.t === 600 && save.best.study.n === 2 && rec.t === 960 && rec.stars === 2);
  var g3 = E.newGame('study'); g3.t = 5000; g3.hints = { a: 3, b: 3 }; g3.done = true;
  assert.strictEqual(E.stars(g3), 1);
});

test('save normalisation is defensive', function () {
  [null, 1, 'x', [], { games: 5 }, { best: 'x' }, { games: { study: 'x', glass: null } }].forEach(function (o) {
    var s = E.normSave(o);
    assert.deepStrictEqual(s.games, {}); assert.deepStrictEqual(s.best, {});
  });
  var g = E.newGame('study');
  WALK.study.slice(0, 6).forEach(function (l) { step(g, l); });
  E.takeHint(g, 'drawer'); g.t = 123.4; g.sel = 'loupe';
  E.setWheel(g, 'cabinet', 1, 3);
  var s = E.normSave(JSON.parse(JSON.stringify({ seen: true, games: { study: g }, best: { glass: { t: 300, hints: 1, stars: 2, n: 1 } } })));
  assert.deepStrictEqual(s.games.study, g);
  assert.ok(s.seen && s.best.glass.t === 300);
  var bad = E.normSave({ games: { study: { view: 'moon', inv: ['loupe', 'loupe', 'ufo', 7], flags: { 'open:drawer': true, x: 'yes', 'bad key!': true },
    hints: { drawer: 99, nope: 2 }, lv: { drawer: [1, 2], cabinet: [9, -1, 2, 'a'], keypad: '12ab3456' }, t: -5, pen: 'x', sel: 'crank', done: false } },
    best: { study: { t: 'fast' }, glass: { t: 1e12, hints: -2, stars: 9 } } });
  var b = bad.games.study;
  assert.strictEqual(b.view, 'desk');
  assert.deepStrictEqual(b.inv, ['loupe']);
  assert.deepStrictEqual(b.flags, { 'open:drawer': true });
  assert.deepStrictEqual(b.hints, { drawer: 3 });
  assert.deepStrictEqual(b.lv, { cabinet: [0, 0, 2, 0], keypad: '1234' });
  assert.ok(b.t === 0 && b.pen === 0 && b.sel === null);
  assert.ok(!bad.best.study && bad.best.glass.hints === 0 && bad.best.glass.stars === 3 && bad.best.glass.t <= 359999);
  // a finished game is not kept as "in progress"
  var done = E.newGame('glass'); done.done = true;
  assert.ok(!E.normSave({ games: { glass: done } }).games.glass);
});

test('deterministic: the same steps give the same state', function () {
  E.ROOMS.forEach(function (R) {
    var a = E.newGame(R.id), b = E.newGame(R.id);
    WALK[R.id].forEach(function (l) { step(a, l); step(b, l); });
    assert.deepStrictEqual(a, b);
  });
});

// No soft-locks: after any random fumbling (wrong items, wrong codes, combining junk,
// re-tapping), a player who tries everything can still escape every room.
test('no soft-locks after random play (seeded)', function () {
  var seed = 12345;
  function rnd(n) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; }
  function answerOf(R, id) { var L = R.locks[id]; return L.kind === 'wheels' ? wheelIdx(R, id, L.answer) : L.answer; }
  E.ROOMS.forEach(function (R) {
    var objs = Object.keys(R.objects), lockIds = Object.keys(R.locks);
    for (var trial = 0; trial < 40; trial++) {
      var g = E.newGame(R.id);
      for (var k = 0; k < 120 && !g.done; k++) {
        var r = rnd(4);
        if (r === 0) E.interact(g, objs[rnd(objs.length)]);
        else if (r === 1 && g.inv.length) E.interact(g, objs[rnd(objs.length)], g.inv[rnd(g.inv.length)]);
        else if (r === 2 && g.inv.length > 1) E.combine(g, g.inv[rnd(g.inv.length)], g.inv[rnd(g.inv.length)]);
        else if (r === 3) { var lid = lockIds[rnd(lockIds.length)], L = R.locks[lid]; E.tryLock(g, lid, L.kind === 'wheels' ? [0, 0, 0, 0, 0].slice(0, L.n) : L.kind === 'keypad' ? '0000' : 'UDLR'); }
      }
      // then try everything, over and over (locks only through an object that offers them)
      for (var pass = 0; pass < 25 && !g.done; pass++) {
        objs.forEach(function (o) {
          var res = E.interact(g, o);
          if (res.ui && res.ui.lock) E.tryLock(g, res.ui.lock, answerOf(R, res.ui.lock));
          g.inv.slice().forEach(function (it) { if (!g.done) E.interact(g, o, it); });
        });
        g.inv.slice().forEach(function (a) { g.inv.slice().forEach(function (b) { if (a !== b && !g.done) E.combine(g, a, b); }); });
      }
      assert.ok(g.done, R.id + ' soft-locked after random play (trial ' + trial + '): flags ' + Object.keys(g.flags).join(',') + ' inv ' + g.inv.join(','));
    }
  });
});

test('locks: wrong shapes of input fail safely; open locks never give twice', function () {
  E.ROOMS.forEach(function (R) {
    var g = E.newGame(R.id);
    for (var id in R.locks) {
      ['', null, undefined, 42, [], [99, -3], 'zzzz', {}].forEach(function (v) { assert.ok(!E.tryLock(g, id, v).ok, R.id + '/' + id + ' ' + JSON.stringify(v)); });
      assert.ok(!g.flags['open:' + id]);
    }
    assert.ok(!E.tryLock(g, 'no-such-lock', '1').ok);
    for (var id2 in R.locks) {
      var L = R.locks[id2], ans = L.kind === 'wheels' ? wheelIdx(R, id2, L.answer) : L.answer;
      var before = g.inv.length, r1 = E.tryLock(g, id2, ans);
      assert.ok(r1.ok);
      var after = g.inv.length, r2 = E.tryLock(g, id2, ans);
      assert.ok(r2.ok && !r2.got.length && g.inv.length === after, id2 + ' gives twice');
      assert.ok(after >= before);
    }
  });
});

test('hints: the last hint of every lock puzzle names the real answer', function () {
  E.ROOMS.forEach(function (R) {
    R.puzzles.forEach(function (p) {
      var m = /^open:(\w+)$/.exec(p.done);
      if (!m || !R.locks[m[1]]) return;
      var L = R.locks[m[1]], last = p.hints[2].toUpperCase().replace(/[^A-Z0-9☼☾★♣♥○△□◇☆]/g, '');
      var want = L.kind === 'wheels' ? L.answer.map(function (a) {
        return L.style === 'weather' ? E.GLYPH[a] : L.style === 'shape' ? E.SHAPE_GLYPH[a] : L.style === 'colour' ? E.CLR[a] : a.toUpperCase();
      }).join('') : L.kind === 'dir' ? null : L.answer;
      if (L.kind === 'dir') { var dirs = p.hints[2].toLowerCase().match(/up|down|left|right/g).map(function (w) { return w.charAt(0).toUpperCase(); }).join(''); assert.strictEqual(dirs, L.answer); return; }
      if (L.style === 'shape') { var sh = p.hints[2].match(/[○△□◇☆]/g).join(''); assert.strictEqual(sh, want, R.id + '/' + p.id); return; }
      if (L.style === 'colour') { var cl = p.hints[2].match(/\b[RYGBV]\b/g).join(''); assert.strictEqual(cl, want, R.id + '/' + p.id); return; }
      assert.ok(last.indexOf(want) >= 0, R.id + '/' + p.id + ': ' + p.hints[2] + ' vs ' + want);
    });
  });
});

console.log(passed + ' passed');
