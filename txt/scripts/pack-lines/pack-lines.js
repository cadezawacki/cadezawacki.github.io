/* Lines Pack — Sort, dedupe, number, reshape lists and lines.
   Script-pack module: one file registering 17 palette scripts.
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
    "name": "Sort by Value",
    "description": "Sort key: value lines (JSON, JS / Python dicts, YAML, key = value) by their value, keeping braces, comments and trailing-comma style",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='3' y1='6' x2='8' y2='6'/><line x1='3' y1='12' x2='8' y2='12'/><line x1='3' y1='18' x2='8' y2='18'/><line x1='11' y1='6' x2='11' y2='6.01'/><line x1='11' y1='12' x2='11' y2='12.01'/><line x1='11' y1='18' x2='11' y2='18.01'/><line x1='18' y1='5' x2='18' y2='19'/><polyline points='21 16 18 19 15 16'/></svg>",
    "tags": "sort,value,values,by value,dict,dictionary,json,object,map,keys,yaml,python"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const r = sortByValue(text);
  if (r.error) { showToast(r.error, 'error', 3500); return; }
  if (ctx.selection) ctx.selection = r.text; else ctx.fullText = r.text;
  showToast('Sorted ' + r.count + ' entr' + (r.count === 1 ? 'y' : 'ies') + ' by value', 'success', 2000);
}

// Sorts "key: value" entries — JSON, JS / Python dicts, YAML-ish lines,
// key = value, key => value — by their value, keeping the braces, indentation,
// comments and comma style the text came in with.
function sortByValue(text) {
  const QUOTES = '"\\'\`';
  const OPEN = '{[(', CLOSE = '}])';

  // Index of the quote closing the string that opens at i (or -1).
  function endOfString(s, i) {
    const q = s[i];
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\\\') { j++; continue; }
      if (s[j] === q) return j;
    }
    return -1;
  }
  // Is a comment starting at i? "//" and "#" need whitespace before them so
  // URLs and "#fff" values are left alone.
  function commentAt(s, i) {
    const before = i === 0 || s[i - 1] === ' ' || s[i - 1] === '\\t';
    return before && (s.startsWith('//', i) || s[i] === '#' || s.startsWith('/*', i));
  }
  // Scan from i to the first top-level char for which stop() is true,
  // skipping strings and bracketed groups. Returns the index, or -1 when a
  // string or bracket is left open.
  function scan(s, i, stop) {
    let depth = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (QUOTES.includes(c)) { const e = endOfString(s, i); if (e < 0) return -1; i = e; continue; }
      if (depth === 0 && stop(s, i)) return i;
      if (OPEN.includes(c)) depth++;
      else if (CLOSE.includes(c)) { if (depth === 0) return -1; depth--; }
    }
    return depth === 0 ? s.length : -1;
  }
  function unquote(v) {
    return v.length >= 2 && QUOTES.includes(v[0]) && v[v.length - 1] === v[0] ? v.slice(1, -1) : v;
  }

  // One entry → { indent, head (up to the end of the value), comma, tail, key, value }
  function parseEntry(line) {
    const indent = line.match(/^\\s*/)[0];
    let i = indent.length;
    if (i >= line.length) return null;
    // Key: a quoted string, or anything up to the separator.
    let keyEnd;
    if (QUOTES.includes(line[i])) {
      keyEnd = endOfString(line, i);
      if (keyEnd < 0) return null;
      keyEnd++;
    } else {
      keyEnd = scan(line, i, (s, j) => s[j] === ':' || s[j] === '=' || s.startsWith('->', j));
      if (keyEnd < 0 || keyEnd === i) return null;
    }
    const key = unquote(line.slice(i, keyEnd).trim());
    // Separator: ":", "=>", "=", ":=" or "->", with any whitespace around it.
    let j = keyEnd;
    while (line[j] === ' ' || line[j] === '\\t') j++;
    const sep = line.slice(j).match(/^(=>|:=|->|:|=)/);
    if (!sep) return null;
    j += sep[0].length;
    while (line[j] === ' ' || line[j] === '\\t') j++;
    // Value: a quoted string, or anything up to a top-level comma / comment.
    let valEnd;
    if (QUOTES.includes(line[j])) {
      valEnd = endOfString(line, j);
      if (valEnd < 0) return null;
      valEnd++;
    } else {
      valEnd = scan(line, j, (s, k) => s[k] === ',' || commentAt(s, k));
      if (valEnd < 0) return null;
      while (valEnd > j && /\\s/.test(line[valEnd - 1])) valEnd--;
    }
    const raw = line.slice(j, valEnd);
    // After the value: optional comma, then only whitespace or a comment.
    let rest = line.slice(valEnd);
    let comma = false;
    const m = rest.match(/^\\s*,/);
    if (m) { comma = true; rest = rest.slice(m[0].length); }
    const t = rest.trim();
    if (t && t !== ';' && !commentAt(' ' + t, 1)) return null;
    return { indent, head: line.slice(indent.length, valEnd), comma, tail: rest, key, value: unquote(raw.replace(/;$/, '').trim()) };
  }

  function cmpText(a, b) {
    const na = Number(a), nb = Number(b);
    if (a.trim() !== '' && b.trim() !== '' && isFinite(na) && isFinite(nb) && na !== nb) return na - nb;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
  }
  const cmp = (a, b) => cmpText(a.value, b.value) || cmpText(a.key, b.key);

  // Comma style: all, none, or "between" (all but the last) is kept as is
  // after sorting; anything else leaves each entry's own comma alone.
  function fixCommas(sorted, original) {
    const n = original.length;
    const between = n > 1 && original.slice(0, -1).every(e => e.comma) && !original[n - 1].comma;
    if (between) sorted.forEach((e, k) => { e.comma = k < n - 1; });
  }

  // Peel off an outer { … } (with any "x = {" / "dict(" lead-in and "};" tail).
  let pre = '', post = '', inner = text;
  const open = text.match(/^\\s*(?:[^\\n{}"'\`]*?[=:(]\\s*)?\\{/);
  const close = text.match(/\\}[\\s);,]*$/);
  if (open && close && close.index >= open[0].length) {
    pre = open[0];
    post = text.slice(close.index);
    inner = text.slice(open[0].length, close.index);
  }

  const lines = inner.split('\\n');
  const nonBlank = lines.filter(l => l.trim());

  // Everything on one line: {"a": "x", "b": "y"}
  if (nonBlank.length === 1) {
    const line = nonBlank[0];
    const lead = line.match(/^\\s*/)[0], trail = line.match(/\\s*$/)[0];
    const body = line.trim();
    const parts = [];
    for (let i = 0; i <= body.length;) {
      const e = scan(body, i, (s, k) => s[k] === ',');
      if (e < 0) return { error: 'Could not parse — unbalanced quotes or brackets' };
      parts.push(body.slice(i, e));
      i = e + 1;
      if (e === body.length) break;
    }
    const trailingComma = parts.length > 1 && !parts[parts.length - 1].trim();
    if (trailingComma) parts.pop();
    const entries = parts.map(p => parseEntry(p.trim()));
    if (entries.some(e => !e)) return { error: 'Could not find a key: value entry in "' + parts[entries.indexOf(null)].trim() + '"' };
    if (entries.length < 2) return { error: 'Need at least two key: value entries to sort' };
    const space = (body.match(/,(\\s*)/) || ['', ' '])[1];
    entries.sort(cmp);
    const out = lead + entries.map(e => e.head).join(',' + space) + (trailingComma ? ',' : '') + trail;
    const newLines = inner.split('\\n').map(l => (l === line ? out : l));
    return { text: pre + newLines.join('\\n') + post, count: entries.length };
  }

  // One entry per line. Comment lines travel with the entry below them;
  // blank or comment lines before the first / after the last entry stay put.
  const isComment = l => /^\\s*(\\/\\/|#|\\/\\*|\\*|--)/.test(l);
  const items = [];
  let pending = [], head = [], first = true;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (!line.trim() || isComment(line)) { pending.push(line); continue; }
    const e = parseEntry(line);
    if (!e) return { error: 'Line ' + (n + 1) + ' is not a one-line key: value entry: ' + line.trim().slice(0, 60) };
    if (first) { head = pending; first = false; } else e.before = pending;
    e.before = e.before || [];
    pending = [];
    items.push(e);
  }
  if (items.length < 2) return { error: 'Need at least two key: value entries to sort' };
  const tail = pending;
  const slots = items.map(e => e.indent);       // indentation belongs to the line, not the entry
  const original = items.slice();
  items.sort(cmp);
  fixCommas(items, original);
  const out = head.slice();
  items.forEach((e, k) => {
    out.push(...e.before);
    out.push(slots[k] + e.head + (e.comma ? ',' : '') + e.tail);
  });
  out.push(...tail);
  return { text: pre + out.join('\\n') + post, count: items.length };
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
    "name": "Delete Blank Lines",
    "description": "Delete blank lines (remove empty lines) — whitespace-only lines too; works on the selection or the whole note",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='5' y1='12' x2='19' y2='12'/><line x1='12' y1='5' x2='12' y2='5.01'/><line x1='12' y1='19' x2='12' y2='19.01'/></svg>",
    "tags": "delete,remove,empty,blank,lines,strip,whitespace,clean"
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
