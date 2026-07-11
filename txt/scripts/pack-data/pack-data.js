/* Data Pack — JSON, tables, extraction and splitting.
   Script-pack module: one file registering 12 palette scripts.
   Extracted verbatim from txt.html (core slimming). */
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

})();
