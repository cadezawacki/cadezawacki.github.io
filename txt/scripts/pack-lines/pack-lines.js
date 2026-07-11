/* Lines Pack — Sort, dedupe, number, reshape lists and lines.
   Script-pack module: one file registering 16 palette scripts.
   Extracted verbatim from txt.html (core slimming). */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var registerScript = function (src) { window.Cade.registerScript(src); };

registerScript(`/**
  {
    "name": "Sort List",
    "description": "Sort lines or comma-separated items alphabetically with smart number handling",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='12' y1='5' x2='12' y2='19'/><polyline points='19 12 12 19 5 12'/><line x1='4' y1='2' x2='4' y2='2.01'/><line x1='4' y1='5' x2='4' y2='5.01'/></svg>",
    "tags": "sort,list,alphabetical,order,asc"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const hasCommas = text.includes(',') && text.split('\\n').length <= 2;
  if (hasCommas) {
    const parts = text.split(',').map(s => s.trim()).filter(Boolean);
    parts.sort((a, b) => smartCompare(a, b));
    const result = parts.join(', ');
    if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
  } else {
    const lines = text.split('\\n');
    lines.sort((a, b) => smartCompare(a.trim(), b.trim()));
    const result = lines.join('\\n');
    if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
  }
}

function smartCompare(a, b) {
  // Blank lines always sort to end
  if (a.trim() === '' && b.trim() === '') return 0;
  if (a.trim() === '') return 1;
  if (b.trim() === '') return -1;
  const stripQuotes = s => s.replace(/^["']|["']$/g, '');
  a = stripQuotes(a);
  b = stripQuotes(b);
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}`);

registerScript(`/**
  {
    "name": "Reverse List",
    "description": "Reverse lines or comma-separated items",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='12' y1='19' x2='12' y2='5'/><polyline points='5 12 12 5 19 12'/></svg>",
    "tags": "reverse,list,flip,invert"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const hasCommas = text.includes(',') && text.split('\\n').length <= 2;
  if (hasCommas) {
    const parts = text.split(',').map(s => s.trim()).filter(Boolean);
    parts.reverse();
    const result = parts.join(', ');
    if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
  } else {
    const lines = text.split('\\n');
    lines.reverse();
    const result = lines.join('\\n');
    if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
  }
}`);

