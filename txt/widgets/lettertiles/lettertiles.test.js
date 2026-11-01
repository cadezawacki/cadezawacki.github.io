/* Headless checks for the Letter Tiles engine (rules, scoring, dictionary, move
 * generator, CPU, saves). Not loaded by the app (not in the manifest).
 * Run: node txt/widgets/lettertiles/lettertiles.test.js */
'use strict';
var assert = require('assert');

var E = require('./lettertiles.js');
var WORDS = require('./lettertiles-words.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, asset: function (p) { return p; }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./lettertiles.js')];
require('./lettertiles.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var BIG = E.buildDict(WORDS);
function idx(r, c) { return r * 15 + c; }
function across(r, c, s) { return s.split('').map(function (ch, k) { return { i: idx(r, c + k), ch: ch }; }); }
function down(r, c, s) { return s.split('').map(function (ch, k) { return { i: idx(r + k, c), ch: ch }; }); }
function emptyBoard() { var b = []; for (var i = 0; i < 225; i++) b.push(''); return b; }
function put(b, pl) { pl.forEach(function (p) { b[p.i] = p.ch; }); return b; }
function plOf(m) { return m.cells.map(function (c, k) { return { i: c, ch: m.chars[k] }; }); }
function keyOf(pl) { return pl.map(function (p) { return p.i + p.ch; }).sort().join(','); }
function conserve(g) {
  var n = g.bag.length;
  g.board.forEach(function (c) { if (c) n++; });
  g.players.forEach(function (p) { n += p.rack.length; });
  return n;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Letter Tiles' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'lettertiles.css');
});

test('the bag: 100 tiles, two blanks, sane values', function () {
  assert.strictEqual(E.TOTAL, 100);
  assert.strictEqual(E.newBag().length, 100);
  assert.strictEqual(E.TILESET['?'][0], 2);
  assert.strictEqual(E.tileVal('?'), 0);
  assert.strictEqual(E.tileVal('q'), 0);       // a blank played as Q
  assert.strictEqual(E.tileVal('Q'), 10);
  E.LETTERS.split('').forEach(function (ch) { assert.ok(E.TILESET[ch][0] >= 1 && E.TILESET[ch][1] >= 1); });
});

test('the premium layout is symmetric with the start square doubling', function () {
  assert.strictEqual(E.PREM.length, 225);
  assert.strictEqual(E.PREM[E.CENTER], 'dw');
  for (var r = 0; r < 15; r++) for (var c = 0; c < 15; c++) {
    var p = E.PREM[idx(r, c)];
    assert.strictEqual(p, E.PREM[idx(c, r)]);
    assert.strictEqual(p, E.PREM[idx(14 - r, c)]);
    assert.strictEqual(p, E.PREM[idx(r, 14 - c)]);
  }
  var n = {};
  E.PREM.forEach(function (p) { n[p] = (n[p] || 0) + 1; });
  assert.ok(n.tw === 8 && n.dw >= 10 && n.tl >= 8 && n.dl >= 20);
});

test('the bundled dictionary decodes in full', function () {
  assert.strictEqual(BIG.words, WORDS.n);
  assert.ok(WORDS.n > 200000);
  ['cat', 'qi', 'xi', 'za', 'quixotic', 'aardvark', 'zymurgy', 'jukebox', 'tiles'].forEach(function (w) { assert.ok(E.hasWord(BIG, w), w); });
  ['qzx', 'aaaaa', 'tilez', 'c', ''].forEach(function (w) { assert.ok(!E.hasWord(BIG, w), w); });
  // chunked building gives the same trie
  var b = E.dictBuilder(WORDS), steps = 0;
  while (!b.step(20000)) steps++;
  assert.ok(steps > 5);
  assert.strictEqual(b.dict.n, BIG.n);
  assert.strictEqual(b.dict.words, BIG.words);
});

