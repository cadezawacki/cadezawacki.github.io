/* Headless checks for the Party Games engine (decks, charades, fishbowl, hot
 * seat, tilt, saves). Not loaded by the app (not in the manifest).
 * Run: node txt/widgets/partygames/partygames.test.js */
'use strict';
var assert = require('assert');

var E = require('./partygames.js');
var DATA = require('./partygames-data.js');
// …and the same engine is registered on the widget when a Cade core is present.
var widget = null, css = [], assets = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, asset: function (p) { assets.push(p); return './' + p; }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./partygames.js')];
require('./partygames.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var CATS = E.parseCharades(DATA);
function pool(sel, diff, used, s) { return E.buildPool(CATS, sel || [], diff || 'mixed', used || [], { rs: s || 7 }); }

test('registers as a widget with its css and data asset', function () {
  assert.ok(widget && widget.name === 'Party Games' && typeof widget.open === 'function');
  assert.deepStrictEqual(css, ['partygames.css']);
  assert.deepStrictEqual(assets, ['partygames-data.js']);
  assert.strictEqual(typeof widget._engine.chStart, 'function'); assert.deepStrictEqual(Object.keys(widget._engine), Object.keys(E));
});

test('decks are big, clean and family-sized', function () {
  assert.ok(CATS.length >= 12, 'categories');
  var total = 0, seen = {};
  CATS.forEach(function (c) {
    assert.ok(c.name && c.icon, c.id);
    [1, 2, 3].forEach(function (d) { assert.ok(c.words.filter(function (w) { return w.d === d; }).length >= 10, c.id + ' d' + d); });
    c.words.forEach(function (w) { assert.ok(w.w.length > 0 && w.w.length <= 40 && w.w.indexOf('|') < 0, w.w); seen[E.wordKey(w.w)] = 1; });
    total += c.words.length;
  });
  assert.ok(total >= 700, 'charades words: ' + total);
  assert.ok(Object.keys(seen).length >= total * 0.97, 'few duplicates across categories');
  ['light', 'silly', 'deep'].forEach(function (d) { assert.ok(DATA.hotseat[d].length >= 35, d); });
  assert.ok(DATA.wyr.length >= 100 && DATA.nhie.length >= 100 && DATA.mlt.length >= 50);
  DATA.wyr.forEach(function (s) { var q = E.parseWyr(s); assert.ok(q.a && q.b, s); });
  var blob = JSON.stringify(DATA).toLowerCase();
  ['beer', 'wine', 'drunk', 'kill', 'sex', 'gun'].forEach(function (bad) { assert.ok(!new RegExp('\\b' + bad + '\\b').test(blob), 'family friendly: ' + bad); });
});

test('word pools follow category, difficulty and freshness', function () {
  var p = pool(['animals'], 'easy');
  assert.ok(p.length >= 20);
  p.forEach(function (x) { assert.strictEqual(x.c, 'Animals'); assert.strictEqual(x.d, 1); });
  var all = pool([], 'mixed'), keys = all.map(function (x) { return E.wordKey(x.w); });
  assert.strictEqual(new Set(keys).size, keys.length, 'deduped');
  // used words go to the back
  var used = pool(['animals'], 'easy').slice(0, 10).map(function (x) { return E.wordKey(x.w); });
  var p2 = pool(['animals'], 'easy', used, 99);
  p2.slice(0, p2.length - 10).forEach(function (x) { assert.ok(used.indexOf(E.wordKey(x.w)) < 0); });
  // seeded: same seed, same order
  assert.deepStrictEqual(pool([], 'hard', [], 5), pool([], 'hard', [], 5));
  assert.notDeepStrictEqual(pool([], 'hard', [], 5).slice(0, 10), pool([], 'hard', [], 6).slice(0, 10));
});

test('charades: a full game scores, rotates teams and ends', function () {
  var g = E.newCharades({ teams: ['A', 'B', 'C'], secs: 30, rounds: 2 }, pool(), 3);
  assert.strictEqual(g.teams.length, 3);
  var turns = 0;
  while (!g.over) {
    var t = E.chStart(g), team = g.ti;
    assert.strictEqual(t.team, team);
    for (var k = 0; k < team + 2; k++) E.chMark(g, 'got');
    E.chMark(g, 'skip');
    assert.strictEqual(E.chTick(g, 10), false);
    assert.ok(E.chMark(g, 'got'));
    assert.strictEqual(E.chTick(g, 25), true, 'time is up');
    assert.strictEqual(E.chMark(g, 'got'), null, 'no marks after the buzzer');
    assert.strictEqual(t.items[t.items.length - 1].r, 'time');
    E.chCommit(g); turns++;
    assert.ok(turns < 50);
  }
  assert.strictEqual(turns, 6);
  assert.deepStrictEqual(g.teams.map(function (x) { return x.score; }), [6, 8, 10]);
  assert.strictEqual(E.standings(g.teams)[0].name, 'C');
  assert.strictEqual(g.best.got, 5);
  assert.strictEqual(E.chStart(g), null);
});

test('charades: penalty, fixing words after the buzzer, early end', function () {
  var g = E.newCharades({ teams: ['A', 'B'], penalty: true, secs: 45 }, pool(), 4);
  var t = E.chStart(g);
  E.chMark(g, 'got'); E.chMark(g, 'skip'); E.chMark(g, 'skip');
  assert.strictEqual(E.chTurnScore(t, g.cfg), -1);
  assert.ok(E.chEndEarly(g));
  assert.strictEqual(t.left, 0);
  var last = t.items.length - 1;
  assert.strictEqual(E.chToggle(t, last), 'got', 'a last-second guess counts');
  assert.strictEqual(E.chToggle(t, last), 'time', 'and back');
  assert.strictEqual(E.chToggle(t, 1), 'got');
  assert.strictEqual(E.chTurnScore(t, g.cfg), 1);
  var e = E.chCommit(g);
  assert.strictEqual(e.score, 1); assert.strictEqual(g.teams[0].score, 1); assert.strictEqual(g.ti, 1);
});

test('charades: the pool recycles instead of running dry', function () {
  var g = E.newCharades({ teams: ['A', 'B'] }, pool(['animals'], 'easy').slice(0, 3), 1);
  E.chStart(g);
  for (var i = 0; i < 10; i++) assert.ok(E.chMark(g, 'got'));
});

function fbGame(players, slips, teams, skips) {
  var g = E.newFishbowl({ teams: teams || ['A', 'B'], players: players, slips: slips, secs: 60, skips: skips == null ? 1 : skips }, 11);
  for (var p = 0; p < players; p++) {
    var words = [];
    for (var s = 0; s < slips; s++) words.push('slip ' + p + '-' + s);
    assert.ok(E.fbAddPlayer(g, 'P' + p, -1, words).ok);
  }
  assert.ok(E.fbBegin(g));
  return g;
}

test('fishbowl: slip entry validates and deals teams', function () {
  var g = E.newFishbowl({ teams: ['A', 'B'], players: 4, slips: 3 }, 1);
  assert.strictEqual(E.fbAddPlayer(g, 'Ann', -1, ['x', '', 'z']).err, 'empty');
  assert.strictEqual(E.fbAddPlayer(g, 'Ann', -1, ['x', 'X ', 'z']).err, 'dup');
  assert.ok(E.fbAddPlayer(g, ' Ann ', -1, ['Moon', 'kite', 'lighthouse']).ok);
  assert.strictEqual(E.fbAddPlayer(g, 'Bo', -1, ['moon', 'a', 'b']).err, 'dup', 'already in the bowl');
  assert.ok(E.fbAddPlayer(g, '', -1, ['a', 'b', 'c']).ok);
  assert.deepStrictEqual(g.players, [{ name: 'Ann', team: 0 }, { name: 'Player 2', team: 1 }]);
  assert.ok(E.fbAddPlayer(g, 'C', 1, ['d', 'e', 'f']).ok);
  assert.ok(E.fbAddPlayer(g, 'D', 1, ['g', 'h', 'i']).ok);
  assert.strictEqual(E.fbBegin(g), true);
  assert.strictEqual(g.bowl.length, 12);
  // a team with nobody can't start
  var h = E.newFishbowl({ teams: ['A', 'B'], players: 4, slips: 2 }, 1);
  ['a', 'b', 'c', 'd'].forEach(function (n, i) { E.fbAddPlayer(h, n, 0, [n + '1', n + '2']); });
  assert.strictEqual(E.fbBegin(h), false);
});

test('fishbowl: three rounds with the same slips, carry-over, rotation', function () {
  var g = fbGame(4, 2), guard = 0, roundsSeen = [];
  var describers = {};
  while (!g.over && guard++ < 200) {
    var t = E.fbStart(g);
    describers[g.players[t.player].name] = 1;
    assert.strictEqual(g.players[t.player].team, t.team, 'describer is on the team');
    var n = 0;
    while (!t.done && n < 3) { E.fbGot(g); E.fbTick(g, 5); n++; }
    if (!t.done) E.fbTick(g, 999);
    var e = E.fbCommit(g);
    if (e.roundOver) roundsSeen.push(e.round);
    if (e.end === 'bowl' && e.round < 2) {
      assert.ok(e.carry >= E.CARRY_MIN, 'leftover time carried');
      assert.strictEqual(g.ti, e.team, 'same team goes again');
      var t2 = E.fbStart(g);
      assert.ok(t2.carried); assert.strictEqual(t2.left, e.carry); assert.strictEqual(t2.player, e.player);
      E.fbTick(g, 999); E.fbCommit(g);
    }
  }
  assert.ok(g.over);
  assert.deepStrictEqual(roundsSeen, [0, 1, 2]);
  var tot = g.teams[0].score + g.teams[1].score;
  assert.strictEqual(tot, 8 * 3, 'every slip scored once per round');
  g.teams.forEach(function (t) { assert.strictEqual(t.rs[0] + t.rs[1] + t.rs[2], t.score); });
  assert.strictEqual(Object.keys(describers).length, 4, 'every player described');
});

test('fishbowl: skips are limited and never lose a slip', function () {
  var g = fbGame(4, 3, ['A', 'B'], 1);
  var t = E.fbStart(g), first = t.cur;
  assert.ok(E.fbSkip(g));
  assert.notStrictEqual(t.cur, first);
  assert.strictEqual(E.fbSkip(g), false, 'one skip per turn');
  assert.strictEqual(g.bowl.length, 12);
  E.fbTick(g, 61);
  assert.strictEqual(t.end, 'time');
  E.fbCommit(g);
  assert.strictEqual(g.bowl.length, 12, 'the timed-out slip goes back');
  var u = E.newFishbowl({ teams: ['A', 'B'], players: 4, slips: 2, skips: -1 }, 3);
  E.fbFillFromDeck(u, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  E.fbBegin(u); E.fbStart(u);
  for (var i = 0; i < 20; i++) assert.ok(E.fbSkip(u), 'unlimited');
  // one slip left: skipping is pointless and refused
  u.bowl = [u.turn.cur];
  assert.strictEqual(E.fbSkip(u), false);
});

test('fishbowl: the deck fills the bowl with unique slips and team names', function () {
  var words = [];
  CATS.forEach(function (c) { c.words.forEach(function (x) { words.push(x.w); }); });
  var g = E.newFishbowl({ teams: ['Red', 'Blue', 'Green'], players: 7, slips: 4, deck: true }, 9);
  assert.strictEqual(E.fbFillFromDeck(g, words), 28);
  assert.strictEqual(new Set(g.slips.map(function (s) { return E.wordKey(s.w); })).size, 28);
  assert.deepStrictEqual(g.players.slice(0, 4).map(function (p) { return p.name; }), ['Red 1', 'Blue 1', 'Green 1', 'Red 2']);
  assert.ok(E.fbBegin(g));
});

test('hot seat: seats rotate, scoring is fair, questions recycle', function () {
  var qs = E.hotseatPool(DATA, ['light'], { rs: 2 });
  assert.strictEqual(qs.length, DATA.hotseat.light.length);
  var g = E.newHotSeat({ players: ['Ann', 'Bo', '', 'Di', ''], laps: 2 }, qs.slice(0, 3), 5);
  assert.deepStrictEqual(g.players.map(function (p) { return p.name; }), ['Ann', 'Bo', 'Player 3', 'Di', 'Player 5']);
  g = E.newHotSeat({ players: ['Ann', 'Bo', '', 'Di'], laps: 2 }, qs.slice(0, 3), 5);
  assert.strictEqual(g.order.length, 8);
  var asked = [];
  for (var i = 0; i < 8; i++) {
    var seat = E.hsSeat(g);
    assert.strictEqual(seat, i % 4);
    asked.push(E.hsQuestion(g));
    E.hsSetAnswer(g, '  pizza   with   pineapple ');
    assert.strictEqual(g.answer, 'pizza with pineapple');
    var r = E.hsAward(g, i % 2 ? [seat, (seat + 1) % 4, (seat + 1) % 4, 99, -1] : []);
    assert.deepStrictEqual(r.ok, i % 2 ? [(seat + 1) % 4] : [], 'seat, dupes and junk ignored');
  }
  assert.ok(g.over);
  assert.strictEqual(E.hsAward(g, [1]), null);
  var total = g.players.reduce(function (s, p) { return s + p.score; }, 0);
  assert.strictEqual(total, 8, '4 right guesses + 4 seat bonuses');
  assert.ok(asked.every(Boolean));
});

test('tilt: nod down = got, tip up = skip, re-arms only near upright', function () {
  var st = E.tiltNew(), out = [];
  function feed(b, gm) { var r = E.tiltStep(st, b, gm); if (r) out.push(r); }
  feed(10, 0);                // lying flat: not armed yet
  assert.deepStrictEqual(out, []);
  feed(90, 0);                // upright (portrait): armed
  feed(150, 0);               // screen to the floor
  feed(160, 0);               // still down: no repeat
  feed(95, 0);                // back up
  feed(30, 0);                // screen to the ceiling
  feed(88, 3);
  // landscape on the forehead: gamma near ±90, crossing the flip
  feed(0, 89); feed(178, -85); feed(-175, -40);
  feed(2, 88); feed(5, 40);
  assert.deepStrictEqual(out, ['got', 'skip', 'got', 'skip']);
  assert.strictEqual(E.tiltStep(st, null, 5), null);
  assert.strictEqual(E.tiltStep(st, NaN, 5), null);
});

test('saves normalise defensively', function () {
  var s = E.normSave(null);
  assert.strictEqual(s.cfg.ch.teams.length, 2); assert.strictEqual(s.cfg.ch.secs, 60);
  [undefined, 5, 'x', [], { cfg: 'bad', rec: [1], used: 'no' }].forEach(function (o) { assert.ok(E.normSave(o).cfg.fb.players >= 4); });
  var w = E.normSave({
    cfg: { ch: { teams: ['', 'Sharks', 7, 'x', 'y', 'z', 'q', 'r'], secs: 31, rounds: 99, diff: 'insane', cats: ['animals', 5] },
      fb: { teams: ['solo'], players: 400, slips: 0, skips: 7 }, hs: { players: ['a'], laps: 9, decks: ['nope'] } },
    rec: { played: { ch: -3, fb: '4' }, chTurn: { n: 12, by: 'Red' }, hsTop: { n: 'x' } },
    used: ['a', 3, 'b']
  });
  assert.deepStrictEqual(w.cfg.ch.teams, ['Red', 'Sharks', '7', 'x', 'y', 'z']);
  assert.strictEqual(w.cfg.ch.secs, 60); assert.strictEqual(w.cfg.ch.rounds, 10); assert.strictEqual(w.cfg.ch.diff, 'mixed');
  assert.deepStrictEqual(w.cfg.ch.cats, ['animals']);
  assert.strictEqual(w.cfg.fb.teams.length, 2); assert.strictEqual(w.cfg.fb.players, 16); assert.strictEqual(w.cfg.fb.slips, 2); assert.strictEqual(w.cfg.fb.skips, 1);
  assert.strictEqual(w.cfg.hs.players.length, 3); assert.strictEqual(E.normSave(null).cfg.hs.players.length, 4); assert.strictEqual(w.cfg.hs.laps, 3); assert.deepStrictEqual(w.cfg.hs.decks, ['light', 'silly', 'deep']);
  assert.deepStrictEqual(w.rec.played, { ch: 0, fb: 4, hs: 0 });
  assert.deepStrictEqual(w.rec.chTurn, { n: 12, by: 'Red' }); assert.strictEqual(w.rec.hsTop, null);
  assert.deepStrictEqual(w.used, ['a', 'b']);
  E.noteUsed(w, ['A', 'C', 'c']);
  assert.deepStrictEqual(w.used, ['a', 'b', 'c']);
  for (var i = 0; i < E.USED_MAX + 50; i++) E.noteUsed(w, ['w' + i]);
  assert.strictEqual(w.used.length, E.USED_MAX);
});

test('records', function () {
  var s = E.newSave();
  assert.ok(E.recordTurn(s, 'ch', 5, 'Red'));
  assert.ok(!E.recordTurn(s, 'ch', 5, 'Blue'), 'a tie is not a record');
  assert.ok(!E.recordTurn(s, 'fb', 0, 'Blue'));
  var g = E.newCharades({ teams: ['A', 'B'] }, pool(), 1);
  g.teams[1].score = 9; g.over = true;
  assert.deepStrictEqual(E.recordGame(s, g), ['top charades score']);
  assert.deepStrictEqual(s.rec.chGame, { n: 9, by: 'B' });
  assert.strictEqual(s.rec.played.ch, 1);
});

test('a saved game survives JSON and junk is rejected', function () {
  var g = E.newCharades({ teams: ['A', 'B'], rounds: 3 }, pool(), 8);
  E.chStart(g); E.chMark(g, 'got'); E.chTick(g, 99); E.chCommit(g);
  var back = E.normGame(JSON.parse(JSON.stringify(g)));
  assert.strictEqual(back.teams[0].score, 1); assert.strictEqual(back.ti, 1); assert.strictEqual(back.pool.length, g.pool.length);
  // same rng stream after reload
  E.chStart(g); E.chStart(back);
  assert.strictEqual(back.turn.cur.w, g.turn.cur.w);
  var f = fbGame(4, 2); E.fbStart(f); E.fbGot(f); E.fbTick(f, 99); E.fbCommit(f);
  var fb = E.normGame(JSON.parse(JSON.stringify(f)));
  assert.strictEqual(fb.phase, 'play'); assert.strictEqual(fb.bowl.length, 7); assert.strictEqual(fb.slips.length, 8);
  assert.ok(E.fbStart(fb));
  var entry = E.newFishbowl({ players: 6, slips: 2 }, 1);
  E.fbAddPlayer(entry, 'A', -1, ['x', 'y']);
  var eb = E.normGame(JSON.parse(JSON.stringify(entry)));
  assert.strictEqual(eb.phase, 'entry'); assert.strictEqual(eb.entry, 1); assert.strictEqual(eb.slips.length, 2);
  var h = E.newHotSeat({ players: ['a', 'b', 'c'] }, ['q1', 'q2'], 3);
  E.hsQuestion(h); E.hsAward(h, [1]);
  var hb = E.normGame(JSON.parse(JSON.stringify(h)));
  assert.strictEqual(hb.oi, 1); assert.strictEqual(hb.players[1].score, 1);
  [null, 1, 'x', {}, { kind: 'charades' }, { kind: 'charades', pool: [], teams: [] }, { kind: 'hotseat', players: [{}], qs: [] },
    { kind: 'fishbowl', players: 'x' }, { kind: 'fishbowl', phase: 'play', players: [], slips: [] }, { kind: 'chess' }].forEach(function (o) {
    assert.strictEqual(E.normGame(o), null, JSON.stringify(o));
  });
  var bad = JSON.parse(JSON.stringify(f));
  bad.bowl = [999, -1, 'x', 2, 2]; bad.ti = 77; bad.carry = 5000; bad.carryP = 99;
  var nb = E.normGame(bad);
  assert.deepStrictEqual(nb.bowl, [2]); assert.ok(nb.ti < 2); assert.ok(nb.carryP < nb.players.length);
});

test('rng is deterministic and shuffles fully', function () {
  var a = { rs: 42 }, b = { rs: 42 };
  for (var i = 0; i < 50; i++) assert.strictEqual(E.rnd(a), E.rnd(b));
  var o = E.deckOrder(100, 3);
  assert.deepStrictEqual(o.slice().sort(function (x, y) { return x - y; }), Array.from({ length: 100 }, function (_, i) { return i; }));
  assert.deepStrictEqual(o, E.deckOrder(100, 3));
});

test('review edge cases: no carry in the last round, seat never self-scores, teams', function () {
  // the last round never carries leftover time (there is no next round)
  var g = fbGame(4, 2);
  g.round = 2; g.bowl = [0];
  var t = E.fbStart(g);
  E.fbGot(g);
  assert.ok(t.done); assert.strictEqual(g.carry, 0);
  E.fbCommit(g);
  assert.ok(g.over);
  assert.strictEqual(E.fbStart(g), null, 'no turns after the game');
  // the hot seat can't vote for itself, junk ids are ignored, game ends after the last seat
  var h = E.newHotSeat({ players: ['A', 'B', 'C'], laps: 1 }, ['q1', 'q2'], 1);
  var r = E.hsAward(h, [0, 0, 1, 'x', 9, -1]);
  assert.deepStrictEqual(r.ok, [1]); assert.strictEqual(h.players[0].score, 1); assert.strictEqual(h.players[1].score, 1);
  E.hsAward(h, []); E.hsAward(h, []);
  assert.ok(h.over); assert.strictEqual(E.hsAward(h, [0]), null);
  // charades always has at least two teams, at most six
  assert.strictEqual(E.normChCfg({ teams: ['Solo'] }).teams.length, 2);
  assert.strictEqual(E.normChCfg({ teams: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }).teams.length, 6);
  // a charades turn can be committed only once, and a resumed game keeps the same next word
  var c = E.newCharades({ teams: ['A', 'B'], rounds: 1 }, pool(), 8);
  E.chStart(c); E.chMark(c, 'got'); E.chEndEarly(c);
  assert.ok(E.chCommit(c)); assert.strictEqual(E.chCommit(c), null);
  var back = E.normGame(JSON.parse(JSON.stringify(c)));
  assert.strictEqual(E.chStart(back).cur.w, E.chStart(c).cur.w);
});

console.log(passed + ' passed');
