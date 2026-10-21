/* Bold-start reading — an editor plugin (off by default) that bolds the
 * first part of every word, so the eye can land on the word starts and skim
 * faster. Purely visual: mark decorations only, the text is never changed.
 *
 * WHAT IS BOLDED: words of letters (apostrophes inside are fine: don't,
 * l'eau) in the visible part of the note. Strength sets the share of each
 * word's letters: light ≈ 30 %, medium ≈ 45 %, strong ≈ 60 % (rounded, at
 * least one letter, and never the whole word unless it has one letter).
 * Skipped: ``` code blocks, `inline code`, headings (already bold), URLs and
 * e-mail addresses, a link's (url), file / image tokens (![file:…],
 * ![img:…], ![alt](src)), HTML tags, the app's %%tag|…%% / ==colour|…==
 * sentinel names, footnote refs, table separator rows, words mixed with
 * digits or underscores (identifiers), CJK text, and — while the editor has
 * focus and the pref is on — the line with the caret, so editing it isn't
 * disturbed.
 *
 * HOW: a ViewPlugin rebuilds the marks for view.visibleRanges right away
 * when the viewport, focus or caret line changes (cheap: a regex pass over
 * the visible lines), and maps them through edits, rebuilding 150 ms after
 * typing pauses. Bold is font-weight via a class — but only when the editor
 * font keeps its advance widths when bold (monospace fonts do; measured once
 * on a detached probe, again when web fonts arrive). Otherwise (a
 * proportional font, or WebKit widening a synthesised bold) it uses
 * -webkit-text-stroke, which thickens the glyphs without moving anything:
 * no reflow, no line-height change, no jank while scrolling on a phone.
 * Turning the plugin off destroys the ViewPlugin: marks, the prefs listener
 * and any pending timer all go.
 *
 * Prefs (Widget preferences → Bold-start reading): strength, caret line. */
