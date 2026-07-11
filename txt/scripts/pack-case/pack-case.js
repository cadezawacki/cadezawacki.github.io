/* Case Pack — Text case transforms.
   Script-pack module: one file registering 7 palette scripts.
   Extracted verbatim from txt.html (core slimming). */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var registerScript = function (src) { window.Cade.registerScript(src); };

registerScript(`/**
  {
    "name": "Upper Case",
    "description": "Convert text to UPPER CASE",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 20h4l10-14h4'/><path d='M7 20L17 6'/></svg>",
    "tags": "upper,case,uppercase,caps"
  }
**/
function main(ctx) {
  if (ctx.selection) { ctx.selection = ctx.selection.toUpperCase(); }
  else { ctx.fullText = ctx.fullText.toUpperCase(); }
}`);

registerScript(`/**
  {
    "name": "Lower Case",
    "description": "Convert text to lower case",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 20h4l10-14h4'/><path d='M17 20L7 6'/></svg>",
    "tags": "lower,case,lowercase"
  }
**/
function main(ctx) {
  if (ctx.selection) { ctx.selection = ctx.selection.toLowerCase(); }
  else { ctx.fullText = ctx.fullText.toLowerCase(); }
}`);

registerScript(`/**
  {
    "name": "Title Case",
    "description": "Convert text to Title Case",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='4 7 4 4 20 4 20 7'/><line x1='9' y1='20' x2='15' y2='20'/><line x1='12' y1='4' x2='12' y2='20'/></svg>",
    "tags": "title,case,capitalize"
  }
**/
function main(ctx) {
  const minor = new Set(['a','an','the','and','but','or','for','nor','on','at','to','by','in','of','up','as','is','if','it','so','no']);
  function titleCase(str) {
    return str.replace(/\\S+/g, (word, idx) => {
      if (idx > 0 && minor.has(word.toLowerCase())) return word.toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });
  }
  if (ctx.selection) { ctx.selection = titleCase(ctx.selection); }
  else { ctx.fullText = titleCase(ctx.fullText); }
}`);

registerScript(`/**
  {
    "name": "camelCase",
    "description": "Convert text to camelCase",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24'><path fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M12 13.72c-.69-.41-1-.894-1-1.22m1 1.22V20H8.5l1.5-2l-1-4.5C6 13.5 4.5 10 4.5 8H3a1 1 0 0 1-1-1a2 2 0 0 1 2-2h1.5l.268-.402a1.248 1.248 0 0 1 2.077 1.384L7.5 6.5c-.167.667-.2 2.1 1 2.5c.667.167 2.1 0 2.5-2c.5-1.5 1.5-4 3.5-4c1.616 0 1.926 2.284 3.83 3.953c.904.79 1.67 1.825 1.67 3.025V20h-3l1-2l-.5-3.771c-1.707.526-3.957.41-5.5-.508M19.299 8S22 8.5 22 12'/></svg>",
    "tags": "camel,case,camelCase,convert,variable"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const result = text.replace(/[-_ ]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, c => c.toLowerCase());
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "snake_case",
    "description": "Convert text to snake_case",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='3' y1='18' x2='21' y2='18'/><path d='M3 12h4l2-4 4 8 2-4h6'/></svg>",
    "tags": "snake,case,snake_case,convert,variable,underscore"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const result = text
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-\\s]+/g, '_')
    .toLowerCase();
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "kebab-case",
    "description": "Convert text to kebab-case",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='3' y1='12' x2='21' y2='12'/><circle cx='7' cy='12' r='1'/><circle cx='12' cy='12' r='1'/><circle cx='17' cy='12' r='1'/></svg>",
    "tags": "kebab,case,kebab-case,convert,variable,dash,slug"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const result = text
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[_\\s]+/g, '-')
    .toLowerCase();
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "CONSTANT_CASE",
    "description": "Convert text to CONSTANT_CASE (screaming snake)",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 7V4h16v3'/><path d='M9 20h6'/><path d='M12 4v16'/></svg>",
    "tags": "constant,case,screaming,snake,upper,variable,env"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const result = text
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-\\s]+/g, '_')
    .toUpperCase();
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

})();
