/* Data Pack — JSON, tables, extraction and splitting.
   Script-pack module: one file registering 28 palette scripts.
   The first 12 were extracted verbatim from txt.html (core slimming); the
   rest share the engine below (window.__CADE_DATA__). */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var registerScript = function (src) { window.Cade.registerScript(src); };

registerScript(`/**
  {
    "name": "Sum",
    "description": "Sum numbers: 1,2,3 or 1 2 3 or one per line (handles trailing commas)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='12' y1='5' x2='12' y2='19'/><line x1='5' y1='12' x2='19' y2='12'/></svg>",
    "tags": "sum,add,total,math,numbers,calculator"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const lines = text.split('\\n').map(l => l.trim()).filter(Boolean);
  let numbers = [];
  if (lines.length === 1) {
    // Single line: try comma-separated first, then space-separated
    const line = lines[0].replace(/,\\s*$/,''); // strip trailing comma
    if (line.includes(',')) {
      numbers = line.split(',').map(s => s.trim()).filter(Boolean).map(s => parseFloat(s.replace(/[^\\d.\\-]/g, '')));
    } else if (line.includes(' ')) {
      numbers = line.split(/\\s+/).map(s => parseFloat(s.replace(/[^\\d.\\-]/g, '')));
    } else {
      numbers = [parseFloat(line.replace(/[^\\d.\\-]/g, ''))];
    }
  } else {
    // Multi-line: one number per line (strip trailing commas)
    numbers = lines.map(l => l.replace(/,\\s*$/, '')).map(s => parseFloat(s.replace(/[^\\d.\\-]/g, '')));
  }
  numbers = numbers.filter(n => !isNaN(n));
  if (numbers.length === 0) { showToast('No numbers found', 'error'); return; }
  const sum = numbers.reduce((a, b) => a + b, 0);
  const result = text + '\\n\\n= ' + sum.toLocaleString('en-US', { maximumFractionDigits: 10 });
  if (ctx.selection) { ctx.selection = result; }
  else { ctx.fullText = result; }
}`);

registerScript(`/**
  {
    "name": "JSON Format",
    "description": "Pretty-print JSON with 2-space indentation",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1'/><path d='M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1'/></svg>",
    "tags": "json,format,pretty,print,beautify"
  }
**/
function main(ctx) {
  try {
    const text = ctx.selection || ctx.fullText;
    const formatted = JSON.stringify(JSON.parse(text), null, 2);
    if (ctx.selection) ctx.selection = formatted; else ctx.fullText = formatted;
  } catch (e) { throw new Error('Invalid JSON: ' + e.message); }
}`);

registerScript(`/**
  {
    "name": "JSON Minify",
    "description": "Minify JSON by removing whitespace",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1'/><path d='M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1'/><line x1='8' y1='12' x2='16' y2='12'/></svg>",
    "tags": "json,minify,compact,compress"
  }
**/
function main(ctx) {
  try {
    const text = ctx.selection || ctx.fullText;
    const minified = JSON.stringify(JSON.parse(text));
    if (ctx.selection) ctx.selection = minified; else ctx.fullText = minified;
  } catch (e) { throw new Error('Invalid JSON: ' + e.message); }
}`);

registerScript(`/**
  {
    "name": "Split by Comma",
    "description": "Split comma-separated text into separate lines",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='12' y1='2' x2='12' y2='22'/><line x1='4' y1='12' x2='20' y2='12'/></svg>",
    "tags": "split,comma,lines,csv,separate"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const result = text.split(',').map(s => s.trim()).filter(Boolean).join('\\n');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Split by Delimiter",
    "description": "Split text by a custom delimiter into separate lines",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='12' y1='2' x2='12' y2='22'/><path d='M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'/></svg>",
    "tags": "split,lines,delimiter,separate,explode"
  }
**/
function main(ctx) {
  const delim = prompt('Delimiter to split on:', ',');
  if (delim === null) return;
  const text = ctx.selection || ctx.fullText;
  const result = text.split(delim).map(s => s.trim()).join('\\n');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Split (Keep Delimiter)",
    "description": "One entry per line, split on a delimiter but KEEP the delimiter in the text",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='12' y1='2' x2='12' y2='22'/><path d='M5 9h14'/></svg>",
    "tags": "split,keep,delimiter,lines,separate,unflatten,explode"
  }
**/
function main(ctx) {
  const delim = prompt('Delimiter to split on (kept in text):', ',');
  if (delim === null || delim === '') return;
  const text = ctx.selection || ctx.fullText;
  const parts = text.split(delim);
  const result = parts
    .map((p, i) => i < parts.length - 1 ? p + delim : p)
    .map(s => s.trim())
    .filter(s => s.length)
    .join('\\n');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Format Table",
    "description": "Align Markdown pipe-table columns (respects :--- alignment)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2'/><line x1='3' y1='9' x2='21' y2='9'/><line x1='3' y1='15' x2='21' y2='15'/><line x1='12' y1='3' x2='12' y2='21'/></svg>",
    "tags": "table,align,markdown,format,pipe,columns"
  }
**/
function main(ctx) {
  const usingSel = !!ctx.selection;
  const text = usingSel ? ctx.selection : ctx.fullText;
  const lines = text.split('\\n');
  const isRow = l => l.indexOf('|') !== -1;
  const isSep = l => /^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$/.test(l);
  const parseCells = l => {
    let s = l.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map(c => c.trim());
  };
  const pad = (s, w, a) => {
    s = s || '';
    const d = w - s.length;
    if (d <= 0) return s;
    if (a === 'r') return ' '.repeat(d) + s;
    if (a === 'c') { const l = Math.floor(d / 2); return ' '.repeat(l) + s + ' '.repeat(d - l); }
    return s + ' '.repeat(d);
  };
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      let j = i; const block = [];
      while (j < lines.length && isRow(lines[j])) { block.push(lines[j]); j++; }
      const rows = block.map(parseCells);
      const aligns = parseCells(block[1]).map(c => {
        const L = c.startsWith(':'), R = c.endsWith(':');
        return L && R ? 'c' : R ? 'r' : L ? 'l2' : 'l';
      });
      const ncol = Math.max.apply(null, rows.map(r => r.length));
      const widths = [];
      for (let c = 0; c < ncol; c++) {
        let w = 3;
        for (let r = 0; r < rows.length; r++) { if (r === 1) continue; const cell = (rows[r][c] || ''); if (cell.length > w) w = cell.length; }
        widths[c] = w;
      }
      for (let r = 0; r < rows.length; r++) {
        if (r === 1) {
          const seps = [];
          for (let c = 0; c < ncol; c++) {
            const a = aligns[c] || 'l', w = widths[c];
            if (a === 'c') seps.push(':' + '-'.repeat(Math.max(1, w - 2)) + ':');
            else if (a === 'r') seps.push('-'.repeat(Math.max(2, w - 1)) + ':');
            else if (a === 'l2') seps.push(':' + '-'.repeat(Math.max(2, w - 1)));
            else seps.push('-'.repeat(Math.max(3, w)));
          }
          out.push('| ' + seps.join(' | ') + ' |');
        } else {
          const cells = [];
          for (let c = 0; c < ncol; c++) cells.push(pad(rows[r][c], widths[c], aligns[c]));
          out.push('| ' + cells.join(' | ') + ' |');
        }
      }
      i = j;
    } else { out.push(lines[i]); i++; }
  }
  const joined = out.join('\\n');
  if (usingSel) ctx.selection = joined; else ctx.fullText = joined;
}`);

registerScript(`/**
  {
    "name": "Find & Replace",
    "description": "Find and replace text (supports regex)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='11' cy='11' r='8'/><line x1='21' y1='21' x2='16.65' y2='16.65'/><line x1='8' y1='11' x2='14' y2='11'/></svg>",
    "tags": "find,replace,search,regex,substitute"
  }
**/
function main(ctx) {
  const find = prompt('Find (regex supported):');
  if (!find) return;
  const replace = prompt('Replace with:', '') || '';
  const text = ctx.selection || ctx.fullText;
  try {
    const regex = new RegExp(find, 'g');
    const result = text.replace(regex, replace);
    const count = (text.match(regex) || []).length;
    if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
    showToast(count + ' replacement' + (count !== 1 ? 's' : '') + ' made', 'success', 2500);
  } catch (e) {
    throw new Error('Invalid regex: ' + e.message);
  }
}`);

registerScript(`/**
  {
    "name": "Extract Emails",
    "description": "Extract all email addresses from text",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z'/><polyline points='22,6 12,13 2,6'/></svg>",
    "tags": "extract,email,emails,address,parse"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const emails = text.match(/[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}/g) || [];
  const unique = [...new Set(emails)];
  if (unique.length === 0) { showToast('No emails found', 'info', 2500); return; }
  ctx.fullText = ctx.fullText + '\\n\\n--- Emails Found (' + unique.length + ') ---\\n' + unique.join('\\n');
}`);

registerScript(`/**
  {
    "name": "Extract URLs",
    "description": "Extract all URLs from text",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'/><path d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'/></svg>",
    "tags": "extract,url,urls,links,http,parse"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const urls = text.match(/https?:\\/\\/[^\\s<>"'\\)\\]]+/g) || [];
  const unique = [...new Set(urls)];
  if (unique.length === 0) { showToast('No URLs found', 'info', 2500); return; }
  ctx.fullText = ctx.fullText + '\\n\\n--- URLs Found (' + unique.length + ') ---\\n' + unique.join('\\n');
}`);

