/* Bug Swarm — a segmented-bug shooter for Cade.txt.
 * A long bug winds down through a field of mushrooms, row by row, turning
 * whenever it meets a wall or a mushroom. You are the A in the garden at the
 * bottom: move (mouse, a finger dragged anywhere on the field, arrows / WASD,
 * a gamepad's stick) and shoot (hold the mouse, the field, Space, the FIRE pad
 * or A — or switch on auto-fire). Shoot a segment mid-body and the bug splits
 * in two; every shot segment leaves a mushroom behind. Mushrooms take four
 * hits. Extras: the Skitter (zig-zags through the garden and eats mushrooms;
 * worth more the closer it is when you hit it), the Tick (drops straight down
 * sowing mushrooms when the garden runs bare; two hits) and the Hornet (crosses
 * the upper field and poisons the mushrooms it touches — a bug that runs into a
 * poisoned one dives straight to the bottom). Clear every segment for the next
 * wave: a shorter bug, more loose heads, more speed. Extra life every N points.
 * 1 or 2 players (alternating turns, arcade style, with a hand-off card).
 * Drawn in monospace glyphs (a glyph atlas) on a canvas; a fixed 120 Hz step
 * with an accumulator, rendering interpolated. The loop runs only while a game
 * is on screen; it pauses on blur, tab hide and minimize. Records persist in
 * Cade.store (cade-bugswarm-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // Units: grid cells (x → right, y → down). Cell (c, r) covers [c, c+1) × [r, r+1).
  var STEP = 1 / 120;
  var COLS = 28, ROWS = 31, ZONE = 6, ZONE_TOP = ROWS - ZONE;   // the garden: the bottom six rows
  var MUSH_HP = 4, BUG_LEN = 12;
  var BULLET_V = 60, PLAYER_V = 15, DRAG_V = 42, PR = 0.42;      // cells / s; player half-size
  var GRACE = 1.3, DIE_T = 1.5, RESTORE_DT = 0.07, LIVES_MAX = 9;
  var PTS = { head: 100, body: 10, mush: 1, restore: 5, tick: 200, hornet: 1000, skitter: [900, 600, 300] };
  var DIFFS = {
    easy: { id: 'easy', name: 'Easy', lives: 4, bonus: 10000, v0: 6, dv: 0.35, vmax: 11, tick: 3, tickW: 2, hornetW: 4, skT: [6, 11], skV: 4.2, mush: 30, sideT: 7 },
    normal: { id: 'normal', name: 'Normal', lives: 3, bonus: 12000, v0: 7.5, dv: 0.45, vmax: 13, tick: 5, tickW: 2, hornetW: 3, skT: [4, 9], skV: 5.2, mush: 36, sideT: 5.5 },
    hard: { id: 'hard', name: 'Hard', lives: 3, bonus: 15000, v0: 9, dv: 0.55, vmax: 15, tick: 7, tickW: 1, hornetW: 2, skT: [3, 7], skV: 6.2, mush: 44, sideT: 4 }
  };
  var DIFF_IDS = ['easy', 'normal', 'hard'];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  // Small seeded PRNG (mulberry32) and an integer hash, so a game is reproducible.
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
  function rint(g, n) { return Math.floor(g.r() * n); }
  function idx(c, r) { return r * COLS + c; }
  function inGrid(c, r) { return c >= 0 && c < COLS && r >= 0 && r < ROWS; }

  // ---- a game ----
  function newGame(seed, opts) {
    opts = opts || {};
    var D = DIFFS[opts.diff] || DIFFS.normal;
    var g = {
      seed: seed >>> 0, D: D, r: rng(hash2(seed, 11)), m: new Uint8Array(COLS * ROWS), pz: new Uint8Array(COLS * ROWS),
      wave: 1, score: 0, lives: D.lives, nextLife: D.bonus, phase: 'play', t: 0, acc: 0, steps: 0, grace: GRACE, timer: 0, ri: 0,
      p: { x: COLS / 2, y: ROWS - 0.5, ox: COLS / 2, oy: ROWS - 0.5 },
      b: { on: false, x: 0, y: 0, ox: 0, oy: 0 },
      bugs: [], foes: [], bottom: false, sideT: D.sideT, sideN: 0,
      skT: D.skT[0] + 2, tickT: 2, hornetT: 12, deadAt: null,
      ev: [], st: { shots: 0, hits: 0, segs: 0, heads: 0, skitters: 0, ticks: 0, hornets: 0, mush: 0 }
    };
    var n = D.mush, guard = 0;
    while (n > 0 && guard++ < 5000) {
      var c = rint(g, COLS), r = 1 + rint(g, ROWS - 2);
      if (r >= ZONE_TOP && g.r() < 0.55) continue;                     // a sparser garden
      if (r >= ROWS - 3 && Math.abs(c + 0.5 - COLS / 2) < 3) continue;  // the start stays clear
      var k = idx(c, r);
      if (g.m[k]) continue;
      g.m[k] = MUSH_HP; n--;
    }
    spawnWave(g);
    return g;
  }
  function bugSpeed(g) { return Math.min(g.D.vmax, g.D.v0 + g.D.dv * (g.wave - 1)); }
  function mkSeg(c, r, d) { return { c: c, r: r, pc: c, pr: r - 1, d: d, vdir: 1, poison: false, x: c, y: r - 1, ox: c, oy: r - 1 }; }
  // A bug of `len` segments entering from above at column c: the head at row `r0`, the body stacked above it.
  function addBug(g, len, c, d, r0) {
    var segs = [];
    for (var i = 0; i < len; i++) segs.push(mkSeg(c, r0 - i, d));
    g.bugs.push({ segs: segs, t: 0, v: bugSpeed(g) });
  }
  function spawnWave(g) {
    var heads = Math.min(6, g.wave - 1), main = BUG_LEN - heads;
    g.bugs = [];
    addBug(g, main, 6 + rint(g, COLS - 12), g.r() < 0.5 ? -1 : 1, 0);
    for (var i = 0; i < heads; i++) addBug(g, 1, 1 + rint(g, COLS - 2), g.r() < 0.5 ? -1 : 1, -2 - i * 2);
    g.bottom = false; g.sideN = 0; g.sideT = g.D.sideT;
  }
  function segCount(g) { var n = 0; for (var i = 0; i < g.bugs.length; i++) n += g.bugs[i].segs.length; return n; }

  // One segment arrives at its cell and picks the next: sideways if it can, else a row down (or up, in the garden) and turn around.
  function decide(g, s) {
    s.pc = s.c; s.pr = s.r;
    if (s.r < 0) { s.r++; return; }                                   // still entering from above
    if (s.poison) {
      if (s.r < ROWS - 1) { s.r++; return; }
      s.poison = false; s.vdir = -1;
    }
    var nc = s.c + s.d;
    if (s.c < 0 || s.c >= COLS) { s.c = nc; return; }                  // a loose head walking in from the side
    if (nc >= 0 && nc < COLS) {
      var k = idx(nc, s.r);
      if (!g.m[k]) { s.c = nc; return; }
      if (g.pz[k] && s.r < ROWS - 1) { s.poison = true; s.d = -s.d; s.r++; s.vdir = 1; return; }
    }
    var nr = s.r + s.vdir;
    if (nr > ROWS - 1) { s.vdir = -1; nr = s.r - 1; }
    else if (s.vdir < 0 && nr < ZONE_TOP) { s.vdir = 1; nr = s.r + 1; }
    s.r = nr; s.d = -s.d;
  }
  function follow(s, a) { s.pc = s.c; s.pr = s.r; s.c = a.c; s.r = a.r; s.d = a.d; s.vdir = a.vdir; s.poison = a.poison; }
  function stepBugs(g, dt) {
    for (var b = 0; b < g.bugs.length; b++) {
      var bug = g.bugs[b], segs = bug.segs, i, s;
      bug.t += bug.v * dt;
      while (bug.t >= 1) {
        bug.t -= 1;
        // the head picks its next cell; every body segment steps into the cell the one ahead of it held,
        // so the body always traces the head's path (even when a mushroom appears or goes behind the head)
        for (i = segs.length - 1; i >= 1; i--) follow(segs[i], segs[i - 1]);
        decide(g, segs[0]);
        for (i = 0; i < segs.length; i++) if (segs[i].r === ROWS - 1 && !g.bottom) g.bottom = true;
      }
      for (i = 0; i < segs.length; i++) { s = segs[i]; s.x = s.pc + (s.c - s.pc) * bug.t; s.y = s.pr + (s.r - s.pr) * bug.t; }
    }
  }

  // ---- extras ----
  function addFoe(g, k, x, y, vx, vy, hw, hh, hp) {
    var f = { k: k, x: x, y: y, ox: x, oy: y, vx: vx, vy: vy, hw: hw, hh: hh, hp: hp || 1, t: 0, cell: -1, row: -99, inside: false, dir: vx < 0 ? -1 : 1 };
    g.foes.push(f);
    g.ev.push({ k: k + 'In', x: x, y: y });
    return f;
  }
  function hasFoe(g, k) { for (var i = 0; i < g.foes.length; i++) if (g.foes[i].k === k) return true; return false; }
  function gardenMush(g) {
    var n = 0;
    for (var r = ZONE_TOP; r < ROWS; r++) for (var c = 0; c < COLS; c++) if (g.m[idx(c, r)]) n++;
    return n;
  }
  function nearPlayer(g, c, r) { return Math.abs(c + 0.5 - g.p.x) < 1.4 && Math.abs(r + 0.5 - g.p.y) < 1.4; }
  function spawners(g, dt) {
    var D = g.D;
    if (!hasFoe(g, 'skitter') && (g.skT -= dt) <= 0) {
      var left = g.r() < 0.5;
      addFoe(g, 'skitter', left ? -1.2 : COLS + 1.2, ZONE_TOP - 1 + g.r() * 3, (left ? 1 : -1) * D.skV, D.skV * 1.3, 0.95, 0.5);
      g.skT = D.skT[0] + g.r() * (D.skT[1] - D.skT[0]);
    }
    if (g.wave >= D.tickW && !hasFoe(g, 'tick') && gardenMush(g) < D.tick && (g.tickT -= dt) <= 0) {
      addFoe(g, 'tick', rint(g, COLS) + 0.5, -0.5, 0, 9 + Math.min(6, g.wave), 0.45, 0.5, 2);
      g.tickT = 1.5 + g.r() * 2.5;
    }
    if (g.wave >= D.hornetW && !hasFoe(g, 'hornet') && (g.hornetT -= dt) <= 0) {
      var l2 = g.r() < 0.5;
      addFoe(g, 'hornet', l2 ? -1.5 : COLS + 1.5, 3.5 + rint(g, ZONE_TOP - 9), (l2 ? 1 : -1) * (4 + g.r() * 3), 0, 1.1, 0.45);
      g.hornetT = 9 + g.r() * 10;
    }
    if (g.bottom && g.sideN < 6 && (g.sideT -= dt) <= 0) {           // loose heads join from the sides once the bug reaches the bottom
      var l3 = g.r() < 0.5, s = mkSeg(l3 ? -1 : COLS, ZONE_TOP + rint(g, 3), l3 ? 1 : -1);
      s.pr = s.r; s.y = s.r; s.oy = s.r; s.pc = s.c - s.d; s.x = s.pc; s.ox = s.pc;
      g.bugs.push({ segs: [s], t: 0, v: bugSpeed(g) });
      g.sideN++; g.sideT = Math.max(2, D.sideT - g.wave * 0.3);
      g.ev.push({ k: 'sideIn', x: s.c, y: s.r });
    }
  }
  function stepFoes(g, dt) {
    for (var i = g.foes.length - 1; i >= 0; i--) {
      var f = g.foes[i], c, r, k;
      f.t += dt;
      if (f.k === 'skitter') {
        if ((f.turn = (f.turn || 0) - dt) <= 0) {                        // a new leg of the zig-zag
          f.turn = 0.3 + g.r() * 0.7;
          var sp = g.D.skV;
          f.vx = g.r() < 0.25 ? 0 : f.dir * sp * (0.7 + g.r() * 0.6);
          f.vy = (g.r() < 0.5 ? -1 : 1) * sp * (1.1 + g.r() * 0.7);
        }
        f.x += f.vx * dt; f.y += f.vy * dt;
        if (f.y < ZONE_TOP - 2.5) { f.y = ZONE_TOP - 2.5; f.vy = Math.abs(f.vy); }
        if (f.y > ROWS - 0.5) { f.y = ROWS - 0.5; f.vy = -Math.abs(f.vy); }
        if (f.x > 0 && f.x < COLS) f.inside = true;
        c = Math.floor(f.x); r = Math.floor(f.y); k = inGrid(c, r) ? idx(c, r) : -1;
        if (k >= 0 && k !== f.cell) {
          f.cell = k;
          if (g.m[k] && g.r() < 0.4) { g.m[k] = 0; g.pz[k] = 0; g.ev.push({ k: 'eat', x: c + 0.5, y: r + 0.5 }); }
        }
        if (f.inside && (f.x < -1.6 || f.x > COLS + 1.6)) g.foes.splice(i, 1);
      } else if (f.k === 'tick') {
        f.y += f.vy * dt;
        r = Math.floor(f.y); c = Math.floor(f.x);
        if (r !== f.row) {
          f.row = r;
          if (r >= 1 && r <= ROWS - 2 && !g.m[idx(c, r)] && !nearPlayer(g, c, r) && g.r() < 0.3) { g.m[idx(c, r)] = MUSH_HP; g.pz[idx(c, r)] = 0; }
        }
        if (f.y > ROWS + 1) g.foes.splice(i, 1);
      } else if (f.k === 'hornet') {
        f.x += f.vx * dt;
        c = Math.floor(f.x); r = Math.floor(f.y);
        if (inGrid(c, r) && idx(c, r) !== f.cell) {
          f.cell = idx(c, r);
          if (g.m[f.cell] && !g.pz[f.cell]) { g.pz[f.cell] = 1; g.ev.push({ k: 'poison', x: c + 0.5, y: r + 0.5 }); }
        }
        if (f.x > 0 && f.x < COLS) f.inside = true;
        if (f.inside && (f.x < -2 || f.x > COLS + 2)) g.foes.splice(i, 1);
      }
    }
  }

  // ---- scoring, the shot ----
  function addScore(g, v) {
    g.score += v;
    while (g.score >= g.nextLife) {
      g.nextLife += g.D.bonus;
      if (g.lives < LIVES_MAX) { g.lives++; g.ev.push({ k: 'life' }); }
    }
    return v;
  }
  function hitAt(g, x, y) {
    var i, j, f;
    for (i = 0; i < g.foes.length; i++) {
      f = g.foes[i];
      if (Math.abs(f.x - x) < f.hw && Math.abs(f.y - y) < f.hh + 0.2) { hitFoe(g, i); return true; }
    }
    for (i = 0; i < g.bugs.length; i++) {
      var segs = g.bugs[i].segs;
      for (j = 0; j < segs.length; j++) {
        var s = segs[j];
        if (Math.abs(s.x + 0.5 - x) < 0.5 && Math.abs(s.y + 0.5 - y) < 0.55) { hitSeg(g, i, j); return true; }
      }
    }
    var c = Math.floor(x), r = Math.floor(y);
    if (inGrid(c, r) && g.m[idx(c, r)]) { hitMush(g, c, r); return true; }
    return false;
  }
  function hitMush(g, c, r) {
    var k = idx(c, r);
    g.m[k]--;
    if (!g.m[k]) { g.pz[k] = 0; g.st.mush++; addScore(g, PTS.mush); g.ev.push({ k: 'mushGone', x: c + 0.5, y: r + 0.5 }); }
    else g.ev.push({ k: 'mushHit', x: c + 0.5, y: r + 0.5 });
  }
  function hitSeg(g, bi, si) {
    var bug = g.bugs[bi], s = bug.segs[si], head = si === 0, pts = head ? PTS.head : PTS.body;
    addScore(g, pts);
    g.st.hits++; g.st.segs++; if (head) g.st.heads++;
    g.ev.push({ k: 'kill', x: s.x + 0.5, y: s.y + 0.5, head: head, pts: pts });
    // a mushroom where it was headed (the cell it was walking into)
    if (inGrid(s.c, s.r) && !nearPlayer(g, s.c, s.r)) { g.m[idx(s.c, s.r)] = MUSH_HP; g.pz[idx(s.c, s.r)] = 0; }
    var tail = bug.segs.slice(si + 1);
    bug.segs = bug.segs.slice(0, si);
    if (!bug.segs.length) g.bugs.splice(bi, 1);
    if (tail.length) {
      g.bugs.push({ segs: tail, t: bug.t, v: bug.v });
      if (bug.segs.length) g.ev.push({ k: 'split', x: tail[0].x + 0.5, y: tail[0].y + 0.5 });
    }
  }
  function hitFoe(g, i) {
    var f = g.foes[i], pts = 0;
    g.st.hits++;
    if (f.k === 'tick' && --f.hp > 0) { f.vy *= 2; g.ev.push({ k: 'tickHit', x: f.x, y: f.y }); return; }
    if (f.k === 'skitter') {
      var dy = Math.abs(f.y - g.p.y);
      pts = dy < 2.5 ? PTS.skitter[0] : dy < 4.5 ? PTS.skitter[1] : PTS.skitter[2];
      g.st.skitters++;
    } else if (f.k === 'tick') { pts = PTS.tick; g.st.ticks++; }
    else { pts = PTS.hornet; g.st.hornets++; }
    addScore(g, pts);
    g.foes.splice(i, 1);
    g.ev.push({ k: f.k, x: f.x, y: f.y, pts: pts });
  }

  // ---- the player ----
  function overlapCells(x, y, out) {
    out.length = 0;
    var c0 = Math.floor(x - PR), c1 = Math.floor(x + PR - 1e-9), r0 = Math.floor(y - PR), r1 = Math.floor(y + PR - 1e-9);
    for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) if (inGrid(c, r)) out.push(idx(c, r));
    return out;
  }
  var OV0 = [], OV1 = [];
  // Move along one axis; a mushroom the player did not already overlap stops it flush against its side.
  function moveAxis(g, mx, my) {
    var p = g.p;
    if (!mx && !my) return;
    overlapCells(p.x, p.y, OV0);
    var nx = clamp(p.x + mx, PR, COLS - PR), ny = clamp(p.y + my, ZONE_TOP + PR, ROWS - PR);
    overlapCells(nx, ny, OV1);
    for (var i = 0; i < OV1.length; i++) {
      var k = OV1[i];
      if (!g.m[k] || OV0.indexOf(k) >= 0) continue;
      var c = k % COLS, r = (k - c) / COLS;
      if (mx > 0) nx = Math.min(nx, c - PR - 1e-6);
      else if (mx < 0) nx = Math.max(nx, c + 1 + PR + 1e-6);
      if (my > 0) ny = Math.min(ny, r - PR - 1e-6);
      else if (my < 0) ny = Math.max(ny, r + 1 + PR + 1e-6);
    }
    if (mx) p.x = (mx > 0 ? Math.max(p.x, nx) : Math.min(p.x, nx));
    if (my) p.y = (my > 0 ? Math.max(p.y, ny) : Math.min(p.y, ny));
  }
  function movePlayer(g, inp, dt) {
    var p = g.p, mx, my;
    if (inp && inp.tx != null) {
      var dx = clamp(inp.tx, PR, COLS - PR) - p.x, dy = clamp(inp.ty, ZONE_TOP + PR, ROWS - PR) - p.y, d = Math.sqrt(dx * dx + dy * dy), mv = DRAG_V * dt;
      if (d > mv) { dx *= mv / d; dy *= mv / d; }
      mx = dx; my = dy;
    } else {
      mx = clamp(inp ? inp.ax || 0 : 0, -1, 1) * PLAYER_V * dt;
      my = clamp(inp ? inp.ay || 0 : 0, -1, 1) * PLAYER_V * 0.85 * dt;
    }
    moveAxis(g, mx, 0);
    moveAxis(g, 0, my);
  }
  function caught(g) {
    var p = g.p, i, j;
    for (i = 0; i < g.bugs.length; i++) {
      var segs = g.bugs[i].segs;
      for (j = 0; j < segs.length; j++) if (Math.abs(segs[j].x + 0.5 - p.x) < 0.78 && Math.abs(segs[j].y + 0.5 - p.y) < 0.74) return true;
    }
    for (i = 0; i < g.foes.length; i++) {
      var f = g.foes[i];
      if (Math.abs(f.x - p.x) < f.hw + 0.3 && Math.abs(f.y - p.y) < f.hh + 0.3) return true;
    }
    return false;
  }
  function die(g) {
    g.phase = 'dying'; g.timer = DIE_T; g.lives--; g.b.on = false;
    g.deadAt = { x: g.p.x, y: g.p.y };
    g.ev.push({ k: 'die', x: g.p.x, y: g.p.y });
  }

  // ---- one fixed step ----
  function snap(g) {
    var i, j;
    g.p.ox = g.p.x; g.p.oy = g.p.y; g.b.ox = g.b.x; g.b.oy = g.b.y;
    for (i = 0; i < g.bugs.length; i++) for (j = 0; j < g.bugs[i].segs.length; j++) { var s = g.bugs[i].segs[j]; s.ox = s.x; s.oy = s.y; }
    for (i = 0; i < g.foes.length; i++) { g.foes[i].ox = g.foes[i].x; g.foes[i].oy = g.foes[i].y; }
  }
  function step(g, inp) {
    var dt = STEP;
    snap(g);
    g.t += dt; g.steps++;
    if (g.phase === 'dying') {
      if ((g.timer -= dt) <= 0) { g.phase = 'restore'; g.timer = 0.25; g.ri = 0; }
      return;
    }
    if (g.phase === 'restore') {                         // damaged and poisoned mushrooms grow back, 5 points each
      if ((g.timer -= dt) > 0) return;
      while (g.ri < COLS * ROWS && !((g.m[g.ri] && g.m[g.ri] < MUSH_HP) || g.pz[g.ri])) g.ri++;
      if (g.ri < COLS * ROWS) {
        g.m[g.ri] = MUSH_HP; g.pz[g.ri] = 0;
        addScore(g, PTS.restore);
        g.ev.push({ k: 'restore', x: g.ri % COLS + 0.5, y: Math.floor(g.ri / COLS) + 0.5 });
        g.ri++; g.timer = RESTORE_DT;
      } else {
        g.phase = g.lives > 0 ? 'down' : 'over';
        g.ev.push({ k: g.phase });
      }
      return;
    }
    if (g.phase !== 'play') return;
    movePlayer(g, inp, dt);
    // the shot: one in the air at a time, in two sub-steps so nothing is skipped
    var b = g.b;
    if (inp && inp.fire && !b.on) {
      b.on = true; b.x = g.p.x; b.y = g.p.y - 0.5; b.ox = b.x; b.oy = b.y;
      g.st.shots++; g.ev.push({ k: 'shot' });
    }
    if (g.grace > 0) g.grace -= dt;
    else { stepBugs(g, dt); stepFoes(g, dt); spawners(g, dt); }
    if (b.on) {
      for (var sub = 0; sub < 2 && b.on; sub++) {
        b.y -= BULLET_V * dt / 2;
        if (b.y < 0) b.on = false;
        else if (hitAt(g, b.x, b.y)) b.on = false;
      }
    }
    if (caught(g)) { die(g); return; }
    if (!g.bugs.length) {
      g.wave++;
      spawnWave(g);
      g.grace = 0.8;
      g.ev.push({ k: 'wave', w: g.wave });
    }
  }
  // Run the fixed steps for a frame of dt seconds; returns the interpolation alpha.
  function advance(g, dt, inp) {
    g.acc += Math.min(dt, 0.1);
    var n = 0;
    while (g.acc >= STEP && n < 24) { step(g, inp); g.acc -= STEP; n++; }
    if (n >= 24) g.acc = 0;
    return g.acc / STEP;
  }
  // Back in play after a lost life: the bug comes again from the top with the segments that were left.
  function respawn(g) {
    if (g.phase !== 'down') return false;
    var N = segCount(g), B = g.bugs.length;
    g.bugs = []; g.foes = [];
    if (N > 0) {
      addBug(g, N - (B - 1), 6 + rint(g, COLS - 12), g.r() < 0.5 ? -1 : 1, 0);
      for (var i = 1; i < B; i++) addBug(g, 1, 1 + rint(g, COLS - 2), g.r() < 0.5 ? -1 : 1, -2 * i);
    } else spawnWave(g);
    g.bottom = false; g.sideN = 0; g.sideT = g.D.sideT; g.skT = g.D.skT[0] + 1; g.tickT = 2; g.hornetT = 10;
    g.p.x = g.p.ox = COLS / 2; g.p.y = g.p.oy = ROWS - 0.5;
    for (var r = ROWS - 2; r < ROWS; r++) for (var c = COLS / 2 - 1; c <= COLS / 2; c++) { g.m[idx(c, r)] = 0; g.pz[idx(c, r)] = 0; }
    g.b.on = false; g.grace = GRACE; g.phase = 'play'; g.deadAt = null;
    return true;
  }

  // A simple pilot: sit under the lowest segment, dodge whatever comes close. Used by the tests.
  function autopilot(g) {
    var p = g.p, best = null, tx = p.x, i, j;
    for (i = 0; i < g.bugs.length; i++) for (j = 0; j < g.bugs[i].segs.length; j++) {
      var s = g.bugs[i].segs[j];
      if (s.y >= 0 && (!best || s.y > best.y)) best = s;
    }
    if (best) tx = best.x + 0.5 + best.d * 0.6;
    var ty = ROWS - 0.5;
    var threats = [];
    for (i = 0; i < g.bugs.length; i++) for (j = 0; j < g.bugs[i].segs.length; j++) threats.push({ x: g.bugs[i].segs[j].x + 0.5, y: g.bugs[i].segs[j].y + 0.5 });
    for (i = 0; i < g.foes.length; i++) threats.push(g.foes[i]);
    for (i = 0; i < threats.length; i++) {
      var t = threats[i];
      if (Math.abs(t.y - p.y) < 3.2 && Math.abs(t.x - p.x) < 3.5) { tx = p.x + (p.x < t.x ? -4 : 4); if (tx < 1) tx = p.x + 4; if (tx > COLS - 1) tx = p.x - 4; ty = t.y > p.y ? ZONE_TOP + 1 : ROWS - 0.5; break; }
    }
    return { ax: 0, ay: 0, tx: clamp(tx, PR, COLS - PR), ty: ty, fire: true };
  }

  function summary(g) {
    return {
      score: g.score, wave: g.wave, diff: g.D.id, segs: g.st.segs, heads: g.st.heads, skitters: g.st.skitters, ticks: g.st.ticks,
      hornets: g.st.hornets, mush: g.st.mush, shots: g.st.shots, acc: g.st.shots ? Math.round(100 * g.st.hits / g.st.shots) : 0, time: g.t
    };
  }

  // ---- the save: settings, a high-score table, totals ----
  var TABLE_N = 10;
  function newSave() {
    return { v: 1, diff: 'normal', players: 1, auto: false, table: [], best: { easy: 0, normal: 0, hard: 0 }, games: 0, waves: 0, segs: 0, wave: 0 };
  }
  function num(v, lo, hi) { v = +v; return isFinite(v) ? clamp(Math.floor(v), lo, hi) : lo; }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    if (DIFFS[o.diff]) s.diff = o.diff;
    s.players = o.players === 2 ? 2 : 1;
    s.auto = !!o.auto;
    if (o.best && typeof o.best === 'object') DIFF_IDS.forEach(function (d) { s.best[d] = num(o.best[d], 0, 1e9); });
    s.games = num(o.games, 0, 1e9); s.waves = num(o.waves, 0, 1e9); s.segs = num(o.segs, 0, 1e9); s.wave = num(o.wave, 0, 1e6);
    if (Array.isArray(o.table)) {
      o.table.forEach(function (e) {
        if (!e || typeof e !== 'object' || !DIFFS[e.d]) return;
        s.table.push({ s: num(e.s, 0, 1e9), w: num(e.w, 1, 1e6), d: e.d, t: typeof e.t === 'string' ? e.t.slice(0, 10) : '', p: typeof e.p === 'string' ? e.p.slice(0, 3) : '' });
      });
      s.table.sort(function (a, b) { return b.s - a.s; });
      s.table.length = Math.min(s.table.length, TABLE_N);
    }
    return s;
  }
  // File a finished game: returns { rank (1-based, 0 if off the table), best (a new best for its difficulty) }.
  function record(save, res, tag, date) {
    var out = { rank: 0, best: false };
    save.games++; save.waves += Math.max(0, res.wave - 1); save.segs += res.segs; save.wave = Math.max(save.wave, res.wave);
    if (res.score > (save.best[res.diff] || 0)) { save.best[res.diff] = res.score; out.best = true; }
    if (res.score <= 0) return out;
    var e = { s: res.score, w: res.wave, d: res.diff, t: date || '', p: tag || '' }, i = 0;
    while (i < save.table.length && save.table[i].s >= e.s) i++;
    if (i < TABLE_N) { save.table.splice(i, 0, e); save.table.length = Math.min(save.table.length, TABLE_N); out.rank = i + 1; }
    return out;
  }

  var ENGINE = {
    STEP: STEP, COLS: COLS, ROWS: ROWS, ZONE: ZONE, ZONE_TOP: ZONE_TOP, MUSH_HP: MUSH_HP, BUG_LEN: BUG_LEN, PTS: PTS, DIFFS: DIFFS, DIFF_IDS: DIFF_IDS,
    BULLET_V: BULLET_V, PR: PR, TABLE_N: TABLE_N,
    rng: rng, hash2: hash2, idx: idx, newGame: newGame, spawnWave: spawnWave, addBug: addBug, mkSeg: mkSeg, decide: decide, stepBugs: stepBugs,
    addFoe: addFoe, stepFoes: stepFoes, hitAt: hitAt, hitSeg: hitSeg, hitMush: hitMush, hitFoe: hitFoe, addScore: addScore, movePlayer: movePlayer,
    caught: caught, die: die, step: step, advance: advance, respawn: respawn, autopilot: autopilot, summary: summary, segCount: segCount,
    gardenMush: gardenMush, bugSpeed: bugSpeed, newSave: newSave, normSave: normSave, record: record
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('bugswarm.css');

  var PANEL_ID = 'bugswarm-panel', NAME = 'Bug Swarm';
  var KEY = 'cade-bugswarm-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var CELL = 12, HUD_H = 28, TOP = HUD_H + 4, CW = 8, VW = COLS * CELL, VH = TOP + ROWS * CELL + 2;
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.bugswarm = { live: function () { return S; } };   // test-only peek

  // palette slots, filled from the theme
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOLD = 4, C_RED = 5, C_ICE = 6, C_FLAME = 7, C_LEAF = 8, C_VIOLET = 9,
    C_POISON = 10, C_GRID = 11, NPAL = 12;
  // per wave: [mushroom, bug]
  var WAVE_COL = [[C_LEAF, C_FLAME], [C_GOLD, C_VIOLET], [C_ICE, C_LEAF], [C_VIOLET, C_GOLD], [C_FLAME, C_ICE], [C_RED, C_LEAF]];
  var CH_MUSH = 0x2663, CH_HEAD = 64, CH_BODY = 111, CH_PLAYER = 65;   // ♣ @ o A

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
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.006);
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
    P[C_TEXT] = css(tx); P[C_MUTED] = css(mu); P[C_FAINT] = css(fa); P[C_ACC] = css(ac);
    P[C_GOLD] = dark ? '#f2c544' : '#b07d06'; P[C_RED] = dark ? '#f06a6a' : '#cf3f3f';
    P[C_ICE] = dark ? '#7cc7f2' : '#2878b5'; P[C_FLAME] = dark ? '#ff8f3f' : '#e2611f';
    P[C_LEAF] = dark ? '#7ed37a' : '#2f8f3a'; P[C_VIOLET] = dark ? '#b79cf5' : '#7351c4';
    P[C_POISON] = dark ? '#f472d0' : '#b0249a'; P[C_GRID] = css(mix(bg, tx, dark ? 0.16 : 0.12));
    S.col = {
      bg: css(bg), hud: css(mix(bg, tx, dark ? 0.06 : 0.04)), zone: css(mix(bg, ac, dark ? 0.08 : 0.06)), line: css(mix(bg, ac, dark ? 0.35 : 0.3)),
      font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace', flash: dark ? '255,255,255' : '255,255,255'
    };
    fitFont();
  }

  // ---- glyph rendering: each (colour, character) pair is drawn once into an atlas and stamped ----
  var AT_COLS = 20, AT_ROWS = 16;
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '700 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = Math.min(15, CW / adv);
    S.fnt = '700 ' + S.fpx.toFixed(3) + 'px ' + f;
    buildAtlas();
  }
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.k || !S.col) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    a.sc = 2;
    a.cwp = Math.ceil(16 * S.k * a.sc); a.chp = Math.ceil(18 * S.k * a.sc);
    a.cv.width = a.cwp * AT_COLS; a.cv.height = a.chp * AT_ROWS;
    a.c = a.cv.getContext('2d');
    a.c.font = '700 ' + (S.fpx * S.k * a.sc).toFixed(3) + 'px ' + S.col.font;
    a.c.textAlign = 'center'; a.c.textBaseline = 'middle';
    a.cw = a.cwp / S.k / a.sc; a.ch = a.chp / S.k / a.sc; a.n = 0; a.max = AT_COLS * AT_ROWS;
    S.gmap = [];
    for (var i = 0; i < NPAL; i++) S.gmap.push({});
  }
  function gIdx(ci, code) {
    var m = S.gmap[ci], i = m[code], a = S.atl;
    if (i !== undefined) return i;
    if (a.n >= a.max) return -1;
    i = a.n++;
    a.c.fillStyle = S.pal[ci];
    a.c.fillText(String.fromCharCode(code), (i % AT_COLS) * a.cwp + a.cwp / 2, ((i / AT_COLS) | 0) * a.chp + a.chp / 2);
    m[code] = i;
    return i;
  }
  // One glyph centred on (x, y); `sc` scales it; `cut` (0..1) keeps only the top part (a nibbled mushroom).
  function glyph(c, ci, code, x, y, sc, cut) {
    if (code === 32) return;
    var i = gIdx(ci, code), a = S.atl;
    if (i < 0) {
      c.font = S.fnt; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = S.pal[ci];
      c.fillText(String.fromCharCode(code), x, y);
      return;
    }
    var w = sc ? a.cw * sc : a.cw, h = sc ? a.ch * sc : a.ch, dx = Math.round((x - w / 2) * S.k) / S.k, dy = Math.round((y - h / 2) * S.k) / S.k;
    var sx = (i % AT_COLS) * a.cwp, sy = ((i / AT_COLS) | 0) * a.chp;
    if (cut && cut < 1) {
      var top = 0.2, keep = top + (1 - top) * cut * 0.8;   // the glyph's cell has some air above it
      c.drawImage(a.cv, sx, sy, a.cwp, a.chp * keep, dx, dy, w, h * keep);
    } else c.drawImage(a.cv, sx, sy, a.cwp, a.chp, dx, dy, w, h);
  }
  function drawStr(c, ci, s, x, y, align, sc) {
    var n = s.length, cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, s.charCodeAt(i), x0 + i * cw + cw / 2, y, sc);
    return x0 + n * cw;
  }
  function pad6(n) { var s = String(Math.max(0, Math.floor(n))); while (s.length < 6) s = '0' + s; return s; }

  // ---- particles and pop-ups (logical px), pools allocated once ----
  var NPART = 90, NPOP = 10;
  function makeFx() {
    S.parts = [];
    for (var i = 0; i < NPART; i++) S.parts.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, code: 46, ci: 0, g: 0 });
    S.pops = [];
    for (i = 0; i < NPOP; i++) S.pops.push({ on: false, x: 0, y: 0, t: 0, s: '', ci: C_GOLD });
    S.pi = 0; S.qi = 0;
  }
  function clearFx() {
    for (var i = 0; i < NPART; i++) S.parts[i].on = false;
    for (i = 0; i < NPOP; i++) S.pops[i].on = false;
  }
  function spark(x, y, vx, vy, life, code, ci, g) {
    var p = S.parts[S.pi]; S.pi = (S.pi + 1) % NPART;
    p.on = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.t = 0; p.life = life; p.code = code; p.ci = ci; p.g = g || 0;
  }
  function burst(x, y, n, sp, codes, ci, g, life) {
    if (S.rm) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = sp * (0.35 + Math.random() * 0.65);
      spark(x, y, Math.cos(a) * v, Math.sin(a) * v, life * (0.6 + Math.random() * 0.5), codes.charCodeAt(i % codes.length), Array.isArray(ci) ? ci[i % ci.length] : ci, g);
    }
  }
  function popup(x, y, s, ci) {
    var p = S.pops[S.qi]; S.qi = (S.qi + 1) % NPOP;
    p.on = true; p.x = x; p.y = y; p.t = 0; p.s = s; p.ci = ci;
  }
  function stepFx(dt) {
    var i, p;
    for (i = 0; i < NPART; i++) {
      p = S.parts[i];
      if (!p.on) continue;
      p.t += dt;
      if (p.t >= p.life) { p.on = false; continue; }
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (i = 0; i < NPOP; i++) { p = S.pops[i]; if (p.on && (p.t += dt) > 1) p.on = false; }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt);
    if (S.flash > 0) S.flash = Math.max(0, S.flash - dt);
    if (S.msg && (S.msg.t += dt) > S.msg.dur) S.msg = S.msgQ.length ? S.msgQ.shift() : null;
  }
  function say(text, ci, dur, queue) {
    var m = { text: text, ci: ci == null ? C_TEXT : ci, t: 0, dur: dur || 1.2 };
    if (queue && S.msg && S.msgQ.length < 3) S.msgQ.push(m); else { S.msg = m; S.msgQ.length = 0; }
  }
  function PX(x) { return x * CELL; }
  function PY(y) { return TOP + y * CELL; }

  function curGame() { return S.games ? S.games[S.cur] : null; }
  function waveCol(g) { return WAVE_COL[(g.wave - 1) % WAVE_COL.length]; }

  // ---- the scene ----
  function lerp(a, b, t) { return a + (b - a) * t; }
  function draw(alpha) {
    if (!S || !S.ctx || !S.atl) return;
    var g = curGame() || S.hf, c = S.ctx, i, j, t = S.clock, wc = waveCol(g);
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (S.shake > 0 && !S.rm) { var sh = S.shake * 10; c.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh); }
    c.fillStyle = S.col.bg; c.fillRect(-10, -10, VW + 20, VH + 20);
    // the garden band and its edge
    c.fillStyle = S.col.zone; c.fillRect(0, PY(ZONE_TOP), VW, ZONE * CELL);
    c.fillStyle = S.col.line;
    for (i = 0; i < COLS; i++) c.fillRect(i * CELL + 3, PY(ZONE_TOP) - 0.5, CELL - 6, 1);
    c.save();
    c.beginPath(); c.rect(0, HUD_H, VW, VH - HUD_H); c.clip();
    // mushrooms
    for (var r = 0; r < ROWS; r++) {
      for (var cc = 0; cc < COLS; cc++) {
        var k = r * COLS + cc, hp = g.m[k];
        if (!hp) continue;
        glyph(c, g.pz[k] ? C_POISON : wc[0], CH_MUSH, PX(cc + 0.5), PY(r + 0.5) + 1, 1.05, hp / MUSH_HP);
      }
    }
    // the bugs: a head '@' and body 'O's that bob as they walk
    for (i = 0; i < g.bugs.length; i++) {
      var segs = g.bugs[i].segs;
      for (j = segs.length - 1; j >= 0; j--) {
        var s = segs[j], sx = PX(lerp(s.ox, s.x, alpha) + 0.5), sy = PY(lerp(s.oy, s.y, alpha) + 0.5);
        if (s.y < -0.55) continue;                     // not in yet
        var bob = S.rm ? 0 : Math.sin(t * 14 + (s.c + s.r) * 1.7) * 0.7;
        var col = s.poison ? C_POISON : wc[1];
        if (j === 0) glyph(c, col, CH_HEAD, sx, sy + bob, 1.2);
        else glyph(c, col, CH_BODY, sx, sy + bob - 1.6, 1.5);   // a fat round 'o' (x-height sits low: lift it)
      }
    }
    // extras
    for (i = 0; i < g.foes.length; i++) {
      var f = g.foes[i], fx = PX(lerp(f.ox, f.x, alpha)), fy = PY(lerp(f.oy, f.y, alpha));
      if (f.k === 'skitter') {
        var leg = ((t * 10) | 0) % 2;
        drawStr(c, C_RED, leg ? '/o\\' : '\\o/', fx, fy, 'center', 1);
      } else if (f.k === 'tick') {
        glyph(c, C_FAINT, 39, fx, fy - 9); glyph(c, C_FAINT, 46, fx, fy - 15);
        glyph(c, f.hp > 1 ? C_GOLD : C_FLAME, 86, fx, fy, 1.1);
      } else {
        var wing = ((t * 16) | 0) % 2;
        drawStr(c, C_FLAME, f.vx > 0 ? (wing ? '~8>' : '-8>') : (wing ? '<8~' : '<8-'), fx, fy, 'center', 1);
      }
    }
    // the shot
    if (g.b.on) {
      var bx = PX(lerp(g.b.ox, g.b.x, alpha)), by = PY(lerp(g.b.oy, g.b.y, alpha));
      glyph(c, C_TEXT, 124, bx, by, 0.95);
      c.globalAlpha = 0.4; glyph(c, C_ACC, 39, bx, by + 8, 0.9); c.globalAlpha = 1;
    }
    // the player
    if (g.phase === 'play' || (!S.games)) {
      var ppx = PX(lerp(g.p.ox, g.p.x, alpha)), ppy = PY(lerp(g.p.oy, g.p.y, alpha));
      if (!(g.grace > 0 && ((t * 12) | 0) % 2 && S.games)) glyph(c, C_ACC, CH_PLAYER, ppx, ppy, 1.25);
    } else if (g.phase === 'dying' && g.deadAt) {
      var dd = Math.max(0, g.timer / DIE_T);
      c.globalAlpha = dd; glyph(c, C_RED, 42, PX(g.deadAt.x), PY(g.deadAt.y), 1 + (1 - dd) * 1.5); c.globalAlpha = 1;
    }
    // particles + pop-ups
    for (i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on) continue;
      c.globalAlpha = Math.min(1, 2.5 * (1 - p.t / p.life));
      glyph(c, p.ci, p.code, p.x, p.y, 0.9);
    }
    c.globalAlpha = 1;
    for (i = 0; i < NPOP; i++) {
      var pp = S.pops[i];
      if (!pp.on) continue;
      c.globalAlpha = Math.min(1, 3 * (1 - pp.t));
      drawStr(c, pp.ci, pp.s, pp.x, pp.y - pp.t * 16, 'center', 0.8);
    }
    c.globalAlpha = 1;
    c.restore();
    hud(c, g);
    if (S.msg && S.games) banner(c, S.msg.text, PY(ROWS / 2 - 3), S.msg.ci);
    if (S.flash > 0 && !S.rm) { c.fillStyle = 'rgba(' + S.col.flash + ',' + (S.flash * (S.dark ? 0.6 : 1.2)).toFixed(3) + ')'; c.fillRect(-10, -10, VW + 20, VH + 20); }
  }
  function banner(c, s, y, ci) {
    var w = (s.length + 4) * CW;
    c.fillStyle = S.col.bg; c.fillRect(VW / 2 - w / 2, y - 10, w, 20);
    c.fillStyle = S.pal[ci]; c.fillRect(VW / 2 - w / 2, y - 10, w, 1); c.fillRect(VW / 2 - w / 2, y + 9, w, 1);
    drawStr(c, ci, s, VW / 2, y, 'center');
  }
  function hud(c, g) {
    var yl = 8, yv = 20, L = 0.7;
    c.fillStyle = S.col.hud; c.fillRect(0, 0, VW, HUD_H);
    c.fillStyle = S.pal[C_GRID]; c.fillRect(0, HUD_H - 1, VW, 1);
    var two = S.games && S.games.length > 1;
    drawStr(c, C_MUTED, two ? 'PLAYER ' + (S.cur + 1) : 'SCORE', 6, yl, 'left', L);
    drawStr(c, C_TEXT, pad6(g.score), 6, yv, 'left');
    var hi = Math.max(S.save.best[g.D.id] || 0, g.score);
    if (two) {
      var o = S.games[1 - S.cur];
      drawStr(c, C_MUTED, 'P' + (2 - S.cur), 76, yl, 'left', L);
      drawStr(c, C_FAINT, pad6(o.score), 76, yv, 'left', 0.85);
    }
    drawStr(c, C_MUTED, 'HIGH', 136, yl, 'left', L);
    drawStr(c, C_GOLD, pad6(hi), 136, yv, 'left');
    drawStr(c, C_MUTED, 'WAVE', 200, yl, 'left', L);
    drawStr(c, waveCol(g)[1], String(g.wave), 200, yv, 'left');
    // lives as little A's from the right
    var n = Math.min(6, Math.max(0, g.lives - (g.phase === 'play' ? 1 : 0)));
    drawStr(c, C_MUTED, 'LIVES', VW - 6, yl, 'right', L);
    for (var i = 0; i < n; i++) glyph(c, C_ACC, CH_PLAYER, VW - 10 - i * 10, yv, 0.95);
    if (g.lives - 1 > 6) drawStr(c, C_MUTED, '+', VW - 12 - 6 * 10, yv, 'center');
  }

  // ---- loop: runs only while a game is on screen ----
  function running() {
    return !!S && S.phase === 'play' && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel));
  }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function input() {
    var inp = S.inp, k = S.keys, gp = S.gp;
    var ax = (k.ArrowRight || k.KeyD ? 1 : 0) - (k.ArrowLeft || k.KeyA ? 1 : 0) + gp.ax;
    var ay = (k.ArrowDown || k.KeyS ? 1 : 0) - (k.ArrowUp || k.KeyW ? 1 : 0) + gp.ay;
    inp.ax = clamp(ax, -1, 1); inp.ay = clamp(ay, -1, 1);
    if (inp.ax || inp.ay) S.tgt = null;
    inp.tx = S.tgt ? S.tgt.x : null; inp.ty = S.tgt ? S.tgt.y : null;
    inp.fire = !!(S.save.auto || k.Space || k.KeyZ || k.KeyX || k.KeyJ || k.Enter || S.mfire || S.tfire || S.padFire || gp.fire);
    return inp;
  }
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
    var g = curGame(), alpha = advance(g, dt, input());
    handleEvents(g, dt);
    stepFx(dt);
    draw(alpha);
    if (g.phase === 'down' || g.phase === 'over') {
      S.endT += dt;
      if (S.endT >= (g.phase === 'over' ? 1.6 : 0.5)) { S.endT = 0; afterLife(); return; }
    } else S.endT = 0;
    S.raf = requestAnimationFrame(frame);
  }

  var POP_COL = { skitter: C_RED, tick: C_GOLD, hornet: C_FLAME };
  function handleEvents(g, dt) {
    var ev = g.ev, snd = S.snd, wc = waveCol(g), i, e;
    for (i = 0; i < ev.length; i++) {
      e = ev[i];
      var x = PX(e.x || 0), y = PY(e.y || 0);
      switch (e.k) {
        case 'shot': if (S.shotT <= S.clock) { snd.tone(1500, 0.035, 'square', 0.006, 700); S.shotT = S.clock + 0.07; } break;
        case 'mushHit': snd.tone(330, 0.03, 'square', 0.012); spark(x, y - 4, (Math.random() - 0.5) * 40, -30, 0.3, 46, wc[0], 120); break;
        case 'mushGone': snd.tone(260, 0.07, 'triangle', 0.025, 130); burst(x, y, 5, 50, ".,'", wc[0], 160, 0.45); break;
        case 'kill':
          if (e.head) { snd.tone(880, 0.1, 'square', 0.03, 440); popup(x, y - 6, '100', wc[1]); }
          else snd.tone(560, 0.07, 'square', 0.022, 300);
          burst(x, y, e.head ? 10 : 6, e.head ? 80 : 60, "*+o.", [wc[1], C_TEXT], 90, 0.55);
          if (Cade.haptic) Cade.haptic(5);
          break;
        case 'split': say('SPLIT!', wc[1], 0.6); break;
        case 'skitter': case 'tick': case 'hornet':
          popup(x, y - 6, String(e.pts), POP_COL[e.k]);
          burst(x, y, 14, 100, "*+x.'", [POP_COL[e.k], C_TEXT, C_GOLD], 60, 0.75);
          [660, 880, 1100].forEach(function (fq, j) { snd.tone(fq, 0.08, 'square', 0.03, 0, j * 0.05); });
          if (e.k === 'skitter' && e.pts >= 900) { say('CLOSE CALL  ' + e.pts, C_RED, 1.1); S.flash = 0.06; }
          else if (e.k === 'hornet') say('HORNET DOWN', C_FLAME, 1.1);
          if (Cade.haptic) Cade.haptic(10);
          break;
        case 'tickHit': snd.tone(990, 0.06, 'square', 0.02); burst(x, y, 4, 50, "'.", C_GOLD, 0, 0.3); break;
        case 'skitterIn': S.skBeep = 0; break;
        case 'hornetIn': snd.tone(180, 0.5, 'sawtooth', 0.012, 240); break;
        case 'tickIn': snd.tone(1600, 0.4, 'sine', 0.015, 400); break;
        case 'sideIn': snd.tone(140, 0.12, 'square', 0.015); break;
        case 'eat': burst(x, y, 3, 30, '.,', wc[0], 60, 0.35); break;
        case 'poison': burst(x, y, 4, 30, "*'", C_POISON, 0, 0.4); snd.tone(1200, 0.05, 'sine', 0.012, 1600); break;
        case 'die':
          S.shake = 0.45; S.flash = 0.12;
          burst(x, y, 28, 130, "*#+x%.", [C_ACC, C_RED, C_GOLD, C_TEXT], 120, 1.1);
          snd.tone(440, 0.7, 'sawtooth', 0.05, 55); snd.tone(220, 0.8, 'square', 0.03, 40, 0.05);
          if (Cade.haptic) Cade.haptic(40);
          say(g.lives > 0 ? 'OUCH' : 'GAME OVER', C_RED, 1.4);
          break;
        case 'restore': snd.tone(500 + (S.rsN++ % 12) * 60, 0.04, 'triangle', 0.02); burst(x, y, 2, 20, "'", wc[0], 0, 0.3); break;
        case 'life':
          say('EXTRA LIFE!', C_ACC, 1.4, true); S.flash = 0.08;
          [523, 659, 784, 1047, 1319].forEach(function (fq, j) { snd.tone(fq, 0.1, 'triangle', 0.035, 0, j * 0.07); });
          break;
        case 'wave':
          say('WAVE ' + e.w, waveCol(g)[1], 1.6);
          [392, 523, 659, 784].forEach(function (fq, j) { snd.tone(fq, 0.12, 'square', 0.025, 0, j * 0.08); });
          break;
        case 'over': say('GAME OVER', C_RED, 2); break;
      }
    }
    ev.length = 0;
    // the march: a two-note thump that speeds up with the bugs; a warble while a skitter is about
    if (g.phase === 'play' && g.grace <= 0 && g.bugs.length) {
      S.beatT += dt * g.bugs[0].v / 2;
      if (S.beatT >= 1) { S.beatT -= Math.floor(S.beatT); S.beatN++; snd.tone(S.beatN % 2 ? 98 : 82, 0.07, 'triangle', 0.035); }
    }
    if (g.phase === 'play') {
      for (i = 0; i < g.foes.length; i++) if (g.foes[i].k === 'skitter') {
        if ((S.skBeep -= dt) <= 0) { S.skBeep = 0.16; snd.tone(S.skHi = !S.skHi ? 1250 : 1000, 0.05, 'triangle', 0.01); }
        break;
      }
    }
  }

  // ---- cards ----
  function chipRow(attr, items, on) {
    return '<div class="bs-chips">' + items.map(function (it) {
      var sel = String(it[0]) === String(on);
      return '<button type="button" class="bs-chip' + (sel ? ' on' : '') + '" data-' + attr + '="' + it[0] + '" aria-pressed="' + sel + '">' + it[1] + '</button>';
    }).join('') + '</div>';
  }
  function line(a, b) { return esc(a) + new Array(Math.max(1, 26 - a.length - b.length) + 1).join(' ') + '<b>' + esc(b) + '</b>'; }
  function homeHtml() {
    var sv = S.save, h = '<div class="bs-card bs-home">';
    h += '<pre class="bs-art" aria-hidden="true">' + esc(' ♣   oooooo@  ♣\n   ♣     ♣   /o\\\n      |       ♣\n  ♣   A    ♣') + '</pre>';
    h += '<div class="bs-title">BUG SWARM</div>';
    h += '<div class="bs-tabs" role="tablist">' + [['play', 'Play'], ['scores', 'High scores']].map(function (tb) {
      return '<button type="button" role="tab" data-tab="' + tb[0] + '" aria-selected="' + (S.tab === tb[0]) + '" class="' + (S.tab === tb[0] ? 'on' : '') + '">' + tb[1] + '</button>';
    }).join('') + '</div>';
    if (S.tab === 'play') {
      h += '<div class="bs-sec"><div class="bs-h">Difficulty</div>' + chipRow('diff', DIFF_IDS.map(function (d) { return [d, DIFFS[d].name]; }), sv.diff) + '</div>';
      h += '<div class="bs-sec"><div class="bs-h">Players</div>' + chipRow('players', [[1, '1 player'], [2, '2 players (take turns)']], sv.players) + '</div>';
      h += '<div class="bs-sec"><div class="bs-h">Shooting</div>' + chipRow('auto', [['0', 'Hold to fire'], ['1', 'Auto-fire']], sv.auto ? '1' : '0') + '</div>';
      var D = DIFFS[sv.diff];
      h += '<div class="bs-note">' + D.lives + ' lives · extra life every ' + fmtInt(D.bonus) + ' · best ' + fmtInt(sv.best[sv.diff] || 0) + '</div>';
    } else {
      if (!sv.table.length) h += '<p class="bs-empty">No scores yet. Go squash some bugs.</p>';
      else {
        h += '<pre class="bs-tab">' + '<i> #     SCORE  WAVE  LEVEL     DATE</i>\n' + sv.table.map(function (e, i) {
          var rk = (i + 1 < 10 ? ' ' : '') + (i + 1), sc = fmtInt(e.s), w = String(e.w);
          var row = rk + '  ' + new Array(Math.max(1, 8 - sc.length) + 1).join(' ') + '<b>' + esc(sc) + '</b>' + new Array(Math.max(1, 6 - w.length) + 1).join(' ') + esc(w) +
            '  ' + esc((DIFFS[e.d].name + (e.p ? ' ' + e.p : '') + '        ').slice(0, 9)) + ' <i>' + esc(e.t ? e.t.slice(5) : '') + '</i>';
          return (i === S.lastRank - 1 ? '<span class="g">' + row + '</span>' : row);
        }).join('\n') + '</pre>';
      }
      h += '<pre class="bs-tab">' + [line('Games played', fmtInt(sv.games)), line('Segments squashed', fmtInt(sv.segs)), line('Furthest wave', sv.wave ? String(sv.wave) : '-')].join('\n') + '</pre>';
      h += '<div class="bs-foot">' + (S.resetArm ?
        '<span class="bs-confirm">Erase all scores?</span><span><button type="button" class="bs-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="bs-lnk" data-act="reset-no">Keep</button></span>' :
        '<span></span><button type="button" class="bs-lnk" data-act="reset">Reset scores</button>') + '</div>';
    }
    return h + '</div>';
  }
  function helpHtml(first) {
    var keys = S.coarse ?
      '<div><b>drag anywhere</b> on the field &nbsp;move (your finger never covers the A)</div><div><b>touching the field</b> or holding <b>FIRE</b> &nbsp;shoot</div>' :
      '<div><b>mouse</b> &nbsp;move &middot; <b>hold the button</b> to shoot</div><div><b>&larr; &uarr; &rarr; &darr;</b> / WASD &nbsp;move &middot; <b>Space</b> / Z &nbsp;shoot</div><div><b>gamepad</b> &nbsp;stick to move, A to shoot</div><div><b>P / Esc</b> &nbsp;pause</div>';
    return '<div class="bs-card bs-help">' +
      '<div class="bs-title">BUG SWARM</div>' +
      '<p>A long bug <b class="bs-b">@OOOO</b> winds down through the mushrooms <b class="bs-m">&#9827;</b>, turning at every wall and mushroom. You are the <b class="bs-a">A</b> in the garden at the bottom.</p>' +
      '<div class="bs-keys">' + keys + '</div>' +
      '<p class="bs-tip">Shoot it mid-body and it <b>splits in two</b>; every segment you hit becomes a mushroom. Mushrooms take four shots. Heads <b>100</b>, body <b>10</b>.</p>' +
      '<div class="bs-keys bs-foes">' +
      '<div><b class="bs-c-red">/o\\</b> Skitter &nbsp;<span>zig-zags through the garden, eats mushrooms &mdash; 300 / 600 / 900, more when it&rsquo;s close</span></div>' +
      '<div><b class="bs-c-gold">V</b> Tick &nbsp;<span>drops when the garden runs bare, sows mushrooms; two shots &mdash; 200</span></div>' +
      '<div><b class="bs-c-flame">&lt;8-</b> Hornet &nbsp;<span>poisons mushrooms <b class="bs-p">&#9827;</b>: a bug that meets one dives straight down &mdash; 1000</span></div></div>' +
      '<p class="bs-tip">Clear every segment for the next wave. Losing a life regrows the damaged mushrooms (+5 each). <b>2 players</b> take turns, a life each.</p>' +
      (first ? '' : '<button type="button" class="bs-go" data-act="close-help">Back</button>') + '</div>';
  }
  function statRows(r) {
    var rows = [line('Wave reached', String(r.wave)), line('Segments', fmtInt(r.segs) + (r.heads ? ' (' + r.heads + ' heads)' : ''))];
    if (r.skitters) rows.push(line('Skitters', String(r.skitters)));
    if (r.ticks) rows.push(line('Ticks', String(r.ticks)));
    if (r.hornets) rows.push(line('Hornets', String(r.hornets)));
    rows.push(line('Mushrooms cleared', fmtInt(r.mush)));
    rows.push(line('Accuracy', r.acc + '%'));
    return rows;
  }
  function resultsHtml() {
    var R = S.results, h = '<div class="bs-card bs-res"><div class="bs-title">GAME OVER</div>';
    if (R.length === 1) {
      var r = R[0];
      h += '<div class="bs-big">' + fmtInt(r.res.score) + '</div>';
      h += r.out.best ? '<div class="bs-new">** new best on ' + esc(DIFFS[r.res.diff].name) + ' **</div>' : '<div class="bs-sub">best ' + fmtInt(S.save.best[r.res.diff]) + '</div>';
      if (r.out.rank) h += '<div class="bs-new">#' + r.out.rank + ' on the high-score table</div>';
      h += '<pre class="bs-tab">' + statRows(r.res).join('\n') + '</pre>';
    } else {
      var a = R[0].res.score, b = R[1].res.score;
      h += '<div class="bs-sub">' + (a === b ? 'A tie!' : 'Player ' + (a > b ? 1 : 2) + ' wins') + '</div>';
      h += '<div class="bs-duo">' + R.map(function (x, i) {
        var win = x.res.score >= R[1 - i].res.score;
        return '<div class="bs-pl' + (win ? ' win' : '') + '"><div class="bs-h">Player ' + (i + 1) + '</div><div class="bs-big">' + fmtInt(x.res.score) + '</div>' +
          '<div class="bs-note">wave ' + x.res.wave + ' · ' + x.res.segs + ' segs · ' + x.res.acc + '%</div>' + (x.out.rank ? '<div class="bs-new">#' + x.out.rank + ' on the table</div>' : '') + '</div>';
      }).join('') + '</div>';
    }
    return h + '</div>';
  }
  function handHtml() {
    var g = S.games[S.next];
    return '<div class="bs-card bs-hand"><div class="bs-title">PLAYER ' + (S.next + 1) + '</div>' +
      '<p class="bs-sub">Pass the device to Player ' + (S.next + 1) + ' &mdash; tap when ready.</p>' +
      '<div class="bs-big">' + fmtInt(g.score) + '</div>' +
      '<div class="bs-note">wave ' + g.wave + ' · ' + g.lives + (g.lives === 1 ? ' life' : ' lives') + ' left</div>' +
      '<button type="button" class="bs-go" data-act="ready">Ready</button></div>';
  }
  function pauseHtml() {
    var g = curGame();
    return '<div class="bs-card bs-pause"><div class="bs-title">PAUSED</div>' +
      '<div class="bs-sub">' + fmtInt(g.score) + ' · wave ' + g.wave + '</div>' +
      '<div class="bs-btns"><button type="button" class="bs-go" data-act="resume">Resume</button><button type="button" class="bs-go alt" data-act="help">Help</button><button type="button" class="bs-go alt" data-act="quit">End game</button></div>' +
      '<div class="bs-note">' + (S.coarse ? 'Tap Resume to carry on' : 'Space / P to resume') + '</div></div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'home' ? homeHtml() : kind === 'help' ? helpHtml(S.phase === 'help') : kind === 'results' ? resultsHtml() :
      kind === 'pause' ? pauseHtml() : kind === 'hand' ? handHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind && kind !== 'home');
    S.stage.classList.toggle('home', kind === 'home');
  }
  function setPad(mode) {
    var h;
    S.padMode = mode;
    if (mode === 'run') {
      h = '<button type="button" class="bs-hold" data-k="fire" aria-label="Hold to fire">Fire <span>' + (S.save.auto ? 'auto' : 'hold') + '</span></button>' +
        '<button type="button" class="bs-act alt" data-act="auto" aria-pressed="' + S.save.auto + '">' + (S.save.auto ? 'Auto: on' : 'Auto: off') + '</button>';
    } else {
      var lab = mode === 'go' ? 'Play' : mode === 'again' ? 'Again' : mode === 'resume' ? 'Resume' : mode === 'ready' ? 'Ready' : mode === 'start' ? 'Let’s go!' : 'Back';
      h = '<button type="button" class="bs-act" data-act="' + mode + '">' + lab + (S.coarse ? '' : ' <small>space</small>') + '</button>' +
        (mode === 'again' ? '<button type="button" class="bs-act alt" data-act="home">Menu</button>' : '');
    }
    S.pad.innerHTML = h;
    syncPad();
  }
  function syncPad() {
    if (!S || S.padMode !== 'run') return;
    var b = S.pad.querySelector('[data-k]');
    if (b) b.classList.toggle('on', !!(S.padFire || S.save.auto));
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
    S.cv.setAttribute('aria-label', 'Bug Swarm play field — best ' + fmtInt(S.save.best[S.save.diff] || 0) + ' on ' + DIFFS[S.save.diff].name + '. Move with the mouse, arrows or a finger dragged on the field; hold to shoot.');
  }

  function toHome() {
    stopLoop();
    S.phase = 'home'; S.games = null; S.paused = false; S.resetArm = false;
    S.hf = newGame(hash2(Date.now() & 0xffff, 3), { diff: S.save.diff });
    clearInput(); clearFx(); S.msg = null; S.msgQ.length = 0;
    showCard('home'); setPad('go'); syncHead(); syncLabel();
    draw(1);
  }
  function startGame() {
    if (!S || (S.phase !== 'home' && S.phase !== 'results' && S.phase !== 'help')) return;
    S.snd.ensure();
    var sv = S.save, base = (Math.random() * 4294967295) >>> 0;
    S.games = [];
    for (var i = 0; i < sv.players; i++) S.games.push(newGame(hash2(base, i + 1), { diff: sv.diff }));
    S.cur = 0; S.paused = false; S.endT = 0; S.beatT = 0; S.beatN = 0; S.rsN = 0; S.shotT = 0; S.lastRank = 0;
    clearInput(); clearFx(); S.msg = null; S.msgQ.length = 0;
    if (sv.players === 2) { S.next = 0; S.phase = 'hand'; showCard('hand'); setPad('ready'); syncHead(); draw(1); return; }
    beginPlay('READY');
  }
  function beginPlay(msg) {
    S.phase = 'play'; S.paused = false;
    showCard(null); setPad('run'); syncHead();
    if (msg) say(msg, C_ACC, 1.2);
    kick();
  }
  // A life is over (g.phase down / over): carry on, hand over to the other player, or end the game.
  function afterLife() {
    var g = curGame(), two = S.games.length > 1, o = two ? S.games[1 - S.cur] : null;
    if (two && o.phase !== 'over') {
      S.next = S.cur = 1 - S.cur; S.phase = 'hand';   // the field behind the card is the next player's
      stopLoop(); clearInput(); clearFx(); S.msg = null; S.msgQ.length = 0;
      showCard('hand'); setPad('ready'); syncHead(); draw(1);
      return;
    }
    if (g.phase === 'down') { respawn(g); clearFx(); say('READY', C_ACC, 1); S.raf = requestAnimationFrame(frame); return; }
    endGame();
  }
  function ready() {
    if (!S || S.phase !== 'hand') return;
    S.cur = S.next;
    var g = curGame();
    if (g.phase === 'down') respawn(g);
    g.acc = 0;
    beginPlay('PLAYER ' + (S.cur + 1));
  }
  function endGame() {
    stopLoop();
    var date = today(), two = S.games.length > 1;
    S.results = S.games.map(function (g, i) {
      var res = summary(g);
      return { res: res, out: record(S.save, res, two ? 'P' + (i + 1) : '', date) };
    });
    S.lastRank = S.results[0].out.rank;
    persist();
    S.phase = 'results'; clearInput();
    showCard('results'); setPad('again'); syncHead(); syncLabel();
    var best = S.results.some(function (r) { return r.out.best; });
    if (S.liveEl) S.liveEl.textContent = 'Game over: ' + S.results.map(function (r) { return fmtInt(r.res.score); }).join(' and ') + ' points.';
    if (best) [659, 784, 988, 1319].forEach(function (fq, j) { S.snd.tone(fq, 0.12, 'triangle', 0.035, 0, j * 0.08); });
    draw(1);
  }
  function padAction(act) {
    if (!S) return;
    S.snd.ensure();
    act = act || S.padMode;
    if (act === 'go' || act === 'again' || act === 'start') { if (S.phase === 'help') S.phase = 'home'; startGame(); }
    else if (act === 'resume') resume();
    else if (act === 'ready') ready();
    else if (act === 'auto') { S.save.auto = !S.save.auto; persist(); setPad('run'); S.snd.tone(S.save.auto ? 988 : 660, 0.05, 'sine', 0.03); }
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
    var g = curGame(); if (g) g.acc = 0;
    showCard(null); setPad('run'); syncHead();
    kick();
  }
  function quitRun() {
    if (!S || S.phase !== 'play') return;
    S.paused = false;
    S.games.forEach(function (g) { g.phase = 'over'; });
    endGame();
  }

  // ---- input ----
  var MOVE_KEYS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, KeyA: 1, KeyD: 1, KeyW: 1, KeyS: 1 };
  var FIRE_KEYS = { Space: 1, KeyZ: 1, KeyX: 1, KeyJ: 1, Enter: 1 };
  var KEY2CODE = { ' ': 'Space', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', a: 'KeyA', d: 'KeyD', w: 'KeyW', s: 'KeyS', z: 'KeyZ', x: 'KeyX', j: 'KeyJ', p: 'KeyP', enter: 'Enter', escape: 'Escape' };
  function keyCode(e) { var c = e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; return c === 'NumpadEnter' ? 'Enter' : c; }
  function clearInput() { S.keys = {}; S.mfire = false; S.tfire = false; S.padFire = false; S.ptr = null; S.tgt = null; S.gp.fire = false; S.gp.ax = 0; S.gp.ay = 0; syncPad(); }
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
    if (!p) { gp.fire = false; gp.ax = 0; gp.ay = 0; return; }
    var ax = p.axes[0] || 0, ay = p.axes[1] || 0;
    gp.ax = (Math.abs(ax) > 0.2 ? ax : 0) + (btnOn(p, 15) ? 1 : 0) - (btnOn(p, 14) ? 1 : 0);
    gp.ay = (Math.abs(ay) > 0.2 ? ay : 0) + (btnOn(p, 13) ? 1 : 0) - (btnOn(p, 12) ? 1 : 0);
    gp.fire = btnOn(p, 0) || btnOn(p, 1) || btnOn(p, 2) || btnOn(p, 5) || btnOn(p, 7);
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
      if (S.phase === 'play' && !S.paused) pause(); else closePanel();
      return;
    }
    if (S.phase === 'play') {
      if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
      if (S.paused) {
        if (code === 'Space' || code === 'Enter') { e.preventDefault(); if (!e.repeat) resume(); }
        else if (MOVE_KEYS[code] || FIRE_KEYS[code]) e.preventDefault();
        return;
      }
      if (MOVE_KEYS[code] || FIRE_KEYS[code]) { e.preventDefault(); S.keys[code] = true; }
      return;
    }
    if (code === 'Space' || code === 'Enter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (!e.repeat) padAction();
    }
  }
  function onKeyUp(e) { if (S) delete S.keys[keyCode(e)]; }

  // ---- layout: a fixed logical field, scaled to fit ----
  // Height the play field may use: the visible viewport minus the panel's top offset and its
  // chrome (title bar, pad, gaps, padding) — measured from the parts, not the panel, which the
  // core may cap in height (that would feed back into a bigger field).
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect(), hd = S.panel.querySelector('.cade-panel-head');
    var chrome = (hd && hd.offsetHeight ? hd.offsetHeight : 40) + (S.pad.offsetHeight || (S.coarse ? 60 : 50)) + 8 + (vw <= 560 ? 18 : 22);
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 12;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var s = Math.min((vw - (phone ? 26 : 48)) / VW, availH(vw, vh) / VH, phone ? 1.4 : solo ? 2.2 : 1.6);
    s = Math.max(0.6, s);
    var cw = Math.floor(VW * s), ch = Math.floor(VH * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--bs-w', cw + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / VW;
    S.scale = cw / VW;
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
    document.removeEventListener('keyup', s.onKeyUp, true);
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
    var body = '<div class="bs"><div class="bs-stage"><canvas class="bs-cv"></canvas><div class="bs-ovl" style="display:none"></div></div>' +
      '<div class="bs-pad"></div><div class="bs-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🐛 Bug Swarm', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'bs-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, stage: p.querySelector('.bs-stage'), cv: p.querySelector('.bs-cv'), ovl: p.querySelector('.bs-ovl'),
      pad: p.querySelector('.bs-pad'), liveEl: p.querySelector('.bs-live'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'home', games: null, cur: 0, next: 0, hf: null, paused: false, raf: 0, last: 0, endT: 0, clock: 0,
      keys: {}, ptr: null, tgt: null, mfire: false, tfire: false, padFire: false, inp: { ax: 0, ay: 0, tx: null, ty: null, fire: false },
      gp: { fire: false, ax: 0, ay: 0, start: false, menuA: false }, gpT: 0,
      pal: new Array(NPAL), col: null, atl: null, k: 1, scale: 1, shake: 0, flash: 0, beatT: 0, beatN: 0, skBeep: 0, skHi: false, rsN: 0, shotT: 0,
      msg: null, msgQ: [], tab: 'play', resetArm: false, padMode: '', cardKind: null, results: null, lastRank: 0
    };
    makeFx();
    S.ctx = S.cv.getContext('2d');
    S.hf = newGame(7, { diff: S.save.diff });
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
      else if (h === 'help') {
        if (S.phase === 'play') pause();
        if (S.cardKind === 'help') { if (S.phase === 'home' || S.paused) showCard(S.paused ? 'pause' : 'home'); }
        else if (S.phase === 'home' || S.paused) showCard('help');
      }
      try { b.blur(); } catch (er) {}
    });

    // Rapid tapping must never zoom, select, magnify or open a callout.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    [S.cv, S.pad].forEach(function (el) {
      el.addEventListener('touchstart', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
      el.addEventListener('touchmove', noTouch, { passive: false });
      el.addEventListener('touchend', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
    });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    // the play field: a mouse steers absolutely (the A follows the pointer); a finger steers relatively
    // (drag anywhere — the A moves by your drag, so the finger never hides it) and shoots while down
    function cellAt(e) {
      var r = S.cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) / S.scale / CELL, y: ((e.clientY - r.top) / S.scale - TOP) / CELL };
    }
    function playing() { return S && S.phase === 'play' && !S.paused; }
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S) return;
      e.preventDefault();
      S.snd.ensure();
      if (!playing()) return;
      try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
      if (e.pointerType === 'mouse') {
        if (e.button > 0) return;
        S.tgt = cellAt(e); S.mfire = true;
      } else {
        S.tfire = (S.tfire || 0) + 1;
        if (!S.ptr) { var g = curGame(); S.ptr = { id: e.pointerId, lx: e.clientX, ly: e.clientY }; S.tgt = { x: g.p.x, y: g.p.y }; }
      }
    });
    S.cv.addEventListener('pointermove', function (e) {
      if (!playing()) return;
      if (e.pointerType === 'mouse') { S.tgt = cellAt(e); return; }
      if (!S.ptr || S.ptr.id !== e.pointerId) return;
      var g = curGame(), gain = 1.25 / S.scale / CELL;
      var tx = (S.tgt ? S.tgt.x : g.p.x) + (e.clientX - S.ptr.lx) * gain, ty = (S.tgt ? S.tgt.y : g.p.y) + (e.clientY - S.ptr.ly) * gain;
      S.tgt = { x: clamp(clamp(tx, g.p.x - 6, g.p.x + 6), PR, COLS - PR), y: clamp(clamp(ty, g.p.y - 4, g.p.y + 4), ZONE_TOP + PR, ROWS - PR) };
      S.ptr.lx = e.clientX; S.ptr.ly = e.clientY;
    });
    function release(e) {
      if (!S) return;
      if (e.pointerType === 'mouse') { S.mfire = false; return; }
      if (S.tfire) S.tfire = Math.max(0, S.tfire - 1);
      if (S.ptr && S.ptr.id === e.pointerId) { S.ptr = null; S.tgt = null; }
    }
    ['pointerup', 'pointercancel'].forEach(function (t) { S.cv.addEventListener(t, release); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // the pad: FIRE is held; the rest are taps
    S.pad.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-k]') : null;
      if (!b || !S) return;
      e.preventDefault();
      S.snd.ensure();
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      S.padFire = true; syncPad();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) {
      S.pad.addEventListener(t, function (e) { if (S && e.target.closest && e.target.closest('[data-k]')) { S.padFire = false; syncPad(); } });
    });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (b && S) { padAction(b.getAttribute('data-act')); try { b.blur(); } catch (er) {} }
    });
    // cards
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var sv = S.save, tab = b.getAttribute('data-tab'), act = b.getAttribute('data-act');
      var df = b.getAttribute('data-diff'), pl = b.getAttribute('data-players'), au = b.getAttribute('data-auto');
      function refocus(sel) { var nb = e.detail === 0 && S.ovl.querySelector(sel); if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} } }
      if (df || pl || au) {
        if (df && DIFFS[df]) { sv.diff = df; S.hf = newGame(hash2(Date.now() & 0xffff, 5), { diff: df }); }
        if (pl) sv.players = pl === '2' ? 2 : 1;
        if (au) sv.auto = au === '1';
        persist(); S.snd.tone(988, 0.04, 'sine', 0.03);
        showCard('home'); syncLabel(); draw(1);
        refocus(df ? '[data-diff="' + df + '"]' : pl ? '[data-players="' + pl + '"]' : '[data-auto="' + au + '"]');
      } else if (tab) { S.tab = tab; showCard('home'); refocus('[data-tab="' + tab + '"]'); }
      else if (act === 'reset') { S.resetArm = true; showCard('home'); }
      else if (act === 'reset-no') { S.resetArm = false; showCard('home'); }
      else if (act === 'reset-yes') {
        var keep = { diff: sv.diff, players: sv.players, auto: sv.auto };
        S.save = newSave(); S.save.diff = keep.diff; S.save.players = keep.players; S.save.auto = keep.auto;
        persist(); S.resetArm = false; S.lastRank = 0;
        Cade.showToast && Cade.showToast('Scores reset', 'info', 1800);
        showCard('home');
      } else if (act === 'close-help') showCard(S.paused ? 'pause' : 'home');
      else if (act === 'resume') resume();
      else if (act === 'quit') quitRun();
      else if (act === 'help') showCard('help');
      else if (act === 'ready') ready();
    });

    if (S.firstRun) {
      S.phase = 'help';
      persist();
      showCard('help'); setPad('start'); syncHead(); syncLabel();
      draw(1);
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
    description: 'Blast a segmented bug as it winds down through the mushroom field — splits, skitters, ticks, hornets, waves, 1 or 2 players',
    icon: '🐛',
    tags: 'game,arcade,fun,shooter,bug,centipede,mushrooms,waves,2 player,ascii',
    open: open,
    _engine: ENGINE
  });
})();
