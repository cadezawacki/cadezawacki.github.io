/* Tetris — the trainride classic. ← → move · ↑ rotate · ↓ soft drop ·
 * Space hard drop. Touch: tap = rotate, swipe = move / drop. Offline module,
 * high score persists, Esc closes. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('tetris.css');

  var COLS = 10, ROWS = 20, CELL = 14;
  var W = COLS * CELL, H = ROWS * CELL;
  var SHAPES = {
    I: [[1, 1, 1, 1]], O: [[1, 1], [1, 1]], T: [[0, 1, 0], [1, 1, 1]],
    S: [[0, 1, 1], [1, 1, 0]], Z: [[1, 1, 0], [0, 1, 1]], J: [[1, 0, 0], [1, 1, 1]], L: [[0, 0, 1], [1, 1, 1]]
  };
  var COLORS = { I: '#5bc0de', O: '#e0c34a', T: '#a45cf0', S: '#7fae5b', Z: '#e85d5d', J: '#5b7fd8', L: '#e0934a' };
  var TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

  var board, piece, score, lines, over, dropMs, acc, last, raf = 0, state = null;

  function hi() { try { return parseInt(Cade.store.get('cade-game-tetris-hi') || '0', 10) || 0; } catch (e) { return 0; } }
  function setHi(v) { try { Cade.store.set('cade-game-tetris-hi', String(v)); } catch (e) {} }
  function newBoard() { var b = []; for (var r = 0; r < ROWS; r++) b.push(new Array(COLS).fill(0)); return b; }
  function rotate(m) {
    var rows = m.length, cols = m[0].length, out = [];
    for (var c = 0; c < cols; c++) { out.push([]); for (var r = rows - 1; r >= 0; r--) out[c].push(m[r][c]); }
    return out;
  }
  function spawn() {
    var t = TYPES[(Math.random() * TYPES.length) | 0];
    var m = SHAPES[t].map(function (r) { return r.slice(); });
    piece = { type: t, m: m, x: ((COLS - m[0].length) / 2) | 0, y: 0 };
    if (collide(piece.m, piece.x, piece.y)) over = true;
  }
  function collide(m, px, py) {
    for (var r = 0; r < m.length; r++) for (var c = 0; c < m[r].length; c++) {
      if (!m[r][c]) continue;
      var x = px + c, y = py + r;
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y >= 0 && board[y][x]) return true;
    }
    return false;
  }
  function merge() {
    for (var r = 0; r < piece.m.length; r++) for (var c = 0; c < piece.m[r].length; c++) {
      if (piece.m[r][c] && piece.y + r >= 0) board[piece.y + r][piece.x + c] = piece.type;
    }
  }
  function clearLines() {
    var cleared = 0;
    for (var r = ROWS - 1; r >= 0; r--) {
      if (board[r].every(function (v) { return v; })) { board.splice(r, 1); board.unshift(new Array(COLS).fill(0)); cleared++; r++; }
    }
    if (cleared) {
      score += [0, 100, 300, 500, 800][cleared] * (1 + (lines / 10 | 0));
      lines += cleared;
      dropMs = Math.max(120, 700 - (lines / 10 | 0) * 70);
      if (score > hi()) setHi(score);
    }
  }
  function lock() { merge(); clearLines(); spawn(); }
  function move(dx) { if (!over && !collide(piece.m, piece.x + dx, piece.y)) piece.x += dx; }
  function rot() { if (over) return; var m = rotate(piece.m); var kicks = [0, -1, 1, -2, 2]; for (var i = 0; i < kicks.length; i++) { if (!collide(m, piece.x + kicks[i], piece.y)) { piece.m = m; piece.x += kicks[i]; return; } } }
  function softDrop() { if (over) return; if (!collide(piece.m, piece.x, piece.y + 1)) piece.y++; else lock(); }
  function hardDrop() { if (over) return; while (!collide(piece.m, piece.x, piece.y + 1)) piece.y++; lock(); }
  function reset() { board = newBoard(); score = 0; lines = 0; over = false; dropMs = 700; acc = 0; last = 0; spawn(); }

  function render() {
    if (!state || !state.canvas.isConnected) return;
    var ctx = state.ctx;
    ctx.fillStyle = '#0c0e12'; ctx.fillRect(0, 0, W, H);
    var r, c;
    for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) {
      if (board[r][c]) { ctx.fillStyle = COLORS[board[r][c]]; ctx.fillRect(c * CELL + 1, r * CELL + 1, CELL - 2, CELL - 2); }
    }
    if (piece) {
      ctx.fillStyle = COLORS[piece.type];
      for (r = 0; r < piece.m.length; r++) for (c = 0; c < piece.m[r].length; c++) {
        if (piece.m[r][c] && piece.y + r >= 0) ctx.fillRect((piece.x + c) * CELL + 1, (piece.y + r) * CELL + 1, CELL - 2, CELL - 2);
      }
    }
    if (over) {
      ctx.fillStyle = 'rgba(12,14,18,0.8)'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = 'bold 18px ui-monospace, monospace';
      ctx.fillText('Game over', W / 2, H / 2 - 6);
      ctx.font = '11px ui-monospace, monospace'; ctx.fillStyle = 'rgba(203,210,220,0.9)';
      ctx.fillText('Space to retry', W / 2, H / 2 + 14);
    }
    var msg = document.getElementById('tetris-msg'); if (msg) msg.textContent = 'Score ' + score + ' · Lines ' + lines;
    var hiEl = document.getElementById('tetris-hi'); if (hiEl) hiEl.textContent = 'HI ' + Math.max(hi(), score);
  }
  function loop(ts) {
    raf = 0;
    if (!state || !state.canvas.isConnected) { state = null; return; }
    if (!last) last = ts;
    acc += ts - last; last = ts;
    if (!over) { while (acc >= dropMs) { acc -= dropMs; softDrop(); } }
    else acc = 0;
    render();
    raf = requestAnimationFrame(loop);
  }
  function close() { if (raf) { cancelAnimationFrame(raf); raf = 0; } if (state && state._key) document.removeEventListener('keydown', state._key, true); state = null; var p = document.getElementById('tetris-panel'); if (p) p.remove(); try { Cade.editor.focus(); } catch (e) {} }
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById('tetris-panel')) { close(); return; }
    var body = '<canvas id="tetris-canvas" class="tetris-canvas" width="' + W + '" height="' + H + '"></canvas>' +
      '<div class="tetris-status"><span id="tetris-msg">Score 0 · Lines 0</span><span id="tetris-hi"></span></div>';
    var p = Cade.mkPanel('tetris-panel', '🧱 Tetris', body);
    var canvas = document.getElementById('tetris-canvas');
    reset();
    state = { canvas: canvas, ctx: canvas.getContext('2d') };
    p._onClose = function () { if (raf) { cancelAnimationFrame(raf); raf = 0; } if (state && state._key) document.removeEventListener('keydown', state._key, true); state = null; };
    state._key = function (e) {
      if (!document.getElementById('tetris-panel')) return;
      var k = e.key;
      if (k === 'Escape') { e.preventDefault(); close(); return; }
      if (k === ' ' || e.code === 'Space') { e.preventDefault(); if (over) reset(); else hardDrop(); return; }
      if (k === 'ArrowLeft') { e.preventDefault(); move(-1); }
      else if (k === 'ArrowRight') { e.preventDefault(); move(1); }
      else if (k === 'ArrowUp') { e.preventDefault(); rot(); }
      else if (k === 'ArrowDown') { e.preventDefault(); softDrop(); acc = 0; }
    };
    document.addEventListener('keydown', state._key, true);
    var sx = 0, sy = 0, tracking = false, lastMoveX = 0;
    canvas.addEventListener('pointerdown', function (e) { sx = e.clientX; sy = e.clientY; tracking = true; lastMoveX = e.clientX; });
    canvas.addEventListener('pointermove', function (e) {
      if (!tracking) return;
      var dx = e.clientX - lastMoveX;
      if (Math.abs(dx) >= CELL) { move(dx > 0 ? 1 : -1); lastMoveX = e.clientX; }
    });
    canvas.addEventListener('pointerup', function (e) {
      if (!tracking) return; tracking = false;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) { if (over) reset(); else rot(); return; }
      if (dy > 40 && Math.abs(dy) > Math.abs(dx)) { if (over) reset(); else hardDrop(); }
    });
    canvas.style.touchAction = 'none';
    raf = requestAnimationFrame(loop);
  }

  Cade.registerWidget({ name: 'Tetris', description: 'Stack falling blocks, clear lines', icon: '🧱', tags: 'game,tetris,blocks,puzzle,train,fun', open: open });
})();
