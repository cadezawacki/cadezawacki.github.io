/* Code Pack formatter - the engine behind "Beautify Code", "Format Code Blocks"
   and "Beautify Options…". Loaded lazily by pack-code-lib.js the first time
   one of them runs; sets window.__CADE_CODEFMT__.

   Who formats what (chosen by comparing both on a corpus, see the tests):
   - Prettier 3 (standalone build from cdn.jsdelivr.net, only the plugins the
     language needs, loaded on first use): JS / JSX, TypeScript / TSX (babel-ts,
     so the 900 KB typescript plugin is never needed), CSS / SCSS / Less, HTML,
     Vue, Markdown, YAML, GraphQL, JSON5.
   - js-beautify stays the fallback for JS / CSS / HTML: used when Prettier
     can't be loaded (offline before first use) and when Prettier rejects a
     snippet it can't parse (a lone method, half a rule...), since js-beautify
     is tolerant. TS / JSX get e4x mode so the fallback doesn't mangle markup.
   - Own formatters for JSON (lossless, from pack-code-lib.js: 100x faster
     than Prettier on big payloads and keeps the JSON.stringify layout people
     expect) and XML (Prettier has no XML). Python / SQL / ... : no formatter.

   Pure helpers are exposed with a leading _ for the node tests. Everything the
   page provides (script loader, js-beautify, JSON/XML printers, detection) is
   passed in as `env`, so the module itself has no load-time side effects. */
