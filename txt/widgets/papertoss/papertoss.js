/* Paper Toss — flick rejected drafts into the bin, for Cade.txt.
 * Every throw is a draft (a built-in clunker or, optionally, a short line of the
 * current note, read only) that crumples into an "@" when you grab it. A desk
 * fan sets a new crosswind each throw: aim into it. Pseudo-3D: the ball flies
 * into the scene on a fixed 240 Hz physics step (exact for constant
 * acceleration) and rendering interpolates, so it flies the same at 60/120 Hz.
 * Rim hits rattle in or out. The bin backs off desk → office → hallway as the
 * streak grows; a miss ends the run. Best run persists. Drawn with canvas
 * glyphs and line art in the app's theme colours; no assets. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('papertoss.css');

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World units are metres / seconds. x → right, y → up, z → into the scene.
  var STEP = 1 / 240, G = 9.8;
  var BALL_R = 0.045;                          // a crumpled sheet, ~9 cm across
  var BIN_R = 0.19, BIN_RB = 0.145, BIN_H = 0.40, RIM_T = 0.007;
  var Y0 = 0.70, Z0 = 0;                       // release point: desk height, at you
  var ALPHA = 46 * Math.PI / 180, TAN_A = Math.tan(ALPHA);
  var AIM_GAIN = 0.42, AIM_MAX = 1.1;          // flick angle → launch angle (damped for fine aim)
  var POW_MIN = -3, POW_MAX = 2;               // power is in doublings of the "right" flick speed
  var WIND_K = 0.55;                           // sideways push (m/s²) per wind unit
  var E_RIM = 0.42, E_BIN = 0.22, E_FLOOR = 0.25, E_WALL = 0.32;
  var LEVELS = [
    { key: 'desk', path: '~/desk', D: 2.0, wall: 3.6, side: 0, windMax: 3.0, pts: 1, at: 0, pg: 0.45 },
    { key: 'office', path: '~/office', D: 3.5, wall: 5.0, side: 0, windMax: 3.5, pts: 2, at: 3, pg: 0.55 },
    { key: 'hallway', path: '~/hallway', D: 5.6, wall: 7.8, side: 1.25, windMax: 4.5, pts: 3, at: 8, pg: 0.65 }
  ];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function levelFor(streak) { for (var i = LEVELS.length - 1; i > 0; i--) if (streak >= LEVELS[i].at) return i; return 0; }

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

  // Launch velocity. `aim` is the flick angle from straight up (radians, + = right);
  // `pow` is how far the flick was from the level's ideal speed, in doublings
  // (0 = perfect). Power picks the reach: a perfect flick drops the ball's centre
  // through the middle of the opening; each doubling adds L.pg metres. Aim turns
  // the throw sideways without stealing forward reach, so compensating for wind
  // is purely a matter of direction.
  function launchVel(L, aim, pow) {
    aim = clamp(+aim || 0, -AIM_MAX, AIM_MAX);
    pow = clamp(+pow || 0, POW_MIN, POW_MAX);
    var reach = L.D + L.pg * pow;
    if (pow < -1) reach += (pow + 1) * 0.6;    // a limp flick dies fast
    var dz = Math.max(0.35, reach) - Z0;
    var vh = Math.sqrt(G * dz * dz / (2 * (Y0 - BIN_H + dz * TAN_A)));
    return { vx: vh * Math.tan(aim * AIM_GAIN), vy: vh * TAN_A, vz: vh };
  }

  function newBall(L, wind, aim, pow) {
    var v = launchVel(L, aim, pow);
    return {
      L: L, ax: (+wind || 0) * WIND_K, x: 0, y: Y0, z: Z0, px: 0, py: Y0, pz: Z0,
      vx: v.vx, vy: v.vy, vz: v.vz, spin: 0, pspin: 0, om: 7 + Math.abs(v.vx) * 3,
      t: 0, acc: 0, steps: 0, state: 'fly', inBin: false, scored: false, inT: 0,
      rims: 0, cross: null, floored: false, restT: 0, result: null, events: []
    };
  }

  function finish(b, res) { b.state = 'done'; b.result = res; b.events.push('done'); }

  // One fixed physics step: exact kinematics, then rim / bin / floor / walls.
  function stepBall(b) {
    if (b.state !== 'fly') return;
    var L = b.L, ev = b.events, dt = STEP;
    b.px = b.x; b.py = b.y; b.pz = b.z; b.pspin = b.spin;
    b.steps++; b.t += dt;
    // The fan only pushes a ball that is in the air and not already inside the bin.
    var ax = (b.y > BALL_R + 0.002 && !b.inBin) ? b.ax : 0;
    b.x += b.vx * dt + 0.5 * ax * dt * dt; b.vx += ax * dt;
    b.y += b.vy * dt - 0.5 * G * dt * dt; b.vy -= G * dt;
    b.z += b.vz * dt;
    b.spin += b.om * dt;

    var dx = b.x, dz = b.z - L.D, rho = Math.sqrt(dx * dx + dz * dz), md = BALL_R + RIM_T;
    // Rim: a thin ring (torus) of radius BIN_R at height BIN_H.
    if (Math.abs(b.y - BIN_H) < md && Math.abs(rho - BIN_R) < md) {
      var ux = rho > 1e-9 ? dx / rho : 1, uz = rho > 1e-9 ? dz / rho : 0;
      var qx = ux * BIN_R, qz = L.D + uz * BIN_R;
      var nx = b.x - qx, ny = b.y - BIN_H, nz = b.z - qz, d = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (d < md) {
        if (d < 1e-9) { nx = 0; ny = 1; nz = 0; d = 1; }
        nx /= d; ny /= d; nz /= d;
        var vn = b.vx * nx + b.vy * ny + b.vz * nz;
        if (vn < 0) {                          // reflect the normal part, scrub some of the rest
          b.vx = (b.vx - vn * nx) * 0.82 - E_RIM * vn * nx;
          b.vy = (b.vy - vn * ny) * 0.82 - E_RIM * vn * ny;
          b.vz = (b.vz - vn * nz) * 0.82 - E_RIM * vn * nz;
          b.om = -b.om * 0.6;
          b.rims++;
          if (vn < -0.3) ev.push('rim');
        }
        b.x = qx + nx * md; b.y = BIN_H + ny * md; b.z = qz + nz * md;
        dx = b.x; dz = b.z - L.D; rho = Math.sqrt(dx * dx + dz * dz);
      }
    }
    // Falling through the rim plane: inside the opening means it's in the bin.
    if (b.py >= BIN_H && b.y < BIN_H && b.vy < 0) {
      var f = (b.py - BIN_H) / (b.py - b.y), cx = b.px + (b.x - b.px) * f, cz = b.pz + (b.z - b.pz) * f;
      if (!b.cross) b.cross = { x: cx, z: cz };
      if (Math.sqrt(cx * cx + (cz - L.D) * (cz - L.D)) < BIN_R) b.inBin = true;
    } else if (b.inBin && b.y > BIN_H + BALL_R) b.inBin = false;   // bounced back out

    // Bin body: a tapered cylinder. Inside → keep in; outside → keep out.
    if (b.y < BIN_H) {
      var rw = BIN_RB + (BIN_R - BIN_RB) * clamp(b.y / BIN_H, 0, 1);
      var wx = rho > 1e-9 ? dx / rho : 1, wz = rho > 1e-9 ? dz / rho : 0, vr = b.vx * wx + b.vz * wz;
      if (b.inBin) {
        var lim = rw - BALL_R;
        if (rho > lim) {
          b.x = wx * lim; b.z = L.D + wz * lim;
          if (vr > 0) {
            b.vx -= (1 + E_BIN) * vr * wx; b.vz -= (1 + E_BIN) * vr * wz;
            if (vr > 0.4) ev.push('bin');
          }
        }
        if (b.y < BALL_R) {
          b.y = BALL_R;
          if (b.vy < 0) { b.vy = -b.vy * E_FLOOR; if (b.vy < 0.25) b.vy = 0; b.vx *= 0.6; b.vz *= 0.6; b.om *= 0.5; }
        }
        if (!b.scored && b.y < BIN_H - 1.5 * BALL_R) { b.scored = true; b.inT = b.t; ev.push('in'); }
      } else {
        var lim2 = rw + BALL_R;
        if (rho < lim2) {
          b.x = wx * lim2; b.z = L.D + wz * lim2;
          if (vr < 0) {
            b.vx -= (1 + E_BIN) * vr * wx; b.vz -= (1 + E_BIN) * vr * wz;
            if (vr < -0.4) ev.push('bin');
          }
        }
      }
    }
    // Floor.
    if (!b.inBin && b.y < BALL_R) {
      b.y = BALL_R;
      if (b.vy < 0) {
        if (!b.floored) { b.floored = true; ev.push('floor'); }
        b.vy = -b.vy * E_FLOOR; if (b.vy < 0.3) b.vy = 0;
        b.vx *= 0.7; b.vz *= 0.7; b.om *= 0.6;
      }
    }
    if (b.y <= BALL_R + 1e-4) {                // sliding friction on the floor / bin bottom
      var sp = Math.sqrt(b.vx * b.vx + b.vz * b.vz), dec = 2.4 * dt;
      if (sp <= dec) { b.vx = 0; b.vz = 0; } else { b.vx -= b.vx / sp * dec; b.vz -= b.vz / sp * dec; }
      b.om *= 1 - 3 * dt;
    }
    // Walls.
    if (b.z > L.wall - BALL_R) {
      b.z = L.wall - BALL_R;
      if (b.vz > 0) { if (b.vz > 0.4) ev.push('wall'); b.vz = -b.vz * E_WALL; b.vx *= 0.8; }
    }
    if (L.side && Math.abs(b.x) > L.side - BALL_R) {
      var sg = b.x < 0 ? -1 : 1;
      b.x = sg * (L.side - BALL_R);
      if (b.vx * sg > 0) { if (Math.abs(b.vx) > 0.4) ev.push('wall'); b.vx = -b.vx * E_WALL; }
    }
    // Done?
    var sp2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
    if (b.scored) {
      if (b.t - b.inT > 0.9 || (b.y <= BALL_R + 1e-3 && sp2 < 0.0025)) finish(b, 'in');
    } else if (b.y <= BALL_R + 1e-3 && sp2 < 0.004) {
      b.restT += dt;
      if (b.restT > 0.12) finish(b, 'miss');
    } else b.restT = 0;
    if (b.state === 'fly' && (b.t > 6 || b.z < -1 || Math.abs(b.x) > 9)) finish(b, b.scored ? 'in' : 'miss');
  }

  // Fixed-timestep accumulator: consume real frame time in STEP slices. Returns the render alpha.
  function advance(b, dt) {
    b.acc += clamp(dt, 0, 0.1);
    var n = 0;
    while (b.acc >= STEP - 1e-9 && b.state === 'fly') {
      stepBall(b);
      b.acc -= STEP;
      if (++n >= 60) { b.acc = 0; break; }
    }
    return b.state === 'fly' ? clamp(b.acc / STEP, 0, 1) : 1;
  }

  // How a finished throw went: in (swish = never touched the rim) or how it missed.
  function judge(b) {
    var out = { result: b.result || 'miss', rims: b.rims, swish: b.result === 'in' && b.rims === 0, kind: '', by: 0 };
    if (out.result === 'in') return out;
    var c = b.cross || { x: b.x, z: b.z }, dx = c.x, dz = c.z - b.L.D;
    if (b.rims > 0) { out.kind = 'rim'; return out; }
    if (Math.abs(dx) > Math.abs(dz)) { out.kind = dx < 0 ? 'left' : 'right'; out.by = Math.abs(dx) - BIN_R; }
    else { out.kind = dz < 0 ? 'short' : 'long'; out.by = Math.abs(dz) - BIN_R; }
    out.by = Math.max(0.05, out.by);
    return out;
  }

  // Run one throw to the end (headless).
  function simulate(level, wind, aim, pow) {
    var b = newBall(LEVELS[level] || LEVELS[0], wind, aim, pow), evs = [], n = 0;
    while (b.state === 'fly' && n++ < 20000) { stepBall(b); if (b.events.length) { evs.push.apply(evs, b.events); b.events.length = 0; } }
    var j = judge(b);
    j.t = b.t; j.steps = b.steps; j.x = b.x; j.y = b.y; j.z = b.z; j.events = evs;
    return j;
  }

  // The flick angle that cancels a crosswind (for a given power): the fan pushes
  // for the whole flight, so lean the throw upwind by half the drift's velocity.
  function aimFor(level, wind, pow) {
    var v = launchVel(LEVELS[level] || LEVELS[0], 0, pow || 0);
    var T = (v.vy + Math.sqrt(v.vy * v.vy + 2 * G * (Y0 - BIN_H))) / G;
    return Math.atan(-0.5 * (+wind || 0) * WIND_K * T / v.vz) / AIM_GAIN;
  }

  // ---- a run: score, streak, level and the wind for the next throw ----
  function newGame(seed) {
    var g = { rnd: rng(seed), score: 0, streak: 0, level: 0, runThrows: 0, made: 0, thrown: 0, wind: 0 };
    rollWind(g);
    return g;
  }
  // The first throw of every run is calm; after that the fan picks a side and a speed.
  function rollWind(g) {
    var L = LEVELS[g.level], a = g.rnd(), s = g.rnd(), m = g.rnd();
    if (g.runThrows === 0 || a < 0.1) g.wind = 0;
    else g.wind = (s < 0.5 ? -1 : 1) * Math.max(0.3, Math.round(L.windMax * (0.2 + 0.8 * m) * 10) / 10);
    return g.wind;
  }
  function applyResult(g, res) {
    var L = LEVELS[g.level], out = { pts: 0, levelFrom: g.level, levelTo: g.level, runOver: false, runScore: 0 };
    g.thrown++;
    if (res.result === 'in') {
      out.pts = L.pts + (res.swish ? 1 : 0);
      g.score += out.pts; g.streak++; g.made++; g.runThrows++;
      g.level = levelFor(g.streak);
    } else {
      out.runOver = true; out.runScore = g.score;
      g.score = 0; g.streak = 0; g.runThrows = 0; g.level = 0;
    }
    out.levelTo = g.level;
    rollWind(g);
    return out;
  }

  // ================= drafts =================
  var DRAFTS = [
    'It was a dark and stormy night…', 'TODO: rewrite everything', 'Dear diary, today I…',
    'Untitled document (37)', 'lorem ipsum dolor sit amet', 'final_FINAL_v3.txt',
    'Call me Ishmael. No, wait—', 'Chapter 1. Chapter 1. Chapter 1.', '// I\'ll fix this later',
    'Once upon a time, in a— nope.', 'git commit -m "stuff"', 'Meeting notes: (nobody spoke)',
    'To whom it may concern,', 'The quick brown fox jumps ov', 'Subject: Re: Re: Fwd: Re:',
    'my novel, page 1 of 1', 'It was the best of times, it wa', 'FIXME: works on my machine',
    'New Year\'s resolutions (draft 4)', 'Hello, World!', 'In conclusion, as I said before,',
    'Act I. A man enters. Why?', 'Sent from my iPhone', 'As per my last email,',
    'Thesis statement goes here', 'while (true) { procrastinate(); }', 'Roses are red, violets are… hm',
    'Q4 strategy: synergy?', 'Opening line, attempt 12', '<insert witty title>',
    'Things I should have said:', 'I am writing to complain about', 'Plot twist: there is no plot',
    'undefined is not a function', 'Ctrl+Z Ctrl+Z Ctrl+Z Ctrl+Z', 'A poem about paper (meta)',
    'Dear Sir or Madam, hey', 'Pros: none. Cons: see above.', 'The End?', 'WIP — do not read',
    'README.md (empty)', 'Haiku: five syllables here', 'Note to self: stop writing notes',
    'chapter_one_REAL.docx'
  ];

  // A line from the user's note, cleaned up for the sheet — or null if it's not a good draft.
  function cleanLine(t) {
    if (!t || t.length > 160) return null;
    t = t.replace(/^\s*(?:[-*+]\s+\[[ xX]\]\s+|\[[ xX]\]\s+|[-*+>]\s+|#{1,6}\s+|\d+[.)]\s+)/, '').replace(/\s+/g, ' ').trim();
    if (t.length < 4 || /^(```|~~~)/.test(t)) return null;
    if (!/[A-Za-z\u00C0-\u024F\u0370-\uFFFF]{2}/.test(t)) return null;   // needs some words
    if (!/\s/.test(t) && t.length > 24) return null;                    // URLs, keys, hashes
    if (t.length > 40) {
      var cut = t.slice(0, 39), sp = cut.lastIndexOf(' ');
      t = (sp >= 26 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…';
    }
    return t;
  }

  // ================= UI =================
  var KEY = 'cade-game-papertoss-', BEST_KEY = KEY + 'best', SOUND_KEY = KEY + 'sound', NOTES_KEY = KEY + 'notes';
  var S = null;   // the live session (one panel at a time)

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }

  // Tiny WebAudio voice. Created only from a user gesture (iOS), closed with the panel.
  function Snd(on) { this.on = !!on; this.ac = null; this.nb = null; }
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
  // Filtered noise: paper crackle, the whoosh of a throw, a soft landing.
  Snd.prototype.noise = function (dur, vol, f0, f1, type, delay, q) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      if (!this.nb) {
        var len = Math.floor(ac.sampleRate * 0.6), buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.nb = buf;
      }
      var t = ac.currentTime + (delay || 0), src = ac.createBufferSource(), fl = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = this.nb;
      fl.type = type || 'bandpass'; fl.Q.value = q || 0.9;
      fl.frequency.setValueAtTime(f0, t);
      if (f1) fl.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(fl); fl.connect(g); g.connect(ac.destination);
      src.start(t, Math.random() * 0.4); src.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; this.nb = null; } };

  function svg(path) {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_NOTE = svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>');

  // ---- theme colours (from the app's CSS variables) ----
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
    var bg = parseCol(v('--bg'), [17, 17, 16]), tx = parseCol(v('--text'), [231, 229, 227]);
    var ac = parseCol(v('--accent'), [15, 149, 152]), sf = parseCol(v('--surface'), bg);
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.55)), fa = parseCol(v('--text-faint'), mix(bg, tx, 0.35));
    var bd = parseCol(v('--border'), mix(bg, tx, 0.18));
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    S.dark = dark;
    S.col = {
      bg: css(bg), text: css(tx), muted: css(mu), faint: css(fa), border: css(bd), accent: css(ac),
      accentSoft: css(ac, 0.55), wall: css(mix(bg, tx, dark ? 0.035 : 0.03)), desk: css(mix(bg, tx, dark ? 0.05 : 0.045)),
      paper: css(dark ? mix(sf, tx, 0.05) : sf), dot: css(fa, dark ? 0.75 : 0.9), shadow: css(tx, dark ? 0.18 : 0.12),
      font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace'
    };
  }

  // ---- camera: one-point perspective, logical canvas units ----
  var VW = 360, VH = 540, CX = VW / 2, HOR = 150, FOC = 540, CAM_Y = 1.45, CAM_Z = -1.2;
  var DESK_Y = 440;                              // top edge of your desk (foreground)
  function P(x, y, z) {
    var s = FOC / Math.max(0.05, z - CAM_Z);
    return { x: CX + x * s, y: HOR - (y - CAM_Y) * s, s: s };
  }
  var REST = P(0, Y0, Z0);                       // where the paper sits on your desk

  // ASCII furniture on the back wall of each room (x/y in metres, lh = line height in m).
  function decos(key) {
    if (key === 'desk') {
      var d = new Date(), mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getMonth()];
      var day = String(d.getDate());
      return [
        { x: -0.62, y: 1.32, lh: 0.1, lines: ['+------+------+', '|      |      |', '|   .  |      |', '+------+------+', '|      |    * |', '|      |      |', '+------+------+'] },
        { x: 0.85, y: 1.38, lh: 0.1, lines: ['.--------.', '|  ' + mon + '   |', '|   ' + (day.length < 2 ? ' ' + day : day) + '   |', "'--------'"] }
      ];
    }
    if (key === 'office') {
      return [
        { x: -0.6, y: 1.35, lh: 0.13, lines: ['+-------------------+', '| TODO              |', '|  [x] write it     |', '|  [ ] write it     |', '|      better       |', '+-------------------+'] },
        { x: 1.2, y: 1.6, lh: 0.12, lines: ['  .-"-.  ', ' / 12  \\ ', '|9  o  3|', ' \\  6  / ', "  '-.-'  "] }
      ];
    }
    return [
      { x: 0, y: 0.55, lh: 0.17, lines: [' ________ ', '|  EXIT  |', '|        |', '|      o |', '|        |', '|________|'] }
    ];
  }

  // ---- drawing helpers ----
  function font(size, weight) { return (weight || 400) + ' ' + size.toFixed(2) + 'px ' + S.col.font; }
  function tx(c, s, x, y, size, weight, fill, align, base, halo) {
    c.font = font(size, weight);
    c.textAlign = align || 'center'; c.textBaseline = base || 'middle';
    if (halo) { c.lineJoin = 'round'; c.lineWidth = 4; c.strokeStyle = halo; c.strokeText(s, x, y); }
    c.fillStyle = fill; c.fillText(s, x, y);
  }
  function ease(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }

  function drawRoom(c, L, D, wall, side) {
    var k = S.col, base = P(0, 0, wall), i;
    // back wall + floor line
    c.fillStyle = k.wall; c.fillRect(0, 0, VW, base.y);
    // floor dots in perspective (one every half metre)
    c.fillStyle = k.dot;
    for (var z = 0.5; z < wall - 0.01; z += 0.5) {
      var row = P(0, 0, z), sz = clamp(row.s * 0.009, 1, 2.4);
      if (row.y > DESK_Y + 4 || row.y < base.y) continue;
      var half = (VW / 2 + 8) / row.s;
      for (var x = -Math.floor(half * 2) / 2; x <= half; x += 0.5) {
        if (side && Math.abs(x) > side - 0.01) continue;
        c.fillRect(CX + x * row.s - sz / 2, row.y - sz / 2, sz, sz);
      }
    }
    c.strokeStyle = k.border; c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, base.y + 0.5); c.lineTo(VW, base.y + 0.5); c.stroke();
    // hallway: side walls and ceiling converge on the far door
    if (side) {
      var ceil = 2.6, bl = P(-side, 0, wall), tl = P(-side, ceil, wall), br = P(side, 0, wall), tr = P(side, ceil, wall);
      var nb = P(-side, 0, 0.05), nt = P(-side, ceil, 0.05), nbr = P(side, 0, 0.05), ntr = P(side, ceil, 0.05);
      c.fillStyle = k.wall;
      c.beginPath(); c.moveTo(nb.x, nb.y); c.lineTo(bl.x, bl.y); c.lineTo(tl.x, tl.y); c.lineTo(nt.x, nt.y); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(nbr.x, nbr.y); c.lineTo(br.x, br.y); c.lineTo(tr.x, tr.y); c.lineTo(ntr.x, ntr.y); c.closePath(); c.fill();
      c.beginPath();
      c.moveTo(nb.x, nb.y); c.lineTo(bl.x, bl.y); c.lineTo(tl.x, tl.y); c.lineTo(nt.x, nt.y);
      c.moveTo(nbr.x, nbr.y); c.lineTo(br.x, br.y); c.lineTo(tr.x, tr.y); c.lineTo(ntr.x, ntr.y);
      c.moveTo(tl.x, tl.y); c.lineTo(tr.x, tr.y);
      c.stroke();
      // the floor outside the corridor is wall, not floor: cover the dots / line
      c.fillStyle = k.wall;
      c.beginPath(); c.moveTo(0, base.y - 1); c.lineTo(bl.x, bl.y - 0.5); c.lineTo(nb.x, nb.y); c.lineTo(0, nb.y); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(VW, base.y - 1); c.lineTo(br.x, br.y - 0.5); c.lineTo(nbr.x, nbr.y); c.lineTo(VW, nbr.y); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(nb.x, nb.y); c.lineTo(bl.x, bl.y); c.moveTo(nbr.x, nbr.y); c.lineTo(br.x, br.y); c.stroke();
    }
    // wall furniture, as ASCII art at the wall's depth
    var ds = S.decos[L.key] || (S.decos[L.key] = decos(L.key));
    for (i = 0; i < ds.length; i++) {
      var d = ds[i], p = P(d.x, d.y, wall), lh = d.lh * p.s, fs = lh / 1.18;
      if (fs < 4) continue;
      c.font = font(fs, 400); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = k.faint;
      var y0 = p.y - (d.lines.length - 1) * lh / 2;
      for (var j = 0; j < d.lines.length; j++) c.fillText(d.lines[j], p.x, y0 + j * lh);
    }
  }

  // Bin: a wire wastebasket in line art — rim ring, diagonal mesh, a "/dev/null" label.
  function ring(c, r, y, D, a0, a1) {
    var n = 28;
    for (var i = 0; i <= n; i++) {
      var a = a0 + (a1 - a0) * i / n, p = P(r * Math.cos(a), y, D + r * Math.sin(a));
      if (i) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y);
    }
  }
  function mesh(c, D, front, n) {
    var tw = Math.PI / n * 1.0;
    for (var i = 0; i < n; i++) {
      var a = i * 2 * Math.PI / n;
      for (var sgn = -1; sgn <= 1; sgn += 2) {
        var at = a + sgn * tw, mid = Math.sin((a + at) / 2);
        if ((mid < 0) !== front) continue;
        var b = P(BIN_RB * Math.cos(a), 0.02, D + BIN_RB * Math.sin(a)), t = P(BIN_R * Math.cos(at), BIN_H - 0.01, D + BIN_R * Math.sin(at));
        c.moveTo(b.x, b.y); c.lineTo(t.x, t.y);
      }
    }
  }
  function drawBinBack(c, D) {
    var k = S.col, s = P(0, BIN_H, D).s, n = s > 120 ? 14 : 10;
    c.lineWidth = Math.max(0.8, s * 0.006); c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = k.faint;
    c.beginPath(); mesh(c, D, false, n); ring(c, BIN_RB, 0.02, D, 0, Math.PI); c.stroke();
    c.strokeStyle = k.muted; c.lineWidth = Math.max(1, s * 0.009);
    c.beginPath(); ring(c, BIN_R, BIN_H, D, 0, Math.PI); c.stroke();
  }
  function drawBinFront(c, D) {
    var k = S.col, s = P(0, BIN_H, D).s, n = s > 120 ? 14 : 10;
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = k.muted; c.lineWidth = Math.max(0.8, s * 0.006);
    c.beginPath(); mesh(c, D, true, n); c.stroke();
    // outline: sides and the front of the base
    var l0 = P(-BIN_RB, 0.02, D), l1 = P(-BIN_R, BIN_H, D), r0 = P(BIN_RB, 0.02, D), r1 = P(BIN_R, BIN_H, D);
    c.strokeStyle = k.text; c.lineWidth = Math.max(1, s * 0.008);
    c.beginPath(); c.moveTo(l0.x, l0.y); c.lineTo(l1.x, l1.y); c.moveTo(r0.x, r0.y); c.lineTo(r1.x, r1.y);
    ring(c, BIN_RB, 0.02, D, Math.PI, 2 * Math.PI); c.stroke();
    c.lineWidth = Math.max(1.2, s * 0.012);
    c.beginPath(); ring(c, BIN_R, BIN_H, D, Math.PI, 2 * Math.PI); c.stroke();
    // label
    var lp = P(0, BIN_H * 0.5, D - (BIN_RB + BIN_R) / 2), fs = 0.052 * lp.s;
    if (fs >= 5.5) {
      c.font = font(fs, 600);
      var w = c.measureText('/dev/null').width + fs * 0.9, h = fs * 1.5;
      c.fillStyle = k.bg; c.fillRect(lp.x - w / 2, lp.y - h / 2, w, h);
      c.strokeStyle = k.border; c.lineWidth = 1; c.strokeRect(lp.x - w / 2 + 0.5, lp.y - h / 2 + 0.5, w - 1, h - 1);
      tx(c, '/dev/null', lp.x, lp.y + fs * 0.05, fs, 600, k.muted);
    }
  }

  // `shadowY`: the surface under the ball (floor, bin bottom or desk top); null = no shadow.
  // A floor shadow that would land on the desk is hidden by the desk.
  function drawBall(c, x, y, z, spin, alpha, shadowY, onDesk) {
    var k = S.col, p = P(x, y, z), rp = BALL_R * p.s;
    alpha = alpha == null ? 1 : alpha;
    if (shadowY != null) {
      var sh = P(x, shadowY, z);
      if (onDesk || sh.y < DESK_Y - 1) {
        c.globalAlpha = alpha * clamp(1 - (y - shadowY) / 2.2, 0.15, 1);
        c.fillStyle = k.shadow;
        c.beginPath(); c.ellipse(sh.x, sh.y, rp * 0.95, rp * 0.32, 0, 0, Math.PI * 2); c.fill();
      }
    }
    c.globalAlpha = alpha;
    c.save();
    c.translate(p.x, p.y); c.rotate(spin);
    var fs = rp * 2.55;
    c.font = font(fs, 700); c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineJoin = 'round'; c.lineWidth = Math.max(1.5, fs * 0.16); c.strokeStyle = k.bg;
    c.strokeText('@', 0, fs * 0.04);
    c.fillStyle = k.text; c.fillText('@', 0, fs * 0.04);
    c.restore();
    c.globalAlpha = 1;
  }

  // The fan stands on the upwind side, head turned into the room; blades are an ASCII spinner.
  var SPIN = ['|', '/', '—', '\\'];
  function fanPos(L, D, side) {
    var fz = clamp(D * 0.7, 1.2, 3.9), s = FOC / (fz - CAM_Z), fx = side * (VW / 2 - 42) / s;
    if (L.side) fx = side * (L.side - 0.3);
    return { x: fx, z: fz };
  }
  function drawFan(c, L, D, wind, t) {
    var k = S.col, side = wind > 0 ? -1 : 1, f = fanPos(L, D, side);
    var head = P(f.x, 0.85, f.z), foot = P(f.x, 0, f.z), r = 0.12 * head.s, on = Math.abs(wind) > 0.05;
    c.lineCap = 'round';
    // stand + base
    c.strokeStyle = k.muted; c.lineWidth = Math.max(1, r * 0.06);
    c.beginPath(); c.moveTo(head.x, head.y + r); c.lineTo(foot.x, foot.y);
    c.moveTo(foot.x - r * 0.6, foot.y); c.lineTo(foot.x + r * 0.6, foot.y); c.stroke();
    // cage
    c.fillStyle = k.bg; c.strokeStyle = k.text; c.lineWidth = Math.max(1.2, r * 0.07);
    c.beginPath(); c.arc(head.x, head.y, r, 0, Math.PI * 2); c.fill(); c.stroke();
    c.strokeStyle = k.faint; c.lineWidth = 1;
    c.setLineDash([2, 3]);
    c.beginPath(); c.arc(head.x, head.y, r * 0.66, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
    // blades: the classic | / — \ spinner, faster in a stronger wind
    var rate = on ? 3 + Math.abs(wind) * 2.6 : 0, idx = S.rm ? 1 : Math.floor(t * rate) % 4;
    tx(c, on ? SPIN[idx] : '/', head.x, head.y, r * 1.25, on ? 700 : 400, on ? k.accent : k.faint);
    // gusts drift off the downwind side
    if (on) {
      var n = clamp(Math.round(Math.abs(wind)), 1, 5), dir = -side;
      for (var i = 0; i < n; i++) {
        var ph = S.rm ? i / n : ((t * (0.6 + Math.abs(wind) * 0.25) + i / n) % 1);
        var gx = head.x + dir * (r * 1.3 + ph * r * 2.6), gy = head.y + (i % 2 ? 0.35 : -0.35) * r * (1 - ph * 0.3);
        c.globalAlpha = (1 - ph) * 0.9;
        tx(c, '~', gx, gy, r * 0.75, 700, k.accent);
      }
      c.globalAlpha = 1;
    }
  }

  // The draft on your desk: a sheet with a filename, a gutter, the line and a caret.
  function wrap(s, max) {
    if (s.length <= max) return [s];
    var cut = s.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    var a = s.slice(0, cut).trim(), b = s.slice(cut).trim();
    if (b.length > max) b = b.slice(0, max - 1) + '…';
    return [a, b];
  }
  function drawSheet(c, cx, cy, sc, rot, alpha, t) {
    var k = S.col, dr = S.draft;
    if (!dr) return;
    c.font = font(13, 400);
    var cw = c.measureText('MMMMMMMMMM').width / 10, w = 316, max = Math.floor((w - 50) / cw);
    var lines = wrap(dr.text, max), h = lines.length > 1 ? 82 : 64;
    c.save();
    c.globalAlpha = alpha;
    c.translate(cx, cy); c.rotate(rot); c.scale(sc, sc);
    var x0 = -w / 2, y0 = -h / 2;
    c.fillStyle = k.paper; c.fillRect(x0, y0, w, h);
    c.strokeStyle = k.border; c.lineWidth = 1; c.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
    // filename tab
    tx(c, dr.name, x0 + 10, y0 + 11, 9.5, 500, k.faint, 'left');
    tx(c, dr.src === 'note' ? 'from this note' : 'rejected', x0 + w - 10, y0 + 11, 9.5, 500, k.faint, 'right');
    c.strokeStyle = k.border;
    c.beginPath(); c.moveTo(x0, y0 + 21.5); c.lineTo(x0 + w, y0 + 21.5); c.stroke();
    // gutter + margin rule
    c.strokeStyle = k.accentSoft;
    c.beginPath(); c.moveTo(x0 + 32.5, y0 + 22); c.lineTo(x0 + 32.5, y0 + h); c.stroke();
    var ly = y0 + 22 + (h - 22) / (lines.length + 1);
    for (var i = 0; i < lines.length; i++) {
      var yy = ly + i * 20;
      tx(c, String(dr.line + i), x0 + 26, yy, 10, 400, k.faint, 'right');
      tx(c, lines[i], x0 + 40, yy, 13, 500, k.text, 'left');
    }
    // caret after the last line, blinking (steady when motion is reduced)
    if (S.rm || Math.floor(t * 1.8) % 2 === 0) {
      c.font = font(13, 500);
      var lx = x0 + 40 + c.measureText(lines[lines.length - 1]).width + 2, cy2 = ly + (lines.length - 1) * 20;
      c.fillStyle = k.accent; c.fillRect(lx, cy2 - 8, 2, 16);
    }
    c.restore();
  }

  // ASCII power meter for keyboard throws: [=====·····]
  function drawMeter(c, m, last) {
    var k = S.col, n = 16, y = REST.y - 52, cw = 9, x0 = CX - (n * cw) / 2;
    c.fillStyle = k.bg; c.globalAlpha = 0.85; c.fillRect(x0 - 16, y - 12, n * cw + 32, 24); c.globalAlpha = 1;
    tx(c, '[', x0 - 6, y, 13, 600, k.muted);
    tx(c, ']', x0 + n * cw + 6, y, 13, 600, k.muted);
    var fill = Math.round(m * n);
    for (var i = 0; i < n; i++) tx(c, i < fill ? '=' : '·', x0 + i * cw + cw / 2, y, 13, 700, i < fill ? k.accent : k.faint);
    if (last != null) tx(c, '^', x0 + clamp(last, 0, 1) * n * cw, y + 14, 10, 600, k.muted);
  }

  function hud(c, g, L, t) {
    var k = S.col, w = g.wind, h = k.wall;      // a wall-coloured halo keeps text clear of the line art
    tx(c, L.path, 14, 20, 12, 600, k.text, 'left', null, h);
    var next = LEVELS[g.level + 1];
    tx(c, L.D.toFixed(1) + 'm' + (next ? ' · ' + (next.at - g.streak) + ' to ' + next.path : ''), 14, 37, 10, 400, k.muted, 'left', null, h);
    // wind, right aligned: "wind ← 2.4"
    c.font = font(12, 700);
    var num = Math.abs(w) < 0.05 ? 'calm' : Math.abs(w).toFixed(1), nw = c.measureText(num).width;
    tx(c, num, VW - 14, 20, 12, 700, k.text, 'right', null, h);
    var arrow = Math.abs(w) < 0.05 ? '·' : w < 0 ? '←' : '→';
    tx(c, arrow, VW - 14 - nw - 6, 20, 14, 700, k.accent, 'right', null, h);
    c.font = font(14, 700);
    tx(c, 'wind', VW - 14 - nw - 12 - c.measureText(arrow).width, 20, 12, 400, k.muted, 'right', null, h);
    // strength pips
    var n = Math.round(Math.abs(w) / 4.5 * 5);
    for (var i = 0; i < 5; i++) {
      var px = VW - 14 - (5 - i) * 7 + 1.5;
      if (i < n) { c.fillStyle = k.accent; c.fillRect(px, 33, 4.5, 8); }
      else { c.strokeStyle = k.faint; c.lineWidth = 1; c.strokeRect(px + 0.5, 33.5, 3.5, 7); }
    }
    // score
    var pop = S.rm ? 1 : 1 + 0.3 * Math.max(0, S.pop / 0.18);
    tx(c, String(g.score), CX, 30, Math.round(28 * pop), 800, k.text, null, null, h);
    if (g.streak > 1) tx(c, 'streak ×' + g.streak, CX, 54, 10, 500, k.muted, null, null, h);
  }

  function drawMsg(c, now) {
    var m = S.msg;
    if (!m) return;
    var age = now - m.t0, a = clamp(Math.min(age / 0.12, (m.dur - age) / 0.35), 0, 1);
    if (a <= 0) return;
    var k = S.col, y = 86 - (S.rm ? 0 : (1 - ease(age / 0.25)) * 8);
    c.globalAlpha = a;
    c.font = font(16, 700);
    var w = Math.max(c.measureText(m.text).width, m.sub ? (c.font = font(11, 500), c.measureText(m.sub).width) : 0) + 24;
    c.globalAlpha = a * 0.9;
    c.fillStyle = k.wall; c.fillRect(CX - w / 2, y - 16, w, m.sub ? 50 : 32);
    c.globalAlpha = a;
    tx(c, m.text, CX, y, 16, 700, m.good ? k.accent : k.text);
    if (m.sub) tx(c, m.sub, CX, y + 21, 11, 500, k.muted);
    c.globalAlpha = 1;
  }

  // ---- full frame ----
  function draw(alpha, now) {
    if (!S || !S.ctx) return;
    var c = S.ctx, k = S.col, g = S.g, L = LEVELS[S.viewLevel], i;
    now = now == null ? perfNow() : now;
    var t = now - S.t0;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.fillStyle = k.bg; c.fillRect(0, 0, VW, VH);
    // bin distance tweens when the level changes
    var tw = S.tween, D = L.D, wall = L.wall, side = L.side;
    if (tw) {
      var e = ease((now - tw.t0) / tw.dur), A = LEVELS[tw.from], B = LEVELS[tw.to];
      D = A.D + (B.D - A.D) * e; wall = A.wall + (B.wall - A.wall) * e;
      side = e < 0.5 ? A.side : B.side;
      L = e < 0.5 ? A : B;
    }
    drawRoom(c, L, D, wall, side);

    var b = S.ball, bx = 0, by = 0, bz = 0, bspin = 0, ballBack = false;
    if (b) {
      var a = alpha == null ? 1 : alpha;
      bx = b.px + (b.x - b.px) * a; by = b.py + (b.y - b.py) * a; bz = b.pz + (b.z - b.pz) * a;
      bspin = b.pspin + (b.spin - b.pspin) * a;
      ballBack = b.inBin || bz > D + BIN_R * 0.3 || (by < BIN_H + BALL_R && bz > D - BIN_R);
    }
    // litter behind the bin, the bin's back half, anything inside it, then its front
    for (i = 0; i < S.litter.length; i++) if (S.litter[i].z >= D) drawBall(c, S.litter[i].x, BALL_R, S.litter[i].z, S.litter[i].r, 0.55, 0);
    drawBinBack(c, D);
    for (i = 0; i < S.binned.length; i++) drawBall(c, S.binned[i].x, S.binned[i].y, D + S.binned[i].dz, S.binned[i].r, 0.8, 0);
    if (b && ballBack) drawBall(c, bx, by, bz, bspin, 1, 0);
    drawBinFront(c, D);
    for (i = 0; i < S.litter.length; i++) if (S.litter[i].z < D) drawBall(c, S.litter[i].x, BALL_R, S.litter[i].z, S.litter[i].r, 0.55, 0);
    drawFan(c, L, D, tw ? 0 : g.wind, t);
    // a ball below desk height (a limp throw) drops out of sight behind the desk
    var lowBall = b && !ballBack && by < Y0 - 0.03;
    if (lowBall) drawBall(c, bx, by, bz, bspin, 1, 0);

    // your desk, and the draft on it
    c.fillStyle = k.desk; c.fillRect(0, DESK_Y, VW, VH - DESK_Y);
    c.strokeStyle = k.border; c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, DESK_Y + 0.5); c.lineTo(VW, DESK_Y + 0.5); c.stroke();

    var ph = S.phase;
    if (ph === 'ready') {
      var fe = S.feedT0 ? ease((now - S.feedT0) / 0.28) : 1;
      drawSheet(c, CX, REST.y - 4 + (1 - fe) * 96, 1, 0, fe, t);
    } else if (ph === 'held') {
      var ce = clamp((now - S.crumpleT0) / 0.2, 0, 1);
      if (ce < 1) drawSheet(c, CX, REST.y - 4 * (1 - ce), 1 - 0.88 * ease(ce), ce * 0.9, 1 - ce * ce, t);
      if (ce > 0.45) drawBall(c, 0, Y0, Z0, S.heldSpin, clamp((ce - 0.45) / 0.4, 0, 1), Y0 - BALL_R, true);
    }
    if (b && !ballBack && !lowBall) drawBall(c, bx, by, bz, bspin, 1, bz < 0.25 ? Y0 - BALL_R : 0, bz < 0.25);

    // keyboard aim guide: the first few metres of the throw's direction
    if (S.kb && (ph === 'ready' || ph === 'held')) {
      var v = launchVel(LEVELS[g.level], S.aim, 0);
      c.fillStyle = k.accent;
      for (i = 1; i <= 6; i++) {
        var tt = i * 0.045, gp = P(v.vx * tt, Y0 + v.vy * tt - G * tt * tt / 2, v.vz * tt);
        c.globalAlpha = 1 - i * 0.13;
        c.beginPath(); c.arc(gp.x, gp.y, 2.4 - i * 0.2, 0, Math.PI * 2); c.fill();
      }
      c.globalAlpha = 1;
    }
    if (S.charge) drawMeter(c, meterAt(now), S.lastMeter);
    // flick trail
    if (S.trail.length) {
      c.fillStyle = k.accent;
      for (i = 0; i < S.trail.length; i++) {
        var tp = S.trail[i], age = now - tp.t;
        if (age > 0.35) continue;
        c.globalAlpha = (1 - age / 0.35) * 0.6;
        c.fillRect(tp.x - 1.5, tp.y - 1.5, 3, 3);
      }
      c.globalAlpha = 1;
    }

    hud(c, g, LEVELS[g.level], t);
    if (S.intro && ph !== 'fly') {
      var sub = S.coarse ? 'swipe up from the paper · aim into the wind' : 'drag up & release · or ←/→ aim, hold space';
      c.font = font(10.5, 400);
      var iw = c.measureText(sub).width + 24;
      c.fillStyle = k.wall; c.fillRect(CX - iw / 2, 70, iw, 44);
      tx(c, 'flick the draft into the bin', CX, 84, 13, 600, k.text);
      tx(c, sub, CX, 102, 10.5, 400, k.muted);
    }
    drawMsg(c, now);
  }

  // ---- loop ----
  function perfNow() { return (window.performance && performance.now ? performance.now() : Date.now()) / 1000; }
  // An input event's own time (same clock as performance.now in modern browsers), in s.
  function evT(e) { var t = e && e.timeStamp; return t > 0 && t < 1e11 ? t / 1000 : perfNow(); }
  function meterAt(now) {
    var p = ((now - S.charge.t0) / 0.9) % 2;
    return p < 1 ? p : 2 - p;                    // ping-pong 0 → 1 → 0
  }
  function busy(now) {
    if (!S || S.paused) return false;
    return S.phase === 'fly' || !!S.charge || !!S.drag || now < S.animUntil;
  }
  function kick() {
    if (!S || S.raf || S.paused) return;
    S.last = 0;
    S.raf = requestAnimationFrame(frame);
  }
  function anim(until) { if (S) { S.animUntil = Math.max(S.animUntil, until); kick(); } }

  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    var now = perfNow(), dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    var alpha = 1;
    if (S.phase === 'fly' && S.ball) {
      alpha = advance(S.ball, dt);
      handleEvents(now);
      if (S.ball.state === 'done') landed(now);
    }
    if (S.phase === 'after' && now >= S.nextAt) nextDraft(now);
    if (S.tween && now - S.tween.t0 >= S.tween.dur) { S.viewLevel = S.tween.to; S.tween = null; }
    S.pop = Math.max(0, S.pop - dt);
    if (S.msg && now - S.msg.t0 > S.msg.dur) {
      S.msg = null;
      if (S.msgQ.length) { var q = S.msgQ.shift(); say(q.text, q.sub, q.good, q.dur); }
    }
    draw(alpha, now);
    if (busy(now)) S.raf = requestAnimationFrame(frame);
    else idle();
  }

  // When nothing is moving, a cheap 12 Hz tick keeps the fan spinning and the
  // caret blinking for a while; it stops after 30 s without input (and never runs
  // with reduced motion, on blur or with the tab hidden).
  function idle() {
    if (!S || S.rm || S.idleT || S.raf || S.paused || document.hidden || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    if (perfNow() > S.idleUntil) return;
    S.idleT = setTimeout(function () {
      if (!S) return;
      S.idleT = 0;
      if (!S.panel.isConnected) { teardown(); return; }
      if (S.raf) return;
      draw(1);
      idle();
    }, 83);
  }
  function poke() {                             // any input: keep the idle tick alive
    if (!S) return;
    S.idleUntil = perfNow() + 30;
    idle();
  }

  var SWISH = [':wq', 'swish. clean delete.', 'rm draft ✓', 'nothing but bin', 'deleted.', 'to /dev/null ✓'];
  var RIMIN = ['in off the rim', 'rattled in', 'saved by the rim'];
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function say(text, sub, good, dur, queue) {
    var m = { text: text, sub: sub || '', good: !!good, t0: perfNow(), dur: dur || 1.1 };
    if (queue && S.msg) { S.msgQ.push(m); anim(S.msg.t0 + S.msg.dur + m.dur); return; }
    S.msg = m;
    if (S.live) S.live.textContent = text + (sub ? ' — ' + sub : '');
    anim(m.t0 + m.dur);
  }

  function handleEvents(now) {
    var b = S.ball, ev = b.events, snd = S.snd;
    for (var i = 0; i < ev.length; i++) {
      switch (ev[i]) {
        case 'rim':
          snd.tone(1250, 0.12, 'triangle', 0.05); snd.tone(1870, 0.09, 'sine', 0.03, 0, 0.004);
          Cade.haptic(6);
          break;
        case 'bin': snd.tone(720, 0.05, 'triangle', 0.025); break;
        case 'wall': snd.noise(0.07, 0.05, 420, 0, 'lowpass'); break;
        case 'floor': snd.noise(0.09, 0.06, 320, 0, 'lowpass'); break;
        case 'in':
          S.pop = 0.18;
          snd.noise(0.12, 0.06, 520, 180, 'lowpass');
          snd.tone(660, 0.1, 'sine', 0.045, 0, 0.03); snd.tone(990, 0.16, 'sine', 0.04, 0, 0.1);
          if (!b.rims) snd.tone(1320, 0.18, 'sine', 0.03, 0, 0.17);
          Cade.haptic(10);
          say(b.rims ? pick(RIMIN) : pick(SWISH), '+' + (LEVELS[S.g.level].pts + (b.rims ? 0 : 1)) + (b.rims ? '' : ' · swish bonus'), true, 1.3);
          break;
      }
    }
    ev.length = 0;
  }

  // The ball has stopped: score it, move on.
  function landed(now) {
    var b = S.ball, g = S.g, res = judge(b), out = applyResult(g, res);
    S.ball = null;
    if (res.result === 'in') {
      S.binned.push({ x: b.x, y: b.y, dz: b.z - b.L.D, r: b.spin });
      if (S.binned.length > 4) S.binned.shift();
      if (out.levelTo !== out.levelFrom) {
        S.snd.tone(523, 0.1, 'triangle', 0.035, 0, 0.25); S.snd.tone(784, 0.14, 'triangle', 0.035, 0, 0.35);
        say('cd ' + LEVELS[out.levelTo].path, 'the bin moves back · ' + LEVELS[out.levelTo].pts + ' pts a basket', true, 1.6, true);
      }
    } else {
      S.litter.push({ x: b.x, z: b.z, r: b.spin });
      if (S.litter.length > 6) S.litter.shift();
      var where = res.kind === 'rim' ? 'rimmed out' : res.kind === 'left' ? 'wide ← ' + res.by.toFixed(1) + 'm'
        : res.kind === 'right' ? 'wide → ' + res.by.toFixed(1) + 'm' : res.kind + ' by ' + res.by.toFixed(1) + 'm';
      S.snd.tone(330, 0.16, 'sine', 0.04, 220, 0.02);
      var nb = out.runScore > S.best;
      if (nb) {
        S.best = out.runScore; sset(BEST_KEY, S.best);
        [784, 988, 1175, 1568].forEach(function (f, j) { S.snd.tone(f, 0.12, 'triangle', 0.04, 0, 0.2 + j * 0.08); });
      }
      say(where, out.runScore ? (nb ? 'new best! ' : 'run over · ') + out.runScore + ' pts' : 'the draft lives on (on the floor)', false, 1.5);
    }
    if (out.levelTo !== out.levelFrom) {
      S.tween = { from: out.levelFrom, to: out.levelTo, t0: now + 0.35, dur: S.rm ? 0.01 : 0.7 };
      S.litter = []; S.binned = [];
      anim(now + 1.1);
    }
    S.phase = 'after';
    S.nextAt = now + (res.result === 'in' ? 0.75 : 1.0);
    anim(S.nextAt + 0.4);
    syncBar();
  }

  // ---- drafts ----
  function noteDraft() {
    try {
      var doc = Cade.editor && Cade.editor.state && Cade.editor.state.doc;
      if (!doc || !doc.lines) return null;
      for (var n = 0; n < 14; n++) {
        var ln = 1 + Math.floor(Math.random() * doc.lines), c = cleanLine(doc.line(ln).text);
        if (c && c !== (S.draft && S.draft.text)) return { text: c, src: 'note', line: ln, name: 'this note' };
      }
    } catch (e) {}
    return null;
  }
  function bookDraft() {
    if (!S.deck.length) {
      for (var i = 0; i < DRAFTS.length; i++) S.deck.push(i);
      for (var j = S.deck.length - 1; j > 0; j--) { var r = Math.floor(Math.random() * (j + 1)), tmp = S.deck[j]; S.deck[j] = S.deck[r]; S.deck[r] = tmp; }
    }
    S.draftNo++;
    var no = String(S.draftNo);
    while (no.length < 3) no = '0' + no;
    return { text: DRAFTS[S.deck.pop()], src: 'book', line: 1, name: 'draft_' + no + '.txt' };
  }
  function pickDraft() { return (S.notesOn && Math.random() < 0.35 && noteDraft()) || bookDraft(); }

  function nextDraft(now) {
    S.draft = pickDraft();
    S.phase = 'ready';
    S.feedT0 = S.rm ? 0 : now;
    anim(now + 0.3);
    syncBar();
  }

  // ---- actions ----
  function crumple(now) {
    if (S.phase === 'after') nextDraft(now);    // impatient: skip straight to the next sheet
    if (S.phase !== 'ready') return S.phase === 'held';
    S.phase = 'held';
    S.crumpleT0 = S.rm ? now - 1 : now;
    S.heldSpin = (Math.random() - 0.5) * 0.8;
    var snd = S.snd;
    snd.noise(0.05, 0.07, 3200, 0, 'bandpass', 0, 0.7); snd.noise(0.04, 0.06, 2400, 0, 'bandpass', 0.04, 0.7);
    snd.noise(0.05, 0.05, 4200, 0, 'bandpass', 0.08, 0.7); snd.noise(0.06, 0.04, 1800, 0, 'bandpass', 0.12, 0.7);
    anim(now + 0.25);
    return true;
  }
  function throwIt(aim, pow, now) {
    if (!S || S.phase !== 'held') return;
    S.intro = false;
    S.ball = newBall(LEVELS[S.g.level], S.g.wind, aim, pow);
    S.ball.spin = S.ball.pspin = S.heldSpin;
    S.phase = 'fly';
    S.snd.noise(0.22, 0.05, 600, 2600, 'bandpass', 0, 0.7);
    kick();
  }

  // ---- pointer: flick to throw ----
  // Flick speed is measured over the last ~70 ms, in canvas-heights per second so a
  // phone and a big desktop canvas feel alike, and turned into doublings of the
  // "right" speed (touch flicks run faster than mouse drags).
  var REF_SPEED = { touch: 3.4, pen: 3.4, mouse: 2.6 };
  function logical(e) {
    var r = S.cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * VW, y: (e.clientY - r.top) / r.height * VH, h: r.height || 1 };
  }
  function onDown(e) {
    if (!S || e.button > 0 || S.drag) return;
    e.preventDefault();
    S.snd.ensure();
    poke();
    if (S.paused) { resume(); return; }
    if (S.phase === 'fly') return;
    var now = perfNow();
    if (!crumple(now)) return;
    try { S.cv.setPointerCapture(e.pointerId); } catch (er) {}
    var p = logical(e);
    S.drag = { id: e.pointerId, type: e.pointerType || 'mouse', pts: [{ x: e.clientX, y: e.clientY, t: evT(e) }], h: p.h, x0: e.clientX, y0: e.clientY };
    S.trail = [{ x: p.x, y: p.y, t: now }];
    S.kb = false;
    kick();
  }
  function onMove(e) {
    if (!S || !S.drag || e.pointerId !== S.drag.id) return;
    var now = perfNow(), d = S.drag, pts = d.pts;
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (!evs || !evs.length) evs = [e];
    for (var i = 0; i < evs.length; i++) pts.push({ x: evs[i].clientX, y: evs[i].clientY, t: evT(evs[i]) });
    while (pts.length > 2 && pts[pts.length - 1].t - pts[0].t > 0.3) pts.shift();
    var p = logical(e);
    S.trail.push({ x: p.x, y: p.y, t: now });
    if (S.trail.length > 24) S.trail.shift();
  }
  function onUp(e) {
    if (!S || !S.drag || e.pointerId !== S.drag.id) return;
    var d = S.drag, now = perfNow();
    S.drag = null;
    S.snd.ensure();                             // iOS unlocks audio on touchend
    try { S.cv.releasePointerCapture(e.pointerId); } catch (er) {}
    anim(now + 0.4);                            // let the trail fade
    if (e.type === 'pointercancel' || S.phase !== 'held') return;
    d.pts.push({ x: e.clientX, y: e.clientY, t: evT(e) });
    // Speed from the final ~70 ms of the gesture; direction from the final ~150 ms
    // (a thumb flick curls at the very end, so a longer chord aims truer).
    var last = d.pts[d.pts.length - 1], ref = d.pts[0], refD = d.pts[0], i;
    for (i = d.pts.length - 1; i >= 0; i--) { ref = d.pts[i]; if (last.t - d.pts[i].t >= 0.07) break; }
    for (i = d.pts.length - 1; i >= 0; i--) { refD = d.pts[i]; if (last.t - d.pts[i].t >= 0.15) break; }
    var dtm = Math.max(0.016, last.t - ref.t), vx = (last.x - ref.x) / dtm, vy = (last.y - ref.y) / dtm;
    var up = d.y0 - e.clientY, speed = Math.sqrt(vx * vx + vy * vy) / d.h;
    if (up < 14 || vy > -40 || speed < 0.5) {
      say(up < 14 ? 'flick upward to throw' : 'release while moving', 'the paper\'s ready', false, 1.2);
      return;
    }
    var ax = last.x - refD.x, ay = last.y - refD.y;
    if (ay > -4) { ax = vx; ay = vy; }
    var aim = Math.atan2(ax, -ay), pow = Math.log(speed / (REF_SPEED[d.type] || 3)) / Math.LN2;
    throwIt(aim, pow, now);
  }

  // ---- keyboard: ←/→ aim, hold Space (or ↑) to charge, release to throw ----
  var KEY2CODE = { ' ': 'Space', arrowup: 'ArrowUp', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', enter: 'Enter', escape: 'Escape' };
  function isThrowKey(code) { return code === 'Space' || code === 'ArrowUp' || code === 'Enter' || code === 'NumpadEnter'; }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return; // parked in the dock: keys belong to the editor
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !S.panel.contains(t)) return;
    var code = e.code || KEY2CODE[(e.key || '').toLowerCase()] || '', now = perfNow();
    if (code === 'Escape') { e.preventDefault(); closePanel(); return; }
    if (code === 'ArrowLeft' || code === 'ArrowRight') {
      e.preventDefault();
      poke();
      if (S.paused) return;
      S.aim = clamp(S.aim + (code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.12 : 0.035), -AIM_MAX, AIM_MAX);
      S.kb = true;
      if (!S.raf) draw(1, now);
      return;
    }
    if (isThrowKey(code)) {
      e.preventDefault();
      if (e.repeat) return;
      S.snd.ensure();
      poke();
      if (S.paused) { resume(); return; }
      if (S.phase === 'fly' || S.charge) return;
      if (!crumple(now)) return;
      S.kb = true;
      S.charge = { t0: now, code: code };
      kick();
    }
  }
  function onKeyUp(e) {
    if (!S || !S.charge) return;
    var code = e.code || KEY2CODE[(e.key || '').toLowerCase()] || '';
    if (!isThrowKey(code)) return;
    e.preventDefault();
    var now = perfNow(), m = meterAt(now);
    S.charge = null;
    S.lastMeter = m;
    // meter → power: the sweet spot sits at 60% of the bar
    throwIt(S.aim, (m - 0.6) * 2.4, now);
  }

  // ---- pause (only matters mid-flight; everything else is turn based) ----
  function pause() {
    if (!S) return;
    clearTimeout(S.idleT); S.idleT = 0;
    S.charge = null; S.drag = null;
    if (S.phase !== 'fly' || S.paused) return;
    S.paused = true;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    S.ovl.innerHTML = '<div class="pt-card"><div class="pt-title">Paused</div>' +
      '<button type="button" class="pt-go" data-act="resume">Resume</button>' +
      '<div class="pt-note">' + (S.coarse ? 'Tap anywhere' : 'Space / click') + ' to carry on</div></div>';
    S.ovl.style.display = '';
    S.stage.classList.add('dim');
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    S.ovl.innerHTML = ''; S.ovl.style.display = 'none';
    S.stage.classList.remove('dim');
    kick();
  }

  function syncBar() {
    if (!S) return;
    var sb = S.bar.querySelector('[data-act="sound"]'), nb = S.bar.querySelector('[data-act="notes"]');
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title); sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
    nb.innerHTML = IC_NOTE;
    nb.title = S.notesOn ? 'Drafts include lines from this note (on)' : 'Drafts include lines from this note (off)';
    nb.setAttribute('aria-label', nb.title); nb.setAttribute('aria-pressed', S.notesOn ? 'true' : 'false');
    nb.classList.toggle('on', S.notesOn);
    var g = S.g, L = LEVELS[g.level], w = g.wind;
    S.cv.setAttribute('aria-label', 'Paper Toss — ' + L.path + ', bin ' + L.D.toFixed(1) + ' m away, wind ' +
      (Math.abs(w) < 0.05 ? 'calm' : (w < 0 ? 'left ' : 'right ') + Math.abs(w).toFixed(1)) + ', score ' + g.score + ', streak ' + g.streak +
      '. Draft: "' + (S.draft ? S.draft.text : '') + '". Flick up to throw, or ←/→ to aim and hold Space.');
    S.hint.innerHTML = 'Best <b>' + S.best + '</b>' + (g.thrown ? ' <span class="pt-sep">·</span> <b>' + g.made + '</b>/' + g.thrown + ' in' : '');
  }

  // ---- layout ----
  // Height the canvas may use: the visible viewport minus the panel's real top
  // offset and chrome (title bar, padding, control bar, safe-area padding).
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height) return vh - (vw <= 560 ? 150 : 170);
    var chrome = r.height - (S.stage.offsetHeight || 0);
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 12;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var s = Math.min((vw - (vw <= 560 ? 42 : 48)) / VW, availH(vw, vh) / VH, 1.25);
    s = Math.max(s, 0.55);
    var cw = Math.floor(VW * s), ch = Math.floor(VH * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / VW;
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.idleT); clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('keyup', s.onKeyUp, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('focus', s.onFocus);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
  }
  function closePanel() {
    var p = document.getElementById('papertoss-panel');
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }

  function open() {
    Cade.closeAllMenus();
    if (document.getElementById('papertoss-panel')) { closePanel(); return; }
    var body = '<div class="pt"><div class="pt-stage"><canvas class="pt-cv" aria-label="Paper Toss: flick the crumpled draft into the bin"></canvas>' +
      '<div class="pt-ovl" style="display:none"></div></div>' +
      '<div class="pt-bar"><span class="pt-hint"></span>' +
      '<button type="button" class="pt-ib" data-act="notes"></button>' +
      '<button type="button" class="pt-ib" data-act="sound"></button></div>' +
      '<div class="pt-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel('papertoss-panel', '🗑️ Paper Toss', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var mm = window.matchMedia, now = perfNow();
    var best = 0;
    try { best = Math.max(0, parseInt(sget(BEST_KEY) || '0', 10) || 0); } catch (e) {}
    S = {
      panel: p, stage: p.querySelector('.pt-stage'), cv: p.querySelector('.pt-cv'), ovl: p.querySelector('.pt-ovl'),
      bar: p.querySelector('.pt-bar'), hint: p.querySelector('.pt-hint'), live: p.querySelector('.pt-live'),
      snd: new Snd(sget(SOUND_KEY) === '1'), notesOn: sget(NOTES_KEY) !== '0', best: best,
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches),
      coarse: !!(mm && mm('(pointer: coarse)').matches),
      g: newGame((Math.random() * 4294967296) >>> 0), viewLevel: 0, tween: null,
      phase: 'ready', ball: null, draft: null, deck: [], draftNo: Math.floor(Math.random() * 40) + 7,
      feedT0: 0, crumpleT0: 0, heldSpin: 0, nextAt: 0, aim: 0, kb: false, charge: null, lastMeter: null,
      drag: null, trail: [], litter: [], binned: [], msg: null, msgQ: [], pop: 0, intro: true, decos: {},
      raf: 0, last: 0, idleT: 0, idleUntil: now + 30, animUntil: 0, paused: false, k: 1, t0: now
    };
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    S.draft = pickDraft();
    layout();
    readTheme();

    S.onKey = onKey; S.onKeyUp = onKeyUp;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKeyUp, true);
    S.onVis = function () { if (document.hidden) pause(); else poke(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { pause(); };
    window.addEventListener('blur', S.onBlur);
    S.onFocus = function () { poke(); };
    window.addEventListener('focus', S.onFocus);
    // Minimized to the dock: same as hiding the tab (a throw in flight waits on the
    // pause card; the idle tick stops); restore wakes the idle tick again.
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) pause(); });
    p.addEventListener('cade-panel-restore', function () { if (S && S.panel === p) poke(); });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S) { layout(); draw(1); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () { if (S) { readTheme(); draw(1); } });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    S.cv.addEventListener('pointerdown', onDown);
    S.cv.addEventListener('pointermove', onMove);
    S.cv.addEventListener('pointerup', onUp);
    S.cv.addEventListener('pointercancel', onUp);
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.ovl.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      resume();
    });
    S.bar.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      poke();
      if (b.dataset.act === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure();
        S.snd.tone(880, 0.07, 'sine', 0.04);
      } else if (b.dataset.act === 'notes') {
        S.notesOn = !S.notesOn;
        sset(NOTES_KEY, S.notesOn ? '1' : '0');
        if (S.phase === 'ready') { S.draft = pickDraft(); if (!S.raf) draw(1); }
        Cade.showToast && Cade.showToast(S.notesOn ? 'Drafts now include lines from this note' : 'Built-in drafts only', 'info', 1600);
      }
      syncBar();
      try { b.blur(); } catch (er) {}
    });
    syncBar();
    nextDraftInitial();
    draw(1);
    kick();
  }
  function nextDraftInitial() { S.phase = 'ready'; S.feedT0 = S.rm ? 0 : perfNow(); anim(perfNow() + 0.3); }

  Cade.registerWidget({
    name: 'Paper Toss',
    description: 'Flick crumpled drafts into the bin — mind the fan',
    icon: '🗑️',
    tags: 'game,arcade,fun,train,paper,toss,throw,trash,bin,crumple,draft,wind,flick',
    open: open,
    // Pure engine, exposed for headless checks (node) — not used by the app.
    _engine: {
      STEP: STEP, LEVELS: LEVELS, BALL_R: BALL_R, BIN_R: BIN_R, BIN_H: BIN_H, AIM_MAX: AIM_MAX, WIND_K: WIND_K,
      launchVel: launchVel, newBall: newBall, stepBall: stepBall, advance: advance, judge: judge, simulate: simulate,
      aimFor: aimFor, newGame: newGame, rollWind: rollWind, applyResult: applyResult, levelFor: levelFor,
      cleanLine: cleanLine, DRAFTS: DRAFTS
    }
  });
})();
