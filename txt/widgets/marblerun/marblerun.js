/* Marble Run — a marble toy and puzzle box, for Cade.txt.
 * Place ramps, curves, funnels, bumpers, flippers, conveyors, trampolines,
 * teleporters, splitters, walls and cups on a grid board, press Play and
 * watch marbles drop from the emitters. Goal levels hand you a few parts
 * and ask for N marbles in the cup(s); the sandbox has every part, emitters
 * and cups included, several save slots and a compact share code.
 * Physics: circles against line segments, arcs and discs (closest point,
 * push out, split the velocity into normal and tangent), marble against
 * marble, gravity; a fixed 240 Hz step, sub-stepped by speed so a fast
 * marble never moves more than a third of its radius between checks — no
 * tunnelling. Same layout, same run: everything is deterministic.
 * Rendering interpolates between steps (smooth at 60 and 120 Hz). The board
 * is drawn as line art and monospace glyphs (cached in a glyph atlas) in
 * the theme's colours. The loop runs only while marbles roll; it pauses on
 * blur, tab hide and minimize. Progress persists in Cade.store (cade-marblerun-*).
 * Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // Units: one grid cell = 1, y points down, seconds.
  var COLS = 10, ROWS = 14;
  var R = 0.17;                      // marble radius
  var G = 24;                        // gravity, cells/s²
  var STEP = 1 / 240;
  var MAXV = 28;
  var ROLL = 0.35;                   // rolling drag while touching (1/s)
  var REST_VN = 1.1;                 // slower impacts than this don't bounce (resting contact)
  var E_WALL = 0.32, E_BALL = 0.55;
  var BUMP_OUT = 9, TRAMP_MIN = 9, TRAMP_MAX = 18, BELT_V = 5;
  var EMIT_DT = 0.6, EMIT_COUNTS = [1, 3, 6, 10];
  var STILL_V = 0.3, STILL_T = 2.5, TMAX = 90, IDLE_T = 20;   // IDLE_T: no catch / loss / spawn for this long ends a run (endless bouncers)
  var TELE_R = 0.24;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ---- part types ----
  // Geometry is described in a cell's local coordinates ([0,1]², y down).
  // s: segment [ax, ay, bx, by]; a: arc [cx, cy, radius, from°, to°] (screen angles, clockwise from +x);
  // d: solid disc [cx, cy, radius]. k: how the surface responds.
  var TYPES = [
    { id: 'ramp', name: 'Ramp', key: '1', forms: 4, info: 'a straight slope — steep or gentle, either way' },
    { id: 'curve', name: 'Curve', key: '2', forms: 4, info: 'a quarter pipe: turns a drop sideways' },
    { id: 'funnel', name: 'Funnel', key: '3', forms: 1, info: 'gathers marbles into a narrow drop' },
    { id: 'bump', name: 'Bumper', key: '4', forms: 1, info: 'kicks marbles away, hard' },
    { id: 'flip', name: 'Flipper', key: '5', forms: 2, info: 'a gate that flips each time a marble rolls off' },
    { id: 'belt', name: 'Conveyor', key: '6', forms: 2, info: 'a moving belt that carries marbles along' },
    { id: 'tramp', name: 'Trampoline', key: '7', forms: 3, info: 'springs marbles back up' },
    { id: 'tele', name: 'Teleporter', key: '8', forms: 3, info: 'pairs by colour: in one, out the other' },
    { id: 'split', name: 'Splitter', key: '9', forms: 1, info: 'a wedge; dead-centre drops alternate sides' },
    { id: 'wall', name: 'Wall', key: '0', forms: 1, info: 'a solid block' },
    { id: 'cup', name: 'Cup', key: 'c', forms: 1, info: 'catches marbles — the goal' },
    { id: 'emit', name: 'Emitter', key: 'e', forms: 4, info: 'drops marbles when you press Play' }
  ];
  var TYPE = {}, TYPE_IX = {};
  TYPES.forEach(function (t, i) { TYPE[t.id] = t; TYPE_IX[t.id] = i; });

  function rot(pt, k) {                  // rotate a local point k×90° clockwise about the cell centre
    var x = pt[0], y = pt[1];
    for (var i = 0; i < (k & 3); i++) { var t = x; x = 1 - y; y = t; }
    return [x, y];
  }
  function geo(t, f) {
    var L = [];
    function s(ax, ay, bx, by, k) { L.push({ g: 's', ax: ax, ay: ay, bx: bx, by: by, k: k || 'wall' }); }
    switch (t) {
      case 'ramp':
        if (f === 0) s(0, 0, 1, 1);
        else if (f === 1) s(1, 0, 0, 1);
        else if (f === 2) s(0, 0.3, 1, 0.7);
        else s(1, 0.3, 0, 0.7);
        break;
      case 'curve': {
        var c = rot([1, 0], f);
        // arc from angle 90° to 180° around (1,0), rotated with the cell
        L.push({ g: 'a', cx: c[0], cy: c[1], r: 1, a0: (90 + 90 * f) * Math.PI / 180, a1: (180 + 90 * f) * Math.PI / 180, k: 'wall' });
        break;
      }
      case 'funnel':
        s(0.02, 0.02, 0.3, 0.68, 'fun'); s(0.98, 0.02, 0.7, 0.68, 'fun');
        s(0.3, 0.68, 0.3, 1, 'fun'); s(0.7, 0.68, 0.7, 1, 'fun');
        break;
      case 'bump':
        L.push({ g: 'd', cx: 0.5, cy: 0.5, r: 0.26, k: 'bump' });
        break;
      case 'flip':
        if (f === 0) s(0.12, 0.24, 0.88, 0.76, 'flip'); else s(0.88, 0.24, 0.12, 0.76, 'flip');
        break;
      case 'belt':
        L.push({ g: 's', ax: 0, ay: 0.72, bx: 1, by: 0.72, k: 'belt', dir: f === 0 ? 1 : -1 });
        break;
      case 'tramp':
        if (f === 0) s(0.1, 0.74, 0.9, 0.74, 'tramp');
        else if (f === 1) s(0.1, 0.86, 0.9, 0.5, 'tramp');
        else s(0.1, 0.5, 0.9, 0.86, 'tramp');
        break;
      case 'split':
        s(0.5, 0.32, 0.04, 0.8, 'split'); s(0.5, 0.32, 0.96, 0.8, 'split');
        break;
      case 'wall':
        s(0, 0, 1, 0); s(1, 0, 1, 1); s(1, 1, 0, 1); s(0, 1, 0, 0);
        break;
      case 'cup':
        s(0.08, 0.14, 0.14, 0.94); s(0.14, 0.94, 0.86, 0.94); s(0.86, 0.94, 0.92, 0.14);
        break;
    }
    return L;
  }

  // ---- layouts ----
  // A piece: { t, c, r, f } (+ n: an emitter's count or a cup's need in levels; fx: fixed by the level).
  function pieceAt(list, c, r) {
    for (var i = 0; i < list.length; i++) if (list[i].c === c && list[i].r === r) return list[i];
    return null;
  }
  function inBoard(c, r) { return c >= 0 && c < COLS && r >= 0 && r < ROWS; }
  function emitCount(p) { return p.n != null ? p.n : EMIT_COUNTS[p.f & 3]; }

  // ---- the simulation ----
  function newSim(pieces) {
    var sim = {
      t: 0, acc: 0, steps: 0, pieces: [], cells: new Array(COLS * ROWS), walls: [], marbles: [], nextId: 1,
      emitters: [], cups: [], teles: [], flips: [], splits: [], events: [], caught: 0, lost: 0, total: 0,
      done: false, won: false, winT: 0, needs: false, prog: 0
    };
    for (var i = 0; i < sim.cells.length; i++) sim.cells[i] = [];
    pieces.forEach(function (src, ix) {
      if (!TYPE[src.t] || !inBoard(src.c, src.r)) return;
      var p = { t: src.t, c: src.c, r: src.r, f: src.f | 0, n: src.n, uid: ix + 1, cnt: 0, armed: false, lastT: 0, flash: 0, alt: 0, anim: 0 };
      sim.pieces.push(p);
      var list = sim.cells[p.c + p.r * COLS];
      geo(p.t, p.f).forEach(function (g) {
        var o = { g: g.g, k: g.k, p: p, dir: g.dir };
        if (g.g === 's') { o.ax = g.ax + p.c; o.ay = g.ay + p.r; o.bx = g.bx + p.c; o.by = g.by + p.r; prepSeg(o); }
        else { o.cx = g.cx + p.c; o.cy = g.cy + p.r; o.r = g.r; o.a0 = g.a0; o.a1 = g.a1; }
        list.push(o);
      });
      if (p.t === 'emit') { p.left = emitCount(p); p.cd = 0.15; sim.emitters.push(p); sim.total += p.left; }
      else if (p.t === 'cup') { sim.cups.push(p); if (p.n > 0) sim.needs = true; }
      else if (p.t === 'tele') sim.teles.push(p);
      else if (p.t === 'flip') sim.flips.push(p);
    });
    // the board's side walls
    [[0, -6, 0, ROWS], [COLS, -6, COLS, ROWS]].forEach(function (w) {
      var o = { g: 's', k: 'wall', p: null, ax: w[0], ay: w[1], bx: w[2], by: w[3] };
      prepSeg(o); sim.walls.push(o);
    });
    return sim;
  }
  function prepSeg(o) {
    var dx = o.bx - o.ax, dy = o.by - o.ay, l2 = dx * dx + dy * dy;
    o.dx = dx; o.dy = dy; o.il2 = l2 > 0 ? 1 / l2 : 0;
    var l = Math.sqrt(l2) || 1;
    o.tx = dx / l; o.ty = dy / l;
  }
  // Swap a flipper's segment to its other side.
  function flipGeo(sim, p) {
    p.f ^= 1;
    var list = sim.cells[p.c + p.r * COLS];
    for (var i = 0; i < list.length; i++) if (list[i].p === p) {
      var g = geo('flip', p.f)[0], o = list[i];
      o.ax = g.ax + p.c; o.ay = g.ay + p.r; o.bx = g.bx + p.c; o.by = g.by + p.r; prepSeg(o);
    }
  }

  var CP = { x: 0, y: 0 };
  function closest(o, x, y) {
    if (o.g === 's') {
      var u = ((x - o.ax) * o.dx + (y - o.ay) * o.dy) * o.il2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      CP.x = o.ax + o.dx * u; CP.y = o.ay + o.dy * u;
    } else if (o.g === 'a') {
      var a = Math.atan2(y - o.cy, x - o.cx), a0 = o.a0, a1 = o.a1;
      while (a < a0) a += 2 * Math.PI;
      while (a > a0 + 2 * Math.PI) a -= 2 * Math.PI;
      if (a <= a1) { CP.x = o.cx + Math.cos(a) * o.r; CP.y = o.cy + Math.sin(a) * o.r; }
      else {
        var e0x = o.cx + Math.cos(a0) * o.r, e0y = o.cy + Math.sin(a0) * o.r, e1x = o.cx + Math.cos(a1) * o.r, e1y = o.cy + Math.sin(a1) * o.r;
        if ((x - e0x) * (x - e0x) + (y - e0y) * (y - e0y) < (x - e1x) * (x - e1x) + (y - e1y) * (y - e1y)) { CP.x = e0x; CP.y = e0y; }
        else { CP.x = e1x; CP.y = e1y; }
      }
    }
    return CP;
  }

  function ev(sim, k, x, y, s, p) { if (sim.events.length < 64) sim.events.push({ k: k, x: x, y: y, s: s || 0, p: p || null }); }

  // Resolve one marble against one collider; h is the sub-step (for drag / belts).
  function collide(sim, m, o, h) {
    var nx, ny, d, pen;
    if (o.g === 'd') {
      var ddx = m.x - o.cx, ddy = m.y - o.cy, dd = Math.sqrt(ddx * ddx + ddy * ddy), rr = o.r + R;
      if (dd >= rr) return;
      if (dd < 1e-6) { nx = 0; ny = -1; } else { nx = ddx / dd; ny = ddy / dd; }
      pen = rr - dd;
    } else {
      var c = closest(o, m.x, m.y), dx = m.x - c.x, dy = m.y - c.y, d2 = dx * dx + dy * dy;
      if (d2 >= R * R) return;
      d = Math.sqrt(d2);
      if (d < 1e-6) { nx = o.g === 's' ? o.ty : 0; ny = o.g === 's' ? -o.tx : -1; if (ny > 0) { nx = -nx; ny = -ny; } }
      else { nx = dx / d; ny = dy / d; }
      pen = R - d;
    }
    m.x += nx * pen; m.y += ny * pen;
    m.touch = true;
    var vn = m.vx * nx + m.vy * ny, k = o.k, p = o.p;
    var tx = m.vx - vn * nx, ty = m.vy - vn * ny;   // tangential part
    if (vn < 0) {
      var out;
      if (k === 'bump') {
        out = Math.max(-vn * 0.9, BUMP_OUT);
        p.flash = 1; ev(sim, 'bump', m.x - nx * R, m.y - ny * R, out, p);
      } else if (k === 'tramp' && (o.tx > 0 ? o.ty * nx - o.tx * ny : o.tx * ny - o.ty * nx) > 0.3) {   // the springy face (its upper side)
        out = clamp(-vn * 0.95, TRAMP_MIN, TRAMP_MAX);
        p.flash = 1; ev(sim, 'tramp', m.x - nx * R, m.y - ny * R, out, p);
      } else {
        out = -vn < REST_VN ? 0 : -vn * E_WALL;
        if (-vn > 2.5) ev(sim, 'hit', m.x - nx * R, m.y - ny * R, -vn, p);
      }
      m.vx = tx + out * nx; m.vy = ty + out * ny;
    }
    // rolling drag along the surface
    var dr = 1 - (k === 'fun' ? 8 : ROLL) * h;
    if (dr < 0) dr = 0;
    var vn2 = m.vx * nx + m.vy * ny;
    m.vx = (m.vx - vn2 * nx) * dr + vn2 * nx; m.vy = (m.vy - vn2 * ny) * dr + vn2 * ny;
    if (k === 'belt' && ny < -0.5) {
      var va = m.vx * o.dir, target = BELT_V, ch = (target - va) * Math.min(1, 10 * h);
      m.vx += ch * o.dir;
    } else if (k === 'flip') {
      p.armed = true; p.lastT = sim.t;
    } else if (k === 'split' && !m.split && Math.abs(nx) < 0.12 && Math.abs(m.vx) < 0.4 && Math.abs(m.x - (p.c + 0.5)) < 0.05) {
      m.split = p.uid;
      m.vx += p.alt ? 0.7 : -0.7; p.alt ^= 1;
    }
  }

  function collideStatic(sim, m, h) {
    var c0 = Math.floor(m.x) - 1, r0 = Math.floor(m.y) - 1, c, r, i, L;
    for (r = r0; r <= r0 + 2; r++) {
      if (r < 0 || r >= ROWS) continue;
      for (c = c0; c <= c0 + 2; c++) {
        if (c < 0 || c >= COLS) continue;
        L = sim.cells[c + r * COLS];
        for (i = 0; i < L.length; i++) collide(sim, m, L[i], h);
      }
    }
    for (i = 0; i < sim.walls.length; i++) collide(sim, m, sim.walls[i], h);
  }

  function spawnClear(sim, x, y) {
    for (var i = 0; i < sim.marbles.length; i++) {
      var m = sim.marbles[i];
      if (m.st === 'roll' && (m.x - x) * (m.x - x) + (m.y - y) * (m.y - y) < 4 * R * R * 1.1) return false;
    }
    return true;
  }

  function stepSim(sim) {
    if (sim.done) return;
    sim.t += STEP; sim.steps++;
    var i, j, m, ms = sim.marbles;
    // emitters
    for (i = 0; i < sim.emitters.length; i++) {
      var e = sim.emitters[i];
      if (e.left <= 0) continue;
      e.cd -= STEP;
      if (e.cd > 0) continue;
      var sx = e.c + 0.5, sy = e.r + 0.55;
      if (!spawnClear(sim, sx, sy)) { e.cd = 0.05; continue; }
      e.left--; e.cd = EMIT_DT; e.flash = 1; sim.prog = sim.t;
      ms.push({ id: sim.nextId++, x: sx, y: sy, px: sx, py: sy, vx: 0, vy: 0.5, st: 'roll', still: 0, tp: 0, split: 0, touch: false, hue: (sim.nextId - 2) % 6, src: e.uid });
      ev(sim, 'spawn', sx, sy, 0, e);
    }
    // integrate + static collisions, sub-stepped by speed
    for (i = 0; i < ms.length; i++) {
      m = ms[i];
      m.px = m.x; m.py = m.y;
      if (m.st !== 'roll') continue;
      m.vy += G * STEP;
      var sp = Math.sqrt(m.vx * m.vx + m.vy * m.vy);
      if (sp > MAXV) { m.vx *= MAXV / sp; m.vy *= MAXV / sp; sp = MAXV; }
      var n = Math.max(1, Math.ceil(sp * STEP / (R * 0.33))), h = STEP / n;
      m.touch = false;
      for (j = 0; j < n; j++) {
        m.x += m.vx * h; m.y += m.vy * h;
        collideStatic(sim, m, h);
      }
    }
    // marble against marble (four relaxation passes, so piles do not squash), then back out of the walls
    for (var pass = 0; pass < 4; pass++) {
      for (i = 0; i < ms.length; i++) {
        var a = ms[i];
        if (a.st !== 'roll') continue;
        for (j = i + 1; j < ms.length; j++) {
          var b = ms[j];
          if (b.st !== 'roll') continue;
          var dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
          if (d2 >= 4 * R * R) continue;
          var d = Math.sqrt(d2), nx, ny;
          if (d < 1e-6) { nx = 1; ny = 0; d = 0; } else { nx = dx / d; ny = dy / d; }
          var pen = (2 * R - d) / 2;
          a.x -= nx * pen; a.y -= ny * pen; b.x += nx * pen; b.y += ny * pen;
          var vr = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (vr < 0) {
            var jj = -(1 + (-vr < REST_VN ? 0 : E_BALL)) * vr / 2;
            a.vx -= jj * nx; a.vy -= jj * ny; b.vx += jj * nx; b.vy += jj * ny;
            if (-vr > 3) ev(sim, 'clack', (a.x + b.x) / 2, (a.y + b.y) / 2, -vr, null);
          }
        }
      }
      for (i = 0; i < ms.length; i++) if (ms[i].st === 'roll') collideStatic(sim, ms[i], 0);
    }
    // sensors: cups, teleporters, the edges; stillness
    var live = 0;
    for (i = 0; i < ms.length; i++) {
      m = ms[i];
      if (m.st !== 'roll') continue;
      if (m.y > ROWS + 0.6 || m.x < -1 || m.x > COLS + 1) { m.st = 'lost'; sim.lost++; sim.prog = sim.t; ev(sim, 'lost', m.x, Math.min(m.y, ROWS), 0, null); continue; }
      var cc = Math.floor(m.x), cr = Math.floor(m.y);
      var p = inBoard(cc, cr) ? cellPiece(sim, cc, cr) : null;
      if (p && p.t === 'cup') {
        var lx = m.x - cc, ly = m.y - cr;
        if (lx > 0.14 && lx < 0.86 && ly > 0.42) {
          m.st = 'in'; m.cup = p.uid; p.cnt++; p.flash = 1; sim.caught++; sim.prog = sim.t;
          ev(sim, 'catch', m.x, m.y, p.cnt, p);
          continue;
        }
      }
      if (m.tp) {
        var tp = byUid(sim, m.tp);
        if (!tp || (m.x - tp.c - 0.5) * (m.x - tp.c - 0.5) + (m.y - tp.r - 0.5) * (m.y - tp.r - 0.5) > 0.36) m.tp = 0;
      }
      if (p && p.t === 'tele' && m.tp !== p.uid) {
        var ox = m.x - p.c - 0.5, oy = m.y - p.r - 0.5;
        if (ox * ox + oy * oy < TELE_R * TELE_R) {
          var q = partner(sim, p);
          if (q) {
            ev(sim, 'tele', m.x, m.y, 0, p);
            m.x = q.c + 0.5 + ox; m.y = q.r + 0.5 + oy; m.px = m.x; m.py = m.y; m.tp = q.uid;
            p.flash = 1; q.flash = 1;
            ev(sim, 'teleout', m.x, m.y, 0, q);
          }
        }
      }
      if (m.split && (!p || p.uid !== m.split)) m.split = 0;
      var v2 = m.vx * m.vx + m.vy * m.vy;
      m.still = v2 < STILL_V * STILL_V ? m.still + STEP : 0;
      live++;
    }
    // flippers flip once the marbles have rolled off
    for (i = 0; i < sim.flips.length; i++) {
      var fp = sim.flips[i];
      if (fp.armed && sim.t - fp.lastT > 0.06) { fp.armed = false; flipGeo(sim, fp); fp.anim = 1; ev(sim, 'flip', fp.c + 0.5, fp.r + 0.5, 0, fp); }
    }
    // goals
    if (sim.needs && !sim.won) {
      var ok = true;
      for (i = 0; i < sim.cups.length; i++) if (sim.cups[i].n > 0 && sim.cups[i].cnt < sim.cups[i].n) ok = false;
      if (ok) { sim.won = true; sim.winT = sim.t; ev(sim, 'win', 0, 0, 0, null); }
    }
    // the end: emitters empty and every marble caught, lost or at rest
    var pending = 0;
    for (i = 0; i < sim.emitters.length; i++) pending += sim.emitters[i].left;
    if (!pending) {
      var busy = false;
      for (i = 0; i < ms.length; i++) if (ms[i].st === 'roll' && ms[i].still < STILL_T) { busy = true; break; }
      if (!busy || sim.t > TMAX || sim.t - sim.prog > IDLE_T) { sim.done = true; ev(sim, 'done', 0, 0, 0, null); }
    } else if (sim.t > TMAX) { sim.done = true; ev(sim, 'done', 0, 0, 0, null); }
    // drop the marbles that are gone for good (keep the array small)
    if (sim.steps % 240 === 0) sim.marbles = ms.filter(function (mm) { return mm.st === 'roll'; });
  }
  function cellPiece(sim, c, r) {
    var L = sim.cells[c + r * COLS];
    if (L.length) return L[0].p;
    for (var i = 0; i < sim.teles.length; i++) if (sim.teles[i].c === c && sim.teles[i].r === r) return sim.teles[i];
    return null;
  }
  function byUid(sim, uid) {
    for (var i = 0; i < sim.pieces.length; i++) if (sim.pieces[i].uid === uid) return sim.pieces[i];
    return null;
  }
  // Teleporters of one colour form a ring in reading order: each sends to the next.
  function partner(sim, p) {
    var L = sim.teles.filter(function (q) { return q.f === p.f; });
    if (L.length < 2) return null;
    L.sort(function (a, b) { return (a.r - b.r) || (a.c - b.c); });
    return L[(L.indexOf(p) + 1) % L.length];
  }

  // Fixed steps from a frame's dt; returns the interpolation fraction.
  function advance(sim, dt) {
    sim.acc = Math.min(sim.acc + dt, 0.1);
    while (sim.acc >= STEP && !sim.done) { stepSim(sim); sim.acc -= STEP; }
    return sim.done ? 1 : sim.acc / STEP;
  }
  // Headless run (tests, level checks).
  function simulate(pieces, maxT) {
    var sim = newSim(pieces), n = Math.ceil((maxT || TMAX + 1) / STEP);
    for (var i = 0; i < n && !sim.done; i++) { stepSim(sim); sim.events.length = 0; }
    return sim;
  }

  // ---- share codes: "MR1-" + base64url(bytes) ----
  // bytes: [cell, type×4 + form] per piece, then a checksum byte.
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function encode(pieces) {
    var by = [];
    pieces.forEach(function (p) {
      if (!TYPE[p.t] || !inBoard(p.c, p.r)) return;
      by.push(p.c + p.r * COLS, TYPE_IX[p.t] * 4 + ((p.f | 0) & 3));
    });
    var sum = 0;
    by.forEach(function (b) { sum = (sum * 31 + b + 7) & 255; });
    by.push(sum);
    var s = '', i;
    for (i = 0; i < by.length; i += 3) {
      var b0 = by[i], b1 = by[i + 1], b2 = by[i + 2], v = (b0 << 16) | ((b1 || 0) << 8) | (b2 || 0);
      s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63];
      if (i + 1 < by.length) s += B64[(v >> 6) & 63];
      if (i + 2 < by.length) s += B64[v & 63];
    }
    return 'MR1-' + s;
  }
  function decode(code) {
    code = String(code || '').replace(/\s+/g, '');
    var m = /^MR1-([A-Za-z0-9_-]*)$/i.exec(code);
    if (!m) return null;
    var s = m[1], by = [], i, acc = 0, bits = 0;
    for (i = 0; i < s.length; i++) {
      var v = B64.indexOf(s.charAt(i));
      if (v < 0) return null;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; by.push((acc >> bits) & 255); }
    }
    if (!by.length || (by.length - 1) % 2) return null;
    var sum = 0;
    for (i = 0; i < by.length - 1; i++) sum = (sum * 31 + by[i] + 7) & 255;
    if (sum !== by[by.length - 1]) return null;
    var out = [];
    for (i = 0; i + 1 < by.length - 1; i += 2) {
      var cell = by[i], tf = by[i + 1], t = TYPES[tf >> 2];
      if (!t || cell >= COLS * ROWS) return null;
      var c = cell % COLS, r = (cell / COLS) | 0;
      if (pieceAt(out, c, r)) continue;
      out.push({ t: t.id, c: c, r: r, f: (tf & 3) % t.forms });
    }
    return out;
  }
  function normPieces(a, max) {
    var out = [];
    if (!Array.isArray(a)) return out;
    a.forEach(function (p) {
      if (!p || !TYPE[p.t]) return;
      var c = p.c | 0, r = p.r | 0;
      if (!inBoard(c, r) || pieceAt(out, c, r) || out.length >= (max || COLS * ROWS)) return;
      out.push({ t: p.t, c: c, r: r, f: Math.abs(p.f | 0) % TYPE[p.t].forms });
    });
    return out;
  }

  // ---- levels ----
  // fixed: the level's own pieces (emitters with n marbles, cups with a need n, walls…);
  // inv: what the player may place; par: pieces for the third star; sol: a known solution (checked in tests).
  function P(t, c, r, f, n) { var o = { t: t, c: c, r: r, f: f || 0 }; if (n != null) o.n = n; return o; }
  function W(cells) { return cells.map(function (a) { return P('wall', a[0], a[1]); }); }
  function row(r, c0, c1) { var o = []; for (var c = c0; c <= c1; c++) o.push([c, r]); return o; }
  function col(c, r0, r1) { var o = []; for (var r = r0; r <= r1; r++) o.push([c, r]); return o; }
  var LEVELS = [
    { name: 'First Drop', hint: 'Pick the ramp, tap a square under the emitter. Tap it again to turn it.',
      fixed: [P('emit', 1, 0, 0, 3), P('cup', 6, 12, 0, 3)], inv: { ramp: 3 }, par: 1,
      sol: [P('ramp', 1, 3, 0)] },
    { name: 'Quarter Pipe', hint: 'A curve turns a falling marble sideways. Which way does it open?',
      fixed: [P('emit', 8, 0, 0, 3), P('cup', 1, 12, 0, 3)].concat(W(col(5, 6, 13))), inv: { curve: 2, ramp: 2 }, par: 1,
      sol: [P('curve', 8, 3, 3)] },
    { name: 'Funnel Vision', hint: 'Two streams, one cup. Where do they cross?',
      fixed: [P('emit', 2, 0, 0, 3), P('emit', 7, 0, 0, 3), P('cup', 4, 12, 0, 5), P('ramp', 2, 3, 2), P('ramp', 7, 3, 3)], inv: { funnel: 2, ramp: 2 }, par: 1,
      sol: [P('funnel', 4, 5)] },
    { name: 'Backstop', hint: 'Too fast! Give the marbles something to bump into.',
      fixed: [P('emit', 0, 0, 0, 3), P('cup', 5, 12, 0, 3), P('ramp', 0, 2, 0), P('ramp', 1, 3, 0)], inv: { wall: 3 }, par: 1,
      sol: [P('wall', 6, 10)] },
    { name: 'Boing', hint: 'Bumpers kick marbles away from their centre — up and over the wall.',
      fixed: [P('emit', 1, 0, 0, 3), P('cup', 8, 5, 0, 3)].concat(W(col(8, 6, 13).concat(col(7, 6, 13)))), inv: { bump: 2, ramp: 2, curve: 1 }, par: 2,
      sol: [P('ramp', 1, 4, 0), P('bump', 4, 7)] },
    { name: 'Spring Step', hint: 'A tilted trampoline throws marbles the way it faces.',
      fixed: [P('emit', 1, 0, 0, 3), P('cup', 8, 12, 0, 3)].concat(W(col(5, 4, 13))), inv: { tramp: 2, ramp: 2 }, par: 1,
      sol: [P('tramp', 1, 4, 2)] },
    { name: 'Conveyor', hint: 'Marbles stop on flat ground. Belts get them moving again.',
      fixed: [P('emit', 1, 0, 0, 3), P('cup', 8, 7, 0, 3)].concat(W(row(8, 3, 9).concat(row(3, 0, 3)))), inv: { belt: 5, ramp: 1 }, par: 2,
      sol: [P('belt', 1, 2, 0), P('belt', 5, 6, 0)] },
    { name: 'Bumper Alley', hint: 'One good bank shot is all it takes.',
      fixed: [P('emit', 8, 0, 0, 4), P('cup', 1, 12, 0, 4), P('bump', 7, 5), P('bump', 4, 4), P('bump', 2, 7), P('bump', 5, 9)], inv: { ramp: 3, wall: 2, curve: 1 }, par: 1,
      sol: [P('ramp', 8, 4, 1)] },
    { name: 'Even Split', hint: 'A splitter sends dead-centre drops left, right, left…',
      fixed: [P('emit', 4, 0, 0, 4), P('cup', 2, 12, 0, 2), P('cup', 6, 12, 0, 2)], inv: { split: 1, ramp: 2, funnel: 2 }, par: 1,
      sol: [P('split', 4, 9)] },
    { name: 'Wormhole', hint: 'In one teleporter, out the other one of the same colour.',
      fixed: [P('emit', 1, 0, 0, 3), P('cup', 8, 12, 0, 3)].concat(W(row(5, 0, 3).concat(col(3, 0, 4)).concat(row(9, 6, 9)).concat(col(6, 10, 13)))), inv: { tele: 2, ramp: 1 }, par: 2,
      sol: [P('tele', 1, 1, 0), P('tele', 8, 10, 0)] },
    { name: 'Up and Over', hint: 'There is a way out of the pit — straight up.',
      fixed: [P('emit', 0, 0, 0, 3), P('cup', 8, 12, 0, 3)].concat(W(row(9, 0, 6).concat(col(6, 5, 8)))), inv: { tramp: 1, belt: 3, ramp: 2 }, par: 1,
      sol: [P('tramp', 0, 5, 2)] },
    { name: 'Crossing', hint: 'Each stream wants the far cup.',
      fixed: [P('emit', 1, 0, 0, 3), P('emit', 8, 0, 0, 3), P('cup', 3, 12, 0, 3), P('cup', 6, 12, 0, 3), P('funnel', 3, 10), P('funnel', 6, 10)].concat(W([[1, 6], [8, 6]])), inv: { ramp: 2, curve: 2 }, par: 2,
      sol: [P('curve', 1, 4, 0), P('curve', 8, 4, 3)] },
    { name: 'Fork', hint: 'A flipper sends one marble left, the next one right.',
      fixed: [P('emit', 4, 0, 0, 6), P('cup', 1, 12, 0, 3), P('cup', 8, 12, 0, 3)], inv: { flip: 1, funnel: 2, ramp: 3, wall: 2 }, par: 3,
      sol: [P('flip', 4, 3, 0), P('funnel', 1, 6), P('funnel', 8, 7)] },
    { name: 'Long Way Round', hint: 'The cup sits in a tunnel. Get inside it.',
      fixed: [P('emit', 1, 0, 0, 3), P('cup', 9, 13, 0, 3)].concat(W(row(9, 3, 9).concat(col(3, 10, 13)).concat(row(13, 4, 8)))), inv: { tele: 2, belt: 2, ramp: 1 }, par: 2,
      sol: [P('tele', 1, 3, 0), P('tele', 9, 11, 0)] },
    { name: 'Zigzag', hint: 'Shelf by shelf, all the way down.',
      fixed: [P('emit', 4, 0, 0, 3), P('cup', 9, 13, 0, 3)].concat(W(row(3, 1, 9).concat(row(6, 0, 8)).concat(row(9, 1, 9)).concat(row(13, 0, 8)))), inv: { belt: 4, ramp: 2 }, par: 4,
      sol: [P('belt', 4, 2, 1), P('belt', 0, 5, 0), P('belt', 9, 8, 1), P('belt', 0, 12, 0)] },
    { name: 'Three Ways', hint: 'Fork, then fork again: three, two and one.',
      fixed: [P('emit', 4, 0, 0, 6), P('cup', 1, 12, 0, 3), P('cup', 5, 12, 0, 2), P('cup', 9, 12, 0, 1)], inv: { funnel: 3, flip: 2, ramp: 2 }, par: 5,
      sol: [P('funnel', 4, 2), P('flip', 4, 4, 0), P('funnel', 1, 7), P('funnel', 7, 7), P('flip', 7, 9, 0)] },
    { name: 'Locked Box', hint: 'Half the marbles belong in the box. It has no door.',
      fixed: [P('emit', 4, 0, 0, 4), P('cup', 1, 12, 0, 2), P('cup', 8, 12, 0, 2)].concat(W(col(7, 5, 13).concat(row(5, 8, 9)))), inv: { funnel: 2, flip: 1, tele: 2, ramp: 1 }, par: 5,
      sol: [P('funnel', 4, 2), P('flip', 4, 4, 0), P('tele', 5, 4, 0), P('tele', 8, 6, 0), P('funnel', 1, 7)] },
    { name: 'Grand Finale', hint: 'Eight marbles, one gap, two cups. Bring them together, then share them out.',
      fixed: [P('emit', 1, 0, 0, 4), P('emit', 8, 0, 0, 4), P('cup', 2, 12, 0, 4), P('cup', 6, 12, 0, 4)].concat(W(row(8, 0, 9).filter(function (a) { return a[0] !== 4; }))),
      inv: { tramp: 1, tele: 2, ramp: 3, curve: 2, funnel: 3, bump: 1, flip: 1 }, par: 4,
      sol: [P('ramp', 1, 7, 2), P('ramp', 8, 7, 3), P('funnel', 4, 9), P('flip', 4, 10, 1)] }
  ];

  function levelPieces(lv, placed) {
    return lv.fixed.map(function (p) { var o = { t: p.t, c: p.c, r: p.r, f: p.f, n: p.n, fx: true }; return o; }).concat(placed || []);
  }
  function invLeft(lv, placed) {
    var left = {};
    Object.keys(lv.inv).forEach(function (k) { left[k] = lv.inv[k]; });
    (placed || []).forEach(function (p) { if (left[p.t] != null) left[p.t]--; });
    return left;
  }
  // Can a piece of type t go at (c, r) in this level?
  function canPlace(lv, placed, t, c, r) {
    if (!inBoard(c, r)) return false;
    if (pieceAt(lv.fixed, c, r) || pieceAt(placed, c, r)) return false;
    if (lv.blocked && lv.blocked.some(function (b) { return b[0] === c && b[1] === r; })) return false;
    var left = invLeft(lv, placed);
    return left[t] > 0;
  }
  function normPlaced(lv, a) {
    var out = [];
    normPieces(a).forEach(function (p) { if (canPlace(lv, out, p.t, p.c, p.r)) out.push(p); });
    return out;
  }
  function starsFor(lv, sim, used) {
    if (!sim.won) return 0;
    return 1 + (used <= lv.par ? 1 : 0) + (sim.caught >= sim.total ? 1 : 0);
  }

  // ---- the save ----
  var SLOTS = 4;
  function newSave() {
    var s = { v: 1, stars: [], placed: [], sandbox: [], slots: [], cur: 0, runs: 0, caught: 0 };
    for (var i = 0; i < SLOTS; i++) s.slots.push(null);
    for (i = 0; i < LEVELS.length; i++) { s.stars.push(0); s.placed.push([]); }
    return s;
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    s.runs = Math.max(0, +o.runs | 0); s.caught = Math.max(0, +o.caught | 0);
    for (var i = 0; i < LEVELS.length; i++) {
      s.stars[i] = Array.isArray(o.stars) ? clamp(+o.stars[i] | 0, 0, 3) : 0;
      s.placed[i] = Array.isArray(o.placed) ? normPlaced(LEVELS[i], o.placed[i]) : [];
    }
    s.cur = clamp(+o.cur | 0, 0, LEVELS.length - 1);
    s.sandbox = normPieces(o.sandbox);
    if (Array.isArray(o.slots)) for (i = 0; i < SLOTS; i++) {
      var sl = o.slots[i];
      if (sl && typeof sl === 'object' && Array.isArray(sl.pieces)) {
        s.slots[i] = { name: String(sl.name || 'Slot ' + (i + 1)).slice(0, 24), t: +sl.t || 0, pieces: normPieces(sl.pieces) };
      }
    }
    return s;
  }
  // The first three levels are open; after that you may leave at most two unsolved behind you.
  function unlocked(save, i) {
    if (i < 3) return true;
    var n = 0;
    for (var k = 0; k < i; k++) if (save.stars[k]) n++;
    return n >= i - 2;
  }
  function totalStars(save) { var n = 0; for (var i = 0; i < save.stars.length; i++) n += save.stars[i] || 0; return n; }

  var ENGINE = {
    COLS: COLS, ROWS: ROWS, R: R, G: G, STEP: STEP, MAXV: MAXV, TMAX: TMAX, IDLE_T: IDLE_T, TYPES: TYPES, TYPE: TYPE, LEVELS: LEVELS, EMIT_COUNTS: EMIT_COUNTS, SLOTS: SLOTS,
    geo: geo, rot: rot, newSim: newSim, stepSim: stepSim, advance: advance, simulate: simulate, closest: closest, collide: collide,
    encode: encode, decode: decode, normPieces: normPieces, pieceAt: pieceAt, inBoard: inBoard, emitCount: emitCount,
    levelPieces: levelPieces, invLeft: invLeft, canPlace: canPlace, normPlaced: normPlaced, starsFor: starsFor,
    newSave: newSave, normSave: normSave, unlocked: unlocked, totalStars: totalStars, partner: partner, P: P
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('marblerun.css');

  var PANEL_ID = 'marblerun-panel', NAME = 'Marble Run';
  var KEY = 'cade-marblerun-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.marblerun = { live: function () { return S; } };   // test-only peek

  // palette slots, filled from the theme
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOLD = 4, C_RED = 5, C_SKY = 6, C_LEAF = 7, C_VIOLET = 8, C_EMBER = 9, C_BG = 10, NPAL = 11;
  var HUES = [C_ACC, C_RED, C_SKY, C_GOLD, C_LEAF, C_VIOLET];
  var TELE_HUE = [C_VIOLET, C_GOLD, C_SKY];
  // the little machine that plays behind the menus
  var DEMO = [P('emit', 4, 0, 3), P('funnel', 4, 2), P('split', 4, 4), P('ramp', 2, 6, 1), P('ramp', 7, 6, 0), P('bump', 1, 9), P('bump', 8, 9),
    P('tele', 6, 3, 0), P('belt', 5, 9, 1), P('cup', 1, 13), P('cup', 7, 13), P('cup', 4, 13)];
  var NOSND = { tone: function () {}, limit: function () { return false; }, ensure: function () {} };

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !o };
  }
  function persist() {
    if (!S) return;
    clearTimeout(S.saveT);
    S.saveT = setTimeout(function () { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }, 250);
  }
  function persistNow() { if (S) { clearTimeout(S.saveT); sset(SAVE_KEY, JSON.stringify(S.save)); } }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---- sound: a tiny WebAudio voice, created on a user gesture (iOS), closed with the panel ----
  function Snd(on) { this.on = !!on; this.ac = null; this.last = {}; }
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
  // at most one of a kind every `gap` seconds (a pile of marbles would otherwise roar)
  Snd.prototype.limit = function (kind, gap) {
    var ac = this.ac;
    if (!this.on || !ac) return false;
    var now = ac.currentTime;
    if (this.last[kind] && now - this.last[kind] < gap) return false;
    this.last[kind] = now;
    return true;
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_MENU = svg('<path d="M4 6h16M4 12h16M4 18h16"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_STOP = svg('<rect x="6" y="6" width="12" height="12" rx="1"/>', true);
  var IC_ROT = svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>');
  var IC_DEL = svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>');
  var IC_RESET = svg('<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/>');

  // A part as a little SVG (the same geometry the physics uses).
  function partSvg(t, f, sz) {
    var parts = [], k = 22, o = 1, i;
    function P2(x, y) { return (o + x * k).toFixed(1) + ' ' + (o + y * k).toFixed(1); }
    if (t === 'emit') {
      parts.push('<path d="M' + P2(0.15, 0.15) + 'L' + P2(0.38, 0.55) + 'M' + P2(0.85, 0.15) + 'L' + P2(0.62, 0.55) + '"/>');
      parts.push('<circle cx="' + (o + 0.5 * k) + '" cy="' + (o + 0.72 * k) + '" r="' + (R * k) + '" fill="currentColor" stroke="none"/>');
      // how many it drops (its form): turning an emitter cycles 1, 3, 6, 10
      parts.push('<text x="' + (o + 1.02 * k) + '" y="' + (o + 1.0 * k) + '" text-anchor="end" font-size="8" font-weight="700" fill="currentColor" stroke="none">' + EMIT_COUNTS[f & 3] + '</text>');
    } else if (t === 'tele') {
      parts.push('<circle cx="' + (o + 0.5 * k) + '" cy="' + (o + 0.5 * k) + '" r="' + (0.34 * k) + '" stroke-dasharray="3 2.4"/>');
      parts.push('<text x="' + (o + 0.5 * k) + '" y="' + (o + 0.5 * k + 3.6) + '" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor" stroke="none">' + 'ABC'.charAt(f) + '</text>');
    } else if (t === 'wall') {
      parts.push('<rect x="' + (o + 0.06 * k) + '" y="' + (o + 0.06 * k) + '" width="' + (0.88 * k) + '" height="' + (0.88 * k) + '" rx="1.5" fill="currentColor" fill-opacity="0.25"/>');
    } else {
      var G2 = geo(t, f);
      for (i = 0; i < G2.length; i++) {
        var g = G2[i];
        if (g.g === 's') parts.push('<path d="M' + P2(g.ax, g.ay) + 'L' + P2(g.bx, g.by) + '"/>');
        else if (g.g === 'a') {
          var x0 = g.cx + Math.cos(g.a0) * g.r, y0 = g.cy + Math.sin(g.a0) * g.r, x1 = g.cx + Math.cos(g.a1) * g.r, y1 = g.cy + Math.sin(g.a1) * g.r;
          parts.push('<path d="M' + P2(x0, y0) + 'A' + (g.r * k) + ' ' + (g.r * k) + ' 0 0 1 ' + P2(x1, y1) + '"/>');
        } else if (g.g === 'd') parts.push('<circle cx="' + (o + g.cx * k) + '" cy="' + (o + g.cy * k) + '" r="' + (g.r * k) + '" fill="currentColor" fill-opacity="0.3"/>');
      }
      if (t === 'belt') parts.push('<path d="M' + P2(f ? 0.62 : 0.38, 0.38) + 'L' + P2(f ? 0.42 : 0.58, 0.5) + 'L' + P2(f ? 0.62 : 0.38, 0.62) + '" stroke-width="1.6"/>');
      if (t === 'flip') parts.push('<circle cx="' + (o + 0.5 * k) + '" cy="' + (o + 0.5 * k) + '" r="2.2" fill="currentColor"/>');
    }
    return '<svg viewBox="0 0 24 24" width="' + (sz || 22) + '" height="' + (sz || 22) + '" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + parts.join('') + '</svg>';
  }

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
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.6)), fa = parseCol(v('--text-faint'), mix(bg, tx, 0.38));
    var sf = parseCol(v('--surface'), mix(bg, tx, 0.04)), bd = parseCol(v('--border'), mix(bg, tx, 0.15));
    var P = S.pal, rgb = S.rgb;
    S.dark = dark;
    rgb[C_TEXT] = tx; rgb[C_MUTED] = mu; rgb[C_FAINT] = fa; rgb[C_ACC] = ac; rgb[C_BG] = bg;
    rgb[C_GOLD] = parseCol(dark ? '#f2c544' : '#b07d06'); rgb[C_RED] = parseCol(dark ? '#f06a6a' : '#cf3f3f');
    rgb[C_SKY] = parseCol(dark ? '#7cc7f2' : '#2878b5'); rgb[C_LEAF] = parseCol(dark ? '#7ed37a' : '#2f8f3a');
    rgb[C_VIOLET] = parseCol(dark ? '#b79cf5' : '#7351c4'); rgb[C_EMBER] = parseCol(dark ? '#ff8f3f' : '#e2611f');
    for (var i = 0; i < NPAL; i++) P[i] = css(rgb[i]);
    S.col = {
      bg: css(bg), board: css(mix(bg, tx, dark ? 0.035 : 0.025)), grid: css(mix(bg, tx, dark ? 0.2 : 0.16)),
      fixedBg: css(mix(bg, tx, dark ? 0.08 : 0.06)), wall: css(mix(bg, tx, dark ? 0.2 : 0.16)), wallEdge: css(mix(bg, tx, dark ? 0.42 : 0.4)),
      surface: css(sf), border: css(bd), accSoft: css(ac, 0.16), accLine: css(ac, 0.55), bad: css(rgb[C_RED], 0.22),
      hi: dark ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.75)', shade: dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
      font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace'
    };
    buildAtlas();
  }

  // ---- glyphs: each (colour, character) is rendered once into an atlas canvas ----
  var AT_COLS = 16, AT_ROWS = 12;
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.col || !S.px) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    a.cell = Math.max(8, Math.ceil(S.px * 0.62));            // device px per glyph cell (~0.5 board cell font)
    a.cv.width = a.cell * AT_COLS; a.cv.height = a.cell * AT_ROWS;
    a.c = a.cv.getContext('2d');
    a.c.font = '700 ' + Math.round(a.cell * 0.78) + 'px ' + S.col.font;
    a.c.textAlign = 'center'; a.c.textBaseline = 'middle';
    a.n = 0; a.max = AT_COLS * AT_ROWS;
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
    a.c.fillText(String.fromCharCode(code), (i % AT_COLS) * a.cell + a.cell / 2, ((i / AT_COLS) | 0) * a.cell + a.cell / 2 + a.cell * 0.04);
    m[code] = i;
    return i;
  }
  // a glyph centred on (x, y) in board cells; sz = its box in cells (default 0.62)
  function glyph(c, ci, ch, x, y, sz) {
    var code = ch.charCodeAt(0);
    if (code === 32) return;
    var i = gIdx(ci, code), a = S.atl, w = sz || 0.62;
    if (i < 0) {
      c.font = '700 ' + (w * 0.78) + 'px ' + S.col.font; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = S.pal[ci];
      c.fillText(ch, x, y);
      return;
    }
    c.drawImage(a.cv, (i % AT_COLS) * a.cell, ((i / AT_COLS) | 0) * a.cell, a.cell, a.cell, x - w / 2, y - w / 2, w, w);
  }
  function text(c, ci, s, x, y, sz, align) {
    var w = sz || 0.62, adv = w * 0.5, n = s.length, x0 = align === 'left' ? x : align === 'right' ? x - n * adv : x - n * adv / 2;
    for (var i = 0; i < n; i++) glyph(c, ci, s.charAt(i), x0 + adv * (i + 0.5), y, w);
  }

  // ---- particles ----
  function spark(x, y, vx, vy, life, ch, ci) {
    if (S.fx.length > 220 || S.rm) return;
    S.fx.push({ x: x, y: y, vx: vx, vy: vy, t: life, life: life, ch: ch, ci: ci });
  }
  function burst(x, y, n, sp, chs, ci, life) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = sp * (0.4 + Math.random() * 0.6);
      spark(x, y, Math.cos(a) * v, Math.sin(a) * v - sp * 0.3, (life || 0.6) * (0.6 + Math.random() * 0.5), chs.charAt(i % chs.length), ci);
    }
  }
  function stepFx(dt) {
    for (var i = S.fx.length - 1; i >= 0; i--) {
      var p = S.fx[i];
      p.t -= dt;
      if (p.t <= 0) { S.fx.splice(i, 1); continue; }
      p.vy += 9 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (i = S.pops.length - 1; i >= 0; i--) { S.pops[i].t -= dt; if (S.pops[i].t <= 0) S.pops.splice(i, 1); }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt * 3);
  }

  // ---- the board being edited ----
  function lv() { return S.mode === 'level' ? LEVELS[S.li] : null; }
  function placedList() { return S.mode === 'level' ? S.save.placed[S.li] : S.save.sandbox; }
  function allPieces() { return S.mode === 'level' ? levelPieces(lv(), placedList()) : placedList(); }
  function fixedAt(c, r) { return S.mode === 'level' ? pieceAt(lv().fixed, c, r) : null; }
  function leftOf(t) {
    if (S.mode !== 'level') return Infinity;
    var l = invLeft(lv(), placedList());
    return l[t] || 0;
  }
  function trayTypes() {
    if (S.mode === 'level') return TYPES.filter(function (t) { return lv().inv[t.id] != null; }).map(function (t) { return t.id; });
    return TYPES.map(function (t) { return t.id; });
  }
  function blockedCell(c, r) {
    var L = lv();
    return !!(L && L.blocked && L.blocked.some(function (b) { return b[0] === c && b[1] === r; }));
  }
  function freeCell(c, r, except) {
    if (!inBoard(c, r) || fixedAt(c, r) || blockedCell(c, r)) return false;
    var p = pieceAt(placedList(), c, r);
    return !p || p === except;
  }
  function canDrop(t, c, r) { return freeCell(c, r) && leftOf(t) > 0; }

  function edited() {
    // any edit drops a finished / stopped run's marbles back to the editor
    if (S.sim) { S.sim = null; S.fx.length = 0; S.result = null; }
    persist(); syncAll();
  }
  function placePiece(t, c, r) {
    if (!canDrop(t, c, r)) return null;
    var p = { t: t, c: c, r: r, f: (S.form[t] || 0) % TYPE[t].forms };
    placedList().push(p);
    S.sel = p;
    S.snd.ensure(); S.snd.tone(740, 0.05, 'triangle', 0.035); S.snd.tone(990, 0.06, 'triangle', 0.03, 0, 0.04);
    if (Cade.haptic) Cade.haptic(6);
    pulse(c, r);
    edited();
    return p;
  }
  function removePiece(p) {
    var L = placedList(), i = L.indexOf(p);
    if (i < 0) return;
    L.splice(i, 1);
    if (S.sel === p) S.sel = null;
    S.snd.tone(330, 0.07, 'triangle', 0.03, 200);
    burst(p.c + 0.5, p.r + 0.5, 6, 3, '.:', C_FAINT, 0.4);
    edited();
  }
  function rotatePiece(p) {
    p.f = (p.f + 1) % TYPE[p.t].forms;
    S.form[p.t] = p.f;
    S.snd.ensure(); S.snd.tone(880, 0.04, 'square', 0.02);
    S.rotAnim = { p: p, t: 0.14 };
    edited();
  }
  function pulse(c, r) { S.pulse = { c: c, r: r, t: 0.25 }; }

  // ---- the run ----
  function play() {
    if (S.sim && !S.sim.done && S.running) { stopRun(); return; }
    S.snd.ensure();
    S.sim = newSim(allPieces());
    S.sim.total = S.sim.total || 0;
    S.result = null; S.winShown = false; S.endT = 0;
    if (!S.sim.emitters.length) {
      Cade.showToast && Cade.showToast('Add an emitter first — it drops the marbles', 'info', 1800);
      S.sim = null; return;
    }
    S.running = true; S.paused = false; S.sel = null; S.drag = null;
    S.save.runs++; persist();
    showCard(null);
    syncAll();
    kick();
  }
  function stopRun() {
    S.running = false; S.paused = false;
    S.sim = null; S.fx.length = 0; S.result = null;
    stopLoop(); showCard(null); syncAll(); redraw();
  }
  function finishRun() {
    var sim = S.sim;
    S.running = false;
    S.save.caught += sim.caught;
    if (S.mode === 'level') {
      var L = lv(), used = placedList().length, st = starsFor(L, sim, used), prev = S.save.stars[S.li] || 0;
      S.result = { won: sim.won, stars: st, prev: prev, caught: sim.caught, total: sim.total, used: used, par: L.par, need: needOf(L), cupsOk: cupsMet(sim) };
      if (st > prev) S.save.stars[S.li] = st;
      persistNow();
      showCard('result');
      announce(sim.won ? 'Level clear — ' + st + ' of 3 stars' : 'Not yet: ' + sim.caught + ' marbles caught');
    } else {
      persist();
      S.result = { sandbox: true, caught: sim.caught, lost: sim.lost, total: sim.total, rest: sim.total - sim.caught - sim.lost };
      announce('Run over: ' + sim.caught + ' caught, ' + sim.lost + ' lost');
    }
    syncAll(); redraw();
  }
  function needOf(L) { var n = 0; L.fixed.forEach(function (p) { if (p.t === 'cup') n += p.n || 0; }); return n; }
  function cupsMet(sim) { var a = 0; sim.cups.forEach(function (c) { if (c.n > 0 && c.cnt >= c.n) a++; }); return a; }

  function pause() {
    if (S && S.demo) { stopLoop(); return; }
    if (!S || !S.running || S.paused) return;
    S.paused = true; stopLoop();
    showCard('pause'); syncAll();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false; showCard(null); syncAll(); kick();
  }

  // ---- loop: runs only while marbles roll (or the last sparks fade) ----
  function live() {
    return !!S && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)) &&
      (S.running || S.fx.length > 0 || S.pops.length > 0 || animBusy());
  }
  function animBusy() {
    if (S.rotAnim || S.pulse) return true;
    if (!S.sim) return false;
    for (var i = 0; i < S.sim.pieces.length; i++) { var p = S.sim.pieces[i]; if (p.flash > 0 || p.anim > 0) return true; }
    return false;
  }
  function kick() { if (S && !S.raf && live()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!live()) { draw(1); return; }
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 1 / 60;
    S.last = ts;
    S.clock += dt;
    var alpha = 1;
    if (S.running && S.sim) {
      alpha = advance(S.sim, dt * S.speed);
      handleEvents(S.sim);
      if (S.sim.won && !S.winShown) { S.winShown = true; S.endT = 0; }
      if (S.sim.won) S.endT += dt;
      if (!S.demo && S.sim.caught + S.sim.lost !== S.lastCount) { S.lastCount = S.sim.caught + S.sim.lost; syncTop(); }
      if (S.demo) {
        // a few rounds, then it rests (the loop stops) until the menu is shown again
        if (S.sim.done) { S.endT += dt; if (S.endT > 1.4) { if (++S.demoN < 3) { S.sim = newSim(DEMO); S.endT = 0; } else S.running = false; } }
      } else if (S.sim.done || (S.sim.won && S.endT > 8)) { finishRun(); }   // after a win, let the stragglers land (they count for the third star)
    }
    if (S.sim) S.sim.pieces.forEach(function (p) {
      if (p.flash > 0) p.flash = Math.max(0, p.flash - dt * 4);
      if (p.anim > 0) p.anim = Math.max(0, p.anim - dt * 7);
    });
    if (S.rotAnim) { S.rotAnim.t -= dt; if (S.rotAnim.t <= 0) S.rotAnim = null; }
    if (S.pulse) { S.pulse.t -= dt; if (S.pulse.t <= 0) S.pulse = null; }
    stepFx(dt);
    draw(alpha);
    if (live()) S.raf = requestAnimationFrame(frame);
  }

  function handleEvents(sim) {
    var snd = S.demo ? NOSND : S.snd, evs = sim.events;
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      switch (e.k) {
        case 'hit':
          if (e.s > 4) burst(e.x, e.y, 2, 2, '.', C_FAINT, 0.3);
          if (snd.limit('hit', 0.035)) snd.tone(260 + Math.min(e.s, 20) * 28, 0.035, 'triangle', Math.min(0.035, 0.006 + e.s * 0.002));
          break;
        case 'clack':
          if (snd.limit('clack', 0.04)) snd.tone(1900 + Math.random() * 300, 0.025, 'square', 0.012);
          break;
        case 'bump':
          burst(e.x, e.y, 6, 5, '*+', C_GOLD, 0.45); if (!S.demo) S.shake = Math.min(1, S.shake + 0.25);
          if (snd.limit('bump', 0.05)) snd.tone(260, 0.12, 'square', 0.03, 780);
          break;
        case 'tramp':
          burst(e.x, e.y, 5, 4, '^\'', C_LEAF, 0.4);
          if (snd.limit('tramp', 0.05)) snd.tone(170, 0.2, 'sine', 0.05, 560);
          break;
        case 'catch': {
          var p = e.p, cl = p.n > 0 && p.cnt === p.n;
          burst(e.x, e.y - 0.2, cl ? 14 : 7, cl ? 6 : 4, cl ? '*+o' : '+.', cl ? C_GOLD : C_LEAF, 0.6);
          if (!S.demo) S.pops.push({ x: p.c + 0.5, y: p.r - 0.1, s: '+1', t: 0.8, ci: C_LEAF });
          var nt = Math.min(p.cnt, 12);
          snd.tone(523 * Math.pow(2, nt / 12 * 2), 0.11, 'triangle', 0.04);
          snd.tone(784 * Math.pow(2, nt / 12 * 2), 0.14, 'sine', 0.025, 0, 0.05);
          if (Cade.haptic && !S.demo) Cade.haptic(5);
          break;
        }
        case 'lost':
          burst(e.x, e.y - 0.1, 4, 2.5, '.,', C_RED, 0.5);
          if (snd.limit('lost', 0.08)) snd.tone(140, 0.16, 'sine', 0.04, 70);
          break;
        case 'tele':
          burst(e.x, e.y, 6, 3, '~*', TELE_HUE[e.p.f] || C_VIOLET, 0.4);
          if (snd.limit('tele', 0.05)) snd.tone(1100, 0.14, 'sine', 0.03, 260);
          break;
        case 'teleout':
          burst(e.x, e.y, 6, 3, '~*', TELE_HUE[e.p.f] || C_VIOLET, 0.4);
          snd.tone(260, 0.14, 'sine', 0.03, 1100, 0.06);
          break;
        case 'flip':
          if (snd.limit('flip', 0.03)) snd.tone(1250, 0.03, 'square', 0.02);
          break;
        case 'spawn':
          if (snd.limit('spawn', 0.05)) snd.tone(620, 0.04, 'sine', 0.02, 820);
          break;
        case 'win':
          [523, 659, 784, 1047, 1319].forEach(function (fq, j) { snd.tone(fq, 0.14, 'triangle', 0.04, 0, j * 0.08); });
          S.sim.cups.forEach(function (cp) { burst(cp.c + 0.5, cp.r + 0.4, 12, 7, '*+o', C_GOLD, 0.9); });
          S.pops.push({ x: COLS / 2, y: ROWS / 2 - 1, s: 'CLEAR!', t: 1.6, ci: C_ACC, big: true });
          break;
      }
    }
    evs.length = 0;
  }

  // ---- drawing (board units: one cell = 1) ----
  function draw(alpha) {
    if (!S || !S.ctx || !S.col) return;
    var c = S.ctx, k = S.px, col = S.col, P = S.pal, i;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, S.cv.width, S.cv.height);
    var sx = 0, sy = 0;
    if (S.shake > 0 && !S.rm) { sx = (Math.random() - 0.5) * S.shake * 0.12; sy = (Math.random() - 0.5) * S.shake * 0.12; }
    c.setTransform(k, 0, 0, k, sx * k, sy * k);
    c.fillStyle = col.board; c.fillRect(0, 0, COLS, ROWS);
    // grid dots at the corners
    c.fillStyle = col.grid;
    var dot = Math.max(1.2 / k, 0.035);
    for (var gy = 1; gy < ROWS; gy++) for (var gx = 1; gx < COLS; gx++) c.fillRect(gx - dot / 2, gy - dot / 2, dot, dot);
    var L = lv();
    // locked cells and the level's own pieces get a tint
    if (L) {
      c.fillStyle = col.fixedBg;
      L.fixed.forEach(function (p) { if (p.t !== 'wall') c.fillRect(p.c + 0.03, p.r + 0.03, 0.94, 0.94); });
      if (L.blocked) { c.fillStyle = col.bad; L.blocked.forEach(function (b) { c.fillRect(b[0] + 0.1, b[1] + 0.1, 0.8, 0.8); }); }
    }
    // hover / brush ghost / keyboard cursor
    var editing = !S.running && !S.cardKind;
    if (editing && S.hover && !S.drag && !S.trayDrag && S.brush && inBoard(S.hover.c, S.hover.r) && !pieceAt(allPieces(), S.hover.c, S.hover.r)) {
      var okH = canDrop(S.brush, S.hover.c, S.hover.r);
      c.fillStyle = okH ? col.accSoft : col.bad; c.fillRect(S.hover.c, S.hover.r, 1, 1);
      if (okH) { c.globalAlpha = 0.45; drawPiece(c, { t: S.brush, c: S.hover.c, r: S.hover.r, f: (S.form[S.brush] || 0) % TYPE[S.brush].forms }, false, null); c.globalAlpha = 1; }
    }
    // the pieces: live ones from the sim while it runs (flippers flip, cups count)
    var sim = S.sim, list = sim ? sim.pieces : allPieces(), byCell = {};
    if (sim) { var src = allPieces(); src.forEach(function (p) { byCell[p.c + ',' + p.r] = p; }); }
    for (i = 0; i < list.length; i++) {
      var p = list[i], orig = sim ? byCell[p.c + ',' + p.r] : p, fixed = orig && (orig.fx || (L && pieceAt(L.fixed, p.c, p.r)));
      if (S.drag && S.drag.moved && orig === S.drag.p) continue;
      drawPiece(c, p, !!fixed, sim);
    }
    // selection
    if (editing && S.sel && placedList().indexOf(S.sel) >= 0 && !(S.drag && S.drag.moved)) {
      c.strokeStyle = P[C_ACC]; c.lineWidth = 0.05; c.setLineDash([0.16, 0.1]);
      c.strokeRect(S.sel.c + 0.04, S.sel.r + 0.04, 0.92, 0.92); c.setLineDash([]);
    }
    if (editing && S.cursor && S.kbd) {
      c.strokeStyle = P[C_TEXT]; c.lineWidth = 0.04; c.setLineDash([0.08, 0.08]);
      c.strokeRect(S.cursor.c + 0.08, S.cursor.r + 0.08, 0.84, 0.84); c.setLineDash([]);
    }
    if (S.pulse) {
      var pt = S.pulse.t / 0.25;
      c.strokeStyle = col.accLine; c.lineWidth = 0.05; c.globalAlpha = pt;
      var g2 = 0.5 + (1 - pt) * 0.2;
      c.strokeRect(S.pulse.c + 0.5 - g2, S.pulse.r + 0.5 - g2, g2 * 2, g2 * 2); c.globalAlpha = 1;
    }
    // drag ghost
    var dg = S.drag && S.drag.moved ? { t: S.drag.p.t, f: S.drag.p.f, x: S.drag.x, y: S.drag.y, ok: S.drag.ok, cc: S.drag.cc }
      : S.trayDrag && S.trayDrag.over ? { t: S.trayDrag.t, f: (S.form[S.trayDrag.t] || 0) % TYPE[S.trayDrag.t].forms, x: S.trayDrag.x, y: S.trayDrag.y, ok: S.trayDrag.ok, cc: S.trayDrag.cc } : null;
    if (dg) {
      if (dg.cc && inBoard(dg.cc.c, dg.cc.r)) { c.fillStyle = dg.ok ? col.accSoft : col.bad; c.fillRect(dg.cc.c, dg.cc.r, 1, 1); }
      c.globalAlpha = 0.8;
      drawPiece(c, { t: dg.t, c: dg.x - 0.5, r: dg.y - 0.5, f: dg.f }, false, null);
      c.globalAlpha = 1;
    }
    // marbles
    if (sim) {
      var ms = sim.marbles;
      for (i = 0; i < ms.length; i++) {
        var m = ms[i];
        if (m.st !== 'roll') continue;
        var x = m.px + (m.x - m.px) * alpha, y = m.py + (m.y - m.py) * alpha;
        drawMarble(c, x, y, HUES[m.hue % HUES.length]);
      }
    }
    // particles and pop-ups
    for (i = 0; i < S.fx.length; i++) {
      var f = S.fx[i];
      c.globalAlpha = Math.max(0, Math.min(1, f.t / f.life * 1.5));
      glyph(c, f.ci, f.ch, f.x, f.y, 0.42);
    }
    c.globalAlpha = 1;
    for (i = 0; i < S.pops.length; i++) {
      var pp = S.pops[i], u = pp.t;
      c.globalAlpha = Math.min(1, u * 2);
      if (pp.big) {
        var w = pp.s.length * 0.9 * 0.5 + 0.9;
        c.fillStyle = col.surface; c.fillRect(COLS / 2 - w / 2, pp.y - 0.65, w, 1.3);
        c.strokeStyle = P[C_ACC]; c.lineWidth = 0.05; c.strokeRect(COLS / 2 - w / 2, pp.y - 0.65, w, 1.3);
        text(c, pp.ci, pp.s, COLS / 2, pp.y, 0.9);
      } else text(c, pp.ci, pp.s, pp.x, pp.y - (0.8 - u) * 0.8, 0.5);
    }
    c.globalAlpha = 1;
  }

  function drawMarble(c, x, y, ci) {
    var rgb = S.rgb[ci];
    c.fillStyle = S.col.shade;
    c.beginPath(); c.arc(x + 0.03, y + 0.04, R, 0, Math.PI * 2); c.fill();
    c.fillStyle = S.pal[ci];
    c.beginPath(); c.arc(x, y, R, 0, Math.PI * 2); c.fill();
    c.fillStyle = css(mix(rgb, S.rgb[C_TEXT], 0.35));
    c.beginPath(); c.arc(x, y, R, 0.2, Math.PI * 0.9); c.lineWidth = 0.035; c.strokeStyle = c.fillStyle; c.stroke();
    c.fillStyle = S.col.hi;
    c.beginPath(); c.arc(x - R * 0.35, y - R * 0.38, R * 0.3, 0, Math.PI * 2); c.fill();
  }

  function drawPiece(c, p, fixed, sim) {
    var P = S.pal, col = S.col, x = p.c, y = p.r, t = p.t, f = p.f | 0, lw = 0.085;
    var ci = fixed ? C_TEXT : C_ACC, stroke = P[ci];
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = stroke; c.lineWidth = lw;
    var fl = p.flash || 0, i;
    if (t === 'wall') {
      c.fillStyle = col.wall; c.fillRect(x + 0.02, y + 0.02, 0.96, 0.96);
      c.strokeStyle = fixed ? col.wallEdge : P[C_ACC]; c.lineWidth = 0.04; c.strokeRect(x + 0.04, y + 0.04, 0.92, 0.92);
      glyph(c, fixed ? C_FAINT : C_ACC, '#', x + 0.5, y + 0.52, 0.55);
      return;
    }
    if (t === 'emit') {
      c.beginPath(); c.moveTo(x + 0.12, y + 0.08); c.lineTo(x + 0.36, y + 0.42); c.moveTo(x + 0.88, y + 0.08); c.lineTo(x + 0.64, y + 0.42); c.stroke();
      var left = sim ? p.left : emitCount(p);
      if (left > 0 && !(sim && fl > 0.5)) drawMarble(c, x + 0.5, y + 0.24, HUES[0]);
      text(c, fixed ? C_MUTED : C_ACC, 'x' + left, x + 0.5, y + 0.9, 0.34);
      return;
    }
    if (t === 'cup') {
      c.lineWidth = 0.1;
      var G0 = geo('cup', 0);
      c.beginPath(); c.moveTo(x + G0[0].ax, y + G0[0].ay); c.lineTo(x + G0[0].bx, y + G0[0].by); c.lineTo(x + G0[2].ax, y + G0[2].ay); c.lineTo(x + G0[2].bx, y + G0[2].by);
      var full = p.n > 0 && sim && p.cnt >= p.n;
      c.strokeStyle = full ? P[C_LEAF] : fl > 0 ? P[C_GOLD] : stroke; c.stroke();
      // the marbles in it, stacked
      var cnt = sim ? p.cnt : 0, shown = Math.min(cnt, 6);
      for (i = 0; i < shown; i++) {
        var row = (i / 3) | 0, cx = x + 0.29 + (i % 3) * 0.21 + (row % 2) * 0.1, cy = y + 0.8 - row * 0.17;
        c.fillStyle = P[HUES[i % HUES.length]]; c.beginPath(); c.arc(cx, cy, 0.1, 0, Math.PI * 2); c.fill();
      }
      var lab = p.n > 0 ? cnt + '/' + p.n : String(cnt);
      if (p.n > 0 || sim) text(c, full ? C_LEAF : C_MUTED, lab, x + 0.5, y + 0.38, 0.4);
      return;
    }
    if (t === 'tele') {
      var hc = TELE_HUE[f] || C_VIOLET, spin = sim ? S.clock * 2.5 : 0;
      c.strokeStyle = P[hc]; c.lineWidth = 0.07;
      c.setLineDash([0.22, 0.14]); c.lineDashOffset = -spin;
      c.beginPath(); c.arc(x + 0.5, y + 0.5, 0.34 + fl * 0.06, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]); c.lineDashOffset = 0;
      if (!fixed) { c.strokeStyle = P[C_ACC]; c.lineWidth = 0.025; c.beginPath(); c.arc(x + 0.5, y + 0.5, 0.44, 0, Math.PI * 2); c.stroke(); }
      glyph(c, hc, 'ABC'.charAt(f), x + 0.5, y + 0.52, 0.5);
      return;
    }
    if (t === 'bump') {
      var br = 0.26 + fl * 0.07;
      c.fillStyle = S.col.accSoft; if (fixed) c.fillStyle = col.fixedBg;
      c.beginPath(); c.arc(x + 0.5, y + 0.5, br, 0, Math.PI * 2); c.fill();
      c.strokeStyle = fl > 0 ? P[C_GOLD] : stroke; c.lineWidth = 0.07; c.stroke();
      glyph(c, fl > 0 ? C_GOLD : ci, '*', x + 0.5, y + 0.53, 0.5);
      return;
    }
    if (t === 'flip') {
      // swings between its two sides; `anim` eases the swing after a flip
      var a1 = Math.atan2(0.52, 0.76), cur = f === 0 ? a1 : -a1;
      if (p.anim > 0) cur = cur + (f === 0 ? -1 : 1) * 2 * a1 * p.anim * p.anim;
      if (S.rotAnim && S.rotAnim.p === p) cur += (f === 0 ? -1 : 1) * 2 * a1 * (S.rotAnim.t / 0.14);
      var hl = Math.sqrt(0.76 * 0.76 + 0.52 * 0.52) / 2, dx = Math.cos(cur) * hl, dy = Math.sin(cur) * hl;
      c.beginPath(); c.moveTo(x + 0.5 - dx, y + 0.5 - dy); c.lineTo(x + 0.5 + dx, y + 0.5 + dy); c.stroke();
      c.fillStyle = stroke; c.beginPath(); c.arc(x + 0.5, y + 0.5, 0.07, 0, Math.PI * 2); c.fill();
      glyph(c, fixed ? C_FAINT : C_ACC, f === 0 ? '>' : '<', x + 0.5, y + 0.2, 0.34);
      return;
    }
    if (t === 'belt') {
      var by = y + 0.72;
      c.lineWidth = 0.07;
      c.beginPath(); c.moveTo(x, by); c.lineTo(x + 1, by); c.moveTo(x + 0.06, by + 0.16); c.lineTo(x + 0.94, by + 0.16); c.stroke();
      c.lineWidth = 0.035;
      c.beginPath(); c.arc(x + 0.08, by + 0.08, 0.08, 0, Math.PI * 2); c.moveTo(x + 1, by + 0.08); c.arc(x + 0.92, by + 0.08, 0.08, 0, Math.PI * 2); c.stroke();
      var off = sim ? (S.clock * 1.6) % 1 : 0, dir = f === 0 ? 1 : -1;
      for (i = 0; i < 2; i++) {
        var u = (i * 0.5 + off * dir + 1) % 1, gx2 = x + 0.18 + u * 0.64;
        glyph(c, fixed ? C_FAINT : C_MUTED, dir > 0 ? '>' : '<', gx2, by + 0.08, 0.26);
      }
      return;
    }
    if (t === 'tramp') {
      var G1 = geo('tramp', f)[0], ax = x + G1.ax, ay = y + G1.ay, bx = x + G1.bx, bay = y + G1.by;
      c.strokeStyle = fl > 0 ? P[C_LEAF] : stroke;
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, bay); c.stroke();
      // the spring under it
      var nx = -(bay - ay), ny = bx - ax, nl = Math.sqrt(nx * nx + ny * ny); nx /= nl; ny /= nl;
      if (ny < 0) { nx = -nx; ny = -ny; }
      var sq = 0.16 * (1 - fl * 0.5);
      c.lineWidth = 0.03; c.beginPath();
      for (i = 0; i <= 6; i++) {
        var uu = 0.15 + 0.7 * i / 6, px = ax + (bx - ax) * uu, py = ay + (bay - ay) * uu, o2 = (i % 2 ? sq : sq * 0.2);
        if (i === 0) c.moveTo(px + nx * o2, py + ny * o2); else c.lineTo(px + nx * o2, py + ny * o2);
      }
      c.stroke();
      return;
    }
    if (t === 'split') {
      var G3 = geo('split', 0);
      c.beginPath(); c.moveTo(x + G3[0].bx, y + G3[0].by); c.lineTo(x + G3[0].ax, y + G3[0].ay); c.lineTo(x + G3[1].bx, y + G3[1].by); c.stroke();
      glyph(c, fixed ? C_FAINT : C_ACC, '^', x + 0.5, y + 0.68, 0.36);
      return;
    }
    // ramps, curves, funnels: their geometry as strokes
    var G4 = geo(t, f);
    if (S.rotAnim && S.rotAnim.p === p) {
      c.save(); c.translate(x + 0.5, y + 0.5); c.rotate(-(Math.PI / 2) * (S.rotAnim.t / 0.14)); c.translate(-x - 0.5, -y - 0.5);
    }
    c.beginPath();
    for (i = 0; i < G4.length; i++) {
      var g = G4[i];
      if (g.g === 's') { c.moveTo(x + g.ax, y + g.ay); c.lineTo(x + g.bx, y + g.by); }
      else if (g.g === 'a') { c.moveTo(x + g.cx + Math.cos(g.a0) * g.r, y + g.cy + Math.sin(g.a0) * g.r); c.arc(x + g.cx, y + g.cy, g.r, g.a0, g.a1); }
    }
    c.stroke();
    if (S.rotAnim && S.rotAnim.p === p) c.restore();
  }

  // ---- cards ----
  function starStr(n) { var s = ''; for (var i = 0; i < 3; i++) s += i < n ? '<b>*</b>' : '<i>.</i>'; return '<span class="mr-stars">' + s + '</span>'; }
  function solvedCount() { var n = 0; for (var i = 0; i < LEVELS.length; i++) if (S.save.stars[i]) n++; return n; }
  function homeHtml() {
    var tot = totalStars(S.save), nextL = 0;
    for (var i = 0; i < LEVELS.length; i++) if (!S.save.stars[i] && unlocked(S.save, i)) { nextL = i; break; }
    return '<div class="mr-card"><pre class="mr-art">' +
      '  o\n   \\_\n     \\__   o\n        \\_( )_  \\_/\n</pre>' +
      '<div class="mr-title">MARBLE RUN</div>' +
      '<div class="mr-sub">ramps, funnels, bumpers — then let them roll</div>' +
      '<div class="mr-btns col">' +
      '<button type="button" class="mr-go" data-act="levels">Levels <small>' + solvedCount() + '/' + LEVELS.length + ' · ' + tot + ' *</small></button>' +
      '<button type="button" class="mr-go alt" data-act="sandbox">Sandbox</button>' +
      '<button type="button" class="mr-go alt" data-act="help">How to play</button></div>' +
      '<div class="mr-note">' + (S.coarse ? 'tap a part, tap the board — drag to move' : 'next up: level ' + (nextL + 1) + ' · keys 1–9 pick parts, R turns, Space plays') + '</div></div>';
  }
  function levelsHtml() {
    var h = '<div class="mr-card wide"><div class="mr-title">LEVELS</div><div class="mr-sub">' + totalStars(S.save) + ' of ' + LEVELS.length * 3 + ' stars</div><div class="mr-grid">';
    for (var i = 0; i < LEVELS.length; i++) {
      var ok = unlocked(S.save, i), st = S.save.stars[i] || 0;
      h += '<button type="button" class="mr-lv' + (st ? ' done' : '') + (ok ? '' : ' locked') + '" data-lv="' + i + '"' + (ok ? '' : ' aria-disabled="true"') +
        ' aria-label="Level ' + (i + 1) + ', ' + esc(LEVELS[i].name) + (ok ? ', ' + st + ' stars' : ', locked') + '">' +
        '<span class="n">' + (i + 1) + '</span><span class="nm">' + esc(LEVELS[i].name) + '</span>' + (ok ? starStr(st) : '<span class="mr-stars"><i>lock</i></span>') + '</button>';
    }
    return h + '</div><div class="mr-btns"><button type="button" class="mr-go alt" data-act="home">Back</button></div>' +
      '<div class="mr-note">solve a level to open the next ones</div></div>';
  }
  function introHtml() {
    var L = lv(), inv = Object.keys(L.inv).map(function (k) { return '<span class="mr-inv">' + partSvg(k, 0, 16) + ' ' + L.inv[k] + '× ' + esc(TYPE[k].name) + '</span>'; }).join('');
    return '<div class="mr-card"><div class="mr-title sm">LEVEL ' + (S.li + 1) + '</div><div class="mr-big">' + esc(L.name) + '</div>' +
      '<p>' + esc(L.goal || goalText(L)) + '</p>' + (L.hint ? '<p class="mr-hint">' + esc(L.hint) + '</p>' : '') +
      '<div class="mr-invs">' + inv + '</div>' +
      '<div class="mr-note">* solve it &nbsp; * use ' + L.par + ' part' + (L.par === 1 ? '' : 's') + ' or fewer &nbsp; * catch every marble</div>' +
      '<div class="mr-btns"><button type="button" class="mr-go" data-act="build">Build</button></div></div>';
  }
  function goalText(L) {
    var cups = L.fixed.filter(function (p) { return p.t === 'cup'; }), em = 0;
    L.fixed.forEach(function (p) { if (p.t === 'emit') em += emitCount(p); });
    if (cups.length === 1) return 'Get ' + cups[0].n + ' of the ' + em + ' marbles into the cup.';
    return 'Fill every cup (' + cups.map(function (c) { return c.n; }).join(' + ') + ') from ' + em + ' marbles.';
  }
  function resultHtml() {
    var r = S.result, L = lv();
    if (r.won) {
      var last = S.li >= LEVELS.length - 1;
      return '<div class="mr-card"><div class="mr-title">CLEAR</div><div class="mr-big">' + starStr(r.stars) + '</div>' +
        '<pre class="mr-tab">' + line('marbles in', r.caught + ' / ' + r.total) + '\n' + line('parts used', r.used + ' (par ' + r.par + ')') + '</pre>' +
        (r.stars > r.prev && r.prev ? '<div class="mr-new">new best</div>' : '') +
        (r.stars < 3 ? '<div class="mr-note">' + (r.used > r.par ? 'try it with ' + r.par + ' part' + (r.par === 1 ? '' : 's') + ' or fewer' : 'catch every marble for the last star') + '</div>' : '<div class="mr-new">perfect!</div>') +
        '<div class="mr-btns">' + (last ? '<button type="button" class="mr-go" data-act="levels">Levels</button>' : '<button type="button" class="mr-go" data-act="next">Next level</button>') +
        '<button type="button" class="mr-go alt" data-act="edit">Tweak</button></div></div>';
    }
    return '<div class="mr-card"><div class="mr-title">NOT YET</div><div class="mr-big">' + r.caught + ' <small>in</small></div>' +
      '<p class="mr-c">' + (r.cupsOk ? 'some cups are full — ' : '') + goalText(L) + '</p>' +
      '<div class="mr-btns"><button type="button" class="mr-go" data-act="edit">Keep building</button><button type="button" class="mr-go alt" data-act="again">Run again</button></div></div>';
  }
  function line(a, b) { return esc(a) + new Array(Math.max(1, 24 - a.length - b.length) + 1).join(' ') + '<b>' + esc(b) + '</b>'; }
  function helpHtml() {
    var rows = TYPES.map(function (t) { return '<div class="mr-row">' + partSvg(t.id, 0, 18) + '<span><b>' + esc(t.name) + '</b> ' + esc(t.info) + '</span></div>'; }).join('');
    return '<div class="mr-card wide"><div class="mr-title">HOW TO PLAY</div>' +
      '<p>Pick a part in the tray (tap it again to turn it), then tap a square to put it there — or drag it straight onto the board. <b>Tap a placed part to turn it</b>, drag it to move it, drag it off the board (or use the bin) to take it back. Press <b>Play</b> and the emitters drop their marbles; press <b>Stop</b> to change things.</p>' +
      '<p>Levels: get the marbles into the cups with the parts you are given. Stars for solving it, for using par parts or fewer, and for catching every marble. Parts in plain ink (not the accent colour) on a shaded square belong to the level and stay put.</p>' +
      '<div class="mr-parts">' + rows + '</div>' +
      (S.coarse ? '' : '<div class="mr-keys"><div><b>1–9, 0, C, E</b> pick a part · <b>R</b> turn · <b>Del</b> remove</div><div><b>Arrows</b> move the cursor · <b>Enter</b> place / turn · <b>Space</b> play / stop · <b>Esc</b> menu</div></div>') +
      '<div class="mr-btns"><button type="button" class="mr-go" data-act="close-help">Got it</button></div></div>';
  }
  function pauseHtml() {
    return '<div class="mr-card"><div class="mr-title">PAUSED</div><div class="mr-btns"><button type="button" class="mr-go" data-act="resume">Resume</button><button type="button" class="mr-go alt" data-act="stop">Stop</button></div></div>';
  }
  function slotsHtml() {
    var h = '<div class="mr-card wide"><div class="mr-title">SAVE &amp; SHARE</div><div class="mr-slots">';
    for (var i = 0; i < SLOTS; i++) {
      var sl = S.save.slots[i];
      h += '<div class="mr-slot"><span class="n">' + (i + 1) + '</span><span class="nm">' + (sl ? esc(sl.name) + ' <i>' + sl.pieces.length + ' parts' + (sl.t ? ' · ' + esc(fmtDate(sl.t)) : '') + '</i>' : '<i>empty</i>') + '</span>' +
        (sl ? '<button type="button" class="mr-sm" data-slot="load" data-i="' + i + '">Load</button>' : '') +
        '<button type="button" class="mr-sm' + (S.armSlot === i ? ' warn' : '') + '" data-slot="save" data-i="' + i + '">' + (S.armSlot === i ? 'Overwrite?' : 'Save') + '</button></div>';
    }
    var code = encode(S.save.sandbox);
    h += '</div><div class="mr-h">Share code</div>' +
      '<div class="mr-code"><input type="text" class="mr-in" readonly value="' + esc(code) + '" aria-label="Share code for this layout" data-code="out"><button type="button" class="mr-sm" data-act="copy">Copy</button></div>' +
      '<div class="mr-h">Load a code</div>' +
      '<div class="mr-code"><input type="text" class="mr-in" placeholder="MR1-…" aria-label="Paste a share code" data-code="in" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="button" class="mr-sm" data-act="import">Load</button></div>' +
      '<div class="mr-btns"><button type="button" class="mr-go alt" data-act="close-slots">Done</button></div></div>';
    return h;
  }
  function fmtDate(t) { try { var d = new Date(t); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return ''; } }

  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'home' ? homeHtml() : kind === 'levels' ? levelsHtml() : kind === 'intro' ? introHtml() : kind === 'result' ? resultHtml()
      : kind === 'help' ? helpHtml() : kind === 'pause' ? pauseHtml() : kind === 'slots' ? slotsHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind);
    if (kind) S.ovl.scrollTop = 0;
    syncAll();
  }
  function announce(s) { if (S && S.liveEl) S.liveEl.textContent = s; }

  // ---- the bars around the board ----
  function syncAll() {
    if (!S) return;
    syncTop(); syncTray(); syncActs(); syncHead();
  }
  function syncTop() {
    var h;
    if (S.mode === 'level') {
      var L = lv(), sim = S.sim, cups = L.fixed.filter(function (p) { return p.t === 'cup'; });
      var got = sim ? sim.caught : 0, need = needOf(L);
      h = '<span class="mr-lvl"><b>' + (S.li + 1) + '</b> ' + esc(L.name) + '</span>' +
        '<span class="mr-goal">' + (sim ? 'in ' + got + ' · lost ' + sim.lost : (cups.length > 1 ? cups.length + ' cups · ' : '') + 'need ' + need) + '</span>' + starStr(S.save.stars[S.li] || 0);
    } else if (S.mode === 'sandbox') {
      var r = S.result;
      h = '<span class="mr-lvl"><b>Sandbox</b></span><span class="mr-goal">' + (S.sim ? 'in ' + S.sim.caught + ' · lost ' + S.sim.lost : placedList().length + ' parts') + '</span>' +
        (r ? '<span class="mr-goal g">' + r.caught + '/' + r.total + ' caught</span>' : '');
    } else h = '<span class="mr-lvl"><b>Marble Run</b></span>';
    if (S.topH !== h) { S.top.innerHTML = h; S.topH = h; }
  }
  function syncTray() {
    if (S.mode === 'menu') { if (S.trayH !== '') { S.tray.innerHTML = ''; S.trayH = ''; } return; }
    var types = trayTypes(), editing = !S.running, h = '';
    types.forEach(function (t, i) {
      var left = leftOf(t), on = S.brush === t, ty = TYPE[t];
      h += '<button type="button" class="mr-part' + (on ? ' on' : '') + (left <= 0 ? ' out' : '') + '" data-t="' + t + '"' + (editing ? '' : ' disabled') +
        ' title="' + esc(ty.name + ' — ' + ty.info) + (S.coarse ? '' : ' (' + ty.key.toUpperCase() + ')') + '" aria-pressed="' + on + '" aria-label="' + esc(ty.name) + (left === Infinity ? '' : ', ' + left + ' left') + '">' +
        partSvg(t, (S.form[t] || 0) % ty.forms, 24) + '<span class="nm">' + esc(ty.name) + '</span>' + (left === Infinity ? '' : '<span class="ct">' + left + '</span>') + '</button>';
    });
    if (S.trayH !== h) { S.tray.innerHTML = h; S.trayH = h; }
  }
  function syncActs() {
    if (S.mode === 'menu') { S.acts.innerHTML = ''; S.actsH = ''; return; }
    var running = S.running, has = !!S.sel && placedList().indexOf(S.sel) >= 0, h;
    var playLab = running ? 'Stop' : S.sim ? 'Reset' : 'Play';
    h = '<button type="button" class="mr-play' + (running ? ' stop' : '') + '" data-act="' + (running ? 'stop' : S.sim ? 'reset' : 'play') + '">' + (running ? IC_STOP : S.sim ? IC_RESET : IC_PLAY) + '<span>' + playLab + '</span>' + (S.coarse ? '' : '<small>space</small>') + '</button>' +
      '<button type="button" class="mr-ab" data-act="rotate" title="Turn (R)" aria-label="Turn the selected part"' + (running || (!has && !S.brush) ? ' disabled' : '') + '>' + IC_ROT + '</button>' +
      '<button type="button" class="mr-ab" data-act="remove" title="Take back (Del)" aria-label="Take the selected part back"' + (running || !has ? ' disabled' : '') + '>' + IC_DEL + '</button>' +
      '<button type="button" class="mr-ab wide' + (S.armClear ? ' warn' : '') + '" data-act="clear"' + (running || !placedList().length ? ' disabled' : '') + '>' + (S.armClear ? 'Sure?' : 'Clear') + '</button>' +
      (S.mode === 'sandbox' ? '<button type="button" class="mr-ab wide" data-act="slots"' + (running ? ' disabled' : '') + '>Save</button>' : '') +
      '<button type="button" class="mr-ab" data-act="menu" title="Menu (Esc)" aria-label="Menu">' + IC_MENU + '</button>';
    if (S.actsH !== h) { S.acts.innerHTML = h; S.actsH = h; }
  }
  function syncHead() {
    var sb = S.head.querySelector('[data-h="sound"]');
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }

  // ---- modes ----
  function toMenu(card) {
    if (S.running) stopRun();
    S.mode = 'menu'; S.sim = null; S.sel = null; S.brush = null; S.result = null;
    S.root.classList.add('menu');
    layout();
    showCard(card || 'home');
    if (!S.rm && !S.demo) { S.demo = true; S.demoN = 0; S.sim = newSim(DEMO); S.running = true; S.endT = 0; kick(); }
    redraw();
  }
  function endDemo() { if (S.demo) { S.demo = false; S.running = false; S.sim = null; S.fx.length = 0; S.pops.length = 0; stopLoop(); } }
  function openLevel(i) {
    endDemo();
    if (S.running) stopRun();
    S.mode = 'level'; S.li = i; S.save.cur = i; S.sim = null; S.sel = null; S.result = null; S.armClear = false;
    var types = trayTypes();
    S.brush = types.length ? types[0] : null;
    S.root.classList.remove('menu');
    persist(); layout();
    showCard('intro'); redraw();
  }
  function openSandbox() {
    endDemo();
    if (S.running) stopRun();
    S.mode = 'sandbox'; S.sim = null; S.sel = null; S.result = null; S.armClear = false; S.armSlot = -1;
    if (!S.save.sandbox.length) S.save.sandbox = [{ t: 'emit', c: 4, r: 0, f: 2 }, { t: 'cup', c: 4, r: 12, f: 0 }];
    S.brush = 'ramp';
    S.root.classList.remove('menu');
    persist(); layout();
    showCard(null); redraw();
  }

  // ---- input ----
  function cellAt(clientX, clientY) {
    var r = S.cv.getBoundingClientRect();
    var x = (clientX - r.left) / r.width * COLS, y = (clientY - r.top) / r.height * ROWS;
    return { x: x, y: y, c: Math.floor(x), r: Math.floor(y), inside: x >= 0 && y >= 0 && x < COLS && y < ROWS };
  }
  function boardDown(e) {
    if (!S || e.button > 0) return;
    S.active = true; S.kbd = false;
    dropFocus();
    S.snd.ensure();
    if (S.cardKind || S.mode === 'menu') return;
    e.preventDefault();
    if (S.running) return;
    if (S.sim) { S.sim = null; S.result = null; S.fx.length = 0; syncAll(); }
    S.armClear = false;
    var at = cellAt(e.clientX, e.clientY);
    if (!at.inside) return;
    S.cursor = { c: at.c, r: at.r };
    var p = pieceAt(placedList(), at.c, at.r);
    try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
    if (p) {
      S.drag = { p: p, id: e.pointerId, c0: at.c, r0: at.r, x0: at.x, y0: at.y, x: at.x, y: at.y, moved: false, wasSel: S.sel === p, ok: true, cc: { c: at.c, r: at.r } };
      S.sel = p;
    } else if (fixedAt(at.c, at.r)) {
      S.sel = null; pulse(at.c, at.r);
      S.snd.tone(200, 0.05, 'triangle', 0.02);
      if (!S.fixedTold) { S.fixedTold = true; Cade.showToast && Cade.showToast('That part belongs to the level', 'info', 1400); }
    } else if (S.brush) {
      if (canDrop(S.brush, at.c, at.r)) {
        var np = placePiece(S.brush, at.c, at.r);
        if (np) S.drag = { p: np, id: e.pointerId, c0: at.c, r0: at.r, x0: at.x, y0: at.y, x: at.x, y: at.y, moved: false, wasSel: false, fresh: true, ok: true, cc: { c: at.c, r: at.r } };
      } else if (leftOf(S.brush) <= 0) {
        S.snd.tone(200, 0.05, 'triangle', 0.02);
        Cade.showToast && Cade.showToast('No ' + TYPE[S.brush].name.toLowerCase() + 's left — take one back first', 'info', 1500);
        S.sel = null;
      } else S.sel = null;
    } else S.sel = null;
    syncAll(); redraw(); kick();
  }
  // pointerdown is cancelled on the board (no text selection / zoom), so the editor would keep
  // focus and swallow Space: hand focus back to the page when the board is touched
  function dropFocus() {
    var a = document.activeElement;
    if (a && a !== document.body && !S.panel.contains(a) && a.blur) { try { a.blur(); } catch (e) {} }
  }
  function boardMove(e) {
    if (!S) return;
    var at = cellAt(e.clientX, e.clientY);
    if (S.drag && S.drag.id === e.pointerId) {
      var d = S.drag;
      d.x = at.x; d.y = at.y;
      if (!d.moved && (Math.abs(at.x - d.x0) > 0.45 || Math.abs(at.y - d.y0) > 0.45 || at.c !== d.c0 || at.r !== d.r0)) d.moved = true;
      if (d.moved) { d.cc = { c: at.c, r: at.r }; d.ok = at.inside ? freeCell(at.c, at.r, d.p) : false; }
      redraw();
      return;
    }
    if (e.pointerType === 'mouse') {
      var h = at.inside ? { c: at.c, r: at.r } : null;
      if ((h && (!S.hover || S.hover.c !== h.c || S.hover.r !== h.r)) || (!h && S.hover)) { S.hover = h; redraw(); }
    }
  }
  function boardUp(e) {
    if (!S || !S.drag || S.drag.id !== e.pointerId) return;
    var d = S.drag, at = cellAt(e.clientX, e.clientY);
    S.drag = null;
    if (d.moved) {
      if (!at.inside) removePiece(d.p);
      else if (freeCell(at.c, at.r, d.p)) {
        if (at.c !== d.p.c || at.r !== d.p.r) {
          d.p.c = at.c; d.p.r = at.r; S.sel = d.p; pulse(at.c, at.r);
          S.snd.tone(660, 0.04, 'triangle', 0.03); edited();
        }
      } else S.snd.tone(200, 0.05, 'triangle', 0.02);
    } else if (d.wasSel && !d.fresh) rotatePiece(d.p);
    syncAll(); redraw(); kick();
  }
  function boardCancel(e) { if (S && S.drag && S.drag.id === e.pointerId) { S.drag = null; redraw(); } }

  // tray: tap picks a part (tap again to drop the pick); drag it straight onto the board
  function trayDown(e) {
    var b = e.target.closest ? e.target.closest('[data-t]') : null;
    if (!b || !S || b.disabled || e.button > 0) return;
    S.active = true;
    dropFocus();
    S.snd.ensure();
    e.preventDefault();
    S.trayDrag = { t: b.getAttribute('data-t'), id: e.pointerId, sx: e.clientX, sy: e.clientY, over: false, moved: false, el: b };
    try { b.setPointerCapture(e.pointerId); } catch (x) {}
  }
  function trayMove(e) {
    var d = S && S.trayDrag;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 10) d.moved = true;
    if (!d.moved) return;
    var at = cellAt(e.clientX, e.clientY);
    d.over = at.y > -1.5 && at.y < ROWS + 0.5 && at.x > -0.5 && at.x < COLS + 0.5;
    d.x = at.x; d.y = at.y; d.cc = { c: at.c, r: at.r }; d.ok = at.inside && canDrop(d.t, at.c, at.r);
    if (S.sim && d.over) { S.sim = null; S.result = null; }
    redraw();
  }
  function trayUp(e) {
    var d = S && S.trayDrag;
    if (!d || d.id !== e.pointerId) return;
    S.trayDrag = null;
    if (d.moved) {
      var at = cellAt(e.clientX, e.clientY);
      if (at.inside && canDrop(d.t, at.c, at.r)) { S.brush = d.t; placePiece(d.t, at.c, at.r); }
      redraw(); syncAll(); return;
    }
    // a tap
    // a tap picks the part; tapping the picked part again turns it (the icon shows how it will go down)
    if (S.brush === d.t && !S.sel) S.form[d.t] = ((S.form[d.t] || 0) + 1) % TYPE[d.t].forms;
    S.brush = d.t; S.sel = null;
    S.snd.tone(880, 0.03, 'sine', 0.025);
    syncAll(); redraw();
  }

  function act(a) {
    if (!S) return;
    S.snd.ensure();
    if (a !== 'clear') S.armClear = false;
    switch (a) {
      case 'play': case 'stop': case 'reset':
        if (a === 'stop') stopRun(); else if (a === 'reset') { S.sim = null; S.result = null; S.fx.length = 0; syncAll(); redraw(); } else play();
        break;
      case 'rotate':
        if (S.running) return;
        if (S.sel && placedList().indexOf(S.sel) >= 0) rotatePiece(S.sel);
        else if (S.brush) { S.form[S.brush] = ((S.form[S.brush] || 0) + 1) % TYPE[S.brush].forms; S.snd.tone(880, 0.04, 'square', 0.02); syncAll(); redraw(); }
        break;
      case 'remove':
        if (!S.running && S.sel) removePiece(S.sel);
        break;
      case 'clear':
        if (S.running || !placedList().length) return;
        if (!S.armClear) { S.armClear = true; syncAll(); return; }
        S.armClear = false;
        placedList().length = 0; S.sel = null;
        S.snd.tone(300, 0.15, 'triangle', 0.03, 120);
        edited(); redraw();
        break;
      case 'menu':
        persistNow();
        toMenu(S.mode === 'level' ? 'levels' : 'home');
        break;
      case 'slots':
        if (S.running) return;
        S.armSlot = -1; showCard('slots');
        break;
    }
    kick();
  }
  function cardAct(b) {
    var a = b.getAttribute('data-act'), lvI = b.getAttribute('data-lv'), slot = b.getAttribute('data-slot');
    S.snd.ensure();
    if (lvI != null) {
      var i = +lvI;
      if (!unlocked(S.save, i)) { Cade.showToast && Cade.showToast('Solve an earlier level to open this one', 'info', 1500); return; }
      openLevel(i); return;
    }
    if (slot) {
      var si = +b.getAttribute('data-i'), sl = S.save.slots[si];
      if (slot === 'save') {
        if (sl && S.armSlot !== si) { S.armSlot = si; showCard('slots'); return; }
        S.save.slots[si] = { name: 'Run ' + (si + 1), t: Date.now(), pieces: normPieces(S.save.sandbox) };
        S.armSlot = -1; persistNow();
        S.snd.tone(988, 0.06, 'triangle', 0.03); S.snd.tone(1319, 0.08, 'triangle', 0.03, 0, 0.06);
        Cade.showToast && Cade.showToast('Saved to slot ' + (si + 1), 'success', 1400);
        showCard('slots');
      } else if (slot === 'load' && sl) {
        S.save.sandbox = normPieces(sl.pieces); S.sel = null; S.sim = null; persistNow();
        S.snd.tone(660, 0.06, 'triangle', 0.03);
        Cade.showToast && Cade.showToast('Loaded slot ' + (si + 1), 'info', 1200);
        showCard(null); redraw();
      }
      return;
    }
    switch (a) {
      case 'levels': showCard('levels'); break;
      case 'sandbox': openSandbox(); break;
      case 'help': S.helpFrom = S.cardKind; showCard('help'); break;
      case 'close-help': showCard(S.mode === 'menu' ? (S.helpFrom && S.helpFrom !== 'help' ? S.helpFrom : 'home') : S.paused ? 'pause' : (S.helpFrom && S.helpFrom !== 'help' && S.helpFrom !== 'pause' ? S.helpFrom : null)); redraw(); break;
      case 'home': showCard('home'); break;
      case 'build': showCard(null); redraw(); break;
      case 'next': openLevel(Math.min(LEVELS.length - 1, S.li + 1)); break;
      case 'edit': S.sim = null; S.result = null; S.fx.length = 0; showCard(null); redraw(); break;
      case 'again': S.sim = null; showCard(null); play(); break;
      case 'resume': resume(); break;
      case 'stop': stopRun(); break;
      case 'close-slots': S.armSlot = -1; showCard(null); redraw(); break;
      case 'copy': {
        var inp = S.ovl.querySelector('[data-code="out"]'), code = inp ? inp.value : '';
        var done = function () { Cade.showToast && Cade.showToast('Share code copied', 'success', 1400); };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, function () { selectIn(inp); });
          else { selectIn(inp); document.execCommand && document.execCommand('copy'); done(); }
        } catch (e) { selectIn(inp); }
        break;
      }
      case 'import': {
        var ii = S.ovl.querySelector('[data-code="in"]'), got = decode(ii ? ii.value : '');
        if (!got) { Cade.showToast && Cade.showToast('That code does not look right', 'error', 1600); return; }
        S.save.sandbox = got; S.sel = null; S.sim = null; persistNow();
        S.snd.tone(784, 0.07, 'triangle', 0.03); S.snd.tone(1175, 0.09, 'triangle', 0.03, 0, 0.06);
        Cade.showToast && Cade.showToast('Layout loaded — ' + got.length + ' parts', 'success', 1400);
        showCard(null); redraw();
        break;
      }
    }
  }
  function selectIn(inp) { if (inp) { try { inp.focus(); inp.select(); } catch (e) {} } }

  function onKey(e) {
    if (!S || !S.active) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tg = e.target, tag = tg && tg.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (tg && tg.isContentEditable)) { if (e.key === 'Escape' && S.cardKind === 'slots') { showCard(null); redraw(); e.preventDefault(); } return; }
    var k = e.key, used = true;
    if (S.cardKind) {
      if (k === 'Escape') {
        if (S.cardKind === 'pause') resume();
        else if (S.cardKind === 'help') cardAct({ getAttribute: function (n) { return n === 'data-act' ? 'close-help' : null; } });
        else if (S.mode !== 'menu') { if (S.cardKind === 'result') { S.sim = null; S.result = null; } showCard(null); redraw(); }
        else if (S.cardKind !== 'home') showCard('home');
        else used = false;
      } else if ((k === ' ' || k === 'Enter') && (S.cardKind === 'intro' || S.cardKind === 'pause')) {
        if (S.cardKind === 'pause') resume(); else { showCard(null); redraw(); }
      } else if (k === 'Enter' && S.cardKind === 'result' && S.result && S.result.won && tag !== 'BUTTON') {
        if (S.li < LEVELS.length - 1) openLevel(S.li + 1); else showCard('levels');
      } else used = false;
    } else if (S.mode !== 'menu') {
      var lk = k.length === 1 ? k.toLowerCase() : k;
      var ty = TYPES.filter(function (t) { return t.key === lk; })[0];
      if (k === ' ') { if (tag === 'BUTTON' && tg !== document.body && S.panel.contains(tg)) { used = false; } else act(S.running ? 'stop' : S.sim ? 'reset' : 'play'); }
      else if (S.running) used = false;
      else if (ty && trayTypes().indexOf(ty.id) >= 0) { if (S.brush === ty.id) S.form[ty.id] = ((S.form[ty.id] || 0) + 1) % ty.forms; S.brush = ty.id; S.sel = null; syncAll(); redraw(); }
      else if (lk === 'r') act('rotate');
      else if (k === 'Delete' || k === 'Backspace') act('remove');
      else if (k === 'Escape') { if (S.sel || S.brush) { S.sel = null; S.brush = null; syncAll(); redraw(); } else act('menu'); }
      else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
        var cu = S.cursor || { c: 4, r: 6 };
        cu = { c: clamp(cu.c + (k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0), 0, COLS - 1), r: clamp(cu.r + (k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0), 0, ROWS - 1) };
        S.cursor = cu; S.kbd = true;
        if (S.sim) { S.sim = null; S.result = null; }
        var pc = pieceAt(placedList(), cu.c, cu.r);
        S.sel = pc || null; syncAll(); redraw();
      } else if (k === 'Enter' && tag !== 'BUTTON') {
        var c0 = S.cursor || { c: 4, r: 6 }, pk = pieceAt(placedList(), c0.c, c0.r);
        S.kbd = true; S.cursor = c0;
        if (S.sim) { S.sim = null; S.result = null; }
        if (pk) { if (S.sel === pk) rotatePiece(pk); else { S.sel = pk; syncAll(); } }
        else if (S.brush && canDrop(S.brush, c0.c, c0.r)) placePiece(S.brush, c0.c, c0.r);
        redraw();
      } else used = false;
    } else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); kick(); }
  }

  // ---- layout ----
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 640, solo = S.panel.classList.contains('cade-solo-panel');
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    S.root.classList.toggle('side', !phone);
    var pr = S.panel.getBoundingClientRect(), top = pr.height ? Math.min(Math.max(0, pr.top), 120) : 48;
    var head = S.panel.querySelector('.cade-panel-head'), hh = head ? head.offsetHeight : 40;
    var chromeH = hh + 20 + (S.top.offsetHeight || 26) + 8;
    var availW, availH;
    if (phone) {
      var below = S.mode === 'menu' ? 0 : (S.coarse ? 52 : 46) + 8 + (S.coarse ? 100 : 88) + 8;
      availW = vw - 34; availH = vh - top - chromeH - below - 10;
    } else {
      availW = Math.min(vw - 48 - 190, solo ? 900 : 520); availH = vh - top - chromeH - 16;
    }
    var cell = Math.floor(Math.min(availW / COLS, availH / ROWS));
    cell = clamp(cell, phone ? 22 : 26, solo ? 64 : 38);
    var cw = cell * COLS, ch = cell * ROWS, dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--mr-w', cw + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.px = S.cv.width / COLS;
    if (S.col) buildAtlas();
  }
  function redraw() { if (!S) return; if (S.raf) return; draw(1); }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT);
    if (s.saveT) { clearTimeout(s.saveT); sset(SAVE_KEY, JSON.stringify(s.save)); }
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    document.removeEventListener('pointerdown', s.onDocDown, true);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('focus', s.onFocus);
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
  }

  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="mr"><div class="mr-top"></div><div class="mr-main"><div class="mr-stage"><canvas class="mr-cv"></canvas><div class="mr-ovl" style="display:none"></div></div>' +
      '<div class="mr-side"><div class="mr-tray" role="toolbar" aria-label="Parts"></div><div class="mr-acts"></div></div></div><div class="mr-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🛝 Marble Run', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'mr-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button><button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, root: p.querySelector('.mr'), top: p.querySelector('.mr-top'), stage: p.querySelector('.mr-stage'), cv: p.querySelector('.mr-cv'),
      ovl: p.querySelector('.mr-ovl'), tray: p.querySelector('.mr-tray'), acts: p.querySelector('.mr-acts'), liveEl: p.querySelector('.mr-live'),
      save: ld.save, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      mode: 'menu', li: 0, sim: null, running: false, paused: false, raf: 0, last: 0, clock: 0, speed: 1, endT: 0,
      pal: new Array(NPAL), rgb: new Array(NPAL), col: null, atl: null, px: 30, fx: [], pops: [], shake: 0,
      sel: null, brush: null, form: {}, drag: null, trayDrag: null, hover: null, cursor: null, kbd: false,
      cardKind: null, result: null, armClear: false, armSlot: -1, active: true, topH: null, trayH: null, actsH: null
    };
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    layout();
    readTheme();

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    // keys act on the board only while the panel was the last thing touched
    S.onDocDown = function (e) { if (S) S.active = S.panel.contains(e.target); };
    document.addEventListener('pointerdown', S.onDocDown, true);
    S.onVis = function () { if (document.hidden) pause(); else kick(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { pause(); S.drag = null; S.trayDrag = null; } };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (!S || S.panel !== p) return; pause(); stopLoop(); });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        layout(); redraw(); kick();
      });
    });
    S.onFocus = function () { kick(); };
    window.addEventListener('focus', S.onFocus);
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); redraw(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); redraw();
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    // header: help / sound (the header drags the panel — these are controls)
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
      } else if (h === 'help') {
        if (S.running && !S.demo) pause();
        if (S.cardKind === 'help') cardAct({ getAttribute: function (n) { return n === 'data-act' ? 'close-help' : null; } });
        else { S.helpFrom = S.cardKind; showCard('help'); }
      }
      try { b.blur(); } catch (er) {}
    });

    // Fast taps must never zoom, select, magnify or open a callout. CSS does most of it;
    // the board and the tray cancel their touches outright and the panel swallows
    // gesture / dblclick events. Text inputs (share codes) are left alone.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    [S.cv, S.tray].forEach(function (el) {
      el.addEventListener('touchstart', noTouch, { passive: false });
      el.addEventListener('touchmove', noTouch, { passive: false });
      el.addEventListener('touchend', function (e) {
        noTouch(e);
        // the tray's buttons still need their tap (pointer events carry it)
      }, { passive: false });
    });
    S.acts.addEventListener('touchend', function (e) { if (e.target.closest && e.target.closest('button') && e.cancelable) { e.preventDefault(); var b = e.target.closest('button'); if (!b.disabled) act(b.getAttribute('data-act')); } }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, function (e) { if (e.target && e.target.tagName === 'INPUT') return; noTouch(e); }, { passive: false }); });

    S.cv.addEventListener('pointerdown', boardDown);
    S.cv.addEventListener('pointermove', boardMove);
    S.cv.addEventListener('pointerup', boardUp);
    S.cv.addEventListener('pointercancel', boardCancel);
    S.cv.addEventListener('pointerleave', function () { if (S && S.hover && !S.drag) { S.hover = null; redraw(); } });
    S.cv.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (!S || S.running || S.cardKind) return;
      var at = cellAt(e.clientX, e.clientY), pc = at.inside ? pieceAt(placedList(), at.c, at.r) : null;
      if (pc) { if (S.sim) { S.sim = null; S.result = null; } removePiece(pc); redraw(); }
    });
    S.tray.addEventListener('pointerdown', trayDown);
    S.tray.addEventListener('pointermove', trayMove);
    S.tray.addEventListener('pointerup', trayUp);
    S.tray.addEventListener('pointercancel', function (e) { if (S && S.trayDrag && S.trayDrag.id === e.pointerId) { S.trayDrag = null; redraw(); } });
    S.tray.addEventListener('click', function (e) {
      // keyboard activation of a tray button (pointer taps are handled on pointerup)
      if (e.detail !== 0 || !S) return;
      var b = e.target.closest ? e.target.closest('[data-t]') : null;
      if (!b) return;
      var t = b.getAttribute('data-t');
      if (S.brush === t) S.form[t] = ((S.form[t] || 0) + 1) % TYPE[t].forms;
      S.brush = t; S.sel = null; syncAll(); redraw();
    });
    S.tray.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.acts.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (b && S && !b.disabled) act(b.getAttribute('data-act'));
    });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (b) cardAct(b);
    });
    S.ovl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.getAttribute && e.target.getAttribute('data-code') === 'in') { e.preventDefault(); cardAct({ getAttribute: function (n) { return n === 'data-act' ? 'import' : null; } }); }
    });

    if (ld.fresh) { toMenu('help'); S.helpFrom = 'home'; } else toMenu('home');
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); redraw(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('700 12px ' + S.col.font).then(function () { if (S && S.panel === p) { buildAtlas(); redraw(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Place ramps, funnels and bumpers, then let the marbles roll — goals and a sandbox',
    icon: '🛝',
    tags: 'game,toy,physics,marble,sandbox,puzzle,ramps,funnel,bumper,flipper,conveyor,trampoline,teleporter,build',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
