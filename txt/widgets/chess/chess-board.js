/* Shared chessboard view for the Chess and Chess Puzzles widgets (Cade.txt).
 * A DOM grid of 64 squares: pieces as Unicode chess glyphs (outline glyph over a
 * solid one, so white pieces are white with an ink outline in any theme) or as
 * plain letters. Tap a piece then a square, or drag it; legal-move dots,
 * capture rings, last move, check, hint and a keyboard cursor. Moves slide.
 * Theme colours are read from the panel's CSS variables and re-read on demand.
 * window.__cadeChessBoard.create(container, { onMove(from, to), onTap(sq) }) */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__cadeChessBoard) return;

  var SOLID = { 1: '♟', 2: '♞', 3: '♝', 4: '♜', 5: '♛', 6: '♚' };
  var HOLLOW = { 1: '♙', 2: '♘', 3: '♗', 4: '♖', 5: '♕', 6: '♔' };
  var VS = '︎';
  var LET = ' PNBRQK';
  var NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];

  function sqOf(r, f) { return r * 16 + f; }
  function sqName(s) { return 'abcdefgh'.charAt(s & 7) + ((s >> 4) + 1); }

  // ---- theme colours ----
  function parseCol(s, d) {
    s = (s || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    return m ? [+m[1], +m[2], +m[3]] : d;
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function css(c, a) {
    var r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
    return a == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function lum(c) { return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
  // Board colours derived from the theme; set as CSS variables on `el`.
  function applyTheme(el) {
    var cs = getComputedStyle(el);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var dark = lum(bg) < 0.45, grey = mix(bg, tx, 0.5);
    var tint = mix(grey, ac, 0.55);
    var L, D;
    if (dark) { L = mix(mix(bg, tx, 0.62), ac, 0.1); D = mix(mix(bg, tx, 0.3), tint, 0.55); }
    else { L = mix(mix(bg, [255, 255, 255], 0.4), ac, 0.08); D = mix(mix(bg, tx, 0.18), ac, 0.42); }
    var st = el.style;
    st.setProperty('--chb-l', css(L)); st.setProperty('--chb-d', css(D));
    st.setProperty('--chb-lc', css(mix(L, D, 0.85))); st.setProperty('--chb-dc', css(mix(D, L, 0.8)));
    st.setProperty('--chb-sel', css(ac, dark ? 0.55 : 0.45));
    st.setProperty('--chb-last', dark ? 'rgba(242,197,68,0.42)' : 'rgba(214,170,30,0.42)');
    st.setProperty('--chb-dot', css(mix(D, [20, 20, 20], 0.55), 0.55));
    st.setProperty('--chb-hint', dark ? '#7ed37a' : '#2f8f3a');
    st.setProperty('--chb-chk', dark ? '#ff5d5d' : '#e03131');
    return dark;
  }

  function create(host, opts) {
    opts = opts || {};
    var root = document.createElement('div');
    root.className = 'chb';
    root.setAttribute('role', 'grid');
    var grid = document.createElement('div');
    grid.className = 'chb-grid';
    root.appendChild(grid);
    var cells = [], pcs = [], crs = [], cfs = [];
    for (var i = 0; i < 64; i++) {
      var c = document.createElement('div');
      c.className = 'chb-sq';
      c.setAttribute('role', 'gridcell');
      var p = document.createElement('span');
      p.className = 'chb-pc';
      c.appendChild(p);
      var cr = document.createElement('i'), cf = document.createElement('i');
      cr.className = 'chb-cr'; cf.className = 'chb-cf';
      c.appendChild(cr); c.appendChild(cf);
      crs.push(cr); cfs.push(cf);
      grid.appendChild(c);
      cells.push(c); pcs.push(p);
    }
    var ghost = document.createElement('span');
    ghost.className = 'chb-pc chb-ghost';
    ghost.style.display = 'none';
    root.appendChild(ghost);
    var arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowSvg.setAttribute('class', 'chb-arrows');
    arrowSvg.setAttribute('viewBox', '0 0 8 8');
    arrowSvg.setAttribute('aria-hidden', 'true');
    root.appendChild(arrowSvg);
    host.appendChild(root);

    var V = {
      el: root, st: null, sel: -1, cursor: -1, flip: false, style: 'glyph', coords: true, targets: [],
      drag: null, onMove: opts.onMove || function () {}, onTap: opts.onTap || null, kb: false
    };
    // index (0..63, visual order) <-> 0x88 square
    function sqAt(idx) { var row = idx >> 3, col = idx & 7; return V.flip ? sqOf(row, 7 - col) : sqOf(7 - row, col); }
    function idxOf(sq) { var r = sq >> 4, f = sq & 7; return V.flip ? r * 8 + (7 - f) : (7 - r) * 8 + f; }

    function pieceHtml(pc) {
      if (!pc) return '';
      var t = pc & 7, w = pc < 8;
      if (V.style === 'letter') return w ? LET.charAt(t) : LET.charAt(t).toLowerCase();
      return HOLLOW[t] + VS;
    }
    function paintPiece(el, pc) {
      var cls = 'chb-pc' + (pc ? (pc < 8 ? ' w' : ' b') + (V.style === 'letter' ? ' let' : ' gl') : '');
      if (el.className !== cls && !el.classList.contains('chb-ghost')) el.className = cls;
      var txt = pieceHtml(pc);
      if (el.textContent !== txt) el.textContent = txt;
      if (pc && V.style !== 'letter') el.setAttribute('data-s', SOLID[pc & 7] + VS); else el.removeAttribute('data-s');
    }

    // Render a state: { b: board (0x88 Int8Array), flip, last: [from, to], check: sq, hint: [from, to],
    //   movable(sq) → bool, targetsOf(sq) → [sq], style, coords, wrong: sq, good: sq }
    V.render = function (st, anim) {
      V.st = st;
      V.flip = !!st.flip; V.style = st.style || 'glyph'; V.coords = st.coords !== false;
      if (V.sel >= 0 && !(st.movable && st.movable(V.sel))) { V.sel = -1; V.targets = []; }
      else if (V.sel >= 0) V.targets = st.targetsOf ? st.targetsOf(V.sel) : [];
      for (var i = 0; i < 64; i++) {
        var sq = sqAt(i), r = sq >> 4, f = sq & 7, light = ((r + f) & 1) === 1, c = cells[i];
        var cls = 'chb-sq ' + (light ? 'l' : 'd');
        if (st.last && (st.last[0] === sq || st.last[1] === sq)) cls += ' last';
        if (V.sel === sq) cls += ' sel';
        if (st.check === sq) cls += ' chk';
        if (st.hint && (st.hint[0] === sq || st.hint[1] === sq)) cls += ' hint';
        if (st.good === sq) cls += ' good';
        if (st.wrong === sq) cls += ' wrong';
        if (V.targets.indexOf(sq) >= 0) cls += st.b[sq] || (st.epSq === sq) ? ' cap' : ' dot';
        if (V.kb && V.cursor === sq) cls += ' cur';
        if (c.className !== cls) c.className = cls;
        c.setAttribute('data-sq', sq);
        var pc = st.b[sq];
        c.setAttribute('aria-label', sqName(sq) + (pc ? ' ' + (pc < 8 ? 'white ' : 'black ') + NAMES[pc & 7] : ''));
        var rk = V.coords && (i & 7) === 0 ? String(r + 1) : '', fl = V.coords && i >= 56 ? 'abcdefgh'.charAt(f) : '';
        if (crs[i].textContent !== rk) crs[i].textContent = rk;
        if (cfs[i].textContent !== fl) cfs[i].textContent = fl;
        paintPiece(pcs[i], pc);
        pcs[i].style.transform = ''; pcs[i].style.transition = '';
        pcs[i].classList.toggle('lift', !!(V.drag && V.drag.moved && V.drag.from === sq));
      }
      drawArrows(st.arrows || []);
      if (anim && anim.length && !reduced()) {
        anim.forEach(function (a) { slide(a[0], a[1]); });
      }
    };
    function reduced() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
    function slide(from, to) {
      var el = pcs[idxOf(to)], a = idxOf(from), b = idxOf(to);
      var dx = (a & 7) - (b & 7), dy = (a >> 3) - (b >> 3);
      el.style.transition = 'none';
      el.style.transform = 'translate(' + dx * 100 + '%,' + dy * 100 + '%)';
      el.classList.add('moving');
      void el.offsetWidth;
      el.style.transition = 'transform 150ms ease-out';
      el.style.transform = '';
      setTimeout(function () { el.classList.remove('moving'); }, 170);
    }
    function drawArrows(list) {
      var h = '';
      list.forEach(function (ar) {
        var a = idxOf(ar[0]), b = idxOf(ar[1]), x1 = (a & 7) + 0.5, y1 = (a >> 3) + 0.5, x2 = (b & 7) + 0.5, y2 = (b >> 3) + 0.5;
        var dx = x2 - x1, dy = y2 - y1, L = Math.sqrt(dx * dx + dy * dy) || 1, ux = dx / L, uy = dy / L;
        var ex = x2 - ux * 0.32, ey = y2 - uy * 0.32;
        h += '<line x1="' + (x1 + ux * 0.2).toFixed(3) + '" y1="' + (y1 + uy * 0.2).toFixed(3) + '" x2="' + ex.toFixed(3) + '" y2="' + ey.toFixed(3) + '"/>' +
          '<polygon points="' + (x2 - ux * 0.05).toFixed(3) + ',' + (y2 - uy * 0.05).toFixed(3) + ' ' + (ex - uy * 0.22).toFixed(3) + ',' + (ey + ux * 0.22).toFixed(3) + ' ' + (ex + uy * 0.22).toFixed(3) + ',' + (ey - ux * 0.22).toFixed(3) + '"/>';
      });
      arrowSvg.innerHTML = h;
    }
    V.clearSel = function () { if (V.sel >= 0) { V.sel = -1; V.targets = []; if (V.st) V.render(V.st); } };
    function select(sq) {
      V.sel = sq; V.targets = V.st.targetsOf ? V.st.targetsOf(sq) : [];
      V.render(V.st);
    }
    // A tap / click / Enter on a square.
    function act(sq) {
      var st = V.st;
      if (!st) return;
      if (V.onTap && V.onTap(sq) === true) return;
      if (V.sel >= 0 && V.targets.indexOf(sq) >= 0) { var f = V.sel; V.sel = -1; V.targets = []; V.onMove(f, sq); return; }
      if (st.movable && st.movable(sq)) { if (V.sel === sq) V.clearSel(); else select(sq); return; }
      V.clearSel();
    }
    V.act = act;

    // ---- pointer: tap-tap or drag ----
    function sqFromPoint(x, y) {
      var r = grid.getBoundingClientRect();
      if (x < r.left || y < r.top || x >= r.right || y >= r.bottom) return -1;
      var col = Math.floor((x - r.left) / (r.width / 8)), row = Math.floor((y - r.top) / (r.height / 8));
      return sqAt(Math.max(0, Math.min(7, row)) * 8 + Math.max(0, Math.min(7, col)));
    }
    function moveGhost(x, y) {
      var r = root.getBoundingClientRect(), s = r.width / 8;
      ghost.style.width = s + 'px'; ghost.style.height = s + 'px';
      ghost.style.transform = 'translate(' + (x - r.left - s / 2) + 'px,' + (y - r.top - s * 0.62) + 'px)';
    }
    root.addEventListener('pointerdown', function (e) {
      if (e.button > 0 || !V.st) return;
      e.preventDefault();
      V.kb = false;
      var sq = sqFromPoint(e.clientX, e.clientY);
      if (sq < 0) return;
      if (opts.onPress) opts.onPress();
      var st = V.st;
      // a selected piece and a legal target: move at once
      if (V.sel >= 0 && V.targets.indexOf(sq) >= 0) { act(sq); return; }
      if (st.movable && st.movable(sq)) {
        var wasSel = V.sel === sq;
        if (!wasSel) select(sq);
        V.drag = { from: sq, x: e.clientX, y: e.clientY, moved: false, id: e.pointerId, wasSel: wasSel };
        try { root.setPointerCapture(e.pointerId); } catch (x) {}
        return;
      }
      act(sq);
    });
    root.addEventListener('pointermove', function (e) {
      var d = V.drag;
      if (!d || e.pointerId !== d.id) return;
      if (!d.moved) {
        var dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (dx * dx + dy * dy < 36) return;
        d.moved = true;
        paintPiece(ghost, V.st.b[d.from]);
        ghost.className = 'chb-pc chb-ghost ' + (V.st.b[d.from] < 8 ? 'w' : 'b') + (V.style === 'letter' ? ' let' : ' gl');
        ghost.style.display = '';
        pcs[idxOf(d.from)].classList.add('lift');
      }
      moveGhost(e.clientX, e.clientY);
      var over = sqFromPoint(e.clientX, e.clientY);
      for (var i = 0; i < 64; i++) cells[i].classList.toggle('over', sqAt(i) === over && V.targets.indexOf(over) >= 0);
    });
    function endDrag(e, cancel) {
      var d = V.drag;
      if (!d || (e && e.pointerId !== d.id)) return;
      V.drag = null;
      ghost.style.display = 'none';
      for (var i = 0; i < 64; i++) cells[i].classList.remove('over');
      pcs[idxOf(d.from)].classList.remove('lift');
      if (!d.moved) { if (d.wasSel && !cancel) V.clearSel(); return; }
      var to = cancel ? -1 : sqFromPoint(e.clientX, e.clientY);
      if (to >= 0 && to !== d.from && V.targets.indexOf(to) >= 0) { V.sel = -1; V.targets = []; V.onMove(d.from, to, true); }
    }
    root.addEventListener('pointerup', function (e) { endDrag(e, false); });
    root.addEventListener('pointercancel', function (e) { endDrag(e, true); });
    root.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    root.addEventListener('touchstart', noTouch, { passive: false });
    root.addEventListener('touchmove', noTouch, { passive: false });
    root.addEventListener('touchend', noTouch, { passive: false });

    // ---- keyboard cursor: arrows move it, Enter / Space acts ----
    V.key = function (code) {
      if (!V.st) return false;
      var map = { ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (map[code]) {
        if (!V.kb || V.cursor < 0) { V.kb = true; V.cursor = V.sel >= 0 ? V.sel : (V.flip ? 0x74 : 0x04); V.render(V.st); return true; }
        var d = map[code], r = (V.cursor >> 4) + (V.flip ? -d[0] : d[0]), f = (V.cursor & 7) + (V.flip ? -d[1] : d[1]);
        r = Math.max(0, Math.min(7, r)); f = Math.max(0, Math.min(7, f));
        V.kb = true; V.cursor = r * 16 + f; V.render(V.st);
        return true;
      }
      if ((code === 'Enter' || code === 'Space' || code === 'NumpadEnter') && V.kb && V.cursor >= 0) { act(V.cursor); return true; }
      return false;
    };
    V.applyTheme = function () { return applyTheme(root); };
    V.destroy = function () { try { root.remove(); } catch (e) {} };
    V.applyTheme();
    return V;
  }

  window.__cadeChessBoard = { create: create, applyTheme: applyTheme, SOLID: SOLID, HOLLOW: HOLLOW, VS: VS, LET: LET, NAMES: NAMES, sqName: sqName };
})();