var SMALL = E.dictFrom(['cat', 'cats', 'at', 'ta', 'act', 'acts', 'scat', 'tact', 'as', 'sat', 'tas', 'it', 'its', 'sit', 'tis', 'ti', 'is', 'si', 'cast', 'scab', 'tab', 'tabs', 'bat', 'bats', 'ab', 'abs', 'ba', 'bi', 'bit', 'bits', 'qi', 'za', 'zap', 'pa', 'pat', 'pats', 'tap', 'taps', 'spat', 'past', 'pas', 'apt']);

test('first move: through the centre, two letters or more, in a line, no gaps', function () {
  var b = emptyBoard();
  assert.ok(E.evalPlay(b, SMALL, across(7, 7, 'CAT')).ok);
  assert.ok(/centre/.test(E.evalPlay(b, SMALL, across(0, 0, 'CAT')).err));
  assert.ok(/two letters/.test(E.evalPlay(b, SMALL, [{ i: E.CENTER, ch: 'A' }]).err));
  assert.ok(/one row/.test(E.evalPlay(b, SMALL, [{ i: idx(7, 7), ch: 'A' }, { i: idx(8, 8), ch: 'T' }]).err));
  assert.ok(/gaps/.test(E.evalPlay(b, SMALL, [{ i: idx(7, 6), ch: 'C' }, { i: idx(7, 7), ch: 'A' }, { i: idx(7, 9), ch: 'T' }]).err));
  var bad = E.evalPlay(b, SMALL, across(7, 7, 'TCA'));
  assert.ok(!bad.ok && /Not a word: TCA/.test(bad.err) && bad.words[0].ok === false);
});

test('scoring: letter values, letter and word squares, start square doubles', function () {
  var b = emptyBoard();
  // C(3)+A(1)+T(1) = 5, the T on the centre (2W) → 10
  var r = E.evalPlay(b, SMALL, across(7, 5, 'CAT'));
  assert.ok(r.ok); assert.strictEqual(r.score, 10);
  // 2L at (7,3): CATS from col 3 → C on 2L: (6+1+1+1)=9, no 2W reached → 9
  r = E.evalPlay(b, SMALL, across(7, 3, 'CATS'));
  assert.ok(!r.ok);                                  // doesn't cover the centre
  r = E.evalPlay(b, SMALL, across(7, 4, 'CATS'));    // C(7,4) A T S(7,7 2W) → 6*2 = 12
  assert.ok(r.ok); assert.strictEqual(r.score, 12);
  // a blank scores nothing, even on a premium square
  r = E.evalPlay(b, SMALL, [{ i: idx(7, 5), ch: 'c' }, { i: idx(7, 6), ch: 'A' }, { i: idx(7, 7), ch: 'T' }]);
  assert.strictEqual(r.score, 4);
});

test('later moves must connect; cross words count; premiums only under new tiles', function () {
  var b = put(emptyBoard(), across(7, 5, 'CAT'));
  assert.ok(/Connect/.test(E.evalPlay(b, SMALL, across(0, 0, 'AT')).err));
  // S after CAT → CATS (3+1+1+1 = 6; (7,8) is plain) → 6
  var r = E.evalPlay(b, SMALL, [{ i: idx(7, 8), ch: 'S' }]);
  assert.ok(r.ok); assert.strictEqual(r.score, 6); assert.deepStrictEqual(r.words.map(function (w) { return w.w; }), ['CATS']);
  // the centre 2W no longer doubles: TA down from the T → T(1) + A(1) = 2
  r = E.evalPlay(b, SMALL, [{ i: idx(8, 7), ch: 'A' }]);
  assert.ok(r.ok); assert.strictEqual(r.score, 2); assert.strictEqual(r.dir, 1);
  // two words at once: IT down at col 8 (I at (6,8), T... ) — place AB under CA: (8,5)A? build parallel
  var b2 = put(emptyBoard(), across(7, 6, 'AT'));
  // "BI" below "AT"? crosses: A/B → AB, T/I → TI
  r = E.evalPlay(b2, SMALL, across(8, 6, 'BI'));
  assert.ok(r.ok);
  var ws = r.words.map(function (w) { return w.w; }).sort();
  assert.deepStrictEqual(ws, ['AB', 'BI', 'TI']);
  // (8,6) is 2L: BI = 3*2+1 = 7; AB = 1 + 6 = 7; TI = 1+1 = 2 → 16
  assert.strictEqual(r.score, 16);
});

