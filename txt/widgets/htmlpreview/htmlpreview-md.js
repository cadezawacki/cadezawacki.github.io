/* Live Preview — Markdown mode (lazy: loaded with marked the first time a note
 * is previewed as Markdown). Exposes window.__cadeMdPreview (module.exports in
 * node for tests):
 *
 *   create(marked) -> { render(src, cb) -> [{k, l, h}], shellDoc(token, vars), staticDoc(blocks, vars, imgs, embeds) }
 *
 * render() turns the note into top-level blocks of HTML: k = a key (content
 * hash + occurrence), l = the block's first editor line, h = its HTML. The
 * preview keeps one "shell" document in its sandboxed iframe and only swaps
 * the blocks that changed (keyed), so typing never reloads the page, keeps the
 * scroll position and leaves live ```html blocks alone.
 *
 * Everything the editor shows is rendered: GFM (tables, task lists — a click
 * ticks the box in the note —, strikethrough, autolinks), line breaks as
 * typed, headings with anchors, callouts ("> [!tip] Title", "-" / "+" fold),
 * highlights (%%yellow|text%%, %%bg/fg|text%%, legacy ==color|text==),
 * ||spoilers||, pasted / drawn images (![img:…], resolved by the app), file
 * pills, footnotes ([^id] + "[^id]: text"), lightly highlighted code, and
 * ```html blocks as live embedded pages (with the ```css / ```js beside them).
 * cb: { embed(line, code) -> key | '', image(code, isRef, data) -> key }.
 * A private marked instance (new marked.Marked) — the File Converter's global
 * marked config is untouched. ES5. */
