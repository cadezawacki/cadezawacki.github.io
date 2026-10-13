/* Code Runner kit — shared, DOM-free helpers for the Code Runner (run ```
 * code blocks) and Live HTML Preview widgets, plus the source of the harness
 * that runs INSIDE each sandboxed iframe.
 *
 * - Fence scanning uses the core's rule (a line starting with ``` opens or
 *   closes a block) so blocks here are exactly the blocks the editor styles.
 * - The ```output planner replaces the output block directly below a code
 *   block (one blank line allowed in between) instead of stacking new ones.
 * - Loop protection: Safari runs iframes on the app's main thread, so a
 *   `while (true) {}` in a sandbox would freeze the whole app and no timer
 *   could ever kill it. Every loop header gets a cheap time check that throws
 *   once the run's time budget is spent.
 * - JSON validator with line/column errors (browser JSON.parse messages differ
 *   and Safari's carry no position at all).
 * - Python traceback cleaner (drops Pyodide's own frames).
 *
 * Loaded by script injection (not a manifest module); also require()-able in
 * node for unit checks. Self-contained IIFE. */
(function (root) {
  'use strict';
  var K = {};

  // ---- languages ---------------------------------------------------------------
  var LANG = {
    js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', node: 'js', es6: 'js',
    ts: 'ts', typescript: 'ts', mts: 'ts', cts: 'ts',
    py: 'py', python: 'py', python3: 'py', py3: 'py', pyodide: 'py',
    json: 'json',
    html: 'html', htm: 'html', xhtml: 'html',
    css: 'css',
    sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell', terminal: 'shell',
    powershell: 'shell', ps: 'shell', ps1: 'shell', pwsh: 'shell', cmd: 'shell', bat: 'shell', batch: 'shell', fish: 'shell',
    output: 'output'
  };
  K.LANG = LANG;
  // First word of the info string; tolerates ```{python} and ```.js styles.
  K.langOf = function (info) {
    var w = String(info || '').trim().replace(/^[{.]+/, '').split(/[\s},:;]/)[0].toLowerCase();
    return Object.prototype.hasOwnProperty.call(LANG, w) ? LANG[w] : null;
  };
  K.RUNNABLE = { js: 1, ts: 1, py: 1, json: 1 };

  // ---- fences --------------------------------------------------------------------
  // doc: CodeMirror Text-like ({lines, line(n) -> {from,to,text,number}, sliceString}).
  function isFence(t) { return t.charCodeAt(0) === 96 && t.lastIndexOf('```', 0) === 0; }
  K.isFence = isFence;
  K.scanFences = function (doc) {
    var blocks = [], open = null;
    for (var i = 1; i <= doc.lines; i++) {
      var l = doc.line(i), t = l.text;
      if (!isFence(t)) continue;
      if (!open) {
        var info = t.slice(3).trim();
        open = { open: i, close: -1, info: info, lang: K.langOf(info), openFrom: l.from, closeFrom: -1 };
      } else {
        open.close = i; open.closeFrom = l.from;
        blocks.push(open); open = null;
      }
    }
    if (open) blocks.push(open);
    return blocks;
  };
  // The block containing (1-based) line n, fence lines included.
  K.blockAt = function (blocks, n) {
    var lo = 0, hi = blocks.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, b = blocks[mid];
      if (n < b.open) hi = mid - 1;
      else if (b.close !== -1 && n > b.close) lo = mid + 1;
      else return b;
    }
    return null;
  };
  K.blockIndex = function (blocks, b) {
    for (var i = 0; i < blocks.length; i++) if (blocks[i] === b) return i;
    return -1;
  };
  // Inner text of a block (between the fence lines).
  K.codeOf = function (doc, b) {
    var first = b.open + 1, last = b.close === -1 ? doc.lines : b.close - 1;
    if (first > last) { var p = doc.line(b.open).to; return { from: p, to: p, text: '', firstLine: first }; }
    var from = doc.line(first).from, to = doc.line(last).to;
    return { from: from, to: to, text: doc.sliceString(from, to), firstLine: first };
  };

  // ---- ```output blocks ------------------------------------------------------------
  var OUT_RE = /^```\s*output(?:\s|$)/i;
  K.isOutputOpen = function (t) { return OUT_RE.test(t); };
  // The ```output block right below code block b (one blank line allowed).
  K.findOutputAfter = function (doc, b) {
    if (b.close === -1) return null;
    var k = b.close + 1;
    if (k <= doc.lines && !doc.line(k).text.trim()) k++;
    if (k > doc.lines || !OUT_RE.test(doc.line(k).text)) return null;
    for (var m = k + 1; m <= doc.lines; m++) {
      if (isFence(doc.line(m).text)) return { open: k, close: m, from: doc.line(k).from, to: doc.line(m).to };
    }
    return null; // unclosed: leave it alone
  };
  // Change that writes `blockText` (a full ```output … ``` block) below b,
  // replacing an existing output block.
  K.outputChange = function (doc, b, blockText) {
    var end = doc.line(b.close).to, ex = K.findOutputAfter(doc, b);
    return { from: end, to: ex ? ex.to : end, insert: '\n' + blockText };
  };
  // Changes removing every closed ```output block (with the newline before it).
  K.outputRemovals = function (doc) {
    var out = [];
    K.scanFences(doc).forEach(function (b) {
      if (b.lang !== 'output' || b.close === -1) return;
      var to = doc.line(b.close).to;
      if (b.open > 1) out.push({ from: doc.line(b.open - 1).to, to: to });
      else out.push({ from: 0, to: Math.min(doc.length, to + 1) });
    });
    return out;
  };

  var CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
  var ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
  K.cleanText = function (s) { return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(ANSI_RE, '').replace(CTRL_RE, ''); };

  // Plain output text -> fenced ```output block, capped. A line starting with
  // ``` would close the fence early (core rule), so it gets a leading space.
  K.formatOutput = function (text, header, o) {
    o = o || {};
    var maxLines = o.maxLines || 200, maxChars = o.maxChars || 20000, maxLine = o.maxLine || 1000;
    var lines = K.cleanText(text).replace(/\s+$/, '').split('\n');
    if (lines.length === 1 && !lines[0]) lines = ['(no output)'];
    var out = [], chars = 0, cut = 0;
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i];
      if (s.length > maxLine) s = s.slice(0, maxLine) + '… (+' + (s.length - maxLine) + ' chars)';
      if (isFence(s)) s = ' ' + s;
      if (out.length >= maxLines || chars + s.length > maxChars) { cut = lines.length - i; break; }
      out.push(s); chars += s.length + 1;
    }
    if (cut) out.push('… ' + cut + ' more line' + (cut === 1 ? '' : 's') + ' (full output in the Code Runner panel)');
    return '```output\n' + (header ? header + '\n' : '') + out.join('\n') + '\n```';
  };

  K.fmtMs = function (ms) {
    ms = Math.max(0, Math.round(ms || 0));
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (Math.round(ms / 100) / 10) + ' s';
    var m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
    return m + ' min ' + s + ' s';
  };

  // ---- script escaping -----------------------------------------------------------------
  // Code goes inside a parser-inserted <script>: "</script" would end it and
  // "<!--" switches the tokenizer into escaped mode. \x3C is "<" in strings,
  // template literals and regexes, so meaning is preserved there.
  K.escapeScript = function (s) { return String(s).replace(/<(\/script|!--)/gi, '\\x3C$1'); };
  K.escapeStyle = function (s) { return String(s).replace(/<\/style/gi, '<\\/style'); };

  // ---- loop protection ---------------------------------------------------------------------
  // Tokenizes JS just enough (comments, strings, template literals, regex
  // literals, brackets) to find loop headers, then inserts a check:
  //   while (c)        -> while (__cadeLP(L)&&(c))
  //   for (a; c; b)    -> for (a; __cadeLP(L)&&(c); b)      (empty c -> __cadeLP(L))
  //   for (x of y) {   -> for (x of y) {__cadeLP(L);         (block bodies only)
  //   do … while (c)   -> the while part, as above
  // No newlines are added, so line numbers stay put. A misparse could break
  // syntax; callers keep the original as a fallback.
  var KW_BEFORE_EXPR = { 'return': 1, 'typeof': 1, 'instanceof': 1, 'in': 1, 'of': 1, 'new': 1, 'delete': 1, 'void': 1, 'throw': 1, 'case': 1, 'do': 1, 'else': 1, 'yield': 1, 'await': 1 };
  function isIdStart(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || c > 127; }
  function isIdPart(c) { return isIdStart(c) || (c >= 48 && c <= 57); }

  K.instrumentLoops = function (src, opt) {
    opt = opt || {};
    var fn = opt.fn || '__cadeLP', tag = opt.tag ? ",'" + String(opt.tag).replace(/[^\w-]/g, '') + "'" : '', line0 = opt.line0 || 0;
    src = String(src);
    var n = src.length, i = 0, line = 1;
    var ins = [];             // [pos, text, seq]
    var seq = 0;
    var stack = [];           // open brackets: {ch, loop, semis}
    var prev = null;          // previous significant token {t:'id'|'kw'|'num'|'str'|'re'|'p', v}
    var pendLoop = null;      // saw for/while, waiting for "("
    var pendBody = null;      // for-in/of header closed, waiting for "{"
    var count = 0;
    function add(pos, text) { ins.push([pos, text, seq++]); }
    function check(L) { return fn + '(' + (line0 + L) + tag + ')'; }
    function regexOk() {
      if (!prev) return true;
      if (prev.t === 'p') return prev.v !== ')' && prev.v !== ']' && prev.v !== '++' && prev.v !== '--';
      if (prev.t === 'id') return KW_BEFORE_EXPR[prev.v] === 1;
      return false;
    }
    function token(t, v) {
      if (pendLoop && !(t === 'p' && v === '(') && !(t === 'id' && v === 'await' && pendLoop.kind === 'for')) pendLoop = null;
      if (pendBody && !(t === 'p' && v === '{')) pendBody = null;
      prev = { t: t, v: v };
    }
    // template literal from position j (just after ` or the } closing ${…});
    // returns true if it stopped at "${" (expression follows).
    function template(j) {
      while (j < n) {
        var c = src.charCodeAt(j);
        if (c === 92) { if (src.charCodeAt(j + 1) === 10) line++; j += 2; continue; }
        if (c === 10) { line++; j++; continue; }
        if (c === 96) { i = j + 1; token('str', '`'); return false; }
        if (c === 36 && src.charCodeAt(j + 1) === 123) { i = j + 2; stack.push({ ch: '${' }); prev = { t: 'p', v: '{' }; return true; }
        j++;
      }
      i = n; return false;
    }
    while (i < n) {
      var c = src.charCodeAt(i), ch;
      if (c === 10) { line++; i++; continue; }
      if (c === 32 || c === 9 || c === 13 || c === 11 || c === 12 || c === 160 || c === 0xfeff || c === 0x2028 || c === 0x2029) { i++; continue; }
      if (c === 47) { // "/"
        var d = src.charCodeAt(i + 1);
        if (d === 47) { var e1 = src.indexOf('\n', i); i = e1 === -1 ? n : e1; continue; }
        if (d === 42) {
          var e2 = src.indexOf('*/', i + 2), stop = e2 === -1 ? n : e2 + 2;
          for (var k = i; k < stop; k++) if (src.charCodeAt(k) === 10) line++;
          i = stop; continue;
        }
        if (regexOk()) {
          var j = i + 1, inCls = false, ok = false;
          while (j < n) {
            var r = src.charCodeAt(j);
            if (r === 10) break;
            if (r === 92) { j += 2; continue; }
            if (r === 91) inCls = true;
            else if (r === 93) inCls = false;
            else if (r === 47 && !inCls) { ok = true; break; }
            j++;
          }
          if (ok) {
            j++;
            while (j < n && isIdPart(src.charCodeAt(j))) j++;
            i = j; token('re', '/'); continue;
          }
        }
        i++; token('p', '/'); continue;
      }
      if (c === 34 || c === 39) { // ' "
        var q = c, j2 = i + 1;
        while (j2 < n) {
          var s = src.charCodeAt(j2);
          if (s === 92) { if (src.charCodeAt(j2 + 1) === 10) line++; j2 += 2; continue; }
          if (s === q || s === 10) break;
          j2++;
        }
        i = j2 + 1; token('str', '"'); continue;
      }
      if (c === 96) { template(i + 1); continue; }
      if (isIdStart(c)) {
        var j3 = i + 1;
        while (j3 < n && isIdPart(src.charCodeAt(j3))) j3++;
        var w = src.slice(i, j3);
        var isProp = prev && prev.t === 'p' && (prev.v === '.' || prev.v === '?.');
        if (!isProp && (w === 'for' || w === 'while')) {
          token('id', w);
          pendLoop = { kind: w, line: line };
        } else if (w === 'await' && pendLoop && pendLoop.kind === 'for') {
          prev = { t: 'id', v: w };
        } else {
          token('id', w);
        }
        i = j3; continue;
      }
      if (c >= 48 && c <= 57 || (c === 46 && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)) {
        var j4 = i + 1;
        while (j4 < n) {
          var nc = src.charCodeAt(j4);
          if (isIdPart(nc) || nc === 46) { j4++; continue; }
          if ((nc === 43 || nc === 45) && (src.charCodeAt(j4 - 1) === 101 || src.charCodeAt(j4 - 1) === 69) && !/^0[xX]/.test(src.slice(i, j4))) { j4++; continue; }
          break;
        }
        i = j4; token('num', '0'); continue;
      }
      ch = src.charAt(i);
      if (ch === '(') {
        var ent = { ch: '(' };
        if (pendLoop) { ent.loop = pendLoop; ent.start = i + 1; ent.semis = []; pendLoop = null; }
        stack.push(ent);
        i++; token('p', '('); continue;
      }
      if (ch === ')') {
        var top = stack.length && stack[stack.length - 1].ch === '(' ? stack.pop() : null;
        i++;
        if (top && top.loop) {
          var L = top.loop.line;
          if (top.loop.kind === 'while') {
            add(top.start, check(L) + '&&('); add(i - 1, ')'); count++;
            token('p', ')');
          } else if (top.semis.length >= 2) {
            var a = top.semis[0] + 1, b = top.semis[1];
            if (!src.slice(a, b).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').trim()) add(a, check(L));
            else { add(a, check(L) + '&&('); add(b, ')'); }
            count++;
            token('p', ')');
          } else {
            token('p', ')');
            pendBody = { line: L };
          }
        } else token('p', ')');
        continue;
      }
      if (ch === ';') {
        var t2 = stack.length ? stack[stack.length - 1] : null;
        if (t2 && t2.loop && t2.loop.kind === 'for') t2.semis.push(i);
        i++; token('p', ';'); continue;
      }
      if (ch === '{') {
        if (pendBody) { add(i + 1, check(pendBody.line) + ';'); count++; pendBody = null; }
        stack.push({ ch: '{' });
        i++; token('p', '{'); continue;
      }
      if (ch === '}') {
        var t3 = stack.length ? stack[stack.length - 1] : null;
        if (t3 && t3.ch === '${') { stack.pop(); template(i + 1); continue; }
        if (t3 && t3.ch === '{') stack.pop();
        i++; token('p', '}'); continue;
      }
      if (ch === '[') { stack.push({ ch: '[' }); i++; token('p', '['); continue; }
      if (ch === ']') { if (stack.length && stack[stack.length - 1].ch === '[') stack.pop(); i++; token('p', ']'); continue; }
      // multi-char punctuators that matter for the regex/division decision
      var two = src.substr(i, 2);
      if (two === '++' || two === '--' || two === '?.' || two === '=>') {
        if (two === '?.' && src.charCodeAt(i + 2) >= 48 && src.charCodeAt(i + 2) <= 57) { i++; token('p', '?'); continue; }
        i += 2; token('p', two); continue;
      }
      i++; token('p', ch);
    }
    if (!ins.length) return { code: src, count: 0 };
    ins.sort(function (x, y) { return x[0] - y[0] || x[2] - y[2]; });
    var out = '', last = 0;
    for (var z = 0; z < ins.length; z++) { out += src.slice(last, ins[z][0]) + ins[z][1]; last = ins[z][0]; }
    out += src.slice(last);
    return { code: out, count: count };
  };

  // Inline <script> bodies of an HTML block (no src, JS type) get loop checks
  // tagged with the editor line they sit on.
  K.instrumentHtmlScripts = function (html, tag, lineBase) {
    var re = /(<script\b([^>]*)>)([\s\S]*?)(<\/script\s*>)/gi;
    return String(html).replace(re, function (m, open, attrs, body, close, idx) {
      if (/\bsrc\s*=/i.test(attrs)) return m;
      var t = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
      if (t && !/^(module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|javascript)$/i.test(t[1])) return m;
      var before = html.slice(0, idx + open.length), nl = 0;
      for (var k = 0; k < before.length; k++) if (before.charCodeAt(k) === 10) nl++;
      return open + K.instrumentLoops(body, { tag: tag, line0: lineBase + nl - 1 }).code + close;
    });
  };

  // ---- JSON validation ----------------------------------------------------------------------
  K.jsonCheck = function (text) {
    text = String(text);
    var i = 0, n = text.length, depthMax = 0;
    function fail(msg, at) { var e = new Error(msg); e.pos = at == null ? i : at; e.isJson = true; throw e; }
    function ws() {
      for (;;) {
        var c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
        if (c === 47 && (text.charCodeAt(i + 1) === 47 || text.charCodeAt(i + 1) === 42)) fail("Comments aren't allowed in JSON");
        return;
      }
    }
    function what(c) {
      if (c === undefined || c === '') return 'end of input';
      if (c === '\n') return 'a line break';
      return "'" + c + "'";
    }
    function str() {
      var start = i; i++;
      for (;;) {
        if (i >= n) fail('Unterminated string', start);
        var c = text.charCodeAt(i);
        if (c === 34) { i++; return; }
        if (c < 32) fail(c === 10 ? 'Line break inside a string (use \\n)' : 'Control character inside a string');
        if (c === 92) {
          var e = text.charAt(i + 1);
          if ('"\\/bfnrt'.indexOf(e) !== -1 && e) { i += 2; continue; }
          if (e === 'u') {
            if (!/^[0-9a-fA-F]{4}$/.test(text.substr(i + 2, 4))) fail('Bad \\u escape (needs 4 hex digits)');
            i += 6; continue;
          }
          fail('Bad escape \\' + e);
        }
        i++;
      }
    }
    function num() {
      var m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
      if (!m) fail('Invalid number');
      var after = text.charAt(i + m[0].length);
      if (/[0-9.eExX]/.test(after) && after) fail('Invalid number', i);
      i += m[0].length;
    }
    function value(depth) {
      if (depth > depthMax) depthMax = depth;
      if (depth > 1000) fail('Nested too deeply');
      ws();
      var c = text.charAt(i);
      if (c === '{') {
        i++; ws();
        if (text.charAt(i) === '}') { i++; return; }
        for (;;) {
          ws();
          var k = text.charAt(i);
          if (k === '}') fail("Trailing comma before '}'");
          if (k === "'") fail('Keys must use double quotes');
          if (k !== '"') fail('Expected a "key" but found ' + what(k));
          str(); ws();
          if (text.charAt(i) !== ':') fail("Expected ':' after the key but found " + what(text.charAt(i)));
          i++;
          value(depth + 1); ws();
          var s = text.charAt(i);
          if (s === ',') { i++; continue; }
          if (s === '}') { i++; return; }
          fail("Expected ',' or '}' after a property value but found " + what(s));
        }
      }
      if (c === '[') {
        i++; ws();
        if (text.charAt(i) === ']') { i++; return; }
        for (;;) {
          ws();
          if (text.charAt(i) === ']') fail("Trailing comma before ']'");
          value(depth + 1); ws();
          var s2 = text.charAt(i);
          if (s2 === ',') { i++; continue; }
          if (s2 === ']') { i++; return; }
          fail("Expected ',' or ']' after an array item but found " + what(s2));
        }
      }
      if (c === '"') { str(); return; }
      if (c === "'") fail('Strings must use double quotes');
      if (c === '-' || (c >= '0' && c <= '9')) { num(); return; }
      var lit = /^(true|false|null)\b/.exec(text.slice(i, i + 6));
      if (lit) { i += lit[1].length; return; }
      var word = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 40));
      if (word) fail(word[0] === 'undefined' || word[0] === 'NaN' || word[0] === 'Infinity' ? word[0] + " isn't valid JSON" : 'Unexpected word ' + word[0]);
      fail('Expected a value but found ' + what(c));
    }
    try {
      ws();
      if (i >= n) fail('Empty input');
      value(0); ws();
      if (i < n) fail('Unexpected ' + what(text.charAt(i)) + ' after the JSON value');
    } catch (e) {
      if (!e || !e.isJson) throw e;
      var pre = text.slice(0, e.pos), ln = pre.split('\n').length, col = e.pos - (pre.lastIndexOf('\n') + 1) + 1;
      return { ok: false, message: e.message, pos: e.pos, line: ln, col: col, lineText: text.split('\n')[ln - 1] || '' };
    }
    var v = JSON.parse(text);
    return { ok: true, value: v, depth: depthMax };
  };

  // JSON block -> output text.
  K.jsonReport = function (text) {
    var r = K.jsonCheck(text);
    if (!r.ok) {
      var gut = String(r.line).length, lt = r.lineText.length > 200 ? r.lineText.slice(0, 200) + '…' : r.lineText;
      var caret = new Array(Math.min(r.col, 201)).join(' ') + '^';
      return { ok: false, text: '✖ Invalid JSON — line ' + r.line + ', col ' + r.col + ': ' + r.message + '\n' +
        '  ' + r.line + ' | ' + lt + '\n' + '  ' + new Array(gut + 1).join(' ') + ' | ' + caret };
    }
    var v = r.value, kind;
    if (Array.isArray(v)) kind = 'array · ' + v.length + ' item' + (v.length === 1 ? '' : 's');
    else if (v && typeof v === 'object') { var nk = Object.keys(v).length; kind = 'object · ' + nk + ' key' + (nk === 1 ? '' : 's'); }
    else kind = v === null ? 'null' : typeof v;
    var pretty = JSON.stringify(v, null, 2);
    var head = '✓ Valid JSON — ' + kind + (r.depth > 1 ? ' · depth ' + r.depth : '');
    return { ok: true, text: pretty === String(text).trim() ? head : head + '\n\n' + pretty, pretty: pretty };
  };

  // ---- Python -----------------------------------------------------------------------------------
  // "# requires: numpy, requests>=2" lines -> micropip install list.
  K.pyRequires = function (code) {
    var out = [], re = /^[ \t]*#[ \t]*requires?[ \t]*:[ \t]*(.+)$/gim, m;
    while ((m = re.exec(String(code)))) {
      m[1].split(/[,\s]+/).forEach(function (p) {
        if (/^[A-Za-z0-9][A-Za-z0-9_.\-\[\]=<>!~]*$/.test(p) && out.indexOf(p) === -1 && out.length < 30) out.push(p);
      });
    }
    return out;
  };
  // Drop Pyodide's runner frames (and their source/caret lines) from a traceback.
  K.cleanTraceback = function (msg) {
    var lines = String(msg || '').replace(/\s+$/, '').split('\n'), out = [], skip = false;
    for (var k = 0; k < lines.length; k++) {
      var L = lines[k], m = /^  File "([^"]*)", line \d+/.exec(L);
      if (m) {
        skip = m[1] === '<cade>' || /python\d+\.zip\/_?pyodide\//.test(m[1]);
        if (!skip) out.push(L);
        continue;
      }
      if (skip && /^    /.test(L)) continue;
      skip = false;
      out.push(L);
    }
    if (out.length === 2 && /^Traceback/.test(out[0])) out.shift();
    var lastLine = out[out.length - 1] || '';
    if (/^EOFError\b/.test(lastLine)) out.push("(input() can't read here — there's no keyboard input in the browser runner; set the value in code)");
    if (/^ModuleNotFoundError\b/.test(lastLine)) out.push('(pure-Python packages from PyPI can be added with a "# requires: name" line)');
    return out.join('\n');
  };

  // ---- the in-iframe harness ---------------------------------------------------------------------
  // Runs INSIDE the sandbox (opaque origin): console capture, a node-like value
  // inspector, timer/fetch tracking (to know when a run is finished), loop
  // checks, error capture with line mapping, postMessage to the parent.
  // ES5 only. Shipped as source via Function.prototype.toString.
  function IFRAME_LIB(G) {
    var cfg = null, token = '', P = G.parent;
    var oST = G.setTimeout, oCT = G.clearTimeout, oSI = G.setInterval, oCI = G.clearInterval;
    var perf = (G.performance && G.performance.now) ? function () { return G.performance.now(); } : function () { return Date.now(); };
    var hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
    var q = [], qTimer = 0, sentLines = 0, sentChars = 0, dropped = 0;
    var t0 = perf(), deadline = Infinity, finished = false, mainStarted = false, mainDone = false, lastAct = t0;
    var nTimers = 0, timers = {}, nFetch = 0, idleTimer = 0, tripped = false, needFb = false;
    var counts = {}, timeLabels = {}, groupIndent = '';
    var lpN = 0, lpInTask = false, lpT0 = 0, rateT = 0, rateN = 0, rateDrop = 0;
    var O = {};

    function quote(s) {
      var qc = s.indexOf("'") === -1 ? "'" : (s.indexOf('"') === -1 ? '"' : (s.indexOf('`') === -1 ? '`' : "'"));
      var r = '', lim = Math.min(s.length, 10000);
      for (var i = 0; i < lim; i++) {
        var c = s.charAt(i), code = s.charCodeAt(i);
        if (c === qc || c === '\\') r += '\\' + c;
        else if (c === '\n') r += '\\n';
        else if (c === '\t') r += '\\t';
        else if (c === '\r') r += '\\r';
        else if (code < 32 || code === 127) r += '\\x' + (code < 16 ? '0' : '') + code.toString(16);
        else r += c;
      }
      return qc + r + qc + (s.length > lim ? '... ' + (s.length - lim) + ' more characters' : '');
    }
    function keyStr(k) { return /^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k); }
    function ctorName(o) {
      try {
        var p = Object.getPrototypeOf(o);
        if (p === null) return null;
        var c = p.constructor;
        return c && typeof c.name === 'string' ? c.name : '';
      } catch (e) { return ''; }
    }
    function tagOf(o) { try { return Object.prototype.toString.call(o).slice(8, -1); } catch (e) { return 'Object'; } }
    function fnStr(f) {
      var src = '', nm = '';
      try { src = Function.prototype.toString.call(f); } catch (e) {}
      try { nm = typeof f.name === 'string' ? f.name : ''; } catch (e) {}
      if (/^class[\s{]/.test(src)) return '[class ' + (nm || '(anonymous)') + ']';
      var kind = /^async[\s(]/.test(src) ? 'AsyncFunction' : (/^(async\s*)?function\s*\*/.test(src) ? 'GeneratorFunction' : 'Function');
      return '[' + kind + (nm ? ': ' + nm : ' (anonymous)') + ']';
    }
    function rep(ch, n) { var s = ''; while (n-- > 0) s += ch; return s; }
    function wrap(open, items, close, ind, fill, start) {
      var multi = false, i;
      for (i = 0; i < items.length; i++) if (items[i].indexOf('\n') !== -1) { multi = true; break; }
      var one = open + ' ' + items.join(', ') + ' ' + close;
      if (!multi && one.length + start + ind.length <= 76) return one;
      var inner = ind + '  ';
      if (fill && !multi && items.length > 6) {
        var maxW = 0;
        for (i = 0; i < items.length; i++) if (items[i].length > maxW) maxW = items[i].length;
        if (maxW <= 16) {
          var cols = Math.max(1, Math.min(16, Math.floor((80 - inner.length) / (maxW + 2)))), rows = [];
          for (var r = 0; r < items.length; r += cols) {
            var row = '';
            for (var j = r; j < r + cols && j < items.length; j++) {
              var cell = items[j] + (j < items.length - 1 ? ',' : '');
              row += (j < r + cols - 1 && j < items.length - 1) ? cell + rep(' ', maxW + 2 - cell.length) : cell;
            }
            rows.push(row);
          }
          return open + '\n' + inner + rows.join('\n' + inner) + '\n' + ind + close;
        }
      }
      return open + '\n' + inner + items.join(',\n' + inner) + '\n' + ind + close;
    }
    function nodeStr(v) {
      try {
        if (v.nodeType === 1) {
          var h = String(v.outerHTML || ('<' + v.nodeName.toLowerCase() + '>'));
          return h.length > 160 ? h.slice(0, 160) + '…' : h;
        }
        if (v.nodeType === 3) return '#text ' + quote(String(v.data).slice(0, 80));
        if (v.nodeType === 9) return '#document';
        return String(v.nodeName);
      } catch (e) { return '[Node]'; }
    }
    function errBrief(e) {
      var name = 'Error', msg = '';
      try { name = String(e.name || 'Error'); msg = e.message != null ? String(e.message) : ''; } catch (x) {}
      return msg ? name + ': ' + msg : name;
    }
    function fmt(v, depth, seen, ind, o) {
      var t = typeof v;
      if (v === null) return 'null';
      if (t === 'undefined') return 'undefined';
      if (t === 'string') return quote(v);
      if (t === 'number') return (v === 0 && 1 / v < 0) ? '-0' : String(v);
      if (t === 'bigint') return String(v) + 'n';
      if (t === 'boolean') return String(v);
      if (t === 'symbol') { try { return v.toString(); } catch (e) { return 'Symbol()'; } }
      if (t === 'function') return fnStr(v);
      for (var s = 0; s < seen.length; s++) if (seen[s] === v) return '[Circular]';
      var tag = tagOf(v), name = ctorName(v);
      try {
        if (tag === 'Error' || v instanceof Error) return seen.length ? '[' + errBrief(v) + ']' : errText(v, null);
        if (tag === 'Date') return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
        if (tag === 'RegExp') return String(v);
        if (tag === 'Promise') return 'Promise { … }';
        if (tag === 'WeakMap' || tag === 'WeakSet' || tag === 'WeakRef') return tag + ' { <items unknown> }';
        if (tag === 'ArrayBuffer' || tag === 'SharedArrayBuffer') return tag + ' { byteLength: ' + v.byteLength + ' }';
        if (v === G || tag === 'Window') return '[Window]';
        if (typeof v.nodeType === 'number' && typeof v.nodeName === 'string') return nodeStr(v);
      } catch (e) {}
      var isArr = false, isView = false;
      try { isArr = Array.isArray(v); isView = !isArr && typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(v) && tag !== 'DataView'; } catch (e) {}
      if (depth < 0) return isArr ? '[Array]' : '[' + (name || tag || 'Object') + ']';
      seen.push(v);
      var inner = ind + '  ', items = [], head = '', open = '{', close = '}', fill = false, i, c;
      try {
        if (isArr || isView || tag === 'Arguments') {
          var len = v.length, max = Math.min(len, 100);
          for (i = 0; i < max; i++) items.push(fmt(v[i], depth - 1, seen, inner, o));
          if (len > max) items.push('... ' + (len - max) + ' more item' + (len - max > 1 ? 's' : ''));
          open = '['; close = ']'; fill = true;
          if (tag === 'Arguments') head = '[Arguments] ';
          else if (isView) head = tag + '(' + len + ') ';
          else if (name && name !== 'Array') head = name + '(' + len + ') ';
        } else if (tag === 'Map') {
          head = 'Map(' + v.size + ') '; c = 0;
          v.forEach(function (val, key) { if (c++ < 100) items.push(fmt(key, depth - 1, seen, inner, o) + ' => ' + fmt(val, depth - 1, seen, inner, o)); });
          if (v.size > 100) items.push('... ' + (v.size - 100) + ' more items');
        } else if (tag === 'Set') {
          head = 'Set(' + v.size + ') '; c = 0;
          v.forEach(function (val) { if (c++ < 100) items.push(fmt(val, depth - 1, seen, inner, o)); });
          if (v.size > 100) items.push('... ' + (v.size - 100) + ' more items');
          fill = true;
        } else {
          if (name === null) head = '[Object: null prototype] ';
          else if (name && name !== 'Object') head = name + ' ';
          else if (tag !== 'Object') head = '[' + tag + '] ';
          var keys = Object.keys(v), nk = Math.min(keys.length, 100);
          for (i = 0; i < nk; i++) {
            var k = keys[i], d = null;
            try { d = Object.getOwnPropertyDescriptor(v, k); } catch (e) {}
            var val = d && (d.get || d.set) ? (d.get ? (d.set ? '[Getter/Setter]' : '[Getter]') : '[Setter]') : fmt(v[k], depth - 1, seen, inner, o);
            items.push(keyStr(k) + ': ' + val);
          }
          if (keys.length > nk) items.push('... ' + (keys.length - nk) + ' more propert' + (keys.length - nk > 1 ? 'ies' : 'y'));
          if (Object.getOwnPropertySymbols) {
            var syms = Object.getOwnPropertySymbols(v);
            for (i = 0; i < syms.length && i < 20; i++) {
              try { if (Object.prototype.propertyIsEnumerable.call(v, syms[i])) items.push('[' + syms[i].toString() + ']: ' + fmt(v[syms[i]], depth - 1, seen, inner, o)); } catch (e) {}
            }
          }
        }
      } catch (e) { items.push('<inspection failed: ' + (e && e.message) + '>'); }
      seen.pop();
      if (!items.length) return head + (open === '[' ? '[]' : '{}');
      return head + wrap(open, items, close, ind, fill, head.length);
    }
    function inspect(v, depth) { return fmt(v, depth == null ? 2 : depth, [], '', O); }
    function formatArgs(args) {
      var out = [], i = 0;
      if (typeof args[0] === 'string' && args.length > 1 && args[0].indexOf('%') !== -1) {
        var f = args[0], s = '';
        i = 1;
        for (var k = 0; k < f.length; k++) {
          var c = f.charAt(k);
          if (c === '%' && k + 1 < f.length) {
            var d = f.charAt(k + 1);
            if (d === '%') { s += '%'; k++; continue; }
            if ('sdifoOjc'.indexOf(d) !== -1) {
              k++;
              if (i >= args.length) { s += '%' + d; continue; }
              var a = args[i++];
              try {
                if (d === 's') s += typeof a === 'string' ? a : (typeof a === 'object' && a !== null ? fmt(a, 1, [], '', O) : (typeof a === 'symbol' ? a.toString() : (typeof a === 'bigint' ? a + 'n' : String(a))));
                else if (d === 'd' || d === 'i') s += typeof a === 'bigint' ? a + 'n' : (typeof a === 'object' && a !== null ? 'NaN' : String(d === 'i' ? parseInt(a, 10) : Number(a)));
                else if (d === 'f') s += String(parseFloat(a));
                else if (d === 'o' || d === 'O') s += fmt(a, d === 'o' ? 4 : 2, [], '', O);
                else if (d === 'j') s += JSON.stringify(a);
              } catch (e) { s += '?'; }
              continue;
            }
          }
          s += c;
        }
        out.push(s);
      }
      for (; i < args.length; i++) out.push(typeof args[i] === 'string' ? args[i] : fmt(args[i], 2, [], '', O));
      return out.join(' ');
    }
    function center(s, w) { var l = Math.floor((w - s.length) / 2); return rep(' ', l) + s + rep(' ', w - s.length - l); }
    function table(data, cols) {
      if (data === null || typeof data !== 'object') return formatArgs([data]);
      var keys = [], rows = [], colList = [], colSet = {}, hasVals = false, i, j;
      if (Array.isArray(data)) for (i = 0; i < data.length; i++) keys.push(i);
      else keys = Object.keys(data);
      if (cols && cols.length) for (i = 0; i < cols.length; i++) { colList.push(String(cols[i])); colSet[String(cols[i])] = 1; }
      for (i = 0; i < keys.length && i < 1000; i++) {
        var row = data[keys[i]], cells = {};
        if (row !== null && typeof row === 'object') {
          var rk = Array.isArray(row) ? row.map(function (x, n) { return String(n); }) : Object.keys(row);
          for (j = 0; j < rk.length; j++) {
            if (cols && cols.length && !hasOwn(colSet, rk[j])) continue;
            if (!hasOwn(colSet, rk[j])) { colSet[rk[j]] = 1; colList.push(rk[j]); }
            cells[rk[j]] = fmt(row[rk[j]], 0, [], '', O).replace(/\s*\n\s*/g, ' ');
          }
        } else { cells['\u0000v'] = fmt(row, 0, [], '', O); hasVals = true; }
        rows.push([String(keys[i]), cells]);
      }
      var header = ['(index)'].concat(colList);
      if (hasVals) header.push('Values');
      var matrix = rows.map(function (r) {
        var line = [r[0]];
        for (var c = 0; c < colList.length; c++) line.push(hasOwn(r[1], colList[c]) ? r[1][colList[c]] : '');
        if (hasVals) line.push(hasOwn(r[1], '\u0000v') ? r[1]['\u0000v'] : '');
        return line;
      });
      var widths = header.map(function (h, c) {
        var w = h.length;
        for (var r = 0; r < matrix.length; r++) if (matrix[r][c].length > w) w = matrix[r][c].length;
        return Math.min(w, 60) + 2;
      });
      function clip(s, w) { return s.length > w - 2 ? s.slice(0, w - 3) + '…' : s; }
      function line(l, m, r) { return l + widths.map(function (w) { return rep('─', w); }).join(m) + r; }
      function rowStr(cells) { return '│' + cells.map(function (s, c) { return center(clip(s, widths[c]), widths[c]); }).join('│') + '│'; }
      var out = [line('┌', '┬', '┐'), rowStr(header), line('├', '┼', '┤')];
      for (i = 0; i < matrix.length; i++) out.push(rowStr(matrix[i]));
      out.push(line('└', '┴', '┘'));
      return out.join('\n');
    }

    // ---- line mapping: document line -> {label, line} of the user's code ----
    function mapLine(l) {
      var segs = (cfg && cfg.segs) || [];
      for (var i = 0; i < segs.length; i++) {
        var g = segs[i];
        if (l >= g.s && l < g.s + g.n) return { label: g.label || '', line: g.base + (l - g.s) };
      }
      return null;
    }
    function locStr(f) { return (f.label ? f.label + ' ' : '') + 'line ' + f.line + (f.col ? ':' + f.col : ''); }
    function parseStack(stack) {
      var out = [], lines = String(stack || '').split('\n'), here = '';
      try { here = String(G.location.href); } catch (e) {}
      for (var i = 0; i < lines.length && out.length < 8; i++) {
        var L = lines[i], m = /^\s*at\s+(?:(.*?)\s+\()?(.*):(\d+):(\d+)\)?\s*$/.exec(L) || /^\s*(.*?)@(.*):(\d+):(\d+)\s*$/.exec(L);
        if (!m) continue;
        var url = m[2] || '';
        if (url.indexOf('srcdoc') === -1 && (!here || url.indexOf(here) === -1)) continue;
        var mp = mapLine(+m[3]);
        if (!mp) continue;
        var fname = (m[1] || '').replace(/^async\s+/, '');
        if (/^(eval|Object\.<anonymous>|<anonymous>|global code|module code)$/.test(fname)) fname = '';
        out.push({ fn: fname, label: mp.label, line: mp.line, col: +m[4] });
      }
      return out;
    }
    function errText(e, loc) {
      if (!e || (typeof e !== 'object' && typeof e !== 'function')) return fmt(e, 2, [], '', O);
      var head = errBrief(e), frames = [];
      try { frames = parseStack(e.stack); } catch (x) {}
      if (!frames.length && loc) frames = [loc];
      if (!frames.length) return head;
      var s = head + ' (' + locStr(frames[0]) + ')';
      for (var i = 1; i < frames.length && i < 6; i++) s += '\n    at ' + (frames[i].fn ? frames[i].fn + ' (' + locStr(frames[i]) + ')' : locStr(frames[i]));
      return s;
    }

    // ---- messaging ----
    function post(m) { m.__cr = token; try { P.postMessage(m, '*'); } catch (e) {} }
    function flush() {
      if (qTimer) { oCT(qTimer); qTimer = 0; }
      if (rateDrop && cfg && cfg.mode !== 'run') { q.push(['warn', '… ' + rateDrop + ' console messages dropped (too many)']); rateDrop = 0; }
      if (!q.length) return;
      var b = q; q = [];
      post({ type: 'out', items: b });
    }
    function send(level, text) {
      if (finished || !cfg) return;
      text = String(text);
      if (cfg.mode === 'run') {
        if (sentLines >= cfg.maxLines || sentChars >= cfg.maxChars) { dropped++; return; }
        sentLines++; sentChars += text.length;
      } else {
        var now = perf();
        if (now - rateT > 1000) { rateT = now; rateN = 0; }
        if (++rateN > 300) { rateDrop++; return; }
        if (text.length > 20000) text = text.slice(0, 20000) + '…';
      }
      if (groupIndent) text = groupIndent + text.replace(/\n/g, '\n' + groupIndent);
      q.push([level, text]);
      if (q.length >= 200) flush();
      else if (!qTimer) qTimer = oST(flush, 30);
    }
    function finish(status) {
      if (finished) return;
      flush();
      finished = true;
      post({ type: 'done', status: status, ms: Math.round((mainDone ? lastAct : perf()) - t0), dropped: dropped });
    }
    function act() { lastAct = perf(); if (mainDone) checkIdle(); }
    function checkIdle() {
      if (finished || !mainDone || nTimers > 0 || nFetch > 0) return;
      if (idleTimer) oCT(idleTimer);
      idleTimer = oST(function () {
        idleTimer = 0;
        if (!finished && mainDone && nTimers === 0 && nFetch === 0) finish('ok');
      }, 15);
    }

    // ---- loop checks ----
    function trip(id, tag, why) {
      tripped = true;
      var where = (tag ? tag + ' ' : '') + 'line ' + id;
      if (cfg.mode === 'run') {
        send('sys', '⏱ ' + why + ' — stopped a loop at ' + where);
        oST(function () { finish('timeout'); }, 0);
      } else {
        send('error', '⏱ ' + why + ' — stopped a loop at ' + where + ' (infinite loop?)');
        oST(function () { tripped = false; }, 0);
      }
      throw new Error(why + ' (loop at ' + where + ')');
    }
    function lp(id, tag) {
      if (!cfg || (++lpN & 63) !== 0) return true;
      var now = perf();
      if (cfg.mode === 'run') {
        if (now > deadline || tripped) trip(id, tag, 'Timed out after ' + Math.round(cfg.timeout / 100) / 10 + ' s');
        return true;
      }
      if (!lpInTask) { lpInTask = true; lpT0 = now; oST(function () { lpInTask = false; }, 0); return true; }
      if (now - lpT0 > (cfg.loopBudget || 1500)) trip(id, tag, 'A loop ran for more than ' + Math.round((cfg.loopBudget || 1500) / 100) / 10 + ' s');
      return true;
    }
    G.__cadeLP = lp;

    // ---- patches ----
    function patchConsole() {
      var C = G.console || (G.console = {});
      ['log', 'info', 'debug', 'warn', 'error'].forEach(function (m) {
        var orig = C[m];
        C[m] = function () {
          send(m === 'debug' ? 'log' : m, formatArgs([].slice.call(arguments)));
          try { if (orig) orig.apply(C, arguments); } catch (e) {}
        };
      });
      C.dir = function (v) { send('log', fmt(v, 2, [], '', O)); };
      C.dirxml = C.log;
      C.table = function (d, cols) { send('log', table(d, cols)); };
      C.assert = function (cond) {
        if (cond) return;
        var rest = [].slice.call(arguments, 1);
        send('error', 'Assertion failed' + (rest.length ? ': ' + formatArgs(rest) : ''));
      };
      C.count = function (l) { l = l === undefined ? 'default' : String(l); counts[l] = (counts[l] || 0) + 1; send('log', l + ': ' + counts[l]); };
      C.countReset = function (l) { counts[l === undefined ? 'default' : String(l)] = 0; };
      C.time = function (l) { timeLabels[l === undefined ? 'default' : String(l)] = perf(); };
      function tl(l, end, extra) {
        var k = l === undefined ? 'default' : String(l);
        if (!hasOwn(timeLabels, k)) { send('warn', "Timer '" + k + "' does not exist"); return; }
        var ms = perf() - timeLabels[k];
        send('log', k + ': ' + (Math.round(ms * 1000) / 1000) + 'ms' + (extra && extra.length ? ' ' + formatArgs(extra) : ''));
        if (end) delete timeLabels[k];
      }
      C.timeLog = function (l) { tl(l, false, [].slice.call(arguments, 1)); };
      C.timeEnd = function (l) { tl(l, true); };
      C.group = C.groupCollapsed = function () {
        if (arguments.length) send('log', formatArgs([].slice.call(arguments)));
        groupIndent += '  ';
      };
      C.groupEnd = function () { groupIndent = groupIndent.slice(2); };
      C.trace = function () { send('log', 'Trace' + (arguments.length ? ': ' + formatArgs([].slice.call(arguments)) : '')); };
      C.clear = function () { q = []; post({ type: 'clear' }); };
    }
    function patchRun() {
      G.setTimeout = function (fn, ms) {
        var args = [].slice.call(arguments, 2), id;
        var f = typeof fn === 'function' ? fn : function () { (0, G.eval)(String(fn)); };
        id = oST(function () {
          if (hasOwn(timers, id)) { delete timers[id]; nTimers--; }
          try { f.apply(G, args); } finally { act(); }
        }, ms);
        timers[id] = 1; nTimers++;
        return id;
      };
      G.setInterval = function (fn, ms) {
        var args = [].slice.call(arguments, 2);
        var f = typeof fn === 'function' ? fn : function () { (0, G.eval)(String(fn)); };
        var id = oSI(function () { try { f.apply(G, args); } finally { act(); } }, ms);
        timers[id] = 2; nTimers++;
        return id;
      };
      G.clearTimeout = G.clearInterval = function (id) {
        if (hasOwn(timers, id)) {
          var kind = timers[id]; delete timers[id]; nTimers--;
          if (kind === 2) oCI(id); else oCT(id);
          act();
        } else { oCT(id); oCI(id); }
      };
      function track(p) {
        nFetch++;
        return p.then(function (v) { nFetch--; act(); return v; }, function (e) { nFetch--; act(); throw e; });
      }
      if (typeof G.fetch === 'function') {
        var oF = G.fetch;
        G.fetch = function () { return track(oF.apply(this, arguments)); };
      }
      var R = G.Response && G.Response.prototype;
      if (R) ['json', 'text', 'arrayBuffer', 'blob', 'formData'].forEach(function (m) {
        var o = R[m];
        if (typeof o === 'function') R[m] = function () { return track(o.apply(this, arguments)); };
      });
      G.alert = function (m) { send('log', '[alert] ' + (m === undefined ? '' : String(m))); };
      G.confirm = function (m) { send('log', '[confirm] ' + (m === undefined ? '' : String(m)) + ' → false'); return false; };
      G.prompt = function (m) { send('log', '[prompt] ' + (m === undefined ? '' : String(m)) + ' → null'); return null; };
    }
    function inRange(l, s, n) { return l >= s && l < s + n; }
    function onError(ev) {
      if (!ev || finished || !cfg) return;
      if (!ev.message && !ev.error) {
        var t = ev.target;
        if (cfg.mode !== 'run' && t && t !== G && t.tagName) {
          var u = t.currentSrc || t.src || t.href || '';
          if (u) send('warn', 'Failed to load <' + String(t.tagName).toLowerCase() + '> ' + u);
        }
        return;
      }
      var l = ev.lineno || 0;
      // Before main() starts, the only thing that can fail is parsing a user
      // script: the first failure is the loop-checked copy, so let the plain
      // copy run instead; a second failure is the user's own syntax error.
      if (cfg.mode === 'run' && cfg.fb && !mainStarted && !needFb) {
        needFb = true;
        try { ev.preventDefault(); } catch (e) {}
        return;
      }
      if (tripped && cfg.mode === 'run') { finish('timeout'); return; }
      var mp = mapLine(l), loc = mp ? { label: mp.label, line: mp.line, col: ev.colno || 0 } : null;
      var text = ev.error ? errText(ev.error, loc) : String(ev.message || 'Error').replace(/^Uncaught\s+/, '') + (loc ? ' (' + locStr(loc) + ')' : '');
      send('sys', '✖ Uncaught ' + text);
      if (cfg.mode === 'run') finish('error');
    }
    function onRejection(ev) {
      if (finished || !cfg) return;
      if (tripped && cfg.mode === 'run') { finish('timeout'); return; }
      send('sys', '✖ Uncaught (in promise) ' + errText(ev && ev.reason, null));
      if (cfg.mode === 'run') finish('error');
    }

    // ---- entry points used by the generated document ----
    function init(c) {
      cfg = c; token = c.token; O = {};
      t0 = perf(); lastAct = t0;
      deadline = c.mode === 'run' ? t0 + (c.timeout || 5000) : Infinity;
      patchConsole();
      if (c.mode === 'run') patchRun();
      G.addEventListener('error', onError, true);
      G.addEventListener('unhandledrejection', onRejection);
      if (c.mode === 'preview') {
        var sx = c.scroll ? c.scroll[0] : 0, sy = c.scroll ? c.scroll[1] : 0, st = 0;
        if (sx || sy) G.addEventListener('load', function () { try { G.scrollTo(sx, sy); } catch (e) {} });
        G.addEventListener('scroll', function () {
          if (st) return;
          st = oST(function () { st = 0; post({ type: 'scroll', x: G.pageXOffset || 0, y: G.pageYOffset || 0 }); }, 250);
        }, true);
      }
    }
    function main(fn) {
      mainStarted = true;
      t0 = perf(); lastAct = t0;
      if (cfg.mode === 'run') deadline = t0 + (cfg.timeout || 5000);
      var p;
      try { p = fn(); } catch (e) { onRejection({ reason: e }); return; }
      p.then(function () { mainDone = true; act(); }, function (e) {
        if (finished) return;
        if (tripped) { finish('timeout'); return; }
        send('sys', '✖ Uncaught ' + errText(e, null));
        finish('error');
      });
    }
    function fb() { return needFb; }
    function after() { if (!mainStarted && !finished) finish('error'); }
    function mstart() { mainStarted = true; t0 = perf(); lastAct = t0; deadline = t0 + (cfg.timeout || 5000); }
    function mend() { mainDone = true; act(); }
    function loadErr() { send('sys', '✖ A module import failed to load'); finish('error'); }

    G.__crInspect = { inspect: inspect, formatArgs: formatArgs, table: table, mapLine: mapLine, parseStack: parseStack };
    G.__cr = { init: init, main: main, fb: fb, after: after, mstart: mstart, mend: mend, loadErr: loadErr };
  }
  K.IFRAME_LIB = IFRAME_LIB;
  var libSrc = null;
  K.libSource = function () {
    if (!libSrc) libSrc = '(' + IFRAME_LIB.toString() + ')(window);';
    return libSrc;
  };

  function countNL(s) { var n = 0; for (var i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++; return n; }
  function Builder() { this.parts = []; this.line = 1; }
  Builder.prototype.add = function (s) { this.parts.push(s); this.line += countNL(s); return this; };
  Builder.prototype.text = function () { return this.parts.join(''); };
  var CFG_SLOT = '\u0000CFG\u0000';

  // ES module syntax (static import / export) -> run as <script type=module>.
  K.isModuleCode = function (code) { return /^[ \t]*(?:import(?:[ \t]+[\w${*'"]|[ \t]*[{*'"])|export[ \t]+[\w{*])/m.test(String(code)); };

  // The sandbox document for one JS run. User code sits in its own lines
  // (user line k = document line segs[].s + k - 1) so error positions map back.
  // When loop checks changed the code, an untouched copy follows and only runs
  // if the instrumented one fails to parse.
  K.buildRunnerDoc = function (code, o) {
    o = o || {};
    code = String(code);
    var isMod = o.module != null ? !!o.module : K.isModuleCode(code);
    var inst = K.instrumentLoops(code);
    var n = countNL(code) + 1, fbOn = !isMod && inst.count > 0;
    var b = new Builder();
    b.add('<!doctype html><html><head><meta charset="utf-8"><script>\n' + K.libSource() + '\n__cr.init(' + CFG_SLOT + ');\n</script></head><body>\n');
    var segs = [];
    if (isMod) {
      b.add('<script type="module" onerror="__cr.loadErr()">__cr.mstart();\n');
      segs.push({ s: b.line, n: n, base: 1, label: '' });
      b.add(K.escapeScript(inst.code) + '\n;__cr.mend();</script>\n');
    } else {
      b.add('<script>__cr.main(async function () {\n');
      segs.push({ s: b.line, n: n, base: 1, label: '' });
      b.add(K.escapeScript(inst.code) + '\n})</script>\n');
      if (fbOn) {
        b.add('<script>__cr.fb() && __cr.main(async function () {\n');
        segs.push({ s: b.line, n: n, base: 1, label: '' });
        b.add(K.escapeScript(code) + '\n})</script>\n');
      }
      b.add('<script>__cr.after()</script>\n');
    }
    b.add('</body></html>');
    var cfg = { token: o.token || 't', mode: 'run', timeout: o.timeout || 5000, maxLines: o.maxLines || 5000, maxChars: o.maxChars || 400000, fb: fbOn, segs: segs };
    return { html: b.text().replace(CFG_SLOT, JSON.stringify(cfg).replace(/</g, '\\u003c')), cfg: cfg, module: isMod, loops: inst.count };
  };

  // ---- Live HTML Preview documents ---------------------------------------------------------------
  K.isFullDoc = function (html) { return /<!doctype\s+html|<html[\s>]/i.test(String(html || '')); };
  // parts: { html: {text, line} | null, css: [{text, line}], js: [{text, line}] }
  // (line = editor line number of the block's first content line)
  // Returns { html (instrumented, with harness), clean (plain single file) }.
  K.buildPreviewDoc = function (parts, o) {
    o = o || {};
    var html = parts.html, css = parts.css || [], js = parts.js || [];
    var full = html && K.isFullDoc(html.text);
    var cfg = { token: o.token || 't', mode: 'preview', loopBudget: o.loopBudget || 1500, scroll: o.scroll || null, segs: [] };
    var harness = '<script>\n' + K.libSource() + '\n__cr.init(' + CFG_SLOT + ');\n</script>';
    var hn = countNL(harness), b = new Builder(), segs = cfg.segs;
    function cssTags(B) {
      css.forEach(function (c) {
        B.add('<style>\n');
        if (B === b) segs.push({ s: b.line, n: countNL(c.text) + 1, base: c.line, label: 'css' });
        B.add(K.escapeStyle(c.text) + '\n</style>\n');
      });
    }
    function jsTags(B, instr) {
      js.forEach(function (c) {
        var mod = K.isModuleCode(c.text);
        B.add(mod ? '<script type="module">\n' : '<script>\n');
        if (instr) segs.push({ s: b.line, n: countNL(c.text) + 1, base: c.line, label: '' });
        var body = instr ? K.instrumentLoops(c.text, { line0: c.line - 1 }).code : c.text;
        B.add(K.escapeScript(body) + '\n</script>\n');
      });
    }
    var clean = new Builder();
    if (full) {
      var src = html.text, ins = K.instrumentHtmlScripts(src, '', html.line);
      // harness right after <head> (else <html>, else doctype, else start)
      var m = /<head\b[^>]*>/i.exec(ins) || /<html\b[^>]*>/i.exec(ins) || /<!doctype[^>]*>/i.exec(ins);
      var at = m ? m.index + m[0].length : 0;
      var pre = ins.slice(0, at), post = ins.slice(at), k = countNL(pre);
      b.add(pre + harness + post + '\n');
      segs.push({ s: 1, n: k + 1, base: html.line, label: '' });
      segs.push({ s: 1 + k + hn, n: countNL(post) + 1, base: html.line + k, label: '' });
      cssTags(b); jsTags(b, true);
      // clean single file: css before </head>, js before </body>
      var cs = new Builder(); cssTags(cs);
      var jb = new Builder(); jsTags(jb, false);
      var out = src, hc = /<\/head\s*>/i.exec(out);
      if (cs.parts.length) out = hc ? out.slice(0, hc.index) + cs.text() + out.slice(hc.index) : cs.text() + out;
      var bc = /<\/body\s*>/i.exec(out);
      if (jb.parts.length) out = bc ? out.slice(0, bc.index) + jb.text() + out.slice(bc.index) : out + '\n' + jb.text();
      clean.add(out);
    } else {
      b.add('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + harness + '\n');
      cssTags(b);
      b.add('</head><body>\n');
      if (html) {
        segs.push({ s: b.line, n: countNL(html.text) + 1, base: html.line, label: '' });
        b.add(K.instrumentHtmlScripts(html.text, '', html.line) + '\n');
      }
      jsTags(b, true);
      b.add('</body></html>');
      clean.add('<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Preview</title>\n');
      cssTags(clean);
      clean.add('</head>\n<body>\n');
      if (html) clean.add(html.text + '\n');
      jsTags(clean, false);
      clean.add('</body>\n</html>\n');
    }
    return { html: b.text().replace(CFG_SLOT, JSON.stringify(cfg).replace(/</g, '\\u003c')), clean: clean.text(), cfg: cfg, full: !!full };
  };

  if (root) root.__cadeCodeRunKit = K;
  if (typeof module === 'object' && module && module.exports) module.exports = K;
})(typeof window !== 'undefined' ? window : null);