registerScript(`/**
  {
    "name": "Extract Numbers",
    "description": "Extract all numbers from text",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 9h16'/><path d='M4 15h16'/><path d='M10 3 8 21'/><path d='M16 3 14 21'/></svg>",
    "tags": "extract,numbers,digits,parse,numeric"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const numbers = text.match(/-?[\\d,]+(\\.[\\d]+)?/g) || [];
  if (numbers.length === 0) { showToast('No numbers found', 'info', 2500); return; }
  ctx.fullText = ctx.fullText + '\\n\\n--- Numbers Found (' + numbers.length + ') ---\\n' + numbers.join('\\n');
}`);

registerScript(`/**
  {
    "name": "Markdown Table",
    "description": "Convert tab or comma separated data to a Markdown table",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2'/><line x1='3' y1='9' x2='21' y2='9'/><line x1='3' y1='15' x2='21' y2='15'/><line x1='9' y1='3' x2='9' y2='21'/><line x1='15' y1='3' x2='15' y2='21'/></svg>",
    "tags": "markdown,table,csv,tsv,convert,format"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const lines = text.split('\\n').filter(l => l.trim());
  if (lines.length < 1) { showToast('Need at least one row', 'error'); return; }
  const delim = lines[0].includes('\\t') ? '\\t' : ',';
  const rows = lines.map(l => l.split(delim).map(c => c.trim()));
  const cols = Math.max(...rows.map(r => r.length));
  const padded = rows.map(r => { while (r.length < cols) r.push(''); return r; });
  const widths = Array.from({length: cols}, (_, i) => Math.max(...padded.map(r => r[i].length), 3));
  const header = '| ' + padded[0].map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
  const sep = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';
  const body = padded.slice(1).map(r => '| ' + r.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |').join('\\n');
  const result = header + '\\n' + sep + (body ? '\\n' + body : '');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

// ===========================================================================
// Shared engine for the scripts below (CSV / Markdown tables, JSON shape
// inference, SQL, extraction). Plain JS so it needs no template-literal
// escaping; each script's main() calls window.__CADE_DATA__.run(...).
// ===========================================================================
var D = {};

// ---------------------------------------------------------------- tables
// RFC-4180: quoted fields, "" escapes, embedded newlines / delimiters.
// Unquoted fields are trimmed; a quote may follow leading spaces ("a, "b"").
D.parseDelimited = function (text, delim) {
  var rows = [], row = [], field = '', i = 0, n = text.length;
  var inQ = false, quoted = false, afterQ = false;
  function endField() { row.push(quoted ? field : field.trim()); field = ''; quoted = false; afterQ = false; }
  function endRow() {
    var q = quoted;
    endField();
    if (!(row.length === 1 && row[0] === '' && !q)) rows.push(row);
    row = [];
  }
  while (i < n) {
    var c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; afterQ = true; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === delim) { endField(); i++; continue; }
    if (c === '\n' || c === '\r') { endRow(); if (c === '\r' && text[i + 1] === '\n') i++; i++; continue; }
    if (c === '"' && !quoted && field.trim() === '') { field = ''; inQ = true; quoted = true; i++; continue; }
    if (afterQ && (c === ' ' || c === '\t')) { i++; continue; }
    field += c; i++;
  }
  if (inQ || field !== '' || row.length || quoted) endRow();
  return rows;
};

D.DELIMS = ['\t', ',', ';', '|'];
D.detectDelimiter = function (text) {
  var best = ',', bestScore = 0;
  D.DELIMS.forEach(function (d) {
    if (text.indexOf(d) === -1) return;
    var rows = D.parseDelimited(text, d).slice(0, 25);
    if (!rows.length) return;
    var h = rows[0].length;
    if (h < 2) return;
    var same = rows.filter(function (r) { return r.length === h; }).length;
    var score = same * 100 + Math.min(h, 99);
    if (score > bestScore) { bestScore = score; best = d; }
  });
  return best;
};

var MD_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
D.mdCells = function (line) {
  var s = line.trim();
  if (s[0] === '|') s = s.slice(1);
  if (s.slice(-1) === '|' && s.slice(-2) !== '\\|') s = s.slice(0, -1);
  var cells = [], cur = '';
  for (var i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
};
// Markdown pipe tables in `lines`: [{start, end (exclusive), rows, aligns}]
D.mdBlocks = function (lines) {
  var out = [];
  for (var i = 0; i + 1 < lines.length; i++) {
    if (lines[i].indexOf('|') === -1 || lines[i + 1].indexOf('|') === -1 || !MD_SEP.test(lines[i + 1])) continue;
    var j = i + 2;
    while (j < lines.length && lines[j].trim() !== '' && lines[j].indexOf('|') !== -1) j++;
    var aligns = D.mdCells(lines[i + 1]).map(function (c) {
      var l = c[0] === ':', r = c.slice(-1) === ':';
      return l && r ? 'c' : r ? 'r' : l ? 'l' : '';
    });
    var rows = [D.mdCells(lines[i])].concat(lines.slice(i + 2, j).map(D.mdCells));
    out.push({ start: i, end: j, rows: rows, aligns: aligns });
    i = j - 1;
  }
  return out;
};

D.padRows = function (rows) {
  var w = 0;
  rows.forEach(function (r) { if (r.length > w) w = r.length; });
  return rows.map(function (r) { r = r.slice(); while (r.length < w) r.push(''); return r; });
};

D.writeCSV = function (rows, delim) {
  return rows.map(function (r) {
    return r.map(function (f) {
      f = f == null ? '' : String(f);
      return (f.indexOf(delim) !== -1 || /["\r\n]/.test(f) || f !== f.trim()) ? '"' + f.replace(/"/g, '""') + '"' : f;
    }).join(delim);
  }).join('\n');
};

D.writeMd = function (rows, aligns) {
  rows = D.padRows(rows.map(function (r) {
    return r.map(function (c) { return String(c == null ? '' : c).replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|'); });
  }));
  if (!rows.length) return '';
  var nc = rows[0].length, widths = [];
  for (var c = 0; c < nc; c++) {
    var w = 3;
    rows.forEach(function (r) { if (r[c].length > w) w = r[c].length; });
    widths.push(w);
  }
  aligns = aligns || [];
  var pad = function (s, w, a) {
    var d = w - s.length;
    if (d <= 0) return s;
    if (a === 'r') return ' '.repeat(d) + s;
    if (a === 'c') { var l = Math.floor(d / 2); return ' '.repeat(l) + s + ' '.repeat(d - l); }
    return s + ' '.repeat(d);
  };
  var line = function (r) { return '| ' + r.map(function (s, i) { return pad(s, widths[i], aligns[i]); }).join(' | ') + ' |'; };
  var sep = '| ' + widths.map(function (w, i) {
    var a = aligns[i];
    if (a === 'c') return ':' + '-'.repeat(w - 2) + ':';
    if (a === 'r') return '-'.repeat(w - 1) + ':';
    if (a === 'l') return ':' + '-'.repeat(w - 1);
    return '-'.repeat(w);
  }).join(' | ') + ' |';
  return [line(rows[0]), sep].concat(rows.slice(1).map(line)).join('\n');
};

// Apply fn(rows, aligns) -> {text} | {rows, aligns} to every Markdown table in
// `text` (other lines untouched), else to the whole text as CSV / TSV.
D.mapTables = function (text, fn) {
  var lines = text.split('\n');
  var blocks = D.mdBlocks(lines);
  if (blocks.length) {
    for (var b = blocks.length - 1; b >= 0; b--) {
      var blk = blocks[b];
      var r = fn(blk.rows, blk.aligns, 'md');
      var out = r.text != null ? r.text : D.writeMd(r.rows, r.aligns);
      lines.splice(blk.start, blk.end - blk.start, out);
    }
    return lines.join('\n');
  }
  var trail = /\s*$/.exec(text)[0];
  var body = text.slice(0, text.length - trail.length);
  if (!body.trim()) throw new Error('No table found (CSV, TSV or a Markdown table)');
  var delim = D.detectDelimiter(body);
  var rows = D.parseDelimited(body, delim);
  var res = fn(rows, null, 'csv');
  return (res.text != null ? res.text : D.writeCSV(res.rows, delim)) + trail;
};

// "007" stays a string; long integers that lose precision stay strings.
D.typeCell = function (s) {
  if (/^-?(0|[1-9]\d*)$/.test(s)) { var n = Number(s); return s !== '-0' && Number.isSafeInteger(n) ? n : s; }
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s)) { var f = Number(s); return isFinite(f) ? f : s; }
  if (/^(true|TRUE|True)$/.test(s)) return true;
  if (/^(false|FALSE|False)$/.test(s)) return false;
  if (/^(null|NULL|Null)$/.test(s)) return null;
  return s;
};

D.rowsToObjects = function (rows) {
  if (!rows.length) return [];
  var seen = Object.create(null);
  var head = rows[0].map(function (h, i) {
    var k = h === '' ? 'column' + (i + 1) : h, base = k, n = 2;
    while (seen[k]) k = base + '_' + n++;
    seen[k] = 1;
    return k;
  });
  return rows.slice(1).filter(function (r) { return r.some(function (c) { return c !== ''; }); }).map(function (r) {
    var o = {};
    var w = Math.max(r.length, head.length);
    for (var i = 0; i < w; i++) {
      var k = i < head.length ? head[i] : 'column' + (i + 1);
      Object.defineProperty(o, k, { value: D.typeCell(i < r.length ? r[i] : ''), enumerable: true, writable: true, configurable: true });
    }
    return o;
  });
};

D.csvToJson = function (text) {
  return D.mapTables(text, function (rows) { return { text: JSON.stringify(D.rowsToObjects(rows), null, 2) }; });
};

D.transpose = function (text) {
  return D.mapTables(text, function (rows, aligns, kind) {
    rows = D.padRows(rows);
    var t = [];
    for (var c = 0; c < (rows[0] ? rows[0].length : 0); c++) t.push(rows.map(function (r) { return r[c]; }));
    return { rows: t, aligns: null };
  });
};

// spec: "name, email, 3", "2-4", "-notes" (drop). Names win over numbers.
D.resolveColumns = function (spec, header) {
  var toks = [], m, re = /\s*("((?:[^"]|"")*)"|[^,]+)\s*(,|$)/g;
  while ((m = re.exec(spec)) && m[0] !== '') {
    var raw = m[2] != null ? m[2].replace(/""/g, '"') : m[1].trim();
    if (raw !== '' || m[2] != null) toks.push({ raw: raw, quoted: m[2] != null });
    if (m.index + m[0].length >= spec.length) break;
  }
  var find = function (name) {
    var i = header.indexOf(name);
    if (i !== -1) return [i];
    var lower = name.toLowerCase();
    for (var k = 0; k < header.length; k++) if (header[k].toLowerCase() === lower) return [k];
    var rg;
    if (/^\d+$/.test(name)) { var n = +name; return n >= 1 && n <= header.length ? [n - 1] : null; }
    if ((rg = /^(\d+)\s*-\s*(\d+)$/.exec(name))) {
      var a = +rg[1], b = +rg[2], out = [];
      if (a < 1 || b < 1 || a > header.length || b > header.length) return null;
      for (var x = a; a <= b ? x <= b : x >= b; x += a <= b ? 1 : -1) out.push(x - 1);
      return out;
    }
    return null;
  };
  var keep = [], drop = [], unknown = [];
  toks.forEach(function (t) {
    var neg = !t.quoted && t.raw[0] === '-' && t.raw.length > 1 && header.indexOf(t.raw) === -1;
    var name = neg ? t.raw.slice(1).trim().replace(/^"(.*)"$/, '$1') : t.raw;
    var idx = find(name);
    if (!idx) { unknown.push(t.raw); return; }
    (neg ? drop : keep).push.apply(neg ? drop : keep, idx);
  });
  if (unknown.length) throw new Error('Unknown column' + (unknown.length > 1 ? 's' : '') + ': ' + unknown.join(', ') + ' (have: ' + header.join(', ') + ')');
  if (!keep.length) for (var i = 0; i < header.length; i++) keep.push(i);
  var res = keep.filter(function (i) { return drop.indexOf(i) === -1; });
  if (!res.length) throw new Error('That would remove every column');
  return res;
};

D.tableHeader = function (text) {
  var lines = text.split('\n'), blocks = D.mdBlocks(lines);
  if (blocks.length) return blocks[0].rows[0];
  var body = text.trim();
  if (!body) return null;
  var rows = D.parseDelimited(body, D.detectDelimiter(body));
  return rows.length ? rows[0] : null;
};

D.selectColumns = function (text, spec) {
  return D.mapTables(text, function (rows, aligns) {
    rows = D.padRows(rows);
    var idx = D.resolveColumns(spec, rows[0] || []);
    return {
      rows: rows.map(function (r) { return idx.map(function (i) { return r[i]; }); }),
      aligns: aligns ? idx.map(function (i) { return aligns[i] || ''; }) : null,
    };
  });
};

// ---------------------------------------------------------------- JSON
D.parseJSON = function (text) {
  try { return JSON.parse(text); } catch (e) { throw new Error('Invalid JSON: ' + e.message); }
};

D.getPath = function (o, path) {
  if (o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, path)) return o[path];
  var parts = path.split('.');
  for (var i = 0; i < parts.length; i++) {
    if (o == null || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, parts[i])) return undefined;
    o = o[parts[i]];
  }
  return o;
};

D.dedupeByKey = function (text, path) {
  var data = D.parseJSON(text);
  if (!Array.isArray(data)) throw new Error('Expected a JSON array');
  var seen = new Set(), out = [], hits = 0;
  data.forEach(function (item) {
    var v = D.getPath(item, path);
    if (v === undefined) { out.push(item); return; }
    hits++;
    var k = JSON.stringify(v);
    if (seen.has(k)) return;
    seen.add(k); out.push(item);
  });
  if (!hits && data.length) throw new Error('No item has the key "' + path + '"');
  var lead = /^\s*/.exec(text)[0], trail = /\s*$/.exec(text)[0];
  var body = text.trim(), lines = body.split('\n'), json;
  if (lines.length === 1) json = JSON.stringify(out);
  else if (data.length > 1 && lines.length <= data.length + 2 && /^\[\s*$/.test(lines[0])) {
    // one compact item per line
    var ind = /^\s*/.exec(lines[1])[0], spaced = /^\s*[\[{].*(": |, )/.test(lines[1]);
    json = out.length ? '[\n' + out.map(function (x) { return ind + D.compact(x, spaced); }).join(',\n') + '\n]' : '[]';
  } else {
    var m = /\n([ \t]+)\S/.exec(body);
    var indent = m ? (m[1][0] === '\t' ? '\t' : m[1].length) : 2;
    json = JSON.stringify(out, null, indent);
  }
  return { text: lead + json + trail, removed: data.length - out.length };
};

// one-line JSON, optionally with a space after ":" and "," ({"a": 1, "b": [1, 2]})
D.compact = function (v, spaced) {
  if (!spaced || v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(function (x) { return D.compact(x === undefined ? null : x, true); }).join(', ') + ']';
  return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; })
    .map(function (k) { return JSON.stringify(k) + ': ' + D.compact(v[k], true); }).join(', ') + '}';
};

D.strFormat = function (s) {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'email';
  if (/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(s)) return 'date-time';
  if (/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s)) return 'date';
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)) return 'uuid';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$/.test(s)) return 'uri';
  return null;
};

D.newShape = function () { return { nul: false, bool: false, int: false, num: false, str: false, fmt: undefined, arr: null, obj: null }; };
D.addValue = function (sh, v) {
  if (v === null) sh.nul = true;
  else if (typeof v === 'boolean') sh.bool = true;
  else if (typeof v === 'number') { if (Number.isInteger(v)) sh.int = true; else sh.num = true; }
  else if (typeof v === 'string') {
    sh.str = true;
    var f = D.strFormat(v);
    sh.fmt = sh.fmt === undefined ? f : (sh.fmt === f ? f : null);
  } else if (Array.isArray(v)) {
    if (!sh.arr) sh.arr = D.newShape();
    v.forEach(function (x) { D.addValue(sh.arr, x); });
  } else if (typeof v === 'object') {
    if (!sh.obj) sh.obj = { n: 0, keys: [], props: Object.create(null) };
    sh.obj.n++;
    Object.keys(v).forEach(function (k) {
      var p = sh.obj.props[k];
      if (!p) { p = sh.obj.props[k] = { n: 0, shape: D.newShape() }; sh.obj.keys.push(k); }
      p.n++;
      D.addValue(p.shape, v[k]);
    });
  }
  return sh;
};
D.hasType = function (sh) { return sh.nul || sh.bool || sh.int || sh.num || sh.str || !!sh.arr || !!sh.obj; };

D.toSchema = function (sh) {
  var s = Object.create(null), types = [];
  if (sh.obj) types.push('object');
  if (sh.arr) types.push('array');
  if (sh.str) types.push('string');
  if (sh.num) types.push('number'); else if (sh.int) types.push('integer');
  if (sh.bool) types.push('boolean');
  if (sh.nul) types.push('null');
  if (!types.length) return s;
  s.type = types.length === 1 ? types[0] : types;
  if (sh.str && sh.fmt) s.format = sh.fmt;
  if (sh.obj) {
    var props = Object.create(null), req = [];
    sh.obj.keys.forEach(function (k) {
      var p = sh.obj.props[k];
      props[k] = D.toSchema(p.shape);
      if (p.n === sh.obj.n) req.push(k);
    });
    s.properties = props;
    if (req.length) s.required = req;
  }
  if (sh.arr) s.items = D.toSchema(sh.arr);
  return s;
};
D.jsonSchema = function (text) {
  var sh = D.addValue(D.newShape(), D.parseJSON(text));
  var s = D.toSchema(sh), root = Object.create(null);
  root.$schema = 'https://json-schema.org/draft/2020-12/schema';
  Object.keys(s).forEach(function (k) { root[k] = s[k]; });
  return JSON.stringify(root, null, 2);
};

// ---- names for generated types
D.words = function (s) {
  return String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/).filter(Boolean);
};
var GO_INITIALISMS = 'ACL API ASCII CPU CSS DNS EOF GUID HTML HTTP HTTPS ID IP JSON LHS QPS RAM RHS RPC SKU SLA SMTP SQL SSH TCP TLS TTL UDP UI UID UUID URI URL UTF8 VM XML XMPP XSRF XSS'.split(' ');
D.pascal = function (s, go) {
  var p = D.words(s).map(function (w) {
    if (go && GO_INITIALISMS.indexOf(w.toUpperCase()) !== -1) return w.toUpperCase();
    return w[0].toUpperCase() + w.slice(1);
  }).join('');
  return p;
};
D.singular = function (name) {
  if (/[^aeiou]ies$/i.test(name)) return name.slice(0, -3) + 'y';
  if (/(ss|us|is)$/i.test(name)) return name + 'Item';
  if (/(x|ch|sh|ss)es$/i.test(name)) return name.slice(0, -2);
  if (/[^s]s$/i.test(name)) return name.slice(0, -1);
  return name + 'Item';
};
function uniqueName(used, base) {
  var name = base, n = 2;
  while (used.has(name)) name = base + n++;
  used.add(name);
  return name;
}
function typeName(key, go, fallback) {
  var p = D.pascal(key, go);
  if (!p) p = fallback;
  if (/^\d/.test(p)) p = fallback + p;
  return p;
}

// Root of a JSON → class/struct conversion: an object, or an array of objects.
function rootShape(text) {
  var data = D.parseJSON(text);
  var sh = D.addValue(D.newShape(), data);
  var ok = (sh.obj && !Array.isArray(data)) || (Array.isArray(data) && sh.arr && sh.arr.obj);
  if (!ok) throw new Error('Expected a JSON object or an array of objects');
  return { sh: sh, isArray: Array.isArray(data) };
}

var PY_KEYWORDS = 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' ');
D.pyIdent = function (k) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && PY_KEYWORDS.indexOf(k) === -1) return k;
  var s = String(k).replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '');
  if (!s) s = 'field';
  if (/^\p{N}/u.test(s)) s = '_' + s;
  if (PY_KEYWORDS.indexOf(s) !== -1) s += '_';
  return s;
};

D.pythonDataclass = function (text) {
  var r = rootShape(text);
  var used = new Set(['Any', 'Dict', 'List', 'Optional', 'Union', 'dataclass', 'annotations']);
  var typing = new Set(), classes = [];
  function base(sh, hint) {
    var parts = [];
    if (sh.obj) {
      if (sh.obj.keys.length) parts.push(klass(sh.obj, hint));
      else { typing.add('Dict'); typing.add('Any'); parts.push('Dict[str, Any]'); }
    }
    if (sh.arr) {
      typing.add('List');
      var it = D.hasType(sh.arr) ? base(sh.arr, D.singular(typeName(hint, false, 'Item'))) : (typing.add('Any'), 'Any');
      if (sh.arr.nul && it !== 'Any') { typing.add('Optional'); it = 'Optional[' + it + ']'; }
      parts.push('List[' + it + ']');
    }
    if (sh.str) parts.push('str');
    if (sh.num) parts.push('float'); else if (sh.int) parts.push('int');
    if (sh.bool) parts.push('bool');
    if (!parts.length) { typing.add('Any'); return 'Any'; }
    if (parts.length === 1) return parts[0];
    typing.add('Union');
    return 'Union[' + parts.join(', ') + ']';
  }
  function klass(obj, hint) {
    var name = uniqueName(used, typeName(hint, false, 'Item'));
    var idents = new Set(), req = [], opt = [];
    obj.keys.forEach(function (k) {
      var p = obj.props[k];
      var id = uniqueName(idents, D.pyIdent(k));
      var t = base(p.shape, k);
      var optional = p.n < obj.n || p.shape.nul;
      var line = '    ' + id + ': ';
      if (optional) { typing.add('Optional'); line += 'Optional[' + t + '] = None'; }
      else line += t;
      if (id !== k) line += '  # ' + JSON.stringify(k);
      (optional ? opt : req).push(line);
    });
    classes.push('@dataclass\nclass ' + name + ':\n' + req.concat(opt).join('\n'));
    return name;
  }
  if (r.isArray) used.add('Root');
  var alias = r.isArray ? 'Root = ' + base(r.sh, 'Root') : (base(r.sh, 'Root'), null);
  var head = ['from __future__ import annotations', '', 'from dataclasses import dataclass'];
  var ty = ['Any', 'Dict', 'List', 'Optional', 'Union'].filter(function (t) { return typing.has(t); });
  if (ty.length) head.push('from typing import ' + ty.join(', '));
  return head.join('\n') + '\n\n\n' + classes.concat(alias ? [alias] : []).join('\n\n\n') + '\n';
};

D.goStruct = function (text) {
  var r = rootShape(text);
  var used = new Set(), structs = [];
  function base(sh, hint) {
    var parts = [];
    if (sh.obj) parts.push(sh.obj.keys.length ? { t: struct(sh.obj, hint), k: 'struct' } : { t: 'map[string]any', k: 'ref' });
    if (sh.arr) {
      var it = D.hasType(sh.arr) ? base(sh.arr, D.singular(typeName(hint, true, 'Item'))) : { t: 'any', k: 'ref' };
      parts.push({ t: '[]' + (sh.arr.nul && it.k !== 'ref' ? '*' : '') + it.t, k: 'ref' });
    }
    if (sh.str) parts.push({ t: 'string', k: 'scalar' });
    if (sh.num) parts.push({ t: 'float64', k: 'scalar' }); else if (sh.int) parts.push({ t: 'int', k: 'scalar' });
    if (sh.bool) parts.push({ t: 'bool', k: 'scalar' });
    return parts.length === 1 ? parts[0] : { t: 'any', k: 'ref' };
  }
  function struct(obj, hint) {
    var name = uniqueName(used, typeName(hint, true, 'Item'));
    var slot = structs.length;
    structs.push(null);
    var names = new Set(), rows = [];
    obj.keys.forEach(function (k) {
      var p = obj.props[k];
      var fname = uniqueName(names, typeName(k, true, 'X'));
      var t = base(p.shape, k);
      var optional = p.n < obj.n || p.shape.nul;
      var type = optional && t.k !== 'ref' ? '*' + t.t : t.t;
      var tag = '`json:"' + String(k).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + (optional ? ',omitempty' : '') + '"`';
      rows.push([fname, type, tag]);
    });
    var w0 = 0, w1 = 0;
    rows.forEach(function (x) { w0 = Math.max(w0, x[0].length); w1 = Math.max(w1, x[1].length); });
    structs[slot] = 'type ' + name + ' struct {\n' + rows.map(function (x) {
      return '\t' + x[0].padEnd(w0) + ' ' + x[1].padEnd(w1) + ' ' + x[2];
    }).join('\n') + '\n}';
    return name;
  }
  if (r.isArray) { used.add('Root'); var t = base(r.sh, 'Root'); structs.unshift('type Root ' + t.t); }
  else base(r.sh, 'Root');
  return structs.join('\n\n') + '\n';
};

// ---------------------------------------------------------------- numbers
D.findNumbers = function (text) {
  var re = /(?<![\w.])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?|(?<![\w.])-?\.\d+/g;
  return (text.match(re) || []).map(function (s) { return parseFloat(s.replace(/,/g, '')); }).filter(isFinite);
};
D.fmtNum = function (v) {
  if (!isFinite(v)) return String(v);
  if (v !== 0 && Math.abs(v) < 1e-6) return v.toPrecision(4);
  return parseFloat(v.toPrecision(12)).toLocaleString('en-US', { maximumFractionDigits: 6 });
};
D.stats = function (nums) {
  var n = nums.length, s = nums.slice().sort(function (a, b) { return a - b; });
  var sum = nums.reduce(function (a, b) { return a + b; }, 0), mean = sum / n;
  var pct = function (p) { var pos = (n - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); };
  var ss = nums.reduce(function (a, x) { return a + (x - mean) * (x - mean); }, 0);
  var freq = new Map(), top = 0;
  nums.forEach(function (x) { var c = (freq.get(x) || 0) + 1; freq.set(x, c); if (c > top) top = c; });
  var modes = [];
  freq.forEach(function (c, x) { if (c === top) modes.push(x); });
  modes.sort(function (a, b) { return a - b; });
  return {
    count: n, sum: sum, mean: mean, median: pct(0.5), modes: top > 1 ? modes : [], modeCount: top,
    min: s[0], max: s[n - 1], range: s[n - 1] - s[0],
    sdPop: Math.sqrt(ss / n), sdSample: n > 1 ? Math.sqrt(ss / (n - 1)) : NaN,
    p25: pct(0.25), p75: pct(0.75), p90: pct(0.9),
  };
};
D.numberStats = function (text) {
  var nums = D.findNumbers(text);
  if (!nums.length) return null;
  var st = D.stats(nums), f = D.fmtNum;
  var mode = st.modes.length
    ? st.modes.slice(0, 5).map(f).join(', ') + (st.modes.length > 5 ? ', …' : '') + ' (×' + st.modeCount + ')'
    : 'none (all unique)';
  var rows = [
    ['count', String(st.count)], ['sum', f(st.sum)], ['mean', f(st.mean)], ['median', f(st.median)], ['mode', mode],
    ['min', f(st.min)], ['max', f(st.max)], ['range', f(st.range)],
    ['std dev (population)', f(st.sdPop)], ['std dev (sample)', st.count > 1 ? f(st.sdSample) : 'n/a'],
    ['p25', f(st.p25)], ['p75', f(st.p75)], ['p90', f(st.p90)],
  ];
  var w = Math.max.apply(null, rows.map(function (r) { return r[0].length; }));
  var block = rows.map(function (r) { return r[0].padEnd(w) + ' = ' + r[1]; }).join('\n');
  var trail = /\n*$/.exec(text)[0];
  return text.slice(0, text.length - trail.length) + '\n\n' + block + trail;
};

// ---------------------------------------------------------------- SQL
var SQL_KW = new Set(('SELECT FROM WHERE AND OR NOT IN IS NULL LIKE ILIKE BETWEEN EXISTS AS ON JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL ' +
  'USING GROUP BY ORDER HAVING LIMIT OFFSET FETCH NEXT ROWS ROW ONLY UNION ALL INTERSECT EXCEPT MINUS DISTINCT INSERT INTO VALUES ' +
  'UPDATE SET DELETE CREATE TABLE VIEW INDEX UNIQUE PRIMARY FOREIGN KEY REFERENCES CONSTRAINT DEFAULT CHECK DROP ALTER ADD COLUMN ' +
  'RENAME TO IF CASE WHEN THEN ELSE END ASC DESC NULLS WITH RECURSIVE RETURNING OVER PARTITION WINDOW TRUE FALSE CASCADE TRUNCATE ' +
  'BEGIN COMMIT ROLLBACK TRANSACTION GRANT REVOKE ANY SOME LATERAL CONFLICT DO NOTHING MERGE MATCHED TEMPORARY INTERVAL COLLATE ' +
  'ESCAPE SIMILAR TOP REPLACE MATERIALIZED FILTER WITHIN ILIKE RLIKE REGEXP').split(' '));
var SQL_FN = new Set(('COUNT SUM AVG MIN MAX COALESCE NULLIF CAST CONVERT LOWER UPPER TRIM LTRIM RTRIM LENGTH CHAR_LENGTH SUBSTRING SUBSTR ' +
  'CONCAT CONCAT_WS ROUND FLOOR CEIL CEILING ABS MOD POWER SQRT NOW CURRENT_DATE DATE_TRUNC DATE_PART EXTRACT ROW_NUMBER RANK DENSE_RANK ' +
  'PERCENT_RANK NTILE LAG LEAD FIRST_VALUE LAST_VALUE IFNULL ISNULL NVL GREATEST LEAST REPLACE POSITION STRING_AGG ARRAY_AGG ' +
  'GROUP_CONCAT JSON_AGG JSONB_AGG JSON_BUILD_OBJECT TO_CHAR TO_DATE TO_TIMESTAMP DATEADD DATEDIFF LEFT RIGHT IIF ' +
  'VARCHAR CHAR DECIMAL NUMERIC').split(' '));
var SQL_OPS = ['->>', '->', '::', '<=', '>=', '<>', '!=', '||', '<<', '>>', ':=', '=>', '!~*', '~*', '!~', '@>', '<@', '&&'];

D.sqlTokens = function (src) {
  var toks = [], i = 0, n = src.length, m;
  var push = function (type, v) { toks.push({ type: type, v: v }); i += v.length; };
  var lastSig = function () { for (var k = toks.length - 1; k >= 0; k--) if (toks[k].type !== 'ws' && toks[k].type !== 'cl' && toks[k].type !== 'cb') return toks[k]; return null; };
  while (i < n) {
    var c = src[i], rest = src.slice(i, i + 3);
    if (/\s/.test(c)) { m = /^\s+/.exec(src.slice(i)); push('ws', m[0]); continue; }
    if (rest.slice(0, 2) === '--') { var e = src.indexOf('\n', i); push('cl', src.slice(i, e === -1 ? n : e)); continue; }
    if (rest.slice(0, 2) === '/*') { var e2 = src.indexOf('*/', i + 2); push('cb', src.slice(i, e2 === -1 ? n : e2 + 2)); continue; }
    // strings, with optional E/N/B/X/U& prefix; '' escapes (and \' inside E'')
    if ((m = /^(?:[EeNnBbXx]|[Uu]&)?'/.exec(src.slice(i))) && (m[0].length === 1 || !/[\w$]/.test(src[i - 1] || ''))) {
      var esc = /^[Ee]/.test(m[0]), j = i + m[0].length;
      while (j < n) {
        if (esc && src[j] === '\\') { j += 2; continue; }
        if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } j++; break; }
        j++;
      }
      push('str', src.slice(i, Math.min(j, n))); continue;
    }
    if ((m = /^\$([A-Za-z_]\w*)?\$/.exec(src.slice(i)))) {
      var close = src.indexOf(m[0], i + m[0].length);
      push('str', src.slice(i, close === -1 ? n : close + m[0].length)); continue;
    }
    if (c === '"' || c === '`') {
      var k = i + 1;
      while (k < n) { if (src[k] === c) { if (src[k + 1] === c) { k += 2; continue; } k++; break; } k++; }
      push('qid', src.slice(i, Math.min(k, n))); continue;
    }
    if (c === '[') {
      var ls = lastSig();
      var sub = ls && (ls.type === 'word' || ls.type === 'qid' || ls.v === ')' || ls.v === ']');
      if (!sub && (m = /^\[[^\]\n]*\]/.exec(src.slice(i)))) { push('qid', m[0]); continue; }
    }
    if ((m = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i)))) { push('num', m[0]); continue; }
    if ((m = /^(?:[@#]{1,2}|:(?!:)|\$)?[\p{L}_\d][\p{L}\p{N}_$]*/u.exec(src.slice(i))) && !/^[@#:$]?\d/.test(m[0]) || (m = /^\$\d+/.exec(src.slice(i)))) { push('word', m[0]); continue; }
    var op = null;
    for (var o = 0; o < SQL_OPS.length; o++) if (src.startsWith(SQL_OPS[o], i)) { op = SQL_OPS[o]; break; }
    if (op) { push('op', op); continue; }
    if ('(),;.[]'.indexOf(c) !== -1) { push('p', c); continue; }
    push('op', c);
  }
  return toks;
};

D.sqlMinify = function (src) {
  var toks = D.sqlTokens(src).filter(function (t) {
    return t.type !== 'ws' && t.type !== 'cl' && !(t.type === 'cb' && !/^\/\*[!+]/.test(t.v));
  });
  var wordish = function (t) { return t.type === 'word' || t.type === 'num' || t.type === 'str' || t.type === 'qid' || t.type === 'cb'; };
  var out = '';
  toks.forEach(function (t, i) {
    var a = toks[i - 1];
    if (a && ((wordish(a) && wordish(t)) || (a.type === 'op' && t.type === 'op') ||
      (a.type === 'num' && t.v === '.') || (a.v === '.' && t.type === 'num'))) out += ' ';
    out += t.v;
  });
  return out;
};

D.sqlBeautify = function (src) {
  var all = D.sqlTokens(src), toks = [];
  // significant tokens; comments remember whether a newline preceded them
  for (var a = 0; a < all.length; a++) {
    var t = all[a];
    if (t.type === 'ws') continue;
    var prevWs = all[a - 1] && all[a - 1].type === 'ws' ? all[a - 1].v : '';
    t.nlBefore = /\n/.test(prevWs) || a === 0;
    toks.push(t);
  }
  var IND = '  ', lines = [], cur = { ind: 0, text: '' }, prev = null, forceNL = false;
  var U = function (t) { return t && t.type === 'word' ? t.v.toUpperCase() : null; };
  var code = toks.filter(function (t) { return t.type !== 'cl' && t.type !== 'cb'; });
  var ci = -1;   // index into `code` of the current token
  var nextCode = function (k) { return code[ci + (k || 1)] || null; };
  var prevCode = function (k) { return code[ci - (k || 1)] || null; };
  var kwOf = function (t, idx) {
    // uppercase form if this word is a keyword / function in this position
    if (t.type !== 'word') return null;
    var u = t.v.toUpperCase(), nx = code[idx + 1], pv = code[idx - 1];
    if ((pv && pv.v === '.') || (nx && nx.v === '.')) return null;
    if (SQL_FN.has(u) && nx && nx.v === '(') return u;
    if (SQL_KW.has(u)) return u;
    return null;
  };
  var newline = function (ind) {
    if (cur.text.trim()) lines.push(cur);
    cur = { ind: ind, text: '' };
    prev = null;
  };
  var isUnary = function (p) {
    if (!p) return true;
    if (p.type === 'op' || p.v === '(' || p.v === ',' || p.v === '[') return true;
    return p.type === 'word' && p.kw && !SQL_FN.has(p.kw) && ['NULL', 'TRUE', 'FALSE', 'END'].indexOf(p.kw) === -1;
  };
  var space = function (p, t) {
    if (!p) return false;
    if (p.unary) return false;
    if (t.v === ',' || t.v === ';' || t.v === ')' || t.v === '.' || t.v === ']' || t.v === '::') return false;
    if (p.v === '(' || p.v === '.' || p.v === '::' || p.v === '[') return false;
    if (t.v === '(') {
      if (t.spaced) return true;
      if (p.type === 'qid') return false;
      if (p.type === 'word') return !!(p.kw && !SQL_FN.has(p.kw));
      return true;
    }
    if (t.v === '[') return !(p.type === 'word' || p.type === 'qid' || p.v === ')' || p.v === ']');
    return true;
  };
  var emit = function (t, text) {
    if (forceNL) { newline(cur.ind); forceNL = false; }
    if (cur.text && space(prev, t)) cur.text += ' ';
    cur.text += text;
    prev = t;
  };
  var frames = [{ type: 'root', base: 0, clause: null, between: false, caseDepth: 0, itemsNL: false }];
  var top = function () { return frames[frames.length - 1]; };
  var cdx = 0, i;
  // consume the next code token (comments in between are dropped)
  var skipCode = function () { do { i++; } while (i < toks.length && (toks[i].type === 'cl' || toks[i].type === 'cb')); cdx++; ci++; };
  for (i = 0; i < toks.length; i++) {
    var tk = toks[i];
    if (tk.type === 'cl' || tk.type === 'cb') {
      if (!tk.nlBefore && !cur.text.trim() && lines.length) {
        // a trailing comment whose line we already broke after (e.g. "a, -- note")
        var li = lines.length - 1;
        while (li > 0 && !lines[li].text.trim()) li--;
        lines[li].text += ' ' + tk.v;
        continue;
      }
      if (tk.nlBefore && cur.text.trim()) newline(cur.ind);
      emit(tk, tk.v);
      if (tk.type === 'cl' || tk.nlBefore) forceNL = true;
      continue;
    }
    ci = cdx++;
    var f = top(), clauseCtx = f.type !== 'paren';
    var kw = kwOf(tk, ci);
    tk.kw = kw;
    var word = kw || tk.v;
    if (f.itemsNL) {
      if (kw === 'DISTINCT' || kw === 'ALL' || kw === 'TOP' || (prev && prev.kw === 'TOP')) { emit(tk, word); continue; }
      f.itemsNL = false;
      if (!(clauseCtx && kw && /^(FROM|WHERE)$/.test(kw))) newline(f.base + 1);
    }
    if (kw && clauseCtx && f.caseDepth === 0) {
      var n1 = U(nextCode()), n2 = U(nextCode(2)), p1 = U(prevCode()), p2 = U(prevCode(2));
      var clause = null, extra = 0;
      if (kw === 'SELECT' || kw === 'WHERE' || kw === 'HAVING' || kw === 'LIMIT' || kw === 'OFFSET' || kw === 'RETURNING' || kw === 'WINDOW' || kw === 'VALUES' || kw === 'FETCH') clause = kw;
      else if (kw === 'FROM' && !(p1 === 'DISTINCT' && p2 === 'IS')) clause = 'FROM';
      else if ((kw === 'GROUP' || kw === 'ORDER') && n1 === 'BY') { clause = kw + ' BY'; extra = 1; }
      else if (kw === 'UNION' || kw === 'INTERSECT' || kw === 'EXCEPT' || kw === 'MINUS') { clause = kw; if (n1 === 'ALL' || n1 === 'DISTINCT') { clause += ' ' + n1; extra = 1; } }
      else if (kw === 'INSERT') { clause = 'INSERT'; if (n1 === 'INTO') { clause = 'INSERT INTO'; extra = 1; } }
      else if (kw === 'UPDATE' && p1 !== 'DO' && p1 !== 'FOR') clause = 'UPDATE';
      else if (kw === 'DELETE') { clause = 'DELETE'; if (n1 === 'FROM') { clause = 'DELETE FROM'; extra = 1; } }
      else if (kw === 'SET' && (f.clause === 'UPDATE' || p1 === 'UPDATE')) clause = 'SET';
      else if (kw === 'WITH' && !(p1 === 'START')) { clause = 'WITH'; if (n1 === 'RECURSIVE') { clause += ' RECURSIVE'; extra = 1; } }
      if (clause) {
        newline(f.base);
        emit(tk, clause);
        for (var x = 0; x < extra; x++) skipCode();
        if (extra) prev = { type: 'word', v: clause, kw: clause.split(' ').pop() };
        f.clause = clause; f.between = false;
        if (clause === 'SELECT' || clause === 'SET' || clause === 'RETURNING' || clause === 'VALUES') f.itemsNL = true;
        if (/^(UNION|INTERSECT|EXCEPT|MINUS)/.test(clause)) forceNL = true;
        continue;
      }
      // JOINs: [NATURAL] [INNER|LEFT|RIGHT|FULL|CROSS] [OUTER] JOIN
      var jw = [];
      for (var q = 0; q < 4; q++) {
        var w = q === 0 ? kw : U(nextCode(q));
        if (!w) break;
        jw.push(w);
        if (w === 'JOIN') break;
        if (['NATURAL', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER'].indexOf(w) === -1) { jw = []; break; }
      }
      if (jw.length && jw[jw.length - 1] === 'JOIN') {
        newline(f.base + 1);
        emit(tk, jw.join(' '));
        for (var y = 1; y < jw.length; y++) skipCode();
        prev = { type: 'word', v: 'JOIN', kw: 'JOIN' };
        f.clause = 'JOIN'; f.between = false;
        continue;
      }
      if (kw === 'ON' && f.clause === 'JOIN') { emit(tk, word); f.clause = 'ON'; continue; }
      if (kw === 'BETWEEN') { f.between = true; emit(tk, word); continue; }
      if ((kw === 'AND' || kw === 'OR') && /^(WHERE|HAVING|ON)$/.test(f.clause || '')) {
        if (kw === 'AND' && f.between) { f.between = false; emit(tk, word); continue; }
        newline(f.base + (f.clause === 'ON' ? 2 : 1));
        emit(tk, word);
        continue;
      }
    }
    if (kw === 'CASE') f.caseDepth++;
    if (kw === 'END' && f.caseDepth > 0) f.caseDepth--;
    if (tk.v === '(') {
      var nx = U(nextCode()), pc = prevCode();
      // INSERT INTO t (a, b) / CREATE TABLE t (...) / CREATE INDEX i ON t (col)
      if (pc && (pc.type === 'word' || pc.type === 'qid') && !pc.kw && /^(INTO|TABLE|EXISTS|VIEW)$/.test(U(prevCode(2)) || '')) tk.spaced = true;
      emit(tk, '(');
      if (nx === 'SELECT' || nx === 'WITH') frames.push({ type: 'sub', base: cur.ind + 1, close: cur.ind, clause: null, between: false, caseDepth: 0, itemsNL: false });
      else if (tk.spaced && /^(TABLE|EXISTS)$/.test(U(prevCode(2)) || '') && U(prevCode(3)) !== 'INTO') {
        // CREATE TABLE t ( one column / constraint per line )
        frames.push({ type: 'paren', cols: true, caseDepth: 0, depth: 0, close: cur.ind });
        newline(cur.ind + 1);
      } else {
        var outer = frames[frames.length - 1];
        if (outer.cols) outer.depth++;
        frames.push({ type: 'paren', caseDepth: 0 });
      }
      continue;
    }
    if (tk.v === ')') {
      var fr = frames.length > 1 ? frames.pop() : f;
      if (fr.type === 'sub' || fr.cols) newline(fr.close);
      else if (frames[frames.length - 1].cols) frames[frames.length - 1].depth--;
      emit(tk, ')');
      continue;
    }
    if (tk.v === ';') {
      emit(tk, ';');
      frames = [{ type: 'root', base: 0, clause: null, between: false, caseDepth: 0, itemsNL: false }];
      newline(0);
      lines.push({ ind: 0, text: '' });
      continue;
    }
    if (tk.v === ',' && f.cols && !f.depth) { emit(tk, ','); newline(f.close + 1); continue; }
    if (tk.v === ',' && clauseCtx && f.caseDepth === 0 && /^(SELECT|SET|RETURNING|VALUES|WITH|WITH RECURSIVE)$/.test(f.clause || '')) {
      emit(tk, ',');
      newline(/^WITH/.test(f.clause) ? f.base : f.base + 1);
      continue;
    }
    if ((tk.v === '-' || tk.v === '+') && isUnary(prev)) { emit(tk, tk.v); prev = { type: 'op', v: tk.v, unary: true }; continue; }
    emit(tk, word);
  }
  newline(0);
  while (lines.length && !lines[lines.length - 1].text.trim()) lines.pop();
  var out = lines.map(function (l) { return l.text ? IND.repeat(l.ind) + l.text : ''; }).join('\n');
  return out.replace(/\n{3,}/g, '\n\n');
};

// ---------------------------------------------------------------- extraction
function uniq(list, keyFn) {
  var seen = new Set(), out = [];
  list.forEach(function (s) { var k = keyFn ? keyFn(s) : s; if (!seen.has(k)) { seen.add(k); out.push(s); } });
  return out;
}
function matchAll(re, text, check) {
  var out = [], m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    var v = check ? check(m) : m[0];
    if (v) out.push({ i: m.index, v: v });
  }
  return out;
}

D.extractPhones = function (text) {
  var re = new RegExp([
    '\\+\\d{1,3}(?:[ .-]?\\(?\\d{1,4}\\)?){1,5}',                           // +44 20 7946 0958, +1 (555) 123-4567
    '(?:1[ .-]?)?(?:\\(\\d{3}\\)[ .-]?|\\d{3}[ .-])\\d{3}[ .-]\\d{4}',          // (555) 123-4567, 1-800-555-0199
    '0\\d{1,4}[ .-]?\\d{3,4}[ .-]?\\d{3,4}',                                   // 020 7946 0958
    '\\d{3}-\\d{4}',                                                          // 555-1234
  ].map(function (s) { return '(?:' + s + ')'; }).join('|'), 'g');
  var full = new RegExp('(?<![\\w+.\\/-])(?:' + re.source + ')(?![\\w]|[.-]\\d)', 'g');
  return uniq(matchAll(full, text, function (m) {
    var d = m[0].replace(/\D/g, '');
    return d.length >= 7 && d.length <= 15 ? m[0] : null;
  }).map(function (x) { return x.v; }), function (s) { return s.replace(/\D/g, ''); });
};

var MONTHS = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
D.extractDates = function (text) {
  var ord = '(?:st|nd|rd|th)?';
  var re = new RegExp('(?<![\\w\\/.:-])(?:' + [
    '(\\d{4})-(\\d{2})-(\\d{2})(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?',
    '(\\d{4})\\/(\\d{1,2})\\/(\\d{1,2})',
    '(\\d{1,2})([\\/.-])(\\d{1,2})\\8(\\d{4}|\\d{2})',
    MONTHS + '\\.?\\s+(?:\\d{1,2}' + ord + '(?:,?\\s+\\d{4})?(?!\\d)|\\d{4})',
    '\\d{1,2}' + ord + '\\s+(?:of\\s+)?' + MONTHS + '\\.?(?:,?\\s+\\d{4})?',
  ].join('|') + ')(?![\\w]|[\\/.-]\\d)', 'g');
  return uniq(matchAll(re, text, function (m) {
    var mo, d;
    if (m[1]) { mo = +m[2]; d = +m[3]; if (mo < 1 || mo > 12 || d < 1 || d > 31) return null; }
    else if (m[4]) { mo = +m[5]; d = +m[6]; if (mo < 1 || mo > 12 || d < 1 || d > 31) return null; }
    else if (m[7]) {
      var a = +m[7], b = +m[9];
      if (a < 1 || b < 1 || a > 31 || b > 31 || (a > 12 && b > 12)) return null;
      if (m[8] === '.' && m[10].length === 2) return null;   // 1.5.24 reads like a version
    }
    return m[0].replace(/\s+/g, ' ');
  }).map(function (x) { return x.v; }));
};

D.isIPv6 = function (s) {
  s = s.replace(/%[\w.-]+$/, '');
  if (!/[0-9a-f]/i.test(s)) return false;
  var groups = 8, v4 = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    if (!v4[1].split('.').every(function (o) { return +o <= 255 && !/^0\d/.test(o); })) return false;
    s = s.slice(0, v4.index + 1) + '0:0';
  }
  var hex = /^[0-9a-fA-F]{1,4}$/;
  var dbl = s.split('::');
  if (dbl.length > 2) return false;
  if (dbl.length === 2) {
    var parts = [].concat(dbl[0] ? dbl[0].split(':') : [], dbl[1] ? dbl[1].split(':') : []);
    return parts.length <= groups - 1 && parts.every(function (p) { return hex.test(p); });
  }
  var g = s.split(':');
  return g.length === groups && g.every(function (p) { return hex.test(p); });
};
D.extractIPs = function (text) {
  var oct = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  var v4 = new RegExp('(?<![\\w.:])' + oct + '(?:\\.' + oct + '){3}(?:\\/(?:3[0-2]|[12]?\\d))?(?![\\w]|\\.\\d)', 'g');
  var v6 = /(?<![\w:.])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?:(?<=:)\d{1,3}(?:\.\d{1,3}){3})?(?:%[\w.-]+)?(?:\/(?:12[0-8]|1[01]\d|[1-9]?\d))?(?![\w:]|\.\d)/g;
  var a = matchAll(v4, text);
  var b = matchAll(v6, text, function (m) { return D.isIPv6(m[0].replace(/\/\d+$/, '')) ? m[0] : null; });
  return uniq(a.concat(b).sort(function (x, y) { return x.i - y.i; }).map(function (x) { return x.v; }), function (s) { return s.toLowerCase(); });
};

D.extractTags = function (text) {
  var tags = matchAll(/(?<![\p{L}\p{N}_&#\/])#([\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)/gu, text, function (m) {
    var b = m[1];
    if (/^[0-9a-f]+$/i.test(b) && (b.length === 3 || b.length === 6 || ((b.length === 4 || b.length === 8) && /\d/.test(b)))) return null;  // a hex colour
    return m[0];
  }).map(function (x) { return x.v; });
  var mentions = matchAll(/(?<![\p{L}\p{N}_@.\/])@([\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?)/gu, text).map(function (x) { return x.v; });
  var lc = function (s) { return s.toLowerCase(); };
  return { tags: uniq(tags, lc), mentions: uniq(mentions, lc) };
};

D.extractMoney = function (text) {
  var SYM = '[$€£¥₹₩₽₺₪฿₫₦₱₴₵¢]';
  var PRE = '(?:US|USD|CA|C|AU|A|NZ|HK|S|R|NT|MX)\\$';
  var CODES = '(?:USD|EUR|GBP|JPY|CNY|RMB|INR|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RUB|BRL|MXN|ZAR|SGD|HKD|KRW|TRY|ILS|AED|SAR|THB|IDR|MYR|PHP|VND|NGN|EGP|ARS|CLP|COP|PEN|UAH|BTC|ETH)';
  var NUM = '(?:\\d{1,3}(?:[,.\\u00a0\\u202f\']\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)(?!\\d)';
  var SCALE = '(?:\\s?(?:[kKmMbB]n?|thousand|million|billion|trillion)(?![\\p{L}\\p{N}_]))?';
  var re = new RegExp('(?<![\\p{L}\\p{N}_$€£¥₹₩₽₺₪฿₫₦₱₴₵.,])(?:' + [
    '[-−]?(?:' + PRE + '|' + SYM + ')\\s?[-−]?' + NUM + SCALE,
    CODES + '\\s?[-−]?' + NUM + SCALE,
    '[-−]?' + NUM + SCALE + '\\s?(?:' + SYM + '|' + CODES + '(?![\\p{L}])|(?:dollars?|euros?|pounds?|yen|rupees?|cents?|bucks)(?![\\p{L}]))',
  ].join('|') + ')', 'gu');
  return uniq(matchAll(re, text).map(function (x) { return x.v.trim(); }));
};

D.extractHexColors = function (text) {
  return uniq(matchAll(/(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g, text).map(function (x) { return x.v; }),
    function (s) { return s.toLowerCase(); });
};

// ---------------------------------------------------------------- runners
var EXTRACT = {
  phones: ['Phone Numbers', 'phone numbers', D.extractPhones],
  dates: ['Dates', 'dates', D.extractDates],
  ips: ['IP Addresses', 'IP addresses', D.extractIPs],
  money: ['Money Amounts', 'money amounts', D.extractMoney],
  colors: ['Hex Colours', 'hex colours', D.extractHexColors],
};
// Tables and JSON make no sense one line at a time: when the palette hands us
// just the current line, work on the whole note instead.
function wholeIfLine(ctx, useWhole) {
  var sel = ctx.selection;
  if (sel && useWhole(sel)) return { text: ctx.fullText, whole: true };
  return { text: sel || ctx.fullText, whole: !sel };
}
function put(ctx, src, out) { if (src.whole) ctx.fullText = out; else ctx.selection = out; }
var notJSON = function (s) { try { JSON.parse(s); return false; } catch (e) { return true; } };
var oneLine = function (s) { return s.indexOf('\n') === -1; };

D.run = function (what, ctx, toast, arg) {
  toast = toast || function () {};
  var src, out, list;
  switch (what) {
    case 'csvToJson': src = wholeIfLine(ctx, oneLine); put(ctx, src, D.csvToJson(src.text)); return;
    case 'transpose': src = wholeIfLine(ctx, oneLine); put(ctx, src, D.transpose(src.text)); return;
    case 'selectColumns': {
      src = wholeIfLine(ctx, oneLine);
      var head = D.tableHeader(src.text);
      if (!head) throw new Error('No table found (CSV, TSV or a Markdown table)');
      var spec = window.prompt('Columns to keep, in order — names or 1-based numbers, ranges like 2-4, "-name" drops one:', head.join(', '));
      if (spec == null || !spec.trim()) return;
      put(ctx, src, D.selectColumns(src.text, spec));
      return;
    }
    case 'jsonSchema': src = wholeIfLine(ctx, notJSON); put(ctx, src, D.jsonSchema(src.text)); return;
    case 'python': src = wholeIfLine(ctx, notJSON); put(ctx, src, D.pythonDataclass(src.text)); return;
    case 'go': src = wholeIfLine(ctx, notJSON); put(ctx, src, D.goStruct(src.text)); return;
    case 'dedupe': {
      src = wholeIfLine(ctx, notJSON);
      var data = D.parseJSON(src.text);
      if (!Array.isArray(data)) throw new Error('Expected a JSON array');
      var key = window.prompt('Dedupe by key (dot path allowed, e.g. id or user.email) — keeps the first of each:', 'id');
      if (key == null || !key.trim()) return;
      var r = D.dedupeByKey(src.text, key.trim());
      put(ctx, src, r.text);
      toast(r.removed ? 'Removed ' + r.removed + ' duplicate' + (r.removed === 1 ? '' : 's') : 'No duplicates found', r.removed ? 'success' : 'info', 2500);
      return;
    }
    case 'stats': {
      var text = ctx.selection || ctx.fullText;
      out = D.numberStats(text);
      if (out == null) { toast('No numbers found', 'error'); return; }
      if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
      return;
    }
    case 'sqlBeautify': case 'sqlMinify': {
      var sql = ctx.selection || ctx.fullText;
      if (!sql.trim()) return;
      out = what === 'sqlMinify' ? D.sqlMinify(sql) : D.sqlBeautify(sql);
      var tr = /\s*$/.exec(sql)[0];
      out += what === 'sqlBeautify' && tr.indexOf('\n') !== -1 ? '\n' : '';
      if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
      return;
    }
    case 'tags': {
      var r2 = D.extractTags(ctx.selection || ctx.fullText);
      if (!r2.tags.length && !r2.mentions.length) { toast('No hashtags or mentions found', 'info', 2500); return; }
      var blocks = [];
      if (r2.tags.length) blocks.push('--- Hashtags Found (' + r2.tags.length + ') ---\n' + r2.tags.join('\n'));
      if (r2.mentions.length) blocks.push('--- Mentions Found (' + r2.mentions.length + ') ---\n' + r2.mentions.join('\n'));
      ctx.fullText = ctx.fullText + '\n\n' + blocks.join('\n\n');
      return;
    }
    default: {
      var ex = EXTRACT[what];
      if (!ex) throw new Error('Unknown data command: ' + what);
      list = ex[2](ctx.selection || ctx.fullText);
      if (!list.length) { toast('No ' + ex[1] + ' found', 'info', 2500); return; }
      ctx.fullText = ctx.fullText + '\n\n--- ' + ex[0] + ' Found (' + list.length + ') ---\n' + list.join('\n');
    }
  }
};

window.__CADE_DATA__ = D;

registerScript(`/**
  {
    "name": "CSV → JSON",
    "description": "CSV, TSV or a Markdown table → a JSON array of objects (header row = keys; numbers, true / false and null typed, codes like 007 kept as text)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z'/><polyline points='14 2 14 8 20 8'/><path d='M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1'/><path d='M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1'/></svg>",
    "tags": "csv,json,csv to json,tsv,markdown,table,convert,parse,objects,data"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('csvToJson', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "JSON → JSON Schema",
    "description": "Infer a JSON Schema (draft 2020-12) from sample JSON — types, required keys, nullable fields, email / date-time / uri formats",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1'/><path d='M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1'/><polyline points='9 12 11 14 15 10'/></svg>",
    "tags": "json,schema,json schema,infer,generate,types,validate,draft 2020-12"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('jsonSchema', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "JSON → Python Dataclass",
    "description": "Generate Python @dataclass classes from sample JSON — nested objects get their own classes, Optional for keys that are missing or null",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='4' width='18' height='16' rx='2'/><line x1='3' y1='9' x2='21' y2='9'/><line x1='7' y1='13' x2='14' y2='13'/><line x1='7' y1='16.5' x2='11' y2='16.5'/></svg>",
    "tags": "json,python,dataclass,class,typing,types,generate,model,code"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('python', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "JSON → Go Struct",
    "description": "Generate Go structs with json tags from sample JSON — nested structs, pointers and omitempty for keys that are missing or null",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='4' width='18' height='16' rx='2'/><line x1='3' y1='9' x2='21' y2='9'/><line x1='10' y1='9' x2='10' y2='20'/></svg>",
    "tags": "json,go,golang,struct,json tags,types,generate,model,code"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('go', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "Dedupe JSON Array by Key…",
    "description": "Drop JSON array items whose key (a dot path like user.email) repeats an earlier one — keeps the first and your formatting",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='9' y='9' width='13' height='13' rx='2'/><path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'/><line x1='12.5' y1='15.5' x2='18.5' y2='15.5'/></svg>",
    "tags": "json,dedupe,duplicates,unique,distinct,array,key,remove,prompt"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('dedupe', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "Select CSV Columns…",
    "description": "Keep, reorder or drop columns of a CSV, TSV or Markdown table — names or numbers like name, email, 3 (-notes drops one)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2'/><line x1='9' y1='3' x2='9' y2='21'/><line x1='15' y1='3' x2='15' y2='21'/><line x1='12' y1='7' x2='12' y2='17'/></svg>",
    "tags": "csv,tsv,markdown,table,columns,select,reorder,drop,remove,cut,prompt"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('selectColumns', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "Transpose Table",
    "description": "Swap the rows and columns of a CSV, TSV or Markdown table",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='7' height='7' rx='1'/><rect x='14' y='14' width='7' height='7' rx='1'/><path d='M14 6.5h3.5a2 2 0 0 1 2 2V11'/><polyline points='17.5 9 19.5 11 21.5 9'/><path d='M10 17.5H6.5a2 2 0 0 1-2-2V13'/><polyline points='2.5 15 4.5 13 6.5 15'/></svg>",
    "tags": "transpose,table,csv,tsv,markdown,rows,columns,pivot,flip,swap"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('transpose', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "Number Stats",
    "description": "Count, sum, mean, median, mode, min / max, range, standard deviation and percentiles of the numbers in the selection or note",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='18' y1='20' x2='18' y2='10'/><line x1='12' y1='20' x2='12' y2='4'/><line x1='6' y1='20' x2='6' y2='14'/></svg>",
    "tags": "stats,statistics,numbers,mean,average,median,mode,std dev,standard deviation,percentile,sum,min,max,math"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('stats', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "SQL Beautify",
    "description": "Format SQL — uppercase keywords, one clause per line, indented select lists, joins, conditions and subqueries (strings and comments untouched)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><ellipse cx='12' cy='5' rx='9' ry='3'/><path d='M21 12c0 1.66-4 3-9 3s-9-1.34-9-3'/><path d='M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5'/></svg>",
    "tags": "sql,format,beautify,pretty,prettify,indent,query,database,code"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('sqlBeautify', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "SQL Minify",
    "description": "Squeeze SQL onto one line — comments and extra whitespace removed, strings and quoted names kept intact",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><ellipse cx='12' cy='5' rx='9' ry='3'/><path d='M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5'/><polyline points='9 11 12 14 15 11'/></svg>",
    "tags": "sql,minify,compact,compress,one line,strip comments,query,database,code"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('sqlMinify', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "Extract Phone Numbers",
    "description": "Extract all phone numbers from text",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z'/></svg>",
    "tags": "extract,phone,phones,telephone,mobile,numbers,parse"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('phones', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "Extract Dates",
    "description": "Extract all dates from text (2024-01-05, 1/5/2024, Jan 5, 2024, 5 March …)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='4' width='18' height='18' rx='2'/><line x1='16' y1='2' x2='16' y2='6'/><line x1='8' y1='2' x2='8' y2='6'/><line x1='3' y1='10' x2='21' y2='10'/></svg>",
    "tags": "extract,dates,date,datetime,iso,calendar,parse"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('dates', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "Extract IP Addresses",
    "description": "Extract all IPv4 and IPv6 addresses from text (CIDR suffixes kept)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='2' y='2' width='20' height='8' rx='2'/><rect x='2' y='14' width='20' height='8' rx='2'/><line x1='6' y1='6' x2='6.01' y2='6'/><line x1='6' y1='18' x2='6.01' y2='18'/></svg>",
    "tags": "extract,ip,ips,ipv4,ipv6,address,network,cidr,parse"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('ips', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "Extract Hashtags & Mentions",
    "description": "Extract all #hashtags and @mentions from text",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='4'/><path d='M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94'/></svg>",
    "tags": "extract,hashtags,hashtag,mentions,mention,social,tags,handles,parse"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('tags', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "Extract Money Amounts",
    "description": "Extract all money amounts from text ($1,234.56, €5, 20 EUR, £3.5M …)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='2' y='6' width='20' height='12' rx='2'/><circle cx='12' cy='12' r='2'/><path d='M6 12h.01M18 12h.01'/></svg>",
    "tags": "extract,money,currency,amounts,prices,dollars,euros,parse"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('money', ctx, showToast);
}`);

registerScript(`/**
  {
    "name": "Extract Hex Colours",
    "description": "Extract all hex colours from text (#fff, #a1b2c3, #a1b2c3ff)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z'/></svg>",
    "tags": "extract,hex,colours,colors,colour,color,css,palette,parse"
  }
**/
function main(ctx) {
  window.__CADE_DATA__.run('colors', ctx, showToast);
}`);

})();
