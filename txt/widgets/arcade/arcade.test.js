/* Headless checks for the Arcade engine (discovery, categories, search, state).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/arcade/arcade.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');

// The module exports its pure engine for node (no DOM, no Cade needed)…
var E = require('./arcade.js');
// …and registers the same engine on the widget when a Cade core is present.
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./arcade.js')];
require('./arcade.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function seeded(seed) {
  var s = seed >>> 0;
  return function () { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// The real manifest: what Cade.commands() lists at boot (lazy stubs).
var manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
var widgets = manifest.modules.filter(function (m) { return m.type === 'widget'; });
var rows = widgets.map(function (m) { return { name: m.name, description: m.description, icon: m.icon, tags: m.tags, kind: 'widget' }; });
rows.push({ name: 'Sort Lines', description: 'a script', icon: '', tags: 'game', kind: 'script' });
var ids = E.idMapFromManifest(manifest);
var cat = E.buildCatalog(rows, ids, 'Arcade');
var byName = {};
cat.forEach(function (e) { byName[e.name] = e; });

test('registers as a widget with its css, same name as the manifest', function () {
  assert.ok(widget && widget.name === 'Arcade' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'arcade.css');
  assert.strictEqual(widget._engine.SELF, E.SELF);
  var me = widgets.filter(function (m) { return m.id === 'arcade'; })[0];
  assert.ok(me && me.name === widget.name && me.entry === 'widgets/arcade/arcade.js' && me.css === 'widgets/arcade/arcade.css');
});

test('every game in the manifest is discovered, the Arcade itself is not', function () {
  widgets.forEach(function (m) {
    var toks = E.tokens(m.tags);
    if (m.id === 'arcade') { assert.ok(!byName[m.name], 'arcade lists itself'); return; }
    if (toks.indexOf('game') !== -1 || toks.indexOf('toy') !== -1) assert.ok(byName[m.name], 'missing game ' + m.name);
  });
  assert.ok(!byName['Sort Lines'], 'scripts are not games');
  assert.ok(cat.length > 60, 'a big catalogue: ' + cat.length);
});

test('non-game tools stay out; game tools go under Game tools', function () {
  ['Calculator', 'Timer', 'Weather', 'Kanban Board', 'Dictionary', 'Beat Maker', 'Anagram Solver'].forEach(function (n) {
    assert.ok(!byName[n], n + ' is not a game');
  });
  ['Score Keeper', 'Chess Clock', 'Remote', 'ARG Desk', 'Random Picker'].forEach(function (n) {
    assert.ok(byName[n], n + ' listed');
    assert.strictEqual(byName[n].cat, 'tools', n);
    assert.strictEqual(byName[n].game, false);
  });
});

test('known games land in the right categories', function () {
  var want = {
    'Snake': 'action', 'Dusk Dash': 'action', 'Pinball': 'action', 'Sudoku': 'puzzle', '2048': 'puzzle', 'Word Guess': 'word',
    'Mini Crossword': 'word', 'Chess': 'board', 'Hearts': 'board', 'Solitaire': 'board', 'Mini Golf': 'sports', 'Darts': 'sports',
    'Lemonade Stand': 'sims', 'Escape Room': 'story', 'Party Games': 'party', 'License Plate Game': 'party', 'Morse Trainer': 'learn',
    'Typing Test': 'learn', 'Falling Sand': 'toys', 'Marble Run': 'toys'
  };
  Object.keys(want).forEach(function (n) { assert.ok(byName[n], n); assert.strictEqual(byName[n].cat, want[n], n); });
  cat.forEach(function (e) { assert.ok(E.CAT[e.cat], e.name + ' has a real category'); });
});

test('tag heuristics place unknown games', function () {
  function c(tags, name) { return E.classify({ name: name || 'Mystery', tags: tags }, '').cat; }
  assert.strictEqual(c('game,arcade,shooter,fun'), 'action');
  assert.strictEqual(c('game,puzzle,logic,daily'), 'puzzle');
  assert.strictEqual(c('game,puzzle,word,daily'), 'word');
  assert.strictEqual(c('game,cards,poker,cpu'), 'board');
  assert.strictEqual(c('game,sport,golf,physics'), 'sports');
  assert.strictEqual(c('game,sim,idle,farm'), 'sims');
  assert.strictEqual(c('game,story,interactive fiction'), 'story');
  assert.strictEqual(c('game,party,charades'), 'party');
  assert.strictEqual(c('game,learning,quiz,geography'), 'learn');
  assert.strictEqual(c('toy,sandbox,relax'), 'toys');
  assert.strictEqual(c('game,fun'), 'action', 'default');
  assert.strictEqual(c('game,fun', 'Word Rush'), 'word', 'name hint');
  assert.strictEqual(c('calculator,math'), null, 'not a game');
  assert.strictEqual(c('learn to fly,train'), null, 'no game tag');
  assert.strictEqual(c('game,score keeper,tally'), 'tools');
  // the override map wins over tags, by id or by name
  assert.strictEqual(E.classify({ name: 'Renamed', tags: 'game,cards' }, 'snake').cat, 'action');
  assert.strictEqual(E.classify({ name: 'Score Keeper', tags: 'x' }, '').cat, 'tools');
});

test('badges: CPU, 2P, daily', function () {
  assert.deepStrictEqual(byName['Chess'].badges, ['cpu', '2p']);
  assert.ok(byName['Pong'].badges.indexOf('2p') !== -1);
  assert.ok(byName['Sudoku'].badges.indexOf('daily') !== -1);
  assert.deepStrictEqual(E.badgesOf(E.tokens('game,arcade')), []);
});

test('catalogue: sorted, deduped, malformed rows skipped', function () {
  for (var i = 1; i < cat.length; i++) assert.ok(cat[i - 1].name.toLowerCase() <= cat[i].name.toLowerCase());
  var c2 = E.buildCatalog([null, {}, { name: '  ' }, { name: 'Zed', tags: 'game' }, { name: 'zed', tags: 'game,puzzle' }, { name: 'Arcade', tags: 'game' }, 5], null, 'Arcade');
  assert.strictEqual(c2.length, 1);
  assert.strictEqual(c2[0].name, 'Zed');
  assert.deepStrictEqual(E.buildCatalog(null), []);
  assert.deepStrictEqual(E.idMapFromManifest(null), {});
});

test('search ranks name hits first, needs every word, finds tags and badges', function () {
  var st = E.newState();
  var r = E.search(cat, 'chess', st).map(function (e) { return e.name; });
  assert.strictEqual(r[0], 'Chess');
  assert.ok(r.indexOf('Chess Puzzles') !== -1 && r.indexOf('Chess Clock') !== -1);
  assert.ok(r.indexOf('Chess Puzzles') < r.indexOf('Checkers') || r.indexOf('Checkers') === -1);
  var cards = E.search(cat, 'cards', st).map(function (e) { return e.name; });
  assert.ok(cards.indexOf('Hearts') !== -1 && cards.indexOf('Blackjack') !== -1);
  var two = E.search(cat, 'board 2 player', st);
  assert.ok(two.length && two.every(function (e) { return e.badges.indexOf('2p') !== -1 || /2 player/.test(e.tags); }));
  assert.ok(E.search(cat, 'cpu', st).some(function (e) { return e.name === 'Hearts'; }));
  assert.strictEqual(E.search(cat, 'pnbl', st)[0].name, 'Pinball', 'fuzzy fallback');
  assert.strictEqual(E.search(cat, 'zzzzqqq', st).length, 0);
  assert.strictEqual(E.search(cat, '  ', st).length, cat.length);
  assert.ok(E.search(cat, 'a+b(', st), 'regex characters are safe');
});

test('filters and sections', function () {
  var st = E.newState();
  var all = E.filterList(cat, 'all', st);
  assert.ok(all.length && all.every(function (e) { return e.game; }), 'tools are not in "all"');
  E.toggleFav(st, 'Snake'); E.toggleFav(st, 'Hearts');
  assert.deepStrictEqual(E.filterList(cat, 'fav', st).map(function (e) { return e.name; }), ['Hearts', 'Snake']);
  var secs = E.sections(cat, st);
  assert.strictEqual(secs[0].id, 'fav');
  assert.strictEqual(secs[secs.length - 1].id, 'tools');
  var total = 0;
  secs.forEach(function (s) { if (s.id !== 'fav') total += s.items.length; });
  assert.strictEqual(total, cat.length, 'every entry in exactly one category section');
  var c = E.counts(cat, st);
  assert.strictEqual(c.fav, 2);
  assert.strictEqual(c.all, all.length);
  assert.ok(E.filterList(cat, 'duo', st).every(function (e) { return e.badges.indexOf('2p') !== -1; }));
});

test('favourites toggle; launches recorded newest first, capped, counted', function () {
  var st = E.newState();
  assert.strictEqual(E.toggleFav(st, 'Pong'), true);
  assert.strictEqual(E.toggleFav(st, 'Pong'), false);
  assert.deepStrictEqual(st.favs, []);
  E.recordLaunch(st, 'Snake', 1000);
  E.recordLaunch(st, 'Pong', 2000);
  assert.strictEqual(E.recordLaunch(st, 'Snake', 3000), 2);
  assert.deepStrictEqual(st.recent.map(function (r) { return r.n; }), ['Snake', 'Pong']);
  assert.strictEqual(st.launches, 3);
  for (var i = 0; i < 30; i++) E.recordLaunch(st, 'G' + i, 4000 + i);
  assert.strictEqual(st.recent.length, E.MAX_RECENT);
  assert.strictEqual(st.recent[0].n, 'G29');
  var mp = E.mostPlayed(cat, st);
  assert.ok(mp && mp.e.name === 'Snake' && mp.n === 2);
  st.recent = [{ n: 'Gone Game', t: 1 }, { n: 'Pong', t: 2 }];
  assert.deepStrictEqual(E.recentList(cat, st).map(function (e) { return e.name; }), ['Pong'], 'uninstalled games drop out');
});

test('state normalisation is defensive and round-trips', function () {
  var st = E.newState();
  E.toggleFav(st, 'Chess'); E.recordLaunch(st, 'Chess', 1234); st.view = 'list'; st.after = 'close'; st.filter = 'board'; st.sound = true;
  assert.deepStrictEqual(E.normState(JSON.parse(JSON.stringify(st))), st);
  var bad = E.normState({ favs: ['a', 'a', 3, '', null, 'b'], recent: [{ n: 'x', t: 'zz' }, { n: 'x', t: 5 }, 'nope', { t: 4 }], plays: { x: -3, y: 2.7, z: 'q' },
    view: 'tiles', after: 'explode', filter: 'nope', sound: 'yes', launches: -1 });
  assert.deepStrictEqual(bad.favs, ['a', 'b']);
  assert.deepStrictEqual(bad.recent, [{ n: 'x', t: 0 }]);
  assert.deepStrictEqual(bad.plays, { y: 2 });
  assert.ok(bad.view === 'grid' && bad.after === 'minimize' && bad.filter === 'all' && bad.sound === false && bad.launches === 0);
  assert.deepStrictEqual(E.normState(null), E.newState());
  assert.deepStrictEqual(E.normState('junk'), E.newState());
  assert.deepStrictEqual(E.normState({ plays: [1, 2] }).plays, {});
});

test('random pick: from the list, avoids the last game and recent ones', function () {
  var st = E.newState();
  var list = E.filterList(cat, 'board', st);
  E.recordLaunch(st, list[0].name, 1); E.recordLaunch(st, list[1].name, 2);
  var rnd = seeded(7);
  for (var i = 0; i < 200; i++) {
    var p = E.pickRandom(list, st, rnd, list[1].name);
    assert.ok(list.indexOf(p) !== -1);
    assert.ok(p !== list[0] && p !== list[1]);
  }
  assert.strictEqual(E.pickRandom([], st), null);
  assert.strictEqual(E.pickRandom([list[0]], st, rnd, list[0].name), list[0], 'the only choice');
  // deterministic for a seed
  assert.strictEqual(E.pickRandom(list, st, seeded(3)).name, E.pickRandom(list, st, seeded(3)).name);
});

test('roulette path ends on the target, never repeats a card twice in a row', function () {
  [2, 3, 5, 40].forEach(function (n) {
    for (var t = 0; t < n; t += Math.max(1, n >> 2)) {
      var path = E.roulettePath(n, t, 12, seeded(n * 31 + t));
      assert.strictEqual(path.length, 12);
      assert.strictEqual(path[11], t);
      for (var i = 0; i < path.length; i++) {
        assert.ok(path[i] >= 0 && path[i] < n);
        if (i) assert.notStrictEqual(path[i], path[i - 1]);
      }
    }
  });
  assert.deepStrictEqual(E.roulettePath(0, 0, 5), []);
  assert.deepStrictEqual(E.roulettePath(1, 0, 3, seeded(1)), [0, 0, 0]);
  assert.ok(E.rouletteDelay(0, 10) < E.rouletteDelay(9, 10), 'slows down');
});

test('grid keyboard moves', function () {
  assert.strictEqual(E.gridMove(0, 'ArrowRight', 4, 10), 1);
  assert.strictEqual(E.gridMove(9, 'ArrowRight', 4, 10), 9);
  assert.strictEqual(E.gridMove(1, 'ArrowDown', 4, 10), 5);
  assert.strictEqual(E.gridMove(7, 'ArrowDown', 4, 10), 9, 'down into a short last row');
  assert.strictEqual(E.gridMove(9, 'ArrowDown', 4, 10), 9);
  assert.strictEqual(E.gridMove(2, 'ArrowUp', 4, 10), -1, 'off the top');
  assert.strictEqual(E.gridMove(6, 'ArrowUp', 4, 10), 2);
  assert.strictEqual(E.gridMove(5, 'End', 4, 10), 9);
  assert.strictEqual(E.gridMove(5, 'Home', 4, 10), 0);
  assert.strictEqual(E.gridMove(0, 'ArrowDown', 0, 3), 1, 'cols clamp to 1');
  assert.strictEqual(E.gridMove(0, 'ArrowDown', 4, 0), -1);
});

test('marquee: ticker loops, lights chase, time ago', function () {
  var st = E.newState();
  var t = E.tickerText(cat, st, 864e5 * 100);
  assert.ok(/INSERT COIN/.test(t) && /GAMES ON THIS CABINET/.test(t) && /NEVER PLAYED/.test(t));
  E.recordLaunch(st, 'Snake', 864e5 * 100 - 7200e3); E.recordLaunch(st, 'Snake', 864e5 * 100 - 3600e3 * 3);
  t = E.tickerText(cat, st, 864e5 * 100);
  assert.ok(/LAST PLAYED: SNAKE \(3H AGO\)/.test(t), t);
  assert.ok(/HI-SCORE: SNAKE x2/.test(t));
  assert.strictEqual(E.tickerSlice('abc', 0, 7), 'abcabca');
  assert.strictEqual(E.tickerSlice('abc', 4, 4), 'bcab');
  assert.strictEqual(E.tickerSlice('abc', -1, 2), 'ca');
  assert.strictEqual(E.tickerSlice('', 3, 3), '   ');
  assert.strictEqual(E.lightsRow(7, 0, 3), 'o..o..o');
  assert.strictEqual(E.lightsRow(7, 1, 3), '..o..o.');
  assert.strictEqual(E.lightsRow(4, -1, 3), '.o..');
  assert.strictEqual(E.ago(0, 5), '');
  assert.strictEqual(E.ago(1000, 20000), 'now');
  assert.strictEqual(E.ago(0 + 1, 1 + 5 * 60e3), '5m');
  assert.strictEqual(E.ago(1, 1 + 3 * 864e5), '3d');
  assert.strictEqual(E.ago(1, 1 + 21 * 864e5), '3w');
  assert.strictEqual(E.pad3(7), '007');
  E.BANNER.forEach(function (l) { assert.ok(l.length <= 46 && /^[ -~]*$/.test(l), 'ascii banner'); });
});

test('every catalogue entry maps to a manifest id usable as a solo page (?widget=id)', function () {
  cat.forEach(function (e) {
    assert.ok(e.id, 'no manifest id for ' + e.name);
    assert.ok(/^[a-z0-9_-]{1,40}$/i.test(e.id), 'bad solo id ' + e.id);
  });
  // a favourited game shows twice in All (Favourites + its category) but once per section
  var st = E.newState(); E.toggleFav(st, 'Snake');
  var secs = E.sections(cat, st), seen = 0;
  secs.forEach(function (s) { var names = s.items.map(function (x) { return x.name; }); seen += names.filter(function (n) { return n === 'Snake'; }).length; assert.strictEqual(new Set(names).size, names.length); });
  assert.strictEqual(seen, 2);
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
