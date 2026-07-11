/* Tools Pack — Editor utilities: todos, time, quotes, counting.
   Script-pack module: one file registering 15 palette scripts.
   Extracted verbatim from txt.html (core slimming). */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var registerScript = function (src) { window.Cade.registerScript(src); };

registerScript(`/**
  {
    "name": "UTC → Local Time",
    "description": "Convert UTC times to local (supports 10:01, 14:01:00Z, ISO dates, epoch)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='10'/><polyline points='12 6 12 12 16 14'/></svg>",
    "tags": "utc,local,time,timezone,convert,date"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  function expandTime(t) {
    let clean = t.replace(/\\s*(AM|PM)/i, (_, ap) => ' ' + ap.toUpperCase()).trim();
    const ampm = clean.match(/(AM|PM)$/i);
    clean = clean.replace(/\\s*(AM|PM)$/i, '').trim();
    const parts = clean.split(':');
    let h = parseInt(parts[0]);
    if (ampm) {
      if (ampm[1].toUpperCase() === 'PM' && h < 12) h += 12;
      if (ampm[1].toUpperCase() === 'AM' && h === 12) h = 0;
    }
    return String(h).padStart(2, '0') + ':' + (parts[1] || '00') + ':' + (parts[2] || '00');
  }
  const today = new Date().toISOString().split('T')[0];
  let result = text;
  let changed = false;

  // ISO 8601 with date: 2024-01-15T10:01:00Z
  if (!changed) { const r = result.replace(/\\d{4}-\\d{2}-\\d{2}[T ]\\d{1,2}:\\d{2}(:\\d{2})?(\\.\\d+)?(Z|[+-]\\d{2}:?\\d{2})?/g, m => {
    const d = new Date(m.includes('Z') || /[+-]\\d{2}/.test(m) ? m : m + 'Z');
    return isNaN(d) ? m : d.toLocaleString();
  }); if (r !== result) { result = r; changed = true; } }

  // Unix epoch
  if (!changed) { const r = result.replace(/\\b(1\\d{9,12})\\b/g, m => {
    const n = parseInt(m); const d = new Date(n > 9999999999 ? n : n * 1000);
    return isNaN(d) ? m : d.toLocaleString();
  }); if (r !== result) { result = r; changed = true; } }

  // Bare time with Z suffix: 14:01:00Z or 14:01Z
  if (!changed) { const r = result.replace(/(\\d{1,2}:\\d{2}(:\\d{2})?)Z/g, (m, time) => {
    const d = new Date(today + 'T' + expandTime(time) + 'Z');
    return isNaN(d) ? m : d.toLocaleTimeString();
  }); if (r !== result) { result = r; changed = true; } }

  // Bare time without Z: 10:01, 3:05 PM — assume UTC
  if (!changed) { const r = result.replace(/(?:^|(?<=\\s))(\\d{1,2}:\\d{2}(:\\d{2})?\\s*(AM|PM)?)(?=\\s|$)/gi, (m, t) => {
    const d = new Date(today + 'T' + expandTime(t.trim()) + 'Z');
    return isNaN(d) ? m : d.toLocaleTimeString();
  }); if (r !== result) { result = r; changed = true; } }

  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Local Time → UTC",
    "description": "Convert local times to UTC (supports 10:01, dates, etc.)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='10'/><polyline points='12 6 12 12 8 14'/><path d='M2 12h2M20 12h2'/></svg>",
    "tags": "local,utc,time,timezone,convert,date"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  function expandTime(t) {
    let clean = t.replace(/\\s*(AM|PM)/i, (_, ap) => ' ' + ap.toUpperCase()).trim();
    const ampm = clean.match(/(AM|PM)$/i);
    clean = clean.replace(/\\s*(AM|PM)$/i, '').trim();
    const parts = clean.split(':');
    let h = parseInt(parts[0]);
    if (ampm) {
      if (ampm[1].toUpperCase() === 'PM' && h < 12) h += 12;
      if (ampm[1].toUpperCase() === 'AM' && h === 12) h = 0;
    }
    return String(h).padStart(2, '0') + ':' + (parts[1] || '00') + ':' + (parts[2] || '00');
  }
  function toUTCTime(d) {
    return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0') + ':' + String(d.getUTCSeconds()).padStart(2,'0') + 'Z';
  }
  const today = new Date().toISOString().split('T')[0];
  let result = text;
  let changed = false;

  // ISO-ish local (no Z or offset): 2024-01-15T10:01:00
  if (!changed) { const r = result.replace(/\\d{4}-\\d{2}-\\d{2}[T ]\\d{1,2}:\\d{2}(:\\d{2})?(\\.\\d+)?(?!Z)(?![+-]\\d{2})/g, m => {
    const d = new Date(m); return isNaN(d) ? m : d.toISOString().replace('.000', '');
  }); if (r !== result) { result = r; changed = true; } }

  // Bare time (no Z): 10:01, 3:05 PM — treat as local, output HH:MM:SSZ
  if (!changed) { const r = result.replace(/(?:^|(?<=\\s))(\\d{1,2}:\\d{2}(:\\d{2})?\\s*(AM|PM)?)(?=\\s|$)/gi, (m, t) => {
    const d = new Date(today + 'T' + expandTime(t.trim()));
    return isNaN(d) ? m : toUTCTime(d);
  }); if (r !== result) { result = r; changed = true; } }

  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Copy All to Clipboard",
    "description": "Copy the entire editor content to clipboard",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='9' y='9' width='13' height='13' rx='2' ry='2'/><path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'/></svg>",
    "tags": "copy,clipboard,all"
  }
**/
function main(ctx) {
  navigator.clipboard.writeText(ctx.fullText).then(() => {
    window.showToast('Copied to clipboard', 'success');
  }).catch(() => {
    window.showToast('Failed to copy', 'error');
  });
}`);

