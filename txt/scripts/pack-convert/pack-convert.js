/* Convert Pack — Encode/decode and format conversions.
   Script-pack module: one file registering 13 palette scripts.
   Extracted verbatim from txt.html (core slimming). */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var registerScript = function (src) { window.Cade.registerScript(src); };

registerScript(`/**
  {
    "name": "Clear Markdown",
    "description": "Strip markdown emphasis (bold/italic/underline/strike/code/highlight) but keep # heading marks",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 7h18'/><path d='M3 12h12'/><path d='M3 17h6'/></svg>",
    "tags": "clear,strip,markdown,plain,bold,italic,underline,remove,format"
  }
**/
function main(ctx) {
  var text = ctx.selection || ctx.fullText;
  var result = window.clearMarkdownInline ? window.clearMarkdownInline(text) : text;
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Super Clear Styles",
    "description": "Strip BOTH Unicode fancy text and markdown formatting — back to plain (keeps # headings)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 3l18 18'/><path d='M21 3L3 21'/></svg>",
    "tags": "clear,strip,plain,reset,defancify,markdown,super,all,format,remove"
  }
**/
function main(ctx) {
  var text = ctx.selection || ctx.fullText;
  var result = window.defancifyText ? window.defancifyText(text) : text;
  result = window.clearMarkdownInline ? window.clearMarkdownInline(result) : result;
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Encode Base64",
    "description": "Encode text to Base64",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='16 18 22 12 16 6'/><polyline points='8 6 2 12 8 18'/></svg>",
    "tags": "encode,base64,btoa"
  }
**/
function main(ctx) {
  try {
    const text = ctx.selection || ctx.fullText;
    const encoded = btoa(unescape(encodeURIComponent(text)));
    if (ctx.selection) ctx.selection = encoded; else ctx.fullText = encoded;
  } catch (e) { throw new Error('Base64 encode failed: ' + e.message); }
}`);

registerScript(`/**
  {
    "name": "Decode Base64",
    "description": "Decode Base64 back to text",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='8 18 2 12 8 6'/><polyline points='16 6 22 12 16 18'/></svg>",
    "tags": "decode,base64,atob"
  }
**/
function main(ctx) {
  try {
    const text = ctx.selection || ctx.fullText;
    const decoded = decodeURIComponent(escape(atob(text.trim())));
    if (ctx.selection) ctx.selection = decoded; else ctx.fullText = decoded;
  } catch (e) { throw new Error('Base64 decode failed: ' + e.message); }
}`);

registerScript(`/**
  {
    "name": "Encode URL",
    "description": "URL-encode the text (percent encoding)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'/><path d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'/></svg>",
    "tags": "url,encode,percent,uri,escape"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const encoded = encodeURIComponent(text);
  if (ctx.selection) ctx.selection = encoded; else ctx.fullText = encoded;
}`);

registerScript(`/**
  {
    "name": "Decode URL",
    "description": "Decode URL-encoded text (percent decoding)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'/><path d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'/></svg>",
    "tags": "url,decode,percent,uri,unescape"
  }
**/
function main(ctx) {
  try {
    const text = ctx.selection || ctx.fullText;
    const decoded = decodeURIComponent(text);
    if (ctx.selection) ctx.selection = decoded; else ctx.fullText = decoded;
  } catch (e) { throw new Error('URL decode failed: ' + e.message); }
}`);

