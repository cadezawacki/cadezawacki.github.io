/* Regex Tester — build and debug JavaScript regular expressions against real
 * text: live highlighting (alternating colours, zero-width matches as a caret
 * mark), a match table with numbered + named groups, a replace preview with JS
 * semantics ($1 $<name> $& $` $' $$), a plain-English explanation of every
 * token, a cheat sheet and ready-made patterns, and hand-offs to the app:
 * "Use in Find & Replace" and "Apply" (one editor transaction = one Undo).
 *
 * SAFETY: matching never runs on the UI thread. A Blob Web Worker (built from
 * this file's own pure functions) runs each job under a time limit (500 ms
 * live, 3 s for Apply); a job that overruns — catastrophic backtracking such as
 * (a+)+$ on "aaaa…b" — gets the worker terminated and a fresh one is made for
 * the next job, so the app never freezes. Shown matches are capped (1,000) and
 * the test text is capped (100,000 characters).
 *
 * PERFORMANCE: nothing runs until the panel opens. The worker is created on
 * the first match, freed after 30 s idle, when the panel is minimized, and on
 * close (with every timer and the ResizeObserver). No document-level listeners.
 * Prefs, the last pattern and a short history live in Cade.store (cade-regex-*).
 *
 * The pure core (tokenizer/explainer, replacement expansion, worker job +
 * timeout runner, escaping helpers, library) is DOM-free and exported for
 * node tests: node txt/widgets/regex/regex.test.js
 * Self-contained IIFE, ES5 style. */