(function (root) {
  'use strict';

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function hash(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h.toString(36) + s.length.toString(36);
  }
  function countNL(s, a, b) { var n = 0; for (var i = a; i < b; i++) if (s.charCodeAt(i) === 10) n++; return n; }
  function slugify(s) {
    return String(s).toLowerCase().replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/g, '').trim()
      .replace(/[^\wÀ-￿\- ]+/g, '').replace(/\s+/g, '-').slice(0, 80) || 'section';
  }

  // ---- highlights (same rules as the editor: a known colour or #hex, else not a highlight) ----
  var BG = { yellow: 'rgba(250,204,21,.38)', green: 'rgba(34,197,94,.30)', blue: 'rgba(59,130,246,.28)', red: 'rgba(239,68,68,.28)', pink: 'rgba(236,72,153,.28)', purple: 'rgba(168,85,247,.28)', orange: 'rgba(249,115,22,.32)', gray: 'rgba(120,113,108,.28)' };
  var FG = { yellow: '#ca8a04', green: '#16a34a', blue: '#2563eb', red: '#dc2626', pink: '#db2777', purple: '#9333ea', orange: '#ea580c', gray: '#78716c' };
  function color(tok) {
    var t = String(tok || '').trim();
    if (BG[t.toLowerCase()]) return t.toLowerCase();
    return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(t) ? t.toLowerCase() : null;
  }
  function hlSpec(spec) {
    var p = String(spec).split('/');
    if (p.length > 2) return null;
    var b = p[0].trim(), f = p.length > 1 ? p[1].trim() : '';
    var bg = b ? color(b) : null, fg = f ? color(f) : null;
    if ((b && !bg) || (f && !fg) || (!bg && !fg)) return null;
    return { bg: bg, fg: fg };
  }
  function hlStyle(bg, fg) {
    var s = '';
    if (bg) s += 'background:' + (BG[bg] || bg + '40') + ';';
    else s += 'background:none;';
    if (fg) s += 'color:' + (FG[fg] || fg) + ';';
    return s;
  }

  // ---- code: a light highlighter (comments, strings, numbers, keywords / tags) ----
  var KW_JS = 'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|import|export|from|default|typeof|instanceof|await|async|yield|try|catch|finally|throw|delete|void|in|of|this|null|true|false|undefined|interface|type|enum|implements|public|private|protected|readonly|static|get|set';
  var KW_PY = 'def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|global|nonlocal|yield|assert|del|async|await|match|case|self';
  var KW_SH = 'if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|export|local|echo|cd|sudo|exit|set|unset|source|alias';
  var STR = '"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'';
  var NUM = '\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b';
  function mk(com, str, kw) { return new RegExp('(' + com + ')|(' + str + ')|(' + NUM + ')|' + (kw ? '\\b(' + kw + ')\\b' : '()'), 'g'); }
  var LANGS = {
    js: mk('\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', STR + '|`(?:[^`\\\\]|\\\\.)*`', KW_JS),
    py: mk('#[^\\n]*', '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|' + STR, KW_PY),
    sh: mk('#[^\\n]*', STR, KW_SH),
    css: mk('\\/\\*[\\s\\S]*?\\*\\/', STR, '@media|@import|@keyframes|@font-face|!important'),
    json: mk('\\/\\/[^\\n]*', STR, 'true|false|null'),
    html: /(<!--[\s\S]*?-->)|("[^"\n]*"|'[^'\n]*')|()|(<\/?[A-Za-z][\w:-]*|\/?>)/g,
    sql: mk('--[^\\n]*', STR, 'select|from|where|and|or|not|insert|into|values|update|set|delete|create|table|join|left|right|inner|outer|on|group|by|order|having|limit|as|distinct|null|is|in|like|count|sum|avg|min|max|SELECT|FROM|WHERE|AND|OR|NOT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|AS|DISTINCT|NULL|IS|IN|LIKE'),
  };
  var ALIAS = { javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js', node: 'js', python: 'py', python3: 'py', py3: 'py', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellsession: 'sh', scss: 'css', less: 'css', xml: 'html', svg: 'html', htm: 'html', jsonc: 'json', json5: 'json', postgres: 'sql', sqlite: 'sql', mysql: 'sql' };
  var TK = [null, 'tk-c', 'tk-s', 'tk-n', 'tk-k'];
  function highlight(code, lang) {
    var re = LANGS[ALIAS[lang] || lang];
    if (!re || code.length > 200000) return esc(code);
    re.lastIndex = 0;
    var out = '', last = 0, m;
    while ((m = re.exec(code)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }
      var g = m[1] != null ? 1 : m[2] != null ? 2 : m[3] ? 3 : 4;
      out += esc(code.slice(last, m.index)) + '<span class="' + TK[g] + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    return out + esc(code.slice(last));
  }

  // ---- callouts: "> [!type] Title" (GitHub's "> [!NOTE]" too), "-" / "+" fold ----
  var CO = {
    note: ['✎', '#2563eb'], abstract: ['☰', '#0891b2'], info: ['ℹ', '#2563eb'], todo: ['☑', '#2563eb'],
    tip: ['💡', '#0d9488'], important: ['❗', '#9333ea'], success: ['✔', '#16a34a'], question: ['?', '#ca8a04'],
    warning: ['⚠', '#ea580c'], failure: ['✖', '#dc2626'], danger: ['⚡', '#dc2626'], bug: ['🐞', '#dc2626'],
    example: ['≡', '#7c3aed'], quote: ['❝', '#78716c'],
  };
  var CO_ALIAS = { summary: 'abstract', tldr: 'abstract', hint: 'tip', check: 'success', done: 'success', help: 'question', faq: 'question', caution: 'warning', attention: 'warning', fail: 'failure', missing: 'failure', error: 'danger', cite: 'quote' };
  function callout(body) {
    var m = /^<p>\[!([A-Za-z]+)\]([+-]?)[ \t]*([^<\n]*)(?:<br>\n?|\n)?/.exec(body);
    if (!m) return '';
    var raw = m[1].toLowerCase(), type = CO[raw] ? raw : CO_ALIAS[raw] || 'note', c = CO[type];
    var title = m[3].trim() || raw.charAt(0).toUpperCase() + raw.slice(1);
    var rest = body.slice(m[0].length);
    rest = /^<\/p>/.test(rest) ? rest.replace(/^<\/p>\n?/, '') : '<p>' + rest;
    var head = '<span class="md-co-i" aria-hidden="true">' + c[0] + '</span><span class="md-co-t">' + title + '</span>';
    var attrs = ' class="md-co md-co-' + type + '" style="--co:' + c[1] + '"';
    var inner = rest.trim() ? '<div class="md-co-b">' + rest + '</div>' : '';
    if (m[2]) return '<details' + attrs + (m[2] === '+' ? ' open' : '') + '><summary class="md-co-h">' + head + '</summary>' + inner + '</details>\n';
    return '<div' + attrs + '><div class="md-co-h">' + head + '</div>' + inner + '</div>\n';
  }

  function fmtSize(n) { n = +n || 0; return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

  function create(marked) {
    var cur = null, slugs = {};
    var M = new marked.Marked({ gfm: true, breaks: true, async: false });
    M.use({
      extensions: [
        { // pasted / drawn images: ![img:j:BASE64] or ![img:j#hash], optional |w320
          name: 'cimg', level: 'inline',
          start: function (s) { var i = s.indexOf('![img:'); return i < 0 ? undefined : i; },
          tokenizer: function (s) {
            var m = /^!\[img:(?:([jwa])([:#]))?([A-Za-z0-9+/=]+)(?:\|w(\d{2,4}))?\]/.exec(s);
            if (!m || (m[2] !== '#' && m[3].length < 24)) return undefined;
            return { type: 'cimg', raw: m[0], code: m[1] || 'j', ref: m[2] === '#', data: m[3], w: m[4] ? +m[4] : 0 };
          },
          renderer: function (t) {
            var key = cur && cur.image ? cur.image(t.code, t.ref, t.data) : '';
            return '<img class="md-cimg" alt="image" data-cimg="' + esc(key) + '"' + (t.w ? ' style="width:' + t.w + 'px"' : '') + '>';
          },
        },
        { // attached files: ![file:name#hash|s1234]
          name: 'cfile', level: 'inline',
          start: function (s) { var i = s.indexOf('![file:'); return i < 0 ? undefined : i; },
          tokenizer: function (s) {
            var m = /^!\[file:([^\]\n#|]{1,120})#([a-f0-9]{16,64})(?:\|s(\d{1,12}))?\]/.exec(s);
            return m ? { type: 'cfile', raw: m[0], name: m[1], size: m[3] ? +m[3] : -1 } : undefined;
          },
          renderer: function (t) { return '<span class="md-file">📎 ' + esc(t.name) + (t.size >= 0 ? ' <small>' + fmtSize(t.size) + '</small>' : '') + '</span>'; },
        },
        { // highlights: %%bg/fg|text%%, legacy ==color|text==
          name: 'hl', level: 'inline',
          start: function (s) { var i = s.search(/%%|==[A-Za-z]/); return i < 0 ? undefined : i; },
          tokenizer: function (s) {
            var m = /^%%([^|%\n]{1,32})\|([\s\S]+?)%%/.exec(s), sp = m && hlSpec(m[1]);
            if (!sp) {
              m = /^==([a-zA-Z]{3,10})\|([\s\S]+?)==/.exec(s);
              sp = m && BG[m[1].toLowerCase()] ? { bg: m[1].toLowerCase(), fg: null } : null;
            }
            if (!sp || m[0].length > 4000) return undefined;
            return { type: 'hl', raw: m[0], bg: sp.bg, fg: sp.fg, tokens: this.lexer.inlineTokens(m[2]) };
          },
          renderer: function (t) { return '<mark class="md-hl" style="' + hlStyle(t.bg, t.fg) + '">' + this.parser.parseInline(t.tokens) + '</mark>'; },
        },
        { // ||spoiler||
          name: 'spoiler', level: 'inline',
          start: function (s) { var i = s.indexOf('||'); return i < 0 ? undefined : i; },
          tokenizer: function (s) {
            var m = /^\|\|([^|\s](?:[^\n]*?[^|\s])?)\|\|/.exec(s);
            return m ? { type: 'spoiler', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) } : undefined;
          },
          renderer: function (t) { return '<span class="md-spoiler" title="Spoiler — click to reveal">' + this.parser.parseInline(t.tokens) + '</span>'; },
        },
        { // footnote reference [^id]
          name: 'fnref', level: 'inline',
          start: function (s) { var i = s.indexOf('[^'); return i < 0 ? undefined : i; },
          tokenizer: function (s) {
            var m = /^\[\^([^\]\s]{1,40})\](?!:)/.exec(s);
            return m ? { type: 'fnref', raw: m[0], id: m[1] } : undefined;
          },
          renderer: function (t) { return '<sup class="md-fn"><a href="#fn-' + esc(slugify(t.id)) + '">' + esc(t.id) + '</a></sup>'; },
        },
        { // footnote definition "[^id]: text" (indented lines continue it)
          name: 'fndef', level: 'block',
          start: function (s) { var m = /(^|\n)\[\^[^\]\s]+\]:/.exec(s); return m ? m.index + m[1].length : undefined; },
          tokenizer: function (s) {
            var m = /^\[\^([^\]\s]{1,40})\]:[ \t]*([^\n]*(?:\n(?:[ \t]{2,}|\t)[^\n]*)*)(?:\n|$)/.exec(s);
            return m ? { type: 'fndef', raw: m[0], id: m[1], tokens: this.lexer.inlineTokens(m[2].replace(/\n[ \t]+/g, ' ')) } : undefined;
          },
          renderer: function (t) { return '<div class="md-fndef" id="fn-' + esc(slugify(t.id)) + '"><sup>' + esc(t.id) + '</sup> ' + this.parser.parseInline(t.tokens) + '</div>\n'; },
        },
      ],
      renderer: {
        heading: function (t) {
          var inner = this.parser.parseInline(t.tokens), id = slugify(inner), n = slugs[id] = (slugs[id] || 0) + 1;
          if (n > 1) id += '-' + (n - 1);
          return '<h' + t.depth + ' id="' + esc(id) + '">' + inner + '</h' + t.depth + '>\n';
        },
        code: function (t) {
          var info = String(t.lang || '').trim(), lang = info.split(/\s+/)[0].toLowerCase();
          if (lang === 'html' && t.__l && cur && cur.embed) {
            var ek = cur.embed(t.__l, t.text);
            if (ek) return '<div class="md-embed" data-ek="' + esc(ek) + '"></div>\n';
          }
          return '<div class="md-code' + (lang === 'output' ? ' md-output' : '') + '">' + (info ? '<span class="md-lang">' + esc(info) + '</span>' : '') +
            '<pre><code>' + highlight(t.text, lang) + '</code></pre></div>\n';
        },
        checkbox: function (t) {
          return '<input type="checkbox"' + (t.checked ? ' checked' : '') + (t.__l ? ' data-tl="' + t.__l + '" title="Tick in the note"' : ' disabled') + '> ';
        },
        blockquote: function (t) {
          var body = this.parser.parse(t.tokens);
          return callout(body) || '<blockquote>\n' + body + '</blockquote>\n';
        },
      },
    });

    // Line numbers: every token's raw text sits, in order, inside its parent's
    // raw text — so walk them with indexOf (lists + items + task checkboxes).
    function annotate(list, raw, line) {
      var pos = 0;
      for (var i = 0; i < (list || []).length; i++) {
        var t = list[i];
        if (!t || typeof t.raw !== 'string' || !t.raw) continue;
        var at = raw.indexOf(t.raw, pos);
        if (at < 0) continue;
        line += countNL(raw, pos, at);
        t.__l = line;
        if (t.type === 'list') annotate(t.items, t.raw, line);
        else if (t.type === 'list_item') annotate(t.tokens, t.raw, line);
        line += countNL(raw, at, at + t.raw.length);
        pos = at + t.raw.length;
      }
    }

    function render(src, cb) {
      cur = cb || {}; slugs = {};
      src = String(src || '').replace(/\r\n?/g, '\n');
      var out = [], seen = {}, toks;
      try { toks = M.lexer(src); } catch (e) { cur = null; return [{ k: 'err', l: 1, h: '<pre class="md-err">' + esc(src) + '</pre>' }]; }
      annotate(toks, src, 1);
      for (var i = 0; i < toks.length; i++) {
        var t = toks[i];
        if (t.type === 'space' || t.type === 'def') continue;
        var h;
        try { h = M.parser([t]); } catch (e) { h = '<pre class="md-err">' + esc(t.raw) + '</pre>'; }
        if (!h || !h.trim()) continue;
        var k = hash(h);
        seen[k] = (seen[k] || 0) + 1;
        out.push({ k: k + '.' + seen[k], l: t.__l || 0, h: h });
      }
      cur = null;
      return out;
    }
    return { render: render, shellDoc: shellDoc, staticDoc: staticDoc, highlight: highlight, hash: hash };
  }

  // ---- the shell document (lives in the preview's sandboxed iframe) ----------------------------
  var CSS = [
    ':root{color-scheme:light dark}',
    'html{-webkit-text-size-adjust:100%}',
    'body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 var(--font-body);}',
    '.md{max-width:780px;margin:0 auto;padding:18px 22px 64px;overflow-wrap:break-word}',
    '.md-b{position:relative}',
    '.md-b.md-cur::before{content:"";position:absolute;left:-12px;top:3px;bottom:3px;width:3px;border-radius:2px;background:var(--accent);opacity:.5}',
    'h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.1em 0 .5em;font-weight:650}',
    'h1{font-size:1.75em}h2{font-size:1.4em;padding-bottom:.2em;border-bottom:1px solid var(--border)}h3{font-size:1.18em}h4{font-size:1.02em}h5,h6{font-size:.92em;color:var(--text-muted)}',
    '.md>.md-b:first-child>:first-child{margin-top:0}',
    'p{margin:0 0 .8em}',
    'a{color:var(--accent);text-underline-offset:2px}',
    'strong{font-weight:650}',
    'code{font:.88em var(--font-mono);background:var(--surface-2);border:1px solid var(--border);padding:.05em .35em;border-radius:4px}',
    '.md-code{position:relative;margin:0 0 1em}',
    'pre{margin:0;padding:10px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;overflow:auto;font:12.5px/1.5 var(--font-mono);tab-size:4}',
    'pre code{background:none;border:0;padding:0;font:inherit}',
    '.md-lang{position:absolute;top:3px;right:8px;font:11px var(--font-mono);color:var(--text-faint);pointer-events:none}',
    '.md-output pre{border-style:dashed;color:var(--text-muted)}',
    '.tk-c{color:var(--text-faint);font-style:italic}.tk-s{color:var(--tk-s)}.tk-n{color:var(--tk-n)}.tk-k{color:var(--accent);font-weight:600}',
    'blockquote{margin:0 0 1em;padding:.1em 1em;border-left:3px solid var(--border);color:var(--text-muted)}',
    'blockquote>:last-child{margin-bottom:0}',
    'ul,ol{margin:0 0 .8em;padding-left:1.6em}li{margin:.15em 0}li>p{margin:0 0 .3em}li>ul,li>ol{margin-bottom:0}',
    'li:has(>input[type=checkbox]){list-style:none;margin-left:-1.35em}',
    'input[type=checkbox]{margin:0 .45em 0 0;vertical-align:-2px;width:15px;height:15px;accent-color:var(--accent)}',
    'input[type=checkbox][data-tl]{cursor:pointer}',
    'li:has(>input:checked){color:var(--text-muted)}',
    'table{border-collapse:collapse;margin:0 0 1em;display:block;overflow-x:auto;max-width:100%}',
    'th,td{border:1px solid var(--border);padding:5px 10px;vertical-align:top}th{background:var(--surface-2);text-align:left;font-weight:600}',
    'hr{border:0;border-top:1px solid var(--border);margin:1.4em 0}',
    'img{max-width:100%;height:auto;border-radius:6px}',
    '.md-cimg:not([src]){display:inline-block;width:120px;height:80px;background:var(--surface-2);border:1px dashed var(--border)}',
    'mark.md-hl{border-radius:3px;padding:0 .12em;color:inherit}',
    '.md-spoiler{background:var(--text);color:transparent;border-radius:3px;cursor:pointer;transition:background .15s,color .15s}',
    '.md-spoiler.shown{background:var(--surface-2);color:inherit}.md-spoiler:not(.shown) *{visibility:hidden}',
    '.md-file{display:inline-flex;align-items:center;gap:4px;padding:0 8px;border:1px solid var(--border);border-radius:999px;font-size:.9em;background:var(--surface)}',
    '.md-file small{color:var(--text-muted)}',
    '.md-fn a{text-decoration:none;padding:0 1px}.md-fndef{font-size:.9em;color:var(--text-muted);margin:0 0 .4em}.md-fndef sup{color:var(--accent)}',
    '.md-co{margin:0 0 1em;border-left:3px solid var(--co);background:color-mix(in srgb,var(--co) 9%,transparent);border-radius:6px;padding:8px 12px}',
    '.md-co-h{display:flex;align-items:center;gap:7px;font-weight:650;color:var(--co)}summary.md-co-h{cursor:pointer}',
    '.md-co-b{margin-top:6px}.md-co-b>:last-child{margin-bottom:0}',
    '.md-embed{margin:0 0 1em;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:#fff;min-height:40px}',
    '.md-embed-f{display:block;width:100%;height:160px;border:0;background:#fff}',
    '.md-err{color:var(--text-muted)}',
    '.md-empty{color:var(--text-faint);text-align:center;padding:48px 12px}',
    '@media (max-width:520px){.md{padding:14px 14px 56px}body{font-size:15.5px}}',
  ].join('\n');

  // Runs inside the sandboxed iframe (ES5, shipped via toString).
  function SHELL(TOKEN) {
    var P = window.parent, root = document.getElementById('md'), imgs = {}, embeds = {}, curEl = null;
    function up(m) { m.__md = TOKEN; try { P.postMessage(m, '*'); } catch (e) {} }
    function blockOf(el) { while (el && el.parentNode !== root) el = el.parentNode; return el; }
    function mount(ph) {
      if (ph.firstChild) return;
      var doc = embeds[ph.getAttribute('data-ek')];
      if (doc == null) return;
      var f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts allow-modals allow-forms allow-popups');
      f.setAttribute('title', 'HTML block');
      f.setAttribute('loading', 'lazy');
      f.className = 'md-embed-f';
      f.srcdoc = doc;
      ph.appendChild(f);
    }
    function fill(el) {
      var a = el.querySelectorAll('img[data-cimg]'), i;
      for (i = 0; i < a.length; i++) { var s = imgs[a[i].getAttribute('data-cimg')]; if (s && a[i].getAttribute('src') !== s) a[i].src = s; }
      var e = el.querySelectorAll('.md-embed[data-ek]');
      for (i = 0; i < e.length; i++) mount(e[i]);
    }
    function render(list) {
      var want = {}, have = {}, i, kids;
      for (i = 0; i < list.length; i++) want[list[i].k] = 1;
      // drop blocks that are gone first, so the ones that stay never move (a moved iframe reloads)
      kids = Array.prototype.slice.call(root.children);
      for (i = 0; i < kids.length; i++) {
        var key = kids[i].getAttribute('data-k');
        if (!want[key] || have[key]) root.removeChild(kids[i]);
        else have[key] = kids[i];
      }
      var ptr = root.firstElementChild;
      for (i = 0; i < list.length; i++) {
        var b = list[i], el = have[b.k];
        if (!el) {
          if (b.h == null) { up({ type: 'resync' }); return; }
          el = document.createElement('div');
          el.className = 'md-b';
          el.setAttribute('data-k', b.k);
          el.innerHTML = b.h;
          fill(el);
        }
        if (el.getAttribute('data-l') !== String(b.l)) el.setAttribute('data-l', String(b.l));
        if (el === ptr) ptr = ptr.nextElementSibling;
        else root.insertBefore(el, ptr);
      }
      if (!list.length) root.innerHTML = '<div class="md-empty">This note is empty.</div>';
      else { var em = root.querySelector('.md-empty'); if (em) em.remove(); }
      // forget images / pages no block uses any more (the app forgets them too)
      var live = {}, ph = root.querySelectorAll('[data-ek],[data-cimg]'), k2;
      for (i = 0; i < ph.length; i++) live[ph[i].getAttribute('data-ek') || ph[i].getAttribute('data-cimg')] = 1;
      for (k2 in embeds) if (!live[k2]) delete embeds[k2];
      for (k2 in imgs) if (!live[k2]) delete imgs[k2];
    }
    function toLine(n, force) {
      var kids = root.children, best = null;
      for (var i = 0; i < kids.length; i++) {
        var l = +kids[i].getAttribute('data-l');
        if (l && l <= n) best = kids[i];
        else if (l > n) break;
      }
      if (!best) best = root.firstElementChild;
      if (!best) return;
      if (curEl !== best) { if (curEl) curEl.classList.remove('md-cur'); best.classList.add('md-cur'); curEl = best; }
      var r = best.getBoundingClientRect(), vh = window.innerHeight;
      if (force || r.bottom < 8 || r.top > vh - 8) best.scrollIntoView({ block: r.height > vh * 0.8 ? 'start' : 'center' });
    }
    window.addEventListener('message', function (e) {
      var m = e.data;
      if (e.source === P) {
        if (!m || m.__md !== TOKEN) return;
        if (m.type === 'render') render(m.blocks || []);
        else if (m.type === 'img') { imgs[m.key] = m.src; fill(root); }
        else if (m.type === 'embeds') { (m.list || []).forEach(function (x) { embeds[x.ek] = x.html; }); fill(root); }
        else if (m.type === 'line') toLine(+m.line || 1, !!m.force);
        else if (m.type === 'vars') { var v = document.getElementById('md-vars'); if (v) v.textContent = m.css; }
        return;
      }
      if (!m || typeof m !== 'object') return;
      if (m.__mdh) { // an embedded html block reports its height
        var fs = document.querySelectorAll('iframe.md-embed-f');
        for (var i = 0; i < fs.length; i++) if (fs[i].contentWindow === e.source) fs[i].style.height = Math.max(40, Math.min(2400, +m.h || 0)) + 'px';
        return;
      }
      if (m.__cr && m.type !== 'scroll') { try { P.postMessage(m, '*'); } catch (x) {} } // console output -> the app
    });
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      // the box flips when the note does (the block re-renders) — read-only notes stay as they are
      if (t.matches('input[type=checkbox][data-tl]')) { e.preventDefault(); up({ type: 'task', line: +t.getAttribute('data-tl') }); return; }
      var sp = t.closest('.md-spoiler');
      if (sp) { sp.classList.toggle('shown'); e.preventDefault(); return; }
      var a = t.closest('a[href^="#"]');
      if (a) {
        e.preventDefault();
        var id = decodeURIComponent(a.getAttribute('href').slice(1)), tg = document.getElementById(id);
        if (tg) tg.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    });
    document.addEventListener('dblclick', function (e) {
      var b = blockOf(e.target);
      if (b && b.getAttribute('data-l')) up({ type: 'goto', line: +b.getAttribute('data-l') });
    });
    up({ type: 'ready' });
  }

  // vars: CSS text for :root (--bg, --text, … taken from the app's theme)
  function shellDoc(token, vars) {
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<base target="_blank"><title>Preview</title><style id="md-vars">' + vars + '</style><style>' + CSS + '</style></head>' +
      '<body><article id="md" class="md"></article><script>(' + SHELL.toString() + ')(' + JSON.stringify(String(token)) + ');<\/script></body></html>';
  }
  // A standalone page (Copy / Open in a new tab): images inlined, html blocks as sandboxed frames.
  function staticDoc(blocks, vars, imgs, embeds) {
    var body = blocks.map(function (b) { return b.h; }).join('\n')
      .replace(/<img class="md-cimg" alt="image" data-cimg="([^"]*)"/g, function (m0, k) { return imgs[k] ? '<img class="md-cimg" alt="image" src="' + esc(imgs[k]) + '"' : m0; })
      .replace(/<div class="md-embed" data-ek="([^"]*)"><\/div>/g, function (m0, k) {
        return embeds[k] ? '<div class="md-embed"><iframe class="md-embed-f" style="height:360px" sandbox="allow-scripts allow-modals allow-forms allow-popups" srcdoc="' + esc(embeds[k]) + '"></iframe></div>' : '';
      });
    return '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Note</title>\n<style>\n' + vars + '\n' + CSS +
      '\n.md-spoiler:hover{background:var(--surface-2);color:inherit}.md-spoiler:hover *{visibility:visible}\n</style>\n</head>\n<body>\n<article class="md">\n' + body + '\n</article>\n</body>\n</html>\n';
  }

  var api = { create: create, hash: hash, slugify: slugify, CSS: CSS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__cadeMdPreview = api;
})(typeof self !== 'undefined' ? self : this);
