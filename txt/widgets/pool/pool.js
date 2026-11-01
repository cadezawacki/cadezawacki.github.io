/* Pool — 8-ball on an ASCII table, for Cade.txt.
 * A top-down table drawn in monospace glyphs (rails of = and |, felt dotted
 * with ·, diamonds, pockets); solids are full discs, stripes banded discs,
 * each with its number. Play vs the CPU (easy / normal / hard), pass-and-play
 * with two players on one device, or practise clearing a rack in as few
 * shots as you can.
 * Physics: a fixed 120 Hz step with adaptive substeps (no ball moves more
 * than a third of its radius per substep), elastic ball-ball collisions that
 * exchange the normal momentum (equal masses, restitution 0.95), cushions as
 * segments with rounded ends (so the pocket jaws rattle), rolling friction
 * plus a little drag, and basic spin: follow / draw act at the first contact
 * and wear off with time; side english kicks the cue ball along a cushion.
 * Rendering interpolates between steps, so it is smooth at 60 or 120 Hz.
 * Rules (simplified WPA 8-ball, no call-shot): break from behind the head
 * string; the table stays open after the break; the first legal pot claims
 * solids or stripes; fouls (scratch, no ball hit, wrong ball first, no rail
 * after contact) give ball in hand anywhere; the 8 wins once your group is
 * down — potted early, or with a scratch, it loses. The 8 on the break is
 * re-spotted.
 * The CPU picks a shot by geometry (ghost-ball aiming, clear lines, cut
 * angle, distance), checks its best few candidates by simulating them with
 * the same engine, then plays it with aim noise by difficulty.
 * The loop runs only while a game is on screen and something moves; it
 * pauses on blur, tab hide and minimize. Stats, settings and an unfinished
 * game persist in Cade.store (cade-pool-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World units: the playing surface is W × H (2:1), x → right, y → down.
  var W = 100, H = 50, R = 1.6, RAIL = 5.4;
  var STEP = 1 / 120;
  var FRIC = 19;                 // rolling resistance (u/s²)
  var DRAG = 0.1;                // extra speed-proportional loss (1/s)
  var E_BALL = 0.96, E_RAIL = 0.8;
  var MAXV = 165;                // cue ball speed at full power (u/s)
  var BREAK_X = 2.1;             // the break is struck harder (a full-power break crosses the table in a blink)
  var KF = 0.6, SPIN_T = 0.9;    // follow / draw strength and how fast it wears off (1/s)
  var KE = 0.32;                 // english kick at a cushion (fraction of the normal speed)
  var HEAD_X = W * 0.25, FOOT_X = W * 0.73;
  var CM = 5.3, SM = 3.9, JL = 2.9;  // corner mouth (along each rail), side mouth half-width, jaw length
  var SOLIDS = [1, 2, 3, 4, 5, 6, 7], STRIPES = [9, 10, 11, 12, 13, 14, 15];
  var DIFFS = ['easy', 'normal', 'hard'];

  // Pockets: where a ball drops (capture point + radius) and where to aim.
  var POCKETS = [
    { x: -0.5, y: -0.5, r: 3.1, ax: 1.0, ay: 1.0, side: false },
    { x: W / 2, y: -1.9, r: 2.6, ax: W / 2, ay: -0.4, side: true },
    { x: W + 0.5, y: -0.5, r: 3.1, ax: W - 1.0, ay: 1.0, side: false },
    { x: -0.5, y: H + 0.5, r: 3.1, ax: 1.0, ay: H - 1.0, side: false },
    { x: W / 2, y: H + 1.9, r: 2.6, ax: W / 2, ay: H + 0.4, side: true },
    { x: W + 0.5, y: H + 0.5, r: 3.1, ax: W - 1.0, ay: H - 1.0, side: false }
  ];
  // Cushions: segments with rounded ends; the short jaw segments lead into the pockets.
  var SEGS = (function () {
    var s = [], q = JL / Math.SQRT2;
    function seg(ax, ay, bx, by) { s.push({ ax: ax, ay: ay, bx: bx, by: by }); }
    [0, H].forEach(function (y) {
      var o = y === 0 ? -1 : 1;
      seg(CM, y, W / 2 - SM, y); seg(W / 2 + SM, y, W - CM, y);
      seg(CM, y, CM - q, y + o * q); seg(W - CM, y, W - CM + q, y + o * q);           // corner jaws
      seg(W / 2 - SM, y, W / 2 - SM + 0.6, y + o * 3); seg(W / 2 + SM, y, W / 2 + SM - 0.6, y + o * 3);  // side jaws
    });
    [0, W].forEach(function (x) {
      var o = x === 0 ? -1 : 1;
      seg(x, CM, x, H - CM);
      seg(x, CM, x + o * q, CM - q); seg(x, H - CM, x + o * q, H - CM + q);
    });
    return s;
  })();

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) { var u = r() || 1e-9, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function groupOf(n) { return n >= 1 && n <= 7 ? 'solid' : n >= 9 && n <= 15 ? 'stripe' : n === 8 ? 'eight' : 'cue'; }
  function other(gr) { return gr === 'solid' ? 'stripe' : 'solid'; }

  // ---- the rack ----
  function rackPositions() {
    var out = [], dx = 2 * R * Math.cos(Math.PI / 6) + 0.02, dy = 2 * R + 0.02;
    for (var r = 0; r < 5; r++) for (var i = 0; i <= r; i++) out.push({ x: FOOT_X + r * dx, y: H / 2 + (i - r / 2) * dy, r: r, i: i });
    return out;
  }
  function newBall(n, x, y) { return { n: n, x: x, y: y, vx: 0, vy: 0, px: x, py: y, on: true, roll: 0 }; }
  function makeRack(rnd) {
    var pos = rackPositions(), balls = [newBall(0, W * 0.2, H / 2)];
    var slots = new Array(15), rest = [];
    var solidFirst = rnd() < 0.5;
    // 8 in the middle of the third row, a solid and a stripe on the back corners
    slots[4] = 8;
    var s0 = SOLIDS[(rnd() * 7) | 0], t0 = STRIPES[(rnd() * 7) | 0];
    slots[10] = solidFirst ? s0 : t0; slots[14] = solidFirst ? t0 : s0;
    SOLIDS.concat(STRIPES).forEach(function (n) { if (n !== s0 && n !== t0) rest.push(n); });
    for (var i = rest.length - 1; i > 0; i--) { var j = (rnd() * (i + 1)) | 0, t = rest[i]; rest[i] = rest[j]; rest[j] = t; }
    for (var k = 0; k < 15; k++) if (slots[k] == null) slots[k] = rest.pop();
    for (k = 0; k < 15; k++) balls.push(newBall(slots[k], pos[k].x, pos[k].y));
    balls.sort(function (a, b) { return a.n - b.n; });
    return balls;
  }

  // ---- a game ----
  // mode: 'cpu' (player 1 vs the CPU), '2p' (pass and play), 'practice' (solo)
  function newGame(mode, opts) {
    opts = opts || {};
    var seed = (opts.seed >>> 0) || 1;
    var g = {
      mode: mode === 'cpu' || mode === '2p' ? mode : 'practice',
      diff: DIFFS.indexOf(opts.diff) >= 0 ? opts.diff : 'normal',
      seed: seed, rs: seed, balls: null,
      turn: opts.first === 1 && mode !== 'practice' ? 1 : 0, groups: [null, null],
      bih: 'kitchen', isBreak: true, phase: 'aim', winner: -1, reason: '',
      shots: [0, 0], pots: [0, 0], fouls: [0, 0], run: 0, bestRun: [0, 0], breakPots: 0,
      shot: null, last: null, t: 0, events: [], nshot: 0
    };
    var r = rng(seed);
    g.balls = makeRack(r);
    g.rs = (r() * 4294967295) >>> 0;
    g.firstBreaker = g.turn;
    return g;
  }
  function ball(g, n) { return g.balls[n]; }
  function remaining(g, gr) {
    var list = gr === 'solid' ? SOLIDS : STRIPES, c = 0;
    for (var i = 0; i < list.length; i++) if (g.balls[list[i]].on) c++;
    return c;
  }
  function objectsLeft(g) { var c = 0; for (var i = 1; i < 16; i++) if (g.balls[i].on) c++; return c; }
  // The balls player p may hit first.
  function legalTargets(g, p) {
    var out = [], i;
    if (g.mode === 'practice' || g.isBreak || !g.groups[p]) {
      for (i = 1; i < 16; i++) if (g.balls[i].on && (i !== 8 || g.mode === 'practice' || objectsLeft(g) === 1)) out.push(i);
      if (!out.length && g.balls[8].on) out.push(8);
      return out;
    }
    var list = g.groups[p] === 'solid' ? SOLIDS : STRIPES;
    for (i = 0; i < list.length; i++) if (g.balls[list[i]].on) out.push(list[i]);
    if (!out.length && g.balls[8].on) out.push(8);
    return out;
  }
  function onEight(g, p) { return !!g.groups[p] && remaining(g, g.groups[p]) === 0; }

  // Can the cue ball be put at (x, y)?
  function canPlace(g, x, y) {
    if (!g.bih) return false;
    if (x < R || x > W - R || y < R || y > H - R) return false;
    if (g.bih === 'kitchen' && x > HEAD_X) return false;
    for (var i = 1; i < 16; i++) {
      var b = g.balls[i];
      if (b.on && (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y) < 4 * R * R * 1.02) return false;
    }
    return true;
  }
  function placeCue(g, x, y) {
    if (!canPlace(g, x, y)) return false;
    var c = g.balls[0];
    c.x = c.px = x; c.y = c.py = y; c.on = true; c.vx = c.vy = 0;
    return true;
  }
  // A free spot near (x, y) for the cue ball (spiralling out), within the allowed region.
  function freeSpot(g, x, y) {
    for (var rr = 0; rr < 40; rr += 0.8) {
      for (var a = 0; a < 16; a++) {
        var px = x + Math.cos(a / 16 * Math.PI * 2) * rr, py = y + Math.sin(a / 16 * Math.PI * 2) * rr;
        if (canPlace(g, px, py)) return { x: px, y: py };
        if (!rr) break;
      }
    }
    return { x: R + 1, y: R + 1 };
  }
  // The 8 back on the foot spot (or the first free place behind it).
  function respot(g, n) {
    var b = g.balls[n];
    for (var x = FOOT_X; x < W - R; x += 0.5) {
      var ok = true;
      for (var i = 0; i < 16; i++) {
        var o = g.balls[i];
        if (i !== n && o.on && (o.x - x) * (o.x - x) + (o.y - H / 2) * (o.y - H / 2) < 4 * R * R * 1.02) { ok = false; break; }
      }
      if (ok) { b.x = b.px = x; b.y = b.py = H / 2; break; }
    }
    b.on = true; b.vx = b.vy = 0;
  }

  // ---- shooting ----
  // angle (rad, 0 = +x), power 0..1, spin: follow (+) / draw (−) and english right (+) / left (−), each −1..1.
  function shoot(g, angle, power, fol, eng) {
    if (g.phase !== 'aim' || !g.balls[0].on) return false;
    power = clamp(+power || 0, 0, 1);
    var v = (3 + (MAXV - 3) * Math.pow(power, 1.15)) * (g.isBreak ? BREAK_X : 1), c = g.balls[0];
    c.vx = Math.cos(angle) * v; c.vy = Math.sin(angle) * v;
    var rem = [g.groups[0] ? remaining(g, g.groups[0]) : -1, g.groups[1] ? remaining(g, g.groups[1]) : -1];
    g.shot = {
      p: g.turn, angle: angle, power: power, v: v, fol: clamp(+fol || 0, -1, 1), eng: clamp(+eng || 0, -1, 1),
      first: 0, pots: [], railAfter: false, railBalls: {}, nRail: 0, rem: rem, open: !g.groups[g.turn], brk: g.isBreak,
      eight: onEight(g, g.turn), t: 0
    };
    g.bih = null;
    g.phase = 'roll'; g.t = 0; g.nshot++;
    g.events.push({ k: 'cue', v: v });
    return true;
  }
  function moving(g) {
    for (var i = 0; i < 16; i++) { var b = g.balls[i]; if (b.on && (b.vx || b.vy)) return true; }
    return false;
  }
  function railHit(g, b, n, vn) {
    var sh = g.shot;
    if (sh && b.n === 0 && sh.eng) {
      // side english: the cushion pushes the cue ball along it (right english → its right)
      var k = sh.eng * KE * vn;
      b.vx += n.y * k; b.vy += -n.x * k;
      sh.eng *= 0.55;
    }
    if (sh) {
      if (sh.first || b.n !== 0) sh.railAfter = sh.railAfter || !!sh.first;
      if (b.n && !sh.railBalls[b.n]) { sh.railBalls[b.n] = 1; sh.nRail++; }
    }
    if (vn > 4) g.events.push({ k: 'rail', v: vn, x: b.x, y: b.y });
  }
  var NV = { x: 0, y: 0 };
  function substep(g, dt) {
    var bs = g.balls, i, j, b, sh = g.shot;
    for (i = 0; i < 16; i++) {
      b = bs[i];
      if (!b.on || (!b.vx && !b.vy)) continue;
      b.x += b.vx * dt; b.y += b.vy * dt;
      var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      b.roll += sp * dt / R;
      var dec = (FRIC + DRAG * sp) * dt;
      if (sp <= dec) { b.vx = 0; b.vy = 0; }
      else { var f = (sp - dec) / sp; b.vx *= f; b.vy *= f; }
    }
    // ball ↔ ball
    for (i = 0; i < 16; i++) {
      var a = bs[i];
      if (!a.on) continue;
      for (j = i + 1; j < 16; j++) {
        b = bs[j];
        if (!b.on) continue;
        var dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 >= 4 * R * R || d2 === 0) continue;
        var d = Math.sqrt(d2), nx = dx / d, ny = dy / d, ov = (2 * R - d) / 2;
        a.x -= nx * ov; a.y -= ny * ov; b.x += nx * ov; b.y += ny * ov;
        var vrel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (vrel <= 0) continue;
        var cue = i === 0 ? a : null, pre = 0, dirx = 0, diry = 0;
        if (cue && sh && !sh.first) {
          sh.first = b.n;
          pre = Math.sqrt(a.vx * a.vx + a.vy * a.vy);
          if (pre) { dirx = a.vx / pre; diry = a.vy / pre; }
        }
        var J = (1 + E_BALL) / 2 * vrel;
        a.vx -= J * nx; a.vy -= J * ny; b.vx += J * nx; b.vy += J * ny;
        if (pre && sh.brk) { a.vx *= 0.45; a.vy *= 0.45; }   // a break is struck low and firm: the cue ball stays near the middle
        if (pre && sh.fol) {
          // follow / draw: the spin left on the cue ball grips the cloth after the hit
          var fe = sh.fol * Math.exp(-SPIN_T * sh.t) * KF * pre;
          a.vx += dirx * fe; a.vy += diry * fe;
        }
        if (vrel > 3) g.events.push({ k: 'ball', v: vrel, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      }
    }
    // cushions
    for (i = 0; i < 16; i++) {
      b = bs[i];
      if (!b.on) continue;
      if (b.x > R + 0.01 && b.x < W - R - 0.01 && b.y > R + 0.01 && b.y < H - R - 0.01) continue;  // nowhere near a rail
      for (j = 0; j < SEGS.length; j++) {
        var s = SEGS[j], sx = s.bx - s.ax, sy = s.by - s.ay;
        var t = clamp(((b.x - s.ax) * sx + (b.y - s.ay) * sy) / (sx * sx + sy * sy), 0, 1);
        var qx = b.x - (s.ax + sx * t), qy = b.y - (s.ay + sy * t), q2 = qx * qx + qy * qy;
        if (q2 >= R * R || q2 === 0) continue;
        var qd = Math.sqrt(q2);
        NV.x = qx / qd; NV.y = qy / qd;
        b.x += NV.x * (R - qd); b.y += NV.y * (R - qd);
        var vn = b.vx * NV.x + b.vy * NV.y;
        if (vn >= 0) continue;
        b.vx -= (1 + E_RAIL) * vn * NV.x; b.vy -= (1 + E_RAIL) * vn * NV.y;
        // a little grip along the cushion
        var tx = -NV.y, ty = NV.x, vt = b.vx * tx + b.vy * ty, lose = Math.min(Math.abs(vt), -vn * 0.12) * (vt < 0 ? -1 : 1);
        b.vx -= tx * lose; b.vy -= ty * lose;
        railHit(g, b, NV, -vn);
      }
    }
    // pockets
    for (i = 0; i < 16; i++) {
      b = bs[i];
      if (!b.on) continue;
      var out = b.x < -2.5 || b.x > W + 2.5 || b.y < -2.5 || b.y > H + 2.5, pk = -1, best = 1e9;
      for (j = 0; j < 6; j++) {
        var P = POCKETS[j], ex = b.x - P.x, ey = b.y - P.y, e2 = ex * ex + ey * ey;
        if (e2 < P.r * P.r || (out && e2 < best)) { pk = j; best = e2; if (!out) break; }
      }
      if (pk >= 0) {
        var spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        b.on = false; b.vx = b.vy = 0; b.x = POCKETS[pk].x; b.y = POCKETS[pk].y;
        if (sh) sh.pots.push(b.n);
        g.events.push({ k: 'pot', n: b.n, p: pk, v: spd });
      }
    }
    if (sh) sh.t += dt;
  }
  // One fixed step; resolves the shot when everything has stopped.
  function step(g) {
    if (g.phase !== 'roll') return;
    var bs = g.balls, mv = 0, i;
    for (i = 0; i < 16; i++) {
      var b = bs[i];
      b.px = b.x; b.py = b.y;
      if (b.on) mv = Math.max(mv, Math.abs(b.vx) + Math.abs(b.vy));
    }
    var n = clamp(Math.ceil(mv * STEP / (R * 0.33)), 1, 16), dt = STEP / n;
    for (i = 0; i < n; i++) substep(g, dt);
    g.t += STEP;
    if (!moving(g) || g.t > 40) {
      for (i = 0; i < 16; i++) { bs[i].vx = bs[i].vy = 0; }
      resolve(g);
    }
  }
  // Advance real time dt with the fixed step; returns the render interpolation alpha.
  function advance(g, acc, dt) {
    acc.t += dt;
    var n = 0;
    while (acc.t >= STEP && n < 24) { acc.t -= STEP; step(g); n++; if (g.phase !== 'roll') { acc.t = 0; return 1; } }
    if (n >= 24) acc.t = 0;
    return clamp(acc.t / STEP, 0, 1);
  }

  // ---- the rules ----
  function resolve(g) {
    var sh = g.shot, p = sh.p, o = 1 - p, res = { p: p, foul: null, cont: false, win: -1, msgs: [], legal: 0, assigned: null, respot: false };
    var pots = sh.pots, cueIn = pots.indexOf(0) >= 0, eightIn = pots.indexOf(8) >= 0;
    var obj = pots.filter(function (n) { return n !== 0 && n !== 8; });
    g.shots[p]++;
    if (g.mode === 'practice') {
      if (cueIn) { res.foul = 'scratch'; g.fouls[0]++; }
      g.pots[0] += obj.length + (eightIn ? 1 : 0);
      res.legal = obj.length + (eightIn ? 1 : 0);
      res.cont = true;
      afterShot(g, res, cueIn);
      if (!objectsLeft(g)) { g.phase = 'over'; g.winner = 0; g.reason = 'cleared'; res.win = 0; }
      g.last = res;
      return res;
    }
    // what the shooter had to hit first
    var need;
    if (sh.brk) need = null;
    else if (sh.open) need = 'open';
    else need = sh.rem[p] === 0 ? 'eight' : g.groups[p];
    if (cueIn) res.foul = 'scratch';
    else if (!sh.first) res.foul = 'miss';
    else if (need === 'open' && sh.first === 8) res.foul = 'wrong';
    else if (need && need !== 'open' && groupOf(sh.first) !== need) res.foul = 'wrong';
    else if (!pots.length && !sh.railAfter && !sh.brk) res.foul = 'rail';
    if (res.foul) g.fouls[p]++;
    // the 8
    if (eightIn) {
      if (sh.brk) { respot(g, 8); res.respot = true; }
      else {
        var cleared = !sh.open && sh.rem[p] === 0;
        if (cleared && !res.foul) { res.win = p; g.reason = 'eight'; }
        else { res.win = o; g.reason = !cleared ? 'early8' : 'scratch8'; }
      }
    }
    // groups: the first legal pot on an open table (never on the break)
    if (sh.open && !sh.brk && !res.foul && obj.length && res.win < 0) {
      var gr = groupOf(obj[0]);
      g.groups[p] = gr; g.groups[o] = other(gr);
      res.assigned = gr;
    }
    var own = g.groups[p];
    res.legal = obj.filter(function (n) { return sh.open || sh.brk ? true : groupOf(n) === own; }).length;
    if (!res.foul && res.win < 0) res.cont = res.legal > 0;
    g.pots[p] += obj.filter(function (n) { return !own || groupOf(n) === own; }).length;
    if (sh.brk) g.breakPots = obj.length;
    if (res.win >= 0) {
      g.phase = 'over'; g.winner = res.win;
      if (!cueIn) { g.last = res; g.run = res.cont ? g.run + res.legal : 0; g.bestRun[p] = Math.max(g.bestRun[p], g.run); return res; }
    }
    afterShot(g, res, cueIn);
    g.last = res;
    return res;
  }
  function afterShot(g, res, cueIn) {
    var p = res.p;
    if (res.cont && !res.foul) { g.run += res.legal; g.bestRun[p] = Math.max(g.bestRun[p], g.run); }
    else if (g.mode !== 'practice') g.run = 0;
    if (g.mode === 'practice') { g.run = res.foul ? 0 : g.run; }
    g.isBreak = false;
    if (g.phase === 'over') { if (cueIn) { var c0 = g.balls[0]; c0.on = true; var s0 = freeSpot(g, HEAD_X, H / 2); c0.x = c0.px = s0.x; c0.y = c0.py = s0.y; } return; }
    g.phase = 'aim';
    if (res.foul) {
      if (g.mode !== 'practice') g.turn = 1 - p;
      g.bih = 'table';
      var c = g.balls[0];
      if (cueIn) {
        c.on = true;
        var sp = freeSpot(g, HEAD_X, H / 2);
        c.x = c.px = sp.x; c.y = c.py = sp.y; c.vx = c.vy = 0;
      }
    } else if (!res.cont && g.mode !== 'practice') g.turn = 1 - p;
    g.shot = null;
  }

  // ---- geometry for the guide and the CPU ----
  // Cast the cue ball from (x, y) along angle: first ball it would touch (ghost centre) or the cushion.
  function castAim(g, x, y, ang) {
    var dx = Math.cos(ang), dy = Math.sin(ang), best = 1e9, hit = 0, i;
    for (i = 1; i < 16; i++) {
      var b = g.balls[i];
      if (!b.on) continue;
      var fx = b.x - x, fy = b.y - y, t = fx * dx + fy * dy;
      if (t <= 0) continue;
      var c2 = fx * fx + fy * fy - t * t, rr = 4 * R * R;
      if (c2 > rr) continue;
      var d = t - Math.sqrt(rr - c2);
      if (d < best && d >= -0.01) { best = Math.max(0, d); hit = i; }
    }
    // the cushion lines the centre can reach
    var tw = 1e9;
    if (dx > 0) tw = Math.min(tw, (W - R - x) / dx); else if (dx < 0) tw = Math.min(tw, (R - x) / dx);
    if (dy > 0) tw = Math.min(tw, (H - R - y) / dy); else if (dy < 0) tw = Math.min(tw, (R - y) / dy);
    tw = Math.max(0, tw);
    if (hit && best <= tw) {
      var gx = x + dx * best, gy = y + dy * best, b2 = g.balls[hit], nx = b2.x - gx, ny = b2.y - gy, nl = Math.sqrt(nx * nx + ny * ny) || 1;
      nx /= nl; ny /= nl;
      var dot = dx * nx + dy * ny, tx = dx - dot * nx, ty = dy - dot * ny;
      return { ball: hit, d: best, gx: gx, gy: gy, ox: nx, oy: ny, cut: Math.acos(clamp(dot, -1, 1)), tx: tx, ty: ty };
    }
    return { ball: 0, d: tw, gx: x + dx * tw, gy: y + dy * tw };
  }
  // Is the straight path of a ball centre from A to B clear of every on-table ball (except the listed)?
  function clearPath(g, ax, ay, bx, by, skipA, skipB) {
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
    for (var i = 0; i < 16; i++) {
      if (i === skipA || i === skipB) continue;
      var b = g.balls[i];
      if (!b.on) continue;
      var t = clamp(((b.x - ax) * dx + (b.y - ay) * dy) / l2, 0, 1);
      var qx = ax + dx * t - b.x, qy = ay + dy * t - b.y;
      if (qx * qx + qy * qy < 4 * R * R * 0.98) return false;
    }
    return true;
  }
  // Every direct pot for player p from the cue ball at (cx, cy): target, pocket, aim angle, difficulty score.
  function findShots(g, p, cx, cy) {
    var c = g.balls[0], out = [];
    if (cx == null) { cx = c.x; cy = c.y; }
    var tg = legalTargets(g, p);
    for (var k = 0; k < tg.length; k++) {
      var b = g.balls[tg[k]];
      for (var j = 0; j < 6; j++) {
        var P = POCKETS[j], px = P.ax - b.x, py = P.ay - b.y, d2 = Math.sqrt(px * px + py * py);
        if (d2 < 0.5) continue;
        px /= d2; py /= d2;
        if (P.side && Math.abs(py) < 0.42) continue;          // too shallow into a side pocket
        if (!P.side && (px * (P.ax < W / 2 ? -1 : 1) < 0.17 || py * (P.ay < H / 2 ? -1 : 1) < 0.17)) continue;  // along the rail away
        var gx = b.x - px * 2 * R, gy = b.y - py * 2 * R;
        var ax = gx - cx, ay = gy - cy, d1 = Math.sqrt(ax * ax + ay * ay);
        if (d1 < 0.3) continue;
        var cs = (ax * px + ay * py) / d1;
        if (cs < 0.2) continue;                                // a cut thinner than ~78°
        if (!clearPath(g, cx, cy, gx, gy, 0, b.n) || !clearPath(g, b.x, b.y, P.ax, P.ay, b.n, 0)) continue;
        if (gx < R * 0.6 || gx > W - R * 0.6 || gy < R * 0.6 || gy > H - R * 0.6) continue;
        var score = cs * cs / (1 + d1 / 90 + d2 / 55) * (P.side ? 0.85 : 1);
        out.push({ ball: b.n, pocket: j, angle: Math.atan2(ay, ax), cut: Math.acos(clamp(cs, -1, 1)), d1: d1, d2: d2, score: score, cs: cs });
      }
    }
    out.sort(function (a, b2) { return b2.score - a.score; });
    return out;
  }
  // Power for a pot: enough for the object ball to reach the pocket with some to spare.
  function potPower(s, extra) {
    var vo = Math.sqrt(2 * FRIC * (s.d2 + 10 + (extra || 0))) * 1.35 + 4;
    var vc = vo / Math.max(0.25, s.cs * 0.975);
    var v0 = Math.sqrt(vc * vc + 2 * FRIC * s.d1) * 1.12 + s.d1 * DRAG;
    return clamp(Math.pow(clamp((v0 - 3) / (MAXV - 3), 0, 1), 1 / 1.15), 0.12, 1);
  }

  // ---- simulation (for the CPU and the tests) ----
  function cloneGame(g) {
    var c = JSON.parse(JSON.stringify(g));
    c.events = [];
    return c;
  }
  function simulate(g, plan, maxT) {
    var c = cloneGame(g);
    if (plan.place) placeCue(c, plan.place.x, plan.place.y);
    if (!shoot(c, plan.angle, plan.power, plan.fol || 0, plan.eng || 0)) return c;
    var lim = Math.ceil((maxT || 30) / STEP);
    for (var i = 0; i < lim && c.phase === 'roll'; i++) { step(c); c.events.length = 0; }
    return c;
  }
  // How good a position is for player p (0..~1.5): the best direct pot available.
  function posValue(g, p) {
    var s = findShots(g, p);
    if (!s.length) return 0;
    return s[0].score + (s[1] ? s[1].score * 0.3 : 0);
  }
  function judge(g0, g1, p) {
    var L = g1.last;
    if (!L) return -50;
    if (g1.phase === 'over') return g1.winner === p ? 1000 : -1000;
    if (L.foul) return -300 - posValue(g1, 1 - p) * 20;
    if (g1.turn === p && g0.mode !== 'practice') return 200 + L.legal * 10 + posValue(g1, p) * 120;
    if (g0.mode === 'practice') return L.legal * 200 + posValue(g1, p) * 120;
    return -posValue(g1, 1 - p) * 120;   // safety: leave them nothing
  }
  var LEVEL = {
    easy: { noise: 0.026, pnoise: 0.12, cand: 3, sims: 1, pick: 3 },
    normal: { noise: 0.0095, pnoise: 0.06, cand: 6, sims: 2, pick: 1 },
    hard: { noise: 0.0032, pnoise: 0.025, cand: 10, sims: 4, pick: 1 }
  };
  // Choose where to put the cue ball (ball in hand): the spot that leaves the best pot.
  function cpuPlace(g, p, rnd) {
    var best = null, bs = -1, tg = legalTargets(g, p), kitchen = g.bih === 'kitchen';
    if (g.isBreak) return { x: W * 0.2, y: H / 2 + (rnd() - 0.5) * 8 };
    for (var k = 0; k < tg.length; k++) {
      var b = g.balls[tg[k]];
      for (var j = 0; j < 6; j++) {
        var P = POCKETS[j], px = P.ax - b.x, py = P.ay - b.y, l = Math.sqrt(px * px + py * py) || 1;
        px /= l; py /= l;
        for (var dd = 7; dd <= 25; dd += 6) for (var off = -0.35; off <= 0.36; off += 0.35) {
          var ca = Math.cos(off), sa = Math.sin(off), qx = px * ca - py * sa, qy = px * sa + py * ca;
          var x = b.x - px * 2 * R - qx * dd, y = b.y - py * 2 * R - qy * dd;
          if (!canPlace(g, x, y)) continue;
          var s = findShots(g, p, x, y);
          var v = s.length ? s[0].score + (s[1] ? 0.2 * s[1].score : 0) : 0;
          if (v > bs) { bs = v; best = { x: x, y: y }; }
        }
      }
    }
    if (!best) best = freeSpot(g, kitchen ? W * 0.15 : W / 2, H / 2 + (rnd() - 0.5) * 10);
    return best;
  }
  // The CPU's shot: { place?, angle, power, fol, eng, aimed (before noise) }.
  function cpuPlan(g, p, level, seed) {
    var L = LEVEL[level] || LEVEL.normal, rnd = rng(seed >>> 0 || 7), place = null, i;
    var work = g;
    if (g.bih) {
      place = cpuPlace(g, p, rnd);
      work = cloneGame(g); placeCue(work, place.x, place.y);
    }
    var c = work.balls[0], plan;
    if (g.isBreak) {
      var apex = work.balls.filter(function (b) { return b.n && b.on; }).sort(function (a, b) { return a.x - b.x; })[0];
      plan = { angle: Math.atan2(apex.y - c.y, apex.x - c.x) + gauss(rnd) * 0.004, power: 0.9 + rnd() * 0.1, fol: 0.2, eng: 0 };
    } else {
      var shots = findShots(work, p).slice(0, L.cand), cands = [];
      shots.forEach(function (s) {
        var pw = potPower(s);
        var vars = L.sims === 1 ? [[pw, 0]] : L.sims === 2 ? [[pw, 0], [Math.min(1, pw * 1.3), 0.3]] :
          [[pw, 0], [Math.min(1, pw * 1.35), 0.4], [Math.min(1, pw * 1.1), -0.5], [Math.min(1, pw * 0.85), 0]];
        vars.forEach(function (vv) { cands.push({ angle: s.angle, power: vv[0], fol: vv[1], eng: 0, base: s.score }); });
      });
      if (!cands.length) {
        // no pot on: a safety — hit a legal ball fully, softly, and keep away from fouls
        // Fan across each legal ball (full to thin contact) and keep the angles whose first contact is that ball.
        var tg = legalTargets(work, p), fan = [0, -0.35, 0.35, -0.7, 0.7, -0.9, 0.9];
        for (i = 0; i < tg.length; i++) {
          var b = work.balls[tg[i]], bd = Math.hypot(b.x - c.x, b.y - c.y) || 1;
          var a0 = Math.atan2(b.y - c.y, b.x - c.x), span = Math.asin(Math.min(1, 2 * R * 0.97 / bd));
          for (var f = 0; f < fan.length; f++) {
            var af = a0 + fan[f] * span;
            if (castAim(work, c.x, c.y, af).ball !== b.n) continue;
            cands.push({ angle: af, power: 0.32, fol: 0, eng: 0, base: 0 });
            cands.push({ angle: af, power: 0.5, fol: 0, eng: 0, base: 0 });
            break;
          }
        }
        if (!cands.length) {
          // snookered: one-cushion kicks (aim at the target mirrored in each rail), then a sweep
          for (i = 0; i < tg.length; i++) {
            var tb = work.balls[tg[i]];
            [[2 * R - tb.x, tb.y], [2 * (W - R) - tb.x, tb.y], [tb.x, 2 * R - tb.y], [tb.x, 2 * (H - R) - tb.y]].forEach(function (m) {
              cands.push({ angle: Math.atan2(m[1] - c.y, m[0] - c.x), power: 0.6, fol: 0, eng: 0, base: 0 });
            });
          }
          for (i = 0; i < 12; i++) cands.push({ angle: i / 12 * Math.PI * 2 + rnd() * 0.1, power: 0.55, fol: 0, eng: 0, base: 0 });
        }
        if (cands.length > 24) cands = cands.slice(0, 24);
      }
      cands.forEach(function (cd) {
        var r1 = simulate(work, cd, 25);
        cd.val = judge(work, r1, p) + cd.base * 10;
      });
      cands.sort(function (a, b2) { return b2.val - a.val; });
      // easy picks loosely among its best few, but never a planned foul when a clean shot exists
      var ok = 1;
      while (ok < cands.length && ok < L.pick && cands[ok].val > -250) ok++;
      var pick = L.pick > 1 ? (rnd() * ok) | 0 : 0;
      plan = cands[pick];
    }
    var out = {
      place: place, aimed: plan.angle,
      angle: plan.angle + gauss(rnd) * L.noise,
      power: clamp(plan.power * (1 + gauss(rnd) * L.pnoise), 0.08, 1),
      fol: plan.fol || 0, eng: plan.eng || 0
    };
    return out;
  }

  // ---- saves: settings, stats, an unfinished game ----
  function newStats() {
    return {
      cpu: { easy: { w: 0, l: 0 }, normal: { w: 0, l: 0 }, hard: { w: 0, l: 0 } },
      duo: { games: 0, p1: 0, p2: 0 }, prac: { racks: 0, best: 0 },
      shots: 0, pots: 0, fouls: 0, bestRun: 0, bestBreak: 0, streak: 0, bestStreak: 0
    };
  }
  function num(v, lo, hi) { v = Math.floor(+v); return isFinite(v) ? clamp(v, lo, hi) : lo; }
  function normStats(o) {
    var s = newStats(), M = 1e9;
    if (!o || typeof o !== 'object') return s;
    DIFFS.forEach(function (d) { var c = o.cpu && o.cpu[d]; if (c) { s.cpu[d].w = num(c.w, 0, M); s.cpu[d].l = num(c.l, 0, M); } });
    if (o.duo) { s.duo.games = num(o.duo.games, 0, M); s.duo.p1 = num(o.duo.p1, 0, M); s.duo.p2 = num(o.duo.p2, 0, M); }
    if (o.prac) { s.prac.racks = num(o.prac.racks, 0, M); s.prac.best = num(o.prac.best, 0, M); }
    ['shots', 'pots', 'fouls', 'bestRun', 'bestBreak', 'streak', 'bestStreak'].forEach(function (k) { s[k] = num(o[k], 0, M); });
    return s;
  }
  // Fold a finished game into the stats; returns which records it set.
  function recordGame(st, g) {
    var rec = {}, human = g.mode === 'cpu' ? [0] : g.mode === '2p' ? [0, 1] : [0];
    human.forEach(function (p) {
      st.shots += g.shots[p]; st.pots += g.pots[p]; st.fouls += g.fouls[p];
      if (g.bestRun[p] > st.bestRun) { st.bestRun = g.bestRun[p]; rec.run = true; }
    });
    if (g.breakPots > st.bestBreak && (g.mode !== 'cpu' || g.firstBreaker === 0)) { st.bestBreak = g.breakPots; rec.brk = true; }
    if (g.mode === 'cpu') {
      var c = st.cpu[g.diff] || st.cpu.normal;
      if (g.winner === 0) { c.w++; st.streak++; if (st.streak > st.bestStreak) { st.bestStreak = st.streak; rec.streak = true; } }
      else { c.l++; st.streak = 0; }
    } else if (g.mode === '2p') {
      st.duo.games++; if (g.winner === 0) st.duo.p1++; else st.duo.p2++;
    } else if (g.phase === 'over' && g.winner === 0) {
      st.prac.racks++;
      if (!st.prac.best || g.shots[0] < st.prac.best) { st.prac.best = g.shots[0]; rec.prac = true; }
    }
    return rec;
  }
  function normSettings(o) {
    var s = { diff: 'normal', guide: 'full', mode: 'cpu' };
    if (!o || typeof o !== 'object') return s;
    if (DIFFS.indexOf(o.diff) >= 0) s.diff = o.diff;
    if (['full', 'short', 'off'].indexOf(o.guide) >= 0) s.guide = o.guide;
    if (['cpu', '2p', 'practice'].indexOf(o.mode) >= 0) s.mode = o.mode;
    return s;
  }
  // An unfinished game from storage: everything checked, or null.
  function normGame(o) {
    if (!o || typeof o !== 'object' || !Array.isArray(o.balls) || o.balls.length !== 16) return null;
    var g = newGame(o.mode, { diff: o.diff, seed: o.seed });
    for (var i = 0; i < 16; i++) {
      var b = o.balls[i], d = g.balls[i];
      if (!b || typeof b !== 'object') return null;
      d.on = !!b.on;
      if (d.on) {
        if (!isFinite(+b.x) || !isFinite(+b.y)) return null;
        d.x = d.px = clamp(+b.x, R, W - R); d.y = d.py = clamp(+b.y, R, H - R);
      }
    }
    if (!g.balls[0].on) g.balls[0].on = true;
    if (!objectsLeft(g)) return null;
    g.turn = o.turn === 1 && g.mode !== 'practice' ? 1 : 0;
    var gr = Array.isArray(o.groups) ? o.groups : [];
    if ((gr[0] === 'solid' || gr[0] === 'stripe') && gr[1] === other(gr[0])) g.groups = [gr[0], gr[1]];
    g.bih = o.bih === 'kitchen' || o.bih === 'table' ? o.bih : null;
    g.isBreak = !!o.isBreak && objectsLeft(g) === 15;
    if (g.isBreak && !g.bih) g.bih = 'kitchen';
    if (g.bih && !canPlace(g, g.balls[0].x, g.balls[0].y)) { var sp = freeSpot(g, HEAD_X * 0.8, H / 2); g.balls[0].x = g.balls[0].px = sp.x; g.balls[0].y = g.balls[0].py = sp.y; }
    ['shots', 'pots', 'fouls', 'bestRun'].forEach(function (k) { if (Array.isArray(o[k])) g[k] = [num(o[k][0], 0, 1e6), num(o[k][1], 0, 1e6)]; });
    g.run = num(o.run, 0, 15); g.breakPots = num(o.breakPots, 0, 15); g.nshot = num(o.nshot, 0, 1e6);
    g.rs = (o.rs >>> 0) || g.rs; g.firstBreaker = o.firstBreaker === 1 ? 1 : 0;
    return g;
  }
  function saveGame(g) {
    if (!g || g.phase !== 'aim') return null;
    return {
      mode: g.mode, diff: g.diff, seed: g.seed, rs: g.rs, turn: g.turn, groups: g.groups, bih: g.bih, isBreak: g.isBreak,
      balls: g.balls.map(function (b) { return { on: b.on, x: +b.x.toFixed(3), y: +b.y.toFixed(3) }; }),
      shots: g.shots, pots: g.pots, fouls: g.fouls, bestRun: g.bestRun, run: g.run, breakPots: g.breakPots, nshot: g.nshot, firstBreaker: g.firstBreaker
    };
  }

  var ENGINE = {
    W: W, H: H, R: R, RAIL: RAIL, STEP: STEP, MAXV: MAXV, HEAD_X: HEAD_X, FOOT_X: FOOT_X, POCKETS: POCKETS, SEGS: SEGS,
    SOLIDS: SOLIDS, STRIPES: STRIPES, DIFFS: DIFFS, LEVEL: LEVEL,
    rng: rng, groupOf: groupOf, rackPositions: rackPositions, makeRack: makeRack, newGame: newGame, ball: ball,
    remaining: remaining, objectsLeft: objectsLeft, legalTargets: legalTargets, onEight: onEight,
    canPlace: canPlace, placeCue: placeCue, freeSpot: freeSpot, respot: respot, shoot: shoot, moving: moving,
    substep: substep, step: step, advance: advance, resolve: resolve, castAim: castAim, clearPath: clearPath,
    findShots: findShots, potPower: potPower, cloneGame: cloneGame, simulate: simulate, posValue: posValue, judge: judge,
    cpuPlace: cpuPlace, cpuPlan: cpuPlan, newStats: newStats, normStats: normStats, recordGame: recordGame,
    normSettings: normSettings, normGame: normGame, saveGame: saveGame
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('pool.css');

  var PANEL_ID = 'pool-panel', NAME = 'Pool';
  var KEY = 'cade-pool-', STATS_KEY = KEY + 'stats', SET_KEY = KEY + 'settings', GAME_KEY = KEY + 'game', SOUND_KEY = KEY + 'sound';
  var TW = W + 2 * RAIL, TH = H + 2 * RAIL;
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.pool = { live: function () { return S; } };   // test-only peek

  // fixed ball colours (tuned per theme in readTheme)
  var BALL_L = ['#f7f4ec', '#e2a908', '#2b5fcf', '#d23a2c', '#7440b3', '#ea7317', '#178a46', '#8a2525', '#1b1b1d'];
  var BALL_D = ['#f4f1ea', '#f0bf2a', '#4f83f0', '#ee5546', '#9d6be0', '#ff8c33', '#2fae62', '#b64040', '#121214'];
  function baseCol(n) { return n === 0 ? 0 : n === 8 ? 8 : n > 8 ? n - 8 : n; }

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { if (Cade.store.remove) Cade.store.remove(k); else Cade.store.set(k, ''); } catch (e) {} }
  function sjson(k) { var r = sget(k); if (!r) return null; try { return JSON.parse(r); } catch (e) { return null; } }
  function persistStats() { if (S) sset(STATS_KEY, JSON.stringify(S.st)); }
  function persistSet() { if (S) sset(SET_KEY, JSON.stringify(S.set)); }
  function persistGame() {
    if (!S || !S.g) return;
    var o = saveGame(S.g);
    if (o) sset(GAME_KEY, JSON.stringify(o));
  }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }

  // ---- sound: a tiny WebAudio voice, created on a user gesture (iOS), closed with the panel ----
  function Snd(on) { this.on = !!on; this.ac = null; this.lastClick = 0; }
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
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.click = function (v) {
    if (!this.on || !this.ac) return;
    var now = this.ac.currentTime;
    if (now - this.lastClick < 0.025) return;
    this.lastClick = now;
    var vol = clamp(v / 160, 0.008, 0.07);
    this.tone(2400 + Math.random() * 500, 0.035, 'triangle', vol, 1400);
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
    var green = dark ? [52, 160, 92] : [38, 134, 72], wood = dark ? [196, 140, 84] : [138, 88, 44];
    S.dark = dark;
    S.pal = {
      bg: css(bg), text: css(tx), muted: css(mu), faint: css(fa), acc: css(ac), acc2: css(ac, 0.35),
      felt: css(mix(bg, green, dark ? 0.2 : 0.17)), dot: css(mix(bg, green, dark ? 0.36 : 0.36)),
      line: css(mix(bg, green, dark ? 0.55 : 0.55)), cush: css(mix(bg, green, dark ? 0.32 : 0.34)),
      rail: css(mix(bg, wood, dark ? 0.24 : 0.2)), railG: css(mix(bg, wood, dark ? 0.6 : 0.62)), dia: css(mix(bg, tx, dark ? 0.75 : 0.7)),
      pocket: dark ? '#050506' : '#26221e', pocketIn: dark ? '#000' : '#0d0b0a',
      red: dark ? '#f06a6a' : '#cf3f3f', gold: dark ? '#f2c544' : '#b07d06',
      shadow: dark ? 'rgba(0,0,0,0.45)' : 'rgba(20,40,20,0.22)',
      cueTip: css(mix(bg, [70, 120, 190], 0.8)), shaft: dark ? '#e7d3ad' : '#d8bb85', butt: dark ? '#8a5a35' : '#6b4122',
      ball: dark ? BALL_D : BALL_L, ring: dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'
    };
    S.font = (v('--font-mono') || '').trim() || 'ui-monospace, monospace';
    buildSprites();
    buildTable();
  }

  // ---- layout / coordinates ----
  // Landscape: the table as is. Narrow portrait screens turn it a quarter turn (the head string at the bottom).
  function sx(x, y) { return S.vert ? (y + RAIL) * S.s : (x + RAIL) * S.s; }
  function sy(x, y) { return S.vert ? (W + RAIL - x) * S.s : (y + RAIL) * S.s; }
  function toWorld(X, Y) { return S.vert ? { x: W + RAIL - Y / S.s, y: X / S.s - RAIL } : { x: X / S.s - RAIL, y: Y / S.s - RAIL }; }
  function availH(vh) {
    var r = S.panel.getBoundingClientRect();
    var chrome = r.height - (S.stage.offsetHeight || 0);
    if (!r.height) chrome = 190;
    if (S.panel.classList.contains('cade-solo-panel')) {
      var hd = S.panel.querySelector('.cade-panel-head');
      chrome = (hd ? hd.offsetHeight : 40) + (S.pad.offsetHeight || 56) + (S.hud.offsetHeight || 30) + 44;
    }
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 10;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    S.vert = phone && vh > vw * 1.15;
    var ah = Math.max(200, availH(vh)), aw = vw - (phone ? 34 : 48);
    var lw = S.vert ? TH : TW, lh = S.vert ? TW : TH;
    var s = Math.min(aw / lw, ah / lh, solo ? 12 : 6.6);
    s = Math.max(s, S.vert ? 3.2 : vh < 500 ? 2.4 : 3.6);   // a phone on its side: shrink rather than spill
    S.s = s;
    var cw = Math.floor(lw * s), ch = Math.floor(lh * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cw = cw; S.ch = ch; S.dpr = dpr;
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--pl-w', Math.max(cw, phone ? 0 : 340) + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    S.panel.classList.toggle('pl-vert', S.vert);
    if (S.pal) { buildSprites(); buildTable(); }
  }

  // ---- cached art: the table (felt, cushions, rails of glyphs, pockets) and the balls ----
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function mkCanvas(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
  function rectW(x0, y0, x1, y1) {   // world rect → screen rect
    var ax = sx(x0, y0), ay = sy(x0, y0), bx = sx(x1, y1), by = sy(x1, y1);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  }
  function buildTable() {
    if (!S.pal || !S.s) return;
    var P = S.pal, k = S.dpr, cv = S.bg || (S.bg = mkCanvas(1, 1));
    cv.width = S.cv.width; cv.height = S.cv.height;
    var c = cv.getContext('2d'), s = S.s;
    c.setTransform(k, 0, 0, k, 0, 0);
    c.clearRect(0, 0, S.cw, S.ch);
    // wood
    c.fillStyle = P.rail;
    rr(c, 0, 0, S.cw, S.ch, Math.min(14, s * 2.2)); c.fill();
    // rail glyphs: = along rails that run across the screen, ‖ along those that run down it
    var fs = Math.max(8, Math.min(16, RAIL * s * 0.42));
    c.font = '600 ' + fs.toFixed(1) + 'px ' + S.font; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = P.railG;
    var cwG = fs * 0.62, inner = rectW(0, 0, W, H), mid = RAIL * s * 0.42;
    function rowH(y, x0, x1) { for (var x = x0; x <= x1; x += cwG) c.fillText('=', x, y); }
    function colV(x, y0, y1) { for (var y = y0; y <= y1; y += fs * 0.9) c.fillText('‖', x, y); }
    rowH(inner.y - mid, inner.x + cwG, inner.x + inner.w - cwG); rowH(inner.y + inner.h + mid, inner.x + cwG, inner.x + inner.w - cwG);
    colV(inner.x - mid, inner.y + fs, inner.y + inner.h - fs); colV(inner.x + inner.w + mid, inner.y + fs, inner.y + inner.h - fs);
    // diamonds
    c.fillStyle = P.dia;
    c.font = '700 ' + (fs * 0.8).toFixed(1) + 'px ' + S.font;
    var dOff = RAIL * 0.7;
    for (var i = 1; i < 8; i++) {
      if (i === 4) continue;
      var x = W * i / 8;
      [[x, -dOff], [x, H + dOff]].forEach(function (p) { glyphAt(c, '◆', p[0], p[1], P.dia); });
    }
    for (i = 1; i < 4; i++) [[-dOff, H * i / 4], [W + dOff, H * i / 4]].forEach(function (p) { glyphAt(c, '◆', p[0], p[1], P.dia); });
    // cushions: a rubber band just outside the cloth
    var cu = 1.1 * s;
    c.fillStyle = P.cush;
    c.fillRect(inner.x - cu, inner.y - cu, inner.w + 2 * cu, inner.h + 2 * cu);
    // cloth
    c.fillStyle = P.felt;
    c.fillRect(inner.x, inner.y, inner.w, inner.h);
    c.font = '500 ' + Math.max(7, s * 1.7).toFixed(1) + 'px ' + S.font; c.fillStyle = P.dot;
    for (var gx = 2.5; gx < W; gx += 5) for (var gy = 2.5; gy < H; gy += 5) c.fillText('·', sx(gx, gy), sy(gx, gy));
    // head string, spots
    c.fillStyle = P.line;
    for (var hy = 1.2; hy < H; hy += 2) c.fillText(':', sx(HEAD_X, hy), sy(HEAD_X, hy));
    c.font = '700 ' + Math.max(8, s * 2).toFixed(1) + 'px ' + S.font;
    c.fillText('+', sx(FOOT_X, H / 2), sy(FOOT_X, H / 2));
    c.fillText('+', sx(HEAD_X, H / 2), sy(HEAD_X, H / 2));
    // pocket throats (dark, between the jaws) and the jaws themselves
    var q = JL / Math.SQRT2;
    function poly(pts, fill) {
      c.beginPath();
      pts.forEach(function (pt, j) { var X = sx(pt[0], pt[1]), Y = sy(pt[0], pt[1]); if (j) c.lineTo(X, Y); else c.moveTo(X, Y); });
      c.closePath(); c.fillStyle = fill; c.fill();
    }
    [[0, 0, 1, 1], [W, 0, -1, 1], [0, H, 1, -1], [W, H, -1, -1]].forEach(function (k0) {
      var X0 = k0[0], Y0 = k0[1], ux = k0[2], uy = k0[3];
      poly([[X0 + ux * CM, Y0], [X0 + ux * (CM - q), Y0 - uy * q], [X0 - ux * 2.2, Y0 - uy * 2.2], [X0 - ux * q, Y0 + uy * (CM - q)], [X0, Y0 + uy * CM], [X0 + ux * 1.5, Y0 + uy * 1.5]], P.pocket);
    });
    [[0, -1], [H, 1]].forEach(function (k0) {
      var Y0 = k0[0], o = k0[1];
      poly([[W / 2 - SM, Y0], [W / 2 - SM + 0.6, Y0 + o * 3], [W / 2 + SM - 0.6, Y0 + o * 3], [W / 2 + SM, Y0]], P.pocket);
    });
    c.strokeStyle = P.cush; c.lineCap = 'round'; c.lineWidth = Math.max(1.5, s * 0.7);
    SEGS.forEach(function (g) {
      if ((g.ay === g.by && (g.ay === 0 || g.ay === H) && g.ax !== g.bx) || (g.ax === g.bx && (g.ax === 0 || g.ax === W))) return;
      c.beginPath(); c.moveTo(sx(g.ax, g.ay), sy(g.ax, g.ay)); c.lineTo(sx(g.bx, g.by), sy(g.bx, g.by)); c.stroke();
    });
    // pockets
    POCKETS.forEach(function (p) {
      var x = sx(p.x, p.y), y = sy(p.x, p.y), r0 = (p.side ? 2.5 : 2.9) * s;
      c.fillStyle = P.pocket; c.beginPath(); c.arc(x, y, r0, 0, Math.PI * 2); c.fill();
      c.fillStyle = P.pocketIn; c.beginPath(); c.arc(x, y, r0 * 0.62, 0, Math.PI * 2); c.fill();
      c.strokeStyle = P.railG; c.lineWidth = 1; c.setLineDash([2, 3]);
      c.beginPath(); c.arc(x, y, r0 + 1.5, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
    });
  }
  function glyphAt(c, ch, x, y, col) { c.fillStyle = col; c.fillText(ch, sx(x, y), sy(x, y)); }
  function rr(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  // Ball sprites: the disc (solid, or white with a band for a stripe) and a number badge drawn on top as it rolls.
  function buildSprites() {
    if (!S.pal || !S.s) return;
    var k = S.dpr, rp = R * S.s, size = Math.ceil((rp * 2 + 4) * k), P = S.pal;
    S.spr = S.spr || [];
    S.badge = S.badge || [];
    S.sprR = rp;
    for (var n = 0; n < 16; n++) {
      var cv = S.spr[n] || (S.spr[n] = mkCanvas(1, 1));
      cv.width = size; cv.height = size;
      var c = cv.getContext('2d'), m = size / 2, r = rp * k, col = P.ball[baseCol(n)];
      c.clearRect(0, 0, size, size);
      c.save();
      c.beginPath(); c.arc(m, m, r, 0, Math.PI * 2); c.closePath();
      if (n > 8) {
        c.fillStyle = P.ball[0]; c.fill();
        c.save(); c.clip(); c.fillStyle = col; c.fillRect(m - r, m - r * 0.58, 2 * r, r * 1.16); c.restore();
      } else { c.fillStyle = col; c.fill(); }
      // shading + a highlight
      var gr = c.createRadialGradient(m - r * 0.35, m - r * 0.4, r * 0.1, m, m, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.35)'); gr.addColorStop(0.45, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.28)');
      c.fillStyle = gr; c.beginPath(); c.arc(m, m, r, 0, Math.PI * 2); c.fill();
      c.lineWidth = Math.max(1, k * 0.8); c.strokeStyle = n === 8 || n === 0 ? P.ring : 'rgba(0,0,0,0.3)';
      c.beginPath(); c.arc(m, m, r - c.lineWidth / 2, 0, Math.PI * 2); c.stroke();
      c.restore();
      // the number badge
      var bcv = S.badge[n] || (S.badge[n] = mkCanvas(1, 1)), bs = Math.ceil(r * 1.25);
      bcv.width = bs; bcv.height = bs;
      var b = bcv.getContext('2d');
      b.clearRect(0, 0, bs, bs);
      if (n) {
        b.fillStyle = '#fbfaf6'; b.beginPath(); b.arc(bs / 2, bs / 2, bs / 2 - 0.5, 0, Math.PI * 2); b.fill();
        b.fillStyle = '#16161a'; b.textAlign = 'center'; b.textBaseline = 'middle';
        b.font = '700 ' + (bs * (n > 9 ? 0.6 : 0.74)).toFixed(1) + 'px ' + S.font;
        b.fillText(String(n), bs / 2, bs / 2 + bs * 0.04);
      } else {
        b.fillStyle = 'rgba(220,40,40,0.75)'; b.beginPath(); b.arc(bs / 2, bs / 2, bs * 0.16, 0, Math.PI * 2); b.fill();   // the cue ball's dot
      }
    }
  }

  // ---- particles, pop-ups, banners ----
  var NPART = 60;
  function makeFx() {
    S.fx = [];
    for (var i = 0; i < NPART; i++) S.fx.push({ life: 0, x: 0, y: 0, vx: 0, vy: 0, ch: '*', col: '', t: 0 });
    S.sink = []; S.pops = [];
  }
  function burst(x, y, n, col, chars) {
    for (var i = 0, made = 0; i < S.fx.length && made < n; i++) {
      var p = S.fx[i];
      if (p.life > 0) continue;
      var a = Math.random() * Math.PI * 2, sp = 6 + Math.random() * 16;
      p.x = x; p.y = y; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp; p.life = p.t = 0.45 + Math.random() * 0.35;
      p.ch = chars.charAt((Math.random() * chars.length) | 0); p.col = col; made++;
    }
  }
  function stepFx(dt) {
    var alive = false, i;
    for (i = 0; i < S.fx.length; i++) {
      var p = S.fx[i];
      if (p.life <= 0) continue;
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; alive = true;
    }
    for (i = S.sink.length - 1; i >= 0; i--) { S.sink[i].t += dt; if (S.sink[i].t > 0.28) S.sink.splice(i, 1); else alive = true; }
    for (i = S.pops.length - 1; i >= 0; i--) { S.pops[i].t += dt; if (S.pops[i].t > 1.1) S.pops.splice(i, 1); else alive = true; }
    if (S.msg) { S.msg.t += dt; if (S.msg.t > S.msg.dur) S.msg = S.msgQ.shift() || null; alive = true; }
    if (S.shake > 0) { S.shake = Math.max(0, S.shake - dt * 3); alive = true; }
    return alive;
  }
  function say(text, col, dur, queue) {
    var m = { text: text, col: col || 'acc', t: 0, dur: dur || 1.5 };
    if (queue && S.msg) S.msgQ.push(m); else { S.msg = m; S.msgQ.length = 0; }
    kick();
  }

  // ---- whose shot / names ----
  function humanTurn() { var g = S.g; return !!g && (g.mode !== 'cpu' || g.turn === 0); }
  function pname(p) {
    var g = S.g;
    if (!g || g.mode === 'practice') return 'You';
    if (g.mode === 'cpu') return p === 0 ? 'You' : 'CPU';
    return 'Player ' + (p + 1);
  }
  function grpName(gr, plural) { return gr === 'solid' ? (plural ? 'solids' : 'solid') : gr === 'stripe' ? (plural ? 'stripes' : 'stripe') : 'the 8'; }

  // ---- the scene ----
  function ballXY(b, a) { return { x: b.px + (b.x - b.px) * a, y: b.py + (b.y - b.py) * a }; }
  function drawBall(c, n, x, y, scale, roll, dx, dy) {
    var sp = S.spr[n], X = sx(x, y), Y = sy(x, y), d = (S.sprR * 2 + 4) * (scale || 1);
    c.drawImage(sp, X - d / 2, Y - d / 2, d, d);
    // the badge rolls across the ball (visible on the near half)
    if (!dx && !dy) roll = 0;
    var cr = Math.cos(roll || 0), sr = Math.sin(roll || 0);
    if (cr < -0.05 && n) return;
    var bw = S.sprR * 1.25 * (scale || 1), off = S.sprR * 0.62 * sr * (scale || 1);
    var ox = 0, oy = 0;
    if (dx || dy) { var tx = sx(x + dx, y + dy) - X, ty = sy(x + dx, y + dy) - Y, tl = Math.sqrt(tx * tx + ty * ty) || 1; ox = tx / tl * off; oy = ty / tl * off; }
    var sq = n ? Math.max(0.35, Math.abs(cr)) : 1;
    c.drawImage(S.badge[n], X + ox - bw / 2 * (dx || dy ? 1 : 1), Y + oy - bw / 2 * sq, bw, bw * sq);
  }
  function draw(alpha) {
    if (!S || !S.ctx || !S.bg) return;
    var c = S.ctx, g = S.g || S.preview, P = S.pal, s = S.s, a = alpha == null ? 1 : alpha;
    c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    c.clearRect(0, 0, S.cw, S.ch);
    var shx = 0, shy = 0;
    if (S.shake > 0 && !S.rm) { shx = (Math.random() - 0.5) * S.shake * 6; shy = (Math.random() - 0.5) * S.shake * 6; c.translate(shx, shy); }
    c.drawImage(S.bg, 0, 0, S.cw, S.ch);
    if (!g) return;
    var aimNow = S.phase === 'play' && g.phase === 'aim' && !S.paused;
    // kitchen shading while placing for the break
    if (aimNow && g.bih === 'kitchen') {
      var kr = rectW(0, 0, HEAD_X, H);
      c.fillStyle = P.acc2; c.globalAlpha = 0.35; c.fillRect(kr.x, kr.y, kr.w, kr.h); c.globalAlpha = 1;
    }
    // shadows then balls
    var i, b, p;
    c.fillStyle = P.shadow;
    for (i = 0; i < 16; i++) {
      b = g.balls[i];
      if (!b.on) continue;
      p = ballXY(b, a);
      c.beginPath(); c.arc(sx(p.x, p.y) + s * 0.35, sy(p.x, p.y) + s * 0.45, R * s, 0, Math.PI * 2); c.fill();
    }
    for (i = 0; i < S.sink.length; i++) {
      var k = S.sink[i], tt = clamp(k.t / 0.28, 0, 1), e = tt * tt;
      c.globalAlpha = 1 - tt * 0.6;
      drawBall(c, k.n, k.x0 + (k.x1 - k.x0) * e, k.y0 + (k.y1 - k.y0) * e, 1 - tt * 0.55, 0, 0, 0);
      c.globalAlpha = 1;
    }
    for (i = 15; i >= 0; i--) {
      b = g.balls[i];
      if (!b.on) continue;
      p = ballXY(b, a);
      var dir = S.dir[i];
      var mv = b.vx || b.vy;
      drawBall(c, i, p.x, p.y, 1, b.roll, mv ? dir[0] : 0, mv ? dir[1] : 0);
    }
    if (aimNow) drawAim(c, g);
    // particles
    if (S.fx) {
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = '700 ' + Math.max(9, s * 2.2).toFixed(1) + 'px ' + S.font;
      for (i = 0; i < S.fx.length; i++) {
        var q = S.fx[i];
        if (q.life <= 0) continue;
        c.globalAlpha = clamp(q.life / q.t, 0, 1); c.fillStyle = q.col;
        c.fillText(q.ch, sx(q.x, q.y), sy(q.x, q.y));
      }
      c.globalAlpha = 1;
      for (i = 0; i < S.pops.length; i++) {
        var pp = S.pops[i], pt = pp.t / 1.1, X = sx(pp.x, pp.y), Y = sy(pp.x, pp.y) - pt * 22;
        c.globalAlpha = clamp(1.4 - pt * 1.4, 0, 1);
        c.font = '700 ' + Math.max(11, s * 2.4).toFixed(1) + 'px ' + S.font;
        c.fillStyle = P.bg; c.fillText(pp.text, X + 1, Y + 1);
        c.fillStyle = pp.col; c.fillText(pp.text, X, Y);
      }
      c.globalAlpha = 1;
    }
    if (S.msg) banner(c, S.msg);
    if (shx || shy) c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  }
  function banner(c, m) {
    var P = S.pal, t = m.t, a = clamp(Math.min(t / 0.15, (m.dur - t) / 0.3), 0, 1);
    var fs = clamp(S.s * 2.6, 12, 18);
    c.font = '700 ' + fs.toFixed(1) + 'px ' + S.font; c.textAlign = 'center'; c.textBaseline = 'middle';
    var w = c.measureText(m.text).width + fs * 2.2, h = fs * 2, x = S.cw / 2, y = S.ch * (S.vert ? 0.42 : 0.5);
    c.globalAlpha = a * 0.92; c.fillStyle = P.bg; rr(c, x - w / 2, y - h / 2, w, h, 8); c.fill();
    c.globalAlpha = a; c.strokeStyle = P[m.col] || P.acc; c.lineWidth = 1.5; c.stroke();
    c.fillStyle = P[m.col] || P.acc; c.fillText(m.text, x, y + 1);
    c.globalAlpha = 1;
  }
  function line(c, x0, y0, x1, y1) { c.beginPath(); c.moveTo(sx(x0, y0), sy(x0, y0)); c.lineTo(sx(x1, y1), sy(x1, y1)); c.stroke(); }
  function drawAim(c, g) {
    var P = S.pal, cue = g.balls[0], s = S.s, human = humanTurn();
    if (!cue.on) return;
    var ang = S.aim, dx = Math.cos(ang), dy = Math.sin(ang), cx = cue.x, cy = cue.y;
    var guide = human ? S.set.guide : 'short';
    // ball in hand: a dashed ring and the hand glyph
    if (g.bih && human) {
      c.strokeStyle = P.acc; c.lineWidth = 1.5; c.setLineDash([3, 3]);
      c.beginPath(); c.arc(sx(cx, cy), sy(cx, cy), R * s + 5 + Math.sin(S.clock * 5) * 1.5, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
    }
    c.save();
    var cr0 = rectW(-2.5, -2.5, W + 2.5, H + 2.5);
    c.beginPath(); c.rect(cr0.x, cr0.y, cr0.w, cr0.h); c.clip();
    var hit = castAim(g, cx, cy, ang), maxL = guide === 'full' ? 1e9 : guide === 'short' ? 16 : 6;
    var L = Math.min(hit.d, maxL);
    c.lineWidth = 1.4; c.strokeStyle = P.text; c.globalAlpha = human ? 0.75 : 0.4; c.setLineDash([4, 4]);
    line(c, cx + dx * R, cy + dy * R, cx + dx * L, cy + dy * L);
    c.setLineDash([]);
    if (guide !== 'off' && hit.d <= maxL) {
      // the ghost ball
      c.beginPath(); c.arc(sx(hit.gx, hit.gy), sy(hit.gx, hit.gy), R * s, 0, Math.PI * 2);
      c.strokeStyle = P.text; c.globalAlpha = human ? 0.8 : 0.4; c.stroke();
      if (hit.ball && guide === 'full') {
        var ob = g.balls[hit.ball], ol = 6 + 16 * Math.cos(hit.cut);
        var legal = legalTargets(g, g.turn).indexOf(hit.ball) >= 0;
        c.strokeStyle = legal ? P.acc : P.red; c.lineWidth = 2; c.globalAlpha = 0.9;
        line(c, ob.x + hit.ox * R, ob.y + hit.oy * R, ob.x + hit.ox * (R + ol), ob.y + hit.oy * (R + ol));
        var tl = Math.sqrt(hit.tx * hit.tx + hit.ty * hit.ty);
        if (tl > 0.05) {
          c.strokeStyle = P.muted; c.lineWidth = 1.2; c.setLineDash([2, 3]);
          var cl = 4 + 10 * tl;
          line(c, hit.gx, hit.gy, hit.gx + hit.tx / tl * cl, hit.gy + hit.ty / tl * cl);
          c.setLineDash([]);
        }
        if (!legal) {
          c.globalAlpha = 0.95; c.font = '700 ' + Math.max(11, s * 2.4).toFixed(1) + 'px ' + S.font; c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillStyle = P.red; c.fillText('x', sx(ob.x, ob.y) + R * s * 1.5, sy(ob.x, ob.y) - R * s * 1.5);
        }
      }
    }
    c.globalAlpha = 1;
    c.restore();
    // the cue: tip, ferrule, shaft and butt, pulled back with the power
    var pw = S.drag && (S.drag.mode === 'pull' || S.drag.mode === 'power') ? S.drag.pw : (S.cpu && S.cpu.stage === 'pull' ? S.cpu.pw : S.showPow);
    var gap = R + 0.8 + (pw || 0) * 11, len = 46;
    var bx0 = cx - dx * gap, by0 = cy - dy * gap, bx1 = cx - dx * (gap + len), by1 = cy - dy * (gap + len);
    c.lineCap = 'round';
    c.strokeStyle = P.shadow; c.lineWidth = s * 1.15; line(c, bx0 + 0.4, by0 + 0.6, bx1 + 0.4, by1 + 0.6);
    c.strokeStyle = P.shaft; c.lineWidth = s * 0.85; line(c, bx0, by0, cx - dx * (gap + len * 0.62), cy - dy * (gap + len * 0.62));
    c.strokeStyle = P.butt; c.lineWidth = s * 1.15; line(c, cx - dx * (gap + len * 0.6), cy - dy * (gap + len * 0.6), bx1, by1);
    c.strokeStyle = P.cueTip; c.lineWidth = s * 0.8; c.lineCap = 'butt'; line(c, bx0, by0, cx - dx * (gap + 0.9), cy - dy * (gap + 0.9));
    c.lineCap = 'round';
  }

  // ---- HUD (DOM): both players' groups and the status line ----
  function ballChips(p) {
    var g = S.g, gr = g.groups[p], list = gr === 'solid' ? SOLIDS : gr === 'stripe' ? STRIPES : null;
    if (!list) return '<span class="pl-open">' + (g.isBreak ? 'break' : 'open') + '</span>';
    return list.map(function (n) {
      return '<i class="pl-bc pl-c' + baseCol(n) + (n > 8 ? ' st' : '') + (g.balls[n].on ? '' : ' gone') + '">' + n + '</i>';
    }).join('') + (onEight(g, p) ? '<i class="pl-bc pl-c8">8</i>' : '');
  }
  function syncHud() {
    if (!S) return;
    var g = S.g, h = '';
    if (!g || S.phase === 'menu') { S.hud.innerHTML = ''; return; }
    if (g.mode === 'practice') {
      h = '<div class="pl-pl on"><b>Practice</b><span>' + g.shots[0] + ' shot' + (g.shots[0] === 1 ? '' : 's') + '</span></div>' +
        '<div class="pl-st">' + esc(status()) + '</div>' +
        '<div class="pl-pl"><b>' + objectsLeft(g) + ' left</b><span>' + (S.st.prac.best ? 'best ' + S.st.prac.best : 'no record yet') + '</span></div>';
    } else {
      for (var p = 0; p < 2; p++) {
        if (p === 1) h += '<div class="pl-st">' + esc(status()) + '</div>';
        h += '<div class="pl-pl' + (g.turn === p && g.phase !== 'over' ? ' on' : '') + (p ? ' r' : '') + '"><b>' + esc(S.vert && g.mode === '2p' ? 'P' + (p + 1) : pname(p)) +
          (g.groups[p] ? ' <em>' + grpName(g.groups[p], true) + '</em>' : '') + '</b><span class="pl-bcs">' + ballChips(p) + '</span></div>';
      }
    }
    S.hud.innerHTML = h;
  }
  function status() {
    var g = S.g;
    if (!g) return '';
    if (g.phase === 'over') return 'Game over';
    if (g.phase === 'roll') return '…';
    if (!humanTurn()) return 'CPU is lining up';
    var who = g.mode === '2p' ? pname(g.turn) + ': ' : '';
    if (g.isBreak) return who + 'break!';
    if (g.bih) return who + 'ball in hand';
    if (g.mode !== 'practice' && onEight(g, g.turn)) return who + 'on the 8';
    return who + 'your shot';
  }

  // ---- the pad under the table ----
  function setPad(mode) {
    S.padMode = mode;
    var h;
    if (mode === 'play' || mode === 'cpu') {
      h = '<button type="button" class="pl-rot" data-rot="-1" aria-label="Aim left">◀</button>' +
        '<div class="pl-pow" role="slider" aria-label="Power: drag right and let go to shoot" aria-valuemin="0" aria-valuemax="100" tabindex="-1">' +
        '<div class="pl-pow-fill"></div><div class="pl-pow-lab"></div></div>' +
        '<button type="button" class="pl-rot" data-rot="1" aria-label="Aim right">▶</button>' +
        '<button type="button" class="pl-spin" data-act="spin" aria-label="Spin" title="Spin (I J K L)"><span class="pl-cueb"><i></i></span></button>';
    } else {
      var lab = { home: 'Rack ’em', again: 'Rematch', resume: 'Resume', start: 'Let’s play' }[mode] || 'OK';
      // with a game saved, the big button resumes it (a new rack is the smaller one) so a quick tap never throws it away
      var resumeSaved = mode === 'home' && !!S.saved;
      if (resumeSaved) lab = 'Resume';
      h = '<button type="button" class="pl-act" data-act="' + (resumeSaved ? 'continue' : mode) + '">' + lab + (S.coarse ? '' : ' <small>space</small>') + '</button>' +
        (mode === 'again' ? '<button type="button" class="pl-act alt" data-act="menu">Menu</button>' : '') +
        (resumeSaved ? '<button type="button" class="pl-act alt" data-act="play">New</button>' : '');
    }
    S.pad.innerHTML = h;
    syncPad();
  }
  function syncPad() {
    if (!S || (S.padMode !== 'play' && S.padMode !== 'cpu')) return;
    var g = S.g, live = S.padMode === 'play' && humanTurn() && g && g.phase === 'aim' && !S.paused;
    var dragging = S.drag && (S.drag.mode === 'power' || S.drag.mode === 'pull');
    var pw = dragging ? S.drag.pw : S.cpu && S.cpu.stage === 'pull' ? S.cpu.pw : S.padMode === 'cpu' ? 0 : S.power;
    var fill = S.pad.querySelector('.pl-pow-fill'), lab = S.pad.querySelector('.pl-pow-lab'), box = S.pad.querySelector('.pl-pow');
    if (fill) fill.style.width = Math.round(pw * 100) + '%';
    if (box) { box.classList.toggle('on', !!dragging); box.classList.toggle('off', !live); box.setAttribute('aria-valuenow', Math.round(pw * 100)); }
    if (lab) {
      var n = 12, f = Math.round(pw * n), bar = '';
      for (var i = 0; i < n; i++) bar += i < f ? '#' : '-';
      var narrow = !!box && box.offsetWidth < 190;
      lab.textContent = !live ? (S.padMode === 'cpu' ? 'CPU’s shot' : g && g.phase === 'roll' ? 'rolling…' : '') :
        dragging ? (narrow ? Math.round(pw * 100) + '% let go' : '[' + bar + '] ' + Math.round(pw * 100) + '%  let go') :
        narrow ? '▶ shoot ' + Math.round(S.power * 100) + '%' :
        (S.coarse ? 'drag ▶ to shoot · ' : 'pull ▶ / space · ') + Math.round(S.power * 100) + '%';
    }
    S.pad.querySelectorAll('.pl-rot, .pl-spin').forEach(function (b) { b.disabled = !live; });
    var dot = S.pad.querySelector('.pl-cueb i');
    if (dot) { dot.style.left = (50 + S.eng * 34) + '%'; dot.style.top = (50 - S.fol * 34) + '%'; }
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.phase !== 'play';
    pb.title = S.paused ? 'Resume (P)' : 'Pause / menu (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }
  function announce(t) { if (S && S.liveEl) S.liveEl.textContent = t; }

  // ---- cards ----
  var ART = ' .-------------------.\n |o        o        o|\n |   :      · o8o   |\n |o        o        o|\n \'-------------------\'';
  function chip(attr, val, cur, label) {
    return '<button type="button" class="pl-chip' + (val === cur ? ' on' : '') + '" data-' + attr + '="' + val + '" aria-pressed="' + (val === cur) + '">' + label + '</button>';
  }
  function pad(a, b, w) { return esc(a) + new Array(Math.max(1, (w || 28) - a.length - String(b).length) + 1).join(' ') + '<b>' + esc(b) + '</b>'; }
  function homeHtml() {
    var st = S.st, set = S.set, h = '<div class="pl-card pl-home"><div class="pl-title">POOL</div><pre class="pl-art">' + esc(ART) + '</pre>';
    h += '<div class="pl-tabs" role="tablist">' + ['play', 'stats'].map(function (t) {
      return '<button type="button" role="tab" data-tab="' + t + '" aria-selected="' + (S.tab === t) + '" class="' + (S.tab === t ? 'on' : '') + '">' + (t === 'play' ? 'Play' : 'Stats') + '</button>';
    }).join('') + '</div>';
    if (S.tab === 'stats') {
      var rows = [];
      DIFFS.forEach(function (d) { var c = st.cpu[d]; rows.push(pad('vs CPU ' + d, c.w + ' W  ' + c.l + ' L')); });
      rows.push(pad('win streak (best)', st.streak + ' (' + st.bestStreak + ')'));
      rows.push(pad('2-player games', st.duo.games + '  P1 ' + st.duo.p1 + ' · P2 ' + st.duo.p2));
      rows.push(pad('practice racks', st.prac.racks + (st.prac.best ? '  best ' + st.prac.best + ' shots' : '')));
      rows.push(pad('balls potted', st.pots));
      rows.push(pad('pot rate', st.shots ? Math.round(st.pots / st.shots * 100) + '%' : '-'));
      rows.push(pad('fouls', st.fouls));
      rows.push(pad('best run', st.bestRun));
      rows.push(pad('best break', st.bestBreak + ' down'));
      h += '<pre class="pl-tab">' + rows.join('\n') + '</pre>';
      h += '<div class="pl-foot">' + (S.resetArm ? '<span class="pl-confirm">Erase all stats?</span><button type="button" class="pl-lnk danger" data-act="reset-yes">Erase</button><button type="button" class="pl-lnk" data-act="reset-no">Keep</button>' :
        '<span>Stats stay on this device.</span><button type="button" class="pl-lnk" data-act="reset">Reset stats</button>') + '</div>';
    } else {
      h += '<div class="pl-sec"><div class="pl-h">Mode</div><div class="pl-chips">' + chip('mode', 'cpu', set.mode, 'vs CPU') + chip('mode', '2p', set.mode, '2 players') + chip('mode', 'practice', set.mode, 'Practice') + '</div></div>';
      if (set.mode === 'cpu') h += '<div class="pl-sec"><div class="pl-h">CPU</div><div class="pl-chips">' + chip('diff', 'easy', set.diff, 'Easy') + chip('diff', 'normal', set.diff, 'Normal') + chip('diff', 'hard', set.diff, 'Hard') + '</div></div>';
      h += '<div class="pl-sec"><div class="pl-h">Aim guide</div><div class="pl-chips">' + chip('guide', 'full', set.guide, 'Full') + chip('guide', 'short', set.guide, 'Short') + chip('guide', 'off', set.guide, 'Off') + '</div></div>';
      h += '<p>' + ({ cpu: 'You break; the CPU breaks the next rack. Solids or stripes, then the 8.', '2p': 'Pass-and-play on one device: hand it over when the turn changes.', practice: 'Clear all fifteen in as few shots as you can. Scratches give ball in hand.' })[set.mode] + '</p>';
      h += '<button type="button" class="pl-go" data-act="play">Rack ’em</button>';
      if (S.saved) h += '<button type="button" class="pl-go alt" data-act="continue">Resume: ' + esc(savedLabel(S.saved)) + '</button>';
    }
    return h + '</div>';
  }
  function savedLabel(g) {
    var m = g.mode === 'cpu' ? 'vs CPU (' + g.diff + ')' : g.mode === '2p' ? '2 players' : 'practice';
    return m + ' · ' + objectsLeft(g) + ' left';
  }
  function helpHtml() {
    var k = S.coarse;
    return '<div class="pl-card"><div class="pl-title">HOW TO PLAY</div>' +
      '<p><b>8-ball.</b> Break, then the first ball you pot makes you <b>solids</b> (1–7, full) or <b>stripes</b> (9–15, banded). Clear your group, then sink the <b>8</b> to win.</p>' +
      '<div class="pl-keys">' +
      (k ? '<div><b>Drag on the table</b> to aim at your finger</div><div><b>◀ ▶</b> fine-tune the aim (hold)</div><div><b>Power bar:</b> drag right, let go to shoot</div><div><b>Ball in hand:</b> drag the cue ball</div>'
        : '<div><b>Move the mouse</b> to aim · <b>click</b> locks the aim</div><div><b>Press, pull back, let go</b> to shoot</div><div><b>← →</b> aim (Shift: fine) · <b>↑ ↓</b> power · <b>Space</b> shoot</div><div><b>I K</b> follow / draw · <b>J L</b> english · <b>P</b> pause</div><div><b>Ball in hand:</b> drag the cue ball</div>') +
      '</div>' +
      '<p><b>Fouls</b> give the other player ball in hand anywhere: scratching (the cue ball in a pocket), hitting nothing, hitting the wrong group first (or the 8 on an open table), or no ball touching a rail after the hit.</p>' +
      '<p><b>The 8</b> potted before your group is cleared, or with a scratch, loses the game. On the break it is re-spotted.</p>' +
      '<p class="pl-tip"><b>Spin</b> (the ball button): top = follow, bottom = draw back, sides = english off the cushions.</p>' +
      '<button type="button" class="pl-go" data-act="close-help">Got it</button></div>';
  }
  function pauseHtml() {
    var g = S.g;
    return '<div class="pl-card"><div class="pl-title">PAUSED</div>' +
      '<div class="pl-sub">' + esc(g.mode === 'cpu' ? 'vs CPU · ' + g.diff : g.mode === '2p' ? '2 players' : 'practice') + ' · ' + objectsLeft(g) + ' balls left</div>' +
      '<div class="pl-btns"><button type="button" class="pl-go" data-act="resume">Resume</button></div>' +
      '<div class="pl-btns"><button type="button" class="pl-go alt" data-act="menu">Menu (saved)</button><button type="button" class="pl-go alt" data-act="rerack">' + (S.rerackArm ? 'Sure? Re-rack' : 'Re-rack') + '</button></div>' +
      '<div class="pl-note">' + (S.coarse ? 'The game is kept if you leave' : 'P / Space to resume · the game is kept') + '</div></div>';
  }
  function spinHtml() {
    return '<div class="pl-card pl-spincard"><div class="pl-title">SPIN</div>' +
      '<div class="pl-spinpad" role="slider" aria-label="Where the cue strikes the ball"><div class="pl-spinx"></div><i style="left:' + (50 + S.eng * 40) + '%;top:' + (50 - S.fol * 40) + '%"></i></div>' +
      '<div class="pl-sub">' + spinLabel() + '</div>' +
      '<div class="pl-chips c">' + [['follow', 0, 1], ['stun', 0, 0], ['draw', 0, -1], ['left', -1, 0], ['right', 1, 0]].map(function (q) {
        return '<button type="button" class="pl-chip" data-spin="' + q[1] + ',' + q[2] + '">' + q[0] + '</button>';
      }).join('') + '</div>' +
      '<button type="button" class="pl-go" data-act="spin-done">Done</button></div>';
  }
  function spinLabel() {
    var a = [];
    if (S.fol > 0.05) a.push('follow ' + Math.round(S.fol * 100) + '%'); else if (S.fol < -0.05) a.push('draw ' + Math.round(-S.fol * 100) + '%');
    if (S.eng > 0.05) a.push('right english ' + Math.round(S.eng * 100) + '%'); else if (S.eng < -0.05) a.push('left english ' + Math.round(-S.eng * 100) + '%');
    return a.length ? a.join(' · ') : 'centre ball (stun)';
  }
  function resultsHtml() {
    var g = S.g, r = S.resRec || {}, h, title, sub;
    if (g.mode === 'practice') {
      title = 'RACK CLEARED'; sub = g.shots[0] + ' shots · ' + g.fouls[0] + ' scratch' + (g.fouls[0] === 1 ? '' : 'es');
    } else {
      title = g.mode === 'cpu' ? (g.winner === 0 ? 'YOU WIN' : 'CPU WINS') : 'PLAYER ' + (g.winner + 1) + ' WINS';
      var loser = 1 - g.winner;
      sub = g.reason === 'eight' ? pname(g.winner) + ' sank the 8' : g.reason === 'early8' ? pname(loser) + ' potted the 8 early' : pname(loser) + ' scratched on the 8';
      if (g.mode === 'cpu' && g.reason !== 'eight') sub = sub.replace(/^You /, 'You ');
    }
    h = '<div class="pl-card"><div class="pl-title">' + title + '</div><div class="pl-sub">' + esc(sub) + '</div>';
    if (g.mode === 'practice') h += '<div class="pl-big">' + g.shots[0] + '</div>';
    var rows = [];
    if (g.mode === 'practice') {
      rows.push(pad('balls potted', g.pots[0])); rows.push(pad('best run', g.bestRun[0])); rows.push(pad('personal best', S.st.prac.best + ' shots'));
    } else {
      rows.push(pad('', pname(0).slice(0, 8) + '   ' + pname(1).slice(0, 8), 30).replace(/<\/?b>/g, ''));
      [['shots', 'shots'], ['potted', 'pots'], ['fouls', 'fouls'], ['best run', 'bestRun']].forEach(function (q) {
        var a = String(g[q[1]][0]), b = String(g[q[1]][1]);
        rows.push(pad(q[0], a + new Array(Math.max(1, 11 - b.length) + 1).join(' ') + b, 30));
      });
      if (g.mode === 'cpu') rows.push(pad('record vs ' + g.diff, S.st.cpu[g.diff].w + ' W  ' + S.st.cpu[g.diff].l + ' L', 30));
    }
    h += '<pre class="pl-tab">' + rows.join('\n') + '</pre>';
    if (r.prac) h += '<div class="pl-new">new best: fewest shots</div>';
    if (r.run) h += '<div class="pl-new">new best run</div>';
    if (r.streak) h += '<div class="pl-new">best win streak: ' + S.st.bestStreak + '</div>';
    if (r.brk) h += '<div class="pl-new">best break: ' + S.st.bestBreak + ' down</div>';
    return h + '<div class="pl-btns"><button type="button" class="pl-go" data-act="again">' + (g.mode === 'practice' ? 'New rack' : 'Rematch') + '</button><button type="button" class="pl-go alt" data-act="menu">Menu</button></div></div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'home' ? homeHtml() : kind === 'help' ? helpHtml() : kind === 'pause' ? pauseHtml() : kind === 'results' ? resultsHtml() : kind === 'spin' ? spinHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind && kind !== 'home');
    S.stage.classList.toggle('home', kind === 'home');
    if (kind) S.ovl.scrollTop = 0;
  }

  // ---- game flow ----
  function toMenu() {
    stopLoop();
    if (S.g && S.g.phase === 'aim') persistGame();
    S.saved = normGame(sjson(GAME_KEY));
    S.phase = 'menu'; S.g = null; S.paused = false; S.cpu = null; S.drag = null; S.resetArm = false; S.rerackArm = false;
    S.preview = S.saved || newGame('2p', { seed: 1 });
    resetDirs();
    showCard('home'); setPad('home'); syncHud(); syncHead();
    layout(); draw(1);
  }
  function startGame(fromSave) {
    S.snd.ensure();
    var g;
    if (fromSave && S.saved) g = S.saved;
    else {
      sdel(GAME_KEY);
      var first = 0;
      if (S.set.mode === 'cpu') { first = S.nextBreak || 0; S.nextBreak = 1 - first; }
      else if (S.set.mode === '2p') { first = S.nextBreak2 || 0; S.nextBreak2 = 1 - first; }
      g = newGame(S.set.mode, { diff: S.set.diff, seed: (Math.random() * 4294967295) >>> 0, first: first });
    }
    S.saved = null;
    S.g = g; S.preview = null;
    S.phase = 'play'; S.paused = false; S.acc = { t: 0 }; S.cpu = null; S.drag = null; S.locked = false; S.rerackArm = false;
    S.fol = 0; S.eng = 0; S.power = 0.55; S.showPow = 0;
    S.msg = null; S.msgQ.length = 0; S.sink.length = 0; S.pops.length = 0;
    resetDirs();
    showCard(null); setPad('play');
    beginTurn(true);
    syncHead(); layout();
    kick();
  }
  function resetDirs() { S.dir = []; for (var i = 0; i < 16; i++) S.dir.push([0, 0]); }
  // A new shot is up: aim at a legal ball, show who's on, maybe start the CPU.
  function beginTurn(first) {
    var g = S.g;
    S.drag = null; S.locked = false;
    autoAim();
    if (g.mode === '2p' && !first) say(pname(g.turn).toUpperCase() + ' — YOUR SHOT', 'acc', 1.4, true);
    if (first) {
      if (g.isBreak) say(g.mode === 'cpu' && g.turn === 1 ? 'CPU BREAKS' : (g.mode === '2p' ? pname(g.turn).toUpperCase() + ' BREAKS' : 'BREAK!'), 'acc', 1.3, true);
    }
    if (!humanTurn()) { S.cpu = { stage: 'think', t: 0, pw: 0 }; setPad('cpu'); }
    else {
      S.cpu = null;
      if (g.isBreak) S.power = 0.9;
      setPad('play');
    }
    syncHud();
    announce(status());
    kick();
  }
  function autoAim() {
    var g = S.g, c = g.balls[0], best = null, bd = 1e9, tg = legalTargets(g, g.turn);
    if (g.isBreak) { S.aim = 0; return; }
    var sh = findShots(g, g.turn);
    if (sh.length) { var tb = g.balls[sh[0].ball]; S.aim = Math.atan2(tb.y - c.y, tb.x - c.x); return; }
    tg.forEach(function (n) { var b = g.balls[n], d = Math.hypot(b.x - c.x, b.y - c.y); if (d < bd) { bd = d; best = b; } });
    if (best) S.aim = Math.atan2(best.y - c.y, best.x - c.x);
  }
  function fire(power) {
    var g = S.g;
    if (!g || g.phase !== 'aim' || S.paused || S.phase !== 'play') return;
    power = clamp(power, 0.02, 1);
    S.snd.ensure();
    if (!shoot(g, S.aim, power, S.fol, S.eng)) return;
    if (humanTurn()) S.power = g.isBreak ? 0.5 : power;
    S.fol = 0; S.eng = 0; S.drag = null; S.locked = false; S.showPow = 0;
    S.acc.t = 0;
    S.snd.tone(320 + power * 200, 0.06, 'triangle', 0.03 + power * 0.04, 140);
    if (g.isBreak !== false && power > 0.7) S.shake = 0.6;
    if (S.cardKind === 'spin') showCard(null);
    setPad(S.padMode === 'cpu' ? 'cpu' : 'play');
    syncHud();
    Cade.haptic && Cade.haptic(6);
    kick();
  }
  // Events from the engine: sounds, sparks, sinking balls.
  function handleEvents(g) {
    var ev = g.events, P = S.pal;
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e.k === 'ball') { S.snd.click(e.v); if (e.v > 120) burst(e.x, e.y, 3, P.muted, '\'`.'); }
      else if (e.k === 'rail') { if (e.v > 10) S.snd.tone(110 + Math.min(80, e.v), 0.07, 'sine', clamp(e.v / 900, 0.006, 0.05)); }
      else if (e.k === 'pot') {
        var b = g.balls[e.n], pk = POCKETS[e.p];
        S.sink.push({ n: e.n, x0: b.px, y0: b.py, x1: pk.x, y1: pk.y, t: 0 });
        var col = e.n === 0 ? P.red : P.ball[baseCol(e.n)];
        burst(pk.x, pk.y, e.n === 8 ? 14 : 8, e.n === 8 ? P.gold : col, e.n === 0 ? 'x!' : '*+.o');
        S.pops.push({ x: clamp(pk.x, 4, W - 4), y: clamp(pk.y, 4, H - 4), t: 0, text: e.n === 0 ? 'scratch' : String(e.n), col: e.n === 0 ? P.red : P.acc });
        S.snd.tone(e.n === 0 ? 160 : 420, 0.16, 'sine', 0.05, e.n === 0 ? 70 : 180);
        S.snd.tone(e.n === 0 ? 120 : 260, 0.08, 'triangle', 0.025, 0, 0.09);
        Cade.haptic && Cade.haptic(e.n === 0 ? 20 : 8);
      }
    }
    ev.length = 0;
  }
  // A shot has finished: tell the table what happened, record it, next turn.
  function afterShotUI() {
    var g = S.g, L = g.last, P = S.pal;
    if (!L) return;
    var msgs = [];
    var fo = { scratch: 'SCRATCH', miss: 'FOUL — NO BALL HIT', wrong: 'FOUL — WRONG BALL FIRST', rail: 'FOUL — NO RAIL' }[L.foul];
    if (L.respot) msgs.push(['8 ON THE BREAK — RE-SPOTTED', 'gold']);
    if (fo && g.phase !== 'over') msgs.push([fo, 'red']);
    if (L.assigned) msgs.push([(g.mode === 'cpu' ? (L.p === 0 ? 'YOU: ' : 'CPU: ') : g.mode === '2p' ? 'P' + (L.p + 1) + ': ' : '') + grpName(L.assigned, true).toUpperCase(), 'acc']);
    if (fo) { S.snd.tone(110, 0.22, 'sawtooth', 0.025, 80); }
    else if (L.legal >= 2) msgs.push([L.legal + ' DOWN!', 'gold']);
    else if (g.mode !== 'practice' && g.run >= 3 && L.cont) msgs.push(['RUN OF ' + g.run, 'gold']);
    S.msg = null; S.msgQ.length = 0;
    msgs.forEach(function (m, i) { say(m[0], m[1], 1.3, i > 0); });
    if (g.phase === 'over') { S.endT = 0; S.ending = true; S.snd.tone(g.mode === 'cpu' && g.winner === 1 ? 196 : 523, 0.12, 'triangle', 0.04); return; }
    persistGame();
    var txt = (fo ? fo.toLowerCase() + '. ' : '') + (L.legal ? L.legal + ' potted. ' : '');
    var turnChanged = g.turn !== L.p;
    if (turnChanged) txt += pname(g.turn) + (g.mode === 'cpu' && g.turn === 1 ? '’s shot.' : ' to shoot.');
    announce(txt);
    beginTurn(false);
    if (fo && g.bih && humanTurn()) say('BALL IN HAND', 'gold', 1.2, true);
  }
  function endGame() {
    var g = S.g;
    S.ending = false;
    sdel(GAME_KEY);
    S.resRec = recordGame(S.st, g);
    persistStats();
    S.phase = 'over';
    stopLoop();
    showCard('results'); setPad('again'); syncHud(); syncHead();
    var win = g.mode === 'practice' || g.mode === '2p' || g.winner === 0;
    if (win) [523, 659, 784, 1047].forEach(function (f, j) { S.snd.tone(f, 0.12, 'triangle', 0.035, 0, j * 0.08); });
    else [392, 330, 262].forEach(function (f, j) { S.snd.tone(f, 0.16, 'triangle', 0.03, 0, j * 0.12); });
    announce(S.ovl.querySelector('.pl-title').textContent + '. ' + (S.ovl.querySelector('.pl-sub') || {}).textContent);
    draw(1);
  }

  // ---- the CPU's turn: think, place, swing the cue round, pull back, strike ----
  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function angDiff(a, b) { var d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
  function stepCpu(dt) {
    var C = S.cpu, g = S.g;
    if (!C || g.phase !== 'aim') return;
    C.t += dt;
    if (C.stage === 'think') {
      if (C.t < 0.55) return;
      var seed = ((g.rs ^ Math.imul(g.nshot + 1, 2654435761)) >>> 0) || 1;
      C.plan = cpuPlan(g, g.turn, g.diff, seed);
      C.from = { x: g.balls[0].x, y: g.balls[0].y, a: S.aim };
      C.stage = C.plan.place ? 'place' : 'aim'; C.t = 0;
      return;
    }
    if (C.stage === 'place') {
      var k = ease(clamp(C.t / 0.5, 0, 1)), c = g.balls[0], pl = C.plan.place;
      c.x = c.px = C.from.x + (pl.x - C.from.x) * k; c.y = c.py = C.from.y + (pl.y - C.from.y) * k;
      if (k >= 1) { c.x = C.from.x; c.y = C.from.y; placeCue(g, pl.x, pl.y); C.stage = 'aim'; C.t = 0; C.from.a = S.aim; }
      return;
    }
    if (C.stage === 'aim') {
      var d = angDiff(C.from.a, C.plan.angle), dur = clamp(Math.abs(d) * 0.5, 0.35, 0.9);
      S.aim = C.from.a + d * ease(clamp(C.t / dur, 0, 1));
      if (C.t >= dur + 0.25) { S.aim = C.plan.angle; C.stage = 'pull'; C.t = 0; }
      return;
    }
    if (C.stage === 'pull') {
      C.pw = C.plan.power * ease(clamp(C.t / 0.45, 0, 1));
      syncPad();
      if (C.t >= 0.6) { var p = C.plan; S.fol = p.fol; S.eng = p.eng; S.cpu = null; fire(p.power); }
    }
  }

  // ---- loop: runs while a game is on screen and something moves ----
  function canRun() { return !!S && S.phase === 'play' && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function kick() { if (S && !S.raf && canRun()) { S.last = 0; S.raf = requestAnimationFrame(frame); } else if (S && !S.raf) draw(1); }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!canRun()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 1 / 60;
    S.last = ts; S.clock += dt;
    pollPad(dt);
    var g = S.g, alpha = 1, busy = false;
    if (g.phase === 'roll') {
      alpha = advance(g, S.acc, dt);
      for (var i = 0; i < 16; i++) {
        var b = g.balls[i], vx = b.vx, vy = b.vy;
        if (vx || vy) { var l = Math.sqrt(vx * vx + vy * vy); S.dir[i][0] = vx / l; S.dir[i][1] = vy / l; }
      }
      handleEvents(g);
      if (g.phase !== 'roll') { alpha = 1; afterShotUI(); }
      busy = true;
    }
    if (S.cpu) { stepCpu(dt); busy = true; }
    // held aim keys / buttons
    var rot = (S.keys.left ? -1 : 0) + (S.keys.right ? 1 : 0) + (S.rotHeld || 0);
    if ((rot || S.gp.ax) && g.phase === 'aim' && humanTurn()) {
      S.rotT += dt;
      var fine = S.keys.shift || S.rotHeld ? 1 : 0, rate = fine ? (S.rotHeld ? 0.06 + Math.min(0.5, S.rotT * 0.25) : 0.06) : 0.7;
      S.aim += (rot * rate + S.gp.ax * 0.9) * dt;
      busy = true;
    } else S.rotT = 0;
    if (S.ending) { S.endT += dt; busy = true; if (S.endT > 1.4) { stepFx(dt); draw(1); endGame(); return; } }
    if (stepFx(dt)) busy = true;
    if (g.phase === 'aim' && humanTurn() && g.bih) busy = true;    // the ball-in-hand ring breathes
    draw(alpha);
    if (busy || S.drag) S.raf = requestAnimationFrame(frame);
  }

  function pause() {
    if (!S || S.phase !== 'play' || S.paused) return;
    S.paused = true; S.rerackArm = false;
    stopLoop(); clearInput();
    showCard('pause'); setPad('resume'); syncHead();
    draw(1);
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null); setPad(humanTurn() ? 'play' : 'cpu'); syncHead();
    kick();
  }
  function padAction(act) {
    if (!S) return;
    S.snd.ensure();
    act = act || S.padMode;
    if (act === 'home' && S.saved) startGame(true);
    else if (act === 'home' || act === 'play') startGame(false);
    else if (act === 'continue') startGame(true);
    else if (act === 'again') { S.set.mode = S.g ? S.g.mode : S.set.mode; startGame(false); }
    else if (act === 'resume') resume();
    else if (act === 'menu') toMenu();
    else if (act === 'start') { showCard('home'); setPad('home'); }
  }

  // ---- input ----
  function clearInput() { S.keys = {}; S.rotHeld = 0; S.drag = null; if (S.gp) S.gp.ax = 0; syncPad(); }
  function canAim() { var g = S && S.g; return !!g && S.phase === 'play' && !S.paused && g.phase === 'aim' && humanTurn() && !S.cardKind; }
  function evPos(e) {
    var r = S.cv.getBoundingClientRect();
    return toWorld((e.clientX - r.left) * S.cw / (r.width || 1), (e.clientY - r.top) * S.ch / (r.height || 1));
  }
  function aimAt(p) {
    var c = S.g.balls[0], dx = p.x - c.x, dy = p.y - c.y;
    if (dx * dx + dy * dy > 0.5) S.aim = Math.atan2(dy, dx);
  }
  function nearCue(p) { var c = S.g.balls[0]; return Math.hypot(p.x - c.x, p.y - c.y) < R * (S.coarse ? 3.4 : 2.2); }
  function onCvDown(e) {
    if (!S || e.button > 0) return;
    e.preventDefault();
    S.snd.ensure();
    if (!canAim()) return;
    var p = evPos(e), g = S.g;
    try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
    if (g.bih && nearCue(p)) S.drag = { id: e.pointerId, mode: 'place', ox: g.balls[0].x - p.x, oy: g.balls[0].y - p.y };
    else if (e.pointerType === 'mouse') { if (!S.locked) aimAt(p); S.drag = { id: e.pointerId, mode: 'pull', x0: p.x, y0: p.y, pw: 0 }; }
    else { S.drag = { id: e.pointerId, mode: 'aim' }; aimAt(p); }
    syncPad(); kick();
  }
  function onCvMove(e) {
    if (!S || !S.g) return;
    var p = evPos(e), d = S.drag;
    if (d && d.id === e.pointerId) {
      if (d.mode === 'place') {
        var x = p.x + d.ox, y = p.y + d.oy, g = S.g;
        if (g.bih === 'kitchen') x = Math.min(x, HEAD_X);
        x = clamp(x, R, W - R); y = clamp(y, R, H - R);
        if (!placeCue(g, x, y)) {
          // slide towards the target as far as it fits
          var c = g.balls[0], bx = c.x, by = c.y;
          for (var t = 0.9; t > 0; t -= 0.1) if (placeCue(g, bx + (x - bx) * t, by + (y - by) * t)) break;
        }
      } else if (d.mode === 'pull') {
        var ux = Math.cos(S.aim), uy = Math.sin(S.aim), back = -((p.x - d.x0) * ux + (p.y - d.y0) * uy);
        d.pw = clamp(back / 28, 0, 1);
        syncPad();
      } else if (d.mode === 'aim') aimAt(p);
      kick();
      return;
    }
    if (!d && e.pointerType === 'mouse' && canAim() && !S.locked) {
      if (S.g.bih && nearCue(p)) { S.cv.style.cursor = 'grab'; return; }
      S.cv.style.cursor = 'crosshair';
      aimAt(p); kick();
    }
  }
  function onCvUp(e) {
    if (!S) return;
    var d = S.drag;
    if (!d || d.id !== e.pointerId) return;
    S.drag = null;
    if (d.mode === 'pull') {
      if (d.pw >= 0.03 && e.type === 'pointerup') { fire(d.pw); return; }
      if (e.type === 'pointerup') {   // a click: lock (or unlock) the aim
        if (S.locked) { S.locked = false; aimAt(evPos(e)); }
        else { S.locked = true; say('AIM LOCKED — CLICK TO FREE', 'muted', 1.1); }
      }
    }
    syncPad(); kick();
  }
  // The power bar: drag right from where you press; let go to shoot; back to the start cancels.
  function onPowDown(e) {
    if (!S || e.button > 0) return;
    var bar = e.target.closest ? e.target.closest('.pl-pow') : null;
    if (!bar) return;
    e.preventDefault();
    S.snd.ensure();
    if (!canAim()) return;
    try { bar.setPointerCapture(e.pointerId); } catch (x) {}
    S.drag = { id: e.pointerId, mode: 'power', x0: e.clientX, w: bar.getBoundingClientRect().width || 200, pw: 0 };
    syncPad(); kick();
  }
  function onPowMove(e) {
    var d = S && S.drag;
    if (!d || d.mode !== 'power' || d.id !== e.pointerId) return;
    d.pw = clamp((e.clientX - d.x0) / (d.w * 0.85), 0, 1);
    syncPad(); kick();
  }
  function onPowUp(e) {
    var d = S && S.drag;
    if (!d || d.mode !== 'power' || d.id !== e.pointerId) return;
    S.drag = null;
    if (e.type === 'pointerup' && d.pw >= 0.03) fire(d.pw);
    else syncPad();
    kick();
  }
  function setSpin(f, e2) {
    var l = Math.sqrt(f * f + e2 * e2);
    if (l > 1) { f /= l; e2 /= l; }
    S.fol = Math.round(f * 20) / 20; S.eng = Math.round(e2 * 20) / 20;
    syncPad();
    if (S.cardKind === 'spin') {
      var dot = S.ovl.querySelector('.pl-spinpad i'), lab = S.ovl.querySelector('.pl-sub');
      if (dot) { dot.style.left = (50 + S.eng * 40) + '%'; dot.style.top = (50 - S.fol * 40) + '%'; }
      if (lab) lab.textContent = spinLabel();
    }
  }
  var KEYMAP = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  var KEY2CODE = { ' ': 'Space', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', enter: 'Enter', escape: 'Escape', p: 'KeyP' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    var code = keyCode(e);
    S.keys.shift = e.shiftKey;
    if (code === 'Escape') {
      e.preventDefault();
      if (S.cardKind === 'spin' || S.cardKind === 'help') { closeCard(); return; }
      if (S.phase === 'play' && !S.paused) pause(); else if (S.paused) resume(); else closePanel();
      return;
    }
    if (S.phase === 'play') {
      if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
      if (S.paused) { if ((code === 'Space' || code === 'Enter') && !(t && t.tagName === 'BUTTON' && S.panel.contains(t))) { e.preventDefault(); if (!e.repeat) resume(); } return; }
      if (S.cardKind === 'help' || S.cardKind === 'spin') {
        if (code === 'Space' || code === 'Enter') { if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return; e.preventDefault(); closeCard(); }
        return;
      }
      if (KEYMAP[code]) { e.preventDefault(); S.keys[KEYMAP[code]] = true; kick(); return; }
      if (!canAim()) { if (code === 'Space' || /^Arrow/.test(code)) e.preventDefault(); return; }
      if (code === 'ArrowUp' || code === 'KeyW') { e.preventDefault(); S.power = clamp(Math.round(S.power * 20 + 1) / 20, 0.05, 1); syncPad(); return; }
      if (code === 'ArrowDown' || code === 'KeyS') { e.preventDefault(); S.power = clamp(Math.round(S.power * 20 - 1) / 20, 0.05, 1); syncPad(); return; }
      if (code === 'KeyI') { e.preventDefault(); setSpin(S.fol + 0.25, S.eng); return; }
      if (code === 'KeyK') { e.preventDefault(); setSpin(S.fol - 0.25, S.eng); return; }
      if (code === 'KeyJ') { e.preventDefault(); setSpin(S.fol, S.eng - 0.25); return; }
      if (code === 'KeyL') { e.preventDefault(); setSpin(S.fol, S.eng + 0.25); return; }
      if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
        if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
        e.preventDefault(); if (!e.repeat) fire(S.power);
      }
      return;
    }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (!e.repeat) { if (S.cardKind === 'help') closeCard(); else padAction(); }
    }
  }
  function onKeyUp(e) {
    if (!S) return;
    var code = keyCode(e);
    S.keys.shift = e.shiftKey;
    if (KEYMAP[code]) S.keys[KEYMAP[code]] = false;
  }
  function closeCard() {
    if (S.phase === 'menu') { showCard('home'); setPad('home'); }
    else if (S.phase === 'over') showCard('results');
    else if (S.paused) showCard('pause');
    else { showCard(null); syncPad(); kick(); }
  }
  // Gamepad: left stick / d-pad aim, LB / RB power, A shoot, Start pause; in menus A presses the big button.
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
    gp.ax = 0;
    if (!p) return;
    var x = p.axes[0] || 0;
    gp.ax = Math.abs(x) > 0.2 ? x * Math.abs(x) : 0;
    if (btnOn(p, 14)) gp.ax = -0.1; else if (btnOn(p, 15)) gp.ax = 0.1;
    var a = btnOn(p, 0), st = btnOn(p, 9), lb = btnOn(p, 4), rb = btnOn(p, 5);
    if (a && !gp.a && canAim()) fire(S.power);
    if (st && !gp.st) { if (S.paused) resume(); else pause(); }
    if (lb && !gp.lb && canAim()) { S.power = clamp(S.power - 0.05, 0.05, 1); syncPad(); }
    if (rb && !gp.rb && canAim()) { S.power = clamp(S.power + 0.05, 0.05, 1); syncPad(); }
    gp.a = a; gp.st = st; gp.lb = lb; gp.rb = rb;
    if (gp.ax) kick();
  }
  function pollMenus() {
    if (!S) return;
    var p = readPad();
    if (!p) return;
    if (S.phase === 'play' && !S.paused) {
      if (!S.raf) { var x = p.axes[0] || 0; if (Math.abs(x) > 0.2 || btnOn(p, 0) || btnOn(p, 9) || btnOn(p, 14) || btnOn(p, 15)) { S.gp.a = false; kick(); } }
      return;
    }
    var a = btnOn(p, 0) || btnOn(p, 9);
    if (a && !S.gp.menuA) { if (S.paused) resume(); else if (S.cardKind === 'help') closeCard(); else padAction(); }
    S.gp.menuA = a;
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S;
    if (s.g && s.g.phase === 'aim' && s.phase === 'play') { var o = saveGame(s.g); if (o) sset(GAME_KEY, JSON.stringify(o)); }
    S = null;
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
    freeCanvas(s.bg);
    (s.spr || []).forEach(freeCanvas); (s.badge || []).forEach(freeCanvas);
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
    var body = '<div class="pl"><div class="pl-hud"></div><div class="pl-stage"><canvas class="pl-cv"></canvas><div class="pl-ovl" style="display:none"></div></div>' +
      '<div class="pl-pad"></div><div class="pl-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🎱 Pool', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'pl-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia, statsRaw = sget(STATS_KEY);
    S = {
      panel: p, head: hb, hud: p.querySelector('.pl-hud'), stage: p.querySelector('.pl-stage'), cv: p.querySelector('.pl-cv'),
      ovl: p.querySelector('.pl-ovl'), pad: p.querySelector('.pl-pad'), liveEl: p.querySelector('.pl-live'),
      st: normStats(sjson(STATS_KEY)), set: normSettings(sjson(SET_KEY)), saved: normGame(sjson(GAME_KEY)), firstRun: !statsRaw && !sget(SET_KEY),
      snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'menu', g: null, preview: null, paused: false, raf: 0, last: 0, clock: 0, acc: { t: 0 },
      aim: 0, power: 0.55, showPow: 0, fol: 0, eng: 0, locked: false, drag: null, cpu: null,
      keys: {}, rotHeld: 0, rotT: 0, gp: { ax: 0, a: false, st: false, lb: false, rb: false, menuA: false }, gpT: 0,
      pal: null, s: 6, vert: false, cw: 0, ch: 0, dpr: 1, msg: null, msgQ: [], shake: 0, dir: [],
      tab: 'play', resetArm: false, rerackArm: false, padMode: '', cardKind: null, nextBreak: 0, nextBreak2: 0, ending: false, endT: 0
    };
    resetDirs();
    makeFx();
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    S.preview = S.saved || newGame('2p', { seed: 1 });
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
        layout(); draw(1);
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); draw(1); } }, 120);
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
        readTheme(); syncPad(); draw(1);
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
        if (S.cardKind === 'help') closeCard();
        else { if (S.phase === 'play' && S.g && S.g.phase !== 'aim') pause(); showCard('help'); }
      }
      try { b.blur(); } catch (er) {}
    });

    // Tapping fast must never zoom, select, magnify or open a callout: the play
    // surfaces cancel their touches outright and the panel swallows gestures.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchmove', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    S.pad.addEventListener('touchstart', function (e) { if (e.target.closest && e.target.closest('.pl-pow, .pl-rot')) noTouch(e); }, { passive: false });
    S.pad.addEventListener('touchmove', function (e) { if (e.target.closest && e.target.closest('.pl-pow, .pl-rot')) noTouch(e); }, { passive: false });
    S.pad.addEventListener('touchend', function (e) {
      var b = e.target.closest && e.target.closest('.pl-pow, .pl-rot');
      if (b) noTouch(e);
    }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    S.cv.addEventListener('pointerdown', onCvDown);
    S.cv.addEventListener('pointermove', onCvMove);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.cv.addEventListener(t, onCvUp); });
    S.cv.addEventListener('pointerleave', function () { if (S) S.cv.style.cursor = ''; });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('pointerdown', function (e) {
      if (!S) return;
      var r = e.target.closest ? e.target.closest('.pl-rot') : null;
      if (r) {
        e.preventDefault();
        if (!canAim()) return;
        try { r.setPointerCapture(e.pointerId); } catch (x) {}
        S.rotHeld = +r.getAttribute('data-rot'); S.rotT = 0; r.classList.add('on');
        S.aim += S.rotHeld * 0.0025;
        kick();
        return;
      }
      onPowDown(e);
    });
    S.pad.addEventListener('pointermove', onPowMove);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) {
      S.pad.addEventListener(t, function (e) {
        if (!S) return;
        var r = e.target.closest ? e.target.closest('.pl-rot') : null;
        if (r) { S.rotHeld = 0; r.classList.remove('on'); }
        onPowUp(e);
      });
    });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b || !S) return;
      var act = b.getAttribute('data-act');
      if (act === 'spin') { if (S.cardKind === 'spin') closeCard(); else if (canAim()) showCard('spin'); return; }
      padAction(act);
    });
    // cards
    function spinFrom(e) {
      var padEl = S.ovl.querySelector('.pl-spinpad');
      if (!padEl) return;
      var r = padEl.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width - 0.5) / 0.4, y = -((e.clientY - r.top) / r.height - 0.5) / 0.4;
      setSpin(clamp(y, -1, 1), clamp(x, -1, 1));
    }
    S.ovl.addEventListener('pointerdown', function (e) {
      if (!S || !e.target.closest || !e.target.closest('.pl-spinpad')) return;
      e.preventDefault();
      S.spinDrag = e.pointerId;
      try { e.target.closest('.pl-spinpad').setPointerCapture(e.pointerId); } catch (x) {}
      spinFrom(e);
    });
    S.ovl.addEventListener('pointermove', function (e) { if (S && S.spinDrag === e.pointerId) spinFrom(e); });
    ['pointerup', 'pointercancel'].forEach(function (t) { S.ovl.addEventListener(t, function () { if (S) S.spinDrag = null; }); });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var act = b.getAttribute('data-act'), tab = b.getAttribute('data-tab'), mode = b.getAttribute('data-mode'), diff = b.getAttribute('data-diff'),
        guide = b.getAttribute('data-guide'), spin = b.getAttribute('data-spin');
      function refocus(sel) { var nb = e.detail === 0 && S.ovl.querySelector(sel); if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} } }
      if (mode || diff || guide) {
        if (mode) S.set.mode = mode; if (diff) S.set.diff = diff; if (guide) S.set.guide = guide;
        persistSet(); showCard('home');
        S.snd.tone(988, 0.04, 'sine', 0.03);
        refocus(mode ? '[data-mode="' + mode + '"]' : diff ? '[data-diff="' + diff + '"]' : '[data-guide="' + guide + '"]');
      } else if (tab) { S.tab = tab; S.resetArm = false; showCard('home'); refocus('[data-tab="' + tab + '"]'); }
      else if (spin) { var q = spin.split(','); setSpin(+q[1], +q[0]); }
      else if (act === 'spin-done' || act === 'close-help') closeCard();
      else if (act === 'reset') { S.resetArm = true; showCard('home'); }
      else if (act === 'reset-no') { S.resetArm = false; showCard('home'); }
      else if (act === 'reset-yes') { S.st = newStats(); persistStats(); S.resetArm = false; Cade.showToast && Cade.showToast('Pool stats reset', 'info', 1800); showCard('home'); }
      else if (act === 'rerack') {
        if (!S.rerackArm) { S.rerackArm = true; showCard('pause'); return; }
        S.set.mode = S.g.mode; S.set.diff = S.g.diff; startGame(false);
      } else if (act) padAction(act);
    });

    if (S.firstRun) {
      persistSet();
      showCard('help'); setPad('start'); syncHud(); syncHead();
      draw(1);
    } else toMenu();
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); draw(1); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('700 12px ' + S.font).then(function () { if (S && S.panel === p) { buildSprites(); buildTable(); draw(1); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: '8-ball pool on an ASCII table — aiming line, spin, vs CPU (easy/normal/hard), pass-and-play or practice racks',
    icon: '🎱',
    tags: 'game,sport,fun,pool,billiards,8-ball,physics,2 player,cpu,practice,ascii',
    open: open,
    _engine: ENGINE
  });
})();
