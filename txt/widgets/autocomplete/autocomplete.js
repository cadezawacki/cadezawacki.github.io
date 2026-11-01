/* Finish the Phrase — an autocomplete showdown, for Cade.txt.
 * The start of a saying, idiom, proverb, famous public-domain line or everyday
 * phrase appears; type how it continues. Answers are scored fuzzily: the text is
 * normalised (case, accents, punctuation, apostrophes, a few spellings), then
 * compared word by word (an in-order match first, typos forgiven by edit
 * distance, out-of-order words for part credit, little words weigh less) and as
 * a whole string — so a near miss earns partial credit and a typo barely costs.
 * The real ending is shown with the words you got highlighted.
 * Modes: Solo (10 prompts, easy → hard, speed bonus and streaks), Daily (the
 * same 10 for everyone on a date), vs CPU (a bot, "Predicto", that guesses with
 * a level-based accuracy and sometimes says something silly) and Party (2-5
 * players, pass-and-play with a privacy screen between turns).
 * Phrases live in autocomplete-data.js (loaded on first open, precached).
 * Records persist in Cade.store (cade-autocomplete-*). Offline; typing works
 * normally (the panel never blocks the text input). */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var CATS = [
    { id: 'p', name: 'Proverbs', tag: 'proverb' },
    { id: 'i', name: 'Idioms', tag: 'idiom' },
    { id: 'q', name: 'Famous lines', tag: 'famous line' },
    { id: 's', name: 'Science', tag: 'science' },
    { id: 'h', name: 'History', tag: 'history' },
    { id: 'e', name: 'Everyday', tag: 'everyday' }
  ];
  var CAT = {};
  for (var ci0 = 0; ci0 < CATS.length; ci0++) CAT[CATS[ci0].id] = CATS[ci0];
  var CAT_IDS = CATS.map(function (c) { return c.id; });
  var DIFFS = [
    { id: 'easy', name: 'Easy', d: [1] },
    { id: 'mixed', name: 'Mixed', d: [1, 2] },
    { id: 'hard', name: 'Hard', d: [2, 3] },
    { id: 'all', name: 'Any', d: [1, 2, 3] }
  ];
  var DIFF = {};
  for (var di0 = 0; di0 < DIFFS.length; di0++) DIFF[DIFFS[di0].id] = DIFFS[di0];
  // The bot: chance of the right ending / a near one (the rest are wrong, often silly),
  // and how long it "thinks" (s). Harder phrases lower its odds.
  var CPU_LEVELS = [
    { id: 'easy', name: 'Easy', exact: 0.3, close: 0.3, think: [3.5, 7] },
    { id: 'medium', name: 'Medium', exact: 0.52, close: 0.28, think: [2.5, 5] },
    { id: 'hard', name: 'Hard', exact: 0.78, close: 0.15, think: [1.5, 3.5] }
  ];
  var CPU = {};
  for (var li0 = 0; li0 < CPU_LEVELS.length; li0++) CPU[CPU_LEVELS[li0].id] = CPU_LEVELS[li0];
  var CPU_NAME = 'Predicto';
  var ROUND_N = 10, PARTY_ROUNDS = [3, 5, 8, 10], MAX_PLAYERS = 5, RECENT_MAX = 150;
  var VERDICTS = [
    { id: 'perfect', min: 0.9, name: 'PERFECT', glyph: '#' },
    { id: 'close', min: 0.7, name: 'SO CLOSE', glyph: '+' },
    { id: 'partial', min: 0.4, name: 'PARTIAL', glyph: '~' },
    { id: 'stretch', min: 0.15, name: 'A STRETCH', glyph: '.' },
    { id: 'miss', min: -1, name: 'MISS', glyph: 'x' }
  ];
  var STREAK_AT = 0.7;   // an answer this good keeps a streak alive

  // Silly endings the bot falls back on when it has no idea. Original, harmless.
  var SILLY = [
    'is a dish best served with fries', 'and that is why I do not own a goat', 'is what my grandma always said',
    'gets the last slice of pizza', 'probably', 'is none of your business', 'was the password all along',
    'and then it rained', 'is mostly vibes', 'eats spaghetti with a spoon', 'is basically a sandwich',
    'but only on Tuesdays', 'wins a free toaster', 'for science', 'is my middle name', 'and a partridge in a pear tree',
    'asked the duck', 'makes the dog sneeze', 'with extra cheese', 'while juggling', 'on a unicycle',
    'is basically soup', 'with a side of regret', 'unless it is Monday', 'and the llama agrees',
    'beep boop does not compute', 'is hiding under the couch', 'said the lighthouse keeper', 'in the year 3000',
    'smells faintly of toast', 'and nobody asked', 'is a very good boy', 'until the batteries run out',
    'tastes like purple', 'and the pigeons know it'
  ];

  var SPELL = {
    colour: 'color', colours: 'colors', favour: 'favor', favours: 'favors', neighbour: 'neighbor', neighbours: 'neighbors',
    valour: 'valor', honour: 'honor', cruellest: 'cruelest', spilt: 'spilled', kilometres: 'kilometers', kilometre: 'kilometer',
    centre: 'center', theatre: 'theater', grey: 'gray', cannot: 'cant', til: 'till', ok: 'okay', km: 'kilometers',
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
    eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
    nineteen: '19', twenty: '20'
  };
  var TENS = { thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90' };
  var TENS_WORD = { twenty: 1, thirty: 1, forty: 1, fifty: 1, sixty: 1, seventy: 1, eighty: 1, ninety: 1 };
  var STOP = {};
  ('a an the of to and or in on at is it its be by for as with that this my your our their his her i you we they ' +
   'will shall are was not but so do than then there from up me us him them am has have').split(' ').forEach(function (w) { STOP[w] = 1; });
  var STOP_W = 0.25;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // seeded PRNG (mulberry32) and a string hash, so rounds are reproducible
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    var h = 2166136261;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return h >>> 0;
  }
  function shuffle(a, r) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // ---- data ----
  // "cat|difficulty|start|ending[~accepted variant...]" → phrase objects (bad lines skipped).
  function parseData(lines) {
    var out = [];
    (lines || []).forEach(function (l, i) {
      if (typeof l !== 'string') return;
      var f = l.split('|');
      if (f.length !== 4 || !CAT[f[0]]) return;
      var d = +f[1], ends = f[3].split('~').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!(d >= 1 && d <= 3) || !f[2].trim() || !ends.length) return;
      out.push({ id: i, cat: f[0], d: d, start: f[2].trim(), end: ends[0], alts: ends });
    });
    return out;
  }
  function wordCount(s) { return String(s).split(/\s+/).filter(Boolean).length; }

  // ---- text normalisation ----
  function normWord(s) {
    s = String(s == null ? '' : s).toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.replace(/[‘’ʼ`'´]/g, '').replace(/&/g, ' and ').replace(/%/g, ' percent ').replace(/(\d)[,.](?=\d)/g, '$1').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function tokens(s) {
    var n = normWord(s);
    if (!n) return [];
    var t = n.split(' ').map(function (w) { return SPELL[w] || w; }), out = [];
    // "ninety nine" → 99, "three hundred" → 300 (both sides are normalised the same way)
    for (var i = 0; i < t.length; i++) {
      var w = TENS[t[i]] || t[i], prev = out[out.length - 1];
      if (/^[1-9]$/.test(w) && i > 0 && TENS_WORD[n.split(' ')[i - 1]]) { out[out.length - 1] = String(+prev + +w); continue; }
      if (w === 'hundred' && /^[1-9]$/.test(prev || '')) { out[out.length - 1] = prev + '00'; continue; }
      out.push(w);
    }
    return out;
  }
  function norm(s) { return tokens(s).join(' '); }

  // optimal string alignment distance (Levenshtein + adjacent transpositions)
  function lev(a, b) {
    var n = a.length, m = b.length, i, j;
    if (!n) return m;
    if (!m) return n;
    var pp = new Array(m + 1), p = new Array(m + 1), c = new Array(m + 1);
    for (j = 0; j <= m; j++) p[j] = j;
    for (i = 1; i <= n; i++) {
      c[0] = i;
      for (j = 1; j <= m; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        var v = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + cost);
        if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) v = Math.min(v, pp[j - 2] + 1);
        c[j] = v;
      }
      var t = pp; pp = p; p = c; c = t;
    }
    return p[m];
  }
  // How much a typed word counts for a target word: 1 exact, a bit less with a typo, 0 if different.
  function wordCredit(a, b) {
    if (a === b) return 1;
    var L = Math.max(a.length, b.length);
    if (L <= 3 || /^\d+$/.test(a) || /^\d+$/.test(b)) return 0;
    var tol = L <= 4 ? 1 : L <= 6 ? 1 : L <= 9 ? 2 : 3;
    if (L === 4 && a.charAt(0) !== b.charAt(0)) return 0;   // cake ≠ bake
    var d = lev(a, b);
    return d <= tol ? 1 - 0.3 * d / L : 0;
  }
  function wt(t) { return STOP[t] ? STOP_W : 1; }

  // Display words of a text, each with its normalised tokens (one word may hold two: "ninety-nine").
  function splitWords(s) {
    var words = [], toks = [], owner = [];
    String(s).split(/\s+/).filter(Boolean).forEach(function (w) {
      var tk = tokens(w), wi = words.length;
      words.push(w);
      for (var k = 0; k < tk.length; k++) { toks.push(tk[k]); owner.push(wi); }
    });
    return { words: words, toks: toks, owner: owner };
  }

  // Score one typed answer against one accepted ending.
  function gradeOne(T, A) {
    var n = T.length, m = A.length, i, j;
    var tHit = new Array(n).fill(0), aHit = new Array(m).fill(0);
    if (!n || !m) return { score: 0, tHit: tHit, aHit: aHit };
    if (T.join(' ') === A.join(' ')) return { score: 1, tHit: tHit.fill(1), aHit: aHit.fill(1) };
    // weighted LCS with fuzzy word equality (order matters most)
    var dp = [], cr = [];
    for (i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)); cr.push(new Array(m + 1).fill(0)); }
    for (i = 1; i <= n; i++) for (j = 1; j <= m; j++) {
      var c = wordCredit(T[i - 1], A[j - 1]);
      cr[i][j] = c;
      var best = Math.max(dp[i - 1][j], dp[i][j - 1]);
      if (c > 0) best = Math.max(best, dp[i - 1][j - 1] + c * wt(T[i - 1]));
      dp[i][j] = best;
    }
    var credit = 0;
    i = n; j = m;
    while (i > 0 && j > 0) {
      var cc = cr[i][j];
      if (cc > 0 && Math.abs(dp[i][j] - (dp[i - 1][j - 1] + cc * wt(T[i - 1]))) < 1e-9) {
        tHit[i - 1] = 1; aHit[j - 1] = 1; credit += cc * wt(T[i - 1]); i--; j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
      else j--;
    }
    // the right words in the wrong order still earn something
    for (i = 0; i < n; i++) {
      if (tHit[i]) continue;
      for (j = 0; j < m; j++) {
        if (aHit[j]) continue;
        var c2 = wordCredit(T[i], A[j]);
        if (c2 > 0) { tHit[i] = 0.5; aHit[j] = 1; credit += c2 * 0.6 * wt(T[i]); break; }
      }
    }
    var tw = 0, aw = 0, am = 0;
    for (i = 0; i < n; i++) tw += wt(T[i]);
    for (j = 0; j < m; j++) { aw += wt(A[j]); if (aHit[j]) am += wt(A[j]); }
    var recall = credit / tw, precision = aw ? am / aw : 0;
    var tok = recall * (0.7 + 0.3 * precision);
    // a word salad must not farm points: unmatched words beyond a small allowance cut the score
    var extra = aw - am, allow = Math.max(2, tw);
    if (extra > allow) tok *= Math.max(0.15, 1 - 0.5 * (extra - allow) / (tw + 2));
    // and as one string, which forgives split / joined words ("bed bugs" / "bedbugs")
    var ja = A.join(''), jt = T.join('');
    var ch = 1 - lev(ja, jt) / Math.max(ja.length, jt.length);
    var useCh = ja === jt || (ch >= 0.85 && jt.length >= 7);   // for split / joined words, not for a swapped word
    var score = Math.max(tok, useCh ? ch : 0);
    if (useCh && ch > tok) {   // credit the words the string match implies
      for (i = 0; i < n; i++) if (!tHit[i] && ja.indexOf(T[i]) >= 0) tHit[i] = 1;
      for (j = 0; j < m; j++) if (!aHit[j] && jt.indexOf(A[j]) >= 0) aHit[j] = 1;
    }
    return { score: clamp(score, 0, 1), tHit: tHit, aHit: aHit };
  }

  function verdictOf(score) {
    for (var i = 0; i < VERDICTS.length; i++) if (score >= VERDICTS[i].min) return VERDICTS[i];
    return VERDICTS[VERDICTS.length - 1];
  }
  // accuracy points for a score (0..100); a hint halves them
  function basePts(score, hint) {
    var p = score >= 0.9 ? 100 : score >= 0.15 ? Math.round(score * 85) : 0;
    return hint ? Math.round(p / 2) : p;
  }

  // Grade an answer for a phrase: best accepted ending, words to highlight on both sides.
  // If the player retyped the start of the phrase too, that part is set aside.
  function grade(ph, answer) {
    var aw = splitWords(answer || ''), P = tokens(ph.start), skip = 0;
    var A = aw.toks;
    var E0 = tokens(ph.end), Aj = A.join(' ');
    for (var q = 0; q < ph.alts.length && P.length; q++) if (Aj === P.concat(tokens(ph.alts[q])).join(' ')) { skip = P.length; break; }   // the whole phrase, retyped
    for (var k = skip ? 0 : Math.min(P.length, A.length - 1); k >= 1; k--) {      // "...penny saved is a penny earned"
      var tail = P.slice(P.length - k).join(' ');
      if (A.slice(0, k).join(' ') === tail && E0.slice(0, k).join(' ') !== tail) { skip = k; break; }
    }
    if (!skip && P.length && A.length >= P.length && A.slice(0, P.length).join(' ') === P.join(' ') &&
        E0.slice(0, P.length).join(' ') !== P.join(' ')) skip = P.length;   // the whole start retyped (maybe nothing more)
    if (!skip && A.length >= 2 && A.length < P.length && P.slice(P.length - A.length).join(' ') === A.join(' ') &&
        E0.slice(0, A.length).join(' ') !== A.join(' ')) skip = A.length;   // only the end of the start, echoed back
    var Au = A.slice(skip), best = null;
    for (var a = 0; a < ph.alts.length; a++) {
      var tw = splitWords(ph.alts[a]);
      var r = gradeOne(tw.toks, Au);
      if (!best || r.score > best.r.score + 1e-9) best = { r: r, tw: tw, alt: a };
      if (r.score >= 1) break;
    }
    var r0 = best.r, tw0 = best.tw;
    // shown ending is the matched variant if it was one, else the main one
    var endWords = tw0.words.map(function () { return 0; });
    for (var t = 0; t < tw0.toks.length; t++) endWords[tw0.owner[t]] = Math.max(endWords[tw0.owner[t]], r0.tHit[t] || 0);
    var ansWords = aw.words.map(function () { return 0; });
    for (var u = 0; u < aw.toks.length; u++) {
      var w = aw.owner[u];
      if (u < skip) { if (!ansWords[w]) ansWords[w] = -1; }   // echoed prompt
      else if (r0.aHit[u - skip]) ansWords[w] = 1;
    }
    var score = Math.round(r0.score * 100) / 100, v = verdictOf(score);
    return {
      score: score, verdict: v.id, label: v.name, alt: best.alt, ending: ph.alts[best.alt],
      endWords: tw0.words.map(function (w, i) { return { w: w, hit: endWords[i] >= 0.99 ? 1 : endWords[i] > 0 ? 0.5 : 0 }; }),
      ansWords: aw.words.map(function (w, i) { return { w: w, hit: ansWords[i] }; })
    };
  }

  // "is a penny earned" → "is a p____ e_____": first word whole, then initials (one word: initial only).
  function hintText(ph) {
    var w = ph.end.split(/\s+/).filter(Boolean);
    function mask(s) {
      var out = '', seen = false;
      for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        if (/[A-Za-z0-9]/.test(ch)) { out += seen ? '_' : ch; seen = true; } else out += ch;
      }
      return out;
    }
    if (w.length === 1) return mask(w[0]);
    return w.map(function (s, i) { return i === 0 ? s : mask(s); }).join(' ');
  }

  // seconds allowed for a phrase in timed play (longer endings get longer)
  function timeLimit(ph) { return clamp(Math.round(15 + ph.end.length * 0.4 + (ph.d - 1) * 3), 18, 45); }

  // Solo scoring: accuracy + speed bonus (up to 30) + streak bonus (+10 per streak step, max 50).
  // `streak` is the streak including this answer.
  function soloPoints(score, o) {
    o = o || {};
    var base = basePts(score, o.hint);
    var frac = o.limit ? clamp((o.limit - (o.time || 0)) / o.limit, 0, 1) : 0;
    var speed = base > 0 ? Math.round(30 * score * frac * (o.hint ? 0.5 : 1)) : 0;
    var streak = score >= STREAK_AT && (o.streak || 0) >= 2 ? Math.min(50, (o.streak - 1) * 10) : 0;
    return { base: base, speed: speed, streak: streak, total: base + speed + streak };
  }

  // ---- picking prompts ----
  function poolOf(phrases, opt) {
    opt = opt || {};
    var ds = (DIFF[opt.diff] || DIFF.mixed).d, cats = opt.cats && opt.cats.length ? opt.cats : CAT_IDS;
    return phrases.filter(function (p) { return ds.indexOf(p.d) >= 0 && cats.indexOf(p.cat) >= 0; });
  }
  // n phrases (ids), fresh ones first (not in `recent`), ordered easy → hard
  function pickRound(phrases, opt, r, n, recent) {
    var pool = poolOf(phrases, opt);
    if (pool.length < n) pool = poolOf(phrases, { diff: 'all', cats: opt && opt.cats });
    if (pool.length < n) pool = phrases.slice();
    var rec = {};
    (recent || []).forEach(function (id) { rec[id] = 1; });
    var fresh = shuffle(pool.filter(function (p) { return !rec[p.id]; }), r);
    var old = shuffle(pool.filter(function (p) { return rec[p.id]; }), r);
    var pick = fresh.concat(old).slice(0, n);
    pick.sort(function (a, b) { return a.d - b.d; });
    return pick.map(function (p) { return p.id; });
  }
  function dateKey(d) {
    d = d || new Date();
    function z(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
  }
  // the same 10 for everyone on a date (all categories, easy → hard)
  function dailyRound(phrases, key) {
    var r = rng(hashStr('ftp-daily-' + key));
    var d1 = shuffle(phrases.filter(function (p) { return p.d === 1; }), r).slice(0, 4);
    var d2 = shuffle(phrases.filter(function (p) { return p.d === 2; }), r).slice(0, 4);
    var d3 = shuffle(phrases.filter(function (p) { return p.d === 3; }), r).slice(0, 2);
    return d1.concat(d2, d3).map(function (p) { return p.id; });
  }

  // ---- the bot ----
  function typo(w, r) {
    if (w.length < 4) return w;
    var i = 2 + Math.floor(r() * (w.length - 3));   // keeps the first letter
    return w.slice(0, i - 1) + w.charAt(i) + w.charAt(i - 1) + w.slice(i + 1);
  }
  function contentIdx(words) {
    var out = [];
    words.forEach(function (w, i) { var t = tokens(w); if (t.length && !STOP[t[0]]) out.push(i); });
    return out;
  }
  // The bot's answer for a phrase: { text, kind: exact|typo|close|wrong|silly|blank, think }.
  function cpuGuess(ph, level, r, phrases) {
    var L = CPU[level] || CPU.medium, f = [1, 0.85, 0.62][ph.d - 1] || 1;
    var think = L.think[0] + r() * (L.think[1] - L.think[0]);
    var x = r(), words = ph.end.split(/\s+/).filter(Boolean);
    if (x < L.exact * f) {
      if (r() < (level === 'hard' ? 0.08 : 0.25)) {
        var ci = contentIdx(words);
        if (ci.length) {
          var k = ci[Math.floor(r() * ci.length)], tw = words.slice();
          tw[k] = typo(tw[k], r);
          if (tw[k] !== words[k]) return { text: tw.join(' '), kind: 'typo', think: think };
        }
      }
      return { text: ph.end, kind: 'exact', think: think };
    }
    var others = phrases && phrases.length > 1 ? phrases : null;
    function other() {
      for (var g = 0; g < 8 && others; g++) {
        var o = others[Math.floor(r() * others.length)];
        if (o.id !== ph.id && norm(o.end) !== norm(ph.end)) return o;
      }
      return null;
    }
    if (x < L.exact * f + L.close) {
      var cw = words.slice(), ci2 = contentIdx(cw);
      if (cw.length >= 4 && r() < 0.5) {   // runs out of steam
        return { text: cw.slice(0, Math.max(2, Math.round(cw.length * 0.6))).join(' ') + '...', kind: 'close', think: think };
      }
      if (cw.length >= 2 && ci2.length) {   // swaps a word for one from another phrase
        var o1 = other(), ow = o1 ? contentIdx(o1.end.split(/\s+/)).map(function (i) { return o1.end.split(/\s+/)[i]; }) : [];
        var k2 = ci2[Math.floor(r() * ci2.length)];
        cw[k2] = ow.length ? ow[Math.floor(r() * ow.length)] : typo(typo(cw[k2], r), r);
        return { text: cw.join(' '), kind: 'close', think: think };
      }
      var w1 = cw[0] || '';   // one word: a heavier typo
      var t1 = typo(w1, r), t2 = t1.length > 4 ? t1.slice(0, -1) : t1 + 's';
      return { text: t2, kind: 'close', think: think };
    }
    var y = r();
    if (y < 0.08) return { text: '', kind: 'blank', think: think + 1.5 };
    if (y < 0.6) { var o2 = other(); if (o2) return { text: o2.end, kind: 'wrong', think: think }; }
    return { text: SILLY[Math.floor(r() * SILLY.length)], kind: 'silly', think: think };
  }

  // ---- saves ----
  function nnum(v, d) { v = +v; return isFinite(v) && v >= 0 ? v : (d || 0); }
  function newSave() {
    var cat = {}, cpu = {};
    CAT_IDS.forEach(function (c) { cat[c] = { n: 0, s: 0 }; });
    CPU_LEVELS.forEach(function (l) { cpu[l.id] = { w: 0, l: 0, d: 0 }; });
    return {
      v: 1,
      solo: { games: 0, best: 0, bestStreak: 0, perfects: 0, answered: 0, acc: 0, last: [] },
      daily: { date: '', score: 0, best: 0, played: 0, streak: 0 },
      cpu: cpu, party: { games: 0 }, cat: cat, recent: []
    };
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    var so = o.solo || {};
    ['games', 'best', 'bestStreak', 'perfects', 'answered', 'acc'].forEach(function (k) { s.solo[k] = nnum(so[k]); });
    if (Array.isArray(so.last)) s.solo.last = so.last.map(function (v) { return nnum(v); }).slice(-10);
    var dl = o.daily || {};
    s.daily.date = typeof dl.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(dl.date) ? dl.date : '';
    ['score', 'best', 'played', 'streak'].forEach(function (k) { s.daily[k] = nnum(dl[k]); });
    CPU_LEVELS.forEach(function (l) {
      var c = o.cpu && o.cpu[l.id] || {};
      s.cpu[l.id] = { w: nnum(c.w), l: nnum(c.l), d: nnum(c.d) };
    });
    s.party.games = nnum(o.party && o.party.games);
    CAT_IDS.forEach(function (c) {
      var x = o.cat && o.cat[c] || {};
      s.cat[c] = { n: nnum(x.n), s: Math.min(nnum(x.s), nnum(x.n)) };
    });
    if (Array.isArray(o.recent)) s.recent = o.recent.filter(function (v) { return typeof v === 'number' && v >= 0 && v === Math.floor(v); }).slice(-RECENT_MAX);
    return s;
  }
  function newSetup() {
    return { mode: 'solo', diff: 'mixed', cats: CAT_IDS.slice(), cpu: 'medium', n: 2, names: ['', '', '', '', ''], rounds: 5, timer: true };
  }
  function normSetup(o) {
    var s = newSetup();
    if (!o || typeof o !== 'object') return s;
    if (['solo', 'daily', 'cpu', 'party'].indexOf(o.mode) >= 0) s.mode = o.mode;
    if (DIFF[o.diff]) s.diff = o.diff;
    if (Array.isArray(o.cats)) {
      var c = CAT_IDS.filter(function (id) { return o.cats.indexOf(id) >= 0; });
      if (c.length) s.cats = c;
    }
    if (CPU[o.cpu]) s.cpu = o.cpu;
    s.n = clamp(Math.round(+o.n) || 2, 2, MAX_PLAYERS);
    if (Array.isArray(o.names)) for (var i = 0; i < MAX_PLAYERS; i++) s.names[i] = typeof o.names[i] === 'string' ? o.names[i].slice(0, 14) : '';
    if (PARTY_ROUNDS.indexOf(+o.rounds) >= 0) s.rounds = +o.rounds;
    s.timer = o.timer !== false;
    return s;
  }
  function remember(save, ids) {
    save.recent = save.recent.concat(ids).slice(-RECENT_MAX);
  }
  function addCat(save, ph, score) {
    var c = save.cat[ph.cat];
    if (c) { c.n++; c.s += clamp(score, 0, 1); }
  }
  // Fold a finished solo / daily round into the save. r: { score, bestStreak, perfects, answered, acc, daily, date }
  // Returns what got beaten.
  function settleSolo(save, r) {
    var out = { best: false, streak: false, daily: false, dailyFirst: false };
    var so = save.solo;
    so.games++; so.answered += r.answered; so.perfects += r.perfects; so.acc += r.acc;
    so.last = so.last.concat([r.score]).slice(-10);
    if (r.score > so.best) { out.best = so.best > 0 || so.games > 1 || r.score > 0; so.best = r.score; }
    if (r.bestStreak > so.bestStreak) { out.streak = r.bestStreak >= 3; so.bestStreak = r.bestStreak; }
    if (r.daily && r.date) {
      var d = save.daily;
      if (d.date !== r.date) {
        var prev = new Date(r.date + 'T12:00:00'); prev.setDate(prev.getDate() - 1);
        d.streak = d.date === dateKey(prev) ? d.streak + 1 : 1;
        d.date = r.date; d.score = r.score; d.played++; out.dailyFirst = true;
      } else if (r.score > d.score) d.score = r.score;
      if (r.score > d.best) { out.daily = true; d.best = r.score; }
    }
    return out;
  }
  // vs the bot: 'w' | 'l' | 'd'
  function settleCpu(save, level, mine, bot) {
    var res = mine > bot ? 'w' : mine < bot ? 'l' : 'd';
    var c = save.cpu[level] || save.cpu.medium;
    c[res]++;
    return res;
  }
  // final standings: [{ i, score, rank }] best first; ties share a rank
  function standings(players) {
    var list = players.map(function (p, i) { return { i: i, score: p.score, perfects: p.perfects || 0 }; });
    list.sort(function (a, b) { return b.score - a.score || b.perfects - a.perfects || a.i - b.i; });
    for (var k = 0; k < list.length; k++) {
      var prev = list[k - 1];
      list[k].rank = prev && prev.score === list[k].score && prev.perfects === list[k].perfects ? prev.rank : k + 1;
    }
    return list;
  }
  // order players answer in on prompt q (the first seat rotates so nobody always goes first)
  function turnOrder(n, q) {
    var o = [];
    for (var i = 0; i < n; i++) o.push((q + i) % n);
    return o;
  }

  var ENGINE = {
    CATS: CATS, DIFFS: DIFFS, CPU_LEVELS: CPU_LEVELS, VERDICTS: VERDICTS, SILLY: SILLY, ROUND_N: ROUND_N,
    PARTY_ROUNDS: PARTY_ROUNDS, MAX_PLAYERS: MAX_PLAYERS, CPU_NAME: CPU_NAME, STREAK_AT: STREAK_AT,
    rng: rng, hashStr: hashStr, shuffle: shuffle, parseData: parseData, wordCount: wordCount,
    tokens: tokens, norm: norm, lev: lev, wordCredit: wordCredit, splitWords: splitWords, gradeOne: gradeOne, grade: grade,
    verdictOf: verdictOf, basePts: basePts, hintText: hintText, timeLimit: timeLimit, soloPoints: soloPoints,
    poolOf: poolOf, pickRound: pickRound, dateKey: dateKey, dailyRound: dailyRound, cpuGuess: cpuGuess,
    newSave: newSave, normSave: normSave, newSetup: newSetup, normSetup: normSetup, remember: remember, addCat: addCat,
    settleSolo: settleSolo, settleCpu: settleCpu, standings: standings, turnOrder: turnOrder
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('autocomplete.css');
  var DATA_URL = Cade.asset('autocomplete-data.js');   // resolve now, while the module folder is known

  var PANEL_ID = 'autocomplete-panel', NAME = 'Finish the Phrase';
  var KEY = 'cade-autocomplete-', SAVE_KEY = KEY + 'save', SETUP_KEY = KEY + 'setup', SOUND_KEY = KEY + 'sound';
  var PHRASES = null, BY_ID = {}, loading = null;
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.autocomplete = { live: function () { return S; } };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadJSON(k) { var raw = sget(k); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function persistSetup() { if (S) sset(SETUP_KEY, JSON.stringify(S.setup)); }

  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function fmtInt(n) {
    n = Math.round(n);
    var s = String(Math.abs(n)), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }
  function pct(x) { return Math.round(clamp(x, 0, 1) * 100) + '%'; }
  function meter(score, n) {
    n = n || 10;
    var k = Math.round(clamp(score, 0, 1) * n);
    return '[<b>' + new Array(k + 1).join('#') + '</b><i>' + new Array(n - k + 1).join('-') + '</i>]';
  }

  function load() {
    if (PHRASES) return Promise.resolve();
    function take(d) { PHRASES = parseData(d.p); PHRASES.forEach(function (p) { BY_ID[p.id] = p; }); }
    if (window.__cadeAutocompleteData && window.__cadeAutocompleteData.p) { take(window.__cadeAutocompleteData); return Promise.resolve(); }
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = DATA_URL; s.async = true;
      s.onload = function () {
        if (window.__cadeAutocompleteData && window.__cadeAutocompleteData.p) { take(window.__cadeAutocompleteData); resolve(); }
        else { loading = null; reject(new Error('no data')); }
      };
      s.onerror = function () { loading = null; s.remove(); reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  // ---- sound: a tiny WebAudio voice, created on a user gesture (iOS), closed with the panel ----
  function Snd(on) { this.on = !!on; this.ac = null; this.lastTick = 0; }
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
  Snd.prototype.key = function () {   // typewriter tick, throttled
    var t = now();
    if (t - this.lastTick < 45) return;
    this.lastTick = t;
    this.tone(1900 + Math.random() * 500, 0.018, 'square', 0.008);
  };
  Snd.prototype.verdict = function (v) {
    if (v === 'perfect') { this.tone(659, 0.09, 'triangle', 0.05); this.tone(880, 0.09, 'triangle', 0.05, 0, 0.08); this.tone(1319, 0.2, 'triangle', 0.05, 0, 0.16); }
    else if (v === 'close') { this.tone(587, 0.1, 'triangle', 0.045); this.tone(784, 0.16, 'triangle', 0.045, 0, 0.09); }
    else if (v === 'partial') { this.tone(523, 0.14, 'triangle', 0.04); }
    else if (v === 'stretch') { this.tone(392, 0.16, 'sine', 0.04, 330); }
    else this.tone(196, 0.26, 'sawtooth', 0.03, 120);
  };
  Snd.prototype.fanfare = function () {
    var n = [523, 659, 784, 1047];
    for (var i = 0; i < n.length; i++) this.tone(n[i], 0.16, 'triangle', 0.05, 0, i * 0.11);
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');

  // ---- small view helpers ----
  function playerName(i) {
    var g = S.g, p = g && g.players[i];
    return p ? p.name : '';
  }
  function chip(attr, label, on, extra) {
    return '<button type="button" class="ac-chip' + (on ? ' on' : '') + '" ' + attr + ' aria-pressed="' + (on ? 'true' : 'false') + '">' + label + (extra || '') + '</button>';
  }
  function wordsHtml(list, kind) {
    return list.map(function (x) {
      var c = kind === 'end' ? (x.hit >= 1 ? 'hit' : x.hit > 0 ? 'half' : 'miss') : (x.hit > 0 ? 'hit' : x.hit < 0 ? 'echo' : 'miss');
      return '<span class="' + c + '">' + esc(x.w) + '</span>';
    }).join(' ');
  }
  function diffStars(d) { return '<span class="ac-stars" title="' + ['easy', 'medium', 'hard'][d - 1] + '">' + new Array(d + 1).join('*') + '<i>' + new Array(4 - d).join('*') + '</i></span>'; }

  // ---- screens ----
  // A card fills the stage (menus, results, privacy screens) and hides the play area.
  function showCard(kind) {
    S.cardKind = kind;
    S.stage.classList.add('carded');
    S.ovl.style.display = '';
    S.ovl.innerHTML = cardHtml(kind);
    S.ovl.scrollTop = 0;
    syncHead(); syncBar();
  }
  function hideCard() {
    S.cardKind = null;
    S.stage.classList.remove('carded');
    S.ovl.style.display = 'none';
    S.ovl.innerHTML = '';
  }

  function homeHtml() {
    var st = S.setup, sv = S.save, m = st.mode, h = '';
    h += '<div class="ac-title">FINISH THE PHRASE</div>';
    h += '<pre class="ac-art" aria-hidden="true">' + esc(S.artLine || '') + '</pre>';
    h += '<div class="ac-tabs" role="tablist">' + [['solo', 'Solo'], ['daily', 'Daily'], ['cpu', 'vs CPU'], ['party', 'Party']].map(function (t) {
      return '<button type="button" role="tab" data-mode="' + t[0] + '" class="' + (m === t[0] ? 'on' : '') + '" aria-selected="' + (m === t[0]) + '">' + t[1] + '</button>';
    }).join('') + '</div>';
    if (m === 'solo') {
      h += '<p>' + ROUND_N + ' phrases, easy to hard. Type the rest of each one &mdash; points for accuracy, a <b>speed bonus</b> and <b>streaks</b>.</p>';
    } else if (m === 'daily') {
      var dk = dateKey(), d = sv.daily;
      h += '<p>The same ' + ROUND_N + ' phrases for everyone today (' + esc(dk) + '). Speed and streaks count.</p>';
      h += '<div class="ac-kv"><span>today</span><b>' + (d.date === dk ? fmtInt(d.score) : '&mdash;') + '</b><span>best ever</span><b>' + fmtInt(d.best) + '</b><span>day streak</span><b>' + (d.date === dk || d.date === dateKey(new Date(Date.now() - 864e5)) ? d.streak : 0) + '</b></div>';
    } else if (m === 'cpu') {
      h += '<p>You and <b>' + CPU_NAME + '</b> the bot answer the same ' + ROUND_N + ' phrases. It is good&hellip; mostly.</p>';
      h += '<div class="ac-sec"><div class="ac-h">' + CPU_NAME + '</div><div class="ac-chips">' + CPU_LEVELS.map(function (l) {
        var r = sv.cpu[l.id];
        return chip('data-cpu="' + l.id + '"', l.name, st.cpu === l.id, ' <i>' + r.w + '-' + r.l + (r.d ? '-' + r.d : '') + '</i>');
      }).join('') + '</div></div>';
    } else {
      h += '<p>Pass-and-play for 2&ndash;' + MAX_PLAYERS + '. Everyone answers the same phrase in turn (answers stay hidden), then all are revealed.</p>';
      h += '<div class="ac-sec"><div class="ac-h">players</div><div class="ac-chips">';
      for (var n = 2; n <= MAX_PLAYERS; n++) h += chip('data-n="' + n + '"', String(n), st.n === n);
      h += '</div><div class="ac-names">';
      for (var i = 0; i < st.n; i++) {
        h += '<input class="ac-name" data-name="' + i + '" type="text" maxlength="14" autocomplete="off" autocapitalize="words" spellcheck="false" placeholder="Player ' + (i + 1) + '" value="' + esc(st.names[i] || '') + '" aria-label="Player ' + (i + 1) + ' name">';
      }
      h += '</div></div>';
      h += '<div class="ac-sec"><div class="ac-h">phrases each</div><div class="ac-chips">' + PARTY_ROUNDS.map(function (r) { return chip('data-rounds="' + r + '"', String(r), st.rounds === r); }).join('') +
        chip('data-timer="1"', 'Timer ' + (st.timer ? 'on' : 'off'), st.timer) + '</div></div>';
    }
    if (m !== 'daily') {
      h += '<div class="ac-sec"><div class="ac-h">difficulty</div><div class="ac-chips">' + DIFFS.map(function (d) { return chip('data-diff="' + d.id + '"', d.name, st.diff === d.id); }).join('') + '</div></div>';
      h += '<div class="ac-sec"><div class="ac-h">categories</div><div class="ac-chips">' + CATS.map(function (c) { return chip('data-cat="' + c.id + '"', c.name, st.cats.indexOf(c.id) >= 0); }).join('') + '</div></div>';
      var pool = poolOf(PHRASES, st).length;
      h += '<div class="ac-note">' + fmtInt(pool) + ' phrases in the mix</div>';
    }
    h += '<button type="button" class="ac-go" data-act="start">' + (m === 'party' ? 'Start party' : m === 'cpu' ? 'Challenge ' + CPU_NAME : m === 'daily' ? 'Play today’s ' + ROUND_N : 'Play ' + ROUND_N) + ' <small>Enter</small></button>';
    h += '<div class="ac-foot"><span>best ' + fmtInt(sv.solo.best) + ' &middot; streak ' + sv.solo.bestStreak + '</span><span><button type="button" class="ac-lnk" data-act="records">records</button> <button type="button" class="ac-lnk" data-act="help">how to play</button></span></div>';
    return h;
  }
  function helpHtml() {
    return '<div class="ac-title">HOW TO PLAY</div>' +
      '<p>A phrase starts &mdash; <b>you finish it</b>. Type the rest and press <b>Enter</b>.</p>' +
      '<div class="ac-keys"><span><b>Spelling</b> doesn’t need to be perfect: typos, case, punctuation and apostrophes are forgiven.</span>' +
      '<span><b>Partial credit</b> for the words you get right; little words (the, a, of) count less.</span>' +
      '<span><b>Hint</b> shows the first word and initials &mdash; halves the points.</span>' +
      '<span><b>Solo</b>: up to 100 for accuracy, +30 for speed, +10 per streak step (answers ' + Math.round(STREAK_AT * 100) + '%+).</span>' +
      '<span><b>Party</b>: pass the device; nobody sees the others’ answers until the reveal.</span></div>' +
      '<pre class="ac-tab">' + VERDICTS.map(function (v) { return '<b>' + v.glyph + '</b> ' + (v.name + '         ').slice(0, 10) + (v.min > 0 ? ' ' + Math.round(v.min * 100) + '%+' : ''); }).join('\n') + '</pre>' +
      '<p class="ac-tip">Keys: <b>Enter</b> answer / next &middot; <b>Esc</b> pause. Phrases are traditional sayings and public-domain lines.</p>' +
      '<button type="button" class="ac-go" data-act="home">Got it</button>';
  }
  function recordsHtml() {
    var sv = S.save, so = sv.solo, h = '<div class="ac-title">RECORDS</div>';
    var avg = so.answered ? so.acc / so.answered : 0;
    h += '<pre class="ac-tab">' +
      'solo best     <b>' + fmtInt(so.best) + '</b>\n' +
      'best streak   <b>' + so.bestStreak + '</b>\n' +
      'rounds        <b>' + so.games + '</b>\n' +
      'perfects      <b>' + so.perfects + '</b> / ' + so.answered + '\n' +
      'accuracy      <b>' + pct(avg) + '</b>\n' +
      'daily best    <b>' + fmtInt(sv.daily.best) + '</b>  (' + sv.daily.played + ' days)\n' +
      'party games   <b>' + sv.party.games + '</b>' +
      '</pre>';
    h += '<div class="ac-h">vs ' + CPU_NAME + ' (won-lost-drawn)</div><pre class="ac-tab">' + CPU_LEVELS.map(function (l) {
      var r = sv.cpu[l.id];
      return (l.name + '        ').slice(0, 8) + ' <b>' + r.w + '</b>-' + r.l + '-' + r.d;
    }).join('\n') + '</pre>';
    h += '<div class="ac-h">by category</div><pre class="ac-tab">' + CATS.map(function (c) {
      var x = sv.cat[c.id], a = x.n ? x.s / x.n : 0;
      return (c.name + '              ').slice(0, 13) + meter(a, 8) + ' ' + (x.n ? pct(a) : '&mdash;') + ' <i>(' + x.n + ')</i>';
    }).join('\n') + '</pre>';
    if (so.last.length) h += '<p class="ac-tip">last rounds: ' + so.last.map(fmtInt).join(' &middot; ') + '</p>';
    h += S.resetArm
      ? '<div class="ac-foot"><span class="ac-confirm">Erase all records?</span><span><button type="button" class="ac-lnk danger" data-act="reset-yes">erase</button> <button type="button" class="ac-lnk" data-act="reset-no">keep</button></span></div>'
      : '<div class="ac-foot"><span></span><button type="button" class="ac-lnk" data-act="reset">reset records</button></div>';
    h += '<button type="button" class="ac-go" data-act="home">Back</button>';
    return h;
  }
  function passHtml() {
    var g = S.g, pi = g.order[g.turn];
    var lk = g.turn > 0 && g.locked ? '<div class="ac-new">' + esc(playerName(g.locked.who)) + (g.locked.timedOut ? ' ran out of time — answer locked in' : '’s answer is locked in') + '</div>' : '';
    return '<div class="ac-title">PASS</div>' + lk +
      '<p class="ac-sub">Phrase ' + (g.qi + 1) + ' of ' + g.ids.length + ' &middot; turn ' + (g.turn + 1) + ' of ' + g.order.length + '</p>' +
      '<div class="ac-big">' + esc(playerName(pi)) + '</div>' +
      '<p class="ac-sub">Pass to ' + esc(playerName(pi)) + ' &mdash; tap when ready.' + (g.timed ? '<br>The clock starts when you tap.' : '') + '</p>' +
      '<button type="button" class="ac-go" data-act="ready">I’m ' + esc(playerName(pi)) + ' &mdash; ready <small>Enter</small></button>' +
      '<div class="ac-foot"><span>' + standingsLine() + '</span><button type="button" class="ac-lnk" data-act="quit">quit</button></div>';
  }
  function standingsLine() {
    var g = S.g;
    return g.players.map(function (p) { return esc(p.name) + ' ' + fmtInt(p.score); }).join(' &middot; ');
  }
  function pauseHtml() {
    return '<div class="ac-title">PAUSED</div><p class="ac-sub">The phrase is hidden and the clock is stopped.</p>' +
      '<div class="ac-btns"><button type="button" class="ac-go" data-act="resume">Resume <small>Esc</small></button><button type="button" class="ac-go alt" data-act="quit">Quit</button></div>';
  }
  function loadingHtml(err) {
    return '<div class="ac-title">FINISH THE PHRASE</div>' + (err
      ? '<p class="ac-sub">Couldn’t load the phrase book.</p><button type="button" class="ac-go" data-act="retry">Try again</button>'
      : '<p class="ac-sub">Opening the phrase book&hellip;</p>');
  }
  function overHtml() {
    var g = S.g, r = S.result || {}, h = '';
    if (g.mode === 'solo' || g.mode === 'daily') {
      var p = g.players[0];
      h += '<div class="ac-title">' + (g.mode === 'daily' ? 'DAILY DONE' : 'ROUND OVER') + '</div>';
      h += '<div class="ac-big">' + fmtInt(p.score) + '</div>';
      if (r.best) h += '<div class="ac-new">NEW BEST SCORE</div>';
      else if (r.daily) h += '<div class="ac-new">NEW DAILY BEST</div>';
      if (r.streak) h += '<div class="ac-new">NEW BEST STREAK: ' + p.bestStreak + '</div>';
      h += '<pre class="ac-tab">perfect   <b>' + p.perfects + '</b> / ' + g.ids.length + '\naccuracy  <b>' + pct(p.acc / g.ids.length) + '</b>\nstreak    <b>' + p.bestStreak + '</b>' +
        (g.mode === 'daily' ? '\nday streak <b>' + S.save.daily.streak + '</b>' : '\nbest      <b>' + fmtInt(S.save.solo.best) + '</b>') + '</pre>';
    } else if (g.mode === 'cpu') {
      var me = g.players[0], bot = g.players[1];
      h += '<div class="ac-title">' + (r.res === 'w' ? 'YOU WIN' : r.res === 'l' ? CPU_NAME.toUpperCase() + ' WINS' : 'DRAW') + '</div>';
      h += '<div class="ac-big">' + fmtInt(me.score) + ' <i>:</i> ' + fmtInt(bot.score) + '</div>';
      var rec = S.save.cpu[g.cpu];
      h += '<p class="ac-sub">vs ' + CPU_NAME + ' (' + CPU[g.cpu].name + '): ' + rec.w + ' won &middot; ' + rec.l + ' lost &middot; ' + rec.d + ' drawn</p>';
      h += '<p class="ac-sub">' + (r.res === 'w' ? '“Recalibrating my vocabulary.”' : r.res === 'l' ? '“I was trained for this.”' : '“Great minds think alike.”') + '</p>';
    } else {
      var st = standings(g.players);
      var top = st.filter(function (x) { return x.rank === 1; });
      h += '<div class="ac-title">' + (top.length > 1 ? 'A TIE' : 'WINNER') + '</div>';
      h += '<div class="ac-big">' + top.map(function (x) { return esc(g.players[x.i].name); }).join(' &amp; ') + '</div>';
      h += '<pre class="ac-tab">' + st.map(function (x) {
        var p2 = g.players[x.i];
        return '<span class="' + (x.rank === 1 ? 'g' : '') + '">' + x.rank + '. ' + esc((p2.name + '              ').slice(0, 14)) + ' <b>' + (fmtInt(p2.score) + '     ').slice(0, 5) + '</b> <i>' + p2.perfects + ' perfect</i></span>';
      }).join('\n') + '</pre>';
    }
    // the phrases of the game, with how you (party: the best answer) did
    h += '<details class="ac-review"><summary>review phrases</summary><div>' + g.log.map(function (L) {
      var ph = BY_ID[L.id];
      return '<div class="ac-rv"><span class="ac-gl v-' + L.v + '">' + verdictOf(L.s).glyph + '</span> ' + esc(ph.start) + ' <b>' + esc(ph.end) + '</b></div>';
    }).join('') + '</div></details>';
    h += '<div class="ac-btns"><button type="button" class="ac-go" data-act="again">Again <small>Enter</small></button><button type="button" class="ac-go alt" data-act="home">Menu</button></div>';
    return h;
  }
  function cardHtml(kind) {
    var inner = kind === 'home' ? homeHtml() : kind === 'help' ? helpHtml() : kind === 'records' ? recordsHtml() :
      kind === 'pass' ? passHtml() : kind === 'pause' ? pauseHtml() : kind === 'over' ? overHtml() :
      kind === 'error' ? loadingHtml(true) : loadingHtml(false);
    return '<div class="ac-card ac-k-' + kind + '">' + inner + '</div>';
  }

  // ---- header + status bar ----
  function syncHead() {
    if (!S) return;
    var sb = S.head.querySelector('[data-h="sound"]'), pb = S.head.querySelector('[data-h="pause"]');
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.classList.toggle('on', S.snd.on);
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    var canPause = S.phase === 'ask';
    pb.disabled = !canPause;
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.title = S.paused ? 'Resume' : 'Pause';
    pb.setAttribute('aria-label', pb.title);
  }
  function syncBar() {
    if (!S) return;
    var g = S.g, inGame = g && S.phase !== 'home' && S.phase !== 'over';
    S.bar.classList.toggle('off', !inGame);
    if (!inGame) return;
    var q = 'Q ' + Math.min(g.qi + 1, g.ids.length) + '/' + g.ids.length, mid = '', right = '';
    if (g.mode === 'solo' || g.mode === 'daily') {
      var p = g.players[0];
      mid = p.streak >= 2 ? '<b class="ac-streak">streak x' + p.streak + '</b>' : (g.mode === 'daily' ? 'daily ' + esc(g.date) : '');
      right = '<b>' + fmtInt(p.score) + '</b>';
    } else if (g.mode === 'cpu') {
      mid = 'vs ' + CPU_NAME + ' <i>' + CPU[g.cpu].name.toLowerCase() + '</i>';
      right = '<b>' + fmtInt(g.players[0].score) + '</b> : ' + fmtInt(g.players[1].score);
    } else {
      var who = S.phase === 'ask' ? g.order[g.turn] : -1;
      mid = who >= 0 ? '<b>' + esc(playerName(who)) + '</b>’s turn' : S.phase === 'reveal' ? standingsLine() : '';
      right = S.phase === 'reveal' ? '' : (g.turn + 1) + '/' + g.order.length;
    }
    S.barQ.textContent = q;
    S.barMid.innerHTML = mid;
    S.barR.innerHTML = right;
  }

  // ---- game flow ----
  function newGame() {
    var st = S.setup, g = { mode: st.mode, qi: 0, log: [], cpu: st.cpu, timed: true, date: '' };
    var seed = (Math.random() * 4294967295) >>> 0;
    g.rand = rng(seed);
    if (st.mode === 'daily') {
      g.date = dateKey();
      g.ids = dailyRound(PHRASES, g.date);
      g.players = [{ name: 'You' }];
    } else if (st.mode === 'party') {
      g.ids = pickRound(PHRASES, st, g.rand, st.rounds, S.save.recent);
      g.players = [];
      for (var i = 0; i < st.n; i++) g.players.push({ name: (st.names[i] || '').trim() || 'Player ' + (i + 1) });
      g.timed = st.timer;
    } else {
      g.ids = pickRound(PHRASES, st, g.rand, ROUND_N, S.save.recent);
      g.players = [{ name: 'You' }];
      if (st.mode === 'cpu') g.players.push({ name: CPU_NAME, cpu: true });
    }
    g.players.forEach(function (p) { p.score = 0; p.perfects = 0; p.streak = 0; p.bestStreak = 0; p.acc = 0; });
    if (g.mode !== 'daily') { remember(S.save, g.ids); persist(); }
    return g;
  }
  function startGame() {
    S.snd.ensure();
    S.g = newGame();
    S.result = null;
    S.snd.tone(523, 0.06, 'triangle', 0.04); S.snd.tone(784, 0.08, 'triangle', 0.04, 0, 0.06);
    nextPrompt();
  }
  function curPh() { return BY_ID[S.g.ids[S.g.qi]]; }
  function nextPrompt() {
    var g = S.g;
    if (g.qi >= g.ids.length) { finish(); return; }
    var humans = g.players.filter(function (p) { return !p.cpu; }).length;
    g.order = g.mode === 'party' ? turnOrder(humans, g.qi) : [0];
    g.turn = 0;
    g.ans = [];
    g.limit = timeLimit(curPh());
    beginTurn();
  }
  function beginTurn() {
    if (S.g.mode === 'party') { S.phase = 'pass'; S.paused = false; blurInput(); showCard('pass'); focusGo(); return; }
    ask();
  }
  // Show the prompt and take an answer. Called straight from a click / key handler,
  // so focusing the input raises the phone keyboard.
  function ask() {
    var g = S.g, ph = curPh();
    hideCard();
    S.phase = 'ask'; S.paused = false;
    g.hint = false; g.elapsed = 0; g.warned = 0;
    S.askEl.hidden = false; S.revEl.hidden = true;
    S.metaEl.innerHTML = '<span class="ac-cat">' + esc(CAT[ph.cat].tag) + '</span>' + diffStars(ph.d) +
      '<span class="ac-wc">' + wordCount(ph.end) + ' word' + (wordCount(ph.end) === 1 ? '' : 's') + '</span>';
    S.promptEl.innerHTML = '<span class="ac-st">' + esc(ph.start) + '</span> <span class="ac-ghost" aria-hidden="true">' + esc(ghostOf(ph)) + '</span><span class="ac-caret" aria-hidden="true">_</span>';
    S.hintEl.textContent = '';
    S.hintEl.hidden = true;
    S.input.value = '';
    S.input.disabled = false;
    S.input.placeholder = g.mode === 'party' ? playerName(g.order[g.turn]) + ', finish it…' : 'finish the phrase…';
    S.timeEl.hidden = !g.timed;
    S.hintBtn.disabled = false;
    syncTimer();
    syncHead(); syncBar();
    say(ph.start + '...');
    try { S.input.focus({ preventScroll: true }); } catch (e) { try { S.input.focus(); } catch (e2) {} }
    S.lastT = now();
    startLoop();
  }
  function ghostOf(ph) {   // the ending's shape as faint dashes ("___ _ _____")
    return ph.end.split(/\s+/).map(function (w) { return w.replace(/[A-Za-z0-9]/g, '_'); }).join(' ');
  }
  function useHint() {
    var g = S.g;
    if (S.phase !== 'ask' || S.paused || g.hint) return;
    g.hint = true;
    S.hintEl.hidden = false;
    S.hintEl.innerHTML = '<span>hint</span> ' + esc(hintText(curPh())) + ' <i>(points halved)</i>';
    S.hintBtn.disabled = true;
    S.snd.tone(740, 0.08, 'sine', 0.04, 620);
    try { S.input.focus({ preventScroll: true }); } catch (e) {}
  }
  function submit(timedOut, giveUp) {
    var g = S.g;
    if (S.phase !== 'ask' || S.paused) return;
    var text = S.input.value.replace(/\s+/g, ' ').trim().slice(0, 200), ph = curPh();
    // a stray Enter (key repeat, or the press that dismissed the pass screen) must not throw away a turn
    if (!text && !timedOut && !giveUp) { S.input.classList.remove('nudge'); void S.input.offsetWidth; S.input.classList.add('nudge'); return; }
    stopLoop();
    var res = grade(ph, text), pi = g.order[g.turn];
    g.ans[pi] = { text: text, g: res, hint: g.hint, time: Math.min(g.elapsed, g.limit), timedOut: !!timedOut };
    S.input.disabled = true;
    if (g.mode === 'party') S.input.value = '';   // nothing of this answer stays around for the next player
    if (g.mode === 'party' && g.turn < g.order.length - 1) {
      g.turn++;
      g.locked = { who: pi, timedOut: !!timedOut };
      S.snd.tone(660, 0.05, 'square', 0.025); S.snd.tone(990, 0.07, 'square', 0.02, 0, 0.05);
      beginTurn();
      return;
    }
    if (g.mode === 'cpu') { botTurn(); return; }
    reveal();
  }

  // the bot "types" its answer into the reveal, then everything is scored
  function botTurn() {
    var g = S.g, ph = curPh();
    var guess = cpuGuess(ph, g.cpu, g.rand, PHRASES);
    g.bot = guess;
    g.ans[1] = { text: guess.text, g: grade(ph, guess.text), hint: false, time: guess.think, bot: guess.kind };
    S.phase = 'cpu';
    blurInput();
    S.askEl.hidden = true; S.revEl.hidden = false;
    S.typed = 0;
    renderReveal(false);
    syncHead(); syncBar();
    var txt = guess.text || '…';
    var step = function () {
      if (!S || S.phase !== 'cpu') return;
      S.typed++;
      var el = S.revEl.querySelector('.ac-bot-typing');
      if (el) el.textContent = txt.slice(0, S.typed);
      if (S.typed % 2) S.snd.key();
      if (S.typed >= txt.length) { S.tmr = setTimeout(function () { if (S && S.phase === 'cpu') reveal(); }, 260); return; }
      S.tmr = setTimeout(step, 26 + Math.random() * 40);
    };
    S.tmr = setTimeout(step, 520);
  }

  function reveal() {
    var g = S.g, ph = curPh();
    clearTimeout(S.tmr);
    S.phase = 'reveal';
    blurInput();
    var lead = -1, leadV = 'miss';
    g.players.forEach(function (p, i) {
      var a = g.ans[i];
      if (!a) return;
      var sc = a.g.score;
      if (g.mode === 'solo' || g.mode === 'daily') {
        p.streak = sc >= STREAK_AT ? p.streak + 1 : 0;
        a.pts = soloPoints(sc, { hint: a.hint, time: a.time, limit: g.limit, streak: p.streak });
      } else {
        p.streak = sc >= STREAK_AT ? p.streak + 1 : 0;
        a.pts = { base: basePts(sc, a.hint), speed: 0, streak: 0, total: basePts(sc, a.hint) };
      }
      p.bestStreak = Math.max(p.bestStreak, p.streak);
      p.score += a.pts.total;
      p.acc += sc;
      if (a.g.verdict === 'perfect') p.perfects++;
      if (!p.cpu) { addCat(S.save, ph, sc); if (lead < 0 || sc > g.ans[lead].g.score) lead = i; }
    });
    if (lead >= 0) leadV = g.ans[lead].g.verdict;
    var a0 = g.mode === 'party' && lead >= 0 ? g.ans[lead] : g.ans[0];   // party: the best answer
    g.log.push({ id: ph.id, s: a0 ? a0.g.score : 0, v: a0 ? a0.g.verdict : 'miss' });
    persist();
    S.askEl.hidden = true; S.revEl.hidden = false;
    renderReveal(true);
    syncHead(); syncBar();
    S.snd.verdict(leadV);
    if (leadV === 'perfect') { burst(); Cade.haptic && Cade.haptic(12); }
    else if (leadV === 'miss') { var vEl = S.revEl.querySelector('.ac-verdict'); if (vEl && !S.rm) { vEl.classList.add('shake'); } }
    var bump = S.bar.querySelector('.ac-bar-r');
    if (bump && !S.rm) { bump.classList.remove('pop'); void bump.offsetWidth; bump.classList.add('pop'); }
    say(ph.start + ' ' + ph.end + '. ' + (g.players.length === 1 ? g.ans[0].g.label + ', ' + g.ans[0].pts.total + ' points' : ''));
    focusGo();
  }
  function rowHtml(i, done) {
    var g = S.g, p = g.players[i], a = g.ans[i];
    var h = '<div class="ac-row' + (p.cpu ? ' bot' : '') + '"><div class="ac-row-h"><b>' + esc(p.name) + '</b>';
    if (p.cpu && !done) {
      h += '<span class="ac-dim">typing&hellip;</span></div><div class="ac-said"><span class="ac-bot-typing"></span><span class="ac-caret">_</span></div></div>';
      return h;
    }
    if (!done) {   // the bot is still typing: answers are in, scores aren't
      h += '<span class="ac-dim">locked in</span></div><div class="ac-said">' + (a.text ? esc(a.text) : '<i class="ac-dim">(no answer)</i>') + '</div></div>';
      return h;
    }
    var v = a.g.verdict;
    h += '<span class="ac-tag v-' + v + '">' + a.g.label + '</span><span class="ac-pts">+' + a.pts.total + '</span></div>';
    h += '<div class="ac-said">' + (a.text ? wordsHtml(a.g.ansWords, 'ans') : '<i class="ac-dim">' + (a.timedOut ? '(out of time)' : '(no answer)') + '</i>') + '</div>';
    h += '<div class="ac-mtr">' + meter(a.g.score, 12) + ' ' + pct(a.g.score) + (a.hint ? ' <i>hint</i>' : '') + (p.cpu ? ' <i>' + a.time.toFixed(1) + 's</i>' : '') + '</div>';
    if (p.cpu) h += '<div class="ac-quip">' + esc(botQuip(a.bot, v)) + '</div>';
    return h + '</div>';
  }
  function botQuip(kind, v) {
    var L = {
      exact: ['Too easy.', 'Autocomplete is literally my job.', 'I have seen this one before.', 'Nailed it.'],
      typo: ['My fingers slipped. I do not have fingers.', 'Close enough for a robot.', 'Spellcheck was on a break.'],
      close: ['I was so close!', 'That is basically what I meant.', 'Partial credit counts, right?'],
      wrong: ['Wait, that’s a different saying.', 'My wires crossed.', 'I mixed up my phrase book.'],
      silly: ['I panicked.', 'Trust me on this one.', 'It is what it is. Probably.', 'Was that not it?'],
      blank: ['...', 'I plead the fifth.', 'Buffering…']
    }[kind] || ['Hmm.'];
    if (kind === 'exact' && v !== 'perfect') return 'Hmm, my answer looked right to me.';
    return L[Math.floor(S.g.rand() * L.length)];
  }
  function renderReveal(done) {
    var g = S.g, ph = curPh(), h = '';
    var multi = g.players.length > 1;
    var first = g.ans[g.order[0]] || g.ans[0];
    // the real ending, highlighted against the best human answer (or the only one)
    var bestI = -1;
    g.players.forEach(function (p, i) { if (!p.cpu && g.ans[i] && (bestI < 0 || g.ans[i].g.score > g.ans[bestI].g.score)) bestI = i; });
    var ref = multi ? g.ans[bestI] : first;
    if (!multi) {
      var a = first, pts = a.pts;
      h += '<div class="ac-verdict v-' + a.g.verdict + '">' + a.g.label + '</div>';
      h += '<div class="ac-mtr big">' + meter(a.g.score, 14) + ' ' + pct(a.g.score) + '</div>';
      h += '<div class="ac-full"><span class="ac-st">' + esc(ph.start) + '</span> <span class="ac-end">' + wordsHtml(a.g.endWords, 'end') + '</span></div>';
      h += '<div class="ac-you"><span class="ac-lab">you</span> ' + (a.text ? wordsHtml(a.g.ansWords, 'ans') : '<i class="ac-dim">' + (a.timedOut ? '(out of time)' : '(gave up)') + '</i>') + '</div>';
      if (a.g.alt > 0) h += '<div class="ac-note">also known as: ' + esc(ph.end) + '</div>';
      h += '<div class="ac-break"><span>+' + pts.base + ' <i>accuracy' + (a.hint ? ' (hint)' : '') + '</i></span>' +
        (pts.speed ? '<span>+' + pts.speed + ' <i>speed</i></span>' : '') +
        (pts.streak ? '<span class="g">+' + pts.streak + ' <i>streak x' + g.players[0].streak + '</i></span>' : '') +
        '<b>= ' + pts.total + '</b></div>';
    } else {
      h += '<div class="ac-full"><span class="ac-st">' + esc(ph.start) + '</span> ' + (done ? '<span class="ac-end">' +
        (ref ? wordsHtml(ref.g.endWords, 'end') : esc(ph.end)) + '</span>' : '<span class="ac-ghost">' + esc(ghostOf(ph)) + '</span>') + '</div>';
      h += '<div class="ac-rows">';
      var order = g.mode === 'party' ? g.order : [0, 1];
      order.forEach(function (i) { h += rowHtml(i, done); });
      h += '</div>';
    }
    var last = g.qi >= g.ids.length - 1;
    h += '<button type="button" class="ac-go ac-next" data-act="next"' + (done ? '' : ' disabled') + '>' + (last ? 'See results' : 'Next phrase') + ' <small>Enter</small></button>';
    S.revEl.innerHTML = h;
  }
  function next() {
    if (S.phase !== 'reveal') return;
    S.snd.ensure();
    S.g.qi++;
    nextPrompt();
  }
  function finish() {
    var g = S.g, r = {};
    S.phase = 'over';
    stopLoop();
    blurInput();
    if (g.mode === 'solo' || g.mode === 'daily') {
      var p = g.players[0];
      r = settleSolo(S.save, { score: p.score, bestStreak: p.bestStreak, perfects: p.perfects, answered: g.ids.length, acc: p.acc, daily: g.mode === 'daily', date: g.date });
      if (r.best || r.daily) { S.snd.fanfare(); setTimeout(function () { if (S && S.phase === 'over') burst(); }, 60); }
    } else if (g.mode === 'cpu') {
      r.res = settleCpu(S.save, g.cpu, g.players[0].score, g.players[1].score);
      if (r.res === 'w') { S.snd.fanfare(); setTimeout(function () { if (S && S.phase === 'over') burst(); }, 60); }
      else S.snd.verdict(r.res === 'l' ? 'miss' : 'partial');
    } else {
      S.save.party.games++;
      S.snd.fanfare();
      setTimeout(function () { if (S && S.phase === 'over') burst(); }, 60);
    }
    S.result = r;
    persist();
    showCard('over');
    focusGo();
  }
  function quitGame() {
    clearTimeout(S.tmr);
    stopLoop();
    S.paused = false;
    toHome();
  }
  function toHome() {
    S.phase = 'home'; S.paused = false;
    stopLoop();
    blurInput();
    S.askEl.hidden = false; S.revEl.hidden = true;
    S.resetArm = false;
    S.artLine = artLine();
    showCard('home');
  }
  function artLine() {
    var ph = PHRASES[Math.floor(Math.random() * PHRASES.length)];
    var s = ph.start.toLowerCase() + ' ' + ph.end.split(/\s+/)[0].toLowerCase().replace(/[a-z]/g, '_') + '_';
    if (s.length > 34) s = '…' + s.slice(-33);
    return '> ' + s;
  }

  // ---- pause / timer ----
  function pause() {
    if (!S || S.phase !== 'ask' || S.paused) return;
    S.paused = true;
    stopLoop();
    blurInput();
    showCard('pause');
    focusGo();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    hideCard();
    syncHead(); syncBar();
    try { S.input.focus({ preventScroll: true }); } catch (e) {}
    S.lastT = now();
    startLoop();
  }
  function running() {
    return !!S && S.phase === 'ask' && !S.paused && S.g.timed && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel));
  }
  function startLoop() {
    if (!S || S.raf || !running()) return;
    S.lastT = now();
    S.raf = requestAnimationFrame(frame);
  }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(t) {
    if (!S) return;
    S.raf = 0;
    if (!running()) return;
    var n = now(), dt = Math.min(0.25, Math.max(0, (n - S.lastT) / 1000));
    S.lastT = n;
    var g = S.g;
    g.elapsed += dt;
    var left = g.limit - g.elapsed;
    if (left <= 5 && Math.ceil(left) !== g.warned && left > 0) { g.warned = Math.ceil(left); S.snd.tone(1200, 0.04, 'square', 0.02); }
    syncTimer();
    if (left <= 0) { submit(true); return; }
    S.raf = requestAnimationFrame(frame);
  }
  function syncTimer() {
    var g = S.g;
    if (!g || !g.timed) return;
    var left = Math.max(0, g.limit - g.elapsed), f = left / g.limit;
    S.tbar.style.transform = 'scaleX(' + f.toFixed(4) + ')';
    S.timeEl.classList.toggle('low', left <= 5);
    var s = Math.ceil(left) + 's';
    if (S.tnum.textContent !== s) S.tnum.textContent = s;
  }

  // ---- juice ----
  function burst() {
    if (!S || S.rm) return;
    var fx = S.fx, r = S.stage.getBoundingClientRect(), el = (S.cardKind ? S.ovl.querySelector('.ac-big') : S.revEl.querySelector('.ac-verdict') || S.revEl.querySelector('.ac-row:not(.bot) .ac-tag.v-perfect')) || S.stage;
    var e = el.getBoundingClientRect();
    var cx = e.left - r.left + e.width / 2, cy = e.top - r.top + e.height / 2;
    var gl = ['*', '+', '.', '#', '"', '!', '~', 'o'];
    for (var i = 0; i < 22; i++) {
      var s = document.createElement('span'), a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 90;
      s.textContent = gl[i % gl.length];
      s.style.left = cx + 'px'; s.style.top = cy + 'px';
      s.style.setProperty('--dx', (Math.cos(a) * d).toFixed(1) + 'px');
      s.style.setProperty('--dy', (Math.sin(a) * d * 0.7 - 20).toFixed(1) + 'px');
      s.style.setProperty('--rot', ((Math.random() - 0.5) * 540).toFixed(0) + 'deg');
      s.style.animationDelay = (Math.random() * 80).toFixed(0) + 'ms';
      if (i % 3 === 0) s.className = 'alt';
      fx.appendChild(s);
    }
    clearTimeout(S.fxT);
    S.fxT = setTimeout(function () { if (S) S.fx.innerHTML = ''; }, 1100);
  }
  function say(t) { if (S && S.liveEl) S.liveEl.textContent = t; }
  function blurInput() { try { if (document.activeElement === S.input) S.input.blur(); } catch (e) {} }
  // On desktop, park focus on the card's main button so Enter works; on touch, leave it.
  function focusGo() {
    if (!S || S.coarse) return;
    var b = (S.cardKind ? S.ovl : S.revEl).querySelector('.ac-go:not([disabled])');
    if (b) { try { b.focus({ preventScroll: true }); } catch (e) {} }
  }

  // ---- input ----
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    var t = e.target;
    var inPanel = t && S.panel.contains(t);
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !inPanel) return;
    var k = e.key;
    // keys typed elsewhere (the editor, another panel) are not ours
    if (!inPanel && t && t !== document.body && t !== document.documentElement) return;
    if (k === 'Escape') {
      if (S.phase === 'ask' && !S.paused) { e.preventDefault(); pause(); }
      else if (S.paused) { e.preventDefault(); resume(); }
      else if (S.cardKind === 'help' || S.cardKind === 'records') { e.preventDefault(); toHome(); }
      return;
    }
    if (k === 'Enter') {
      if (t === S.input) return;   // the form submits
      if (t && t.tagName === 'BUTTON' && inPanel) return;   // a focused button does its own job
      e.preventDefault();
      if (e.repeat) return;
      if (S.paused) resume();
      else if (S.phase === 'reveal') next();
      else if (S.phase === 'cpu') { clearTimeout(S.tmr); reveal(); }
      else if (S.phase === 'pass') { S.snd.ensure(); ask(); }
      else if (S.phase === 'over') startGame();
      else if (S.phase === 'home' && S.cardKind === 'home') startGame();
      else if (S.phase === 'home') toHome();
    }
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.tmr); clearTimeout(s.fxT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
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
    var body = '<div class="ac">' +
      '<div class="ac-bar off"><span class="ac-bar-q"></span><span class="ac-bar-m"></span><span class="ac-bar-r"></span></div>' +
      '<div class="ac-stage">' +
        '<div class="ac-play">' +
          '<div class="ac-ask">' +
            '<div class="ac-meta"></div>' +
            '<div class="ac-prompt"></div>' +
            '<div class="ac-time"><span class="ac-tbar"><i></i></span><span class="ac-tnum"></span></div>' +
            '<form class="ac-form" autocomplete="off"><input class="ac-in" type="text" maxlength="200" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" enterkeyhint="send" aria-label="Your ending">' +
            '<button type="submit" class="ac-send" aria-label="Answer">↵</button></form>' +
            '<div class="ac-hint" hidden></div>' +
            '<div class="ac-acts"><button type="button" class="ac-btn" data-act="hint">Hint <small>&frac12; pts</small></button><button type="button" class="ac-btn" data-act="skip">Give up</button></div>' +
          '</div>' +
          '<div class="ac-rev" hidden></div>' +
        '</div>' +
        '<div class="ac-ovl"></div>' +
        '<div class="ac-fx" aria-hidden="true"></div>' +
      '</div>' +
      '<div class="ac-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '✍️ Finish the Phrase', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'ac-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia;
    S = {
      panel: p, head: hb, stage: p.querySelector('.ac-stage'), ovl: p.querySelector('.ac-ovl'), fx: p.querySelector('.ac-fx'),
      bar: p.querySelector('.ac-bar'), barQ: p.querySelector('.ac-bar-q'), barMid: p.querySelector('.ac-bar-m'), barR: p.querySelector('.ac-bar-r'),
      askEl: p.querySelector('.ac-ask'), revEl: p.querySelector('.ac-rev'), metaEl: p.querySelector('.ac-meta'), promptEl: p.querySelector('.ac-prompt'),
      timeEl: p.querySelector('.ac-time'), tbar: p.querySelector('.ac-tbar i'), tnum: p.querySelector('.ac-tnum'),
      hintEl: p.querySelector('.ac-hint'), hintBtn: p.querySelector('[data-act="hint"]'), input: p.querySelector('.ac-in'), form: p.querySelector('.ac-form'),
      liveEl: p.querySelector('.ac-live'),
      save: normSave(loadJSON(SAVE_KEY)), setup: normSetup(loadJSON(SETUP_KEY)), snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'loading', paused: false, raf: 0, tmr: 0, fxT: 0, g: null, cardKind: null, resetArm: false, artLine: ''
    };
    p._onClose = teardown;

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S && !document.hasFocus()) pause(); };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) { pause(); stopLoop(); } });

    // header: help / sound / pause (the header drags the panel — these are controls)
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') {
        if (S.phase === 'ask') { pause(); return; }
        if (S.phase === 'home') { if (S.cardKind === 'help') showCard('home'); else showCard('help'); }
        else Cade.showToast && Cade.showToast('Finish the phrase: type the ending, Enter to answer. Esc pauses.', 'info', 2600);
      }
      try { b.blur(); } catch (er) {}
    });

    // No zooming, selecting or callouts on fast taps (typing in the inputs still works).
    function noGesture(e) {
      var t = e.target;
      if (t && t.tagName === 'INPUT') return;
      if (e.cancelable) e.preventDefault();
    }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noGesture, { passive: false }); });
    p.addEventListener('contextmenu', function (e) { if (!(e.target && e.target.tagName === 'INPUT')) e.preventDefault(); });

    S.form.addEventListener('submit', function (e) { e.preventDefault(); if (S) { S.snd.ensure(); submit(false); } });
    S.input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.repeat) e.preventDefault(); });
    S.input.addEventListener('input', function () { if (S && S.phase === 'ask') S.snd.key(); });
    S.stage.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || b.disabled) return;
      S.snd.ensure();
      var act = b.getAttribute('data-act');
      var mode = b.getAttribute('data-mode'), diff = b.getAttribute('data-diff'), cat = b.getAttribute('data-cat'), cpu = b.getAttribute('data-cpu');
      var n = b.getAttribute('data-n'), rounds = b.getAttribute('data-rounds'), timer = b.getAttribute('data-timer');
      var st = S.setup, refresh = false;
      if (mode) { st.mode = mode; refresh = true; }
      else if (diff) { st.diff = diff; refresh = true; }
      else if (cat) {
        var at = st.cats.indexOf(cat);
        if (at >= 0) { if (st.cats.length > 1) st.cats.splice(at, 1); else { Cade.showToast && Cade.showToast('Keep at least one category', 'info', 1400); return; } }
        else st.cats.push(cat);
        refresh = true;
      }
      else if (cpu) { st.cpu = cpu; refresh = true; }
      else if (n) { st.n = +n; refresh = true; }
      else if (rounds) { st.rounds = +rounds; refresh = true; }
      else if (timer) { st.timer = !st.timer; refresh = true; }
      if (refresh) {
        persistSetup();
        S.snd.tone(988, 0.04, 'sine', 0.03);
        var keep = null;
        ['data-mode', 'data-diff', 'data-cat', 'data-cpu', 'data-n', 'data-rounds', 'data-timer'].forEach(function (a) {
          if (!keep && b.hasAttribute(a)) keep = '[' + a + '="' + b.getAttribute(a) + '"]';
        });
        showCard('home');
        var nb = e.detail === 0 && keep ? S.ovl.querySelector(keep) : null;   // keyboard: keep focus on the same chip
        if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
        return;
      }
      if (!act) return;
      if (act === 'start' || act === 'again') startGame();
      else if (act === 'home') toHome();
      else if (act === 'help') showCard('help');
      else if (act === 'records') { S.resetArm = false; showCard('records'); }
      else if (act === 'reset') { S.resetArm = true; showCard('records'); }
      else if (act === 'reset-no') { S.resetArm = false; showCard('records'); }
      else if (act === 'reset-yes') {
        var rec = S.save.recent;
        S.save = newSave(); S.save.recent = rec; S.resetArm = false;
        persist();
        Cade.showToast && Cade.showToast('Records erased', 'info', 1600);
        showCard('records');
      }
      else if (act === 'ready') ask();
      else if (act === 'resume') resume();
      else if (act === 'quit') quitGame();
      else if (act === 'next') next();
      else if (act === 'hint') useHint();
      else if (act === 'skip') { S.input.value = ''; submit(false, true); }
      else if (act === 'retry') boot();
    });
    // the player names in party setup
    S.ovl.addEventListener('input', function (e) {
      var t = e.target;
      if (!S || !t || !t.getAttribute) return;
      var i = t.getAttribute('data-name');
      if (i != null) { S.setup.names[+i] = t.value.slice(0, 14); persistSetup(); }
    });
    S.ovl.addEventListener('keydown', function (e) {
      var t = e.target;
      if (e.key === 'Enter' && t && t.getAttribute && t.getAttribute('data-name') != null) { e.preventDefault(); e.stopPropagation(); try { t.blur(); } catch (er) {} startGame(); }
    }, true);
    // the CPU's typing: a tap on the reveal skips ahead
    S.revEl.addEventListener('pointerdown', function () { if (S && S.phase === 'cpu') { clearTimeout(S.tmr); reveal(); } });

    function boot() {
      S.phase = 'loading';
      showCard('loading');
      load().then(function () {
        if (!S || S.panel !== p) return;
        if (!sget(SAVE_KEY)) { S.phase = 'home'; S.artLine = artLine(); showCard('help'); focusGo(); persist(); }
        else { toHome(); focusGo(); }
      }, function () {
        if (!S || S.panel !== p) return;
        S.phase = 'error';
        showCard('error');
      });
    }
    syncHead();
    boot();
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Guess how sayings and famous lines continue — fuzzy scoring, vs CPU or pass-and-play',
    icon: '✍️',
    tags: 'game,word,phrase,autocomplete,guess,idiom,quiz,party,2 player',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
