/* Headless checks for the Spin & Solve engine (board layout, bank, wheel physics,
 * rules, CPU, bonus, stats, saves). Not loaded by the app (not in the manifest).
 * Run: node txt/widgets/wheel/wheel.test.js */
'use strict';
var assert = require('assert');

var E = require('./wheel.js');
var DATA = require('./wheel-data.js');
var widget = null, css = [], assets = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, asset: function (p) { assets.push(p); return p; }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./wheel.js')];
require('./wheel.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var BANK = E.parseBank(DATA), DICT = E.buildDict(BANK);
function P(text, cat) { return { id: E.hashId(E.norm(text)), cat: cat || 'Phrase', text: text }; }
function game(seats, rounds, seed) {
  return E.newGame({ players: seats || [{ name: 'A', cpu: 0 }, { name: 'B', cpu: 0 }, { name: 'C', cpu: 0 }], rounds: rounds || 2, seed: seed || 7, clock: 45 });
}
// skip to the first main round with a given puzzle
function mainRound(g, text) {
  E.startRound(g, P('ICE CREAM'));          // toss-up 1
  E.tossEnd(g);
  return E.startRound(g, P(text));
}
function wedgeIdx(r, k, v) {
  for (var i = 0; i < r.wheel.length; i++) if (r.wheel[i].k === k && (v == null || r.wheel[i].v === v)) return i;
  return -1;
}

test('registers with the manifest metadata', function () {
  var man = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../../manifest.json'), 'utf8'));
  var m = (man.modules || man.items || man.widgets || []).find ? (man.modules || man.items || man.widgets || []).find(function (x) { return x.id === 'wheel'; }) : null;
  if (!m) { var all = JSON.stringify(man); assert.ok(all.indexOf('"id": "wheel"') >= 0 || all.indexOf('"id":"wheel"') >= 0); m = null; (function walk(o) { if (!o || typeof o !== 'object') return; if (o.id === 'wheel') m = o; for (var k in o) walk(o[k]); })(man); }
  assert.ok(widget, 'registered');
  assert.deepStrictEqual(css, ['wheel.css']);
  assert.deepStrictEqual(assets, ['wheel-data.js']);
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(widget[k], m[k], k); });
});

