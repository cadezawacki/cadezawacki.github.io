/* Breakout — a low-key retro brick-breaker widget for Cade.txt.
 * Loaded on demand by the module loader; registers itself via window.Cade.
 * Paddle: mouse / drag / arrow keys. Click or Space to launch. Esc bails out.
 * Broken bricks sometimes drop powerup capsules — catch them with the paddle:
 * W wide · M multi-ball · S slow · L +life · F fireball · N narrow (the bad one).
 * Timed effects count down in game frames (~60/s), so they freeze with the
 * ball on minimize and never leave a timer running after close.
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
  var FPS = 60;                         // effect timers tick per frame, like the physics
  var DROP_CHANCE = 0.15, CAP_W = 24, CAP_H = 11, CAP_SPEED = 1.5, MAX_CAPS = 4, MAX_BALLS = 12, MAX_LIVES = 6;
  // k: effect key · t: duration in frames (0 = instant) · w: drop weight · bad: shown dim in the HUD
  var POWERUPS = [
    { k: 'W', name: 'wide',   t: 12 * FPS, w: 20 },
    { k: 'M', name: 'multi',  t: 0,        w: 15 },
    { k: 'S', name: 'slow',   t: 10 * FPS, w: 18 },
    { k: 'L', name: 'life',   t: 0,        w: 7 },
    { k: 'F', name: 'fire',   t: 6 * FPS,  w: 12 },
    { k: 'N', name: 'narrow', t: 10 * FPS, w: 18, bad: true },
  ];
  var PU = {}; POWERUPS.forEach(function (p) { PU[p.k] = p; });
  var PU_WEIGHT = POWERUPS.reduce(function (a, p) { return a + p.w; }, 0);
  var HUD_ORDER = ['W', 'N', 'S', 'F'];

  // Capsule colours come from the app's theme variables (the playfield itself
  // stays dark in both themes, so the dark-theme hues read well either way).
  function palette() {
    var cs = null;
    try { cs = getComputedStyle(document.documentElement); } catch (e) {}
    var v = function (n, d) { var x = cs ? cs.getPropertyValue(n) : ''; return (x && x.trim()) || d; };
    return {
      W: v('--accent', '#0f9598'), M: v('--success', '#4ade80'), S: '#60a5fa',
      L: v('--error', '#f87171'), F: v('--warning', '#f59e0b'), N: '#a78bfa',
      mono: v('--font-mono', 'ui-monospace, monospace'),
    };
  }

  function hi() { try { return parseInt(Cade.store.get('cade-game-breakout-hi') || '0', 10) || 0; } catch (e) { return 0; } }
  function setHi(v) { try { Cade.store.set('cade-game-breakout-hi', String(v)); } catch (e) {} }

  function initBricks(s) {
    s.bricks = []; s.left = BRK.ROWS * BRK.COLS;
    var gap = 3, w = (BRK.W - gap) / BRK.COLS;
    for (var r = 0; r < BRK.ROWS; r++)
      for (var c = 0; c < BRK.COLS; c++)
        s.bricks.push({ x: c * w + gap, y: BRK.TOP + r * (BRK.BRICK_H + gap), w: w - gap, h: BRK.BRICK_H, color: COLORS[r % COLORS.length], alive: true });
  }
  function newBall(s) { return { x: s.paddle.x + s.padW / 2, y: BRK.H - 24, vx: 0, vy: 0, r: BRK.BALL_R }; }
  // Drop every capsule and timed effect, back to one ball on the paddle.
  function clearPowerups(s) {
    s.caps = []; s.fx = { W: 0, N: 0, S: 0, F: 0 }; s.flash = null;
    setPadW(s, BRK.PAD_W);
  }
  function setPadW(s, w) {
    var mid = s.paddle.x + s.padW / 2;
    s.padW = w;
    s.paddle.x = Math.max(0, Math.min(BRK.W - w, mid - w / 2));
  }
  function padTarget(s) { return BRK.PAD_W * (s.fx.W > 0 ? 1.6 : s.fx.N > 0 ? 0.65 : 1); }
  function reset(s, full) {
    clearPowerups(s);
    s.balls = [newBall(s)];
    s.started = false;
    if (full) { s.score = 0; s.lives = 3; s.over = false; s.win = false; initBricks(s); }
  }
  function launch(s) {
    if (s.over || s.win) reset(s, true);
    if (s.started) return;
    s.started = true;
    var b = s.balls[0];
    b.vx = (Math.random() < 0.5 ? -1 : 1) * 2.2;
    b.vy = -3.2;
    if (!raf) raf = requestAnimationFrame(loop);
  }
  function maybeDrop(s, br) {
    if (s.caps.length >= MAX_CAPS || Math.random() >= DROP_CHANCE) return;
    var roll = Math.random() * PU_WEIGHT, p = POWERUPS[POWERUPS.length - 1];
    for (var i = 0; i < POWERUPS.length; i++) { roll -= POWERUPS[i].w; if (roll < 0) { p = POWERUPS[i]; break; } }
    s.caps.push({ k: p.k, x: br.x + br.w / 2 - CAP_W / 2, y: br.y + br.h / 2 - CAP_H / 2 });
  }
  function applyPowerup(s, k) {
    var p = PU[k];
    if (k === 'M') {
      var out = [];
      for (var i = 0; i < s.balls.length; i++) {
        var b = s.balls[i], sp = Math.hypot(b.vx, b.vy) || 3.2, a = Math.atan2(b.vy, b.vx);
        out.push(b);
        for (var j = -1; j <= 1; j += 2) {
          if (s.balls.length + out.length - i - 1 >= MAX_BALLS) break;
          var na = a + j * 0.4;
          out.push({ x: b.x, y: b.y, vx: sp * Math.cos(na), vy: sp * Math.sin(na), r: b.r });
        }
      }
      s.balls = out.slice(0, MAX_BALLS);
    } else if (k === 'L') {
      s.lives = Math.min(MAX_LIVES, s.lives + 1);
    } else {
      s.fx[k] = p.t;                              // re-catching refreshes the duration
      if (k === 'W') s.fx.N = 0; else if (k === 'N') s.fx.W = 0;  // wide and narrow cancel out
      setPadW(s, padTarget(s));
    }
    s.flash = { k: k, t: 40 };
  }
  function stepBall(s, b, slow) {
    b.x += b.vx * slow; b.y += b.vy * slow;
    if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
    if (b.x + b.r > BRK.W) { b.x = BRK.W - b.r; b.vx = -Math.abs(b.vx); }
    if (b.y - b.r < 0) { b.y = b.r; b.vy = Math.abs(b.vy); }
    var py = BRK.H - 18, pw = s.padW;
    if (b.vy > 0 && b.y + b.r >= py && b.y + b.r <= py + BRK.PAD_H + 6 && b.x >= s.paddle.x - b.r && b.x <= s.paddle.x + pw + b.r) {
      b.y = py - b.r;
      var hit = Math.max(-1, Math.min(1, (b.x - (s.paddle.x + pw / 2)) / (pw / 2)));
      var speed = Math.min(6, Math.hypot(b.vx, b.vy) + 0.05);
      var ang = hit * 1.0;
      b.vx = speed * Math.sin(ang);
      b.vy = -Math.abs(speed * Math.cos(ang));
    }
    var fire = s.fx.F > 0;
    for (var i = 0; i < s.bricks.length; i++) {
      var br = s.bricks[i];
      if (!br.alive) continue;
      if (b.x + b.r > br.x && b.x - b.r < br.x + br.w && b.y + b.r > br.y && b.y - b.r < br.y + br.h) {
        br.alive = false; s.score += 10; s.left--;
        maybeDrop(s, br);
        if (fire) continue;                       // fireball ploughs straight through
        var overlapX = Math.min(b.x + b.r - br.x, br.x + br.w - (b.x - b.r));
        var overlapY = Math.min(b.y + b.r - br.y, br.y + br.h - (b.y - b.r));
        if (overlapX < overlapY) b.vx = -b.vx; else b.vy = -b.vy;
        break;
      }
    }
  }
  function loop() {
    raf = 0;
    var s = game;
    if (!s || !s.canvas || !s.canvas.isConnected) { game = null; return; }
    if (s.started && !s.over && !s.win) {
      var slow = s.fx.S > 0 ? 0.65 : 1, i;
      // Timed effects: tick down; when wide/narrow lapses, the paddle snaps back.
      for (i = 0; i < HUD_ORDER.length; i++) {
        var k = HUD_ORDER[i];
        if (s.fx[k] > 0 && --s.fx[k] === 0 && (k === 'W' || k === 'N')) setPadW(s, padTarget(s));
      }
      if (s.flash && --s.flash.t <= 0) s.flash = null;
      for (i = 0; i < s.balls.length; i++) stepBall(s, s.balls[i], slow);
      // Capsules fall steadily; caught ones apply, missed ones vanish off the bottom.
      var py = BRK.H - 18, keep = [];
      for (i = 0; i < s.caps.length; i++) {
        var c = s.caps[i];
        c.y += CAP_SPEED;
        if (c.y + CAP_H >= py && c.y <= py + BRK.PAD_H && c.x + CAP_W >= s.paddle.x && c.x <= s.paddle.x + s.padW) applyPowerup(s, c.k);
        else if (c.y < BRK.H) keep.push(c);
      }
      s.caps = keep;
      if (s.left <= 0) s.win = true;
      // A life is lost only when the last ball drops out.
      var alive = s.balls.filter(function (b) { return b.y - b.r <= BRK.H; });
      if (alive.length) s.balls = alive;
      else {
        s.lives--;
        if (s.lives <= 0) { s.over = true; clearPowerups(s); if (s.score > hi()) setHi(s.score); }
        else reset(s, false);
      }
      if (s.win) { clearPowerups(s); if (s.score > hi()) setHi(s.score); }
    } else if (!s.started) {
      s.balls[0].x = s.paddle.x + s.padW / 2;
    }
    render(s);
    if (s.canvas.isConnected) raf = requestAnimationFrame(loop);
  }
  function render(s) {
    var ctx = s.ctx;
    ctx.clearRect(0, 0, BRK.W, BRK.H);
    ctx.fillStyle = '#0c0e12'; ctx.fillRect(0, 0, BRK.W, BRK.H);
    var i;
    for (i = 0; i < s.bricks.length; i++) { var br = s.bricks[i]; if (!br.alive) continue; ctx.fillStyle = br.color; ctx.fillRect(br.x, br.y, br.w, br.h); }
    var pal = s.pal, mono = pal.mono;
    // Capsules: small rounded pills with a monospace letter.
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 9px ' + mono;
    for (i = 0; i < s.caps.length; i++) {
      var c = s.caps[i];
      pill(ctx, c.x, c.y, CAP_W, CAP_H); ctx.fillStyle = pal[c.k]; ctx.fill();
      ctx.fillStyle = '#0c0e12'; ctx.fillText(c.k, c.x + CAP_W / 2, c.y + CAP_H / 2 + 0.5);
    }
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = s.fx.W > 0 ? pal.W : s.fx.N > 0 ? pal.N : '#cbd2dc';
    ctx.fillRect(s.paddle.x, BRK.H - 18, s.padW, BRK.PAD_H);
    var fire = s.fx.F > 0;
    ctx.fillStyle = fire ? pal.F : '#fff';
    for (i = 0; i < s.balls.length; i++) {
      var b = s.balls[i];
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
    }
    if (fire) {
      ctx.globalAlpha = 0.3;
      for (i = 0; i < s.balls.length; i++) { ctx.beginPath(); ctx.arc(s.balls[i].x - s.balls[i].vx, s.balls[i].y - s.balls[i].vy, s.balls[i].r + 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = 'rgba(203,210,220,0.85)'; ctx.font = '11px ' + mono;
    ctx.textAlign = 'left'; ctx.fillText('SCORE ' + s.score, 6, 16);
    ctx.textAlign = 'right'; ctx.fillText('♥'.repeat(Math.max(0, s.lives)), BRK.W - 6, 16);
    // HUD: active timed effects as "W 9" chips in the middle of the top bar.
    var chips = [];
    for (i = 0; i < HUD_ORDER.length; i++) if (s.fx[HUD_ORDER[i]] > 0) chips.push(HUD_ORDER[i]);
    if (chips.length) {
      ctx.font = '10px ' + mono; ctx.textAlign = 'center';
      var cw = 30, x0 = BRK.W / 2 - (chips.length * cw) / 2;
      for (i = 0; i < chips.length; i++) {
        var k = chips[i], secs = Math.ceil(s.fx[k] / FPS);
        ctx.globalAlpha = s.fx[k] < 2 * FPS && (s.fx[k] >> 3) % 2 ? 0.45 : 1;  // blink as it runs out
        ctx.fillStyle = pal[k]; ctx.fillText(k + ' ' + secs, x0 + cw * i + cw / 2, 16);
      }
      ctx.globalAlpha = 1;
    }
    if (s.flash) {
      ctx.globalAlpha = Math.min(1, s.flash.t / 20);
      ctx.font = 'bold 12px ' + mono; ctx.textAlign = 'center'; ctx.fillStyle = pal[s.flash.k];
      ctx.fillText(PU[s.flash.k].name.toUpperCase() + (s.flash.k === 'M' ? ' ×3' : s.flash.k === 'L' ? ' +1' : ''), BRK.W / 2, BRK.H - 40);
      ctx.globalAlpha = 1;
    }
    var msg = document.getElementById('game-msg');
    if (msg) msg.textContent = s.over ? 'Game over — Space to retry' : s.win ? 'You win! — Space to play again' : s.started ? '' : 'Click / Space to launch';
    var hiEl = document.getElementById('game-hi'); if (hiEl) hiEl.textContent = 'HI ' + Math.max(hi(), s.score);
  }
  function pill(ctx, x, y, w, h) {
    var r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
    ctx.closePath();
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
      paddle: { x: (BRK.W - BRK.PAD_W) / 2 }, padW: BRK.PAD_W,
      balls: [], caps: [], fx: { W: 0, N: 0, S: 0, F: 0 }, flash: null, pal: palette(),
      bricks: [], left: 0, score: 0, lives: 3, started: false, over: false, win: false,
    };
    reset(s, true);
    game = s;
    var movePaddle = function (clientX) {
      var r = canvas.getBoundingClientRect();
      var scale = BRK.W / r.width;
      s.paddle.x = Math.max(0, Math.min(BRK.W - s.padW, (clientX - r.left) * scale - s.padW / 2));
      if (!s.started) s.balls[0].x = s.paddle.x + s.padW / 2;
    };
    canvas.addEventListener('pointermove', function (e) { movePaddle(e.clientX); });
    canvas.addEventListener('pointerdown', function (e) { e.preventDefault(); movePaddle(e.clientX); launch(s); });
    s._key = function (e) {
      if (!document.getElementById('game-panel')) return;
      if (Cade.isMinimized && Cade.isMinimized(p)) return; // parked in the dock: keys belong to the editor
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); launch(s); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); s.paddle.x = Math.max(0, s.paddle.x - 26); if (!s.started) s.balls[0].x = s.paddle.x + s.padW / 2; }
      else if (e.key === 'ArrowRight') { e.preventDefault(); s.paddle.x = Math.min(BRK.W - s.padW, s.paddle.x + 26); if (!s.started) s.balls[0].x = s.paddle.x + s.padW / 2; }
    };
    document.addEventListener('keydown', s._key, true);
    // Minimized: freeze the ball; restore picks up on the same frame.
    p.addEventListener('cade-panel-minimize', function () { if (raf) { cancelAnimationFrame(raf); raf = 0; } });
    p.addEventListener('cade-panel-restore', function () { if (game === s && !raf) raf = requestAnimationFrame(loop); });
    render(s);
    if (!raf) raf = requestAnimationFrame(loop);
  }

  Cade.registerWidget({
    name: 'Breakout',
    description: 'A quick retro brick-breaker break with falling powerups — Esc to bail',
    icon: '▥',
    tags: 'game,arcade,break,retro,brick,fun',
    open: open,
  });
})();