registerScript(`/**
  {
    "name": "Trim / Clean",
    "description": "Trim whitespace, remove blank lines, normalize spaces",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M9 7H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-4'/><path d='M9 7V3h6v4'/></svg>",
    "tags": "trim,clean,whitespace,strip,normalize"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const cleaned = text
    .split('\\n')
    .map(line => line.trim())
    .filter((line, i, arr) => !(line === '' && arr[i-1] === ''))
    .join('\\n')
    .trim();
  if (ctx.selection) ctx.selection = cleaned; else ctx.fullText = cleaned;
}`);

registerScript(`/**
  {
    "name": "Count Words",
    "description": "Count words, characters, sentences, and paragraphs",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 9h16'/><path d='M4 15h16'/><path d='M10 3 8 21'/><path d='M16 3 14 21'/></svg>",
    "tags": "count,words,characters,sentences,statistics,wc"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const words = text.trim() ? text.trim().split(/\\s+/).length : 0;
  const chars = text.length;
  const charsNoSpace = text.replace(/\\s/g, '').length;
  const sentences = (text.match(/[.!?]+/g) || []).length;
  const paragraphs = text.split(/\\n\\s*\\n/).filter(p => p.trim()).length;
  const lines = text.split('\\n').length;
  const report = [
    '--- Word Count ---',
    'Words: ' + words.toLocaleString(),
    'Characters: ' + chars.toLocaleString(),
    'Characters (no spaces): ' + charsNoSpace.toLocaleString(),
    'Sentences: ' + sentences.toLocaleString(),
    'Paragraphs: ' + paragraphs.toLocaleString(),
    'Lines: ' + lines.toLocaleString(),
  ].join('\\n');
  ctx.fullText = ctx.fullText + '\\n\\n' + report;
}`);

