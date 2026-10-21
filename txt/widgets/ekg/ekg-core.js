/* Prose EKG — the analyzer (pure: no DOM, no editor). Shared by ekg.js (the
 * panel) and ekg-view.js (the editor marks and margin strip); unit-tested by
 * ekg.test.js. UMD: module.exports in node, window.__cadeEkgCore in the page.
 *
 *   text ─scanBlocks→ prose blocks (paragraphs; code fences, front matter,
 *   tables, headings, HTML and indented code are skipped; headings are not
 *   analysed at all) ─analyzePara→ sentences with offsets + issues.
 * A very long run of lines without a blank line is cut into chunks at
 * content-chosen sentence ends, so one edit never re-analyses the whole run.
 *
 * Inside a block, Markdown and app syntax is masked out without changing a
 * single offset: inline code, URLs, e-mails and #tags become one opaque word
 * (\u0001 runs), image / file tokens, HTML tags and link brackets become
 * "gap" characters (\u0002) that are neither words nor whitespace, quote
 * prefixes and list markers become spaces. Every list item starts a sentence.
 *
 * Per sentence: words, syllables (heuristic), clauses (punctuation +
 * conjunctions + relative pronouns), Flesch-Kincaid grade, a 0-100
 * complexity score, a length class (short < 8 words, medium 8-20, long
 * 21-30, run-on > 30) and, past 25 words, the run-on "tail" (word 26 to the
 * end) in 8 levels that climb with every further word.
 *
 * The grammar / style checks are deliberately conservative — each one has an
 * exception list and is tested for false positives as much as for hits.
 *
 * Optional part-of-speech tags (the compromise library, run in nlp-worker.js
 * via nlp-client.js; Analyzer({ pos }) / setPos) widen three checks: its →
 * it's before a gerund or predicate adjective ("its raining", "its hard to
 * say"), then → than after any comparative the tagger knows ("taller then
 * John") — and no longer when a clause follows ("shorter then the nights
 * grew") — and comma splices with any subject + finite verb after the
 * sentence's first comma ("I love pizza, my wife hates it"). Tags are asked
 * for only when a rule has a candidate; a paragraph analysed while its tags
 * were still on the way is marked pend and settle() redoes it. Measured and
 * NOT used: compromise's sentence splitter (32 of the 53 split cases right vs
 * 53) and its passive / adjective verdicts (on real prose it calls "was
 * received", "are equipped" adjectives: it would have dropped ~60 true
 * passives per 100k words to drop ~20 stative ones). Hyphenated compound
 * adjectives ("old-fashioned", "left-handed") are never passives either way.
 *
 * Analyzer caches results per paragraph text (LRU), so re-analysing a note
 * after an edit only redoes the paragraph that changed. Offsets in a cached
 * result are relative to its block; callers add block.from. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.__cadeEkgCore = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var WORD = '\u0001', GAP = '\u0002', C_WORD = 1, C_GAP = 2;
  var SHORT = 8, MEDIUM = 20, LONG = 30, TAIL = 25, TAIL_RAMP = 20, TAIL_LEVELS = 8, COMPLEX = 60;
  var SOFT_CHUNK = 2000, HARD_CHUNK = 6000;
  var RE_LINE_END = /[.!?…:]["'”’)\]]*[ \t]*$/;

  function set(s) { var o = Object.create(null), a = s.split(/\s+/); for (var i = 0; i < a.length; i++) if (a[i]) o[a[i]] = 1; return o; }
  function fill(ch, n) { return n > 0 ? new Array(n + 1).join(ch) : ''; }

  // ---- character classes ----------------------------------------------------------
  function isSpaceC(c) { return c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || c === 0xA0 || (c >= 0x2000 && c <= 0x200A) || c === 0x202F || c === 0x3000; }
  function isDigitC(c) { return c >= 48 && c <= 57; }
  function isAlnumC(c) {
    return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
      (c >= 0xC0 && c <= 0x24F && c !== 0xD7 && c !== 0xF7) || (c >= 0x370 && c <= 0x52F) ||
      (c >= 0x1E00 && c <= 0x1FFF) || (c >= 0x3040 && c <= 0x9FFF) || (c >= 0xAC00 && c <= 0xD7AF);
  }
  function isUpperAt(t, i) {
    var c = t.charCodeAt(i);
    if (c >= 65 && c <= 90) return true;
    if (c < 0xC0 || !isAlnumC(c)) return false;
    var ch = t.charAt(i); return ch !== ch.toLowerCase();
  }
  function isLowerAt(t, i) {
    var c = t.charCodeAt(i);
    if (c >= 97 && c <= 122) return true;
    if (c < 0xC0 || !isAlnumC(c)) return false;
    var ch = t.charAt(i); return ch !== ch.toUpperCase();
  }
  function isTermC(c) { return c === 46 || c === 33 || c === 63 || c === 0x2026 || c === 0x203D; }
  function isQuoteC(c) { return c === 34 || c === 39 || c === 0x201D || c === 0x2019 || c === 0xBB || c === 0x203A || c === 0x201C || c === 0x2018; }
  // what may follow a full stop and still belong to the sentence: quotes, brackets, emphasis, gaps
  function isCloserC(c) { return isQuoteC(c) || c === 41 || c === 93 || c === 125 || c === 42 || c === 95 || c === 126 || c === 61 || c === C_GAP; }
  function isOpenerC(c) { return isQuoteC(c) || c === 40 || c === 91 || c === 123 || c === 42 || c === 95 || c === 126 || c === 0xAB || c === 0x2039 || c === 0xBF || c === 0xA1 || c === C_GAP; }
  function isEmojiC(c) { return (c >= 0xD83C && c <= 0xD83E) || (c >= 0x2600 && c <= 0x27BF) || (c >= 0x2B00 && c <= 0x2BFF) || (c >= 0x2300 && c <= 0x23FF); }
  // End of an emoji sequence starting at i (pairs, ZWJ joins, VS16, keycaps, skin tones).
  function emojiEnd(t, i) {
    var n = t.length;
    while (i < n) {
      var c = t.charCodeAt(i);
      if (c >= 0xD83C && c <= 0xD83E) i += 2;
      else if ((c >= 0x2600 && c <= 0x27BF) || (c >= 0x2B00 && c <= 0x2BFF) || (c >= 0x2300 && c <= 0x23FF) || c === 0xFE0F || c === 0x200D || c === 0x20E3) i++;
      else break;
    }
    return i;
  }

  // ---- word lists -------------------------------------------------------------------
  // Never end a sentence.
  var ABBR_STRONG = set('mr mrs ms mx dr prof rev hon sgt capt col cmdr lt gen gov sen rep pres supt insp cpl pvt adm maj brig messrs mmes mme mlle fr ' +
    'vs v e.g i.e cf viz approx appt fig figs eq eqs op pp ca al eds vol vols ch pg tel nos');
  // End a sentence only before a typical sentence opener ("etc. The …").
  var ABBR_AMBIG = set('etc inc ltd co corp llc plc bros jr sr st esq a.m p.m am pm u.s u.k u.n e.u u.s.a ph.d m.d b.a m.a b.sc m.sc d.c ' +
    'sec ft ave blvd rd mt dept est ext apt ' +
    'jan feb mar apr jun jul aug sep sept oct nov dec mon tue tues wed thu thur thurs fri sat sun');
  // Also usually followed by a lower-case word ("incl. tax", "approx. five").
  var ABBR_LOWER = set('ex eg ie incl esp misc min max orig lit govt intl natl yr yrs hr hrs mo mos wk wks qty pkg ref refs abbr abbrev aka resp cont contd attn ' +
    'assoc univ inst dist div est tbsp tsp oz lb lbs kg km cm mm sq approx avg info dept');
  // Typical first words of a sentence (lower-cased).
  var STARTERS = set("i it its it's the this that these those we he she they you my our his her their your there here a an in on at after before " +
    "when if as what why how who where now still yet also however today tomorrow yesterday next finally meanwhile later then but and so or nor " +
    "anyway sometimes some many most all no not one each every let please thanks thank maybe perhaps of for with although because since while " +
    "once unless until even just only is are was were do does did can could should would will yes ok okay oh well first second third last " +
    "overall instead otherwise besides moreover furthermore therefore thus hence again soon suddenly eventually luckily unfortunately " +
    "fortunately actually honestly basically clearly sadly happily hopefully obviously apparently from by to i'm i've i'll i'd we're they're " +
    "you're he's she's that's there's what's let's don't doesn't didn't can't won't isn't wasn't");
  var QWORDS = set("what why how who whom whose where when which is are was were do does did can could would should will shall may might must " +
    "have has had isn't aren't wasn't weren't don't doesn't didn't can't won't wouldn't shouldn't couldn't really right ok okay huh eh wow oh ah hey " +
    "yes no seriously sure great nice cool thanks thank");
  var CONJ = set('and but or nor yet so because although though unless while whereas whenever wherever whether if until when since which who whom whose');
  var SUBJ = set('i you he she it we they this that these those there the a an my our your his her their its some every each everyone everything ' +
    'nobody someone something nothing people one i\'m it\'s he\'s she\'s we\'re they\'re you\'re there\'s that\'s');
  var PRONOUN = set('i you he she it we they i\'m it\'s he\'s she\'s we\'re they\'re you\'re there\'s that\'s');
  var AUX = set('is was are were am be been has have had do does did will would can could should may might must');
  var PAST = set('went came said got made took saw knew thought felt left ran ate gave found told became kept began wrote sat stood lost paid met brought ' +
    'bought sent spent built held heard meant put read set won');
  var SUBORD = set('if when while because although though since unless after before as once until whenever wherever whether even');

  // ---- syllables ---------------------------------------------------------------------
  var SYL_EXC = { the: 1, every: 2, everything: 3, everyone: 3, business: 2, different: 3, area: 3, idea: 3, real: 1, really: 2,
    people: 2, science: 2, quiet: 2, poem: 2, being: 2, create: 2, created: 3, naive: 2, recipe: 3, simile: 3, coyote: 3, cafe: 2 };
  var sylCache = Object.create(null), sylN = 0;
  function syllables(w) {
    var r = sylCache[w];
    if (r) return r;
    r = sylCount(w);
    if (++sylN > 50000) { sylCache = Object.create(null); sylN = 0; }
    sylCache[w] = r;
    return r;
  }
  function sylCount(w) {
    if (/\d/.test(w)) return Math.min(5, Math.max(1, w.replace(/\D/g, '').length));
    if (w.indexOf('-') > 0) { var p = w.split('-'), s = 0; for (var i = 0; i < p.length; i++) if (p[i]) s += sylCount(p[i]); return Math.max(1, s); }
    var a = w.replace(/['’]/g, '').toLowerCase();
    if (SYL_EXC[a]) return SYL_EXC[a];
    var b = a.replace(/[^a-z]/g, '');
    if (b.length < a.length * 0.6) return Math.max(1, Math.round(a.length / 3));   // mostly non-Latin
    if (b.length <= 3) return 1;
    b = b.replace(/(?:[^laeiouy]es|[^laeiouydt]ed|[^laeiouy]e)$/, '').replace(/^y/, '').replace(/eau/g, 'o');
    var m = b.match(/[aeiouy]{1,2}/g);
    return m ? m.length : 1;
  }

  // ---- blocks --------------------------------------------------------------------------
  var RE_FENCE = /^[ \t]{0,3}(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})/;
  var RE_HEAD = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
  var RE_HR = /^[ \t]{0,3}([-*_=])(?:[ \t]*\1){2,}[ \t]*$/;
  var RE_TSEP = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$|^[ \t]*\|[ \t]*:?-{2,}:?[ \t]*\|[ \t]*$/;
  var RE_TROW = /^[ \t]*\|.*\|/;
  var RE_HTMLBLK = /^[ \t]{0,3}<(?:[A-Za-z][A-Za-z0-9-]*(?:[\s>\/]|$)|\/[A-Za-z]|!--)/;
  var RE_INDENT = /^(?: {4}|\t)/;
  var RE_BLANK = /^[ \t]*$/;
  var RE_MEDIA_LINE = /^[ \t]*(?:(?:!\[(?:img|file):[^\]]*\]|!\[[^\]]*\]\([^)]*\))[ \t]*)+$/;
  var RE_LISTLINE = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+•]|\d{1,3}[.)])[ \t]+|^[ \t]*\[[ xX]\][ \t]/;
  var RE_FM_KEY = /^[A-Za-z0-9_-]+[ \t]*:/;

  function strHash(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return h; }
  // A CM6-style line iterator over a string (next() → this; .value, .done).
  function strLines(s) {
    var pos = 0, it = { value: '', done: false };
    it.next = function () {
      if (pos > s.length) { it.done = true; it.value = ''; return it; }
      var e = s.indexOf('\n', pos);
      if (e < 0) e = s.length;
      it.value = s.slice(pos, e);
      pos = e + 1;
      return it;
    };
    return it;
  }
  function textOf(src, b) { return typeof src === 'string' ? src.slice(b.from, b.to) : src.sliceString(b.from, b.to); }

  // The prose blocks of a text (a string or a CodeMirror Text): [{ from, to }].
  function scanBlocks(src) {
    var it = typeof src === 'string' ? strLines(src) : src.iterLines();
    var blocks = [], cur = [];
    var fence = null, table = false, html = false, icode = false, blank = true, list = false;
    // A very long run of lines (a note written line by line, a long list) is cut into chunks
    // after a sentence end / before a list item, so an edit re-analyses only its chunk. The
    // cut points depend on the lines' own content (a hash), not on offsets: an edit early on
    // doesn't move every later chunk (which would empty the cache).
    function flush() {
      var n = cur.length;
      if (!n) return;
      var a = 0;
      if (cur[n - 1][1] - cur[0][0] > SOFT_CHUNK) {
        for (var k = 0; k < n - 1; k++) {
          var span = cur[k][1] - cur[a][0];
          if (span > HARD_CHUNK || ((cur[k + 1][3] || RE_LINE_END.test(cur[k][2])) && (strHash(cur[k][2]) & 15) === 0)) {
            blocks.push({ from: cur[a][0], to: cur[k][1] });
            a = k + 1;
          }
        }
      }
      blocks.push({ from: cur[a][0], to: cur[n - 1][1] });
      cur = [];
    }
    function line(L, from) {
      var to = from + L.length, m;
      if (fence) {
        m = RE_FENCE.exec(L);
        if (m && m[1].charAt(0) === fence.ch && m[1].length >= fence.n && RE_BLANK.test(L.slice(m[0].length))) fence = null;
        return;
      }
      if ((m = RE_FENCE.exec(L))) { flush(); fence = { ch: m[1].charAt(0), n: m[1].length }; blank = table = html = icode = false; return; }
      if (RE_BLANK.test(L)) { flush(); blank = true; table = html = false; return; }
      if (html) return;
      if (icode) { if (RE_INDENT.test(L)) return; icode = false; }
      if (table) { if (L.indexOf('|') >= 0) return; table = false; }
      if (RE_HEAD.test(L)) { flush(); blank = list = false; return; }
      if (RE_TSEP.test(L)) {                       // the header row above belongs to the table
        if (cur.length && cur[cur.length - 1][2].indexOf('|') >= 0) cur.pop();
        flush(); table = true; blank = false; return;
      }
      if (RE_TROW.test(L)) { flush(); table = true; blank = false; return; }
      if (RE_HR.test(L)) { flush(); blank = list = false; return; }
      if (!cur.length && RE_HTMLBLK.test(L)) { html = true; blank = false; return; }
      var isList = RE_LISTLINE.test(L);
      if (!cur.length && blank && !list && !isList && RE_INDENT.test(L)) { icode = true; blank = false; return; }
      if (RE_MEDIA_LINE.test(L)) { flush(); blank = false; return; }
      if (!cur.length) list = isList;
      else if (isList) list = true;
      cur.push([from, to, L, isList]);
      blank = false;
    }
    // YAML front matter: "---" on line 1, "key:" on line 2, closed by --- / ... within 200 lines;
    // anything else is replayed as ordinary lines
    var pos = 0, idx = 0, fm = null;
    function replay() { var b = fm; fm = false; for (var q = 0; q < b.length; q++) line(b[q][0], b[q][1]); }
    while (!it.next().done) {
      var L = it.value, from = pos;
      pos += L.length + 1;
      if (idx++ === 0 && /^---[ \t]*$/.test(L)) { fm = [[L, from]]; continue; }
      if (fm) {
        if (fm.length > 1 && /^(?:---|\.\.\.)[ \t]*$/.test(L)) { fm = false; continue; }
        fm.push([L, from]);
        if ((fm.length === 2 && !RE_FM_KEY.test(L)) || fm.length > 200) replay();
        continue;
      }
      line(L, from);
    }
    if (fm) replay();
    flush();
    return blocks;
  }

  // ---- masking -------------------------------------------------------------------------
  var RE_QUOTE = /^[ \t]*(?:>[ \t]?)+/;
  var RE_CALLOUT = /^\[![A-Za-z-]+\][+-]?[ \t]*/;
  var RE_LIST = /^[ \t]*(?:(?:[-*+•]|\d{1,3}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|\[[ xX]\][ \t]+)/;
  var RE_CODE = /``[^`\n]+``|`[^`\n]+`/g;
  var RE_FTOKEN = /!\[(?:img|file):[^\]\n]*\]/g;
  var RE_IMG = /!\[[^\]\n]*\]\([^)\n]*\)/g;
  var RE_AUTOLINK = /<(?:https?:\/\/|mailto:)[^>\s]+>/gi;
  var RE_HTML = /<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>\n]*)?\/?>/g;
  var RE_LINK = /\[([^\]\n]*)\]\(([^)\n]*)\)|\[([^\]\n]+)\]\[([^\]\n]*)\]/g;
  var RE_WIKI = /\[\[([^\]\n]*)\]\]/g;
  var RE_FOOT = /\[\^[^\]\n]+\]/g;
  var RE_URL = /\b(?:https?:\/\/|www\.)[^\s<>"'`\u0001\u0002]+/gi;
  var RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
  var RE_TAG = /(^|[\s(])(#[A-Za-z][\w\/-]*)/g;
  var RE_SPOILER = /\|\|/g;

  // Same-length masked copy of a block + the forced sentence starts.
  function mask(src) {
    var lines = src.split('\n'), out = [], breaks = [], pos = 0, prev = null;
    for (var li = 0; li < lines.length; li++) {
      var L = lines[li], m, pre = 0, isList = false;
      if ((m = RE_QUOTE.exec(L))) pre = m[0].length;
      var rest = L.slice(pre);
      if ((m = RE_CALLOUT.exec(rest))) { pre += m[0].length; rest = L.slice(pre); }
      if ((m = RE_LIST.exec(rest))) { pre += m[0].length; rest = L.slice(pre); isList = true; }
      if (isList) breaks.push({ pos: pos + pre, kind: 'list' });
      else if (prev !== null) {
        // A short line without a full stop followed by a capitalised line ("Shopping\nMilk…",
        // "Dear Sam,\nThanks…", "Notes:\nWe…") is a sentence break; long lines are wrapped prose.
        var pt = prev.replace(/[\s\u0002]+$/, ''), fi = rest.search(/\S/);
        if (pt && fi >= 0 && !/[.!?…‽"”'’)\]]$/.test(pt) && (pt.length < 40 || /:$/.test(pt)) && isUpperAt(rest, fi)) breaks.push({ pos: pos + pre + fi, kind: 'line' });
      }
      prev = rest;
      out.push(pre ? fill(' ', pre) + rest : rest);
      pos += L.length + 1;
    }
    var t = out.join('\n');
    if (t.indexOf('`') >= 0) t = t.replace(RE_CODE, function (m0) { return fill(WORD, m0.length); });
    if (t.indexOf('![') >= 0) t = t.replace(RE_FTOKEN, function (m0) { return fill(GAP, m0.length); }).replace(RE_IMG, function (m0) { return fill(GAP, m0.length); });
    if (t.indexOf('<') >= 0) t = t.replace(RE_AUTOLINK, function (m0) { return fill(WORD, m0.length); }).replace(RE_HTML, function (m0) { return fill(GAP, m0.length); });
    if (t.indexOf('[') >= 0) {
      t = t.replace(RE_WIKI, function (m0, a) { return GAP + GAP + a + GAP + GAP; })
        .replace(RE_FOOT, function (m0) { return fill(GAP, m0.length); })
        .replace(RE_LINK, function (m0, a, u, b) { var x = a != null ? a : b; return GAP + x + fill(GAP, m0.length - 1 - x.length); });
    }
    if (/https?:|www\./i.test(t)) t = t.replace(RE_URL, function (m0) {
      var u = m0.replace(/[.,;:!?)\]*_]+$/, '');
      if (/\)$/.test(m0.slice(0, u.length + 1)) && u.indexOf('(') >= 0) u = m0.slice(0, u.length + 1);
      return fill(WORD, u.length) + m0.slice(u.length);
    });
    if (t.indexOf('@') >= 0) t = t.replace(RE_EMAIL, function (m0) { return fill(WORD, m0.length); });
    if (t.indexOf('#') >= 0) t = t.replace(RE_TAG, function (m0, a, b) { return a + fill(WORD, b.length); });
    if (t.indexOf('||') >= 0) t = t.replace(RE_SPOILER, GAP + GAP);
    return { t: t, breaks: breaks };
  }

  // ---- sentences -----------------------------------------------------------------------
  function wordAt(t, i) {
    var j = i;
    while (j < t.length) { var c = t.charCodeAt(j); if (isAlnumC(c) || ((c === 39 || c === 0x2019) && j > i)) j++; else break; }
    return t.slice(i, j).toLowerCase().replace(/’/g, "'");
  }
  // Is the full stop / ! / ? at t[i..j) a sentence end, given the next word starts at m?
  function isBoundary(t, s, i, j, quoted, m) {
    var run = t.slice(i, j), bang = /[!?‽]/.test(run);
    while (m < t.length && isOpenerC(t.charCodeAt(m))) m++;
    var up = isUpperAt(t, m), low = isLowerAt(t, m);
    if (bang) {
      if (!low) return true;
      if (quoted) return false;                          // "'Who?' she asked", "(sadly!) it" go on
      // before a lower-case word only after a question-like opening or a short burst
      // ("Really? yes", "Wow! that…") — not "Use match? when …"
      var f = s;
      while (f < i && isOpenerC(t.charCodeAt(f))) f++;
      return !!QWORDS[wordAt(t, f)] || (t.slice(s, i).match(/[A-Za-z0-9\u00C0-\u024F]+/g) || []).length <= 1;
    }
    if (run.indexOf('…') >= 0 || run.length >= 3) return up;  // an ellipsis ends a sentence only before a capital
    var a = i;
    while (a > s) { var c = t.charCodeAt(a - 1); if (isAlnumC(c) || c === 46) a--; else break; }
    var tok = t.slice(a, i), lt = tok.toLowerCase();
    if (low && (quoted || !tok)) return false;            // '"Stop." he said', "a dot (.) in"
    if (!tok) return true;
    if (ABBR_STRONG[lt]) return false;
    if (lt === 'no' && isDigitC(t.charCodeAt(m))) return false;
    if (ABBR_AMBIG[lt] || /^(?:[a-z]\.)+[a-z]$/i.test(tok) || (tok.length === 1 && !isDigitC(tok.charCodeAt(0)))) return up && !!STARTERS[wordAt(t, m)];
    if (low) return !(ABBR_LOWER[lt] || /^\d+$/.test(lt) || (lt.length <= 4 && /^[a-z]+$/.test(lt) && !/[aeiouy]/.test(lt)));
    return true;
  }
  // Sentence ranges of a masked block: [{ from, to, after, end }]; after/end name the
  // break before / the terminator: start, list, line, stop, bang, ell, emoji, none.
  function split(t, breaks) {
    var out = [], n = t.length, s = -1, bi = 0, prev = 'start', c;
    var nb = breaks.length ? breaks[0].pos : -1;
    function close(end, kind) {
      while (end > s && isSpaceC(t.charCodeAt(end - 1))) end--;
      if (end > s) out.push({ from: s, to: end, after: prev, end: kind });
      s = -1; prev = kind;
    }
    for (var i = 0; i < n; i++) {
      while (nb >= 0 && i >= nb) {
        if (s >= 0) close(nb, 'none');
        prev = breaks[bi].kind;
        bi++; nb = bi < breaks.length ? breaks[bi].pos : -1;
      }
      c = t.charCodeAt(i);
      if (s < 0) { if (isSpaceC(c) || c === C_GAP) continue; s = i; }
      if (isTermC(c)) {
        var j = i + 1;
        while (j < n && isTermC(t.charCodeAt(j))) j++;
        var k = j, quoted = false;
        while (k < n && isCloserC(c = t.charCodeAt(k))) { if (isQuoteC(c) || c === 41 || c === 93) quoted = true; k++; }
        // an emoji right after the stop belongs to this sentence ("Done! 🎉")
        var e = k;
        while (e < n && (t.charCodeAt(e) === 32 || t.charCodeAt(e) === 9)) e++;
        if (e < n && isEmojiC(t.charCodeAt(e))) { var e2 = emojiEnd(t, e); if (e2 >= n || isSpaceC(t.charCodeAt(e2))) k = e2; }
        if (k < n && !isSpaceC(t.charCodeAt(k))) { i = j - 1; continue; }
        var m = k;
        while (m < n && (isSpaceC(c = t.charCodeAt(m)) || c === C_GAP)) m++;
        var stop = m >= n || (nb >= 0 && nb <= m) || isBoundary(t, s, i, j, quoted, m);
        if (stop) {
          var run = t.slice(i, j);
          close(k, /[!?‽]/.test(run) ? 'bang' : (run.indexOf('…') >= 0 || run.length >= 3) ? 'ell' : 'stop');
          i = k - 1;
        } else i = j - 1;
      } else if (isEmojiC(c)) {
        // "I love it 😍 It works" — an emoji between a word and a typical opener ends a sentence
        var ee = emojiEnd(t, i);
        if (i > s && (ee >= n || isSpaceC(t.charCodeAt(ee)))) {
          var p = i - 1;
          while (p > s && isSpaceC(t.charCodeAt(p))) p--;
          var mm = ee;
          while (mm < n && isSpaceC(t.charCodeAt(mm))) mm++;
          if (isAlnumC(t.charCodeAt(p)) && mm < n && !(nb >= 0 && nb <= mm) && isUpperAt(t, mm) && STARTERS[wordAt(t, mm)]) { close(ee, 'emoji'); i = ee - 1; continue; }
        }
        i = ee - 1;
      }
    }
    if (s >= 0) close(n, 'none');
    return out;
  }

  // Words of t[from, to): [{ from, to, lw (lower-case), op (opaque: code / URL / tag) }]
  function tokenize(t, from, to) {
    var out = [], i = from, c, j;
    while (i < to) {
      c = t.charCodeAt(i);
      if (c === C_WORD) {
        j = i + 1;
        while (j < to && t.charCodeAt(j) === C_WORD) j++;
        out.push({ from: i, to: j, lw: '', op: true });
        i = j; continue;
      }
      if (isAlnumC(c)) {
        j = i + 1;
        while (j < to) {
          c = t.charCodeAt(j);
          if (isAlnumC(c)) { j++; continue; }
          if ((c === 39 || c === 0x2019 || c === 45 || c === 0x2010) && j + 1 < to && isAlnumC(t.charCodeAt(j + 1))) { j += 2; continue; }
          if ((c === 46 || c === 44) && isDigitC(t.charCodeAt(j - 1)) && j + 1 < to && isDigitC(t.charCodeAt(j + 1))) { j += 2; continue; }
          break;
        }
        out.push({ from: i, to: j, lw: t.slice(i, j).toLowerCase(), op: false });
        i = j; continue;
      }
      i++;
    }
    return out;
  }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function classOf(n) { return n < SHORT ? 's' : n <= MEDIUM ? 'm' : n <= LONG ? 'l' : 'r'; }
  // Run-on tail level (1..8) of the k-th word (0-based; k >= TAIL).
  function tailIntensity(k) { return Math.min(1, (k - TAIL + 1) / TAIL_RAMP); }
  function tailLevel(k) { return Math.min(TAIL_LEVELS, Math.max(1, Math.ceil(tailIntensity(k) * TAIL_LEVELS))); }
  function round1(x) { return Math.round(x * 10) / 10; }

  function measure(t, r, ws) {
    var n = ws.length, syl = 0, long = 0, markers = 0, pend = false, k, w, q, c;
    for (k = 0; k < n; k++) {
      w = ws[k];
      if (k) {
        for (q = ws[k - 1].to; q < w.from; q++) {
          c = t.charCodeAt(q);
          if (c === 44 || c === 59 || c === 58 || c === 0x2014 || c === 0x2013 ||
            (c === 45 && (t.charCodeAt(q + 1) === 45 || (isSpaceC(t.charCodeAt(q - 1)) && isSpaceC(t.charCodeAt(q + 1)))))) { pend = true; break; }
        }
      }
      var sy = w.op ? 1 : syllables(w.lw);
      syl += sy;
      if (sy >= 3) long++;
      if (!w.op && CONJ[w.lw]) { if (k) markers++; pend = false; }
      else if (pend) { markers++; pend = false; }
    }
    var grade = n ? Math.max(0, 0.39 * n + 11.8 * syl / n - 15.59) : 0, clauses = 1 + markers, lr = n ? long / n : 0;
    var score = 30 * Math.min(n, 40) / 40 + 30 * Math.min(clauses - 1, 5) / 5 + 20 * Math.min(lr / 0.35, 1) + 20 * clamp01((grade - 8) / 12);
    var tail = null;
    if (n > TAIL) {
      var steps = [], last = -1;
      for (k = TAIL; k < n; k++) {
        var lvl = tailLevel(k), b = k + 1 < n ? ws[k + 1].from : r.to;
        if (lvl === last) steps[steps.length - 1][1] = b; else steps.push([ws[k].from, b, lvl]);
        last = lvl;
      }
      tail = { from: ws[TAIL].from, to: r.to, words: n - TAIL, level: last, steps: steps };
    }
    return {
      from: r.from, to: r.to, words: n, syll: syl, clauses: clauses, long: long, grade: round1(grade), score: Math.round(score),
      // "very complex" needs hard words too — a long chain of short words is a run-on, not dense prose
      cls: classOf(n), complex: score >= COMPLEX && n >= 12 && (lr >= 0.12 || syl / n >= 1.45), tail: tail, after: r.after, end: r.end, first: ''
    };
  }

  // ---- grammar & style -----------------------------------------------------------------
  var CAT = { passive: 'passive', filler: 'filler' };
  function catOf(type) { return CAT[type] || 'grammar'; }
  var REPEAT_OK = set('had that much ha haha no so bye knock chop night yeah well now there tut blah bla hey very really oh ah la na go yes hip ho dum cha bang boo pom tsk wow mm hmm uh ok okay more many far long bye-bye');
  // names that are also words: "Will will come", "May may go"
  var NAME_WORDS = set('will may bill mark sue pat rob jack art frank grant hope joy rose faith grace june april august summer chase drew guy');
  var ACRO_WORDS = set('NASA NATO UNESCO UNICEF ASAP AIDS OPEC NAFTA FIFA SCUBA LASER RADAR SIM PIN RAM ROM GIF JIF JPEG FAQ SQL LED LOL SHA YOLO IKEA URL MOD LAN WAN NAT SAT HVAC ASCII GIF MOOC NIMBY SWAT');
  var ACRO_LETTERS = set('IEEE OECD NAACP AAA UAE');
  var ART_SKIP = set('is are was were and or of in on at as if it its up us an a am to be by so do no not the');
  var H_SILENT = /^(?:hour|honest|honou?r|heir)/;
  var H_EITHER = /^(?:herb|histor|hotel|homage|humble)/;
  var YOO = /^(?:uni(?![mnd])|unan|use|usa|usu|uti|ura|ure|uri|uro|ute|uto|ubiq|uku|ukr|ugand|uvu|u-|eu|ewe|one(?!r)|once|ouija|url|usb|utf|uuid|u[ix]$)/;
  // true = starts with a vowel sound, false = consonant sound, null = unsure (skip)
  function vowelSound(w) {
    var lw = w.toLowerCase();
    if (isDigitC(w.charCodeAt(0))) return /^8/.test(w) || /^1[18](?!\d)/.test(w) || /^1[18]\d\d(?!\d)/.test(w) || /^1[18],\d{3}/.test(w);
    var core = /^[A-Z][A-Z0-9]+s?$/.test(w) ? w.replace(/s$/, '') : '';
    if (core && /^[A-Z][A-Z0-9]*[A-Z0-9]$/.test(core) && core.length >= 2) {
      if (ACRO_WORDS[core]) return null;
      if (core.length >= 4 && /[AEIOU]/.test(core) && !ACRO_LETTERS[core]) return null;   // said as a word
      return 'AEFHILMNORSX'.indexOf(core.charAt(0)) >= 0;
    }
    if (w.length === 1) return null;
    var w1 = lw.split('-')[0];
    if (/^(?:npm|ssh|sql|svg|rpm|ftp|smtp|ssl|tls|xml|rss|scss|sdk|mcp|llm|nlp|cli|mp[34])/.test(w1)) return 'AEFHILMNORSX'.indexOf(w1.charAt(0).toUpperCase()) >= 0;
    if (/^[a-z]+$/.test(w1) && !/[aeiou]/.test(w1)) return null;   // npm, html, https: said letter by letter
    if (/^x-/.test(lw)) return true;
    if (H_SILENT.test(lw)) return true;
    if (H_EITHER.test(lw)) return null;
    if (/^[aeiou]/.test(lw)) return !YOO.test(lw);
    if (/^[a-z]/.test(lw)) return false;
    return null;
  }
  var IRREG_PP = set('arisen awoken beaten become begun bent bet bid bitten blown broken brought built burnt bought caught chosen come cut dealt dug drawn ' +
    'dreamt driven eaten fed fought found flown forbidden forgotten forgiven frozen given grown hung heard hidden hit held hurt kept knelt known laid led ' +
    'lent let lit made meant met mistaken paid proven put quit read rewritten ridden rung risen run said seen sought sold sent set sewn shaken shed shot ' +
    'shown shrunk shut sung sunk slain slept slung spoken sped spent spun split spread sprung stolen stuck stung struck sworn swept swollen taken taught torn ' +
    'told thought thrown understood undertaken undone woken worn woven won wound withdrawn written overcome overtaken overthrown overseen beheld begotten ' +
    'forsaken bound ground cast broadcast forecast');
  var NOT_PP = set('hundred sacred naked wicked kindred hatred rugged ragged crooked beloved aged embed indeed shred infrared biped moped wretched dogged jagged ' +
    'bed red wed fled sled shed bred');
  var EED_PP = set('freed agreed guaranteed decreed refereed');
  // statives that read as adjectives, not as passives ("I am tired", "it is based on")
  var ADJ_PP = set('tired excited bored scared worried married interested surprised pleased satisfied confused concerned supposed involved embarrassed ' +
    'frightened amazed annoyed ashamed delighted disappointed disgusted exhausted relaxed stressed determined complicated sophisticated detailed talented ' +
    'crowded skilled experienced qualified dedicated related located based dressed engaged divorced retired unemployed overwhelmed thrilled fascinated ' +
    'terrified horrified convinced entitled inclined obliged acquainted accustomed devoted opposed finished done gone born lost left upset blessed ' +
    'prepared');
  var BE = set('am is are was were be been being');
  var ADV = set('not never also already often always just still then now all both usually sometimes really very quite rarely seldom even ever largely');
  var LY_NOT = set('only early family reply supply apply july ally fly belly holy ugly lonely likely lovely friendly silly jelly rely italy');
  var FILLER = set('very really just actually basically literally');
  var PP_NEXT = set('been had gone done known seen got gotten made taken thought said told left lost won come become went ate gave');
  var THAN_STRONG = set('more less rather fewer other');
  var THAN_ADJ = 'better|worse|greater|larger|smaller|bigger|higher|lower|older|younger|cheaper|stronger|weaker|richer|smarter|nicer|happier|faster|slower|longer|shorter|easier|harder';
  var THAN_NEXT = set('ever usual before expected anticipated planned needed necessary normal average me him her us them that this those these the a an any ' +
    'anyone anything anybody everyone everything most many last mine yours ours theirs his');
  var LOWER_OK = set('e eg i ie etc vs cf viz aka www http https npm git');

  var RE_REPEAT = /\b([A-Za-z]+(?:['’][A-Za-z]+)?)([ \t]+|[ \t]*\n[ \t]*)(\1)\b/gi;
  var RE_ART = /\b(an?)([ \t]+|[ \t]*\n[ \t]*)([A-Za-z0-9][A-Za-z0-9'’-]*)/gi;
  var RE_NOSPACE = /([a-z]{2})([.!?])([A-Z][a-z])/g;
  var RE_SPACEBEFORE = /([A-Za-z0-9)\]"'”’])([ \t]+)([,;]|[.!?]+$)(?=[ \t\n]|$)/g;
  var RE_DOUBLE = /,,+|;;+|\.{2,}|[,;]\.(?!\.)|,;|;,/g;
  var RE_OF = /\b(could|should|would|must|might)([ \t]+)(of)([ \t]+)([A-Za-z]+)/gi;
  var RE_ALOT = /\b(alot)\b/gi;
  var RE_WELCOME = /\b(your)([ \t]+)welcome\b(?![ \t]*[A-Za-z0-9])/gi;
  var RE_THEN = new RegExp('\\b(more|less|rather|fewer|other|' + THAN_ADJ + ')([ \\t]+)(then)([ \\t]+)([A-Za-z0-9$£€]+)', 'gi');
  var RE_ITS = /\b(its)([ \t]+)(a|an|the|not|been|gonna)\b/gi;
  var ITS_NEXT = set('a an the not been gonna');
  var RE_ITSOWN = /\b(it['’]s)([ \t]+)own\b/gi;
  var RE_SPLICE = /,([ \t]+)(?:(?:it|i|he|she|we|they|this|there|you)[ \t]+(?:is|was|are|were|am|has|had|have|will|would|can|could|should|did|does|do|isn['’]t|wasn['’]t|aren['’]t|weren['’]t|don['’]t|doesn['’]t|didn['’]t|can['’]t|won['’]t)|it['’]s|i['’]m|they['’]re|we['’]re|you['’]re|he['’]s|she['’]s|there['’]s|i['’]ve|we['’]ve|they['’]ve|i['’]ll|we['’]ll|they['’]ll|it['’]ll)\b/gi;

  // ---- optional part-of-speech tags (compromise, run in nlp-worker.js) -----------------
  // A paragraph's tags arrive as { s: [start], e: [end], b: [tag bits], r: [root or ''] }
  // with offsets into the paragraph (block-relative, same as the masked text). Rules
  // only consult them to confirm or widen a candidate the word lists already found, so
  // without them (offline, still loading, failed) every rule behaves as before.
  var NLP_TAGS = ['Noun', 'Pronoun', 'ProperNoun', 'Person', 'Place', 'Organization', 'Verb', 'Gerund', 'Infinitive', 'PastTense',
    'PresentTense', 'Participle', 'Passive', 'Copula', 'Auxiliary', 'Modal', 'Adjective', 'Comparative', 'Superlative', 'Adverb',
    'Determiner', 'Possessive', 'Preposition', 'Conjunction', 'Value', 'Date', 'Plural', 'Acronym', 'Imperative', 'Negative'];
  var TB = {}, TAG_IX = {};
  for (var ti0 = 0; ti0 < NLP_TAGS.length; ti0++) { TB[NLP_TAGS[ti0]] = 1 << ti0; TAG_IX[NLP_TAGS[ti0]] = ti0; }
  // The text compromise sees: opaque words become x-runs, gaps become spaces (same length).
  function nlpPrep(t) { return t.replace(/\u0001/g, 'x').replace(/\u0002/g, ' '); }
  function nlpRoot(t, bits, tf, model) {
    var w = String(t.normal || t.text || '').toLowerCase().replace(/['’]s$/, '').replace(/['’]$/, ''), out = '';
    if (!tf || !w) return '';
    try {
      if ((bits & TB.Verb) && !(bits & (TB.Auxiliary | TB.Copula | TB.Modal))) {
        var tense = bits & TB.Gerund ? 'Gerund' : bits & TB.Participle ? 'Participle' : bits & TB.PastTense ? 'PastTense' : bits & TB.PresentTense ? 'PresentTense' : '';
        if (tense === 'PresentTense') {
          // only a plain third-person -s / -es / -ies (the library also "un-conjugates" pass, dare)
          if (/[^s]s$/.test(w)) {
            out = tf.verb.toInfinitive(w, model, tense);
            if (out !== w.slice(0, -1) && out !== w.slice(0, -2) && out !== w.slice(0, -3) + 'y') out = '';
          }
        } else if (tense) {
          out = tf.verb.toInfinitive(w, model, tense);
          if ((!out || out === w) && tense === 'PastTense') out = tf.verb.toInfinitive(w, model, 'Participle');
        }
      } else if ((bits & TB.Noun) && (bits & TB.Plural) && !(bits & TB.Pronoun)) out = tf.noun.toSingular(w, model);
    } catch (e) { out = ''; }
    return out && out !== w && /^[a-z][a-z'-]*$/.test(out) ? out : '';
  }
  // Tag one prepared paragraph with compromise (nlp = the library's main function).
  function nlpEncode(nlp, text) {
    var doc = nlp(text), tf = null, model = null, out = { s: [], e: [], b: [], r: [] };
    doc.compute('offset');
    try { tf = nlp.methods().two.transform; model = nlp.model(); } catch (e) {}
    var docs = doc.docs || [];
    for (var i = 0; i < docs.length; i++) {
      for (var j = 0; j < docs[i].length; j++) {
        var t = docs[i][j];
        if (!t.text || !t.offset) continue;                // implicit terms ("'s" → is)
        var bits = 0;
        t.tags.forEach(function (g) { var x = TAG_IX[g]; if (x != null) bits |= 1 << x; });
        out.s.push(t.offset.start); out.e.push(t.offset.start + t.offset.length); out.b.push(bits);
        out.r.push(nlpRoot(t, bits, tf, model));
      }
    }
    return out;
  }
  // Index of the term covering offset p (start <= p < end), or -1.
  function posAt(P, p) {
    var lo = 0, hi = P.s.length - 1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (P.e[mid] <= p) lo = mid + 1; else if (P.s[mid] > p) hi = mid - 1; else return mid; }
    return -1;
  }
  function posBits(P, p) { var i = posAt(P, p); return i < 0 ? 0 : P.b[i]; }
  var FINITE_NOT = TB.Gerund | TB.Participle;
  // A finite verb ("hates", "were", "arrive") — not "shining" or a bare participle.
  function finiteVerb(b) {
    if (!(b & TB.Verb)) return false;
    if (b & (TB.Copula | TB.Auxiliary | TB.Modal)) return true;
    return !(b & FINITE_NOT) && !!(b & (TB.PastTense | TB.PresentTense));
  }
  var HYPHEN_PRE = set('re co pre de un non mis over under out');

  function capFirst(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function sameCase(model, word) { return /^[A-Z]/.test(model) ? capFirst(word) : word; }
  function isPP(w) {
    if (IRREG_PP[w]) return true;
    if (w.length < 4 || NOT_PP[w]) return false;
    if (/eed$/.test(w)) return !!EED_PP[w];
    return /ed$/.test(w);
  }
  function isAdv(w) { return !!ADV[w] || (w.length > 4 && /ly$/.test(w) && !LY_NOT[w]); }

  // Is t[a, b) only spaces (no punctuation between two words)?
  function onlySpace(t, a, b) { for (var i = a; i < b; i++) if (!isSpaceC(t.charCodeAt(i))) return false; return true; }
  // The clause before a comma (head = the sentence up to it) looks independent: it starts with
  // a subject, has a verb, isn't quoted / bracketed / subordinate. verbIn(a, b) = POS says
  // head[a, b) holds a finite verb (null: word lists only).
  function spliceLeft(head, ws, verbIn) {
    var cs = Math.max(head.lastIndexOf(','), head.lastIndexOf(';'), head.lastIndexOf(':'), head.lastIndexOf('—'), head.lastIndexOf('–'));
    var clause = head.slice(cs + 1), cw = clause.match(/[A-Za-z0-9'’]+/g) || [];
    if (cw.length < 3 || /["“”]/.test(head) || head.lastIndexOf('(') > head.lastIndexOf(')') || /\)\s*$/.test(head)) return false;
    // ("On Windows, you can…", "For most uses, this is…" are introductory phrases)
    var c0 = cw[0].toLowerCase().replace(/’/g, "'");
    if (!SUBJ[c0]) return false;
    var verb = PRONOUN[c0];
    for (var v2 = 1; v2 < cw.length && !verb; v2++) {
      var cv = cw[v2].toLowerCase().replace(/’/g, "'");
      verb = !!(AUX[cv] || PAST[cv] || /^\w+'(?:s|re|ve|ll|d|m)$|n't$/.test(cv) || (cv.length > 3 && /ed$/.test(cv)));
    }
    if (!verb && verbIn) verb = verbIn(cs + 1, head.length);
    if (!verb) return false;
    for (var q = 0; q < cw.length; q++) if (SUBORD[cw[q].toLowerCase()]) return false;
    return !(ws[0] && SUBORD[ws[0].lw]);
  }

  // "I think its …": verbs that take a whole clause
  var SAY = set('think thought know knew guess hope believe say said says mean feel felt suppose reckon bet sure');
  var SPLICE_NOT = set('that which who whom whose where when what whichever whatever wherever however as than so more less most a an');
  var OBJ_PRON = set('me him her us them mine yours ours theirs his hers');
  // Word index starting exactly at offset p, or -1.
  function wordIndexAt(ws, p) { for (var i = 0; i < ws.length; i++) { if (ws[i].from === p) return i; if (ws[i].from > p) break; } return -1; }
  // From word k on: a noun phrase that goes on with a finite verb ("the nights grew",
  // "I went") — i.e. a clause, not the object of a comparison ("than the house", "than me").
  function clauseAfter(TP, ws, t, k) {
    var n = k, b;
    if (OBJ_PRON[ws[n].lw]) n++;
    else {
      while (n < ws.length && n < k + 4 && ((b = posBits(TP, ws[n].from)) & (TB.Determiner | TB.Possessive | TB.Adjective | TB.Value)) && (!(b & TB.Noun) || (b & TB.Possessive))) n++;
      if (n < ws.length && (posBits(TP, ws[n].from) & (TB.Noun | TB.Pronoun))) n++;
    }
    return n > k && n < ws.length && onlySpace(t, ws[n - 1].to, ws[n].from) && finiteVerb(posBits(TP, ws[n].from));
  }

  // Issues of one sentence. sub = the masked sentence; positions are block-relative.
  // pos() → the paragraph's part-of-speech tags or null (see nlpEncode).
  function checkSentence(t, src, s, ws, ups, out, pos) {
    var base = s.from, sub = t.slice(s.from, s.to), m, a, b, first = ws[0] && !ws[0].op ? ws[0].from : -1;
    var apos = src.indexOf('’') >= 0 && src.indexOf("'") < 0 ? '’' : "'";
    function add(type, from, to, message, fix) {
      var is = { type: type, cat: catOf(type), from: from, to: to, message: message, text: src.slice(from, to) };
      if (fix) { fix.expect = src.slice(fix.from, fix.to); is.fix = fix; }
      out.push(is);
    }

    // lower-case start
    // (only after a full stop inside a paragraph, only for common opening words — a lower-case
    // identifier like "npm …" or a paragraph resuming after a code block is left alone)
    if (s.first === 'l' && (s.after === 'stop' || s.after === 'bang') && ups > 0 && !/[^"'“‘]/.test(t.slice(s.from, ws[0].from))) {
      var w0 = src.slice(ws[0].from, ws[0].to), w0l = ws[0].lw.replace(/’/g, "'");
      if (w0 === w0.toLowerCase() && STARTERS[w0l] && !LOWER_OK[w0l] && !/^[.(:]/.test(src.charAt(ws[0].to)) && !(w0.length === 1 && /^[).]/.test(src.charAt(ws[0].to)))) {
        add('lowercase', ws[0].from, ws[0].to, 'Sentence starts with a lower-case letter', { from: ws[0].from, to: ws[0].from + 1, insert: w0.charAt(0).toUpperCase() });
      }
    }
    // repeated word
    RE_REPEAT.lastIndex = 0;
    while ((m = RE_REPEAT.exec(sub))) {
      var lw = m[1].toLowerCase(), at = base + m.index;
      if (REPEAT_OK[lw]) continue;
      var pc = sub.charAt(m.index - 1);
      if (pc === '-' || pc === "'" || pc === '’' || pc === '.' || pc === '@') continue;
      var nc = sub.charAt(m.index + m[0].length);
      if (nc === '-' || ((pc === '"' || pc === '“') && (nc === '"' || nc === '”'))) continue;   // "rake rake-built", fix "the the" typos
      if (/^[A-Z]/.test(m[1]) && !/^[A-Z]/.test(m[3]) && (at !== first || NAME_WORDS[lw])) continue;   // "Will will …"
      a = at + m[1].length; b = at + m[0].length;
      add('repeat', at, b, 'Repeated word “' + lw + ' ' + lw + '”', /\n/.test(m[2]) ? null : { from: a, to: b, insert: '' });
      RE_REPEAT.lastIndex = m.index + m[1].length;
    }
    // a / an
    RE_ART.lastIndex = 0;
    while ((m = RE_ART.exec(sub))) {
      var art = m[1], nx = m[3], atA = base + m.index, pch = sub.charAt(m.index - 1);
      RE_ART.lastIndex = m.index + art.length;
      if (pch === '-' || pch === "'" || pch === '’' || pch === '.' || pch === '/') continue;
      if (art === 'AN' || (art.charAt(0) === 'A' && atA !== first)) continue;          // "Plan A is", "TYPE AN"
      if (ART_SKIP[nx.toLowerCase()]) continue;
      var after = sub.charAt(m.index + m[0].length);
      if (after === '.' && nx.length === 1) continue;
      var v = vowelSound(nx);
      if (v === null) continue;
      var isA = art.toLowerCase() === 'a';
      if (isA && v) add('article', atA, atA + m[0].length, 'Use “an” before “' + nx + '”', { from: atA, to: atA + 1, insert: art === 'A' ? 'An' : 'an' });
      else if (!isA && !v) add('article', atA, atA + m[0].length, 'Use “a” before “' + nx + '”', { from: atA, to: atA + 2, insert: art.charAt(0) === 'A' ? 'A' : 'a' });
    }
    // missing space after a full stop ("end.Next")
    // (only before a typical sentence opener: "fs.Stats", "http.Server" are code)
    RE_NOSPACE.lastIndex = 0;
    while ((m = RE_NOSPACE.exec(sub))) {
      var ti = m.index;
      while (ti > 0 && !isSpaceC(sub.charCodeAt(ti - 1))) ti--;
      var tok = sub.slice(ti, m.index + 2), nxt = wordAt(sub, m.index + 3), after2 = sub.charAt(m.index + 3 + nxt.length);
      if (/[\/@:\d.\u0001\u0002_]/.test(tok) || /[A-Z]/.test(tok.slice(1)) || !STARTERS[nxt] || /[(.\w]/.test(after2) || /[A-Z]/.test(sub.slice(m.index + 4, m.index + 3 + nxt.length))) continue;
      var pp = base + m.index + 2;
      add('space', pp, pp + 2, 'Missing space after “' + m[2] + '”', { from: pp + 1, to: pp + 1, insert: ' ' });
    }
    // space before punctuation ("word ,")
    RE_SPACEBEFORE.lastIndex = 0;
    while ((m = RE_SPACEBEFORE.exec(sub))) {
      if (m[3].length > 2) continue;                       // "wait ..." — a spaced ellipsis is fine
      a = base + m.index + 1; b = a + m[2].length;
      add('spacebefore', a, b + 1, 'Space before “' + m[3] + '”', { from: a, to: b, insert: '' });
    }
    // doubled punctuation (not an ellipsis)
    RE_DOUBLE.lastIndex = 0;
    while ((m = RE_DOUBLE.exec(sub))) {
      var dd = m[0], at2 = base + m.index;
      if (/^\.+$/.test(dd)) {
        if (dd.length !== 2) continue;
        var bc = sub.charAt(m.index - 1), ac = sub.charAt(m.index + 2);
        if (!/[A-Za-z]/.test(bc) || (ac && !/[\s"'”’)\]*_]/.test(ac))) continue;
      }
      if (/["'`‘“]/.test(sub.charAt(m.index - 1))) continue;     // ';;' quoted as a literal
      var single = /^(.)\1+$/.test(dd) ? dd.charAt(0) : /^[,;]\.$/.test(dd) ? '.' : '';
      add('double', at2, at2 + dd.length, 'Doubled punctuation “' + dd + '”', single ? { from: at2, to: at2 + dd.length, insert: single } : null);
    }
    // could of / should of …
    RE_OF.lastIndex = 0;
    while ((m = RE_OF.exec(sub))) {
      var nw = m[5].toLowerCase();
      if (!(PP_NEXT[nw] || IRREG_PP[nw] || (nw.length > 3 && /(?:ed|en)$/.test(nw)))) continue;
      a = base + m.index + m[1].length + m[2].length;
      add('of', base + m.index, a + 2, '“' + m[1] + ' of” → “' + m[1] + ' have”', { from: a, to: a + 2, insert: 'have' });
    }
    // alot
    RE_ALOT.lastIndex = 0;
    while ((m = RE_ALOT.exec(sub))) {
      a = base + m.index;
      add('alot', a, a + 4, '“alot” → “a lot”', { from: a, to: a + 4, insert: sameCase(m[1], 'a lot') });
    }
    // your welcome
    RE_WELCOME.lastIndex = 0;
    while ((m = RE_WELCOME.exec(sub))) {
      a = base + m.index;
      var before = sub.slice(0, m.index).replace(/[\s\u0002*_"“”'‘’(]+$/, '');
      if (a !== first && !/[,;:—–!-]$/.test(before)) continue;   // "thanks for your welcome" is a noun
      add('welcome', a, a + m[0].length, '“your welcome” → “you' + apos + 're welcome”', { from: a, to: a + 4, insert: sameCase(m[1], 'you' + apos + 're') });
    }
    // more then / better then …
    var thenAt = Object.create(null);
    RE_THEN.lastIndex = 0;
    while ((m = RE_THEN.exec(sub))) {
      var cmp = m[1].toLowerCase(), nx2 = m[5].toLowerCase();
      if (!THAN_STRONG[cmp] && !THAN_NEXT[nx2] && !/^[\d$£€]/.test(nx2)) continue;
      a = base + m.index + m[1].length + m[2].length;
      if (!THAN_STRONG[cmp]) {                     // with tags: "shorter then the nights grew" is a clause
        var wk = wordIndexAt(ws, a + 4 + m[4].length), TP0 = wk > 0 ? pos() : null;
        if (TP0 && clauseAfter(TP0, ws, t, wk)) continue;
      }
      add('then', base + m.index, a + 4, '“' + cmp + ' then” → “' + cmp + ' than”', { from: a, to: a + 4, insert: sameCase(m[3], 'than') });
      thenAt[a] = 1;
    }
    // … any other comparative the tagger knows ("taller then me", "quieter then usual"),
    // as long as what follows is a noun phrase that doesn't go on as a clause ("colder then it snowed")
    for (var th = 1; th < ws.length - 1; th++) {
      if (ws[th].lw !== 'then' || thenAt[ws[th].from] || ws[th - 1].op || ws[th + 1].op) continue;
      if (!onlySpace(t, ws[th - 1].to, ws[th].from) || !onlySpace(t, ws[th].to, ws[th + 1].from)) continue;
      var TP = pos();
      if (!TP) break;
      var cb = posBits(TP, ws[th - 1].from), nl = ws[th + 1].lw;
      if (!(cb & TB.Comparative) || THAN_STRONG[ws[th - 1].lw]) continue;
      var nb0 = posBits(TP, ws[th + 1].from);
      if (!(THAN_NEXT[nl] || /^[\d$£€]/.test(nl) || (nb0 & (TB.Noun | TB.ProperNoun | TB.Determiner | TB.Possessive | TB.Value | TB.Date)))) continue;
      if ((nb0 & TB.Pronoun) && !THAN_NEXT[nl] && !(nb0 & TB.Possessive)) continue;      // "then I went": a subject
      if (clauseAfter(TP, ws, t, th + 1)) continue;
      var cw0 = src.slice(ws[th - 1].from, ws[th - 1].to);
      add('then', ws[th - 1].from, ws[th].to, '“' + cw0.toLowerCase() + ' then” → “' + cw0.toLowerCase() + ' than”', { from: ws[th].from, to: ws[th].to, insert: sameCase(src.slice(ws[th].from, ws[th].to), 'than') });
    }
    // its / it's
    RE_ITS.lastIndex = 0;
    while ((m = RE_ITS.exec(sub))) {
      a = base + m.index;
      add('its', a, a + m[0].length, '“its ' + m[3].toLowerCase() + '” → “it' + apos + 's ' + m[3].toLowerCase() + '”', { from: a, to: a + 3, insert: sameCase(m[1], 'it' + apos + 's') });
    }
    RE_ITSOWN.lastIndex = 0;
    while ((m = RE_ITSOWN.exec(sub))) {
      a = base + m.index;
      add('its', a, a + m[0].length, '“it’s own” → “its own”', { from: a, to: a + m[1].length, insert: sameCase(m[1], 'its') });
    }
    // … and with tags: "its raining", "its getting late", "its (so) cold today", "its hard to say" —
    // "its" opening a clause (sentence start, after a conjunction or a comma) before a gerund
    // or a predicate adjective; "its rising cost", "its simple design", "chased its tail" stay
    for (var ii = 0; ii < ws.length - 1; ii++) {
      if (ws[ii].lw !== 'its' || ws[ii].op || ITS_NEXT[ws[ii + 1].lw] || ws[ii + 1].lw === 'own') continue;
      if (!onlySpace(t, ws[ii].to, ws[ii + 1].from)) continue;
      var IP = pos();
      if (!IP) break;
      if (ii > 0 && onlySpace(t, ws[ii - 1].to, ws[ii].from) && !(posBits(IP, ws[ii - 1].from) & TB.Conjunction) && !SAY[ws[ii - 1].lw]) continue;
      var ik = ii + 1;
      if ((posBits(IP, ws[ik].from) & TB.Adverb) && ik + 1 < ws.length && onlySpace(t, ws[ik].to, ws[ik + 1].from)) ik++;
      var ib = posBits(IP, ws[ik].from), inb = ik + 1 < ws.length && onlySpace(t, ws[ik].to, ws[ik + 1].from) ? posBits(IP, ws[ik + 1].from) : 0;
      var pred = (ib & TB.Gerund) ? !(inb & TB.Noun) && !finiteVerb(inb) :
        (ib & TB.Adjective) && !(ib & (TB.Superlative | TB.Comparative | TB.Noun | TB.Value)) && !(inb & (TB.Noun | TB.Adjective | TB.Value)) && !finiteVerb(inb);
      if (!pred || ws[ik].op) continue;
      a = ws[ii].from;
      var nw0 = src.slice(ws[ii + 1].from, ws[ii + 1].to).toLowerCase();
      add('its', a, ws[ii + 1].to, '“its ' + nw0 + '” → “it' + apos + 's ' + nw0 + '”', { from: a, to: a + 3, insert: sameCase(src.slice(a, a + 3), 'it' + apos + 's') });
    }
    // comma splice: ", it was …" after an independent-looking clause
    var spliceAt = Object.create(null);
    RE_SPLICE.lastIndex = 0;
    while ((m = RE_SPLICE.exec(sub))) {
      if (!spliceLeft(sub.slice(0, m.index), ws, null)) continue;
      a = base + m.index;
      spliceAt[a] = 1;
      add('splice', a, a + m[0].length, 'Possible comma splice — try a full stop, a semicolon or “and”');
    }
    // … and with tags: any subject + finite verb after the comma ("I love pizza, my wife hates
    // it", "The sun was shining, the birds were singing"); not "her eyes shining", "a doctor,"
    if (sub.indexOf(',') >= 0) {
      var SP = null, wi = 0;
      var verbIn = function (x, y) {
        for (var q = 0; q < ws.length; q++) { var w = ws[q], o = w.from - base; if (o >= x && o < y && !w.op && finiteVerb(posBits(SP, w.from))) return true; }
        return false;
      };
      for (var ci = sub.indexOf(','); ci >= 0; ci = sub.indexOf(',', ci + 1)) {
        if (spliceAt[base + ci] || !/[ \t]/.test(sub.charAt(ci + 1))) continue;
        while (wi < ws.length && ws[wi].from < base + ci) wi++;
        if (wi >= ws.length - 1 || wi < 1 || ws[wi].op) continue;
        if (SPLICE_NOT[ws[wi].lw] || !onlySpace(t, base + ci + 1, ws[wi].from)) continue;     // ", that it is", ', “This'
        // only the sentence's first joint, after a plain clause from the sentence start (a clause
        // after an earlier comma may still hang on an "If …" or be part of a list)
        if (/[,;:—–]/.test(sub.slice(0, ci)) || /^(?:that|this|these|those)$/.test(ws[0].lw)) break;
        // a short tail is a tag or an aside: ", I think,", ", you know.", ", all things considered"
        var tail = 0, te = wi;
        while (te < ws.length && tail < 4) { tail++; if (te + 1 < ws.length && !onlySpace(t, ws[te].to, ws[te + 1].from)) break; te++; }
        if (tail < 4) continue;
        if (!SP && !(SP = pos())) break;
        var sk = wi, sb = posBits(SP, ws[sk].from), adj = 0;
        if ((sb & TB.Adjective) && !(sb & (TB.Determiner | TB.Possessive))) continue;          // "a deep, intricate character"
        if ((sb & (TB.Determiner | TB.Possessive)) && !(sb & TB.Noun && !(sb & TB.Possessive))) sk++;
        while (sk < ws.length && adj < 2 && (posBits(SP, ws[sk].from) & TB.Adjective) && !(posBits(SP, ws[sk].from) & (TB.Noun | TB.Comparative | TB.Superlative))) { sk++; adj++; }
        if (sk >= ws.length - 1) continue;
        sb = posBits(SP, ws[sk].from);
        if (!(sb & (TB.Noun | TB.ProperNoun | TB.Pronoun | TB.Value)) || (sb & (TB.Comparative | TB.Superlative))) continue;
        if (sk + 2 < ws.length && (posBits(SP, ws[sk + 1].from) & TB.Noun) && !(posBits(SP, ws[sk + 1].from) & (TB.Verb | TB.Pronoun))) sk++;   // "the bus driver"
        var vb = posBits(SP, ws[sk + 1].from), clean = true;
        for (var g0 = wi; g0 <= sk && clean; g0++) if (!onlySpace(t, ws[g0].to, ws[g0 + 1].from)) clean = false;
        if (!clean || !finiteVerb(vb) || (vb & TB.Noun)) continue;
        if (ws[sk + 2] && ws[sk + 2].lw === 'by') continue;                                  // "Santa Barbara, followed by"
        if ((sb & TB.ProperNoun) && (posBits(SP, ws[wi - 1].from) & TB.ProperNoun)) continue;  // "California, Santa Barbara"
        if (/\b(?:that|what|whether|which|who)\b/i.test(sub.slice(0, ci))) continue;          // "estimates that …, climate change could"
        if (!spliceLeft(sub.slice(0, ci), ws, verbIn)) continue;
        add('splice', base + ci, ws[sk + 1].to, 'Possible comma splice — try a full stop, a semicolon or “and”');
      }
    }
    // passive voice: be + (adverb) + past participle
    for (var k = 0; k < ws.length - 1; k++) {
      if (!BE[ws[k].lw] || ws[k].op) continue;
      if (k && (ws[k - 1].lw === 'there' || ws[k - 1].lw === 'here')) continue;
      var j = k + 1, gaps = true;
      while (j < ws.length && j <= k + 2 && isAdv(ws[j].lw) && ws[j].lw !== 'being') j++;
      if (j < ws.length && ws[j].lw === 'being' && ws[k].lw !== 'being') j++;
      if (j >= ws.length || ws[j].op) continue;
      var p = ws[j].lw, hy = p.indexOf('-');
      if (!isPP(p) || ADJ_PP[p]) continue;
      if (hy > 0 && !HYPHEN_PRE[p.slice(0, hy)]) continue;     // old-fashioned, left-handed: compound adjectives
      for (var g = k; g < j && gaps; g++) if (!/^[ \t\n]+$/.test(t.slice(ws[g].to, ws[g + 1].from))) gaps = false;
      if (!gaps) continue;
      if (p === 'used' && ws[j + 1] && ws[j + 1].lw === 'to') continue;
      add('passive', ws[k].from, ws[j].to, 'Passive voice: “' + src.slice(ws[k].from, ws[j].to).replace(/\s+/g, ' ') + '”');
      k = j;
    }
    // filler words (style; off unless switched on)
    for (var f = 0; f < ws.length; f++) if (FILLER[ws[f].lw]) add('filler', ws[f].from, ws[f].to, 'Filler word “' + ws[f].lw + '”');
  }

  // ---- a paragraph -------------------------------------------------------------------------
  // provider(text) → tags for the prepared paragraph text, null (none: word lists only) or
  // undefined (not there yet: the result is marked pend so the Analyzer redoes it later).
  // It is asked at most once, and only when a rule has a candidate to check.
  function analyzePara(src, provider) {
    var mk = mask(src), t = mk.t, raw = split(t, mk.breaks), sents = [], wsets = [], k, P, pend = false, want = false, ask = '';
    function pos() {
      if (P === undefined) {
        want = true;
        ask = provider ? nlpPrep(t) : '';
        P = provider ? provider(ask) : null;
        if (P === undefined) { pend = true; P = null; }
      }
      return P;
    }
    for (k = 0; k < raw.length; k++) {
      var r = raw[k], ws = tokenize(t, r.from, r.to), real = 0;
      for (var q = 0; q < ws.length; q++) if (!ws[q].op) real++;
      if (!real) continue;
      var s = measure(t, r, ws), p = r.from;
      while (p < r.to && isOpenerC(t.charCodeAt(p))) p++;
      s.first = isUpperAt(t, p) ? 'u' : (isLowerAt(t, p) && p === ws[0].from && !ws[0].op) ? 'l' : 'x';
      sents.push(s); wsets.push(ws);
    }
    var ups = 0, issues = [];
    for (k = 0; k < sents.length; k++) if (sents[k].first === 'u') ups++;
    for (k = 0; k < sents.length; k++) checkSentence(t, src, sents[k], wsets[k], ups, issues, pos);
    issues.sort(function (x, y) { return x.from - y.from || x.to - y.to; });
    var r = { sents: sents, issues: issues, pend: pend, want: want, tagged: !!P };
    if (pend) r.ask = ask;               // what to look for when settling
    return r;
  }

  // ---- stats -----------------------------------------------------------------------------------
  function stats(sents, issues) {
    var n = sents.length, W = 0, S = 0, longest = null, cls = { s: 0, m: 0, l: 0, r: 0 }, complex = 0, tails = 0, i;
    for (i = 0; i < n; i++) {
      var s = sents[i];
      W += s.words; S += s.syll; cls[s.cls]++;
      if (s.complex) complex++;
      if (s.tail) tails++;
      if (!longest || s.words > longest.words) longest = s;
    }
    var mean = n ? W / n : 0, v = 0;
    for (i = 0; i < n; i++) v += (sents[i].words - mean) * (sents[i].words - mean);
    var byType = {}, byCat = { grammar: 0, passive: 0, filler: 0 };
    issues = issues || [];
    for (i = 0; i < issues.length; i++) { var t = issues[i]; byType[t.type] = (byType[t.type] || 0) + 1; byCat[t.cat] = (byCat[t.cat] || 0) + 1; }
    return {
      sentences: n, words: W, syllables: S, mean: round1(mean), sd: round1(n ? Math.sqrt(v / n) : 0),
      longest: longest ? { words: longest.words, from: longest.from, to: longest.to } : null,
      grade: n && W ? round1(Math.max(0, 0.39 * (W / n) + 11.8 * (S / W) - 15.59)) : 0,
      classes: cls, complex: complex, tails: tails, issues: issues.length, byType: byType, byCat: byCat
    };
  }

  // ---- analyzer with a per-paragraph cache ------------------------------------------------
  function shiftSent(s, off) {
    var o = {}, k;
    for (k in s) o[k] = s[k];
    o.from = s.from + off; o.to = s.to + off;
    if (s.tail) {
      var st = [];
      for (k = 0; k < s.tail.steps.length; k++) { var x = s.tail.steps[k]; st.push([x[0] + off, x[1] + off, x[2]]); }
      o.tail = { from: s.tail.from + off, to: s.tail.to + off, words: s.tail.words, level: s.tail.level, steps: st };
    }
    return o;
  }
  function shiftIssue(is, off) {
    var o = {}, k;
    for (k in is) o[k] = is[k];
    o.from = is.from + off; o.to = is.to + off;
    if (is.fix) o.fix = { from: is.fix.from + off, to: is.fix.to + off, insert: is.fix.insert, expect: is.fix.expect };
    return o;
  }
  function Analyzer(opts) {
    this.cache = new Map(); this.max = (opts && opts.max) || 20000; this.hits = 0; this.misses = 0;
    this.pos = (opts && opts.pos) || null;
  }
  // Tags from now on (fn as for analyzePara; null = word lists only). Results that waited
  // for tags are redone on their next use; finished ones stay.
  Analyzer.prototype.setPos = function (fn) {
    var c = this.cache;
    this.pos = fn || null;
    if (fn) c.forEach(function (r, k) { if (r.want && !r.tagged) c.delete(k); });
  };
  // Forget the paragraphs that were analysed while their tags were missing → how many.
  Analyzer.prototype.dropPending = function () {
    var n = 0, c = this.cache;
    c.forEach(function (r, k) { if (r.pend) { c.delete(k); n++; } });
    return n;
  };
  // Redo the waiting paragraphs whose tags have arrived → how many now read differently
  // (their issues changed). Those still waiting stay as they are.
  Analyzer.prototype.settle = function () {
    var c = this.cache, pos = this.pos, todo = [], changed = 0;
    if (!pos) return 0;
    c.forEach(function (r, k) { if (r.pend && pos(r.ask) !== undefined) todo.push(k); });
    for (var i = 0; i < todo.length; i++) {
      var old = c.get(todo[i]), r = analyzePara(todo[i], pos);
      c.set(todo[i], r);
      if (issueSig(old.issues) !== issueSig(r.issues)) changed++;
    }
    return changed;
  };
  function issueSig(a) { var s = ''; for (var i = 0; i < a.length; i++) s += a[i].type + a[i].from + ':' + a[i].to + ';'; return s; }
  Analyzer.prototype.para = function (text) {
    var c = this.cache, r = c.get(text);
    if (r) { c.delete(text); c.set(text, r); this.hits++; return r; }
    r = analyzePara(text, this.pos);
    this.misses++;
    c.set(text, r);
    if (c.size > this.max) { var it = c.keys(); while (c.size > this.max) c.delete(it.next().value); }
    return r;
  };
  // Whole text (or the blocks overlapping range {from, to}) with absolute offsets.
  // blocks: pass a scanBlocks() result to reuse it.
  Analyzer.prototype.analyze = function (src, range, blocks) {
    blocks = blocks || scanBlocks(src);
    var out = { blocks: [], sentences: [], issues: [] };
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (range && (b.to < range.from || b.from > range.to)) continue;
      var r = this.para(textOf(src, b)), bi = out.blocks.length, k;
      out.blocks.push({ from: b.from, to: b.to, r: r, first: out.sentences.length });
      for (k = 0; k < r.sents.length; k++) { var s = shiftSent(r.sents[k], b.from); s.block = bi; out.sentences.push(s); }
      for (k = 0; k < r.issues.length; k++) out.issues.push(shiftIssue(r.issues[k], b.from));
    }
    out.stats = stats(out.sentences, out.issues);
    return out;
  };
  Analyzer.prototype.clear = function () { this.cache.clear(); };

  // Index of the block holding pos (or the last one before it); -1 if none.
  function blockAt(blocks, pos) {
    var lo = 0, hi = blocks.length - 1, r = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (blocks[mid].from <= pos) { r = mid; lo = mid + 1; } else hi = mid - 1; }
    return r;
  }
  // First block that ends at or after pos.
  function firstBlockFrom(blocks, pos) {
    var lo = 0, hi = blocks.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (blocks[mid].to < pos) lo = mid + 1; else hi = mid; }
    return lo;
  }
  // Index of the sentence holding pos (or the nearest before it); -1 if none.
  function sentenceAt(sents, pos) {
    var lo = 0, hi = sents.length - 1, r = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (sents[mid].from <= pos) { r = mid; lo = mid + 1; } else hi = mid - 1; }
    return r;
  }

  return {
    WORD: WORD, GAP: GAP, SHORT: SHORT, MEDIUM: MEDIUM, LONG: LONG, TAIL: TAIL, TAIL_LEVELS: TAIL_LEVELS, COMPLEX: COMPLEX,
    scanBlocks: scanBlocks, mask: mask, split: split, tokenize: tokenize, syllables: syllables, classOf: classOf, tailLevel: tailLevel, tailIntensity: tailIntensity,
    vowelSound: vowelSound, analyzePara: analyzePara, stats: stats, catOf: catOf, Analyzer: Analyzer,
    NLP_TAGS: NLP_TAGS, TAG: TB, nlpPrep: nlpPrep, nlpEncode: nlpEncode, posAt: posAt, posBits: posBits,
    blockAt: blockAt, firstBlockFrom: firstBlockFrom, sentenceAt: sentenceAt, textOf: textOf,
    // convenience: sentences of a plain piece of text (one paragraph per block)
    sentences: function (text) { var a = new Analyzer(); return a.analyze(text).sentences; }
  };
});