test('bingo: all seven tiles score 50 more', function () {
  var d = E.dictFrom(['tablets', 'ab']);
  var r = E.evalPlay(emptyBoard(), d, across(7, 1, 'TABLETS'));
  assert.ok(r.ok && r.bingo);
  // T(1,2W at 7,1) A B(3,2L at 7,3) L E T S(1, 2W at 7,7) → (1+1+6+1+1+1+1)=12 * 4 = 48 + 50
  assert.strictEqual(r.score, 98);
});

test('the generator finds exactly the valid plays (small dictionary, brute force)', function () {
  var boards = [emptyBoard(), put(emptyBoard(), across(7, 5, 'CAT')), put(put(emptyBoard(), across(7, 5, 'CAT')), down(4, 7, 'PAS'))];
  var racks = [['B', 'I', 'T', 'S', 'A', 'P', 'Z'], ['S', 'A', 'T', 'Q', 'I', 'B', 'C']];
  var dictWords = ['cat', 'cats', 'at', 'ta', 'act', 'acts', 'scat', 'tact', 'as', 'sat', 'tas', 'it', 'its', 'sit', 'tis', 'ti', 'is', 'si', 'cast', 'scab', 'tab', 'tabs', 'bat', 'bats', 'ab', 'abs', 'ba', 'bi', 'bit', 'bits', 'qi', 'za', 'zap', 'pa', 'pat', 'pats', 'tap', 'taps', 'spat', 'past', 'pas', 'apt'];
  boards.forEach(function (b) {
    racks.forEach(function (rack) {
      var gen = E.genMoves(SMALL, b, rack), got = {};
      gen.forEach(function (m) {
        var k = keyOf(plOf(m));
        assert.ok(!got[k], 'duplicate ' + k);
        got[k] = m.sc;
        var r = E.evalPlay(b, SMALL, plOf(m));
        assert.ok(r.ok, m.word + ' ' + r.err);
        assert.strictEqual(r.score, m.sc, m.word);
      });
      // brute force: every dictionary word, every line and start, both directions
      var want = {};
      dictWords.forEach(function (w) {
        w = w.toUpperCase();
        for (var dd = 0; dd < 2; dd++) for (var L = 0; L < 15; L++) for (var s = 0; s + w.length <= 15; s++) {
          var pl = [], left = rack.slice(), ok = true;
          for (var k = 0; k < w.length && ok; k++) {
            var cell = dd ? idx(s + k, L) : idx(L, s + k), have = b[cell];
            if (have) { if (have.toUpperCase() !== w.charAt(k)) ok = false; continue; }
            var at = left.indexOf(w.charAt(k));
            if (at < 0) { ok = false; break; }
            left.splice(at, 1);
            pl.push({ i: cell, ch: w.charAt(k) });
          }
          if (!ok || !pl.length) continue;
          var r = E.evalPlay(b, SMALL, pl);
          if (r.ok && r.words[0].w === w) want[keyOf(pl)] = r.score;
        }
      });
      Object.keys(want).forEach(function (k) { assert.strictEqual(got[k], want[k], 'missed ' + k); });
      Object.keys(got).forEach(function (k) { assert.ok(k in want, 'extra ' + k); });
    });
  });
});

test('blanks: the generator plays them as any letter for 0 points', function () {
  var b = put(emptyBoard(), across(7, 5, 'CAT'));
  var gen = E.genMoves(SMALL, b, ['?', 'Z']);
  var zap = gen.filter(function (m) { return m.word === 'ZAP'; });
  assert.ok(zap.length >= 1);
  gen.forEach(function (m) {
    m.chars.forEach(function (ch) { if (ch !== 'Z') assert.ok(E.isBlankCh(ch), 'only one real tile: Z'); });
    var r = E.evalPlay(b, SMALL, plOf(m));
    assert.ok(r.ok); assert.strictEqual(r.score, m.sc);
  });
});