registerScript(`/**
  {
    "name": "Quoter",
    "description": "Wrap items in quotes (comma or newline delimited, toggles off)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M10 11c-1.5 0-3-1-3-3s1-3 3-3c1 0 2 .5 2 2'/><path d='M20 11c-1.5 0-3-1-3-3s1-3 3-3c1 0 2 .5 2 2'/></svg>",
    "tags": "quote,quoter,wrap,comma,list,string"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const isComma = text.includes(',') && text.split('\\n').length <= 2;
  const delim = isComma ? ',' : '\\n';
  const items = text.split(delim).map(s => s.trim()).filter(Boolean);
  // Check if already quoted — toggle off
  const allQuoted = items.every(s => /^["'].*["']$/.test(s));
  let result;
  if (allQuoted) {
    const unquoted = items.map(s => s.replace(/^["']|["']$/g, ''));
    result = isComma ? unquoted.join(', ') : unquoted.join('\\n');
  } else {
    const quoted = items.map(s => '"' + s.replace(/^["']|["']$/g, '') + '"');
    result = isComma ? quoted.join(', ') : quoted.join('\\n');
  }
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Toggle Todo",
    "description": "Toggle [ ]/[x] checkboxes on current or selected lines",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2'/><path d='M9 12l2 2 4-4'/></svg>",
    "tags": "todo,check,checkbox,toggle,done,task,list"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const full = ctx.fullText;
  const lines = text.split('\\n');
  const todoRe = /^(\\s*(?:[-•*]\\s+)?)\\[([ xX])\\](\\s.*)?$/;
  const hasTodos = lines.some(l => todoRe.test(l));

  // If checkboxes found but page missing @type: todo, prompt to add it
  if (hasTodos) {
    const firstLine = full.split('\\n')[0].trim().toLowerCase();
    const hasTypeDirective = firstLine.startsWith('@type:');
    const hasTodoType = hasTypeDirective && firstLine.split(':')[1].split(',').map(t => t.trim()).includes('todo');
    if (!hasTodoType) {
      if (confirm('This page is not marked as @type: todo. Add it?')) {
        if (hasTypeDirective) {
          // Append todo to existing @type line
          const origFirst = full.split('\\n')[0];
          ctx.fullText = full.replace(origFirst, origFirst + ', todo');
        } else {
          ctx.fullText = '@type: todo\\n' + full;
        }
      }
    }
  }

  let result;
  if (hasTodos) {
    // Toggle existing checkboxes + apply/remove strikethrough
    result = lines.map(l => {
      const m = l.match(todoRe);
      if (!m) return l;
      const isDone = m[2] !== ' ';
      const rest = m[3] || '';
      if (isDone) {
        // Unchecking: remove combining strikethrough
        return m[1] + '[ ]' + rest.replace(/\\u0336/g, '');
      } else {
        // Checking: add combining strikethrough to text after checkbox (skip leading space)
        const struck = rest.length > 0 ? rest[0] + [...rest.slice(1)].map(ch => ch + '\\u0336').join('') : '';
        return m[1] + '[x]' + struck;
      }
    }).join('\\n');
  } else {
    // Add [ ] to lines that don't have it
    result = lines.map(l => {
      if (l.trim() === '') return l;
      const indent = l.match(/^(\\s*)/)[1];
      const content = l.trim().replace(/^[-•*]\\s+/, '');
      return indent + '[ ] ' + content;
    }).join('\\n');
  }
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Convert Todo",
    "description": "Convert lines to a todo list, or revert a todo list back to bullets",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/><path d='M14 2v6h6'/><path d='M9 15l2 2 4-4'/></svg>",
    "tags": "todo,convert,list,checkbox,bullet"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const lines = text.split('\\n');
  const todoRe = /^(\\s*)(?:[-\u2022*]\\s+)?\\[([ xX])\\]\\s?(.*)/;
  const isTodo = lines.some(l => todoRe.test(l));

  let result;
  if (isTodo) {
    // Remove todo checkboxes -> convert to bulleted list, strip strikethrough
    result = lines.map(l => {
      const m = l.match(todoRe);
      if (!m) return l;
      const indent = m[1];
      const content = (m[3] || '').replace(/\\u0336/g, '');
      return indent + '- ' + content;
    }).join('\\n');
  } else {
    // Convert lines to todo list - strip existing bullets/numbers/letters
    result = lines.map(l => {
      if (l.trim() === '') return l;
      const indent = l.match(/^(\\s*)/)[1];
      const content = l.trim().replace(/^[-\u2022*]\\s+/, '').replace(/^\\d{1,3}\\.\\s+/, '').replace(/^[A-Za-z]\\.\\s+/, '').replace(/^\\[\\d+\\]\\s+/, '');
      return indent + '[ ] ' + content;
    }).join('\\n');
  }
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Timestamp",
    "description": "Insert current date and time",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='4' width='18' height='18' rx='2' ry='2'/><line x1='16' y1='2' x2='16' y2='6'/><line x1='8' y1='2' x2='8' y2='6'/><line x1='3' y1='10' x2='21' y2='10'/></svg>",
    "tags": "timestamp,date,time,now,insert,today"
  }
**/
function main(ctx) {
  const now = new Date();
  const stamp = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + ' ' + now.toLocaleTimeString();
  ctx.fullText = ctx.fullText ? ctx.fullText + '\\n\\n' + stamp : stamp;
}`);

