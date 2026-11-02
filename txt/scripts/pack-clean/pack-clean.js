/* Clean & Restructure Pack — whitespace, list, table and code cleanup
   transforms. Script-pack module: one file registering 19 palette scripts.
   Follows the idiom: read ctx.selection || ctx.fullText, write back to the
   same target. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var registerScript = function (src) { window.Cade.registerScript(src); };

registerScript(`/**
  {
    "name": "Strip Trailing Whitespace",
    "description": "Remove spaces and tabs from the end of every line",
    "author": "Cade",
    "icon": "🧹",
    "tags": "clean,trailing,whitespace,trim,lines,code"
  }
**/
function main(ctx) {
  var t = ctx.selection || ctx.fullText;
  var out = t.split('\\n').map(function (l) { return l.replace(/[ \\t]+$/, ''); }).join('\\n');
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "Collapse Blank Lines",
    "description": "Squeeze runs of blank lines down to a single blank line",
    "author": "Cade",
    "icon": "🗜",
    "tags": "clean,blank,empty,lines,collapse,squeeze"
  }
**/
function main(ctx) {
  var t = ctx.selection || ctx.fullText;
  var out = t.replace(/(\\n[ \\t]*){3,}/g, '\\n\\n');
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "Tabs → Spaces",
    "description": "Replace every tab with spaces (asks for width, default 4)",
    "author": "Cade",
    "icon": "⇥",
    "tags": "tabs,spaces,indent,convert,code"
  }
**/
function main(ctx) {
  var w = parseInt(prompt('Spaces per tab:', '4') || '0', 10);
  if (!w || w < 1 || w > 16) return;
  var t = ctx.selection || ctx.fullText;
  var out = t.replace(/\\t/g, Array(w + 1).join(' '));
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "Spaces → Tabs",
    "description": "Convert leading space indentation to tabs (asks for width, default 4)",
    "author": "Cade",
    "icon": "⇤",
    "tags": "tabs,spaces,indent,convert,code"
  }
**/
function main(ctx) {
  var w = parseInt(prompt('Spaces per tab:', '4') || '0', 10);
  if (!w || w < 1 || w > 16) return;
  var t = ctx.selection || ctx.fullText;
  var re = new RegExp('^(?:' + Array(w + 1).join(' ') + ')+', 'mg');
  var out = t.replace(re, function (m) { return Array(Math.floor(m.length / w) + 1).join('\\t') + Array((m.length % w) + 1).join(' '); });
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "Straighten Quotes",
    "description": "Replace smart/curly quotes and dashes with plain ASCII ones",
    "author": "Cade",
    "icon": "❝",
    "tags": "quotes,smart,curly,straighten,ascii,clean,code"
  }
**/
function main(ctx) {
  var t = ctx.selection || ctx.fullText;
  var out = t
    .replace(/[\\u2018\\u2019\\u201A\\u201B\\u2032]/g, "'")
    .replace(/[\\u201C\\u201D\\u201E\\u201F\\u2033]/g, '"')
    .replace(/[\\u2013\\u2014]/g, '-')
    .replace(/\\u2026/g, '...');
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "Sentence case",
    "description": "Lowercase everything, then capitalize the start of each sentence",
    "author": "Cade",
    "icon": "🔡",
    "tags": "case,sentence,capitalize,clean"
  }
**/
function main(ctx) {
  var t = ctx.selection || ctx.fullText;
  var out = t.toLowerCase().replace(/(^|[.!?]\\s+|\\n\\s*)([a-z])/g, function (m, pre, ch) { return pre + ch.toUpperCase(); });
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "Dedupe Lines (Ignore Case)",
    "description": "Remove duplicate lines, treating different cases as the same line",
    "author": "Cade",
    "icon": "🚿",
    "tags": "dedupe,unique,duplicate,lines,case,clean,list"
  }
