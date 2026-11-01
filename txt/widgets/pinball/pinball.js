/* Pinball — an ASCII pinball table for Cade.txt.
 * A portrait table drawn in monospace glyphs: two flippers and an upper one,
 * a plunger you charge, three pop bumpers, two slingshots, a bank of drop
 * targets, three top rollover lanes (lane change with the flippers; light all
 * three for a bigger bonus multiplier), two ramps (weak shots roll back), a
 * left orbit with a spinner, a kickback in the left outlane, standup targets
 * that relight it, a scoop that starts missions and multiball, ball save,
 * tilt (nudge, warnings), skill shot, combos, jackpots and an end-of-ball
 * bonus count. 1-4 players take turns (pass-and-play hand-off).
 * Physics: fixed 240 Hz step, each split into substeps so neither a ball nor
 * a flipper moves more than ~2 units per substep (a ball is 13 across, walls
 * are segments, so nothing tunnels); circles vs segments / circles / tapered
 * flipper capsules, flipper surface velocity (omega x r) goes into the
 * impulse. The renderer interpolates between steps (smooth at 60 or 120 Hz).
 * Progress persists in Cade.store (cade-pinball-*). Offline, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // Table units ("px" of a 300 x 560 table), y DOWN, seconds.
  var STEP = 1 / 240, TW = 300, TH = 560, R = 6.5, G = 760, MAXV = 1500, SUBMOVE = 2;
  var FL_UP = 30, FL_DN = 18;              // flipper angular speed (rad/s) up / down
  var BALL_SAVE = 12, MB_SAVE = 15, BONUS_T = 2.8, MISSION_T = 45, COMBO_T = 3.5, COMBO_MAX = 8;   // combo awards stop growing at x8
  var PLUNGE_FULL = 0.9;                   // seconds to a full charge
  var LANE_X = 270, FLOOR_Y = 532, DRAIN_Y = 568;
  var CX = 139;                            // the playfield's mirror line (8 .. 270)
  var PI = Math.PI;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mx(x) { return 2 * CX - x; }

  // Small seeded PRNG (mulberry32), so a game is reproducible.
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- the table (static geometry; mutable state lives in the game) ----
  // seg: { ax, ay, bx, by, k: 'wall'|'sling'|'gate'|'stand'|'drop', e, id }
  function dropY(x) { return 279 - (x - 104) * 0.24; }
  function buildTable() {
    var T = { segs: [], circles: [], drops: [], stands: [], sensors: [], ramps: [], draw: [] };
    function seg(ax, ay, bx, by, k, o) {
      var s = { ax: ax, ay: ay, bx: bx, by: by, k: k || 'wall', e: 0.42, id: -1 };
      if (o) for (var q in o) s[q] = o[q];
      s.dx = bx - ax; s.dy = by - ay; s.l2 = s.dx * s.dx + s.dy * s.dy; s.len = Math.sqrt(s.l2);
      s.minx = Math.min(ax, bx) - R - 8; s.maxx = Math.max(ax, bx) + R + 8; s.miny = Math.min(ay, by) - R - 8; s.maxy = Math.max(ay, by) + R + 8;
      T.segs.push(s);
      return s;
    }
    function poly(pts, k, o, look) {
      for (var i = 0; i + 1 < pts.length; i++) seg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], k, o);
      T.draw.push({ pts: pts, look: look || 'wall' });
    }
    function mir(pts) { return pts.map(function (p) { return [mx(p[0]), p[1]]; }); }
    // outer walls and the arch over the top
    poly([[8, 548], [8, 140]]);
    var arch = [], N = 28;
    for (var i = 0; i <= N; i++) { var a = PI + PI * i / N; arch.push([150 + 142 * Math.cos(a), 140 + 128 * Math.sin(a)]); }
    arch[0] = [8, 140]; arch[N] = [292, 140];
    poly(arch);
    poly([[292, 140], [292, 548]]);
    // the plunger lane, its floor (the plunger's tip) and the one-way gate at its top
    poly([[LANE_X, 548], [LANE_X, 172]]);
    seg(LANE_X, FLOOR_Y, 292, FLOOR_Y, 'wall', { e: 0.1 });
    seg(LANE_X, 172, 292, 147, 'gate', { e: 0.3 });
    T.draw.push({ pts: [[LANE_X, 172], [292, 147]], look: 'gate' });
    // the left orbit's gate: a shot up the orbit goes through; a ball round the arch is turned into the playfield
    seg(8, 150, 48, 168, 'gate', { e: 0.3 });
    T.draw.push({ pts: [[8, 150], [48, 168]], look: 'gate' });
    // bottom: outlane / inlane separators, slingshots (closed triangles; the face kicks)
    var sepL = [[28, 376], [28, 442.6], [88, 472.6]], slL = [[46, 374], [46, 432], [74, 446]];
    poly(sepL); poly(mir(sepL));
    poly(slL); poly(mir(slL));
    seg(74, 446, 46, 374, 'sling', { id: 0, e: 0.3 });
    seg(mx(74), 446, mx(46), 374, 'sling', { id: 1, e: 0.3 });
    T.slings = [slL, mir(slL)];
    // left orbit inner wall = the left ramp channel's left wall
    poly([[36, 330], [36, 224]]);
    // ramp channels: { x0, x1, yl / yr (the sloped roof's ends), y1 (mouth) }; a ball that
    // reaches the roof rides the ramp. Roofs slope so a ball landing on top rolls off.
    var rL = { id: 0, x0: 36, x1: 62, yl: 224, yr: 236, y1: 322 }, rR = { id: 1, x0: 202, x1: 228, yl: 236, yr: 224, y1: 322 };
    [rL, rR].forEach(function (r) {
      r.y0 = Math.min(r.yl, r.yr); r.yc = Math.max(r.yl, r.yr) + R + 4;
      poly([[r.x0, r.y1], [r.x0, r.yl], [r.x1, r.yr], [r.x1, r.y1]], 'wall', null, 'ramp');
    });
    // the ramps' wireforms: left ramp → right inlane, right ramp → left inlane
    rL.path = [[49, 238], [49, 200], [56, 150], [78, 112], [110, 94], [168, 94], [214, 106], [244, 140], [246, 330], [241, 384]];
    rR.path = [[215, 238], [215, 200], [196, 190], [96, 190], [86, 200], [86, 318], [40, 356], [37, 384]];
    [rL, rR].forEach(function (r) {
      var L = 0, cum = [0];
      for (var j = 1; j < r.path.length; j++) { L += Math.hypot(r.path[j][0] - r.path[j - 1][0], r.path[j][1] - r.path[j - 1][1]); cum.push(L); }
      r.cum = cum; r.L = L;
    });
    T.ramps = [rL, rR];
    // top rollover lane guides
    [90, 122, 156, 188].forEach(function (x) { poly([[x, 46], [x, 76]], 'wall', null, 'guide'); });
    // pop bumpers and rubber posts
    T.bumpers = [{ x: 106, y: 128, r: 15 }, { x: 172, y: 128, r: 15 }, { x: 139, y: 172, r: 15 }];
    T.bumpers.forEach(function (b, j) { T.circles.push({ x: b.x, y: b.y, r: b.r, k: 'bumper', id: j, e: 0.5 }); });
    // drop targets: a bank of three guarding the scoop
    // (a slanted bank, so a ball landing on top rolls off rather than balancing there)
    [114, 139, 164].forEach(function (x, j) {
      var s = seg(x - 10, dropY(x - 10), x + 10, dropY(x + 10), 'drop', { id: j, e: 0.35 });
      s.cx = x; s.cy = dropY(x);
      T.drops.push(s);
    });
    // standup targets on the right wall (relight the kickback)
    [[286, 0], [318, 1]].forEach(function (q) {
      var s = seg(264, q[0], 264, q[0] + 16, 'stand', { id: q[1], e: 0.4 });
      T.stands.push(s);
      poly([[264, q[0]], [LANE_X, q[0] - 6]]); poly([[264, q[0] + 16], [LANE_X, q[0] + 22]]);
    });
    // the flippers
    T.flippers = [
      { x: 90, y: 482, len: 40, rb: 7.5, rt: 4, rest: 0.5, up: -0.45, side: 0 },
      { x: mx(90), y: 482, len: 40, rb: 7.5, rt: 4, rest: PI - 0.5, up: PI + 0.45, side: 1 },
      { x: 262, y: 214, len: 32, rb: 6, rt: 3.5, rest: PI - 0.55, up: PI + 0.35, side: 1 }
    ];
    // sensors (circles; entered = a hit)
    function sens(id, x, y, r) { T.sensors.push({ id: id, x: x, y: y, r: r || 8 }); }
    sens('lane0', 106, 64); sens('lane1', 139, 64); sens('lane2', 172, 64);
    sens('inL', 37, 404); sens('inR', mx(37), 404);
    sens('outL', 18, 500); sens('outR', mx(18), 500);
    sens('orbit', 22, 232, 10);
    T.scoop = { x: 139, y: 224, r: 7 };
    T.spinner = { y: 282, x0: 8, x1: 36 };
    T.kicker = { x: 18, y: 500 };
    T.lanes = [106, 139, 172];
    return T;
  }
  var TABLE = buildTable();

  // ---- missions ----
  var MISSIONS = [
    { id: 'ramps', name: 'RAMP RUSH', goal: 4, what: 'ramp shots', award: 100000 },
    { id: 'pops', name: 'POP ART', goal: 25, what: 'bumper hits', award: 75000 },
    { id: 'spin', name: 'SPIN CYCLE', goal: 40, what: 'spinner spins', award: 75000 },
    { id: 'orbit', name: 'ORBITER', goal: 3, what: 'left orbits', award: 100000 },
    { id: 'lanes', name: 'TOP GUN', goal: 6, what: 'top lanes', award: 75000 },
    { id: 'targets', name: 'DEMOLITION', goal: 6, what: 'drop targets', award: 100000 }
  ];

  // ---- a game ----
  function newPlayer() {
    return { score: 0, ball: 1, extra: 0, done: 0, mi: 0, locks: 0, lockNeed: 3, mbN: 0, kick: true, missionLit: true,
      stats: { ramps: 0, jackpots: 0, missions: 0, mbs: 0, spins: 0, pops: 0, orbits: 0 } };
  }
  function newGame(opts) {
    opts = opts || {};
    var n = clamp(opts.players | 0 || 1, 1, 4), nb = opts.balls === 5 ? 5 : 3, seed = (opts.seed >>> 0) || 1;
    var g = {
      seed: seed, rnd: rng(seed), t: 0, steps: 0, acc: 0, nP: n, nBalls: nb, players: [], cur: 0,
      balls: [], nextId: 1, queue: 0, autoT: 0, phase: 'play', events: [],
      fl: TABLE.flippers.map(function (f) { return { a: f.rest, pa: f.rest, w: 0, held: false }; }),
      inp: { l: false, r: false, p: false }, charge: 0, pcharge: 0,
      drops: [true, true, true], dropT: 0, dropDownT: 0, stands: [false, false],
      lanes: [false, false, false], skillLane: 0, skillT: 0, launched: false,
      mult: 1, bonus: 0, saveT: 0, saveUsed: false, mb: false, mbLit: false, jackpot: 0,
      mission: null, tilt: 0, warns: 0, tilted: false,
      spin: { a: 0, pa: 0, w: 0 }, bump: [0, 0, 0], sling: [0, 0], comboT: 0, combo: 0, lastShot: '',
      bonusCalc: null, bonusT: 0, over: false, lastAward: 0
    };
    for (var i = 0; i < n; i++) g.players.push(newPlayer());
    serve(g);
    return g;
  }
  function P(g) { return g.players[g.cur]; }
  function newBall(g, x, y, st) {
    var b = { id: g.nextId++, x: x, y: y, px: x, py: y, vx: 0, vy: 0, st: st || 'play', ht: 0, ramp: null, rs: 0, still: 0, noScoop: 0, flT: 0, ins: {}, age: 0 };
    g.balls.push(b);
    return b;
  }
  function laneBall(g) {
    for (var i = 0; i < g.balls.length; i++) { var b = g.balls[i]; if (b.st === 'play' && b.x > LANE_X && b.y > FLOOR_Y - R - 14) return b; }
    return null;
  }
  // A ball waiting on the plunger for the player (not an auto-launch).
  function waitingInLane(g) { return g.phase === 'play' && g.autoT <= 0 && !!laneBall(g); }
  function serve(g) {
    g.phase = 'play';
    g.balls.length = 0; g.queue = 0; g.autoT = 0;
    newBall(g, 281, FLOOR_Y - R, 'play');
    g.skillLane = Math.floor(g.rnd() * 3); g.skillT = 0; g.launched = false; g.saveT = 0; g.saveUsed = false;
    g.charge = 0; g.pcharge = 0;
    g.events.push({ k: 'serve' });
  }
  function ballsLive(g) { return g.balls.length + g.queue; }

  // ---- scoring ----
  function award(g, pts, x, y) {
    if (g.tilted || g.phase !== 'play') return 0;
    P(g).score += pts; g.lastAward = pts;
    if (x != null) g.events.push({ k: 'pts', p: pts, x: x, y: y });
    return pts;
  }
  function addBonus(g, v) { if (!g.tilted) g.bonus += v; }
  function prog(g, id, n) {
    var m = g.mission;
    if (!m || m.id !== id || g.tilted) return;
    m.n += n || 1;
    if (m.n >= m.goal) {
      var def = MISSIONS[m.idx], p = P(g);
      award(g, def.award);
      addBonus(g, 20000);
      p.done++; p.stats.missions++;
      g.events.push({ k: 'mdone', name: def.name, p: def.award });
      g.mission = null;
      if (p.done % 3 === 0) { p.extra++; g.events.push({ k: 'extra' }); }
      if (p.done % MISSIONS.length === 0) { award(g, 1000000); g.events.push({ k: 'wizard' }); }
    }
  }
  function shot(g, kind, x, y) {
    // combos: ramps and orbits made within COMBO_T of each other
    if (g.comboT > 0 && g.lastShot) g.combo++; else g.combo = 1;
    g.comboT = COMBO_T; g.lastShot = kind;
    if (g.combo >= 2) { award(g, 10000 * Math.min(g.combo, COMBO_MAX), x, y - 10); g.events.push({ k: 'combo', n: g.combo }); }
  }
  function hitRamp(g, id) {
    var r = TABLE.ramps[id], p = P(g), x = r.path[0][0], y = r.path[0][1];
    award(g, 5000, x, y); addBonus(g, 3000); p.stats.ramps++;
    g.events.push({ k: 'ramp', id: id });
    shot(g, 'ramp', x, y);
    if (g.mb) {
      var jp = 50000 + 10000 * g.jackpot;
      award(g, jp, x, y + 12); g.jackpot++; p.stats.jackpots++;
      g.events.push({ k: 'jackpot', p: jp });
    } else if (!g.mbLit) {
      p.locks = Math.min(p.lockNeed, p.locks + 1);
      if (p.locks >= p.lockNeed) { g.mbLit = true; g.events.push({ k: 'mblit' }); }
      else g.events.push({ k: 'lock', n: p.locks, need: p.lockNeed });
    }
    prog(g, 'ramps');
  }
  function hitOrbit(g) {
    award(g, 3000, 22, 232); addBonus(g, 2000); P(g).stats.orbits++;
    g.events.push({ k: 'orbit' });
    shot(g, 'orbit', 22, 232);
    prog(g, 'orbit');
  }
  function hitLane(g, i) {
    var T = TABLE;
    award(g, 500, T.lanes[i], 64); addBonus(g, 1000);
    if (g.skillT > 0) {
      g.skillT = 0;
      if (i === g.skillLane) { award(g, 25000, T.lanes[i], 50); g.events.push({ k: 'skill' }); }
    }
    g.lanes[i] = true;
    g.events.push({ k: 'lane', i: i });
    prog(g, 'lanes');
    if (g.lanes[0] && g.lanes[1] && g.lanes[2]) {
      g.lanes = [false, false, false];
      award(g, 5000);
      if (g.mult < 5) { g.mult++; g.events.push({ k: 'mult', n: g.mult }); } else { award(g, 25000); g.events.push({ k: 'multmax' }); }
    }
  }
  function hitDrop(g, i) {
    if (!g.drops[i]) return;
    g.drops[i] = false;
    award(g, 1500, TABLE.drops[i].cx, TABLE.drops[i].cy); addBonus(g, 1000);
    g.events.push({ k: 'drop', i: i });
    prog(g, 'targets');
    if (!g.drops[0] && !g.drops[1] && !g.drops[2]) {
      award(g, 15000, 139, 252);
      var p = P(g);
      if (!g.mission && !g.mb) p.missionLit = true;
      g.events.push({ k: 'bank' });
      g.dropDownT = 25;     // they stay down for a while: shoot the scoop behind them
    }
  }
  function hitStand(g, i) {
    var p = P(g);
    award(g, 1000, 258, i ? 326 : 294);
    g.stands[i] = true;
    g.events.push({ k: 'stand', i: i });
    if (g.stands[0] && g.stands[1]) {
      g.stands = [false, false];
      if (p.kick) award(g, 10000); else { p.kick = true; g.events.push({ k: 'kicklit' }); }
    }
  }
  function startMission(g) {
    var p = P(g), idx = p.mi % MISSIONS.length, d = MISSIONS[idx];
    g.mission = { idx: idx, id: d.id, name: d.name, goal: d.goal, n: 0, t: MISSION_T };
    p.mi++; p.missionLit = false;
    award(g, 5000);
    g.events.push({ k: 'mission', name: d.name, goal: d.goal, what: d.what });
  }
  function startMultiball(g) {
    var p = P(g);
    g.mb = true; g.mbLit = false; g.jackpot = 0;
    p.locks = 0; p.mbN++; p.lockNeed = Math.min(5, 3 + p.mbN); p.stats.mbs++;
    g.queue += 2; g.saveT = Math.max(g.saveT, MB_SAVE);
    award(g, 20000);
    g.events.push({ k: 'multiball' });
  }
  function scoopAward(g, b) {
    var p = P(g);
    award(g, 2500, TABLE.scoop.x, TABLE.scoop.y); addBonus(g, 2000);
    b.ht = 1.0;
    if (g.mbLit && !g.mb) { startMultiball(g); b.ht = 1.8; }
    else if (p.missionLit && !g.mission && !g.mb) { startMission(g); b.ht = 1.6; }
    else g.events.push({ k: 'scoop' });
    // the scoop is behind the targets: it resets them
    if (!g.drops[0] && !g.drops[1] && !g.drops[2]) g.dropT = 1.2;
  }
  function nudge(g) {
    if (g.phase !== 'play' || g.tilted) return false;
    g.tilt += 1;
    for (var i = 0; i < g.balls.length; i++) {
      var b = g.balls[i];
      if (b.st !== 'play') continue;
      b.vy -= 150; b.vx += (g.rnd() - 0.5) * 140;
    }
    g.events.push({ k: 'nudge' });
    if (g.tilt >= 2.6) {
      g.tilted = true; g.mission = null;
      g.events.push({ k: 'tilt' });
    } else if (g.tilt >= 1.5) { g.warns++; g.events.push({ k: 'warn', n: g.warns }); }
    return true;
  }

  // ---- physics ----
  function collideSeg(g, b, s, dt) {
    if (b.x < s.minx || b.x > s.maxx || b.y < s.miny || b.y > s.maxy) return;
    var t = ((b.x - s.ax) * s.dx + (b.y - s.ay) * s.dy) / s.l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    var qx = s.ax + s.dx * t, qy = s.ay + s.dy * t, dx = b.x - qx, dy = b.y - qy, d2 = dx * dx + dy * dy;
    if (d2 >= R * R) return;
    if (s.k === 'gate') {
      // one way: only a ball coming from the playfield side bumps into it (one in the lane passes)
      var sd = (s.dx * (b.py - s.ay) - s.dy * (b.px - s.ax)) / s.len;
      if (sd > 0) return;
    }
    if (s.k === 'drop' && !g.drops[s.id]) return;
    var front = s.k !== 'drop' || s.dx * (b.y - s.ay) - s.dy * (b.x - s.ax) > 0;   // a drop target only falls when hit from the front
    var d = Math.sqrt(d2), nx, ny;
    if (d < 1e-6) { nx = -s.dy / s.len; ny = s.dx / s.len; d = 0; } else { nx = dx / d; ny = dy / d; }
    b.x += nx * (R - d); b.y += ny * (R - d);
    var vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      var e = -vn < 30 ? 0 : s.e;
      b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny;
      // a little friction along the surface
      var vt = b.vx * -ny + b.vy * nx;
      b.vx -= -ny * vt * 0.004; b.vy -= nx * vt * 0.004;
      if (s.k === 'sling' && -vn > 60 && !g.tilted && g.sling[s.id] <= 0) {
        b.vx += nx * 330; b.vy += ny * 330; g.sling[s.id] = 0.12;
        award(g, 110, qx, qy); addBonus(g, 100);
        g.events.push({ k: 'sling', id: s.id, x: qx, y: qy });
      } else if (s.k === 'drop' && -vn > 25 && front) hitDrop(g, s.id);
      else if (s.k === 'stand' && -vn > 40) hitStand(g, s.id);
      else if (-vn > 260) g.events.push({ k: 'thunk', v: -vn });
    }
  }
  function collideCircle(g, b, c) {
    var dx = b.x - c.x, dy = b.y - c.y, rr = R + c.r, d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) return;
    var d = Math.sqrt(d2) || 1e-6, nx = dx / d, ny = dy / d;
    b.x = c.x + nx * rr; b.y = c.y + ny * rr;
    var vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      b.vx -= (1 + c.e) * vn * nx; b.vy -= (1 + c.e) * vn * ny;
      if (c.k === 'bumper' && !g.tilted) {
        // a pop bumper fires whenever it's touched: the ball leaves fast
        var out = b.vx * nx + b.vy * ny, want = 420;
        if (out < want) { b.vx += nx * (want - out); b.vy += ny * (want - out); }
        if (g.bump[c.id] < 0.13) {
          g.bump[c.id] = 0.18;
          var p = P(g);
          award(g, 300, c.x, c.y - c.r); addBonus(g, 200); p.stats.pops++;
          g.events.push({ k: 'bumper', id: c.id, x: c.x, y: c.y });
          if (g.skillT > 0) g.skillT = 0;
          prog(g, 'pops');
        }
      }
    }
  }
  // A tapered capsule rotating about its pivot; its surface velocity goes into the bounce.
  function collideFlipper(g, b, fd, fs) {
    var ca = Math.cos(fs.a), sa = Math.sin(fs.a), tx = fd.x + ca * fd.len, ty = fd.y + sa * fd.len;
    var rx = b.x - fd.x, ry = b.y - fd.y;
    if (rx * rx + ry * ry > (fd.len + fd.rb + R + 4) * (fd.len + fd.rb + R + 4)) return;
    var t = (rx * ca + ry * sa) / fd.len;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    var qx = fd.x + ca * fd.len * t, qy = fd.y + sa * fd.len * t, rad = fd.rb + (fd.rt - fd.rb) * t;
    var dx = b.x - qx, dy = b.y - qy, d2 = dx * dx + dy * dy, rr = R + rad;
    if (d2 >= rr * rr) return;
    var d = Math.sqrt(d2), nx, ny;
    if (d < 1e-6) { nx = sa; ny = -ca; if (fd.side) { nx = -nx; ny = -ny; } d = 0; } else { nx = dx / d; ny = dy / d; }
    b.x += nx * (rr - d); b.y += ny * (rr - d);
    // the flipper's surface velocity at the contact point: omega x r
    var cx = qx + nx * rad - fd.x, cy = qy + ny * rad - fd.y, fvx = -fs.w * cy, fvy = fs.w * cx;
    var rvx = b.vx - fvx, rvy = b.vy - fvy, vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      var e = -vn < 40 ? 0 : 0.32;
      b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny;
      if (fs.w !== 0 && -vn > 200) g.events.push({ k: 'flip-hit', v: -vn });
    }
    b.flT = 0.1;
    void tx; void ty;
  }
  function collideBalls(a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy, rr = 2 * R;
    if (d2 >= rr * rr || d2 < 1e-9) return;
    var d = Math.sqrt(d2), nx = dx / d, ny = dy / d, pen = (rr - d) / 2;
    a.x -= nx * pen; a.y -= ny * pen; b.x += nx * pen; b.y += ny * pen;
    var vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (vn < 0) {
      var j = -(1 + 0.9) * vn / 2;
      a.vx -= j * nx; a.vy -= j * ny; b.vx += j * nx; b.vy += j * ny;
    }
  }
  function inRamp(b, r) { return b.x > r.x0 && b.x < r.x1 && b.y > r.yc - 8 && b.y < r.y1 + 4; }
  function rampPos(r, s, out) {
    var c = r.cum, p = r.path, i = 1;
    while (i < c.length - 1 && c[i] < s) i++;
    var u = clamp((s - c[i - 1]) / ((c[i] - c[i - 1]) || 1), 0, 1);
    out.x = p[i - 1][0] + (p[i][0] - p[i - 1][0]) * u; out.y = p[i - 1][1] + (p[i][1] - p[i - 1][1]) * u;
    out.dx = (p[i][0] - p[i - 1][0]) / ((c[i] - c[i - 1]) || 1); out.dy = (p[i][1] - p[i - 1][1]) / ((c[i] - c[i - 1]) || 1);
    return out;
  }
  var TMP = { x: 0, y: 0, dx: 0, dy: 0 };

  // Sensors: rollovers, inlanes / outlanes, the orbit; the spinner and the scoop.
  function sensors(g, b) {
    var T = TABLE, S = T.sensors, p = P(g);
    for (var i = 0; i < S.length; i++) {
      var s = S[i], dx = b.x - s.x, dy = b.y - s.y, inside = dx * dx + dy * dy < s.r * s.r;
      if (inside && !b.ins[s.id]) {
        b.ins[s.id] = true;
        var id = s.id;
        if (id.charAt(0) === 'l' && id.slice(0, 4) === 'lane') hitLane(g, +id.charAt(4));
        else if (id === 'inL' || id === 'inR') { award(g, 1000, s.x, s.y); addBonus(g, 1000); g.events.push({ k: 'inlane', id: id }); }
        else if (id === 'outL') {
          if (p.kick && !g.tilted) {
            p.kick = false;
            b.vx = 0; b.vy = -1250; b.x = T.kicker.x;
            award(g, 2000, s.x, s.y - 14);
            g.events.push({ k: 'kickback', x: s.x, y: s.y });
          } else { award(g, 1000, s.x, s.y); g.events.push({ k: 'outlane', id: id }); }
        } else if (id === 'outR') { award(g, 1000, s.x, s.y); g.events.push({ k: 'outlane', id: id }); }
        else if (id === 'orbit' && b.vy < -150) hitOrbit(g);
      } else if (!inside && b.ins[s.id]) b.ins[s.id] = false;
    }
    // the spinner: a ball crossing its line sets it spinning (faster ball, faster spin)
    var sp = T.spinner;
    if (b.x > sp.x0 && b.x < sp.x1 && (b.py - sp.y) * (b.y - sp.y) <= 0 && b.py !== b.y) {
      g.spin.w = Math.max(g.spin.w, Math.min(18, Math.abs(b.vy) / 55));
      g.events.push({ k: 'spinhit' });
    }
    // the scoop
    var sc = T.scoop, ddx = b.x - sc.x, ddy = b.y - sc.y;
    if (b.noScoop <= 0 && ddx * ddx + ddy * ddy < sc.r * sc.r && b.vx * b.vx + b.vy * b.vy < 750 * 750) {
      b.st = 'held'; b.x = sc.x; b.y = sc.y; b.vx = 0; b.vy = 0;
      scoopAward(g, b);
      g.events.push({ k: 'scoopin', x: sc.x, y: sc.y });
    }
  }

  // One fixed step: flippers, balls (substepped), timers, the rules.
  function stepGame(g, inp) {
    var T = TABLE, i, j, b, dt = STEP;
    inp = inp || {};
    var tl = g.tilted || g.phase !== 'play';
    var L = !!inp.l && !tl, Rr = !!inp.r && !tl;
    // lane change on a flipper press
    if (L && !g.inp.l && g.phase === 'play') { g.lanes.push(g.lanes.shift()); g.events.push({ k: 'flip', side: 0 }); }
    if (Rr && !g.inp.r && g.phase === 'play') { g.lanes.unshift(g.lanes.pop()); g.events.push({ k: 'flip', side: 1 }); }
    if (!L && g.inp.l) g.events.push({ k: 'unflip', side: 0 });
    if (!Rr && g.inp.r) g.events.push({ k: 'unflip', side: 1 });
    // the plunger: charge while held (with a ball on it); launch on release
    var lb = g.phase === 'play' ? laneBall(g) : null;
    g.pcharge = g.charge;
    if (inp.p && lb && g.autoT <= 0) g.charge = Math.min(1, g.charge + dt / PLUNGE_FULL);
    else if (!inp.p && g.charge > 0) {
      if (lb && g.charge > 0.04) launch(g, lb, g.charge);
      g.charge = 0;
    } else if (!lb) g.charge = 0;
    g.inp.l = L; g.inp.r = Rr; g.inp.p = !!inp.p;
    g.steps++; g.t += dt;
    for (i = 0; i < g.balls.length; i++) { b = g.balls[i]; b.px = b.x; b.py = b.y; }
    for (i = 0; i < 3; i++) g.fl[i].pa = g.fl[i].a;
    g.spin.pa = g.spin.a;

    // substeps: so nothing moves more than SUBMOVE units in one
    var vmax = 0;
    for (i = 0; i < g.balls.length; i++) { b = g.balls[i]; if (b.st === 'play') vmax = Math.max(vmax, Math.abs(b.vx) + Math.abs(b.vy)); }
    var fmove = 0;
    for (i = 0; i < 3; i++) {
      var fd = T.flippers[i], fs = g.fl[i], want = (i === 0 ? L : Rr) ? fd.up : fd.rest;
      if (fs.a !== want) fmove = Math.max(fmove, ((i === 0 ? L : Rr) ? FL_UP : FL_DN) * fd.len);
    }
    var n = Math.max(2, Math.ceil((vmax + MAXV * 0.1 + fmove) * dt / SUBMOVE)), h = dt / n;
    for (var k = 0; k < n; k++) {
      // flippers turn
      for (i = 0; i < 3; i++) {
        var F = T.flippers[i], st = g.fl[i], held = i === 0 ? L : Rr, tgt = held ? F.up : F.rest, sp = (held ? FL_UP : FL_DN) * h, a0 = st.a;
        if (Math.abs(tgt - st.a) <= sp) st.a = tgt; else st.a += tgt > st.a ? sp : -sp;
        st.w = (st.a - a0) / h; st.held = held;
      }
      for (i = 0; i < g.balls.length; i++) {
        b = g.balls[i];
        if (b.st !== 'play') continue;
        var bx0 = b.x, by0 = b.y;
        b.vy += G * h;
        for (j = 0; j < T.ramps.length; j++) if (inRamp(b, T.ramps[j])) b.vy += 520 * h;   // up the ramp is uphill
        var damp = 1 - 0.06 * h;
        b.vx *= damp; b.vy *= damp;
        var V = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        if (V > MAXV) { b.vx *= MAXV / V; b.vy *= MAXV / V; }
        b.x += b.vx * h; b.y += b.vy * h;
        var opx = b.px, opy = b.py; b.px = bx0; b.py = by0;          // (collideSeg's gate test wants this substep's start)
        for (var pass = 0; pass < 2; pass++) {
          for (j = 0; j < T.segs.length; j++) collideSeg(g, b, T.segs[j], h);
          for (j = 0; j < T.circles.length; j++) collideCircle(g, b, T.circles[j]);
        }
        for (j = 0; j < 3; j++) collideFlipper(g, b, T.flippers[j], g.fl[j]);
        sensors(g, b);
        // ramp capture at the top of a channel
        for (j = 0; j < T.ramps.length && b.st === 'play'; j++) {
          var rp = T.ramps[j];
          if (b.x > rp.x0 && b.x < rp.x1 && b.y < rp.yc && b.y > rp.yl + (rp.yr - rp.yl) * (b.x - rp.x0) / (rp.x1 - rp.x0)) { b.st = 'ramp'; b.ramp = rp; b.rs = 0; b.vx = 0; b.vy = -Math.max(380, -b.vy); hitRamp(g, j); }
        }
        b.px = opx; b.py = opy;
      }
      for (i = 0; i < g.balls.length; i++) for (j = i + 1; j < g.balls.length; j++) {
        if (g.balls[i].st === 'play' && g.balls[j].st === 'play') collideBalls(g.balls[i], g.balls[j]);
      }
    }
    // balls on a ramp, in the scoop; drains; stuck balls
    for (i = g.balls.length - 1; i >= 0; i--) {
      b = g.balls[i];
      b.age += dt;
      if (b.noScoop > 0) b.noScoop -= dt;
      if (b.flT > 0) b.flT -= dt;
      if (b.st === 'ramp') {
        b.rs += 620 * dt;
        if (b.rs >= b.ramp.L) {
          var rr = b.ramp, last = rr.path[rr.path.length - 1];
          rampPos(rr, rr.L, TMP);
          b.st = 'play'; b.x = last[0]; b.y = last[1]; b.vx = TMP.dx * 240; b.vy = TMP.dy * 240; b.ramp = null;
          g.events.push({ k: 'rampout' });
        } else { rampPos(b.ramp, b.rs, TMP); b.x = TMP.x; b.y = TMP.y; }
        continue;
      }
      if (b.st === 'held') {
        b.ht -= dt;
        if (b.ht <= 0) {
          b.st = 'play'; b.vx = -240; b.vy = 210; b.noScoop = 0.8;
          g.events.push({ k: 'eject', x: b.x, y: b.y });
        }
        continue;
      }
      if (b.y > DRAIN_Y || b.x < -20 || b.x > TW + 20 || b.y < -40) { drain(g, i); continue; }
      var spd = Math.abs(b.vx) + Math.abs(b.vy);
      if (spd < 14 && b.flT <= 0 && !(b.x > LANE_X && b.y > FLOOR_Y - 30)) {
        b.still += dt;
        if (b.still > 2.5) { b.still = 0; b.vy = -420; b.vx = (g.rnd() - 0.5) * 240; g.events.push({ k: 'search' }); }
      } else b.still = 0;
    }
    // the multiball queue / ball save re-serves: one ball on the plunger at a time
    if (g.phase === 'play' && g.queue > 0 && !laneBall(g)) {
      g.queue--; newBall(g, 281, FLOOR_Y - R, 'play'); g.autoT = 0.6;
    }
    if (g.autoT > 0) {
      g.autoT -= dt;
      if (g.autoT <= 0) { g.autoT = 0; var ab = laneBall(g); if (ab) launch(g, ab, 0.86, true); }
    }
    // a weak plunge that rolled back to rest on the plunger: the next plunge is a fresh launch
    // (skill shot and the ball save again, and the save didn't tick away while the ball sat there)
    if (g.phase === 'play' && g.launched && !g.mb && g.autoT <= 0 && g.queue === 0 && g.balls.length === 1 && !g.saveUsed) {
      var rb = laneBall(g);
      if (rb && Math.abs(rb.vy) < 5 && rb.y > FLOOR_Y - R - 1.5 && g.charge === 0) { g.launched = false; g.saveT = 0; g.skillT = 0; }
    }
    // timers
    for (i = 0; i < 3; i++) if (g.bump[i] > 0) g.bump[i] -= dt;
    for (i = 0; i < 2; i++) if (g.sling[i] > 0) g.sling[i] -= dt;
    if (g.tilt > 0) g.tilt = Math.max(0, g.tilt - 0.45 * dt);
    if (g.saveT > 0) g.saveT = Math.max(0, g.saveT - dt);
    if (g.skillT > 0) g.skillT = Math.max(0, g.skillT - dt);
    if (g.comboT > 0) { g.comboT -= dt; if (g.comboT <= 0) { g.comboT = 0; g.combo = 0; g.lastShot = ''; } }
    if (g.dropT > 0) { g.dropT -= dt; if (g.dropT <= 0) { g.dropT = 0; g.drops = [true, true, true]; g.dropDownT = 0; g.events.push({ k: 'dropreset' }); } }
    if (g.dropDownT > 0) { g.dropDownT -= dt; if (g.dropDownT <= 0 && !g.dropT) g.dropT = 0.01; }
    if (g.mission) {
      g.mission.t -= dt;
      if (g.mission.t <= 0) { g.events.push({ k: 'mfail', name: g.mission.name }); g.mission = null; P(g).missionLit = true; }
    }
    // the spinner turns down; each half turn scores
    var spn = g.spin;
    if (spn.w > 0) {
      var before = Math.floor(spn.a * 2);
      spn.a += spn.w * dt;
      spn.w = Math.max(0, spn.w - (1.2 + 0.25 * spn.w) * dt);
      var turns = Math.floor(spn.a * 2) - before;
      for (var q = 0; q < turns; q++) {
        award(g, 100); addBonus(g, 50);
        P(g).stats.spins++;
        g.events.push({ k: 'spin' });
        prog(g, 'spin');
      }
    }
    if (g.phase === 'bonus') {
      g.bonusT += dt;
      if (g.bonusT >= BONUS_T) nextBall(g);
    }
  }
  function launch(g, b, c, auto) {
    b.vy = -(520 + 1000 * clamp(c, 0, 1)); b.vx = 0;
    g.events.push({ k: 'launch', c: c, auto: !!auto });
    if (!g.launched) {
      g.launched = true; g.skillT = 4;
      if (!g.saveUsed) g.saveT = Math.max(g.saveT, BALL_SAVE);
    }
  }
  function drain(g, i) {
    var b = g.balls[i];
    g.balls.splice(i, 1);
    if (g.phase !== 'play') return;
    if (!g.tilted && g.saveT > 0) {
      g.queue++;
      if (!g.mb) { g.saveT = 0; g.saveUsed = true; }
      g.events.push({ k: 'saved' });
      return;
    }
    g.events.push({ k: 'drain', x: b.x });
    if (g.mb && ballsLive(g) <= 1) { g.mb = false; g.events.push({ k: 'mbend' }); }
    if (ballsLive(g) === 0) endBall(g);
  }
  function endBall(g) {
    var base = g.tilted ? 0 : g.bonus, mult = g.mult, total = base * mult;
    g.bonusCalc = { base: base, mult: mult, total: total, tilted: g.tilted };
    if (!g.tilted) P(g).score += total;
    g.phase = 'bonus'; g.bonusT = 0; g.mission = null; g.mb = false;
    g.events.push({ k: 'endball', total: total });
  }
  // After the bonus: shoot again, the next player, or game over. Returns the new phase.
  function nextBall(g) {
    var p = P(g), prev = g.cur;
    g.mult = 1; g.bonus = 0; g.lanes = [false, false, false]; g.drops = [true, true, true]; g.dropT = 0; g.dropDownT = 0;
    g.stands = [false, false]; g.tilt = 0; g.warns = 0; g.tilted = false; g.mission = null; g.mb = false; g.mbLit = false;
    g.comboT = 0; g.combo = 0; g.lastShot = ''; g.bonusCalc = null; g.queue = 0; g.balls.length = 0;
    if (p.extra > 0) { p.extra--; g.events.push({ k: 'shootagain' }); }
    else {
      p.ball++;
      var found = -1;
      for (var k = 1; k <= g.nP; k++) {
        var c = (prev + k) % g.nP;
        if (g.players[c].ball <= g.nBalls) { found = c; break; }
      }
      if (found < 0) { g.phase = 'over'; g.over = true; g.events.push({ k: 'over' }); return g.phase; }
      g.cur = found;
    }
    p = P(g);
    g.mbLit = p.locks >= p.lockNeed;
    if (g.nP > 1 && g.cur !== prev) { g.phase = 'next'; g.events.push({ k: 'handoff', p: g.cur }); return g.phase; }
    serve(g);
    return g.phase;
  }
  // The UI calls this when the next player is ready.
  function ready(g) { if (g.phase === 'next') serve(g); }

  // Advance real time dt with the fixed step; returns the render interpolation alpha.
  function advance(g, dt, inp) {
    g.acc = Math.min(g.acc + dt, 0.25);
    while (g.acc >= STEP) { stepGame(g, inp); g.acc -= STEP; }
    return g.acc / STEP;
  }
  // Headless play with a pilot (g → input); for tests.
  function simulate(seed, pilot, maxT, opts) {
    var o = opts || {}; o.seed = seed;
    var g = newGame(o), n = Math.ceil((maxT || 60) / STEP);
    for (var i = 0; i < n && g.phase !== 'over'; i++) {
      if (g.phase === 'next') ready(g);
      stepGame(g, pilot ? pilot(g) : null);
      g.events.length = 0;
    }
    return g;
  }
  // A simple robot: flips when a ball comes down near a flipper; plunges at half charge.
  function autopilot(g) {
    var T = TABLE, l = false, r = false, p = false;
    for (var i = 0; i < g.balls.length; i++) {
      var b = g.balls[i];
      if (b.st !== 'play') continue;
      if (b.x > LANE_X) { p = g.charge < 0.55 + 0.3 * ((g.steps >> 9) % 2); continue; }
      for (var j = 0; j < 3; j++) {
        var F = T.flippers[j], dx = b.x - F.x, dy = b.y - F.y, dir = F.side ? -1 : 1;
        if (dy > -38 && dy < 22 && dx * dir > -6 && dx * dir < F.len + 6 && b.vy > 40) { if (j === 0) l = true; else r = true; }
      }
    }
    return { l: l, r: r, p: p };
  }

  // ---- the save: high scores, records, options ----
  function newSave() {
    return { v: 1, top: [], games: 0, opt: { players: 1, balls: 3 },
      rec: { score: 0, ramps: 0, jackpots: 0, missions: 0, mbs: 0, spins: 0, pops: 0, orbits: 0 } };
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    s.games = Math.max(0, +o.games | 0);
    if (o.opt && typeof o.opt === 'object') {
      s.opt.players = clamp(+o.opt.players | 0 || 1, 1, 4);
      s.opt.balls = +o.opt.balls === 5 ? 5 : 3;
    }
    if (o.rec && typeof o.rec === 'object') for (var k in s.rec) s.rec[k] = Math.max(0, +o.rec[k] || 0);
    if (Array.isArray(o.top)) {
      o.top.forEach(function (e) {
        if (!e || typeof e !== 'object') return;
        var sc = Math.max(0, Math.floor(+e.s || 0));
        if (!sc) return;
        s.top.push({ s: sc, d: typeof e.d === 'string' ? e.d.slice(0, 10) : '', b: +e.b === 5 ? 5 : 3, p: clamp(+e.p | 0 || 1, 1, 4), n: clamp(+e.n | 0 || 1, 1, 4) });
      });
      s.top.sort(function (a, b) { return b.s - a.s; });
      s.top = s.top.slice(0, 10);
    }
    if (s.top.length && s.top[0].s > s.rec.score) s.rec.score = s.top[0].s;
    return s;
  }
  // Fold a finished game into the save; returns the ranks each player made (-1 = none).
  function settle(save, g, date) {
    save.games++;
    var ranks = [];
    var es = g.players.map(function (p, i) {
      var e = { s: p.score, d: date || '', b: g.nBalls, p: g.nP, n: i + 1 };
      if (p.score > 0) save.top.push(e);
      if (p.score > save.rec.score) save.rec.score = p.score;
      for (var k in p.stats) if (k in save.rec && p.stats[k] > save.rec[k]) save.rec[k] = p.stats[k];
      return e;
    });
    save.top.sort(function (a, b) { return b.s - a.s; });
    save.top = save.top.slice(0, 10);
    es.forEach(function (e) { ranks.push(save.top.indexOf(e)); });
    return ranks;
  }

  var ENGINE = {
    STEP: STEP, TW: TW, TH: TH, R: R, G: G, MAXV: MAXV, LANE_X: LANE_X, FLOOR_Y: FLOOR_Y, DRAIN_Y: DRAIN_Y, BALL_SAVE: BALL_SAVE, BONUS_T: BONUS_T,
    MISSION_T: MISSION_T, MISSIONS: MISSIONS, TABLE: TABLE, rng: rng,
    newGame: newGame, stepGame: stepGame, advance: advance, simulate: simulate, autopilot: autopilot, serve: serve, ready: ready,
    nudge: nudge, launch: launch, laneBall: laneBall, waitingInLane: waitingInLane, newBall: newBall, rampPos: rampPos,
    hitRamp: hitRamp, hitOrbit: hitOrbit, hitLane: hitLane, hitDrop: hitDrop, hitStand: hitStand, startMission: startMission, startMultiball: startMultiball,
    endBall: endBall, nextBall: nextBall, ballsLive: ballsLive, player: P,
    newSave: newSave, normSave: normSave, settle: settle
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('pinball.css');

  var PANEL_ID = 'pinball-panel', NAME = 'Pinball';
  var KEY = 'cade-pinball-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var VW = TW, HUD = 36, VH = HUD + TH, CW = 7, RH = 10;
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.pinball = { live: function () { return S; } };   // test-only peek

  // palette slots, filled from the theme (readTheme)
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOLD = 4, C_RED = 5, C_ICE = 6, C_FLAME = 7, C_LEAF = 8, C_VIOLET = 9,
    C_WALL = 10, C_RAIL = 11, C_DIM = 12, C_BG = 13, NPAL = 14;
  var RAINBOW = [C_GOLD, C_FLAME, C_RED, C_VIOLET, C_ICE, C_ACC, C_LEAF];

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
  function today() { var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }

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
  Snd.prototype.arp = function (fs, step, type, vol, dur) { for (var i = 0; i < fs.length; i++) this.tone(fs[i], dur || 0.1, type || 'triangle', vol || 0.035, 0, i * step); };
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
    P[C_WALL] = css(mix(bg, tx, dark ? 0.62 : 0.7)); P[C_RAIL] = css(mix(bg, ac, dark ? 0.5 : 0.45));
    P[C_DIM] = css(mix(bg, tx, dark ? 0.22 : 0.18)); P[C_BG] = css(bg);
    S.col = {
      bg: css(bg), field: css(mix(bg, tx, dark ? 0.035 : 0.025)), hud: css(bg, 0.86), ball: css(mix(tx, bg, dark ? 0.04 : 0.12)),
      acc: css(ac), accSoft: css(mix(bg, ac, 0.16)), sling: css(mix(bg, ac, dark ? 0.2 : 0.14)), rail: css(mix(bg, ac, dark ? 0.09 : 0.07)),
      flip: css(ac), flipEdge: css(mix(ac, tx, 0.35)), gold: P[C_GOLD], dim: P[C_DIM], text: P[C_TEXT],
      font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace'
    };
    fitFont();
  }

  // ---- glyph rendering (as in Dusk Dash: a per-theme atlas of (colour, char) stamps) ----
  var AT_COLS = 24, AT_ROWS = 16;
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '600 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = CW / adv;
    S.fnt = '600 ' + S.fpx.toFixed(3) + 'px ' + f;
    buildAtlas();
    S.baseDirty = true;
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
  function drawStr(c, ci, s, x, y, align, sc, nosnap) {
    var n = s.length, cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, s.charCodeAt(i), x0 + i * cw + cw / 2, y, nosnap, sc);
    return x0 + n * cw;
  }
  var NB = new Uint8Array(24);
  function writeNum(v, comma) {
    var n = 0, ip = Math.max(0, Math.floor(v)), cnt = 0;
    do { if (comma && cnt && cnt % 3 === 0) NB[n++] = 44; NB[n++] = 48 + ip % 10; ip = Math.floor(ip / 10); cnt++; } while (ip > 0 && n < 22);
    for (var a = 0, b = n - 1; a < b; a++, b--) { var t = NB[a]; NB[a] = NB[b]; NB[b] = t; }
    return n;
  }
  function drawNum(c, ci, n, x, y, align, sc) {
    var cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, NB[i], x0 + i * cw + cw / 2, y, false, sc);
    return x0 + n * cw;
  }

  // ---- the static table: walls in glyphs, slings, rails — rendered once per theme / size ----
  function wallChar(dx, dy) {
    var a = Math.atan2(dy, dx);
    if (a < 0) a += PI;
    if (a < PI / 8 || a > 7 * PI / 8) return 45;      // -
    if (a > 3 * PI / 8 && a < 5 * PI / 8) return 124; // |
    return a < PI / 2 ? 92 : 47;                      // \ or /
  }
  // Glyphs along a line, spaced like typed text: '-' at its advance, '|' at its height, diagonals apart.
  function stampLine(c, ci, ax, ay, bx, by, gap, sc, code) {
    var dx = bx - ax, dy = by - ay, L = Math.sqrt(dx * dx + dy * dy), ch = code || wallChar(dx, dy);
    if (!gap) gap = (ch === 45 ? 5.8 : ch === 124 ? 7.5 : 6.4) * (sc || 1);
    var n = Math.max(1, Math.round(L / gap));
    for (var i = 0; i <= n; i++) glyph(c, ci, ch, ax + dx * i / n, ay + dy * i / n, true, sc);
  }
  function buildBase() {
    S.baseDirty = false;
    var cv = S.base || (S.base = document.createElement('canvas'));
    cv.width = S.cv.width; cv.height = S.cv.height;
    var c = cv.getContext('2d'), T = TABLE, i, j;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.fillStyle = S.col.bg; c.fillRect(0, 0, VW, VH);
    c.translate(0, HUD);
    // the playfield's floor
    c.beginPath(); c.moveTo(8, TH);
    for (i = 0; i <= 28; i++) { var a = PI + PI * i / 28; c.lineTo(150 + 142 * Math.cos(a), 140 + 128 * Math.sin(a)); }
    c.lineTo(292, TH); c.closePath(); c.fillStyle = S.col.field; c.fill();
    // ramp wireforms (under the walls: they're "above" in the game, but quiet)
    T.ramps.forEach(function (r) {
      var p = r.path;
      c.strokeStyle = S.col.rail; c.lineWidth = 11; c.lineJoin = 'round'; c.lineCap = 'round';
      c.beginPath(); c.moveTo(p[0][0], p[0][1]);
      for (j = 1; j < p.length; j++) c.lineTo(p[j][0], p[j][1]);
      c.stroke();
      for (j = 1; j < p.length; j++) {
        var dx = p[j][0] - p[j - 1][0], dy = p[j][1] - p[j - 1][1], L = Math.sqrt(dx * dx + dy * dy), nx = -dy / L * 6.5, ny = dx / L * 6.5;
        stampLine(c, C_RAIL, p[j - 1][0] + nx, p[j - 1][1] + ny, p[j][0] + nx, p[j][1] + ny, 6, 0.55, 46);
        stampLine(c, C_RAIL, p[j - 1][0] - nx, p[j - 1][1] - ny, p[j][0] - nx, p[j][1] - ny, 6, 0.55, 46);
      }
    });
    // slingshots: a soft fill, glyph edges
    T.slings.forEach(function (tri) {
      c.beginPath(); c.moveTo(tri[0][0], tri[0][1]); c.lineTo(tri[1][0], tri[1][1]); c.lineTo(tri[2][0], tri[2][1]); c.closePath();
      c.fillStyle = S.col.sling; c.fill();
    });
    // walls
    T.draw.forEach(function (d) {
      var ci = d.look === 'guide' ? C_MUTED : d.look === 'ramp' ? C_RAIL : d.look === 'gate' ? C_FAINT : C_WALL;
      for (j = 0; j + 1 < d.pts.length; j++) stampLine(c, ci, d.pts[j][0], d.pts[j][1], d.pts[j + 1][0], d.pts[j + 1][1], 0, 1);
    });
    // the sling faces in the accent
    T.slings.forEach(function (tri) { stampLine(c, C_ACC, tri[2][0], tri[2][1], tri[0][0], tri[0][1], 0, 1); });
    // spinner posts, scoop rim, labels
    var sp = T.spinner;
    glyph(c, C_MUTED, 111, sp.x0 + 2, sp.y, true, 0.8); glyph(c, C_MUTED, 111, sp.x1 - 2, sp.y, true, 0.8);
    drawStr(c, C_DIM, 'SPIN', 22, sp.y + 22, 'center', 0.7);
    drawStr(c, C_DIM, 'ORBIT', 22, 350, 'center', 0.62);
    // apron: the drain
    drawStr(c, C_DIM, '\\________/', CX, 548, 'center', 0.9);
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---- particles and pop-ups (table coords); pools allocated once ----
  var NPART = 72, NPOP = 10;
  function makeFx() {
    S.parts = [];
    for (var i = 0; i < NPART; i++) S.parts.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, code: 46, ci: 0 });
    S.pops = [];
    for (i = 0; i < NPOP; i++) S.pops.push({ on: false, x: 0, y: 0, t: 0, v: 0, ci: C_GOLD });
    S.pi = 0; S.qi = 0;
  }
  function clearFx() {
    for (var i = 0; i < NPART; i++) S.parts[i].on = false;
    for (i = 0; i < NPOP; i++) S.pops[i].on = false;
    S.msg = null; S.msgQ.length = 0; S.shake = 0; S.flash = 0;
  }
  function spark(x, y, vx, vy, life, code, ci) {
    var p = S.parts[S.pi]; S.pi = (S.pi + 1) % NPART;
    p.on = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.t = 0; p.life = life; p.code = code; p.ci = ci;
  }
  function burst(x, y, n, sp, codes, ci, life) {
    if (S.rm) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * PI * 2, v = sp * (0.35 + Math.random() * 0.65);
      spark(x, y, Math.cos(a) * v, Math.sin(a) * v, (life || 0.5) * (0.6 + Math.random() * 0.5), codes.charCodeAt(i % codes.length), ci < 0 ? RAINBOW[i % RAINBOW.length] : ci);
    }
  }
  function popup(x, y, v, ci) {
    var p = S.pops[S.qi]; S.qi = (S.qi + 1) % NPOP;
    p.on = true; p.x = x; p.y = y; p.t = 0; p.v = v; p.ci = ci == null ? C_GOLD : ci;
  }
  function stepFx(dt) {
    var i, p;
    for (i = 0; i < NPART; i++) {
      p = S.parts[i];
      if (!p.on) continue;
      p.t += dt;
      if (p.t >= p.life) { p.on = false; continue; }
      p.vy += 220 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (i = 0; i < NPOP; i++) { p = S.pops[i]; if (p.on && (p.t += dt) > 1) p.on = false; }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt);
    if (S.flash > 0) S.flash = Math.max(0, S.flash - dt);
    if (S.msg && (S.msg.t += dt) > S.msg.dur) S.msg = S.msgQ.length ? S.msgQ.shift() : null;
  }
  function say(text, ci, dur, queue, sub) {
    var m = { text: text, sub: sub || '', ci: ci == null ? C_TEXT : ci, t: 0, dur: dur || 1.4 };
    if (queue && S.msg && S.msgQ.length < 4) S.msgQ.push(m); else { S.msg = m; S.msgQ.length = 0; }
  }

  // ---- drawing ----
  var TMPB = { x: 0, y: 0, dx: 0, dy: 0 };
  function blink(rate) { return ((S.clock * (rate || 3)) | 0) % 2 === 0; }
  function lamp(c, on, ci, s, x, y, sc) { drawStr(c, on ? ci : C_DIM, s, x, y, 'center', sc || 0.85); }

  function draw(alpha) {
    if (!S || !S.ctx || !S.atl) return;
    if (S.baseDirty || !S.base) buildBase();
    var c = S.ctx, g = S.g, T = TABLE, i, a = alpha;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(S.base, 0, 0);
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (S.shake > 0 && !S.rm) c.translate((Math.random() - 0.5) * S.shake * 14, (Math.random() - 0.5) * S.shake * 14);
    c.translate(0, HUD);
    var p = g ? g.players[g.cur] : null, live = !!g && g.phase === 'play';
    // --- lamps ---
    // top lanes A B C (the skill-shot lane blinks before / just after the launch)
    for (i = 0; i < 3; i++) {
      var lit = g && g.lanes[i], sk = g && live && (!g.launched || g.skillT > 0) && g.skillLane === i;
      lamp(c, lit || (sk && blink(4)), sk && !lit ? C_ACC : C_GOLD, 'ABC'.charAt(i), T.lanes[i], 86, 1.1);
    }
    // bonus multiplier
    for (i = 2; i <= 5; i++) lamp(c, g && g.mult >= i, C_GOLD, i + 'x', CX - 45 + (i - 2) * 30, 452, 0.9);
    // locks / multiball, at the centre
    if (g) {
      var need = p.lockNeed, x0 = CX - (need - 1) * 6;
      if (g.mb) drawStr(c, blink(5) ? C_FLAME : C_GOLD, 'JACKPOT', CX, 352, 'center', 0.9);
      else if (g.mbLit) drawStr(c, blink(4) ? C_ACC : C_FAINT, 'MULTIBALL', CX, 352, 'center', 0.85);
      else drawStr(c, C_DIM, 'LOCK', CX, 352, 'center', 0.75);
      for (i = 0; i < need; i++) glyph(c, g.mb || i < p.locks ? C_ACC : C_DIM, i < p.locks || g.mb ? 64 : 111, x0 + i * 12, 366, false, 0.9);
    }
    // ramp arrows: jackpots in multiball, locks otherwise; mission shots
    T.ramps.forEach(function (r, k) {
      var x = (r.x0 + r.x1) / 2, y = r.y1 + 14, on = false, ci = C_ACC;
      if (g && live) {
        if (g.mb) { on = blink(5); ci = C_GOLD; }
        else if (g.mission && g.mission.id === 'ramps') { on = blink(3); ci = C_FLAME; }
        else if (!g.mbLit) on = true;
        if (g.comboT > 0 && g.lastShot && blink(8)) { on = true; ci = C_ICE; }
      }
      lamp(c, on, ci, '^', x, y, 1.1);
      lamp(c, on, ci, '^', x, y + 7, 1.1);
    });
    // the orbit arrow and the spinner
    var om = g && g.mission && (g.mission.id === 'orbit' || g.mission.id === 'spin');
    lamp(c, om && blink(3), C_FLAME, '^', 22, 336, 1.1);
    var sp = T.spinner, sa = g ? g.spin.pa + (g.spin.a - g.spin.pa) * a : 0, ph = ((sa * 4) % 4 + 4) % 4 | 0;
    var sch = ph === 0 ? 61 : ph === 1 ? 45 : ph === 2 ? 126 : 45;
    for (i = 0; i < 3; i++) glyph(c, g && g.spin.w > 0.3 ? C_GOLD : C_MUTED, sch, sp.x0 + 7 + i * 7, sp.y, false, 1);
    // drop targets
    T.drops.forEach(function (d, k) {
      var up = !g || g.drops[k];
      if (up) {
        stampLine(c, g && g.mission && g.mission.id === 'targets' && blink(3) ? C_FLAME : C_GOLD, d.ax + 3, d.ay, d.bx - 3, d.by, 7, 1, 35);
      } else stampLine(c, C_DIM, d.ax + 2, d.ay + 2, d.bx - 2, d.by + 2, 4, 0.8, 95);
    });
    // standups and the kickback
    T.stands.forEach(function (s, k) { glyph(c, g && g.stands[k] ? C_GOLD : C_MUTED, 93, s.ax - 1, (s.ay + s.by) / 2, false, 1.6); });
    var kOn = !g || p.kick;
    drawStr(c, kOn ? (g && blink(1.5) ? C_LEAF : C_ACC) : C_DIM, 'KICK', 18, 486, 'center', 0.62);
    glyph(c, kOn ? C_ACC : C_DIM, 94, 18, 520, false, 1.1);
    // the scoop: a saucer that glows when it will start something
    var sc = T.scoop, sci = C_MUTED, label = '';
    if (g && live) {
      if (g.mbLit && !g.mb) { sci = C_FLAME; label = 'MB'; }
      else if (p.missionLit && !g.mission && !g.mb) { sci = C_ACC; label = 'GO'; }
    }
    if (label && blink(3)) { c.fillStyle = S.col.accSoft; c.beginPath(); c.arc(sc.x, sc.y, 11, 0, 2 * PI); c.fill(); }
    drawStr(c, sci, '\\_/', sc.x, sc.y + 2, 'center', 1);
    if (label) drawStr(c, sci, label, sc.x, sc.y - 13, 'center', 0.75);
    // ball save
    var save = g && g.saveT > 0 && (g.saveT > 3 || blink(5));
    drawStr(c, save ? C_LEAF : C_DIM, 'SAVE', CX, 520, 'center', 0.8);
    // bumpers: rings of glyphs that flash when they fire
    T.bumpers.forEach(function (b, k) {
      var hot = g && g.bump[k] > 0;
      if (hot) { c.fillStyle = S.col.accSoft; c.beginPath(); c.arc(b.x, b.y, b.r + 2, 0, 2 * PI); c.fill(); }
      for (var q = 0; q < 12; q++) {
        var an = q / 12 * 2 * PI;
        glyph(c, hot ? C_GOLD : C_MUTED, hot ? 42 : 111, b.x + Math.cos(an) * (b.r - 2), b.y + Math.sin(an) * (b.r - 2), true, 0.8);
      }
      glyph(c, hot ? C_GOLD : (g && g.mission && g.mission.id === 'pops' && blink(3)) ? C_FLAME : C_ACC, 64, b.x, b.y, true, 1.3);
    });
    // --- the plunger ---
    var ch = g ? g.pcharge + (g.charge - g.pcharge) * a : 0, lb = g && laneBall(g), py = FLOOR_Y + 1 + ch * 14;
    drawStr(c, C_ACC, '===', 281, py, 'center', 0.95);
    for (i = 0; i < 3; i++) glyph(c, C_MUTED, 90, 281, py + 7 + i * (5 - ch * 2), false, 0.8);
    if (g && live && waitingInLane(g) && !S.rm) drawStr(c, blink(2) ? C_ACC : C_FAINT, 'v', 281, 500, 'center', 1);
    // --- flippers ---
    T.flippers.forEach(function (f, k) {
      var fs = g ? g.fl[k] : null, an = fs ? fs.pa + (fs.a - fs.pa) * a : f.rest;
      drawFlipper(c, f, an);
    });
    // --- balls ---
    if (g) {
      for (i = 0; i < g.balls.length; i++) {
        var b = g.balls[i], bx = b.px + (b.x - b.px) * a, by = b.py + (b.y - b.py) * a;
        if (b.st === 'play' && b.x > LANE_X && b.y > FLOOR_Y - R - 2 && ch > 0) by += ch * 14;
        var onRamp = b.st === 'ramp';
        drawBall(c, bx, by, onRamp ? 1.12 : 1, b);
      }
    }
    // particles + pop-ups
    for (i = 0; i < NPART; i++) {
      var q2 = S.parts[i];
      if (!q2.on) continue;
      c.globalAlpha = Math.min(1, 2.5 * (1 - q2.t / q2.life));
      glyph(c, q2.ci, q2.code, q2.x, q2.y);
    }
    c.globalAlpha = 1;
    for (i = 0; i < NPOP; i++) {
      var pp = S.pops[i];
      if (!pp.on) continue;
      c.globalAlpha = Math.min(1, 3 * (1 - pp.t));
      var n = writeNum(pp.v, true);
      drawNum(c, pp.ci, n, pp.x, pp.y - 10 - pp.t * 22, 'center', 0.8);
    }
    c.globalAlpha = 1;
    // banners: the message queue; TILT; the bonus count
    if (g && g.tilted && g.phase === 'play') banner(c, 'TILT', blink(2) ? C_RED : C_FLAME, 'flippers are dead', 300);
    else if (S.msg) banner(c, S.msg.text, S.msg.ci, S.msg.sub, 300);
    if (g && g.phase === 'bonus' && g.bonusCalc) bonusCard(c, g);
    c.translate(0, -HUD);
    if (g) hud(c, g);
    else idleHud(c);
    if (S.flash > 0 && !S.rm) { c.fillStyle = 'rgba(255,255,255,' + (S.flash * 1.2).toFixed(3) + ')'; c.fillRect(0, 0, VW, VH); }
  }
  function drawFlipper(c, f, an) {
    var ca = Math.cos(an), sa = Math.sin(an), tx = f.x + ca * f.len, ty = f.y + sa * f.len, nx = -sa, ny = ca;
    c.beginPath();
    c.moveTo(f.x + nx * f.rb, f.y + ny * f.rb);
    c.lineTo(tx + nx * f.rt, ty + ny * f.rt);
    c.arc(tx, ty, f.rt, an + PI / 2, an - PI / 2, true);
    c.lineTo(f.x - nx * f.rb, f.y - ny * f.rb);
    c.arc(f.x, f.y, f.rb, an - PI / 2, an + PI / 2, true);
    c.closePath();
    c.fillStyle = S.col.flip; c.fill();
    c.lineWidth = 1; c.strokeStyle = S.col.flipEdge; c.stroke();
    // a row of glyphs along it, the ASCII touch
    c.save(); c.translate(f.x, f.y); c.rotate(an);
    for (var i = 1; i < 5; i++) glyph(c, C_BG, i === 1 ? 111 : 61, f.len * (i - 0.6) / 4.4, 0, true, 0.7);
    c.restore();
  }
  function drawBall(c, x, y, s, b) {
    var r = R * s;
    if (b.st === 'ramp') { c.fillStyle = 'rgba(0,0,0,' + (S.dark ? 0.35 : 0.12) + ')'; c.beginPath(); c.arc(x + 3, y + 4, r, 0, 2 * PI); c.fill(); }
    c.fillStyle = S.col.ball; c.beginPath(); c.arc(x, y, r, 0, 2 * PI); c.fill();
    c.fillStyle = S.col.bg; c.globalAlpha = 0.55; c.beginPath(); c.arc(x - r * 0.35, y - r * 0.35, r * 0.32, 0, 2 * PI); c.fill(); c.globalAlpha = 1;
  }
  function banner(c, s, ci, sub, y) {
    var sc = s.length > 14 ? 1.2 : 1.6, w = s.length * CW * sc + 24, h = sub ? 34 : 22;
    w = Math.max(w, sub ? sub.length * CW * 0.8 + 20 : 0);
    c.fillStyle = S.col.bg; c.fillRect(CX - w / 2, y - 12, w, h);
    c.fillStyle = S.pal[ci]; c.fillRect(CX - w / 2, y - 12, w, 1); c.fillRect(CX - w / 2, y - 12 + h - 1, w, 1);
    drawStr(c, ci, s, CX, y - 1, 'center', sc);
    if (sub) drawStr(c, C_MUTED, sub, CX, y + 14, 'center', 0.8);
  }
  function bonusCard(c, g) {
    var b = g.bonusCalc, t = Math.min(1, g.bonusT / (BONUS_T * 0.6)), shown = Math.floor(b.total * t / 10) * 10;
    if (t >= 1) shown = b.total;
    var y = 270, w = 200, h = b.tilted ? 52 : 74;
    c.fillStyle = S.col.bg; c.fillRect(CX - w / 2, y - 26, w, h);
    c.fillStyle = S.pal[b.tilted ? C_RED : C_ACC]; c.fillRect(CX - w / 2, y - 26, w, 1); c.fillRect(CX - w / 2, y - 27 + h, w, 1);
    if (b.tilted) { drawStr(c, C_RED, 'TILTED', CX, y - 12, 'center', 1.2); drawStr(c, C_MUTED, 'no bonus this ball', CX, y + 10, 'center', 0.85); return; }
    drawStr(c, C_MUTED, '-- BONUS --', CX, y - 14, 'center', 1);
    var n = writeNum(b.base, true), x = drawNum(c, C_TEXT, n, CX - 8, y + 4, 'right', 0.9);
    void x;
    drawStr(c, C_GOLD, 'x' + b.mult, CX + 4, y + 4, 'left', 0.9);
    n = writeNum(shown, true);
    drawNum(c, C_ACC, n, CX, y + 28, 'center', 1.6);
  }
  function hud(c, g) {
    var p = g.players[g.cur], n, y1 = 11, y2 = 27;
    c.fillStyle = S.col.bg; c.fillRect(0, 0, VW, HUD);
    c.fillStyle = S.col.dim; c.fillRect(0, HUD - 1, VW, 1);
    var lab = g.nP > 1 ? 'P' + (g.cur + 1) : 'SCORE';
    drawStr(c, C_MUTED, lab, 6, y1 - 1, 'left', 0.75);
    n = writeNum(p.score, true);
    drawNum(c, C_TEXT, n, 6, y2 - 2, 'left', 1.45);
    // ball, then the others' scores
    var bx = drawStr(c, C_TEXT, Math.min(p.ball, g.nBalls) + '/' + g.nBalls, VW - 6, y1 - 1, 'right', 0.9);
    void bx;
    drawStr(c, C_MUTED, 'BALL ', VW - 6 - CW * 3 * 0.9, y1 - 1, 'right', 0.75);
    var right = '';
    if (g.mission) right = g.mission.name + ' ' + Math.min(g.mission.n, g.mission.goal) + '/' + g.mission.goal + ' ' + Math.ceil(g.mission.t) + 's';
    else if (g.mb) right = 'MULTIBALL';
    else if (g.nP > 1) {
      var parts = [];
      for (var i = 0; i < g.nP; i++) if (i !== g.cur) parts.push('P' + (i + 1) + ' ' + short(g.players[i].score));
      right = parts.join(' ');
    } else if (p.extra) right = 'SHOOT AGAIN';
    else if (g.mult > 1) right = 'BONUS ' + g.mult + 'x';
    if (right) drawStr(c, g.mission ? C_FLAME : g.mb ? C_GOLD : C_MUTED, right, VW - 6, y2, 'right', right.length > 22 ? 0.66 : 0.75);
    // the tilt meter: dots that fill as you nudge
    if (g.tilt > 0.2 && !g.tilted) {
      for (i = 0; i < 3; i++) glyph(c, g.tilt > i + 0.5 ? (i >= 1 ? C_RED : C_GOLD) : C_DIM, 33, VW / 2 + 30 + i * 6, y1 - 1, false, 0.8);
    }
  }
  function short(v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e4 ? Math.round(v / 1000) + 'K' : fmtInt(v); }
  function idleHud(c) {
    c.fillStyle = S.col.bg; c.fillRect(0, 0, VW, HUD);
    c.fillStyle = S.col.dim; c.fillRect(0, HUD - 1, VW, 1);
    drawStr(c, C_MUTED, 'HIGH SCORE', 6, 10, 'left', 0.75);
    var n = writeNum(S.save.rec.score, true);
    drawNum(c, C_TEXT, n, 6, 25, 'left', 1.45);
    drawStr(c, C_ACC, 'PINBALL', VW - 6, 18, 'right', 1.2);
  }

  // ---- events → sound, particles, messages ----
  function handleEvents(g) {
    var ev = g.events, snd = S.snd, i, e, now = S.clock;
    for (i = 0; i < ev.length; i++) {
      e = ev[i];
      switch (e.k) {
        case 'pts': if (e.p >= 1000) popup(e.x, e.y, e.p, e.p >= 25000 ? C_ACC : C_GOLD); break;
        case 'flip': snd.tone(110, 0.05, 'square', 0.03, 70); break;
        case 'flip-hit': if (now - (S.thT || 0) > 0.05) { S.thT = now; snd.tone(180, 0.05, 'triangle', 0.035, 120); } break;
        case 'bumper':
          snd.tone(520 + e.id * 90, 0.07, 'square', 0.035, 380); burst(e.x, e.y, 6, 90, "*'.", C_GOLD, 0.35);
          Cade.haptic && Cade.haptic(5);
          break;
        case 'sling': snd.tone(300, 0.06, 'sawtooth', 0.028, 160); burst(e.x, e.y, 4, 70, "'.", C_ACC, 0.3); break;
        case 'thunk': if (now - (S.thT || 0) > 0.05) { S.thT = now; snd.tone(90 + Math.min(120, e.v / 6), 0.05, 'sine', Math.min(0.05, e.v / 9000)); } break;
        case 'drop': snd.tone(240, 0.08, 'square', 0.035, 120); burst(TABLE.drops[e.i].cx, TABLE.drops[e.i].cy, 5, 70, '#.', C_GOLD, 0.4); break;
        case 'bank': say('TARGETS DOWN', C_GOLD, 1.3, true, 'shoot the scoop'); snd.arp([523, 659, 784], 0.06); break;
        case 'dropreset': snd.tone(330, 0.08, 'square', 0.02, 440); break;
        case 'stand': snd.tone(700, 0.05, 'square', 0.03); break;
        case 'kicklit': say('KICKBACK LIT', C_LEAF, 1.2, true); snd.arp([440, 660], 0.07); break;
        case 'kickback':
          say('KICKBACK!', C_LEAF, 1.1); snd.tone(160, 0.2, 'sawtooth', 0.05, 900); S.shake = 0.15;
          burst(e.x, e.y, 10, 120, "*'.", C_LEAF, 0.5); Cade.haptic && Cade.haptic(12);
          break;
        case 'lane': snd.tone(988 + e.i * 120, 0.07, 'triangle', 0.035); break;
        case 'mult': say('BONUS ' + e.n + 'X', C_GOLD, 1.3, true); snd.arp([659, 784, 988, 1319], 0.06); break;
        case 'multmax': say('MAX BONUS', C_GOLD, 1, true, '+25,000'); break;
        case 'skill': say('SKILL SHOT', C_ACC, 1.6, false, '+25,000'); snd.arp([784, 988, 1175, 1568], 0.06, 'square', 0.03); S.flash = 0.1; break;
        case 'inlane': snd.tone(880, 0.05, 'sine', 0.03); break;
        case 'outlane': if (!g.tilted) snd.tone(200, 0.15, 'sine', 0.04, 120); break;
        case 'orbit': say('ORBIT', C_ICE, 0.9, true); snd.tone(500, 0.18, 'triangle', 0.03, 1200); break;
        case 'spin': if (now - (S.spT || 0) > 0.03) { S.spT = now; snd.tone(1600, 0.025, 'square', 0.015); } break;
        case 'ramp': snd.tone(330, 0.3, 'triangle', 0.035, 990); break;
        case 'rampout': break;
        case 'lock': say('LOCK ' + e.n + ' OF ' + e.need, C_ACC, 1.1, true); break;
        case 'mblit': say('MULTIBALL LIT', C_FLAME, 1.5, true, 'shoot the scoop'); snd.arp([392, 523, 659, 784], 0.08); break;
        case 'multiball':
          say('MULTIBALL', C_FLAME, 2, false, 'ramps score jackpots'); S.flash = 0.15; S.shake = 0.2;
          snd.arp([523, 659, 784, 1047, 784, 1047, 1319], 0.07, 'square', 0.03);
          Cade.haptic && Cade.haptic(20);
          break;
        case 'jackpot':
          say('JACKPOT', C_GOLD, 1.5, false, '+' + fmtInt(e.p)); S.flash = 0.12;
          snd.arp([784, 988, 1175, 1568, 1976], 0.05, 'square', 0.03);
          burst(TABLE.ramps[0].path[0][0], 240, 12, 140, '$*+', -1, 0.8);
          break;
        case 'mbend': say('MULTIBALL OVER', C_MUTED, 1.2, true); break;
        case 'combo': say('COMBO x' + e.n, C_ICE, 1, true); snd.tone(1200, 0.1, 'triangle', 0.03, 1800); break;
        case 'scoopin': snd.tone(140, 0.12, 'sine', 0.05, 90); burst(e.x, e.y, 5, 50, '.o', C_MUTED, 0.4); break;
        case 'eject': snd.tone(220, 0.08, 'sawtooth', 0.03, 440); break;
        case 'scoop': popup(TABLE.scoop.x, TABLE.scoop.y - 4, 2500, C_GOLD); break;
        case 'mission': say(e.name, C_FLAME, 2.4, false, e.goal + ' ' + e.what + ' in ' + MISSION_T + 's'); snd.arp([392, 494, 587, 784], 0.08, 'square', 0.03); break;
        case 'mdone': say('MISSION COMPLETE', C_LEAF, 2, false, e.name + ' +' + fmtInt(e.p)); snd.arp([523, 659, 784, 1047, 1319], 0.07, 'square', 0.03); S.flash = 0.12; burst(CX, 260, 16, 160, "*+'.", -1, 0.9); break;
        case 'mfail': say('TIME UP', C_MUTED, 1.2, true, e.name); snd.tone(300, 0.3, 'triangle', 0.03, 150); break;
        case 'extra': say('EXTRA BALL', C_LEAF, 2, true, 'shoot again'); snd.arp([659, 880, 1109, 1319], 0.08); break;
        case 'wizard': say('WIZARD!', C_VIOLET, 2.4, true, '+1,000,000'); break;
        case 'launch': snd.tone(140 + e.c * 200, 0.18, 'sawtooth', 0.04, 60); break;
        case 'saved': say('BALL SAVED', C_LEAF, 1.4); snd.arp([523, 784], 0.08); break;
        case 'nudge': S.shake = Math.max(S.shake, 0.12); snd.tone(70, 0.08, 'sine', 0.06); Cade.haptic && Cade.haptic(10); break;
        case 'warn': say('DANGER', C_RED, 0.9, false, e.n > 1 ? 'one more and it tilts' : 'easy on the nudges'); snd.tone(180, 0.2, 'square', 0.04); break;
        case 'tilt': snd.tone(110, 0.6, 'sawtooth', 0.05, 55); S.shake = 0.3; Cade.haptic && Cade.haptic(30); break;
        case 'search': break;
        case 'drain':
          if (g.phase === 'play' && E_ballsLive(g) > 0) break;
          snd.tone(330, 0.5, 'triangle', 0.04, 110);
          break;
        case 'endball': S.msg = null; S.msgQ.length = 0; S.cntT = 0; break;
        case 'shootagain': say('SHOOT AGAIN', C_LEAF, 1.6); break;
        case 'serve':
          if (g.nP > 1) say('PLAYER ' + (g.cur + 1), C_ACC, 1.2, false, 'ball ' + Math.min(g.players[g.cur].ball, g.nBalls));
          else say('BALL ' + Math.min(g.players[g.cur].ball, g.nBalls), C_ACC, 1.2, false, S.coarse ? 'hold the bottom to plunge' : 'hold space to plunge');
          break;
        case 'handoff': break;
        case 'over': break;
      }
    }
    ev.length = 0;
  }
  function E_ballsLive(g) { return g.balls.length + g.queue; }

  // ---- loop: runs only while a game is on screen ----
  function running() {
    return !!S && S.phase === 'play' && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)) && S.g && S.g.phase !== 'next' && S.g.phase !== 'over';
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
    var g = S.g, inp = input(), wasBonus = g.phase === 'bonus';
    var al = advance(g, dt, inp);
    if (g.phase === 'bonus' && S.snd.on) {
      S.cntT = (S.cntT || 0) + dt;
      if (S.cntT > 0.07 && g.bonusT < BONUS_T * 0.6 && g.bonusCalc && g.bonusCalc.total > 0) { S.cntT = 0; S.snd.tone(660 + g.bonusT * 400, 0.04, 'square', 0.02); }
    }
    handleEvents(g);
    stepFx(dt);
    syncPad();
    draw(al);
    void wasBonus;
    if (g.phase === 'next') { handoff(); return; }
    if (g.phase === 'over') { gameOver(); return; }
    S.raf = requestAnimationFrame(frame);
  }

  // ---- input: two flipper buttons, the plunger, nudge; keys, pointers, pad, gamepad ----
  var KL = { KeyZ: 1, ShiftLeft: 1, ArrowLeft: 1, KeyA: 1 }, KR = { Slash: 1, ShiftRight: 1, ArrowRight: 1, KeyM: 1, Period: 1 };
  var KP = { Space: 1, ArrowDown: 1, Enter: 1, NumpadEnter: 1 }, KN = { ArrowUp: 1, KeyT: 1, KeyN: 1 };
  var KEY2CODE = { ' ': 'Space', arrowdown: 'ArrowDown', arrowup: 'ArrowUp', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', z: 'KeyZ', a: 'KeyA', m: 'KeyM', '/': 'Slash', '.': 'Period', t: 'KeyT', n: 'KeyN', p: 'KeyP', enter: 'Enter', escape: 'Escape' };
  function keyCode(e) {
    if (e.code) return e.code;
    if (e.key === 'Shift') return e.location === 2 ? 'ShiftRight' : 'ShiftLeft';
    return KEY2CODE[(e.key || '').toLowerCase()] || '';
  }
  function anyOf(map) { for (var k in S.keys) if (S.keys[k] && map[k]) return true; return false; }
  function ptrOf(kind) { for (var id in S.ptrs) if (S.ptrs[id] === kind) return true; return false; }
  // A flipper tap shorter than a frame still flips: each press holds for at least 70 ms.
  function input() {
    var now = performance.now(), gp = S.gp;
    var l = anyOf(KL) || ptrOf('l') || gp.l, r = anyOf(KR) || ptrOf('r') || gp.r, p = anyOf(KP) || ptrOf('p') || gp.p;
    if (l) S.minL = now + 70; if (r) S.minR = now + 70;
    return { l: l || now < S.minL, r: r || now < S.minR, p: p };
  }
  function doNudge() {
    if (!S || !S.g || S.phase !== 'play' || S.paused) return;
    nudge(S.g);
  }
  function clearInput() { S.keys = {}; S.ptrs = {}; S.gp.l = S.gp.r = S.gp.p = false; S.minL = S.minR = 0; syncPad(); }
  function readPad() {
    var pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) return pads[i];
    return null;
  }
  function btnOn(p, i) { var b = p.buttons[i]; return !!b && (b.pressed || b.value > 0.5); }
  // Gamepad: LB/LT/d-pad left = left flipper, RB/RT/d-pad right/B = right, A / d-pad down = plunger, Y / d-pad up = nudge, Start = pause.
  function pollPad() {
    var gp = S.gp, p = readPad();
    if (!p) { gp.l = gp.r = gp.p = false; return; }
    gp.l = btnOn(p, 4) || btnOn(p, 6) || btnOn(p, 14) || (p.axes[0] || 0) < -0.6;
    gp.r = btnOn(p, 5) || btnOn(p, 7) || btnOn(p, 15) || btnOn(p, 1) || (p.axes[2] || 0) > 0.6;
    gp.p = btnOn(p, 0) || btnOn(p, 13);
    var nu = btnOn(p, 3) || btnOn(p, 12);
    if (nu && !gp.nu) doNudge();
    gp.nu = nu;
    var st = btnOn(p, 9);
    if (st && !gp.start && S.phase === 'play' && !S.paused) pause();
    gp.start = st;
  }
  function pollMenus() {
    if (!S || running()) return;
    var p = readPad();
    if (!p) return;
    var a = btnOn(p, 0) || btnOn(p, 9);
    if (a && !S.gp.menuA) padAction();
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
      if (S.phase === 'play' && !S.paused && S.g.phase !== 'next') pause(); else if (S.paused) resume(); else if (S.phase !== 'play') closePanel();   // (never throws away a game at the hand-off)
      return;
    }
    if (S.phase === 'play' && !S.paused && S.g && (S.g.phase === 'play' || S.g.phase === 'bonus')) {
      if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) pause(); return; }
      if (KN[code]) { e.preventDefault(); if (!e.repeat) doNudge(); return; }
      if (KL[code] || KR[code] || KP[code]) { e.preventDefault(); if (!S.keys[code]) { S.keys[code] = true; S.snd.ensure(); syncPad(); } }
      return;
    }
    if (S.paused && code === 'KeyP') { e.preventDefault(); if (!e.repeat) resume(); return; }
    // between games Space / Enter does the big button's job — unless a button in the panel has focus
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (!e.repeat) padAction();
    }
  }
  function onKeyUp(e) {
    if (!S) return;
    var code = keyCode(e);
    if (e.key === 'Shift' && !e.code) { delete S.keys.ShiftLeft; delete S.keys.ShiftRight; }
    if (S.keys[code]) { delete S.keys[code]; syncPad(); }
  }

  // ---- cards ----
  function optBtns(name, vals, cur, fmt) {
    return '<div class="pb-opt"><span class="pb-h">' + name + '</span><div class="pb-seg" role="group" aria-label="' + name + '">' + vals.map(function (v) {
      return '<button type="button" data-opt="' + name.toLowerCase() + '" data-v="' + v + '" class="' + (v === cur ? 'on' : '') + '" aria-pressed="' + (v === cur) + '">' + fmt(v) + '</button>';
    }).join('') + '</div></div>';
  }
  function scoresHtml(max) {
    var top = S.save.top;
    if (!top.length) return '<div class="pb-note">No scores yet — be the first.</div>';
    return '<pre class="pb-tab">' + top.slice(0, max).map(function (e, i) {
      var a = (i + 1 < 10 ? ' ' : '') + (i + 1) + '. ', b2 = fmtInt(e.s), tag = (e.p > 1 ? ' P' + e.n : '') + (e.b === 5 ? ' 5b' : '');
      var mid = new Array(Math.max(1, 15 - b2.length) + 1).join(' ');
      return '<i>' + a + '</i><b>' + esc(b2) + '</b>' + mid + '<i>' + esc(e.d.slice(2)) + esc(tag) + '</i>';
    }).join('\n') + '</pre>';
  }
  var ART = [
    '.-------------------.',
    '|  o    @    @    o |',
    '|    @   \\_/   ###  |',
    '| \\               / |',
    '|  \\___       ___/ =|',
    "'-------------------'"
  ];
  function homeHtml() {
    var sv = S.save, o = sv.opt, h = '<div class="pb-card pb-home">';
    h += '<pre class="pb-art" aria-hidden="true">' + esc(ART.join('\n')) + '</pre>';
    h += '<div class="pb-title">PINBALL</div>';
    h += '<div class="pb-tabs" role="tablist">' + ['play', 'scores'].map(function (tb) {
      return '<button type="button" role="tab" data-tab="' + tb + '" aria-selected="' + (S.tab === tb) + '" class="' + (S.tab === tb ? 'on' : '') + '">' + (tb === 'play' ? 'Play' : 'High scores') + '</button>';
    }).join('') + '</div>';
    if (S.tab === 'play') {
      h += optBtns('Players', [1, 2, 3, 4], o.players, function (v) { return String(v); });
      h += optBtns('Balls', [3, 5], o.balls, function (v) { return v + ' balls'; });
      h += '<p class="pb-tip">' + (o.players > 1 ? 'Take turns, a ball each — pass the device when it says so.' : 'Light the scoop, start missions, lock balls on the ramps for multiball.') + '</p>';
      h += '<div class="pb-note">' + (sv.rec.score ? 'High score ' + fmtInt(sv.rec.score) : (S.coarse ? 'Tap the left / right half to flip' : 'Z and / flip, hold Space to plunge')) + '</div>';
    } else {
      h += scoresHtml(10);
      var r = sv.rec, rows = [['Games', fmtInt(sv.games)], ['Most ramps', String(r.ramps)], ['Most jackpots', String(r.jackpots)], ['Most missions', String(r.missions)], ['Most multiballs', String(r.mbs)]];
      h += '<pre class="pb-tab pb-recs">' + rows.map(function (q) { return esc(q[0]) + new Array(Math.max(1, 22 - q[0].length - q[1].length) + 1).join(' ') + '<b>' + esc(q[1]) + '</b>'; }).join('\n') + '</pre>';
      h += '<div class="pb-foot">' + (S.resetArm ?
        '<span class="pb-confirm">Erase all scores?</span><span><button type="button" class="pb-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="pb-lnk" data-act="reset-no">Keep</button></span>' :
        '<span></span><button type="button" class="pb-lnk" data-act="reset">Reset scores</button>') + '</div>';
    }
    return h + '</div>';
  }
  function helpHtml(first) {
    var keys = S.coarse ?
      '<div><b>tap / hold the left or right half</b> &nbsp;flippers</div><div><b>hold the bottom</b> &nbsp;(or LAUNCH) to pull the plunger, let go to fire</div><div><b>NUDGE</b> &nbsp;shake the table (careful)</div>' :
      '<div><b>Z</b> / <b>Left Shift</b> / <b>&larr;</b> &nbsp;left flipper</div><div><b>/</b> / <b>Right Shift</b> / <b>&rarr;</b> &nbsp;right flippers</div>' +
      '<div><b>hold Space</b> / <b>&darr;</b> &nbsp;pull the plunger, let go to fire</div><div><b>&uarr;</b> / <b>T</b> &nbsp;nudge &nbsp;<span>(3 quick = TILT)</span></div>' +
      '<div><b>P</b> / <b>Esc</b> &nbsp;pause &nbsp;<span>gamepad: bumpers flip, A plunges, Y nudges</span></div>';
    return '<div class="pb-card pb-help">' +
      '<div class="pb-title">PINBALL</div>' +
      '<div class="pb-keys">' + keys + '</div>' +
      '<ul class="pb-rules">' +
      '<li><b>Skill shot</b>: plunge into the blinking top lane.</li>' +
      '<li><b>A B C</b> lanes: light all three to raise the <b>bonus multiplier</b> (flippers move the lit lanes).</li>' +
      '<li><b>Ramps</b> light <b>LOCK</b>s. Lit locks light <b>MULTIBALL</b> at the scoop: ramps then score <b>JACKPOTS</b>.</li>' +
      '<li>Knock down the <b>###</b> targets, then shoot the <b>\\_/</b> scoop behind them to start a <b>mission</b>. Every 3 missions: extra ball.</li>' +
      '<li><b>KICK</b>back saves the left outlane once; the two <b>]</b> standups relight it.</li>' +
      '<li>Ramps and the orbit in quick succession make <b>combos</b>. <b>SAVE</b> lit = a drained ball comes back.</li>' +
      '<li>End of ball: <b>bonus</b> x multiplier. A <b>TILT</b> loses the ball and its bonus.</li></ul>' +
      (first ? '' : '<button type="button" class="pb-go" data-act="close-help">Back</button>') + '</div>';
  }
  function pauseHtml() {
    var g = S.g;
    return '<div class="pb-card pb-pause"><div class="pb-title">PAUSED</div>' +
      '<div class="pb-sub">' + fmtInt(g.players[g.cur].score) + ' &middot; ball ' + Math.min(g.players[g.cur].ball, g.nBalls) + ' of ' + g.nBalls + '</div>' +
      '<div class="pb-btns"><button type="button" class="pb-go" data-act="resume">Resume</button><button type="button" class="pb-go alt" data-act="quit">End game</button></div>' +
      '<div class="pb-note">' + (S.coarse ? 'Tap Resume to carry on' : 'P to resume') + '</div></div>';
  }
  function handoffHtml() {
    var g = S.g, p = g.cur;
    return '<div class="pb-card pb-hand"><div class="pb-title">PLAYER ' + (p + 1) + '</div>' +
      '<div class="pb-sub">Pass to Player ' + (p + 1) + ' &mdash; ball ' + Math.min(g.players[p].ball, g.nBalls) + ' of ' + g.nBalls + '</div>' +
      '<pre class="pb-tab">' + g.players.map(function (q, i) { return (i === p ? '<b>&gt; ' : '<i>  ') + 'P' + (i + 1) + '  ' + fmtInt(q.score) + (i === p ? '</b>' : '</i>'); }).join('\n') + '</pre>' +
      '<button type="button" class="pb-go" data-act="ready">Tap when ready</button></div>';
  }
  function resultsHtml() {
    var g = S.g, rk = S.ranks || [], h = '<div class="pb-card pb-res"><div class="pb-title">GAME OVER</div>';
    if (g.nP === 1) {
      var sc = g.players[0].score;
      h += '<div class="pb-big">' + fmtInt(sc) + '</div>';
      h += rk[0] === 0 ? '<div class="pb-new">** new high score **</div>' : rk[0] > 0 ? '<div class="pb-new">#' + (rk[0] + 1) + ' on the board</div>' : '<div class="pb-sub">high score ' + fmtInt(S.save.rec.score) + '</div>';
    } else {
      var order = g.players.map(function (q, i) { return i; }).sort(function (a, b) { return g.players[b].score - g.players[a].score; });
      var tie = g.players[order[0]].score === g.players[order[1]].score;
      h += '<div class="pb-big">' + (tie ? 'TIE!' : 'P' + (order[0] + 1) + ' WINS') + '</div>';
      h += '<pre class="pb-tab">' + order.map(function (i, k) { return (k === 0 ? '<b>' : '<i>') + (k + 1) + '. P' + (i + 1) + '  ' + fmtInt(g.players[i].score) + (rk[i] === 0 ? '  *best*' : '') + (k === 0 ? '</b>' : '</i>'); }).join('\n') + '</pre>';
    }
    var st = g.players[g.nP === 1 ? 0 : 0].stats;
    if (g.nP === 1) {
      var rows = [['Ramps', st.ramps], ['Jackpots', st.jackpots], ['Missions', st.missions], ['Multiballs', st.mbs], ['Pop bumpers', st.pops], ['Spinner', st.spins]];
      h += '<pre class="pb-tab">' + rows.map(function (q) { var v = String(q[1]); return esc(q[0]) + new Array(Math.max(1, 20 - q[0].length - v.length) + 1).join(' ') + '<b>' + v + '</b>'; }).join('\n') + '</pre>';
    }
    return h + '<div class="pb-note">' + (S.coarse ? '' : 'Space to play again') + '</div></div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'home' ? homeHtml() : kind === 'help' ? helpHtml(S.firstRun) : kind === 'results' ? resultsHtml() : kind === 'pause' ? pauseHtml() : kind === 'hand' ? handoffHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind);
    S.ovl.scrollTop = 0;
  }
  function setPad(mode) {
    var h;
    S.padMode = mode;
    if (mode === 'play') {
      h = '<button type="button" class="pb-fl" data-k="l" aria-label="Left flipper">&#9664; <span>flip</span></button>' +
        '<button type="button" class="pb-mid" data-k="m" aria-label="Launch / nudge"></button>' +
        '<button type="button" class="pb-fl" data-k="r" aria-label="Right flipper"><span>flip</span> &#9654;</button>';
    } else {
      var lab = mode === 'go' ? 'Play' : mode === 'again' ? 'Again' : mode === 'resume' ? 'Resume' : mode === 'start' ? 'Let’s play' : mode === 'ready' ? 'Ready' : 'Back';
      h = '<button type="button" class="pb-act" data-act="' + mode + '">' + lab + (S.coarse ? '' : ' <small>space</small>') + '</button>' +
        (mode === 'again' ? '<button type="button" class="pb-act alt" data-act="home">Menu</button>' : '');
    }
    S.pad.innerHTML = h;
    S.midKind = '';
    syncPad();
  }
  function syncPad() {
    if (!S || S.padMode !== 'play') return;
    var bs = S.pad.querySelectorAll('[data-k]');
    for (var i = 0; i < bs.length; i++) {
      var k = bs[i].getAttribute('data-k');
      if (k === 'm') {
        var w = S.g && (waitingInLane(S.g) || S.g.charge > 0) ? 'launch' : 'nudge';
        if (w !== S.midKind) { S.midKind = w; bs[i].innerHTML = w === 'launch' ? 'Launch <span>hold</span>' : 'Nudge'; bs[i].classList.toggle('launch', w === 'launch'); }
        bs[i].classList.toggle('on', ptrOf('p') || (S.g && S.g.charge > 0));
      } else bs[i].classList.toggle('on', k === 'l' ? (anyOf(KL) || ptrOf('l')) : (anyOf(KR) || ptrOf('r')));
    }
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
    S.cv.setAttribute('aria-label', 'Pinball table — high score ' + fmtInt(S.save.rec.score) + '. Z and slash flip, hold space to plunge, up arrow nudges.');
  }

  function toHome() {
    stopLoop();
    S.phase = 'home'; S.g = null; S.paused = false; S.resetArm = false;
    clearInput(); clearFx();
    showCard('home'); setPad('go'); syncHead(); syncLabel();
    draw(1);
  }
  function startGame() {
    if (!S) return;
    S.snd.ensure();
    var o = S.save.opt;
    S.g = newGame({ players: o.players, balls: o.balls, seed: (Math.random() * 4294967295) >>> 0 });
    S.phase = 'play'; S.paused = false; S.ranks = null; S.overT = 0;
    clearInput(); clearFx();
    showCard(null); setPad('play'); syncHead();
    if (o.players > 1) { S.g.phase = 'next'; S.g.events.length = 0; handoff(); return; }
    handleEvents(S.g);
    kick();
  }
  function handoff() {
    stopLoop(); clearInput();
    showCard('hand'); setPad('ready');
    draw(1);
  }
  function playerReady() {
    if (!S || !S.g || S.g.phase !== 'next') return;
    ENGINE.ready(S.g);
    showCard(null); setPad('play');
    handleEvents(S.g);
    kick();
  }
  function gameOver() {
    stopLoop();
    S.ranks = settle(S.save, S.g, today());
    persist();
    S.phase = 'over'; clearInput();
    showCard('results'); setPad('again'); syncHead(); syncLabel();
    if (S.liveEl) S.liveEl.textContent = 'Game over: ' + S.g.players.map(function (p, i) { return (S.g.nP > 1 ? 'player ' + (i + 1) + ' ' : '') + fmtInt(p.score); }).join(', ') + ' points.';
    if (S.ranks.indexOf(0) >= 0) S.snd.arp([659, 784, 988, 1319], 0.08);
    draw(1);
  }
  function padAction(act) {
    if (!S) return;
    S.snd.ensure();
    act = act || S.padMode;
    if (act === 'go' || act === 'again') startGame();
    else if (act === 'resume') resume();
    else if (act === 'ready') playerReady();
    else if (act === 'home' || act === 'start' || act === 'back') toHome();
  }
  function pause() {
    if (!S || S.phase !== 'play' || S.paused || !S.g || S.g.phase === 'next' || S.g.phase === 'over') return;
    S.paused = true;
    stopLoop(); clearInput();
    showCard('pause'); setPad('resume'); syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null); setPad('play'); syncHead();
    kick();
  }
  function quitGame() {
    if (!S || S.phase !== 'play') return;
    S.paused = false;
    S.g.phase = 'over';
    gameOver();
  }

  // ---- layout ----
  // Height the table may use: the visible viewport minus the panel's top offset and its
  // chrome (title bar, body padding, the pad), measured from the parts themselves — the
  // panel's own height can't be trusted (a panel taller than the window is clamped).
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect(), hd = S.panel.querySelector('.cade-panel-head'), body = S.panel.querySelector('.cade-panel-body');
    var padV = 16;
    try { var cs = getComputedStyle(body); padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0); } catch (e) {}
    var chrome = (hd ? hd.offsetHeight || 40 : 40) + (S.pad.offsetHeight || (S.coarse ? 54 : 46)) + 8 + padV + 6;
    var top = S.panel.classList.contains('cade-solo-panel') ? 0 : Math.min(Math.max(0, r.top), 140);
    return vh - top - chrome - 8;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var s = Math.min((vw - (phone ? 20 : 48)) / VW, solo ? 2 : 1.4), ah = availH(vw, vh);
    s = Math.max(0.5, Math.min(s, ah / VH));
    var cw = Math.floor(VW * s), ch = Math.floor(VH * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--pb-w', Math.max(cw, phone ? 0 : 300) + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / VW;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    if (S.col) fitFont();
  }
  function redraw() { if (!S) return; if (running() && S.raf) return; draw(1); }

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
    freeCanvas(s.base);
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
    var body = '<div class="pb"><div class="pb-stage"><canvas class="pb-cv"></canvas><div class="pb-ovl" style="display:none"></div></div>' +
      '<div class="pb-pad"></div><div class="pb-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🕹️ Pinball', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'pb-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, stage: p.querySelector('.pb-stage'), cv: p.querySelector('.pb-cv'), ovl: p.querySelector('.pb-ovl'),
      pad: p.querySelector('.pb-pad'), liveEl: p.querySelector('.pb-live'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'home', g: null, paused: false, raf: 0, last: 0, clock: 0,
      keys: {}, ptrs: {}, gp: { l: false, r: false, p: false, nu: false, start: false, menuA: false }, gpT: 0, minL: 0, minR: 0,
      pal: new Array(NPAL), col: null, atl: null, base: null, baseDirty: true, k: 1,
      shake: 0, flash: 0, msg: null, msgQ: [], tab: 'play', resetArm: false, padMode: '', cardKind: null, midKind: ''
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
        if (S.phase === 'play') { pause(); if (S.paused) { showCard('help'); S.helpFromPause = true; } }
        else if (S.cardKind === 'help') showCard(S.phase === 'over' ? 'results' : 'home');
        else if (S.phase === 'home' || S.phase === 'over') showCard('help');
      }
      try { b.blur(); } catch (er) {}
    });

    // Fast tapping must never zoom, select, magnify or open a callout.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    [S.cv, S.pad].forEach(function (el) {
      el.addEventListener('touchstart', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
      el.addEventListener('touchmove', noTouch, { passive: false });
      el.addEventListener('touchend', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
    });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    // the table: left half / right half flip; the bottom launches while a ball waits on the plunger
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (S.phase !== 'play' || S.paused || !S.g || (S.g.phase !== 'play' && S.g.phase !== 'bonus')) return;
      var r = S.cv.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      var kind = waitingInLane(S.g) && fy > 0.62 && (fx > 0.5 || !S.g.balls.some(function (b) { return b.x < LANE_X; })) ? 'p' : fx < 0.5 ? 'l' : 'r';
      try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
      S.ptrs[e.pointerId] = kind; syncPad();
    });
    function release(e) { if (S && S.ptrs[e.pointerId]) { delete S.ptrs[e.pointerId]; syncPad(); } }
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.cv.addEventListener(t, release); S.pad.addEventListener(t, release); });
    S.pad.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-k]') : null;
      if (!b || !S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (S.phase !== 'play' || S.paused || !S.g) return;
      var k = b.getAttribute('data-k');
      if (k === 'm') {
        if (waitingInLane(S.g)) k = 'p';
        else { doNudge(); return; }
      }
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      S.ptrs[e.pointerId] = k; syncPad();
    });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (b && S) padAction(b.getAttribute('data-act'));
    });
    // cards
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var tab = b.getAttribute('data-tab'), act = b.getAttribute('data-act'), opt = b.getAttribute('data-opt');
      if (opt) {
        var v = +b.getAttribute('data-v');
        if (opt === 'players') S.save.opt.players = clamp(v, 1, 4); else S.save.opt.balls = v === 5 ? 5 : 3;
        persist(); showCard('home'); S.snd.tone(988, 0.04, 'sine', 0.03);
        var nb = e.detail === 0 && S.ovl.querySelector('[data-opt="' + opt + '"][data-v="' + v + '"]');
        if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
      } else if (tab) {
        S.tab = tab; S.resetArm = false; showCard('home');
        var tb = e.detail === 0 && S.ovl.querySelector('[data-tab="' + tab + '"]');
        if (tb) { try { tb.focus({ preventScroll: true }); } catch (er) {} }
      }
      else if (act === 'reset') { S.resetArm = true; showCard('home'); }
      else if (act === 'reset-no') { S.resetArm = false; showCard('home'); }
      else if (act === 'reset-yes') {
        var opt0 = S.save.opt;
        S.save = newSave(); S.save.opt = opt0;
        persist(); S.resetArm = false;
        Cade.showToast && Cade.showToast('Scores reset', 'info', 1800);
        showCard('home'); draw(1);
      } else if (act === 'close-help') {
        if (S.paused) showCard('pause');
        else if (S.phase === 'over') showCard('results');
        else { S.firstRun = false; showCard('home'); }
      }
      else if (act === 'resume') resume();
      else if (act === 'quit') quitGame();
      else if (act === 'ready') playerReady();
    });

    if (S.firstRun) {
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
    description: 'ASCII pinball — flippers, bumpers, ramps, missions and multiball',
    icon: '🕹️',
    tags: 'game,arcade,fun,pinball,flippers,physics,table,multiball,ascii,2 players',
    open: open,
    _engine: ENGINE
  });
})();