registerScript(`/**
  {
    "name": "Clean Quotes",
    "description": "Convert curly/typographic quotes to straight standard quotes",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M10 8c-2 0-3 1-3 3v1h2v-1c0-1 0-1 1-1'/><path d='M18 8c-2 0-3 1-3 3v1h2v-1c0-1 0-1 1-1'/></svg>",
    "tags": "clean,quotes,straight,curly,typographic,fix,normalize"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const result = text
    .replace(/[\\u201c\\u201d\\u201e\\u201f\\u2033\\u2036\\u301d\\u301e\\uFF02]/g, '"')
    .replace(/[\\u2018\\u2019\\u201a\\u201b\\u2032\\u2035\\u0060\\u00b4\\uFF07]/g, "'")
    .replace(/[\\u2013\\u2014]/g, '-')
    .replace(/\\u2026/g, '...');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Align Comments",
    "description": "Pad inline comments so they line up across consecutive lines. Auto-detects Python (#) and JS (//) syntax.",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='3' y1='6' x2='21' y2='6'/><line x1='3' y1='12' x2='15' y2='12'/><line x1='3' y1='18' x2='18' y2='18'/></svg>",
    "tags": "align,comments,padding,format,python,javascript"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const lines = text.split('\\n');

  // Auto-detect language by scoring keywords
  const pyScore = (text.match(/\\bdef \\b|\\bimport \\b|\\bclass \\b|\\bself\\b/g) || []).length;
  const jsScore = (text.match(/\\bfunction\\b|\\bconst\\b|\\blet\\b|\\bvar\\b|=>/g) || []).length;
  const marker = pyScore >= jsScore ? '#' : '//';

  // Return the character index of the inline comment marker, or null if none / full-line comment
  function findInlineComment(line) {
    let inSingle = false, inDouble = false, inTemplate = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\\\' && (inSingle || inDouble || inTemplate)) { i++; continue; }
      if (ch === '\`' && !inSingle && !inDouble) { inTemplate = !inTemplate; continue; }
      if (ch === "'" && !inDouble && !inTemplate) { inSingle = !inSingle; continue; }
      if (ch === '"' && !inSingle && !inTemplate) { inDouble = !inDouble; continue; }
      if (!inSingle && !inDouble && !inTemplate) {
        if (marker === '#' && ch === '#') {
          if (line.slice(0, i).trim() === '') return null; // full-line comment
          return i;
        }
        if (marker === '//' && ch === '/' && line[i + 1] === '/') {
          if (line.slice(0, i).trim() === '') return null; // full-line comment
          return i;
        }
      }
    }
    return null;
  }

  const result = [];
  let i = 0;

  while (i < lines.length) {
    const groupStart = i;
    const group = [];

    // Collect consecutive lines that each have an inline comment
    while (i < lines.length) {
      const commentIdx = findInlineComment(lines[i]);
      if (commentIdx !== null) {
        const codePart = lines[i].slice(0, commentIdx).trimEnd();
        const commentPart = lines[i].slice(commentIdx);
        group.push({ line: lines[i], codePart, commentPart });
        i++;
      } else {
        break;
      }
    }

    if (group.length >= 2) {
      const maxLen = Math.max(...group.map(g => g.codePart.length));
      for (const g of group) {
        result.push(g.codePart + ' '.repeat(maxLen - g.codePart.length + 2) + g.commentPart);
      }
    } else if (group.length === 1) {
      result.push(group[0].line); // single line — nothing to align
    }

    if (i === groupStart) {
      result.push(lines[i]); // line with no comment, pass through
      i++;
    }
  }

  const output = result.join('\\n');
  if (ctx.selection) ctx.selection = output; else ctx.fullText = output;
}`);

