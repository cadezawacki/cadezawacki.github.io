/* Text Pack — reshape prose: aLtErNaTiNg case, markdown-aware hard-wrap /
   unwrap, ASCII transliteration, redaction, numbers ↔ words, ordinals,
   plural / singular, lorem ipsum, and per-line truncate / surround / suffix.
   Script-pack module: one file registering 14 palette scripts.

   Unlike the older packs (template-literal sources with doubled escapes), each
   script here is written as real functions and turned into its source string
   with Function#toString. The core evaluates every script in isolation (it
   cannot see this IIFE), so reg() concatenates each helper a script needs into
   that script's own source. Bonus: the logic can be unit-tested in node. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;

  function reg(meta, main, helpers) {
    var src = '/**\n' + JSON.stringify(meta, null, 2) + '\n**/\n' + String(main);
    for (var i = 0; helpers && i < helpers.length; i++) src += '\n\n' + String(helpers[i]);
    window.Cade.registerScript(src);
  }

  // ===================================================================
  // Alternating Case
  // ===================================================================
  var altCaseMain = function main(ctx) {
    var t = ctx.selection || ctx.fullText;
    var out = altCase(t);
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // Alternates per cased letter only (spaces/digits/punctuation don't advance
  // the toggle), starting lower — "spongebob" → "sPoNgEbOb".
  function altCase(t) {
    var chars = Array.from(t), up = false, out = '';
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i], lo = ch.toLowerCase(), hi = ch.toUpperCase();
      if (lo === hi) { out += ch; continue; }
      // ß→SS / İ→i\u0307 change length; keep the original glyph but still toggle.
      var next = up ? hi : lo;
      out += next.length === ch.length ? next : ch;
      up = !up;
    }
    return out;
  }

  reg({
    name: 'Alternating Case (aLtErNaTiNg)',
    description: 'sPoNgEbOb mocking case — alternate lower/UPPER on every letter',
    author: 'Cade',
    icon: '🧽',
    tags: 'alternating,case,spongebob,mocking,sarcasm,meme,studly,toggle,silly,funny'
  }, altCaseMain, [altCase]);

  // ===================================================================
  // Shared markdown-aware line model (Wrap + Unwrap)
  // ===================================================================

  // Display width: code points, tabs to the next multiple of 4 (CM6 default).
  function wrapCols(s) {
    var chars = Array.from(s), w = 0;
    for (var i = 0; i < chars.length; i++) w += chars[i] === '\t' ? 4 - (w % 4) : 1;
    return w;
  }

  // Split a line into quote prefix / indentation / list marker / body and
  // classify it. qp + indent + marker + body === line, always.
  function wrapInfo(line) {
    var q = /^[ \t]*(?:>[ \t]?)+/.exec(line);
    var qp = q ? q[0] : '';
    var rest = line.slice(qp.length);
    var indent = /^[ \t]*/.exec(rest)[0];
    var body = rest.slice(indent.length);
    var info = { qp: qp, depth: (qp.match(/>/g) || []).length, indent: indent, marker: '', body: body, kind: 'text' };
    if (!body.trim()) info.kind = 'blank';                                   // also a bare ">" quote line
    else if (/^(`{3,}|~{3,})/.test(body)) info.kind = 'fence';
    else if (body.charAt(0) === '|') info.kind = 'table';
    else if (/^#{1,6}(\s|$)/.test(body)) info.kind = 'heading';
    else if (/^([-*_=])(?:[ \t]*\1){2,}[ \t]*$/.test(body)) info.kind = 'rule'; // hr / setext underline
    else {
      var m = /^(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(body);   // -, *, +, 1. 1) and - [ ] tasks
      if (m) { info.kind = 'item'; info.marker = m[0]; info.body = body.slice(m[0].length); }
    }
    return info;
  }

  // Fence tracking: returns the new fence state (the opening run, e.g. "```",
  // or null) after seeing `info` while in state `fence`.
  function wrapFence(info, fence) {
    var run = /^(`{3,}|~{3,})/.exec(info.body);
    if (!fence) return run ? run[1] : null;
    if (run && run[1].charAt(0) === fence.charAt(0) && run[1].length >= fence.length &&
        !info.body.slice(run[1].length).trim()) return null;
    return fence;
  }

  // Fence state at the end of `text` — lets a selection that starts inside a
  // ``` block know it is code.
  function wrapFenceAfter(text) {
    var lines = text ? text.split('\n') : [], fence = null;
    for (var i = 0; i < lines.length; i++) {
      var info = wrapInfo(lines[i]);
      if (fence || info.kind === 'fence') fence = wrapFence(info, fence);
    }
    return fence;
  }

  // Fence state just before the editor selection's first line ('' doc → null).
  function wrapFenceBeforeSelection() {
    var ed = window.Cade && window.Cade.editor;
    if (!ed) return null;
    var st = ed.state, start = st.doc.lineAt(st.selection.main.from).from;
    return start > 0 ? wrapFenceAfter(st.doc.sliceString(0, start)) : null;
  }

  // ===================================================================
  // Wrap at N Columns
  // ===================================================================
  var wrapMain = function main(ctx) {
    var Cade = window.Cade, KEY = 'cade-textpack-wrap-width';
    var last = null;
    try { last = Cade && Cade.store ? Cade.store.get(KEY) : null; } catch (e) { /* storage blocked */ }
    var ans = prompt('Wrap at column (width):', last || '80');
    if (ans === null) return;
    var width = parseInt(ans, 10);
    if (!(width >= 1 && width <= 10000)) { showToast('Enter a column width, e.g. 80', 'error', 2500); return; }
    try { if (Cade && Cade.store) Cade.store.set(KEY, String(width)); } catch (e) { /* ignore */ }
    var t = ctx.selection || ctx.fullText;
    var out = wrapText(t, width, ctx.selection ? wrapFenceBeforeSelection() : null);
    if (out === t) { showToast('Nothing to wrap — no line is wider than ' + width, 'info', 2500); return; }
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // Break only lines wider than `width` (never joins lines, so short-line lists
  // stay intact). Code fences, tables, headings and rules pass through.
  function wrapText(text, width, fence) {
    var lines = text.split('\n'), out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], info = wrapInfo(line);
      if (fence || info.kind === 'fence') { fence = wrapFence(info, fence); out.push(line); continue; }
      out.push(info.kind === 'text' || info.kind === 'item' ? wrapOne(info, line, width) : line);
    }
    return out.join('\n');
  }

  // Greedy wrap of one line. Continuation lines repeat the quote prefix and
  // indentation; list items get a hanging indent under their text (tabs kept
  // as tabs so it lines up). A token longer than the width stays whole.
  function wrapOne(info, line, width) {
    if (wrapCols(line) <= width) return line;
    var first = info.qp + info.indent + info.marker;
    var cont = info.qp + info.indent + info.marker.replace(/[^\t]/g, ' ');
    var body = info.body, trail = /[ \t]*$/.exec(body)[0];
    body = body.slice(0, body.length - trail.length);
    var parts = body.split(/([ \t]+)/);          // word, gap, word, gap, …
    var out = [], cur = first + parts[0], curW = wrapCols(cur);
    for (var i = 2; i < parts.length; i += 2) {
      var gap = parts[i - 1], word = parts[i], gw = wrapCols(gap), ww = wrapCols(word);
      if (curW + gw + ww <= width) { cur += gap + word; curW += gw + ww; }
      else { out.push(cur); cur = cont + word; curW = wrapCols(cur); }
    }
    out.push(cur + trail);
    return out.join('\n');
  }

  reg({
    name: 'Wrap at N Columns…',
    description: 'Hard-wrap long lines at a width (default 80) — keeps indents, hangs list items, repeats > quotes, skips code/tables/headings',
    author: 'Cade',
    icon: '📏',
    tags: 'wrap,hard wrap,columns,width,80,line length,reflow,fill,format,paragraph,markdown,email,commit,fmt'
  }, wrapMain, [wrapText, wrapOne, wrapInfo, wrapCols, wrapFence, wrapFenceAfter, wrapFenceBeforeSelection]);

  // ===================================================================
  // Unwrap Paragraphs
  // ===================================================================
  var unwrapMain = function main(ctx) {
    var ed = window.Cade && window.Cade.editor;
    var sel = ed ? ed.state.selection.main : null;
    // No real selection but the cursor is on a text line: the core hands us just
    // that line, which can't be unwrapped on its own — act on the paragraph /
    // list item around the cursor instead (like Emacs' unfill-paragraph).
    if (sel && sel.empty && ctx.selection) {
      if (ed.state.readOnly) { showToast('Document is read-only', 'error', 2500); return; }
      var doc = ed.state.doc, n = doc.lineAt(sel.head).number - 1;
      var units = unwrapUnits(doc.toString().split('\n'), null), u = null;
      for (var i = 0; i < units.length; i++) if (units[i].start <= n && n <= units[i].end) { u = units[i]; break; }
      if (!u || u.start === u.end) { showToast('Nothing to unwrap here — select text, or put the cursor in a wrapped paragraph', 'info', 3000); return; }
      ed.dispatch({ changes: { from: doc.line(u.start + 1).from, to: doc.line(u.end + 1).to, insert: u.text }, userEvent: 'input' });
      return;
    }
    var t = ctx.selection || ctx.fullText;
    var out = unwrapText(t, ctx.selection ? wrapFenceBeforeSelection() : null);
    if (out === t) { showToast('Nothing to unwrap', 'info', 2000); return; }
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  function unwrapText(text, fence) {
    var units = unwrapUnits(text.split('\n'), fence), out = [];
    for (var i = 0; i < units.length; i++) out.push(units[i].text);
    return out.join('\n');
  }

  // Groups lines into units {start, end, text}. A paragraph continues while the
  // next line is plain text at the same quote depth and indentation; a list
  // item continues while lines are indented past its marker. Blank lines,
  // fences (and their contents), tables, headings, rules and new list items all
  // break units. Lines that aren't joined come back byte-for-byte.
  function unwrapUnits(lines, fence) {
    var units = [], cur = null;
    function flush() {
      if (!cur) return;
      var body = cur.joined ? cur.body.replace(/ {2,}/g, ' ').replace(/\s+$/, '') : cur.body;
      units.push({ start: cur.start, end: cur.end, text: cur.head + body });
      cur = null;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], info = wrapInfo(line);
      if (fence || info.kind === 'fence') {
        flush(); fence = wrapFence(info, fence);
        units.push({ start: i, end: i, text: line }); continue;
      }
      if (info.kind === 'text' && cur && info.depth === cur.depth &&
          (cur.item ? wrapCols(info.indent) > cur.ind : wrapCols(info.indent) === cur.ind)) {
        cur.body = unwrapJoin(cur.body, info.body); cur.end = i; cur.joined = true; continue;
      }
      flush();
      if (info.kind === 'text' || info.kind === 'item') {
        cur = { start: i, end: i, depth: info.depth, ind: wrapCols(info.indent), item: info.kind === 'item',
                head: info.qp + info.indent + info.marker, body: info.body, joined: false };
      } else {
        units.push({ start: i, end: i, text: line });
      }
    }
    flush();
    return units;
  }

  // "exam-" + "ple" → "example" (hyphen ends the line after a letter and the
  // next line starts lowercase); otherwise join with one space.
  function unwrapJoin(a, b) {
    a = a.replace(/[ \t]+$/, ''); b = b.replace(/^[ \t]+/, '');
    if (!a) return b;
    if (!b) return a;
    if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
    return a + ' ' + b;
  }

  reg({
    name: 'Unwrap Paragraphs',
    description: 'Join hard-wrapped lines back into paragraphs — keeps list items, quotes, headings, tables and code fences apart',
    author: 'Cade',
    icon: '📜',
    tags: 'unwrap,unfill,join,lines,paragraph,reflow,hard wrap,merge,email,pdf,copy paste,newlines,hyphen'
  }, unwrapMain, [unwrapText, unwrapUnits, unwrapJoin, wrapInfo, wrapCols, wrapFence, wrapFenceAfter, wrapFenceBeforeSelection]);

  // ===================================================================
  // Transliterate to ASCII
  // ===================================================================
  var asciiMain = function main(ctx) {
    var t = ctx.selection || ctx.fullText;
    var stats = { unknown: 0 };
    var out = toAscii(t, stats);
    if (stats.unknown) showToast(stats.unknown + ' character' + (stats.unknown === 1 ? '' : 's') + ' had no ASCII equivalent (→ ?)', 'info', 3500);
    if (out === t) return;
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // Map pass → NFKD (splits accents, unfolds ligatures/fullwidth/𝗳𝗮𝗻𝗰𝘆 letters)
  // → strip marks → map pass again (Greek loses its tonos first, so α covers ά).
  // Cyrillic is mapped BEFORE NFKD so й/ё/ї keep their identity.
  function toAscii(text, stats) {
    var M = asciiMap();
    var s = text
      .replace(/[\u2028\u2029\u0085]/g, '\n')
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
      .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF\uFE00-\uFE0F]|\uD83C[\uDFFB-\uDFFF]/g, '')
      .replace(/(\d)([¼-¾⅐-⅞])/g, '$1 $2');   // 1½ → 1 1/2, not 11/2
    s = asciiMapChars(s, M);
    s = s.normalize('NFKD').replace(/\p{M}/gu, '');
    s = asciiMapChars(s, M);
    return s.replace(/[^\x00-\x7F]/gu, function () { if (stats) stats.unknown++; return '?'; });
  }

  // Multi-letter replacements for capitals follow their neighbours:
  // "Ærø" → "Aero" but "ÆRØ" → "AERO", "Щи" → "Shchi" but "ЩИ" → "SHCHI".
  function asciiMapChars(s, M) {
    var chars = Array.from(s), out = '';
    function isUp(c) { return !!c && c !== c.toLowerCase() && c === c.toUpperCase(); }
    for (var i = 0; i < chars.length; i++) {
      var c = chars[i], r = M[c];
      if (r === undefined) { out += c; continue; }
      if (r.length > 1 && isUp(c)) {
        var next = chars[i + 1], prev = chars[i - 1];
        if (isUp(next) || (isUp(prev) && !(next && next !== next.toUpperCase()))) r = r.toUpperCase();
      }
      out += r;
    }
    return out;
  }

  function asciiMap() {
    var M = {
      // Letters NFKD can't decompose
      'ß': 'ss', 'ẞ': 'SS', 'æ': 'ae', 'Æ': 'Ae', 'œ': 'oe', 'Œ': 'Oe', 'ø': 'o', 'Ø': 'O',
      'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ð': 'd', 'Ð': 'D', 'þ': 'th', 'Þ': 'Th',
      'ı': 'i', 'ȷ': 'j', 'ĸ': 'k', 'ŋ': 'ng', 'Ŋ': 'Ng', 'ħ': 'h', 'Ħ': 'H', 'ŧ': 't', 'Ŧ': 'T',
      'ƒ': 'f', 'ə': 'e', 'Ə': 'E', 'µ': 'u',
      // Quotes, dashes, punctuation
      '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '‵': "'", '´': "'",
      '‹': "'", '›': "'",
      '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', '‶': '"',
      '«': '"', '»': '"', '〝': '"', '〞': '"',
      '‐': '-', '‑': '-', '‒': '-', '–': '-', '−': '-', '⁃': '-',
      '—': '--', '―': '--', '…': '...', '⁄': '/', '∕': '/',
      '•': '*', '‣': '>', '◦': 'o', '·': '.', '⋅': '.', '‧': '-',
      '¡': '!', '¿': '?', '¦': '|', '˜': '~', 'ˆ': '^', '†': '+',
      // Symbols
      '©': '(c)', '®': '(R)', '™': '(TM)', '℠': '(SM)', '℗': '(P)',
      '§': 'Sec.', '¶': 'Para.',
      '€': 'EUR', '£': 'GBP', '¥': 'JPY', '¢': 'c', '₹': 'INR', '₽': 'RUB',
      '₩': 'KRW', '₿': 'BTC', '₺': 'TRY', '₴': 'UAH',
      '×': 'x', '÷': '/', '±': '+/-', '°': 'deg', '‰': '%o',
      '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '∞': 'inf', '√': 'sqrt',
      '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '⇐': '<=', '⇔': '<=>',
      '↑': '^', '↓': 'v', '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x'
    };
    // Cyrillic (Russian + Ukrainian/Belarusian/Serbian extras), lower → Latin;
    // capitals derived (Ж → Zh; all-caps context handled in asciiMapChars).
    var cyr = {
      'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh', 'з': 'z',
      'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r',
      'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
      'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
      'і': 'i', 'ї': 'yi', 'є': 'ye', 'ґ': 'g', 'ў': 'u',
      'ђ': 'dj', 'ј': 'j', 'љ': 'lj', 'њ': 'nj', 'ћ': 'c', 'џ': 'dz', 'ѕ': 'dz', 'ќ': 'k', 'ѓ': 'g'
    };
    // Greek (modern), unaccented — accents are gone by the second map pass.
    var greek = {
      'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i', 'θ': 'th', 'ι': 'i',
      'κ': 'k', 'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'x', 'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's',
      'ς': 's', 'τ': 't', 'υ': 'y', 'φ': 'f', 'χ': 'ch', 'ψ': 'ps', 'ω': 'o'
    };
    [cyr, greek].forEach(function (tbl) {
      Object.keys(tbl).forEach(function (lo) {
        var r = tbl[lo], up = lo.toUpperCase();
        M[lo] = r;
        if (up !== lo && M[up] === undefined) M[up] = r.charAt(0).toUpperCase() + r.slice(1);
      });
    });
    return M;
  }

  reg({
    name: 'Transliterate to ASCII',
    description: 'Crème brûlée, Straße, Łódź, “smart” quotes — dashes… → plain ASCII (accents, ligatures, symbols, Greek & Cyrillic)',
    author: 'Cade',
    icon: '🔡',
    tags: 'ascii,transliterate,accents,diacritics,remove accents,unidecode,deaccent,latin,plain text,slug,normalize,cyrillic,greek,smart quotes'
  }, asciiMain, [toAscii, asciiMapChars, asciiMap]);

  // ===================================================================
  // Redact Selection
  // ===================================================================
  var redactMain = function main(ctx) {
    var ed = window.Cade && window.Cade.editor;
    // The core hands scripts the current line when nothing is selected —
    // redacting a whole line by accident would be nasty, so insist on a real one.
    if (!ed || ed.state.selection.main.empty || !ctx.selection) {
      showToast('Select the text you want to redact first', 'error', 2500);
      return;
    }
    ctx.selection = redact(ctx.selection);
  };

  // One █ per visible character (grapheme, so 👍🏽 or é is one block); spaces,
  // tabs and newlines survive so the layout keeps its shape.
  function redact(t) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      var segs = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t)), out = '';
      for (var i = 0; i < segs.length; i++) out += /^\s+$/.test(segs[i].segment) ? segs[i].segment : '█';
      return out;
    }
    return t.replace(/\S\p{M}*/gu, '█');
  }

  reg({
    name: 'Redact Selection',
    description: 'Black out the selected text with █ blocks (keeps spaces and line breaks)',
    author: 'Cade',
    icon: '⬛',
    tags: 'redact,censor,black out,blackout,hide,hide text,hide this text,hide selection,hide words,mask,obscure,privacy,secret,classified,block'
  }, redactMain, [redact]);

  // ===================================================================
  // Shared number scanner (Numbers → Words, Ordinals)
  // ===================================================================

  // Calls fn({sign, int, frac, pct, raw}) for every standalone number in the
  // text and splices in what it returns (null leaves it alone). Skipped on
  // purpose: numbers glued to letters / underscores (mp3, 3rd, v2, 1e5),
  // pieces of dates, times, versions, IPs, ranges, fractions and phone numbers
  // (2024-01-05, 10:30, 1.2.3, 5-10, 1/2, 555-0100), leading-zero codes (007),
  // .5, #12 / @3 / $5 / €5, and list markers ("1. ", "2) ") at a line start.
  function numScan(text, fn) {
    var re = /([-−])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%)?/g;
    return text.replace(re, function (raw, sign, int, frac, pct, off, s) {
      var end = off + raw.length;
      var b = s.charAt(off - 1), b2 = s.charAt(off - 2), a = s.charAt(end), a2 = s.charAt(end + 1);
      var word = /[\p{L}\p{N}\p{M}_]/u;
      if (word.test(b) || word.test(a)) return raw;
      if (/[.#$€£¥₹¢@\\\/^]/.test(b)) return raw;
      if (/[,:\/\-−]/.test(b) && /\d/.test(b2)) return raw;
      if (sign && /[,:\/]/.test(b)) return raw;
      if (/[.,:\/\-−]/.test(a) && /\d/.test(a2)) return raw;
      if (/[\/]/.test(a)) return raw;
      if (/^0\d/.test(int)) return raw;
      if (!sign && !frac && !pct && /[.)]/.test(a) && /^[ \t]?$/.test(a2) && /(^|\n)[ \t>]*$/.test(s.slice(0, off))) return raw;
      var r = fn({ sign: sign ? '-' : '', int: int, frac: frac || '', pct: !!pct, raw: raw });
      return r == null ? raw : r;
    });
  }

  // ===================================================================
  // Numbers → Words
  // ===================================================================
  var numWordsMain = function main(ctx) {
    var t = ctx.selection || ctx.fullText;
    var out = numbersToWords(t);
    if (out === t) { showToast('No standalone numbers to spell out', 'info', 2500); return; }
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // 42 → forty-two, -7 → minus seven, 3.14 → three point one four,
  // 1,250,000 → one million two hundred fifty thousand, 50% → fifty percent.
  // Up to 999 trillion; bigger numbers are left alone.
  function numbersToWords(text) {
    return numScan(text, function (m) {
      var digits = m.int.replace(/,/g, '');
      if (digits.length > 15) return null;
      var w = intToWords(Number(digits));
      if (m.frac) w += ' point ' + m.frac.split('').map(function (d) { return intToWords(+d); }).join(' ');
      return (m.sign ? 'minus ' : '') + w + (m.pct ? ' percent' : '');
    });
  }

  function intToWords(n) {
    var ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
      'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
    var TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    var SCALES = ['', ' thousand', ' million', ' billion', ' trillion'];
    if (n === 0) return 'zero';
    function chunk(c) {
      var h = Math.floor(c / 100), r = c % 100, out = [];
      if (h) out.push(ONES[h] + ' hundred');
      if (r) out.push(r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? '-' + ONES[r % 10] : ''));
      return out.join(' ');
    }
    var parts = [], i = 0;
    while (n > 0) {
      var c = n % 1000;
      if (c) parts.unshift(chunk(c) + SCALES[i]);
      n = Math.floor(n / 1000); i++;
    }
    return parts.join(' ');
  }

  reg({
    name: 'Numbers → Words',
    description: 'Spell out numbers — 42 → forty-two, -7 → minus seven, 3.14 → three point one four, 50% → fifty percent (dates, times, versions, codes and 3rd / mp3 are left alone)',
    author: 'Cade',
    icon: '🗣',
    tags: 'numbers,words,spell out,spell,number to words,english,cheque,check,writing,digits,text,convert,humanize'
  }, numWordsMain, [numbersToWords, intToWords, numScan]);

  // ===================================================================
  // Words → Numbers
  // ===================================================================
  var wordsNumMain = function main(ctx) {
    var t = ctx.selection || ctx.fullText;
    var out = wordsToNumbers(t);
    if (out === t) { showToast('No spelled-out numbers found', 'info', 2500); return; }
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // forty-two → 42, one hundred and five → 105, two million three hundred
  // thousand → 2300000, minus seven → -7, three point one four → 3.14,
  // a dozen → 12, nineteen hundred → 1900. Separate numbers stay separate
  // ("one two three" → "1 2 3"); ordinals (first, twenty-first) and hyphenated
  // words with non-number parts (twenty-one-year-old) are left alone, as is a
  // lone "one" after no / any / some / every / each / the / this / that / which.
  function wordsToNumbers(text) {
    var V = w2nVocab(), toks = [], re = /[\p{L}\p{N}\p{M}_'’]+/gu, m;
    while ((m = re.exec(text))) toks.push({ w: m[0], lw: m[0].toLowerCase(), s: m.index, e: m.index + m[0].length });
    // Hyphen compounds: every part must be a number word, else none of it is.
    for (var i = 0; i < toks.length; i++) {
      var j = i;
      while (j + 1 < toks.length && /^[-‑]$/.test(text.slice(toks[j].e, toks[j + 1].s))) j++;
      var allNum = true;
      for (var k = i; k <= j; k++) if (!V[toks[k].lw] || V[toks[k].lw].k === 'and' || V[toks[k].lw].k === 'a') allNum = false;
      for (k = i; k <= j; k++) toks[k].kind = allNum || j === i ? (V[toks[k].lw] || { k: 'other' }) : { k: 'other' };
      i = j;
    }
    var reps = [], skipOne = { no: 1, any: 1, some: 1, every: 1, each: 1, the: 1, this: 1, that: 1, which: 1 };
    for (i = 0; i < toks.length; i++) {
      var neg = false, st = i;
      if (toks[i].kind.k === 'minus' && i + 1 < toks.length && w2nLinked(text, toks[i], toks[i + 1]) &&
          !(i > 0 && w2nLinked(text, toks[i - 1], toks[i]) && /^(num|and)$/.test(toks[i - 1].kind.k))) {
        neg = true; st = i + 1;
      }
      var r = w2nParse(text, toks, st);
      if (!r) continue;
      if (r.end - st === 1 && toks[st].lw === 'one' && !r.frac && st > 0 && skipOne[toks[st - 1].lw]) { i = st; continue; }
      var val = String(r.value) + (r.frac ? '.' + r.frac : '');
      reps.push({ s: toks[i].s, e: toks[r.end - 1].e, v: (neg ? '-' : '') + val });
      i = r.end - 1;
    }
    var out = '', pos = 0;
    for (i = 0; i < reps.length; i++) { out += text.slice(pos, reps[i].s) + reps[i].v; pos = reps[i].e; }
    return out + text.slice(pos);
  }

  // Two tokens belong to one phrase when only spaces / tabs or one hyphen sit between.
  function w2nLinked(text, a, b) {
    return /^(?:[ \t]+|[-‑])$/.test(text.slice(a.e, b.s));
  }

  function w2nVocab() {
    var V = {};
    'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'
      .split(' ').forEach(function (w, i) { V[w] = { k: 'num', t: i === 0 ? 'zero' : i < 10 ? 'unit' : 'teen', v: i }; });
    'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ').forEach(function (w, i) { V[w] = { k: 'num', t: 'tens', v: (i + 2) * 10 }; });
    V.hundred = { k: 'num', t: 'hundred', v: 100 };
    V.thousand = { k: 'num', t: 'scale', v: 1e3 }; V.million = { k: 'num', t: 'scale', v: 1e6 };
    V.billion = { k: 'num', t: 'scale', v: 1e9 }; V.trillion = { k: 'num', t: 'scale', v: 1e12 };
    V.dozen = { k: 'num', t: 'dozen', v: 12 };
    V.and = { k: 'and' }; V.a = { k: 'a' }; V.point = { k: 'point' };
    V.minus = { k: 'minus' }; V.negative = { k: 'minus' };
    return V;
  }

  // Longest valid number starting at toks[i] → {end (exclusive), value, frac} or null.
  function w2nParse(text, toks, i) {
    var total = 0, cur = 0, minScale = Infinity, last = null, k = i, frac = '';
    function kindAt(x) { return x < toks.length ? toks[x].kind : { k: 'none' }; }
    function linked(x) { return x + 1 < toks.length && w2nLinked(text, toks[x], toks[x + 1]); }
    while (k < toks.length) {
      if (k > i && !linked(k - 1)) break;
      var K = kindAt(k), t = K.t;
      if (K.k === 'a') {
        var nx = kindAt(k + 1);
        if (last !== null || !linked(k) || !(nx.t === 'hundred' || nx.t === 'scale' || nx.t === 'dozen')) break;
        cur = 1; last = 'a'; k++; continue;
      }
      if (K.k === 'and') {
        var na = kindAt(k + 1);
        if (!(last === 'hundred' || last === 'scale') || !linked(k) || !(na.t === 'unit' || na.t === 'teen' || na.t === 'tens')) break;
        last = 'and'; k++; continue;
      }
      if (K.k === 'point') {
        if (last === null || last === 'a' || last === 'and' || !linked(k)) break;
        var d = k + 1, ds = '';
        while (d < toks.length && (toks[d].kind.t === 'unit' || toks[d].kind.t === 'zero') && w2nLinked(text, toks[d - 1], toks[d])) { ds += toks[d].kind.v; d++; }
        if (!ds) break;
        frac = ds; k = d; break;
      }
      if (K.k !== 'num') break;
      if (last === 'zero' || last === 'dozen') break;
      if (t === 'zero') { if (last !== null) break; last = 'zero'; k++; continue; }
      if (t === 'unit') { if (!(last === null || last === 'tens' || last === 'hundred' || last === 'scale' || last === 'and')) break; }
      else if (t === 'teen' || t === 'tens') { if (!(last === null || last === 'hundred' || last === 'scale' || last === 'and')) break; }
      else if (t === 'hundred') { if (!(cur >= 1 && cur < 100) || last === 'and') break; cur *= 100; last = 'hundred'; k++; continue; }
      else if (t === 'scale') { if (!(cur > 0) || K.v >= minScale || last === 'and') break; total += cur * K.v; cur = 0; minScale = K.v; last = 'scale'; k++; continue; }
      else if (t === 'dozen') { if (!(cur >= 1 && cur < 100) || !(last === 'unit' || last === 'teen' || last === 'tens' || last === 'a')) break; cur *= 12; last = 'dozen'; k++; continue; }
      cur += K.v; last = t; k++;
    }
    if (last === null || last === 'a') return null;
    return { end: k, value: total + cur, frac: frac };
  }

  reg({
    name: 'Words → Numbers',
    description: 'Turn spelled-out numbers into digits — forty-two → 42, one hundred and five → 105, minus seven → -7, three point one four → 3.14, a dozen → 12',
    author: 'Cade',
    icon: '🔢',
    tags: 'words,numbers,digits,words to numbers,parse,english,spelled out,convert,numeric,dozen,hundred,thousand,million'
  }, wordsNumMain, [wordsToNumbers, w2nLinked, w2nVocab, w2nParse]);

  // ===================================================================
  // Ordinals
  // ===================================================================
  var ordinalsMain = function main(ctx) {
    var t = ctx.selection || ctx.fullText;
    var out = addOrdinals(t);
    if (out === t) { showToast('No standalone whole numbers to turn into ordinals', 'info', 2500); return; }
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // 1 → 1st, 22 → 22nd, 113 → 113th, 1,001 → 1,001st. Whole, unsigned,
  // standalone numbers only (same rules as Numbers → Words; 1st / 3.5 / 50% /
  // -2 / list markers are left alone).
  function addOrdinals(text) {
    return numScan(text, function (m) {
      if (m.sign || m.frac || m.pct) return null;
      return m.int + ordSuffix(Number(m.int.replace(/,/g, '').slice(-2)));
    });
  }

  function ordSuffix(n) {
    if (n % 100 >= 11 && n % 100 <= 13) return 'th';
    return ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  }

  reg({
    name: 'Ordinals',
    description: 'Add ordinal suffixes to whole numbers — 1 → 1st, 22 → 22nd, 113 → 113th (numbers in dates, times, codes and words are left alone)',
    author: 'Cade',
    icon: '🥇',
    tags: 'ordinal,ordinals,1st,2nd,3rd,nth,suffix,rank,numbers,position,th,st,nd,rd'
  }, ordinalsMain, [addOrdinals, ordSuffix, numScan]);

  // ===================================================================
  // Pluralize / Singularize Lines
  // ===================================================================
  var pluralMain = function main(ctx) {
    var t = ctx.selection || ctx.fullText;
    var out = inflectLines(t, 'plural');
    if (out === t) { showToast('Nothing to pluralize — the last word of each line is already plural (or uncountable)', 'info', 3000); return; }
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };
  var singularMain = function main(ctx) {
    var t = ctx.selection || ctx.fullText;
    var out = inflectLines(t, 'singular');
    if (out === t) { showToast('Nothing to singularize — the last word of each line is already singular (or uncountable)', 'info', 3000); return; }
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // The rule: on every line, the LAST word is inflected — the head noun of a
  // list item or a short phrase ("- big red apple" → "- big red apples",
  // "Category: Box" → "Category: Boxes"); a one-word line is that word. Only
  // letters count as the word; trailing punctuation / spaces stay. Lines that
  // end in a number, URL, path, @handle, #tag or a word with an apostrophe
  // are left alone, as are blank lines.
  function inflectLines(text, mode) {
    return text.split('\n').map(function (line) {
      var m = /(^|[^\p{L}\p{M}\p{N}_.\/@:#\\'’])([\p{L}\p{M}]+)([^\p{L}\p{M}\p{N}_'’]*)$/u.exec(line);
      if (!m) return line;
      var word = m[2], start = m.index + m[1].length;
      var next = inflectWord(word, mode);
      return next === word ? line : line.slice(0, start) + next + m[3];
    }).join('\n');
  }

  // Inflects one word, keeping its case style: the shared prefix as typed and
  // the new tail in caps when the word is ALL CAPS (Person → People,
  // PERSON → PEOPLE, iPhone → iPhones).
  function inflectWord(word, mode) {
    var lw = word.toLowerCase();
    var res = mode === 'plural' ? pluralWord(lw) : singularWord(lw);
    if (res === lw) return word;
    var p = 0;
    while (p < lw.length && p < res.length && lw[p] === res[p]) p++;
    var tail = res.slice(p);
    if (word.length > 1 && word === word.toUpperCase()) tail = tail.toUpperCase();
    else if (p === 0 && word[0] !== lw[0]) tail = tail.charAt(0).toUpperCase() + tail.slice(1);
    return word.slice(0, p) + tail;
  }

  function inflectData() {
    if (inflectData.cache) return inflectData.cache;
    function set(str) { var o = {}; str.split(/\s+/).forEach(function (w) { if (w) o[w] = 1; }); return o; }
    var irr = {
      person: 'people', man: 'men', woman: 'women', child: 'children', mouse: 'mice', louse: 'lice', goose: 'geese',
      tooth: 'teeth', foot: 'feet', ox: 'oxen', die: 'dice', penny: 'pence',
      cactus: 'cacti', fungus: 'fungi', nucleus: 'nuclei', radius: 'radii', stimulus: 'stimuli', syllabus: 'syllabi',
      alumnus: 'alumni', locus: 'loci',
      analysis: 'analyses', axis: 'axes', crisis: 'crises', diagnosis: 'diagnoses', prognosis: 'prognoses',
      thesis: 'theses', oasis: 'oases', synopsis: 'synopses', ellipsis: 'ellipses', emphasis: 'emphases',
      neurosis: 'neuroses', psychosis: 'psychoses', paralysis: 'paralyses', nemesis: 'nemeses',
      phenomenon: 'phenomena', criterion: 'criteria', datum: 'data', medium: 'media', curriculum: 'curricula',
      memorandum: 'memoranda', bacterium: 'bacteria', stratum: 'strata', millennium: 'millennia',
      appendix: 'appendices', matrix: 'matrices', vertex: 'vertices', index: 'indices', genus: 'genera', corpus: 'corpora',
      quiz: 'quizzes',
      knife: 'knives', wife: 'wives', life: 'lives', wolf: 'wolves', half: 'halves', calf: 'calves', elf: 'elves',
      leaf: 'leaves', loaf: 'loaves', shelf: 'shelves', thief: 'thieves', self: 'selves', sheaf: 'sheaves',
      scarf: 'scarves', wharf: 'wharves', hoof: 'hooves',
      potato: 'potatoes', tomato: 'tomatoes', hero: 'heroes', echo: 'echoes', veto: 'vetoes', torpedo: 'torpedoes',
      embargo: 'embargoes', mosquito: 'mosquitoes', volcano: 'volcanoes', domino: 'dominoes', cargo: 'cargoes',
      buffalo: 'buffaloes', tornado: 'tornadoes'
    };
    var rev = {};
    Object.keys(irr).forEach(function (k) { rev[irr[k]] = k; });
    return (inflectData.cache = {
      irr: irr, rev: rev,
      // Same plural for one and many
      unc: set('sheep fish deer moose swine bison salmon trout cod series species information rice money equipment news ' +
        'advice furniture luggage baggage music homework knowledge police traffic weather wheat jeans scissors pants ' +
        'shorts trousers pliers tongs offspring means headquarters chassis corps staff feedback research evidence ' +
        'aircraft spacecraft hovercraft gold silver sugar butter chaos kudos asbestos ethos pathos cosmos mucus ' +
        'physics mathematics economics athletics gymnastics ethics politics linguistics electronics ' +
        'cattle data wildlife livestock garbage rubbish mail clothing sand bread milk water sushi'),
      // Not nouns — never inflected
      stop: set('a an the and or but nor of to in on at by for with from as is are was were be been am do does did ' +
        'has have had it its this that these those he she they we you i me him her them us my your our their his ' +
        'hers ours theirs mine yours not no yes so than then there here thus always perhaps also too very'),
      // Irregulars that also end longer words (fireman, grandchild, bookshelf, hypothesis, salesperson…)
      compound: ('man woman person child goose tooth foot knife wife wolf half calf leaf loaf shelf thief self ' +
        'analysis thesis synopsis ellipsis diagnosis paralysis matrix appendix phenomenon criterion bacterium curriculum').split(' '),
      manNot: set('human german roman shaman talisman caiman ottoman walkman doberman pullman desman ' +
        'omen specimen abdomen stamen regimen semen hymen acumen bitumen lumen amen ramen'),
      // Singulars ending in -s: buses, lenses, statuses…
      sEnd: set('bus gas lens atlas canvas iris bias alias virus status bonus campus census circus apparatus ' +
        'octopus walrus chorus citrus prospectus sinus surplus thesaurus terminus uterus fetus hiatus consensus lotus ' +
        'nexus onus abacus plus minus pancreas focus'),
      // -che and -ie singulars (caches → cache, movies → movie)
      che: 'ache cache niche cliche avalanche moustache mustache quiche psyche creche panache microfiche attache douche pastiche cloche brioche'.split(' '),
      ie: ('movie cookie pie tie lie brownie zombie calorie rookie prairie selfie smoothie goalie hippie genie veggie ' +
        'freebie newbie foodie birdie hoodie sweetie cutie auntie collie pixie magpie lingerie budgie bootie ' +
        'yuppie junkie groupie sortie').split(' '),
      // -ch said "k": stomachs, epochs, monarchs
      chK: 'stomach epoch monarch patriarch matriarch oligarch tech loch czech eunuch'.split(' ')
    });
  }

  function inflectEnds(w, list) {
    for (var i = 0; i < list.length; i++) if (w === list[i] || w.length > list[i].length && w.slice(-list[i].length) === list[i]) return true;
    return false;
  }

  // Exact irregular, or a longer word ending in one (fireman → firemen);
  // `table` is d.irr (to plural) or d.rev (to singular).
  function inflectIrregular(w, table, d) {
    if (Object.prototype.hasOwnProperty.call(table, w)) return table[w];
    for (var i = 0; i < d.compound.length; i++) {
      var sing = d.compound[i], plur = d.irr[sing];
      var from = table === d.irr ? sing : plur, to = table === d.irr ? plur : sing;
      if (w.length > from.length && w.slice(-from.length) === from) {
        if ((sing === 'man' || sing === 'woman') && (d.manNot[w] || d.manNot[w.replace(/men$/, 'man')])) return null;
        return w.slice(0, w.length - from.length) + to;
      }
    }
    return null;
  }

  function inflectSkip(w, d) {
    return !w || d.unc[w] || d.stop[w] || (/(?:fish|sheep|deer|ware|craft)$/.test(w) && w.length > 5);
  }

  function pluralWord(w) {
    var d = inflectData();
    if (inflectSkip(w, d)) return w;
    var s = singularWord(w);
    if (s !== w && pluralWordRaw(s, d) === w) return w;     // already plural: people, cats, boxes, mice
    return pluralWordRaw(w, d);
  }

  function pluralWordRaw(w, d) {
    var irr = inflectIrregular(w, d.irr, d);
    if (irr) return irr;
    if (/(?:[^aeiou]|qu)y$/.test(w)) return w.slice(0, -1) + 'ies';      // city → cities, day → days
    if (inflectEnds(w, d.chK)) return w + 's';
    if (/sis$/.test(w)) return w.slice(0, -2) + 'es';                   // hypothesis → hypotheses
    if (/(?:s|sh|ch|x|z)$/.test(w)) return w + 'es';                     // bus, dish, church, box, waltz
    return w + 's';
  }

  function singularWord(w) {
    var d = inflectData();
    if (inflectSkip(w, d) || d.sEnd[w] || d.irr[w]) return w;
    var irr = inflectIrregular(w, d.rev, d);
    if (irr) return irr;
    if (/ies$/.test(w)) {
      var ie = w.slice(0, -1);
      // movies → movie, pies → pie; longer -ie words also match as endings (neckties)
      var ieWord = d.ie.some(function (x) { return ie === x || x.length >= 5 && inflectEnds(ie, [x]); });
      return w.length <= 4 || ieWord || /(?:neck|bow)tie$/.test(ie) ? ie : w.slice(0, -3) + 'y';
    }
    if (/(?:ss|sh|x|zz|[^aeiouz]z)es$/.test(w)) return w.slice(0, -2);       // boxes, waltzes (but prizes → prize)
    if (/ches$/.test(w)) return inflectEnds(w.slice(0, -1), d.che) ? w.slice(0, -1) : w.slice(0, -2);
    if (/ses$/.test(w) && d.sEnd[w.slice(0, -2)]) return w.slice(0, -2);
    if (/(?:ss|us|is)$/.test(w) || w.length < 3) return w;
    if (/s$/.test(w)) return w.slice(0, -1);
    return w;
  }

  reg({
    name: 'Pluralize Lines',
    description: 'Make the last word of every line plural — apple → apples, city → cities, box → boxes, knife → knives, person → people, child → children (keeps case; sheep / information stay)',
    author: 'Cade',
    icon: '👥',
    tags: 'plural,pluralize,plurals,inflect,english,noun,nouns,lines,list,many,irregular,grammar'
  }, pluralMain, [inflectLines, inflectWord, inflectData, inflectEnds, inflectIrregular, inflectSkip, pluralWord, pluralWordRaw, singularWord]);

  reg({
    name: 'Singularize Lines',
    description: 'Make the last word of every line singular — apples → apple, cities → city, boxes → box, knives → knife, people → person, mice → mouse (keeps case)',
    author: 'Cade',
    icon: '👤',
    tags: 'singular,singularize,depluralize,inflect,english,noun,nouns,lines,list,one,irregular,grammar'
  }, singularMain, [inflectLines, inflectWord, inflectData, inflectEnds, inflectIrregular, inflectSkip, pluralWord, pluralWordRaw, singularWord]);

  // ===================================================================
  // Lorem Ipsum…
  // ===================================================================
  var loremMain = function main(ctx) {
    var Cade = window.Cade, KEY = 'cade-textpack-lorem';
    var last = null;
    try { last = Cade && Cade.store ? Cade.store.get(KEY) : null; } catch (e) { /* storage blocked */ }
    var ans = prompt('Lorem ipsum — how much? 3 = paragraphs, 5s = sentences, 50w = words:', last || '3');
    if (ans === null) return;
    var spec = loremSpec(ans);
    if (!spec) { showToast('Enter e.g. 3 (paragraphs), 5s (sentences) or 50w (words)', 'error', 3000); return; }
    try { if (Cade && Cade.store) Cade.store.set(KEY, ans.trim()); } catch (e) { /* ignore */ }
    var text = lorem(spec.n, spec.unit, Math.random);
    var ed = Cade && Cade.editor;
    if (!ed) { if (ctx.selection) ctx.selection = text; else ctx.fullText = ctx.fullText ? ctx.fullText + '\n\n' + text : text; return; }
    if (ed.state.readOnly) { showToast('Document is read-only', 'error', 2500); return; }
    // A real selection is replaced; otherwise insert at the cursor (the core
    // would hand us the whole current line), padded so it doesn't fuse with
    // the text around it.
    var sel = ed.state.selection.main, doc = ed.state.doc;
    var before = doc.sliceString(Math.max(0, sel.from - 2), sel.from), after = doc.sliceString(sel.to, Math.min(doc.length, sel.to + 2));
    var pre = '', post = '';
    if (spec.unit === 'p') {
      if (sel.from > 0 && before !== '\n\n') pre = /\n$/.test(before) ? '\n' : '\n\n';
      if (sel.to < doc.length && after !== '\n\n') post = /^\n/.test(after) ? '\n' : '\n\n';
    } else {
      if (before && !/\s$/.test(before)) pre = ' ';
      if (after && !/^[\s.,;:!?)\]]/.test(after)) post = ' ';
    }
    var insert = pre + text + post;
    ed.dispatch({ changes: { from: sel.from, to: sel.to, insert: insert }, selection: { anchor: sel.from + pre.length + text.length }, userEvent: 'input', scrollIntoView: true });
  };

  // "3" / "3p" / "3 paragraphs" → {n: 3, unit: 'p'}; "5s" sentences, "50w" words.
  function loremSpec(ans) {
    var m = /^\s*(\d{1,5})\s*(p|para|paras|paragraphs?|s|sent|sents|sentences?|w|words?)?\s*$/i.exec(String(ans));
    if (!m) return null;
    var n = parseInt(m[1], 10), unit = (m[2] || 'p').charAt(0).toLowerCase();
    var max = { p: 100, s: 1000, w: 10000 }[unit];
    if (n < 1 || n > max) return null;
    return { n: n, unit: unit };
  }

  // Starts with the classic sentence; the rest is shuffled from the same Latin.
  function lorem(n, unit, rand) {
    var FIRST = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
    var WORDS = ('ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat ' +
      'duis aute irure dolor in reprehenderit voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint ' +
      'occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum lorem ipsum amet ' +
      'consectetur adipiscing elit sed eiusmod tempor incididunt labore magna aliqua integer porta semper tellus ' +
      'vitae fermentum lectus sagittis mauris viverra pellentesque habitant morbi tristique senectus netus').split(' ');
    function pick() { return WORDS[Math.floor(rand() * WORDS.length) % WORDS.length]; }
    function between(a, b) { return a + Math.floor(rand() * (b - a + 1)); }
    function sentence() {
      var len = between(7, 15), out = [];
      for (var i = 0; i < len; i++) {
        var w = pick();
        if (i && w === out[i - 1].replace(/,$/, '')) w = pick();
        if (i > 2 && i < len - 3 && rand() < 0.12) w += ',';
        out.push(w);
      }
      out[0] = out[0].charAt(0).toUpperCase() + out[0].slice(1);
      return out.join(' ').replace(/,$/, '') + '.';
    }
    var first = true;
    function nextSentence() { if (first) { first = false; return FIRST; } return sentence(); }
    if (unit === 'w') {
      var words = [];
      while (words.length < n) words = words.concat(nextSentence().split(' '));
      words = words.slice(0, n);
      words[n - 1] = words[n - 1].replace(/[.,]$/, '') + '.';
      return words.join(' ');
    }
    if (unit === 's') {
      var ss = [];
      for (var i = 0; i < n; i++) ss.push(nextSentence());
      return ss.join(' ');
    }
    var paras = [];
    for (var p = 0; p < n; p++) {
      var ps = [], count = between(4, 7);
      for (var j = 0; j < count; j++) ps.push(nextSentence());
      paras.push(ps.join(' '));
    }
    return paras.join('\n\n');
  }

  reg({
    name: 'Lorem Ipsum…',
    description: 'Insert placeholder Latin at the cursor (or over the selection) — asks how much: 3 paragraphs, 5s sentences or 50w words; starts with the classic "Lorem ipsum dolor sit amet…"',
    author: 'Cade',
    icon: '🏛',
    tags: 'lorem,ipsum,lorem ipsum,placeholder,dummy,filler,text,latin,generate,insert,mockup,design,paragraphs,sentences,words'
  }, loremMain, [loremSpec, lorem]);

  // ===================================================================
  // Truncate Lines…
  // ===================================================================
  var truncMain = function main(ctx) {
    var Cade = window.Cade, KEY = 'cade-textpack-truncate';
    var last = null;
    try { last = Cade && Cade.store ? Cade.store.get(KEY) : null; } catch (e) { /* storage blocked */ }
    var ans = prompt('Truncate lines longer than (characters):', last || '80');
    if (ans === null) return;
    var n = parseInt(ans, 10);
    if (!(n >= 1 && n <= 100000) || !/^\s*\d+\s*$/.test(ans)) { showToast('Enter a line length, e.g. 80', 'error', 2500); return; }
    try { if (Cade && Cade.store) Cade.store.set(KEY, String(n)); } catch (e) { /* ignore */ }
    var t = ctx.selection || ctx.fullText;
    var r = truncateLines(t, n);
    if (!r.count) { showToast('Nothing to truncate — no line is longer than ' + n, 'info', 2500); return; }
    if (ctx.selection) ctx.selection = r.text; else ctx.fullText = r.text;
  };

  // Lines over n characters (graphemes — é, 👍🏽 and 🇫🇷 count as one) keep
  // their first n−1 and end in "…", so every line fits in n.
  function truncateLines(text, n) {
    var seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
    var count = 0;
    var out = text.split('\n').map(function (line) {
      if (line.length <= n) return line;          // UTF-16 length ≥ grapheme count: fast path
      var g = seg ? Array.from(seg.segment(line), function (x) { return x.segment; }) : (line.match(/\P{M}\p{M}*|\p{M}+/gu) || []);
      if (g.length <= n) return line;
      count++;
      return g.slice(0, n - 1).join('').replace(/\s+$/, '') + '…';
    }).join('\n');
    return { text: out, count: count };
  }

  reg({
    name: 'Truncate Lines…',
    description: 'Cut every line longer than N characters and end it with … (asks for N, default 80; emoji and accents count as one)',
    author: 'Cade',
    icon: '✂',
    tags: 'truncate,cut,shorten,trim,lines,length,max,limit,ellipsis,columns,width,clip'
  }, truncMain, [truncateLines]);

  // ===================================================================
  // Surround Lines…
  // ===================================================================
  var surroundMain = function main(ctx) {
    var Cade = window.Cade, KEY = 'cade-textpack-surround';
    var last = null;
    try { last = Cade && Cade.store ? Cade.store.get(KEY) : null; } catch (e) { /* storage blocked */ }
    var ans = prompt('Surround each line with — e.g. " or ( or ** or <li>, or before|after with | for the line:', last || '"');
    if (ans === null || ans === '') return;
    try { if (Cade && Cade.store) Cade.store.set(KEY, ans); } catch (e) { /* ignore */ }
    var t = ctx.selection || ctx.fullText;
    var out = surroundLines(t, surroundPair(ans));
    if (out === t) return;
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // What goes before / after each line:
  //   "before|after" (one |) → as written ("<li>|</li>", "[|](url)")
  //   an opener → its closer: ( [ { < ‘ “ « ‹ „ ‚ 「 『 【 《 〈 ¿ ¡ mirror,
  //     "<b><i>" → "</i></b>", "/* " → " */", "<!-- " → " -->", "{{ " → " }}"
  //   anything else (" ' ** ` _ ~~) → the same text on both sides.
  function surroundPair(spec) {
    var bars = spec.split('|').length - 1;
    if (bars === 1 && spec !== '|') { var k = spec.indexOf('|'); return { before: spec.slice(0, k), after: spec.slice(k + 1) }; }
    var lead = /^\s*/.exec(spec)[0], trail = /\s*$/.exec(spec.slice(lead.length))[0];
    var core = spec.slice(lead.length, spec.length - trail.length);
    var mirrorWs = function (s) { return s.split('').reverse().join(''); };
    var tags = /^(?:<[A-Za-z][\w:.-]*(?:\s[^<>]*)?>)+$/.test(core) ? core.match(/<[A-Za-z][\w:.-]*/g) : null;
    if (tags) return { before: spec, after: mirrorWs(trail) + tags.reverse().map(function (t) { return '</' + t.slice(1) + '>'; }).join('') + mirrorWs(lead) };
    var WORDS = { '<!--': '-->', '/*': '*/', '/**': '*/', '(*': '*)', '{%': '%}', '{#': '#}', '<%': '%>', '<%=': '%>', '<?': '?>', '<?php': '?>' };
    if (WORDS[core]) return { before: spec, after: mirrorWs(trail) + WORDS[core] + mirrorWs(lead) };
    var PAIRS = { '(': ')', '[': ']', '{': '}', '<': '>', '‘': '’', '“': '”', '«': '»', '‹': '›', '„': '“', '‚': '‘',
      '「': '」', '『': '』', '【': '】', '《': '》', '〈': '〉', '（': '）', '［': '］', '｛': '｝', '¿': '?', '¡': '!' };
    var chars = Array.from(spec).reverse();
    return { before: spec, after: chars.map(function (c) { return PAIRS[c] || c; }).join('') };
  }

  // Wraps each non-blank line inside its indentation (and before trailing
  // spaces); if every non-blank line is already wrapped, unwraps instead.
  function surroundLines(text, pair) {
    var lines = text.split('\n'), B = pair.before, A = pair.after;
    function parts(l) { var m = /^([ \t]*)(.*?)([ \t]*)$/.exec(l); return { ind: m[1], body: m[2], tail: m[3] }; }
    var nonEmpty = lines.filter(function (l) { return l.trim() !== ''; });
    if (!nonEmpty.length || (!B && !A)) return text;
    var Bt = B.replace(/^[ \t]+/, ''), At = A.replace(/[ \t]+$/, '');
    var allHave = nonEmpty.every(function (l) {
      var p = parts(l).body;
      return p.length >= Bt.length + At.length && p.slice(0, Bt.length) === Bt && p.slice(p.length - At.length) === At;
    });
    return lines.map(function (l) {
      if (l.trim() === '') return l;
      var p = parts(l);
      if (allHave) {
        return p.ind + p.body.slice(Bt.length, p.body.length - At.length) + p.tail;
      }
      return p.ind + B + p.body + A + p.tail;
    }).join('\n');
  }

  reg({
    name: 'Surround Lines…',
    description: 'Wrap every line — type " or ( or ** or <li> (closers and closing tags added for you), or before|after with | marking the line; run again to unwrap',
    author: 'Cade',
    icon: '🥪',
    tags: 'surround,wrap,enclose,quote,quotes,brackets,parentheses,tags,html,li,lines,before,after,toggle,restructure,code'
  }, surroundMain, [surroundPair, surroundLines]);

  // ===================================================================
  // Suffix Lines… (companion to Prefix Lines… in the Clean pack)
  // ===================================================================
  var suffixMain = function main(ctx) {
    var suf = prompt('Suffix to toggle (e.g. ";", ",", " \\"):', ';');
    if (suf == null || suf === '') return;
    var t = ctx.selection || ctx.fullText;
    var out = suffixLines(t, suf);
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // Adds `suf` to the end of every non-blank line — or removes it if every
  // non-blank line already ends with it (mirror of Prefix Lines…).
  function suffixLines(text, suf) {
    var lines = text.split('\n');
    var nonEmpty = lines.filter(function (l) { return l.trim() !== ''; });
    var allHave = nonEmpty.length > 0 && nonEmpty.every(function (l) { return l.length >= suf.length && l.slice(l.length - suf.length) === suf; });
    return lines.map(function (l) {
      if (l.trim() === '') return l;
      return allHave ? l.slice(0, l.length - suf.length) : l + suf;
    }).join('\n');
  }

  reg({
    name: 'Suffix Lines…',
    description: 'Add a suffix to every line — or remove it if every line already has it',
    author: 'Cade',
    icon: '◀',
    tags: 'suffix,append,end,semicolon,comma,lines,toggle,restructure,code'
  }, suffixMain, [suffixLines]);
})();
