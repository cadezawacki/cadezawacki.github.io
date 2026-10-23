/* Flit — a one-button flyer for Cade.txt. Tap / click / Space / ↑ to flap
 * through the gaps; they tighten and speed up as the score climbs. Medals at
 * 10 / 20 / 30 / 50. Drawn entirely in monospace ASCII glyphs to match the
 * editor (pipes, hills, clouds, the bird =(o>), no image assets.
 * Physics runs on a fixed 120 Hz step with an accumulator, so the bird flies
 * identically at 60, 90, 120 or 144 Hz; rendering interpolates between steps.
 * Pauses on blur / tab hide. Best score persists. Offline module. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('flappy.css');

  // ---- world (logical units; the canvas is scaled to fit) ----
  var VW = 288, VH = 432, GROUND = 52, FLOOR = VH - GROUND;
  var STEP = 1 / 120;                         // fixed physics step (s)
  var GRAV = 1450, FLAP_V = -405, MAX_FALL = 620, CEIL = -24;
  var BIRD_X = 82, HIT_R = 10;                // hitbox is smaller than the drawn bird: forgiving
  var COL_W = 52, CAP_H = 16, CAP_OVER = 3, SPACING = 172;
  var SPEED0 = 118, READY_Y = 188;
  var MEDALS = [
    { key: 'platinum', name: 'Platinum', at: 50, color: '#9fd8d6', ink: '#3f8f8c' },
    { key: 'gold', name: 'Gold', at: 30, color: '#f2c544', ink: '#b8860b' },
    { key: 'silver', name: 'Silver', at: 20, color: '#c3c9d0', ink: '#7d8792' },
    { key: 'bronze', name: 'Bronze', at: 10, color: '#cd8a4b', ink: '#a8652a' }
  ];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  // Gentle difficulty ramp: faster scroll and a tighter gap with each point.
  function speedFor(score) { return Math.min(170, SPEED0 + score * 1.6); }
  function gapFor(score) { return Math.max(100, 138 - score * 1.15); }
  function medalFor(score) { for (var i = 0; i < MEDALS.length; i++) if (score >= MEDALS[i].at) return MEDALS[i]; return null; }

  // Small seeded PRNG (mulberry32) so a run is reproducible from its seed.
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ================= engine (pure: no DOM — unit-checked in node) =================
  function newWorld(seed) {
    return {
      rnd: rng(seed), acc: 0, steps: 0, t: 0, state: 'ready',
      y: READY_Y, vy: 0, rot: 0, wing: 0, flapT: 0, py: READY_Y, prot: 0,
      cam: 0, pcam: 0, speed: SPEED0, cols: [], nextX: 0, lastGy: FLOOR / 2,
      score: 0, deadT: 0, landed: false, events: []
    };
  }

  function spawn(w) {
    var gap = gapFor(w.score), lo = 52 + gap / 2, hi = FLOOR - 44 - gap / 2;
    // Random height, but never an impossible swing from the previous gap.
    var gy = clamp(lo + w.rnd() * (hi - lo), w.lastGy - 130, w.lastGy + 130);
    w.lastGy = gy;
    w.cols.push({ x: w.nextX, gy: gy, gap: gap, passed: false });
    w.nextX += SPACING;
  }

  function circRect(cx, cy, r, x0, y0, x1, y1) {
    var nx = cx < x0 ? x0 : cx > x1 ? x1 : cx, ny = cy < y0 ? y0 : cy > y1 ? y1 : cy;
    var dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }
  function hitsCol(c, bx, by) {
    return circRect(bx, by, HIT_R, c.x, -1e4, c.x + COL_W, c.gy - c.gap / 2) ||
      circRect(bx, by, HIT_R, c.x, c.gy + c.gap / 2, c.x + COL_W, FLOOR + 20);
  }

  function die(w, onGround) {
    w.state = 'dead'; w.deadT = 0; w.landed = !!onGround;
    w.vy = onGround ? 0 : -90;                 // a little knock-back off a column
    w.events.push('hit');
  }

  // One fixed physics step. `flap` is the (already queued) input for this step.
  function stepWorld(w, flap) {
    w.py = w.y; w.prot = w.rot; w.pcam = w.cam;
    w.steps++; w.t += STEP;
    var ev = w.events;
    if (w.state === 'ready') {
      w.cam += SPEED0 * STEP;                  // ground keeps scrolling while you get ready
      w.y = READY_Y + Math.sin(w.t * 4.2) * 5;
      if (flap) { w.state = 'play'; w.vy = 0; w.nextX = w.cam + VW + 40; }
    }
    if (w.state === 'play') {
      if (flap) { w.vy = FLAP_V; w.flapT = 0.25; ev.push('flap'); }
      w.vy = Math.min(MAX_FALL, w.vy + GRAV * STEP);
      w.y += w.vy * STEP;
      if (w.y < CEIL) { w.y = CEIL; if (w.vy < 0) w.vy = 0; }
      w.cam += w.speed * STEP;
      while (w.nextX - w.cam < VW + COL_W) spawn(w);
      while (w.cols.length && w.cols[0].x + COL_W + CAP_OVER < w.cam - 4) w.cols.shift();
      var bx = w.cam + BIRD_X;
      for (var i = 0; i < w.cols.length; i++) {
        var c = w.cols[i];
        if (!c.passed && c.x + COL_W / 2 < bx) {
          c.passed = true; w.score++; w.speed = speedFor(w.score);
          ev.push('score');
          for (var m = 0; m < MEDALS.length; m++) if (MEDALS[m].at === w.score) ev.push('medal');
        }
        if (hitsCol(c, bx, w.y)) { die(w, false); break; }
      }
      if (w.state === 'play' && w.y + HIT_R >= FLOOR) { w.y = FLOOR - HIT_R; die(w, true); }
    } else if (w.state === 'dead') {
      w.deadT += STEP;
      if (!w.landed) {
        w.vy = Math.min(MAX_FALL * 1.2, w.vy + GRAV * STEP);
        w.y += w.vy * STEP;
        if (w.y + HIT_R >= FLOOR) { w.y = FLOOR - HIT_R; w.vy = 0; w.landed = true; ev.push('land'); }
      }
    }
    // Nose up after a flap, tipping into a dive as it falls.
    var tgt = w.state === 'ready' ? 0 : w.state === 'dead' && w.landed ? 1.45 : clamp(w.vy / MAX_FALL * 1.4, -0.45, 1.45);
    w.rot += (tgt - w.rot) * Math.min(1, STEP * (tgt > w.rot ? 7 : 16));
    w.wing += (w.flapT > 0 ? 30 : w.state === 'dead' ? 0 : 8) * STEP;
    w.flapT = Math.max(0, w.flapT - STEP);
  }

  // Fixed-timestep accumulator: consume real frame time in STEP slices.
  // `poll(w)` supplies the input for each step. Returns the render alpha.
  function advance(w, dt, poll) {
    w.acc += clamp(dt, 0, 0.25);               // after a long stall, don't fast-forward seconds
    var n = 0;
    while (w.acc >= STEP - 1e-7) {             // epsilon: 1/60 must be exactly two steps
      stepWorld(w, !!(poll && poll(w)));
      w.acc -= STEP;
      if (++n >= 40) { w.acc = 0; break; }
    }
    return clamp(w.acc / STEP, 0, 1);
  }

  // ================= UI =================
  var BEST_KEY = 'cade-game-flappy-best', SOUND_KEY = 'cade-game-flappy-sound';
  var S = null;   // the live session (one panel at a time)

  function getBest() { try { return Math.max(0, parseInt(Cade.store.get(BEST_KEY) || '0', 10) || 0); } catch (e) { return 0; } }
  function setBest(v) { try { Cade.store.set(BEST_KEY, String(v)); } catch (e) {} }

  // Tiny WebAudio voice. Created only from a user gesture (iOS), closed with the panel.
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
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      var t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.008);
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

  // ---- theme colours (derived from the app's CSS variables) ----
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
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [17, 17, 16]), tx = parseCol(v('--text'), [231, 229, 227]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    S.dark = dark;
    S.col = {
      bg: css(bg), text: css(tx), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace',
      star: css(mix(bg, tx, dark ? 0.34 : 0.32)), cloud: css(mix(bg, tx, dark ? 0.2 : 0.24)),
      far: css(mix(bg, ac, dark ? 0.34 : 0.32)), near: css(mix(bg, ac, dark ? 0.55 : 0.52)),
      pipe: css(ac), pipeHi: css(mix(ac, dark ? [255, 255, 255] : [0, 0, 0], dark ? 0.38 : 0.25)), pipeLo: css(mix(ac, bg, 0.5)),
      ground: css(mix(bg, tx, dark ? 0.3 : 0.34)), edge: css(mix(ac, tx, 0.2)),
      bird: dark ? '#f4b740' : '#c27d0e', wing: dark ? '#d8922a' : '#9c6208'
    };
    fitFont();
  }

  // ---- ASCII rendering ----
  // Everything is drawn as monospace glyphs on a cell grid. A cell is a
  // seventh of a column, so a pipe is exactly 7 glyphs wide and the drawing
  // matches the engine's hitboxes; the font size is fitted to the font's real
  // advance so strings line up with the grid in any monospace font. Things
  // move smoothly (sub-cell offsets) while staying on their own grid.
  var CWU = COL_W / 7, RHU = 12;
  var PIPE_ROW = ['|', ':', '#', '=', '-', '.', '|'];   // highlight left of centre, shadow right
  var CAP = '[=======]';
  var GROUND_ROWS = ['=-==-=-===-=', '.:  .  :. . ', ' . :.   .  :', ':  .  . :  .'];
  var BIRD_BODY = '=(o>', BIRD_DEAD = '=(x>';
  var CLOUD_BIG = ['   .-~~~-.', ' .(       ).', '(___________)'], CLOUD_SMALL = [' .--.', '(____)'];
  var DIGITS = ['###|#.#|#.#|#.#|###', '.#.|##.|.#.|.#.|###', '###|..#|###|#..|###', '###|..#|.##|..#|###', '#.#|#.#|###|..#|..#',
    '###|#..|###|..#|###', '###|#..|###|#.#|###', '###|..#|.#.|.#.|.#.', '###|#.#|###|#.#|###', '###|#.#|###|..#|###'].map(function (d) {
    return d.split('|').map(function (r) { return r.replace(/\./g, ' '); });
  });

  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '600 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;    // advance per px of font size
    S.fpx = CWU / adv;
    S.fnt = '600 ' + S.fpx.toFixed(3) + 'px ' + f;
    S.adv = adv;
    buildTiles();
  }
  function fontAt(scale, weight) { return (weight || 600) + ' ' + (S.fpx * scale).toFixed(3) + 'px ' + S.col.font; }
  function glyphs(c, s, x, y, color) { c.fillStyle = color; c.fillText(s, x, y); }
  function setText(c, font, align) { c.font = font; c.textAlign = align || 'left'; c.textBaseline = 'middle'; }

  // Pre-rendered strips (device pixels) for the repeating parts: a tall pipe
  // shaft and one period of the ground. Rebuilt on resize / theme change.
  function tile(wu, hu) {
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil(wu * S.k)); cv.height = Math.max(1, Math.ceil(hu * S.k));
    var c = cv.getContext('2d');
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    setText(c, S.fnt);
    return { cv: cv, c: c, w: wu, h: hu };
  }
  function buildTiles() {
    if (!S.k || !S.col) return;
    var k = S.col, i, j, rows = Math.ceil(VH / RHU) + 1;
    var sh = tile(COL_W, rows * RHU);
    for (i = 0; i < rows; i++) {
      var y = i * RHU + RHU / 2;
      for (j = 0; j < 7; j++) glyphs(sh.c, PIPE_ROW[j], j * CWU, y, j === 0 || j === 6 ? k.pipeHi : j <= 2 ? k.pipe : k.pipeLo);
    }
    S.shaft = sh;
    var L = GROUND_ROWS[0].length, gr = tile(L * CWU, GROUND);
    for (i = 0; i < GROUND_ROWS.length; i++) glyphs(gr.c, GROUND_ROWS[i], 0, 1 + i * RHU + RHU / 2, i ? k.ground : k.edge);
    S.groundT = gr;
  }
  // Snap to the device pixel grid so tiles stay crisp.
  function px(v) { return Math.round(v * S.k) / S.k; }

  // ASCII mountain ranges: a seeded walk that climbs (/) and descends (\)
  // one row per glyph column, with the odd flat stretch (_) in the valleys.
  // Cyclic, so it scrolls forever; the glyphs belong to world columns, so
  // they slide smoothly instead of shimmering.
  function range(seed, maxH, n) {
    var r = rng(seed), out = [], L = 0, up = true;
    for (var i = 0; i < n; i++) {
      if (L === 0 && !up && r() < 0.45) { out.push(['_', 1]); up = true; continue; }  // '_' sits on the cell bottom, level with the feet of / and \
      if (L >= maxH || (L > 0 && r() < (up ? 0.22 : 0.08))) up = false;
      else if (L === 0 || r() < (up ? 0.04 : 0.14)) up = true;
      if (up) { L++; out.push(['/', L]); } else { out.push(['\\', L]); L--; }
    }
    while (L > 0) { out.push(['\\', L]); L--; }       // close the loop at ground level
    return out;
  }
  var FAR = range(11, 6, 300), NEAR = range(29, 3, 240);
  function ridge(c, cols, off, baseRow, color) {
    var n = Math.ceil(VW / CWU) + 2, i0 = Math.floor(off / CWU), sx = -(off - i0 * CWU), rows = {}, j, N = cols.length;
    for (j = 0; j < n; j++) {
      var g = cols[((i0 + j) % N + N) % N], row = baseRow - g[1];
      (rows[row] || (rows[row] = []))[j] = g[0];
    }
    setText(c, S.fnt); c.fillStyle = color;
    for (var r in rows) {
      var a2 = rows[r], str = '';
      for (j = 0; j < n; j++) str += a2[j] || ' ';
      c.fillText(str, sx, +r * RHU + RHU / 2);
    }
  }
  function drawCol(c, col, x) {
    var k = S.col, sh = S.shaft, top = col.gy - col.gap / 2, bot = col.gy + col.gap / 2;
    var xr = px(x), h1 = Math.max(0, top - CAP_H), h2 = Math.max(0, FLOOR - (bot + CAP_H));
    c.fillStyle = k.bg;                              // solid behind the glyphs: hills don't show through
    c.fillRect(xr - CWU, 0, COL_W + 2 * CWU, Math.max(0, top));
    c.fillRect(xr - CWU, bot, COL_W + 2 * CWU, Math.max(0, FLOOR - bot));
    // shafts: rows aligned to the caps (top shaft from the tile's bottom, bottom shaft from its top)
    if (h1 > 0) { var sy = sh.h - h1; c.drawImage(sh.cv, 0, sy * S.k, sh.cv.width, h1 * S.k, xr, 0, COL_W, h1); }
    if (h2 > 0) c.drawImage(sh.cv, 0, 0, sh.cv.width, h2 * S.k, xr, bot + CAP_H, COL_W, h2);
    setText(c, S.fnt);
    glyphs(c, CAP, xr - CWU, top - CAP_H / 2, k.pipeHi);
    glyphs(c, CAP, xr - CWU, bot + CAP_H / 2, k.pipeHi);
  }
  function drawBird(c, x, y, rot, wing, dead) {
    var k = S.col, w4 = 4 * CWU, x0 = -w4 / 2;
    c.save();
    c.translate(x, y);
    c.rotate(rot);
    setText(c, fontAt(1, 800));
    glyphs(c, dead ? BIRD_DEAD : BIRD_BODY, x0, 0, k.bird);
    if (!dead) {                                    // the wing: up, level or down with the flap cycle
      var s = Math.sin(wing);
      if (s > 0.35) glyphs(c, '\\', x0 + CWU, -RHU * 0.72, k.wing);
      else if (s < -0.35) glyphs(c, '/', x0 + CWU, RHU * 0.72, k.wing);
      else glyphs(c, '~', x0 + CWU, -RHU * 0.62, k.wing);
    }
    c.restore();
  }
  // Text centred on x inside a bg-coloured box (so it reads over pipes).
  function label(c, s, x, y, scale, color, frame) {
    setText(c, fontAt(scale), 'center');
    var w = s.length * CWU * scale, h = RHU * scale;
    if (frame) {
      var bar = '+' + new Array(s.length + 3).join('-') + '+';
      c.fillStyle = S.col.bg; c.fillRect(x - w / 2 - 2 * CWU * scale, y - h * 1.5, w + 4 * CWU * scale, h * 3);
      glyphs(c, bar, x, y - h, frame);
      glyphs(c, '| ' + s + ' |', x, y, frame);
      glyphs(c, bar, x, y + h, frame);
      c.fillStyle = color; c.fillText(s, x, y);
    } else {
      c.fillStyle = S.col.bg; c.fillRect(x - w / 2 - 2, y - h / 2, w + 4, h);
      glyphs(c, s, x, y, color);
    }
  }
  function bigNumber(c, n, cx, cy, scale) {
    var ds = String(n), cw = CWU * scale, rh = RHU * 0.64 * scale, rows = ['', '', '', '', ''];
    for (var i = 0; i < ds.length; i++) for (var r = 0; r < 5; r++) rows[r] += (i ? ' ' : '') + DIGITS[+ds.charAt(i)][r];
    setText(c, fontAt(scale, 800), 'center');
    c.lineJoin = 'round'; c.lineWidth = Math.max(2.5, cw * 0.55); c.strokeStyle = S.col.bg;
    for (r = 0; r < 5; r++) c.strokeText(rows[r], cx, cy + (r - 2) * rh);
    c.fillStyle = S.col.text;
    for (r = 0; r < 5; r++) c.fillText(rows[r], cx, cy + (r - 2) * rh);
  }

  var CLOUDS = [[20, 64, 1], [170, 112, 0.7], [300, 40, 0.85], [390, 92, 0.6]], CLOUD_P = 440;
  var STARS = (function () { var r = rng(7), a = []; for (var i = 0; i < 34; i++) a.push([r() * 600, r() * 250, r() < 0.2 ? '+' : r() < 0.5 ? '.' : '·']); return a; })();

  function draw(alpha) {
    if (!S || !S.ctx) return;
    var c = S.ctx, w = S.w, k = S.col, i, a = alpha || 0;
    var cam = w.pcam + (w.cam - w.pcam) * a, y = w.py + (w.y - w.py) * a, rot = w.prot + (w.rot - w.prot) * a;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.fillStyle = k.bg; c.fillRect(0, 0, VW, VH);
    setText(c, S.fnt);
    if (S.dark) {
      c.fillStyle = k.star;
      for (i = 0; i < STARS.length; i++) {
        var sx = ((STARS[i][0] - cam * 0.03) % 600 + 600) % 600 - 100;
        if (sx > -8 && sx < VW) c.fillText(STARS[i][2], sx, STARS[i][1]);
      }
    }
    c.fillStyle = k.cloud;
    for (i = 0; i < CLOUDS.length; i++) {
      var cx = ((CLOUDS[i][0] - cam * 0.1) % CLOUD_P + CLOUD_P) % CLOUD_P - 100, cl = CLOUDS[i][2] > 0.8 ? CLOUD_BIG : CLOUD_SMALL;
      if (cx < VW + 4) for (var r = 0; r < cl.length; r++) c.fillText(cl[r], cx, CLOUDS[i][1] + r * RHU);
    }
    ridge(c, FAR, cam * 0.22, 26, k.far);
    ridge(c, NEAR, cam * 0.5, 30, k.near);
    for (i = 0; i < w.cols.length; i++) {
      var pxl = w.cols[i].x - cam;
      if (pxl < VW + CWU && pxl + COL_W + CWU > 0) drawCol(c, w.cols[i], pxl);
    }
    // ground: one pre-rendered period, repeated and scrolled with the world
    var gt = S.groundT, gw = gt.w, g0 = -(((cam % gw) + gw) % gw);
    c.fillStyle = k.bg; c.fillRect(0, FLOOR, VW, GROUND);
    for (var gx = g0; gx < VW; gx += gw) c.drawImage(gt.cv, px(gx), FLOOR, gw, GROUND);

    if (w.state === 'ready') {
      label(c, 'GET READY', VW / 2, 100, 1.25, k.text, k.pipe);
      label(c, S.coarse ? 'tap to flap' : 'space / ↑ / click to flap', VW / 2, 138, 0.95, k.text);
      var best = S.best, md = medalFor(best);
      if (best > 0) label(c, 'best ' + best + (md ? ' · ' + md.name.toLowerCase() : ''), VW / 2, 254, 0.95, k.text);
    } else {
      var pop = S.rm ? 1 : 1 + 0.25 * Math.max(0, S.pop / 0.15);
      bigNumber(c, w.score, VW / 2, 44, 0.9 * pop);
    }
    if (S.banner && S.banner.t > 0) {
      c.globalAlpha = Math.min(1, S.banner.t / 0.3);
      var mc = S.dark ? S.banner.medal.color : S.banner.medal.ink;
      label(c, '* ' + S.banner.medal.name.toUpperCase() + ' MEDAL *', VW / 2, 92, 0.95, mc, mc);
      c.globalAlpha = 1;
    }
    drawBird(c, BIRD_X, y, rot, w.wing, w.state === 'dead');   // last: never hidden behind the HUD
    if (S.flash > 0 && !S.rm) {
      c.fillStyle = 'rgba(255,255,255,' + (S.flash / 0.25 * 0.6).toFixed(3) + ')';
      c.fillRect(0, 0, VW, VH);
    }
  }

  // ---- loop ----
  function looping() {
    if (!S || S.paused || S.ovlKind) return false;
    var w = S.w;
    return w.state !== 'dead' || !w.landed || w.deadT < 0.5 || S.flash > 0;
  }
  function kick() { if (S && !S.raf && looping()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function pollFlap() { if (S && S.flapQ > 0) { S.flapQ--; return true; } return false; }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    var dt = S.last ? Math.min(0.25, (ts - S.last) / 1000) : 0;
    S.last = ts;
    var alpha = advance(S.w, dt, pollFlap);
    S.pop = Math.max(0, S.pop - dt);
    S.flash = Math.max(0, S.flash - dt);
    if (S.banner) S.banner.t -= dt;
    handleEvents();
    draw(alpha);
    var w = S.w;
    if (w.state === 'dead' && w.landed && w.deadT >= 0.5 && !S.ovlKind) { showOverlay('over'); return; }
    if (looping()) S.raf = requestAnimationFrame(frame);
  }

  function handleEvents() {
    var w = S.w, ev = w.events, snd = S.snd;
    for (var i = 0; i < ev.length; i++) {
      switch (ev[i]) {
        case 'flap': snd.tone(460, 0.08, 'triangle', 0.05, 760); break;
        case 'score':
          S.pop = 0.15;
          snd.tone(880, 0.08, 'sine', 0.05); snd.tone(1320, 0.12, 'sine', 0.035, 0, 0.06);
          Cade.haptic(8);                       // light tick on phones that support vibration
          break;
        case 'medal':
          S.banner = { medal: medalFor(w.score), t: 1.6 };
          [784, 988, 1175, 1568].forEach(function (f, j) { snd.tone(f, 0.12, 'triangle', 0.04, 0, 0.12 + j * 0.08); });
          break;
        case 'hit':
          S.flash = 0.25;
          snd.tone(180, 0.2, 'square', 0.04, 70);
          Cade.haptic(28);
          S.newBest = w.score > S.best;
          if (S.newBest) { S.best = w.score; setBest(S.best); }
          syncBar();
          break;
        case 'land': snd.tone(95, 0.12, 'square', 0.04); break;
      }
    }
    ev.length = 0;
  }

  // ---- actions ----
  function act() {                            // the one button: flap / start / restart / resume
    if (!S) return;
    S.snd.ensure();
    if (S.paused) { resume(); return; }
    var w = S.w;
    if (w.state === 'dead') { if (w.deadT >= 0.35) restart(); return; }
    if (S.flapQ < 2) S.flapQ++;
    kick();
  }
  function restart() {
    S.w = newWorld((Math.random() * 4294967296) >>> 0);
    S.flapQ = 1;                              // instant: the restart tap is the first flap
    S.newBest = false; S.banner = null; S.flash = 0; S.pop = 0;
    showOverlay(null);
    kick();
  }
  function pause() {
    if (!S || S.paused || S.w.state !== 'play') return;
    S.paused = true; S.flapQ = 0;
    showOverlay('pause');
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    S.flapQ = 1;                              // the resume tap lifts the bird, so it can't drop straight onto a column
    showOverlay(null);
    kick();
  }

  // ASCII medal: a coin with the medal's initial (or an empty dashed one).
  function medalHtml(m) {
    var art = m ? [' .---. ', '(  ' + m.name.charAt(0) + '  )', " '---' "] : [' .- -. ', '(     )', " '- -' "];
    return '<pre class="fl-medal' + (m ? ' fl-m-' + m.key : '') + '" title="' + (m ? m.name + ' medal' : 'No medal yet') + '">' +
      art.join('\n') + '</pre>';
  }
  function overlayHtml(kind) {
    var w = S.w;
    if (kind === 'pause') {
      return '<div class="fl-card"><div class="fl-title">PAUSED</div><div class="fl-sub">score ' + w.score + '</div>' +
        '<button type="button" class="fl-go" data-act="resume">[ resume ]</button>' +
        '<div class="fl-note">' + (S.coarse ? 'tap anywhere' : 'space / p / click') + ' — resuming gives you a flap</div></div>';
    }
    var m = medalFor(w.score), nm = null;
    for (var i = MEDALS.length - 1; i >= 0; i--) if (MEDALS[i].at > w.score) { nm = MEDALS[i]; break; }
    return '<div class="fl-card"><div class="fl-title">GAME OVER</div>' +
      '<div class="fl-res">' + medalHtml(m) +
      '<div class="fl-nums"><div><span>score</span><b>' + w.score + '</b></div><div><span>best</span><b>' + S.best + '</b></div></div></div>' +
      (S.newBest && w.score > 0 ? '<div class="fl-new">** new best **</div>' : '') +
      '<button type="button" class="fl-go" data-act="restart">[ play again ]</button>' +
      '<div class="fl-note">' + (nm ? (nm.at - w.score) + ' more for ' + nm.name.toLowerCase() : 'top medal — nice flying') +
      ' · ' + (S.coarse ? 'tap' : 'space') + ' to retry</div></div>';
  }
  function showOverlay(kind) {
    S.ovlKind = kind;
    S.ovl.innerHTML = kind ? overlayHtml(kind) : '';
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind);
    syncBar();
  }
  function syncBar() {
    if (!S) return;
    var pb = S.bar.querySelector('[data-act="pause"]'), sb = S.bar.querySelector('[data-act="sound"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = !(S.paused || S.w.state === 'play');
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.classList.toggle('on', S.snd.on);
    var m = medalFor(S.best);
    S.hint.innerHTML = 'best <b>' + S.best + '</b>' + (m ? ' <i class="fl-dot fl-m-' + m.key + '" title="' + m.name + ' medal">(' + m.name.charAt(0) + ')</i>' : '');
  }

  // ---- input ----
  var KEY2CODE = { ' ': 'Space', arrowup: 'ArrowUp', w: 'KeyW', enter: 'Enter', p: 'KeyP', escape: 'Escape' };
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return; // parked in the dock: keys belong to the editor
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !S.panel.contains(t)) return;
    var code = e.code || KEY2CODE[(e.key || '').toLowerCase()] || '';
    if (code === 'Escape') {
      e.preventDefault();
      if (S.w.state === 'play' && !S.paused) pause(); else closePanel();
      return;
    }
    if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
    if (code === 'Space' || code === 'ArrowUp' || code === 'KeyW' || code === 'Enter' || code === 'NumpadEnter') {
      e.preventDefault();
      if (!e.repeat) act();                   // holding the key must not machine-gun flaps
    }
  }

  // ---- layout ----
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
    var s = Math.min((vw - 48) / VW, availH(vw, vh) / VH, 1.3);
    s = Math.max(s, 0.6);
    var cw = Math.floor(VW * s), ch = Math.floor(VH * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / VW;
    if (S.col) buildTiles();
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    clearTimeout(s.resizeT);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
  }
  function closePanel() {
    var p = document.getElementById('flappy-panel');
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }

  function open() {
    Cade.closeAllMenus();
    if (document.getElementById('flappy-panel')) { closePanel(); return; }
    var body = '<div class="fl"><div class="fl-stage"><canvas class="fl-cv" aria-label="Flit game"></canvas><div class="fl-ovl"></div></div>' +
      '<div class="fl-bar"><span class="fl-hint"></span>' +
      '<button type="button" class="fl-ib" data-act="sound"></button>' +
      '<button type="button" class="fl-ib" data-act="pause"></button></div></div>';
    var p = Cade.mkPanel('flappy-panel', '🐦 Flit', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var mm = window.matchMedia, soundOn = false;
    try { soundOn = Cade.store.get(SOUND_KEY) === '1'; } catch (e) {}
    S = {
      panel: p, stage: p.querySelector('.fl-stage'), cv: p.querySelector('.fl-cv'), ovl: p.querySelector('.fl-ovl'),
      bar: p.querySelector('.fl-bar'), hint: p.querySelector('.fl-hint'),
      snd: new Snd(soundOn), best: getBest(), newBest: false,
      rm: false,
      coarse: !!(mm && mm('(pointer: coarse)').matches),
      w: newWorld((Math.random() * 4294967296) >>> 0), flapQ: 0, raf: 0, last: 0, paused: false, ovlKind: null,
      pop: 0, flash: 0, banner: null, k: 1
    };
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    layout();
    readTheme();

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { pause(); };
    window.addEventListener('blur', S.onBlur);
    // Minimized to the dock: pause like a tab switch (the pause card waits for the
    // player after restore) and stop drawing meanwhile; restore restarts the loop.
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      pause();
      if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    });
    p.addEventListener('cade-panel-restore', function () { if (S && S.panel === p) kick(); });
    S.onResize = function () {
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S) { layout(); draw(0); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () { if (S) { readTheme(); draw(0); } });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    S.cv.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;               // primary button / touch only
      e.preventDefault();
      act();
    });
    // iOS unlocks WebAudio on touchend rather than touchstart: retry there too.
    S.cv.addEventListener('pointerup', function () { if (S) S.snd.ensure(); });
    // Over a card: tap anywhere resumes / restarts (buttons are the visible affordance;
    // their click covers keyboard activation, and act() ignores the duplicate).
    S.ovl.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      act();
    });
    S.ovl.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (b && S && S.ovlKind) act();
    });
    S.bar.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      if (b.dataset.act === 'sound') {
        S.snd.on = !S.snd.on;
        try { Cade.store.set(SOUND_KEY, S.snd.on ? '1' : '0'); } catch (er) {}
        S.snd.ensure();
        S.snd.tone(880, 0.07, 'sine', 0.04);
        syncBar();
      } else if (b.dataset.act === 'pause') { if (S.paused) resume(); else pause(); }
      try { b.blur(); } catch (er) {}
    });
    syncBar();
    showOverlay(null);
    draw(0);
    kick();
    // The glyph grid is fitted to the mono font's advance: refit once it has loaded.
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('600 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); draw(0); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: 'Flit',
    description: 'One-button flyer — tap to flap through the gaps, chase medals',
    icon: '🐦',
    tags: 'game,arcade,fun,train,flap,bird,tap,one button,endless',
    open: open,
    // Pure engine, exposed for headless checks (node) — not used by the app.
    _engine: { STEP: STEP, VW: VW, FLOOR: FLOOR, BIRD_X: BIRD_X, HIT_R: HIT_R, COL_W: COL_W, MEDALS: MEDALS,
      newWorld: newWorld, stepWorld: stepWorld, advance: advance, medalFor: medalFor, speedFor: speedFor, gapFor: gapFor }
  });
})();
