/* Curling — slide stones down a sheet of pebbled ice, for Cade.txt.
 * A top-down sheet drawn in monospace glyphs (cached in a glyph atlas) with the
 * house in theme tints. Set the skip's broom (aim), the weight (how hard) and
 * the handle (in-turn ↻ curls right, out-turn ↺ curls left), then deliver. The
 * stone slows on the ice and curls more and more as it slows; sweep (tap or hold
 * the SWEEP button / Space while it slides) to carry it farther and straighter.
 * Stones collide (equal masses, slightly inelastic), go out at the side lines
 * and the back line, a stone that never clears the far hog line comes off, and
 * the optional free guard zone rule protects early guards. Each end is scored
 * on the stones closest to the button; the team that scores gives up the hammer
 * (the last stone). 4, 6 or 8 ends; 4, 6 or 8 stones a side.
 * Play the CPU (Club / Skilled / Elite — it reads the house and picks a draw,
 * guard, takeout or raise by simulating the shots, then sweeps them to the
 * line) or pass-and-play with a friend on one device.
 * Physics runs on a fixed 120 Hz step with an accumulator (time sped up 2.6x
 * so a draw takes ~10 s); rendering interpolates; the loop runs only while
 * something moves; it pauses on blur, tab hide and minimize. Match and records
 * persist in Cade.store (cade-curling-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // Units: metres and seconds. y runs down the sheet from the near hog line
  // (where the stone is released, y = 0) towards the far house; x across it
  // (0 = centre line, + = right as the thrower sees it).
  var STEP = 1 / 120;
  var G = 9.81;
  var MU = 0.0095;                        // ice friction (a draw is released at ~2.3 m/s)
  var R = 0.145;                          // stone radius
  var HW = 2.375;                         // half the sheet's width
  var HOG = 21.95, TEE = 28.35, BACK = 30.18;
  var R12 = 1.83, R8 = 1.22, R4 = 0.61, RB = 0.15;
  var K_CURL = 0.009, VC = 0.32;          // curl: lateral accel K / max(v, VC) — grows as the stone slows
  var SW_MU = 0.2, SW_CURL = 0.5;         // full sweeping: 20% less friction, half the curl
  var E_REST = 0.88;                      // stone on stone restitution
  var W0 = 1.1;                           // spin at release (rad/s)
  var V_STOP = 0.006;
  var V_MIN = 1.6, V_MAX = 4.3;           // release speeds the weight control spans
  var TIME_SCALE = 2.6;                   // the UI runs the sim this much faster than real time
  var SPEC = { ends: [4, 6, 8], spe: [4, 6, 8] };
  var LEVELS = [
    { id: 0, name: 'Club', sa: 0.0075, sv: 0.028, top: 4, tol: 0.45, full: false },
    { id: 1, name: 'Skilled', sa: 0.0042, sv: 0.015, top: 2, tol: 0.22, full: true },
    { id: 2, name: 'Elite', sa: 0.0022, sv: 0.008, top: 1, tol: 0.08, full: true, robust: 3 }
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
  function hash2(a, b) {
    var h = Math.imul((a | 0) ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul((b | 0) + 0x632BE5AB, 0xC2B2AE35);
    h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
    return h >>> 0;
  }
  function gauss(r) { var u = r() || 1e-9, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  // ---- the sheet ----
  function distB(x, y) { var dy = y - TEE; return Math.sqrt(x * x + dy * dy); }
  function inHouse(s) { return distB(s.x, s.y) <= R12 + R; }
  // The free guard zone: past the far hog line, short of the tee line, not in the house.
  function inFGZ(s) { return s.y - R > HOG && s.y < TEE && !inHouse(s); }
  function isOut(s) { return Math.abs(s.x) + R >= HW || s.y - R > BACK || s.y < -2; }
  // Where a straight stone released at v would stop (no curl, no sweeping): its path length.
  function reach(v) { return v * v / (2 * MU * G); }
  function speedFor(len) { return Math.sqrt(2 * MU * G * Math.max(0, len)); }
  // Broom on the tee line → the release angle (from the centre line, + = right).
  function angleFor(bx) { return Math.atan2(bx, TEE); }
  function broomFor(theta) { return TEE * Math.tan(theta); }
  // The weight called by name: where it would stop (or what it does) if thrown straight.
  function weightName(v) {
    var y = reach(v), d = y - TEE;
    if (y - R <= HOG) return 'Hog';
    if (y < TEE - R12 - 0.2) return 'Guard';
    if (y < TEE - R12 + 0.1) return 'Biter';
    if (d < -R8) return 'Top 12';
    if (d < -R4) return 'Top 8';
    if (d < -RB) return 'Top 4';
    if (d <= RB) return 'Button';
    if (d < R4) return 'Back 4';
    if (d < R8) return 'Back 8';
    if (y < BACK) return 'Back 12';
    if (y < BACK + 2.5) return 'Hack';
    if (y < BACK + 9) return 'Tap';
    if (v < 3.55) return 'Takeout';
    return 'Peel';
  }

  // ---- stones and one delivery's physics ----
  function mkStone(id, team, x, y) { return { id: id, team: team, x: x, y: y, vx: 0, vy: 0, w: 0, a: 0, px: x, py: y, pa: 0, out: false, oy: 0 }; }
  function cloneStone(s) {
    var q = mkStone(s.id, s.team, s.x, s.y);
    q.vx = s.vx || 0; q.vy = s.vy || 0; q.w = s.w || 0; q.a = s.a || 0; q.pa = q.a;
    return q;
  }
  // A shot: { th: release angle (rad, + = right), v: release speed (m/s), turn: +1 in-turn (curls right) / -1 out-turn }.
  function newShot(stones, team, shot, id) {
    var list = (stones || []).filter(function (s) { return !s.out; }).map(cloneStone), th = shot.th || 0, v = clamp(shot.v, 0.2, 6);
    var d = mkStone(id == null ? 99 : id, team, 0, 0);
    d.vx = v * Math.sin(th); d.vy = v * Math.cos(th); d.w = (shot.turn < 0 ? -1 : 1) * W0;
    list.push(d);
    var snap = list.map(function (s) { return { id: s.id, team: s.team, x: s.x, y: s.y }; });
    snap.pop();
    return { st: list, d: d, team: team, snap: snap, t: 0, acc: 0, steps: 0, hit: false, done: false,
      events: [], hits: [], outs: [], maxV: v, sweepT: 0 };
  }
  function moving(s) { return !s.out && (s.vx !== 0 || s.vy !== 0); }

  // One fixed step. sweep in [0, 1]: how hard the throwing team sweeps its moving stones.
  function stepShot(f, sweep) {
    if (f.done) return;
    var st = f.st, n = st.length, dt = STEP, i, j, s, any = false;
    sweep = clamp(+sweep || 0, 0, 1);
    f.steps++; f.t += dt;
    for (i = 0; i < n; i++) { s = st[i]; s.px = s.x; s.py = s.y; s.pa = s.a; }
    for (i = 0; i < n; i++) {
      s = st[i];
      if (!moving(s)) continue;
      var v = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
      if (v < V_STOP) { s.vx = 0; s.vy = 0; s.w = 0; continue; }
      var sw = s.team === f.team ? sweep : 0;
      if (sw > 0) f.sweepT += dt * sw;
      var ux = s.vx / v, uy = s.vy / v;
      var vn = Math.max(0, v - MU * (1 - SW_MU * sw) * G * dt);
      // curl: a push to the right of the stone's travel for clockwise spin, growing as it slows
      var sp = clamp(s.w / W0, -1, 1), al = K_CURL * sp * (1 - SW_CURL * sw) / Math.max(v, VC);
      s.vx = ux * vn + uy * al * dt;
      s.vy = uy * vn - ux * al * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.a += s.w * dt;
      any = true;
    }
    // collisions: equal masses, impulse along the line of centres
    var D = 2 * R, D2 = D * D;
    for (i = 0; i < n; i++) {
      var a = st[i];
      if (a.out) continue;
      for (j = i + 1; j < n; j++) {
        var b = st[j];
        if (b.out || (!moving(a) && !moving(b))) continue;
        var dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 >= D2 || d2 === 0) continue;
        var d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        var rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (rel > 0) {
          var J = (1 + E_REST) / 2 * rel;
          a.vx -= J * nx; a.vy -= J * ny; b.vx += J * nx; b.vy += J * ny;
          a.w *= 0.3; b.w = a.w * 0.2;
          if (a === f.d || b === f.d) f.hit = true;
          f.events.push('hit');
          f.hits.push({ x: a.x + nx * R, y: a.y + ny * R, v: rel });
        }
        var push = (D - d) / 2 + 1e-6;
        a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
      }
    }
    for (i = 0; i < n; i++) {
      s = st[i];
      if (!s.out && isOut(s)) {
        s.out = true; s.vx = 0; s.vy = 0; s.w = 0; s.oy = s.y;
        f.outs.push(s); f.events.push('out');
      }
    }
    if (!any) { f.done = true; f.events.push('rest'); }
  }
  // Advance real time dt (already scaled); returns the render interpolation alpha.
  // sweep: a number, or a function (f) → sweep for each step (the CPU's sweepers).
  function advance(f, dt, sweep) {
    f.acc = Math.min(f.acc + dt, 0.5);
    while (f.acc >= STEP && !f.done) { stepShot(f, typeof sweep === 'function' ? sweep(f) : sweep); f.acc -= STEP; }
    return f.done ? 1 : f.acc / STEP;
  }
  // Run a shot to rest. sweepFn(f) → sweep for each step (optional).
  function runShot(f, sweepFn) {
    var guard = 0;
    while (!f.done && guard++ < 20000) { stepShot(f, sweepFn ? sweepFn(f) : 0); f.events.length = 0; f.hits.length = 0; }
    return f;
  }

  // The rules once the stones are still: hog line, free guard zone. Pure.
  function resolve(m, f) {
    var st = f.st.filter(function (s) { return !s.out; }), d = f.d, why = '', removed = [];
    if (!d.out && !f.hit && d.y - R <= HOG) { st = st.filter(function (s) { return s !== d; }); why = 'hog'; }
    if (!why && m.fgz && m.thrown < fgzRocks(m)) {
      var broke = f.snap.some(function (q) {
        if (q.team === f.team || !inFGZ(q)) return false;
        for (var i = 0; i < st.length; i++) if (st[i].id === q.id) return false;
        return true;
      });
      if (broke) {
        st = f.snap.map(function (q) { return mkStone(q.id, q.team, q.x, q.y); });
        why = 'fgz';
      }
    }
    var left = {};
    st.forEach(function (s) { left[s.id] = 1; });
    f.snap.forEach(function (q) { if (!left[q.id]) removed.push(q); });
    return {
      stones: st.map(function (s) { return { id: s.id, team: s.team, x: +s.x.toFixed(4), y: +s.y.toFixed(4) }; }),
      why: why, removed: removed, kept: why === '' && !d.out && left[d.id] === 1,
      outOpp: removed.filter(function (q) { return q.team !== f.team; }).length,
      outOwn: removed.filter(function (q) { return q.team === f.team; }).length
    };
  }
  function fgzRocks(m) { return m.spe <= 4 ? 4 : 5; }

  // Who lies shot: the team with the closest stone scores one for each of its
  // stones nearer than the other team's closest (stones touching the house only).
  function scoreEnd(stones) {
    var h = stones.filter(function (s) { return !s.out && inHouse(s); }).map(function (s) { return { s: s, d: distB(s.x, s.y) }; });
    h.sort(function (a, b) { return a.d - b.d; });
    if (!h.length) return { team: -1, pts: 0, order: [] };
    var team = h[0].s.team, pts = 0;
    while (pts < h.length && h[pts].s.team === team) pts++;
    return { team: team, pts: pts, order: h.slice(0, pts).map(function (q) { return q.s.id; }) };
  }

  // ---- the match ----
  function newMatch(o) {
    o = o || {};
    var seed = (o.seed >>> 0) || 1, r = rng(hash2(seed, 5));
    return {
      v: 1, seed: seed, mode: o.mode === '2p' ? '2p' : 'cpu', level: clamp(o.level | 0, 0, 2),
      ends: SPEC.ends.indexOf(o.ends | 0) >= 0 ? o.ends | 0 : 6, spe: SPEC.spe.indexOf(o.spe | 0) >= 0 ? o.spe | 0 : 6,
      fgz: o.fgz !== false, end: 1, thrown: 0, score: [0, 0], hammer: r() < 0.5 ? 0 : 1, stones: [], nextId: 1,
      log: [], over: false, winner: -1, lastEnd: null, n: 0
    };
  }
  function toThrow(m) { return m.thrown % 2 === 0 ? 1 - m.hammer : m.hammer; }
  function stonesLeft(m, team) {
    var k = m.spe - (team === m.hammer ? Math.floor(m.thrown / 2) : Math.ceil(m.thrown / 2));
    return Math.max(0, k);
  }
  function deliver(m, shot) { return newShot(m.stones, toThrow(m), shot, m.nextId); }
  // Fold a finished delivery into the match. Returns what happened.
  function finishShot(m, f) {
    var res = resolve(m, f);
    m.stones = res.stones; m.nextId++; m.thrown++; m.n++;
    var info = { res: res, endDone: false, over: false, end: null };
    if (m.thrown >= 2 * m.spe) {
      var sc = scoreEnd(m.stones), e = { end: m.end, team: sc.team, pts: sc.pts, hammer: m.hammer, stones: m.stones, order: sc.order };
      if (sc.pts > 0) { m.score[sc.team] += sc.pts; m.hammer = 1 - sc.team; }
      m.log.push({ end: m.end, team: sc.team, pts: sc.pts });
      m.lastEnd = e; info.endDone = true; info.end = e;
      m.end++; m.thrown = 0; m.stones = [];
      if (m.end > m.ends) {
        if (m.score[0] !== m.score[1]) { m.over = true; m.winner = m.score[0] > m.score[1] ? 0 : 1; }
        else if (m.end > m.ends + 3) { m.over = true; m.winner = -1; }   // three extra ends all square: a draw
      }
      info.over = m.over;
    }
    return info;
  }
  function normMatch(o) {
    if (!o || typeof o !== 'object' || o.v !== 1) return null;
    var m = newMatch({ seed: o.seed, mode: o.mode, level: o.level, ends: o.ends, spe: o.spe, fgz: o.fgz });
    m.end = clamp(o.end | 0, 1, m.ends + 4);
    m.thrown = clamp(o.thrown | 0, 0, 2 * m.spe - 1);
    m.score = [Math.max(0, o.score && o.score[0] | 0), Math.max(0, o.score && o.score[1] | 0)];
    m.hammer = o.hammer === 0 ? 0 : 1;
    m.nextId = Math.max(1, o.nextId | 0);
    m.n = Math.max(0, o.n | 0);
    m.over = !!o.over; m.winner = o.winner === 0 || o.winner === 1 ? o.winner : -1;
    m.stones = Array.isArray(o.stones) ? o.stones.filter(function (s) {
      return s && isFinite(s.x) && isFinite(s.y) && (s.team === 0 || s.team === 1) && !isOut({ x: +s.x, y: +s.y });
    }).slice(0, 2 * m.spe).map(function (s) { return { id: s.id | 0, team: s.team, x: +s.x, y: +s.y }; }) : [];
    // ids must stay unique: the next stone's id is past every stone already on the sheet
    m.stones.forEach(function (s) { if (s.id >= m.nextId) m.nextId = s.id + 1; });
    m.log = Array.isArray(o.log) ? o.log.filter(function (e) { return e && isFinite(e.end); }).slice(0, 12).map(function (e) {
      return { end: e.end | 0, team: e.team === 0 || e.team === 1 ? e.team : -1, pts: clamp(e.pts | 0, 0, 8) };
    }) : [];
    return m;
  }

  // ---- solving shots (the CPU's skip, and the aim guide) ----
  // A stone thrown straight up the centre at v: where it comes to rest and its path.
  var FREE = {};
  function freePath(v, turn, keep) {
    var key = v.toFixed(4) + (turn < 0 ? 'L' : 'R');
    if (!keep && FREE[key]) return FREE[key];
    var f = newShot([], 0, { th: 0, v: v, turn: turn }, 0), pts = [0, 0], k = 0;
    while (!f.done && k++ < 20000) {
      stepShot(f, 0);
      if (f.steps % 12 === 0) pts.push(f.d.x, f.d.y);
      if (f.d.out) break;
    }
    pts.push(f.d.x, f.d.y);
    var out = { x: f.d.x, y: f.d.y, pts: pts };
    if (Object.keys(FREE).length > 600) FREE = {};
    FREE[key] = out;
    return out;
  }
  function rot(x, y, th) { var c = Math.cos(th), s = Math.sin(th); return { x: x * c + y * s, y: -x * s + y * c }; }
  // Draw to (tx, ty) with the given turn: the speed and angle that bring a free stone to rest there.
  function solveDraw(tx, ty, turn) {
    var L = Math.sqrt(tx * tx + ty * ty), v = speedFor(L), p;
    for (var it = 0; it < 4; it++) {
      p = freePath(v, turn);
      var l = Math.sqrt(p.x * p.x + p.y * p.y) || 1;
      v *= Math.sqrt(L / l);
    }
    v = Math.round(v * 1e4) / 1e4;
    p = freePath(v, turn);
    return { th: Math.atan2(tx, ty) - Math.atan2(p.x, p.y), v: v, turn: turn < 0 ? -1 : 1 };
  }
  // Hit a point (tx, ty) at release speed v: rotate the free path so it runs through it.
  function solveHit(tx, ty, v, turn) {
    var p = freePath(v, turn), P = p.pts, L = Math.sqrt(tx * tx + ty * ty), bx = 0, by = L;
    for (var i = 2; i < P.length; i += 2) {
      var l = Math.sqrt(P[i] * P[i] + P[i + 1] * P[i + 1]);
      if (l >= L) {
        var l0 = Math.sqrt(P[i - 2] * P[i - 2] + P[i - 1] * P[i - 1]), u = l > l0 ? (L - l0) / (l - l0) : 0;
        bx = P[i - 2] + (P[i] - P[i - 2]) * u; by = P[i - 1] + (P[i + 1] - P[i - 1]) * u;
        break;
      }
    }
    return { th: Math.atan2(tx, ty) - Math.atan2(bx, by), v: v, turn: turn < 0 ? -1 : 1 };
  }
  // The free path of a shot, in sheet coordinates (for the aim guide).
  function shotPath(shot) {
    var p = freePath(Math.round(shot.v * 1e4) / 1e4, shot.turn), out = [];
    for (var i = 0; i < p.pts.length; i += 2) { var q = rot(p.pts[i], p.pts[i + 1], shot.th); out.push(q.x, q.y); }
    return out;
  }

  // ---- the CPU skip ----
  // How good a position is for `team`, with `left` stones still to come this end.
  function evaluate(stones, team, m, left) {
    var sc = scoreEnd(stones), sgn = sc.team === team ? 1 : -1, hasHammer = m.hammer === team;
    if (left <= 0) {
      var v0 = sc.pts * sgn * 10;
      if (sc.pts === 0) v0 = hasHammer ? 2 : -2;                       // a blank keeps the hammer
      else if (sc.team === team && hasHammer && sc.pts === 1) v0 -= 3;  // one with the hammer is a little weak
      return v0;
    }
    // early in an end, stones in the house are easy targets and guards are worth more
    var phase = left / (2 * m.spe), val = sc.pts * sgn * (left <= 2 ? 3.2 : 1.6 * (1 - 0.6 * phase));
    var h = stones.filter(inHouse).map(function (s) { return { s: s, d: distB(s.x, s.y) }; }).sort(function (a, b) { return a.d - b.d; });
    for (var i = 0; i < h.length && i < 5; i++) val += (h[i].s.team === team ? 1 : -1) * 0.7 * Math.pow(0.6, i) * (1.15 - h[i].d / (R12 + R) * 0.5) * (1 - 0.5 * phase);
    stones.forEach(function (s) {
      if (!inFGZ(s) || s.y < TEE - 7.5 || Math.abs(s.x) > 1.6) return;
      var own = s.team === team, centre = Math.abs(s.x) < 0.55;
      var w = own ? (hasHammer ? (centre ? 0.25 : 0.7) : (centre ? 0.9 : 0.4)) : -0.35;
      // a guard in front of the shot stone is worth more
      if (h.length && Math.abs(s.x - h[0].s.x) < 0.45) w *= h[0].s.team === s.team ? 1.8 : 0.8;
      val += w * (0.3 + phase);
    });
    var own = 0, opp = 0;
    stones.forEach(function (s) { if (s.y > TEE - 7.5) { if (s.team === team) own++; else opp++; } });
    val += (own - opp) * 0.12;
    // the opponent throws next: an open shot stone of theirs is about to cost us, ours is about to be hit
    if (h.length && left >= 1) {
      var top = h[0].s, guarded = stones.some(function (s) { return s !== top && s.y < top.y - 0.3 && s.y > top.y - 6 && Math.abs(s.x - top.x) < 0.32; });
      if (!guarded) val += top.team === team ? -0.35 : -0.15;
    }
    return val;
  }
  function candidates(m, team, L) {
    var C = [], opp = 1 - team, st = m.stones;
    function draw(x, y, kind, label) { C.push({ kind: kind, tx: x, ty: y, label: label, turn: 1 }, { kind: kind, tx: x, ty: y, label: label, turn: -1 }); }
    draw(0, TEE, 'draw', 'Draw to the button');
    draw(0, TEE - 0.7, 'draw', 'Draw to the top of the four');
    draw(0.75, TEE - 0.2, 'draw', 'Draw to the eight');
    draw(-0.75, TEE - 0.2, 'draw', 'Draw to the eight');
    draw(0, TEE + 0.6, 'draw', 'Draw to the back four');
    if (L.full) { draw(1.25, TEE + 0.2, 'draw', 'Draw to the twelve'); draw(-1.25, TEE + 0.2, 'draw', 'Draw to the twelve'); }
    C.push({ kind: 'guard', tx: 0, ty: TEE - 3.6, label: 'Centre guard', turn: 1 }, { kind: 'guard', tx: 0, ty: TEE - 3.6, label: 'Centre guard', turn: -1 });
    C.push({ kind: 'guard', tx: 1.0, ty: TEE - 3.0, label: 'Corner guard', turn: -1 }, { kind: 'guard', tx: -1.0, ty: TEE - 3.0, label: 'Corner guard', turn: 1 });
    st.forEach(function (s) {
      if (s.y < HOG) return;
      var front = s.y < TEE - R12;
      if (s.team === opp) {
        [1, -1].forEach(function (t) {
          C.push({ kind: 'hit', tx: s.x, ty: s.y, off: 0, v: 3.15, turn: t, label: front ? 'Peel the guard' : 'Takeout', target: s.id });
          if (L.full) {
            C.push({ kind: 'hit', tx: s.x, ty: s.y, off: 0.09 * t, v: 2.9, turn: t, label: 'Hit and roll', target: s.id });
            if (!front) C.push({ kind: 'hit', tx: s.x, ty: s.y, off: 0, v: speedFor(s.y + 1.2), turn: t, label: 'Tap back', target: s.id });
          }
        });
        if (!front) draw(s.x, s.y - 2 * R - 0.03, 'draw', 'Freeze');
      } else if (front) {
        // come around our guard, or raise it into the house
        var behind = Math.min(TEE + 0.3, s.y + 2.4);
        draw(s.x * 0.5, behind, 'draw', 'Come around the guard');
        if (L.full && s.y < TEE - R12) [1, -1].forEach(function (t) { C.push({ kind: 'hit', tx: s.x, ty: s.y, off: 0, v: speedFor(s.y + 2.6), turn: t, label: 'Raise', target: s.id }); });
      }
    });
    return C;
  }
  function solveCand(c) {
    if (c.kind === 'hit') {
      // aim so the edges meet: offset the aim point across the line of travel
      var a = Math.atan2(c.tx, c.ty), ox = c.off * Math.cos(a), oy = -c.off * Math.sin(a);
      return solveHit(c.tx + ox, c.ty + oy, Math.round(c.v * 1e4) / 1e4, c.turn);
    }
    return solveDraw(c.tx, c.ty, c.turn);
  }
  // Sweep the delivered stone to the line it was aimed for: look ahead (stone
  // alone, no sweeping) and sweep while it would stop short of the target.
  function cpuSweep(f, plan, tol) {
    if (!plan || plan.kind === 'hit' && plan.label !== 'Raise' && plan.label !== 'Tap back') return 0;
    var d = f.d;
    if (d.out || !moving(d) || f.hit) return 0;
    if (f.steps % 6 !== 0 && f.lastSw != null) return f.lastSw;
    // where it would stop unswept: the rest of its path (v²/2μg) along its heading, a
    // little short for the curl still to come
    var v = Math.sqrt(d.vx * d.vx + d.vy * d.vy), Lr = reach(v), stopY = d.y + d.vy / v * Lr * (1 - 0.012 * Math.min(1, Lr / 10));
    var ty = plan.kind === 'hit' ? plan.ty + 1 : plan.ty;
    f.lastSw = stopY < ty - (tol == null ? 0.15 : tol) ? 1 : 0;
    return f.lastSw;
  }
  function trial(m, team, shot, plan, tol) {
    var f = newShot(m.stones, team, shot, m.nextId);
    runShot(f, plan ? function (ff) { return cpuSweep(ff, plan, tol); } : null);
    return f;
  }
  // Pick the shot. Returns { shot, plan } with the execution noise already in the shot.
  // The work is a job that can be spread over several frames (cpuJob + cpuWork),
  // so a crowded house never stalls the UI; cpuPlan runs it to the end at once.
  // Same seed, same result, however the work is sliced.
  function cpuJob(m, level, seed) {
    var L = LEVELS[clamp(level | 0, 0, 2)], team = toThrow(m);
    return { m: m, L: L, team: team, r: rng(hash2(seed >>> 0, m.n + 101)), left: 2 * m.spe - m.thrown - 1,
      C: candidates(m, team, L), i: 0, scored: [], stage: 0, top: null, ti: 0, tk: 0, res: null };
  }
  function cpuUnit(J) {
    var m = J.m, L = J.L, team = J.team, left = J.left, r = J.r;
    if (J.stage === 0) {                                     // simulate one candidate
      if (J.i < J.C.length) {
        var c = J.C[J.i++], shot = solveCand(c);
        if (!(shot.v >= V_MIN - 0.4 && shot.v <= V_MAX + 0.4) || !isFinite(shot.th) || Math.abs(shot.th) > 0.09) return;
        var f = trial(m, team, shot, c, L.tol), res = resolve(m, f), v = evaluate(res.stones, team, m, left);
        if (res.why) v -= 1.5;
        J.scored.push({ c: c, shot: shot, v: v });
        return;
      }
      J.scored.sort(function (a, b) { return b.v - a.v; });
      if (!J.scored.length) { var dflt = solveDraw(0, TEE, 1); J.scored.push({ c: { kind: 'draw', tx: 0, ty: TEE, label: 'Draw to the button', turn: 1 }, shot: dflt, v: 0 }); }
      J.stage = L.robust ? 1 : 2;
      if (L.robust) { J.top = J.scored.slice(0, 5); J.top.forEach(function (q) { q.sum = q.v; }); }
      return;
    }
    if (J.stage === 1) {                                     // the best few, thrown with this skip's own wobble
      if (J.ti < J.top.length) {
        var q = J.top[J.ti];
        var sh = { th: q.shot.th + gauss(r) * L.sa, v: q.shot.v * (1 + gauss(r) * L.sv), turn: q.shot.turn };
        q.sum += evaluate(resolve(m, trial(m, team, sh, q.c, L.tol)).stones, team, m, left);
        if (++J.tk >= L.robust) { q.rv = q.sum / (L.robust + 1); J.tk = 0; J.ti++; }
        return;
      }
      J.top.sort(function (a, b) { return b.rv - a.rv; });
      J.scored = J.top.concat(J.scored.slice(5));
      J.stage = 2;
      return;
    }
    if (J.stage === 2) {
      var scored = J.scored, pick = scored[0];
      if (L.top > 1) {
        var pool = scored.slice(0, L.top).filter(function (s) { return s.v > scored[0].v - 2.5; });
        pick = pool[Math.floor(r() * pool.length)] || scored[0];
      }
      var fin = { th: pick.shot.th + gauss(r) * L.sa, v: clamp(pick.shot.v * (1 + gauss(r) * L.sv), 0.5, 5.5), turn: pick.shot.turn };
      J.res = { shot: fin, plan: { kind: pick.c.kind, tx: pick.c.tx, ty: pick.c.ty, label: pick.c.label, tol: L.tol }, ideal: pick.shot, value: pick.v, n: scored.length };
      J.stage = 3;
    }
  }
  // Do up to `ms` milliseconds of the job (Infinity: all of it). Returns the plan when done, else null.
  function cpuWork(J, ms) {
    var t0 = Date.now(), k = 0;
    while (J.stage < 3) {
      cpuUnit(J);
      if (++k % 2 === 0 && Date.now() - t0 >= ms) break;
    }
    return J.stage === 3 ? J.res : null;
  }
  function cpuPlan(m, level, seed) { return cpuWork(cpuJob(m, level, seed), Infinity); }

  // ---- records ----
  function newSave() {
    return { v: 1, opts: { mode: 'cpu', level: 1, ends: 6, spe: 6, fgz: true, guide: 'line' },
      rec: { games: 0, wins: [0, 0, 0], losses: [0, 0, 0], draws: 0, twoP: 0, bigEnd: 0, buttons: 0, takeouts: 0, pts: 0, steals: 0 } };
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    var op = o.opts || {};
    s.opts.mode = op.mode === '2p' ? '2p' : 'cpu';
    s.opts.level = clamp(op.level | 0, 0, 2);
    if (SPEC.ends.indexOf(op.ends | 0) >= 0) s.opts.ends = op.ends | 0;
    if (SPEC.spe.indexOf(op.spe | 0) >= 0) s.opts.spe = op.spe | 0;
    s.opts.fgz = op.fgz !== false;
    s.opts.guide = ['off', 'line', 'path'].indexOf(op.guide) >= 0 ? op.guide : 'line';
    var r = o.rec || {};
    ['games', 'draws', 'twoP', 'bigEnd', 'buttons', 'takeouts', 'pts', 'steals'].forEach(function (k) { s.rec[k] = Math.max(0, +r[k] | 0); });
    ['wins', 'losses'].forEach(function (k) { if (Array.isArray(r[k])) for (var i = 0; i < 3; i++) s.rec[k][i] = Math.max(0, +r[k][i] | 0); });
    return s;
  }
  // Fold a finished match into the records (vs CPU: team 0 is the human).
  function settle(save, m) {
    var r = save.rec, out = { win: false, best: false };
    r.games++;
    if (m.mode === '2p') r.twoP++;
    else if (m.winner === 0) { r.wins[m.level]++; out.win = true; }
    else if (m.winner === 1) r.losses[m.level]++;
    else r.draws++;
    return out;
  }

  var ENGINE = {
    STEP: STEP, MU: MU, G: G, R: R, HW: HW, HOG: HOG, TEE: TEE, BACK: BACK, R12: R12, R8: R8, R4: R4, RB: RB,
    V_MIN: V_MIN, V_MAX: V_MAX, W0: W0, TIME_SCALE: TIME_SCALE, LEVELS: LEVELS, SPEC: SPEC,
    rng: rng, hash2: hash2, clamp: clamp, distB: distB, inHouse: inHouse, inFGZ: inFGZ, isOut: isOut,
    reach: reach, speedFor: speedFor, angleFor: angleFor, broomFor: broomFor, weightName: weightName,
    mkStone: mkStone, newShot: newShot, stepShot: stepShot, advance: advance, runShot: runShot, resolve: resolve, fgzRocks: fgzRocks,
    scoreEnd: scoreEnd, newMatch: newMatch, toThrow: toThrow, stonesLeft: stonesLeft, deliver: deliver, finishShot: finishShot, normMatch: normMatch,
    freePath: freePath, solveDraw: solveDraw, solveHit: solveHit, shotPath: shotPath, rot: rot,
    evaluate: evaluate, candidates: candidates, cpuSweep: cpuSweep, cpuPlan: cpuPlan, cpuJob: cpuJob, cpuWork: cpuWork, trial: trial,
    newSave: newSave, normSave: normSave, settle: settle
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('curling.css');

  var PANEL_ID = 'curling-panel', NAME = 'Curling';
  var KEY = 'cade-curling-', SAVE_KEY = KEY + 'save', MATCH_KEY = KEY + 'match', SOUND_KEY = KEY + 'sound';
  var VW = 336, CW = 8, RH = 12, MARG = 10, PPM0 = (VW - 2 * MARG) / (2 * HW), PPM = PPM0, VIEW_M = 7.4;   // metres the house view must show (back line to the guards)
  var HOUSE_TOP = BACK + 0.6;            // the world y at the top edge in the house view
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.curling = { live: function () { return S; } };   // test-only peek

  // palette slots, filled from the theme
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_RED = 4, C_GOLD = 5, C_ICE = 6, C_PEB = 7, C_LINE = 8, C_HOG = 9, C_GREEN = 10, NPAL = 11;
  var TEAM_SLOT = [C_RED, C_GOLD];

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { if (Cade.store.remove) Cade.store.remove(k); else Cade.store.set(k, ''); } catch (e) {} }
  function sjson(k) { var raw = sget(k); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function persistSave() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function persistMatch() {
    if (!S) return;
    if (S.m && !S.m.over) sset(MATCH_KEY, JSON.stringify(S.m)); else sdel(MATCH_KEY);
  }

  // ---- sound: a tiny WebAudio voice, made on a user gesture ----
  function Snd(on) { this.on = !!on; this.ac = null; this.noise = null; this.rum = null; }
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
  // a filtered noise burst: granite on granite, or a broom on the ice
  Snd.prototype.burst = function (vol, freq, dur, type) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      if (!this.noise) {
        var n = Math.floor(ac.sampleRate * 0.3), buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
        for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        this.noise = buf;
      }
      var t = ac.currentTime, src = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = this.noise; bp.type = type || 'bandpass'; bp.frequency.value = freq || 2400; bp.Q.value = 1.2;
      g.gain.setValueAtTime(Math.min(0.25, vol), t); g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.12));
      src.connect(bp); bp.connect(g); g.connect(ac.destination);
      src.start(t, Math.random() * 0.15); src.stop(t + (dur || 0.12) + 0.02);
    } catch (e) {}
  };
  // the stone's low rumble over the pebble (a held tone; gain follows the speed)
  Snd.prototype.rumble = function (level) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') { this.stopRumble(); return; }
    try {
      if (!this.rum) {
        var o = ac.createOscillator(), g = ac.createGain(), lp = ac.createBiquadFilter();
        o.type = 'triangle'; o.frequency.value = 48; lp.type = 'lowpass'; lp.frequency.value = 160;
        g.gain.value = 0.0001; o.connect(lp); lp.connect(g); g.connect(ac.destination); o.start();
        this.rum = { o: o, g: g };
      }
      this.rum.g.gain.setTargetAtTime(Math.max(0.0001, level * 0.06), ac.currentTime, 0.08);
      this.rum.o.frequency.setTargetAtTime(40 + level * 20, ac.currentTime, 0.1);
    } catch (e) {}
  };
  Snd.prototype.stopRumble = function () {
    if (!this.rum) return;
    var r = this.rum; this.rum = null;
    try { r.g.gain.setTargetAtTime(0.0001, this.ac.currentTime, 0.04); r.o.stop(this.ac.currentTime + 0.25); } catch (e) {}
  };
  Snd.prototype.close = function () { this.stopRumble(); if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_MENU = svg('<path d="M4 7h16M4 12h16M4 17h16"/>');

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
    var red = dark ? [240, 106, 106] : [207, 63, 63], gold = dark ? [242, 197, 68] : [176, 125, 6], ice = dark ? [124, 199, 242] : [40, 120, 181];
    var P = S.pal;
    S.dark = dark;
    P[C_TEXT] = css(tx); P[C_MUTED] = css(mu); P[C_FAINT] = css(fa); P[C_ACC] = css(ac);
    P[C_RED] = css(red); P[C_GOLD] = css(gold); P[C_ICE] = css(ice);
    P[C_PEB] = css(mix(bg, tx, dark ? 0.2 : 0.16)); P[C_LINE] = css(mix(bg, tx, dark ? 0.42 : 0.38));
    P[C_HOG] = css(mix(bg, red, 0.75)); P[C_GREEN] = dark ? '#7ed37a' : '#2f8f3a';
    S.col = {
      bg: css(bg), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace',
      boards: css(mix(bg, tx, dark ? 0.1 : 0.07)), r12: css(mix(bg, ice, dark ? 0.3 : 0.22)), r4: css(mix(bg, red, dark ? 0.3 : 0.22)),
      ring: css(mix(bg, tx, dark ? 0.3 : 0.25)), granite: css(mix(bg, tx, dark ? 0.3 : 0.22)), graniteHi: css(mix(bg, tx, dark ? 0.45 : 0.1)),
      edge: css(mix(bg, tx, dark ? 0.6 : 0.55)), shadow: dark ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.16)',
      team: [css(red), css(gold)], teamDim: [css(mix(bg, red, 0.45)), css(mix(bg, gold, 0.45))], hud: css(bg, 0.86), fgz: css(mix(bg, ac, dark ? 0.07 : 0.05))
    };
    fitFont();
  }

  // ---- glyph rendering (a cached atlas, as in Dusk Dash) ----
  var AT_COLS = 24, AT_ROWS = 12;
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '600 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = CW / adv;
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
  function glyph(c, ci, code, x, y, sc) {
    if (code === 32) return;
    var i = gIdx(ci, code), a = S.atl;
    if (i < 0) {
      c.font = S.fnt; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = S.pal[ci];
      c.fillText(String.fromCharCode(code), x, y);
      return;
    }
    var w = sc ? a.cw * sc : a.cw, h = sc ? a.ch * sc : a.ch, dx = Math.round((x - w / 2) * S.k) / S.k, dy = Math.round((y - h / 2) * S.k) / S.k;
    c.drawImage(a.cv, (i % AT_COLS) * a.cwp, ((i / AT_COLS) | 0) * a.chp, a.cwp, a.chp, dx, dy, w, h);
  }
  function drawStr(c, ci, s, x, y, align, sc) {
    var n = s.length, cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, s.charCodeAt(i), x0 + i * cw + cw / 2, y, sc);
    return x0 + n * cw;
  }

  // ---- particles (world space), pools allocated once ----
  var NPART = 72;
  function makeFx() {
    S.parts = [];
    for (var i = 0; i < NPART; i++) S.parts.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, code: 46, ci: 0 });
    S.pi = 0;
  }
  function clearFx() { for (var i = 0; i < NPART; i++) S.parts[i].on = false; }
  function spark(x, y, vx, vy, life, code, ci) {
    var p = S.parts[S.pi]; S.pi = (S.pi + 1) % NPART;
    p.on = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.t = 0; p.life = life; p.code = code; p.ci = ci;
  }
  function burst(x, y, n, sp, codes, ci, life) {
    if (S.rm) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = sp * (0.3 + Math.random() * 0.7);
      spark(x, y, Math.cos(a) * v, Math.sin(a) * v, life * (0.6 + Math.random() * 0.5), codes.charCodeAt(i % codes.length), ci);
    }
  }
  function anyFx() { for (var i = 0; i < NPART; i++) if (S.parts[i].on) return true; return false; }
  function stepFx(dt) {
    for (var i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on) continue;
      p.t += dt;
      if (p.t >= p.life) { p.on = false; continue; }
      var k = Math.exp(-3 * dt);
      p.vx *= k; p.vy *= k; p.x += p.vx * dt; p.y += p.vy * dt;
    }
    if (S.msg && (S.msg.t += dt) > S.msg.dur) S.msg = S.msgQ.length ? S.msgQ.shift() : null;
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt);
  }
  function say(text, ci, dur, queue, sub) {
    var m = { text: text, sub: sub || '', ci: ci == null ? C_TEXT : ci, t: 0, dur: dur || 1.4 };
    if (queue && S.msg && S.msgQ.length < 3) S.msgQ.push(m); else { S.msg = m; S.msgQ.length = 0; }
  }

  // ---- the scene ----
  function SX(x) { return VW / 2 + x * PPM; }
  function SY(y) { return S.VH - (y - S.camB) * PPM; }
  function houseCam() { return HOUSE_TOP - S.VH / PPM; }
  function viewTop() { return S.camB + S.VH / PPM; }

  // Stones as the renderer sees them this frame: [x, y, angle, team, id, moving]
  function sceneStones(alpha) {
    var out = [];
    if (S.f && S.phase === 'run') {
      S.f.st.forEach(function (s) {
        if (s.out && !(s.outT > 0)) return;
        var a = s.out ? 1 : alpha;
        out.push({ x: s.px + (s.x - s.px) * a, y: s.py + (s.y - s.py) * a, a: s.pa + (s.a - s.pa) * a, team: s.team, id: s.id, out: s.out, ot: s.outT || 0 });
      });
    } else {
      var list = S.endStones || (S.m ? S.m.stones : []);
      list.forEach(function (s) { out.push({ x: s.x, y: s.y, a: (s.id * 1.7) % 6.28, team: s.team, id: s.id }); });
    }
    return out;
  }

  function draw(alpha, dt) {
    if (!S || !S.ctx || !S.atl) return;
    var c = S.ctx, VH = S.VH, i;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (S.shake > 0 && !S.rm) c.translate((Math.random() - 0.5) * S.shake * 10, (Math.random() - 0.5) * S.shake * 10);
    c.fillStyle = S.col.bg; c.fillRect(-10, -10, VW + 20, VH + 20);
    // boards outside the side lines
    var xl = SX(-HW), xr = SX(HW);
    c.fillStyle = S.col.boards; c.fillRect(-10, -10, xl + 10, VH + 20); c.fillRect(xr, -10, VW - xr + 10, VH + 20);
    var y0 = S.camB - 0.5, y1 = viewTop() + 0.5;
    // the free guard zone, faintly
    if (S.m && S.m.fgz && HOG < y1 && TEE > y0) { c.fillStyle = S.col.fgz; c.fillRect(xl, SY(TEE), xr - xl, SY(HOG) - SY(TEE)); }
    drawPebble(c, y0, y1);
    drawHouse(c);
    drawLines(c, y0, y1);
    if (S.phase === 'aim' || S.phase === 'cpu') drawAim(c);
    drawTrail(c, alpha);
    var list = sceneStones(alpha);
    for (i = 0; i < list.length; i++) drawStone(c, list[i]);
    if (S.phase !== 'run') drawCounts(c, list);
    if ((S.phase === 'run') && S.f) drawSweepers(c, alpha);
    for (i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on) continue;
      var px = SX(p.x), py = SY(p.y);
      if (py < -RH || py > VH + RH) continue;
      c.globalAlpha = Math.min(1, 2.2 * (1 - p.t / p.life));
      glyph(c, p.ci, p.code, px, py);
    }
    c.globalAlpha = 1;
    if (S.phase === 'aim' || S.phase === 'cpu') drawBroom(c);
    hud(c);
    if (S.msg) banner(c);
  }

  function drawPebble(c, y0, y1) {
    var k0 = Math.floor(y0 * 2), k1 = Math.ceil(y1 * 2);
    for (var k = k0; k < k1; k++) {
      for (var j = 0; j < 7; j++) {
        var h = hash2(k, j), x = ((h & 1023) / 1023 * 2 - 1) * (HW - 0.06), y = k / 2 + ((h >>> 10) & 1023) / 1023 / 2;
        glyph(S.ctx, C_PEB, 46, SX(x), SY(y), (h >>> 20) & 1 ? 1 : 0.75);
      }
    }
  }
  function drawHouse(c) {
    var cx = SX(0), cy = SY(TEE);
    if (cy - R12 * PPM > S.VH + 4 || cy + R12 * PPM < -4) return;
    [[R12, S.col.r12], [R8, S.col.bg], [R4, S.col.r4], [RB, S.col.bg]].forEach(function (r) {
      c.beginPath(); c.arc(cx, cy, r[0] * PPM, 0, Math.PI * 2); c.fillStyle = r[1]; c.fill();
    });
    c.strokeStyle = S.col.ring; c.lineWidth = 1;
    [R12, R8, R4, RB].forEach(function (r) { c.beginPath(); c.arc(cx, cy, r * PPM, 0, Math.PI * 2); c.stroke(); });
    // ring dots in glyphs around the 12-foot
    var n = 44;
    for (var i = 0; i < n; i++) {
      var a = i / n * Math.PI * 2;
      glyph(c, C_ICE, 46, cx + Math.cos(a) * (R12 * PPM + 5), cy + Math.sin(a) * (R12 * PPM + 5), 0.8);
    }
  }
  function hline(c, y, ch, ci, label) {
    var sy = SY(y);
    if (sy < -RH || sy > S.VH + RH) return;
    var xl = SX(-HW), xr = SX(HW), n = Math.floor((xr - xl) / CW);
    for (var i = 0; i < n; i++) glyph(c, ci, ch, xl + (i + 0.5) * (xr - xl) / n, sy);
    if (label) {
      var lw = label.length * CW * 0.7;
      if (xl > lw + 6) drawStr(c, ci, label, xl - 3, sy, 'right', 0.7);       // room in the boards
      else { c.fillStyle = S.col.boards; c.fillRect(xl + 2, sy - RH / 2, lw + 6, RH); drawStr(c, ci, label, xl + 5, sy, 'left', 0.7); }
    }
  }
  function drawLines(c, y0, y1) {
    var cx = SX(0), ya = Math.max(y0, -0.5), yb = Math.min(y1, BACK + 1.2), y;
    // the centre line, as a dotted glyph run
    for (y = Math.ceil(ya / 0.3) * 0.3; y < yb; y += 0.3) glyph(c, C_LINE, 58, cx, SY(y), 0.9);
    hline(c, TEE, 45, C_LINE, 'TEE');
    hline(c, BACK, 61, C_LINE, 'BACK');
    hline(c, HOG, 61, C_HOG, 'HOG');
    hline(c, 0, 61, C_HOG, 'HOG');
    // side lines
    for (y = Math.ceil(y0 / 0.25) * 0.25; y < y1; y += 0.25) { glyph(c, C_LINE, 124, SX(-HW), SY(y)); glyph(c, C_LINE, 124, SX(HW), SY(y)); }
  }

  // The aim: a dotted line from the release to the broom, the weight's straight
  // stop mark, or (guide 'path') the stone's whole free path with its curl.
  function curShot() { return { th: angleFor(S.aim.bx), v: S.aim.v, turn: S.aim.turn }; }
  function drawAim(c) {
    var guide = S.phase === 'cpu' ? 'line' : S.save.opts.guide, th = angleFor(S.aim.bx), sn = Math.sin(th), cs = Math.cos(th), L, y0 = S.camB - 0.5, y1 = viewTop();
    if (guide === 'off') return;
    var stopL = reach(S.aim.v);
    for (L = Math.max(0, (y0 / cs) - ((y0 / cs) % 0.4)); L < Math.min(stopL, y1 / cs + 1); L += 0.4) {
      var x = sn * L, y = cs * L;
      if (y < y0 || y > y1) continue;
      glyph(c, C_FAINT, 46, SX(x), SY(y));
    }
    var team = S.m ? toThrow(S.m) : 0;
    if (guide === 'path' && S.phase === 'aim') {
      var P = shotPath(curShot());
      for (var i = 0; i < P.length; i += 2) {
        if (P[i + 1] < y0 || P[i + 1] > y1) continue;
        glyph(c, TEAM_SLOT[team], i % 4 ? 46 : 111, SX(P[i]), SY(P[i + 1]), i % 4 ? 1 : 0.7);
      }
    }
    // the straight stop mark (where this weight runs out if it didn't curl)
    var sx = SX(sn * stopL), sy = SY(cs * stopL);
    if (sy > -RH && sy < S.VH + RH) { glyph(c, TEAM_SLOT[team], 120, sx, sy, 1.2); }
  }
  function drawBroom(c) {
    var bx = SX(S.aim.bx), by = SY(TEE), t = S.idleT;
    if (by < -RH * 2 || by > S.VH) return;
    var wig = S.phase === 'cpu' ? Math.sin(t * 9) * 1.5 : 0;
    drawStr(c, C_ACC, '[#]', bx + wig, by, 'center', 1.1);
    glyph(c, C_ACC, 47, bx + 9 + wig, by - RH * 0.9);
    glyph(c, C_ACC, 47, bx + 15 + wig, by - RH * 1.8);
  }

  function drawStone(c, s) {
    var x = SX(s.x), y = SY(s.y), r = R * PPM;
    if (y < -r * 2 || y > S.VH + r * 2) return;
    if (s.out) c.globalAlpha = Math.max(0, s.ot / 0.6) * 0.8;
    c.beginPath(); c.arc(x + 1.2, y + 2, r, 0, Math.PI * 2); c.fillStyle = S.col.shadow; c.fill();
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = S.col.granite; c.fill();
    c.lineWidth = 1.3; c.strokeStyle = S.col.edge; c.stroke();
    c.beginPath(); c.arc(x, y, r * 0.62, 0, Math.PI * 2); c.fillStyle = S.col.teamDim[s.team]; c.fill();
    // the handle, turning with the stone
    var ca = Math.cos(s.a), sa = Math.sin(s.a);
    c.lineCap = 'round'; c.lineWidth = Math.max(2.5, r * 0.36); c.strokeStyle = S.col.team[s.team];
    c.beginPath(); c.moveTo(x - ca * r * 0.25, y - sa * r * 0.25); c.lineTo(x + ca * r * 0.78, y + sa * r * 0.78); c.stroke();
    c.lineCap = 'butt';
    c.globalAlpha = 1;
  }
  // Numbers on the stones that count right now (shot stone = 1).
  function drawCounts(c, list) {
    var stones = list.filter(function (s) { return !s.out; });
    var sc = scoreEnd(stones);
    for (var i = 0; i < sc.order.length; i++) {
      for (var j = 0; j < stones.length; j++) if (stones[j].id === sc.order[i]) {
        var s = stones[j], x = SX(s.x) + R * PPM + 5, y = SY(s.y) - R * PPM - 2;
        c.fillStyle = S.col.hud; c.fillRect(x - 5, y - 6, 10, 12);
        glyph(c, TEAM_SLOT[s.team], 49 + i, x, y);
      }
    }
  }
  function drawTrail(c, alpha) {
    var T = S.trail, n = T.length / 2;
    for (var i = 0; i < n; i++) {
      var y = SY(T[i * 2 + 1]);
      if (y < -RH || y > S.VH + RH) continue;
      c.globalAlpha = S.phase === 'run' ? 0.25 + 0.6 * i / n : 0.35;
      glyph(c, TEAM_SLOT[S.trailTeam], 46, SX(T[i * 2]), y);
    }
    c.globalAlpha = 1;
  }
  // Two brooms working ahead of the stone while the team sweeps.
  function drawSweepers(c, alpha) {
    var f = S.f, team = f.team, sw = S.swShow;
    if (sw < 0.05) return;
    f.st.forEach(function (s) {
      if (s.out || s.team !== team || (s.vx === 0 && s.vy === 0)) return;
      var v = Math.hypot(s.vx, s.vy), ux = s.vx / v, uy = s.vy / v;
      var x = s.px + (s.x - s.px) * alpha, y = s.py + (s.y - s.py) * alpha;
      var ph = Math.sin(S.idleT * (10 + sw * 16));
      [-1, 1].forEach(function (side) {
        var ahead = R * 2.4 + (side > 0 ? 0.1 : 0.32), off = ph * side * 0.12;
        var bx = x + ux * ahead + uy * off, by = y + uy * ahead - ux * off;
        c.globalAlpha = 0.45 + 0.55 * sw;
        drawStr(c, C_ICE, side > 0 ? '=#=' : '-#-', SX(bx), SY(by), 'center');
      });
      c.globalAlpha = 1;
    });
  }

  function hud(c) {
    if (!S.m) return;
    var m = S.m, VH = S.VH, team = toThrow(m), y = 9, L = 0.8, cw = CW * L;
    c.fillStyle = S.col.hud; c.fillRect(0, 0, VW, 18);
    if (S.phase === 'aim' || S.phase === 'cpu' || S.phase === 'run' || S.phase === 'settle') {
      var aiming = S.phase === 'aim' || S.phase === 'cpu', who = aiming ? team : S.curTeam, no = aiming ? Math.floor(m.thrown / 2) + 1 : S.curNo;
      var x = drawStr(c, TEAM_SLOT[who], teamName(who), 6, y, 'left', L);
      drawStr(c, C_MUTED, ' STONE ' + no + '/' + m.spe, x, y, 'left', L);
    }
    var sc = scoreEnd(sceneStones(1).filter(function (s) { return !s.out; }));
    if (sc.pts) {
      var tail = teamName(sc.team) + ' ' + sc.pts, xr = drawStr(c, C_MUTED, 'SHOT ', VW - 6 - tail.length * cw - 5 * cw, y, 'left', L);
      drawStr(c, TEAM_SLOT[sc.team], tail, xr, y, 'left', L);
    } else drawStr(c, C_FAINT, 'HOUSE EMPTY', VW - 6, y, 'right', L);
    if (S.phase === 'aim') {
      var bx = S.aim.bx, bs = Math.abs(bx) < 0.005 ? 'BROOM ON CENTRE' : 'BROOM ' + Math.abs(bx).toFixed(2) + 'm ' + (bx < 0 ? 'LEFT' : 'RIGHT');
      c.fillStyle = S.col.hud; c.fillRect(0, VH - 17, VW, 17);
      drawStr(c, C_MUTED, bs, 6, VH - 8.5, 'left', L);
      drawStr(c, TEAM_SLOT[team], S.aim.turn > 0 ? 'IN-TURN, CURLS >' : '< CURLS, OUT-TURN', VW - 6, VH - 8.5, 'right', L);
    } else if (S.phase === 'run' && S.f) {
      var d = S.f.d, v = Math.hypot(d.vx, d.vy);
      c.fillStyle = S.col.hud; c.fillRect(0, VH - 17, VW, 17);
      var x2 = drawStr(c, C_MUTED, 'SWEEP ', 6, VH - 8.5, 'left', L), cells = 10, on = Math.round(S.swShow * cells);
      for (var i = 0; i < cells; i++) glyph(c, i < on ? C_ICE : C_FAINT, i < on ? 35 : 45, x2 + i * cw + cw / 2, VH - 8.5, L);
      drawStr(c, C_MUTED, (S.ff ? '>> ' : '') + v.toFixed(2) + ' m/s', VW - 6, VH - 8.5, 'right', L);
      if (S.plan && S.cpuTeam === S.f.team) drawStr(c, C_MUTED, 'CPU: ' + S.plan.label.toUpperCase(), VW / 2, 28, 'center', L);
    }
  }
  function banner(c) {
    // over the ice the stone has just left while it runs; below the house otherwise
    var m = S.msg, k = m.t < 0.15 ? m.t / 0.15 : m.t > m.dur - 0.25 ? Math.max(0, (m.dur - m.t) / 0.25) : 1, y = S.VH * (S.phase === 'run' ? 0.32 : 0.76);
    var w = Math.max(m.text.length, m.sub.length * 0.8) * CW + 24, h = m.sub ? RH * 3.2 : RH * 2;
    c.globalAlpha = k;
    c.fillStyle = S.col.hud; c.fillRect(VW / 2 - w / 2, y - RH, w, h);
    c.strokeStyle = S.pal[m.ci]; c.lineWidth = 1; c.strokeRect(VW / 2 - w / 2 + 0.5, y - RH + 0.5, w - 1, h - 1);
    drawStr(c, m.ci, m.text, VW / 2, y, 'center');
    if (m.sub) drawStr(c, C_MUTED, m.sub, VW / 2, y + RH * 1.2, 'center', 0.8);
    c.globalAlpha = 1;
  }

  // ---- names ----
  function isCpu(team) { return !!S.m && S.m.mode === 'cpu' && team === 1; }
  function teamName(t) { return S.m && S.m.mode === 'cpu' ? (t === 0 ? 'YOU' : 'CPU') : (t === 0 ? 'RED' : 'YELLOW'); }
  function hammerLine(t) {
    if (S.m && S.m.mode === 'cpu') return t === 0 ? 'You have the hammer' : 'The CPU has the hammer';
    return (t === 0 ? 'Red' : 'Yellow') + ' has the hammer';
  }
  function teamWord(t) { return S.m && S.m.mode === 'cpu' ? (t === 0 ? 'You' : 'The CPU') : (t === 0 ? 'Red' : 'Yellow'); }

  // ---- the loop: runs while something moves (a delivery, the camera, the CPU's skip, particles) ----
  function camTarget(alpha) {
    var hc = houseCam();
    if (S.phase === 'run' && S.f && !S.f.hit) {
      var d = S.f.d, y = d.py + (d.y - d.py) * alpha;
      return Math.min(hc, y - 0.3 * S.VH / PPM);
    }
    return hc;
  }
  function busy() {
    if (!S || S.paused || document.hidden || (Cade.isMinimized && Cade.isMinimized(S.panel))) return false;
    return S.phase === 'run' || S.phase === 'cpu' || S.phase === 'settle' || Math.abs(S.camB - camTarget(1)) > 0.002 || !!S.msg || anyFx();
  }
  function kick() { if (S && !S.raf && busy()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!busy()) { draw(1, 0); return; }
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    S.idleT += dt;
    pollPad(dt);
    if (!S || S.paused) return;
    var alpha = 1;
    if (S.phase === 'run' && S.f) {
      var f = S.f, human = !isCpu(f.team);
      S.swImp = Math.max(0, S.swImp - dt * 1.3);
      var sw = human ? Math.max(sweepHeld() ? 0.55 : 0, S.swImp) : 0;
      var plan = S.plan, tol = plan ? plan.tol : 0.2;
      alpha = advance(f, dt * TIME_SCALE * (S.ff ? 4 : 1), human ? sw : function (ff) { return cpuSweep(ff, plan, tol); });
      if (!human) sw = f.lastSw ? 0.85 + 0.15 * Math.sin(S.idleT * 20) : 0;
      S.swShow += (sw - S.swShow) * Math.min(1, dt * 12);
      runEvents(f, dt);
      if (f.done) { afterRest(); if (!S) return; }
    } else if (S.phase === 'cpu') cpuTick(dt);
    else if (S.phase === 'settle') {
      S.settleT += dt;
      if (S.settleT > 1.5 && Math.abs(S.camB - camTarget(1)) < 0.05) settleDone();
    }
    // the camera eases after its target (cut on the throw, then follows)
    var tg = camTarget(alpha), kc = S.phase === 'run' ? 6 : 3.2;
    S.camB += (tg - S.camB) * (1 - Math.exp(-kc * dt));
    if (Math.abs(S.camB - tg) < 0.002) S.camB = tg;
    stepFx(dt);
    draw(alpha, dt);
    if (S && !S.raf && busy()) S.raf = requestAnimationFrame(frame);
    else if (S && S.snd) S.snd.stopRumble();
  }
  function runEvents(f, dt) {
    var i, ev = f.events, snd = S.snd, d = f.d;
    for (i = 0; i < f.hits.length; i++) {
      var h = f.hits[i];
      snd.burst(0.05 + Math.min(0.2, h.v * 0.06), 1500 + h.v * 300, 0.1);
      snd.tone(900 + h.v * 200, 0.05, 'triangle', 0.02 + Math.min(0.04, h.v * 0.01));
      burst(h.x, h.y, 4 + Math.round(h.v * 4), 0.4 + h.v * 0.4, "*+'.", C_TEXT, 0.5);
      if (h.v > 1.2) { S.shake = Math.min(0.25, h.v * 0.06); Cade.haptic && Cade.haptic(10); }
    }
    f.hits.length = 0;
    for (i = 0; i < ev.length; i++) if (ev[i] === 'out') snd.tone(110, 0.2, 'sine', 0.05, 70);
    ev.length = 0;
    f.st.forEach(function (s) {
      if (s.out && s.outT == null) { s.outT = 0.6; burst(s.x, s.y, 6, 0.6, '~.', C_FAINT, 0.6); }
      else if (s.outT > 0) s.outT -= dt;
    });
    // the trail: where the delivered stone has been
    var T = S.trail, n = T.length;
    if (!d.out && (n === 0 || Math.hypot(d.x - T[n - 2], d.y - T[n - 1]) > 0.35)) T.push(d.x, d.y);
    // frost off the brooms
    if (S.swShow > 0.3 && !S.rm && !d.out && (d.vx || d.vy) && Math.random() < S.swShow * 0.6) {
      var v = Math.hypot(d.vx, d.vy) || 1;
      spark(d.x + d.vx / v * R * 2.6 + (Math.random() - 0.5) * 0.3, d.y + d.vy / v * R * 2.6, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.4, 0.4, Math.random() < 0.5 ? 46 : 44, C_ICE);
    }
    var fast = 0;
    f.st.forEach(function (s) { if (!s.out) fast = Math.max(fast, Math.hypot(s.vx, s.vy)); });
    snd.rumble(Math.min(1, fast / 3));
  }

  // ---- the match flow ----
  function defAim() { return { bx: -0.6, v: speedFor(TEE - 0.4), turn: 1 }; }
  function newMatchFromOpts() {
    var o = S.save.opts;
    S.m = newMatch({ seed: (Math.random() * 4294967295) >>> 0, mode: o.mode, level: o.level, ends: o.ends, spe: o.spe, fgz: o.fgz });
    S.aimMem = [defAim(), defAim()];
    S.trail = [];
    persistMatch();
    S.settled = false;
    beginTurn(true);
  }
  function resumeMatch() {
    var m = normMatch(sjson(MATCH_KEY));
    if (!m || m.over) { newMatchFromOpts(); return; }
    S.m = m; S.aimMem = [defAim(), defAim()]; S.trail = []; S.settled = false;
    beginTurn(true);
  }
  function beginTurn(fresh) {
    var m = S.m;
    S.endStones = null; S.endInfo = null; S.f = null; S.plan = null; S.paused = false;
    if (m.over) { showOver(); return; }
    var team = toThrow(m);
    S.aim = JSON.parse(JSON.stringify(S.aimMem[team]));
    showCard(null);
    if (m.thrown === 0) {
      say('END ' + m.end + (m.end > m.ends ? ' (EXTRA)' : ''), C_ACC, 1.6, false, hammerLine(m.hammer).toUpperCase());
    } else if (m.mode === '2p') say(teamName(team) + ' TO THROW', TEAM_SLOT[team], 1.1);
    if (isCpu(team)) {
      S.phase = 'cpu'; S.cpuT = 0; S.cpuStage = 0; S.cpuTeam = team; S.cpuJob = null;
      setPad('cpu');
    } else {
      S.phase = 'aim';
      setPad('aim');
    }
    if (fresh) S.camB = houseCam();
    syncSb(); syncHead(); syncLabel();
    draw(1, 0);
    kick();
  }
  // The CPU's turn: read the house (a beat), walk the broom to its call, then throw.
  function cpuTick(dt) {
    S.cpuT += dt;
    if (S.cpuStage === 0) {
      // think in slices of a few ms a frame (a crowded house takes a while), at least a beat
      if (!S.cpuJob) S.cpuJob = cpuJob(S.m, S.m.level, hash2(S.m.seed, 991));
      var r = cpuWork(S.cpuJob, 8);
      if (!r || S.cpuT <= 0.35) return;
      S.cpuJob = null; S.cpuStage = 1;
      S.plan = r.plan; S.cpuShot = r.shot; S.cpuFrom = { bx: S.aim.bx, v: S.aim.v };
      S.aim.turn = r.shot.turn; S.cpuT = 0;
      if (S.liveEl) S.liveEl.textContent = 'The CPU calls: ' + r.plan.label;
      setPad('cpu');
    } else if (S.cpuStage === 1) {
      var u = Math.min(1, S.cpuT / 1.0), e = u * u * (3 - 2 * u);
      S.aim.bx = S.cpuFrom.bx + (broomFor(S.cpuShot.th) - S.cpuFrom.bx) * e;
      S.aim.v = S.cpuFrom.v + (S.cpuShot.v - S.cpuFrom.v) * e;
      if (u >= 1 && S.cpuT > 1.45) { S.cpuStage = 2; throwStone(S.cpuShot); }
    }
  }
  function throwStone(shot) {
    var m = S.m;
    if (!m || (S.phase !== 'aim' && S.phase !== 'cpu')) return;
    S.snd.ensure();
    var team = toThrow(m);
    if (!isCpu(team)) S.aimMem[team] = { bx: S.aim.bx, v: S.aim.v, turn: S.aim.turn };
    S.f = deliver(m, shot || curShot());
    S.curTeam = team; S.curNo = Math.floor(m.thrown / 2) + 1;
    S.trail = [0, 0]; S.trailTeam = team;
    S.phase = 'run'; S.ff = false; S.swImp = 0; S.swShow = 0; S.keys = {}; S.ptrs = {};
    S.camB = camTarget(0);                                   // a cut to the delivery
    setPad(isCpu(team) ? 'cpurun' : 'run'); syncHead();
    S.snd.tone(220, 0.25, 'sine', 0.04, 160);
    kick();
  }
  function afterRest() {
    var m = S.m, f = S.f, info = finishShot(m, f), res = info.res, d = f.d, team = f.team, human = !isCpu(team), rec = S.save.rec;
    S.snd.stopRumble();
    var dist = distB(d.x, d.y), msg = '', ci = TEAM_SLOT[team], sub = '';
    if (res.why === 'hog') { msg = 'HOG LINE'; sub = 'short of the far hog line: removed'; ci = C_MUTED; }
    else if (res.why === 'fgz') { msg = 'FREE GUARD ZONE'; sub = 'a protected guard came out: stones reset'; ci = C_MUTED; }
    else if (res.outOpp >= 2) { msg = res.outOpp === 2 ? 'DOUBLE TAKEOUT!' : 'TRIPLE TAKEOUT!'; S.shake = 0.2; }
    else if (res.outOpp === 1) msg = res.kept && inHouse(d) ? 'HIT AND STAY' : 'TAKEOUT';
    else if (res.kept && dist < RB + R) msg = 'ON THE BUTTON!';
    else if (res.kept && inHouse(d)) msg = dist < R4 + R ? 'IN THE FOUR-FOOT' : 'IN THE HOUSE';
    else if (res.kept && inFGZ(d)) msg = 'GUARD';
    else if (!res.kept && !f.hit) { msg = d.oy > BACK || d.y > BACK ? 'THROUGH THE HOUSE' : 'WIDE'; ci = C_MUTED; }
    else if (res.outOwn > 0 && !res.outOpp) { msg = 'OUCH'; sub = 'that one cost you a stone'; ci = C_MUTED; }
    if (msg) say(msg, ci, 1.5, false, sub);
    if (human && (S.m.mode === '2p' || team === 0)) {
      if (res.kept && dist < 0.3) rec.buttons++;
      if (!res.why) rec.takeouts += res.outOpp;
    }
    if (msg === 'ON THE BUTTON!' || /TAKEOUT/.test(msg)) {
      [659, 880, 1175].forEach(function (fq, j) { S.snd.tone(fq, 0.1, 'triangle', 0.03, 0, j * 0.07); });
      if (res.kept) burst(d.x, d.y, 10, 1.2, "*+'", TEAM_SLOT[team], 0.8);
    } else if (res.why) S.snd.tone(196, 0.3, 'square', 0.025, 130);
    S.lastInfo = info;
    if (info.endDone) {
      S.endStones = info.end.stones; S.endInfo = info.end;
      var e = info.end;
      if (e.pts > 0) {
        if (S.m.mode === '2p' || e.team === 0) {
          rec.bigEnd = Math.max(rec.bigEnd, e.pts);
          if (S.m.mode === 'cpu') { rec.pts += e.pts; if (e.hammer !== 0) rec.steals++; }
        }
      }
    }
    // the last stone of the match: fold it into the records now, so closing the
    // panel before the final card still counts it (the saved match is dropped)
    if (info.over && !S.settled) { S.settled = true; S.over = settle(S.save, m); }
    persistSave(); persistMatch();
    S.f = null;
    S.phase = 'settle'; S.settleT = 0;
    setPad('wait'); syncSb(); syncHead();
    if (S.liveEl) S.liveEl.textContent = (msg ? msg.toLowerCase() + '. ' : '') + (info.endDone ? endLine(info.end) : '');
  }
  function settleDone() {
    if (!S || S.phase !== 'settle') return;
    if (S.lastInfo && S.lastInfo.endDone) showEnd();
    else beginTurn(false);
  }
  function endLine(e) {
    if (e.pts === 0) return 'Blank end. ' + hammerLine(e.hammer) + '.';
    return teamWord(e.team) + ' score' + (S.m.mode === 'cpu' && e.team === 1 ? 's ' : ' ') + e.pts + (e.team !== e.hammer ? ' (a steal!)' : '') + '.';
  }
  function showEnd() {
    var e = S.endInfo;
    S.phase = 'end'; S.msg = null; S.msgQ.length = 0;
    showCard('end');
    setPad(S.m.over ? 'final' : 'next');
    syncSb(); syncHead();
    if (e.pts > 0) {
      var good = S.m.mode === '2p' || e.team === 0;
      (good ? [523, 659, 784, 1047] : [392, 330, 262]).forEach(function (fq, j) { S.snd.tone(fq, 0.13, 'triangle', 0.035, 0, j * 0.09); });
    }
    draw(1, 0);
  }
  function nextEnd() {
    if (!S || !S.m) return;
    if (S.m.over) { showOver(); return; }
    S.trail = [];
    beginTurn(false);
  }
  function showOver() {
    var m = S.m;
    if (!S.settled) { S.settled = true; S.over = settle(S.save, m); persistSave(); }
    sdel(MATCH_KEY);
    S.phase = 'over'; S.msg = null; S.msgQ.length = 0;
    showCard('over'); setPad('over'); syncSb(); syncHead();
    var good = m.mode === '2p' ? m.winner >= 0 : m.winner === 0;
    if (good) [523, 659, 784, 1047, 1319].forEach(function (fq, j) { S.snd.tone(fq, 0.14, 'triangle', 0.04, 0, j * 0.1); });
    else S.snd.tone(262, 0.5, 'sine', 0.04, 196);
    if (S.liveEl) S.liveEl.textContent = overTitle() + ' ' + m.score[0] + ' to ' + m.score[1] + '.';
    draw(1, 0);
  }
  function overTitle() {
    var m = S.m;
    if (m.winner < 0) return 'A DRAW';
    if (m.mode === 'cpu') return m.winner === 0 ? 'YOU WIN' : 'CPU WINS';
    return (m.winner === 0 ? 'RED' : 'YELLOW') + ' WINS';
  }
  function toHome() {
    stopLoop();
    if (S.snd) S.snd.stopRumble();
    S.phase = 'home'; S.paused = false; S.f = null; S.endStones = null; S.msg = null; S.msgQ.length = 0; S.settled = false;
    if (S.m && S.m.over) S.m = null;
    if (!S.m) { var sv = normMatch(sjson(MATCH_KEY)); S.m = sv && !sv.over ? sv : null; }
    S.camB = houseCam();
    clearFx();
    showCard('home'); setPad('home'); syncSb(); syncHead(); syncLabel();
    draw(1, 0);
  }
  function pause() {
    if (!S || S.paused || (S.phase !== 'run' && S.phase !== 'cpu' && S.phase !== 'settle')) return;
    S.paused = true; S.keys = {}; S.ptrs = {};
    stopLoop(); S.snd.stopRumble();
    showCard('pause'); setPad('resume'); syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null); setPad(S.phase === 'run' ? (isCpu(S.f.team) ? 'cpurun' : 'run') : S.phase === 'cpu' ? 'cpu' : 'wait'); syncHead();
    kick();
  }

  // ---- cards ----
  function opt(key, val, label, cur) {
    var on = cur === val;
    return '<button type="button" class="cu-chip' + (on ? ' on' : '') + '" data-opt="' + key + '" data-val="' + val + '" aria-pressed="' + on + '">' + esc(label) + '</button>';
  }
  function optRow(title, key, list, cur) {
    return '<div class="cu-orow"><span class="cu-h">' + title + '</span><div class="cu-chips">' +
      list.map(function (q) { return opt(key, q[0], q[1], cur); }).join('') + '</div></div>';
  }
  function linescore(m) {
    var n = Math.max(m.ends, m.log.length), head = 'END  ', rows = [m.mode === 'cpu' ? 'YOU  ' : 'RED  ', m.mode === 'cpu' ? 'CPU  ' : 'YEL  '];
    for (var e = 0; e < n; e++) {
      head += (e + 1 > 9 ? '' : ' ') + (e + 1);
      var L = m.log[e];
      for (var t = 0; t < 2; t++) rows[t] += ' ' + (!L ? '.' : L.team === t ? '<b>' + L.pts + '</b>' : '<i>0</i>');
    }
    head += '   T'; rows[0] += '  ' + ('  ' + m.score[0]).slice(-2); rows[1] += '  ' + ('  ' + m.score[1]).slice(-2);
    return '<pre class="cu-ls">' + head + '\n<span class="r">' + rows[0] + '</span>\n<span class="y">' + rows[1] + '</span></pre>';
  }
  function homeHtml() {
    var o = S.save.opts, r = S.save.rec, h = '<div class="cu-card cu-home">';
    h += '<pre class="cu-art" aria-hidden="true">   .-""""-.      __\n  / .-""-. \\    (__)\n | | (@) | |  ~~\n  \\ \'-..-\' /\n   \'-....-\'</pre>';
    h += '<div class="cu-title">CURLING</div>';
    h += '<div class="cu-tabs" role="tablist">' + ['play', 'records'].map(function (tb) {
      return '<button type="button" role="tab" data-tab="' + tb + '" aria-selected="' + (S.tab === tb) + '" class="' + (S.tab === tb ? 'on' : '') + '">' + (tb === 'play' ? 'New match' : 'Records') + '</button>';
    }).join('') + '</div>';
    if (S.tab === 'play') {
      h += optRow('Play', 'mode', [['cpu', 'vs CPU'], ['2p', '2 players']], o.mode);
      if (o.mode === 'cpu') h += optRow('CPU', 'level', LEVELS.map(function (L) { return [String(L.id), L.name]; }), String(o.level));
      h += optRow('Ends', 'ends', [['4', '4'], ['6', '6'], ['8', '8']], String(o.ends));
      h += optRow('Stones', 'spe', [['4', '4 each'], ['6', '6 each'], ['8', '8 each']], String(o.spe));
      h += optRow('Guard zone', 'fgz', [['1', 'On'], ['0', 'Off']], o.fgz ? '1' : '0');
      h += optRow('Aim guide', 'guide', [['off', 'Off'], ['line', 'Line'], ['path', 'Path']], o.guide);
      if (S.m && !S.m.over) {
        var m = S.m;
        h += '<div class="cu-saved"><span>Match in progress · end ' + m.end + '/' + m.ends + ' · ' + (m.mode === 'cpu' ? 'You ' + m.score[0] + ' – ' + m.score[1] + ' CPU ' + LEVELS[m.level].name : 'Red ' + m.score[0] + ' – ' + m.score[1] + ' Yellow') + '</span></div>';
      }
    } else {
      var rows = [['Matches', r.games]];
      LEVELS.forEach(function (L, i) { rows.push(['vs ' + L.name, r.wins[i] + ' W  ' + r.losses[i] + ' L']); });
      rows.push(['Draws', r.draws], ['2-player matches', r.twoP], ['Biggest end', r.bigEnd || '-'], ['Steals (vs CPU)', r.steals], ['Takeouts', r.takeouts], ['Buttons', r.buttons]);
      h += '<pre class="cu-tab">' + rows.map(function (q) { var a = String(q[0]), b = String(q[1]); return esc(a) + new Array(Math.max(1, 28 - a.length - b.length) + 1).join(' ') + '<b>' + esc(b) + '</b>'; }).join('\n') + '</pre>';
      h += '<div class="cu-foot">' + (S.resetArm ?
        '<span class="cu-confirm">Erase all records?</span><span><button type="button" class="cu-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="cu-lnk" data-act="reset-no">Keep</button></span>' :
        '<span></span><button type="button" class="cu-lnk" data-act="reset">Reset records</button>') + '</div>';
    }
    return h + '</div>';
  }
  function helpHtml() {
    var keys = S.coarse ?
      '<div><b>drag the sheet</b> &nbsp;move the skip&rsquo;s broom (your aim)</div><div><b>weight slider</b> &nbsp;how hard you throw</div><div><b>&#8634; / &#8635;</b> &nbsp;the handle: which way it curls</div><div><b>SWEEP</b> &nbsp;tap fast (or hold) while it slides</div>' :
      '<div><b>&larr; &rarr;</b> / drag &nbsp;move the broom (Shift: faster)</div><div><b>&uarr; &darr;</b> &nbsp;weight</div><div><b>Q / E</b> &nbsp;out-turn &#8634; / in-turn &#8635;</div><div><b>Space</b> &nbsp;throw, then tap fast (or hold) to sweep</div><div><b>F</b> &nbsp;fast-forward &nbsp;<b>P / Esc</b> &nbsp;pause</div>';
    return '<div class="cu-card cu-help"><div class="cu-title">HOW TO PLAY</div>' +
      '<p>Slide your stones up the ice and finish closer to the <b>button</b> (the centre of the rings) than the other side.</p>' +
      '<div class="cu-keys">' + keys + '</div>' +
      '<p class="cu-tip">A stone <b>curls</b> the way its handle turns, more and more as it slows: in-turn &#8635; bends right, out-turn &#8634; left (about a metre on a draw). So aim the broom to the <i>other</i> side of where you want to finish.</p>' +
      '<p class="cu-tip"><b>Weight</b> is called by where it would stop: Guard (in front of the house), Top 12 &hellip; Button &hellip; Back 12, then Tap, Takeout and Peel for hits.</p>' +
      '<p class="cu-tip"><b>Sweeping</b> polishes the ice: the stone carries up to two metres farther and curls less. Sweep late to stretch a draw that looks light.</p>' +
      '<p class="cu-tip"><b>Scoring</b>: after every stone of the end, the side with the closest stone scores one for each of its stones closer than the other side&rsquo;s best (in the rings only). The <b>hammer</b> is the last stone: scoring hands it to the other side; a blank end keeps it.</p>' +
      '<p class="cu-tip">Stones out at the sides or past the back line come off; so does one that never clears the far <b>hog line</b>. With the <b>free guard zone</b> on, guards in front of the house can&rsquo;t be knocked out by the first ' + (S.m ? fgzRocks(S.m) : 5) + ' stones of an end.</p>' +
      '<button type="button" class="cu-go" data-act="close-help">Back</button></div>';
  }
  function endHtml() {
    var e = S.endInfo, m = S.m, t = e.pts ? (S.m.mode === 'cpu' ? (e.team === 0 ? 'YOU SCORE ' : 'CPU SCORES ') : teamName(e.team) + ' SCORES ') + e.pts : 'BLANK END';
    var sub = (e.pts && e.team !== e.hammer ? 'A steal! ' : e.pts ? '' : 'Nobody in the rings. ') + hammerLine(m.hammer);
    return '<div class="cu-card cu-end"><div class="cu-title">END ' + e.end + '</div>' +
      '<div class="cu-big ' + (e.pts ? (e.team ? 'y' : 'r') : '') + '">' + esc(t) + '</div><div class="cu-sub">' + esc(sub) + '</div>' + linescore(m) + '</div>';
  }
  function overHtml() {
    var m = S.m, r = S.save.rec, note = '';
    if (m.mode === 'cpu') note = 'vs ' + LEVELS[m.level].name + ': ' + r.wins[m.level] + ' W · ' + r.losses[m.level] + ' L';
    return '<div class="cu-card cu-over"><div class="cu-title">' + overTitle() + '</div>' +
      '<div class="cu-big"><span class="r">' + m.score[0] + '</span> <i>-</i> <span class="y">' + m.score[1] + '</span></div>' +
      linescore(m) + (note ? '<div class="cu-note">' + esc(note) + '</div>' : '') + '</div>';
  }
  function pauseHtml() {
    return '<div class="cu-card cu-pause"><div class="cu-title">PAUSED</div><div class="cu-sub">End ' + S.m.end + ' · ' + teamName(0) + ' ' + S.m.score[0] + ' – ' + S.m.score[1] + ' ' + teamName(1) + '</div>' +
      '<div class="cu-btns"><button type="button" class="cu-go" data-act="resume">Resume</button><button type="button" class="cu-go alt" data-act="home">Menu</button></div></div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'home' ? homeHtml() : kind === 'help' ? helpHtml() : kind === 'end' ? endHtml() : kind === 'over' ? overHtml() : kind === 'pause' ? pauseHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.ovl.classList.toggle('low', kind === 'end');
    S.stage.classList.toggle('dim', !!kind && kind !== 'end');
    if (S.VH) relayout();
  }

  // ---- the pad under the sheet ----
  var ZONES = [['hog', 0, HOG + R], ['guard', HOG + R, TEE - R12 - R], ['house', TEE - R12 - R, BACK + R], ['hit', BACK + R, 1e9]];
  // The slider is piecewise: most of its travel goes to the weights that matter
  // most (guards and draws into the house); hits share the last quarter.
  var WK = [[0, speedFor(HOG - 2.5)], [0.12, speedFor(HOG + R)], [0.36, speedFor(TEE - R12 - R)], [0.78, speedFor(BACK + R)], [1, V_MAX]];
  function pToV(p) {
    p = clamp(p, 0, 1);
    for (var i = 1; i < WK.length; i++) if (p <= WK[i][0]) return WK[i - 1][1] + (WK[i][1] - WK[i - 1][1]) * (p - WK[i - 1][0]) / (WK[i][0] - WK[i - 1][0]);
    return V_MAX;
  }
  function vToP(v) {
    v = clamp(v, WK[0][1], V_MAX);
    for (var i = 1; i < WK.length; i++) if (v <= WK[i][1]) return WK[i - 1][0] + (WK[i][0] - WK[i - 1][0]) * (v - WK[i - 1][1]) / (WK[i][1] - WK[i - 1][1]);
    return 1;
  }
  function vPct(v) { return vToP(v) * 100; }
  function setPad(mode) {
    var h = '', sp = S.coarse ? '' : ' <small>space</small>';
    S.padMode = mode;
    if (mode === 'aim') {
      var zones = ZONES.map(function (z) {
        var a = vPct(speedFor(z[1])), b = vPct(speedFor(Math.min(z[2], 200)));
        return '<i class="z-' + z[0] + '" style="left:' + a.toFixed(1) + '%;width:' + Math.max(0, b - a).toFixed(1) + '%"></i>';
      }).join('');
      h = '<div class="cu-wt"><div class="cu-wl"><span>WEIGHT</span><b class="cu-wn"></b><em class="cu-wv"></em></div>' +
        '<div class="cu-rng"><div class="cu-zones" aria-hidden="true">' + zones + '</div>' +
        '<input type="range" class="cu-w" min="0" max="1000" step="1" aria-label="Weight"></div></div>' +
        '<div class="cu-row"><button type="button" class="cu-turn" data-turn="-1" aria-label="Out-turn: curls left">&#8634; <span>out</span></button>' +
        '<button type="button" class="cu-turn" data-turn="1" aria-label="In-turn: curls right">&#8635; <span>in</span></button>' +
        '<button type="button" class="cu-act" data-act="throw">Throw' + sp + '</button></div>';
    } else if (mode === 'run') {
      h = '<div class="cu-row"><button type="button" class="cu-sweep" data-k="sweep" aria-label="Sweep: tap fast or hold">Sweep <span>tap fast!</span></button>' +
        '<button type="button" class="cu-ff" data-act="ff" aria-label="Fast forward" title="Fast forward (F)">&raquo;</button></div>';
    } else if (mode === 'cpu' || mode === 'cpurun') {
      h = '<div class="cu-row"><div class="cu-cpu">' + (S.plan ? 'CPU call: <b>' + esc(S.plan.label) + '</b>' : 'CPU is reading the house&hellip;') + '</div>' +
        (mode === 'cpurun' ? '<button type="button" class="cu-ff" data-act="ff" aria-label="Fast forward" title="Fast forward (F)">&raquo;</button>' : '') + '</div>';
    } else if (mode === 'wait') {
      h = '<div class="cu-row"><button type="button" class="cu-act alt" data-act="skip">Next' + sp + '</button></div>';
    } else if (mode === 'next' || mode === 'final') {
      h = '<div class="cu-row"><button type="button" class="cu-act" data-act="next">' + (mode === 'final' ? 'Final score' : 'Next end') + sp + '</button></div>';
    } else if (mode === 'over') {
      h = '<div class="cu-row"><button type="button" class="cu-act" data-act="new">Rematch' + sp + '</button><button type="button" class="cu-act alt" data-act="home">Menu</button></div>';
    } else if (mode === 'home') {
      var saved = S.m && !S.m.over;
      h = '<div class="cu-row">' + (saved ? '<button type="button" class="cu-act" data-act="resume-match">Resume' + sp + '</button><button type="button" class="cu-act alt" data-act="new">New match</button>' :
        '<button type="button" class="cu-act" data-act="new">Start' + sp + '</button>') + '</div>';
    } else if (mode === 'resume') {
      h = '<div class="cu-row"><button type="button" class="cu-act" data-act="resume">Resume' + sp + '</button></div>';
    } else if (mode === 'help') {
      h = '<div class="cu-row"><button type="button" class="cu-act" data-act="close-help">Got it' + sp + '</button></div>';
    }
    S.pad.innerHTML = h;
    S.pad.className = 'cu-pad cu-pad-' + mode;
    syncPad();
  }
  function syncPad() {
    if (!S) return;
    if (S.padMode === 'aim') {
      var inp = S.pad.querySelector('.cu-w');
      var pv = Math.round(vToP(S.aim.v) * 1000);
      if (inp && Math.abs(+inp.value - pv) > 1) inp.value = String(pv);
      var wn = S.pad.querySelector('.cu-wn'), wv = S.pad.querySelector('.cu-wv');
      if (wn) wn.textContent = weightName(S.aim.v);
      if (wv) wv.textContent = S.aim.v.toFixed(2) + ' m/s';
      Array.prototype.forEach.call(S.pad.querySelectorAll('[data-turn]'), function (b) {
        var on = +b.getAttribute('data-turn') === S.aim.turn;
        b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    } else if (S.padMode === 'run') {
      var sb = S.pad.querySelector('[data-k]');
      if (sb) sb.classList.toggle('on', sweepHeld() || S.swImp > 0.5);
    }
    var ff = S.pad.querySelector('[data-act="ff"]');
    if (ff) ff.classList.toggle('on', !!S.ff);
  }
  function stonesLine(t) {
    var m = S.m, left = stonesLeft(m, t), s = '';
    if (S.phase === 'end' || S.phase === 'over' || S.phase === 'home') left = S.phase === 'end' || S.phase === 'over' ? 0 : left;
    for (var i = 0; i < m.spe; i++) s += i < left ? 'o' : '.';
    return s;
  }
  function syncSb() {
    if (!S) return;
    var m = S.m;
    if (!m || S.phase === 'home' || S.phase === 'help') { S.sb.innerHTML = '<span class="cu-sb-t">🥌 sweep it home</span>'; return; }
    var team = toThrow(m), live = S.phase === 'aim' || S.phase === 'cpu' || S.phase === 'run' ? (S.phase === 'run' && S.f ? S.f.team : team) : -1;
    function side(t) {
      return '<div class="cu-side ' + (t ? 'y' : 'r') + (live === t ? ' live' : '') + '"><b>' + teamName(t) + (m.hammer === t && !m.over ? ' <i title="Hammer: last stone">H</i>' : '') + '</b>' +
        '<span class="cu-pts">' + m.score[t] + '</span><span class="cu-st" aria-label="' + stonesLeft(m, t) + ' stones left">' + stonesLine(t) + '</span></div>';
    }
    var endTxt = m.over ? 'FINAL' : 'END ' + Math.min(m.end, Math.max(m.ends, m.end)) + (m.end > m.ends ? '+' : '/' + m.ends);
    if (S.phase === 'end') endTxt = 'END ' + S.endInfo.end;
    S.sb.innerHTML = side(0) + '<div class="cu-mid">' + endTxt + '</div>' + side(1);
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    var can = S.phase === 'run' || S.phase === 'cpu' || S.phase === 'settle';
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = !can && !S.paused;
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
    var mb = S.head.querySelector('[data-h="menu"]');
    mb.disabled = S.phase === 'home';
  }
  function syncLabel() {
    S.cv.setAttribute('aria-label', 'Curling sheet. ' + (S.m ? teamName(0) + ' ' + S.m.score[0] + ', ' + teamName(1) + ' ' + S.m.score[1] + ', end ' + S.m.end + '. ' : '') +
      'Drag or use the arrow keys to move the broom, up and down for weight, Q and E for the turn, Space to throw and to sweep.');
  }

  // ---- input ----
  var KEY2CODE = { ' ': 'Space', arrowdown: 'ArrowDown', arrowup: 'ArrowUp', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', enter: 'Enter', escape: 'Escape' };
  var SWEEP_KEYS = { Space: 1, Enter: 1, NumpadEnter: 1, ArrowDown: 1, KeyS: 1 };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ('Key' + (e.key || '').toUpperCase()); }
  function sweepHeld() {
    if (!S) return false;
    for (var k in S.keys) if (S.keys[k]) return true;
    for (var id in S.ptrs) return true;
    return !!S.gp.hold;
  }
  function sweepPress() {
    if (!S || S.phase !== 'run' || !S.f || isCpu(S.f.team) || S.paused) return;
    S.swImp = Math.min(1, S.swImp + 0.34);
    S.snd.burst(0.05, 5200, 0.07, 'highpass');
    syncPad();
  }
  function setAim(bx, v, turn) {
    if (!S || S.phase !== 'aim') return;
    if (bx != null) S.aim.bx = clamp(Math.round(bx * 1000) / 1000, -(HW - R), HW - R);
    if (v != null) S.aim.v = clamp(Math.round(v * 10000) / 10000, WK[0][1], V_MAX);
    if (turn != null && turn !== S.aim.turn) { S.aim.turn = turn; S.snd.tone(turn > 0 ? 740 : 620, 0.05, 'sine', 0.03); }
    syncPad(); draw(1, 0);
  }
  function primary() {
    if (!S) return;
    var md = S.padMode;
    if (md === 'aim') throwStone();
    else padAction(md === 'wait' ? 'skip' : md === 'next' || md === 'final' ? 'next' : md === 'over' ? 'new' : md === 'home' ? (S.m && !S.m.over ? 'resume-match' : 'new') : md === 'resume' ? 'resume' : md === 'help' ? 'close-help' : '');
  }
  function padAction(act) {
    if (!S || !act) return;
    S.snd.ensure();
    if (act === 'throw') throwStone();
    else if (act === 'ff') { S.ff = !S.ff; syncPad(); }
    else if (act === 'skip') { if (S.phase === 'settle' && S.settleT > 0.25) { S.camB = houseCam(); settleDone(); } }
    else if (act === 'next') nextEnd();
    else if (act === 'new') { S.tab = 'play'; newMatchFromOpts(); }
    else if (act === 'resume-match') resumeMatch();
    else if (act === 'resume') resume();
    else if (act === 'home') toHome();
    else if (act === 'close-help') {
      var fr = S.helpFrom; S.helpFrom = null;
      if (!fr || fr === 'home') toHome();
      else { setPad(fr); showCard(S.paused ? 'pause' : S.phase === 'end' ? 'end' : S.phase === 'over' ? 'over' : null); draw(1, 0); }
    }
  }
  function openHelp() {
    if (!S) return;
    if (S.cardKind === 'help') { padAction('close-help'); return; }
    if (S.phase === 'run' || S.phase === 'cpu' || S.phase === 'settle') { pause(); }
    if (S.paused) { S.helpFrom = 'resume'; showCard('help'); setPad('help'); return; }
    S.helpFrom = S.phase === 'home' ? 'home' : S.padMode;
    showCard('help'); setPad('help');
  }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !S.panel.contains(t)) return;
    if (t && t.isContentEditable && !S.panel.contains(t)) return;
    var code = keyCode(e), ph = S.phase, big = e.shiftKey;
    if (code === 'Escape') {
      e.preventDefault();
      if (S.cardKind === 'help') padAction('close-help');
      else if ((ph === 'run' || ph === 'cpu' || ph === 'settle') && !S.paused) pause();
      else if (S.paused) resume();
      else if (ph === 'home') closePanel();
      else toHome();
      return;
    }
    if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
    if (code === 'KeyH' || e.key === '?') { e.preventDefault(); openHelp(); return; }
    if (S.paused) { if (code === 'Space' || code === 'Enter') { e.preventDefault(); if (!e.repeat) resume(); } return; }
    if (S.cardKind === 'help') { if (code === 'Space' || code === 'Enter') { e.preventDefault(); padAction('close-help'); } return; }
    if (ph === 'aim') {
      var db = big ? 0.1 : 0.02, dv = big ? 0.04 : 0.008;
      if (code === 'ArrowLeft' || code === 'KeyA') { e.preventDefault(); setAim(S.aim.bx - db); return; }
      if (code === 'ArrowRight' || code === 'KeyD') { e.preventDefault(); setAim(S.aim.bx + db); return; }
      if (code === 'ArrowUp' || code === 'KeyW') { e.preventDefault(); setAim(null, pToV(vToP(S.aim.v) + dv)); return; }
      if (code === 'ArrowDown' || code === 'KeyS') { e.preventDefault(); setAim(null, pToV(vToP(S.aim.v) - dv)); return; }
      if (code === 'KeyQ') { e.preventDefault(); setAim(null, null, -1); return; }
      if (code === 'KeyE') { e.preventDefault(); setAim(null, null, 1); return; }
      if (code === 'KeyT') { e.preventDefault(); setAim(null, null, -S.aim.turn); return; }
      if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
        if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
        e.preventDefault(); if (!e.repeat) throwStone(); return;
      }
      return;
    }
    if (ph === 'run' || ph === 'cpu') {
      if (code === 'KeyF') { e.preventDefault(); if (!e.repeat) padAction('ff'); return; }
      if (ph === 'run' && SWEEP_KEYS[code]) {
        e.preventDefault();
        // a key still held from the throw (auto-repeat) is not a sweep: press it again
        if (!S.keys[code] && !e.repeat) { S.keys[code] = true; sweepPress(); }
        return;
      }
      return;
    }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (!e.repeat) primary();
    }
  }
  function onKeyUp(e) {
    if (!S) return;
    var code = keyCode(e);
    if (S.keys[code]) { delete S.keys[code]; syncPad(); }
  }
  // Gamepad: stick / d-pad aim and weight, bumpers the turn, A throws and sweeps (tap it), Y fast-forwards, Start pauses.
  function readPad() {
    var pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) return pads[i];
    return null;
  }
  function btnOn(p, i) { var b = p.buttons[i]; return !!b && (b.pressed || b.value > 0.5); }
  function pollPad(dt) {
    if (!S) return;
    var gp = S.gp, p = readPad();
    if (!p) { gp.hold = false; return; }
    var a = btnOn(p, 0), st = btnOn(p, 9), y = btnOn(p, 3), lb = btnOn(p, 4), rb = btnOn(p, 5);
    if (st && !gp.st) { if (S.paused) resume(); else if (S.phase === 'run' || S.phase === 'cpu' || S.phase === 'settle') pause(); }
    if (!S.paused) {
      if (S.phase === 'aim') {
        var ax = p.axes[0] || 0, ay = p.axes[1] || 0;
        if (btnOn(p, 14)) ax = -1; if (btnOn(p, 15)) ax = 1; if (btnOn(p, 12)) ay = -1; if (btnOn(p, 13)) ay = 1;
        if (Math.abs(ax) < 0.2) ax = 0; if (Math.abs(ay) < 0.2) ay = 0;
        if (ax || ay) setAim(ax ? S.aim.bx + ax * 0.9 * (dt || 0.05) : null, ay ? pToV(vToP(S.aim.v) - ay * 0.25 * (dt || 0.05)) : null);
        if (lb && !gp.lb) setAim(null, null, -1);
        if (rb && !gp.rb) setAim(null, null, 1);
        if (a && !gp.a) throwStone();
      } else if (S.phase === 'run') {
        gp.hold = a;
        if (a && !gp.a) sweepPress();
        if (y && !gp.y) padAction('ff');
      } else if (S.phase === 'cpu') { if (y && !gp.y) padAction('ff'); }
      else if (a && !gp.a) primary();
    } else if (a && !gp.a) resume();
    gp.a = a; gp.st = st; gp.y = y; gp.lb = lb; gp.rb = rb;
  }

  // ---- layout ----
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height) return vh - (vw <= 560 ? 260 : 280);
    // the pad is tallest while aiming (weight slider + buttons): always leave room for that
    var padH = S.pad.offsetHeight || 0, padMax = S.coarse ? 134 : 112;
    var chrome = r.height - (S.stage.offsetHeight || 0) + Math.max(0, padMax - padH);
    if (S.panel.classList.contains('cade-solo-panel')) {
      var hd = S.panel.querySelector('.cade-panel-head');
      chrome = (hd ? hd.offsetHeight : 40) + padMax + (S.sb.offsetHeight || 40) + 44;
    }
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 10;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var s = Math.min((vw - (phone ? 30 : 48)) / VW, phone ? 1.3 : solo ? 1.8 : 1.3), ah = availH(vw, vh), MINH = 400;
    var vh2 = Math.floor(ah / s);
    if (vh2 < MINH) { s = Math.max(0.7, Math.min(s, ah / MINH)); vh2 = MINH; }
    vh2 = Math.min(vh2, phone ? 640 : 600);
    var cw = Math.floor(VW * s), ch = Math.floor(vh2 * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    if (S.lay === cw + 'x' + ch + '@' + dpr) return false;     // nothing changed
    S.lay = cw + 'x' + ch + '@' + dpr;
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--cu-w', cw + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / VW; S.scale = s;
    var wasHouse = !S.VH || Math.abs(S.camB - houseCam()) < 0.01;
    S.VH = S.cv.height / S.k;
    // a short view zooms out a little so the guards in front of the house stay in sight
    PPM = PPM0 * clamp(S.VH / (VIEW_M * PPM0), 0.8, 1);
    if (wasHouse) S.camB = houseCam();
    if (S.col) fitFont();
    return true;
  }
  // the panel's chrome settles after it opens (position, fonts, the scoreboard): measure again
  function relayout() { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel)) && layout()) draw(1, 0); }
  function redraw() { if (!S) return; if (S.raf) return; draw(1, 0); }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT);
    clearInterval(s.gpT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('keyup', s.onKeyUp, true);
    document.removeEventListener('visibilitychange', s.onVis);
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
    var body = '<div class="cu"><div class="cu-sb"></div><div class="cu-stage"><canvas class="cu-cv" role="img"></canvas><div class="cu-ovl" style="display:none"></div></div>' +
      '<div class="cu-pad"></div><div class="cu-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🥌 Curling', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'cu-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play (H)" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="menu" title="Menu" aria-label="Menu">' + IC_MENU + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia, raw = sjson(SAVE_KEY);
    S = {
      panel: p, head: hb, stage: p.querySelector('.cu-stage'), cv: p.querySelector('.cu-cv'), ovl: p.querySelector('.cu-ovl'),
      pad: p.querySelector('.cu-pad'), sb: p.querySelector('.cu-sb'), liveEl: p.querySelector('.cu-live'),
      save: normSave(raw), firstRun: !raw, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'home', m: null, f: null, plan: null, paused: false, raf: 0, last: 0, idleT: 0,
      keys: {}, ptrs: {}, gp: { hold: false }, gpT: 0, aim: defAim(), aimMem: [defAim(), defAim()],
      pal: new Array(NPAL), col: null, atl: null, k: 1, VH: 0, camB: 0, trail: [], trailTeam: 0,
      msg: null, msgQ: [], shake: 0, swImp: 0, swShow: 0, ff: false, tab: 'play', resetArm: false, padMode: '', cardKind: null,
      endStones: null, endInfo: null, settled: false, settleT: 0, curTeam: 0, curNo: 1
    };
    makeFx();
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    layout();
    readTheme();

    S.onKey = onKey; S.onKeyUp = onKeyUp;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKeyUp, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { pause(); S.keys = {}; S.ptrs = {}; } };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      pause(); S.keys = {}; S.ptrs = {}; stopLoop();
    });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        S.lay = ''; layout(); redraw(); kick();
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { S.lay = ''; layout(); redraw(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    // a gamepad: polled by the loop while it runs, and by a slow timer for aiming and the menus
    S.onPad = function () { if (S && !S.gpT) S.gpT = setInterval(function () { if (S && !S.raf && !(Cade.isMinimized && Cade.isMinimized(S.panel))) pollPad(0.05); }, 50); };
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
        if (!S.snd.on) S.snd.stopRumble();
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') openHelp();
      else if (h === 'menu') toHome();
      try { b.blur(); } catch (er) {}
    });

    // Fast tapping (sweeping!) must never zoom, select, magnify or open a callout.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchmove', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    S.pad.addEventListener('touchstart', function (e) { if (e.target.closest && e.target.closest('[data-k],.cu-ff')) noTouch(e); }, { passive: false });
    S.pad.addEventListener('touchend', function (e) { if (e.target.closest && e.target.closest('[data-k],.cu-ff')) noTouch(e); }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    // the sheet: drag (or tap) the broom while aiming; tap anywhere to sweep while your stone slides
    var drag = null;
    function worldX(e) { var r = S.cv.getBoundingClientRect(); return ((e.clientX - r.left) / r.width * VW - VW / 2) / PPM; }
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (S.phase === 'aim') {
        try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY, bx: S.aim.bx, v: S.aim.v, axis: '' };
      } else if (S.phase === 'run') {
        try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
        S.ptrs[e.pointerId] = 1; sweepPress();
      } else if (S.phase === 'settle') padAction('skip');
    });
    S.cv.addEventListener('pointermove', function (e) {
      if (!S || !drag || drag.id !== e.pointerId || S.phase !== 'aim') return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y, sc = S.scale || 1;
      if (!drag.axis && Math.abs(dx) + Math.abs(dy) > 6) drag.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      if (drag.axis === 'x') setAim(drag.bx + dx / sc / PPM * 0.5);
      else if (drag.axis === 'y') setAim(null, pToV(vToP(drag.v) - dy / sc * 0.0015));
    });
    function endDrag(e) {
      if (!S) return;
      if (S.ptrs[e.pointerId]) { delete S.ptrs[e.pointerId]; syncPad(); }
      if (drag && drag.id === e.pointerId) {
        if (!drag.axis && e.type === 'pointerup' && S.phase === 'aim') setAim(worldX(e));
        drag = null;
      }
    }
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.cv.addEventListener(t, endDrag); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // the pad: sweep (pointer-held), turn, weight, actions
    S.pad.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-k]') : null;
      if (!b || !S) return;
      e.preventDefault();
      S.snd.ensure();
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      S.ptrs[e.pointerId] = 1; sweepPress();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) {
      S.pad.addEventListener(t, function (e) { if (S && S.ptrs[e.pointerId]) { delete S.ptrs[e.pointerId]; syncPad(); } });
    });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('input', function (e) {
      if (!S || !e.target.classList.contains('cu-w')) return;
      setAim(null, pToV(+e.target.value / 1000));
    });
    S.pad.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      if (b.hasAttribute('data-turn')) { setAim(null, null, +b.getAttribute('data-turn')); return; }
      var act = b.getAttribute('data-act');
      if (act) padAction(act);
      if (S && act !== 'ff') { try { b.blur(); } catch (er) {} }
    });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var key = b.getAttribute('data-opt'), tab = b.getAttribute('data-tab'), act = b.getAttribute('data-act');
      if (key) {
        var val = b.getAttribute('data-val'), o = S.save.opts;
        if (key === 'mode' || key === 'guide') o[key] = val;
        else if (key === 'fgz') o.fgz = val === '1';
        else o[key] = +val;
        S.save = normSave(S.save); persistSave();
        S.snd.tone(988, 0.04, 'sine', 0.03);
        showCard('home');
        var nb = S.ovl.querySelector('[data-opt="' + key + '"][data-val="' + val + '"]');
        if (nb && e.detail === 0) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
      } else if (tab) { S.tab = tab; S.resetArm = false; showCard('home'); }
      else if (act === 'reset') { S.resetArm = true; showCard('home'); }
      else if (act === 'reset-no') { S.resetArm = false; showCard('home'); }
      else if (act === 'reset-yes') {
        var o2 = S.save.opts; S.save = newSave(); S.save.opts = o2; S.resetArm = false; persistSave();
        Cade.showToast && Cade.showToast('Records reset', 'info', 1800);
        showCard('home');
      } else padAction(act);
    });

    if (S.firstRun) { persistSave(); toHome(); S.helpFrom = 'home'; showCard('help'); setPad('help'); }
    else toHome();
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); redraw(); } });
    setTimeout(function () { if (S && S.panel === p) relayout(); }, 350);
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('600 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); redraw(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Slide stones, sweep to steer, score the house — vs CPU or pass-and-play',
    icon: '🥌',
    tags: 'game,sport,fun,curling,ice,sweep,2 player,cpu,stones,house,olympic,winter',
    open: open,
    _engine: ENGINE
  });
})();
