/* Code Pack - Unobfuscate. Loaded lazily by pack-code-lib.js the first time
   "Unobfuscate Code" runs; sets window.__CADE_UNOBF__.

   Undoes what the Code Pack's own "Obfuscate" scripts do (and, for JS, most
   output of javascript-obfuscator in general):

   - HTML  base64 + document.write loader  -> the exact original page.
   - Python zlib/base64 exec loader        -> the (minified) code, re-indented
                                              to 4 spaces. Comments/docstrings
                                              were dropped when it was made.
   - CSS   hex-escaped class/id names and strings -> readable, then formatted.
   - JS    string table + decoder (base64 / rc4, rotated, shuffled): the
           decoder is run in an opaque-origin sandboxed iframe (no access to
           the app, its storage or the note), with every loop given an
           iteration budget, since Safari runs frames on the page's thread
           and a runaway loop could otherwise freeze the app. Its answers are
           put back as plain strings. Then proxy objects are inlined,
           constant expressions folded, injected dead branches removed,
           control-flow flattening (switch-in-a-loop) unrolled, comma /
           ternary statements split back into statements, and _0x… names
           renamed to v1 / fn1 / arg1…. Original local names and comments
           are not recoverable: the obfuscator never kept them.

   The JS parser (acorn) and printer (astring) load from jsDelivr only when a
   JS unobfuscate runs. Pure parts are exposed with a leading _ for node
   checks (deobfuscateJS takes an injectable sandbox runner). */