**/
function main(ctx) {
  var t = ctx.selection || ctx.fullText;
  var seen = {};
  var out = t.split('\\n').filter(function (l) {
    var k = l.trim().toLowerCase();
    if (k === '') return true;
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  }).join('\\n');
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "Sort by Column",
    "description": "Sort lines by the Nth column (asks for delimiter and column number)",
    "author": "Cade",
    "icon": "🧮",
    "tags": "sort,column,csv,table,list,restructure"
  }
**/
function main(ctx) {
  var delim = prompt('Column delimiter (e.g. , or ; or | — \\\\t for tab):', ',');
  if (delim == null) return;
  if (delim === '\\\\t') delim = '\\t';
  if (delim === '') delim = ',';
  var col = parseInt(prompt('Sort by column number (1 = first):', '1') || '0', 10);
  if (!col || col < 1) return;
  var t = ctx.selection || ctx.fullText;
  var lines = t.split('\\n');
  var key = function (l) {
    var parts = l.split(delim);
    return (parts[col - 1] || '').trim();
  };
  lines.sort(function (a, b) {
    if (a.trim() === '') return 1;
    if (b.trim() === '') return -1;
    return key(a).localeCompare(key(b), undefined, { numeric: true, sensitivity: 'base' });
  });
  var out = lines.join('\\n');
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "Renumber Lists",
    "description": "Fix numbered lists so each run counts 1. 2. 3. again — supports 1. 1) and [1] (indent-aware)",
    "author": "Cade",
    "icon": "🔢",
    "tags": "renumber,list,numbered,bracket,markdown,restructure,fix"
  }
**/
function main(ctx) {
  var t = ctx.selection || ctx.fullText;
  var lines = t.split('\\n');
  var counters = {}; // indent -> current number
  for (var i = 0; i < lines.length; i++) {
    // Matches "1. x", "1) x" and "[1] x" — each line keeps its own style.
    var m = lines[i].match(/^(\\s*)(?:(\\d+)([.)])|\\[(\\d+)\\])(\\s+)(.*)$/);
    if (!m) {
      // A non-list, non-blank line ends every run; blank lines keep them alive
      if (lines[i].trim() !== '') counters = {};
      continue;
    }
    var indent = m[1];
    var bracketed = m[4] != null;
    var style = bracketed ? '[]' : m[3];
    // Deeper indent starts its own sequence; shallower resets deeper ones.
    for (var k in counters) { if (k.length > indent.length) delete counters[k]; }
    // A marker-style change (1. → [1] etc.) starts a fresh sequence too.
    var c = counters[indent];
    if (!c || c.style !== style) c = { n: 0, style: style };
    c.n++;
    counters[indent] = c;
    var marker = bracketed ? ('[' + c.n + ']') : (c.n + m[3]);
    lines[i] = indent + marker + m[5] + m[6];
  }
  var out = lines.join('\\n');
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "Fix Checkboxes",
    "description": "Normalize todo checkboxes: [] [ x ] [X] → [ ] and [x]",
    "author": "Cade",
    "icon": "☑",
    "tags": "todo,checkbox,fix,normalize,list,clean"
  }
**/
function main(ctx) {
  var t = ctx.selection || ctx.fullText;
  var out = t.split('\\n').map(function (l) {
    return l.replace(/^(\\s*(?:[-*•]\\s+)?)\\[\\s*([xX]?)\\s*\\]/, function (m, pre, x) {
      return pre + (x ? '[x]' : '[ ]');
    });
  }).join('\\n');
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "Normalize Unicode",
    "description": "NFC-normalize and strip zero-width/invisible characters",
    "author": "Cade",
    "icon": "🧼",
    "tags": "unicode,normalize,nfc,zero-width,invisible,clean"
  }