test('big dictionary: generated moves are legal and scored like a person\'s play', function () {
  var g = E.newGame({ seed: 99, players: [{ name: 'A', cpu: 3 }, { name: 'B', cpu: 3 }] }), checked = 0;
  for (var t = 0; t < 12 && !g.over; t++) {
    var p = E.current(g), moves = E.genMoves(BIG, g.board, p.rack);
    for (var k = 0; k < moves.length; k += Math.max(1, Math.floor(moves.length / 40))) {
      var r = E.evalPlay(g.board, BIG, plOf(moves[k]));
      assert.ok(r.ok, moves[k].word + ' ' + r.err);
      assert.strictEqual(r.score, moves[k].sc);
      checked++;
    }
    var dec = E.cpuDecide(moves, 3, p.rack, g.bag.length, E.rng(t));
    if (dec.type === 'play') assert.ok(E.play(g, BIG, plOf(dec.move)).ok);
    else if (dec.type === 'swap') assert.ok(E.swap(g, dec.tiles));
    else E.pass(g);
    assert.strictEqual(conserve(g), 100);
  }
  assert.ok(checked > 100);
});

test('chunked search: one board line per step, same moves', function () {
  var b = put(put(emptyBoard(), across(7, 5, 'CAT')), down(4, 7, 'PAS'));
  var rack = ['E', 'R', 'S', 'T', 'O', '?', 'N'];
  var s = E.makeSearch(BIG, b, rack), steps = 0;
  while (!s.step()) steps++;
  assert.ok(steps >= 5 && steps <= 30);
  assert.strictEqual(s.moves.length, E.genMoves(BIG, b, rack).length);
});

test('a whole CPU game finishes, keeps every tile and is reproducible', function () {
  function game(seed, lv) {
    var g = E.newGame({ seed: seed, players: [{ name: 'A', cpu: lv[0] }, { name: 'B', cpu: lv[1] }] }), rr = E.rng(seed), n = 0;
    while (!g.over && n++ < 300) {
      var p = E.current(g), dec = E.cpuDecide(E.genMoves(BIG, g.board, p.rack), p.cpu, p.rack, g.bag.length, rr);
      if (dec.type === 'play') { var r = E.play(g, BIG, plOf(dec.move)); assert.ok(r.ok, r.err); }
      else if (dec.type === 'swap') assert.ok(E.swap(g, dec.tiles));
      else E.pass(g);
      assert.strictEqual(conserve(g), 100);
    }
    assert.ok(g.over, 'game ended');
    return g;
  }
  var a = game(7, [3, 1]), b = game(7, [3, 1]);
  assert.deepStrictEqual(a.board, b.board);
  assert.deepStrictEqual(a.players.map(function (p) { return p.score; }), b.players.map(function (p) { return p.score; }));
  // hard beats easy over a few games
  var hardWins = 0;
  for (var s = 1; s <= 4; s++) { var g = game(100 + s, [3, 1]); if (g.players[0].score > g.players[1].score) hardWins++; }
  assert.ok(hardWins >= 3, 'hard won ' + hardWins + '/4');
});

test('cpu levels: easy random, medium middling, hard best (plus leave)', function () {
  var b = put(emptyBoard(), across(7, 5, 'CAT'));
  var rack = ['E', 'R', 'S', 'T', 'O', 'A', 'N'], moves = E.genMoves(BIG, b, rack);
  var top = Math.max.apply(null, moves.map(function (m) { return m.sc; }));
  var hard = E.cpuDecide(moves, 3, rack, 50, E.rng(1));
  assert.strictEqual(hard.type, 'play');
  assert.ok(hard.move.sc >= top - 12);
  var med = E.cpuDecide(moves, 2, rack, 50, E.rng(2));
  assert.ok(med.move.sc <= top && med.move.sc >= top * 0.3);
  var easy = E.cpuDecide(moves, 1, rack, 50, E.rng(3));
  assert.ok(moves.indexOf(easy.move) >= 0);
  // no moves: swap while the bag allows, else pass
  assert.strictEqual(E.cpuDecide([], 3, ['Q', 'Q', 'V'], 50).type, 'swap');
  assert.strictEqual(E.cpuDecide([], 3, ['Q'], 3).type, 'pass');
});