(function (root) {
  'use strict';
  if (root.__CADE_UNOBF__) return;

  var CDN = {
    acorn: 'https://cdn.jsdelivr.net/npm/acorn@8.14.0/dist/acorn.min.js',   // global acorn.parse()
    astring: 'https://cdn.jsdelivr.net/npm/astring@1.9.0/dist/astring.min.js' // global astring.generate()
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
  function ensureDeps() {
    var a = root.acorn && root.acorn.parse ? Promise.resolve() : loadScript(CDN.acorn);
    var b = root.astring && root.astring.generate ? Promise.resolve() : loadScript(CDN.astring);
    return Promise.all([a, b]).then(function () {
      if (!root.acorn || !root.acorn.parse || !root.astring || !root.astring.generate) throw new Error('JavaScript parser failed to load');
      return { acorn: root.acorn, astring: root.astring };
    });
  }

  // =====================================================================
  // Detection
  // =====================================================================
  var RE_PY = /exec\s*\(\s*(?:zlib\s*\.\s*decompress\s*\(\s*)?base64\s*\.\s*b64decode\s*\(/;
  var RE_HTML = /document\s*\.\s*write\s*\(\s*(?:decodeURIComponent\s*\(\s*escape\s*\(\s*)?(?:atob|unescape)\s*\(/;
  var RE_CSS_MARK = /Obfuscated by Cade\.txt Code Pack - class\/id names/;
  var RE_JS_OBF = /\b_0x[0-9a-f]{4,}\b/;
  // -> { lang, sure }
  function detect(s) {
    if (RE_PY.test(s)) return { lang: 'python', sure: true };
    if (RE_HTML.test(s)) return { lang: 'html', sure: true };
    if (RE_CSS_MARK.test(s)) return { lang: 'css', sure: true };
    if (RE_JS_OBF.test(s)) return { lang: 'js', sure: true };
    if (/\\[0-9a-fA-F]{2,6} /.test(s) && /[.#][^{]*\{[^}]*:/.test(s) && !/\bfunction\b|=>/.test(s)) return { lang: 'css', sure: false };
    return null;
  }

  // =====================================================================
  // HTML
  // =====================================================================
  function b64ToUtf8(b64) {
    var bin = atob(b64.replace(/\s+/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  var RE_HTML_LOADER = /<script[^>]*>\s*document\s*\.\s*write\s*\(\s*(decodeURIComponent\s*\(\s*escape\s*\(\s*)?(atob|unescape)\s*\(\s*(["'])([^"']*)\3\s*\)\s*(?:\)\s*\)\s*)?\)\s*;?\s*<\/script>/i;
  function unobfuscateHTML(src) {
    var out = src, layers = 0, m;
    while ((m = RE_HTML_LOADER.exec(out)) && layers < 10) {
      var payload = m[2] === 'atob' ? b64ToUtf8(m[4]) : decodeURIComponent(m[4]);
      out = out.slice(0, m.index) + payload + out.slice(m.index + m[0].length);
      layers++;
    }
    if (!layers) throw new Error('No base64 / document.write loader found — nothing to undo');
    out = out.replace(/<!-- Obfuscated by Cade\.txt Code Pack\.[\s\S]*?-->/g, '');
    return { code: out, note: 'Unobfuscated HTML: decoded ' + layers + ' loader' + (layers > 1 ? 's' : '') + ' — exact original restored' };
  }

  // =====================================================================
  // Python
  // =====================================================================
  function b64ToBytes(b64) {
    var bin = atob(b64.replace(/\s+/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('This browser can’t decompress zlib (needs iOS 16.4+ / a recent browser)'));
    var ds = new DecompressionStream('deflate'), w = ds.writable.getWriter();
    w.write(bytes); w.close();
    return new Response(ds.readable).arrayBuffer().then(function (buf) { return new TextDecoder('utf-8').decode(buf); });
  }
  // Python string literal body ('…' / "…") -> its value (escapes the encoder can emit).
  function pyStrVal(body) {
    return body.replace(/\\(x[0-9a-fA-F]{2}|n|r|t|\\|'|"|\n)/g, function (m, e) {
      if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
      return { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"', '\n': '' }[e];
    });
  }
  var RE_PY_LOADER = /(?:^|\n)[ \t]*(?:import[^\n]*\n[ \t]*|import[^;\n]*;\s*)?exec\s*\(\s*(zlib\s*\.\s*decompress\s*\(\s*)?base64\s*\.\s*b64decode\s*\(\s*[bB]?(['"])((?:\\.|(?!\2).)*)\2\s*\)\s*(?:\)\s*)?(?:\.\s*decode\s*\([^)]*\)\s*)?\)\s*;?[ \t]*(?=\n|$)/;
  // Re-indent: logical-line indents are scaled from the source's unit (1 space
  // for Code Pack output) to 4 spaces; lines inside triple-quoted strings are
  // left exactly as they are.
  function reindentPython(src) {
    var lines = src.split('\n'), inTriple = null, starts = [], i, unit = 0;
    function scan(line) {           // updates inTriple across one physical line
      var j = 0;
      while (j < line.length) {
        if (inTriple) {
          var k = line.indexOf(inTriple, j);
          if (k < 0) return;
          var bs = 0, b = k - 1; while (b >= 0 && line[b] === '\\') { bs++; b--; }
          j = k + 3; if (bs % 2 === 0) inTriple = null;
          continue;
        }
        var c = line[j];
        if (c === '#') return;
        if (c === '"' || c === "'") {
          if (line.substr(j, 3) === c + c + c) { inTriple = c + c + c; j += 3; continue; }
          j++;
          while (j < line.length && line[j] !== c) { if (line[j] === '\\') j++; j++; }
          j++; continue;
        }
        j++;
      }
    }
    for (i = 0; i < lines.length; i++) { starts.push(!inTriple); scan(lines[i]); }
    var gcd = function (a, b) { return b ? gcd(b, a % b) : a; };
    for (i = 0; i < lines.length; i++) {
      if (!starts[i] || !lines[i].trim()) continue;
      var w = /^ */.exec(lines[i])[0].length;
      if (w) unit = unit ? gcd(unit, w) : w;
    }
    if (!unit || unit >= 4) return src;
    var k2 = 4 / unit;
    for (i = 0; i < lines.length; i++) {
      if (!starts[i]) continue;
      var lead = /^ */.exec(lines[i])[0].length;
      if (lead) lines[i] = new Array(lead * k2 + 1).join(' ') + lines[i].slice(lead);
    }
    return lines.join('\n');
  }
  function unobfuscatePython(src) {
    var out = src.replace(/\r\n?/g, '\n'), layers = 0;
    function step() {
      var m = RE_PY_LOADER.exec(out);
      if (!m || layers >= 10) return Promise.resolve();
      var bytes = b64ToBytes(pyStrVal(m[3]));
      var p = m[1] ? inflate(bytes) : Promise.resolve(new TextDecoder('utf-8').decode(bytes));
      return p.then(function (code) {
        var lead = m[0].charAt(0) === '\n' ? '\n' : '';
        out = out.slice(0, m.index) + lead + code + out.slice(m.index + m[0].length);
        layers++;
        return step();
      });
    }
    return step().then(function () {
      if (!layers) throw new Error('No base64 / zlib exec loader found — nothing to undo');
      out = out.replace(/^# Obfuscated by Cade\.txt Code Pack[^\n]*\n?/m, '').replace(/^\n+/, '');
      return { code: reindentPython(out), note: 'Unobfuscated Python: decoded ' + layers + ' loader' + (layers > 1 ? 's' : '') + ', re-indented (comments & docstrings were removed when it was made)' };
    });
  }

  // =====================================================================
  // CSS
  // =====================================================================
  // Turn \XX escapes back into characters wherever the plain character is
  // equally valid there; escapes the original author needed (a leading
  // digit, ":" in a class name, a quote inside a string…) stay escaped.
  function unescapeCSS(css) {
    var out = '', i = 0, n = css.length, quote = null, count = 0;
    while (i < n) {
      var c = css[i];
      if (!quote && c === '/' && css[i + 1] === '*') {
        var e = css.indexOf('*/', i + 2); e = e < 0 ? n : e + 2;
        out += css.slice(i, e); i = e; continue;
      }
      if (c === '\\') {
        var m = /^\\([0-9a-fA-F]{1,6})(\r\n|[ \t\n\r\f])?/.exec(css.slice(i, i + 8));
        if (m) {
          var cp = parseInt(m[1], 16), ch = cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : null, ok = false;
          if (ch) {
            if (quote) ok = ch !== quote && ch !== '\\' && cp >= 0x20 && cp !== 0x7F;
            else {
              var p = out.charAt(out.length - 1), pp = out.charAt(out.length - 2);
              var atStart = p === '.' || p === '#' || (p === '-' && (pp === '.' || pp === '#'));
              ok = /[A-Za-z_\-]/.test(ch) || cp > 0x7F || (/[0-9]/.test(ch) && !atStart);
              if (ch === '-' && (p === '.' || p === '#') && /^\\(2d|2D)[ ]?(?:[0-9]|\\3[0-9])/.test(css.slice(i, i + 9))) ok = false;
            }
          }
          if (ok) { out += ch; count++; i += m[0].length; continue; }
          out += m[0]; i += m[0].length; continue;
        }
        out += css.substr(i, 2); i += 2; continue;
      }
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      out += c; i++;
    }
    return { css: out, count: count };
  }
  function unobfuscateCSS(src, beautify) {
    var r = unescapeCSS(src.replace(/\/\*! Obfuscated by Cade\.txt Code Pack[\s\S]*?\*\//, ''));
    if (!r.count) throw new Error('No CSS hex escapes found — nothing to undo');
    return Promise.resolve(beautify ? beautify(r.css) : r.css).then(function (css) {
      return { code: css, note: 'Unobfuscated CSS: ' + r.count + ' escaped characters restored and formatted (comments were removed when it was made)' };
    });
  }

  // =====================================================================
  // JavaScript
  // =====================================================================
  var SKIP = { type: 1, start: 1, end: 1, loc: 1, range: 1, raw: 1, regex: 1, bigint: 1 };
  function isNode(x) { return x && typeof x.type === 'string'; }
  // Visit every node (pre-order). fn(node, parent, key, index) may return false to skip children.
  function each(node, fn, parent, key, idx) {
    if (fn(node, parent, key, idx) === false) return;
    for (var k in node) {
      if (SKIP[k] || !node.hasOwnProperty(k)) continue;
      var v = node[k];
      if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) if (isNode(v[i])) each(v[i], fn, node, k, i); }
      else if (isNode(v)) each(v, fn, node, k, null);
    }
  }
  // Post-order rewrite: fn(node, parent, key) returns a replacement node (or
  // undefined to keep). Inside statement arrays, it may return an array to splice.
  function rewrite(node, fn, parent, key) {
    for (var k in node) {
      if (SKIP[k] || !node.hasOwnProperty(k)) continue;
      var v = node[k];
      if (Array.isArray(v)) {
        var out = [];
        for (var i = 0; i < v.length; i++) {
          if (!isNode(v[i])) { out.push(v[i]); continue; }
          var r = rewrite(v[i], fn, node, k);
          if (Array.isArray(r)) Array.prototype.push.apply(out, r);
          else if (r !== null) out.push(r);
        }
        node[k] = out;
      } else if (isNode(v)) {
        var r2 = rewrite(v, fn, node, k);
        if (r2 && !Array.isArray(r2)) node[k] = r2;
      }
    }
    var rep = fn(node, parent, key);
    return rep === undefined ? node : rep;
  }
  function clone(n) { return JSON.parse(JSON.stringify(n)); }
  function lit(v) {
    if (v === undefined) return { type: 'Identifier', name: 'undefined' };
    if (typeof v === 'number' && (v < 0 || (v === 0 && 1 / v < 0))) return { type: 'UnaryExpression', operator: '-', prefix: true, argument: lit(-v) };
    if (typeof v === 'number' && !isFinite(v)) return isNaN(v) ? { type: 'Identifier', name: 'NaN' } : { type: 'Identifier', name: 'Infinity' };
    return { type: 'Literal', value: v };
  }
  var NONE = {};
  // Constant value of an expression, or NONE.
  function cval(n, look) {
    if (!n) return NONE;
    switch (n.type) {
      case 'Literal': return n.regex || n.bigint != null ? NONE : n.value;
      case 'Identifier': {
        if (look) { var lv = look(n); if (lv !== NONE) return lv; }
        return n.name === 'undefined' ? undefined : n.name === 'NaN' ? NaN : n.name === 'Infinity' ? Infinity : NONE;
      }
      case 'UnaryExpression': {
        if (n.operator === '!' && n.argument.type === 'ArrayExpression' && !n.argument.elements.length) return false; // ![]
        if (n.operator === 'void') { var va = cval(n.argument, look); return va === NONE ? NONE : undefined; }
        var a = cval(n.argument, look);
        if (a === NONE) return NONE;
        switch (n.operator) {
          case '-': return typeof a === 'number' ? -a : NONE;
          case '+': return typeof a === 'number' ? a : NONE;
          case '!': return !a;
          case '~': return typeof a === 'number' ? ~a : NONE;
          case 'typeof': return a === null ? 'object' : typeof a;
        }
        return NONE;
      }
      case 'BinaryExpression': {
        var l = cval(n.left, look); if (l === NONE) return NONE;
        var r = cval(n.right, look); if (r === NONE) return NONE;
        var ok = function (x) { return x === null || x === undefined || typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean'; };
        if (!ok(l) || !ok(r)) return NONE;
        switch (n.operator) {
          case '+': return l + r; case '-': return l - r; case '*': return l * r; case '/': return l / r; case '%': return l % r;
          case '**': return Math.pow(l, r);
          case '===': return l === r; case '!==': return l !== r; case '==': return l == r; case '!=': return l != r; // eslint-disable-line eqeqeq
          case '<': return l < r; case '>': return l > r; case '<=': return l <= r; case '>=': return l >= r;
          case '&': return l & r; case '|': return l | r; case '^': return l ^ r;
          case '<<': return l << r; case '>>': return l >> r; case '>>>': return l >>> r;
        }
        return NONE;
      }
      case 'LogicalExpression': {
        var L = cval(n.left, look), R = cval(n.right, look);
        if (L === NONE || R === NONE) return NONE;
        return n.operator === '&&' ? (L && R) : n.operator === '||' ? (L || R) : (L != null ? L : R);
      }
    }
    return NONE;
  }
  function truthy(n) {                     // true / false / null (unknown); `![]` style and literals
    if (n.type === 'ArrayExpression' || n.type === 'ObjectExpression' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') return true;
    if (n.type === 'UnaryExpression' && n.operator === '!') { var t = truthy(n.argument); return t === null ? null : !t; }
    var v = cval(n);
    return v === NONE ? null : !!v;
  }
  var ID_RE = /^[A-Za-z_$][\w$]*$/;
  function propName(n, computed) {          // constant property name of a key, or null
    if (!computed && n.type === 'Identifier') return n.name;
    var v = cval(n);
    return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
  }

  // ---- scopes: which declaration each identifier refers to ----
  // The obfuscator reuses _0x… names in different scopes, so anything that
  // follows a name (decoder aliases, proxy objects) goes by binding, not by
  // name. analyze(ast) -> Map(Identifier node -> binding) for declarations
  // and references alike (one binding object per declared name per scope).
  function isRefPos(par, key) {
    if (!par) return true;
    if (par.type === 'MemberExpression' && key === 'property' && !par.computed) return false;
    if ((par.type === 'Property' || par.type === 'MethodDefinition' || par.type === 'PropertyDefinition') && key === 'key' && !par.computed) return false;
    if ((par.type === 'LabeledStatement' || par.type === 'BreakStatement' || par.type === 'ContinueStatement') && key === 'label') return false;
    if (par.type === 'MetaProperty') return false;
    if ((par.type === 'ExportSpecifier' && key === 'exported') || (par.type === 'ImportSpecifier' && key === 'imported')) return false;
    return true;
  }
  function patternIds(p, out) {
    out = out || [];
    if (!p) return out;
    if (p.type === 'Identifier') out.push(p);
    else if (p.type === 'AssignmentPattern') patternIds(p.left, out);
    else if (p.type === 'RestElement') patternIds(p.argument, out);
    else if (p.type === 'ArrayPattern') p.elements.forEach(function (e) { patternIds(e, out); });
    else if (p.type === 'ObjectPattern') p.properties.forEach(function (q) { patternIds(q.type === 'RestElement' ? q.argument : q.value, out); });
    return out;
  }
  function kids(node, fn) {
    for (var k in node) {
      if (SKIP[k] || !node.hasOwnProperty(k)) continue;
      var v = node[k];
      if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) if (isNode(v[i])) fn(v[i], k); }
      else if (isNode(v)) fn(v, k);
    }
  }
  function analyze(ast) {
    var map = new Map(), scopeOf = new Map();
    function Scope(parent, fn) { this.parent = parent; this.fn = fn; this.vars = Object.create(null); }
    function fnScope(s) { while (!s.fn) s = s.parent; return s; }
    function declare(scope, id, kind, decl) {
      var b = scope.vars[id.name] || (scope.vars[id.name] = { name: id.name, kind: kind, decl: decl });
      map.set(id, b);
    }
    function decl(node, scope, par, key) {
      var s = scope;
      switch (node.type) {
        case 'Program': s = new Scope(null, true); break;
        case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
          if (node.type === 'FunctionDeclaration' && node.id) declare(scope, node.id, 'fn', node);
          s = new Scope(scope, true);
          if (node.type === 'FunctionExpression' && node.id) declare(s, node.id, 'fn', node);
          node.params.forEach(function (p) { patternIds(p).forEach(function (id) { declare(s, id, 'param', node); }); });
          break;
        case 'ClassDeclaration': if (node.id) declare(scope, node.id, 'class', node); break;
        case 'ClassExpression': if (node.id) { s = new Scope(scope, false); declare(s, node.id, 'class', node); } break;
        case 'BlockStatement': if (!(par && /Function/.test(par.type) && key === 'body')) s = new Scope(scope, false); break;
        case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': case 'SwitchStatement': case 'StaticBlock': s = new Scope(scope, false); break;
        case 'CatchClause': s = new Scope(scope, false); patternIds(node.param).forEach(function (id) { declare(s, id, 'catch', node); }); break;
        case 'VariableDeclaration': {
          var target = node.kind === 'var' ? fnScope(scope) : scope;
          node.declarations.forEach(function (d) { patternIds(d.id).forEach(function (id) { declare(target, id, node.kind, d); }); });
          break;
        }
        case 'ImportDeclaration': node.specifiers.forEach(function (sp) { declare(scope, sp.local, 'import', node); }); break;
      }
      if (s !== scope) scopeOf.set(node, s);
      kids(node, function (c, k) { decl(c, s, node, k); });
    }
    function ref(node, scope, par, key) {
      if (node.type === 'Identifier') {
        if (!map.has(node) && isRefPos(par, key)) {
          for (var sc = scope; sc; sc = sc.parent) { var b = sc.vars[node.name]; if (b) { map.set(node, b); break; } }
        }
        return;
      }
      var s = scopeOf.get(node) || scope;
      kids(node, function (c, k) { ref(c, s, node, k); });
    }
    decl(ast, null, null, null);
    ref(ast, null, null, null);
    return map;
  }

  // ---- string table machinery ----
  function isStringArrayFn(st) {
    if (st.type !== 'FunctionDeclaration' || st.params.length) return false;
    var big = null;
    each(st.body, function (n) {
      if (n.type === 'ArrayExpression' && n.elements.length >= 3) {
        var s = 0; for (var i = 0; i < n.elements.length; i++) if (n.elements[i] && n.elements[i].type === 'Literal' && typeof n.elements[i].value === 'string') s++;
        if (s / n.elements.length >= 0.9) big = n;
      }
    });
    return !!big;
  }
  function isStringArrayVar(st) {
    if (st.type !== 'VariableDeclaration' || st.declarations.length !== 1) return false;
    var d = st.declarations[0];
    if (d.id.type !== 'Identifier' || !d.init || d.init.type !== 'ArrayExpression' || d.init.elements.length < 3) return false;
    return d.init.elements.every(function (e) { return e && e.type === 'Literal' && typeof e.value === 'string'; });
  }
  function fnNameOf(st) {
    if (st.type === 'FunctionDeclaration') return st.id.name;
    if (st.type === 'VariableDeclaration' && st.declarations.length === 1 && st.declarations[0].id.type === 'Identifier' &&
      st.declarations[0].init && /Function/.test(st.declarations[0].init.type)) return st.declarations[0].id.name;
    return null;
  }
  // Statement that is an immediately-invoked function (optionally !/void prefixed, or in a sequence).
  function iifeOf(st) {
    if (st.type !== 'ExpressionStatement') return null;
    var e = st.expression;
    if (e.type === 'UnaryExpression') e = e.argument;
    if (e.type === 'SequenceExpression') e = e.expressions[0];
    if (e.type === 'CallExpression' && /Function/.test(e.callee.type)) return e;
    return null;
  }

  // Wrap every loop body in an iteration budget for the sandbox.
  function guardLoops(ast, acorn) {
    var guard = acorn.parse('if(++__cadeG>5e6)throw new Error("loop budget exceeded");', { ecmaVersion: 'latest' }).body[0];
    each(ast, function (n) {
      if (/^(While|DoWhile|For|ForIn|ForOf)Statement$/.test(n.type)) {
        var b = n.body;
        n.body = { type: 'BlockStatement', body: [clone(guard)].concat(b.type === 'BlockStatement' ? b.body : [b]) };
      }
    });
  }

  // The browser sandbox: an opaque-origin iframe that runs the decoder code
  // and answers the calls. Removed afterwards (and on timeout).
  function sandboxRun(code, calls) {
    return new Promise(function (resolve, reject) {
      var token = 'uo' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      var ifr = document.createElement('iframe');
      ifr.setAttribute('sandbox', 'allow-scripts');   // NOT allow-same-origin: opaque origin, no app access
      ifr.setAttribute('aria-hidden', 'true');
      ifr.setAttribute('tabindex', '-1');
      ifr.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px;top:0;visibility:hidden';
      var done = false, t = 0;
      function end(err, res) {
        if (done) return;
        done = true; clearTimeout(t);
        window.removeEventListener('message', onMsg);
        try { ifr.remove(); } catch (e) {}
        if (err) reject(err); else resolve(res);
      }
      function onMsg(e) {
        if (e.source !== ifr.contentWindow || !e.data || e.data.t !== token) return;
        if (e.data.ready) { try { ifr.contentWindow.postMessage({ t: token, code: code, calls: calls }, '*'); } catch (x) { end(x); } return; }
        if (e.data.error) end(new Error('Decoder failed in the sandbox: ' + e.data.error));
        else end(null, e.data.results || []);
      }
      window.addEventListener('message', onMsg);
      t = setTimeout(function () { end(new Error('The decoder didn’t answer (timed out)')); }, 15000);
      var T = JSON.stringify(token);
      ifr.srcdoc = '<!doctype html><meta charset="utf-8"><script>(function(){var T=' + T + ';' +
        'addEventListener("message",function(e){var d=e.data;if(!d||d.t!==T||!d.code)return;var out=[],err=null;' +
        'try{var F=(new Function(d.code))();for(var i=0;i<d.calls.length;i++){var c=d.calls[i],r=null;' +
        'try{var f=F[c[0]];r=typeof f==="function"?f.apply(null,c[1]):null;}catch(x){r=null;}out.push(typeof r==="string"?r:null);}}' +
        'catch(x){err=String(x&&x.message||x);}parent.postMessage({t:T,results:out,error:err},"*");});' +
        'parent.postMessage({t:T,ready:1},"*");})();<\/script>';
      (document.body || document.documentElement).appendChild(ifr);
    });
  }

  function jsStr(s) {
    return "'" + s.replace(/[\\'\n\r\t\u2028\u2029\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, function (c) {
      return { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\t': '\\t' }[c] || '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
    }) + "'";
  }

  // deobfuscateJS(src, {acorn, astring}, runner) -> Promise<{code, stats}>
  function deobfuscateJS(src, deps, runner) {
    var acorn = deps.acorn, astring = deps.astring, ast;
    var opts = { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true, allowImportExportEverywhere: true };
    try { ast = acorn.parse(src, Object.assign({ sourceType: 'script' }, opts)); }
    catch (e1) {
      try { ast = acorn.parse(src, Object.assign({ sourceType: 'module' }, opts)); }
      catch (e2) { return Promise.reject(new Error('Not valid JavaScript: ' + e1.message)); }
    }
    var stats = { strings: 0, proxies: 0, folded: 0, dead: 0, flattened: 0, renamed: 0 };
    var body = ast.body;

    var B = analyze(ast);
    function bind(id) { return id && B.get(id); }
    function refsBinding(node, b) {
      var hit = false;
      each(node, function (n) { if (hit) return false; if (n.type === 'Identifier' && B.get(n) === b) hit = true; });
      return hit;
    }

    // 1. find the string table, its rotation and decoders (top level)
    var arrB = [], arrIdx = [], i;
    for (i = 0; i < body.length; i++) {
      if (isStringArrayFn(body[i])) { arrB.push(bind(body[i].id)); arrIdx.push(i); }
      else if (isStringArrayVar(body[i])) { arrB.push(bind(body[i].declarations[0].id)); arrIdx.push(i); }
    }
    var decIdx = [], rotIdx = [], family = new Map(), rootNames = [];
    if (arrB.length) {
      for (i = 0; i < body.length; i++) {
        if (arrIdx.indexOf(i) >= 0) continue;
        var fname = fnNameOf(body[i]);
        if (fname && arrB.some(function (ab) { return refsBinding(body[i], ab); })) {
          var fid = body[i].type === 'FunctionDeclaration' ? body[i].id : body[i].declarations[0].id;
          decIdx.push(i); family.set(bind(fid), { root: true }); rootNames.push(fname);
          continue;
        }
        var call = iifeOf(body[i]);
        if (call && call.arguments.some(function (a) { return a.type === 'Identifier' && arrB.indexOf(B.get(a)) >= 0; })) rotIdx.push(i);
      }
    }

    // Plain code: leave it alone (re-printing would only lose its comments).
    if (!decIdx.length && !RE_JS_OBF.test(src)) {
      return Promise.reject(new Error('No obfuscation found — nothing to undo (Beautify Code formats plain JavaScript)'));
    }

    var decode = Promise.resolve();
    if (decIdx.length) {
      // 2. aliases (const x = decoder) and thin wrapper functions, to a fixpoint
      var grew = true, aliasDecls = new Set(), wrapperDecls = new Set();
      while (grew) {
        grew = false;
        each(ast, function (n) {
          if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && n.init.type === 'Identifier' && family.has(B.get(n.init)) && !family.has(B.get(n.id))) {
            family.set(B.get(n.id), { alias: B.get(n.init) }); aliasDecls.add(n); grew = true;
          } else if (n.type === 'FunctionDeclaration' && n.id && !family.has(B.get(n.id)) && n.body.body.length === 1 && n.body.body[0].type === 'ReturnStatement') {
            var ra = n.body.body[0].argument;
            if (ra && ra.type === 'CallExpression' && ra.callee.type === 'Identifier' && family.has(B.get(ra.callee))) {
              family.set(B.get(n.id), { wrapper: n }); wrapperDecls.add(n); grew = true;
            }
          }
        });
      }
      // a call through aliases / wrappers -> [decoder name, constant args]
      var resolveCall = function (b, args, depth) {
        var f = family.get(b);
        if (!f || depth > 20) return null;
        if (f.root) return [b.name, args];
        if (f.alias) return resolveCall(f.alias, args, depth + 1);
        var W = f.wrapper, inner = W.body.body[0].argument, pv = new Map();
        W.params.forEach(function (p, k) { if (p.type === 'Identifier') pv.set(B.get(p), args[k]); });
        var look = function (id) { var bb = B.get(id); return bb && pv.has(bb) ? pv.get(bb) : NONE; };
        var inArgs = [];
        for (var k = 0; k < inner.arguments.length; k++) {
          var v = cval(inner.arguments[k], look);
          if (v === NONE || (typeof v !== 'number' && typeof v !== 'string')) return null;
          inArgs.push(v);
        }
        return resolveCall(B.get(inner.callee), inArgs, depth + 1);
      };
      // 3. every call with constant arguments
      var calls = [], keyOf = {}, sites = [];
      each(ast, function (n) {
        if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || !family.has(B.get(n.callee))) return;
        var args = [];
        for (var k = 0; k < n.arguments.length; k++) { var v = cval(n.arguments[k]); if (v === NONE || (typeof v !== 'number' && typeof v !== 'string')) return; args.push(v); }
        var rc = resolveCall(B.get(n.callee), args, 0);
        if (!rc) return;
        var key = rc[0] + '\u0000' + JSON.stringify(rc[1]);
        if (!(key in keyOf)) { keyOf[key] = calls.length; calls.push(rc); }
        sites.push([n, keyOf[key]]);
      });
      // 4. sandbox program: table + decoders + rotation, loop-guarded; returns name -> decoder
      var pre = { type: 'Program', sourceType: 'script', body: [] };
      arrIdx.concat(decIdx, rotIdx).sort(function (x, y) { return x - y; }).forEach(function (k) { pre.body.push(clone(body[k])); });
      guardLoops(pre, acorn);
      var code = 'var __cadeG=0;' + astring.generate(pre) + '\nreturn {' + rootNames.map(function (nm) { return JSON.stringify(nm) + ':' + nm; }).join(',') + '};';
      decode = (calls.length ? runner(code, calls) : Promise.resolve([])).then(function (results) {
        for (var s = 0; s < sites.length; s++) {
          var r = results[sites[s][1]];
          if (typeof r !== 'string') continue;
          var nd = sites[s][0];
          for (var key2 in nd) if (nd.hasOwnProperty(key2)) delete nd[key2];
          nd.type = 'Literal'; nd.value = r;
          stats.strings++;
        }
        // Drop the machinery, but only when nothing else still uses it (every
        // call answered, no alias passed around): otherwise leave it working.
        var drop = {}, ext = false;
        arrIdx.concat(decIdx, rotIdx).forEach(function (k) { drop[k] = 1; });
        body.forEach(function (st, k) {
          if (drop[k] || ext) return;
          each(st, function (n) {
            if (ext) return false;
            if (wrapperDecls.has(n) || aliasDecls.has(n)) return false;
            if (n.type === 'Identifier') { var bb = B.get(n); if (bb && (family.has(bb) || arrB.indexOf(bb) >= 0)) ext = true; }
          });
        });
        if (!ext) {
          ast.body = body.filter(function (st, k) { return !drop[k]; });
          rewrite(ast, function (n) {
            if (wrapperDecls.has(n)) return null;
            if (n.type === 'VariableDeclaration') {
              n.declarations = n.declarations.filter(function (d) { return !aliasDecls.has(d); });
              if (!n.declarations.length) return null;
            }
          });
        }
      });
    }
    return decode.then(function () {
      simplifyAll(ast, stats);
      renameHex(ast, stats);
      var out = astring.generate(ast, { indent: '  ' });
      return { code: out, stats: stats };
    });
  }
  // ---- simplification passes ----
  function isStmtList(parent, key) {
    return parent && ((parent.type === 'Program' || parent.type === 'BlockStatement' || parent.type === 'StaticBlock') && key === 'body' || parent.type === 'SwitchCase' && key === 'consequent');
  }
  function hasLexical(stmts) {
    return stmts.some(function (s) { return s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration' || (s.type === 'VariableDeclaration' && s.kind !== 'var'); });
  }
  function unwrapBlock(b, parent, key) {
    if (!b) return null;
    if (b.type === 'BlockStatement' && isStmtList(parent, key) && !hasLexical(b.body)) return b.body;
    return b;
  }
  function exprStmt(e) { return { type: 'ExpressionStatement', expression: e }; }

  // Inline proxy objects: const o = {k: 'str', f: function(a, b) { return a + b; }}; o.k / o.f(x, y)
  // Only when every use of o is a constant-key read or call (never written,
  // never passed around), and each function's body uses nothing but its params.
  function inlineProxies(ast, stats) {
    var B = analyze(ast), cands = new Map();
    each(ast, function (n) {
      if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier' || !n.init || n.init.type !== 'ObjectExpression') return;
      var map = {}, ok = n.init.properties.length > 0;
      n.init.properties.forEach(function (p) {
        if (!ok) return;
        if (p.type !== 'Property' || p.kind !== 'init' || p.method || p.shorthand) { ok = false; return; }
        var k = propName(p.key, p.computed);
        if (k === null) { ok = false; return; }
        var v = p.value;
        if (v.type === 'Literal' && !v.regex) map[k] = { lit: v };
        else if (v.type === 'FunctionExpression' && !v.async && !v.generator && !v.id && v.params.every(function (q) { return q.type === 'Identifier'; }) &&
          v.body.body.length === 1 && v.body.body[0].type === 'ReturnStatement' && v.body.body[0].argument) {
          var pb = v.params.map(function (q) { return B.get(q); }), pure = true;
          each(v.body.body[0].argument, function (x, par, key) {
            if (x.type === 'ThisExpression' || /Function|Class/.test(x.type)) { pure = false; return false; }
            if (x.type === 'Identifier' && isRefPos(par, key) && pb.indexOf(B.get(x)) < 0) pure = false;
          });
          if (pure) map[k] = { fn: v, pb: pb }; else ok = false;
        } else ok = false;
      });
      if (ok) cands.set(B.get(n.id), { decl: n, map: map, refs: [] });
    });
    if (!cands.size) return 0;
    // every reference must be a constant-key read / call of a known key
    each(ast, function (n, par, key) {
      if (n.type !== 'Identifier') return;
      var c = cands.get(B.get(n));
      if (!c || (par && par.type === 'VariableDeclarator' && key === 'id' && par === c.decl)) return;
      var ok = par && par.type === 'MemberExpression' && key === 'object';
      if (ok) {
        var k = propName(par.property, par.computed);
        ok = k !== null && Object.prototype.hasOwnProperty.call(c.map, k);
      }
      if (!ok) c.bad = true;
    });
    var changed = 0;
    function subst(e, args) {
      var ret = clone(e.fn.body.body[0].argument), orig = e.fn.body.body[0].argument, ids = [], oids = [];
      each(orig, function (x, par, key) { if (x.type === 'Identifier' && isRefPos(par, key)) oids.push(B.get(x)); });
      each(ret, function (x, par, key) { if (x.type === 'Identifier' && isRefPos(par, key)) ids.push(x); });
      var at = new Map();
      ids.forEach(function (x, j) { at.set(x, e.pb.indexOf(oids[j])); });
      return rewrite({ type: 'ExpressionStatement', expression: ret }, function (x) {
        if (x.type === 'Identifier' && at.has(x)) { var j = at.get(x); return j >= 0 && args[j] ? clone(args[j]) : { type: 'Identifier', name: 'undefined' }; }
      }).expression;
    }
    function uses(e, j) { var c = 0; each(e.fn.body.body[0].argument, function (x, par, key) { if (x.type === 'Identifier' && isRefPos(par, key) && B.get(x) === e.pb[j]) c++; }); return c; }
    var simple = function (a) { return a.type === 'Identifier' || a.type === 'Literal' || a.type === 'ThisExpression'; };
    rewrite(ast, function (n, parent, key) {
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.type === 'Identifier') {
        var c = cands.get(B.get(n.callee.object));
        if (c && !c.bad) {
          var e = c.map[propName(n.callee.property, n.callee.computed)];
          if (e && e.fn && n.arguments.every(function (a) { return a.type !== 'SpreadElement'; }) &&
            e.pb.every(function (p, j) { return !n.arguments[j] || simple(n.arguments[j]) || uses(e, j) <= 1; })) { changed++; return subst(e, n.arguments); }
        }
      }
      if (n.type === 'MemberExpression' && n.object.type === 'Identifier' && !(parent && parent.type === 'CallExpression' && key === 'callee')) {
        var c2 = cands.get(B.get(n.object));
        if (c2 && !c2.bad) {
          var e2 = c2.map[propName(n.property, n.computed)];
          if (e2 && e2.lit) { changed++; return clone(e2.lit); }
        }
      }
    });
    // drop proxy objects nothing references any more
    var used = new Set();
    each(ast, function (n, par, key) {
      if (n.type === 'Identifier' && !(par && par.type === 'VariableDeclarator' && key === 'id')) { var bb = B.get(n); if (bb && cands.has(bb)) used.add(bb); }
    });
    rewrite(ast, function (n) {
      if (n.type === 'VariableDeclaration') {
        var before = n.declarations.length;
        n.declarations = n.declarations.filter(function (d) {
          var bb = d.id.type === 'Identifier' && B.get(d.id), c = bb && cands.get(bb);
          return !(c && c.decl === d && !c.bad && !used.has(bb));
        });
        stats.proxies += before - n.declarations.length;
        if (!n.declarations.length) return null;
      }
    });
    return changed;
  }

  // Control-flow flattening: var o = '2|0|1'.split('|'), i = 0; while (true) { switch (o[i++]) { case '0': …; continue; … } break; }
  function unflatten(ast, stats) {
    var changed = 0;
    function orderOf(init) {
      if (!init || init.type !== 'CallExpression' || init.callee.type !== 'MemberExpression') return null;
      if (propName(init.callee.property, init.callee.computed) !== 'split') return null;
      var s = cval(init.callee.object), sep = cval(init.arguments[0]);
      return typeof s === 'string' && typeof sep === 'string' ? s.split(sep) : null;
    }
    function tryAt(list, i) {
      var st = list[i], order = null, ordName = null, idxName = null, used = 1, decls = [];
      if (!st || st.type !== 'VariableDeclaration') return null;
      st.declarations.forEach(function (d) {
        if (d.id.type !== 'Identifier') return;
        var o = orderOf(d.init);
        if (o) { order = o; ordName = d.id.name; }
        else if (order && cval(d.init) === 0) idxName = d.id.name;
      });
      if (!order) return null;
      var loop = list[i + 1];
      if (!idxName && loop && loop.type === 'VariableDeclaration' && loop.declarations.length === 1 && cval(loop.declarations[0].init) === 0) {
        idxName = loop.declarations[0].id.name; used = 2; loop = list[i + 2];
      }
      if (!idxName || !loop || loop.type !== 'WhileStatement' || truthy(loop.test) !== true || loop.body.type !== 'BlockStatement') return null;
      var lb = loop.body.body;
      if (!lb.length || lb[0].type !== 'SwitchStatement' || (lb.length === 2 && lb[1].type !== 'BreakStatement') || lb.length > 2) return null;
      var d0 = lb[0].discriminant;
      if (!(d0.type === 'MemberExpression' && d0.computed && d0.object.type === 'Identifier' && d0.object.name === ordName &&
        d0.property.type === 'UpdateExpression' && d0.property.operator === '++' && !d0.property.prefix && d0.property.argument.name === idxName)) return null;
      var cases = {};
      for (var c = 0; c < lb[0].cases.length; c++) {
        var cs = lb[0].cases[c], kv = cval(cs.test);
        if (kv === NONE) return null;
        var cons = cs.consequent.slice();
        if (cons.length === 1 && cons[0].type === 'BlockStatement') cons = cons[0].body.slice();
        var last = cons[cons.length - 1];
        if (last && last.type === 'ContinueStatement' && !last.label) cons.pop();
        var bad = false;
        each({ type: 'BlockStatement', body: cons }, function (x) {
          if (/Function|Class/.test(x.type) && x !== cons) return false;
          if ((x.type === 'ContinueStatement' || x.type === 'BreakStatement') && !x.label) { bad = true; return false; }
          if (/^(While|DoWhile|For|ForIn|ForOf|Switch)Statement$/.test(x.type)) return false;   // their own break/continue are fine
        });
        if (bad) return null;
        cases[String(kv)] = cons;
      }
      var out = [];
      for (var o2 = 0; o2 < order.length; o2++) { if (!cases[order[o2]]) return null; out = out.concat(cases[order[o2]]); }
      // keep any other declarators of the first statement
      var rest = st.declarations.filter(function (d) { return d.id.name !== ordName && d.id.name !== idxName; });
      if (rest.length) out.unshift({ type: 'VariableDeclaration', kind: st.kind, declarations: rest });
      return { remove: used + 1, stmts: out };
    }
    each(ast, function (n) {
      var lists = [];
      if (n.type === 'Program' || n.type === 'BlockStatement' || n.type === 'StaticBlock') lists.push(n.body);
      if (n.type === 'SwitchCase') lists.push(n.consequent);
      lists.forEach(function (list) {
        for (var i = 0; i < list.length; i++) {
          var r = tryAt(list, i);
          if (r) { Array.prototype.splice.apply(list, [i, r.remove].concat(r.stmts)); changed++; stats.flattened++; i += r.stmts.length - 1; }
        }
      });
    });
    return changed;
  }

  function foldAndTidy(ast, stats) {
    var changed = 0;
    rewrite(ast, function (n, parent, key) {
      // constant expressions -> literal
      if (n.type === 'BinaryExpression' || n.type === 'UnaryExpression' || n.type === 'LogicalExpression') {
        if (n.type === 'UnaryExpression' && n.operator === '-' && n.argument.type === 'Literal' && typeof n.argument.value === 'number') return;
        if (n.type === 'UnaryExpression' && n.operator === 'void' && cval(n.argument) !== NONE) { changed++; return { type: 'Identifier', name: 'undefined' }; }
        var v = cval(n);
        if (v !== NONE && (typeof v !== 'string' || v.length < 4096) && v !== undefined) {
          if (n.type === 'UnaryExpression' && n.operator === 'typeof') return;
          changed++; stats.folded++;
          return lit(v);
        }
        // `true && x` -> x,  `false || x` -> x
        if (n.type === 'LogicalExpression') {
          var t = truthy(n.left);
          if (t !== null && cval(n.left) !== NONE) {
            if ((n.operator === '&&' && t) || (n.operator === '||' && !t)) { changed++; return n.right; }
            if ((n.operator === '&&' && !t) || (n.operator === '||' && t)) { changed++; return n.left; }
          }
        }
      }
      if (n.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'ArrayExpression' && !n.argument.elements.length) { changed++; return lit(false); }
      if (n.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'UnaryExpression' && n.argument.operator === '!' &&
        n.argument.argument.type === 'ArrayExpression' && !n.argument.argument.elements.length) { changed++; return lit(true); }
      // dead branches
      if (n.type === 'ConditionalExpression') {
        var tc = cval(n.test) !== NONE || n.test.type === 'ArrayExpression' ? truthy(n.test) : null;
        if (tc !== null) { changed++; stats.dead++; return tc ? n.consequent : n.alternate; }
      }
      if (n.type === 'IfStatement') {
        var ti = cval(n.test) !== NONE ? truthy(n.test) : null;
        if (ti !== null) {
          changed++; stats.dead++;
          var keep = ti ? n.consequent : n.alternate;
          if (!keep) return isStmtList(parent, key) ? null : { type: 'EmptyStatement' };
          return unwrapBlock(keep, parent, key);
        }
      }
      // obj['name'] -> obj.name ; {'name': v} -> {name: v} ; ['name']() {} -> name() {}
      if (n.type === 'MemberExpression' && n.computed && n.property.type === 'Literal' && typeof n.property.value === 'string' && ID_RE.test(n.property.value)) {
        n.computed = false; n.property = { type: 'Identifier', name: n.property.value }; changed++;
      }
      if ((n.type === 'Property' || n.type === 'MethodDefinition' || n.type === 'PropertyDefinition') && n.key.type === 'Literal' && typeof n.key.value === 'string' && ID_RE.test(n.key.value) && !n.shorthand) {
        // a computed ['constructor'] / ['__proto__'] means something else than the bare name
        if (!(n.computed && (n.key.value === 'constructor' || n.key.value === '__proto__'))) { n.computed = false; n.key = { type: 'Identifier', name: n.key.value }; changed++; }
      }
      // statement-level commas / ternaries / && back into statements
      if (n.type === 'ExpressionStatement' && isStmtList(parent, key)) {
        var e = n.expression;
        if (e.type === 'SequenceExpression') { changed++; return e.expressions.map(exprStmt); }
        if (e.type === 'ConditionalExpression') {
          changed++;
          return { type: 'IfStatement', test: e.test, consequent: { type: 'BlockStatement', body: [exprStmt(e.consequent)] }, alternate: { type: 'BlockStatement', body: [exprStmt(e.alternate)] } };
        }
        if (e.type === 'LogicalExpression' && (e.operator === '&&' || e.operator === '||') && /Call|Assignment|Update|Sequence|Await/.test(e.right.type)) {
          changed++;
          var test = e.operator === '&&' ? e.left : { type: 'UnaryExpression', operator: '!', prefix: true, argument: e.left };
          return { type: 'IfStatement', test: test, consequent: { type: 'BlockStatement', body: [exprStmt(e.right)] }, alternate: null };
        }
      }
      // var a = 1, b = 2;  ->  one declaration per line, like hand-written code
      if (n.type === 'VariableDeclaration' && n.declarations.length > 1 && isStmtList(parent, key) && n.declarations.some(function (d) { return d.init; })) {
        changed++;
        return n.declarations.map(function (d) { return { type: 'VariableDeclaration', kind: n.kind, declarations: [d] }; });
      }
      if (n.type === 'ReturnStatement' && n.argument && n.argument.type === 'SequenceExpression' && isStmtList(parent, key)) {
        changed++;
        var ex = n.argument.expressions;
        return ex.slice(0, -1).map(exprStmt).concat([{ type: 'ReturnStatement', argument: ex[ex.length - 1] }]);
      }
      if (n.type === 'IfStatement' && n.test.type === 'SequenceExpression' && isStmtList(parent, key)) {
        changed++;
        var ex2 = n.test.expressions;
        n.test = ex2[ex2.length - 1];
        return ex2.slice(0, -1).map(exprStmt).concat([n]);
      }
      // single statements inside blocks for readability: if (x) a(); -> if (x) { a(); }
      if (n.type === 'IfStatement') {
        if (n.consequent.type !== 'BlockStatement') n.consequent = { type: 'BlockStatement', body: [n.consequent] };
        if (n.alternate && n.alternate.type !== 'BlockStatement' && n.alternate.type !== 'IfStatement') n.alternate = { type: 'BlockStatement', body: [n.alternate] };
      }
      if (/^(For|ForIn|ForOf|While)Statement$/.test(n.type) && n.body.type !== 'BlockStatement') n.body = { type: 'BlockStatement', body: [n.body] };
      // { { … } } -> { … } (not a function / catch body: merging there could clash with a parameter)
      if (n.type === 'BlockStatement' && n.body.length === 1 && n.body[0].type === 'BlockStatement' &&
        !(parent && (/Function/.test(parent.type) || parent.type === 'CatchClause') && key === 'body')) { changed++; n.body = n.body[0].body; }
    });
    return changed;
  }

  // Literals printed plainly: decimal numbers, single-quoted strings.
  function normaliseLiterals(ast) {
    each(ast, function (n) {
      if (n.type !== 'Literal' || n.regex || n.bigint != null) return;
      if (typeof n.value === 'string') n.raw = jsStr(n.value);
      else if (typeof n.value === 'number') n.raw = String(n.value);
      else if (n.value === null) n.raw = 'null';
      else if (typeof n.value === 'boolean') n.raw = String(n.value);
    });
  }

  function simplifyAll(ast, stats) {
    for (var pass = 0; pass < 12; pass++) {
      var c = foldAndTidy(ast, stats);
      c += inlineProxies(ast, stats);
      c += unflatten(ast, stats);
      if (!c) break;
    }
    normaliseLiterals(ast);
  }

  // _0x… -> v1 / fn1 / arg1 / err1 / Cls1 (one global mapping: the
  // obfuscator's names are unique, so this can't capture anything).
  function renameHex(ast, stats) {
    var taken = {}, map = {}, count = { v: 0, fn: 0, arg: 0, err: 0, Cls: 0 };
    each(ast, function (n) { if (n.type === 'Identifier') taken[n.name] = 1; });
    var HEX = /^_0x[0-9a-fA-F]{3,}$/;
    function give(name, kind) {
      if (!HEX.test(name) || map[name]) return;
      var nm;
      do { nm = kind + (++count[kind]); } while (taken[nm]);
      taken[nm] = 1; map[name] = nm;
    }
    function bindPattern(p, kind) {
      if (!p) return;
      if (p.type === 'Identifier') give(p.name, kind);
      else if (p.type === 'AssignmentPattern') bindPattern(p.left, kind);
      else if (p.type === 'RestElement') bindPattern(p.argument, kind);
      else if (p.type === 'ArrayPattern') p.elements.forEach(function (e) { bindPattern(e, kind); });
      else if (p.type === 'ObjectPattern') p.properties.forEach(function (q) { bindPattern(q.type === 'RestElement' ? q.argument : q.value, kind); });
    }
    each(ast, function (n) {
      if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') && n.id) give(n.id.name, 'fn');
      if (/Function/.test(n.type)) n.params.forEach(function (p) { bindPattern(p, 'arg'); });
      if (n.type === 'VariableDeclarator') bindPattern(n.id, n.init && /Function/.test(n.init.type) ? 'fn' : 'v');
      if (n.type === 'CatchClause') bindPattern(n.param, 'err');
      if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && n.id) give(n.id.name, 'Cls');
    });
    each(ast, function (n) { if (n.type === 'Identifier' && HEX.test(n.name)) give(n.name, 'v'); });   // implicit globals etc.
    each(ast, function (n, par, key) {
      if (n.type !== 'Identifier' || !map[n.name]) return;
      if (par && par.type === 'MemberExpression' && key === 'property' && !par.computed) return;
      if (par && (par.type === 'Property' || par.type === 'MethodDefinition' || par.type === 'PropertyDefinition') && key === 'key' && !par.computed) {
        if (par.shorthand) { par.shorthand = false; par.value = { type: 'Identifier', name: map[n.name] }; }
        return;
      }
      n.name = map[n.name];
    });
    stats.renamed = Object.keys(map).length;
  }

  function jsNote(st) {
    var parts = [];
    if (st.strings) parts.push(st.strings + ' strings decoded');
    if (st.proxies) parts.push(st.proxies + ' proxy objects inlined');
    if (st.dead) parts.push(st.dead + ' dead branches removed');
    if (st.flattened) parts.push(st.flattened + ' flattened blocks restored');
    if (st.renamed) parts.push(st.renamed + ' names renamed');
    return 'Unobfuscated JavaScript: ' + (parts.length ? parts.join(', ') : 'tidied and formatted') +
      (st.renamed ? ' (original local names and comments aren’t recoverable)' : '');
  }

  // =====================================================================
  // Entry
  // =====================================================================
  // run(lang, input, env) -> Promise<{code, note}>; env.beautifyCSS optional
  function run(lang, input, env) {
    env = env || {};
    if (lang === 'html') return Promise.resolve().then(function () { return unobfuscateHTML(input); });
    if (lang === 'python') return unobfuscatePython(input);
    if (lang === 'css') return unobfuscateCSS(input, env.beautifyCSS);
    if (lang === 'js') {
      return ensureDeps().then(function (deps) { return deobfuscateJS(input, deps, sandboxRun); })
        .then(function (r) { return { code: r.code, note: jsNote(r.stats) }; });
    }
    return Promise.reject(new Error('Unobfuscate supports JavaScript, Python, HTML and CSS'));
  }

  root.__CADE_UNOBF__ = {
    run: run, detect: detect,
    _unobfuscateHTML: unobfuscateHTML, _unobfuscatePython: unobfuscatePython, _reindentPython: reindentPython,
    _unescapeCSS: unescapeCSS, _deobfuscateJS: deobfuscateJS, _jsNote: jsNote
  };
})(typeof window !== 'undefined' ? window : this);
