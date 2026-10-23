/* Asteroids — a vector rock-blaster widget for Cade.txt (loaded on demand).
 * Keys: ← → turn · ↑ thrust · Space fire · Shift/H hyperspace · P pause ·
 * Enter start · Esc close. Touch: a thumb pad under the playfield (multi-touch,
 * fingers can slide between buttons). Physics run on a fixed 120 Hz step under
 * a delta-time rAF loop, so 60 and 120 Hz screens play identically. The vector
 * "glow" is wide faint strokes under a thin bright one — shadowBlur is far too
 * slow on iOS canvas to use for every line, every frame. */
(function () {
  'use strict';
  var root = typeof window !== 'undefined' ? window : {};

  // ===== Pure helpers (no DOM) — unit-checked in node via window.__CADE_UNIT__ =====
  var TAU = Math.PI * 2;
  var ROCK_R = [0, 10, 19, 36];        // radius by size class (1 small … 3 large)
  var ROCK_PTS = [0, 100, 50, 20];     // score by size class
  var EXTRA_LIFE = 10000;

  function wrap(v, max) { v %= max; return v < 0 ? v + max : v; }
  // Shortest signed distance along a wrapping axis, so hits work across edges.
  function wrapDelta(d, size) { return d > size / 2 ? d - size : d < -size / 2 ? d + size : d; }

  // Jagged outline. Vertex angles stay monotonic (jitter < half a step), so the
  // polygon is star-shaped about its centre and never self-intersects — which
  // keeps the even-odd point test exact.
  function rockShape(rng, r) {
    var n = 9 + Math.floor(rng() * 5), pts = [], maxR = 0;
    for (var i = 0; i < n; i++) {
      var ang = (i + (rng() - 0.5) * 0.7) / n * TAU;
      var rad = r * (0.72 + rng() * 0.36);
      if (rng() < 0.2) rad *= 0.76;    // the odd deep notch reads as "rock", not "blob"
      pts.push(Math.cos(ang) * rad, Math.sin(ang) * rad);
      if (rad > maxR) maxR = rad;
    }
    return { pts: pts, maxR: maxR };
  }
  function pointInPoly(px, py, pts) {
    var inside = false, n = pts.length;
    for (var i = 0, j = n - 2; i < n; j = i, i += 2) {
      var yi = pts[i + 1], yj = pts[j + 1];
      if ((yi > py) !== (yj > py) && px < (pts[j] - pts[i]) * (py - yi) / (yj - yi) + pts[i]) inside = !inside;
    }
    return inside;
  }
  function makeRock(rng, size, x, y, vx, vy) {
    var sh = rockShape(rng, ROCK_R[size]);
    return { size: size, x: x, y: y, vx: vx, vy: vy, rot: rng() * TAU,
      spin: (rng() - 0.5) * (1.2 + (3 - size) * 0.9), pts: sh.pts, maxR: sh.maxR };
  }
  function rockContains(rk, px, py, W, H) {
    var dx = wrapDelta(px - rk.x, W), dy = wrapDelta(py - rk.y, H);
    if (dx * dx + dy * dy > rk.maxR * rk.maxR) return false;
    var c = Math.cos(rk.rot), s = Math.sin(rk.rot);
    return pointInPoly(dx * c + dy * s, dy * c - dx * s, rk.pts);   // rotate into the rock's frame
  }
  // Large → 2 medium → 2 small → gone. The halves fly apart roughly opposite
  // each other, keep half the parent's drift plus a nudge from the hit, and get
  // a little faster every level.
  function splitRock(rk, rng, level, ix, iy) {
    if (rk.size <= 1) return [];
    var ns = rk.size - 1, out = [], a = rng() * TAU;
    var sp = (ns === 2 ? 48 : 70) * (1 + Math.min(level - 1, 10) * 0.05);
    for (var k = 0; k < 2; k++) {
      var ang = a + k * Math.PI + (rng() - 0.5) * 0.9, v = sp * (0.7 + rng() * 0.6);
      out.push(makeRock(rng, ns,
        rk.x + Math.cos(ang) * ROCK_R[ns] * 0.45, rk.y + Math.sin(ang) * ROCK_R[ns] * 0.45,
        rk.vx * 0.5 + Math.cos(ang) * v + (ix || 0) * 0.03, rk.vy * 0.5 + Math.sin(ang) * v + (iy || 0) * 0.03));
    }
    return out;
  }
  function waveRocks(level) { return Math.min(11, 2 + level * 2); }
  function ufoSpread(level) { return Math.max(0.03, 0.42 - 0.06 * (level - 1)); }
  // Big saucers spray at random; small ones aim — tighter every level, and from
  // level 3 they lead a moving target.
  function ufoAim(u, ship, level, rng, speed, W, H) {
    if (!u.small) return rng() * TAU;
    var dx = wrapDelta(ship.x - u.x, W), dy = wrapDelta(ship.y - u.y, H);
    if (level >= 3) { var t = Math.sqrt(dx * dx + dy * dy) / speed; dx += ship.vx * t; dy += ship.vy * t; }
    return Math.atan2(dy, dx) + (rng() * 2 - 1) * ufoSpread(level);
  }
  function livesEarned(before, after) { return Math.floor(after / EXTRA_LIFE) - Math.floor(before / EXTRA_LIFE); }
  // Ship outline (facing +x): nose, wing, notch, wing.
  var HULL = [12, 0, -8, -7, -5, 0, -8, 7];
  // Hull sample points in world space — the vertices plus the nose→wing edge
  // midpoints, so a rock corner can't slip between samples at ship scale.
  function hullPoints(sh) {
    var c = Math.cos(sh.a), s = Math.sin(sh.a), out = [];
    for (var i = 0; i < HULL.length; i += 2) out.push(sh.x + HULL[i] * c - HULL[i + 1] * s, sh.y + HULL[i] * s + HULL[i + 1] * c);
    out.push((out[0] + out[2]) / 2, (out[1] + out[3]) / 2, (out[0] + out[6]) / 2, (out[1] + out[7]) / 2);
    return out;
  }
  function shipHitsRock(sh, rk, W, H) {
    var p = hullPoints(sh);
    for (var i = 0; i < p.length; i += 2) if (rockContains(rk, p[i], p[i + 1], W, H)) return true;
    return false;
  }
  // Classic respawn rule: wait until the centre is clear instead of dropping
  // the new ship into a rock (it then also gets a short invulnerable blink).
  function spawnClear(x, y, rocks, ufo, shots, W, H) {
    for (var i = 0; i < rocks.length; i++) {
      var rk = rocks[i], dx = wrapDelta(rk.x - x, W), dy = wrapDelta(rk.y - y, H), m = rk.maxR + 52;
      if (dx * dx + dy * dy < m * m) return false;
    }
    if (ufo && Math.abs(ufo.x - x) < 90 && Math.abs(wrapDelta(ufo.y - y, H)) < 90) return false;
    for (i = 0; i < shots.length; i++) {
      if (Math.abs(wrapDelta(shots[i].x - x, W)) < 50 && Math.abs(wrapDelta(shots[i].y - y, H)) < 50) return false;
    }
    return true;
  }
  // The hyperspace gamble: the busier the sky, the likelier the jump fails.
  function hyperRisk(rockCount) { return Math.min(0.25, 0.04 + rockCount * 0.006); }
  // Offsets at which to redraw an object so it reads as continuous across edges.
  function ghosts(x, y, r, W, H) {
    var xs = [0], ys = [0], out = [];
    if (x - r < 0) xs.push(W); else if (x + r > W) xs.push(-W);
    if (y - r < 0) ys.push(H); else if (y + r > H) ys.push(-H);
    for (var i = 0; i < xs.length; i++) for (var j = 0; j < ys.length; j++) out.push(xs[i], ys[j]);
    return out;
  }

  if (root.__CADE_UNIT__) {
    root.__CADE_UNIT__.asteroids = {
      wrap: wrap, wrapDelta: wrapDelta, rockShape: rockShape, pointInPoly: pointInPoly, makeRock: makeRock,
      rockContains: rockContains, splitRock: splitRock, waveRocks: waveRocks, ufoAim: ufoAim, ufoSpread: ufoSpread,
      livesEarned: livesEarned, hullPoints: hullPoints, shipHitsRock: shipHitsRock, spawnClear: spawnClear,
      hyperRisk: hyperRisk, ghosts: ghosts, ROCK_R: ROCK_R, ROCK_PTS: ROCK_PTS
    };
  }
  if (typeof root.Cade === 'undefined') return;

  // ===== Widget =====
  var Cade = root.Cade;
  Cade.loadCSS('asteroids.css');

  var PANEL = 'asteroids-panel', HI_KEY = 'cade-game-asteroids-hi', PREF_KEY = 'cade-game-asteroids-prefs';
  var WW = 400;                               // world width; height is picked per screen at open
  var STEP = 1 / 120;
  var TURN = 4.4, THRUST = 230, DRAG = 0.38, VMAX = 280;
  var SHOT_V = 400, SHOT_LIFE = 0.9, SHOT_CAP = 4, USHOT_V = 210, USHOT_LIFE = 1.5;
  var MINI = HULL.map(function (v) { return v * 0.62; });
  var FLAME = [-6, -3.5, -14, 0, -6, 3.5];
  var KEYS = { arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right', arrowup: 'thrust', w: 'thrust',
    ' ': 'fire', shift: 'hyper', h: 'hyper', arrowdown: 'hyper', s: 'hyper' };
  var rnd = Math.random;
  var reduced = false;
  var S = null;                               // the live game (one panel at a time)
  if (root.__CADE_UNIT__) root.__CADE_UNIT__.asteroidsLive = function () { return S; };   // test-only peek

  function coarse() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  // env(safe-area-inset-bottom) isn't readable from JS directly; measure a probe.
  // Keeps the thumb pad clear of the iPhone home-indicator swipe zone.
  function safeBottom() {
    var d = document.createElement('div'), v = 0;
    d.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;padding-bottom:env(safe-area-inset-bottom, 0px)';
    document.body.appendChild(d);
    try { v = parseFloat(getComputedStyle(d).paddingBottom) || 0; } catch (e) {}
    d.remove();
    return v;
  }
  function loadPrefs() { try { return JSON.parse(Cade.store.get(PREF_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function savePrefs(p) { try { Cade.store.set(PREF_KEY, JSON.stringify(p)); } catch (e) {} }
  function getHi() { try { return parseInt(Cade.store.get(HI_KEY) || '0', 10) || 0; } catch (e) { return 0; } }
  function setHi(v) { try { Cade.store.set(HI_KEY, String(v)); } catch (e) {} }

  // ---- Sound: WebAudio blips, off by default. The context is only created
  // inside a user gesture (iOS refuses to start it otherwise) and is closed
  // with the panel. ----
  function Sfx() { this.on = false; this.ac = null; this.out = null; this.noise = null; this.loops = {}; }
  Sfx.prototype.unlock = function () {
    if (!this.on) return;
    if (!this.ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ac = new AC(); } catch (e) { this.ac = null; return; }
      this.out = this.ac.createGain(); this.out.gain.value = 0.22; this.out.connect(this.ac.destination);
      var n = this.ac.sampleRate | 0, buf = this.ac.createBuffer(1, n, this.ac.sampleRate), d = buf.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
    }
    if (this.ac.state === 'suspended' && this.ac.resume) { try { this.ac.resume(); } catch (e) {} }
  };
  Sfx.prototype.ready = function () { return this.on && this.ac && this.ac.state === 'running' ? this.ac : null; };
  Sfx.prototype.tone = function (f0, f1, dur, type, vol, at) {
    var ac = this.ready(); if (!ac) return;
    var t = ac.currentTime + (at || 0), o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.out); o.start(t); o.stop(t + dur + 0.05);
  };
  Sfx.prototype.hiss = function (dur, vol, freq) {
    var ac = this.ready(); if (!ac) return;
    var t = ac.currentTime, src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = this.noise; f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t); f.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.2), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.out); src.start(t, Math.random() * 0.4); src.stop(t + dur + 0.05);
  };
  // Continuous sounds (thrust rumble, saucer warble) are built once and gated
  // by a gain; hum() is called every step but only touches the graph on change.
  Sfx.prototype.hum = function (name, on, alt) {
    var ac = this.ready(), L = this.loops[name];
    if (!ac) return;
    if (on && !L) L = this.loops[name] = this.makeHum(ac, name);
    if (!L) return;
    if (L.osc && alt != null && L.alt !== alt) { L.alt = alt; L.osc.frequency.setValueAtTime(alt ? 640 : 400, ac.currentTime); }
    var want = on ? L.vol : 0;
    if (L.cur !== want) { L.cur = want; L.g.gain.setTargetAtTime(want, ac.currentTime, 0.04); }
  };
  Sfx.prototype.makeHum = function (ac, name) {
    var g = ac.createGain(), L = { g: g, cur: 0, vol: 0.5, osc: null, alt: null };
    g.gain.value = 0; g.connect(this.out);
    if (name === 'thrust') {
      var src = ac.createBufferSource(), f = ac.createBiquadFilter();
      src.buffer = this.noise; src.loop = true; f.type = 'lowpass'; f.frequency.value = 420;
      src.connect(f); f.connect(g); src.start();
    } else {
      var o = ac.createOscillator(), lfo = ac.createOscillator(), lg = ac.createGain(), f2 = ac.createBiquadFilter();
      o.type = 'square'; o.frequency.value = 400; lfo.frequency.value = 6.5; lg.gain.value = 70;
      f2.type = 'lowpass'; f2.frequency.value = 1500;
      lfo.connect(lg); lg.connect(o.frequency); o.connect(f2); f2.connect(g); o.start(); lfo.start();
      L.osc = o; L.vol = 0.05;
    }
    return L;
  };
  Sfx.prototype.mute = function () {
    for (var k in this.loops) { this.loops[k].cur = 0; try { this.loops[k].g.gain.value = 0; } catch (e) {} }
    if (this.ac && this.ac.suspend) { try { this.ac.suspend(); } catch (e) {} }
  };
  Sfx.prototype.close = function () {
    if (this.ac) { try { var pr = this.ac.close(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {} }
    this.ac = null; this.loops = {};
  };
  Sfx.prototype.fire = function () { this.tone(880, 220, 0.09, 'square', 0.12); };
  Sfx.prototype.ufoFire = function () { this.tone(1300, 500, 0.1, 'square', 0.07); };
  Sfx.prototype.bang = function (size) { this.hiss(0.16 + size * 0.12, 0.55, 2800 - size * 600); };
  Sfx.prototype.die = function () { this.hiss(0.9, 0.6, 1400); this.tone(220, 40, 0.8, 'sawtooth', 0.1); };
  Sfx.prototype.hyper = function () { this.tone(200, 1600, 0.25, 'sine', 0.18); };
  Sfx.prototype.extra = function () { this.tone(660, 0, 0.09, 'square', 0.1); this.tone(880, 0, 0.09, 'square', 0.1, 0.09); this.tone(1320, 0, 0.14, 'square', 0.1, 0.18); };
  Sfx.prototype.beat = function (hi) { this.tone(hi ? 62 : 55, 0, 0.11, 'square', 0.16); };

  // ---- Theme: read the app's CSS variables so the playfield matches light/dark ----
  function palette() {
    var de = document.documentElement, cs = getComputedStyle(de);
    var v = function (n, d) { var x = cs.getPropertyValue(n); return (x && x.trim()) || d; };
    var mono = v('--font-mono', 'ui-monospace, monospace');
    if (de.getAttribute('data-theme') === 'dark') {
      return { bg: v('--bg', '#111110'), ink: v('--text', '#e7e5e3'), dim: v('--text-muted', '#8c8a87'),
        ship: v('--accent-hover', '#12b3b7'), glow: v('--accent-hover', '#12b3b7'), glowA: 0.3,
        ufo: '#f4b45c', hot: v('--error', '#f87171'), mono: mono };
    }
    return { bg: v('--surface-2', '#f5f5f4'), ink: v('--text', '#1c1917'), dim: v('--text-muted', '#78716c'),
      ship: v('--accent', '#0f9598'), glow: v('--accent', '#0f9598'), glowA: 0.17,
      ufo: '#b45f17', hot: v('--error', '#dc2626'), mono: mono };
  }

  // ---- Multi-touch thumb pad. Each pointer is tracked by pointerId and
  // re-hit-tested as it moves, so a thumb can rock between ◀ and ▶ (or slide
  // onto FIRE) without lifting; any number of buttons can be held at once. ----
  function bindPad(pad, onHeld, onPress, onDown) {
    var owner = {}, btns = Array.prototype.slice.call(pad.querySelectorAll('[data-k]')), rects = [];
    function measure() {
      rects = btns.map(function (b) { return { k: b.getAttribute('data-k'), r: b.getBoundingClientRect() }; });
    }
    function keyAt(x, y) {
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i].r;
        if (x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 6 && y <= r.bottom + 6) return rects[i].k;
      }
      return null;
    }
    function sync() {
      var held = {};
      for (var id in owner) if (owner[id]) held[owner[id]] = true;
      btns.forEach(function (b) { b.classList.toggle('on', !!held[b.getAttribute('data-k')]); });
      onHeld(held);
    }
    function set(id, k) {
      var prev = owner[id];
      owner[id] = k;
      if (k && k !== prev) onPress(k);
      sync();
    }
    pad.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (onDown) onDown();
      measure();
      try { pad.setPointerCapture(e.pointerId); } catch (x) {}
      set(e.pointerId, keyAt(e.clientX, e.clientY));
    });
    pad.addEventListener('pointermove', function (e) {
      if (!(e.pointerId in owner)) return;
      var k = keyAt(e.clientX, e.clientY);
      if (k !== owner[e.pointerId]) set(e.pointerId, k);
    });
    function up(e) { if (e.pointerId in owner) { delete owner[e.pointerId]; sync(); } }
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    pad.addEventListener('lostpointercapture', up);
    pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    return { reset: function () { owner = {}; sync(); } };
  }

  // ---- Game state ----
  function deadShip(s) { return { x: s.W / 2, y: s.H / 2, vx: 0, vy: 0, a: -Math.PI / 2, alive: false, inv: 0, hyper: 0, thrust: false }; }
  function newShip(s) { var sh = deadShip(s); sh.alive = true; sh.inv = 2.4; return sh; }
  function spawnRocks(s, n, avoid) {
    for (var i = 0; i < n; i++) {
      var x, y, tries = 0;
      do {   // enter from the edges, never on top of the ship
        if (rnd() < 0.5) { x = rnd() * s.W; y = rnd() < 0.5 ? 2 : s.H - 2; } else { x = rnd() < 0.5 ? 2 : s.W - 2; y = rnd() * s.H; }
      } while (++tries < 20 && avoid && Math.abs(wrapDelta(x - avoid.x, s.W)) < 120 && Math.abs(wrapDelta(y - avoid.y, s.H)) < 120);
      var a = rnd() * TAU, v = (20 + rnd() * 26) * (1 + Math.min(s.level - 1, 10) * 0.05);
      s.rocks.push(makeRock(rnd, 3, x, y, Math.cos(a) * v, Math.sin(a) * v));
    }
  }
  function attract(s) {
    s.state = 'title'; s.level = 1; s.rocks = []; s.shots = []; s.ushots = []; s.ufo = null; s.ship = deadShip(s);
    spawnRocks(s, 5, null);
  }
  function resetGame(s) {
    s.state = 'play'; s.level = 1; s.score = 0; s.lives = 3; s.newHi = false;
    s.rocks = []; s.shots = []; s.ushots = []; s.parts = []; s.ufo = null;
    s.ship = newShip(s); s.fireCD = 0; s.firePress = 0; s.hyperCD = 0; s.hyperPress = false;
    s.respawnT = 0; s.wavePending = false; s.waveT = 0;
    resetUfoTimer(s);
    startWave(s);
    updateBar(s);
  }
  function startWave(s) {
    spawnRocks(s, waveRocks(s.level), s.ship.alive ? s.ship : { x: s.W / 2, y: s.H / 2 });
    s.beatGap = 1.0; s.beatT = 1.0;
    s.msg = 'LEVEL ' + s.level; s.msgT = 1.6;
  }
  function resetUfoTimer(s) { s.ufoT = (13 + rnd() * 10) * Math.max(0.45, 1 - 0.07 * (s.level - 1)); }
  function held(s, k) { return !!(s.kb[k] || s.pad[k]); }

  function addScore(s, n) {
    var before = s.score;
    s.score += n;
    var e = livesEarned(before, s.score);
    if (e > 0) { s.lives = Math.min(9, s.lives + e); s.msg = 'EXTRA SHIP'; s.msgT = 1.4; s.sfx.extra(); }
  }
  function burst(s, x, y, n, col, speed) {
    if (reduced) n = Math.ceil(n / 3);
    for (var i = 0; i < n && s.parts.length < 280; i++) {
      var a = rnd() * TAU, v = speed * (0.3 + rnd() * 0.9), life = 0.45 + rnd() * 0.6;
      s.parts.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: life, max: life, col: col, len: 0, a: 0, spin: 0 });
    }
  }
  function breakRock(s, j, ix, iy, scored) {
    var rk = s.rocks[j];
    s.rocks.splice(j, 1);
    var kids = splitRock(rk, rnd, s.level, ix, iy);
    for (var k = 0; k < kids.length; k++) { kids[k].x = wrap(kids[k].x, s.W); kids[k].y = wrap(kids[k].y, s.H); s.rocks.push(kids[k]); }
    if (scored) addScore(s, ROCK_PTS[rk.size]);
    burst(s, rk.x, rk.y, 4 + rk.size * 4, 'ink', 50 + rk.size * 22);
    s.sfx.bang(rk.size);
  }
  function killUfo(s, scored) {
    var u = s.ufo;
    if (!u) return;
    if (scored) addScore(s, u.small ? 1000 : 200);
    burst(s, u.x, u.y, 14, 'ufo', 90);
    s.sfx.bang(2);
    s.ufo = null;
    resetUfoTimer(s);
  }
  function killShip(s) {
    var sh = s.ship;
    if (!sh.alive) return;
    sh.alive = false; sh.thrust = false;
    s.lives--;
    // The hull flies apart as tumbling line segments.
    var p = hullPoints(sh);
    for (var i = 0; i < 4; i++) {
      var a = i * 2, b = ((i + 1) % 4) * 2, mx = (p[a] + p[b]) / 2, my = (p[a + 1] + p[b + 1]) / 2;
      var ang = rnd() * TAU, v = 20 + rnd() * 40, life = 1.4 + rnd() * 0.6;
      s.parts.push({ x: mx, y: my, vx: sh.vx * 0.3 + Math.cos(ang) * v, vy: sh.vy * 0.3 + Math.sin(ang) * v,
        life: life, max: life, col: 'ship', len: Math.sqrt(Math.pow(p[b] - p[a], 2) + Math.pow(p[b + 1] - p[a + 1], 2)),
        a: Math.atan2(p[b + 1] - p[a + 1], p[b] - p[a]), spin: (rnd() - 0.5) * 6 });
    }
    burst(s, sh.x, sh.y, 16, 'ship', 100);
    s.shake = 7;
    s.respawnT = 1.8;
    s.sfx.die();
    try { Cade.haptic(60); } catch (e) {}
  }
  function enterHyper(s) {
    var sh = s.ship;
    if (s.hyperCD > 0) return;
    s.hyperCD = 1.1; sh.hyper = 0.5; sh.thrust = false;
    burst(s, sh.x, sh.y, 10, 'ship', 45);
    s.sfx.hyper();
  }
  function leaveHyper(s) {
    var sh = s.ship;
    sh.x = 24 + rnd() * (s.W - 48); sh.y = 24 + rnd() * (s.H - 48); sh.vx = 0; sh.vy = 0;
    burst(s, sh.x, sh.y, 10, 'ship', 45);
    if (rnd() < hyperRisk(s.rocks.length)) killShip(s);
  }
  function gameOver(s) {
    if (s.state === 'over') return;
    s.state = 'over'; s.overAt = s.t; s.ufo = null; s.ushots = []; s.shots = [];
    if (s.score > s.hi) { s.hi = s.score; setHi(s.hi); s.newHi = true; }
    s.sfx.hum('thrust', false); s.sfx.hum('ufo', false);
    updateBar(s);
  }

  function moveShots(list, dt, W, H) {
    for (var i = list.length - 1; i >= 0; i--) {
      var b = list[i];
      b.life -= dt;
      if (b.life <= 0) { list.splice(i, 1); continue; }
      b.x = wrap(b.x + b.vx * dt, W); b.y = wrap(b.y + b.vy * dt, H);
    }
  }
  function updateShip(s, dt) {
    var sh = s.ship, hp = s.hyperPress;
    s.hyperPress = false;
    if (s.hyperCD > 0) s.hyperCD -= dt;
    if (s.fireCD > 0) s.fireCD -= dt;
    if (s.firePress > 0) s.firePress -= dt;
    if (!sh.alive) {
      s.respawnT -= dt;
      if (s.respawnT > 0) return;
      if (s.lives <= 0) { gameOver(s); return; }
      if (spawnClear(s.W / 2, s.H / 2, s.rocks, s.ufo, s.ushots, s.W, s.H)) { s.ship = newShip(s); s.firePress = 0; }
      return;
    }
    if (sh.hyper > 0) { sh.hyper -= dt; if (sh.hyper <= 0) leaveHyper(s); return; }
    var turn = (held(s, 'right') ? 1 : 0) - (held(s, 'left') ? 1 : 0);
    sh.a += turn * TURN * dt;
    sh.thrust = held(s, 'thrust');
    if (sh.thrust) { sh.vx += Math.cos(sh.a) * THRUST * dt; sh.vy += Math.sin(sh.a) * THRUST * dt; }
    var d = Math.exp(-DRAG * dt);
    sh.vx *= d; sh.vy *= d;
    var sp = Math.sqrt(sh.vx * sh.vx + sh.vy * sh.vy);
    if (sp > VMAX) { sh.vx *= VMAX / sp; sh.vy *= VMAX / sp; }
    sh.x = wrap(sh.x + sh.vx * dt, s.W); sh.y = wrap(sh.y + sh.vy * dt, s.H);
    if (sh.inv > 0) sh.inv -= dt;
    // A tap fires at once (short buffer so a press during cooldown isn't lost);
    // holding auto-fires at a slower cadence. Max SHOT_CAP shots in flight.
    if (s.fireCD <= 0 && (s.firePress > 0 || held(s, 'fire')) && s.shots.length < SHOT_CAP) {
      var c = Math.cos(sh.a), sn = Math.sin(sh.a);
      s.shots.push({ x: sh.x + c * 12, y: sh.y + sn * 12, vx: sh.vx + c * SHOT_V, vy: sh.vy + sn * SHOT_V, life: SHOT_LIFE });
      s.fireCD = s.firePress > 0 ? 0.1 : 0.2;
      s.firePress = 0;
      s.sfx.fire();
    }
    if (hp) enterHyper(s);
  }
  function updateUfo(s, dt) {
    var u = s.ufo, sh = s.ship;
    if (!u) {
      s.ufoT -= dt;
      if (s.ufoT <= 0) {
        var small = s.score >= 10000 ? rnd() < 0.75 : rnd() < Math.min(0.6, 0.12 + 0.1 * (s.level - 1));
        var dir = rnd() < 0.5 ? 1 : -1;
        s.ufo = { x: dir > 0 ? -14 : s.W + 14, y: 30 + rnd() * (s.H - 60), vx: dir * (small ? 74 : 56), vy: 0,
          small: small, r: small ? 7 : 12, turnT: 1, shotT: 1, travel: 0 };
      }
      return;
    }
    u.x += u.vx * dt; u.y = wrap(u.y + u.vy * dt, s.H); u.travel += Math.abs(u.vx * dt);
    if (u.travel > s.W + 30) { s.ufo = null; resetUfoTimer(s); return; }   // flew off the far side
    u.turnT -= dt;
    if (u.turnT <= 0) { u.turnT = 0.8 + rnd() * 1.4; u.vy = (Math.floor(rnd() * 3) - 1) * (u.small ? 46 : 36); }
    u.shotT -= dt;
    if (u.shotT <= 0 && s.ushots.length < 3 && sh.alive && sh.hyper <= 0) {
      u.shotT = u.small ? Math.max(0.55, 1.05 - 0.05 * s.level) : 1.3;
      var a = ufoAim(u, sh, s.level, rnd, USHOT_V, s.W, s.H);
      s.ushots.push({ x: u.x + Math.cos(a) * (u.r + 2), y: u.y + Math.sin(a) * (u.r + 2),
        vx: Math.cos(a) * USHOT_V, vy: Math.sin(a) * USHOT_V, life: USHOT_LIFE });
      s.sfx.ufoFire();
    }
  }
  function near(dx, dy, r) { return dx * dx + dy * dy < r * r; }
  function collide(s) {
    var W = s.W, H = s.H, sh = s.ship, i, j, b, u, hit;
    for (i = s.shots.length - 1; i >= 0; i--) {
      b = s.shots[i]; hit = false;
      for (j = s.rocks.length - 1; j >= 0; j--) {
        if (rockContains(s.rocks[j], b.x, b.y, W, H)) { breakRock(s, j, b.vx, b.vy, true); hit = true; break; }
      }
      u = s.ufo;
      if (!hit && u && near(b.x - u.x, wrapDelta(b.y - u.y, H), u.r + 1.5)) { killUfo(s, true); hit = true; }
      if (hit) s.shots.splice(i, 1);
    }
    var vulnerable = sh.alive && sh.hyper <= 0 && sh.inv <= 0;
    for (i = s.ushots.length - 1; i >= 0; i--) {
      b = s.ushots[i]; hit = false;
      for (j = s.rocks.length - 1; j >= 0; j--) {
        if (rockContains(s.rocks[j], b.x, b.y, W, H)) { breakRock(s, j, b.vx, b.vy, false); hit = true; break; }
      }
      if (!hit && vulnerable && near(wrapDelta(b.x - sh.x, W), wrapDelta(b.y - sh.y, H), 8)) { killShip(s); vulnerable = false; hit = true; }
      if (hit) s.ushots.splice(i, 1);
    }
    if (vulnerable) {
      for (j = s.rocks.length - 1; j >= 0; j--) {
        if (shipHitsRock(sh, s.rocks[j], W, H)) { breakRock(s, j, sh.vx, sh.vy, true); killShip(s); vulnerable = false; break; }
      }
    }
    u = s.ufo;
    if (u && vulnerable && near(sh.x - u.x, wrapDelta(sh.y - u.y, H), u.r + 7)) { killUfo(s, true); killShip(s); }
    u = s.ufo;
    if (u) {
      for (j = s.rocks.length - 1; j >= 0; j--) {
        var rk = s.rocks[j];
        if (near(rk.x - u.x, wrapDelta(rk.y - u.y, H), rk.maxR * 0.85 + u.r * 0.7)) { breakRock(s, j, u.vx, u.vy, false); killUfo(s, false); break; }
      }
    }
  }
  function update(s, dt) {
    var i, W = s.W, H = s.H;
    s.t += dt;
    for (i = 0; i < s.rocks.length; i++) {
      var rk = s.rocks[i];
      rk.x = wrap(rk.x + rk.vx * dt, W); rk.y = wrap(rk.y + rk.vy * dt, H); rk.rot += rk.spin * dt;
    }
    var fr = Math.exp(-1.1 * dt);
    for (i = s.parts.length - 1; i >= 0; i--) {
      var p = s.parts[i];
      p.life -= dt;
      if (p.life <= 0) { s.parts.splice(i, 1); continue; }
      p.x = wrap(p.x + p.vx * dt, W); p.y = wrap(p.y + p.vy * dt, H); p.a += p.spin * dt;
      p.vx *= fr; p.vy *= fr;
    }
    if (s.shake > 0) s.shake = Math.max(0, s.shake - dt * 16);
    if (s.msgT > 0) s.msgT -= dt;
    if (s.state !== 'play') return;
    updateShip(s, dt);
    if (s.state !== 'play') return;     // that step ended the game
    moveShots(s.shots, dt, W, H);
    moveShots(s.ushots, dt, W, H);
    updateUfo(s, dt);
    collide(s);
    if (!s.rocks.length && !s.wavePending) { s.wavePending = true; s.waveT = 2.2; }
    if (s.wavePending) { s.waveT -= dt; if (s.waveT <= 0) { s.wavePending = false; s.level++; startWave(s); } }
    // The two-note heartbeat quickens through each wave.
    if (s.rocks.length && s.ship.alive && s.sfx.on) {
      s.beatT -= dt;
      if (s.beatT <= 0) { s.beatHi = !s.beatHi; s.sfx.beat(s.beatHi); s.beatGap = Math.max(0.26, s.beatGap - 0.012); s.beatT = s.beatGap; }
    }
    s.sfx.hum('thrust', s.ship.alive && s.ship.thrust && s.ship.hyper <= 0);
    s.sfx.hum('ufo', !!s.ufo, s.ufo ? s.ufo.small : null);
  }

  // ---- Rendering ----
  function polyPath(ctx, pts, x, y, rot, open) {
    var c = Math.cos(rot), s = Math.sin(rot);
    ctx.moveTo(x + pts[0] * c - pts[1] * s, y + pts[0] * s + pts[1] * c);
    for (var i = 2; i < pts.length; i += 2) ctx.lineTo(x + pts[i] * c - pts[i + 1] * s, y + pts[i] * s + pts[i + 1] * c);
    if (!open) ctx.closePath();
  }
  function glowStroke(ctx, P, color, glow, w) {
    ctx.strokeStyle = glow;
    ctx.globalAlpha = P.glowA * 0.45; ctx.lineWidth = w * 5; ctx.stroke();
    ctx.globalAlpha = P.glowA; ctx.lineWidth = w * 2.6; ctx.stroke();
    ctx.globalAlpha = 1; ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke();
  }
  function ufoPath(ctx, u) {
    var r = u.r, x = u.x, y = u.y;
    ctx.moveTo(x - r, y); ctx.lineTo(x - r * 0.45, y + r * 0.42); ctx.lineTo(x + r * 0.45, y + r * 0.42); ctx.lineTo(x + r, y); ctx.closePath();
    ctx.moveTo(x - r, y); ctx.lineTo(x - r * 0.45, y - r * 0.32); ctx.lineTo(x + r * 0.45, y - r * 0.32); ctx.lineTo(x + r, y);
    ctx.moveTo(x - r * 0.45, y - r * 0.32); ctx.lineTo(x - r * 0.22, y - r * 0.72); ctx.lineTo(x + r * 0.22, y - r * 0.72); ctx.lineTo(x + r * 0.45, y - r * 0.32);
  }
  function drawShots(ctx, P, list, col, glow) {
    var i, b;
    if (!list.length) return;
    ctx.fillStyle = glow; ctx.globalAlpha = P.glowA * 1.2;
    ctx.beginPath();
    for (i = 0; i < list.length; i++) { b = list[i]; ctx.moveTo(b.x + 3.4, b.y); ctx.arc(b.x, b.y, 3.4, 0, TAU); }
    ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = col;
    ctx.beginPath();
    for (i = 0; i < list.length; i++) { b = list[i]; ctx.moveTo(b.x + 1.5, b.y); ctx.arc(b.x, b.y, 1.5, 0, TAU); }
    ctx.fill();
  }
  function text(ctx, P, str, x, y, size, col, weight, glowPx) {
    ctx.font = (weight || 500) + ' ' + size + 'px ' + P.mono;
    ctx.fillStyle = col;
    if (glowPx) { ctx.shadowColor = P.glow; ctx.shadowBlur = glowPx; }
    ctx.fillText(str, x, y);
    if (glowPx) ctx.shadowBlur = 0;
  }
  function render(s) {
    var ctx = s.ctx, P = s.pal, k = s.k, W = s.W, H = s.H, i, j, g;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    ctx.fillStyle = P.bg; ctx.fillRect(0, 0, s.canvas.width, s.canvas.height);
    var ox = 0, oy = 0;
    if (s.shake > 0 && !reduced) { ox = (rnd() - 0.5) * s.shake; oy = (rnd() - 0.5) * s.shake; }
    ctx.setTransform(k, 0, 0, k, ox * k, oy * k);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    // Rocks: every outline (plus edge ghosts) in one path, stroked once per glow layer.
    ctx.beginPath();
    for (i = 0; i < s.rocks.length; i++) {
      var rk = s.rocks[i];
      g = ghosts(rk.x, rk.y, rk.maxR, W, H);
      for (j = 0; j < g.length; j += 2) polyPath(ctx, rk.pts, rk.x + g[j], rk.y + g[j + 1], rk.rot);
    }
    glowStroke(ctx, P, P.ink, P.glow, 1.3);

    if (s.ufo) { ctx.beginPath(); ufoPath(ctx, s.ufo); glowStroke(ctx, P, P.ufo, P.ufo, 1.3); }

    var sh = s.ship;
    if (s.state === 'play' && sh.alive && sh.hyper <= 0) {
      var blinkOff = sh.inv > 0 && !reduced && ((s.t * 10) | 0) % 2 === 1;
      if (!blinkOff) {
        if (sh.inv > 0 && reduced) ctx.globalAlpha = 0.5;
        g = ghosts(sh.x, sh.y, 13, W, H);
        ctx.beginPath();
        for (j = 0; j < g.length; j += 2) polyPath(ctx, HULL, sh.x + g[j], sh.y + g[j + 1], sh.a);
        glowStroke(ctx, P, P.ship, P.glow, 1.5);
        if (sh.thrust && ((s.t * 28) | 0) % 2 === 0) {
          ctx.beginPath(); polyPath(ctx, FLAME, sh.x, sh.y, sh.a, true);
          glowStroke(ctx, P, P.ship, P.glow, 1.2);
        }
        ctx.globalAlpha = 1;
      }
    }
    drawShots(ctx, P, s.shots, P.ink, P.glow);
    drawShots(ctx, P, s.ushots, P.ufo, P.ufo);

    for (i = 0; i < s.parts.length; i++) {
      var p = s.parts[i], col = p.col === 'ship' ? P.ship : p.col === 'ufo' ? P.ufo : P.ink;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.max * 1.4));
      if (p.len) {
        var hx = Math.cos(p.a) * p.len / 2, hy = Math.sin(p.a) * p.len / 2;
        ctx.beginPath(); ctx.moveTo(p.x - hx, p.y - hy); ctx.lineTo(p.x + hx, p.y + hy);
        ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.stroke();
      } else {
        ctx.fillStyle = col; ctx.fillRect(p.x - 0.9, p.y - 0.9, 1.8, 1.8);
      }
    }
    ctx.globalAlpha = 1;

    // While the respawn waits for a clear centre, show the zone being watched.
    if (s.state === 'play' && !sh.alive && s.lives > 0 && s.respawnT <= 0) {
      ctx.beginPath(); ctx.arc(W / 2, H / 2, 34, 0, TAU);
      ctx.setLineDash([4, 6]); ctx.strokeStyle = P.dim; ctx.lineWidth = 1; ctx.globalAlpha = 0.7; ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }

    ctx.setTransform(k, 0, 0, k, 0, 0);
    hud(s);
    overlay(s);
  }
  function hud(s) {
    var ctx = s.ctx, P = s.pal;
    ctx.textBaseline = 'top';
    if (s.state !== 'title') {
      ctx.textAlign = 'left'; text(ctx, P, String(s.score), 10, 8, 15, P.ink, 600);
      ctx.textAlign = 'right'; text(ctx, P, 'LV ' + s.level, s.W - 10, 10, 12, P.dim, 500);
      if (s.state === 'play') {
        ctx.beginPath();
        for (var i = 0; i < Math.min(s.lives, 8); i++) polyPath(ctx, MINI, 15 + i * 12, 36, -Math.PI / 2);
        ctx.strokeStyle = P.ship; ctx.lineWidth = 1.1; ctx.stroke();
      }
    }
    ctx.textAlign = 'center'; text(ctx, P, 'HI ' + Math.max(s.hi, s.score), s.W / 2, 10, 12, P.dim, 500);
  }
  function overlay(s) {
    var ctx = s.ctx, P = s.pal, cx = s.W / 2, cy = s.H / 2, gl = 9 * s.k, touch = s.padOn;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (s.paused) {
      ctx.globalAlpha = 0.6; ctx.fillStyle = P.bg; ctx.fillRect(0, 0, s.W, s.H); ctx.globalAlpha = 1;
      text(ctx, P, 'PAUSED', cx, cy - 10, 26, P.ship, 700, gl);
      text(ctx, P, touch ? 'Tap to resume' : 'P or Enter to resume', cx, cy + 20, 12, P.dim);
      return;
    }
    if (s.state === 'title') {
      text(ctx, P, 'ASTEROIDS', cx, cy - 36, 34, P.ship, 700, gl);
      text(ctx, P, touch ? 'Tap here or FIRE to start' : 'Press Enter or Space to start', cx, cy + 4, 13, P.ink, 600);
      text(ctx, P, touch ? 'Thumb pad below \u00b7 slide between buttons' : '\u2190 \u2192 turn \u00b7 \u2191 thrust \u00b7 Space fire \u00b7 Shift hyperspace', cx, cy + 26, 11, P.dim);
    } else if (s.state === 'over') {
      text(ctx, P, 'GAME OVER', cx, cy - 28, 30, P.ink, 700, gl);
      text(ctx, P, 'SCORE ' + s.score + (s.newHi ? '  \u00b7  NEW BEST!' : '  \u00b7  BEST ' + s.hi), cx, cy + 6, 13, s.newHi ? P.ship : P.ink, 600);
      if (s.t - s.overAt > 1) text(ctx, P, touch ? 'Tap to play again' : 'Enter to play again', cx, cy + 28, 12, P.dim);
    } else if (s.msgT > 0) {
      ctx.globalAlpha = Math.min(1, s.msgT * 2);
      text(ctx, P, s.msg, cx, cy - s.H * 0.22, 18, P.ink, 700, gl);
      ctx.globalAlpha = 1;
    }
  }

  // ---- Loop + lifecycle ----
  function frame(ts) {
    var s = S;
    if (!s) return;
    s.raf = 0;
    if (!s.canvas.isConnected) { teardown(); return; }
    var dt = s.last ? (ts - s.last) / 1000 : STEP;
    s.last = ts;
    if (dt > 0.1) dt = 0.1; else if (dt < 0) dt = 0;
    if (!s.paused) {
      s.acc += dt;
      for (var n = 0; s.acc >= STEP && n < 16; n++) { update(s, STEP); s.acc -= STEP; }
      if (s.acc >= STEP) s.acc = 0;    // fell far behind: drop time rather than spiral
    }
    if (S !== s) return;
    render(s);
    if (!s.paused) s.raf = requestAnimationFrame(frame);
  }
  function kick(s) { if (!s.raf) { s.last = 0; s.raf = requestAnimationFrame(frame); } }
  function setPaused(s, on) {
    if (s.state !== 'play') on = false;
    if (s.paused === on) return;
    s.paused = on;
    s.kb = {};                             // key-ups are lost while away; start clean
    if (s.padCtl) s.padCtl.reset();
    s.sfx.hum('thrust', false); s.sfx.hum('ufo', false);
    updateBar(s);
    if (on) { if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; } render(s); } else kick(s);
  }
  function startOrResume(s) {
    if (s.paused) { setPaused(s, false); return true; }
    if (s.state === 'title' || (s.state === 'over' && s.t - s.overAt > 1)) { resetGame(s); return true; }
    return false;
  }
  function press(s, k) {
    if (k === 'fire') { if (!startOrResume(s) && s.state === 'play') s.firePress = 0.18; }
    else if (k === 'hyper') { if (s.state === 'play' && !s.paused) s.hyperPress = true; }
  }
  function updateBar(s) {
    var b = s.panel.querySelector('[data-act="pause"]');
    if (b) b.textContent = s.state !== 'play' ? 'Start' : s.paused ? 'Resume' : 'Pause';
    b = s.panel.querySelector('[data-act="sound"]');
    if (b) { b.textContent = s.sfx.on ? 'Sound on' : 'Sound off'; b.classList.toggle('on', s.sfx.on); }
    b = s.panel.querySelector('[data-act="pad"]');
    if (b) b.classList.toggle('on', s.padOn);
  }
  function fit(s, first) {
    var p = s.panel, vw = window.innerWidth, vh = window.innerHeight;
    var narrow = vw < 640, extra = 18;    // body padding + canvas border
    var maxW = narrow ? vw - 24 - extra : Math.min(560, vw - 48 - extra);
    var chrome = p.offsetHeight - s.canvas.offsetHeight;   // title bar, button bar, thumb pad
    var r = p.getBoundingClientRect();
    var maxH = Math.max(160, vh - Math.max(0, r.top) - chrome - 10 - safeBottom());
    if (first) {
      // Pick the world's aspect for this screen: tall on phones, classic 4:3-ish on desktop.
      var asp = maxH / maxW;
      s.H = Math.round(WW * (narrow ? clamp(asp, 0.75, 1.25) : clamp(asp, 0.62, 0.75)));
    }
    var w = Math.floor(Math.max(180, Math.min(maxW, maxH * s.W / s.H))), h = Math.round(w * s.H / s.W);
    s.canvas.style.width = w + 'px'; s.canvas.style.height = h + 'px';
    p.style.width = (w + extra + 2) + 'px';   // + the panel's own border (global border-box)
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    s.canvas.width = Math.round(w * dpr); s.canvas.height = Math.round(h * dpr);
    s.k = s.canvas.width / s.W;
    var pw = w + extra + 2, left = first ? Math.round((vw - pw) / 2) : r.left;
    p.style.left = Math.max(4, Math.min(left, vw - pw - 4)) + 'px';
    p.style.right = 'auto';
    if (!s.raf) render(s);
  }
  function teardown() {
    var s = S;
    if (!s) return;
    S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('keyup', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    clearTimeout(s.resizeT);
    if (s.mo) s.mo.disconnect();
    s.sfx.close();
  }
  function close(refocus) {
    var p = document.getElementById(PANEL);
    if (p) p.remove();
    teardown();
    if (refocus && !coarse()) { try { Cade.editor.focus(); } catch (e) {} }
  }

  var SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var ICON = {
    left: SVG + '<path d="M19 15A7 7 0 0 0 5 15"/><path d="M2 12l3 3.5 3-3.5"/></svg>',
    right: SVG + '<path d="M5 15A7 7 0 0 1 19 15"/><path d="M16 12l3 3.5 3-3.5"/></svg>',
    thrust: SVG + '<path d="M12 3l6.5 16-6.5-4-6.5 4z" fill="currentColor" stroke="none"/></svg>',
    fire: SVG + '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/></svg>',
    hyper: SVG + '<circle cx="12" cy="12" r="8" stroke-dasharray="2.5 3.2"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg>'
  };
  function pk(k, label, cls) {
    return '<div class="ast-pk' + (cls ? ' ' + cls : '') + '" data-k="' + k + '" role="button" aria-label="' + label + '">' + ICON[k] + '</div>';
  }
  function bodyHtml() {
    return '<div class="ast-wrap">' +
      '<canvas class="ast-canvas" aria-label="Asteroids playfield"></canvas>' +
      '<div class="ast-bar">' +
        '<button type="button" class="ast-b" data-act="pause" tabindex="-1">Start</button>' +
        '<button type="button" class="ast-b" data-act="sound" tabindex="-1">Sound off</button>' +
        '<button type="button" class="ast-b" data-act="pad" tabindex="-1" title="Show/hide the touch controls">Pad</button>' +
        '<span class="ast-hint">\u2190\u2192 turn \u00b7 \u2191 thrust \u00b7 Space fire \u00b7 Shift hyperspace \u00b7 P pause</span>' +
      '</div>' +
      '<div class="ast-pad">' +
        '<div class="ast-grp">' + pk('left', 'Turn left') + pk('right', 'Turn right') + '</div>' +
        pk('hyper', 'Hyperspace', 'sm') +
        '<div class="ast-grp">' + pk('thrust', 'Thrust') + pk('fire', 'Fire', 'fire') + '</div>' +
      '</div>' +
    '</div>';
  }

  function open() {
    try { Cade.closeAllMenus(); } catch (e) {}
    if (document.getElementById(PANEL)) { close(true); return; }
    teardown();
    reduced = false;
    var prefs = loadPrefs();
    var p = Cade.mkPanel(PANEL, '\u2604\ufe0f Asteroids', bodyHtml());
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    var canvas = p.querySelector('.ast-canvas');
    var s = {
      panel: p, wrapEl: p.querySelector('.ast-wrap'), canvas: canvas, ctx: canvas.getContext('2d'), pal: palette(),
      state: 'title', paused: false, t: 0, acc: 0, last: 0, raf: 0, k: 1, W: WW, H: 300,
      level: 1, score: 0, lives: 3, hi: getHi(), newHi: false, overAt: 0,
      rocks: [], shots: [], ushots: [], parts: [], ufo: null, ship: null,
      kb: {}, pad: {}, fireCD: 0, firePress: 0, hyperCD: 0, hyperPress: false, respawnT: 0,
      wavePending: false, waveT: 0, ufoT: 15, beatT: 1, beatGap: 1, beatHi: false,
      shake: 0, msg: '', msgT: 0, sfx: new Sfx(), prefs: prefs,
      padOn: prefs.pad != null ? !!prefs.pad : coarse()
    };
    S = s;
    s.sfx.on = !!prefs.sound;
    s.ship = deadShip(s);
    s.wrapEl.classList.toggle('pad', s.padOn);
    p._onClose = teardown;
    fit(s, true);
    attract(s);
    updateBar(s);

    // Keys are captured on document from the moment the panel opens — no click
    // needed — and never leak to the editor or app shortcuts underneath.
    s.onKey = function (e) {
      if (S !== s || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!s.canvas.isConnected) { teardown(); return; }   // panel removed without _onClose
      if (Cade.isMinimized && Cade.isMinimized(p)) return; // parked in the dock: keys belong to the editor
      var tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      var key = (e.key || '').toLowerCase(), down = e.type === 'keydown';
      if (e.code === 'Space' || key === 'spacebar') key = ' ';
      if (key === 'escape') { if (down) { e.preventDefault(); close(true); } return; }
      if (key === 'p' || key === 'enter') {
        e.preventDefault(); e.stopPropagation();
        if (down && !e.repeat) { s.sfx.unlock(); if (key === 'p') setPaused(s, !s.paused); else startOrResume(s); }
        return;
      }
      var act = KEYS[key];
      if (!act) return;
      e.preventDefault(); e.stopPropagation();
      if (down) { s.sfx.unlock(); if (!e.repeat && !s.kb[act]) press(s, act); s.kb[act] = true; }
      else s.kb[act] = false;
    };
    document.addEventListener('keydown', s.onKey, true);
    document.addEventListener('keyup', s.onKey, true);
    s.onVis = function () { if (document.hidden) setPaused(s, true); };
    s.onBlur = function () { setPaused(s, true); };
    document.addEventListener('visibilitychange', s.onVis);
    window.addEventListener('blur', s.onBlur);
    // Minimized to the dock: pause like a tab switch (Resume waits for the player
    // after restore) and stop the attract loop meanwhile; restore restarts it.
    p.addEventListener('cade-panel-minimize', function () {
      if (S !== s) return;
      setPaused(s, true);
      if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; }
    });
    p.addEventListener('cade-panel-restore', function () { if (S === s && !s.paused) kick(s); });
    s.onResize = function () { clearTimeout(s.resizeT); s.resizeT = setTimeout(function () { if (S === s) fit(s, false); }, 120); };
    window.addEventListener('resize', s.onResize);
    try {
      s.mo = new MutationObserver(function () { s.pal = palette(); if (!s.raf) render(s); });
      s.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) { s.mo = null; }

    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      s.sfx.unlock();
      if (!startOrResume(s) && s.state === 'play') s.firePress = 0.18;
    });
    s.padCtl = bindPad(p.querySelector('.ast-pad'),
      function (h) { s.pad = h; },
      function (k) { if (S === s) press(s, k); },
      function () { s.sfx.unlock(); });
    var bar = p.querySelector('.ast-bar');
    bar.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep focus off the buttons
    bar.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'pause') { if (s.state === 'play') setPaused(s, !s.paused); else startOrResume(s); }
      else if (act === 'sound') {
        s.sfx.on = !s.sfx.on;
        if (s.sfx.on) { s.sfx.unlock(); setTimeout(function () { s.sfx.tone(660, 990, 0.08, 'square', 0.08); }, 30); }
        else s.sfx.mute();
        s.prefs.sound = s.sfx.on; savePrefs(s.prefs);
      } else if (act === 'pad') {
        s.padOn = !s.padOn; s.prefs.pad = s.padOn; savePrefs(s.prefs);
        s.wrapEl.classList.toggle('pad', s.padOn);
        fit(s, false);
      }
      updateBar(s);
      try { b.blur(); } catch (x) {}
    });
    // iOS reliably honours touchend-class gestures for starting audio.
    p.addEventListener('pointerup', function () { s.sfx.unlock(); });
    render(s);
    kick(s);
  }

  Cade.registerWidget({
    name: 'Asteroids',
    description: 'Vector rock-blaster \u2014 thrust, wrap, split rocks, dodge saucers',
    icon: '\u2604\ufe0f',
    tags: 'game,arcade,fun,train,asteroids,space,shooter,retro,vector',
    open: open
  });
})();