test('turns: rack checks, refills, pass / swap and the scoreless end', function () {
  var g = E.newGame({ seed: 3, players: [{ name: 'Ann', cpu: 0 }, { name: 'Bo', cpu: 0 }] });
  var t0 = g.turn, p = E.current(g);
  p.rack = ['C', 'A', 'T', 'E', 'E', 'E', 'E'];
  g.bag.push('X'); // keep the tile count honest for the test: swap one back out
  g.bag.splice(g.bag.indexOf('X'), 1);
  assert.ok(!E.play(g, SMALL, across(7, 7, 'ZAP')).ok);    // not on the rack
  var r = E.play(g, SMALL, across(7, 6, 'CAT'));
  assert.ok(r.ok);
  assert.strictEqual(p.rack.length, 7);
  assert.notStrictEqual(g.turn, t0);
  assert.deepStrictEqual(g.last, [idx(7, 6), idx(7, 7), idx(7, 8)]);
  var bagN = g.bag.length, q = E.current(g), before = q.rack.slice();
  assert.ok(E.swap(g, before.slice(0, 3)));
  assert.strictEqual(g.bag.length, bagN);
  assert.strictEqual(q.rack.length, 7);
  for (var k = 0; k < 3; k++) E.pass(g);
  assert.ok(g.over, '2 x players scoreless turns end the game');
  assert.strictEqual(g.result.out, -1);
});

test('going out: the rack values move to whoever finished', function () {
  var g = E.newGame({ seed: 4, players: [{ name: 'A', cpu: 0 }, { name: 'B', cpu: 0 }] });
  // empty the bag into the board area (pretend), leaving A with CAT and B with Q, Z
  g.bag = [];
  g.turn = 0;
  g.players[0].rack = ['C', 'A', 'T']; g.players[1].rack = ['Q', 'Z'];
  g.players[0].score = 100; g.players[1].score = 120;
  var r = E.play(g, SMALL, across(7, 6, 'CAT'));
  assert.ok(r.ok && g.over);
  assert.strictEqual(g.result.out, 0);
  assert.strictEqual(g.players[0].score, 100 + r.score + 19);
  assert.strictEqual(g.players[1].score, 120 - 19);
  assert.deepStrictEqual(g.result.win, [0]);
});

test('saves: round trip, and garbage or tampered saves are refused', function () {
  var g = E.newGame({ seed: 11 });
  var p = E.current(g), m = E.genMoves(BIG, g.board, p.rack);
  if (m.length) E.play(g, BIG, plOf(m[0])); else E.pass(g);
  var back = E.normGame(JSON.parse(JSON.stringify(g)));
  assert.ok(back);
  assert.deepStrictEqual(back.board, g.board);
  assert.deepStrictEqual(back.players, g.players);
  assert.strictEqual(back.turn, g.turn);
  assert.strictEqual(back.rs, g.rs);
  [null, 5, 'x', {}, { v: 1 }, { v: 2, board: [] }].forEach(function (o) { assert.strictEqual(E.normGame(o), null); });
  var t = JSON.parse(JSON.stringify(g)); t.bag.push('Q');               // an extra tile
  assert.strictEqual(E.normGame(t), null);
  t = JSON.parse(JSON.stringify(g)); t.board[0] = '<';
  assert.strictEqual(E.normGame(t), null);
  t = JSON.parse(JSON.stringify(g)); t.players[0].name = '<b>' + 'x'.repeat(40); t.turn = 9;
  var n = E.normGame(t);
  assert.ok(n && n.players[0].name.indexOf('<') < 0 && n.players[0].name.length <= 14 && n.turn === n.players.length - 1);
  // the resumed game draws the same tiles as the original would
  var a = JSON.parse(JSON.stringify(g)), b2 = E.normGame(JSON.parse(JSON.stringify(g)));
  E.pass(a); E.pass(b2);
  assert.deepStrictEqual(a.players.map(function (p) { return p.rack; }), b2.players.map(function (p) { return p.rack; }));
});