**/
function main(ctx) {
  var t = ctx.selection || ctx.fullText;
  var out = t.normalize('NFC')
    .replace(/[\\u200B\\u200C\\u200D\\u2060\\uFEFF\\u00AD]/g, '')
    .replace(/\\u00A0/g, ' ');
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "Remove ANSI Codes",
    "description": "Strip terminal color/escape sequences from pasted console output",
    "author": "Cade",
    "icon": "🖥",
    "tags": "ansi,escape,terminal,console,clean,code,log"
  }
**/
function main(ctx) {
  var t = ctx.selection || ctx.fullText;
  var out = t.replace(/\\u001b\\[[0-9;?]*[A-Za-z]/g, '').replace(/\\u001b\\][^\\u0007]*\\u0007/g, '');
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "CSV → Markdown Table",
    "description": "Turn comma-separated lines into a markdown table (first row = header)",
    "author": "Cade",
    "icon": "🧾",
    "tags": "csv,markdown,table,convert,restructure"
  }
**/
function main(ctx) {
  var t = (ctx.selection || ctx.fullText).replace(/\\r/g, '');
  var rows = t.split('\\n').filter(function (l) { return l.trim() !== ''; })
    .map(function (l) { return l.split(',').map(function (c) { return c.trim().replace(/\\|/g, '\\\\|'); }); });
  if (!rows.length) return;
  var cols = 0;
  rows.forEach(function (r) { if (r.length > cols) cols = r.length; });
  rows.forEach(function (r) { while (r.length < cols) r.push(''); });
  var line = function (r) { return '| ' + r.join(' | ') + ' |'; };
  var sep = '|' + Array(cols + 1).join(' --- |');
  var out = [line(rows[0]), sep].concat(rows.slice(1).map(line)).join('\\n');
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "Markdown Table → CSV",
    "description": "Turn a markdown table back into comma-separated lines",
    "author": "Cade",
    "icon": "📤",
    "tags": "markdown,table,csv,convert,restructure"
  }
