/* Notebook core — the DOM-free half of the reactive notebook (linked code
 * blocks): name analysis, the run transform, the dependency planner, chart
 * and text helpers, and the source of the harness that runs INSIDE the
 * notebook's persistent JavaScript sandbox.
 *
 * - analyzeJS / analyzePython: a small tokenizer plus a forgiving
 *   statement-level walk (no full parser). defines = names a block binds at
 *   its top level (declarations, functions, classes, imports, plain global
 *   assignments; Python: assignments, def, class, import, for/with/except
 *   targets); uses = free names read at the top level; lateUses = free names
 *   read only inside function bodies (they link to earlier blocks only, so
 *   mutually recursive helpers in two blocks don't look like a cycle).
 * - buildJSVariants: rewrites a block so its top-level bindings land in the
 *   sandbox's global scope (re-running `const a = 1` must work), wraps it in
 *   an async function (top-level await), returns the last expression's value
 *   and turns static imports into dynamic ones. No newlines are added, so
 *   error lines are the block's own.
 * - plan: what to re-run after a block ran — its transitive dependents in
 *   dependency order (document order on ties); blocks in or behind a cycle
 *   are reported instead of run.
 *
 * Loaded by the notebook engine (script injection); require()-able in node
 * for the unit tests. Self-contained IIFE. */
