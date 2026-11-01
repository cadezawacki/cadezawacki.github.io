/* Headless checks for the Morse Trainer engine (code table, timing, decoders, stats, arcade, save).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/morse/morse.test.js */
'use strict';
var assert = require('assert');

var E = require('./morse.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./morse.js')];
require('./morse.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function near(a, b, eps, msg) { assert.ok(Math.abs(a - b) <= (eps || 1e-9), (msg || '') + ' ' + a + ' vs ' + b); }

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Morse Trainer' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'morse.css');
  assert.strictEqual(widget._engine.KOCH.length, E.KOCH.length);
});
test('code table: complete, unique, round-trips', function () {
  var seen = {};
  E.ALPHA.forEach(function (c) { assert.ok(E.CODE[c], c); });
  for (var d = 0; d <= 9; d++) assert.strictEqual(E.CODE[d].length, 5);
  Object.keys(E.CODE).forEach(function (c) {
    var code = E.CODE[c];
    assert.ok(/^[.-]+$/.test(code), c);
    assert.ok(!seen[code], 'duplicate code ' + code);
    seen[code] = 1;
    assert.strictEqual(E.charOf(code), c);
  });
  assert.strictEqual(E.encode('sos'), '... --- ...');
  assert.strictEqual(E.encode('hi there'), '.... .. / - .... . .-. .');
  assert.strictEqual(E.charOf('........'), '');
});
test('koch order covers every character once', function () {
  assert.strictEqual(E.KOCH.length, Object.keys(E.CODE).length);
  assert.strictEqual(new Set(E.KOCH).size, E.KOCH.length);
  assert.deepStrictEqual(E.lessonSet(0), ['K', 'M']);
  assert.strictEqual(E.lessonSet(5).join(''), 'KMURE');
  assert.strictEqual(E.lessonSet(999).length, E.KOCH.length);
});
test('timing: PARIS is 50 units; Farnsworth stretches only the gaps', function () {
  var tm = E.timing(20, 20);
  near(tm.dot, 0.06);
  var sch = E.schedule('PARIS', tm);
  near(sch.dur + tm.wg, 50 * tm.dot, 1e-9, 'PARIS + word gap');
  var fw = E.timing(20, 10);
  near(fw.dot, 0.06); near(fw.dash, 0.18);
  assert.ok(fw.cg > tm.cg && fw.wg > tm.wg);
  var sf = E.schedule('PARIS', fw);
  // one PARIS word incl. its word gap lasts 60/eff seconds
  near(sf.dur + fw.wg, 60 / 10, 1e-9, 'Farnsworth word time');
  assert.strictEqual(sf.tones.length, sch.tones.length);
  var t2 = E.timing(3, 99);
  assert.ok(t2.wpm === 5 && t2.eff === 5);
});
test('schedule: tones, marks, word gaps', function () {
  var tm = E.timing(20, 20), s = E.schedule('E T', tm);
  assert.strictEqual(s.tones.length, 2);
  near(s.tones[1].t, tm.dot + tm.wg);
  assert.deepStrictEqual(s.marks.map(function (m) { return m.ch; }), ['E', 'T']);
  assert.ok(E.toneAt(s, 0.01) && !E.toneAt(s, tm.dot + 0.01) && E.toneAt(s, s.tones[1].t + 0.01));
  assert.strictEqual(E.schedule('~~', tm).tones.length, 0);
});
// key a string through the straight-key decoder with a given fist
function keyStraight(d, text, dotMs, jitter, r) {
  var t = 1000, out = '';
  text.split('').forEach(function (ch, ci) {
    var code = E.CODE[ch];
    for (var i = 0; i < code.length; i++) {
      var len = (code.charAt(i) === '.' ? dotMs : dotMs * 3) * (1 + (r() - 0.5) * jitter);
      E.decDown(d, t); t += len; E.decUp(d, t);
      t += dotMs * (1 + (r() - 0.5) * jitter);
    }
    var res = null;
    for (var k = 0; k < 400 && !res; k++) { t += 5; res = E.decTick(d, t); }
    if (res) out += res.ch || '#';
  });
  return out;
}
test('straight key decoder: reads an even fist and adapts to speed', function () {
  var r = E.rng(5);
  var d = E.newDecoder(15);
  assert.strictEqual(keyStraight(d, 'KMURESNAPTLW', 80, 0.3, r), 'KMURESNAPTLW');
  // a much slower fist than the setting: adapts within a few characters
  var d2 = E.newDecoder(20), got = keyStraight(d2, 'EEEETTTTPARISQUICK', 200, 0.25, r);
  assert.strictEqual(got.slice(-5), 'QUICK');
  assert.ok(Math.abs(E.decWpm(d2) - 6) <= 2, 'measured wpm ' + E.decWpm(d2));
  // no completion while held or during an intra-character gap
  var d3 = E.newDecoder(15);
  E.decDown(d3, 0); E.decUp(d3, 80);
  assert.strictEqual(E.decTick(d3, 150), null);
  E.decDown(d3, 160);
  assert.strictEqual(E.decTick(d3, 2000), null);
  E.decUp(d3, 400);
  var res = E.decTick(d3, 2000);
  assert.ok(res && res.code === '.-' && res.ch === 'A');
});
// run the iambic keyer with scripted paddles at 1 ms resolution
function runKeyer(k, script, endT) {
  var els = '', chars = [], si = 0, prevEnd = -1e9, overlap = false;
  for (var t = 0; t <= endT; t++) {
    while (si < script.length && script[si][0] <= t) { E.keyPaddle(k, script[si][1], script[si][2], t); si++; }
    var o = E.keyStep(k, t);
    o.els.forEach(function (e) { if (e.t0 < prevEnd + k.dot - 1e-6) overlap = true; prevEnd = e.t0 + e.d; els += e.el; });
    if (o.done) chars.push(o.done.ch || '#');
  }
  return { els: els, chars: chars.join(''), overlap: overlap };
}
test('iambic keyer: held paddles repeat, squeeze alternates, memory latches, spacing exact', function () {
  var k = E.newKeyer(20);   // dot 60 ms
  var a = runKeyer(k, [[0, 'dit', true], [290, 'dit', false]], 1000);
  assert.strictEqual(a.els, '...');   // 0, 120, 240 start; released at 290 mid third
  assert.strictEqual(a.chars, 'S');
  assert.ok(!a.overlap);
  var k2 = E.newKeyer(20), b = runKeyer(k2, [[0, 'dah', true], [10, 'dit', true], [400, 'dah', false], [400, 'dit', false]], 1200);
  assert.strictEqual(b.els.slice(0, 4), '-.-.');
  assert.strictEqual(b.chars, 'C');
  // a dit tapped during a dah is remembered (memory) → N then nothing else
  var k3 = E.newKeyer(20), c = runKeyer(k3, [[0, 'dah', true], [30, 'dah', false], [50, 'dit', true], [70, 'dit', false]], 1000);
  assert.strictEqual(c.chars, 'N');
  assert.ok(!c.overlap);
});
test('stats: record, weights favour weak characters, weakest list', function () {
  var st = {};
  for (var i = 0; i < 20; i++) { E.record(st, 'K', true); E.record(st, 'm', i % 2 === 0); }
  assert.ok(st.M && st.M.n === 20 && st.M.ok === 10);
  assert.ok(E.weight(st, 'M') > E.weight(st, 'K'));
  assert.ok(E.weight(st, 'Q') > E.weight(st, 'K'), 'unseen characters come up often');
  assert.strictEqual(E.record(st, '~', true), null);
  var r = E.rng(1), n = { K: 0, M: 0 };
  for (i = 0; i < 4000; i++) n[E.pick(['K', 'M'], st, r)]++;
  assert.ok(n.M > n.K * 1.5, JSON.stringify(n));
  assert.deepStrictEqual(E.weakest(st, ['K', 'M']), ['M']);
  var g = E.makeGroup(['K', 'M', 'U'], st, 5, E.rng(3));
  assert.ok(/^[KMU]{5}$/.test(g));
});
test('grade and lesson progression', function () {
  var g = E.grade('KMURE', 'kmxre');
  assert.ok(g.ok === 4 && g.n === 5 && !g.exact && g.res[2].got === 'X');
  assert.ok(E.grade('CQ', 'CQ').exact);
  assert.ok(E.lessonPassed(23, 25) && !E.lessonPassed(22, 25) && !E.lessonPassed(9, 9));
  var s = E.newSave(), out = E.settleLesson(s, 25, 25);
  assert.ok(out.passed && out.newChar === 'U' && s.lesson === 3 && s.maxLesson === 3);
  out = E.settleLesson(s, 5, 25);
  assert.ok(!out.passed && s.lesson === 3 && s.rec.copyAcc === 100);
  s.lesson = E.KOCH.length;
  out = E.settleLesson(s, 25, 25);
  assert.ok(out.passed && !out.newChar && s.lesson === E.KOCH.length);
});
test('drills: callsigns look like callsigns, words are encodable', function () {
  var r = E.rng(9);
  for (var i = 0; i < 300; i++) {
    var c = E.callsign(r);
    assert.ok(/^[A-Z]{1,2}[0-9][A-Z]{1,3}(\/P)?$/.test(c), c);
    assert.ok(E.encode(c).length > 0);
  }
  E.WORDS.concat(E.ABBR).forEach(function (w) { w.split('').forEach(function (ch) { assert.ok(E.CODE[ch], w); }); });
  ['words', 'calls', 'abbr', 'mix'].forEach(function (k) { assert.ok(E.drillItem(k, r).length > 0); });
});
test('arcade: spawns, falls at a steady rate, lands cost lives, deterministic', function () {
  var a = E.newArcade(42, { pool: ['K', 'M'], stats: {} });
  assert.ok(a.pool.length >= 4, 'tiny lesson sets are padded');
  var spawned = 0;
  for (var i = 0; i < 120 * 30 && a.phase === 'run'; i++) {
    E.arcStep(a);
    a.events.forEach(function (e) { if (e.k === 'spawn') spawned++; });
    a.events.length = 0;
    a.items.forEach(function (it) { assert.ok(it.y >= it.py && it.y < 1); });
  }
  assert.ok(spawned >= 8, 'spawned ' + spawned);
  assert.ok(a.lives < E.LIVES, 'ignored codes land');
  // the same seed replays identically; frame rate does not matter
  function play(dtFrame) {
    var b = E.newArcade(7, { pool: E.lessonSet(8), stats: {} }), t = 0, log = [];
    while (t < 40 && b.phase === 'run') {
      E.arcAdvance(b, dtFrame); t += dtFrame;
      b.events.forEach(function (e) { if (e.k === 'spawn') log.push(e.it.ch + e.it.col); });
      b.events.length = 0;
      if (b.items.length && b.items[0].y > 0.5) E.arcType(b, b.items[0].ch);
    }
    return log.slice(0, 12).join(',') + '|' + b.steps;
  }
  var p60 = play(1 / 60), p120 = play(1 / 120);
  assert.strictEqual(p60.split('|')[0], p120.split('|')[0]);
});
test('arcade: typing clears the lowest match, combo, levels, scoring, game over', function () {
  var a = E.newArcade(3, { pool: E.lessonSet(6), stats: {} });
  a.items = [{ id: 1, ch: 'K', code: '-.-', col: 0, y: 0.2, py: 0.2, v: 0.1 }, { id: 2, ch: 'K', code: '-.-', col: 1, y: 0.6, py: 0.6, v: 0.1 }];
  var hit = E.arcType(a, 'k');
  assert.ok(hit && hit.id === 2 && a.items.length === 1 && a.combo === 1 && a.score === 10 + 6);
  assert.strictEqual(E.arcType(a, 'Z'), null);
  assert.strictEqual(a.combo, 0);
  for (var i = 0; i < 8; i++) { a.items.push({ id: 10 + i, ch: 'M', code: '--', col: 0, y: 0.5, py: 0.5, v: 0.1 }); E.arcType(a, 'M'); }
  assert.ok(a.lv === 2 && a.pool.length === 7, 'level up adds a character');
  assert.ok(a.stats.M.n === 8 && a.stats.M.ok === 8);
  var ears = E.newArcade(3, { pool: ['K', 'M', 'U', 'R'], ears: true });
  ears.items = [{ id: 1, ch: 'R', code: '.-.', col: 0, y: 0, py: 0, v: 0.1 }];
  E.arcType(ears, 'R');
  assert.strictEqual(ears.score, 50, 'ears-only scores double');
  var b = E.newArcade(1, { pool: ['K', 'M', 'U', 'R'] });
  b.items = [0, 1, 2].map(function (j) { return { id: j, ch: 'K', code: '-.-', col: j, y: 0.999, py: 0.999, v: 1 }; });
  b.spawnT = 99;
  E.arcStep(b);
  assert.ok(b.phase === 'done' && b.lives === 0);
  assert.strictEqual(E.arcType(b, 'K'), null);
  var s = E.newSave(); b.score = 120; b.bestCombo = 4;
  assert.ok(E.settleArcade(s, b).best && s.rec.arcade === 120 && !E.settleArcade(s, b).best);
});
test('save: normalises junk defensively and round-trips', function () {
  var s = E.newSave();
  E.record(s.stats, 'K', true); s.lesson = 7; s.maxLesson = 9; s.set.keyer = 'iambic'; s.seen = ['K', 'M'];
  assert.deepStrictEqual(E.normSave(JSON.parse(JSON.stringify(s))), s);
  var bad = E.normSave({ lesson: 'x', maxLesson: -3, stats: { K: { n: 5, ok: 99, ema: 7 }, '~': { n: 1 }, M: null, __proto__: { n: 3 } },
    set: { wpm: 999, eff: 500, pitch: -1, keyer: 'bug', group: 0, len: 'a', pool: 'x', drill: 'nope', hint: 0 }, rec: { arcade: -9 }, seen: ['K', 'K', 3, '~'] });
  assert.ok(bad.lesson === 2 && bad.maxLesson === 2);
  assert.deepStrictEqual(bad.stats, { K: { n: 5, ok: 5, ema: 1 } });
  assert.ok(bad.set.wpm === 45 && bad.set.eff === 45 && bad.set.pitch === 300 && bad.set.keyer === 'straight' && bad.set.group === 1 && bad.set.len === 25);
  assert.ok(bad.set.pool === 'lesson' && bad.set.drill === 'mix' && bad.set.hint === false && bad.rec.arcade === 0);
  assert.deepStrictEqual(bad.seen, ['K']);
  assert.deepStrictEqual(E.normSave(null), E.newSave());
  assert.deepStrictEqual(E.normSave('junk'), E.newSave());
});