test('the bank: 600+ unique puzzles that all fit the board', function () {
  var raw = 0;
  DATA.cats.forEach(function (c) { raw += c.p.split('|').length; });
  assert.strictEqual(BANK.length, raw, 'every puzzle parses and fits');
  assert.ok(BANK.length >= 600, 'size ' + BANK.length);
  var ids = {};
  BANK.forEach(function (p) { assert.ok(!ids[p.id], 'duplicate id ' + p.text); ids[p.id] = 1; assert.ok(/^[A-Z &'\-?!.,]+$/.test(p.text), p.text); });
  assert.ok(DATA.cats.length >= 15, 'categories');
  assert.ok(BANK.filter(E.bonusOk).length >= 150, 'bonus-sized puzzles');
});

test('board layout: rows of 12/14/14/12, word wrapped, centered', function () {
  var l = E.layoutBoard('NIGHT LIGHT');
  assert.ok(l && l.cells.length === 10);
  var l2 = E.layoutBoard('THE EARLY BIRD CATCHES THE WORM');
  assert.ok(l2);
  l2.lines.forEach(function (line, j) { assert.ok(line.length <= E.ROW_CAP[l2.rows[j]]); });
  l2.cells.forEach(function (c) {
    assert.ok(c.c >= E.ROW_OFF[c.r] && c.c < E.ROW_OFF[c.r] + E.ROW_CAP[c.r], 'inside the row');
    assert.strictEqual('THE EARLY BIRD CATCHES THE WORM'.charAt(c.i), c.ch, 'cell maps to its char');
  });
  assert.strictEqual(E.layoutBoard('SUPERCALIFRAGILISTIC'), null, 'a word longer than a row cannot fit');
  // every bank puzzle: cells never collide
  BANK.forEach(function (p) {
    var lay = E.layoutBoard(p.text), seen = {};
    lay.cells.forEach(function (c) { var k = c.r + ':' + c.c; assert.ok(!seen[k], p.text); seen[k] = 1; });
    assert.strictEqual(lay.cells.length, p.text.replace(/ /g, '').length);
  });
});

test('puzzle picking avoids the recent list and the last category', function () {
  var r01 = E.mulberry32(3), recent = [];
  for (var i = 0; i < 200; i++) {
    var p = E.pickPuzzle(BANK, recent, r01, 'main');
    assert.ok(recent.indexOf(p.id) < 0, 'not recent');
    recent = E.noteRecent(recent, p.id, 400);
  }
  assert.strictEqual(recent.length, 200);
  var b = E.pickPuzzle(BANK, [], r01, 'bonus');
  assert.ok(E.bonusOk(b));
  var c = E.pickPuzzle(BANK, [], r01, 'main', 'Phrase');
  assert.notStrictEqual(c.cat, 'Phrase');
  // everything recent: still returns something
  assert.ok(E.pickPuzzle(BANK, BANK.map(function (x) { return x.id; }), r01, 'main'));
  assert.strictEqual(E.noteRecent(['a', 'b', 'c'], 'd', 3).join(), 'b,c,d');
});

test('wheel: 24 wedges, values grow by round, all special wedges present', function () {
  var w0 = E.makeWheel(0), w2 = E.makeWheel(2), w3 = E.makeWheel(3);
  assert.strictEqual(w0.length, 24);
  ['bk', 'lose', 'free', 'wild', 'mys', 'prize'].forEach(function (k) { assert.ok(w0.some(function (w) { return w.k === k; }), k); });
  function sum(w) { return w.reduce(function (s, x) { return s + (x.k === 'cash' ? x.v : 0); }, 0); }
  assert.ok(sum(w2) > sum(w0));
  assert.strictEqual(w0[0].v, 2500); assert.strictEqual(w2[0].v, 5000);
  assert.ok(w3.filter(function (w) { return w.k === 'bk'; }).length === 3, 'late rounds add a bankrupt');
  assert.strictEqual(E.bonusWheel().length, 24);
});

test('spin physics: friction stops it, pegs tick, wedgeAt maps the pointer', function () {
  assert.strictEqual(E.wedgeAt(0.001, 24), 23, 'rotating clockwise brings the previous wedge under the pointer');
  assert.strictEqual(E.wedgeAt(-0.001, 24), 0);
  assert.strictEqual(E.wedgeAt(-E.TAU / 24 * 5.5, 24), 5);
  var sp = { a: 0, w: 12 }, ticks = 0, t = 0;
  while (sp.w !== 0 && t < 30) { ticks += E.spinStep(sp, 1 / 120, 24); t += 1 / 120; }
  assert.ok(t > 2 && t < 9, 'spin lasts a few seconds: ' + t.toFixed(2));
  assert.ok(sp.a > E.TAU, 'more than a turn');
  assert.ok(Math.abs(ticks - Math.floor(sp.a / (E.TAU / 24))) <= 1, 'one tick per peg passed');
  var fast = E.spinRest(0, 18, 24), slow = E.spinRest(0, 4, 24);
  assert.ok(fast.a > slow.a, 'harder spins go further');
  var back = E.spinRest(0, -10, 24);
  assert.ok(back.a < 0, 'spins work both ways');
  // a range of spins lands on many different wedges
  var seen = {};
  for (var w = 5; w < 18; w += 0.37) seen[E.spinRest(0.3, w, 24).i] = 1;
  assert.ok(Object.keys(seen).length >= 12);
});

test('round sequence: toss-ups, main rounds, final, bonus', function () {
  var s = E.buildSeq(3).map(function (x) { return x.t + (x.final ? '!' : ''); }).join(' ');
  assert.strictEqual(s, 'toss main toss main main! bonus');
  assert.strictEqual(E.buildSeq(1).map(function (x) { return x.t + (x.final ? '!' : ''); }).join(' '), 'toss main! bonus');
});

test('calling letters: cash per letter, misses and repeats pass the turn', function () {
  var g = game(), r = mainRound(g, 'BANANA BREAD');
  var start = r.turn;
  assert.strictEqual(r.phase, 'turn');
  assert.ok(E.canSpin(g) && !E.canBuy(g));
  assert.ok(E.startSpin(g));
  var res = E.spinLand(g, wedgeIdx(r, 'cash', 600));
  assert.strictEqual(r.phase, 'call');
  assert.strictEqual(E.callLetter(g, 'A').ok, false, 'no vowels on a spin');
  res = E.callLetter(g, 'N');
  assert.strictEqual(res.n, 2); assert.strictEqual(res.earn, 1200);
  assert.strictEqual(g.players[start].round, 1200);
  assert.strictEqual(r.phase, 'turn'); assert.strictEqual(r.turn, start);
  // buy a vowel
  assert.ok(E.buyVowel(g));
  res = E.callLetter(g, 'A');
  assert.strictEqual(res.n, 4);
  assert.strictEqual(g.players[start].round, 950);
  // a repeat letter passes the turn
  E.startSpin(g); E.spinLand(g, wedgeIdx(r, 'cash', 600));
  res = E.callLetter(g, 'N');
  assert.strictEqual(res.ev, 'used');
  assert.strictEqual(r.turn, (start + 1) % 3);
  // a miss passes the turn
  E.startSpin(g); E.spinLand(g, wedgeIdx(r, 'cash', 600));
  res = E.callLetter(g, 'Z');
  assert.strictEqual(res.ev, 'miss');
  assert.strictEqual(r.turn, (start + 2) % 3);
});

test('bankrupt, lose a turn, free play', function () {
  var g = game(), r = mainRound(g, 'HOT DOG'), a = r.turn;
  E.startSpin(g); E.spinLand(g, wedgeIdx(r, 'cash', 900)); E.callLetter(g, 'T');
  assert.strictEqual(g.players[a].round, 900);
  E.startSpin(g); var res = E.spinLand(g, wedgeIdx(r, 'bk'));
  assert.strictEqual(res.ev, 'bk'); assert.strictEqual(res.lost, 900);
  assert.strictEqual(g.players[a].round, 0);
  assert.strictEqual(r.turn, (a + 1) % 3);
  var b = r.turn;
  E.startSpin(g); E.spinLand(g, wedgeIdx(r, 'lose'));
  assert.strictEqual(r.turn, (b + 1) % 3);
  var c = r.turn;
  E.startSpin(g); E.spinLand(g, wedgeIdx(r, 'free'));
  assert.strictEqual(r.phase, 'free');
  res = E.callLetter(g, 'O');                     // a vowel, free
  assert.strictEqual(res.n, 2); assert.strictEqual(g.players[c].round, 0);
  assert.strictEqual(r.turn, c);
  E.startSpin(g); E.spinLand(g, wedgeIdx(r, 'free'));
  res = E.callLetter(g, 'Q');                     // a miss costs nothing on free play
  assert.ok(res.keep); assert.strictEqual(r.turn, c); assert.strictEqual(r.phase, 'turn');
  E.startSpin(g); E.spinLand(g, wedgeIdx(r, 'free'));
  assert.ok(E.startSolve(g));
  res = E.trySolve(g, 'HOT HOG');
  assert.ok(!res.ok && res.keep, 'a wrong free-play solve keeps the turn');
  assert.strictEqual(r.turn, c);
});

test('wild, prize and mystery wedges', function () {
  var g = game(null, 2, 11), r = mainRound(g, 'TREASURE HUNT'), a = r.turn;
  E.startSpin(g); E.spinLand(g, wedgeIdx(r, 'wild'));
  var res = E.callLetter(g, 'T');
  assert.ok(res.wild && g.players[a].wild);
  assert.strictEqual(E.wedgeOf(r, wedgeIdx(r, 'wild')).k, 'cash', 'the wild card leaves the wheel');
  E.startSpin(g); E.spinLand(g, wedgeIdx(r, 'prize'));
  res = E.callLetter(g, 'R');
  assert.ok(res.prize);
  assert.strictEqual(r.held[a].length, 1);
  E.startSpin(g); E.spinLand(g, wedgeIdx(r, 'mys'));
  res = E.callLetter(g, 'H');
  assert.ok(res.mys); assert.strictEqual(r.phase, 'mystery');
  res = E.mystery(g, false);
  assert.strictEqual(r.phase, 'turn');
  assert.ok(r.mysDone);
  assert.strictEqual(E.wedgeOf(r, wedgeIdx(r, 'mys')).k, 'cash');
  // solving banks round money + held prize
  var before = g.players[a].round;
  E.startSolve(g);
  res = E.trySolve(g, 'treasure hunt');
  assert.ok(res.ok);
  assert.strictEqual(g.players[a].total, before + r.held[a][0].v);
  assert.strictEqual(r.phase, 'done');
  assert.deepStrictEqual(g.players[a].won.length, 1);
  // a mystery flip is a coin toss
  var wins = 0, bks = 0;
  for (var s = 1; s < 60; s++) {
    var g2 = game(null, 2, s), r2 = mainRound(g2, 'HOT DOG');
    E.startSpin(g2); E.spinLand(g2, wedgeIdx(r2, 'mys')); E.callLetter(g2, 'T');
    var m = E.mystery(g2, true);
    if (m.ev === 'mys-win') wins++; else bks++;
  }
  assert.ok(wins > 10 && bks > 10, wins + '/' + bks);
});

test('solving: wrong passes, right banks at least $1,000; others lose round money', function () {
  var g = game(), r = mainRound(g, 'PIECE OF CAKE'), a = r.turn, b = (a + 1) % 3;
  E.startSpin(g); E.spinLand(g, wedgeIdx(r, 'cash', 300)); E.callLetter(g, 'C');
  assert.strictEqual(g.players[a].round, 600);
  E.startSolve(g);
  var res = E.trySolve(g, 'PIECE OF CORN');
  assert.ok(!res.ok); assert.strictEqual(r.turn, b);
  E.startSpin(g); E.spinLand(g, wedgeIdx(r, 'cash', 300)); E.callLetter(g, 'P');
  assert.ok(E.startSolve(g)); assert.ok(E.cancelSolve(g)); assert.strictEqual(r.phase, 'turn');
  E.startSolve(g);
  res = E.trySolve(g, "  piece   of cake ");
  assert.ok(res.ok);
  assert.strictEqual(g.players[b].total, 1000, 'minimum $1,000');
  assert.strictEqual(g.players[a].total, 0, 'the other player keeps nothing');
  assert.ok(E.allShown(r));
});

test('toss-ups: reveal one tile at a time, buzz, lock out, winner starts the next round', function () {
  var g = game(), r = E.startRound(g, P('GARDEN HOSE'));
  assert.strictEqual(r.phase, 'toss');
  var n = 0;
  while (E.tossReveal(g) >= 0) n++;
  assert.strictEqual(E.hiddenIdx(r).length, 1, 'never reveals the last letter');
  assert.strictEqual(n, 9);
  assert.ok(E.buzz(g, 1));
  var res = E.trySolve(g, 'GARDEN HOSS');
  assert.ok(!res.ok); assert.strictEqual(r.phase, 'toss');
  assert.ok(!E.buzz(g, 1), 'locked out');
  assert.ok(E.buzz(g, 2));
  res = E.trySolve(g, 'GARDEN HOSE');
  assert.ok(res.ok);
  assert.strictEqual(g.players[2].total, 1000);
  var m = E.startRound(g, P('HOT DOG'));
  assert.strictEqual(m.turn, 2, 'toss-up winner starts');
  // everyone locked out: no winner
  var g2 = game(), r2 = E.startRound(g2, P('GARDEN HOSE'));
  [0, 1, 2].forEach(function (i) { E.buzz(g2, i); E.trySolve(g2, 'X'); });
  assert.strictEqual(r2.phase, 'done'); assert.strictEqual(r2.winner, -1);
});

test('final round clock: runs out into a final spin and a speed-up round', function () {
  var g = game(null, 1), r = mainRound(g, 'SNOW GLOBE');
  assert.ok(r.final && r.clock === 45);
  E.tickClock(g, 10);
  assert.strictEqual(r.clock, 35);
  E.startSpin(g);
  assert.ok(!E.tickClock(g, 5), 'clock waits while the wheel spins');
  E.spinLand(g, wedgeIdx(r, 'cash', 600));
  E.tickClock(g, 100);
  assert.strictEqual(r.phase, 'call', 'the current turn finishes first');
  var a = r.turn;
  E.callLetter(g, 'N');
  assert.strictEqual(r.phase, 'final');
  assert.ok(E.startSpin(g));
  var res = E.spinLand(g, wedgeIdx(r, 'cash', 600));
  assert.strictEqual(res.ev, 'speed'); assert.strictEqual(r.speed, 1600);
  assert.strictEqual(r.phase, 'speedCall'); assert.strictEqual(r.turn, a);
  res = E.callLetter(g, 'O');                    // vowels free
  assert.strictEqual(res.earn, 0); assert.strictEqual(r.phase, 'speedSolve');
  assert.ok(E.passSpeed(g)); assert.strictEqual(r.turn, (a + 1) % 3); assert.strictEqual(r.phase, 'speedCall');
  res = E.callLetter(g, 'S');
  assert.strictEqual(res.earn, 1600);
  E.startSolve(g);
  assert.ok(!E.cancelSolve(g), 'no backing out of a speed-up guess');
  res = E.trySolve(g, 'SNOW GLOBE');
  assert.ok(res.ok);
  assert.strictEqual(g.players[(a + 1) % 3].total, 1600);
  res = E.callLetter(g, 'Q');
  assert.ok(!res.ok);
});

test('timeouts pass play', function () {
  var g = game(), r = mainRound(g, 'HOT DOG'), a = r.turn;
  E.timeout(g); assert.strictEqual(r.turn, (a + 1) % 3);
  E.startSpin(g); E.spinLand(g, wedgeIdx(r, 'cash', 600));
  E.timeout(g); assert.strictEqual(r.turn, (a + 2) % 3); assert.strictEqual(r.phase, 'turn');
});

test('bonus round: RSTLNE given, 3 + 1 picks (+1 with WILD), solve or time out', function () {
  var g = game(null, 1);
  g.players[1].total = 5000; g.players[1].wild = true;
  E.startRound(g, P('X')); E.tossEnd(g);
  E.startRound(g, P('Y')); g.r.phase = 'done';
  assert.strictEqual(E.nextKind(g), 'bonus');
  var r = E.startRound(g, P('CHILL PILL'));
  assert.strictEqual(r.turn, 1); assert.strictEqual(r.phase, 'bspin');
  assert.deepStrictEqual(r.need, { c: 4, v: 1 });
  assert.ok(r.rev[3] && r.rev[4] && r.rev[9], 'L shown');
  E.startSpin(g); E.spinLand(g, 9);
  assert.strictEqual(r.phase, 'bpick'); assert.strictEqual(r.env, 9);
  assert.ok(!E.bonusPick(g, 'T').ok, 'given letters cannot be picked');
  ['C', 'H', 'P', 'M'].forEach(function (L) { assert.ok(E.bonusPick(g, L).ok); });
  assert.strictEqual(E.bonusPick(g, 'B').ev, 'full-c');
  assert.ok(E.bonusUnpick(g)); assert.ok(E.bonusPick(g, 'D').ok);
  assert.ok(!E.bonusReveal(g), 'needs the vowel');
  assert.ok(E.bonusPick(g, 'I').done);
  var idx = E.bonusReveal(g);
  assert.ok(idx.length >= 5);
  assert.strictEqual(r.phase, 'bsolve');
  assert.ok(!E.trySolve(g, 'CHILL BILL').ok); assert.strictEqual(r.phase, 'bsolve', 'keep guessing');
  var res = E.trySolve(g, 'CHILL PILL');
  assert.ok(res.ok); assert.strictEqual(g.players[1].bonus, 100000); assert.ok(g.over);
  assert.strictEqual(E.standings(g)[0], 1);
  var g2 = game(null, 1); E.startRound(g2, P('X')); E.tossEnd(g2); E.startRound(g2, P('Y')); g2.r.phase = 'done';
  E.startRound(g2, P('CHILL PILL')); E.startSpin(g2); E.spinLand(g2, 0);
  'CHPA'.split('').forEach(function (L) { E.bonusPick(g2, L); }); E.bonusReveal(g2);
  res = E.timeout(g2);
  assert.strictEqual(res.ev, 'bonus-lose'); assert.ok(g2.over); assert.strictEqual(g2.players[0].bonus, 0);
});

test('CPU: pattern matching picks good letters and solves when it can read the board', function () {
  var g = game([{ cpu: 4 }, { cpu: 1 }]), r = mainRound(g, 'JUMP ROPE');
  var sc = E.letterScores(r, DICT, E.CONS);
  assert.ok(Object.keys(sc).length === 21);
  assert.ok(!E.cpuKnows(g, 0, DICT), 'blank board: no idea');
  'JMPR'.split('').forEach(function (L) { E.hiddenIdx(r, L).forEach(function (i) { r.rev[i] = true; }); r.used += L; });
  assert.ok(E.knowledge(r, DICT) > 0.6);
  var knows = 0;
  for (var k = 0; k < 20; k++) if (E.cpuKnows(g, 0, DICT)) knows++;
  assert.ok(knows >= 15, 'expert reads J_MP R_P_: ' + knows);
  assert.strictEqual(E.cpuGuess(g, 0, DICT, true), 'JUMP ROPE');
  var v = E.cpuLetter(g, 0, DICT, E.VOWELS);
  assert.ok(v === 'U' || v === 'O' || v === 'E', 'expert vowel ' + v);
  // full simulations: CPU-only rounds always finish; experts solve faster than easy CPUs
  function sim(d) {
    var acts = 0, wrong = 0;
    for (var s = 1; s <= 30; s++) {
      var gg = game([{ cpu: d }, { cpu: d }, { cpu: d }], 2, s * 13 + d), r01 = E.mulberry32(s);
      E.startRound(gg, E.pickPuzzle(BANK, [], r01)); E.tossEnd(gg);
      var rr = E.startRound(gg, E.pickPuzzle(BANK, [], r01)), t = 0;
      while (rr.phase !== 'done' && t < 400) {
        t++;
        var pi = rr.turn, c = E.cpuTurn(gg, pi, DICT);
        if (c === 'solve' || c === 'guess') { E.startSolve(gg); if (!E.trySolve(gg, E.cpuGuess(gg, pi, DICT, c === 'solve')).ok) wrong++; continue; }
        if (c === 'vowel') { E.buyVowel(gg); E.callLetter(gg, E.cpuLetter(gg, pi, DICT, E.VOWELS)); continue; }
        E.startSpin(gg); E.spinLand(gg, Math.floor(r01() * 24));
        if (rr.phase === 'call' || rr.phase === 'free') E.callLetter(gg, E.cpuLetter(gg, pi, DICT, E.CONS));
        if (rr.phase === 'mystery') E.mystery(gg, E.cpuFlip(gg, pi));
      }
      assert.strictEqual(rr.phase, 'done', 'round finished');
      acts += t;
    }
    return { acts: acts / 30, wrong: wrong };
  }
  var easy = sim(1), expert = sim(4);
  assert.ok(expert.acts < easy.acts, 'expert ' + expert.acts + ' vs easy ' + easy.acts);
  assert.ok(expert.wrong <= 3, 'experts rarely guess wrong: ' + expert.wrong);
  // bonus picks are legal
  var gb = game([{ cpu: 3 }], 1); E.startRound(gb, P('X')); E.tossEnd(gb); E.startRound(gb, P('Y')); gb.r.phase = 'done';
  E.startRound(gb, P('BOOK NOOK')); E.startSpin(gb); E.spinLand(gb, 2);
  var picks = E.cpuBonusPicks(gb, 0, DICT);
  assert.strictEqual(picks.length, 4);
  picks.split('').forEach(function (L) { assert.ok(E.bonusPick(gb, L).ok, 'pick ' + L + ' of ' + picks); });
});

test('settings, stats, saves', function () {
  var s = E.normSettings({ rounds: 99, timer: 7, clock: 60, anim: 'fast', diff: 9 });
  assert.deepStrictEqual(s, { rounds: 5, diff: 4, timer: 0, clock: 60, anim: 'fast' });
  assert.deepStrictEqual(E.normSettings(null), { rounds: 3, diff: 2, timer: 0, clock: 45, anim: 'normal' });
  var g = game([{ name: 'Me', cpu: 0 }, { name: 'Bot', cpu: 2 }], 1);
  E.startRound(g, P('X')); E.tossEnd(g);
  var r = E.startRound(g, P('HOT DOG'));
  r.turn = 0; g.players[0].round = 3000; E.startSolve(g); E.trySolve(g, 'HOT DOG');
  E.startRound(g, P('BOOK NOOK')); E.startSpin(g); E.spinLand(g, 1);
  'BKMA'.split('').forEach(function (L) { E.bonusPick(g, L); }); E.bonusReveal(g); E.trySolve(g, 'BOOK NOOK');
  var st = E.recordGame(null, g, '2026-11-25');
  assert.strictEqual(st.games, 1); assert.strictEqual(st.wins, 1);
  assert.strictEqual(st.bonusPlays, 1); assert.strictEqual(st.bonusWins, 1);
  assert.strictEqual(st.bestBank, 3000 + 45000); assert.strictEqual(st.bestRound, 3000);
  assert.strictEqual(st.board[0].n, 'Me');
  assert.deepStrictEqual(E.normStats(JSON.parse(JSON.stringify(st))), st);
  // saves round-trip through JSON; transient phases resume sensibly
  var g2 = game(), r2 = mainRound(g2, 'HOT DOG');
  E.startSpin(g2);
  var back = E.normGame(JSON.parse(JSON.stringify(g2)));
  assert.ok(back); assert.strictEqual(back.r.phase, 'turn');
  E.startSolve(g2);
  E.spinLand(g2, wedgeIdx(r2, 'cash', 600)); E.callLetter(g2, 'T'); E.startSolve(g2);
  assert.strictEqual(E.normGame(JSON.parse(JSON.stringify(g2))).r.phase, 'turn', 'a solve in progress resumes at the turn');
  g2.r.phase = 'done';
  assert.strictEqual(E.normGame(JSON.parse(JSON.stringify(g2))).r.phase, 'done', 'between rounds resumes at the result');
  assert.strictEqual(E.normGame({ v: 0 }), null);
  assert.strictEqual(E.normGame(null), null);
  g2.over = true;
  assert.strictEqual(E.normGame(JSON.parse(JSON.stringify(g2))), null);
  // the RNG lives in the game: same seed, same draws
  var x = game(null, 2, 5), y = game(null, 2, 5);
  assert.strictEqual(E.rnd(x), E.rnd(y));
});

console.log(passed + ' passed' + (process.exitCode ? ' (with failures)' : ''));
