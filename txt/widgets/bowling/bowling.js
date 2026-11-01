/* Bowling — ten-pin bowling for Cade.txt.
 * A lane seen from behind the foul line, drawn in monospace glyphs (cached in a
 * glyph atlas) with a camera that follows the ball down to the pins. Set your
 * position on the approach, aim at the arrows, pick power and spin, and the ball
 * skids through the oil then hooks on the dry back end. The ten pins are real
 * bodies: the ball and flying pins knock them over, a falling pin takes its
 * neighbour with it, lying pins slide and bounce off the kickbacks, light hits
 * make a pin teeter. Proper ten-frame scoring (strikes, spares, the 10th-frame
 * bonus balls), a scorecard, up to four bowlers: you, friends passing the
 * device, or CPU bowlers (Rookie / League / Pro / Ace) that plan their lines by
 * simulating throws. Records: high game, strikes, spares, perfect games.
 * Physics runs on a fixed 240 Hz step with an accumulator; rendering
 * interpolates. The loop only runs while something moves; it pauses on blur,
 * tab hide and minimize. Progress persists in Cade.store (cade-bowling-*).
 * Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // Units: inches and seconds. x → right across the lane (0 = centre), z → down
  // the lane from the foul line (z = 0) to the head pin (z = 720, 60 ft).
  var STEP = 1 / 240;
  var LANE_HW = 20.75, GUT_W = 9.25, WALL = LANE_HW + GUT_W;   // lane half width, gutter, kickback walls
  var HEAD_Z = 720, ROW = 10.392, PIT_Z = 756, DECK_Z = 700;  // head pin spot, row spacing, pit edge, pin deck start
  var BALL_R = 4.3, PIN_R = 2.4, PIN_H = 15, LIE_R = 2.0;
  var M_BALL = 15, M_PIN = 3.5;
  var OIL_END = 456, OIL_DRY = 0.04;     // the oil pattern (38 ft) and how little the ball grips on it
  var HOOK = 58, SPIN_DECAY = 1.3;       // lateral grip (in/s² at full spin, dry) and how fast the spin is spent
  var FR_OIL = 6, FR_DRY = 22;           // ball deceleration (in/s²)
  var V_MIN = 200, V_MAX = 400;          // release speeds (11.4 – 22.7 mph)
  var X_MAX = 18, ANG_MAX = 0.08;        // start position (±in) and launch angle (±rad)
  var KNOCK = 22, TEETER = 12;           // impact speeds (in/s) that topple a pin / make it teeter
  var FALL_T = 0.32, FR_STAND = 420, FR_FALL = 200, FR_LIE = 240;
  var E_BALL = 0.72, E_PIN = 0.8, E_WALL = 0.55;
  var MAX_T = 9;
  // pin spots: [x, row]; pin n is index n - 1 (1 = head pin, 2 left of it, 3 right…)
  var SPOTS = [[0, 0], [-6, 1], [6, 1], [-12, 2], [0, 2], [12, 2], [-18, 3], [-6, 3], [6, 3], [18, 3]];
  var LEVELS = [
    { id: 'rookie', name: 'Rookie', sx: 4.5, sa: 0.014, sp: 0.16, ss: 0.4, cand: 6 },
    { id: 'league', name: 'League', sx: 2.2, sa: 0.0065, sp: 0.08, ss: 0.18, cand: 12 },
    { id: 'pro', name: 'Pro', sx: 1, sa: 0.003, sp: 0.04, ss: 0.08, cand: 24 },
    { id: 'ace', name: 'Ace', sx: 0.4, sa: 0.0012, sp: 0.015, ss: 0.03, cand: 40 }
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

  // ---- the rack ----
  function spot(id) { var s = SPOTS[id - 1]; return { x: s[0], z: HEAD_Z + s[1] * ROW }; }
  function newPin(id, x, z) {
    var s = spot(id);
    return { id: id, x: x == null ? s.x : x, z: z == null ? s.z : z, vx: 0, vz: 0, up: true, u: 0, dx: 0, dz: 1, out: false,
      wob: 0, wobT: 0, tee: 0, teeFall: false, px: 0, pz: 0, pu: 0 };
  }
  // A rack: all ten, or the given standing pins [{id, x, z}] / [ids].
  function newRack(list) {
    var out = [], i;
    if (!list) { for (i = 1; i <= 10; i++) out.push(newPin(i)); return out; }
    for (i = 0; i < list.length; i++) {
      var p = list[i];
      if (typeof p === 'number') out.push(newPin(p));
      else if (p && p.id >= 1 && p.id <= 10) out.push(newPin(p.id, isFinite(p.x) ? p.x : null, isFinite(p.z) ? p.z : null));
    }
    return out;
  }

  // The oil: the ball barely grips on the oiled front of the lane, fully on the dry back end.
  function dry(z) {
    var u = clamp((z - (OIL_END - 40)) / 80, 0, 1);
    return OIL_DRY + (1 - OIL_DRY) * u * u * (3 - 2 * u);
  }
  function speedOf(pow) { return V_MIN + (V_MAX - V_MIN) * clamp(pow, 0, 1); }
  function mph(v) { return v * 0.0568182; }

  // ---- a roll: one ball thrown at a rack ----
  // thr: { x: start position (in), ang: launch angle (rad, + = right), pow: 0..1, spin: -1..1 (+ hooks left) }
  function newRoll(pins, thr, seed) {
    var v = speedOf(thr.pow), a = clamp(thr.ang, -ANG_MAX, ANG_MAX);
    var b = { x: clamp(thr.x, -X_MAX, X_MAX), z: 0, vx: v * Math.sin(a), vz: v * Math.cos(a), spin: clamp(thr.spin, -1, 1), gut: 0, out: false, rot: 0, px: 0, pz: 0, hit: false, v0: v };
    b.px = b.x; b.pz = b.z;
    var R = { ball: b, pins: pins.map(function (p) { var q = newPin(p.id, p.x, p.z); q.px = q.x; q.pz = q.z; return q; }),
      t: 0, acc: 0, steps: 0, done: false, quietT: 0, events: [], hits: [], r: rng(seed >>> 0 || 1), before: pins.length, entry: null, firstHit: 0 };
    return R;
  }
  function pinMoving(p) { return !p.out && (p.vx * p.vx + p.vz * p.vz > 4 || (!p.up && p.u < 1) || p.tee > 0); }
  // horizontal velocity of the point a fraction lam up a pin (a falling pin's top swings forward)
  function pinPtV(p, lam) {
    if (p.up || p.u >= 1) return [p.vx, p.vz];
    var phi = p.u * Math.PI / 2, w = (Math.PI / 2) / FALL_T * Math.cos(phi) * PIN_H * lam;
    return [p.vx + p.dx * w, p.vz + p.dz * w];
  }
  function topple(R, p, dirx, dirz, jit) {
    if (!p.up) return;
    var L = Math.sqrt(dirx * dirx + dirz * dirz) || 1, a = Math.atan2(dirx / L, dirz / L) + (R.r() - 0.5) * (jit || 0.5);
    p.up = false; p.u = 0; p.dx = Math.sin(a); p.dz = Math.cos(a); p.tee = 0; p.wob = 0;
    R.events.push('fall');
  }
  // Closest point on a pin's footprint to (x, z): standing → its base; fallen → along its body.
  function pinSeg(p) {
    if (p.up) return null;
    var phi = p.u * Math.PI / 2, s = Math.sin(phi) * PIN_H;
    return [p.x, p.z, p.x + p.dx * s, p.z + p.dz * s];
  }
  function closest(seg, x, z) {
    var ax = seg[0], az = seg[1], bx = seg[2] - ax, bz = seg[3] - az, L2 = bx * bx + bz * bz;
    var t = L2 > 1e-6 ? clamp(((x - ax) * bx + (z - az) * bz) / L2, 0, 1) : 0;
    return [ax + bx * t, az + bz * t, t];
  }
  // Impulse between two bodies along n (from a to b) at relative normal speed vn (> 0 approaching).
  function impulse(vn, ma, mb, e) { return (1 + e) * vn / (1 / ma + 1 / mb); }

  function stepRoll(R) {
    if (R.done) return;
    var dt = STEP, b = R.ball, pins = R.pins, n = pins.length, i, j, p, q, ev = R.events;
    R.t += dt; R.steps++;
    b.px = b.x; b.pz = b.z;
    for (i = 0; i < n; i++) { p = pins[i]; p.px = p.x; p.pz = p.z; p.pu = p.u; }
    // --- the ball ---
    if (!b.out) {
      var v = Math.sqrt(b.vx * b.vx + b.vz * b.vz) || 1;
      if (!b.gut) {
        var d = dry(b.z);
        b.vx -= HOOK * b.spin * d * dt;
        b.spin -= b.spin * SPIN_DECAY * d * dt;
        var fr = (FR_OIL + (FR_DRY - FR_OIL) * d) * dt, nv = Math.max(60, v - fr);
        b.vx *= nv / v; b.vz *= nv / v; v = nv;
      } else { b.vx = 0; b.vz = Math.max(80, b.vz - FR_DRY * dt); }
      b.x += b.vx * dt; b.z += b.vz * dt;
      b.rot += v * dt / BALL_R;
      if (!b.gut && b.z < PIT_Z - 10 && Math.abs(b.x) > LANE_HW + 0.5) {
        b.gut = b.x > 0 ? 1 : -1; b.x = b.gut * (LANE_HW + GUT_W / 2); b.vx = 0; b.spin = 0;
        if (!b.hit) R.gutter = true;
        ev.push('gutter');
      }
      if (b.z > PIT_Z + BALL_R) { b.out = true; ev.push('pit'); }
      if (b.vz < 0 && b.z < 0) { b.out = true; }
      // ball vs pins
      if (!b.out && b.z > HEAD_Z - 30) {
        for (i = 0; i < n; i++) {
          p = pins[i];
          if (p.out) continue;
          var cx = p.x, cz = p.z, rr = BALL_R + PIN_R, lam = 0;
          if (!p.up) { var c = closest(pinSeg(p), b.x, b.z); cx = c[0]; cz = c[1]; rr = BALL_R + LIE_R; lam = c[2]; }
          var dx = cx - b.x, dz = cz - b.z, d2 = dx * dx + dz * dz;
          if (d2 >= rr * rr || d2 < 1e-9) continue;
          var dist = Math.sqrt(d2), nx = dx / dist, nz = dz / dist, pv = pinPtV(p, lam);
          var vn = (b.vx - pv[0]) * nx + (b.vz - pv[1]) * nz;
          // separate (the pin gives way)
          var ov = rr - dist;
          p.x += nx * ov * 0.8; p.z += nz * ov * 0.8; b.x -= nx * ov * 0.2; b.z -= nz * ov * 0.2;
          if (vn <= 0) continue;
          var J = impulse(vn, M_BALL, M_PIN, E_BALL);
          b.vx -= J / M_BALL * nx; b.vz -= J / M_BALL * nz;
          // a little scatter: pins don't fly exactly along the normal
          var sc = (R.r() - 0.5) * 0.24, cs = Math.cos(sc), sn = Math.sin(sc), ix = J / M_PIN * (nx * cs - nz * sn), iz = J / M_PIN * (nx * sn + nz * cs);
          p.vx += ix; p.vz += iz;
          if (!b.hit) { b.hit = true; R.firstHit = p.id; R.entry = { x: b.x, ang: Math.atan2(b.vx, b.vz) }; }
          R.hits.push({ x: cx, z: cz, v: vn, k: 'ball' });
          if (p.up) { if (vn > TEETER) topple(R, p, ix, iz, 0.6); else wobble(R, p, vn); }
        }
      }
    }
    // --- the pins ---
    for (i = 0; i < n; i++) {
      p = pins[i];
      if (p.out) continue;
      var sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
      if (sp > 0) {
        var f = (p.up ? FR_STAND : p.u < 1 ? FR_FALL : FR_LIE) * dt;
        if (sp <= f) { p.vx = 0; p.vz = 0; } else { p.vx -= p.vx / sp * f; p.vz -= p.vz / sp * f; }
      }
      p.x += p.vx * dt; p.z += p.vz * dt;
      if (!p.up && p.u < 1) {
        p.u = Math.min(1, p.u + dt / FALL_T);
        if (p.u >= 1) ev.push('thud');
      }
      if (p.up && p.wob > 0) { p.wobT += dt; p.wob = Math.max(0, p.wob - dt * 1.6); }
      if (p.up && p.tee > 0) {
        p.tee -= dt;
        if (p.tee <= 0) { p.tee = 0; if (p.teeFall) { topple(R, p, p.dx || (R.r() - 0.5), p.dz || 1, 1.2); ev.push('teeterfall'); } }
      }
      // the kickbacks (walls beside the pin deck)
      if (p.z > DECK_Z - 20) {
        var seg = pinSeg(p), ex = seg ? Math.max(Math.abs(seg[0]), Math.abs(seg[2])) : Math.abs(p.x), lim = WALL - (p.up ? PIN_R : LIE_R);
        if (ex > lim) {
          var side = (seg ? (Math.abs(seg[2]) > Math.abs(seg[0]) ? seg[2] : seg[0]) : p.x) > 0 ? 1 : -1;
          p.x -= side * (ex - lim);
          if (p.vx * side > 0) { p.vx = -p.vx * E_WALL; ev.push('wall'); if (!p.up) { p.dx = -p.dx; } }
        }
      }
      if (p.z > PIT_Z + (p.up ? 0 : 2)) { p.out = true; if (p.up) { p.up = false; p.u = 1; } ev.push('pitpin'); }
    }
    // pin vs pin: a falling or sliding pin knocks standing ones; standing pins jostle
    for (i = 0; i < n; i++) {
      p = pins[i];
      if (p.out) continue;
      var segP = pinSeg(p), movingP = p.vx * p.vx + p.vz * p.vz > 1 || (!p.up && p.u < 1);
      for (j = 0; j < n; j++) {
        if (j === i) continue;
        q = pins[j];
        if (q.out || !q.up) continue;                 // targets: standing pins
        if (p.up && j < i) continue;                  // standing pairs once
        if (!movingP && !(q.vx * q.vx + q.vz * q.vz > 1)) continue;
        var ax, az, rr2, lm = 0;
        if (segP) { var cc = closest(segP, q.x, q.z); ax = cc[0]; az = cc[1]; rr2 = LIE_R + PIN_R; lm = cc[2]; }
        else { ax = p.x; az = p.z; rr2 = PIN_R * 2; }
        var ddx = q.x - ax, ddz = q.z - az, dd2 = ddx * ddx + ddz * ddz;
        if (dd2 >= rr2 * rr2 || dd2 < 1e-9) continue;
        var dd = Math.sqrt(dd2), mx = ddx / dd, mz = ddz / dd, pv2 = pinPtV(p, lm);
        var vrel = (pv2[0] - q.vx) * mx + (pv2[1] - q.vz) * mz, ov2 = rr2 - dd;
        q.x += mx * ov2 * 0.5; q.z += mz * ov2 * 0.5; p.x -= mx * ov2 * 0.5; p.z -= mz * ov2 * 0.5;
        if (vrel <= 0) continue;
        var J2 = impulse(vrel, M_PIN, M_PIN, E_PIN), sc2 = (R.r() - 0.5) * 0.3, c2 = Math.cos(sc2), s2 = Math.sin(sc2);
        var jx = J2 / M_PIN * (mx * c2 - mz * s2), jz = J2 / M_PIN * (mx * s2 + mz * c2);
        q.vx += jx; q.vz += jz;
        // a falling pin's top carries little mass: its base takes only part of the reaction
        var k = segP ? 0.5 : 1;
        p.vx -= jx * k; p.vz -= jz * k;
        R.hits.push({ x: q.x, z: q.z, v: vrel, k: 'pin' });
        ev.push('clack');
        if (vrel > KNOCK) topple(R, q, jx, jz, 0.7);
        else if (vrel > TEETER * 0.5) wobble(R, q, vrel);
      }
    }
    // done: the ball has gone and everything has come to rest
    var busy = !b.out;
    for (i = 0; i < n && !busy; i++) if (pinMoving(pins[i])) busy = true;
    R.quietT = busy ? 0 : R.quietT + dt;
    if (R.quietT > 0.35 || R.t > MAX_T) finish(R);
  }
  // A light knock: the pin rocks; a firm one may still tip it over after a moment.
  function wobble(R, p, vn) {
    p.wob = Math.min(1, p.wob + vn / TEETER * 0.6); p.wobT = 0;
    if (vn > TEETER * 0.55 && p.tee <= 0) {
      p.tee = 0.45 + R.r() * 0.35;
      p.teeFall = R.r() < (vn / TEETER - 0.45) * 0.9;
      var L = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
      if (L > 0.1) { p.dx = p.vx / L; p.dz = p.vz / L; } else { p.dx = 0; p.dz = 1; }
      R.events.push('teeter');
    }
  }
  function finish(R) {
    if (R.done) return;
    R.done = true;
    for (var i = 0; i < R.pins.length; i++) {
      var p = R.pins[i];
      p.vx = p.vz = 0; p.tee = 0; p.wob = 0;
      if (p.up && (p.z > PIT_Z || Math.abs(p.x) > WALL)) { p.up = false; p.out = true; }
      if (!p.up && p.u < 1) p.u = 1;
    }
    R.events.push('done');
  }
  // Advance real time dt with the fixed step; returns the render interpolation alpha.
  function advanceRoll(R, dt) {
    R.acc = Math.min(R.acc + dt, 0.25);
    while (R.acc >= STEP && !R.done) { stepRoll(R); R.acc -= STEP; }
    return R.done ? 1 : R.acc / STEP;
  }
  function rollResult(R) {
    var standing = [], down = [];
    R.pins.forEach(function (p) {
      if (p.up && !p.out) standing.push({ id: p.id, x: p.x, z: p.z }); else down.push(p.id);
    });
    standing.sort(function (a, b) { return a.id - b.id; });
    down.sort(function (a, b) { return a - b; });
    return { standing: standing, down: down, count: down.length, gutter: !!R.gutter && !R.ball.hit, hit: R.ball.hit, first: R.firstHit,
      entry: R.entry, mph: mph(R.ball.v0) };
  }
  function simulate(pins, thr, seed) {
    var R = newRoll(pins, thr, seed);
    while (!R.done) { stepRoll(R); R.events.length = 0; R.hits.length = 0; }
    return rollResult(R);
  }
  // Where a throw's ball crosses z (no pins), for aim guides and the CPU.
  function pathAt(thr, z) {
    var R = newRoll([], thr, 1), b = R.ball;
    while (!b.out && b.z < z && !b.gut && R.t < MAX_T) stepRoll(R);
    return { x: b.x, gut: b.gut, ang: Math.atan2(b.vx, b.vz) };
  }

  // ---- scoring ----
  // rolls: pins knocked per ball. Returns the frames with marks and running totals.
  function scoreGame(rolls) {
    var frames = [], i = 0, total = 0, f;
    for (f = 0; f < 10; f++) {
      var fr = { rolls: [], marks: [], score: null, total: null, strike: false, spare: false, open: false, done: false };
      frames.push(fr);
      if (i >= rolls.length) continue;
      var a = rolls[i], b = rolls[i + 1], c = rolls[i + 2];
      if (f < 9) {
        if (a === 10) {
          fr.rolls = [10]; fr.marks = ['X', '']; fr.strike = true; fr.done = true;
          if (b != null && c != null) fr.score = 10 + b + c;
          i += 1;
        } else {
          fr.rolls = b == null ? [a] : [a, b];
          fr.marks = [mk(a), b == null ? '' : a + b === 10 ? '/' : mk(b)];
          if (b != null) {
            fr.done = true;
            if (a + b === 10) { fr.spare = true; if (c != null) fr.score = 10 + c; }
            else { fr.open = true; fr.score = a + b; }
          }
          i += b == null ? 1 : 2;
        }
      } else {
        var r = rolls.slice(i, i + 3);
        fr.rolls = r;
        fr.marks = ['', '', ''];
        if (r.length > 0) fr.marks[0] = r[0] === 10 ? 'X' : mk(r[0]);
        if (r.length > 1) fr.marks[1] = r[0] === 10 ? (r[1] === 10 ? 'X' : mk(r[1])) : (r[0] + r[1] === 10 ? '/' : mk(r[1]));
        if (r.length > 2) {
          var fresh = r[0] === 10 ? r[1] === 10 : true;   // a fresh rack before the third ball?
          fr.marks[2] = fresh ? (r[2] === 10 ? 'X' : mk(r[2])) : (r[1] + r[2] === 10 ? '/' : mk(r[2]));
        }
        fr.strike = r[0] === 10;
        fr.spare = r[0] !== 10 && r.length > 1 && r[0] + r[1] === 10;
        var need = r[0] === 10 || (r.length > 1 && r[0] + r[1] === 10) ? 3 : 2;
        fr.done = r.length >= need;
        fr.open = fr.done && need === 2;
        if (fr.done) fr.score = r[0] + r[1] + (need === 3 ? r[2] : 0);
        i += r.length;
      }
    }
    var running = 0, ok = true;
    for (f = 0; f < 10; f++) {
      if (ok && frames[f].score != null) { running += frames[f].score; frames[f].total = running; } else ok = false;
    }
    // the score so far (pins counted, bonuses pending included as known)
    for (f = 0; f < 10; f++) total += frames[f].score != null ? frames[f].score : frames[f].rolls.reduce(function (s, v) { return s + v; }, 0);
    return { frames: frames, total: running, live: total, done: frames[9].done, cur: cursor(rolls) };
  }
  function mk(v) { return v === 0 ? '-' : String(v); }
  // Where the next ball goes: frame (0-9), ball in the frame (0-2), whether the rack is fresh, done.
  function cursor(rolls) {
    var i = 0, f = 0;
    while (f < 9 && i < rolls.length) {
      if (rolls[i] === 10) { i++; f++; continue; }
      if (i + 1 >= rolls.length) return { frame: f, ball: 1, fresh: false, done: false, left: 10 - rolls[i] };
      i += 2; f++;
    }
    if (f < 9) return { frame: f, ball: 0, fresh: true, done: false, left: 10 };
    var r = rolls.slice(i);
    if (r.length === 0) return { frame: 9, ball: 0, fresh: true, done: false, left: 10 };
    if (r.length === 1) return r[0] === 10 ? { frame: 9, ball: 1, fresh: true, done: false, left: 10 } : { frame: 9, ball: 1, fresh: false, done: false, left: 10 - r[0] };
    if (r.length === 2) {
      if (r[0] === 10) return r[1] === 10 ? { frame: 9, ball: 2, fresh: true, done: false, left: 10 } : { frame: 9, ball: 2, fresh: false, done: false, left: 10 - r[1] };
      if (r[0] + r[1] === 10) return { frame: 9, ball: 2, fresh: true, done: false, left: 10 };
    }
    return { frame: 9, ball: r.length, fresh: false, done: true, left: 0 };
  }
  function validRolls(rolls) {
    var out = [];
    for (var k = 0; k < rolls.length; k++) {
      var c = cursor(out);
      if (c.done) break;
      var v = rolls[k] | 0;
      if (v < 0 || v > c.left) break;
      out.push(v);
    }
    return out;
  }

  // A split: the head pin is down and the standing pins fall in two or more groups with gaps between.
  function isSplit(ids) {
    if (!ids || ids.length < 2 || ids.indexOf(1) >= 0) return false;
    var seen = {}, groups = 0;
    for (var i = 0; i < ids.length; i++) {
      if (seen[ids[i]]) continue;
      groups++;
      var st = [ids[i]]; seen[ids[i]] = 1;
      while (st.length) {
        var a = spot(st.pop());
        for (var j = 0; j < ids.length; j++) {
          if (seen[ids[j]]) continue;
          var b = spot(ids[j]), dx = a.x - b.x, dz = a.z - b.z;
          if (dx * dx + dz * dz < 12.2 * 12.2) { seen[ids[j]] = 1; st.push(ids[j]); }
        }
      }
    }
    return groups > 1;
  }
  function leaveName(ids) {
    if (!ids.length) return '';
    var s = ids.join('-');
    if (s === '7-10') return 'the 7-10';
    if (ids.length === 4 && s === '4-6-7-10') return 'the big four';
    return s;
  }

  // ---- a game: up to four bowlers, frame by frame ----
  function newGame(players, seed) {
    var ps = (players || [{ kind: 'h' }]).slice(0, 4).map(function (p, i) {
      return { kind: p.kind === 'c' ? 'c' : 'h', lvl: clamp(p.lvl | 0, 0, LEVELS.length - 1), name: String(p.name || defaultName(p, i)).slice(0, 14), rolls: [], sp: [], hand: p.hand === 'l' ? 'l' : 'r' };
    });
    if (!ps.length) ps.push({ kind: 'h', lvl: 0, name: 'P1', rolls: [], sp: [], hand: 'r' });
    return { v: 1, seed: seed >>> 0 || 1, players: ps, n: 0, rack: null, over: false };
  }
  function defaultName(p, i) { return p.kind === 'c' ? 'CPU ' + LEVELS[clamp(p.lvl | 0, 0, 3)].name : 'P' + (i + 1); }
  // Whose turn: the bowler with the fewest finished frames (in order).
  function turnOf(g) {
    var best = -1, bf = 99;
    for (var i = 0; i < g.players.length; i++) {
      var c = cursor(g.players[i].rolls);
      if (c.done) continue;
      var fdone = c.frame;
      if (fdone < bf) { bf = fdone; best = i; }
    }
    return best;
  }
  // The pins the current bowler faces: a fresh rack or what's left standing.
  function rackFor(g) {
    var t = turnOf(g);
    if (t < 0) return [];
    var c = cursor(g.players[t].rolls);
    if (c.fresh || !g.rack) return newRack();
    return newRack(g.rack);
  }
  // Record a roll's result; returns what happened for the commentary.
  function applyRoll(g, res) {
    var t = turnOf(g);
    if (t < 0) return null;
    var P = g.players[t], c = cursor(P.rolls), before = c.fresh ? 10 : (g.rack ? g.rack.length : c.left);
    var standing = res.standing.filter(function (s) { return true; });
    var cnt = clamp(before - standing.length, 0, c.left);
    var standIds = standing.map(function (s) { return s.id; });
    var split = c.fresh && cnt < 10 && isSplit(standIds);
    P.rolls.push(cnt); P.sp.push(split ? 1 : 0);
    g.n++;
    var c2 = cursor(P.rolls), info = { player: t, count: cnt, frame: c.frame, ball: c.ball, fresh: c.fresh, split: split, leave: standIds,
      strike: c.fresh && cnt === 10, spare: !c.fresh && standing.length === 0 && cnt > 0, gutter: cnt === 0 && !!res.gutter, miss: cnt === 0 };
    info.frameDone = c2.frame !== c.frame || c2.done;
    g.rack = c2.fresh || info.frameDone ? null : standing.map(function (s) { return { id: s.id, x: +s.x.toFixed(2), z: +s.z.toFixed(2) }; });
    if (info.frameDone) g.rack = null;
    g.over = turnOf(g) < 0;
    info.over = g.over;
    return info;
  }
  function seedFor(g) { return hash2(g.seed, g.n + 1) || 1; }
  function normGame(o) {
    if (!o || typeof o !== 'object' || !Array.isArray(o.players) || !o.players.length) return null;
    var g = newGame(o.players.map(function (p) { return p && typeof p === 'object' ? p : {}; }), +o.seed >>> 0);
    g.players.forEach(function (P, i) {
      var src = o.players[i] || {};
      P.rolls = validRolls(Array.isArray(src.rolls) ? src.rolls : []);
      P.sp = P.rolls.map(function (_, k) { return Array.isArray(src.sp) && src.sp[k] ? 1 : 0; });
    });
    g.n = g.players.reduce(function (s, P) { return s + P.rolls.length; }, 0);
    if (Array.isArray(o.rack)) {
      var seen = {};
      g.rack = o.rack.filter(function (p) {
        if (!p || !(p.id >= 1 && p.id <= 10) || seen[p.id] || !isFinite(p.x) || !isFinite(p.z)) return false;
        seen[p.id] = 1; return Math.abs(p.x) < WALL && p.z > DECK_Z - 40 && p.z < PIT_Z;
      }).map(function (p) { return { id: p.id | 0, x: +p.x, z: +p.z }; });
    }
    var t = turnOf(g);
    if (t >= 0) {
      var c = cursor(g.players[t].rolls);
      if (c.fresh) g.rack = null;
      else if (!g.rack || g.rack.length !== c.left) {      // rebuild the leave as plain spots
        g.rack = []; for (var k = 10 - c.left + 1; k <= 10; k++) g.rack.push({ id: k, x: spot(k).x, z: spot(k).z });
      }
    }
    g.over = t < 0;
    return g;
  }

  // ---- the CPU bowler: plans by simulating candidate throws, then executes with its level's error ----
  // A line through the pocket for a hand: start position, angle, power, spin.
  function aimFor(targetX, x0, pow, spin) {
    // solve the launch angle so the (pin-less) ball reaches targetX at the head pin (secant search)
    var a0 = -0.03, a1 = 0.03, f0 = pathAt({ x: x0, ang: a0, pow: pow, spin: spin }, HEAD_Z).x - targetX, f1 = pathAt({ x: x0, ang: a1, pow: pow, spin: spin }, HEAD_Z).x - targetX;
    for (var k = 0; k < 12 && Math.abs(f1) > 0.05; k++) {
      if (f1 === f0) break;
      var a2 = clamp(a1 - f1 * (a1 - a0) / (f1 - f0), -ANG_MAX, ANG_MAX);
      a0 = a1; f0 = f1; a1 = a2;
      f1 = pathAt({ x: x0, ang: a1, pow: pow, spin: spin }, HEAD_Z).x - targetX;
    }
    return { x: x0, ang: a1, pow: pow, spin: spin };
  }
  function cpuCandidates(pins, lvl, hand, r) {
    var L = LEVELS[clamp(lvl | 0, 0, 3)], s = hand === 'l' ? -1 : 1, out = [], n = L.cand, i;
    var full = pins.length === 10;
    for (i = 0; i < n; i++) {
      var pow = 0.45 + r() * 0.4, spin, x0, tx;
      if (full) {
        spin = s * (0.35 + r() * 0.6); x0 = s * (4 + r() * 12); tx = s * (1.5 + r() * 3.5);
      } else {
        // aim through the leave: at a standing pin, a little off its centre
        var p = pins[(r() * pins.length) | 0];
        spin = (r() - 0.5) * 0.6 * (L.id === 'rookie' ? 0.5 : 1) + s * 0.15;
        tx = p.x + (r() - 0.5) * 6;
        x0 = clamp(-tx * 0.6 + (r() - 0.5) * 8, -X_MAX, X_MAX);   // cross-lane for corner pins
        if (Math.abs(tx) > 14) pow = 0.7 + r() * 0.3;            // corner pins: firm and straight
      }
      // project the target back from the head pin to the pin it's meant for
      out.push({ lazy: [tx, x0, pow, spin] });    // the line is solved when the planner gets to it (keeps a turn's start cheap)
    }
    return out;
  }
  // Score a candidate: pins down over a few jittered tries (a robust line beats a lucky one).
  function cpuEval(pins, thr, lvl, seed) {
    var L = LEVELS[clamp(lvl | 0, 0, 3)], r = rng(seed), tot = 0, N = pins.length === 10 ? 5 : 3;
    for (var k = 0; k < N; k++) {
      var j = k === 0 ? thr : jitter(thr, L, r, 0.6);
      var res = simulate(pins, j, hash2(seed, k));
      tot += res.count + (res.count === pins.length ? 2 : 0);
    }
    return tot / N;
  }
  function jitter(thr, L, r, k) {
    k = k == null ? 1 : k;
    return { x: clamp(thr.x + gauss(r) * L.sx * k, -X_MAX, X_MAX), ang: clamp(thr.ang + gauss(r) * L.sa * k, -ANG_MAX, ANG_MAX),
      pow: clamp(thr.pow + gauss(r) * L.sp * k, 0, 1), spin: clamp(thr.spin + gauss(r) * L.ss * k, -1, 1) };
  }
  // A planner that can be stepped a few candidates per frame (UI) or run to the end (tests).
  // A bowler remembers its strike line between frames (keyed by level and hand) and keeps refining it.
  var LINES = {};
  function cpuPlanner(pins, lvl, hand, seed) {
    var r = rng(seed), cands = cpuCandidates(pins, lvl, hand, r), key = null;
    if (pins.length === 10) {
      key = (lvl | 0) + (hand === 'l' ? 'l' : 'r');
      if (LINES[key]) cands.unshift(LINES[key].thr);
    }
    return { pins: pins, lvl: lvl, cands: cands, i: 0, best: null, bestV: -1, seed: seed, done: false, key: key };
  }
  function candAt(pl, i) {
    var c = pl.cands[i];
    if (c && c.lazy) c = pl.cands[i] = aimFor(c.lazy[0], c.lazy[1], c.lazy[2], c.lazy[3]);
    return c;
  }
  function cpuStep(pl, k) {
    for (var m = 0; m < (k || 1) && pl.i < pl.cands.length; m++, pl.i++) {
      candAt(pl, pl.i);
      var v = cpuEval(pl.pins, pl.cands[pl.i], pl.lvl, hash2(pl.seed, pl.i + 7));
      if (pl.i === 0 && pl.key && LINES[pl.key]) {          // the remembered line: average in its history
        var Ln = LINES[pl.key]; Ln.v = (Ln.v * Ln.n + v) / (Ln.n + 1); Ln.n = Math.min(12, Ln.n + 1); v = Ln.v;
      }
      if (v > pl.bestV) { pl.bestV = v; pl.best = pl.cands[pl.i]; }
    }
    if (pl.i >= pl.cands.length) {
      pl.done = true;
      if (pl.key && pl.best && (!LINES[pl.key] || LINES[pl.key].thr !== pl.best)) LINES[pl.key] = { thr: pl.best, v: pl.bestV, n: 1 };
    }
    return pl.done;
  }
  function cpuForget() { LINES = {}; }
  // The throw the CPU actually makes: its plan with its level's error.
  function cpuExecute(pl) {
    var L = LEVELS[clamp(pl.lvl | 0, 0, 3)], r = rng(hash2(pl.seed, 991));
    return jitter(pl.best || candAt(pl, 0), L, r, 1);
  }
  function cpuThrow(pins, lvl, hand, seed) {
    var pl = cpuPlanner(pins, lvl, hand, seed);
    while (!cpuStep(pl, 8)) { /* plan */ }
    return cpuExecute(pl);
  }

  // ---- swipe → throw (phone swipe / mouse drag) ----
  // pts: [{x, y, t}] in logical px (y down, t ms). Up the screen = down the lane.
  // Direction → angle, speed of the flick → power, the path's bow → spin.
  var SW_ANG = 0.2, SW_V0 = 260, SW_V1 = 1900, SW_CURVE = 4.5;
  function swipeThrow(pts) {
    if (!pts || pts.length < 2) return null;
    var a = pts[0], b = pts[pts.length - 1], dx = b.x - a.x, dy = a.y - b.y, len = Math.sqrt(dx * dx + dy * dy);
    if (dy < 24 || len < 30) return null;
    // speed: over the last ~120 ms of the stroke
    var k = pts.length - 1;
    while (k > 0 && b.t - pts[k - 1].t < 120) k--;
    var q = pts[Math.max(0, k - 1)], dt = Math.max(16, b.t - q.t), vx = b.x - q.x, vy = b.y - q.y;
    var v = Math.sqrt(vx * vx + vy * vy) / dt * 1000;
    var pow = clamp((v - SW_V0) / (SW_V1 - SW_V0), 0, 1);
    // the bow: the largest signed distance from the chord (right of the stroke = hooks left)
    var ux = dx / len, uy = -dy / len, rx = -uy, ry = ux, dev = 0;
    for (var i = 1; i < pts.length - 1; i++) {
      var d = (pts[i].x - a.x) * rx + (pts[i].y - a.y) * ry;
      if (Math.abs(d) > Math.abs(dev)) dev = d;
    }
    var spin = clamp(dev / len * SW_CURVE, -1, 1);
    if (Math.abs(spin) < 0.05) spin = 0;
    return { ang: clamp(Math.atan2(dx, dy) * SW_ANG, -ANG_MAX, ANG_MAX), pow: pow, spin: spin, v: v };
  }

  // ---- records (human bowlers only) ----
  function newRecords() {
    return { v: 1, games: 0, pins: 0, high: 0, strikes: 0, spares: 0, opens: 0, gutters: 0, splits: 0, conv: 0, perfect: 0, clean: 0, streak: 0, turkeys: 0, wins: 0, top: [] };
  }
  function normRecords(o) {
    var r = newRecords();
    if (!o || typeof o !== 'object') return r;
    for (var k in r) if (k !== 'top' && k !== 'v') r[k] = Math.max(0, Math.floor(+o[k] || 0));
    r.high = Math.min(300, r.high);
    if (Array.isArray(o.top)) r.top = o.top.filter(function (t) { return t && isFinite(t.s) && t.s >= 0 && t.s <= 300; })
      .map(function (t) { return { s: t.s | 0, d: String(t.d || '').slice(0, 10), n: String(t.n || '').slice(0, 14) }; })
      .sort(function (a, b) { return b.s - a.s; }).slice(0, 5);
    return r;
  }
  // A bowler's game stats from their rolls.
  function gameStats(P) {
    var sc = scoreGame(P.rolls), st = { score: sc.total, strikes: 0, spares: 0, opens: 0, gutters: 0, splits: 0, conv: 0, streak: 0, turkeys: 0, clean: true };
    var cur = 0, fresh = true, prev = 0, i;
    for (i = 0; i < P.rolls.length; i++) {
      var c = cursor(P.rolls.slice(0, i)), v = P.rolls[i];
      if (c.fresh) {
        if (v === 10) { st.strikes++; cur++; if (cur > st.streak) st.streak = cur; if (cur % 3 === 0) st.turkeys++; }
        else cur = 0;
        if (v === 0) st.gutters++;
        if (P.sp[i]) { st.splits++; if (P.rolls[i + 1] === 10 - v) st.conv++; }
      } else {
        if (v === c.left) st.spares++;
        else if (v === 0) st.gutters++;
      }
    }
    sc.frames.forEach(function (f) { if (f.open) { st.opens++; st.clean = false; } });
    st.perfect = sc.total === 300;
    return st;
  }
  function settleGame(rec, g, date) {
    var card = { best: false, perfect: false, lines: [] }, hs = 0, humans = 0;
    var totals = g.players.map(function (P) { return scoreGame(P.rolls).total; }), top = Math.max.apply(null, totals);
    g.players.forEach(function (P, i) {
      if (P.kind !== 'h') return;
      humans++;
      var st = gameStats(P);
      rec.games++; rec.pins += st.score; rec.strikes += st.strikes; rec.spares += st.spares; rec.opens += st.opens; rec.gutters += st.gutters;
      rec.splits += st.splits; rec.conv += st.conv; rec.turkeys += st.turkeys;
      if (st.streak > rec.streak) rec.streak = st.streak;
      if (st.clean) rec.clean++;
      if (st.perfect) { rec.perfect++; card.perfect = true; }
      if (st.score > rec.high) { if (rec.high > 0 || st.score > 0) card.best = true; rec.high = st.score; }
      if (g.players.length > 1 && totals[i] === top && totals.filter(function (t) { return t === top; }).length === 1) rec.wins++;
      rec.top.push({ s: st.score, d: date || '', n: P.name });
      if (st.score > hs) hs = st.score;
      card.lines.push({ name: P.name, st: st });
    });
    rec.top.sort(function (a, b) { return b.s - a.s; });
    rec.top = rec.top.slice(0, 5);
    card.humans = humans;
    return card;
  }

  var ENGINE = {
    STEP: STEP, LANE_HW: LANE_HW, GUT_W: GUT_W, WALL: WALL, HEAD_Z: HEAD_Z, ROW: ROW, PIT_Z: PIT_Z, DECK_Z: DECK_Z, BALL_R: BALL_R, PIN_R: PIN_R, PIN_H: PIN_H,
    OIL_END: OIL_END, X_MAX: X_MAX, ANG_MAX: ANG_MAX, V_MIN: V_MIN, V_MAX: V_MAX, LEVELS: LEVELS, SPOTS: SPOTS, MAX_T: MAX_T,
    rng: rng, hash2: hash2, spot: spot, newRack: newRack, dry: dry, speedOf: speedOf, mph: mph,
    newRoll: newRoll, stepRoll: stepRoll, advanceRoll: advanceRoll, rollResult: rollResult, simulate: simulate, pathAt: pathAt, pinSeg: pinSeg,
    scoreGame: scoreGame, cursor: cursor, validRolls: validRolls, isSplit: isSplit, leaveName: leaveName,
    newGame: newGame, turnOf: turnOf, rackFor: rackFor, applyRoll: applyRoll, seedFor: seedFor, normGame: normGame,
    aimFor: aimFor, cpuCandidates: cpuCandidates, cpuPlanner: cpuPlanner, cpuStep: cpuStep, cpuExecute: cpuExecute, cpuThrow: cpuThrow, cpuForget: cpuForget,
    swipeThrow: swipeThrow, newRecords: newRecords, normRecords: normRecords, gameStats: gameStats, settleGame: settleGame
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('bowling.css');

  var PANEL_ID = 'bowling-panel', NAME = 'Bowling';
  var KEY = 'cade-bowling-', GAME_KEY = KEY + 'game', REC_KEY = KEY + 'rec', SET_KEY = KEY + 'setup', SOUND_KEY = KEY + 'sound';
  var VW = 384, CW = 8, RH = 12, BOARD = 41.5 / 39;
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.bowling = { live: function () { return S; } };   // test-only peek

  // glyph palette slots (filled from the theme)
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOLD = 4, C_RED = 5, C_LEAF = 6, C_BOARD = 7, C_ARROW = 8, C_SIGN = 9, C_OIL = 10, C_ICE = 11, NPAL = 12;

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { if (Cade.store.remove) Cade.store.remove(k); else Cade.store.set(k, ''); } catch (e) {} }
  function sjson(k) { var raw = sget(k); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

  // setup: four slots (h = a person, c = CPU, '' = empty) and each person's last aim
  function newSetup() { return { slots: [{ k: 'h', lvl: 1 }, { k: 'c', lvl: 1 }, { k: '', lvl: 1 }, { k: '', lvl: 1 }], aims: [] }; }
  function normSetup(o) {
    var s = newSetup();
    if (!o || typeof o !== 'object') return s;
    if (Array.isArray(o.slots)) for (var i = 0; i < 4; i++) {
      var q = o.slots[i];
      if (!q) continue;
      s.slots[i] = { k: q.k === 'h' || q.k === 'c' ? q.k : '', lvl: clamp(q.lvl | 0, 0, 3) };
    }
    if (!s.slots[0].k) s.slots[0].k = 'h';
    if (Array.isArray(o.aims)) s.aims = o.aims.slice(0, 4).map(normAim);
    return s;
  }
  function defAim() { return { x: 10, ang: 0.001, spin: 0.4 }; }
  function normAim(a) {
    var d = defAim();
    if (!a || typeof a !== 'object') return d;
    return { x: clamp(isFinite(a.x) ? +a.x : d.x, -X_MAX, X_MAX), ang: clamp(isFinite(a.ang) ? +a.ang : d.ang, -ANG_MAX, ANG_MAX), spin: clamp(isFinite(a.spin) ? +a.spin : d.spin, -1, 1) };
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
  // a filtered noise burst: pins clacking
  Snd.prototype.clack = function (vol, freq, dur) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      if (!this.noise) {
        var n = Math.floor(ac.sampleRate * 0.3), buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
        for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        this.noise = buf;
      }
      var t = ac.currentTime, src = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = this.noise; bp.type = 'bandpass'; bp.frequency.value = freq || 2400; bp.Q.value = 1.4;
      g.gain.setValueAtTime(Math.min(0.25, vol), t); g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.12));
      src.connect(bp); bp.connect(g); g.connect(ac.destination);
      src.start(t, Math.random() * 0.15); src.stop(t + (dur || 0.12) + 0.02);
    } catch (e) {}
  };
  // the ball's rumble down the lane (a held low tone, gain follows the ball)
  Snd.prototype.rumble = function (level) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') { this.stopRumble(); return; }
    try {
      if (!this.rum) {
        var o = ac.createOscillator(), g = ac.createGain(), lp = ac.createBiquadFilter();
        o.type = 'triangle'; o.frequency.value = 52; lp.type = 'lowpass'; lp.frequency.value = 180;
        g.gain.value = 0.0001; o.connect(lp); lp.connect(g); g.connect(ac.destination); o.start();
        this.rum = { o: o, g: g };
      }
      this.rum.g.gain.setTargetAtTime(Math.max(0.0001, level * 0.07), ac.currentTime, 0.05);
      this.rum.o.frequency.setTargetAtTime(46 + level * 22, ac.currentTime, 0.1);
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

  // ---- theme ----
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
    var wood = dark ? [196, 150, 92] : [205, 160, 100], P = S.pal;
    S.dark = dark;
    var lane = mix(bg, wood, dark ? 0.2 : 0.3), deck = mix(bg, wood, dark ? 0.27 : 0.4), appr = mix(bg, wood, dark ? 0.12 : 0.17);
    P[C_TEXT] = css(tx); P[C_MUTED] = css(mu); P[C_FAINT] = css(fa); P[C_ACC] = css(ac);
    P[C_GOLD] = dark ? '#f2c544' : '#a87406'; P[C_RED] = dark ? '#f06a6a' : '#cf3f3f'; P[C_LEAF] = dark ? '#7ed37a' : '#2f8f3a';
    P[C_ICE] = dark ? '#7cc7f2' : '#2878b5';
    P[C_BOARD] = css(mix(lane, tx, dark ? 0.22 : 0.2)); P[C_ARROW] = css(mix(lane, tx, dark ? 0.6 : 0.55));
    P[C_SIGN] = css(mix(mix(bg, ac, 0.2), tx, 0.75)); P[C_OIL] = css(mix(lane, ac, dark ? 0.5 : 0.45));
    S.col = {
      bg: css(bg), hud: css(bg, 0.86), lane: css(lane), deck: css(deck), appr: css(appr),
      gut: css(mix(bg, tx, dark ? 0.1 : 0.13)), gutEdge: css(mix(bg, tx, dark ? 0.2 : 0.26)),
      pit: css(dark ? mix(bg, [0, 0, 0], 0.55) : mix(bg, tx, 0.78)), wall: css(mix(bg, tx, dark ? 0.16 : 0.2)), wallTop: css(mix(bg, tx, dark ? 0.26 : 0.32)),
      mask: css(mix(bg, ac, dark ? 0.22 : 0.16)), maskEdge: css(mix(bg, ac, dark ? 0.45 : 0.4)),
      oil: css(ac, dark ? 0.07 : 0.06), ball: css(ac), ballHi: css(mix(ac, [255, 255, 255], 0.45)), ballLo: css(mix(ac, [0, 0, 0], 0.35)), hole: css(mix(ac, [0, 0, 0], 0.6)),
      pin: dark ? '#ece7dc' : '#fffdf8', pinEdge: dark ? 'rgba(0,0,0,0.55)' : css(mix(bg, tx, 0.55)), pinRed: dark ? '#e0524e' : '#cc3b37',
      shadow: dark ? 'rgba(0,0,0,0.4)' : 'rgba(40,25,10,0.16)', meter: css(mix(bg, tx, 0.12)),
      font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace'
    };
    fitFont();
  }

  // ---- glyphs: each (colour, char) rendered once into an atlas ----
  var AT_COLS = 24, AT_ROWS = 14;
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
    a.sc = 2.5;
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
    var w = sc ? a.cw * sc : a.cw, h = sc ? a.ch * sc : a.ch, dx = x - w / 2, dy = y - h / 2;
    if (!sc || sc >= 0.95) { dx = Math.round(dx * S.k) / S.k; dy = Math.round(dy * S.k) / S.k; }
    c.drawImage(a.cv, (i % AT_COLS) * a.cwp, ((i / AT_COLS) | 0) * a.chp, a.cwp, a.chp, dx, dy, w, h);
  }
  function drawStr(c, ci, s, x, y, align, sc) {
    var n = s.length, cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, s.charCodeAt(i), x0 + i * cw + cw / 2, y, sc);
    return x0 + n * cw;
  }

  // ---- the camera: a pitched pinhole looking down the lane ----
  var CAM_AIM = { z: -150, h: 62, p: 0.2, f: 2.1, y: 0.4 };
  var CAM_PINS = { z: 440, h: 52, p: 0.2, f: 2.1, y: 0.42 };
  var PX = 0, PY = 0, PS = 0, PD = 0;
  function camSet(cm) {
    S.cz = cm.z; S.ch = cm.h; S.cpc = Math.cos(cm.p); S.cps = Math.sin(cm.p);
    S.F = Math.min(cm.f * S.VH, 3.3 * VW); S.cyy = S.VH * cm.y + 10;
  }
  // world (x, z, height y) → screen; false when behind the camera
  function proj(x, z, y) {
    var rz = z - S.cz, ry = (y || 0) - S.ch, d = rz * S.cpc - ry * S.cps;
    if (d < 6) return false;
    var u = rz * S.cps + ry * S.cpc;
    PD = d; PS = S.F / d; PX = VW / 2 + x * PS; PY = S.cyy - u * PS;
    return true;
  }
  // the nearest z on the ground the camera sees
  function zNear() { return S.cz + 14; }
  function quad(c, fill, x0, x1, z0, z1, y0, y1) {
    // a ground (or upright, when y0/y1 given with x0 === x1) rectangle
    var pts = [];
    if (x0 === x1) { pushP(pts, x0, z0, y0); pushP(pts, x0, z1, y0); pushP(pts, x0, z1, y1); pushP(pts, x0, z0, y1); }
    else if (z0 === z1) { pushP(pts, x0, z0, y0); pushP(pts, x1, z0, y0); pushP(pts, x1, z0, y1); pushP(pts, x0, z0, y1); }
    else { pushP(pts, x0, z0, 0); pushP(pts, x1, z0, 0); pushP(pts, x1, z1, 0); pushP(pts, x0, z1, 0); }
    if (pts.length < 6) return;
    c.fillStyle = fill;
    c.beginPath(); c.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
    c.closePath(); c.fill();
  }
  function pushP(a, x, z, y) { if (proj(x, z, y)) a.push(PX, PY); }

  // ---- particles (world space) ----
  var NPART = 70;
  function makeFx() {
    S.parts = [];
    for (var i = 0; i < NPART; i++) S.parts.push({ on: false, x: 0, z: 0, y: 0, vx: 0, vz: 0, vy: 0, t: 0, life: 1, code: 42, ci: 0 });
    S.pi = 0;
  }
  function clearFx() { for (var i = 0; i < NPART; i++) S.parts[i].on = false; }
  function spark(x, z, y, n, sp, codes, ci) {
    if (S.rm) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var p = S.parts[S.pi]; S.pi = (S.pi + 1) % NPART;
      var a = Math.random() * Math.PI * 2, v = sp * (0.3 + Math.random() * 0.7);
      p.on = true; p.x = x; p.z = z; p.y = y; p.vx = Math.cos(a) * v; p.vz = Math.sin(a) * v * 0.6; p.vy = sp * (0.4 + Math.random() * 0.8);
      p.t = 0; p.life = 0.45 + Math.random() * 0.4; p.code = codes.charCodeAt(i % codes.length); p.ci = ci;
    }
  }
  function stepFx(dt) {
    for (var i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on) continue;
      p.t += dt;
      if (p.t >= p.life) { p.on = false; continue; }
      p.vy -= 260 * dt; p.x += p.vx * dt; p.z += p.vz * dt; p.y = Math.max(0, p.y + p.vy * dt);
    }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt);
    if (S.flash > 0) S.flash = Math.max(0, S.flash - dt);
    if (S.msg) { S.msg.t += dt; if (S.msg.t > S.msg.dur) S.msg = null; }
  }
  function say(text, ci, dur, sub) { S.msg = { text: text, ci: ci == null ? C_TEXT : ci, t: 0, dur: dur || 1.4, sub: sub || '' }; }

  // ---- drawing ----
  function draw(alpha, dt) {
    if (!S || !S.ctx || !S.atl) return;
    var c = S.ctx, VH = S.VH;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (S.shake > 0 && !S.rm) { var sh = S.shake * 10; c.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh); }
    camSet(S.cam);
    c.fillStyle = S.col.bg; c.fillRect(-12, -12, VW + 24, VH + 24);
    drawLane(c);
    drawGuide(c);
    drawBodies(c, alpha);
    // particles
    for (var i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on || !proj(p.x, p.z, p.y)) continue;
      c.globalAlpha = Math.min(1, 2.5 * (1 - p.t / p.life));
      glyph(c, p.ci, p.code, PX, PY, clamp(PS * 0.9, 0.45, 1.1));
    }
    c.globalAlpha = 1;
    if (S.swipe && S.swipe.pts.length > 1) drawSwipe(c);
    hud(c);
    readout(c);
    if (S.msg) banner(c);
    if (S.flash > 0 && !S.rm) { c.fillStyle = 'rgba(255,255,255,' + (S.flash * 1.6).toFixed(3) + ')'; c.fillRect(-12, -12, VW + 24, VH + 24); }
  }

  function drawLane(c) {
    var zn = Math.max(zNear(), -260), zf = PIT_Z + 40, i, z, x;
    // the approach, wider than the lane
    if (zn < 0) quad(c, S.col.appr, -WALL - 14, WALL + 14, zn, 0);
    // gutters, then the lane and the pin deck
    quad(c, S.col.gut, -WALL, -LANE_HW, Math.max(zn, 0), PIT_Z);
    quad(c, S.col.gut, LANE_HW, WALL, Math.max(zn, 0), PIT_Z);
    quad(c, S.col.lane, -LANE_HW, LANE_HW, Math.max(zn, 0), DECK_Z);
    quad(c, S.col.deck, -LANE_HW, LANE_HW, Math.max(zn, DECK_Z), PIT_Z);
    // the oil: a faint sheen on the front of the lane
    if (zn < OIL_END) { quad(c, S.col.oil, -LANE_HW, LANE_HW, Math.max(zn, 0), OIL_END - 60); quad(c, S.col.oil, -LANE_HW, LANE_HW, Math.max(zn, OIL_END - 60), OIL_END); }
    // the pit and the curtain behind it
    quad(c, S.col.pit, -WALL - 6, WALL + 6, PIT_Z, zf);
    quad(c, S.col.pit, -WALL - 6, WALL + 6, zf, zf, 0, 34);
    // kickbacks
    var kz0 = Math.max(zn, DECK_Z - 60);
    quad(c, S.col.wall, -WALL, -WALL, kz0, zf, 0, 26);
    quad(c, S.col.wall, WALL, WALL, kz0, zf, 0, 26);
    // the masking unit over the pins
    quad(c, S.col.mask, -WALL - 6, WALL + 6, zf, zf, 34, 64);
    if (proj(0, zf, 49)) {
      var sc = Math.min(2 * (WALL + 6) * PS * 0.82 / (14 * CW), 20 * PS / RH);
      if (sc > 0.2) drawStr(c, C_SIGN, '* CADE LANES *', PX, PY, 'center', sc);
    }
    if (proj(-WALL - 6, zf, 34)) { var lx = PX, ly = PY; if (proj(WALL + 6, zf, 34)) { c.fillStyle = S.col.maskEdge; c.fillRect(lx, ly - 1, PX - lx, 2); } }
    // board seams every five boards: dotted glyph lines
    var step = 48, z0 = Math.max(zn, 0);
    z0 = z0 - (z0 % step) + step;
    for (i = -15; i <= 15; i += 5) {
      x = i * BOARD;
      for (z = z0; z < DECK_Z; z += step) {
        if (z > 140 && z < 200) continue;
        if (!proj(x, z, 0)) continue;
        glyph(c, z < OIL_END ? C_OIL : C_BOARD, 46, PX, PY - 3 * clamp(PS, 0.2, 1), clamp(PS * 1.1, 0.25, 0.9));
      }
    }
    // the arrows (a V at 12-16 ft) and the dots at 7 ft
    for (i = 5; i <= 35; i += 5) {
      x = LANE_HW - (i - 0.5) * BOARD; z = 150 + (15 - Math.abs(i - 20)) * 2.4;
      if (z > zn && proj(x, z, 0)) glyph(c, C_ARROW, 94, PX, PY, clamp(PS * 1.5, 0.4, 1.3));
    }
    [3, 5, 8, 11, 14, 26, 29, 32, 35, 37].forEach(function (b) {
      if (84 > zn && proj(LANE_HW - (b - 0.5) * BOARD, 84, 0)) glyph(c, C_ARROW, 46, PX, PY - 3 * clamp(PS, 0.2, 1), clamp(PS * 1.4, 0.4, 1.1));
    });
    // approach dots
    [-24].forEach(function (az) {
      if (az <= zn) return;
      [3, 5, 8, 11, 14, 20, 26, 29, 32, 35, 37].forEach(function (b) {
        if (proj(LANE_HW - (b - 0.5) * BOARD, az, 0)) glyph(c, C_ARROW, 46, PX, PY - 3 * clamp(PS, 0.2, 1), clamp(PS * 1.4, 0.4, 1.1));
      });
    });
    // the foul line
    if (zn < 0 && proj(-LANE_HW - 4, 0, 0)) {
      var fx0 = PX, fy0 = PY, fw = clamp(PS * 1.2, 1, 4);
      if (proj(LANE_HW + 4, 0, 0)) { c.fillStyle = S.pal[C_RED]; c.globalAlpha = 0.75; c.fillRect(fx0, Math.min(fy0, PY) - fw / 2, PX - fx0, fw); c.globalAlpha = 1; }
    }
    // the pin spots: faint marks where the rack stands
    for (i = 0; i < 10; i++) {
      var sp2 = spot(i + 1);
      if (proj(sp2.x, sp2.z, 0)) glyph(c, C_BOARD, 43, PX, PY - 2 * clamp(PS, 0.2, 1), clamp(PS * 0.9, 0.25, 0.75));
    }
  }

  // the aim line: from the ball along the launch angle to the arrows (and the CPU's line)
  function drawGuide(c) {
    if (!S.aimShow) return;
    var a = S.aimShow, z, sinA = Math.sin(a.ang), cosA = Math.cos(a.ang), slope = sinA / cosA;
    var zEnd = 260, zs = Math.max(zNear() + 4, 6);
    zs = zs + ((170 - zs) % 10 + 10) % 10;
    for (z = zs; z <= zEnd; z += 10) {
      var x = a.x + slope * z;
      if (Math.abs(x) > LANE_HW || !proj(x, z, 0)) continue;
      var t = z / zEnd;
      c.globalAlpha = 0.95 - t * 0.6;
      var atA = Math.abs(z - 170) < 5;
      glyph(c, a.cpu ? C_GOLD : C_ACC, atA ? 111 : 46, PX, PY - (atA ? 0 : 2 * clamp(PS, 0.2, 1)), atA ? clamp(PS * 1.6, 0.6, 1.3) : clamp(PS * 1.5, 0.5, 1.3));
    }
    c.globalAlpha = 1;
    // the hook: a few faint marks curving the way the spin will take it, out past the arrows
    if (Math.abs(a.spin) > 0.04 && !a.cpu) {
      var xs = a.x + slope * zEnd;
      for (var k = 1; k <= 8; k++) {
        var zz = zEnd + k * 35, xx = xs + slope * k * 35 - a.spin * k * k * 0.4;
        if (Math.abs(xx) > LANE_HW || !proj(xx, zz, 0)) continue;
        c.globalAlpha = 0.42 - k * 0.04;
        glyph(c, C_ACC, 46, PX, PY - 2 * clamp(PS, 0.2, 1), clamp(PS * 1.6, 0.4, 1));
      }
      c.globalAlpha = 1;
    }
  }

  // pins and the ball, back to front
  var PROFILE = [[0.02, 0.9], [0.1, 1.55], [0.2, 2.2], [0.3, 2.35], [0.4, 2.0], [0.5, 1.45], [0.6, 0.95], [0.68, 0.85], [0.76, 0.98], [0.84, 1.18], [0.92, 1.1], [0.97, 0.75]];
  function drawBodies(c, alpha) {
    var list = S.blist, n = 0, i, R = S.R;
    var pins = R ? R.pins : S.rack;
    if (pins) for (i = 0; i < pins.length; i++) {
      var p = pins[i];
      if (p.out) continue;
      if (S.sweep && (!p.up || (S.sweep.all && p.z < sweepZ()))) continue;
      list[n++] = p;
    }
    var b = R && !R.ball.out ? R.ball : S.idleBall;
    if (b) list[n++] = b;
    list.length = n;
    list.sort(function (a, b2) { return zOf(b2, alpha) - zOf(a, alpha); });
    for (i = 0; i < n; i++) {
      if (list[i] === b) drawBall(c, b, alpha); else drawPin(c, list[i], alpha);
    }
    if (S.sweep) drawSweep(c);
  }
  function zOf(o, a) { return o.pz != null && S.R ? o.pz + (o.z - o.pz) * a : o.z; }
  function drawPin(c, p, a) {
    var live = !!S.R, x = live ? p.px + (p.x - p.px) * a : p.x, z = live ? p.pz + (p.z - p.pz) * a : p.z;
    var u = live && !p.up ? p.pu + (p.u - p.pu) * a : (p.up ? 0 : 1);
    var drop = S.setT > 0 ? S.setT * S.setT * 60 : 0;
    var ax, az, ay;
    if (p.up) {
      var w = p.wob * 0.22 * Math.sin(p.wobT * 22), tl = p.tee > 0 ? 0.12 * Math.sin(p.tee * 30) : 0;
      ax = (p.dx || 0) * (w + tl); az = (p.dz || 0) * (w + tl); ay = 1;
      if (!p.dx && !p.dz) { ax = w + tl; az = 0; }
    } else {
      var phi = u * Math.PI / 2;
      ax = p.dx * Math.sin(phi); az = p.dz * Math.sin(phi); ay = Math.cos(phi);
    }
    // the shadow
    if (proj(x, z, 0)) {
      c.fillStyle = S.col.shadow;
      c.beginPath(); c.ellipse(PX + 1, PY, 2.6 * PS, 1.1 * PS, 0, 0, Math.PI * 2); c.fill();
    }
    // the silhouette: discs along the pin's axis, an outline pass then the fill
    var k, pr, L = PROFILE.length, xs = S.px, ys = S.py, rs = S.pr, ok = 0;
    var lift = ay < 0.5 ? 2.2 * (1 - ay * 2) : 0;   // a lying pin rests on its belly
    for (k = 0; k < L; k++) {
      pr = PROFILE[k];
      var hgt = pr[0] * PIN_H;
      if (!proj(x + ax * hgt, z + az * hgt, ay * hgt + lift + drop)) { xs[k] = NaN; continue; }
      xs[k] = PX; ys[k] = PY; rs[k] = pr[1] * PS; ok++;
    }
    if (!ok) return;
    var ow = Math.max(0.6, 0.35 * PS);
    c.fillStyle = S.col.pinEdge;
    c.beginPath();
    for (k = 0; k < L; k++) if (xs[k] === xs[k]) { c.moveTo(xs[k] + rs[k] + ow, ys[k]); c.arc(xs[k], ys[k], rs[k] + ow, 0, Math.PI * 2); }
    c.fill();
    c.fillStyle = S.col.pin;
    c.beginPath();
    for (k = 0; k < L; k++) if (xs[k] === xs[k]) { c.moveTo(xs[k] + rs[k], ys[k]); c.arc(xs[k], ys[k], rs[k], 0, Math.PI * 2); }
    c.fill();
    // the red neck stripes
    if (xs[6] === xs[6] && xs[7] === xs[7] && rs[6] > 0.6) {
      c.strokeStyle = S.col.pinRed; c.lineWidth = Math.max(0.7, rs[6] * 0.55); c.lineCap = 'round';
      c.beginPath();
      var mx = (xs[6] + xs[7]) / 2, my = (ys[6] + ys[7]) / 2, dxs = xs[7] - xs[6], dys = ys[7] - ys[6], ln = Math.sqrt(dxs * dxs + dys * dys) || 1;
      var nx = -dys / ln, ny = dxs / ln, r6 = rs[6] * 0.95;
      c.moveTo(mx - nx * r6 - dxs * 0.25, my - ny * r6 - dys * 0.25); c.lineTo(mx + nx * r6 - dxs * 0.25, my + ny * r6 - dys * 0.25);
      c.moveTo(mx - nx * r6 + dxs * 0.35, my - ny * r6 + dys * 0.35); c.lineTo(mx + nx * r6 + dxs * 0.35, my + ny * r6 + dys * 0.35);
      c.stroke();
    }
  }
  function drawBall(c, b, a) {
    var live = !!S.R && b === S.R.ball, x = live ? b.px + (b.x - b.px) * a : b.x, z = live ? b.pz + (b.z - b.pz) * a : b.z;
    var y = BALL_R + (b.gut ? -2.5 : 0);
    if (!proj(x, z, 0)) return;
    var sx = PX, sy = PY, s0 = PS;
    c.fillStyle = S.col.shadow;
    c.beginPath(); c.ellipse(sx + 1.5, sy, BALL_R * 1.05 * s0, BALL_R * 0.4 * s0, 0, 0, Math.PI * 2); c.fill();
    if (!proj(x, z, y)) return;
    var r = BALL_R * PS;
    c.fillStyle = S.col.ballLo; c.beginPath(); c.arc(PX, PY, r, 0, Math.PI * 2); c.fill();
    c.fillStyle = S.col.ball; c.beginPath(); c.arc(PX - r * 0.08, PY - r * 0.08, r * 0.88, 0, Math.PI * 2); c.fill();
    c.fillStyle = S.col.ballHi; c.beginPath(); c.arc(PX - r * 0.38, PY - r * 0.4, r * 0.22, 0, Math.PI * 2); c.fill();
    // finger holes turn with the roll and drift with the spin
    var rot = (b.rot || 0) + (b.spinVis || 0), cr = Math.cos(rot);
    if (cr > -0.2 && r > 3) {
      var tilt = (b.spin || 0) * 0.6 + 0.25, hx = PX + Math.sin(tilt) * r * 0.25, hy = PY - Math.sin(rot) * r * 0.45, hr = r * 0.13 * (0.5 + 0.5 * Math.max(0, cr));
      c.fillStyle = S.col.hole;
      c.beginPath();
      c.arc(hx - r * 0.2, hy - r * 0.12, hr, 0, Math.PI * 2); c.moveTo(hx + r * 0.2 + hr, hy - r * 0.12);
      c.arc(hx + r * 0.2, hy - r * 0.12, hr, 0, Math.PI * 2); c.moveTo(hx + hr * 1.2, hy + r * 0.2);
      c.arc(hx, hy + r * 0.2, hr * 1.2, 0, Math.PI * 2);
      c.fill();
    }
  }
  // the pinsetter's rake sweeping the dead wood
  function sweepZ() { return DECK_Z - 20 + Math.min(1, S.sweep.t / S.sweep.dur) * (PIT_Z - DECK_Z + 30); }
  function drawSweep(c) {
    var z = sweepZ();
    if (!proj(-WALL, z, 9)) return;
    var x0 = PX, y0 = PY;
    if (!proj(WALL, z, 9)) return;
    var n = Math.max(4, Math.round((PX - x0) / (CW * 0.9))), sc = clamp(PS * 2.2, 0.4, 1.8);
    for (var i = 0; i <= n; i++) glyph(c, C_MUTED, 61, x0 + (PX - x0) * i / n, y0 + (PY - y0) * i / n, sc);
  }
  function drawSwipe(c) {
    var pts = S.swipe.pts, n = pts.length;
    for (var i = 0; i < n; i++) {
      c.globalAlpha = 0.25 + 0.6 * i / n;
      glyph(c, C_ACC, i === n - 1 ? 111 : 46, pts[i].x, pts[i].y, i === n - 1 ? 1.3 : 1);
    }
    c.globalAlpha = 1;
  }

  // the HUD: who's up, the frame, the score and the pins still standing
  function hud(c) {
    var g = S.g;
    if (!g) return;
    var t = S.turn, P = t >= 0 && !g.over ? g.players[t] : null;
    c.fillStyle = S.col.hud; c.fillRect(0, 0, VW, 36);
    if (!P && g.over) {
      var tots = g.players.map(function (q) { return scoreGame(q.rolls).total; }), bi = tots.indexOf(Math.max.apply(null, tots));
      drawStr(c, C_ACC, 'FINAL', 7, 10, 'left');
      var tie = tots.filter(function (v) { return v === tots[bi]; }).length > 1, wn = g.players[bi].name;
      drawStr(c, C_MUTED, g.players.length < 2 ? 'GAME OVER' : tie ? 'TIE GAME' : wn === 'You' ? 'YOU WIN' : wn.toUpperCase() + ' WINS', 7, 25, 'left', 0.78);
      drawStr(c, C_MUTED, 'SCORE', VW - 66, 10, 'right', 0.72);
      drawStr(c, C_TEXT, String(tots[g.players.length > 1 ? bi : 0]), VW - 66, 24, 'right', 1.15);
    }
    if (P) {
      var cur = cursor(P.rolls), sc = scoreGame(P.rolls);
      drawStr(c, P.kind === 'c' ? C_GOLD : C_ACC, P.name.toUpperCase(), 7, 10, 'left');
      var x = drawStr(c, C_MUTED, 'FRAME ', 7, 25, 'left', 0.78);
      x = drawStr(c, C_TEXT, String(cur.frame + 1), x, 25, 'left', 0.78);
      x = drawStr(c, C_MUTED, '  BALL ', x, 25, 'left', 0.78);
      drawStr(c, C_TEXT, String(cur.ball + 1), x, 25, 'left', 0.78);
      drawStr(c, C_MUTED, 'SCORE', VW - 66, 10, 'right', 0.72);
      drawStr(c, C_TEXT, String(sc.live), VW - 66, 24, 'right', 1.15);
    }
    // the pin indicator: back row on top, as seen from the approach
    var up = S.upMap, i;
    for (i = 1; i <= 10; i++) up[i] = 0;
    var pins = S.R ? S.R.pins : S.rack;
    if (pins) for (i = 0; i < pins.length; i++) if (pins[i].up && !pins[i].out) up[pins[i].id] = 1;
    var bx = VW - 32, by = 6, sx = 7.2, sy = 7.4;
    for (i = 0; i < 10; i++) {
      var s = SPOTS[i], gx = bx + s[0] / 6 * sx / 2 * 1.0, gy = by + (3 - s[1]) * sy;
      glyph(c, up[i + 1] ? C_TEXT : C_FAINT, up[i + 1] ? 111 : 46, gx, gy + 2, 0.85);
    }
  }
  // under the lane: stand, aim, hook and the power meter while aiming
  function readout(c) {
    var VH = S.VH, a = S.aim, ph = S.phase;
    if (!(ph === 'aim' || ph === 'meter') || !a) return;
    var y = VH - 12;
    c.fillStyle = S.col.bg; c.fillRect(0, VH - 25, VW, 25);
    var stand = Math.round((LANE_HW - a.x) / BOARD + 0.5), tgt = Math.round((LANE_HW - (a.x + Math.tan(a.ang) * 180)) / BOARD + 0.5);
    var x = drawStr(c, C_MUTED, 'STAND ', 7, y, 'left', 0.75);
    x = drawStr(c, C_TEXT, String(clamp(stand, 1, 39)), x, y, 'left', 0.85);
    x = drawStr(c, C_MUTED, '  AIM ', x, y, 'left', 0.75);
    x = drawStr(c, C_TEXT, tgt < 1 || tgt > 39 ? '--' : String(tgt), x, y, 'left', 0.85);
    x = drawStr(c, C_MUTED, '  HOOK ', x, y, 'left', 0.75);
    var hk = Math.round(Math.abs(a.spin) * 5), hs = hk ? new Array(hk + 1).join(a.spin > 0 ? '<' : '>') : '0';
    x = drawStr(c, C_ACC, hs, x, y, 'left', 0.85);
    if (ph === 'meter') {
      var w = 96, mx = VW - w - 8, v = meterVal(), cells = 16, on = Math.round(v * cells);
      drawStr(c, C_MUTED, 'PWR', mx - 4, y, 'right', 0.75);
      for (var i = 0; i < cells; i++) glyph(c, i < on ? (i >= 13 ? C_RED : i >= 9 ? C_GOLD : C_LEAF) : C_FAINT, i < on ? 35 : 45, mx + i * w / cells + 3, y, 0.85);
    } else if (S.lastMph) {
      drawStr(c, C_FAINT, S.lastMph.toFixed(1) + ' mph', VW - 8, y, 'right', 0.72);
    }
  }
  function banner(c) {
    var m = S.msg, t = m.t, VH = S.VH, y = VH * (S.phase === 'aim' || S.phase === 'cpu' ? 0.4 : 0.6);
    var a = Math.min(1, t * 6, (m.dur - t) * 4), sc = 1.8 + Math.max(0, 0.25 - t) * 2.4;
    if (a <= 0) return;
    c.globalAlpha = a;
    var w = Math.max((m.text.length + 3) * CW * sc, (m.sub.length + 4) * CW * 0.85);
    c.fillStyle = S.col.hud; c.fillRect(VW / 2 - w / 2, y - RH * sc * 0.75, w, RH * sc * 1.5 + (m.sub ? RH * 1.3 : 0));
    drawStr(c, m.ci, m.text, VW / 2, y, 'center', sc);
    if (m.sub) drawStr(c, C_MUTED, m.sub, VW / 2, y + RH * sc * 0.75 + RH * 0.45, 'center', 0.85);
    c.globalAlpha = 1;
  }

  // ---- the loop: runs only while something moves ----
  function busy() {
    if (!S || S.paused || document.hidden || (Cade.isMinimized && Cade.isMinimized(S.panel))) return false;
    var ph = S.phase;
    return ph === 'roll' || ph === 'meter' || ph === 'cpu' || ph === 'result' || !!S.sweep || camOff() || !!S.msg || S.shake > 0 || S.setT > 0 || anyFx();
  }
  function anyFx() { for (var i = 0; i < NPART; i++) if (S.parts[i].on) return true; return false; }
  function kick() { if (S && !S.raf && busy()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!busy()) { draw(1, 0); return; }
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    S.time += dt;
    var alpha = 1;
    if (S.phase === 'roll' && S.R) {
      alpha = advanceRoll(S.R, dt * S.ff);
      rollEvents();
      var b = S.R.ball;
      b.spinVis = (b.spinVis || 0) + b.spin * dt * 9;
      S.snd.rumble(b.out || b.z < 0 ? 0 : Math.min(1, Math.sqrt(b.vx * b.vx + b.vz * b.vz) / V_MAX) * (b.gut ? 0.6 : 1));
      if (S.R.done) { S.snd.stopRumble(); rollDone(); }
    } else if (S.phase === 'cpu') cpuTick(dt);
    else if (S.phase === 'result') { S.resT -= dt; if (S.resT <= 0) nextTurn(); }
    if (S.sweep) { S.sweep.t += dt; if (S.sweep.t >= S.sweep.dur) { var fn = S.sweep.then; S.sweep = null; fn(); } }
    if (S.setT > 0) S.setT = Math.max(0, S.setT - dt * 2.6);
    camStep(dt, alpha);
    stepFx(dt);
    pollPad();
    if (!S) return;
    draw(alpha, dt);
    if (busy()) S.raf = requestAnimationFrame(frame);
  }
  function meterVal() { var t = (S.time - S.meterT0) * 0.78; t = t - Math.floor(t); return t < 0.5 ? t * 2 : 2 - t * 2; }
  // the camera eases towards the aim view, or follows the ball to the pins
  function camTarget(alpha) {
    if (S.phase === 'result' || S.phase === 'sweep') return CAM_PINS;
    if (S.phase === 'roll' && S.R) {
      var b = S.R.ball, z = b.out ? PIT_Z : b.pz + (b.z - b.pz) * alpha, k = clamp((z - 40) / 560, 0, 1);
      k = k * k * (3 - 2 * k);
      return lerpCam(CAM_AIM, CAM_PINS, k);
    }
    return CAM_AIM;
  }
  function camOff() {
    var t = camTarget(1), c = S.cam;
    return Math.abs(t.z - c.z) > 0.5 || Math.abs(t.h - c.h) > 0.05 || Math.abs(t.p - c.p) > 0.002 || Math.abs(t.f - c.f) > 0.002 || Math.abs(t.y - c.y) > 0.002;
  }
  function lerpCam(a, b, k) { return { z: a.z + (b.z - a.z) * k, h: a.h + (b.h - a.h) * k, p: a.p + (b.p - a.p) * k, f: a.f + (b.f - a.f) * k, y: a.y + (b.y - a.y) * k }; }
  function camStep(dt, alpha) {
    var t = camTarget(alpha), c = S.cam, rate = S.phase === 'roll' ? 7 : 3.2, k = dt > 0 ? 1 - Math.exp(-rate * dt) : 1;
    if (S.rm) k = 1;
    var moving = false;
    ['z', 'h', 'p', 'f', 'y'].forEach(function (q) { c[q] += (t[q] - c[q]) * k; if (Math.abs(t[q] - c[q]) > (q === 'z' ? 0.5 : 0.002)) moving = true; else c[q] = t[q]; });
    S.camMoving = moving;
  }

  // roll events: sound and sparks
  function rollEvents() {
    var R = S.R, ev = R.events, i, snd = S.snd, nClack = 0;
    for (i = 0; i < R.hits.length; i++) {
      var h = R.hits[i];
      if (h.k === 'ball') { spark(h.x, h.z, 8, 4, 50, "*'.", C_GOLD); if (!S.firstHit) { S.firstHit = true; S.shake = Math.min(0.3, 0.08 + h.v / 2000); snd.clack(0.22, 1900, 0.18); snd.tone(110, 0.2, 'sine', 0.08, 60); Cade.haptic && Cade.haptic(18); } }
      else if (h.v > 40 && Math.random() < 0.35) spark(h.x, h.z, 10, 2, 40, "'.", C_FAINT);
    }
    R.hits.length = 0;
    for (i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e === 'clack' && nClack < 3 && S.time - S.clackT > 0.02) { nClack++; S.clackT = S.time; snd.clack(0.05 + Math.random() * 0.08, 2000 + Math.random() * 1600, 0.09); }
      else if (e === 'fall') { S.fallN++; }
      else if (e === 'thud' && S.time - S.thudT > 0.04) { S.thudT = S.time; snd.clack(0.05, 700, 0.12); }
      else if (e === 'gutter') { snd.tone(90, 0.35, 'sine', 0.06, 55); say('GUTTER', C_MUTED, 1.0); }
      else if (e === 'wall') snd.clack(0.06, 900, 0.1);
      else if (e === 'teeter') snd.tone(520, 0.06, 'triangle', 0.02, 480);
      else if (e === 'teeterfall') snd.clack(0.08, 1500, 0.12);
    }
    ev.length = 0;
  }

  // ---- game flow ----
  function persistGame() { if (S && S.g && !S.g.over) sset(GAME_KEY, JSON.stringify(S.g)); }
  function persistSetup() { if (S) sset(SET_KEY, JSON.stringify(S.setup)); }
  function persistRec() { if (S) sset(REC_KEY, JSON.stringify(S.rec)); }

  function playersFromSetup() {
    var hs = S.setup.slots.filter(function (q) { return q.k === 'h'; }).length, hn = 0, cn = {};
    return S.setup.slots.map(function (q, i) {
      if (!q.k) return null;
      if (q.k === 'h') { hn++; return { kind: 'h', name: hs === 1 ? 'You' : 'P' + hn, slot: i }; }
      var nm = LEVELS[q.lvl].name; cn[nm] = (cn[nm] || 0) + 1;
      return { kind: 'c', lvl: q.lvl, name: nm + (cn[nm] > 1 ? ' ' + cn[nm] : ''), slot: i };
    }).filter(Boolean);
  }
  function startGame() {
    var ps = playersFromSetup();
    if (!ps.length) return;
    cpuForget();
    S.g = newGame(ps, (Math.random() * 4294967295) >>> 0);
    S.g.slots = ps.map(function (p) { return p.slot; });
    S.lastTurn = -1; S.lastMph = 0;
    persistGame();
    beginTurn(true);
  }
  function resumeGame() {
    var g = normGame(sjson(GAME_KEY));
    if (!g || g.over) { sdel(GAME_KEY); toMenu(); return; }
    var raw = sjson(GAME_KEY);
    g.slots = raw && Array.isArray(raw.slots) ? raw.slots.slice(0, g.players.length).map(function (v) { return clamp(v | 0, 0, 3); }) : g.players.map(function (_, i) { return i; });
    cpuForget();
    S.g = g; S.lastTurn = -1;
    beginTurn(true);
  }
  function aimOf(t) {
    var slot = S.g.slots ? S.g.slots[t] : t;
    if (!S.setup.aims[slot]) S.setup.aims[slot] = defAim();
    return S.setup.aims[slot];
  }
  // A turn starts: a fresh rack is set (dropping in), the bowler steps up.
  function beginTurn(first) {
    var g = S.g;
    S.turn = turnOf(g);
    if (S.turn < 0) { endGame(); return; }
    var P = g.players[S.turn], cur = cursor(P.rolls);
    S.R = null; S.firstHit = false;
    S.rack = rackFor(g);
    if (cur.fresh) S.setT = 1;
    S.idleBall = { x: 0, z: -8, spin: 0, rot: 0 };
    S.aimShow = null;
    renderCard(); renderPad();
    var handoff = P.kind === 'h' && S.lastTurn >= 0 && S.lastTurn !== S.turn && g.players.filter(function (q) { return q.kind === 'h'; }).length > 1;
    S.lastTurn = S.turn;
    if (P.kind === 'c') {
      S.phase = 'cpu';
      S.cpuT = 0; S.cpuPlan = cpuPlanner(S.rack.map(function (p) { return { id: p.id, x: p.x, z: p.z }; }), P.lvl, P.hand, seedFor(g) ^ 0x5bd1e995);
      S.cpuAim = { x: 0, ang: 0, spin: 0, cpu: true }; S.cpuThr = null;
      S.idleBall.x = 0;
      say(P.name.toUpperCase(), C_GOLD, 1.1, 'frame ' + (cur.frame + 1) + (cur.ball ? ' · ball ' + (cur.ball + 1) : ''));
    } else {
      S.aim = aimOf(S.turn);
      S.idleBall.x = S.aim.x; S.idleBall.spin = S.aim.spin;
      S.aimShow = S.aim;
      if (handoff) { S.phase = 'handoff'; showCard('handoff'); }
      else {
        S.phase = 'aim';
        if (!first || cur.frame > 0 || cur.ball > 0) { if (cur.ball === 0 && g.players.length > 1) say(P.name.toUpperCase(), C_ACC, 0.9, 'frame ' + (cur.frame + 1)); }
        else say('FRAME 1', C_ACC, 1.1, P.kind === 'h' && S.coarse ? 'swipe up to bowl' : 'drag up or press space');
      }
    }
    renderScore(); renderPad(); syncHead();
    kick(); draw(1, 0);
  }
  function throwBall(thr) {
    if (!S || !S.g) return;
    S.snd.ensure();
    var P = S.g.players[S.turn];
    if (P.kind === 'h') { S.aim.x = thr.x; S.aim.ang = thr.ang; S.aim.spin = thr.spin; persistSetup(); }
    S.R = newRoll(S.rack, thr, seedFor(S.g));
    S.R.ball.z = -8; S.R.ball.pz = -8;
    S.lastMph = mph(S.R.ball.v0);
    S.phase = 'roll'; S.aimShow = null; S.swipe = null; S.idleBall = null; S.firstHit = false; S.fallN = 0; S.clackT = 0; S.thudT = 0;
    S.ff = P.kind === 'c' && S.fastCpu ? 2.5 : 1;
    S.snd.tone(180, 0.12, 'sine', 0.05, 120);
    Cade.haptic && Cade.haptic(10);
    renderPad(); syncHead(); kick();
  }
  function rollDone() {
    var res = rollResult(S.R), g = S.g, P = g.players[S.turn];
    var info = applyRoll(g, res);
    if (info.over) settleNow(); else persistGame();
    S.rack = S.R.pins;           // keep drawing the pins where they came to rest
    S.R = null;
    S.idleBall = null;
    renderScore();
    // the call
    var snd = S.snd, txt = '', ci = C_TEXT, sub = '', dur = 1.5;
    if (info.strike) {
      var sc = cursor(P.rolls), streak = 0;
      for (var k = P.rolls.length - 1; k >= 0; k--) { var c0 = cursor(P.rolls.slice(0, k)); if (c0.fresh && P.rolls[k] === 10) streak++; else break; }
      txt = streak >= 12 ? 'PERFECT!' : streak >= 3 ? (streak === 3 ? 'TURKEY!' : streak + ' BAGGER!') : streak === 2 ? 'DOUBLE!' : 'STRIKE!';
      ci = C_ACC; S.flash = 0.12; S.shake = 0.35; dur = 1.8;
      [523, 659, 784, 1047, 1319].forEach(function (f, j) { snd.tone(f, 0.14, 'triangle', 0.045, 0, j * 0.07); });
      if (proj(0, HEAD_Z + 15, 10)) spark(0, HEAD_Z + 15, 12, 18, 120, "*+'.", C_GOLD);
      Cade.haptic && Cade.haptic(30);
      void sc;
    } else if (info.spare) {
      txt = 'SPARE!'; ci = C_LEAF; sub = info.count + ' pin' + (info.count > 1 ? 's' : '');
      [659, 988].forEach(function (f, j) { snd.tone(f, 0.16, 'triangle', 0.045, 0, j * 0.09); });
      spark(0, HEAD_Z + 15, 10, 10, 90, "*'.", C_LEAF);
    } else if (info.gutter) { txt = 'GUTTER BALL'; ci = C_MUTED; snd.tone(150, 0.3, 'sawtooth', 0.025, 70); }
    else if (info.miss) { txt = 'MISS'; ci = C_MUTED; }
    else {
      txt = String(info.count); ci = C_TEXT; sub = info.count === 1 ? 'pin' : 'pins';
      if (info.split) { txt = 'SPLIT ' + info.count; ci = C_RED; sub = leaveName(info.leave); snd.tone(330, 0.15, 'triangle', 0.035, 0); snd.tone(247, 0.25, 'triangle', 0.035, 0, 0.14); }
      else if (info.fresh && info.leave.length) { sub = 'leave ' + leaveName(info.leave); snd.tone(523, 0.1, 'triangle', 0.03); }
      else snd.tone(440, 0.1, 'triangle', 0.03);
    }
    say(txt, ci, dur, sub);
    if (S.liveEl) S.liveEl.textContent = P.name + ': ' + txt + (sub ? ' — ' + sub : '') + '. Score ' + scoreGame(P.rolls).live + '.';
    S.lastInfo = info;
    S.phase = 'result'; S.resT = P.kind === 'c' && S.fastCpu ? 1.0 : dur + 0.15;
    renderPad(); syncHead(); kick();
  }
  // after the call: the rake sweeps the dead wood (or the whole rack), then the next turn
  function nextTurn() {
    if (!S || S.phase !== 'result') return;
    S.phase = 'sweep'; S.msg = null;
    var info = S.lastInfo;
    var then = function () {
      if (!S) return;
      if (S.g.over) { endGame(); return; }
      beginTurn(false);
    };
    var fresh = info.frameDone || info.strike || info.spare || cursor(S.g.players[info.player].rolls).fresh;
    S.sweep = { t: 0, dur: S.rm ? 0.05 : 0.6, then: then, all: fresh };
    renderPad(); kick();
  }
  // the last ball is in: drop the save and bank the records at once (closing during the sweep loses nothing)
  function settleNow() {
    var g = S.g;
    if (!g || g.settled) return;
    sdel(GAME_KEY);
    S.card = settleGame(S.rec, g, today());
    g.settled = true;
    persistRec();
  }
  function endGame() {
    var g = S.g;
    settleNow();
    S.phase = 'over'; S.R = null; S.aimShow = null; S.idleBall = null;
    showCard('over'); renderPad(); renderScore(); syncHead();
    if (S.card.best) [659, 784, 988, 1319].forEach(function (f, j) { S.snd.tone(f, 0.14, 'triangle', 0.04, 0, j * 0.08); });
    var totals = g.players.map(function (P) { return scoreGame(P.rolls).total; });
    if (S.liveEl) S.liveEl.textContent = 'Game over. ' + g.players.map(function (P, i) { return P.name + ' ' + totals[i]; }).join(', ') + '.';
    draw(1, 0);
  }

  // ---- the CPU's turn: plan a few candidates per frame, glide the aim there, bowl ----
  function cpuTick(dt) {
    var pl = S.cpuPlan, P = S.g.players[S.turn];
    S.cpuT += dt;
    if (!pl.done) {
      var t0 = performance.now();
      while (!pl.done && performance.now() - t0 < 7) cpuStep(pl, 1);
      if (pl.done) S.cpuThr = cpuExecute(pl);
    }
    var a = S.cpuAim, tgt = pl.best || { x: 0, ang: 0, spin: 0 }, k = 1 - Math.exp(-dt * 4);
    a.x += (tgt.x - a.x) * k; a.ang += (tgt.ang - a.ang) * k; a.spin += (tgt.spin - a.spin) * k;
    S.aimShow = a; S.idleBall.x = a.x;
    var wait = S.fastCpu ? 0.5 : 1.3;
    if (S.cpuThr && S.cpuT > wait) { void P; throwBall(S.cpuThr); }
  }

  // ---- human input: keys / pad steps, the meter, swipes ----
  function canAim() { return S && S.phase === 'aim' && !S.paused && S.g && S.g.players[S.turn].kind === 'h'; }
  function nudge(what, dir, big) {
    if (!canAim() && !(S && S.phase === 'meter' && what !== 'bowl')) return;
    if (S.phase === 'meter') return;
    var a = S.aim;
    if (what === 'move') a.x = clamp(a.x + dir * (big ? 3 : 1) * BOARD, -X_MAX, X_MAX);
    else if (what === 'aim') a.ang = clamp(a.ang + dir * (big ? 0.006 : 0.002), -ANG_MAX, ANG_MAX);
    else if (what === 'hook') a.spin = clamp(Math.round((a.spin + dir * (big ? 0.4 : 0.2)) * 5) / 5, -1, 1);
    S.idleBall.x = a.x; S.idleBall.spin = a.spin;
    S.snd.tone(what === 'hook' ? 700 + a.spin * 200 : 900, 0.03, 'sine', 0.02);
    persistSetup();
    draw(1, 0);
  }
  function bowlPress() {
    if (!S) return;
    S.snd.ensure();
    if (S.phase === 'aim' && canAim()) { S.phase = 'meter'; S.meterT0 = S.time; renderPad(); kick(); }
    else if (S.phase === 'meter' && !S.paused) {
      var v = meterVal();
      throwBall({ x: S.aim.x, ang: S.aim.ang, pow: v, spin: S.aim.spin });
    } else if (S.phase === 'result') { S.resT = 0; }
    else if (S.phase === 'handoff') { S.phase = 'aim'; showCard(null); renderPad(); draw(1, 0); }
    else if (S.phase === 'roll') { S.ff = S.ff > 1 ? 1 : 3; renderPad(); }
    else if (S.phase === 'cpu') { S.fastCpu = true; renderPad(); }
  }
  function stagePt(e) {
    var r = S.cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * VW, y: (e.clientY - r.top) / r.height * S.VH, t: e.timeStamp || performance.now() };
  }
  function swipePreview() {
    var th = swipeThrow(S.swipe.pts);
    if (th) { S.aimShow = { x: S.aim.x, ang: th.ang, spin: th.spin }; S.idleBall.spin = th.spin; }
    else S.aimShow = S.aim;
  }

  // ---- gamepad ----
  function readPad() {
    var pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) return pads[i];
    return null;
  }
  function btnOn(p, i) { var b = p.buttons[i]; return !!b && (b.pressed || b.value > 0.5); }
  function pollPad() {
    if (!S || !S.gpOn) return;
    var p = readPad(), gp = S.gp;
    if (!p) return;
    var now = S.time || 0, ax = p.axes[0] || 0;
    var dirs = { move: (btnOn(p, 15) || ax > 0.5 ? 1 : 0) - (btnOn(p, 14) || ax < -0.5 ? 1 : 0), aim: (btnOn(p, 5) ? 1 : 0) - (btnOn(p, 4) ? 1 : 0), hook: (btnOn(p, 2) ? 1 : 0) - (btnOn(p, 1) ? 1 : 0) };
    for (var k in dirs) {
      if (dirs[k] && (!gp[k] || now - gp[k] > 0.16)) { nudge(k, dirs[k], false); gp[k] = now || 0.001; }
      else if (!dirs[k]) gp[k] = 0;
    }
    var a = btnOn(p, 0), st = btnOn(p, 9);
    if (a && !gp.a) {
      if (S.cardKind === 'menu') startGame();
      else if (S.cardKind === 'over') { startGame(); }
      else if (S.paused) resume();
      else bowlPress();
    }
    if (st && !gp.st && S.g && S.phase !== 'over') { if (S.paused) resume(); else pause(); }
    gp.a = a; gp.st = st;
  }
  function padTimer() {
    if (!S) return;
    if (!S.raf) { S.time += 0.05; pollPad(); }
  }

  // ---- cards (DOM over the canvas) ----
  function slotLabel(q, i) {
    if (!q.k) return i === 0 ? 'You' : '—';
    return q.k === 'h' ? 'Player' : 'CPU · ' + LEVELS[q.lvl].name;
  }
  function menuHtml() {
    var h = '<div class="bw-card bw-menu">';
    h += '<div class="bw-top"><span class="bw-brand">BOWLING</span><span class="bw-hi" title="High game">' + (S.rec.high ? 'high ' + S.rec.high : '') + '</span></div>';
    h += '<div class="bw-tabs" role="tablist">' + ['play', 'records'].map(function (tb) {
      return '<button type="button" role="tab" data-tab="' + tb + '" aria-selected="' + (S.tab === tb) + '" class="' + (S.tab === tb ? 'on' : '') + '">' + (tb === 'play' ? 'Play' : 'Records') + '</button>';
    }).join('') + '</div>';
    if (S.tab === 'play') {
      var saved = sjson(GAME_KEY), sg = saved ? normGame(saved) : null;
      if (sg && !sg.over) {
        var P0 = sg.players[Math.max(0, turnOf(sg))];
        h += '<button type="button" class="bw-go" data-act="resume-game">Resume game <small>' + esc(sg.players.map(function (P) { return P.name; }).join(' vs ')) + ' · frame ' + (cursor(P0.rolls).frame + 1) + '</small></button>';
      }
      h += '<div class="bw-h">Bowlers</div><div class="bw-slots">';
      S.setup.slots.forEach(function (q, i) {
        h += '<div class="bw-slot"><span class="bw-sn">' + (i + 1) + '</span>' +
          '<button type="button" class="bw-pick' + (q.k ? ' on' : '') + (q.k === 'c' ? ' cpu' : '') + '" data-slot="' + i + '" aria-label="Bowler ' + (i + 1) + ': ' + esc(slotLabel(q, i)) + ' (tap to change)">' +
          '<b>' + (q.k === 'c' ? '[c]' : q.k === 'h' ? '[@]' : '[ ]') + '</b> ' + esc(slotLabel(q, i)) + '</button></div>';
      });
      h += '</div>';
      h += '<div class="bw-presets"><button type="button" class="bw-lnk" data-preset="solo">Solo</button><button type="button" class="bw-lnk" data-preset="cpu">vs CPU</button><button type="button" class="bw-lnk" data-preset="two">2 players</button><button type="button" class="bw-lnk" data-preset="four">4 players</button></div>';
      h += '<div class="bw-note">Tap a bowler to switch: player → CPU Rookie / League / Pro / Ace → off.</div>';
    } else {
      var r = S.rec, avg = r.games ? (r.pins / r.games).toFixed(1) : '-';
      var conv = r.splits ? Math.round(100 * r.conv / r.splits) + '%' : '-';
      var rows = [['High game', r.high ? String(r.high) : '-'], ['Average', avg], ['Games', String(r.games)], ['Wins (multi)', String(r.wins)],
        ['Strikes', String(r.strikes)], ['Spares', String(r.spares)], ['Best strike run', String(r.streak)], ['Turkeys', String(r.turkeys)],
        ['Clean games', String(r.clean)], ['Splits made', r.splits ? r.conv + '/' + r.splits + ' (' + conv + ')' : '-'], ['Gutters / misses', String(r.gutters)], ['Perfect games', String(r.perfect)]];
      h += '<pre class="bw-tab">' + rows.map(function (q) { return esc(q[0]) + new Array(Math.max(1, 26 - q[0].length - q[1].length) + 1).join(' ') + '<b>' + esc(q[1]) + '</b>'; }).join('\n') + '</pre>';
      if (r.top.length) h += '<div class="bw-h">Top games</div><pre class="bw-tab">' + r.top.map(function (t, i) {
        var a = (i + 1) + '. ' + t.n, b = t.s + '  ' + t.d;
        return esc(a) + new Array(Math.max(1, 26 - a.length - b.length) + 1).join(' ') + '<b>' + t.s + '</b>  <i>' + esc(t.d) + '</i>';
      }).join('\n') + '</pre>';
      h += '<div class="bw-foot">' + (S.resetArm ?
        '<span class="bw-confirm">Erase all records?</span><span><button type="button" class="bw-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="bw-lnk" data-act="reset-no">Keep</button></span>' :
        '<span></span><button type="button" class="bw-lnk" data-act="reset">Reset records</button>') + '</div>';
    }
    return h + '</div>';
  }
  function helpHtml() {
    var keys = S.coarse ?
      '<div><b>swipe up</b> &nbsp;from the ball to bowl: the direction aims, the speed is power, a curved stroke adds hook</div><div><b>tap the approach</b> &nbsp;to stand there</div><div><b>&lsaquo; &rsaquo; buttons</b> &nbsp;stand, aim and hook in steps, then <b>BOWL</b> (tap to start the power meter, tap again to let go)</div>' :
      '<div><b>drag up</b> &nbsp;with the mouse and let go: direction aims, speed is power, a curve adds hook</div><div><b>&larr; &rarr;</b> stand &nbsp; <b>A D</b> aim &nbsp; <b>Q E</b> hook &nbsp;(Shift: bigger steps)</div><div><b>Space</b> &nbsp;start the power meter, again to let go</div><div><b>F</b> fast-forward &nbsp; <b>P / Esc</b> pause &nbsp; <b>gamepad</b> d-pad / LB RB / X B, A bowls</div>';
    return '<div class="bw-card bw-help">' +
      '<pre class="bw-art" aria-hidden="true">   o  o  o  o\n     o  o  o\n      o  o\n       o\n\n       @  ))</pre>' +
      '<div class="bw-title">BOWLING</div>' +
      '<p>Ten frames, ten pins. Knock them all down with the first ball for a <b>strike</b> (10 + your next two balls), with both for a <b>spare</b> (10 + the next ball). Strike or spare in the 10th and you get bonus balls. 300 is perfect.</p>' +
      '<div class="bw-keys">' + keys + '</div>' +
      '<p class="bw-tip">The front of the lane is <b>oiled</b>: the ball skids straight, then <b>hooks</b> on the dry back end. Aim at the <b>arrows</b>. A faster ball hooks less. Right-handed? Stand right, aim out a little and hook back into the <b>pocket</b> between the 1 and 3 pins.</p>' +
      '<p class="bw-tip">Play alone, against CPU bowlers, or pass the device around: up to four bowlers.</p>' +
      '<button type="button" class="bw-go" data-act="close-help">' + (S.helpFrom === 'game' ? 'Back to the game' : 'Got it') + '</button></div>';
  }
  function overHtml() {
    var g = S.g, cd = S.card, rows = g.players.map(function (P, i) { return { P: P, i: i, s: scoreGame(P.rolls).total }; });
    rows.sort(function (a, b) { return b.s - a.s; });
    var h = '<div class="bw-card bw-over"><div class="bw-title">' + (cd.perfect ? 'PERFECT GAME' : 'FINAL') + '</div>';
    if (rows.length === 1) h += '<div class="bw-big">' + rows[0].s + '</div>';
    else h += '<pre class="bw-tab bw-rank">' + rows.map(function (r, k) {
      var a = (k === 0 && rows.length > 1 && r.s > rows[1].s ? '* ' : (k + 1) + '. ') + r.P.name, b = String(r.s);
      return (k === 0 ? '<b class="w">' : '') + esc(a) + new Array(Math.max(1, 22 - a.length - b.length) + 1).join(' ') + '<b>' + b + '</b>' + (k === 0 ? '</b>' : '');
    }).join('\n') + '</pre>';
    if (cd.best) h += '<div class="bw-new">** new high game **</div>';
    cd.lines.forEach(function (L) {
      var st = L.st, bits = [st.strikes + ' X', st.spares + ' /', st.opens + ' open'];
      if (st.streak >= 3) bits.push('best run ' + st.streak);
      if (st.clean) bits.push('clean game');
      h += '<div class="bw-sub">' + (cd.lines.length > 1 ? esc(L.name) + ': ' : '') + esc(bits.join(' · ')) + '</div>';
    });
    if (!cd.humans) h += '<div class="bw-sub">CPU exhibition: no records kept</div>';
    h += '<div class="bw-note">High ' + (S.rec.high || '-') + ' · average ' + (S.rec.games ? (S.rec.pins / S.rec.games).toFixed(1) : '-') + '</div></div>';
    return h;
  }
  function pauseHtml() {
    return '<div class="bw-card bw-pause"><div class="bw-title">PAUSED</div>' +
      '<div class="bw-btns"><button type="button" class="bw-go" data-act="resume">Resume</button><button type="button" class="bw-go alt" data-act="quit">Menu</button></div>' +
      '<div class="bw-note">The game is saved: resume it later from the menu.</div></div>';
  }
  function handoffHtml() {
    var P = S.g.players[S.turn], cur = cursor(P.rolls);
    return '<div class="bw-card bw-hand"><div class="bw-title">' + esc(P.name.toUpperCase()) + '</div>' +
      '<div class="bw-sub">frame ' + (cur.frame + 1) + ' · ' + scoreGame(P.rolls).live + ' so far</div>' +
      '<button type="button" class="bw-go" data-act="ready">' + esc(P.name) + ' is up: tap when ready</button>' +
      '<div class="bw-note">Pass the ' + (S.coarse ? 'phone' : 'controls') + ' to ' + esc(P.name) + '.</div></div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'menu' ? menuHtml() : kind === 'help' ? helpHtml() : kind === 'over' ? overHtml() : kind === 'pause' ? pauseHtml() : kind === 'handoff' ? handoffHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind);
  }
  function renderCard() { if (S.cardKind && S.cardKind !== 'pause') showCard(null); }

  // ---- the scorecard ----
  function renderScore() {
    var g = S.g;
    if (!g) { S.score.innerHTML = ''; S.score.style.display = 'none'; if (S.scoreRows) { S.scoreRows = 0; layout(); } return; }
    S.score.style.display = '';
    var t = turnOf(g), h = '';
    g.players.forEach(function (P, i) {
      var sc = scoreGame(P.rolls), cur = sc.cur, k = 0;
      h += '<div class="bw-row' + (i === t && !g.over ? ' cur' : '') + (P.kind === 'c' ? ' cpu' : '') + '"><div class="bw-nm" title="' + esc(P.name) + '">' + esc(P.name) + '</div>';
      // roll index → split flag
      var spAt = [], ri = 0;
      sc.frames.forEach(function (f, fi) {
        spAt[fi] = []; for (var q = 0; q < f.rolls.length; q++) spAt[fi].push(!!P.sp[ri + q]); ri += f.rolls.length;
      });
      sc.frames.forEach(function (f, fi) {
        var nb = fi === 9 ? 3 : 2, isCur = i === t && !g.over && cur.frame === fi;
        h += '<div class="bw-f' + (fi === 9 ? ' ten' : '') + (isCur ? ' now' : '') + '"><div class="bw-m">';
        for (k = 0; k < nb; k++) {
          var m = f.marks[k] || '';
          var cls = m === 'X' ? 'x' : m === '/' ? 's' : '';
          if (spAt[fi][k] && m !== 'X') cls += ' sp';
          h += '<i class="' + cls + '">' + esc(m) + '</i>';
        }
        h += '</div><div class="bw-t">' + (f.total != null ? f.total : '') + '</div></div>';
      });
      h += '<div class="bw-tot">' + sc.live + '</div></div>';
    });
    S.score.innerHTML = h;
    if (S.scoreRows !== g.players.length) { S.scoreRows = g.players.length; layout(); }
  }

  // ---- the pad under the lane ----
  function renderPad() {
    if (!S) return;
    var ph = S.phase, h = '', P = S.g && S.turn >= 0 ? S.g.players[S.turn] : null;
    var hint = function (k) { return S.coarse ? '' : ' <small>' + k + '</small>'; };
    if (S.cardKind === 'menu') h = '<button type="button" class="bw-act" data-act="start">Bowl!' + hint('space') + '</button><button type="button" class="bw-act alt" data-act="help">How to play</button>';
    else if (S.cardKind === 'help') h = '<button type="button" class="bw-act" data-act="close-help">' + (S.helpFrom === 'game' ? 'Back' : 'Got it') + '</button>';
    else if (ph === 'over') h = '<button type="button" class="bw-act" data-act="again">Rematch' + hint('space') + '</button><button type="button" class="bw-act alt" data-act="menu">Menu</button>';
    else if (S.paused) h = '<button type="button" class="bw-act" data-act="resume">Resume</button>';
    else if (ph === 'handoff') h = '<button type="button" class="bw-act" data-act="ready">Ready</button>';
    else if ((ph === 'aim' || ph === 'meter') && P && P.kind === 'h') {
      h = '<div class="bw-adj">' +
        grp('stand', adj('move', -1, '&lsaquo;', 'Stand left') + adj('move', 1, '&rsaquo;', 'Stand right')) +
        grp('aim', adj('aim', -1, '&lsaquo;', 'Aim left') + adj('aim', 1, '&rsaquo;', 'Aim right')) +
        grp('hook', adj('hook', 1, '&lsaquo;', 'Hook left') + adj('hook', -1, '&rsaquo;', 'Hook right')) + '</div>' +
        '<button type="button" class="bw-act bw-bowl' + (ph === 'meter' ? ' hot' : '') + '" data-act="bowl">' + (ph === 'meter' ? 'Let go!' : 'Bowl') + hint('space') + '</button>';
    } else if (ph === 'cpu') h = '<button type="button" class="bw-act alt wide" data-act="fastcpu">' + esc(P ? P.name : 'CPU') + ' is lining up' + (S.fastCpu ? '' : ' · faster &raquo;') + '</button>';
    else if (ph === 'roll') h = '<button type="button" class="bw-act alt wide" data-act="ff">' + (S.ff > 1 ? 'Normal speed' : 'Fast-forward &raquo;') + hint('F') + '</button>';
    else if (ph === 'result' || ph === 'sweep') h = '<button type="button" class="bw-act alt wide" data-act="next">Next' + hint('space') + '</button>';
    if (h !== S.padHtml) { S.pad.innerHTML = h; S.padHtml = h; }
  }
  function grp(lab, inner) { return '<div class="bw-grp"><span class="bw-al">' + lab + '</span><div>' + inner + '</div></div>'; }
  function adj(what, dir, lab, title) {
    return '<button type="button" class="bw-b" data-adj="' + what + '" data-dir="' + dir + '" title="' + title + '" aria-label="' + title + '">' + lab + '</button>';
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = !S.g || S.phase === 'over' || S.cardKind === 'menu';
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }

  function toMenu() {
    stopLoop();
    S.snd.stopRumble();
    if (S.g && !S.g.over) persistGame();
    S.g = null; S.R = null; S.turn = -1; S.paused = false; S.resetArm = false; S.msg = null; S.sweep = null;
    S.phase = 'menu'; S.rack = newRack(); S.idleBall = { x: 10, z: -8, spin: 0.4, rot: 0 }; S.aimShow = null;
    S.cam = { z: CAM_AIM.z, h: CAM_AIM.h, p: CAM_AIM.p, f: CAM_AIM.f, y: CAM_AIM.y };
    clearFx();
    showCard('menu'); renderPad(); renderScore(); syncHead();
    draw(1, 0);
  }
  function pause() {
    if (!S || !S.g || S.paused || S.phase === 'over' || S.cardKind === 'help') return;
    S.paused = true; S.swipe = null;
    stopLoop(); S.snd.stopRumble();
    if (S.phase === 'meter') S.phase = 'aim';
    showCard('pause'); renderPad(); syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(S.phase === 'handoff' ? 'handoff' : null); renderPad(); syncHead();
    kick(); draw(1, 0);
  }

  // ---- keys ----
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (t && t.isContentEditable && !S.panel.contains(t)) return;
    var k = e.key || '', kl = k.toLowerCase(), big = e.shiftKey;
    if (k === 'Escape') {
      e.preventDefault();
      if (S.cardKind === 'help') { closeHelp(); return; }
      if (S.g && !S.paused && S.phase !== 'over') pause(); else closePanel();
      return;
    }
    if (S.cardKind === 'menu' || S.cardKind === 'help' || S.phase === 'over' || S.paused || S.phase === 'handoff') {
      if (k === ' ' || k === 'Enter') {
        if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
        e.preventDefault();
        if (e.repeat) return;
        if (S.cardKind === 'menu') startGame();
        else if (S.cardKind === 'help') closeHelp();
        else if (S.phase === 'over') startGame();
        else if (S.paused) resume();
        else bowlPress();
      } else if (kl === 'p' && S.paused) { e.preventDefault(); resume(); }
      else if ((kl === 'h' || k === '?') && S.cardKind !== 'help') { e.preventDefault(); openHelp(); }
      return;
    }
    if (kl === 'p') { e.preventDefault(); if (!e.repeat) pause(); return; }
    if (kl === 'h' || k === '?') { e.preventDefault(); openHelp(); return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); nudge('move', k === 'ArrowLeft' ? -1 : 1, big); return; }
    if (kl === 'a' || kl === 'd' || k === ',' || k === '.' || k === '<' || k === '>') { e.preventDefault(); nudge('aim', kl === 'a' || k === ',' || k === '<' ? -1 : 1, big); return; }
    if (kl === 'q' || kl === 'e') { e.preventDefault(); nudge('hook', kl === 'q' ? 1 : -1, big); return; }
    if (kl === 'f') { e.preventDefault(); if (S.phase === 'roll') { S.ff = S.ff > 1 ? 1 : 3; renderPad(); } else if (S.phase === 'cpu') { S.fastCpu = true; renderPad(); } return; }
    if (k === ' ' || k === 'Enter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (!e.repeat) bowlPress();
    }
  }
  function openHelp() {
    if (S.g && S.phase !== 'over') { if (!S.paused) pause(); S.helpFrom = 'game'; } else S.helpFrom = 'menu';
    showCard('help'); renderPad();
  }
  function closeHelp() {
    if (S.helpFrom === 'game' && S.g) { showCard('pause'); }
    else if (S.g && S.phase === 'over' && S.card) showCard('over');
    else showCard('menu');
    renderPad();
  }

  // ---- layout ----
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height) return vh - (vw <= 560 ? 260 : 280);
    var chrome = r.height - (S.stage.offsetHeight || 0);
    if (S.panel.classList.contains('cade-solo-panel')) {
      var hd = S.panel.querySelector('.cade-panel-head');
      chrome = (hd ? hd.offsetHeight : 40) + (S.pad.offsetHeight || 56) + (S.score.offsetHeight || 0) + 44;
    }
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 10;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var s = Math.min((vw - (phone ? 34 : 48)) / VW, phone ? 1.25 : solo ? 2.2 : 1.35), ah = availH(vw, vh);
    var vh2 = Math.floor(ah / s);
    if (vh2 < 300) { s = Math.max(0.6, Math.min(s, ah / 300)); vh2 = 300; }
    vh2 = Math.min(vh2, phone ? 470 : solo ? 440 : 360);
    var cw = Math.floor(VW * s), ch = Math.floor(vh2 * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--bw-w', cw + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / VW;
    S.VH = S.cv.height / S.k;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    if (S.col) fitFont();
  }
  function redraw() { if (!S) return; if (S.raf) return; draw(1, 0); }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT); clearInterval(s.gpT); clearInterval(s.repT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('gamepadconnected', s.onPad);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    if (s.g && !s.g.over) { try { Cade.store.set(GAME_KEY, JSON.stringify(s.g)); } catch (e) {} }
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
    var body = '<div class="bw"><div class="bw-stage"><canvas class="bw-cv"></canvas><div class="bw-ovl" style="display:none"></div></div>' +
      '<div class="bw-score" aria-label="Scorecard"></div><div class="bw-pad"></div><div class="bw-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🎳 Bowling', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'bw-hb';
    hb.innerHTML = '<button type="button" data-h="menu" title="Menu" aria-label="Menu">' + IC_MENU + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia, firstRun = !sget(SET_KEY) && !sget(REC_KEY);
    S = {
      panel: p, head: hb, stage: p.querySelector('.bw-stage'), cv: p.querySelector('.bw-cv'), ovl: p.querySelector('.bw-ovl'),
      score: p.querySelector('.bw-score'), pad: p.querySelector('.bw-pad'), liveEl: p.querySelector('.bw-live'),
      setup: normSetup(sjson(SET_KEY)), rec: normRecords(sjson(REC_KEY)), snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'menu', g: null, R: null, rack: null, turn: -1, paused: false, raf: 0, last: 0, time: 0,
      pal: new Array(NPAL), col: null, atl: null, k: 1, VH: 300, blist: [], px: new Float32Array(16), py: new Float32Array(16), pr: new Float32Array(16), upMap: new Uint8Array(11),
      cam: { z: CAM_AIM.z, h: CAM_AIM.h, p: CAM_AIM.p, f: CAM_AIM.f, y: CAM_AIM.y }, camMoving: false,
      shake: 0, flash: 0, msg: null, setT: 0, sweep: null, ff: 1, fastCpu: false, tab: 'play', resetArm: false, cardKind: null, padHtml: null,
      gp: {}, gpOn: false, gpT: 0, swipe: null, aim: null, aimShow: null, idleBall: null, lastMph: 0, clackT: 0, thudT: 0, fallN: 0, helpFrom: 'menu'
    };
    makeFx();
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    layout();
    readTheme();

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S && (S.phase === 'roll' || S.phase === 'meter' || S.phase === 'cpu')) pause(); };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      pause(); stopLoop(); S.swipe = null;
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
    S.onPad = function () { if (S && !S.gpT) { S.gpOn = true; S.gpT = setInterval(padTimer, 50); } };
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

    // header buttons
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
      else if (h === 'help') { if (S.cardKind === 'help') closeHelp(); else openHelp(); }
      else if (h === 'menu') { if (S.cardKind !== 'menu') toMenu(); }
      try { b.blur(); } catch (er) {}
    });

    // no zoom / select / callouts from fast taps
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchmove', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    S.pad.addEventListener('touchstart', function (e) { if (e.target.closest && e.target.closest('[data-adj]')) noTouch(e); }, { passive: false });
    S.pad.addEventListener('touchend', function (e) { if (e.target.closest && e.target.closest('[data-adj],[data-act]')) { noTouch(e); var b = e.target.closest('[data-act]'); if (b && !b.disabled) padAct(b.getAttribute('data-act')); } }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // the lane: swipe / drag up to bowl; tap the approach to stand there; tap to let go of the meter
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (S.phase === 'meter') { bowlPress(); return; }
      if (S.phase === 'result') { S.resT = 0; return; }
      if (S.phase === 'roll' && S.g.players[S.turn].kind === 'c') { S.ff = 3; renderPad(); return; }
      if (!canAim()) return;
      try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
      S.swipe = { id: e.pointerId, pts: [stagePt(e)] };
      draw(1, 0);
    });
    S.cv.addEventListener('pointermove', function (e) {
      if (!S || !S.swipe || S.swipe.id !== e.pointerId) return;
      if (!canAim()) { S.swipe = null; return; }
      var pts = S.swipe.pts, q = stagePt(e), l = pts[pts.length - 1];
      if (Math.abs(q.x - l.x) + Math.abs(q.y - l.y) < 1.5) return;
      pts.push(q);
      if (pts.length > 160) pts.splice(1, 1);
      swipePreview();
      if (!S.swipeRaf) S.swipeRaf = requestAnimationFrame(function () { if (S) { S.swipeRaf = 0; if (!S.raf) draw(1, 0); } });
    });
    function swipeEnd(e) {
      if (!S || !S.swipe || S.swipe.id !== e.pointerId) return;
      var sw = S.swipe; S.swipe = null;
      if (e.type === 'pointerup') sw.pts.push(stagePt(e));
      var th = e.type === 'pointerup' && canAim() ? swipeThrow(sw.pts) : null;
      if (th) { throwBall({ x: S.aim.x, ang: th.ang, pow: th.pow, spin: th.spin }); return; }
      S.aimShow = S.aim; S.idleBall.spin = S.aim.spin;
      // a tap on the approach: stand there
      var a = sw.pts[0], b = sw.pts[sw.pts.length - 1];
      if (e.type === 'pointerup' && canAim() && Math.abs(b.x - a.x) + Math.abs(b.y - a.y) < 12) {
        camSet(S.cam);
        if (proj(0, -8, 0) && a.y > PY - 60) {
          var d = PD, x = (a.x - VW / 2) / (S.F / d);
          S.aim.x = clamp(Math.round(x / BOARD) * BOARD, -X_MAX, X_MAX); S.idleBall.x = S.aim.x;
          S.snd.tone(900, 0.03, 'sine', 0.02); persistSetup();
        }
      }
      draw(1, 0);
    }
    ['pointerup', 'pointercancel'].forEach(function (t) { S.cv.addEventListener(t, swipeEnd); });

    // the pad: step buttons repeat while held; actions on click
    function stopRep() { clearInterval(S.repT); clearTimeout(S.repD); S.repT = 0; }
    S.pad.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.target.closest && e.target.closest('button')) e.preventDefault();   // no focus: Space stays the game's
      var b = e.target.closest ? e.target.closest('[data-adj]') : null;
      if (!b || !S) return;
      e.preventDefault();
      S.snd.ensure();
      var what = b.getAttribute('data-adj'), dir = +b.getAttribute('data-dir');
      nudge(what, dir, false);
      stopRep();
      S.repD = setTimeout(function () { if (S) S.repT = setInterval(function () { if (S) nudge(what, dir, false); }, 70); }, 320);
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.pad.addEventListener(t, function () { if (S) stopRep(); }); });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (b && S) padAct(b.getAttribute('data-act'));
    });
    // cards
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var slot = b.getAttribute('data-slot'), tab = b.getAttribute('data-tab'), act = b.getAttribute('data-act'), pre = b.getAttribute('data-preset');
      if (slot != null) {
        var i = +slot, q = S.setup.slots[i];
        // player → CPU Rookie → League → Pro → Ace → off (slot 1 never off)
        if (q.k === 'h') { q.k = 'c'; q.lvl = 0; }
        else if (q.k === 'c' && q.lvl < 3) q.lvl++;
        else if (q.k === 'c') q.k = i === 0 ? 'h' : '';
        else q.k = 'h';
        persistSetup(); S.snd.tone(800 + i * 60, 0.04, 'sine', 0.025);
        showCard('menu');
        var nb = e.detail === 0 && S.ovl.querySelector('[data-slot="' + i + '"]');
        if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
      } else if (pre) {
        var sl = S.setup.slots, lv = sl[1].k === 'c' ? sl[1].lvl : 1;
        var map = { solo: ['h', '', '', ''], cpu: ['h', 'c', '', ''], two: ['h', 'h', '', ''], four: ['h', 'h', 'h', 'h'] }[pre];
        for (var j = 0; j < 4; j++) { sl[j].k = map[j]; if (map[j] === 'c') sl[j].lvl = lv; }
        persistSetup(); showCard('menu');
      } else if (tab) { S.tab = tab; S.resetArm = false; showCard('menu'); }
      else if (act === 'resume-game') resumeGame();
      else if (act === 'reset') { S.resetArm = true; showCard('menu'); }
      else if (act === 'reset-no') { S.resetArm = false; showCard('menu'); }
      else if (act === 'reset-yes') { S.rec = newRecords(); persistRec(); S.resetArm = false; Cade.showToast && Cade.showToast('Records reset', 'info', 1600); showCard('menu'); }
      else padAct(act);
    });

    toMenu();
    if (firstRun) { S.helpFrom = 'menu'; showCard('help'); renderPad(); }
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); redraw(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('600 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); redraw(); } }, function () {});
      }
    } catch (e) {}
  }
  function padAct(act) {
    if (!S || !act) return;
    S.snd.ensure();
    if (act === 'start' || act === 'again') startGame();
    else if (act === 'help') openHelp();
    else if (act === 'close-help') closeHelp();
    else if (act === 'menu' || act === 'quit') toMenu();
    else if (act === 'resume') resume();
    else if (act === 'ready') bowlPress();
    else if (act === 'bowl') bowlPress();
    else if (act === 'ff') { S.ff = S.ff > 1 ? 1 : 3; renderPad(); }
    else if (act === 'fastcpu') { S.fastCpu = true; renderPad(); }
    else if (act === 'next') { if (S.phase === 'result') S.resT = 0; }
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Aim, spin and hook through 10 frames — vs CPU or pass-and-play',
    icon: '🎳',
    tags: 'game,sport,fun,bowling,strike,spare,2 player,cpu,ten pin,pins,hook',
    open: open,
    _engine: ENGINE
  });
})();