registerScript(`/**
  {
    "name": "Unique Lines",
    "description": "Remove duplicate lines, preserving order",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='7' height='7'/><rect x='14' y='3' width='7' height='7' opacity='0.4'/><rect x='3' y='14' width='7' height='7'/><rect x='14' y='14' width='7' height='7'/></svg>",
    "tags": "unique,deduplicate,duplicate,lines,distinct,remove"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const seen = new Set();
  const lines = text.split('\\n').filter(line => {
    const key = line.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const result = lines.join('\\n');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Remove Empty Lines",
    "description": "Remove all blank/empty lines",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='5' y1='12' x2='19' y2='12'/><line x1='12' y1='5' x2='12' y2='5.01'/><line x1='12' y1='19' x2='12' y2='19.01'/></svg>",
    "tags": "remove,empty,blank,lines"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const result = text.split('\\n').filter(l => l.trim() !== '').join('\\n');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Number Lines",
    "description": "Prefix each line with its line number",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='10' y1='6' x2='21' y2='6'/><line x1='10' y1='12' x2='21' y2='12'/><line x1='10' y1='18' x2='21' y2='18'/><path d='M4 6h1v4'/><path d='M4 10h2'/><path d='M6 18H4c0-1 2-2 2-3s-1-1.5-2-1'/></svg>",
    "tags": "number,lines,prefix,enumerate"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const lines = text.split('\\n');
  const pad = String(lines.length).length;
  const result = lines.map((l, i) => String(i + 1) + '.'.padStart(pad, ' ') + '  ' + l).join('\\n');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Bullet List",
    "description": "Toggle bullet points on lines (add or remove)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='8' y1='6' x2='21' y2='6'/><line x1='8' y1='12' x2='21' y2='12'/><line x1='8' y1='18' x2='21' y2='18'/><line x1='3' y1='6' x2='3.01' y2='6'/><line x1='3' y1='12' x2='3.01' y2='12'/><line x1='3' y1='18' x2='3.01' y2='18'/></svg>",
    "tags": "bullet,list,toggle,unordered,dash,point"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const lines = text.split('\\n');
  const nonEmpty = lines.filter(l => l.trim());
  const allBulleted = nonEmpty.length > 0 && nonEmpty.every(l => /^\\s*[-•*]\\s/.test(l));
  let result;
  if (allBulleted) {
    // Remove bullets
    result = lines.map(l => l.replace(/^(\\s*)[-•*]\\s+/, '$1')).join('\\n');
  } else {
    // Add bullets
    result = lines.map(l => {
      if (l.trim() === '') return l;
      const indent = l.match(/^(\\s*)/)[1];
      const content = l.trim().replace(/^[-•*]\\s+/, '');
      return indent + '- ' + content;
    }).join('\\n');
  }
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Listify",
    "description": "Format text into a quoted, comma-separated list — auto-detects delimiter",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M8 6h13'/><path d='M8 12h13'/><path d='M8 18h13'/><circle cx='3' cy='6' r='1' fill='currentColor'/><circle cx='3' cy='12' r='1' fill='currentColor'/><circle cx='3' cy='18' r='1' fill='currentColor'/></svg>",
    "tags": "list,listify,format,comma,quote,array,csv,items"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  // Determine the delimiter: prefer structured delimiters, fall back to space
  let items;
  const hasNewlines = text.includes('\\n');
  const hasTabs = text.includes('\\t');
  const hasCommas = text.includes(',');
  if (hasNewlines) {
    items = text.split('\\n');
  } else if (hasTabs) {
    items = text.split('\\t');
  } else if (hasCommas) {
    items = text.split(',');
  } else {
    items = text.split(/\\s+/);
  }
  // Clean up each item: trim whitespace, strip existing quotes, drop empties
  items = items
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/^["'\`\\u201c\\u201d]+|["'\`\\u201c\\u201d]+$/g, '').trim())
    .filter(Boolean);
  const result = items.map(s => '"' + s + '"').join(', ');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Shuffle Lines",
    "description": "Randomly shuffle the order of lines",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='16 3 21 3 21 8'/><line x1='4' y1='20' x2='21' y2='3'/><polyline points='21 16 21 21 16 21'/><line x1='15' y1='15' x2='21' y2='21'/><line x1='4' y1='4' x2='9' y2='9'/></svg>",
    "tags": "shuffle,random,randomize,lines,reorder"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const lines = text.split('\\n');
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }
  const result = lines.join('\\n');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Sort Lines by Length",
    "description": "Sort lines from shortest to longest",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='3' y1='6' x2='10' y2='6'/><line x1='3' y1='12' x2='15' y2='12'/><line x1='3' y1='18' x2='21' y2='18'/></svg>",
    "tags": "sort,length,lines,shortest,longest"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const lines = text.split('\\n');
  lines.sort((a, b) => a.length - b.length);
  const result = lines.join('\\n');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Wrap Lines",
    "description": "Wrap each line with a prefix and suffix (prompts)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 6h18'/><path d='M3 12h15a3 3 0 1 1 0 6h-4'/><polyline points='13 16 11 18 13 20'/></svg>",
    "tags": "wrap,lines,prefix,suffix,surround,quote"
  }
**/
function main(ctx) {
  const prefix = prompt('Prefix for each line:', '"') || '';
  const suffix = prompt('Suffix for each line:', '"') || '';
  const text = ctx.selection || ctx.fullText;
  const result = text.split('\\n').map(l => prefix + l + suffix).join('\\n');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Join Lines",
    "description": "Join all lines into one with a separator",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M8 6h13'/><path d='M8 12h13'/><path d='M8 18h13'/><path d='M3 6h.01'/><path d='M3 12h.01'/><path d='M3 18h.01'/></svg>",
    "tags": "join,lines,merge,combine,separator,comma"
  }
**/
function main(ctx) {
  const sep = prompt('Separator:', ', ');
  if (sep === null) return;
  const text = ctx.selection || ctx.fullText;
  const result = text.split('\\n').filter(l => l.trim()).join(sep);
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Listify (One Per Row)",
    "description": "Quote each item on its own row, with a comma after each except the last",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M8 6h13'/><path d='M8 12h13'/><path d='M8 18h13'/><circle cx='3' cy='6' r='1' fill='currentColor'/><circle cx='3' cy='12' r='1' fill='currentColor'/><circle cx='3' cy='18' r='1' fill='currentColor'/></svg>",
    "tags": "list,listify,rows,quote,column,array,one per line,csv"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  let items;
  if (text.includes('\\n')) items = text.split('\\n');
  else if (text.includes('\\t')) items = text.split('\\t');
  else if (text.includes(',')) items = text.split(',');
  else items = text.split(/\\s+/);
  items = items.map(s => s.trim()).filter(Boolean);
  const result = items.map((s, i) => '"' + s + '"' + (i < items.length - 1 ? ',' : '')).join('\\n');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Remove Duplicates (CSV)",
    "description": "Remove duplicate values in comma-separated text",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'/><circle cx='9' cy='7' r='4'/><line x1='17' y1='11' x2='23' y2='11'/></svg>",
    "tags": "remove,duplicates,csv,comma,unique,dedup"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const items = text.split(',').map(s => s.trim());
  const unique = [...new Set(items)];
  const removed = items.length - unique.length;
  const result = unique.join(', ');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
  showToast('Removed ' + removed + ' duplicate' + (removed !== 1 ? 's' : ''), 'success', 2500);
}`);

