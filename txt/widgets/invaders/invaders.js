/* Invaders — a formation shooter widget for Cade.txt (loaded on demand).
 * Hold the line against a marching 5×11 alien formation: it steps sideways,
 * drops and reverses at the edges, and speeds up as it thins out. Shields
 * erode pixel by pixel; a mystery ship crosses now and then for a bonus.
 * Keys: ← → / A D move · Space fire · P pause · Enter start · Esc close.
 * Touch: drag anywhere on the field to move, tap to fire (a second finger can
 * tap while the first drags), or use the ◀ ▶ FIRE pad under the field.
 * All sprites are original pixel art defined below, drawn crisp with
 * nearest-neighbour scaling. Fixed 120 Hz simulation under a delta-time rAF
 * loop, so 60 and 120 Hz screens play identically. */
(function () {
  'use strict';
  var root = typeof window !== 'undefined' ? window : {};

  // ===== Pixel art ('#' = lit). One string per row, one array per frame. =====
  var SPR_ID = 0;
  function sprite(frames) {
    var h = frames[0].length, w = frames[0][0].length;
    return { id: 's' + (SPR_ID++), w: w, h: h, frames: frames.map(function (rows) {
      var bits = new Uint8Array(w * h);
      for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) bits[y * w + x] = rows[y].charAt(x) === '#' ? 1 : 0;
      return bits;
    }) };
  }
  var SPR = {
    // "Seeker" — a one-eyed orb whose pupil glances side to side (30 pts)
    A: sprite([
      ['...####...', '..######..', '.###..###.', '.####.###.', '..######..', '...#..#...', '..#.##.#..', '.#......#.'],
      ['...####...', '..######..', '.###..###.', '.###.####.', '..######..', '...#..#...', '...#..#...', '..#....#..']
    ]),
    // "Beetle" — split shell, feelers and scuttling legs (20 pts)
    B: sprite([
      ['..#.....#..', '...#####...', '..#######..', '.##.#.#.##.', '#####.#####', '.#########.', '..#.#.#.#..', '.#.......#.'],
      ['..#.....#..', '...#####...', '..#######..', '.##.#.#.##.', '#####.#####', '.#########.', '.#.#...#.#.', '#.........#']
    ]),
    // "Drifter" — a domed jelly trailing tendrils (10 pts)
    C: sprite([
      ['...######...', '.##########.', '###.####.###', '############', '.#.#.##.#.#.', '#.#..##..#.#', '#..#....#..#', '.#..#..#..#.'],
      ['...######...', '.##########.', '###.####.###', '############', '.#.#.##.#.#.', '.#.#.##.#.#.', '#.#......#.#', '#..#....#..#']
    ]),
    // Mystery disc with blinking portholes
    M: sprite([
      ['.......##.......', '....########....', '..##.#.##.#.##..', '################', '.##############.', '...#..#..#..#...', '..#..#....#..#..'],
      ['.......##.......', '....########....', '..#.##.##.##.#..', '################', '.##############.', '...#..#..#..#...', '..#..#....#..#..']
    ]),
    // Player cannon: turret on treads
    P: sprite([
      ['......#......', '.....###.....', '....#####....', '.###########.', '#############', '##.#.#.#.#.##', '#############', '.#.#.#.#.#.#.']
    ]),
    PX: sprite([
      ['.#....#...#..', '...#.....#..#', '#..#.##.#....', '...######..#.', '.##########..', '#.#########.#', '#############', '..#.#.#.#.#..'],
      ['#...#....#..#', '..#...#...#..', '.....#.#..#..', '.#.######....', '..#########.#', '#.#########..', '.############', '#.#.#.#.#.#.#']
    ]),
    BOOM: sprite([
      ['#...#..#...#', '.#..#..#..#.', '..#......#..', '##........##', '..#......#..', '.#..#..#..#.', '#...#..#...#']
    ]),
    SPLAT: sprite([
      ['..#..#', '#..#..', '.####.', '######', '.####.', '#.#..#']
    ]),
    // Alien shots: a wiggler, an aimed bolt with a sliding crossbar, a fast twister
    zig: sprite([
      ['.#.', '#..', '.#.', '..#', '.#.', '#..', '.#.'],
      ['#..', '.#.', '..#', '.#.', '#..', '.#.', '..#'],
      ['.#.', '..#', '.#.', '#..', '.#.', '..#', '.#.'],
      ['..#', '.#.', '#..', '.#.', '..#', '.#.', '#..']
    ]),
    bolt: sprite([
      ['.#.', '###', '.#.', '.#.', '.#.', '.#.', '.#.'],
      ['.#.', '.#.', '.#.', '###', '.#.', '.#.', '.#.'],
      ['.#.', '.#.', '.#.', '.#.', '.#.', '###', '.#.']
    ]),
    fast: sprite([
      ['.#.', '#.#', '.#.', '.#.', '#.#', '.#.', '.#.'],
      ['.#.', '.#.', '#.#', '.#.', '.#.', '#.#', '.#.']
    ])
  };

  // ===== Playfield geometry (world pixels) =====
  var W = 224, H = 242;
  var ROWS = 5, COLS = 11, CELL = 16;
  var ROW_TYPE = ['A', 'B', 'B', 'C', 'C'], POINTS = { A: 30, B: 20, C: 10 };
  var FORM_TOP = 40, LEFT = 4, RIGHT = 220, DX = 2, DY = 8;
  var MYST_Y = 20, SHIELD_Y = 182, SHIELD_W = 22, SHIELD_H = 16, CANNON_Y = 206, GROUND_Y = 222;
  var SHOT_SPEED = { zig: 72, bolt: 88, fast: 128 };

  // ===== Pure helpers (no DOM) — unit-checked in node via window.__CADE_UNIT__ =====
  // Each wave starts a row lower than the last, down to a floor.
  function waveStartY(level) { return FORM_TOP + Math.min(level - 1, 6) * 8; }
  function newFormation(level) {
    var alive = new Uint8Array(ROWS * COLS);
    for (var i = 0; i < alive.length; i++) alive[i] = 1;
    return { x: 24, y: waveStartY(level), dir: 1, frame: 0, alive: alive };
  }
  function alienRect(f, idx) {
    var c = idx % COLS, r = (idx / COLS) | 0, sp = SPR[ROW_TYPE[r]];
    return { x: f.x + c * CELL + ((CELL - sp.w) >> 1), y: f.y + r * CELL, w: sp.w, h: sp.h };
  }
  function formationExtents(f) {
    var e = { minX: Infinity, maxX: -Infinity, maxY: -Infinity, alive: 0 };
    for (var i = 0; i < f.alive.length; i++) {
      if (!f.alive[i]) continue;
      var r = alienRect(f, i);
      e.alive++;
      if (r.x < e.minX) e.minX = r.x;
      if (r.x + r.w > e.maxX) e.maxX = r.x + r.w;
      if (r.y + r.h > e.maxY) e.maxY = r.y + r.h;
    }
    return e;
  }
  // One march step: slide DX sideways; if the outermost live alien would cross
  // an edge, drop DY and reverse instead (no sideways move on a drop step).
  function stepFormation(f) {
    var e = formationExtents(f);
    if (!e.alive) return 'none';
    f.frame ^= 1;
    var d = f.dir * DX;
    if (e.minX + d < LEFT || e.maxX + d > RIGHT) { f.y += DY; f.dir = -f.dir; return 'drop'; }
    f.x += d;
    return 'move';
  }
  // Seconds per step: the march quickens as the formation thins (the last
  // alien races) and every level is a little brisker.
  function stepInterval(alive, level) {
    return (0.01 + 0.5 * Math.pow(Math.max(alive, 0) / (ROWS * COLS), 1.1)) * Math.max(0.55, 1 - 0.06 * (level - 1));
  }
  function alienAt(f, px, py) {
    var r = Math.floor((py - f.y) / CELL), c = Math.floor((px - f.x) / CELL);
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return -1;
    var idx = r * COLS + c;
    if (!f.alive[idx]) return -1;
    var rc = alienRect(f, idx);
    return px >= rc.x && px < rc.x + rc.w && py >= rc.y && py < rc.y + rc.h ? idx : -1;
  }
  function bottomAlien(f, c) {
    for (var r = ROWS - 1; r >= 0; r--) if (f.alive[r * COLS + c]) return r * COLS + c;
    return -1;
  }
  // The live column whose centre is nearest x (for the aimed shot), or -1.
  function aimColumn(f, x) {
    var best = -1, bd = Infinity;
    for (var c = 0; c < COLS; c++) {
      if (bottomAlien(f, c) < 0) continue;
      var d = Math.abs(f.x + c * CELL + CELL / 2 - x);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  // Shield: a block with clipped top corners and an arch cut in the base.
  function makeShield() {
    var m = new Uint8Array(SHIELD_W * SHIELD_H);
    for (var y = 0; y < SHIELD_H; y++) for (var x = 0; x < SHIELD_W; x++) {
      var on = 1;
      if (y < 4 && (x < 4 - y || x > SHIELD_W - 1 - (4 - y))) on = 0;
      if ((y >= 12 && x >= 7 && x <= 14) || (y === 11 && x >= 8 && x <= 13) || (y === 10 && x >= 9 && x <= 12)) on = 0;
      m[y * SHIELD_W + x] = on;
    }
    return m;
  }
  // First lit pixel of a mask inside a rect (clipped), scanning rows top-down,
  // or bottom-up when `up` (a shot rising from below meets the underside first).
  function maskHit(m, mw, mh, x0, y0, x1, y1, up) {
    x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(mw - 1, Math.floor(x1));
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(mh - 1, Math.floor(y1));
    if (x0 > x1 || y0 > y1) return -1;
    for (var j = 0; j <= y1 - y0; j++) {
      var y = up ? y1 - j : y0 + j;
      for (var x = x0; x <= x1; x++) if (m[y * mw + x]) return y * mw + x;
    }
    return -1;
  }
  // Blast a ragged elliptical hole: certain at the centre, patchier towards
  // the rim, so shields wear away organically. Returns pixels cleared.
  function erode(m, mw, mh, cx, cy, rx, ry, rng) {
    var n = 0;
    for (var y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(mh - 1, Math.ceil(cy + ry)); y++) {
      for (var x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(mw - 1, Math.ceil(cx + rx)); x++) {
        var dx = (x - cx) / rx, dy = (y - cy) / ry, d = dx * dx + dy * dy;
        if (d < 1 && m[y * mw + x] && rng() < 1.15 - d) { m[y * mw + x] = 0; n++; }
      }
    }
    return n;
  }
  function clearRect(m, mw, mh, x0, y0, x1, y1) {
    var n = 0;
    for (var y = Math.max(0, y0); y <= Math.min(mh - 1, y1); y++) {
      for (var x = Math.max(0, x0); x <= Math.min(mw - 1, x1); x++) if (m[y * mw + x]) { m[y * mw + x] = 0; n++; }
    }
    return n;
  }
  // Classic rule is one shot on screen; later waves earn a faster cannon.
  function maxPlayerShots(level) { return level >= 6 ? 3 : level >= 3 ? 2 : 1; }
  function maxAlienShots(level) { return Math.min(3, 1 + Math.ceil(level / 2)); }
  function mysteryValue(rng) { var r = rng(); return r < 0.3 ? 50 : r < 0.65 ? 100 : r < 0.9 ? 150 : 300; }

  if (root.__CADE_UNIT__) {
    root.__CADE_UNIT__.invaders = {
      SPR: SPR, W: W, H: H, ROWS: ROWS, COLS: COLS, LEFT: LEFT, RIGHT: RIGHT, DX: DX, DY: DY, SHIELD_W: SHIELD_W, SHIELD_H: SHIELD_H,
      waveStartY: waveStartY, newFormation: newFormation, alienRect: alienRect, formationExtents: formationExtents,
      stepFormation: stepFormation, stepInterval: stepInterval, alienAt: alienAt, bottomAlien: bottomAlien,
      aimColumn: aimColumn, makeShield: makeShield, maskHit: maskHit, erode: erode, clearRect: clearRect,
      maxPlayerShots: maxPlayerShots, maxAlienShots: maxAlienShots, mysteryValue: mysteryValue
    };
  }
  if (typeof root.Cade === 'undefined') return;

  // ===== Widget =====
  var Cade = root.Cade;
  Cade.loadCSS('invaders.css');

  var PANEL = 'invaders-panel', HI_KEY = 'cade-game-invaders-hi', PREF_KEY = 'cade-game-invaders-prefs';
  var STEP = 1 / 120, SPEED = 85, PSHOT_V = 250, EXTRA_AT = 1500;
  var MARCH = [98, 87.31, 77.78, 73.42];           // the four-note bass march
  var KEYS = { arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right', ' ': 'fire', arrowup: 'fire', w: 'fire' };
  var rnd = Math.random;
  var reduced = false;
  var S = null;                                    // the live game (one panel at a time)
  if (root.__CADE_UNIT__) root.__CADE_UNIT__.invadersLive = function () { return S; };   // test-only peek

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

  // ---- Sound: WebAudio, off by default; the context is only created inside a
  // user gesture (iOS won't start it otherwise) and is closed with the panel. ----
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
  // The mystery ship's warble: built once, gated by a gain, only touched on change.
  Sfx.prototype.hum = function (on) {
    var ac = this.ready(), L = this.loops.m;
    if (!ac) return;
    if (on && !L) {
      var g = ac.createGain(), o = ac.createOscillator(), lfo = ac.createOscillator(), lg = ac.createGain(), f = ac.createBiquadFilter();
      g.gain.value = 0; g.connect(this.out);
      o.type = 'square'; o.frequency.value = 520; lfo.frequency.value = 8; lg.gain.value = 90;
      f.type = 'lowpass'; f.frequency.value = 1600;
      lfo.connect(lg); lg.connect(o.frequency); o.connect(f); f.connect(g); o.start(); lfo.start();
      L = this.loops.m = { g: g, cur: 0 };
    }
    if (!L) return;
    var want = on ? 0.05 : 0;
    if (L.cur !== want) { L.cur = want; L.g.gain.setTargetAtTime(want, ac.currentTime, 0.04); }
  };
  Sfx.prototype.mute = function () {
    for (var k in this.loops) { this.loops[k].cur = 0; try { this.loops[k].g.gain.value = 0; } catch (e) {} }
    if (this.ac && this.ac.suspend) { try { this.ac.suspend(); } catch (e) {} }
  };
  Sfx.prototype.close = function () {
    if (this.ac) { try { var pr = this.ac.close(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {} }
    this.ac = null; this.loops = {};
  };
  Sfx.prototype.march = function (i) { this.tone(MARCH[i & 3], 0, 0.09, 'square', 0.13); };
  Sfx.prototype.shoot = function () { this.tone(1500, 380, 0.11, 'square', 0.06); };
  Sfx.prototype.hit = function () { this.hiss(0.2, 0.5, 3200); };
  Sfx.prototype.die = function () { this.hiss(1.0, 0.6, 1500); this.tone(300, 50, 0.9, 'sawtooth', 0.09); };
  Sfx.prototype.bonus = function () { for (var i = 0; i < 4; i++) this.tone(700 + i * 220, 0, 0.07, 'square', 0.08, i * 0.07); };
  Sfx.prototype.extra = function () { this.tone(660, 0, 0.09, 'square', 0.1); this.tone(880, 0, 0.09, 'square', 0.1, 0.09); this.tone(1320, 0, 0.14, 'square', 0.1, 0.18); };

  // ---- Theme: read the app's CSS variables so the playfield matches light/dark ----
  function palette() {
    var de = document.documentElement, cs = getComputedStyle(de);
    var v = function (n, d) { var x = cs.getPropertyValue(n); return (x && x.trim()) || d; };
    var dark = de.getAttribute('data-theme') === 'dark';
    return {
      bg: dark ? v('--bg', '#111110') : v('--surface-2', '#f5f5f4'),
      ink: v('--text', dark ? '#e7e5e3' : '#1c1917'),
      dim: v('--text-muted', dark ? '#8c8a87' : '#78716c'),
      accent: dark ? v('--accent-hover', '#12b3b7') : v('--accent', '#0f9598'),
      hot: v('--error', dark ? '#f87171' : '#dc2626'),
      mono: v('--font-mono', 'ui-monospace, monospace')
    };
  }

  // ---- Multi-touch pad: pointers tracked by id and re-hit-tested as they move,
  // so a thumb can rock between ◀ and ▶ while another holds FIRE. ----
  function bindPad(pad, onHeld, onPress, onDown) {
    var owner = {}, btns = Array.prototype.slice.call(pad.querySelectorAll('[data-k]')), rects = [];
    function measure() { rects = btns.map(function (b) { return { k: b.getAttribute('data-k'), r: b.getBoundingClientRect() }; }); }
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
    function set(id, k) { var prev = owner[id]; owner[id] = k; if (k && k !== prev) onPress(k); sync(); }
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
  function newShields() {
    var out = [];
    for (var i = 0; i < 4; i++) out.push({ x: Math.round(W * (i + 0.5) / 4 - SHIELD_W / 2), y: SHIELD_Y, m: makeShield(), dirty: true, cv: null });
    return out;
  }
  function newGround() { var g = new Uint8Array(W); for (var i = 0; i < W; i++) g[i] = 1; return g; }
  function aliveCount(f) { var n = 0; for (var i = 0; i < f.alive.length; i++) n += f.alive[i]; return n; }
  function startWave(s) {
    s.f = newFormation(s.level);
    s.alive = ROWS * COLS;
    s.shields = newShields(); s.ground = newGround();
    s.pshots = []; s.ashots = []; s.myst = null;
    s.mystT = 16 + rnd() * 10;
    s.stepT = 0.7; s.ashotT = 1.4; s.introT = 1.0; s.waveClearT = 0;
    s.msg = 'WAVE ' + s.level; s.msgT = 1.4;
  }
  function resetGame(s) {
    s.state = 'play'; s.level = 1; s.score = 0; s.lives = 3; s.extraGiven = false; s.newHi = false; s.invaded = false;
    s.player = { x: W / 2, alive: true }; s.dyingT = 0; s.graceT = 0;
    s.fireCD = 0; s.firePress = 0; s.touchX = null; s.shotN = 0; s.booms = []; s.pops = [];
    startWave(s);
    updateBar(s);
  }
  function held(s, k) { return !!(s.kb[k] || s.pad[k]); }
  function addScore(s, n) {
    s.score += n;
    if (!s.extraGiven && s.score >= EXTRA_AT) {
      s.extraGiven = true; s.lives = Math.min(9, s.lives + 1);
      s.msg = 'EXTRA LIFE'; s.msgT = 1.4; s.sfx.extra();
    }
  }
  function boom(s, spr, x, y, t, col) { s.booms.push({ spr: spr, x: x, y: y, t: t, col: col }); }
  function killAlien(s, idx) {
    var r = alienRect(s.f, idx);
    s.f.alive[idx] = 0; s.alive--;
    addScore(s, POINTS[ROW_TYPE[(idx / COLS) | 0]]);
    boom(s, SPR.BOOM, r.x + r.w / 2 - 6, r.y, 0.22, 'ink');
    s.sfx.hit();
  }
  function killPlayer(s) {
    var pl = s.player;
    if (!pl.alive) return;
    pl.alive = false; s.lives = Math.max(0, s.lives - 1);
    s.dyingT = 1.5; s.ashots = []; s.flashT = 0.18;
    s.sfx.die();
    try { Cade.haptic(80); } catch (e) {}
  }
  function gameOver(s) {
    if (s.state === 'over') return;
    s.state = 'over'; s.overAt = s.t;
    if (s.score > s.hi) { s.hi = s.score; setHi(s.hi); s.newHi = true; }
    s.sfx.hum(false);
    updateBar(s);
  }

  function updatePlayer(s, dt) {
    var pl = s.player;
    if (s.fireCD > 0) s.fireCD -= dt;
    if (s.firePress > 0) s.firePress -= dt;
    if (!pl.alive) {
      s.dyingT -= dt;
      if (s.dyingT > 0) return;
      if (s.lives <= 0 || s.invaded) { gameOver(s); return; }
      pl.alive = true; pl.x = W / 2; s.touchX = null; s.graceT = 1.0; s.firePress = 0;
      return;
    }
    if (s.graceT > 0) s.graceT -= dt;
    var dir = (held(s, 'right') ? 1 : 0) - (held(s, 'left') ? 1 : 0);
    if (dir) { pl.x += dir * SPEED * dt; s.touchX = null; }
    else if (s.touchX != null) {
      var d = s.touchX - pl.x, m = SPEED * 1.8 * dt;
      pl.x += d > m ? m : d < -m ? -m : d;
    }
    pl.x = clamp(pl.x, 8, W - 8);
    if ((s.firePress > 0 || held(s, 'fire')) && s.fireCD <= 0 && s.pshots.length < maxPlayerShots(s.level)) {
      s.pshots.push({ x: Math.round(pl.x), y: CANNON_Y - 4 });
      s.fireCD = 0.16; s.firePress = 0;
      s.sfx.shoot();
    }
  }
  function updatePlayerShots(s, dt) {
    var f = s.f, i, j;
    for (i = s.pshots.length - 1; i >= 0; i--) {
      var b = s.pshots[i], hit = false;
      b.y -= PSHOT_V * dt;
      var idx = alienAt(f, b.x, b.y);
      if (idx < 0) idx = alienAt(f, b.x, b.y + 3);
      if (idx >= 0) { killAlien(s, idx); hit = true; }
      var my = s.myst;
      if (!hit && my && b.x >= my.x && b.x < my.x + SPR.M.w && b.y < MYST_Y + SPR.M.h && b.y + 4 > MYST_Y) {
        var v = mysteryValue(rnd);
        addScore(s, v);
        s.pops.push({ x: my.x + SPR.M.w / 2, y: MYST_Y, text: String(v), t: 1.2 });
        boom(s, SPR.BOOM, my.x + 2, MYST_Y, 0.3, 'hot');
        s.myst = null; s.mystT = 18 + rnd() * 12;
        s.sfx.bonus();
        hit = true;
      }
      if (!hit) {
        for (j = s.ashots.length - 1; j >= 0; j--) {   // shots can be shot down
          var a = s.ashots[j];
          if (Math.abs(a.x - b.x) <= 1.5 && b.y < a.y + 7 && b.y + 4 > a.y) {
            s.ashots.splice(j, 1);
            boom(s, SPR.SPLAT, b.x - 3, b.y - 2, 0.12, 'ink');
            hit = true; break;
          }
        }
      }
      if (!hit) {
        for (j = 0; j < s.shields.length; j++) {
          var sh = s.shields[j], lx = b.x - sh.x, ly = b.y - sh.y;
          if (lx < 0 || lx >= SHIELD_W || ly + 3 < 0 || ly >= SHIELD_H) continue;
          var p = maskHit(sh.m, SHIELD_W, SHIELD_H, lx, ly, lx, ly + 3, true);
          if (p >= 0) {
            var hx = p % SHIELD_W, hy = (p / SHIELD_W) | 0;
            erode(sh.m, SHIELD_W, SHIELD_H, hx, hy - 1, 2.3, 3.4, rnd);
            sh.dirty = true;
            boom(s, SPR.SPLAT, sh.x + hx - 3, sh.y + hy - 4, 0.1, 'accent');
            hit = true; break;
          }
        }
      }
      if (!hit && b.y < 16) { boom(s, SPR.SPLAT, b.x - 3, 14, 0.12, 'ink'); hit = true; }
      if (hit) s.pshots.splice(i, 1);
    }
  }
  function updateFormation(s, dt) {
    s.stepT -= dt;
    if (s.stepT > 0) return;
    stepFormation(s.f);
    s.stepT = Math.max(STEP, s.stepT + stepInterval(s.alive, s.level));
    // March note, rate-limited so the last racing alien doesn't buzz.
    if (s.t - s.lastNote > 0.07) { s.lastNote = s.t; s.sfx.march(s.marchI++); }
    var e = formationExtents(s.f);
    if (e.maxY > SHIELD_Y) {
      // Aliens marching through the shields chew them away.
      for (var i = 0; i < s.f.alive.length; i++) {
        if (!s.f.alive[i]) continue;
        var r = alienRect(s.f, i);
        if (r.y + r.h <= SHIELD_Y) continue;
        for (var j = 0; j < s.shields.length; j++) {
          var sh = s.shields[j];
          if (clearRect(sh.m, SHIELD_W, SHIELD_H, r.x - sh.x, r.y - sh.y, r.x + r.w - 1 - sh.x, r.y + r.h - 1 - sh.y)) sh.dirty = true;
        }
      }
    }
    if (e.maxY >= CANNON_Y) { s.invaded = true; s.lives = 0; killPlayer(s); }
  }
  function alienFire(s, dt) {
    if (s.graceT > 0 || s.introT > 0) return;
    s.ashotT -= dt;
    if (s.ashotT > 0 || s.ashots.length >= maxAlienShots(s.level)) return;
    var f = s.f, type, col;
    s.shotN++;
    if (s.shotN % 3 === 0) { type = 'bolt'; col = aimColumn(f, s.player.x); }
    else {
      type = s.level >= 3 && rnd() < Math.min(0.5, 0.15 + 0.05 * s.level) ? 'fast' : 'zig';
      var cols = [];
      for (var c = 0; c < COLS; c++) if (bottomAlien(f, c) >= 0) cols.push(c);
      col = cols.length ? cols[(rnd() * cols.length) | 0] : -1;
    }
    var idx = col >= 0 ? bottomAlien(f, col) : -1;
    if (idx < 0) return;
    var r = alienRect(f, idx);
    s.ashots.push({ x: Math.round(r.x + r.w / 2), y: r.y + r.h, type: type, ft: 0, fi: 0 });
    s.ashotT = (0.5 + rnd() * 0.9) * Math.max(0.4, 1 - 0.07 * (s.level - 1));
  }
  function updateAlienShots(s, dt) {
    var pl = s.player;
    for (var i = s.ashots.length - 1; i >= 0; i--) {
      var a = s.ashots[i], hit = false;
      a.y += SHOT_SPEED[a.type] * dt;
      a.ft += dt;
      if (a.ft > 0.06) { a.ft = 0; a.fi++; }
      var bottom = a.y + 6;
      for (var j = 0; j < s.shields.length && !hit; j++) {
        var sh = s.shields[j];
        if (a.x + 1 < sh.x || a.x - 1 >= sh.x + SHIELD_W || bottom < sh.y || a.y >= sh.y + SHIELD_H) continue;
        var p = maskHit(sh.m, SHIELD_W, SHIELD_H, a.x - 1 - sh.x, a.y + 3 - sh.y, a.x + 1 - sh.x, bottom - sh.y, false);
        if (p >= 0) {
          var hx = p % SHIELD_W, hy = (p / SHIELD_W) | 0;
          erode(sh.m, SHIELD_W, SHIELD_H, hx, hy + 1, 3, 4, rnd);
          sh.dirty = true;
          boom(s, SPR.SPLAT, sh.x + hx - 3, sh.y + hy - 1, 0.12, 'ink');
          hit = true;
        }
      }
      if (!hit && pl.alive && Math.abs(a.x - pl.x) <= 6 && bottom >= CANNON_Y + 2 && a.y <= CANNON_Y + 7) { killPlayer(s); return; }
      if (!hit && bottom >= GROUND_Y) {
        for (var gx = a.x - 2; gx <= a.x + 2; gx++) if (gx >= 0 && gx < W && rnd() < 0.7) s.ground[gx] = 0;
        boom(s, SPR.SPLAT, a.x - 3, GROUND_Y - 6, 0.12, 'ink');
        hit = true;
      }
      if (hit) s.ashots.splice(i, 1);
    }
  }
  function updateMystery(s, dt) {
    var my = s.myst;
    if (!my) {
      s.mystT -= dt;
      if (s.mystT <= 0 && s.alive >= 8 && s.player.alive) {
        var dir = rnd() < 0.5 ? 1 : -1;
        s.myst = { x: dir > 0 ? -SPR.M.w : W, dir: dir };
      } else if (s.mystT <= 0) s.mystT = 4;
      return;
    }
    my.x += my.dir * 40 * dt;
    if (my.x < -SPR.M.w - 2 || my.x > W + 2) { s.myst = null; s.mystT = 18 + rnd() * 12; }
  }
  function update(s, dt) {
    s.t += dt;
    var i;
    for (i = s.booms.length - 1; i >= 0; i--) { s.booms[i].t -= dt; if (s.booms[i].t <= 0) s.booms.splice(i, 1); }
    for (i = s.pops.length - 1; i >= 0; i--) { s.pops[i].t -= dt; if (s.pops[i].t <= 0) s.pops.splice(i, 1); }
    if (s.msgT > 0) s.msgT -= dt;
    if (s.flashT > 0) s.flashT -= dt;
    if (s.state !== 'play') return;
    if (s.introT > 0) s.introT -= dt;
    updatePlayer(s, dt);
    if (s.state !== 'play') return;
    updatePlayerShots(s, dt);
    var frozen = !s.player.alive || s.waveClearT > 0;
    if (!frozen) { updateFormation(s, dt); alienFire(s, dt); }
    updateAlienShots(s, dt);
    if (s.player.alive) updateMystery(s, dt);
    s.sfx.hum(!!s.myst && s.player.alive);
    if (s.alive <= 0 && s.waveClearT <= 0) { s.waveClearT = 1.6; s.ashots = []; s.myst = null; s.sfx.hum(false); }
    else if (s.waveClearT > 0) {
      s.waveClearT -= dt;
      if (s.waveClearT <= 0) { s.level++; startWave(s); }
    }
  }

  // ---- Rendering: everything snapped to device pixels, sprites blitted from
  // tiny cached canvases with smoothing off, so pixels stay square and crisp. ----
  function spriteCanvas(s, spr, fi, color) {
    var key = spr.id + ':' + (fi % spr.frames.length) + ':' + color, c = s.cache[key];
    if (c) return c;
    c = document.createElement('canvas'); c.width = spr.w; c.height = spr.h;
    var x = c.getContext('2d'), bits = spr.frames[fi % spr.frames.length];
    x.fillStyle = color;
    for (var i = 0; i < bits.length; i++) if (bits[i]) x.fillRect(i % spr.w, (i / spr.w) | 0, 1, 1);
    s.cache[key] = c;
    return c;
  }
  function blit(s, img, x, y, w, h) {
    var k = s.k, x0 = Math.round(x * k), y0 = Math.round(y * k);
    s.ctx.drawImage(img, x0, y0, Math.round((x + w) * k) - x0, Math.round((y + h) * k) - y0);
  }
  function drawSprite(s, spr, fi, color, x, y) { blit(s, spriteCanvas(s, spr, fi, color), x, y, spr.w, spr.h); }
  function box(s, x, y, w, h) {
    var k = s.k, x0 = Math.round(x * k), y0 = Math.round(y * k);
    s.ctx.fillRect(x0, y0, Math.max(1, Math.round((x + w) * k) - x0), Math.max(1, Math.round((y + h) * k) - y0));
  }
  function txt(s, str, x, y, size, col, align, weight) {
    var ctx = s.ctx;
    ctx.font = (weight || 600) + ' ' + Math.max(8, Math.round(size * s.k)) + 'px ' + s.pal.mono;
    ctx.fillStyle = col; ctx.textAlign = align || 'left'; ctx.textBaseline = 'top';
    ctx.fillText(str, Math.round(x * s.k), Math.round(y * s.k));
  }
  function shieldCanvas(s, sh) {
    if (!sh.cv) { sh.cv = document.createElement('canvas'); sh.cv.width = SHIELD_W; sh.cv.height = SHIELD_H; sh.dirty = true; }
    if (sh.dirty) {
      var x = sh.cv.getContext('2d');
      x.clearRect(0, 0, SHIELD_W, SHIELD_H); x.fillStyle = s.pal.accent;
      for (var i = 0; i < sh.m.length; i++) if (sh.m[i]) x.fillRect(i % SHIELD_W, (i / SHIELD_W) | 0, 1, 1);
      sh.dirty = false;
    }
    return sh.cv;
  }
  function colorOf(P, c) { return c === 'hot' ? P.hot : c === 'accent' ? P.accent : P.ink; }
  function render(s) {
    var ctx = s.ctx, P = s.pal, i;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = P.bg; ctx.fillRect(0, 0, s.canvas.width, s.canvas.height);
    if (s.flashT > 0 && !reduced) { ctx.globalAlpha = 0.14; ctx.fillStyle = P.hot; ctx.fillRect(0, 0, s.canvas.width, s.canvas.height); ctx.globalAlpha = 1; }

    txt(s, 'SCORE ' + pad5(s.score), 4, 4, 7, P.ink, 'left');
    txt(s, 'HI ' + pad5(Math.max(s.hi, s.score)), W - 4, 4, 7, P.dim, 'right');

    if (s.state === 'title') { drawTitle(s); overlay(s); return; }

    var f = s.f, a, sp;
    for (i = 0; i < f.alive.length; i++) {
      if (!f.alive[i]) continue;
      var r = alienRect(f, i);
      drawSprite(s, SPR[ROW_TYPE[(i / COLS) | 0]], f.frame, P.ink, r.x, r.y);
    }
    if (s.myst) drawSprite(s, SPR.M, (s.t * 6) | 0, P.hot, Math.round(s.myst.x), MYST_Y);
    for (i = 0; i < s.shields.length; i++) blit(s, shieldCanvas(s, s.shields[i]), s.shields[i].x, s.shields[i].y, SHIELD_W, SHIELD_H);

    // ground line with its shot-out gaps
    ctx.fillStyle = P.accent;
    var run = -1;
    for (i = 0; i <= W; i++) {
      var on = i < W && s.ground[i];
      if (on && run < 0) run = i;
      else if (!on && run >= 0) { box(s, run, GROUND_Y, i - run, 1); run = -1; }
    }
    var pl = s.player;
    if (pl.alive) drawSprite(s, SPR.P, 0, P.accent, Math.round(pl.x) - 6, CANNON_Y);
    else if (s.state === 'play' || s.invaded) drawSprite(s, SPR.PX, (s.t * 10) | 0, P.accent, Math.round(pl.x) - 6, CANNON_Y);

    ctx.fillStyle = P.ink;
    for (i = 0; i < s.pshots.length; i++) box(s, s.pshots[i].x, s.pshots[i].y, 1, 4);
    for (i = 0; i < s.ashots.length; i++) { a = s.ashots[i]; sp = SPR[a.type]; drawSprite(s, sp, a.fi, P.ink, a.x - 1, Math.round(a.y)); }
    for (i = 0; i < s.booms.length; i++) { a = s.booms[i]; drawSprite(s, a.spr, 0, colorOf(P, a.col), Math.round(a.x), Math.round(a.y)); }
    for (i = 0; i < s.pops.length; i++) txt(s, s.pops[i].text, s.pops[i].x, s.pops[i].y, 7, P.hot, 'center', 700);

    // lives + wave, under the ground line
    txt(s, String(s.lives), 4, GROUND_Y + 5, 7, P.ink, 'left');
    for (i = 0; i < Math.min(s.lives - 1, 6); i++) drawSprite(s, SPR.P, 0, P.accent, 14 + i * 16, GROUND_Y + 5);
    txt(s, 'WAVE ' + s.level, W - 4, GROUND_Y + 5, 7, P.dim, 'right');
    overlay(s);
  }
  function pad5(n) { var t = String(n); while (t.length < 5) t = '0' + t; return t; }
  function drawTitle(s) {
    var P = s.pal, touch = s.padOn || coarse(), fi = (s.t * 2) | 0;
    txt(s, 'INVADERS', W / 2, 34, 20, P.accent, 'center', 800);
    txt(s, touch ? 'TAP TO START' : 'PRESS ENTER TO START', W / 2, 66, 8, P.ink, 'center', 600);
    var rows = [[SPR.M, '= ? MYSTERY', P.hot], [SPR.A, '= 30 POINTS', P.ink], [SPR.B, '= 20 POINTS', P.ink], [SPR.C, '= 10 POINTS', P.ink]];
    for (var i = 0; i < rows.length; i++) {
      var sp = rows[i][0], y = 96 + i * 20;
      drawSprite(s, sp, fi, rows[i][2], 76 - sp.w / 2, y);
      txt(s, rows[i][1], 92, y, 7, P.ink, 'left', 500);
    }
    txt(s, touch ? 'DRAG TO MOVE \u00b7 TAP TO FIRE' : '\u2190 \u2192 MOVE \u00b7 SPACE FIRE \u00b7 P PAUSE', W / 2, 188, 7, P.dim, 'center', 500);
  }
  function veil(s, a) {
    var ctx = s.ctx;
    ctx.globalAlpha = a; ctx.fillStyle = s.pal.bg; ctx.fillRect(0, 0, s.canvas.width, s.canvas.height); ctx.globalAlpha = 1;
  }
  function overlay(s) {
    var P = s.pal, touch = s.padOn || coarse();
    if (s.paused) {
      veil(s, 0.65);
      txt(s, 'PAUSED', W / 2, 104, 16, P.accent, 'center', 800);
      txt(s, touch ? 'TAP TO RESUME' : 'P OR ENTER TO RESUME', W / 2, 128, 7, P.dim, 'center');
    } else if (s.state === 'over') {
      veil(s, 0.6);
      if (s.invaded) txt(s, 'THEY LANDED', W / 2, 78, 8, P.hot, 'center', 700);
      txt(s, 'GAME OVER', W / 2, 92, 16, P.ink, 'center', 800);
      txt(s, 'SCORE ' + s.score + (s.newHi ? '  \u00b7  NEW BEST!' : ''), W / 2, 116, 8, s.newHi ? P.accent : P.ink, 'center');
      if (s.t - s.overAt > 1) txt(s, touch ? 'TAP TO PLAY AGAIN' : 'ENTER TO PLAY AGAIN', W / 2, 134, 7, P.dim, 'center');
    } else if (s.state === 'play' && s.msgT > 0) {
      s.ctx.globalAlpha = Math.min(1, s.msgT * 2);
      txt(s, s.msg, W / 2, 166, 9, P.accent, 'center', 800);   // between formation and shields
      s.ctx.globalAlpha = 1;
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
    s.kb = {};                              // key-ups are lost while away; start clean
    if (s.padCtl) s.padCtl.reset();
    s.sfx.hum(false);
    updateBar(s);
    if (on) { if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; } render(s); } else kick(s);
  }
  function startOrResume(s) {
    if (s.paused) { setPaused(s, false); return true; }
    if (s.state === 'title' || (s.state === 'over' && s.t - s.overAt > 1)) { resetGame(s); return true; }
    return false;
  }
  function press(s, k) {
    if (k === 'fire' && !startOrResume(s) && s.state === 'play') s.firePress = 0.25;
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
    var narrow = vw < 640, extra = 18;      // body padding + canvas border
    var maxW = narrow ? vw - 24 - extra : Math.min(W * 2, vw - 48 - extra);
    var chrome = p.offsetHeight - s.canvas.offsetHeight;   // title bar, button bar, pad
    var r = p.getBoundingClientRect();
    var maxH = Math.max(160, vh - Math.max(0, r.top) - chrome - 10 - safeBottom());
    var w = Math.floor(Math.max(170, Math.min(maxW, maxH * W / H))), h = Math.round(w * H / W);
    s.canvas.style.width = w + 'px'; s.canvas.style.height = h + 'px';
    p.style.width = (w + extra + 2) + 'px';  // + the panel's own border (global border-box)
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    s.canvas.width = Math.round(w * dpr); s.canvas.height = Math.round(h * dpr);
    s.k = s.canvas.width / W;
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

  var SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">';
  function bodyHtml() {
    return '<div class="inv-wrap">' +
      '<canvas class="inv-canvas" aria-label="Invaders playfield"></canvas>' +
      '<div class="inv-bar">' +
        '<button type="button" class="inv-b" data-act="pause" tabindex="-1">Start</button>' +
        '<button type="button" class="inv-b" data-act="sound" tabindex="-1">Sound off</button>' +
        '<button type="button" class="inv-b" data-act="pad" tabindex="-1" title="Show/hide the touch buttons">Pad</button>' +
        '<span class="inv-hint">\u2190\u2192 move \u00b7 Space fire \u00b7 P pause \u00b7 Esc close</span>' +
      '</div>' +
      '<div class="inv-pad">' +
        '<div class="inv-pk" data-k="left" role="button" aria-label="Move left">' + SVG + '<path d="M15.5 5v14L5 12z"/></svg></div>' +
        '<div class="inv-pk" data-k="right" role="button" aria-label="Move right">' + SVG + '<path d="M8.5 5v14L19 12z"/></svg></div>' +
        '<div class="inv-gap"></div>' +
        '<div class="inv-pk fire" data-k="fire" role="button" aria-label="Fire">' + SVG + '<rect x="10.5" y="3" width="3" height="11" rx="1.5"/><path d="M5 20h14l-2.5-5h-9z"/></svg><span>FIRE</span></div>' +
      '</div>' +
    '</div>';
  }

  function open() {
    try { Cade.closeAllMenus(); } catch (e) {}
    if (document.getElementById(PANEL)) { close(true); return; }
    teardown();
    reduced = false;
    var prefs = loadPrefs();
    var p = Cade.mkPanel(PANEL, '\ud83d\udc7e Invaders', bodyHtml());
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    var canvas = p.querySelector('.inv-canvas');
    var s = {
      panel: p, wrapEl: p.querySelector('.inv-wrap'), canvas: canvas, ctx: canvas.getContext('2d'), pal: palette(), cache: {},
      state: 'title', paused: false, t: 0, acc: 0, last: 0, raf: 0, k: 1,
      level: 1, score: 0, lives: 3, hi: getHi(), newHi: false, overAt: 0, extraGiven: false, invaded: false,
      f: newFormation(1), alive: ROWS * COLS, shields: newShields(), ground: newGround(),
      player: { x: W / 2, alive: true }, pshots: [], ashots: [], booms: [], pops: [], myst: null,
      stepT: 1, ashotT: 1, mystT: 20, introT: 0, waveClearT: 0, dyingT: 0, graceT: 0, flashT: 0,
      marchI: 0, lastNote: -1, shotN: 0, fireCD: 0, firePress: 0, touchX: null,
      kb: {}, pad: {}, msg: '', msgT: 0, sfx: new Sfx(), prefs: prefs,
      padOn: prefs.pad != null ? !!prefs.pad : coarse()
    };
    S = s;
    s.sfx.on = !!prefs.sound;
    s.wrapEl.classList.toggle('pad', s.padOn);
    p._onClose = teardown;
    fit(s, true);
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
      if (down) { s.sfx.unlock(); if (!e.repeat && !s.kb[act]) press(s, act); s.kb[act] = true; s.touchX = null; }
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
      s.mo = new MutationObserver(function () {
        s.pal = palette(); s.cache = {};
        for (var i = 0; i < s.shields.length; i++) s.shields[i].dirty = true;
        if (!s.raf) render(s);
      });
      s.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) { s.mo = null; }

    // Drag anywhere on the field to slide the cannon (relative, so the finger
    // never hides it); a quick tap fires; a second finger taps to fire mid-drag.
    var drag = null;
    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      s.sfx.unlock();
      if (startOrResume(s) || s.state !== 'play') return;
      if (drag) { s.firePress = 0.25; return; }
      var r = canvas.getBoundingClientRect();
      drag = { id: e.pointerId, sx: e.clientX, x0: s.player.x, t0: Date.now(), moved: false, scale: W / (r.width || W) };
      try { canvas.setPointerCapture(e.pointerId); } catch (x) {}
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.sx;
      if (!drag.moved && Math.abs(dx) > 6) drag.moved = true;
      if (drag.moved) s.touchX = clamp(drag.x0 + dx * drag.scale, 8, W - 8);
    });
    var endDrag = function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (e.type === 'pointerup' && !drag.moved && Date.now() - drag.t0 < 350) s.firePress = 0.25;
      drag = null;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('lostpointercapture', endDrag);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    s.padCtl = bindPad(p.querySelector('.inv-pad'),
      function (h) { s.pad = h; if (h.left || h.right) s.touchX = null; },
      function (k) { if (S === s) press(s, k); },
      function () { s.sfx.unlock(); });
    var bar = p.querySelector('.inv-bar');
    bar.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep focus off the buttons
    bar.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'pause') { if (s.state === 'play') setPaused(s, !s.paused); else startOrResume(s); }
      else if (act === 'sound') {
        s.sfx.on = !s.sfx.on;
        if (s.sfx.on) { s.sfx.unlock(); setTimeout(function () { s.sfx.march(0); }, 30); }
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
    name: 'Invaders',
    description: 'Hold the line against a marching alien formation \u2014 shields, mystery ship, waves',
    icon: '\ud83d\udc7e',
    tags: 'game,arcade,fun,train,invaders,aliens,space,shooter,retro',
    open: open
  });
})();
