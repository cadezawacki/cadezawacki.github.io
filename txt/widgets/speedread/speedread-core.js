/* Speed Reader — core: note text -> words -> chunks -> timings, plus the
 * mapping between reading positions and document offsets. Pure ES5, no DOM:
 * window.__cadeSpeedRead in the browser, module.exports in node
 * (txt/widgets/speedread/speedread.test.js).
 *
 * TOKENISING (tokenize(text, base)): one pass over the lines, keeping the
 * source offset of every character that is read, so each word knows where it
 * sits in the note ([from, to), plus `base` when the text is a slice of it).
 *   - ``` / ~~~ fenced blocks are skipped (fence lines included);
 *   - markdown syntax is not read: heading #s, quote >s, list markers and
 *     task boxes, callout [!type] tags, emphasis ** __ ~~ == ||, escapes,
 *     table pipes and separator rows, hr lines, [table] / @complete markers;
 *   - headings read as text; [text](url) and [[page|alias]] read as their
 *     text; `inline code` reads as its content;
 *   - file / image tokens (![file:…], ![img:…], ![alt](src)), footnote refs,
 *     bare URLs, HTML tags and long space-less data lines are skipped.
 * Every line is a paragraph (this app writes one paragraph per line).
 *
 * WORD: { w: display text, from, to, end, len, num, head }
 *   end: 0 none, 1 clause (, ; : —), 2 sentence (. ! ? …), 3 paragraph.
 *   len: letters + digits in it; num: it contains a digit.
 *
 * CHUNKS (chunk(words, n)): up to n words shown together. A chunk closes
 * early after a word that ends a clause / sentence / paragraph, and when the
 * next word would push it past n*8+4 characters, so phrases stay readable.
 *
 * TIMING (chunkMs): one word-time is 60000 / wpm ms. A word costs one
 * word-time, more when long (beyond 7 letters, +10% per letter up to +70%)
 * or numeric (+30%). The chunk's last word adds its pause: (mul − 1)
 * word-times, mul = 1 + (s − 1)/2 after a clause, s after a sentence and
 * 1.4 s after a paragraph, where s is the "pause at sentence ends"
 * multiplier.
 *
 * ORP (orpIndex): the optimal-recognition letter, by the length of the word's
 * letter/digit core: 1 -> 1st, 2–5 -> 2nd, 6–9 -> 3rd, 10–13 -> 4th, 14+ ->
 * 5th (counted after any leading quote or bracket). */
