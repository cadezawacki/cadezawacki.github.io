/* Layout & Format Pack — reshape how text sits on the page: one sentence per
   line (semantic line breaks) and back, boxes drawn with box-drawing
   characters (or code comment banners), ls-style columns, sorting lines by
   the dates in them, and locale-aware number formatting.
   Script-pack module: one file registering 7 palette scripts.

   Same authoring pattern as pack-text / pack-dev: every script and helper is
   a real function serialised with Function#toString. The core evaluates each
   script source in isolation (it cannot see this IIFE), so reg() concatenates
   exactly the helpers a script needs into that script's own source — nothing
   below may reference an IIFE variable from inside a serialised function. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;

  function reg(meta, main, helpers) {
    var src = '/**\n' + JSON.stringify(meta, null, 2) + '\n**/\n' + String(main);
    for (var i = 0; helpers && i < helpers.length; i++) src += '\n\n' + String(helpers[i]);
    window.Cade.registerScript(src);
  }

  var SVG = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>";
  var ICON = {
    sentences: SVG + "<path d='M3 6h12M3 12h8M3 18h14'/><path d='M19 6h.01M15 12h.01M21 18h.01'/></svg>",
    join: SVG + "<path d='M3 5h7M3 9.5h5'/><path d='M13 7.25h7'/><polyline points='17 4.25 20 7.25 17 10.25'/><path d='M3 15h18M3 20h12'/></svg>",
    box: SVG + "<rect x='2.5' y='4.5' width='19' height='15' rx='1.5'/><path d='M7 10h10M7 14h6'/></svg>",
    columns: SVG + "<rect x='3' y='3' width='18' height='18' rx='2'/><path d='M9 3v18M15 3v18'/></svg>",
    dateAsc: SVG + "<rect x='2' y='5' width='13' height='13' rx='2'/><path d='M2 9.5h13M6 3v4M11 3v4'/><path d='M19.5 6v14M16.5 17l3 3 3-3'/></svg>",
    dateDesc: SVG + "<rect x='2' y='5' width='13' height='13' rx='2'/><path d='M2 9.5h13M6 3v4M11 3v4'/><path d='M19.5 20V6M16.5 9l3-3 3 3'/></svg>",
    numbers: "<svg viewBox='0 0 24 24'><text x='12' y='16.5' text-anchor='middle' font-size='11' font-weight='700' font-family='ui-monospace,Menlo,Consolas,monospace' fill='currentColor'>1,2</text></svg>"
  };

  /* ================================================================
     Shared helpers (serialised into scripts)
     ================================================================ */

  function lpReadOnly() {
    var ed = window.Cade && window.Cade.editor;
    if (ed && ed.state && ed.state.readOnly) { showToast('Document is read-only', 'error', 2500); return true; }
    return false;
  }
  function lpHasSel() {
    var ed = window.Cade && window.Cade.editor;
    return !!(ed && ed.state && !ed.state.selection.main.empty);
  }
  function lpStoreGet(k) { try { return window.Cade.store.get(k); } catch (e) { return null; } }
  function lpStoreSet(k, v) { try { window.Cade.store.set(k, v); } catch (e) { /* prefs are best-effort */ } }

  // Display columns with tabs to the next multiple of 4 (CM6 default) — used
  // for indentation, where everything is ASCII.
  function lpCols(s) {
    var chars = Array.from(s), w = 0;
    for (var i = 0; i < chars.length; i++) w += chars[i] === '\t' ? 4 - (w % 4) : 1;
    return w;
  }

  function lpExpandTabs(line) {
    if (line.indexOf('\t') < 0) return line;
    var out = '', w = 0, g = lpGraphemes(line);
    for (var i = 0; i < g.length; i++) {
      if (g[i] === '\t') { var n = 4 - (w % 4); out += '    '.slice(0, n); w += n; }
      else { out += g[i]; w += lpGW(g[i]); }
    }
    return out;
  }

  // Minimal grapheme clustering — enough to measure: combining marks,
  // variation selectors, ZWJ sequences, skin tones, tags, keycaps and flag
  // pairs stay with their base. (No Intl.Segmenter: identical results on
  // every engine.)
  function lpGraphemes(s) {
    var cps = Array.from(s), out = [];
    for (var i = 0; i < cps.length; i++) {
      var c = cps[i], cp = c.codePointAt(0), n = out.length, prev = n ? out[n - 1] : '';
      var glue = n > 0 && (
        /\p{M}/u.test(c) || (cp >= 0xFE00 && cp <= 0xFE0F) || cp === 0x200D || cp === 0x20E3 ||
        (cp >= 0x1F3FB && cp <= 0x1F3FF) || (cp >= 0xE0020 && cp <= 0xE007F) ||
        prev.charCodeAt(prev.length - 1) === 0x200D ||
        (cp >= 0x1F1E6 && cp <= 0x1F1FF && Array.from(prev).length === 1 && /[\u{1F1E6}-\u{1F1FF}]/u.test(prev)));
      if (glue) out[n - 1] += c; else out.push(c);
    }
    return out;
  }

  // Terminal-style cell width of one grapheme: 0 for controls / lone
  // zero-width marks, 2 for emoji presentation and East Asian Wide/Fullwidth.
  function lpGW(g) {
    var cp = g.codePointAt(0);
    if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) return 0;
    if (/^[\p{M}\u200B-\u200F\u2028-\u202E\u2060-\u2064\uFEFF]/u.test(g)) return 0;
    if (g.indexOf('\uFE0E') >= 0) return lpWide(cp) ? 2 : 1;              // text presentation
    if (g.indexOf('\uFE0F') >= 0 || /\p{Emoji_Presentation}/u.test(g) ||
        (g.indexOf('\u200D') > 0 && /\p{Extended_Pictographic}/u.test(g)) ||
        /[\u{1F1E6}-\u{1F1FF}]/u.test(g)) return 2;
    return lpWide(cp) ? 2 : 1;
  }

  function lpWide(cp) {
    return (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0x303E) || (cp >= 0x3041 && cp <= 0x33FF) ||
      (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xA000 && cp <= 0xA4CF) ||
      (cp >= 0xA960 && cp <= 0xA97F) || (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE10 && cp <= 0xFE19) || (cp >= 0xFE30 && cp <= 0xFE6F) || (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1B000 && cp <= 0x1B2FF) || (cp >= 0x1F200 && cp <= 0x1F2FF) ||
      (cp >= 0x20000 && cp <= 0x3FFFD);
  }

  function lpWidth(s) {
    var g = lpGraphemes(s), w = 0;
    for (var i = 0; i < g.length; i++) w += g[i] === '\t' ? 4 : lpGW(g[i]);
    return w;
  }

  // Leading/trailing blank lines stay outside whatever we build (a selection
  // that ends in a newline keeps it). Returns [start, end) of the content.
  function lpContentRange(lines) {
    var a = 0, b = lines.length;
    while (a < b && !lines[a].trim()) a++;
    while (b > a && !lines[b - 1].trim()) b--;
    return [a, b];
  }

  /* ---------------- Markdown-aware line model (as in pack-text) ---------------- */

  // qp + indent + marker + body === line, always.
  function lpInfo(line) {
    var q = /^[ \t]*(?:>[ \t]?)+/.exec(line);
    var qp = q ? q[0] : '';
    var rest = line.slice(qp.length);
    var indent = /^[ \t]*/.exec(rest)[0];
    var body = rest.slice(indent.length);
    var info = { qp: qp, depth: (qp.match(/>/g) || []).length, indent: indent, marker: '', body: body, kind: 'text' };
    if (!body.trim()) info.kind = 'blank';
    else if (/^(`{3,}|~{3,})/.test(body)) info.kind = 'fence';
    else if (body.charAt(0) === '|') info.kind = 'table';
    else if (/^#{1,6}(\s|$)/.test(body)) info.kind = 'heading';
    else if (/^([-*_=])(?:[ \t]*\1){2,}[ \t]*$/.test(body)) info.kind = 'rule';
    else if (/^<\/?[a-zA-Z!]/.test(body)) info.kind = 'html';
    else if (/^\[[^\]]+\]:\s/.test(body)) info.kind = 'refdef';
    else {
      var m = /^(?:[-*+\u2022]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(body);
      if (m) { info.kind = 'item'; info.marker = m[0]; info.body = body.slice(m[0].length); }
    }
    return info;
  }

  function lpFence(info, fence) {
    var run = /^(`{3,}|~{3,})/.exec(info.body);
    if (!fence) return run ? run[1] : null;
    if (run && run[1].charAt(0) === fence.charAt(0) && run[1].length >= fence.length &&
        !info.body.slice(run[1].length).trim()) return null;
    return fence;
  }

  function lpFenceAfter(text) {
    var lines = text ? text.split('\n') : [], fence = null;
    for (var i = 0; i < lines.length; i++) {
      var info = lpInfo(lines[i]);
      if (fence || info.kind === 'fence') fence = lpFence(info, fence);
    }
    return fence;
  }

  // Fence state just before the line the selection (or cursor) starts on, so
  // running on a line inside a ``` block leaves the code alone.
  function lpFenceBeforeSelection() {
    var ed = window.Cade && window.Cade.editor;
    if (!ed) return null;
    var st = ed.state, start = st.doc.lineAt(st.selection.main.from).from;
    return start > 0 ? lpFenceAfter(st.doc.sliceString(0, start)) : null;
  }

  var LINE = [lpInfo, lpCols, lpFence, lpFenceAfter, lpFenceBeforeSelection];
  var BASE = [lpReadOnly, lpHasSel, lpStoreGet, lpStoreSet];
  var WIDTH = [lpGraphemes, lpGW, lpWide, lpWidth, lpExpandTabs, lpContentRange];

  /* ================================================================
     1a. One Sentence Per Line
     ================================================================ */

  var osplMain = function main(ctx) {
    if (lpReadOnly()) return;
    var t = ctx.selection || ctx.fullText;
    var out = osplText(t, ctx.selection ? lpFenceBeforeSelection() : null);
    if (out === t) { showToast('Already one sentence per line', 'info', 2500); return; }
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // Paragraphs and list items are re-flowed (hard-wrapped continuation lines
  // joined) and then split at sentence ends. The first sentence keeps the
  // quote prefix, indent and list marker; later ones are indented to line up
  // with the text after the marker. Fences, tables, headings, rules and HTML
  // pass through untouched.
  function osplText(text, fence) {
    var lines = text.split('\n'), out = [], i = 0;
    while (i < lines.length) {
      var line = lines[i], info = lpInfo(line);
      if (fence || info.kind === 'fence') { fence = lpFence(info, fence); out.push(line); i++; continue; }
      if (info.kind !== 'text' && info.kind !== 'item') { out.push(line); i++; continue; }
      var head = info.qp + info.indent + info.marker;
      var cont = info.qp + info.indent + info.marker.replace(/[^\t]/g, ' ');
      var ind = lpCols(info.indent), body = info.body, last = info.body, j = i + 1;
      while (j < lines.length) {
        var nx = lpInfo(lines[j]);
        if (nx.kind !== 'text' || nx.depth !== info.depth || !osplWrapped(last, nx.body)) break;
        var nInd = lpCols(nx.indent);
        if (info.kind === 'item' ? nInd <= ind : nInd !== ind) break;
        body = body.replace(/[ \t]+$/, '') + ' ' + nx.body;
        last = nx.body; j++;
      }
      var trail = /[ \t]*$/.exec(body)[0];
      var sents = osplSplit(body.slice(0, body.length - trail.length));
      sents[sents.length - 1] += trail;
      out.push(head + sents[0]);
      for (var k = 1; k < sents.length; k++) out.push(cont + sents[k]);
      i = j;
    }
    return out.join('\n');
  }

  // Was `s` hard-wrapped mid-sentence (so `next` continues it)? Lines that end
  // a sentence, a colon intro or a markdown hard break never join; short
  // lines join only when the next one carries on in lowercase — so a list of
  // short notes ("TODO" / "buy milk") is left alone.
  function osplWrapped(s, next) {
    if (/( {2}|\\)$/.test(s)) return false;
    var t = s.replace(/\s+$/, '');
    if (!t) return false;
    if (/[.!?:…\u203D\u3002\uFF01\uFF1F]["'\u2019\u201D\u00BB)\]*_`\u300D\u300F]*$/.test(t)) return false;
    var w = lpCols(t);
    return /[,;\u2013—-]$/.test(t) || w >= 50 || (w >= 25 && /^\p{Ll}/u.test(next || ''));
  }

  // Split one paragraph's text into sentences.
  function osplSplit(s) {
    var m = osplMask(s), out = [], start = 0, i = 0, n = s.length;
    var TERM = /[.!?…\u203D\u3002\uFF01\uFF1F]/, CLOSE = /["'\u2019\u201D\u00BB)\]}*_\u300D\u300F\uFF09]/;
    while (i < n) {
      if (!TERM.test(m.charAt(i))) { i++; continue; }
      var j = i;
      while (j < n && TERM.test(m.charAt(j))) j++;
      var run = m.slice(i, j);
      while (j < n && CLOSE.test(m.charAt(j))) j++;
      var k = j;
      while (k < n && (m.charAt(k) === ' ' || m.charAt(k) === '\t')) k++;
      if (k >= n) break;
      var cjk = /[\u3002\uFF01\uFF1F]/.test(run);
      if ((k > j || cjk) && osplBoundary(s, m, i, run, k)) {
        out.push(s.slice(start, j));
        start = k;
      }
      i = k > j ? k : j;
    }
    out.push(s.slice(start));
    return out;
  }

  // Same-length copy of `s` with inline code, URLs, emails and link targets
  // blanked out, so their dots and ?s are never sentence ends.
  function osplMask(s) {
    var res = [/(`+)[^`]*?\1/g, /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"]*[^\s<>".,;:!?'")\]}]/gi,
      /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, /\]\([^)\s]*\)/g];
    for (var r = 0; r < res.length; r++) {
      s = s.replace(res[r], function (x) { return new Array(x.length + 1).join('x'); });
    }
    return s;
  }

  // Is the terminator run at m[i] (whose next sentence would start at k) a
  // real sentence end? Lowercase continuations never are; a lone "." after an
  // abbreviation / initial depends on the abbreviation and the next word.
  function osplBoundary(s, m, i, run, k) {
    var rest = s.slice(k);
    var lead = /^["'\u2018\u201C\u00AB(\[{*_\u00BF\u00A1\u300C\u300E]*/.exec(rest)[0];
    var c = rest.charAt(lead.length);
    if (!c) return false;
    if (/[\u3002\uFF01\uFF1F]/.test(run)) return true;
    if (/\p{Ll}/u.test(c) || /[,;:%)\]}.!?…\-\u2013—]/.test(c)) return false;
    if (run !== '.') return true;
    var b = i;
    while (b > 0 && /[\p{L}.'\u2019]/u.test(m.charAt(b - 1))) b--;
    var w = m.slice(b, i).replace(/^['\u2019.]+/, ''), lw = w.toLowerCase();
    if (!w) return true;
    var NEVER = ' mr mrs ms mx dr prof rev hon messrs mmes vs vs e.g i.e viz cf approx resp ';
    var DIGIT = ' no nos nr vol vols ch chap sec secs art arts para pp pg p fig figs eq eqs op ref refs ca est ed tel ext ' +
      'jan feb mar apr jun jul aug sep sept oct nov dec ';
    var AMBIG = ' etc inc ltd co corp llc plc jr sr esq bros st mt ft gen col lt sgt capt cmdr adm gov sen rep pres supt ' +
      'al dept univ assn mfg intl govt ave blvd rd ';
    if (NEVER.indexOf(' ' + lw + ' ') >= 0) return false;
    if (DIGIT.indexOf(' ' + lw + ' ') >= 0 && /\p{N}/u.test(c)) return false;
    if (AMBIG.indexOf(' ' + lw + ' ') >= 0 || /^\p{Lu}$/u.test(w) || /^(?:\p{L}\.)+\p{L}$/u.test(w)) {
      // "U.S. Army" / "J. R. R. Tolkien" / "Apple Inc. CEO" continue; "…in the U.S. The…" ends.
      var nw = (/^[\p{L}']+/u.exec(rest.slice(lead.length)) || [''])[0].toLowerCase();
      var STARTERS = ' the a an this that these those there here it its i we he she they you my our your his her their ' +
        'but and so then however also in on at if when while after before as for to what why how who where which ' +
        'yes no not all some each every many most one please let now today finally next first still yet although ' +
        'though because since meanwhile thus therefore instead otherwise perhaps maybe of with from by there\'s it\'s ' +
        'i\'m we\'re they\'re that\'s ';
      return STARTERS.indexOf(' ' + nw + ' ') >= 0;
    }
    return true;
  }

  /* ================================================================
     1b. Join Sentences Into Paragraphs
     ================================================================ */

  var joinMain = function main(ctx) {
    if (lpReadOnly()) return;
    var ed = window.Cade && window.Cade.editor;
    var sel = ed ? ed.state.selection.main : null;
    // No selection, cursor on a text line: the core hands us just that line,
    // which can't be joined on its own — join the paragraph around it instead.
    if (sel && sel.empty && ctx.selection) {
      var doc = ed.state.doc, n = doc.lineAt(sel.head).number - 1;
      var units = joinUnits(doc.toString().split('\n'), null), u = null;
      for (var i = 0; i < units.length; i++) if (units[i].start <= n && n <= units[i].end) { u = units[i]; break; }
      if (!u || u.start === u.end) { showToast('Nothing to join here — select text, or put the cursor in a paragraph', 'info', 3000); return; }
      ed.dispatch({ changes: { from: doc.line(u.start + 1).from, to: doc.line(u.end + 1).to, insert: u.text }, userEvent: 'input' });
      return;
    }
    var t = ctx.selection || ctx.fullText;
    var out = joinText(t, ctx.selection ? lpFenceBeforeSelection() : null);
    if (out === t) { showToast('Nothing to join', 'info', 2000); return; }
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  function joinText(text, fence) {
    var units = joinUnits(text.split('\n'), fence), out = [];
    for (var i = 0; i < units.length; i++) out.push(units[i].text);
    return out.join('\n');
  }

  // Groups lines into paragraphs {start, end, text}: a paragraph continues
  // while the next line is plain text at the same quote depth and indent; a
  // list item while lines are indented past its marker. Blank lines, fences,
  // tables, headings, rules, new list items and markdown hard breaks (two
  // trailing spaces or a backslash) end it. Unjoined lines come back as-is.
  function joinUnits(lines, fence) {
    var units = [], cur = null;
    function flush() {
      if (!cur) return;
      units.push({ start: cur.start, end: cur.end, text: cur.head + (cur.joined ? cur.body.replace(/[ \t]+$/, '') : cur.body) });
      cur = null;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], info = lpInfo(line);
      if (fence || info.kind === 'fence') {
        flush(); fence = lpFence(info, fence);
        units.push({ start: i, end: i, text: line }); continue;
      }
      if (info.kind === 'text' && cur && !cur.hard && info.depth === cur.depth &&
          (cur.item ? lpCols(info.indent) > cur.ind : lpCols(info.indent) === cur.ind)) {
        var a = cur.body.replace(/[ \t]+$/, ''), b = info.body;
        var cjk = /[\u3000-\u9FFF\uFF00-\uFFEF]$/.test(a) && /^[\u3000-\u9FFF\uFF00-\uFFEF]/.test(b);
        cur.body = a + (cjk ? '' : ' ') + b; cur.end = i; cur.joined = true;
        cur.hard = /( {2}|\\)$/.test(line);
        continue;
      }
      flush();
      if (info.kind === 'text' || info.kind === 'item') {
        cur = { start: i, end: i, depth: info.depth, ind: lpCols(info.indent), item: info.kind === 'item',
                head: info.qp + info.indent + info.marker, body: info.body, joined: false, hard: /( {2}|\\)$/.test(line) };
      } else {
        units.push({ start: i, end: i, text: line });
      }
    }
    flush();
    return units;
  }

  /* ================================================================
     2. Box It…
     ================================================================ */

  var boxMain = function main(ctx) {
    if (lpReadOnly()) return;
    var t = ctx.selection || ctx.fullText;
    if (!t.trim()) { showToast('Select some text to box', 'info', 2500); return; }
    var un = boxUnbox(t);
    if (un !== null && window.confirm('This text is already in a box.\n\nOK — remove the box\nCancel — draw a new box around it')) {
      if (ctx.selection) ctx.selection = un; else ctx.fullText = un;
      return;
    }
    var KEY = 'cade-layoutpack-box';
    var S = boxStyles(), menu = [];
    for (var i = 0; i < S.length; i++) menu.push((i + 1) + '   ' + S[i].label);
    var ans = window.prompt('Box style — type a number, optionally followed by padding (e.g. "3 2"):\n' + menu.join('\n') +
      '\n\nAdd "c" to center or "r" to right-align the lines.', lpStoreGet(KEY) || '1');
    if (ans === null) return;
    var opt = boxParse(ans);
    if (!opt) { showToast('Type a style number from 1 to ' + S.length, 'error', 2500); return; }
    lpStoreSet(KEY, ans.trim() || '1');
    var out = boxDraw(t, opt);
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // Each style is built the same way: top = tl + t×(W+2p) + tr, line =
  // l + pad + text + pad + r, bottom = bl + b×(W+2p) + br. The comment
  // banners just use multi-character pieces so every row is equally wide.
  function boxStyles() {
    return [
      { label: '┌─┐  single', tl: '┌', t: '─', tr: '┐', l: '│', r: '│', bl: '└', b: '─', br: '┘' },
      { label: '╔═╗  double', tl: '╔', t: '═', tr: '╗', l: '║', r: '║', bl: '╚', b: '═', br: '╝' },
      { label: '╭─╮  rounded', tl: '╭', t: '─', tr: '╮', l: '│', r: '│', bl: '╰', b: '─', br: '╯' },
      { label: '┏━┓  heavy', tl: '┏', t: '━', tr: '┓', l: '┃', r: '┃', bl: '┗', b: '━', br: '┛' },
      { label: '+-+  ASCII', tl: '+', t: '-', tr: '+', l: '|', r: '|', bl: '+', b: '-', br: '+' },
      { label: '/* */  C-style comment banner', tl: '/*', t: '*', tr: '*', l: ' *', r: '*', bl: ' *', b: '*', br: '/', c: true },
      { label: '#  hash comment banner', tl: '#', t: '#', tr: '#', l: '#', r: '#', bl: '#', b: '#', br: '#' },
      { label: '//  slash comment banner', tl: '//', t: '/', tr: '//', l: '//', r: '//', bl: '//', b: '/', br: '//' }
    ];
  }

  // "3" → rounded, "3 2" → padding 2, "3 2 1" → + 1 blank line above/below,
  // "c" / "r" → centre / right-align. Names work too ("double", "ascii", "#").
  function boxParse(ans) {
    var toks = ans.trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
    var NAMES = { single: 1, light: 1, thin: 1, double: 2, rounded: 3, round: 3, heavy: 4, bold: 4, thick: 4, ascii: 5, plain: 5,
      '/*': 6, '/**/': 6, '#': 7, hash: 7, '//': 8, slash: 8 };
    var o = { style: 0, pad: 1, vpad: 0, align: 'left' }, nums = [];
    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i];
      if (/^\d+$/.test(tk)) nums.push(parseInt(tk, 10));
      else if (NAMES[tk]) o.style = NAMES[tk];
      else if (tk === 'c' || tk === 'center' || tk === 'centre') o.align = 'center';
      else if (tk === 'r' || tk === 'right') o.align = 'right';
      else if (tk === 'l' || tk === 'left') o.align = 'left';
      else return null;
    }
    if (!o.style) o.style = nums.length ? nums.shift() : 1;
    if (nums.length) o.pad = Math.min(nums.shift(), 12);
    if (nums.length) o.vpad = Math.min(nums.shift(), 6);
    if (o.style < 1 || o.style > boxStyles().length) return null;
    return o;
  }

  function boxDraw(text, opt) {
    var S = boxStyles()[opt.style - 1], lines = text.split('\n'), R = lpContentRange(lines);
    var body = lines.slice(R[0], R[1]).map(lpExpandTabs), ind = Infinity, i;
    for (i = 0; i < body.length; i++) if (body[i].trim()) ind = Math.min(ind, /^ */.exec(body[i])[0].length);
    if (ind === Infinity) ind = 0;
    body = body.map(function (l) { return l.slice(ind).replace(/\s+$/, ''); });
    if (S.c) body = body.map(function (l) { return l.replace(/\*\//g, '* /'); });  // don't close the comment early
    for (i = 0; i < opt.vpad; i++) { body.unshift(''); body.push(''); }
    var widths = body.map(lpWidth), W = Math.max.apply(null, widths), p = opt.pad, pre = new Array(ind + 1).join(' ');
    function rep(ch, n) { return new Array(n + 1).join(ch); }
    var out = [pre + S.tl + rep(S.t, W + 2 * p) + S.tr];
    for (i = 0; i < body.length; i++) {
      var gap = W - widths[i], left = opt.align === 'center' ? Math.floor(gap / 2) : opt.align === 'right' ? gap : 0;
      out.push(pre + S.l + rep(' ', p + left) + body[i] + rep(' ', gap - left + p) + S.r);
    }
    out.push(pre + S.bl + rep(S.b, W + 2 * p) + S.br);
    return lines.slice(0, R[0]).concat(out, lines.slice(R[1])).join('\n');
  }

  // If `text` is a box this script could have drawn (any of the styles),
  // return it with the frame, padding and blank padding rows removed; else null.
  function boxUnbox(text) {
    var lines = text.split('\n'), R = lpContentRange(lines);
    if (R[1] - R[0] < 2) return null;
    var L = lines.slice(R[0], R[1]).map(function (l) { return l.replace(/\s+$/, ''); });
    var ind = /^[ \t]*/.exec(L[0])[0], i;
    for (i = 0; i < L.length; i++) { if (L[i].slice(0, ind.length) !== ind) return null; L[i] = L[i].slice(ind.length); }
    var FAM = [
      { top: /^[┌╔╭┏+][─═━-]*[┐╗╮┓+]$/, bot: /^[└╚╰┗+][─═━-]*[┘╝╯┛+]$/, l: /^[│║┃|]/, r: /[│║┃|]$/ },
      { top: /^\/\*\*+$/, bot: /^ ?\*+\/$/, l: /^ ?\*/, r: /\*$/ },
      { top: /^#{3,}$/, bot: /^#{3,}$/, l: /^#/, r: /#$/ },
      { top: /^\/{4,}$/, bot: /^\/{4,}$/, l: /^\/\//, r: /\/\/$/ }
    ];
    var last = L.length - 1;
    for (var f = 0; f < FAM.length; f++) {
      var F = FAM[f];
      if (!F.top.test(L[0]) || !F.bot.test(L[last])) continue;
      var inner = [], ok = true;
      for (i = 1; i < last && ok; i++) {
        var lm = F.l.exec(L[i]), rm = F.r.exec(L[i]);
        if (!lm || !rm || lm[0].length + rm[0].length > L[i].length) { ok = false; break; }
        inner.push(L[i].slice(lm[0].length, L[i].length - rm[0].length).replace(/\s+$/, ''));
      }
      if (!ok) continue;
      var a = 0, b = inner.length;
      while (a < b && !inner[a]) a++;
      while (b > a && !inner[b - 1]) b--;
      inner = inner.slice(a, b);
      var pad = Infinity;
      for (i = 0; i < inner.length; i++) if (inner[i]) pad = Math.min(pad, /^ */.exec(inner[i])[0].length);
      if (pad === Infinity) pad = 0;
      inner = inner.map(function (l) { return l ? ind + l.slice(pad) : ''; });
      return lines.slice(0, R[0]).concat(inner, lines.slice(R[1])).join('\n');
    }
    return null;
  }

  /* ================================================================
     3. Columnize List…
     ================================================================ */

  var colMain = function main(ctx) {
    if (lpReadOnly()) return;
    var t = ctx.selection || ctx.fullText;
    var P = colParse(t);
    if (!P || P.items.length < 2) { showToast('Need a list — one item per line, or comma-separated', 'info', 3000); return; }
    var KEY = 'cade-layoutpack-columns';
    var flags = colFlags(lpStoreGet(KEY) || '');
    var auto = colAuto(colItems(P, flags.keep), flags.width - lpCols(P.indent), flags.rows, flags.table);
    var ans = window.prompt('Columns — a number, or leave ' + auto + ' (fits ' + flags.width + ' characters). Add letters to change the layout:\n' +
      '  r     fill across rows (default: down the columns, like ls)\n' +
      '  t     markdown table\n' +
      (P.bullets ? '  k     keep the bullets\n' : '') +
      '  w100  fit a different width', (String(auto) + ' ' + flags.str).trim());
    if (ans === null) return;
    var f = colFlags(ans);
    if (f.bad) { showToast('Unknown option: ' + f.bad, 'error', 2500); return; }
    lpStoreSet(KEY, f.str);
    var items = colItems(P, f.keep);
    var n = f.cols || colAuto(items, f.width - lpCols(P.indent), f.rows, f.table);
    var rows = colRender(items, n, f.rows, f.table);
    var out = P.before.concat(rows.map(function (r) { return P.indent + r; }), P.after).join('\n');
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // "3 r t k w100" → { cols: 3, rows: true, table: true, keep: true, width: 100 }.
  // `str` is the remembered part (letters + width), not the column count.
  function colFlags(s) {
    var o = { cols: 0, rows: false, table: false, keep: false, width: 80, bad: '' }, toks = String(s).toLowerCase().split(/[\s,]+/);
    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i], m;
      if (!tk) continue;
      if (/^\d+$/.test(tk)) o.cols = Math.min(parseInt(tk, 10), 500);
      else if ((m = /^w(\d+)$/.exec(tk))) o.width = Math.max(10, Math.min(parseInt(m[1], 10), 1000));
      else if (/^[rtk]+$/.test(tk)) {
        if (tk.indexOf('r') >= 0) o.rows = true;
        if (tk.indexOf('t') >= 0) o.table = true;
        if (tk.indexOf('k') >= 0) o.keep = true;
      } else if (!o.bad) o.bad = tk;
    }
    o.str = [o.rows ? 'r' : '', o.table ? 't' : '', o.keep ? 'k' : '', o.width !== 80 ? 'w' + o.width : ''].filter(Boolean).join(' ');
    return o;
  }

  // Items are the non-blank lines; a single line is split on tabs, then
  // semicolons, then commas, then spaces. Bullets count only when every item
  // has one.
  function colParse(text) {
    var lines = text.split('\n'), R = lpContentRange(lines);
    if (R[0] === R[1]) return null;
    var mid = lines.slice(R[0], R[1]).filter(function (l) { return l.trim(); }), items;
    var indent = /^[ \t]*/.exec(mid[0])[0];
    for (var i = 1; i < mid.length; i++) {
      var ws = /^[ \t]*/.exec(mid[i])[0], k = 0;
      while (k < indent.length && k < ws.length && indent.charAt(k) === ws.charAt(k)) k++;
      indent = indent.slice(0, k);
    }
    if (mid.length >= 2) items = mid.map(function (l) { return l.trim().replace(/\t/g, '    '); });
    else {
      var one = mid[0].trim();
      var sep = one.indexOf('\t') >= 0 ? /\t+/ : one.indexOf(';') >= 0 ? /\s*;\s*/ : one.indexOf(',') >= 0 ? /\s*,\s*/ : /\s+/;
      items = one.split(sep).filter(Boolean);
      if (items.length > 2 && sep.source.indexOf(',') >= 0) items[items.length - 1] = items[items.length - 1].replace(/^(?:and|or|&)\s+/i, '');
    }
    var BUL = /^(?:[-*+\u2022\u25E6\u25AA\u2023\u00B7\u2013]|\d{1,9}[.)]|[a-zA-Z][.)])\s+(?:\[[ xX]\]\s+)?/;
    var bullets = items.every(function (it) { return BUL.test(it); });
    return { items: items, indent: indent, bullets: bullets, before: lines.slice(0, R[0]), after: lines.slice(R[1]) };
  }

  function colItems(P, keep) {
    if (!P.bullets || keep) return P.items.slice();
    return P.items.map(function (it) { return it.replace(/^(?:[-*+\u2022\u25E6\u25AA\u2023\u00B7\u2013]|\d{1,9}[.)]|[a-zA-Z][.)])\s+(?:\[[ xX]\]\s+)?/, ''); });
  }

  // Column-major (like ls): fill down, rows = ceil(n / cols) — which may need
  // fewer columns than asked for. Row-major: fill across.
  function colGrid(items, cols, rowMajor) {
    var n = items.length, c = Math.max(1, Math.min(cols, n)), rows = Math.ceil(n / c);
    if (!rowMajor) c = Math.ceil(n / rows);
    var grid = [], widths = [], r, j;
    for (j = 0; j < c; j++) widths.push(0);
    for (r = 0; r < rows; r++) {
      var row = [];
      for (j = 0; j < c; j++) {
        var idx = rowMajor ? r * c + j : j * rows + r;
        var it = idx < n ? items[idx] : null;
        row.push(it);
        if (it !== null) widths[j] = Math.max(widths[j], lpWidth(it));
      }
      grid.push(row);
    }
    return { grid: grid, widths: widths };
  }

  // Most columns that still fit `maxW` display cells (what ls does).
  function colAuto(items, maxW, rowMajor, table) {
    for (var c = items.length; c > 1; c--) {
      var g = colGrid(table ? items.map(colCell) : items, c, rowMajor), total = 0;
      for (var j = 0; j < g.widths.length; j++) total += table ? Math.max(3, g.widths[j]) + 3 : g.widths[j] + (j ? 2 : 0);
      if (table) total += 1;
      if (total <= maxW) return g.widths.length;
    }
    return 1;
  }

  function colCell(s) { return s.replace(/\|/g, '\\|'); }

  function colRender(items, cols, rowMajor, table) {
    function pad(s, w) { return s + new Array(Math.max(0, w - lpWidth(s)) + 1).join(' '); }
    if (table) {
      var g = colGrid(items.map(colCell), cols, rowMajor), W = g.widths.map(function (w) { return Math.max(3, w); });
      var head = '|' + W.map(function (w) { return new Array(w + 3).join(' '); }).join('|') + '|';
      var sep = '|' + W.map(function (w) { return new Array(w + 3).join('-'); }).join('|') + '|';
      return [head, sep].concat(g.grid.map(function (row) {
        return '| ' + row.map(function (c, j) { return pad(c === null ? '' : c, W[j]); }).join(' | ') + ' |';
      }));
    }
    var G = colGrid(items, cols, rowMajor);
    return G.grid.map(function (row) {
      var s = '';
      for (var j = 0; j < row.length; j++) {
        if (row[j] === null) continue;
        s += j < row.length - 1 ? pad(row[j], G.widths[j] + 2) : row[j];
      }
      return s.replace(/\s+$/, '');
    });
  }

  /* ================================================================
     4. Sort Lines by Date (oldest / newest first)
     ================================================================ */

  var sdAscMain = function main(ctx) { sdRun(ctx, false); };
  var sdDescMain = function main(ctx) { sdRun(ctx, true); };

  // Explicit selection → those lines; otherwise the whole document (sorting
  // the single line the core would hand us is pointless).
  function sdRun(ctx, desc) {
    if (lpReadOnly()) return;
    var whole = !lpHasSel(), t = whole ? ctx.fullText : ctx.selection;
    var res = sdSort(t, desc, function () {
      var KEY = 'cade-layoutpack-datefmt', lang = (window.navigator && window.navigator.language) || 'en-US';
      var def = lpStoreGet(KEY) || (/^en-US|^en$|-(US|PH|CA)$/i.test(lang) ? '1' : '2');
      var a = window.prompt('Dates like 03/04/2026 — which way round?\n1  month first: March 4 (US)\n2  day first: 3 April (Europe & most of the world)', def);
      if (a === null) return null;
      a = a.trim().toLowerCase();
      var v = /^(2|eu|d|dmy|day)/.test(a) ? 'eu' : 'us';
      lpStoreSet(KEY, v === 'eu' ? '2' : '1');
      return v;
    });
    if (res === null) return;
    if (!res.dated) { showToast('No dates found to sort by', 'info', 2500); return; }
    if (res.text !== t) { if (whole) ctx.fullText = res.text; else ctx.selection = res.text; }
    showToast('Sorted ' + res.dated + ' dated ' + (res.blocks ? 'block' : 'line') + (res.dated === 1 ? '' : 's') +
      (res.undated ? ' \u00B7 ' + res.undated + ' without a date moved to the end' : ''), 'success', 3000);
  }

  // Returns { text, dated, undated, blocks } or null if the user cancelled.
  // Records are lines plus their more-indented continuation lines. When the
  // text is made of blank-line-separated blocks headed by a date (a journal),
  // whole blocks are sorted instead.
  function sdSort(text, desc, ask) {
    var body = text.replace(/\n+$/, ''), tail = text.slice(body.length);
    var lines = body.split('\n'), found = lines.map(function (l) { return sdFind(l); });
    var conv = sdConvention(found, ask);
    if (conv === null) return null;
    function recs(from, to) {
      var out = [], cur = null;
      for (var i = from; i < to; i++) {
        var ind = lpCols(/^[ \t]*/.exec(lines[i])[0]);
        if (!lines[i].trim()) { cur = null; out.push({ s: i, e: i + 1, blank: true }); continue; }
        if (cur && ind > cur.ind) { cur.e = i + 1; continue; }
        cur = { s: i, e: i + 1, ind: ind };
        out.push(cur);
      }
      out.forEach(function (r) {
        r.key = null;
        for (var k = r.s; k < r.e && r.key === null; k++) r.key = sdKey(found[k], conv);
      });
      return out;
    }
    var blocks = [], b = null, i;
    for (i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) { b = null; continue; }
      if (!b) { b = { s: i, e: i + 1 }; blocks.push(b); } else b.e = i + 1;
    }
    var useBlocks = false;
    if (blocks.length >= 2) {
      var headed = 0, shapeOk = true, allDated = true;
      blocks.forEach(function (bl) {
        var R = recs(bl.s, bl.e), dated = R.filter(function (r) { return r.key !== null; });
        if (dated.length < R.length) allDated = false;
        if (R[0].key !== null) headed++;
        else if (dated.length) shapeOk = false;
        bl.key = R[0].key;
      });
      useBlocks = headed >= 2 && shapeOk && !allDated;
    }
    var units;
    if (useBlocks) units = blocks.map(function (bl) { return { text: lines.slice(bl.s, bl.e).join('\n'), key: bl.key }; });
    else units = recs(0, lines.length).map(function (r) { return { text: lines.slice(r.s, r.e).join('\n'), key: r.key, blank: r.blank }; });
    var withKey = [], without = [];
    units.forEach(function (u, idx) { u.idx = idx; (u.key !== null ? withKey : without).push(u); });
    withKey.sort(function (x, y) { return (desc ? y.key - x.key : x.key - y.key) || x.idx - y.idx; });
    // Blank separator lines (line mode) trail everything else.
    var undated = without.filter(function (u) { return !u.blank; }), blanks = without.filter(function (u) { return u.blank; });
    var all = withKey.concat(undated, blanks);
    var out = all.map(function (u) { return u.text; }).join(useBlocks ? '\n\n' : '\n');
    return { text: out + tail, dated: withKey.length, undated: undated.length, blocks: useBlocks };
  }

  // Numeric dates like 03/04/2026: if the text itself settles it (some date
  // has a part > 12), follow that; otherwise ask once. Dotted dates
  // (13.10.2026) are always day-first.
  function sdConvention(found, ask) {
    var us = 0, eu = 0, amb = 0;
    for (var i = 0; i < found.length; i++) {
      var f = found[i];
      if (!f || f.kind !== 'num' || f.dot) continue;
      if (f.a > 12 && f.b <= 12) eu++;
      else if (f.b > 12 && f.a <= 12) us++;
      else if (f.a <= 12 && f.b <= 12 && f.a !== f.b) amb++;
    }
    if (!amb) return eu > us ? 'eu' : 'us';
    if (us && !eu) return 'us';
    if (eu && !us) return 'eu';
    return ask();
  }

  function sdValid(y, m, d) {
    if (!(m >= 1 && m <= 12 && d >= 1)) return false;
    var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  }

  // Sortable number for a found date (null if none): yyyymmdd + minutes.
  function sdKey(f, conv) {
    if (!f) return null;
    var y = f.y, m = f.m, d = f.d;
    if (f.kind === 'num') {
      var dayFirst = f.dot || conv === 'eu';
      m = dayFirst ? f.b : f.a; d = dayFirst ? f.a : f.b;
      if (!sdValid(y, m, d)) { var t = m; m = d; d = t; }
      if (!sdValid(y, m, d)) return null;
    }
    if (y == null) y = new Date().getFullYear();
    return ((y * 100 + m) * 100 + d) * 10000 + (f.t == null ? 0 : f.t + 1);
  }

  // First date in `s` (ISO, numeric, month names — weekday names are simply
  // skipped over) plus the first time of day on the line as a tiebreak.
  function sdFind(s) {
    var best = null, m, re;
    function edge(i, e) {
      var p = s.charAt(i - 1), n = s.charAt(e);
      if (/\d/.test(p) || /\d/.test(n)) return false;
      if (/[.\/-]/.test(p) && /\d/.test(s.charAt(i - 2))) return false;
      if (/[.\/-]/.test(n) && /\d/.test(s.charAt(e + 1))) return false;
      return true;
    }
    function take(r) { if (!best || r.i < best.i || (r.i === best.i && r.e > best.e)) best = r; }
    re = /(\d{4})([-\/.])(\d{1,2})\2(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?/g;
    while ((m = re.exec(s))) {
      if (!edge(m.index, m.index + m[0].length) || !sdValid(+m[1], +m[3], +m[4])) continue;
      take({ i: m.index, e: m.index + m[0].length, kind: 'iso', y: +m[1], m: +m[3], d: +m[4],
             t: m[5] != null && +m[5] < 24 && +m[6] < 60 ? +m[5] * 60 + +m[6] : null });
    }
    re = /(\d{1,2})([-\/.])(\d{1,2})\2(\d{4}|\d{2})/g;
    while ((m = re.exec(s))) {
      if (!edge(m.index, m.index + m[0].length)) continue;
      var a = +m[1], b = +m[3], y = m[4].length === 2 ? (+m[4] < 70 ? 2000 : 1900) + +m[4] : +m[4];
      if (!sdValid(y, a, b) && !sdValid(y, b, a)) continue;
      take({ i: m.index, e: m.index + m[0].length, kind: 'num', a: a, b: b, y: y, dot: m[2] === '.' });
    }
    var MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![a-z])\\.?';
    var forms = [
      [new RegExp('\\b' + MON + '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?', 'gi'), 1, 2, 3],
      [new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MON + '(?:,?\\s+(\\d{4})\\b)?', 'gi'), 2, 1, 3],
      [new RegExp('\\b' + MON + ',?\\s+(\\d{4})\\b', 'gi'), 1, 0, 2]
    ];
    for (var f = 0; f < forms.length; f++) {
      re = forms[f][0];
      while ((m = re.exec(s))) {
        var mt = m[forms[f][1]];
        if (/^(may|mar|march)$/.test(mt)) continue;          // the words "may" / "mar", not months
        var mo = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(mt.slice(0, 3).toLowerCase()) + 1;
        var d = forms[f][2] ? +m[forms[f][2]] : 1, yr = m[forms[f][3]] ? +m[forms[f][3]] : null;
        if (/\d/.test(s.charAt(m.index - 1)) || !sdValid(yr || 2000, mo, d)) continue;
        take({ i: m.index, e: m.index + m[0].length, kind: 'name', y: yr, m: mo, d: d });
      }
    }
    if (best && best.t == null) best.t = sdTime(s, best);
    return best;
  }

  // Minutes after midnight of the first clock time on the line outside the
  // date itself ("3:30 pm", "15:30", "3pm", "noon"), or null.
  function sdTime(s, date) {
    var res = [/(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap])\.?m\.?(?![a-z]))?/gi, /(\d{1,2})()\s*([ap])\.?m\.?(?![a-z])/gi, /\b(noon|midnight)\b()()/gi];
    var best = null, m;
    for (var r = 0; r < res.length; r++) {
      while ((m = res[r].exec(s))) {
        var i = m.index, e = i + m[0].length;
        if (date && i < date.e && e > date.i) continue;
        if (/[\d:.]/.test(s.charAt(i - 1)) || /\d/.test(s.charAt(e))) continue;
        var h, mi = m[2] ? +m[2] : 0;
        if (/^noon$/i.test(m[1])) h = 12; else if (/^midnight$/i.test(m[1])) h = 0;
        else {
          h = +m[1];
          if (m[3]) { if (h < 1 || h > 12) continue; h = h % 12 + (/p/i.test(m[3]) ? 12 : 0); }
          if (h > 23 || mi > 59) continue;
        }
        if (!best || i < best.i) best = { i: i, t: h * 60 + mi };
      }
    }
    return best ? best.t : null;
  }

  /* ================================================================
     5. Format Numbers…
     ================================================================ */

  var fnMain = function main(ctx) {
    if (lpReadOnly()) return;
    var t = ctx.selection || ctx.fullText;
    var cands = fnFind(t);
    if (!cands.length) { showToast('No numbers found to format', 'info', 2500); return; }
    var KEY = 'cade-layoutpack-numfmt', KEYCUR = 'cade-layoutpack-numcur', NB = '\u202F';
    var ans = window.prompt('Format numbers as — type a number, optionally + fixed decimals (e.g. "1 2"):\n' +
      '1   1,234,567.89   US / UK (en-US)\n' +
      '2   1.234.567,89   German (de-DE)\n' +
      '3   1' + NB + '234' + NB + '567,89   French (fr-FR)\n' +
      '4   12,34,567.89   Indian (en-IN)\n' +
      "5   1'234'567.89   Swiss\n" +
      '6   $1,234.57      currency (USD, EUR, GBP, JPY, INR…)\n' +
      '7   12.5%          percent\n' +
      '8   1.2M           compact\n' +
      '9   1234567.89     strip formatting\n\n' +
      'Or type a locale (es-ES) or a currency code (EUR).', lpStoreGet(KEY) || '1');
    if (ans === null) return;
    var opt = fnOptions(ans);
    if (!opt) { showToast('Not a format choice: ' + ans, 'error', 3000); return; }
    if (opt.mode === 'currency' && !opt.currency) {
      var c = window.prompt('Currency — USD, EUR, GBP, JPY, INR (any ISO code), optionally with a locale, e.g. "EUR fr-FR":', lpStoreGet(KEYCUR) || 'USD');
      if (c === null) return;
      var co = fnOptions(c);
      if (!co || !co.currency) { showToast('Not a currency code: ' + c, 'error', 3000); return; }
      opt.currency = co.currency;
      if (co.locale) opt.locale = co.locale;
      lpStoreSet(KEYCUR, c.trim());
    }
    var out;
    try { out = fnApply(t, cands, opt, (window.navigator && window.navigator.language) || 'en-US'); }
    catch (e) { showToast('Could not format: ' + (e && e.message ? e.message : e), 'error', 4000); return; }
    lpStoreSet(KEY, ans.trim());
    if (out.text === t) { showToast('Numbers already in that format', 'info', 2500); return; }
    if (ctx.selection) ctx.selection = out.text; else ctx.fullText = out.text;
    showToast('Formatted ' + out.count + ' number' + (out.count === 1 ? '' : 's'), 'success', 2500);
  };

  // "1 2" → en-US with 2 decimals; "EUR", "€", "eur fr-FR", "%", "compact",
  // "strip", or a bare locale ("es-ES" → Intl grouping for that locale).
  function fnOptions(ans) {
    var toks = String(ans).trim().split(/[\s,]+/).filter(Boolean);
    var MENU = [null, 'en', 'de', 'fr', 'in', 'ch', 'currency', 'percent', 'compact', 'strip'];
    var STY = { us: 'en', en: 'en', 'en-us': 'en', uk: 'en', 'en-gb': 'en', de: 'de', 'de-de': 'de', german: 'de',
      fr: 'fr', 'fr-fr': 'fr', french: 'fr', 'in': 'in', 'en-in': 'in', indian: 'in', india: 'in',
      ch: 'ch', swiss: 'ch', 'de-ch': 'ch' };
    var SYM = { '$': 'USD', 'us$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };
    var o = { mode: null, dec: null, locale: null, currency: null };
    if (!toks.length) return null;
    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i], lw = tk.toLowerCase();
      if (/^\d$/.test(tk) && o.mode === null && i === 0 && +tk >= 1) o.mode = MENU[+tk];
      else if (/^\d{1,2}$/.test(tk)) o.dec = Math.min(+tk, 20);
      else if (SYM[lw]) { o.mode = 'currency'; o.currency = SYM[lw]; }
      else if (/^[a-z]{3}$/i.test(tk) && lw !== 'pct' && lw !== 'raw') { o.mode = 'currency'; o.currency = tk.toUpperCase(); }
      else if (lw === '%' || lw === 'percent' || lw === 'pct') o.mode = 'percent';
      else if (lw === 'compact' || lw === 'short' || lw === 'k') o.mode = 'compact';
      else if (lw === 'strip' || lw === 'plain' || lw === 'raw' || lw === 'none') o.mode = 'strip';
      else if (lw === 'currency' || lw === 'money') o.mode = 'currency';
      else if (STY[lw] && !o.currency) o.mode = STY[lw];
      else if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})+$/i.test(tk) || /^[a-z]{2}$/i.test(tk)) o.locale = tk;
      else return null;
    }
    if (o.mode === null && o.locale) o.mode = 'intl';
    if (o.mode === null) return null;
    if (o.currency && !/^[A-Z]{3}$/.test(o.currency)) return null;
    return o;
  }

  // Candidate numbers in `text`: {s, e, sign, int, frac, ...}. Each one's
  // decimal separator is worked out on its own (a lone "1,234" / "1.234" is
  // settled by the other numbers in the text, else English rules). Dates,
  // times, versions, IPs, phone numbers, hex, URLs, numbers glued to words
  // and bare years are left alone.
  function fnFind(text) {
    var prot = fnProtect(text), out = [], m;
    var re = /(\d{1,3}([,.'\u2019\u00A0\u202F\u2009 ])\d{3}(?:\2\d{3})*|\d{1,2}(?:,\d{2})+,\d{3}|\d+)(?:([.,])(\d+))?/g;
    function runEnd(i) { while (i < text.length && /[\d.,'\u2019]/.test(text.charAt(i))) i++; return i; }
    while ((m = re.exec(text))) {
      var s = m.index, e = s + m[0].length, intRaw = m[1], gsep = m[2] || (/,/.test(m[1]) ? ',' : ''), dsep = m[3] || '', frac = m[4] || '';
      if (gsep === ' ' && intRaw.split(' ').length < 3 && dsep !== ',') {
        // "in 12 100 cases" is two numbers; plain spaces group only "1 234 567" / "1 234,5".
        intRaw = /^\d+/.exec(intRaw)[0]; e = s + intRaw.length; gsep = ''; dsep = ''; frac = '';
        re.lastIndex = e;
      }
      if (gsep && gsep === dsep) { re.lastIndex = runEnd(e); continue; }
      var sign = '', ss = s, pc = text.charAt(s - 1);
      if ((pc === '-' || pc === '\u2212' || pc === '+') && !/[\p{L}\p{N}_)\]]/u.test(text.charAt(s - 2))) { sign = pc; ss = s - 1; }
      var before = text.charAt(ss - 1), after = text.charAt(e), after2 = text.charAt(e + 1);
      var bad = /[\p{L}\p{N}_#@\/\\.]/u.test(before) || (before === ',' && /\d/.test(text.charAt(ss - 2))) ||
        /[\p{N}_@\/\\]/u.test(after) || (/[.,:\-\/]/.test(after) && /\d/.test(after2)) ||
        (/\p{L}/u.test(after) && /\p{N}/u.test(after2));
      for (var q = s; q < e && !bad; q++) if (prot[q]) bad = true;
      if (!bad && intRaw.length > 1 && intRaw.charAt(0) === '0' && !gsep) bad = true;           // 007, 0123: ids
      if (!bad && !gsep && !dsep && intRaw.length === 4 && +intRaw >= 1900 && +intRaw <= 2100) bad = true;   // a year
      if (bad) { if (e < runEnd(e) || /[.,]/.test(after)) re.lastIndex = runEnd(e); continue; }
      var c = { s: ss, e: e, sign: sign, intRaw: intRaw, gsep: gsep, dsep: dsep, frac: frac, amb: false };
      // "0.123" / "0,123": a group can't start with 0, so that's a decimal.
      if (gsep && (gsep === ',' || gsep === '.') && !dsep && intRaw.split(gsep).length === 2) {
        if (intRaw.charAt(0) === '0' && intRaw.indexOf(gsep) === 1) { c.dsep = gsep; c.frac = intRaw.slice(2); c.intRaw = '0'; c.gsep = ''; }
        else c.amb = true;
      }
      out.push(c);
    }
    var dot = 0, comma = 0;
    out.forEach(function (c) {
      if (c.amb) return;
      if (c.gsep === ',' || c.dsep === '.') dot++;
      if (c.gsep === '.' || c.dsep === ',') comma++;
    });
    var dec = comma > dot ? ',' : '.';
    out.forEach(function (c) {
      if (c.amb && c.gsep === dec) { var p = c.intRaw.split(dec); c.intRaw = p[0]; c.frac = p[1]; c.dsep = dec; c.gsep = ''; }
      c.int = c.intRaw.replace(/\D/g, '');
      var pm = /^[ \u00A0\u202F]?%/.exec(text.slice(c.e));
      c.pct = pm ? pm[0].length : 0;
      var cb = /(?:US\$|[$€£¥₹]|\b(?:USD|EUR|GBP|JPY|INR|CHF|CAD|AUD)\b)[ \u00A0]?$/.exec(text.slice(Math.max(0, c.s - 5), c.s));
      c.curB = cb ? cb[0].length : 0;
      var ca = /^[ \u00A0\u202F]?(?:[€£¥₹$]|(?:USD|EUR|GBP|JPY|INR|CHF|CAD|AUD)\b)/.exec(text.slice(c.e));
      c.curA = ca ? ca[0].length : 0;
    });
    return out;
  }

  // Character mask of spans that must not be read as numbers.
  function fnProtect(text) {
    var prot = new Uint8Array(text.length + 1);
    function mark(a, b) { for (var i = a; i < b; i++) prot[i] = 1; }
    function each(re, test) {
      var m;
      while ((m = re.exec(text))) { if (!test || test(m[0])) mark(m.index, m.index + m[0].length); if (!m[0].length) re.lastIndex++; }
    }
    each(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"]+/gi);                         // URLs
    each(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g);                                          // emails
    each(/\d+(?:[-\/]\d+)+/g);                                                     // dates, phones, ranges, fractions
    each(/\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?/g);                                  // times
    each(/\b0[xob][0-9a-f]+\b|#[0-9a-f]{3,8}\b/gi);                                 // hex / binary / colours
    each(/\+\d[\d ().-]{6,}\d/g);                                                   // +44 20 7946 0958
    each(/\(\d{1,4}\)[ .]?\d{2,4}[ .-]\d{2,4}/g);                                   // (555) 123 4567
    // 1.2.3 versions, 192.168.0.1 IPs, 13.10.2026 dates — but not 1.234.567 grouping
    each(/\d+(?:\.\d+){2,}/g, function (x) {
      var p = x.split('.');
      if (p.length === 4 && p.every(function (g) { return +g <= 255; })) return true;
      return !(p[0].length <= 3 && p.slice(1).every(function (g) { return g.length === 3; }));
    });
    each(/\d+(?:,\d+){2,}/g, function (x) {                                         // 1,2,3 lists (not grouping)
      return !/^\d{1,3}(?:,\d{3})+$/.test(x) && !/^\d{1,2}(?:,\d{2})+,\d{3}$/.test(x);
    });
    each(/\d{2,5}(?:[ .]\d{2,5}){2,}/g, function (x) {                              // 555 123 4567 phone-ish runs
      var p = x.split(/[ .]/);
      return !(p[0].length <= 3 && p.slice(1).every(function (g) { return g.length === 3; }));
    });
    return prot;
  }

  // Round a decimal digit string half away from zero (what Intl does).
  function fnRound(int, frac, dec) {
    if (dec == null) return { int: int, frac: frac };
    if (frac.length <= dec) return { int: int, frac: frac + new Array(dec - frac.length + 1).join('0') };
    var digits = (int + frac.slice(0, dec)).split(''), up = frac.charAt(dec) >= '5';
    for (var i = digits.length - 1; up && i >= 0; i--) {
      if (digits[i] === '9') digits[i] = '0'; else { digits[i] = String(+digits[i] + 1); up = false; }
    }
    var all = (up ? '1' : '') + digits.join('');
    var ip = all.slice(0, all.length - dec).replace(/^0+(?=\d)/, '');
    return { int: ip || '0', frac: all.slice(all.length - dec) };
  }

  // Group the integer digits: 3s, or Indian 3-then-2s.
  function fnGroup(int, sep, indian) {
    if (int.length <= 3) return int;
    var head = int.slice(0, -3), tail = int.slice(-3), n = indian ? 2 : 3, parts = [];
    while (head.length > n) { parts.unshift(head.slice(-n)); head = head.slice(0, -n); }
    if (head) parts.unshift(head);
    return parts.concat(tail).join(sep);
  }

  function fnNumber(c) { return Number((c.sign === '-' || c.sign === '\u2212' ? '-' : '') + c.int + (c.frac ? '.' + c.frac : '')); }

  function fnCompact(v, loc, dec) {
    var o = { notation: 'compact', maximumFractionDigits: dec == null ? 1 : dec };
    try {
      var f = new Intl.NumberFormat(loc, o);
      if (f.resolvedOptions().notation === 'compact') return f.format(v);
    } catch (e) { /* old engine: fall through */ }
    var a = Math.abs(v), U = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (var i = 0; i < U.length; i++) {
      if (a >= U[i][0]) return new Intl.NumberFormat(loc, { maximumFractionDigits: o.maximumFractionDigits }).format(v / U[i][0]) + U[i][1];
    }
    return new Intl.NumberFormat(loc, { maximumFractionDigits: o.maximumFractionDigits }).format(v);
  }

  // Rewrite every candidate (back to front). Returns { text, count }.
  function fnApply(text, cands, opt, navLang) {
    var STY = { en: [',', '.'], de: ['.', ','], fr: ['\u202F', ','], 'in': [',', '.'], ch: ["'", '.'] };
    var CURLOC = { USD: 'en-US', EUR: 'de-DE', GBP: 'en-GB', JPY: 'ja-JP', INR: 'en-IN', CHF: 'de-CH', CAD: 'en-CA', AUD: 'en-AU', CNY: 'zh-CN' };
    var LOC = { en: 'en-US', de: 'de-DE', fr: 'fr-FR', 'in': 'en-IN', ch: 'de-CH' };
    var loc = opt.locale ? (LOC[opt.locale.toLowerCase()] || opt.locale) : null;
    if (opt.mode === 'currency') loc = loc || CURLOC[opt.currency] || navLang;
    loc = loc || navLang || 'en-US';
    // Percent: plain numbers are fractions (0.25 → 25%) only if every one of them is ≤ 1.
    var fractions = opt.mode === 'percent' && cands.every(function (c) { return c.pct || Math.abs(fnNumber(c)) <= 1; });
    var fmtCache = {};
    function nf(o) { var k = JSON.stringify(o); return fmtCache[k] || (fmtCache[k] = new Intl.NumberFormat(loc, o)); }
    var res = text, count = 0;
    for (var i = cands.length - 1; i >= 0; i--) {
      var c = cands[i], s = c.s, e = c.e, str;
      var neg = c.sign === '-' || c.sign === '\u2212';
      if (STY[opt.mode]) {
        var r = fnRound(c.int, c.frac, opt.dec), sy = STY[opt.mode];
        str = c.sign + fnGroup(r.int, sy[0], opt.mode === 'in') + (r.frac ? sy[1] + r.frac : '');
      } else if (opt.mode === 'strip') {
        var r2 = fnRound(c.int, c.frac, opt.dec);
        str = c.sign + r2.int + (r2.frac ? '.' + r2.frac : '');
      } else if (opt.mode === 'intl') {
        var fd = opt.dec != null ? opt.dec : Math.min(c.frac.length, 20);
        str = nf({ minimumFractionDigits: fd, maximumFractionDigits: fd }).format(fnNumber(c));
        if (c.sign === '+') str = '+' + str;
      } else if (opt.mode === 'currency') {
        var co = { style: 'currency', currency: opt.currency };
        if (opt.dec != null) { co.minimumFractionDigits = opt.dec; co.maximumFractionDigits = opt.dec; }
        str = nf(co).format(fnNumber(c));
        s -= c.curB; e += c.curA;
      } else if (opt.mode === 'percent') {
        var v = fnNumber(c), keep = c.pct || !fractions;
        if (keep) v /= 100;
        var mx = opt.dec != null ? opt.dec : Math.max(0, Math.min(20, c.frac.length - (keep ? 0 : 2)));
        str = nf({ style: 'percent', minimumFractionDigits: opt.dec != null ? opt.dec : 0, maximumFractionDigits: mx }).format(v);
        e += c.pct;
      } else if (opt.mode === 'compact') {
        str = fnCompact(fnNumber(c), loc, opt.dec);
      } else continue;
      if (neg && opt.mode !== 'strip' && !STY[opt.mode] && c.sign === '\u2212') str = str.replace('-', '\u2212');
      if (res.slice(s, e) !== str) count++;
      res = res.slice(0, s) + str + res.slice(e);
    }
    return { text: res, count: count };
  }

  /* ================================================================
     Registration
     ================================================================ */

  var OSPL = [osplText, osplWrapped, osplSplit, osplMask, osplBoundary];
  var FN = [fnOptions, fnFind, fnProtect, fnRound, fnGroup, fnNumber, fnCompact, fnApply];

  reg({
    name: 'One Sentence Per Line',
    description: 'Semantic line breaks — put each sentence on its own line (knows Dr., e.g., U.S., 3.14, URLs…; keeps list markers & quotes; skips code/tables/headings)',
    author: 'Cade', icon: ICON.sentences,
    tags: 'sentence,sentences,per line,semantic line breaks,sembr,ventilated prose,split,line break,prose,markdown,diff,git,writing,one per line'
  }, osplMain, BASE.concat(LINE, OSPL));

  reg({
    name: 'Join Sentences Into Paragraphs',
    description: 'Reverse of One Sentence Per Line — rejoin sentence lines into paragraphs (keeps blank lines, list items, quotes, hard breaks and code apart)',
    author: 'Cade', icon: ICON.join,
    tags: 'join,sentences,paragraph,paragraphs,merge,lines,unsplit,reflow,semantic line breaks,sembr,prose,markdown'
  }, joinMain, BASE.concat(LINE, [joinText, joinUnits]));

  reg({
    name: 'Box It…',
    description: 'Draw a box around the selection — single ┌─┐, double ╔═╗, rounded ╭─╮, heavy ┏━┓, ASCII +-+ or a /* # // comment banner (run again to unbox)',
    author: 'Cade', icon: ICON.box,
    tags: 'box,frame,border,box drawing,ascii art,banner,comment,header,unbox,callout,rounded,double,heavy,emoji,cjk,outline'
  }, boxMain, BASE.concat(WIDTH, [boxStyles, boxParse, boxDraw, boxUnbox]));

  reg({
    name: 'Columnize List…',
    description: 'Lay a list (one per line or comma-separated) out in N aligned columns like ls — down or across, plain or as a markdown table',
    author: 'Cade', icon: ICON.columns,
    tags: 'columns,columnize,column,list,grid,ls,layout,align,table,markdown table,compact,multi column,format,bullets'
  }, colMain, BASE.concat(WIDTH, [lpCols, colFlags, colParse, colItems, colGrid, colAuto, colCell, colRender]));

  var SD = [lpCols, sdRun, sdSort, sdConvention, sdValid, sdKey, sdFind, sdTime];
  reg({
    name: 'Sort Lines by Date',
    description: 'Sort lines (or dated blocks) oldest first by the first date in each — 2026-10-13, 10/13/2026, Oct 13 2026, 13 Oct… — time of day breaks ties',
    author: 'Cade', icon: ICON.dateAsc,
    tags: 'sort,date,dates,chronological,oldest,ascending,lines,timeline,log,journal,calendar,order,time'
  }, sdAscMain, BASE.concat(SD));

  reg({
    name: 'Sort Lines by Date (newest first)',
    description: 'Sort lines (or dated blocks) newest first by the first date in each; lines without a date go to the end',
    author: 'Cade', icon: ICON.dateDesc,
    tags: 'sort,date,dates,newest,latest,descending,reverse chronological,lines,log,journal,calendar,order,time'
  }, sdDescMain, BASE.concat(SD));

  reg({
    name: 'Format Numbers…',
    description: 'Reformat numbers as 1,234.56 / 1.234,56 / 1 234,56 / 12,34,567 / 1\'234.56, currency, %, compact 1.2M, or strip formatting — skips dates, times, versions, IPs, phones',
    author: 'Cade', icon: ICON.numbers,
    tags: 'number,numbers,format,thousands,separator,comma,decimal,locale,currency,percent,compact,intl,grouping,strip,money,indian,swiss,german,french'
  }, fnMain, BASE.concat(FN));
})();
