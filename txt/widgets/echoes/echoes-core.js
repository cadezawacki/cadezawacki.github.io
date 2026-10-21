/* Word Echoes — the analyzer (pure: no DOM, no editor). Used by echoes.js (the
 * panel + editor view); unit-tested by echoes.test.js. UMD: module.exports in
 * node, window.__cadeEchoesCore in the page.
 *
 * Sentence boundaries come from Prose EKG's core (txt/widgets/ekg/ekg-core.js,
 * window.__cadeEkgCore / require('../ekg/ekg-core.js')): its block scanner
 * skips code fences, tables, headings, front matter and HTML; its masker turns
 * inline code, URLs, e-mails and #tags into opaque words and file / image
 * tokens into gaps without moving a single offset. Echoes walks the words of
 * those sentences and keeps the "content" ones:
 *
 *   normalise: lower-case, ’ → ', possessive 's / s' dropped; a word with a
 *   digit, a contraction (don't, we're…), a stopword, a word on the user's
 *   ignore list or one shorter than minLen letters is skipped. With stemming
 *   on, the key is a light Porter stem (steps 1a–1c: plurals, -ed, -ing, y→i),
 *   so run / runs / running and idea / ideas share a key.
 *
 *   Part-of-speech tags (optional; see ekg/nlp-client.js — the compromise
 *   library in a worker): with them a word is keyed by its root first, so
 *   irregular forms meet too (wrote / written / write, children / child,
 *   mice / mouse), in context ("the saw" stays a noun, "I saw" is see).
 *   "Skip names" leaves out proper nouns: capitalised words inside a sentence,
 *   and at a sentence start when the same word is capitalised inside one
 *   elsewhere in the paragraph — or, with tags, when the tagger calls it a
 *   person, place or organisation ("Elizabeth smiled." opening a paragraph).
 *   (The tagger's broader "proper noun" also catches capitalised common words
 *   at a sentence start — "Happy", "Tease" — so it isn't trusted alone.)
 *   Until a paragraph's tags arrive it is keyed without them and marked
 *   pend, so Engine.dropPending() makes the next pass redo just those.
 *
 * Severity of an occurrence = that of its nearest other occurrence (before or
 * after), from a combined distance
 *
 *   d = wordGap · W_WORD + sentenceGap · W_SENT          (W_WORD 0.06, W_SENT 1)
 *   D = taper · (W_SENT + AVG_SENT · W_WORD)             (AVG_SENT 15 → D = 9.5 at taper 5)
 *   severity = (1 − d / D)^1.5, clamped to 0..1
 *   … and 0 once sentenceGap > taper or wordGap > taper · 24 (120 words at 5).
 *
 * wordGap counts every word (stopwords too) between the two; sentenceGap is how
 * many sentence boundaries lie between them (0 = same sentence). Because a
 * boundary adds a whole unit, a repeat in the same sentence is always more
 * severe than one the same number of words away across a boundary; with
 * ordinary 15-word sentences the tint fades to nothing about `taper` sentences
 * away. Levels 1..6 bucket the severity for cheap decorations.
 *
 * Engine caches a summary of each block (paragraph) by its text, so a
 * re-analysis after an edit redoes only the edited paragraph. window() looks
 * at the blocks overlapping a range plus just enough context on each side
 * (≥ taper sentences or the word cap); index() aggregates the whole note
 * (counts, positions, an echo score per word) for the panel list and the
 * focus chip. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.__cadeEchoesCore = api;
})(typeof window !== 'undefined' ? window : this, function (root) {
  'use strict';

  var W_WORD = 0.06, W_SENT = 1, AVG_SENT = 15, WORDS_PER_TAPER = 24, CURVE = 1.5, MIN_SEV = 0.05, LEVELS = 6;
  var DEFAULTS = { taper: 5, stem: true, minLen: 3, ignore: '', names: false, style: 'tint' };

  // The sentence splitter (Prose EKG's core) — the page loads it before this file is used.
  var ekg = null;
  function sentenceCore() {
    if (ekg) return ekg;
    if (root && root.__cadeEkgCore) return (ekg = root.__cadeEkgCore);
    if (typeof require === 'function') { try { ekg = require('../ekg/ekg-core.js'); return ekg; } catch (e) {} }
    throw new Error('Word Echoes needs ekg-core.js');
  }

  function set(s) { var o = Object.create(null), a = s.split(/\s+/); for (var i = 0; i < a.length; i++) if (a[i]) o[a[i]] = 1; return o; }

  // ---- stopwords (~200): articles, pronouns, prepositions, conjunctions, auxiliaries,
  // determiners, and the commonest verbs / adverbs / filler nouns ---------------------
  var STOP = set(
    'a an the and or but nor so yet for of to in on at by with from into onto upon about above below over under after before ' +
    'between among amongst through throughout during without within against across along around behind beyond near off out up down ' +
    'via per toward towards inside outside than then that this these those there here where when what which who whom whose why how ' +
    'i me my mine myself you your yours yourself yourselves he him his himself she her hers herself it its itself we us our ours ' +
    'ourselves they them their theirs themselves one ones oneself ' +
    'is am are was were be been being have has had having do does did doing done will would shall should can could may might must ought ' +
    'not no yes only also just very too quite rather really even still already ever never always often sometimes usually again once ' +
    'twice soon now later almost maybe perhaps probably actually though although however therefore thus else instead anyway ' +
    'all any both each either neither every few many much more most less least some such other others another same own several enough ' +
    'as if because since while unless until whether whatever whenever wherever whoever ' +
    'get gets got getting gotten go goes going went gone make makes made making take takes took taken taking come comes came coming ' +
    'say says said saying see sees seen saw seeing know knows knew known think thinks thought want wants wanted let lets put puts ' +
    'give gives gave given seem seems seemed look looks looked use used tell told keep kept ' +
    'thing things something anything nothing everything someone anyone everyone nobody somebody anybody everybody ' +
    'like well back way ways lot lots kind sort bit able sure ' +
    'oh ok okay yeah hey etc'
  );

  // ---- normalising + stemming ------------------------------------------------------------
  // Porter's consonant test: y is a consonant at the start or after a vowel.
  function isCons(w, i) {
    var c = w.charAt(i);
    if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
    if (c === 'y') return i === 0 ? true : !isCons(w, i - 1);
    return true;
  }
  // Porter's measure m of w[0, n): the number of vowel→consonant transitions.
  function measure(w, n) {
    var m = 0, i = 0;
    while (i < n && isCons(w, i)) i++;
    while (i < n) {
      while (i < n && !isCons(w, i)) i++;
      if (i >= n) break;
      m++;
      while (i < n && isCons(w, i)) i++;
    }
    return m;
  }
  function hasVowel(w, n) { for (var i = 0; i < n; i++) if (!isCons(w, i)) return true; return false; }
  function cvc(w) {
    var n = w.length;
    if (n < 3 || !isCons(w, n - 1) || isCons(w, n - 2) || !isCons(w, n - 3)) return false;
    var c = w.charAt(n - 1);
    return c !== 'w' && c !== 'x' && c !== 'y';
  }
  // A light stem: Porter steps 1a (plurals), 1b (-eed / -ed / -ing with the e / double-
  // consonant repair) and 1c (y → i). run/runs/running → run, hope/hoped/hoping → hope,
  // study/studies/studied → studi, idea/ideas → idea. Words that aren't plain a–z stay as they are.
  function stem(w) {
    if (w.length < 4 || !/^[a-z]+$/.test(w)) return w;
    // 1a
    if (/sses$/.test(w)) w = w.slice(0, -2);
    else if (/ies$/.test(w)) w = w.slice(0, -2);
    else if (/(?:x|ch|sh|zz)es$/.test(w)) w = w.slice(0, -2);
    else if (/[^su]s$/.test(w) && !/is$/.test(w)) w = w.slice(0, -1);
    // 1b
    var again = false, n;
    if (/eed$/.test(w)) { if (measure(w, w.length - 3) > 0) w = w.slice(0, -1); }
    else if (/ed$/.test(w) && hasVowel(w, w.length - 2)) { w = w.slice(0, -2); again = true; }
    else if (/ing$/.test(w) && hasVowel(w, w.length - 3)) { w = w.slice(0, -3); again = true; }
    if (again) {
      n = w.length;
      if (/(?:at|bl|iz)$/.test(w)) w += 'e';
      else if (n > 1 && w.charAt(n - 1) === w.charAt(n - 2) && isCons(w, n - 1) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
      else if (measure(w, n) === 1 && cvc(w)) w += 'e';
    }
    // 1c
    if (/y$/.test(w) && hasVowel(w, w.length - 1)) w = w.slice(0, -1) + 'i';
    return w;
  }

  // Compiled options: { taper, stem, minLen, ignore (a set of keys), D, capW }.
  function compile(opts) {
    opts = opts || {};
    var o = {};
    for (var k in DEFAULTS) o[k] = opts[k] != null ? opts[k] : DEFAULTS[k];
    o.taper = Math.max(1, Math.min(20, +o.taper || DEFAULTS.taper));
    o.minLen = Math.max(1, Math.min(20, Math.round(+o.minLen || DEFAULTS.minLen)));
    o.stem = !!o.stem;
    o.names = !!o.names;
    o.D = o.taper * (W_SENT + AVG_SENT * W_WORD);
    o.capW = Math.round(o.taper * WORDS_PER_TAPER);
    var ig = Object.create(null), list = String(o.ignore || '').split(/[,;\n]+/);
    for (var i = 0; i < list.length; i++) {
      var w = clean(list[i].trim().toLowerCase());
      if (!w) continue;
      ig[w] = 1;
      if (o.stem) ig[stem(w)] = 1;
    }
    o.ignoreSet = ig;
    o.sig = [o.taper, o.stem ? 1 : 0, o.minLen, Object.keys(ig).sort().join(','), o.names ? 1 : 0].join('|');
    return o;
  }

  // The same options without stemming (cached on cfg as .exact).
  function exactOf(cfg) { var o = {}; for (var k in cfg) o[k] = cfg[k]; o.stem = false; o.exact = null; return o; }

  // ’ → ', drop a possessive ('s / s'); '' for a contraction.
  function clean(w) {
    if (w.indexOf('’') >= 0) w = w.replace(/’/g, "'");
    if (w.indexOf("'") >= 0) {
      w = w.replace(/'s$/, '').replace(/'$/, '');
      if (w.indexOf("'") >= 0) return '';          // don't, we're, rock'n'roll
    }
    return w;
  }
  // The matching key of a lower-cased word, or '' if it is never flagged.
  function normalize(lw, cfg) {
    cfg = cfg && cfg.ignoreSet ? cfg : compile(cfg);
    if (!lw || /[0-9]/.test(lw)) return '';
    var w = clean(lw);
    if (!w || STOP[lw] || STOP[w] || cfg.ignoreSet[w]) return '';
    var letters = w.replace(/[^a-zÀ-ɏͰ-ԯ]/g, '').length || w.length;
    if (letters < cfg.minLen) return '';
    if (!/[a-zÀ-ɏͰ-ԯ぀-鿿가-힯]/.test(w)) return '';
    if (!cfg.stem || w.indexOf('-') >= 0) return w;
    var s = stem(w);
    if (STOP[s] || cfg.ignoreSet[s]) return '';
    return s;
  }

  function isStopword(w) { return !!STOP[String(w).toLowerCase()]; }

  // ---- distance → severity ------------------------------------------------------------------
  function severity(wordGap, sentGap, cfg) {
    cfg = cfg && cfg.D ? cfg : compile(cfg);
    if (sentGap > cfg.taper || wordGap > cfg.capW) return 0;
    var d = Math.max(0, wordGap) * W_WORD + Math.max(0, sentGap) * W_SENT;
    var x = 1 - d / cfg.D;
    return x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(x, CURVE);
  }
  function level(sev) { return sev < MIN_SEV ? 0 : Math.max(1, Math.min(LEVELS, Math.ceil(sev * LEVELS))); }

  // ---- a block's words --------------------------------------------------------------------
  function isCap(text, i) { var c = text.charAt(i); return c !== c.toLowerCase(); }
  function allCaps(w) { return w.length > 1 && w === w.toUpperCase(); }
  // Summary of one block of prose: n words (all of them), s sentences, and the candidate
  // occurrences occ: [{ from, to, key, lw, w (word index), s (sentence index) }], block-relative.
  // provider(text) → tags | null | undefined, as for Prose EKG's analyzePara.
  function blockInfo(text, cfg, provider) {
    cfg = cfg && cfg.ignoreSet ? cfg : compile(cfg);
    var E = sentenceCore(), mk = E.mask(text), t = mk.t, raw = E.split(t, mk.breaks);
    var occ = [], n = 0, s = 0, P = null, pend = false, want = false, i, k, x;
    if (provider && (cfg.stem || cfg.names) && E.nlpPrep) {
      want = true;
      var ask = E.nlpPrep(t);
      P = provider(ask);
      if (P === undefined) { pend = true; P = null; }
    }
    var NAME = P ? E.TAG.Person | E.TAG.Place | E.TAG.Organization : 0;
    var sents = [], capIn = null;
    for (i = 0; i < raw.length; i++) sents.push(E.tokenize(t, raw[i].from, raw[i].to));
    if (cfg.names) {
      // words capitalised inside a sentence somewhere in this paragraph
      capIn = Object.create(null);
      for (i = 0; i < sents.length; i++) for (k = 1; k < sents[i].length; k++) { x = sents[i][k]; if (!x.op && isCap(text, x.from) && !allCaps(text.slice(x.from, x.to))) capIn[x.lw] = 1; }
    }
    for (i = 0; i < sents.length; i++) {
      var ws = sents[i], real = 0, first = true;
      for (k = 0; k < ws.length; k++) {
        x = ws[k];
        if (x.op) continue;
        real++;
        var key = normalize(x.lw, cfg), j = -1;
        if (key && P) { j = E.posAt(P, x.from); if (j >= 0 && (P.s[j] !== x.from || P.e[j] !== x.to)) j = -1; }
        if (key && cfg.names && isCap(text, x.from)) {
          var name = !allCaps(text.slice(x.from, x.to)) && (!first || !!capIn[x.lw] || (j >= 0 && !!(P.b[j] & NAME)));
          if (name) key = '';
        }
        if (key && cfg.stem && j >= 0) {
          if (P.r[j]) key = normalize(P.r[j], cfg);
          // a singular noun keeps its -s (news ≠ new, series, physics)
          else if ((P.b[j] & E.TAG.Noun) && !(P.b[j] & E.TAG.Plural) && /s$/.test(x.lw)) key = normalize(x.lw, cfg.exact || (cfg.exact = exactOf(cfg)));
        }
        if (key) occ.push({ from: x.from, to: x.to, key: key, lw: x.lw, w: n, s: s });
        n++;
        first = false;
      }
      if (real) s++;
    }
    var r = { n: n, s: s, occ: occ, pend: pend, want: want, tagged: !!P };
    if (pend) r.ask = ask;
    return r;
  }

  // Every word of a plain text with its key ('' = never flagged) and sentence index.
  function tokenize(text, opts) {
    var E = sentenceCore(), cfg = compile(opts), blocks = E.scanBlocks(text), out = [], s0 = 0;
    for (var b = 0; b < blocks.length; b++) {
      var bl = blocks[b], src = text.slice(bl.from, bl.to), mk = E.mask(src), raw = E.split(mk.t, mk.breaks), s = 0;
      for (var i = 0; i < raw.length; i++) {
        var ws = E.tokenize(mk.t, raw[i].from, raw[i].to), real = 0;
        for (var k = 0; k < ws.length; k++) {
          if (ws[k].op) continue;
          real++;
          out.push({ from: bl.from + ws[k].from, to: bl.from + ws[k].to, word: text.slice(bl.from + ws[k].from, bl.from + ws[k].to), key: normalize(ws[k].lw, cfg), sent: s0 + s });
        }
        if (real) s++;
      }
      s0 += s;
    }
    return out;
  }

  // ---- the engine ----------------------------------------------------------------------------
  function textOf(src, b) { return typeof src === 'string' ? src.slice(b.from, b.to) : src.sliceString(b.from, b.to); }

  function Engine(opts) { this.cache = new Map(); this.max = 20000; this.cfg = null; this.pos = null; this.setOptions(opts); }
  // Part-of-speech tags from now on (fn as for blockInfo; null = none). Blocks keyed while
  // tags were wanted but missing are redone on their next use.
  Engine.prototype.setPos = function (fn) {
    var c = this.cache;
    this.pos = fn || null;
    if (fn) c.forEach(function (r, k) { if (r.want && !r.tagged) c.delete(k); });
  };
  // Redo the waiting blocks whose tags have arrived → how many now key differently.
  Engine.prototype.settle = function () {
    var c = this.cache, pos = this.pos, cfg = this.cfg, todo = [], changed = 0;
    if (!pos) return 0;
    c.forEach(function (r, k) { if (r.pend && pos(r.ask) !== undefined) todo.push(k); });
    for (var i = 0; i < todo.length; i++) {
      var old = c.get(todo[i]), r = blockInfo(todo[i], cfg, pos);
      c.set(todo[i], r);
      if (occSig(old.occ) !== occSig(r.occ)) changed++;
    }
    return changed;
  };
  function occSig(a) { var s = ''; for (var i = 0; i < a.length; i++) s += a[i].from + a[i].key + ';'; return s; }
  // Forget the blocks still waiting for their tags → how many.
  Engine.prototype.dropPending = function () {
    var n = 0, c = this.cache;
    c.forEach(function (r, k) { if (r.pend) { c.delete(k); n++; } });
    return n;
  };
  // Returns true when the change affects the results (the cache is then dropped if needed).
  Engine.prototype.setOptions = function (opts) {
    var c = compile(opts), old = this.cfg;
    this.cfg = c;
    if (!old) return true;
    var keysChanged = old.stem !== c.stem || old.minLen !== c.minLen || old.names !== c.names || old.sig.split('|')[3] !== c.sig.split('|')[3];
    if (keysChanged) this.cache.clear();
    return old.sig !== c.sig;
  };
  Engine.prototype.info = function (text) {
    var c = this.cache, r = c.get(text);
    if (r) { c.delete(text); c.set(text, r); return r; }
    r = blockInfo(text, this.cfg, this.pos);
    c.set(text, r);
    if (c.size > this.max) { var it = c.keys(); while (c.size > this.max) c.delete(it.next().value); }
    return r;
  };
  Engine.prototype.blocks = function (src) { return sentenceCore().scanBlocks(src); };
  Engine.prototype.clear = function () { this.cache.clear(); };

  // Pick the nearer (more severe) of an occurrence's neighbours.
  function nearest(cfg, gw, gs, k, prev, next) {
    var best = null, sv, a;
    if (prev >= 0) { sv = severity(gw[k] - gw[prev], gs[k] - gs[prev], cfg); best = { sev: sv, other: prev, dir: -1 }; }
    if (next >= 0) {
      sv = severity(gw[next] - gw[k], gs[next] - gs[k], cfg);
      if (!best || sv > best.sev || (sv === best.sev && gw[next] - gw[k] < gw[k] - gw[best.other])) best = { sev: sv, other: next, dir: 1 };
    }
    if (best) { a = best.other; best.wordGap = Math.abs(gw[a] - gw[k]); best.sentGap = Math.abs(gs[a] - gs[k]); }
    return best;
  }

  // Echo marks for the words in [from, to] of src (a string or a CodeMirror Text):
  // [{ from, to, key, lw, sev, level, same, dir (-1 earlier / 1 later), wordGap, sentGap }].
  // blocks: a scanBlocks() result of src (pass it to reuse it).
  Engine.prototype.window = function (src, blocks, from, to) {
    var E = sentenceCore(), cfg = this.cfg, bl = blocks || E.scanBlocks(src), out = [];
    var a = E.firstBlockFrom(bl, from), b = a - 1, i;
    while (b + 1 < bl.length && bl[b + 1].from <= to) b++;
    if (b < a) return out;
    var infos = Object.create(null);
    function inf(j) { return infos[j] || (infos[j] = this.info(textOf(src, bl[j]))); }
    inf = inf.bind(this);
    // context: enough blocks either side that anything farther scores 0
    var ns = 0, nw = 0, a0 = a, b1 = b;
    while (a0 > 0 && ns <= cfg.taper && nw <= cfg.capW) { a0--; ns += inf(a0).s; nw += inf(a0).n; }
    ns = 0; nw = 0;
    while (b1 + 1 < bl.length && ns <= cfg.taper && nw <= cfg.capW) { b1++; ns += inf(b1).s; nw += inf(b1).n; }
    var keys = [], gw = [], gs = [], pos = [], inR = [], W0 = 0, S0 = 0;
    for (i = a0; i <= b1; i++) {
      var r = inf(i), off = bl[i].from;
      for (var k = 0; k < r.occ.length; k++) {
        var o = r.occ[k], f = off + o.from, t = off + o.to;
        keys.push(o.key); gw.push(W0 + o.w); gs.push(S0 + o.s); pos.push(o);
        inR.push(i >= a && i <= b && t >= from && f <= to ? f : -1);
      }
      W0 += r.n; S0 += r.s;
    }
    var n = keys.length, prev = new Int32Array(n), next = new Int32Array(n), last = new Map();
    for (i = 0; i < n; i++) { var p = last.get(keys[i]); prev[i] = p === undefined ? -1 : p; last.set(keys[i], i); }
    last.clear();
    for (i = n - 1; i >= 0; i--) { var q = last.get(keys[i]); next[i] = q === undefined ? -1 : q; last.set(keys[i], i); }
    for (i = 0; i < n; i++) {
      if (inR[i] < 0 || (prev[i] < 0 && next[i] < 0)) continue;
      var nb = nearest(cfg, gw, gs, i, prev[i], next[i]), lv = nb ? level(nb.sev) : 0;
      if (!lv) continue;
      var oo = pos[i];
      out.push({ from: inR[i], to: inR[i] + (oo.to - oo.from), key: keys[i], lw: oo.lw, sev: nb.sev, level: lv, same: nb.sentGap === 0, dir: nb.dir, wordGap: nb.wordGap, sentGap: nb.sentGap });
    }
    return out;
  };

  // The whole note: { keys: Map(key → { key, word, n, score, pos: [from…], len: [length…] }), words, top(limit) }.
  // score sums the severity of each occurrence against the one before it (how much it echoes).
  Engine.prototype.index = function (src, blocks) {
    var cfg = this.cfg, bl = blocks || sentenceCore().scanBlocks(src), keys = new Map(), W0 = 0, S0 = 0, words = 0;
    for (var i = 0; i < bl.length; i++) {
      var r = this.info(textOf(src, bl[i])), off = bl[i].from;
      for (var k = 0; k < r.occ.length; k++) {
        var o = r.occ[k], e = keys.get(o.key), w = W0 + o.w, s = S0 + o.s;
        if (!e) { e = { key: o.key, word: o.lw, n: 0, score: 0, pos: [], len: [], lw: 0, ls: 0 }; keys.set(o.key, e); }
        else e.score += severity(w - e.lw, s - e.ls, cfg);
        e.n++; e.pos.push(off + o.from); e.len.push(o.to - o.from); e.lw = w; e.ls = s;
      }
      W0 += r.n; S0 += r.s;
    }
    words = W0;
    return {
      keys: keys, words: words, sentences: S0,
      top: function (limit) {
        var a = [];
        keys.forEach(function (e) { if (e.n > 1 && e.score > 0) a.push(e); });
        a.sort(function (x, y) { return y.score - x.score || y.n - x.n || (x.word < y.word ? -1 : 1); });
        return a.slice(0, limit || 12);
      }
    };
  };
  // The candidate word at pos (or exactly [from, to) when to is given) → { from, to, key, lw } | null.
  Engine.prototype.wordAt = function (src, blocks, pos, to) {
    var E = sentenceCore(), bl = blocks || E.scanBlocks(src), i = E.blockAt(bl, pos);
    if (i < 0 || pos > bl[i].to) return null;
    var r = this.info(textOf(src, bl[i])), off = bl[i].from, p = pos - off, lo = 0, hi = r.occ.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, o = r.occ[mid];
      if (o.to < p) lo = mid + 1;
      else if (o.from > p) hi = mid - 1;
      else {
        if (to != null && to !== pos && (o.from !== p || o.to !== to - off)) return null;
        return { from: off + o.from, to: off + o.to, key: o.key, lw: o.lw };
      }
    }
    return null;
  };

  // Plain-text convenience: echo marks of a whole string.
  function analyze(text, opts) { var e = new Engine(opts); return e.window(text, null, 0, text.length); }

  return {
    DEFAULTS: DEFAULTS, LEVELS: LEVELS, MIN_SEV: MIN_SEV, W_WORD: W_WORD, W_SENT: W_SENT, AVG_SENT: AVG_SENT,
    STOPWORDS: STOP, isStopword: isStopword, stem: stem, normalize: normalize, compile: compile,
    severity: severity, level: level, blockInfo: blockInfo, tokenize: tokenize, Engine: Engine, analyze: analyze,
    sentenceCore: sentenceCore
  };
});
