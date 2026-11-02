/* Lines Pack — Sort, dedupe, number, reshape lists and lines.
   Script-pack module: one file registering 33 palette scripts.
   The first 17 were extracted verbatim from txt.html (core slimming). */
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
  const hasCommaNumbers = /\\d{1,3}(,\\d{3})+/.test(text);
  let result;
  if (hasCommaNumbers) {
    // Remove commas from numbers
    result = text.replace(/(\\d{1,3})(,\\d{3})+/g, m => m.replace(/,/g, ''));
  } else {
    // Add commas to numbers
    result = text.replace(/\\b(\\d+)(\.\\d+)?\\b/g, (_, int, dec) => {
      const withCommas = int.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
      return dec ? withCommas + dec : withCommas;
    });
  }
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);


  // ===================================================================
  // Natural sorts, frequency, picking / chunking, grouping, set
  // operations and zips. These are written as real functions (the source
  // each row registers is built with String(fn)), so the helpers below are
  // shared instead of copied into every template string.
  // ===================================================================
  var SVG = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>";
  function reg(meta, main, helpers) {
    var head = { name: meta.name, description: meta.description, author: 'Cade', icon: SVG + meta.icon + '</svg>', tags: meta.tags };
    var src = '/**\n' + JSON.stringify(head, null, 2) + '\n**/\n' + String(main);
    for (var i = 0; helpers && i < helpers.length; i++) src += '\n\n' + String(helpers[i]);
    registerScript(src);
  }

  // ---- helpers (each is stringified into the scripts that use it) ----

  // The text to work on. Palette semantics: selection → current non-empty
  // line → whole note. A one-line "selection" that is really just the line
  // the cursor sits on is useless to a line-list transform, so those use the
  // whole note instead — unless keepLine(line) says the line itself is the
  // input (e.g. a comma-separated list on one line).
  function readInput(ctx, keepLine) {
    var sel = ctx.selection;
    if (sel) {
      var explicit = true;
      try { var ed = window.Cade && window.Cade.editor; if (ed) explicit = !ed.state.selection.main.empty; } catch (e) { /* keep */ }
      if (explicit || sel.indexOf('\n') >= 0 || (keepLine && keepLine(sel))) return { text: sel, sel: true };
    }
    return { text: ctx.fullText, sel: false };
  }
  function writeOutput(ctx, inp, out) {
    if (inp.sel) ctx.selection = out; else ctx.fullText = out;
  }

  // Split into lines, remembering the line ending (CRLF kept) and whether the
  // text ended with a newline, so the result can end the same way.
  function linesOf(text) {
    var eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    var lines = text.split(/\r?\n/);
    var trail = lines.length > 1 && lines[lines.length - 1] === '';
    if (trail) lines.pop();
    return { lines: lines, eol: eol, trail: trail };
  }
  function joinLines(info, lines) {
    return lines.join(info.eol) + (info.trail && lines.length ? info.eol : '');
  }

  // Ask with a remembered default (per device); null when cancelled.
  // "\t" typed literally means a tab.
  function ask(key, message, def) {
    var store = null, last = null;
    try { store = window.Cade && window.Cade.store; last = store ? store.get('cade-lines-' + key) : null; } catch (e) { /* storage blocked */ }
    var ans = prompt(message, last != null && last !== '' ? last : def);
    if (ans == null) return null;
    try { if (store) store.set('cade-lines-' + key, ans); } catch (e) { /* ignore */ }
    return ans;
  }
  function askInt(key, message, def, min) {
    var ans = ask(key, message, def);
    if (ans == null) return null;
    var m = /^\s*([+-]?\d+)\s*$/.exec(ans), n = m ? parseInt(m[1], 10) : NaN;
    if (!m || n < min || n === 0) { showToast('Enter a whole number' + (min > 0 ? ' (1 or more)' : ', e.g. 2 or -1'), 'error', 2500); return null; }
    return n;
  }

  // Human ("natural") order: runs of digits compare as numbers (file2 <
  // file10, v1.9 < v1.10), the rest case- and accent-insensitively. Equal
  // keys return 0 so a stable sort keeps their original order.
  function natCmp(a, b) {
    var ra = String(a).split(/(\d+)/), rb = String(b).split(/(\d+)/);
    var coll = natCmp.coll || (natCmp.coll = new Intl.Collator(undefined, { sensitivity: 'base' }));
    for (var i = 0, n = Math.min(ra.length, rb.length); i < n; i++) {
      var x = ra[i], y = rb[i];
      if (x === y) continue;
      var c;
      if (i % 2) {
        x = x.replace(/^0+(?=\d)/, ''); y = y.replace(/^0+(?=\d)/, '');
        c = x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
      } else c = coll.compare(x, y);
      if (c) return c;
    }
    return ra.length - rb.length;
  }
  // Natural-sort lines by key(line) (default: the trimmed line). Blank lines
  // go to the end (like Sort List); lines whose key is null go after the
  // keyed ones; ties keep their order.
  function natSortLines(lines, desc, key) {
    var items = [], blank = [];
    lines.forEach(function (l, i) {
      if (!l.trim()) blank.push(l);
      else items.push({ l: l, k: key ? key(l) : l.trim(), i: i });
    });
    items.sort(function (a, b) {
      if (a.k == null || b.k == null) return (a.k == null) - (b.k == null) || a.i - b.i;
      var c = natCmp(a.k, b.k);
      return (desc ? -c : c) || a.i - b.i;
    });
    return items.map(function (it) { return it.l; }).concat(blank);
  }
  function natSortMain(ctx, desc) {
    var inp = readInput(ctx, function (l) { return l.indexOf(',') >= 0; });
    var info = linesOf(inp.text), out;
    if (info.lines.length === 1 && info.lines[0].indexOf(',') >= 0) {
      var parts = info.lines[0].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      out = joinLines(info, [natSortLines(parts, desc).join(', ')]);
    } else {
      out = joinLines(info, natSortLines(info.lines, desc));
    }
    writeOutput(ctx, inp, out);
  }

  // Word n of a line (1-based; negative counts from the end), without the
  // punctuation around it ("Smith," → "Smith"); null when there is none.
  function nthWord(line, n) {
    var words = line.trim().split(/\s+/).filter(Boolean);
    var w = words[n > 0 ? n - 1 : words.length + n];
    if (w == null) return null;
    return w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') || w;
  }
  function sortByWordMain(ctx, n) {
    var inp = readInput(ctx);
    var info = linesOf(inp.text);
    writeOutput(ctx, inp, joinLines(info, natSortLines(info.lines, false, function (l) { return nthWord(l, n); })));
  }

  // Non-blank lines grouped by their trimmed text, in first-appearance order.
  function countLines(lines) {
    var map = new Map(), blank = [];
    lines.forEach(function (l) {
      var k = l.trim();
      if (!k) { blank.push(l); return; }
      var g = map.get(k);
      if (!g) { g = { key: k, n: 0, i: map.size, lines: [] }; map.set(k, g); }
      g.n++; g.lines.push(l);
    });
    var groups = Array.from(map.values()).sort(function (a, b) { return b.n - a.n || a.i - b.i; });
    return { groups: groups, blank: blank };
  }

  // "3" → lines 3, 6, 9…; "3+1" (or "3n+1") → lines 1, 4, 7…; odd / even.
  function parseNth(s) {
    s = String(s).trim().toLowerCase().replace(/\s+/g, '');
    if (s === 'odd') return { step: 2, start: 1 };
    if (s === 'even') return { step: 2, start: 2 };
    var m = /^(\d+)n?(?:\+(\d+))?$/.exec(s);
    if (!m) return null;
    var step = parseInt(m[1], 10), start = m[2] != null ? parseInt(m[2], 10) : step;
    return step >= 1 && start >= 1 ? { step: step, start: start } : null;
  }

  // Heading letter for Group by First Letter: the first letter or digit
  // (leading bullets / quotes skipped), uppercased, accents dropped; "#" for
  // digits, symbols and anything without a letter.
  function initialOf(line) {
    var t = line.trim(), m = /[\p{L}\p{N}]/u.exec(t);
    if (!m || /\p{N}/u.test(m[0])) return '#';
    var c = Array.from(t.slice(m.index))[0];
    var d = c.normalize('NFD').replace(/\p{M}+/gu, '');
    if (d.length === 1) c = d;
    var u = c.toUpperCase();
    return Array.from(u).length === 1 ? u : c;
  }

  // Separator for Group by Prefix when none is given: the candidate found
  // (not at the start) in the most lines, if that is at least half of them
  // (and 2+); otherwise " " — group by the first word.
  function detectSep(lines) {
    var cands = [':', ' - ', ' – ', ' — ', '|', '/', '=', '-', '_'], best = null, bestN = 0;
    cands.forEach(function (c) {
      var n = lines.filter(function (l) { return l.trim().indexOf(c) > 0; }).length;
      if (n > bestN) { best = c; bestN = n; }
    });
    return best && bestN >= Math.max(2, Math.ceil(lines.length / 2)) ? best : ' ';
  }
  function splitKey(line, sep) {
    var t = line.trim(), ws = !sep.trim();
    var i = ws ? t.search(/\s/) : t.indexOf(sep);
    if (i <= 0) return { key: t, rest: '' };
    return { key: t.slice(0, i).trim(), rest: t.slice(ws ? i : i + sep.length).trim() };
  }

  // Two lists in one text: split at the first line of --- (3+ dashes);
  // without one, the text must be exactly two blocks separated by blank
  // line(s). Returns { a, b } (raw non-blank lines) or { error }.
  function twoBlocks(text) {
    var lines = text.split(/\r?\n/), isSep = function (l) { return /^\s*-{3,}\s*$/.test(l); };
    var seps = lines.filter(isSep).length, a, b;
    var nb = function (ls) { return ls.filter(function (l) { return l.trim(); }); };
    if (seps > 1) return { error: 'Found more than one --- line — keep exactly two lists, separated by one ---' };
    if (seps === 1) {
      var cut = lines.findIndex(isSep);
      a = nb(lines.slice(0, cut)); b = nb(lines.slice(cut + 1));
    } else {
      var blocks = [], cur = null;
      lines.forEach(function (l) {
        if (!l.trim()) { cur = null; return; }
        if (!cur) { cur = []; blocks.push(cur); }
        cur.push(l);
      });
      if (blocks.length !== 2) return { error: 'Need two lists separated by a line of --- (or a blank line); found ' + blocks.length + ' block' + (blocks.length === 1 ? '' : 's') };
      a = blocks[0]; b = blocks[1];
    }
    if (!a.length || !b.length) return { error: 'List ' + (a.length ? 'B' : 'A') + ' is empty — put one list above the --- and one below' };
    return { a: a, b: b };
  }
  // A block as trimmed items: one item per line, or the comma-separated
  // items when the block is a single line with commas.
  function blockItems(block) {
    var t = block.map(function (l) { return l.trim(); });
    if (t.length === 1 && t[0].indexOf(',') >= 0) return { items: t[0].split(',').map(function (s) { return s.trim(); }).filter(Boolean), comma: true };
    return { items: t, comma: false };
  }
  function setOpMain(ctx, op) {
    var inp = readInput(ctx), text = inp.text;
    var two = twoBlocks(text);
    if (two.error) { showToast(two.error, 'error', 4000); return; }
    var A = blockItems(two.a), B = blockItems(two.b);
    var inA = new Set(A.items), inB = new Set(B.items), seen = new Set(), out = [];
    var add = function (x) { if (!seen.has(x)) { seen.add(x); out.push(x); } };
    A.items.forEach(function (x) {
      if (op === 'and' ? inB.has(x) : op === 'or' ? true : !inB.has(x)) add(x);
    });
    if (op === 'or' || op === 'xor') B.items.forEach(function (x) { if (op === 'or' || !inA.has(x)) add(x); });
    var label = { and: 'common to both lists', or: 'in either list', not: 'in A that are not in B', xor: 'in only one of the lists' }[op];
    if (!out.length) { showToast('No items ' + label + ' — text left as is', 'info', 3000); return; }
    var info = linesOf(text);
    writeOutput(ctx, inp, joinLines(info, A.comma && B.comma ? [out.join(', ')] : out));
  }

  function zipMain(ctx, sep) {
    var inp = readInput(ctx), text = inp.text;
    var two = twoBlocks(text);
    if (two.error) { showToast(two.error, 'error', 4000); return; }
    var a = two.a, b = two.b, out = [];
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      if (sep == null) {
        if (i < a.length) out.push(a[i]);
        if (i < b.length) out.push(b[i]);
      } else {
        out.push(((i < a.length ? a[i].trim() : '') + sep + (i < b.length ? b[i].trim() : '')).replace(/ +$/, ''));
      }
    }
    writeOutput(ctx, inp, joinLines(linesOf(text), out));
  }

  var IO = [readInput, writeOutput, linesOf, joinLines];
  var NAT = IO.concat([natCmp, natSortLines]);

  // ---- rows ----

  reg({
    name: 'Natural Sort',
    description: 'Sort lines (or one line of comma-separated items) in human order — file2 before file10, v1.9 before v1.10 — ignoring case; equal lines keep their order and blank lines go last',
    icon: "<path d='M4 6h7'/><path d='M4 12h7'/><path d='M4 18h7'/><path d='M17 4v16'/><polyline points='14 17 17 20 20 17'/><path d='M14 7l1.5-1.5V10'/>",
    tags: 'sort,natural,human,numeric,version,numbers,alphanumeric,file2,file10,list,order,asc,case-insensitive'
  }, function main(ctx) { natSortMain(ctx, false); }, NAT.concat([natSortMain]));

  reg({
    name: 'Natural Sort (Descending)',
    description: 'Sort lines (or comma-separated items) in reverse human order — file10 before file2, v1.10 before v1.9 — ignoring case; ties keep their order, blank lines go last',
    icon: "<path d='M4 6h7'/><path d='M4 12h7'/><path d='M4 18h7'/><path d='M17 20V4'/><polyline points='14 7 17 4 20 7'/>",
    tags: 'sort,natural,human,numeric,version,descending,desc,reverse,z-a,largest first,list,order'
  }, function main(ctx) { natSortMain(ctx, true); }, NAT.concat([natSortMain]));

  reg({
    name: 'Sort by Nth Word…',
    description: 'Sort lines by one word — asks which (2 = the second word, -1 = the last, -2 = second to last); natural order, punctuation around the word ignored, lines without that word go after',
    icon: "<path d='M3 6h4'/><path d='M3 12h4'/><path d='M3 18h4'/><path d='M10 6h5' stroke-width='3'/><path d='M10 12h5' stroke-width='3'/><path d='M10 18h5' stroke-width='3'/><path d='M20 4v16'/><polyline points='17.5 17.5 20 20 22.5 17.5'/>",
    tags: 'sort,word,nth,column,field,key,second word,last word,surname,by word,awk,sort -k'
  }, function main(ctx) {
    var n = askInt('nth-word', 'Sort by word number (1 = first, 2 = second, -1 = last):', '2', -Infinity);
    if (n == null) return;
    sortByWordMain(ctx, n);
  }, NAT.concat([ask, askInt, nthWord, sortByWordMain]));

  reg({
    name: 'Sort by Last Word',
    description: 'Sort lines by their last word (surnames, trailing numbers or tags) in natural order, punctuation around it ignored; ties keep their order',
    icon: "<path d='M3 6h7'/><path d='M3 12h7'/><path d='M3 18h7'/><path d='M13 6h3' stroke-width='3'/><path d='M13 12h3' stroke-width='3'/><path d='M13 18h3' stroke-width='3'/><path d='M20 4v16'/><polyline points='17.5 17.5 20 20 22.5 17.5'/>",
    tags: 'sort,last word,surname,last name,family name,end,word,by word,natural'
  }, function main(ctx) { sortByWordMain(ctx, -1); }, NAT.concat([nthWord, sortByWordMain]));

  reg({
    name: 'Sort by Frequency',
    description: 'Most common lines first, with duplicates grouped together; equally common lines keep their first-appearance order, blank lines go last',
    icon: "<rect x='3' y='4' width='18' height='4' rx='1'/><rect x='3' y='10' width='12' height='4' rx='1'/><rect x='3' y='16' width='6' height='4' rx='1'/>",
    tags: 'sort,frequency,most common,popular,count,duplicates,group,repeated,occurrences,histogram'
  }, function main(ctx) {
    var inp = readInput(ctx), info = linesOf(inp.text), c = countLines(info.lines), out = [];
    c.groups.forEach(function (g) { out.push.apply(out, g.lines); });
    writeOutput(ctx, inp, joinLines(info, out.concat(c.blank)));
  }, IO.concat([countLines]));

  reg({
    name: 'Count Duplicates',
    description: 'Like sort | uniq -c: each distinct line once, prefixed with how many times it appears (right-aligned), most frequent first, ties in first-appearance order; blank lines dropped',
    icon: "<path d='M3 5v6'/><path d='M6 5v6'/><path d='M9 5v6'/><path d='M2 10l8-4'/><path d='M13 8h8'/><path d='M3 16h3'/><path d='M13 16h8'/>",
    tags: 'count,duplicates,uniq,uniq -c,frequency,occurrences,tally,histogram,distinct,how many,dedupe'
  }, function main(ctx) {
    var inp = readInput(ctx), info = linesOf(inp.text), c = countLines(info.lines);
    if (!c.groups.length) { showToast('No lines to count', 'info', 2000); return; }
    var w = String(c.groups[0].n).length;
    writeOutput(ctx, inp, joinLines(info, c.groups.map(function (g) {
      return String(g.n).padStart(w, ' ') + ' ' + g.key;
    })));
  }, IO.concat([countLines]));

  reg({
    name: 'Every Nth Line…',
    description: 'Keep every Nth line — asks for N: "3" keeps lines 3, 6, 9…; "3+1" (or "3n+1") keeps lines 1, 4, 7…; "2+1" / "odd" every other line from the first, "even" from the second',
    icon: "<line x1='4' y1='5' x2='20' y2='5'/><line x1='4' y1='10' x2='20' y2='10' opacity='0.35'/><line x1='4' y1='15' x2='20' y2='15'/><line x1='4' y1='20' x2='20' y2='20' opacity='0.35'/>",
    tags: 'every,nth,line,odd,even,alternate,every other,skip,pick,sample,stride,step,filter,keep'
  }, function main(ctx) {
    var ans = ask('nth-line', 'Keep every Nth line — "3" = lines 3, 6, 9…; "3+1" = lines 1, 4, 7…; or "odd" / "even":', '2+1');
    if (ans == null) return;
    var p = parseNth(ans);
    if (!p) { showToast('Use N or N+start, e.g. 2, 2+1, 3+2, odd, even', 'error', 3500); return; }
    var inp = readInput(ctx), info = linesOf(inp.text);
    var out = info.lines.filter(function (l, i) { return i + 1 >= p.start && (i + 1 - p.start) % p.step === 0; });
    if (!out.length) { showToast('There is no line ' + p.start + ' — text left as is', 'info', 2500); return; }
    writeOutput(ctx, inp, joinLines(info, out));
  }, IO.concat([ask, parseNth]));

  reg({
    name: 'Chunk into Groups…',
    description: 'Split a list into groups of N lines with a blank line between groups — asks for N; existing blank lines are dropped first, so it can be re-run with a new size',
    icon: "<path d='M4 4h16'/><path d='M4 8h16'/><path d='M4 16h16'/><path d='M4 20h16'/>",
    tags: 'chunk,group,batch,split,paragraphs,blocks,every n,partition,blank line,sets of'
  }, function main(ctx) {
    var n = askInt('chunk', 'Lines per group:', '3', 1);
    if (n == null) return;
    var inp = readInput(ctx), info = linesOf(inp.text), out = [];
    info.lines.filter(function (l) { return l.trim(); }).forEach(function (l, i) {
      if (i && i % n === 0) out.push('');
      out.push(l);
    });
    writeOutput(ctx, inp, joinLines(info, out));
  }, IO.concat([ask, askInt]));

  reg({
    name: 'Group by First Letter',
    description: 'Sort lines naturally and put a heading line (A, B, C…) above each initial — accents folded (É → E), digits and symbols under "#" at the end, a blank line between groups, blank lines dropped',
    icon: "<path d='M3 11l3-8 3 8'/><path d='M4.2 8h3.6'/><path d='M12 5h9'/><path d='M12 9h9'/><path d='M7 15h14'/><path d='M7 19h14'/>",
    tags: 'group,first letter,initial,alphabet,alphabetical,index,a-z,headings,glossary,directory,sort'
  }, function main(ctx) {
    var inp = readInput(ctx), info = linesOf(inp.text), groups = new Map();
    natSortLines(info.lines.filter(function (l) { return l.trim(); }), false, function (l) {
      var t = l.trim(); return t.replace(/^[^\p{L}\p{N}]+/u, '') || t;
    }).forEach(function (l) {
      var h = initialOf(l);
      if (!groups.has(h)) groups.set(h, []);
      groups.get(h).push(l);
    });
    var heads = Array.from(groups.keys()).sort(function (a, b) { return (a === '#') - (b === '#') || natCmp(a, b); });
    var out = [];
    heads.forEach(function (h, i) {
      if (i) out.push('');
      out.push(h);
      out.push.apply(out, groups.get(h));
    });
    writeOutput(ctx, inp, joinLines(info, out));
  }, NAT.concat([initialOf]));

  reg({
    name: 'Group by Prefix…',
    description: 'Group lines that share the text before a separator — asks for it (blank = auto: ":", " - ", "|", "/", "=" or else the first word); each key becomes a heading with the rest of its lines as indented "- " bullets, groups in first-appearance order',
    icon: "<path d='M3 4h8'/><path d='M5 4v11'/><path d='M5 9h3'/><path d='M5 15h3'/><path d='M11 9h10'/><path d='M11 15h10'/><path d='M3 21h8' opacity='0.35'/>",
    tags: 'group,prefix,key,category,before colon,separator,outline,bullets,tree,nest,cluster,by key,first word'
  }, function main(ctx) {
    var ans = ask('prefix-sep', 'Group by the text before (blank = auto-detect ":", " - ", "|", "/" or the first word; \\t = tab):', '');
    if (ans == null) return;
    var inp = readInput(ctx), info = linesOf(inp.text);
    var lines = info.lines.filter(function (l) { return l.trim(); });
    if (!lines.length) { showToast('No lines to group', 'info', 2000); return; }
    var sep = ans.replace(/\\t/g, '\t');
    if (!sep || sep.trim().toLowerCase() === 'auto') sep = detectSep(lines);
    var groups = new Map();
    lines.forEach(function (l) {
      var kr = splitKey(l, sep);
      if (!groups.has(kr.key)) groups.set(kr.key, []);
      if (kr.rest) groups.get(kr.key).push(kr.rest);
    });
    var out = [];
    groups.forEach(function (rests, key) {
      if (out.length) out.push('');
      out.push(key);
      rests.forEach(function (r) { out.push('  - ' + r); });
    });
    writeOutput(ctx, inp, joinLines(info, out));
  }, IO.concat([ask, detectSep, splitKey]));

  var SETS = IO.concat([twoBlocks, blockItems, setOpMain]);
  var VENN = "<circle cx='9' cy='12' r='6'/><circle cx='15' cy='12' r='6'/>";
  var SETDESC = ' — two lists separated by a line of --- (or a blank line); items trimmed, compared case-sensitively, no duplicates, A’s order then B’s';
  reg({
    name: 'List Intersection',
    description: 'Items in both lists (A ∩ B)' + SETDESC,
    icon: VENN + "<path d='M12 6.8A6 6 0 0 1 12 17.2A6 6 0 0 1 12 6.8Z' fill='currentColor' stroke='none' opacity='0.5'/>",
    tags: 'intersection,intersect,common,both,in both,shared,and,set,compare,lists,overlap,venn'
  }, function main(ctx) { setOpMain(ctx, 'and'); }, SETS);

  reg({
    name: 'List Union',
    description: 'Every item from either list, once (A ∪ B)' + SETDESC,
    icon: "<circle cx='9' cy='12' r='6' fill='currentColor' fill-opacity='0.3'/><circle cx='15' cy='12' r='6' fill='currentColor' fill-opacity='0.3'/>",
    tags: 'union,merge,combine,either,or,set,lists,all,distinct,dedupe,venn'
  }, function main(ctx) { setOpMain(ctx, 'or'); }, SETS);

  reg({
    name: 'List Difference (A − B)',
    description: 'Items in the first list that are not in the second (A − B)' + SETDESC,
    icon: VENN + "<path d='M12 6.8A6 6 0 1 0 12 17.2A6 6 0 0 1 12 6.8Z' fill='currentColor' stroke='none' opacity='0.5'/>",
    tags: 'difference,minus,subtract,except,not in,missing,a - b,set,compare,lists,diff,venn'
  }, function main(ctx) { setOpMain(ctx, 'not'); }, SETS);

  reg({
    name: 'List Symmetric Difference',
    description: 'Items in exactly one of the two lists (A △ B)' + SETDESC,
    icon: VENN + "<path d='M12 6.8A6 6 0 1 0 12 17.2A6 6 0 0 1 12 6.8Z' fill='currentColor' stroke='none' opacity='0.5'/><path d='M12 6.8A6 6 0 1 1 12 17.2A6 6 0 0 0 12 6.8Z' fill='currentColor' stroke='none' opacity='0.5'/>",
    tags: 'symmetric difference,xor,either but not both,unique,only one,set,compare,lists,diff,venn'
  }, function main(ctx) { setOpMain(ctx, 'xor'); }, SETS);

  var ZIP = IO.concat([twoBlocks, zipMain]);
  reg({
    name: 'Zip Lines',
    description: 'Interleave two lists line by line — a1, b1, a2, b2… — separated by a line of --- (or a blank line); leftovers of the longer list go at the end',
    icon: "<path d='M4 5h10'/><path d='M10 10h10'/><path d='M4 15h10'/><path d='M10 20h10'/>",
    tags: 'zip,interleave,merge,alternate,weave,shuffle together,combine,two lists,pair'
  }, function main(ctx) { zipMain(ctx, null); }, ZIP);

  reg({
    name: 'Zip Into Columns…',
    description: 'Pair two lists side by side — "a1 | b1" — asks for the separator (default " | ", \\t = tab); lists separated by a line of --- (or a blank line), a missing partner leaves its side empty',
    icon: "<rect x='3' y='4' width='18' height='16' rx='2'/><line x1='12' y1='4' x2='12' y2='20'/><path d='M6 9h3'/><path d='M15 9h3'/><path d='M6 14h3'/><path d='M15 14h3'/>",
    tags: 'zip,columns,side by side,pair,join,combine,paste,two lists,table,tab,csv,merge'
  }, function main(ctx) {
    var sep = ask('zip-sep', 'Column separator (\\t = tab):', ' | ');
    if (sep == null) return;
    zipMain(ctx, sep.replace(/\\t/g, '\t'));
  }, ZIP.concat([ask]));

})();
