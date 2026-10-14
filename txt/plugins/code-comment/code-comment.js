/* Code comments — Ctrl+/ (Cmd+/ on a Mac) inside a ``` fenced block toggles
 * comments on the selected lines (or the caret's line) in that block's
 * language: // for JS, C, Go…, # for Python, shell, YAML…, -- for SQL and
 * Lua, <!-- --> for HTML/XML, slash-star blocks for CSS, and so on. With no
 * language on the fence (or one it doesn't know) it guesses from the code.
 *
 * Like an IDE: if every non-blank line is already commented they are
 * uncommented, otherwise all of them are commented, aligned at the shallowest
 * indent; blank lines are left alone. Block-comment languages wrap the
 * selected lines in one comment (and unwrap it again). One transaction, one
 * Undo; several cursors work. Fence lines themselves are never touched, and
 * outside a fence the key does whatever it did before.
 *
 * The comment logic below is pure (no DOM, no editor) and unit-tested:
 * node txt/plugins/code-comment/code-comment.test.js */
(function () {
  'use strict';

  // ================= core (pure) =================
  var LINE = {
    '//': 'js javascript jsx mjs cjs node ts typescript tsx java c h cpp c++ cc cxx hpp cs csharp c# go golang rust rs swift kotlin kt kts ' +
      'scala sc dart php groovy gradle objc objective-c objectivec m mm scss sass less zig proto protobuf solidity sol v verilog sv systemverilog ' +
      'glsl hlsl wgsl d fsharp fs jsonc json5 json hjson arduino ino processing pde haxe apex cuda cu metal',
    '#': 'python py py3 python3 ipython ruby rb sh bash zsh shell console fish ksh csh tcsh perl pl pm r rscript yaml yml toml dockerfile docker ' +
      'makefile make mk cmake powershell ps1 psm1 pwsh nim julia jl elixir ex exs crystal cr coffee coffeescript conf nginx apache apacheconf ' +
      'terraform tf hcl graphql gql gitignore ignore env dotenv properties nix tcl awk sed jq starlark bzl bazel cython pyx gdscript',
    '--': 'sql mysql postgres postgresql psql pgsql plsql plpgsql sqlite tsql mssql oracle hive bigquery snowflake lua haskell hs elm ada vhdl applescript purescript idris agda',
    ';': 'lisp commonlisp cl clojure clj cljs cljc edn scheme scm racket rkt elisp emacs-lisp asm nasm masm x86asm assembly s ini cfg autohotkey ahk',
    '%': 'latex tex bibtex matlab octave erlang erl prolog postscript ps',
    "'": 'vb vba vbnet vbscript vbs basic',
    'REM': 'bat cmd batch dos',
    '!': 'fortran f90 f95 f03',
    '"': 'vim vimscript viml'
  };
  var BLOCK = {
    'html': ['<!--', '-->'], 'htm': ['<!--', '-->'], 'xml': ['<!--', '-->'], 'xhtml': ['<!--', '-->'], 'svg': ['<!--', '-->'],
    'markdown': ['<!--', '-->'], 'md': ['<!--', '-->'], 'vue': ['<!--', '-->'], 'svelte': ['<!--', '-->'], 'xsl': ['<!--', '-->'],
    'plist': ['<!--', '-->'], 'rss': ['<!--', '-->'], 'atom': ['<!--', '-->'], 'jsx-html': ['<!--', '-->'],
    'css': ['/*', '*/'], 'pcss': ['/*', '*/'], 'postcss': ['/*', '*/'], 'stylus': ['/*', '*/'],
    'ocaml': ['(*', '*)'], 'ml': ['(*', '*)'], 'pascal': ['{', '}'], 'delphi': ['{', '}'], 'mermaid': ['%%', ''],
    'handlebars': ['{{!--', '--}}'], 'hbs': ['{{!--', '--}}'], 'jinja': ['{#', '#}'], 'jinja2': ['{#', '#}'], 'twig': ['{#', '#}'], 'django': ['{#', '#}'],
    'erb': ['<%#', '%>'], 'ejs': ['<%#', '%>']
  };
  var BYLANG = {};
  (function () {
    for (var tok in LINE) {
      var names = LINE[tok].split(' ');
      for (var i = 0; i < names.length; i++) if (names[i]) BYLANG[names[i]] = { line: tok };
    }
    for (var n in BLOCK) BYLANG[n] = BLOCK[n][1] ? { block: BLOCK[n] } : { line: BLOCK[n][0] };
  })();

  // The language word from a fence's info string: "```py title=x" → "py".
  function fenceLang(info) {
    var m = /^\s*(?:`{3,}|~{3,})\s*\{?\s*\.?([^\s{}`,]+)/.exec(info || '');
    return m ? m[1].toLowerCase().replace(/^language-/, '') : '';
  }
  // A good guess from the code itself when the fence names no (known) language.
  function guess(lines) {
    var text = lines.join('\n'), score = { '//': 0, '#': 0, '--': 0, html: 0, css: 0 };
    var t = text.slice(0, 4000);
    if (/^\s*</m.test(t) && /<\/?[a-z][\w-]*[\s>]/i.test(t)) score.html += 3;
    if (/^\s*[.#]?[\w-]+(\s*[,>+~]\s*[.#]?[\w-]+)*\s*\{[^}]*:[^}]*;/m.test(t)) score.css += 3;
    if (/\b(select|insert\s+into|update|delete\s+from|create\s+table)\b[\s\S]*\b(from|where|values|set|primary)\b/i.test(t)) score['--'] += 3;
    if (/^\s*(def|elif|import|from|print\(|if __name__)\b/m.test(t) || /:\s*$/m.test(t) && !/[;{}]\s*$/m.test(t)) score['#'] += 3;
    if (/^\s*(echo|export|fi|then|done|sudo|cd|ls|apt|brew|npm|pip|git)\b/m.test(t) || /^#!/.test(t) || /^\s*[\w.-]+:\s*\S/m.test(t) && !/[;{}]/.test(t)) score['#'] += 2;
    if (/^\s*#(?!include|define|if|endif|pragma)/m.test(t)) score['#'] += 1;
    if (/^\s*\/\//m.test(t)) score['//'] += 2;
    if (/[;{}]\s*$/m.test(t) || /\b(function|const|let|var|public|private|static|void|int|func|fn)\b|=>/.test(t)) score['//'] += 2;
    var best = '//', bv = 0;
    for (var k in score) if (score[k] > bv) { bv = score[k]; best = k; }
    if (best === 'html') return { block: BLOCK.html };
    if (best === 'css') return { block: BLOCK.css };
    return { line: best };
  }
  function syntaxFor(lang, lines) { return BYLANG[lang] || guess(lines); }

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Line comments: changes [{from, to, insert}] relative to the given lines
  // (absolute offsets come from `starts`, each line's start in the document).
  function toggleLines(lines, starts, tok) {
    var blank = function (l) { return !/\S/.test(l); }, i, changes = [];
    var re = new RegExp('^(\\s*)' + esc(tok) + ' ?');
    var body = [];
    for (i = 0; i < lines.length; i++) if (!blank(lines[i])) body.push(i);
    if (!body.length) return changes;
    var all = body.every(function (j) { return re.test(lines[j]); });
    if (all) {
      body.forEach(function (j) {
        var m = re.exec(lines[j]);
        changes.push({ from: starts[j] + m[1].length, to: starts[j] + m[0].length, insert: '' });
      });
      return changes;
    }
    var ind = Infinity;
    body.forEach(function (j) { ind = Math.min(ind, /^\s*/.exec(lines[j])[0].length); });
    body.forEach(function (j) { changes.push({ from: starts[j] + ind, to: starts[j] + ind, insert: tok + ' ' }); });
    return changes;
  }
  // Block comments around a run of lines: wrap, or unwrap when already wrapped.
  function toggleBlock(lines, starts, open, close) {
    var first = -1, last = -1, i;
    for (i = 0; i < lines.length; i++) if (/\S/.test(lines[i])) { if (first < 0) first = i; last = i; }
    if (first < 0) return [];
    var a = lines[first], z = lines[last], ia = /^\s*/.exec(a)[0].length;
    var openRe = new RegExp('^(\\s*)' + esc(open) + ' ?'), closeRe = new RegExp(' ?' + esc(close) + '(\\s*)$');
    var om = openRe.exec(a), cm = closeRe.exec(z);
    if (om && cm && !(first === last && om[0].length > z.length - cm[0].length)) {
      var cStart = z.length - cm[0].length;
      var ch = [{ from: starts[first] + om[1].length, to: starts[first] + om[0].length, insert: '' }];
      ch.push({ from: starts[last] + cStart, to: starts[last] + cStart + cm[0].length - cm[1].length, insert: '' });
      return ch;
    }
    var zEnd = z.replace(/\s+$/, '').length;
    return [{ from: starts[first] + ia, to: starts[first] + ia, insert: open + ' ' },
      { from: starts[last] + zEnd, to: starts[last] + zEnd, insert: ' ' + close }];
  }
  function toggle(lines, starts, syn) {
    return syn.block ? toggleBlock(lines, starts, syn.block[0], syn.block[1]) : toggleLines(lines, starts, syn.line);
  }

  var CORE = { fenceLang: fenceLang, guess: guess, syntaxFor: syntaxFor, toggleLines: toggleLines, toggleBlock: toggleBlock, toggle: toggle, BYLANG: BYLANG };
  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ================= editor binding =================
  var Cade = window.Cade, CM = Cade.CM;
  if (!CM || !CM.keymap) return;
  var FENCE = /^\s*(`{3,}|~{3,})/;
  function inFence(pos) { try { return !!(Cade.inCodeFence && Cade.inCodeFence(pos)); } catch (e) { return false; } }

  // The fenced block around line n: its opening line (with the info string) and
  // the content lines' range; null when n is a fence line or not in a block.
  function blockAt(doc, n) {
    var line = doc.line(n);
    if (FENCE.test(line.text) || !inFence(line.from)) return null;
    var open = 0, close = doc.lines + 1, i;
    for (i = n - 1; i >= 1; i--) if (FENCE.test(doc.line(i).text)) { open = i; break; }
    if (!open) return null;
    for (i = n + 1; i <= doc.lines; i++) if (FENCE.test(doc.line(i).text)) { close = i; break; }
    return { open: open, first: open + 1, last: close - 1, info: doc.line(open).text };
  }

  function run(view) {
    var st = view.state, doc = st.doc, groups = {}, order = [], r, i;
    // Group the selected lines by the block they're in; ranges outside blocks don't count.
    for (r = 0; r < st.selection.ranges.length; r++) {
      var rg = st.selection.ranges[r], a = doc.lineAt(rg.from).number, b = doc.lineAt(rg.to).number;
      if (b > a && rg.to === doc.line(b).from) b--;       // a selection ending at a line start excludes that line
      for (i = a; i <= b; i++) {
        var blk = blockAt(doc, i);
        if (!blk) continue;
        var g = groups[blk.open];
        if (!g) { g = groups[blk.open] = { blk: blk, lines: {} }; order.push(blk.open); }
        g.lines[i] = true;
      }
    }
    if (!order.length) return false;                        // not in a code block: leave the key alone
    var changes = [];
    order.forEach(function (k) {
      var g = groups[k], nums = Object.keys(g.lines).map(Number).sort(function (x, y) { return x - y; });
      var lines = [], starts = [], all = [];
      for (i = g.blk.first; i <= g.blk.last && all.length < 400; i++) all.push(doc.line(i).text);
      var syn = syntaxFor(fenceLang(g.blk.info), all);
      if (syn.block) {                                      // one block comment per contiguous run
        var run2 = [];
        var flush = function () {
          if (!run2.length) return;
          changes = changes.concat(toggle(run2.map(function (n) { return doc.line(n).text; }), run2.map(function (n) { return doc.line(n).from; }), syn));
          run2 = [];
        };
        nums.forEach(function (n, j) { if (j && n !== nums[j - 1] + 1) flush(); run2.push(n); });
        flush();
      } else {
        nums.forEach(function (n) { var L = doc.line(n); lines.push(L.text); starts.push(L.from); });
        changes = changes.concat(toggle(lines, starts, syn));
      }
    });
    if (changes.length) view.dispatch({ changes: changes, userEvent: 'input.comment', scrollIntoView: true });
    return true;
  }

  var km = CM.keymap.of([{ key: 'Mod-/', run: run, preventDefault: true }]);
  Cade.registerPlugin({ id: 'code-comment', ext: CM.Prec && CM.Prec.highest ? CM.Prec.highest(km) : km });
})();