(function (root) {
  'use strict';

  var RE_AN = /[\p{L}\p{N}]/u;
  var RE_DIGIT = /\p{N}/u;
  var MARKUP = '*_~=|';
  var ABBR = ' mr. mrs. ms. dr. st. vs. jr. sr. prof. e.g. i.e. cf. approx. no. fig. vol. ';

  function isSpace(c) { return c === ' ' || c === '\t' || c === ' ' || c === '\r' || c === '​' || c === '﻿'; }

  // Characters of a line that are read, with their offsets in the line.
  // lit marks characters from inline code (never treated as markup).
  function scanInline(s, a, b, out) {
    var i = a, m, rest;
    while (i < b) {
      var c = s.charAt(i);
      rest = s.slice(i, b);
      if (c === '!' && (m = /^!\[(?:img|file):[^\]\n]*\]/.exec(rest) || /^!\[[^\]\n]*\]\([^)\n]*\)/.exec(rest))) { i += m[0].length; out.gap(); continue; }
      if (c === '[') {
        if ((m = /^\[\^[^\]\s]+\]/.exec(rest))) { i += m[0].length; continue; }
        if ((m = /^\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/.exec(rest))) {
          if (m[2] != null) scanInline(s, i + 3 + m[1].length, i + 3 + m[1].length + m[2].length, out);
          else scanInline(s, i + 2, i + 2 + m[1].length, out);
          i += m[0].length; continue;
        }
        if ((m = /^\[([^\]\n]+)\]\((?:[^()\s]|\([^)\s]*\))*(?:\s+"[^"\n]*")?\)/.exec(rest))) {
          scanInline(s, i + 1, i + 1 + m[1].length, out);
          i += m[0].length; continue;
        }
      }
      if (c === '`' && (m = /^`([^`\n]+)`/.exec(rest))) {
        for (var k = 0; k < m[1].length; k++) out.push(m[1].charAt(k), i + 1 + k, true);
        i += m[0].length; continue;
      }
      if ((c === 'h' || c === 'w') && (i === 0 || !RE_AN.test(s.charAt(i - 1))) &&
          (m = /^(?:https?:\/\/|www\.)[^\s<>()[\]]+/.exec(rest))) { i += m[0].length; out.gap(); continue; }
      if (c === '<' && (m = /^<\/?[a-zA-Z][^>\n]*>/.exec(rest))) { i += m[0].length; out.gap(); continue; }
      if (c === '%' && (m = /^%%[^|%\n\s]{1,32}\|/.exec(rest) || /^%%/.exec(rest))) { i += m[0].length; continue; }
      if (c === '=' && (m = /^==[a-zA-Z]{3,10}\|/.exec(rest))) { i += m[0].length; continue; }
      if (c === '\\' && i + 1 < b && /[\\`*_{}[\]()#+\-.!|~%=>]/.test(s.charAt(i + 1))) { out.push(s.charAt(i + 1), i + 1, true); i += 2; continue; }
      out.push(c, i, false);
      i++;
    }
  }

  // A word's trailing punctuation -> pause class (0 none, 1 clause, 2 sentence).
  function endOf(w) {
    var t = w.replace(/["'’”»)\]}*]+$/, '');
    if (/(?:\.\.\.|…)$/.test(t)) return 2;
    if (/[.!?]$/.test(t)) {
      if (/[!?]$/.test(t)) return 2;
      var core = t.replace(/^["'‘“(\[]+/, '');
      if (ABBR.indexOf(' ' + core.toLowerCase() + ' ') >= 0) return 0;
      if (/^\p{Lu}\.$/u.test(core)) return 0; // an initial: "J."
      return 2;
    }
    if (/[,;:—–]$/.test(t) || /(?:^|\s)-$/.test(t)) return 1;
    return 0;
  }

  function lettersOf(w) { var n = 0; for (var i = 0; i < w.length; i++) if (RE_AN.test(w.charAt(i))) n++; return n; }

  function tokenize(text, base) {
    text = String(text || '');
    base = base || 0;
    var words = [];
    var lines = text.split('\n');
    var off = 0, fence = '';
    function paraEnd() { if (words.length) words[words.length - 1].end = 3; }
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li], lineFrom = off, m;
      off += line.length + 1;
      var fm = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (fm && fm[1].charAt(0) === fence.charAt(0) && fm[1].length >= fence.length && !/\S/.test(line.slice(fm[0].length))) fence = '';
        continue;
      }
      if (fm) { fence = fm[1]; paraEnd(); continue; }
      if (!/\S/.test(line)) { paraEnd(); continue; }
      if (line.length > 2000 && !/\s/.test(line.slice(0, 2000))) continue;                 // embedded data
      if (/^\s*(?:\[table(?::[^\]]*)?\]|@complete)\s*$/i.test(line)) continue;               // core table / macro markers
      if (/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) continue;              // table separator row
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { paraEnd(); continue; }              // horizontal rule
      var cs = 0, head = false, end = line.length;
      if ((m = /^\s*%%(?:center|right)%%\s?/.exec(line))) cs = m[0].length;
      var l = line.slice(cs);
      if ((m = /^\s{0,3}(#{1,6})\s+/.exec(l))) {
        head = true; cs += m[0].length;
        var tm = /\s+#+\s*$/.exec(line.slice(cs));
        if (tm) end = cs + tm.index;
      } else if ((m = /^\s{0,3}(?:>\s?)+/.exec(l))) {
        cs += m[0].length;
        if ((m = /^\[![a-zA-Z]+\][+-]?\s*/.exec(line.slice(cs)))) cs += m[0].length;
      } else if ((m = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/.exec(l))) {
        cs += m[0].length;
      }
      var table = /^\s*\|.*\|\s*$/.test(line);
      // Collect the characters that are read.
      var chars = [], offs = [], lits = [];
      var out = {
        push: function (c, o, lit) {
          if (table && c === '|' && !lit) { chars.push(' '); offs.push(o); lits.push(false); chars.push('\u0001'); offs.push(o); lits.push(false); chars.push(' '); offs.push(o); lits.push(false); return; }
          chars.push(c); offs.push(o); lits.push(!!lit);
        },
        gap: function () { chars.push(' '); offs.push(-1); lits.push(false); }
      };
      scanInline(line, cs, end, out);
      // Split on whitespace into raw tokens.
      var lineWords = [];
      var i = 0, n = chars.length;
      while (i < n) {
        while (i < n && isSpace(chars[i])) i++;
        if (i >= n) break;
        var j = i;
        while (j < n && !isSpace(chars[j])) j++;
        if (chars[i] === '\u0001') { if (lineWords.length) lineWords[lineWords.length - 1].end = Math.max(lineWords[lineWords.length - 1].end, 1); i = j; continue; }
        // Strip markup characters at the edges (before the first / after the last letter or digit).
        var first = -1, last = -1, k;
        for (k = i; k < j; k++) if (RE_AN.test(chars[k])) { if (first < 0) first = k; last = k; }
        var w = '', a = -1, b = -1;
        for (k = i; k < j; k++) {
          var ch = chars[k];
          if (!lits[k] && MARKUP.indexOf(ch) >= 0 && (first < 0 || k < first || k > last)) continue;
          w += ch;
          if (a < 0) a = offs[k];
          b = offs[k] + 1;
        }
        i = j;
        if (!w) continue;
        var e = endOf(w);
        if (first < 0) {
          // Punctuation on its own ("—", "&") rides with the word before it.
          if (lineWords.length) {
            var pw = lineWords[lineWords.length - 1];
            pw.w += ' ' + w; pw.to = base + lineFrom + b; pw.end = Math.max(pw.end, e);
          }
          continue;
        }
        lineWords.push({ w: w, from: base + lineFrom + a, to: base + lineFrom + b, end: e, len: lettersOf(w), num: RE_DIGIT.test(w), head: head });
      }
      if (lineWords.length) {
        lineWords[lineWords.length - 1].end = 3;
        for (k = 0; k < lineWords.length; k++) words.push(lineWords[k]);
      }
    }
    return words;
  }

  function maxCharsFor(n) { return n * 8 + 4; }

  // [{a, b}] word ranges, b exclusive.
  function chunk(words, n) {
    n = Math.max(1, Math.min(5, Math.round(n) || 1));
    var out = [], i = 0, max = maxCharsFor(n);
    while (i < words.length) {
      var a = i, count = 0, chars = 0;
      while (i < words.length && count < n) {
        var wl = words[i].w.length;
        if (count > 0 && chars + 1 + wl > max) break;
        chars += (count ? 1 : 0) + wl; count++; i++;
        if (words[i - 1].end > 0) break;
      }
      out.push({ a: a, b: i });
    }
    return out;
  }

  function orpIndex(w) {
    w = String(w || '');
    var p = 0;
    while (p < w.length && !RE_AN.test(w.charAt(p))) p++;
    if (p >= w.length) return 0;
    var q = p, L = 0;
    for (var i = p; i < w.length; i++) if (RE_AN.test(w.charAt(i))) { q = i; }
    L = q - p + 1;
    var k = L <= 1 ? 0 : L <= 5 ? 1 : L <= 9 ? 2 : L <= 13 ? 3 : 4;
    return Math.min(q, p + k);
  }

  function wordWeight(word) {
    var f = 1;
    if (word.len > 7) f += Math.min(0.7, (word.len - 7) * 0.1);
    if (word.num) f += 0.3;
    return f;
  }
  function pauseMul(end, s) {
    s = Math.max(1, +s || 1);
    return end >= 3 ? 1.4 * s : end === 2 ? s : end === 1 ? 1 + (s - 1) / 2 : 1;
  }
  function chunkMs(words, c, wpm, s) {
    var unit = 60000 / Math.max(1, wpm), sum = 0;
    for (var i = c.a; i < c.b; i++) sum += wordWeight(words[i]);
    return Math.max(60, unit * (sum + pauseMul(words[c.b - 1].end, s) - 1));
  }
  // Durations of every chunk, and the time from each chunk to the end.
  function timeline(words, chunks, wpm, s) {
    var dur = new Array(chunks.length), rest = new Array(chunks.length + 1);
    rest[chunks.length] = 0;
    for (var i = chunks.length - 1; i >= 0; i--) { dur[i] = chunkMs(words, chunks[i], wpm, s); rest[i] = rest[i + 1] + dur[i]; }
    return { dur: dur, rest: rest };
  }

  // Index of the word at document offset `off` (the one containing it, else
  // the next one; words.length - 1 past the end; 0 for an empty list).
  function wordAt(words, off) {
    var lo = 0, hi = words.length - 1, ans = words.length - 1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (words[mid].to > off) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
    return Math.max(0, ans);
  }
  // Index of the chunk holding word wi.
  function chunkOf(chunks, wi) {
    var lo = 0, hi = chunks.length - 1, ans = 0;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (chunks[mid].a <= wi) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function sentenceStarts(words) {
    var out = [];
    for (var i = 0; i < words.length; i++) if (i === 0 || words[i - 1].end >= 2) out.push(i);
    return out;
  }
  // Word index to jump to from word wi: forward = the next sentence; back =
  // the start of this sentence, or the one before when already at its start.
  function sentenceTarget(starts, wi, dir, total) {
    var i;
    if (dir > 0) {
      for (i = 0; i < starts.length; i++) if (starts[i] > wi) return starts[i];
      return Math.max(0, (total || 1) - 1);
    }
    for (i = starts.length - 1; i >= 0; i--) if (starts[i] < wi) return starts[i];
    return 0;
  }

  function fmtTime(ms) {
    var sec = Math.max(0, Math.ceil(ms / 1000));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  // Where reading should begin for a caret at `caret`: the word there, or
  // the start when the caret is past the last word.
  function startIndex(words, caret) {
    if (!words.length || caret == null) return 0;
    if (caret >= words[words.length - 1].to) return 0;
    var i = wordAt(words, caret);
    if (i > 0 && words[i - 1].to === caret) i--; // caret right after a word: that word
    return i;
  }

  var api = {
    tokenize: tokenize, chunk: chunk, maxCharsFor: maxCharsFor, orpIndex: orpIndex, endOf: endOf,
    wordWeight: wordWeight, pauseMul: pauseMul, chunkMs: chunkMs, timeline: timeline,
    wordAt: wordAt, chunkOf: chunkOf, sentenceStarts: sentenceStarts, sentenceTarget: sentenceTarget,
    startIndex: startIndex, fmtTime: fmtTime
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__cadeSpeedRead = api;
})(typeof self !== 'undefined' ? self : this);
