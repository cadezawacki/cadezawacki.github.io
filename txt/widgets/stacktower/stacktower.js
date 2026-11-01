/* Stack Tower — one-button tower stacking, for Cade.txt.
 * A block slides back and forth over the top of the tower; tap (the play
 * field, the big DROP button, Space / Enter / ↓, a gamepad's A) to drop it.
 * Whatever hangs over the edge is sliced off and tumbles away as debris; a
 * drop within a hair of the block below is PERFECT: it snaps into place, the
 * streak grows, and from the third perfect in a row the block grows back.
 * Every layer the slide gets a little faster and the camera rises; the
 * colours walk around the hue wheel one step per layer.
 * Modes: Classic, Turbo (starts fast), vs CPU (easy / medium / hard: take
 * turns on one tower — whoever misses loses) and 2 players (the same, pass
 * and play on one device).
 * Drawn in monospace glyphs (cached in a glyph atlas) on a canvas. Physics
 * (the slider, the debris, the camera) runs on a fixed 120 Hz step with an
 * accumulator and the renderer interpolates, so it is the same at 60 or
 * 120 Hz. The loop runs only while a game is on screen; it pauses on blur,
 * tab hide and minimize. Records persist in Cade.store (cade-stacktower-*).
 * Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World units: logical px. x → right, y → up. The ground's top is y = 0;
  // layer n spans y ∈ [n·LH, (n+1)·LH]. Layer 0 is the plinth.
  var STEP = 1 / 120;
  var FW = 320, LH = 12, W0 = 128, MIN_W = 1;
  var G = 1100;                                 // debris gravity (px/s²)
  var V0 = { classic: 120, turbo: 185, cpu: 120, duel: 120 }, VK = 0.03, VMAX = 360;
  var GROW_N = 3, GROW = 8;                     // the 3rd perfect in a row onward grows the block
  var FALL_T = 1.6;                             // seconds from a miss to the results
  var MAX_DEBRIS = 64;
  var HOLD = 0.45;                              // 2 players: the next slider waits a beat, so a double tap can't drop it
  var MODES = ['classic', 'turbo', 'cpu', 'duel'];
  var CPU_LEVELS = [
    { id: 'easy', name: 'Easy', ts: 0.09, think: 0.55 },
    { id: 'medium', name: 'Medium', ts: 0.042, think: 0.42 },
    { id: 'hard', name: 'Hard', ts: 0.026, think: 0.3 }
  ];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) {
    var u = Math.max(1e-9, r()), v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function speedAt(mode, n) { return Math.min(VMAX, (V0[mode] || V0.classic) * (1 + VK * Math.max(0, n - 1))); }
  function tolAt(v) { return clamp(v * 0.03, 3, 8); }
  // The slider's left-edge range for a block of width w: it sweeps the whole
  // field (a hair past the edges), at least ±48 px around the middle.
  function rangeOf(w) {
    var A = Math.max(48, (FW - w) / 2 + 8);
    return { lo: FW / 2 - w / 2 - A, hi: FW / 2 - w / 2 + A };
  }

  function newGame(opts) {
    opts = opts || {};
    var mode = MODES.indexOf(opts.mode) >= 0 ? opts.mode : 'classic', seed = (opts.seed >>> 0) || 1;
    var g = {
      mode: mode, seed: seed, r: rng(seed), lvl: clamp(opts.lvl | 0, 0, CPU_LEVELS.length - 1),
      players: mode === 'cpu' || mode === 'duel' ? 2 : 1, turn: 0,
      blocks: [{ x: (FW - W0) / 2, w: W0, n: 0, perfect: false }], m: null, debris: [],
      phase: 'play', t: 0, acc: 0, steps: 0, score: 0, height: 0, combo: 0, bestCombo: 0, perfects: 0, grows: 0, cuts: 0,
      pts: [0, 0], pp: [0, 0], drops: [0, 0], loser: -1, overT: 0,
      cam: 1, pcam: 1, hue0: seed % 36, events: [], last: null, plan: null
    };
    spawn(g);
    return g;
  }
  function top(g) { return g.blocks[g.blocks.length - 1]; }
  function isCpuTurn(g) { return g.mode === 'cpu' && g.turn === 1; }
  // May a human drop right now? (playing, a slider out, not the CPU's turn, not on the hand-off beat)
  function canDrop(g) { return g.phase === 'play' && !!g.m && !(g.m.hold > 0) && !isCpuTurn(g); }

  // A new slider for the next layer: odd layers come from the left, even from the right.
  function spawn(g) {
    var n = g.blocks.length, w = top(g).w, R = rangeOf(w), fromL = n % 2 === 1;
    var x = fromL ? R.lo : R.hi;
    g.m = { x: x, px: x, w: w, dir: fromL ? 1 : -1, v: speedAt(g.mode, n), n: n, lo: R.lo, hi: R.hi, hold: g.mode === 'duel' && n > 1 ? HOLD : 0 };
    g.plan = isCpuTurn(g) ? cpuPlan(g) : null;
  }
  // The CPU's aim for this drop: an error (px from a perfect line-up) drawn
  // from its level's timing spread (seconds, like a human's reaction jitter,
  // so faster sliders mean bigger misses); and a beat to think.
  function cpuPlan(g) {
    var L = CPU_LEVELS[g.lvl], m = g.m, sp = Math.max(1, L.ts * m.v);
    return { err: gauss(g.r) * sp, wait: L.think * (0.7 + 0.6 * g.r()) };
  }

  function addDebris(g, x, w, n, side, vx, whole) {
    var r = g.r, k = clamp(160 / Math.max(4, w), 1.2, 9);
    var d = {
      x: x + w / 2, y: n * LH + LH / 2, w: w, h: LH, a: 0, n: n,
      vx: vx + side * (18 + r() * 26), vy: whole ? 30 : 6, va: -side * k * (0.7 + r() * 0.6),
      px: 0, py: 0, pa: 0, t: 0, rest: false
    };
    d.px = d.x; d.py = d.y; d.pa = d.a;
    g.debris.push(d);
    if (g.debris.length > MAX_DEBRIS) {
      for (var i = 0; i < g.debris.length; i++) if (g.debris[i].rest) { g.debris.splice(i, 1); break; }
      if (g.debris.length > MAX_DEBRIS) g.debris.shift();
    }
    return d;
  }

  // Drop the slider. alpha: where the renderer last showed it between the
  // last two steps (0..1), so the drop lands where the player saw it.
  function drop(g, alpha) {
    if (g.phase !== 'play' || !g.m) return null;
    var m = g.m, tp = top(g), a = alpha == null ? 1 : clamp(alpha, 0, 1);
    var x = m.px + (m.x - m.px) * a;
    if (x < m.lo || x > m.hi) x = m.x;                    // a bounce inside the step: use the step's end
    var d = x - tp.x, lo = Math.max(x, tp.x), hi = Math.min(x + m.w, tp.x + tp.w), tol = tolAt(m.v), p = g.turn;
    var res = { n: m.n, player: p, off: d, perfect: false, grow: 0, cut: 0, miss: false, gain: 0, x: x, w: m.w };
    g.drops[p]++;
    if (Math.abs(d) > tol && hi - lo < MIN_W) {           // missed the tower
      res.miss = true;
      addDebris(g, x, m.w, m.n, d < 0 ? -1 : 1, m.dir * m.v * 0.35, true);
      g.m = null; g.plan = null; g.phase = 'fall'; g.overT = 0; g.loser = p;
      g.combo = 0;
      g.events.push('miss');
      g.last = res;
      return res;
    }
    var bx, bw, perfect = Math.abs(d) <= tol;
    if (perfect) {
      bx = tp.x; bw = tp.w;
      g.combo++; g.perfects++; g.pp[p]++;
      if (g.combo > g.bestCombo) g.bestCombo = g.combo;
      if (g.combo >= GROW_N && bw < W0) {
        var nw = Math.min(W0, bw + GROW);
        res.grow = nw - bw; bx -= res.grow / 2; bw = nw; g.grows++;
      }
    } else {
      bx = lo; bw = hi - lo;
      res.cut = m.w - bw; g.cuts++;
      if (x < lo) addDebris(g, x, lo - x, m.n, -1, m.dir * m.v * 0.25);
      else addDebris(g, hi, x + m.w - hi, m.n, 1, m.dir * m.v * 0.25);
      g.combo = 0;
    }
    res.perfect = perfect;
    g.blocks.push({ x: bx, w: bw, n: m.n, perfect: perfect });
    g.height = g.blocks.length - 1;
    res.gain = 1 + (perfect ? Math.min(g.combo, 5) : 0);
    g.score += res.gain; g.pts[p] += res.gain;
    g.events.push('place');
    if (perfect) g.events.push('perfect');
    if (res.grow) g.events.push('grow');
    if (g.height % 10 === 0) g.events.push('milestone');
    if (g.players === 2) { g.turn = 1 - g.turn; g.events.push('turn'); }
    g.last = res;
    spawn(g);
    return res;
  }

  // The height debris can rest on at x: the top of the run of layers that
  // cover x from the plinth up (the ledges a slice leaves), else the ground.
  function supportAt(g, x) {
    var B = g.blocks, k = 0;
    while (k < B.length && x >= B[k].x && x <= B[k].x + B[k].w) k++;
    return k * LH;
  }
  function stepDebris(g, dt) {
    var L = g.debris;
    for (var i = L.length - 1; i >= 0; i--) {
      var d = L[i];
      d.px = d.x; d.py = d.y; d.pa = d.a;
      if (d.rest) { d.t += dt; continue; }
      d.t += dt;
      d.vy -= G * dt;
      var ox = d.x;
      d.x += d.vx * dt; d.y += d.vy * dt; d.a += d.va * dt;
      var sa = Math.abs(Math.sin(d.a)), ca = Math.abs(Math.cos(d.a)), half = sa * d.w / 2 + ca * d.h / 2;
      d.fl = Math.min(supportAt(g, d.x), d.n * LH);
      if (d.y - half < d.fl - 4) {                        // ran into the side of a ledge: knock it back
        d.x = ox; d.vx = -d.vx * 0.3;
        d.fl = Math.min(supportAt(g, d.x), d.n * LH);
      }
      if (d.y - half < d.fl) {                            // the ground or a ledge: bounce, scrub, settle flat
        d.y = d.fl + half;
        if (d.vy < 0) d.vy = -d.vy * 0.22;
        d.vx *= 0.72;
        var q = Math.PI / 2, tgt = Math.round(d.a / q) * q;
        if (d.w > d.h * 1.6) tgt = Math.round(d.a / Math.PI) * Math.PI;   // a slab rests on its long side
        d.a += (tgt - d.a) * 0.18; d.va *= 0.55;
        d.y = d.fl + Math.abs(Math.sin(d.a)) * d.w / 2 + Math.abs(Math.cos(d.a)) * d.h / 2;   // the turn changed its footprint
        if (Math.abs(d.vy) < 40 && Math.abs(d.va) < 0.8 && Math.abs(d.vx) < 10) {
          d.rest = true; d.a = tgt; d.vx = d.vy = d.va = 0;
          d.y = d.fl + Math.abs(Math.sin(d.a)) * d.w / 2 + Math.abs(Math.cos(d.a)) * d.h / 2;
        }
      }
      if (d.t > 12) L.splice(i, 1);
    }
  }

  function stepGame(g) {
    if (g.phase === 'done') return;
    var dt = STEP, m = g.m;
    g.steps++; g.t += dt; g.pcam = g.cam;
    if (m) {
      m.px = m.x;
      if (m.hold > 0) m.hold = Math.max(0, m.hold - dt);
      else m.x += m.dir * m.v * dt;
      if (m.x > m.hi) { m.x = 2 * m.hi - m.x; m.dir = -1; }
      else if (m.x < m.lo) { m.x = 2 * m.lo - m.x; m.dir = 1; }
      if (g.phase === 'play' && g.plan && isCpuTurn(g)) {
        var P = g.plan;
        if (P.wait > 0) P.wait -= dt;
        else {
          var tgt = top(g).x + P.err;
          if ((m.px - tgt) * (m.x - tgt) <= 0) drop(g, (tgt - m.px) / ((m.x - m.px) || 1));
        }
      }
    }
    stepDebris(g, dt);
    var ct = g.phase === 'play' ? g.blocks.length : g.blocks.length - 0.5;
    g.cam += (ct - g.cam) * (1 - Math.exp(-7 * dt));
    if (g.phase === 'fall') {
      g.overT += dt;
      if (g.overT >= FALL_T) { g.phase = 'done'; g.events.push('done'); }
    }
  }

  // Advance real time dt on the fixed step; returns the render interpolation alpha.
  function advance(g, dt) {
    g.acc = Math.min(g.acc + dt, 0.25);
    while (g.acc >= STEP && g.phase !== 'done') { stepGame(g); g.acc -= STEP; }
    return g.phase === 'done' ? 1 : g.acc / STEP;
  }
  function winner(g) { return g.players === 2 && g.loser >= 0 ? 1 - g.loser : -1; }
  function summary(g) {
    return { mode: g.mode, lvl: g.lvl, score: g.score, height: g.height, perfects: g.perfects, combo: g.bestCombo, grows: g.grows,
      cuts: g.cuts, winner: winner(g), pts: g.pts.slice(), pp: g.pp.slice(), time: g.t };
  }

  // ---- the save: records per solo mode, CPU wins / losses per level ----
  function newSave() {
    return { v: 1, games: 0, layers: 0, perfects: 0, mode: 'classic', lvl: 1,
      best: { classic: { score: 0, height: 0, combo: 0 }, turbo: { score: 0, height: 0, combo: 0 } },
      cpu: { w: [0, 0, 0], l: [0, 0, 0] }, duels: 0 };
  }
  function nn(v) { v = +v; return isFinite(v) && v > 0 ? Math.floor(v) : 0; }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    s.games = nn(o.games); s.layers = nn(o.layers); s.perfects = nn(o.perfects); s.duels = nn(o.duels);
    if (MODES.indexOf(o.mode) >= 0) s.mode = o.mode;
    if (o.lvl === 0 || o.lvl === 1 || o.lvl === 2) s.lvl = o.lvl;
    ['classic', 'turbo'].forEach(function (md) {
      var b = o.best && o.best[md];
      if (b && typeof b === 'object') for (var k in s.best[md]) s.best[md][k] = nn(b[k]);
    });
    if (o.cpu && typeof o.cpu === 'object') ['w', 'l'].forEach(function (k) {
      if (Array.isArray(o.cpu[k])) for (var i = 0; i < 3; i++) s.cpu[k][i] = nn(o.cpu[k][i]);
    });
    return s;
  }
  // Fold a finished game into the save; returns the results card's data.
  function settle(save, res) {
    var nb = {}, win = null;
    save.games++; save.layers += res.height; save.perfects += res.perfects;
    if (res.mode === 'classic' || res.mode === 'turbo') {
      var b = save.best[res.mode], map = { score: res.score, height: res.height, combo: res.combo };
      for (var k in map) if (map[k] > b[k]) { nb[k] = true; b[k] = map[k]; }
    } else if (res.mode === 'cpu') {
      win = res.winner === 0;
      save.cpu[win ? 'w' : 'l'][res.lvl]++;
    } else save.duels++;
    return { best: nb, win: win };
  }
  function bestOf(save, mode) { return save.best[mode] ? save.best[mode] : null; }

  var ENGINE = {
    STEP: STEP, HOLD: HOLD, FW: FW, LH: LH, W0: W0, G: G, GROW_N: GROW_N, GROW: GROW, FALL_T: FALL_T, VMAX: VMAX, MODES: MODES, CPU_LEVELS: CPU_LEVELS,
    rng: rng, speedAt: speedAt, tolAt: tolAt, rangeOf: rangeOf, newGame: newGame, top: top, isCpuTurn: isCpuTurn, canDrop: canDrop, spawn: spawn,
    drop: drop, stepGame: stepGame, stepDebris: stepDebris, supportAt: supportAt, advance: advance, winner: winner, summary: summary,
    newSave: newSave, normSave: normSave, settle: settle, bestOf: bestOf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('stacktower.css');

  var PANEL_ID = 'stacktower-panel', NAME = 'Stack Tower';
  var KEY = 'cade-stacktower-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var VW = FW, CW = 8, RH = LH, NH = 36;
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.stacktower = { live: function () { return S; } };   // test-only peek

  // palette slots: fixed colours, then NH hues around the wheel (the layers)
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOLD = 4, C_RED = 5, C_CLOUD = 6, C_STAR = 7, C_GRASS = 8, C_HUE = 9, NPAL = C_HUE + NH;
  var P_SLOT = [C_ACC, C_GOLD];

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }

  // ---- sound: a tiny WebAudio voice, created on a user gesture, closed with the panel ----
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
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  // a short filtered noise burst: the slice
  Snd.prototype.noise = function (dur, vol, freq) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      if (!this.nb) {
        var len = Math.floor(ac.sampleRate * 0.3), b = ac.createBuffer(1, len, ac.sampleRate), d = b.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.nb = b;
      }
      var t = ac.currentTime, s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = this.nb; f.type = 'bandpass'; f.frequency.value = freq || 2400; f.Q.value = 0.9;
      g.gain.setValueAtTime(vol || 0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(ac.destination);
      s.start(t); s.stop(t + dur + 0.02);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; this.nb = null; } };
  // a major pentatonic, climbing with the streak
  var PENTA = [0, 2, 4, 7, 9];
  function note(i) { return 392 * Math.pow(2, (Math.floor(i / 5) * 12 + PENTA[((i % 5) + 5) % 5]) / 12); }

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');

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
  function hsl(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    function f(n) { var k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); }
    return [f(0), f(8), f(4)];
  }
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.55)), fa = parseCol(v('--text-faint'), mix(bg, tx, 0.35));
    var P = S.pal;
    S.dark = dark;
    P[C_TEXT] = css(tx); P[C_MUTED] = css(mu); P[C_FAINT] = css(fa); P[C_ACC] = css(ac);
    P[C_GOLD] = dark ? '#f2c544' : '#b07d06'; P[C_RED] = dark ? '#f06a6a' : '#cf3f3f';
    P[C_CLOUD] = css(mix(bg, tx, dark ? 0.22 : 0.18)); P[C_STAR] = css(mix(bg, tx, dark ? 0.5 : 0.35));
    P[C_GRASS] = dark ? '#6fbf6a' : '#3f8f3a';
    S.fill = []; S.rim = [];
    for (var i = 0; i < NH; i++) {
      var h = hsl(i * 360 / NH, dark ? 0.62 : 0.6, dark ? 0.64 : 0.47);
      P[C_HUE + i] = css(dark ? mix(h, [255, 255, 255], 0.08) : h);
      S.fill.push(css(mix(bg, h, dark ? 0.3 : 0.28)));
      S.rim.push(css(mix(bg, h, dark ? 0.55 : 0.6)));
    }
    S.col = {
      bg: css(bg), hud: css(bg, 0.9), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace',
      ground: css(mix(bg, tx, dark ? 0.1 : 0.07)), plinth: css(mix(bg, tx, dark ? 0.2 : 0.14)),
      sky: dark ? [16, 22, 58] : [40, 70, 150], ac: ac, bgc: bg
    };
    fitFont();
  }

  // ---- glyph rendering (as in Dusk Dash): a CW × RH grid, glyphs cached in an atlas ----
  var AT_COLS = 24, AT_ROWS = 20;
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '700 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = Math.min(CW / adv, RH * 1.05);
    S.fnt = '700 ' + S.fpx.toFixed(3) + 'px ' + f;
    buildAtlas();
    buildClouds();
  }
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.k || !S.col) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    a.sc = 2;
    a.cwp = Math.ceil((CW + 6) * S.k * a.sc); a.chp = Math.ceil((RH + 6) * S.k * a.sc);
    a.cv.width = a.cwp * AT_COLS; a.cv.height = a.chp * AT_ROWS;
    a.c = a.cv.getContext('2d');
    a.c.font = '700 ' + (S.fpx * S.k * a.sc).toFixed(3) + 'px ' + S.col.font;
    a.c.textAlign = 'center'; a.c.textBaseline = 'middle';
    a.cw = a.cwp / S.k / a.sc; a.ch = a.chp / S.k / a.sc; a.n = 0; a.max = AT_COLS * AT_ROWS;
    S.gmap = [];
    for (var i = 0; i < NPAL; i++) { var m = new Int16Array(128); for (var j = 0; j < 128; j++) m[j] = -1; S.gmap.push(m); }
  }
  function gIdx(ci, code) {
    if (code >= 128) return -1;
    var m = S.gmap[ci], i = m[code], a = S.atl;
    if (i >= 0) return i;
    if (a.n >= a.max) return -1;
    i = a.n++;
    a.c.fillStyle = S.pal[ci];
    a.c.fillText(String.fromCharCode(code), (i % AT_COLS) * a.cwp + a.cwp / 2, ((i / AT_COLS) | 0) * a.chp + a.chp / 2);
    m[code] = i;
    return i;
  }
  function glyph(c, ci, code, x, y, nosnap, sc) {
    if (code === 32) return;
    var i = gIdx(ci, code), a = S.atl;
    if (i < 0) {
      c.font = sc ? '700 ' + (S.fpx * sc).toFixed(3) + 'px ' + S.col.font : S.fnt;
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = S.pal[ci];
      c.fillText(String.fromCharCode(code), x, y);
      return;
    }
    var w = sc ? a.cw * sc : a.cw, h = sc ? a.ch * sc : a.ch, dx = x - w / 2, dy = y - h / 2;
    if (!nosnap) { dx = Math.round(dx * S.k) / S.k; dy = Math.round(dy * S.k) / S.k; }
    c.drawImage(a.cv, (i % AT_COLS) * a.cwp, ((i / AT_COLS) | 0) * a.chp, a.cwp, a.chp, dx, dy, w, h);
  }
  function drawStr(c, ci, s, x, y, align, nosnap, sc) {
    var n = s.length, cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, s.charCodeAt(i), x0 + i * cw + cw / 2, y, nosnap, sc);
    return x0 + n * cw;
  }
  var NB = new Uint8Array(24);
  function writeNum(v) {
    var n = 0, ip = Math.max(0, Math.round(v));
    do { NB[n++] = 48 + ip % 10; ip = Math.floor(ip / 10); } while (ip > 0 && n < 20);
    for (var a = 0, b = n - 1; a < b; a++, b--) { var t = NB[a]; NB[a] = NB[b]; NB[b] = t; }
    return n;
  }
  function drawNum(c, ci, n, x, y, align, sc) {
    var cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, NB[i], x0 + i * cw + cw / 2, y, false, sc);
    return x0 + n * cw;
  }

  // Clouds, pre-rendered once per theme / size (original shapes).
  var CLOUD_SHAPES = [
    ['   .-~~-.', ' (        )_', '(___________)'],
    ['  .~.', '(    )-.', '(_______)'],
    ['    _.--._', ' .-(      )-.', '(_____________)']
  ];
  function buildClouds() {
    if (!S.k || !S.col) return;
    if (S.cloudT) S.cloudT.forEach(function (t) { freeCanvas(t.cv); });
    S.cloudT = CLOUD_SHAPES.map(function (sh) {
      var w = 0;
      sh.forEach(function (r) { w = Math.max(w, r.length); });
      var cv = document.createElement('canvas'), wl = w * CW + 4, hl = sh.length * RH + 6;
      cv.width = Math.ceil(wl * S.k); cv.height = Math.ceil(hl * S.k);
      var c = cv.getContext('2d');
      c.setTransform(S.k, 0, 0, S.k, 0, 0);
      c.font = S.fnt; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillStyle = S.pal[C_CLOUD];
      sh.forEach(function (r, i) { c.fillText(r, 2, 3 + i * RH + RH / 2); });
      return { cv: cv, w: wl, h: hl };
    });
  }
  var CLOUDS = (function () {
    var r = rng(9), a = [];
    for (var i = 0; i < 22; i++) a.push({ x: r() * 520 - 100, y: (14 + r() * 70) * LH, s: Math.floor(r() * 3), sp: 4 + r() * 8 });
    return a;
  })();
  var STARS = (function () {
    var r = rng(13), a = [];
    for (var i = 0; i < 70; i++) a.push({ x: r() * VW, y: r(), c: r() < 0.12 ? 43 : r() < 0.25 ? 42 : 46 });
    return a;
  })();
  var TREES = [[-150, 0], [-118, 1], [-96, 0], [-70, 2], [384, 0], [408, 2], [436, 1], [460, 0], [30, 1], [282, 2]];

  // ---- particles (world space, y up) and pop-ups; pools allocated once ----
  var NPART = 90, NPOP = 8;
  function makeFx() {
    S.parts = [];
    for (var i = 0; i < NPART; i++) S.parts.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, code: 46, ci: 0, g: 0 });
    S.pops = [];
    for (i = 0; i < NPOP; i++) S.pops.push({ on: false, x: 0, y: 0, t: 0, v: 0, ci: C_GOLD });
    S.ripples = [];
    S.pi = 0; S.qi = 0;
  }
  function clearFx() {
    for (var i = 0; i < NPART; i++) S.parts[i].on = false;
    for (i = 0; i < NPOP; i++) S.pops[i].on = false;
    S.ripples.length = 0;
  }
  function spark(x, y, vx, vy, life, code, ci, g) {
    var p = S.parts[S.pi]; S.pi = (S.pi + 1) % NPART;
    p.on = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.t = 0; p.life = life; p.code = code; p.ci = ci; p.g = g || 0;
  }
  function burst(x, y, n, sp, codes, ci, g, life, up) {
    if (S.rm) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = sp * (0.35 + Math.random() * 0.65);
      spark(x, y, Math.cos(a) * v, (up ? Math.abs(Math.sin(a)) : Math.sin(a)) * v, life * (0.6 + Math.random() * 0.5),
        codes.charCodeAt(i % codes.length), ci < 0 ? (i % 2 ? C_ACC : C_GOLD) : ci, g);
    }
  }
  function popup(x, y, v, ci) {
    var p = S.pops[S.qi]; S.qi = (S.qi + 1) % NPOP;
    p.on = true; p.x = x; p.y = y; p.t = 0; p.v = v; p.ci = ci;
  }
  function stepFx(dt) {
    var i, p;
    for (i = 0; i < NPART; i++) {
      p = S.parts[i];
      if (!p.on) continue;
      p.t += dt;
      if (p.t >= p.life) { p.on = false; continue; }
      p.vy -= p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (i = 0; i < NPOP; i++) { p = S.pops[i]; if (p.on && (p.t += dt) > 1) p.on = false; }
    for (i = S.ripples.length - 1; i >= 0; i--) if ((S.ripples[i].t += dt) > 0.5) S.ripples.splice(i, 1);
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt);
    if (S.flash > 0) S.flash = Math.max(0, S.flash - dt);
    if (S.landT < 1) S.landT += dt;
    if (S.msg && (S.msg.t += dt) > S.msg.dur) S.msg = S.msgQ.length ? S.msgQ.shift() : null;
  }
  function say(text, ci, dur, queue) {
    var m = { text: text, ci: ci == null ? C_TEXT : ci, t: 0, dur: dur || 1 };
    if (queue && S.msg && S.msgQ.length < 3) S.msgQ.push(m); else { S.msg = m; S.msgQ.length = 0; }
  }

  // ---- the scene ----
  function hueSlot(g, n) { return (g.hue0 + n) % NH; }
  function easeOut(t) { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t) * (1 - t); }
  // Camera: z (px per world px) and the world y at the bottom edge. While
  // playing, the slider sits ~42% from the top; after a miss it pulls back
  // to show the whole tower.
  function view(g, a) {
    var v = S.v, VH = S.VH;
    var cam = g.pcam + (g.cam - g.pcam) * a;
    var b = Math.max(-Math.max(46, VH * 0.2), cam * LH - VH * 0.58);
    var z = 1;
    if (S.zoomT > 0) {
      var H = (g.blocks.length + 3) * LH + 46, zf = Math.min(1, (VH - 70) / H), e = easeOut(S.zoomT);
      z = 1 + (zf - 1) * e;
      b = b + (-46 / z - b) * e;
    }
    v.z = z; v.bottom = b;
    return v;
  }
  function X(v, wx) { return (wx - FW / 2) * v.z + VW / 2; }
  function Y(v, wy) { return S.VH - (wy - v.bottom) * v.z; }

  // One block: a soft fill, a rim, and a row of glyphs [====] stretched over its width.
  function drawBlock(c, v, x, w, n, slot, ch, lift, bright) {
    var z = v.z, sx = X(v, x), sw = w * z, sy = Y(v, (n + 1) * LH + (lift || 0)), sh = LH * z;
    if (sx > VW || sx + sw < 0 || sy > S.VH || sy + sh < 0) return;
    c.fillStyle = S.fill[slot]; c.fillRect(sx, sy, sw, sh);
    if (z < 0.45) { c.fillStyle = S.rim[slot]; c.fillRect(sx, sy, sw, Math.max(1 / S.k, sh * 0.25)); return; }
    c.fillStyle = S.rim[slot]; c.fillRect(sx, sy, sw, 1 / S.k * 1.5); c.fillRect(sx, sy + sh - 1 / S.k, sw, 1 / S.k);
    var ci = bright ? C_TEXT : C_HUE + slot, cy = sy + sh / 2, sc = z < 1 ? z : 0;
    if (sw < CW * z * 1.4) { glyph(c, ci, 124, sx + sw / 2, cy, true, sc); return; }
    var k = Math.max(2, Math.round(sw / (CW * z))), step = sw / k;
    for (var i = 0; i < k; i++) {
      var code = i === 0 ? 91 : i === k - 1 ? 93 : ch;
      glyph(c, ci, code, sx + step * (i + 0.5), cy, true, sc);
    }
  }
  function drawDebris(c, v, g, a, d) {
    var x = d.px + (d.x - d.px) * a, y = d.py + (d.y - d.py) * a, an = d.pa + (d.a - d.pa) * a;
    var sx = X(v, x), sy = Y(v, y);
    if (sy > S.VH + 80 || sy < -80) return;
    var fade = d.rest ? clamp(1 - (d.t - 6) / 4, 0.25, 1) : 1, slot = hueSlot(g, d.n);
    c.save();
    c.globalAlpha = fade;
    c.translate(sx, sy); c.rotate(-an); c.scale(v.z, v.z);
    var w = d.w, h = d.h;
    c.fillStyle = S.fill[slot]; c.fillRect(-w / 2, -h / 2, w, h);
    c.fillStyle = S.rim[slot]; c.fillRect(-w / 2, -h / 2, w, 1.5 / S.k);
    if (w < CW * 1.4) glyph(c, C_HUE + slot, 124, 0, 0, true);
    else {
      var k = Math.max(2, Math.round(w / CW)), st = w / k;
      for (var i = 0; i < k; i++) glyph(c, C_HUE + slot, i === 0 ? 91 : i === k - 1 ? 93 : 61, -w / 2 + st * (i + 0.5), 0, true);
    }
    c.restore();
  }

  function draw(alpha, dt) {
    if (!S || !S.ctx || !S.atl) return;
    var g = S.g || S.hg, c = S.ctx, VH = S.VH, v = view(g, alpha), i, n, t = S.idleT;
    S.alpha = alpha;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (S.shake > 0 && !S.rm) { var sh = S.shake * S.shakeA; c.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh * 0.6); }
    c.fillStyle = S.col.bg; c.fillRect(-10, -10, VW + 20, VH + 20);
    // the sky deepens with altitude
    var alt = Math.max(0, v.bottom + VH * 0.5 / v.z) / LH, deep = clamp((alt - 10) / 90, 0, 1);
    if (deep > 0) {
      var sk = S.col.sky, gr = c.createLinearGradient(0, 0, 0, VH);
      gr.addColorStop(0, css(sk, deep * (S.dark ? 0.5 : 0.22)));
      gr.addColorStop(1, css(sk, deep * (S.dark ? 0.2 : 0.06)));
      c.fillStyle = gr; c.fillRect(-10, -10, VW + 20, VH + 20);
    }
    // stars: in the dark theme always, in the light one once you're high
    var starA = S.dark ? 0.35 + 0.65 * deep : clamp((alt - 45) / 40, 0, 1) * 0.8;
    if (starA > 0.02) {
      c.globalAlpha = starA;
      var pan = v.bottom * 0.15;
      for (i = 0; i < STARS.length; i++) {
        var st = STARS[i], syy = ((st.y * (VH + 200) + pan) % (VH + 200) + VH + 200) % (VH + 200) - 100;
        if (syy > 0 && syy < VH) glyph(c, C_STAR, st.c, st.x, syy, false, st.c === 46 ? 1 : 0.75);
      }
      c.globalAlpha = 1;
    }
    // clouds (parallax 0.6, drifting); they clear away as the camera pulls back
    var cA = 1 - easeOut(S.zoomT * 1.6);
    c.globalAlpha = cA;
    for (i = 0; i < CLOUDS.length && cA > 0.01; i++) {
      var cl = CLOUDS[i], tl = S.cloudT[cl.s];
      var cx = ((cl.x + t * cl.sp) % 620 + 620) % 620 - 150;
      var cyw = cl.y, cyy = VH - (cyw - v.bottom * 0.6) * Math.max(0.6, v.z) - tl.h;
      if (cyy > -tl.h && cyy < VH) c.drawImage(tl.cv, X(v, cx) - (X(v, cx) - VW / 2) * (1 - Math.max(0.6, v.z)) * 0.3, cyy, tl.w, tl.h);
    }
    c.globalAlpha = 1;
    // altitude ruler on the right, every 10 layers; the best height as a dashed gold line
    var z = v.z;
    if (z > 0.5) {
      var n0 = Math.max(10, Math.floor(v.bottom / LH / 10) * 10);
      for (var L = n0; L * LH < v.bottom + VH / z + LH; L += 10) {
        var ry = Y(v, L * LH);
        if (ry < 46 || ry > VH) continue;
        n = writeNum(L);
        drawNum(c, C_FAINT, n, VW - 6, ry, 'right', 0.8);
        glyph(c, C_FAINT, 45, VW - 6 - n * CW * 0.8 - 6, ry, false, 0.8);
      }
    }
    var bestH = S.bestH;
    if (bestH > 0 && S.mode !== 'cpu' && S.mode !== 'duel') {
      var by = Y(v, (bestH + 1) * LH);
      if (by > 40 && by < VH) {
        for (var bx = 4; bx < VW - 60; bx += CW * 2) glyph(c, C_GOLD, 45, bx, by, false, 0.8);
        drawStr(c, C_GOLD, 'BEST', VW - 34, by, 'center', false, 0.8);
      }
    }
    // the ground
    var gy = Y(v, 0);
    if (gy < VH + 4) {
      c.fillStyle = S.col.ground; c.fillRect(-10, gy, VW + 20, VH - gy + 10);
      for (i = 0; i < TREES.length; i++) drawTree(c, v, TREES[i][0], TREES[i][1]);
      var gs = CW * z;
      if (z > 0.45) {
        for (var gx = ((X(v, 0) % gs) + gs) % gs - gs; gx < VW + gs; gx += gs) {
          var hsh = ((Math.round((gx - X(v, 0)) / gs) * 7919) >>> 0) % 7;
          glyph(c, hsh < 2 ? C_GRASS : C_FAINT, hsh < 2 ? 34 : hsh < 4 ? 44 : 46, gx + gs / 2, gy + 2 * z, true, z < 1 ? z : 0);
          for (var ry2 = 1; ry2 < 12 && gy + RH * z * (ry2 + 0.3) < VH; ry2++) {   // soil: sparser with depth
            var hh = ihash(Math.round((gx - X(v, 0)) / gs), ry2) % 13;
            if (hh < 4 - Math.min(2, ry2 >> 1)) glyph(c, C_FAINT, hh === 0 ? 39 : hh === 1 ? 44 : 46, gx + gs / 2 + (ry2 % 2) * gs * 0.4, gy + RH * z * (ry2 + 0.3), true, z < 1 ? z : 0);
          }
        }
      }
      c.fillStyle = S.pal[C_FAINT]; c.fillRect(-10, gy, VW + 20, Math.max(1, z) / S.k);
    }
    // debris behind the tower (it slides off the back edge)
    for (i = 0; i < g.debris.length; i++) drawDebris(c, v, g, alpha, g.debris[i]);
    // the tower: only visible layers
    var B = g.blocks, lo = Math.max(0, Math.floor(v.bottom / LH) - 1), hi = Math.min(B.length - 1, Math.ceil((v.bottom + VH / z) / LH) + 1);
    for (i = lo; i <= hi; i++) {
      var bk = B[i];
      if (i === 0) {
        var px0 = X(v, bk.x), pw = bk.w * z, py0 = Y(v, LH);
        c.fillStyle = S.col.plinth; c.fillRect(px0, py0, pw, LH * z);
        if (z > 0.45) {
          var kk = Math.max(2, Math.round(pw / (CW * z)));
          for (var j = 0; j < kk; j++) glyph(c, C_MUTED, j === 0 ? 47 : j === kk - 1 ? 92 : 35, px0 + pw / kk * (j + 0.5), py0 + LH * z / 2, true, z < 1 ? z : 0);
        }
        continue;
      }
      var last = i === B.length - 1 && S.landT < 0.18 && S.g;
      var lift = last ? (1 - S.landT / 0.18) * 3 : 0;
      drawBlock(c, v, bk.x, bk.w, bk.n, hueSlot(g, bk.n), bk.perfect ? 35 : 61, lift, last && bk.perfect && S.landT < 0.1);
    }
    // ripples around perfect drops
    for (i = 0; i < S.ripples.length; i++) {
      var rp = S.ripples[i], e = rp.t / 0.5, gr2 = 2 + e * 14;
      c.globalAlpha = (1 - e) * 0.9;
      c.strokeStyle = S.pal[C_HUE + rp.slot]; c.lineWidth = 1.5;
      c.strokeRect(X(v, rp.x) - gr2, Y(v, (rp.n + 1) * LH) - gr2 * 0.5, rp.w * z + gr2 * 2, LH * z + gr2);
      c.globalAlpha = 1;
    }
    // the slider, with faint guides at the top block's edges behind it
    var m = g.m;
    if (m && S.g) {
      var mx = m.px + (m.x - m.px) * alpha, tp = B[B.length - 1], gyy = Y(v, m.n * LH + LH / 2);
      glyph(c, C_FAINT, 58, X(v, tp.x) + 1, gyy, true);
      glyph(c, C_FAINT, 58, X(v, tp.x + tp.w) - 1, gyy, true);
      var slot = hueSlot(g, m.n);
      drawBlock(c, v, mx, m.w, m.n, slot, 61, 0, false);
      if (g.players === 2) {     // whose drop it is: a marker over the slider
        var pc = P_SLOT[g.turn], lab = g.turn === 0 ? 'P1' : g.mode === 'cpu' ? 'CPU' : 'P2';
        if (m.hold > 0) lab += ' READY';
        var lhw = lab.length * CW * 0.85 / 2 + 4, lcx = X(v, mx + m.w / 2);
        drawStr(c, pc, lab, clamp(lcx, lhw, VW - lhw), gyy - RH * 1.25, 'center', true, 0.85);
        glyph(c, pc, 118, clamp(lcx, 8, VW - 8), gyy - RH * 0.6, true, 0.75);
      }
    }
    // particles + pop-ups
    for (i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on) continue;
      var ppx = X(v, p.x), ppy = Y(v, p.y);
      if (ppx < -CW || ppx > VW + CW || ppy < -RH || ppy > VH + RH) continue;
      c.globalAlpha = Math.min(1, 2.5 * (1 - p.t / p.life));
      glyph(c, p.ci, p.code, ppx, ppy, true);
    }
    c.globalAlpha = 1;
    for (i = 0; i < NPOP; i++) {
      var pp = S.pops[i];
      if (!pp.on) continue;
      c.globalAlpha = Math.min(1, 3 * (1 - pp.t));
      n = writeNum(pp.v);
      var qx = X(v, pp.x), qy = Y(v, pp.y) - pp.t * 26;
      glyph(c, pp.ci, 43, qx - (n + 1) * CW / 2, qy);
      drawNum(c, pp.ci, n, qx + CW / 2, qy, 'center');
    }
    c.globalAlpha = 1;
    if (S.g) hud(c, g);
    if (S.msg && S.g) banner(c, S.msg.text, VH * 0.24, S.msg.ci, S.msg.t);
    if (S.flash > 0 && !S.rm) {
      c.fillStyle = S.dark ? 'rgba(255,255,255,' + (S.flash * 0.9).toFixed(3) + ')' : 'rgba(255,255,255,' + (S.flash * 1.6).toFixed(3) + ')';
      c.fillRect(-10, -10, VW + 20, VH + 20);
    }
  }
  function ihash(a, b) {
    var h = Math.imul(a ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul(b + 0x632BE5AB, 0xC2B2AE35);
    h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12;
    return h >>> 0;
  }
  function drawTree(c, v, x, kind) {
    var z = v.z, sx = X(v, x), sy = Y(v, 0);
    if (sx < -30 || sx > VW + 30 || z < 0.45) return;
    var sc = z < 1 ? z : 0, rh = RH * z;
    if (kind === 0) {
      glyph(c, C_GRASS, 94, sx, sy - rh * 2.5, true, sc);
      drawStr(c, C_GRASS, '/ \\', sx, sy - rh * 1.5, 'center', true, sc || 1);
      glyph(c, C_MUTED, 124, sx, sy - rh * 0.5, true, sc);
    } else if (kind === 1) {
      drawStr(c, C_GRASS, '(@)', sx, sy - rh * 1.5, 'center', true, sc || 1);
      glyph(c, C_MUTED, 124, sx, sy - rh * 0.5, true, sc);
    } else drawStr(c, C_GRASS, '"w"', sx, sy - rh * 0.5, 'center', true, sc || 1);
  }
  function banner(c, s, y, ci, t) {
    var sc = 1 + 0.25 * Math.max(0, 1 - t / 0.12), w = (s.length + 4) * CW * sc;
    c.fillStyle = S.col.hud; c.fillRect(VW / 2 - w / 2, y - RH * 0.85 * sc, w, RH * 1.7 * sc);
    glyph(c, ci, 91, VW / 2 - w / 2 + CW * 0.6 * sc, y, true, sc);
    glyph(c, ci, 93, VW / 2 + w / 2 - CW * 0.6 * sc, y, true, sc);
    drawStr(c, ci, s, VW / 2, y, 'center', true, sc);
  }
  function hud(c, g) {
    var n, L = 0.72, VH2 = 44;
    c.fillStyle = S.col.hud; c.fillRect(0, 0, VW, VH2);
    if (g.players === 2) {
      var p2 = g.mode === 'cpu' ? 'CPU' : 'P2';
      drawStr(c, g.turn === 0 && g.phase === 'play' ? C_ACC : C_MUTED, (g.turn === 0 ? '> ' : '  ') + 'P1', 6, 9, 'left', false, L);
      n = writeNum(g.pts[0]); drawNum(c, C_ACC, n, 6 + CW * L * 2, 26, 'left', 1.5);
      drawStr(c, g.turn === 1 && g.phase === 'play' ? C_GOLD : C_MUTED, p2 + (g.turn === 1 ? ' <' : '  '), VW - 6, 9, 'right', false, L);
      n = writeNum(g.pts[1]); drawNum(c, C_GOLD, n, VW - 6 - CW * L * 2, 26, 'right', 1.5);
      drawStr(c, C_MUTED, 'HEIGHT', VW / 2, 9, 'center', false, L);
      n = writeNum(g.height); drawNum(c, C_TEXT, n, VW / 2, 26, 'center', 1.8);
    } else {
      drawStr(c, C_MUTED, 'HEIGHT', 6, 9, 'left', false, L);
      n = writeNum(g.height); drawNum(c, C_TEXT, n, 6, 25, 'left', 1.1);
      drawStr(c, C_MUTED, 'BEST', VW - 6, 9, 'right', false, L);
      var bs = Math.max(S.bestScore, g.score);
      n = writeNum(bs); drawNum(c, g.score > S.bestScore && S.bestScore > 0 ? C_GOLD : C_TEXT, n, VW - 6, 25, 'right', 1.1);
      var pop = 1 + 0.35 * Math.max(0, 1 - S.scoreT / 0.15);
      n = writeNum(g.score); drawNum(c, C_TEXT, n, VW / 2, 22, 'center', 2 * pop);
    }
    if (g.combo > 1) {
      var cs = g.combo >= GROW_N ? (((S.idleT * 6) | 0) % 2 ? C_GOLD : C_ACC) : C_ACC;
      var lab = 'COMBO x', w = (lab.length + String(g.combo).length) * CW * 0.85;
      var x = drawStr(c, cs, lab, VW / 2 - w / 2, VH2 + 9, 'left', false, 0.85);
      n = writeNum(g.combo); drawNum(c, cs, n, x, VH2 + 9, 'left', 0.85);
    }
  }

  // ---- loop: runs only while a game is on screen ----
  function running() {
    return !!S && !!S.g && S.phase === 'play' && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel));
  }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    pollPad();
    if (!S.raf && !running()) return;
    S.idleT += dt; S.scoreT += dt;
    var g = S.g, alpha = advance(g, dt);
    handleEvents(g);
    stepFx(dt);
    if (g.phase !== 'play') S.zoomT = Math.min(1, S.zoomT + dt / 1.1);
    draw(alpha, dt);
    if (g.phase === 'done') { endGame(); return; }
    syncPad();
    S.raf = requestAnimationFrame(frame);
  }

  function handleEvents(g) {
    var ev = g.events, snd = S.snd, r = g.last, i;
    for (i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e === 'place') {
        S.landT = 0; S.scoreT = 0;
        var y = (r.n + 1) * LH, bk = g.blocks[g.blocks.length - 1];
        if (!r.perfect) {
          var big = clamp(r.cut / 40, 0.15, 1);
          snd.noise(0.06 + big * 0.08, 0.05 + big * 0.04, 1800 - big * 900);
          snd.tone(note(Math.min(9, g.height % 10)) / 2, 0.12, 'triangle', 0.045);
          S.shake = 0.12 + big * 0.12; S.shakeA = 3 + big * 5;
          var ex = r.x < bk.x ? bk.x : bk.x + bk.w;
          burst(ex, y - LH / 2, 4 + Math.round(big * 6), 60, ".,'", C_MUTED, 300, 0.5);
          Cade.haptic && Cade.haptic(8);
          if (r.cut < 6) say('CLOSE!', C_MUTED, 0.6);
        }
        popup(bk.x + bk.w / 2, y + 4, r.gain, r.perfect ? C_ACC : C_MUTED);
        if (S.liveEl && g.height % 5 === 0) S.liveEl.textContent = 'Height ' + g.height + ', score ' + g.score + '.';
      } else if (e === 'perfect') {
        var bk2 = g.blocks[g.blocks.length - 1], c2 = g.combo;
        snd.tone(note(c2 + 4), 0.16, 'triangle', 0.05);
        snd.tone(note(c2 + 6), 0.2, 'sine', 0.035, 0, 0.05);
        if (c2 >= 5) snd.tone(note(c2 + 9), 0.22, 'sine', 0.025, 0, 0.1);
        S.ripples.push({ x: bk2.x, w: bk2.w, n: bk2.n, slot: hueSlot(g, bk2.n), t: 0 });
        burst(bk2.x, (bk2.n + 1) * LH, 5, 70, "*+'", c2 >= GROW_N ? -1 : C_ACC, 120, 0.6, true);
        burst(bk2.x + bk2.w, (bk2.n + 1) * LH, 5, 70, "*+'", c2 >= GROW_N ? -1 : C_ACC, 120, 0.6, true);
        say(c2 > 1 ? 'PERFECT x' + c2 : 'PERFECT', C_ACC, 0.8);
        S.flash = 0.05;
        Cade.haptic && Cade.haptic(5);
      } else if (e === 'grow') {
        var bk3 = g.blocks[g.blocks.length - 1], yy = (bk3.n + 0.5) * LH;
        for (var q = 0; q < 3; q++) {
          spark(bk3.x - 2, yy, -60 - q * 30, 0, 0.45, 60, C_GOLD, 0);
          spark(bk3.x + bk3.w + 2, yy, 60 + q * 30, 0, 0.45, 62, C_GOLD, 0);
        }
        say('GROW +' + Math.round(r.grow), C_GOLD, 0.9, true);
        [0, 2, 4].forEach(function (k, j) { snd.tone(note(g.combo + 7 + k), 0.1, 'square', 0.02, 0, 0.12 + j * 0.05); });
      } else if (e === 'milestone') {
        say('HEIGHT ' + g.height, C_GOLD, 1.1, true);
        snd.tone(523, 0.1, 'triangle', 0.04, 0, 0.15); snd.tone(784, 0.18, 'triangle', 0.035, 0, 0.25);
        if (g.mode !== 'cpu' && g.mode !== 'duel' && S.bestH > 0 && g.height > S.bestH && !S.passedBest) { S.passedBest = true; say('NEW BEST HEIGHT', C_GOLD, 1.2, true); }
      } else if (e === 'miss') {
        snd.tone(220, 0.5, 'sawtooth', 0.04, 70); snd.noise(0.3, 0.06, 500);
        S.shake = 0.4; S.shakeA = 9;
        say(g.players === 2 ? (g.loser === 0 ? 'P1 MISSED' : g.mode === 'cpu' ? 'CPU MISSED' : 'P2 MISSED') : 'MISSED', C_RED, 1.6);
        Cade.haptic && Cade.haptic(30);
        S.zoomT = 0.0001;
        setPad('wait');
      }
    }
    ev.length = 0;
    // passing the best height mid-run
    if (!S.passedBest && S.bestH > 0 && g.players === 1 && g.height > S.bestH) {
      S.passedBest = true; say('NEW BEST HEIGHT', C_GOLD, 1.2, true);
      [659, 784, 988].forEach(function (fq, j) { snd.tone(fq, 0.1, 'triangle', 0.035, 0, j * 0.07); });
    }
  }

  // ---- cards ----
  var MODE_INFO = {
    classic: { name: 'Classic', info: 'build as high as you can' },
    turbo: { name: 'Turbo', info: 'starts fast, gets faster' },
    cpu: { name: 'vs CPU', info: 'take turns — first to miss loses' },
    duel: { name: '2 players', info: 'pass and play — first to miss loses' }
  };
  function line(a, b2, w) { w = w || 26; return esc(a) + new Array(Math.max(1, w - a.length - b2.length) + 1).join(' ') + '<b>' + esc(b2) + '</b>'; }
  function homeHtml() {
    var sv = S.save, md = S.mode, h = '<div class="st-card st-home">';
    h += '<pre class="st-art" aria-hidden="true">' + artHtml() + '</pre>';
    h += '<div class="st-title">STACK TOWER</div>';
    h += '<div class="st-sec"><div class="st-h">Mode</div><div class="st-chips">' + MODES.map(function (k) {
      return '<button type="button" class="st-chip' + (md === k ? ' on' : '') + '" data-mode="' + k + '" aria-pressed="' + (md === k) + '">' + esc(MODE_INFO[k].name) + '</button>';
    }).join('') + '</div><div class="st-note st-left">' + esc(MODE_INFO[md].info) + '</div></div>';
    if (md === 'cpu') {
      h += '<div class="st-sec"><div class="st-h">CPU</div><div class="st-chips">' + CPU_LEVELS.map(function (L, i) {
        return '<button type="button" class="st-chip' + (sv.lvl === i ? ' on' : '') + '" data-lvl="' + i + '" aria-pressed="' + (sv.lvl === i) + '">' + L.name +
          ' <i>' + sv.cpu.w[i] + '-' + sv.cpu.l[i] + '</i></button>';
      }).join('') + '</div></div>';
    }
    var rows = [];
    if (md === 'classic' || md === 'turbo') {
      var b = sv.best[md];
      rows.push(line('Best score', String(b.score)), line('Best height', String(b.height)), line('Best combo', String(b.combo)));
    } else if (md === 'cpu') {
      rows.push(line('Record vs ' + CPU_LEVELS[sv.lvl].name, sv.cpu.w[sv.lvl] + ' W  ' + sv.cpu.l[sv.lvl] + ' L'));
    } else rows.push(line('Duels played', String(sv.duels)));
    rows.push('<i>' + line('Games', String(sv.games)) + '</i>', '<i>' + line('Layers stacked', String(sv.layers)) + '</i>');
    h += '<pre class="st-tab">' + rows.join('\n') + '</pre>';
    h += '<div class="st-foot">' + (S.resetArm ?
      '<span class="st-confirm">Erase all records?</span><span><button type="button" class="st-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="st-lnk" data-act="reset-no">Keep</button></span>' :
      '<span>' + (S.coarse ? 'tap to drop' : 'space / click to drop') + '</span><button type="button" class="st-lnk" data-act="reset">Reset records</button>') + '</div>';
    return h + '</div>';
  }
  function artHtml() {
    return '<span class="st-h0">   [==]</span>\n<span class="st-h1">  [====]</span>\n<span class="st-h2">  [=====]</span>\n<span class="st-h3"> [=======]</span>';
  }
  function helpHtml(first) {
    var keys = S.coarse ?
      '<div><b>tap</b> &nbsp;anywhere to drop the block</div>' :
      '<div><b>Space</b> / &darr; / click &nbsp;drop the block</div><div><b>gamepad</b> &nbsp;A to drop, Start to pause</div><div><b>P / Esc</b> &nbsp;pause</div>';
    return '<div class="st-card st-help">' +
      '<pre class="st-art" aria-hidden="true">' + artHtml() + '</pre>' +
      '<div class="st-title">STACK TOWER</div>' +
      '<p>A block slides over the top of your tower. <b>Drop it</b> right on the block below.</p>' +
      '<div class="st-keys">' + keys + '</div>' +
      '<p class="st-tip">Whatever hangs over the edge is <b>sliced off</b> — the tower gets narrower. Line it up within a hair for a <b>PERFECT</b>: no slice, and from the <b>3rd perfect in a row</b> the block grows back.</p>' +
      '<p class="st-tip">Every layer is a little faster. Miss the tower completely and it&rsquo;s over.</p>' +
      '<p class="st-tip"><b>vs CPU</b> and <b>2 players</b> share one tower and take turns: whoever misses loses.</p>' +
      (first ? '' : '<button type="button" class="st-go" data-act="close-help">Back</button>') + '</div>';
  }
  function resultsHtml() {
    var cd = S.card, r = S.res, rows = [], h = '<div class="st-card st-res">';
    if (r.mode === 'classic' || r.mode === 'turbo') {
      var b = S.save.best[r.mode];
      h += '<div class="st-title">TOPPLED</div><div class="st-big">' + r.score + '</div>' +
        (cd.best.score ? '<div class="st-new">** new best score **</div>' : '<div class="st-sub">best ' + b.score + '</div>');
      rows.push(line('Height', r.height + (cd.best.height ? ' *' : '')), line('Perfect drops', String(r.perfects)),
        line('Best combo', 'x' + r.combo + (cd.best.combo ? ' *' : '')), line('Regrowths', String(r.grows)));
      rows.push('<i>' + new Array(27).join('-') + '</i>', '<span class="g">' + line(MODE_INFO[r.mode].name + ' best height', String(b.height)) + '</span>');
    } else {
      var p2 = r.mode === 'cpu' ? 'CPU' : 'Player 2', wname = r.winner === 0 ? (r.mode === 'cpu' ? 'YOU WIN' : 'PLAYER 1 WINS') : (r.mode === 'cpu' ? 'CPU WINS' : 'PLAYER 2 WINS');
      h += '<div class="st-title">' + wname + '</div><div class="st-big ' + (r.winner === 0 ? 'p1' : 'p2') + '">' + r.height + '</div><div class="st-sub">layers high</div>';
      rows.push(line('', 'P1    ' + (r.mode === 'cpu' ? 'CPU' : ' P2')));
      rows.push(line('Points', pad(r.pts[0], 3) + '    ' + pad(r.pts[1], 3)), line('Perfects', pad(r.pp[0], 3) + '    ' + pad(r.pp[1], 3)));
      if (r.mode === 'cpu') rows.push('<i>' + new Array(27).join('-') + '</i>', '<span class="g">' + line('vs ' + CPU_LEVELS[r.lvl].name, S.save.cpu.w[r.lvl] + ' W  ' + S.save.cpu.l[r.lvl] + ' L') + '</span>');
      else rows.push('<i>' + esc((r.winner === 0 ? p2 : 'Player 1') + ' missed the tower') + '</i>');
    }
    h += '<pre class="st-tab">' + rows.join('\n') + '</pre>';
    return h + '</div>';
  }
  function pad(v, n) { v = String(v); while (v.length < n) v = ' ' + v; return v; }
  function pauseHtml() {
    var g = S.g;
    return '<div class="st-card st-pause"><div class="st-title">PAUSED</div>' +
      '<div class="st-sub">height ' + g.height + (g.players === 1 ? ' · score ' + g.score : '') + '</div>' +
      '<div class="st-btns"><button type="button" class="st-go" data-act="resume">Resume</button><button type="button" class="st-go alt" data-act="quit">Quit</button></div>' +
      '<div class="st-note">' + (S.coarse ? 'Tap Resume to carry on' : 'Space / P to resume') + '</div></div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'home' ? homeHtml() : kind === 'help' ? helpHtml(S.firstRun) : kind === 'results' ? resultsHtml() : kind === 'pause' ? pauseHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind && kind !== 'home' && kind !== 'results');
    S.stage.classList.toggle('home', kind === 'home' || kind === 'results');
  }
  function setPad(mode) {
    var h;
    S.padMode = mode;
    if (mode === 'play') {
      var g = S.g, lab = 'Drop', cls = '';
      if (g && g.players === 2) {
        if (isCpuTurn(g)) { lab = 'CPU&hellip;'; cls = ' cpu'; }
        else { lab = (g.turn === 0 ? 'P1' : 'P2') + ' drop'; cls = g.turn === 1 ? ' p2' : ''; }
      }
      h = '<button type="button" class="st-drop' + cls + '" data-k="drop" aria-label="Drop the block">' + lab + (S.coarse || cls === ' cpu' ? '' : ' <span>space</span>') + '</button>';
      S.padTurn = g ? g.turn : 0;
    } else if (mode === 'wait') {
      h = '<button type="button" class="st-drop idle" disabled>&hellip;</button>';
    } else {
      var l2 = mode === 'go' ? 'Play' : mode === 'again' ? 'Again' : mode === 'resume' ? 'Resume' : mode === 'start' ? 'Let&rsquo;s stack' : 'Back';
      h = '<button type="button" class="st-act" data-act="' + mode + '">' + l2 + (S.coarse ? '' : ' <small>space</small>') + '</button>' +
        (mode === 'again' ? '<button type="button" class="st-act alt" data-act="home">Menu</button>' : '');
    }
    S.pad.innerHTML = h;
  }
  // the pad follows the turn in duels (cheap: only rebuilt when the turn changes)
  function syncPad() {
    if (!S || S.padMode !== 'play' || !S.g) return;
    if (S.padTurn !== S.g.turn) setPad('play');
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.phase !== 'play';
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }
  function syncLabel() {
    var b = S.save.best.classic;
    S.cv.setAttribute('aria-label', 'Stack Tower — best score ' + b.score + ', best height ' + b.height + '. Press space, enter or tap the tower to drop the sliding block.');
  }

  // A small tower for the menu backdrop: a few drops, slightly off.
  function demoGame() {
    var g = newGame({ mode: 'classic', seed: 7 }), offs = [0, 9, -6, 0, 0, 5, -3, 0, 7];
    for (var i = 0; i < offs.length; i++) { var tp = top(g); g.m.x = g.m.px = tp.x + offs[i]; drop(g, 1); }
    g.debris.length = 0; g.cam = g.pcam = g.blocks.length; g.events.length = 0;
    return g;
  }
  function toHome() {
    stopLoop();
    S.phase = 'home'; S.g = null; S.paused = false; S.resetArm = false; S.zoomT = 0;
    S.hg = demoGame();
    clearInput(); clearFx(); S.msg = null; S.msgQ.length = 0;
    showCard('home'); setPad('go'); syncHead(); syncLabel();
    draw(1, 0);
  }
  function startGame() {
    if (!S || (S.phase !== 'home' && S.phase !== 'results' && S.phase !== 'help')) return;
    S.snd.ensure();
    var md = S.mode, b = S.save.best[md];
    S.bestScore = b ? b.score : 0; S.bestH = b ? b.height : 0; S.passedBest = false;
    S.g = newGame({ mode: md, seed: (Math.random() * 4294967295) >>> 0 || 1, lvl: S.save.lvl });
    S.phase = 'play'; S.paused = false; S.zoomT = 0; S.landT = 1; S.scoreT = 1;
    clearInput(); clearFx(); S.msg = null; S.msgQ.length = 0;
    showCard(null); setPad('play'); syncHead();
    say(md === 'cpu' ? 'YOU GO FIRST' : md === 'duel' ? 'P1 GOES FIRST' : S.coarse ? 'TAP TO DROP' : 'SPACE TO DROP', C_MUTED, 1.3);
    kick();
  }
  function endGame() {
    stopLoop();
    S.res = summary(S.g);
    S.card = settle(S.save, S.res);
    persist();
    S.phase = 'results'; S.zoomT = 1; clearInput();
    showCard('results'); setPad('again'); syncHead(); syncLabel();
    var r = S.res;
    if (S.liveEl) S.liveEl.textContent = r.winner >= 0 ? (r.winner === 0 ? 'Player 1' : r.mode === 'cpu' ? 'The CPU' : 'Player 2') + ' wins at height ' + r.height + '.' : 'Toppled: score ' + r.score + ', height ' + r.height + '.';
    if (S.card.best.score || S.card.win) [659, 784, 988, 1319].forEach(function (fq, j) { S.snd.tone(fq, 0.12, 'triangle', 0.035, 0, j * 0.08); });
    else if (S.card.win === false) [392, 330, 262].forEach(function (fq, j) { S.snd.tone(fq, 0.16, 'triangle', 0.035, 0, j * 0.1); });
    draw(1, 0);
  }
  function padAction(act) {
    if (!S) return;
    S.snd.ensure();
    act = act || S.padMode;
    if (act === 'go' || act === 'again' || act === 'start') { if (act === 'start') { S.firstRun = false; S.phase = 'home'; } startGame(); }
    else if (act === 'resume') resume();
    else if (act === 'home' || act === 'back') toHome();
  }
  function pause() {
    if (!S || S.phase !== 'play' || S.paused) return;
    S.paused = true;
    stopLoop(); clearInput();
    showCard('pause'); setPad('resume'); syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null); setPad(S.g.phase === 'play' ? 'play' : 'wait'); syncHead();
    kick();
  }
  function quitGame() {
    if (!S || S.phase !== 'play') return;
    S.paused = false;
    toHome();
  }
  // The one action: drop (only on a human's turn while playing).
  function act() {
    if (!S || S.phase !== 'play' || S.paused || !S.g || !canDrop(S.g)) return;
    drop(S.g, S.alpha);
  }

  // ---- input ----
  var DROP_KEYS = { Space: 1, ArrowDown: 1, ArrowUp: 1, Enter: 1, NumpadEnter: 1, KeyS: 1 };
  var KEY2CODE = { ' ': 'Space', arrowdown: 'ArrowDown', arrowup: 'ArrowUp', s: 'KeyS', p: 'KeyP', enter: 'Enter', escape: 'Escape' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  function clearInput() { if (S) { S.gp.a = true; } }
  function readPad() {
    var pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) return pads[i];
    return null;
  }
  function btnOn(p, i) { var b = p.buttons[i]; return !!b && (b.pressed || b.value > 0.5); }
  function pollPad() {
    var gp = S.gp, p = readPad();
    if (!p) { gp.a = false; return; }
    var a = btnOn(p, 0) || btnOn(p, 1) || btnOn(p, 2) || btnOn(p, 3) || btnOn(p, 7) || btnOn(p, 5);
    if (a && !gp.a) act();
    gp.a = a;
    var st = btnOn(p, 9);
    if (st && !gp.start && S.phase === 'play' && !S.paused) pause();
    gp.start = st;
  }
  function pollMenus() {
    if (!S || (S.phase === 'play' && !S.paused)) return;
    var p = readPad();
    if (!p) return;
    var a = btnOn(p, 0) || btnOn(p, 9);
    if (a && !S.gp.menuA) { if (S.paused) resume(); else padAction(); }
    S.gp.menuA = a;
  }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !S.panel.contains(t)) return;
    var code = keyCode(e);
    if (code === 'Escape') {
      e.preventDefault();
      if (S.phase === 'play' && !S.paused) pause(); else closePanel();
      return;
    }
    if (S.phase === 'play') {
      if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
      if (S.paused) {
        if (code === 'Space' || code === 'Enter') { e.preventDefault(); if (!e.repeat) resume(); }
        else if (DROP_KEYS[code]) e.preventDefault();
        return;
      }
      if (DROP_KEYS[code]) { e.preventDefault(); if (!e.repeat) act(); }
      return;
    }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (!e.repeat) padAction();
    }
  }

  // ---- layout ----
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height) return vh - (vw <= 560 ? 190 : 210);
    var chrome = r.height - (S.stage.offsetHeight || 0);
    if (S.panel.classList.contains('cade-solo-panel')) {
      var hd = S.panel.querySelector('.cade-panel-head');
      chrome = (hd ? hd.offsetHeight : 40) + (S.pad.offsetHeight || 56) + 36;
    }
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 10;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var s = Math.min((vw - (phone ? 34 : 48)) / VW, phone ? 1.3 : solo ? 2 : 1.25), ah = availH(vw, vh);
    var vh2 = Math.floor(ah / s);
    if (vh2 < 380) { s = Math.max(0.6, Math.min(s, ah / 380)); vh2 = 380; }
    vh2 = Math.min(vh2, phone ? 560 : 500);
    var cw = Math.floor(VW * s), ch = Math.floor(vh2 * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--st-w', cw + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / VW;
    S.VH = S.cv.height / S.k;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    if (S.col) fitFont();
  }
  function redraw() { if (!S) return; if (S.phase === 'play' && !S.paused && S.raf) return; draw(1, 0); }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    clearInterval(s.gpT);
    window.removeEventListener('gamepadconnected', s.onPad);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    if (s.atl) freeCanvas(s.atl.cv);
    if (s.cloudT) s.cloudT.forEach(function (t) { freeCanvas(t.cv); });
    freeCanvas(s.cv);
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }

  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="st"><div class="st-stage"><canvas class="st-cv"></canvas><div class="st-ovl" style="display:none"></div></div>' +
      '<div class="st-pad"></div><div class="st-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🧱 Stack Tower', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'st-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, stage: p.querySelector('.st-stage'), cv: p.querySelector('.st-cv'), ovl: p.querySelector('.st-ovl'),
      pad: p.querySelector('.st-pad'), liveEl: p.querySelector('.st-live'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) === '1'), mode: ld.save.mode,
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'home', g: null, hg: null, paused: false, raf: 0, last: 0, idleT: 0, alpha: 1,
      gp: { a: false, start: false, menuA: false }, gpT: 0,
      pal: new Array(NPAL), col: null, atl: null, cloudT: null, k: 1, VH: 400, v: {}, fill: [], rim: [],
      shake: 0, shakeA: 4, flash: 0, landT: 1, scoreT: 1, zoomT: 0, bestScore: 0, bestH: 0, passedBest: false,
      msg: null, msgQ: [], resetArm: false, padMode: '', padTurn: 0, cardKind: null
    };
    makeFx();
    S.ctx = S.cv.getContext('2d');
    S.hg = demoGame();
    p._onClose = teardown;
    layout();
    readTheme();

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) pause(); };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      pause(); stopLoop();
    });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        layout(); redraw();
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); redraw(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    S.onPad = function () { if (S && !S.gpT) S.gpT = setInterval(pollMenus, 100); };
    window.addEventListener('gamepadconnected', S.onPad);
    if (readPad()) S.onPad();
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); redraw();
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') {
        if (S.phase === 'play') pause();
        else if (S.cardKind === 'help') { if (S.phase === 'home') showCard('home'); }
        else if (S.phase === 'home') showCard('help');
      }
      try { b.blur(); } catch (er) {}
    });

    // Rapid tapping must never zoom, select, magnify or open a callout.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    [S.cv, S.pad].forEach(function (el) {
      el.addEventListener('touchstart', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
      el.addEventListener('touchmove', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
      el.addEventListener('touchend', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
    });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    // the play field and the DROP button act on press (no waiting for the click)
    function press(e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      act();
    }
    S.cv.addEventListener('pointerdown', press);
    S.pad.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-k]') : null;
      if (b) press(e);
    });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (b && S) padAction(b.getAttribute('data-act'));
    });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var md = b.getAttribute('data-mode'), lv = b.getAttribute('data-lvl'), a = b.getAttribute('data-act'), focusSel = null;
      if (md) {
        S.mode = S.save.mode = md; persist();
        S.snd.tone(988, 0.05, 'sine', 0.03);
        showCard('home'); focusSel = '[data-mode="' + md + '"]';
      } else if (lv != null) {
        S.save.lvl = clamp(+lv | 0, 0, 2); persist();
        S.snd.tone(1175, 0.05, 'sine', 0.03);
        showCard('home'); focusSel = '[data-lvl="' + lv + '"]';
      } else if (a === 'reset') { S.resetArm = true; showCard('home'); }
      else if (a === 'reset-no') { S.resetArm = false; showCard('home'); }
      else if (a === 'reset-yes') {
        var keep = S.save.mode, kl = S.save.lvl;
        S.save = newSave(); S.save.mode = keep; S.save.lvl = kl; persist();
        Cade.showToast && Cade.showToast('Records reset', 'info', 1800);
        toHome();
      } else if (a === 'close-help') showCard('home');
      else if (a === 'resume') resume();
      else if (a === 'quit') quitGame();
      var nb = focusSel && e.detail === 0 && S.ovl.querySelector(focusSel);
      if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
    });

    if (S.firstRun) {
      S.phase = 'help';
      persist();
      showCard('help'); setPad('start'); syncHead(); syncLabel();
      draw(1, 0);
    } else toHome();
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); redraw(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('700 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); redraw(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Tap to drop the sliding block — overhangs get sliced, perfect drops grow',
    icon: '🧱',
    tags: 'game,arcade,fun,one button,tap,stack,tower,endless,vs cpu,2 players,ascii',
    open: open,
    _engine: ENGINE
  });
})();
