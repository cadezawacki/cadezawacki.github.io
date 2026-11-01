/* Mini Golf — 18 original ASCII holes for Cade.txt.
 * Top-down courses drawn in monospace glyphs: walls to bank off, windmills,
 * sliding doors, slopes, sand, water (one stroke and back to where you hit
 * from), bridges, wormhole tunnels and bumpers. Drag back from anywhere on
 * the green to aim (the guide shows the line and the power), let go to putt;
 * or aim with the keys / the pad (arrows turn, up / down sets the power,
 * Space putts). 1-4 players take turns on one device — each plays the hole
 * out (or picks up at the stroke cap), the best score on a hole tees off
 * first on the next — and any seat can be a CPU golfer (easy / normal /
 * hard). Front nine, back nine, all eighteen or a practice hole; the
 * scorecard, records and a round in progress persist in Cade.store
 * (cade-minigolf-*).
 * Physics: fixed 120 Hz steps with an accumulator (render interpolates),
 * each step sub-stepped so the ball never moves more than a fraction of its
 * radius; circle vs segment / circle / box collisions with restitution
 * against moving parts' own velocity; rolling friction, sand drag, slope
 * force fields; the cup captures only a slow enough ball (a fast one lips
 * out). The CPU plans by simulating candidate putts with the same engine and
 * scoring where they stop on a path-distance field to the cup.
 * Offline module, no assets. All hole layouts are original. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World units: cells of the hole's grid; x → right, y → down; seconds.
  var STEP = 1 / 120;
  var R = 0.26;                 // ball radius
  var CUP_R = 0.46;             // the cup
  var CAP_V = 7.5;              // a ball faster than this over the cup lips out
  var MAX_V = 30;               // a full-power putt
  var FR_GREEN = 3, KD_GREEN = 0.6;   // rolling friction (cells/s²) and drag (1/s)
  var FR_SAND = 15, KD_SAND = 3.2;
  var SLOPE_A = 6.5;            // slope push (beats rolling friction: a ball can't rest on a slope)
  var E_WALL = 0.74, T_WALL = 0.985, E_BLADE = 0.8;
  var BUMP_R = 0.36, BUMP_KICK = 9;
  var V_STOP = 0.14, SHOT_MAX_T = 30;

  // cell types
  var VOID = 0, WALL = 1, GREEN = 2, SAND = 3, WATER = 4, BRIDGE = 5, SLOPE = 6, BUMP = 7, DIAG = 8, TUN = 9;
  var SLOPES = { '>': [1, 0], '<': [-1, 0], '^': [0, -1], 'v': [0, 1] };

  /* The holes. Legend:
       #  wall          .  green          :  sand          ~  water
       =  bridge        > < ^ v  slope (pushes that way)    o  bumper
       / \  45° wall (bank)        1-4  tunnel mouths (pairs)
       S  tee           H  cup           (space)  out of play
     mills: windmills { x, y (hub, cells), r (blade length), n (blades), w (rad/s), a (phase) }
     doors: sliding blocks { x, y, w, h, dx, dy (travel), p (period s), o (phase 0-1) } */
  var HOLES = [
    { name: 'First Putt', par: 2, tip: 'Bank it off the slanted corner and let it roll down to the cup.', map: [
      '##########################',
      '#.....................\\###',
      '#......................\\##',
      '#..S....................\\#',
      '#........................#',
      '#\\.......................#',
      '###################......#',
      '                  #......#',
      '                  #......#',
      '                  #......#',
      '                  #...H..#',
      '                  #......#',
      '                  #\\..../#',
      '                  ########'] },
    { name: 'Switchback', par: 3, tip: 'Round the end of the wall — the slanted corners turn you back.', map: [
      '########################',
      '#.....................\\#',
      '#..H...................#',
      '#......................#',
      '#......................#',
      '#################......#',
      '#......................#',
      '#......................#',
      '#..S...................#',
      '#...................../#',
      '########################'] },
    { name: 'Bunker Hill', par: 3, tip: 'Sand eats speed. Thread between the bunkers.', map: [
      '##########################',
      '#........................#',
      '#.......:::::............#',
      '#......:::::::.....::....#',
      '#..S....:::::.....::::...#',
      '#.................:::.H..#',
      '#........#####.....::....#',
      '#........#####...........#',
      '#.....:::.......:::......#',
      '#....:::::.....:::::.....#',
      '#........................#',
      '##########################'] },
    { name: 'The Windmill', par: 3, tip: 'Time it: go through the gap when the sails are flat.', mills: [{ x: 11.5, y: 7.5, r: 2.35, n: 2, w: 1.15, a: 0 }], map: [
      '#########################',
      '#..........#............#',
      '#..........#............#',
      '#..........#............#',
      '#..........#............#',
      '#.......................#',
      '#.......................#',
      '#..S....................#',
      '#.......................#',
      '#.......................#',
      '#..........#.........H..#',
      '#..........#............#',
      '#..........#............#',
      '#..........#............#',
      '#########################'] },
    { name: 'Pond Crossing', par: 3, tip: 'Take the bridge for the short way — or go round the pond.', map: [
      '############################',
      '#..........................#',
      '#..S.......................#',
      '#..........................#',
      '#~~~~~~~~====~~~~~~~~~~....#',
      '#~~~~~~~~====~~~~~~~~~~....#',
      '#~~~~~~~~====~~~~~~~~~~....#',
      '#..........................#',
      '#.........H................#',
      '#..........................#',
      '############################'] },
    { name: 'Slip and Slide', par: 3, tip: 'The slope drags you toward the sand. Hit it firmly across.', map: [
      '##########################',
      '#........vvvvvvvv....<<..#',
      '#..S.....vvvvvvvv....<<..#',
      '#........vvvvvvvv....<<..#',
      '#........vvvvvvvv....<<H.#',
      '#........vvvvvvvv....<<..#',
      '#........vvvvvvvv....<<..#',
      '#........::::::::....<<..#',
      '##########################'] },
    { name: 'Pinball', par: 3, tip: 'Bumpers kick the ball away — fast.', map: [
      '########################',
      '#......................#',
      '#..S.......o.......o...#',
      '#......o.......o.......#',
      '#..........o.......o...#',
      '#......o.......o....H..#',
      '#..........o.......o...#',
      '#......o.......o.......#',
      '#..........o...........#',
      '#......................#',
      '########################'] },
    { name: 'Wormholes', par: 3, tip: 'Roll into a tunnel and come out of its twin, same speed and heading.', map: [
      '############################',
      '#3.......#........#........#',
      '#........#........#........#',
      '#........#...3....#....2...#',
      '#..S...1.#........#........#',
      '#........#...H....#.1......#',
      '#........#........#........#',
      '#........#...2....#........#',
      '############################'] },
    { name: 'Gatekeepers', par: 4, tip: 'Two sliding doors. Wait for the gaps.', doors: [
      { x: 9, y: 4, w: 1, h: 2, dx: 0, dy: 2.2, p: 3.2, o: 0 },
      { x: 18, y: 4, w: 1, h: 2, dx: 0, dy: 2.2, p: 2.6, o: 0.4 }], map: [
      '############################',
      '#........#........#........#',
      '#........#........#........#',
      '#........#........#........#',
      '#..S.......................#',
      '#.......................H..#',
      '#........#........#........#',
      '#........#........#........#',
      '#........#........#........#',
      '############################'] },
    { name: 'Serpentine', par: 4, tip: 'Three lanes. Use the slanted corners to turn without stopping.', map: [
      '############################',
      '#/........................\\#',
      '#..S.......................#',
      '#\\.........................#',
      '####################.......#',
      '#/.........................#',
      '#..........................#',
      '#........................./#',
      '#.......####################',
      '#.........................\\#',
      '#......................H...#',
      '#\\......................../#',
      '############################'] },
    { name: 'Island Green', par: 4, tip: 'The cup sits on an island. Two bridges — pick one.', map: [
      '############################',
      '#..........................#',
      '#..S.......................#',
      '#..........................#',
      '#.......~~~~~~~~~~~~~~.....#',
      '#.......~~~~~~~~~~~~~~.....#',
      '#.......~~~.......~~~~.....#',
      '#.......~~~...H...======...#',
      '#.......~~~.......======...#',
      '#.......~~~~~~==~~~~~~.....#',
      '#.......~~~~~~==~~~~~~.....#',
      '#..........................#',
      '############################'] },
    { name: 'Twin Mills', par: 4, tip: 'Two windmills turning opposite ways.', mills: [
      { x: 8.5, y: 6.5, r: 2.35, n: 3, w: 1.0, a: 0 },
      { x: 18.5, y: 6.5, r: 2.35, n: 4, w: -0.8, a: 0.4 }], map: [
      '############################',
      '#.......#.........#........#',
      '#.......#.........#........#',
      '#.......#.........#........#',
      '#..........................#',
      '#..........................#',
      '#.S........................#',
      '#..........................#',
      '#..........................#',
      '#.......#.........#........#',
      '#.......#.........#.....H..#',
      '#.......#.........#........#',
      '############################'] },
    { name: 'The Gutter', par: 3, tip: 'The slopes funnel into the middle. The cup is not in the middle.', map: [
      '############################',
      '#..........................#',
      '#vvvvvvvvvvvvvvvvvvvvvvvvv.#',
      '#vvvvvvvvvvvvvvvvvvvvvvvvv.#',
      '#..S.......................#',
      '#^^^^^^^^^^^^^^^^^^^^^^^^^.#',
      '#^^^^^^^^^^^^^^^^^^^^^^^^^.#',
      '#.....................H....#',
      '#..........................#',
      '############################'] },
    { name: 'Pachinko', par: 4, tip: 'A forest of bumpers. Find a lane.', map: [
      '##########################',
      '#/......................\\#',
      '#..S.....................#',
      '#........................#',
      '#...o...o...o...o...o....#',
      '#.....o...o...o...o...o..#',
      '#...o...o...o...o...o....#',
      '#.....o...o...o...o...o..#',
      '#........................#',
      '#..........H.............#',
      '#\\....................../#',
      '##########################'] },
    { name: 'Rush Hour', par: 3, tip: 'Traffic crosses the fairway, and the cup hides behind a wall. Look both ways.', doors: [
      { x: 8, y: 1.6, w: 1, h: 2, dx: 0, dy: 6.8, p: 3.6, o: 0 },
      { x: 13, y: 8.4, w: 1, h: 2, dx: 0, dy: -6.8, p: 3.0, o: 0.25 },
      { x: 18, y: 1.6, w: 1, h: 2, dx: 0, dy: 6.8, p: 2.4, o: 0.5 }], map: [
      '############################',
      '#..........................#',
      '#..........................#',
      '#......................#...#',
      '#......................#...#',
      '#..S...................#.H.#',
      '#......................#...#',
      '#......................#...#',
      '#..........................#',
      '#..........................#',
      '#..........................#',
      '############################'] },
    { name: 'Lighthouse', par: 4, tip: 'Round the point and over the bridge — or take the tunnel.', map: [
      '############################',
      '#..........#~~~~~~~~~~~~~~~#',
      '#..S.......#~~~~~~~~~~~~~~~#',
      '#..........#~~~~~......~~~~#',
      '#..........#~~~~~..H...~~~~#',
      '#..........#~~~~~......~~~~#',
      '#.....1....#~~~~~~~==~~~~~~#',
      '#..........#~~~~~~~==~~~~~~#',
      '#..........#.........1.....#',
      '#..........................#',
      '#\\......................../#',
      '############################'] },
    { name: 'Volcano', par: 3, tip: 'The cup sits on a crater rim — the slopes run away from it. Not too fast, not too slow.', map: [
      '##########################',
      '#........................#',
      '#..............^^^^^.....#',
      '#.............<^^^^^>....#',
      '#..S..........<<.H.>>....#',
      '#.............<vvvvv>....#',
      '#..............vvvvv.....#',
      '#........................#',
      '#........::::::::::......#',
      '##########################'] },
    { name: 'Grand Finale', par: 4, tip: 'Everything at once. Good luck.', mills: [{ x: 20.5, y: 9.5, r: 2.35, n: 3, w: 1.2, a: 0.3 }], map: [
      '############################',
      '#..S.......o........#......#',
      '#...................#......#',
      '#..........vvvvvv...#..H...#',
      '#..........vvvvvv...#......#',
      '#~~~~~~~...vvvvvv...#..::..#',
      '#~~~~~~~............#......#',
      '#~~~~~~~...::::.....#......#',
      '#~~~~~~~...::::...........\\#',
      '#.......o.................>#',
      '#.........................>#',
      '#.....o...................>#',
      '#\\......................../#',
      '############################'] }
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
  function gauss(r) { var u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  // ---- parse a hole: cells, collision segments (bucketed), features ----
  function parseHole(def) {
    var rows = def.map, H = rows.length, W = 0, x, y, i;
    for (y = 0; y < H; y++) W = Math.max(W, rows[y].length);
    var h = {
      name: def.name, par: def.par, tip: def.tip || '', W: W, H: H, ch: [], t: new Uint8Array(W * H), sx: new Int8Array(W * H), sy: new Int8Array(W * H),
      diagBack: new Int8Array(W * H), segs: [], bk: [], bumps: [], tun: {}, tunAt: new Int16Array(W * H), tee: null, cup: null,
      mills: (def.mills || []).map(function (m) { return { x: m.x, y: m.y, r: m.r, n: m.n, w: m.w, a: m.a || 0 }; }),
      doors: (def.doors || []).map(function (d) { return { x: d.x, y: d.y, w: d.w, h: d.h, dx: d.dx || 0, dy: d.dy || 0, p: d.p || 3, o: d.o || 0 }; })
    };
    for (i = 0; i < W * H; i++) h.tunAt[i] = -1;
    for (y = 0; y < H; y++) {
      var row = [];
      for (x = 0; x < W; x++) {
        var c = rows[y].charAt(x) || ' ', k = y * W + x, ty = GREEN;
        if (c === ' ') ty = VOID;
        else if (c === '#') ty = WALL;
        else if (c === ':') ty = SAND;
        else if (c === '~') ty = WATER;
        else if (c === '=') ty = BRIDGE;
        else if (SLOPES[c]) { ty = SLOPE; h.sx[k] = SLOPES[c][0]; h.sy[k] = SLOPES[c][1]; }
        else if (c === 'o') { ty = BUMP; h.bumps.push({ x: x + 0.5, y: y + 0.5, hit: 0 }); }
        else if (c === '/' || c === '\\') ty = DIAG;
        else if (c >= '1' && c <= '9') { ty = TUN; (h.tun[c] = h.tun[c] || []).push(k); }
        else if (c === 'S') h.tee = { x: x + 0.5, y: y + 0.5 };
        else if (c === 'H') h.cup = { x: x + 0.5, y: y + 0.5 };
        h.t[k] = ty; row.push(c);
      }
      h.ch.push(row);
    }
    // tunnel pairs: each mouth knows its twin
    for (var d in h.tun) { var L = h.tun[d]; if (L.length === 2) { h.tunAt[L[0]] = L[1]; h.tunAt[L[1]] = L[0]; } }
    function solid(cx, cy) { if (cx < 0 || cy < 0 || cx >= W || cy >= H) return true; var tt = h.t[cy * W + cx]; return tt === WALL || tt === VOID; }
    h.solid = solid;
    // wall faces: a solid cell's side that faces a playable cell; merged along runs
    var hs = {}, vs = {};
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      if (!solid(x, y)) continue;
      if (!solid(x, y - 1)) hs[y + ',' + x] = 1;          // top face at line y
      if (!solid(x, y + 1)) hs[(y + 1) + ',' + x] = 1;    // bottom face at line y+1
      if (!solid(x - 1, y)) vs[x + ',' + y] = 1;          // left face at line x
      if (!solid(x + 1, y)) vs[(x + 1) + ',' + y] = 1;
    }
    var ly, lx;
    for (ly = 0; ly <= H; ly++) for (x = 0; x <= W; x++) {
      if (!hs[ly + ',' + x] || hs[ly + ',' + (x - 1)]) continue;
      var x1 = x; while (hs[ly + ',' + (x1 + 1)]) x1++;
      h.segs.push(mkSeg(x, ly, x1 + 1, ly));
    }
    for (lx = 0; lx <= W; lx++) for (y = 0; y <= H; y++) {
      if (!vs[lx + ',' + y] || vs[lx + ',' + (y - 1)]) continue;
      var y1 = y; while (vs[lx + ',' + (y1 + 1)]) y1++;
      h.segs.push(mkSeg(lx, y, lx, y1 + 1));
    }
    // 45° walls; which half is solid (the half whose neighbours are walls), for the escape check
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var ch = h.ch[y][x];
      if (ch === '/') {
        h.segs.push(mkSeg(x, y + 1, x + 1, y));
        var tl = solid(x - 1, y) && solid(x, y - 1), br = solid(x + 1, y) && solid(x, y + 1);
        h.diagBack[y * W + x] = tl && !br ? 1 : br && !tl ? 2 : 0;    // 1: top-left half solid, 2: bottom-right
      } else if (ch === '\\') {
        h.segs.push(mkSeg(x, y, x + 1, y + 1));
        var tr = solid(x + 1, y) && solid(x, y - 1), bl = solid(x - 1, y) && solid(x, y + 1);
        h.diagBack[y * W + x] = tr && !bl ? 3 : bl && !tr ? 4 : 0;    // 3: top-right half solid, 4: bottom-left
      }
    }
    // buckets: each cell lists the segments within reach of a ball centred in it
    var m = R + 0.05;
    for (i = 0; i < W * H; i++) h.bk.push([]);
    h.segs.forEach(function (s, si) {
      var ax = Math.floor(Math.min(s.x1, s.x2) - m), bx = Math.floor(Math.max(s.x1, s.x2) + m),
        ay = Math.floor(Math.min(s.y1, s.y2) - m), by = Math.floor(Math.max(s.y1, s.y2) + m);
      for (var cy = Math.max(0, ay); cy <= Math.min(H - 1, by); cy++) for (var cx = Math.max(0, ax); cx <= Math.min(W - 1, bx); cx++) h.bk[cy * W + cx].push(si);
    });
    // bounding box of everything in play (the camera frames it)
    var bx0 = W, by0 = H, bx1 = 0, by1 = 0;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) if (h.t[y * W + x] !== VOID) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x + 1); by1 = Math.max(by1, y + 1); }
    h.box = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    h.dist = distField(h);
    return h;
  }
  function mkSeg(x1, y1, x2, y2) { var dx = x2 - x1, dy = y2 - y1; return { x1: x1, y1: y1, x2: x2, y2: y2, dx: dx, dy: dy, l2: dx * dx + dy * dy }; }

  function cellAt(h, x, y) {
    var cx = Math.floor(x), cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= h.W || cy >= h.H) return -1;
    return cy * h.W + cx;
  }
  // Is a point inside the solid part of the hole (wall, void, the back of a 45° wall)?
  function inSolid(h, x, y) {
    var k = cellAt(h, x, y);
    if (k < 0) return true;
    var t = h.t[k];
    if (t === WALL || t === VOID) return true;
    if (t === DIAG) {
      var fx = x - Math.floor(x), fy = y - Math.floor(y), b = h.diagBack[k];
      if (b === 1) return fx + fy < 1 - 0.02;
      if (b === 2) return fx + fy > 1 + 0.02;
      if (b === 3) return fx > fy + 0.02;
      if (b === 4) return fy > fx + 0.02;
    }
    return false;
  }

  // Path distance (cells) from every cell to the cup, around walls and water; tunnels count.
  function distField(h) {
    var W = h.W, N = W * h.H, D = new Float32Array(N), done = new Uint8Array(N), i;
    for (i = 0; i < N; i++) D[i] = 1e9;
    if (!h.cup) return D;
    var c0 = Math.floor(h.cup.y) * W + Math.floor(h.cup.x);
    D[c0] = 0;
    function ok(k) { var t = h.t[k]; return t !== WALL && t !== VOID && t !== WATER && t !== BUMP; }
    function cost(k) { var t = h.t[k]; return t === SAND ? 2.2 : 1; }
    var nb = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
    for (;;) {   // Dijkstra, O(N²) — the grids are tiny
      var best = -1, bd = 1e9;
      for (i = 0; i < N; i++) if (!done[i] && D[i] < bd) { bd = D[i]; best = i; }
      if (best < 0) break;
      done[best] = 1;
      var x = best % W, y = (best / W) | 0;
      for (var j = 0; j < 8; j++) {
        var nx = x + nb[j][0], ny = y + nb[j][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= h.H) continue;
        var nk = ny * W + nx;
        if (!ok(nk) || done[nk]) continue;
        if (j >= 4 && (!ok(y * W + nx) || !ok(ny * W + x))) continue;   // no cutting wall corners
        var nd = bd + nb[j][2] * (cost(nk) + cost(best)) / 2;
        if (h.t[best] === SLOPE) { var sdot = -(h.sx[best] * nb[j][0] + h.sy[best] * nb[j][1]); nd += sdot > 0 ? 0.6 : 0; }
        if (nd < D[nk]) D[nk] = nd;
      }
      if (h.t[best] === TUN && h.tunAt[best] >= 0 && !done[h.tunAt[best]] && bd + 1 < D[h.tunAt[best]]) D[h.tunAt[best]] = bd + 1;
    }
    return D;
  }

  // ---- moving parts, as functions of the hole's clock t ----
  function millAngle(m, t) { return m.a + m.w * t; }
  function doorAt(d, t, out) {
    var s = Math.sin(2 * Math.PI * (t / d.p + d.o)), c = Math.cos(2 * Math.PI * (t / d.p + d.o)), k = 2 * Math.PI / d.p;
    out.x = d.x + d.dx * 0.5 * (1 + s); out.y = d.y + d.dy * 0.5 * (1 + s);
    out.vx = d.dx * 0.5 * c * k; out.vy = d.dy * 0.5 * c * k;
    return out;
  }

  // ---- the ball ----
  function newBall(x, y) {
    return { x: x, y: y, px: x, py: y, vx: 0, vy: 0, st: 'rest', restT: 0, rollT: 0, tun: -1, ev: [], hitV: 0 };
  }
  function speed(b) { return Math.sqrt(b.vx * b.vx + b.vy * b.vy); }
  function putt(b, ang, pow) {
    pow = clamp(pow, 0, 1);
    var v = MAX_V * pow;
    b.vx = Math.cos(ang) * v; b.vy = Math.sin(ang) * v;
    b.st = 'roll'; b.restT = 0; b.rollT = 0;
  }

  var TMP = { x: 0, y: 0, vx: 0, vy: 0 };
  // Push the ball off a segment (moving with velocity svx, svy at the contact); returns the impact speed.
  function hitSeg(b, x1, y1, dx, dy, l2, th, svx, svy, e) {
    var u = l2 > 0 ? clamp(((b.x - x1) * dx + (b.y - y1) * dy) / l2, 0, 1) : 0;
    var px = x1 + dx * u, py = y1 + dy * u, ox = b.x - px, oy = b.y - py, d2 = ox * ox + oy * oy, rr = R + th;
    if (d2 >= rr * rr) return -1;
    var d = Math.sqrt(d2), nx, ny;
    if (d < 1e-6) { nx = -dy; ny = dx; var nl = Math.sqrt(nx * nx + ny * ny) || 1; nx /= nl; ny /= nl; if (nx * (b.vx - svx) + ny * (b.vy - svy) > 0) { nx = -nx; ny = -ny; } }
    else { nx = ox / d; ny = oy / d; }
    b.x = px + nx * rr; b.y = py + ny * rr;
    return bounce(b, nx, ny, svx, svy, e);
  }
  function bounce(b, nx, ny, svx, svy, e) {
    var rvx = b.vx - svx, rvy = b.vy - svy, vn = rvx * nx + rvy * ny;
    if (vn >= 0) return 0;
    var tx = rvx - vn * nx, ty = rvy - vn * ny;
    b.vx = svx + tx * T_WALL - e * vn * nx; b.vy = svy + ty * T_WALL - e * vn * ny;
    return -vn;
  }
  function hitCircle(b, cx, cy, cr) {
    var ox = b.x - cx, oy = b.y - cy, d2 = ox * ox + oy * oy, rr = R + cr;
    if (d2 >= rr * rr) return -1;
    var d = Math.sqrt(d2) || 1e-6, nx = ox / d, ny = oy / d;
    b.x = cx + nx * rr; b.y = cy + ny * rr;
    return bounce(b, nx, ny, 0, 0, E_WALL);
  }
  function hitBox(b, x0, y0, w, h2, vx, vy) {
    var cx = clamp(b.x, x0, x0 + w), cy = clamp(b.y, y0, y0 + h2), ox = b.x - cx, oy = b.y - cy, d2 = ox * ox + oy * oy, nx, ny;
    if (d2 >= R * R) return -1;
    if (d2 > 1e-12) { var d = Math.sqrt(d2); nx = ox / d; ny = oy / d; b.x = cx + nx * R; b.y = cy + ny * R; }
    else {   // the centre is inside the box (it was shoved in): out through the nearest side
      var l = b.x - x0, r = x0 + w - b.x, t = b.y - y0, bt = y0 + h2 - b.y, mn = Math.min(l, r, t, bt);
      nx = mn === l ? -1 : mn === r ? 1 : 0; ny = nx ? 0 : mn === t ? -1 : 1;
      if (nx) b.x = nx < 0 ? x0 - R : x0 + w + R; else b.y = ny < 0 ? y0 - R : y0 + h2 + R;
    }
    return bounce(b, nx, ny, vx, vy, E_WALL);
  }

  // Collide against moving parts at time t; returns the strongest impact (-1: no contact).
  function dynHits(h, b, t) {
    var best = -1, i, k, v;
    for (i = 0; i < h.mills.length; i++) {
      var m = h.mills[i], ddx = b.x - m.x, ddy = b.y - m.y;
      if (ddx * ddx + ddy * ddy > (m.r + R + 0.2) * (m.r + R + 0.2)) continue;
      v = hitCircle(b, m.x, m.y, 0.42); if (v > best) best = v;
      var a0 = millAngle(m, t);
      for (k = 0; k < m.n; k++) {
        var a = a0 + k * 2 * Math.PI / m.n, ex = Math.cos(a) * m.r, ey = Math.sin(a) * m.r;
        // velocity of the blade at the ball's radius: ω × r
        var rx = b.x - m.x, ry = b.y - m.y;
        v = hitSeg(b, m.x, m.y, ex, ey, m.r * m.r, 0.1, -m.w * ry, m.w * rx, E_BLADE);
        if (v > best) best = v;
      }
    }
    for (i = 0; i < h.doors.length; i++) {
      var d = h.doors[i], q = doorAt(d, t, TMP);
      v = hitBox(b, q.x, q.y, d.w, d.h, q.vx, q.vy); if (v > best) best = v;
    }
    return best;
  }

  // One fixed physics step of the ball at the hole's time t (t is the time at the START of the step).
  function stepBall(h, b, t) {
    var dt = STEP, ev = b.ev;
    b.px = b.x; b.py = b.y;
    if (b.st === 'sunk' || b.st === 'water') return;
    if (b.st === 'rest') {
      // a resting ball can still be swept by a sail or a door
      if (h.mills.length || h.doors.length) {
        var ox = b.x, oy = b.y, hv = dynHits(h, b, t + dt);
        if (hv >= 0 && (Math.abs(b.x - ox) + Math.abs(b.y - oy) > 1e-4 || hv > 0.05)) {
          staticHits(h, b);
          if (inSolid(h, b.x, b.y)) { b.x = ox; b.y = oy; b.vx = 0; b.vy = 0; return; }
          b.st = 'roll'; b.restT = 0; b.rollT = 0; ev.push('swept');
          if (speed(b) < 0.5) { var nl = Math.sqrt((b.x - ox) * (b.x - ox) + (b.y - oy) * (b.y - oy)) || 1; b.vx += (b.x - ox) / nl * 0.6; b.vy += (b.y - oy) / nl * 0.6; }
        }
      }
      return;
    }
    b.rollT += dt;
    var k = cellAt(h, b.x, b.y), ty = k >= 0 ? h.t[k] : WALL;
    // forces: slope, then friction against the motion
    var sx = 0, sy = 0;
    if (ty === SLOPE) { sx = h.sx[k] * SLOPE_A; sy = h.sy[k] * SLOPE_A; b.vx += sx * dt; b.vy += sy * dt; }
    var sp = speed(b), fr = ty === SAND ? FR_SAND : FR_GREEN, kd = ty === SAND ? KD_SAND : KD_GREEN;
    var dv = (fr + kd * sp) * dt;
    if (sp <= dv) { b.vx = 0; b.vy = 0; sp = 0; }
    else { b.vx *= (sp - dv) / sp; b.vy *= (sp - dv) / sp; sp -= dv; }
    // the cup: a slow ball drops; a fast one is tugged and lips out
    if (h.cup) {
      var cx = h.cup.x - b.x, cy = h.cup.y - b.y, cd = Math.sqrt(cx * cx + cy * cy);
      if (cd < CUP_R) {
        if (sp < CAP_V && cd < CUP_R - 0.06) { b.st = 'sunk'; b.vx = 0; b.vy = 0; ev.push('sunk'); return; }
        var pull = 24 * dt / (cd || 1);
        b.vx += cx * pull; b.vy += cy * pull;
        if (!b.lip) { b.lip = 1; ev.push('lip'); }
      } else if (b.lip && cd > CUP_R + 0.3) b.lip = 0;
    }
    // move in sub-steps of at most a fraction of the radius
    sp = speed(b);
    var n = Math.max(1, Math.ceil(sp * dt / (R * 0.45))), sdt = dt / n, maxHit = 0;
    for (var s = 0; s < n; s++) {
      var bx = b.x, by = b.y, ts = t + (s + 1) * sdt;
      b.x += b.vx * sdt; b.y += b.vy * sdt;
      var v1 = dynHits(h, b, ts); if (v1 > maxHit) maxHit = v1;
      // bumpers kick
      for (var bi = 0; bi < h.bumps.length; bi++) {
        var bp = h.bumps[bi], vb = hitCircle(b, bp.x, bp.y, BUMP_R);
        if (vb >= 0) {
          var nx2 = b.x - bp.x, ny2 = b.y - bp.y, nl2 = Math.sqrt(nx2 * nx2 + ny2 * ny2) || 1, out = (b.vx * nx2 + b.vy * ny2) / nl2;
          if (out < BUMP_KICK) { b.vx += nx2 / nl2 * (BUMP_KICK - out); b.vy += ny2 / nl2 * (BUMP_KICK - out); }
          if (vb > 0.3) { ev.push('bump'); bp.hit = 1; }
        }
      }
      var v2 = staticHits(h, b); if (v2 > maxHit) maxHit = v2;
      // never leave the playing area: if something shoved the ball into a wall, undo the sub-step
      if (inSolid(h, b.x, b.y)) { b.x = bx; b.y = by; b.vx *= -0.5; b.vy *= -0.5; }
      // tunnels
      var kk = cellAt(h, b.x, b.y);
      if (kk >= 0 && h.t[kk] === TUN && h.tunAt[kk] >= 0) {
        if (b.tun !== kk) {
          var tw = h.tunAt[kk];
          b.x = (tw % h.W) + 0.5; b.y = ((tw / h.W) | 0) + 0.5; b.px = b.x; b.py = b.y;
          b.tun = tw; ev.push('warp');
          break;
        }
      } else if (b.tun >= 0 && kk !== b.tun) b.tun = -1;
    }
    if (maxHit > 0.6) { b.hitV = maxHit; ev.push('wall'); }
    // water?
    k = cellAt(h, b.x, b.y);
    if (k >= 0 && h.t[k] === WATER) { b.st = 'water'; b.vx = 0; b.vy = 0; ev.push('water'); return; }
    // rest: stopped (or pinned against a wall on a slope)
    sp = speed(b);
    var onSlope = k >= 0 && h.t[k] === SLOPE;
    if (sp < (onSlope ? 0.7 : 0.5)) b.restT += dt; else b.restT = 0;
    if ((sp < V_STOP && !onSlope) || b.restT > (onSlope ? 0.4 : 0.6) || b.rollT > SHOT_MAX_T) {
      b.vx = 0; b.vy = 0; b.st = 'rest'; b.restT = 0; ev.push('stop');
    }
  }
  function staticHits(h, b) {
    var k = cellAt(h, b.x, b.y), best = 0;
    if (k < 0) return 0;
    var L = h.bk[k];
    for (var i = 0; i < L.length; i++) {
      var sg = h.segs[L[i]], v = hitSeg(b, sg.x1, sg.y1, sg.dx, sg.dy, sg.l2, 0, 0, 0, E_WALL);
      if (v > best) best = v;
    }
    return best;
  }

  // Simulate a putt from (x, y) at hole time t0 until the ball stops; for the CPU and tests.
  function simShot(h, x, y, t0, ang, pow, maxT, track) {
    var b = newBall(x, y), t = t0, n = Math.ceil((maxT || SHOT_MAX_T) / STEP), path = track ? [] : null;
    putt(b, ang, pow);
    for (var i = 0; i < n; i++) {
      stepBall(h, b, t); t += STEP; b.ev.length = 0;
      if (path && i % 4 === 0) path.push(b.x, b.y);
      if (b.st !== 'roll') break;
    }
    return { x: b.x, y: b.y, st: b.st === 'roll' ? 'rest' : b.st, t: t - t0, path: path };
  }

  // ---- a round ----
  var COURSES = {
    front: { name: 'Front 9', holes: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
    back: { name: 'Back 9', holes: [9, 10, 11, 12, 13, 14, 15, 16, 17] },
    all: { name: 'All 18', holes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] }
  };
  var PARSED = [];
  function hole(i) { return PARSED[i] || (PARSED[i] = parseHole(HOLES[i])); }
  function capOf(par) { return Math.max(6, par + 3); }
  function coursePar(holes) { var p = 0; for (var i = 0; i < holes.length; i++) p += HOLES[holes[i]].par; return p; }

  // players: [{ cpu: 0 (human) | 1 easy | 2 normal | 3 hard }]
  function newGame(course, players, practice) {
    var holes = course === 'practice' ? [clamp(practice | 0, 0, HOLES.length - 1)] : (COURSES[course] || COURSES.front).holes.slice();
    var g = {
      course: COURSES[course] ? course : 'practice', holes: holes, players: players.map(function (p) { return { cpu: clamp(p.cpu | 0, 0, 3) }; }),
      scores: [], hi: 0, order: [], oi: 0, cur: 0, strokes: 0, ball: null, from: null, t: 0, steps: 0, phase: 'aim', acc: 0, ev: [], last: null
    };
    for (var p = 0; p < g.players.length; p++) { var row = []; for (var k = 0; k < holes.length; k++) row.push(0); g.scores.push(row); }
    startHole(g);
    return g;
  }
  function curHole(g) { return hole(g.holes[g.hi]); }
  // The honour: the best score on the last hole tees off first (ties keep the last order).
  function startHole(g) {
    var n = g.players.length, ord = [], i;
    for (i = 0; i < n; i++) ord.push(i);
    if (g.hi > 0) {
      var prev = g.order.slice(), hp = g.hi - 1;
      ord.sort(function (a, b) { return (g.scores[a][hp] - g.scores[b][hp]) || (prev.indexOf(a) - prev.indexOf(b)); });
    }
    g.order = ord; g.oi = 0; g.t = 0; g.steps = 0;
    startTurn(g);
  }
  function startTurn(g) {
    var h = curHole(g);
    g.cur = g.order[g.oi]; g.strokes = 0;
    g.ball = newBall(h.tee.x, h.tee.y); g.from = { x: h.tee.x, y: h.tee.y };
    g.phase = 'aim'; g.last = null;
  }
  function shoot(g, ang, pow) {
    if (g.phase !== 'aim' || g.ball.st !== 'rest') return false;
    g.strokes++; g.from = { x: g.ball.x, y: g.ball.y };
    putt(g.ball, ang, pow);
    g.phase = 'roll';
    g.ev.push('putt');
    return true;
  }
  // One fixed step of the round (the hole's clock always runs: sails turn while you aim).
  function stepGame(g) {
    var h = curHole(g), b = g.ball;
    if (g.phase === 'aim' || g.phase === 'roll') {
      stepBall(h, b, g.t);
      for (var i = 0; i < b.ev.length; i++) g.ev.push(b.ev[i]);
      b.ev.length = 0;
      if (g.phase === 'aim' && b.st !== 'rest') g.phase = 'roll';        // swept by a sail (even straight in or into water): settle it
      if (g.phase === 'roll') {
        var cap = capOf(h.par);
        if (b.st === 'sunk') holeOut(g, g.strokes, false);
        else if (b.st === 'water') {
          g.strokes++;                                                 // one stroke penalty, back to where you hit from
          g.ev.push('penalty');
          b.x = b.px = g.from.x; b.y = b.py = g.from.y; b.st = 'rest'; b.vx = b.vy = 0;
          if (g.strokes >= cap) holeOut(g, cap, true); else g.phase = 'aim';
        } else if (b.st === 'rest') {
          if (g.strokes >= cap) holeOut(g, cap, true); else g.phase = 'aim';
        }
      }
    }
    g.t += STEP; g.steps++;
  }
  function holeOut(g, n, picked) {
    n = Math.max(1, n);   // a ball swept in before the first putt still counts one
    g.scores[g.cur][g.hi] = n;
    g.phase = 'holed';
    g.last = { p: g.cur, n: n, picked: picked, par: curHole(g).par };
    g.ev.push(picked ? 'pickup' : 'holed');
  }
  // After a player holes out: the next player, or the hole is done ('card'), or the round ('done').
  function nextTurn(g) {
    if (g.phase !== 'holed') return g.phase;
    g.oi++;
    if (g.oi < g.order.length) { startTurn(g); return 'turn'; }
    g.phase = g.hi + 1 < g.holes.length ? 'card' : 'done';
    return g.phase;
  }
  function nextHole(g) {
    if (g.phase !== 'card') return false;
    g.hi++; startHole(g);
    return true;
  }
  function advance(g, dt) {
    g.acc = Math.min(g.acc + dt, 0.25);
    while (g.acc >= STEP) { stepGame(g); g.acc -= STEP; }
    return g.acc / STEP;
  }
  function totals(g) {
    return g.players.map(function (p, i) {
      var s = 0, par = 0;
      for (var k = 0; k < g.holes.length; k++) if (g.scores[i][k]) { s += g.scores[i][k]; par += HOLES[g.holes[k]].par; }
      return { strokes: s, toPar: s - par };
    });
  }
  // Placings after the round (ties share a place).
  function standings(g) {
    var t = totals(g), idx = t.map(function (x, i) { return i; });
    idx.sort(function (a, b) { return t[a].strokes - t[b].strokes || a - b; });
    var out = [], place = 0;
    for (var i = 0; i < idx.length; i++) {
      if (i === 0 || t[idx[i]].strokes !== t[idx[i - 1]].strokes) place = i + 1;
      out.push({ p: idx[i], place: place, strokes: t[idx[i]].strokes, toPar: t[idx[i]].toPar });
    }
    return out;
  }
  function scoreName(n, par) {
    if (n === 1) return 'HOLE IN ONE';
    var d = n - par;
    return d <= -3 ? 'ALBATROSS' : d === -2 ? 'EAGLE' : d === -1 ? 'BIRDIE' : d === 0 ? 'PAR' : d === 1 ? 'BOGEY' : d === 2 ? 'DOUBLE BOGEY' : '+' + d;
  }

  // ---- the CPU golfer: simulate candidate putts, score where they stop ----
  var LEVELS = [null,
    { name: 'Easy', angN: 24, powN: 5, refine: 6, sa: 0.15, sp: 0.24 },
    { name: 'Normal', angN: 48, powN: 7, refine: 12, sa: 0.075, sp: 0.13 },
    { name: 'Hard', angN: 72, powN: 9, refine: 24, sa: 0.04, sp: 0.07 }];
  function distAt(h, x, y) {
    var k = cellAt(h, x, y);
    if (k < 0) return 999;
    var d = h.dist[k];
    if (d > 1e8) return 999;
    // within the cup's cell, the true distance
    if (d < 0.5) return Math.sqrt((x - h.cup.x) * (x - h.cup.x) + (y - h.cup.y) * (y - h.cup.y)) * 0.5;
    return d;
  }
  // Expected strokes still to play from a spot (a rough model: putts from far take two or more).
  function leaveCost(h, x, y) {
    var d = distAt(h, x, y), k = cellAt(h, x, y), c = d >= 999 ? 9 : d < 1.2 ? 1 + d * 0.15 : 1 + Math.min(5, d / 9) + 0.25;
    if (k >= 0 && h.t[k] === SAND) c += 0.35;
    if (k >= 0 && h.t[k] === SLOPE) c += 0.25;
    return c;
  }
  function evalShot(h, x, y, t0, ang, pow) {
    var r = simShot(h, x, y, t0, ang, pow, 14);
    if (r.st === 'sunk') return { cost: 0 + r.t * 0.001, r: r };
    if (r.st === 'water') return { cost: 1 + leaveCost(h, x, y), r: r };
    return { cost: leaveCost(h, r.x, r.y), r: r };
  }
  // An incremental planner (the UI runs a slice per frame). level 1-3; t0: the clock when it will putt.
  // Stage 0 sweeps a grid of putts; stage 1 re-scores the most promising (diverse) ones under the
  // level's own wobble, so it won't pick a line that only works if struck perfectly (a ball that
  // stops on the water's edge); stages 2-3 refine around the winner with the same robust score.
  function newPlanner(h, x, y, t0, level, seed) {
    var L = LEVELS[clamp(level | 0, 1, 3)], cands = [], i, j;
    var direct = Math.atan2(h.cup.y - y, h.cup.x - x), dd = Math.sqrt((h.cup.x - x) * (h.cup.x - x) + (h.cup.y - y) * (h.cup.y - y));
    for (i = 0; i < L.angN; i++) for (j = 0; j < L.powN; j++) cands.push([i * 2 * Math.PI / L.angN, 0.12 + 0.88 * Math.pow((j + 0.5) / L.powN, 1.3)]);
    // straight at the cup at a gentle range of speeds (the putt that just dies in the hole)
    var pd = Math.sqrt(2 * FR_GREEN * dd) / MAX_V;
    for (j = -3; j <= 6; j++) cands.push([direct, clamp(pd * (1 + j * 0.12) + 0.04, 0.04, 1)]);
    return { h: h, x: x, y: y, t0: t0, L: L, cands: cands, i: 0, best: null, top: [], phase: 0, r: rng(seed || 1), done: false, evals: 0 };
  }
  var TOP_N = 10;
  function addTop(P, c) {
    var T = P.top, i;
    for (i = 0; i < T.length; i++) {
      var o = T[i], da = Math.abs(Math.atan2(Math.sin(o.ang - c.ang), Math.cos(o.ang - c.ang)));
      if (da < 0.07 && Math.abs(o.pow - c.pow) < 0.07) { if (c.cost < o.cost) T[i] = c; else return; T.sort(function (a, b) { return a.cost - b.cost; }); return; }
    }
    T.push(c); T.sort(function (a, b) { return a.cost - b.cost; });
    if (T.length > TOP_N) T.pop();
  }
  // The expected cost of a putt when struck with the level's typical error (deterministic samples).
  function robustEval(P, ang, pow) {
    var L = P.L, da = L.sa * 1.25, dp = L.sp * 1.25, e = evalShot(P.h, P.x, P.y, P.t0, ang, pow), sum = e.cost * 2, worst = e.cost;
    var V = [[da, 0], [-da, 0], [0, dp], [0, -dp]];
    for (var i = 0; i < V.length; i++) {
      var c = evalShot(P.h, P.x, P.y, P.t0, ang + V[i][0], clamp(pow * (1 + V[i][1]), 0.03, 1)).cost;
      sum += c; if (c > worst) worst = c;
    }
    P.evals += 5;
    return { ang: ang, pow: pow, cost: sum / 6 + (worst - e.cost) * 0.1, st: e.r.st };
  }
  function planStep(P, n) {
    while (n-- > 0 && !P.done) {
      if (P.phase === 0) {
        if (P.i < P.cands.length) {
          var c = P.cands[P.i++], e = evalShot(P.h, P.x, P.y, P.t0, c[0], c[1]);
          P.evals++;
          addTop(P, { ang: c[0], pow: c[1], cost: e.cost, st: e.r.st });
          continue;
        }
        P.phase = 1; P.i = 0; P.cands = P.top.map(function (q) { return [q.ang, q.pow]; }); P.best = null;
        continue;
      }
      if (P.i < P.cands.length) {
        var q = P.cands[P.i++], rb = robustEval(P, q[0], q[1]);
        if (!P.best || rb.cost < P.best.cost) P.best = rb;
        continue;
      }
      if (P.phase < 3 && P.best && P.best.cost > 0.0005) {
        // refine around the best so far, twice, finer each time
        P.phase++;
        var k = P.L.refine, sa = P.phase === 2 ? 0.06 : 0.02, sp = P.phase === 2 ? 0.06 : 0.025;
        P.cands = []; P.i = 0;
        for (var m = 0; m < k; m++) P.cands.push([P.best.ang + (P.r() * 2 - 1) * sa, clamp(P.best.pow + (P.r() * 2 - 1) * sp, 0.03, 1)]);
        continue;
      }
      if (!P.best) P.best = { ang: 0, pow: 0.3, cost: 9, st: 'rest' };
      P.done = true;
    }
    return P.done;
  }
  // The putt the CPU actually makes: the plan plus its level's wobble.
  function cpuShot(P, seed) {
    var r = rng(seed || 7), b = P.best || { ang: 0, pow: 0.3 };
    return { ang: b.ang + gauss(r) * P.L.sa, pow: clamp(b.pow * (1 + gauss(r) * P.L.sp), 0.03, 1) };
  }
  function planShot(h, x, y, t0, level, seed) {
    var P = newPlanner(h, x, y, t0, level, seed);
    while (!planStep(P, 500)) {}
    return P;
  }

  // ---- save: records, settings, a round in progress ----
  function newSave() {
    return { v: 1, rounds: 0, aces: 0, putts: 0, best: { front: 0, back: 0, all: 0 }, hole: HOLES.map(function () { return 0; }),
      setup: { course: 'front', practice: 0, seats: [0], level: 2 } };
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    s.rounds = Math.max(0, +o.rounds | 0); s.aces = Math.max(0, +o.aces | 0); s.putts = Math.max(0, +o.putts | 0);
    if (o.best && typeof o.best === 'object') for (var k in s.best) { var b = +o.best[k] | 0; s.best[k] = b > 0 && b < 999 ? b : 0; }
    if (Array.isArray(o.hole)) for (var i = 0; i < s.hole.length; i++) { var hv = +o.hole[i] | 0; s.hole[i] = hv > 0 && hv < 20 ? hv : 0; }
    var su = o.setup;
    if (su && typeof su === 'object') {
      if (COURSES[su.course] || su.course === 'practice') s.setup.course = su.course;
      s.setup.practice = clamp(+su.practice | 0, 0, HOLES.length - 1);
      if (Array.isArray(su.seats) && su.seats.length >= 1) s.setup.seats = su.seats.slice(0, 4).map(function (v) { return v ? 1 : 0; });
      s.setup.level = clamp(+su.level | 0, 1, 3) || 2;
    }
    return s;
  }
  // Fold a finished round into the records (humans only). Returns what's new.
  function settle(save, g) {
    var nb = { course: false, holes: [] }, t = totals(g), hasHuman = false, bestT = 999;
    save.rounds++;
    for (var p = 0; p < g.players.length; p++) {
      if (g.players[p].cpu) continue;
      hasHuman = true;
      for (var k = 0; k < g.holes.length; k++) {
        var n = g.scores[p][k], hi = g.holes[k];
        if (!n) continue;
        if (n === 1) save.aces++;
        if (!save.hole[hi] || n < save.hole[hi]) { if (save.hole[hi] && nb.holes.indexOf(hi) < 0) nb.holes.push(hi); save.hole[hi] = n; }
      }
      if (t[p].strokes < bestT) bestT = t[p].strokes;
    }
    if (hasHuman && save.best[g.course] !== undefined && bestT < 999) {
      if (!save.best[g.course] || bestT < save.best[g.course]) { nb.course = true; save.best[g.course] = bestT; }
    }
    return nb;
  }
  // A round in progress, between putts (the ball at rest), as plain JSON.
  function snapRound(g) {
    if (g.phase !== 'aim' || g.ball.st !== 'rest') return null;
    return { v: 1, course: g.course, holes: g.holes.slice(), players: g.players.map(function (p) { return p.cpu; }), scores: g.scores.map(function (r) { return r.slice(); }),
      hi: g.hi, order: g.order.slice(), oi: g.oi, strokes: g.strokes, bx: +g.ball.x.toFixed(3), by: +g.ball.y.toFixed(3), t: +g.t.toFixed(3) };
  }
  function loadRound(o) {
    if (!o || typeof o !== 'object' || !Array.isArray(o.holes) || !Array.isArray(o.players)) return null;
    var holes = o.holes.map(function (v) { return v | 0; }).filter(function (v) { return v >= 0 && v < HOLES.length; });
    var np = o.players.length;
    if (!holes.length || holes.length !== o.holes.length || np < 1 || np > 4) return null;
    var g = newGame('front', o.players.map(function (c) { return { cpu: c }; }));
    g.course = COURSES[o.course] ? o.course : 'practice'; g.holes = holes;
    g.scores = [];
    for (var p = 0; p < np; p++) { var row = []; for (var k = 0; k < holes.length; k++) { var v = o.scores && o.scores[p] ? +o.scores[p][k] | 0 : 0; row.push(clamp(v, 0, 20)); } g.scores.push(row); }
    g.hi = clamp(o.hi | 0, 0, holes.length - 1);
    var ord = Array.isArray(o.order) ? o.order.map(function (v) { return v | 0; }) : [];
    var okOrd = ord.length === np && ord.every(function (v, i) { return v >= 0 && v < np && ord.indexOf(v) === i; });
    g.order = okOrd ? ord : g.players.map(function (x, i) { return i; });
    g.oi = clamp(o.oi | 0, 0, np - 1);
    g.t = Math.max(0, +o.t || 0);
    startTurn(g);
    g.strokes = clamp(o.strokes | 0, 0, capOf(curHole(g).par) - 1);
    var h = curHole(g), bx = +o.bx, by = +o.by;
    if (isFinite(bx) && isFinite(by) && !inSolid(h, bx, by) && h.t[cellAt(h, bx, by)] !== WATER) { g.ball.x = g.ball.px = bx; g.ball.y = g.ball.py = by; }
    g.from = { x: g.ball.x, y: g.ball.y };
    return g;
  }

  var ENGINE = {
    STEP: STEP, R: R, CUP_R: CUP_R, CAP_V: CAP_V, MAX_V: MAX_V, HOLES: HOLES, COURSES: COURSES, LEVELS: LEVELS,
    VOID: VOID, WALL: WALL, GREEN: GREEN, SAND: SAND, WATER: WATER, BRIDGE: BRIDGE, SLOPE: SLOPE, BUMP: BUMP, DIAG: DIAG, TUN: TUN,
    rng: rng, parseHole: parseHole, hole: hole, cellAt: cellAt, inSolid: inSolid, millAngle: millAngle, doorAt: doorAt,
    newBall: newBall, putt: putt, speed: speed, stepBall: stepBall, simShot: simShot,
    newGame: newGame, curHole: curHole, shoot: shoot, stepGame: stepGame, nextTurn: nextTurn, nextHole: nextHole, advance: advance,
    totals: totals, standings: standings, capOf: capOf, coursePar: coursePar, scoreName: scoreName,
    distAt: distAt, newPlanner: newPlanner, planStep: planStep, planShot: planShot, cpuShot: cpuShot,
    newSave: newSave, normSave: normSave, settle: settle, snapRound: snapRound, loadRound: loadRound
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('minigolf.css');

  var PANEL_ID = 'minigolf-panel', NAME = 'Mini Golf';
  var KEY = 'cade-minigolf-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound', ROUND_KEY = KEY + 'round';
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.minigolf = { live: function () { return S; } };   // test-only peek

  // palette slots (readTheme)
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOLD = 4, C_RED = 5, C_ICE = 6, C_FLAME = 7, C_LEAF = 8, C_VIOLET = 9,
    C_WOOD = 10, C_WALL = 11, C_GRASS = 12, C_SANDG = 13, C_BG = 14, NPAL = 15;
  var P_SLOT = [C_ACC, C_RED, C_GOLD, C_VIOLET];
  var P_CLS = ['p1', 'p2', 'p3', 'p4'];

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { if (Cade.store.remove) Cade.store.remove(k); else Cade.store.set(k, ''); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function loadSavedRound() {
    var raw = sget(ROUND_KEY);
    if (!raw) return null;
    try { var o = JSON.parse(raw); return o && loadRound(o) ? o : null; } catch (e) { return null; }
  }
  function saveRound() {
    if (!S || !S.g) return;
    var snap = snapRound(S.g);
    if (snap) sset(ROUND_KEY, JSON.stringify(snap));
  }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function sgn(n) { return n > 0 ? '+' + n : n === 0 ? 'E' : String(n); }

  // ---- sound: a tiny WebAudio voice, created on a user gesture, closed with the panel ----
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
  var IC_CARD = svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 4v16M15 4v16"/>');

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
    var P = S.pal, gold = dark ? [242, 197, 68] : [176, 125, 6], red = dark ? [240, 106, 106] : [207, 63, 63], ice = dark ? [124, 199, 242] : [40, 120, 181],
      leaf = dark ? [126, 211, 122] : [47, 143, 58], vio = dark ? [183, 156, 245] : [115, 81, 196], wood = dark ? [196, 150, 104] : [140, 94, 52];
    S.dark = dark;
    P[C_TEXT] = css(tx); P[C_MUTED] = css(mu); P[C_FAINT] = css(fa); P[C_ACC] = css(ac); P[C_BG] = css(bg);
    P[C_GOLD] = css(gold); P[C_RED] = css(red); P[C_ICE] = css(ice); P[C_FLAME] = dark ? '#ff8f3f' : '#e2611f';
    P[C_LEAF] = css(leaf); P[C_VIOLET] = css(vio); P[C_WOOD] = css(wood);
    P[C_WALL] = css(mix(bg, tx, dark ? 0.62 : 0.55)); P[C_GRASS] = css(mix(bg, leaf, dark ? 0.42 : 0.42)); P[C_SANDG] = css(mix(bg, gold, 0.7));
    S.col = {
      bg: css(bg), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace',
      g1: css(mix(bg, leaf, dark ? 0.13 : 0.12)), g2: css(mix(bg, leaf, dark ? 0.17 : 0.17)),
      sand: css(mix(bg, gold, dark ? 0.2 : 0.24)), water: css(mix(bg, ice, dark ? 0.26 : 0.24)), water2: css(mix(bg, ice, dark ? 0.34 : 0.32)),
      bridge: css(mix(bg, wood, dark ? 0.32 : 0.3)), wall: css(mix(bg, tx, dark ? 0.12 : 0.1)), wallIn: css(mix(bg, tx, dark ? 0.07 : 0.06)),
      slope: css(mix(bg, leaf, dark ? 0.2 : 0.2)), cup: dark ? '#05070a' : css(mix(tx, bg, 0.05)), shadow: dark ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.18)',
      door: css(mix(bg, vio, dark ? 0.4 : 0.32)), doorEdge: css(vio), hud: css(bg, 0.86), ball: dark ? '#f4f4f0' : '#ffffff', ballEdge: dark ? 'rgba(0,0,0,0.6)' : css(mix(tx, bg, 0.25)),
      tun: css(mix(bg, vio, dark ? 0.35 : 0.28)), pcol: [css(ac), css(red), css(gold), css(vio)]
    };
    buildAtlas();
    S.layerDirty = true;
  }

  // ---- glyphs: each (colour, char) rendered once into an atlas, stamped with drawImage ----
  var AT_COLS = 24, AT_ROWS = 14;
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.col || !S.sc) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    a.fpx = Math.max(8, S.sc * 0.86);
    a.cwp = Math.ceil(S.sc * 1.25 * S.k); a.chp = a.cwp;
    a.cv.width = a.cwp * AT_COLS; a.cv.height = a.chp * AT_ROWS;
    a.c = a.cv.getContext('2d');
    a.c.font = '700 ' + (a.fpx * S.k).toFixed(2) + 'px ' + S.col.font;
    a.c.textAlign = 'center'; a.c.textBaseline = 'middle';
    a.cw = a.cwp / S.k; a.n = 0; a.max = AT_COLS * AT_ROWS;
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
    a.c.fillText(String.fromCharCode(code), (i % AT_COLS) * a.cwp + a.cwp / 2, ((i / AT_COLS) | 0) * a.chp + a.chp / 2 + a.chp * 0.04);
    m[code] = i;
    return i;
  }
  function glyph(c, ci, code, x, y, sc) {
    if (code === 32) return;
    var i = gIdx(ci, code), a = S.atl;
    if (i < 0) {
      c.font = '700 ' + (a.fpx * (sc || 1)).toFixed(2) + 'px ' + S.col.font; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = S.pal[ci];
      c.fillText(String.fromCharCode(code), x, y);
      return;
    }
    var w = sc ? a.cw * sc : a.cw;
    c.drawImage(a.cv, (i % AT_COLS) * a.cwp, ((i / AT_COLS) | 0) * a.chp, a.cwp, a.chp, x - w / 2, y - w / 2, w, w);
  }

  // ---- the view: the hole's bounding box fitted to the stage; portrait stages turn a wide hole on its side ----
  function fitView() {
    if (!S.g) return;
    var h = curHole(S.g), b = h.box, bw = b.x1 - b.x0, bh = b.y1 - b.y0, SW = S.SW, SH = S.SH, pad = 6;
    var a = Math.min((SW - pad * 2) / bw, (SH - pad * 2) / bh), r = Math.min((SW - pad * 2) / bh, (SH - pad * 2) / bw);
    var rot = r > a * 1.08, sc = Math.min(rot ? r : a, 40);
    var vw = (rot ? bh : bw) * sc, vh = (rot ? bw : bh) * sc;
    var V = S.V = { rot: rot, sc: sc, ox: (SW - vw) / 2, oy: (SH - vh) / 2, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, hole: h };
    var old = S.sc;
    S.sc = sc;
    if (S.col && (old !== sc || !S.atl)) buildAtlas();
    S.layerDirty = true;
    return V;
  }
  // world point → screen (CSS px in the stage)
  function SX(x, y) { var V = S.V; return V.rot ? V.ox + (y - V.y0) * V.sc : V.ox + (x - V.x0) * V.sc; }
  function SY(x, y) { var V = S.V; return V.rot ? V.oy + (V.x1 - x) * V.sc : V.oy + (y - V.y0) * V.sc; }
  // a screen vector → world vector
  function toWorldV(dx, dy) { var V = S.V; return V.rot ? { x: -dy / V.sc, y: dx / V.sc } : { x: dx / V.sc, y: dy / V.sc }; }
  // a world direction → a screen direction
  function scrDir(dx, dy) { return S.V.rot ? [dy, -dx] : [dx, dy]; }
  // top-left of a cell's square on screen
  function cellXY(cx, cy) { var V = S.V; return V.rot ? [V.ox + (cy - V.y0) * V.sc, V.oy + (V.x1 - cx - 1) * V.sc] : [V.ox + (cx - V.x0) * V.sc, V.oy + (cy - V.y0) * V.sc]; }

  // A slope arrow in screen terms
  function arrowCode(dx, dy) { var d = scrDir(dx, dy); return d[0] > 0 ? 62 : d[0] < 0 ? 60 : d[1] < 0 ? 94 : 118; }
  function hashc(x, y) { var n = Math.imul(x * 374761393 + y * 668265263, 1274126177); n ^= n >>> 13; return (n >>> 0) % 997; }

  // ---- the static layer: terrain, walls, cup, tee (redrawn per hole / theme / size) ----
  function renderLayer() {
    var V = S.V, h = V.hole, sc = V.sc, W = h.W;
    var L = S.layer || (S.layer = document.createElement('canvas'));
    L.width = S.cv.width; L.height = S.cv.height;
    var c = L.getContext('2d'), x, y, k, t, p, col = S.col;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.clearRect(0, 0, S.SW, S.SH);
    S.water = []; S.slopes = [];
    function exposed(xx, yy) {
      if (!h.solid(xx, yy) || h.t[yy * W + xx] !== WALL) return false;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) { if (!h.solid(xx + dx, yy + dy)) return true; }
      return false;
    }
    var ov = 0.6 / S.k;   // a hair of overlap so the fills never show seams
    for (y = 0; y < h.H; y++) for (x = 0; x < W; x++) {
      k = y * W + x; t = h.t[k];
      if (t === VOID) continue;
      p = cellXY(x, y);
      var f = null;
      if (t === WALL) f = exposed(x, y) ? col.wall : col.wallIn;
      else if (t === SAND) f = col.sand;
      else if (t === WATER) f = col.water;
      else if (t === BRIDGE) f = col.bridge;
      else if (t === SLOPE) f = col.slope;
      else f = ((S.V.rot ? x : y) >> 0) % 2 ? col.g1 : col.g2;
      c.fillStyle = f; c.fillRect(p[0] - ov, p[1] - ov, sc + ov * 2, sc + ov * 2);
      if (t === WATER) S.water.push(x, y);
      if (t === SLOPE) S.slopes.push(x, y, h.sx[k], h.sy[k]);
    }
    // glyph texture: grass dots, sand grains, bridge planks, walls as ASCII outlines
    for (y = 0; y < h.H; y++) for (x = 0; x < W; x++) {
      k = y * W + x; t = h.t[k]; p = cellXY(x, y);
      var cx = p[0] + sc / 2, cy = p[1] + sc / 2, hv = hashc(x, y);
      if (t === GREEN || t === DIAG || t === TUN || t === BUMP) {
        if (hv % 5 === 0) glyph(c, C_GRASS, hv % 3 ? 46 : 44, cx + ((hv % 7) - 3) * sc * 0.06, cy + ((hv % 5) - 2) * sc * 0.06, 0.8);
        else if (hv % 11 === 1) glyph(c, C_GRASS, 39, cx, cy, 0.8);
      } else if (t === SAND) glyph(c, C_SANDG, hv % 3 ? 58 : 46, cx, cy, 0.85);
      else if (t === BRIDGE) glyph(c, C_WOOD, 61, cx, cy, 1);
      else if (t === WALL && exposed(x, y)) {
        // connect to exposed wall neighbours, in screen terms
        var l = exposed(x - 1, y), r = exposed(x + 1, y), u = exposed(x, y - 1), d = exposed(x, y + 1);
        var hz = l || r, vt = u || d;
        if (S.V.rot) { var tmp = hz; hz = vt; vt = tmp; }
        glyph(c, C_WALL, hz && vt ? 43 : hz ? 45 : vt ? 124 : 43, cx, cy, 1);
      }
      if (t === DIAG) {
        var ch = h.ch[y][x], code = ch === '/' ? 47 : 92;
        if (S.V.rot) code = code === 47 ? 92 : 47;
        // fill the solid half
        var bk = h.diagBack[k];
        if (bk) {
          c.fillStyle = col.wall; c.beginPath();
          var tri = bk === 1 ? [[0, 0], [1, 0], [0, 1]] : bk === 2 ? [[1, 0], [1, 1], [0, 1]] : bk === 3 ? [[0, 0], [1, 0], [1, 1]] : [[0, 0], [0, 1], [1, 1]];
          for (var q = 0; q < 3; q++) { var wx = x + tri[q][0], wy = y + tri[q][1]; if (q) c.lineTo(SX(wx, wy), SY(wx, wy)); else c.moveTo(SX(wx, wy), SY(wx, wy)); }
          c.closePath(); c.fill();
        }
        glyph(c, C_WALL, code, cx, cy, 1.15);
      }
    }
    // the tee mat
    var te = h.tee;
    c.strokeStyle = S.pal[C_FAINT]; c.lineWidth = 1; c.setLineDash([2, 2]);
    c.strokeRect(SX(te.x, te.y) - sc * 0.45, SY(te.x, te.y) - sc * 0.45, sc * 0.9, sc * 0.9);
    c.setLineDash([]);
    S.layerDirty = false;
  }

  // ---- particles (world space) ----
  var NPART = 72;
  function makeFx() {
    S.parts = [];
    for (var i = 0; i < NPART; i++) S.parts.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, code: 46, ci: 0, dr: 0 });
    S.pi = 0; S.trail = []; S.msg = null; S.msgQ = [];
  }
  function clearFx() { for (var i = 0; i < NPART; i++) S.parts[i].on = false; S.trail.length = 0; S.msg = null; S.msgQ.length = 0; }
  function spark(x, y, vx, vy, life, code, ci, dr) {
    var p = S.parts[S.pi]; S.pi = (S.pi + 1) % NPART;
    p.on = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.t = 0; p.life = life; p.code = code; p.ci = ci; p.dr = dr || 2;
  }
  function burst(x, y, n, sp, codes, ci, life) {
    if (S.rm) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = sp * (0.3 + Math.random() * 0.7);
      spark(x, y, Math.cos(a) * v, Math.sin(a) * v, life * (0.6 + Math.random() * 0.5), codes.charCodeAt(i % codes.length), ci < 0 ? P_SLOT[i % 4] : ci);
    }
  }
  function stepFx(dt) {
    for (var i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on) continue;
      p.t += dt;
      if (p.t >= p.life) { p.on = false; continue; }
      var dr = Math.exp(-p.dr * dt); p.vx *= dr; p.vy *= dr;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt);
    if (S.msg && (S.msg.t += dt) > S.msg.dur) S.msg = S.msgQ.length ? S.msgQ.shift() : null;
    for (i = 0; i < S.bumpFx.length; i++) if (S.bumpFx[i] > 0) S.bumpFx[i] = Math.max(0, S.bumpFx[i] - dt);
  }
  function say(text, ci, dur, sub, queue) {
    var m = { text: text, sub: sub || '', ci: ci == null ? C_TEXT : ci, t: 0, dur: dur || 1.2 };
    if (queue && S.msg && S.msgQ.length < 3) S.msgQ.push(m); else { S.msg = m; S.msgQ.length = 0; }
  }

  // ---- drawing ----
  function draw(alpha) {
    if (!S || !S.ctx || !S.g || !S.V || !S.atl) return;
    var c = S.ctx, g = S.g, h = S.V.hole, V = S.V, sc = V.sc, i, x, y, p;
    if (S.layerDirty) renderLayer();
    var t = g.t + alpha * STEP - STEP;   // the clock interpolated between the last two steps
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (S.shake > 0 && !S.rm) c.translate((Math.random() - 0.5) * S.shake * 10, (Math.random() - 0.5) * S.shake * 10);
    c.fillStyle = S.col.bg; c.fillRect(-12, -12, S.SW + 24, S.SH + 24);
    c.drawImage(S.layer, 0, 0, S.SW, S.SH);
    // water ripples and slope arrows (animated)
    var at = S.animT;
    for (i = 0; i < S.water.length; i += 2) {
      x = S.water[i]; y = S.water[i + 1]; p = cellXY(x, y);
      var ph = (at * 1.3 + (x + y * 0.7) * 0.45) % 2;
      if (hashc(x, y) % 5 > 1) continue;
      glyph(S.ctx, C_ICE, ph < 1 ? 126 : 45, p[0] + sc / 2 + Math.sin(at + x) * sc * 0.12, p[1] + sc / 2, 0.95);
    }
    for (i = 0; i < S.slopes.length; i += 4) {
      x = S.slopes[i]; y = S.slopes[i + 1];
      var sx = S.slopes[i + 2], sy = S.slopes[i + 3], u = ((at * 0.9 + ((x + y) % 2) * 0.5) % 1), wx = x + 0.5 + sx * (u - 0.5) * 0.7, wy = y + 0.5 + sy * (u - 0.5) * 0.7;
      c.globalAlpha = Math.sin(u * Math.PI) * 0.7;
      glyph(c, C_LEAF, arrowCode(sx, sy), SX(wx, wy), SY(wx, wy), 0.8);
    }
    c.globalAlpha = 1;
    // tunnels: a dark mouth with its number, swirling
    var tk = 0;
    for (var d in h.tun) {
      var L = h.tun[d];
      for (i = 0; i < L.length; i++) {
        x = L[i] % h.W + 0.5; y = ((L[i] / h.W) | 0) + 0.5;
        var px = SX(x, y), py = SY(x, y);
        c.fillStyle = S.col.tun; c.beginPath(); c.arc(px, py, sc * 0.46, 0, Math.PI * 2); c.fill();
        c.strokeStyle = S.pal[C_VIOLET]; c.lineWidth = Math.max(1, sc * 0.07); c.beginPath();
        var a0 = at * 2.4 + tk; c.arc(px, py, sc * 0.4, a0, a0 + 4.2); c.stroke();
        glyph(c, C_VIOLET, d.charCodeAt(0), px, py, 0.85);
      }
      tk += 1.3;
    }
    // bumpers
    for (i = 0; i < h.bumps.length; i++) {
      var bp = h.bumps[i], fx = S.bumpFx[i] || 0, rr = sc * (0.36 + fx * 0.5);
      px = SX(bp.x, bp.y); py = SY(bp.x, bp.y);
      c.fillStyle = S.col.bg; c.beginPath(); c.arc(px, py, rr, 0, Math.PI * 2); c.fill();
      c.strokeStyle = fx > 0 ? S.pal[C_GOLD] : S.pal[C_RED]; c.lineWidth = Math.max(1.5, sc * 0.11); c.beginPath(); c.arc(px, py, rr, 0, Math.PI * 2); c.stroke();
      glyph(c, fx > 0 ? C_GOLD : C_RED, fx > 0 ? 42 : 111, px, py, 0.9);
    }
    // the cup and its flag (the flag lifts out while a ball is close)
    var cu = h.cup, cpx = SX(cu.x, cu.y), cpy = SY(cu.x, cu.y), bl = g.ball;
    c.fillStyle = S.col.cup; c.beginPath(); c.arc(cpx, cpy, sc * CUP_R, 0, Math.PI * 2); c.fill();
    c.strokeStyle = S.pal[C_MUTED]; c.lineWidth = 1; c.beginPath(); c.arc(cpx, cpy, sc * CUP_R, 0, Math.PI * 2); c.stroke();
    var bx = bl.px + (bl.x - bl.px) * alpha, by = bl.py + (bl.y - bl.py) * alpha;
    var near = Math.sqrt((bx - cu.x) * (bx - cu.x) + (by - cu.y) * (by - cu.y)), fa = clamp((near - 1) / 2.5, 0.2, 1);
    if (bl.st === 'sunk') fa = 1;
    c.globalAlpha = fa;
    glyph(c, C_TEXT, 124, cpx, cpy - sc * 0.6, 1);
    glyph(c, C_TEXT, 124, cpx, cpy - sc * 1.25, 1);
    glyph(c, C_RED, ((at * 3) | 0) % 2 ? 62 : 41, cpx + sc * 0.42, cpy - sc * 1.55, 1);
    c.globalAlpha = 1;
    // sliding doors
    for (i = 0; i < h.doors.length; i++) {
      var dr = h.doors[i], q = doorAt(dr, t, TMP), x0 = q.x, y0 = q.y, x1 = q.x + dr.w, y1 = q.y + dr.h;
      var sxa = Math.min(SX(x0, y0), SX(x1, y1)), sya = Math.min(SY(x0, y0), SY(x1, y1)), sw = Math.abs(SX(x1, y1) - SX(x0, y0)), sh = Math.abs(SY(x1, y1) - SY(x0, y0));
      c.fillStyle = S.col.door; c.fillRect(sxa, sya, sw, sh);
      c.strokeStyle = S.col.doorEdge; c.lineWidth = Math.max(1, sc * 0.08); c.strokeRect(sxa + 0.5, sya + 0.5, sw - 1, sh - 1);
      var vert = sh > sw, n = Math.max(1, Math.round((vert ? sh : sw) / sc));
      for (var j = 0; j < n; j++) glyph(c, C_VIOLET, vert ? 61 : 124, vert ? sxa + sw / 2 : sxa + (j + 0.5) * sw / n, vert ? sya + (j + 0.5) * sh / n : sya + sh / 2, 0.9);
    }
    // the ball's trail
    for (i = 0; i < S.trail.length; i += 2) {
      c.globalAlpha = 0.15 + 0.5 * i / S.trail.length;
      glyph(c, C_FAINT, 46, SX(S.trail[i], S.trail[i + 1]), SY(S.trail[i], S.trail[i + 1]), 0.8);
    }
    c.globalAlpha = 1;
    // aim guide
    if (S.showAim) drawAim(c, bx, by);
    // the ball
    if (bl.st !== 'sunk') {
      var bxs = SX(bx, by), bys = SY(bx, by), br = Math.max(3, sc * R * 1.12), sink = 1;
      var cd = Math.sqrt((bx - cu.x) * (bx - cu.x) + (by - cu.y) * (by - cu.y));
      if (cd < CUP_R && bl.st === 'roll') sink = 0.85;
      c.fillStyle = S.col.shadow; c.beginPath(); c.ellipse(bxs + br * 0.25, bys + br * 0.35, br, br * 0.85, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = S.col.ball; c.beginPath(); c.arc(bxs, bys, br * sink, 0, Math.PI * 2); c.fill();
      c.lineWidth = Math.max(1.5, br * 0.32); c.strokeStyle = S.col.pcol[g.cur % 4]; c.stroke();
    } else if (S.sunkT < 0.5) {
      c.globalAlpha = 1 - S.sunkT * 2;
      c.fillStyle = S.col.ball; c.beginPath(); c.arc(cpx, cpy, Math.max(2, sc * R * (1 - S.sunkT)), 0, Math.PI * 2); c.fill();
      c.globalAlpha = 1;
    }
    // windmills, over the ball (their sails are tall)
    for (i = 0; i < h.mills.length; i++) {
      var m = h.mills[i], a0 = millAngle(m, t);
      c.strokeStyle = S.pal[C_FLAME]; c.lineCap = 'round';
      for (var bk = 0; bk < m.n; bk++) {
        var an = a0 + bk * 2 * Math.PI / m.n, ca = Math.cos(an), sa = Math.sin(an), tx = m.x + ca * m.r, ty = m.y + sa * m.r;
        c.lineWidth = Math.max(3, sc * 0.26);
        c.beginPath(); c.moveTo(SX(m.x, m.y), SY(m.x, m.y)); c.lineTo(SX(tx, ty), SY(tx, ty)); c.stroke();
        // the sail: a lighter band along the outer half, with a glyph at the tip
        c.globalAlpha = 0.35; c.lineWidth = Math.max(6, sc * 0.6);
        c.beginPath(); c.moveTo(SX(m.x + ca * m.r * 0.45, m.y + sa * m.r * 0.45), SY(m.x + ca * m.r * 0.45, m.y + sa * m.r * 0.45)); c.lineTo(SX(m.x + ca * (m.r - 0.15), m.y + sa * (m.r - 0.15)), SY(m.x + ca * (m.r - 0.15), m.y + sa * (m.r - 0.15))); c.stroke();
        c.globalAlpha = 1;
        glyph(c, C_FLAME, 42, SX(tx, ty), SY(tx, ty), 0.9);
      }
      c.lineCap = 'butt';
      px = SX(m.x, m.y); py = SY(m.x, m.y);
      c.fillStyle = S.col.bg; c.beginPath(); c.arc(px, py, sc * 0.42, 0, Math.PI * 2); c.fill();
      c.strokeStyle = S.pal[C_FLAME]; c.lineWidth = Math.max(1.5, sc * 0.1); c.stroke();
      glyph(c, C_FLAME, ((at * 4) | 0) % 2 ? 120 : 43, px, py, 0.9);
    }
    // particles
    for (i = 0; i < NPART; i++) {
      var pp = S.parts[i];
      if (!pp.on) continue;
      c.globalAlpha = Math.min(1, 2.5 * (1 - pp.t / pp.life));
      glyph(c, pp.ci, pp.code, SX(pp.x, pp.y), SY(pp.x, pp.y), 0.9);
    }
    c.globalAlpha = 1;
    if (S.msg && !S.paused) banner(c, S.msg);
  }

  // The guide: a dotted line from the ball along the aim (one bank shown), as long as the power.
  function drawAim(c, bx, by) {
    var ang = S.aim.ang, pow = S.aim.pow, sc = S.V.sc, h = S.V.hole;
    var len = 1.2 + pow * 8.5, ci = pow < 0.45 ? C_LEAF : pow < 0.78 ? C_GOLD : C_RED;
    var b = { x: bx, y: by, vx: Math.cos(ang), vy: Math.sin(ang) }, d = 0, step = 0.08, nextDot = 0.55, bounces = 0, j = 0;
    while (d < len && j++ < 400) {
      b.x += b.vx * step; b.y += b.vy * step; d += step;
      var k = cellAt(h, b.x, b.y);
      if (k < 0) break;
      if (h.t[k] === WATER && bounces === 0 && d > 0.6) { glyph(c, C_ICE, 120, SX(b.x, b.y), SY(b.x, b.y), 0.9); break; }
      var L = h.bk[k], hit = false;
      for (var i = 0; i < L.length; i++) {
        var sg = h.segs[L[i]], u = sg.l2 > 0 ? clamp(((b.x - sg.x1) * sg.dx + (b.y - sg.y1) * sg.dy) / sg.l2, 0, 1) : 0;
        var qx = b.x - (sg.x1 + sg.dx * u), qy = b.y - (sg.y1 + sg.dy * u), q2 = qx * qx + qy * qy;
        if (q2 < R * R) {
          var ql = Math.sqrt(q2) || 1, nx = qx / ql, ny = qy / ql, vn = b.vx * nx + b.vy * ny;
          if (vn < 0) { b.vx -= 2 * vn * nx; b.vy -= 2 * vn * ny; hit = true; }
          b.x += nx * (R - ql); b.y += ny * (R - ql);
        }
      }
      if (hit && ++bounces > 1) break;
      if (d >= nextDot) {
        c.globalAlpha = 0.95 - 0.6 * d / len;
        glyph(c, ci, d + 0.5 >= len ? 111 : 46, SX(b.x, b.y), SY(b.x, b.y), d + 0.5 >= len ? 0.8 : 1.1);
        nextDot += 0.5;
      }
    }
    c.globalAlpha = 1;
    // while dragging: a faint pull-back line from the ball (the slingshot)
    if (S.drag && S.drag.live) {
      var bxs = SX(bx, by), bys = SY(bx, by), dx = S.drag.cx - S.drag.sx, dy = S.drag.cy - S.drag.sy;
      c.strokeStyle = S.pal[C_FAINT]; c.lineWidth = 1.5; c.setLineDash([3, 4]);
      c.beginPath(); c.moveTo(bxs, bys); c.lineTo(bxs + dx * 0.6, bys + dy * 0.6); c.stroke(); c.setLineDash([]);
      c.strokeStyle = S.pal[ci]; c.lineWidth = Math.max(2, sc * 0.12);
      c.beginPath(); c.arc(bxs, bys, sc * 0.55, -Math.PI / 2, -Math.PI / 2 + pow * Math.PI * 2); c.stroke();
    }
  }
  function banner(c, m) {
    var SW = S.SW, SH = S.SH, big = Math.max(14, Math.min(30, SW / (m.text.length + 6) * 1.55)), small = Math.max(11, Math.min(14, big * 0.55));
    var hh = big * 1.6 + (m.sub ? small * 1.7 : 0), y = SH * 0.42 - hh / 2, k = m.t < 0.15 ? m.t / 0.15 : m.t > m.dur - 0.25 ? Math.max(0, (m.dur - m.t) / 0.25) : 1;
    c.globalAlpha = k;
    c.font = '700 ' + big.toFixed(1) + 'px ' + S.col.font;
    var w = c.measureText('[ ' + m.text + ' ]').width;
    if (m.sub) { c.font = '500 ' + small.toFixed(1) + 'px ' + S.col.font; w = Math.max(w, c.measureText(m.sub).width); }
    w = Math.min(SW - 12, w + 28);
    c.fillStyle = S.col.hud; c.fillRect(SW / 2 - w / 2, y, w, hh);
    c.strokeStyle = S.pal[m.ci]; c.lineWidth = 1; c.strokeRect(SW / 2 - w / 2 + 0.5, y + 0.5, w - 1, hh - 1);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = '700 ' + big.toFixed(1) + 'px ' + S.col.font; c.fillStyle = S.pal[m.ci];
    c.fillText(m.text, SW / 2, y + big * 0.85, SW - 20);
    if (m.sub) { c.font = '500 ' + small.toFixed(1) + 'px ' + S.col.font; c.fillStyle = S.pal[C_MUTED]; c.fillText(m.sub, SW / 2, y + big * 1.6 + small * 0.75, SW - 24); }
    c.globalAlpha = 1;
  }

  // ---- players ----
  function humans() { var n = 0; S.g.players.forEach(function (p) { if (!p.cpu) n++; }); return n; }
  function pname(i, g) {
    g = g || S.g;
    var p = g.players[i], nh = 0, nc = 0;
    g.players.forEach(function (q) { if (q.cpu) nc++; else nh++; });
    if (p.cpu) return 'CPU' + (nc > 1 ? ' ' + (i + 1) : '');
    return nh === 1 && g.players.length > 1 ? 'You' : g.players.length === 1 ? 'You' : 'P' + (i + 1);
  }
  function isCpuTurn() { return S.g && S.g.players[S.g.cur].cpu > 0; }

  // ---- HUD (DOM) ----
  function syncHud() {
    if (!S || !S.g) { if (S) S.hud.innerHTML = ''; return; }
    var g = S.g, h = curHole(g), tot = totals(g), parts = [];
    var hn = g.course === 'practice' ? 'PRACTICE ' + (g.holes[0] + 1) : 'HOLE ' + (g.hi + 1) + '<i>/' + g.holes.length + '</i>';
    parts.push('<span class="mg-h1">' + hn + '</span><span class="mg-par">PAR ' + h.par + '</span>');
    var pl = g.players.map(function (p, i) {
      var on = i === g.cur && (g.phase === 'aim' || g.phase === 'roll' || g.phase === 'holed');
      return '<span class="mg-pl ' + P_CLS[i] + (on ? ' on' : '') + '"><b>' + esc(pname(i)) + '</b> ' + (tot[i].strokes ? sgn(tot[i].toPar) : '-') + '</span>';
    }).join('');
    parts.push('<span class="mg-pls">' + pl + '</span>');
    parts.push('<span class="mg-st">' + (g.phase === 'aim' || g.phase === 'roll' ? 'STROKE <b>' + (g.strokes + (g.phase === 'aim' ? 1 : 0)) + '</b>' : '') + '</span>');
    var html = parts.join('');
    if (html !== S.hudHtml) { S.hud.innerHTML = html; S.hudHtml = html; }
  }
  function syncPow() {
    if (!S || !S.powEl) return;
    var p = Math.round(S.aim.pow * 100);
    var cells = 10, on = Math.round(S.aim.pow * cells), bar = '';
    for (var i = 0; i < cells; i++) bar += i < on ? '#' : '-';
    var s = '[' + bar + '] ' + (p < 10 ? '  ' : p < 100 ? ' ' : '') + p + '%';
    if (s !== S.powTxt) { S.powEl.textContent = s; S.powTxt = s; S.powEl.className = 'mg-pow ' + (S.aim.pow < 0.45 ? 'lo' : S.aim.pow < 0.78 ? 'mid' : 'hi'); }
  }

  // ---- cards ----
  function courseLabel(c, pr) { return c === 'practice' ? 'Practice — hole ' + (pr + 1) : COURSES[c].name; }
  function bestLine(c) {
    var b = S.save.best[c], par = coursePar(COURSES[c].holes);
    return b ? b + ' (' + sgn(b - par) + ')' : '-';
  }
  function menuHtml() {
    var su = S.save.setup, h = '';
    h += '<div class="mg-card mg-menu">';
    h += '<div class="mg-top"><span class="mg-brand">MINI GOLF</span><span class="mg-meta">' + (S.save.rounds ? S.save.rounds + ' round' + (S.save.rounds === 1 ? '' : 's') : '18 holes') + '</span></div>';
    h += '<div class="mg-tabs" role="tablist">' + ['play', 'records'].map(function (tb) {
      return '<button type="button" role="tab" data-tab="' + tb + '" aria-selected="' + (S.tab === tb) + '" class="' + (S.tab === tb ? 'on' : '') + '">' + (tb === 'play' ? 'Play' : 'Records') + '</button>';
    }).join('') + '</div>';
    if (S.tab === 'play') {
      if (S.resume) {
        var o = S.resume;
        h += '<button type="button" class="mg-resume" data-act="resume-round"><b>Resume round</b><span>' + esc(courseLabel(o.course, o.holes[0])) + (o.course === 'practice' ? '' : ' · hole ' + ((o.hi | 0) + 1) + ' of ' + o.holes.length) + ' · ' + o.players.length + ' player' + (o.players.length > 1 ? 's' : '') + '</span></button>';
      }
      h += '<div class="mg-sec"><div class="mg-h">Course</div><div class="mg-chips">' + ['front', 'back', 'all', 'practice'].map(function (c) {
        var lab = c === 'practice' ? 'Practice' : COURSES[c].name, sub = c === 'practice' ? 'one hole' : 'par ' + coursePar(COURSES[c].holes);
        return '<button type="button" class="mg-chip' + (su.course === c ? ' on' : '') + '" data-course="' + c + '" aria-pressed="' + (su.course === c) + '">' + lab + '<i>' + sub + '</i></button>';
      }).join('') + '</div>';
      if (su.course === 'practice') {
        var ph = HOLES[su.practice];
        h += '<div class="mg-stepper"><button type="button" class="mg-sq" data-act="ph-prev" aria-label="Previous hole">&lt;</button><span><b>' + (su.practice + 1) + '</b> ' + esc(ph.name) + ' <i>par ' + ph.par + (S.save.hole[su.practice] ? ' · best ' + S.save.hole[su.practice] : '') + '</i></span><button type="button" class="mg-sq" data-act="ph-next" aria-label="Next hole">&gt;</button></div>';
      }
      h += '</div>';
      h += '<div class="mg-sec"><div class="mg-h">Players <i>tap a seat: you / CPU</i></div><div class="mg-chips mg-seats">';
      var fake = { players: su.seats.map(function (v) { return { cpu: v }; }) };
      su.seats.forEach(function (v, i) {
        h += '<button type="button" class="mg-chip mg-seat ' + P_CLS[i] + (v ? ' cpu' : '') + '" data-seat="' + i + '" aria-label="Seat ' + (i + 1) + ': ' + (v ? 'CPU' : 'human') + ' (tap to switch)"><b class="mg-dot">o</b>' + esc(pname(i, fake)) + '<i>' + (v ? LEVELS[su.level].name.toLowerCase() : 'human') + '</i></button>';
      });
      if (su.seats.length < 4) h += '<button type="button" class="mg-chip mg-add" data-act="seat-add" aria-label="Add a player">+</button>';
      if (su.seats.length > 1) h += '<button type="button" class="mg-chip mg-add" data-act="seat-del" aria-label="Remove the last player">&minus;</button>';
      h += '</div><div class="mg-presets"><button type="button" class="mg-lnk" data-preset="solo">Solo</button><button type="button" class="mg-lnk" data-preset="cpu">vs CPU</button><button type="button" class="mg-lnk" data-preset="2p">2 players</button><button type="button" class="mg-lnk" data-preset="4p">4 players</button></div></div>';
      if (su.seats.some(function (v) { return v; })) {
        h += '<div class="mg-sec"><div class="mg-h">CPU golfer</div><div class="mg-chips">' + [1, 2, 3].map(function (l) {
          return '<button type="button" class="mg-chip' + (su.level === l ? ' on' : '') + '" data-level="' + l + '" aria-pressed="' + (su.level === l) + '">' + LEVELS[l].name + '</button>';
        }).join('') + '</div></div>';
      }
      if (!su.seats.some(function (v) { return !v; })) h += '<div class="mg-note">All CPUs — sit back and watch.</div>';
    } else {
      var r = S.save, rows = [['Front 9', bestLine('front')], ['Back 9', bestLine('back')], ['All 18', bestLine('all')], ['Holes in one', String(r.aces)], ['Rounds', String(r.rounds)], ['Putts', String(r.putts)]];
      h += '<pre class="mg-tab">' + rows.map(function (q) { return esc(q[0]) + new Array(Math.max(1, 24 - q[0].length - q[1].length) + 1).join(' ') + '<b>' + esc(q[1]) + '</b>'; }).join('\n') + '</pre>';
      h += '<div class="mg-h">Best on each hole</div><div class="mg-grid">' + HOLES.map(function (ho, i) {
        var b = r.hole[i], cls = !b ? '' : b === 1 ? ' ace' : b < ho.par ? ' under' : b === ho.par ? ' par' : ' over';
        return '<span class="mg-gc' + cls + '" title="' + esc((i + 1) + '. ' + ho.name + ' — par ' + ho.par + (b ? ', best ' + b : '')) + '"><i>' + (i + 1) + '</i><b>' + (b || '·') + '</b></span>';
      }).join('') + '</div>';
      h += '<div class="mg-foot">' + (S.resetArm ?
        '<span class="mg-confirm">Erase all records?</span><span><button type="button" class="mg-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="mg-lnk" data-act="reset-no">Keep</button></span>' :
        '<span></span><button type="button" class="mg-lnk" data-act="reset">Reset records</button>') + '</div>';
    }
    return h + '</div>';
  }
  function helpHtml(first) {
    var keys = S.coarse ?
      '<div><b>drag back</b> &nbsp;from anywhere on the green, like a slingshot</div><div><b>let go</b> &nbsp;to putt — farther back is harder</div><div><b>&lt; &gt; &minus; +</b> &nbsp;fine-tune the aim, then <b>PUTT</b></div>' :
      '<div><b>drag back</b> &nbsp;with the mouse, let go to putt</div><div><b>&larr; &rarr;</b> &nbsp;aim (Shift: fine) &nbsp; <b>&uarr; &darr;</b> &nbsp;power</div><div><b>Space / Enter</b> &nbsp;putt &nbsp; <b>C</b> &nbsp;scorecard &nbsp; <b>P / Esc</b> &nbsp;pause</div><div><b>gamepad</b> &nbsp;stick aims, A putts</div>';
    return '<div class="mg-card mg-help">' +
      '<pre class="mg-art" aria-hidden="true">   |&gt;\n   |        .  .  o\n  (_)   ~~~   ---\'</pre>' +
      '<div class="mg-title">MINI GOLF</div>' +
      '<p>Get the ball in the cup in as few strokes as you can. Each hole has a <b>par</b>; a hole stops counting at par + 3 (at least 6).</p>' +
      '<div class="mg-keys">' + keys + '</div>' +
      '<div class="mg-keys mg-legend">' +
      '<div><b class="k-wall">+--</b> walls and <b class="k-wall">/ \\</b> banks &nbsp;<span>bounce off them</span></div>' +
      '<div><b class="k-sand">:::</b> sand &nbsp;<span>slows you right down</span></div>' +
      '<div><b class="k-water">~~~</b> water &nbsp;<span>+1 stroke, back to where you hit from</span></div>' +
      '<div><b class="k-wood">===</b> bridge &nbsp;<span>safe over the water</span></div>' +
      '<div><b class="k-leaf">&gt;&gt;&gt;</b> slope &nbsp;<span>pushes the ball that way</span></div>' +
      '<div><b class="k-red">(o)</b> bumper &nbsp;<span>kicks the ball away</span></div>' +
      '<div><b class="k-vio">(1)</b> tunnel &nbsp;<span>out of its twin, same speed</span></div>' +
      '<div><b class="k-flame">-x-</b> windmill, <b class="k-vio">[=]</b> doors &nbsp;<span>time your putt</span></div></div>' +
      '<p class="mg-tip">The cup only takes a ball that is <b>slow enough</b> — too fast and it lips out. Up to 4 players take turns on one device; any seat can be a CPU.</p>' +
      (first ? '' : '<button type="button" class="mg-go" data-act="close-help">Back</button>') + '</div>';
  }
  function cardTable(g, hiNow) {
    var nh = g.holes.length, blocks = nh > 9 ? [[0, 9], [9, nh]] : [[0, nh]], tot = totals(g), h = '';
    blocks.forEach(function (bk, bi) {
      h += '<table class="mg-sc"><thead><tr><th>' + (nh > 9 ? (bi ? 'IN' : 'OUT') : 'HOLE') + '</th>';
      for (var k = bk[0]; k < bk[1]; k++) h += '<th' + (k === hiNow ? ' class="now"' : '') + '>' + (g.holes[k] + 1) + '</th>';
      h += '<th>' + (blocks.length > 1 ? (bi ? 'IN' : 'OUT') : 'TOT') + '</th></tr><tr class="par"><td>par</td>';
      var ps = 0;
      for (k = bk[0]; k < bk[1]; k++) { var pr = HOLES[g.holes[k]].par; ps += pr; h += '<td>' + pr + '</td>'; }
      h += '<td>' + ps + '</td></tr></thead><tbody>';
      g.players.forEach(function (p, i) {
        var s = 0;
        h += '<tr class="' + P_CLS[i] + '"><td><b>' + esc(pname(i, g)) + '</b></td>';
        for (k = bk[0]; k < bk[1]; k++) {
          var n = g.scores[i][k], par = HOLES[g.holes[k]].par;
          s += n;
          h += '<td class="' + (!n ? 'e' : n === 1 ? 'ace' : n < par ? 'under' : n > par ? 'over' : '') + '">' + (n || '·') + '</td>';
        }
        h += '<td class="t">' + (s || '·') + '</td></tr>';
      });
      h += '</tbody></table>';
    });
    if (blocks.length > 1) h += '<div class="mg-tots">' + g.players.map(function (p, i) { return '<span class="' + P_CLS[i] + '"><b>' + esc(pname(i, g)) + '</b> ' + (tot[i].strokes || 0) + ' <i>' + sgn(tot[i].toPar) + '</i></span>'; }).join('') + '</div>';
    return '<div class="mg-scw">' + h + '</div>';
  }
  function scorecardHtml(kind) {
    var g = S.g, h = curHole(g), st = standings(g);
    var head = kind === 'card' ? '<div class="mg-title">HOLE ' + (g.hi + 1) + ' DONE</div><div class="mg-sub">' + esc(h.name) + ' · par ' + h.par + '</div>' : '<div class="mg-title">SCORECARD</div>';
    var lead = '';
    if (kind === 'card' && g.players.length > 1) {
      var ldr = st.filter(function (x) { return x.place === 1; });
      lead = '<div class="mg-note">' + (ldr.length > 1 ? 'All square at the top' : esc(pname(ldr[0].p)) + ' lead' + (pname(ldr[0].p) === 'You' ? '' : 's') + ' (' + sgn(ldr[0].toPar) + ')') + ' · next: ' + esc(HOLES[g.holes[g.hi + 1]].name) + '</div>';
    } else if (kind === 'card') lead = '<div class="mg-note">Next: ' + (g.hi + 2) + '. ' + esc(HOLES[g.holes[g.hi + 1]].name) + ' · par ' + HOLES[g.holes[g.hi + 1]].par + '</div>';
    return '<div class="mg-card mg-cardv">' + head + cardTable(g, g.hi) + lead +
      (kind === 'view' ? '<button type="button" class="mg-go" data-act="close-card">Back</button>' : '') + '</div>';
  }
  function resultsHtml() {
    var g = S.g, st = standings(g), nb = S.nb || { course: false, holes: [] }, h = '';
    var multi = g.players.length > 1, w = st[0], tie = multi && st.length > 1 && st[1].place === 1;
    h += '<div class="mg-card mg-res"><div class="mg-title">' + (g.course === 'practice' ? 'HOLED OUT' : 'ROUND OVER') + '</div>';
    if (multi) h += '<div class="mg-big ' + (tie ? '' : P_CLS[w.p]) + '">' + (tie ? 'A TIE' : esc(pname(w.p)) + (pname(w.p) === 'You' ? ' WIN' : ' WINS')) + '</div>';
    else h += '<div class="mg-big">' + w.strokes + ' <small>' + sgn(w.toPar) + '</small></div>';
    if (nb.course) h += '<div class="mg-new">** new best ' + esc(COURSES[g.course] ? COURSES[g.course].name : '') + ' **</div>';
    h += cardTable(g, -1);
    if (multi) h += '<pre class="mg-tab">' + st.map(function (x) { var nm = x.place + '. ' + pname(x.p); return esc(nm) + new Array(Math.max(1, 18 - nm.length) + 1).join(' ') + '<b>' + x.strokes + ' (' + sgn(x.toPar) + ')</b>'; }).join('\n') + '</pre>';
    if (nb.holes.length) h += '<div class="mg-new">new best on ' + nb.holes.map(function (i) { return 'hole ' + (i + 1); }).join(', ') + '</div>';
    if (S.aces) h += '<div class="mg-new">' + S.aces + ' hole' + (S.aces > 1 ? 's' : '') + ' in one!</div>';
    return h + '</div>';
  }
  function handoffHtml() {
    var g = S.g, i = g.cur;
    return '<div class="mg-card mg-hand"><div class="mg-title">PASS THE PUTTER</div>' +
      '<div class="mg-big ' + P_CLS[i] + '">' + esc(pname(i)) + '</div>' +
      '<div class="mg-sub">' + (g.oi === 0 ? 'tees off on hole ' + (g.hi + 1) : 'your turn on hole ' + (g.hi + 1)) + ' · ' + esc(curHole(g).name) + '</div>' +
      '<div class="mg-note">' + (S.coarse ? 'Tap Ready' : 'Space or Ready') + ' when ' + esc(pname(i)) + ' has the ' + (S.coarse ? 'device' : 'keyboard') + '</div></div>';
  }
  function pauseHtml() {
    return '<div class="mg-card mg-pause"><div class="mg-title">PAUSED</div>' +
      '<div class="mg-sub">' + esc(curHole(S.g).name) + ' · ' + esc(pname(S.g.cur)) + ', stroke ' + (S.g.strokes + 1) + '</div>' +
      '<div class="mg-btns"><button type="button" class="mg-go" data-act="resume">Resume</button><button type="button" class="mg-go alt" data-act="view-card">Scorecard</button></div>' +
      '<div class="mg-btns"><button type="button" class="mg-go alt" data-act="quit">' + (S.quitArm ? 'Really quit? (saved)' : 'Quit to menu') + '</button></div>' +
      '<div class="mg-note">The round is saved — resume it from the menu.</div></div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'menu' ? menuHtml() : kind === 'help' ? helpHtml(S.firstRun) : kind === 'card' ? scorecardHtml('card') : kind === 'view' ? scorecardHtml('view') :
      kind === 'results' ? resultsHtml() : kind === 'handoff' ? handoffHtml() : kind === 'pause' ? pauseHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind);
    S.ovl.scrollTop = 0;
  }
  function setPad(mode) {
    var h = '';
    S.padMode = mode;
    var k = S.coarse ? '' : ' <small>space</small>';
    if (mode === 'aim') {
      h = '<button type="button" class="mg-pb" data-hold="l" aria-label="Aim left">&lt;</button><button type="button" class="mg-pb" data-hold="r" aria-label="Aim right">&gt;</button>' +
        '<button type="button" class="mg-pb" data-hold="d" aria-label="Less power">&minus;</button><button type="button" class="mg-pb" data-hold="u" aria-label="More power">+</button>' +
        '<button type="button" class="mg-act" data-act="putt">Putt' + k + '</button>';
    } else if (mode === 'wait') h = '<div class="mg-wait">' + esc(S.waitTxt || '') + '</div>';
    else {
      var lab = { start: 'Let’s play', tee: 'Tee off', ready: 'Ready', next: 'Next hole', again: 'Play again', resume: 'Resume', back: 'Back' }[mode] || 'OK';
      h = '<button type="button" class="mg-act" data-act="' + mode + '">' + lab + k + '</button>';
      if (mode === 'again') h += '<button type="button" class="mg-act alt" data-act="menu">Menu</button>';
      if (mode === 'next') h += '<button type="button" class="mg-act alt" data-act="menu">Menu</button>';
    }
    S.pad.innerHTML = h;
    S.powEl = null;
    if (mode === 'aim') {
      var pw = document.createElement('div');
      pw.className = 'mg-pow'; S.pad.insertBefore(pw, S.pad.firstChild); S.powEl = pw; S.powTxt = '';
      syncPow();
    }
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]'), cb = S.head.querySelector('[data-h="card"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.phase !== 'play';
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    cb.disabled = !S.g;
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }
  function live(t) { if (S && S.liveEl) S.liveEl.textContent = t; }

  // ---- flow ----
  function toMenu() {
    stopLoop();
    S.phase = 'menu'; S.paused = false; S.resetArm = false; S.quitArm = false; S.plan = null; S.drag = null;
    S.resume = loadSavedRound();
    // a quiet preview of a hole behind the menu
    if (!S.g || S.gDone) { S.g = newGame('practice', [{ cpu: 0 }], S.save.setup.course === 'practice' ? S.save.setup.practice : COURSES[S.save.setup.course].holes[0]); S.preview = true; }
    clearFx(); S.showAim = false;
    fitView(); syncHud(); S.hud.classList.add('off');
    showCard('menu'); setPad('tee'); syncHead();
    draw(1);
  }
  function startRound(fromSave) {
    S.snd.ensure();
    var su = S.save.setup;
    if (fromSave) {
      S.g = loadRound(fromSave);
      if (!S.g) { toMenu(); return; }
    } else {
      S.g = newGame(su.course, su.seats.map(function (v) { return { cpu: v ? su.level : 0 }; }), su.practice);
      sdel(ROUND_KEY);
    }
    S.preview = false; S.gDone = false; S.aces = 0; S.nb = null;
    S.hud.classList.remove('off');
    beginTurn(true);
  }
  // A player steps up (after the hand-off card if one is due).
  function beginTurn(newHole) {
    var g = S.g;
    S.plan = null; S.drag = null; S.pending = null; S.cpuAim = null;
    clearFx();
    fitView();
    var h = curHole(g);
    S.aim = { ang: Math.atan2(h.cup.y - g.ball.y, h.cup.x - g.ball.x), pow: 0.35 };
    syncHud();
    saveRound();   // the round resumes with this player stepping up (even from the hand-off card)
    if (!g.players[g.cur].cpu && humans() > 1) { S.phase = 'handoff'; showCard('handoff'); setPad('ready'); syncHead(); draw(1); S.newHole = newHole; return; }
    play(newHole);
  }
  function play(newHole) {
    var g = S.g, h = curHole(g);
    S.phase = 'play'; S.paused = false;
    showCard(null);
    if (newHole || S.newHole) {
      say(g.course === 'practice' ? 'HOLE ' + (g.holes[0] + 1) + ' · PAR ' + h.par : 'HOLE ' + (g.hi + 1) + ' · PAR ' + h.par, C_ACC, 2.6, h.name + ' — ' + h.tip);
      S.newHole = false;
    } else if (g.players.length > 1) say(pname(g.cur).toUpperCase() + (pname(g.cur) === 'You' ? 'R TURN' : '’S TURN'), P_SLOT[g.cur % 4], 1.3);
    syncAimUi();
    saveRound();
    live(pname(g.cur) + ' to play hole ' + (g.hi + 1) + ', ' + h.name + ', par ' + h.par + '.');
    kick();
  }
  function syncAimUi() {
    var g = S.g, human = !isCpuTurn(), ready = g.phase === 'aim' && g.ball.st === 'rest';
    S.showAim = ready && (human || !!S.cpuAim);
    if (human && ready) { if (S.padMode !== 'aim') setPad('aim'); }
    else {
      S.waitTxt = isCpuTurn() && ready ? pname(g.cur) + ' is lining up…' : g.phase === 'roll' ? '' : '';
      if (S.padMode !== 'wait' || S.pad.textContent !== S.waitTxt) setPad('wait');
    }
    syncHud(); syncHead();
  }
  function doPutt() {
    var g = S.g;
    if (!g || S.phase !== 'play' || S.paused || isCpuTurn() || g.phase !== 'aim' || g.ball.st !== 'rest') return;
    if (S.aim.pow < 0.02) return;
    S.snd.ensure();
    shoot(g, S.aim.ang, S.aim.pow);
    S.save.putts++; persist();
    afterPutt();
  }
  function afterPutt() {
    S.showAim = false; S.drag = null; S.trail.length = 0;
    var p = S.aim.pow;
    S.snd.tone(320 + p * 500, 0.06, 'triangle', 0.05); S.snd.tone(180, 0.05, 'sine', 0.04);
    Cade.haptic && Cade.haptic(8);
    syncAimUi();
  }
  // ---- the CPU's turn: plan over a few frames, swing the aim to the plan, putt on the planned tick ----
  function cpuThink(dt) {
    var g = S.g;
    if (!isCpuTurn() || g.phase !== 'aim' || g.ball.st !== 'rest') return;
    var h = curHole(g), moving = h.mills.length || h.doors.length;
    if (!S.plan) {
      var wait = 0.9 + Math.random() * 0.5;
      S.plan = { P: newPlanner(h, g.ball.x, g.ball.y, g.t + wait, g.players[g.cur].cpu, ((Math.random() * 1e9) | 0) + 1), at: g.t + wait, tries: 0, shot: null };
      S.cpuAim = { from: S.aim.ang, fromP: S.aim.pow };
      S.showAim = true;
      syncAimUi();
    }
    var pl = S.plan, t0 = performance.now();
    while (!pl.P.done && performance.now() - t0 < 7) planStep(pl.P, 8);
    // swing the guide toward the best line found so far
    if (pl.P.best) {
      var tgt = pl.shot ? pl.shot.ang : pl.P.best.ang, tp = pl.shot ? pl.shot.pow : pl.P.best.pow;
      var da = Math.atan2(Math.sin(tgt - S.aim.ang), Math.cos(tgt - S.aim.ang));
      S.aim.ang += da * Math.min(1, dt * 5); S.aim.pow += (tp - S.aim.pow) * Math.min(1, dt * 4);
    }
    if (pl.P.done && !pl.shot) {
      if (moving && g.t > pl.at - STEP && pl.tries < 2) {   // too slow to plan in time for the moving parts: plan for later
        pl.tries++; pl.at = g.t + 1.2;
        pl.P = newPlanner(h, g.ball.x, g.ball.y, pl.at, g.players[g.cur].cpu, ((Math.random() * 1e9) | 0) + 1);
        return;
      }
      pl.shot = cpuShot(pl.P, ((Math.random() * 1e9) | 0) + 1);
      if (!moving) pl.at = Math.max(pl.at, g.t + 0.35);
    }
  }
  // Called inside the fixed-step loop, before each step: the CPU putts exactly at its planned time.
  function cpuTick() {
    var pl = S.plan, g = S.g;
    if (!pl || !pl.shot || g.phase !== 'aim' || g.ball.st !== 'rest') return;
    if (g.t + 1e-9 >= pl.at) {
      S.aim.ang = pl.shot.ang; S.aim.pow = pl.shot.pow;
      shoot(g, pl.shot.ang, pl.shot.pow);
      S.plan = null; S.cpuAim = null;
      afterPutt();
    }
  }

  // ---- events from the engine ----
  function handleEvents() {
    var g = S.g, ev = g.ev, b = g.ball, snd = S.snd, h = curHole(g);
    for (var i = 0; i < ev.length; i++) {
      switch (ev[i]) {
        case 'wall':
          var v = Math.min(1, b.hitV / 18);
          if (S.lastWall < S.animT - 0.04) { snd.tone(140 + v * 260, 0.05, 'square', 0.012 + v * 0.03); S.lastWall = S.animT; }
          if (v > 0.6) { S.shake = 0.08; Cade.haptic && Cade.haptic(6); }
          burst(b.x, b.y, 2 + (v * 4 | 0), 2 + v * 4, ".'", C_FAINT, 0.35);
          break;
        case 'bump':
          snd.tone(520, 0.12, 'sine', 0.05, 980);
          for (var q = 0; q < h.bumps.length; q++) if (h.bumps[q].hit) { h.bumps[q].hit = 0; S.bumpFx[q] = 0.22; burst(h.bumps[q].x, h.bumps[q].y, 6, 6, "*'.", C_GOLD, 0.45); }
          Cade.haptic && Cade.haptic(10);
          break;
        case 'warp':
          snd.tone(300, 0.22, 'sine', 0.04, 1200);
          burst(b.x, b.y, 8, 5, '@o.', C_VIOLET, 0.5);
          break;
        case 'lip':
          snd.tone(900, 0.04, 'square', 0.02); snd.tone(700, 0.05, 'square', 0.02, 0, 0.05);
          break;
        case 'swept':
          snd.tone(160, 0.1, 'sine', 0.05, 90);
          say('SWEPT!', C_FLAME, 0.9);
          break;
        case 'water':
          snd.tone(600, 0.35, 'sine', 0.05, 120); snd.tone(240, 0.3, 'triangle', 0.03, 90, 0.05);
          burst(b.x, b.y, 14, 6, '~.o', C_ICE, 0.9);
          S.shake = 0.12;
          break;
        case 'penalty':
          say('SPLASH  +1', C_ICE, 1.3, 'back to where you hit from');
          S.trail.length = 0;
          break;
        case 'sunk':
          S.sunkT = 0;
          snd.tone(330, 0.08, 'sine', 0.06); snd.tone(165, 0.18, 'sine', 0.06, 0, 0.06);
          burst(h.cup.x, h.cup.y, 18, 8, "*+'.", -1, 1.0);
          Cade.haptic && Cade.haptic(18);
          break;
        case 'holed': case 'pickup':
          var L = g.last, nm = scoreName(L.n, L.par);
          if (ev[i] === 'pickup') say('PICKED UP', C_MUTED, 1.6, pname(L.p) + ' scores ' + L.n);
          else {
            var good = L.n < L.par || L.n === 1, ci = L.n === 1 ? C_GOLD : good ? C_ACC : L.n === L.par ? C_TEXT : C_MUTED;
            say(nm + (L.n === 1 ? '!' : ''), ci, 1.7, pname(L.p) + ' · ' + L.n + ' stroke' + (L.n > 1 ? 's' : ''));
            if (L.n === 1) { S.aces++; [523, 659, 784, 1047, 1319].forEach(function (f, j) { snd.tone(f, 0.12, 'square', 0.03, 0, 0.12 + j * 0.08); }); burst(h.cup.x, h.cup.y, 30, 12, '*+o', -1, 1.4); S.shake = 0.2; }
            else if (good) [659, 784, 1047].forEach(function (f, j) { snd.tone(f, 0.11, 'triangle', 0.04, 0, 0.12 + j * 0.08); });
            else snd.tone(440, 0.12, 'triangle', 0.035, 0, 0.12);
          }
          live(pname(L.p) + ': ' + (ev[i] === 'pickup' ? 'picked up, ' : nm.toLowerCase() + ', ') + L.n + ' on hole ' + (g.hi + 1) + '.');
          S.holedT = 0;
          break;
        case 'stop':
          break;
      }
    }
    ev.length = 0;
  }

  // ---- loop: runs only while a hole is in play ----
  function running() { return !!S && S.phase === 'play' && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0, g = S.g;
    S.last = ts; S.animT += dt;
    pollPad(dt);
    if (!running()) return;
    keyAim(dt);
    cpuThink(dt);
    var wasPhase = g.phase;
    g.acc = Math.min(g.acc + dt, 0.25);
    while (g.acc >= STEP) { cpuTick(); stepGame(g); g.acc -= STEP; }
    var alpha = g.acc / STEP;
    if (g.ball.st === 'roll') {
      S.trailT -= dt;
      if (S.trailT <= 0) { S.trailT = 0.035; S.trail.push(g.ball.x, g.ball.y); if (S.trail.length > 36) S.trail.splice(0, 2); }
      var k = cellAt(curHole(g), g.ball.x, g.ball.y);
      if (k >= 0 && curHole(g).t[k] === SAND && speed(g.ball) > 2 && Math.random() < 0.3) spark(g.ball.x, g.ball.y, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 0.4, 46, C_GOLD);
    } else if (S.trail.length && Math.random() < 0.3) S.trail.splice(0, 2);
    if (g.ball.st === 'sunk') S.sunkT += dt;
    handleEvents();
    stepFx(dt);
    if (wasPhase === 'roll' && g.phase === 'aim') { var hc = curHole(g); S.aim.ang = Math.atan2(hc.cup.y - g.ball.y, hc.cup.x - g.ball.x); syncAimUi(); saveRound(); }
    else if (wasPhase === 'aim' && g.phase === 'roll') { if (S.plan) { S.plan = null; S.cpuAim = null; } syncAimUi(); }   // swept mid-plan: plan again from where it stops
    if (g.phase === 'aim' && !isCpuTurn() && S.padMode !== 'aim' && g.ball.st === 'rest') syncAimUi();
    if (S.powEl) syncPow();
    draw(alpha);
    if (g.phase === 'holed') {
      S.holedT += dt;
      if (S.holedT > 1.7) { afterHole(); return; }
    }
    S.raf = requestAnimationFrame(frame);
  }
  function afterHole() {
    stopLoop();
    var g = S.g, r = nextTurn(g);
    if (r === 'turn') { beginTurn(false); return; }
    sdel(ROUND_KEY);
    if (r === 'card') {
      S.phase = 'card'; syncHud(); showCard('card'); setPad('next'); syncHead();
      saveRoundBetween();
      return;
    }
    // the round is over
    S.nb = settle(S.save, g); persist();
    S.gDone = true;
    S.phase = 'results'; syncHud(); showCard('results'); setPad('again'); syncHead();
    var st = standings(g);
    live('Round over. ' + st.map(function (x) { return pname(x.p) + ' ' + x.strokes; }).join(', ') + '.');
    if (S.nb.course) [659, 784, 988, 1319].forEach(function (f, j) { S.snd.tone(f, 0.12, 'triangle', 0.035, 0, j * 0.08); });
  }
  // Between holes the round resumes at the next tee (the best score on this hole has the honour).
  function saveRoundBetween() {
    var g = S.g, prev = g.order.slice(), o = g.players.map(function (x, i) { return i; }), h2 = hole(g.holes[g.hi + 1]);
    o.sort(function (a, b) { return (g.scores[a][g.hi] - g.scores[b][g.hi]) || (prev.indexOf(a) - prev.indexOf(b)); });
    sset(ROUND_KEY, JSON.stringify({ v: 1, course: g.course, holes: g.holes.slice(), players: g.players.map(function (p) { return p.cpu; }),
      scores: g.scores.map(function (r) { return r.slice(); }), hi: g.hi + 1, order: o, oi: 0, strokes: 0, bx: h2.tee.x, by: h2.tee.y, t: 0 }));
  }
  function goNextHole() {
    if (!S || S.phase !== 'card') return;
    nextHole(S.g);
    beginTurn(true);
  }
  function pause() {
    if (!S || S.phase !== 'play' || S.paused) return;
    S.paused = true; S.quitArm = false;
    stopLoop(); clearHeld();
    if (S.drag) { S.aim.ang = S.drag.ang0; S.aim.pow = S.drag.pow0; S.drag = null; }
    showCard('pause'); setPad('resume'); syncHead();
    draw(1);
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null);
    if (isCpuTurn() || S.g.phase !== 'aim') setPad('wait'); else setPad('aim');
    syncAimUi();
    kick();
  }
  function quitRound() {
    saveRound();
    S.paused = false; S.gDone = true;
    toMenu();
  }
  function padAction(act) {
    if (!S) return;
    S.snd.ensure();
    act = act || S.padMode;
    if (act === 'putt') doPutt();
    else if (act === 'tee') { if (S.cardKind === 'menu') startRound(null); else { S.tab = 'play'; showCard('menu'); } }
    else if (act === 'start' || act === 'back' || act === 'menu') { S.firstRun = false; if (S.phase === 'card' || S.phase === 'results') S.gDone = true; toMenu(); }
    else if (act === 'ready') { if (S.phase === 'handoff') play(false); }
    else if (act === 'next') goNextHole();
    else if (act === 'again') { S.gDone = true; startRound(null); }
    else if (act === 'resume') { if (S.cardKind === 'view') { showCard('pause'); } else resume(); }
  }

  // ---- aiming input ----
  function clearHeld() { S.held = { l: 0, r: 0, u: 0, d: 0 }; S.keys = {}; }
  function canAim() { return S && S.phase === 'play' && !S.paused && S.g && !isCpuTurn() && S.g.phase === 'aim' && S.g.ball.st === 'rest'; }
  function keyAim(dt) {
    if (!canAim()) return;
    var hd = S.held, k = S.keys, l = hd.l || k.ArrowLeft || k.KeyA, r = hd.r || k.ArrowRight || k.KeyD, u = hd.u || k.ArrowUp || k.KeyW, d = hd.d || k.ArrowDown || k.KeyS;
    var fine = k.ShiftLeft || k.ShiftRight, rate = (fine ? 0.18 : 1.1) * dt;
    // turn so the guide moves the way the arrow points on screen (the view may be turned)
    if (l || r) {
      S.aimHeldT += dt;
      var acc = Math.min(1, 0.3 + S.aimHeldT * 1.4);
      S.aim.ang += (r ? 1 : -1) * rate * acc;
    } else S.aimHeldT = 0;
    if (u || d) S.aim.pow = clamp(S.aim.pow + (u ? 1 : -1) * (fine ? 0.12 : 0.55) * dt, 0.02, 1);
  }
  var KEY2CODE = { ' ': 'Space', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', enter: 'Enter', escape: 'Escape', p: 'KeyP', c: 'KeyC', a: 'KeyA', d: 'KeyD', w: 'KeyW', s: 'KeyS', shift: 'ShiftLeft' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  var AIM_KEYS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, KeyA: 1, KeyD: 1, KeyW: 1, KeyS: 1 };
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    var code = keyCode(e);
    if (code === 'ShiftLeft' || code === 'ShiftRight') { S.keys[code] = true; return; }
    if (code === 'Escape') {
      e.preventDefault();
      if (S.phase === 'play' && !S.paused) pause();
      else if (S.cardKind === 'view') showCard(S.paused ? 'pause' : S.phase === 'card' ? 'card' : null);
      else if (S.cardKind === 'help' && !S.firstRun) toMenuOrBack();
      else if (S.phase === 'menu') closePanel();
      else if (S.paused) resume();
      return;
    }
    if (code === 'KeyP' && S.phase === 'play') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
    if (code === 'KeyC' && S.g && !S.preview && !e.repeat) { e.preventDefault(); toggleCardView(); return; }
    if (S.phase === 'play' && !S.paused) {
      if (AIM_KEYS[code]) { e.preventDefault(); S.keys[code] = true; return; }
      if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') { e.preventDefault(); if (!e.repeat) doPutt(); return; }
      return;
    }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (!e.repeat) { if (S.paused && S.cardKind === 'pause') resume(); else if (S.cardKind === 'help' && !S.firstRun) toMenuOrBack(); else padAction(); }
    }
  }
  function onKeyUp(e) { if (!S) return; var code = keyCode(e); if (S.keys[code]) delete S.keys[code]; }
  function toMenuOrBack() { if (S.phase === 'menu') showCard('menu'); else if (S.paused) showCard('pause'); }
  function toggleCardView() {
    if (!S.g || S.preview) return;
    if (S.cardKind === 'view') { showCard(S.paused ? 'pause' : S.phase === 'card' ? 'card' : S.phase === 'results' ? 'results' : null); return; }
    if (S.phase === 'play' && !S.paused) pause();
    if (S.phase === 'play' || S.phase === 'card' || S.phase === 'handoff') showCard('view');
  }

  // Gamepad: the left stick turns the aim, up / down sets the power, A putts, Start pauses.
  function readPad() {
    var pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) return pads[i];
    return null;
  }
  function btnOn(p, i) { var b = p.buttons[i]; return !!b && (b.pressed || b.value > 0.5); }
  function pollPad(dt) {
    var p = readPad(), gp = S.gp;
    if (!p) return;
    var ax = p.axes[0] || 0, ay = p.axes[1] || 0;
    if (canAim()) {
      if (Math.abs(ax) > 0.2) S.aim.ang += ax * 1.4 * dt;
      if (btnOn(p, 14)) S.aim.ang -= 0.6 * dt;
      if (btnOn(p, 15)) S.aim.ang += 0.6 * dt;
      if (Math.abs(ay) > 0.3) S.aim.pow = clamp(S.aim.pow - ay * 0.6 * dt, 0.02, 1);
      if (btnOn(p, 12)) S.aim.pow = clamp(S.aim.pow + 0.4 * dt, 0.02, 1);
      if (btnOn(p, 13)) S.aim.pow = clamp(S.aim.pow - 0.4 * dt, 0.02, 1);
    }
    var a = btnOn(p, 0), st = btnOn(p, 9);
    if (a && !gp.a && canAim()) doPutt();
    if (st && !gp.st && S.phase === 'play' && !S.paused) pause();
    gp.a = a; gp.st = st;
  }
  function pollMenus() {
    if (!S || (S.phase === 'play' && !S.paused)) return;
    var p = readPad();
    if (!p) return;
    var a = btnOn(p, 0) || btnOn(p, 9);
    if (a && !S.gp.menuA) { if (S.paused) resume(); else padAction(); }
    S.gp.menuA = a;
  }

  // ---- layout ----
  // Everything in the panel but the stage, measured from the content (not the
  // panel box: a panel clamped to the screen hides how tall its body wants to
  // be, which made the green too tall and pushed the pad off a phone screen).
  function chromeH() {
    var r = S.panel.getBoundingClientRect(), bd = S.panel.querySelector('.cade-panel-body');
    if (!r.height || !bd) return 0;
    return (r.height - bd.clientHeight) + bd.scrollHeight - (S.stage.offsetHeight || 0);
  }
  // the room left for the stage: the visible viewport below the panel's top
  function availH(vw, vh, chrome) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height || !chrome) return vh - (vw <= 560 ? 230 : 240);
    var room = vh - Math.min(Math.max(0, r.top), 140), mx = getComputedStyle(S.panel).maxHeight, mh = /px$/.test(mx) ? parseFloat(mx) : 0;
    if (mh > 0) room = Math.min(room, mh);                              // the app caps the panel to the window it opened in
    return room - chrome - 6;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.width && vv.scale <= 1.01) vw = Math.min(vw, vv.width);
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    // a short, wide screen (a phone on its side): the pad goes beside the green
    var side = vh < 520 && vw > vh * 1.25 && vw >= 480;
    S.panel.classList.toggle('mg-side', side);
    var gut = side ? (solo ? 24 : 40) : phone ? (solo ? 20 : 34) : 48;
    var padW = side ? 178 : 0;                                         // .mg-side .mg-pad width + gap
    var W = Math.floor(Math.min(vw - gut - padW, solo ? 1100 : 760)), ch = chromeH(), ah = availH(vw, vh, ch), H;
    ah = Math.floor(Math.max(side ? 120 : 160, ah));
    if (W < ah * 0.9) H = Math.min(ah, Math.round(W * 1.7));           // a tall stage: holes turn on their side
    else H = Math.min(ah, Math.round(W * 0.62));
    H = Math.max(H, Math.min(ah, 220));
    if (side && W > H * 2.6) W = Math.round(H * 2.6);                   // no letterboxed strip of a green
    var dpr = Math.min(W * H > 360000 ? 2 : 3, Math.max(1, window.devicePixelRatio || 1));   // crisp glyphs on a phone, bounded memory on a big screen
    S.SW = W; S.SH = H;
    S.cv.style.width = W + 'px'; S.cv.style.height = H + 'px';
    S.stage.style.width = W + 'px'; S.stage.style.height = H + 'px';
    S.panel.style.setProperty('--mg-w', W + 'px');
    S.cv.width = Math.round(W * dpr); S.cv.height = Math.round(H * dpr);
    S.k = S.cv.width / W;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    S.sc = 0;
    S.lay = { vw: vw, vh: vh, chrome: ch, side: side };
    if (S.g) fitView();
  }
  // the HUD wrapping or the pad changing mode moves the chrome: fit again
  function relayoutIfMoved() {
    if (!S || !S.lay || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var ch = chromeH();
    if (ch && Math.abs(ch - S.lay.chrome) > 1) { layout(); redraw(); }
  }
  function redraw() { if (!S) return; if (S.raf) return; draw(1); }

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
    window.removeEventListener('orientationchange', s.onResize);
    if (s.ro) s.ro.disconnect();
    if (s.themeObs) s.themeObs.disconnect();
    if (s.phase === 'play' && s.g && !s.preview) { try { var snap = snapRound(s.g); if (snap) sset(ROUND_KEY, JSON.stringify(snap)); } catch (e) {} }
    s.snd.close();
    if (s.atl) freeCanvas(s.atl.cv);
    freeCanvas(s.layer);
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
    var body = '<div class="mg"><div class="mg-hud off"></div><div class="mg-stage"><canvas class="mg-cv"></canvas><div class="mg-ovl" style="display:none"></div></div>' +
      '<div class="mg-pad"></div><div class="mg-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '⛳ Mini Golf', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'mg-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="card" title="Scorecard (C)" aria-label="Scorecard">' + IC_CARD + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, hud: p.querySelector('.mg-hud'), stage: p.querySelector('.mg-stage'), cv: p.querySelector('.mg-cv'), ovl: p.querySelector('.mg-ovl'),
      pad: p.querySelector('.mg-pad'), liveEl: p.querySelector('.mg-live'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'menu', g: null, preview: true, gDone: true, paused: false, raf: 0, last: 0, animT: 0,
      keys: {}, held: { l: 0, r: 0, u: 0, d: 0 }, aimHeldT: 0, gp: { a: false, st: false, menuA: false }, gpT: 0,
      pal: new Array(NPAL), col: null, atl: null, layer: null, layerDirty: true, k: 1, SW: 480, SH: 300, sc: 0, V: null,
      aim: { ang: 0, pow: 0.35 }, drag: null, plan: null, cpuAim: null, showAim: false, trail: [], trailT: 0, sunkT: 0, holedT: 0, shake: 0, bumpFx: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      lastWall: 0, aces: 0, nb: null, tab: 'play', resetArm: false, quitArm: false, padMode: '', cardKind: null, hudHtml: '', water: [], slopes: []
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
    S.onBlur = function () { if (S) { pause(); clearHeld(); } };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      pause(); clearHeld(); stopLoop();
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
    window.addEventListener('orientationchange', S.onResize);
    try {
      S.ro = new ResizeObserver(function () { if (S && S.panel === p) requestAnimationFrame(relayoutIfMoved); });
      S.ro.observe(S.hud); S.ro.observe(S.pad);
    } catch (e) {}
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
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'card') toggleCardView();
      else if (h === 'help') {
        if (S.phase === 'play' && !S.paused) pause();
        if (S.cardKind === 'help') toMenuOrBack();
        else if (S.phase === 'menu' || S.paused) showCard('help');
      }
      try { b.blur(); } catch (er) {}
    });

    // Fast taps must never zoom, select, magnify or open a callout.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchmove', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    S.pad.addEventListener('touchstart', function (e) { if (e.target.closest && e.target.closest('[data-hold]')) noTouch(e); }, { passive: false });
    S.pad.addEventListener('touchend', function (e) {
      var b = e.target.closest && e.target.closest('button');
      if (!b) return;
      noTouch(e);
      if (!b.hasAttribute('data-hold') && !b.disabled) b.click();     // a quick tap still clicks (no double-tap zoom)
    }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    // drag back to aim: from anywhere on the stage, like a slingshot; let go to putt
    function stagePt(e) {
      var r = S.cv.getBoundingClientRect(), fx = r.width ? S.SW / r.width : 1, fy = r.height ? S.SH / r.height : 1;
      return { x: (e.clientX - r.left) * fx, y: (e.clientY - r.top) * fy };
    }
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (!canAim() || S.drag) return;
      var q = stagePt(e);
      try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
      S.drag = { id: e.pointerId, sx: q.x, sy: q.y, cx: q.x, cy: q.y, ang0: S.aim.ang, pow0: S.aim.pow, live: false };
    });
    S.cv.addEventListener('pointermove', function (e) {
      if (!S || !S.drag || S.drag.id !== e.pointerId) return;
      if (!canAim()) { S.drag = null; return; }
      var q = stagePt(e), d = S.drag, dx = d.sx - q.x, dy = d.sy - q.y, len = Math.sqrt(dx * dx + dy * dy);
      d.cx = q.x; d.cy = q.y;
      if (len > 8) {
        d.live = true;
        var w = toWorldV(dx, dy), full = Math.max(90, Math.min(S.SW, S.SH) * 0.42);
        S.aim.ang = Math.atan2(w.y, w.x);
        S.aim.pow = clamp((len - 8) / full, 0, 1);
      } else if (d.live) S.aim.pow = 0;
      if (!S.raf) draw(1);
    });
    function endDrag(e, cancel) {
      if (!S || !S.drag || S.drag.id !== e.pointerId) return;
      var d = S.drag;
      S.drag = null;
      if (!cancel && d.live && S.aim.pow >= 0.03) doPutt();
      else if (d.live) { S.aim.ang = d.ang0; S.aim.pow = d.pow0; }
    }
    S.cv.addEventListener('pointerup', function (e) { endDrag(e, false); });
    S.cv.addEventListener('pointercancel', function (e) { endDrag(e, true); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // the pad: held aim buttons, putt and the flow buttons
    S.pad.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-hold]') : null;
      if (!b || !S) return;
      e.preventDefault();
      S.snd.ensure();
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      var k = b.getAttribute('data-hold');
      S.held[k] = 1; b.classList.add('on');
      // a tap nudges one notch even if released at once
      if (canAim()) {
        if (k === 'l') S.aim.ang -= 0.6 * Math.PI / 180; else if (k === 'r') S.aim.ang += 0.6 * Math.PI / 180;
        else if (k === 'u') S.aim.pow = clamp(S.aim.pow + 0.01, 0.02, 1); else S.aim.pow = clamp(S.aim.pow - 0.01, 0.02, 1);
        if (!S.raf) draw(1);
      }
    });
    function padUp(e) {
      var b = e.target.closest ? e.target.closest('[data-hold]') : null;
      if (!b || !S) return;
      S.held[b.getAttribute('data-hold')] = 0; b.classList.remove('on');
    }
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.pad.addEventListener(t, padUp); });
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
      var su = S.save.setup, a = b.getAttribute('data-act'), tab = b.getAttribute('data-tab'), course = b.getAttribute('data-course'),
        seat = b.getAttribute('data-seat'), lvl = b.getAttribute('data-level'), pre = b.getAttribute('data-preset'), re = true;
      if (tab) { S.tab = tab; S.resetArm = false; }
      else if (course) { su.course = course; }
      else if (seat !== null) { var i = +seat; su.seats[i] = su.seats[i] ? 0 : 1; }
      else if (lvl) su.level = +lvl;
      else if (pre) su.seats = pre === 'solo' ? [0] : pre === 'cpu' ? [0, 1] : pre === '2p' ? [0, 0] : [0, 0, 0, 0];
      else if (a === 'seat-add') { if (su.seats.length < 4) su.seats.push(su.seats.length && su.seats.every(function (v) { return !v; }) ? 0 : 1); }
      else if (a === 'seat-del') { if (su.seats.length > 1) su.seats.pop(); }
      else if (a === 'ph-prev') su.practice = (su.practice + HOLES.length - 1) % HOLES.length;
      else if (a === 'ph-next') su.practice = (su.practice + 1) % HOLES.length;
      else if (a === 'resume-round') { var o = S.resume; if (o) startRound(o); return; }
      else if (a === 'reset') S.resetArm = true;
      else if (a === 'reset-no') S.resetArm = false;
      else if (a === 'reset-yes') { var keep = S.save.setup; S.save = newSave(); S.save.setup = keep; S.resetArm = false; Cade.showToast && Cade.showToast('Records reset', 'info', 1600); }
      else if (a === 'close-help') { S.firstRun = false; toMenuOrBack(); return; }
      else if (a === 'resume') { resume(); return; }
      else if (a === 'view-card') { showCard('view'); return; }
      else if (a === 'close-card') { showCard(S.paused ? 'pause' : S.phase === 'card' ? 'card' : S.phase === 'results' ? 'results' : null); return; }
      else if (a === 'quit') { if (S.quitArm) quitRound(); else { S.quitArm = true; showCard('pause'); } return; }
      else re = false;
      if (!re) return;
      persist();
      if (S.phase === 'menu') {
        // the preview behind the menu follows the course pick
        var ph = su.course === 'practice' ? su.practice : COURSES[su.course].holes[0];
        if (S.g && S.preview && S.g.holes[0] !== ph) { S.g = newGame('practice', [{ cpu: 0 }], ph); fitView(); draw(1); }
        showCard('menu');
        var sel = e.detail === 0 && (S.ovl.querySelector('[data-tab="' + tab + '"]') || S.ovl.querySelector('[data-course="' + course + '"]') || S.ovl.querySelector('[data-seat="' + seat + '"]') || S.ovl.querySelector('[data-level="' + lvl + '"]') || S.ovl.querySelector('[data-act="' + a + '"]'));
        if (sel) { try { sel.focus({ preventScroll: true }); } catch (er) {} }
      }
      S.snd.tone(988, 0.04, 'sine', 0.025);
    });

    S.resume = loadSavedRound();
    if (S.firstRun) {
      persist();
      S.g = newGame('practice', [{ cpu: 0 }], 0); S.preview = true;
      fitView();
      S.phase = 'menu'; showCard('help'); setPad('start'); syncHead();
      draw(1);
    } else toMenu();
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); layout(); redraw(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('700 12px ' + S.col.font).then(function () { if (S && S.panel === p) { buildAtlas(); S.layerDirty = true; redraw(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: '18 ASCII holes of bank shots, windmills, slopes and water — par and scorecards',
    icon: '⛳',
    tags: 'game,sport,fun,golf,mini golf,putt,physics,2 player',
    open: open,
    _engine: ENGINE
  });
})();
