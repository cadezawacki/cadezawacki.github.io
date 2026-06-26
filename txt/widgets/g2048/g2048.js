/* 2048 — slide tiles (arrows / swipe), merge matching numbers, reach 2048.
 * Offline, self-contained module. Best score persists. Esc closes. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('g2048.css');

  var N = 4, GAP = 8, CELL = 62, TOP = 30;
  var W = GAP + N * (CELL + GAP);            // 288
  var H = TOP + GAP + N * (CELL + GAP);      // 318
  var grid, score, over, raf = 0, state = null;

  function best() { try { return parseInt(Cade.store.get('cade-game-2048-best') || '0', 10) || 0; } catch (e) { return 0; } }
  function setBest(v) { try { Cade.store.set('cade-game-2048-best', String(v)); } catch (e) {} }
  function emptyCells() { var c = []; for (var i = 0; i < N * N; i++) if (!grid[i]) c.push(i); return c; }
  function spawn() { var c = emptyCells(); if (!c.length) return; grid[c[(Math.random() * c.length) | 0]] = Math.random() < 0.9 ? 2 : 4; }
  function reset() { grid = new Array(N * N).fill(0); score = 0; over = false; spawn(); spawn(); }

  function slide(line) {
    var a = line.filter(function (v) { return v; }), g = 0;
    for (var i = 0; i < a.length - 1; i++) { if (a[i] === a[i + 1]) { a[i] *= 2; g += a[i]; a.splice(i + 1, 1); } }
    while (a.length < N) a.push(0);
    return { line: a, g: g };
  }
  function indicesFor(dir, i) {
    var idx = [];
    for (var j = 0; j < N; j++) {
      var r, c;
      if (dir === 'left') { r = i; c = j; }
      else if (dir === 'right') { r = i; c = N - 1 - j; }
      else if (dir === 'up') { r = j; c = i; }
      else { r = N - 1 - j; c = i; }
      idx.push(r * N + c);
    }
    return idx;
  }
  function move(dir) {
    if (over) return;
    var changed = false, gained = 0;
    for (var i = 0; i < N; i++) {
      var idx = indicesFor(dir, i);
      var res = slide(idx.map(function (k) { return grid[k]; }));
      gained += res.g;
      for (var j = 0; j < N; j++) { if (grid[idx[j]] !== res.line[j]) changed = true; grid[idx[j]] = res.line[j]; }
    }
    if (changed) {
      score += gained;
      if (score > best()) setBest(score);
      spawn();
      if (isOver()) over = true;
    }
  }
  function isOver() {
    if (emptyCells().length) return false;
    for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) {
      var v = grid[i * N + j];
      if (j < N - 1 && grid[i * N + j + 1] === v) return false;
      if (i < N - 1 && grid[(i + 1) * N + j] === v) return false;
    }
    return true;
  }

  var COLORS = { 0: '#1b1e25', 2: '#3a3f4b', 4: '#46506b', 8: '#5b6f9e', 16: '#6f8fc4', 32: '#7fae8c', 64: '#9bc16a', 128: '#d8b65a', 256: '#e0a64a', 512: '#e88f57', 1024: '#e87060', 2048: '#e85d8a' };
  function render() {
    if (!state || !state.canvas.isConnected) return;
    var ctx = state.ctx;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0c0e12'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(203,210,220,0.9)'; ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText('SCORE ' + score, 6, 18);
    ctx.textAlign = 'right'; ctx.fillText('BEST ' + Math.max(best(), score), W - 6, 18);
    ctx.textBaseline = 'middle';
    for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) {
      var v = grid[i * N + j];
      var x = GAP + j * (CELL + GAP), y = TOP + GAP + i * (CELL + GAP);
      ctx.fillStyle = COLORS[v] || '#e85d8a';
      ctx.fillRect(x, y, CELL, CELL);
      if (v) {
        ctx.fillStyle = v <= 4 ? '#cbd2dc' : '#0c0e12';
        ctx.font = 'bold ' + (v < 100 ? 26 : v < 1000 ? 21 : 17) + 'px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(v), x + CELL / 2, y + CELL / 2 + 1);
      }
    }
    if (over) {
      ctx.fillStyle = 'rgba(12,14,18,0.78)'; ctx.fillRect(0, TOP, W, H - TOP);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = 'bold 22px ui-monospace, monospace';
      ctx.fillText('Game over', W / 2, H / 2 - 8);
      ctx.font = '12px ui-monospace, monospace'; ctx.fillStyle = 'rgba(203,210,220,0.9)';
      ctx.fillText('Space / tap to restart', W / 2, H / 2 + 16);
    }
  }
  function loop() { raf = 0; if (!state || !state.canvas.isConnected) { state = null; return; } render(); raf = requestAnimationFrame(loop); }

  function close() { if (raf) { cancelAnimationFrame(raf); raf = 0; } if (state && state._key) document.removeEventListener('keydown', state._key, true); state = null; var p = document.getElementById('g2048-panel'); if (p) p.remove(); try { Cade.editor.focus(); } catch (e) {} }
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById('g2048-panel')) { close(); return; }
    var body = '<canvas id="g2048-canvas" class="g2048-canvas" width="' + W + '" height="' + H + '"></canvas>' +
      '<div class="g2048-hint">Arrows / swipe to move · Space to restart · Esc to close</div>';
    var p = Cade.mkPanel('g2048-panel', '🔢 2048', body);
    var canvas = document.getElementById('g2048-canvas');
    reset();
    state = { canvas: canvas, ctx: canvas.getContext('2d') };
    p._onClose = function () { if (raf) { cancelAnimationFrame(raf); raf = 0; } if (state && state._key) document.removeEventListener('keydown', state._key, true); state = null; };
    state._key = function (e) {
      if (!document.getElementById('g2048-panel')) return;
      var k = e.key;
      if (k === 'Escape') { e.preventDefault(); close(); return; }
      if (k === ' ' || e.code === 'Space') { e.preventDefault(); reset(); return; }
      if (k === 'ArrowLeft') { e.preventDefault(); move('left'); }
      else if (k === 'ArrowRight') { e.preventDefault(); move('right'); }
      else if (k === 'ArrowUp') { e.preventDefault(); move('up'); }
      else if (k === 'ArrowDown') { e.preventDefault(); move('down'); }
    };
    document.addEventListener('keydown', state._key, true);
    // Touch swipe
    var sx = 0, sy = 0, tracking = false;
    canvas.addEventListener('pointerdown', function (e) { sx = e.clientX; sy = e.clientY; tracking = true; });
    canvas.addEventListener('pointerup', function (e) {
      if (!tracking) return; tracking = false;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) < 24 && Math.abs(dy) < 24) { if (over) reset(); return; }
      if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left'); else move(dy > 0 ? 'down' : 'up');
    });
    canvas.style.touchAction = 'none';
    raf = requestAnimationFrame(loop);
  }

  Cade.registerWidget({ name: '2048', description: 'Slide & merge tiles to reach 2048', icon: '🔢', tags: 'game,2048,puzzle,numbers,train,fun', open: open });
})();
