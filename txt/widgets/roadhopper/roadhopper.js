/* Road Hopper — a lane-crossing hopper for Cade.txt.
 * Hop a little glyph critter over busy roads (cars, coupes, dozers, racers,
 * trucks), across a river on drifting logs and lily pads (some pads sink for
 * a moment), into the five bays of the far bank. Fill all five to clear the
 * level; every level is faster and nastier (sinking pads, an eel lurking in a
 * bay, a snake on the median). A timer per trip, lives, bonuses: a coin that
 * shows up in a bay, a lost buddy riding a log (carry them home), time bonus,
 * extra lives. ENDLESS is a variant on procedurally generated lanes — grass
 * with trees and coins, roads, rivers, railway crossings — with the edge of
 * the screen creeping up behind you.
 * Modes: Classic / Endless, Easy / Normal / Hard, one player, vs a CPU rival
 * (Rookie / Pro / Ace — it runs the same lanes after you) or two players
 * taking turns on one device (same seed, pass the device in between).
 * Controls: arrows / WASD, swipe on the play field (tap = hop forward), the
 * pad under the field, a gamepad (d-pad / stick, A = forward).
 * Logic is grid based (rows are integers, x is continuous so logs can carry
 * you); a hop is a short eased move with an arc. Physics runs on a fixed
 * 120 Hz step with an accumulator; lane objects are a pure function of lane
 * time, so rendering interpolates exactly at any refresh rate. Drawn in
 * monospace glyphs from a cached glyph atlas, colours from the theme.
 * Records persist in Cade.store (cade-roadhopper-*). Offline, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var STEP = 1 / 120;
  var COLS = 15, ROWS = 13;            // classic board: rows 0 (start) .. 12 (the bays)
  var LOOP = 21, MARG = 6;             // a lane repeats every LOOP cells; objects live in [-MARG, LOOP-MARG)
  var HOP_T = 0.13;                    // seconds per hop
  var DIE_T = 1.35, CLEAR_T = 2.4;
  var START_COL = 7;
  var BAYS = [1, 4, 7, 10, 13];
  var DIVE_P = 7;                      // lily-pad sink cycle (s)
  var TRAIN = 14;                      // train length in cells
  var LIFE_AT = 10000, LIFE_STEP = 15000, MAX_LIVES = 9;
  var DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];   // up, right, down, left as [dx, drow]

  var DIFFS = {
    easy: { name: 'Easy', speed: 0.8, time: 40, lives: 5, creep: 0.7, eelLv: 3 },
    normal: { name: 'Normal', speed: 1, time: 30, lives: 3, creep: 1, eelLv: 2 },
    hard: { name: 'Hard', speed: 1.22, time: 24, lives: 3, creep: 1.3, eelLv: 1 }
  };
  var DIFF_IDS = ['easy', 'normal', 'hard'];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mod(a, n) { a = a % n; return a < 0 ? a + n : a; }
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
  // The game's own random stream lives in g.rs (a number), so a game is plain
  // JSON: it can be cloned (the test bot looks ahead that way).
  function rnd(g) {
    g.rs = (g.rs + 0x6D2B79F5) | 0;
    var t = Math.imul(g.rs ^ (g.rs >>> 15), 1 | g.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ---- lanes ----
  // A lane: { k: 'safe'|'road'|'water'|'home'|'rail', v: cells/s, t: lane time,
  // objs: [{ x, len, ty, dive, ph }], hurt: objects kill on touch, trees, coin }.
  // An object's left edge at lane time t is mod(x + v·t, LOOP) − MARG.
  function lane(k, v) { return { k: k, v: v || 0, t: 0, objs: [], hurt: k === 'road', trees: [], coin: -1 }; }
  function objX(L, o, t) { return mod(o.x + L.v * (t == null ? L.t : t), LOOP) - MARG; }
  function padUp(o, t) {             // a sinking pad holds you until it's under
    if (!o.dive) return true;
    var p = mod(t + o.ph, DIVE_P);
    return p < 5.2 || p >= 6.6;
  }
  function padState(o, t) {          // 0 up, 1 sinking, 2 under, 3 rising
    if (!o.dive) return 0;
    var p = mod(t + o.ph, DIVE_P);
    return p < 4.3 ? 0 : p < 5.2 ? 1 : p < 6.2 ? 2 : p < 6.6 ? 3 : 0;
  }
  // Index of the object holding a hopper whose centre is at cx, or -1.
  function support(L, cx, t) {
    if (!L || L.k !== 'water') return -1;
    if (t == null) t = L.t;
    for (var i = 0; i < L.objs.length; i++) {
      var o = L.objs[i], x = objX(L, o, t);
      if (cx >= x - 0.14 && cx <= x + o.len + 0.14 && padUp(o, t)) return i;
    }
    return -1;
  }
  // Does anything that hurts overlap [a, b] on this lane?
  function hitAt(L, a, b, t) {
    if (!L) return null;
    if (L.k === 'rail') return L.st === 'pass' && b > L.tx + 0.15 && a < L.tx + TRAIN - 0.15 ? 'train' : null;
    if (!L.hurt) return null;
    if (t == null) t = L.t;
    for (var i = 0; i < L.objs.length; i++) {
      var o = L.objs[i], x = objX(L, o, t);
      if (b > x + 0.1 && a < x + o.len - 0.1) return o.ty === 'snake' ? 'snake' : 'squash';
    }
    return null;
  }

  // Classic board: roads in rows 1–5, the median 6, the river 7–11, the bays 12.
  var CLASSIC = [
    { r: 1, k: 'road', ty: 'car', len: 2, v: -1.0, n: 3 },
    { r: 2, k: 'road', ty: 'dozer', len: 2, v: 0.72, n: 3 },
    { r: 3, k: 'road', ty: 'coupe', len: 2, v: -1.45, n: 3 },
    { r: 4, k: 'road', ty: 'racer', len: 1, v: 3.0, n: 1 },
    { r: 5, k: 'road', ty: 'truck', len: 3, v: -1.1, n: 2 },
    { r: 7, k: 'water', ty: 'lily', len: 3, v: -1.15, n: 4 },
    { r: 8, k: 'water', ty: 'log', len: 3, v: 0.85, n: 4 },
    { r: 9, k: 'water', ty: 'log', len: 5, v: 1.8, n: 3 },
    { r: 10, k: 'water', ty: 'lily', len: 2, v: -1.45, n: 4 },
    { r: 11, k: 'water', ty: 'log', len: 4, v: 1.2, n: 3 }
  ];
  function levelSpeed(g, water) {
    var lv = g.level - 1, D = DIFFS[g.diff];
    return D.speed * (water ? Math.min(1.75, 1 + 0.085 * lv) : Math.min(2.1, 1 + 0.13 * lv));
  }
  function buildClassic(g) {
    var lv = g.level, sp = levelSpeed(g, false), spw = levelSpeed(g, true), lanes = [], r, i;
    for (r = 0; r < ROWS; r++) lanes.push(lane(r === 12 ? 'home' : 'safe'));
    for (i = 0; i < CLASSIC.length; i++) {
      var c = CLASSIC[i], L = lane(c.k, c.v * (c.k === 'water' ? spw : sp)), n = c.n, len = c.len;
      if (c.r === 1 && lv >= 3) n = 4;
      if (c.r === 3 && lv >= 5) n = 4;
      if (c.r === 4 && lv >= 4) n = 2;
      if (c.r === 8 && lv >= 4) len = 2;
      if (c.r === 9 && lv >= 5) len = 4;
      if (c.r === 11 && lv >= 6) len = 3;
      var dives = c.ty !== 'lily' ? [] : c.r === 7 ? (lv >= 3 ? [1, 3] : [1]) : (lv >= 2 ? [0, 2] : [2]);
      var sp0 = LOOP / n, j0 = rnd(g) * sp0;
      for (var j = 0; j < n; j++) {
        L.objs.push({ x: j0 + j * sp0 + (rnd(g) - 0.5) * Math.max(0, sp0 - len - 2.2) * 0.5, len: len, ty: c.ty,
          dive: dives.indexOf(j) >= 0, ph: rnd(g) * DIVE_P });
      }
      lanes[c.r] = L;
    }
    if (lv >= 3) {                    // a snake slithers along the median
      var M = lane('safe', 0.6 * sp);
      M.hurt = true;
      M.objs.push({ x: rnd(g) * LOOP, len: 2, ty: 'snake', dive: false, ph: 0 });
      lanes[6] = M;
    }
    g.lanes = lanes;
  }
  function resetBays(g) {
    g.bays = BAYS.map(function (c) { return { col: c, fill: false, item: '', t: 0 }; });
    g.bayT = 4 + rnd(g) * 3;
  }

  // ---- endless: lanes generated ahead of the hopper, from the seed and the row ----
  function genEndless(g, upto) {
    var G = g.gen, D = DIFFS[g.diff];
    while (G.row <= upto) {
      var r = G.row, d = clamp(r / 260, 0, 1), R = rng(hash2(g.seed, r * 7 + 1)), L;
      if (r < 3) L = grass(R, r, d, true);
      else {
        if (G.left <= 0) {
          var opts = [['grass', 0.28], ['road', 0.34], ['water', 0.27], ['rail', r > 14 ? 0.11 : 0]], tot = 0, k, pick = '';
          for (k = 0; k < opts.length; k++) if (opts[k][0] !== G.last) tot += opts[k][1];
          var x = R() * tot;
          for (k = 0; k < opts.length; k++) {
            if (opts[k][0] === G.last) continue;
            pick = opts[k][0];
            if ((x -= opts[k][1]) < 0) break;
          }
          if (r === 3) pick = 'road';                     // ease in: traffic before the first river
          G.last = pick;
          G.left = pick === 'grass' ? 1 + Math.floor(R() * 2) : pick === 'road' ? 1 + Math.floor(R() * (2 + Math.round(3 * d))) :
            pick === 'water' ? 1 + Math.floor(R() * (2 + Math.round(2 * d))) : 1 + (r > 60 && R() < 0.4 ? 1 : 0);
          G.wdir = R() < 0.5 ? 1 : -1;
        }
        G.left--;
        if (G.last === 'grass') L = grass(R, r, d, false);
        else if (G.last === 'road') L = road(R, d, D);
        else if (G.last === 'water') { L = river(R, d, D, G.wdir); G.wdir = -G.wdir; }
        else L = rail(R, d, D, g.seed, r);
      }
      g.lanes[r] = L;
      G.row++;
    }
  }
  function grass(R, r, d, start) {
    var L = lane('safe'), n = start ? (r === 0 ? 3 : 0) : Math.floor(R() * (3 + 2.5 * d)), tries = 0;
    while (L.trees.length < n && tries++ < 40) {
      var c = Math.floor(R() * COLS);
      if (start && Math.abs(c - START_COL) < 3) continue;
      if (L.trees.indexOf(c) < 0) L.trees.push(c);
    }
    if (!start && R() < 0.32) {
      for (tries = 0; tries < 20; tries++) { var cc = Math.floor(R() * COLS); if (L.trees.indexOf(cc) < 0) { L.coin = cc; break; } }
    }
    return L;
  }
  var ROAD_TYPES = [
    { ty: 'racer', len: 1, v0: 2.5, v1: 3.6, gap: 7 },
    { ty: 'car', len: 2, v0: 0.9, v1: 1.7, gap: 3 },
    { ty: 'coupe', len: 2, v0: 1.1, v1: 2.0, gap: 3.4 },
    { ty: 'dozer', len: 2, v0: 0.5, v1: 0.9, gap: 2.8 },
    { ty: 'truck', len: 3, v0: 0.7, v1: 1.3, gap: 3.4 }
  ];
  function road(R, d, D) {
    var T = ROAD_TYPES[Math.floor(R() * ROAD_TYPES.length)];
    var L = lane('road', (R() < 0.5 ? 1 : -1) * (T.v0 + R() * (T.v1 - T.v0)) * (1 + 0.6 * d) * D.speed);
    var gmin = Math.max(2, T.gap - d), x = R() * 3;
    while (x + T.len <= LOOP - gmin || !L.objs.length) {
      L.objs.push({ x: x, len: T.len, ty: T.ty, dive: false, ph: 0 });
      x += T.len + gmin + R() * (6 - 2 * d);
    }
    return L;
  }
  function river(R, d, D, dir) {
    var lily = R() < 0.35, v = Math.min(2.6, (0.7 + R() * 0.9) * (1 + 0.4 * d) * D.speed);
    var L = lane('water', dir * v), x = R() * 2;
    while (true) {
      var len = lily ? 2 + Math.floor(R() * 2) : 2 + Math.floor(R() * (4 - 1.5 * d));
      if (x + len > LOOP - 1.2 && L.objs.length >= 2) break;
      L.objs.push({ x: x, len: len, ty: lily ? 'lily' : 'log', dive: lily && L.objs.length > 0 && R() < 0.25 + 0.4 * d, ph: R() * DIVE_P });
      x += len + 1.2 + R() * (1.8 + d);
    }
    return L;
  }
  function rail(R, d, D, seed, r) {
    var L = lane('rail', (R() < 0.5 ? 1 : -1) * (16 + 6 * d));
    L.st = 'idle'; L.tm = 1.5 + R() * 4; L.tx = -TRAIN - 2; L.cyc = 0; L.seed = hash2(seed, r);
    return L;
  }
  function stepRail(L, g, dt) {
    L.tm -= dt;
    if (L.st === 'idle' && L.tm <= 0) { L.st = 'warn'; L.tm = 1.3; g.events.push('bell'); }
    else if (L.st === 'warn' && L.tm <= 0) { L.st = 'pass'; L.tx = L.v > 0 ? -TRAIN : COLS; g.events.push('train'); }
    else if (L.st === 'pass') {
      L.tx += L.v * dt;
      if (L.tx > COLS + 1 || L.tx < -TRAIN - 1) {
        L.cyc++;
        L.st = 'idle'; L.tm = (2.5 + (hash2(L.seed, L.cyc) / 4294967296) * 5) / DIFFS[g.diff].creep;
      }
    }
  }

  // ---- a game ----
  function newHopper(col, row) { return { x: col, y: row, px: col, py: row, face: 0, hop: null, q: -1, ride: -1, z: 0, pz: 0, carry: false, top: row }; }
  function newGame(opts) {
    opts = opts || {};
    var mode = opts.mode === 'endless' ? 'endless' : 'classic', dk = DIFFS[opts.diff] ? opts.diff : 'normal', D = DIFFS[dk], seed = (opts.seed >>> 0) || 1;
    var g = {
      mode: mode, diff: dk, seed: seed, rs: hash2(seed, 99) | 0, t: 0, steps: 0, acc: 0, phase: 'play', level: 1,
      lives: mode === 'endless' ? 1 : D.lives, score: 0, time: D.time, timeMax: D.time, maxRow: 0, homes: 0, coins: 0, hops: 0, bonus: 0,
      deaths: {}, events: [], pops: [], dieT: 0, cause: '', dieX: 0, dieY: 0, clearT: 0, nextLife: LIFE_AT, lanes: [], bays: [], bayT: 5,
      buddy: null, buddyT: 8, cam: 0, pcam: 0, floor: 0, started: false, gen: null, h: null
    };
    if (mode === 'classic') { buildClassic(g); resetBays(g); g.h = newHopper(START_COL, 0); }
    else { g.gen = { row: 0, left: 0, last: 'grass', wdir: 1 }; genEndless(g, ROWS + 12); g.h = newHopper(START_COL, 1); g.maxRow = 1; }
    return g;
  }
  function laneAt(g, r) {
    r = Math.round(r);
    if (r < 0) return null;
    if (g.mode === 'classic' && r >= ROWS) return null;
    return g.lanes[r] || null;
  }
  function bayAt(g, x) {               // the bay a hop aimed at x lands in (a little magnetism)
    var best = -1, bd = 0.8;
    for (var i = 0; i < BAYS.length; i++) { var dd = Math.abs(BAYS[i] - x); if (dd < bd) { bd = dd; best = i; } }
    return best;
  }

  // Ask for a hop (0 up, 1 right, 2 down, 3 left). Mid-hop it is buffered.
  function hop(g, dir) {
    var h = g.h;
    if (g.phase !== 'play' || !(dir >= 0 && dir <= 3)) return false;
    if (h.hop) { h.q = dir; return false; }
    var dx = DIRS[dir][0], dy = DIRS[dir][1], ty = Math.round(h.y) + dy, L = laneAt(g, ty);
    h.face = dir;
    if (!L) { g.events.push('bump'); return false; }
    var tx = h.x + dx;
    if (L.k === 'home') { var b = bayAt(g, tx); tx = b >= 0 ? BAYS[b] : Math.round(tx); }
    else if (L.k !== 'water') tx = Math.round(tx);
    if (L.k === 'water' ? (tx < -0.45 || tx > COLS - 0.55) : (tx < 0 || tx > COLS - 1)) { g.events.push('bump'); return false; }
    if (L.trees.length && L.trees.indexOf(tx) >= 0) { g.events.push('bump'); return false; }
    h.hop = { x0: h.x, y0: Math.round(h.y), x1: tx, y1: ty, t: 0 };
    h.ride = -1; h.q = -1; g.hops++; g.started = true;
    g.events.push('hop');
    return true;
  }

  function addScore(g, v, x, y) {
    g.score += v;
    if (x != null) g.pops.push({ x: x, y: y, v: v });
    if (g.mode === 'classic' && g.score >= g.nextLife) {
      g.nextLife += LIFE_STEP;
      if (g.lives < MAX_LIVES) { g.lives++; g.events.push('life'); }
    }
  }

  function die(g, cause) {
    if (g.phase !== 'play') return;
    var h = g.h;
    g.phase = 'dying'; g.dieT = 0; g.cause = cause; g.dieX = h.x; g.dieY = Math.round(h.y);
    g.deaths[cause] = (g.deaths[cause] || 0) + 1;
    g.lives--;
    if (h.carry && g.buddy) { g.buddy = null; g.buddyT = 8 + rnd(g) * 6; }
    h.carry = false; h.hop = null; h.q = -1; h.z = 0; h.ride = -1;
    g.events.push('die');
  }
  function respawn(g) {
    g.h = newHopper(START_COL, 0);
    g.time = g.timeMax; g.phase = 'play';
  }
  function reachHome(g, b) {
    var h = g.h, bay = g.bays[b], x = BAYS[b];
    bay.fill = true;
    var base = 50 + 10 * Math.ceil(g.time);
    addScore(g, base, x, 12);
    g.homes++;
    g.events.push('home');
    if (bay.item === 'coin') { addScore(g, 200, x, 11.4); g.bonus++; g.events.push('coin'); }
    if (h.carry) { addScore(g, 200, x, 11); g.bonus++; g.buddy = null; g.buddyT = 9 + rnd(g) * 6; g.events.push('rescue'); }
    bay.item = ''; bay.t = 0;
    for (var i = 0; i < g.bays.length; i++) if (!g.bays[i].fill) { respawn(g); return; }
    g.phase = 'clear'; g.clearT = 0; h.hop = null;
    addScore(g, 1000, 7, 6);
    g.events.push('clear');
  }
  function land(g) {
    var h = g.h, L = laneAt(g, h.y), row = Math.round(h.y);
    h.y = row;
    if (L.k === 'water') {
      var s = support(L, h.x + 0.5);
      if (s < 0) { die(g, 'splash'); return; }
      h.ride = s;
      buddyCheck(g);
    } else if (L.k === 'home') {
      var b = BAYS.indexOf(Math.round(h.x));
      h.x = Math.round(h.x);
      if (b < 0 || g.bays[b].fill) { die(g, 'hedge'); return; }
      if (g.bays[b].item === 'eel') { die(g, 'eel'); return; }
      reachHome(g, b);
      return;
    } else {
      h.x = Math.round(h.x);
      if (L.coin >= 0 && L.coin === h.x) { L.coin = -1; g.coins++; addScore(g, 25, h.x, row); g.events.push('coin'); }
    }
    if (row > h.top) { addScore(g, 10 * (row - h.top)); h.top = row; }
    if (row > g.maxRow) g.maxRow = row;
    if (h.q >= 0 && g.phase === 'play') { var q = h.q; h.q = -1; hop(g, q); }
  }
  function buddyCheck(g) {
    var bd = g.buddy, h = g.h;
    if (!bd || h.carry || bd.row !== Math.round(h.y) || h.ride !== bd.obj) return;
    var L = g.lanes[bd.row], bx = objX(L, L.objs[bd.obj]) + bd.off + 0.5;
    if (Math.abs(bx - (h.x + 0.5)) < 0.8) { h.carry = true; g.events.push('buddy'); }
  }
  function stepBays(g, dt) {
    var i, b, free = [];
    for (i = 0; i < g.bays.length; i++) {
      b = g.bays[i];
      if (b.item && (b.t -= dt) <= 0) { b.item = ''; b.t = 0; }
      if (!b.fill && !b.item) free.push(i);
    }
    if ((g.bayT -= dt) <= 0) {
      g.bayT = 5 + rnd(g) * 4;
      if (free.length) {
        b = g.bays[free[Math.floor(rnd(g) * free.length)]];
        b.item = g.level >= DIFFS[g.diff].eelLv && rnd(g) < 0.45 ? 'eel' : 'coin';
        b.t = 5;
      }
    }
  }
  var BUDDY_ROWS = [8, 9, 11];
  function stepBuddy(g, dt) {
    var bd = g.buddy;
    if (!bd) {
      if ((g.buddyT -= dt) <= 0) {
        var row = BUDDY_ROWS[Math.floor(rnd(g) * BUDDY_ROWS.length)], L = g.lanes[row];
        g.buddy = { row: row, obj: Math.floor(rnd(g) * L.objs.length), off: 0, dir: 1, t: 14 };
      }
      return;
    }
    if (g.h.carry) return;
    var o = g.lanes[bd.row].objs[bd.obj];
    bd.off += bd.dir * 0.7 * dt;
    if (bd.off > o.len - 1) { bd.off = o.len - 1; bd.dir = -1; }
    if (bd.off < 0) { bd.off = 0; bd.dir = 1; }
    if ((bd.t -= dt) <= 0) { g.buddy = null; g.buddyT = 8 + rnd(g) * 8; }
  }

  // One fixed step.
  function step(g) {
    var dt = STEP, h = g.h, r, L, ev = g.events;
    g.t += dt; g.steps++;
    h.px = h.x; h.py = h.y; h.pz = h.z; g.pcam = g.cam;
    // the world moves in every phase (the menus show it running)
    var r0 = g.mode === 'classic' ? 0 : Math.max(0, Math.floor(g.cam) - 2), r1 = g.mode === 'classic' ? ROWS - 1 : Math.floor(g.cam) + ROWS + 2;
    for (r = r0; r <= r1; r++) {
      L = g.lanes[r];
      if (!L) continue;
      L.t += dt;
      if (L.k === 'rail') stepRail(L, g, dt);
    }
    if (g.mode === 'classic') { stepBays(g, dt); stepBuddy(g, dt); }
    if (g.phase === 'dying') {
      g.dieT += dt;
      if (g.dieT >= DIE_T) {
        if (g.lives > 0 && g.mode === 'classic') respawn(g);
        else { g.phase = 'over'; ev.push('over'); }
      }
      return;
    }
    if (g.phase === 'clear') {
      if ((g.clearT += dt) >= CLEAR_T) {
        g.level++; buildClassic(g); resetBays(g); respawn(g);
        g.buddy = null; g.buddyT = 8;
        ev.push('level');
      }
      return;
    }
    if (g.phase !== 'play') return;
    if (g.mode === 'classic') {
      var t0 = Math.ceil(g.time);
      g.time -= dt;
      if (g.time <= 0) { g.time = 0; die(g, 'time'); return; }
      if (Math.ceil(g.time) !== t0 && t0 <= 6) ev.push('tick');
    }
    if (h.hop) {
      var hp = h.hop, L0 = laneAt(g, hp.y0), L1 = laneAt(g, hp.y1);
      if (L0 && L0.k === 'water') hp.x0 += L0.v * dt;
      if (L1 && L1.k === 'water') hp.x1 += L1.v * dt;
      hp.t = Math.min(1, hp.t + dt / HOP_T);
      var e = 1 - (1 - hp.t) * (1 - hp.t);
      h.x = hp.x0 + (hp.x1 - hp.x0) * e; h.y = hp.y0 + (hp.y1 - hp.y0) * e; h.z = Math.sin(Math.PI * hp.t);
      if (hp.t >= 1) {
        h.hop = null; h.z = 0; h.x = hp.x1; h.y = hp.y1;
        land(g);
        if (g.phase !== 'play') return;
      }
    } else {
      L = laneAt(g, h.y);
      if (L && L.k === 'water') {
        h.x += L.v * dt;
        var s = support(L, h.x + 0.5);
        if (s < 0) { die(g, 'splash'); return; }
        h.ride = s;
        buddyCheck(g);
        if (h.x + 0.5 < 0 || h.x + 0.5 > COLS) { die(g, 'drift'); return; }
      }
    }
    // traffic, trains, the snake
    var hit = hitAt(laneAt(g, h.y), h.x + 0.22, h.x + 0.78);
    if (hit) { die(g, hit); return; }
    if (g.mode === 'endless') stepCam(g, dt);
  }
  function creepSpeed(g) { return Math.min(0.55, 0.11 + 0.0016 * g.maxRow) * DIFFS[g.diff].creep; }
  function stepCam(g, dt) {
    var h = g.h;
    if (g.started) g.floor += creepSpeed(g) * dt;
    var want = Math.max(g.floor, h.y - 4.5);
    if (want > g.cam) g.cam += (want - g.cam) * Math.min(1, 4 * dt);
    if (g.floor < g.cam - 1.5) g.floor = g.cam - 1.5;   // running ahead buys a little slack, not a lot
    genEndless(g, Math.floor(g.cam) + ROWS + 12);
    for (var r = g.gen.pr || 0, r1 = Math.floor(g.cam) - 4; r < r1; r++) g.lanes[r] = null;   // forget lanes far behind
    if (Math.floor(g.cam) - 4 > (g.gen.pr || 0)) g.gen.pr = Math.floor(g.cam) - 4;
    if (!h.hop && h.y < g.cam - 0.45) die(g, 'behind');
  }

  // Advance real time with the fixed step; returns the render interpolation alpha.
  function advance(g, dt) {
    g.acc = Math.min(g.acc + dt, 0.25);
    while (g.acc >= STEP) { step(g); g.acc -= STEP; }
    return g.acc / STEP;
  }
  function clone(g) { return JSON.parse(JSON.stringify(g)); }
  function summary(g) {
    return { mode: g.mode, diff: g.diff, score: g.score, level: g.level, homes: g.homes, row: g.maxRow, coins: g.coins,
      hops: g.hops, bonus: g.bonus, time: g.t, cause: g.cause };
  }

  // A look-ahead pilot (tests, and the demo on the title screen): tries each
  // hop on a copy of the game and keeps the one that survives and climbs.
  function pilot(g, depth) {
    if (g.phase !== 'play' || g.h.hop) return -1;
    var best = -1, bs = -1e9, order = [0, 1, 3, -1, 2];
    for (var i = 0; i < order.length; i++) {
      var d = order[i], c = clone(g);
      c.events = []; c.pops = [];
      if (d >= 0 && !hop(c, d)) continue;
      var n = Math.round((d >= 0 ? 0.42 : 0.2) / STEP), k;
      for (k = 0; k < n && c.phase === 'play'; k++) step(c);
      if (c.phase === 'dying' || c.phase === 'over') continue;
      var sc = c.h.y * 10 + (c.phase === 'clear' ? 500 : 0) + (c.homes - g.homes) * 300 - Math.abs(c.h.x - START_COL) * 0.2;
      if (d === 2) sc -= 6;
      if (d === -1) sc -= 1;
      var Lc = laneAt(c, c.h.y), hr = Math.round(c.h.y), bd = 99;
      if (c.mode === 'classic' && (hr === 11 || hr === 10)) {      // line up a free bay
        for (var bi = 0; bi < BAYS.length; bi++) {
          if (!c.bays[bi].fill && c.bays[bi].item !== 'eel') bd = Math.min(bd, Math.abs(BAYS[bi] - c.h.x));
        }
        if (bd < 99) sc -= bd * (hr === 11 ? 4 : 1.2);
        if (hr === 11) { var b = bayAt(c, c.h.x); sc += b >= 0 && !c.bays[b].fill && c.bays[b].item !== 'eel' ? 4 : -2; }
      }
      if (Lc && Lc.k === 'water' && bd > 1.2) {                     // don't ride a log off the edge
        var ex = Lc.v > 0 ? COLS - 1 - c.h.x : c.h.x;
        if (ex < 2) sc -= (2 - ex) * 5;
      }
      if (depth && c.phase === 'play' && !c.h.hop) { var nx = pilot(c, depth - 1); if (nx < -1) sc -= 25; }
      if (sc > bs) { bs = sc; best = d; }
    }
    return best === -1 && bs === -1e9 ? -2 : best;
  }

  // ---- the CPU rival: the pilot with a reaction time, a search depth and the odd blunder ----
  var CPU_LV = {
    rookie: { name: 'Rookie', react: 0.34, depth: 0, slip: 0.03 },
    pro: { name: 'Pro', react: 0.17, depth: 1, slip: 0.012 },
    ace: { name: 'Ace', react: 0.07, depth: 1, slip: 0.004 }
  };
  var CPU_IDS = ['rookie', 'pro', 'ace'];
  function newCpu(lv, seed) { return { lv: CPU_LV[lv] ? lv : 'pro', wait: 0.6, rs: hash2(seed >>> 0, 4242) | 0, moves: 0 }; }
  // Let the CPU think for dt seconds; it hops when its reaction timer runs out.
  // Returns the hop it made (0..3), or -1. Every hop it makes is a legal hop().
  function cpuTick(g, cpu, dt) {
    if (g.phase !== 'play' || g.h.hop) return -1;
    if ((cpu.wait -= dt) > 0) return -1;
    var P = CPU_LV[cpu.lv] || CPU_LV.pro, d;
    cpu.wait = P.react * (0.7 + 0.6 * rnd(cpu));
    // it tires: slips get likelier the longer the run goes on
    if (rnd(cpu) < P.slip * (1 + g.t / 120)) d = [0, 0, 1, 3][Math.floor(rnd(cpu) * 4)];
    else d = pilot(g, P.depth);
    if (d >= 0 && hop(g, d)) { cpu.moves++; return d; }
    return -1;
  }

  // ---- the save: settings, records, top scores ----
  function recKey(mode, diff) { return (mode === 'endless' ? 'endless' : 'classic') + '-' + (DIFFS[diff] ? diff : 'normal'); }
  function newSave() {
    return { v: 1, mode: 'classic', diff: 'normal', players: 1, cpu: false, cpuLv: 'pro', seed: 1, games: 0, homes: 0, hops: 0, coins: 0, rec: {}, tops: {} };
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    if (o.mode === 'endless' || o.mode === 'classic') s.mode = o.mode;
    if (DIFFS[o.diff]) s.diff = o.diff;
    s.players = o.players === 2 ? 2 : 1;
    s.cpu = o.cpu === true && s.players === 2;
    if (CPU_LV[o.cpuLv]) s.cpuLv = o.cpuLv;
    s.seed = (+o.seed >>> 0) || 1;
    ['games', 'homes', 'hops', 'coins'].forEach(function (k) { s[k] = Math.max(0, Math.floor(+o[k] || 0)); });
    ['classic', 'endless'].forEach(function (m) {
      DIFF_IDS.forEach(function (d) {
        var k = recKey(m, d), r = o.rec && o.rec[k], t = o.tops && o.tops[k];
        if (r && typeof r === 'object') s.rec[k] = { score: Math.max(0, Math.floor(+r.score || 0)), level: Math.max(0, Math.floor(+r.level || 0)), row: Math.max(0, Math.floor(+r.row || 0)) };
        if (Array.isArray(t)) {
          s.tops[k] = t.filter(function (e) { return e && typeof e === 'object' && isFinite(+e.s); }).map(function (e) {
            return { s: Math.max(0, Math.floor(+e.s)), n: Math.max(0, Math.floor(+e.n || 0)), d: typeof e.d === 'string' ? e.d.slice(0, 10) : '' };
          }).sort(function (a, b) { return b.s - a.s; }).slice(0, 5);
        }
      });
    });
    return s;
  }
  // Fold a finished game into the save; returns { best, rank } (rank 1..5 in the top table, or 0).
  function settle(save, res, date) {
    var k = recKey(res.mode, res.diff), r = save.rec[k] || (save.rec[k] = { score: 0, level: 0, row: 0 });
    var out = { best: res.score > r.score && res.score > 0, rank: 0, bestN: false };
    save.games++; save.homes += res.homes || 0; save.hops += res.hops || 0; save.coins += res.coins || 0;
    if (res.score > r.score) r.score = res.score;
    var n = res.mode === 'endless' ? res.row : res.level;
    if (res.mode === 'endless') { if (res.row > r.row) { out.bestN = r.row > 0; r.row = res.row; } }
    else if (res.level > r.level) { out.bestN = r.level > 0; r.level = res.level; }
    var T = save.tops[k] || (save.tops[k] = []);
    if (res.score > 0) {
      var e = { s: res.score, n: n, d: date || '' }, i = 0;
      while (i < T.length && T[i].s >= e.s) i++;
      if (i < 5) { T.splice(i, 0, e); out.rank = i + 1; }
      if (T.length > 5) T.length = 5;
    }
    return out;
  }
  function gameSeed(save) { return hash2(save.seed, save.games + 1) || 1; }

  var ENGINE = {
    STEP: STEP, COLS: COLS, ROWS: ROWS, LOOP: LOOP, MARG: MARG, HOP_T: HOP_T, DIE_T: DIE_T, CLEAR_T: CLEAR_T, START_COL: START_COL,
    BAYS: BAYS, DIVE_P: DIVE_P, TRAIN: TRAIN, DIFFS: DIFFS, LIFE_AT: LIFE_AT, CLASSIC: CLASSIC,
    rng: rng, hash2: hash2, mod: mod, objX: objX, padUp: padUp, padState: padState, support: support, hitAt: hitAt,
    newGame: newGame, laneAt: laneAt, hop: hop, step: step, advance: advance, clone: clone, summary: summary, pilot: pilot,
    buildClassic: buildClassic, genEndless: genEndless, creepSpeed: creepSpeed, levelSpeed: levelSpeed, die: die,
    CPU_LV: CPU_LV, newCpu: newCpu, cpuTick: cpuTick,
    newSave: newSave, normSave: normSave, settle: settle, recKey: recKey, gameSeed: gameSeed
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('roadhopper.css');

  var PANEL_ID = 'roadhopper-panel', NAME = 'Road Hopper';
  var KEY = 'cade-roadhopper-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var CELL = 24, CW = 8, RH = 12, VW = COLS * CELL, FY = 34, FH = ROWS * CELL, VH = FY + FH + 26;
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.roadhopper = { live: function () { return S; }, engine: ENGINE };   // test-only peek

  // palette slots (glyph colours), filled from the theme
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOLD = 4, C_RED = 5, C_ICE = 6, C_FLAME = 7, C_LEAF = 8, C_VIOLET = 9,
    C_LOG = 10, C_WAVE = 11, C_TUFT = 12, C_HEDGE = 13, C_LINE = 14, C_PINK = 15, NPAL = 16;
  var VEH = { car: C_RED, coupe: C_ICE, dozer: C_GOLD, racer: C_VIOLET, truck: C_FLAME, snake: C_LEAF };
  // right-facing sprites: [top row, bottom row], three characters per cell
  var SPR = {
    car: [' _/=\\_', '(o--o>'],
    coupe: ['.-==-.', '[o--o>'],
    dozer: [' [#]_.', '(O)=o>'],
    racer: ['_=.', 'o=>'],
    truck: ['[#####]|\\', '(oo---oo>']
  };
  var MIR = { '/': '\\', '\\': '/', '<': '>', '>': '<', '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{' };
  function mirror(s) { var o = ''; for (var i = s.length - 1; i >= 0; i--) { var ch = s.charAt(i); o += MIR[ch] || ch; } return o; }
  var SPRL = {};
  for (var sk in SPR) SPRL[sk] = [mirror(SPR[sk][0]), mirror(SPR[sk][1])];
  var HOPPER = [['o.o', '/_\\'], ['.oo', '/_)'], ['\\_/', 'o.o'], ['oo.', '(_\\']];   // up, right, down, left
  var CAUSE = {
    squash: 'SPLAT!', splash: 'SPLASH!', drift: 'SWEPT AWAY', time: 'OUT OF TIME', hedge: 'HEDGE!', eel: 'EEL!',
    snake: 'SNAKE BITE', train: 'TRAIN!', behind: 'TOO SLOW!'
  };
  var CAUSE_LONG = {
    squash: 'flattened by traffic', splash: 'fell in the river', drift: 'drifted off the edge', time: 'ran out of time',
    hedge: 'hopped into the hedge', eel: 'met the eel', snake: 'bitten by the snake', train: 'hit by a train', behind: 'left behind'
  };

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
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
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
  var IC_ARROW = [svg('<path d="M12 19V5M5 12l7-7 7 7"/>'), svg('<path d="M5 12h14M12 5l7 7-7 7"/>'), svg('<path d="M12 5v14M5 12l7 7 7-7"/>'), svg('<path d="M19 12H5M12 5l-7 7 7 7"/>')];

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
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.55)), fa = parseCol(v('--text-faint'), mix(bg, tx, 0.35));
    var P = S.pal;
    S.dark = dark;
    var gold = dark ? [242, 197, 68] : [176, 125, 6], red = dark ? [240, 106, 106] : [207, 63, 63], ice = dark ? [124, 199, 242] : [40, 120, 181];
    var flame = dark ? [255, 143, 63] : [226, 97, 31], leaf = dark ? [126, 211, 122] : [47, 143, 58], violet = dark ? [183, 156, 245] : [115, 81, 196];
    var logc = dark ? [201, 154, 100] : [138, 90, 43], pink = dark ? [244, 143, 196] : [196, 64, 128];
    P[C_TEXT] = css(tx); P[C_MUTED] = css(mu); P[C_FAINT] = css(fa); P[C_ACC] = css(ac);
    P[C_GOLD] = css(gold); P[C_RED] = css(red); P[C_ICE] = css(ice); P[C_FLAME] = css(flame); P[C_LEAF] = css(leaf); P[C_VIOLET] = css(violet);
    P[C_LOG] = css(logc); P[C_WAVE] = css(mix(bg, ice, dark ? 0.42 : 0.4)); P[C_TUFT] = css(mix(bg, leaf, dark ? 0.4 : 0.38));
    P[C_HEDGE] = css(mix(bg, leaf, dark ? 0.62 : 0.66)); P[C_LINE] = css(mix(bg, tx, dark ? 0.3 : 0.26)); P[C_PINK] = css(pink);
    S.col = {
      bg: css(bg), hud: css(bg, 0.86), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace',
      grass: css(mix(bg, leaf, dark ? 0.13 : 0.12)), road: css(mix(bg, tx, dark ? 0.08 : 0.065)), water: css(mix(bg, ice, dark ? 0.22 : 0.17)),
      hedge: css(mix(bg, leaf, dark ? 0.3 : 0.28)), bay: css(mix(bg, ice, dark ? 0.32 : 0.26)), log: css(mix(bg, logc, dark ? 0.36 : 0.28)),
      lily: css(mix(bg, leaf, dark ? 0.32 : 0.26)), hop: css(mix(bg, ac, dark ? 0.3 : 0.2)), train: css(mix(bg, violet, dark ? 0.26 : 0.2)), shadow: css(tx, dark ? 0.25 : 0.14),
      veh: {}
    };
    for (var k in VEH) S.col.veh[k] = css(mix(bg, parseCol(P[VEH[k]]), dark ? 0.24 : 0.17));
    fitFont();
  }

  // ---- glyph rendering: (colour, char) pairs cached in an atlas canvas, stamped with drawImage ----
  var AT_COLS = 24, AT_ROWS = 18;
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '600 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = Math.min(CW / adv, RH * 1.02);
    S.fnt = '600 ' + S.fpx.toFixed(3) + 'px ' + f;
    buildAtlas();
  }
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.k || !S.col) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
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
  function glyph(c, ci, code, x, y, nosnap, sc) {
    if (code === 32) return;
    var i = gIdx(ci, code), a = S.atl;
    if (i < 0) {
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
  var NB = new Uint8Array(24);
  function writeNum(v, comma) {
    var n = 0, ip = Math.max(0, Math.round(v)), cnt = 0;
    do { if (comma && cnt && cnt % 3 === 0) NB[n++] = 44; NB[n++] = 48 + ip % 10; ip = Math.floor(ip / 10); cnt++; } while (ip > 0 && n < 20);
    for (var a = 0, b = n - 1; a < b; a++, b--) { var t = NB[a]; NB[a] = NB[b]; NB[b] = t; }
    return n;
  }
  function drawNum(c, ci, n, x, y, align, sc) {
    var cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, NB[i], x0 + i * cw + cw / 2, y, false, sc);
    return x0 + n * cw;
  }
  function rrect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  // ---- particles (in cells / rows, so they scroll with the endless camera) and pop-ups ----
  var NPART = 72, NPOP = 8;
  function makeFx() {
    S.parts = [];
    for (var i = 0; i < NPART; i++) S.parts.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, code: 46, ci: 0, g: 0 });
    S.popsFx = [];
    for (i = 0; i < NPOP; i++) S.popsFx.push({ on: false, x: 0, y: 0, t: 0, v: 0, ci: C_GOLD });
    S.pi = 0; S.qi = 0;
  }
  function clearFx() {
    for (var i = 0; i < NPART; i++) S.parts[i].on = false;
    for (i = 0; i < NPOP; i++) S.popsFx[i].on = false;
    S.msg = null; S.msgQ.length = 0; S.shake = 0; S.flash = 0;
  }
  function spark(x, y, vx, vy, life, code, ci, g) {
    var p = S.parts[S.pi]; S.pi = (S.pi + 1) % NPART;
    p.on = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.t = 0; p.life = life; p.code = code; p.ci = ci; p.g = g || 0;
  }
  function burst(x, y, n, sp, codes, ci, g, life) {
    if (S.rm) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = sp * (0.35 + Math.random() * 0.65);
      spark(x, y, Math.cos(a) * v, Math.sin(a) * v, life * (0.6 + Math.random() * 0.5), codes.charCodeAt(i % codes.length), ci, g);
    }
  }
  function popup(x, y, v, ci) {
    var p = S.popsFx[S.qi]; S.qi = (S.qi + 1) % NPOP;
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
    for (i = 0; i < NPOP; i++) { p = S.popsFx[i]; if (p.on && (p.t += dt) > 1.1) p.on = false; }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt);
    if (S.flash > 0) S.flash = Math.max(0, S.flash - dt);
    if (S.msg && (S.msg.t += dt) > S.msg.dur) S.msg = S.msgQ.length ? S.msgQ.shift() : null;
  }
  function say(text, ci, dur, queue) {
    var m = { text: text, ci: ci == null ? C_TEXT : ci, t: 0, dur: dur || 1.2 };
    if (queue && S.msg && S.msgQ.length < 3) S.msgQ.push(m); else { S.msg = m; S.msgQ.length = 0; }
  }

  // ---- the scene ----
  function camOf(g, a) { return g.mode === 'classic' ? 0 : g.pcam + (g.cam - g.pcam) * a; }
  function rowY(r, cam) { return FY + (ROWS - 1 - (r - cam)) * CELL; }          // top edge of a row
  function cx(x) { return (x + 0.5) * CELL; }                                     // centre of a hopper at cell x

  function draw(alpha) {
    if (!S || !S.ctx || !S.atl) return;
    var g = S.g || S.dg, c = S.ctx, a = alpha, cam = camOf(g, a), i;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.fillStyle = S.col.bg; c.fillRect(-10, -10, VW + 20, VH + 20);
    c.save();
    if (S.shake > 0 && !S.rm) { var sh = S.shake * 10; c.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh); }
    c.beginPath(); c.rect(0, FY, VW, FH); c.clip();
    var r0 = Math.floor(cam) - 1, r1 = Math.floor(cam) + ROWS;
    for (var r = r1; r >= r0; r--) { var L = laneAt(g, r); if (L) drawLaneBg(c, g, L, r, rowY(r, cam), a); }   // top down: lane marks spill upwards
    for (r = r0; r <= r1; r++) { var L2 = laneAt(g, r); if (L2) drawLaneObjs(c, g, L2, r, rowY(r, cam), a); }
    if (S.g && g.mode === 'endless') {               // the record row, as a line across the field
      var rb = S.save.rec[recKey(g.mode, g.diff)], br = rb ? rb.row : 0;
      if (br > 3 && br >= cam - 1 && br <= cam + ROWS) {
        var by = rowY(br, cam) + 1;
        c.globalAlpha = br <= g.maxRow ? 0.35 : 0.8;
        for (i = 0; i < COLS * 3; i++) if (i % 3 !== 2) glyph(c, C_GOLD, 45, i * CW + CW / 2, by);
        drawStr(c, C_GOLD, ' BEST ', VW - 6, by, 'right', false, 0.8);
        c.globalAlpha = 1;
      }
    }
    drawHopper(c, g, cam, a);
    // particles + pop-ups
    for (i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on) continue;
      c.globalAlpha = Math.min(1, 2.5 * (1 - p.t / p.life));
      glyph(c, p.ci, p.code, p.x * CELL, rowY(p.y, cam) + CELL / 2);
    }
    c.globalAlpha = 1;
    for (i = 0; i < NPOP; i++) {
      var pp = S.popsFx[i];
      if (!pp.on) continue;
      c.globalAlpha = Math.min(1, 3 * (1.1 - pp.t));
      var n = writeNum(pp.v, true), qx = clamp(pp.x * CELL, (n + 1) * CW / 2 + 2, VW - (n + 1) * CW / 2 - 2), qy = rowY(pp.y, cam) - pp.t * 22;
      glyph(c, pp.ci, 43, qx - (n + 1) * CW / 2 + CW / 2, qy);
      drawNum(c, pp.ci, n, qx + CW / 2, qy, 'center');
    }
    c.globalAlpha = 1;
    c.restore();
    if (S.g) hud(c, g);
    else { c.fillStyle = S.col.hud; c.fillRect(0, 0, VW, FY); c.fillRect(0, FY + FH, VW, VH - FY - FH); }
    if (S.msg && S.g) banner(c, S.msg.text, FY + FH * 0.5, S.msg.ci);
    if (S.flash > 0 && !S.rm) { c.fillStyle = S.dark ? 'rgba(255,255,255,' + (S.flash * 0.9).toFixed(3) + ')' : 'rgba(255,255,255,' + (S.flash * 1.4).toFixed(3) + ')'; c.fillRect(0, 0, VW, VH); }
  }

  function cellHash(r, col) { return hash2(r * 31 + 7, col) % 97; }
  function drawLaneBg(c, g, L, r, y, a) {
    var k = L.k, i, col;
    if (k === 'safe') {
      c.fillStyle = S.col.grass; c.fillRect(0, y, VW, CELL);
      for (col = 0; col < COLS; col++) {
        var hh = cellHash(r, col);
        if (hh < 22) glyph(c, C_TUFT, hh < 8 ? 44 : hh < 15 ? 34 : 39, col * CELL + 4 + (hh % 3) * 7, y + 6 + (hh % 2) * 11);
      }
      if (g.mode === 'classic' && r === 6) { for (i = 0; i < COLS * 3; i++) if (i % 2 === 0) glyph(c, C_TUFT, 46, i * CW + CW / 2, y + CELL - 2); }
    } else if (k === 'road') {
      c.fillStyle = S.col.road; c.fillRect(0, y, VW, CELL);
      var up = laneAt(g, r + 1);
      if (up && up.k === 'road') for (i = 0; i < COLS * 3; i++) if (i % 4 < 2) glyph(c, C_LINE, 45, i * CW + CW / 2, y - 1, false, 0.9);
    } else if (k === 'water' || k === 'home') {
      c.fillStyle = k === 'home' ? S.col.hedge : S.col.water; c.fillRect(0, y, VW, CELL);
      if (k === 'water') {
        var off = mod(L.t * L.v * 0.35 * CELL, CELL * 2), ph = r % 2 ? CELL : 0;
        for (i = -1; i < COLS / 2 + 1; i++) {
          var wx = i * CELL * 2 + off + ph;
          glyph(c, C_WAVE, 126, wx, y + 7); glyph(c, C_WAVE, 126, wx + CELL, y + 17);
        }
      } else drawBays(c, g, y);
    } else if (k === 'rail') {
      c.fillStyle = S.col.road; c.fillRect(0, y, VW, CELL);
      for (i = 0; i < COLS * 3; i++) {
        glyph(c, C_LINE, 61, i * CW + CW / 2, y + 7);
        glyph(c, C_LINE, i % 3 === 1 ? 124 : 61, i * CW + CW / 2, y + 17);
      }
      if (L.st === 'warn' || L.st === 'pass') {
        var on = ((S.clock * 6) | 0) % 2 === 0;
        c.fillStyle = on ? (S.dark ? 'rgba(240,106,106,0.22)' : 'rgba(207,63,63,0.16)') : 'rgba(0,0,0,0)';
        c.fillRect(0, y, VW, CELL);
        if (L.st === 'warn') {
          glyph(c, C_RED, 33, 6, y + CELL / 2, false, 1.4); glyph(c, C_RED, 33, VW - 6, y + CELL / 2, false, 1.4);
          if (on) drawStr(c, C_RED, L.v > 0 ? '>>>' : '<<<', L.v > 0 ? 16 : VW - 16, y + CELL / 2, L.v > 0 ? 'left' : 'right');
        }
      }
    }
  }
  function drawBays(c, g, y) {
    for (var i = 0; i < COLS * 3; i++) {
      var col = (i / 3) | 0;
      if (BAYS.indexOf(col) >= 0) continue;
      glyph(c, C_HEDGE, i % 2 ? 35 : 37, i * CW + CW / 2, y + 7);
      glyph(c, C_HEDGE, i % 2 ? 37 : 35, i * CW + CW / 2, y + 17);
    }
    var t = S.clock;
    for (var b = 0; b < BAYS.length; b++) {
      var x = BAYS[b] * CELL, bay = g.bays[b];
      c.fillStyle = S.col.bay; rrect(c, x + 1, y + 3, CELL - 2, CELL - 3, 4); c.fill();
      if (!bay) continue;
      if (bay.fill) { drawStr(c, C_ACC, HOPPER[2][0], x + CELL / 2, y + 7, 'center'); drawStr(c, C_ACC, HOPPER[2][1], x + CELL / 2, y + 17, 'center'); }
      else if (bay.item === 'coin') glyph(c, C_GOLD, ((t * 4) | 0) % 4 === 0 ? 83 : 36, x + CELL / 2, y + 13 + Math.sin(t * 5) * 1.5, false, 1.5);
      else if (bay.item === 'eel') {
        var open = ((t * 3) | 0) % 2;
        drawStr(c, C_RED, open ? 'vvv' : '\\v/', x + CELL / 2, y + 8, 'center');
        drawStr(c, C_RED, open ? '^^^' : '/^\\', x + CELL / 2, y + 17, 'center');
      }
    }
  }
  function drawLaneObjs(c, g, L, r, y, a) {
    var i, tt = L.t - (1 - a) * STEP, objs = L.objs;
    if (L.k === 'water') {
      for (i = 0; i < objs.length; i++) {
        var o = objs[i], x = objX(L, o, tt) * CELL, w = o.len * CELL;
        drawFloat(c, o, x, y, w, tt);
        if (x + w > VW) drawFloat(c, o, x - LOOP * CELL, y, w, tt);
        else if (x < 0) drawFloat(c, o, x + LOOP * CELL, y, w, tt);
      }
      var bd = g.buddy;
      if (bd && bd.row === r && !(g.h && g.h.carry)) {
        var bo = objs[bd.obj], bx = (objX(L, bo, tt) + bd.off + 0.5) * CELL;
        glyph(c, C_PINK, 64, bx, y + 10 + Math.sin(S.clock * 8) * 1.2, false, 1.35);
        glyph(c, C_PINK, 118, bx, y + 20, false, 0.9);
      }
    } else if (L.k === 'road' || (L.k === 'safe' && objs.length)) {
      for (i = 0; i < objs.length; i++) {
        var v = objs[i], vx = objX(L, v, tt) * CELL;
        drawVeh(c, L, v, vx, y);
        if (vx + v.len * CELL > VW) drawVeh(c, L, v, vx - LOOP * CELL, y);
        else if (vx < 0) drawVeh(c, L, v, vx + LOOP * CELL, y);
      }
    } else if (L.k === 'rail' && L.st === 'pass') {
      var tx = (L.tx - L.v * (1 - a) * STEP) * CELL;
      c.fillStyle = S.col.train; rrect(c, tx + 1, y + 2, TRAIN * CELL - 2, CELL - 3, 5); c.fill();
      var n3 = TRAIN * 3, fwd = L.v > 0;
      for (i = 0; i < n3; i++) {
        var gx = tx + i * CW + CW / 2;
        if (gx < -CW || gx > VW + CW) continue;
        var j = fwd ? i : n3 - 1 - i, cab = j >= n3 - 3;
        var tch = cab ? (j === n3 - 1 ? (fwd ? 92 : 47) : 35) : j % 7 === 0 || j % 7 === 6 ? (j % 7 === 0 ? (fwd ? 91 : 93) : (fwd ? 93 : 91)) : j % 7 === 3 ? 61 : 35;
        var bch = cab ? (j === n3 - 1 ? (fwd ? 62 : 60) : 111) : j % 7 === 1 || j % 7 === 5 ? 111 : 45;
        glyph(c, C_VIOLET, tch, gx, y + 7);
        glyph(c, C_VIOLET, bch, gx, y + 17);
      }
    } else if (L.k === 'safe') {
      for (i = 0; i < L.trees.length; i++) {
        var tc = L.trees[i] * CELL + CELL / 2;
        drawStr(c, C_LEAF, '/^\\', tc, y + 7, 'center');
        drawStr(c, C_LOG, '"|"', tc, y + 17, 'center');
      }
      if (L.coin >= 0) glyph(c, C_GOLD, ((S.clock * 4 + r) | 0) % 5 === 0 ? 83 : 36, L.coin * CELL + CELL / 2, y + 12 + Math.sin(S.clock * 4 + r) * 1.6, false, 1.5);
    }
  }
  function drawFloat(c, o, x, y, w, tt) {
    if (x > VW || x + w < 0) return;
    var i, n = o.len * 3;
    if (o.ty === 'log') {
      c.fillStyle = S.col.log; rrect(c, x + 1, y + 3, w - 2, CELL - 5, 8); c.fill();
      for (i = 0; i < n; i++) {
        var top = i === 0 ? 40 : i === n - 1 ? 41 : (i % 4 === 1 ? 61 : 45), bot = i === 0 ? 40 : i === n - 1 ? 64 : (i % 5 === 3 ? 126 : 95);
        glyph(c, C_LOG, top, x + i * CW + CW / 2, y + 8);
        glyph(c, C_LOG, bot, x + i * CW + CW / 2, y + 15);
      }
      return;
    }
    // lily pads, one per cell; a sinking one fades, an under one leaves bubbles
    var st = padState(o, tt);
    for (i = 0; i < o.len; i++) {
      var px = x + i * CELL;
      if (st === 2) { glyph(c, C_WAVE, ((S.clock * 3 + i) | 0) % 2 ? 111 : 46, px + CELL / 2, y + 12); continue; }
      c.globalAlpha = st === 1 ? 0.45 + 0.35 * (((S.clock * 8) | 0) % 2) : st === 3 ? 0.4 : 1;
      c.fillStyle = S.col.lily; rrect(c, px + 2, y + 3, CELL - 4, CELL - 5, 9); c.fill();
      drawStr(c, C_LEAF, ' _ ', px + CELL / 2, y + 5, 'center');
      drawStr(c, C_LEAF, o.dive && st === 1 ? '...' : '(_)', px + CELL / 2, y + 15, 'center');
      c.globalAlpha = 1;
    }
  }
  function drawVeh(c, L, o, x, y) {
    var w = o.len * CELL;
    if (x > VW || x + w < 0) return;
    var ci = VEH[o.ty] || C_RED, right = L.v > 0;
    if (o.ty === 'snake') {
      var wig = ((S.clock * 6) | 0) % 2, s = wig ? '~^~^:>' : '^~^~:>';
      drawStr(c, ci, right ? s : mirror(s), x + w / 2, y + 12, 'center');
      return;
    }
    c.fillStyle = S.col.veh[o.ty]; rrect(c, x + 2, y + 2, w - 4, CELL - 4, 5); c.fill();
    var sp = right ? SPR[o.ty] : SPRL[o.ty];
    drawStr(c, ci, sp[0], x + w / 2, y + 7, 'center');
    drawStr(c, ci, sp[1], x + w / 2, y + 17, 'center');
  }

  function drawHopper(c, g, cam, a) {
    var h = g.h;
    if (!h) return;
    if (g.phase === 'dying' || g.phase === 'over') { drawDeath(c, g, cam); return; }
    if (g.phase === 'clear') return;
    var x = cx(h.px + (h.x - h.px) * a), yr = h.py + (h.y - h.py) * a, z = h.pz + (h.z - h.pz) * a;
    var y = rowY(yr, cam) + CELL / 2, sc = 1 + 0.22 * z, lift = z * 7;
    // a shadow on the ground, then the hopper in the air above it
    c.fillStyle = S.col.shadow;
    c.beginPath(); c.ellipse(x, y + 10, 9 - z * 3, 2.2 - z * 0.6, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = S.col.hop;
    c.beginPath(); c.arc(x, y - lift, 10.5 * sc, 0, Math.PI * 2); c.fill();
    var sp = HOPPER[h.face] || HOPPER[0], ty = sp[0], by = z > 0.25 && h.face !== 2 ? '|_|' : sp[1];   // legs tucked in mid-air
    var blink = g.mode === 'classic' && g.time < 6 && ((S.clock * 8) | 0) % 2 === 0;
    var ci = blink ? C_RED : C_ACC;
    drawStr(c, ci, ty, x, y - 5 * sc - lift, 'center', true, sc);
    drawStr(c, ci, by, x, y + 5 * sc - lift, 'center', true, sc);
    if (h.carry) glyph(c, C_PINK, 64, x, y - 13 * sc - lift, true, 1.1);
  }
  function drawDeath(c, g, cam) {
    var x = cx(g.dieX), y = rowY(g.dieY, cam) + CELL / 2, t = g.dieT, cs = g.cause;
    if (g.phase === 'over' && g.mode === 'endless' && t > 3) return;
    c.globalAlpha = clamp(1.6 - t / DIE_T, 0, 1);
    if (cs === 'splash' || cs === 'drift') {
      var f = Math.min(3, (t * 5) | 0), A = [['.o.', '(_)'], [' O ', '( )'], ['o O', '(   )'], ['~ ~', '~~~']][f];
      drawStr(c, C_ICE, A[0], x, y - 5, 'center'); drawStr(c, C_ICE, A[1], x, y + 5, 'center');
    } else if (cs === 'time' || cs === 'behind') {
      drawStr(c, C_MUTED, 'x.x', x, y - 5, 'center'); drawStr(c, C_MUTED, '/_\\', x, y + 5, 'center');
      if (((t * 3) | 0) % 2) drawStr(c, C_FAINT, 'z', x + 10, y - 14 - t * 6, 'center');
    } else {
      drawStr(c, C_RED, '\\|/', x, y - 5, 'center'); drawStr(c, C_RED, '-*-', x, y + 5, 'center');
    }
    c.globalAlpha = 1;
  }

  function banner(c, s, y, ci) {
    var w = (s.length + 4) * CW;
    c.fillStyle = S.col.bg; rrect(c, VW / 2 - w / 2, y - RH, w, RH * 2, 6); c.fill();
    c.strokeStyle = S.pal[ci]; c.lineWidth = 1; rrect(c, VW / 2 - w / 2 + 0.5, y - RH + 0.5, w - 1, RH * 2 - 1, 6); c.stroke();
    drawStr(c, ci, s, VW / 2, y, 'center');
  }

  function hud(c, g) {
    var yl = 8, yv = 22, n, x, L = 0.72, i;
    c.fillStyle = S.col.hud; c.fillRect(0, 0, VW, FY);
    c.fillRect(0, FY + FH, VW, VH - FY - FH);
    var rec = S.save.rec[recKey(g.mode, g.diff)], hi = Math.max(rec ? rec.score : 0, g.score);
    var vsCpu = !!(S.match && S.match.cpu && S.match.cur === 1 && S.match.res[0]);
    if (vsCpu) hi = S.match.res[0].score;            // while the CPU runs, the HUD shows the score it has to beat
    drawStr(c, C_MUTED, S.match && S.match.n > 1 ? (S.match.cpu ? (S.match.cur ? 'CPU SCORE' : 'YOUR SCORE') : 'P' + (S.match.cur + 1) + ' SCORE') : 'SCORE', 6, yl, 'left', false, L);
    n = writeNum(g.score, true); drawNum(c, C_TEXT, n, 6, yv);
    drawStr(c, C_MUTED, vsCpu ? 'YOU' : 'HI', 116, yl, 'left', false, L);
    n = writeNum(hi, true); drawNum(c, vsCpu ? (g.score > hi ? C_RED : C_ACC) : hi === g.score && g.score > 0 ? C_ACC : C_TEXT, n, 116, yv);
    drawStr(c, C_MUTED, g.mode === 'classic' ? 'LEVEL' : 'ROW', 210, yl, 'left', false, L);
    n = writeNum(g.mode === 'classic' ? g.level : g.maxRow); drawNum(c, C_TEXT, n, 210, yv);
    if (g.mode === 'classic') {
      drawStr(c, C_MUTED, 'LIVES', VW - 6, yl, 'right', false, L);
      var lv = Math.max(0, g.lives - (g.phase === 'play' || g.phase === 'clear' ? 1 : 0));   // the one in play isn't in reserve
      for (i = 0; i < Math.min(lv, 6); i++) glyph(c, C_ACC, 64, VW - 10 - i * 11, yv, false, 1.05);
      if (lv > 6) drawStr(c, C_MUTED, '+' + (lv - 6), VW - 10 - 6 * 11, yv, 'right', false, 0.8);
      if (!lv) drawStr(c, C_FAINT, '-', VW - 10, yv, 'center');
    } else {
      drawStr(c, C_MUTED, 'COINS', VW - 6, yl, 'right', false, L);
      n = writeNum(g.coins); x = drawNum(c, C_TEXT, n, VW - 6, yv, 'right');
      glyph(c, C_GOLD, 36, VW - 6 - n * CW - 7, yv);
    }
    // bottom: the trip timer (classic) / the creeping edge (endless)
    var yb = FY + FH + 13;
    if (g.mode === 'classic') {
      var cells = 26, fr = clamp(g.time / g.timeMax, 0, 1), on = Math.ceil(fr * cells - 0.001), low = g.time < 6 && g.phase === 'play';
      drawStr(c, low ? C_RED : C_MUTED, 'TIME', 6, yb, 'left', false, L);
      x = 44;
      for (i = 0; i < cells; i++) glyph(c, i < on ? (low && ((S.clock * 4) | 0) % 2 ? C_RED : low ? C_FLAME : C_LEAF) : C_FAINT, i < on ? 35 : 45, x + i * 8 + 4, yb, false, 0.9);
      n = writeNum(Math.ceil(g.time)); NB[n++] = 115;
      drawNum(c, low ? C_RED : C_MUTED, n, VW - 6, yb, 'right', L);
      if (g.h && g.h.carry) drawStr(c, C_PINK, '@', x + cells * 8 + 4, yb, 'left', false, L);
    } else {
      var lag = g.h ? g.h.y - g.cam : 5, warn = lag < 1.6 && g.phase === 'play';
      drawStr(c, warn ? C_RED : C_MUTED, warn ? 'HURRY UP!' : 'KEEP HOPPING', 6, yb, 'left', false, L);
      drawStr(c, C_MUTED, DIFFS[g.diff].name.toUpperCase(), VW - 6, yb, 'right', false, L);
    }
  }

  // ---- loop: runs only while a game is on screen ----
  function running() {
    return !!S && S.phase === 'play' && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel));
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
    if (!running()) return;
    S.clock += dt;
    var g = S.g, alpha;
    if (S.cpu && S.skip) {                      // fast-forward: simulate in a frame-sized time budget
      var t0 = performance.now();
      while (g.phase !== 'over' && performance.now() - t0 < 12) {
        for (var k = 0; k < 30 && g.phase !== 'over'; k++) { cpuTick(g, S.cpu, STEP); step(g); }
        g.events.length = 0; g.pops.length = 0;
        if (g.t > CPU_CAP && g.phase !== 'over') { g.phase = 'over'; g.cause = ''; }
      }
      g.acc = 0; alpha = 1;
      if (g.phase === 'over') S.endT = 1.3;
    } else {
      if (S.cpu) cpuTick(g, S.cpu, dt);
      alpha = advance(g, dt);
      if (S.cpu && g.t > CPU_CAP && g.phase === 'play') { g.phase = 'over'; g.cause = ''; }
    }
    handleEvents(g);
    stepFx(dt);
    draw(alpha);
    if (g.phase === 'over') {
      S.endT += dt;
      if (S.endT >= 1.3) { endGame(); return; }
    }
    S.raf = requestAnimationFrame(frame);
  }

  function handleEvents(g) {
    var ev = g.events, snd = S.snd, h = g.h, i;
    for (i = 0; i < g.pops.length; i++) { var p = g.pops[i]; popup(p.x + 0.5, p.y + 0.5, p.v, p.v >= 200 ? C_GOLD : C_ACC); }
    g.pops.length = 0;
    for (i = 0; i < ev.length; i++) {
      switch (ev[i]) {
        case 'hop':
          snd.tone(380 + (h.face === 0 ? 140 : h.face === 2 ? -60 : 40) + Math.random() * 30, 0.06, 'square', 0.018, 620);
          if (!S.rm) burst(h.x + 0.5, Math.round(h.y) - 0.3, 3, 1.2, '.,', C_FAINT, 0, 0.3);
          break;
        case 'bump': snd.tone(140, 0.06, 'square', 0.025); Cade.haptic && Cade.haptic(5); break;
        case 'die':
          var cs = g.cause;
          say(CAUSE[cs] || 'OUCH', cs === 'splash' || cs === 'drift' ? C_ICE : cs === 'time' || cs === 'behind' ? C_MUTED : C_RED, 1.3);
          if (cs === 'splash' || cs === 'drift') {
            snd.tone(700, 0.3, 'sine', 0.05, 120); snd.tone(1400, 0.12, 'triangle', 0.02, 300, 0.05);
            burst(g.dieX + 0.5, g.dieY, 12, 2.4, "o.'~", C_ICE, 3, 0.7);
          } else if (cs === 'time' || cs === 'behind') {
            snd.tone(440, 0.18, 'triangle', 0.04, 330); snd.tone(330, 0.3, 'triangle', 0.04, 220, 0.18);
          } else {
            snd.tone(160, 0.22, 'sawtooth', 0.05, 55); snd.tone(90, 0.3, 'square', 0.03, 40, 0.03);
            burst(g.dieX + 0.5, g.dieY, 14, 3.2, "*#.'", C_RED, 2, 0.6);
            S.shake = 0.25;
          }
          Cade.haptic && Cade.haptic(30);
          break;
        case 'home':
          say('HOME!', C_ACC, 1.1);
          [659, 784, 988].forEach(function (f, j) { snd.tone(f, 0.1, 'triangle', 0.04, 0, j * 0.07); });
          var hb = g.bays.length ? BAYS[g.bays.reduce(function (m, b, j) { return b.fill ? j : m; }, 0)] : 7;
          burst(hb + 0.5, 12, 10, 2.6, "*+'.", C_ACC, 0, 0.7);
          Cade.haptic && Cade.haptic(10);
          break;
        case 'coin': snd.tone(1320, 0.06, 'sine', 0.035); snd.tone(1760, 0.1, 'sine', 0.03, 0, 0.05); if (g.mode === 'classic') say('BONUS COIN +200', C_GOLD, 1.2, true); break;
        case 'buddy': say('BUDDY ABOARD', C_PINK, 1.1); snd.tone(880, 0.08, 'triangle', 0.035); snd.tone(1175, 0.12, 'triangle', 0.03, 0, 0.07); break;
        case 'rescue': say('RESCUED +200', C_PINK, 1.3, true); break;
        case 'clear':
          say('LEVEL ' + g.level + ' CLEAR +1000', C_GOLD, 2.2, true);
          S.flash = 0.14;
          [523, 659, 784, 1047, 1319].forEach(function (f, j) { snd.tone(f, 0.12, 'square', 0.028, 0, j * 0.09); });
          for (var b = 0; b < BAYS.length; b++) burst(BAYS[b] + 0.5, 12, 6, 3, "*+'.", b % 2 ? C_GOLD : C_ACC, 1, 0.9);
          break;
        case 'level': say('LEVEL ' + g.level, C_ACC, 1.5); say('FASTER!', C_FLAME, 1.0, true); break;
        case 'life': say('EXTRA LIFE', C_LEAF, 1.4, true); [784, 1047, 1568].forEach(function (f, j) { snd.tone(f, 0.09, 'triangle', 0.035, 0, j * 0.06); }); break;
        case 'tick': snd.tone(1000, 0.03, 'square', 0.02); break;
        case 'bell': snd.tone(1250, 0.07, 'square', 0.015); snd.tone(1250, 0.07, 'square', 0.015, 0, 0.18); break;
        case 'train': snd.tone(220, 0.5, 'sawtooth', 0.025, 180); break;
      }
    }
    ev.length = 0;
  }

  // ---- cards ----
  function chipRow(name, opts, cur) {
    return '<div class="rh-chips" role="radiogroup">' + opts.map(function (o) {
      var on = String(o[0]) === String(cur);
      return '<button type="button" class="rh-chip' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on + '" data-set="' + name + '" data-v="' + o[0] + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function recLine(a, b) { return esc(a) + new Array(Math.max(1, 28 - a.length - b.length) + 1).join(' ') + '<b>' + esc(b) + '</b>'; }
  function topTable(k, mode, hl) {
    var T = S.save.tops[k] || [];
    if (!T.length) return '<div class="rh-note">No games yet — go set a record.</div>';
    return '<pre class="rh-tab">' + T.map(function (e, i) {
      var s = (i + 1) + '. ' + fmtInt(e.s), m = (mode === 'endless' ? 'row ' : 'lv ') + e.n + '  ' + (e.d ? e.d.slice(5) : '');
      var line = s + new Array(Math.max(1, 28 - s.length - m.length) + 1).join(' ') + '<i>' + esc(m) + '</i>';
      return i + 1 === hl ? '<span class="g">' + line + '</span>' : line;
    }).join('\n') + '</pre>';
  }
  function homeHtml() {
    var sv = S.save, k = recKey(sv.mode, sv.diff), r = sv.rec[k], h = '';
    h += '<div class="rh-card rh-home">';
    h += '<div class="rh-top"><span class="rh-brand">ROAD HOPPER</span><span class="rh-hi" title="Best score for this mode">' + (r && r.score ? 'HI ' + fmtInt(r.score) : '') + '</span></div>';
    h += '<div class="rh-tabs" role="tablist">' + ['play', 'records'].map(function (tb) {
      return '<button type="button" role="tab" data-tab="' + tb + '" aria-selected="' + (S.tab === tb) + '" class="' + (S.tab === tb ? 'on' : '') + '">' + (tb === 'play' ? 'Play' : 'Records') + '</button>';
    }).join('') + '</div>';
    if (S.tab === 'play') {
      h += '<div class="rh-sec"><div class="rh-h">Mode</div>' + chipRow('mode', [['classic', 'Classic'], ['endless', 'Endless']], sv.mode) +
        '<div class="rh-hint">' + (sv.mode === 'classic' ? 'Fill all five bays to clear a level. Levels speed up.' : 'Endless random lanes — trees, coins, trains. Don&rsquo;t fall behind.') + '</div></div>';
      h += '<div class="rh-sec"><div class="rh-h">Difficulty</div>' + chipRow('diff', DIFF_IDS.map(function (d) { return [d, DIFFS[d].name]; }), sv.diff) +
        '<div class="rh-hint">' + (sv.mode === 'classic' ? DIFFS[sv.diff].lives + ' lives · ' + DIFFS[sv.diff].time + ' s a trip' + (sv.diff === 'hard' ? ' · eels from level 1' : '') : sv.diff === 'easy' ? 'gentle traffic, a slow edge' : sv.diff === 'hard' ? 'fast traffic, a quick edge' : 'the standard pace') + '</div></div>';
      h += '<div class="rh-sec"><div class="rh-h">Players</div>' + chipRow('players', [[1, '1 player'], ['cpu', 'vs CPU'], [2, '2 players']], sv.cpu ? 'cpu' : sv.players) +
        (sv.cpu ? chipRow('cpulv', CPU_IDS.map(function (c) { return [c, CPU_LV[c].name]; }), sv.cpuLv) +
          '<div class="rh-hint">You go first, then the CPU runs the same lanes — best score wins.</div>' :
          sv.players === 2 ? '<div class="rh-hint">Take turns on this device — same lanes, best score wins.</div>' : '') + '</div>';
    } else {
      h += '<div class="rh-sec"><div class="rh-h">Top scores · ' + (sv.mode === 'classic' ? 'Classic' : 'Endless') + ' · ' + DIFFS[sv.diff].name + '</div>' + topTable(k, sv.mode, 0) + '</div>';
      var rows = [];
      ['classic', 'endless'].forEach(function (m) {
        DIFF_IDS.forEach(function (d) {
          var rr = sv.rec[recKey(m, d)];
          if (rr && rr.score) rows.push(recLine((m === 'classic' ? 'Classic ' : 'Endless ') + DIFFS[d].name, fmtInt(rr.score) + (m === 'classic' ? ' lv' + rr.level : ' r' + rr.row)));
        });
      });
      rows.push('<i>' + new Array(29).join('-') + '</i>');
      rows.push(recLine('Games', fmtInt(sv.games)));
      rows.push(recLine('Hops', fmtInt(sv.hops)));
      rows.push(recLine('Hoppers home', fmtInt(sv.homes)));
      rows.push(recLine('Coins (endless)', fmtInt(sv.coins)));
      h += '<div class="rh-sec"><div class="rh-h">Bests</div><pre class="rh-tab">' + rows.join('\n') + '</pre></div>';
      h += '<div class="rh-foot">' + (S.resetArm ?
        '<span class="rh-confirm">Erase all records?</span><span><button type="button" class="rh-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="rh-lnk" data-act="reset-no">Keep</button></span>' :
        '<span></span><button type="button" class="rh-lnk" data-act="reset">Reset records</button>') + '</div>';
    }
    return h + '</div>';
  }
  function helpHtml(first) {
    var keys = S.coarse ?
      '<div><b>swipe</b> &nbsp;on the road to hop that way</div><div><b>tap</b> &nbsp;to hop forward</div><div><b>arrow pad</b> &nbsp;under the field works too</div>' :
      '<div><b>arrows</b> / <b>WASD</b> &nbsp;hop</div><div><b>click</b> / <b>swipe</b> &nbsp;the field to hop</div><div><b>gamepad</b> &nbsp;d-pad, A = forward</div><div><b>P</b> / <b>Esc</b> &nbsp;pause</div>';
    return '<div class="rh-card rh-help">' +
      '<pre class="rh-art" aria-hidden="true">%#[o.o]#%#[ $ ]#%\n~ (=====@) ~ (_)(_)\n .-==-.  ^  _/=\\_\n [o--o>  o.o (o--o)</pre>' +
      '<div class="rh-title">ROAD HOPPER</div>' +
      '<p>Get your hopper <b>o.o</b> across the road and the river into the five bays of the far bank.</p>' +
      '<div class="rh-keys">' + keys + '</div>' +
      '<p class="rh-tip"><b>Roads:</b> don&rsquo;t get flattened. <b>River:</b> you can&rsquo;t swim — ride the logs and lily pads, and watch for pads that <b>sink</b> (they flicker first). Don&rsquo;t drift off the edge.</p>' +
      '<p class="rh-tip"><b>Bays:</b> land squarely in an empty one. A <b class="rh-c-gold">$</b> in a bay is a bonus; <b class="rh-c-red">vvv</b> is an eel — stay out. Carry a lost buddy <b class="rh-c-pink">@</b> home from a log for +200.</p>' +
      '<p class="rh-tip">Each trip has a timer; faster trips score more. Every new row is +10, a home 50 + time, a full bank +1000. Extra life at 10,000.</p>' +
      '<p class="rh-tip"><b>Endless:</b> random lanes forever — grass with trees and coins, roads, rivers and railways (a <b class="rh-c-red">!</b> means a train is coming). The edge creeps up behind you.</p>' +
      '<p class="rh-tip"><b>vs CPU:</b> you run first, then a CPU rival (Rookie, Pro or Ace) runs the very same lanes. <b>2 players:</b> take turns on one device. Best score wins.</p>' +
      (first ? '' : '<button type="button" class="rh-go" data-act="close-help">Back</button>') + '</div>';
  }
  function resultsHtml() {
    var r = S.res, cd = S.card, m = S.match, h = '<div class="rh-card rh-res">';
    if (m && m.n > 1) {
      var a = m.res[0], b = m.res[1], win = a.score === b.score ? 0 : a.score > b.score ? 1 : 2;
      var who = m.cpu ? ['You', 'CPU ' + CPU_LV[m.cpu].name] : ['Player 1', 'Player 2'];
      h += '<div class="rh-title">' + (!win ? 'A DRAW' : m.cpu ? (win === 1 ? 'YOU WIN' : 'CPU WINS') : 'PLAYER ' + win + ' WINS') + '</div>';
      h += '<pre class="rh-tab rh-vs">' + [0, 1].map(function (i) {
        var q = m.res[i], s = who[i], v = fmtInt(q.score) + (q.mode === 'endless' ? ' r' + q.row : ' lv' + q.level);
        var line = recLine(s, v);
        return win === i + 1 ? '<span class="g">' + line + '</span>' : line;
      }).join('\n') + '</pre>';
      h += '<div class="rh-note">' + (win ? 'by ' + fmtInt(Math.abs(a.score - b.score)) + ' points' : 'dead level — rematch?') + '</div>';
      return h + '</div>';
    }
    h += '<div class="rh-title">GAME OVER</div>';
    h += '<div class="rh-big">' + fmtInt(r.score) + '</div>';
    h += cd.best ? '<div class="rh-new">** new best score **</div>' : '<div class="rh-sub">' + esc(CAUSE_LONG[r.cause] || '') + '</div>';
    var rows = [];
    if (r.mode === 'classic') {
      rows.push(recLine('Level reached', String(r.level)));
      rows.push(recLine('Hoppers home', String(r.homes)));
      if (r.bonus) rows.push(recLine('Bonuses', String(r.bonus)));
    } else {
      rows.push(recLine('Rows crossed', String(r.row)));
      rows.push(recLine('Coins', String(r.coins)));
    }
    rows.push(recLine('Hops', fmtInt(r.hops)));
    rows.push(recLine('Time', Math.floor(r.time / 60) + ':' + ('0' + Math.floor(r.time % 60)).slice(-2)));
    h += '<pre class="rh-tab">' + rows.join('\n') + '</pre>';
    if (cd.bestN) h += '<div class="rh-new">new best ' + (r.mode === 'classic' ? 'level' : 'row') + '</div>';
    h += '<div class="rh-h">Top scores · ' + DIFFS[r.diff].name + '</div>' + topTable(recKey(r.mode, r.diff), r.mode, cd.rank);
    return h + '</div>';
  }
  function passHtml() {
    var m = S.match, p = m.res[0];
    if (m.cpu) {
      return '<div class="rh-card rh-pass"><div class="rh-title">YOU: ' + fmtInt(p.score) + '</div>' +
        '<pre class="rh-art" aria-hidden="true">  o.o  vs  [o.o]\n  /_\\      /_\\</pre>' +
        '<div class="rh-big">CPU &middot; ' + esc(CPU_LV[m.cpu].name) + '</div>' +
        '<div class="rh-sub">Now the CPU runs the same lanes. Can it beat ' + fmtInt(p.score) + '?</div>' +
        '<div class="rh-note">Watch it hop, or skip straight to the result</div></div>';
    }
    return '<div class="rh-card rh-pass"><div class="rh-title">PLAYER 1: ' + fmtInt(p.score) + '</div>' +
      '<pre class="rh-art" aria-hidden="true">  o.o  -->  o.o\n  /_\\       /_\\</pre>' +
      '<div class="rh-big">Pass to Player 2</div>' +
      '<div class="rh-sub">Same lanes, same traffic. Beat ' + fmtInt(p.score) + '.</div>' +
      '<div class="rh-note">' + (S.coarse ? 'Tap when ready' : 'Space / click when ready') + '</div></div>';
  }
  function pauseHtml() {
    var g = S.g;
    return '<div class="rh-card rh-pause"><div class="rh-title">PAUSED</div>' +
      '<div class="rh-sub">' + fmtInt(g.score) + ' · ' + (g.mode === 'classic' ? 'level ' + g.level : 'row ' + g.maxRow) + '</div>' +
      '<div class="rh-btns"><button type="button" class="rh-go" data-act="resume">Resume</button><button type="button" class="rh-go alt" data-act="quit">' + (S.cpu ? 'Skip' : 'End game') + '</button></div>' +
      '<div class="rh-note">' + (S.coarse ? 'Tap Resume to carry on' : 'P / Space to resume') + '</div></div>';
  }
  function showCard(kind) {
    if (kind !== 'help') S.helpFrom = null;
    S.cardKind = kind;
    var h = kind === 'home' ? homeHtml() : kind === 'help' ? helpHtml(S.firstRun && !S.helpFrom) : kind === 'results' ? resultsHtml() :
      kind === 'pause' ? pauseHtml() : kind === 'pass' ? passHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.ovl.scrollTop = 0;
    S.stage.classList.toggle('dim', !!kind && kind !== 'home');
    S.stage.classList.toggle('home', kind === 'home');
  }
  function setPad(mode) {
    var h;
    S.padMode = mode;
    if (mode === 'play') {
      h = '<button type="button" class="rh-dir" data-k="3" aria-label="Hop left">' + IC_ARROW[3] + '</button>' +
        '<button type="button" class="rh-dir rh-up" data-k="0" aria-label="Hop forward">' + IC_ARROW[0] + '<span>hop</span></button>' +
        '<button type="button" class="rh-dir" data-k="2" aria-label="Hop back">' + IC_ARROW[2] + '</button>' +
        '<button type="button" class="rh-dir" data-k="1" aria-label="Hop right">' + IC_ARROW[1] + '</button>';
    } else {
      var lab = { go: 'Go!', again: 'Play again', resume: 'Resume', start: 'Let&rsquo;s go!', back: 'Back', p2: 'Player 2 — go!', rematch: 'Rematch',
        cpu: 'Watch the CPU', watch: S.skip ? 'Skipping&hellip;' : 'Skip to the end' }[mode] || 'Go!';
      var act = mode === 'watch' ? 'skip' : mode;
      h = '<button type="button" class="rh-act" data-act="' + act + '"' + (mode === 'watch' && S.skip ? ' disabled' : '') + '>' + lab + (S.coarse ? '' : ' <small>space</small>') + '</button>' +
        (mode === 'again' || mode === 'rematch' ? '<button type="button" class="rh-act alt" data-act="home">Menu</button>' :
          mode === 'cpu' ? '<button type="button" class="rh-act alt" data-act="skip">Skip</button>' : '');
    }
    S.pad.innerHTML = h;
    var was = S.pad.classList.contains('rh-dpad');
    S.pad.classList.toggle('rh-dpad', mode === 'play');
    if (was !== (mode === 'play') && S.coarse && S.col) { layout(); redraw(); }   // the thumb pad is taller: refit the field
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
    var r = S.save.rec[recKey(S.save.mode, S.save.diff)];
    S.cv.setAttribute('aria-label', 'Road Hopper — ' + (r && r.score ? 'best score ' + fmtInt(r.score) + '. ' : '') + 'Arrow keys or WASD to hop; swipe or tap the play field.');
  }

  function demoGame() {
    var g = newGame({ mode: S.save.mode, diff: S.save.diff, seed: 7 });
    for (var i = 0; i < 300; i++) step(g);
    g.events.length = 0; g.pops.length = 0;
    return g;
  }
  function toHome() {
    S.phase = 'home'; S.g = null; S.paused = false; S.resetArm = false; S.match = null;
    S.dg = demoGame();
    clearFx();
    showCard('home'); setPad('go'); syncHead(); syncLabel();
    draw(1);
  }
  function startGame(seed) {
    if (!S) return;
    S.snd.ensure();
    var sv = S.save;
    if (!S.match) S.match = { n: sv.players, cur: 0, res: [], seed: gameSeed(sv), cpu: sv.cpu && sv.players === 2 ? sv.cpuLv : '' };
    S.g = newGame({ mode: sv.mode, diff: sv.diff, seed: seed || S.match.seed });
    S.phase = 'play'; S.paused = false; S.endT = 0; S.clock = 0; S.skip = false;
    S.cpu = S.match.cpu && S.match.cur === 1 ? newCpu(S.match.cpu, S.g.seed) : null;
    clearFx();
    showCard(null); setPad(playPad()); syncHead();
    if (S.match.n > 1) say(S.match.cpu ? (S.cpu ? 'CPU · ' + CPU_LV[S.match.cpu].name.toUpperCase() : 'YOUR RUN') : 'PLAYER ' + (S.match.cur + 1), C_ACC, 1.3);
    say(sv.mode === 'classic' ? 'FILL THE 5 BAYS' : 'HOP FOREVER', C_MUTED, 1.4, S.match.n > 1);
    draw(1);
    kick();
  }
  function endGame() {
    stopLoop();
    var g = S.g, m = S.match;
    S.res = summary(g);
    if (S.cpu) S.card = { best: false, rank: 0, bestN: false };    // the CPU's runs never touch your records
    else { S.card = settle(S.save, S.res, today()); persist(); }
    S.cpu = null; S.skip = false;
    m.res[m.cur] = S.res;
    if (m.n > 1 && m.cur === 0) {
      S.phase = 'pass'; m.cur = 1;
      showCard('pass'); setPad(m.cpu ? 'cpu' : 'p2'); syncHead();
      if (S.liveEl) S.liveEl.textContent = m.cpu ? 'You scored ' + fmtInt(S.res.score) + '. The CPU runs next.' : 'Player 1 scored ' + fmtInt(S.res.score) + '. Pass to player 2.';
      return;
    }
    S.phase = 'results';
    showCard('results'); setPad(m.n > 1 ? 'rematch' : 'again'); syncHead(); syncLabel();
    if (S.liveEl) S.liveEl.textContent = 'Game over: ' + fmtInt(S.res.score) + ' points.';
    if (S.card.best && m.n === 1) [659, 784, 988, 1319].forEach(function (fq, j) { S.snd.tone(fq, 0.12, 'triangle', 0.035, 0, j * 0.08); });
    draw(1);
  }
  function padAction(act) {
    if (!S) return;
    S.snd.ensure();
    act = act || (S.padMode === 'watch' ? 'skip' : S.padMode);
    if (act === 'go' || act === 'start') { S.match = null; if (S.firstRun) S.firstRun = false; startGame(); }
    else if (act === 'again' || act === 'rematch') { S.match = null; startGame(); }
    else if (act === 'p2' || act === 'cpu') startGame(S.match.seed);
    else if (act === 'skip') { if (S.phase === 'pass' && S.match && S.match.cpu) { startGame(S.match.seed); S.skip = true; setPad(playPad()); } else skipCpu(); }
    else if (act === 'resume') resume();
    else if (act === 'home' || act === 'back') toHome();
  }
  function pause() {
    if (!S || S.phase !== 'play' || S.paused) return;
    S.paused = true;
    stopLoop();
    showCard('pause'); setPad('resume'); syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null); setPad(playPad()); syncHead();
    kick();
  }
  var CPU_CAP = 1200;               // a CPU run that just won't end is called after 20 minutes
  // How to play, from any screen; Back returns to the card it covered (a game in play pauses first).
  function openHelp() {
    if (!S || S.cardKind === 'help') return;
    if (S.phase === 'play' && !S.paused) pause();
    var from = S.cardKind || 'home';
    showCard('help');
    S.helpFrom = from;
    S.ovl.innerHTML = helpHtml(false);
  }
  function closeHelp() {
    if (!S || S.cardKind !== 'help') return;
    showCard(S.helpFrom || 'home');
  }
  function playPad() { return S.cpu ? 'watch' : 'play'; }
  function skipCpu() {             // fast-forward the CPU's run to its end
    if (!S || !S.cpu || S.phase !== 'play') return;
    S.skip = true;
    if (S.paused) resume(); else setPad(playPad());
  }
  function quitRun() {
    if (!S || S.phase !== 'play') return;
    if (S.cpu) { skipCpu(); return; }
    S.paused = false;
    var g = S.g;
    if (g.phase === 'play' || g.phase === 'dying' || g.phase === 'clear') { if (!g.cause) g.cause = ''; g.phase = 'over'; }
    endGame();
  }
  function doHop(dir) {
    if (!S || S.phase !== 'play' || S.paused || !S.g || S.cpu) return;   // the CPU's run is hands-off
    S.snd.ensure();
    hop(S.g, dir);
  }

  // ---- input ----
  var KEYDIR = { ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3 };
  var KEY2CODE = { ' ': 'Space', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', p: 'KeyP', enter: 'Enter', escape: 'Escape' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  function readPad() {
    var pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) return pads[i];
    return null;
  }
  function btnOn(p, i) { var b = p.buttons[i]; return !!b && (b.pressed || b.value > 0.5); }
  // Gamepad: d-pad / left stick hop (edge-triggered), A hops forward, Start pauses.
  function pollPad() {
    var gp = S.gp, p = readPad();
    if (!p) { gp.dir = -1; return; }
    var ax = p.axes[0] || 0, ay = p.axes[1] || 0, d = -1;
    if (btnOn(p, 12) || btnOn(p, 0) || ay < -0.6) d = 0;
    else if (btnOn(p, 15) || ax > 0.6) d = 1;
    else if (btnOn(p, 13) || ay > 0.6) d = 2;
    else if (btnOn(p, 14) || ax < -0.6) d = 3;
    if (d >= 0 && d !== gp.dir) doHop(d);
    gp.dir = d;
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
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !S.panel.contains(t)) return;
    var code = keyCode(e);
    if (code === 'Escape') {
      e.preventDefault();
      if (S.phase === 'play' && !S.paused) pause(); else if (S.cardKind === 'help') closeHelp(); else closePanel();
      return;
    }
    if (S.phase === 'play') {
      if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
      if (S.paused) {
        if (code === 'Space' || code === 'Enter') { e.preventDefault(); if (!e.repeat) resume(); }
        else if (KEYDIR[code] != null) e.preventDefault();
        return;
      }
      if (S.cpu) {
        if (KEYDIR[code] != null) e.preventDefault();
        else if (code === 'Space' || code === 'Enter') { e.preventDefault(); if (!e.repeat) skipCpu(); }
        return;
      }
      if (KEYDIR[code] != null) { e.preventDefault(); if (!e.repeat) doHop(KEYDIR[code]); return; }
      if (code === 'Space') { e.preventDefault(); if (!e.repeat) doHop(0); }
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
    var s = Math.min((vw - (phone ? 34 : 48)) / VW, phone ? 1.3 : solo ? 2.4 : 1.4, availH(vw, vh) / VH);
    s = Math.max(0.6, s);
    var cw = Math.floor(VW * s), ch = Math.floor(VH * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--rh-w', cw + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / VW;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    if (S.col) fitFont();
  }
  function redraw() { if (!S) return; if (S.phase === 'play' && !S.paused && S.raf) return; draw(1); }

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
    var body = '<div class="rh"><div class="rh-stage"><canvas class="rh-cv"></canvas><div class="rh-ovl" style="display:none"></div></div>' +
      '<div class="rh-pad"></div><div class="rh-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🚦 Road Hopper', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'rh-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, stage: p.querySelector('.rh-stage'), cv: p.querySelector('.rh-cv'), ovl: p.querySelector('.rh-ovl'),
      pad: p.querySelector('.rh-pad'), liveEl: p.querySelector('.rh-live'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'home', g: null, dg: null, match: null, paused: false, raf: 0, last: 0, endT: 0, clock: 0,
      gp: { dir: -1, start: false, menuA: false }, gpT: 0, ptr: null,
      pal: new Array(NPAL), col: null, atl: null, k: 1, shake: 0, flash: 0,
      msg: null, msgQ: [], tab: 'play', resetArm: false, padMode: '', cardKind: null, res: null, card: null
    };
    makeFx();
    S.ctx = S.cv.getContext('2d');
    S.dg = demoGame();
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

    // header: help / sound / pause
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
      else if (h === 'help') { if (S.cardKind === 'help') closeHelp(); else openHelp(); }
      try { b.blur(); } catch (er) {}
    });

    // Fast tapping must never zoom, select, magnify or open a callout: the play
    // surfaces cancel their touches outright and the panel swallows gestures.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    [S.cv, S.pad].forEach(function (el) {
      el.addEventListener('touchstart', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
      el.addEventListener('touchmove', noTouch, { passive: false });
      el.addEventListener('touchend', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
    });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    // the play field: swipe to hop that way (fires as soon as the finger has
    // travelled far enough), tap to hop forward
    var SWIPE = 16;
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (S.phase !== 'play' || S.paused) { if (S.phase === 'pass' || S.phase === 'results') padAction(); return; }
      try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
      S.ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, done: false };
    });
    S.cv.addEventListener('pointermove', function (e) {
      var q = S && S.ptr;
      if (!q || q.id !== e.pointerId || q.done) return;
      var dx = e.clientX - q.x, dy = e.clientY - q.y;
      if (dx * dx + dy * dy < SWIPE * SWIPE) return;
      q.done = true;
      doHop(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy < 0 ? 0 : 2));
    });
    function ptrEnd(e) {
      var q = S && S.ptr;
      if (!q || q.id !== e.pointerId) return;
      S.ptr = null;
      if (!q.done && e.type === 'pointerup') doHop(0);
    }
    ['pointerup', 'pointercancel'].forEach(function (t) { S.cv.addEventListener(t, ptrEnd); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // the arrow pad hops on press (not on release) — quick taps stay quick
    S.pad.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-k]') : null;
      if (!b || e.button > 0) return;
      e.preventDefault();
      b.classList.add('on');
      setTimeout(function () { b.classList.remove('on'); }, 110);
      doHop(+b.getAttribute('data-k'));
    });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (b && S) padAction(b.getAttribute('data-act'));
    });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) { if (S.cardKind === 'pass') padAction('p2'); return; }
      S.snd.ensure();
      var set = b.getAttribute('data-set'), tab = b.getAttribute('data-tab'), act = b.getAttribute('data-act');
      if (set) {
        var v = b.getAttribute('data-v');
        if (set === 'players') { S.save.cpu = v === 'cpu'; S.save.players = v === '2' || v === 'cpu' ? 2 : 1; }
        else if (set === 'cpulv' && CPU_LV[v]) S.save.cpuLv = v;
        else if (set === 'mode') S.save.mode = v === 'endless' ? 'endless' : 'classic';
        else if (set === 'diff' && DIFFS[v]) S.save.diff = v;
        persist();
        S.snd.tone(988, 0.04, 'sine', 0.03);
        if (set === 'mode' || set === 'diff') { S.dg = demoGame(); draw(1); }
        showCard('home'); syncLabel();
        var nb = e.detail === 0 && S.ovl.querySelector('[data-set="' + set + '"][data-v="' + v + '"]');
        if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
      } else if (tab) {
        S.tab = tab; S.resetArm = false; showCard('home');
        var tb = e.detail === 0 && S.ovl.querySelector('[data-tab="' + tab + '"]');
        if (tb) { try { tb.focus({ preventScroll: true }); } catch (er) {} }
      }
      else if (act === 'reset') { S.resetArm = true; showCard('home'); }
      else if (act === 'reset-no') { S.resetArm = false; showCard('home'); }
      else if (act === 'reset-yes') {
        var keep = S.save;
        S.save = newSave(); S.save.mode = keep.mode; S.save.diff = keep.diff; S.save.players = keep.players; S.save.cpu = keep.cpu; S.save.cpuLv = keep.cpuLv;
        S.save.seed = (Math.random() * 4294967295) >>> 0;
        persist(); S.tab = 'play';
        Cade.showToast && Cade.showToast('Records reset', 'info', 1800);
        toHome();
      } else if (act === 'close-help') closeHelp();
      else if (act === 'resume') resume();
      else if (act === 'quit') quitRun();
    });

    if (S.firstRun) {
      S.phase = 'home';
      S.save.seed = (Math.random() * 4294967295) >>> 0;
      persist();
      showCard('help'); setPad('start'); syncHead(); syncLabel();
      draw(1);
    } else toHome();
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); redraw(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('600 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); redraw(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Hop across busy roads and rivers — classic levels or endless lanes, vs CPU or 2 players',
    icon: '🚦',
    tags: 'game,arcade,fun,road,cross,traffic,river,hop,endless,logs,ascii',
    open: open,
    _engine: ENGINE
  });
})();
