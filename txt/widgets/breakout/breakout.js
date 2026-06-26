/* Breakout — a low-key retro brick-breaker widget for Cade.txt.
 * Loaded on demand by the module loader; registers itself via window.Cade.
 * Paddle: mouse / drag / arrow keys. Click or Space to launch. Esc bails out.
 * High score persists locally. Self-contained IIFE — no global leakage. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  // Load this module's stylesheet now, while the loader's per-module context is
  // still pointing at this folder (open() runs later, after the context moves on).
  Cade.loadCSS('breakout.css');

  var BRK = { ROWS: 5, COLS: 8, W: 300, H: 360, BRICK_H: 14, TOP: 26, PAD_W: 56, PAD_H: 8, BALL_R: 5 };
  var COLORS = ['#f2f4f7', '#cfd4dc', '#aab0bb', '#878d99', '#646b77']; // white → grey rows
  var raf = 0, game = null;

  function hi() { try { return parseInt(Cade.store.get('cade-game-breakout-hi') || '0', 10) || 0; } catch (e) { return 0; } }
  function setHi(v) { try { Cade.store.set('cade-game-breakout-hi', String(v)); } catch (e) {} }

  function initBricks(s) {
    s.bricks = [];
    var gap = 3, w = (BRK.W - gap) / BRK.COLS;
    for (var r = 0; r < BRK.ROWS; r++)
      for (var c = 0; c < BRK.COLS; c++)
        s.bricks.push({ x: c * w + gap, y: BRK.TOP + r * (BRK.BRICK_H + gap), w: w - gap, h: BRK.BRICK_H, color: COLORS[r % COLORS.length], alive: true });
  }
  function reset(s, full) {
    s.ball.x = s.paddle.x + BRK.PAD_W / 2;
    s.ball.y = BRK.H - 24;
    s.ball.vx = 0; s.ball.vy = 0;
    s.started = false;
    if (full) { s.score = 0; s.lives = 3; s.over = false; s.win = false; initBricks(s); }
  }
  function launch(s) {
    if (s.over || s.win) reset(s, true);
    if (s.started) return;
    s.started = true;
    s.ball.vx = (Math.random() < 0.5 ? -1 : 1) * 2.2;
    s.ball.vy = -3.2;
    if (!raf) raf = requestAnimationFrame(loop);
  }
  function loop() {
    raf = 0;
    var s = game;
    if (!s || !s.canvas || !s.canvas.isConnected) { game = null; return; }
    if (s.started && !s.over && !s.win) {
      var b = s.ball;
      b.x += b.vx; b.y += b.vy;
      if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
      if (b.x + b.r > BRK.W) { b.x = BRK.W - b.r; b.vx = -Math.abs(b.vx); }
      if (b.y - b.r < 0) { b.y = b.r; b.vy = Math.abs(b.vy); }
      var py = BRK.H - 18;
      if (b.vy > 0 && b.y + b.r >= py && b.y + b.r <= py + BRK.PAD_H + 6 && b.x >= s.paddle.x - b.r && b.x <= s.paddle.x + BRK.PAD_W + b.r) {
        b.y = py - b.r;
        var hit = (b.x - (s.paddle.x + BRK.PAD_W / 2)) / (BRK.PAD_W / 2);
        var speed = Math.min(6, Math.hypot(b.vx, b.vy) + 0.05);
        var ang = hit * 1.0;
        b.vx = speed * Math.sin(ang);
        b.vy = -Math.abs(speed * Math.cos(ang));
      }
      for (var i = 0; i < s.bricks.length; i++) {
        var br = s.bricks[i];
        if (!br.alive) continue;
        if (b.x + b.r > br.x && b.x - b.r < br.x + br.w && b.y + b.r > br.y && b.y - b.r < br.y + br.h) {
          br.alive = false; s.score += 10;
          var overlapX = Math.min(b.x + b.r - br.x, br.x + br.w - (b.x - b.r));
          var overlapY = Math.min(b.y + b.r - br.y, br.y + br.h - (b.y - b.r));
          if (overlapX < overlapY) b.vx = -b.vx; else b.vy = -b.vy;
          break;
        }
      }
      if (s.bricks.every(function (br) { return !br.alive; })) s.win = true;
      if (b.y - b.r > BRK.H) {
        s.lives--;
        if (s.lives <= 0) { s.over = true; if (s.score > hi()) setHi(s.score); }
        else reset(s, false);
      }
      if (s.win && s.score > hi()) setHi(s.score);
    } else if (!s.started) {
      s.ball.x = s.paddle.x + BRK.PAD_W / 2;
    }
    render(s);
    if (s.canvas.isConnected) raf = requestAnimationFrame(loop);
  }
  function render(s) {
    var ctx = s.ctx;
    ctx.clearRect(0, 0, BRK.W, BRK.H);
    ctx.fillStyle = '#0c0e12'; ctx.fillRect(0, 0, BRK.W, BRK.H);
    for (var i = 0; i < s.bricks.length; i++) { var br = s.bricks[i]; if (!br.alive) continue; ctx.fillStyle = br.color; ctx.fillRect(br.x, br.y, br.w, br.h); }
    ctx.fillStyle = '#cbd2dc'; ctx.fillRect(s.paddle.x, BRK.H - 18, BRK.PAD_W, BRK.PAD_H);
    ctx.beginPath(); ctx.arc(s.ball.x, s.ball.y, s.ball.r, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.fillStyle = 'rgba(203,210,220,0.85)'; ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left'; ctx.fillText('SCORE ' + s.score, 6, 16);
    ctx.textAlign = 'right'; ctx.fillText('♥'.repeat(Math.max(0, s.lives)), BRK.W - 6, 16);
    var msg = document.getElementById('game-msg');
    if (msg) msg.textContent = s.over ? 'Game over — Space to retry' : s.win ? 'You win! — Space to play again' : s.started ? '' : 'Click / Space to launch';
    var hiEl = document.getElementById('game-hi'); if (hiEl) hiEl.textContent = 'HI ' + Math.max(hi(), s.score);
  }
  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (game && game._key) { try { document.removeEventListener('keydown', game._key, true); } catch (e) {} }
    game = null;
  }
  function close() {
    stop();
    var p = document.getElementById('game-panel');
    if (p) p.remove();
    try { Cade.editor.focus(); } catch (e) {}
  }
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById('game-panel')) { close(); return; }
    var body = '<canvas id="game-canvas" class="brk-canvas" width="' + BRK.W + '" height="' + BRK.H + '"></canvas>' +
      '<div class="brk-status"><span id="game-msg">Click / Space to launch</span><span id="game-hi"></span></div>';
    var p = Cade.mkPanel('game-panel', '▥ Breakout', body);
    p._onClose = stop;
    var canvas = document.getElementById('game-canvas');
    var ctx = canvas.getContext('2d');
    var s = {
      canvas: canvas, ctx: ctx,
      paddle: { x: (BRK.W - BRK.PAD_W) / 2 },
      ball: { x: BRK.W / 2, y: BRK.H - 24, vx: 0, vy: 0, r: BRK.BALL_R },
      bricks: [], score: 0, lives: 3, started: false, over: false, win: false,
    };
    initBricks(s);
    game = s;
    var movePaddle = function (clientX) {
      var r = canvas.getBoundingClientRect();
      var scale = BRK.W / r.width;
      s.paddle.x = Math.max(0, Math.min(BRK.W - BRK.PAD_W, (clientX - r.left) * scale - BRK.PAD_W / 2));
      if (!s.started) s.ball.x = s.paddle.x + BRK.PAD_W / 2;
    };
    canvas.addEventListener('pointermove', function (e) { movePaddle(e.clientX); });
    canvas.addEventListener('pointerdown', function (e) { e.preventDefault(); movePaddle(e.clientX); launch(s); });
    s._key = function (e) {
      if (!document.getElementById('game-panel')) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); launch(s); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); s.paddle.x = Math.max(0, s.paddle.x - 26); if (!s.started) s.ball.x = s.paddle.x + BRK.PAD_W / 2; }
      else if (e.key === 'ArrowRight') { e.preventDefault(); s.paddle.x = Math.min(BRK.W - BRK.PAD_W, s.paddle.x + 26); if (!s.started) s.ball.x = s.paddle.x + BRK.PAD_W / 2; }
    };
    document.addEventListener('keydown', s._key, true);
    render(s);
    if (!raf) raf = requestAnimationFrame(loop);
  }

  Cade.registerWidget({
    name: 'Breakout',
    description: 'A quick retro brick-breaker break — Esc to bail',
    icon: '▥',
    tags: 'game,arcade,break,retro,brick,fun',
    open: open,
  });
})();
