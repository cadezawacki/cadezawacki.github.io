/* Live Preview — Markdown mode (lazy: loaded with marked the first time a note
 * is previewed as Markdown). Exposes window.__cadeMdPreview (module.exports in
 * node for tests):
 *
 *   create(marked) -> { render(src, cb) -> [{k, l, h}], shellDoc(token, vars), staticDoc(blocks, vars, imgs, embeds) }
 *
 * render() turns the note into top-level blocks of HTML: k = a key (content
 * hash + occurrence), l = the block's first editor line, h = its HTML. The
 * preview keeps one "shell" document in its sandboxed iframe and only swaps
 * the blocks that changed (keyed), so typing never reloads the page, keeps the
 * scroll position and leaves live ```html blocks alone.
 *
 * Everything the editor shows is rendered: GFM (tables, task lists — a click
 * ticks the box in the note —, strikethrough, autolinks), line breaks as
 * typed, headings with anchors, callouts ("> [!tip] Title", "-" / "+" fold),
 * highlights (%%yellow|text%%, %%bg/fg|text%%, legacy ==color|text==),
 * ||spoilers||, pasted / drawn images (![img:…], resolved by the app), file
 * pills, footnotes ([^id] + "[^id]: text"), lightly highlighted code,
 * ```csv / ```tsv tables, ```postcard ASCII postcards in colour (decoded here,
 * no widget needed) and ```html blocks as live embedded pages (with the
 * ```css / ```js beside them).
 * cb: { embed(line, code) -> key | '', image(code, isRef, data) -> key }.
 * A private marked instance (new marked.Marked) — the File Converter's global
 * marked config is untouched. ES5. */
