/* Code Pack - minify, obfuscate, unobfuscate and beautify code (JS, Python,
   HTML, CSS, plus JSON/XML; Beautify also TS, SCSS/Less, Vue, Markdown, YAML,
   GraphQL). Script-pack module: registers 14 palette scripts, each a
   thin wrapper that lazily loads the shared engine (pack-code-lib.js) on first
   run and delegates to it. The engine, in turn, lazy-loads terser /
   js-beautify / javascript-obfuscator / Prettier (only the plugins a language
   needs) from cdn.jsdelivr.net only when needed,
   so this module costs nothing until a user actually runs one of its scripts.

   Input resolution (done by the engine against the live CodeMirror state):
   explicit selection -> the fenced code block (``` / ~~~) the cursor is in ->
   the whole document. Output replaces the same range; when the input was the
   inside of a fence, the fence is kept. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;

  // Resolve the shared library URL AT MODULE-LOAD TIME (folder context only
  // valid now), then inject it into each script's source as a literal.
  var LIB_URL = Cade.asset('pack-code-lib.js');

  // Prelude placed at the top of every script's async main: ensures the engine
  // is loaded, then exposes it as `L`. Scripts are eval'd in isolation and
  // cannot see this IIFE's vars, so the URL is baked into the string.
  var ENSURE =
    'if(!window.__CADE_CODEPACK__){' +
      'await new Promise(function(res,rej){' +
        'var s=document.createElement("script");' +
        's.src=' + JSON.stringify(LIB_URL) + ';' +
        's.onload=function(){res();};' +
        's.onerror=function(){rej(new Error("Code Pack library failed to load"));};' +
        'document.head.appendChild(s);' +
      '}).catch(function(e){showToast(e.message,"error",4000);});' +
    '}' +
    'if(!window.__CADE_CODEPACK__){return;}' +
    'var L=window.__CADE_CODEPACK__;';

  function reg(meta, body) {
    var src = '/**\n' + JSON.stringify(meta, null, 2) + '\n**/\n' +
              'async function main(ctx){\n' + ENSURE + '\n' + body + '\n}';
    Cade.registerScript(src);
  }

  var I = {
    min:  "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='4 14 10 14 10 20'/><polyline points='20 10 14 10 14 4'/><line x1='14' y1='10' x2='21' y2='3'/><line x1='3' y1='21' x2='10' y2='14'/></svg>",
    js:   "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2'/><path d='M8 10v5a1.5 1.5 0 0 1-3 0'/><path d='M13 15a1.5 1.5 0 0 0 3 0c0-2-3-1.5-3-3.5a1.5 1.5 0 0 1 3 0'/></svg>",
    css:  "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 3h16l-1.5 16L12 21l-6.5-2L4 3z'/><path d='M8 8h8l-.5 5L12 14l-3.5-1'/></svg>",
    html: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='9 8 5 12 9 16'/><polyline points='15 8 19 12 15 16'/></svg>",
    py:   "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 3c-3 0-5 1-5 3v3h5'/><path d='M7 9H5c-2 0-3 1.5-3 3.5S3 16 5 16h2'/><path d='M12 21c3 0 5-1 5-3v-3h-5'/><path d='M17 15h2c2 0 3-1.5 3-3.5S21 8 19 8h-2'/></svg>",
    obf:  "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='11' width='18' height='10' rx='2'/><path d='M7 11V7a5 5 0 0 1 10 0v4'/><line x1='12' y1='15' x2='12' y2='17'/></svg>",
    unobf: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='11' width='18' height='10' rx='2'/><path d='M7 11V7a5 5 0 0 1 9.9-1'/><line x1='12' y1='15' x2='12' y2='17'/></svg>",
    beauty: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M5 3v4'/><path d='M3 5h4'/><path d='M6 17v4'/><path d='M4 19h4'/><path d='M13 3l3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7z'/></svg>"
  };

  var TAGS = 'minify,minifier,compress,uglify,terser,obfuscate,obfuscator,beautify,prettify,format,code';

  reg({
    name: 'Minify Code',
    description: 'Auto-detect language and minify (JS, CSS, HTML, Python, JSON, XML)',
    icon: I.min,
    tags: 'minify,minifier,compress,code,auto,detect,uglify,terser,js,javascript,css,html,python,py,json,xml'
  }, 'await L.run(ctx, "minify", "auto");');

  reg({
    name: 'Minify JS',
    description: 'Minify JavaScript with terser (compress + mangle)',
    icon: I.js,
    tags: 'minify,javascript,js,terser,compress,uglify,mangle'
  }, 'await L.run(ctx, "minify", "js");');

  reg({
    name: 'Minify CSS',
    description: 'Minify CSS: strip comments/whitespace, shorten colours, drop 0 units',
    icon: I.css,
    tags: 'minify,css,compress,stylesheet,shorten'
  }, 'await L.run(ctx, "minify", "css");');

  reg({
    name: 'Minify HTML',
    description: 'Minify HTML: collapse whitespace, strip comments, minify inline JS/CSS',
    icon: I.html,
    tags: 'minify,html,compress,markup,whitespace'
  }, 'await L.run(ctx, "minify", "html");');

  reg({
    name: 'Minify Python',
    description: 'Minify Python: drop comments/docstrings/blank lines, 1-space indent',
    icon: I.py,
    tags: 'minify,python,py,compress,docstring,comments,indent'
  }, 'await L.run(ctx, "minify", "python");');

  reg({
    name: 'Obfuscate Code',
    description: 'Auto-detect language and obfuscate (JS, Python, HTML, CSS)',
    icon: I.obf,
    tags: 'obfuscate,obfuscator,auto,detect,code,protect,scramble,js,javascript,python,py,html,css'
  }, 'await L.run(ctx, "obfuscate", "auto");');

  reg({
    name: 'Obfuscate JS',
    description: 'Obfuscate JavaScript (string array + rotate + base64); prompts strength',
    icon: I.obf,
    tags: 'obfuscate,obfuscator,javascript,js,protect,scramble,stringarray,base64'
  }, 'var p=(window.prompt("Obfuscation strength (low, medium, high):","medium")||"").trim().toLowerCase();' +
     'if(p===""){p="medium";}' +
     'if(p!=="low"&&p!=="medium"&&p!=="high"){showToast("Unknown strength; using medium","info",2000);p="medium";}' +
     'await L.run(ctx, "obfuscate", "js", {preset:p});');

  reg({
    name: 'Obfuscate Python',
    description: 'Obfuscate Python into a zlib+base64 exec loader (reversible)',
    icon: I.obf,
    tags: 'obfuscate,python,py,zlib,base64,exec,loader,protect'
  }, 'await L.run(ctx, "obfuscate", "python");');

  reg({
    name: 'Obfuscate HTML',
    description: 'Obfuscate HTML into a base64 + document.write loader (reversible)',
    icon: I.obf,
    tags: 'obfuscate,html,base64,document.write,loader,protect,scramble'
  }, 'await L.run(ctx, "obfuscate", "html");');

  reg({
    name: 'Obfuscate CSS',
    description: 'Minify CSS and escape class/id names + strings as CSS hex escapes',
    icon: I.obf,
    tags: 'obfuscate,css,escape,hex,class,stylesheet,scramble'
  }, 'await L.run(ctx, "obfuscate", "css");');

  reg({
    name: 'Unobfuscate Code',
    description: 'Undo Obfuscate: decode JS string tables, unflatten & rename _0x names; unwrap Python / HTML loaders; unescape CSS',
    icon: I.unobf,
    tags: 'unobfuscate,deobfuscate,deobfuscator,unobfuscator,decode,reverse,unpack,readable,js,javascript,python,py,html,css,_0x,javascript-obfuscator'
  }, 'await L.run(ctx, "unobfuscate", "auto");');

  reg({
    name: 'Beautify Code',
    description: 'Pretty-print the selection, the ``` block at the cursor or the note with Prettier: JS, TS, JSX, CSS, SCSS, Less, HTML, Vue, Markdown, YAML, GraphQL; plus JSON and XML',
    icon: I.beauty,
    tags: 'beautify,prettify,prettier,format,pretty,indent,code,js,javascript,ts,typescript,jsx,tsx,css,scss,less,html,vue,markdown,md,yaml,yml,graphql,json,xml,auto'
  }, 'await L.run(ctx, "beautify", "auto");');

  reg({
    name: 'Format Code Blocks',
    description: 'Prettier-format every ``` code block in the note (or the selection) by its fence language; unlabelled and unsupported blocks are left alone',
    icon: I.beauty,
    tags: 'format,beautify,prettier,prettify,code,blocks,fences,fenced,markdown,all,js,ts,css,html,json,yaml,graphql'
  }, 'await L.formatBlocks();');

  reg({
    name: 'Beautify Options…',
    description: 'Set print width, indent (spaces or tabs), semicolons, quotes and trailing commas for Beautify Code and Format Code Blocks',
    icon: I.beauty,
    tags: 'beautify,prettier,format,options,settings,width,indent,tabs,spaces,semicolons,quotes,trailing,commas'
  }, 'await L.formatOptions();');
})();