registerScript(`/**
  {
    "name": "Markdown to Plain",
    "description": "Strip Markdown formatting to plain text",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='2' y='4' width='20' height='16' rx='2'/><path d='M7 15V9l2.5 3L12 9v6'/><path d='M17 9l-2 6h4'/></svg>",
    "tags": "markdown,plain,text,strip,remove,formatting"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  let result = text
    .replace(/^#{1,6}\\s+/gm, '')
    .replace(/\\*\\*(.+?)\\*\\*/g, '$1')
    .replace(/\\*(.+?)\\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\`(.+?)\`/g, '$1')
    .replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g, '$1')
    .replace(/^[\\s]*[-*+]\\s+/gm, '')
    .replace(/^[\\s]*\\d+\\.\\s+/gm, '')
    .replace(/^>\\s+/gm, '')
    .replace(/^---+$/gm, '');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Hex ↔ RGB",
    "description": "Convert hex colors to RGB and vice versa",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='13.5' cy='6.5' r='4'/><circle cx='17.5' cy='14.5' r='4'/><circle cx='8.5' cy='14.5' r='4'/></svg>",
    "tags": "hex,rgb,color,colour,convert,css"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const hasHex = /#([0-9a-fA-F]{3}){1,2}\\b/.test(text);
  let result;
  if (hasHex) {
    result = text
      .replace(/#([0-9a-fA-F]{6})\\b/gi, (_, h) => {
        const r = parseInt(h.substr(0,2),16), g = parseInt(h.substr(2,2),16), b = parseInt(h.substr(4,2),16);
        return 'rgb(' + r + ', ' + g + ', ' + b + ')';
      })
      .replace(/#([0-9a-fA-F]{3})\\b/gi, (_, h) => {
        const r = parseInt(h[0]+h[0],16), g = parseInt(h[1]+h[1],16), b = parseInt(h[2]+h[2],16);
        return 'rgb(' + r + ', ' + g + ', ' + b + ')';
      });
  } else {
    result = text.replace(/rgb\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\)/gi, (_, r, g, b) => {
      return '#' + [r,g,b].map(n => parseInt(n).toString(16).padStart(2,'0')).join('');
    });
  }
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Escape HTML",
    "description": "Escape HTML special characters (&, <, >, quotes)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='16 18 22 12 16 6'/><polyline points='8 6 2 12 8 18'/><line x1='14' y1='4' x2='10' y2='20'/></svg>",
    "tags": "escape,html,encode,entities,xss,sanitize"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const result = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Unescape HTML",
    "description": "Unescape HTML entities back to characters",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='8 18 2 12 8 6'/><polyline points='16 6 22 12 16 18'/><line x1='10' y1='20' x2='14' y2='4'/></svg>",
    "tags": "unescape,html,decode,entities"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const result = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec)));
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Strip HTML Tags",
    "description": "Remove all HTML tags, keeping text content",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='16 18 22 12 16 6'/><polyline points='8 6 2 12 8 18'/><line x1='4' y1='4' x2='20' y2='20'/></svg>",
    "tags": "strip,html,tags,remove,clean,text"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const result = text.replace(/<[^>]*>/g, '').replace(/\\s+/g, ' ').trim();
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "JSON to CSV",
    "description": "Convert JSON array of objects to CSV",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z'/><polyline points='14 2 14 8 20 8'/><line x1='8' y1='13' x2='16' y2='13'/><line x1='8' y1='17' x2='16' y2='17'/></svg>",
    "tags": "json,csv,convert,export,data,table"
  }
**/
function main(ctx) {
  try {
    const text = ctx.selection || ctx.fullText;
    const data = JSON.parse(text);
    if (!Array.isArray(data) || data.length === 0) throw new Error('Expected a non-empty JSON array');
    const headers = [...new Set(data.flatMap(Object.keys))];
    const escape = v => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') || s.includes('\\n') ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const csv = [headers.join(','), ...data.map(row => headers.map(h => escape(row[h])).join(','))].join('\\n');
    if (ctx.selection) ctx.selection = csv; else ctx.fullText = csv;
  } catch (e) { throw new Error('JSON→CSV failed: ' + e.message); }
}`);

registerScript(`/**
  {
    "name": "ROT13",
    "description": "Apply ROT13 cipher (rotate letters by 13)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='11' width='18' height='11' rx='2' ry='2'/><path d='M7 11V7a5 5 0 0 1 10 0v4'/></svg>",
    "tags": "rot13,cipher,encode,decode,crypto,fun"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const result = text.replace(/[a-zA-Z]/g, c => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

})();
