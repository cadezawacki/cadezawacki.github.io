/* ============================================================
   ARG DESK (round 2) — Puzzle crafter view
   A workbench for building and checking word puzzles and pen-and-
   paper ciphers: a cipher bench (steps pipeline, encode/decode,
   round-trip check, analysis), the solve path, and the design
   checks with automated helpers.
   Routes: crafter · crafter.<puzzleId> · crafter.scratch
   ============================================================ */
(function () {
  'use strict';
  var D = window.ARG;
  var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  /* typical English letter frequencies, % (A–Z) */
  var EN = [8.167, 1.492, 2.782, 4.253, 12.702, 2.228, 2.015, 6.094, 6.966, 0.153, 0.772, 4.025, 2.406,
    6.749, 7.507, 1.929, 0.095, 5.987, 6.327, 9.056, 2.758, 0.978, 2.360, 0.150, 1.974, 0.074];
  var IOC_EN = 0.066, IOC_RAND = 0.038;

  function esc(s) { return Kit.esc(s); }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function deaccent(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function squash(s) { return String(s || '').toUpperCase().replace(/\s+/g, ' ').trim(); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  /* ============================================================
     EXTRA CIPHER OPS (registered on Kit so every view can run them)
     ============================================================ */
  function keyedAlphabet(key, dropJ) {
    var src = deaccent(key).toUpperCase().replace(/[^A-Z]/g, '');
    if (dropJ) src = src.replace(/J/g, 'I');
    var out = '';
    (src + A).split('').forEach(function (c) {
      if (dropJ && c === 'J') return;
      if (out.indexOf(c) < 0) out += c;
    });
    return out;
  }
  function mapLetters(t, from, to) {
    return t.replace(/[A-Za-z]/g, function (c) {
      var up = c.toUpperCase(), i = from.indexOf(up);
      if (i < 0) return c;
      return c === up ? to[i] : to[i].toLowerCase();
    });
  }
  Kit.registerOp('keyword', {
    label: 'Keyword alphabet',
    desc: 'Substitution alphabet: the keyword\'s letters first, then the rest of A–Z.',
    params: [{ key: 'keyword', label: 'Keyword', type: 'text', def: 'MERIDIAN' }],
    encode: function (t, p) { return mapLetters(t, A, keyedAlphabet(p.keyword)); },
    decode: function (t, p) { return mapLetters(t, keyedAlphabet(p.keyword), A); },
  });

  Kit.registerOp('polybius', {
    label: 'Polybius square',
    desc: '5×5 grid with I and J in one cell. Each letter becomes a row–column digit pair.',
    params: [{ key: 'key', label: 'Square key (optional)', type: 'text', def: '' }],
    lossy: true,
    fold: function (s) { return s.replace(/J/g, 'I'); },
    encode: function (t, p) {
      var sq = keyedAlphabet(p.key, true);
      return deaccent(t).toUpperCase().replace(/J/g, 'I').split(/\s+/).map(function (w) {
        return w.replace(/[^A-Z]/g, '').split('').map(function (c) { var i = sq.indexOf(c); return (Math.floor(i / 5) + 1) + '' + (i % 5 + 1); }).join(' ');
      }).filter(Boolean).join(' / ');
    },
    decode: function (t, p) {
      var sq = keyedAlphabet(p.key, true);
      return String(t).split('/').map(function (w) {
        var d = w.replace(/[^0-9]/g, ''), out = '';
        for (var i = 0; i < d.length; i += 2) {
          var r = +d[i], c = +d[i + 1];
          out += (r >= 1 && r <= 5 && c >= 1 && c <= 5) ? sq[(r - 1) * 5 + (c - 1)] : '?';
        }
        return out;
      }).filter(Boolean).join(' ');
    },
  });

  /* book code: blank lines start a new page */
  function normWord(w) { return deaccent(w).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function bookIndex(src) {
    var entries = [], byWord = {}, gline = 0;
    var text = String(src || '').replace(/\r/g, '').trim();
    if (!text) return { entries: entries, byWord: byWord };
    text.split(/\n[ \t]*\n\s*/).forEach(function (page, pi) {
      page.split('\n').forEach(function (line, li) {
        if (!line.trim()) return;
        gline++;
        var wi = 0;
        line.split(/\s+/).forEach(function (tok) {
          var w = normWord(tok); if (!w) return;
          wi++;
          var e = { w: w, page: pi + 1, line: li + 1, gline: gline, word: wi };
          entries.push(e);
          (byWord[w] = byWord[w] || []).push(e);
        });
      });
    });
    return { entries: entries, byWord: byWord };
  }
  Kit.registerOp('bookcode', {
    label: 'Book code',
    desc: 'Each word becomes where it sits in a source text: page.line.word or line.word.',
    params: [
      { key: 'source', label: 'Source text', type: 'longtext', def: '' },
      { key: 'format', label: 'Numbering', type: 'select', def: 'plw', options: [['plw', 'page.line.word'], ['lw', 'line.word']] },
      { key: 'pick', label: 'Repeated words', type: 'select', def: 'first', options: [['first', 'Use the first match'], ['cycle', 'Rotate through matches']] },
    ],
    lossy: true,
    encode: function (t, p) {
      var idx = bookIndex(p.source), used = {};
      return String(t).split(/\s+/).map(normWord).filter(Boolean).map(function (w) {
        var list = idx.byWord[w];
        if (!list) return '?' + w + '?';
        var n = used[w] || 0; used[w] = n + 1;
        var e = p.pick === 'cycle' ? list[n % list.length] : list[0];
        return p.format === 'lw' ? e.gline + '.' + e.word : e.page + '.' + e.line + '.' + e.word;
      }).join(' ');
    },
    decode: function (t, p) {
      var idx = bookIndex(p.source);
      return String(t).trim().split(/\s+/).filter(Boolean).map(function (tok) {
        var miss = /^\?([^?]+)\?$/.exec(tok);
        if (miss) return miss[1].toUpperCase();
        var parts = tok.split('.').map(Number);
        if (parts.some(isNaN)) return '?';
        var hit = null;
        if (parts.length === 3) hit = idx.entries.find(function (e) { return e.page === parts[0] && e.line === parts[1] && e.word === parts[2]; });
        else if (parts.length === 2) hit = idx.entries.find(function (e) { return e.gline === parts[0] && e.word === parts[1]; });
        return hit ? hit.w.toUpperCase() : '?';
      }).join(' ');
    },
  });

  Kit.registerOp('numbase', {
    label: 'Number base',
    desc: 'Letters (A=1) or numbers to binary or hex, and back.',
    params: [
      { key: 'from', label: 'Convert', type: 'select', def: 'letters', options: [['letters', 'Letters (A=1)'], ['numbers', 'Numbers']] },
      { key: 'base', label: 'To', type: 'select', def: '2', options: [['2', 'Binary'], ['16', 'Hex']] },
    ],
    lossy: true,
    encode: function (t, p) {
      var base = +p.base === 16 ? 16 : 2;
      if (p.from === 'numbers') return String(t).replace(/\d+/g, function (n) { return parseInt(n, 10).toString(base).toUpperCase(); });
      var pad = base === 2 ? 5 : 2;
      return deaccent(t).toUpperCase().split(/\s+/).map(function (w) {
        return w.replace(/[^A-Z]/g, '').split('').map(function (c) { return (A.indexOf(c) + 1).toString(base).toUpperCase().padStart(pad, '0'); }).join(' ');
      }).filter(Boolean).join(' / ');
    },
    decode: function (t, p) {
      var base = +p.base === 16 ? 16 : 2;
      if (p.from === 'numbers') {
        var re = base === 2 ? /\b[01]+\b/g : /\b[0-9A-Fa-f]+\b/g;
        return String(t).replace(re, function (n) { return String(parseInt(n, base)); });
      }
      return String(t).split('/').map(function (w) {
        return w.trim().split(/\s+/).filter(Boolean).map(function (n) { var v = parseInt(n, base); return A[v - 1] || '?'; }).join('');
      }).filter(Boolean).join(' ');
    },
  });

  /* one-line descriptions for the built-in ops (the menu shows every op in Kit.ops) */
  var OP_DESC = {
    caesar: 'Shifts every letter a fixed number of places.',
    vigenere: 'Shifts each letter by the matching letter of a repeating key.',
    atbash: 'Mirrors the alphabet: A↔Z, B↔Y, and so on.',
    a1z26: 'Letters become their place in the alphabet (A=1 … Z=26).',
    morse: 'Dots and dashes; words are split by /.',
    reverse: 'Writes the whole text backwards.',
    bigear: 'Big Ear intensity code: 0–9, then A=10 … Z=35.',
    railfence: 'Writes the text in a zigzag across rails, then reads each rail.',
    upper: 'Uppercases everything. Lossy: case is lost.',
    lettersonly: 'Keeps letters only, uppercased. Lossy: spaces and punctuation go.',
  };
  var OP_GROUPS = [
    { label: 'Substitution', ops: ['caesar', 'vigenere', 'atbash', 'keyword'] },
    { label: 'Encoding', ops: ['a1z26', 'polybius', 'morse', 'bigear', 'numbase', 'bookcode'] },
    { label: 'Transposition', ops: ['reverse', 'railfence'] },
    { label: 'Clean-up', ops: ['upper', 'lettersonly'] },
  ];
  function opDesc(name) { var op = Kit.ops[name] || {}; return op.desc || OP_DESC[name] || op.label || name; }
  function opLabel(name) { var op = Kit.ops[name]; return op ? op.label : 'Unknown step "' + name + '"'; }
  function newStep(name) {
    var st = { op: name };
    ((Kit.ops[name] || {}).params || []).forEach(function (pr) { st[pr.key] = pr.def != null ? pr.def : ''; });
    return st;
  }

  /* ============================================================
     RECIPE VERIFICATION
     Kit.checkRecipe, plus: a normalised round trip when a step is
     lossy, steps that change nothing, missing book-code words.
     ============================================================ */
  function lettersOf(t) { return deaccent(t).toUpperCase().replace(/[^A-Z]/g, ''); }
  function foldsFor(steps) {
    var f = [];
    (steps || []).forEach(function (st) { var op = Kit.ops[st.op]; if (op && op.fold && f.indexOf(op.fold) < 0) f.push(op.fold); });
    return f;
  }
  function canon(s, folds) {
    var c = deaccent(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
    (folds || []).forEach(function (fn) { c = fn(c); });
    return c;
  }
  function firstDiff(a, b) { var n = Math.min(a.length, b.length); for (var i = 0; i < n; i++) if (a[i] !== b[i]) return i; return a.length === b.length ? -1 : n; }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function stepName(i, st) { return 'Step ' + (i + 1) + ' (' + opLabel(st.op) + ')'; }

  function verify(rec, opts) {
    opts = opts || {};
    var steps = (rec && rec.steps) || [], pt = String((rec && rec.plaintext) || '');
    var res = { state: 'none', problems: [], notes: [], stepIssues: {}, lossyOps: [], built: '', decoded: null };
    if (!steps.length) return res;
    var chk = Kit.checkRecipe({ plaintext: pt, steps: steps, output: opts.output != null ? opts.output : undefined });
    var enc = Kit.runRecipe(pt, steps, 'encode');
    res.built = enc.output;
    if (!pt.trim()) res.problems.push('The plaintext is empty. Type what the player should end up with.');
    if (enc.error) {
      res.problems.push(enc.error.replace(/^Unknown step "(.+)"$/, 'Step ' + (enc.trace.length + 1) + ' uses "$1", which this desk does not know.'));
      res.stepIssues[enc.trace.length] = enc.error;
      res.state = 'broken';
      return res;
    }
    chk.problems.forEach(function (p) {
      if (/does not give the plaintext back/.test(p)) return; /* reported below, with detail */
      res.problems.push(/stored output does not match/.test(p) ? 'The saved output no longer matches what these steps produce.' : p);
    });
    /* steps that change nothing */
    var identity = 0;
    enc.trace.forEach(function (tr, i) {
      var st = steps[i], op = Kit.ops[st.op] || {}, input = i === 0 ? pt : enc.trace[i - 1].out;
      if (op.lossy || tr.out !== input || !/[A-Za-z0-9]/.test(input)) return;
      var why = { vigenere: 'its key has no letters', caesar: 'a shift of 0 or 26 moves nothing', keyword: 'this keyword leaves the alphabet in order', railfence: 'the text is too short for this many rails' }[st.op];
      res.stepIssues[i] = 'This step changes nothing' + (why ? ': ' + why + '.' : '.');
      res.problems.push(stepName(i, st) + ' changes nothing' + (why ? ': ' + why + '.' : '.'));
      identity++;
    });
    if (!identity && pt.trim() && squash(enc.output) === squash(pt)) res.problems.push('The output is the same as the plaintext: the steps cancel each other out.');
    /* book code: words missing from the source */
    steps.forEach(function (st, i) {
      if (st.op !== 'bookcode') return;
      if (!String(st.source || '').trim()) { res.problems.push(stepName(i, st) + ' has no source text yet.'); res.stepIssues[i] = 'Paste the source text. Blank lines start a new page.'; return; }
      var out = (enc.trace[i] || {}).out || '';
      var miss = (out.match(/\?[^?\s]+\?/g) || []).map(function (m) { return m.slice(1, -1); });
      miss = miss.filter(function (m, k) { return miss.indexOf(m) === k; });
      if (miss.length) {
        var msg = plural(miss.length, 'word is', 'words are') + ' not in the source: ' + miss.slice(0, 6).join(', ') + (miss.length > 6 ? ', …' : '') + '.';
        res.problems.push(stepName(i, st) + ': ' + msg);
        res.stepIssues[i] = msg.charAt(0).toUpperCase() + msg.slice(1);
      }
    });
    /* round trip */
    var dec = Kit.runRecipe(enc.output, steps, 'decode');
    res.decoded = dec.output;
    var folds = foldsFor(steps);
    if (enc.lossy) {
      steps.forEach(function (st) { var op = Kit.ops[st.op]; if (op && op.lossy && res.lossyOps.indexOf(op.label) < 0) res.lossyOps.push(op.label); });
      var a = canon(dec.output, folds), b = canon(pt, folds);
      if (dec.error || a !== b) res.problems.push(tripMsg(dec, a, b, true));
      res.notes.push(res.lossyOps.join(', ') + (res.lossyOps.length === 1 ? ' is' : ' are') + ' lossy, so the round trip compares letters and digits only, ignoring case, spaces and punctuation' + (folds.length ? ', and reads J as I' : '') + '.');
    } else if (dec.error || squash(dec.output) !== squash(pt)) {
      var msg = tripMsg(dec, squash(dec.output), squash(pt), false);
      if (!dec.error && canon(dec.output) === canon(pt)) msg += ' Only spaces or punctuation differ: add a "Letters only" step first if that is intended.';
      res.problems.push(msg);
    }
    res.state = res.problems.length ? 'broken' : 'verified';
    return res;
  }
  function tripMsg(dec, got, want, letters) {
    if (dec.error) return 'Decoding fails: ' + dec.error + '.';
    var at = firstDiff(got, want);
    return 'Decoding the output does not give the plaintext back. It gives "' + clip(dec.output, 60) + '"' +
      (at >= 0 ? ' (first difference at the ' + ordinal(at + 1) + (letters ? ' letter' : ' character') + ').' : '.');
  }
  function storedState(p) {
    if (!p || !p.recipe || !(p.recipe.steps || []).length) return 'none';
    return verify(p.recipe, { output: p.recipe.output }).state;
  }
  /* The desk's recipe check. Kit.integrity (Problems) prefers this over Kit.checkRecipe when present,
     so the rail, the checks tab and the Problems list always agree, lossy ops included. */
  Kit.verifyRecipe = function (recipe) {
    try {
      if (!recipe || !Array.isArray(recipe.steps) || !recipe.steps.length) return { ok: true, state: 'none', problems: [], notes: [], built: null };
      var r = verify(recipe, { output: recipe.output });
      return { ok: r.state !== 'broken', state: r.state, problems: r.problems, notes: r.notes, built: r.built, roundTrip: r.decoded };
    } catch (err) {
      return { ok: false, state: 'broken', problems: ['The recipe could not be checked: ' + err.message], notes: [], built: null };
    }
  };

  /* ============================================================
     ANALYSIS
     ============================================================ */
  function chiFor(counts, N, shift) {
    var x = 0;
    for (var i = 0; i < 26; i++) {
      var o = counts[(i + shift) % 26], e = N * EN[i] / 100;
      x += (o - e) * (o - e) / e;
    }
    return x;
  }
  function shiftText(t, s) {
    return t.replace(/[A-Za-z]/g, function (c) { var up = c.toUpperCase(); return A[((A.indexOf(up) + s) % 26 + 26) % 26]; });
  }
  function iocOf(str) {
    var N = str.length; if (N < 2) return null;
    var c = new Array(26).fill(0), s = 0, i;
    for (i = 0; i < N; i++) c[A.indexOf(str[i])]++;
    for (i = 0; i < 26; i++) s += c[i] * (c[i] - 1);
    return s / (N * (N - 1));
  }
  /* ref = the plaintext, when known: it is "real English" at this length */
  function analyze(text, ref) {
    var t = String(text || ''), L = lettersOf(t), N = L.length, i;
    var counts = new Array(26).fill(0);
    for (i = 0; i < N; i++) counts[A.indexOf(L[i])]++;
    var an = { text: t, length: t.length, letters: N, words: (t.trim().match(/\S+/g) || []).length, counts: counts, ioc: iocOf(L) };
    var R = ref ? lettersOf(ref) : '';
    an.refChi = null;
    if (R.length >= 8) {
      var rc = new Array(26).fill(0);
      for (i = 0; i < R.length; i++) rc[A.indexOf(R[i])]++;
      an.refChi = chiFor(rc, R.length, 0);
    }
    an.threshold = an.refChi != null ? Math.max(an.refChi * 1.5, an.refChi + 15) : 40;
    an.shifts = [];
    if (N) {
      var refCanon = R ? canon(ref) : null;
      for (var s = 1; s <= 25; s++) {
        var chi = chiFor(counts, N, s);
        var dec = shiftText(t, -s);
        an.shifts.push({ shift: s, chi: chi, preview: dec.replace(/\s+/g, ' ').trim().slice(0, 80),
          intended: !!(refCanon && canon(dec) === refCanon), english: N >= 10 && chi <= an.threshold, close: N >= 10 && chi <= an.threshold * 1.6 });
      }
      var others = an.shifts.filter(function (x) { return !x.intended; }).slice().sort(function (a, b) { return a.chi - b.chi; });
      an.best = others[0] || null;
      an.intended = an.shifts.filter(function (x) { return x.intended; })[0] || null;
    }
    an.periods = [];
    for (var p = 1; p <= 12; p++) {
      if (N / p < 3) { an.periods.push({ p: p, ioc: null, ok: false }); continue; }
      var tot = 0, n = 0;
      for (var j = 0; j < p; j++) {
        var col = ''; for (var k = j; k < N; k += p) col += L[k];
        var v = iocOf(col); if (v != null) { tot += v; n++; }
      }
      an.periods.push({ p: p, ioc: n ? tot / n : null, ok: n > 0 });
    }
    an.top = an.periods.filter(function (x) { return x.ok; }).slice().sort(function (a, b) { return b.ioc - a.ioc; }).slice(0, 3);
    return an;
  }
  function iocGuide(v) {
    if (v == null) return { tone: 'neutral', short: 'not enough letters', text: 'Not enough letters to measure.' };
    if (v >= 0.058) return { tone: 'teal', short: 'English-like', text: 'Close to 0.066: this looks like English or a simple substitution (one alphabet, such as Caesar, Atbash or a keyword alphabet). Letter frequencies survive, so frequency analysis will work on it.' };
    if (v <= 0.045) return { tone: 'purple', short: 'flat', text: 'Close to 0.038: this looks polyalphabetic (such as Vigenère) or random. Frequencies are flattened, so a player needs the key or a key-length attack.' };
    return { tone: 'amber', short: 'in between', text: 'Between the English (0.066) and random (0.038) marks: a short text, a mixed cipher, or a transposition of a short message.' };
  }
  function shiftSummary(an) {
    if (!an.letters) return { tone: 'neutral', text: 'No letters to scan.' };
    var b = an.best, ref = an.refChi != null ? ' (your plaintext scores ' + Math.round(an.refChi) + ')' : '';
    var lead = an.intended ? 'Shift −' + an.intended.shift + ' gives back your plaintext: that is the intended solve. ' : '';
    if (!b) return { tone: 'teal', text: lead || 'No shifts to compare.' };
    if (b.english) return { tone: 'error', flag: true, text: lead + 'Shift −' + b.shift + ' reads like English (χ² ' + Math.round(b.chi) + ref + '). A player could stop there. Read it and make sure it gives no sensible answer.' };
    if (b.close) return { tone: 'amber', flag: true, text: lead + 'The best other shift, −' + b.shift + ', scores close to English (χ² ' + Math.round(b.chi) + ref + '). Read it to be sure it is gibberish.' };
    return { tone: 'teal', text: lead + 'No ' + (an.intended ? 'other ' : '') + 'shift reads as English. The closest is −' + b.shift + ' at χ² ' + Math.round(b.chi) + ref + '.' };
  }

  /* ============================================================
     PER-VIEWER MEMORY (working copies, last puzzle, tab), per game.
     The iframe shares localStorage with cade.txt, which runs close to
     its quota: one small key, drafts only while they hold unsaved
     changes, 20 KB at most (oldest drafts go first). The working copy
     is never written over a stored recipe; Save does that.
     ============================================================ */
  var MEM_KEY = 'argdesk-crafter-v3';
  var OLD_KEYS = ['arg-crafter-v1', 'argdesk-crafter', 'argdesk-crafter-v1', 'argdesk-crafter-v2'];
  var MEM_CAP = 20000;
  var store = { loaded: false, g: {} };
  var mem = { last: null, tab: 'bench', drafts: {} };   /* the slot of the game on screen */
  var SCRATCH_SEED = { plaintext: 'THE LEDGER HAS MORE PAGES THAN IDA ADMITS', steps: [{ op: 'keyword', keyword: 'MERIDIAN' }] };
  function loadStore() {
    if (store.loaded) return;
    store.loaded = true;
    try {
      OLD_KEYS.forEach(function (k) { if (localStorage.getItem(k) != null) localStorage.removeItem(k); });
      var raw = localStorage.getItem(MEM_KEY); if (!raw) return;
      var m = JSON.parse(raw);
      Object.keys((m && m.g) || {}).forEach(function (gid) {
        var o = m.g[gid] || {}, slot = { last: o.last || null, tab: o.tab || 'bench', drafts: {} };
        Object.keys(o.d || {}).forEach(function (k) {
          var c = o.d[k]; if (!c || typeof c !== 'object') return;
          slot.drafts[k] = { plaintext: String(c.p || ''), steps: Array.isArray(c.s) ? c.s : [], player: String(c.pl || ''), mode: c.m ? 'decode' : 'encode', clues: {}, base: null, t: +c.t || 0, restored: true };
        });
        store.g[gid] = slot;
      });
    } catch (e) { /* storage unavailable or corrupt: memory only */ }
  }
  function useGame(gid) {
    loadStore();
    gid = gid || '_';
    if (!store.g[gid]) store.g[gid] = { last: null, tab: 'bench', drafts: {} };
    mem = store.g[gid];
    return mem;
  }
  function worthKeeping(gid, k, d) {
    if (k === 'scratch') return recipeKey(d) !== recipeKey(SCRATCH_SEED) || !!d.player;
    if (gid !== Kit.games.current()) return true;                 /* another game's drafts were dirty when saved */
    var p = Kit.get(k);
    return !!(p && recipeKey(d) !== storedKey(p));               /* keep only unsaved work */
  }
  var memTimer = null;
  function saveMem(now) {
    clearTimeout(memTimer);
    if (now) writeMem(); else memTimer = setTimeout(writeMem, 300);
  }
  function writeMem() {
    clearTimeout(memTimer);
    var games = {}; try { Kit.games.list().forEach(function (g) { games[g.id] = 1; }); } catch (e) { /* no registry */ }
    var out = { g: {} }, list = [];
    Object.keys(store.g).forEach(function (gid) {
      if (gid !== '_' && !games[gid]) return;                     /* the game was deleted */
      var s = store.g[gid], o = { d: {} };
      if (s.last) o.last = s.last;
      if (s.tab && s.tab !== 'bench') o.tab = s.tab;
      Object.keys(s.drafts).forEach(function (k) {
        var d = s.drafts[k];
        if (!worthKeeping(gid, k, d)) return;
        var c = { p: d.plaintext, s: d.steps, t: d.t || 0 };
        if (d.mode === 'decode') c.m = 1;
        if (d.player) c.pl = d.player;
        o.d[k] = c; list.push({ gid: gid, k: k, t: c.t });
      });
      if (!Object.keys(o.d).length) delete o.d;
      if (o.last || o.tab || o.d) out.g[gid] = o;
    });
    var str = JSON.stringify(out);
    list.sort(function (a, b) { return a.t - b.t; });
    while (str.length > MEM_CAP && list.length) {
      var x = list.shift(); delete out.g[x.gid].d[x.k];
      str = JSON.stringify(out);
    }
    try {
      if (!Object.keys(out.g).length) localStorage.removeItem(MEM_KEY);
      else localStorage.setItem(MEM_KEY, str);
    } catch (e) { /* quota or storage off: the working copy stays in memory */ }
  }
  function normSteps(steps) {
    return (steps || []).map(function (st) { var o = { op: st.op }; Object.keys(st).sort().forEach(function (k) { if (k !== 'op') o[k] = st[k]; }); return o; });
  }
  function recipeKey(r) { r = r || {}; return JSON.stringify({ p: r.plaintext || '', s: normSteps(r.steps) }); }
  function storedKey(p) { return recipeKey(p && p.recipe); }
  function getDraft(pid) {
    var key = pid || 'scratch', d = mem.drafts[key];
    if (!d) {
      var src = pid ? ((Kit.get(pid) || {}).recipe || {}) : SCRATCH_SEED;
      d = mem.drafts[key] = { plaintext: src.plaintext || '', steps: clone(src.steps || []), player: '', mode: 'encode', clues: {}, base: pid ? storedKey(Kit.get(pid)) : null, t: 0 };
    }
    if (pid && d.restored) { d.restored = false; d.base = storedKey(Kit.get(pid)); }  /* restored unsaved work stays unsaved */
    if (!d.clues) d.clues = {};
    if (!Array.isArray(d.steps)) d.steps = [];
    return d;
  }
  function touch(d) { d.t = Date.now(); }
  /* stored recipe changed elsewhere (another device, import, undo): a clean working copy follows it */
  function syncDraft(pid) {
    var p = Kit.get(pid), d = mem.drafts[pid];
    if (!p || !d || d.restored) return false;
    var sk = storedKey(p);
    if (d.base === sk) return false;
    var clean = recipeKey(d) === d.base;
    d.base = sk;
    if (clean) { var r = p.recipe || {}; d.plaintext = r.plaintext || ''; d.steps = clone(r.steps || []); return true; }
    return false;
  }
  function isDirty(pid) {
    if (!pid) return false;
    var d = mem.drafts[pid], p = Kit.get(pid);
    return !!(d && p && recipeKey(d) !== storedKey(p));
  }

  /* ============================================================
     SMALL RENDER HELPERS
     ============================================================ */
  var IC = {
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  };
  var RSTATE = {
    verified: { label: 'verified', title: 'Recipe verified: it builds and decodes back to the plaintext' },
    broken: { label: 'broken', title: 'Recipe has problems' },
    none: { label: '', title: 'No recipe' },
  };
  function kindLabel(k) { var x = D.puzzleKinds.find(function (y) { return y.id === k; }); return x ? x.label : (k || '—'); }
  function chapterLabel(cid) { var c = Kit.chapter(cid); return c ? 'Ch ' + c.n + ' · ' + c.title : 'No chapter'; }
  function captureFocus(container) {
    var a = document.activeElement;
    if (!a || !container.contains(a)) return null;
    var key = a.getAttribute('data-fk'); if (!key) return null;
    var f = { key: key, sel: null };
    try { if (typeof a.selectionStart === 'number') f.sel = [a.selectionStart, a.selectionEnd]; } catch (e) { /* number inputs */ }
    return f;
  }
  function restoreFocus(container, f) {
    if (!f) return;
    var el = container.querySelector('[data-fk="' + CSS.escape(f.key) + '"]');
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    if (f.sel) { try { el.setSelectionRange(f.sel[0], f.sel[1]); } catch (e) { /* ignore */ } }
  }
  function isTextField(el) { return !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|number|)$/.test(el.type || ''))); }

  /* ============================================================
     THE VIEW
     ============================================================ */
  Desk.registerView({
    id: 'crafter', title: 'Puzzle crafter',
    routes: function (t) {
      if (t === 'crafter') return {};
      if (t === 'crafter.scratch') return { scratch: true };
      var m = /^crafter\.(.+)$/.exec(t);
      return m ? { puzzle: m[1] } : null;
    },
    mount: function (root, params, ctx) {
      useGame(Kit.games.current());
      var S = { pid: null, tab: mem.tab || 'bench', q: '', menuOpen: false, expanded: {}, other: false, otherText: '', tableOpen: false, external: false, pathStale: false, alive: true };
      var own = 0, pending = null, timers = {}, rafId = 0, lastAn = null, saveSig = '';

      root.innerHTML =
        '<div class="cf">' +
          '<aside class="cf-rail" aria-label="Puzzles">' +
            '<div class="cf-rail-head"><span class="eyebrow">Puzzles</span>' +
              '<label class="cf-search">' + IC.search + '<input type="search" class="input" data-in="q" data-fk="q" placeholder="Filter by id, title or kind" aria-label="Filter puzzles" autocomplete="off" spellcheck="false"></label></div>' +
            '<div class="cf-rail-list scroll" id="cf-list"></div>' +
          '</aside>' +
          '<section class="cf-main scroll" id="cf-main">' +
            '<div class="cf-pick" id="cf-pick"></div>' +
            '<header class="cf-head" id="cf-head"></header>' +
            '<div class="cf-tabs" id="cf-tabs" role="tablist" aria-label="Crafter sections"></div>' +
            '<div class="cf-panel" id="cf-panel" role="tabpanel"></div>' +
          '</section>' +
        '</div>' +
        '<div class="cf-tip" role="tooltip" hidden></div>';
      var el = {
        list: root.querySelector('#cf-list'), main: root.querySelector('#cf-main'), pick: root.querySelector('#cf-pick'),
        head: root.querySelector('#cf-head'), tabs: root.querySelector('#cf-tabs'), panel: root.querySelector('#cf-panel'), tip: root.querySelector('.cf-tip'),
      };

      function puzzle() { return S.pid ? Kit.get(S.pid) : null; }
      function draft() { return getDraft(S.pid); }
      function ownUpdate(fn) { own++; try { fn(); } finally { own--; } }
      /* last puzzle used here; else the first puzzle with a recipe; an empty game opens the scratchpad */
      function defaultPid() {
        if (!D.puzzles.length || mem.last === 'scratch') return null;
        if (mem.last && Kit.type(mem.last) === 'puzzle') return mem.last;
        var order = Kit.puzzleOrder();
        var withRecipe = order.filter(function (p) { return p.recipe && (p.recipe.steps || []).length; })[0];
        return (withRecipe || order[0]).id;
      }
      function resolve(prm) {
        if (prm && prm.scratch) return null;
        if (prm && prm.puzzle && Kit.get(prm.puzzle) && Kit.type(prm.puzzle) === 'puzzle') return prm.puzzle;
        return defaultPid();
      }
      function go(pidOrScratch) { Desk.go('crafter.' + (pidOrScratch || 'scratch'), { replace: true }); }

      /* ---------- pending text edits (debounced Kit.update) ---------- */
      function queueField(field, value) {
        if (!S.pid) return;
        if (pending && pending.pid !== S.pid) flush();
        if (!pending) pending = { pid: S.pid, patch: {} };
        pending.patch[field] = value;
        clearTimeout(timers.flush);
        timers.flush = setTimeout(flush, 450);
      }
      function flush() {
        clearTimeout(timers.flush);
        if (!pending) return;
        var p = pending; pending = null;
        if (Kit.get(p.pid)) ownUpdate(function () { Kit.update(p.pid, p.patch); });
      }

      /* ============================================================
         RAIL + PHONE PICKER
         ============================================================ */
      /* chapters → events → puzzles; unplaced events and puzzles without an event at the end */
      function hasEvent(p) { return !!(p.event && Kit.type(p.event) === 'event'); }
      function groups(filter) {
        var out = [];
        function evGroup(ev) { return { ev: ev, ps: Kit.puzzlesInEvent(ev.id).filter(filter) }; }
        Kit.chapters().forEach(function (ch) {
          var evs = Kit.eventsIn(ch.id).map(evGroup).filter(function (g) { return g.ps.length; });
          if (evs.length) out.push({ label: chapterLabel(ch.id), events: evs });
        });
        var loose = Kit.eventsIn(null).map(evGroup).filter(function (g) { return g.ps.length; });
        if (loose.length) out.push({ label: 'Not in a chapter yet', events: loose });
        var none = Kit.puzzleOrder().filter(function (p) { return !hasEvent(p) && filter(p); });
        if (none.length) out.push({ label: 'No event', events: [{ ev: null, ps: none }] });
        return out;
      }
      function matches(q) {
        return function (p) { return !q || (p.id + ' ' + p.title + ' ' + p.kind + ' ' + kindLabel(p.kind) + ' ' + (hasEvent(p) ? Kit.label(p.event) : '')).toLowerCase().indexOf(q) >= 0; };
      }
      function firstEvent() {
        var chs = Kit.chapters();
        for (var i = 0; i < chs.length; i++) { var evs = Kit.eventsIn(chs[i].id); if (evs.length) return evs[0]; }
        return Kit.eventsIn(null)[0] || null;
      }
      function newPuzzleBlock(where) {
        var ev = firstEvent(), ch = Kit.chapters()[0];
        var dest = ev ? 'It goes into ' + ev.title + ' (' + ev.id + '); move it to another event later.'
          : 'A first event is added to ' + (ch ? chapterLabel(ch.id) : 'the game') + ' to hold it.';
        return '<div class="cf-nop">' +
          '<p class="cf-nop-t">No puzzles yet — add one in the Trail or Codex.</p>' +
          '<p class="cf-nop-s">Or start one here and build its cipher on the bench. ' + esc(dest) + '</p>' +
          '<div class="cf-np"><input type="text" class="input" data-np="' + where + '" data-fk="np-' + where + '" placeholder="Puzzle title" aria-label="New puzzle title" autocomplete="off" spellcheck="false">' +
          '<button type="button" class="btn sm primary" data-act="np-create" data-where="' + where + '">Create puzzle</button></div>' +
        '</div>';
      }
      function renderRail() {
        var q = S.q.trim().toLowerCase(), html = '';
        var scratchOn = S.pid === null;
        if (!q || 'scratchpad'.indexOf(q) >= 0) {
          html += '<button type="button" class="cf-row cf-row-scratch" data-act="pick" data-id="scratch"' + (scratchOn ? ' aria-current="page"' : '') + '>' +
            '<span class="cf-row-top"><span class="cf-row-ico">SCR</span><span class="cf-row-t">Scratchpad</span></span>' +
            '<span class="cf-row-meta">Try a cipher without touching a puzzle</span></button>';
        }
        if (!D.puzzles.length) {
          var f0 = captureFocus(el.list);
          el.list.innerHTML = html + newPuzzleBlock('rail');
          restoreFocus(el.list, f0);
          return;
        }
        var shown = 0;
        groups(matches(q)).forEach(function (g) {
          html += '<div class="cf-grp"><span class="eyebrow">' + esc(g.label) + '</span></div>';
          g.events.forEach(function (eg) {
            if (eg.ev) html += '<div class="cf-evh" title="' + esc(eg.ev.id + ' · ' + eg.ev.title) + '">' + Kit.layerDot(eg.ev.layer) + '<span class="cf-evh-id">' + esc(eg.ev.id) + '</span><span class="cf-evh-t">' + esc(eg.ev.title) + '</span></div>';
            eg.ps.forEach(function (p) {
              shown++;
              var rs = storedState(p), on = p.id === S.pid;
              html += '<button type="button" class="cf-row" data-act="pick" data-id="' + esc(p.id) + '"' + (on ? ' aria-current="page"' : '') + '>' +
                '<span class="cf-row-top"><span class="cf-row-id">' + esc(p.id) + '</span><span class="cf-row-t">' + esc(p.title || 'Untitled puzzle') + '</span>' +
                '<span class="cf-dot" data-dirty="' + esc(p.id) + '"' + (isDirty(p.id) ? '' : ' hidden') + ' title="Unsaved recipe changes"></span></span>' +
                '<span class="cf-row-meta">' + Kit.pips(p.status) + '<span class="cf-row-kind">' + esc(kindLabel(p.kind)) + '</span>' +
                (rs !== 'none' ? '<span class="cf-rs cf-rs-' + rs + '" title="' + esc(RSTATE[rs].title) + '">' + RSTATE[rs].label + '</span>' : '') + '</span></button>';
            });
          });
        });
        if (q && !shown) html += '<p class="cf-empty">No puzzle matches "' + esc(S.q) + '".</p>';
        var st = el.list.scrollTop;
        el.list.innerHTML = html;
        el.list.scrollTop = st;
      }
      function renderPick() {
        var f = captureFocus(el.pick);
        if (!D.puzzles.length) { el.pick.innerHTML = newPuzzleBlock('phone'); restoreFocus(el.pick, f); return; }
        var html = '<option value="scratch"' + (S.pid === null ? ' selected' : '') + '>Scratchpad</option>';
        groups(function () { return true; }).forEach(function (g) {
          g.events.forEach(function (eg) {
            html += '<optgroup label="' + esc(g.label + (eg.ev ? ' › ' + eg.ev.title : '')) + '">' + eg.ps.map(function (p) {
              var rs = storedState(p);
              return '<option value="' + esc(p.id) + '"' + (p.id === S.pid ? ' selected' : '') + '>' + esc(p.id + ' · ' + (p.title || 'Untitled puzzle')) + (rs !== 'none' ? ' — recipe ' + rs : '') + (isDirty(p.id) ? ' (unsaved)' : '') + '</option>';
            }).join('') + '</optgroup>';
          });
        });
        el.pick.innerHTML = '<label class="field-label" for="cf-pick-sel">Puzzle</label><select class="input" id="cf-pick-sel" data-ch="pick" data-fk="pick">' + html + '</select>';
        restoreFocus(el.pick, f);
      }

      /* ============================================================
         HEADER + TABS + STATUS
         ============================================================ */
      function renderHeader() {
        var f = captureFocus(el.head), p = puzzle();
        if (!p) {
          el.head.innerHTML = '<div class="cf-head-l"><span class="eyebrow">Puzzle crafter</span>' +
            '<h1 class="cf-title"><span>Scratchpad</span></h1>' +
            '<p class="cf-sub">Not tied to a puzzle. Try a cipher here, then save it to a puzzle when it works.</p></div>' +
            '<div class="cf-head-r"><button type="button" class="btn sm" data-act="export-game" title="Export the whole game for an LLM">' + Kit.ICONS.exportIcon + 'Export the game…</button></div>';
          return;
        }
        var statusSel = '<select class="input cf-status" data-ch="status" data-fk="status" aria-label="Status">' +
          D.statuses.map(function (s) { return '<option value="' + s.id + '"' + (s.id === p.status ? ' selected' : '') + '>' + esc(s.label) + '</option>'; }).join('') + '</select>';
        el.head.innerHTML = '<div class="cf-head-l">' +
            '<div class="cf-crumbs"><span class="eyebrow">' + esc(hasEvent(p) ? chapterLabel(Kit.get(p.event).chapter) : 'Puzzle crafter') + '</span>' +
              (hasEvent(p) ? '<span class="cf-crumb-sep" aria-hidden="true">›</span><span class="cf-crumb-ev">' + Kit.refHtml(p.event) + '</span>'
                : '<span class="chip tone-amber" title="Puzzles sit inside events. Pick one on the puzzle page.">No event yet</span>') + '</div>' +
            '<h1 class="cf-title"><span class="cf-title-t">' + esc(p.title || 'Untitled puzzle') + '</span><span class="id">' + esc(p.id) + '</span>' + (p.final ? '<span class="chip tone-amber">finale</span>' : '') + '</h1>' +
            '<div class="cf-meta">' +
              '<span class="cf-meta-i"><span class="cf-k">Kind</span>' + esc(kindLabel(p.kind)) + '</span>' +
              '<span class="cf-meta-i"><span class="cf-k">Difficulty</span>' + Kit.diff(p.difficulty || 0) + '</span>' +
              (p.estMin ? '<span class="cf-meta-i"><span class="cf-k">Solve</span><span class="mono">~' + esc(Kit.fmtMinutes(p.estMin)) + '</span></span>' : '') +
              '<span class="cf-meta-i cf-meta-status"><span class="cf-k">Status</span>' + Kit.pips(p.status) + statusSel + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="cf-head-r">' +
            '<button type="button" class="btn sm" data-act="open-page">' + IC.out + 'Open page</button>' +
            '<button type="button" class="btn sm" data-act="open-trail">' + IC.out + 'Open in Trail</button>' +
            '<button type="button" class="btn sm" data-act="export" title="Export this puzzle and everything linked to it">' + Kit.ICONS.exportIcon + '<span>Export<span class="cf-long"> this puzzle for an LLM</span>…</span></button>' +
          '</div>';
        restoreFocus(el.head, f);
      }
      var TABS = [['bench', 'Cipher bench'], ['path', 'Solve path'], ['checks', 'Checks']];
      function renderTabs() {
        var p = puzzle(), f = captureFocus(el.tabs);
        if (!p) S.tab = 'bench';
        el.tabs.innerHTML = TABS.filter(function (t) { return p || t[0] === 'bench'; }).map(function (t) {
          var extra = '';
          if (t[0] === 'bench') extra = '<span class="cf-dot" data-dirty="tab"' + (isDirty(S.pid) ? '' : ' hidden') + ' title="Unsaved recipe changes"></span>';
          if (t[0] === 'path' && p) extra = '<span class="cf-tab-n">' + (p.solvePath || []).filter(Boolean).length + '</span>';
          if (t[0] === 'checks' && p) extra = '<span class="cf-tab-n">' + (p.checks || []).filter(function (c) { return D.designChecks.some(function (d) { return d.id === c; }); }).length + '/' + D.designChecks.length + '</span>';
          var on = S.tab === t[0];
          return '<button type="button" role="tab" class="cf-tab" id="cf-tab-' + t[0] + '" aria-controls="cf-panel" data-act="tab" data-tab="' + t[0] + '" data-fk="tab-' + t[0] + '" aria-selected="' + on + '" tabindex="' + (on ? 0 : -1) + '">' + t[1] + extra + '</button>';
        }).join('') + (p ? '' : '<span class="cf-tabs-note">Solve path and checks belong to a puzzle.</span>');
        el.panel.setAttribute('aria-labelledby', 'cf-tab-' + S.tab);
        restoreFocus(el.tabs, f);
      }
      function setStatus() {
        var p = puzzle(), d = draft();
        if (!p) { ctx.setStatus(['Puzzle crafter', 'Scratchpad', plural(d.steps.length, 'step'), 'Not saved to the game until you save it to a puzzle']); return; }
        var rs = storedState(p);
        ctx.setStatus(['Puzzle crafter', p.id + ' · ' + p.title,
          rs === 'none' ? 'No saved recipe' : 'Saved recipe ' + rs,
          plural(d.steps.length, 'step') + ' on the bench',
          'Solve path ' + plural((p.solvePath || []).length, 'step'),
          'Checks ' + (p.checks || []).length + '/' + D.designChecks.length,
          isDirty(S.pid) ? 'Unsaved recipe changes' : null]);
      }
      function updateDirtyMarks() {
        var dirty = isDirty(S.pid);
        Array.prototype.forEach.call(root.querySelectorAll('[data-dirty]'), function (n) {
          var k = n.getAttribute('data-dirty');
          n.hidden = k === 'tab' || k === 'bench' ? !dirty : !isDirty(k);
        });
      }

      /* ============================================================
         CIPHER BENCH
         ============================================================ */
      function paramHtml(st, i, pr) {
        var v = st[pr.key] != null ? st[pr.key] : (pr.def != null ? pr.def : '');
        var id = 'cf-p-' + i + '-' + pr.key, fk = 's' + i + '-' + pr.key;
        var common = ' id="' + id + '" data-in="param" data-i="' + i + '" data-k="' + esc(pr.key) + '" data-fk="' + fk + '"';
        var ctl;
        if (pr.type === 'longtext') ctl = '<textarea class="input doc cf-longtext" rows="5"' + common + ' spellcheck="false" placeholder="Paste the source text. Blank lines start a new page.">' + esc(v) + '</textarea>';
        else if (pr.type === 'select') ctl = '<select class="input"' + common.replace('data-in="param"', 'data-ch="param"') + '>' + (pr.options || []).map(function (o) {
          var val = Array.isArray(o) ? o[0] : o, lab = Array.isArray(o) ? o[1] : o;
          return '<option value="' + esc(val) + '"' + (String(val) === String(v) ? ' selected' : '') + '>' + esc(lab) + '</option>';
        }).join('') + '</select>';
        else if (pr.type === 'number') ctl = '<input type="number" inputmode="numeric" class="input mono cf-num"' + common + ' value="' + esc(v) + '">';
        else ctl = '<input type="text" class="input mono"' + common + ' value="' + esc(v) + '" spellcheck="false" autocomplete="off">';
        return '<div class="cf-param' + (pr.type === 'longtext' ? ' wide' : '') + '"><label for="' + id + '">' + esc(pr.label || pr.key) + '</label>' + ctl + '</div>';
      }
      function stepCard(st, i, n, mode) {
        var op = Kit.ops[st.op], ps = op ? (op.params || []) : [];
        var upD = mode === 'encode' ? -1 : 1;           /* visual up */
        var canUp = i + upD >= 0 && i + upD < n, canDown = i - upD >= 0 && i - upD < n;
        return '<div class="cf-step' + (op ? '' : ' bad') + '" data-i="' + i + '">' +
          '<div class="cf-step-h">' +
            '<span class="cf-step-n" title="Step ' + (i + 1) + ' of the recipe">' + (i + 1) + '</span>' +
            (mode === 'decode' ? '<span class="cf-step-dir">undo</span>' : '') +
            '<span class="cf-step-op">' + esc(opLabel(st.op)) + '</span>' +
            (op && op.lossy ? '<span class="chip tone-amber" title="Lossy: decoding cannot restore everything this step removes">lossy</span>' : '') +
            '<span class="cf-step-tools">' +
              '<button type="button" class="cf-ib" data-act="step-move" data-i="' + i + '" data-d="' + upD + '" data-fk="s' + i + '-up" aria-label="Move step ' + (i + 1) + ' up"' + (canUp ? '' : ' disabled') + '>' + IC.up + '</button>' +
              '<button type="button" class="cf-ib" data-act="step-move" data-i="' + i + '" data-d="' + (-upD) + '" data-fk="s' + i + '-down" aria-label="Move step ' + (i + 1) + ' down"' + (canDown ? '' : ' disabled') + '>' + IC.down + '</button>' +
              '<button type="button" class="cf-ib danger" data-act="step-rm" data-i="' + i + '" data-fk="s' + i + '-rm" aria-label="Remove step ' + (i + 1) + '">' + IC.x + '</button>' +
            '</span>' +
          '</div>' +
          (ps.length ? '<div class="cf-params">' + ps.map(function (pr) { return paramHtml(st, i, pr); }).join('') + '</div>' : '') +
          '<p class="cf-step-desc">' + esc(op ? opDesc(st.op) : 'Remove this step or import the op it needs.') + '</p>' +
          '<div class="cf-step-issue" hidden></div>' +
          '<div class="cf-prev' + (S.expanded[i] ? ' open' : '') + '"><span class="cf-prev-l">' + (mode === 'encode' ? 'gives' : 'undone') + '</span><code class="cf-prev-t"></code>' +
            '<button type="button" class="cf-prev-more" data-act="expand" data-i="' + i + '" hidden>' + (S.expanded[i] ? 'Show less' : 'Show all') + '</button></div>' +
        '</div>';
      }
      function opMenuHtml() {
        var listed = {}, html = '';
        OP_GROUPS.forEach(function (g) {
          var ops = g.ops.filter(function (k) { return Kit.ops[k]; });
          if (!ops.length) return;
          html += '<div class="cf-menu-g"><span class="eyebrow">' + esc(g.label) + '</span>' + ops.map(function (k) { listed[k] = 1; return opItem(k); }).join('') + '</div>';
        });
        var rest = Object.keys(Kit.ops).filter(function (k) { return !listed[k]; });
        if (rest.length) html += '<div class="cf-menu-g"><span class="eyebrow">Other</span>' + rest.map(opItem).join('') + '</div>';
        return html;
        function opItem(k) {
          return '<button type="button" role="menuitem" class="cf-menu-i" data-act="add-op" data-op="' + esc(k) + '" data-fk="op-' + esc(k) + '">' +
            '<span class="cf-menu-t">' + esc(Kit.ops[k].label) + (Kit.ops[k].lossy ? ' <span class="cf-menu-lossy">lossy</span>' : '') + '</span>' +
            '<span class="cf-menu-d">' + esc(opDesc(k)) + '</span></button>';
        }
      }
      function renderSteps() {
        var d = draft(), box = el.panel.querySelector('#cf-steps'); if (!box) return;
        var f = captureFocus(box), n = d.steps.length, order = d.steps.map(function (_, i) { return i; });
        if (d.mode === 'decode') order.reverse();
        box.innerHTML = n ? order.map(function (i, k) {
          return (k ? '<div class="cf-flow" aria-hidden="true"></div>' : '') + stepCard(d.steps[i], i, n, d.mode);
        }).join('') : '<div class="cf-nosteps">No steps yet. ' + (d.mode === 'encode' ? 'Add one below to turn the plaintext into a cipher.' : 'Switch to Build to add steps.') + '</div>';
        restoreFocus(box, f);
      }
      function renderBench() {
        var p = puzzle(), d = draft(), enc = d.mode === 'encode';
        var mainScroll = el.main.scrollTop, f = captureFocus(el.panel);
        var clueFill = p ? (p.inputs || []).map(Kit.get).filter(function (c) { return c && c.kind === 'text'; }) : [];
        el.panel.innerHTML =
          '<div class="cf-bench">' +
            '<div class="cf-work">' +
              '<div class="cf-toolbar">' +
                '<div class="seg cf-mode" role="group" aria-label="Mode">' +
                  '<button type="button" data-act="mode" data-mode="encode" data-fk="mode-encode" aria-pressed="' + enc + '">Build (encode)</button>' +
                  '<button type="button" data-act="mode" data-mode="decode" data-fk="mode-decode" aria-pressed="' + !enc + '">Test a solve (decode)</button>' +
                '</div>' +
                '<span class="cf-dirty" data-dirty="bench"' + (isDirty(S.pid) ? '' : ' hidden') + '>Unsaved changes</span>' +
              '</div>' +
              (enc
                ? '<div class="cf-io"><div class="cf-io-h"><label for="cf-pt" class="cf-io-l">Plaintext</label><span class="cf-io-n" id="cf-pt-n"></span></div>' +
                    '<textarea id="cf-pt" class="input cf-mono cf-ta" rows="3" data-in="pt" data-fk="pt" spellcheck="false" placeholder="What the player should end up reading">' + esc(d.plaintext) + '</textarea></div>'
                : '<div class="cf-io"><div class="cf-io-h"><label for="cf-player" class="cf-io-l">Text the player sees</label><span class="cf-io-n" id="cf-player-n"></span></div>' +
                    '<textarea id="cf-player" class="input cf-mono cf-ta" rows="3" data-in="player" data-fk="player" spellcheck="false" placeholder="Paste the text exactly as a player would see it">' + esc(d.player) + '</textarea>' +
                    '<div class="cf-fill"><span class="faint">Fill with</span><button type="button" class="btn sm ghost" data-act="fill-built">the built output</button>' +
                      clueFill.map(function (c) { return '<button type="button" class="btn sm ghost" data-act="fill-clue" data-id="' + esc(c.id) + '">' + esc(c.id) + ' text</button>'; }).join('') + '</div></div>') +
              '<div class="cf-flow" aria-hidden="true"></div>' +
              '<div class="cf-steps" id="cf-steps"></div>' +
              (enc ? '<div class="cf-add"><button type="button" class="btn sm" data-act="add-open" data-fk="add-open" aria-expanded="' + S.menuOpen + '" aria-controls="cf-menu">' + IC.plus + 'Add step</button>' +
                '<div class="cf-menu" id="cf-menu" role="menu" aria-label="Steps you can add"' + (S.menuOpen ? '' : ' hidden') + '>' + opMenuHtml() + '</div></div>' : '') +
              '<div class="cf-flow" aria-hidden="true"></div>' +
              '<div class="cf-io cf-out"><div class="cf-io-h"><span class="cf-io-l">' + (enc ? 'Output' : 'What the player gets') + '</span><span class="cf-io-n" id="cf-out-n"></span>' +
                '<button type="button" class="btn sm" data-act="copy-out" data-fk="copy-out">' + IC.copy + 'Copy</button></div>' +
                '<pre class="cf-outbox" id="cf-out" tabindex="0" aria-live="polite"></pre>' +
                (enc ? '' : '<div class="cf-cmp" id="cf-cmp"></div>') + '</div>' +
              '<div class="cf-verify" id="cf-verify" aria-live="polite"></div>' +
              '<div class="cf-save" id="cf-save"></div>' +
            '</div>' +
            '<aside class="cf-an" aria-label="Analysis">' +
              '<div class="cf-an-head"><span class="cf-an-title">Analysis</span>' +
                '<label class="cf-switch"><input type="checkbox" data-ch="other-on" data-fk="other-on"' + (S.other ? ' checked' : '') + '><span>Analyze other text</span></label></div>' +
              '<textarea class="input cf-mono cf-ta cf-other" rows="3" data-in="other" data-fk="other" spellcheck="false" placeholder="Paste any text to analyze"' + (S.other ? '' : ' hidden') + ' aria-label="Text to analyze">' + esc(S.otherText) + '</textarea>' +
              '<div class="cf-an-body" id="cf-an"></div>' +
            '</aside>' +
          '</div>';
        saveSig = '';
        renderSteps();
        recompute(true);
        restoreFocus(el.panel, f);
        el.main.scrollTop = mainScroll;
      }

      /* live recompute: previews, output, verification, save bar, analysis */
      function recompute(immediateAnalysis) {
        var d = draft(), box = el.panel.querySelector('#cf-steps'); if (!box) return;
        var enc = d.mode === 'encode', input = enc ? d.plaintext : d.player;
        var run = Kit.runRecipe(input, d.steps, d.mode);
        var n = d.steps.length, ver = verify({ plaintext: d.plaintext, steps: d.steps });
        var built = ver.built != null && n ? ver.built : (Kit.runRecipe(d.plaintext, d.steps, 'encode').output);
        Array.prototype.forEach.call(box.querySelectorAll('.cf-step'), function (card) {
          var i = +card.dataset.i, k = enc ? i : n - 1 - i, tr = run.trace[k];
          var pre = card.querySelector('.cf-prev-t'), more = card.querySelector('.cf-prev-more'), iss = card.querySelector('.cf-step-issue');
          if (tr) { pre.textContent = tr.out === '' ? '(empty)' : tr.out; card.classList.remove('failed'); }
          else if (run.error && k === run.trace.length) { pre.textContent = run.error; card.classList.add('failed'); }
          else { pre.textContent = '—'; }
          var issue = enc ? ver.stepIssues[i] : null;
          iss.hidden = !issue; iss.textContent = issue || '';
          card.classList.toggle('warn', !!issue);
          more.hidden = !S.expanded[i] && !(pre.scrollHeight > pre.clientHeight + 2);
        });
        var out = el.panel.querySelector('#cf-out');
        out.textContent = run.output || '';
        out.classList.toggle('empty', !run.output);
        if (!run.output) out.textContent = enc ? 'The output appears here as you type.' : 'Paste the text a player sees above.';
        var cnt = function (s) { var t = String(s || ''); return t.length + ' chars · ' + lettersOf(t).length + ' letters'; };
        var ptn = el.panel.querySelector(enc ? '#cf-pt-n' : '#cf-player-n'); if (ptn) ptn.textContent = cnt(input);
        el.panel.querySelector('#cf-out-n').textContent = run.output ? cnt(run.output) : '';
        if (!enc) {
          var cmp = el.panel.querySelector('#cf-cmp'), folds = foldsFor(d.steps);
          if (!d.player.trim()) { cmp.className = 'cf-cmp'; cmp.textContent = ''; }
          else if (run.error) { cmp.className = 'cf-cmp bad'; cmp.textContent = 'Decoding stops: ' + run.error; }
          else {
            var a = canon(run.output, folds), b = canon(d.plaintext, folds), at = firstDiff(a, b);
            if (at < 0) { cmp.className = 'cf-cmp ok'; cmp.textContent = squash(run.output) === squash(d.plaintext) ? 'Matches the plaintext exactly.' : 'Matches the plaintext, comparing letters and digits only.'; }
            else { cmp.className = 'cf-cmp bad'; cmp.textContent = 'Differs from the plaintext at the ' + ordinal(at + 1) + ' letter: gets "' + (a[at] || 'nothing') + '", the plaintext has "' + (b[at] || 'nothing') + '".'; }
          }
        }
        renderVerify(ver, d);
        renderSave(ver, built);
        updateDirtyMarks();
        setStatus();
        saveMem();
        S.anText = S.other ? S.otherText : (enc ? built : d.player);
        S.anRef = S.other ? null : d.plaintext;
        if (immediateAnalysis) renderAnalysis();
        else { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(renderAnalysis); }
      }
      function renderVerify(ver, d) {
        var box = el.panel.querySelector('#cf-verify'); if (!box) return;
        var cls = 'cf-verify', html;
        if (!d.steps.length) { cls += ' none'; html = '<span class="cf-v-k">Check</span><span>Add a step to build a cipher. The round trip is checked as you type.</span>'; }
        else if (ver.state === 'verified') {
          cls += ' ok';
          html = '<span class="cf-v-k">Check</span><span><b>Round trip OK:</b> decoding the output gives the plaintext back.</span>';
        } else {
          cls += ' bad';
          html = '<span class="cf-v-k">Check</span><span><b>' + (ver.problems.length === 1 ? 'One problem' : ver.problems.length + ' problems') + '</b><ul>' + ver.problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></span>';
        }
        if (ver.notes.length) html += '<span class="cf-v-note">' + ver.notes.map(esc).join(' ') + '</span>';
        box.className = cls; box.innerHTML = html;
        box.setAttribute('data-state', !d.steps.length ? 'none' : ver.state);
      }
      function renderSave(ver, built) {
        var box = el.panel.querySelector('#cf-save'); if (!box) return;
        var p = puzzle(), d = draft();
        if (!p) {
          var sig0 = 'scratch|' + d.steps.length;
          if (sig0 === saveSig) return; saveSig = sig0;
          box.innerHTML = '<div class="cf-save-row"><button type="button" class="btn primary" data-act="save-to" data-fk="save-to"' + (d.steps.length ? '' : ' disabled') + '>Save to a puzzle…</button>' +
            '<span class="cf-save-note">The scratchpad stays in this browser. Saving copies the plaintext, steps and output into the puzzle you pick.</span></div>';
          return;
        }
        var dirty = isDirty(S.pid), hasSaved = !!(p.recipe && (p.recipe.steps || []).length);
        var stored = hasSaved ? verify(p.recipe, { output: p.recipe.output }) : null;
        var clues = (p.inputs || []).map(Kit.get).filter(function (c) { return c && c.kind === 'text'; });
        var clearing = !d.steps.length && hasSaved;
        var sig = [S.pid, dirty, hasSaved, stored && stored.state, stored && stored.problems.join('|'), clearing, d.steps.length, built, clues.map(function (c) { return c.id + ':' + c.text + ':' + !!d.clues[c.id]; }).join('|')].join('¦');
        if (sig === saveSig) return; saveSig = sig;
        var f = captureFocus(box);
        var stateTxt = dirty ? '<span class="cf-save-state dirty"><i class="cf-dot"></i>Unsaved changes. The saved recipe is untouched until you save.</span>'
          : hasSaved ? '<span class="cf-save-state">Saved recipe matches the bench' + (stored.state === 'verified' ? ' and verifies.' : '.') + '</span>'
          : '<span class="cf-save-state">' + esc(p.id) + ' has no saved recipe yet.</span>';
        var html = '<div class="cf-save-row">' +
          '<button type="button" class="btn' + (dirty ? ' primary' : '') + '" data-act="save" data-fk="save"' + (d.steps.length || clearing ? '' : ' disabled') + '>' + (clearing ? 'Clear the saved recipe' : 'Save recipe to ' + esc(p.id)) + '</button>' +
          '<button type="button" class="btn ghost" data-act="revert" data-fk="revert"' + (dirty ? '' : ' disabled') + '>Revert to saved</button>' +
          stateTxt + '</div>';
        if (stored && stored.state === 'broken' && !dirty) html += '<div class="cf-save-warn">The saved recipe has problems: ' + esc(stored.problems.join(' ')) + ' Saving the bench rewrites it.</div>';
        if (clues.length && !clearing) {
          html += '<fieldset class="cf-clueset"><legend>Also set the clue text <span class="faint">so the clue carries the enciphered text</span></legend>' + clues.map(function (c) {
            var same = squash(c.text) === squash(built);
            return '<label class="cf-clue-opt"><input type="checkbox" data-ch="useclue" value="' + esc(c.id) + '" data-fk="uc-' + esc(c.id) + '"' + (d.clues[c.id] ? ' checked' : '') + '>' +
              '<span class="id">' + esc(c.id) + '</span><span class="cf-clue-t doc">' + esc(clip(c.text, 90)) + '</span>' + (same ? '<span class="chip tone-teal">matches</span>' : '') + '</label>';
          }).join('') + '</fieldset>';
        } else if (!clearing) {
          html += '<p class="cf-save-note">' + esc(p.id) + ' has no text clues to carry the ciphertext. Add one in Solve path if a player should see it.</p>';
        }
        box.innerHTML = html;
        restoreFocus(box, f);
      }

      /* ---------- analysis panel ---------- */
      function renderAnalysis() {
        var body = el.panel.querySelector('#cf-an'); if (!body) return;
        var an = analyze(S.anText || '', S.anRef);
        lastAn = an;
        var src = S.other ? 'Other text' : (draft().mode === 'encode' ? 'Output of the steps' : 'Text the player sees');
        if (!an.letters) {
          body.innerHTML = '<div class="cf-an-src">' + esc(src) + '</div><p class="cf-empty">Nothing to analyze yet. ' + (S.other ? 'Paste some text above.' : 'Type a plaintext and add a step, or analyze other text.') + '</p>';
          return;
        }
        var g = iocGuide(an.ioc), sh = shiftSummary(an), shortTxt = an.letters < 40;
        var rows = an.shifts.map(function (s) {
          var fit = Math.max(0, Math.min(1, (Math.log(1000) - Math.log(Math.max(s.chi, 1))) / (Math.log(1000) - Math.log(10))));
          var tag = s.intended ? '<span class="chip tone-teal">your plaintext</span>' : s.english ? '<span class="chip tone-orange">reads like English</span>' : s.close ? '<span class="chip tone-amber">close</span>' : (an.best && s.shift === an.best.shift ? '<span class="chip">closest</span>' : '');
          return '<tr class="' + (s.intended ? 'is-int' : s.english ? 'is-en' : s.close ? 'is-close' : '') + '"><td class="n">−' + s.shift + '</td><td class="pv"><code>' + esc(s.preview) + '</code>' + tag + '</td>' +
            '<td class="chi">' + Math.round(s.chi) + '</td><td class="fit"><span class="cf-fit"><i style="width:' + Math.round(fit * 100) + '%"></i></span></td></tr>';
        }).join('');
        var top = an.top.map(function (x, i) { return '<b' + (i ? ' class="minor"' : '') + '>' + x.p + '</b>'; }).join(', ');
        body.innerHTML =
          '<div class="cf-an-src">' + esc(src) + (S.other ? '' : (S.anRef ? ' · plaintext used as the English benchmark' : '')) + '</div>' +
          '<div class="cf-stats">' +
            '<div><b>' + an.length + '</b><span>length</span></div><div><b>' + an.letters + '</b><span>letters</span></div>' +
            '<div><b>' + an.words + '</b><span>words</span></div><div><b>' + (an.ioc == null ? '—' : an.ioc.toFixed(3)) + '</b><span>IoC</span></div></div>' +
          (shortTxt ? '<p class="cf-short">Short text (' + an.letters + ' letters): treat every number here as a rough guide.</p>' : '') +
          '<section class="cf-an-sec"><div class="cf-sec-h"><h3>Letter frequency</h3><span class="cf-legend"><span><i class="sw-bar"></i>This text</span><span><i class="sw-tick"></i>Typical English</span></span></div>' +
            '<div class="cf-chart" data-chart="freq" role="img" aria-label="Letter frequency of this text compared with typical English"></div>' +
            '<details class="cf-tdet"' + (S.tableOpen ? ' open' : '') + '><summary>Show as a table</summary><div class="cf-tscroll scroll"><table class="cf-ftable"><thead><tr><th>Letter</th>' + A.split('').map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>' +
              '<tr><th>Count</th>' + an.counts.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>' +
              '<tr><th>%</th>' + an.counts.map(function (c) { return '<td>' + (c / an.letters * 100).toFixed(1) + '</td>'; }).join('') + '</tr>' +
              '<tr><th>English %</th>' + EN.map(function (e) { return '<td>' + e.toFixed(1) + '</td>'; }).join('') + '</tr></tbody></table></div></details></section>' +
          '<section class="cf-an-sec"><div class="cf-sec-h"><h3>Index of coincidence</h3><span class="chip tone-' + g.tone + '">' + esc(g.short) + '</span></div>' +
            '<div class="cf-chart" data-chart="ioc" role="img" aria-label="Index of coincidence ' + (an.ioc == null ? 'unknown' : an.ioc.toFixed(3)) + ' on a scale from random to English"></div>' +
            '<p class="cf-guide">' + esc(g.text) + '</p></section>' +
          '<section class="cf-an-sec"><div class="cf-sec-h"><h3>All 25 Caesar shifts</h3><span class="cf-sec-n">χ² vs English · lower reads more like English</span></div>' +
            '<div class="cf-notice tone-' + (sh.tone === 'error' ? 'orange' : sh.tone) + '" data-flag="' + (sh.flag ? 1 : 0) + '">' + esc(sh.text) + '</div>' +
            '<div class="cf-tscroll scroll cf-shifts"><table class="cf-stable"><thead><tr><th>Shift</th><th>Reads as</th><th class="chi">χ²</th><th class="fit">English fit</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>' +
          '<section class="cf-an-sec"><div class="cf-sec-h"><h3>Repeating-key length</h3><span class="cf-sec-n">average IoC of every n-th letter</span></div>' +
            '<div class="cf-chart" data-chart="period" role="img" aria-label="Index of coincidence for key lengths 1 to 12"></div>' +
            '<p class="cf-guide">' + (an.top.length ? 'Most likely key lengths: ' + top + '. A length whose columns score near 0.066 is a good candidate; multiples of the true length score high too.' : 'Too few letters to estimate a key length.') + '</p></section>';
        drawCharts();
      }

      /* ---------- charts (inline SVG, token colours, redrawn on theme change) ---------- */
      function colors() {
        return { grid: Kit.cssVar('--border'), axis: Kit.cssVar('--border-strong'), text: Kit.cssVar('--text-muted'), faint: Kit.cssVar('--text-faint'),
          ink: Kit.cssVar('--text'), bar: Kit.cssVar('--accent'), soft: Kit.cssVar('--border-strong'), surface: Kit.cssVar('--surface'), en: Kit.cssVar('--ws-teal-fg'), rnd: Kit.cssVar('--ws-purple-fg') };
      }
      function colPath(x, y, w, h, r) {
        if (h <= 0) return '';
        r = Math.min(r, w / 2, h);
        return 'M' + x + ' ' + (y + h) + 'V' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + r) + 'V' + (y + h) + 'Z';
      }
      function svgText(x, y, s, fill, anchor, extra) { return '<text x="' + x + '" y="' + y + '" fill="' + fill + '" text-anchor="' + (anchor || 'middle') + '"' + (extra || '') + '>' + esc(s) + '</text>'; }
      function drawCharts() {
        var an = lastAn; if (!an || !an.letters) return;
        var c = colors();
        Array.prototype.forEach.call(el.panel.querySelectorAll('.cf-chart'), function (host) {
          var w = Math.max(220, Math.floor(host.clientWidth || 300)), kind = host.getAttribute('data-chart');
          host.innerHTML = kind === 'freq' ? freqSvg(an, w, c) : kind === 'ioc' ? iocSvg(an, w, c) : periodSvg(an, w, c);
          host.setAttribute('data-w', w);
        });
      }
      function freqSvg(an, w, c) {
        var h = 156, m = { l: 34, r: 4, t: 10, b: 22 }, iw = w - m.l - m.r, ih = h - m.t - m.b;
        var pct = an.counts.map(function (n) { return n / an.letters * 100; });
        var max = Math.max(13, Math.max.apply(null, pct)), step = max > 30 ? 10 : 5, top = Math.ceil(max / step) * step;
        var y = function (v) { return m.t + ih - v / top * ih; }, slot = iw / 26, bw = Math.max(3, Math.min(24, slot * 0.58));
        var s = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" class="cf-svg">';
        for (var t = 0; t <= top; t += step) {
          s += '<line x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + y(t) + '" y2="' + y(t) + '" stroke="' + (t ? c.grid : c.axis) + '" stroke-width="1" shape-rendering="crispEdges"/>';
          s += svgText(m.l - 6, y(t) + 3, t + (t ? '%' : ''), c.faint, 'end');
        }
        for (var i = 0; i < 26; i++) {
          var cx = m.l + slot * i + slot / 2, bh = pct[i] / top * ih;
          s += '<path d="' + colPath(cx - bw / 2, y(pct[i]), bw, bh, 3) + '" fill="' + c.bar + '"/>';
          var ey = y(EN[i]), half = Math.min(slot * 0.42, bw / 2 + 3);
          s += '<line x1="' + (cx - half) + '" x2="' + (cx + half) + '" y1="' + ey + '" y2="' + ey + '" stroke="' + c.ink + '" stroke-width="2" stroke-linecap="round"/>';
          s += svgText(cx, h - 7, A[i], an.counts[i] ? c.text : c.faint);
          s += '<rect x="' + (m.l + slot * i) + '" y="' + m.t + '" width="' + slot + '" height="' + (ih + m.b) + '" fill="transparent" data-tip="' +
            esc(A[i] + ': ' + an.counts[i] + ' of ' + an.letters + ' letters (' + pct[i].toFixed(1) + '%) · English ' + EN[i].toFixed(1) + '%') + '"/>';
        }
        return s + '</svg>';
      }
      function iocSvg(an, w, c) {
        var h = 46, lo = 0.03, hi = 0.08, m = { l: 8, r: 8 }, iw = w - m.l - m.r;
        var x = function (v) { return m.l + (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * iw; }, ty = 30;
        var s = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" class="cf-svg">';
        s += '<line x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + ty + '" y2="' + ty + '" stroke="' + c.grid + '" stroke-width="4" stroke-linecap="round"/>';
        [[IOC_RAND, 'random .038', c.rnd], [IOC_EN, 'English .066', c.en]].forEach(function (r) {
          s += '<line x1="' + x(r[0]) + '" x2="' + x(r[0]) + '" y1="' + (ty - 7) + '" y2="' + (ty + 7) + '" stroke="' + r[2] + '" stroke-width="2" stroke-linecap="round"/>';
          s += svgText(x(r[0]), ty - 13, r[1], c.text);
        });
        if (an.ioc != null) {
          s += '<circle cx="' + x(an.ioc) + '" cy="' + ty + '" r="6.5" fill="' + c.bar + '" stroke="' + c.surface + '" stroke-width="2.5"/>';
          s += '<rect x="' + (x(an.ioc) - 10) + '" y="' + (ty - 10) + '" width="20" height="20" fill="transparent" data-tip="IoC ' + an.ioc.toFixed(3) + ' (' + an.letters + ' letters)"/>';
        }
        return s + '</svg>';
      }
      function periodSvg(an, w, c) {
        var h = 132, m = { l: 34, r: 56, t: 10, b: 22 }, iw = w - m.l - m.r, ih = h - m.t - m.b;
        var vals = an.periods.map(function (x) { return x.ioc || 0; });
        var top = Math.max(0.08, Math.ceil(Math.max.apply(null, vals) * 100) / 100);
        var y = function (v) { return m.t + ih - v / top * ih; }, slot = iw / 12, bw = Math.max(4, Math.min(24, slot * 0.56));
        var topSet = an.top.map(function (x) { return x.p; });
        var s = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" class="cf-svg">';
        s += '<line x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + y(0) + '" y2="' + y(0) + '" stroke="' + c.axis + '" stroke-width="1" shape-rendering="crispEdges"/>';
        s += svgText(m.l - 6, y(0) + 3, '0', c.faint, 'end') + svgText(m.l - 6, y(top) + 3, top.toFixed(2).replace(/^0/, ''), c.faint, 'end');
        [[IOC_EN, 'English', c.en], [IOC_RAND, 'random', c.rnd]].forEach(function (r) {
          s += '<line x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + y(r[0]) + '" y2="' + y(r[0]) + '" stroke="' + r[2] + '" stroke-width="1" shape-rendering="crispEdges" opacity="0.8"/>';
          s += svgText(w - m.r + 6, y(r[0]) + 3, r[1], c.text, 'start');
        });
        an.periods.forEach(function (pr, i) {
          var cx = m.l + slot * i + slot / 2;
          if (pr.ok && pr.ioc != null) {
            var hot = topSet.indexOf(pr.p) >= 0;
            s += '<path d="' + colPath(cx - bw / 2, y(pr.ioc), bw, pr.ioc / top * ih, 3) + '" fill="' + (hot ? c.bar : c.soft) + '"/>';
          } else {
            s += '<circle cx="' + cx + '" cy="' + (y(0) - 3) + '" r="1.5" fill="' + c.faint + '"/>';
          }
          s += svgText(cx, h - 7, String(pr.p), topSet.indexOf(pr.p) >= 0 ? c.ink : c.text);
          s += '<rect x="' + (m.l + slot * i) + '" y="' + m.t + '" width="' + slot + '" height="' + (ih + m.b) + '" fill="transparent" data-tip="' +
            esc('Key length ' + pr.p + ': ' + (pr.ok && pr.ioc != null ? 'IoC ' + pr.ioc.toFixed(3) : 'too few letters per column')) + '"/>';
        });
        return s + '</svg>';
      }

      /* ---------- bench actions ---------- */
      function setMode(m) {
        var d = draft();
        if (d.mode === m) return;
        d.mode = m; S.menuOpen = false;
        if (m === 'decode' && !d.player.trim()) d.player = Kit.runRecipe(d.plaintext, d.steps, 'encode').output;
        S.expanded = {};
        renderBench();
      }
      function addStep(name) {
        var d = draft();
        d.steps.push(newStep(name));
        S.menuOpen = false;
        var btn = el.panel.querySelector('[data-act="add-open"]'); if (btn) btn.setAttribute('aria-expanded', 'false');
        var menu = el.panel.querySelector('#cf-menu'); if (menu) menu.hidden = true;
        renderSteps(); recompute();
        var i = d.steps.length - 1, card = el.panel.querySelector('.cf-step[data-i="' + i + '"]');
        if (card) {
          var first = card.querySelector('input, select, textarea') || card.querySelector('[data-act="step-rm"]');
          if (first) first.focus();
          if (card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
        }
      }
      function moveStep(i, delta) {
        var d = draft(), j = i + delta;
        if (j < 0 || j >= d.steps.length) return;
        var t = d.steps[i]; d.steps[i] = d.steps[j]; d.steps[j] = t;
        var e = S.expanded[i]; S.expanded[i] = S.expanded[j]; S.expanded[j] = e;
        renderSteps(); recompute();
        var b = el.panel.querySelector('.cf-step[data-i="' + j + '"] [data-act="step-move"][data-d="' + delta + '"]');
        if (b && !b.disabled) b.focus(); else { b = el.panel.querySelector('.cf-step[data-i="' + j + '"] [data-act="step-rm"]'); if (b) b.focus(); }
      }
      function removeStep(i) {
        var d = draft(), gone = d.steps.splice(i, 1)[0];
        S.expanded = {};
        renderSteps(); recompute();
        Kit.toast('Removed step ' + (i + 1) + ' (' + opLabel(gone.op) + ')', { label: 'Undo', run: function () {
          var dd = getDraft(S.pid); dd.steps.splice(Math.min(i, dd.steps.length), 0, gone); renderSteps(); recompute(); Kit.toast('Step restored');
        } });
        var next = el.panel.querySelector('.cf-step[data-i="' + Math.min(i, d.steps.length - 1) + '"] [data-act="step-rm"]') || el.panel.querySelector('[data-act="add-open"]');
        if (next) next.focus();
      }
      function setParam(i, key, raw) {
        var d = draft(), st = d.steps[i]; if (!st) return;
        var op = Kit.ops[st.op], pr = op && (op.params || []).find(function (x) { return x.key === key; });
        st[key] = pr && pr.type === 'number' ? (raw === '' || isNaN(+raw) ? raw : +raw) : raw;
        recompute();
      }
      function doSave() {
        var p = puzzle(); if (!p) { saveToPuzzle(); return; }
        var d = draft(), pid = p.id;
        var built = Kit.runRecipe(d.plaintext, d.steps, 'encode').output;
        var clueIds = d.steps.length ? (p.inputs || []).filter(function (cid) { var c = Kit.get(cid); return c && c.kind === 'text' && d.clues[cid]; }) : [];
        var snap = Kit.snapshot();
        ownUpdate(function () {
          Kit.batch(function () {
            Kit.update(pid, { recipe: d.steps.length ? { plaintext: d.plaintext, steps: clone(d.steps), output: built } : null });
            clueIds.forEach(function (cid) { Kit.update(cid, { text: built }); });
          });
        });
        d.base = storedKey(Kit.get(pid));
        saveSig = '';
        recompute();
        renderRail(); renderPick();
        var msg = d.steps.length ? 'Saved the recipe to ' + pid + (clueIds.length ? ' and set the text of ' + clueIds.join(', ') : '') : 'Cleared the saved recipe on ' + pid;
        Kit.toast(msg, { label: 'Undo', run: function () {
          ownUpdate(function () { Kit.restore(snap); });
          var dd = mem.drafts[pid]; if (dd) dd.base = storedKey(Kit.get(pid));
          saveSig = ''; refreshAll(false);
          Kit.toast('Save undone. Your bench still has the changes.');
        } });
      }
      function saveToPuzzle() {
        var d = draft();
        if (!d.steps.length) return;
        Kit.pick({ title: 'Save the scratchpad recipe to…', types: ['puzzle'], placeholder: 'Pick a puzzle (its saved recipe is replaced)', onPick: function (id) {
          if (Kit.type(id) !== 'puzzle') return;
          var built = Kit.runRecipe(d.plaintext, d.steps, 'encode').output, snap = Kit.snapshot(), had = !!(Kit.get(id).recipe && (Kit.get(id).recipe.steps || []).length);
          ownUpdate(function () { Kit.update(id, { recipe: { plaintext: d.plaintext, steps: clone(d.steps), output: built } }); });
          mem.drafts[id] = { plaintext: d.plaintext, steps: clone(d.steps), player: '', mode: 'encode', clues: {}, base: storedKey(Kit.get(id)) };
          go(id);
          Kit.toast('Saved the scratchpad recipe to ' + id + (had ? ', replacing its old recipe' : ''), { label: 'Undo', run: function () {
            ownUpdate(function () { Kit.restore(snap); });
            var dd = mem.drafts[id]; if (dd) dd.base = storedKey(Kit.get(id));
            saveSig = ''; refreshAll(false);
            Kit.toast('Save undone');
          } });
        } });
      }
      function revert() {
        var p = puzzle(); if (!p) return;
        var d = draft(), before = { plaintext: d.plaintext, steps: clone(d.steps) }, r = p.recipe || {};
        d.plaintext = r.plaintext || ''; d.steps = clone(r.steps || []); d.base = storedKey(p);
        if (d.mode === 'decode') d.player = Kit.runRecipe(d.plaintext, d.steps, 'encode').output;
        S.expanded = {}; renderBench(); renderRail();
        var pid = p.id;
        Kit.toast('Reverted ' + pid + ' to its saved recipe', { label: 'Undo', run: function () {
          var dd = getDraft(pid); dd.plaintext = before.plaintext; dd.steps = before.steps;
          if (S.pid === pid && S.tab === 'bench') renderBench(); renderRail();
          Kit.toast('Unsaved changes restored');
        } });
      }

      /* ============================================================
         SOLVE PATH
         ============================================================ */
      function clueRow(c, p) {
        var where;
        if (!c.plantedIn) where = '<span class="cf-flag bad">Not planted yet</span>';
        else if (Kit.type(c.plantedIn) === 'puzzle') where = '<span class="cf-where">Produced by solving ' + Kit.refHtml(c.plantedIn) + '</span>';
        else where = '<span class="cf-where">Planted in ' + Kit.refHtml(c.plantedIn) + '</span>';
        return '<li class="cf-clue' + (c.plantedIn ? '' : ' unplanted') + '">' +
          '<span class="cf-clue-k">' + Kit.layerDot(c.layer) + '<span class="id">' + esc(c.id) + '</span><span class="cf-ckind">' + esc(c.kind) + '</span></span>' +
          '<span class="cf-clue-b"><button type="button" class="cf-clue-text doc" data-act="open-ref" data-id="' + esc(c.id) + '" title="Open ' + esc(c.id) + '">' + esc(c.text) + '</button>' + where + '</span>' +
          '<button type="button" class="cf-ib" data-act="clue-rm" data-id="' + esc(c.id) + '" data-fk="clue-rm-' + esc(c.id) + '" aria-label="Remove ' + esc(c.id) + ' from this puzzle\'s inputs">' + IC.x + '</button></li>';
      }
      function listEditor(kind, items, label, placeholder) {
        return '<ol class="cf-list" data-list="' + kind + '">' + items.map(function (t, i) {
          return '<li class="cf-li"><span class="cf-li-n">' + (i + 1) + '</span>' +
            '<textarea class="input cf-li-t" rows="1" data-in="' + kind + '" data-k="' + i + '" data-fk="' + kind + '-' + i + '" aria-label="' + esc(label + ' ' + (i + 1)) + '" placeholder="' + esc(placeholder) + '">' + esc(t) + '</textarea>' +
            '<span class="cf-li-tools">' +
              '<button type="button" class="cf-ib" data-act="li-move" data-list="' + kind + '" data-k="' + i + '" data-d="-1" data-fk="' + kind + '-' + i + '-up" aria-label="Move ' + esc(label.toLowerCase()) + ' ' + (i + 1) + ' up"' + (i ? '' : ' disabled') + '>' + IC.up + '</button>' +
              '<button type="button" class="cf-ib" data-act="li-move" data-list="' + kind + '" data-k="' + i + '" data-d="1" data-fk="' + kind + '-' + i + '-down" aria-label="Move ' + esc(label.toLowerCase()) + ' ' + (i + 1) + ' down"' + (i < items.length - 1 ? '' : ' disabled') + '>' + IC.down + '</button>' +
              '<button type="button" class="cf-ib danger" data-act="li-rm" data-list="' + kind + '" data-k="' + i + '" data-fk="' + kind + '-' + i + '-rm" aria-label="Remove ' + esc(label.toLowerCase()) + ' ' + (i + 1) + '">' + IC.x + '</button>' +
            '</span></li>';
        }).join('') + '</ol>';
      }
      function renderPath() {
        var p = puzzle(); if (!p) return;
        var f = captureFocus(el.panel), mainScroll = el.main.scrollTop;
        var clues = (p.inputs || []).map(Kit.get).filter(Boolean);
        var unplanted = clues.filter(function (c) { return !c.plantedIn; }).length;
        var hints = p.hints || [];
        el.panel.innerHTML = '<div class="cf-path">' +
          '<section class="cf-card"><div class="cf-sec-h"><h3>The player starts with</h3><span class="cf-sec-n">' + plural(clues.length, 'clue') + '</span>' +
            '<button type="button" class="btn sm" data-act="clue-add" data-fk="clue-add">' + IC.plus + 'Add a clue…</button></div>' +
            (unplanted ? '<div class="cf-notice tone-orange">' + plural(unplanted, 'clue is', 'clues are') + ' not planted anywhere yet, so a player cannot find ' + (unplanted === 1 ? 'it' : 'them') + '.</div>' : '') +
            (clues.length ? '<ul class="cf-clues">' + clues.map(function (c) { return clueRow(c, p); }).join('') + '</ul>' : '<p class="cf-empty">No input clues. What does the player start from?</p>') +
          '</section>' +
          '<div class="cf-grid2">' +
            '<div class="field"><label for="cf-premise">Premise <span class="faint">what the player is shown</span></label><textarea id="cf-premise" class="input cf-auto" rows="3" data-in="premise" data-fk="premise">' + esc(p.premise || '') + '</textarea></div>' +
            '<div class="field"><label for="cf-aha">Aha <span class="faint">the key insight, in one line</span></label><input id="cf-aha" type="text" class="input" data-in="aha" data-fk="aha" value="' + esc(p.aha || '') + '" placeholder="e.g. The box number is a quatrain number."></div>' +
          '</div>' +
          '<section class="cf-card"><div class="cf-sec-h"><h3>Solve path</h3><span class="cf-sec-n">what the player does, in order</span></div>' +
            (p.solvePath && p.solvePath.length ? listEditor('sp', p.solvePath, 'Step', 'Describe what the player does') : '<p class="cf-empty">No steps yet. Write down every move a player makes, from the first clue to the answer.</p>') +
            '<button type="button" class="btn sm" data-act="li-add" data-list="sp" data-fk="sp-add">' + IC.plus + 'Add step</button></section>' +
          '<div class="field"><label for="cf-solution">Solution <span class="faint">the answer and how it is reached</span></label><textarea id="cf-solution" class="input cf-auto" rows="3" data-in="solution" data-fk="solution">' + esc(p.solution || '') + '</textarea></div>' +
          '<section class="cf-card cf-hints"><div class="cf-sec-h"><h3>Hints</h3><span class="cf-sec-n">optional and rare</span></div>' +
            '<p class="cf-guide">Most puzzles need none. The game ships all at once to a small group, so a hint only belongs where a fair solver could get stuck for good.</p>' +
            (hints.length ? listEditor('hint', hints, 'Hint', 'The one nudge a stuck player gets') : '<p class="cf-empty">No hints. That is normal.</p>') +
            '<button type="button" class="btn sm ghost" data-act="li-add" data-list="hint" data-fk="hint-add">' + IC.plus + 'Add a hint</button></section>' +
        '</div>';
        restoreFocus(el.panel, f);
        el.main.scrollTop = mainScroll;
      }
      function renderPathSafe() {
        var a = document.activeElement;
        if (a && el.panel.contains(a) && isTextField(a)) { S.pathStale = true; return; }
        S.pathStale = false;
        renderPath();
      }
      function readList(kind) {
        return Array.prototype.map.call(el.panel.querySelectorAll('textarea[data-in="' + kind + '"]'), function (t) { return t.value; });
      }
      var LIST_FIELD = { sp: 'solvePath', hint: 'hints' };
      function listAction(act, kind, k) {
        var p = puzzle(); if (!p) return;
        flush();
        var field = LIST_FIELD[kind], arr = (p[field] || []).slice(), pid = p.id;
        if (act === 'add') {
          arr.push('');
          ownUpdate(function () { Kit.update(pid, { [field]: arr }); });
          renderPath();
          var t = el.panel.querySelector('[data-fk="' + kind + '-' + (arr.length - 1) + '"]'); if (t) t.focus();
          return;
        }
        if (act === 'move') {
          var j = k.i + k.d; if (j < 0 || j >= arr.length) return;
          var tmp = arr[k.i]; arr[k.i] = arr[j]; arr[j] = tmp;
          ownUpdate(function () { Kit.update(pid, { [field]: arr }); });
          renderPath();
          var b = el.panel.querySelector('[data-fk="' + kind + '-' + j + '-' + (k.d < 0 ? 'up' : 'down') + '"]');
          if (!b || b.disabled) b = el.panel.querySelector('[data-fk="' + kind + '-' + j + '"]');
          if (b) b.focus();
          return;
        }
        if (act === 'rm') {
          var snap = Kit.snapshot(), gone = arr.splice(k.i, 1)[0];
          ownUpdate(function () { Kit.update(pid, { [field]: arr }); });
          renderPath();
          var nb = el.panel.querySelector('[data-fk="' + kind + '-' + Math.min(k.i, arr.length - 1) + '-rm"]') || el.panel.querySelector('[data-fk="' + kind + '-add"]');
          if (nb) nb.focus();
          Kit.toast('Removed ' + (kind === 'sp' ? 'step ' : 'hint ') + (k.i + 1) + (gone ? ': "' + clip(gone, 40) + '"' : ''), { label: 'Undo', run: function () { Kit.restore(snap); Kit.toast((kind === 'sp' ? 'Step' : 'Hint') + ' restored'); } });
        }
      }

      /* ============================================================
         CHECKS
         ============================================================ */
      function upstreamOf(pid) {
        var seen = new Set(), stack = ((Kit.get(pid) || {}).requires || []).slice();
        while (stack.length) { var x = stack.pop(); if (seen.has(x)) continue; seen.add(x); ((Kit.get(x) || {}).requires || []).forEach(function (r) { stack.push(r); }); }
        return seen;
      }
      function researchRow(rid) {
        var r = Kit.get(rid); if (!r) return '';
        var tone = r.status === 'verified' ? 'tone-green' : r.status === 'read' ? 'tone-blue' : 'tone-neutral';
        return '<span class="cf-src">' + Kit.refHtml(rid) + '<span class="chip ' + tone + '">' + esc(r.status === 'verified' ? 'verified' : 'not yet verified · ' + r.status) + '</span></span>';
      }
      function helperSingle(p) {
        var out = [], flags = 0;
        if (p.recipe && (p.recipe.steps || []).length) {
          var an = analyze(p.recipe.output || Kit.runRecipe(p.recipe.plaintext, p.recipe.steps, 'encode').output, p.recipe.plaintext);
          var sh = shiftSummary(an), g = iocGuide(an.ioc), ver = verify(p.recipe, { output: p.recipe.output });
          if (sh.flag) flags++;
          if (ver.state === 'broken') flags++;
          out.push('<li class="' + (sh.flag ? 'flag' : 'ok') + '"><b>Shift scan of the saved output.</b> ' + esc(sh.text) + '</li>');
          out.push('<li><b>Index of coincidence ' + (an.ioc == null ? '—' : an.ioc.toFixed(3)) + '.</b> ' + esc(g.short.charAt(0).toUpperCase() + g.short.slice(1)) + '.' +
            (an.top.length ? ' Repeating-key estimate: ' + an.top.map(function (x) { return x.p; }).join(', ') + '.' : '') + (an.letters < 40 ? ' (Short text: rough.)' : '') + '</li>');
          out.push('<li class="' + (ver.state === 'broken' ? 'flag' : 'ok') + '"><b>Recipe ' + ver.state + '.</b> ' + esc(ver.state === 'broken' ? ver.problems.join(' ') : 'The saved output decodes back to the plaintext.') + '</li>');
        } else {
          if (p.kind === 'cipher') { flags++; out.push('<li class="flag"><b>No saved recipe.</b> This is a cipher puzzle: build it on the Cipher bench so the scan can run.</li>'); }
          else out.push('<li><b>No saved recipe,</b> so there is no ciphertext to scan.</li>');
        }
        if (!p.solution || /^tbd\.?$/i.test(String(p.solution).trim())) { flags++; out.push('<li class="flag"><b>No solution written down.</b> Hard to judge "one answer" without it.</li>'); }
        out.push('<li class="cf-ask">Ask yourself: could a different reading of the same clues also fit? Try the steps in another order or direction.</li>');
        return { flags: flags, html: '<ul class="cf-hl">' + out.join('') + '</ul>' };
      }
      function helperVerifiable(p) {
        var claims = [], flags = 0;
        (p.mysteries || []).forEach(function (mid) { if (Kit.get(mid)) claims.push(mid); });
        (p.reveals || []).concat(p.inputs || []).forEach(function (id) { var l = Kit.layerOf(id); if ((l === 'record' || l === 'pseudo') && claims.indexOf(id) < 0) claims.push(id); });
        if (!claims.length) return { flags: 0, html: '<p class="cf-empty">No real-world claims are linked to this puzzle.</p>' };
        var rows = claims.map(function (id) {
          var o = Kit.get(id), t = Kit.type(id), srcs = [];
          D.research.forEach(function (r) { if ((r.supports || []).indexOf(id) >= 0) srcs.push(r.id); });
          if (t === 'mystery') (o.research || []).forEach(function (r) { if (srcs.indexOf(r) < 0) srcs.push(r); });
          /* events borrow their linked mysteries' research; clues (no links of their own) borrow the puzzle's */
          var via = [];
          function addVia(r) { if (srcs.indexOf(r) < 0 && via.indexOf(r) < 0) via.push(r); }
          if (t === 'event') (o.links || []).filter(function (x) { return Kit.type(x) === 'mystery'; }).forEach(function (mid) { ((Kit.get(mid) || {}).research || []).forEach(addVia); });
          if (t === 'clue') D.research.forEach(function (r) { if ((r.supports || []).indexOf(p.id) >= 0) addVia(r.id); });
          var isV = function (r) { return (Kit.get(r) || {}).status === 'verified'; };
          var all = srcs.concat(via), direct = srcs.some(isV), viaOnly = !direct && via.some(isV);
          var lay = Kit.layerOf(id) || o.layer, claim = lay === 'record' || lay === 'pseudo', needs = claim && !direct && !viaOnly;
          if (needs) flags++;
          var verdict = needs ? '<span class="cf-flag bad">No verified source</span>'
            : viaOnly ? '<span class="cf-flag warn">Verified only via linked research: check it covers this</span>'
            : direct ? '<span class="cf-flag ok">Verified source</span>' : '<span class="cf-flag">Not a real-world claim</span>';
          return '<li class="cf-claim' + (needs ? ' flag' : viaOnly ? ' maybe' : '') + '"><div class="cf-claim-h">' + (lay ? Kit.layerBadge(lay, { short: true }) : '') + Kit.refHtml(id) + verdict + '</div>' +
            (all.length ? '<div class="cf-srcs">' + srcs.map(researchRow).join('') + (via.length ? '<span class="cf-via">' + (t === 'event' ? 'via its mystery' : 'via the puzzle\'s research') + '</span>' + via.map(researchRow).join('') : '') + '</div>' : '<div class="cf-srcs"><span class="faint">No research linked.</span></div>') + '</li>';
        }).join('');
        return { flags: flags, html: '<ul class="cf-claims">' + rows + '</ul>' };
      }
      function helperContained(p) {
        var out = [], flags = 0, cn = (Kit.chapter(p.chapter) || {}).n, up = upstreamOf(p.id);
        var clues = (p.inputs || []).map(Kit.get).filter(Boolean);
        if (!clues.length) { flags++; out.push('<li class="flag"><b>No input clues.</b> What does the player start from?</li>'); }
        clues.forEach(function (c) {
          var line = '<span class="id">' + esc(c.id) + '</span> <span class="doc">' + esc(clip(c.text, 70)) + '</span> — ';
          if (!c.plantedIn) { flags++; out.push('<li class="flag">' + line + '<b>not planted yet.</b></li>'); return; }
          if (Kit.type(c.plantedIn) === 'puzzle') {
            var fine = up.has(c.plantedIn);
            if (!fine) flags++;
            out.push('<li class="' + (fine ? 'ok' : 'flag') + '">' + line + 'produced by ' + Kit.refHtml(c.plantedIn) + (fine ? ', which comes first.' : ', which this puzzle does not require. A player may not have it yet.') + '</li>');
            return;
          }
          var a = Kit.get(c.plantedIn), an = a ? (Kit.chapter(a.chapter) || {}).n : null, late = an != null && cn != null && an > cn;
          if (late) flags++;
          out.push('<li class="' + (late ? 'flag' : 'ok') + '">' + line + 'planted in ' + Kit.refHtml(c.plantedIn) + (late ? ', which first appears in chapter ' + an + ', after this puzzle.' : '.') + '</li>');
        });
        (p.requires || []).forEach(function (rid) {
          var r = Kit.get(rid);
          if (!r) { flags++; out.push('<li class="flag">Requires <span class="id">' + esc(rid) + '</span>, which does not exist.</li>'); return; }
          var rn = (Kit.chapter(r.chapter) || {}).n, late = rn > cn;
          if (late) flags++;
          out.push('<li class="' + (late ? 'flag' : 'ok') + '">Requires ' + Kit.refHtml(rid) + (late ? ', from a later chapter (' + rn + ').' : ' (chapter ' + rn + ').') + '</li>');
        });
        out.push('<li class="cf-ask">Ask yourself: is there any step that needs knowledge the trail never gives?</li>');
        return { flags: flags, html: '<ul class="cf-hl">' + out.join('') + '</ul>' };
      }
      var PHONE_TIPS = {
        image: 'Phones often strip image metadata (EXIF, GPS) when saving. If the puzzle needs it, offer a direct file link.',
        audio: 'Audio needs headphones, and spectrograms need an app. Check a free phone app can do the job.',
        document: 'Check the document reads at phone width without endless zooming.',
        print: 'Print pieces need an online mirror that reads well on a phone.',
        domain: 'Open the site on a phone and walk every step there.',
        social: 'Check the posts render in the phone app, not just on the web.',
        phone: 'Players will call from a mobile. Check the line and voicemail work.',
        physical: 'A physical find means travel. Make sure the trail to it works from a phone.',
        video: 'Check the video plays inline and has captions.',
        other: 'Check it on a phone.',
      };
      var CLUE_TIPS = { audio: 'An audio clue: assume players listen on phone speakers first.', data: 'A data clue (metadata, coordinates): check a phone can reach it at all.', image: 'An image clue: check fine detail survives a phone screen and messaging apps.' };
      function helperPhone(p) {
        var out = [], seen = {};
        (p.assets || []).map(Kit.get).filter(Boolean).forEach(function (a) {
          out.push('<li>' + Kit.refHtml(a.id) + ' <span class="cf-ckind">' + esc(a.kind) + '</span> — ' + esc(PHONE_TIPS[a.kind] || PHONE_TIPS.other) + '</li>');
        });
        (p.inputs || []).map(Kit.get).filter(Boolean).forEach(function (c) {
          if (CLUE_TIPS[c.kind] && !seen[c.kind]) { seen[c.kind] = 1; out.push('<li><span class="id">' + esc(c.id) + '</span> <span class="cf-ckind">' + esc(c.kind) + '</span> — ' + esc(CLUE_TIPS[c.kind]) + '</li>'); }
        });
        if (p.recipe && (p.recipe.steps || []).length) out.push('<li><b>Ciphertext:</b> make it selectable text, not an image, so a player can paste it into a tool on their phone.</li>');
        if (!out.length) out.push('<li>No assets linked yet. Note where this puzzle lives so you can test it on a phone.</li>');
        return { flags: 0, html: '<ul class="cf-hl">' + out.join('') + '</ul>' };
      }
      function helperPeople(p) {
        var mys = p.mysteries || [], found = [];
        D.characters.forEach(function (c) {
          if (!c.guard) return;
          var why = [];
          if ((c.appears || []).indexOf(p.id) >= 0) why.push('appears in ' + p.id);
          if ((p.reveals || []).indexOf(c.id) >= 0) why.push('revealed by ' + p.id);
          Kit.backlinks(c.id).forEach(function (x) {
            var refs = Kit.refs(x);
            mys.forEach(function (mid) { if (refs.indexOf(mid) >= 0 && why.length < 4) { var w = 'linked to ' + mid + ' through ' + x; if (why.indexOf(w) < 0) why.push(w); } });
          });
          if (why.length) found.push({ c: c, why: why });
        });
        if (!found.length) return { flags: 0, html: '<p class="cf-empty">No real people are linked to this puzzle.</p>' };
        return { flags: 0, people: found.length, html: '<ul class="cf-people">' + found.map(function (f) {
          return '<li><div class="cf-person">' + Kit.refHtml(f.c.id) + '<span class="cf-ckind">' + esc(f.c.kind) + '</span>' + (f.c.life ? '<span class="faint mono">' + esc(f.c.life) + '</span>' : '') + '</div>' +
            '<div class="cf-guard"><span class="eyebrow">Guard</span>' + esc(f.c.guard) + '</div>' +
            '<div class="cf-why">' + esc(f.why.join(' · ')) + '</div></li>';
        }).join('') + '</ul>' };
      }
      var HELPERS = { single: helperSingle, verifiable: helperVerifiable, contained: helperContained, phone: helperPhone, people: helperPeople };
      function renderChecks() {
        var p = puzzle(); if (!p) return;
        var f = captureFocus(el.panel), mainScroll = el.main.scrollTop;
        var have = p.checks || [], passed = D.designChecks.filter(function (dc) { return have.indexOf(dc.id) >= 0; }).length;
        var probs = Kit.problemsFor(p.id);
        var html = '<div class="cf-checks">' +
          '<div class="cf-checks-sum"><span class="cf-meter" aria-hidden="true">' + D.designChecks.map(function (dc) { return '<i class="' + (have.indexOf(dc.id) >= 0 ? 'on' : '') + '"></i>'; }).join('') + '</span>' +
            '<span><b>' + passed + ' of ' + D.designChecks.length + '</b> design checks passed. Tick a check when you are satisfied; the helper under each one does the legwork.</span></div>';
        D.designChecks.forEach(function (dc) {
          var on = have.indexOf(dc.id) >= 0, hp = HELPERS[dc.id] ? HELPERS[dc.id](p) : { flags: 0, html: '' };
          var tag = hp.flags ? '<span class="chip tone-orange">' + plural(hp.flags, 'flag') + '</span>' : (dc.id === 'people' && hp.people ? '<span class="chip tone-amber">' + plural(hp.people, 'real person', 'real people') + '</span>' : dc.id === 'phone' ? '<span class="chip">reminders</span>' : '<span class="chip tone-teal">no flags</span>');
          html += '<section class="cf-check' + (on ? ' on' : '') + '" data-check="' + dc.id + '">' +
            '<label class="cf-check-h"><input type="checkbox" data-ch="check" value="' + dc.id + '" data-fk="chk-' + dc.id + '"' + (on ? ' checked' : '') + '>' +
              '<span class="cf-check-t">' + esc(dc.label) + '</span><span class="cf-check-id mono">' + dc.id + '</span>' + tag + '</label>' +
            '<div class="cf-check-b">' + hp.html + '</div></section>';
        });
        html += '<section class="cf-card"><div class="cf-sec-h"><h3>Problems for ' + esc(p.id) + '</h3><span class="cf-sec-n">' + probs.length + '</span></div>' +
          (probs.length ? '<ul class="cf-probs">' + probs.map(function (x) {
            return '<li><span class="sev sev-' + x.severity + '">' + x.severity + '</span><span class="cf-prob-k mono">' + esc(x.kind) + '</span><span>' + esc(x.text) + '</span></li>';
          }).join('') + '</ul>' : '<p class="cf-empty">No problems found for this puzzle.</p>') + '</section></div>';
        el.panel.innerHTML = html;
        restoreFocus(el.panel, f);
        el.main.scrollTop = mainScroll;
      }

      /* ============================================================
         ORCHESTRATION
         ============================================================ */
      function renderPanel() {
        S.pathStale = false;
        if (S.tab === 'path' && puzzle()) renderPath();
        else if (S.tab === 'checks' && puzzle()) renderChecks();
        else { S.tab = 'bench'; renderBench(); }
      }
      function refreshAll(resetScroll) {
        renderRail(); renderPick(); renderHeader(); renderTabs(); renderPanel(); setStatus();
        if (resetScroll) el.main.scrollTop = 0;
      }
      function show(prm, first) {
        flush();
        var pid = resolve(prm);
        if (prm && prm.puzzle && pid !== prm.puzzle) Kit.toast('"' + prm.puzzle + '" is not a puzzle. Showing ' + (pid || 'the scratchpad') + '.');
        if (!first && pid === S.pid) return;
        S.pid = pid; S.menuOpen = false; S.expanded = {};
        mem.last = pid || 'scratch'; saveMem();
        if (pid) syncDraft(pid);
        getDraft(pid);
        refreshAll(true);
        var cur = el.list.querySelector('[aria-current="page"]');
        if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
      }

      /* change from anywhere: never overwrite the working copy, never move the caret */
      var offChange = Kit.on('change', function () {
        if (!own) S.external = true;
        clearTimeout(timers.change);
        timers.change = setTimeout(onChange, 40);
      });
      function onChange() {
        if (!S.alive) return;
        var ext = S.external; S.external = false;
        if (S.pid && !Kit.get(S.pid)) { S.pid = defaultPid(); getDraft(S.pid); refreshAll(true); return; }
        Object.keys(mem.drafts).forEach(function (k) { if (k !== 'scratch' && !Kit.get(k)) delete mem.drafts[k]; });
        var benchReplaced = false;
        if (ext && S.pid) benchReplaced = syncDraft(S.pid);
        renderRail(); renderPick(); renderHeader(); renderTabs();
        if (S.tab === 'bench') { if (benchReplaced) renderBench(); else { saveSig = ''; recompute(); } }
        else if (S.tab === 'path') { if (ext) renderPathSafe(); }
        else if (S.tab === 'checks') renderChecks();
        setStatus();
      }

      /* ---------- events ---------- */
      function onClick(e) {
        var t = e.target.closest('[data-act]');
        if (!t || !root.contains(t)) {
          if (S.menuOpen && !e.target.closest('.cf-add')) closeMenu();
          return;
        }
        var act = t.getAttribute('data-act');
        if (S.menuOpen && act !== 'add-open' && act !== 'add-op' && !t.closest('.cf-add')) closeMenu();
        switch (act) {
          case 'pick': go(t.getAttribute('data-id') === 'scratch' ? null : t.getAttribute('data-id')); break;
          case 'tab': flush(); S.tab = t.getAttribute('data-tab'); mem.tab = S.tab; saveMem(); renderTabs(); renderPanel(); setStatus(); break;
          case 'mode': setMode(t.getAttribute('data-mode')); break;
          case 'add-open':
            S.menuOpen = !S.menuOpen; t.setAttribute('aria-expanded', String(S.menuOpen));
            var menu = el.panel.querySelector('#cf-menu'); if (menu) { menu.hidden = !S.menuOpen; if (S.menuOpen) { var fi = menu.querySelector('.cf-menu-i'); if (fi) fi.focus(); } }
            break;
          case 'add-op': addStep(t.getAttribute('data-op')); break;
          case 'step-move': moveStep(+t.getAttribute('data-i'), +t.getAttribute('data-d')); break;
          case 'step-rm': removeStep(+t.getAttribute('data-i')); break;
          case 'expand':
            var i = +t.getAttribute('data-i'); S.expanded[i] = !S.expanded[i];
            var pv = t.closest('.cf-prev'); pv.classList.toggle('open', !!S.expanded[i]); t.textContent = S.expanded[i] ? 'Show less' : 'Show all';
            break;
          case 'copy-out': var o = el.panel.querySelector('#cf-out'); if (o && !o.classList.contains('empty')) Kit.copy(o.textContent, o); break;
          case 'save': doSave(); break;
          case 'save-to': saveToPuzzle(); break;
          case 'revert': revert(); break;
          case 'fill-built': var d = draft(); d.player = Kit.runRecipe(d.plaintext, d.steps, 'encode').output; el.panel.querySelector('#cf-player').value = d.player; recompute(); break;
          case 'fill-clue': var c = Kit.get(t.getAttribute('data-id')), dd = draft(); if (c) { dd.player = c.text; el.panel.querySelector('#cf-player').value = dd.player; recompute(); } break;
          case 'open-page': if (S.pid) { flush(); ctx.go(S.pid); } break;
          case 'open-trail': if (S.pid) { flush(); ctx.go('trail.' + S.pid); } break;
          case 'open-ref': flush(); ctx.go(t.getAttribute('data-id')); break;
          case 'export': if (S.pid) { flush(); ctx.openExport({ kind: 'linked', ids: [S.pid], depth: 1 }); } break;
          case 'export-game': ctx.openExport({ kind: 'game' }); break;
          case 'clue-add': addClue(); break;
          case 'clue-rm': removeClue(t.getAttribute('data-id')); break;
          case 'li-add': listAction('add', t.getAttribute('data-list')); break;
          case 'li-move': listAction('move', t.getAttribute('data-list'), { i: +t.getAttribute('data-k'), d: +t.getAttribute('data-d') }); break;
          case 'li-rm': listAction('rm', t.getAttribute('data-list'), { i: +t.getAttribute('data-k') }); break;
        }
      }
      function closeMenu() {
        S.menuOpen = false;
        var m = el.panel.querySelector('#cf-menu'); if (m) m.hidden = true;
        var b = el.panel.querySelector('[data-act="add-open"]'); if (b) b.setAttribute('aria-expanded', 'false');
      }
      function addClue() {
        var p = puzzle(); if (!p) return;
        var pid = p.id;
        Kit.pick({ title: 'Add a clue the player starts with', types: ['clue'], exclude: p.inputs || [], allowCreate: true, onPick: function (id) {
          var cur = Kit.get(pid); if (!cur || Kit.type(id) !== 'clue') return;
          ownUpdate(function () { Kit.update(pid, { inputs: (cur.inputs || []).concat([id]) }); });
          if (S.pid === pid && S.tab === 'path') renderPath();
          Kit.toast('Added ' + id + ' to ' + pid + '\'s inputs');
        } });
      }
      function removeClue(cid) {
        var p = puzzle(); if (!p) return;
        flush();
        var snap = Kit.snapshot();
        ownUpdate(function () { Kit.update(p.id, { inputs: (p.inputs || []).filter(function (x) { return x !== cid; }) }); });
        renderPath();
        Kit.toast('Removed ' + cid + ' from ' + p.id + '\'s inputs', { label: 'Undo', run: function () { Kit.restore(snap); Kit.toast(cid + ' is back'); } });
      }
      function onInput(e) {
        var t = e.target, k = t.getAttribute && t.getAttribute('data-in'); if (!k) return;
        var d;
        switch (k) {
          case 'q': S.q = t.value; renderRail(); break;
          case 'pt': d = draft(); d.plaintext = t.value; recompute(); break;
          case 'player': d = draft(); d.player = t.value; recompute(); break;
          case 'param': setParam(+t.getAttribute('data-i'), t.getAttribute('data-k'), t.value); break;
          case 'other': S.otherText = t.value; S.anText = t.value; S.anRef = null; cancelAnimationFrame(rafId); rafId = requestAnimationFrame(renderAnalysis); break;
          case 'premise': case 'aha': case 'solution': queueField(k, t.value); break;
          case 'sp': case 'hint': queueField(LIST_FIELD[k], readList(k)); break;
        }
      }
      function onChangeEvt(e) {
        var t = e.target, k = t.getAttribute && t.getAttribute('data-ch'); if (!k) return;
        var p = puzzle(), d;
        switch (k) {
          case 'pick': go(t.value === 'scratch' ? null : t.value); break;
          case 'status': if (p) { ownUpdate(function () { Kit.update(p.id, { status: t.value }); }); renderHeader(); renderRail(); setStatus(); } break;
          case 'param': setParam(+t.getAttribute('data-i'), t.getAttribute('data-k'), t.value); break;
          case 'other-on':
            S.other = t.checked;
            var ta = el.panel.querySelector('.cf-other'); if (ta) { ta.hidden = !S.other; if (S.other && !S.otherText) ta.focus(); }
            recompute(true);
            break;
          case 'useclue': d = draft(); d.clues[t.value] = t.checked; saveMem(); break;
          case 'check':
            if (!p) break;
            var have = (p.checks || []).slice(), id = t.value;
            if (t.checked && have.indexOf(id) < 0) have.push(id);
            if (!t.checked) have = have.filter(function (x) { return x !== id; });
            have = D.designChecks.map(function (dc) { return dc.id; }).filter(function (x) { return have.indexOf(x) >= 0; }).concat(have.filter(function (x) { return !D.designChecks.some(function (dc) { return dc.id === x; }); }));
            ownUpdate(function () { Kit.update(p.id, { checks: have }); });
            renderChecks(); renderTabs(); setStatus();
            break;
        }
      }
      function onFocusOut(e) {
        var t = e.target;
        if (t && t.getAttribute && /^(premise|aha|solution|sp|hint)$/.test(t.getAttribute('data-in') || '')) flush();
        setTimeout(function () {
          if (!S.alive || !S.pathStale || S.tab !== 'path') return;
          var a = document.activeElement;
          if (a && el.panel.contains(a) && isTextField(a)) return;
          S.pathStale = false; renderPath();
        }, 0);
      }
      function onKey(e) {
        if (e.key === 'Escape' && S.menuOpen) { closeMenu(); var b = el.panel.querySelector('[data-act="add-open"]'); if (b) b.focus(); e.stopPropagation(); return; }
        if (e.target.closest && e.target.closest('.cf-tabs') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
          var tabs = Array.prototype.slice.call(el.tabs.querySelectorAll('.cf-tab')), i = tabs.indexOf(e.target.closest('.cf-tab'));
          var n = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
          if (n) { n.click(); var f = el.tabs.querySelector('[data-tab="' + n.getAttribute('data-tab') + '"]'); if (f) f.focus(); }
          e.preventDefault();
        }
      }
      function onDocKey(e) {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's' && S.tab === 'bench' && root.isConnected) {
          e.preventDefault();
          if (S.pid) doSave(); else saveToPuzzle();
        }
      }
      /* chart tooltips (hover on desktop, tap on touch) */
      var tipTimer = null;
      function showTip(target, x, y) {
        var tip = el.tip; tip.textContent = target.getAttribute('data-tip'); tip.hidden = false;
        var r = tip.getBoundingClientRect();
        var left = Math.min(Math.max(8, x - r.width / 2), window.innerWidth - r.width - 8), top = y - r.height - 12;
        if (top < 8) top = y + 16;
        tip.style.left = left + 'px'; tip.style.top = top + 'px';
      }
      function onPointerMove(e) {
        var t = e.target.closest && e.target.closest('[data-tip]');
        if (!t || !root.contains(t)) { if (!el.tip.hidden && e.pointerType !== 'touch') el.tip.hidden = true; return; }
        showTip(t, e.clientX, e.clientY);
        if (e.pointerType === 'touch') { clearTimeout(tipTimer); tipTimer = setTimeout(function () { el.tip.hidden = true; }, 2400); }
      }
      function onPointerLeave() { el.tip.hidden = true; }
      function onToggle(e) { if (e.target.classList && e.target.classList.contains('cf-tdet')) S.tableOpen = e.target.open; }
      function onTheme() { drawCharts(); }

      root.addEventListener('click', onClick);
      root.addEventListener('input', onInput);
      root.addEventListener('change', onChangeEvt);
      root.addEventListener('focusout', onFocusOut);
      root.addEventListener('keydown', onKey);
      root.addEventListener('pointermove', onPointerMove);
      root.addEventListener('pointerdown', onPointerMove);
      root.addEventListener('pointerleave', onPointerLeave);
      root.addEventListener('toggle', onToggle, true);
      document.addEventListener('keydown', onDocKey);
      document.addEventListener('kit:theme', onTheme);
      var ro = null, lastW = 0;
      if (window.ResizeObserver) {
        ro = new ResizeObserver(function () {
          var host = el.panel.querySelector('.cf-chart'); if (!host) return;
          var w = Math.floor(host.clientWidth);
          if (Math.abs(w - lastW) > 2) { lastW = w; cancelAnimationFrame(rafId); rafId = requestAnimationFrame(drawCharts); }
        });
        ro.observe(el.main);
      }

      show(params, true);

      return {
        update: function (prm) { show(prm, false); },
        unmount: function () {
          flush();
          S.alive = false;
          offChange();
          clearTimeout(timers.change); clearTimeout(timers.flush); clearTimeout(tipTimer);
          cancelAnimationFrame(rafId);
          if (ro) ro.disconnect();
          document.removeEventListener('keydown', onDocKey);
          document.removeEventListener('kit:theme', onTheme);
          root.removeEventListener('click', onClick);
          root.removeEventListener('input', onInput);
          root.removeEventListener('change', onChangeEvt);
          root.removeEventListener('focusout', onFocusOut);
          root.removeEventListener('keydown', onKey);
          root.removeEventListener('pointermove', onPointerMove);
          root.removeEventListener('pointerdown', onPointerMove);
          root.removeEventListener('pointerleave', onPointerLeave);
          root.removeEventListener('toggle', onToggle, true);
          saveMem();
        },
        exportScope: function () { return S.pid ? { kind: 'entity', ids: [S.pid] } : { kind: 'game' }; },
        navToken: function () { return 'crafter'; },
      };
    },
  });

  /* exposed for tests and other views */
  Desk.crafter = { verify: verify, analyze: analyze };
})();
