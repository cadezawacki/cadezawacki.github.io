/* Password Generator — random passwords, passphrases, PINs and pronounceable
 * passwords for Cade.txt.
 *
 * RANDOMNESS: only crypto.getRandomValues, turned into integers by rejection
 * sampling (no modulo bias), never Math.random. Each consumed random word is
 * zeroed in the buffer, and the buffer is wiped when the panel closes.
 *
 * STRENGTH: the EXACT entropy of the generator settings — log2 of the number of
 * equally likely outputs (inclusion–exclusion for "use every set", the excluded
 * weak PINs counted, …) — shown as a 10-cell ASCII meter, a label and the
 * average time to find it at 10^10 guesses/s (an offline attack on a fast
 * hash). "Check a password" estimates a TYPED password locally: classes,
 * length, common passwords, dictionary words (the EFF list), keyboard walks,
 * sequences, repeats and dates. Never stored, never sent.
 *
 * FILES: passgen-words.js (EFF Short Wordlist 1, CC BY 3.0) is loaded lazily —
 * only for a passphrase or the checker's dictionary pass.
 *
 * PRIVACY / PERFORMANCE: only settings are saved (Cade.store, cade-passgen-*).
 * Generated and checked passwords exist only in the panel's DOM and are wiped
 * when it closes. Nothing runs until the panel opens; there are no global
 * listeners, intervals or workers — a pending prefs write is flushed on close.
 *
 * The pure core (RNG, generators, entropy, strength, checker) is DOM-free and
 * exported for node tests: node txt/widgets/passgen/passgen.test.js
 * Self-contained IIFE, ES5 style. */
