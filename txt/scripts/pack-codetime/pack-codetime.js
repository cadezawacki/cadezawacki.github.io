/* Code & Time Pack — strip comments from code (string / regex / template
   literal aware, 20+ languages) and convert or insert times across time
   zones (DST-correct via Intl.DateTimeFormat with timeZone — works on iOS).
   Script-pack module: one file registering 3 palette scripts.

   Same authoring pattern as pack-text / pack-dev: every script and helper is
   a real function serialised with Function#toString. The core evaluates each
   script source in isolation (it cannot see this IIFE), so reg() concatenates
   exactly the helpers a script needs into that script's own source — nothing
   below may reference an IIFE variable from inside a serialised function. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;

  function reg(meta, main, helpers) {
    var src = '/**\n' + JSON.stringify(meta, null, 2) + '\n**/\n' + String(main);
    for (var i = 0; helpers && i < helpers.length; i++) src += '\n\n' + String(helpers[i]);
    window.Cade.registerScript(src);
  }

  var SVG = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>";
  var ICON = {
    strip: SVG + "<path d='M9 5 5 19M15 5l-4 14'/><path d='M3 12h18'/><path d='M17 16l4 4M21 16l-4 4'/></svg>",
    zones: SVG + "<circle cx='12' cy='12' r='9'/><path d='M3 12h18'/><path d='M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18'/></svg>",
    insert: SVG + "<circle cx='11' cy='13' r='8'/><path d='M11 9v4l2.5 2'/><path d='M19 2v6M16 5h6'/></svg>"
  };

  function ctStoreGet(k) { try { return window.Cade.store.get(k); } catch (e) { return null; } }
  function ctStoreSet(k, v) { try { window.Cade.store.set(k, v); } catch (e) { /* prefs are best-effort */ } }

  function ctCopy(text, msg) {
    var done = function () { showToast(msg || 'Copied to clipboard', 'success', 2500); };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      if (ok) done(); else showToast('Copy failed', 'error', 2000);
    };
    var nav = window.navigator;
    if (nav && nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  /* ================================================================
     1. Strip Code Comments
     ================================================================ */

  var scMain = function main(ctx) {
    var ed = window.Cade && window.Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { showToast('Document is read-only', 'error', 2500); return; }
    var R = scRange(ed);
    if (!R.text.trim()) { showToast('Nothing to strip', 'info', 2000); return; }
    var lang = R.info ? scLang(R.info) : null;
    if (!lang) {
      var d = scDetect(R.text);
      lang = d.lang;
      if (!d.sure) {
        var ans = window.prompt('Strip comments as which language? (looks like ' + lang + ')\n' +
          'js  ts  java  c  cpp  cs  go  rust  swift  kotlin  dart  php\n' +
          'python  ruby  shell  yaml  toml  css  scss  html  xml  sql  lua  haskell', lang);
        if (ans === null) return;
        lang = scLang(ans);
        if (!lang) { showToast('Unknown language: ' + ans, 'error', 2500); return; }
      }
    }
    var res = scStrip(R.text, lang, {});
    if (lang === 'python' && res.docs &&
        window.confirm('Also remove ' + res.docs + ' docstring' + (res.docs === 1 ? '' : 's') + '? (an emptied block gets "pass")')) {
      res = scStrip(R.text, lang, { docstrings: true });
    }
    var kept = res.kept ? ' \u00B7 kept ' + res.kept + ' directive' + (res.kept === 1 ? '' : 's') + ' / licence' : '';
    if (!res.count) { showToast('No comments found (' + lang + ')' + kept, 'info', 3000); return; }
    var live = window.Cade.editor, len = live.state.doc.length;
    live.dispatch({ changes: { from: Math.min(R.from, len), to: Math.min(R.to, len), insert: res.text }, userEvent: 'input' });
    showToast('Removed ' + res.count + ' comment' + (res.count === 1 ? '' : 's') + ' (' + lang + ')' + kept, 'success', 3000);
  };

  // Selection → the fenced block (``` / ~~~) around the cursor → whole doc.
  function scRange(ed) {
    var state = ed.state, sel = state.selection.main, doc = state.doc;
    if (sel.from !== sel.to) return { from: sel.from, to: sel.to, text: state.sliceDoc(sel.from, sel.to), info: null };
    var cur = doc.lineAt(sel.head).number, nLines = doc.lines, fenceRe = /^\s*(`{3,}|~{3,})(.*)$/;
    var open = -1, mark = '', info = null;
    for (var ln = 1; ln <= nLines; ln++) {
      var mm = fenceRe.exec(doc.line(ln).text);
      if (open < 0) {
        if (mm) { open = ln; mark = mm[1]; info = mm[2].trim(); }
      } else if (mm && mm[1].charAt(0) === mark.charAt(0) && mm[1].length >= mark.length && !mm[2].trim()) {
        if (cur >= open && cur <= ln) return scFenceBody(state, open, ln, info);
        open = -1;
      }
      if (open >= 0 && ln > cur && open > cur) break;
    }
    if (open >= 0 && cur >= open) return scFenceBody(state, open, nLines + 1, info);
    return { from: 0, to: doc.length, text: doc.toString(), info: null };
  }

  function scFenceBody(state, open, close, info) {
    var doc = state.doc, a = open + 1, b = Math.min(close - 1, doc.lines);
    if (a > b) { var p = doc.line(open).to; return { from: p, to: p, text: '', info: info }; }
    var from = doc.line(a).from, to = doc.line(b).to;
    return { from: from, to: to, text: state.sliceDoc(from, to), info: info };
  }

  // Fence info string / user answer → canonical language key (or null).
  function scLang(name) {
    var k = String(name || '').trim().toLowerCase().replace(/^[{.]+/, '').split(/[\s,{}=]+/)[0];
    var M = {
      js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js', javascriptreact: 'js', jsonc: 'js', json5: 'js',
      ts: 'ts', typescript: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', typescriptreact: 'ts',
      c: 'c', h: 'c', objc: 'c', 'objective-c': 'c', objectivec: 'c', m: 'c',
      cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'cpp', arduino: 'cpp', cuda: 'cpp', cu: 'cpp',
      cs: 'cs', csharp: 'cs', 'c#': 'cs', java: 'java', groovy: 'java', gradle: 'java', kotlin: 'kotlin', kt: 'kotlin', kts: 'kotlin',
      scala: 'scala', sc: 'scala', sbt: 'scala', swift: 'swift', go: 'go', golang: 'go', rust: 'rust', rs: 'rust', dart: 'dart',
      php: 'php', python: 'python', py: 'python', py3: 'python', python3: 'python', pyw: 'python', bzl: 'python', starlark: 'python',
      ruby: 'ruby', rb: 'ruby', rake: 'ruby', gemfile: 'ruby', podfile: 'ruby',
      sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', ksh: 'shell', fish: 'shell', shellscript: 'shell', console: 'shell',
      dockerfile: 'hash', docker: 'hash', make: 'hash', makefile: 'hash', mk: 'hash', cmake: 'hash', perl: 'hash', pl: 'hash', pm: 'hash',
      r: 'hash', elixir: 'hash', ex: 'hash', exs: 'hash', nim: 'hash', coffee: 'hash', coffeescript: 'hash', powershell: 'hash', ps1: 'hash',
      conf: 'hash', env: 'hash', dotenv: 'hash', gitignore: 'hash', ignore: 'hash', properties: 'hash', hash: 'hash', tcl: 'hash',
      yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'toml', cfg: 'toml',
      css: 'css', scss: 'scss', sass: 'scss', less: 'scss', styl: 'scss', stylus: 'scss',
      html: 'html', htm: 'html', xhtml: 'html', vue: 'html', svelte: 'html', astro: 'html', erb: 'html', ejs: 'html', handlebars: 'html', hbs: 'html',
      xml: 'xml', svg: 'xml', xsl: 'xml', xslt: 'xml', plist: 'xml', rss: 'xml', atom: 'xml', xaml: 'xml', csproj: 'xml',
      sql: 'sql', mysql: 'sql', pgsql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql', plsql: 'sql', tsql: 'sql', psql: 'sql',
      lua: 'lua', luau: 'lua', haskell: 'haskell', hs: 'haskell', elm: 'haskell', purescript: 'haskell'
    };
    return M[k] || null;
  }

  // Scanner settings per language family.
  function scSpec(lang) {
    var C = { line: ['//'], block: [['/*', '*/']], dq: true, sq: true };
    switch (lang) {
      case 'js': case 'ts': C.bt = 'tpl'; C.regex = 'js'; return C;
      case 'go': C.bt = 'raw'; C.go = true; return C;
      case 'rust': C.nest = true; C.rust = true; return C;
      case 'swift': C.nest = true; C.triple = ['"""']; return C;
      case 'kotlin': case 'scala': C.nest = true; C.triple = ['"""']; return C;
      case 'java': C.triple = ['"""']; return C;
      case 'dart': C.nest = true; C.triple = ['"""', "'''"]; return C;
      case 'cs': C.cs = true; C.triple = ['"""']; return C;
      case 'cpp': C.cpp = true; C.digitSep = true; return C;
      case 'c': C.digitSep = true; return C;
      case 'php': C.line = ['//', '#']; C.php = true; C.heredoc = 'php'; return C;
      case 'python': return { line: ['#'], dq: true, sq: true, triple: ['"""', "'''"], py: true };
      case 'ruby': return { line: ['#'], dq: true, sq: true, bt: 'raw', btEsc: true, ruby: true, regex: 'ruby', heredoc: 'ruby', mlStr: true };
      case 'shell': return { line: ['#'], dq: true, sq: true, sqRaw: true, bt: 'raw', btEsc: true, mlStr: true, wordHash: true, heredoc: 'shell' };
      case 'hash': return { line: ['#'], dq: true, sq: true };
      case 'yaml': return { line: ['#'], dq: true, sq: true, sqDouble: true, wordHash: true, yaml: true, mlStr: true };
      case 'toml': return { line: ['#', ';'], dq: true, sq: true, sqRaw: true, triple: ['"""', "'''"], toml: true, lineHashStart: true };
      case 'css': return { block: [['/*', '*/']], dq: true, sq: true, css: true };
      case 'scss': return { line: ['//'], block: [['/*', '*/']], dq: true, sq: true, css: true };
      case 'html': case 'xml': return { html: true };
      case 'sql': return { line: ['--'], block: [['/*', '*/']], dq: true, sq: true, bt: 'raw', noEsc: true, dbl: true, mlStr: true, sql: true };
      case 'lua': return { line: ['--'], dq: true, sq: true, lua: true };
      case 'haskell': return { line: ['--'], block: [['{-', '-}']], nest: true, dq: true, hs: true };
    }
    return C;
  }

  function scStrip(src, lang, opts) {
    var L = scSpec(lang), r = L.html ? scHtml(src, opts || {}) : scScan(src, L, opts || {});
    var out = scApply(src, r.cuts);
    return { text: out, count: r.cuts.length, kept: r.st.kept, docs: r.st.docs };
  }

  // Tokenise just enough to know what is code, string, regex or comment.
  // Returns { cuts: [{s, e, insert?}], st: { kept, docs } }.
  function scScan(src, L, opts) {
    var n = src.length, i = 0, cuts = [], st = { kept: 0, docs: 0 };
    var tpl = [];                       // JS template-literal ${ } brace depths
    var prev = '', word = '';           // last significant char / identifier (regex heuristic)
    var depth = 0;                      // bracket depth (Python docstrings)
    var lineBeg = 0, atStart = true, lineLast = '';
    var here = [], m, t;
    var ID = /[\p{L}\p{N}_$]+/uy;
    function at(s, j) { return src.substr(j, s.length) === s; }
    function eol(j) { var k = src.indexOf('\n', j); return k < 0 ? n : k; }
    function idc(ch) { return /[\p{L}\p{N}_$]/u.test(ch || ''); }
    function str(j, q, esc, ml, dbl) {
      var k = j + q.length;
      while (k < n) {
        var ch = src.charAt(k);
        if (esc && ch === '\\') { k += 2; continue; }
        if (src.substr(k, q.length) === q) {
          if (dbl && src.substr(k + q.length, q.length) === q) { k += 2 * q.length; continue; }
          return k + q.length;
        }
        if (ch === '\n' && !ml) return k;
        k++;
      }
      return n;
    }
    function blockEnd(j, o, c, nest) {
      var d = 1, k = j + o.length;
      while (k < n) {
        if (nest && at(o, k)) { d++; k += o.length; continue; }
        if (at(c, k)) { k += c.length; if (!--d) return k; continue; }
        k++;
      }
      return n;
    }
    function keepLine(txt, j) {
      if (L.go && /^\/\/(?:go:|line |export |extern |nolint)|^\/\/ \+build/.test(txt)) return true;
      if (/^\/\/\/\s*<(?:reference|amd-)/.test(txt) || /^\/\/[#@]\s*source(?:Mapping)?URL=/.test(txt)) return true;
      if (L.py && /^#.*coding[:=]/.test(txt) && src.slice(0, j).split('\n').length <= 2) return true;
      if (L.ruby && /^#\s*(?:frozen_string_literal|encoding|coding|warn_indent|shareable_constant_value):/.test(txt) &&
          /^(?:[ \t]*(?:#.*)?\n)*[ \t]*$/.test(src.slice(0, j))) return true;
      return false;
    }
    if (at('#!', 0) || at('<?php', 0)) i = eol(0);           // shebang / php open tag line
    while (i < n) {
      var c = src.charAt(i);
      if (c === '\n') {
        i++;
        if (here.length) { i = scHeredocSkip(src, i, here); here = []; }
        if (L.yaml) {
          // Block scalar (key: | / - >-): more-indented lines below are text.
          var bm = /^([ \t]*)(?:-[ \t]+)?(?:[^#'"\n]*?:[ \t]+)?[|>][1-9+\-]{0,2}[ \t]*(?:#.*)?$/.exec(src.slice(lineBeg, i - 1));
          if (bm) {
            var bi = bm[1].length;
            while (i < n) {
              var e2 = eol(i), l2 = src.slice(i, e2);
              if (l2.trim() && /^[ \t]*/.exec(l2)[0].length <= bi) break;
              i = e2 + 1;
            }
            i = Math.min(i, n);
          }
        }
        lineBeg = i; atStart = true; lineLast = '';
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      var first = atStart; atStart = false;

      // Ruby =begin … =end blocks and the __END__ data section
      if (L.ruby && i === lineBeg) {
        if (at('=begin', i) && /^\s?$/.test(src.charAt(i + 6))) {
          var be = src.indexOf('\n=end', i), bEnd = be < 0 ? n : eol(be + 1);
          cuts.push({ s: i, e: bEnd }); i = bEnd; continue;
        }
        if (src.slice(i, eol(i)) === '__END__') break;
      }

      // Block comments
      var hit = false;
      for (t = 0; L.block && t < L.block.length; t++) {
        var o = L.block[t][0], cl = L.block[t][1];
        if (!at(o, i)) continue;
        var end = blockEnd(i, o, cl, L.nest), body = src.slice(i, end);
        if (/^\/\*!|^\{-#|@license|@preserve|@cc_on|^\/\*#\s*source(?:Mapping)?URL=/.test(body)) st.kept++;
        else cuts.push({ s: i, e: end });
        i = end; hit = true; break;
      }
      if (hit) continue;
      if (L.lua && (m = /^--\[(=*)\[/.exec(src.substr(i, 40)))) {
        var lc = ']' + m[1] + ']', le = src.indexOf(lc, i + m[0].length);
        le = le < 0 ? n : le + lc.length;
        cuts.push({ s: i, e: le }); i = le; continue;
      }

      // Line comments
      for (t = 0; L.line && t < L.line.length; t++) {
        var tok = L.line[t];
        if (!at(tok, i)) continue;
        if (tok === '#' && L.wordHash && !first && !/[ \t;&|()]/.test(src.charAt(i - 1))) continue;
        if (tok === '#' && L.php && src.charAt(i + 1) === '[') continue;
        if (L.lineHashStart && !first) {
          // TOML / INI: '#' after a value is a comment, ';' only at line start
          if (tok === ';') continue;
        }
        if (tok === '--' && L.hs && /[!#$%&*+.\/<=>?@\\^|~:]/.test(src.charAt(i + 2 + /^-*/.exec(src.slice(i + 2, i + 80))[0].length))) continue;
        if (tok === '//' && L.css && src.charAt(i - 1) === ':') continue;
        hit = true; break;
      }
      if (hit) {
        var ce = eol(i);
        if (keepLine(src.slice(i, ce), i)) st.kept++; else cuts.push({ s: i, e: ce });
        i = ce; continue;
      }

      // Heredocs: remember the terminator, skip the body at the next newline
      if (L.heredoc && c === '<' && at('<<', i)) {
        if (L.heredoc === 'shell' && src.charAt(i + 2) !== '<') m = /^<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2/.exec(src.substr(i, 80));
        else if (L.heredoc === 'ruby' && !/[\w)\]]/.test(src.charAt(i - 1))) m = /^<<([~-]?)(['"`]?)([A-Z_][A-Z0-9_]*|[A-Za-z_]\w*(?=['"`]))\2/.exec(src.substr(i, 80));
        else if (L.heredoc === 'php') m = /^<<<[ \t]*()(['"]?)([A-Za-z_]\w*)\2/.exec(src.substr(i, 80));
        else m = null;
        if (m) {
          here.push({ tag: m[3], indent: !!m[1] || L.heredoc === 'php' });
          i += m[0].length; prev = '"'; word = ''; continue;
        }
      }

      // Strings (and other literals that may contain comment-like text)
      var pre = 0, q0 = c, sEnd = -1;
      if (L.py && (m = /^[rRuUbBfF]{1,2}(?=['"])/.exec(src.substr(i, 3))) && !idc(src.charAt(i - 1))) { pre = m[0].length; q0 = src.charAt(i + pre); }
      if (L.triple && (q0 === '"' || q0 === "'")) {
        for (t = 0; t < L.triple.length; t++) {
          if (at(L.triple[t], i + pre)) { sEnd = str(i + pre, L.triple[t], !(L.toml && L.triple[t] === "'''"), true, false); break; }
        }
      }
      if (sEnd < 0 && L.cs && (m = /^(?:\$@|@\$|@)"/.exec(src.substr(i, 3)))) sEnd = str(i + m[0].length - 1, '"', false, true, true);
      if (sEnd < 0 && L.cpp && (m = /^(?:u8|[uUL])?R"([^()\\\s]{0,16})\(/.exec(src.substr(i, 24))) && !idc(src.charAt(i - 1))) {
        var rc = ')' + m[1] + '"', re1 = src.indexOf(rc, i + m[0].length);
        sEnd = re1 < 0 ? n : re1 + rc.length;
      }
      if (sEnd < 0 && L.rust && (m = /^b?r(#*)"/.exec(src.substr(i, 12))) && !idc(src.charAt(i - 1))) {
        var rq = '"' + m[1], re2 = src.indexOf(rq, i + m[0].length);
        sEnd = re2 < 0 ? n : re2 + rq.length;
      }
      if (sEnd < 0 && L.sql && c === '$' && (m = /^\$(?:[A-Za-z_]\w*)?\$/.exec(src.substr(i, 40))) && !idc(src.charAt(i - 1))) {
        var dq2 = src.indexOf(m[0], i + m[0].length);
        sEnd = dq2 < 0 ? n : dq2 + m[0].length;
      }
      if (sEnd < 0 && L.lua && c === '[' && (m = /^\[(=*)\[/.exec(src.substr(i, 40)))) {
        var lq = ']' + m[1] + ']', le2 = src.indexOf(lq, i + m[0].length);
        sEnd = le2 < 0 ? n : le2 + lq.length;
      }
      if (sEnd < 0 && q0 === '"' && L.dq) sEnd = str(i + pre, '"', !L.noEsc, !!L.mlStr, !!L.dbl);
      if (sEnd < 0 && q0 === "'" && L.sq) {
        if (L.rust || L.hs) {
          // char literal 'a' / '\n' vs Rust lifetime 'a / Haskell prime x'
          if (/^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|[^\n])[^'\n]{0,8}|[^\\'\n])'/.test(src.substr(i, 16)) && !idc(src.charAt(i - 1))) sEnd = str(i, "'", true, false, false);
          else { i++; prev = 'a'; continue; }
        } else if (L.digitSep && /[0-9A-Fa-f]/.test(src.charAt(i - 1)) && /[0-9A-Fa-f]/.test(src.charAt(i + 1)) && /\d/.test(src.charAt(i - 1) + src.charAt(i - 2))) {
          i++; continue;                                             // 1'000'000 digit separator
        } else if (L.yaml && lineLast && ':-[{,?'.indexOf(lineLast) < 0) {
          i++; lineLast = "'"; continue;                             // apostrophe inside a plain scalar
        } else {
          sEnd = str(i + pre, "'", !L.noEsc && !L.sqRaw, !!L.mlStr, !!(L.dbl || L.sqDouble));
        }
      }
      if (sEnd < 0 && L.yaml && q0 === '"' && lineLast && ':-[{,?'.indexOf(lineLast) < 0) sEnd = -2;
      if (sEnd < 0 && c === '`' && L.bt === 'raw') sEnd = str(i, '`', !!L.btEsc, true, false);
      if (sEnd < 0 && c === '`' && L.bt === 'tpl') {
        var tr = scTpl(src, i + 1);
        if (tr.interp) tpl.push(0);
        i = tr.end; prev = '"'; word = ''; lineLast = '"'; continue;
      }
      if (sEnd > i) {
        if (L.py && first && depth === 0 && prev !== '\\' && !/[fFbB]/.test(src.substr(i, pre)) &&
            /^[ \t]*(?:#[^\n]*)?(?:\n|$)/.test(src.slice(sEnd))) {
          // A bare string statement: a docstring (or a string used as a comment).
          st.docs++;
          if (opts.docstrings) {
            var need = false;
            if (prev === ':') {
              var dInd = i - lineBeg, k2 = eol(sEnd) + 1;
              need = true;
              while (k2 < n) {
                var e3 = eol(k2), l3 = src.slice(k2, e3);
                if (l3.trim() && !/^\s*#/.test(l3)) { need = /^[ \t]*/.exec(l3)[0].length < dInd; break; }
                k2 = e3 + 1;
              }
            }
            cuts.push({ s: i, e: sEnd, insert: need ? 'pass' : '' });
          }
        }
        i = sEnd; prev = '"'; word = ''; lineLast = '"'; continue;
      }

      // CSS url(…) without quotes may contain //
      if (L.css && (c === 'u' || c === 'U') && /^url\(\s*[^\s'")]/i.test(src.substr(i, 6)) && !idc(src.charAt(i - 1))) {
        var ue = src.indexOf(')', i);
        i = ue < 0 ? n : ue + 1; prev = ')'; continue;
      }

      // Ruby %w[] %q() %r{} … literals
      if (L.ruby && c === '%' && (m = /^%[qQwWiIrsx]?([(\[{<|!\/^])/.exec(src.substr(i, 3))) && scRegexOk(prev, word, 'ruby')) {
        var od = m[1], cd = { '(': ')', '[': ']', '{': '}', '<': '>' }[od] || od, dd = 1, k3 = i + m[0].length;
        while (k3 < n && dd) {
          var ch3 = src.charAt(k3);
          if (ch3 === '\\') { k3 += 2; continue; }
          if (ch3 === cd) dd--; else if (ch3 === od && cd !== od) dd++;
          k3++;
        }
        i = k3; prev = '"'; word = ''; continue;
      }

      // Regex literals
      if (c === '/' && L.regex && !at('//', i) && !at('/*', i) && scRegexOk(prev, word, L.regex)) {
        var rx = scRegexEnd(src, i);
        if (rx > 0) { i = rx; prev = 'a'; word = ''; lineLast = 'a'; continue; }
      }

      // Template literal ${ … } nesting
      if (tpl.length && c === '{') tpl[tpl.length - 1]++;
      else if (tpl.length && c === '}') {
        if (tpl[tpl.length - 1] === 0) {
          tpl.pop();
          var tr2 = scTpl(src, i + 1);
          if (tr2.interp) tpl.push(0);
          i = tr2.end; prev = '"'; word = ''; continue;
        }
        tpl[tpl.length - 1]--;
      }

      // Identifiers / numbers
      ID.lastIndex = i;
      if ((m = ID.exec(src))) { word = m[0]; prev = 'a'; lineLast = 'a'; i += m[0].length; continue; }

      if (L.py) { if ('([{'.indexOf(c) >= 0) depth++; else if (')]}'.indexOf(c) >= 0 && depth) depth--; }
      prev = c; word = ''; lineLast = c; i++;
    }
    return { cuts: cuts, st: st };
  }

  // Template literal body from j (just after ` or the } closing a ${…}):
  // { end, interp } — interp means we stopped just after a "${".
  function scTpl(src, j) {
    var n = src.length;
    while (j < n) {
      var ch = src.charAt(j);
      if (ch === '\\') { j += 2; continue; }
      if (ch === '`') return { end: j + 1, interp: false };
      if (ch === '$' && src.charAt(j + 1) === '{') return { end: j + 2, interp: true };
      j++;
    }
    return { end: n, interp: false };
  }

  // Can a "/" here start a regex? (After an operator, an opening bracket, a
  // comma, the start, or a keyword like return / typeof — not after a value.)
  function scRegexOk(prev, word, kind) {
    if (!prev) return true;
    if (prev === 'a') {
      var KW = kind === 'ruby' ? ' if elsif unless while until and or not when then return puts print p case in do yield ' :
        ' return typeof instanceof in of new delete void throw case do else yield await ';
      return KW.indexOf(' ' + word + ' ') >= 0;
    }
    return '(,=:[!&|?{};+-*%<>~^'.indexOf(prev) >= 0;
  }

  // End index of a regex literal starting at i, or -1 when it isn't one.
  function scRegexEnd(src, i) {
    var j = i + 1, n = src.length, cls = false;
    while (j < n) {
      var ch = src.charAt(j);
      if (ch === '\\') { j += 2; continue; }
      if (ch === '\n') return -1;
      if (cls) { if (ch === ']') cls = false; }
      else if (ch === '[') cls = true;
      else if (ch === '/') { j++; while (j < n && /[a-z]/i.test(src.charAt(j))) j++; return j; }
      j++;
    }
    return -1;
  }

  // Skip heredoc bodies that start at i; returns the index after the last terminator line.
  function scHeredocSkip(src, i, list) {
    var n = src.length;
    for (var h = 0; h < list.length; h++) {
      while (i < n) {
        var e = src.indexOf('\n', i); if (e < 0) e = n;
        var line = src.slice(i, e).replace(/\r$/, '');
        i = e + 1;
        if ((list[h].indent ? line.trim().replace(/;$/, '') : line) === list[h].tag) break;
      }
    }
    return Math.min(i, n);
  }

  // HTML / XML: <!-- --> comments, plus JS inside <script> and CSS inside <style>.
  function scHtml(src, opts) {
    var cuts = [], st = { kept: 0, docs: 0 }, i = 0, n = src.length, low = src.toLowerCase(), m;
    while (i < n) {
      var lt = src.indexOf('<', i);
      if (lt < 0) break;
      i = lt;
      if (src.substr(i, 4) === '<!--') {
        var e = src.indexOf('-->', i + 4);
        e = e < 0 ? n : e + 3;
        if (/^<!--\[if|^<!--<!\[endif/i.test(src.substr(i, 16))) st.kept++;   // Outlook / IE conditional comments do work
        else cuts.push({ s: i, e: e });
        i = e; continue;
      }
      if (src.substr(i, 9) === '<![CDATA[') { var ce = src.indexOf(']]>', i); i = ce < 0 ? n : ce + 3; continue; }
      if (!/^<[a-zA-Z]/.test(src.substr(i, 2))) { i++; continue; }
      // A start tag: skip it whole (attribute values may contain "<!--").
      var k = i, quote = '';
      while (k < n) {
        var ch = src.charAt(k);
        if (quote) { if (ch === quote) quote = ''; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
        k++;
      }
      var tagEnd = Math.min(k + 1, n);
      if ((m = /^<(script|style)\b/i.exec(src.substr(i, 8)))) {
        var name = m[1].toLowerCase(), tag = src.slice(i, tagEnd);
        var close = low.indexOf('</' + name, tagEnd);
        if (close < 0) close = n;
        var lang = null;
        if (name === 'style') lang = 'css';
        else {
          var ty = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(tag);
          if (!ty || /^(?:text\/(?:java|ecma)script|application\/(?:java|ecma)script|module|text\/babel|text\/jsx)$/i.test(ty[1])) lang = 'js';
        }
        if (lang) {
          var r = scScan(src.slice(tagEnd, close), scSpec(lang), opts);
          for (var c = 0; c < r.cuts.length; c++) cuts.push({ s: r.cuts[c].s + tagEnd, e: r.cuts[c].e + tagEnd });
          st.kept += r.st.kept;
        }
        i = close + 2; continue;
      }
      i = tagEnd;
    }
    return { cuts: cuts, st: st };
  }

  // Remove the cut spans. Lines left holding only whitespace by a removal are
  // dropped (and a blank line next to one doesn't double up); trailing code
  // and trailing comments on code lines are handled so "x = 1;  // y" → "x = 1;"
  // and "a /* b */ + c" → "a + c".
  function scApply(src, cuts) {
    cuts.sort(function (a, b) { return a.s - b.s; });
    var lastEnd = 0, i;
    for (i = 0; i < cuts.length; i++) {
      var c = cuts[i], a = c.s, b = c.e;
      if (!c.insert) {
        var ls = src.lastIndexOf('\n', a - 1) + 1, le = src.indexOf('\n', b);
        if (le < 0) le = src.length;
        var tailBlank = !src.slice(b, le).trim(), headBlank = !src.slice(ls, a).trim();
        var pc = src.charAt(a - 1), nc = src.charAt(b);
        if (tailBlank && !headBlank) { while (a > Math.max(ls, lastEnd) && /[ \t]/.test(src.charAt(a - 1))) a--; }
        else if (!tailBlank && /[ \t]/.test(nc) && (headBlank || /[ \t([{>]/.test(pc))) { while (b < le && /[ \t]/.test(src.charAt(b))) b++; }
        else if (!tailBlank && /[ \t]/.test(pc) && /[)\]},;:.]/.test(nc)) { while (a > Math.max(ls, lastEnd) && /[ \t]/.test(src.charAt(a - 1))) a--; }
      }
      c.s = Math.max(a, lastEnd); c.e = Math.max(b, c.s); lastEnd = c.e;
    }
    var lines = [], cur = { t: '', lost: false }, pos = 0;
    function put(seg, lost, ins) {
      var parts = seg.split('\n');
      for (var p = 0; p < parts.length; p++) {
        if (p) { lines.push(cur); cur = { t: '', lost: false }; }
        if (lost) cur.lost = true; else cur.t += parts[p];
      }
      if (ins) cur.t += ins;
    }
    for (i = 0; i < cuts.length; i++) { put(src.slice(pos, cuts[i].s), false); put(src.slice(cuts[i].s, cuts[i].e), true, cuts[i].insert); pos = cuts[i].e; }
    put(src.slice(pos), false);
    lines.push(cur);
    var out = [], dropped = false;
    for (i = 0; i < lines.length; i++) {
      var L = lines[i], txt = L.lost ? L.t.replace(/[ \t]+$/, '') : L.t;
      if (L.lost && !txt.trim()) { dropped = true; continue; }
      if (!txt.trim()) {
        if (dropped && (!out.length || !out[out.length - 1].trim())) continue;
        out.push(txt); continue;
      }
      out.push(txt); dropped = false;
    }
    return out.join('\n');
  }

  // Best-guess language for code without a fence tag: { lang, sure }.
  function scDetect(text) {
    var t = text.slice(0, 20000), S = {}, m;
    function add(l, v) { S[l] = (S[l] || 0) + v; }
    function has(re) { return re.test(t); }
    if ((m = /^#!.*?\b(python[\d.]*|node|deno|bun|bash|sh|zsh|ksh|ruby|perl|lua|php)\b/.exec(t))) {
      var sb = { node: 'js', deno: 'ts', bun: 'js', bash: 'shell', sh: 'shell', zsh: 'shell', ksh: 'shell', ruby: 'ruby', perl: 'hash', lua: 'lua', php: 'php' };
      return { lang: sb[m[1]] || 'python', sure: true };
    }
    if (has(/^\s*<\?php/)) return { lang: 'php', sure: true };
    if (has(/^\s*<\?xml/)) return { lang: 'xml', sure: true };
    if (has(/^\s*<!doctype\s+html|^\s*<html[\s>]/i)) return { lang: 'html', sure: true };
    var tags = (t.match(/<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*)?\/?>/g) || []).length;
    if (/^\s*</.test(t) && tags >= 2) {
      var html = /<\/?(?:div|span|p|a|ul|li|table|body|head|script|style|section|img|br|h[1-6]|template|button|input|form|nav|main)\b/i.test(t);
      return { lang: html ? 'html' : 'xml', sure: tags >= 3 };
    }
    if (has(/^\s*(?:def|class)\s+\w+[^\n]*:\s*(?:#.*)?$/m)) add('python', 3);
    if (has(/^\s*(?:from\s+[\w.]+\s+import\s|import\s+[\w.]+(?:\s+as\s+\w+)?\s*$)/m)) add('python', 3);
    if (has(/^\s*(?:elif|except|finally|with)\b[^\n]*:\s*$/m)) add('python', 2);
    if (has(/\bself\.\w/)) add('python', 1);
    if (has(/^\s*(?:def|class|module)\s+[\w:.]+(?:\([^)]*\))?\s*$/m)) add('ruby', 2);
    if (has(/^\s*end\s*$/m)) { add('ruby', 2); add('lua', 1); }
    if (has(/\bputs\b|\brequire\s+['"]|\.each\s+do\b|\bdo\s*\|\w|\battr_accessor\b/)) add('ruby', 3);
    if (has(/^\s*(?:if\s+\[|fi\s*$|then\s*$|done\s*$|esac\s*$|for\s+\w+\s+in\b|while\s+\[)/m)) add('shell', 3);
    if (has(/^\s*(?:echo|export|cd|sudo|apt(?:-get)?|brew|npm|yarn|pip|git|curl|wget|mkdir|chmod|source|alias)\s/m)) add('shell', 2);
    var lines = t.split('\n').filter(function (l) { return l.trim() && !/^\s*#/.test(l); });
    var yamlish = lines.filter(function (l) { return /^\s*(?:-\s+)?[\w"'.\/-]+:(?:\s|$)/.test(l) || /^\s*-\s+\S/.test(l) || /^---\s*$/.test(l); }).length;
    if (lines.length && yamlish / lines.length >= 0.6 && !has(/[;{}]\s*$/m)) add('yaml', 4);
    if (has(/^\s*\[[\w.\- "]+\]\s*$/m) && has(/^\s*[\w.\-"]+\s*=\s*\S/m)) add('toml', 4);
    if (has(/[\w\-\]\)*#.:>~+ ]\s*\{[^{}]*:[^{}]*\}/) && !has(/\bfunction\b|=>|\breturn\b/)) add('css', 3);
    if (has(/^\s*[\w-]+\s*:\s*[^;{}\n]+;\s*$/m) && !has(/\b(?:var|let|const|return)\b/)) add('css', 2);
    if (has(/@(?:media|import|keyframes|font-face|supports)\b/)) add('css', 2);
    if (has(/^\s*\$[\w-]+\s*:|&[:.\-]|@(?:mixin|include|extend|use)\b/m) && S.css) add('scss', S.css + 1);
    if (has(/\b(?:SELECT\s[\s\S]+?\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|CREATE\s+(?:TABLE|VIEW|INDEX|FUNCTION)|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE)\b/i)) add('sql', 5);
    if (has(/\blocal\s+(?:function\s+)?\w+/)) add('lua', 3);
    if (has(/--\[\[/) || has(/\belseif\b/) || has(/~=/)) add('lua', 2);
    if (has(/^\s*module\s+[\w.]+\s*(?:\([^)]*\))?\s*where\b/m) || has(/^\w+\s*::\s*[\w\[(]/m)) add('haskell', 4);
    var cl = has(/[;{}]\s*$/m) ? 2 : 0;
    if (has(/\bfn\s+\w+\s*(?:<[^>]*>)?\s*\(|\blet\s+mut\b|\bimpl\b|\bpub\s+(?:fn|struct|enum)\b|println!/)) add('rust', 3 + cl);
    if (has(/^\s*package\s+\w+\s*$/m) || has(/\bfunc\s+(?:\(\w+\s+\*?\w+\)\s*)?\w+\s*\(/)) add('go', 3 + cl);
    if (has(/\b(?:const|let|var)\s+\w+\s*=|=>|\bfunction\b|\bconsole\.\w+|\brequire\(|\b(?:import|export)\s[^\n]*\bfrom\s+['"]/)) add('js', 2 + cl);
    if (has(/:\s*(?:string|number|boolean|any|void)\b|\binterface\s+\w+\s*\{|\btype\s+\w+\s*=/)) add('ts', (S.js || 0) + 2);
    if (has(/\bpublic\s+(?:static\s+)?(?:final\s+)?(?:class|void|int|String)\b|System\.out\.print|^\s*import\s+java\./m)) add('java', 3 + cl);
    if (has(/\busing\s+System\b|\bnamespace\s+[\w.]+|Console\.Write/)) add('cs', 3 + cl);
    if (has(/^\s*#\s*(?:include|define|ifn?def|pragma)\b/m)) add('c', 3 + cl);
    if (has(/std::|\bcout\b|\btemplate\s*</)) add('cpp', 4 + cl);
    if (has(/\bimport\s+(?:Foundation|UIKit|SwiftUI)\b|\bguard\s+let\b|\bif\s+let\b/)) add('swift', 4 + cl);
    if (has(/\bfun\s+\w+\s*\(|\bval\s+\w+\s*[:=]/)) add('kotlin', 3 + cl);
    if (has(/\$\w+\s*=/) && has(/->\w|\becho\s/)) add('php', 2 + cl);
    if (cl && !S.js && !S.rust && !S.go && !S.java && !S.cs && !S.c && !S.cpp && !S.swift && !S.kotlin && !S.php) add('js', 1);
    var best = 'js', bv = 0, second = 0;
    Object.keys(S).forEach(function (k) {
      if (S[k] > bv) { second = bv; bv = S[k]; best = k; }
      else if (S[k] > second) second = S[k];
    });
    return { lang: best, sure: bv >= 3 && bv >= second * 2 && bv - second >= 2 };
  }

  /* ================================================================
     Time zone helpers
     ================================================================ */

  function tzDevice() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
  }

  // Abbreviations: a number = fixed offset in minutes (EST is always UTC-5);
  // a string = the generic, DST-following zone (ET follows New York).
  function tzAbbrs() {
    return {
      UTC: 0, GMT: 0, UT: 0, Z: 0,
      PT: 'America/Los_Angeles', PST: -480, PDT: -420, MT: 'America/Denver', MST: -420, MDT: -360,
      CT: 'America/Chicago', CST: -360, CDT: -300, ET: 'America/New_York', EST: -300, EDT: -240,
      AKT: 'America/Anchorage', AKST: -540, AKDT: -480, HT: 'Pacific/Honolulu', HST: -600,
      AT: 'America/Halifax', AST: -240, ADT: -180, NT: 'America/St_Johns', NST: -210, NDT: -150,
      BST: 60, IST: 330, WET: 0, WEST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180, MSK: 180,
      UK: 'Europe/London', CEIST: 120,
      GST: 240, PKT: 300, NPT: 345, ICT: 420, WIB: 420, SGT: 480, HKT: 480, PHT: 480, AWST: 480,
      JST: 540, KST: 540, ACST: 570, ACDT: 630, AEST: 600, AEDT: 660, AET: 'Australia/Sydney',
      NZST: 720, NZDT: 780, NZT: 'Pacific/Auckland', BRT: -180, ART: -180, SAST: 120, WAT: 60, CAT: 120, EAT: 180
    };
  }

  // Generic zone a standard/daylight abbreviation belongs to (for the
  // "EST in summer?" note).
  function tzAbbrHome(ab) {
    var H = { PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', MST: 'America/Denver', MDT: 'America/Denver',
      CST: 'America/Chicago', CDT: 'America/Chicago', EST: 'America/New_York', EDT: 'America/New_York',
      AKST: 'America/Anchorage', AKDT: 'America/Anchorage', AST: 'America/Halifax', ADT: 'America/Halifax',
      NST: 'America/St_Johns', NDT: 'America/St_Johns', BST: 'Europe/London', WET: 'Europe/Lisbon', WEST: 'Europe/Lisbon',
      CET: 'Europe/Paris', CEST: 'Europe/Paris', EET: 'Europe/Athens', EEST: 'Europe/Athens',
      ACST: 'Australia/Adelaide', ACDT: 'Australia/Adelaide', AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney',
      NZST: 'Pacific/Auckland', NZDT: 'Pacific/Auckland' };
    return H[ab] || null;
  }

  // ~100 major cities (plus a few nicknames) → IANA zone.
  function tzCities() {
    return {
      'London': 'Europe/London', 'Edinburgh': 'Europe/London', 'Manchester': 'Europe/London', 'Dublin': 'Europe/Dublin',
      'Lisbon': 'Europe/Lisbon', 'Paris': 'Europe/Paris', 'Berlin': 'Europe/Berlin', 'Munich': 'Europe/Berlin',
      'Frankfurt': 'Europe/Berlin', 'Hamburg': 'Europe/Berlin', 'Madrid': 'Europe/Madrid', 'Barcelona': 'Europe/Madrid',
      'Rome': 'Europe/Rome', 'Milan': 'Europe/Rome', 'Amsterdam': 'Europe/Amsterdam', 'Brussels': 'Europe/Brussels',
      'Vienna': 'Europe/Vienna', 'Zurich': 'Europe/Zurich', 'Geneva': 'Europe/Zurich', 'Stockholm': 'Europe/Stockholm',
      'Oslo': 'Europe/Oslo', 'Copenhagen': 'Europe/Copenhagen', 'Helsinki': 'Europe/Helsinki', 'Warsaw': 'Europe/Warsaw',
      'Prague': 'Europe/Prague', 'Budapest': 'Europe/Budapest', 'Athens': 'Europe/Athens', 'Bucharest': 'Europe/Bucharest',
      'Kyiv': 'Europe/Kiev', 'Kiev': 'Europe/Kiev', 'Istanbul': 'Europe/Istanbul', 'Moscow': 'Europe/Moscow',
      'Reykjavik': 'Atlantic/Reykjavik', 'Cairo': 'Africa/Cairo', 'Johannesburg': 'Africa/Johannesburg',
      'Cape Town': 'Africa/Johannesburg', 'Lagos': 'Africa/Lagos', 'Nairobi': 'Africa/Nairobi', 'Casablanca': 'Africa/Casablanca',
      'Dubai': 'Asia/Dubai', 'Abu Dhabi': 'Asia/Dubai', 'Riyadh': 'Asia/Riyadh', 'Doha': 'Asia/Qatar',
      'Tel Aviv': 'Asia/Jerusalem', 'Jerusalem': 'Asia/Jerusalem', 'Tehran': 'Asia/Tehran', 'Karachi': 'Asia/Karachi',
      'Mumbai': 'Asia/Kolkata', 'Delhi': 'Asia/Kolkata', 'New Delhi': 'Asia/Kolkata', 'Bangalore': 'Asia/Kolkata',
      'Bengaluru': 'Asia/Kolkata', 'Kolkata': 'Asia/Kolkata', 'Chennai': 'Asia/Kolkata', 'Hyderabad': 'Asia/Kolkata',
      'Dhaka': 'Asia/Dhaka', 'Kathmandu': 'Asia/Kathmandu', 'Bangkok': 'Asia/Bangkok', 'Jakarta': 'Asia/Jakarta',
      'Singapore': 'Asia/Singapore', 'Kuala Lumpur': 'Asia/Kuala_Lumpur', 'Manila': 'Asia/Manila',
      'Ho Chi Minh City': 'Asia/Ho_Chi_Minh', 'Saigon': 'Asia/Ho_Chi_Minh', 'Hanoi': 'Asia/Ho_Chi_Minh',
      'Hong Kong': 'Asia/Hong_Kong', 'Shanghai': 'Asia/Shanghai', 'Beijing': 'Asia/Shanghai', 'Shenzhen': 'Asia/Shanghai',
      'Taipei': 'Asia/Taipei', 'Seoul': 'Asia/Seoul', 'Tokyo': 'Asia/Tokyo', 'Osaka': 'Asia/Tokyo',
      'Sydney': 'Australia/Sydney', 'Melbourne': 'Australia/Melbourne', 'Brisbane': 'Australia/Brisbane',
      'Perth': 'Australia/Perth', 'Adelaide': 'Australia/Adelaide', 'Auckland': 'Pacific/Auckland', 'Wellington': 'Pacific/Auckland',
      'Honolulu': 'Pacific/Honolulu', 'Hawaii': 'Pacific/Honolulu', 'Anchorage': 'America/Anchorage',
      'Los Angeles': 'America/Los_Angeles', 'LA': 'America/Los_Angeles', 'San Francisco': 'America/Los_Angeles',
      'SF': 'America/Los_Angeles', 'Seattle': 'America/Los_Angeles', 'Portland': 'America/Los_Angeles',
      'San Diego': 'America/Los_Angeles', 'Las Vegas': 'America/Los_Angeles', 'Vancouver': 'America/Vancouver',
      'Phoenix': 'America/Phoenix', 'Denver': 'America/Denver', 'Salt Lake City': 'America/Denver',
      'Calgary': 'America/Edmonton', 'Edmonton': 'America/Edmonton', 'Chicago': 'America/Chicago', 'Dallas': 'America/Chicago',
      'Houston': 'America/Chicago', 'Austin': 'America/Chicago', 'Minneapolis': 'America/Chicago', 'Mexico City': 'America/Mexico_City',
      'New York': 'America/New_York', 'New York City': 'America/New_York', 'NYC': 'America/New_York', 'Boston': 'America/New_York',
      'Washington': 'America/New_York', 'Washington DC': 'America/New_York', 'DC': 'America/New_York', 'Atlanta': 'America/New_York',
      'Miami': 'America/New_York', 'Philadelphia': 'America/New_York', 'Detroit': 'America/Detroit', 'Toronto': 'America/Toronto',
      'Montreal': 'America/Toronto', 'Ottawa': 'America/Toronto', 'Halifax': 'America/Halifax', "St John's": 'America/St_Johns',
      'Bogota': 'America/Bogota', 'Lima': 'America/Lima', 'Santiago': 'America/Santiago',
      'Buenos Aires': 'America/Argentina/Buenos_Aires', 'Sao Paulo': 'America/Sao_Paulo', 'S\u00E3o Paulo': 'America/Sao_Paulo',
      'Rio de Janeiro': 'America/Sao_Paulo', 'Rio': 'America/Sao_Paulo', 'Caracas': 'America/Caracas',
      'Pacific': 'America/Los_Angeles', 'Mountain': 'America/Denver', 'Central': 'America/Chicago', 'Eastern': 'America/New_York',
      'Atlantic': 'America/Halifax', 'Alaska': 'America/Anchorage'
    };
  }

  function tzNorm(s) {
    return String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[.']/g, '').replace(/\s+/g, ' ').trim();
  }

  function tzOffLabel(off) {
    if (!off) return 'UTC';
    var a = Math.abs(off), h = Math.floor(a / 60), mi = a % 60;
    return 'UTC' + (off < 0 ? '-' : '+') + h + (mi ? ':' + (mi < 10 ? '0' : '') + mi : '');
  }

  // Validate / canonicalise an IANA name with Intl (case-insensitively).
  function tzCanon(s) {
    var tries = [s, s.split('/').map(function (p) {
      return p.split('_').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }).join('_');
    }).join('/')];
    for (var i = 0; i < tries.length; i++) {
      try { return new Intl.DateTimeFormat('en-US', { timeZone: tries[i] }).resolvedOptions().timeZone; } catch (e) { /* next */ }
    }
    return null;
  }

  // "Europe/London", "cet", "PT", "Tokyo", "UTC+5:30", "local" → zone object
  // { id } (IANA, follows DST) or { fixed, label } (fixed offset), or null.
  function tzResolve(str) {
    var s = String(str || '').trim().replace(/^\(|\)$/g, '').replace(/\s+(?:standard\s+|daylight\s+)?time$/i, '').trim(), m;
    if (!s) return null;
    if (/^(?:local|here|device|mine|my time|this device)$/i.test(s)) return { id: tzDevice() };
    if ((m = /^(?:UTC|GMT)?\s*([+\-\u2212])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(s)) && /^(?:UTC|GMT|[+\-\u2212])/i.test(s)) {
      var off = (+m[2] * 60 + (+m[3] || 0)) * (m[1] === '+' ? 1 : -1);
      if (Math.abs(off) <= 14 * 60) return { fixed: off, label: tzOffLabel(off) };
    }
    var A = tzAbbrs(), up = s.toUpperCase();
    if (A.hasOwnProperty(up)) return typeof A[up] === 'number' ? { fixed: A[up], label: up === 'Z' || up === 'UT' ? 'UTC' : up } : { id: A[up] };
    var C = tzCities(), key = tzNorm(s);
    for (var name in C) if (tzNorm(name) === key) return { id: C[name] };
    if (/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+){0,2}$/.test(s)) { var id = tzCanon(s); if (id) return { id: id }; }
    return null;
  }

  // Minutes east of UTC for zone z at instant ms.
  function tzOffset(z, ms) {
    if (z.fixed != null) return z.fixed;
    var cache = tzOffset.cache || (tzOffset.cache = {});
    var f = cache[z.id] || (cache[z.id] = new Intl.DateTimeFormat('en-US', { timeZone: z.id, hour12: false,
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
    var p = {}, parts = f.formatToParts(new Date(ms));
    for (var i = 0; i < parts.length; i++) p[parts[i].type] = parts[i].value;
    var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  }

  // Wall-clock time in zone z → UTC ms. A time skipped by DST (2:30 on
  // spring-forward night) moves forward an hour; a repeated one takes the first.
  function tzToUtc(y, mo, d, h, mi, z) {
    var guess = Date.UTC(y, mo - 1, d, h, mi), o0 = tzOffset(z, guess);
    var t1 = guess - o0 * 60000, o1 = tzOffset(z, t1);
    if (o1 === o0) return t1;
    var t2 = guess - o1 * 60000;
    return tzOffset(z, t2) === o1 ? t2 : Math.max(t1, t2);
  }

  function tzParts(z, ms) {
    var off = tzOffset(z, ms), d = new Date(ms + off * 60000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(),
             s: d.getUTCSeconds(), wd: d.getUTCDay(), off: off };
  }

  // Short name for zone z at ms: "EDT", "BST", "CEST", "IST", "AEDT"… —
  // falls back to "UTC+9" when no English locale has a letter abbreviation.
  function tzAbbr(z, ms) {
    if (z.fixed != null) return z.label || tzOffLabel(z.fixed);
    var cache = tzAbbr.cache || (tzAbbr.cache = {}), off = tzOffset(z, ms);
    var LOCS = ['en-US', 'en-GB', 'en-AU', 'en-IN', 'en-NZ', 'en-CA'];
    for (var i = 0; i < LOCS.length; i++) {
      var k = LOCS[i] + '|' + z.id, name = '';
      try {
        var f = cache[k] || (cache[k] = new Intl.DateTimeFormat(LOCS[i], { timeZone: z.id, timeZoneName: 'short' }));
        var parts = f.formatToParts(new Date(ms));
        for (var j = 0; j < parts.length; j++) if (parts[j].type === 'timeZoneName') name = parts[j].value;
      } catch (e) { name = ''; }
      if (/^[A-Z]{2,5}$/.test(name) && (name !== 'GMT' || off === 0) && (name !== 'UTC' || off === 0)) return name;
    }
    var FB = { 'Asia/Tokyo': 'JST', 'Asia/Seoul': 'KST', 'Asia/Shanghai': 'CST', 'Asia/Hong_Kong': 'HKT', 'Asia/Singapore': 'SGT',
      'Asia/Taipei': 'CST', 'Asia/Dubai': 'GST', 'Asia/Manila': 'PHT', 'Asia/Jakarta': 'WIB', 'Asia/Bangkok': 'ICT',
      'Asia/Ho_Chi_Minh': 'ICT', 'Asia/Kuala_Lumpur': 'MYT', 'Asia/Karachi': 'PKT', 'Asia/Kathmandu': 'NPT', 'Asia/Dhaka': 'BST',
      'Europe/Moscow': 'MSK', 'Europe/Istanbul': 'TRT', 'America/Sao_Paulo': 'BRT', 'America/Argentina/Buenos_Aires': 'ART',
      'Africa/Johannesburg': 'SAST', 'Africa/Lagos': 'WAT', 'Africa/Nairobi': 'EAT', 'Asia/Kolkata': 'IST', 'Asia/Jerusalem': off === 180 ? 'IDT' : 'IST',
      'Asia/Riyadh': 'AST', 'Asia/Qatar': 'AST', 'Asia/Tehran': 'IRST', 'Australia/Perth': 'AWST', 'Australia/Brisbane': 'AEST' };
    return FB[z.id] || tzOffLabel(off);
  }

  function tzFmtTime(h, mi, h12) {
    var mm = (mi < 10 ? '0' : '') + mi;
    if (h12) return ((h + 11) % 12 + 1) + ':' + mm + ' ' + (h < 12 ? 'AM' : 'PM');
    return (h < 10 ? '0' : '') + h + ':' + mm;
  }

  function tzFmtDate(p) {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][p.wd] + ' ' +
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p.m - 1] + ' ' + p.d;
  }

  // Does this device prefer a 12-hour clock?
  function tzH12() {
    try {
      var o = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions();
      return o.hourCycle ? o.hourCycle === 'h12' || o.hourCycle === 'h11' : !!o.hour12;
    } catch (e) { return true; }
  }

  /* ================================================================
     2. Convert Times Between Zones…
     ================================================================ */

  var tzMain = function main(ctx) {
    var ed = window.Cade && window.Cade.editor;
    if (ed && ed.state.readOnly) { showToast('Document is read-only', 'error', 2500); return; }
    var t = ctx.selection || ctx.fullText;
    var found = tzFind(t);
    if (!found.length) { showToast('No times found (e.g. "3pm PT", "15:30 CET", "2026-10-13T15:00Z")', 'info', 3500); return; }
    var KT = 'cade-codetime-target', KS = 'cade-codetime-source', KM = 'cade-codetime-mode', dev = tzDevice();
    var ans = window.prompt('Convert ' + found.length + ' time' + (found.length === 1 ? '' : 's') + ' to which time zone?\n' +
      'IANA (Europe/London), abbreviation (CET, PT, IST), city (Tokyo) or UTC+2 — comma-separate several.', ctStoreGet(KT) || dev);
    if (ans === null) return;
    var targets = tzList(ans);
    if (targets.bad.length) { showToast('Unknown time zone: ' + targets.bad.join(', '), 'error', 3500); return; }
    if (!targets.list.length) return;
    ctStoreSet(KT, ans.trim());
    var src = null;
    if (found.some(function (f) { return !f.zone && !f.abs; })) {
      var sa = window.prompt('Times without a zone (like "3pm") are in which zone?', ctStoreGet(KS) || dev);
      if (sa === null) return;
      src = tzResolve(sa);
      if (!src) { showToast('Unknown time zone: ' + sa, 'error', 3000); return; }
      ctStoreSet(KS, sa.trim());
    }
    var ma = window.prompt('1  annotate — 3pm PT (6:00 PM EDT)\n2  replace — 6:00 PM EDT', ctStoreGet(KM) || '1');
    if (ma === null) return;
    var mode = /^\s*(2|r)/i.test(ma) ? 'replace' : 'annotate';
    ctStoreSet(KM, mode === 'replace' ? '2' : '1');
    var res = tzConvert(t, found, targets.list, src, mode, Date.now());
    if (res.text !== t) { if (ctx.selection) ctx.selection = res.text; else ctx.fullText = res.text; }
    showToast('Converted ' + res.count + ' time' + (res.count === 1 ? '' : 's') + (res.notes.length ? ' \u00B7 ' + res.notes.join(' \u00B7 ') : ''),
      res.notes.length ? 'info' : 'success', res.notes.length ? 7000 : 2500);
  };

  // "Tokyo, CET, America/New_York" → { list: [{ zone, label }], bad: [names] }
  function tzList(s) {
    var out = { list: [], bad: [] };
    String(s).split(/[,;\n]+/).slice(0, 24).forEach(function (tok) {
      tok = tok.trim();
      if (!tok) return;
      var z = tzResolve(tok);
      if (!z) { out.bad.push(tok); return; }
      var label = z.id && tok.indexOf('/') >= 0 ? tok.split('/').pop().replace(/_/g, ' ') : tok;
      out.list.push({ zone: z, label: label });
    });
    return out;
  }

  // Regex source matching a zone name in prose (no capture groups inside).
  function tzZoneSrc() {
    var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'); };
    var byLen = function (a, b) { return b.length - a.length; };
    var ab = Object.keys(tzAbbrs()).filter(function (k) { return k !== 'Z' && k !== 'UK' && k !== 'UT'; }).sort(byLen);
    var cities = Object.keys(tzCities()).sort(byLen).map(esc);
    return '(?:(?:UTC|GMT)\\s?[+\\-\u2212]\\s?\\d{1,2}(?::?\\d{2})?' +
      '|[A-Z][A-Za-z]+(?:\\/[A-Z][A-Za-z_+\\-]+){1,2}' +
      '|(?:Pacific|Eastern|Central|Mountain|Atlantic|Alaska|Hawaii)(?:\\s+(?:Standard|Daylight))?(?:\\s+Time)?' +
      '|' + ab.join('|') + '|' + cities.join('|') + ')';
  }

  // Every convertible time in `text`:
  // { s, e, h, mi, h12, zoneStr, zone, abs (UTC ms for ISO with offset), iso, date }.
  function tzFind(text) {
    var Z = tzZoneSrc(), out = [], m;
    var ZT = '(?:\\s*\\((' + Z + ')\\)|\\s*(?:in\\s+)?(' + Z + ')(?:\\s+[Tt]ime)?)?(?![A-Za-z])';
    var iso = new RegExp('(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.\\d+)?)?(?:\\s?(Z|[+\\-]\\d{2}(?::?\\d{2})?)(?![\\w])|' +
      '\\s+(' + Z + ')(?![A-Za-z]))?', 'g');
    while ((m = iso.exec(text))) {
      if (/\d/.test(text.charAt(m.index - 1))) continue;
      var f = { s: m.index, e: m.index + m[0].length, iso: true, h: +m[4], mi: +m[5], sec: m[6] != null ? +m[6] : null, h12: false,
                date: { y: +m[1], m: +m[2], d: +m[3] } };
      if (m[7]) {
        var om = /^([+\-])(\d{2}):?(\d{2})?$/.exec(m[7]), off = m[7] === 'Z' ? 0 : (+om[2] * 60 + (+om[3] || 0)) * (om[1] === '-' ? -1 : 1);
        f.abs = Date.UTC(f.date.y, f.date.m - 1, f.date.d, f.h, f.mi, f.sec || 0) - off * 60000;
        f.srcLabel = m[7] === 'Z' ? 'UTC' : tzOffLabel(off);
      } else if (m[8]) { f.zoneStr = m[8]; f.zone = tzResolve(m[8]); }
      if (f.h < 24 && f.mi < 60) out.push(f);
    }
    var tre = new RegExp('(?:(\\d{1,2})(?::(\\d{2}))?\\s?([aApP])\\.?[mM]\\.?|(\\d{1,2}):(\\d{2})(?::\\d{2})?|([Nn]oon|[Mm]idnight))' + ZT, 'g');
    while ((m = tre.exec(text))) {
      var s = m.index, e = s + m[0].length;
      if (/[\d:.\w]/.test(text.charAt(s - 1)) || /\d/.test(text.charAt(e))) continue;
      if (out.some(function (o) { return o.iso && s < o.e && e > o.s; })) continue;
      var h, mi = 0, h12 = false;
      if (m[6]) { h = /^n/i.test(m[6]) ? 12 : 0; h12 = true; }
      else if (m[3]) { h = +m[1]; mi = m[2] ? +m[2] : 0; if (h < 1 || h > 12) continue; h = h % 12 + (/p/i.test(m[3]) ? 12 : 0); h12 = true; }
      else { h = +m[4]; mi = +m[5]; if (h > 23) continue; }
      if (mi > 59) continue;
      var zs = m[7] || m[8] || null;
      out.push({ s: s, e: e, h: h, mi: mi, h12: h12, zoneStr: zs, zone: zs ? tzResolve(zs) : null });
    }
    // "3-4pm PT", "11-1pm ET": the bare first hour borrows the meridiem and zone.
    var rng = /(\d{1,2})(?::(\d{2}))?\s*(?:-|\u2013|\u2014|to)\s*(?=\d)/g;
    while ((m = rng.exec(text))) {
      var rs = m.index, re2 = rs + m[1].length + (m[2] ? m[2].length + 1 : 0);
      if (/[\d:.\w]/.test(text.charAt(rs - 1)) || out.some(function (o) { return rs < o.e && re2 > o.s; })) continue;
      var nx = null;
      for (var k = 0; k < out.length; k++) if (out[k].s === rs + m[0].length) nx = out[k];
      if (!nx || nx.iso) continue;
      var h1 = +m[1], mi1 = m[2] ? +m[2] : 0;
      if (nx.h12) {
        if (h1 < 1 || h1 > 12) continue;
        var pm = nx.h >= 12, nh = (nx.h + 11) % 12 + 1;
        if (h1 > nh && h1 !== 12) pm = !pm;                     // 11-1pm: 11 is am
        h1 = h1 % 12 + (pm ? 12 : 0);
      } else if (!m[2] || h1 > 23) continue;
      out.push({ s: rs, e: re2, h: h1, mi: mi1, h12: nx.h12, zoneStr: null, zone: null, rangeOf: nx });
    }
    out.sort(function (a, b) { return a.s - b.s; });
    out.forEach(function (f) {
      if (f.rangeOf) { f.zone = f.rangeOf.zone; f.zoneStr = f.rangeOf.zoneStr; f.abs = null; }
      if (!f.iso) f.date = tzDateNear(text, f.s, f.e);
    });
    return out.filter(function (f) { return !f.zoneStr || f.zone; });
  }

  // A date on the same line just before (or right after) a time: ISO,
  // 10/14/2026, "Oct 14", "14 October 2026". Yearless → this year.
  function tzDateNear(text, s, e) {
    var ls = text.lastIndexOf('\n', s - 1) + 1, le = text.indexOf('\n', e);
    if (le < 0) le = text.length;
    var line = text.slice(ls, le), a = s - ls, b = e - ls, best = null, m;
    var MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
    var forms = [
      [/(\d{4})-(\d{1,2})-(\d{1,2})/g, function (x) { return { y: +x[1], m: +x[2], d: +x[3] }; }],
      [/(\d{1,2})\/(\d{1,2})\/(\d{4})/g, function (x) { return +x[1] > 12 ? { y: +x[3], m: +x[2], d: +x[1] } : { y: +x[3], m: +x[1], d: +x[2] }; }],
      [new RegExp('\\b' + MON + '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?', 'gi'), function (x) { return { y: x[3] ? +x[3] : null, m: tzMon(x[1]), d: +x[2] }; }],
      [new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+' + MON + '(?:,?\\s+(\\d{4}))?', 'gi'), function (x) { return { y: x[3] ? +x[3] : null, m: tzMon(x[2]), d: +x[1] }; }]
    ];
    for (var f = 0; f < forms.length; f++) {
      var re = forms[f][0];
      while ((m = re.exec(line))) {
        var ds = m.index, de = ds + m[0].length;
        if (de > a && ds < b) continue;
        var dist = de <= a ? a - de : ds - b;
        if (de <= a ? dist > 40 : dist > 25) continue;
        var d = forms[f][1](m);
        if (!(d.m >= 1 && d.m <= 12 && d.d >= 1 && d.d <= 31)) continue;
        if (!best || dist < best.dist) best = { dist: dist, d: d };
      }
    }
    return best ? best.d : null;
  }

  function tzMon(s) { return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(s.slice(0, 3).toLowerCase()) + 1; }

  // Rewrite (back to front). Returns { text, count, notes }.
  function tzConvert(text, found, targets, src, mode, now) {
    var res = text, count = 0, notes = [];
    for (var i = found.length - 1; i >= 0; i--) {
      var f = found[i], zone = f.zone || src, utc;
      if (f.abs != null) utc = f.abs;
      else {
        if (!zone) continue;
        var dt = f.date;
        if (!dt || dt.y == null) {
          var today = tzParts(zone, now);
          dt = { y: dt && dt.y == null ? today.y : today.y, m: dt ? dt.m : today.m, d: dt ? dt.d : today.d };
        }
        utc = tzToUtc(dt.y, dt.m, dt.d, f.h, f.mi, zone);
        f.date = dt;
        if (zone.fixed != null && zone.label && tzAbbrHome(zone.label)) {
          var home = tzOffset({ id: tzAbbrHome(zone.label) }, utc);
          if (home !== zone.fixed && notes.indexOf(zone.label) < 0) {
            notes.push(zone.label + ' read strictly as ' + tzOffLabel(zone.fixed) + ' (that date uses ' + tzOffLabel(home) + ')');
          }
        }
      }
      var srcOff = f.abs != null ? null : tzOffset(zone, utc), outs = [];
      for (var k = 0; k < targets.length; k++) {
        var tz = targets[k].zone, p = tzParts(tz, utc);
        if (mode === 'annotate' && srcOff !== null && p.off === srcOff && tzAbbr(tz, utc) === tzAbbr(zone, utc)) continue;
        var str;
        if (f.iso && mode === 'replace') {
          var pad = function (x) { return (x < 10 ? '0' : '') + x; }, o = p.off, ao = Math.abs(o);
          str = p.y + '-' + pad(p.m) + '-' + pad(p.d) + 'T' + pad(p.h) + ':' + pad(p.mi) + (f.sec != null ? ':' + pad(p.s) : '') +
            (o === 0 && (tz.fixed === 0 || /^(?:Etc\/)?(?:UTC|GMT|UCT|Zulu)$/.test(tz.id || '')) ? 'Z' : (o < 0 ? '-' : '+') + pad(Math.floor(ao / 60)) + ':' + pad(ao % 60));
        } else {
          str = (f.iso ? tzFmtDate(p) + ', ' : '') + tzFmtTime(p.h, p.mi, f.iso ? true : f.h12) + ' ' + tzAbbr(tz, utc);
          if (!f.iso && f.date) {
            var dd = Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(f.date.y, f.date.m - 1, f.date.d)) / 864e5);
            if (dd) str += dd === 1 ? ' next day' : dd === -1 ? ' previous day' : ' ' + (dd > 0 ? '+' : '') + dd + ' days';
          }
        }
        outs.push(str);
        if (mode === 'replace') break;
      }
      if (!outs.length) continue;
      if (mode === 'replace') res = res.slice(0, f.s) + outs[0] + res.slice(f.e);
      else {
        if (/^\s?\(\s*(?:\w{3} \w{3} \d{1,2}, )?\d{1,2}:\d{2}/.test(text.slice(f.e))) continue;   // already annotated
        res = res.slice(0, f.e) + ' (' + outs.join(' / ') + ')' + res.slice(f.e);
      }
      count++;
    }
    return { text: res, count: count, notes: notes };
  }

  /* ================================================================
     3. Insert Time In Zones…
     ================================================================ */

  var insMain = function main(ctx) {
    var ed = window.Cade && window.Cade.editor;
    if (!ed) return;
    var KEY = 'cade-codetime-zones', dev = tzDevice();
    var def = ctStoreGet(KEY) || [dev, 'UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo']
      .filter(function (z, i, a) { return a.indexOf(z) === i; }).join(', ');
    var ans = window.prompt('Insert the current time in which zones? (comma-separated: IANA names, CET / PT, cities, UTC+2)', def);
    if (ans === null) return;
    var L = tzList(ans);
    if (L.bad.length) { showToast('Unknown time zone: ' + L.bad.join(', '), 'error', 3500); return; }
    if (!L.list.length) return;
    ctStoreSet(KEY, ans.trim());
    var block = tzNowBlock(L.list, Date.now(), tzH12());
    var st = ed.state, sel = st.selection.main;
    if (st.readOnly) { ctCopy(block, 'Read-only mode — times copied to clipboard instead'); return; }
    var line = st.doc.lineAt(sel.from), multi = L.list.length > 1;
    var before = multi && sel.from > line.from ? '\n' : '';
    var lineEnd = st.doc.lineAt(sel.to);
    var after = multi && sel.to < lineEnd.to ? '\n' : '';
    var ins = before + block + after;
    ed.dispatch({ changes: { from: sel.from, to: sel.to, insert: ins }, selection: { anchor: sel.from + ins.length }, userEvent: 'input', scrollIntoView: true });
  };

  // One zone → "Tue Oct 13, 3:04 PM PDT"; several → aligned lines
  // "Los Angeles  Tue Oct 13  3:04 PM  PDT  (UTC-7)".
  function tzNowBlock(list, ms, h12) {
    if (list.length === 1) {
      var p0 = tzParts(list[0].zone, ms);
      return tzFmtDate(p0) + ', ' + tzFmtTime(p0.h, p0.mi, h12) + ' ' + tzAbbr(list[0].zone, ms);
    }
    var rows = list.map(function (it) {
      var p = tzParts(it.zone, ms), ab = tzAbbr(it.zone, ms), off = tzOffLabel(p.off);
      return [it.label, tzFmtDate(p), tzFmtTime(p.h, p.mi, h12), ab, ab === off ? '' : '(' + off + ')'];
    });
    var w = [0, 0, 0, 0];
    rows.forEach(function (r) { for (var c = 0; c < 4; c++) w[c] = Math.max(w[c], r[c].length); });
    return rows.map(function (r) {
      var s = '';
      for (var c = 0; c < 4; c++) s += c === 2 ? new Array(w[c] - r[c].length + 1).join(' ') + r[c] + '  ' : r[c] + new Array(w[c] - r[c].length + 3).join(' ');
      return (s + r[4]).replace(/\s+$/, '');
    }).join('\n');
  }

  /* ================================================================
     Registration
     ================================================================ */

  reg({
    name: 'Strip Code Comments',
    description: 'Remove comments from code — JS/TS/Java/C/C#/Go/Rust/Swift/Kotlin, Python, Ruby, shell, YAML, TOML, CSS, HTML, SQL, Lua — never inside strings or regexes; keeps shebangs and /*! licences',
    author: 'Cade', icon: ICON.strip,
    tags: 'comments,strip,remove,delete,code,uncomment,clean,javascript,typescript,python,ruby,shell,yaml,css,html,sql,lua,java,go,rust,docstring'
  }, scMain, [scRange, scFenceBody, scLang, scSpec, scStrip, scScan, scTpl, scRegexOk, scRegexEnd, scHeredocSkip, scHtml, scApply, scDetect]);

  var TZ = [tzDevice, tzAbbrs, tzAbbrHome, tzCities, tzNorm, tzOffLabel, tzCanon, tzResolve, tzOffset, tzToUtc, tzParts, tzAbbr,
    tzFmtTime, tzFmtDate, tzH12, tzList, ctStoreGet, ctStoreSet];

  reg({
    name: 'Convert Times Between Zones…',
    description: 'Convert "3pm PT", "15:30 CET", "10am New York", "noon UTC", ISO timestamps… to another zone (DST-correct) — annotate "3pm PT (6:00 PM EDT)" or replace',
    author: 'Cade', icon: ICON.zones,
    tags: 'time zone,timezone,convert,tz,utc,gmt,pst,est,cet,ist,jst,dst,meeting,schedule,world clock,iana,city,annotate'
  }, tzMain, TZ.concat([tzZoneSrc, tzFind, tzDateNear, tzMon, tzConvert]));

  reg({
    name: 'Insert Time In Zones…',
    description: 'Insert the current time in a list of time zones (remembered) — e.g. your zone, UTC, New York, London, Tokyo',
    author: 'Cade', icon: ICON.insert,
    tags: 'time zone,timezone,insert,now,current time,world clock,utc,clock,zones,cities,meeting,schedule'
  }, insMain, TZ.concat([tzNowBlock, ctCopy]));
})();