test('records: wins per CPU level, bests, longest word', function () {
  var rec = E.normRecords(null);
  var g = E.newGame({ seed: 2, players: [{ name: 'Me', cpu: 0 }, { name: 'Bot', cpu: 3 }] });
  g.players[0].score = 300; g.players[1].score = 200; g.players[0].best = 77; g.players[0].bestW = 'QUIZ'; g.players[0].bingos = 2;
  g.log.push({ p: 0, t: 'play', w: ['ZEPHYRS'], sc: 77 }, { p: 1, t: 'play', w: ['EXTRAORDINARY'], sc: 10 });
  E.finish(g, -1);
  var news = E.settle(rec, g);
  assert.strictEqual(rec.games, 1);
  assert.strictEqual(rec.cpu[3].w, 1);
  assert.strictEqual(rec.move, 77); assert.strictEqual(rec.moveW, 'QUIZ');
  assert.strictEqual(rec.long, 'ZEPHYRS');                // a CPU's word doesn't count
  assert.strictEqual(rec.bingos, 2);
  assert.ok(news.indexOf('score') >= 0 && news.indexOf('move') >= 0);
  var r2 = E.normRecords(JSON.parse(JSON.stringify(rec)));
  assert.deepStrictEqual(r2, rec);
  assert.deepStrictEqual(E.normRecords({ games: -4, cpu: 'x', long: 'a<b' }), E.newRecords());
  // CPU-only games don't count
  var cg = E.newGame({ seed: 5, players: [{ cpu: 1 }, { cpu: 2 }] }); E.finish(cg, -1);
  assert.deepStrictEqual(E.settle(rec, cg), []);
  assert.strictEqual(rec.games, 1);
});

test('the search is quick on a busy board', function () {
  var g = E.newGame({ seed: 21, players: [{ cpu: 3 }, { cpu: 3 }] }), worst = 0;
  for (var t = 0; t < 14 && !g.over; t++) {
    var p = E.current(g), t0 = Date.now(), moves = E.genMoves(BIG, g.board, p.rack.concat([]));
    worst = Math.max(worst, Date.now() - t0);
    var dec = E.cpuDecide(moves, 3, p.rack, g.bag.length, E.rng(t));
    if (dec.type === 'play') E.play(g, BIG, plOf(dec.move)); else E.pass(g);
  }
  var t1 = Date.now();
  E.genMoves(BIG, g.board, ['?', '?', 'E', 'S', 'R', 'A', 'T']);       // the worst case: two blanks
  worst = Math.max(worst, Date.now() - t1);
  assert.ok(worst < 1500, 'slowest search ' + worst + ' ms');
});


test('review: hard CPU with no moves swaps real rack letters the engine accepts', function () {
  var g = E.newGame({ seed: 9, players: [{ name: 'A', cpu: 3 }, { name: 'B', cpu: 0 }] });
  var p = E.current(g);
  var dec = E.cpuDecide([], 3, p.rack, g.bag.length, E.rng(1));
  assert.strictEqual(dec.type, 'swap');
  dec.tiles.forEach(function (t) { assert.ok(typeof t === 'string' && p.rack.indexOf(t) >= 0, 'tile ' + t); });
  var turn = g.turn;
  assert.ok(E.swap(g, dec.tiles), 'swap accepted');
  assert.notStrictEqual(g.turn, turn);
  assert.strictEqual(conserve(g), 100);
  [1, 2].forEach(function (lv) {
    var d = E.cpuDecide([], lv, ['Q', 'V', 'V'], 50);
    assert.ok(d.type === 'swap' && d.tiles.every(function (t) { return typeof t === 'string'; }));
  });
});