(function (root) {
  'use strict';

  var STRENGTH = { light: 0.3, medium: 0.45, strong: 0.6 };
  var FIELDS = [
    { key: 'strength', type: 'radio', label: 'Fixation strength', default: 'medium',
      hint: 'How much of the start of each word is bold: light about a third, medium about half, strong about two thirds',
      options: [{ value: 'light', label: 'Light' }, { value: 'medium', label: 'Medium' }, { value: 'strong', label: 'Strong' }] },
    { key: 'skipCaret', type: 'toggle', label: 'Leave the line I’m editing plain', default: true,
      hint: 'While you type, the caret’s line shows no bold, so the text you are changing stays still' }
  ];
  var META = { id: 'boldread', settingKey: 'plugins.boldread' };

  // Letters to bold in a word of `len` letters.
  function boldLen(len, strength) {
    len = Math.max(0, len | 0);
    if (len <= 1) return len;
    var f = STRENGTH[strength] || STRENGTH.medium;
    return Math.max(1, Math.min(len - 1, Math.round(len * f)));
  }

  var SKIP_RES = [
    /(`+)[^\n]*?\1/g,                                     // inline code
    /!\[[^\]\n]*\](?:\([^)\n]*\))?/g,                     // file / image tokens, ![alt](src)
    /\]\([^)\s]*(?:\s+"[^"\n]*")?\)/g,                    // a link's (url)
    /(?:https?:\/\/|www\.|mailto:)[^\s<>()[\]]+/gi,       // bare URLs
    /[\w.+-]+@[\w-]+\.[\w.-]+/g,                          // e-mail addresses
    /<\/?[a-zA-Z][^>\n]*>/g,                              // HTML tags
    /%%[^|%\s]{1,32}(?:\||%%)/g,                          // %%tag| / %%center%% sentinels
    /==[a-zA-Z]{3,10}\|/g,                                // ==colour| highlight sentinels
    /\[\^[^\]\s]+\]/g                                     // footnote refs
  ];
  var RE_RUN = /[\p{L}\p{M}\p{N}_'’]+/gu;
  var RE_L = /\p{L}/u;
  var RE_BAD = /[\p{N}_]|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

  // Lines left alone entirely.
  function skipLine(text) {
    return !text || text.length > 3000 ||
      /^\s{0,3}#{1,6}\s/.test(text) ||                                   // headings
      /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(text) ||        // table separator row
      /^\s*(?:\[table(?::[^\]]*)?\]|@complete)\s*$/i.test(text);         // core table / macro markers
  }
  // [[from, to]] in the line that must not be touched.
  function skipRanges(text) {
    var out = [], m;
    for (var i = 0; i < SKIP_RES.length; i++) {
      var re = SKIP_RES[i];
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        if (!m[0].length) { re.lastIndex++; continue; }
        out.push([m.index, m.index + m[0].length]);
      }
    }
    return out;
  }
  // [[from, to]] of the bold parts of a line's words.
  function lineBold(text, strength) {
    if (skipLine(text)) return [];
    var skips = skipRanges(text), out = [], m;
    RE_RUN.lastIndex = 0;
    while ((m = RE_RUN.exec(text)) !== null) {
      var a = m.index, b = a + m[0].length, run = m[0];
      // trim quote marks at the ends ('word' -> word)
      while (a < b && (text.charAt(a) === "'" || text.charAt(a) === '’')) a++;
      while (b > a && (text.charAt(b - 1) === "'" || text.charAt(b - 1) === '’')) b--;
      if (a >= b) continue;
      run = text.slice(a, b);
      if (RE_BAD.test(run)) continue;
      var bad = false;
      for (var k = 0; k < skips.length; k++) if (a < skips[k][1] && b > skips[k][0]) { bad = true; break; }
      if (bad) continue;
      var letters = 0, i;
      for (i = 0; i < run.length; i++) if (RE_L.test(run.charAt(i))) letters++;
      var n = boldLen(letters, strength);
      if (!n) continue;
      // end after the n-th letter (and any combining marks that follow it)
      var seen = 0, end = 0;
      for (i = 0; i < run.length; i++) {
        if (RE_L.test(run.charAt(i))) { seen++; if (seen > n) break; }
        end = i + 1;
      }
      if (seen <= n) end = run.length; // ran out (one-letter words)
      out.push([a, a + end]);
    }
    return out;
  }

  var lib = { STRENGTH: STRENGTH, FIELDS: FIELDS, META: META, boldLen: boldLen, skipLine: skipLine, skipRanges: skipRanges, lineBold: lineBold };
  if (typeof module !== 'undefined' && module && module.exports) { module.exports = lib; return; }

  // ======================================================================
  // Editor plugin
  // ======================================================================
  var Cade = root && root.Cade;
  if (!Cade || !Cade.CM || !Cade.CM.ViewPlugin || !Cade.CM.Decoration) return;
  var CM = Cade.CM, Decoration = CM.Decoration;
  Cade.loadCSS('boldread.css');
  // The bold style rides on the mark itself (CodeMirror owns the editor
  // element's class attribute and rewrites it on focus changes).
  var MARK = { w: Decoration.mark({ class: 'cm-br cm-br-w' }), s: Decoration.mark({ class: 'cm-br cm-br-s' }) };
  var REFRESH = CM.StateEffect.define();
  var DEBOUNCE = 150;

  var fallbackPrefs = null;
  function prefsOf(id, fields) {
    if (Cade.prefs) return Cade.prefs(id);
    if (fallbackPrefs) return fallbackPrefs;
    var d = {}, ls = [];
    fields.forEach(function (f) { if (f.key) d[f.key] = f.default; });
    function all() { var o = {}; for (var k in d) o[k] = d[k]; return o; }
    fallbackPrefs = {
      get: function (k) { return d[k]; },
      all: all,
      set: function (k, v) { d[k] = v; ls.slice().forEach(function (fn) { try { fn(k, v, all()); } catch (e) {} }); },
      on: function (fn) { ls.push(fn); return function () { var i = ls.indexOf(fn); if (i >= 0) ls.splice(i, 1); }; }
    };
    return fallbackPrefs;
  }
  function inFence(pos) { try { return !!(Cade.inCodeFence && Cade.inCodeFence(pos)); } catch (e) { return false; } }

  // 'w' (font-weight) when bold doesn't change the editor font's advance
  // widths, else 's' (text stroke). Measured on a detached probe — never
  // inside contentDOM, which CodeMirror owns.
  function measureMode(view) {
    try {
      var cs = getComputedStyle(view.contentDOM);
      var p = document.createElement('span');
      p.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font-style:normal;font-weight:400';
      p.style.fontFamily = cs.fontFamily;
      p.style.fontSize = cs.fontSize;
      p.style.letterSpacing = cs.letterSpacing;
      p.textContent = 'The quick brown fox jumps over a lazy dog, quietly';
      document.body.appendChild(p);
      var w1 = p.getBoundingClientRect().width;
      p.style.fontWeight = '700';
      var w2 = p.getBoundingClientRect().width;
      p.remove();
      return w1 > 0 && Math.abs(w2 - w1) < 0.5 ? 'w' : 's';
    } catch (e) { return 's'; }
  }

  function BoldRead(view) {
    var self = this;
    this.view = view;
    this.dead = false;
    this.timer = 0;
    this.P = prefsOf('boldread', FIELDS);
    this.off = null;
    try { this.off = this.P.on(function () { self.kick(0); }); } catch (e) {}
    this.mode = measureMode(view);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        if (self.dead) return;
        var m = measureMode(view);
        if (m !== self.mode) { self.mode = m; self.kick(0); }
      });
    }
    this.caretKey = this.caretLine(view);
    this.decorations = this.build(view);
  }
  BoldRead.prototype.pref = function (k) {
    var v;
    try { v = this.P.get(k); } catch (e) {}
    if (k === 'strength') return STRENGTH[v] ? v : 'medium';
    return typeof v === 'boolean' ? v : true;
  };
  BoldRead.prototype.caretLine = function (view) {
    if (!this.pref('skipCaret') || !view.hasFocus) return -1;
    var st = view.state;
    return st.doc.lineAt(st.selection.main.head).number;
  };
  BoldRead.prototype.build = function (view) {
    var doc = view.state.doc, vr = view.visibleRanges, strength = this.pref('strength');
    var skip = this.caretKey, out = [], last = 0, mark = MARK[this.mode] || MARK.s;
    for (var r = 0; r < vr.length; r++) {
      var a = Math.max(doc.lineAt(vr[r].from).number, last + 1), b = doc.lineAt(vr[r].to).number;
      for (var i = a; i <= b; i++) {
        if (i === skip) continue;
        var line = doc.line(i);
        if (!line.length || inFence(line.from)) continue;
        var sp = lineBold(line.text, strength);
        for (var k = 0; k < sp.length; k++) out.push(mark.range(line.from + sp[k][0], line.from + sp[k][1]));
      }
      last = b;
    }
    return out.length ? Decoration.set(out, true) : Decoration.none;
  };
  // Rebuild after `ms` (0 = on the next tick) through a transaction, so the
  // view picks up the new decorations.
  BoldRead.prototype.kick = function (ms) {
    var self = this;
    clearTimeout(this.timer);
    this.timer = setTimeout(function () {
      self.timer = 0;
      if (self.dead) return;
      if (self.view.composing) { self.kick(DEBOUNCE); return; }
      try { self.view.dispatch({ effects: REFRESH.of(null) }); } catch (e) {}
    }, ms);
  };
  BoldRead.prototype.update = function (u) {
    var forced = false;
    for (var t = 0; t < u.transactions.length && !forced; t++) {
      var fx = u.transactions[t].effects;
      for (var e = 0; e < fx.length; e++) if (fx[e].is(REFRESH)) { forced = true; break; }
    }
    var key = this.caretLine(u.view);
    if (forced || u.viewportChanged || u.focusChanged || key !== this.caretKey) {
      clearTimeout(this.timer); this.timer = 0;
      this.caretKey = key;
      this.decorations = this.build(u.view);
      return;
    }
    if (u.docChanged) {
      this.decorations = this.decorations.map(u.changes);
      this.kick(DEBOUNCE);
    }
  };
  BoldRead.prototype.destroy = function () {
    this.dead = true;
    clearTimeout(this.timer); this.timer = 0;
    if (this.off) { try { this.off(); } catch (e) {} this.off = null; }
  };

  var plugin = CM.ViewPlugin.fromClass(BoldRead, { decorations: function (v) { return v.decorations; } });
  Cade.registerPlugin({ id: META.id, ext: plugin });
  root.__cadeBoldRead = { lib: lib, measureMode: measureMode }; // for browser checks
})(typeof window !== 'undefined' ? window : this);