registerScript(`/**
  {
    "name": "Indent / Dedent",
    "description": "Add or remove indentation (2 spaces)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='21' y1='6' x2='3' y2='6'/><line x1='21' y1='12' x2='9' y2='12'/><line x1='21' y1='18' x2='7' y2='18'/><polyline points='3 12 7 16 3 20'/></svg>",
    "tags": "indent,dedent,tab,space,whitespace,shift"
  }
**/
function main(ctx) {
  const choice = prompt('Type "in" to indent or "out" to dedent:', 'in');
  if (!choice) return;
  const text = ctx.selection || ctx.fullText;
  let result;
  if (choice.toLowerCase().startsWith('o')) {
    result = text.split('\\n').map(l => l.startsWith('  ') ? l.slice(2) : l).join('\\n');
  } else {
    result = text.split('\\n').map(l => '  ' + l).join('\\n');
  }
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Flatten",
    "description": "Collapse multiple lines into a single line, with a single space between each, skipping blank lines",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='3' y1='8' x2='21' y2='8'/><line x1='3' y1='12' x2='21' y2='12'/><line x1='3' y1='16' x2='21' y2='16'/><polyline points='8 5 12 1 16 5'/><polyline points='8 19 12 23 16 19'/></svg>",
    "tags": "flatten,join,single line,collapse,condense,unwrap"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const result = text
    .split('\\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join(' ');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Toggle Commas",
    "description": "Add or remove thousands-place commas from numbers (1234567 ↔ 1,234,567)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='12' y1='20' x2='12' y2='10'/><line x1='18' y1='20' x2='18' y2='4'/><line x1='6' y1='20' x2='6' y2='16'/></svg>",
    "tags": "comma,commas,thousands,number,format,1000"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const hasCommaNumbers = /\d{1,3}(,\d{3})+/.test(text);
  let result;
  if (hasCommaNumbers) {
    // Remove commas from numbers
    result = text.replace(/(\d{1,3})(,\d{3})+/g, m => m.replace(/,/g, ''));
  } else {
    // Add commas to numbers
    result = text.replace(/\b(\d+)(\.\d+)?\b/g, (_, int, dec) => {
      const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return dec ? withCommas + dec : withCommas;
    });
  }
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

})();
