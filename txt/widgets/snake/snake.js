/* Snake — eat the dots, don't bite yourself. Arrows / swipe. Offline module.
 * Speeds up as you grow; high score persists. Esc closes. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('snake.css');

  var COLS = 20, ROWS = 20, CELL = 14;
  var W = COLS * CELL, H = ROWS * CELL;
  var snake, dir, nextDir, food, score, over, started, stepMs, acc, last, raf = 0, state = null;

  function hi() { try { return parseInt(Cade.store.get('cade-game-snake-hi') || '0', 10) || 0; } catch (e) { return 0; } }
  function setHi(v) { try { Cade.store.set('cade-game-snake-hi', String(v)); } catch (e) {} }
  function placeFood() {
    do { food = { x: (Math.random() * COLS) | 0, y: (Math.random() * ROWS) | 0 }; }
    while (snake.some(function (s) { return s.x === food.x && s.y === food.y; }));
  }
  function reset() {
    snake = [{ x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }];
    dir = { x: 1, y: 0 }; nextDir = dir; score = 0; over = false; started = false; stepMs = 130; acc = 0; last = 0;
    placeFood();
  }
  function step() {
    if (!started || over) return;
    dir = nextDir;
    var head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS || snake.some(function (s) { return s.x === head.x && s.y === head.y; })) {
      over = true; if (score > hi()) setHi(score); return;
    }
    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) { score++; if (score > hi()) setHi(score); stepMs = Math.max(60, 130 - score * 3); placeFood(); }
    else snake.pop();
  }
  function render() {
    if (!state || !state.canvas.isConnected) return;
    var ctx = state.ctx;
    ctx.fillStyle = '#0c0e12'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#e85d8a'; ctx.fillRect(food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4);
    for (var i = 0; i < snake.length; i++) {
      ctx.fillStyle = i === 0 ? '#f2f4f7' : 'hsl(150,40%,' + Math.max(40, 70 - i) + '%)';
      ctx.fillRect(snake[i].x * CELL + 1, snake[i].y * CELL + 1, CELL - 2, CELL - 2);
    }
    var msg = document.getElementById('snake-msg');
    if (msg) msg.textContent = over ? 'Game over — Space to retry' : !started ? 'Arrows / swipe to start' : 'Score ' + score;
    var hiEl = document.getElementById('snake-hi'); if (hiEl) hiEl.textContent = 'HI ' + Math.max(hi(), score);
  }
  function loop(ts) {
    raf = 0;
    if (!state || !state.canvas.isConnected) { state = null; return; }
    if (!last) last = ts;
    acc += ts - last; last = ts;
    while (acc >= stepMs) { acc -= stepMs; step(); }
    render();
    raf = requestAnimationFrame(loop);
  }
  function setDir(x, y) {
    if (!started) { started = true; last = 0; }
    if (over) return;
    if (dir.x === -x && dir.y === -y) return; // no reversing
    nextDir = { x: x, y: y };
  }
  function close() { if (raf) { cancelAnimationFrame(raf); raf = 0; } if (state && state._key) document.removeEventListener('keydown', state._key, true); state = null; var p = document.getElementById('snake-panel'); if (p) p.remove(); try { Cade.editor.focus(); } catch (e) {} }
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById('snake-panel')) { close(); return; }
    var body = '<canvas id="snake-canvas" class="snake-canvas" width="' + W + '" height="' + H + '"></canvas>' +
      '<div class="snake-status"><span id="snake-msg">Arrows / swipe to start</span><span id="snake-hi"></span></div>';
    var p = Cade.mkPanel('snake-panel', '🐍 Snake', body);
    var canvas = document.getElementById('snake-canvas');
    reset();
    state = { canvas: canvas, ctx: canvas.getContext('2d') };
    p._onClose = function () { if (raf) { cancelAnimationFrame(raf); raf = 0; } if (state && state._key) document.removeEventListener('keydown', state._key, true); state = null; };
    state._key = function (e) {
      if (!document.getElementById('snake-panel')) return;
      var k = e.key;
      if (k === 'Escape') { e.preventDefault(); close(); return; }
      if ((k === ' ' || e.code === 'Space') && over) { e.preventDefault(); reset(); return; }
      if (k === 'ArrowLeft') { e.preventDefault(); setDir(-1, 0); }
      else if (k === 'ArrowRight') { e.preventDefault(); setDir(1, 0); }
      else if (k === 'ArrowUp') { e.preventDefault(); setDir(0, -1); }
      else if (k === 'ArrowDown') { e.preventDefault(); setDir(0, 1); }
    };
    document.addEventListener('keydown', state._key, true);
    var sx = 0, sy = 0, tracking = false;
    canvas.addEventListener('pointerdown', function (e) { sx = e.clientX; sy = e.clientY; tracking = true; });
    canvas.addEventListener('pointerup', function (e) {
      if (!tracking) return; tracking = false;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) < 16 && Math.abs(dy) < 16) { if (over) reset(); return; }
      if (Math.abs(dx) > Math.abs(dy)) setDir(dx > 0 ? 1 : -1, 0); else setDir(0, dy > 0 ? 1 : -1);
    });
    canvas.style.touchAction = 'none';
    raf = requestAnimationFrame(loop);
  }

  Cade.registerWidget({ name: 'Snake', description: 'Classic snake — eat, grow, survive', icon: '🐍', tags: 'game,snake,arcade,train,fun', open: open });
})();
