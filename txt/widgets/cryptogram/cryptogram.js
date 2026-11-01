/* Cryptogram — crack a famous quote hidden behind a letter-swap cipher, for Cade.txt.
 * Every letter of a public-domain quote (and its author) is swapped for another
 * (a derangement: no letter ever stands for itself). Tap a cipher letter, then a
 * key (or type on a real keyboard) to say what you think it stands for; every
 * copy of that cipher letter fills in at once. The frequency strip counts each
 * cipher letter, clashing guesses are flagged, Check marks wrong guesses and a
 * Hint reveals a letter (both cost score). Daily puzzle (the same for everyone
 * on a date), practice at three difficulties (easy pre-reveals a few letters),
 * and "From my note", which encodes a sentence from the open note.
 * Streaks, best times and best scores persist in Cade.store (cade-cryptogram-*).
 * The quote book (cryptogram-quotes.js) is loaded on first open; offline-first.
 * Not a game panel: the editor beside it stays usable. A press inside the panel
 * arms keyboard capture; a press anywhere else hands the keyboard back. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var DIFFS = {
    easy: { id: 'easy', name: 'Easy', min: 16, max: 44, reveal: 3, base: 400 },
    medium: { id: 'medium', name: 'Medium', min: 34, max: 78, reveal: 1, base: 800 },
    hard: { id: 'hard', name: 'Hard', min: 62, max: 999, reveal: 0, base: 1300 },
    note: { id: 'note', name: 'Note', min: 10, max: 999, reveal: 1, base: 500 }
  };
  var DIFF_IDS = ['easy', 'medium', 'hard'];
  var HINT_COST = 150, CHECK_COST = 40;
  var EPOCH = '2026-01-01';
  var ENGLISH_FREQ = 'ETAOINSHRDLUCMFWYPGBVKJXQZ';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  // mulberry32: small seeded PRNG so a puzzle is reproducible from its seed
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {   // FNV-1a
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function isL(ch) { return ch >= 'A' && ch <= 'Z'; }
  function letters(s) { return String(s).toUpperCase().replace(/[^A-Z]/g, ''); }

  // Accents folded, curly quotes / dashes made plain, anything else non-printable dropped.
  function plainText(s) {
    s = String(s == null ? '' : s);
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    s = s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, ' - ').replace(/…/g, '...')
      .replace(/ß/g, 'ss').replace(/[æÆ]/g, 'ae').replace(/[œŒ]/g, 'oe');
    s = s.replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s;
  }
  function parseQuote(line) {
    var s = String(line || ''), i = s.lastIndexOf('|');
    return i < 0 ? { text: plainText(s), author: '' } : { text: plainText(s.slice(0, i)), author: plainText(s.slice(i + 1)) };
  }

  // A random derangement of the alphabet: key[p] is the cipher letter for plain letter p.
  function makeKey(r) {
    var k, i, j, t, ok;
    for (var tries = 0; tries < 200; tries++) {
      k = ALPHA.split('');
      for (i = k.length - 1; i > 0; i--) { j = Math.floor(r() * (i + 1)); t = k[i]; k[i] = k[j]; k[j] = t; }
      ok = true;
      for (i = 0; i < 26; i++) if (k[i] === ALPHA[i]) { ok = false; break; }
      if (ok) break;
    }
    if (!ok) {   // practically unreachable; a rotation is always a derangement
      for (i = 0; i < 26; i++) {
        var idx = ALPHA.indexOf(k[i]);
        if (idx === i) { j = (i + 1) % 26; t = k[i]; k[i] = k[j]; k[j] = t; }
      }
    }
    var out = {};
    for (i = 0; i < 26; i++) out[ALPHA[i]] = k[i];
    return out;
  }
  function encode(s, key) {
    var u = String(s).toUpperCase(), out = '';
    for (var i = 0; i < u.length; i++) { var ch = u[i]; out += isL(ch) ? key[ch] : ch; }
    return out;
  }
  function invert(key) { var o = {}; for (var p in key) o[key[p]] = p; return o; }

  // Indices of quotes that fit a difficulty, by letter count (no quote is too trivial).
  function pool(quotes, diff) {
    var d = DIFFS[diff] || DIFFS.medium, out = [];
    for (var i = 0; i < quotes.length; i++) {
      var q = parseQuote(quotes[i]), n = letters(q.text).length;
      if (n >= d.min && n <= d.max && distinctCount(q.text) >= 7) out.push(i);
    }
    return out;
  }
  function distinctCount(s) { var m = {}, n = 0, u = letters(s); for (var i = 0; i < u.length; i++) if (!m[u[i]]) { m[u[i]] = 1; n++; } return n; }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function dayNum(s) { var p = String(s).split('-'); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000); }
  function numDate(n) { var d = new Date(n * 86400000); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
  function prevDate(s) { return numDate(dayNum(s) - 1); }
  function validDate(s) { return typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && numDate(dayNum(s)) === s; }

  // The daily: medium Monday-Thursday, easy on Sunday, hard Friday/Saturday. The
  // quote walks a fixed shuffle of the pool, so no repeat until the pool is used up.
  function dailyDiff(date) { var wd = (dayNum(date) + 4) % 7; return wd === 0 ? 'easy' : wd >= 5 ? 'hard' : 'medium'; }
  function dailyDesc(quotes, date) {
    var diff = dailyDiff(date), pl = pool(quotes, diff), r = rng(hashStr('cg-daily-' + diff)), i, j, t;
    for (i = pl.length - 1; i > 0; i--) { j = Math.floor(r() * (i + 1)); t = pl[i]; pl[i] = pl[j]; pl[j] = t; }
    var n = dayNum(date) - dayNum(EPOCH), len = pl.length;
    return { kind: 'daily', diff: diff, qi: pl.length ? pl[((n % len) + len) % len] : 0, seed: hashStr('cg-day-' + date), date: date };
  }
  function practiceDesc(quotes, diff, r, seen) {
    var pl = pool(quotes, diff), avoid = {}, i;
    (seen || []).forEach(function (q) { avoid[q] = 1; });
    var fresh = pl.filter(function (q) { return !avoid[q]; });
    if (!fresh.length) fresh = pl;
    var qi = fresh.length ? fresh[Math.floor(r() * fresh.length)] : 0;
    return { kind: 'practice', diff: DIFFS[diff] && diff !== 'note' ? diff : 'medium', qi: qi, seed: (r() * 4294967296) >>> 0 };
  }
  function noteDesc(text, seed) { return { kind: 'note', diff: 'note', text: plainText(text).slice(0, 240), seed: seed >>> 0 }; }

  // desc → the puzzle: plain + cipher text, the key, the cipher letters used,
  // their counts and the letters given away at the start.
  function buildPuzzle(desc, quotes) {
    var q;
    if (desc.kind === 'note') q = { text: plainText(desc.text), author: '' };
    else q = parseQuote(quotes[desc.qi] || '');
    var r = rng(desc.seed >>> 0), key = makeKey(r), sol = invert(key);
    var text = q.text.toUpperCase(), author = q.author.toUpperCase();
    var ctext = encode(text, key), cauthor = encode(author, key), freq = {}, list = [], all = ctext + cauthor, i;
    for (i = 0; i < all.length; i++) {
      var ch = all[i];
      if (!isL(ch)) continue;
      if (!freq[ch]) { freq[ch] = 0; list.push(ch); }
      freq[ch]++;
    }
    var d = DIFFS[desc.diff] || DIFFS.medium;
    // Givens: drawn from the mid-frequency letters (the commonest are the fun ones to crack).
    var nGive = Math.min(d.reveal, Math.max(0, list.length - 4)), given = [];
    if (nGive > 0) {
      var byF = list.slice().sort(function (a, b) { return freq[b] - freq[a] || (a < b ? -1 : 1); });
      var cand = byF.slice(Math.min(2, byF.length - 1));
      for (i = 0; i < nGive && cand.length; i++) given.push(cand.splice(Math.floor(r() * cand.length), 1)[0]);
    }
    return {
      desc: desc, text: text, author: author, ctext: ctext, cauthor: cauthor, key: key, sol: sol,
      letters: list.sort(), freq: freq, given: given, base: d.base, distinct: list.length, nLetters: letters(all).length
    };
  }

  function newGame(puz) {
    var g = { g: {}, hints: [], checks: 0, wrong: {}, t: 0, done: false, score: 0 };
    puz.given.forEach(function (c) { g.g[c] = puz.sol[c]; });
    return g;
  }
  function locked(puz, game, c) { return puz.given.indexOf(c) >= 0 || game.hints.indexOf(c) >= 0; }
  // Put plain letter p (or null) on cipher letter c. Locked letters don't move.
  function assign(puz, game, c, p) {
    if (game.done || !puz.freq[c] || locked(puz, game, c)) return false;
    p = p ? String(p).toUpperCase() : null;
    if (p && !isL(p)) return false;
    if (p) game.g[c] = p; else delete game.g[c];
    delete game.wrong[c];
    return true;
  }
  // Clashes: two cipher letters given the same plain letter, or a letter set to itself.
  function conflicts(puz, game) {
    var by = {}, out = {}, c;
    for (c in game.g) { if (!puz.freq[c]) continue; (by[game.g[c]] = by[game.g[c]] || []).push(c); }
    for (var p in by) if (by[p].length > 1) by[p].forEach(function (x) { out[x] = 'dup'; });
    for (c in game.g) if (puz.freq[c] && game.g[c] === c) out[c] = 'self';
    return out;
  }
  function filled(puz, game) { var n = 0; puz.letters.forEach(function (c) { if (game.g[c]) n++; }); return n; }
  function isSolved(puz, game) {
    for (var i = 0; i < puz.letters.length; i++) { var c = puz.letters[i]; if (game.g[c] !== puz.sol[c]) return false; }
    return true;
  }
  // Marks wrong guesses (they stay marked until changed). Returns how many.
  function check(puz, game) {
    if (game.done) return 0;
    game.checks++;
    game.wrong = {};
    var n = 0;
    puz.letters.forEach(function (c) { if (game.g[c] && game.g[c] !== puz.sol[c]) { game.wrong[c] = 1; n++; } });
    return n;
  }
  // Reveal a letter: the preferred one if it still needs it, else the commonest unsolved.
  // A wrong guess elsewhere that used the revealed plain letter is cleared.
  function hint(puz, game, prefer) {
    if (game.done) return null;
    var need = puz.letters.filter(function (c) { return !locked(puz, game, c) && game.g[c] !== puz.sol[c]; });
    if (!need.length) {
      // all right but not locked? reveal nothing; pick an unlocked one anyway so the hint isn't wasted
      return null;
    }
    var c = prefer && need.indexOf(prefer) >= 0 ? prefer : need.sort(function (a, b) { return puz.freq[b] - puz.freq[a] || (a < b ? -1 : 1); })[0];
    var p = puz.sol[c];
    for (var o in game.g) if (o !== c && game.g[o] === p && !locked(puz, game, o)) { delete game.g[o]; delete game.wrong[o]; }
    game.g[c] = p;
    delete game.wrong[c];
    game.hints.push(c);
    return c;
  }
  function par(puz) { return 25 + puz.distinct * 7; }
  function score(puz, game, secs) {
    var base = puz.base, bonus = Math.max(0, Math.round((par(puz) - secs) * 4));
    var pen = game.hints.length * HINT_COST + game.checks * CHECK_COST;
    return Math.max(Math.round(base * 0.1), base + bonus - pen);
  }
  function finish(puz, game) {
    if (game.done || !isSolved(puz, game)) return false;
    game.done = true;
    game.wrong = {};
    game.t = Math.max(1000, Math.round(game.t / 1000) * 1000);   // whole seconds: the shown time is the recorded one
    game.score = score(puz, game, Math.round(game.t / 1000));
    return true;
  }

  // ---- saves ----
  function normGame(o, puz) {
    var g = newGame(puz);
    if (!o || typeof o !== 'object') return g;
    if (o.g && typeof o.g === 'object') {
      for (var c in o.g) {
        var p = o.g[c];
        if (isL(c) && c.length === 1 && puz.freq[c] && typeof p === 'string' && p.length === 1 && isL(p) && !locked(puz, g, c)) g.g[c] = p;
      }
    }
    if (Array.isArray(o.hints)) {
      o.hints.forEach(function (c) {
        if (typeof c === 'string' && puz.freq[c] && g.hints.indexOf(c) < 0 && puz.given.indexOf(c) < 0) { g.hints.push(c); g.g[c] = puz.sol[c]; }
      });
    }
    g.checks = clamp(Math.floor(+o.checks) || 0, 0, 9999);
    g.t = clamp(+o.t || 0, 0, 99 * 3600000);
    if (o.wrong && typeof o.wrong === 'object') for (var w in o.wrong) if (puz.freq[w] && g.g[w] && g.g[w] !== puz.sol[w]) g.wrong[w] = 1;
    if (o.done && isSolved(puz, g)) { g.done = true; g.score = clamp(Math.floor(+o.score) || 0, 0, 1e6); }
    return g;
  }
  function normDesc(o, quotes) {
    if (!o || typeof o !== 'object') return null;
    var seed = (+o.seed) >>> 0;
    if (o.kind === 'note') {
      var t = plainText(o.text);
      return letters(t).length >= 4 ? noteDesc(t, seed) : null;
    }
    var qi = Math.floor(+o.qi);
    if (!(qi >= 0 && qi < quotes.length)) return null;
    var diff = DIFF_IDS.indexOf(o.diff) >= 0 ? o.diff : 'medium';
    if (o.kind === 'daily') return validDate(o.date) ? { kind: 'daily', diff: diff, qi: qi, seed: seed, date: o.date } : null;
    return { kind: 'practice', diff: diff, qi: qi, seed: seed };
  }
  function newStats() {
    var s = { diff: {}, daily: { streak: 0, best: 0, last: '', days: {} }, total: { played: 0, solved: 0, hints: 0 } };
    DIFF_IDS.concat('note').forEach(function (d) { s.diff[d] = { played: 0, solved: 0, bestT: 0, bestS: 0, clean: 0 }; });
    return s;
  }
  function nn(v, max) { v = Math.floor(+v); return v > 0 ? Math.min(v, max || 1e9) : 0; }
  function normStats(o) {
    var s = newStats();
    if (!o || typeof o !== 'object') return s;
    DIFF_IDS.concat('note').forEach(function (d) {
      var x = o.diff && o.diff[d];
      if (!x || typeof x !== 'object') return;
      var y = s.diff[d];
      y.played = nn(x.played); y.solved = Math.min(nn(x.solved), y.played || nn(x.solved)); y.bestT = nn(x.bestT, 99 * 3600); y.bestS = nn(x.bestS, 1e6); y.clean = nn(x.clean);
    });
    if (o.daily && typeof o.daily === 'object') {
      s.daily.streak = nn(o.daily.streak, 100000); s.daily.best = Math.max(nn(o.daily.best, 100000), s.daily.streak);
      s.daily.last = validDate(o.daily.last) ? o.daily.last : '';
      var days = o.daily.days && typeof o.daily.days === 'object' ? o.daily.days : {}, ks = Object.keys(days).filter(validDate).sort().slice(-120);
      ks.forEach(function (k) { var v = days[k]; if (v && typeof v === 'object') s.daily.days[k] = { t: nn(v.t, 99 * 3600), s: nn(v.s, 1e6), h: nn(v.h, 26) }; });
    }
    if (o.total && typeof o.total === 'object') { s.total.played = nn(o.total.played); s.total.solved = nn(o.total.solved); s.total.hints = nn(o.total.hints); }
    return s;
  }
  // A game started (counted once per puzzle by the UI).
  function recordStart(stats, desc) { var d = stats.diff[desc.diff] || stats.diff.medium; d.played++; stats.total.played++; }
  // A solve: bests, clean solves, the daily streak. Returns what improved.
  function recordSolve(stats, puz, game) {
    var desc = puz.desc, d = stats.diff[desc.diff] || stats.diff.medium, secs = Math.max(1, Math.round(game.t / 1000)), out = { bestT: false, bestS: false, streak: 0 };
    d.solved++; stats.total.solved++; stats.total.hints += game.hints.length;
    if (!game.hints.length && !game.checks) d.clean++;
    if (!d.bestT || secs < d.bestT) { out.bestT = d.bestT > 0; d.bestT = secs; }
    if (game.score > d.bestS) { out.bestS = d.bestS > 0; d.bestS = game.score; }
    if (desc.kind === 'daily' && !stats.daily.days[desc.date]) {
      var dl = stats.daily;
      if (dl.last === prevDate(desc.date)) dl.streak++;
      else if (dl.last !== desc.date) dl.streak = 1;
      if (!dl.last || desc.date > dl.last) dl.last = desc.date;
      dl.best = Math.max(dl.best, dl.streak);
      dl.days[desc.date] = { t: secs, s: game.score, h: game.hints.length };
      var ks = Object.keys(dl.days).sort();
      while (ks.length > 120) delete dl.days[ks.shift()];
      out.streak = dl.streak;
    }
    return out;
  }
  // The streak shown today: alive if the last solve was today or yesterday.
  function liveStreak(stats, today) {
    var l = stats.daily.last;
    return l === today || l === prevDate(today) ? stats.daily.streak : 0;
  }

  // ---- "From my note": a sentence to encode ----
  function cleanNote(s) {
    s = String(s || '');
    s = s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ').replace(/\S+@\S+\.\S+/g, ' ');
    s = s.replace(/^[ \t]*(#{1,6}|>+|[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)])[ \t]+/gm, '');
    s = s.replace(/[*_~|#<>{}\[\]\\^=]+/g, ' ');
    return s;
  }
  function sentences(text) {
    var out = [], parts = cleanNote(text).split(/\n\s*\n|\n/), i;
    for (i = 0; i < parts.length; i++) {
      var m = parts[i].match(/[^.!?]+[.!?]*/g) || [];
      for (var j = 0; j < m.length; j++) {
        var s = plainText(m[j]);
        if (s) out.push(s);
      }
    }
    return out;
  }
  function trimSentence(s, max) {
    s = plainText(s);
    if (s.length <= max) return s;
    var cut = s.slice(0, max), sp = cut.lastIndexOf(' ');
    return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:-]+$/, '') + '...';
  }
  function goodSentence(s) { var n = letters(s).length; return n >= 14 && distinctCount(s) >= 7 && n <= 400; }
  // Candidates from a note: good sentences, longest-ish first is not wanted —
  // keep note order so "near the cursor" can be found.
  function noteCandidates(text) {
    return sentences(text).filter(goodSentence).map(function (s) { return trimSentence(s, 170); });
  }
  // The sentence at the cursor (a selection wins), else a seeded random one.
  function pickNoteSentence(text, cursor, sel, r) {
    if (sel) { var ss = trimSentence(sel.replace(/\s+/g, ' '), 170); if (goodSentence(ss)) return ss; }
    var full = String(text || '');
    if (cursor != null && cursor >= 0) {
      var a = full.lastIndexOf('\n', cursor - 1) + 1, b = full.indexOf('\n', cursor);
      if (b < 0) b = full.length;
      var line = full.slice(a, b), rel = cursor - a, ms = line.match(/[^.!?]+[.!?]*/g) || [], pos = 0;
      for (var i = 0; i < ms.length; i++) {
        var end = pos + ms[i].length;
        if (rel >= pos && rel <= end) {
          var c = noteCandidates(ms[i]);
          if (c.length) return c[0];
          break;
        }
        pos = end;
      }
    }
    var all = noteCandidates(full);
    if (!all.length) return '';
    return all[Math.floor((r ? r() : Math.random()) * all.length)];
  }

  function fmtTime(secs) {
    secs = Math.max(0, Math.floor(secs));
    var h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = secs % 60;
    return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s);
  }
  function shareText(puz, game) {
    var d = puz.desc, secs = Math.round(game.t / 1000);
    var head = d.kind === 'daily' ? 'Cryptogram ' + d.date + ' (' + DIFFS[d.diff].name + ')' : 'Cryptogram ' + DIFFS[d.diff].name;
    return head + ' -- solved in ' + fmtTime(secs) + ', ' + game.score + ' pts' +
      (game.hints.length ? ', ' + game.hints.length + ' hint' + (game.hints.length > 1 ? 's' : '') : ', no hints') +
      (game.checks ? ', ' + game.checks + ' check' + (game.checks > 1 ? 's' : '') : '');
  }

  var ENGINE = {
    ALPHA: ALPHA, DIFFS: DIFFS, DIFF_IDS: DIFF_IDS, HINT_COST: HINT_COST, CHECK_COST: CHECK_COST, ENGLISH_FREQ: ENGLISH_FREQ,
    rng: rng, hashStr: hashStr, plainText: plainText, parseQuote: parseQuote, letters: letters, distinctCount: distinctCount,
    makeKey: makeKey, encode: encode, invert: invert, pool: pool, dailyDiff: dailyDiff, dailyDesc: dailyDesc, practiceDesc: practiceDesc, noteDesc: noteDesc,
    buildPuzzle: buildPuzzle, newGame: newGame, locked: locked, assign: assign, conflicts: conflicts, filled: filled, isSolved: isSolved,
    check: check, hint: hint, par: par, score: score, finish: finish, normGame: normGame, normDesc: normDesc,
    newStats: newStats, normStats: normStats, recordStart: recordStart, recordSolve: recordSolve, liveStreak: liveStreak,
    cleanNote: cleanNote, sentences: sentences, noteCandidates: noteCandidates, pickNoteSentence: pickNoteSentence, trimSentence: trimSentence,
    dateKey: dateKey, dayNum: dayNum, numDate: numDate, prevDate: prevDate, validDate: validDate, fmtTime: fmtTime, shareText: shareText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('cryptogram.css');
  var DATA_URL = Cade.asset('cryptogram-quotes.js');   // resolve now, while the module context is ours

  var PANEL_ID = 'cryptogram-panel', NAME = 'Cryptogram';
  var KEY = 'cade-cryptogram-', K_STATS = KEY + 'stats', K_PREFS = KEY + 'prefs', K_DAILY = KEY + 'daily', K_PLAY = KEY + 'play', K_NOTE = KEY + 'note', K_SOUND = KEY + 'sound';
  var KB_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', '<ZXCVBNM>'];
  var S = null;
  var quotes = null, loading = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.cryptogram = { live: function () { return S; } };

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function readJSON(k) { var raw = sget(k); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function today() { return dateKey(new Date()); }
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 1800); } catch (e) {} }
  function prettyDate(s) {
    var p = String(s).split('-');
    try { return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); } catch (e) { return s; }
  }

  function loadQuotes() {
    if (quotes) return Promise.resolve(quotes);
    if (window.__cadeCryptogramQuotes) { quotes = window.__cadeCryptogramQuotes; return Promise.resolve(quotes); }
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = DATA_URL; s.async = true;
      s.onload = function () {
        if (Array.isArray(window.__cadeCryptogramQuotes)) { quotes = window.__cadeCryptogramQuotes; resolve(quotes); }
        else { loading = null; reject(new Error('no data')); }
      };
      s.onerror = function () { loading = null; s.remove(); reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  // ---- sound: a tiny WebAudio voice, created on a user gesture, off by default ----
  function Snd(on) { this.on = !!on; this.ac = null; }
  Snd.prototype.ensure = function () {
    if (!this.on) return;
    if (!this.ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ac = new AC(); } catch (e) { this.ac = null; return; }
    }
    if (this.ac.state === 'suspended') { try { this.ac.resume(); } catch (e) {} }
  };
  Snd.prototype.tone = function (f, dur, type, vol, slide, delay) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      var t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };
  function sfx(kind) {
    if (!S) return;
    var s = S.snd;
    if (kind === 'key') s.tone(660 + Math.random() * 60, 0.04, 'triangle', 0.03);
    else if (kind === 'clear') s.tone(330, 0.05, 'triangle', 0.025);
    else if (kind === 'clash') { s.tone(160, 0.12, 'square', 0.025); s.tone(150, 0.12, 'square', 0.02, 0, 0.05); }
    else if (kind === 'hint') { s.tone(880, 0.08, 'sine', 0.04); s.tone(1320, 0.12, 'sine', 0.035, 0, 0.07); }
    else if (kind === 'ok') { s.tone(784, 0.07, 'sine', 0.035); s.tone(1047, 0.1, 'sine', 0.03, 0, 0.06); }
    else if (kind === 'bad') s.tone(220, 0.18, 'sawtooth', 0.025, 140);
    else if (kind === 'win') [523, 659, 784, 1047, 1319].forEach(function (f, i) { s.tone(f, 0.16, 'triangle', 0.04, 0, i * 0.09); });
    else if (kind === 'tick') s.tone(988, 0.05, 'sine', 0.03);
  }

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_MENU = svg('<path d="M4 7h16M4 12h16M4 17h16"/>');

  // ---- persistence ----
  function loadPrefs() {
    var o = readJSON(K_PREFS) || {};
    return {
      diff: DIFF_IDS.indexOf(o.diff) >= 0 ? o.diff : 'medium',
      freq: o.freq !== false,
      seen: Array.isArray(o.seen) ? o.seen.filter(function (n) { return n === (n | 0) && n >= 0; }).slice(-250) : [],
      helped: !!o.helped
    };
  }
  function savePrefs() { if (S) sset(K_PREFS, JSON.stringify(S.prefs)); }
  function saveStats() { if (S) sset(K_STATS, JSON.stringify(S.stats)); }
  function slotKey(desc) { return desc.kind === 'daily' ? K_DAILY : desc.kind === 'note' ? K_NOTE : K_PLAY; }
  function saveGame() {
    if (!S || !S.puz) return;
    syncClock();
    var g = S.game, o = { desc: S.puz.desc, g: g.g, hints: g.hints, checks: g.checks, wrong: g.wrong, t: Math.round(g.t), done: g.done, score: g.score, at: Date.now() };
    sset(slotKey(S.puz.desc), JSON.stringify(o));
  }
  // A saved slot → { puz, game } (or null when it's unusable / from another day).
  function loadSlot(k) {
    var o = readJSON(k);
    if (!o || !quotes) return null;
    var desc = normDesc(o.desc, quotes);
    if (!desc) return null;
    if (desc.kind === 'daily') {
      var fresh = dailyDesc(quotes, desc.date);
      if (fresh.qi !== desc.qi || fresh.seed !== desc.seed) return null;   // quote book changed: not the same puzzle
    }
    var puz = buildPuzzle(desc, quotes);
    return { puz: puz, game: normGame(o, puz), at: +o.at || 0 };
  }
  // The most recently touched unfinished practice or note puzzle (null if none).
  function latestUnfinished(skipKind) {
    var a = skipKind === 'practice' ? null : loadSlot(K_PLAY), b = skipKind === 'note' ? null : loadSlot(K_NOTE);
    if (a && (a.game.done || a.puz.desc.kind !== 'practice')) a = null;
    if (b && (b.game.done || b.puz.desc.kind !== 'note')) b = null;
    return a && b ? (b.at > a.at ? b : a) : a || b;
  }

  // ---- the clock: runs while a puzzle is on screen, unpaused, visible ----
  function clockShouldRun() {
    return !!S && S.phase === 'play' && !S.paused && !S.game.done && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)) && S.panel.isConnected;
  }
  function syncClock() {
    if (!S || !S.game) return;
    var t = now();
    if (S.runSince) { S.game.t += t - S.runSince; S.runSince = 0; }
    if (clockShouldRun()) S.runSince = t;
  }
  function elapsed() { if (!S || !S.game) return 0; return S.game.t + (S.runSince ? now() - S.runSince : 0); }
  function paintTime() {
    if (!S || !S.timeEl) return;
    var txt = fmtTime(elapsed() / 1000);
    if (S.timeEl.textContent !== txt) S.timeEl.textContent = txt;
  }

  // ---- layout of the board ----
  // cells: one per letter in reading order: { c (cipher), el, a (author line) }
  function buildBoard() {
    var puz = S.puz, html = '', idx = 0;
    S.cells = [];
    function line(ctext, cls) {
      var words = ctext.split(' '), h = '<div class="' + cls + '">';
      if (cls === 'cg-auth' && ctext) h += '<span class="cg-w cg-dash"><span class="cg-p">&mdash;</span></span>';
      words.forEach(function (w) {
        if (!w) return;
        h += '<span class="cg-w">';
        for (var i = 0; i < w.length; i++) {
          var ch = w[i];
          if (isL(ch)) {
            h += '<span class="cg-c" data-i="' + idx + '" data-c="' + ch + '"><b class="cg-g"></b><i class="cg-k">' + ch + '</i></span>';
            S.cells.push({ c: ch, a: cls === 'cg-auth' });
            idx++;
          } else h += '<span class="cg-p">' + esc(ch) + '</span>';
        }
        h += '</span>';
      });
      return h + '</div>';
    }
    html = line(puz.ctext, 'cg-text') + (puz.cauthor ? line(puz.cauthor, 'cg-auth') : '');
    S.board.innerHTML = html;
    var els = S.board.querySelectorAll('.cg-c');
    for (var i = 0; i < els.length; i++) S.cells[i].el = els[i];
    // the frequency strip: commonest cipher letters first
    var fl = puz.letters.slice().sort(function (a, b) { return puz.freq[b] - puz.freq[a] || (a < b ? -1 : 1); });
    S.freqEl.innerHTML = '<span class="cg-fh" title="How often each cipher letter appears. In English the commonest letters are E T A O I N S H R">freq</span>' +
      fl.map(function (c) {
        return '<button type="button" class="cg-f" data-f="' + c + '" title="' + c + ' appears ' + puz.freq[c] + ' time' + (puz.freq[c] > 1 ? 's' : '') + '"><i>' + c + '</i><b></b><small>' + puz.freq[c] + '</small></button>';
      }).join('');
    S.freqBtns = {};
    var fb = S.freqEl.querySelectorAll('.cg-f');
    for (i = 0; i < fb.length; i++) S.freqBtns[fb[i].getAttribute('data-f')] = fb[i];
  }

  function selCipher() { var c = S.cells[S.sel]; return c ? c.c : null; }
  function paint() {
    if (!S || !S.puz) return;
    var puz = S.puz, g = S.game, conf = conflicts(puz, g), sc = selCipher(), done = g.done, i;
    for (i = 0; i < S.cells.length; i++) {
      var cell = S.cells[i], c = cell.c, el = cell.el, p = g.g[c] || '';
      var gb = el.firstChild;
      if (gb.textContent !== p) gb.textContent = p;
      el.className = 'cg-c' + (locked(puz, g, c) ? ' given' : '') + (conf[c] ? ' bad' : '') + (g.wrong[c] ? ' wrong' : '') +
        (!done && c === sc ? ' sel' : '') + (!done && i === S.sel ? ' cur' : '') + (p ? ' has' : '') + (done ? ' solved' : '');
    }
    for (var fc in S.freqBtns) {
      var b = S.freqBtns[fc], gp = g.g[fc] || '';
      b.lastChild.previousSibling.textContent = gp || '·';
      b.className = 'cg-f' + (gp ? ' has' : '') + (conf[fc] ? ' bad' : '') + (locked(puz, g, fc) ? ' given' : '') + (!done && fc === sc ? ' on' : '');
    }
    // keyboard: letters already used dim; the selected cipher letter's guess lights up
    var used = {};
    for (var gc in g.g) if (puz.freq[gc]) used[g.g[gc]] = (used[g.g[gc]] || 0) + 1;
    var curP = sc ? g.g[sc] : '';
    for (var k in S.keys) {
      var kb = S.keys[k];
      kb.className = 'cg-key' + (used[k] ? ' used' : '') + (used[k] > 1 ? ' dup' : '') + (k === curP && !done ? ' on' : '');
    }
    var lk = sc && locked(puz, g, sc);
    S.root.classList.toggle('cg-lk', !!lk);
    // bar
    var f = filled(puz, g);
    S.progEl.textContent = f + '/' + puz.letters.length;
    S.hintsEl.textContent = g.hints.length ? g.hints.length + (g.hints.length > 1 ? ' hints' : ' hint') : '';
    S.root.classList.toggle('cg-done', !!done);
    S.root.classList.toggle('cg-nofreq', !S.prefs.freq);
    var hb = S.acts.querySelector('[data-a="hint"]'), cb = S.acts.querySelector('[data-a="check"]');
    if (hb) hb.disabled = done; if (cb) cb.disabled = done || !f;
    syncHead();
  }
  function scrollSel() {
    var c = S.cells[S.sel];
    if (!c || !c.el) return;
    var wrap = S.boardWrap, r = c.el.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    if (r.top < w.top + 4) wrap.scrollTop -= (w.top - r.top) + 10;
    else if (r.bottom > w.bottom - 4) wrap.scrollTop += (r.bottom - w.bottom) + 10;
  }

  // ---- moves ----
  function movable(i) { var c = S.cells[i]; return !!c && !locked(S.puz, S.game, c.c); }
  function step(dir, wantEmpty) {
    var n = S.cells.length;
    if (!n) return;
    for (var k = 1; k <= n; k++) {
      var i = ((S.sel + dir * k) % n + n) % n;
      if (!movable(i)) continue;
      if (wantEmpty && S.game.g[S.cells[i].c]) continue;
      S.sel = i; return true;
    }
    if (wantEmpty) return step(dir, false);
    return false;
  }
  function selectCell(i) {
    if (!S || !S.cells[i]) return;
    S.sel = i;
    paint(); scrollSel();
  }
  function selectCipher(c) {
    for (var i = 0; i < S.cells.length; i++) if (S.cells[i].c === c) { selectCell(i); return; }
  }
  function flash(c, cls) {
    S.cells.forEach(function (cell) {
      if (cell.c !== c) return;
      cell.el.classList.remove(cls);
      void cell.el.offsetWidth;
      cell.el.classList.add(cls);
    });
  }
  function typeLetter(p) {
    if (!S || !S.puz || S.game.done || S.phase !== 'play' || S.paused) return;
    var c = selCipher();
    if (!c) return;
    if (locked(S.puz, S.game, c)) { step(1, true); paint(); scrollSel(); return; }
    if (S.game.g[c] === p) { step(1, true); paint(); scrollSel(); return; }
    assign(S.puz, S.game, c, p);
    var conf = conflicts(S.puz, S.game);
    if (conf[c]) {
      sfx('clash');
      if (conf[c] === 'self' && !S.toldSelf) { S.toldSelf = true; toast('No letter stands for itself in this cipher', 'info', 2200); }
    } else sfx('key');
    flash(c, 'pop');
    if (!afterChange()) { step(1, true); paint(); scrollSel(); }
  }
  function clearLetter(back) {
    if (!S || !S.puz || S.game.done || S.phase !== 'play' || S.paused) return;
    var c = selCipher();
    if (c && S.game.g[c] && !locked(S.puz, S.game, c)) { assign(S.puz, S.game, c, null); sfx('clear'); }
    else if (back) { step(-1, false); }
    afterChange(); paint(); scrollSel();
  }
  // Returns true when the change solved it.
  function afterChange() {
    syncClock();
    if (finish(S.puz, S.game)) { S.runSince = 0; win(); return true; }
    saveGame();
    if (filled(S.puz, S.game) === S.puz.letters.length && !Object.keys(conflicts(S.puz, S.game)).length && !S.toldFull) {
      S.toldFull = true;
      setMsg('Every letter is filled but something is off. Try Check.', 'warn');
    }
    return false;
  }
  function doHint() {
    if (!S || !S.puz || S.game.done) return;
    var c = hint(S.puz, S.game, selCipher());
    if (!c) return;
    sfx('hint'); Cade.haptic && Cade.haptic(10);
    flash(c, 'reveal');
    setMsg('Revealed ' + c + ' = ' + S.puz.sol[c] + ' (−' + HINT_COST + ')', '');
    if (!afterChange()) { if (selCipher() === c) step(1, true); paint(); scrollSel(); }
  }
  function doCheck() {
    if (!S || !S.puz || S.game.done || !filled(S.puz, S.game)) return;
    var n = check(S.puz, S.game);
    if (n) {
      sfx('bad'); Cade.haptic && Cade.haptic(25);
      setMsg(n + ' wrong letter' + (n > 1 ? 's' : '') + ' marked (−' + CHECK_COST + ')', 'bad');
      Object.keys(S.game.wrong).forEach(function (c) { flash(c, 'shake'); });
    } else { sfx('ok'); setMsg('All ' + filled(S.puz, S.game) + ' letters so far are right (−' + CHECK_COST + ')', 'ok'); }
    saveGame(); paint();
  }
  function setMsg(t, kind) {
    if (!S) return;
    clearTimeout(S.msgT);
    S.msgEl.textContent = t;
    S.msgEl.className = 'cg-msg' + (kind ? ' ' + kind : '') + (t ? ' on' : '');
    if (t) S.msgT = setTimeout(function () { if (S) S.msgEl.className = 'cg-msg'; }, 2600);
  }

  // ---- phases ----
  function startPuzzle(puz, game, fresh) {
    syncClock();
    S.puz = puz; S.game = game || newGame(puz);
    S.root.classList.remove('cg-cascade');
    clearTimeout(S.winT);
    S.phase = 'play'; S.paused = false; S.runSince = 0; S.toldFull = false; S.lastWin = null;
    buildBoard();
    S.sel = 0;
    if (!movable(0) || S.game.g[S.cells[0].c]) step(1, true);
    if (fresh) {
      recordStart(S.stats, puz.desc); saveStats();
      if (puz.desc.kind === 'practice' && puz.desc.qi != null) {
        S.prefs.seen.push(puz.desc.qi); S.prefs.seen = S.prefs.seen.slice(-250); savePrefs();
      }
    }
    var d = puz.desc;
    S.modeEl.textContent = d.kind === 'daily' ? 'Daily · ' + prettyDate(d.date) : d.kind === 'note' ? 'From your note' : 'Practice';
    S.diffEl.textContent = DIFFS[d.diff].name;
    S.diffEl.className = 'cg-tag d-' + d.diff;
    hideCard();
    S.boardWrap.scrollTop = 0;
    if (S.game.done) { S.phase = 'done'; paint(); showCard('result'); return; }
    saveGame(); paint(); syncClock(); paintTime();
    setMsg(puz.given.length ? puz.given.length + ' letter' + (puz.given.length > 1 ? 's are' : ' is') + ' given away' : '', '');
  }
  function win() {
    syncClock();
    S.phase = 'done';
    var info = recordSolve(S.stats, S.puz, S.game);
    S.lastWin = info;
    saveStats(); saveGame();
    paint();
    sfx('win'); Cade.haptic && Cade.haptic([12, 40, 12]);
    // cascade: every cell flips into place in reading order
    S.cells.forEach(function (cell, i) { cell.el.style.setProperty('--d', Math.min(i * 22, 1400) + 'ms'); });
    S.root.classList.add('cg-cascade');
    clearTimeout(S.winT);
    S.winT = setTimeout(function () { if (S && S.phase === 'done') showCard('result'); }, Math.min(S.cells.length * 22, 1400) + 650);
  }
  function playDaily() {
    var td = today(), slot = loadSlot(K_DAILY);
    if (slot && slot.puz.desc.date === td) { startPuzzle(slot.puz, slot.game, false); return; }
    var desc = dailyDesc(quotes, td), puz = buildPuzzle(desc, quotes);
    startPuzzle(puz, null, true);
  }
  function playPractice(diff, cont) {
    if (cont) { var slot = latestUnfinished(S.puz && !S.game.done && S.phase === 'menu-play' ? S.puz.desc.kind : ''); if (slot) { startPuzzle(slot.puz, slot.game, false); return; } }
    var desc = practiceDesc(quotes, diff || S.prefs.diff, Math.random, S.prefs.seen);
    startPuzzle(buildPuzzle(desc, quotes), null, true);
  }
  function playNote(text) {
    var desc = noteDesc(text, (Math.random() * 4294967296) >>> 0);
    startPuzzle(buildPuzzle(desc, quotes), null, true);
  }
  function noteSource() {
    var out = { text: '', cursor: -1, sel: '' };
    try {
      var ed = Cade.editor;
      if (ed && ed.state) {
        out.text = ed.state.doc.toString();
        var m = ed.state.selection && ed.state.selection.main;
        if (m) { out.cursor = m.head; if (m.from !== m.to) out.sel = ed.state.sliceDoc(m.from, m.to); }
      }
    } catch (e) {}
    return out;
  }
  function pause() {
    if (!S || S.phase !== 'play' || S.paused) return;
    syncClock(); S.paused = true; syncClock(); saveGame();
    showCard('pause'); syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false; hideCard(); syncClock(); paint(); syncHead();
  }
  function toMenu() {
    syncClock();
    if (S.phase === 'play') { saveGame(); S.phase = 'menu-play'; }
    S.paused = false;
    showCard('menu');
  }

  // ---- cards ----
  function hideCard() { S.ovl.style.display = 'none'; S.ovl.innerHTML = ''; S.cardKind = null; S.root.classList.remove('cg-dim', 'cg-hide'); }
  function title(t) { return '<div class="cg-title">' + esc(t) + '</div>'; }
  function statsTable() {
    var st = S.stats, rows = '<b>         played solved  best time  best</b>\n';
    DIFF_IDS.concat('note').forEach(function (d) {
      var x = st.diff[d];
      if (d === 'note' && !x.played) return;
      rows += padR(DIFFS[d].name, 8) + padL(x.played, 7) + padL(x.solved, 7) + padL(x.bestT ? fmtTime(x.bestT) : '-', 11) + padL(x.bestS || '-', 6) + '\n';
    });
    return '<pre class="cg-tab">' + rows.replace(/\n$/, '') + '</pre>';
  }
  function padR(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function padL(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }
  function showCard(kind) {
    syncClock();
    S.cardKind = kind;
    var h = '', td = today();
    if (kind === 'menu') {
      var st = S.stats, streak = liveStreak(st, td), dd = st.daily.days[td], dslot = loadSlot(K_DAILY);
      var dState = dd ? '<span class="ok">solved ' + fmtTime(dd.t) + ' · ' + dd.s + ' pts</span>' :
        dslot && dslot.puz.desc.date === td && (filled(dslot.puz, dslot.game) > dslot.puz.given.length || dslot.game.t > 3000) ? 'in progress · ' + fmtTime(dslot.game.t / 1000) : DIFFS[dailyDiff(td)].name.toLowerCase() + ' today';
      var onBoard = S.puz && !S.game.done && S.phase === 'menu-play';
      var cont = latestUnfinished(onBoard ? S.puz.desc.kind : '');   // not the one already on the board
      h = title('CRYPTOGRAM') +
        '<pre class="cg-art">' + esc('Q XZQ BC LYQ RCMSA\n= A WAY IN THE WORDS') + '</pre>' +
        '<p class="cg-sub">Every letter of a famous quote is swapped for another. Crack the code.</p>' +
        (onBoard ? '<button type="button" class="cg-go" data-act="back">Back to the puzzle <small>' + esc(S.modeEl.textContent) + '</small></button>' : '') +
        '<button type="button" class="cg-go' + (onBoard ? ' alt' : '') + '" data-act="daily">' + (dd ? 'See today’s daily' : 'Play today’s daily') + ' <small>' + dState + '</small></button>' +
        '<div class="cg-row"><span class="cg-h">streak</span><span class="cg-streak">' + (streak ? '★ ' + streak + ' day' + (streak > 1 ? 's' : '') : 'none yet') + '</span><span class="cg-faint">best ' + st.daily.best + '</span></div>' +
        '<div class="cg-sec"><div class="cg-h">practice</div><div class="cg-chips">' +
        DIFF_IDS.map(function (d) {
          var D = DIFFS[d];
          return '<button type="button" class="cg-chip' + (S.prefs.diff === d ? ' on' : '') + '" data-diff="' + d + '">' + D.name +
            ' <i>' + (D.reveal ? D.reveal + ' given' : 'long') + '</i></button>';
        }).join('') + '</div>' +
        '<div class="cg-btns"><button type="button" class="cg-go" data-act="new">New ' + DIFFS[S.prefs.diff].name.toLowerCase() + ' puzzle</button>' +
        (cont ? '<button type="button" class="cg-go alt" data-act="cont">Continue <small>' + DIFFS[cont.puz.desc.diff].name + ' · ' + fmtTime(cont.game.t / 1000) + '</small></button>' : '') +
        '</div></div>' +
        '<button type="button" class="cg-go alt" data-act="note">From my note <small>encode a sentence you wrote</small></button>' +
        '<div class="cg-sec"><div class="cg-h">records</div>' + statsTable() + '</div>' +
        '<div class="cg-foot"><button type="button" class="cg-lnk" data-act="help">How to play</button>' +
        '<button type="button" class="cg-lnk" data-act="freq">' + (S.prefs.freq ? 'Hide' : 'Show') + ' frequency strip</button></div>';
    } else if (kind === 'help') {
      h = title('HOW TO PLAY') +
        '<p>A famous quote has been put through a <b>letter-swap cipher</b>: each letter always becomes the same other letter (and never itself). Work out the swap.</p>' +
        '<div class="cg-keys">' +
        '<span><b>Tap a letter</b> in the puzzle (the small grey one is the cipher), then <b>tap a key</b> or type what you think it stands for. Every copy fills in.</span>' +
        '<span><b>freq</b> counts each cipher letter: in English the commonest are <b>E T A O I N S H R</b>.</span>' +
        '<span>Red letters <b>clash</b>: two cipher letters given the same answer.</span>' +
        '<span><b>Check</b> marks wrong letters (−' + CHECK_COST + '). <b>Hint</b> reveals the selected letter (−' + HINT_COST + ').</span>' +
        '<span>Short words help: one-letter words are A or I; THE, AND, OF, TO, IS are everywhere; an apostrophe-S is often S.</span>' +
        '</div>' +
        '<div class="cg-keys"><span><b>Keyboard:</b> A–Z guess · Backspace / Space clear · ← → move · Tab next blank · Esc pause</span></div>' +
        '<p class="cg-tip">Score: easy ' + DIFFS.easy.base + ', medium ' + DIFFS.medium.base + ', hard ' + DIFFS.hard.base + ' + a speed bonus, minus hints and checks. The daily is the same for everyone on a date (easy Sundays, hard Fri/Sat).</p>' +
        '<button type="button" class="cg-go" data-act="close-help">Got it</button>';
    } else if (kind === 'pause') {
      h = title('PAUSED') + '<div class="cg-big">' + fmtTime(elapsed() / 1000) + '</div>' +
        '<p class="cg-sub">' + filled(S.puz, S.game) + ' of ' + S.puz.letters.length + ' letters placed</p>' +
        '<div class="cg-btns"><button type="button" class="cg-go" data-act="resume">Resume</button><button type="button" class="cg-go alt" data-act="menu">Menu</button></div>';
    } else if (kind === 'result') {
      var g = S.game, puz = S.puz, d = puz.desc, info = S.lastWin || {}, q = d.kind === 'note' ? { text: puz.text, author: '' } : parseQuote(quotes[d.qi]);
      var sd = S.stats.diff[d.diff];
      h = title('SOLVED') +
        '<blockquote class="cg-quote">“' + esc(q.text) + '”' + (q.author ? '<cite>— ' + esc(q.author) + '</cite>' : '') + '</blockquote>' +
        '<div class="cg-res"><div><span>time</span><b>' + fmtTime(g.t / 1000) + '</b></div><div><span>score</span><b class="acc">' + g.score + '</b></div>' +
        '<div><span>hints</span><b>' + g.hints.length + '</b></div><div><span>checks</span><b>' + g.checks + '</b></div></div>' +
        (info.bestS ? '<div class="cg-new">NEW BEST SCORE (' + DIFFS[d.diff].name.toLowerCase() + ')</div>' : info.bestT ? '<div class="cg-new">NEW BEST TIME</div>' : '') +
        (d.kind === 'daily' ? '<div class="cg-note">daily streak ★ ' + liveStreak(S.stats, td) + ' · best ' + S.stats.daily.best + '</div>' : '') +
        '<div class="cg-note">' + DIFFS[d.diff].name + ' best ' + (sd.bestT ? fmtTime(sd.bestT) : '-') + ' · ' + (sd.bestS || '-') + ' pts</div>' +
        '<div class="cg-btns">' +
        (d.kind === 'daily' ? '<button type="button" class="cg-go" data-act="new">Practice puzzle</button>' :
          d.kind === 'note' ? '<button type="button" class="cg-go" data-act="note">Another from my note</button>' :
            '<button type="button" class="cg-go" data-act="new">Next ' + DIFFS[d.diff].name.toLowerCase() + '</button>') +
        '<button type="button" class="cg-go alt" data-act="menu">Menu</button></div>' +
        '<div class="cg-foot"><button type="button" class="cg-lnk" data-act="share">Copy result</button><button type="button" class="cg-lnk" data-act="view">View board</button></div>';
    } else if (kind === 'note') {
      var src = noteSource(), cands = noteCandidates(src.text);
      if (!S.noteText) S.noteText = pickNoteSentence(src.text, src.cursor, src.sel, Math.random);
      var has = !!S.noteText;
      h = title('FROM MY NOTE') +
        (has ? '<p>Found a sentence ' + (src.sel ? 'in your selection' : 'in the open note') + ' (' + letters(S.noteText).length + ' letters). Encode it without peeking, or write your own.</p>' +
          '<div class="cg-btns"><button type="button" class="cg-go" data-act="note-go">Encode it</button>' +
          (cands.length > 1 ? '<button type="button" class="cg-go alt" data-act="note-other">Another one</button>' : '') + '</div>'
          : '<p>' + (Cade.editor ? 'No sentence in the open note is long enough (at least 14 letters, 7 different ones).' : 'The note editor isn’t available here.') + ' Type or paste one:</p>') +
        '<div class="cg-sec"><div class="cg-h">' + (has ? 'or type your own' : 'your sentence') + '</div>' +
        '<textarea class="cg-ta" rows="3" maxlength="240" placeholder="A sentence of at least 14 letters…" spellcheck="false"></textarea>' +
        '<button type="button" class="cg-go' + (has ? ' alt' : '') + '" data-act="note-own">Encode my sentence</button></div>' +
        '<div class="cg-foot"><button type="button" class="cg-lnk" data-act="menu">Back</button></div>';
    }
    S.ovl.innerHTML = '<div class="cg-card cg-card-' + kind + '">' + h + '</div>';
    S.ovl.style.display = '';
    S.ovl.scrollTop = 0;
    S.root.classList.add('cg-dim');
    S.root.classList.toggle('cg-hide', kind === 'pause' || ((kind === 'menu' || kind === 'help' || kind === 'note') && S.phase !== 'done' && !!S.puz && !S.game.done));
    syncClock(); syncHead();
    var first = S.ovl.querySelector('.cg-go');
    if (first && !S.coarse && kind !== 'note') { try { first.focus({ preventScroll: true }); } catch (e) {} }
  }

  function onCardClick(e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !S) return;
    S.snd.ensure();
    var act = b.getAttribute('data-act'), diff = b.getAttribute('data-diff');
    if (diff) { S.prefs.diff = diff; savePrefs(); sfx('tick'); showCard('menu'); var nb = S.ovl.querySelector('[data-diff="' + diff + '"]'); if (nb && e.detail === 0) nb.focus(); return; }
    if (act === 'daily') playDaily();
    else if (act === 'new') playPractice(S.puz && S.puz.desc.kind === 'practice' && S.cardKind === 'result' ? S.puz.desc.diff : S.prefs.diff, false);
    else if (act === 'cont') playPractice(null, true);
    else if (act === 'back') { S.phase = 'play'; S.paused = false; hideCard(); syncClock(); paint(); }
    else if (act === 'note') { S.noteText = ''; showCard('note'); }
    else if (act === 'note-go') { var t = S.noteText; S.noteText = ''; playNote(t); }
    else if (act === 'note-other') {
      var src = noteSource(), c = noteCandidates(src.text).filter(function (x) { return x !== S.noteText; });
      if (c.length) S.noteText = c[Math.floor(Math.random() * c.length)];
      sfx('tick'); showCard('note');
    } else if (act === 'note-own') {
      var ta = S.ovl.querySelector('.cg-ta'), v = ta ? plainText(ta.value) : '';
      if (letters(v).length < 14 || distinctCount(v) < 7) { toast('Needs at least 14 letters (7 different ones)', 'info', 2200); if (ta) ta.focus(); return; }
      S.noteText = ''; playNote(trimSentence(v, 240));
    }
    else if (act === 'help') showCard('help');
    else if (act === 'close-help') {
      if (!S.prefs.helped) { S.prefs.helped = true; savePrefs(); }
      if (S.helpFrom === 'play') { S.helpFrom = ''; S.phase = 'play'; hideCard(); syncClock(); paint(); }
      else showCard('menu');
    }
    else if (act === 'freq') { S.prefs.freq = !S.prefs.freq; savePrefs(); paint(); showCard('menu'); }
    else if (act === 'resume') resume();
    else if (act === 'menu') { S.paused = false; if (S.phase === 'play') S.phase = 'menu-play'; showCard('menu'); }
    else if (act === 'view') { hideCard(); paint(); }
    else if (act === 'share') {
      var txt = shareText(S.puz, S.game);
      try {
        navigator.clipboard.writeText(txt).then(function () { toast('Copied', 'success', 1400); }, function () { toast(txt, 'info', 4000); });
      } catch (er) { toast(txt, 'info', 4000); }
    }
  }

  // ---- header (help / sound / pause) ----
  function syncHead() {
    if (!S) return;
    var sb = S.head.querySelector('[data-h="sound"]'), pb = S.head.querySelector('[data-h="pause"]');
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.classList.toggle('on', S.snd.on);
    sb.title = S.snd.on ? 'Sound on' : 'Sound off'; sb.setAttribute('aria-label', sb.title);
    var canP = S.phase === 'play';
    pb.disabled = !canP;
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.title = S.paused ? 'Resume' : 'Pause'; pb.setAttribute('aria-label', pb.title);
  }

  // ---- keyboard capture (like Word Guess: a press inside arms it, elsewhere disarms) ----
  function setActive(on) {
    if (!S || S.active === on) return;
    S.active = on;
    S.panel.classList.toggle('cg-idle', !on);
    if (on) blurEditor();
  }
  function blurEditor() { try { if (Cade.editor && Cade.editor.hasFocus) Cade.editor.contentDOM.blur(); } catch (e) {} }
  function onDocPointer(e) { if (S) setActive(S.panel.contains(e.target)); }
  function onDocFocus(e) {
    if (!S || S.panel.contains(e.target)) return;
    if (Date.now() - S.openedAt < 600) { blurEditor(); return; }
    setActive(false);
  }
  function onKey(e) {
    if (!S || !S.active) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
      if (e.key === 'Escape' && S.panel.contains(t)) { e.preventDefault(); t.blur(); }
      return;   // real typing (the note box) stays untouched
    }
    var ae = document.activeElement;
    if (ae && ae !== document.body && !S.panel.contains(ae) && ae.isContentEditable) return;
    var k = e.key, handled = true;
    if (S.cardKind) {
      if (k === 'Escape') {
        if (S.cardKind === 'pause') resume();
        else if (S.cardKind === 'help' || S.cardKind === 'note') { if (S.helpFrom === 'play') { S.helpFrom = ''; S.phase = 'play'; hideCard(); syncClock(); paint(); } else showCard('menu'); }
        else if (S.cardKind === 'menu' && S.phase === 'menu-play') { S.phase = 'play'; hideCard(); syncClock(); paint(); }
        else if (S.cardKind === 'result') { hideCard(); paint(); }
        else handled = false;
      } else if (S.cardKind === 'pause' && (k === ' ' || k === 'Enter')) resume();
      else handled = false;
    } else if (S.phase === 'done') {
      if (k === 'Enter' || k === ' ' || k === 'Escape') showCard('result'); else handled = false;
    } else if (S.phase !== 'play') handled = false;
    else if (/^[a-zA-Z]$/.test(k)) typeLetter(k.toUpperCase());
    else if (k === 'Backspace') clearLetter(true);
    else if (k === 'Delete' || k === ' ') clearLetter(false);
    else if (k === 'ArrowRight' || k === 'ArrowDown') { step(1, false); paint(); scrollSel(); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp') { step(-1, false); paint(); scrollSel(); }
    else if (k === 'Tab') { step(e.shiftKey ? -1 : 1, true); paint(); scrollSel(); }
    else if (k === 'Escape') pause();
    else if (k === '?') doHint();
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S;
    syncClock(); if (s.puz) saveGame();
    S = null;
    clearInterval(s.tick); clearTimeout(s.msgT); clearTimeout(s.winT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('pointerdown', s.onDocPointer, true);
    document.removeEventListener('focusin', s.onDocFocus, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('pagehide', s.onHide);
    window.removeEventListener('blur', s.onBlur);
    s.snd.close();
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
  }

  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var kb = KB_ROWS.map(function (row) {
      return '<div class="cg-kr">' + row.split('').map(function (ch) {
        if (ch === '<') return '<button type="button" class="cg-key cg-nav" data-nav="-1" aria-label="Previous letter">←</button>';
        if (ch === '>') return '<button type="button" class="cg-key cg-nav" data-nav="1" aria-label="Next letter">→</button>';
        return '<button type="button" class="cg-key" data-k="' + ch + '">' + ch + '</button>';
      }).join('') + '</div>';
    }).join('');
    var body = '<div class="cg">' +
      '<div class="cg-bar"><span class="cg-mode"></span><span class="cg-tag"></span><span class="cg-prog"></span><span class="cg-hints"></span>' +
      '<button type="button" class="cg-time" title="Pause">0:00</button></div>' +
      '<div class="cg-stage"><div class="cg-bw"><div class="cg-board"></div></div><div class="cg-msg"></div></div>' +
      '<div class="cg-freq"></div>' +
      '<div class="cg-acts">' +
      '<button type="button" class="cg-act" data-a="hint" title="Reveal the selected letter (−' + HINT_COST + ')">Hint</button>' +
      '<button type="button" class="cg-act" data-a="check" title="Mark wrong letters (−' + CHECK_COST + ')">Check</button>' +
      '<button type="button" class="cg-act" data-a="clear" title="Clear the selected letter">Clear</button>' +
      '<button type="button" class="cg-act alt" data-a="menu" title="Menu">' + IC_MENU + '<span>Menu</span></button></div>' +
      '<div class="cg-kb">' + kb + '</div>' +
      '<div class="cg-ovl" style="display:none"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🔐 Cryptogram', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'cg-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-sharebtn') || p.querySelector('.cade-panel-popbtn') || p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia;
    S = {
      panel: p, head: hb, root: p.querySelector('.cg'), board: p.querySelector('.cg-board'), boardWrap: p.querySelector('.cg-bw'),
      ovl: p.querySelector('.cg-ovl'), freqEl: p.querySelector('.cg-freq'), acts: p.querySelector('.cg-acts'), kb: p.querySelector('.cg-kb'),
      msgEl: p.querySelector('.cg-msg'), timeEl: p.querySelector('.cg-time'), modeEl: p.querySelector('.cg-mode'), diffEl: p.querySelector('.cg-tag'),
      progEl: p.querySelector('.cg-prog'), hintsEl: p.querySelector('.cg-hints'),
      snd: new Snd(sget(K_SOUND) === '1'), prefs: loadPrefs(), stats: normStats(readJSON(K_STATS)),
      coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'loading', paused: false, puz: null, game: null, cells: [], sel: 0, keys: {}, freqBtns: {}, runSince: 0,
      active: true, openedAt: Date.now(), cardKind: null, noteText: '', helpFrom: ''
    };
    var kbs = S.kb.querySelectorAll('[data-k]');
    for (var i = 0; i < kbs.length; i++) S.keys[kbs[i].getAttribute('data-k')] = kbs[i];
    p._onClose = teardown;
    blurEditor();

    S.onKey = onKey; S.onDocPointer = onDocPointer; S.onDocFocus = onDocFocus;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('pointerdown', S.onDocPointer, true);
    document.addEventListener('focusin', S.onDocFocus, true);
    S.onVis = function () { if (!S) return; if (document.hidden) { pause(); } syncClock(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onHide = function () { if (S) { syncClock(); saveGame(); } };
    window.addEventListener('pagehide', S.onHide);
    // switching to another app: stop the clock (the pause card hides the board)
    S.onBlur = function () { if (S && S.panel.isConnected && !(Cade.isMinimized && Cade.isMinimized(S.panel))) pause(); };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) { pause(); syncClock(); setActive(false); } });
    p.addEventListener('cade-panel-restore', function () { if (S && S.panel === p) { setActive(true); syncClock(); } });
    S.tick = setInterval(function () { if (S && S.panel.isConnected) paintTime(); else if (S) teardown(); }, 250);

    // Fast taps must never zoom, select, magnify or open a callout; the panel
    // swallows gesture / dblclick, the board and keys cancel their touches.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    [S.board, S.kb, S.freqEl, S.acts].forEach(function (el) {
      var t0 = null;
      el.addEventListener('touchstart', function (e) {
        if (e.touches.length > 1) { noTouch(e); t0 = null; return; }
        var t = e.touches[0]; t0 = { x: t.clientX, y: t.clientY };
      }, { passive: false });
      el.addEventListener('touchend', function (e) {
        var b = e.target.closest && e.target.closest('.cg-c, button');
        if (!b) return;
        noTouch(e);
        var t = e.changedTouches && e.changedTouches[0];
        if (!t0 || !t || Math.abs(t.clientX - t0.x) > 12 || Math.abs(t.clientY - t0.y) > 12) return;   // a scroll, not a tap
        t0 = null;
        if (!b.disabled) b.click();   // the click a cancelled touchend would have produced
      }, { passive: false });
    });
    // buttons and cells never take focus away from the panel on mouse press (no selection either)
    p.addEventListener('mousedown', function (e) {
      if (e.target.closest && (e.target.closest('.cade-panel-head') || e.target.closest('textarea'))) return;
      e.preventDefault();
    });
    p.addEventListener('contextmenu', function (e) { if (!(e.target.closest && e.target.closest('textarea'))) e.preventDefault(); });

    S.board.addEventListener('click', function (e) {
      var c = e.target.closest ? e.target.closest('.cg-c') : null;
      if (!c || !S || S.phase !== 'play' || S.paused || S.cardKind) return;
      S.snd.ensure();
      var i = +c.getAttribute('data-i');
      selectCell(i);
      if (locked(S.puz, S.game, S.cells[i].c)) setMsg('That letter is given', '');
    });
    S.freqEl.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-f]') : null;
      if (!b || !S || S.phase !== 'play' || S.paused || S.cardKind) return;
      S.snd.ensure(); selectCipher(b.getAttribute('data-f'));
    });
    S.kb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      S.snd.ensure();
      if (S.cardKind || S.phase !== 'play') return;
      var k = b.getAttribute('data-k'), nav = b.getAttribute('data-nav');
      if (k) typeLetter(k);
      else if (nav) { step(+nav, false); paint(); scrollSel(); }
    });
    S.acts.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S || b.disabled) return;
      S.snd.ensure();
      var a = b.getAttribute('data-a');
      if (a === 'menu') { if (S.cardKind === 'menu') { if (S.phase === 'menu-play') { S.phase = 'play'; hideCard(); syncClock(); paint(); } } else toMenu(); return; }
      if (S.cardKind || S.phase !== 'play') return;
      if (a === 'hint') doHint();
      else if (a === 'check') doCheck();
      else if (a === 'clear') clearLetter(false);
    });
    S.timeEl.addEventListener('click', function () { if (!S) return; if (S.paused) resume(); else pause(); });
    S.ovl.addEventListener('click', onCardClick);

    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(K_SOUND, S.snd.on ? '1' : '0');
        S.snd.ensure(); sfx('tick');
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') {
        if (S.cardKind === 'help') { if (S.helpFrom === 'play') { S.helpFrom = ''; S.phase = 'play'; hideCard(); syncClock(); paint(); } else showCard('menu'); }
        else if (S.phase === 'play' && !S.cardKind) { S.helpFrom = 'play'; S.phase = 'menu-play'; showCard('help'); }
        else if (S.cardKind !== 'pause' && S.phase !== 'loading') showCard('help');
      }
      try { b.blur(); } catch (er) {}
    });
    syncHead();

    S.ovl.innerHTML = '<div class="cg-card"><div class="cg-title">CRYPTOGRAM</div><p class="cg-sub">Opening the quote book…</p></div>';
    S.ovl.style.display = '';
    loadQuotes().then(function () {
      if (!S || S.panel !== p) return;
      S.phase = 'menu';
      // Pick up where you left off: an unfinished daily from today, else an unfinished practice, else the menu.
      var td = today(), ds = loadSlot(K_DAILY), ps = latestUnfinished();
      if (!S.prefs.helped) showCard('help');
      else if (ds && ds.puz.desc.date === td && !ds.game.done && (filled(ds.puz, ds.game) > ds.puz.given.length)) { startPuzzle(ds.puz, ds.game, false); pause(); }
      else if (ps && !ps.game.done && filled(ps.puz, ps.game) > ps.puz.given.length) { startPuzzle(ps.puz, ps.game, false); pause(); }
      else showCard('menu');
    }, function () {
      if (!S || S.panel !== p) return;
      S.ovl.innerHTML = '<div class="cg-card"><div class="cg-title">CRYPTOGRAM</div><p class="cg-sub">Couldn’t load the quote book (offline before it was cached?).</p></div>';
    });
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Crack a famous quote hidden behind a letter-swap cipher — daily puzzle, hints, timer',
    icon: '🔐',
    tags: 'game,puzzle,word,cipher,cryptogram,quote,decode,daily',
    open: open,
    _engine: ENGINE
  });
})();
