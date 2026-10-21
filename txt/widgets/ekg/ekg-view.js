/* Prose EKG — the editor side (an extension ekg.js registers as 'ekg-view'
 * while its panel is open, and removes on close).
 *
 *  · Margin strip: one absolutely-positioned layer inside view.scrollDOM (so
 *    it scrolls with the text) holding a bar per sentence, aligned with the
 *    sentence's first..last visual line, width ∝ word count, coloured by
 *    length class (short teal · medium green · long amber · run-on red;
 *    very complex = purple outline). Several sentences on one visual line
 *    share it in slices. Positions are read in a CodeMirror measure cycle
 *    (coordsAtPos); .cm-content gets right padding (editorAttributes) so bars
 *    never cover text. A tap on a bar selects its sentence.
 *  · Inline marks: run-on tails tinted amber → red, very complex sentences
 *    with a dotted purple underline, grammar issues wavy red, passive voice
 *    dotted blue, filler words faint grey — each with a title tooltip.
 *
 * Only the blocks around view.visibleRanges (± MARGIN chars) are analysed
 * (cached per paragraph by the core); a doc change maps the marks at once
 * and re-analyses after a short debounce, a scroll re-analyses only when it
 * leaves the covered range. A rebuild is pushed into the editor with a
 * `refresh` effect (also what the panel's category toggles dispatch).
 * The plugin does nothing at all unless host.isOpen() — a room's saved
 * editor state can still carry the extension after the panel closed; it
 * stays dormant there and wakes if the panel opens on that state again. */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var MARGIN = 2500, DEBOUNCE = 180, SCROLL_DEBOUNCE = 50, CAP_WORDS = 40;

  window.__cadeEkgView = function (host) {
    var CM = window.Cade.CM, Decoration = CM.Decoration, ViewPlugin = CM.ViewPlugin, EditorView = CM.EditorView;
    var core = host.core, refresh = CM.StateEffect.define();
    var tailDeco = [];
    for (var l = 1; l <= core.TAIL_LEVELS; l++) tailDeco[l] = Decoration.mark({ class: 'cm-ekg-tail cm-ekg-t' + l });
    var flashDeco = Decoration.mark({ class: 'cm-ekg-flash' });
    var markCache = new Map();
    function mark(cls, title) {
      var k = cls + '\u0000' + title, d = markCache.get(k);
      if (!d) {
        if (markCache.size > 800) markCache.clear();
        d = Decoration.mark({ class: cls, attributes: { title: title } });
        markCache.set(k, d);
      }
      return d;
    }
    var CLS = { s: 'short', m: 'medium', l: 'long', r: 'run-on' };
    function describe(s) {
      return s.words + ' words · ' + CLS[s.cls] + (s.complex ? ' · very complex (' + s.clauses + ' clauses, grade ' + s.grade + ')' : '');
    }

    function Ekg(view) {
      var self = this;
      this.view = view;
      this.deco = Decoration.none;
      this.sents = [];        // analysed sentences near the viewport: { from, to, cls, cx, words, … }
      this.cov = null;        // the doc range they cover
      this.blocks = null;     // block list of the current doc (null = stale)
      this.timer = 0;
      this.live = false;
      this.layer = null;
      this.bars = [];
      // a bar is a button-like target outside the content: keep CM's caret where it is
      this.onDown = function (e) { if (e.target.closest && e.target.closest('.cm-ekg-bar')) e.preventDefault(); };
      this.onClick = function (e) {
        var b = e.target.closest ? e.target.closest('.cm-ekg-bar') : null;
        if (!b) return;
        e.preventDefault(); e.stopPropagation();
        self.pick(+b.getAttribute('data-i'));
      };
      this.measureReq = { key: this, read: function (v) { return self.read(v); }, write: function (m) { self.write(m); } };
      if (host.isOpen()) this.start();
    }
    Ekg.prototype.start = function () {
      this.live = true;
      this.layer = document.createElement('div');
      this.layer.className = 'cm-ekg-strip';
      this.layer.setAttribute('aria-hidden', 'true');
      this.view.scrollDOM.appendChild(this.layer);
      this.layer.addEventListener('mousedown', this.onDown);
      this.layer.addEventListener('click', this.onClick);
      this.blocks = null;
      this.rebuild();
      this.measure();
    };
    Ekg.prototype.stop = function () {
      this.live = false;
      this.clearTimer();
      if (this.layer) {
        this.layer.removeEventListener('mousedown', this.onDown);
        this.layer.removeEventListener('click', this.onClick);
        this.layer.remove();
        this.layer = null;
      }
      this.bars = []; this.sents = []; this.cov = null; this.blocks = null; this.deco = Decoration.none;
    };
    Ekg.prototype.update = function (u) {
      // (a room's saved state can hold this plugin while the panel is closed: it stays
      // dormant, and wakes if the panel opens again on that state)
      if (!host.isOpen()) { if (this.live) this.stop(); return; }
      if (!this.live) { this.start(); return; }
      var forced = false, i, j;
      for (i = 0; i < u.transactions.length && !forced; i++) {
        var ef = u.transactions[i].effects;
        for (j = 0; j < ef.length; j++) if (ef[j].is(refresh)) { forced = true; break; }
      }
      if (u.docChanged) {
        var ch = u.changes;
        this.blocks = null;
        this.deco = this.deco.map(ch);
        for (i = 0; i < this.sents.length; i++) { var s = this.sents[i]; s.from = ch.mapPos(s.from, 1); s.to = Math.max(s.from, ch.mapPos(s.to, -1)); }
        if (this.cov) this.cov = { from: ch.mapPos(this.cov.from, -1), to: ch.mapPos(this.cov.to, 1) };
        var fl = host.flash;
        if (fl) host.flash = { from: ch.mapPos(fl.from, 1), to: ch.mapPos(fl.to, -1) };
      }
      if (forced) { this.clearTimer(); this.rebuild(); }
      else if (u.docChanged) this.schedule(DEBOUNCE);
      else if (u.viewportChanged && !this.covers()) this.schedule(SCROLL_DEBOUNCE);
      if (forced || u.docChanged || u.viewportChanged || u.geometryChanged) this.measure();
    };
    Ekg.prototype.clearTimer = function () { if (this.timer) { clearTimeout(this.timer); this.timer = 0; } };
    Ekg.prototype.schedule = function (ms) {
      var self = this;
      this.clearTimer();
      this.timer = setTimeout(function () {
        self.timer = 0;
        if (!self.live) return;
        try { self.view.dispatch({ effects: refresh.of(null) }); } catch (e) {}
      }, ms);
    };
    Ekg.prototype.covers = function () {
      var vr = this.view.visibleRanges, c = this.cov;
      if (!c || !vr.length) return !!c;
      return vr[0].from >= c.from && vr[vr.length - 1].to <= c.to;
    };
    Ekg.prototype.rebuild = function () {
      var view = this.view, doc = view.state.doc, cats = host.cats || {};
      if (!this.blocks) this.blocks = core.scanBlocks(doc);
      var vr = view.visibleRanges, vp = view.viewport;
      var from = Math.max(0, (vr.length ? vr[0].from : vp.from) - MARGIN), to = Math.min(doc.length, (vr.length ? vr[vr.length - 1].to : vp.to) + MARGIN);
      var bl = this.blocks, ranges = [], sents = [], i, k;
      for (i = core.firstBlockFrom(bl, from); i < bl.length && bl[i].from <= to; i++) {
        var b = bl[i], off = b.from, r = host.an.para(doc.sliceString(b.from, b.to));
        for (k = 0; k < r.sents.length; k++) {
          var s = r.sents[k];
          sents.push({ from: off + s.from, to: off + s.to, cls: s.cls, cx: s.complex, words: s.words, clauses: s.clauses, grade: s.grade });
          if (cats.tails && s.tail) for (var q = 0; q < s.tail.steps.length; q++) { var st = s.tail.steps[q]; if (st[1] > st[0]) ranges.push(tailDeco[st[2]].range(off + st[0], off + st[1])); }
          if (cats.complex && s.complex) ranges.push(mark('cm-ekg-cx', 'Very complex: ' + s.words + ' words, ' + s.clauses + ' clauses, grade ' + s.grade).range(off + s.from, off + s.to));
        }
        for (k = 0; k < r.issues.length; k++) {
          var is = r.issues[k];
          if (cats[is.cat] && is.to > is.from) ranges.push(mark('cm-ekg-' + is.cat, is.message).range(off + is.from, off + is.to));
        }
      }
      var fl = host.flash;                        // a range the panel just selected (seen on phones without focus)
      if (fl && fl.to > fl.from && fl.to <= doc.length) ranges.push(flashDeco.range(fl.from, fl.to));
      this.deco = ranges.length ? Decoration.set(ranges, true) : Decoration.none;
      this.sents = sents;
      this.cov = { from: from, to: to };
    };
    Ekg.prototype.measure = function () { if (this.live) this.view.requestMeasure(this.measureReq); };
    // (measure phase: layout reads only)
    Ekg.prototype.read = function (view) {
      if (!this.live || !(host.cats && host.cats.strip) || !this.sents.length) return null;
      var sd = view.scrollDOM, rect = sd.getBoundingClientRect(), cr = view.contentDOM.getBoundingClientRect();
      var top0 = rect.top + sd.clientTop - sd.scrollTop, left0 = rect.left + sd.clientLeft - sd.scrollLeft;
      var vp = view.viewport, rows = [];
      for (var i = 0; i < this.sents.length; i++) {
        var s = this.sents[i];
        if (s.to <= vp.from || s.from >= vp.to || s.to <= s.from) continue;
        var a = view.coordsAtPos(Math.max(s.from, vp.from), 1), b = view.coordsAtPos(Math.min(s.to, vp.to), -1);
        if (!a || !b) continue;
        rows.push({ i: i, at: a.top - top0, ab: a.bottom - top0, bt: b.top - top0, bb: b.bottom - top0 });
      }
      var pad = parseFloat(getComputedStyle(view.contentDOM).paddingRight) || 0;
      return { rows: rows, right: cr.right - left0, pad: pad, lh: view.defaultLineHeight || 20 };
    };
    // (write phase: DOM only)
    Ekg.prototype.write = function (m) {
      if (!this.live || !this.layer) return;
      var layer = this.layer, k;
      if (!m || !m.rows.length) { layer.style.display = 'none'; return; }
      layer.style.display = '';
      var W = Math.max(6, Math.min(24, m.pad - 4)), x = m.right - W - 2;
      // A visual line shared by consecutive sentences is sliced between them.
      var rows = m.rows, first = [], last = [], g = null;
      function grp(top, bottom) {
        var h = bottom - top, ex = Math.max(0, (m.lh - h) / 2);   // the glyph box → the whole line box
        return { top: top - ex, h: h + 2 * ex, n: 1 };
      }
      for (k = 0; k < rows.length; k++) {
        var r = rows[k];
        if (g && g.lastRow === k - 1 && Math.abs(g.ref - r.at) < 3) { first[k] = { g: g, i: g.n }; g.n++; }
        else { g = grp(r.at, r.ab); g.ref = r.at; first[k] = { g: g, i: 0 }; }
        if (Math.abs(r.bt - r.at) >= 3) { g = grp(r.bt, r.bb); g.ref = r.bt; last[k] = { g: g, i: 0 }; }
        else last[k] = first[k];
        g.lastRow = k;
      }
      for (k = 0; k < rows.length; k++) {
        var s = this.sents[rows[k].i], f = first[k], e = last[k];
        var top = f.g.top + f.g.h * f.i / f.g.n, bot = e.g.top + e.g.h * (e.i + 1) / e.g.n;
        if (bot - top > 5) { top += 1; bot -= 1; }
        var el = this.bars[k];
        if (!el) {
          el = this.bars[k] = document.createElement('div');
          el.appendChild(document.createElement('i'));
          layer.appendChild(el);
        }
        el.className = 'cm-ekg-bar cm-ekg-b' + s.cls + (s.cx ? ' cm-ekg-bcx' : '');
        el.style.cssText = 'top:' + top.toFixed(1) + 'px;height:' + Math.max(3, bot - top).toFixed(1) + 'px;left:' + x.toFixed(1) + 'px;width:' + W + 'px';
        el.firstChild.style.width = Math.max(3, Math.round(W * Math.min(1, s.words / CAP_WORDS))) + 'px';
        el.setAttribute('data-i', String(rows[k].i));
        el.setAttribute('data-from', String(s.from)); el.setAttribute('data-to', String(s.to));
        el.title = describe(s);
      }
      for (k = rows.length; k < this.bars.length; k++) this.bars[k].remove();
      this.bars.length = rows.length;
    };
    Ekg.prototype.pick = function (i) {
      var s = this.sents[i], view = this.view;
      if (!s) return;
      view.dispatch({ selection: { anchor: s.from, head: s.to }, userEvent: 'select.ekg' });
      if (host.onPick) { try { host.onPick(s); } catch (e) {} }
      if (!host.noFocus || !host.noFocus()) view.focus();
    };
    Ekg.prototype.destroy = function () { this.stop(); };

    var plugin = ViewPlugin.define(function (view) { return new Ekg(view); }, { decorations: function (v) { return v.deco; } });
    // While open: a class on the editor (the theme hooks) and, with the strip on, room for it.
    var attrs = EditorView.editorAttributes.of(function () {
      if (!host.isOpen()) return null;
      return { class: 'cm-ekg-on' + (host.cats && host.cats.strip ? ' cm-ekg-pad' : '') };
    });
    return { ext: [plugin, attrs], refresh: refresh, plugin: plugin };
  };
})();
