/* Code Pack library - shared engine for Minify / Obfuscate / Beautify.
   Loaded lazily (as a separate <script>) by txt/scripts/pack-code/pack-code.js
   on the first time any Code Pack script runs. Sets window.__CADE_CODEPACK__.
   Heavy third-party libs (terser, js-beautify, javascript-obfuscator) are
   themselves loaded from cdn.jsdelivr.net only when actually needed.
   Kept as its own file (not inlined per-script) so the ~scripts share one copy
   and the big logic loads once. Pure helpers are exposed with a leading _ so
   they can be unit-checked in node. */
(function () {
  'use strict';
  if (window.__CADE_CODEPACK__) return;

  // --- pinned, exact CDN versions (verified to exist + global/API read) ---
  var CDN = {
    terser: 'https://cdn.jsdelivr.net/npm/terser@5.51.2/dist/bundle.min.js',               // global Terser.minify()
    beautify: 'https://cdn.jsdelivr.net/npm/js-beautify@1.15.4/js/lib/beautifier.min.js',  // global beautifier.{js,css,html}
    obfuscator: 'https://cdn.jsdelivr.net/npm/javascript-obfuscator@4.2.2/dist/index.browser.js' // global JavaScriptObfuscator.obfuscate()
  };

  function loadScript(url) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('Failed to load ' + url)); };
      document.head.appendChild(s);
    });
  }
  function ensureTerser() {
    if (window.Terser && window.Terser.minify) return Promise.resolve(window.Terser);
    return loadScript(CDN.terser).then(function () {
      if (!window.Terser || !window.Terser.minify) throw new Error('Terser failed to initialise');
      return window.Terser;
    });
  }
  function ensureBeautify() {
    if (window.beautifier && window.beautifier.js) return Promise.resolve(window.beautifier);
    return loadScript(CDN.beautify).then(function () {
      if (!window.beautifier || !window.beautifier.js) throw new Error('js-beautify failed to initialise');
      return window.beautifier;
    });
  }
  function ensureObfuscator() {
    if (window.JavaScriptObfuscator && window.JavaScriptObfuscator.obfuscate) return Promise.resolve(window.JavaScriptObfuscator);
    return loadScript(CDN.obfuscator).then(function () {
      if (!window.JavaScriptObfuscator || !window.JavaScriptObfuscator.obfuscate) throw new Error('javascript-obfuscator failed to initialise');
      return window.JavaScriptObfuscator;
    });
  }

  function toast(m, t, d) { try { window.Cade.showToast(m, t || 'info', d || 2500); } catch (e) {} }
  function enc(s) { try { return new TextEncoder().encode(s).length; } catch (e) { return s.length; } }
  function fmtSize(b) { return b < 1024 ? b + ' B' : (b / 1024).toFixed(1) + ' KB'; }
  function fmtDelta(inB, outB) {
    if (!inB) return '';
    var r = Math.round((1 - outB / inB) * 100);
    return r >= 0 ? '-' + r + '%' : '+' + (-r) + '%';
  }
  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function labelOf(lang) {
    return { js: 'JS', css: 'CSS', html: 'HTML', python: 'Python', json: 'JSON', xml: 'XML' }[lang] || lang.toUpperCase();
  }

  // =====================================================================
  // Language detection
  // =====================================================================
  var INFO_LANG = {
    js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js', es6: 'js',
    ts: 'js', typescript: 'js', tsx: 'js',
    py: 'python', python: 'python', python3: 'python', py3: 'python',
    html: 'html', htm: 'html', xhtml: 'html', vue: 'html', svelte: 'html',
    css: 'css', scss: 'css', less: 'css', sass: 'css',
    json: 'json', json5: 'json', jsonc: 'json',
    xml: 'xml', svg: 'xml', rss: 'xml', xsl: 'xml', xslt: 'xml'
  };
  function resolveLangFromInfo(info) {
    if (!info) return null;
    var k = String(info).trim().toLowerCase().split(/[\s,{}]+/)[0];
    return INFO_LANG[k] || null;
  }

  function detectLang(code) {
    var t = code.trim();
    if (!t) return { lang: 'js', sure: false };

    // JSON
    if (/^[\[{]/.test(t)) { try { JSON.parse(t); return { lang: 'json', sure: true }; } catch (e) {} }

    // Explicit XML prolog
    if (/^<\?xml\b/i.test(t)) return { lang: 'xml', sure: true };
    if (/^<!doctype\s+html/i.test(t)) return { lang: 'html', sure: true };

    // HTML: recognised html tags
    var htmlTag = /<(?:html|head|body|div|span|section|article|nav|header|footer|main|aside|p|a|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|form|input|button|label|select|option|textarea|img|picture|source|video|audio|canvas|svg|path|h[1-6]|script|style|link|meta|title|br|hr|strong|em|b|i|u|code|pre|blockquote|figure|figcaption|iframe|template)\b/i;
    if (htmlTag.test(t)) {
      var tags = (t.match(/<[a-zA-Z!\/][^>]*>/g) || []).length;
      return { lang: 'html', sure: tags >= 2 };
    }
    // Generic XML: tag pairs but not js/css punctuation soup
    if (/^<[a-zA-Z][\w:.-]*(\s[^<>]*)?>[\s\S]*<\/[a-zA-Z]/.test(t) && !/[;{]/.test(t.slice(0, 120))) {
      return { lang: 'xml', sure: false };
    }

    var looksJs = /[;{}]/.test(t) && /\b(function|var|let|const|return|=>)\b/.test(t);

    // CSS
    var cssAt = /@(media|import|keyframes|font-face|supports|charset|namespace|page)\b/;
    var cssRule = /[^{}]*\{[^{}]*[\w-]+\s*:[^{}]+\}/;
    if ((cssAt.test(t) || cssRule.test(t)) &&
        !/\b(function|=>|console\.|document\.|window\.)\b/.test(t) &&
        !/\bdef\s+\w+\s*\(/.test(t)) {
      var decls = (t.match(/[\w-]+\s*:\s*[^;{}]+[;}]/g) || []).length;
      if (cssAt.test(t) || decls >= 1) return { lang: 'css', sure: cssAt.test(t) || decls >= 2 };
    }

    // Python
    var pyStrong = /(^|\n)\s*(def|class|async\s+def)\s+\w+/.test(t) ||
                   /(^|\n)\s*(import\s+\w|from\s+[\w.]+\s+import)/.test(t) ||
                   /(^|\n)[ \t]*(if|elif|else|for|while|with|try|except|finally|def|class)\b[^\n]*:[ \t]*(#.*)?$/m.test(t);
    var pyWeak = /\b(elif|lambda|self|None|True|False)\b/.test(t) || /(^|[^\w])print\s*\(/.test(t) || /\bf["']/.test(t) || /:\n[ \t]+\S/.test(t);
    if (pyStrong && !looksJs) return { lang: 'python', sure: true };
    if (pyWeak && !looksJs && !/[{};]/.test(t)) return { lang: 'python', sure: false };

    // Default JS
    var jsSure = /\b(function|var|let|const|return|class|import|export|console|document|window|async|await)\b/.test(t) ||
                 /=>/.test(t) || /;\s*$/m.test(t);
    return { lang: 'js', sure: jsSure };
  }

  // =====================================================================
  // CSS minify (string/url-aware; own implementation)
  // =====================================================================
  var CH1 = String.fromCharCode(1), CH2 = String.fromCharCode(2);

  function stripCssComments(css) {
    var out = '', i = 0, n = css.length, inS = false, q = '';
    while (i < n) {
      var c = css[i];
      if (inS) {
        out += c;
        if (c === '\\') { out += (css[i + 1] || ''); i += 2; continue; }
        if (c === q) inS = false;
        i++; continue;
      }
      if (c === '"' || c === "'") { inS = true; q = c; out += c; i++; continue; }
      if (c === '/' && css[i + 1] === '*') {
        var important = css[i + 2] === '!';
        var end = css.indexOf('*/', i + 2);
        if (end < 0) end = n - 2;
        if (important) out += css.slice(i, end + 2);
        i = end + 2; continue;
      }
      out += c; i++;
    }
    return out;
  }

  function minifyCSS(css) {
    css = stripCssComments(css);
    var store = [];
    // protect strings, then url(...)
    css = css.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, function (m) { store.push(m); return CH1 + (store.length - 1) + CH2; });
    css = css.replace(/url\(\s*([^)]*?)\s*\)/gi, function (m, inner) { store.push('url(' + inner + ')'); return CH1 + (store.length - 1) + CH2; });
    // collapse whitespace
    css = css.replace(/\s+/g, ' ');
    css = css.replace(/\s*\{\s*/g, '{').replace(/\s*\}\s*/g, '}')
             .replace(/\s*;\s*/g, ';').replace(/\s*,\s*/g, ',')
             .replace(/:\s+/g, ':').replace(/\s*>\s*/g, '>');
    // Space BEFORE ':' only inside declarations (segments ended by ';' or '}');
    // selector segments (ended by '{') keep it, since "a :hover" != "a:hover".
    css = css.replace(/(^|[{};])([^{};]*)(?=[;}])/g, function (m, pre, seg) { return pre + seg.replace(/\s+:/g, ':'); });
    // Conditional at-rule preludes: "and (min-width : 1px)" -> "and (min-width:1px)"
    css = css.replace(/@(media|supports|container)\b[^{]*/gi, function (m) { return m.replace(/\s*:\s*/g, ':'); });
    css = css.replace(/;}/g, '}');
    css = css.replace(/\s*!important/gi, '!important');
    // zero-length units
    css = css.replace(/(^|[\s:,(])(-?)0(?:px|em|rem|ex|ch|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q)\b/gi, '$1$20');
    // shorten hex colours
    css = css.replace(/#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3([0-9a-f])\4\b/gi, '#$1$2$3$4');
    css = css.replace(/#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3\b/gi, '#$1$2$3');
    // restore
    css = css.replace(new RegExp(CH1 + '(\\d+)' + CH2, 'g'), function (m, idx) { return store[+idx]; });
    return css.trim();
  }

  // CSS "obfuscate": honest + simple. Minify, then rewrite class/id names and
  // string contents as CSS hex escapes (\XX ). Stays valid + still matches the
  // same DOM; element selectors, pseudo-classes, at-rules, property names and
  // numeric/colour values are left intact so nothing breaks.
  function cssEscChar(ch) { return '\\' + ch.charCodeAt(0).toString(16) + ' '; }
  function obfuscateCSS(css) {
    var min = minifyCSS(css);
    var store = [];
    min = min.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, function (m) {
      var q = m[0], body = m.slice(1, -1), esc = '';
      for (var i = 0; i < body.length; i++) esc += cssEscChar(body[i]);
      store.push(q + esc + q);
      return CH1 + (store.length - 1) + CH2;
    });
    min = min.replace(/([.#])(-?[A-Za-z_][\w-]*)/g, function (m, p, name) {
      var esc = '';
      for (var i = 0; i < name.length; i++) esc += cssEscChar(name[i]);
      return p + esc;
    });
    min = min.replace(new RegExp(CH1 + '(\\d+)' + CH2, 'g'), function (m, idx) { return store[+idx]; });
    return '/*! Obfuscated by Cade.txt Code Pack - class/id names + strings are CSS-escaped. Valid CSS, still matches the same markup; not secure. */' + min;
  }

  // =====================================================================
  // HTML minify (own; raw <pre>/<textarea>, inline <script> via terser,
  // inline <style> via the CSS minifier)
  // =====================================================================
  function minifyHtmlAttrs(attrs) {
    if (!attrs || !attrs.trim()) return '';
    var BOOL = { checked: 1, disabled: 1, readonly: 1, multiple: 1, selected: 1, autofocus: 1, required: 1, novalidate: 1, hidden: 1, async: 1, defer: 1, ismap: 1, loop: 1, muted: 1, controls: 1, autoplay: 1, open: 1, reversed: 1, 'default': 1, itemscope: 1, nomodule: 1, allowfullscreen: 1, formnovalidate: 1, playsinline: 1, inert: 1 };
    var re = /([^\s=\/>]+)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g, m, out = '';
    while ((m = re.exec(attrs))) {
      var name = m[1], val = m[3];
      if (val === undefined) { out += ' ' + name; continue; }
      var unq = val;
      if (/^["']/.test(val)) unq = val.slice(1, -1);
      if (BOOL[name.toLowerCase()] && (unq === '' || unq.toLowerCase() === name.toLowerCase())) { out += ' ' + name; continue; }
      out += ' ' + name + '=' + val;
    }
    return out;
  }
  function minifyHtmlTag(tag) {
    var mm = /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)([\s\S]*?)(\/?)\s*>$/.exec(tag);
    if (!mm) return tag.replace(/\s+/g, ' ');
    return '<' + mm[1] + mm[2] + minifyHtmlAttrs(mm[3]) + (mm[4] ? ' /' : '') + '>';
  }
  function keepComment(c) { return /^<!--\[if/i.test(c) || /\[endif\]/i.test(c) || /^<!--!/.test(c); }

  async function minifyHTML(html) {
    var re = /<!--[\s\S]*?-->|<(script|style|pre|textarea)\b([^>]*)>([\s\S]*?)<\/\1\s*>|<\/?[a-zA-Z][^>]*>|[^<]+|</gi;
    var m, tokens = [];
    while ((m = re.exec(html))) tokens.push(m);
    var terser = null, pieces = [];
    // pieces: {k:'text'|'tag', v, name}; names let us drop whitespace between block tags
    function tagPiece(v, name) { pieces.push({ k: 'tag', v: v, name: name }); }
    for (var k = 0; k < tokens.length; k++) {
      var tk = tokens[k], full = tk[0];
      if (/^<!--/.test(full)) { if (keepComment(full)) tagPiece(full, ''); continue; }
      if (tk[1]) {
        var tag = tk[1].toLowerCase(), attrs = tk[2] || '', inner = tk[3] || '';
        var open = '<' + tag + minifyHtmlAttrs(attrs) + '>', close = '</' + tag + '>';
        if (tag === 'pre' || tag === 'textarea') { tagPiece(open + inner + close, tag); continue; }
        if (tag === 'style') { tagPiece(open + minifyCSS(inner) + close, tag); continue; }
        if (tag === 'script') {
          var typeM = /type\s*=\s*['"]?([^'">\s]+)/i.exec(attrs);
          var typ = typeM ? typeM[1].toLowerCase() : '';
          var isJs = !typ || typ === 'text/javascript' || typ === 'application/javascript' || typ === 'module' || typ === 'text/ecmascript';
          if (isJs && inner.trim()) {
            try {
              if (!terser) terser = await ensureTerser();
              var r = await terser.minify(inner, { compress: true, mangle: true });
              if (r && typeof r.code === 'string') inner = r.code;
            } catch (e) { /* keep inline script raw if it will not parse */ }
          }
          tagPiece(open + inner + close, tag); continue;
        }
      }
      if (/^<\/?[a-zA-Z]/.test(full)) { tagPiece(minifyHtmlTag(full), (/^<\/?([a-zA-Z][\w:-]*)/.exec(full)[1] || '').toLowerCase()); continue; }
      // text (or stray '<'); merge with a preceding text piece (comment removal
      // leaves text runs adjacent) so their whitespace collapses together
      var last = pieces[pieces.length - 1];
      if (last && last.k === 'text') last.v += full; else pieces.push({ k: 'text', v: full });
    }
    var out = '';
    for (var q = 0; q < pieces.length; q++) {
      var pc = pieces[q];
      if (pc.k === 'tag') { out += pc.v; continue; }
      var v = pc.v.replace(/\s+/g, ' ');
      if (v === ' ') {
        // whitespace-only between two block-level tags (or doc edge) renders nothing
        var pv = pieces[q - 1], nx = pieces[q + 1];
        if ((!pv || HTML_BLOCK[pv.name]) && (!nx || HTML_BLOCK[nx.name])) continue;
      }
      out += v;
    }
    return out.trim();
  }
  var HTML_BLOCK = {};
  ('html head body title meta link base script style noscript template div p ul ol li dl dt dd table caption colgroup col ' +
   'thead tbody tfoot tr td th section article nav header footer main aside h1 h2 h3 h4 h5 h6 hgroup form fieldset legend ' +
   'figure figcaption blockquote pre hr address details summary dialog menu option optgroup')
    .split(' ').forEach(function (t) { HTML_BLOCK[t] = 1; });

  // HTML "obfuscate": UTF-8-safe base64 + document.write loader. Page still
  // renders when JS is on. Honestly limited: trivially reversible, needs JS,
  // invisible to no-JS/crawlers - all noted in the emitted comment.
  function utf8ToB64(str) { return btoa(unescape(encodeURIComponent(str))); }
  function obfuscateHTML(html) {
    var b64 = utf8ToB64(html);
    var note = '<!-- Obfuscated by Cade.txt Code Pack. NOT encryption: the original HTML is base64-wrapped and trivially reversible. Requires JavaScript; invisible to crawlers / no-JS clients. -->';
    return note + '<' + 'script>document.write(decodeURIComponent(escape(atob("' + b64 + '"))))<' + '/script>';
  }

  // =====================================================================
  // Python minify (own tokenizer-aware implementation)
  // =====================================================================
  function matchStringStart(s, i) {
    var mm = /^([rbfuRBFU]{0,3})('''|"""|'|")/.exec(s.slice(i, i + 7));
    if (!mm) return null;
    if (mm[1].length > 0 && i > 0 && /[A-Za-z0-9_]/.test(s[i - 1])) return null; // prefix glued to an identifier
    // validate prefix is a real python combo (r,b,f,u and pairs); reject junk like 'uuu'
    if (mm[1] && !/^(r|u|b|f|rb|br|rf|fr|Rb|bR|[rbfuRBFU]?)$/i.test(mm[1])) {
      if (mm[1].length > 2) return null;
    }
    return { prefix: mm[1], quote: mm[2], triple: mm[2].length === 3 };
  }
  function readString(s, i, info) {
    var start = i, q = info.quote, isRaw = info.prefix.toLowerCase().indexOf('r') >= 0;
    i += info.prefix.length + q.length;
    if (info.triple) {
      while (i < s.length) {
        if (!isRaw && s[i] === '\\') { i += 2; continue; }
        if (s[i] === q[0] && s.slice(i, i + 3) === q) { i += 3; break; }
        i++;
      }
    } else {
      while (i < s.length) {
        if (s[i] === '\n') break;
        if (!isRaw && s[i] === '\\') { i += 2; continue; }
        if (s[i] === q) { i++; break; }
        i++;
      }
    }
    return { text: s.slice(start, i), end: i };
  }
  function indentWidth(lead) { var w = 0; for (var k = 0; k < lead.length; k++) w += lead[k] === '\t' ? 8 : 1; return w; }

  function minifyPython(src) {
    src = src.replace(/\r\n?/g, '\n');
    var n = src.length, i = 0, bracket = 0, cur = null, lines = [];
    function startLine() { cur = { segs: [] }; }
    function pushCode(v) { if (!cur) startLine(); cur.segs.push({ k: 'c', v: v }); }
    function pushStr(v) { if (!cur) startLine(); cur.segs.push({ k: 's', v: v }); }

    while (i < n) {
      var c = src[i];
      if (c === '\n') {
        var cont = false;
        if (bracket > 0) cont = true;
        else if (cur) {
          var lastC = null;
          for (var z = cur.segs.length - 1; z >= 0; z--) {
            if (cur.segs[z].k === 'c') { var v = cur.segs[z].v.replace(/[ \t]+$/, ''); if (v.length) { lastC = v[v.length - 1]; break; } }
            else { lastC = 'S'; break; }
          }
          if (lastC === '\\') {
            for (var z2 = cur.segs.length - 1; z2 >= 0; z2--) { if (cur.segs[z2].k === 'c') { cur.segs[z2].v = cur.segs[z2].v.replace(/\\[ \t]*$/, ''); break; } }
            cont = true;
          }
        }
        if (cont) { pushCode(' '); i++; continue; }
        if (cur) lines.push(cur);
        cur = null; i++; continue;
      }
      if (c === '#') { var j = i; while (j < n && src[j] !== '\n') j++; i = j; continue; }
      var info = matchStringStart(src, i);
      if (info) { var sr = readString(src, i, info); pushStr(sr.text); i = sr.end; continue; }
      var start = i;
      while (i < n) {
        var ch = src[i];
        if (ch === '\n' || ch === '#') break;
        if (matchStringStart(src, i)) break;
        if (ch === '(' || ch === '[' || ch === '{') bracket++;
        else if (ch === ')' || ch === ']' || ch === '}') { if (bracket > 0) bracket--; }
        i++;
      }
      pushCode(src.slice(start, i));
    }
    if (cur) lines.push(cur);

    // clean each logical line -> {width, text, isDoc}
    var pending = [];
    for (var li = 0; li < lines.length; li++) {
      var L = lines[li], lead = '';
      if (L.segs.length && L.segs[0].k === 'c') lead = (/^[ \t]*/.exec(L.segs[0].v))[0];
      var txt = '', first = true;
      for (var si = 0; si < L.segs.length; si++) {
        var seg = L.segs[si];
        if (seg.k === 's') { txt += seg.v; first = false; continue; }
        var vv = (first ? seg.v.slice(lead.length) : seg.v).replace(/[ \t]+/g, ' ');
        // collapse a space that meets another space across a code/join boundary
        if (txt.charAt(txt.length - 1) === ' ' && vv.charAt(0) === ' ') vv = vv.slice(1);
        txt += vv;
        first = false;
      }
      txt = txt.replace(/[ \t]+$/, '').replace(/^[ \t]+/, '');
      if (txt === '') continue;
      var nonEmpty = L.segs.filter(function (s) { return s.v.replace(/[ \t]/g, '') !== ''; });
      var isDoc = nonEmpty.length === 1 && nonEmpty[0].k === 's';
      pending.push({ width: indentWidth(lead), text: txt, isDoc: isDoc });
    }

    // map widths -> levels (indent stack)
    var stack = [0], emitted = [];
    for (var pi = 0; pi < pending.length; pi++) {
      var P = pending[pi];
      if (P.width > stack[stack.length - 1]) stack.push(P.width);
      else {
        while (stack.length > 1 && P.width < stack[stack.length - 1]) stack.pop();
        if (P.width !== stack[stack.length - 1]) stack.push(P.width);
      }
      emitted.push({ level: stack.length - 1, text: P.text, isDoc: P.isDoc });
    }

    // drop docstrings; insert 'pass' when that would empty a block
    var out = [];
    for (var ei = 0; ei < emitted.length; ei++) {
      var E = emitted[ei];
      if (E.isDoc) {
        var prev = out.length ? out[out.length - 1] : null;
        var next = (ei + 1 < emitted.length) ? emitted[ei + 1] : null;
        var opensBlock = prev && /:$/.test(prev.text) && prev.level === E.level - 1;
        var soleBody = opensBlock && (!next || next.level < E.level);
        if (soleBody) out.push({ level: E.level, text: 'pass' });
        continue;
      }
      out.push({ level: E.level, text: E.text });
    }
    return out.map(function (f) { return (f.level > 0 ? new Array(f.level + 1).join(' ') : '') + f.text; }).join('\n');
  }

  // Python "obfuscate": minify, then a zlib+base64 exec loader.
  function bytesToB64(bytes) {
    var bin = '', CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(bin);
  }
  async function deflateB64(str) {
    var data = new TextEncoder().encode(str);
    var cs = new CompressionStream('deflate'); // zlib/RFC1950 - Python zlib.decompress reads it
    var w = cs.writable.getWriter(); w.write(data); w.close();
    var buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    return bytesToB64(buf);
  }
  function pyStr(s) { return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
  async function obfuscatePython(src) {
    var mini = minifyPython(src), loader;
    if (typeof CompressionStream !== 'undefined') {
      var b64 = await deflateB64(mini);
      loader = 'import zlib,base64;exec(zlib.decompress(base64.b64decode(' + pyStr(b64) + ')))';
    } else {
      loader = 'import base64;exec(base64.b64decode(' + pyStr(utf8ToB64(mini)) + ').decode("utf-8"))';
    }
    return '# Obfuscated by Cade.txt Code Pack - zlib+base64 loader (reversible, NOT secure).\n' + loader + '\n';
  }

  // =====================================================================
  // JS minify / obfuscate (terser + javascript-obfuscator)
  // =====================================================================
  async function minifyJS(code) {
    var T = await ensureTerser(), r;
    try { r = await T.minify(code, { compress: true, mangle: true }); }
    catch (e) {
      var pos = (e && e.line != null) ? (' (line ' + e.line + (e.col != null ? ', col ' + e.col : '') + ')') : '';
      throw new Error('JS syntax error' + pos + ': ' + ((e && e.message) || e));
    }
    if (r && typeof r.code === 'string') return r.code;
    if (r && r.error) throw new Error('JS syntax error: ' + r.error.message);
    throw new Error('Minify produced no output');
  }
  function obfPreset(name) {
    if (name === 'low') return { compact: true, stringArray: true, stringArrayThreshold: 0.5, stringArrayEncoding: ['base64'] };
    if (name === 'high') return { compact: true, stringArray: true, stringArrayRotate: true, stringArrayShuffle: true, stringArrayThreshold: 1, stringArrayEncoding: ['base64', 'rc4'], deadCodeInjection: true, deadCodeInjectionThreshold: 0.4, controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.75, splitStrings: true, numbersToExpressions: true };
    return { compact: true, stringArray: true, stringArrayRotate: true, stringArrayShuffle: true, stringArrayThreshold: 0.75, stringArrayEncoding: ['base64'], controlFlowFlattening: false, deadCodeInjection: false };
  }
  async function obfuscateJS(code, preset) {
    var O = await ensureObfuscator();
    try { return O.obfuscate(code, obfPreset(preset || 'medium')).getObfuscatedCode(); }
    catch (e) { throw new Error('JS obfuscation failed: ' + ((e && e.message) || e)); }
  }

  // =====================================================================
  // JSON / XML trivial transforms + XML beautify
  // =====================================================================
  function minifyJSON(s) { try { return JSON.stringify(JSON.parse(s)); } catch (e) { throw new Error('Invalid JSON: ' + e.message); } }
  function beautifyJSON(s) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { throw new Error('Invalid JSON: ' + e.message); } }
  function minifyXML(s) { return s.replace(/>\s+</g, '><').replace(/^\s+|\s+$/g, ''); }
  function repeat(s, n) { var r = ''; while (n-- > 0) r += s; return r; }
  function beautifyXML(xml, pad) {
    pad = pad || '  ';
    xml = xml.replace(/>\s+</g, '><').trim();
    var out = '', depth = 0, tokens = xml.match(/<[^>]+>|[^<]+/g) || [];
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i];
      if (tk[0] === '<') {
        var isMeta = /^<\?/.test(tk) || /^<!/.test(tk);
        var isClose = /^<\//.test(tk);
        var isSelf = /\/>$/.test(tk) || isMeta;
        if (isClose) depth = Math.max(0, depth - 1);
        out += repeat(pad, depth) + tk + '\n';
        if (!isClose && !isSelf) depth++;
      } else {
        var txt = tk.trim();
        if (txt) out += repeat(pad, depth) + txt + '\n';
      }
    }
    return out.replace(/\n$/, '');
  }

  function beautyOpts() { return { indent_size: 2, space_in_empty_paren: true, preserve_newlines: true, max_preserve_newlines: 2, end_with_newline: false }; }

  // =====================================================================
  // transform dispatch
  // =====================================================================
  async function transform(op, lang, input, opts) {
    if (op === 'minify') {
      if (lang === 'css') return minifyCSS(input);
      if (lang === 'html') return await minifyHTML(input);
      if (lang === 'python') return minifyPython(input);
      if (lang === 'json') return minifyJSON(input);
      if (lang === 'xml') return minifyXML(input);
      return await minifyJS(input);
    }
    if (op === 'obfuscate') {
      if (lang === 'python') return await obfuscatePython(input);
      if (lang === 'html') return obfuscateHTML(input);
      if (lang === 'css') return obfuscateCSS(input);
      if (lang === 'json') return minifyJSON(input);
      if (lang === 'xml') return minifyXML(input);
      return await obfuscateJS(input, opts && opts.preset);
    }
    if (op === 'beautify') {
      if (lang === 'css') return (await ensureBeautify()).css(input, beautyOpts());
      if (lang === 'html') return (await ensureBeautify()).html(input, beautyOpts());
      if (lang === 'json') return beautifyJSON(input);
      if (lang === 'xml') return beautifyXML(input, '  ');
      if (lang === 'python') throw new Error('Beautify does not support Python (try Minify Python)');
      return (await ensureBeautify()).js(input, beautyOpts());
    }
    throw new Error('Unknown operation: ' + op);
  }

  // =====================================================================
  // Input range detection: selection -> fenced block around cursor -> doc
  // =====================================================================
  function detectRange() {
    var ed = window.Cade.editor, state = ed.state, sel = state.selection.main, doc = state.doc;
    if (sel.from !== sel.to) {
      return { ed: ed, from: sel.from, to: sel.to, text: state.sliceDoc(sel.from, sel.to), fenced: false, info: null, scope: 'selection' };
    }
    var cursorLine = doc.lineAt(sel.head).number, nLines = doc.lines;
    var fenceRe = /^(\s*)(\u0060{3,}|~{3,})(.*)$/; // ``` or ~~~ fences
    var blocks = [], inFence = false, open = -1, marker = '', len = 0, info = null;
    for (var ln = 1; ln <= nLines; ln++) {
      var txt = doc.line(ln).text, mm = txt.match(fenceRe);
      if (!inFence) {
        if (mm) { inFence = true; open = ln; marker = mm[2][0]; len = mm[2].length; info = mm[3].trim(); }
      } else if (mm && mm[2][0] === marker && mm[2].length >= len && mm[3].trim() === '') {
        blocks.push({ open: open, close: ln, info: info }); inFence = false;
      }
    }
    if (inFence) blocks.push({ open: open, close: nLines + 1, info: info }); // unclosed -> EOF
    for (var b = 0; b < blocks.length; b++) {
      var blk = blocks[b];
      if (cursorLine >= blk.open && cursorLine <= blk.close) {
        var fromLine = blk.open + 1, toLine = Math.min(blk.close - 1, nLines);
        if (fromLine > toLine) {
          var p = doc.line(Math.min(blk.open, nLines)).to;
          return { ed: ed, from: p, to: p, text: '', fenced: true, info: blk.info || null, scope: 'fence' };
        }
        var from = doc.line(fromLine).from, to = doc.line(toLine).to;
        return { ed: ed, from: from, to: to, text: state.sliceDoc(from, to), fenced: true, info: blk.info || null, scope: 'fence' };
      }
    }
    return { ed: ed, from: 0, to: doc.length, text: doc.toString(), fenced: false, info: null, scope: 'doc' };
  }

  var LANG_MAP = { js: 'js', javascript: 'js', css: 'css', html: 'html', py: 'python', python: 'python', json: 'json', xml: 'xml' };

  // =====================================================================
  // Public entry: run(ctx, op, langArg, opts)
  // =====================================================================
  async function run(ctx, op, langArg, opts) {
    var R = detectRange();
    var input = R.text;
    if (!input || !input.trim()) { toast('Nothing to ' + op, 'error'); return; }

    var lang = langArg;
    if (lang === 'auto') {
      var fromInfo = R.fenced ? resolveLangFromInfo(R.info) : null;
      if (fromInfo) lang = fromInfo;
      else {
        var d = detectLang(input);
        lang = d.lang;
        if (!d.sure) {
          var ans = window.prompt('Detected ' + labelOf(lang) + '. Language to ' + op + '? (js, css, html, python, json, xml)', lang);
          if (ans === null) return;
          lang = LANG_MAP[ans.trim().toLowerCase()] || lang;
        }
      }
    }

    if (R.ed.state.readOnly) { toast('Editor is read-only', 'error'); return; }

    var output;
    try { output = await transform(op, lang, input, opts); }
    catch (e) { toast((e && e.message) ? e.message : ('Could not ' + op + ' ' + lang), 'error', 6000); return; }
    if (typeof output !== 'string') { toast('Nothing produced', 'error'); return; }

    // doc may have shifted during awaits (lib load / prompt / sync); clamp to live length
    var live = window.Cade.editor, len2 = live.state.doc.length;
    var from = Math.min(R.from, len2), to = Math.min(R.to, len2);
    if (live.state.readOnly) { toast('Editor is read-only', 'error'); return; }
    live.dispatch({ changes: { from: from, to: to, insert: output }, userEvent: 'input' });

    var inB = enc(input), outB = enc(output);
    toast(capitalize(op) + ' ' + labelOf(lang) + ': ' + fmtSize(inB) + ' -> ' + fmtSize(outB) + ' (' + fmtDelta(inB, outB) + ')', 'success', 3200);
  }

  window.__CADE_CODEPACK__ = {
    run: run,
    _detectLang: detectLang,
    _resolveLangFromInfo: resolveLangFromInfo,
    _minifyCSS: minifyCSS,
    _obfuscateCSS: obfuscateCSS,
    _minifyHTML: minifyHTML,
    _obfuscateHTML: obfuscateHTML,
    _minifyPython: minifyPython,
    _obfuscatePython: obfuscatePython,
    _minifyJSON: minifyJSON,
    _beautifyJSON: beautifyJSON,
    _minifyXML: minifyXML,
    _beautifyXML: beautifyXML,
    _deflateB64: deflateB64,
    _utf8ToB64: utf8ToB64
  };
})();