registerScript(`/**
  {
    "name": "Round To",
    "description": "Round all decimal numbers to a specified number of decimal places",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='10'/><line x1='12' y1='8' x2='12' y2='12'/><line x1='12' y1='16' x2='12.01' y2='16'/></svg>",
    "tags": "round,decimal,places,precision,number,format"
  }
**/
function main(ctx) {
  const decimals = parseInt(prompt('Decimal places (0–10):', '2'), 10);
  if (isNaN(decimals) || decimals < 0 || decimals > 10) return;
  const text = ctx.selection || ctx.fullText;
  const result = text.replace(/\b\d+\.\d+\b/g, m => parseFloat(m).toFixed(decimals));
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Copy Block",
    "description": "Copy the current contiguous block (to next blank line or end of doc) to clipboard",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='9' y='9' width='13' height='13' rx='2' ry='2'/><path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'/></svg>",
    "tags": "copy,clipboard,block,paragraph"
  }
**/
function main(ctx) {
  // Uses the contiguous block via ctx.selection (new block-aware behaviour)
  const text = ctx.selection || ctx.fullText;
  if (!text.trim()) { showToast('Nothing to copy', 'error', 2000); return; }
  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied ' + text.split('\n').length + ' lines to clipboard', 'success', 2000);
  }).catch(() => {
    showToast('Copy failed', 'error', 2000);
  });
}`);