test('arcade: spawns are paced so their beeps never pile up (slow wpm too)', function () {
  near(E.codeDur('.', 0.1), 0.4, 1e-9);            // 1 unit + 3 unit gap
  near(E.codeDur('-.-', 0.06), (3 + 1 + 1 + 1 + 3 + 3) * 0.06, 1e-9);
  [5, 12, 30].forEach(function (wpm) {
    var dot = 1.2 / wpm, a = E.newArcade(99, { pool: E.KOCH.slice(0, 20), dot: dot }), last = null;
    a.lives = 1e6;   // never ends: just watch spawn times
    for (var i = 0; i < 120 * 240; i++) {
      E.arcStep(a);
      for (var j = 0; j < a.events.length; j++) {
        var ev = a.events[j];
        if (ev.k !== 'spawn') continue;
        if (last) assert.ok(a.t - last.t >= E.codeDur(last.code, dot) - 1e-6, wpm + ' wpm: spawn too soon after ' + last.code);
        last = { t: a.t, code: ev.it.code };
      }
      a.events.length = 0;
    }
  });
  // with no dot the old pacing applies and play stays deterministic
  var x = E.newArcade(5, { pool: ['K', 'M', 'U', 'R'] }), y = E.newArcade(5, { pool: ['K', 'M', 'U', 'R'] });
  for (var k = 0; k < 2000; k++) { E.arcStep(x); E.arcStep(y); }
  assert.deepStrictEqual(x.items.map(function (i) { return i.ch + i.y; }), y.items.map(function (i) { return i.ch + i.y; }));
});
test('arcade pool grows by one new character a level, never repeats', function () {
  for (var lv = 1; lv < 60; lv++) {
    var p = E.arcadePool(['K', 'M'], lv);
    assert.strictEqual(new Set(p).size, p.length);
    assert.strictEqual(p.length, Math.min(E.KOCH.length, 4 + lv - 1));
  }
  var q = E.arcadePool(E.KOCH.slice(0, 10), 3);
  assert.strictEqual(q.length, 12);
  assert.deepStrictEqual(q.slice(0, 10), E.KOCH.slice(0, 10));
});
test('lesson settle: caps at the last lesson, needs 10 characters', function () {
  var s = E.newSave();
  assert.strictEqual(E.settleLesson(s, 9, 9).passed, false);   // too short
  assert.strictEqual(s.lesson, 2);
  var o = E.settleLesson(s, 9, 10);
  assert.ok(o.passed && o.newChar === E.KOCH[2] && s.lesson === 3);
  s.lesson = E.KOCH.length;
  o = E.settleLesson(s, 25, 25);
  assert.ok(o.passed && !o.newChar && s.lesson === E.KOCH.length);
  assert.strictEqual(E.grade('ABC', 'A').ok, 1);
  assert.strictEqual(E.grade('ABC', 'abcd').exact, false);
});
test('straight key decoder: long holds are dashes, a pause ends the character, junk decodes to nothing', function () {
  var d = E.newDecoder(15), t = 0, dot = 80;
  function key(len, gap) { E.decDown(d, t); t += len; E.decUp(d, t); t += gap; }
  key(dot * 9, dot);                       // a very long hold: still one dash
  assert.strictEqual(d.sym, '-');
  assert.strictEqual(E.decTick(d, t), null);
  var r = E.decTick(d, t + E.decGap(d) + 1);
  assert.deepStrictEqual(r, { code: '-', ch: 'T' });
  for (var i = 0; i < 8; i++) key(dot, dot);   // eight dits: not a character, kept to 7 elements
  r = E.decTick(d, t + E.decGap(d) + 1);
  assert.ok(r && r.ch === '' && r.code.length === 7);
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
