/* ASCII Postcard view — renders each ```postcard block (see postcard-core.js
 * for the format) as its coloured card while the caret is elsewhere; put the
 * caret in it (click the card, ✎, or arrow into it) and the raw text is back
 * for editing, set small and tight (1 character = 1 cell) so the art lines up.
 * A bar under the card: caption · size, and ✎ edit / ⧉ copy the plain art /
 * ⤓ download it as a PNG picture / 🗑 delete (tap twice). Read-only notes render too; delete is refused.
 *
 * Cheap by design: a StateField (block widgets can't come from a ViewPlugin)
 * that keeps the postcard blocks of the doc. One line scan on load; after
 * that, while the note has no "```postcard" line at all, an edit only looks at
 * the lines it touched; with postcards, an edit that touches a ``` line
 * rescans, any other edit maps the blocks and re-hashes only the one it hit.
 * A caret move only re-checks which blocks hold a selection end. Widgets are
 * equal by content hash, so CM keeps their DOM; canvases are drawn when they
 * first scroll near the viewport (IntersectionObserver) from a small LRU of
 * rendered cards (by hash × width; device pixel ratio capped at 2, width at
 * 1400 px). postcard-core.js loads only when a card is first drawn.
 * The block finder is pure and exported for node tests. */
(function () {
  'use strict';

  var OPEN_RE = /^```postcard(?:[ \t]|$)/;
  var MAX_SPAN = 3000; // a change spanning more lines than this just rescans
  var COLOR_RE = /^~ ?[A-Za-z0-9+/=_-]{4,}\s*$/;
  function isFence(t) { return t.charCodeAt(0) === 96 && t.lastIndexOf('```', 0) === 0; }
  function hash(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h.toString(36) + s.length.toString(36);
  }
  // What the bar and the placeholder need, without the core: size, paper, caption.
  function head(t) {
    var info = ' ' + t.slice(11).replace(/"[^"]*"?/g, ' ') + ' ';
    var d = /\s(\d{1,3})x(\d{1,3})(?=\s)/i.exec(info), bg = /\s(dark|light|paper)(?=\s)/i.exec(info);
    var st = /\s(classic|dense|blocks|braille|edges|text)(?=\s)/i.exec(info), cap = /"([^"]*)"/.exec(t);
    return { cols: d ? +d[1] : 0, rows: d ? +d[2] : 0, bg: bg ? bg[1].toLowerCase() : 'dark', style: st ? st[1].toLowerCase() : '', cap: cap ? cap[1] : '' };
  }
  function mkBlock(doc, from, to) {
    var t = doc.lineAt(from).text, b = head(t), text = doc.sliceString(from, to);
    b.from = from; b.to = to; b.text = text; b.h = hash(text);
    b.ok = b.cols >= 1 && b.rows >= 1 && b.cols <= 400 && b.rows <= 400;
    return b;
  }
  // Whole doc: n = lines starting with ```postcard (paired or not); blocks =
  // closed postcard fences (the core's rule: any line starting with ``` opens
  // or closes a fence).
  function scan(doc) {
    var blocks = [], n = 0, open = -1, pc = false, pos = 0;
    for (var it = doc.iterLines(); !it.next().done;) {
      var t = it.value, from = pos;
      pos += t.length + 1;
      if (t.charCodeAt(0) !== 96 || !isFence(t)) continue;
      var isPc = OPEN_RE.test(t);
      if (isPc) n++;
      if (open < 0) { open = from; pc = isPc; }
      else { if (pc) blocks.push(mkBlock(doc, open, from + t.length)); open = -1; }
    }
    return { n: n, blocks: blocks };
  }
  // Which blocks hold a selection end ("1") → shown raw.
  function openKey(sel, blocks) {
    var k = '';
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i], on = false;
      for (var j = 0; j < sel.ranges.length && !on; j++) {
        var r = sel.ranges[j];
        on = (r.head >= b.from && r.head <= b.to) || (r.anchor >= b.from && r.anchor <= b.to);
      }
      k += on ? '1' : '0';
    }
    return k;
  }
  // The card's canvas height for a pixel width (postcard-core layout(): one
  // cell of margin all round, cells twice as tall as wide).
  function cardHeight(cols, rows, W) { return Math.round(W / (cols + 2) * (rows * 2 + 2)); }
  // The plain art of a block's text: between the fences, minus the colour line.
  function plainArt(text) {
    var ls = String(text).split('\n').slice(1);
    if (ls.length && isFence(ls[ls.length - 1])) ls.pop();
    if (ls.length > 1 && COLOR_RE.test(ls[ls.length - 1])) ls.pop();
    return ls.join('\n');
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { scan: scan, openKey: openKey, head: head, cardHeight: cardHeight, plainArt: plainArt, hash: hash, OPEN_RE: OPEN_RE };
    return;
  }
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade, CM = Cade.CM;
  if (!CM || !CM.StateField || !CM.Decoration || !CM.WidgetType || !CM.EditorView) return;
  Cade.loadCSS('postcard-view.css');
  var StateField = CM.StateField, Decoration = CM.Decoration, WidgetType = CM.WidgetType, EditorView = CM.EditorView;
  var CORE_URL = Cade.asset('postcard-core.js');

  function loadCore() {
    if (window.__cadePostcard) return Promise.resolve(window.__cadePostcard);
    if (!window.__cadePostcardP) {
      window.__cadePostcardP = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = CORE_URL;
        s.onload = function () { if (window.__cadePostcard) res(window.__cadePostcard); else { window.__cadePostcardP = null; rej(new Error('postcard core missing')); } };
        s.onerror = function () { window.__cadePostcardP = null; rej(new Error('postcard core failed to load')); };
        document.head.appendChild(s);
      });
    }
    return window.__cadePostcardP;
  }
  function toast(m, t) { try { Cade.showToast(m, t || 'info', 1800); } catch (e) {} }
  function copyText(s) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s);
    return new Promise(function (res, rej) {
      var ta = document.createElement('textarea');
      ta.value = s; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      if (ok) res(); else rej(new Error('copy failed'));
    });
  }

  // ---- PNG export (one at a time; the last one is kept for a quick second tap) ----
  // (when it's ready by the click, it is saved inside the tap itself — Safari wants that)
  var lastPng = { h: '', p: null, r: null };
  function pngOf(b) {
    if (lastPng.h === b.h && lastPng.p) return lastPng.p;
    var p = loadCore().then(function (PC) {
      var card = PC.parseBlock(b.text);
      return PC.toPng(card).then(function (blob) { return { PC: PC, card: card, blob: blob }; });
    });
    var slot = lastPng = { h: b.h, p: p, r: null };
    p.then(function (r) { slot.r = r; }, function () { if (lastPng === slot) lastPng = { h: '', p: null, r: null }; });
    return p;
  }
  function savePng(r) {
    r.PC.download(r.blob, r.PC.pngName(r.card.caption));
    toast('Postcard saved as a PNG', 'success');
  }

  // ---- canvases ------------------------------------------------------------------
  var cards = new Map(), masters = new Map(), masterPx = 0, MASTER_BUDGET = 8e6;
  function cardOf(PC, b) {
    var c = cards.get(b.h);
    if (c) { cards.delete(b.h); cards.set(b.h, c); return c; }
    c = PC.parseBlock(b.text);
    cards.set(b.h, c);
    if (cards.size > 32) cards.delete(cards.keys().next().value);
    return c;
  }
  function masterOf(PC, card, key, W) {
    var m = masters.get(key);
    if (m) { masters.delete(key); masters.set(key, m); return m; }
    m = document.createElement('canvas');
    PC.render(m, card, { width: W, font: PC.monoFont() });
    masters.set(key, m); masterPx += m.width * m.height;
    while (masterPx > MASTER_BUDGET && masters.size > 1) {
      var k0 = masters.keys().next().value, old = masters.get(k0);
      masters.delete(k0); masterPx -= old.width * old.height; old.width = old.height = 0;
    }
    return m;
  }
  var io = null;
  function watch(el) {
    if (typeof IntersectionObserver !== 'function') { paint(el); return; }
    if (!io) io = new IntersectionObserver(function (es) {
      for (var i = 0; i < es.length; i++) if (es[i].isIntersecting) { io.unobserve(es[i].target); paint(es[i].target); }
    }, { rootMargin: '400px 0px' });
    io.observe(el);
  }
  function paint(el) {
    var w = el.__pc;
    if (!w || w.painted) return;
    w.painted = true;
    loadCore().then(function (PC) {
      return PC.fontReady(PC.monoFont()).then(function () { return PC; });
    }).then(function (PC) {
      var card = cardOf(PC, w.b), cv = el.querySelector('canvas');
      if (!card || !cv) { el.classList.add('cm-pc-bad'); return; }
      if (card.cols !== w.b.cols || card.rows !== w.b.rows) { el.classList.add('cm-pc-bad'); return; }
      var m = masterOf(PC, card, w.b.h + '|' + cv.width, cv.width);
      var ctx = cv.getContext('2d');
      ctx.drawImage(m, 0, 0);
      el.classList.add('cm-pc-ready');
      if (card.colorError) el.classList.add('cm-pc-mono');
    }, function () { w.painted = false; el.classList.add('cm-pc-bad'); });
  }

  // ---- the widget ------------------------------------------------------------------
  var contentW = 0;
  function widthFor(view) {
    if (!contentW) { try { contentW = view.contentDOM.clientWidth - 8; } catch (e) {} }
    return contentW > 120 ? contentW : 600;
  }
  window.addEventListener('resize', function () { contentW = 0; });
  var ICON = {
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
    del: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    png: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 17v3h16v-3"/></svg>',
  };

  function Card(b) { this.b = b; this.h = b.h; }
  Card.prototype = Object.create(WidgetType.prototype);
  Card.prototype.constructor = Card;
  Card.prototype.eq = function (o) { return o.h === this.h; };
  Object.defineProperty(Card.prototype, 'estimatedHeight', {
    get: function () { var css = Math.min(contentW || 600, this.b.cols * 9 + 18); return cardHeight(this.b.cols, this.b.rows, css) + 50; },
  });
  Card.prototype.toDOM = function (view) {
    var b = this.b, cssW = Math.min(widthFor(view), b.cols * 9 + 18);
    var dpr = Math.min(2, window.devicePixelRatio || 1), W = Math.min(1400, Math.round(cssW * dpr));
    var wrap = document.createElement('div');
    wrap.className = 'cm-pc cm-pc-' + b.bg + (cssW < 380 ? ' cm-pc-narrow' : '');
    wrap.setAttribute('contenteditable', 'false');
    wrap.style.setProperty('--pc-w', cssW + 'px');
    var cap = b.cap || 'ASCII postcard';
    wrap.innerHTML = '<div class="cm-pc-box"><div class="cm-pc-card" title="Edit the text"><canvas width="' + W + '" height="' + cardHeight(b.cols, b.rows, W) + '"></canvas></div>' +
      '<div class="cm-pc-bar"><span class="cm-pc-cap"></span><span class="cm-pc-meta"></span><span class="cm-pc-acts">' +
      '<button type="button" tabindex="-1" data-act="edit" title="Edit the text" aria-label="Edit">' + ICON.edit + '</button>' +
      '<button type="button" tabindex="-1" data-act="copy" title="Copy the art as plain text" aria-label="Copy">' + ICON.copy + '</button>' +
      '<button type="button" tabindex="-1" data-act="png" title="Download as a PNG picture" aria-label="Download PNG">' + ICON.png + '</button>' +
      '<button type="button" tabindex="-1" data-act="del" title="Delete this postcard" aria-label="Delete">' + ICON.del + '</button></span></div></div>';
    wrap.querySelector('.cm-pc-card').setAttribute('aria-label', 'ASCII postcard: ' + cap);
    wrap.querySelector('.cm-pc-cap').textContent = b.cap;
    wrap.querySelector('.cm-pc-meta').textContent = b.cols + '×' + b.rows + (b.style ? ' · ' + b.style : '');
    wrap.__pc = { b: b, view: view, painted: false };
    var armed = 0;
    wrap.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus / no caret drag
    // start building the picture on press, so the click can save it at once
    wrap.addEventListener('pointerdown', function (e) { if (e.target.closest && e.target.closest('[data-act="png"]')) pngOf(wrap.__pc.b); });
    wrap.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var btn = e.target.closest ? e.target.closest('[data-act]') : null, act = btn ? btn.getAttribute('data-act') : 'edit';
      var v = wrap.__pc.view, from;
      try { from = v.posAtDOM(wrap); } catch (x) { return; }
      var st = v.state, doc = st.doc;
      if (from < 0 || from > doc.length) return;
      var L = doc.lineAt(from);
      if (!OPEN_RE.test(L.text)) return;
      var blk = null, fields = st.field(field, false);
      if (fields) for (var i = 0; i < fields.blocks.length; i++) if (fields.blocks[i].from === L.from) blk = fields.blocks[i];
      if (!blk) return;
      if (act === 'edit') {
        var at = Math.min(doc.length, L.to + 1);
        v.dispatch({ selection: { anchor: at }, scrollIntoView: true, userEvent: 'select' });
        v.focus();
      } else if (act === 'png') {
        if (lastPng.h === blk.h && lastPng.r) { savePng(lastPng.r); return; }
        btn.classList.add('cm-pc-busy');
        pngOf(blk).then(function (r) { btn.classList.remove('cm-pc-busy'); savePng(r); },
          function () { btn.classList.remove('cm-pc-busy'); toast('Couldn\u2019t make the picture', 'error'); });
      } else if (act === 'copy') {
        copyText(plainArt(blk.text)).then(function () { toast('Postcard copied as text', 'success'); }, function () { toast('Copy failed', 'error'); });
      } else if (act === 'del') {
        if (st.readOnly) { toast('Read-only mode — editing is locked', 'error'); return; }
        if (!armed) {
          armed = setTimeout(function () { armed = 0; btn.classList.remove('cm-pc-armed'); btn.title = 'Delete this postcard'; }, 3000);
          btn.classList.add('cm-pc-armed'); btn.title = 'Tap again to delete';
          return;
        }
        clearTimeout(armed); armed = 0;
        var to = blk.to < doc.length && doc.sliceString(blk.to, blk.to + 1) === '\n' ? blk.to + 1 : blk.to;
        v.dispatch({ changes: { from: blk.from, to: to }, userEvent: 'delete' });
        toast('Postcard deleted — undo brings it back', 'info');
      }
    });
    watch(wrap);
    return wrap;
  };
  Card.prototype.updateDOM = function () { return false; };
  Card.prototype.ignoreEvent = function () { return true; };
  Card.prototype.destroy = function (dom) { if (io) try { io.unobserve(dom); } catch (e) {} };

  // ---- state field ---------------------------------------------------------------
  // Lines an edit touched (old and new text) — any of them a ``` line?
  function fenceTouched(tr) {
    var hit = false, od = tr.startState.doc, nd = tr.state.doc;
    tr.changes.iterChanges(function (fa, ta, fb, tb) {
      if (hit) return;
      var i, a = od.lineAt(fa).number, b = od.lineAt(ta).number;
      if (b - a > MAX_SPAN) { hit = true; return; }
      for (i = a; i <= b && !hit; i++) if (isFence(od.line(i).text)) hit = true;
      a = nd.lineAt(fb).number; b = nd.lineAt(tb).number;
      if (b - a > MAX_SPAN) { hit = true; return; }
      for (i = a; i <= b && !hit; i++) if (isFence(nd.line(i).text)) hit = true;
    });
    return hit;
  }
  // A note without postcards: did this edit write a ```postcard line?
  function postcardTyped(tr) {
    var hit = false, nd = tr.state.doc;
    tr.changes.iterChanges(function (fa, ta, fb, tb) {
      if (hit) return;
      var a = nd.lineAt(fb).number, b = nd.lineAt(tb).number;
      if (b - a > MAX_SPAN) { hit = true; return; }
      for (var i = a; i <= b && !hit; i++) { var t = nd.line(i).text; if (t.charCodeAt(0) === 96 && OPEN_RE.test(t)) hit = true; }
    });
    return hit;
  }
  // No fence line changed: blocks keep their pairing; map them, re-read the one an edit hit.
  function remap(tr, blocks) {
    var ch = tr.changes, nd = tr.state.doc, out = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i], from = ch.mapPos(b.from, 1), to = ch.mapPos(b.to, -1);
      if (ch.touchesRange(b.from, b.to)) { out.push(mkBlock(nd, from, to)); continue; }
      if (from === b.from && to === b.to) { out.push(b); continue; }
      var c = {}; for (var k in b) c[k] = b[k];
      c.from = from; c.to = to;
      out.push(c);
    }
    return out;
  }
  var RAWC = Decoration.line({ class: 'cm-pc-rawc' }), rawDeco = {};
  function rawLine(cols) { return rawDeco[cols] || (rawDeco[cols] = Decoration.line({ class: 'cm-pc-raw', attributes: { style: '--pc-cols:' + cols } })); }
  function build(doc, blocks, key) {
    var out = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b.ok) continue;
      if (key.charAt(i) === '0') { out.push(Decoration.replace({ widget: new Card(b), block: true }).range(b.from, b.to)); continue; }
      // raw: one character per cell, so the art reads while it's edited
      var a = doc.lineAt(b.from).number + 1, z = doc.lineAt(b.to).number - 1, deco = rawLine(b.cols);
      for (var l = a; l <= z; l++) {
        var line = doc.line(l);
        out.push((l === z && l - a >= 1 && COLOR_RE.test(line.text.slice(0, 64)) ? RAWC : deco).range(line.from));
      }
    }
    return out.length ? Decoration.set(out) : Decoration.none;
  }
  function compute(v, st, tr) {
    var sc;
    if (!v) sc = scan(st.doc);
    else if (tr.docChanged) {
      if (!v.n) { if (!postcardTyped(tr)) return v; sc = scan(st.doc); }  // the common case: no postcards
      else if (fenceTouched(tr)) sc = scan(st.doc);
      else sc = { n: v.n, blocks: v.blocks.length ? remap(tr, v.blocks) : v.blocks };
    } else if (tr.selection && v.blocks.length) sc = v;
    else return v;
    if (!sc.blocks.length) return v && !v.blocks.length && v.n === sc.n ? v : { n: sc.n, blocks: sc.blocks, key: '', deco: Decoration.none };
    var key = openKey(st.selection, sc.blocks);
    if (v && sc === v && key === v.key) return v;          // the caret moved; nothing opened or closed
    return { n: sc.n, blocks: sc.blocks, key: key, deco: build(st.doc, sc.blocks, key) };
  }
  var field = StateField.define({
    create: function (st) { return compute(null, st, null); },
    update: function (v, tr) { return compute(v, tr.state, tr); },
    provide: function (f) { return EditorView.decorations.from(f, function (v) { return v.deco; }); },
  });

  Cade.registerPlugin({ id: 'postcard-view', ext: field });
})();
