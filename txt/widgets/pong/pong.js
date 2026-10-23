/* Pong — retro two-paddle tennis for Cade.txt.
 * vs CPU (Easy / Normal / Hard) or two players on one keyboard / one phone.
 * Wide panels get a landscape court; tall ones (a phone in portrait) rotate it
 * so P1 plays from the bottom and P2 from the top. Physics runs in court units
 * with delta-time substeps, so even a top-speed ball can't tunnel a paddle.
 * Keys: W/S + ↑/↓ (portrait court: A/D + ←/→) · P pause · Esc pause / close.
 * Touch: drag anywhere on your half. First to 7 (or 11); wins kept per level. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('pong.css');

  // ---- court geometry & tuning (court units: x runs paddle→paddle, y across) ----
  var L = 480, W = 300, R = 5;                  // court length / width, ball half-size
  var PAD_LEN = 56, PAD_T = 8, PAD_INSET = 14, HALF = PAD_LEN / 2, REACH = HALF + R;
  var FACE1 = PAD_INSET + PAD_T, FACE2 = L - PAD_INSET - PAD_T;   // paddle front faces
  var SERVE_V = 260, HIT_DV = 22, MAX_V = 800;   // ball speed: serve, +per paddle hit, cap
  var MAX_ANGLE = 1.0;                           // launch angle off the paddle tip (rad)
  var ENGLISH = 0.0004, ENGLISH_MAX = 0.2;       // a moving paddle steepens the return…
  var SPIN_K = 0.4, SPIN_MAX = 260, SPIN_DECAY = 1.4; // …and curves it (decaying side accel)
  var KEY_V = 430, KEY_ACC = 5200, TOUCH_V = 1400;
  var MAX_STEP = 3;                              // max ball travel per substep (< PAD_T)
  var SERVE_T = 1.8, POINT_T = 0.75, RESUME_T = 0.9;
  // CPU personalities. Misses come from human-like limits — reaction delay, a
  // per-approach aiming error that swells with ball speed (plus a rare misread),
  // a top paddle speed, and (below Hard) reading a curving ball as a straight
  // line until it looks again. Tuned headlessly: each level reliably beats the
  // one below, and a scripted "casual player" wins ~99% / ~60% / ~13% of matches.
  var DIFFS = {
    easy: { label: 'Easy', react: 0.3, maxV: 230, err: 45, blunder: 0.3, spin: false, replan: 0.34, aim: 0 },
    normal: { label: 'Normal', react: 0.19, maxV: 320, err: 30, blunder: 0.15, spin: false, replan: 0.2, aim: 0.25 },
    hard: { label: 'Hard', react: 0.11, maxV: 420, err: 20, blunder: 0.06, spin: true, replan: 0.1, aim: 0.5 }
  };
  var DIFF_KEYS = ['easy', 'normal', 'hard'];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ================= engine (pure: no DOM — unit-checked in node) =================
  function newPaddle() { return { y: W / 2, vy: 0, kv: 0, dir: 0, target: null, cap: TOUCH_V }; }
  function newGame(opts) {
    var g = {
      mode: opts.mode || 'cpu', to: opts.to || 7,
      p1: newPaddle(), p2: newPaddle(),
      ball: { x: L / 2, y: W / 2, vx: 0, vy: 0, speed: SERVE_V, spin: 0 },
      s1: 0, s2: 0, phase: 'serve', timer: SERVE_T, digit: 0, serveTo: 1, rally: 0, winner: 0,
      ai: null, events: []
    };
    return g;
  }

  function movePaddle(p, h) {
    var y0 = p.y;
    if (p.dir) {
      // Keyboard: a very short ramp so a tap nudges and a hold sweeps.
      var dv = p.dir * KEY_V - p.kv, a = KEY_ACC * h;
      p.kv += clamp(dv, -a, a);
      p.y += p.kv * h;
    } else {
      p.kv = 0;
      if (p.target != null) { var m = p.cap * h; p.y += clamp(p.target - p.y, -m, m); }
    }
    p.y = clamp(p.y, HALF, W - HALF);
    p.vy = h > 0 ? (p.y - y0) / h : 0;
  }

  // Swept test against a paddle face: did the ball's leading edge cross the
  // face during this substep, and was the paddle there at the crossing point?
  function hitTest(g, p, px, py, side) {
    var b = g.ball, face = side === 1 ? FACE1 : FACE2, dir = side === 1 ? 1 : -1;
    var lead = b.x - dir * R, prevLead = px - dir * R, yAt;
    var before = side === 1 ? prevLead >= face : prevLead <= face;
    var after = side === 1 ? lead < face : lead > face;
    if (before && after) yAt = py + (b.y - py) * ((prevLead - face) / (prevLead - lead));
    else if (!before && (side === 1 ? lead > face - PAD_T : lead < face + PAD_T)) yAt = b.y; // paddle slid onto it
    else return false;
    if (Math.abs(yAt - p.y) > REACH) return false;
    var off = clamp((yAt - p.y) / REACH, -1, 1);
    var ang = off * MAX_ANGLE + clamp(p.vy * ENGLISH, -ENGLISH_MAX, ENGLISH_MAX);
    ang = clamp(ang, -MAX_ANGLE - 0.1, MAX_ANGLE + 0.1);
    b.speed = Math.min(MAX_V, b.speed + HIT_DV);
    b.vx = dir * b.speed * Math.cos(ang);
    b.vy = b.speed * Math.sin(ang);
    b.spin = clamp(p.vy * SPIN_K, -SPIN_MAX, SPIN_MAX);
    b.x = face + dir * R; b.y = clamp(yAt, R, W - R);
    g.rally++;
    g.events.push(side === 1 ? 'hit1' : 'hit2');
    return true;
  }

  function stepBall(g, h) {
    var b = g.ball, px = b.x, py = b.y;
    if (b.spin) {
      b.vy += b.spin * h;
      b.spin *= Math.exp(-SPIN_DECAY * h);
      if (Math.abs(b.spin) < 1) b.spin = 0;
    }
    // A curving ball must keep travelling paddle→paddle, not ping wall to wall.
    var lim = Math.abs(b.vx) * 2;
    if (b.vy > lim) b.vy = lim; else if (b.vy < -lim) b.vy = -lim;
    b.x += b.vx * h; b.y += b.vy * h;
    if (b.y < R) { b.y = 2 * R - b.y; b.vy = Math.abs(b.vy); b.spin = -b.spin * 0.6; g.events.push('wall'); }
    else if (b.y > W - R) { b.y = 2 * (W - R) - b.y; b.vy = -Math.abs(b.vy); b.spin = -b.spin * 0.6; g.events.push('wall'); }
    if (b.vx < 0) hitTest(g, g.p1, px, py, 1);
    else if (b.vx > 0) hitTest(g, g.p2, px, py, 2);
    if (b.x < -2 * R) point(g, 2);
    else if (b.x > L + 2 * R) point(g, 1);
  }

  function point(g, who) {
    var b = g.ball;
    if (who === 1) g.s1++; else g.s2++;
    b.vx = b.vy = b.spin = 0;
    g.serveTo = who === 1 ? 2 : 1;               // the player who conceded receives
    g.events.push('score' + who);
    if (g.s1 >= g.to || g.s2 >= g.to) { g.phase = 'over'; g.winner = who; g.events.push('win'); }
    else { g.phase = 'point'; g.timer = POINT_T; }
  }

  function placeServe(g, rnd) {
    var b = g.ball;
    b.x = L / 2; b.y = W / 2 + (rnd() * 2 - 1) * W * 0.22;
    b.vx = b.vy = b.spin = 0; b.speed = SERVE_V;
    g.phase = 'serve'; g.timer = SERVE_T; g.digit = 0;
  }
  function serve(g, rnd) {
    var b = g.ball, dir = g.serveTo === 1 ? -1 : 1, ang = (rnd() * 2 - 1) * 0.42;
    b.speed = SERVE_V;
    b.vx = dir * SERVE_V * Math.cos(ang); b.vy = SERVE_V * Math.sin(ang); b.spin = 0;
    g.rally = 0; g.phase = 'play';
    g.events.push('go');
  }

  // Advance the match by dt seconds. `frozen` keeps the ball still (resume
  // countdown) while paddles stay live so players can line up.
  function update(g, dt, rnd, frozen) {
    if (g.phase === 'over' || dt <= 0) return;
    if (g.ai) g.ai.think(g, dt);
    if (g.phase === 'point') {
      g.timer -= dt;
      if (g.timer <= 0) placeServe(g, rnd);
    } else if (g.phase === 'serve') {
      g.timer -= dt;
      var d = Math.max(0, Math.ceil(g.timer / (SERVE_T / 3)));
      if (d !== g.digit && d > 0) g.events.push('tick');
      g.digit = d;
      if (g.timer <= 0) serve(g, rnd);
    }
    var b = g.ball, live = g.phase === 'play' && !frozen;
    var dist = live ? Math.sqrt(b.vx * b.vx + b.vy * b.vy) * dt : 0;
    var n = Math.min(120, Math.max(1, Math.ceil(dist / MAX_STEP)));
    var h = dt / n;
    for (var i = 0; i < n; i++) {
      movePaddle(g.p1, h); movePaddle(g.p2, h);
      if (live && g.phase === 'play') stepBall(g, h);
    }
  }

  // Where will the ball's centre be when its leading edge reaches `face`?
  // Simulates walls (and optionally the curve) — the same physics, coarser step.
  var PRED_H = 1 / 240, PRED_DECAY = Math.exp(-SPIN_DECAY * PRED_H);
  function predictY(b, face, withSpin) {
    var x = b.x, y = b.y, vx = b.vx, vy = b.vy, sp = withSpin ? b.spin : 0;
    if (!vx) return null;
    var lead = vx < 0 ? -R : R;
    if (vx < 0 ? x + lead <= face : x + lead >= face) return y;
    for (var i = 0; i < 4000; i++) {
      if (sp) { vy += sp * PRED_H; sp *= PRED_DECAY; if (Math.abs(sp) < 1) sp = 0; }
      var lim = Math.abs(vx) * 2;
      if (vy > lim) vy = lim; else if (vy < -lim) vy = -lim;
      var nx = x + vx * PRED_H, ny = y + vy * PRED_H;
      if (vx < 0 ? nx + lead <= face : nx + lead >= face) {
        ny = y + (ny - y) * ((face - lead - x) / (nx - x));   // exact crossing within the step
        return ny < R ? 2 * R - ny : ny > W - R ? 2 * (W - R) - ny : ny;
      }
      x = nx; y = ny;
      if (y < R) { y = 2 * R - y; vy = Math.abs(vy); sp = -sp * 0.6; }
      else if (y > W - R) { y = 2 * (W - R) - y; vy = -Math.abs(vy); sp = -sp * 0.6; }
    }
    return y;
  }

  function Ai(diff, side, rnd) {
    this.cfg = DIFFS[diff] || DIFFS.normal; this.side = side; this.rnd = rnd || Math.random;
    this.tracking = false; this.wait = 0; this.replan = 0; this.err = 0; this.aimOff = 0;
  }
  Ai.prototype.think = function (g, dt) {
    var c = this.cfg, me = this.side === 1 ? g.p1 : g.p2, opp = this.side === 1 ? g.p2 : g.p1, b = g.ball;
    var toward = g.phase === 'play' && (this.side === 1 ? b.vx < 0 : b.vx > 0);
    if (!toward) {
      // Off duty: drift back toward the middle, loosely shadowing the ball.
      this.tracking = false;
      me.cap = c.maxV * 0.55;
      me.target = W / 2 + (b.y - W / 2) * 0.3;
      return;
    }
    me.cap = c.maxV;
    if (!this.tracking) {
      this.tracking = true;
      this.wait = c.react * (0.75 + 0.5 * this.rnd());
      // Aiming error swells with ball speed, plus the odd outright misread.
      var sp = b.speed / MAX_V, amp = c.err * (0.35 + 1.65 * sp * sp);
      if (this.rnd() < c.blunder * sp) amp *= 2.5;
      this.err = (this.rnd() * 2 - 1) * amp;
      // Aim: hit off-centre to angle the return away from the opponent.
      var d = c.spin ? (opp.y < W / 2 ? 1 : -1) : (this.rnd() < 0.5 ? 1 : -1);
      this.aimOff = -d * c.aim * REACH * (0.6 + 0.4 * this.rnd());
      this.replan = 0;
    }
    if (this.wait > 0) { this.wait -= dt; return; }   // still "seeing" the shot leave
    this.replan -= dt;
    if (this.replan > 0) return;
    this.replan = c.replan;
    var y = predictY(b, this.side === 1 ? FACE1 : FACE2, c.spin);
    if (y != null) me.target = y + this.err + this.aimOff;
  };

  // ================= UI =================
  var STATS_KEY = 'cade-game-pong-stats', PREFS_KEY = 'cade-game-pong-prefs';
  var S = null;   // the live session (one panel at a time)

  function loadJSON(k) { try { var v = JSON.parse(Cade.store.get(k) || 'null'); return v && typeof v === 'object' ? v : null; } catch (e) { return null; } }
  function saveJSON(k, v) { try { Cade.store.set(k, JSON.stringify(v)); } catch (e) {} }
  function loadPrefs() {
    var p = loadJSON(PREFS_KEY) || {};
    return {
      mode: p.mode === '2p' ? '2p' : 'cpu',
      diff: DIFFS[p.diff] ? p.diff : 'normal',
      to: p.to === 11 ? 11 : 7,
      sound: p.sound === true
    };
  }
  function loadStats() {
    var s = loadJSON(STATS_KEY) || {}, out = {};
    DIFF_KEYS.forEach(function (d) { var r = s[d] || {}; out[d] = { w: Math.max(0, r.w | 0), l: Math.max(0, r.l | 0) }; });
    return out;
  }

  // Tiny WebAudio blipper. The context is only created from a user gesture
  // (iOS requirement) and closed with the panel.
  function Snd(on) { this.on = !!on; this.ac = null; }
  Snd.prototype.ensure = function () {
    if (!this.on) return;
    if (!this.ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ac = new AC(); } catch (e) { this.ac = null; return; }
    }
    if (this.ac.state === 'suspended') { try { this.ac.resume(); } catch (e) {} }
  };
  Snd.prototype.tone = function (f, dur, type, vol, slide, delay) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;   // 'suspended' just queues until resume()
    try {
      var t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);

  // 3×5 pixel digits for the crisp retro scoreboard.
  var DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
    '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
  function drawNum(c, n, cx, cy, cell) {
    var s = String(n), w = s.length * 4 - 1;
    var x0 = Math.round(cx - w * cell / 2), y0 = Math.round(cy - 2.5 * cell);
    for (var i = 0; i < s.length; i++) {
      var bits = DIGITS[+s.charAt(i)] || DIGITS[0];
      for (var j = 0; j < 15; j++) if (bits.charAt(j) === '1') c.fillRect(x0 + (i * 4 + j % 3) * cell, y0 + ((j / 3) | 0) * cell, cell, cell);
    }
  }

  // Court → device pixels. Portrait rotates the court a quarter turn so P1
  // (x = 0) sits at the bottom and court-y runs left → right.
  function scr(x, y) { return S.portrait ? [y * S.k, (L - x) * S.k] : [x * S.k, y * S.k]; }
  function rectL(x, y, w, h) {
    var k = S.k, sx, sy, sw, sh;
    if (S.portrait) { sx = y * k; sy = (L - x - w) * k; sw = h * k; sh = w * k; }
    else { sx = x * k; sy = y * k; sw = w * k; sh = h * k; }
    var x0 = Math.round(sx), y0 = Math.round(sy);   // snap to device pixels: crisp edges
    S.ctx.fillRect(x0, y0, Math.max(1, Math.round(sx + sw) - x0), Math.max(1, Math.round(sy + sh) - y0));
  }

  function draw() {
    if (!S || !S.ctx) return;
    var c = S.ctx, g = S.g, col = S.col, k = S.k, b = g.ball, i;
    c.fillStyle = col.bg; c.fillRect(0, 0, S.cv.width, S.cv.height);
    c.fillStyle = col.border;
    for (var y = 6; y < W; y += 18) rectL(L / 2 - 1.5, y, 3, 9);
    c.fillStyle = col.faint;
    var cell = Math.max(2, Math.round(k * 5)), a1 = scr(L / 2 - 50, 34), a2 = scr(L / 2 + 50, 34);
    drawNum(c, g.s1, a1[0], a1[1], cell); drawNum(c, g.s2, a2[0], a2[1], cell);
    c.fillStyle = col.accent; rectL(PAD_INSET, g.p1.y - HALF, PAD_T, PAD_LEN);
    c.fillStyle = col.text; rectL(L - PAD_INSET - PAD_T, g.p2.y - HALF, PAD_T, PAD_LEN);
    if (g.phase === 'play') {
      if (!S.rm) {
        for (i = 0; i < S.trail.length; i++) {
          c.globalAlpha = 0.06 + 0.05 * i;
          rectL(S.trail[i][0] - R, S.trail[i][1] - R, 2 * R, 2 * R);
        }
        c.globalAlpha = 1;
      }
      rectL(b.x - R, b.y - R, 2 * R, 2 * R);
    }
    var digit = g.phase === 'serve' ? g.digit : S.hold > 0 ? Math.ceil(S.hold / (RESUME_T / 3)) : 0;
    if (digit > 0 && !S.ovlKind) {
      var m = scr(L / 2, W / 2);
      c.fillStyle = col.bg; var big = Math.max(3, Math.round(k * 7));
      c.fillRect(Math.round(m[0] - 2.5 * big), Math.round(m[1] - 3.5 * big), 5 * big, 7 * big);
      c.fillStyle = col.accent; drawNum(c, digit, m[0], m[1], big);
    }
  }

  // ---- loop ----
  function running() { return !!(S && S.g && !S.paused && !S.ovlKind && S.g.phase !== 'over'); }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) { draw(); return; }
    var dt = S.last ? Math.min(0.05, (ts - S.last) / 1000) : 0;
    S.last = ts;
    var g = S.g;
    if (S.hold > 0) { S.hold = Math.max(0, S.hold - dt); update(g, dt, Math.random, true); }
    else update(g, dt, Math.random, false);
    if (g.phase === 'play') { S.trail.push([g.ball.x, g.ball.y]); if (S.trail.length > 5) S.trail.shift(); }
    else S.trail.length = 0;
    handleEvents();
    draw();
    if (running()) S.raf = requestAnimationFrame(frame);
  }

  function handleEvents() {
    var g = S.g, ev = g.events, snd = S.snd;
    for (var i = 0; i < ev.length; i++) {
      switch (ev[i]) {
        case 'hit1': snd.tone(523, 0.05, 'square', 0.05); break;
        case 'hit2': snd.tone(440, 0.05, 'square', 0.05); break;
        case 'wall': snd.tone(262, 0.035, 'square', 0.035); break;
        case 'tick': snd.tone(660, 0.06, 'square', 0.035); break;
        case 'go': snd.tone(988, 0.08, 'square', 0.04); break;
        case 'score1': case 'score2':
          snd.tone(196, 0.24, 'square', 0.05, 98);
          if (S.coarse) Cade.haptic(18);
          break;
        case 'win':
          if (g.mode === 'cpu') {
            var st = S.stats[S.prefs.diff];
            if (g.winner === 1) st.w++; else st.l++;
            saveJSON(STATS_KEY, S.stats);
          }
          var tune = g.mode === 'cpu' && g.winner === 2 ? [392, 330, 262] : [523, 659, 784, 1047];
          for (var j = 0; j < tune.length; j++) snd.tone(tune[j], 0.12, 'square', 0.045, 0, j * 0.11);
          showOverlay('over');
          break;
      }
    }
    ev.length = 0;
  }

  // ---- pause / overlays ----
  function pause() {
    if (!running()) return;
    S.paused = true; S.held = {}; applyKeys();
    showOverlay('pause');
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    if (S.g.phase === 'play') S.hold = RESUME_T;   // 3-2-1 before the ball moves again
    showOverlay(null);
    kick();
  }
  function togglePause() { if (!S) return; if (S.paused) resume(); else pause(); }

  function seg(attr, val, cur, label) {
    return '<button type="button" class="pong-sb' + (String(val) === String(cur) ? ' on' : '') + '" data-' + attr + '="' + val +
      '" aria-pressed="' + (String(val) === String(cur)) + '">' + label + '</button>';
  }
  function statsHtml() {
    return '<div class="pong-stats" title="Wins–losses vs the CPU">' + DIFF_KEYS.map(function (d) {
      var s = S.stats[d];
      return '<span>' + DIFFS[d].label + ' <b>' + s.w + '–' + s.l + '</b></span>';
    }).join('') + '</div>';
  }
  function overlayHtml(kind) {
    var pr = S.prefs, g = S.g, h = '<div class="pong-card">';
    if (kind === 'pause') {
      return h + '<div class="pong-title">Paused</div><div class="pong-score">' + g.s1 + ' – ' + g.s2 + '</div>' +
        '<button type="button" class="pong-go" data-act="resume">Resume</button>' +
        '<button type="button" class="pong-ghost" data-act="menu">Quit to menu</button></div>';
    }
    if (kind === 'over') {
      var who = g.mode === 'cpu' ? (g.winner === 1 ? 'You win!' : 'CPU wins') : 'Player ' + g.winner + ' wins!';
      h += '<div class="pong-title">' + who + '</div><div class="pong-score">' + g.s1 + ' – ' + g.s2 + '</div>' +
        '<button type="button" class="pong-go" data-act="start">Play again</button>' +
        '<button type="button" class="pong-ghost" data-act="menu">Change settings</button>';
      return h + (g.mode === 'cpu' ? statsHtml() : '') + '</div>';
    }
    h += '<div class="pong-title">PONG</div>' +
      '<div class="pong-row"><span class="pong-lbl">Mode</span><div class="pong-seg">' +
      seg('mode', 'cpu', pr.mode, 'vs CPU') + seg('mode', '2p', pr.mode, '2 players') + '</div></div>';
    if (pr.mode === 'cpu') {
      h += '<div class="pong-row"><span class="pong-lbl">CPU</span><div class="pong-seg">' +
        DIFF_KEYS.map(function (d) { return seg('diff', d, pr.diff, DIFFS[d].label); }).join('') + '</div></div>';
    }
    h += '<div class="pong-row"><span class="pong-lbl">Play to</span><div class="pong-seg">' +
      seg('to', 7, pr.to, '7') + seg('to', 11, pr.to, '11') + '</div></div>' +
      '<button type="button" class="pong-go" data-act="start">Play</button>' +
      (pr.mode === 'cpu' ? statsHtml() : '') + '<div class="pong-keys">' + controlsText() + '</div>';
    return h + '</div>';
  }
  function controlsText() {
    var pr = S.prefs, port = S.portrait;
    if (S.coarse) return pr.mode === 'cpu' ? 'Drag anywhere to move your paddle (teal, ' + (port ? 'bottom' : 'left') + ')' :
      'Each player drags on their own half · teal = ' + (port ? 'bottom' : 'left');
    var k1 = port ? 'A / D' : 'W / S', k2 = port ? '← / →' : '↑ / ↓';
    return pr.mode === 'cpu' ? k1 + ' or ' + k2 + ' (or mouse) · P pause · Esc' :
      'P1 (teal) ' + k1 + ' · P2 ' + k2 + ' · P pause';
  }
  function showOverlay(kind) {
    S.ovlKind = kind;
    S.ovl.innerHTML = kind ? overlayHtml(kind) : '';
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind);
    syncBar();
    draw();
  }
  function syncBar() {
    var pb = S.bar.querySelector('[data-act="pause"]'), sb = S.bar.querySelector('[data-act="sound"]');
    var inGame = S.g && S.g.phase !== 'over' && (S.paused || !S.ovlKind);
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = !inGame;
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.classList.toggle('on', S.snd.on);
    var pr = S.prefs;
    S.hint.textContent = !S.g || S.ovlKind === 'menu' ? 'First to ' + pr.to :
      (pr.mode === 'cpu' ? DIFFS[pr.diff].label + ' CPU' : '2 players') + ' · first to ' + S.g.to;
  }

  function startGame() {
    var pr = S.prefs;
    S.g = newGame({ mode: pr.mode, to: pr.to });
    S.g.ai = pr.mode === 'cpu' ? new Ai(pr.diff, 2, Math.random) : null;
    S.g.serveTo = 1;
    placeServe(S.g, Math.random);
    S.paused = false; S.hold = 0; S.trail = []; S.ptrs = {};
    S.held = {}; applyKeys();
    showOverlay(null);
    kick();
  }
  function toMenu() {
    S.paused = false; S.hold = 0;
    S.g = newGame({ mode: S.prefs.mode, to: S.prefs.to });
    showOverlay('menu');
  }
  function primary() {
    if (S.paused) resume();
    else if (S.ovlKind === 'menu' || S.ovlKind === 'over') startGame();
  }

  // ---- input ----
  var KEY2CODE = { w: 'KeyW', s: 'KeyS', a: 'KeyA', d: 'KeyD', p: 'KeyP', ' ': 'Space', enter: 'Enter', escape: 'Escape',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight' };
  var MOVE = { KeyW: 1, KeyS: 1, KeyA: 1, KeyD: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1 };

  function applyKeys() {
    if (!S || !S.g) return;
    var h = S.held, port = S.portrait;
    // "minus" = toward court y = 0: up on a landscape court, left on a portrait one.
    var n1 = port ? h.KeyA : h.KeyW, p1 = port ? h.KeyD : h.KeyS;
    var n2 = port ? h.ArrowLeft : h.ArrowUp, p2 = port ? h.ArrowRight : h.ArrowDown;
    var d1, d2 = 0;
    if (S.g.mode === 'cpu') d1 = (n1 || n2) ? -1 : (p1 || p2) ? 1 : 0;
    else { d1 = n1 ? -1 : p1 ? 1 : 0; d2 = n2 ? -1 : p2 ? 1 : 0; }
    S.g.p1.dir = d1;
    if (d1) S.g.p1.target = null;
    if (S.g.mode !== 'cpu') { S.g.p2.dir = d2; if (d2) S.g.p2.target = null; }
  }

  function onKey(e) {
    if (!S) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return; // parked in the dock: keys belong to the editor
    if (e.ctrlKey || e.metaKey || e.altKey) return;          // leave app shortcuts alone
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !S.panel.contains(t)) return;
    var code = e.code || KEY2CODE[(e.key || '').toLowerCase()] || '';
    var down = e.type === 'keydown';
    if (code === 'Escape') {
      if (!down) return;
      e.preventDefault();
      if (running()) pause(); else closePanel();
      return;
    }
    if (code === 'KeyP') { e.preventDefault(); if (down && !e.repeat) { S.snd.ensure(); togglePause(); } return; }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      e.preventDefault();
      if (down && !e.repeat) { S.snd.ensure(); primary(); }
      return;
    }
    if (MOVE[code]) {
      e.preventDefault();
      if (down) S.snd.ensure();
      S.held[code] = down;
      applyKeys();
    }
  }

  function toCourt(e) {
    var r = S.cv.getBoundingClientRect();
    var cx = (e.clientX - r.left) / (r.width || 1), cy = (e.clientY - r.top) / (r.height || 1);
    return S.portrait ? { x: (1 - cy) * L, y: cx * W } : { x: cx * L, y: cy * W };
  }
  function steer(side, y) {
    var g = S.g;
    if (!g || (side === 2 && g.mode === 'cpu')) return;
    var p = side === 1 ? g.p1 : g.p2;
    if (p.dir) return;                          // a held key wins
    p.target = clamp(y, HALF, W - HALF); p.cap = TOUCH_V;
  }
  function onPtrDown(e) {
    S.snd.ensure();
    if (!running()) return;
    e.preventDefault();
    var pt = toCourt(e), side = S.g.mode === '2p' && pt.x >= L / 2 ? 2 : 1;
    S.ptrs[e.pointerId] = side;
    try { S.cv.setPointerCapture(e.pointerId); } catch (er) {}
    steer(side, pt.y);
  }
  function onPtrMove(e) {
    if (!running()) return;
    var side = S.ptrs[e.pointerId];
    if (side == null) {
      if (e.pointerType !== 'mouse' || S.g.mode !== 'cpu') return;
      side = 1;                                   // vs CPU on desktop: the mouse just hovers
    }
    steer(side, toCourt(e).y);
  }
  function onPtrUp(e) { if (S) delete S.ptrs[e.pointerId]; }

  // ---- layout / theme ----
  // Height the canvas may use: the viewport minus the panel's real top offset and
  // chrome (title bar, padding, control bar, safe-area padding). Measured, because
  // the header grows by the notch inset in the iOS Home Screen app.
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height) return vh - (vw <= 560 ? 150 : 170);
    var chrome = r.height - (S.stage.offsetHeight || 0);
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 12;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600;
    var aw = Math.max(200, vw - 48), ah = Math.max(170, availH(vw, vh));
    var sL = Math.min(aw / L, ah / W), sP = Math.min(aw / W, ah / L);
    var port = sP > sL * 1.12;                     // rotate only when it buys real size
    var s = Math.min(port ? sP : sL, 1.3);
    var cw = Math.floor((port ? W : L) * s), ch = Math.floor((port ? L : W) * s);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    if (port !== S.portrait) { S.ptrs = {}; S.held = {}; }
    S.portrait = port;
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / (port ? W : L);
    applyKeys();
    if (S.ovlKind === 'menu') S.ovl.innerHTML = overlayHtml('menu');   // control hints mention the orientation
  }
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n, d) { var x = (cs.getPropertyValue(n) || '').trim(); return x || d; }
    S.col = { bg: v('--bg', '#111110'), text: v('--text', '#e7e5e3'), faint: v('--text-faint', '#5c5a58'),
      border: v('--border', '#333231'), accent: v('--accent', '#0f9598') };
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('keyup', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    clearTimeout(s.resizeT);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
  }
  function closePanel() {
    var p = document.getElementById('pong-panel');
    teardown();
    if (p) p.remove();
    // Hand focus back to the editor on desktop only — on a phone it would pop the keyboard.
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }

  function open() {
    Cade.closeAllMenus();
    if (document.getElementById('pong-panel')) { closePanel(); return; }
    var body = '<div class="pong"><div class="pong-stage"><canvas class="pong-cv" aria-label="Pong court"></canvas>' +
      '<div class="pong-ovl"></div></div><div class="pong-bar"><span class="pong-hint"></span>' +
      '<button type="button" class="pong-ib" data-act="sound"></button>' +
      '<button type="button" class="pong-ib" data-act="pause"></button></div></div>';
    var p = Cade.mkPanel('pong-panel', '🏓 Pong', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var prefs = loadPrefs(), mm = window.matchMedia;
    S = {
      panel: p, stage: p.querySelector('.pong-stage'), cv: p.querySelector('.pong-cv'), ovl: p.querySelector('.pong-ovl'),
      bar: p.querySelector('.pong-bar'), hint: p.querySelector('.pong-hint'),
      prefs: prefs, stats: loadStats(), snd: new Snd(prefs.sound),
      rm: false,
      coarse: !!(mm && mm('(pointer: coarse)').matches),
      g: null, raf: 0, last: 0, paused: false, hold: 0, trail: [], ptrs: {}, held: {}, ovlKind: null, portrait: false, k: 1
    };
    S.ctx = S.cv.getContext('2d');
    S.g = newGame({ mode: prefs.mode, to: prefs.to });
    p._onClose = teardown;
    readTheme();
    layout();

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKey, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { pause(); if (S) { S.held = {}; applyKeys(); } };
    window.addEventListener('blur', S.onBlur);
    // Minimized to the dock: pause like a tab switch; the pause card waits after restore.
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) S.onBlur(); });
    S.onResize = function () {
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S) { layout(); draw(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () { if (S) { readTheme(); draw(); } });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    var cv = S.cv;
    cv.addEventListener('pointerdown', onPtrDown);
    cv.addEventListener('pointermove', onPtrMove);
    cv.addEventListener('pointerup', onPtrUp);
    // iOS unlocks WebAudio on touchend rather than touchstart: retry there too.
    cv.addEventListener('pointerup', function () { if (S) S.snd.ensure(); });
    cv.addEventListener('pointercancel', onPtrUp);
    S.ovl.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      S.snd.ensure();
      var pr = S.prefs, d = b.dataset;
      if (d.mode) pr.mode = d.mode;
      else if (d.diff) pr.diff = d.diff;
      else if (d.to) pr.to = +d.to === 11 ? 11 : 7;
      else if (d.act === 'start') { startGame(); return; }
      else if (d.act === 'resume') { resume(); return; }
      else if (d.act === 'menu') { toMenu(); return; }
      else return;
      saveJSON(PREFS_KEY, pr);
      S.g = newGame({ mode: pr.mode, to: pr.to });
      showOverlay('menu');
    });
    S.bar.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      if (b.dataset.act === 'sound') {
        S.snd.on = !S.snd.on;
        S.prefs.sound = S.snd.on;
        saveJSON(PREFS_KEY, S.prefs);
        S.snd.ensure();
        S.snd.tone(660, 0.06, 'square', 0.04);
        syncBar();
      } else if (b.dataset.act === 'pause') togglePause();
      try { b.blur(); } catch (er) {}
    });
    showOverlay('menu');
  }

  Cade.registerWidget({
    name: 'Pong',
    description: 'Retro paddle duel — vs CPU or 2 players on one keyboard / phone',
    icon: '🏓',
    tags: 'game,arcade,fun,train,pong,tennis,paddle,retro,two player,multiplayer',
    open: open,
    // Pure engine, exposed for headless checks (node) — not used by the app.
    _engine: { L: L, W: W, R: R, FACE1: FACE1, FACE2: FACE2, MAX_V: MAX_V, SERVE_V: SERVE_V, DIFFS: DIFFS,
      newGame: newGame, update: update, stepBall: stepBall, predictY: predictY, placeServe: placeServe, serve: serve, Ai: Ai }
  });
})();