(function () {
  'use strict';

  // ===========================================================================
  // Pure core — no DOM, no Cade
  // ===========================================================================
  var Core = (function () {
    var LIVE_MS = 500, APPLY_MS = 3000, MAX_SHOW = 1000, MAX_TEST = 100000, MAX_APPLY = 5000000, VAL_CAP = 200;

    function flagSupported(f) { try { new RegExp('', f); return true; } catch (e) { return false; } }
    function hex(n, w) { var s = n.toString(16).toUpperCase(); while (s.length < (w || 4)) s = '0' + s; return s; }
    function has(s, ch) { return String(s || '').indexOf(ch) >= 0; }

    // ---- readable names ------------------------------------------------------------
    function charName(ch) {
      var code = ch.codePointAt(0);
      if (ch === ' ') return 'a space';
      if (ch === '\t') return 'a tab';
      if (ch === '\n') return 'a line feed (\\n)';
      if (ch === '\r') return 'a carriage return (\\r)';
      if (code === 0) return 'the NUL character (\\0)';
      if (code < 32 || code === 127) return 'control character U+' + hex(code);
      if (code === 0xa0) return 'a no-break space';
      if (code >= 0xd800 && code <= 0xdfff) return 'U+' + hex(code) + ' (half of a surrogate pair — add the u flag to treat emoji as one character)';
      return '“' + ch + '”';
    }
    function vis(s) {
      return String(s).replace(/[\n\r\t\u0000]/g, function (c) { return c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '\\0'; });
    }
    var ESC_CLASS = {
      d: 'a digit 0–9', D: 'any character except a digit',
      w: 'a word character (A–Z, a–z, 0–9 or _)', W: 'any character except a word character',
      s: 'a whitespace character (space, tab, line break …)', S: 'any character except whitespace',
    };
    var CLASS_ITEM = { d: 'a digit', D: 'a non-digit', w: 'a word character', W: 'a non-word character', s: 'whitespace', S: 'non-whitespace' };
    var ESC_CTRL = { n: '\n', r: '\r', t: '\t', v: '\u000b', f: '\f' };
    var PROP_HINT = {
      L: 'any letter', Letter: 'any letter', Lu: 'an uppercase letter', Uppercase_Letter: 'an uppercase letter', Ll: 'a lowercase letter',
      Lowercase_Letter: 'a lowercase letter', N: 'any number', Nd: 'a decimal digit', P: 'punctuation', S: 'a symbol', Z: 'a separator',
      Emoji: 'an emoji', Emoji_Presentation: 'an emoji shown as a picture', Extended_Pictographic: 'a pictographic character (emoji etc.)',
      White_Space: 'whitespace', Alphabetic: 'an alphabetic character', 'Script=Latin': 'a Latin-script character',
      'Script=Greek': 'a Greek-script character', 'Script=Cyrillic': 'a Cyrillic-script character', 'Script=Han': 'a Han (Chinese) character',
      M: 'a combining mark', Mn: 'a non-spacing mark', Sc: 'a currency symbol', Sm: 'a math symbol',
    };
    var FLAG_TEXT = {
      d: 'd — indices: report where each group matched (match.indices)',
      g: 'g — global: find every match, not just the first',
      i: 'i — ignore case: “a” also matches “A”',
      m: 'm — multiline: ^ and $ match at the start / end of every line',
      s: 's — dotAll: “.” also matches line breaks',
      u: 'u — unicode: code points (emoji are one character), \\u{…} and \\p{…}; stricter syntax',
      v: 'v — unicodeSets: like u, plus set operations ([A&&B], [A--B]) and \\q{…} strings in classes',
      y: 'y — sticky: each match must start exactly where the previous one ended (no skipping ahead)',
    };

    // ---- capturing groups in order (prepass) -------------------------------------------
    function scanGroups(src, vmode) {
      var out = [], i = 0, n = src.length, cls = 0;
      while (i < n) {
        var c = src.charAt(i);
        if (c === '\\') { i += 2; continue; }
        if (cls) {
          if (c === '[' && vmode) cls++;
          else if (c === ']') cls--;
          i++; continue;
        }
        if (c === '[') { cls = 1; i++; continue; }
        if (c === '(') {
          if (src.charAt(i + 1) !== '?') out.push({ n: out.length + 1, name: null, at: i });
          else if (src.charAt(i + 2) === '<' && src.charAt(i + 3) !== '=' && src.charAt(i + 3) !== '!') {
            var e = src.indexOf('>', i + 3);
            out.push({ n: out.length + 1, name: e > 0 ? src.slice(i + 3, e) : '', at: i });
          }
        }
        i++;
      }
      return out;
    }

    // ---- tokenizer: never throws; problems become 'err' tokens ------------------------------
    // token: { k, s, e, raw, d, depth, ... }  k ∈ lit any anchor cls set open close alt quant ref err
    function tokenize(src, flags) {
      src = String(src == null ? '' : src); flags = String(flags || '');
      var v = has(flags, 'v'), uni = has(flags, 'u') || v, ml = has(flags, 'm'), dotAll = has(flags, 's');
      var groups = scanGroups(src, v), names = {}, hasNamed = false;
      groups.forEach(function (g) { if (g.name) { names[g.name] = g.n; hasNamed = true; } });
      var toks = [], stack = [], n = src.length, capN = 0, i = 0;

      function push(k, s0, e0, d, extra) {
        var t = { k: k, s: s0, e: e0, raw: src.slice(s0, e0), d: d, depth: stack.length };
        if (extra) for (var x in extra) t[x] = extra[x];
        toks.push(t);
        return t;
      }
      function err(s0, e0, d) { return push('err', s0, e0, d); }
      function lit(s0, e0, ch, note) { return push('lit', s0, e0, 'Literal ' + charName(ch) + (note ? ' ' + note : ''), { ch: ch, note: note || '' }); }
      function groupLabel(g) { return g.label; }

      function quantifiable(t) {
        if (!t) return false;
        if (t.k === 'lit' || t.k === 'any' || t.k === 'cls' || t.k === 'set' || t.k === 'ref') return true;
        if (t.k === 'close') return !(t.group.kind === 'lookbehind' || t.group.kind === 'neglookbehind') && (uni ? t.group.kind !== 'lookahead' && t.group.kind !== 'neglookahead' : true);
        return false;
      }
      function quantText(lo, hi, lazy) {
        var base;
        if (lo === 0 && hi === Infinity) base = 'Zero or more times';
        else if (lo === 1 && hi === Infinity) base = 'One or more times';
        else if (lo === 0 && hi === 1) base = 'Optional — zero or one time';
        else if (lo === hi) return 'Exactly ' + lo + ' time' + (lo === 1 ? '' : 's');
        else if (hi === Infinity) base = lo + ' or more times';
        else base = 'Between ' + lo + ' and ' + hi + ' times';
        return base + (lazy ? ' — lazy: as few as possible' : ' — greedy: as many as possible');
      }
      function targetText(t) {
        if (t.k === 'close') return 'the whole ' + groupLabel(t.group);
        if (t.k === 'lit') return charName(t.ch) + ' (just that one character)';
        return 'the item before it';
      }
      function parseQuant(at, lo, hi, end) {
        var lazy = src.charAt(end) === '?', e = end + (lazy ? 1 : 0);
        var prev = toks.length ? toks[toks.length - 1] : null;
        if (lo > hi) { err(at, e, 'Quantifier numbers out of order: {' + lo + ',' + hi + '}'); return e; }
        if (lo > 4294967295 || (hi !== Infinity && hi > 4294967295)) { err(at, e, 'Quantifier number too large'); return e; }
        if (!quantifiable(prev)) { err(at, e, 'Nothing to repeat — “' + src.slice(at, e) + '” needs something before it'); return e; }
        push('quant', at, e, quantText(lo, hi, lazy) + ', applied to ' + targetText(prev), { lo: lo, hi: hi, lazy: lazy, target: toks.length - 1 });
        return e;
      }

      // \… outside a class
      function parseEscape(at) {
        if (at + 1 >= n) { err(at, at + 1, 'Trailing backslash — it escapes nothing'); return at + 1; }
        var c = src.charAt(at + 1), e = at + 2, rest = src.slice(at + 1), mm;
        if (ESC_CLASS[c]) { push('cls', at, e, 'Matches ' + ESC_CLASS[c]); return e; }
        if (c === 'b') { push('anchor', at, e, 'Word boundary — between a word character and a non-word character (or the text edge)'); return e; }
        if (c === 'B') { push('anchor', at, e, 'Not a word boundary'); return e; }
        if (c >= '1' && c <= '9') {
          var dm = /^\d+/.exec(rest)[0], num = +dm;
          if (num <= groups.length) {
            var g = groups[num - 1];
            push('ref', at, at + 1 + dm.length, 'Backreference — the same text group #' + num + (g.name ? ' “' + g.name + '”' : '') + ' matched', { ref: num });
            return at + 1 + dm.length;
          }
          if (uni) { err(at, at + 1 + dm.length, 'Backreference \\' + num + ' to a group that does not exist'); return at + 1 + dm.length; }
          if (c === '8' || c === '9') { lit(at, e, c, '(no group #' + num + ', so it is just the digit)'); return e; }
          mm = /^[0-7]{1,3}/.exec(rest); var oc = mm[0];
          if (parseInt(oc, 8) > 255) oc = oc.slice(0, 2);
          lit(at, at + 1 + oc.length, String.fromCharCode(parseInt(oc, 8)), '(legacy octal escape — no group #' + num + ')');
          return at + 1 + oc.length;
        }
        if (c === '0') {
          var nx = src.charAt(at + 2);
          if (nx >= '0' && nx <= '9') {
            if (uni) { err(at, at + 3, 'Invalid escape \\0' + nx + ' under the u/v flag'); return at + 3; }
            mm = /^[0-7]{1,3}/.exec(rest); var o2 = mm[0];
            if (parseInt(o2, 8) > 255) o2 = o2.slice(0, 2);
            lit(at, at + 1 + o2.length, String.fromCharCode(parseInt(o2, 8)), '(legacy octal escape)');
            return at + 1 + o2.length;
          }
          lit(at, e, '\u0000'); return e;
        }
        if (ESC_CTRL[c]) { lit(at, e, ESC_CTRL[c]); return e; }
        if (c === 'c') {
          var L = src.charAt(at + 2);
          if (/[A-Za-z]/.test(L)) { lit(at, at + 3, String.fromCharCode(L.charCodeAt(0) % 32), '(Ctrl+' + L.toUpperCase() + ')'); return at + 3; }
          if (uni) { err(at, e, 'Invalid \\c escape — it needs a letter after it'); return e; }
          lit(at, at + 1, '\\', '(a lone \\c is read as a backslash)'); return at + 1;
        }
        if (c === 'x') {
          mm = /^[0-9A-Fa-f]{2}/.exec(src.slice(at + 2));
          if (mm) { lit(at, at + 4, String.fromCharCode(parseInt(mm[0], 16)), '(\\x' + mm[0] + ')'); return at + 4; }
          if (uni) { err(at, e, 'Invalid \\x escape — it needs two hex digits'); return e; }
          lit(at, e, 'x', '(an incomplete \\x is just “x”)'); return e;
        }
        if (c === 'u') {
          if (uni && src.charAt(at + 2) === '{') {
            mm = /^\{([0-9A-Fa-f]+)\}/.exec(src.slice(at + 2));
            if (mm && parseInt(mm[1], 16) <= 0x10ffff) { lit(at, at + 2 + mm[0].length, String.fromCodePoint(parseInt(mm[1], 16)), '(U+' + hex(parseInt(mm[1], 16)) + ')'); return at + 2 + mm[0].length; }
            err(at, mm ? at + 2 + mm[0].length : e, 'Invalid \\u{…} escape'); return mm ? at + 2 + mm[0].length : e;
          }
          mm = /^[0-9A-Fa-f]{4}/.exec(src.slice(at + 2));
          if (mm) {
            var code = parseInt(mm[0], 16), endU = at + 6;
            if (uni && code >= 0xd800 && code <= 0xdbff) {
              var lo2 = /^\\u([Dd][C-Fc-f][0-9A-Fa-f]{2})/.exec(src.slice(endU));
              if (lo2) { var full = String.fromCharCode(code, parseInt(lo2[1], 16)); lit(at, endU + 6, full, '(U+' + hex(full.codePointAt(0)) + ')'); return endU + 6; }
            }
            lit(at, endU, String.fromCharCode(code), '(U+' + mm[0].toUpperCase() + ')'); return endU;
          }
          if (uni) { err(at, e, 'Invalid \\u escape — it needs four hex digits (or \\u{…})'); return e; }
          lit(at, e, 'u', '(an incomplete \\u is just “u”)'); return e;
        }
        if (c === 'p' || c === 'P') {
          if (!uni) { lit(at, e, c, '(\\' + c + '{…} needs the u or v flag — without it this is just “' + c + '”)'); return e; }
          mm = /^\{([A-Za-z_]+(?:=[A-Za-z0-9_]+)?)\}/.exec(src.slice(at + 2));
          if (!mm) { err(at, e, 'Invalid \\' + c + ' escape — write \\' + c + '{Property}'); return e; }
          push('cls', at, at + 2 + mm[0].length, 'Matches a character ' + (c === 'P' ? 'WITHOUT' : 'with') + ' the Unicode property ' + mm[1] + (PROP_HINT[mm[1]] ? ' (' + PROP_HINT[mm[1]] + ')' : ''));
          return at + 2 + mm[0].length;
        }
        if (c === 'k') {
          if (hasNamed || uni) {
            mm = /^<([^>]*)>/.exec(src.slice(at + 2));
            if (mm && names[mm[1]]) { push('ref', at, at + 2 + mm[0].length, 'Backreference — the same text group #' + names[mm[1]] + ' “' + mm[1] + '” matched', { ref: names[mm[1]] }); return at + 2 + mm[0].length; }
            err(at, mm ? at + 2 + mm[0].length : e, mm ? 'No group named “' + mm[1] + '”' : 'Invalid \\k escape — write \\k<name>');
            return mm ? at + 2 + mm[0].length : e;
          }
          lit(at, e, 'k', '(without named groups \\k is just “k”)'); return e;
        }
        var cp = String.fromCodePoint(src.codePointAt(at + 1));
        if (/[\^$\\.*+?()[\]{}|\/]/.test(cp)) { lit(at, at + 1 + cp.length, cp, '(escaped)'); return at + 1 + cp.length; }
        if (uni) { err(at, at + 1 + cp.length, 'Invalid escape \\' + cp + ' under the u/v flag (only syntax characters can be escaped)'); return at + 1 + cp.length; }
        lit(at, at + 1 + cp.length, cp, '(unnecessary escape)'); return at + 1 + cp.length;
      }

      // one item inside [...] starting at j -> { e, label, ch (single char or null), bad }
      function classAtom(j) {
        var c = src.charAt(j);
        if (c !== '\\') { var cp = uni ? String.fromCodePoint(src.codePointAt(j)) : c; return { e: j + cp.length, label: charName(cp), ch: cp }; }
        if (j + 1 >= n) return { e: j + 1, label: 'a backslash', ch: null, bad: 'Trailing backslash' };
        var x = src.charAt(j + 1), mm;
        if (CLASS_ITEM[x]) return { e: j + 2, label: CLASS_ITEM[x], ch: null };
        if (x === 'b') return { e: j + 2, label: 'a backspace (\\b means backspace inside [ ])', ch: '\b' };
        if (x === '-') return { e: j + 2, label: '“-”', ch: '-' };
        if (ESC_CTRL[x]) return { e: j + 2, label: charName(ESC_CTRL[x]), ch: ESC_CTRL[x] };
        if (x === '0' && !/[0-9]/.test(src.charAt(j + 2))) return { e: j + 2, label: charName('\u0000'), ch: '\u0000' };
        if (x === 'x' && (mm = /^[0-9A-Fa-f]{2}/.exec(src.slice(j + 2)))) { var cx = String.fromCharCode(parseInt(mm[0], 16)); return { e: j + 4, label: charName(cx), ch: cx }; }
        if (x === 'u') {
          if (uni && src.charAt(j + 2) === '{' && (mm = /^\{([0-9A-Fa-f]+)\}/.exec(src.slice(j + 2))) && parseInt(mm[1], 16) <= 0x10ffff) {
            var cu = String.fromCodePoint(parseInt(mm[1], 16)); return { e: j + 2 + mm[0].length, label: charName(cu), ch: cu };
          }
          if ((mm = /^[0-9A-Fa-f]{4}/.exec(src.slice(j + 2)))) { var c4 = String.fromCharCode(parseInt(mm[0], 16)); return { e: j + 6, label: 'U+' + mm[0].toUpperCase(), ch: c4 }; }
        }
        if (x === 'c' && /[A-Za-z]/.test(src.charAt(j + 2))) { var cc = String.fromCharCode(src.charCodeAt(j + 2) % 32); return { e: j + 3, label: 'Ctrl+' + src.charAt(j + 2).toUpperCase(), ch: cc }; }
        if ((x === 'p' || x === 'P') && uni) {
          mm = /^\{([A-Za-z_]+(?:=[A-Za-z0-9_]+)?)\}/.exec(src.slice(j + 2));
          if (mm) return { e: j + 2 + mm[0].length, label: (x === 'P' ? 'not ' : '') + (PROP_HINT[mm[1]] || '\\p{' + mm[1] + '}'), ch: null };
          return { e: j + 2, label: '\\' + x, ch: null, bad: 'Invalid \\' + x + ' escape' };
        }
        if (x === 'q' && v && src.charAt(j + 2) === '{') {
          var close = src.indexOf('}', j + 3);
          if (close > 0) return { e: close + 1, label: 'the string(s) “' + src.slice(j + 3, close).split('|').join('”, “') + '”', ch: null };
        }
        var xp = String.fromCodePoint(src.codePointAt(j + 1));
        if (uni && !/[\^$\\.*+?()[\]{}|\/\-]/.test(xp) && !(v && /[&!#%,:;<=>@`~]/.test(xp))) return { e: j + 1 + xp.length, label: charName(xp), ch: xp, bad: 'Invalid escape \\' + xp + ' in a class under the u/v flag' };
        return { e: j + 1 + xp.length, label: charName(xp), ch: xp };
      }
      function listText(items) {
        if (items.length > 12) items = items.slice(0, 12).concat(['…']);
        if (items.length === 1) return items[0];
        return items.slice(0, -1).join(', ') + ' or ' + items[items.length - 1];
      }
      function parseClass(at) {
        var neg = src.charAt(at + 1) === '^', j = at + 1 + (neg ? 1 : 0), items = [], depth = 1, bad = '', nested = false, ops = [];
        while (j < n) {
          var c = src.charAt(j);
          if (c === ']') { depth--; j++; if (!depth) break; continue; }
          if (v && c === '[') { depth++; nested = true; j++; continue; }
          if (v && (src.substr(j, 2) === '&&' || src.substr(j, 2) === '--')) { ops.push(src.substr(j, 2) === '&&' ? 'intersection (&&)' : 'subtraction (--)'); j += 2; continue; }
          var a = classAtom(j);
          if (a.bad && !bad) bad = a.bad;
          j = a.e;
          if (src.charAt(j) === '-' && j + 1 < n && src.charAt(j + 1) !== ']' && !(v && src.charAt(j + 1) === '-')) {
            var b = classAtom(j + 1);
            if (b.bad && !bad) bad = b.bad;
            if (a.ch != null && b.ch != null) {
              if (a.ch.codePointAt(0) > b.ch.codePointAt(0)) { if (!bad) bad = 'Range out of order in character class: ' + vis(a.ch) + '-' + vis(b.ch); }
              items.push(rangeLabel(a.ch, b.ch));
            } else {
              if (uni && !bad) bad = 'A class escape can\'t be a range end under the u/v flag';
              items.push(a.label, '“-”', b.label);
            }
            j = b.e;
            continue;
          }
          items.push(a.label);
        }
        if (depth > 0) { err(at, n, 'Unterminated character class — missing “]”'); return n; }
        var d;
        if (!items.length && !nested) d = neg ? 'Any character at all, line breaks included ([^] matches everything)' : 'Matches nothing — [] is an empty class';
        else d = (neg ? 'Any one character EXCEPT ' : 'Any one of: ') + listText(items.length ? items : ['a nested set']) + (ops.length ? ' — with set ' + ops.join(' and ') : '') + (nested ? ' (nested sets)' : '');
        if (bad) err(at, j, bad); else push('set', at, j, d);
        return j;
      }
      function rangeLabel(a, b) {
        var pa = a.codePointAt(0), pb = b.codePointAt(0);
        function nm(c, p) { return p > 32 && p !== 127 && !(p >= 0xd800 && p <= 0xdfff) ? c : 'U+' + hex(p); }
        return nm(a, pa) + '–' + nm(b, pb);
      }

      function parseOpen(at) {
        var g = { s: at, open: toks.length };
        if (src.charAt(at + 1) !== '?') {
          capN++; g.kind = 'cap'; g.n = capN; g.label = 'group #' + capN;
          push('open', at, at + 1, 'Capturing group #' + capN + ' — remembers what it matches ($' + capN + ' in a replacement)', { group: g });
          stack.push(g); return at + 1;
        }
        var t2 = src.charAt(at + 2), t3 = src.charAt(at + 3), end, mm;
        if (t2 === ':') { g.kind = 'noncap'; g.label = 'non-capturing group'; end = at + 3; push('open', at, end, 'Non-capturing group — groups the pattern without remembering it', { group: g }); }
        else if (t2 === '=') { g.kind = 'lookahead'; g.label = 'lookahead'; end = at + 3; push('open', at, end, 'Lookahead — what follows must match here, without being consumed', { group: g }); }
        else if (t2 === '!') { g.kind = 'neglookahead'; g.label = 'negative lookahead'; end = at + 3; push('open', at, end, 'Negative lookahead — what follows must NOT match here', { group: g }); }
        else if (t2 === '<' && t3 === '=') { g.kind = 'lookbehind'; g.label = 'lookbehind'; end = at + 4; push('open', at, end, 'Lookbehind — what follows must match just BEFORE this point', { group: g }); }
        else if (t2 === '<' && t3 === '!') { g.kind = 'neglookbehind'; g.label = 'negative lookbehind'; end = at + 4; push('open', at, end, 'Negative lookbehind — what follows must NOT match just before this point', { group: g }); }
        else if (t2 === '<') {
          var close = src.indexOf('>', at + 3), name = close > 0 ? src.slice(at + 3, close) : '';
          capN++; g.kind = 'cap'; g.n = capN; g.name = name; g.label = 'group #' + capN + ' “' + name + '”';
          end = close > 0 ? close + 1 : at + 3;
          if (close < 0) err(at, end, 'Unterminated group name — missing “>”');
          else if (!/^[A-Za-z_$\u00C0-\uFFFF][\w$\u00C0-\uFFFF]*$/.test(name)) err(at, end, 'Invalid group name “' + name + '”');
          else push('open', at, end, 'Named capturing group #' + capN + ' “' + name + '” — $<' + name + '> in a replacement', { group: g });
        }
        else if ((mm = /^\(\?([ims]*)(?:-([ims]*))?:/.exec(src.slice(at))) && (mm[1] || mm[2])) {
          g.kind = 'modifier'; g.label = 'modifier group'; end = at + mm[0].length;
          var on = mm[1].split('').map(function (f) { return f + ' on'; }), off = (mm[2] || '').split('').map(function (f) { return f + ' off'; });
          push('open', at, end, 'Modifier group — flags ' + on.concat(off).join(', ') + ' inside it (newer browsers only)', { group: g });
        }
        else { g.kind = 'noncap'; g.label = 'group'; end = at + 2; err(at, end, 'Invalid group syntax “(?' + t2 + '” — expected (?:  (?=  (?!  (?<=  (?<!  or (?<name>'); }
        stack.push(g);
        return end;
      }

      while (i < n) {
        var c = src.charAt(i);
        if (c === '\\') { i = parseEscape(i); continue; }
        if (c === '[') { i = parseClass(i); continue; }
        if (c === '(') { i = parseOpen(i); continue; }
        if (c === ')') {
          if (!stack.length) { err(i, i + 1, 'Unmatched “)” — no group is open'); i++; continue; }
          var g = stack.pop();
          g.close = toks.length;
          push('close', i, i + 1, 'End of ' + g.label, { group: g });
          i++; continue;
        }
        if (c === '|') { push('alt', i, i + 1, 'OR — otherwise try the alternative after this' + (stack.length ? ' (inside ' + stack[stack.length - 1].label + ')' : '')); i++; continue; }
        if (c === '*') { i = parseQuant(i, 0, Infinity, i + 1); continue; }
        if (c === '+') { i = parseQuant(i, 1, Infinity, i + 1); continue; }
        if (c === '?') { i = parseQuant(i, 0, 1, i + 1); continue; }
        if (c === '{') {
          var qm = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
          if (qm) { i = parseQuant(i, +qm[1], qm[2] ? (qm[3] === '' ? Infinity : +qm[3]) : +qm[1], i + qm[0].length); continue; }
          if (uni) { err(i, i + 1, 'Lone “{” — escape it as \\{ under the u/v flag'); i++; continue; }
          lit(i, i + 1, '{'); i++; continue;
        }
        if (c === '}' || c === ']') {
          if (uni) { err(i, i + 1, 'Lone “' + c + '” — escape it as \\' + c + ' under the u/v flag'); i++; continue; }
          lit(i, i + 1, c); i++; continue;
        }
        if (c === '^') { push('anchor', i, i + 1, ml ? 'Start of a line (m flag)' : 'Start of the text' + (src.indexOf('\n') < 0 ? '' : '')); i++; continue; }
        if (c === '$') { push('anchor', i, i + 1, ml ? 'End of a line (m flag)' : 'End of the text'); i++; continue; }
        if (c === '.') { push('any', i, i + 1, dotAll ? 'Any character, line breaks included (s flag)' : 'Any character except a line break'); i++; continue; }
        var cp = uni ? String.fromCodePoint(src.codePointAt(i)) : c;
        lit(i, i + cp.length, cp);
        i += cp.length;
      }
      while (stack.length) {
        var u = stack.pop();
        toks.push({ k: 'err', s: u.s, e: u.s + 1, raw: '(', d: 'Unclosed ' + u.label + ' — missing “)”', depth: stack.length });
      }
      return { tokens: toks, groups: groups };
    }

    // Nested variable quantifiers — (a+)+, (\w*)*, (\d+|x)+ — whose group body can
    // split the same text in many ways. A body with a mandatory literal that none of
    // its repeated parts can match — (?:[a-z]+\.)+ — is unambiguous and not flagged.
    function atomMatches(q, ch, flags) {
      if (q.k === 'lit') return has(flags, 'i') ? q.ch.toLowerCase() === ch.toLowerCase() : q.ch === ch;
      if (q.k === 'any') return has(flags, 's') || !/[\n\r\u2028\u2029]/.test(ch);
      try { return new RegExp('^(?:' + q.raw + ')$', (has(flags, 'i') ? 'i' : '') + (has(flags, 'v') ? 'v' : has(flags, 'u') ? 'u' : '')).test(ch); }
      catch (e) { return true; }
    }
    function riskWarnings(toks, flags) {
      var out = [];
      toks.forEach(function (t) {
        if (t.k !== 'quant' || t.hi <= 1) return;
        var target = toks[t.target];
        if (!target || target.k !== 'close') return;
        var g = target.group, bd = toks[g.open].depth + 1, inner = false, alt = false, mand = [], reps = [];
        for (var j = g.open + 1; j < g.close; j++) {
          var x = toks[j], nx = toks[j + 1];
          if (x.k === 'quant' && x.hi > 1 && x.lo !== x.hi) inner = true;
          else if (x.k === 'alt' && x.depth === bd) alt = true;
          else if (x.k === 'lit' || x.k === 'cls' || x.k === 'set' || x.k === 'any') {
            if (x.k === 'lit' && x.depth === bd && !(nx && nx.k === 'quant')) mand.push(x);
            else reps.push(x);
          }
        }
        if (!inner) return;
        var sep = !alt && mand.some(function (m) { return reps.every(function (r) { return !atomMatches(r, m.ch, flags); }); });
        if (sep) return;
        out.push('Possible catastrophic backtracking: “' + toks.slice(g.open, t.target + 1).map(function (x) { return x.raw; }).join('') + t.raw +
          '” repeats something that itself repeats, so text that almost matches can take exponential time — the tester stops it after ' + LIVE_MS +
          ' ms. Make each repetition unambiguous: (a+)+ → a+, (\\w+\\s?)* → (\\w+\\s)*\\w*.');
      });
      return out;
    }

    // plain characters merge into one "Literal text" row; ones with a caveat stay alone
    function mergeable(t) { return !t.note || t.note === '(escaped)'; }
    // -> { rows: [{depth, k, raw, d}], groups, warnings, errors, flags: [] }
    function explain(src, flags) {
      try {
        src = String(src == null ? '' : src); flags = String(flags || '');
        var r = tokenize(src, flags), toks = r.tokens, rows = [], ic = has(flags, 'i');
        for (var i = 0; i < toks.length; i++) {
          var t = toks[i];
          if (t.k === 'lit' && mergeable(t)) {
            var j = i;
            while (j + 1 < toks.length && toks[j + 1].k === 'lit' && toks[j + 1].depth === t.depth && mergeable(toks[j + 1])) j++;
            if (j + 1 < toks.length && toks[j + 1].k === 'quant' && j > i) j--; // the quantified character stands alone
            if (j > i) {
              var text = toks.slice(i, j + 1).map(function (x) { return x.ch; }).join('');
              rows.push({ depth: t.depth, k: 'lit', raw: src.slice(t.s, toks[j].e), d: 'Literal text “' + vis(text) + '”' + (ic && /[a-z]/i.test(text) ? ' (any case)' : '') });
              i = j;
              continue;
            }
            rows.push({ depth: t.depth, k: 'lit', raw: t.raw, d: t.d + (ic && /[a-z]/i.test(t.ch) ? ' (any case)' : '') });
            continue;
          }
          rows.push({ depth: t.depth, k: t.k, raw: t.raw, d: t.d });
        }
        var fl = [];
        'dgimsuvy'.split('').forEach(function (f) { if (has(flags, f) && FLAG_TEXT[f]) fl.push(FLAG_TEXT[f]); });
        var errors = toks.filter(function (x) { return x.k === 'err'; }).length;
        if (has(flags, 'u') && has(flags, 'v')) errors++, rows.push({ depth: 0, k: 'err', raw: 'uv', d: 'The u and v flags can\'t be used together' });
        return { rows: rows, groups: r.groups, warnings: riskWarnings(toks, flags), errors: errors, flags: fl };
      } catch (e) {
        return { rows: [{ depth: 0, k: 'err', raw: String(src).slice(0, 40), d: 'This pattern could not be explained' }], groups: [], warnings: [], errors: 1, flags: [] };
      }
    }

    // ---- replacement (String.prototype.replace semantics) -------------------------------
    function advanceIndex(str, i, unicode) {
      if (!unicode || i + 1 >= str.length) return i + 1;
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) { var d = str.charCodeAt(i + 1); if (d >= 0xdc00 && d <= 0xdfff) return i + 2; }
      return i + 1;
    }
    // GetSubstitution: $$ $& $` $' $n $nn $<name>
    function expandReplacement(tpl, m, str) {
      var out = '', i = 0, n = tpl.length, pos = m.index, matched = m[0], tail = pos + matched.length, caps = m.length - 1, groups = m.groups;
      while (i < n) {
        var c = tpl.charAt(i);
        if (c !== '$' || i + 1 >= n) { out += c; i++; continue; }
        var d = tpl.charAt(i + 1);
        if (d === '$') { out += '$'; i += 2; }
        else if (d === '&') { out += matched; i += 2; }
        else if (d === '`') { out += str.slice(0, pos); i += 2; }
        else if (d === "'") { out += str.slice(tail); i += 2; }
        else if (d >= '0' && d <= '9') {
          var d2 = tpl.charAt(i + 2), two = d2 >= '0' && d2 <= '9' ? +(d + d2) : -1, one = +d;
          if (two >= 1 && two <= caps) { out += m[two] == null ? '' : m[two]; i += 3; }
          else if (one >= 1 && one <= caps) { out += m[one] == null ? '' : m[one]; i += 2; }
          else { out += '$'; i++; }
        }
        else if (d === '<') {
          var gt = tpl.indexOf('>', i + 2);
          if (gt < 0 || groups === undefined) { out += '$<'; i += 2; }
          else { var v = groups[tpl.slice(i + 2, gt)]; out += v == null ? '' : String(v); i = gt + 1; }
        }
        else { out += '$'; i++; }
      }
      return out;
    }
    // Same result as text.replace(new RegExp(pattern, flags), tpl), built from our pieces.
    function replaceAllLike(text, re, tpl) {
      var out = '', pos = 0, uni = re.unicode || !!re.unicodeSets, m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        out += text.slice(pos, m.index) + expandReplacement(tpl, m, text);
        pos = m.index + m[0].length;
        if (!re.global) break;
        if (m[0] === '') re.lastIndex = advanceIndex(text, re.lastIndex, uni);
      }
      return out + text.slice(pos);
    }
    // \n \t \\ (and \w \s → space, like the app's Find & Replace) in a replacement
    function expandEscapes(r) {
      return String(r).replace(/\\([ntws\\])/g, function (m, c) { return c === 'n' ? '\n' : c === 't' ? '\t' : c === '\\' ? '\\' : ' '; });
    }

    // ---- the worker job (runs inside the Blob worker; also called directly in tests) --------
    function trunc(s, cap) { return s == null ? null : s.length > cap ? s.slice(0, cap) : s; }
    function packMatch(m, cap) {
      var g = [], i, named = null;
      for (i = 1; i < m.length; i++) g.push(m[i] === undefined ? null : trunc(m[i], cap));
      if (m.groups) { named = {}; for (var k in m.groups) named[k] = m.groups[k] === undefined ? null : trunc(m.groups[k], cap); }
      return { i: m.index, l: m[0].length, v: trunc(m[0], cap), g: g, n: named, x: m.indices ? m.indices.slice(1).map(function (p) { return p ? [p[0], p[1]] : null; }) : null };
    }
    // job: { id, kind: 'match' | 'apply', pattern, flags, text, tpl?, maxShow?, cap? }
    function runJob(job) {
      var t0 = Date.now(), re;
      try { re = new RegExp(job.pattern, job.flags); }
      catch (e) { return { id: job.id, kind: job.kind, ok: false, error: String(e && e.message || e) }; }
      var text = String(job.text), uni = re.unicode || !!re.unicodeSets, maxShow = job.maxShow || 1000, cap = job.cap || 200;
      var tpl = typeof job.tpl === 'string' ? job.tpl : null, apply = job.kind === 'apply';
      var matches = [], changes = [], total = 0, parts = [], marks = [], pos = 0, outLen = 0, m;
      var groupCount = 0;
      try { groupCount = new RegExp('|' + job.pattern, job.flags).exec('').length - 1; } catch (e) {}
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        total++;
        var end = m.index + m[0].length;
        if (!apply && matches.length < maxShow) matches.push(packMatch(m, cap));
        if (tpl !== null) {
          var rep = expandReplacement(tpl, m, text);
          if (apply) { if (rep !== m[0]) changes.push(m.index, end, rep); }
          else {
            var before = text.slice(pos, m.index);
            parts.push(before, rep); outLen += before.length;
            if (marks.length < maxShow * 2) marks.push(outLen, outLen + rep.length);
            outLen += rep.length;
          }
          pos = end;
        }
        if (!re.global) break;
        if (m[0] === '') re.lastIndex = advanceIndex(text, re.lastIndex, uni);
      }
      var res = { id: job.id, kind: job.kind, ok: true, total: total, ms: Date.now() - t0 };
      if (apply) res.changes = changes;
      else {
        res.matches = matches; res.groupCount = groupCount;
        if (tpl !== null) { parts.push(text.slice(pos)); res.preview = { text: parts.join(''), marks: marks }; }
      }
      return res;
    }
    function workerSource() {
      return '"use strict";\n' + [advanceIndex, expandReplacement, trunc, packMatch, runJob].map(String).join('\n') +
        '\nself.onmessage = function (e) { var r; try { r = runJob(e.data); } catch (err) { r = { id: e.data && e.data.id, ok: false, error: String(err && err.message || err) }; } self.postMessage(r); };\n';
    }

    // ---- job runner: one job at a time, a time limit, terminate + recreate on overrun -------
    // o: { spawn() -> worker-like {postMessage, terminate, onmessage, onerror}, setTimeout, clearTimeout }
    // run(job, ms, cb): cb gets the worker's reply, or {timeout:true, ms}, {superseded:true}
    // (a newer job replaced it while queued), {cancelled:true} (dispose) or {ok:false, error}.
    function createRunner(o) {
      var w = null, busy = null, pending = null, timer = null, spawned = 0;
      var setT = o.setTimeout || setTimeout, clearT = o.clearTimeout || clearTimeout;
      function kill() { if (w) { var x = w; w = null; x.onmessage = x.onerror = null; try { x.terminate(); } catch (e) {} } }
      function ensure() {
        if (w) return w;
        w = o.spawn(); spawned++;
        var me = w;
        w.onmessage = function (e) { if (w === me) reply(e && e.data !== undefined ? e.data : e); };
        w.onerror = function (e) {
          if (e && e.preventDefault) e.preventDefault();
          if (w !== me) return;
          kill();
          finish({ ok: false, error: 'The matcher crashed' + (e && e.message ? ': ' + e.message : '') });
        };
        return w;
      }
      function start(item) {
        busy = item;
        try { ensure().postMessage(item.job); }
        catch (e) { kill(); busy = null; item.cb({ id: item.job.id, ok: false, error: 'Could not start the matcher: ' + (e && e.message || e) }); next(); return; }
        timer = setT(function () {
          if (busy !== item) return;
          timer = null;
          kill(); // a runaway regex can't be interrupted — the worker goes, a fresh one comes next time
          busy = null;
          item.cb({ id: item.job.id, kind: item.job.kind, ok: false, timeout: true, ms: item.ms });
          next();
        }, item.ms);
      }
      function finish(data) {
        if (timer) { clearT(timer); timer = null; }
        var it = busy; busy = null;
        if (it) it.cb(data && data.id === undefined ? Object.assign({ id: it.job.id }, data) : data);
        next();
      }
      function reply(data) { if (busy && data && data.id === busy.job.id) finish(data); }
      function next() { if (!busy && pending) { var p = pending; pending = null; start(p); } }
      return {
        run: function (job, ms, cb) {
          var item = { job: job, ms: ms, cb: cb || function () {} };
          if (busy) { if (pending) pending.cb({ id: pending.job.id, superseded: true }); pending = item; }
          else start(item);
        },
        busy: function () { return !!busy; },
        alive: function () { return !!w; },
        spawned: function () { return spawned; },
        idleKill: function () { if (!busy && !pending) kill(); },
        dispose: function () {
          if (timer) { clearT(timer); timer = null; }
          kill();
          var b = busy, p = pending; busy = pending = null;
          if (b) b.cb({ id: b.job.id, cancelled: true });
          if (p) p.cb({ id: p.job.id, cancelled: true });
        },
      };
    }

    // ---- escaping / hand-off helpers -----------------------------------------------------------
    // A JS regex literal: escape "/" outside classes and line terminators — the
    // same text as RegExp.prototype.source.
    function toJsLiteral(p, flags) {
      p = String(p); flags = String(flags || '');
      if (!p) return '/(?:)/' + flags;
      var out = '', cls = 0, v = has(flags, 'v'), LT = { '\n': '\\n', '\r': '\\r', '\u2028': '\\u2028', '\u2029': '\\u2029' };
      for (var i = 0; i < p.length; i++) {
        var c = p.charAt(i);
        if (c === '\\') {
          if (i + 1 >= p.length) { out += '\\\\'; continue; }
          var nx = p.charAt(i + 1);
          out += LT[nx] || '\\' + nx; i++; continue;
        }
        if (cls) { if (c === ']') cls--; else if (c === '[' && v) cls++; }
        else if (c === '[') cls = 1;
        out += c === '/' && !cls ? '\\/' : LT[c] || c;
      }
      return '/' + out + '/' + flags;
    }
    // A double-quoted string literal valid in JS, JSON, Java, C#, Go …
    function toStringLiteral(s) {
      return '"' + String(s).replace(/[\\"\u0000-\u001f\u007f\u2028\u2029]/g, function (c) {
        return c === '\\' ? '\\\\' : c === '"' ? '\\"' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '\\u' + hex(c.charCodeAt(0));
      }) + '"';
    }
    function toNewRegExp(p, flags) { return 'new RegExp(' + toStringLiteral(p) + (flags ? ', "' + flags + '"' : '') + ')'; }

    // The app's Find & Replace runs patterns with only g (+ i via its Aa toggle), so
    // m and s are rewritten into the pattern; u/v syntax can't be carried over.
    // -> { pattern, caseSensitive, notes: [], error }
    function forFindPanel(p, flags) {
      p = String(p); flags = String(flags || '');
      var m = has(flags, 'm'), s = has(flags, 's'), v = has(flags, 'v'), out = '', cls = 0, i = 0, n = p.length, notes = [];
      var NOTLT = '[^\\n\\r\\u2028\\u2029]';
      while (i < n) {
        var c = p.charAt(i), e;
        if (c === '\\') {
          if (p.charAt(i + 1) === 'k' && p.charAt(i + 2) === '<' && (e = p.indexOf('>', i + 3)) > 0) { out += p.slice(i, e + 1); i = e + 1; continue; }
          out += p.substr(i, 2); i += 2; continue;
        }
        if (cls) { if (c === '[' && v) cls++; else if (c === ']') cls--; out += c; i++; continue; }
        if (c === '[') { cls = 1; out += c; i++; continue; }
        if (c === '(' && p.charAt(i + 1) === '?' && p.charAt(i + 2) === '<' && p.charAt(i + 3) !== '=' && p.charAt(i + 3) !== '!' && (e = p.indexOf('>', i + 3)) > 0) {
          out += p.slice(i, e + 1); i = e + 1; continue;
        }
        if (c === '.' && s) out += '[\\s\\S]';
        else if (c === '^' && m) out += '(?<!' + NOTLT + ')';
        else if (c === '$' && m) out += '(?!' + NOTLT + ')';
        else out += c;
        i++;
      }
      var res = { pattern: out, caseSensitive: !has(flags, 'i'), notes: notes, error: '' };
      if (m) notes.push('m rewritten as lookarounds');
      if (s) notes.push('s rewritten as [\\s\\S]');
      if (has(flags, 'u') || v) {
        if (/\\[pP]\{|\\u\{|[\ud800-\udbff]/.test(p) || (v && /\\q\{|&&|--|\[[^\]]*\[/.test(p))) {
          res.error = 'This pattern needs the ' + (v ? 'v' : 'u') + ' flag, which Find & Replace doesn\'t support — use Apply here instead';
        } else notes.push('runs without the ' + (v ? 'v' : 'u') + ' flag');
      }
      if (has(flags, 'y')) notes.push('y ignored');
      if (!has(flags, 'g')) notes.push('Find & Replace always finds every match');
      try { new RegExp(out, res.caseSensitive ? 'g' : 'gi'); } catch (e2) { if (!res.error) res.error = 'Find & Replace can\'t run this pattern: ' + e2.message; }
      return res;
    }
    // Our replacement (already escape-expanded) in the app's Replace field syntax,
    // which reads \n \t \\ itself: escape backslashes, spell out line breaks / tabs.
    function toFindReplacement(r) {
      return String(r).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t');
    }

    // ---- library -------------------------------------------------------------------------------
    var HEX = '[0-9A-Fa-f]';
    var IPV6 = '(?<![:\\w])(?:(?:' + HEX + '{1,4}:){7}' + HEX + '{1,4}|(?:' + HEX + '{1,4}:){1,7}:|(?:' + HEX + '{1,4}:){1,6}:' + HEX + '{1,4}|' +
      '(?:' + HEX + '{1,4}:){1,5}(?::' + HEX + '{1,4}){1,2}|(?:' + HEX + '{1,4}:){1,4}(?::' + HEX + '{1,4}){1,3}|(?:' + HEX + '{1,4}:){1,3}(?::' + HEX + '{1,4}){1,4}|' +
      '(?:' + HEX + '{1,4}:){1,2}(?::' + HEX + '{1,4}){1,5}|' + HEX + '{1,4}:(?::' + HEX + '{1,4}){1,6}|:(?:(?::' + HEX + '{1,4}){1,7}|:))(?![:\\w])';
    // { name, p, f, sample, r?, esc?, expect: number of matches in the sample (tested) }
    var LIBRARY = [
      { name: 'Email address', p: '[\\w.%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', f: 'g', sample: 'Write to ada@example.com or bob.smith+notes@mail.co.uk — not @handle or user@localhost.', expect: 2 },
      { name: 'URL (http / https)', p: 'https?:\\/\\/[^\\s<>"\']+[^\\s<>"\'.,;:!?)\\]]', f: 'gi', sample: 'See https://example.com/docs?page=2#top, or http://test.org/a/b. Not ftp://x.y.', expect: 2 },
      { name: 'IPv4 address', p: '\\b(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\b', f: 'g', sample: 'Router 192.168.1.1, DNS 8.8.8.8 — invalid: 256.1.1.1 and 10.0.0.300.', expect: 2 },
      { name: 'IPv6 address', p: IPV6, f: 'g', sample: 'Hosts 2001:db8::1, fe80::1ff:fe23:4567:890a, ::1 and 2001:0db8:85a3:0000:0000:8a2e:0370:7334.', expect: 4 },
      { name: 'Date YYYY-MM-DD (named groups)', p: '\\b(?<year>\\d{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12]\\d|3[01])\\b', f: 'g', sample: 'Released 2024-03-15, due 1999-12-31 — not 2024-13-01.', r: '$<day>/$<month>/$<year>', expect: 2 },
      { name: 'Date DD/MM/YYYY', p: '\\b(0?[1-9]|[12]\\d|3[01])([\\/.-])(0?[1-9]|1[0-2])\\2(\\d{4})\\b', f: 'g', sample: 'Born 31/12/1999, moved 1.5.2020 — not 32/01/2000 or 01/02.2003.', r: '$4-$3-$1', expect: 2 },
      { name: 'Date MM/DD/YYYY (US)', p: '\\b(0?[1-9]|1[0-2])\\/(0?[1-9]|[12]\\d|3[01])\\/(\\d{4})\\b', f: 'g', sample: 'Due 12/31/2024 and 7/4/1776 — not 13/01/2020.', r: '$3-$1-$2', expect: 2 },
      { name: 'Time 24 h (HH:MM[:SS])', p: '\\b([01]?\\d|2[0-3]):([0-5]\\d)(?::([0-5]\\d))?\\b', f: 'g', sample: 'Meet at 09:30 or 18:45:10 — not 24:00 or 7:60.', expect: 2 },
      { name: 'Time 12 h (h:mm am/pm)', p: '\\b(1[0-2]|0?[1-9]):([0-5]\\d)\\s?([ap]\\.?m\\b\\.?)', f: 'gi', sample: 'Doors 7:30 PM, show 8:15pm, brunch 11:00 a.m. — not 13:00 pm.', expect: 3 },
      { name: 'Phone (North America)', p: '(?:\\+?1[-.\\s]?)?\\(?\\b([2-9]\\d{2})\\)?[-.\\s]?(\\d{3})[-.\\s]?(\\d{4})\\b', f: 'g', sample: 'Call (555) 123-4567, 555.987.6543 or +1 212 555 0199.', r: '($1) $2-$3', expect: 3 },
      { name: 'Phone (international, E.164)', p: '\\+[1-9]\\d{6,14}\\b', f: 'g', sample: 'Numbers: +442071838750 and +14155552671; spaced ones like +33 1 23 don\'t match.', expect: 2 },
      { name: 'Hex colour', p: '#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\\b', f: 'g', sample: 'color: #fff; background: #0f9598; overlay: #12345678 — not #12, #12345 or #ggg.', expect: 3 },
      { name: 'UUID', p: '\\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b', f: 'gi', sample: 'ids 123e4567-e89b-12d3-a456-426614174000 and 550E8400-E29B-41D4-A716-446655440000.', expect: 2 },
      { name: 'US ZIP code', p: '\\b\\d{5}(?:-\\d{4})?\\b', f: 'g', sample: 'Beverly Hills 90210, New York 10001-0001 — not 1234.', expect: 2 },
      { name: 'UK postcode', p: '\\b[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2}\\b', f: 'gi', sample: 'London SW1A 1AA, Manchester M1 1AE, Leeds LS1 4AP.', expect: 3 },
      { name: 'Canadian postal code', p: '\\b[ABCEGHJ-NPRSTVXY]\\d[ABCEGHJ-NPRSTV-Z] ?\\d[ABCEGHJ-NPRSTV-Z]\\d\\b', f: 'gi', sample: 'Ottawa K1A 0B1, Vancouver V6B3K9.', expect: 2 },
      { name: 'Number with thousands separators', p: '(?<![\\d,.])-?\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?(?![\\d,])', f: 'g', sample: 'Population 1,234,567; budget -12,500.75 — not 1234 or 12,34.', expect: 2 },
      { name: 'Decimal / scientific number', p: '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?', f: 'g', sample: 'Values: 42, -3.14, .5, 6.02e23 and 1E-9.', expect: 5 },
      { name: 'Markdown link', p: '\\[([^\\]\\n]+)\\]\\(([^)\\s]+)(?:\\s+"([^"]*)")?\\)', f: 'g', sample: 'See [the docs](https://example.com "Docs") and [home](/).', r: '$1 <$2>', expect: 2 },
      { name: 'Duplicate words', p: '\\b(\\w+)\\s+\\1\\b', f: 'gi', sample: 'This is is a test of the the duplicate finder. The the end.', r: '$1', expect: 3 },
      { name: 'Trailing whitespace', p: '[ \\t]+$', f: 'gm', sample: 'line one   \nline two\t\nline three', r: '', expect: 2 },
      { name: 'Leading + trailing spaces', p: '^[ \\t]+|[ \\t]+$', f: 'gm', sample: '   indented\nclean\ntrailing   ', r: '', expect: 2 },
      { name: 'Extra blank lines', p: '\\n{3,}', f: 'g', sample: 'para one\n\n\n\npara two\n\n\npara three', r: '\\n\\n', esc: true, expect: 2 },
      { name: 'HTML tag', p: '<\\/?([a-zA-Z][\\w-]*)\\b[^>]*>', f: 'g', sample: '<p class="x">Hello <b>world</b><br/></p>', expect: 5 },
      { name: 'Semantic version', p: '\\bv?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-([\\w.-]+))?(?:\\+([\\w.-]+))?\\b', f: 'g', sample: 'Upgrade from v1.2.3 to 2.0.0-beta.1+build.5.', expect: 2 },
      { name: 'MAC address', p: '\\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\\b', f: 'g', sample: 'eth0 00:1A:2B:3C:4D:5E, wlan0 00-1a-2b-3c-4d-5f.', expect: 2 },
      { name: 'Hashtags & @mentions', p: '(?<![\\w@#])([#@])(\\w+)', f: 'g', sample: 'Thanks @cade for the #regex tips! email@x.com is not a mention.', expect: 2 },
      { name: 'Words in any script (u)', p: '\\p{L}+(?:[\'’]\\p{L}+)*', f: 'gu', sample: 'Café, naïve, Straße, Ελληνικά, 日本語 and don’t.', expect: 7 },
    ];
    var CHEAT = [
      ['Characters', [['.', 'any character except a line break'], ['\\d', 'digit 0–9'], ['\\D', 'not a digit'], ['\\w', 'word character [A-Za-z0-9_]'], ['\\W', 'not a word character'],
        ['\\s', 'whitespace'], ['\\S', 'not whitespace'], ['\\t', 'tab'], ['\\n', 'line feed'], ['\\.', 'a literal dot — escape . * + ? ^ $ ( ) [ ] { } | \\ /'], ['\\u00e9', 'character by code (é)'], ['\\p{L}', 'any letter (u flag)']]],
      ['Sets', [['[abc]', 'a, b or c'], ['[^abc]', 'anything except a, b, c'], ['[a-z]', 'range a to z'], ['[\\w.-]', 'word character, dot or hyphen']]],
      ['Anchors', [['^', 'start of the text (of a line with m)'], ['$', 'end of the text (of a line with m)'], ['\\b', 'word boundary'], ['\\B', 'not a word boundary']]],
      ['Groups', [['(…)', 'capturing group → $1'], ['(?:…)', 'group without capturing'], ['(?<name>…)', 'named group → $<name>'], ['\\1', 'the same text as group 1'], ['\\k<name>', 'the same text as the named group'], ['a|b', 'a or b']]],
      ['Lookaround', [['(?=…)', 'followed by'], ['(?!…)', 'not followed by'], ['(?<=…)', 'preceded by'], ['(?<!…)', 'not preceded by']]],
      ['Quantifiers', [['*', '0 or more'], ['+', '1 or more'], ['?', '0 or 1 (optional)'], ['{3}', 'exactly 3'], ['{2,}', '2 or more'], ['{2,5}', '2 to 5'], ['*?', 'lazy: as few as possible (also +? ?? {n,m}?)']]],
      ['Replacement', [['$&', 'the whole match'], ['$1', 'group 1'], ['$<name>', 'a named group'], ['$`', 'the text before the match'], ['$\'', 'the text after the match'], ['$$', 'a literal $']]],
    ];

    return {
      LIVE_MS: LIVE_MS, APPLY_MS: APPLY_MS, MAX_SHOW: MAX_SHOW, MAX_TEST: MAX_TEST, MAX_APPLY: MAX_APPLY, VAL_CAP: VAL_CAP,
      flagSupported: flagSupported, scanGroups: scanGroups, tokenize: tokenize, explain: explain,
      advanceIndex: advanceIndex, expandReplacement: expandReplacement, replaceAllLike: replaceAllLike, expandEscapes: expandEscapes,
      runJob: runJob, workerSource: workerSource, createRunner: createRunner,
      toJsLiteral: toJsLiteral, toStringLiteral: toStringLiteral, toNewRegExp: toNewRegExp, forFindPanel: forFindPanel, toFindReplacement: toFindReplacement,
      LIBRARY: LIBRARY, CHEAT: CHEAT, FLAG_TEXT: FLAG_TEXT,
    };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ===========================================================================
  // Panel UI
  // ===========================================================================
  var Cade = window.Cade;
  Cade.loadCSS('regex.css');
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'regex-panel';
  var PREFS_KEY = 'cade-regex-prefs', LAST_KEY = 'cade-regex-last', HIST_KEY = 'cade-regex-history';
  var HIST_MAX = 15, IDLE_MS = 30000, ROWS_STEP = 200;
  var FLAGS = 'gimsuvyd';
  var FLAG_OK = {};
  var TABS = ['matches', 'replace', 'explain', 'library'];
  var SAMPLE = 'Contact ada@example.com or bob.smith+notes@mail.co.uk before 2024-03-15.\n' +
    'Call (555) 123-4567 — the the meeting moved to 09:30.\nColours: #0f9598, #fff; version v2.4.1; https://example.com/docs';
  var IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var P = null, blobUrl = null;

  function readJSON(k, d) { try { var v = JSON.parse(Cade.store.get(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function writeJSON(k, v) { try { Cade.store.set(k, JSON.stringify(v)); } catch (e) {} }
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 1800); } catch (e) {} }
  function q(sel) { return P ? P.el.querySelector(sel) : null; }
  function fmtN(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function coarse() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }

  function copyText(text, label) {
    var done = function () { toast('Copied ' + (label || ''), 'success', 1400); };
    var fail = function () { toast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { if (document.execCommand('copy')) done(); else fail(); } catch (e) { fail(); }
      ta.remove();
    }
  }

  // ---- worker host ------------------------------------------------------------------------
  function spawnWorker() {
    if (typeof Worker === 'undefined' || !window.URL || !URL.createObjectURL) throw new Error('Web Workers are unavailable');
    if (!blobUrl) blobUrl = URL.createObjectURL(new Blob([Core.workerSource()], { type: 'application/javascript' }));
    return new Worker(blobUrl);
  }
  function makeRunner() {
    return Core.createRunner({ spawn: spawnWorker, setTimeout: function (f, ms) { return setTimeout(f, ms); }, clearTimeout: function (t) { clearTimeout(t); } });
  }

  // ---- state helpers --------------------------------------------------------------------------
  function setFlagsStr(f) {
    var out = '';
    FLAGS.split('').forEach(function (c) { if (has(f, c) && FLAG_OK[c]) out += c; });
    if (has(out, 'u') && has(out, 'v')) out = out.replace('u', '');
    P.flags = 'dgimsuvy'.split('').filter(function (c) { return has(out, c); }).join(''); // canonical order, like RegExp#flags
  }
  function has(s, c) { return String(s).indexOf(c) >= 0; }
  function tplRaw() { return P ? P.rep.value : ''; }
  function tplEff() { return P.escOn ? Core.expandEscapes(tplRaw()) : tplRaw(); }
  function editorPick() {
    try {
      var ed = Cade.editor, sel = ed.state.selection.main;
      if (!sel.empty) return { text: ed.state.sliceDoc(sel.from, Math.min(sel.to, sel.from + Core.MAX_TEST)), src: 'selection', cut: sel.to - sel.from > Core.MAX_TEST };
      var len = ed.state.doc.length;
      return { text: ed.state.sliceDoc(0, Math.min(len, Core.MAX_TEST)), src: 'note', cut: len > Core.MAX_TEST };
    } catch (e) { return { text: '', src: '', cut: false }; }
  }

  // ---- panel ----------------------------------------------------------------------------------
  function shell() {
    var flagBtns = FLAGS.split('').map(function (f) {
      return '<button type="button" class="rx-flag" data-f="' + f + '" aria-pressed="false" title="' + esc(Core.FLAG_TEXT[f]) + '">' + f + '</button>';
    }).join('');
    return '' +
      '<div class="rx-top">' +
        '<div class="rx-prow">' +
          '<div class="rx-pbox"><span class="rx-slash">/</span>' +
            '<input type="text" class="rx-pat" placeholder="pattern, e.g. (\\w+)@(\\w+)\\.com" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" aria-label="Pattern">' +
            '<span class="rx-slash">/</span><span class="rx-fstr" aria-hidden="true"></span></div>' +
          '<details class="rx-dd rx-hist"><summary class="rx-ibtn" title="Recent patterns" aria-label="Recent patterns">🕘</summary><div class="rx-menu rx-hmenu"></div></details>' +
        '</div>' +
        '<div class="rx-frow"><div class="rx-flags" role="group" aria-label="Flags">' + flagBtns + '</div>' +
          '<span class="rx-sp"></span>' +
          '<button type="button" class="rx-ibtn rx-find" title="Open the app\'s Find & Replace with this pattern">Find ↗</button>' +
          '<details class="rx-dd rx-copy"><summary class="rx-ibtn" title="Copy the pattern">Copy ▾</summary><div class="rx-menu rx-cmenu">' +
            '<button type="button" data-copy="lit"><code>/…/flags</code><small>JavaScript literal</small></button>' +
            '<button type="button" data-copy="new"><code>new RegExp("…")</code><small>JavaScript constructor</small></button>' +
            '<button type="button" data-copy="str"><code>"…"</code><small>escaped string — Java, C#, Go, JSON …</small></button>' +
          '</div></details>' +
        '</div>' +
        '<div class="rx-status" aria-live="polite"></div>' +
      '</div>' +
      '<div class="rx-tbox"><div class="rx-hl" aria-hidden="true"></div>' +
        '<textarea class="rx-text" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" maxlength="' + Core.MAX_TEST + '" aria-label="Test text" placeholder="Test text"></textarea></div>' +
      '<div class="rx-tbar">' +
        '<button type="button" class="rx-ibtn rx-usesel" title="Test against the editor selection">⇣ Selection</button>' +
        '<button type="button" class="rx-ibtn rx-usenote" title="Test against the whole note">⇣ Note</button>' +
        '<button type="button" class="rx-ibtn rx-clear" title="Clear the test text">Clear</button>' +
        '<span class="rx-sp"></span><span class="rx-tinfo"></span>' +
      '</div>' +
      '<div class="rx-tabs" role="tablist">' +
        '<button type="button" class="rx-tab" role="tab" data-tab="matches">Matches</button>' +
        '<button type="button" class="rx-tab" role="tab" data-tab="replace">Replace</button>' +
        '<button type="button" class="rx-tab" role="tab" data-tab="explain">Explain<span class="rx-warn" hidden> ⚠</span></button>' +
        '<button type="button" class="rx-tab" role="tab" data-tab="library">Library</button>' +
      '</div>' +
      '<div class="rx-panes">' +
        '<div class="rx-pane" data-pane="matches"></div>' +
        '<div class="rx-pane" data-pane="replace">' +
          '<textarea class="rx-rep" rows="2" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" aria-label="Replacement" placeholder="Replacement — $1  $<name>  $&  $$"></textarea>' +
          '<div class="rx-rbar"><label class="rx-cb" title="Read \\n, \\t and \\\\ in the replacement as a line break, a tab and a backslash"><input type="checkbox" class="rx-escbox"> <code>\\n \\t</code> escapes</label>' +
            '<span class="rx-sp"></span><span class="rx-rinfo"></span></div>' +
          '<div class="rx-prev" aria-label="Result preview"></div>' +
          '<div class="rx-racts">' +
            '<button type="button" class="rx-btn primary rx-apply" title="Replace in the editor selection, or the whole note when nothing is selected — one Undo reverts it">Apply to selection / note</button>' +
            '<button type="button" class="rx-btn rx-rcopy">Copy result</button>' +
            '<button type="button" class="rx-btn rx-rfind" title="Open Find & Replace with the pattern and this replacement">Find & Replace ↗</button>' +
          '</div>' +
        '</div>' +
        '<div class="rx-pane" data-pane="explain"></div>' +
        '<div class="rx-pane" data-pane="library"></div>' +
      '</div>';
  }

  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById(PANEL_ID);
    if (existing) { existing.remove(); if (existing._onClose) existing._onClose(); return; }
    FLAGS.split('').forEach(function (f) { if (FLAG_OK[f] === undefined) FLAG_OK[f] = Core.flagSupported(f); });
    var prefs = readJSON(PREFS_KEY, {}), last = readJSON(LAST_KEY, {});
    var el = Cade.mkPanel(PANEL_ID, '🧪 Regex Tester', shell());
    P = {
      el: el, pat: el.querySelector('.rx-pat'), ta: el.querySelector('.rx-text'), hl: el.querySelector('.rx-hl'), rep: el.querySelector('.rx-rep'),
      flags: 'g', tab: TABS.indexOf(prefs.tab) >= 0 ? prefs.tab : 'matches', escOn: prefs.esc !== false,
      runner: makeRunner(), jobId: 0, liveId: 0, res: null, ranges: [], prevText: '', applying: false,
      tRun: 0, tIdle: 0, tSave: 0, ro: null, rows: ROWS_STEP, src: '', cut: false, libDone: false,
    };
    var st = P;
    setFlagsStr(typeof last.f === 'string' ? last.f : typeof prefs.flags === 'string' ? prefs.flags : 'g');
    P.pat.value = typeof last.p === 'string' ? last.p : '';
    P.rep.value = typeof last.r === 'string' ? last.r : '';
    el.querySelector('.rx-escbox').checked = P.escOn;
    var pick = editorPick();
    if (pick.text.trim()) setText(pick.text, pick.src, pick.cut);
    else setText(SAMPLE, 'sample', false);
    syncFlags();
    bind(el, st);
    setTab(P.tab, true);
    if (typeof ResizeObserver !== 'undefined') {
      P.ro = new ResizeObserver(function () { if (P === st) syncPad(); });
      P.ro.observe(P.ta);
    }
    el._onClose = function () { teardown(st); };
    P.onHide = function () { if (P === st) saveLast(true); }; // a reload mid-debounce keeps the latest pattern
    window.addEventListener('pagehide', P.onHide);
    el.addEventListener('cade-panel-minimize', function () {
      if (P !== st) return;
      clearTimeout(P.tRun); clearTimeout(P.tIdle);
      saveLast(true); // flush a pending write now rather than while parked
      P.runner.dispose(); // frees the worker; nothing runs while parked
    });
    el.addEventListener('cade-panel-restore', function () { if (P === st) schedule(0); });
    runNow();
    if (!coarse()) setTimeout(function () { if (P === st) { P.pat.focus(); P.pat.select(); } }, 0);
  }

  function teardown(st) {
    if (P !== st) return;
    clearTimeout(P.tRun); clearTimeout(P.tIdle);
    saveLast(true);
    window.removeEventListener('pagehide', P.onHide);
    addHistory();
    var runner = P.runner, ro = P.ro;
    P = null; // first, so callbacks of cancelled jobs see a closed panel
    runner.dispose();
    if (ro) try { ro.disconnect(); } catch (e) {}
    if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) {} blobUrl = null; }
  }
  function close() { var el = document.getElementById(PANEL_ID); if (el) { el.remove(); if (el._onClose) el._onClose(); } }

  // ---- persistence ------------------------------------------------------------------------------
  function saveLast(now) {
    if (!P) return;
    clearTimeout(P.tSave);
    var st = P;
    var go = function () {
      if (P !== st) return;
      writeJSON(LAST_KEY, { p: P.pat.value.slice(0, 4000), f: P.flags, r: P.rep.value.slice(0, 4000) });
      writeJSON(PREFS_KEY, { flags: P.flags, tab: P.tab, esc: P.escOn });
    };
    if (now) go(); else P.tSave = setTimeout(go, 700);
  }
  function history() { var h = readJSON(HIST_KEY, []); return Array.isArray(h) ? h.filter(function (x) { return x && typeof x.p === 'string'; }) : []; }
  function addHistory() {
    if (!P) return;
    var p = P.pat.value, f = P.flags;
    if (!p || p.length > 2000) return;
    try { new RegExp(p, f); } catch (e) { return; }
    var h = history().filter(function (x) { return !(x.p === p && x.f === f); });
    h.unshift({ p: p, f: f });
    writeJSON(HIST_KEY, h.slice(0, HIST_MAX));
  }

  // ---- events -------------------------------------------------------------------------------------
  function bind(el, st) {
    P.pat.addEventListener('input', function () { if (P === st) { closeMenus(); onPattern(); } });
    P.pat.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addHistory(); } });
    P.ta.addEventListener('input', function () { if (P === st) onText(); });
    P.ta.addEventListener('scroll', function () { if (P === st) { P.hl.scrollTop = P.ta.scrollTop; P.hl.scrollLeft = P.ta.scrollLeft; } }, { passive: true });
    P.rep.addEventListener('input', function () { if (P === st) { saveLast(); schedule(); } });
    el.querySelector('.rx-escbox').addEventListener('change', function (e) { if (P === st) { P.escOn = e.target.checked; saveLast(true); schedule(0); } });
    el.querySelector('.rx-hist').addEventListener('toggle', function (e) { if (P === st && e.target.open) { renderHistory(); fitMenu(e.target); } });
    el.querySelector('.rx-copy').addEventListener('toggle', function (e) { if (P === st && e.target.open) fitMenu(e.target); });
    el.addEventListener('keydown', function (e) {
      if (P !== st || e.key !== 'Escape' || !el.querySelector('.rx-dd[open]')) return;
      e.preventDefault(); e.stopPropagation(); closeMenus(); // Esc closes an open dropdown first
    });
    el.addEventListener('click', function (e) {
      var t = e.target, b;
      if (P !== st || !t.closest) return;
      var dd = t.closest('.rx-dd');
      P.el.querySelectorAll('.rx-dd[open]').forEach(function (d) { if (d !== dd) d.open = false; });
      if ((b = t.closest('.rx-flag'))) { toggleFlag(b.getAttribute('data-f')); return; }
      if ((b = t.closest('.rx-tab'))) { setTab(b.getAttribute('data-tab')); return; }
      if ((b = t.closest('[data-copy]'))) { copyAs(b.getAttribute('data-copy')); closeMenus(); return; }
      if ((b = t.closest('[data-hist]'))) { var h = history()[+b.getAttribute('data-hist')]; if (h) loadPattern(h.p, h.f); closeMenus(); return; }
      if (t.closest('.rx-hclear')) { writeJSON(HIST_KEY, []); renderHistory(); return; }
      if (t.closest('.rx-find')) { useInFind(false); return; }
      if (t.closest('.rx-rfind')) { useInFind(true); return; }
      if (t.closest('.rx-usesel')) {
        var s = editorPick();
        if (s.src !== 'selection') { toast('Select some text in the editor first'); return; }
        setText(s.text, 'selection', s.cut); schedule(0); return;
      }
      if (t.closest('.rx-usenote')) {
        try {
          var ed = Cade.editor, len = ed.state.doc.length;
          setText(ed.state.sliceDoc(0, Math.min(len, Core.MAX_TEST)), 'note', len > Core.MAX_TEST); schedule(0);
        } catch (e2) {}
        return;
      }
      if (t.closest('.rx-clear')) { setText('', '', false); schedule(0); if (!coarse()) P.ta.focus(); return; }
      if (t.closest('.rx-apply')) { applyReplace(); return; }
      if (t.closest('.rx-rcopy')) { var pv = P.res && P.res.preview; if (pv) copyText(pv.text, 'result'); return; }
      if ((b = t.closest('.rx-more'))) { P.rows += ROWS_STEP; renderMatches(); return; }
      if ((b = t.closest('tr[data-k]'))) { revealMatch(+b.getAttribute('data-k')); return; }
      if ((b = t.closest('[data-lib]'))) { loadLibrary(+b.getAttribute('data-lib'), !!t.closest('.rx-libsample')); return; }
      if ((b = t.closest('[data-ins]'))) { insertToken(b.getAttribute('data-ins'), b.getAttribute('data-to')); }
    });
  }
  // A dropdown hangs from its button's right edge; when the button wrapped to the
  // left (phones) that would run off-screen, so hang it from the left edge instead.
  function fitMenu(dd) {
    var m = dd.querySelector('.rx-menu');
    if (!m) return;
    m.style.left = ''; m.style.right = '';
    var r = m.getBoundingClientRect(), pr = P.el.getBoundingClientRect();
    if (r.left < pr.left + 4) { m.style.right = 'auto'; m.style.left = '0'; }
  }
  function closeMenus() { if (!P) return; P.el.querySelectorAll('.rx-dd[open]').forEach(function (d) { d.open = false; }); }

  function toggleFlag(f) {
    if (!FLAG_OK[f]) { toast('The ' + f + ' flag isn\'t supported by this browser', 'error', 2200); return; }
    var cur = P.flags;
    if (has(cur, f)) cur = cur.replace(f, '');
    else { cur += f; if (f === 'u') cur = cur.replace('v', ''); if (f === 'v') cur = cur.replace('u', ''); }
    setFlagsStr(cur);
    syncFlags();
    onPattern(true, true);
  }
  function syncFlags() {
    P.el.querySelectorAll('.rx-flag').forEach(function (b) {
      var f = b.getAttribute('data-f'), on = has(P.flags, f);
      b.setAttribute('aria-pressed', String(on));
      b.disabled = !FLAG_OK[f];
      if (!FLAG_OK[f]) b.title = f + ' — not supported by this browser';
    });
    q('.rx-fstr').textContent = P.flags;
  }
  function onPattern(now, saveNow) {
    saveLast(saveNow);
    if (P.tab === 'explain') renderExplain();
    else updateWarn();
    schedule(now ? 0 : undefined);
  }
  function setTab(tab, first) {
    if (TABS.indexOf(tab) < 0) tab = 'matches';
    var changed = tab !== P.tab;
    P.tab = tab;
    P.el.querySelectorAll('.rx-tab').forEach(function (b) { var on = b.getAttribute('data-tab') === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    P.el.querySelectorAll('.rx-pane').forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== tab; });
    if (!first && changed) saveLast(true);
    if (tab === 'explain') renderExplain(); else updateWarn();
    if (tab === 'library' && !P.libDone) renderLibrary();
    if (tab === 'matches') renderMatches();
    if (tab === 'replace') { renderPreview(); if (!first) schedule(0); }
  }

  // ---- test text + highlighting ---------------------------------------------------------------------
  function setText(text, src, cut) {
    P.ta.value = text;
    P.src = src; P.cut = cut;
    P.ranges = []; P.prevText = text;
    P.ta.scrollTop = 0;
    renderHl();
    textInfo();
  }
  function textInfo() {
    var n = P.ta.value.length, s = fmtN(n) + ' char' + (n === 1 ? '' : 's');
    if (P.src === 'selection') s += ' · from the selection';
    else if (P.src === 'note') s += ' · from the note';
    else if (P.src === 'sample') s += ' · sample';
    if (P.cut) s += ' (first ' + fmtN(Core.MAX_TEST) + ')';
    q('.rx-tinfo').textContent = s;
  }
  function onText() {
    // keep the old highlights aligned while the worker catches up: shift the
    // ranges after the edit, drop the ones it touched
    var a = P.prevText, b = P.ta.value, pre = 0, suf = 0;
    var max = Math.min(a.length, b.length);
    while (pre < max && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
    while (suf < max - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf)) suf++;
    var oldEnd = a.length - suf, delta = b.length - a.length;
    P.ranges = P.ranges.filter(function (r) { return r[0] + r[1] < pre || (r[0] >= oldEnd && r[0] > pre); })
      .map(function (r) { return r[0] >= oldEnd ? [r[0] + delta, r[1], r[2]] : r; });
    P.prevText = b;
    if (P.src === 'sample' || P.src === 'note' || P.src === 'selection') { P.src = 'edited'; }
    renderHl();
    textInfo();
    schedule();
  }
  function syncPad() {
    if (!P) return;
    // the backdrop must wrap exactly like the textarea: same padding, plus the
    // textarea's scrollbar width on the right (and iOS's fixed 3px text inset)
    var cs = getComputedStyle(P.ta), pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
    var bx = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
    var sb = Math.max(0, P.ta.offsetWidth - P.ta.clientWidth - bx), ios = IOS ? 3 : 0;
    P.hl.style.paddingLeft = (pl + ios) + 'px';
    P.hl.style.paddingRight = (pr + sb + ios) + 'px';
    P.hl.scrollTop = P.ta.scrollTop;
  }
  function renderHl() {
    var text = P.ta.value, rs = P.ranges, html = '', pos = 0;
    for (var k = 0; k < rs.length; k++) {
      var i = rs[k][0], l = rs[k][1];
      if (i < pos || i > text.length) continue;
      html += esc(text.slice(pos, i));
      if (!l) html += '<span class="rx-zw" data-k="' + rs[k][2] + '"></span>';
      else html += '<mark class="rx-m' + (rs[k][2] % 2) + '" data-k="' + rs[k][2] + '">' + esc(text.slice(i, i + l)) + '</mark>';
      pos = i + l;
    }
    html += esc(text.slice(pos));
    if (!text || text.charAt(text.length - 1) === '\n') html += ' ';
    P.hl.innerHTML = html;
    syncPad();
  }
  function revealMatch(k) {
    var mk = P.hl.querySelector('[data-k="' + k + '"]'), m = P.res && P.res.matches && P.res.matches[k];
    if (!m) return;
    if (mk) {
      P.ta.scrollTop = Math.max(0, mk.offsetTop - P.ta.clientHeight / 3);
      P.hl.scrollTop = P.ta.scrollTop;
      P.hl.querySelectorAll('.rx-cur').forEach(function (x) { x.classList.remove('rx-cur'); });
      mk.classList.add('rx-cur');
    }
    P.el.querySelectorAll('tr.on').forEach(function (r) { r.classList.remove('on'); });
    var row = P.el.querySelector('tr[data-k="' + k + '"]'); if (row) row.classList.add('on');
    if (!coarse()) { try { P.ta.focus({ preventScroll: true }); P.ta.setSelectionRange(m.i, m.i + m.l); } catch (e) {} }
  }

  // ---- running ----------------------------------------------------------------------------------------
  function schedule(ms) {
    if (!P) return;
    clearTimeout(P.tRun);
    var st = P;
    P.tRun = setTimeout(function () { if (P === st) runNow(); }, ms == null ? 120 : ms);
  }
  function runNow() {
    if (!P || P.applying || (Cade.isMinimized && Cade.isMinimized(P.el))) return;
    clearTimeout(P.tRun); clearTimeout(P.tIdle);
    var pat = P.pat.value, st = P;
    if (!pat) { P.res = null; P.ranges = []; renderHl(); setStatus('Type a pattern — or pick one from the Library', ''); renderActive(); return; }
    var job = { id: ++P.jobId, kind: 'match', pattern: pat, flags: P.flags, text: P.ta.value, maxShow: Core.MAX_SHOW, cap: Core.VAL_CAP };
    if (P.tab === 'replace') job.tpl = tplEff();
    P.liveId = job.id;
    P.runner.run(job, Core.LIVE_MS, function (res) {
      if (P !== st || res.superseded || res.cancelled || res.id !== P.liveId) return;
      onResult(res, job);
      P.tIdle = setTimeout(function () { if (P === st) P.runner.idleKill(); }, IDLE_MS);
    });
  }
  function onResult(res, job) {
    if (res.timeout) {
      P.res = { timeout: true };
      P.ranges = [];
      renderHl();
      setStatus('⏱ Stopped after ' + res.ms + ' ms — this pattern backtracks catastrophically on this text (see Explain). The app stayed responsive; simplify the pattern.', 'err');
      renderActive();
      return;
    }
    if (!res.ok) {
      P.res = { error: res.error };
      P.ranges = [];
      renderHl();
      setStatus('⚠ ' + res.error.replace(/^Invalid regular expression: /, ''), 'err');
      renderActive();
      return;
    }
    res.job = job;
    P.res = res;
    P.rows = ROWS_STEP;
    if (job.text === P.ta.value) {
      P.ranges = res.matches.map(function (m, k) { return [m.i, m.l, k]; });
      P.prevText = job.text;
      renderHl();
    }
    var n = res.total, s;
    if (!n) s = 'No match';
    else s = fmtN(n) + ' match' + (n === 1 ? '' : 'es') + (n > res.matches.length ? ' · first ' + fmtN(res.matches.length) + ' shown' : '');
    if (!has(P.flags, 'g') && n) s += ' · g is off: first match only';
    s += ' · ' + (res.ms < 1 ? '<1' : res.ms) + ' ms';
    setStatus(s, n ? 'ok' : '');
    renderActive();
  }
  function setStatus(s, kind) {
    var el = q('.rx-status');
    el.textContent = s;
    el.className = 'rx-status' + (kind ? ' ' + kind : '');
  }
  function renderActive() {
    if (P.tab === 'matches') renderMatches();
    else if (P.tab === 'replace') renderPreview();
  }

  // ---- matches table -------------------------------------------------------------------------------------
  function cell(v, isNull) {
    if (isNull) return '<span class="rx-null" title="the group did not take part in this match">—</span>';
    if (v === '') return '<span class="rx-null" title="empty">∅</span>';
    var s = v.length > 120 ? v.slice(0, 120) : v, more = v.length > 120 || v.length >= Core.VAL_CAP;
    return esc(s).replace(/\n/g, '<span class="rx-ws">↵</span>').replace(/\t/g, '<span class="rx-ws">⇥</span>') + (more ? '<span class="rx-ws">…</span>' : '');
  }
  function renderMatches() {
    var pane = q('[data-pane="matches"]'), r = P.res;
    if (!pane || P.tab !== 'matches') return;
    if (!P.pat.value) { pane.innerHTML = '<div class="rx-empty">Matches, their positions and capture groups show up here.</div>'; return; }
    if (!r || r.timeout || r.error) { pane.innerHTML = '<div class="rx-empty">' + (r && r.timeout ? 'Matching was stopped — no results.' : r && r.error ? 'Fix the pattern to see matches.' : 'Matching…') + '</div>'; return; }
    if (!r.matches.length) { pane.innerHTML = '<div class="rx-empty">No match in the test text.</div>'; return; }
    var ex = Core.explain(P.res.job.pattern, P.res.job.flags), names = {};
    ex.groups.forEach(function (g) { if (g.name) names[g.n] = g.name; });
    var gc = r.groupCount, rows = r.matches.slice(0, P.rows), hasIdx = !!(r.matches[0] && r.matches[0].x);
    var h = '<div class="rx-tblwrap"><table class="rx-tbl"><thead><tr><th>#</th><th>at</th><th>match</th>';
    for (var g = 1; g <= gc; g++) h += '<th>' + g + (names[g] ? ' <span class="rx-gname">' + esc(names[g]) + '</span>' : '') + '</th>';
    h += '</tr></thead><tbody>';
    rows.forEach(function (m, k) {
      h += '<tr data-k="' + k + '"><td class="rx-n">' + (k + 1) + '</td><td class="rx-n">' + m.i + (m.l ? '–' + (m.i + m.l) : '') + '</td><td class="rx-v">' + cell(m.v, false) + '</td>';
      for (var j = 0; j < gc; j++) {
        var gv = m.g[j];
        h += '<td class="rx-v">' + cell(gv, gv === null) + (hasIdx && m.x[j] ? '<span class="rx-at">' + m.x[j][0] + '–' + m.x[j][1] + '</span>' : '') + '</td>';
      }
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    if (r.matches.length > rows.length) h += '<button type="button" class="rx-btn rx-more">Show ' + fmtN(Math.min(ROWS_STEP, r.matches.length - rows.length)) + ' more</button>';
    if (r.total > r.matches.length) h += '<div class="rx-note">' + fmtN(r.total) + ' matches in all — the first ' + fmtN(r.matches.length) + ' are listed and highlighted.</div>';
    pane.innerHTML = h;
  }

  // ---- replace preview ---------------------------------------------------------------------------------------
  function renderPreview() {
    var box = q('.rx-prev'), info = q('.rx-rinfo'), r = P.res;
    if (!box || P.tab !== 'replace') return;
    var ok = r && r.ok && r.preview && r.job && r.job.tpl === tplEff() && r.job.text === P.ta.value;
    q('.rx-rcopy').disabled = !ok;
    if (!P.pat.value) { box.innerHTML = '<div class="rx-empty">Type a pattern, then a replacement: $1 or $<name> for groups, $& for the whole match, $$ for a “$”.</div>'; info.textContent = ''; return; }
    if (!r || r.timeout || r.error) { box.innerHTML = '<div class="rx-empty">' + (r && r.timeout ? 'Matching was stopped — no preview.' : r && r.error ? 'Fix the pattern to see the result.' : 'Working…') + '</div>'; info.textContent = ''; return; }
    if (!ok) { info.textContent = 'Updating…'; return; }
    var t = r.preview.text, mk = r.preview.marks, html = '', pos = 0;
    var LIM = 200000;
    for (var k = 0; k < mk.length; k += 2) {
      if (mk[k] > LIM) break;
      html += esc(t.slice(pos, mk[k])) + (mk[k + 1] > mk[k] ? '<mark class="rx-r">' + esc(t.slice(mk[k], mk[k + 1])) + '</mark>' : '<span class="rx-zw rx-zr"></span>');
      pos = mk[k + 1];
    }
    html += esc(t.slice(pos, Math.max(pos, LIM)));
    if (t.length > LIM) html += '<span class="rx-ws">… (' + fmtN(t.length - LIM) + ' more characters)</span>';
    box.innerHTML = html || '<span class="rx-null">(empty result)</span>';
    info.textContent = r.total ? fmtN(r.total) + ' replacement' + (r.total === 1 ? '' : 's') : 'No match — nothing to replace';
  }

  // ---- explain --------------------------------------------------------------------------------------------------
  function updateWarn() {
    var ex = P.pat.value ? Core.explain(P.pat.value, P.flags) : null;
    var w = q('.rx-warn'); if (w) w.hidden = !(ex && (ex.warnings.length || ex.errors));
    return ex;
  }
  function renderExplain() {
    var pane = q('[data-pane="explain"]'), ex = updateWarn();
    if (!pane) return;
    if (!ex) { pane.innerHTML = '<div class="rx-empty">A token-by-token, plain-English reading of the pattern appears here.</div>'; return; }
    var h = '';
    ex.warnings.forEach(function (w) { h += '<div class="rx-banner warn">⚠ ' + esc(w) + '</div>'; });
    h += '<div class="rx-xlist">';
    ex.rows.forEach(function (r) {
      h += '<div class="rx-xrow k-' + r.k + '" style="padding-left:' + (6 + Math.min(r.depth, 8) * 14) + 'px"><code class="rx-tok">' + esc(r.raw).replace(/\n/g, '\\n') + '</code><span class="rx-xd">' + esc(r.d) + '</span></div>';
    });
    h += '</div>';
    if (ex.flags.length) h += '<div class="rx-xflags">' + ex.flags.map(function (f) { return '<div><code class="rx-tok">' + esc(f.charAt(0)) + '</code> ' + esc(f.slice(4)) + '</div>'; }).join('') + '</div>';
    pane.innerHTML = h;
  }

  // ---- library + cheat sheet ------------------------------------------------------------------------------------
  function renderLibrary() {
    var pane = q('[data-pane="library"]');
    var h = '<div class="rx-lsec">Ready-made patterns <span class="rx-dim">— tap to load · “try” also loads sample text</span></div><div class="rx-lib">';
    Core.LIBRARY.forEach(function (L, i) {
      var ok = true; try { new RegExp(L.p, L.f); } catch (e) { ok = false; }
      if (!ok) return; // e.g. a flag this browser lacks
      h += '<div class="rx-li"><button type="button" class="rx-lload" data-lib="' + i + '"><span class="rx-lname">' + esc(L.name) + '</span><code class="rx-lcode">/' + esc(L.p) + '/' + L.f + '</code></button>' +
        '<button type="button" class="rx-ibtn rx-libsample" data-lib="' + i + '" title="Load with its sample text">try</button></div>';
    });
    h += '</div><div class="rx-lsec">Cheat sheet <span class="rx-dim">— tap a token to insert it</span></div><div class="rx-cheat">';
    Core.CHEAT.forEach(function (sec) {
      var toRep = sec[0] === 'Replacement';
      h += '<div class="rx-csec"><div class="rx-chead">' + esc(sec[0]) + '</div>';
      sec[1].forEach(function (row) {
        h += '<div class="rx-crow"><button type="button" class="rx-ctok" data-ins="' + esc(row[0]) + '"' + (toRep ? ' data-to="rep"' : '') + '>' + esc(row[0]) + '</button><span>' + esc(row[1]) + '</span></div>';
      });
      h += '</div>';
    });
    h += '</div>';
    pane.innerHTML = h;
    P.libDone = true;
  }
  function loadPattern(p, f) {
    P.pat.value = p;
    setFlagsStr(f); syncFlags();
    onPattern(true, true);
  }
  function loadLibrary(i, withSample) {
    var L = Core.LIBRARY[i];
    if (!L) return;
    if (withSample || !P.ta.value.trim() || P.src === 'sample') { setText(L.sample, 'sample', false); }
    if (L.r != null) { P.rep.value = L.r; if (L.esc && !P.escOn) { P.escOn = true; q('.rx-escbox').checked = true; } }
    loadPattern(L.p, L.f);
    addHistory();
    setTab(L.r != null && withSample ? 'replace' : 'matches');
    toast('Loaded: ' + L.name, 'info', 1200);
  }
  function insertToken(tok, to) {
    var target = to === 'rep' ? P.rep : P.pat;
    if (to === 'rep' && P.tab !== 'replace') setTab('replace');
    var ins = tok, caret = -1;
    var ell = ins.indexOf('…');
    if (ell >= 0) { caret = ell; ins = ins.replace('…', ''); }
    var a = target.selectionStart != null ? target.selectionStart : target.value.length, b = target.selectionEnd != null ? target.selectionEnd : a;
    target.value = target.value.slice(0, a) + ins + target.value.slice(b);
    var c = a + (caret >= 0 ? caret : ins.length);
    try { if (!coarse()) { target.focus(); } target.setSelectionRange(c, c); } catch (e) {}
    if (to === 'rep') { saveLast(); schedule(0); } else onPattern(true);
  }

  // ---- history ---------------------------------------------------------------------------------------------------------
  function renderHistory() {
    var menu = q('.rx-hmenu'), h = history();
    if (!h.length) { menu.innerHTML = '<div class="rx-mempty">No recent patterns yet</div>'; return; }
    menu.innerHTML = h.map(function (x, i) { return '<button type="button" data-hist="' + i + '"><code>/' + esc(x.p) + '/' + esc(x.f) + '</code></button>'; }).join('') +
      '<button type="button" class="rx-hclear"><small>Clear history</small></button>';
  }

  // ---- hand-offs --------------------------------------------------------------------------------------------------------
  function copyAs(kind) {
    var p = P.pat.value, f = P.flags;
    if (!p) { toast('Type a pattern first'); return; }
    addHistory();
    if (kind === 'lit') copyText(Core.toJsLiteral(p, f), 'as a JS literal');
    else if (kind === 'new') copyText(Core.toNewRegExp(p, f), 'as new RegExp(…)');
    else copyText(Core.toStringLiteral(p), 'as an escaped string');
  }
  function useInFind(withReplace) {
    var p = P.pat.value;
    if (!p) { toast('Type a pattern first'); return; }
    var spec = Core.forFindPanel(p, P.flags);
    if (spec.error) { toast(spec.error, 'error', 3600); return; }
    if (typeof window.openFindPanel !== 'function') { toast('Find & Replace isn\'t available here', 'error'); return; }
    window.openFindPanel();
    var fi = document.getElementById('find-input'), ri = document.getElementById('replace-input');
    var rb = document.getElementById('find-regex'), cb = document.getElementById('find-case'), ib = document.getElementById('find-invert');
    if (!fi || !rb) { toast('Find & Replace isn\'t available here', 'error'); return; }
    if (ib && ib.classList.contains('active')) ib.click();
    if (!rb.classList.contains('active')) rb.click();
    if (cb && cb.classList.contains('active') !== spec.caseSensitive) cb.click();
    var rep = tplEff();
    if (ri && (withReplace || rep)) { ri.value = Core.toFindReplacement(rep); ri.dispatchEvent(new Event('input', { bubbles: true })); }
    fi.value = spec.pattern;
    fi.dispatchEvent(new Event('input', { bubbles: true }));
    try { fi.focus(); } catch (e) {}
    addHistory();
    toast('In Find & Replace' + (spec.notes.length ? ' · ' + spec.notes.join(' · ') : ''), 'success', spec.notes.length ? 3200 : 1600);
    if (window.innerWidth < 600 && Cade.minimizePanel) Cade.minimizePanel(P.el); // let the find bar show on a phone
  }
  function applyReplace() {
    var ed = Cade.editor;
    if (!ed || P.applying) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
    var p = P.pat.value;
    if (!p) { toast('Type a pattern first'); return; }
    var sel = ed.state.selection.main, inSel = !sel.empty;
    var from = inSel ? sel.from : 0, to = inSel ? sel.to : ed.state.doc.length;
    if (to - from > Core.MAX_APPLY) { toast('That is too much text to replace at once (' + fmtN(Core.MAX_APPLY) + ' characters max)', 'error', 3000); return; }
    var doc = ed.state.doc, st = P, btn = q('.rx-apply');
    var job = { id: ++P.jobId, kind: 'apply', pattern: p, flags: P.flags, text: ed.state.sliceDoc(from, to), tpl: tplEff() };
    P.applying = true; btn.disabled = true; btn.textContent = 'Replacing…';
    clearTimeout(P.tRun);
    P.runner.run(job, Core.APPLY_MS, function (res) {
      if (P !== st) return;
      P.applying = false; btn.disabled = false; btn.textContent = 'Apply to selection / note';
      if (res.cancelled || res.superseded) return; // minimized meanwhile: restore re-runs
      schedule(0);
      if (res.timeout) { toast('Stopped after ' + (res.ms / 1000) + ' s — the pattern is too slow on this text; nothing was changed', 'error', 3600); return; }
      if (!res.ok) { toast(res.error, 'error', 3000); return; }
      if (Cade.editor !== ed || ed.state.doc !== doc) { toast('The note changed meanwhile — nothing was replaced; try again', 'error', 3000); return; }
      if (!res.changes.length) { toast(res.total ? 'The replacements equal the matches — nothing to change' : 'No match ' + (inSel ? 'in the selection' : 'in the note'), 'info', 2200); return; }
      var ch = [];
      for (var k = 0; k < res.changes.length; k += 3) ch.push({ from: from + res.changes[k], to: from + res.changes[k + 1], insert: res.changes[k + 2] });
      ed.dispatch({ changes: ch, userEvent: 'input.replace', scrollIntoView: true });
      addHistory();
      var n = ch.length;
      toast('Replaced ' + fmtN(n) + ' match' + (n === 1 ? '' : 'es') + ' in the ' + (inSel ? 'selection' : 'note') + ' — one Undo (Ctrl/⌘+Z) reverts it' + (!has(P.flags, 'g') ? ' · g is off: first match only' : ''), 'success', 3200);
    });
  }

  Cade.registerWidget({
    name: 'Regex Tester',
    description: 'Test regular expressions live — highlighted matches, groups, replace preview, plain-English explanation, ready-made patterns',
    icon: '🧪',
    tags: 'regex,regexp,regular expression,pattern,match,test,tester,replace,find,capture,group,explain,cheat sheet,library,email,url,ip,date,backtracking,developer,code',
    open: open,
    close: close,
  });
})();