**/
function main(ctx) {
  var t = ctx.selection || ctx.fullText;
  var out = t.split('\\n').filter(function (l) {
    var s = l.trim();
    if (!/^\\|.*\\|$/.test(s)) return s !== ''; // keep non-table lines? drop only separators below
    return !/^\\|[\\s:|-]+\\|$/.test(s);        // drop | --- | separator rows
  }).map(function (l) {
    var s = l.trim();
    if (!/^\\|.*\\|$/.test(s)) return l;
    return s.slice(1, -1).split('|').map(function (c) {
      c = c.trim().replace(/\\\\\\|/g, '|');
      return /[",\\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
    }).join(',');
  }).join('\\n');
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "Sort JSON Keys",
    "description": "Pretty-print JSON with all object keys sorted alphabetically (recursive)",
    "author": "Cade",
    "icon": "🗂",
    "tags": "json,sort,keys,format,code,clean"
  }
**/
function main(ctx) {
  var t = ctx.selection || ctx.fullText;
  var sortDeep = function (v) {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      var o = {};
      Object.keys(v).sort().forEach(function (k) { o[k] = sortDeep(v[k]); });
      return o;
    }
    return v;
  };
  try {
    var out = JSON.stringify(sortDeep(JSON.parse(t)), null, 2);
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  } catch (e) {
    showToast('Not valid JSON: ' + e.message, 'error', 3000);
  }
}`);

registerScript(`/**
  {
    "name": "Align Colons",
    "description": "Align the values after 'key:' across consecutive lines (config/YAML style)",
    "author": "Cade",
    "icon": "📐",
    "tags": "align,colon,yaml,config,format,code"
  }
**/
function main(ctx) {
  var t = ctx.selection || ctx.fullText;
  var lines = t.split('\\n');
  // Work in runs of consecutive matching lines so unrelated blocks keep their shape.
  var i = 0;
  while (i < lines.length) {
    var run = [];
    while (i < lines.length && /^(\\s*)([^:\\n]{1,60}?):(\\s+)\\S/.test(lines[i])) { run.push(i); i++; }
    if (run.length >= 2) {
      var width = 0;
      run.forEach(function (idx) {
        var m = lines[idx].match(/^(\\s*[^:\\n]{1,60}?):/);
        if (m && m[0].length > width) width = m[0].length;
      });
      run.forEach(function (idx) {
        var m = lines[idx].match(/^(\\s*[^:\\n]{1,60}?):(\\s+)(.*)$/);
        if (m) lines[idx] = (m[1] + ':') + Array(width - (m[1] + ':').length + 2).join(' ') + m[3];
      });
    }
    i++;
  }
  var out = lines.join('\\n');
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

registerScript(`/**
  {
    "name": "Prefix Lines…",
    "description": "Add a prefix to every line — or remove it if every line already has it",
    "author": "Cade",
    "icon": "▶",
    "tags": "prefix,comment,quote,lines,toggle,restructure,code"
  }
**/
function main(ctx) {
  var pre = prompt('Prefix to toggle (e.g. "// ", "# ", "> "):', '// ');
  if (pre == null || pre === '') return;
  var t = ctx.selection || ctx.fullText;
  var lines = t.split('\\n');
  var nonEmpty = lines.filter(function (l) { return l.trim() !== ''; });
  var allHave = nonEmpty.length > 0 && nonEmpty.every(function (l) { return l.indexOf(pre) === 0; });
  var out = lines.map(function (l) {
    if (l.trim() === '') return l;
    return allHave ? l.slice(pre.length) : pre + l;
  }).join('\\n');
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}`);

// ---------------------------------------------------------------------------
// Invisible characters. Written with String.raw (no doubled escapes); both
// scripts get the same detector appended to their source, since the core runs
// every script in isolation.
// ---------------------------------------------------------------------------
var INVIS_HELPERS = String.raw`

// Names for invisible / format / control characters: ⟦NAME⟧ tags, and what
// Remove turns them into ('space' → " ", 'line' → newline, else dropped).
var INVIS_NAMES = {
  0x0085: 'NEL', 0x007F: 'DEL', 0x00A0: 'NBSP', 0x00AD: 'SHY', 0x034F: 'CGJ', 0x061C: 'ALM',
  0x115F: 'HCF', 0x1160: 'HJF', 0x17B4: 'KIVAQ', 0x17B5: 'KIVAA', 0x180E: 'MVS',
  0x2000: 'NQSP', 0x2001: 'MQSP', 0x2002: 'ENSP', 0x2003: 'EMSP', 0x2004: '3/MSP', 0x2005: '4/MSP',
  0x2006: '6/MSP', 0x2007: 'FSP', 0x2008: 'PSP', 0x2009: 'THSP', 0x200A: 'HSP',
  0x200B: 'ZWSP', 0x200C: 'ZWNJ', 0x200D: 'ZWJ', 0x200E: 'LRM', 0x200F: 'RLM',
  0x2028: 'LSEP', 0x2029: 'PSEP', 0x202A: 'LRE', 0x202B: 'RLE', 0x202C: 'PDF', 0x202D: 'LRO',
  0x202E: 'RLO', 0x202F: 'NNBSP', 0x205F: 'MMSP', 0x2060: 'WJ', 0x2061: 'FA', 0x2062: 'IT',
  0x2063: 'IS', 0x2064: 'IP', 0x2066: 'LRI', 0x2067: 'RLI', 0x2068: 'FSI', 0x2069: 'PDI',
  0x2800: 'BLANK', 0x3000: 'IDSP', 0x3164: 'HF', 0xFEFF: 'BOM', 0xFFA0: 'HWHF',
  0xFFF9: 'IAA', 0xFFFA: 'IAS', 0xFFFB: 'IAT', 0xE0001: 'TAG-LANG', 0xE007F: 'TAG-END'
};
var INVIS_C0 = ['NUL','SOH','STX','ETX','EOT','ENQ','ACK','BEL','BS','HT','LF','VT','FF','CR','SO','SI',
  'DLE','DC1','DC2','DC3','DC4','NAK','SYN','ETB','CAN','EM','SUB','ESC','FS','GS','RS','US'];
var INVIS_SPACE = 'NBSP NQSP MQSP ENSP EMSP 3/MSP 4/MSP 6/MSP FSP PSP THSP HSP NNBSP MMSP IDSP BLANK'.split(' ');
var INVIS_LINE = 'NEL LSEP PSEP VT FF'.split(' ');

function invisKind(name) {
  return INVIS_SPACE.indexOf(name) >= 0 ? 'space' : INVIS_LINE.indexOf(name) >= 0 ? 'line' : 'drop';
}

function invisHex(cp) {
  var h = cp.toString(16).toUpperCase();
  return 'U+' + (h.length < 4 ? '0000'.slice(h.length) + h : h);
}

// Joining scripts (Arabic, Indic, …) use ZWJ / ZWNJ inside words on purpose.
function invisJoinLetter(ch) {
  return !!ch && /[\p{L}\p{M}]/u.test(ch) && !/[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u.test(ch);
}

// Tag name for the code point at cps[i], or null to leave it alone. Legit uses
// are kept: ZWJ inside emoji (👨‍👩‍👧) and joining-script words, variation
// selectors right after an emoji / CJK ideograph (❤️, 1️⃣), plus tab / newline / CR.
function invisName(cps, i) {
  var ch = cps[i], cp = ch.codePointAt(0);
  if (cp === 9 || cp === 10 || cp === 13) return null;
  if (cp < 32) return INVIS_C0[cp];
  if (cp >= 0xFE00 && cp <= 0xFE0F || cp >= 0xE0100 && cp <= 0xE01EF) {
    var prev = cps[i - 1];
    if (prev && /[\p{Emoji}\p{Ideographic}]/u.test(prev) && !/[︀-️\u{E0100}-\u{E01EF}]/u.test(prev)) return null;
    return 'VS' + (cp <= 0xFE0F ? cp - 0xFE00 + 1 : cp - 0xE0100 + 17);
  }
  if (cp === 0x200D || cp === 0x200C) {
    var j = i - 1;
    while (j >= 0 && /[︎️\u{1F3FB}-\u{1F3FF}]/u.test(cps[j])) j--;
    var before = cps[j], after = cps[i + 1];
    if (cp === 0x200D && before && after && /\p{Extended_Pictographic}/u.test(before) && /[\p{Extended_Pictographic}\p{Emoji}]/u.test(after)) return null;
    if (invisJoinLetter(cps[i - 1]) && invisJoinLetter(after)) return null;
  }
  if (INVIS_NAMES[cp]) return INVIS_NAMES[cp];
  // Prepended concatenation marks (Arabic number signs …) are Cf but visible.
  if (cp >= 0x0600 && cp <= 0x0605 || cp === 0x06DD || cp === 0x070F || cp === 0x0890 || cp === 0x0891 ||
      cp === 0x08E2 || cp === 0x110BD || cp === 0x110CD) return null;
  if (/[\p{Cc}\p{Cf}]/u.test(ch)) return invisHex(cp);
  return null;
}

// Walks the text and splices in hit(name, count) for each invisible (a run of
// ASCII tag characters — hidden "ASCII smuggling" text — comes as one hit,
// TAG:the hidden text). Flag tag sequences (🏴 + tags + cancel tag) are kept.
function invisWalk(text, hit) {
  var cps = Array.from(text), out = '', i = 0, n = cps.length;
  function isTag(c) { var x = c && c.codePointAt(0); return x >= 0xE0020 && x <= 0xE007F; }
  while (i < n) {
    var ch = cps[i], cp = ch.codePointAt(0);
    if (cp === 0x1F3F4 && isTag(cps[i + 1])) {
      var j = i + 1;
      while (j < n && isTag(cps[j]) && cps[j].codePointAt(0) !== 0xE007F) j++;
      if (j < n && cps[j].codePointAt(0) === 0xE007F) { out += cps.slice(i, j + 1).join(''); i = j + 1; continue; }
    }
    if (cp >= 0xE0020 && cp <= 0xE007E) {
      var hidden = '';
      while (i < n && cps[i].codePointAt(0) >= 0xE0020 && cps[i].codePointAt(0) <= 0xE007E) {
        hidden += String.fromCharCode(cps[i].codePointAt(0) - 0xE0000); i++;
      }
      out += hit('TAG:' + hidden, hidden.length);
      continue;
    }
    var name = invisName(cps, i);
    out += name ? hit(name, 1) : ch;
    i++;
  }
  return out;
}

// Matches the ⟦NAME⟧ tags Reveal writes (and only those).
function invisTagRe() {
  var names = Object.keys(INVIS_NAMES).map(function (k) { return INVIS_NAMES[k]; }).concat(INVIS_C0);
  var alt = names.map(function (s) { return s.replace(/[.*+?^$()|[\]\\\/{}-]/g, '\\$&'); }).join('|');
  return new RegExp('⟦(' + alt + '|U\\+[0-9A-F]{4,6}|VS\\d{1,3}|TAG:[\\x20-\\x7E]*?)⟧', 'g');
}

function invisSummary(counts) {
  return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 6)
    .map(function (k) { return counts[k] + '× ' + k; }).join(', ') + (Object.keys(counts).length > 6 ? ', …' : '');
}
`;

registerScript(String.raw`/**
  {
    "name": "Reveal Invisible Characters",
    "description": "Show hidden characters as tags — ⟦ZWSP⟧ ⟦NBSP⟧ ⟦BOM⟧ ⟦SHY⟧ ⟦RLO⟧, control codes, stray variation selectors, hidden tag text — with a count of each",
    "author": "Cade",
    "icon": "👁",
    "tags": "invisible,hidden,reveal,show,zero-width,zwsp,zwj,nbsp,bom,soft hyphen,bidi,rtl,control,characters,unicode,watermark,smuggling,debug,clean"
  }
**/
function main(ctx) {
  var t = ctx.selection || ctx.fullText;
  var counts = {}, total = 0;
  var out = invisWalk(t, function (name, n) {
    var key = name.indexOf('TAG:') === 0 ? 'TAG' : name;
    counts[key] = (counts[key] || 0) + n; total += n;
    return '⟦' + name + '⟧';
  });
  if (!total) { showToast('No invisible characters found', 'info', 2500); return; }
  showToast('Found ' + total + ' invisible character' + (total === 1 ? '' : 's') + ': ' + invisSummary(counts), 'success', 4500);
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}` + INVIS_HELPERS);

registerScript(String.raw`/**
  {
    "name": "Remove Invisible Characters",
    "description": "Strip zero-width characters, BOMs, soft hyphens, bidi and control codes (and Reveal's ⟦…⟧ tags) — odd spaces like NBSP become normal spaces; tabs, newlines and emoji joiners are kept",
    "author": "Cade",
    "icon": "✨",
    "tags": "invisible,hidden,remove,strip,delete,zero-width,zwsp,zwj,nbsp,bom,soft hyphen,bidi,control,characters,unicode,watermark,clean,sanitize"
  }
**/
function main(ctx) {
  var t = ctx.selection || ctx.fullText;
  var total = 0;
  function swap(name) { var k = invisKind(name); return k === 'space' ? ' ' : k === 'line' ? '\n' : ''; }
  var out = t.replace(invisTagRe(), function (m, name) { total++; return swap(name); });
  out = invisWalk(out, function (name, n) { total += n; return swap(name); });
  if (!total) { showToast('No invisible characters found', 'info', 2500); return; }
  showToast('Removed ' + total + ' invisible character' + (total === 1 ? '' : 's'), 'success', 3000);
  if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
}` + INVIS_HELPERS);

})();