(function () {
  'use strict';
  if (window.__CADE_CODEFMT__) return;

  // pinned: 3.9.9 (2026-09-23). Each plugin is a separate UMD file that adds
  // itself to window.prettierPlugins.
  var PRETTIER = 'https://cdn.jsdelivr.net/npm/prettier@3.9.9/';
  var LOAD_TIMEOUT = 20000;

  // =====================================================================
  // Options (one prompt, stored in Cade.store)
  // =====================================================================
  var OPT_KEY = 'codepack.format';
  var DEFAULTS = { width: 80, indent: 2, tabs: false, semi: true, quotes: 'double', trailing: 'all' };

  function clean(o) {
    var r = {}, k;
    for (k in DEFAULTS) r[k] = DEFAULTS[k];
    if (!o || typeof o !== 'object') return r;
    if (o.width >= 20 && o.width <= 320) r.width = Math.round(o.width);
    if (o.indent >= 1 && o.indent <= 8) r.indent = Math.round(o.indent);
    if (typeof o.tabs === 'boolean') r.tabs = o.tabs;
    if (typeof o.semi === 'boolean') r.semi = o.semi;
    if (o.quotes === 'single' || o.quotes === 'double') r.quotes = o.quotes;
    if (o.trailing === 'all' || o.trailing === 'es5' || o.trailing === 'none') r.trailing = o.trailing;
    return r;
  }
  function getOptions() {
    var raw = null;
    try { raw = window.Cade.store.get(OPT_KEY); } catch (e) {}
    try { return clean(JSON.parse(raw || 'null')); } catch (e) { return clean(null); }
  }
  function setOptions(o) {
    o = clean(o);
    try { window.Cade.store.set(OPT_KEY, JSON.stringify(o)); } catch (e) {}
    return o;
  }
  function optionsString(o) {
    o = clean(o);
    return 'width=' + o.width + ' indent=' + (o.tabs ? 'tab' : o.indent) + ' semi=' + (o.semi ? 'yes' : 'no') +
      ' quotes=' + o.quotes + ' trailing=' + o.trailing;
  }
  // "width=100 indent=tab semi=no quotes=single" (also "w:100", "tabs", "nosemi",
  // "single", "4"...); unknown words are reported, blank / "default" resets.
  function parseOptions(str, base) {
    var o = clean(base), errors = [];
    var words = String(str == null ? '' : str).trim().toLowerCase().split(/[\s,;]+/).filter(Boolean);
    var YES = { yes: 1, y: 1, true: 1, on: 1, '1': 1 }, NO = { no: 1, n: 1, false: 1, off: 1, '0': 1 };
    if (!words.length || words[0] === 'default' || words[0] === 'defaults' || words[0] === 'reset') return { opts: clean(null), errors: [] };
    words.forEach(function (w) {
      var m = w.match(/^([a-z]+)\s*[=:]\s*(.+)$/), k = m ? m[1] : '', v = m ? m[2] : w;
      if (!m) {
        if (/^\d+$/.test(w)) { k = +w > 8 ? 'width' : 'indent'; }
        else if (w === 'tab' || w === 'tabs') { k = 'indent'; v = 'tab'; }
        else if (w === 'spaces') { o.tabs = false; return; }
        else if (w === 'semi' || w === 'semicolons') { o.semi = true; return; }
        else if (w === 'nosemi' || w === 'no-semi' || w === 'asi') { o.semi = false; return; }
        else if (w === 'single' || w === 'double') { o.quotes = w; return; }
        else if (w === 'es5' || w === 'none' || w === 'all') { o.trailing = w; return; }
        else { errors.push(w); return; }
      }
      if (k === 'width' || k === 'w' || k === 'printwidth' || k === 'columns' || k === 'cols') {
        var n = parseInt(v, 10);
        if (n >= 20 && n <= 320) o.width = n; else errors.push(w + ' (20-320)');
      } else if (k === 'indent' || k === 'tabwidth' || k === 'tab' || k === 'i') {
        if (v === 'tab' || v === 'tabs' || v === 't') o.tabs = true;
        else { var n2 = parseInt(v, 10); if (n2 >= 1 && n2 <= 8) { o.indent = n2; o.tabs = false; } else errors.push(w + ' (1-8 or tab)'); }
      } else if (k === 'tabs' || k === 'usetabs') {
        if (YES[v]) o.tabs = true; else if (NO[v]) o.tabs = false; else errors.push(w);
      } else if (k === 'semi' || k === 'semicolons' || k === 'semis') {
        if (YES[v]) o.semi = true; else if (NO[v]) o.semi = false; else errors.push(w + ' (yes/no)');
      } else if (k === 'quotes' || k === 'quote' || k === 'q') {
        if (v === 'single' || v === "'" || v === 's') o.quotes = 'single';
        else if (v === 'double' || v === '"' || v === 'd') o.quotes = 'double';
        else errors.push(w + ' (single/double)');
      } else if (k === 'trailing' || k === 'commas' || k === 'trailingcomma' || k === 'comma') {
        if (v === 'all' || v === 'es5' || v === 'none') o.trailing = v; else if (NO[v]) o.trailing = 'none'; else errors.push(w + ' (all/es5/none)');
      } else errors.push(w);
    });
    return { opts: o, errors: errors };
  }
  function indentUnit(o) { return o.tabs ? '\t' : new Array(o.indent + 1).join(' '); }

  // =====================================================================
  // Languages
  // =====================================================================
  // parsers: tried in order. plugins: Prettier plugin files. fallback: the
  // js-beautify mode. strict: never fall back (js-beautify turns TS generics
  // and casts into comparisons), report the Prettier error / offline instead.
  var LANGS = {
    js:       { label: 'JS', parsers: ['babel', 'babel-ts'], plugins: ['babel', 'estree'], fallback: 'js' },
    ts:       { label: 'TS', parsers: ['babel-ts'], plugins: ['babel', 'estree'], fallback: 'js', strict: true },
    css:      { label: 'CSS', parsers: ['css'], plugins: ['postcss'], fallback: 'css' },
    scss:     { label: 'SCSS', parsers: ['scss'], plugins: ['postcss'], fallback: 'css' },
    less:     { label: 'Less', parsers: ['less'], plugins: ['postcss'], fallback: 'css' },
    html:     { label: 'HTML', parsers: ['html'], plugins: ['html'], fallback: 'html' },
    vue:      { label: 'Vue', parsers: ['vue'], plugins: ['html', 'postcss', 'babel', 'estree'], fallback: 'html' },
    svelte:   { label: 'Svelte', fallback: 'html' },               // no Svelte plugin in Prettier core
    markdown: { label: 'Markdown', parsers: ['markdown'], plugins: ['markdown'] },
    yaml:     { label: 'YAML', parsers: ['yaml'], plugins: ['yaml'] },
    graphql:  { label: 'GraphQL', parsers: ['graphql'], plugins: ['graphql'] },
    json5:    { label: 'JSON5', parsers: ['json5'], plugins: ['babel', 'estree'] },
    json:     { label: 'JSON', native: 'json' },
    xml:      { label: 'XML', native: 'xml' }
  };
  var INFO = {
    js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js', es6: 'js', ecmascript: 'js',
    ts: 'ts', typescript: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
    css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'html', xhtml: 'html', vue: 'vue', svelte: 'svelte',
    json: 'json', jsonc: 'json', geojson: 'json', webmanifest: 'json', json5: 'json5',
    md: 'markdown', markdown: 'markdown', yaml: 'yaml', yml: 'yaml', graphql: 'graphql', gql: 'graphql',
    xml: 'xml', svg: 'xml', rss: 'xml', atom: 'xml', xsl: 'xml', xslt: 'xml', plist: 'xml', xaml: 'xml', csproj: 'xml'
  };
  // fence languages we know but can't format: reported, never guessed at
  var NO_FMT = ('py python python3 py3 sql mysql pgsql postgres plsql sqlite rust rs go golang c h cpp c++ cc hpp ' +
    'cs csharp java kotlin kt swift ruby rb php sh bash zsh shell console fish ps1 powershell bat cmd ' +
    'lua perl pl r dart scala elixir ex haskell hs clojure lisp ocaml fsharp vb vba matlab julia zig nim ' +
    'toml ini cfg conf properties env dockerfile docker makefile make nginx apache diff patch ' +
    'text txt plain plaintext none output log csv tsv sass styl stylus pug jade hbs handlebars mdx q kdb')
    .split(' ').reduce(function (m, k) { m[k] = 1; return m; }, {});

  function infoKey(info) {
    if (!info) return '';
    return String(info).trim().toLowerCase().replace(/^[{.]+/, '').split(/[\s,{}:]+/)[0].replace(/^\./, '');
  }
  // fence info / typed answer -> format language, or null (unknown)
  function fromInfo(info) { var k = infoKey(info); return INFO[k] || (LANGS[k] ? k : null); }
  function unsupported(info) { var k = infoKey(info); return NO_FMT[k] ? k : null; }
  function labelOf(lang) { return (LANGS[lang] && LANGS[lang].label) || (lang === 'python' ? 'Python' : String(lang).toUpperCase()); }

  // =====================================================================
  // Detection (refines pack-code-lib.js detectLang for the extra languages)
  // =====================================================================
  function looksYaml(t) {
    var lines = t.split('\n'), keys = 0, plainKeys = 0, nested = false, block = -1, seen = 0;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i], s = ln.replace(/\s+$/, '');
      if (!s.trim() || /^\s*#/.test(s)) continue;
      var ind = s.match(/^\s*/)[0].length;
      if (block >= 0 && ind > block) continue;                     // inside a | or > block scalar
      block = -1; seen++;
      if (ind) nested = true;
      if (/^\s*(---|\.\.\.)(\s|$)/.test(s)) { nested = true; continue; }
      if (/[;{]$/.test(s) || /^\s*[})\]]/.test(s)) return null;
      var m = s.match(/^\s*(?:-\s+)?((?:"[^"]*"|'[^']*'|[^\s#:{}\[\],&*!|>'"%@`][^#:]*?))\s*:(?:\s+(.*))?$/);
      if (m) {
        keys++; if (/^[\w.\/$-]+$|^["']/.test(m[1])) plainKeys++;
        if (/^[|>][-+0-9]*\s*(#.*)?$/.test(m[2] || '')) block = ind;
        continue;
      }
      if (/^\s*-(\s|$)/.test(s)) { nested = true; continue; }
      return null;
    }
    if (!keys || !seen) return null;
    return { lang: 'yaml', sure: keys === plainKeys && seen >= 2 && nested };
  }
  function looksMarkdown(t) {
    var score = 0;
    if (/^#{1,6}\s+\S/m.test(t) && !/^#!/.test(t)) score += 2;
    if (/^[^\s].*\n(=+|-{3,})\s*$/m.test(t)) score += 1;
    if (/^\s{0,3}([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?\S/m.test(t)) score += 1;
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(t)) score += 2;
    if (/\[[^\]\n]+\]\([^)\s]+\)/.test(t)) score += 1;
    if (/(\*\*|__)\S[^\n]*?\S\1/.test(t)) score += 1;
    if (/^\s{0,3}(```|~~~)/m.test(t)) score += 2;
    if (/^\s{0,3}>\s/m.test(t)) score += 1;
    if (/[;{}]\s*$/m.test(t) && !/^\s{0,3}(```|~~~)/m.test(t)) score -= 2;
    // never "sure": a whole note is Markdown-ish, so always confirm first
    return score >= 2 ? { lang: 'markdown', sure: false } : null;
  }
  function looksGraphql(t) {
    if (/^(query|mutation|subscription|fragment)\b[^;=]*\{/.test(t) && !/=>|\bfunction\b|;\s*$/m.test(t)) return { lang: 'graphql', sure: true };
    var defs = t.match(/^(type|input|enum|interface|union|scalar|schema|extend|directive)\b/gm);
    if (defs && !/[;=]\s*$|=>|\bfunction\b|\bexport\b|\bimport\b/m.test(t) &&
        /^\s+\w+(\([^)]*\))?\s*:\s*\[?[A-Z]\w*!?\]?!?/m.test(t)) return { lang: 'graphql', sure: true };
    return null;
  }
  function cssDialect(t) {
    if (/\$[\w-]+\s*:|@(mixin|include|use|forward|extend|each|for|while|if|else|function|return)\b|#\{/.test(t)) return 'scss';
    if (/(^|[\s;{])@[\w-]+\s*:|\.[\w-]+\([^)]*\)\s*(;|when\b)|\bwhen\s*\(|~["']|@\{[\w-]+\}/.test(t)) return 'less';
    return 'css';
  }
  // env.detectLang: pack-code-lib.js detectLang; env.formatJSON: the JSON printer
  function detect(input, env) {
    var t = String(input || '').trim();
    if (!t) return { lang: 'js', sure: false };
    var noLead = t.replace(/^(\s*(\/\/[^\n]*|\/\*[\s\S]*?\*\/))+\s*/, '');
    if (/^[\[{]/.test(noLead) && env && env.formatJSON) { try { env.formatJSON(t, ''); return { lang: 'json', sure: true }; } catch (e) {} }
    if (/^<template[\s>]/i.test(t) && /<\/template>/i.test(t)) return { lang: 'vue', sure: /<script[\s>]/i.test(t) };
    var d = env && env.detectLang ? env.detectLang(t) : { lang: 'js', sure: false };
    // JSX reads as HTML to detectLang: code around the tags, or {expressions} as attribute values
    if (d.lang === 'html' && !/^<!doctype|^<html[\s>]/i.test(t) &&
        (/^\s*(import|export|const|let|var|function|class|return)\b/m.test(t) || /=>\s*\(?\s*</.test(t) || /\s[\w-]+=\{/.test(t))) {
      return { lang: 'js', sure: true };
    }
    if (d.sure && (d.lang === 'json' || d.lang === 'xml' || d.lang === 'html')) return d;
    var g = looksGraphql(t);
    if (g) return g;
    if (/^\s*(export\s+)?(declare\s+)?(interface|type|enum|namespace|abstract\s+class)\s+\w+(<[^>]*>)?\s*(=|\{|extends\b)/m.test(t)) return { lang: 'ts', sure: true };
    if (d.lang === 'css') return { lang: cssDialect(t), sure: d.sure };
    if (d.sure && d.lang === 'python') return d;
    var y = looksYaml(t);
    if (y && (y.sure || !d.sure)) return y;
    var md = looksMarkdown(t);
    if (md && (!d.sure || /^#{1,6}\s+\S/m.test(t))) return md;
    if (d.lang === 'html' || d.lang === 'xml' || d.lang === 'python') return d;
    if (/:\s*(string|number|boolean|unknown|any|void|never)\b|\bas\s+const\b|\b(private|public|protected|readonly)\s+\w+\s*[:;=(]/m.test(t)) return { lang: 'ts', sure: true };
    return { lang: 'js', sure: d.sure };
  }

  // =====================================================================
  // Prettier loading (only the plugins a language needs)
  // =====================================================================
  var pending = {};
  function loadOnce(url, loader) {
    if (!pending[url]) {
      pending[url] = new Promise(function (res, rej) {
        var timer = setTimeout(function () { rej(new Error('timed out loading ' + url.split('/').pop())); }, LOAD_TIMEOUT);
        Promise.resolve().then(function () { return loader(url); }).then(function () { clearTimeout(timer); res(); },
          function (e) { clearTimeout(timer); rej(e); });
      }).catch(function (e) { delete pending[url]; throw e; });   // a failed load is retried next time
    }
    return pending[url];
  }
  function pluginsFor(lang, src) {
    var L = LANGS[lang], names = (L.plugins || []).slice();
    if (lang === 'html') {          // embedded code is formatted when its plugin is present, else kept as-is
      if (/<script\b|\son[a-z]+\s*=/i.test(src)) names.push('babel', 'estree');
      if (/<style\b|\sstyle\s*=/i.test(src)) names.push('postcss');
    }
    return names;
  }
  function havePrettier() { return !!(window.prettier && window.prettier.format); }
  function havePlugins(names) {
    var P = window.prettierPlugins || {};
    return names.every(function (n) { return !!P[n]; });
  }
  function loadPrettier(names, env) {
    var loader = env && env.loadScript;
    if (havePrettier() && havePlugins(names)) return Promise.resolve(prettierWith(names));
    if (!loader) return Promise.reject(new Error('no script loader'));
    var jobs = [];
    if (!havePrettier()) jobs.push(loadOnce(PRETTIER + 'standalone.js', loader));
    names.forEach(function (n) { if (!(window.prettierPlugins || {})[n]) jobs.push(loadOnce(PRETTIER + 'plugins/' + n + '.js', loader)); });
    return Promise.all(jobs).then(function () {
      if (!havePrettier() || !havePlugins(names)) throw new Error('Prettier failed to initialise');
      return prettierWith(names);
    });
  }
  function prettierWith(names) {
    var P = window.prettierPlugins, seen = {}, list = [];
    names.forEach(function (n) { if (!seen[n]) { seen[n] = 1; list.push(P[n]); } });
    return { prettier: window.prettier, plugins: list };
  }
  function prettierOptions(parser, plugins, o, lang) {
    return {
      parser: parser, plugins: plugins,
      printWidth: o.width, tabWidth: o.indent, useTabs: o.tabs,
      semi: o.semi, singleQuote: o.quotes === 'single', trailingComma: o.trailing,
      proseWrap: 'preserve',
      // Markdown: leave fenced code alone (Format Code Blocks does those), so
      // the result doesn't depend on which plugins happen to be loaded
      embeddedLanguageFormatting: lang === 'markdown' ? 'off' : 'auto'
    };
  }
  // "Unexpected token (2:10)\n> 1 | ..." -> "line 2, col 10: Unexpected token"
  function errText(e) {
    var msg = String((e && e.message) || e).split('\n')[0].trim().replace(/\.(\s*\(\d+:\d+\))?$/, '$1');
    var m = msg.match(/^(.*?)\s*\((\d+):(\d+)\)\s*$/);
    if (m) return 'line ' + m[2] + ', col ' + m[3] + ': ' + m[1].replace(/^(CssSyntaxError|SyntaxError):\s*/, '');
    if (e && e.loc && e.loc.start) return 'line ' + e.loc.start.line + ', col ' + e.loc.start.column + ': ' + msg;
    return msg;
  }

  // CSS functions are case-insensitive, but Prettier treats URL(...) (not
  // lower case) as a plain function and spaces out data:image/svg+xml...
  function lowerUrlCalls(css) {
    if (!/url\(/i.test(css) || !/(?!url\()[uU][rR][lL]\(/.test(css)) return css;
    return css.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b[uU][rR][lL]\(/g, function (m, str) { return str || 'url('; });
  }

  // =====================================================================
  // Indent handling: a block indented as a whole (a fence inside a list
  // item, an indented selection) is formatted flush-left and re-indented.
  // =====================================================================
  function commonIndent(s) {
    var lines = s.split('\n'), pre = null;
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      var ws = lines[i].match(/^[ \t]*/)[0];
      if (pre === null) pre = ws;
      else { var k = 0; while (k < pre.length && k < ws.length && pre[k] === ws[k]) k++; pre = pre.slice(0, k); }
      if (!pre) return '';
    }
    return pre || '';
  }
  function dedent(s, pre) { return s.split('\n').map(function (l) { return l.indexOf(pre) === 0 ? l.slice(pre.length) : l.replace(/^[ \t]+/, ''); }).join('\n'); }
  function reindent(s, pre) { return s.split('\n').map(function (l) { return l ? pre + l : l; }).join('\n'); }

  // =====================================================================
  // format(lang, input, opts, env) -> Promise<{ code, lang, label, engine, note }>
  // env: { loadScript, ensureBeautify, formatJSON, beautifyXML, onLoading }
  // =====================================================================
  function isJsxish(s) { return /(return|=>|[(=,?:&|])\s*<([A-Za-z][\w.]*|>)/.test(s); }
  function beautifyOpts(o, lang, src) {
    return {
      indent_size: o.tabs ? 1 : o.indent, indent_char: o.tabs ? '\t' : ' ', indent_with_tabs: o.tabs,
      space_in_empty_paren: true, preserve_newlines: true, max_preserve_newlines: 2, end_with_newline: false,
      e4x: (lang === 'ts' || lang === 'js') && isJsxish(src)
    };
  }
  async function fallback(mode, lang, src, o, env) {
    if (!env || !env.ensureBeautify) throw new Error('js-beautify unavailable');
    var B = await env.ensureBeautify();
    return B[mode](src, beautifyOpts(o, lang, src));
  }

  async function formatCore(lang, src, o, env) {
    var L = LANGS[lang];
    if (L.native === 'json') {
      if (!env || !env.formatJSON) throw new Error('JSON formatter unavailable');
      return { code: env.formatJSON(src, indentUnit(o)), engine: 'built-in' };
    }
    if (L.native === 'xml') {
      if (!env || !env.beautifyXML) throw new Error('XML formatter unavailable');
      return { code: env.beautifyXML(src, indentUnit(o)), engine: 'built-in' };
    }
    if (!L.parsers) return { code: await fallback(L.fallback, lang, src, o, env), engine: 'js-beautify' };

    var names = pluginsFor(lang, src), P;
    try {
      if (env && env.onLoading && !(havePrettier() && havePlugins(names))) env.onLoading();
      P = await loadPrettier(names, env);
    } catch (e) {
      if (L.fallback && !L.strict) {
        try { return { code: await fallback(L.fallback, lang, src, o, env), engine: 'js-beautify', note: 'Prettier unavailable (offline?), used js-beautify' }; }
        catch (e2) { /* both failed: report the Prettier problem */ }
      }
      throw new Error(L.label + ' formatting needs Prettier, which could not be loaded (offline?): ' +
        String((e && e.message) || e).replace(/https?:\/\/\S*\/([^\/\s]+)/g, '$1'));
    }
    var code = lang === 'css' || lang === 'scss' || lang === 'less' ? lowerUrlCalls(src) : src, first = null;
    for (var k = 0; k < L.parsers.length; k++) {
      try {
        var out = await P.prettier.format(code, prettierOptions(L.parsers[k], P.plugins, o, lang));
        return { code: out, engine: 'Prettier', parser: L.parsers[k], lang: L.parsers[k] === 'babel-ts' && lang === 'js' ? 'ts' : lang };
      } catch (e) { if (!first) first = e; }
    }
    if (L.fallback && !L.strict && env && env.ensureBeautify) {
      try { return { code: await fallback(L.fallback, lang, src, o, env), engine: 'js-beautify', note: 'Prettier: ' + errText(first) + ', so js-beautify was used' }; }
      catch (e3) { /* report Prettier's error */ }
    }
    throw new Error(L.label + ' syntax error, ' + errText(first));
  }

  async function format(lang, input, opts, env) {
    if (lang === 'python') throw new Error('No Python formatter (Prettier has none); try Minify Python');
    if (!LANGS[lang]) throw new Error('No formatter for ' + lang);
    var o = clean(opts || getOptions());
    var pre = commonIndent(input), src = pre ? dedent(input, pre) : input;
    var r = await formatCore(lang, src, o, env);
    var code = String(r.code).replace(/\s+$/, '').replace(/^\n+/, '');
    if (pre) code = reindent(code, pre);
    if (/\n$/.test(input)) code += '\n';
    var outLang = r.lang || lang;
    return { code: code, lang: outLang, label: labelOf(outLang), engine: r.engine, note: r.note || '' };
  }

  // =====================================================================
  // Fenced code blocks (same rules as the lib's cursor-fence lookup)
  // =====================================================================
  function findFences(text) {
    var lines = text.split('\n'), out = [], pos = 0, open = null;
    var re = /^(\s*)(`{3,}|~{3,})(.*)$/;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i], m = ln.match(re), start = pos;
      pos += ln.length + 1;
      if (!open) {
        if (m && !(m[2][0] === '`' && m[3].indexOf('`') >= 0)) open = { line: i + 1, from: start, info: m[3].trim(), ch: m[2][0], len: m[2].length, contentFrom: pos };
      } else if (m && m[2][0] === open.ch && m[2].length >= open.len && !m[3].trim()) {
        open.contentTo = Math.max(open.contentFrom, start - 1);
        open.to = start + ln.length;
        out.push(open); open = null;
      }
    }
    return out;  // unclosed fences are ignored: formatting to EOF would swallow the note
  }

  // Formats every labelled fence overlapping [from, to) (whole text when
  // omitted). -> { changes: [{from, to, insert}], formatted, unchanged, skipped: [..], failed: [..] }
  async function formatBlocks(text, from, to, opts, env) {
    var blocks = findFences(text), res = { changes: [], formatted: 0, unchanged: 0, skipped: [], failed: [], total: 0 };
    if (from != null && to != null && from !== to) blocks = blocks.filter(function (b) { return b.from < to && b.to > from; });
    res.total = blocks.length;
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i], lang = fromInfo(b.info), body = text.slice(b.contentFrom, b.contentTo);
      if (b.contentTo <= b.contentFrom || !body.trim()) { res.unchanged++; continue; }
      if (!lang) { res.skipped.push(infoKey(b.info) || 'no language'); continue; }
      try {
        var r = await format(lang, body, opts, env);
        if (r.code === body) res.unchanged++;
        else { res.changes.push({ from: b.contentFrom, to: b.contentTo, insert: r.code }); res.formatted++; }
      } catch (e) { res.failed.push({ line: b.line, lang: labelOf(lang), message: (e && e.message) || String(e) }); }
    }
    return res;
  }

  window.__CADE_CODEFMT__ = {
    format: format,
    formatBlocks: formatBlocks,
    detect: detect,
    fromInfo: fromInfo,
    unsupported: unsupported,
    labelOf: labelOf,
    getOptions: getOptions,
    setOptions: setOptions,
    parseOptions: parseOptions,
    optionsString: optionsString,
    langs: Object.keys(LANGS),
    PRETTIER: PRETTIER,
    _findFences: findFences,
    _commonIndent: commonIndent,
    _lowerUrlCalls: lowerUrlCalls,
    _pluginsFor: pluginsFor,
    _errText: errText,
    _prettierOptions: prettierOptions
  };
})();