registerScript(`/**
  {
    "name": "Convert",
    "description": "Unit conversions: °F↔°C, in↔cm, ft↔m, mi↔km, lb↔kg, oz↔g, KB↔MB↔GB, and more",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M8 3L4 7l4 4'/><path d='M4 7h16'/><path d='M16 21l4-4-4-4'/><path d='M20 17H4'/></svg>",
    "tags": "convert,unit,temperature,length,weight,data,fahrenheit,celsius,inches,centimeters,feet,meters,miles,kilometers,pounds,kilograms,kilobyte,megabyte,gigabyte"
  }
**/
function main(ctx) {
  const CONVERSIONS = {
    // Temperature
    'f>c':   { label: '°F → °C',   fn: v => (v - 32) * 5/9,    fmt: v => v.toFixed(2) + ' °C' },
    'c>f':   { label: '°C → °F',   fn: v => v * 9/5 + 32,      fmt: v => v.toFixed(2) + ' °F' },
    // Length
    'in>cm': { label: 'in → cm',   fn: v => v * 2.54,           fmt: v => v.toFixed(4) + ' cm' },
    'cm>in': { label: 'cm → in',   fn: v => v / 2.54,           fmt: v => v.toFixed(4) + ' in' },
    'ft>m':  { label: 'ft → m',    fn: v => v * 0.3048,         fmt: v => v.toFixed(4) + ' m' },
    'm>ft':  { label: 'm → ft',    fn: v => v / 0.3048,         fmt: v => v.toFixed(4) + ' ft' },
    'mi>km': { label: 'mi → km',   fn: v => v * 1.60934,        fmt: v => v.toFixed(4) + ' km' },
    'km>mi': { label: 'km → mi',   fn: v => v / 1.60934,        fmt: v => v.toFixed(4) + ' mi' },
    'yd>m':  { label: 'yd → m',    fn: v => v * 0.9144,         fmt: v => v.toFixed(4) + ' m' },
    'm>yd':  { label: 'm → yd',    fn: v => v / 0.9144,         fmt: v => v.toFixed(4) + ' yd' },
    // Weight
    'lb>kg': { label: 'lb → kg',   fn: v => v * 0.453592,       fmt: v => v.toFixed(4) + ' kg' },
    'kg>lb': { label: 'kg → lb',   fn: v => v / 0.453592,       fmt: v => v.toFixed(4) + ' lb' },
    'oz>g':  { label: 'oz → g',    fn: v => v * 28.3495,        fmt: v => v.toFixed(4) + ' g' },
    'g>oz':  { label: 'g → oz',    fn: v => v / 28.3495,        fmt: v => v.toFixed(4) + ' oz' },
    // Data
    'kb>mb': { label: 'KB → MB',   fn: v => v / 1024,           fmt: v => v.toFixed(4) + ' MB' },
    'mb>kb': { label: 'MB → KB',   fn: v => v * 1024,           fmt: v => v.toFixed(0) + ' KB' },
    'mb>gb': { label: 'MB → GB',   fn: v => v / 1024,           fmt: v => v.toFixed(4) + ' GB' },
    'gb>mb': { label: 'GB → MB',   fn: v => v * 1024,           fmt: v => v.toFixed(0) + ' MB' },
    'kb>gb': { label: 'KB → GB',   fn: v => v / 1048576,        fmt: v => v.toFixed(6) + ' GB' },
    'gb>kb': { label: 'GB → KB',   fn: v => v * 1048576,        fmt: v => v.toFixed(0) + ' KB' },
    'gb>tb': { label: 'GB → TB',   fn: v => v / 1024,           fmt: v => v.toFixed(4) + ' TB' },
    'tb>gb': { label: 'TB → GB',   fn: v => v * 1024,           fmt: v => v.toFixed(0) + ' GB' },
    // Speed
    'mph>kph': { label: 'mph → km/h', fn: v => v * 1.60934,     fmt: v => v.toFixed(2) + ' km/h' },
    'kph>mph': { label: 'km/h → mph', fn: v => v / 1.60934,     fmt: v => v.toFixed(2) + ' mph' },
    // Area
    'sqft>sqm': { label: 'ft² → m²', fn: v => v * 0.092903,    fmt: v => v.toFixed(4) + ' m²' },
    'sqm>sqft': { label: 'm² → ft²', fn: v => v / 0.092903,    fmt: v => v.toFixed(4) + ' ft²' },
    // Volume
    'l>gal':  { label: 'L → gal',  fn: v => v * 0.264172,       fmt: v => v.toFixed(4) + ' gal' },
    'gal>l':  { label: 'gal → L',  fn: v => v / 0.264172,       fmt: v => v.toFixed(4) + ' L' },
    // Pressure
    'psi>bar':  { label: 'psi → bar', fn: v => v * 0.0689476,   fmt: v => v.toFixed(4) + ' bar' },
    'bar>psi':  { label: 'bar → psi', fn: v => v / 0.0689476,   fmt: v => v.toFixed(2) + ' psi' },
  };

  const MENU = [
    '── Temperature ──────────────────',
    '  f>c   °F → °C',
    '  c>f   °C → °F',
    '── Length ───────────────────────',
    '  in>cm  inches → centimeters',
    '  cm>in  centimeters → inches',
    '  ft>m   feet → meters',
    '  m>ft   meters → feet',
    '  mi>km  miles → kilometers',
    '  km>mi  kilometers → miles',
    '  yd>m   yards → meters',
    '  m>yd   meters → yards',
    '── Weight ───────────────────────',
    '  lb>kg  pounds → kilograms',
    '  kg>lb  kilograms → pounds',
    '  oz>g   ounces → grams',
    '  g>oz   grams → ounces',
    '── Data Storage ─────────────────',
    '  kb>mb  KB → MB',
    '  mb>kb  MB → KB',
    '  mb>gb  MB → GB',
    '  gb>mb  GB → MB',
    '  kb>gb  KB → GB',
    '  gb>kb  GB → KB',
    '  gb>tb  GB → TB',
    '  tb>gb  TB → GB',
    '── Speed ────────────────────────',
    '  mph>kph  mph → km/h',
    '  kph>mph  km/h → mph',
    '── Area ─────────────────────────',
    '  sqft>sqm  ft² → m²',
    '  sqm>sqft  m² → ft²',
    '── Volume ───────────────────────',
    '  l>gal  litres → gallons',
    '  gal>l  gallons → litres',
    '── Pressure ─────────────────────',
    '  psi>bar  psi → bar',
    '  bar>psi  bar → psi',
  ].join('\\n');

  const text = (ctx.selection || ctx.fullText).trim();
  // Try to auto-detect: "42.5 f>c" or just a number when a code is in selection hint
  const autoMatch = text.match(/^([\\d.\\-]+)\\s+([a-z>]+)$/i);
  let code, value;

  if (autoMatch) {
    value = parseFloat(autoMatch[1]);
    code = autoMatch[2].toLowerCase();
  } else {
    const raw = prompt('Convert: Enter code and value (e.g. "98.6 f>c") or just a code to see options:\\n\\n' + MENU);
    if (!raw) return;
    const parts = raw.trim().split(/\\s+/);
    // Support "98.6 f>c" or "f>c 98.6"
    if (parts.length === 2) {
      if (!isNaN(parts[0])) { value = parseFloat(parts[0]); code = parts[1].toLowerCase(); }
      else { code = parts[0].toLowerCase(); value = parseFloat(parts[1]); }
    } else if (parts.length === 1) {
      code = parts[0].toLowerCase();
      const numStr = prompt('Enter the value to convert:');
      if (numStr === null) return;
      value = parseFloat(numStr);
    } else {
      showToast('Invalid input. Try "98.6 f>c"', 'error');
      return;
    }
  }

  const conv = CONVERSIONS[code];
  if (!conv) { showToast('Unknown conversion: ' + code, 'error'); return; }
  if (isNaN(value)) { showToast('Invalid number', 'error'); return; }

  const result = conv.fmt(conv.fn(value));
  if (ctx.selection) ctx.selection = result; else ctx.fullText += (ctx.fullText ? '\\n' : '') + result;
  showToast(value + ' ' + conv.label.split(' → ')[0].replace('°','°') + ' = ' + result, 'success', 3000);
}`);

registerScript(`/**
  {
    "name": "Clean Diary",
    "description": "Remove empty date entries from a @type: diary document",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='3 6 5 6 21 6'/><path d='M19 6l-1 14H6L5 6'/><path d='M10 11v6M14 11v6'/><path d='M9 6V4h6v2'/></svg>",
    "tags": "diary,clean,empty,date"
  }
**/
function main(ctx) {
  const lines = ctx.fullText.split('\\n');
  const HEADER = /^(January|February|March|April|May|June|July|August|September|October|November|December) \\d+(?:st|nd|rd|th), \\d{4} -$/;
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (HEADER.test(lines[i])) {
      const header = lines[i];
      let j = i + 1;
      while (j < lines.length && !HEADER.test(lines[j])) j++;
      const block = lines.slice(i + 1, j);
      const hasContent = block.some(l => l.trim() !== '');
      if (hasContent) { out.push(header); out.push(...block); }
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  while (out.length > 1 && out[out.length - 1].trim() === '') out.pop();
  ctx.fullText = out.join('\\n');
}
`);

})();