(function (root) {
  'use strict';

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function hash(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h.toString(36) + s.length.toString(36);
  }
  function countNL(s, a, b) { var n = 0; for (var i = a; i < b; i++) if (s.charCodeAt(i) === 10) n++; return n; }
  function slugify(s) {
    return String(s).toLowerCase().replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/g, '').trim()
      .replace(/[^\wÀ-￿\- ]+/g, '').replace(/\s+/g, '-').slice(0, 80) || 'section';
  }

  // ---- highlights (same rules as the editor: a known colour or #hex, else not a highlight) ----
  var BG = { yellow: 'rgba(250,204,21,.38)', green: 'rgba(34,197,94,.30)', blue: 'rgba(59,130,246,.28)', red: 'rgba(239,68,68,.28)', pink: 'rgba(236,72,153,.28)', purple: 'rgba(168,85,247,.28)', orange: 'rgba(249,115,22,.32)', gray: 'rgba(120,113,108,.28)' };
  var FG = { yellow: '#ca8a04', green: '#16a34a', blue: '#2563eb', red: '#dc2626', pink: '#db2777', purple: '#9333ea', orange: '#ea580c', gray: '#78716c' };
  function color(tok) {
    var t = String(tok || '').trim();
    if (BG[t.toLowerCase()]) return t.toLowerCase();
    return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(t) ? t.toLowerCase() : null;
  }
  function hlSpec(spec) {
    var p = String(spec).split('/');
    if (p.length > 2) return null;
    var b = p[0].trim(), f = p.length > 1 ? p[1].trim() : '';
    var bg = b ? color(b) : null, fg = f ? color(f) : null;
    if ((b && !bg) || (f && !fg) || (!bg && !fg)) return null;
    return { bg: bg, fg: fg };
  }
  function hlStyle(bg, fg) {
    var s = '';
    if (bg) s += 'background:' + (BG[bg] || bg + '40') + ';';
    else s += 'background:none;';
    if (fg) s += 'color:' + (FG[fg] || fg) + ';';
    return s;
  }

  // ---- code: a light highlighter (comments, strings, numbers, keywords / tags) ----
  var KW_JS = 'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|import|export|from|default|typeof|instanceof|await|async|yield|try|catch|finally|throw|delete|void|in|of|this|null|true|false|undefined|interface|type|enum|implements|public|private|protected|readonly|static|get|set';
  var KW_PY = 'def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|global|nonlocal|yield|assert|del|async|await|match|case|self';
  var KW_SH = 'if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|export|local|echo|cd|sudo|exit|set|unset|source|alias';
  var STR = '"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'';
  var NUM = '\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b';
  function mk(com, str, kw) { return new RegExp('(' + com + ')|(' + str + ')|(' + NUM + ')|' + (kw ? '\\b(' + kw + ')\\b' : '()'), 'g'); }
  var LANGS = {
    js: mk('\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', STR + '|`(?:[^`\\\\]|\\\\.)*`', KW_JS),
    py: mk('#[^\\n]*', '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|' + STR, KW_PY),
    sh: mk('#[^\\n]*', STR, KW_SH),
    css: mk('\\/\\*[\\s\\S]*?\\*\\/', STR, '@media|@import|@keyframes|@font-face|!important'),
    json: mk('\\/\\/[^\\n]*', STR, 'true|false|null'),
    html: /(<!--[\s\S]*?-->)|("[^"\n]*"|'[^'\n]*')|()|(<\/?[A-Za-z][\w:-]*|\/?>)/g,
    sql: mk('--[^\\n]*', STR, 'select|from|where|and|or|not|insert|into|values|update|set|delete|create|table|join|left|right|inner|outer|on|group|by|order|having|limit|as|distinct|null|is|in|like|count|sum|avg|min|max|SELECT|FROM|WHERE|AND|OR|NOT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|AS|DISTINCT|NULL|IS|IN|LIKE'),
  };
  var ALIAS = { javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js', node: 'js', python: 'py', python3: 'py', py3: 'py', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellsession: 'sh', scss: 'css', less: 'css', xml: 'html', svg: 'html', htm: 'html', jsonc: 'json', json5: 'json', postgres: 'sql', sqlite: 'sql', mysql: 'sql' };
  var TK = [null, 'tk-c', 'tk-s', 'tk-n', 'tk-k'];
  function highlight(code, lang) {
    var re = LANGS[ALIAS[lang] || lang];
    if (!re || code.length > 200000) return esc(code);
    re.lastIndex = 0;
    var out = '', last = 0, m;
    while ((m = re.exec(code)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }
      var g = m[1] != null ? 1 : m[2] != null ? 2 : m[3] ? 3 : 4;
      out += esc(code.slice(last, m.index)) + '<span class="' + TK[g] + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    return out + esc(code.slice(last));
  }

  // ---- callouts: "> [!type] Title" (GitHub's "> [!NOTE]" too), "-" / "+" fold ----
  var CO = {
    note: ['✎', '#2563eb'], abstract: ['☰', '#0891b2'], info: ['ℹ', '#2563eb'], todo: ['☑', '#2563eb'],
    tip: ['💡', '#0d9488'], important: ['❗', '#9333ea'], success: ['✔', '#16a34a'], question: ['?', '#ca8a04'],
    warning: ['⚠', '#ea580c'], failure: ['✖', '#dc2626'], danger: ['⚡', '#dc2626'], bug: ['🐞', '#dc2626'],
    example: ['≡', '#7c3aed'], quote: ['❝', '#78716c'],
  };
  var CO_ALIAS = { summary: 'abstract', tldr: 'abstract', hint: 'tip', check: 'success', done: 'success', help: 'question', faq: 'question', caution: 'warning', attention: 'warning', fail: 'failure', missing: 'failure', error: 'danger', cite: 'quote' };
  function callout(body) {
    var m = /^<p>\[!([A-Za-z]+)\]([+-]?)[ \t]*([^<\n]*)(?:<br>\n?|\n)?/.exec(body);
    if (!m) return '';
    var raw = m[1].toLowerCase(), type = CO[raw] ? raw : CO_ALIAS[raw] || 'note', c = CO[type];
    var title = m[3].trim() || raw.charAt(0).toUpperCase() + raw.slice(1);
    var rest = body.slice(m[0].length);
    rest = /^<\/p>/.test(rest) ? rest.replace(/^<\/p>\n?/, '') : '<p>' + rest;
    var head = '<span class="md-co-i" aria-hidden="true">' + c[0] + '</span><span class="md-co-t">' + title + '</span>';
    var attrs = ' class="md-co md-co-' + type + '" style="--co:' + c[1] + '"';
    var inner = rest.trim() ? '<div class="md-co-b">' + rest + '</div>' : '';
    if (m[2]) return '<details' + attrs + (m[2] === '+' ? ' open' : '') + '><summary class="md-co-h">' + head + '</summary>' + inner + '</details>\n';
    return '<div' + attrs + '><div class="md-co-h">' + head + '</div>' + inner + '</div>\n';
  }

  // ---- CSV / TSV: a ```csv block, or a whole note that is one, renders as a table ----
  var CSV_MAX_ROWS = 5000;
  function parseDelim(text, d) {
    var rows = [], row = [], f = '', q = false, i = 0, n = text.length, c;
    for (; i < n; i++) {
      c = text.charAt(i);
      if (q) {
        if (c === '"') { if (text.charAt(i + 1) === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"' && f === '') q = true;
      else if (c === d) { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c !== '\r') f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1 || r[0] !== ''; });
  }
  // The delimiter if every non-empty line (3+ of them) has the same number of
  // them outside quotes — so prose with a few commas never turns into a table.
  function sniffDelim(src) {
    var lines = src.split('\n').filter(function (l) { return l.trim(); });
    if (lines.length < 3 || /^\s*(#|[-*+] |>|```|\|)/m.test(src)) return '';
    var cands = ['\t', ',', ';'];
    for (var k = 0; k < cands.length; k++) {
      var d = cands[k], want = -1, ok = true;
      for (var i = 0; i < lines.length && ok; i++) {
        var cnt = 0, q = false, l = lines[i];
        for (var j = 0; j < l.length; j++) { var ch = l.charAt(j); if (ch === '"') q = !q; else if (ch === d && !q) cnt++; }
        if (q) return '';                       // a quoted newline: leave such notes alone
        if (want < 0) want = cnt; else if (cnt !== want) ok = false;
      }
      if (ok && want >= 1) return d;
    }
    return '';
  }
  function csvTable(text, d) {
    var rows = parseDelim(text, d);
    if (!rows.length) return '';
    var head = rows[0], cols = 0, i, j, s;
    for (i = 0; i < rows.length; i++) cols = Math.max(cols, rows[i].length);
    s = '<table class="md-csv"><thead><tr>';
    for (j = 0; j < cols; j++) s += '<th>' + esc(head[j] == null ? '' : head[j]) + '</th>';
    s += '</tr></thead><tbody>';
    var last = Math.min(rows.length, CSV_MAX_ROWS + 1);
    for (i = 1; i < last; i++) {
      s += '<tr>';
      for (j = 0; j < cols; j++) s += '<td>' + esc(rows[i][j] == null ? '' : rows[i][j]) + '</td>';
      s += '</tr>';
    }
    s += '</tbody></table>\n';
    if (rows.length > last) s += '<p class="md-err">… showing the first ' + CSV_MAX_ROWS + ' of ' + (rows.length - 1) + ' rows.</p>\n';
    return s;
  }

  // ---- ASCII postcards: a ```postcard block (widgets/postcard/postcard-core.js has the
  // format) renders as coloured text — runs of one colour share a span. A copy of
  // the minimal decoder (base64 + raw inflate + palette) so this file stands alone;
  // anything that doesn't add up renders the art in one colour. ----
  var PC_PAPER = { dark: 1, light: 1, paper: 1 };
  var PC_INK = { green: { dark: '#3dff7a', light: '#0a7d32', paper: '#2f6b2f' }, sepia: { dark: '#d9b77e', light: '#704214', paper: '#6b4423' } };
  var PC_COLOR_RE = /^~ ?[A-Za-z0-9+/=_-]{4,}\s*$/;
  function pcInfo(info) {
    var re = /"([^"]*)"?|(\S+)/g, m, first = true, o = { cols: 0, rows: 0, style: 'classic', mode: '', tint: '#e07a5f', bg: 'dark', cap: '' };
    while ((m = re.exec(info))) {
      if (first) { if ((m[2] || '').toLowerCase() !== 'postcard') return null; first = false; continue; }
      if (m[1] != null) { if (!o.cap) o.cap = m[1].trim(); continue; }
      var t = m[2].toLowerCase(), d = /^(\d{1,3})x(\d{1,3})$/.exec(t), tm = /^tint(?:[:=]?#?([0-9a-f]{6}|[0-9a-f]{3}))?$/.exec(t);
      if (d) { o.cols = +d[1]; o.rows = +d[2]; }
      else if (PC_PAPER[t]) o.bg = t;
      else if (t === 'color' || t === 'colour' || t === 'mono' || t === 'green' || t === 'sepia') o.mode = t === 'colour' ? 'color' : t;
      else if (tm) { o.mode = 'tint'; if (tm[1]) o.tint = '#' + (tm[1].length === 3 ? tm[1].replace(/(.)/g, '$1$1') : tm[1]); }
      else if (/^(classic|dense|blocks|braille|edges|text)$/.test(t)) o.style = t;
    }
    return first ? null : o;
  }
  var B64A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function pcB64(s) {
    s = s.replace(/[\s=]+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    var out = [], acc = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B64A.indexOf(s.charAt(i));
      if (v < 0) return null;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
    }
    return out;
  }
  // raw DEFLATE (after puff.c); throws on bad data or more than max bytes
  var PC_LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var PC_LE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var PC_DB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var PC_DE = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var PC_CL = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  function pcHuff(l, off, n) {
    var c = [], o = [0, 0], s = [], i, left = 1;
    for (i = 0; i < 16; i++) c[i] = 0;
    for (i = 0; i < n; i++) c[l[off + i] || 0]++;
    for (i = 1; i < 16; i++) { left = left * 2 - c[i]; if (left < 0) throw new Error('code'); }
    for (i = 1; i < 15; i++) o[i + 1] = o[i] + c[i];
    for (i = 0; i < n; i++) if (l[off + i]) s[o[l[off + i]]++] = i;
    return { c: c, s: s };
  }
  function pcInflate(src, max) {
    var out = [], pos = 0, bb = 0, bc = 0, last, type, i, F = null;
    function bits(k) {
      while (bc < k) { if (pos >= src.length) throw new Error('eof'); bb |= src[pos++] << bc; bc += 8; }
      var v = bb & ((1 << k) - 1); bb >>>= k; bc -= k; return v;
    }
    function dec(h) {
      var code = 0, first = 0, idx = 0;
      for (var len = 1; len < 16; len++) {
        code |= bits(1);
        if (code - h.c[len] < first) return h.s[idx + code - first];
        idx += h.c[len]; first = (first + h.c[len]) << 1; code <<= 1;
      }
      throw new Error('code');
    }
    function codes(L, D) {
      for (;;) {
        var s = dec(L);
        if (s < 256) { if (out.length >= max) throw new Error('long'); out.push(s); continue; }
        if (s === 256) return;
        s -= 257;
        if (s >= 29) throw new Error('len');
        var len = PC_LB[s] + bits(PC_LE[s]), ds = dec(D);
        if (ds >= 30) throw new Error('dist');
        var d = PC_DB[ds] + bits(PC_DE[ds]);
        if (d > out.length || out.length + len > max) throw new Error('dist');
        while (len--) out.push(out[out.length - d]);
      }
    }
    do {
      last = bits(1); type = bits(2);
      if (type === 0) {
        bb = bc = 0;
        var n = src[pos] | src[pos + 1] << 8, nn = src[pos + 2] | src[pos + 3] << 8;
        pos += 4;
        if (n !== (~nn & 0xffff) || pos + n > src.length || out.length + n > max) throw new Error('stored');
        for (i = 0; i < n; i++) out.push(src[pos++]);
      } else if (type === 1) {
        if (!F) { F = []; for (i = 0; i < 288; i++) F[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8; for (; i < 318; i++) F[i] = 5; }
        codes(pcHuff(F, 0, 288), pcHuff(F, 288, 30));
      } else if (type === 2) {
        var nl = bits(5) + 257, nd = bits(5) + 1, nc = bits(4) + 4, ls = [];
        if (nl > 286 || nd > 30) throw new Error('counts');
        for (i = 0; i < 19; i++) ls[i] = 0;
        for (i = 0; i < nc; i++) ls[PC_CL[i]] = bits(3);
        var lc = pcHuff(ls, 0, 19);
        ls = [];
        while (ls.length < nl + nd) {
          var sym = dec(lc), rep, val = 0;
          if (sym < 16) { ls.push(sym); continue; }
          if (sym === 16) { if (!ls.length) throw new Error('rep'); val = ls[ls.length - 1]; rep = 3 + bits(2); }
          else rep = sym === 17 ? 3 + bits(3) : 11 + bits(7);
          if (ls.length + rep > nl + nd) throw new Error('rep');
          while (rep--) ls.push(val);
        }
        if (!ls[256]) throw new Error('eob');
        codes(pcHuff(ls, 0, nl), pcHuff(ls, nl, nd));
      } else throw new Error('type');
    } while (!last);
    return out;
  }
  // '~ base64' → { pal: ['#rrggbb'…], idx: [] } or null
  function pcColors(line, cells) {
    try {
      var b = pcB64(line.replace(/^\s*~\s*/, ''));
      if (!b || b.length < 3 || b[0] !== 1 || (b[1] & ~1)) return null;
      var body = b.slice(2);
      if (b[1] & 1) body = pcInflate(body, 1 + 192 + cells);
      var n = body[0], pal = [], i;
      if (!(n >= 1 && n <= 64) || body.length !== 1 + n * 3 + cells) return null;
      for (i = 0; i < n; i++) pal.push('#' + [body[1 + i * 3], body[2 + i * 3], body[3 + i * 3]].map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join(''));
      var idx = body.slice(1 + n * 3);
      for (i = 0; i < cells; i++) if (idx[i] >= n) return null;
      return { pal: pal, idx: idx };
    } catch (e) { return null; }
  }
  function pcFit(s, n) {
    var a = Array.from(String(s || '').replace(/\t/g, ' ')).slice(0, n);
    while (a.length < n) a.push(' ');
    return a;
  }
  function postcard(info, text) {
    var o = pcInfo(info);
    if (!o) return '';
    var body = String(text).split('\n'), c = null, y, x;
    if (body.length > 1 && PC_COLOR_RE.test(body[body.length - 1])) { var cl = body.pop(); if (!o.mode || o.mode === 'color') c = pcColors(cl, o.cols * o.rows); }
    var cols = o.cols, rows = o.rows;
    if (!cols || !rows || cols > 400 || rows > 400) { c = null; rows = body.length; cols = 1; for (y = 0; y < rows; y++) cols = Math.max(cols, Array.from(body[y]).length); cols = Math.min(cols, 400); }
    var style = '--pc-cols:' + cols, cls = 'md-pc md-pc-' + o.bg, h = '';
    if (c) {
      for (var k = 0; k < c.pal.length; k++) style += ';--k' + k + ':' + c.pal[k];
      var cur = -1;
      for (y = 0; y < rows; y++) {
        var line = pcFit(body[y], cols);
        for (x = 0; x < cols; x++) {
          var ch = line[x], ci = c.idx[y * cols + x];
          if (ch !== ' ' && ch !== '\u2800' && ci !== cur) { if (cur >= 0) h += '</i>'; h += '<i class=k' + ci + '>'; cur = ci; }
          h += esc(ch);   // blanks join the current run: invisible either way
        }
        if (y < rows - 1) h += '\n';
      }
      if (cur >= 0) h += '</i>';
    } else {
      var lines = [];
      for (y = 0; y < rows; y++) lines.push(pcFit(body[y], cols).join('').replace(/\s+$/, ''));
      h = esc(lines.join('\n'));
      if (o.mode === 'tint') style += ';color:' + o.tint;
      else if (PC_INK[o.mode]) style += ';color:' + PC_INK[o.mode][o.bg];
      else if (o.mode !== 'color' || !c) cls = 'md-pc md-pc-mono';
    }
    return '<figure class="md-pcw"><pre class="' + cls + '" style="' + style + '" role="img" aria-label="' + esc('ASCII postcard' + (o.cap ? ': ' + o.cap : '')) + '">' + h + '</pre>' +
      (o.cap ? '<figcaption>' + esc(o.cap) + '</figcaption>' : '') + '</figure>\n';
  }

  function fmtSize(n) { n = +n || 0; return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

  function create(marked) {
    var cur = null, slugs = {};
    var M = new marked.Marked({ gfm: true, breaks: true, async: false });
    M.use({
      extensions: [
        { // pasted / drawn images: ![img:j:BASE64] or ![img:j#hash], optional |w320
          name: 'cimg', level: 'inline',
          start: function (s) { var i = s.indexOf('![img:'); return i < 0 ? undefined : i; },
          tokenizer: function (s) {
            var m = /^!\[img:(?:([jwa])([:#]))?([A-Za-z0-9+/=]+)(?:\|w(\d{2,4}))?\]/.exec(s);
            if (!m || (m[2] !== '#' && m[3].length < 24)) return undefined;
            return { type: 'cimg', raw: m[0], code: m[1] || 'j', ref: m[2] === '#', data: m[3], w: m[4] ? +m[4] : 0 };
          },
          renderer: function (t) {
            var key = cur && cur.image ? cur.image(t.code, t.ref, t.data) : '';
            return '<img class="md-cimg" alt="image" data-cimg="' + esc(key) + '"' + (t.w ? ' style="width:' + t.w + 'px"' : '') + '>';
          },
        },
        { // attached files: ![file:name#hash|s1234]
          name: 'cfile', level: 'inline',
          start: function (s) { var i = s.indexOf('![file:'); return i < 0 ? undefined : i; },
          tokenizer: function (s) {
            var m = /^!\[file:([^\]\n#|]{1,120})#([a-f0-9]{16,64})(?:\|s(\d{1,12}))?\]/.exec(s);
            return m ? { type: 'cfile', raw: m[0], name: m[1], size: m[3] ? +m[3] : -1 } : undefined;
          },
          renderer: function (t) { return '<span class="md-file">📎 ' + esc(t.name) + (t.size >= 0 ? ' <small>' + fmtSize(t.size) + '</small>' : '') + '</span>'; },
        },
        { // highlights: %%bg/fg|text%%, legacy ==color|text==
          name: 'hl', level: 'inline',
          start: function (s) { var i = s.search(/%%|==[A-Za-z]/); return i < 0 ? undefined : i; },
          tokenizer: function (s) {
            var m = /^%%([^|%\n]{1,32})\|([\s\S]+?)%%/.exec(s), sp = m && hlSpec(m[1]);
            if (!sp) {
              m = /^==([a-zA-Z]{3,10})\|([\s\S]+?)==/.exec(s);
              sp = m && BG[m[1].toLowerCase()] ? { bg: m[1].toLowerCase(), fg: null } : null;
            }
            if (!sp || m[0].length > 4000) return undefined;
            return { type: 'hl', raw: m[0], bg: sp.bg, fg: sp.fg, tokens: this.lexer.inlineTokens(m[2]) };
          },
          renderer: function (t) { return '<mark class="md-hl" style="' + hlStyle(t.bg, t.fg) + '">' + this.parser.parseInline(t.tokens) + '</mark>'; },
        },
        { // ||spoiler||
          name: 'spoiler', level: 'inline',
          start: function (s) { var i = s.indexOf('||'); return i < 0 ? undefined : i; },
          tokenizer: function (s) {
            var m = /^\|\|([^|\s](?:[^\n]*?[^|\s])?)\|\|/.exec(s);
            return m ? { type: 'spoiler', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) } : undefined;
          },
          renderer: function (t) { return '<span class="md-spoiler" title="Spoiler — click to reveal">' + this.parser.parseInline(t.tokens) + '</span>'; },
        },
        { // footnote reference [^id]
          name: 'fnref', level: 'inline',
          start: function (s) { var i = s.indexOf('[^'); return i < 0 ? undefined : i; },
          tokenizer: function (s) {
            var m = /^\[\^([^\]\s]{1,40})\](?!:)/.exec(s);
            return m ? { type: 'fnref', raw: m[0], id: m[1] } : undefined;
          },
          renderer: function (t) { return '<sup class="md-fn"><a href="#fn-' + esc(slugify(t.id)) + '">' + esc(t.id) + '</a></sup>'; },
        },
        { // footnote definition "[^id]: text" (indented lines continue it)
          name: 'fndef', level: 'block',
          start: function (s) { var m = /(^|\n)\[\^[^\]\s]+\]:/.exec(s); return m ? m.index + m[1].length : undefined; },
          tokenizer: function (s) {
            var m = /^\[\^([^\]\s]{1,40})\]:[ \t]*([^\n]*(?:\n(?:[ \t]{2,}|\t)[^\n]*)*)(?:\n|$)/.exec(s);
            return m ? { type: 'fndef', raw: m[0], id: m[1], tokens: this.lexer.inlineTokens(m[2].replace(/\n[ \t]+/g, ' ')) } : undefined;
          },
          renderer: function (t) { return '<div class="md-fndef" id="fn-' + esc(slugify(t.id)) + '"><sup>' + esc(t.id) + '</sup> ' + this.parser.parseInline(t.tokens) + '</div>\n'; },
        },
      ],
      renderer: {
        heading: function (t) {
          var inner = this.parser.parseInline(t.tokens), id = slugify(inner), n = slugs[id] = (slugs[id] || 0) + 1;
          if (n > 1) id += '-' + (n - 1);
          return '<h' + t.depth + ' id="' + esc(id) + '">' + inner + '</h' + t.depth + '>\n';
        },
        code: function (t) {
          var info = String(t.lang || '').trim(), lang = info.split(/\s+/)[0].toLowerCase();
          if ((lang === 'csv' || lang === 'tsv') && t.text.trim()) return csvTable(t.text, lang === 'tsv' ? '\t' : sniffDelim(t.text) || ',');
          if (lang === 'postcard') { var pc = postcard(info, t.text); if (pc) return pc; }
          if (lang === 'html' && t.__l && cur && cur.embed) {
            var ek = cur.embed(t.__l, t.text);
            if (ek) return '<div class="md-embed" data-ek="' + esc(ek) + '"></div>\n';
          }
          return '<div class="md-code' + (lang === 'output' ? ' md-output' : '') + '">' + (info ? '<span class="md-lang">' + esc(info) + '</span>' : '') +
            '<pre><code>' + highlight(t.text, lang) + '</code></pre></div>\n';
        },
        checkbox: function (t) {
          return '<input type="checkbox"' + (t.checked ? ' checked' : '') + (t.__l ? ' data-tl="' + t.__l + '" title="Tick in the note"' : ' disabled') + '> ';
        },
        blockquote: function (t) {
          var body = this.parser.parse(t.tokens);
          return callout(body) || '<blockquote>\n' + body + '</blockquote>\n';
        },
      },
    });

    // Line numbers: every token's raw text sits, in order, inside its parent's
    // raw text — so walk them with indexOf (lists + items + task checkboxes).
    function annotate(list, raw, line) {
      var pos = 0;
      for (var i = 0; i < (list || []).length; i++) {
        var t = list[i];
        if (!t || typeof t.raw !== 'string' || !t.raw) continue;
        var at = raw.indexOf(t.raw, pos);
        if (at < 0) continue;
        line += countNL(raw, pos, at);
        t.__l = line;
        if (t.type === 'list') annotate(t.items, t.raw, line);
        else if (t.type === 'list_item') annotate(t.tokens, t.raw, line);
        line += countNL(raw, at, at + t.raw.length);
        pos = at + t.raw.length;
      }
    }

    function render(src, cb) {
      cur = cb || {}; slugs = {};
      src = String(src || '').replace(/\r\n?/g, '\n');
      var out = [], seen = {}, toks;
      var dl = src.length < 2000000 ? sniffDelim(src) : '';
      if (dl) { var th = csvTable(src, dl); cur = null; return [{ k: hash(th) + '.1', l: 1, h: th }]; }
      try { toks = M.lexer(src); } catch (e) { cur = null; return [{ k: 'err', l: 1, h: '<pre class="md-err">' + esc(src) + '</pre>' }]; }
      annotate(toks, src, 1);
      for (var i = 0; i < toks.length; i++) {
        var t = toks[i];
        if (t.type === 'space' || t.type === 'def') continue;
        var h;
        try { h = M.parser([t]); } catch (e) { h = '<pre class="md-err">' + esc(t.raw) + '</pre>'; }
        if (!h || !h.trim()) continue;
        var k = hash(h);
        seen[k] = (seen[k] || 0) + 1;
        out.push({ k: k + '.' + seen[k], l: t.__l || 0, h: h });
      }
      cur = null;
      return out;
    }
    return { render: render, shellDoc: shellDoc, staticDoc: staticDoc, highlight: highlight, hash: hash, sniffDelim: sniffDelim, parseDelim: parseDelim, csvTable: csvTable, postcard: postcard };
  }

  // ---- the shell document (lives in the preview's sandboxed iframe) ----------------------------
  var CSS = [
    ':root{color-scheme:light dark}',
    'html{-webkit-text-size-adjust:100%}',
    'body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 var(--font-body);}',
    '.md{max-width:780px;margin:0 auto;padding:18px 22px 64px;overflow-wrap:break-word}',
    '.md-b{position:relative}',
    '.md-b.md-cur::before{content:"";position:absolute;left:-12px;top:3px;bottom:3px;width:3px;border-radius:2px;background:var(--accent);opacity:.5}',
    'h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.1em 0 .5em;font-weight:650}',
    'h1{font-size:1.75em}h2{font-size:1.4em;padding-bottom:.2em;border-bottom:1px solid var(--border)}h3{font-size:1.18em}h4{font-size:1.02em}h5,h6{font-size:.92em;color:var(--text-muted)}',
    '.md>.md-b:first-child>:first-child{margin-top:0}',
    'p{margin:0 0 .8em}',
    'a{color:var(--accent);text-underline-offset:2px}',
    'strong{font-weight:650}',
    'code{font:.88em var(--font-mono);background:var(--surface-2);border:1px solid var(--border);padding:.05em .35em;border-radius:4px}',
    '.md-code{position:relative;margin:0 0 1em}',
    'pre{margin:0;padding:10px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;overflow:auto;font:12.5px/1.5 var(--font-mono);tab-size:4}',
    'pre code{background:none;border:0;padding:0;font:inherit}',
    '.md-lang{position:absolute;top:3px;right:8px;font:11px var(--font-mono);color:var(--text-faint);pointer-events:none}',
    '.md-output pre{border-style:dashed;color:var(--text-muted)}',
    '.tk-c{color:var(--text-faint);font-style:italic}.tk-s{color:var(--tk-s)}.tk-n{color:var(--tk-n)}.tk-k{color:var(--accent);font-weight:600}',
    'blockquote{margin:0 0 1em;padding:.1em 1em;border-left:3px solid var(--border);color:var(--text-muted)}',
    'blockquote>:last-child{margin-bottom:0}',
    'ul,ol{margin:0 0 .8em;padding-left:1.6em}li{margin:.15em 0}li>p{margin:0 0 .3em}li>ul,li>ol{margin-bottom:0}',
    'li:has(>input[type=checkbox]){list-style:none;margin-left:-1.35em}',
    'input[type=checkbox]{margin:0 .45em 0 0;vertical-align:-2px;width:15px;height:15px;accent-color:var(--accent)}',
    'input[type=checkbox][data-tl]{cursor:pointer}',
    'li:has(>input:checked){color:var(--text-muted)}',
    'table{border-collapse:collapse;margin:0 0 1em;display:block;overflow-x:auto;max-width:100%}',
    'th,td{border:1px solid var(--border);padding:5px 10px;vertical-align:top}th{background:var(--surface-2);text-align:left;font-weight:600}',
    'hr{border:0;border-top:1px solid var(--border);margin:1.4em 0}',
    'table.md-csv td{white-space:pre-wrap;font-variant-numeric:tabular-nums}',
    '.md-tw{margin:0 0 1em}.md-tw>table{margin:0}',
    '.md-tf{display:flex;align-items:center;gap:8px;margin:0 0 6px}',
    '.md-tf input{flex:1 1 auto;min-width:0;max-width:280px;font:13px var(--font-body);color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:5px 9px;-webkit-appearance:none;appearance:none}',
    '.md-tf input:focus{outline:none;border-color:var(--accent)}',
    '.md-tf span{font:12px var(--font-body);color:var(--text-faint);white-space:nowrap}',
    'th.md-sort{cursor:pointer;user-select:none;-webkit-user-select:none;white-space:nowrap}th.md-sort:hover{color:var(--accent)}',
    'th.md-sort::after{content:"\\2195";margin-left:.4em;opacity:.3;font-size:.85em}',
    'th.md-sort[aria-sort=ascending]::after{content:"\\25B2";opacity:.9;color:var(--accent)}th.md-sort[aria-sort=descending]::after{content:"\\25BC";opacity:.9;color:var(--accent)}',
    'tr.md-hide{display:none}',
    '@media print{:root{--bg:#fff;--surface:#fff;--surface-2:#f4f4f4;--text:#111;--text-muted:#444;--text-faint:#777;--border:#ccc}body{background:#fff;color:#111}.md{max-width:none;padding:0}.md-tf,.md-b.md-cur::before{display:none!important}table{display:table;overflow:visible}tr,img,pre,.md-co{break-inside:avoid}th.md-sort::after{content:none}.md-spoiler{background:none;color:inherit}.md-spoiler *{visibility:visible!important}}',
    'img{max-width:100%;height:auto;border-radius:6px}',
    '.md-cimg:not([src]){display:inline-block;width:120px;height:80px;background:var(--surface-2);border:1px dashed var(--border)}',
    'mark.md-hl{border-radius:3px;padding:0 .12em;color:inherit}',
    '.md-spoiler{background:var(--text);color:transparent;border-radius:3px;cursor:pointer;transition:background .15s,color .15s}',
    '.md-spoiler.shown{background:var(--surface-2);color:inherit}.md-spoiler:not(.shown) *{visibility:hidden}',
    '.md-file{display:inline-flex;align-items:center;gap:4px;padding:0 8px;border:1px solid var(--border);border-radius:999px;font-size:.9em;background:var(--surface)}',
    '.md-file small{color:var(--text-muted)}',
    '.md-fn a{text-decoration:none;padding:0 1px}.md-fndef{font-size:.9em;color:var(--text-muted);margin:0 0 .4em}.md-fndef sup{color:var(--accent)}',
    '.md-co{margin:0 0 1em;border-left:3px solid var(--co);background:color-mix(in srgb,var(--co) 9%,transparent);border-radius:6px;padding:8px 12px}',
    '.md-co-h{display:flex;align-items:center;gap:7px;font-weight:650;color:var(--co)}summary.md-co-h{cursor:pointer}',
    '.md-co-b{margin-top:6px}.md-co-b>:last-child{margin-bottom:0}',
    '.md-embed{margin:0 0 1em;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:#fff;min-height:40px}',
    '.md-embed-f{display:block;width:100%;height:160px;border:0;background:#fff}',
    // ASCII postcards: one character per cell (a cell is half as wide as tall), sized to fit the column
    '.md-pcw{margin:0 0 1em}',
    '.md-pc{display:inline-block;max-width:100%;margin:0;padding:12px 14px;border:0;border-radius:8px;overflow:hidden;white-space:pre;tab-size:1;' +
      'font-family:var(--font-mono);font-size:min(13px,calc((min(100vw,780px) - 76px) / var(--pc-cols,64) / .6));line-height:1.2;letter-spacing:0;' +
      'font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0}',
    '.md-pc i{font-style:normal}',
    '.md-pc-dark{background:#111110;color:#e7e5e3}.md-pc-light{background:#fafaf9;color:#1c1917;box-shadow:inset 0 0 0 1px var(--border)}.md-pc-paper{background:#f2e8d5;color:#3b3024}',
    '.md-pc-mono{background:var(--surface-2);color:var(--text);box-shadow:inset 0 0 0 1px var(--border)}',
    (function () { var s = ''; for (var i = 0; i < 64; i++) s += '.md-pc .k' + i + '{color:var(--k' + i + ')}'; return s; })(),
    '.md-pcw figcaption{margin:5px 2px 0;font-size:.88em;font-style:italic;color:var(--text-muted)}',
    '@media print{.md-pc{-webkit-print-color-adjust:exact;print-color-adjust:exact;font-size:min(10px,calc(680px / var(--pc-cols,64) / .6))}.md-pcw{break-inside:avoid}}',
    '.md-err{color:var(--text-muted)}',
    '.md-empty{color:var(--text-faint);text-align:center;padding:48px 12px}',
    '@media (max-width:520px){.md{padding:14px 14px 56px}body{font-size:15.5px}}',
  ].join('\n');

  // Runs inside the sandboxed iframe (ES5, shipped via toString).
  function SHELL(TOKEN) {
    var P = window.parent, root = document.getElementById('md'), imgs = {}, embeds = {}, curEl = null;
    function up(m) { m.__md = TOKEN; try { P.postMessage(m, '*'); } catch (e) {} }
    function blockOf(el) { while (el && el.parentNode !== root) el = el.parentNode; return el; }
    function mount(ph) {
      if (ph.firstChild) return;
      var doc = embeds[ph.getAttribute('data-ek')];
      if (doc == null) return;
      var f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts allow-modals allow-forms allow-popups');
      f.setAttribute('title', 'HTML block');
      f.setAttribute('loading', 'lazy');
      f.className = 'md-embed-f';
      f.srcdoc = doc;
      ph.appendChild(f);
    }
    // Tables: click a header to sort (again to reverse, a third time for the
    // note's order); 4+ rows get a filter box. Kept across re-renders by the
    // header row's text, so typing in the note doesn't reset them.
    var tstate = {};
    function cellKey(td) {
      var t = (td ? td.textContent : '').trim(), n = t.replace(/[$€£¥%,\s]/g, '');
      return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(n) ? { n: parseFloat(n), t: t } : { n: NaN, t: t.toLowerCase() };
    }
    function applyT(tb, s) {
      var body = tb.tBodies[0];
      if (!body) return;
      var rows = Array.prototype.slice.call(body.rows), shown = 0;
      rows.forEach(function (r, i) { if (r.__o == null) r.__o = i; });
      if (s.col >= 0 && s.dir) {
        var c = s.col, d = s.dir;
        rows.sort(function (a, b) {
          var x = cellKey(a.cells[c]), y = cellKey(b.cells[c]), r;
          if (!isNaN(x.n) && !isNaN(y.n)) r = x.n - y.n;
          else if (!isNaN(x.n) !== !isNaN(y.n)) r = isNaN(x.n) ? 1 : -1;   // numbers before text
          else r = x.t < y.t ? -1 : x.t > y.t ? 1 : 0;
          if (!x.t !== !y.t) return x.t ? -1 : 1;                           // blanks last either way
          return (r || a.__o - b.__o) * (r ? d : 1);
        });
      } else rows.sort(function (a, b) { return a.__o - b.__o; });
      var q = (s.q || '').toLowerCase().trim();
      for (var i = 0; i < rows.length; i++) {
        var hit = !q || rows[i].textContent.toLowerCase().indexOf(q) >= 0;
        rows[i].classList.toggle('md-hide', !hit);
        if (hit) shown++;
        body.appendChild(rows[i]);
      }
      var hs = tb.tHead ? tb.tHead.rows[0].cells : [];
      for (var j = 0; j < hs.length; j++) {
        if (s.col === j && s.dir) hs[j].setAttribute('aria-sort', s.dir > 0 ? 'ascending' : 'descending');
        else hs[j].removeAttribute('aria-sort');
      }
      if (tb.__cnt) tb.__cnt.textContent = q ? shown + ' of ' + rows.length : rows.length + ' rows';
    }
    function enhance(el) {
      var ts = el.querySelectorAll('table'), seenK = {};
      for (var i = 0; i < ts.length; i++) {
        var tb = ts[i];
        if (!tb.tHead || !tb.tBodies[0] || tb.__enh) continue;
        tb.__enh = 1;
        var sig = tb.tHead.textContent.trim().slice(0, 200), n = seenK[sig] = (seenK[sig] || 0) + 1, key = sig + '#' + n;
        var s = tstate[key] || (tstate[key] = { col: -1, dir: 0, q: '' });
        tb.__s = s;
        var hs = tb.tHead.rows[0].cells;
        for (var j = 0; j < hs.length; j++) { hs[j].className += ' md-sort'; hs[j].setAttribute('data-c', j); hs[j].title = 'Sort'; }
        if (tb.tBodies[0].rows.length >= 4) {
          var w = document.createElement('div'), bar = document.createElement('div'), inp = document.createElement('input'), cnt = document.createElement('span');
          w.className = 'md-tw'; bar.className = 'md-tf';
          inp.type = 'search'; inp.placeholder = 'Filter rows…'; inp.value = s.q; inp.setAttribute('aria-label', 'Filter rows');
          inp.__t = tb;
          bar.appendChild(inp); bar.appendChild(cnt);
          tb.parentNode.insertBefore(w, tb);
          w.appendChild(bar); w.appendChild(tb);
          tb.__cnt = cnt;
        }
        if (s.dir || s.q || tb.__cnt) applyT(tb, s);
      }
    }
    document.addEventListener('input', function (e) {
      var t = e.target;
      if (t && t.__t) { t.__t.__s.q = t.value; applyT(t.__t, t.__t.__s); }
    });
    function fill(el) {
      var a = el.querySelectorAll('img[data-cimg]'), i;
      for (i = 0; i < a.length; i++) { var s = imgs[a[i].getAttribute('data-cimg')]; if (s && a[i].getAttribute('src') !== s) a[i].src = s; }
      var e = el.querySelectorAll('.md-embed[data-ek]');
      for (i = 0; i < e.length; i++) mount(e[i]);
    }
    function render(list) {
      var want = {}, have = {}, i, kids;
      for (i = 0; i < list.length; i++) want[list[i].k] = 1;
      // drop blocks that are gone first, so the ones that stay never move (a moved iframe reloads)
      kids = Array.prototype.slice.call(root.children);
      for (i = 0; i < kids.length; i++) {
        var key = kids[i].getAttribute('data-k');
        if (!want[key] || have[key]) root.removeChild(kids[i]);
        else have[key] = kids[i];
      }
      var ptr = root.firstElementChild;
      for (i = 0; i < list.length; i++) {
        var b = list[i], el = have[b.k];
        if (!el) {
          if (b.h == null) { up({ type: 'resync' }); return; }
          el = document.createElement('div');
          el.className = 'md-b';
          el.setAttribute('data-k', b.k);
          el.innerHTML = b.h;
          fill(el);
          enhance(el);
        }
        if (el.getAttribute('data-l') !== String(b.l)) el.setAttribute('data-l', String(b.l));
        if (el === ptr) ptr = ptr.nextElementSibling;
        else root.insertBefore(el, ptr);
      }
      if (!list.length) root.innerHTML = '<div class="md-empty">This note is empty.</div>';
      else { var em = root.querySelector('.md-empty'); if (em) em.remove(); }
      // forget images / pages no block uses any more (the app forgets them too)
      var live = {}, ph = root.querySelectorAll('[data-ek],[data-cimg]'), k2;
      for (i = 0; i < ph.length; i++) live[ph[i].getAttribute('data-ek') || ph[i].getAttribute('data-cimg')] = 1;
      for (k2 in embeds) if (!live[k2]) delete embeds[k2];
      for (k2 in imgs) if (!live[k2]) delete imgs[k2];
    }
    function toLine(n, force) {
      var kids = root.children, best = null;
      for (var i = 0; i < kids.length; i++) {
        var l = +kids[i].getAttribute('data-l');
        if (l && l <= n) best = kids[i];
        else if (l > n) break;
      }
      if (!best) best = root.firstElementChild;
      if (!best) return;
      if (curEl !== best) { if (curEl) curEl.classList.remove('md-cur'); best.classList.add('md-cur'); curEl = best; }
      var r = best.getBoundingClientRect(), vh = window.innerHeight;
      if (force || r.bottom < 8 || r.top > vh - 8) best.scrollIntoView({ block: r.height > vh * 0.8 ? 'start' : 'center' });
    }
    window.addEventListener('message', function (e) {
      var m = e.data;
      if (e.source === P) {
        if (!m || m.__md !== TOKEN) return;
        if (m.type === 'render') render(m.blocks || []);
        else if (m.type === 'img') { imgs[m.key] = m.src; fill(root); }
        else if (m.type === 'embeds') { (m.list || []).forEach(function (x) { embeds[x.ek] = x.html; }); fill(root); }
        else if (m.type === 'line') toLine(+m.line || 1, !!m.force);
        else if (m.type === 'vars') { var v = document.getElementById('md-vars'); if (v) v.textContent = m.css; }
        else if (m.type === 'print') { try { window.print(); } catch (x) {} }
        return;
      }
      if (!m || typeof m !== 'object') return;
      if (m.__mdh) { // an embedded html block reports its height
        var fs = document.querySelectorAll('iframe.md-embed-f');
        for (var i = 0; i < fs.length; i++) if (fs[i].contentWindow === e.source) fs[i].style.height = Math.max(40, Math.min(2400, +m.h || 0)) + 'px';
        return;
      }
      if (m.__cr && m.type !== 'scroll') { try { P.postMessage(m, '*'); } catch (x) {} } // console output -> the app
    });
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      // the box flips when the note does (the block re-renders) — read-only notes stay as they are
      if (t.matches('input[type=checkbox][data-tl]')) { e.preventDefault(); up({ type: 'task', line: +t.getAttribute('data-tl') }); return; }
      var th = t.closest('th.md-sort');
      if (th) {
        var tbl = th.closest('table'), s = tbl && tbl.__s, c = +th.getAttribute('data-c');
        if (s) {
          if (s.col !== c) { s.col = c; s.dir = 1; } else if (s.dir === 1) s.dir = -1; else { s.col = -1; s.dir = 0; }
          applyT(tbl, s);
        }
        return;
      }
      var sp = t.closest('.md-spoiler');
      if (sp) { sp.classList.toggle('shown'); e.preventDefault(); return; }
      var a = t.closest('a[href^="#"]');
      if (a) {
        e.preventDefault();
        var id = decodeURIComponent(a.getAttribute('href').slice(1)), tg = document.getElementById(id);
        if (tg) tg.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    });
    document.addEventListener('dblclick', function (e) {
      var b = blockOf(e.target);
      if (b && b.getAttribute('data-l')) up({ type: 'goto', line: +b.getAttribute('data-l') });
    });
    up({ type: 'ready' });
  }

  // vars: CSS text for :root (--bg, --text, … taken from the app's theme)
  function shellDoc(token, vars) {
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<base target="_blank"><title>Preview</title><style id="md-vars">' + vars + '</style><style>' + CSS + '</style></head>' +
      '<body><article id="md" class="md"></article><script>(' + SHELL.toString() + ')(' + JSON.stringify(String(token)) + ');<\/script></body></html>';
  }
  // A standalone page (Copy / Open in a new tab): images inlined, html blocks as sandboxed frames.
  function staticDoc(blocks, vars, imgs, embeds) {
    var body = blocks.map(function (b) { return b.h; }).join('\n')
      .replace(/<img class="md-cimg" alt="image" data-cimg="([^"]*)"/g, function (m0, k) { return imgs[k] ? '<img class="md-cimg" alt="image" src="' + esc(imgs[k]) + '"' : m0; })
      .replace(/<div class="md-embed" data-ek="([^"]*)"><\/div>/g, function (m0, k) {
        return embeds[k] ? '<div class="md-embed"><iframe class="md-embed-f" style="height:360px" sandbox="allow-scripts allow-modals allow-forms allow-popups" srcdoc="' + esc(embeds[k]) + '"></iframe></div>' : '';
      });
    return '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Note</title>\n<style>\n' + vars + '\n' + CSS +
      '\n.md-spoiler:hover{background:var(--surface-2);color:inherit}.md-spoiler:hover *{visibility:visible}\n</style>\n</head>\n<body>\n<article class="md">\n' + body + '\n</article>\n</body>\n</html>\n';
  }

  var api = { create: create, hash: hash, slugify: slugify, CSS: CSS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__cadeMdPreview = api;
})(typeof self !== 'undefined' ? self : this);
