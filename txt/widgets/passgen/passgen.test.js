/* Unit tests for the Password Generator's pure core (RNG, generators, entropy,
 * strength, checker). Not loaded by the app (not in the manifest).
 * Run: node txt/widgets/passgen/passgen.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var C = require('./passgen.js');
var WORDS = require('./passgen-words.js');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function near(a, b, eps, msg) { assert.ok(Math.abs(a - b) <= (eps || 1e-9), (msg || '') + ' expected ' + b + ', got ' + a); }
function log2(x) { return Math.log(x) / Math.LN2; }
var rng = C.makeRng(); // real crypto.getRandomValues (node's webcrypto)

// a deterministic word source for the RNG
function fakeSource(values) {
  var i = 0;
  return function (arr) { for (var k = 0; k < arr.length; k++) arr[k] = i < values.length ? values[i++] : 0; };
}

// ---- source hygiene ------------------------------------------------------------------
test('no Math.random anywhere in the module', function () {
  var src = fs.readFileSync(path.join(__dirname, 'passgen.js'), 'utf8');
  assert.ok(!/Math\.random\s*\(/.test(src));
  assert.ok(/getRandomValues/.test(src));
});

// ---- unbiased random ints --------------------------------------------------------------
test('rng: range edges and validation', function () {
  assert.strictEqual(rng.int(1), 0);
  for (var i = 0; i < 1000; i++) { var x = rng.int(7); assert.ok(x >= 0 && x < 7 && x === Math.floor(x)); }
  var big = rng.int(4294967296); assert.ok(big >= 0 && big < 4294967296);
  assert.throws(function () { rng.int(0); }, RangeError);
  assert.throws(function () { rng.int(2.5); }, RangeError);
  assert.throws(function () { rng.int(4294967297); }, RangeError);
});
test('rng: rejection sampling drops the biased tail (no modulo bias)', function () {
  // n = 3: 2^32 mod 3 = 1, so the single top value 0xFFFFFFFF must be rejected
  var r = C.makeRng(fakeSource([0xFFFFFFFF, 5]));
  assert.strictEqual(r.int(3), 5 % 3);
  // n = 10: limit = 2^32 - 6; values >= limit are rejected
  var lim = 4294967296 - 4294967296 % 10;
  r = C.makeRng(fakeSource([lim, lim + 5, lim - 1]));
  assert.strictEqual(r.int(10), (lim - 1) % 10);
  // power of two: never rejects
  r = C.makeRng(fakeSource([0xFFFFFFFF]));
  assert.strictEqual(r.int(16), 15);
});
test('rng: uniformity sanity (chi-square) for several ranges', function () {
  [2, 6, 7, 10, 26, 95].forEach(function (n) {
    var N = 60000 * Math.max(1, Math.round(n / 10)), counts = new Array(n).fill(0);
    for (var i = 0; i < N; i++) counts[rng.int(n)]++;
    var exp = N / n, chi = 0;
    counts.forEach(function (c) { chi += (c - exp) * (c - exp) / exp; });
    // df = n-1; mean df, sd sqrt(2df): allow a generous 6 sd (false alarm ~1e-9)
    var df = n - 1, lim = df + 6 * Math.sqrt(2 * df) + 10;
    assert.ok(chi < lim, 'chi-square ' + chi.toFixed(1) + ' for n=' + n + ' (limit ' + lim.toFixed(1) + ')');
    counts.forEach(function (c) { assert.ok(c > 0); });
  });
});
test('rng: wipe zeroes the buffer and consumed words', function () {
  var seen = [];
  var r = C.makeRng(function (a) { for (var i = 0; i < a.length; i++) a[i] = i + 1; seen = a; });
  r.int(1000);
  assert.strictEqual(seen[0], 0, 'consumed word zeroed');
  r.wipe();
  for (var i = 0; i < seen.length; i++) assert.strictEqual(seen[i], 0);
});

// ---- entropy -----------------------------------------------------------------------------
// Count the valid strings by brute force for tiny alphabets.
function bruteCount(sizes, L, each, noRepeat) {
  var n = sizes.reduce(function (a, b) { return a + b; }, 0), owner = [];
  sizes.forEach(function (s, i) { for (var k = 0; k < s; k++) owner.push(i); });
  var total = Math.pow(n, L), count = 0;
  for (var x = 0; x < total; x++) {
    var v = x, prev = -1, seen = 0, ok = true;
    for (var i = 0; i < L; i++) {
      var c = v % n; v = Math.floor(v / n);
      if (noRepeat && c === prev) { ok = false; break; }
      prev = c; seen |= 1 << owner[c];
    }
    if (ok && each && seen !== (1 << sizes.length) - 1) ok = false;
    if (ok) count++;
  }
  return count;
}
test('entropy: inclusion–exclusion matches brute force on tiny sets', function () {
  var cases = [[[2, 3], 4], [[1, 2, 3], 5], [[2, 2, 2, 1], 6], [[3], 4], [[1, 1], 3], [[4, 1], 7], [[1, 1, 1], 3]];
  cases.forEach(function (cs) {
    [false, true].forEach(function (each) {
      [false, true].forEach(function (noRep) {
        var cnt = bruteCount(cs[0], cs[1], each, noRep), bits = C.setsEntropy(cs[0], cs[1], each, noRep);
        if (cnt === 0) assert.strictEqual(bits, -Infinity, JSON.stringify(cs) + ' ' + each + noRep);
        else near(bits, log2(cnt), 1e-9, JSON.stringify(cs) + ' each=' + each + ' noRepeat=' + noRep);
      });
    });
  });
  assert.strictEqual(C.setsEntropy([2, 2, 2], 2, true, false), -Infinity); // shorter than the number of sets
});
test('entropy: known random-password settings', function () {
  near(C.passwordInfo({ length: 10, lower: true }).bits, 10 * log2(26), 1e-9);
  near(C.passwordInfo({ length: 16, upper: true, lower: true, digits: true }).bits, 16 * log2(62), 1e-9);
  near(C.passwordInfo({ length: 20, upper: true, lower: true, digits: true, symbols: true }).bits, 20 * log2(90), 1e-9);
  // look-alikes out: I O / l o / 0 1 -> 24 + 24 + 8
  near(C.passwordInfo({ length: 12, upper: true, lower: true, digits: true, ambiguous: true }).bits, 12 * log2(56), 1e-9);
  // custom symbols, de-duplicated, letters/digits/space dropped
  near(C.passwordInfo({ length: 8, digits: true, symbols: true, symbolSet: '!!@ a1#' }).bits, 8 * log2(13), 1e-9);
  // "each set" lowers it slightly
  var e = C.passwordInfo({ length: 8, upper: true, lower: true, digits: true, symbols: true, each: true }).bits;
  assert.ok(e < 8 * log2(90) && e > 8 * log2(90) - 2, String(e));
  // no identical neighbours: n (n-1)^(L-1)
  near(C.passwordInfo({ length: 12, lower: true, noRepeat: true }).bits, log2(26) + 11 * log2(25), 1e-9);
  assert.ok(C.passwordInfo({ length: 12 }).error);
  assert.ok(C.passwordInfo({ length: 12, symbols: true, symbolSet: 'abc' }).error);
});
test('entropy: passphrase, PIN, memorable', function () {
  near(C.phraseInfo({ words: 6, sep: 'hyphen' }, 1296).bits, 6 * log2(1296), 1e-9);
  near(C.phraseInfo({ words: 6, sep: 'hyphen', digit: true }, 1296).bits, 6 * log2(1296) + log2(10) + log2(6), 1e-9);
  near(C.phraseInfo({ words: 4, sep: 'space', digit: true, symbol: true }, 1296).bits, 4 * log2(1296) + log2(10) + log2(4) + log2(12) + log2(4), 1e-9);
  near(C.phraseInfo({ words: 5, sep: 'hyphen', symbol: true }, 1296).bits, 5 * log2(1296) + log2(12) + log2(5), 1e-9);
  assert.strictEqual(C.phraseInfo({ words: 5, sep: 'none' }, 1296).approx, true);
  assert.strictEqual(C.phraseInfo({ words: 5, sep: 'none', cap: true }, 1296).approx, false);
  near(C.pinInfo({ digits: 4 }).bits, 4 * log2(10), 1e-9);
  near(C.pinInfo({ digits: 4, avoidWeak: true }).bits, log2(10000 - 884), 1e-9);
  near(C.pinInfo({ digits: 6, avoidWeak: true }).bits, log2(1e6 - 85246), 1e-9);
  near(C.memoInfo({ syllables: 12 }).bits, 12 * log2(80), 1e-9);
  near(C.memoInfo({ syllables: 10, digit: true }).bits, 10 * log2(80) + log2(10 * 4), 1e-9);
});
test('entropy: passphrase outputs are distinct (count check on a tiny list)', function () {
  // every combination of (words, digit word, digit, symbol word, symbol) gives a different string
  var list = ['ab', 'cd', 'ef'], o = { words: 2, sep: 'hyphen', digit: true, symbol: true }, seen = {}, combos = 0;
  var syms = C.PHRASE_SYMBOLS.split('').filter(function (c) { return c !== '-'; });
  for (var a = 0; a < 3; a++) for (var b = 0; b < 3; b++) for (var dp = 0; dp < 2; dp++) for (var d = 0; d < 10; d++) for (var sp = 0; sp < 2; sp++) for (var s = 0; s < syms.length; s++) {
    var w = [list[a], list[b]]; w[dp] += d; w[sp] += syms[s]; seen[w.join('-')] = 1; combos++;
  }
  assert.strictEqual(Object.keys(seen).length, combos);
  near(C.phraseInfo(o, 3).bits, log2(combos), 1e-9);
});
test('weak PINs: table = rule count = brute force', function () {
  for (var L = 4; L <= 12; L++) assert.strictEqual(C.WEAK_PINS[L], C.countWeakPins(L), 'L=' + L);
  for (var L2 = 4; L2 <= 7; L2++) {
    var n = 0, lim = Math.pow(10, L2);
    for (var x = 0; x < lim; x++) { var s = String(x); while (s.length < L2) s = '0' + s; if (C.pinWeakness(s)) n++; }
    assert.strictEqual(n, C.countWeakPins(L2), 'brute L=' + L2);
  }
  ['0000', '1212', '1234', '9876', '7890', '2580', '1987', '2024', '0101', '1231', '3112', '123123', '311299', '19991231', '12121212'].forEach(function (p) {
    assert.ok(C.pinWeakness(p), p + ' should be weak');
  });
  ['8463', '5097', '738459', '48207315'].forEach(function (p) { assert.strictEqual(C.pinWeakness(p), '', p + ' should be fine'); });
});

// ---- generators honour their settings ----------------------------------------------------
test('random password: length, alphabet, each set, look-alikes, neighbours', function () {
  var configs = [
    { length: 8, upper: true, lower: true, digits: true, symbols: true, each: true },
    { length: 128, lower: true, digits: true, each: true, noRepeat: true },
    { length: 12, upper: true, digits: true, ambiguous: true, each: true },
    { length: 9, symbols: true, digits: true, symbolSet: '#!', each: true, noRepeat: true },
    { length: 30, lower: true, symbols: true, symbolSet: '€§', each: true },
    { length: 8, upper: true, lower: true, digits: true, symbols: true, ambiguous: true, noRepeat: true },
  ];
  configs.forEach(function (o) {
    var sets = C.passwordSets(o), pool = {};
    sets.forEach(function (s) { s.chars.forEach(function (c) { pool[c] = 1; }); });
    for (var t = 0; t < 400; t++) {
      var pw = C.generatePassword(o, rng), cs = Array.from(pw);
      assert.strictEqual(cs.length, o.length);
      cs.forEach(function (c) { assert.ok(pool[c], 'unexpected ' + c + ' in ' + pw); });
      if (o.each) sets.forEach(function (s) { assert.ok(cs.some(function (c) { return s.chars.indexOf(c) >= 0; }), 'missing ' + s.key + ' in ' + pw); });
      if (o.noRepeat) for (var i = 1; i < cs.length; i++) assert.notStrictEqual(cs[i], cs[i - 1], 'repeat in ' + pw);
      if (o.ambiguous) cs.forEach(function (c) { assert.ok(C.AMBIGUOUS.indexOf(c) < 0, 'look-alike ' + c); });
    }
  });
  assert.throws(function () { C.generatePassword({ length: 10 }, rng); });
});
test('random password: characters are roughly uniform', function () {
  var counts = {}, N = 3000, L = 20;
  for (var t = 0; t < N; t++) Array.from(C.generatePassword({ length: L, lower: true, digits: true }, rng)).forEach(function (c) { counts[c] = (counts[c] || 0) + 1; });
  var exp = N * L / 36;
  assert.strictEqual(Object.keys(counts).length, 36);
  Object.keys(counts).forEach(function (c) { assert.ok(Math.abs(counts[c] - exp) < exp * 0.12, c + ' ' + counts[c]); });
});
test('passphrase: word count, list membership, separator, capitals, extras', function () {
  var set = {}; WORDS.forEach(function (w) { set[w] = 1; });
  assert.strictEqual(WORDS.length, 1296);
  assert.strictEqual(Object.keys(set).length, 1296);
  var o = { words: 7, sep: 'period', cap: true, digit: true, symbol: true };
  for (var t = 0; t < 300; t++) {
    var p = C.generatePhrase(o, WORDS, rng), parts = p.split('.');
    assert.strictEqual(parts.length, 7, p);
    var digits = (p.match(/\d/g) || []).length, syms = (p.match(/[!#$%&*+=?@^~]/g) || []).length;
    assert.strictEqual(digits, 1, p); assert.strictEqual(syms, 1, p);
    parts.forEach(function (w) {
      var bare = w.replace(/[\d!#$%&*+=?@^~]+$/, '');
      assert.ok(/^[A-Z]/.test(bare), 'capitalized ' + w);
      assert.ok(set[bare.toLowerCase()], 'in list ' + bare);
    });
  }
  var plain = C.generatePhrase({ words: 3, sep: 'space' }, WORDS, rng);
  assert.strictEqual(plain.split(' ').length, 3);
  assert.ok(plain === plain.toLowerCase());
  assert.throws(function () { C.generatePhrase({ words: 3 }, [], rng); });
});
test('PIN: digits only, right length, never weak when asked', function () {
  for (var L = 4; L <= 12; L++) {
    for (var t = 0; t < 400; t++) {
      var p = C.generatePin({ digits: L, avoidWeak: true }, rng);
      assert.ok(new RegExp('^\\d{' + L + '}$').test(p), p);
      assert.strictEqual(C.pinWeakness(p), '', p);
    }
  }
  var weakSeen = 0;
  for (var k = 0; k < 4000; k++) if (C.pinWeakness(C.generatePin({ digits: 4 }, rng))) weakSeen++;
  assert.ok(weakSeen > 150 && weakSeen < 600, 'unfiltered PINs include weak ones at the base rate: ' + weakSeen);
});
test('memorable: syllable structure, groups, capitals, digit', function () {
  var syl = '[' + C.CONS + '][' + C.VOWELS + ']';
  for (var t = 0; t < 300; t++) {
    var m = C.generateMemo({ syllables: 11, cap: true, digit: true }, rng);
    var groups = m.split('-');
    assert.strictEqual(groups.length, 4, m);
    assert.strictEqual((m.match(/\d/g) || []).length, 1, m);
    groups.forEach(function (g, i) {
      var bare = g.replace(/\d$/, '');
      assert.ok(/^[A-Z]/.test(bare), m);
      assert.ok(new RegExp('^(' + syl + '){' + (i < 3 ? 3 : 2) + '}$').test(bare.toLowerCase()), m);
    });
  }
});

// ---- strength ---------------------------------------------------------------------------
test('strength: labels, meter, crack time', function () {
  assert.strictEqual(C.rate(30).label, 'weak');
  assert.strictEqual(C.rate(44.9).label, 'weak');
  assert.strictEqual(C.rate(45).label, 'fair');
  assert.strictEqual(C.rate(65).label, 'strong');
  assert.strictEqual(C.rate(85).label, 'very strong');
  assert.strictEqual(C.rate(0).meter, '[□□□□□□□□□□]');
  assert.strictEqual(C.rate(62).meter, '[■■■■■■■□□□]');
  assert.strictEqual(C.rate(300).meter, '[■■■■■■■■■■]');
  assert.strictEqual(C.crackTime(20), 'instantly');
  assert.strictEqual(C.crackTime(40), '55 seconds');       // 2^39 / 1e10
  assert.strictEqual(C.crackTime(50), '16 hours');
  assert.strictEqual(C.crackTime(60), '2 years');
  assert.strictEqual(C.crackTime(80), '1.9 million years');
  assert.strictEqual(C.crackTime(129.7), '10²¹ years');
  // monotonic in seconds-equivalent order
  var order = ['instantly', 'second', 'minute', 'hour', 'day', 'month', 'year'];
  var last = 0;
  for (var b = 1; b < 70; b += 0.5) {
    var s = C.crackTime(b), idx = 0;
    order.forEach(function (u, i) { if (s.indexOf(u) >= 0) idx = i; });
    assert.ok(idx >= last, 'crack time not monotonic at ' + b + ': ' + s);
    last = idx;
  }
});

// ---- checker ----------------------------------------------------------------------------
var WS = {}; WORDS.forEach(function (w) { WS[w] = 1; });
test('checker: common passwords, patterns and dates are weak', function () {
  ['password', 'P@ssw0rd', '123456', 'qwerty', 'qwertyuiop', 'iloveyou', 'aaaaaaaa', 'abcdef', '19900512', 'drowssap', 'zxcvbnm', 'asdfghjkl;'].forEach(function (p) {
    var r = C.checkPassword(p, WS);
    assert.strictEqual(r.label, 'weak', p + ' -> ' + r.bits);
    assert.ok(r.findings.length > 0, p + ' has findings');
  });
  var r = C.checkPassword('password', WS);
  assert.strictEqual(r.findings[0].kind, 'common');
  assert.ok(C.checkPassword('qwerty', WS).findings.some(function (f) { return f.kind === 'common' || f.kind === 'keyboard'; }));
  assert.ok(C.checkPassword('hjkl;\'', WS).findings.some(function (f) { return f.kind === 'keyboard'; }));
  assert.ok(C.checkPassword('xx1987xx', WS).findings.some(function (f) { return f.kind === 'date'; }));
  assert.ok(C.checkPassword('zebrayodel', WS).findings.some(function (f) { return f.kind === 'word'; }));
  assert.ok(C.checkPassword('mnopqr', WS).findings.some(function (f) { return f.kind === 'sequence'; }));
  assert.ok(C.checkPassword('xyzxyzxyz9', WS).findings.length);
  assert.strictEqual(C.checkPassword('', WS), null);
});
test('checker: random strings score high, words cost less than random', function () {
  var r = C.checkPassword('kX9#mQ2$vL8@nR4w', WS);
  assert.ok(r.bits > 85, String(r.bits));
  var gen = C.generatePassword({ length: 20, upper: true, lower: true, digits: true, symbols: true, each: true }, rng);
  assert.ok(C.checkPassword(gen, WS).bits > 100);
  var phrase = C.checkPassword('zebra-acorn-yodel-basil', WS), rand = C.checkPassword('qhvnd-xkwpz-tmrbf-jlgcz', WS);
  assert.ok(phrase.bits < rand.bits);
  assert.deepStrictEqual(C.checkPassword('Ab1!', WS).classes, ['lowercase', 'uppercase', 'digits', 'symbols']);
});
test('checker: never throws, stays fast on odd input', function () {
  var alphabet = 'aA1!@#qwerty12319900101 \t\n€😀ßǅ.-_/\\|';
  for (var t = 0; t < 400; t++) {
    var n = 1 + rng.int(60), s = '';
    for (var i = 0; i < n; i++) s += Array.from(alphabet)[rng.int(Array.from(alphabet).length)];
    var r = C.checkPassword(s, WS);
    assert.ok(r && isFinite(r.bits) && r.bits >= 0, JSON.stringify(s));
  }
  var t0 = Date.now();
  C.checkPassword(new Array(300).join('qw'), WS);
  C.checkPassword(new Array(300).join('a'), WS);
  C.checkPassword(new Array(30).join('abcdefghij'), WS);
  assert.ok(Date.now() - t0 < 1500, 'pathological inputs took ' + (Date.now() - t0) + 'ms');
});

console.log((failed ? 'FAILED ' + failed + ', ' : '') + passed + ' passed');
