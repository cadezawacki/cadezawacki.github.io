/* Slash commands — type "/" at the start of a line (after optional indentation
 * or a list marker) or after a space, and a small menu opens at the caret:
 * headings, lists, todo, quote, callouts, code block, table, divider, date /
 * time, link and inline wrappers, the core's "/code" symbol shortcuts, then
 * every widget and script from the Ctrl+K palette (Cade.commands()). Keep
 * typing to filter (fuzzy: /tab → Table, /td → Todo); ↑ ↓ move, Enter / Tab
 * pick, Esc closes, a space that leaves nothing matching closes, and so does
 * moving the caret away. Picking removes the "/query" and runs the command.
 *
 * Input is read from document CHANGES, not keydown, so soft keyboards and
 * IMEs work. Only the menu's navigation keys are captured, only while it is
 * showing, by a DOCUMENT-level capture listener: that runs before the core's
 * capture-phase handlers on the editor (Enter list-continuation, @-injection,
 * the core dropdown), so Enter on "- /todo" picks the item instead of
 * continuing the list. While a "/" is being handled here the core's own
 * "/code" dropdown stands down (Cade.claimSlash) — its symbols are listed in
 * this menu instead.
 *
 * Cheap: update() returns at once unless the menu is open or the change typed
 * a "/". No "/" inside ``` fences, `inline code`, URLs or paths (a/b), or in
 * read-only mode. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var CM = Cade.CM;
  if (!CM || !CM.ViewPlugin) return;
  Cade.loadCSS('slash.css');

  var ViewPlugin = CM.ViewPlugin;
  var MAX_Q = 40;     // longest query the menu stays alive for
  var MAX_ROWS = 150; // rendered-row cap (an empty query lists everything)
  var active = null;  // the live plugin instance (there is one editor)

  function esc(s) { return Cade.escapeHtml(String(s == null ? '' : s)); }
  function lower(s) { return String(s || '').toLowerCase(); }
  function inFence(pos) { try { return !!(Cade.inCodeFence && Cade.inCodeFence(pos)); } catch (e) { return false; } }
  // Palette icons are emoji or trusted inline <svg> strings (the palette
  // renders them raw too); anything else is escaped.
  function iconHtml(ic) { ic = String(ic || ''); return /^\s*<svg[\s>]/i.test(ic) ? ic : esc(ic); }

  // ---- line edits -------------------------------------------------------------
  // Every built-in rewrites the caret's line in ONE change (single undo step).
  // c = { text: line with "/query" removed, col: caret column in it }; actions
  // return { text, anchor, head } relative to the line start.
  var PREFIX_RE = /^([ \t]*)(#{1,6}[ \t]+|>[ \t]?(?:\[![^\]\n]*\][+-]?[ \t]*)?|(?:[-*+•]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|\[[ xX]\][ \t]+)?/;

  // Turn the line into a block of another kind, replacing any heading / quote /
  // callout / list / checkbox prefix it already has (so "- /h2" → "## ").
  function setPrefix(prefix, keepIndent) {
    return function (c) {
      var m = PREFIX_RE.exec(c.text);
      var lead = (keepIndent ? m[1] : '') + (typeof prefix === 'function' ? prefix(c, m[1]) : prefix);
      var col = Math.max(0, c.col - m[0].length);
      return { text: lead + c.text.slice(m[0].length), anchor: lead.length + col };
    };
  }
  // Insert at the caret; `caret` is the offset inside `ins`, `sel` a length to select.
  function inline(ins, caret, sel) {
    return function (c) {
      var s = typeof ins === 'function' ? ins() : ins;
      var at = caret == null ? s.length : caret;
      return { text: c.text.slice(0, c.col) + s + c.text.slice(c.col), anchor: c.col + at, head: c.col + at + (sel || 0) };
    };
  }
  // Multi-line block: replaces a blank line, otherwise goes on the next line.
  function block(ins, caret, sel) {
    return function (c) {
      if (!c.text.trim()) return { text: ins, anchor: caret, head: caret + (sel || 0) };
      var base = c.text.replace(/[ \t]+$/, '');
      var at = base.length + 1 + caret;
      return { text: base + '\n' + ins, anchor: at, head: at + (sel || 0) };
    };
  }
  // "1." continues the numbering of a numbered line right above at the same indent.
  function numberPrefix(c, indent) {
    var m = c.prev && /^([ \t]*)(\d{1,9})([.)])[ \t]/.exec(c.prev);
    return m && m[1] === indent ? (parseInt(m[2], 10) + 1) + m[3] + ' ' : '1. ';
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function clock() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  var TABLE = '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';

  // ---- built-in commands ------------------------------------------------------
  // keys: space-separated aliases (an exact alias ranks first; also shown as the
  // hint). The core's old "/table", "/todo", "/hr", "/h1", "/note", "/now"…
  // snippet names are all aliases here, so muscle memory keeps working.
  var BUILTINS = [
    { sec: 'Blocks', name: 'Text', desc: 'Plain paragraph (drop heading / list / quote)', icon: 'Aa', keys: 'text p paragraph plain', act: setPrefix('', true) },
    { sec: 'Blocks', name: 'Heading 1', desc: 'Big section heading', icon: 'H1', keys: 'h1 # title', act: setPrefix('# ', false) },
    { sec: 'Blocks', name: 'Heading 2', desc: 'Medium section heading', icon: 'H2', keys: 'h2 ## subtitle', act: setPrefix('## ', false) },
    { sec: 'Blocks', name: 'Heading 3', desc: 'Small section heading', icon: 'H3', keys: 'h3 ###', act: setPrefix('### ', false) },
    { sec: 'Blocks', name: 'Bullet list', desc: 'Simple bulleted list', icon: '•', keys: 'ul bullet bullets unordered - list', act: setPrefix('- ', true) },
    { sec: 'Blocks', name: 'Numbered list', desc: 'List with numbering', icon: '1.', keys: 'ol numbered ordered number 1.', act: setPrefix(numberPrefix, true) },
    { sec: 'Blocks', name: 'Todo', desc: 'Checkbox task', icon: '☐', keys: 'todo task checkbox box [] check', act: setPrefix('[ ] ', true) },
    { sec: 'Blocks', name: 'Quote', desc: 'Block quote', icon: '❝', keys: 'quote blockquote > cite', act: setPrefix('> ', false) },
    { sec: 'Callouts', name: 'Note callout', desc: '> [!note] box', icon: '📝', keys: 'note callout', act: setPrefix('> [!note] ', false) },
    { sec: 'Callouts', name: 'Tip callout', desc: '> [!tip] box', icon: '💡', keys: 'tip hint callout', act: setPrefix('> [!tip] ', false) },
    { sec: 'Callouts', name: 'Info callout', desc: '> [!info] box', icon: 'ℹ️', keys: 'info callout', act: setPrefix('> [!info] ', false) },
    { sec: 'Callouts', name: 'Warning callout', desc: '> [!warning] box', icon: '⚠️', keys: 'warning warn caution callout', act: setPrefix('> [!warning] ', false) },
    { sec: 'Callouts', name: 'Danger callout', desc: '> [!danger] box', icon: '⛔', keys: 'danger error callout', act: setPrefix('> [!danger] ', false) },
    { sec: 'Callouts', name: 'Collapsible callout', desc: '> [!note]- starts folded', icon: '▸', keys: 'fold collapse collapsible details toggle callout', act: setPrefix('> [!note]- ', false) },
    { sec: 'Insert', name: 'Code block', desc: '``` fenced code', icon: '{ }', keys: 'code block fence ``` pre snippet', act: block('```\n\n```', 4) },
    { sec: 'Insert', name: 'Table', desc: '3 × 2 markdown table', icon: '▦', keys: 'table grid', act: block(TABLE, 2, 8) },
    { sec: 'Insert', name: 'Divider', desc: 'Horizontal rule ---', icon: '—', keys: 'divider hr rule line --- separator', act: block('---\n', 4) },
    { sec: 'Insert', name: 'Date', desc: "Today's date", icon: '📅', keys: 'date today day', act: inline(today) },
    { sec: 'Insert', name: 'Time', desc: 'Current time', icon: '🕒', keys: 'time clock', act: inline(clock) },
    { sec: 'Insert', name: 'Date & time', desc: 'Date and current time', icon: '🗓️', keys: 'now datetime timestamp stamp', act: inline(function () { return today() + ' ' + clock(); }) },
    { sec: 'Insert', name: 'Link', desc: '[text](url)', icon: '🔗', keys: 'link url href', act: inline('[]()', 1) },
    { sec: 'Format', name: 'Bold', desc: '**bold**', icon: 'B', keys: 'bold strong b', act: inline('****', 2) },
    { sec: 'Format', name: 'Italic', desc: '*italic*', icon: 'I', keys: 'italic em i', act: inline('**', 1) },
    { sec: 'Format', name: 'Strikethrough', desc: '~~strike~~', icon: 'S', keys: 'strike strikethrough del s', act: inline('~~~~', 2) },
    { sec: 'Format', name: 'Highlight', desc: '==highlight==', icon: '==', keys: 'highlight mark ==', act: inline('====', 2) },
    { sec: 'Format', name: 'Inline code', desc: '`code`', icon: '`', keys: 'inline tick backtick mono', act: inline('``', 1) },
  ];
  BUILTINS.forEach(function (b) {
    b.kind = 'builtin';
    b.ln = lower(b.name);
    b.keyset = ' ' + lower(b.keys) + ' ';
    b.hint = b.keys.split(' ')[0];
  });

  // ---- matching -----------------------------------------------------------------
  function fuzzy(q, s) {
    var qi = 0;
    for (var i = 0; i < s.length && qi < q.length; i++) if (s.charCodeAt(i) === q.charCodeAt(qi)) qi++;
    return qi === q.length;
  }
  function score(q, it) {
    if (!q) return 1;
    var n = it.ln;
    if (n === q || (it.keyset && it.keyset.indexOf(' ' + q + ' ') >= 0)) return 1000;
    if (n.indexOf(q) === 0) return 900;
    if (n.indexOf(' ' + q) > 0) return 850;          // a later word starts with q
    if (n.indexOf(q) > 0) return 800;
    if (it.keyset && it.keyset.indexOf(' ' + q) >= 0) return 760; // alias prefix
    if (it.lt && it.lt.indexOf(q) >= 0) return 600;  // tags
    if (it.ld && it.ld.indexOf(q) >= 0) return 500;  // description
    if (fuzzy(q, n)) return 400;
    if (it.keyset && fuzzy(q, it.keyset)) return 350;
    return 0;
  }
  function loadCommands() {
    var list = [];
    try { list = (Cade.commands && Cade.commands()) || []; } catch (e) { list = []; }
    return list.filter(function (c) { return c && c.name; }).map(function (c) {
      return {
        kind: c.kind === 'widget' ? 'widget' : 'script', name: c.name, desc: c.description || '',
        icon: c.icon || '', ln: lower(c.name), lt: lower(c.tags), ld: lower(c.description),
        hint: c.kind === 'widget' ? 'widget' : 'script',
      };
    });
  }
  function loadSymbols() {
    var out = [], codes = {};
    try { codes = (Cade.slashCodes && Cade.slashCodes()) || {}; } catch (e) { codes = {}; }
    for (var k in codes) {
      if (Object.prototype.hasOwnProperty.call(codes, k)) {
        out.push({ kind: 'symbol', code: k, sym: String(codes[k]), name: '/' + k, desc: 'Insert ' + codes[k], icon: String(codes[k]), hint: 'symbol' });
      }
    }
    return out;
  }
  var SYM_Q_RE = /^[-A-Za-z0-9<>=!~*.()$|]{1,6}$/; // the core's "/code" charset

  // Rows: exact symbol code first, then strong built-ins, strong commands,
  // weak built-ins, symbol prefixes, weak commands. Built-ins stay above the
  // palette's widgets/scripts at equal strength.
  // Spaces are NOT trimmed: "/heading 1" still matches, "/tab " doesn't —
  // which is what lets a space that matches nothing close the menu.
  function match(s, raw) {
    var q = lower(raw), hasSpace = /\s/.test(raw);
    var b1 = [], b2 = [], c1 = [], c2 = [], sx = [], sp = [];
    var i, it, sc;
    for (i = 0; i < BUILTINS.length; i++) {
      it = BUILTINS[i]; sc = score(q, it);
      if (sc >= 700) b1.push({ it: it, sc: sc }); else if (sc > 0) b2.push({ it: it, sc: sc });
    }
    if (!s.cmds) s.cmds = loadCommands();
    for (i = 0; i < s.cmds.length; i++) {
      it = s.cmds[i]; sc = score(q, it);
      if (sc >= 700) c1.push({ it: it, sc: sc }); else if (sc > 0) c2.push({ it: it, sc: sc });
    }
    // Symbol codes are case-sensitive (/x vs /X) and only listed once typed.
    if (raw && !hasSpace && SYM_Q_RE.test(raw)) {
      if (!s.syms) s.syms = loadSymbols();
      for (i = 0; i < s.syms.length; i++) {
        it = s.syms[i];
        if (it.code === raw) sx.push({ it: it, sc: 1100 });
        else if (it.code.indexOf(raw) === 0) sp.push({ it: it, sc: 650 });
      }
    }
    var bySc = function (a, b) { return b.sc - a.sc; };
    // Array.prototype.sort is stable in every current engine, so ties keep
    // the built-ins' curated order and the palette's order.
    [b1, b2, c1, c2].forEach(function (a) { a.sort(bySc); });
    sp.sort(function (a, b) { return a.it.code.length - b.it.code.length; });
    var all = sx.concat(b1, c1, b2, sp, c2);
    if (all.length > MAX_ROWS) all.length = MAX_ROWS;
    return all.map(function (r) { return r.it; });
  }

  // ---- trigger --------------------------------------------------------------------
  // Did this update TYPE a "/" (not paste / undo / remote sync)?
  function typedSlash(u) {
    var hit = false;
    for (var i = 0; i < u.transactions.length && !hit; i++) {
      var tr = u.transactions[i];
      if (!tr.docChanged || !tr.isUserEvent('input.type')) continue;
      tr.changes.iterChanges(function (fa, ta, fb, tb, ins) {
        if (!hit && ins.length && ins.length <= 8 && ins.toString().indexOf('/') >= 0) hit = true;
      });
    }
    return hit;
  }
  // Is the "/" right before `head` a command trigger?
  function canStart(st, head) {
    if (st.readOnly || st.selection.ranges.length !== 1 || !st.selection.main.empty) return false;
    var line = st.doc.lineAt(head);
    if (line.length > 2000) return false;
    var t = line.text, col = head - line.from;
    if (col < 1 || t.charAt(col - 1) !== '/') return false;
    var prev = col >= 2 ? t.charAt(col - 2) : '';
    if (prev && !/\s/.test(prev)) return false;          // a/b, http://, 1/2
    var next = t.charAt(col);
    if (next && !/\s/.test(next)) return false;          // editing in front of a word / path
    if (inFence(line.from)) return false;
    var ticks = 0;
    for (var i = 0; i < col - 1; i++) if (t.charCodeAt(i) === 96) ticks++;
    return (ticks & 1) === 0;                             // not inside `inline code`
  }

  // ---- the plugin ---------------------------------------------------------------------
  function Slash(view) {
    this.view = view;
    this.s = null;   // session { pos (of "/"), q, rows, idx, cmds, syms }
    this.el = null;  // menu element while showing
    this.renderedQ = null;
    var self = this;
    this.onKey = function (e) { self.key(e); };
    this.onClick = function (e) { self.click(e); };
    this.onHover = function (e) { self.hover(e); };
    this.onMove = function () { if (self.el) self.place(); };
    active = this;
  }

  Slash.prototype.update = function (u) {
    if (!this.s) {
      if (!u.docChanged || !typedSlash(u)) return;
      var head = u.state.selection.main.head;
      if (!canStart(u.state, head)) return;
      this.s = { pos: head - 1, q: null, rows: [], idx: 0, cmds: null, syms: null };
    } else if (u.docChanged) {
      this.s.pos = u.changes.mapPos(this.s.pos, 1);
    } else if (!u.selectionSet && !u.focusChanged) {
      return; // scroll / decoration-only updates don't touch the query
    }
    this.refresh();
  };

  Slash.prototype.refresh = function () {
    var s = this.s, view = this.view, st = view.state, sel = st.selection;
    if (st.readOnly || sel.ranges.length !== 1 || !sel.main.empty || !view.hasFocus) return this.end();
    var head = sel.main.head;
    if (head <= s.pos || st.doc.sliceString(s.pos, s.pos + 1) !== '/') return this.end();
    var line = st.doc.lineAt(s.pos);
    if (head > line.to) return this.end();
    var q = st.doc.sliceString(s.pos + 1, head);
    if (q.length > MAX_Q || /^\s/.test(q)) return this.end();
    if (q !== s.q) { s.q = q; s.rows = match(s, q); s.idx = 0; }
    if (!s.rows.length) {
      if (/\s/.test(q)) return this.end(); // a space that matches nothing closes
      return this.hide();                  // keep listening: Backspace may revive it
    }
    this.show();
  };

  Slash.prototype.show = function () {
    if (!this.el) {
      var el = document.createElement('div');
      el.className = 'csl-menu';
      el.setAttribute('role', 'listbox');
      el.style.visibility = 'hidden'; // until the first measure places it
      // Keep focus (and the soft keyboard) in the editor when the menu is touched.
      el.addEventListener('mousedown', function (e) { e.preventDefault(); });
      el.addEventListener('click', this.onClick);
      el.addEventListener('mousemove', this.onHover);
      document.body.appendChild(el);
      this.el = el;
      this.renderedQ = null;
      document.addEventListener('keydown', this.onKey, true);
      this.view.scrollDOM.addEventListener('scroll', this.onMove, { passive: true });
      window.addEventListener('resize', this.onMove);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', this.onMove);
        window.visualViewport.addEventListener('scroll', this.onMove);
      }
    }
    if (this.renderedQ !== this.s.q) { this.render(); this.renderedQ = this.s.q; }
    this.place();
  };

  Slash.prototype.hide = function () {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    document.removeEventListener('keydown', this.onKey, true);
    this.view.scrollDOM.removeEventListener('scroll', this.onMove);
    window.removeEventListener('resize', this.onMove);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this.onMove);
      window.visualViewport.removeEventListener('scroll', this.onMove);
    }
  };

  Slash.prototype.end = function () { this.hide(); this.s = null; };

  Slash.prototype.destroy = function () { this.end(); if (active === this) active = null; };

  Slash.prototype.render = function () {
    var s = this.s, rows = s.rows, html = '', sec = null, grouped = !s.q;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (grouped) {
        var label = r.kind === 'builtin' ? r.sec : (r.kind === 'widget' ? 'Widgets' : 'Scripts');
        if (label !== sec) { html += '<div class="csl-sec">' + esc(label) + '</div>'; sec = label; }
      }
      html += '<div class="csl-item' + (i === s.idx ? ' on' : '') + '" role="option" data-i="' + i + '">' +
        '<span class="csl-ic csl-k-' + r.kind + '">' + iconHtml(r.icon) + '</span>' +
        '<span class="csl-main"><span class="csl-name">' + esc(r.name) + '</span>' +
        (r.desc ? '<span class="csl-desc">' + esc(r.desc) + '</span>' : '') + '</span>' +
        (r.hint ? '<span class="csl-hint">' + esc(r.hint) + '</span>' : '') + '</div>';
    }
    if (grouped) html += '<div class="csl-foot">↑↓ navigate · ↵ select · esc close · type to filter</div>';
    this.el.innerHTML = html;
    this.el.scrollTop = 0;
  };

  Slash.prototype.mark = function (scroll) {
    var items = this.el.querySelectorAll('.csl-item');
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('on', i === this.s.idx);
    if (scroll && items[this.s.idx]) items[this.s.idx].scrollIntoView({ block: 'nearest' });
  };

  Slash.prototype.move = function (d) {
    var n = this.s.rows.length;
    if (!n) return;
    this.s.idx = (this.s.idx + d + n) % n;
    this.mark(true);
  };

  // Anchor under the "/" (or above it when the room is up there), inside the
  // VISUAL viewport so a phone's soft keyboard never covers it.
  Slash.prototype.place = function () {
    var self = this, pos = this.s ? this.s.pos : -1;
    if (pos < 0) return;
    this.view.requestMeasure({
      key: 'cade-slash-place',
      read: function (v) {
        var el = self.el;
        if (!el || pos > v.state.doc.length) return null;
        return { c: v.coordsAtPos(pos), nat: el.scrollHeight, w: el.offsetWidth };
      },
      write: function (m) {
        var el = self.el;
        if (!el || !m) return;
        var c = m.c;
        if (!c) { el.style.visibility = 'hidden'; return; } // "/" scrolled out of view
        el.style.visibility = '';
        var vv = window.visualViewport;
        var vTop = vv ? vv.offsetTop : 0, vH = vv ? vv.height : window.innerHeight;
        var vLeft = vv ? vv.offsetLeft : 0, vW = vv ? vv.width : window.innerWidth;
        var below = vTop + vH - c.bottom - 10, above = c.top - vTop - 10;
        var down = below >= Math.min(m.nat, 200) || below >= above;
        var maxH = Math.max(90, Math.min(340, down ? below : above));
        var h = Math.min(m.nat, maxH);
        el.style.maxHeight = maxH + 'px';
        el.style.left = Math.max(vLeft + 8, Math.min(c.left - 12, vLeft + vW - m.w - 8)) + 'px';
        el.style.top = (down ? c.bottom + 4 : c.top - 4 - h) + 'px';
      },
    });
  };

  Slash.prototype.key = function (e) {
    if (!this.s || !this.el || !this.view.hasFocus) return;
    if (e.isComposing || e.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey) return;
    var k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') this.move(k === 'ArrowDown' ? 1 : -1);
    else if ((k === 'Enter' || k === 'Tab') && !e.shiftKey) this.choose(this.s.idx);
    else if (k === 'Escape') this.end();
    else return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  Slash.prototype.click = function (e) {
    var it = e.target && e.target.closest ? e.target.closest('.csl-item') : null;
    if (it) this.choose(parseInt(it.getAttribute('data-i'), 10));
  };

  Slash.prototype.hover = function (e) {
    var it = e.target && e.target.closest ? e.target.closest('.csl-item') : null;
    if (!it || !this.s) return;
    var i = parseInt(it.getAttribute('data-i'), 10);
    if (i !== this.s.idx) { this.s.idx = i; this.mark(false); }
  };

  Slash.prototype.choose = function (i) {
    var s = this.s, view = this.view;
    if (!s) return;
    var row = s.rows[i], from = s.pos, to = view.state.selection.main.head;
    this.end();
    if (!row || view.state.readOnly || to < from) return;
    try { run(view, row, from, to); } catch (err) { console.error('Slash command failed:', err); }
  };

  function run(view, row, from, to) {
    if (row.kind === 'symbol') {
      view.dispatch({ changes: { from: from, to: to, insert: row.sym }, selection: { anchor: from + row.sym.length }, userEvent: 'input', scrollIntoView: true });
      view.focus();
      return;
    }
    if (row.kind === 'widget' || row.kind === 'script') {
      // Clear "/query" first so a script sees the cleaned line, exactly like
      // running it from the palette (selection → current line → whole doc).
      view.dispatch({ changes: { from: from, to: to, insert: '' }, selection: { anchor: from }, userEvent: 'input' });
      if (!Cade.runCommand || !Cade.runCommand(row.name)) Cade.showToast('Command not found: ' + row.name, 'error', 2500);
      return;
    }
    var st = view.state, line = st.doc.lineAt(from);
    var c = {
      text: line.text.slice(0, from - line.from) + line.text.slice(to - line.from),
      col: from - line.from,
      prev: line.number > 1 ? st.doc.line(line.number - 1).text : '',
    };
    var r = row.act(c);
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: r.text },
      selection: { anchor: line.from + r.anchor, head: line.from + (r.head == null ? r.anchor : r.head) },
      userEvent: 'input', scrollIntoView: true,
    });
    view.focus();
  }

  var plugin = ViewPlugin.fromClass(Slash);

  // While a "/" session is live here, the core's "/code" dropdown stays out.
  if (Cade.claimSlash) Cade.claimSlash(function () { return !!(active && active.s); });

  Cade.registerPlugin({ id: 'slash', ext: plugin });
})();
