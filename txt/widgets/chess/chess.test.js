/* Headless checks for the Chess engine and the widget's pure helpers.
 * Not loaded by the app. Run: node txt/widgets/chess/chess.test.js */
'use strict';
var assert = require('assert');
var E = require('./chess-engine.js');
var H = require('./chess.js');

// The widget registers itself (with its helpers) when a Cade core is present.
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, asset: function (p) { return './txt/widgets/chess/' + p; }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./chess.js')];
require('./chess.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function play(fen, sans) {
  var p = E.fromFEN(fen || E.START_FEN);
  sans.forEach(function (s) { var m = E.fromSAN(p, s); assert.ok(m, 'illegal ' + s + ' in ' + p.fen()); p.make(m); });
  return p;
}
var KIWI = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Chess' && typeof widget.open === 'function');
  assert.deepStrictEqual(css, ['chess-board.css', 'chess.css']);
  assert.strictEqual(widget._helpers.fmtClock(65000), H.fmtClock(65000));
});

test('perft: start position depth 1-4', function () {
  var p = E.fromFEN(E.START_FEN);
  assert.deepStrictEqual([1, 2, 3, 4].map(function (d) { return E.perft(p, d); }), [20, 400, 8902, 197281]);
  assert.strictEqual(p.fen(), E.START_FEN, 'make / unmake left the position changed');
});
test('perft: kiwipete depth 1-3', function () {
  var p = E.fromFEN(KIWI);
  assert.deepStrictEqual([1, 2, 3].map(function (d) { return E.perft(p, d); }), [48, 2039, 97862]);
});
test('perft: tricky positions (en passant pins, promotions, castling rights)', function () {
  assert.strictEqual(E.perft(E.fromFEN('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1'), 5), 674624);
  assert.strictEqual(E.perft(E.fromFEN('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1'), 4), 422333);
  assert.strictEqual(E.perft(E.fromFEN('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8'), 3), 62379);
  assert.strictEqual(E.perft(E.fromFEN('r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10'), 3), 89890);
});
test('make / unmake restores the hash, and the incremental hash equals a fresh one', function () {
  var p = E.fromFEN(KIWI), r = E.rng(5);
  for (var i = 0; i < 300; i++) {
    var ms = p.legalMoves();
    if (!ms.length) break;
    var lo = p.lo, hi = p.hi, f = p.fen();
    var m = ms[Math.floor(r() * ms.length)];
    p.make(m);
    var q = E.fromFEN(p.fen());
    assert.ok(q.lo === p.lo && q.hi === p.hi, 'hash drift after ' + E.toUCI(m));
    p.unmake();
    assert.ok(p.lo === lo && p.hi === hi && p.fen() === f, 'unmake mismatch');
    p.make(m);
  }
});
test('FEN round trips, and bad FENs are rejected', function () {
  [E.START_FEN, KIWI, '8/8/8/4k3/8/8/8/4K3 b - - 12 40', 'rnbqkbnr/pppp1ppp/8/4pP2/8/8/PPPPP1PP/RNBQKBNR w KQkq e6 0 3'].forEach(function (f) { assert.strictEqual(E.fromFEN(f).fen(), f); });
  ['', 'nonsense', '8/8/8/8/8/8/8/8 w - - 0 1', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1'].forEach(function (f) { assert.throws(function () { E.fromFEN(f); }); });
  // castling rights the pieces can't back up are dropped
  assert.strictEqual(E.fromFEN('4k3/8/8/8/8/8/8/4K3 w KQkq - 0 1').castle, 0);
});
test('castling: not out of, through or into check; rights lost when king or rook moves', function () {
  function can(fen, uci) { var p = E.fromFEN(fen); return !!E.fromUCI(p, uci); }
  assert.ok(can('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1'));
  assert.ok(can('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1c1'));
  assert.ok(!can('r3k2r/8/8/8/8/8/4r3/R3K2R w KQkq - 0 1', 'e1g1'), 'out of check');
  assert.ok(!can('r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1', 'e1g1'), 'through check (f1 attacked)');
  assert.ok(!can('r3k2r/8/8/8/8/8/6r1/R3K2R w KQkq - 0 1', 'e1g1'), 'into check');
  assert.ok(can('r3k2r/8/8/8/8/8/1r6/R3K2R w KQkq - 0 1', 'e1c1'), 'b1 attacked doesn\'t stop O-O-O');
  var p = play('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', ['Rb1', 'Rb8']);
  assert.ok(!E.fromSAN(p, 'O-O-O') && E.fromSAN(p, 'O-O'));
  p = play(null, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O']);
  assert.ok(p.pieceAt('g1') === E.K && p.pieceAt('f1') === E.R && !p.pieceAt('h1'));
  p.unmake();
  assert.ok(p.pieceAt('e1') === E.K && p.pieceAt('h1') === E.R);
});
test('en passant: only right after the double step; capture removes the pawn', function () {
  var p = play(null, ['e4', 'a6', 'e5', 'd5']);
  var m = E.fromSAN(p, 'exd6');
  assert.ok(m && (E.mFlags(m) & E.F_EP));
  p.make(m);
  assert.strictEqual(p.pieceAt('d5'), 0); assert.strictEqual(p.pieceAt('d6'), E.P);
  var q = play(null, ['e4', 'a6', 'e5', 'd5', 'Nf3', 'Nf6']);
  assert.ok(!E.fromSAN(q, 'exd6'), 'en passant must be immediate');
  // a pinned en passant capture is illegal
  assert.ok(!E.fromUCI(E.fromFEN('8/8/8/K2pP2r/8/8/8/7k w - d6 0 1'), 'e5d6'));
});
test('promotion: all four pieces, SAN with =Q, capture-promotion', function () {
  var p = E.fromFEN('1n5k/P7/8/8/8/8/8/K7 w - - 0 1');
  var ms = p.legalMoves().filter(function (m) { return E.mFrom(m) === E.sqParse('a7'); });
  assert.strictEqual(ms.length, 8);
  assert.strictEqual(E.toSAN(p, E.fromUCI(p, 'a7a8q')), 'a8=Q');
  assert.strictEqual(E.toSAN(p, E.fromUCI(p, 'a7b8n')), 'axb8=N');
  var m = E.fromSAN(p, 'axb8=R'); p.make(m);
  assert.strictEqual(p.pieceAt('b8'), E.R); p.unmake();
  assert.strictEqual(p.pieceAt('a7'), E.P); assert.strictEqual(p.pieceAt('b8'), E.N | E.BLACK);
  assert.ok(E.fromSAN(p, 'a8Q'), 'lenient SAN without =');
});
test('SAN: disambiguation, checks and mates', function () {
  var p = E.fromFEN('4k3/8/8/8/8/4K3/8/R6R w - - 0 1');
  assert.strictEqual(E.toSAN(p, E.fromUCI(p, 'a1d1')), 'Rad1');
  assert.strictEqual(E.toSAN(p, E.fromUCI(p, 'h1f1')), 'Rhf1');
  assert.strictEqual(E.toSAN(p, E.fromUCI(p, 'a1a8')), 'Ra8+');
  var c = E.fromFEN('4k3/8/8/8/8/8/8/R3K2R w K - 0 1');
  assert.strictEqual(E.toSAN(c, E.fromUCI(c, 'e1g1')), 'O-O');
  var q = E.fromFEN('7k/8/8/N7/8/8/8/N3K3 w - - 0 1');
  assert.strictEqual(E.toSAN(q, E.fromUCI(q, 'a1b3')), 'N1b3');
  var r = play(null, ['f3', 'e5', 'g4']);
  assert.strictEqual(E.toSAN(r, E.fromSAN(r, 'Qh4')), 'Qh4#');
  var s = E.fromFEN('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
  assert.strictEqual(E.toSAN(s, E.fromUCI(s, 'a1a8')), 'Ra8+');
});
test('game status: mate, stalemate, insufficient material, fifty moves, threefold', function () {
  assert.strictEqual(E.status(play(null, ['f3', 'e5', 'g4', 'Qh4'])).reason, 'checkmate');
  assert.strictEqual(E.status(play(null, ['f3', 'e5', 'g4', 'Qh4'])).result, '0-1');
  assert.strictEqual(E.status(E.fromFEN('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')).reason, 'stalemate');
  ['8/8/4k3/8/8/4K3/8/8 w - - 0 1', '8/8/4k3/8/8/4KN2/8/8 w - - 0 1', '8/8/4k1b1/8/8/4KB2/8/8 w - - 0 1'].forEach(function (f) {
    assert.strictEqual(E.status(E.fromFEN(f)).reason, 'insufficient material', f);
  });
  assert.ok(!E.status(E.fromFEN('8/8/4kb2/8/8/4KB2/8/8 w - - 0 1')).over, 'opposite-coloured bishops can still mate');
  assert.ok(!E.status(E.fromFEN('8/8/4k3/8/8/4KP2/8/8 w - - 0 1')).over);
  assert.strictEqual(E.status(E.fromFEN('8/8/4k3/8/8/4KR2/8/8 w - - 100 80')).reason, 'fifty-move rule');
  var p = play(null, ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1']);
  assert.ok(!E.status(p).over);
  p.make(E.fromSAN(p, 'Ng8'));
  assert.strictEqual(E.status(p).reason, 'threefold repetition');
});
test('PGN: tags, move numbers, result, SetUp/FEN for a custom start', function () {
  var r = E.replay(E.START_FEN, ['e2e4', 'e7e5', 'g1f3']);
  var t = E.pgn({ white: 'A', black: 'B', result: '*', date: '2026.10.31', sans: r.sans });
  assert.ok(/\[White "A"\]/.test(t) && /1\. e4 e5 2\. Nf3 \*/.test(t) && !/FEN/.test(t));
  var f = '4k3/8/8/8/8/8/8/R3K3 b - - 0 7', r2 = E.replay(f, ['e8d7', 'a1a7']);
  var t2 = E.pgn({ fen: f, sans: r2.sans, result: '*' });
  assert.ok(/\[SetUp "1"\]/.test(t2) && /7\.\.\. Kd7 8\. Ra7\+/.test(t2));
  assert.strictEqual(E.replay(E.START_FEN, ['e2e5']), null);
});
test('search: finds mate in one, mate in two, and wins a hanging queen', function () {
  var p = E.fromFEN('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
  var r = E.search(p, { depth: 4 });
  assert.strictEqual(E.toUCI(r.move), 'd1d8'); assert.strictEqual(r.mate, 1);
  var q = E.fromFEN('r1b1k2r/ppp2ppp/2n5/2bqp3/8/2NP1N2/PPPQBPPP/R3K2R b KQkq - 0 1');
  var hq = E.search(q, { depth: 5 });
  assert.ok(hq.move, 'a move');
  var z = E.fromFEN('k7/8/8/3q4/8/8/8/3RK3 w - - 0 1');
  assert.strictEqual(E.toUCI(E.search(z, { depth: 3 }).move), 'd1d5');
  var m2 = E.fromFEN('2r3k1/5ppp/8/8/8/8/3R1PPP/3R2K1 w - - 0 1');   // Rd8+ Rxd8 Rxd8#
  var s2 = E.search(m2, { depth: 6 });
  assert.strictEqual(s2.mate, 2);
});
test('search respects its time budget and node limit; is deterministic with a node limit', function () {
  var p = E.fromFEN(KIWI), t0 = Date.now();
  E.search(p, { time: 300 });
  assert.ok(Date.now() - t0 < 900, 'took ' + (Date.now() - t0) + ' ms');
  E.clearTT(); var a = E.search(E.fromFEN(KIWI), { nodes: 20000 });
  E.clearTT(); var b = E.search(E.fromFEN(KIWI), { nodes: 20000 });
  assert.strictEqual(a.move, b.move); assert.strictEqual(a.score, b.score);
});
test('every level plays only legal moves, a whole game to the end', function () {
  var rand = E.rng(77);
  for (var g = 0; g < 3; g++) {
    var p = E.fromFEN(E.START_FEN), lv = [1, 2, 3][g], over = false;
    for (var ply = 0; ply < 400 && !over; ply++) {
      var o = E.levelOpts(ply % 2 ? lv : 1, 0); o.rand = rand; if (o.time) o.time = 0; o.nodes = 3000;
      var r = E.search(p, o), legal = p.legalMoves();
      assert.ok(r && legal.indexOf(r.move) >= 0, 'illegal CPU move');
      p.make(r.move);
      over = E.status(p).over;
    }
  }
});
test('worker protocol: handle() replays the game and answers in UCI', function () {
  var r = E.handle({ id: 3, fen: E.START_FEN, moves: ['f2f3', 'e7e5', 'g2g4'], opts: { level: 4, timeCap: 300 } });
  assert.strictEqual(r.id, 3); assert.strictEqual(r.uci, 'd8h4'); assert.strictEqual(r.mate, 1);
  assert.ok(E.handle({ id: 4, fen: E.START_FEN, moves: ['e2e5'] }).error);
  assert.strictEqual(E.handle({ id: 5, fen: E.START_FEN, moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'] }).uci, null);
});
test('mate solver: exact distance, unique first move, longest defence', function () {
  var p = E.fromFEN('2r3k1/5ppp/8/8/8/8/3R1PPP/3R2K1 w - - 0 1');
  assert.strictEqual(E.mateDistance(p, 3), 2);
  var v = E.verifyPuzzle('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 1);
  assert.ok(v.ok && v.uci === 'a1a8');
  assert.ok(!E.verifyPuzzle('6k1/5ppp/8/8/8/8/8/RR4K1 w - - 0 1', 1).ok, 'two mating moves is not unique');
  assert.ok(!E.verifyPuzzle(E.START_FEN, 2).ok);
  var line = E.solutionLine('2r3k1/5ppp/8/8/8/8/3R1PPP/3R2K1 w - - 0 1', 2);
  assert.strictEqual(line.length, 3);
  var q = E.replay('2r3k1/5ppp/8/8/8/8/3R1PPP/3R2K1 w - - 0 1', line).pos;
  assert.strictEqual(E.status(q).reason, 'checkmate');
});
test('material and captured pieces', function () {
  var p = play(null, ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qxg2']);
  var m = E.material(p);
  assert.strictEqual(m.diff, -1);
  assert.deepStrictEqual(m.captured[0], [1, 1]); assert.deepStrictEqual(m.captured[1], [1]);
  var base = E.fromFEN('6k1/P7/8/8/8/8/5PPP/6K1 w - - 0 1'), q = E.replay(base.fen(), ['a7a8q']).pos;
  var m2 = E.material(q, base);
  assert.deepStrictEqual(m2.captured, [[], []], 'a promotion is not a capture'); assert.strictEqual(m2.diff, 12);
});
test('helpers: saved game normalisation keeps the legal prefix and sane fields', function () {
  assert.strictEqual(H.normGame(null, E), null);
  var g = H.normGame({ mode: 'weird', level: 99, human: 7, tc: 'zzz', moves: ['e2e4', 'e7e5', 'e1e3', 'g1f3'], clocks: [-5, 'x'], result: { result: 'lol' } }, E);
  assert.strictEqual(g.mode, 'cpu'); assert.strictEqual(g.level, 6); assert.strictEqual(g.human, 0); assert.strictEqual(g.tc, 'none');
  assert.deepStrictEqual(g.moves, ['e2e4', 'e7e5']); assert.deepStrictEqual(g.clocks, [0, 0]); assert.strictEqual(g.result, null);
  var g2 = H.normGame({ mode: '2p', autoFlip: false, tc: '3+2', moves: ['d2d4'], result: { result: '1-0', reason: 'checkmate' }, startFen: 'bad fen' }, E);
  assert.strictEqual(g2, null, 'a broken start FEN drops the save');
  var g3 = H.normGame({ mode: '2p', autoFlip: false, tc: '3+2', moves: ['d2d4'], result: { result: '1-0', reason: 'time' } }, E);
  assert.ok(g3.mode === '2p' && g3.autoFlip === false && g3.clocks[0] === 180000 && g3.result.result === '1-0');
});
test('helpers: stats, prefs, outcomes', function () {
  var s = H.normStats({ levels: { 3: { w: 2, d: 'x', l: -4 } }, p2: { w: 1 }, recent: [{ r: '1-0', out: 'q' }, 5] });
  assert.deepStrictEqual(s.levels[3], { w: 2, d: 0, l: 0 }); assert.strictEqual(s.recent.length, 1); assert.strictEqual(s.recent[0].out, 'd');
  var g = H.newGame({ mode: 'cpu', level: 2, human: 1 });
  assert.strictEqual(H.recordResult(s, g, { result: '0-1', reason: 'checkmate' }), 'w');
  assert.strictEqual(s.levels[2].w, 1);
  assert.strictEqual(H.recordResult(s, H.newGame({ mode: '2p' }), { result: '1/2-1/2', reason: 'stalemate' }), 'd');
  assert.strictEqual(s.p2.d, 1);
  var pr = H.normPrefs({ style: 'letter', lastLevel: 0, lastTc: '10+5', lastColor: 'x' });
  assert.ok(pr.style === 'letter' && pr.lastLevel === 1 && pr.lastTc === '10+5' && pr.lastColor === 'w');
});
test('helpers: clocks, flag falls, draw offers', function () {
  assert.strictEqual(H.fmtClock(300000), '5:00'); assert.strictEqual(H.fmtClock(65400), '1:06'); assert.strictEqual(H.fmtClock(9450), '9.4'); assert.strictEqual(H.fmtClock(-3), '0.0');
  assert.strictEqual(H.fmtClock(3723000), '1:02:03');
  var p = E.fromFEN('8/8/4k3/8/8/4K3/8/7R w - - 0 1');
  assert.deepStrictEqual(H.flagResult(p, 1, E), { result: '1-0', reason: 'time' });
  assert.strictEqual(H.flagResult(p, 0, E).result, '1/2-1/2', 'a bare king can\'t win on time');
  assert.ok(H.cpuTimeCap(60000, 0) <= 2200 && H.cpuTimeCap(60000, 0) > 1000);
  assert.ok(H.cpuTimeCap(1000, 0) <= 500);
  assert.ok(H.acceptsDraw(-120, 10) && !H.acceptsDraw(0, 10) && H.acceptsDraw(10, 80));
});

// ---- reviewer additions ----
test('perft: mirrored position 4 and position 3 at depth 4', function () {
  assert.strictEqual(E.perft(E.fromFEN('r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1'), 3), 9467);
  assert.strictEqual(E.perft(E.fromFEN('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1'), 4), 43238);
});
test('repetition ignores an en passant square nobody can use', function () {
  // after 1.e4 the e3 square cannot be taken: the same placement later is the same position
  var p = play(null, ['e4', 'Nf6', 'Nf3', 'Ng8', 'Ng1', 'Nf6', 'Nf3', 'Ng8']);
  assert.ok(!E.status(p).over);
  p.make(E.fromSAN(p, 'Ng1'));
  assert.strictEqual(E.status(p).reason, 'threefold repetition');
  // but a usable en passant square makes it a different position
  var q = E.fromFEN('4k3/8/8/8/3p4/8/4P3/4K3 w - - 0 1');
  q.make(E.fromSAN(q, 'e4'));
  var r = E.fromFEN('4k3/8/8/8/3pP3/8/8/4K3 b - - 0 1');
  assert.ok(q.lo !== r.lo || q.hi !== r.hi, 'a capturable ep square must change the hash');
});
test('SAN round trip: every legal move, through random games, parses back to itself', function () {
  var rnd = E.rng(7), n = 0;
  for (var g = 0; g < 12; g++) {
    var p = E.fromFEN(g % 2 ? KIWI : E.START_FEN);
    for (var ply = 0; ply < 80; ply++) {
      var ms = p.legalMoves();
      if (!ms.length) break;
      ms.forEach(function (m) {
        var san = E.toSAN(p, m);
        assert.strictEqual(E.fromSAN(p, san), m, san + ' in ' + p.fen());
        assert.strictEqual(E.fromUCI(p, E.toUCI(m)), m);
        n++;
      });
      p.make(ms[Math.floor(rnd() * ms.length)]);
      if (E.status(p).over) break;
    }
  }
  assert.ok(n > 5000, n + ' moves checked');
});
test('fifty-move rule: a mate on the hundredth half-move still counts as mate', function () {
  var p = E.fromFEN('7k/8/6K1/8/8/8/8/R7 w - - 99 80');
  p.make(E.fromSAN(p, 'Ra8'));
  assert.strictEqual(E.status(p).reason, 'checkmate');
  var q = E.fromFEN('7k/8/6K1/8/8/8/8/R7 w - - 99 80');
  q.make(E.fromSAN(q, 'Ra2'));
  assert.strictEqual(E.status(q).reason, 'fifty-move rule');
});
test('the computer at every level answers legally from tricky positions (checks, promotions, few moves)', function () {
  var fens = ['4k3/1P6/8/8/8/8/8/4K3 w - - 0 1', 'r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1', '6k1/5ppp/8/8/8/8/5PPP/3r2K1 w - - 0 1', '8/8/8/8/8/2k5/1q6/K7 w - - 0 1'];
  fens.forEach(function (f) {
    for (var lv = 1; lv <= 6; lv++) {
      var st = E.status(E.fromFEN(f)), r = E.handle({ id: 1, fen: f, moves: [], opts: { level: lv, timeCap: 120 } });
      if (st.over) { assert.strictEqual(r.uci, null, f); continue; }
      assert.ok(r.uci && E.fromUCI(E.fromFEN(f), r.uci), 'level ' + lv + ' ' + f + ' -> ' + r.uci);
    }
  });
  // promotion with a choice: the strong levels promote to a queen
  var r6 = E.handle({ id: 2, fen: '4k3/1P6/8/8/8/8/8/4K3 w - - 0 1', moves: [], opts: { level: 4, timeCap: 200 } });
  assert.strictEqual(r6.uci, 'b7b8q');
});
test('saved game: clock history is trimmed to the moves and clocks stay sane', function () {
  var g = H.normGame({ mode: 'cpu', level: 9, human: 1, tc: '3+2', moves: ['e2e4', 'e7e5', 'zz'], clocks: [-5, 'x'], clockHist: [[1, 2], [3, 4], [5, 6], [7, 8], 'bad'] }, E);
  assert.strictEqual(g.level, 6);
  assert.deepStrictEqual(g.moves, ['e2e4', 'e7e5']);
  assert.deepStrictEqual(g.clocks, [0, 0]);
  assert.ok(g.clockHist.length <= 3);
  assert.strictEqual(g.counted, false);
  assert.strictEqual(H.normGame({ moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'], result: { result: '0-1', reason: 'checkmate' } }, E).counted, true, 'a finished game is already in the stats');
  assert.strictEqual(H.normGame('nope', E), null);
  assert.strictEqual(H.normGame({ startFen: 'garbage' }, E), null);
});

console.log(passed + ' passed');
