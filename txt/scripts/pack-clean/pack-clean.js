/* Clean & Restructure Pack — whitespace, list, table and code cleanup
   transforms. Script-pack module: one file registering 17 palette scripts.
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

})();
