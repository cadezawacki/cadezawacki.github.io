/* Text Pack — reshape prose: aLtErNaTiNg case, markdown-aware hard-wrap /
   unwrap, ASCII transliteration and redaction.
   Script-pack module: one file registering 5 palette scripts.

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
    tags: 'redact,censor,black out,blackout,hide,mask,obscure,privacy,secret,classified,block'
  }, redactMain, [redact]);
})();