(function (root) {
  'use strict';
  var NC = {};
  var hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  function set(list) { var o = {}; for (var i = 0; i < list.length; i++) o[list[i]] = 1; return o; }
  function uniq(a) { var seen = {}, out = []; for (var i = 0; i < a.length; i++) if (!hasOwn(seen, a[i])) { seen[a[i]] = 1; out.push(a[i]); } return out; }

  // Runtimes: which fence languages share one live scope per note.
  NC.RT = { js: 'js', ts: 'js', py: 'py' };

  // ==== JavaScript tokenizer ====================================================================
  var PUNCS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.',
    '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
  var KW_BEFORE_EXPR = set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'extends']);
  function isIdStart(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || c > 127; }
  function isIdPart(c) { return isIdStart(c) || (c >= 48 && c <= 57); }
  function isDigit(c) { return c >= 48 && c <= 57; }

  // -> [{type: name|num|str|tmpl|regex|punc, v, s, e, nl}] (nl: a line break before it)
  NC.tokenizeJS = function (src) {
    src = String(src);
    var toks = [], i = 0, n = src.length, nl = false, stack = [];
    function push(type, s, e) { toks.push({ type: type, v: src.slice(s, e), s: s, e: e, nl: nl }); nl = false; }
    function lastSig() { return toks.length ? toks[toks.length - 1] : null; }
    function regexOk() {
      var p = lastSig();
      if (!p) return true;
      if (p.type === 'name') return hasOwn(KW_BEFORE_EXPR, p.v);
      if (p.type !== 'punc') return false;
      return !(p.v === ')' || p.v === ']' || p.v === '}' || p.v === '++' || p.v === '--');
    }
    // template text from i (just after ` or a closing } of ${…}) to the next ` or ${
    function tmplRest(s) {
      while (i < n) {
        var c = src.charCodeAt(i);
        if (c === 92) { i += 2; continue; }
        if (c === 96) { i++; push('tmpl', s, i); return; }
        if (c === 36 && src.charCodeAt(i + 1) === 123) {
          push('tmpl', s, i);
          toks.push({ type: 'punc', v: '${', s: i, e: i + 2, nl: false });
          stack.push('${');
          i += 2;
          return;
        }
        i++;
      }
      push('tmpl', s, n);
    }
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) { while (i < n && src.charCodeAt(i) !== 10) i++; } // #!shebang
    while (i < n) {
      var c = src.charCodeAt(i), s = i;
      if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) { nl = true; i++; continue; }
      if (c === 32 || c === 9 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff) { i++; continue; }
      if (c === 47) {
        var d = src.charCodeAt(i + 1);
        if (d === 47) { while (i < n && src.charCodeAt(i) !== 10) i++; continue; }
        if (d === 42) {
          var end = src.indexOf('*/', i + 2);
          end = end === -1 ? n : end + 2;
          if (src.slice(i, end).indexOf('\n') !== -1) nl = true;
          i = end;
          continue;
        }
        if (regexOk()) {
          i++;
          var inCls = false;
          while (i < n) {
            var r = src.charCodeAt(i);
            if (r === 10) break;
            if (r === 92) { i += 2; continue; }
            if (r === 91) inCls = true;
            else if (r === 93) inCls = false;
            else if (r === 47 && !inCls) { i++; break; }
            i++;
          }
          while (i < n && isIdPart(src.charCodeAt(i))) i++;
          push('regex', s, i);
          continue;
        }
      }
      if (c === 39 || c === 34) {
        i++;
        while (i < n) {
          var q = src.charCodeAt(i);
          if (q === 92) { i += 2; continue; }
          if (q === c) { i++; break; }
          if (q === 10) break;
          i++;
        }
        push('str', s, i);
        continue;
      }
      if (c === 96) { i++; tmplRest(s); continue; }
      if (c === 125 && stack.length && stack[stack.length - 1] === '${') {
        stack.pop();
        toks.push({ type: 'punc', v: '}', s: i, e: i + 1, nl: nl, tpl: true });
        nl = false;
        i++;
        tmplRest(i);
        continue;
      }
      if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(i + 1)))) {
        i++;
        while (i < n) {
          var ch = src.charCodeAt(i);
          if (isIdPart(ch) || ch === 46) { i++; continue; }
          if ((ch === 43 || ch === 45) && /[eE]/.test(src.charAt(i - 1)) && !/^0[xX]/.test(src.slice(s, i))) { i++; continue; }
          break;
        }
        push('num', s, i);
        continue;
      }
      if (isIdStart(c) || c === 92 || c === 35) {
        i++;
        while (i < n) {
          var ic = src.charCodeAt(i);
          if (isIdPart(ic)) i++;
          else if (ic === 92 && src.charCodeAt(i + 1) === 117) i += 2;
          else break;
        }
        push('name', s, i);
        continue;
      }
      var p = null;
      for (var k = 0; k < PUNCS.length; k++) if (src.substr(i, PUNCS[k].length) === PUNCS[k]) { p = PUNCS[k]; break; }
      if (p === '?.' && isDigit(src.charCodeAt(i + 2))) p = null; // a ? .5 : b
      if (!p) p = src.charAt(i);
      if (p === '{' || p === '(' || p === '[') stack.push(p);
      else if ((p === '}' || p === ')' || p === ']') && stack.length) stack.pop();
      i += p.length;
      push('punc', s, i);
    }
    return toks;
  };
  // Index of each bracket's partner (-1 when unbalanced).
  function matchBrackets(T) {
    var M = new Array(T.length), st = [];
    for (var i = 0; i < T.length; i++) {
      M[i] = -1;
      var t = T[i];
      if (t.type !== 'punc') continue;
      var v = t.v;
      if (v === '(' || v === '[' || v === '{' || v === '${') st.push(i);
      else if (v === ')' || v === ']' || v === '}') {
        var want = v === ')' ? '(' : v === ']' ? '[' : '{';
        for (var j = st.length - 1; j >= 0; j--) {
          var o = T[st[j]].v;
          if (o === want || (v === '}' && o === '${')) { M[i] = st[j]; M[st[j]] = i; st.length = j; break; }
        }
      }
    }
    return M;
  }

  // ==== JavaScript analysis =====================================================================
  var JS_RESERVED = set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export',
    'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch',
    'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'enum', 'await']);
  NC.JS_GLOBALS = set(('undefined NaN Infinity globalThis window self document console Math JSON Object Array String Number Boolean Symbol BigInt ' +
    'Date RegExp Error TypeError RangeError SyntaxError ReferenceError EvalError URIError AggregateError Promise Map Set WeakMap WeakSet WeakRef ' +
    'Proxy Reflect Intl ArrayBuffer SharedArrayBuffer DataView Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array ' +
    'Float32Array Float64Array BigInt64Array BigUint64Array parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI ' +
    'decodeURI escape unescape setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame queueMicrotask ' +
    'structuredClone fetch Response Request Headers URL URLSearchParams Blob File FileReader TextEncoder TextDecoder atob btoa crypto performance ' +
    'navigator location alert confirm prompt display Image ImageData OffscreenCanvas HTMLElement HTMLCanvasElement Element Node Event CustomEvent ' +
    'EventTarget AbortController AbortSignal WebAssembly arguments Function eval Iterator').split(' '));
  // TypeScript words that the JS walk would otherwise report as names read.
  var TS_SKIP = set(('string number boolean any unknown never object bigint symbol readonly keyof infer as satisfies interface type enum implements ' +
    'namespace declare abstract private public protected override is asserts unique module').split(' '));
  var ASSIGN_OPS = set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
  // A line break before one of these does not end the statement (ASI).
  var CONT = set(['(', '[', '.', '?.', ',', '?', ':', '=', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '+', '-', '*', '/', '%', '**', '&', '|', '^',
    '&&', '||', '??', '<<', '>>', '>>>', '=>', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=', ')', ']', '}']);
  var STMT_KW = set(['var', 'let', 'const', 'function', 'class', 'if', 'for', 'while', 'do', 'switch', 'try', 'return', 'throw', 'break',
    'continue', 'import', 'export', 'with', 'debugger']);

  NC.analyzeJS = function (src, opt) {
    opt = opt || {};
    src = String(src);
    var ts = !!opt.ts;
    var T = NC.tokenizeJS(src), M = matchBrackets(T), N = T.length;
    var scopeTop = { parent: null, func: true, names: {} };
    var refs = [];
    var R = { decls: [], fnDecls: [], classDecls: [], imports: [], exports: [], stmts: [], tla: false };

    function v(i) { return i < N && i >= 0 ? T[i].v : ''; }
    function ty(i) { return i < N && i >= 0 ? T[i].type : ''; }
    function isP(i, s) { return i < N && i >= 0 && T[i].type === 'punc' && T[i].v === s; }
    function isN(i, s) { return i < N && i >= 0 && T[i].type === 'name' && (s == null || T[i].v === s); }
    function close(i) { var m = M[i]; return m > i ? m : N; } // partner of an opener (end of input when unbalanced)
    function newScope(p, func) { return { parent: p, func: !!func, names: {} }; }
    function declare(sc, name, kind) {
      if (!name || name.charAt(0) === '#') return;
      var s = sc;
      if (kind === 'var') while (!s.func && s.parent) s = s.parent;
      s.names[name] = 1;
    }
    function ref(i, sc, fd, read, write) {
      var name = T[i].v;
      if (name.charAt(0) === '#' || hasOwn(JS_RESERVED, name)) return;
      refs.push({ name: name, sc: sc, fd: fd, read: read, write: write });
    }
    // does the walk at token j stop here? (end of a statement / expression)
    function endsExpr(j, end) {
      if (j >= end) return true;
      var t = T[j], p = T[j - 1];
      if (t.type === 'punc' && (t.v === ';' || ((t.v === ')' || t.v === ']' || t.v === '}') && !t.tpl))) return true;
      if (!t.nl || !p) return false;
      // a line break: the statement goes on only when the previous token wants
      // an operand or the next one can only continue an expression
      if (p.type === 'punc' && !(p.v === ')' || p.v === ']' || p.v === '}' || p.v === '++' || p.v === '--')) return false;
      if (p.type === 'name' && (hasOwn(KW_BEFORE_EXPR, p.v) && p.v !== 'yield' && p.v !== 'await') ) return false;
      if (t.type === 'punc' && hasOwn(CONT, t.v) && t.v !== ')' && t.v !== ']' && t.v !== '}') return false;
      if (t.type === 'tmpl') return false;
      if (t.type === 'name' && (t.v === 'in' || t.v === 'instanceof' || (ts && (t.v === 'as' || t.v === 'satisfies')))) return false;
      return true;
    }
    // TypeScript annotation after a binding (x: Type, f(): Type): skip to the next , = ) ; or a { at depth 0
    function skipType(j, end, stopBrace) {
      var depth = 0;
      while (j < end) {
        var t = T[j];
        if (t.type === 'punc') {
          if (t.v === '<') depth++;
          else if (t.v === '>' && depth) depth--;
          else if (t.v === '>>' && depth) depth = Math.max(0, depth - 2);
          else if (t.v === '(' || t.v === '[') { j = close(j) + 1; continue; }
          else if (t.v === '{') { if (stopBrace && !depth) return j; j = close(j) + 1; continue; }
          else if (!depth && (t.v === ',' || t.v === '=' || t.v === ')' || t.v === ';' || t.v === '=>' || t.v === ']' || t.v === '}')) return j;
        }
        if (!depth && j > 0 && T[j].nl && t.type === 'name' && T[j - 1].type === 'name') return j;
        j++;
      }
      return j;
    }

    // ---- patterns (declarations, params, destructuring assignments) ----
    // onName(tokenIndex) for each bound name; defaults are walked as expressions.
    function pattern(i, end, sc, fd, onName) {
      if (i >= end) return i;
      var t = T[i];
      if (t.type === 'name') { onName(i); return i + 1; }
      if (isP(i, '[')) {
        var e = close(i), j = i + 1;
        while (j < e) {
          if (isP(j, ',')) { j++; continue; }
          if (isP(j, '...')) j++;
          j = pattern(j, e, sc, fd, onName);
          if (isP(j, '=')) j = expr(j + 1, e, sc, fd, true);
          while (j < e && !isP(j, ',')) j++;
        }
        return e + 1;
      }
      if (isP(i, '{')) {
        var e2 = close(i), k = i + 1;
        while (k < e2) {
          if (isP(k, ',')) { k++; continue; }
          if (isP(k, '...')) { k = pattern(k + 1, e2, sc, fd, onName); continue; }
          var keyTok = k;
          if (isP(k, '[')) { expr(k + 1, close(k), sc, fd, false); k = close(k) + 1; }
          else k++;
          if (isP(k, ':')) k = pattern(k + 1, e2, sc, fd, onName);
          else if (ty(keyTok) === 'name') onName(keyTok);
          if (isP(k, '=')) k = expr(k + 1, e2, sc, fd, true);
          while (k < e2 && !isP(k, ',')) k++;
        }
        return e2 + 1;
      }
      return i + 1;
    }
    function params(i, sc, fd, fs) { // i at '('; returns index after ')'
      var e = close(i), j = i + 1;
      while (j < e) {
        if (isP(j, ',')) { j++; continue; }
        if (isP(j, '...')) j++;
        if (ts && isN(j) && /^(public|private|protected|readonly|override)$/.test(v(j)) && (isN(j + 1) || isP(j + 1, '{') || isP(j + 1, '['))) j++;
        j = pattern(j, e, fs, fd, function (k) { declare(fs, T[k].v, 'let'); });
        if (isP(j, '?')) j++;
        if (isP(j, ':')) j = skipType(j + 1, e, false);
        if (isP(j, '=')) j = expr(j + 1, e, fs, fd, true);
        while (j < e && !isP(j, ',')) j++;
      }
      return e + 1;
    }
    // function [*] [name] (params) [: type] { body } — i at 'function'
    function func(i, end, sc, fd, isDecl, top) {
      var j = i + 1, name = null;
      if (isP(j, '*')) j++;
      if (isN(j) && !isP(j, '(')) { name = j; j++; }
      if (ts && isP(j, '<')) j = skipType(j, end, true);
      var fs = newScope(sc, true);
      if (name != null) {
        if (isDecl) {
          declare(sc, T[name].v, 'let');
          if (top && fd === 0) R.fnDecls.push(T[name].v);
        } else declare(fs, T[name].v, 'let');
      }
      if (isP(j, '(')) j = params(j, sc, fd + 1, fs);
      if (ts && isP(j, ':')) j = skipType(j + 1, end, true);
      if (isP(j, '{')) { stmts(j + 1, close(j), fs, fd + 1, false); j = close(j) + 1; }
      return j;
    }
    function arrow(i, end, sc, fd, stopComma) { // i at '(' or a name, followed by =>
      var fs = newScope(sc, true), j;
      if (isP(i, '(')) j = params(i, sc, fd + 1, fs);
      else { declare(fs, T[i].v, 'let'); j = i + 1; }
      if (ts && isP(j, ':')) j = skipType(j + 1, end, true);
      if (isP(j, '=>')) j++;
      if (isP(j, '{')) { stmts(j + 1, close(j), fs, fd + 1, false); return close(j) + 1; }
      return expr(j, end, fs, fd + 1, stopComma);
    }
    function classBody(i, sc, fd) { // i at '{'
      var e = close(i), j = i + 1;
      while (j < e) {
        if (isP(j, ';') || isP(j, ',')) { j++; continue; }
        if (isP(j, '@')) { j++; j = expr(j, e, sc, fd, true); continue; }
        if (isN(j, 'static') && isP(j + 1, '{')) { stmts(j + 2, close(j + 1), newScope(sc, true), fd + 1, false); j = close(j + 1) + 1; continue; }
        while (isN(j) && /^(static|get|set|async|public|private|protected|readonly|abstract|override|declare|accessor)$/.test(v(j)) &&
               (isN(j + 1) || isP(j + 1, '[') || isP(j + 1, '*') || ty(j + 1) === 'str' || ty(j + 1) === 'num')) j++;
        if (isP(j, '*')) j++;
        if (isP(j, '[')) { expr(j + 1, close(j), sc, fd, false); j = close(j) + 1; }
        else j++; // member name (not a reference)
        if (isP(j, '?') || isP(j, '!')) j++;
        if (ts && isP(j, '<')) j = skipType(j, e, true);
        if (isP(j, '(')) {
          var fs = newScope(sc, true);
          j = params(j, sc, fd + 1, fs);
          if (ts && isP(j, ':')) j = skipType(j + 1, e, true);
          if (isP(j, '{')) { stmts(j + 1, close(j), fs, fd + 1, false); j = close(j) + 1; }
          continue;
        }
        if (ts && isP(j, ':')) j = skipType(j + 1, e, false);
        if (isP(j, '=')) j = expr(j + 1, e, newScope(sc, true), fd + 1, false);
      }
      return e + 1;
    }
    function cls(i, end, sc, fd, isDecl, top) { // i at 'class'
      var j = i + 1, name = null;
      if (isN(j) && v(j) !== 'extends' && v(j) !== 'implements') { name = j; j++; }
      if (ts && isP(j, '<')) j = skipType(j, end, true);
      if (name != null && isDecl) declare(sc, T[name].v, 'let');
      var inner = sc;
      if (name != null && !isDecl) { inner = newScope(sc, false); declare(inner, T[name].v, 'let'); }
      if (isN(j, 'extends')) {
        j++;
        var k = j;
        while (k < end && !isP(k, '{')) { if (isP(k, '(') || isP(k, '[')) k = close(k); k++; }
        expr(j, k, inner, fd, false);
        j = k;
      }
      if (isN(j, 'implements')) while (j < end && !isP(j, '{')) j++;
      if (isP(j, '{')) {
        var bodyOpen = j;
        j = classBody(j, inner, fd);
        if (isDecl && top && fd === 0 && name != null) R.classDecls.push({ kw: i, name: T[name].v, close: close(bodyOpen) });
      }
      return j;
    }
    function objLit(i, sc, fd) { // i at '{' (object literal)
      var e = close(i), j = i + 1;
      while (j < e) {
        if (isP(j, ',')) { j++; continue; }
        if (isP(j, '...')) { j = expr(j + 1, e, sc, fd, true); continue; }
        while (isN(j) && /^(get|set|async)$/.test(v(j)) && (isN(j + 1) || isP(j + 1, '[') || isP(j + 1, '*') || ty(j + 1) === 'str' || ty(j + 1) === 'num')) j++;
        if (isP(j, '*')) j++;
        var keyTok = j, computed = isP(j, '[');
        if (computed) { expr(j + 1, close(j), sc, fd, false); j = close(j) + 1; }
        else j++;
        if (isP(j, ':')) { j = expr(j + 1, e, sc, fd, true); continue; }
        if (isP(j, '(')) {
          var fs = newScope(sc, true);
          j = params(j, sc, fd + 1, fs);
          if (ts && isP(j, ':')) j = skipType(j + 1, e, true);
          if (isP(j, '{')) { stmts(j + 1, close(j), fs, fd + 1, false); j = close(j) + 1; }
          continue;
        }
        if (!computed && ty(keyTok) === 'name') ref(keyTok, sc, fd, true, false); // shorthand {a}
        if (isP(j, '=')) j = expr(j + 1, e, sc, fd, true);                       // {a = 1} (pattern side)
        while (j < e && !isP(j, ',')) j++;
      }
      return e + 1;
    }
    // Walk an expression from i; returns the index of the token that ends it
    // (not consumed): ; , (when stopComma) a closer, end, or an ASI line break.
    function expr(i, end, sc, fd, stopComma) {
      var j = i, ternary = 0, first = true;
      while (j < end) {
        if (!first && endsExpr(j, end)) return j;
        first = false;
        var t = T[j];
        if (t.type === 'punc') {
          var pv = t.v;
          if (pv === ',' && stopComma) return j;
          if (pv === ';' || ((pv === ')' || pv === ']' || pv === '}') && !t.tpl)) return j;
          if (pv === '?') { ternary++; j++; continue; }
          if (pv === ':') { if (ternary) { ternary--; j++; continue; } return j; }
          if (pv === '(') {
            var c = close(j);
            if (isP(c + 1, '=>') || (ts && isP(c + 1, ':') && arrowAfterType(c + 1, end))) { j = arrow(j, end, sc, fd, stopComma); continue; }
            exprSeq(j + 1, c, sc, fd); j = c + 1; continue;
          }
          if (pv === '[') {
            var c2 = close(j);
            if (isP(c2 + 1, '=') && atExprStart(j)) { pattern(j, end, sc, fd, function (k) { ref(k, sc, fd, false, true); }); j = c2 + 1; continue; }
            exprSeq(j + 1, c2, sc, fd); j = c2 + 1; continue;
          }
          if (pv === '{') {
            var c3 = close(j);
            if (isP(c3 + 1, '=') && atExprStart(j)) { pattern(j, end, sc, fd, function (k) { ref(k, sc, fd, false, true); }); j = c3 + 1; continue; }
            j = objLit(j, sc, fd); continue;
          }
          if (pv === '${') { exprSeq(j + 1, close(j), sc, fd); j = close(j) + 1; continue; }
          if (pv === '.' || pv === '?.') { j++; if (isN(j)) j++; continue; } // property name
          j++;
          continue;
        }
        if (t.type === 'name') {
          var nv = t.v;
          if (nv === 'function') { j = func(j, end, sc, fd, false, false); continue; }
          if (nv === 'class') { j = cls(j, end, sc, fd, false, false); continue; }
          if (nv === 'async' && isN(j + 1, 'function') && !T[j + 1].nl) { j = func(j + 1, end, sc, fd, false, false); continue; }
          if (nv === 'async' && !T[j + 1 < N ? j + 1 : j].nl && (isP(j + 1, '(') && isP(close(j + 1) + 1, '=>'))) { j = arrow(j + 1, end, sc, fd, stopComma); continue; }
          if (nv === 'async' && isN(j + 1) && isP(j + 2, '=>')) { j = arrow(j + 1, end, sc, fd, stopComma); continue; }
          if (isP(j + 1, '=>') && !hasOwn(JS_RESERVED, nv)) { j = arrow(j, end, sc, fd, stopComma); continue; }
          if (nv === 'await' && fd === 0) R.tla = true;
          if (nv === 'import' && (isP(j + 1, '(') || isP(j + 1, '.'))) { j++; if (isP(j, '.')) j += 2; continue; }
          if (nv === 'new' && isP(j + 1, '.')) { j += 3; continue; } // new.target
          if (ts && (nv === 'as' || nv === 'satisfies') && j > i) { j = skipTypeExpr(j + 1, end); continue; }
          if (ts && hasOwn(TS_SKIP, nv)) { j++; continue; }
          var prev = j > 0 ? T[j - 1] : null;
          if (prev && prev.type === 'punc' && (prev.v === '.' || prev.v === '?.')) { j++; continue; }
          if (nv === 'of' && j > i) { j++; continue; } // for (x of y)
          var nx = j + 1 < N ? T[j + 1] : null, write = false, read = true;
          if (nx && nx.type === 'punc' && hasOwn(ASSIGN_OPS, nx.v)) { write = true; read = nx.v !== '='; }
          else if ((nx && nx.type === 'punc' && !nx.nl && (nx.v === '++' || nx.v === '--')) || (prev && prev.type === 'punc' && (prev.v === '++' || prev.v === '--'))) write = true;
          ref(j, sc, fd, read, write);
          j++;
          continue;
        }
        j++;
      }
      return j;
    }
    function arrowAfterType(j, end) { var k = skipType(j + 1, end, true); return isP(k, '=>'); }
    function skipTypeExpr(j, end) {
      while (j < end) {
        if (isP(j, '<') || isP(j, '(') || isP(j, '[')) { if (isP(j, '<')) { j++; continue; } j = close(j) + 1; continue; }
        if (isN(j) || isP(j, '.') || isP(j, '|') || isP(j, '&') || isP(j, '>')) { j++; if (T[j] && T[j].nl) return j; continue; }
        break;
      }
      return j;
    }
    // is the opener at j the first token of an expression (so `{…} =` / `[…] =` destructures)?
    function atExprStart(j) {
      var p = j > 0 ? T[j - 1] : null;
      if (!p) return true;
      if (p.type === 'punc') return p.v === '(' || p.v === ',' || p.v === ';' || p.v === '=' || p.v === '{' || p.v === '}' || p.v === '?' || p.v === ':' || p.v === '[' || p.v === '=>';
      return p.nl || T[j].nl || p.v === 'return' || p.v === 'of' || p.v === 'in';
    }
    function exprSeq(i, end, sc, fd) {
      var j = i;
      while (j < end) {
        var k = expr(j, end, sc, fd, false);
        if (k >= end) break;
        if (k <= j) { j++; continue; } // no progress (a stray closer / colon): step over it
        j = (isP(k, ',') || isP(k, ';') || isP(k, ':')) ? k + 1 : k;
      }
    }
    // var/let/const — i at the keyword. inFor: inside a for (…) header.
    function declaration(i, end, sc, fd, top, inFor) {
      var kw = T[i].v, kind = kw === 'var' ? 'var' : 'let', j = i + 1;
      var info = { kw: i, kind: kw, top: top, inFor: !!inFor, decls: [], end: 0 };
      while (j < end) {
        var ds = j, pat = isP(j, '[') || isP(j, '{'), names = [];
        j = pattern(j, end, sc, fd, function (k) { declare(sc, T[k].v, kind); names.push(T[k].v); });
        var patEnd = j - 1;
        if (ts && isP(j, '!')) j++;
        if (ts && isP(j, ':')) j = skipType(j + 1, end, false);
        var hasInit = false, initEnd = patEnd;
        if (isP(j, '=')) {
          hasInit = true;
          j = expr(j + 1, end, sc, fd, true);
          initEnd = j - 1;
        }
        info.decls.push({ s: ds, patEnd: patEnd, pat: pat, init: hasInit, initEnd: initEnd, names: names });
        if (isP(j, ',')) { j++; continue; }
        break;
      }
      info.end = j;
      if (fd === 0 && (kw === 'var' || (top && !inFor))) R.decls.push(info);
      return j;
    }
    // import … from '…' — i at 'import' (top level only)
    function importDecl(i, end, sc, top) {
      var j = i + 1, im = { s: i, def: null, ns: null, specs: [], src: '', end: i };
      if (ts && isN(j, 'type') && !isN(j + 1, 'from')) j++;
      if (ty(j) === 'str') { im.src = T[j].v; j++; }
      else {
        if (isN(j) && v(j) !== 'from') { im.def = T[j].v; declare(sc, im.def, 'let'); j++; if (isP(j, ',')) j++; }
        if (isP(j, '*')) { j++; if (isN(j, 'as')) j++; if (isN(j)) { im.ns = T[j].v; declare(sc, im.ns, 'let'); j++; } }
        if (isP(j, '{')) {
          var e = close(j), k = j + 1;
          while (k < e) {
            if (isP(k, ',')) { k++; continue; }
            if (ts && isN(k, 'type') && (isN(k + 1) || ty(k + 1) === 'str') && !isP(k + 1, ',')) k++;
            var imported = T[k].v, local = imported;
            k++;
            if (isN(k, 'as')) { k++; local = v(k); k++; }
            im.specs.push({ imported: imported, local: local });
            declare(sc, local, 'let');
          }
          j = e + 1;
        }
        if (isN(j, 'from')) j++;
        if (ty(j) === 'str') { im.src = T[j].v; j++; }
      }
      if ((isN(j, 'assert') || isN(j, 'with')) && isP(j + 1, '{')) j = close(j + 1) + 1;
      im.end = j - 1;
      R.tla = true;
      if (top) R.imports.push(im);
      if (isP(j, ';')) j++;
      return j;
    }
    function stmts(i, end, sc, fd, top) {
      var j = i;
      while (j < end) {
        var k = stmt(j, end, sc, fd, top);
        if (k <= j) k = j + 1;
        j = k;
      }
    }
    function blockAt(j, sc, fd) { // j at '{' -> index after '}'
      stmts(j + 1, close(j), newScope(sc, false), fd, false);
      return close(j) + 1;
    }
    function body(j, end, sc, fd) { return isP(j, '{') ? blockAt(j, sc, fd) : stmt(j, end, sc, fd, false); }
    function parenExpr(j, sc, fd) { if (!isP(j, '(')) return j; exprSeq(j + 1, close(j), sc, fd); return close(j) + 1; }
    function stmt(i, end, sc, fd, top) {
      var t = T[i], j, kind = 'expr';
      if (!t) return end;
      var start = i;
      j = (function () {
        if (t.type === 'punc') {
          if (t.v === ';') { kind = 'empty'; return i + 1; }
          if (t.v === '{') { kind = 'block'; return blockAt(i, sc, fd); }
          if (t.v === '@') { kind = 'decorator'; return expr(i + 1, end, sc, fd, true); }
        }
        if (t.type === 'name') {
          var tv = t.v;
          if ((tv === 'var' || tv === 'const') || (tv === 'let' && (isN(i + 1) || isP(i + 1, '[') || isP(i + 1, '{')))) {
            kind = 'decl';
            var e = declaration(i, end, sc, fd, top, false);
            return isP(e, ';') ? e + 1 : e;
          }
          if (tv === 'function') { kind = 'function'; return func(i, end, sc, fd, true, top); }
          if (tv === 'async' && isN(i + 1, 'function') && !T[i + 1].nl) { kind = 'function'; return func(i + 1, end, sc, fd, true, top); }
          if (tv === 'class') { kind = 'class'; return cls(i, end, sc, fd, true, top); }
          if (ts && (tv === 'interface' || (tv === 'type' && isN(i + 1) && !T[i + 1].nl) || tv === 'declare') ) {
            kind = 'type';
            var q = i + 1;
            while (q < end && !isP(q, '{') && !isP(q, '=') && !isP(q, ';') && !(T[q].nl)) q++;
            if (isP(q, '{')) return close(q) + 1;
            if (isP(q, '=')) { q = skipType(q + 1, end, false); return isP(q, ';') ? q + 1 : q; }
            return q;
          }
          if (ts && tv === 'enum' && isN(i + 1)) {
            kind = 'enum'; declare(sc, T[i + 1].v, 'let');
            var en = i + 2; if (isP(en, '{')) return close(en) + 1; return en;
          }
          if (tv === 'if') {
            kind = 'if';
            j = parenExpr(i + 1, sc, fd);
            j = body(j, end, sc, fd);
            if (isN(j, 'else')) j = body(j + 1, end, sc, fd);
            return j;
          }
          if (tv === 'for') {
            kind = 'for';
            j = i + 1;
            if (isN(j, 'await')) { if (fd === 0) R.tla = true; j++; }
            if (!isP(j, '(')) return j;
            var hs = newScope(sc, false), he = close(j), k = j + 1;
            if (isN(k, 'var') || isN(k, 'const') || (isN(k, 'let') && (isN(k + 1) || isP(k + 1, '[') || isP(k + 1, '{')))) {
              k = declaration(k, he, hs, fd, top, true);
            }
            // rest of the header: for (x of y) / (a; b; c) / (k in o)
            while (k < he) {
              if (isN(k, 'of') || isN(k, 'in')) { k++; continue; }
              var k2 = expr(k, he, hs, fd, false);
              k = k2 <= k ? k + 1 : k2;
              if (isP(k, ';') || isP(k, ',')) k++;
            }
            return body(he + 1, end, hs, fd);
          }
          if (tv === 'while' || tv === 'with') { kind = tv; j = parenExpr(i + 1, sc, fd); return body(j, end, sc, fd); }
          if (tv === 'do') {
            kind = 'do';
            j = body(i + 1, end, sc, fd);
            if (isN(j, 'while')) j = parenExpr(j + 1, sc, fd);
            return isP(j, ';') ? j + 1 : j;
          }
          if (tv === 'switch') {
            kind = 'switch';
            j = parenExpr(i + 1, sc, fd);
            if (!isP(j, '{')) return j;
            var se = close(j), bs = newScope(sc, false), m = j + 1;
            while (m < se) {
              if (isN(m, 'case')) { m = expr(m + 1, se, bs, fd, false); if (isP(m, ':')) m++; continue; }
              if (isN(m, 'default') && isP(m + 1, ':')) { m += 2; continue; }
              var m2 = stmt(m, se, bs, fd, false);
              m = m2 <= m ? m + 1 : m2;
            }
            return se + 1;
          }
          if (tv === 'try') {
            kind = 'try';
            j = i + 1;
            if (isP(j, '{')) j = blockAt(j, sc, fd);
            if (isN(j, 'catch')) {
              j++;
              var cs = newScope(sc, false);
              if (isP(j, '(')) {
                var ce = close(j);
                pattern(j + 1, ce, cs, fd, function (q2) { declare(cs, T[q2].v, 'let'); });
                j = ce + 1;
              }
              if (isP(j, '{')) { stmts(j + 1, close(j), cs, fd, false); j = close(j) + 1; }
            }
            if (isN(j, 'finally') && isP(j + 1, '{')) j = blockAt(j + 1, sc, fd);
            return j;
          }
          if (tv === 'return' || tv === 'throw') {
            kind = tv;
            if (i + 1 >= end || T[i + 1].nl || isP(i + 1, ';') || isP(i + 1, '}')) return isP(i + 1, ';') ? i + 2 : i + 1;
            var re = expr(i + 1, end, sc, fd, false);
            while (isP(re, ',')) re = expr(re + 1, end, sc, fd, false);
            return isP(re, ';') ? re + 1 : re;
          }
          if (tv === 'break' || tv === 'continue') {
            kind = tv;
            j = i + 1;
            if (isN(j) && !T[j].nl) j++;
            return isP(j, ';') ? j + 1 : j;
          }
          if (tv === 'debugger') { kind = 'debugger'; return isP(i + 1, ';') ? i + 2 : i + 1; }
          if (tv === 'import' && !isP(i + 1, '(') && !isP(i + 1, '.')) { kind = 'import'; return importDecl(i, end, sc, top && fd === 0); }
          if (tv === 'export') {
            kind = 'export';
            if (top && fd === 0) R.exports.push({ s: i, e: i, all: false });
            j = i + 1;
            if (isN(j, 'default')) {
              if (top && fd === 0) R.exports[R.exports.length - 1].e = j;
              j++;
              return stmt(j, end, sc, fd, false);
            }
            if (isP(j, '{') || isP(j, '*')) {
              var x = j;
              if (isP(x, '{')) x = close(x) + 1; else { x++; if (isN(x, 'as')) x += 2; }
              if (isN(x, 'from')) x += 2;
              if (top && fd === 0) { var ex = R.exports[R.exports.length - 1]; ex.e = x - 1; ex.all = true; }
              return isP(x, ';') ? x + 1 : x;
            }
            return stmt(j, end, sc, fd, top);
          }
          if (isP(i + 1, ':') && !hasOwn(JS_RESERVED, tv)) { kind = 'label'; return stmt(i + 2, end, sc, fd, false); }
        }
        // expression statement
        var ee = expr(i, end, sc, fd, false);
        while (isP(ee, ',')) ee = expr(ee + 1, end, sc, fd, false);
        if (ee <= i) ee = i + 1;
        if (isP(ee, ';')) { lastTok = ee - 1; return ee + 1; }
        lastTok = ee - 1;
        return ee;
      })();
      if (top) {
        var lt = kind === 'expr' ? lastTok : j - 1;
        if (lt >= start && lt < N) R.stmts.push({ kind: kind, a: start, b: lt });
      }
      return j;
    }
    var lastTok = 0;
    try { stmts(0, N, scopeTop, 0, true); } catch (e) { R.failed = String(e && e.message || e); }

    // ---- resolve references ----
    var defines = Object.keys(scopeTop.names), uses = [], late = [];
    var defSet = set(defines);
    refs.forEach(function (r) {
      var s = r.sc;
      while (s) { if (hasOwn(s.names, r.name)) return; s = s.parent; }
      if (r.write && r.fd === 0 && !hasOwn(defSet, r.name)) { defSet[r.name] = 1; defines.push(r.name); }
      if (!r.read) return;
      if (hasOwn(NC.JS_GLOBALS, r.name) || (ts && hasOwn(TS_SKIP, r.name))) return;
      (r.fd === 0 ? uses : late).push(r.name);
    });
    // a name this block assigns itself (x = x + 1) is still read from upstream; a
    // global it only assigns (no read) is not
    uses = uniq(uses);
    var useSet = set(uses);
    late = uniq(late).filter(function (n) { return !hasOwn(useSet, n) && !hasOwn(defSet, n); });
    R.defines = defines;
    R.uses = uses;
    R.lateUses = late;
    R.tokens = T;
    return R;
  };

  // ==== JavaScript run transform ================================================================
  // Rewrites one block for the shared sandbox: top-level bindings become
  // globals (declared once by a `var` prefix, so re-running a const block
  // works and other blocks see them), function declarations are exported at
  // the start (they hoist), static imports become `await import()`, export
  // keywords go, the last expression statement is returned. Edits never add
  // a line break before user code, so error lines stay the block's lines.
  NC.transformJS = function (src, an, opt) {
    opt = opt || {};
    src = String(src);
    an = an || NC.analyzeJS(src, opt);
    var T = an.tokens, edits = [], vars = [];
    function ed(from, to, text) { edits.push({ from: from, to: to, text: text }); }
    function blank(a, b) { ed(a, b, src.slice(a, b).replace(/[^\n]/g, ' ')); }
    an.decls.forEach(function (d) {
      var kw = T[d.kw], semi = !d.inFor && d.top;
      ed(kw.s, kw.e, (semi ? ';' : '') + (kw.e - kw.s > 1 ? new Array(kw.e - kw.s - (semi ? 1 : 0) + 1).join(' ') : ''));
      d.decls.forEach(function (x) {
        vars.push.apply(vars, x.names);
        if (x.pat && x.init) { ed(T[x.s].s, T[x.s].s, '('); ed(T[x.initEnd].e, T[x.initEnd].e, ')'); }
        else if (!x.init && !d.inFor && d.kind !== 'var') ed(T[x.patEnd].e, T[x.patEnd].e, ' = void 0');
      });
    });
    an.classDecls.forEach(function (c) {
      vars.push(c.name);
      ed(T[c.kw].s, T[c.kw].s, ';' + c.name + ' = ');
      if (c.close < T.length) ed(T[c.close].e, T[c.close].e, ';');
    });
    an.imports.forEach(function (im) {
      var a = T[im.s].s, b = T[im.end].e, lines = (src.slice(a, b).match(/\n/g) || []).length;
      var url = im.src || "''", parts = [];
      if (im.ns) { vars.push(im.ns); parts.push(im.ns + ' = await import(' + url + ')'); if (im.def) { vars.push(im.def); parts.push(im.def + ' = ' + im.ns + '.default'); } }
      var props = [];
      if (im.def && !im.ns) { vars.push(im.def); props.push('default: ' + im.def); }
      im.specs.forEach(function (s) { vars.push(s.local); props.push((/^[A-Za-z_$][\w$]*$/.test(s.imported) || /^['"]/.test(s.imported) ? s.imported : JSON.stringify(s.imported)) + ': ' + s.local); });
      if (props.length) parts.push('{' + props.join(', ') + '} = await import(' + url + ')');
      var text = parts.length ? ';(' + parts.join(', ') + ');' : ';await import(' + url + ');';
      ed(a, b + (src.charAt(b) === ';' ? 1 : 0), text + new Array(lines + 1).join('\n'));
    });
    an.exports.forEach(function (x) {
      if (x.all) blank(T[x.s].s, T[x.e].e + (src.charAt(T[x.e].e) === ';' ? 1 : 0));
      else blank(T[x.s].s, T[x.e].e);
    });
    // the value of the last top-level expression statement
    var ret = null, last = an.stmts.length ? an.stmts[an.stmts.length - 1] : null;
    if (last && last.kind === 'expr' && !an.failed) {
      var ft = T[last.a];
      if (!(ft.type === 'name' && hasOwn(STMT_KW, ft.v)) && !(ft.type === 'punc' && ft.v === '{')) ret = { from: ft.s, to: T[last.b].e };
    }
    function apply(list) {
      list = list.slice().sort(function (x, y) { return x.from - y.from || x.to - y.to; });
      var out = '', at = 0;
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e.from < at) continue; // overlapping edit (shouldn't happen): skip it
        out += src.slice(at, e.from) + e.text;
        at = e.to;
      }
      return out + src.slice(at);
    }
    var withRet = ret ? apply(edits.concat([{ from: ret.from, to: ret.from, text: 'return (' }, { from: ret.to, to: ret.to, text: ')' }])) : null;
    vars = uniq(vars.concat(an.defines.filter(function (n) { return an.fnDecls.indexOf(n) === -1; })))
      .filter(function (n) { return /^[A-Za-z_$\u0080-￿][\w$\u0080-￿]*$/.test(n) && !hasOwn(JS_RESERVED, n); });
    return { body: apply(edits), bodyRet: withRet, vars: vars, fns: uniq(an.fnDecls), analysis: an };
  };
  // The sources the sandbox tries in order (the first that compiles runs):
  // loop-checked + return value, loop-checked, plain + return, plain. The
  // last one is also what a syntax error is located against.
  NC.buildJSVariants = function (src, K, fname, opt) {
    var tr = NC.transformJS(src, null, opt);
    var head = (tr.vars.length ? 'var ' + tr.vars.join(',') + ';' : '') + '__nbRun(async function(){' +
      tr.fns.map(function (f) { return '__nbG.' + f + '=' + f + ';'; }).join('');
    var tail = '\n})\n//# sourceURL=' + fname;
    function inst(code) {
      if (!K || !K.instrumentLoops) return null;
      try { var r = K.instrumentLoops(code); return r && r.count ? r.code : null; } catch (e) { return null; }
    }
    var out = [], seen = {};
    function add(body) { if (body == null) return; var s = head + body + tail; if (!hasOwn(seen, s)) { seen[s] = 1; out.push(s); } }
    add(tr.bodyRet ? inst(tr.bodyRet) : null);
    add(inst(tr.body));
    add(tr.bodyRet);
    add(tr.body);
    return { variants: out, vars: tr.vars, fns: tr.fns, analysis: tr.analysis };
  };

  // ==== Python ==================================================================================
  var PY_KW = set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
    'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
    'try', 'while', 'with', 'yield']);
  NC.PY_BUILTINS = set(('abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex copyright ' +
    'credits delattr dict dir divmod enumerate eval exec exit filter float format frozenset getattr globals hasattr hash help hex id input int ' +
    'isinstance issubclass iter len license list locals map max memoryview min next object oct open ord pow print property quit range repr ' +
    'reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ __name__ __file__ __builtins__ __doc__ ' +
    'display NotImplemented Ellipsis self cls Exception BaseException ValueError TypeError KeyError IndexError RuntimeError StopIteration ' +
    'AttributeError NameError ZeroDivisionError ImportError ModuleNotFoundError OSError IOError AssertionError NotImplementedError ArithmeticError ' +
    'LookupError FileNotFoundError PermissionError TimeoutError KeyboardInterrupt SystemExit GeneratorExit RecursionError UnicodeError ' +
    'UnicodeDecodeError UnicodeEncodeError OverflowError MemoryError Warning UserWarning DeprecationWarning EOFError').split(' '));
  var PY_OPS = ['**=', '//=', '>>=', '<<=', '...', '->', ':=', '==', '!=', '<=', '>=', '**', '//', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@='];
  var PY_AUG = set(['+=', '-=', '*=', '/=', '//=', '%=', '**=', '>>=', '<<=', '&=', '|=', '^=', '@=']);

  // -> logical lines [{indent, toks: [{type: name|num|str|op, v}]}]; f-string
  // expressions are spliced in as tokens between ( ) after the string.
  NC.tokenizePy = function (src) {
    src = String(src).replace(/\r\n?/g, '\n');
    var lines = [], cur = null, depth = 0, i = 0, n = src.length, atStart = true;
    function tok(type, v) { if (!cur) cur = { indent: 0, toks: [] }; cur.toks.push({ type: type, v: v }); }
    function endLine() { if (cur && cur.toks.length) lines.push(cur); cur = null; atStart = true; }
    function fexprs(body) {
      var out = [], k = 0;
      while (k < body.length) {
        var ch = body.charAt(k);
        if (ch === '{') {
          if (body.charAt(k + 1) === '{') { k += 2; continue; }
          var d = 1, a = k + 1, e = a, br = 0;
          while (e < body.length && d) {
            var c2 = body.charAt(e);
            if (c2 === '{') d++;
            else if (c2 === '}') { d--; if (!d) break; }
            else if ((c2 === '[' || c2 === '(')) br++;
            else if ((c2 === ']' || c2 === ')')) br--;
            e++;
          }
          var inner = body.slice(a, e), cut = inner.length, bd = 0;
          for (var q = 0; q < inner.length; q++) {
            var c3 = inner.charAt(q);
            if (c3 === '(' || c3 === '[' || c3 === '{') bd++;
            else if (c3 === ')' || c3 === ']' || c3 === '}') bd--;
            else if (!bd && (c3 === '!' && inner.charAt(q + 1) !== '=') || (!bd && c3 === ':' && inner.charAt(q + 1) !== '=')) { cut = q; break; }
          }
          out.push(inner.slice(0, cut).replace(/=\s*$/, ''));
          k = e + 1;
          continue;
        }
        k++;
      }
      return out;
    }
    while (i < n) {
      var c = src.charAt(i);
      if (atStart && depth === 0) {
        var ind = 0, j = i;
        while (j < n && (src.charAt(j) === ' ' || src.charAt(j) === '\t')) { ind = src.charAt(j) === '\t' ? (ind + 8) - (ind % 8) : ind + 1; j++; }
        i = j;
        if (i >= n) break;
        c = src.charAt(i);
        if (c === '\n') { i++; continue; }
        if (c === '#') { while (i < n && src.charAt(i) !== '\n') i++; continue; }
        if (!cur) cur = { indent: ind, toks: [] };
        atStart = false;
      }
      if (c === '\n') { i++; if (depth === 0) endLine(); continue; }
      if (c === ' ' || c === '\t' || c === '\f') { i++; continue; }
      if (c === '#') { while (i < n && src.charAt(i) !== '\n') i++; continue; }
      if (c === '\\' && src.charAt(i + 1) === '\n') { i += 2; continue; }
      var pm = /^([rRbBuUfF]{0,2})(['"])/.exec(src.slice(i, i + 4));
      if (pm && (pm[1] === '' || /^[rRbBuUfF]+$/.test(pm[1])) && (pm[1] || c === '"' || c === "'")) {
        var pre = pm[1], q0 = pm[2], s = i;
        i += pre.length;
        var triple = src.substr(i, 3) === q0 + q0 + q0, qs = triple ? q0 + q0 + q0 : q0, raw = /[rR]/.test(pre);
        i += qs.length;
        var bstart = i;
        while (i < n) {
          if (!raw && src.charAt(i) === '\\') { i += 2; continue; }
          if (raw && src.charAt(i) === '\\' && i + 1 < n) { i += 2; continue; }
          if (src.substr(i, qs.length) === qs) break;
          if (!triple && src.charAt(i) === '\n') break;
          i++;
        }
        var bodyTxt = src.slice(bstart, i);
        i = Math.min(n, i + qs.length);
        tok('str', src.slice(s, i));
        if (/[fF]/.test(pre)) {
          fexprs(bodyTxt).forEach(function (ex) {
            var sub = NC.tokenizePy(ex);
            tok('op', '(');
            sub.forEach(function (l) { l.toks.forEach(function (t) { cur.toks.push(t); }); });
            tok('op', ')');
          });
        }
        continue;
      }
      var cc = c.charCodeAt(0);
      if (isIdStart(cc) && cc !== 36) {
        var s2 = i;
        i++;
        while (i < n && isIdPart(src.charCodeAt(i)) && src.charAt(i) !== '$') i++;
        tok('name', src.slice(s2, i));
        continue;
      }
      if (isDigit(cc) || (c === '.' && isDigit(src.charCodeAt(i + 1)))) {
        var s3 = i;
        i++;
        while (i < n && (isIdPart(src.charCodeAt(i)) || src.charAt(i) === '.' || ((src.charAt(i) === '+' || src.charAt(i) === '-') && /[eE]/.test(src.charAt(i - 1))))) i++;
        tok('num', src.slice(s3, i));
        continue;
      }
      var op = null;
      for (var k = 0; k < PY_OPS.length; k++) if (src.substr(i, PY_OPS[k].length) === PY_OPS[k]) { op = PY_OPS[k]; break; }
      if (!op) op = c;
      if (op === '(' || op === '[' || op === '{') depth++;
      else if (op === ')' || op === ']' || op === '}') depth = Math.max(0, depth - 1);
      i += op.length;
      tok('op', op);
    }
    endLine();
    return lines;
  };

  NC.analyzePython = function (src) {
    var lines = NC.tokenizePy(src);
    var mod = { kind: 'module', indent: -1, locals: {}, assigned: {}, globals: {}, used: [], parent: null };
    var stack = [mod], defines = [], uses = [], late = [], star = false;
    function defineIn(sc, name) {
      if (!name) return;
      if (sc.kind === 'module' || hasOwn(sc.globals, name)) {
        if (!hasOwn(mod.assigned, name)) { mod.assigned[name] = 1; defines.push(name); }
        return;
      }
      sc.locals[name] = 1;
    }
    function useIn(sc, name) {
      if (hasOwn(PY_KW, name)) return;
      if (sc.kind === 'module') {
        if (!hasOwn(mod.assigned, name) && !hasOwn(NC.PY_BUILTINS, name)) uses.push(name);
        return;
      }
      sc.used.push(name);
    }
    // close a def/class scope: its free names go to the enclosing function, or become late uses
    function pop() {
      var sc = stack.pop(), p = stack[stack.length - 1];
      sc.used.forEach(function (nm) {
        if (sc.kind === 'func' && hasOwn(sc.locals, nm) && !hasOwn(sc.globals, nm)) return;
        if (sc.kind === 'class' && hasOwn(sc.locals, nm)) return;
        var fp = p;
        while (fp && fp.kind === 'class') fp = fp.parent;
        if (fp && fp.kind === 'func') fp.used.push(nm);
        else if (!hasOwn(NC.PY_BUILTINS, nm)) late.push(nm);
      });
    }
    // names read in toks[a, b) (attributes, keyword arguments, comprehension and lambda locals left out)
    function exprUses(toks, a, b, sc, locals) {
      locals = locals || {};
      var stackB = [];
      for (var i = a; i < b; i++) {
        var t = toks[i];
        if (t.type === 'op') {
          if (t.v === '(' || t.v === '[' || t.v === '{') {
            var e = closeOf(toks, i, b);
            // comprehension: targets after `for` (up to `in`) are local to the brackets
            var comp = null, d = 0;
            for (var q = i + 1; q < e; q++) {
              var tq = toks[q];
              if (tq.type === 'op' && (tq.v === '(' || tq.v === '[' || tq.v === '{')) d++;
              else if (tq.type === 'op' && (tq.v === ')' || tq.v === ']' || tq.v === '}')) d--;
              else if (!d && tq.type === 'name' && tq.v === 'for') {
                comp = comp || {};
                for (var r = q + 1; r < e && !(toks[r].type === 'name' && toks[r].v === 'in'); r++) if (toks[r].type === 'name') comp[toks[r].v] = 1;
              }
            }
            if (comp) {
              var loc = {};
              for (var k0 in locals) loc[k0] = 1;
              for (var k1 in comp) loc[k1] = 1;
              exprUses(toks, i + 1, e, sc, loc);
              i = e;
              continue;
            }
            stackB.push(t.v);
            continue;
          }
          if (t.v === ')' || t.v === ']' || t.v === '}') { stackB.pop(); continue; }
          continue;
        }
        if (t.type !== 'name') continue;
        var nv = t.v, prev = toks[i - 1], next = toks[i + 1];
        if (nv === 'lambda') {
          var l2 = {}, j = i + 1;
          for (var kk in locals) l2[kk] = 1;
          for (; j < b && !(toks[j].type === 'op' && toks[j].v === ':'); j++) {
            if (toks[j].type === 'name' && !(toks[j - 1] && toks[j - 1].type === 'op' && toks[j - 1].v === '=')) l2[toks[j].v] = 1;
            if (toks[j].type === 'op' && toks[j].v === '=') { var dj = skipDefault(toks, j + 1, b); exprUses(toks, j + 1, dj, sc, locals); j = dj - 1; }
          }
          var be = lambdaEnd(toks, j + 1, b);
          exprUses(toks, j + 1, be, sc, l2);
          i = be - 1;
          continue;
        }
        if (prev && prev.type === 'op' && prev.v === '.') continue;
        if (next && next.type === 'op' && next.v === ':=') { defineIn(sc, nv); continue; }
        if (next && next.type === 'op' && next.v === '=' && stackB.length && stackB[stackB.length - 1] === '(') continue; // f(k=1)
        if (hasOwn(locals, nv)) continue;
        useIn(sc, nv);
      }
    }
    function closeOf(toks, i, b) {
      var d = 0;
      for (var j = i; j < b; j++) {
        var t = toks[j];
        if (t.type !== 'op') continue;
        if (t.v === '(' || t.v === '[' || t.v === '{') d++;
        else if (t.v === ')' || t.v === ']' || t.v === '}') { d--; if (!d) return j; }
      }
      return b;
    }
    function skipDefault(toks, j, b) { var d = 0; for (; j < b; j++) { var t = toks[j]; if (t.type === 'op') { if (t.v === '(' || t.v === '[' || t.v === '{') d++; else if (t.v === ')' || t.v === ']' || t.v === '}') d--; else if (!d && (t.v === ',' || t.v === ':')) return j; } } return b; }
    function lambdaEnd(toks, j, b) { var d = 0; for (; j < b; j++) { var t = toks[j]; if (t.type === 'op') { if (t.v === '(' || t.v === '[' || t.v === '{') d++; else if (t.v === ')' || t.v === ']' || t.v === '}') { if (!d) return j; d--; } else if (!d && t.v === ',') return j; } } return b; }
    // indices of top-level (depth 0) tokens with value v in [a, b)
    function splitTop(toks, a, b, pred) {
      var out = [], d = 0;
      for (var i = a; i < b; i++) {
        var t = toks[i];
        if (t.type === 'op') {
          if (t.v === '(' || t.v === '[' || t.v === '{') d++;
          else if (t.v === ')' || t.v === ']' || t.v === '}') d--;
          else if (!d && pred(t)) out.push(i);
        }
      }
      return out;
    }
    // assignment target toks[a, b): bare names (also inside tuple/list brackets) are bound;
    // names in attribute / subscript targets are read
    function targets(toks, a, b, sc) {
      var parts = [], last = a;
      splitTop(toks, a, b, function (t) { return t.v === ','; }).forEach(function (ci) { parts.push([last, ci]); last = ci + 1; });
      parts.push([last, b]);
      parts.forEach(function (p) {
        var s = p[0], e = p[1];
        if (s >= e) return;
        if (toks[s].type === 'op' && toks[s].v === '*') s++;
        if (s >= e) return;
        var t0 = toks[s];
        if (t0.type === 'op' && (t0.v === '(' || t0.v === '[') && closeOf(toks, s, e) === e - 1) { targets(toks, s + 1, e - 1, sc); return; }
        if (t0.type === 'name' && e - s === 1) { defineIn(sc, t0.v); return; }
        exprUses(toks, s, e, sc);
      });
    }
    function simple(toks, a, b, sc) {
      if (a >= b) return;
      var t = toks[a], v0 = t.type === 'name' ? t.v : '';
      if (v0 === 'import') {
        splitTop(toks, a + 1, b, function (x) { return x.v === ','; }).concat([b]).reduce(function (s, ci) {
          var seg = toks.slice(s, ci), asI = -1;
          for (var q = 0; q < seg.length; q++) if (seg[q].type === 'name' && seg[q].v === 'as') asI = q;
          if (asI !== -1 && seg[asI + 1]) defineIn(sc, seg[asI + 1].v);
          else if (seg[0] && seg[0].type === 'name') defineIn(sc, seg[0].v);
          return ci + 1;
        }, a + 1);
        return;
      }
      if (v0 === 'from') {
        var imp = a + 1;
        while (imp < b && !(toks[imp].type === 'name' && toks[imp].v === 'import')) imp++;
        var s0 = imp + 1, e0 = b;
        if (toks[s0] && toks[s0].type === 'op' && toks[s0].v === '(') { s0++; e0 = closeOf(toks, imp + 1, b); }
        for (var q2 = s0; q2 < e0; q2++) {
          var tk = toks[q2];
          if (tk.type === 'op' && tk.v === '*') { star = true; continue; }
          if (tk.type !== 'name' || tk.v === 'as') continue;
          var nx = toks[q2 + 1];
          if (nx && nx.type === 'name' && nx.v === 'as') { if (toks[q2 + 2]) defineIn(sc, toks[q2 + 2].v); q2 += 2; continue; }
          defineIn(sc, tk.v);
        }
        return;
      }
      if (v0 === 'global' || v0 === 'nonlocal') {
        for (var g = a + 1; g < b; g++) if (toks[g].type === 'name' && v0 === 'global') sc.globals[toks[g].v] = 1;
        return;
      }
      if (v0 === 'del' || v0 === 'pass' || v0 === 'break' || v0 === 'continue') { exprUses(toks, a + 1, b, sc); return; }
      if (v0 === 'return' || v0 === 'yield' || v0 === 'raise' || v0 === 'assert' || v0 === 'await') { exprUses(toks, a + 1, b, sc); return; }
      // assignment / annotated / augmented / expression statement
      // everything after a top-level `lambda` is its expression (its defaults' = and its :)
      var lam = b;
      for (var li = a, ld = 0; li < b; li++) {
        var lt = toks[li];
        if (lt.type === 'op') { if (lt.v === '(' || lt.v === '[' || lt.v === '{') ld++; else if (lt.v === ')' || lt.v === ']' || lt.v === '}') ld--; }
        else if (!ld && lt.type === 'name' && lt.v === 'lambda') { lam = li; break; }
      }
      var before = function (x) { return x < lam; };
      var eqs = splitTop(toks, a, b, function (x) { return x.v === '='; }).filter(before);
      var aug = splitTop(toks, a, b, function (x) { return hasOwn(PY_AUG, x.v); }).filter(before);
      var colon = splitTop(toks, a, b, function (x) { return x.v === ':'; }).filter(before);
      if (aug.length) {
        exprUses(toks, aug[0] + 1, b, sc);
        exprUses(toks, a, aug[0], sc);
        targets(toks, a, aug[0], sc);
        return;
      }
      if (colon.length && (!eqs.length || colon[0] < eqs[0])) { // x: int = 1
        exprUses(toks, colon[0] + 1, eqs.length ? eqs[0] : b, sc);
        if (eqs.length) exprUses(toks, eqs[0] + 1, b, sc);
        if (eqs.length) targets(toks, a, colon[0], sc);
        return;
      }
      if (eqs.length) {
        exprUses(toks, eqs[eqs.length - 1] + 1, b, sc); // the value is evaluated first
        var st = a;
        eqs.forEach(function (ei) { targets(toks, st, ei, sc); st = ei + 1; });
        return;
      }
      exprUses(toks, a, b, sc);
    }
    // a statement on one logical line (compound headers recurse into what follows the colon)
    function statement(toks, a, b, sc, indent) {
      if (a >= b) return;
      var t = toks[a], v0 = t.type === 'name' ? t.v : '';
      if (t.type === 'op' && t.v === '@') { exprUses(toks, a + 1, b, sc); return; }
      if (v0 === 'async' && toks[a + 1] && toks[a + 1].type === 'name' && /^(def|for|with)$/.test(toks[a + 1].v)) { statement(toks, a + 1, b, sc, indent); return; }
      var colon = -1;
      if (/^(def|class|if|elif|else|while|for|with|try|except|finally|match|case)$/.test(v0)) {
        var cs = splitTop(toks, a, b, function (x) { return x.v === ':'; });
        if (v0 === 'def') {
          // the colon that ends the header is the first top-level one after the parameters
          var pe = closeOf(toks, a + 2, b);
          cs = splitTop(toks, pe + 1, b, function (x) { return x.v === ':'; });
        }
        colon = cs.length ? cs[0] : -1;
        if ((v0 === 'match' || v0 === 'case') && colon === -1) colon = -2;
      }
      if (colon === -2) { simple(toks, a, b, sc); return; }
      if (v0 === 'def' && toks[a + 1]) {
        defineIn(sc, toks[a + 1].v);
        var fs = { kind: 'func', indent: indent, locals: {}, assigned: {}, globals: {}, used: [], parent: sc };
        var p0 = a + 2, p1 = closeOf(toks, p0, b);
        // parameters: names are local; defaults and annotations are read outside
        var ps = p0 + 1;
        splitTop(toks, p0 + 1, p1, function (x) { return x.v === ','; }).concat([p1]).forEach(function (ci) {
          var s = ps;
          while (s < ci && toks[s].type === 'op' && (toks[s].v === '*' || toks[s].v === '**' || toks[s].v === '/')) s++;
          if (s < ci && toks[s].type === 'name') fs.locals[toks[s].v] = 1;
          for (var q = s + 1; q < ci; q++) if (toks[q].type === 'op' && (toks[q].v === '=' || toks[q].v === ':')) { exprUses(toks, q + 1, ci, sc); break; }
          ps = ci + 1;
        });
        var ra = -1;
        for (var q3 = p1 + 1; q3 < (colon < 0 ? b : colon); q3++) if (toks[q3].type === 'op' && toks[q3].v === '->') ra = q3;
        if (ra !== -1) exprUses(toks, ra + 1, colon < 0 ? b : colon, sc);
        stack.push(fs);
        if (colon >= 0 && colon + 1 < b) bodyLine(toks, colon + 1, b, fs, indent);
        return;
      }
      if (v0 === 'class' && toks[a + 1]) {
        defineIn(sc, toks[a + 1].v);
        if (toks[a + 2] && toks[a + 2].type === 'op' && toks[a + 2].v === '(') exprUses(toks, a + 2, closeOf(toks, a + 2, b) + 1, sc);
        var csc = { kind: 'class', indent: indent, locals: {}, assigned: {}, globals: {}, used: [], parent: sc };
        stack.push(csc);
        if (colon >= 0 && colon + 1 < b) bodyLine(toks, colon + 1, b, csc, indent);
        return;
      }
      if (v0 === 'for') {
        var inI = a + 1;
        while (inI < b && !(toks[inI].type === 'name' && toks[inI].v === 'in')) inI++;
        exprUses(toks, inI + 1, colon < 0 ? b : colon, sc);
        targets(toks, a + 1, inI, sc);
      } else if (v0 === 'with') {
        var end = colon < 0 ? b : colon;
        splitTop(toks, a + 1, end, function (x) { return x.v === ','; }).concat([end]).reduce(function (s, ci) {
          var asI = -1;
          for (var q = s; q < ci; q++) if (toks[q].type === 'name' && toks[q].v === 'as') asI = q;
          exprUses(toks, s, asI === -1 ? ci : asI, sc);
          if (asI !== -1) targets(toks, asI + 1, ci, sc);
          return ci + 1;
        }, a + 1);
      } else if (v0 === 'except') {
        var e2 = colon < 0 ? b : colon, asJ = -1;
        for (var q4 = a + 1; q4 < e2; q4++) if (toks[q4].type === 'name' && toks[q4].v === 'as') asJ = q4;
        exprUses(toks, a + 1, asJ === -1 ? e2 : asJ, sc);
        if (asJ !== -1 && toks[asJ + 1]) defineIn(sc, toks[asJ + 1].v);
      } else if (colon >= 0) {
        if (v0 === 'case') { for (var q5 = a + 1; q5 < colon; q5++) if (toks[q5].type === 'name' && !hasOwn(PY_KW, toks[q5].v) && !(toks[q5 + 1] && toks[q5 + 1].type === 'op' && (toks[q5 + 1].v === '(' || toks[q5 + 1].v === '.'))) defineIn(sc, toks[q5].v); }
        else exprUses(toks, a + 1, colon, sc);
      } else { bodyLine(toks, a, b, sc, indent); return; }
      if (colon >= 0 && colon + 1 < b) bodyLine(toks, colon + 1, b, sc, indent);
    }
    function bodyLine(toks, a, b, sc, indent) { // simple statements separated by ;
      var s = a;
      splitTop(toks, a, b, function (x) { return x.v === ';'; }).concat([b]).forEach(function (ci) {
        if (s < ci) {
          var t = toks[s];
          if (t.type === 'name' && /^(def|class|if|elif|else|while|for|with|try|except|finally|async)$/.test(t.v)) statement(toks, s, ci, sc, indent);
          else simple(toks, s, ci, sc);
        }
        s = ci + 1;
      });
    }
    lines.forEach(function (L) {
      while (stack.length > 1 && L.indent <= stack[stack.length - 1].indent) pop();
      statement(L.toks, 0, L.toks.length, stack[stack.length - 1], L.indent);
    });
    while (stack.length > 1) pop();
    uses = uniq(uses);
    var useSet = set(uses), defSet = set(defines);
    late = uniq(late).filter(function (n) { return !hasOwn(useSet, n) && !hasOwn(defSet, n); });
    return { defines: defines, uses: uses, lateUses: late, star: star };
  };

  NC.analyze = function (lang, code) {
    try {
      if (lang === 'py') return NC.analyzePython(code);
      var a = NC.analyzeJS(code, { ts: lang === 'ts' });
      return { defines: a.defines, uses: a.uses, lateUses: a.lateUses };
    } catch (e) {
      return { defines: [], uses: [], lateUses: [], failed: String(e && e.message || e) };
    }
  };

  // ==== dependencies ============================================================================
  // cells: [{id, rt, defines, uses, lateUses}] in document order.
  // A name read by a block comes from the nearest block above (same runtime)
  // that defines it, else from the nearest one below; a name read only inside
  // a function comes from a block above only. -> {id: [ids it depends on]}
  NC.deps = function (cells) {
    var out = {};
    cells.forEach(function (c, j) {
      var d = [];
      function from(name, below) {
        for (var i = j - 1; i >= 0; i--) if (cells[i].rt === c.rt && cells[i].defines.indexOf(name) !== -1) return cells[i].id;
        if (below) for (var k = j + 1; k < cells.length; k++) if (cells[k].rt === c.rt && cells[k].defines.indexOf(name) !== -1) return cells[k].id;
        return null;
      }
      (c.uses || []).forEach(function (n) { var x = from(n, true); if (x != null && x !== c.id && d.indexOf(x) === -1) d.push(x); });
      (c.lateUses || []).forEach(function (n) { var x = from(n, false); if (x != null && x !== c.id && d.indexOf(x) === -1) d.push(x); });
      out[c.id] = d;
    });
    return out;
  };
  // After block `rootId` ran: which blocks to re-run and in what order.
  // removed: names the block defined before but no longer does (whoever read them is affected too).
  // -> {order: [ids], cyclic: [ids], blocked: [ids], dependents: [ids]}
  NC.plan = function (cells, rootId, removed) {
    var deps = NC.deps(cells), idx = {}, byId = {}, rdeps = {};
    cells.forEach(function (c, i) { idx[c.id] = i; byId[c.id] = c; rdeps[c.id] = []; });
    cells.forEach(function (c) { deps[c.id].forEach(function (d) { rdeps[d].push(c.id); }); });
    var root = byId[rootId];
    if (!root) return { order: [], cyclic: [], blocked: [], dependents: [] };
    var seen = {}, queue = [rootId];
    seen[rootId] = 1;
    (removed || []).forEach(function (n) {
      cells.forEach(function (c) {
        if (c.id !== rootId && c.rt === root.rt && !hasOwn(seen, c.id) && ((c.uses || []).indexOf(n) !== -1 || (c.lateUses || []).indexOf(n) !== -1)) { seen[c.id] = 1; queue.push(c.id); }
      });
    });
    for (var q = 0; q < queue.length; q++) rdeps[queue[q]].forEach(function (x) { if (!hasOwn(seen, x)) { seen[x] = 1; queue.push(x); } });
    var closure = queue.slice(1).sort(function (a, b) { return idx[a] - idx[b]; });
    var inSet = {};
    queue.forEach(function (id) { inSet[id] = 1; });
    // strongly connected components (Tarjan) over the affected blocks
    var index = 0, st = [], onSt = {}, num = {}, low = {}, cyclic = {};
    function strong(vId) {
      num[vId] = low[vId] = index++;
      st.push(vId); onSt[vId] = 1;
      deps[vId].forEach(function (w) {
        if (!hasOwn(inSet, w)) return;
        if (!hasOwn(num, w)) { strong(w); low[vId] = Math.min(low[vId], low[w]); }
        else if (hasOwn(onSt, w)) low[vId] = Math.min(low[vId], num[w]);
      });
      if (low[vId] === num[vId]) {
        var comp = [], w2;
        do { w2 = st.pop(); delete onSt[w2]; comp.push(w2); } while (w2 !== vId);
        if (comp.length > 1) comp.forEach(function (x) { cyclic[x] = 1; });
      }
    }
    queue.forEach(function (id) { if (!hasOwn(num, id)) strong(id); });
    // blocked: in a cycle, or depending (through affected blocks) on one
    var blocked = {};
    Object.keys(cyclic).forEach(function (k) {
      var id = byId[k] ? byId[k].id : k;
      var stack2 = [id];
      while (stack2.length) {
        var x = stack2.pop();
        if (x === rootId || hasOwn(blocked, x)) continue;
        blocked[x] = 1;
        rdeps[x].forEach(function (y) { if (hasOwn(inSet, y)) stack2.push(y); });
      }
    });
    var runnable = closure.filter(function (id) { return !hasOwn(blocked, id); }), rset = {};
    runnable.forEach(function (id) { rset[id] = 1; });
    // Kahn's algorithm; ties go to document order
    var indeg = {}, order = [];
    runnable.forEach(function (id) { indeg[id] = deps[id].filter(function (d) { return hasOwn(rset, d); }).length; });
    var ready = runnable.filter(function (id) { return !indeg[id]; });
    while (ready.length) {
      ready.sort(function (a, b) { return idx[a] - idx[b]; });
      var n = ready.shift();
      order.push(n);
      rdeps[n].forEach(function (m) { if (hasOwn(rset, m) && --indeg[m] === 0) ready.push(m); });
    }
    var cyc = closure.filter(function (id) { return hasOwn(cyclic, id); });
    if (hasOwn(cyclic, rootId)) cyc.unshift(rootId);
    return {
      order: order,
      cyclic: cyc,
      blocked: closure.filter(function (id) { return hasOwn(blocked, id) && !hasOwn(cyclic, id); }),
      dependents: closure
    };
  };

  // ==== output helpers ==========================================================================
  // The plain-text form of one run's output (console lines, value, error) —
  // what "Insert output as text" / saved ```output blocks contain.
  NC.outputText = function (out) {
    var buf = '';
    function line(t) { if (buf && buf.charAt(buf.length - 1) !== '\n') buf += '\n'; buf += t + '\n'; }
    (out && out.items || []).forEach(function (it) {
      if (it.k === 'log') {
        var t = String(it.text);
        if (it.raw) { buf += t; return; } // a streamed chunk (Python stdout) carries its own line breaks
        if (it.level === 'warn') t = '⚠ ' + t;
        else if (it.level === 'error' && !/^[✖✕⏱]/.test(t)) t = '✖ ' + t;
        line(t);
      } else if (it.text != null) line(String(it.text));
      else line('[' + (it.k || 'output') + ']');
    });
    if (out && out.result && out.result.text != null) line('→ ' + out.result.text);
    if (out && out.error) line('✖ ' + out.error.text + (out.error.line && !/\bline \d+/.test(out.error.text) ? ' (line ' + out.error.line + ')' : ''));
    return buf.replace(/\n$/, '');
  };
  NC.fmtMs = function (ms) {
    ms = Math.max(0, Math.round(ms || 0));
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (Math.round(ms / 100) / 10) + ' s';
    return Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s';
  };
  NC.isImageSrc = function (s) { return typeof s === 'string' && s.length < 20e6 && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+\/]+=*$/.test(s); };

  function escX(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtNum(x) {
    var a = Math.abs(x);
    if (a !== 0 && (a >= 1e6 || a < 1e-3)) return x.toExponential(1);
    return String(Math.round(x * 100) / 100);
  }
  // A small bar / line chart as SVG markup, built only from numbers and
  // escaped labels (spec comes from untrusted sandbox output).
  // spec: {type: 'bar'|'line', title, labels: [..], series: [{name, pts: [[x, y], …]}]}
  NC.chartSVG = function (spec, o) {
    o = o || {};
    var W = o.width || 560, H = o.height || 240, padL = 46, padR = 12, padT = spec && spec.title ? 26 : 12, padB = 30;
    if (!spec || !Array.isArray(spec.series)) return '';
    var series = spec.series.slice(0, 8).map(function (s) {
      return { name: String(s && s.name || '').slice(0, 40), pts: (Array.isArray(s && s.pts) ? s.pts : []).slice(0, 5000).map(function (p) { return [+p[0], +p[1]]; }).filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); }) };
    }).filter(function (s) { return s.pts.length; });
    if (!series.length) return '';
    var labels = Array.isArray(spec.labels) ? spec.labels.slice(0, 500).map(function (l) { return String(l).slice(0, 24); }) : null;
    var type = spec.type === 'bar' ? 'bar' : spec.type === 'scatter' ? 'scatter' : 'line';
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    series.forEach(function (s) { s.pts.forEach(function (p) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }); });
    if (type === 'bar') { y0 = Math.min(0, y0); y1 = Math.max(0, y1); x0 -= 0.5; x1 += 0.5; }
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    if (x0 === x1) { x0 -= 1; x1 += 1; }
    var pw = W - padL - padR, ph = H - padT - padB;
    function X(x) { return padL + (x - x0) / (x1 - x0) * pw; }
    function Y(y) { return padT + (1 - (y - y0) / (y1 - y0)) * ph; }
    var out = ['<svg class="nb-chart" viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' + escX(spec.title || 'chart') + '" xmlns="http://www.w3.org/2000/svg">'];
    if (spec.title) out.push('<text class="nb-ch-title" x="' + padL + '" y="16">' + escX(String(spec.title).slice(0, 80)) + '</text>');
    // axes + 4 grid lines
    for (var g = 0; g <= 4; g++) {
      var gy = y0 + (y1 - y0) * g / 4, py = Y(gy).toFixed(1);
      out.push('<line class="nb-ch-grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + py + '" y2="' + py + '"/>');
      out.push('<text class="nb-ch-ax" x="' + (padL - 6) + '" y="' + (+py + 4) + '" text-anchor="end">' + escX(fmtNum(gy)) + '</text>');
    }
    if (labels && labels.length) {
      var step = Math.max(1, Math.ceil(labels.length / 10));
      labels.forEach(function (l, i) {
        if (i % step) return;
        out.push('<text class="nb-ch-ax" x="' + X(i).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle">' + escX(l) + '</text>');
      });
    } else {
      [x0, (x0 + x1) / 2, x1].forEach(function (x, i) {
        out.push('<text class="nb-ch-ax" x="' + X(x).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="' + (i === 0 ? 'start' : i === 2 ? 'end' : 'middle') + '">' + escX(fmtNum(x)) + '</text>');
      });
    }
    var ns = series.length;
    series.forEach(function (s, si) {
      var cls = 'nb-s' + (si % 6);
      if (type === 'bar') {
        var slot = pw / Math.max(1, (x1 - x0)), bw = Math.max(1, slot * 0.8 / ns);
        s.pts.forEach(function (p) {
          var bx = X(p[0]) - slot * 0.4 + si * bw, by = Y(Math.max(0, p[1])), bh = Math.abs(Y(p[1]) - Y(0));
          out.push('<rect class="' + cls + '" x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.5, bh).toFixed(1) + '"><title>' + escX((labels && labels[p[0]] != null ? labels[p[0]] : fmtNum(p[0])) + ': ' + fmtNum(p[1])) + '</title></rect>');
        });
      } else if (type === 'scatter') {
        s.pts.forEach(function (p) { out.push('<circle class="' + cls + '" cx="' + X(p[0]).toFixed(1) + '" cy="' + Y(p[1]).toFixed(1) + '" r="2.5"/>'); });
      } else {
        var pts = s.pts.slice().sort(function (a, b) { return a[0] - b[0]; });
        out.push('<polyline class="' + cls + ' nb-ch-line" fill="none" points="' + pts.map(function (p) { return X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1); }).join(' ') + '"/>');
      }
    });
    if (ns > 1 || series[0].name) {
      var lx = padL + 4;
      series.forEach(function (s, si) {
        out.push('<rect class="nb-s' + (si % 6) + '" x="' + lx + '" y="' + (padT + 2) + '" width="8" height="8"/><text class="nb-ch-ax" x="' + (lx + 11) + '" y="' + (padT + 10) + '">' + escX(s.name || 'series ' + (si + 1)) + '</text>');
        lx += 24 + Math.min(20, (s.name || 'series ' + (si + 1)).length) * 6;
      });
    }
    out.push('</svg>');
    return out.join('');
  };

  // ==== the sandbox harness =====================================================================
  // Runs INSIDE the notebook's persistent sandbox (sandbox="allow-scripts",
  // opaque origin) after the Code Runner kit's IFRAME_LIB, whose inspector it
  // borrows. One instance keeps the note's JavaScript scope alive between
  // runs: console capture attributed to the block that is running (or that
  // created the timer), display() for rich output, loop checks against the
  // run's deadline, timer cleanup when a block re-runs, a variables listing.
  // ES5 only; shipped as source via Function.prototype.toString — it must
  // never contain a closing script tag or an HTML comment opener.
  function NB_LIB(G, TOKEN) {
    var P = G.parent, I = G.__crInspect || null;
    var oST = G.setTimeout, oCT = G.clearTimeout, oSI = G.setInterval, oCI = G.clearInterval;
    var oRAF = G.requestAnimationFrame, oCAF = G.cancelAnimationFrame;
    var perf = (G.performance && G.performance.now) ? function () { return G.performance.now(); } : function () { return Date.now(); };
    var run = null, lastCell = null, ctxCell = null, probing = false;
    var timers = {}, outQ = {}, outT = 0, caps = {};
    var lpN = 0, inTask = false, taskT0 = 0, baseline = {};
    var hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

    function post(m) { m.__nb = TOKEN; try { P.postMessage(m, '*'); } catch (e) {} }
    function insp(v, d) { try { return I ? I.inspect(v, d == null ? 2 : d) : String(v); } catch (e) { return '[uninspectable]'; } }
    function fmtArgs(a) { try { return I ? I.formatArgs(a) : [].join.call(a, ' '); } catch (e) { return '?'; } }
    function cellNow() { return ctxCell != null ? ctxCell : (run ? run.cell : lastCell); }
    function cap(cell) { return caps[cell] || (caps[cell] = { n: 0, chars: 0, drop: 0, disp: 0 }); }
    function emit(level, text) {
      var cell = cellNow();
      if (cell == null) return;
      var c = cap(cell);
      text = String(text);
      if (c.n >= 2000 || c.chars >= 300000) { c.drop++; return; }
      if (text.length > 20000) text = text.slice(0, 20000) + '…';
      c.n++; c.chars += text.length;
      (outQ[cell] || (outQ[cell] = [])).push([level, text]);
      if (!outT) outT = oST(flush, 40);
    }
    function flush() {
      if (outT) { oCT(outT); outT = 0; }
      for (var k in outQ) if (hasOwn(outQ, k) && outQ[k].length) post({ type: 'out', cell: +k, items: outQ[k] });
      outQ = {};
    }
    function show(item) {
      var cell = cellNow();
      if (cell == null || !item) return;
      var c = cap(cell);
      if (c.disp >= 60) { c.drop++; return; }
      c.disp++;
      flush();
      post({ type: 'display', cell: cell, item: item });
    }

    // ---- values -> output items ----
    function oneLine(s, max) { s = String(s).replace(/\s*\n\s*/g, ' '); return s.length > (max || 200) ? s.slice(0, (max || 200) - 1) + '…' : s; }
    function isCanvas(v) { try { return typeof G.HTMLCanvasElement !== 'undefined' && v instanceof G.HTMLCanvasElement || (typeof G.OffscreenCanvas !== 'undefined' && v instanceof G.OffscreenCanvas); } catch (e) { return false; } }
    function canvasSrc(cv) {
      if (cv.toDataURL) return cv.toDataURL('image/png');
      var c2 = G.document.createElement('canvas'); c2.width = cv.width; c2.height = cv.height;
      c2.getContext('2d').drawImage(cv.transferToImageBitmap ? cv.transferToImageBitmap() : cv, 0, 0);
      return c2.toDataURL('image/png');
    }
    function isRows(a) {
      if (!a.length) return false;
      for (var i = 0; i < a.length && i < 50; i++) {
        var r = a[i];
        if (r === null || typeof r !== 'object' || typeof r.nodeType === 'number') return false;
      }
      return true;
    }
    function tableItem(rows, text) {
      var cols = [], seen = {}, out = [], i, j, isArr = Array.isArray(rows);
      var keys = isArr ? null : Object.keys(rows);
      var n = isArr ? rows.length : keys.length;
      for (i = 0; i < n && i < 500; i++) {
        var r = isArr ? rows[i] : rows[keys[i]];
        if (r === null || typeof r !== 'object') { if (!hasOwn(seen, '\u0000v')) { seen['\u0000v'] = 1; cols.push('\u0000v'); } continue; }
        var rk = Object.keys(r);
        for (j = 0; j < rk.length && cols.length < 40; j++) if (!hasOwn(seen, rk[j])) { seen[rk[j]] = 1; cols.push(rk[j]); }
      }
      for (i = 0; i < n && i < 500; i++) {
        var row = isArr ? rows[i] : rows[keys[i]], line = [isArr ? String(i) : String(keys[i])];
        for (j = 0; j < cols.length; j++) {
          var k = cols[j], val;
          if (k === '\u0000v') line.push(row === null || typeof row !== 'object' ? oneLine(insp(row, 0)) : '');
          else if (row !== null && typeof row === 'object' && hasOwn(row, k)) { val = row[k]; line.push(typeof val === 'string' ? oneLine(val) : oneLine(insp(val, 0))); }
          else line.push('');
        }
        out.push(line);
      }
      var tt = text;
      if (tt == null) { try { tt = I && I.table ? I.table(rows) : insp(rows); } catch (e) { tt = insp(rows); } }
      return { k: 'table', cols: ['(index)'].concat(cols.map(function (c) { return c === '\u0000v' ? 'Values' : c; })), rows: out, total: n, text: tt };
    }
    function tree(v, depth, budget, seen) {
      var t = Object.prototype.toString.call(v).slice(8, -1), head = t, kids = [], more = 0, i, n = 0;
      if (Array.isArray(v)) head = 'Array(' + v.length + ')';
      else if (t === 'Map') head = 'Map(' + v.size + ')';
      else if (t === 'Set') head = 'Set(' + v.size + ')';
      else { try { var p = Object.getPrototypeOf(v), c = p && p.constructor; head = p === null ? 'Object' : (c && c.name) || t; } catch (e) {} }
      function child(x) {
        if (x !== null && typeof x === 'object' && depth < 5 && budget.n > 0 && seen.indexOf(x) === -1 && typeof x.nodeType !== 'number' && !(x instanceof G.Error) && Object.prototype.toString.call(x) !== 'Date') {
          budget.n--;
          seen.push(x);
          var r = tree(x, depth + 1, budget, seen);
          seen.pop();
          return r;
        }
        return oneLine(insp(x, 0), 300);
      }
      try {
        if (Array.isArray(v) || ArrayBuffer.isView(v)) { for (i = 0; i < v.length; i++) { if (n++ >= 100) { more = v.length - 100; break; } kids.push([String(i), child(v[i])]); } }
        else if (t === 'Map') { v.forEach(function (val, key) { if (n++ >= 100) { more++; return; } kids.push([oneLine(insp(key, 0), 80), child(val)]); }); }
        else if (t === 'Set') { var si = 0; v.forEach(function (val) { if (n++ >= 100) { more++; return; } kids.push([String(si++), child(val)]); }); }
        else { var ks = Object.keys(v); for (i = 0; i < ks.length; i++) { if (n++ >= 100) { more = ks.length - 100; break; } var d = Object.getOwnPropertyDescriptor(v, ks[i]); kids.push([ks[i], d && (d.get || d.set) ? '[Getter/Setter]' : child(v[ks[i]])]); } }
      } catch (e) {}
      return { h: head, c: kids, more: more };
    }
    function rich(v) {
      try {
        if (v === undefined) return null;
        if (v !== null && typeof v === 'object') {
          if (isCanvas(v)) return { k: 'image', src: canvasSrc(v), w: v.width, h: v.height };
          if (typeof G.ImageData !== 'undefined' && v instanceof G.ImageData) {
            var c = G.document.createElement('canvas'); c.width = v.width; c.height = v.height; c.getContext('2d').putImageData(v, 0, 0);
            return { k: 'image', src: c.toDataURL('image/png'), w: v.width, h: v.height };
          }
          if (typeof G.HTMLImageElement !== 'undefined' && v instanceof G.HTMLImageElement && /^data:image\//.test(v.src)) return { k: 'image', src: v.src };
          if (v.nodeType === 1) return { k: 'html', html: String(v.outerHTML).slice(0, 2000000), text: insp(v) };
          if (Array.isArray(v) && isRows(v)) return tableItem(v);
          var tag = Object.prototype.toString.call(v);
          if (!(v instanceof G.Error) && tag !== '[object Date]' && tag !== '[object RegExp]' && tag !== '[object Promise]' && (Array.isArray(v) || ArrayBuffer.isView(v) || tag === '[object Object]' || tag === '[object Map]' || tag === '[object Set]')) {
            var tr = tree(v, 0, { n: 1500 }, [v]);
            if (tr.c.length) return { k: 'tree', tree: tr, text: insp(v, 2) };
          }
        }
        return { k: 'text', text: insp(v, 2) };
      } catch (e) { return { k: 'text', text: insp(v) }; }
    }
    function chartSpec(data, o) {
      o = o || {};
      var labels = null, series = [], i;
      function num(x) { x = +x; return isFinite(x) ? x : null; }
      function numberish(x) { return typeof x === 'number' || (typeof x === 'string' && x.trim() !== '' && isFinite(+x)); }
      if (Array.isArray(data) && data.length) {
        if (data.every(numberish)) series.push({ name: o.name || '', pts: data.map(function (y, k) { return [k, num(y)]; }) });
        else if (data.every(function (p) { return Array.isArray(p) && p.length >= 2 && numberish(p[1]); })) {
          if (data.every(function (p) { return numberish(p[0]); })) series.push({ name: o.name || '', pts: data.map(function (p) { return [num(p[0]), num(p[1])]; }) });
          else { labels = data.map(function (p) { return String(p[0]); }); series.push({ name: o.name || '', pts: data.map(function (p, k) { return [k, num(p[1])]; }) }); }
        } else if (data.every(function (r) { return r && typeof r === 'object'; })) {
          var ks = Object.keys(data[0]), xk = o.x, yks = o.y ? [].concat(o.y) : null;
          if (!xk) for (i = 0; i < ks.length; i++) if (!numberish(data[0][ks[i]]) || /^(x|label|name|date|key|category)$/i.test(ks[i])) { xk = ks[i]; break; }
          if (!yks) yks = ks.filter(function (k) { return k !== xk && numberish(data[0][k]); });
          var numericX = xk && data.every(function (r) { return numberish(r[xk]); });
          if (xk && !numericX) labels = data.map(function (r) { return String(r[xk]); });
          yks.slice(0, 8).forEach(function (yk) {
            series.push({ name: yk, pts: data.map(function (r, k) { return [xk && numericX ? num(r[xk]) : k, num(r[yk])]; }) });
          });
        }
      } else if (data && typeof data === 'object') {
        var keys = Object.keys(data);
        if (keys.length && keys.every(function (k) { return numberish(data[k]); })) {
          labels = keys;
          series.push({ name: o.name || '', pts: keys.map(function (k, j) { return [j, num(data[k])]; }) });
        } else keys.slice(0, 8).forEach(function (k) {
          if (Array.isArray(data[k])) series.push({ name: k, pts: data[k].map(function (y, j) { return Array.isArray(y) ? [num(y[0]), num(y[1])] : [j, num(y)]; }) });
        });
      }
      series.forEach(function (s) { s.pts = s.pts.filter(function (p) { return p[0] !== null && p[1] !== null; }).slice(0, 5000); });
      return { type: o.type || (labels ? 'bar' : 'line'), title: o.title ? String(o.title).slice(0, 80) : '', labels: labels ? labels.slice(0, 500) : null, series: series };
    }
    var display = function (v) {
      for (var i = 0; i < arguments.length; i++) {
        var x = arguments[i];
        show(typeof x === 'string' ? { k: 'text', text: x } : (rich(x) || { k: 'text', text: 'undefined' }));
      }
    };
    display.html = function (s) { show({ k: 'html', html: String(s == null ? '' : s).slice(0, 2000000) }); };
    display.svg = display.html;
    display.text = function (s) { show({ k: 'text', text: String(s) }); };
    display.json = function (v) { show(v !== null && typeof v === 'object' ? { k: 'tree', tree: tree(v, 0, { n: 1500 }, [v]), text: insp(v, 2) } : { k: 'text', text: insp(v) }); };
    display.table = function (rows) { show(rows !== null && typeof rows === 'object' ? tableItem(rows) : { k: 'text', text: insp(rows) }); };
    display.image = function (x) {
      if (typeof x === 'string') { show({ k: 'image', src: x }); return; }
      show(rich(x));
    };
    display.chart = function (data, o) { var sp = chartSpec(data, o); show(sp.series.length ? { k: 'chart', spec: sp, text: '[chart' + (sp.title ? ': ' + sp.title : '') + ']' } : { k: 'text', text: 'display.chart: nothing to plot' }); };
    display.clear = function () { var cell = cellNow(); if (cell != null) { flush(); post({ type: 'clear', cell: cell }); } };
    G.display = display;

    // ---- errors ----
    function errInfo(e) {
      var text, frames = [];
      if (e !== null && (typeof e === 'object' || typeof e === 'function')) {
        var name = 'Error', msg = '', st = '';
        try { name = String(e.name || 'Error'); msg = e.message != null ? String(e.message) : ''; } catch (x) {}
        try { st = String(e.stack || ''); } catch (x) {}
        text = (e instanceof G.Error || st) ? (msg ? name + ': ' + msg : name) : 'Uncaught ' + insp(e, 2);
        var re = /(?:at\s+(?:(.*?)\s+\()?|^\s*(?:(.*?)@)?)[^\s(]*?nb-(\d+)\.js:(\d+)(?::(\d+))?/gm, m;
        while ((m = re.exec(st)) && frames.length < 8) {
          var fn = (m[1] || m[2] || '').replace(/^async\s+/, '');
          if (/^(eval|<anonymous>|global code)$/.test(fn) || /__nbRun/.test(fn)) fn = '';
          // the block's wrapper call (unnamed, on its first line, below a frame of that block) is noise
          if (!fn && +m[4] === 1 && frames.some(function (f) { return f.cell === +m[3]; })) continue;
          frames.push({ cell: +m[3], line: +m[4], fn: fn });
        }
      } else text = 'Uncaught ' + insp(e, 2);
      return { text: text, frames: frames };
    }
    // locate a syntax error: insert the source as a script (it never runs —
    // it doesn't parse) and read the error event's line
    function syntaxInfo(src) {
      var got = null, s = G.document.createElement('script');
      function on(ev) {
        got = { text: String(ev.message || 'SyntaxError').replace(/^Uncaught\s+/, '').replace(/^SyntaxError: Failed to execute '[^']*' on '[^']*': /, 'SyntaxError: '), line: ev.lineno || 0 };
        try { ev.preventDefault(); ev.stopImmediatePropagation(); } catch (e) {}
      }
      probing = true;
      G.addEventListener('error', on, true);
      try { s.text = src; G.document.head.appendChild(s); } catch (e) { if (!got) got = { text: String(e && e.message || e), line: 0 }; }
      G.removeEventListener('error', on, true);
      probing = false;
      try { s.remove(); } catch (e) {}
      if (got && !/^\w*Error/.test(got.text)) got.text = 'SyntaxError: ' + got.text;
      return got || { text: 'SyntaxError', line: 0 };
    }
    G.addEventListener('error', function (ev) {
      if (probing || !ev) return;
      if (!ev.message && !ev.error) return;
      emit('error', '✖ Uncaught ' + (ev.error ? errInfo(ev.error).text : String(ev.message).replace(/^Uncaught\s+/, '')));
      try { ev.preventDefault(); } catch (e) {}
    });
    G.addEventListener('unhandledrejection', function (ev) {
      emit('error', '✖ Uncaught (in promise) ' + errInfo(ev && ev.reason).text);
      try { ev.preventDefault(); } catch (e) {}
    });

    // ---- console ----
    var C = G.console || (G.console = {}), counts = {}, timeL = {}, indent = '';
    ['log', 'info', 'debug', 'warn', 'error'].forEach(function (m) {
      C[m] = function () { emit(m === 'debug' || m === 'info' ? 'log' : m, indent + fmtArgs([].slice.call(arguments)).replace(/\n/g, '\n' + indent)); };
    });
    C.dir = function (v) { emit('log', insp(v, 2)); };
    C.table = function (d, cols) { if (d !== null && typeof d === 'object') show(tableItem(d, I && I.table ? I.table(d, cols) : null)); else C.log(d); };
    C.assert = function (c) { if (!c) emit('error', 'Assertion failed' + (arguments.length > 1 ? ': ' + fmtArgs([].slice.call(arguments, 1)) : '')); };
    C.count = function (l) { l = l === undefined ? 'default' : String(l); counts[l] = (counts[l] || 0) + 1; emit('log', l + ': ' + counts[l]); };
    C.countReset = function (l) { counts[l === undefined ? 'default' : String(l)] = 0; };
    C.time = function (l) { timeL[l === undefined ? 'default' : String(l)] = perf(); };
    C.timeLog = C.timeEnd = function (l) {
      var k = l === undefined ? 'default' : String(l);
      if (!hasOwn(timeL, k)) { emit('warn', "Timer '" + k + "' does not exist"); return; }
      emit('log', k + ': ' + (Math.round((perf() - timeL[k]) * 1000) / 1000) + 'ms');
    };
    C.group = C.groupCollapsed = function () { if (arguments.length) C.log.apply(C, arguments); indent += '  '; };
    C.groupEnd = function () { indent = indent.slice(2); };
    C.trace = function () { emit('log', 'Trace' + (arguments.length ? ': ' + fmtArgs([].slice.call(arguments)) : '')); };
    C.clear = function () { display.clear(); };

    // ---- timers belong to the block that set them ----
    function call(owner, f, args) {
      var prev = ctxCell;
      ctxCell = owner;
      try { f.apply(G, args); } catch (e) { emit('error', '✖ Uncaught ' + errInfo(e).text); }
      finally { ctxCell = prev; }
    }
    function strFn(fn) { return typeof fn === 'function' ? fn : function () { (0, G.eval)(String(fn)); }; }
    G.setTimeout = function (fn, ms) {
      var args = [].slice.call(arguments, 2), owner = cellNow(), f = strFn(fn), id;
      id = oST(function () { delete timers['t' + id]; call(owner, f, args); }, ms);
      timers['t' + id] = { cell: owner, kind: 't', id: id };
      return id;
    };
    G.setInterval = function (fn, ms) {
      var args = [].slice.call(arguments, 2), owner = cellNow(), f = strFn(fn), id;
      id = oSI(function () { call(owner, f, args); }, ms);
      timers['i' + id] = { cell: owner, kind: 'i', id: id };
      return id;
    };
    G.clearTimeout = function (id) { delete timers['t' + id]; oCT(id); };
    G.clearInterval = function (id) { delete timers['i' + id]; oCI(id); };
    if (oRAF) {
      G.requestAnimationFrame = function (fn) {
        var owner = cellNow(), id;
        id = oRAF.call(G, function (ts) { delete timers['r' + id]; call(owner, fn, [ts]); });
        timers['r' + id] = { cell: owner, kind: 'r', id: id };
        return id;
      };
      G.cancelAnimationFrame = function (id) { delete timers['r' + id]; oCAF.call(G, id); };
    }
    function dispose(cell) {
      for (var k in timers) {
        if (!hasOwn(timers, k)) continue;
        var t = timers[k];
        if (cell != null && t.cell !== cell) continue;
        if (t.kind === 't') oCT(t.id); else if (t.kind === 'i') oCI(t.id); else if (oCAF) oCAF.call(G, t.id);
        delete timers[k];
      }
    }

    // ---- loop checks (inserted into every loop header by the kit) ----
    G.__cadeLP = function (id) {
      if ((++lpN & 63) !== 0) return true;
      var now = perf();
      if (run) {
        if (run.stop) throw new Error('Interrupted');
        if (now > run.deadline) { run.timedOut = true; throw new Error('Timed out after ' + Math.round(run.timeout / 100) / 10 + ' s — stopped a loop'); }
        return true;
      }
      if (!inTask) { inTask = true; taskT0 = now; oST(function () { inTask = false; }, 0); return true; }
      if (now - taskT0 > 2000) throw new Error('A loop ran for more than 2 s — stopped (line ' + id + ')');
      return true;
    };
    G.__nbG = G;
    G.__nbRun = function (fn) { return fn(); };

    // ---- runs ----
    function compiles(src) {
      try { new G.Function(src); return true; } catch (e) { return !(e instanceof G.SyntaxError); }
    }
    function finish(r, status, result, error) {
      if (r.done) return;
      r.done = true;
      if (r.timer) oCT(r.timer);
      if (run === r) run = null;
      flush();
      var c = caps[r.cell];
      post({ type: 'done', id: r.id, cell: r.cell, status: status, ms: Math.round(perf() - r.t0), result: result || null, error: error || null, dropped: c ? c.drop : 0 });
    }
    function doRun(m) {
      if (run) finish(run, 'stopped', null, { text: 'Stopped' });
      dispose(m.cell);
      caps[m.cell] = { n: 0, chars: 0, drop: 0, disp: 0 };
      var timeout = Math.max(500, +m.timeout || 5000), t0 = perf();
      var r = run = { id: m.id, cell: m.cell, t0: t0, deadline: t0 + timeout, timeout: timeout, stop: false, done: false, timedOut: false };
      lastCell = m.cell;
      var vs = m.variants || [], src = null, i;
      for (i = 0; i < vs.length; i++) if (compiles(vs[i])) { src = vs[i]; break; }
      if (src == null) { finish(r, 'error', null, syntaxInfo(vs[vs.length - 1] || '')); return; }
      var p;
      try { p = (0, G.eval)(src); } catch (e) { finish(r, 'error', null, errInfo(e)); return; }
      r.timer = oST(function () {
        r.timedOut = true;
        dispose(r.cell);
        finish(r, 'timeout', null, { text: 'Timed out after ' + Math.round(timeout / 100) / 10 + ' s — the block was still waiting (a promise that never settled?)' });
      }, timeout);
      Promise.resolve(p).then(function (v) {
        if (r.done) return;
        r.t1 = perf();
        finish(r, 'ok', rich(v), null);
      }, function (e) {
        var info = errInfo(e);
        if (r.stop || r.timedOut) info.text = info.text.replace(/^Error: /, '');
        finish(r, r.stop ? 'stopped' : r.timedOut ? 'timeout' : 'error', null, info);
      });
    }
    function vars() {
      var out = [], names = Object.getOwnPropertyNames(G);
      for (var i = 0; i < names.length && out.length < 400; i++) {
        var n = names[i];
        if (hasOwn(baseline, n) || /^__(nb|cr|cade)/.test(n)) continue;
        var d = null;
        try { d = Object.getOwnPropertyDescriptor(G, n); } catch (e) {}
        if (!d) continue;
        var val = d.value, t;
        if (!('value' in d)) { out.push([n, 'getter', '']); continue; }
        if (val === null) t = 'null';
        else if (Array.isArray(val)) t = 'Array(' + val.length + ')';
        else if (typeof val === 'function') { var src = ''; try { src = Function.prototype.toString.call(val); } catch (e) {} t = /^class[\s{]/.test(src) ? 'class' : 'function'; }
        else if (typeof val === 'object') { try { var pr = Object.getPrototypeOf(val); t = pr === null ? 'Object' : (pr.constructor && pr.constructor.name) || 'Object'; } catch (e) { t = 'object'; } if (t === 'Map' || t === 'Set') t += '(' + val.size + ')'; }
        else t = typeof val;
        out.push([n, t, oneLine(insp(val, 0), 160)]);
      }
      return out;
    }
    G.addEventListener('message', function (e) {
      if (e.source !== P) return;
      var m = e.data;
      if (!m || m.__nb !== TOKEN) return;
      if (m.type === 'run') doRun(m);
      else if (m.type === 'interrupt') {
        if (run) { run.stop = true; dispose(run.cell); finish(run, 'stopped', null, { text: 'Stopped' }); }
        else dispose(null);
        post({ type: 'interrupted', id: m.id });
      } else if (m.type === 'dispose') dispose(m.cell == null ? null : m.cell);
      else if (m.type === 'vars') post({ type: 'vars', id: m.id, list: vars() });
    });
    var own = Object.getOwnPropertyNames(G);
    for (var b = 0; b < own.length; b++) baseline[own[b]] = 1;
    post({ type: 'ready' });
  }
  NC.NB_LIB = NB_LIB;
  NC.sandboxDoc = function (token, libSrc) {
    return '<!doctype html><html><head><meta charset="utf-8"><script>\n' + (libSrc || '') + '\n(' + NB_LIB.toString() + ')(window, ' +
      JSON.stringify(String(token)).replace(/</g, '\\u003c') + ');\n</script></head><body></body></html>';
  };

  // ==== preferences (the contract's fallback until the core provides Cade.prefs) ===============
  // Fallback objects are shared through window.__cadePrefsFallback so the
  // Code Runner engine and the notebook see the same values and listeners.
  var NODE_PREFS = {};
  NC.prefsOf = function (Cade, id, fields) {
    if (Cade && typeof Cade.prefs === 'function') {
      try { var p = Cade.prefs(id); if (p && typeof p.get === 'function') return p; } catch (e) {}
    }
    var reg = root ? (root.__cadePrefsFallback || (root.__cadePrefsFallback = {})) : NODE_PREFS;
    if (reg[id]) return reg[id];
    var d = {}, ls = [];
    (fields || []).forEach(function (f) { if (f.key) d[f.key] = f.default; });
    return (reg[id] = {
      fallback: true,
      get: function (k) { return d[k]; },
      all: function () { var o = {}; for (var k in d) o[k] = d[k]; return o; },
      set: function (k, val) { d[k] = val; ls.slice().forEach(function (fn) { try { fn(k, val, this.all()); } catch (e) {} }, this); },
      on: function (fn) { ls.push(fn); return function () { var i = ls.indexOf(fn); if (i >= 0) ls.splice(i, 1); }; }
    });
  };
  // The notebook's own preferences (= the manifest entry's "prefs") and the
  // core's "Code blocks" page as far as the notebook reads it.
  NC.PREFS = {
    title: 'Notebook',
    fields: [
      { key: 'autoRun', type: 'toggle', label: 'Re-run dependent blocks automatically', default: true,
        hint: 'After you run a block, the blocks that use its variables run again (in order). Off: they are only marked stale.' },
      { key: 'timings', type: 'toggle', label: 'Show run times', default: true },
      { key: 'maxHeight', type: 'slider', label: 'Output height limit', default: 320, min: 120, max: 800, step: 20, unit: 'px' },
      { key: 'saveOutputs', type: 'toggle', label: 'Also save text output in the note', default: false,
        hint: 'Writes an ```output block under each block, like Code Runner. Blocks that already have one are always kept up to date. Tables, charts and images stay view-only.' },
      { type: 'heading', label: 'Time limits' },
      { key: 'jsTimeout', type: 'number', label: 'JavaScript time limit', default: 5, min: 1, max: 120, step: 1, unit: 's' },
      { key: 'pyTimeout', type: 'number', label: 'Python time limit', default: 30, min: 1, max: 600, step: 1, unit: 's' }
    ]
  };
  NC.CODEBLOCK_FIELDS = [{ key: 'linked', type: 'toggle', label: 'Linked blocks', default: true }];

  if (root) root.__cadeNotebookCore = NC;
  if (typeof module === 'object' && module && module.exports) module.exports = NC;
})(typeof window !== 'undefined' ? window : null);
