/* Callouts — Obsidian / GitHub-style callout boxes. A blockquote whose first
 * line is "> [!type] Optional title" (GitHub's "> [!NOTE]" too) renders as a
 * box: coloured left bar + tint on every line, and an icon + title header. The
 * "> " and "[!type]" markers hide unless the caret is on that line (the same
 * CSS .cm-activeLine trick the core uses for **emphasis** markers), so the
 * source stays plain editable text. Types: note, abstract/summary/tldr, info,
 * todo, tip/hint, important, success/check/done, question/help/faq,
 * warning/caution/attention, failure/fail/missing, danger/error, bug, example,
 * quote/cite; unknown types render as note.
 *
 * Folding: "> [!tip]-" starts collapsed, "> [!tip]+" expanded, and only those
 * get a chevron. Fold state is VIEW-LOCAL — the marker in the text is the
 * default, a click overrides it for this session — rather than rewriting the
 * "-"/"+" in the doc: a click is a viewing action, so it must not create an
 * edit (no sync push / conflict with other devices, no undo entry) and it has
 * to work in read-only and locked rooms. Editing the marker resets the
 * override, so the text stays the source of truth. Hidden lines get a
 * display:none line class like the core's heading folds (block replaces can't
 * come from a plugin and this bundle exports no StateField); a caret that
 * lands inside a folded body (arrows, search, go-to) unfolds it.
 *
 * Respects Settings → Markdown styling: when it's off, raw text and no folds.
 * Viewport-only, rebuilt on doc / viewport / setting / fold changes; selection
 * moves only check whether the caret entered a fold. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var CM = Cade.CM;
  if (!CM || !CM.ViewPlugin || !CM.Decoration || !CM.WidgetType) return;
  Cade.loadCSS('callouts.css');

  var ViewPlugin = CM.ViewPlugin, Decoration = CM.Decoration, WidgetType = CM.WidgetType;

  // "> [!type]± title" — 1 type, 2 fold marker, 3 gap, 4 title.
  var HEAD_RE = /^>[ \t]*\[!([A-Za-z][\w-]*)\]([+-]?)([ \t]*)(.*)$/;
  var LOOKBACK = 1000;   // lines scanned up for the header of a body line
  var MAX_BLOCK = 5000;  // longest callout handled
  var GT = 62;           // '>'

  var CANON = {
    note: 'note', abstract: 'abstract', summary: 'abstract', tldr: 'abstract',
    info: 'info', todo: 'todo', tip: 'tip', hint: 'tip', important: 'important',
    success: 'success', check: 'success', done: 'success',
    question: 'question', help: 'question', faq: 'question',
    warning: 'warning', caution: 'warning', attention: 'warning',
    failure: 'failure', fail: 'failure', missing: 'failure',
    danger: 'danger', error: 'danger', bug: 'bug', example: 'example',
    quote: 'quote', cite: 'quote',
  };
  var LABEL = { tldr: 'TL;DR', faq: 'FAQ' };

  // Lucide-style 24px stroke icons (currentColor = the callout colour).
  var P = {
    note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    abstract: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4M12 16h4M8 11h.01M8 16h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    todo: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    tip: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    important: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v4M12 15h.01"/>',
    success: '<path d="M20 6 9 17l-5-5"/>',
    question: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
    warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
    failure: '<path d="M18 6 6 18M6 6l12 12"/>',
    danger: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    bug: '<path d="m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
    example: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    quote: '<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.76-2.02-2-2H4c-1.25 0-2 .75-2 1.97V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .01-1 1.03V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.76-2.02-2-2h-4c-1.25 0-2 .75-2 1.97V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
  };
  function svg(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P[name] + '</svg>';
  }
  function label(raw) {
    var k = raw.toLowerCase();
    return LABEL[k] || (raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase());
  }
  function inFence(pos) { try { return !!(Cade.inCodeFence && Cade.inCodeFence(pos)); } catch (e) { return false; } }
  function mdOn() {
    try { var v = Cade.Settings && Cade.Settings.get('editor.markdownStyling'); return v !== false; } catch (e) { return true; }
  }

  // ---- block structure ------------------------------------------------------------
  function isQuote(t) { return t.charCodeAt(0) === GT; }
  // Header line number for the quote line `ln`, or 0 if it's a plain quote.
  function findHeader(doc, ln) {
    for (var j = ln; j >= 1 && ln - j <= LOOKBACK; j--) {
      var t = doc.line(j).text;
      if (!isQuote(t)) return 0;
      if (HEAD_RE.test(t)) return j;
    }
    return 0;
  }
  // Last line of the callout headed at `h` (a new header starts a new one).
  function blockEnd(doc, h) {
    var j = h;
    while (j < doc.lines && j - h < MAX_BLOCK) {
      var t = doc.line(j + 1).text;
      if (!isQuote(t) || HEAD_RE.test(t)) break;
      j++;
    }
    return j;
  }

  // ---- widgets -----------------------------------------------------------------------
  // ES5 subclasses of CM's WidgetType (its constructor is empty, so it's safe
  // not to call it; compare() uses constructor + eq()).
  function Head(t, text, foldable, folded) { this.t = t; this.text = text; this.foldable = foldable; this.folded = folded; }
  Head.prototype = Object.create(WidgetType.prototype);
  Head.prototype.constructor = Head;
  Head.prototype.eq = function (o) { return o.t === this.t && o.text === this.text && o.foldable === this.foldable && o.folded === this.folded; };
  Head.prototype.toDOM = function (view) {
    var s = document.createElement('span');
    s.className = 'cm-co-hw';
    var html = '';
    if (this.foldable) {
      html += '<span class="cm-co-chev' + (this.folded ? ' cm-co-chev-closed' : '') + '" role="button" title="' +
        (this.folded ? 'Expand' : 'Collapse') + '">' + svg('chev') + '</span>';
    }
    html += '<span class="cm-co-ic">' + svg(this.t) + '</span>';
    // Untitled callouts show their type name; hidden on the active line,
    // where the raw "[!type]" is revealed instead.
    if (this.text) html += '<span class="cm-co-autolabel">' + Cade.escapeHtml(this.text) + '</span>';
    s.innerHTML = html;
    if (this.foldable) {
      s.firstChild.addEventListener('mousedown', function (e) {
        e.preventDefault(); e.stopPropagation(); // no caret move / focus steal
        toggle(view, s);
      });
    }
    return s;
  };
  Head.prototype.ignoreEvent = function () { return false; }; // icon/label clicks place the caret

  function Pill(n) { this.n = n; }
  Pill.prototype = Object.create(WidgetType.prototype);
  Pill.prototype.constructor = Pill;
  Pill.prototype.eq = function (o) { return o.n === this.n; };
  Pill.prototype.toDOM = function (view) {
    var s = document.createElement('span');
    s.className = 'cm-co-pill';
    s.textContent = '\u2026 ' + this.n + ' line' + (this.n === 1 ? '' : 's');
    s.title = 'Expand';
    s.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); toggle(view, s); });
    return s;
  };
  Pill.prototype.ignoreEvent = function () { return true; };

  function toggle(view, dom) {
    var p = view.plugin(plugin);
    if (!p) return;
    var pos;
    try { pos = view.posAtDOM(dom); } catch (e) { return; }
    var st = view.state, line = st.doc.lineAt(pos), m = HEAD_RE.exec(line.text);
    if (!m) return;
    var folded = p.isFolded(line.from, m[2]);
    p.setFold(line.from, m[2], !folded);
    p.dirty = true;
    var spec = {};
    if (!folded) {
      // Folding with the caret inside the body: park it on the header so the
      // fold isn't immediately re-opened by the caret check.
      var e = blockEnd(st.doc, line.number), head = st.selection.main.head;
      if (head > line.to && head <= st.doc.line(e).to) spec.selection = { anchor: line.to };
    }
    view.dispatch(spec);
  }

  // ---- decorations ------------------------------------------------------------------
  var MARK_GT = Decoration.mark({ class: 'cm-co-gt' });
  var MARK_GT_BLANK = Decoration.mark({ class: 'cm-co-gtb' });
  var MARK_MK = Decoration.mark({ class: 'cm-co-mk' });
  var MARK_TITLE = Decoration.mark({ class: 'cm-co-title' });
  var HIDDEN = Decoration.line({ class: 'cm-co-hidden' });
  var lineDecos = {};
  function lineDeco(cls) { return lineDecos[cls] || (lineDecos[cls] = Decoration.line({ class: cls })); }

  function Callouts(view) {
    this.md = mdOn();
    this.folds = [];   // view-local overrides { pos (header line start), mk, folded }
    this.hidden = [];  // folded bodies from the last build { pos, mk, from, to }
    this.dirty = false;
    this.decorations = this.build(view);
  }

  Callouts.prototype.isFolded = function (pos, mk) {
    for (var i = 0; i < this.folds.length; i++) {
      var f = this.folds[i];
      if (f.pos === pos) return f.mk === mk ? f.folded : mk === '-';
    }
    return mk === '-';
  };
  Callouts.prototype.setFold = function (pos, mk, folded) {
    this.folds = this.folds.filter(function (f) { return f.pos !== pos; });
    this.folds.push({ pos: pos, mk: mk, folded: folded });
    if (this.folds.length > 200) this.folds.shift();
  };

  Callouts.prototype.update = function (u) {
    var rebuild = this.dirty || u.viewportChanged;
    var md = mdOn();
    if (md !== this.md) { this.md = md; rebuild = true; }
    if (u.docChanged) {
      var ch = u.changes;
      this.folds.forEach(function (f) { f.pos = ch.mapPos(f.pos, 1); });
      rebuild = true;
    }
    this.dirty = false;
    if (rebuild) this.decorations = this.build(u.view);
    if ((rebuild || u.selectionSet) && this.hidden.length && this.unfoldAtCaret(u.state)) {
      this.decorations = this.build(u.view);
    }
  };

  // Never leave a caret (or selection end) inside hidden lines.
  Callouts.prototype.unfoldAtCaret = function (st) {
    var rs = st.selection.ranges, hit = false;
    for (var i = 0; i < this.hidden.length; i++) {
      var hd = this.hidden[i];
      for (var j = 0; j < rs.length; j++) {
        var a = rs[j].anchor, b = rs[j].head;
        if ((b >= hd.from && b <= hd.to) || (a >= hd.from && a <= hd.to)) { this.setFold(hd.pos, hd.mk, false); hit = true; break; }
      }
    }
    return hit;
  };

  Callouts.prototype.build = function (view) {
    this.hidden = [];
    if (!this.md) return Decoration.none;
    var doc = view.state.doc, out = [], done = 0, vr = view.visibleRanges;
    for (var r = 0; r < vr.length; r++) {
      var ln = Math.max(doc.lineAt(vr[r].from).number, done + 1);
      var last = doc.lineAt(vr[r].to).number;
      while (ln <= last) {
        var line = doc.line(ln);
        if (!isQuote(line.text) || line.length > 2000 || inFence(line.from)) { ln++; continue; }
        var h = findHeader(doc, ln);
        if (!h) {
          // A plain quote: skip to its end (or to a header that starts inside it).
          while (ln < doc.lines) {
            var nt = doc.line(ln + 1).text;
            if (!isQuote(nt) || HEAD_RE.test(nt)) break;
            ln++;
          }
          done = ln; ln++;
          continue;
        }
        var e = blockEnd(doc, h);
        this.decorate(doc, h, e, ln, last, out);
        done = e; ln = e + 1;
      }
    }
    return Decoration.set(out, true);
  };

  Callouts.prototype.decorate = function (doc, h, e, visFrom, visTo, out) {
    var hl = doc.line(h), m = HEAD_RE.exec(hl.text);
    var raw = m[1], t = CANON[raw.toLowerCase()] || 'note', mk = m[2], title = m[4];
    var foldable = mk === '+' || mk === '-';
    var folded = foldable && e > h && this.isFolded(hl.from, mk);
    var base = 'cm-co cm-co-t-' + t;
    var bracket = hl.text.indexOf('[');
    var mkEnd = hl.text.length - title.length;

    out.push(lineDeco(base + ' cm-co-head' + (e === h || folded ? ' cm-co-end' : '') + (folded ? ' cm-co-folded' : '')).range(hl.from));
    out.push(Decoration.widget({ widget: new Head(t, title.trim() ? '' : label(raw), foldable, folded), side: -1 }).range(hl.from));
    out.push(MARK_GT.range(hl.from, hl.from + bracket));
    out.push(MARK_MK.range(hl.from + bracket, hl.from + mkEnd));
    if (title.length) out.push(MARK_TITLE.range(hl.from + mkEnd, hl.to));

    if (folded) {
      out.push(Decoration.widget({ widget: new Pill(e - h), side: 1 }).range(hl.to));
      for (var i = h + 1; i <= e; i++) out.push(HIDDEN.range(doc.line(i).from));
      this.hidden.push({ pos: hl.from, mk: mk, from: doc.line(h + 1).from, to: doc.line(e).to });
      return;
    }
    // Body: only the lines in view get styled.
    var a = Math.max(h + 1, visFrom), b = Math.min(e, visTo);
    for (var k = a; k <= b; k++) {
      var l = doc.line(k);
      out.push(lineDeco(base + ' cm-co-body' + (k === e ? ' cm-co-end' : '')).range(l.from));
      var g = /^>[ \t]?/.exec(l.text)[0].length;
      // An empty ">" paragraph line would collapse to zero height if its only
      // text were display:none'd — make that marker invisible instead.
      if (l.length <= 2000) out.push((/\S/.test(l.text.slice(g)) ? MARK_GT : MARK_GT_BLANK).range(l.from, l.from + g));
    }
  };

  var plugin = ViewPlugin.fromClass(Callouts, { decorations: function (v) { return v.decorations; } });

  Cade.registerPlugin({ id: 'callouts', ext: plugin });
})();