test('review: rule edge cases', function () {
  var b = put(emptyBoard(), across(7, 6, 'CAT'));
  // extending a word with one tile scores the whole word
  var r = E.evalPlay(b, SMALL, [{ i: idx(7, 9), ch: 'S' }]);
  assert.ok(r.ok && r.words.length === 1 && r.words[0].w === 'CATS', JSON.stringify(r));
  // a lone tile making words both ways counts both
  b = put(put(emptyBoard(), across(7, 6, 'CAT')), down(8, 9, 'T'));   // T below the S square
  r = E.evalPlay(b, SMALL, [{ i: idx(7, 9), ch: 'S' }]);
  var ws = r.words.map(function (w) { return w.w; }).sort();
  assert.deepStrictEqual(ws, ['CATS', 'ST'].sort());
  assert.ok(!r.ok);                                     // ST isn't in SMALL
  // tiles on both sides of an existing tile make one word through it
  b = put(emptyBoard(), across(7, 7, 'A'));
  r = E.evalPlay(b, SMALL, [{ i: idx(7, 6), ch: 'C' }, { i: idx(7, 8), ch: 'T' }]);
  assert.ok(r.ok && r.words[0].w === 'CAT');
  // a hole between placed tiles is a gap
  r = E.evalPlay(b, SMALL, [{ i: idx(7, 5), ch: 'C' }, { i: idx(7, 8), ch: 'T' }]);
  assert.ok(!r.ok && /gap/i.test(r.err));
  // premiums only count under new tiles: replaying over a used 2W/3L square doesn't double again
  var first = E.evalPlay(emptyBoard(), SMALL, across(7, 6, 'CAT'));
  assert.strictEqual(first.score, (3 + 1 + 1) * 2);     // centre doubles the word
  b = put(emptyBoard(), across(7, 6, 'CAT'));
  r = E.evalPlay(b, SMALL, [{ i: idx(7, 9), ch: 'S' }]);
  assert.strictEqual(r.score, (3 + 1 + 1 + 1 * E.LMUL[idx(7, 9)]) * E.WMUL[idx(7, 9)]);
  // a blank on a letter square scores nothing for that tile
  r = E.evalPlay(emptyBoard(), SMALL, [{ i: idx(7, 6), ch: 'c' }, { i: idx(7, 7), ch: 'A' }, { i: idx(7, 8), ch: 'T' }]);
  assert.ok(r.ok && r.score === (0 + 1 + 1) * 2);
  // a blank played needs a letter
  r = E.evalPlay(emptyBoard(), SMALL, [{ i: idx(7, 7), ch: '?' }, { i: idx(7, 8), ch: 'T' }]);
  assert.ok(!r.ok);
});

test('review: swap guards, and a save with a blank on the board loads', function () {
  var g = E.newGame({ seed: 12, players: [{ cpu: 0 }, { cpu: 0 }] });
  var p = E.current(g);
  assert.ok(!E.swap(g, []));
  assert.ok(!E.swap(g, ['?', '?', '?']) || p.rack.filter(function (c) { return c === '?'; }).length >= 3);
  var keep = g.bag; g.bag = g.bag.slice(0, 6);
  assert.ok(!E.swap(g, [p.rack[0]]), 'needs 7 in the bag');
  g.bag = keep;
  // hand the player a blank and an I (swapping tiles with the bag keeps the count honest)
  function give(ch, at) { g.bag.splice(g.bag.indexOf(ch), 1); g.bag.push(p.rack[at]); p.rack[at] = ch; }
  if (p.rack[0] !== '?') give('?', 0);
  if (p.rack[1] !== 'I') give('I', 1);
  var pl = [{ i: idx(7, 7), ch: 'q' }, { i: idx(7, 8), ch: 'I' }];
  assert.strictEqual(conserve(g), 100);
  var r = E.play(g, BIG, pl);
  assert.ok(r.ok, r.err);
  assert.strictEqual(g.board[idx(7, 7)], 'q');
  var back = E.normGame(JSON.parse(JSON.stringify(g)));
  assert.ok(back && back.board[idx(7, 7)] === 'q');
});

console.log(passed + ' passed');
if (process.exitCode) console.log('some checks FAILED');