(function () {
  'use strict';

  // ===========================================================================
  // Pure core — no DOM, no Cade
  // ===========================================================================
  var Core = (function () {
    var TWO32 = 4294967296;
    function log2(x) { return Math.log(x) / Math.LN2; }
    function clampInt(v, lo, hi, dflt) {
      v = Math.round(+v);
      if (!isFinite(v)) v = dflt;
      return Math.max(lo, Math.min(hi, v));
    }
    function chars(s) { return Array.from(String(s == null ? '' : s)); } // by code point
    function rep(s, n) { var o = ''; for (var i = 0; i < n; i++) o += s; return o; }

    // ---- unbiased random integers ------------------------------------------------
    // fill(Uint32Array) must fill the array with uniform random 32-bit words
    // (crypto.getRandomValues). Tests inject their own source.
    function makeRng(fill) {
      if (typeof fill !== 'function') {
        var c = typeof crypto !== 'undefined' && crypto && crypto.getRandomValues ? crypto : null;
        if (!c) throw new Error('crypto.getRandomValues is not available');
        fill = function (a) { c.getRandomValues(a); };
      }
      var buf = new Uint32Array(64), pos = buf.length;
      function u32() {
        if (pos >= buf.length) { fill(buf); pos = 0; }
        var x = buf[pos];
        buf[pos++] = 0; // no residue of consumed randomness
        return x;
      }
      // uniform integer in [0, n): reject the top 2^32 mod n values, then reduce
      function int(n) {
        if (n !== Math.floor(n) || n < 1 || n > TWO32) throw new RangeError('random int: bad range ' + n);
        if (n === 1) return 0;
        var limit = TWO32 - TWO32 % n;
        for (;;) { var x = u32(); if (x < limit) return x % n; }
      }
      function wipe() { for (var i = 0; i < buf.length; i++) buf[i] = 0; pos = buf.length; }
      return { int: int, u32: u32, wipe: wipe };
    }

    // ---- character sets --------------------------------------------------------------
    var UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', LOWER = 'abcdefghijklmnopqrstuvwxyz', DIGITS = '0123456789';
    var SYMBOLS = '!#$%&()*+,-./:;<=>?@[]^_{|}~';   // default: no quotes, backslash or backtick
    var AMBIGUOUS = 'Il1|O0o`\'"';                    // look-alikes

    // A custom symbol set: printable non-alphanumerics, de-duplicated, in order.
    function cleanSymbols(s) {
      var out = [], seen = {};
      chars(s).forEach(function (c) {
        if (/[\sA-Za-z0-9\u0000-\u001f\u007f-\u009f]/.test(c) || seen[c]) return;
        seen[c] = 1; out.push(c);
      });
      return out.join('');
    }
    // The disjoint sets a random-password config selects (look-alikes removed,
    // empty sets dropped).
    function passwordSets(o) {
      var sets = [];
      function add(key, s) {
        var cs = chars(s).filter(function (c) { return !o.ambiguous || AMBIGUOUS.indexOf(c) < 0; });
        if (cs.length) sets.push({ key: key, chars: cs });
      }
      if (o.upper) add('upper', UPPER);
      if (o.lower) add('lower', LOWER);
      if (o.digits) add('digits', DIGITS);
      if (o.symbols) add('symbols', cleanSymbols(o.symbolSet == null ? SYMBOLS : o.symbolSet));
      return sets;
    }

    // Exact entropy (bits) of a uniform pick among the length-L strings over the
    // union of disjoint sets of the given sizes that satisfy the constraints:
    //   each     — every set appears at least once (inclusion–exclusion)
    //   noRepeat — no two identical neighbours
    // -Infinity when no string satisfies them.
    function setsEntropy(sizes, L, each, noRepeat) {
      var n = 0, k = sizes.length, i;
      for (i = 0; i < k; i++) n += sizes[i];
      if (!n || L < 1) return -Infinity;
      if (noRepeat && n < 2 && L > 1) return -Infinity;
      if (each && L < k) return -Infinity;
      var base = noRepeat ? log2(n) + (L - 1) * (L > 1 ? log2(n - 1) : 0) : L * log2(n);
      if (!each || k < 2) return base;
      // P(a uniform candidate contains every set) = Σ_S (-1)^|S| · P(no char from S)
      var p = 0;
      for (var mask = 0; mask < (1 << k); mask++) {
        var m = n, odd = 0;
        for (i = 0; i < k; i++) if (mask & (1 << i)) { m -= sizes[i]; odd ^= 1; }
        var t;
        if (!noRepeat) t = Math.pow(m / n, L);
        else t = m <= 0 ? 0 : L === 1 ? m / n : (m / n) * Math.pow((m - 1) / (n - 1), L - 1);
        p += odd ? -t : t;
      }
      return p > 0 ? base + log2(p) : -Infinity;
    }

    // Uniform over the valid strings: candidates are uniform over all strings
    // (or all strings with no identical neighbours), and rejecting the ones that
    // miss a set keeps the survivors uniform.
    function generateFromSets(sets, L, each, noRepeat, rng) {
      var pool = [], owner = [], k = sets.length;
      sets.forEach(function (s, si) { s.chars.forEach(function (c) { pool.push(c); owner.push(si); }); });
      var n = pool.length;
      if (!n) throw new Error('Pick at least one character set');
      if (noRepeat && n < 2 && L > 1) throw new Error('Avoiding repeats needs at least two characters');
      if (each && L < k) throw new Error('Too short to use every set');
      var full = (1 << k) - 1;
      for (var tries = 0; tries < 100000; tries++) {
        var out = new Array(L), seen = 0, prev = -1;
        for (var i = 0; i < L; i++) {
          var x;
          if (noRepeat && prev >= 0) { x = rng.int(n - 1); if (x >= prev) x++; } // uniform over the n-1 others
          else x = rng.int(n);
          out[i] = pool[x]; seen |= 1 << owner[x]; prev = x;
        }
        if (!each || seen === full) return out.join('');
      }
      throw new Error('Could not satisfy the settings');
    }

    // ---- random password ------------------------------------------------------------------
    function passwordInfo(o) {
      var sets = passwordSets(o), L = clampInt(o.length, 1, 1024, 20);
      var info = { sets: sets, length: L, error: '', bits: 0, pool: 0 };
      sets.forEach(function (s) { info.pool += s.chars.length; });
      if (!sets.length) info.error = o.symbols && !o.upper && !o.lower && !o.digits ? 'The symbol set is empty' : 'Pick at least one character set';
      else {
        info.bits = setsEntropy(sets.map(function (s) { return s.chars.length; }), L, !!o.each, !!o.noRepeat);
        if (info.bits === -Infinity) info.error = 'These settings allow no password';
      }
      return info;
    }
    function generatePassword(o, rng) {
      var info = passwordInfo(o);
      if (info.error) throw new Error(info.error);
      return generateFromSets(info.sets, info.length, !!o.each, !!o.noRepeat, rng);
    }

    // ---- passphrase -------------------------------------------------------------------------
    var SEPARATORS = { hyphen: '-', space: ' ', period: '.', underscore: '_', comma: ',', none: '' };
    var PHRASE_SYMBOLS = '!#$%&*+=?@^~';
    function phraseSymbols(sep) { return chars(PHRASE_SYMBOLS).filter(function (c) { return c !== sep; }); }
    function phraseInfo(o, nWords) {
      var n = clampInt(o.words, 1, 64, 6), sep = Object.prototype.hasOwnProperty.call(SEPARATORS, o.sep) ? SEPARATORS[o.sep] : '-';
      var W = nWords || 0, syms = phraseSymbols(sep);
      var info = { words: n, sep: sep, bits: 0, error: '', approx: false, symbols: syms };
      if (W < 2) { info.error = 'The word list is not loaded'; return info; }
      // digit / symbol: a random one appended to a random word (n positions each);
      // outputs stay distinct, so the counts multiply.
      info.bits = n * log2(W) + (o.digit ? log2(10) + log2(n) : 0) + (o.symbol ? log2(syms.length) + log2(n) : 0);
      // no separator and no capitals: word boundaries can be ambiguous → upper bound
      info.approx = sep === '' && !o.cap;
      return info;
    }
    function capWord(w) { return w.charAt(0).toUpperCase() + w.slice(1); }
    function generatePhrase(o, words, rng) {
      var info = phraseInfo(o, words && words.length);
      if (info.error) throw new Error(info.error);
      var picks = [], i;
      for (i = 0; i < info.words; i++) {
        var w = words[rng.int(words.length)];
        picks.push(o.cap ? capWord(w) : w);
      }
      if (o.digit) { i = rng.int(info.words); picks[i] += DIGITS.charAt(rng.int(10)); }
      if (o.symbol) { i = rng.int(info.words); picks[i] += info.symbols[rng.int(info.symbols.length)]; }
      return picks.join(info.sep);
    }

    // ---- PIN ---------------------------------------------------------------------------------
    // Weak = a repeated block (0000, 1212, 123123), a straight run (1234, 9876,
    // 7890), a well-known pattern (keypad lines …), or — for 4/6/8 digits — a
    // year or a date (MMDD, DDMM, DDMMYY, YYYYMMDD …).
    var COMMON_PINS = {};
    ('1004 1122 2580 0852 1470 0741 3690 0963 1379 1397 7931 9731 2468 8642 1357 7531 5683 1235 ' +
      '112233 123321 159753 159357 147258 147852 258369 789456 111222 102030 147369 963852 741852 852456 753951 ' +
      '11223344 12344321 13572468').split(' ').forEach(function (p) { COMMON_PINS[p] = 1; });
    var MDAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    function dayOk(m, d) { return m >= 1 && m <= 12 && d >= 1 && d <= MDAYS[m - 1]; }
    function isPeriodic(s) {
      var L = s.length;
      for (var p = 1; p <= L / 2; p++) if (L % p === 0 && s === rep(s.slice(0, p), L / p)) return true;
      return false;
    }
    function isDatePin(s) {
      var L = s.length;
      function n(a, b) { return +s.slice(a, b); }
      if (L === 4) return n(0, 2) === 19 || n(0, 2) === 20 || dayOk(n(0, 2), n(2, 4)) || dayOk(n(2, 4), n(0, 2));
      if (L === 6) return dayOk(n(2, 4), n(0, 2)) || dayOk(n(0, 2), n(2, 4)) || dayOk(n(2, 4), n(4, 6));
      if (L === 8) {
        var yE = n(4, 8), yS = n(0, 4);
        return (yE >= 1900 && yE <= 2099 && (dayOk(n(2, 4), n(0, 2)) || dayOk(n(0, 2), n(2, 4)))) ||
          (yS >= 1900 && yS <= 2099 && dayOk(n(4, 6), n(6, 8)));
      }
      return false;
    }
    // '' or why the PIN is weak
    function pinWeakness(s) {
      if (isPeriodic(s)) return 'repeat';
      var up = true, dn = true;
      for (var i = 1; i < s.length; i++) {
        var d = (s.charCodeAt(i) - s.charCodeAt(i - 1) + 10) % 10;
        if (d !== 1) up = false;
        if (d !== 9) dn = false;
      }
      if (s.length > 1 && (up || dn)) return 'run';
      if (COMMON_PINS[s]) return 'common';
      if (isDatePin(s)) return 'date';
      return '';
    }
    // Möbius function, for counting the strings that are a repeated block
    function mobius(n) {
      var r = 1;
      for (var p = 2; p * p <= n; p++) {
        if (n % p === 0) { n /= p; if (n % p === 0) return 0; r = -r; }
      }
      return n > 1 ? -r : r;
    }
    function pad(x, w) { x = String(x); while (x.length < w) x = '0' + x; return x; }
    // How many length-L PINs pinWeakness() flags — without enumerating 10^L:
    // the periodic ones by Möbius inversion, the rest from their rules.
    function countWeakPins(L) {
      var primitive = 0, d;
      for (d = 1; d <= L; d++) if (L % d === 0) primitive += mobius(L / d) * Math.pow(10, d);
      var total = Math.pow(10, L) - primitive, seen = {};
      function cand(s) { if (s.length === L && !seen[s] && !isPeriodic(s) && pinWeakness(s)) { seen[s] = 1; total++; } }
      var i, a, b, s, m, dd, y;
      for (a = 0; a < 10; a++) {
        s = ''; b = a; for (i = 0; i < L; i++) { s += b; b = (b + 1) % 10; } cand(s);
        s = ''; b = a; for (i = 0; i < L; i++) { s += b; b = (b + 9) % 10; } cand(s);
      }
      Object.keys(COMMON_PINS).forEach(cand);
      if (L === 4) for (y = 1900; y <= 2099; y++) cand(String(y));
      if (L === 4 || L === 6 || L === 8) {
        for (m = 1; m <= 12; m++) for (dd = 1; dd <= MDAYS[m - 1]; dd++) {
          var M = pad(m, 2), D = pad(dd, 2);
          if (L === 4) { cand(M + D); cand(D + M); }
          else if (L === 6) for (y = 0; y < 100; y++) { var Y = pad(y, 2); cand(D + M + Y); cand(M + D + Y); cand(Y + M + D); }
          else for (y = 1900; y <= 2099; y++) { cand(D + M + y); cand(M + D + y); cand(y + M + D); }
        }
      }
      return total;
    }
    // countWeakPins(4..12), precomputed (passgen.test.js re-derives and brute-forces them)
    var WEAK_PINS = { 4: 884, 5: 30, 6: 85246, 7: 30, 8: 200799, 9: 1020, 10: 100110, 11: 30, 12: 1009920 };
    function pinInfo(o) {
      var L = clampInt(o.digits, 1, 18, 6), weak = 0;
      if (o.avoidWeak) weak = WEAK_PINS[L] != null ? WEAK_PINS[L] : countWeakPins(L);
      return { length: L, bits: log2(Math.pow(10, L) - weak), weakCount: weak, error: '' };
    }
    function generatePin(o, rng) {
      var info = pinInfo(o);
      for (var tries = 0; tries < 100000; tries++) {
        var s = '';
        for (var i = 0; i < info.length; i++) s += DIGITS.charAt(rng.int(10));
        if (!o.avoidWeak || !pinWeakness(s)) return s;
      }
      throw new Error('Could not generate a PIN');
    }

    // ---- memorable (pronounceable) -------------------------------------------------------------
    // Consonant–vowel syllables, grouped in threes with hyphens: "bafeku-motira".
    var CONS = 'bdfghjklmnprstvz', VOWELS = 'aeiou';
    function memoInfo(o) {
      var k = clampInt(o.syllables, 1, 64, 12), groups = Math.ceil(k / 3);
      return { syllables: k, groups: groups, error: '', bits: k * log2(CONS.length * VOWELS.length) + (o.digit ? log2(10 * groups) : 0) };
    }
    function generateMemo(o, rng) {
      var info = memoInfo(o), parts = [], g = '';
      for (var i = 0; i < info.syllables; i++) {
        g += CONS.charAt(rng.int(CONS.length)) + VOWELS.charAt(rng.int(VOWELS.length));
        if (i % 3 === 2 || i === info.syllables - 1) { parts.push(o.cap ? capWord(g) : g); g = ''; }
      }
      if (o.digit) { var j = rng.int(parts.length); parts[j] += DIGITS.charAt(rng.int(10)); }
      return parts.join('-');
    }

    // ---- strength ------------------------------------------------------------------------------
    var RATE = 1e10; // guesses per second: an offline attack on a fast hash
    var SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
    function sup(n) { return String(n).replace(/\d/g, function (d) { return SUP.charAt(+d); }); }
    function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
    function sig(x) { return x < 10 ? String(Math.round(x * 10) / 10).replace(/\.0$/, '') : String(Math.round(x)); }
    // Average time to find it (half the space) at `rate` guesses/s, in words.
    function crackTime(bits, rate) {
      rate = rate || RATE;
      if (!(bits > 1)) return 'instantly';
      var lg = (bits - 1) * Math.log10(2) - Math.log10(rate); // log10(seconds)
      if (lg < 0) return 'instantly';
      var s = Math.pow(10, lg);
      if (s < 60) return plural(Math.max(1, Math.round(s)), 'second');
      if (s < 3600) return plural(Math.round(s / 60), 'minute');
      if (s < 86400) return plural(Math.round(s / 3600), 'hour');
      if (s < 86400 * 31) return plural(Math.round(s / 86400), 'day');
      if (s < 31557600) return plural(Math.round(s / 2629800), 'month');
      var ly = lg - Math.log10(31557600), y = Math.pow(10, ly);
      if (y < 1000) return plural(Math.round(y), 'year');
      if (y < 1e6) return sig(y / 1e3) + ' thousand years';
      if (y < 1e9) return sig(y / 1e6) + ' million years';
      if (y < 1e12) return sig(y / 1e9) + ' billion years';
      return '10' + sup(Math.floor(ly)) + ' years';
    }
    function rate(bits) {
      bits = bits > 0 ? bits : 0;
      var label = bits < 45 ? 'weak' : bits < 65 ? 'fair' : bits < 85 ? 'strong' : 'very strong';
      var cells = bits <= 0 ? 0 : Math.max(1, Math.min(10, Math.ceil(bits / 10)));
      return {
        bits: bits, label: label, key: label.replace(' ', '-'), cells: cells,
        meter: '[' + rep('■', cells) + rep('□', 10 - cells) + ']', time: crackTime(bits),
      };
    }

    // ---- password checker (estimate for a typed password) -----------------------------------------
    // Common passwords, most common first (from public breach top lists).
    var COMMON_PW = ('123456 password 12345678 qwerty 123456789 12345 1234 111111 1234567 dragon 123123 baseball ' +
      'abc123 football monkey letmein 696969 shadow master 666666 qwertyuiop 123321 mustang 1234567890 michael 654321 ' +
      'superman 1qaz2wsx 7777777 121212 000000 qazwsx 123qwe killer trustno1 jordan jennifer zxcvbnm asdfgh hunter ' +
      'buster soccer harley batman andrew tigger sunshine iloveyou 2000 charlie robert thomas hockey ranger daniel ' +
      'starwars klaster 112233 george computer michelle jessica pepper 1111 zxcvbn 555555 11111111 131313 freedom ' +
      '777777 pass maggie 159753 aaaaaa ginger princess joshua cheese amanda summer love ashley nicole chelsea biteme ' +
      'matthew access yankees 987654321 dallas austin thunder taylor matrix admin welcome login passw0rd password1 ' +
      'qwerty123 1q2w3e4r 1q2w3e4r5t 123abc abcd1234 qwe123 zaq12wsx letmein1 welcome1 admin123 secret ' +
      'hello flower whatever mypass passpass 1password p4ssw0rd iloveu ilovey0u lovely babygirl 654321a 1qazxsw2 ' +
      'football1 baseball1 superman1 dragon1 monkey1 shadow1 master1 sunshine1 princess1 qwertyui asdfghjkl ' +
      'q1w2e3r4 q1w2e3r4t5 a1b2c3 aa123456 password123 123456a 1234qwer changeme default guest root toor ' +
      'test test123 temp qwerty1 azerty letmein123 trustme google samsung apple facebook linkedin').split(' ');
    var COMMON_RANK = null;
    function commonRank() {
      if (!COMMON_RANK) { COMMON_RANK = {}; COMMON_PW.forEach(function (w, i) { if (!COMMON_RANK[w]) COMMON_RANK[w] = i + 1; }); }
      return COMMON_RANK;
    }
    var L33T = { '4': 'a', '@': 'a', '8': 'b', '(': 'c', '3': 'e', '6': 'g', '9': 'g', '1': 'i', '!': 'i', '|': 'i', '0': 'o', '$': 's', '5': 's', '7': 't', '+': 't', '2': 'z' };
    var KEY_ROWS = ['`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./'];
    var ROW_X = [0, 1.5, 1.75, 2.25];
    var SHIFT_OF = { '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/' };
    var KEYPOS = null;
    function keyPos(c) {
      if (!KEYPOS) {
        KEYPOS = {};
        KEY_ROWS.forEach(function (row, y) { for (var x = 0; x < row.length; x++) KEYPOS[row.charAt(x)] = [ROW_X[y] + x, y]; });
      }
      var base = SHIFT_OF[c] || c.toLowerCase();
      return KEYPOS[base] || null;
    }
    function isShifted(c) { return !!SHIFT_OF[c] || (c >= 'A' && c <= 'Z'); }
    function keyAdjacent(a, b) {
      var p = keyPos(a), q = keyPos(b);
      if (!p || !q) return false;
      var dy = Math.abs(p[1] - q[1]), dx = Math.abs(p[0] - q[0]);
      return dy === 0 ? dx === 1 : dy === 1 && dx <= 0.75;
    }
    function keyDir(a, b) { var p = keyPos(a), q = keyPos(b); return (q[1] - p[1]) + ':' + (q[0] > p[0] ? 1 : -1); }
    function nCk(n, k) { if (k < 0 || k > n) return 0; var r = 1; for (var i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; }
    // zxcvbn's estimate for a keyboard walk of length L with t turns
    function spatialBits(s) {
      var L = s.length, turns = 1, i, j, g = 0, S = 94, D = 4.6;
      for (i = 2; i < L; i++) if (keyDir(s.charAt(i - 2), s.charAt(i - 1)) !== keyDir(s.charAt(i - 1), s.charAt(i))) turns++;
      for (i = 2; i <= L; i++) for (j = 1; j <= Math.min(turns, i - 1); j++) g += nCk(i - 1, j - 1) * S * Math.pow(D, j);
      var sh = 0; for (i = 0; i < L; i++) if (isShifted(s.charAt(i))) sh++;
      if (sh) { var u = L - sh; if (!u) g *= 2; else { var v = 0; for (i = 1; i <= Math.min(sh, u); i++) v += nCk(L, i); g *= v; } }
      return log2(g);
    }
    function charClass(c) {
      if (c >= 'a' && c <= 'z') return 'lower';
      if (c >= 'A' && c <= 'Z') return 'upper';
      if (c >= '0' && c <= '9') return 'digit';
      if (c.charCodeAt(0) < 128) return 'symbol';
      return 'other';
    }
    var CLASS_SIZE = { lower: 26, upper: 26, digit: 10, symbol: 33, other: 100 };
    function capBits(w) {
      var up = 0, lo = 0, i;
      for (i = 0; i < w.length; i++) { var c = w.charAt(i); if (c >= 'A' && c <= 'Z') up++; else if (c >= 'a' && c <= 'z') lo++; }
      if (!up) return 0;
      if (!lo || (up === 1 && /^[A-Z]/.test(w)) || (up === 1 && /[A-Z]$/.test(w))) return 1;
      var v = 0; for (i = 1; i <= Math.min(up, lo); i++) v += nCk(up + lo, i);
      return log2(v);
    }
    function wordVariants(sub) {
      // lower-cased, plus de-l33ted readings (1 and | can be i or l)
      var lo = sub.toLowerCase(), out = [{ w: lo, subs: 0 }];
      if (!/[48(3691!|0$572@+]/.test(lo)) return out;
      ['i', 'l'].forEach(function (one) {
        var w = '', n = 0;
        for (var i = 0; i < lo.length; i++) {
          var c = lo.charAt(i), r = L33T[c];
          if ((c === '1' || c === '|') && r) r = one;
          if (r) { w += r; n++; } else w += c;
        }
        if (n && w !== out[out.length - 1].w) out.push({ w: w, subs: n });
      });
      return out;
    }
    var WORD_BITS = log2(648); // a word from the 1,296-word list: half the list on average
    // Cost of one repeated block: brute force, or a known word / password (no recursion).
    function blockBits(block, wordSet) {
      var brute = block.length * log2(poolOf(block).pool), lo = block.toLowerCase(), r = commonRank()[lo];
      if (r) brute = Math.min(brute, log2(r) + capBits(block));
      if (wordSet && wordSet[lo]) brute = Math.min(brute, WORD_BITS + capBits(block));
      return brute;
    }
    // Candidate segments of the password: { i, j, bits, kind, text }
    function findPatterns(pw, wordSet) {
      var segs = [], n = pw.length, i, j, k, rank = commonRank();
      function add(a, b, bits, kind) { segs.push({ i: a, j: b, bits: Math.max(0, bits), kind: kind, text: pw.slice(a, b) }); }
      // dictionary: common passwords and words, plain / l33t / reversed
      for (i = 0; i < n; i++) {
        for (j = i + 3; j <= Math.min(n, i + 20); j++) {
          var sub = pw.slice(i, j), extra = capBits(sub);
          var vs = wordVariants(sub), rv = sub.split('').reverse().join('').toLowerCase();
          vs.push({ w: rv, subs: 0, rev: true });
          for (k = 0; k < vs.length; k++) {
            var v = vs[k], cost = extra + (v.subs ? Math.max(1, v.subs) : 0) + (v.rev ? 1 : 0);
            if (rank[v.w]) add(i, j, log2(rank[v.w]) + cost, v.rev ? 'reversed' : v.subs ? 'leet' : 'common');
            else if (wordSet && wordSet[v.w] && v.w.length >= 4) add(i, j, WORD_BITS + cost, v.rev ? 'reversed-word' : v.subs ? 'leet-word' : 'word');
          }
        }
      }
      // keyboard walks (4+ adjacent keys; pieces up to 24 keys)
      for (i = 0; i < n - 1; i = j) {
        for (j = i + 1; j < n && keyAdjacent(pw.charAt(j - 1), pw.charAt(j)); j++) {}
        if (j - i >= 4) for (var a = i; a <= j - 4; a++) for (var b = a + 4; b <= Math.min(j, a + 24); b++) add(a, b, spatialBits(pw.slice(a, b)), 'keyboard');
      }
      // sequences (abc, 975, ZYX: steady step ±1 or ±2 within one class)
      for (i = 0; i < n - 2; i++) {
        var cls = charClass(pw.charAt(i)), step = pw.charCodeAt(i + 1) - pw.charCodeAt(i);
        if (cls === 'symbol' || cls === 'other' || !step || Math.abs(step) > 2) continue;
        for (j = i + 1; j < n && charClass(pw.charAt(j)) === cls && pw.charCodeAt(j) - pw.charCodeAt(j - 1) === step; j++) {}
        if (j - i >= 3) {
          var first = pw.charAt(i), start = /[aAzZ019]/.test(first) ? 4 : cls === 'digit' ? 10 : 26;
          for (var e = i + 3; e <= j; e++) add(i, e, log2(start * (e - i) * (step < 0 ? 2 : 1) * (Math.abs(step) > 1 ? 2 : 1)), 'sequence');
        }
      }
      // repeats: aaa, abcabc (block ≤ 16 chars)
      for (i = 0; i < n; i++) {
        for (var bl = 1; bl <= 16 && i + 2 * bl <= n; bl++) {
          var block = pw.slice(i, i + bl), times = 1;
          while (pw.slice(i + times * bl, i + (times + 1) * bl) === block) times++;
          if (times >= 2 && (bl > 1 || times >= 3)) {
            var bb = blockBits(block, wordSet);
            for (var t2 = 2; t2 <= times; t2++) if (bl > 1 || t2 >= 3) add(i, i + t2 * bl, bb + log2(t2), 'repeat');
          }
        }
      }
      // dates and years
      var YEAR = /^(19|20)\d\d$/;
      for (i = 0; i < n; i++) {
        for (j = i + 4; j <= Math.min(n, i + 10); j++) {
          var ds = pw.slice(i, j);
          if (!/^\d/.test(ds) || !/\d$/.test(ds)) continue;
          if (YEAR.test(ds)) { add(i, j, log2(150), 'date'); continue; }
          if (isDateText(ds)) add(i, j, log2(366 * 120) + (/\D/.test(ds) ? 2 : 0), 'date');
        }
      }
      return segs;
    }
    function isDateText(s) {
      var m = /^(\d{1,4})([\s\/\\_.-])(\d{1,2})\2(\d{1,4})$/.exec(s), parts;
      if (m) parts = [m[1], m[3], m[4]];
      else if (/^\d{6}$/.test(s)) parts = null;
      else if (/^\d{8}$/.test(s)) parts = null;
      else return false;
      function y(v) { var x = +v; return v.length === 2 || (v.length === 4 && x >= 1900 && x <= 2099); }
      if (parts) {
        if (parts[0].length >= 3) return parts[0].length === 4 && y(parts[0]) && dayOk(+parts[1], +parts[2]);
        if (parts[2].length !== 2 && parts[2].length !== 4) return false;
        return y(parts[2]) && (dayOk(+parts[1], +parts[0]) || dayOk(+parts[0], +parts[1]));
      }
      var L = s.length, Y = L === 6 ? 2 : 4;
      function n2(a, b) { return +s.slice(a, b); }
      return (y(s.slice(L - Y)) && (dayOk(n2(2, 4), n2(0, 2)) || dayOk(n2(0, 2), n2(2, 4)))) ||
        (y(s.slice(0, Y)) && dayOk(n2(Y, Y + 2), n2(Y + 2, Y + 4)));
    }
    function poolOf(pw) {
      var seen = {}, pool = 0;
      for (var i = 0; i < pw.length; i++) { var c = charClass(pw.charAt(i)); if (!seen[c]) { seen[c] = 1; pool += CLASS_SIZE[c]; } }
      return { pool: pool, classes: ['lower', 'upper', 'digit', 'symbol', 'other'].filter(function (c) { return seen[c]; }) };
    }
    // Minimum-cost split of the password into brute-forced characters and the
    // patterns above (dynamic programming), in bits.
    function estimateBits(pw, wordSet, outSegs) {
      var n = pw.length;
      if (!n) return 0;
      var per = log2(poolOf(pw).pool), segs = findPatterns(pw, wordSet);
      var best = [0], from = [null], i, j;
      var byEnd = {};
      segs.forEach(function (s) { (byEnd[s.j] || (byEnd[s.j] = [])).push(s); });
      for (j = 1; j <= n; j++) {
        best[j] = best[j - 1] + per; from[j] = null;
        var list = byEnd[j] || [];
        for (i = 0; i < list.length; i++) {
          var c = best[list[i].i] + list[i].bits;
          if (c < best[j]) { best[j] = c; from[j] = list[i]; }
        }
      }
      var used = [];
      for (j = n; j > 0;) { var s = from[j]; if (s) { used.unshift(s); j = s.i; } else j--; }
      var bits = best[n];
      if (used.length > 1) { var f = 1; for (i = 2; i <= used.length; i++) f *= i; bits += log2(f); }
      if (outSegs) Array.prototype.push.apply(outSegs, used);
      return bits;
    }
    var KIND_TEXT = {
      common: 'Common password', leet: 'Common password with l33t swaps', reversed: 'Common password reversed',
      word: 'Dictionary word', 'leet-word': 'Dictionary word with l33t swaps', 'reversed-word': 'Dictionary word reversed',
      keyboard: 'Keyboard pattern', sequence: 'Sequence', repeat: 'Repeat', date: 'Date or year',
    };
    var CLASS_NAME = { lower: 'lowercase', upper: 'uppercase', digit: 'digits', symbol: 'symbols', other: 'other characters' };
    // -> { bits, length, classes, findings: [{kind, text, label}], ... rate fields }
    function checkPassword(pw, wordSet) {
      pw = String(pw == null ? '' : pw);
      if (!pw) return null;
      var MAX = 128, head = pw.slice(0, MAX), used = [];
      var pi = poolOf(pw);
      var bits = estimateBits(head, wordSet, used);
      if (pw.length > MAX) bits += (Array.from(pw).length - Array.from(head).length) * log2(pi.pool);
      var r = rate(bits), findings = [], seen = {};
      if (pw.length === head.length && commonRank()[pw.toLowerCase()]) {
        findings.push({ kind: 'common', label: 'One of the most common passwords', text: pw }); seen['common:' + pw.toLowerCase()] = 1;
      }
      used.forEach(function (s) {
        var key = s.kind + ':' + s.text.toLowerCase();
        if (seen[key]) return;
        seen[key] = 1;
        findings.push({ kind: s.kind, label: KIND_TEXT[s.kind] || s.kind, text: s.text });
      });
      r.length = Array.from(pw).length;
      r.classes = pi.classes.map(function (c) { return CLASS_NAME[c]; });
      r.findings = findings;
      r.tips = [];
      if (r.length < 12) r.tips.push('Use at least 12 characters — or a passphrase of 6+ random words.');
      if (pi.classes.length < 2 && r.length < 20) r.tips.push('Only ' + r.classes[0] + ': mixing types helps a little, length helps more.');
      if (findings.length) r.tips.push('Predictable parts are cheap to guess; random characters or random words are not.');
      return r;
    }

    return {
      makeRng: makeRng, UPPER: UPPER, LOWER: LOWER, DIGITS: DIGITS, SYMBOLS: SYMBOLS, AMBIGUOUS: AMBIGUOUS,
      cleanSymbols: cleanSymbols, passwordSets: passwordSets, setsEntropy: setsEntropy, generateFromSets: generateFromSets,
      passwordInfo: passwordInfo, generatePassword: generatePassword,
      SEPARATORS: SEPARATORS, PHRASE_SYMBOLS: PHRASE_SYMBOLS, phraseInfo: phraseInfo, generatePhrase: generatePhrase,
      pinWeakness: pinWeakness, countWeakPins: countWeakPins, WEAK_PINS: WEAK_PINS, pinInfo: pinInfo, generatePin: generatePin,
      CONS: CONS, VOWELS: VOWELS, memoInfo: memoInfo, generateMemo: generateMemo,
      RATE: RATE, crackTime: crackTime, rate: rate, checkPassword: checkPassword, isDateText: isDateText,
      keyAdjacent: keyAdjacent, COMMON_PW: COMMON_PW, clampInt: clampInt,
    };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ===========================================================================
  // Panel UI
  // ===========================================================================
  var Cade = window.Cade;
  Cade.loadCSS('passgen.css');
  var WORDS_URL = Cade.asset('passgen-words.js'); // resolve now, while the loader context is ours
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'passgen-panel';
  var PREFS_KEY = 'cade-passgen-prefs';
  var DEFAULTS = {
    mode: 'random',
    len: 20, upper: true, lower: true, digits: true, symbols: true, symbolSet: Core.SYMBOLS, each: true, ambiguous: false, noRepeat: false,
    words: 6, sep: 'hyphen', cap: true, wdigit: true, wsymbol: false,
    pin: 6, pinWeak: true,
    syl: 12, scap: true, sdigit: true,
  };
  var MODES = ['random', 'phrase', 'pin', 'memo'];
  var prefs = null, P = null, words = null, wordSet = null, wordsP = null;

  // ---- prefs (settings only — never a password) -----------------------------------
  function loadPrefs() {
    prefs = {};
    var saved = null;
    try { saved = JSON.parse(Cade.store.get(PREFS_KEY) || 'null'); } catch (e) {}
    for (var k in DEFAULTS) prefs[k] = saved && typeof saved[k] === typeof DEFAULTS[k] ? saved[k] : DEFAULTS[k];
    if (MODES.indexOf(prefs.mode) < 0) prefs.mode = 'random';
    prefs.len = Core.clampInt(prefs.len, 8, 128, 20);
    prefs.words = Core.clampInt(prefs.words, 3, 10, 6);
    prefs.pin = Core.clampInt(prefs.pin, 4, 12, 6);
    prefs.syl = Core.clampInt(prefs.syl, 4, 20, 12);
    if (!Object.prototype.hasOwnProperty.call(Core.SEPARATORS, prefs.sep)) prefs.sep = 'hyphen';
    prefs.symbolSet = String(prefs.symbolSet).slice(0, 200);
  }
  function savePrefsNow() {
    if (!P) return;
    clearTimeout(P.tSave); P.tSave = 0;
    try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
  }
  // discrete changes save at once; slider / typing saves are debounced (and
  // flushed on close or when the page is hidden)
  function savePrefs(now) {
    if (!P) return;
    if (now) { savePrefsNow(); return; }
    clearTimeout(P.tSave);
    var st = P;
    P.tSave = setTimeout(function () { if (P === st) savePrefsNow(); }, 400);
  }

  // ---- word list (lazy) ---------------------------------------------------------------
  function ensureWords() {
    if (words) return Promise.resolve(words);
    if (wordsP) return wordsP;
    wordsP = new Promise(function (resolve, reject) {
      if (window.__cadePassgenWords) { resolve(); return; }
      var s = document.createElement('script');
      s.src = WORDS_URL; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load the word list' + (navigator.onLine ? '' : ' — it needs one online load to cache'))); };
      document.head.appendChild(s);
    }).then(function () {
      var w = window.__cadePassgenWords;
      if (!w || w.length < 1000) throw new Error('The word list is invalid');
      words = w; wordSet = {};
      w.forEach(function (x) { wordSet[x] = 1; });
      return words;
    });
    wordsP.catch(function () { wordsP = null; });
    return wordsP;
  }

  // ---- helpers ------------------------------------------------------------------------
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 1800); } catch (e) {} }
  function q(sel) { return P ? P.el.querySelector(sel) : null; }
  function fmt1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
  function copyText(text, msg) {
    var done = function () { toast(msg || 'Copied — the clipboard is not cleared automatically', 'success', 2600); };
    var fail = function () { toast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { if (document.execCommand('copy')) done(); else fail(); } catch (e) { fail(); }
      ta.value = '';
      ta.remove();
    }
  }
  function insertText(text) {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
    ed.dispatch(ed.state.replaceSelection(text), { userEvent: 'input', scrollIntoView: true });
    toast('Inserted at the cursor', 'success', 1300);
  }
  // Coloured rendering: digits and symbols stand out, so look-alikes are easy to read.
  function paint(el, pw) {
    el.textContent = '';
    var cur = null, cls = '';
    Array.from(pw).forEach(function (c) {
      var k = /[0-9]/.test(c) ? 'd' : /[A-Za-z]/.test(c) ? '' : 's';
      if (!cur || k !== cls) {
        cur = k ? document.createElement('span') : document.createTextNode('');
        if (k) cur.className = 'pg-c' + k;
        el.appendChild(cur); cls = k;
      }
      if (k) cur.textContent += c; else cur.data += c;
    });
  }
  function isTyping(t) {
    if (!t) return false;
    if (t.isContentEditable) return true;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    return t.tagName === 'INPUT' && !/^(checkbox|radio|range|button|submit|reset)$/i.test(t.type);
  }

  // ---- panel --------------------------------------------------------------------------
  var MODE_LABEL = { random: 'Password', phrase: 'Passphrase', pin: 'PIN', memo: 'Memorable' };
  function shell() {
    return '' +
      '<div class="pg-modes" role="tablist" aria-label="Kind">' +
        MODES.map(function (m) { return '<button type="button" class="pg-mode" role="tab" data-mode="' + m + '">' + MODE_LABEL[m] + '</button>'; }).join('') +
      '</div>' +
      '<div class="pg-outbox">' +
        '<div class="pg-out" aria-live="polite" aria-label="Generated password"></div>' +
      '</div>' +
      '<div class="pg-meter" aria-live="polite"><span class="pg-bar"></span> <span class="pg-label"></span> <span class="pg-bits"></span></div>' +
      '<div class="pg-time"></div>' +
      '<div class="pg-acts">' +
        '<button type="button" class="pg-btn primary pg-regen" title="New (R)">↻ New</button>' +
        '<button type="button" class="pg-btn pg-copy" title="Copy to the clipboard">Copy</button>' +
        '<button type="button" class="pg-btn pg-insert" title="Insert at the cursor in the note">Insert</button>' +
        '<button type="button" class="pg-btn pg-five" title="Generate five to pick from">×5</button>' +
      '</div>' +
      '<div class="pg-list" hidden></div>' +
      '<div class="pg-opts"></div>' +
      '<details class="pg-check"><summary>Check a password</summary>' +
        '<div class="pg-crow">' +
          '<input type="password" class="pg-cin" placeholder="Type a password to check" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-1p-ignore aria-label="Password to check">' +
          '<button type="button" class="pg-ibtn pg-eye" title="Show / hide" aria-pressed="false">Show</button>' +
        '</div>' +
        '<div class="pg-cres"><div class="pg-hint">Checked on this device only — never stored or sent.</div></div>' +
      '</details>' +
      '<div class="pg-about">crypto.getRandomValues, unbiased · only settings are saved · copied text stays on the clipboard until replaced (browsers can\'t reliably clear it) · ' +
        'crack times assume 10¹⁰ guesses/s offline · passphrases use the <a href="https://www.eff.org/dice" target="_blank" rel="noopener">EFF Short Wordlist 1</a> (CC BY 3.0)</div>';
  }
  function rangeRow(label, k, min, max) {
    return '<div class="pg-row"><span class="pg-lab">' + label + '</span>' +
      '<input type="range" class="pg-range" data-k="' + k + '" min="' + min + '" max="' + max + '" value="' + prefs[k] + '" aria-label="' + label + '">' +
      '<input type="number" class="pg-num" data-k="' + k + '" min="' + min + '" max="' + max + '" value="' + prefs[k] + '" inputmode="numeric" aria-label="' + label + '"></div>';
  }
  function cb(k, label, extra) {
    return '<label class="pg-cb"><input type="checkbox" data-k="' + k + '"' + (prefs[k] ? ' checked' : '') + '><span>' + label + (extra ? ' <span class="pg-dim">' + extra + '</span>' : '') + '</span></label>';
  }
  function chip(k, label, title) {
    return '<button type="button" class="pg-chip" data-t="' + k + '" aria-pressed="' + !!prefs[k] + '" title="' + title + '">' + label + '</button>';
  }
  function optsHtml(mode) {
    if (mode === 'random') {
      return rangeRow('Length', 'len', 8, 128) +
        '<div class="pg-chips">' + chip('upper', 'A–Z', 'Uppercase letters') + chip('lower', 'a–z', 'Lowercase letters') +
          chip('digits', '0–9', 'Digits') + chip('symbols', '!#$', 'Symbols') + '</div>' +
        '<div class="pg-row pg-symrow"><span class="pg-lab">Symbols</span>' +
          '<input type="text" class="pg-syms" data-k="symbolSet" value="' + esc(prefs.symbolSet) + '" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" aria-label="Symbol set">' +
          '<button type="button" class="pg-ibtn pg-symreset" title="Default symbols">↺</button></div>' +
        cb('each', 'Use every selected set at least once') +
        cb('ambiguous', 'No look-alikes', 'I l 1 | O 0 o ` \' "') +
        cb('noRepeat', 'No identical neighbours', 'aa, 11');
    }
    if (mode === 'phrase') {
      var seps = [['hyphen', 'Hyphen  -'], ['space', 'Space'], ['period', 'Period  .'], ['underscore', 'Underscore  _'], ['comma', 'Comma  ,'], ['none', 'None']];
      return rangeRow('Words', 'words', 3, 10) +
        '<div class="pg-row"><span class="pg-lab">Separator</span><select class="pg-sel" data-k="sep" aria-label="Separator">' +
          seps.map(function (s) { return '<option value="' + s[0] + '"' + (prefs.sep === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') + '</select></div>' +
        cb('cap', 'Capitalize words') + cb('wdigit', 'Add a digit') + cb('wsymbol', 'Add a symbol', Core.PHRASE_SYMBOLS) +
        '<div class="pg-note">1,296 words · 10.3 bits each · the digit / symbol goes after a random word</div>';
    }
    if (mode === 'pin') {
      return rangeRow('Digits', 'pin', 4, 12) +
        cb('pinWeak', 'Skip weak PINs', '0000, 1212, 1234, 2580, years, dates') +
        '<div class="pg-note">A PIN is protected by its attempt limit (lockout), not by entropy — the offline crack time doesn\'t apply.</div>';
    }
    return rangeRow('Syllables', 'syl', 4, 20) + cb('scap', 'Capitalize groups') + cb('sdigit', 'Add a digit') +
      '<div class="pg-note">Pronounceable consonant–vowel syllables · 80 per syllable (6.3 bits) · grouped in threes</div>';
  }

  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById(PANEL_ID);
    if (existing) { existing.remove(); if (existing._onClose) existing._onClose(); return; }
    loadPrefs();
    var el = Cade.mkPanel(PANEL_ID, '🔐 Password Generator', shell());
    el.setAttribute('tabindex', '-1');
    P = { el: el, out: el.querySelector('.pg-out'), cur: '', list: [], rng: Core.makeRng(), tSave: 0, gen: 0 };
    var st = P;
    bind(el, st);
    setMode(prefs.mode, true);
    el._onClose = function () { teardown(st); };
    P.onHide = function () { if (P === st) savePrefsNow(); };
    window.addEventListener('pagehide', P.onHide);
    el.addEventListener('cade-panel-minimize', P.onHide); // flush a pending write instead of running while parked
    if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) setTimeout(function () { if (P === st) try { el.focus({ preventScroll: true }); } catch (e) {} }, 0);
  }

  // Wipe every password from the panel's DOM and from memory.
  function teardown(st) {
    if (P !== st) return;
    savePrefsNow();
    window.removeEventListener('pagehide', P.onHide);
    var el = P.el;
    var cin = el.querySelector('.pg-cin');
    if (cin) { cin.value = ''; cin.type = 'password'; }
    ['.pg-out', '.pg-list', '.pg-cres'].forEach(function (s) { var x = el.querySelector(s); if (x) x.textContent = ''; });
    P.cur = ''; P.list = [];
    P.rng.wipe();
    P = null;
  }
  function close() { var el = document.getElementById(PANEL_ID); if (el) { el.remove(); if (el._onClose) el._onClose(); } }

  function bind(el, st) {
    el.addEventListener('click', function (e) {
      var t = e.target, b;
      if (P !== st || !t.closest) return;
      if ((b = t.closest('.pg-mode'))) { setMode(b.getAttribute('data-mode')); return; }
      if ((b = t.closest('.pg-chip'))) {
        var k = b.getAttribute('data-t');
        prefs[k] = !prefs[k]; b.setAttribute('aria-pressed', String(prefs[k]));
        savePrefs(true); regen(); return;
      }
      if (t.closest('.pg-regen')) { regen(); return; }
      if (t.closest('.pg-copy')) { if (P.cur) copyText(P.cur); return; }
      if (t.closest('.pg-insert')) { if (P.cur) insertText(P.cur); return; }
      if (t.closest('.pg-five')) { makeList(); return; }
      if (t.closest('.pg-lclose')) { hideList(); return; }
      if ((b = t.closest('[data-use]'))) { var u = P.list[+b.getAttribute('data-use')]; if (u) { P.cur = u; render(); } return; }
      if ((b = t.closest('[data-lcopy]'))) { var c = P.list[+b.getAttribute('data-lcopy')]; if (c) copyText(c); return; }
      if (t.closest('.pg-symreset')) {
        prefs.symbolSet = Core.SYMBOLS;
        var si = el.querySelector('.pg-syms'); if (si) si.value = prefs.symbolSet;
        savePrefs(true); regen(); return;
      }
      if ((b = t.closest('.pg-eye'))) {
        var inp = el.querySelector('.pg-cin'), show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        b.textContent = show ? 'Hide' : 'Show'; b.setAttribute('aria-pressed', String(show));
      }
    });
    el.addEventListener('input', function (e) {
      var t = e.target;
      if (P !== st) return;
      if (t.classList.contains('pg-cin')) { check(); return; }
      var k = t.getAttribute('data-k');
      if (!k || t.type === 'checkbox' || t.tagName === 'SELECT') return;
      if (t.type === 'range' || t.type === 'number') {
        var lim = { len: [8, 128], words: [3, 10], pin: [4, 12], syl: [4, 20] }[k];
        if (t.type === 'number' && (t.value === '' || +t.value < lim[0] || +t.value > lim[1])) return; // mid-typing: wait for a valid value
        prefs[k] = Core.clampInt(t.value, lim[0], lim[1], DEFAULTS[k]);
        el.querySelectorAll('[data-k="' + k + '"]').forEach(function (x) { if (x !== t) x.value = prefs[k]; });
      } else prefs[k] = t.value.slice(0, 200);
      savePrefs(); regen();
    });
    el.addEventListener('change', function (e) {
      var t = e.target, k = t.getAttribute('data-k');
      if (P !== st || !k) return;
      if (t.type === 'checkbox') prefs[k] = t.checked;
      else if (t.tagName === 'SELECT') prefs[k] = t.value;
      else if (t.type === 'number') { t.value = prefs[k]; return; } // out-of-range entry: snap back
      else return;
      savePrefs(true); regen();
    });
    el.querySelector('.pg-check').addEventListener('toggle', function (e) {
      if (P === st && e.target.open) { ensureWords().then(function () { if (P === st) check(); }, function () {}); }
    });
    el.addEventListener('keydown', function (e) {
      if (P !== st || (Cade.isMinimized && Cade.isMinimized(el))) return;
      if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
        e.preventDefault(); regen();
      }
    });
  }

  function setMode(mode, first) {
    if (MODES.indexOf(mode) < 0) mode = 'random';
    if (!first && mode === prefs.mode && P.el.querySelector('.pg-opts').childElementCount) return;
    prefs.mode = mode;
    P.el.querySelectorAll('.pg-mode').forEach(function (b) {
      var on = b.getAttribute('data-mode') === mode;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on));
    });
    q('.pg-opts').innerHTML = optsHtml(mode);
    hideList();
    if (!first) savePrefs(true);
    regen();
  }

  // Settings of the current mode -> { info, make() }
  function spec() {
    var m = prefs.mode;
    if (m === 'random') {
      var o = { length: prefs.len, upper: prefs.upper, lower: prefs.lower, digits: prefs.digits, symbols: prefs.symbols, symbolSet: prefs.symbolSet, each: prefs.each, ambiguous: prefs.ambiguous, noRepeat: prefs.noRepeat };
      return { info: Core.passwordInfo(o), make: function () { return Core.generatePassword(o, P.rng); } };
    }
    if (m === 'phrase') {
      var po = { words: prefs.words, sep: prefs.sep, cap: prefs.cap, digit: prefs.wdigit, symbol: prefs.wsymbol };
      if (!words) return { info: { error: '', loading: true }, make: null };
      return { info: Core.phraseInfo(po, words.length), make: function () { return Core.generatePhrase(po, words, P.rng); } };
    }
    if (m === 'pin') {
      var pn = { digits: prefs.pin, avoidWeak: prefs.pinWeak };
      return { info: Core.pinInfo(pn), make: function () { return Core.generatePin(pn, P.rng); } };
    }
    var mo = { syllables: prefs.syl, cap: prefs.scap, digit: prefs.sdigit };
    return { info: Core.memoInfo(mo), make: function () { return Core.generateMemo(mo, P.rng); } };
  }

  function regen() {
    if (!P) return;
    var st = P, s = spec(), gen = ++P.gen;
    P.err = s.info.error || '';
    P.loading = !!s.info.loading;
    if (P.loading) {
      P.cur = '';
      render(s.info);
      ensureWords().then(function () { if (P === st && P.gen === gen) regen(); }, function (e) {
        if (P === st && P.gen === gen) { P.loading = false; P.err = e.message; render(s.info); }
      });
      return;
    }
    P.cur = '';
    if (!P.err) { try { P.cur = s.make(); } catch (e) { P.err = e.message; } }
    if (!q('.pg-list').hidden) fillList(s);
    render(s.info);
  }

  function render(info) {
    if (!P) return;
    info = info || spec().info;
    var out = P.out;
    out.classList.toggle('pg-msg', !P.cur);
    if (P.cur) paint(out, P.cur);
    else out.textContent = P.loading ? 'Loading the word list…' : P.err || '';
    var ok = !!P.cur && !P.err;
    ['.pg-copy', '.pg-insert', '.pg-five'].forEach(function (s) { var b = q(s); if (b) b.disabled = !ok; });
    var r = ok ? Core.rate(info.bits) : null, m = q('.pg-meter');
    m.setAttribute('data-r', r ? r.key : '');
    q('.pg-bar').textContent = r ? r.meter : '[□□□□□□□□□□]';
    q('.pg-label').textContent = r ? r.label : '';
    q('.pg-bits').textContent = r ? (info.approx ? '≤ ' : '') + fmt1(info.bits) + ' bits' : '';
    var len = P.cur ? Array.from(P.cur).length : 0;
    var tm = '';
    if (r) {
      tm = (prefs.mode === 'pin' ? 'Offline: ' : '') + '≈ ' + r.time + ' to crack on average at 10¹⁰ guesses/s' + ' · ' + len + ' characters';
      if (prefs.mode === 'pin' && info.weakCount) tm += ' · ' + info.weakCount.toLocaleString('en-US') + ' weak PINs excluded';
      if (info.approx) tm += ' · no separator or capitals: word boundaries can blur';
    }
    q('.pg-time').textContent = tm;
  }

  // ---- five to pick from ---------------------------------------------------------------
  function makeList() {
    if (!P || !P.cur) return;
    q('.pg-list').hidden = false;
    fillList(spec());
  }
  function fillList(s) {
    var box = q('.pg-list');
    P.list = [];
    if (!s.make || s.info.error) { box.hidden = true; box.textContent = ''; return; }
    for (var i = 0; i < 5; i++) { try { P.list.push(s.make()); } catch (e) { break; } }
    box.innerHTML = '<div class="pg-lhead"><span>Pick one</span><button type="button" class="pg-ibtn pg-lclose" title="Hide the list" aria-label="Hide the list">✕</button></div>' +
      P.list.map(function (pw, i) {
        return '<div class="pg-li"><button type="button" class="pg-lt" data-use="' + i + '" title="Use this one"></button>' +
          '<button type="button" class="pg-ibtn" data-lcopy="' + i + '" title="Copy">Copy</button></div>';
      }).join('');
    box.querySelectorAll('.pg-lt').forEach(function (b, i) { paint(b, P.list[i]); });
  }
  function hideList() {
    var box = q('.pg-list');
    if (!box) return;
    box.hidden = true; box.textContent = '';
    if (P) P.list = [];
  }

  // ---- check a typed password -------------------------------------------------------------
  function check() {
    if (!P) return;
    var inp = q('.pg-cin'), box = q('.pg-cres'), pw = inp.value;
    if (!pw) { box.innerHTML = '<div class="pg-hint">Checked on this device only — never stored or sent.</div>'; return; }
    if (!words) { var st = P; ensureWords().then(function () { if (P === st) check(); }, function () {}); }
    var r = Core.checkPassword(pw, wordSet);
    var h = '<div class="pg-meter" data-r="' + r.key + '"><span class="pg-bar">' + r.meter + '</span> <span class="pg-label">' + r.label + '</span> <span class="pg-bits">≈ ' + fmt1(r.bits) + ' bits</span></div>' +
      '<div class="pg-time">≈ ' + esc(r.time) + ' to crack on average at 10¹⁰ guesses/s · ' + r.length + ' characters · ' + esc(r.classes.join(', ')) + '</div>';
    if (r.findings.length) {
      h += '<ul class="pg-finds">' + r.findings.slice(0, 8).map(function (f) {
        return '<li><span class="pg-fk">' + esc(f.label) + '</span> <code></code></li>';
      }).join('') + '</ul>';
    }
    if (r.tips.length) h += '<div class="pg-tips">' + r.tips.map(esc).join(' ') + '</div>';
    h += '<div class="pg-hint">An estimate: attackers try common passwords, words, patterns and dates first. Checked on this device only — never stored or sent.</div>';
    box.innerHTML = h;
    // the fragments go in as text (never as HTML)
    box.querySelectorAll('.pg-finds code').forEach(function (c, i) { c.textContent = r.findings[i].text; });
  }

  Cade.registerWidget({
    name: 'Password Generator',
    description: 'Strong random passwords, passphrases, PINs & pronounceable ones — exact entropy, crack-time meter and a local password checker',
    icon: '🔐',
    tags: 'password,passwords,generator,generate,passphrase,diceware,pin,random,secure,strong,entropy,strength,crack,checker,security,eff,wordlist,pronounceable,memorable,keygen',
    open: open,
    close: close,
  });
})();
