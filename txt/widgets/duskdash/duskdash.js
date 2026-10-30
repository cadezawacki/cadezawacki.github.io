/* Dusk Dash — race the sunset over rolling hills, for Cade.txt.
 * A dot slides over endless islands of smooth hills. Hold (anywhere on the
 * play field, the big pad button, Space / ↓ / S, a gamepad's A) to get heavy
 * and dive; let go to get light and fly. Dive into the downslopes, let go on
 * the upslopes and the crests fling you into the air; touch back down along a
 * downslope for a PERFECT slide (three in a row: FEVER). Every island crossed
 * buys more daylight — when the sun sets the run coasts to a stop.
 * Power-ups float over the crests: rocket, magnet, feather (low gravity),
 * x2 score, butter (every landing is perfect) and sun (more daylight).
 * Coins buy looks in the Wardrobe: the dot's glyph, its colour and its trail.
 * Drawn entirely in monospace glyphs (cached in a glyph atlas) on a canvas,
 * the hills as contour bands. Physics runs on a fixed 120 Hz step with an
 * accumulator and the terrain is analytic (cosine hills, C¹ smooth), so a
 * glide is the same at 60 or 120 Hz; rendering interpolates. The loop runs
 * only while a run is on screen; it pauses on blur, tab hide and minimize.
 * Progress persists in Cade.store (cade-dd-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World units: metres and seconds. x → right, y → up; valleys sit near y = 0.
  var STEP = 1 / 120;
  var G = 30;                          // gravity, let go (light)
  var HOLD_AIR = 3.4, HOLD_GND = 2.6;  // gravity multipliers while held (heavy: dive)
  var MIN_V = 9, PUSH = 16, CRAWL = 6, MAX_V = 150;  // the dot never stalls: a push below MIN_V, and it always crawls at CRAWL
  var LAUNCH_V = 8;                    // slower than this, a crest can't throw you
  var SUN0 = 50, DUSK_T = 6;           // seconds of daylight at the start; seconds to coast once it's dark
  var PERFECT_A = 0.36, BAD_A = 0.9;   // landing angle (velocity vs slope, rad): perfect / thud
  var PERFECT_KICK = 4, FEVER_N = 3, FEVER_T = 6, FEVER_A = 7;
  var REF_H = 288, VIEW_W = 384;       // logical px the camera zoom is defined for
  var R_COIN = 2.1, R_PW = 2.8, MAGNET_R = 20;
  var START_X = -18;

  // Temporary power-ups (seconds; 0 = instant).
  var POWERS = [
    { id: 'rocket', name: 'Rocket', ch: 'R', dur: 3.5, w: 3, info: 'a shove forward' },
    { id: 'magnet', name: 'Magnet', ch: 'M', dur: 9, w: 3, info: 'pulls coins in' },
    { id: 'feather', name: 'Feather', ch: 'F', dur: 7, w: 3, info: 'low gravity while you fly' },
    { id: 'x2', name: 'Double', ch: '2', dur: 10, w: 2, info: 'x2 score and coins' },
    { id: 'butter', name: 'Butter', ch: 'B', dur: 8, w: 2, info: 'every landing is perfect' },
    { id: 'sun', name: 'Sunbeam', ch: 'S', dur: 0, w: 2, info: '+6 s of daylight' }
  ];
  var PW = {};
  for (var pi0 = 0; pi0 < POWERS.length; pi0++) PW[POWERS[pi0].id] = POWERS[pi0];
  var SUNBEAM = 6;

  // The wardrobe. price: coins; or need: an achievement (rec key ≥ n) instead.
  var BODIES = [
    { id: 'dot', name: 'Dot', ch: 'o', price: 0 },
    { id: 'star', name: 'Star', ch: '*', price: 60 },
    { id: 'swirl', name: 'Swirl', ch: '@', price: 150 },
    { id: 'moon', name: 'Big O', ch: 'O', price: 250 },
    { id: 'knot', name: 'Knot', ch: '&', price: 400 },
    { id: 'block', name: 'Block', ch: '#', price: 600 },
    { id: 'pct', name: 'Odds', ch: '%', price: 900 },
    { id: 'comet', name: 'Comet', ch: 'Q', price: 1300 },
    { id: 'mystery', name: 'Mystery', ch: '?', need: 'island', n: 5, how: 'reach island 5' },
    { id: 'eight', name: 'Eight', ch: '8', need: 'chain', n: 8, how: '8 perfect slides in a row' }
  ];
  var COLORS = [
    { id: 'ink', name: 'Ink', price: 0 },
    { id: 'accent', name: 'Accent', price: 0 },
    { id: 'gold', name: 'Gold', price: 50 },
    { id: 'coral', name: 'Coral', price: 100 },
    { id: 'sky', name: 'Sky', price: 160 },
    { id: 'ember', name: 'Ember', price: 250 },
    { id: 'leaf', name: 'Leaf', price: 350 },
    { id: 'violet', name: 'Violet', price: 500 },
    { id: 'rainbow', name: 'Rainbow', price: 1500 }
  ];
  var TRAILS = [
    { id: 'none', name: 'None', s: '', price: 0 },
    { id: 'dots', name: 'Dots', s: '.', price: 0 },
    { id: 'dash', name: 'Dashes', s: '-', price: 40 },
    { id: 'wave', name: 'Waves', s: '~', price: 120 },
    { id: 'stars', name: 'Stars', s: '*+', price: 220 },
    { id: 'binary', name: 'Binary', s: '01', price: 400 },
    { id: 'comet', name: 'Comet', s: '=-', price: 600 },
    { id: 'sparkle', name: 'Sparkle', s: "*'.+", price: 800, multi: true }
  ];
  var WARDROBE = { body: BODIES, color: COLORS, trail: TRAILS };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // Small seeded PRNG (mulberry32) and an integer hash, so a run is reproducible.
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(a, b) {
    var h = Math.imul((a | 0) ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul((b | 0) + 0x632BE5AB, 0xC2B2AE35);
    h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
    return h >>> 0;
  }

  // ---- the world: islands of hills, generated ahead of the dot ----
  // Nodes alternate peak / valley; between two nodes the ground is a half
  // cosine, so the slope is continuous everywhere (zero at every node) and
  // slope and curvature are exact. Each island is a run of hills that grow
  // towards a big final one; the valley after it is the island's end.
  function newWorld(seed) {
    var w = { seed: seed >>> 0, xs: [-80, 0], ys: [24, 24], peak: true, isl: [], items: [], hill: 0, j: 0, r: rng(hash2(seed, 77)), gs: 0, gk: 0 };
    genIsland(w);
    genIsland(w);
    return w;
  }
  function segW(w, dh, i) {
    var r = w.r();
    return Math.max(1.25 * Math.abs(dh), 18 + 1.6 * Math.min(i, 12) + r * 26);
  }
  function genIsland(w) {
    var i = w.isl.length, n = 4 + Math.min(5, i), base = 11 + 4.2 * Math.min(i, 12), x0 = w.xs[w.xs.length - 1];
    for (var h = 0; h < n; h++) {
      var big = h === n - 1, vy = -2.5 + w.r() * 5;
      var A = Math.min(78, base * (0.6 + 0.75 * w.r()) * (big ? 1.5 : 1));
      if (w.peak) addNode(w, vy, i, false);
      addNode(w, w.ys[w.ys.length - 1] + A, i, big);
    }
    addNode(w, -2.5 + w.r() * 5, i, false);
    w.isl.push({ i: i, x0: x0, x1: w.xs[w.xs.length - 1] });
  }
  function addNode(w, y, isl, big) {
    var lx = w.xs[w.xs.length - 1], ly = w.ys[w.ys.length - 1], x = lx + segW(w, y - ly, isl) * (big ? 1.15 : 1);
    w.xs.push(x); w.ys.push(y);
    var wasPeak = w.peak;
    w.peak = !w.peak;
    if (wasPeak) hillItems(w, lx, ly, x, y, isl);     // a descent: dress the hill it comes off
  }
  // Coins along a descent or in an arc off its crest, and now and then a power-up.
  function hillItems(w, px, py, vx, vy, isl) {
    var hi = w.hill++, r = rng(hash2(w.seed ^ 0xC01, hi)), k, x, n, items = w.items;
    if (hi === 0) return;                               // the starting hill stays clear
    var roll = r();
    if (roll < 0.42) {                                  // coins hugging the downslope
      n = 5 + Math.floor(r() * 4);
      for (k = 0; k < n; k++) { x = px + (vx - px) * (0.18 + 0.64 * k / (n - 1)); items.push({ k: 'coin', x: x, y: groundY(w, x) + 1.6, hit: false }); }
    } else if (roll < 0.75) {                           // an arc in the air past the crest
      n = 6 + Math.floor(r() * 3);
      var lift = 4 + r() * 8, sp = 4 + r() * 2;
      for (k = 0; k < n; k++) {
        var u = k / (n - 1);
        items.push({ k: 'coin', x: px + 4 + k * sp, y: py + 3 + lift * 4 * u * (1 - u) + (1 - u) * 2, hit: false });
      }
    }
    if (hi > 2 && r() < 0.24 + Math.min(0.08, isl * 0.01)) {
      var tw = 0, pk, q;
      for (q = 0; q < POWERS.length; q++) tw += POWERS[q].w;
      pk = r() * tw;
      for (q = 0; q < POWERS.length - 1 && pk >= POWERS[q].w; q++) pk -= POWERS[q].w;
      items.push({ k: 'pw', p: POWERS[q].id, x: px + 10 + r() * 14, y: py + 7 + r() * 13, hit: false });
    }
  }
  function ensure(w, x) { while (w.xs[w.xs.length - 1] < x + 600) genIsland(w); }
  function seg(w, x) {
    var xs = w.xs, j = w.j, n = xs.length - 2;
    if (j > n || x < xs[j] || (j + 8 <= n && x >= xs[j + 8])) {   // a jump: binary search
      var lo = 0, hi = n;
      while (lo < hi) { var m = (lo + hi + 1) >> 1; if (xs[m] <= x) lo = m; else hi = m - 1; }
      j = lo;
    }
    while (j < n && x >= xs[j + 1]) j++;
    w.j = j;
    return j;
  }
  // Ground height at x; also leaves the slope in w.gs and y'' in w.gk.
  function groundY(w, x) {
    var xs = w.xs, ys = w.ys;
    if (x <= xs[0]) { w.gs = 0; w.gk = 0; return ys[0]; }
    var j = seg(w, x), x0 = xs[j], x1 = xs[j + 1], y0 = ys[j], dy = ys[j + 1] - y0, W = x1 - x0;
    if (x >= x1) { w.gs = 0; w.gk = 0; return ys[j + 1]; }
    var u = Math.PI * (x - x0) / W;
    w.gs = dy * Math.PI / (2 * W) * Math.sin(u);
    w.gk = dy * Math.PI * Math.PI / (2 * W * W) * Math.cos(u);
    return y0 + dy * (1 - Math.cos(u)) / 2;
  }
  function islandAt(w, x) {
    var L = w.isl;
    for (var i = 0; i < L.length; i++) if (x < L[i].x1) return i;
    return L.length - 1;
  }

  // ---- a run ----
  function newRun(seed, opts) {
    var w = newWorld(seed), y = groundY(w, START_X);
    var f = {
      seed: seed >>> 0, w: w, phase: 'run', x: START_X, y: y, vx: MIN_V, vy: 0, s: MIN_V, gnd: true, px: START_X, py: y,
      t: 0, sun: SUN0, duskT: 0, acc: 0, steps: 0, hold: false,
      air: 0, maxAir: 0, maxSpeed: 0, maxAlt: 0, score: 0, coins: 0, perfects: 0, chain: 0, bestChain: 0, fever: 0, fevers: 0,
      island: 0, islands: 0, pw: { rocket: 0, magnet: 0, feather: 0, x2: 0, butter: 0 }, pwGot: 0, lastPw: '', ii: 0,
      zoom: 1, pzoom: 1, cb: -14, pcb: -14, cbT: -14, events: [], hits: [], lastGain: 0, airScore: 0, sunGain: 0, dScore: 0
    };
    f.zoom = f.pzoom = camTarget(f);
    f.cb = f.pcb = f.cbT;
    if (opts && opts.sun) f.sun = opts.sun;
    return f;
  }
  function speedOf(f) { return f.gnd ? f.s : Math.sqrt(f.vx * f.vx + f.vy * f.vy); }
  function altOf(f) { return f.y - groundY(f.w, f.x); }
  function mult(f) { return (f.pw.x2 > 0 ? 2 : 1) * (f.fever > 0 ? 2 : 1); }
  function addScore(f, v) { v = Math.round(v * mult(f)); f.score += v; f.lastGain = v; return v; }

  // Camera: the zoom (px per metre for a REF_H-tall view) keeps the dot and
  // the valleys in frame — high flight zooms out. Smoothed here, in the fixed
  // step, so the renderer can interpolate it like any other state.
  function camTarget(f) {
    var gy = groundY(f.w, f.x), top = Math.max(f.y, gy) + 18, bot = Math.min(-14, gy - 12);
    f.cbT = bot;
    var H = clamp(Math.max(80 + speedOf(f) * 0.3, (top - bot) * 1.1), 80, 1200);
    return REF_H / H;
  }

  function land(f) {
    var w = f.w, gy = groundY(w, f.x), sl = w.gs, a = Math.atan(sl), ca = Math.cos(a), sa = Math.sin(a);
    var vt = f.vx * ca + f.vy * sa, diff = Math.abs(Math.atan2(f.vy, f.vx) - a), ev = f.events, air = f.air;
    f.y = gy; f.gnd = true;
    if (air > 0.35 && (diff < PERFECT_A || f.pw.butter > 0) && a < -0.1) {
      f.s = vt + PERFECT_KICK;
      f.perfects++; f.chain++;
      if (f.chain > f.bestChain) f.bestChain = f.chain;
      addScore(f, 25 * Math.min(f.chain, 10));
      ev.push('perfect');
      if (f.chain >= FEVER_N && f.chain % FEVER_N === 0) { f.fever = FEVER_T; f.fevers++; ev.push('fever'); }
    } else if (air > 0.25 && diff > BAD_A) {
      f.s = vt * 0.85; f.chain = 0; ev.push('thud');
    } else {
      f.s = vt;
      if (air > 0.25) ev.push('land');
    }
    if (air > 1.5) { f.airScore = addScore(f, 15 * air); ev.push('air'); }
    f.s = clamp(f.s, 3, MAX_V);
    f.vx = f.s * ca; f.vy = f.s * sa;
    f.air = 0;
  }

  // One fixed physics step. hold: heavy (dive) this step.
  function stepRun(f, hold) {
    if (f.phase === 'done') return;
    var w = f.w, dt = STEP, ev = f.events, pw = f.pw, k;
    hold = !!hold; f.hold = hold;
    f.px = f.x; f.py = f.y; f.pzoom = f.zoom; f.pcb = f.cb;
    f.steps++; f.t += dt;
    if (f.phase === 'run') {
      f.sun -= dt;
      if (f.sun <= 0) { f.sun = 0; f.phase = 'dusk'; f.duskT = 0; ev.push('night'); }
    } else f.duskT += dt;
    for (k in pw) if (pw[k] > 0) { pw[k] -= dt; if (pw[k] <= 0) { pw[k] = 0; ev.push('pwoff'); } }
    if (f.fever > 0) f.fever = Math.max(0, f.fever - dt);
    var dusk = f.phase === 'dusk';
    var gm = hold ? (f.gnd ? HOLD_GND : HOLD_AIR) : (pw.feather > 0 && !f.gnd ? 0.45 : 1), g = G * gm;
    var fwd = (pw.rocket > 0 ? 30 : 0) + (f.fever > 0 ? FEVER_A : 0);
    if (dusk) fwd = 0;
    if (f.gnd) {
      groundY(w, f.x);
      var a = Math.atan(w.gs), ca = Math.cos(a), sa = Math.sin(a);
      f.s += (-g * sa + fwd) * dt;
      if (dusk) f.s -= (0.6 * f.s + 3) * dt;                     // dark: the dot tires and rolls to a stop
      else if (f.s < MIN_V) f.s += PUSH * dt;
      f.s = clamp(f.s, dusk ? 0 : CRAWL, MAX_V);
      f.x += f.s * ca * dt;
      f.y = groundY(w, f.x);
      a = Math.atan(w.gs); ca = Math.cos(a); sa = Math.sin(a);
      f.vx = f.s * ca; f.vy = f.s * sa;
      // leave the ground when it curves away faster than the dot can follow:
      // the normal force g·cos a + s²·κ goes negative over a crest
      var kap = w.gk / Math.pow(1 + w.gs * w.gs, 1.5);
      if (f.s > LAUNCH_V && g * ca + f.s * f.s * kap < 0) { f.gnd = false; f.air = 0; ev.push('launch'); }
    } else {
      f.vy -= g * dt;
      if (fwd) { var V0 = Math.sqrt(f.vx * f.vx + f.vy * f.vy) || 1; f.vx += fwd * f.vx / V0 * dt; f.vy += fwd * Math.max(0.25, f.vy / V0) * dt; }
      if (f.vx < 3) f.vx = 3;
      var V = Math.sqrt(f.vx * f.vx + f.vy * f.vy);
      if (V > MAX_V) { f.vx *= MAX_V / V; f.vy *= MAX_V / V; }
      f.x += f.vx * dt; f.y += f.vy * dt;
      f.air += dt;
      if (f.air > f.maxAir) f.maxAir = f.air;
      if (f.y <= groundY(w, f.x)) land(f);
    }
    var sp = speedOf(f), alt = f.y - groundY(w, f.x);
    if (sp > f.maxSpeed) f.maxSpeed = sp;
    if (alt > f.maxAlt) f.maxAlt = alt;
    ensure(w, f.x);
    // islands: crossing one buys daylight
    var L = w.isl[f.island];
    if (L && f.x >= L.x1) {
      f.island++; f.islands++;
      if (!dusk) { f.sunGain = Math.max(4, 13 - f.island); f.sun += f.sunGain; }
      addScore(f, 150 * f.island);
      ev.push('island');
    }
    touchItems(f);
    // distance scores as you go
    var d = Math.floor(Math.max(0, f.x) / 2);
    if (d > f.dScore) { f.score += (d - f.dScore) * mult(f); f.dScore = d; }
    // camera
    var zt = camTarget(f), kz = 1 - Math.exp(-2.4 * dt);
    f.zoom += (zt - f.zoom) * kz; f.cb += (f.cbT - f.cb) * kz;
    if (dusk && ((f.gnd && f.s < 1.5) || f.duskT > DUSK_T)) { f.phase = 'done'; ev.push('done'); }
  }

  function touchItems(f) {
    var items = f.w.items, pw = f.pw, i, it, dx, dy;
    while (f.ii < items.length && items[f.ii].x < f.x - 40) f.ii++;
    for (i = f.ii; i < items.length; i++) {
      it = items[i];
      if (it.x > f.x + 45) { if (it.x > f.x + 80) break; continue; }
      if (it.hit) continue;
      dx = it.x - f.x; dy = it.y - f.y;
      var d2 = dx * dx + dy * dy;
      if (it.k === 'coin') {
        if (pw.magnet > 0 && d2 < MAGNET_R * MAGNET_R) {            // drift towards the dot
          var d = Math.sqrt(d2) || 1, pull = Math.min(d, (25 + speedOf(f)) * STEP);
          it.x -= dx / d * pull; it.y -= dy / d * pull;
          dx = it.x - f.x; dy = it.y - f.y; d2 = dx * dx + dy * dy;
        }
        if (d2 < R_COIN * R_COIN) {
          it.hit = true; f.coins += pw.x2 > 0 ? 2 : 1;
          addScore(f, 10); f.hits.push(it); f.events.push('coin');
        }
      } else if (d2 < R_PW * R_PW) {
        it.hit = true; f.pwGot++; f.lastPw = it.p; f.hits.push(it);
        if (it.p === 'sun') { if (f.phase === 'run') f.sun += SUNBEAM; }
        else pw[it.p] = PW[it.p].dur;
        addScore(f, 50);
        f.events.push('pw');
      }
    }
  }

  // Advance real time dt with a fixed step; returns the render interpolation alpha.
  function advance(f, dt, hold) {
    f.acc = Math.min(f.acc + dt, 0.25);
    while (f.acc >= STEP && f.phase !== 'done') { stepRun(f, hold); f.acc -= STEP; }
    return f.phase === 'done' ? 1 : f.acc / STEP;
  }
  function summary(f) {
    return { score: f.score, dist: Math.max(0, f.x), coins: f.coins, islands: f.islands, perfects: f.perfects, chain: f.bestChain,
      air: f.maxAir, speed: f.maxSpeed, alt: f.maxAlt, fevers: f.fevers, powers: f.pwGot, time: f.t };
  }
  // Headless run with a pilot function (f) → hold; for tests.
  function simulate(seed, pilot, maxT) {
    var f = newRun(seed), n = Math.ceil((maxT || 400) / STEP);
    for (var i = 0; i < n && f.phase !== 'done'; i++) { stepRun(f, pilot ? pilot(f) : false); f.events.length = 0; f.hits.length = 0; }
    return f;
  }

  // ---- the save: wallet, records, the wardrobe ----
  function newSave() {
    return { v: 1, wallet: 0, seed: 1, runs: 0, total: 0,
      rec: { score: 0, dist: 0, island: 0, chain: 0, air: 0, coins: 0 },
      own: { body: ['dot'], color: ['ink', 'accent'], trail: ['none', 'dots'] },
      sel: { body: 'dot', color: 'accent', trail: 'dots' } };
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    s.wallet = Math.max(0, +o.wallet || 0); s.seed = (+o.seed >>> 0) || 1; s.runs = Math.max(0, +o.runs | 0); s.total = Math.max(0, +o.total || 0);
    if (o.rec) for (var k in s.rec) s.rec[k] = Math.max(0, +o.rec[k] || 0);
    ['body', 'color', 'trail'].forEach(function (cat) {
      if (o.own && Array.isArray(o.own[cat])) o.own[cat].forEach(function (id) { if (itemOf(cat, id) && s.own[cat].indexOf(id) < 0) s.own[cat].push(id); });
      if (o.sel && owns(s, cat, o.sel[cat])) s.sel[cat] = o.sel[cat];
    });
    return s;
  }
  function itemOf(cat, id) {
    var L = WARDROBE[cat];
    if (!L) return null;
    for (var i = 0; i < L.length; i++) if (L[i].id === id) return L[i];
    return null;
  }
  function owns(save, cat, id) { return !!itemOf(cat, id) && save.own[cat].indexOf(id) >= 0; }
  function canBuy(save, cat, id) {
    var it = itemOf(cat, id);
    return !!it && !it.need && !owns(save, cat, id) && save.wallet >= it.price;
  }
  function buy(save, cat, id) {
    if (!canBuy(save, cat, id)) return false;
    save.wallet -= itemOf(cat, id).price;
    save.own[cat].push(id); save.sel[cat] = id;
    return true;
  }
  function wear(save, cat, id) { if (!owns(save, cat, id)) return false; save.sel[cat] = id; return true; }
  // Fold a finished run into the save; returns the results card's data.
  function settle(save, res) {
    var rec = save.rec, nb = {}, unlocked = [];
    save.runs++; save.wallet += res.coins; save.total += res.coins;
    var map = { score: res.score, dist: res.dist, island: res.islands + 1, chain: res.chain, air: res.air, coins: res.coins };
    for (var k in map) if (map[k] > rec[k]) { if (rec[k] > 0 || k === 'score') nb[k] = true; rec[k] = map[k]; }
    ['body', 'color', 'trail'].forEach(function (cat) {
      WARDROBE[cat].forEach(function (it) {
        if (it.need && rec[it.need] >= it.n && save.own[cat].indexOf(it.id) < 0) { save.own[cat].push(it.id); unlocked.push(it); }
      });
    });
    return { best: nb, unlocked: unlocked, wallet: save.wallet };
  }
  function runSeed(save) { return hash2(save.seed, save.runs + 1) || 1; }

  var ENGINE = {
    STEP: STEP, G: G, HOLD_AIR: HOLD_AIR, HOLD_GND: HOLD_GND, MIN_V: MIN_V, MAX_V: MAX_V, SUN0: SUN0, REF_H: REF_H, VIEW_W: VIEW_W,
    POWERS: POWERS, BODIES: BODIES, COLORS: COLORS, TRAILS: TRAILS, FEVER_N: FEVER_N, SUNBEAM: SUNBEAM,
    rng: rng, hash2: hash2, newWorld: newWorld, groundY: groundY, ensure: ensure, islandAt: islandAt,
    newRun: newRun, stepRun: stepRun, land: land, advance: advance, summary: summary, simulate: simulate,
    speedOf: speedOf, altOf: altOf, mult: mult, touchItems: touchItems,
    newSave: newSave, normSave: normSave, itemOf: itemOf, owns: owns, canBuy: canBuy, buy: buy, wear: wear, settle: settle, runSeed: runSeed
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('duskdash.css');

  var PANEL_ID = 'duskdash-panel', NAME = 'Dusk Dash';
  var KEY = 'cade-dd-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var VW = VIEW_W, CW = 8, RH = 12;
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.duskdash = { live: function () { return S; } };   // test-only peek

  // palette slots, filled from the theme (readTheme); the last NHUE are the islands' surface lines
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOLD = 4, C_RED = 5, C_ICE = 6, C_FLAME = 7, C_LEAF = 8, C_VIOLET = 9,
    C_CLOUD = 10, C_STAR = 11, C_SUN = 12, C_RIDGE = 13, C_LINE = 14, NHUE = 6, NPAL = C_LINE + NHUE;
  var RAINBOW = [C_GOLD, C_FLAME, C_RED, C_VIOLET, C_ICE, C_ACC, C_LEAF];
  var COLOR_SLOT = { ink: C_TEXT, accent: C_ACC, gold: C_GOLD, coral: C_RED, sky: C_ICE, ember: C_FLAME, leaf: C_LEAF, violet: C_VIOLET, rainbow: -1 };
  var PW_SLOT = { rocket: C_FLAME, magnet: C_RED, feather: C_ICE, x2: C_GOLD, butter: C_LEAF, sun: C_SUN };

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }

  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function fmtInt(n) {
    n = Math.round(n);
    var s = String(Math.abs(n)), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }
  function fmtDist(m) {
    if (m < 1000) return Math.round(m) + ' m';
    var k = m / 1000;
    return (k >= 10 ? k.toFixed(1) : k.toFixed(2)).replace(/\.?0+$/, '') + ' km';
  }

  // ---- sound: a tiny WebAudio voice, created on a user gesture (iOS), closed with the panel ----
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
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');

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
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.55)), fa = parseCol(v('--text-faint'), mix(bg, tx, 0.35));
    var P = S.pal;
    S.dark = dark;
    P[C_TEXT] = css(tx); P[C_MUTED] = css(mu); P[C_FAINT] = css(fa); P[C_ACC] = css(ac);
    P[C_GOLD] = dark ? '#f2c544' : '#b07d06'; P[C_RED] = dark ? '#f06a6a' : '#cf3f3f';
    P[C_ICE] = dark ? '#7cc7f2' : '#2878b5'; P[C_FLAME] = dark ? '#ff8f3f' : '#e2611f';
    P[C_LEAF] = dark ? '#7ed37a' : '#2f8f3a'; P[C_VIOLET] = dark ? '#b79cf5' : '#7351c4';
    P[C_CLOUD] = css(mix(bg, tx, dark ? 0.24 : 0.2)); P[C_STAR] = css(mix(bg, tx, dark ? 0.42 : 0.3));
    P[C_SUN] = dark ? '#ffb347' : '#de8a12'; P[C_RIDGE] = css(mix(bg, ac, dark ? 0.24 : 0.2));
    // the islands: each a hue, as two contour bands and a surface line
    var hues = [ac, parseCol(P[C_LEAF]), parseCol(P[C_GOLD]), parseCol(P[C_RED]), parseCol(P[C_ICE]), parseCol(P[C_VIOLET])];
    S.hue = hues.map(function (h, i) {
      P[C_LINE + i] = css(mix(bg, h, dark ? 0.85 : 0.9));
      return { a: css(mix(bg, h, dark ? 0.3 : 0.26)), b: css(mix(bg, h, dark ? 0.2 : 0.16)) };
    });
    S.col = { bg: css(bg), hud: css(bg, 0.8), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace' };
    fitFont();
  }

  // ---- glyph rendering ----
  // Everything is drawn as monospace glyphs on a CW × RH cell grid. Each
  // (colour, character) pair is rendered once into an atlas canvas at device
  // resolution and stamped with drawImage — far cheaper than fillText per glyph
  // on iOS. The font size is fitted to the font's real advance.
  var AT_COLS = 24, AT_ROWS = 18;
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '600 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = CW / adv;
    S.fnt = '600 ' + S.fpx.toFixed(3) + 'px ' + f;
    buildAtlas();
    buildClouds();
  }
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.k || !S.col) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    // big enough cells for glyphs drawn at up to 2x (the dot)
    a.sc = 2;
    a.cwp = Math.ceil((CW + 6) * S.k * a.sc); a.chp = Math.ceil((RH + 8) * S.k * a.sc);
    a.cv.width = a.cwp * AT_COLS; a.cv.height = a.chp * AT_ROWS;
    a.c = a.cv.getContext('2d');
    a.c.font = '600 ' + (S.fpx * S.k * a.sc).toFixed(3) + 'px ' + S.col.font;
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
  // One glyph centred on (x, y) in logical units, snapped to the device pixel grid unless `nosnap`; `sc` scales it.
  function glyph(c, ci, code, x, y, nosnap, sc) {
    if (code === 32) return;
    var i = gIdx(ci, code), a = S.atl;
    if (i < 0) {                       // non-ASCII or a full atlas: plain text (rare)
      c.font = S.fnt; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = S.pal[ci];
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
  // Numbers without building strings: digits go into a reused buffer.
  var NB = new Uint8Array(24);
  function writeNum(v, dec, comma) {
    var neg = v < 0, n = 0, i;
    if (neg) v = -v;
    var sc = dec === 1 ? 10 : 1, iv = Math.round(v * sc), ip = Math.floor(iv / sc), fp = iv - ip * sc;
    for (i = 0; i < (dec || 0); i++) { NB[n++] = 48 + fp % 10; fp = Math.floor(fp / 10); }
    if (dec) NB[n++] = 46;
    var cnt = 0;
    do { if (comma && cnt && cnt % 3 === 0) NB[n++] = 44; NB[n++] = 48 + ip % 10; ip = Math.floor(ip / 10); cnt++; } while (ip > 0 && n < 20);
    if (neg) NB[n++] = 45;
    for (var a = 0, b = n - 1; a < b; a++, b--) { var t = NB[a]; NB[a] = NB[b]; NB[b] = t; }
    return n;
  }
  function drawNum(c, ci, n, x, y, align, sc) {
    var cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, NB[i], x0 + i * cw + cw / 2, y, false, sc);
    return x0 + n * cw;
  }

  // Cloud tiles: pre-rendered once per theme / size.
  var CLOUD_SHAPES = [
    ['    .--~~--.', ' .-(        )-.', '(______________)'],
    ['  .--.', '.(    )-.', '(________)'],
    ['   _.~~._', ' .(      ).', '(___________)']
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

  // A distant ASCII range (as in Learn to Fly): a seeded walk of / \ and _, cyclic.
  function range(seed, maxH, n) {
    var r = rng(seed), out = [], L = 0, up = true;
    for (var i = 0; i < n; i++) {
      if (L === 0 && !up && r() < 0.45) { out.push([95, 0]); up = true; continue; }
      if (L >= maxH || (L > 0 && r() < (up ? 0.2 : 0.08))) up = false;
      else if (L === 0 || r() < (up ? 0.04 : 0.14)) up = true;
      if (up) { L++; out.push([47, L]); } else { out.push([92, L]); L--; }
    }
    while (L > 0) { out.push([92, L]); L--; }
    return out;
  }
  var FAR = range(23, 5, 300);
  var CLOUD_P = 1500, CLOUDS = (function () {
    var r = rng(9), a = [];
    for (var i = 0; i < 26; i++) a.push({ u: r() * CLOUD_P, v: r() * 150, s: Math.floor(r() * 3) });
    return a;
  })();
  var STARS = (function () {
    var r = rng(13), a = [];
    for (var i = 0; i < 40; i++) a.push({ x: r() * 640, y: r() * 420, c: r() < 0.12 ? 43 : r() < 0.2 ? 42 : 46 });
    return a;
  })();

  // ---- particles (world space) and score pop-ups; pools allocated once ----
  var NPART = 64, NPOP = 8, NTRAIL = 34;
  function makeFx() {
    S.parts = [];
    for (var i = 0; i < NPART; i++) S.parts.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, code: 46, ci: 0, g: 0 });
    S.pops = [];
    for (i = 0; i < NPOP; i++) S.pops.push({ on: false, x: 0, y: 0, t: 0, v: 0, ci: C_GOLD });
    S.trail = new Float32Array(NTRAIL * 2); S.tn = 0; S.th = 0; S.tT = 0;
    S.pi = 0; S.qi = 0;
  }
  function clearFx() {
    for (var i = 0; i < NPART; i++) S.parts[i].on = false;
    for (i = 0; i < NPOP; i++) S.pops[i].on = false;
    S.tn = 0;
  }
  function spark(x, y, vx, vy, life, code, ci, g) {
    var p = S.parts[S.pi]; S.pi = (S.pi + 1) % NPART;
    p.on = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.t = 0; p.life = life; p.code = code; p.ci = ci; p.g = g || 0;
  }
  function burst(x, y, n, sp, codes, ci, g, life) {
    if (S.rm) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = sp * (0.35 + Math.random() * 0.65);
      spark(x, y, Math.cos(a) * v, Math.abs(Math.sin(a)) * v * 0.9, life * (0.6 + Math.random() * 0.5), codes.charCodeAt(i % codes.length), ci < 0 ? RAINBOW[i % RAINBOW.length] : ci, g);
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
    for (i = 0; i < NPOP; i++) { p = S.pops[i]; if (p.on && (p.t += dt) > 1.1) p.on = false; }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt);
    if (S.flash > 0) S.flash = Math.max(0, S.flash - dt);
    if (S.msg && (S.msg.t += dt) > S.msg.dur) S.msg = S.msgQ.length ? S.msgQ.shift() : null;
  }
  function say(text, ci, dur, queue) {
    var m = { text: text, ci: ci == null ? C_TEXT : ci, t: 0, dur: dur || 1.2 };
    if (queue && S.msg && S.msgQ.length < 3) S.msgQ.push(m); else { S.msg = m; S.msgQ.length = 0; }
  }
  // The trail: where the dot has been, sampled in world space.
  function pushTrail(x, y) {
    var T = S.trail;
    T[S.th * 2] = x; T[S.th * 2 + 1] = y;
    S.th = (S.th + 1) % NTRAIL;
    if (S.tn < NTRAIL) S.tn++;
  }

  // ---- the look the save is wearing ----
  function bodyCode() { var b = itemOf('body', S.save.sel.body) || BODIES[0]; return b.ch.charCodeAt(0); }
  function bodySlot(t) {
    var s = COLOR_SLOT[S.save.sel.color];
    if (s == null) s = C_ACC;
    if (s < 0 || (S.f && S.f.fever > 0)) s = RAINBOW[((t * 10) | 0) % RAINBOW.length];
    return s;
  }

  // ---- the scene ----
  // Camera: the engine's zoom and bottom edge (interpolated); the dot sits 30% from the left.
  function view(f, a) {
    var v = S.v, VH = S.VH;
    v.x = f.px + (f.x - f.px) * a; v.y = f.py + (f.y - f.py) * a;
    // a tall (portrait) view zooms in a little and spends half its spare height on ground
    var zf = Math.pow(Math.max(1, VH / REF_H), 0.35);
    v.z = (f.pzoom + (f.zoom - f.pzoom) * a) * zf;
    v.bottom = f.pcb + (f.cb - f.pcb) * a - (VH - REF_H * zf) * 0.5 / v.z;
    v.left = v.x - 0.3 * VW / v.z;
    var top = VH - (v.y - v.bottom) * v.z;
    if (top < 52) v.bottom = v.y - (VH - 52) / v.z;   // a rocket outran the camera: keep the dot under the HUD
    return v;
  }
  function X(v, wx) { return (wx - v.left) * v.z; }
  function Y(v, wy) { return S.VH - (wy - v.bottom) * v.z; }

  function draw(alpha, dt) {
    if (!S || !S.ctx || !S.atl) return;
    var f = S.f || S.hf, c = S.ctx, VH = S.VH, v = view(f, alpha), i, n;
    var t = S.f ? f.t : S.idleT;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (S.shake > 0 && !S.rm) {
      var sh = S.shake * 8;
      c.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
    }
    c.fillStyle = S.col.bg; c.fillRect(-10, -10, VW + 20, VH + 20);
    // the sky follows the sun: warm as it sinks, dark once it's gone
    var day = clamp(f.sun / SUN0, 0, 1), night = f.phase === 'run' ? 0 : clamp(f.duskT / 1.2 + 0.3, 0, 1);
    var warm = clamp(1 - day / 0.5, 0, 1) * (1 - night);
    if (warm > 0) { c.fillStyle = 'rgba(255,128,48,' + (warm * (S.dark ? 0.12 : 0.14)).toFixed(3) + ')'; c.fillRect(-10, -10, VW + 20, VH + 20); }
    if (night > 0) { c.fillStyle = 'rgba(12,16,44,' + (night * (S.dark ? 0.35 : 0.3)).toFixed(3) + ')'; c.fillRect(-10, -10, VW + 20, VH + 20); }
    // parallax offsets are render state: they follow the camera's on-screen motion
    var dl = 0;
    if (S.lastLeft !== null && dt > 0) {
      dl = (v.left - S.lastLeft) * v.z;
      if (dl > -400 && dl < 400) { S.cloudOff += dl * 0.3; S.farOff += dl * 0.1; } else dl = 0;
    }
    S.lastLeft = v.left;
    var hz = Math.min(VH - RH * 2, Y(v, 4));          // the horizon: about valley level
    if (S.dark || night > 0.3) {
      c.globalAlpha = S.dark ? 1 : night;
      for (i = 0; i < STARS.length; i++) {
        var st = STARS[i], sx = ((st.x - S.farOff * 0.3) % 640 + 640) % 640 - 100, sy = st.y * (hz / 420);
        if (sx > -4 && sx < VW + 4 && sy < hz - RH * 3 && sy > 36) glyph(c, C_STAR, st.c, sx, sy, false, st.c === 46 ? 1 : 0.75);
      }
      c.globalAlpha = 1;
    }
    drawSun(c, day, night, hz);
    for (i = 0; i < CLOUDS.length; i++) {
      var cl = CLOUDS[i], tl = S.cloudT[cl.s], cx = ((cl.u - S.cloudOff) % CLOUD_P + CLOUD_P) % CLOUD_P - 160;
      var cyy = 44 + cl.v * Math.max(30, Math.min(hz, VH * 0.5) - 90) / 150;   // the upper sky only
      if (cx < VW && cx + tl.w > 0 && cyy + tl.h < hz) c.drawImage(tl.cv, cx, cyy, tl.w, tl.h);
    }
    ridge(c, FAR, S.farOff, hz);

    drawTerrain(c, v);
    drawFlags(c, v, f);
    drawItems(c, v, f, t);

    // the trail, oldest first
    var tr = itemOf('trail', S.save.sel.trail) || TRAILS[0];
    if (tr.s && S.tn > 1 && S.f) {
      var T = S.trail, slot = bodySlot(t);
      for (i = S.tn - 1; i >= 1; i--) {
        var q = (S.th - 1 - i + NTRAIL * 2) % NTRAIL, fr = 1 - i / S.tn;
        var tx = X(v, T[q * 2]), ty = Y(v, T[q * 2 + 1]);
        if (tx < -CW || tx > VW + CW) continue;
        c.globalAlpha = fr * 0.85;
        var tc = tr.multi ? RAINBOW[(q + ((t * 8) | 0)) % RAINBOW.length] : slot;
        glyph(c, tc, tr.s.charCodeAt((q + S.tseq) % tr.s.length), tx, ty, true, 0.7 + fr * 0.45);
      }
      c.globalAlpha = 1;
    }
    // particles + pop-ups
    for (i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on) continue;
      var px = X(v, p.x), py = Y(v, p.y);
      if (px < -CW || px > VW + CW || py < -RH || py > VH + RH) continue;
      c.globalAlpha = Math.min(1, 2.5 * (1 - p.t / p.life));
      glyph(c, p.ci, p.code, px, py);
    }
    c.globalAlpha = 1;
    for (i = 0; i < NPOP; i++) {
      var pp = S.pops[i];
      if (!pp.on) continue;
      c.globalAlpha = Math.min(1, 3 * (1.1 - pp.t));
      n = writeNum(pp.v, 0, true);
      var qx = X(v, pp.x), qy = Y(v, pp.y) - RH * 1.6 - pp.t * 24;
      glyph(c, pp.ci, 43, qx - (n + 1) * CW / 2, qy);
      drawNum(c, pp.ci, n, qx + CW / 2, qy, 'center');
    }
    c.globalAlpha = 1;
    drawDot(c, f, v, t, dt);

    if (S.f && S.phase === 'run') hud(c, f);
    if (S.msg && S.phase === 'run') banner(c, S.msg.text, RH * 5.2, S.msg.ci);
    if (S.flash > 0 && !S.rm) {
      c.fillStyle = 'rgba(255,255,255,' + (S.flash * 1.4).toFixed(3) + ')';
      c.fillRect(-10, -10, VW + 20, VH + 20);
    }
  }

  // The sun sinks to the horizon as the daylight runs out; then the moon.
  function drawSun(c, day, night, hz) {
    var x = VW * 0.88, top = 60, y = hz - RH * 1.2 - (hz - RH * 1.2 - top) * Math.sqrt(day);
    if (night > 0) {
      c.globalAlpha = night;
      drawStr(c, C_STAR, '_.', VW * 0.18, 66, 'center');
      drawStr(c, C_STAR, '( (', VW * 0.18 + 2, 66 + RH, 'center');
      drawStr(c, C_STAR, "'-'", VW * 0.18, 66 + RH * 2, 'center');
      c.globalAlpha = 1;
      return;
    }
    if (y > hz) return;
    var flick = ((S.idleT * 2) | 0) % 2;
    drawStr(c, C_SUN, flick ? '\\ | /' : '. | .', x, y - RH, 'center');
    drawStr(c, C_SUN, '-( )-', x, y, 'center');
    drawStr(c, C_SUN, flick ? '/ | \\' : "' | '", x, y + RH, 'center');
    glyph(c, C_SUN, 79, x, y);
  }
  function ridge(c, cols, off, base) {
    var i0 = Math.floor(off / CW), sx = -(off - i0 * CW), N = cols.length, nn = VW / CW + 2;
    for (var j = 0; j < nn; j++) {
      var g = cols[((i0 + j) % N + N) % N];
      glyph(c, C_RIDGE, g[0], sx + j * CW + CW / 2, base - g[1] * RH * 0.75 + (g[0] === 95 ? -RH * 0.45 : 0));
    }
  }

  // Hills: contour bands that follow the surface down (two shades of the
  // island's hue), a surface line in glyphs chosen by the on-screen slope.
  var COLW = 4;
  function drawTerrain(c, v) {
    var w = (S.f || S.hf).w, z = v.z, VH = S.VH, n = Math.ceil(VW / COLW) + 3, TX = S.tx, TY = S.ty, TI = S.ti, j, b;
    var minY = 1e9;
    for (j = 0; j < n; j++) {
      var sx = (j - 1) * COLW, wx = v.left + sx / z;
      TX[j] = sx; TY[j] = Y(v, groundY(w, wx)); TI[j] = islandAt(w, wx);
      if (TY[j] < minY) minY = TY[j];
    }
    var bh = Math.max(9, 4.5 * z), nb = Math.min(40, Math.ceil((VH - minY) / bh) + 1);
    // one island at a time (the colours change at the boundary valley)
    var j0 = 0;
    while (j0 < n) {
      var j1 = j0, isl = TI[j0];
      while (j1 < n - 1 && TI[j1 + 1] === isl) j1++;
      var hue = S.hue[isl % NHUE], xa = TX[j0], xb = j1 < n - 1 ? TX[j1 + 1] : TX[j1] + COLW;
      for (b = 0; b < nb; b++) {
        var off = b * bh;
        c.fillStyle = b % 2 ? hue.b : hue.a;
        c.beginPath();
        c.moveTo(xa, VH + 4);
        for (j = j0; j <= j1; j++) c.lineTo(TX[j], TY[j] + off);
        if (j1 < n - 1) c.lineTo(xb, TY[j1 + 1] + off);
        c.lineTo(xb, VH + 4);
        c.closePath();
        c.fill();
      }
      j0 = j1 + 1;
    }
    // the surface line: one glyph per text column
    var k0 = Math.floor(v.left * z / CW);
    for (var k = 0; k < Math.ceil(VW / CW) + 2; k++) {
      var gx = (k0 + k) * CW + CW / 2 - v.left * z, gw = v.left + gx / z;
      var y = Y(v, groundY(w, gw)), sl = -w.gs;            // on-screen slope = world slope (both axes scale by z)
      if (y > VH + RH || y < -RH) continue;
      var ch = sl > 1.6 || sl < -1.6 ? 124 : sl < -0.45 ? 47 : sl > 0.45 ? 92 : 95;
      glyph(c, C_LINE + islandAt(w, gw) % NHUE, ch, gx, ch === 95 ? y - RH * 0.42 : y - RH * 0.08);
    }
  }

  // A flag on each island's last crest, and the island's number at its end.
  function drawFlags(c, v, f) {
    var w = f.w, L = w.isl;
    for (var i = 0; i < L.length; i++) {
      var x = X(v, L[i].x1);
      if (x < -CW * 4 || x > VW + CW * 4) continue;
      var y = Y(v, groundY(w, L[i].x1));
      glyph(c, C_MUTED, 124, x, y - RH * 0.9);
      glyph(c, C_MUTED, 124, x, y - RH * 1.9);
      drawStr(c, i + 1 <= f.island && S.f ? C_FAINT : C_RED, '|>', x + CW * 0.5, y - RH * 2.6, 'left');
      var n = writeNum(i + 2, 0);
      drawNum(c, C_TEXT, n, x, y - RH * 3.7, 'center', 0.85);
    }
  }

  function drawItems(c, v, f, t) {
    var items = f.w.items, VH = S.VH, x0 = v.left - 10, x1 = v.left + VW / v.z + 10;
    for (var i = S.f ? f.ii : 0; i < items.length; i++) {
      var it = items[i];
      if (it.x > x1 + 40) break;
      if (it.hit || it.x < x0 || it.x > x1) continue;
      var sx = X(v, it.x), sy = Y(v, it.y);
      if (sy < -RH * 2 || sy > VH + RH * 2) continue;
      if (it.k === 'coin') glyph(c, C_GOLD, ((t * 5 + it.x * 0.1) | 0) % 5 === 0 ? 83 : 36, sx, sy);
      else {
        var ci = PW_SLOT[it.p], bob = Math.sin(t * 3 + it.x) * 2.5, pul = ((t * 4) | 0) % 2;
        glyph(c, ci, 91, sx - CW * 1.1, sy + bob);
        glyph(c, ci, PW[it.p].ch.charCodeAt(0), sx, sy + bob, false, 1.15);
        glyph(c, ci, 93, sx + CW * 1.1, sy + bob);
        if (pul) { glyph(c, ci, 39, sx - CW * 1.6, sy + bob - RH * 0.7, false, 0.8); glyph(c, ci, 46, sx + CW * 1.6, sy + bob + RH * 0.6, false, 0.8); }
      }
    }
  }

  // The dot: one glyph, a little heavier (bigger) while held, sitting on the
  // surface along its normal. Glows (a halo of dots) while a power-up runs.
  function drawDot(c, f, v, t, dt) {
    var w = f.w, x = X(v, v.x), y = Y(v, v.y), want = f.hold ? 1.95 : 1.6;
    S.dsc += (want - S.dsc) * Math.min(1, (dt || 0) * 14);
    var r = S.dsc * RH * 0.32;
    if (f.gnd) { groundY(w, v.x); var a = Math.atan(w.gs); x -= Math.sin(a) * r; y -= Math.cos(a) * r; }
    else y -= r;
    S.dotX = x; S.dotY = y;
    var p = f.pw, glow = p.rocket || p.magnet || p.feather || p.x2 || p.butter;
    if (glow && S.f) {
      var gc = p.rocket ? C_FLAME : p.magnet ? C_RED : p.butter ? C_LEAF : p.x2 ? C_GOLD : C_ICE;
      for (var q = 0; q < 6; q++) {
        var an = t * 3 + q * Math.PI / 3, rr = r + 7;
        c.globalAlpha = 0.65;
        glyph(c, gc, 46, x + Math.cos(an) * rr, y + Math.sin(an) * rr * 0.9, true);
      }
      c.globalAlpha = 1;
      if (p.rocket) { var fl = (t * 30) | 0; drawStr(c, C_FLAME, fl % 2 ? '=-' : '~=', x - r - CW * 0.6, y, 'right', true); }
    }
    glyph(c, bodySlot(t), bodyCode(), x, y, true, S.dsc);
  }

  function banner(c, s, y, ci) {
    var w = (s.length + 4) * CW;
    c.fillStyle = S.col.bg; c.fillRect(VW / 2 - w / 2, y - RH * 0.8, w, RH * 1.6);
    glyph(c, ci, 91, VW / 2 - w / 2 + CW * 0.5, y);
    glyph(c, ci, 93, VW / 2 + w / 2 - CW * 0.5, y);
    drawStr(c, ci, s, VW / 2, y, 'center');
  }

  function hud(c, f) {
    var yl = 6, yv = 17, y2 = 30, n, x, L = 0.72;
    c.fillStyle = S.col.hud; c.fillRect(0, 0, VW, 37);
    drawStr(c, C_MUTED, 'SCORE', 6, yl, 'left', false, L);
    drawStr(c, C_MUTED, 'DIST', 112, yl, 'left', false, L);
    drawStr(c, C_MUTED, 'COINS', 196, yl, 'left', false, L);
    drawStr(c, C_MUTED, f.phase === 'run' ? 'SUN' : 'NIGHT', 262, yl, 'left', false, L);
    n = writeNum(f.score, 0, true); drawNum(c, f.fever > 0 ? RAINBOW[((f.t * 10) | 0) % 7] : C_TEXT, n, 6, yv);
    n = writeNum(Math.max(0, f.x), 0, true); x = drawNum(c, C_TEXT, n, 112, yv); glyph(c, C_MUTED, 109, x + 4, yv + 1, false, 0.85);
    n = writeNum(f.coins, 0); glyph(c, C_GOLD, 36, 200, yv); drawNum(c, C_TEXT, n, 208, yv);
    // the sun: a bar of daylight; red when it's nearly gone
    var cells = 12, fr = clamp(f.sun / SUN0, 0, 1.5), on = Math.ceil(Math.min(1, fr) * cells - 0.001), low = f.sun < 8 && f.phase === 'run';
    x = 262;
    for (var i = 0; i < cells; i++) glyph(c, i < on ? (low && ((f.t * 4) | 0) % 2 ? C_RED : C_SUN) : C_FAINT, i < on ? 35 : 45, x + i * CW * 0.8 + CW * 0.4, yv, false, 0.8);
    if (fr > 1) glyph(c, C_SUN, 43, x + cells * CW * 0.8 + 4, yv, false, 0.8);
    // the second row: the island, power-ups running, then the streak
    x = drawStr(c, C_MUTED, 'ISLAND ', 6, y2, 'left', false, L);
    n = writeNum(f.island + 1, 0); x = drawNum(c, C_TEXT, n, x, y2, 'left', L) + CW * 1.5;
    for (var k = 0; k < POWERS.length; k++) {
      var id = POWERS[k].id, tl = f.pw[id];
      if (!tl) continue;
      x = drawStr(c, PW_SLOT[id], POWERS[k].name.toUpperCase(), x, y2, 'left', false, L) + 3;
      n = writeNum(tl, 1); x = drawNum(c, C_MUTED, n, x, y2, 'left', L) + CW * 1.2;
    }
    if (f.fever > 0) drawStr(c, RAINBOW[((f.t * 12) | 0) % 7], 'FEVER x2', VW - 6, y2, 'right', false, L);
    else if (f.chain > 0) {
      n = writeNum(f.chain, 0);
      drawNum(c, C_ACC, n, VW - 6, y2, 'right', L);
      drawStr(c, C_MUTED, 'STREAK x', VW - 6 - n * CW * L, y2, 'right', false, L);
    }
  }

  // ---- loop: runs only while a run is on screen ----
  function running() {
    return !!S && S.phase === 'run' && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel));
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
    if (!S.raf && !running()) return;              // the gamepad paused it
    S.idleT += dt;
    var f = S.f, alpha = advance(f, dt, held());
    handleEvents(f);
    stepFx(dt);
    // trail samples, at the interpolated position
    S.tT -= dt;
    if (S.tT <= 0) {
      S.tT = 1 / 40;
      var ix = f.px + (f.x - f.px) * alpha, iy = f.py + (f.y - f.py) * alpha;
      pushTrail(ix, iy + (f.gnd ? 0.6 : 0.8)); S.tseq++;
    }
    if (f.pw.rocket > 0 && !S.rm && Math.random() < 0.5) spark(f.x - 1.5, f.y + 0.8, -f.vx * 0.2, 2, 0.45, Math.random() < 0.5 ? 42 : 46, C_FLAME, 0);
    draw(alpha, dt);
    if (f.phase === 'done') {
      S.endT += dt;
      if (S.endT >= 0.9) { endRun(); return; }
    }
    S.raf = requestAnimationFrame(frame);
  }

  function handleEvents(f) {
    var ev = f.events, snd = S.snd, i, it;
    for (i = 0; i < f.hits.length; i++) {
      it = f.hits[i];
      if (it.k === 'coin') { popup(it.x, it.y, 10 * mult(f), C_GOLD); burst(it.x, it.y, 3, 6, '*.', C_GOLD, 0, 0.35); }
      else { burst(it.x, it.y, 12, 16, "*'.+", PW_SLOT[it.p], 6, 0.8); }
    }
    f.hits.length = 0;
    for (i = 0; i < ev.length; i++) {
      switch (ev[i]) {
        case 'launch': if (speedOf(f) > 22) snd.tone(260 + Math.min(500, speedOf(f) * 6), 0.18, 'sine', 0.02, 700 + Math.min(600, speedOf(f) * 8)); break;
        case 'coin':
          if (S.coinT <= S.idleT) { snd.tone(1320 + (S.coinN % 5) * 90, 0.06, 'sine', 0.035); S.coinT = S.idleT + 0.03; }
          S.coinN++;
          break;
        case 'perfect':
          snd.tone(660 + Math.min(10, f.chain) * 70, 0.12, 'triangle', 0.04, 0, 0); snd.tone(990 + Math.min(10, f.chain) * 90, 0.14, 'triangle', 0.03, 0, 0.06);
          popup(f.x, f.y + 1, f.lastGain, C_ACC);
          say(f.chain > 1 ? 'PERFECT x' + f.chain : 'PERFECT!', C_ACC, 0.9);
          burst(f.x, f.y, 5, 9, "'.", C_ACC, 4, 0.5);
          Cade.haptic && Cade.haptic(6);
          break;
        case 'fever':
          say('FEVER! x2', C_FLAME, 1.6);
          S.flash = 0.12;
          [523, 659, 784, 1047].forEach(function (fq, j) { snd.tone(fq, 0.1, 'square', 0.028, 0, j * 0.06); });
          burst(f.x, f.y + 1, 14, 18, "*+'.", -1, 6, 0.9);
          break;
        case 'thud':
          snd.tone(140, 0.16, 'sine', 0.06, 70);
          if (!S.msg || S.msg.t > 0.3) say('THUD', C_MUTED, 0.6);
          S.shake = 0.18;
          burst(f.x, f.y, 6, 7, ".,'", C_FAINT, 8, 0.5);
          Cade.haptic && Cade.haptic(14);
          break;
        case 'air': popup(f.x, f.y + 2, f.airScore, C_ICE); say('BIG AIR', C_ICE, 0.8, true); break;
        case 'pw':
          var P = PW[f.lastPw];
          say(P.name.toUpperCase() + (P.id === 'sun' ? ' +' + SUNBEAM + 's' : '!'), PW_SLOT[P.id], 1.2);
          [784, 988, 1175, 1568].forEach(function (fq, j) { snd.tone(fq, 0.09, 'triangle', 0.035, 0, j * 0.05); });
          Cade.haptic && Cade.haptic(10);
          break;
        case 'island':
          say('ISLAND ' + (f.island + 1) + (f.phase === 'run' ? '  +' + f.sunGain + 's SUN' : ''), C_SUN, 1.6);
          snd.tone(523, 0.12, 'triangle', 0.04); snd.tone(784, 0.18, 'triangle', 0.04, 0, 0.1); snd.tone(1047, 0.24, 'triangle', 0.035, 0, 0.2);
          S.flash = 0.08;
          break;
        case 'night':
          say('NIGHTFALL', C_STAR, 2.4);
          snd.tone(392, 0.4, 'sine', 0.04, 196);
          break;
      }
    }
    ev.length = 0;
  }

  // ---- cards ----
  function chip(cat, it) {
    var sv = S.save, own = owns(sv, cat, it.id), on = sv.sel[cat] === it.id, poor = !own && !it.need && sv.wallet < it.price;
    var face;
    if (cat === 'body') face = '<b class="dd-face">' + esc(it.ch) + '</b>';
    else if (cat === 'color') face = '<b class="dd-face dd-c-' + it.id + '">' + esc(itemOf('body', sv.sel.body).ch) + '</b>';
    else face = '<b class="dd-face">' + (it.s ? esc((it.s + it.s + it.s).slice(0, 3)) : '&middot;') + '</b>';
    var tag = own ? (on ? 'on' : '') : it.need ? '<i>' + esc(it.how) + '</i>' : '<i>$' + fmtInt(it.price) + '</i>';
    var lbl = it.name + (own ? (on ? ' (wearing)' : '') : it.need ? ' — locked: ' + it.how : ' — ' + it.price + ' coins');
    return '<button type="button" class="dd-chip' + (on ? ' on' : '') + (own ? '' : ' locked') + (poor ? ' poor' : '') + '" data-cat="' + cat + '" data-id="' + it.id + '"' +
      (!own && (it.need || poor) ? ' aria-disabled="true"' : '') + ' title="' + esc(lbl) + '" aria-label="' + esc(lbl) + '">' + face +
      '<span>' + esc(it.name) + '</span>' + (tag && tag !== 'on' ? tag : '') + '</button>';
  }
  function homeHtml() {
    var sv = S.save, r = sv.rec, h = '';
    h += '<div class="dd-card dd-home">';
    h += '<div class="dd-top"><span class="dd-brand">DUSK DASH</span><span class="dd-wallet" title="Coins to spend">$' + fmtInt(sv.wallet) + '</span></div>';
    h += '<div class="dd-tabs" role="tablist">' +
      ['look', 'records'].map(function (tb) { return '<button type="button" role="tab" data-tab="' + tb + '" aria-selected="' + (S.tab === tb) + '" class="' + (S.tab === tb ? 'on' : '') + '">' + (tb === 'look' ? 'Wardrobe' : 'Records') + '</button>'; }).join('') + '</div>';
    if (S.tab === 'look') {
      [['body', 'Body'], ['color', 'Colour'], ['trail', 'Trail']].forEach(function (cg) {
        h += '<div class="dd-sec"><div class="dd-h">' + cg[1] + '</div><div class="dd-chips">' + WARDROBE[cg[0]].map(function (it) { return chip(cg[0], it); }).join('') + '</div></div>';
      });
    } else {
      var rows = [['Best score', fmtInt(r.score)], ['Farthest', fmtDist(r.dist)], ['Best island', r.island ? String(r.island) : '-'],
        ['Perfect streak', String(r.chain)], ['Longest air', r.air.toFixed(1) + ' s'], ['Most coins (run)', String(r.coins)],
        ['Runs', fmtInt(sv.runs)], ['Coins collected', fmtInt(sv.total)]];
      h += '<pre class="dd-tab">' + rows.map(function (q) { return esc(q[0]) + new Array(Math.max(1, 26 - q[0].length - q[1].length) + 1).join(' ') + '<b>' + esc(q[1]) + '</b>'; }).join('\n') + '</pre>';
      h += '<div class="dd-foot">' + (S.resetArm ?
        '<span class="dd-confirm">Erase records, coins and looks?</span><span><button type="button" class="dd-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="dd-lnk" data-act="reset-no">Keep</button></span>' :
        '<span></span><button type="button" class="dd-lnk" data-act="reset">Reset progress</button>') + '</div>';
    }
    h += '<div class="dd-note">' + (r.score ? 'Best ' + fmtInt(r.score) + ' · ' + fmtDist(r.dist) : 'Hold to dive, let go to fly') + '</div>';
    return h + '</div>';
  }
  function helpHtml(first) {
    var keys = S.coarse ?
      '<div><b>hold the screen</b> &nbsp;(or the big button) to get heavy and dive</div><div><b>let go</b> &nbsp;to get light and fly</div>' :
      '<div><b>hold Space</b> / &darr; / S / the mouse &nbsp;get heavy and dive</div><div><b>let go</b> &nbsp;get light and fly</div><div><b>gamepad</b> &nbsp;hold A</div><div><b>P / Esc</b> &nbsp;pause</div>';
    return '<div class="dd-card dd-help">' +
      '<pre class="dd-art" aria-hidden="true">  \\ | /        .  o\n  -( )-     .\'\n __/\\___  _/\\__/\\_</pre>' +
      '<div class="dd-title">DUSK DASH</div>' +
      '<p>Race the sunset over endless hills. You&rsquo;re a dot: the ground is your friend.</p>' +
      '<div class="dd-keys">' + keys + '</div>' +
      '<p class="dd-tip"><b>Hold on the way down</b> to pick up speed, <b>let go on the way up</b> and the crest throws you into the air. Land along a downslope for a <b>PERFECT</b> slide; three in a row is <b>FEVER</b> (x2 score, faster).</p>' +
      '<p class="dd-tip">Each island crossed (<b>|&gt;</b> flags) buys more daylight. When the sun sets, you coast to a stop.</p>' +
      '<div class="dd-keys dd-pws">' + POWERS.map(function (p) { return '<div><b class="dd-pw dd-p-' + p.id + '">[' + p.ch + ']</b> ' + p.name + ' &nbsp;<span>' + p.info + '</span></div>'; }).join('') + '</div>' +
      '<p class="dd-tip">Coins (<b>$</b>) buy new looks in the Wardrobe.</p>' +
      (first ? '' : '<button type="button" class="dd-go" data-act="close-help">Back</button>') + '</div>';
  }
  function resultsHtml() {
    var cd = S.card, r = S.res, rows = [];
    function line(a, b2) { return esc(a) + new Array(Math.max(1, 26 - a.length - b2.length) + 1).join(' ') + '<b>' + esc(b2) + '</b>'; }
    rows.push(line('Distance', fmtDist(r.dist)));
    rows.push(line('Islands crossed', String(r.islands)));
    rows.push(line('Perfect slides', r.perfects + (r.chain > 1 ? ' (best x' + r.chain + ')' : '')));
    rows.push(line('Longest air', r.air.toFixed(1) + ' s'));
    rows.push(line('Top speed', Math.round(r.speed * 3.6) + ' km/h'));
    if (r.fevers) rows.push(line('Fevers', String(r.fevers)));
    if (r.powers) rows.push(line('Power-ups', String(r.powers)));
    rows.push('<i>' + new Array(27).join('-') + '</i>');
    rows.push('<span class="g">' + line('Coins', '+$' + r.coins) + '</span>');
    var bests = Object.keys(cd.best).filter(function (k) { return k !== 'score'; }).map(function (k) { return { dist: 'distance', island: 'island', chain: 'streak', air: 'air', coins: 'coins' }[k]; });
    return '<div class="dd-card dd-res">' +
      '<div class="dd-title">NIGHTFALL</div>' +
      '<div class="dd-big">' + fmtInt(r.score) + '</div>' +
      (cd.best.score ? '<div class="dd-new">** new best score **</div>' : '<div class="dd-sub">best ' + fmtInt(S.save.rec.score) + '</div>') +
      '<pre class="dd-tab">' + rows.join('\n') + '</pre>' +
      (bests.length ? '<div class="dd-new">new best ' + bests.join(', ') + '</div>' : '') +
      cd.unlocked.map(function (it) { return '<div class="dd-new">unlocked: ' + esc(it.name) + (it.ch ? ' (' + esc(it.ch) + ')' : '') + '</div>'; }).join('') +
      '<div class="dd-note">Wallet $' + fmtInt(cd.wallet) + nextBuy() + '</div></div>';
  }
  // The cheapest look still for sale, as a nudge.
  function nextBuy() {
    var best = null;
    ['body', 'color', 'trail'].forEach(function (cat) {
      WARDROBE[cat].forEach(function (it) { if (!it.need && !owns(S.save, cat, it.id) && (!best || it.price < best.price)) best = it; });
    });
    if (!best) return '';
    return S.save.wallet >= best.price ? ' · you can afford the ' + best.name.toLowerCase() + ' look' : ' · next look at $' + fmtInt(best.price);
  }
  function pauseHtml() {
    return '<div class="dd-card dd-pause"><div class="dd-title">PAUSED</div>' +
      '<div class="dd-sub">' + fmtInt(S.f.score) + ' · ' + fmtDist(Math.max(0, S.f.x)) + '</div>' +
      '<div class="dd-btns"><button type="button" class="dd-go" data-act="resume">Resume</button><button type="button" class="dd-go alt" data-act="quit">End run</button></div>' +
      '<div class="dd-note">' + (S.coarse ? 'Tap Resume to carry on' : 'Space / P to resume') + '</div></div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'home' ? homeHtml() : kind === 'help' ? helpHtml(S.firstRun) : kind === 'results' ? resultsHtml() : kind === 'pause' ? pauseHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind && kind !== 'home');
    S.stage.classList.toggle('home', kind === 'home');
  }
  function setPad(mode) {
    var h;
    S.padMode = mode;
    if (mode === 'run') h = '<button type="button" class="dd-hold" data-k="hold" aria-label="Hold to dive">Hold <span>to dive</span></button>';
    else {
      var lab = mode === 'go' ? 'Go!' : mode === 'again' ? 'Again' : mode === 'resume' ? 'Resume' : mode === 'start' ? 'Let’s go!' : 'Back';
      h = '<button type="button" class="dd-act" data-act="' + mode + '">' + lab + (S.coarse ? '' : ' <small>space</small>') + '</button>' +
        (mode === 'again' ? '<button type="button" class="dd-act alt" data-act="home">Wardrobe</button>' : '');
    }
    S.pad.innerHTML = h;
    syncPad();
  }
  function syncPad() {
    if (!S || S.padMode !== 'run') return;
    var b = S.pad.querySelector('[data-k]');
    if (b) b.classList.toggle('on', held());
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.phase !== 'run';
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }
  function syncLabel() {
    var r = S.save.rec;
    S.cv.setAttribute('aria-label', 'Dusk Dash — best score ' + fmtInt(r.score) + ', ' + fmtDist(r.dist) + '. Hold space, the down arrow or the play field to dive; let go to fly.');
  }

  function toHome() {
    S.phase = 'home'; S.f = null; S.paused = false; S.resetArm = false;
    S.hf = newRun(1);
    clearInput(); clearFx(); S.msg = null; S.msgQ.length = 0;
    showCard('home'); setPad('go'); syncHead(); syncLabel();
    draw(1, 0);
  }
  function startRun() {
    if (!S || (S.phase !== 'home' && S.phase !== 'results')) return;
    S.snd.ensure();
    S.f = newRun(runSeed(S.save));
    S.phase = 'run'; S.paused = false; S.endT = 0; S.coinN = 0; S.coinT = 0; S.dsc = 1.6; S.tseq = 0;
    clearInput(); clearFx(); S.msg = null; S.msgQ.length = 0;
    showCard(null); setPad('run'); syncHead();
    say('HOLD TO DIVE', C_MUTED, 1.6);
    kick();
  }
  function endRun() {
    stopLoop();
    S.res = summary(S.f);
    S.card = settle(S.save, S.res);
    persist();
    S.phase = 'results'; clearInput();
    showCard('results'); setPad('again'); syncHead(); syncLabel();
    if (S.liveEl) S.liveEl.textContent = 'Nightfall: ' + fmtInt(S.res.score) + ' points, ' + fmtDist(S.res.dist) + ', ' + S.res.coins + ' coins.';
    if (S.card.best.score) [659, 784, 988, 1319].forEach(function (fq, j) { S.snd.tone(fq, 0.12, 'triangle', 0.035, 0, j * 0.08); });
    draw(1, 0);
  }
  function padAction(act) {
    if (!S) return;
    S.snd.ensure();
    act = act || S.padMode;
    if (act === 'go' || act === 'again') startRun();
    else if (act === 'resume') resume();
    else if (act === 'home' || act === 'start' || act === 'back') toHome();
  }
  function pause() {
    if (!S || S.phase !== 'run' || S.paused) return;
    S.paused = true;
    stopLoop(); clearInput();
    showCard('pause'); setPad('resume'); syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null); setPad('run'); syncHead();
    kick();
  }
  function quitRun() {
    if (!S || S.phase !== 'run') return;
    S.paused = false;
    S.f.phase = 'done';
    endRun();
  }

  // ---- input: one action (hold), from keys, the pad, the play field and a gamepad ----
  var HOLD_KEYS = { Space: 1, ArrowDown: 1, KeyS: 1, Enter: 1, NumpadEnter: 1 };
  var KEY2CODE = { ' ': 'Space', arrowdown: 'ArrowDown', s: 'KeyS', p: 'KeyP', enter: 'Enter', escape: 'Escape' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  function held() {
    if (!S) return false;
    for (var k in S.keys) if (S.keys[k]) return true;
    for (var id in S.ptrs) return true;
    return !!S.gp.hold;
  }
  function clearInput() { S.keys = {}; S.ptrs = {}; S.gp.hold = false; syncPad(); }
  // Gamepad: A / a trigger / d-pad down hold; Start pauses; between runs A presses the big button.
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
    if (!p) { gp.hold = false; return; }
    var was = gp.hold;
    gp.hold = btnOn(p, 0) || btnOn(p, 7) || btnOn(p, 5) || btnOn(p, 13) || (p.axes[1] || 0) > 0.6;
    if (was !== gp.hold) syncPad();
    var st = btnOn(p, 9);
    if (st && !gp.start && S.phase === 'run' && !S.paused) pause();
    gp.start = st;
  }
  function pollMenus() {
    if (!S || (S.phase === 'run' && !S.paused)) return;
    var p = readPad();
    if (!p) return;
    var a = btnOn(p, 0) || btnOn(p, 9);
    if (a && !S.gp.menuA) { if (S.paused) resume(); else padAction(); }
    S.gp.menuA = a;
  }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !S.panel.contains(t)) return;
    var code = keyCode(e);
    if (code === 'Escape') {
      e.preventDefault();
      if (S.phase === 'run' && !S.paused) pause(); else closePanel();
      return;
    }
    if (S.phase === 'run') {
      if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
      if (S.paused) {
        if (code === 'Space' || code === 'Enter') { e.preventDefault(); if (!e.repeat) resume(); }
        else if (HOLD_KEYS[code]) e.preventDefault();
        return;
      }
      if (HOLD_KEYS[code]) { e.preventDefault(); if (!S.keys[code]) { S.keys[code] = true; syncPad(); } }
      return;
    }
    // between runs Space / Enter does the big button's job — unless a button in the panel has focus
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (!e.repeat) padAction();
    }
  }
  function onKeyUp(e) {
    if (!S) return;
    var code = keyCode(e);
    if (S.keys[code]) { delete S.keys[code]; syncPad(); }
  }

  // ---- layout ----
  // Height the play field may use: the visible viewport minus the panel's real top
  // offset and chrome (title bar, padding, pad, safe-area padding) — measured.
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
    var s = Math.min((vw - (phone ? 34 : 48)) / VW, phone ? 1.25 : solo ? 2.6 : 1.4), ah = availH(vw, vh);
    var vh2 = Math.floor(ah / s);
    if (vh2 < 288) { s = Math.max(0.55, Math.min(s, ah / 288)); vh2 = 288; }
    vh2 = Math.min(vh2, phone ? 520 : solo ? 420 : 340);
    var cw = Math.floor(VW * s), ch = Math.floor(vh2 * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--dd-w', cw + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / VW;
    S.VH = S.cv.height / S.k;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    if (S.col) fitFont();
  }
  function redraw() { if (!S) return; if (S.phase === 'run' && !S.paused && S.raf) return; draw(1, 0); }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('keyup', s.onKeyUp, true);
    document.removeEventListener('visibilitychange', s.onVis);
    clearInterval(s.gpT);
    window.removeEventListener('gamepadconnected', s.onPad);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    // hand the canvas memory back now (iOS keeps a canvas' backing store until GC)
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
    var body = '<div class="dd"><div class="dd-stage"><canvas class="dd-cv"></canvas><div class="dd-ovl" style="display:none"></div></div>' +
      '<div class="dd-pad"></div><div class="dd-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🌅 Dusk Dash', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'dd-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, stage: p.querySelector('.dd-stage'), cv: p.querySelector('.dd-cv'), ovl: p.querySelector('.dd-ovl'),
      pad: p.querySelector('.dd-pad'), liveEl: p.querySelector('.dd-live'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'home', f: null, hf: null, paused: false, raf: 0, last: 0, endT: 0, idleT: 0,
      keys: {}, ptrs: {}, gp: { hold: false, start: false, menuA: false }, gpT: 0,
      pal: new Array(NPAL), col: null, atl: null, cloudT: null, k: 1, VH: 288, v: {}, hue: [],
      tx: new Float32Array(200), ty: new Float32Array(200), ti: new Int16Array(200),
      cloudOff: 0, farOff: 0, lastLeft: null, shake: 0, flash: 0, dsc: 1.6, tseq: 0, coinN: 0, coinT: 0, dotX: 0, dotY: 0,
      msg: null, msgQ: [], tab: 'look', resetArm: false, padMode: '', cardKind: null
    };
    makeFx();
    S.ctx = S.cv.getContext('2d');
    S.hf = newRun(1);
    p._onClose = teardown;
    layout();
    readTheme();

    S.onKey = onKey; S.onKeyUp = onKeyUp;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKeyUp, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { pause(); clearInput(); } };
    window.addEventListener('blur', S.onBlur);
    // Minimized to the dock: pause like a tab switch and stop drawing.
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      pause(); clearInput(); stopLoop();
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

    // header: help / sound / pause (the header drags the panel — these are controls)
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
        if (S.phase === 'run') pause();
        if (S.cardKind === 'help') { if (S.phase === 'home') showCard('home'); }
        else if (S.phase === 'home') showCard('help');
      }
      try { b.blur(); } catch (er) {}
    });

    // Rapid tapping must never zoom, select, magnify or open a callout. CSS does
    // most of it (touch-action / user-select / touch-callout); iOS still zooms on
    // a quick double tap or pinch in places, so the hold surfaces cancel their
    // touches outright and the panel swallows gesture / dblclick events.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    [S.cv, S.pad].forEach(function (el) {
      el.addEventListener('touchstart', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
      el.addEventListener('touchmove', noTouch, { passive: false });
      el.addEventListener('touchend', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
    });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    // the play field and the pad's big button: hold (any number of fingers)
    function press(e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (S.phase !== 'run' || S.paused) return;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {}
      S.ptrs[e.pointerId] = 1; syncPad();
    }
    function release(e) {
      if (!S) return;
      if (S.ptrs[e.pointerId]) { delete S.ptrs[e.pointerId]; syncPad(); }
    }
    S.cv.addEventListener('pointerdown', press);
    S.pad.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-k]') : null;
      if (b) press(e);
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.cv.addEventListener(t, release); S.pad.addEventListener(t, release); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (b && S) padAction(b.getAttribute('data-act'));
    });
    // cards: tabs, the wardrobe, reset; pause buttons
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var cat = b.getAttribute('data-cat'), id = b.getAttribute('data-id'), tab = b.getAttribute('data-tab'), act = b.getAttribute('data-act');
      if (cat) {
        var sv = S.save;
        if (owns(sv, cat, id)) { wear(sv, cat, id); persist(); S.snd.tone(988, 0.05, 'sine', 0.03); }
        else if (buy(sv, cat, id)) {
          persist();
          S.snd.tone(1047, 0.07, 'square', 0.03); S.snd.tone(1568, 0.12, 'square', 0.025, 0, 0.07);
          Cade.haptic && Cade.haptic(8);
        } else {
          var it = itemOf(cat, id);
          Cade.showToast && Cade.showToast(it.need ? 'Locked — ' + it.how : 'Needs $' + fmtInt(it.price) + ' (you have $' + fmtInt(sv.wallet) + ')', 'info', 1800);
          return;
        }
        showCard('home'); draw(1, 0);
        var nb = e.detail === 0 && S.ovl.querySelector('[data-cat="' + cat + '"][data-id="' + id + '"]');
        if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
      } else if (tab) {
        S.tab = tab; showCard('home');
        var tb = e.detail === 0 && S.ovl.querySelector('[data-tab="' + tab + '"]');
        if (tb) { try { tb.focus({ preventScroll: true }); } catch (er) {} }
      }
      else if (act === 'reset') { S.resetArm = true; showCard('home'); }
      else if (act === 'reset-no') { S.resetArm = false; showCard('home'); }
      else if (act === 'reset-yes') {
        S.save = newSave(); S.save.seed = (Math.random() * 4294967295) >>> 0;
        persist(); S.tab = 'look';
        Cade.showToast && Cade.showToast('Progress reset', 'info', 1800);
        toHome();
      } else if (act === 'close-help') showCard('home');
      else if (act === 'resume') resume();
      else if (act === 'quit') quitRun();
    });

    if (S.firstRun) {
      S.phase = 'help';
      S.save.seed = (Math.random() * 4294967295) >>> 0;
      persist();
      showCard('help'); setPad('start'); syncHead(); syncLabel();
      draw(1, 0);
    } else toHome();
    // the canvas size depends on the panel's real chrome: measure again once it's laid out,
    // and refit the glyph grid when the mono font has loaded
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); redraw(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('600 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); redraw(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Race the sunset over endless hills — hold to dive, let go to fly; perfect slides, fever, power-ups and a wardrobe of looks',
    icon: '🌅',
    tags: 'game,arcade,fun,tiny wings,hills,glide,dive,slide,fly,one button,hold,sunset,endless,power-ups,ascii',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
