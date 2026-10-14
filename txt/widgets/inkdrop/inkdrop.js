/* Ink Drop — a draw-a-line physics puzzle for Cade.txt, drawn in ASCII.
 * Each board has a ball (@), a cup (\___/) and whatever the level throws in
 * the way: walls (#), planks (=), spikes (^^^), bumpers ( ), glass (:::),
 * conveyor belts (>>>), portals, cannons, moving cups and no-ink zones (///).
 * Draw lines with a finger or the mouse — they become solid — then DROP the
 * ball. Ink is limited; stars for reaching the cup, staying under par ink and
 * grabbing the ★ on the way. 24 handcrafted levels in three chapters + a
 * sandbox. Progress persists (Cade.store, cade-inkdrop-*).
 *
 * The engine is pure (no DOM) and exported for node (inkdrop.test.js verifies
 * a solution drawing for every level). Physics: fixed 240 Hz step with an
 * accumulator, sub-stepped against tunnelling; a rolling ball (spin + Coulomb
 * friction) against capsules / boxes / circles. Deterministic for a given
 * drawing, identical at 60 or 120 Hz; rendering interpolates. Nothing runs
 * while idle: the canvas redraws only while you draw or the ball moves. */
(function () {
  'use strict';

  // =====================================================================
  // ENGINE (pure: no DOM — unit-checked in node by inkdrop.test.js)
  // =====================================================================
  // Board space: 100 × 150 units, y down. The ASCII grid is 40 × 30 cells of
  // 2.5 × 5 units, so obstacles authored on that grid line up with glyphs.
  var W = 100, H = 150, CW = 2.5, RH = 5;
  var STEP = 1 / 240, G = 190;
  var BALL_R = 2.4, INK_R = 0.7, PLANK_R = 1.1, CUP_R = 0.9;
  var MAX_V = 420;           // speed cap (units/s)
  var REST_V = 7;            // slower impacts than this don't bounce (resting contact)
  var BUMP_V = 120;          // a bumper always kicks at least this hard
  var GLASS_V = 62;          // impact speed that shatters glass
  var PORTAL_R = 3.6, STAR_R = 2.6;
  var ROLL_RES = 0.03;       // rolling resistance, as a fraction of g
  var BELT_K = 10;           // how quickly a belt drags the ball to its speed (1/s)
  var T_MAX = 20, STUCK_T = 1.1, WIN_T = 0.45;
  var INK_EPS = 0.12;        // how far a simplified stroke may stray from the finger (keeps curves smooth)
  var MAT = {
    ink: { e: 0.25, mu: 0.6, smooth: true }, wall: { e: 0.3, mu: 0.6 }, plank: { e: 0.3, mu: 0.6, smooth: true },
    cup: { e: 0.15, mu: 0.8 }, glass: { e: 0.2, mu: 0.5 }, bumper: { e: 0.85, mu: 0, kick: BUMP_V },
    belt: { e: 0.15, mu: 0.9 }, mover: { e: 0.12, mu: 0.9 }, spike: { e: 0.2, mu: 0.5 }
  };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function hyp(x, y) { return Math.sqrt(x * x + y * y); }

  // ---------- geometry ----------
  // Squared distance from (px,py) to segment (x1,y1)-(x2,y2).
  function segDist2(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy, t = 0;
    if (l2 > 1e-12) t = clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1);
    var qx = x1 + dx * t - px, qy = y1 + dy * t - py;
    return qx * qx + qy * qy;
  }
  function polyLength(pts) {
    var L = 0;
    for (var i = 1; i < pts.length; i++) L += hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return L;
  }
  function inkOf(strokes) {
    var L = 0;
    for (var i = 0; i < strokes.length; i++) L += polyLength(strokes[i]);
    return L;
  }
  function inRect(x, y, r, pad) { return x > r[0] - pad && x < r[0] + r[2] + pad && y > r[1] - pad && y < r[1] + r[3] + pad; }

  // Cup geometry: three capsules (sloped sides, flat floor). g = [cx, floorY, innerW, depth].
  function cupSegs(g) {
    var cx = g[0], fy = g[1], hw = g[2] / 2, d = g[3], fl = d * 0.3;   // sides flare out a little: easy in, hard to skip out
    return [
      [cx - hw - fl, fy - d, cx - hw, fy + CUP_R],
      [cx + hw + fl, fy - d, cx + hw, fy + CUP_R],
      [cx - hw, fy + CUP_R, cx + hw, fy + CUP_R]
    ];
  }
  // Moving things ease from their start to start + (dx,dy) and back, period T (from the moment you DROP).
  function swing(dx, dy, T, t) {
    var ph = 2 * Math.PI * t / T, f = (1 - Math.cos(ph)) / 2, df = Math.PI / T * Math.sin(ph);
    return { ox: dx * f, oy: dy * f, vx: dx * df, vy: dy * df };
  }
  function moverAt(m, t) { var w = swing(m[4], m[5], m[6], t); return { x: m[0] + w.ox, y: m[1] + w.oy, vx: w.vx, vy: w.vy }; }
  // The cup at time t (goal.move = [dx, dy, T] makes it a moving target).
  function cupAt(goal, t) {
    var c = goal.cup, mv = goal.move;
    if (!mv) return { c: c, vx: 0, vy: 0 };
    var w = swing(mv[0], mv[1], mv[2], t);
    return { c: [c[0] + w.ox, c[1] + w.oy, c[2], c[3]], vx: w.vx, vy: w.vy };
  }

  // ---------- where ink may go ----------
  // A stroke's centre line must stay on the board and out of every obstacle,
  // no-ink zone, portal, mover track and the ball's own spot.
  function blockedAt(L, x, y) {
    if (x < INK_R || x > W - INK_R || y < INK_R || y > H - INK_R) return true;
    var i, a, lists = [L.walls, L.glass, L.belts, L.spikes, L.nodraw];
    for (var k = 0; k < lists.length; k++) {
      a = lists[k];
      if (a) for (i = 0; i < a.length; i++) if (inRect(x, y, a[i], 0)) return true;
    }
    if (L.movers) for (i = 0; i < L.movers.length; i++) {
      var m = L.movers[i], x0 = Math.min(m[0], m[0] + m[4]), y0 = Math.min(m[1], m[1] + m[5]);
      if (inRect(x, y, [x0, y0, m[2] + Math.abs(m[4]), m[3] + Math.abs(m[5])], 2 * BALL_R + 1)) return true;   // no squeezing the ball against a platform
    }
    if (L.bumpers) for (i = 0; i < L.bumpers.length; i++) { a = L.bumpers[i]; if (hyp(x - a[0], y - a[1]) < a[2] + INK_R) return true; }
    if (L.portals) for (i = 0; i < L.portals.length; i++) {
      a = L.portals[i];
      var pr = (a[4] || PORTAL_R) + INK_R;
      if (hyp(x - a[0], y - a[1]) < pr || hyp(x - a[2], y - a[3]) < pr) return true;
    }
    if (L.planks) for (i = 0; i < L.planks.length; i++) { a = L.planks[i]; if (segDist2(x, y, a[0], a[1], a[2], a[3]) < PLANK_R * PLANK_R) return true; }
    if (L.goal && L.goal.cup) {
      var gc = L.goal.cup, gm = L.goal.move;
      if (gm) {                                // a moving cup keeps its whole run clear of ink
        var hw = gc[2] / 2 + gc[3] * 0.3 + CUP_R, pad = 2 * BALL_R + 1;
        if (inRect(x, y, [gc[0] - hw + Math.min(0, gm[0]), gc[1] - gc[3] + Math.min(0, gm[1]), 2 * hw + Math.abs(gm[0]), gc[3] + CUP_R + Math.abs(gm[1])], pad)) return true;
      } else {
        var cs = cupSegs(gc);
        for (i = 0; i < cs.length; i++) if (segDist2(x, y, cs[i][0], cs[i][1], cs[i][2], cs[i][3]) < CUP_R * CUP_R) return true;
      }
    }
    if (hyp(x - L.ball[0], y - L.ball[1]) < BALL_R + INK_R + 0.8) return true;
    return false;
  }
  // Is the whole segment drawable? (sampled every 0.4 units)
  function segClear(L, x1, y1, x2, y2) {
    var d = hyp(x2 - x1, y2 - y1), n = Math.max(1, Math.ceil(d / 0.4));
    for (var i = 0; i <= n; i++) if (blockedAt(L, x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n)) return false;
    return true;
  }
  // The furthest point along (x1,y1)→(x2,y2) that is still drawable, or null.
  function clipSeg(L, x1, y1, x2, y2) {
    var d = hyp(x2 - x1, y2 - y1), n = Math.max(1, Math.ceil(d / 0.25)), lx = x1, ly = y1;
    for (var i = 1; i <= n; i++) {
      var x = x1 + (x2 - x1) * i / n, y = y1 + (y2 - y1) * i / n;
      if (blockedAt(L, x, y)) return i === 1 ? null : [lx, ly];
      lx = x; ly = y;
    }
    return [x2, y2];
  }

  // Ramer–Douglas–Peucker that never shortcuts through an obstacle: a run of
  // points collapses to one segment only when that segment is still clear.
  function simplify(L, pts, eps) {
    if (pts.length < 3) return pts.slice();
    var keep = new Array(pts.length), stack = [[0, pts.length - 1]];
    keep[0] = keep[pts.length - 1] = true;
    while (stack.length) {
      var r = stack.pop(), a = r[0], b = r[1];
      if (b - a < 2) continue;
      var ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1], md = -1, mi = a + 1;
      for (var i = a + 1; i < b; i++) {
        var d = segDist2(pts[i][0], pts[i][1], ax, ay, bx, by);
        if (d > md) { md = d; mi = i; }
      }
      if (md > eps * eps || (L && !segClear(L, ax, ay, bx, by))) {
        keep[mi] = true;
        stack.push([a, mi], [mi, b]);
      }
    }
    var out = [];
    for (var j = 0; j < pts.length; j++) if (keep[j]) out.push([Math.round(pts[j][0] * 100) / 100, Math.round(pts[j][1] * 100) / 100]);
    return out;
  }
  // Index of the stroke nearest (x,y) within tol, or -1 (erase by tapping).
  function strokeAt(strokes, x, y, tol) {
    var best = -1, bd = tol * tol;
    for (var i = 0; i < strokes.length; i++) {
      var s = strokes[i];
      for (var j = 0; j < s.length; j++) {
        var d = j ? segDist2(x, y, s[j - 1][0], s[j - 1][1], s[j][0], s[j][1]) : (x - s[0][0]) * (x - s[0][0]) + (y - s[0][1]) * (y - s[0][1]);
        if (d <= bd) { bd = d; best = i; }
      }
    }
    return best;
  }
  // A drawing is legal when every stroke is clear of obstacles and the total fits the budget.
  function validDrawing(L, strokes) {
    for (var i = 0; i < strokes.length; i++) {
      var s = strokes[i];
      if (s.length < 2) return false;
      for (var j = 1; j < s.length; j++) if (!segClear(L, s[j - 1][0], s[j - 1][1], s[j][0], s[j][1])) return false;
    }
    return inkOf(strokes) <= L.ink + 1e-6;
  }

  // ---------- simulation ----------
  function mkSeg(x1, y1, x2, y2, r, m, kind) {
    var p = r + BALL_R;
    return { x1: x1, y1: y1, x2: x2, y2: y2, r: r, m: m, kind: kind,
      minx: Math.min(x1, x2) - p, maxx: Math.max(x1, x2) + p, miny: Math.min(y1, y2) - p, maxy: Math.max(y1, y2) + p };
  }
  function newSim(L, strokes) {
    var s = {
      L: L, segs: [], boxes: [], circs: [], pickups: [], t: 0, steps: 0, acc: 0,
      state: 'run', reason: '', goalT: 0, stuckT: 0, lock: -1, got: 0, events: [], lastHit: -1, touch: false, tnx: 0, tny: -1,
      ball: { x: L.ball[0], y: L.ball[1], vx: L.ball[2] || 0, vy: L.ball[3] || 0, w: 0, a: 0, px: L.ball[0], py: L.ball[1], pa: 0 }
    };
    var i, a;
    if (L.planks) for (i = 0; i < L.planks.length; i++) { a = L.planks[i]; s.segs.push(mkSeg(a[0], a[1], a[2], a[3], PLANK_R, MAT.plank, 'plank')); }
    if (L.goal && L.goal.cup) {
      var cs = cupSegs(L.goal.cup);
      s.cupSegs = [];
      for (i = 0; i < 3; i++) { var cg = mkSeg(cs[i][0], cs[i][1], cs[i][2], cs[i][3], CUP_R, MAT.cup, 'cup'); s.segs.push(cg); s.cupSegs.push(cg); }
    }
    for (i = 0; i < strokes.length; i++) {
      var st = strokes[i];
      for (var j = 1; j < st.length; j++) s.segs.push(mkSeg(st[j - 1][0], st[j - 1][1], st[j][0], st[j][1], INK_R, MAT.ink, 'ink'));
    }
    function box(r, m, kind, extra) {
      var b = { x0: r[0], y0: r[1], x1: r[0] + r[2], y1: r[1] + r[3], m: m, kind: kind, alive: true, vx: 0, vy: 0 };
      if (extra) for (var k in extra) b[k] = extra[k];
      s.boxes.push(b);
      return b;
    }
    if (L.walls) for (i = 0; i < L.walls.length; i++) box(L.walls[i], MAT.wall, 'wall');
    if (L.glass) for (i = 0; i < L.glass.length; i++) box(L.glass[i], MAT.glass, 'glass', { gi: i });
    if (L.belts) for (i = 0; i < L.belts.length; i++) box(L.belts[i], MAT.belt, 'belt', { speed: L.belts[i][4] });
    if (L.spikes) for (i = 0; i < L.spikes.length; i++) {
      // Fair spikes: the deadly box sits a little inside the drawn row, on the pointed side.
      a = L.spikes[i];
      var dir = a[4] || 'u', r = [a[0], a[1], a[2], a[3]];
      if (dir === 'u') { r[1] += 1.4; r[3] -= 1.4; } else if (dir === 'd') r[3] -= 1.4;
      else if (dir === 'l') { r[0] += 0.8; r[2] -= 0.8; } else r[2] -= 0.8;
      box(r, MAT.spike, 'spike');
    }
    if (L.movers) for (i = 0; i < L.movers.length; i++) box(L.movers[i], MAT.mover, L.movers[i][7] === 'spike' ? 'spike' : 'mover', { mv: L.movers[i] });
    if (L.bumpers) for (i = 0; i < L.bumpers.length; i++) { a = L.bumpers[i]; s.circs.push({ x: a[0], y: a[1], r: a[2], m: MAT.bumper, bi: i }); }
    if (L.star) s.pickups.push({ x: L.star[0], y: L.star[1], got: false });
    s.broken = {};
    return s;
  }

  // Resolve one contact: push out, bounce the normal part, and let friction
  // turn sliding into rolling (solid sphere: slip changes 3.5× the impulse).
  // (svx, svy) is the surface's own velocity (belts, movers). A glancing hit
  // on a drawn line or plank is a polyline kink of what is really a curve:
  // the ball follows it and keeps its speed, as it would on a smooth track.
  function resolve(s, b, nx, ny, pen, m, svx, svy, h) {
    b.x += nx * pen; b.y += ny * pen;
    s.touch = true; s.tnx = nx; s.tny = ny;
    var rvx = b.vx - svx, rvy = b.vy - svy, vn = rvx * nx + rvy * ny;
    if (vn >= 0) return 0;
    var tx = -ny, ty = nx, vt = rvx * tx + rvy * ty;
    if (m.smooth && -vn > 2.5 * G * h && -vn < 0.6 * Math.abs(vt)) {
      var sp = Math.sqrt(vt * vt + vn * vn) * 0.998, nvt = vt > 0 ? sp : -sp;
      b.vx = svx + tx * nvt; b.vy = svy + ty * nvt;
      b.w = nvt / BALL_R;
      return -vn;
    }
    var vnew = -vn < REST_V ? 0 : -vn * m.e;
    if (m.kick) vnew = Math.max(vnew, m.kick);
    var jn = vnew - vn;
    var jt = -(vt - b.w * BALL_R) / 3.5, lim = m.mu * jn;
    if (jt > lim) jt = lim; else if (jt < -lim) jt = -lim;
    b.vx += nx * jn + tx * jt;
    b.vy += ny * jn + ty * jt;
    b.w -= jt * 2.5 / BALL_R;
    if (-vn > 28 && s.t - s.lastHit > 0.06) { s.lastHit = s.t; s.events.push({ k: m.kick ? 'bump' : 'hit', x: b.x - nx * BALL_R, y: b.y - ny * BALL_R, v: -vn }); }
    else if (m.kick) s.events.push({ k: 'bump', x: b.x - nx * BALL_R, y: b.y - ny * BALL_R, v: -vn });
    return -vn;
  }

  var R2 = BALL_R * BALL_R;
  function collide(s, h) {
    var b = s.ball, i, d2, d, nx, ny;
    // capsules: ink, planks, the cup
    for (i = 0; i < s.segs.length; i++) {
      var g = s.segs[i];
      if (b.x < g.minx || b.x > g.maxx || b.y < g.miny || b.y > g.maxy) continue;
      var dx = g.x2 - g.x1, dy = g.y2 - g.y1, l2 = dx * dx + dy * dy, t = 0;
      if (l2 > 1e-12) t = clamp(((b.x - g.x1) * dx + (b.y - g.y1) * dy) / l2, 0, 1);
      var qx = b.x - (g.x1 + dx * t), qy = b.y - (g.y1 + dy * t), rr = g.r + BALL_R;
      d2 = qx * qx + qy * qy;
      if (d2 >= rr * rr) continue;
      d = Math.sqrt(d2);
      if (d > 1e-9) { nx = qx / d; ny = qy / d; } else { nx = -dy; ny = dx; var ln = hyp(nx, ny) || 1; nx /= ln; ny /= ln; if (ny > 0) { nx = -nx; ny = -ny; } }
      resolve(s, b, nx, ny, rr - d, g.m, g.vx || 0, g.vy || 0, h);
    }
    // boxes: walls, glass, belts, spikes, movers
    for (i = 0; i < s.boxes.length; i++) {
      var o = s.boxes[i];
      if (!o.alive) continue;
      var cx = clamp(b.x, o.x0, o.x1), cy = clamp(b.y, o.y0, o.y1), ex = b.x - cx, ey = b.y - cy, pen;
      d2 = ex * ex + ey * ey;
      if (d2 >= R2) continue;
      if (d2 > 1e-12) { d = Math.sqrt(d2); nx = ex / d; ny = ey / d; pen = BALL_R - d; }
      else {                                   // centre inside: leave by the nearest face
        var l = b.x - o.x0, r = o.x1 - b.x, tp = b.y - o.y0, bt = o.y1 - b.y, mn = Math.min(l, r, tp, bt);
        if (mn === tp) { nx = 0; ny = -1; } else if (mn === bt) { nx = 0; ny = 1; } else if (mn === l) { nx = -1; ny = 0; } else { nx = 1; ny = 0; }
        pen = mn + BALL_R;
      }
      if (o.kind === 'spike') { s.state = 'lose'; s.reason = 'spikes'; s.events.push({ k: 'pop', x: b.x, y: b.y }); return; }
      if (o.kind === 'glass') {
        var vin = -(b.vx * nx + b.vy * ny);
        if (vin > GLASS_V) {
          o.alive = false; s.broken[o.gi] = s.t;
          b.vx *= 0.8; b.vy *= 0.8;
          s.events.push({ k: 'glass', x: cx, y: cy, gi: o.gi, v: vin });
          continue;
        }
      }
      var svx = 0, svy = 0;
      if (o.kind === 'belt') { if (ny < -0.7) svx = o.speed; else if (ny > 0.7) svx = -o.speed; }
      else if (o.kind === 'mover') { svx = o.vx; svy = o.vy; }
      resolve(s, b, nx, ny, pen, o.m, svx, svy, h);
      if (o.kind === 'belt' && Math.abs(ny) > 0.7) {
        // the belt drags the ball to its speed; the ball rides it without spinning against it
        b.vx += (svx - b.vx) * Math.min(1, BELT_K * h);
        b.w = ((b.vx - svx) * -ny) / BALL_R;
      }
    }
    // bumpers
    for (i = 0; i < s.circs.length; i++) {
      var c = s.circs[i], fx = b.x - c.x, fy = b.y - c.y, rs = c.r + BALL_R;
      d2 = fx * fx + fy * fy;
      if (d2 >= rs * rs) continue;
      d = Math.sqrt(d2) || 1e-9;
      if (d2 < 1e-12) { fx = 0; fy = -1; d = 1; }
      var before = s.events.length;
      resolve(s, b, fx / d, fy / d, rs - d, c.m, 0, 0, h);
      if (s.events.length > before) s.events[s.events.length - 1].bi = c.bi;
    }
  }

  function substep(s, h) {
    var b = s.ball;
    b.vy += G * h;
    b.x += b.vx * h; b.y += b.vy * h;
    b.a += b.w * h;
    s.touch = false;
    collide(s, h);
    if (s.state !== 'run') return;
    if (s.touch) collide(s, h);                // second pass settles corners / V-shaped valleys
    if (s.state !== 'run') return;
    if (s.touch) {                             // rolling resistance along the last contact's tangent
      var tx = -s.tny, ty = s.tnx, vt = b.vx * tx + b.vy * ty, dec = ROLL_RES * G * h;
      var dv = Math.abs(vt) <= dec ? -vt : (vt > 0 ? -dec : dec);
      b.vx += tx * dv; b.vy += ty * dv;
      b.w += dv / BALL_R;
    }
    var sp = hyp(b.vx, b.vy);
    if (sp > MAX_V) { b.vx *= MAX_V / sp; b.vy *= MAX_V / sp; }
  }

  // One fixed physics step (sub-stepped so a fast ball never moves more than
  // a third of its radius between collision checks).
  function step(s) {
    if (s.state !== 'run') return;
    var b = s.ball, L = s.L, i;
    b.px = b.x; b.py = b.y; b.pa = b.a;
    s.steps++; s.t = s.steps * STEP;
    for (i = 0; i < s.boxes.length; i++) {
      var o = s.boxes[i];
      if (o.mv) { var p = moverAt(o.mv, s.t); o.x0 = p.x; o.y0 = p.y; o.x1 = p.x + o.mv[2]; o.y1 = p.y + o.mv[3]; o.vx = p.vx; o.vy = p.vy; }
    }
    if (L.goal && L.goal.move && s.cupSegs) {
      var ca = cupAt(L.goal, s.t), cn = cupSegs(ca.c);
      for (i = 0; i < 3; i++) {
        var q = s.cupSegs[i], c4 = cn[i], pp = q.r + BALL_R;
        q.x1 = c4[0]; q.y1 = c4[1]; q.x2 = c4[2]; q.y2 = c4[3]; q.vx = ca.vx; q.vy = ca.vy;
        q.minx = Math.min(c4[0], c4[2]) - pp; q.maxx = Math.max(c4[0], c4[2]) + pp; q.miny = Math.min(c4[1], c4[3]) - pp; q.maxy = Math.max(c4[1], c4[3]) + pp;
      }
    }
    var sp = hyp(b.vx, b.vy) + G * STEP;
    var n = Math.min(24, Math.max(1, Math.ceil(sp * STEP / (BALL_R * 0.33))));
    var wasTouch = false;
    for (i = 0; i < n && s.state === 'run'; i++) { substep(s, STEP / n); if (s.touch) wasTouch = true; }
    if (s.state !== 'run') return;
    // portals: keep the velocity, keep the offset; no re-entry until the ball has left both mouths
    if (L.portals) {
      for (i = 0; i < L.portals.length; i++) {
        var P = L.portals[i], PR = P[4] || PORTAL_R, da = hyp(b.x - P[0], b.y - P[1]), db = hyp(b.x - P[2], b.y - P[3]);
        if (s.lock === i) { if (da > PR + BALL_R * 0.6 && db > PR + BALL_R * 0.6) s.lock = -1; continue; }
        if (s.lock !== -1) continue;
        if (da < PR * 0.9 || db < PR * 0.9) {
          var fromA = da < db, ox = b.x - (fromA ? P[0] : P[2]), oy = b.y - (fromA ? P[1] : P[3]);
          s.events.push({ k: 'portal', x: b.x, y: b.y });
          b.x = (fromA ? P[2] : P[0]) + ox; b.y = (fromA ? P[3] : P[1]) + oy;
          b.px = b.x; b.py = b.y;
          s.lock = i;
          s.events.push({ k: 'portal', x: b.x, y: b.y });
          break;
        }
      }
    }
    for (i = 0; i < s.pickups.length; i++) {
      var pk = s.pickups[i];
      if (!pk.got && hyp(b.x - pk.x, b.y - pk.y) < STAR_R + BALL_R) { pk.got = true; s.got++; s.events.push({ k: 'star', x: pk.x, y: pk.y }); }
    }
    var speed = hyp(b.vx, b.vy), inGoal = false, g = L.goal;
    if (g && g.cup) {
      var c = cupAt(g, s.t).c;
      inGoal = Math.abs(b.x - c[0]) < c[2] / 2 + 1.2 && b.y > c[1] - c[3] + 1 && b.y < c[1] + 1;
    } else if (g && g.zone) inGoal = inRect(b.x, b.y, g.zone, 0);
    if (inGoal) {
      s.goalT += STEP;
      // a static cup has to keep the ball; a zone or a moving cup only has to catch it
      if (g.zone || (g.move && b.y > c[1] - c[3] + BALL_R + 1) || s.goalT >= WIN_T || (s.goalT > 0.1 && speed < 4)) { s.state = 'win'; s.events.push({ k: 'win', x: b.x, y: b.y }); return; }
    } else s.goalT = 0;
    if (b.y > H + 8 || b.x < -8 || b.x > W + 8 || b.y < -80) { s.state = 'lose'; s.reason = 'out'; s.events.push({ k: 'out', x: b.x, y: b.y }); return; }
    if (speed < 1.5 && wasTouch) s.stuckT += STEP; else s.stuckT = 0;
    if (s.stuckT > STUCK_T) { s.state = 'lose'; s.reason = 'stuck'; s.events.push({ k: 'stuck', x: b.x, y: b.y }); return; }
    if (s.t >= T_MAX) { s.state = 'lose'; s.reason = 'time'; s.events.push({ k: 'time', x: b.x, y: b.y }); }
  }

  // Fixed-timestep accumulator: consume real frame time in STEP slices. Returns the render alpha.
  function advance(s, dt) {
    s.acc += clamp(dt, 0, 0.1);
    var n = 0;
    while (s.acc >= STEP - 1e-9 && s.state === 'run') {
      step(s);
      s.acc -= STEP;
      if (++n >= 48) { s.acc = 0; break; }
    }
    return s.state === 'run' ? clamp(s.acc / STEP, 0, 1) : 1;
  }

  // Run a drawing to the end, headless.
  function simulate(L, strokes, opts) {
    var s = newSim(L, strokes || []), path = opts && opts.path ? [] : null, max = Math.ceil(T_MAX / STEP) + 5;
    while (s.state === 'run' && s.steps < max) {
      step(s);
      if (path && s.steps % 6 === 0) path.push([s.ball.x, s.ball.y]);
    }
    return { result: s.state, reason: s.reason, t: s.t, steps: s.steps, got: s.got, stars: s.pickups.length, ball: s.ball, path: path, sim: s };
  }

  // Stars for a finished run: reach the cup, stay at or under par ink, collect the ★.
  function rate(L, ink, res) {
    var win = res.result === 'win';
    var out = { win: win, par: win && ink <= L.par + 1e-6, star: win && res.got >= (L.star ? 1 : 0), stars: 0 };
    if (win) out.stars = 1 + (out.par ? 1 : 0) + (out.star ? 1 : 0);
    return out;
  }

  // =====================================================================
  // LEVELS — board units (100 × 150, y down). Grid cells are 2.5 × 5.
  //   ball [x, y, vx?, vy?] · goal {cup:[cx, floorY, innerW, depth]} or {zone:[x,y,w,h]}
  //   ink budget · par (3rd-star ink) · star [x, y]
  //   walls/glass/nodraw [x,y,w,h] · belts [x,y,w,h,speed] · spikes [x,y,w,h,dir]
  //   planks [x1,y1,x2,y2] · bumpers [x,y,r] · portals [ax,ay,bx,by,r?]
  //   movers [x,y,w,h,dx,dy,period] · hint [[x,y,text]] · ghost [[x,y]…] (tutorial trace)
  // =====================================================================
  var CHAPTERS = [
    { n: 1, name: 'Sketchbook', blurb: 'lines, ramps & bridges' },
    { n: 2, name: 'Workshop', blurb: 'spikes, bumpers, glass & belts' },
    { n: 3, name: 'Machine Room', blurb: 'portals, cannons & moving cups' }
  ];
  var LEVELS = [
    // ---------------- Chapter 1 · Sketchbook ----------------
    { id: 'c1-1', ch: 1, name: 'First Line', tut: true, ball: [16, 20], goal: { cup: [72, 125, 14, 10] }, ink: 140, par: 95, star: [42, 63],
      hint: [[50, 7, 'trace the dotted line, then DROP'], [50, 141, 'lines you draw are solid']], ghost: [[6, 26], [60, 92]] },
    { id: 'c1-2', ch: 1, name: 'Bridge', tut: true, ball: [12, 38], goal: { cup: [86, 76, 12, 10] }, ink: 90, par: 40, star: [52, 58],
      planks: [[3, 47, 36, 59]],
      walls: [[62.5, 65, 11.5, 85], [97.5, 30, 2.5, 120]],
      hint: [[50, 20, 'bridge the gap'], [50, 25, 'into the hole on the right']] },
    { id: 'c1-3', ch: 1, name: 'Switchback', tut: true, ball: [10, 12], goal: { cup: [14, 140, 14, 10] }, ink: 220, par: 175, star: [70, 84],
      walls: [[0, 60, 75, 5], [97.5, 0, 2.5, 110], [0, 65, 2.5, 85]],
      hint: [[50, 75, 'draw as many lines'], [50, 80, 'as your ink allows']] },
    { id: 'c1-4', ch: 1, name: 'Ski Jump', ball: [8, 14], goal: { cup: [84, 138, 14, 10] }, ink: 110, par: 75, star: [50, 45],
      walls: [[47.5, 60, 5, 90], [97.5, 70, 2.5, 80]], planks: [[56, 100, 72, 122]] },
    { id: 'c1-5', ch: 1, name: 'Keep Out', ball: [12, 10], goal: { cup: [70, 100, 15, 10] }, ink: 80, par: 40, star: [45, 40],
      walls: [[57.5, 100, 27.5, 50], [85, 55, 2.5, 95]], nodraw: [[27.5, 25, 72.5, 75]],
      hint: [[50, 18, 'no ink in the /// zone']] },
    { id: 'c1-6', ch: 1, name: 'Backstop', ball: [8, 10], goal: { cup: [78.5, 111, 12, 10] }, ink: 60, par: 25, star: [88, 85],
      planks: [[3, 17, 55, 48]], walls: [[45, 100, 22.5, 50], [90, 100, 10, 50]] },
    { id: 'c1-7', ch: 1, name: 'Half-pipe', ball: [10, 12], goal: { cup: [86, 62, 11, 10] }, ink: 150, par: 115, star: [32, 88],
      walls: [[75, 62, 25, 5], [65, 72.5, 5, 77.5], [97.5, 20, 2.5, 42]] },
    { id: 'c1-8', ch: 1, name: 'Labyrinth', ball: [88, 10], goal: { cup: [86, 145, 13, 10] }, ink: 130, par: 85, star: [50, 85],
      walls: [[0, 20, 2.5, 130], [97.5, 20, 2.5, 130], [20, 30, 77.5, 5], [2.5, 60, 77.5, 5], [20, 90, 77.5, 5], [2.5, 120, 72.5, 5]] },
    // ---------------- Chapter 2 · Workshop ----------------
    { id: 'c2-1', ch: 2, name: 'Spike Pit', tut: true, ball: [50, 10], goal: { cup: [14, 140, 14, 10] }, ink: 90, par: 45, star: [35, 52],
      spikes: [[30, 145, 70, 5, 'u'], [37.5, 75, 25, 5, 'u']], walls: [[0, 30, 2.5, 120]],
      hint: [[50, 95, '^^^ pops the ball']] },
    { id: 'c2-2', ch: 2, name: 'Boing', tut: true, ball: [43, 10], goal: { cup: [86, 107, 12, 10] }, ink: 60, par: 30, star: [70, 84],
      bumpers: [[40, 110, 5]], walls: [[72.5, 107, 27.5, 5]], spikes: [[0, 145, 100, 5, 'u']],
      hint: [[50, 95, '( ) bumpers kick hard']] },
    { id: 'c2-3', ch: 2, name: 'Smash', tut: true, ball: [12, 10], goal: { cup: [22, 140, 14, 10] }, ink: 100, par: 70, star: [43, 66],
      planks: [[4, 17, 40, 32]], glass: [[10, 127.5, 25, 2.5]], spikes: [[40, 145, 60, 5, 'u']],
      hint: [[62, 95, ':::: glass breaks'], [62, 100, 'on a hard hit']] },
    { id: 'c2-4', ch: 2, name: 'Wrong Way', tut: true, ball: [60, 10], goal: { cup: [80, 140, 13, 10] }, ink: 100, par: 70, star: [40, 95],
      belts: [[20, 70, 62.5, 5, -55]], spikes: [[0, 145, 62.5, 5, 'u']], walls: [[0, 40, 2.5, 110]], nodraw: [[17.5, 20, 82.5, 45]],
      hint: [[50, 60, '<<< belts carry the ball']] },
    { id: 'c2-5', ch: 2, name: 'Pinball', ball: [50, 8], goal: { cup: [50, 140, 12, 10] }, ink: 130, par: 90, star: [12, 72],
      bumpers: [[51.5, 40, 5], [28, 72, 5], [72, 72, 5], [50, 104, 5]], walls: [[0, 30, 2.5, 115], [97.5, 30, 2.5, 115]],
      spikes: [[2.5, 145, 35, 5, 'u'], [62.5, 145, 35, 5, 'u']] },
    { id: 'c2-6', ch: 2, name: 'Soft Landing', ball: [30, 8], goal: { cup: [87, 82, 14, 10] }, ink: 90, par: 50, star: [50, 52],
      glass: [[25, 57.5, 52.5, 2.5]], spikes: [[25, 80, 52.5, 5, 'u'], [2.5, 145, 95, 5, 'u']],
      walls: [[0, 15, 2.5, 135], [97.5, 30, 2.5, 70]], nodraw: [[27.5, 20, 72.5, 35]] },
    { id: 'c2-7', ch: 2, name: 'Crossroads', ball: [30, 8], goal: { cup: [86, 140, 14, 10] }, ink: 80, par: 50, star: [20, 78],
      belts: [[10, 50, 40, 5, -60], [42.5, 100, 47.5, 5, 60]], spikes: [[2.5, 145, 70, 5, 'u']],
      walls: [[0, 30, 2.5, 120], [97.5, 60, 2.5, 90]], nodraw: [[12.5, 15, 87.5, 32.5]] },
    { id: 'c2-8', ch: 2, name: 'Gauntlet', ball: [10, 8], goal: { cup: [86, 140, 14, 10] }, ink: 80, par: 45, star: [45, 82],
      bumpers: [[12, 48, 5]], glass: [[25, 60, 37.5, 2.5]], belts: [[20, 95, 50, 5, 55]],
      walls: [[97.5, 60, 2.5, 90]], spikes: [[0, 145, 75, 5, 'u'], [95, 70, 2.5, 55, 'l']], nodraw: [[25, 25, 75, 30]] },
    // ---------------- Chapter 3 · Machine Room ----------------
    { id: 'c3-1', ch: 3, name: 'Wormhole', tut: true, ball: [15, 8], goal: { cup: [14, 140, 14, 10] }, ink: 120, par: 95, star: [70, 62],
      portals: [[15, 45, 82, 22]], spikes: [[25, 145, 75, 5, 'u']], walls: [[0, 60, 2.5, 90]],
      hint: [[50, 95, 'in one portal, out the other —'], [50, 100, 'same speed, same direction']] },
    { id: 'c3-2', ch: 3, name: 'Cannon', tut: true, ball: [8, 40, 85, -40], goal: { cup: [50, 140, 14, 10] }, ink: 100, par: 70, star: [80, 70],
      spikes: [[0, 145, 37.5, 5, 'u'], [62.5, 145, 37.5, 5, 'u']],
      hint: [[50, 18, 'this one comes out firing']] },
    { id: 'c3-3', ch: 3, name: 'Moving Target', tut: true, ball: [15, 8], goal: { cup: [35, 140, 22, 10], move: [30, 0, 5] }, ink: 80, par: 50, star: [22, 40],
      planks: [[25, 70, 44, 94], [75, 70, 56, 94]], walls: [[42.5, 95, 2.5, 17.5], [55, 95, 2.5, 17.5]], spikes: [[0, 145, 100, 5, 'u']],
      hint: [[50, 20, 'things only move once you DROP:'], [50, 25, 'feed the funnel, time the cup']] },
    { id: 'c3-4', ch: 3, name: 'Elevator', ball: [85, 10], goal: { cup: [15, 57, 14, 10] }, ink: 120, par: 60, star: [40, 30],
      portals: [[60, 132, 60, 25]], walls: [[0, 57, 30, 5], [0, 0, 2.5, 60], [97.5, 20, 2.5, 130]], spikes: [[2.5, 145, 95, 5, 'u']] },
    { id: 'c3-5', ch: 3, name: 'Bank Shot', ball: [8, 30, 130, 0], goal: { cup: [50, 140, 14, 10] }, ink: 120, par: 75, star: [84, 80],
      glass: [[40, 127.5, 20, 2.5]], spikes: [[0, 145, 37.5, 5, 'u'], [62.5, 145, 37.5, 5, 'u']] },
    { id: 'c3-6', ch: 3, name: 'Relay', ball: [10, 8], goal: { cup: [40, 140, 14, 10] }, ink: 120, par: 80, star: [74, 101],
      walls: [[0, 60, 25, 5]], portals: [[31, 56, 60, 95]], spikes: [[0, 145, 30, 5, 'u'], [50, 145, 50, 5, 'u']] },
    { id: 'c3-7', ch: 3, name: 'Clockwork', ball: [20, 8], goal: { cup: [40, 140, 14, 10], move: [45, 0, 4] }, ink: 80, par: 45, star: [50, 55],
      belts: [[30, 70, 50, 5, 30]], walls: [[87.5, 45, 2.5, 40]], spikes: [[0, 145, 100, 5, 'u']] },
    { id: 'c3-8', ch: 3, name: 'Grand Machine', ball: [8, 20, 120, 0], goal: { cup: [16, 140, 14, 10] }, ink: 140, par: 95, star: [86, 40],
      glass: [[45, 70, 30, 2.5]], belts: [[25, 95, 55, 5, -45]], portals: [[18, 97, 62, 118, 4.5]],
      walls: [[97.5, 0, 2.5, 150], [0, 60, 2.5, 85]], spikes: [[30, 145, 67.5, 5, 'u']] }
  ];

  // A toy box: one of everything, unlimited ink, no stars.
  var SANDBOX = {
    id: 'sandbox', name: 'Sandbox', ch: 0, sandbox: true, ball: [50, 10], ink: Infinity, par: Infinity,
    goal: { cup: [18, 140, 14, 10] }, planks: [[62, 30, 82, 40]], bumpers: [[22, 62, 5], [80, 78, 4]],
    belts: [[30, 100, 30, 5, 40]], portals: [[90, 138, 40, 22]], glass: [[62.5, 112.5, 25, 2.5]],
    movers: [[5, 115, 15, 5, 0, -40, 4]], spikes: [[35, 145, 47.5, 5, 'u']], walls: [[0, 20, 2.5, 30], [97.5, 0, 2.5, 120]],
    hint: [[50, 5, 'sandbox — unlimited ink, no score']]
  };

  var api = {
    W: W, H: H, CW: CW, RH: RH, STEP: STEP, G: G, BALL_R: BALL_R, INK_R: INK_R, PLANK_R: PLANK_R, CUP_R: CUP_R,
    PORTAL_R: PORTAL_R, STAR_R: STAR_R, MAX_V: MAX_V, T_MAX: T_MAX, MAT: MAT, INK_EPS: INK_EPS,
    LEVELS: LEVELS, CHAPTERS: CHAPTERS, SANDBOX: SANDBOX,
    segDist2: segDist2, polyLength: polyLength, inkOf: inkOf, cupSegs: cupSegs, moverAt: moverAt, cupAt: cupAt,
    blockedAt: blockedAt, segClear: segClear, clipSeg: clipSeg, simplify: simplify, strokeAt: strokeAt, validDrawing: validDrawing,
    newSim: newSim, step: step, advance: advance, simulate: simulate, rate: rate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // =====================================================================
  // UI (browser only)
  // =====================================================================
  var Cade = window.Cade;
  Cade.loadCSS('inkdrop.css');

  var PANEL_ID = 'inkdrop-panel';
  var K_PROG = 'cade-inkdrop-progress', K_LEVEL = 'cade-inkdrop-level', K_DRAW = 'cade-inkdrop-drawings', K_SOUND = 'cade-inkdrop-sound';
  var MIN_STROKE = 1.5, ERASE_TOL = 3.5;
  var FAIL_TEXT = { spikes: 'popped on the spikes', out: 'off the board', stuck: 'the ball got stuck', time: 'out of time' };
  var S = null;                                // the live session (one panel at a time)

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function readJSON(k, d) { try { var v = sget(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function now() { return (window.performance && performance.now ? performance.now() : Date.now()) / 1000; }
  function esc(t) { return Cade.escapeHtml ? Cade.escapeHtml(String(t)) : String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function rep(ch, n) { return n > 0 ? new Array(n + 1).join(ch) : ''; }

  // ---------- progress ----------
  function loadProg() {
    var p = readJSON(K_PROG, null);
    if (!p || typeof p !== 'object' || !p.best || typeof p.best !== 'object') p = { v: 1, best: {} };
    return p;
  }
  function bestOf(id) { var b = S.prog.best[id]; return b && b.s ? b.s : 0; }
  function unlocked(i) {                       // you may skip up to two unsolved levels
    if (i < 3) return true;
    var n = 0;
    for (var j = 0; j < i; j++) if (bestOf(LEVELS[j].id)) n++;
    return n >= i - 2;
  }
  function starTotal() { var n = 0; for (var i = 0; i < LEVELS.length; i++) n += bestOf(LEVELS[i].id); return n; }
  function record(L, r, ink) {
    var b = S.prog.best[L.id] || { s: 0, i: null };
    var improved = r.stars > b.s;
    b.s = Math.max(b.s, r.stars);
    b.i = b.i == null ? Math.round(ink) : Math.min(b.i, Math.round(ink));
    S.prog.best[L.id] = b;
    sset(K_PROG, JSON.stringify(S.prog));
    return improved;
  }

  // ---------- drawings, one per level, kept between visits ----------
  function saveDrawing() {
    if (!S || !S.L) return;
    var all = readJSON(K_DRAW, {});
    if (!all || typeof all !== 'object') all = {};
    if (S.strokes.length) {
      all[S.L.id] = S.strokes.map(function (st) { return st.map(function (p) { return [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]; }); });
    } else delete all[S.L.id];
    sset(K_DRAW, JSON.stringify(all));
  }
  function loadDrawing(L) {
    var all = readJSON(K_DRAW, {}), d = all && all[L.id], out = [], ink = 0;
    if (!Array.isArray(d)) return out;
    for (var i = 0; i < d.length && i < 60; i++) {
      var st = d[i];
      if (!Array.isArray(st) || st.length < 2) continue;
      var ok = true;
      for (var j = 0; j < st.length && ok; j++) ok = Array.isArray(st[j]) && isFinite(st[j][0]) && isFinite(st[j][1]);
      if (!ok || !validDrawing(L, [st])) continue;   // the level changed under it: drop that stroke
      var len = polyLength(st);
      if (ink + len > L.ink + 1e-6) break;
      ink += len;
      out.push(st.map(function (p) { return [+p[0], +p[1]]; }));
    }
    return out;
  }

  // ---------- sound: a tiny WebAudio voice, created on a gesture, closed with the panel ----------
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
      g.gain.exponentialRampToValueAtTime(vol || 0.04, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.noise = function (dur, vol, freq, delay) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      if (!this.nb) {
        var n = Math.floor(ac.sampleRate * 0.4), buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0), x = 7;
        for (var i = 0; i < n; i++) { x = (x * 16807) % 2147483647; d[i] = x / 1073741823.5 - 1; }
        this.nb = buf;
      }
      var t = ac.currentTime + (delay || 0), src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = this.nb; f.type = 'highpass'; f.frequency.value = freq || 1800;
      g.gain.setValueAtTime(vol || 0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(ac.destination);
      src.start(t); src.stop(t + dur + 0.02);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  // ---------- icons ----------
  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC = {
    pen: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    erase: svg('<path d="M20 20H9L4 15a2 2 0 0 1 0-2.8l9.2-9.2a2 2 0 0 1 2.8 0l4.2 4.2a2 2 0 0 1 0 2.8L12 18"/><path d="m8.5 8.5 7 7"/>'),
    undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    clear: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
    grid: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
    sndOn: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'),
    sndOff: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>'),
    lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>')
  };

  // ---------- theme colours (from the app's CSS variables) ----------
  function parseCol(str, d) {
    str = (str || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(str);
    return m ? [+m[1], +m[2], +m[3]] : d;
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rgb(c, a) {
    var r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
    return a == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n, d) { return parseCol(cs.getPropertyValue(n), d); }
    var bg = v('--bg', [250, 250, 249]), tx = v('--text', [28, 25, 23]), mu = v('--text-muted', [120, 113, 108]);
    var fa = v('--text-faint', [168, 162, 158]), ac = v('--accent', [15, 149, 152]);
    var er = v('--error', [220, 38, 38]), ok = v('--success', [22, 163, 74]);
    var am = v('--ws-amber-fg', [180, 83, 9]), pu = v('--ws-purple-fg', [124, 58, 237]), bl = v('--ws-blue-fg', [2, 132, 199]);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    S.dark = dark;
    S.font = (cs.getPropertyValue('--font-mono') || '').trim() || 'ui-monospace, monospace';
    S.col = {
      bg: rgb(bg), text: rgb(tx), muted: rgb(mu), faint: rgb(fa),
      dot: rgb(mix(bg, tx, dark ? 0.16 : 0.13)),
      wall: rgb(mix(bg, tx, dark ? 0.42 : 0.4)), wallFill: rgb(mix(bg, tx, dark ? 0.08 : 0.06)), wallEdge: rgb(mix(bg, tx, dark ? 0.55 : 0.5)),
      plank: rgb(mix(bg, tx, dark ? 0.62 : 0.6)), plankUnder: rgb(mix(bg, tx, dark ? 0.2 : 0.16)),
      ink: rgb(ac), inkUnder: rgb(mix(bg, ac, dark ? 0.36 : 0.26)), inkCur: rgb(mix(ac, tx, 0.15)),
      spike: rgb(er), spikeFill: rgb(mix(bg, er, dark ? 0.12 : 0.08)),
      cup: rgb(ok), cupUnder: rgb(mix(bg, ok, dark ? 0.3 : 0.22)),
      star: rgb(am), starDim: rgb(mix(bg, am, 0.35)),
      portal: rgb(pu), portalDim: rgb(mix(bg, pu, dark ? 0.3 : 0.2)),
      bump: rgb(ac), bumpFill: rgb(mix(bg, ac, dark ? 0.18 : 0.12)),
      glass: rgb(mix(bg, bl, dark ? 0.75 : 0.7)), glassFill: rgb(mix(bg, bl, dark ? 0.14 : 0.1)),
      belt: rgb(mix(bg, tx, dark ? 0.6 : 0.55)), beltFill: rgb(mix(bg, tx, dark ? 0.1 : 0.07)),
      mover: rgb(mix(bg, tx, dark ? 0.7 : 0.65)), track: rgb(mix(bg, tx, dark ? 0.25 : 0.22)),
      nodraw: rgb(mix(bg, er, dark ? 0.32 : 0.24)), nodrawFill: rgb(mix(bg, er, dark ? 0.06 : 0.04)),
      hint: rgb(mix(bg, tx, dark ? 0.5 : 0.48)), ghost: rgb(mix(bg, ac, 0.5)),
      ball: rgb(tx), ballBg: rgb(bg), fail: rgb(er), good: rgb(ok)
    };
    fitFont();
  }
  // Glyphs sit on the board's cell grid: the font is sized from the mono font's
  // real advance so one character is exactly one 2.5-unit cell wide.
  function fitFont() {
    var c = S.ctx;
    c.font = '700 100px ' + S.font;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = CW / adv;
    S.fnt = '700 ' + S.fpx.toFixed(3) + 'px ' + S.font;
    S.adv = adv;
  }
  function font(scale, weight) { return (weight || 700) + ' ' + (S.fpx * scale).toFixed(3) + 'px ' + S.font; }
  function setText(c, f, align) { c.font = f; c.textAlign = align || 'center'; c.textBaseline = 'middle'; }

  // ---------- board layers ----------
  function layer() {
    var cv = document.createElement('canvas');
    cv.width = S.cv.width; cv.height = S.cv.height;
    var c = cv.getContext('2d');
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    return { cv: cv, c: c };
  }
  // Glyph rows filling a rect, aligned to the global grid and clipped to the rect.
  function fillGlyphs(c, r, ch, col) {
    c.save();
    c.beginPath(); c.rect(r[0], r[1], r[2], r[3]); c.clip();
    setText(c, S.fnt, 'left'); c.fillStyle = col;
    var c0 = Math.floor(r[0] / CW + 1e-6), c1 = Math.ceil((r[0] + r[2]) / CW - 1e-6), r0 = Math.floor(r[1] / RH + 1e-6), r1 = Math.ceil((r[1] + r[3]) / RH - 1e-6);
    if (r[3] < RH * 0.8) { r0 = 0; r1 = 1; }      // thin strips: one row through their middle
    for (var row = r0; row < r1; row++) {
      var y = r[3] < RH * 0.8 ? r[1] + r[3] / 2 : row * RH + RH / 2;
      c.fillText(rep(ch, c1 - c0), c0 * CW, y);
    }
    c.restore();
  }
  // Glyph stamps along a segment (planks, the cup, ink).
  function stampSeg(c, x1, y1, x2, y2, ch, gap, rot) {
    var dx = x2 - x1, dy = y2 - y1, d = Math.sqrt(dx * dx + dy * dy), n = Math.max(1, Math.round(d / gap)), a = Math.atan2(dy, dx);
    for (var i = 0; i <= n; i++) {
      var x = x1 + dx * i / n, y = y1 + dy * i / n;
      if (rot) { c.save(); c.translate(x, y); c.rotate(a); c.fillText(ch, 0, 0); c.restore(); } else c.fillText(ch, x, y);
    }
  }
  // Ink: a soft band that is the exact line the ball rolls on, inked over with
  // a trail of glyphs turned to follow it.
  function polyPath(c, pts) { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); }
  function drawStroke(c, pts, col, under) {
    if (pts.length < 2) return;
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = under; c.lineWidth = INK_R * 2;
    polyPath(c, pts); c.stroke();
    setText(c, font(1.08, 800), 'center'); c.fillStyle = col;
    var carry = 2.1 / 2;
    for (var i = 1; i < pts.length; i++) {
      var x1 = pts[i - 1][0], y1 = pts[i - 1][1], dx = pts[i][0] - x1, dy = pts[i][1] - y1, d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-6) continue;
      var a = Math.atan2(dy, dx), t = carry;
      if (a > Math.PI / 2) a -= Math.PI; else if (a < -Math.PI / 2) a += Math.PI;   // keep glyphs upright
      while (t <= d) {
        c.save(); c.translate(x1 + dx * t / d, y1 + dy * t / d); c.rotate(a); c.fillText('~', 0, 0); c.restore();
        t += 2.1;
      }
      carry = t - d;
    }
  }
  // The cup: its exact outline, then an ASCII \____/ drawn row by row along it.
  function drawCup(c, cup) {
    var cs = cupSegs(cup), k = S.col, fy = cup[1], d = cup[3], rows = Math.max(1, Math.round(d / RH)), i;
    c.lineCap = 'round'; c.strokeStyle = k.cupUnder; c.lineWidth = CUP_R * 2;
    c.beginPath(); c.moveTo(cs[0][0], cs[0][1]); c.lineTo(cs[0][2], cs[0][3]); c.lineTo(cs[1][2], cs[1][3]); c.lineTo(cs[1][0], cs[1][1]); c.stroke();
    setText(c, S.fnt, 'center'); c.fillStyle = k.cup;
    for (i = 0; i < rows; i++) {
      var y = fy - d + (i + 0.5) * d / rows, f = (y - cs[0][1]) / (cs[0][3] - cs[0][1]);
      c.fillText('\\', cs[0][0] + (cs[0][2] - cs[0][0]) * f, y);
      c.fillText('/', cs[1][0] + (cs[1][2] - cs[1][0]) * f, y);
    }
    var x0 = cs[2][0] + CW * 0.6, x1 = cs[2][2] - CW * 0.6, n = Math.max(1, Math.round((x1 - x0) / CW));
    for (i = 0; i <= n; i++) c.fillText('_', x0 + (x1 - x0) * i / n, fy - RH * 0.42);
    setText(c, font(0.6, 800), 'center'); c.fillStyle = k.cup;
    c.fillText('GOAL', cup[0], fy - d * 0.55);
  }
  function drawPortalMouth(c, x, y, label, spin, r) {
    var k = S.col;
    r = r || PORTAL_R;
    c.fillStyle = k.portalDim; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
    c.save(); c.translate(x, y); c.rotate(spin || 0);
    c.strokeStyle = k.portal; c.lineWidth = 0.5; c.setLineDash([1.1, 0.9]);
    c.beginPath(); c.arc(0, 0, r, 0, 6.2832); c.stroke();
    c.setLineDash([]);
    c.restore();
    setText(c, font(0.95, 800), 'center'); c.fillStyle = k.portal;
    c.fillText(label, x, y + 0.2);
  }
  function drawBumper(c, b, flash) {
    var k = S.col, r = b[2] * (1 + (flash || 0) * 0.12);
    c.fillStyle = k.bumpFill; c.beginPath(); c.arc(b[0], b[1], r, 0, 6.2832); c.fill();
    c.strokeStyle = k.bump; c.lineWidth = 0.55 + (flash || 0) * 0.5; c.beginPath(); c.arc(b[0], b[1], r, 0, 6.2832); c.stroke();
    c.lineWidth = 0.35; c.beginPath(); c.arc(b[0], b[1], r * 0.55, 0, 6.2832); c.stroke();
    setText(c, font(0.8, 800), 'center'); c.fillStyle = k.bump; c.fillText('*', b[0], b[1] + 0.5);
  }
  function drawMover(c, m, x, y) {
    var k = S.col, spike = m[7] === 'spike';
    c.fillStyle = spike ? k.spikeFill : k.wallFill; c.fillRect(x, y, m[2], m[3]);
    var r = [x, y, m[2], m[3]];
    if (spike) { fillGlyphs(c, r, 'X', k.spike); return; }
    c.strokeStyle = k.mover; c.lineWidth = 0.4; c.strokeRect(x + 0.2, y + 0.2, m[2] - 0.4, m[3] - 0.4);
    fillGlyphs(c, r, '=', k.mover);
  }
  function drawTrack(c, x0, y0, x1, y1) {
    var k = S.col;
    c.strokeStyle = k.track; c.lineWidth = 0.35; c.setLineDash([0.6, 1.4]);
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    c.setLineDash([]);
    setText(c, font(0.7), 'center'); c.fillStyle = k.track;
    var a = Math.atan2(y1 - y0, x1 - x0);
    [[x0, y0, a + Math.PI], [x1, y1, a]].forEach(function (e) { c.save(); c.translate(e[0], e[1]); c.rotate(e[2]); c.fillText('>', 0, 0); c.restore(); });
  }

  // Everything that never moves: rebuilt on level load, resize and theme change only.
  function buildStatic() {
    var L = S.L, k = S.col, i, a;
    var ly = S.stat && S.stat.cv.width === S.cv.width && S.stat.cv.height === S.cv.height ? S.stat : layer();
    var c = ly.c;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = k.bg; c.fillRect(0, 0, ly.cv.width, ly.cv.height);   // every device pixel, so no stale strip survives
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.fillStyle = k.dot;                                     // whiteboard dot grid
    var dr = Math.max(0.16, 0.5 / S.k * 1.6);
    for (var gy = RH * 2; gy < H; gy += RH * 2) for (var gx = CW * 4; gx < W; gx += CW * 4) c.fillRect(gx - dr / 2, gy - dr / 2, dr, dr);
    if (L.nodraw) for (i = 0; i < L.nodraw.length; i++) {
      a = L.nodraw[i];
      c.fillStyle = k.nodrawFill; c.fillRect(a[0], a[1], a[2], a[3]);
      c.save(); c.beginPath(); c.rect(a[0], a[1], a[2], a[3]); c.clip();
      c.strokeStyle = k.nodraw; c.lineWidth = 0.3;
      c.beginPath();
      for (var hx = a[0] - a[3]; hx < a[0] + a[2]; hx += 3.5) { c.moveTo(hx, a[1] + a[3]); c.lineTo(hx + a[3], a[1]); }
      c.stroke(); c.restore();
      c.strokeStyle = k.nodraw; c.lineWidth = 0.3; c.setLineDash([1, 1]); c.strokeRect(a[0], a[1], a[2], a[3]); c.setLineDash([]);
    }
    if (L.hint) {
      setText(c, font(0.82, 600), 'center'); c.fillStyle = k.hint;
      for (i = 0; i < L.hint.length; i++) c.fillText(L.hint[i][2], L.hint[i][0], L.hint[i][1]);
    }
    if (L.walls) for (i = 0; i < L.walls.length; i++) {
      a = L.walls[i];
      c.fillStyle = k.wallFill; c.fillRect(a[0], a[1], a[2], a[3]);
      fillGlyphs(c, a, '#', k.wall);
      c.strokeStyle = k.wallEdge; c.lineWidth = 0.3; c.strokeRect(a[0] + 0.15, a[1] + 0.15, a[2] - 0.3, a[3] - 0.3);
    }
    if (L.spikes) for (i = 0; i < L.spikes.length; i++) {
      a = L.spikes[i];
      var dir = a[4] || 'u';
      c.fillStyle = k.spikeFill; c.fillRect(a[0], a[1], a[2], a[3]);
      fillGlyphs(c, a, dir === 'u' ? '^' : dir === 'd' ? 'v' : dir === 'l' ? '<' : '>', k.spike);
    }
    if (L.planks) for (i = 0; i < L.planks.length; i++) {
      a = L.planks[i];
      c.lineCap = 'round'; c.strokeStyle = k.plankUnder; c.lineWidth = PLANK_R * 2;
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(a[2], a[3]); c.stroke();
      setText(c, S.fnt, 'center'); c.fillStyle = k.plank;
      stampSeg(c, a[0], a[1], a[2], a[3], '=', CW, true);
    }
    if (L.bumpers) for (i = 0; i < L.bumpers.length; i++) drawBumper(c, L.bumpers[i], 0);
    if (L.movers) for (i = 0; i < L.movers.length; i++) {
      var m = L.movers[i];
      drawTrack(c, m[0] + m[2] / 2, m[1] + m[3] / 2, m[0] + m[4] + m[2] / 2, m[1] + m[5] + m[3] / 2);
    }
    if (L.goal && L.goal.move) {
      var g = L.goal.cup, gm = L.goal.move;
      drawTrack(c, g[0], g[1] + 3, g[0] + gm[0], g[1] + gm[1] + 3);
    }
    if (L.goal && L.goal.zone) {
      a = L.goal.zone;
      c.fillStyle = k.cupUnder; c.globalAlpha = 0.35; c.fillRect(a[0], a[1], a[2], a[3]); c.globalAlpha = 1;
      c.strokeStyle = k.cup; c.lineWidth = 0.4; c.setLineDash([1.2, 0.8]); c.strokeRect(a[0], a[1], a[2], a[3]); c.setLineDash([]);
      setText(c, font(0.8, 800), 'center'); c.fillStyle = k.cup; c.fillText('[ GOAL ]', a[0] + a[2] / 2, a[1] + a[3] / 2);
    }
    if (L.goal && L.goal.cup && !L.goal.move) drawCup(c, L.goal.cup);
    if (L.ball[2] || L.ball[3]) {                              // the cannon behind a launched ball
      var ang = Math.atan2(L.ball[3] || 0, L.ball[2] || 0);
      c.save(); c.translate(L.ball[0], L.ball[1]); c.rotate(ang);
      c.fillStyle = k.wallFill; c.fillRect(-9, -2.6, 7.5, 5.2);
      c.strokeStyle = k.wallEdge; c.lineWidth = 0.4; c.strokeRect(-9, -2.6, 7.5, 5.2);
      setText(c, S.fnt, 'center'); c.fillStyle = k.wall; c.fillText('=', -7.4, 0); c.fillText('=', -4.9, 0);
      c.restore();
    }
    S.stat = ly;
  }
  // Committed ink strokes: rebuilt only when the drawing changes.
  function buildInk() {
    var ly = S.inkL && S.inkL.cv.width === S.cv.width && S.inkL.cv.height === S.cv.height ? S.inkL : layer();
    var c = ly.c;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, ly.cv.width, ly.cv.height);
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (S.L.ghost && !S.strokes.length) {                      // tutorial: a dotted line to trace
      var gp = S.L.ghost;
      c.fillStyle = S.col.ghost;
      for (var i = 1; i < gp.length; i++) {
        var dx = gp[i][0] - gp[i - 1][0], dy = gp[i][1] - gp[i - 1][1], d = Math.sqrt(dx * dx + dy * dy);
        for (var t = 0; t <= d; t += 2.2) { c.beginPath(); c.arc(gp[i - 1][0] + dx * t / d, gp[i - 1][1] + dy * t / d, 0.45, 0, 6.2832); c.fill(); }
      }
    }
    for (var j = 0; j < S.strokes.length; j++) drawStroke(c, S.strokes[j], S.col.ink, S.col.inkUnder);
    S.inkL = ly;
  }

  // ---------- the frame ----------
  function draw(alpha) {
    if (!S || !S.ctx || !S.stat) return;
    var c = S.ctx, L = S.L, k = S.col, sim = S.sim, t = sim ? sim.t : 0, i, a, tn = now();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(S.stat.cv, 0, 0);
    c.drawImage(S.inkL.cv, 0, 0);
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    // belts: arrows crawl while the ball runs
    if (L.belts) for (i = 0; i < L.belts.length; i++) {
      a = L.belts[i];
      c.fillStyle = k.beltFill; c.fillRect(a[0], a[1], a[2], a[3]);
      c.strokeStyle = k.belt; c.lineWidth = 0.35; c.strokeRect(a[0] + 0.2, a[1] + 0.2, a[2] - 0.4, a[3] - 0.4);
      var off = ((t * a[4]) % CW + CW) % CW;
      c.save(); c.beginPath(); c.rect(a[0] + 0.4, a[1], a[2] - 0.8, a[3]); c.clip();
      setText(c, S.fnt, 'left'); c.fillStyle = k.belt;
      c.fillText(rep(a[4] > 0 ? '>' : '<', Math.ceil(a[2] / CW) + 2), a[0] - CW + off, a[1] + a[3] / 2);
      c.restore();
    }
    if (L.glass) for (i = 0; i < L.glass.length; i++) {
      if (sim && sim.broken[i] != null) continue;
      a = L.glass[i];
      c.fillStyle = k.glassFill; c.fillRect(a[0], a[1], a[2], a[3]);
      c.strokeStyle = k.glass; c.lineWidth = 0.3; c.strokeRect(a[0] + 0.15, a[1] + 0.15, a[2] - 0.3, a[3] - 0.3);
      fillGlyphs(c, a, ':', k.glass);
    }
    if (L.movers) for (i = 0; i < L.movers.length; i++) {
      var m = L.movers[i], p = moverAt(m, t);
      drawMover(c, m, p.x, p.y);
    }
    if (L.bumpers && S.bumpT) for (i = 0; i < L.bumpers.length; i++) {
      var fl = S.bumpT[i] ? Math.max(0, 1 - (tn - S.bumpT[i]) / 0.25) : 0;
      if (fl > 0) drawBumper(c, L.bumpers[i], fl);
    }
    if (L.portals) for (i = 0; i < L.portals.length; i++) {
      a = L.portals[i];
      var lab = String.fromCharCode(65 + i), sp = t * 2.4;
      drawPortalMouth(c, a[0], a[1], lab, sp, a[4]);
      drawPortalMouth(c, a[2], a[3], lab, -sp, a[4]);
    }
    if (L.goal && L.goal.move) drawCup(c, cupAt(L.goal, t).c);
    if (L.star && !(sim && sim.pickups[0] && sim.pickups[0].got)) {
      setText(c, font(1.25, 800), 'center'); c.fillStyle = k.star;
      c.fillText('★', L.star[0], L.star[1] + 0.3);
    }
    if (S.cur && S.cur.pts.length > 1) drawStroke(c, S.cur.pts, k.inkCur, k.inkUnder);
    // the ball
    var bx = L.ball[0], by = L.ball[1], ba = 0;
    if (sim) {
      var b = sim.ball, al = alpha == null ? 1 : alpha;
      bx = b.px + (b.x - b.px) * al; by = b.py + (b.y - b.py) * al; ba = b.pa + (b.a - b.pa) * al;
    }
    var popped = S.phase === 'fail' && sim && sim.reason === 'spikes';
    if (!popped || tn - S.endT < 0.12) {
      c.fillStyle = k.ballBg; c.beginPath(); c.arc(bx, by, BALL_R + 0.3, 0, 6.2832); c.fill();
      c.save(); c.translate(bx, by); c.rotate(ba);
      setText(c, S.ballFnt, 'center'); c.fillStyle = k.ball; c.fillText('@', 0, 0.35);
      c.restore();
    }
    if (S.phase === 'edit' && !S.cur && (L.ball[2] || L.ball[3])) {   // where the cannon fires
      var vx = L.ball[2] || 0, vy = L.ball[3] || 0, sp2 = Math.sqrt(vx * vx + vy * vy);
      c.fillStyle = k.faint;
      for (i = 1; i <= 4; i++) { c.beginPath(); c.arc(bx + vx / sp2 * (3.6 + i * 2.2), by + vy / sp2 * (3.6 + i * 2.2), 0.42, 0, 6.2832); c.fill(); }
    }
    // sparks, shards, confetti
    for (i = 0; i < S.parts.length; i++) {
      var q = S.parts[i], life = 1 - q.t / q.life;
      if (life <= 0) continue;
      c.globalAlpha = Math.min(1, life * 1.4);
      setText(c, font(q.s || 0.8, 800), 'center'); c.fillStyle = q.col;
      c.fillText(q.ch, q.x, q.y);
    }
    c.globalAlpha = 1;
    if (S.mark && tn < S.mark.until) {                         // "can't draw here"
      setText(c, font(1.1, 800), 'center'); c.fillStyle = k.fail;
      c.fillText('×', S.mark.x, S.mark.y);
    }
    if (S.phase === 'fail' && S.failMsg) banner(c, '✗ ' + S.failMsg, k.fail);
    else if (S.phase === 'win' && !S.ovlKind) banner(c, S.L.sandbox ? 'in the cup!' : '✓ solved', k.good);
    else if (S.phase === 'end') banner(c, S.endMsg || '', k.muted);
  }
  // A status strip across the top of the board (covers any hint text under it).
  function banner(c, text, col) {
    c.fillStyle = S.col.bg; c.fillRect(0, 0, W, 11);
    c.strokeStyle = col; c.lineWidth = 0.3; c.beginPath(); c.moveTo(0, 11); c.lineTo(W, 11); c.stroke();
    setText(c, font(0.95, 800), 'center'); c.fillStyle = col;
    c.fillText(text, W / 2, 5.7);
  }

  // ---------- particles ----------
  function burst(x, y, n, chars, col, speed, life, grav) {
    if (S.rm) n = Math.min(n, 3);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * 6.2832, v = speed * (0.35 + Math.random() * 0.65);
      S.parts.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.3, t: 0, life: life * (0.7 + Math.random() * 0.5),
        ch: chars.charAt(Math.floor(Math.random() * chars.length)), col: col, g: grav == null ? 60 : grav, s: 0.7 + Math.random() * 0.4 });
    }
    if (S.parts.length > 160) S.parts.splice(0, S.parts.length - 160);
  }
  function stepParts(dt) {
    var out = [];
    for (var i = 0; i < S.parts.length; i++) {
      var q = S.parts[i];
      q.t += dt;
      if (q.t >= q.life) continue;
      q.vy += q.g * dt; q.x += q.vx * dt; q.y += q.vy * dt;
      out.push(q);
    }
    S.parts = out;
  }

  // ---------- loop: runs only while something moves ----------
  function busy() { return !!S && !S.paused && (S.phase === 'run' || S.parts.length > 0 || now() < S.animUntil); }
  function requestDraw() { if (S && !S.raf && !S.paused) S.raf = requestAnimationFrame(frame); }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0, alpha = 1;
    S.last = busy() ? ts : 0;
    if (S.phase === 'run' && S.sim) {
      alpha = advance(S.sim, dt);
      handleEvents();
      if (S.sim.state !== 'run') { onEnd(); alpha = 1; }
    }
    if (S.parts.length) stepParts(dt);
    if (S.cardAt && now() >= S.cardAt) { S.cardAt = 0; showOverlay('win'); }
    draw(alpha);
    if (busy() || S.cardAt) S.raf = requestAnimationFrame(frame);
    else S.last = 0;
  }
  function handleEvents() {
    var ev = S.sim.events, snd = S.snd, k = S.col;
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      switch (e.k) {
        case 'hit': snd.tone(180 + Math.min(1, e.v / 200) * 260, 0.05, 'triangle', 0.012 + Math.min(1, e.v / 200) * 0.03); break;
        case 'bump':
          if (S.bumpT && e.bi != null) S.bumpT[e.bi] = now();
          snd.tone(330, 0.14, 'sine', 0.05, 760);
          burst(e.x, e.y, 5, '*+', k.bump, 26, 0.35, 0);
          Cade.haptic && Cade.haptic(6);
          break;
        case 'glass':
          snd.noise(0.22, 0.07, 2600); snd.tone(1900, 0.08, 'triangle', 0.02, 2400);
          burst(e.x, e.y, 14, ':.,\'`', k.glass, 34, 0.7, 110);
          Cade.haptic && Cade.haptic(10);
          break;
        case 'star':
          snd.tone(1320, 0.09, 'sine', 0.045); snd.tone(1760, 0.14, 'sine', 0.04, 0, 0.07);
          burst(e.x, e.y, 9, '*+✦', k.star, 22, 0.55, 0);
          Cade.haptic && Cade.haptic(8);
          break;
        case 'portal':
          if (!S.lastPortal || now() - S.lastPortal > 0.1) { snd.tone(520, 0.16, 'sine', 0.035, 1040); S.lastPortal = now(); }
          burst(e.x, e.y, 5, '.o°', k.portal, 14, 0.35, 0);
          break;
        case 'pop':
          snd.noise(0.16, 0.06, 900); snd.tone(220, 0.16, 'square', 0.03, 70);
          burst(e.x, e.y, 12, '*x+.', k.fail, 30, 0.6, 40);
          Cade.haptic && Cade.haptic(28);
          break;
        case 'win':
          [784, 988, 1175, 1568].forEach(function (f, j) { snd.tone(f, 0.13, 'triangle', 0.04, 0, j * 0.08); });
          burst(e.x, e.y - 4, 22, '*+✦·', k.star, 40, 1.0, 70);
          burst(e.x, e.y - 4, 12, '*+·', k.ink, 36, 1.0, 70);
          Cade.haptic && Cade.haptic(14);
          break;
        case 'out': case 'stuck': case 'time':
          snd.tone(300, 0.18, 'sine', 0.035, 180);
          break;
      }
    }
    ev.length = 0;
  }

  // ---------- phases: edit → run → win / fail ----------
  function setPhase(ph) {
    S.phase = ph;
    S.panel.classList.toggle('id-running', ph === 'run');
    syncBar();
  }
  function drop() {
    if (!S || S.phase !== 'edit' || S.ovlKind) return;
    S.snd.ensure();
    S.cur = null;
    S.sim = newSim(S.L, S.strokes);
    S.bumpT = {};
    S.parts = [];
    S.failMsg = '';
    S.last = 0;
    setPhase('run');
    say('Dropped');
    requestDraw();
  }
  function backToEdit() {
    if (!S) return;
    S.sim = null; S.cardAt = 0; S.failMsg = ''; S.endMsg = '';
    S.parts = [];
    showOverlay(null);
    setPhase('edit');
    draw(1);
  }
  function onEnd() {
    var sim = S.sim, L = S.L;
    S.endT = now();
    if (L.sandbox) {
      S.endMsg = sim.state === 'win' ? 'in the cup!' : sim.reason === 'stuck' ? 'the ball came to rest' : sim.reason === 'spikes' ? 'pop!' : sim.reason === 'out' ? 'off the board' : 'time’s up';
      setPhase(sim.state === 'win' ? 'win' : 'end');
      say(S.endMsg);
      return;
    }
    if (sim.state === 'win') {
      var ink = inkOf(S.strokes), r = rate(L, ink, { result: 'win', got: sim.got });
      S.result = { r: r, ink: ink, prev: bestOf(L.id) };
      S.result.improved = record(L, r, ink);
      syncHud();
      setPhase('win');
      S.cardAt = now() + (S.rm ? 0.05 : 0.85);
      S.animUntil = S.cardAt + 0.1;
      say('Solved with ' + r.stars + ' star' + (r.stars === 1 ? '' : 's'));
    } else {
      S.failMsg = FAIL_TEXT[sim.reason] || 'missed';
      S.animUntil = now() + 0.3;
      setPhase('fail');
      say(S.failMsg + ' — adjust your lines and drop again');
    }
  }
  function primary() {                         // Space / Enter / the big button
    if (!S) return;
    S.snd.ensure();
    if (S.paused) { resume(); return; }
    if (S.ovlKind === 'win') { nextLevel(); return; }
    if (S.ovlKind) { showOverlay(null); return; }
    if (S.phase === 'edit') drop();
    else if (S.phase === 'win' && !S.L.sandbox) {
      if (S.cardAt) { S.cardAt = 0; showOverlay('win'); } else nextLevel();
    } else backToEdit();                       // stop a run, or retry after a miss
  }

  // ---------- levels ----------
  function levelIndex(id) { for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].id === id) return i; return -1; }
  function loadLevel(L) {
    if (S.L && S.phase !== 'run') saveDrawing();
    S.L = L;
    S.idx = levelIndex(L.id);
    S.strokes = loadDrawing(L);
    S.hist = [];
    S.sim = null; S.cur = null; S.parts = []; S.cardAt = 0; S.failMsg = ''; S.result = null;
    sset(K_LEVEL, L.id);
    S.cv.setAttribute('aria-label', 'Ink Drop board: ' + L.name + '. Draw lines with your finger or mouse, then drop the ball.');
    setPhase('edit');
    if (S.col) { buildStatic(); buildInk(); }
    syncHud();
    draw(1);
  }
  function nextLevel() {
    var i = S.idx + 1;
    if (S.L.sandbox || i >= LEVELS.length) { showOverlay('levels'); return; }
    if (!unlocked(i)) { showOverlay('levels'); return; }
    showOverlay(null);
    loadLevel(LEVELS[i]);
  }
  function stepLevel(d) {
    if (S.L.sandbox) return;
    var i = S.idx + d;
    if (i < 0 || i >= LEVELS.length || !unlocked(i)) return;
    loadLevel(LEVELS[i]);
  }

  // ---------- drawing ----------
  function toBoard(e) {
    var r = S.cv.getBoundingClientRect();
    return [(e.clientX - r.left) / (r.width || 1) * W, (e.clientY - r.top) / (r.height || 1) * H];
  }
  function inkLeft() { return S.L.ink - inkOf(S.strokes) - (S.cur ? S.cur.len : 0); }
  function markBlocked(p) { S.mark = { x: p[0], y: p[1], until: now() + 0.45 }; S.animUntil = Math.max(S.animUntil, S.mark.until); requestDraw(); }
  function addPoint(p) {
    var cur = S.cur, last = cur.pts[cur.pts.length - 1], dx = p[0] - last[0], dy = p[1] - last[1], d = Math.sqrt(dx * dx + dy * dy);
    if (cur.stop || d < 0.7) return;
    var q = clipSeg(S.L, last[0], last[1], p[0], p[1]);
    if (!q) { cur.stop = true; markBlocked(p); return; }
    if (q[0] !== p[0] || q[1] !== p[1]) { cur.stop = true; markBlocked(p); }
    dx = q[0] - last[0]; dy = q[1] - last[1]; d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-6) return;
    var left = S.L.ink - S.inkUsed - cur.len;
    if (d > left) {                                     // out of ink: end the line exactly at the budget
      var f = Math.max(0, left) / d;
      q = [last[0] + dx * f, last[1] + dy * f]; d = d * f;
      cur.stop = true;
      flashMeter();
    }
    if (d > 1e-6) { cur.pts.push(q); cur.len += d; }
  }
  function flashMeter() {
    var m = S.hudInk;
    if (!m) return;
    m.classList.remove('id-flash'); void m.offsetWidth; m.classList.add('id-flash');
    S.snd.tone(200, 0.08, 'square', 0.02);
  }
  function eraseAt(p) {
    var i = strokeAt(S.strokes, p[0], p[1], ERASE_TOL);
    if (i < 0) return false;
    S.hist.push({ t: 'erase', i: i, s: S.strokes[i] });
    S.strokes.splice(i, 1);
    S.snd.tone(260, 0.05, 'triangle', 0.02);
    strokesChanged();
    return true;
  }
  function strokesChanged() { buildInk(); saveDrawing(); syncHud(); syncBar(); requestDraw(); }
  function onDown(e) {
    if (!S || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    S.snd.ensure();
    if (S.paused) { resume(); return; }
    if (S.ovlKind || S.phase === 'run') return;
    if (S.phase !== 'edit') backToEdit();
    var p = toBoard(e);
    try { S.cv.setPointerCapture(e.pointerId); } catch (er) {}
    S.ptr = e.pointerId;
    if (S.mode === 'erase') { eraseAt(p); return; }
    if (blockedAt(S.L, p[0], p[1])) { markBlocked(p); S.ptr = null; return; }
    if (S.L.ink - inkOf(S.strokes) < 0.5) { flashMeter(); S.ptr = null; return; }
    S.inkUsed = inkOf(S.strokes);
    S.cur = { pts: [p], len: 0, stop: false };
    requestDraw();
  }
  function onMove(e) {
    if (!S || S.ptr == null || e.pointerId !== S.ptr) return;
    e.preventDefault();
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (!evs || !evs.length) evs = [e];
    for (var i = 0; i < evs.length; i++) {
      var p = toBoard(evs[i]);
      if (S.mode === 'erase') eraseAt(p);
      else if (S.cur) addPoint(p);
    }
    if (S.cur) { syncHud(); requestDraw(); }
  }
  function onUp(e) {
    if (!S || S.ptr == null || e.pointerId !== S.ptr) return;
    S.ptr = null;
    try { S.cv.releasePointerCapture(e.pointerId); } catch (er) {}
    var cur = S.cur;
    S.cur = null;
    if (!cur || e.type === 'pointercancel' && cur.len < MIN_STROKE) { syncHud(); requestDraw(); return; }
    var pts = simplify(S.L, cur.pts, INK_EPS), len = polyLength(pts);
    if (len >= MIN_STROKE && validDrawing(S.L, S.strokes.concat([pts]))) {
      S.strokes.push(pts);
      S.hist.push({ t: 'add' });
      S.snd.tone(620, 0.04, 'sine', 0.018);
      strokesChanged();
    } else { syncHud(); requestDraw(); }
  }
  function undo() {
    if (!S || S.phase === 'run' || S.ovlKind) return;
    if (S.phase !== 'edit') backToEdit();
    var h = S.hist.pop();
    if (!h) return;
    if (h.t === 'add') S.strokes.pop();
    else if (h.t === 'erase') S.strokes.splice(Math.min(h.i, S.strokes.length), 0, h.s);
    else if (h.t === 'clear') S.strokes = h.s.slice();
    strokesChanged();
  }
  function clearAll() {
    if (!S || S.phase === 'run' || S.ovlKind) return;
    if (S.phase !== 'edit') backToEdit();
    if (!S.strokes.length) return;
    S.hist.push({ t: 'clear', s: S.strokes.slice() });
    S.strokes = [];
    strokesChanged();
  }
  function setMode(m) {
    if (!S) return;
    S.mode = m;
    S.cv.classList.toggle('id-erasing', m === 'erase');
    syncBar();
  }

  // ---------- HUD, toolbar, overlays ----------
  function stars(n, of) { var s = ''; for (var i = 0; i < (of || 3); i++) s += i < n ? '★' : '☆'; return s; }
  function syncHud() {
    if (!S || !S.L) return;
    var L = S.L, used = inkOf(S.strokes) + (S.cur ? S.cur.len : 0);
    S.hudLv.innerHTML = L.sandbox ? '<b>∞</b> Sandbox' : '<b>' + L.ch + '-' + (S.idx - firstOfCh(L.ch) + 1) + '</b> ' + esc(L.name) +
      ' <span class="id-best" title="Best">' + stars(bestOf(L.id)) + '</span>';
    if (L.ink === Infinity) { S.hudInk.innerHTML = 'ink <b>∞</b>'; S.hudInk.title = 'Unlimited ink'; return; }
    var left = Math.max(0, L.ink - used), frac = left / L.ink, cells = 10, full = Math.round(frac * cells);
    if (left > 0.5 && full === 0) full = 1;
    var under = used <= L.par + 1e-6;
    S.hudInk.innerHTML = '<span class="id-meter" aria-hidden="true">[<i>' + rep('█', full) + '</i>' + rep('░', cells - full) + ']</span>' +
      ' <b>' + Math.round(frac * 100) + '%</b> <span class="id-par' + (under ? ' ok' : '') + '" title="Use at most ' + Math.round(L.par) + ' ink for the par star">★par</span>';
    S.hudInk.title = 'Ink left: ' + Math.round(left) + ' of ' + Math.round(L.ink) + ' (par ' + Math.round(L.par) + ')';
  }
  function firstOfCh(ch) { for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].ch === ch) return i; return 0; }
  function syncBar() {
    if (!S) return;
    var b = S.btn, ph = S.phase, editing = ph !== 'run';
    b.pen.classList.toggle('on', S.mode === 'draw'); b.pen.setAttribute('aria-pressed', S.mode === 'draw' ? 'true' : 'false');
    b.erase.classList.toggle('on', S.mode === 'erase'); b.erase.setAttribute('aria-pressed', S.mode === 'erase' ? 'true' : 'false');
    b.undo.disabled = !editing || !S.hist.length;
    b.clear.disabled = !editing || !S.strokes.length;
    b.pen.disabled = b.erase.disabled = !editing;
    var go = b.go;
    if (ph === 'run') { go.innerHTML = '<span aria-hidden="true">■</span> Stop'; go.title = 'Stop and edit (Space)'; }
    else if (ph === 'edit') { go.innerHTML = '<span aria-hidden="true">▼</span> DROP'; go.title = 'Drop the ball (Space)'; }
    else if (ph === 'win' && !S.L.sandbox) { go.innerHTML = 'Next <span aria-hidden="true">▶</span>'; go.title = 'Next level (Space)'; }
    else { go.innerHTML = '<span aria-hidden="true">↻</span> Retry'; go.title = 'Back to your drawing (Space)'; }
    go.classList.toggle('id-stop', ph === 'run');
    var sb = S.hdr.snd;
    sb.innerHTML = S.snd.on ? IC.sndOn : IC.sndOff;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
  }
  function say(t) { if (S && S.live) S.live.textContent = t; }

  function levelsHtml() {
    var h = '<div class="id-card id-levels" role="dialog" aria-label="Levels"><div class="id-lhead"><span class="id-ltitle">LEVELS</span>' +
      '<span class="id-ltot">★ ' + starTotal() + '/' + LEVELS.length * 3 + '</span>' +
      '<button type="button" class="id-x" data-act="close" aria-label="Close levels">×</button></div>';
    for (var c = 0; c < CHAPTERS.length; c++) {
      var ch = CHAPTERS[c];
      h += '<div class="id-ch"><div class="id-chname"><b>' + ch.n + '</b> ' + esc(ch.name) + ' <span>— ' + esc(ch.blurb) + '</span></div><div class="id-grid">';
      var n = 0;
      for (var i = 0; i < LEVELS.length; i++) {
        var L = LEVELS[i];
        if (L.ch !== ch.n) continue;
        n++;
        var un = unlocked(i), st = bestOf(L.id), cur = S.L && S.L.id === L.id;
        h += '<button type="button" class="id-tile' + (cur ? ' cur' : '') + (st ? ' done' : '') + '"' + (un ? '' : ' disabled') +
          ' data-lv="' + i + '" title="' + esc(ch.n + '-' + n + ' ' + L.name) + (un ? '' : ' (locked)') + '">' +
          '<span class="id-tn">' + ch.n + '-' + n + '</span>' +
          '<span class="id-ts">' + (un ? stars(st) : IC.lock) + '</span></button>';
      }
      h += '</div></div>';
    }
    h += '<div class="id-lfoot"><button type="button" class="id-tile id-sand' + (S.L && S.L.sandbox ? ' cur' : '') + '" data-lv="sandbox">' +
      '<span class="id-tn">∞</span><span class="id-ts">sandbox</span></button>' +
      '<p class="id-note">Solve one to unlock the next — you can skip two. Stars: reach the cup · stay under par ink · grab the ★.</p>' +
      '<button type="button" class="id-link" data-act="reset">reset progress</button></div></div>';
    return h;
  }
  function winHtml() {
    var R = S.result, r = R.r, L = S.L, last = S.idx >= LEVELS.length - 1;
    var row = function (ok, txt) { return '<li class="' + (ok ? 'ok' : 'no') + '"><span>' + (ok ? '✓' : '✗') + '</span>' + txt + '</li>'; };
    return '<div class="id-card id-win" role="dialog" aria-label="Solved"><div class="id-wtitle">SOLVED</div>' +
      '<div class="id-wstars" aria-label="' + r.stars + ' of 3 stars">' + stars(r.stars).split('').map(function (c, i) {
        return '<span class="' + (i < r.stars ? 'on' : '') + '" style="animation-delay:' + (0.12 * i) + 's">' + c + '</span>';
      }).join('') + '</div><ul class="id-checks">' +
      row(true, 'reached the cup') +
      row(r.par, 'ink ' + Math.round(R.ink) + (r.par ? ' ≤ ' : ' > ') + 'par ' + Math.round(L.par)) +
      row(r.star, r.star ? 'grabbed the ★' : 'missed the ★') + '</ul>' +
      (R.improved && R.prev ? '<div class="id-new">new best!</div>' : R.prev > r.stars ? '<div class="id-note">best: ' + stars(R.prev) + '</div>' : '') +
      '<div class="id-wbtns"><button type="button" class="id-b2" data-act="again">↻ Tweak</button>' +
      '<button type="button" class="id-b2" data-act="levels">Levels</button>' +
      '<button type="button" class="id-go2" data-act="next">' + (last ? 'All done ★' : 'Next ▶') + '</button></div></div>';
  }
  function showOverlay(kind) {
    if (!S) return;
    S.ovlKind = kind;
    var o = S.ovl;
    if (!kind) { o.innerHTML = ''; o.style.display = 'none'; S.stage.classList.remove('dim'); syncBar(); return; }
    if (kind === 'levels' && S.phase === 'run') { S.sim = null; setPhase('edit'); }
    o.innerHTML = kind === 'levels' ? levelsHtml() : kind === 'win' ? winHtml() :
      '<div class="id-card id-pause"><div class="id-wtitle">PAUSED</div><button type="button" class="id-go2" data-act="resume">Resume</button>' +
      '<div class="id-note">' + (S.coarse ? 'tap' : 'Space / click') + ' to carry on</div></div>';
    o.style.display = '';
    o.scrollTop = 0;
    S.stage.classList.add('dim');
    syncBar();
    var f = o.querySelector(kind === 'levels' ? '.id-tile.cur:not([disabled]), .id-tile:not([disabled])' : '.id-go2');
    if (f && !S.coarse) { try { f.focus({ preventScroll: true }); } catch (e) {} }
  }
  function onOverlayClick(e) {
    var t = e.target.closest ? e.target.closest('[data-act],[data-lv]') : null;
    if (!S) return;
    if (!t) {
      if (S.ovlKind === 'pause') resume();
      else if (e.target === S.ovl) showOverlay(null);    // a tap on the dimmed board closes the card
      return;
    }
    var act = t.getAttribute('data-act'), lv = t.getAttribute('data-lv');
    if (lv != null) {
      showOverlay(null);
      loadLevel(lv === 'sandbox' ? SANDBOX : LEVELS[+lv]);
      return;
    }
    if (act === 'close') showOverlay(null);
    else if (act === 'resume') resume();
    else if (act === 'again') backToEdit();
    else if (act === 'levels') showOverlay('levels');
    else if (act === 'next') nextLevel();
    else if (act === 'reset') {
      var ok = false;
      try { ok = window.confirm('Reset all Ink Drop stars and drawings?'); } catch (er) {}
      if (!ok) return;
      S.prog = { v: 1, best: {} };
      sset(K_PROG, JSON.stringify(S.prog));
      sset(K_DRAW, '{}');
      S.strokes = []; S.hist = [];
      showOverlay(null);
      loadLevel(LEVELS[0]);
    }
  }

  // ---------- pause (only a running ball can pause; drawing is turn-based) ----------
  function pause() {
    if (!S || S.paused || S.phase !== 'run') return;
    S.paused = true;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    S.last = 0;
    showOverlay('pause');
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    S.last = 0;
    showOverlay(null);
    requestDraw();
  }

  // ---------- keyboard ----------
  var KEY2CODE = { ' ': 'Space', enter: 'Enter', escape: 'Escape', z: 'KeyZ', e: 'KeyE', d: 'KeyD', l: 'KeyL', c: 'KeyC', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight' };
  function onKey(e) {
    if (!S) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    var t = e.target;
    if (t && (t.isContentEditable || (t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) && !S.panel.contains(t)) return;
    var code = e.code || KEY2CODE[(e.key || '').toLowerCase()] || '';
    if ((e.ctrlKey || e.metaKey) && !e.altKey && code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (code === 'Escape') {
      e.preventDefault();
      if (S.ovlKind === 'levels' || S.ovlKind === 'win') showOverlay(null);
      else if (S.paused) resume();
      else if (S.phase === 'run') backToEdit();
      else closePanel();
      return;
    }
    if (t && t.tagName === 'BUTTON' && S.panel.contains(t) && (code === 'Space' || code === 'Enter' || code === 'NumpadEnter')) return; // let the focused button click
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') { e.preventDefault(); if (!e.repeat) primary(); return; }
    if (e.repeat) return;
    if (code === 'KeyZ' || code === 'Backspace') { e.preventDefault(); undo(); }
    else if (code === 'KeyE') { e.preventDefault(); setMode(S.mode === 'erase' ? 'draw' : 'erase'); }
    else if (code === 'KeyD') { e.preventDefault(); setMode('draw'); }
    else if (code === 'KeyC') { e.preventDefault(); clearAll(); }
    else if (code === 'KeyL') { e.preventDefault(); showOverlay(S.ovlKind === 'levels' ? null : 'levels'); }
    else if ((code === 'ArrowRight' || code === 'ArrowLeft') && !S.ovlKind && S.phase !== 'run') { e.preventDefault(); stepLevel(code === 'ArrowRight' ? 1 : -1); }
  }

  // ---------- layout ----------
  // Height the board may use: the visible viewport minus the panel's top offset
  // and everything around the board (title bar, HUD, toolbar, padding). Measured
  // from those parts, not the panel, which the core may have capped (scrolling).
  function availH(vh) {
    var r = S.panel.getBoundingClientRect(), head = S.panel.querySelector('.cade-panel-head'), body = S.panel.querySelector('.cade-panel-body');
    if (!r.height) return vh - 240;
    var pad = 18;
    try { var bs = getComputedStyle(body); pad = parseFloat(bs.paddingTop) + parseFloat(bs.paddingBottom); } catch (e) {}
    var chrome = (head ? head.offsetHeight : 34) + (S.root.offsetHeight - S.stage.offsetHeight) + pad + 2;
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 8;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var s = Math.min((vw - (vw <= 560 ? 42 : 48)) / W, availH(vh) / H, 4.6);
    s = Math.max(s, 2);
    var cw = Math.floor(W * s), ch = Math.round(cw * H / W), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.root.style.width = cw + 'px';
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / W;
  }
  function refit() {
    if (!S) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // hidden: the restore handler refits
    layout();
    if (S.col) { fitFont(); S.ballFnt = font(BALL_R * 2 / CW * 1.02, 800); buildStatic(); buildInk(); }
    draw(1);
  }

  // ---------- open / close ----------
  function teardown() {
    if (!S) return;
    var s = S;
    if (s.phase !== 'run') { try { saveDrawing(); } catch (e) {} }
    S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    s.stat = s.inkL = null;                                 // drop the cached layers
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }

  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { closePanel(); return; }
    var tb = function (act, icon, title) { return '<button type="button" class="id-tb" data-act="' + act + '" title="' + title + '" aria-label="' + title + '">' + icon + '</button>'; };
    var body = '<div class="id"><div class="id-hud"><span class="id-lv"></span><span class="id-ink"></span></div>' +
      '<div class="id-stage"><canvas class="id-cv"></canvas><div class="id-ovl" style="display:none"></div></div>' +
      '<div class="id-bar">' + tb('pen', IC.pen, 'Draw (D)') + tb('erase', IC.erase, 'Erase: tap a line (E)') +
      tb('undo', IC.undo, 'Undo (Z)') + tb('clear', IC.clear, 'Clear all lines (C)') +
      '<span class="id-sp"></span><button type="button" class="id-go" data-act="go"></button></div>' +
      '<div class="id-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🖋️ Ink Drop', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    // header: levels + sound, before the core's minimize button
    var hb = document.createElement('span');
    hb.className = 'id-hbtns';
    hb.innerHTML = '<button type="button" class="id-hb" data-act="levels" title="Levels (L)" aria-label="Levels">' + IC.grid + '</button>' +
      '<button type="button" class="id-hb" data-act="sound"></button>';
    var head = p.querySelector('.cade-panel-head');
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });   // controls, not a drag handle
    var mm = window.matchMedia;
    S = {
      panel: p, root: p.querySelector('.id'), stage: p.querySelector('.id-stage'), cv: p.querySelector('.id-cv'), ovl: p.querySelector('.id-ovl'),
      hudLv: p.querySelector('.id-lv'), hudInk: p.querySelector('.id-ink'), live: p.querySelector('.id-live'),
      btn: { pen: p.querySelector('[data-act="pen"]'), erase: p.querySelector('[data-act="erase"]'), undo: p.querySelector('[data-act="undo"]'),
        clear: p.querySelector('[data-act="clear"]'), go: p.querySelector('[data-act="go"]') },
      hdr: { levels: hb.querySelector('[data-act="levels"]'), snd: hb.querySelector('[data-act="sound"]') },
      snd: new Snd(sget(K_SOUND) === '1'), prog: loadProg(),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      L: null, idx: 0, strokes: [], hist: [], cur: null, mode: 'draw', phase: 'edit', sim: null, parts: [], bumpT: {},
      raf: 0, last: 0, paused: false, ovlKind: null, animUntil: 0, cardAt: 0, endT: 0, k: 1, ptr: null, mark: null, inkUsed: 0
    };
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { pause(); };
    window.addEventListener('blur', S.onBlur);
    // Minimized to the dock: a running drop pauses; nothing draws until restored.
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      pause();
      if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    });
    p.addEventListener('cade-panel-restore', function () { if (S && S.panel === p) { refit(); requestDraw(); } });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(refit, 140);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () { if (S) { readTheme(); refit(); } });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    S.cv.addEventListener('pointerdown', onDown);
    S.cv.addEventListener('pointermove', onMove);
    S.cv.addEventListener('pointerup', onUp);
    S.cv.addEventListener('pointercancel', onUp);
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.ovl.addEventListener('click', onOverlayClick);
    p.querySelector('.id-bar').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      S.snd.ensure();
      var a = b.getAttribute('data-act');
      if (a === 'pen') setMode('draw');
      else if (a === 'erase') setMode(S.mode === 'erase' ? 'draw' : 'erase');
      else if (a === 'undo') undo();
      else if (a === 'clear') clearAll();
      else if (a === 'go') primary();
      if (S && (S.coarse || e.detail > 0)) { try { b.blur(); } catch (er) {} }   // pointer clicks leave Space to DROP
    });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var a = b.getAttribute('data-act');
      if (a === 'levels') showOverlay(S.ovlKind === 'levels' ? null : 'levels');
      else if (a === 'sound') {
        S.snd.on = !S.snd.on;
        sset(K_SOUND, S.snd.on ? '1' : '0');
        S.snd.ensure();
        S.snd.tone(880, 0.07, 'sine', 0.04);
        syncBar();
      }
      try { b.blur(); } catch (er) {}
    });

    var id = sget(K_LEVEL), L = id === 'sandbox' ? SANDBOX : LEVELS[Math.max(0, levelIndex(id))];
    if (!L.sandbox && !unlocked(levelIndex(L.id))) L = LEVELS[0];
    layout();
    readTheme();
    S.ballFnt = font(BALL_R * 2 / CW * 1.02, 800);
    loadLevel(L);
    // The glyph grid is fitted to the mono font's advance: refit once it has loaded.
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('700 12px ' + S.font).then(function () { if (S && S.panel === p) refit(); }, function () {});
      }
    } catch (e) {}
    // The panel's chrome is only measurable once laid out (and its stylesheet applied):
    // fit the board again next frame and once more shortly after.
    requestAnimationFrame(function () { if (S && S.panel === p) refit(); });
    S.resizeT = setTimeout(function () { if (S && S.panel === p) refit(); }, 350);
  }

  Cade.registerWidget({
    name: 'Ink Drop',
    description: 'Draw lines, drop the ball, land it in the cup — 24 ASCII physics puzzles',
    icon: '🖋️',
    tags: 'game,puzzle,physics,draw,line,ink,ball,drop,cup,brain,crayon,fun,train',
    open: open
  });
})();
