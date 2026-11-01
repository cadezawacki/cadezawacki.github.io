/* Darts — a pub dartboard drawn in glyphs, for Cade.txt.
 * Aim with a swaying reticle (your hand is never quite still): hold to steady
 * your breath — the sway shrinks — and let go to throw. Hold too long and the
 * arm tires and shakes. Mouse: hover to aim, press-hold-release to throw.
 * Touch: tap to place the aim, then press and hold anywhere (drag to fine-tune)
 * and release. Keys: arrows / WASD aim, hold Space to steady, release to throw.
 * Gamepad: stick aims, hold A.
 * Modes: 301 / 501 / 701 (double-out optional, bust rules, checkout hints,
 * legs), Cricket (15–20 + bull, marks and points, 20-round cap), Around the
 * Clock (1 → 20 → bull; doubles and trebles skip ahead) and Practice.
 * 1–4 players: solo, vs CPU (Easy / Medium / Hard / Pro — it aims at sensible
 * targets: checkout routes, setup shots, cricket tactics — with a scatter) or
 * pass-and-play. Stats for player one: 3-dart averages, best checkout, 180s,
 * cricket marks per round, around-the-clock darts.
 * The board is drawn with glyphs on concentric rings (cached once per theme /
 * size); the loop runs a fixed 120 Hz step with render interpolation, only
 * while a match is on screen, and pauses on blur, tab hide and minimize.
 * Saves in Cade.store (cade-darts-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // Board coordinates: the board's scoring radius is 1 (outer edge of the
  // double ring); x → right, y → up; 20 sits at the top.
  var ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  // Ring radii. A touch wider than a regulation board (trebles 0.58–0.63,
  // doubles 0.95–1.0) so the rings read at glyph resolution — still a test.
  var R_DB = 0.05, R_SB = 0.12, R_T0 = 0.56, R_T1 = 0.645, R_D0 = 0.915, R_D1 = 1;
  var STEP = 1 / 120;
  var BULL = 25;
  var MODES = ['x01', 'cricket', 'atc', 'practice'];
  var CRICKET_NUMS = [20, 19, 18, 17, 16, 15, 25];
  var CRICKET_ROUNDS = 20;
  var ATC_SEQ = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 25];
  var CPU_LEVELS = [
    { id: 'easy', name: 'Easy', sigma: 0.22 },
    { id: 'medium', name: 'Medium', sigma: 0.145 },
    { id: 'hard', name: 'Hard', sigma: 0.1 },
    { id: 'pro', name: 'Pro', sigma: 0.068 }
  ];
  // Your hand: the sway's base amplitude (board units).
  var HANDS = [
    { id: 'steady', name: 'Steady', amp: 0.18 },
    { id: 'normal', name: 'Normal', amp: 0.24 },
    { id: 'shaky', name: 'Shaky', amp: 0.31 }
  ];
  var RELEASE_SIGMA = 0.02;   // a clean release still scatters a little

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // Small seeded PRNG (mulberry32), so a CPU match is reproducible.
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) {
    var u = 0, v = 0;
    while (u === 0) u = r();
    v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ---- the board ----
  function segIndex(n) { return ORDER.indexOf(n); }
  // What a dart at (x, y) scores: { n: 0..20 or 25, m: 0..3 } (n = 0: off the board).
  function scoreAt(x, y) {
    var r = Math.sqrt(x * x + y * y);
    if (!(r <= R_D1)) return { n: 0, m: 0 };
    if (r <= R_DB) return { n: BULL, m: 2 };
    if (r <= R_SB) return { n: BULL, m: 1 };
    var deg = Math.atan2(x, y) * 180 / Math.PI;           // 0 at the top, clockwise
    var idx = Math.floor((((deg + 9) % 360) + 360) % 360 / 18) % 20;
    var m = r >= R_D0 ? 2 : (r >= R_T0 && r <= R_T1) ? 3 : 1;
    return { n: ORDER[idx], m: m };
  }
  function value(h) { return h.n * h.m; }
  function label(h) {
    if (!h || !h.n || !h.m) return 'MISS';
    if (h.n === BULL) return h.m === 2 ? 'BULL' : '25';
    return (h.m === 3 ? 'T' : h.m === 2 ? 'D' : '') + h.n;
  }
  // The middle of a bed: m = 1 aims the fat inner single, 1.5 the outer single.
  function aimPoint(n, m) {
    if (n === BULL) return { x: 0, y: 0 };
    var i = segIndex(n);
    if (i < 0) return { x: 0, y: 0 };
    var th = i * 18 * Math.PI / 180;
    var r = m === 3 ? (R_T0 + R_T1) / 2 : m === 2 ? (R_D0 + R_D1) / 2 : m === 1.5 ? (R_T1 + R_D0) / 2 : (R_SB + R_T0) / 2 + 0.03;
    return { x: r * Math.sin(th), y: r * Math.cos(th) };
  }

  // ---- the sway: your hand is never still ----
  // A smooth Lissajous drift (≈0.4 Hz) plus a tremor that grows as the arm tires.
  function sway(t, ph) {
    ph = ph || 0;
    return {
      x: 0.72 * Math.sin(1.9 * t + ph) + 0.28 * Math.sin(4.7 * t + 1.3 + ph * 2.1),
      y: 0.72 * Math.sin(1.37 * t + 0.6 + ph * 1.7) + 0.28 * Math.sin(3.9 * t + 2.2 + ph * 0.7)
    };
  }
  var HOLD_BEST = 0.9, HOLD_TIRE = 2.4, HOLD_MAX = 4.4;
  // Sway multiplier for a hold of h seconds (h < 0: not holding).
  function steadyAmp(h) {
    if (!(h >= 0)) return 1;
    if (h < HOLD_BEST) { var u = h / HOLD_BEST; return 1 - 0.64 * (1 - (1 - u) * (1 - u)); }
    if (h < HOLD_TIRE) return 0.36;
    return 0.36 + 1.2 * clamp((h - HOLD_TIRE) / (HOLD_MAX - HOLD_TIRE), 0, 1);
  }
  function tremor(h) { return h >= HOLD_TIRE ? clamp((h - HOLD_TIRE) / (HOLD_MAX - HOLD_TIRE), 0, 1) : 0; }
  // The reticle's offset from the aim point at time t, holding for h s, with hand base amplitude a0.
  function wobble(t, h, a0, ph) {
    var s = sway(t, ph), amp = a0 * steadyAmp(h), tr = tremor(h) * a0 * 0.25;
    return {
      x: amp * s.x + tr * Math.sin(23 * t + ph),
      y: amp * s.y + tr * Math.sin(19 * t + 1.1 + ph),
      amp: amp
    };
  }
  // A thrown dart: where it lands for an aim with scatter sigma.
  function scatter(x, y, sigma, r) { return { x: x + gauss(r) * sigma, y: y + gauss(r) * sigma }; }

  // ---- checkouts ----
  var ALL = [];
  (function () {
    for (var n = 1; n <= 20; n++) for (var m = 1; m <= 3; m++) ALL.push({ n: n, m: m, v: n * m });
    ALL.push({ n: BULL, m: 1, v: 25 }); ALL.push({ n: BULL, m: 2, v: 50 });
  })();
  var DPREF = [20, 16, 8, 18, 12, 10, 4, 14, 6, 2, 19, 17, 15, 13, 11, 9, 7, 5, 3, 1];   // favourite finishing doubles
  function finalPen(d) {
    if (d.n === BULL) return d.m === 2 ? 15 : 30;
    if (d.m !== 2) return 40 + (20 - d.n) * 0.1;
    var k = DPREF.indexOf(d.n); return k;
  }
  function setupPen(d) {
    if (d.n === BULL) return d.m === 2 ? 14 : 12;
    if (d.m === 3) return (20 - d.n) * 0.6;
    if (d.m === 2) return 10 + (20 - d.n) * 0.1;
    return 7 + (20 - d.n) * 0.1;
  }
  var CO_CACHE = {};
  function buildSetups() {
    // best1[v]: cheapest single dart scoring v; best2[v]: cheapest pair (higher first)
    var b1 = {}, b2 = {}, i, j;
    for (i = 0; i < ALL.length; i++) {
      var d = ALL[i], p = setupPen(d);
      if (!b1[d.v] || p < b1[d.v].p) b1[d.v] = { p: p, r: [d] };
    }
    for (i = 0; i < ALL.length; i++) {
      for (var v in b1) {
        var a = ALL[i], b = b1[v].r[0];
        var tot = a.v + b.v, pp = setupPen(a) + b1[v].p;
        var pair = a.v >= b.v ? [a, b] : [b, a];
        if (!b2[tot] || pp < b2[tot].p - 1e-9) b2[tot] = { p: pp, r: pair };
      }
    }
    return { b1: b1, b2: b2 };
  }
  var SETUPS = null;
  // The best route to finish `rem` in at most `darts` darts, as hits [{n,m}], or null.
  function checkout(rem, darts, doubleOut) {
    darts = darts == null ? 3 : darts;
    if (doubleOut === undefined) doubleOut = true;
    if (!(rem > 0) || rem > 180 || darts < 1) return null;
    var key = rem + ':' + darts + ':' + (doubleOut ? 1 : 0);
    if (key in CO_CACHE) return CO_CACHE[key] ? CO_CACHE[key].slice() : null;
    if (!SETUPS) SETUPS = buildSetups();
    var best = null, bestC = Infinity;
    for (var i = 0; i < ALL.length; i++) {
      var f = ALL[i];
      if (doubleOut && f.m !== 2) continue;
      if (f.v > rem) continue;
      var left = rem - f.v, fp = doubleOut ? finalPen(f) : setupPen(f) * 0.5, c, route;
      if (left === 0) { c = 1000 + fp; route = [f]; }
      else if (darts >= 2 && SETUPS.b1[left]) { c = 2000 + fp + SETUPS.b1[left].p; route = [SETUPS.b1[left].r[0], f]; }
      else if (darts >= 3 && SETUPS.b2[left]) { c = 3000 + fp + SETUPS.b2[left].p; route = [SETUPS.b2[left].r[0], SETUPS.b2[left].r[1], f]; }
      else continue;
      if (c < bestC) { bestC = c; best = route; }
    }
    CO_CACHE[key] = best ? best.map(function (d) { return { n: d.n, m: d.m }; }) : null;
    return CO_CACHE[key] ? CO_CACHE[key].slice() : null;
  }
  function routeLabel(r) { return r ? r.map(label).join(' ') : ''; }
  // Bust rule for x01: would `h` bust a player on `rem`?
  function busts(rem, h, doubleOut) {
    var after = rem - value(h);
    if (after < 0) return true;
    if (doubleOut && after === 1) return true;
    if (after === 0 && doubleOut && h.m !== 2) return true;
    return false;
  }

  // ---- matches ----
  function normOpts(o) {
    o = o && typeof o === 'object' ? o : {};
    var mode = MODES.indexOf(o.mode) >= 0 ? o.mode : 'x01';
    var start = [301, 501, 701].indexOf(+o.start) >= 0 ? +o.start : 501;
    var legs = clamp(Math.round(+o.legs) || 1, 1, 3);
    var ps = Array.isArray(o.players) ? o.players.slice(0, 4) : [];
    if (!ps.length) ps = [{ name: 'You', cpu: 0 }];
    if (mode === 'practice') ps = ps.slice(0, 1);
    ps = ps.map(function (p, i) {
      p = p && typeof p === 'object' ? p : {};
      var cpu = clamp(Math.round(+p.cpu) || 0, 0, CPU_LEVELS.length);
      if (i === 0) cpu = 0;
      return { name: String(p.name || (cpu ? 'CPU' : 'P' + (i + 1))).slice(0, 12), cpu: cpu };
    });
    return { mode: mode, start: start, doubleOut: o.doubleOut !== false, legs: mode === 'x01' ? legs : 1, players: ps };
  }
  function resetLeg(G, p) {
    p.score = G.o.start;
    p.marks = { 20: 0, 19: 0, 18: 0, 17: 0, 16: 0, 15: 0, 25: 0 };
    p.pts = 0;
    p.idx = 0;
    p.legDarts = 0;
  }
  function newGame(opts) {
    var o = normOpts(opts);
    var G = {
      v: 1, mode: o.mode, o: o, cur: 0, starter: 0, leg: 1, round: 1,
      turn: [], turnStart: 0, phase: 'aim', winner: -1, legWinner: -1, draw: false, last: null, nDarts: 0
    };
    G.players = o.players.map(function (p) {
      var q = { name: p.name, cpu: p.cpu, legs: 0, darts: 0, points: 0, markCount: 0, hiTurn: 0, n180: 0, n140: 0, n100: 0, hiOut: 0,
        bestLeg: 0, trebles: 0, doubles: 0, bulls: 0, hits: 0, turns: 0, best3: 0 };
      resetLeg(G, q);
      return q;
    });
    G.turnStart = G.players[0].score;
    return G;
  }
  function curP(G) { return G.players[G.cur]; }
  function turnTotal(G) { var s = 0; for (var i = 0; i < G.turn.length; i++) s += G.turn[i].v; return s; }
  function cricketOpen(G, n, except) {
    for (var i = 0; i < G.players.length; i++) if (i !== except && G.players[i].marks[n] < 3) return true;
    return false;
  }
  function cricketClosedAll(p) {
    for (var i = 0; i < CRICKET_NUMS.length; i++) if (p.marks[CRICKET_NUMS[i]] < 3) return false;
    return true;
  }
  function totalMarks(p) { var s = 0; for (var i = 0; i < CRICKET_NUMS.length; i++) s += Math.min(3, p.marks[CRICKET_NUMS[i]]); return s; }
  function atcTarget(p) { return ATC_SEQ[Math.min(p.idx, ATC_SEQ.length - 1)]; }

  // Throw one dart (a hit { n, m }) for the player to throw. Returns what happened.
  function throwDart(G, hit) {
    if (G.phase !== 'aim') return null;
    var p = curP(G), n = hit && hit.n | 0, m = hit && hit.m | 0;
    if (!(n === BULL ? (m === 1 || m === 2) : n >= 1 && n <= 20 && m >= 1 && m <= 3)) { n = 0; m = 0; }
    var h = { n: n, m: m, v: n * m, lbl: '' }, ev = { hit: h, bust: false, legWon: false, gameOver: false, turnOver: false, marks: 0, scored: 0, adv: 0, closed: false };
    h.lbl = label(h);
    G.turn.push(h);
    G.nDarts++;
    p.darts++; p.legDarts++;
    if (m === 3) p.trebles++;
    if (m === 2 && n !== BULL) p.doubles++;
    if (n === BULL) p.bulls++;
    if (n) p.hits++;
    if (G.mode === 'x01') {
      if (busts(p.score, h, G.o.doubleOut)) {
        ev.bust = true; h.bust = true;
        // the turn's points come back off: they never counted
        p.points -= turnTotal(G) - h.v;
        p.score = G.turnStart;
      } else {
        p.score -= h.v; p.points += h.v; ev.scored = h.v;
        if (p.score === 0) {
          ev.legWon = true; ev.checkout = G.turnStart;
          p.hiOut = Math.max(p.hiOut, G.turnStart);
        }
      }
    } else if (G.mode === 'cricket') {
      if (CRICKET_NUMS.indexOf(n) >= 0) {
        var had = p.marks[n], add = m, need = Math.max(0, 3 - had), close = Math.min(add, need), extra = add - close;
        p.marks[n] = had + close;
        ev.marks = close;
        if (close && p.marks[n] === 3) ev.closed = true;
        if (extra > 0 && cricketOpen(G, n, G.cur)) { p.pts += extra * n; ev.scored = extra * n; ev.marks += extra; }
        p.markCount = (p.markCount || 0) + ev.marks;
        h.mk = ev.marks;
      }
      if (cricketClosedAll(p)) {
        var lead = true;
        for (var i = 0; i < G.players.length; i++) if (i !== G.cur && G.players[i].pts > p.pts) lead = false;
        if (lead) ev.legWon = true;
      }
    } else if (G.mode === 'atc') {
      var tg = atcTarget(p);
      if (n && n === tg) {
        var step = tg === BULL ? 1 : m;
        var nxt = Math.min(p.idx + step, tg === BULL ? ATC_SEQ.length : ATC_SEQ.length - 1);
        ev.adv = nxt - p.idx; p.idx = nxt;
        if (p.idx >= ATC_SEQ.length) ev.legWon = true;
      }
    } else {
      p.points += h.v; ev.scored = h.v;
    }
    if (ev.legWon) {
      winLeg(G, G.cur, ev);
    } else if (ev.bust || G.turn.length >= 3) {
      endTurn(G, ev);
    }
    G.last = ev;
    return ev;
  }
  function turnStats(G, p, bust) {
    p.turns++;
    if (G.mode === 'x01' || G.mode === 'practice') {
      var t = bust ? 0 : turnTotal(G);
      if (t > p.hiTurn) p.hiTurn = t;
      if (t === 180) p.n180++;
      else if (t >= 140) p.n140++;
      else if (t >= 100) p.n100++;
      if (G.turn.length === 3 && t > p.best3) p.best3 = t;
    }
  }
  function endTurn(G, ev) {
    turnStats(G, curP(G), ev && ev.bust);
    ev.statsDone = true;
    ev.turnOver = true;
    G.phase = 'turnover';
    // cricket: the round cap, after the last thrower of the last round
    if (G.mode === 'cricket' && G.round >= CRICKET_ROUNDS && nextIdx(G) === G.starter) {
      var best = -1, bi = -1, tie = false;
      G.players.forEach(function (q, i) {
        var s = q.pts * 1000 + totalMarks(q);
        if (s > best) { best = s; bi = i; tie = false; } else if (s === best) tie = true;
      });
      if (tie) { G.draw = true; G.phase = 'over'; G.winner = -1; G.legWinner = -1; ev.gameOver = true; ev.draw = true; }
      else winLeg(G, bi, ev);
    }
  }
  function winLeg(G, i, ev) {
    var p = G.players[i];
    if (i === G.cur && !ev.statsDone) turnStats(G, p, false);
    ev.turnOver = true; ev.legWon = true; ev.winner = i;
    p.legs++;
    if (G.mode === 'x01' && (!p.bestLeg || p.legDarts < p.bestLeg)) p.bestLeg = p.legDarts;
    if (G.mode === 'atc' && (!p.bestLeg || p.legDarts < p.bestLeg)) p.bestLeg = p.legDarts;
    G.legWinner = i;
    if (p.legs >= G.o.legs) { G.phase = 'over'; G.winner = i; ev.gameOver = true; }
    else G.phase = 'legover';
  }
  function nextIdx(G) { return (G.cur + 1) % G.players.length; }
  function nextTurn(G) {
    if (G.phase !== 'turnover') return false;
    G.cur = nextIdx(G);
    if (G.cur === G.starter) G.round++;
    G.turn = [];
    G.turnStart = curP(G).score;
    G.phase = 'aim';
    return true;
  }
  function nextLeg(G) {
    if (G.phase !== 'legover') return false;
    G.leg++;
    G.starter = (G.starter + 1) % G.players.length;
    G.cur = G.starter; G.round = 1; G.turn = []; G.legWinner = -1;
    G.players.forEach(function (p) { resetLeg(G, p); });
    G.turnStart = curP(G).score;
    G.phase = 'aim';
    return true;
  }
  function avg3(p) { return p.darts ? p.points / p.darts * 3 : 0; }
  function mpr(p) { return p.darts ? (p.markCount || 0) / p.darts * 3 : 0; }

  // ---- the CPU: picks a sensible bed, then throws with its scatter ----
  function cpuTarget(G) {
    var p = curP(G), left = 3 - G.turn.length, lvl = CPU_LEVELS[(p.cpu || 2) - 1] || CPU_LEVELS[1];
    if (G.mode === 'x01') return x01Target(p.score, left, G.o.doubleOut, lvl);
    if (G.mode === 'cricket') return cricketTarget(G, G.cur, lvl);
    if (G.mode === 'atc') {
      var t = atcTarget(p);
      if (t === BULL) return { n: BULL, m: 1 };
      return { n: t, m: lvl.sigma <= 0.1 && t <= 18 ? 3 : 1 };
    }
    return { n: 20, m: 3 };
  }
  function x01Target(rem, left, dout, lvl) {
    var co = checkout(rem, left, dout);
    if (co) {
      // a long-shot bull finish is not for the weaker arms
      if (!(lvl.sigma > 0.1 && co[0].n === BULL && co.length > 1)) return { n: co[0].n, m: co[0].m };
    }
    if (!dout) {
      // any-out with no finish on: score big, but never past zero
      if (rem >= 60) return { n: 20, m: 3 };
      if (rem >= 3) return { n: Math.min(20, Math.floor(rem / 3)), m: 3 };
      return { n: rem, m: 1 };
    }
    if (rem > 170 || rem - 60 >= 42) return { n: 20, m: 3 };
    // set up a favourite double: the smallest-scoring single that leaves one
    var goals = [32, 40, 16, 36, 24, 20, 8, 12, 4, 2];
    for (var g = 0; g < goals.length; g++) {
      var need = rem - goals[g];
      if (need >= 1 && need <= 20) return { n: need, m: 1 };
      if (need === 25) return { n: BULL, m: 1 };
      if (need > 20 && need <= 60 && need % 3 === 0) return { n: need / 3, m: 3 };
    }
    if (rem > 40) return { n: 20, m: 1 };
    if (rem % 2 === 0) return { n: rem / 2, m: 2 };
    return { n: 1, m: 1 };
  }
  function cricketTarget(G, me, lvl) {
    var p = G.players[me], i, n;
    var maxOther = 0;
    for (i = 0; i < G.players.length; i++) if (i !== me) maxOther = Math.max(maxOther, G.players[i].pts);
    var behind = p.pts < maxOther || (p.pts === maxOther && G.players.length > 1 && lvl.sigma <= 0.1);
    if (behind) {
      for (i = 0; i < CRICKET_NUMS.length; i++) {
        n = CRICKET_NUMS[i];
        if (p.marks[n] >= 3 && cricketOpen(G, n, me) && n !== BULL) return { n: n, m: 3 };
      }
    }
    for (i = 0; i < CRICKET_NUMS.length; i++) {
      n = CRICKET_NUMS[i];
      if (p.marks[n] < 3) return n === BULL ? { n: BULL, m: lvl.sigma <= 0.1 ? 2 : 1 } : { n: n, m: 3 };
    }
    return { n: BULL, m: 1 };
  }
  function cpuSigma(level) { var l = CPU_LEVELS[(level || 2) - 1] || CPU_LEVELS[1]; return l.sigma; }
  // A whole CPU dart: target, the throw, the hit.
  function cpuDart(G, r) {
    var tg = cpuTarget(G), ap = aimPoint(tg.n, tg.m), sg = cpuSigma(curP(G).cpu);
    var at = scatter(ap.x, ap.y, sg, r);
    return { target: tg, aim: ap, x: at.x, y: at.y, hit: scoreAt(at.x, at.y) };
  }
  // Play a whole match of CPUs (tests / balance): returns the game.
  function simulate(opts, seed, maxDarts) {
    var G = newGame(opts), r = rng(seed || 1), k = 0;
    // seat 0 is always a person: let it throw like the CPU in seat 1 would
    var lvl0 = G.players[1] ? G.players[1].cpu || 2 : (opts && opts.level) || 2;
    while (G.phase !== 'over' && k < (maxDarts || 5000)) {
      if (G.phase === 'turnover') { nextTurn(G); continue; }
      if (G.phase === 'legover') { nextLeg(G); continue; }
      var p = curP(G), keep = p.cpu;
      if (!p.cpu) p.cpu = lvl0;
      var d = cpuDart(G, r);
      p.cpu = keep;
      throwDart(G, d.hit);
      k++;
    }
    return G;
  }

  // ---- save ----
  function newStats() {
    return {
      x01: { games: 0, wins: 0, darts: 0, points: 0, hiOut: 0, hiTurn: 0, n180: 0, bestLeg: 0, bestAvg: 0 },
      cricket: { games: 0, wins: 0, darts: 0, marks: 0, bestMpr: 0 },
      atc: { games: 0, wins: 0, bestDarts: 0 },
      practice: { darts: 0, points: 0, best3: 0, trebles: 0, doubles: 0, bulls: 0 },
      cpu: [0, 0, 0, 0], cpuGames: [0, 0, 0, 0]
    };
  }
  function newSave() {
    return {
      v: 1,
      setup: { mode: 'x01', start: 501, doubleOut: true, legs: 1, opp: 'cpu', level: 2, hand: 1 },
      stats: newStats(),
      match: null
    };
  }
  function num(v, d, lo, hi) { v = +v; if (!isFinite(v)) return d; if (lo != null && v < lo) return lo; if (hi != null && v > hi) return hi; return v; }
  var OPPS = ['solo', 'cpu', '2p', '3p', '4p'];
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    var su = o.setup && typeof o.setup === 'object' ? o.setup : {};
    s.setup.mode = MODES.indexOf(su.mode) >= 0 ? su.mode : 'x01';
    s.setup.start = [301, 501, 701].indexOf(+su.start) >= 0 ? +su.start : 501;
    s.setup.doubleOut = su.doubleOut !== false;
    s.setup.legs = Math.round(num(su.legs, 1, 1, 3));
    s.setup.opp = OPPS.indexOf(su.opp) >= 0 ? su.opp : 'cpu';
    s.setup.level = Math.round(num(su.level, 2, 1, 4));
    s.setup.hand = Math.round(num(su.hand, 1, 0, 2));
    var st = o.stats && typeof o.stats === 'object' ? o.stats : {};
    var d = s.stats;
    ['x01', 'cricket', 'atc', 'practice'].forEach(function (k) {
      var src = st[k] && typeof st[k] === 'object' ? st[k] : {};
      for (var f in d[k]) d[k][f] = num(src[f], 0, 0, 1e9);
    });
    ['cpu', 'cpuGames'].forEach(function (k) {
      var a = Array.isArray(st[k]) ? st[k] : [];
      for (var i = 0; i < 4; i++) d[k][i] = Math.round(num(a[i], 0, 0, 1e9));
    });
    s.match = normMatch(o.match);
    return s;
  }
  // A saved match in progress: kept only if it's whole and consistent.
  function normMatch(m) {
    try {
      if (!m || typeof m !== 'object' || m.v !== 1 || !Array.isArray(m.players) || !m.players.length) return null;
      var G = newGame(m.o);
      if (G.mode !== m.mode || G.players.length !== m.players.length) return null;
      if (['aim', 'turnover', 'legover'].indexOf(m.phase) < 0) return null;
      G.cur = Math.round(num(m.cur, 0, 0, G.players.length - 1));
      G.starter = Math.round(num(m.starter, 0, 0, G.players.length - 1));
      G.leg = Math.round(num(m.leg, 1, 1, 9));
      G.round = Math.round(num(m.round, 1, 1, 999));
      G.nDarts = Math.round(num(m.nDarts, 0, 0, 1e6));
      G.players.forEach(function (p, i) {
        var q = m.players[i] || {};
        ['legs', 'darts', 'points', 'hiTurn', 'n180', 'n140', 'n100', 'hiOut', 'bestLeg', 'trebles', 'doubles', 'bulls', 'hits', 'turns', 'best3', 'legDarts', 'pts', 'markCount'].forEach(function (k) {
          p[k] = Math.round(num(q[k], 0, 0, 1e7));
        });
        p.score = Math.round(num(q.score, G.o.start, G.o.doubleOut ? 2 : 1, G.o.start));
        if (G.mode !== 'x01') p.score = G.o.start;
        p.idx = Math.round(num(q.idx, 0, 0, ATC_SEQ.length - 1));
        var mk = q.marks && typeof q.marks === 'object' ? q.marks : {};
        CRICKET_NUMS.forEach(function (n) { p.marks[n] = Math.round(num(mk[n], 0, 0, 3)); });
      });
      // a half-thrown turn resumes where it stopped (its darts already count)
      if (m.phase === 'legover') { G.phase = 'legover'; G.legWinner = Math.round(num(m.legWinner, 0, 0, G.players.length - 1)); }
      else if (m.phase === 'turnover') { G.phase = 'turnover'; G.turn = []; }
      G.turnStart = G.players[G.cur].score;
      if (G.phase === 'aim' && Array.isArray(m.turn) && m.turn.length && m.turn.length < 3) {
        G.turn = m.turn.map(function (d) {
          d = d && typeof d === 'object' ? d : {};
          var n = d.n | 0, k = d.m | 0;
          if (!(n === BULL ? (k === 1 || k === 2) : n >= 1 && n <= 20 && k >= 1 && k <= 3)) { n = 0; k = 0; }
          var h = { n: n, m: k, v: n * k, lbl: '' };
          h.lbl = label(h);
          if (d.mk) h.mk = Math.round(num(d.mk, 0, 0, 9));
          return h;
        });
        if (G.mode === 'x01') G.turnStart = Math.round(num(m.turnStart, G.turnStart, G.turnStart, G.o.start));
      }
      return G;
    } catch (e) { return null; }
  }
  // Fold a finished match into player one's records. Returns the new-best flags.
  function settle(save, G) {
    var st = save.stats, p = G.players[0], best = {};
    if (!p || p.cpu) return best;
    var cpuOpp = 0;
    G.players.forEach(function (q) { if (q.cpu) cpuOpp = Math.max(cpuOpp, q.cpu); });
    var won = G.winner === 0 && G.players.length > 1;
    if (G.mode === 'x01') {
      var x = st.x01, a = avg3(p);
      x.games++; if (won) x.wins++;
      x.darts += p.darts; x.points += p.points; x.n180 += p.n180;
      if (p.hiOut > x.hiOut) { x.hiOut = p.hiOut; best.hiOut = 1; }
      if (p.hiTurn > x.hiTurn) { x.hiTurn = p.hiTurn; best.hiTurn = 1; }
      if (p.bestLeg && (!x.bestLeg || p.bestLeg < x.bestLeg)) { x.bestLeg = p.bestLeg; best.bestLeg = 1; }
      if (p.darts >= 9 && a > x.bestAvg) { x.bestAvg = Math.round(a * 100) / 100; best.bestAvg = 1; }
    } else if (G.mode === 'cricket') {
      var c = st.cricket, mp = mpr(p);
      c.games++; if (won) c.wins++;
      c.darts += p.darts; c.marks += p.markCount || 0;
      if (p.darts >= 9 && mp > c.bestMpr) { c.bestMpr = Math.round(mp * 100) / 100; best.bestMpr = 1; }
    } else if (G.mode === 'atc') {
      var t = st.atc;
      t.games++; if (won) t.wins++;
      if (G.winner === 0 || (G.players.length === 1 && p.idx >= ATC_SEQ.length)) {
        if (p.bestLeg && (!t.bestDarts || p.bestLeg < t.bestDarts)) { t.bestDarts = p.bestLeg; best.bestDarts = 1; }
      }
    } else {
      var pr = st.practice;
      pr.darts += p.darts; pr.points += p.points; pr.trebles += p.trebles; pr.doubles += p.doubles; pr.bulls += p.bulls;
      if (p.best3 > pr.best3) { pr.best3 = p.best3; best.best3 = 1; }
    }
    if (cpuOpp && G.mode !== 'practice') {
      st.cpuGames[cpuOpp - 1]++;
      if (won) st.cpu[cpuOpp - 1]++;
    }
    return best;
  }

  var ENGINE = {
    ORDER: ORDER, R_DB: R_DB, R_SB: R_SB, R_T0: R_T0, R_T1: R_T1, R_D0: R_D0, R_D1: R_D1, STEP: STEP, BULL: BULL,
    CRICKET_NUMS: CRICKET_NUMS, CRICKET_ROUNDS: CRICKET_ROUNDS, ATC_SEQ: ATC_SEQ, CPU_LEVELS: CPU_LEVELS, HANDS: HANDS, MODES: MODES, OPPS: OPPS,
    RELEASE_SIGMA: RELEASE_SIGMA, HOLD_BEST: HOLD_BEST, HOLD_TIRE: HOLD_TIRE,
    clamp: clamp, rng: rng, gauss: gauss, segIndex: segIndex, scoreAt: scoreAt, value: value, label: label, aimPoint: aimPoint,
    sway: sway, steadyAmp: steadyAmp, wobble: wobble, scatter: scatter,
    checkout: checkout, routeLabel: routeLabel, busts: busts,
    normOpts: normOpts, newGame: newGame, curP: curP, turnTotal: turnTotal, throwDart: throwDart, nextTurn: nextTurn, nextLeg: nextLeg,
    cricketOpen: cricketOpen, cricketClosedAll: cricketClosedAll, totalMarks: totalMarks, atcTarget: atcTarget, avg3: avg3, mpr: mpr,
    cpuTarget: cpuTarget, x01Target: x01Target, cricketTarget: cricketTarget, cpuSigma: cpuSigma, cpuDart: cpuDart, simulate: simulate,
    newSave: newSave, normSave: normSave, normMatch: normMatch, settle: settle
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('darts.css');

  var PANEL_ID = 'darts-panel', NAME = 'Darts';
  var KEY = 'cade-darts-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var VW = 340, VH = 364, CX = 170, CY = 184, BR = 126, CW = 8, RH = 12;
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.darts = { live: function () { return S; } };   // test-only peek

  // palette slots, filled from the theme
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_RED = 4, C_LEAF = 5, C_GOLD = 6, C_VIOLET = 7, C_ICE = 8, C_FLAME = 9, C_BG = 10, NPAL = 11;
  var P_SLOT = [C_ACC, C_FLAME, C_VIOLET, C_ICE];
  var P_CLASS = ['dt-c0', 'dt-c1', 'dt-c2', 'dt-c3'];

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function f1(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function f2(v) { return (Math.round(v * 100) / 100).toFixed(2); }

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
  Snd.prototype.arp = function (fs, step, type, vol) { var me = this; fs.forEach(function (f, j) { me.tone(f, step * 1.6, type || 'triangle', vol || 0.035, 0, j * step); }); };
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
    P[C_TEXT] = css(tx); P[C_MUTED] = css(mu); P[C_FAINT] = css(fa); P[C_ACC] = css(ac); P[C_BG] = css(bg);
    var red = dark ? [240, 106, 106] : [200, 52, 52], leaf = dark ? [126, 211, 122] : [40, 138, 58];
    P[C_RED] = css(red); P[C_LEAF] = css(leaf);
    P[C_GOLD] = dark ? '#f2c544' : '#b07d06'; P[C_VIOLET] = dark ? '#b79cf5' : '#7351c4';
    P[C_ICE] = dark ? '#7cc7f2' : '#2878b5'; P[C_FLAME] = dark ? '#ff8f3f' : '#e2611f';
    S.rgb = { bg: bg, tx: tx, ac: ac, red: red, leaf: leaf, mu: mu };
    S.col = { bg: css(bg), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace' };
    fitFont();
  }

  // ---- glyph rendering (a cached atlas, as in Dusk Dash) ----
  var AT_COLS = 24, AT_ROWS = 14;
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '600 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = CW / adv;
    S.fnt = '600 ' + S.fpx.toFixed(3) + 'px ' + f;
    buildAtlas();
    buildBoard();
  }
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.k || !S.col) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    a.sc = 3;
    a.cwp = Math.ceil((CW + 4) * S.k * a.sc); a.chp = Math.ceil((RH + 6) * S.k * a.sc);
    a.cv.width = a.cwp * AT_COLS; a.cv.height = a.chp * AT_ROWS;
    a.c = a.cv.getContext('2d');
    a.c.font = '700 ' + (S.fpx * S.k * a.sc).toFixed(3) + 'px ' + S.col.font;
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
    var w = sc ? a.cw * sc : a.cw, h = sc ? a.ch * sc : a.ch;
    c.drawImage(a.cv, (i % AT_COLS) * a.cwp, ((i / AT_COLS) | 0) * a.chp, a.cwp, a.chp, x - w / 2, y - h / 2, w, h);
  }
  function drawStr(c, ci, s, x, y, align, sc) {
    var n = s.length, cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, s.charCodeAt(i), x0 + i * cw + cw / 2, y, sc);
    return x0 + n * cw;
  }
  // a glyph string with a background-coloured halo, readable over the board
  function haloStr(c, ci, s, x, y, align, sc) {
    var d = 0.9 * (sc || 1);
    drawStr(c, C_BG, s, x - d, y, align, sc); drawStr(c, C_BG, s, x + d, y, align, sc);
    drawStr(c, C_BG, s, x, y - d, align, sc); drawStr(c, C_BG, s, x, y + d, align, sc);
    return drawStr(c, ci, s, x, y, align, sc);
  }

  // ---- the board, drawn once per theme / size into its own canvas ----
  function bx(x) { return CX + x * BR; }
  function by(y) { return CY - y * BR; }
  // an annular sector (board radii r0..r1, segment idx), as a canvas path
  function bedPath(c, r0, r1, idx) {
    var a0 = (idx * 18 - 9 - 90) * Math.PI / 180, a1 = (idx * 18 + 9 - 90) * Math.PI / 180;
    c.beginPath();
    c.arc(CX, CY, r1 * BR, a0, a1, false);
    c.arc(CX, CY, r0 * BR, a1, a0, true);
    c.closePath();
  }
  function hitPath(c, n, m) {
    if (n === BULL) { c.beginPath(); c.arc(CX, CY, (m === 2 ? R_DB : R_SB) * BR, 0, Math.PI * 2); return; }
    var i = segIndex(n);
    if (m === 3) bedPath(c, R_T0, R_T1, i);
    else if (m === 2) bedPath(c, R_D0, R_D1, i);
    else if (m === 1.5) bedPath(c, R_T1, R_D0, i);
    else bedPath(c, R_SB, R_T0, i);
  }
  function buildBoard() {
    if (!S.k || !S.col) return;
    var b = S.bcv || (S.bcv = document.createElement('canvas'));
    b.width = S.cv.width; b.height = S.cv.height;
    var c = b.getContext('2d'), R = S.rgb, dk = S.dark, i, j;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.clearRect(0, 0, VW, VH);
    // the surround: a dark rubber ring, with the numbers
    c.beginPath(); c.arc(CX, CY, BR * 1.22, 0, Math.PI * 2);
    c.fillStyle = css(mix(R.bg, R.tx, dk ? 0.1 : 0.08)); c.fill();
    c.lineWidth = 1; c.strokeStyle = css(mix(R.bg, R.tx, 0.22)); c.stroke();
    var cDark = css(mix(R.bg, R.tx, dk ? 0.2 : 0.3)), cLight = css(mix(R.bg, [236, 214, 170], dk ? 0.3 : 0.55));
    var cRed = css(mix(R.bg, R.red, dk ? 0.42 : 0.55)), cGreen = css(mix(R.bg, R.leaf, dk ? 0.42 : 0.5));
    for (i = 0; i < 20; i++) {
      var ev = i % 2 === 0;
      c.fillStyle = ev ? cDark : cLight;
      bedPath(c, R_SB, R_T0, i); c.fill();
      bedPath(c, R_T1, R_D0, i); c.fill();
      c.fillStyle = ev ? cRed : cGreen;
      bedPath(c, R_T0, R_T1, i); c.fill();
      bedPath(c, R_D0, R_D1, i); c.fill();
    }
    c.fillStyle = cGreen; c.beginPath(); c.arc(CX, CY, R_SB * BR, 0, Math.PI * 2); c.fill();
    c.fillStyle = cRed; c.beginPath(); c.arc(CX, CY, R_DB * BR, 0, Math.PI * 2); c.fill();
    // glyph texture: rows of characters on concentric rings, coloured per bed
    var gDark = css(mix(R.bg, R.tx, dk ? 0.42 : 0.56)), gLight = dk ? css(mix(R.bg, [236, 214, 170], 0.62)) : css(mix(R.bg, [150, 112, 50], 0.42));
    var gRed = dk ? css(mix(R.bg, R.red, 0.95)) : css(mix(R.red, [0, 0, 0], 0.08)), gGreen = dk ? css(mix(R.bg, R.leaf, 0.95)) : css(mix(R.leaf, [0, 0, 0], 0.1));
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = '700 ' + (S.fpx * 0.78).toFixed(2) + 'px ' + S.col.font;
    var bands = [[R_SB, R_T0, 0], [R_T0, R_T1, 1], [R_T1, R_D0, 0], [R_D0, R_D1, 1]];
    for (j = 0; j < bands.length; j++) {
      var r0 = bands[j][0] * BR, r1 = bands[j][1] * BR, ring = bands[j][2], rows = Math.max(1, Math.round((r1 - r0) / 7.2));
      for (var q = 0; q < rows; q++) {
        var rr = r0 + (r1 - r0) * (q + 0.5) / rows, per = Math.max(1, Math.round(rr * Math.PI / 10 / 6.4));
        for (i = 0; i < 20; i++) {
          var evn = i % 2 === 0;
          c.fillStyle = ring ? (evn ? gRed : gGreen) : (evn ? gDark : gLight);
          var ch = ring ? '=' : evn ? ':' : '.';
          for (var g = 0; g < per; g++) {
            var ang = (i * 18 - 9 + 18 * (g + 0.5) / per - 90) * Math.PI / 180, x = CX + Math.cos(ang) * rr, y = CY + Math.sin(ang) * rr;
            if (ring) {
              c.save(); c.translate(x, y); c.rotate(ang + Math.PI / 2); c.fillText(ch, 0, 0); c.restore();
            } else c.fillText(ch, x, y);
          }
        }
      }
    }
    c.fillStyle = gGreen; c.fillText('o', CX, CY - R_SB * BR * 0.62); c.fillText('o', CX, CY + R_SB * BR * 0.62);
    c.fillText('o', CX - R_SB * BR * 0.62, CY); c.fillText('o', CX + R_SB * BR * 0.62, CY);
    c.fillStyle = gRed; c.fillText('@', CX, CY + 0.5);
    // the wire: spokes and rings, thin
    c.strokeStyle = css(mix(R.bg, R.tx, dk ? 0.5 : 0.42)); c.lineWidth = 0.6;
    c.beginPath();
    for (i = 0; i < 20; i++) {
      var a = (i * 18 - 9 - 90) * Math.PI / 180;
      c.moveTo(CX + Math.cos(a) * R_SB * BR, CY + Math.sin(a) * R_SB * BR);
      c.lineTo(CX + Math.cos(a) * R_D1 * BR, CY + Math.sin(a) * R_D1 * BR);
    }
    c.stroke();
    [R_DB, R_SB, R_T0, R_T1, R_D0, R_D1].forEach(function (r) { c.beginPath(); c.arc(CX, CY, r * BR, 0, Math.PI * 2); c.stroke(); });
    // the numbers, upright, round the outside
    c.font = '700 ' + (S.fpx * 1.12).toFixed(2) + 'px ' + S.col.font;
    c.fillStyle = css(R.tx);
    for (i = 0; i < 20; i++) {
      var an = (i * 18 - 90) * Math.PI / 180;
      c.fillText(String(ORDER[i]), CX + Math.cos(an) * BR * 1.11, CY + Math.sin(an) * BR * 1.11 + 0.5);
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---- effects ----
  var NPART = 48, NPOP = 6;
  function makeFx() {
    S.parts = []; S.pops = [];
    for (var i = 0; i < NPART; i++) S.parts.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, code: 42, ci: 0 });
    for (i = 0; i < NPOP; i++) S.pops.push({ on: false, x: 0, y: 0, t: 0, s: '', ci: 0, sc: 1 });
  }
  function clearFx() { S.parts.forEach(function (p) { p.on = false; }); S.pops.forEach(function (p) { p.on = false; }); S.big = null; }
  function burst(x, y, n, sp, codes, ci) {
    if (S.rm) n = Math.ceil(n / 3);
    for (var k = 0, i = 0; i < NPART && k < n; i++) {
      var p = S.parts[i];
      if (p.on) continue;
      var a = Math.random() * Math.PI * 2, v = sp * (0.4 + Math.random() * 0.8);
      p.on = true; p.x = x; p.y = y; p.vx = Math.cos(a) * v; p.vy = Math.sin(a) * v - sp * 0.3; p.t = 0; p.life = 0.45 + Math.random() * 0.4;
      p.code = codes.charCodeAt((Math.random() * codes.length) | 0); p.ci = ci; k++;
    }
  }
  function popup(x, y, s, ci, sc) {
    var best = S.pops[0];
    for (var i = 0; i < NPOP; i++) { if (!S.pops[i].on) { best = S.pops[i]; break; } if (S.pops[i].t > best.t) best = S.pops[i]; }
    best.on = true; best.x = x; best.y = y; best.t = 0; best.s = s; best.ci = ci; best.sc = sc || 1;
  }
  function bigMsg(s, ci, dur) { S.big = { s: s, ci: ci, t: 0, dur: dur || 1.2 }; }
  function stepFx(dt) {
    for (var i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on) continue;
      p.t += dt; if (p.t >= p.life) { p.on = false; continue; }
      p.vy += 160 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (i = 0; i < NPOP; i++) { var q = S.pops[i]; if (q.on) { q.t += dt; if (q.t > 1.1) q.on = false; } }
    if (S.big) { S.big.t += dt; if (S.big.t > S.big.dur) S.big = null; }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt);
  }

  // ---- drawing a frame ----
  function draw(alpha) {
    if (!S || !S.ctx || !S.atl || !S.bcv) return;
    var c = S.ctx, G = S.G, i;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = S.col.bg; c.fillRect(0, 0, S.cv.width, S.cv.height);
    var ox = 0, oy = 0;
    if (S.shake > 0 && !S.rm) { ox = (Math.random() - 0.5) * S.shake * 14; oy = (Math.random() - 0.5) * S.shake * 14; }
    c.drawImage(S.bcv, Math.round(ox * S.k), Math.round(oy * S.k));
    c.setTransform(S.k, 0, 0, S.k, ox * S.k, oy * S.k);
    var playing = S.phase === 'play' && G;
    // the bed to go for: a suggested checkout / the clock's number, softly pulsing
    var hl = playing ? hintBed() : null;
    if (hl) {
      var pul = S.rm ? 0.3 : 0.22 + 0.14 * Math.sin(S.t * 5);
      c.fillStyle = css(S.rgb.ac, pul.toFixed(3)); hitPath(c, hl.n, hl.m); c.fill();
      c.strokeStyle = css(S.rgb.ac, 0.9); c.lineWidth = 1.4; c.stroke();
    }
    if (playing && G.mode === 'cricket') drawCricketMarks(c, G);
    // darts in the board this turn
    for (i = 0; i < S.stuck.length; i++) drawDart(c, S.stuck[i].x, S.stuck[i].y, S.stuck[i].ci, 1, i === S.stuck.length - 1 ? S.stuckT : 9);
    // the dart in flight: big and near, shrinking into the board
    if (S.sub === 'flight' && S.fl) {
      var fl = S.fl, u = clamp((fl.t - STEP * (1 - alpha)) / fl.dur, 0, 1), e = 1 - (1 - u) * (1 - u);
      var fx = bx(fl.x0 + (fl.x1 - fl.x0) * e), fy = by(fl.y0 + (fl.y1 - fl.y0) * e) - Math.sin(u * Math.PI) * 26;
      drawDart(c, (fx - CX) / BR, (CY - fy) / BR, fl.ci, 2.6 - 1.6 * e, 9);
    }
    // the reticle
    if (playing && (S.sub === 'aim' || S.sub === 'cpuAim')) drawReticle(c, alpha);
    // particles and pop-ups (canvas coordinates)
    for (i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on) continue;
      c.globalAlpha = Math.min(1, 2.5 * (1 - p.t / p.life));
      glyph(c, p.ci, p.code, p.x, p.y);
    }
    c.globalAlpha = 1;
    for (i = 0; i < NPOP; i++) {
      var q = S.pops[i];
      if (!q.on) continue;
      c.globalAlpha = Math.min(1, 3 * (1.1 - q.t));
      haloStr(c, q.ci, q.s, q.x, q.y - 12 - q.t * 22, 'center', q.sc);
    }
    c.globalAlpha = 1;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (playing) hud(c, G);
    if (S.big) {
      var b = S.big, fa = b.t < 0.12 ? b.t / 0.12 : clamp((b.dur - b.t) / 0.35, 0, 1), sc = 2.4 + (S.rm ? 0 : 0.8 * Math.max(0, 0.15 - b.t) / 0.15);
      c.globalAlpha = fa;
      var w = b.s.length * CW * sc + 24;
      c.fillStyle = css(S.rgb.bg, 0.86); c.fillRect(CX - w / 2, CY + BR * 0.42 - 22, w, 44);
      c.strokeStyle = S.pal[b.ci]; c.lineWidth = 1.5; c.strokeRect(CX - w / 2 + 0.5, CY + BR * 0.42 - 22 + 0.5, w - 1, 43);
      drawStr(c, b.ci, b.s, CX, CY + BR * 0.42, 'center', sc);
      c.globalAlpha = 1;
    }
  }
  // A stuck dart: the point a halo'd X in the thrower's colour, the flight a short tail.
  function drawDart(c, x, y, ci, sc, age) {
    var px = bx(x), py = by(y), s = sc || 1, wob = age < 0.25 && !S.rm ? Math.sin(age * 60) * (0.25 - age) * 10 : 0;
    c.strokeStyle = S.pal[C_BG]; c.lineWidth = 3.2 * s; c.lineCap = 'round';
    c.beginPath(); c.moveTo(px, py); c.lineTo(px + 7 * s + wob, py + 9 * s); c.stroke();
    c.strokeStyle = S.pal[ci]; c.lineWidth = 1.4 * s;
    c.beginPath(); c.moveTo(px, py); c.lineTo(px + 7 * s + wob, py + 9 * s); c.stroke();
    haloStr(c, ci, '>', px + 8.5 * s + wob, py + 11 * s, 'center', 0.8 * s);
    haloStr(c, ci, 'x', px, py, 'center', 1.05 * s);
  }
  function drawReticle(c, alpha) {
    var x = S.prx + (S.rx - S.prx) * alpha, y = S.pry + (S.ry - S.pry) * alpha;
    var px = bx(x), py = by(y), amp = Math.max(0.012, S.ramp) * BR, held = S.sub === 'aim' && S.hold.on, h = S.hold.t;
    var steady = held && h >= HOLD_BEST * 0.85 && h < HOLD_TIRE, tired = held && h >= HOLD_TIRE;
    var ci = steady ? C_LEAF : tired ? C_RED : S.sub === 'cpuAim' ? P_SLOT[S.G.cur % 4] : C_TEXT;
    // the base aim (where your arm points): a faint cross
    if (S.sub === 'aim') {
      var a = S.aims[S.G.cur];
      haloStr(c, C_FAINT, '+', bx(a.x), by(a.y), 'center', 0.9);
    }
    // the sway envelope: a ring of dots, tighter as you steady
    var n = 12;
    c.globalAlpha = 0.85;
    for (var i = 0; i < n; i++) {
      var an = i / n * Math.PI * 2 + S.t * 0.6;
      glyph(c, ci, 46, px + Math.cos(an) * (amp + 7), py + Math.sin(an) * (amp + 7), 1);
    }
    c.globalAlpha = 1;
    haloStr(c, ci, '-', px - 9, py, 'center', 0.9); haloStr(c, ci, '-', px + 9, py, 'center', 0.9);
    haloStr(c, ci, '|', px, py - 9, 'center', 0.8); haloStr(c, ci, '|', px, py + 9, 'center', 0.8);
    c.fillStyle = S.pal[C_BG]; c.fillRect(px - 2, py - 2, 4, 4);
    c.fillStyle = S.pal[ci]; c.fillRect(px - 1.2, py - 1.2, 2.4, 2.4);
  }
  // Cricket: the marks per number beside each, for the thrower.
  function drawCricketMarks(c, G) {
    var p = G.players[G.cur];
    for (var k = 0; k < CRICKET_NUMS.length - 1; k++) {
      var n = CRICKET_NUMS[k], i = segIndex(n), an = (i * 18 - 90) * Math.PI / 180, mk = p.marks[n];
      if (mk >= 3) {
        c.globalAlpha = 0.18; c.fillStyle = S.pal[C_BG];
        bedPath(c, R_SB, R_D1, i); c.fill();
        c.globalAlpha = 1;
      }
      var s = mk >= 3 ? (E_open(G, n) ? '(X)' : '---') : mk === 2 ? 'X' : mk === 1 ? '/' : '';
      if (s) haloStr(c, mk >= 3 ? C_LEAF : C_ACC, s, CX + Math.cos(an) * BR * 1.27, CY + Math.sin(an) * BR * 1.27, 'center', 0.85);
    }
  }
  function E_open(G, n) { return cricketOpen(G, n, G.cur); }
  // The bed worth showing: the next dart of a checkout, the clock's number.
  function hintBed() {
    var G = S.G, p = curP(G);
    if (G.phase !== 'aim' || (S.sub !== 'aim' && S.sub !== 'settle')) return null;
    if (p.cpu) return null;
    if (G.mode === 'x01') {
      var co = checkout(p.score, 3 - G.turn.length, G.o.doubleOut);
      return co ? co[0] : null;
    }
    if (G.mode === 'atc') { var t = atcTarget(p); return { n: t, m: t === BULL ? 1 : 1.5 }; }
    return null;
  }
  function hud(c, G) {
    var p = curP(G), ci = P_SLOT[G.cur % 4];
    // top left: who's throwing and the darts left
    var x = drawStr(c, ci, p.name.toUpperCase(), 6, 10, 'left', 1);
    x += 8;
    for (var i = 0; i < 3; i++) { glyph(c, i < G.turn.length ? C_FAINT : ci, i < G.turn.length ? 46 : 62, x + i * 10, 10, 1); }
    // top right: the steadiness meter (humans)
    if (!p.cpu && S.sub === 'aim') {
      var h = S.hold.on ? S.hold.t : -1, w = 10, a = steadyAmp(h), fill = Math.round(clamp((1 - a) / 0.8, 0, 1) * w);
      var tired = h >= HOLD_TIRE, good = h >= HOLD_BEST * 0.85 && !tired;
      var ex = drawStr(c, C_FAINT, 'STEADY ', VW - 6 - (w + 9) * CW, 10, 'left', 1);
      glyph(c, C_MUTED, 91, ex + CW / 2, 10);
      for (i = 0; i < w; i++) glyph(c, i < fill ? (tired ? C_RED : good ? C_LEAF : C_ACC) : C_FAINT, i < fill ? 35 : 46, ex + CW * (i + 1.5), 10);
      glyph(c, C_MUTED, 93, ex + CW * (w + 1.5), 10);
    } else if (p.cpu && S.cpu && S.cpu.target) {
      drawStr(c, C_MUTED, 'AIMING ' + label(S.cpu.target), VW - 6, 10, 'right', 1);
    }
    // bottom: a hint line
    var msg = S.hint;
    if (msg) drawStr(c, msg.ci, msg.s, CX, VH - 9, 'center', 1);
  }

  // ---- the loop: a fixed step with interpolation, only while a match is on screen ----
  function running() {
    return !!S && S.phase === 'play' && !S.paused && !S.cardKind && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel));
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
    S.acc += dt;
    var n = 0;
    while (S.acc >= STEP && n < 24) { tick(); S.acc -= STEP; n++; if (!running()) break; }
    if (n >= 24) S.acc = 0;
    stepFx(dt);
    draw(S.acc / STEP);
    if (running()) S.raf = requestAnimationFrame(frame);
  }
  // One fixed step of the turn: aiming, the CPU, the flight, the pauses between darts.
  function tick() {
    var G = S.G;
    S.t += STEP;
    S.stuckT += STEP;
    S.prx = S.rx; S.pry = S.ry;
    if (S.sub === 'aim') {
      var a = S.aims[G.cur], kx = 0, ky = 0;
      if (S.keys.ArrowLeft || S.keys.KeyA) kx -= 1;
      if (S.keys.ArrowRight || S.keys.KeyD) kx += 1;
      if (S.keys.ArrowUp || S.keys.KeyW) ky += 1;
      if (S.keys.ArrowDown || S.keys.KeyS) ky -= 1;
      kx += S.gp.ax; ky += S.gp.ay;
      if (kx || ky) {
        var sp = (S.keys.Shift ? 0.22 : 0.62) * STEP;
        a.x += kx * sp; a.y += ky * sp;
        clampAim(a);
      }
      if (S.hold.on) S.hold.t += STEP;
      var w = wobble(S.t, S.hold.on ? S.hold.t : -1, HANDS[S.save.setup.hand].amp, S.ph);
      S.rx = a.x + w.x; S.ry = a.y + w.y; S.ramp = w.amp;
    } else if (S.sub === 'cpuAim') {
      var cp = S.cpu, u = clamp(cp.t / cp.move, 0, 1), e = u * u * (3 - 2 * u), sg = cpuSigma(curP(G).cpu);
      cp.t += STEP;
      var sw = sway(S.t * 1.3, S.ph), amp = sg * 0.7 * (1 - 0.5 * u);
      S.rx = cp.fx + (cp.d.aim.x - cp.fx) * e + sw.x * amp;
      S.ry = cp.fy + (cp.d.aim.y - cp.fy) * e + sw.y * amp;
      S.ramp = amp;
      if (cp.t >= cp.move + cp.hold) launch(S.rx, S.ry, cp.d.x, cp.d.y);
    } else if (S.sub === 'flight') {
      S.fl.t += STEP;
      if (S.fl.t >= S.fl.dur) land();
    } else if (S.sub === 'settle') {
      S.wait -= STEP;
      if (S.wait <= 0) startDart();
    } else if (S.sub === 'wait') {
      S.wait -= STEP;
      if (S.wait <= 0) advance();
    }
  }
  function clampAim(a) {
    var r = Math.sqrt(a.x * a.x + a.y * a.y);
    if (r > 1.2) { a.x *= 1.2 / r; a.y *= 1.2 / r; }
  }

  // ---- the turn flow ----
  function startDart() {
    var G = S.G, p = curP(G);
    S.hold = { on: false, t: 0, src: '' };
    if (p.cpu) {
      var d = cpuDart(G, S.r);
      S.cpu = { d: d, target: d.target, t: 0, move: 0.55 + Math.random() * 0.2, hold: 0.25 + Math.random() * 0.25, fx: S.rx, fy: S.ry };
      S.sub = 'cpuAim';
      setHint('', 0);
    } else {
      S.cpu = null;
      S.sub = 'aim';
      setHint(S.coarse ? 'tap to aim · hold, then release to throw' : 'hold to steady · release to throw', C_FAINT);
    }
    renderScore(); syncPad();
  }
  function startTurn() {
    var G = S.G, p = curP(G);
    S.stuck = [];
    if (!S.aims[G.cur]) S.aims[G.cur] = aimPoint(20, 3);
    var a = S.aims[G.cur];
    S.rx = S.prx = a.x; S.ry = S.pry = a.y;
    S.ph = G.cur * 1.7 + Math.random() * 6;
    var humans = G.players.filter(function (q) { return !q.cpu; }).length;
    if (G.players.length > 1 && (humans > 1 || p.cpu)) {
      bigMsg(p.cpu ? p.name + ' UP' : (humans > 1 ? p.name.toUpperCase() + ' — THROW' : 'YOUR THROW'), P_SLOT[G.cur % 4], 1.1);
    }
    if (G.mode === 'x01' && !p.cpu) {
      var co = checkout(p.score, 3 - G.turn.length, G.o.doubleOut);
      if (co) popup(CX, VH - 30, 'OUT ' + routeLabel(co), C_ACC, 1);
    }
    startDart();
  }
  function launch(x0, y0, x1, y1) {
    var G = S.G;
    S.sub = 'flight';
    S.fl = { x0: x0, y0: y0 - 0.9, x1: x1, y1: y1, t: 0, dur: 0.24, ci: P_SLOT[G.cur % 4] };
    S.snd.tone(420, 0.16, 'sine', 0.022, 1100);
    S.hint = null;
    syncPad();
  }
  function throwNow() {
    if (!S || S.sub !== 'aim' || !S.hold.on) return;
    var x = S.rx, y = S.ry, sc = scatter(x, y, RELEASE_SIGMA, S.r);
    S.hold = { on: false, t: 0, src: '' };
    launch(x, y, sc.x, sc.y);
  }
  function land() {
    var G = S.G, fl = S.fl, p = curP(G), hit = scoreAt(fl.x1, fl.y1);
    S.stuck.push({ x: fl.x1, y: fl.y1, ci: fl.ci }); S.stuckT = 0;
    S.fl = null;
    var before = G.mode === 'x01' ? p.score : 0;
    var ev = throwDart(G, hit), px = bx(fl.x1), py = by(fl.y1);
    var snd = S.snd;
    // feedback
    if (!hit.n) {
      snd.tone(130, 0.14, 'sine', 0.045, 70);
      popup(px, py, 'MISS', C_FAINT);
      burst(px, py, 5, 40, ".,'", C_FAINT);
    } else {
      snd.tone(170, 0.06, 'triangle', 0.07, 80); snd.tone(1600, 0.02, 'square', 0.012);
      var lbl = label(hit), pc = hit.m === 3 ? C_RED : hit.m === 2 ? (hit.n === BULL ? C_RED : C_LEAF) : C_TEXT;
      if (G.mode === 'cricket' && ev.marks === 0) pc = C_FAINT;
      if (G.mode === 'atc' && !ev.adv) pc = C_FAINT;
      popup(px, py, lbl, pc, hit.m >= 2 ? 1.3 : 1.05);
      if (hit.m >= 2 || hit.n === BULL) {
        burst(px, py, hit.n === BULL ? 16 : 10, 70, "*+'.", pc);
        snd.tone(hit.m === 3 ? 1175 : 988, 0.12, 'triangle', 0.032, 0, 0.04);
        if (hit.n === BULL) { snd.tone(1480, 0.14, 'triangle', 0.03, 0, 0.11); S.shake = 0.12; }
        Cade.haptic && Cade.haptic(8);
      } else burst(px, py, 3, 30, ".'", C_MUTED);
    }
    // the mode's own news
    if (G.mode === 'x01') {
      if (ev.bust) {
        bigMsg('BUST', C_RED, 1.3);
        snd.tone(220, 0.3, 'sawtooth', 0.03, 110);
        S.shake = 0.2; Cade.haptic && Cade.haptic(30);
      } else if (ev.legWon) {
        bigMsg(G.phase === 'over' ? 'GAME SHOT' : 'LEG SHOT', C_LEAF, 1.6);
        popup(CX, CY + BR * 0.3, 'OUT ' + before, C_LEAF, 1.6);
      } else if (G.turn.length === 3 || ev.turnOver) {
        var tt = turnTotal(G);
        if (tt === 180) { bigMsg('ONE-EIGHTY!', C_GOLD, 2); snd.arp([523, 659, 784, 1047, 1319], 0.08, 'square', 0.03); burst(CX, CY, 30, 120, "*+'.", C_GOLD); S.shake = 0.25; }
        else if (tt >= 100) { bigMsg(tt + '!', C_GOLD, 1.3); snd.arp([659, 880, 1175], 0.07); }
        else bigMsg(String(tt), C_TEXT, 1);
      }
    } else if (G.mode === 'cricket') {
      if (ev.closed) { popup(CX, CY + BR * 0.35, hit.n === BULL ? 'BULL CLOSED' : hit.n + ' CLOSED', C_LEAF, 1.3); snd.arp([784, 1047], 0.07); }
      if (ev.scored) popup(px, py + 18, '+' + ev.scored, C_GOLD, 1.1);
      if (ev.turnOver && !ev.legWon && !ev.draw) {
        bigMsg(turnMarks(G) + ' MARK' + (turnMarks(G) === 1 ? '' : 'S'), turnMarks(G) >= 5 ? C_GOLD : C_TEXT, 1);
      }
      if (ev.legWon) bigMsg('GAME!', C_LEAF, 1.6);
      if (ev.draw) bigMsg('DRAW', C_MUTED, 1.6);
    } else if (G.mode === 'atc') {
      if (ev.adv > 1) popup(CX, CY + BR * 0.35, 'SKIP +' + ev.adv, C_GOLD, 1.3);
      if (ev.legWon) bigMsg(G.players.length > 1 ? p.name.toUpperCase() + ' WINS' : 'ROUND THE CLOCK!', C_LEAF, 1.8);
    } else {
      if (G.turn.length === 3 || ev.turnOver) {
        var t3 = turnTotal(G);
        bigMsg(t3 === 180 ? 'ONE-EIGHTY!' : String(t3), t3 >= 100 ? C_GOLD : C_TEXT, 1);
        if (t3 === 180) { snd.arp([523, 659, 784, 1047, 1319], 0.08, 'square', 0.03); burst(CX, CY, 30, 120, "*+'.", C_GOLD); }
      }
    }
    if (ev.legWon || ev.gameOver) {
      snd.arp([523, 659, 784, 1047], 0.09);
      burst(px, py, 24, 110, "*+'.", C_LEAF);
    }
    renderScore();
    if (G.phase === 'aim') { S.sub = 'settle'; S.wait = p.cpu ? 0.35 : 0.2; }
    else { S.sub = 'wait'; S.wait = G.phase === 'turnover' ? (p.cpu ? 1.3 : 1.5) : 1.7; setHint(G.phase === 'turnover' ? (S.coarse ? 'tap to continue' : 'space / click to continue') : '', C_FAINT); }
    syncPad();
  }
  // marks earned this turn (closing marks + scoring marks)
  function turnMarks(G) {
    var s = 0;
    for (var i = 0; i < G.turn.length; i++) {
      var h = G.turn[i];
      s += h.mk || 0;
    }
    return s;
  }
  // After a turn / leg / match: move on.
  function advance() {
    var G = S.G;
    if (G.phase === 'turnover') {
      nextTurn(G);
      saveMatch();
      startTurn();
    } else if (G.phase === 'legover') {
      saveMatch();
      S.sub = 'idle';
      stopLoop();
      showCard('leg');
      setPad('nextleg');
    } else if (G.phase === 'over') {
      endMatch();
    }
  }
  function skipWait() { if (S && S.sub === 'wait') { S.wait = 0; } }
  function setHint(s, ci) { S.hint = s ? { s: s, ci: ci } : null; }

  function saveMatch() {
    if (!S || !S.G) return;
    S.save.match = S.G.phase === 'over' || S.G.mode === 'practice' ? null : JSON.parse(JSON.stringify(S.G));
    persist();
  }

  // ---- the scoreboard (DOM, above the board) ----
  function renderScore() {
    if (!S) return;
    var G = S.G, h = '';
    if (!G || S.phase !== 'play') { S.sb.innerHTML = ''; S.sb.style.display = 'none'; return; }
    S.sb.style.display = '';
    var cur = G.cur;
    if (G.mode === 'x01' || G.mode === 'atc') {
      h += '<div class="dt-pls n' + G.players.length + '">';
      G.players.forEach(function (p, i) {
        var big = G.mode === 'x01' ? String(p.score) : (p.idx >= ATC_SEQ.length ? 'DONE' : atcTarget(p) === BULL ? 'BULL' : String(atcTarget(p)));
        var sub = G.mode === 'x01' ? 'avg ' + f1(avg3(p)) + (G.o.legs > 1 ? ' · legs ' + p.legs : '') : atcBar(p);
        h += '<div class="dt-pl ' + P_CLASS[i] + (i === cur ? ' on' : '') + '"><div class="dt-nm">' + (i === cur ? '&gt; ' : '') + esc(p.name) +
          (p.cpu ? ' <i>' + CPU_LEVELS[p.cpu - 1].name + '</i>' : '') + '</div><div class="dt-sc">' + esc(big) + '</div><div class="dt-su">' + sub + '</div></div>';
      });
      h += '</div>';
    } else if (G.mode === 'cricket') {
      h += '<table class="dt-cr"><thead><tr><th></th>' + CRICKET_NUMS.map(function (n) { return '<th>' + (n === BULL ? 'B' : n) + '</th>'; }).join('') + '<th>pts</th></tr></thead><tbody>';
      G.players.forEach(function (p, i) {
        h += '<tr class="' + P_CLASS[i] + (i === cur ? ' on' : '') + '"><td class="dt-nm">' + (i === cur ? '&gt;' : '') + esc(p.name) + '</td>' +
          CRICKET_NUMS.map(function (n) {
            var m = p.marks[n], open = cricketOpen(G, n, i);
            return '<td class="mk' + (m >= 3 ? (open ? ' cl' : ' dead') : '') + '">' + (m >= 3 ? '(X)' : m === 2 ? 'X' : m === 1 ? '/' : '·') + '</td>';
          }).join('') + '<td class="pt">' + p.pts + '</td></tr>';
      });
      h += '</tbody></table>';
    } else {
      var p0 = G.players[0];
      h += '<div class="dt-pr"><span>darts <b>' + p0.darts + '</b></span><span>3-dart avg <b>' + f1(avg3(p0)) + '</b></span><span>best <b>' + p0.best3 +
        '</b></span><span>T<b>' + p0.trebles + '</b> D<b>' + p0.doubles + '</b> B<b>' + p0.bulls + '</b></span></div>';
    }
    // this turn's darts, and the way out
    var p = curP(G), tl = '';
    for (var i = 0; i < 3; i++) {
      var d = G.turn[i];
      tl += '<span class="dt-d' + (d ? (d.bust ? ' bust' : '') : ' e') + '">' + (d ? esc(d.lbl) : '-') + '</span>';
    }
    var extra = '';
    if (G.mode === 'x01') {
      var bust = G.turn.length && G.turn[G.turn.length - 1].bust;
      extra = bust ? '<span class="dt-bust">BUST</span>' : '<span class="dt-tt">= ' + turnTotal(G) + '</span>';
      var co = G.phase === 'aim' ? checkout(p.score, 3 - G.turn.length, G.o.doubleOut) : null;
      if (co) extra += '<span class="dt-out">out <b>' + esc(routeLabel(co)) + '</b></span>';
      else if (G.phase === 'aim' && p.score <= 170 && G.o.doubleOut && !p.cpu) extra += '<span class="dt-out dim">no out</span>';
    } else if (G.mode === 'cricket') {
      extra = '<span class="dt-tt">round ' + Math.min(G.round, CRICKET_ROUNDS) + '/' + CRICKET_ROUNDS + '</span>';
    } else if (G.mode === 'atc') {
      extra = '<span class="dt-tt">round ' + G.round + '</span>';
    } else extra = '<span class="dt-tt">= ' + turnTotal(G) + '</span>';
    h += '<div class="dt-turn">' + tl + extra + '</div>';
    S.sb.innerHTML = h;
  }
  function atcBar(p) {
    var s = '';
    for (var i = 0; i < ATC_SEQ.length; i++) s += i < p.idx ? '#' : '.';
    return '<span class="dt-bar">' + s + '</span>';
  }

  // ---- cards ----
  var ART = [
    '    .-\'\'\'\'\'-.',
    '  .\'  .---.  \'.',
    ' /   / .-. \\   \\ ',
    '|   | ( @ )<=======--',
    ' \\   \\ \'-\' /   /',
    '  \'.  \'---\'  .\'',
    '    \'-.....-\''
  ].join('\n');
  var MODE_NAMES = { x01: 'x01', cricket: 'Cricket', atc: 'Around the Clock', practice: 'Practice' };
  function chip(grp, val, lab, on, title) {
    return '<button type="button" class="dt-chip' + (on ? ' on' : '') + '" data-set="' + grp + '" data-v="' + esc(String(val)) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' +
      (title ? ' title="' + esc(title) + '"' : '') + '>' + lab + '</button>';
  }
  function matchName(o) {
    var m = o.mode === 'x01' ? String(o.start) : MODE_NAMES[o.mode];
    return m;
  }
  function homeHtml() {
    var sv = S.save, su = sv.setup, h = '';
    h += '<div class="dt-card dt-home">';
    h += '<pre class="dt-art" aria-hidden="true">' + esc(ART) + '</pre>';
    h += '<div class="dt-title">DARTS</div>';
    h += '<div class="dt-tabs" role="tablist">' + ['play', 'stats'].map(function (tb) {
      return '<button type="button" role="tab" data-tab="' + tb + '" aria-selected="' + (S.tab === tb) + '" class="' + (S.tab === tb ? 'on' : '') + '">' + (tb === 'play' ? 'Play' : 'Stats') + '</button>';
    }).join('') + '</div>';
    if (S.tab === 'play') {
      if (sv.match) {
        var m = sv.match;
        h += '<div class="dt-resume"><div><b>Match in progress</b> — ' + esc(matchName(m.o)) + ': ' +
          m.players.map(function (p) { return esc(p.name) + ' ' + (m.mode === 'x01' ? p.score : m.mode === 'cricket' ? p.pts + 'pts' : (ATC_SEQ[Math.min(p.idx, 20)] === BULL ? 'B' : ATC_SEQ[Math.min(p.idx, 20)])); }).join(' · ') +
          '</div><div class="dt-btns"><button type="button" class="dt-go" data-act="resume-match">Resume</button><button type="button" class="dt-go alt" data-act="drop-match">Discard</button></div></div>';
      }
      h += sec('Game', chip('mode', 'x01', '301 / 501', su.mode === 'x01') + chip('mode', 'cricket', 'Cricket', su.mode === 'cricket') +
        chip('mode', 'atc', 'Clock', su.mode === 'atc', 'Around the Clock') + chip('mode', 'practice', 'Practice', su.mode === 'practice'));
      if (su.mode === 'x01') {
        h += '<div class="dt-row">' + sec('Start', [301, 501, 701].map(function (v) { return chip('start', v, String(v), su.start === v); }).join('')) +
          sec('Finish', chip('dout', 1, 'Double', su.doubleOut, 'Finish on a double (or the bull)') + chip('dout', 0, 'Any', !su.doubleOut)) + '</div>';
        h += sec('Legs (first to)', [1, 2, 3].map(function (v) { return chip('legs', v, String(v), su.legs === v); }).join(''));
      }
      if (su.mode !== 'practice') {
        h += sec('Players', chip('opp', 'solo', 'Solo', su.opp === 'solo') + chip('opp', 'cpu', 'vs CPU', su.opp === 'cpu') +
          chip('opp', '2p', '2P', su.opp === '2p', 'Pass and play') + chip('opp', '3p', '3P', su.opp === '3p') + chip('opp', '4p', '4P', su.opp === '4p'));
        if (su.opp === 'cpu') h += sec('CPU', CPU_LEVELS.map(function (l, i) { return chip('level', i + 1, l.name, su.level === i + 1); }).join(''));
      }
      h += sec('Your hand', HANDS.map(function (hd, i) { return chip('hand', i, hd.name, su.hand === i, 'How much your aim sways'); }).join(''));
      h += '<div class="dt-note">' + esc(setupNote(su)) + '</div>';
    } else {
      h += statsHtml();
    }
    return h + '</div>';
  }
  function sec(t, body) { return '<div class="dt-sec"><div class="dt-h">' + esc(t) + '</div><div class="dt-chips">' + body + '</div></div>'; }
  function setupNote(su) {
    var st = S.save.stats;
    if (su.mode !== 'practice' && su.opp === 'cpu') {
      var g = st.cpuGames[su.level - 1], w = st.cpu[su.level - 1];
      return g ? 'vs ' + CPU_LEVELS[su.level - 1].name + ' CPU: ' + w + ' won of ' + g : 'The CPU aims like a player: checkouts, setups, tactics';
    }
    if (su.mode === 'x01') return st.x01.games ? 'Your 3-dart average: ' + f1(st.x01.darts ? st.x01.points / st.x01.darts * 3 : 0) : 'Get to exactly zero' + (su.doubleOut ? ', finishing on a double' : '');
    if (su.mode === 'cricket') return 'Close 15–20 and the bull; score on what you own';
    if (su.mode === 'atc') return '1 to 20, then the bull — doubles and trebles skip ahead';
    return 'Throw freely — every dart counts towards your stats';
  }
  function statsHtml() {
    var st = S.save.stats, x = st.x01, c = st.cricket, a = st.atc, p = st.practice, rows = [];
    function line(l, v) { return esc(l) + new Array(Math.max(1, 28 - l.length - String(v).length) + 1).join(' ') + '<b>' + esc(String(v)) + '</b>'; }
    rows.push('<span class="g">x01</span>');
    rows.push(line('Games / won', x.games + ' / ' + x.wins));
    rows.push(line('3-dart average', x.darts ? f2(x.points / x.darts * 3) : '-'));
    rows.push(line('Best match average', x.bestAvg ? f2(x.bestAvg) : '-'));
    rows.push(line('Highest checkout', x.hiOut || '-'));
    rows.push(line('Highest turn', x.hiTurn || '-'));
    rows.push(line('180s', x.n180));
    rows.push(line('Fewest darts (leg)', x.bestLeg || '-'));
    rows.push('<span class="g">Cricket</span>');
    rows.push(line('Games / won', c.games + ' / ' + c.wins));
    rows.push(line('Marks per round', c.darts ? f2(c.marks / c.darts * 3) : '-'));
    rows.push(line('Best MPR (match)', c.bestMpr ? f2(c.bestMpr) : '-'));
    rows.push('<span class="g">Around the Clock</span>');
    rows.push(line('Games / won', a.games + ' / ' + a.wins));
    rows.push(line('Fewest darts', a.bestDarts || '-'));
    rows.push('<span class="g">Practice</span>');
    rows.push(line('Darts', p.darts));
    rows.push(line('3-dart average', p.darts ? f2(p.points / p.darts * 3) : '-'));
    rows.push(line('Best 3 darts', p.best3 || '-'));
    rows.push(line('Trebles / doubles / bulls', p.trebles + '/' + p.doubles + '/' + p.bulls));
    rows.push('<span class="g">vs CPU (won / played)</span>');
    CPU_LEVELS.forEach(function (l, i) { rows.push(line(l.name, st.cpu[i] + ' / ' + st.cpuGames[i])); });
    return '<pre class="dt-tab">' + rows.join('\n') + '</pre>' +
      '<div class="dt-foot">' + (S.resetArm ?
        '<span class="dt-confirm">Erase all stats?</span><span><button type="button" class="dt-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="dt-lnk" data-act="reset-no">Keep</button></span>' :
        '<span></span><button type="button" class="dt-lnk" data-act="reset">Reset stats</button>') + '</div>';
  }
  function helpHtml() {
    var keys = S.coarse ?
      '<div><b>tap</b> &nbsp;the board to place your aim</div><div><b>press &amp; hold</b> &nbsp;(board or big button) to steady, drag to fine-tune</div><div><b>release</b> &nbsp;to throw</div>' :
      '<div><b>mouse</b> &nbsp;point to aim · hold the button to steady · release to throw</div><div><b>arrows / WASD</b> &nbsp;aim (Shift: fine) · <b>hold Space</b> steady · release throws</div><div><b>gamepad</b> &nbsp;stick aims · hold A</div><div><b>P / Esc</b> &nbsp;pause</div>';
    return '<div class="dt-card dt-help"><div class="dt-title">HOW TO THROW</div>' +
      '<p>Your hand sways: the reticle drifts around where you aim (the faint <b>+</b>). <b>Hold</b> to steady your breath — the ring of dots tightens and the meter goes <b class="dt-c-leaf">green</b>. Hold too long and the arm tires and shakes (<b class="dt-c-red">red</b>). <b>Release</b> to throw.</p>' +
      '<div class="dt-keys">' + keys + '</div>' +
      '<p><b>301 / 501 / 701</b> — score down to exactly 0. With <b>double out</b> the last dart must hit a double (outer ring) or the bull. Going below 0, to 1, or to 0 without a double is a <b>bust</b>: the turn scores nothing. The board lights up a <b>checkout</b> route when one is on.</p>' +
      '<p><b>Cricket</b> — hit 15–20 and the bull. Three marks close a number (double = 2, treble = 3). Hits on your closed number score its points while anyone else still has it open. Close everything with at least as many points as everyone else to win (20 rounds max).</p>' +
      '<p><b>Around the Clock</b> — 1, 2, 3 … 20, then the bull. Doubles skip 2 ahead, trebles 3.</p>' +
      '<p><b>Practice</b> — free throwing with a live 3-dart average.</p>' +
      '<p class="dt-tip">The CPU aims at sensible beds with a scatter that shrinks with its level. In 2–4 player games, pass the device round between turns.</p>' +
      '<button type="button" class="dt-go" data-act="close-help">Back</button></div>';
  }
  function pauseHtml() {
    return '<div class="dt-card"><div class="dt-title">PAUSED</div><div class="dt-sub">' + esc(matchName(S.G.o)) + (S.G.mode === 'cricket' ? ' · round ' + S.G.round : '') + '</div>' +
      '<div class="dt-btns"><button type="button" class="dt-go" data-act="resume">Resume</button><button type="button" class="dt-go alt" data-act="quit">' + (S.G.mode === 'practice' ? 'End session' : 'Leave match') + '</button></div>' +
      '<div class="dt-note">' + (S.G.mode === 'practice' ? 'Ending the session keeps its stats' : 'A match left here can be resumed from the menu') + '</div></div>';
  }
  function legHtml() {
    var G = S.G, w = G.players[G.legWinner];
    return '<div class="dt-card"><div class="dt-title">LEG ' + (G.leg) + '</div><div class="dt-big ' + P_CLASS[G.legWinner] + '">' + esc(w.name) + '</div>' +
      '<div class="dt-sub">' + G.players.map(function (p) { return esc(p.name) + ' ' + p.legs; }).join(' · ') + ' &nbsp;(first to ' + G.o.legs + ')</div>' +
      '<div class="dt-note">checkout ' + w.hiOut + ' · leg in ' + w.legDarts + ' darts</div></div>';
  }
  function resultsHtml() {
    var G = S.G, R = S.res, h = '<div class="dt-card dt-res">';
    var solo = G.players.length === 1;
    if (G.mode === 'practice') h += '<div class="dt-title">SESSION</div><div class="dt-big">' + f2(avg3(G.players[0])) + '</div><div class="dt-sub">3-dart average</div>';
    else if (G.draw) h += '<div class="dt-title">DRAW</div><div class="dt-big">all square</div>';
    else if (solo) h += '<div class="dt-title">' + (G.mode === 'atc' ? 'ROUND THE CLOCK' : 'GAME SHOT') + '</div><div class="dt-big">' + G.players[0].darts + (G.players[0].darts === 1 ? ' dart' : ' darts') + '</div>';
    else h += '<div class="dt-title">GAME SHOT</div><div class="dt-big ' + P_CLASS[G.winner] + '">' + esc(G.players[G.winner].name) + (G.players[G.winner].name === 'You' ? ' win!' : ' wins') + '</div>';
    var cols = G.players.map(function (p) { return p.name; });
    var rows = [];
    function rowOf(l, f) { rows.push([l].concat(G.players.map(f))); }
    if (G.mode === 'x01' || G.mode === 'practice') {
      if (G.o.legs > 1) rowOf('Legs', function (p) { return p.legs; });
      rowOf('3-dart avg', function (p) { return f1(avg3(p)); });
      rowOf('Darts', function (p) { return p.darts; });
      rowOf('Best turn', function (p) { return p.hiTurn; });
      if (G.mode === 'x01') rowOf('Checkout', function (p) { return p.hiOut || '-'; });
      rowOf('100+/140+', function (p) { return (p.n100 + p.n140 + p.n180) + '/' + (p.n140 + p.n180); });
      rowOf('180s', function (p) { return p.n180; });
      if (G.mode === 'practice') rowOf('T / D / B', function (p) { return p.trebles + '/' + p.doubles + '/' + p.bulls; });
    } else if (G.mode === 'cricket') {
      rowOf('Points', function (p) { return p.pts; });
      rowOf('Marks/round', function (p) { return f2(mpr(p)); });
      rowOf('Darts', function (p) { return p.darts; });
    } else {
      rowOf('Reached', function (p) { return p.idx >= ATC_SEQ.length ? 'done' : (atcTarget(p) === BULL ? 'bull' : atcTarget(p)); });
      rowOf('Darts', function (p) { return p.darts; });
      rowOf('Trebles', function (p) { return p.trebles; });
    }
    var cw = [12].concat(cols.map(function (c) { return Math.max(6, c.length + 1); }));
    function pad(s, n, left) { s = String(s); while (s.length < n) s = left ? ' ' + s : s + ' '; return s; }
    var tab = '<i>' + pad('', cw[0]) + cols.map(function (c, i) { return pad(c, cw[i + 1], true); }).join('') + '</i>\n' +
      rows.map(function (r) { return pad(r[0], cw[0]) + r.slice(1).map(function (v, i) { return '<b>' + esc(pad(v, cw[i + 1], true)) + '</b>'; }).join(''); }).join('\n');
    h += '<pre class="dt-tab">' + tab + '</pre>';
    var nb = Object.keys(R.best || {}).map(function (k) { return { hiOut: 'checkout', hiTurn: 'turn', bestLeg: 'leg', bestAvg: 'average', bestMpr: 'MPR', bestDarts: 'darts', best3: '3 darts' }[k]; });
    if (nb.length) h += '<div class="dt-new">** new best ' + esc(nb.join(', ')) + ' **</div>';
    return h + '</div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'home' ? homeHtml() : kind === 'help' ? helpHtml() : kind === 'results' ? resultsHtml() : kind === 'pause' ? pauseHtml() : kind === 'leg' ? legHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind && kind !== 'home');
    S.stage.classList.toggle('home', kind === 'home');
    if (kind) S.ovl.scrollTop = 0;
  }

  // ---- the pad under the board ----
  function setPad(mode) {
    S.padMode = mode;
    var h, k = S.coarse ? '' : ' <small>space</small>';
    if (mode === 'play') {
      h = '<button type="button" class="dt-hold" data-k="hold" aria-label="Hold to steady, release to throw">Hold <span>· release to throw</span></button>';
      if (S.G && S.G.mode === 'practice') h += '<button type="button" class="dt-act alt" data-act="end-practice">End</button>';
    } else {
      var lab = { go: 'Throw!', again: 'Rematch', resume: 'Resume', nextleg: 'Next leg', back: 'Back' }[mode] || 'Back';
      h = '<button type="button" class="dt-act" data-act="' + mode + '">' + lab + k + '</button>' +
        (mode === 'again' ? '<button type="button" class="dt-act alt" data-act="home">Menu</button>' : '');
    }
    S.pad.innerHTML = h;
    syncPad();
  }
  function syncPad() {
    if (!S || S.padMode !== 'play') return;
    var b = S.pad.querySelector('[data-k]');
    if (!b) return;
    var G = S.G, cpu = G && curP(G).cpu, wait = S.sub === 'wait';
    b.classList.toggle('on', !!S.hold.on);
    b.classList.toggle('wait', !!(cpu && !wait));
    b.innerHTML = wait ? 'Next <span>· ' + (S.coarse ? 'tap' : 'click') + ' to continue</span>' : cpu && S.sub !== 'wait' ? esc(curP(G).name) + ' <span>throwing…</span>' : S.hold.on ? 'Steady… <span>release to throw</span>' : 'Hold <span>· release to throw</span>';
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

  // ---- phases ----
  function toHome() {
    stopLoop();
    S.phase = 'home'; S.paused = false; S.resetArm = false; S.G = null; S.sub = 'idle'; S.stuck = [];
    clearInput(); clearFx(); S.hint = null;
    renderScore();
    showCard('home'); setPad('go'); syncHead();
    layout(); draw(1);
  }
  function playersFor(su) {
    if (su.mode === 'practice' || su.opp === 'solo') return [{ name: 'You', cpu: 0 }];
    if (su.opp === 'cpu') return [{ name: 'You', cpu: 0 }, { name: 'CPU', cpu: su.level }];
    var n = { '2p': 2, '3p': 3, '4p': 4 }[su.opp] || 2, ps = [];
    for (var i = 0; i < n; i++) ps.push({ name: 'P' + (i + 1), cpu: 0 });
    return ps;
  }
  function startMatch(G) {
    S.snd.ensure();
    S.G = G || newGame({ mode: S.save.setup.mode, start: S.save.setup.start, doubleOut: S.save.setup.doubleOut, legs: S.save.setup.legs, players: playersFor(S.save.setup) });
    S.aims = [];
    S.phase = 'play'; S.paused = false; S.stuck = []; S.res = null;
    clearInput(); clearFx();
    showCard(null); setPad('play'); syncHead();
    if (S.G.phase === 'turnover') { nextTurn(S.G); }
    renderScore();
    layout();
    if (S.G.phase === 'legover') { S.sub = 'idle'; renderScore(); showCard('leg'); setPad('nextleg'); draw(1); return; }
    saveMatch();
    renderScore();
    startTurn();
    kick();
  }
  function nextLegNow() {
    if (!S || !S.G || S.G.phase !== 'legover') return;
    nextLeg(S.G);
    saveMatch();
    showCard(null); setPad('play');
    S.stuck = [];
    renderScore();
    startTurn();
    kick();
  }
  function endMatch() {
    stopLoop();
    var G = S.G;
    if (G.phase !== 'over') { G.phase = 'over'; }
    S.res = { best: settle(S.save, G) };
    S.save.match = null;
    persist();
    S.phase = 'over'; S.sub = 'idle'; S.hint = null;
    clearInput();
    renderScore();
    showCard('results'); setPad('again'); syncHead();
    if (S.liveEl) S.liveEl.textContent = G.draw ? 'Draw.' : G.winner >= 0 ? G.players[G.winner].name + ' wins.' : 'Session over.';
    if (G.winner === 0 || G.mode === 'practice') S.snd.arp([659, 784, 988, 1319], 0.08);
    draw(1);
  }
  function quitMatch() {
    if (!S || !S.G) return;
    if (S.G.mode === 'practice') { S.paused = false; endMatch(); return; }
    saveMatch();
    toHome();
  }
  function padAction(act) {
    if (!S) return;
    S.snd.ensure();
    act = act || S.padMode;
    if (act === 'go') startMatch();
    else if (act === 'again') startMatch(newGame(S.G ? S.G.o : null));
    else if (act === 'resume') resume();
    else if (act === 'nextleg') nextLegNow();
    else if (act === 'end-practice') { if (S.G && S.G.mode === 'practice') endMatch(); }
    else if (act === 'back' && S.cardKind === 'help') closeHelp();
    else if (act === 'home' || act === 'back') toHome();
  }
  // Back from the help card to wherever it was opened from.
  function closeHelp() {
    if (!S) return;
    var b = S.helpBack || { card: S.phase === 'play' ? 'pause' : S.phase === 'over' ? 'results' : 'home', pad: S.phase === 'play' ? 'resume' : S.phase === 'over' ? 'again' : 'go' };
    S.helpBack = null;
    if (S.phase === 'play' && S.paused) b = { card: 'pause', pad: 'resume' };
    showCard(b.card); setPad(b.pad);
  }
  function pause() {
    if (!S || S.phase !== 'play' || S.paused || S.cardKind) return;
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

  // ---- input ----
  var KEY2CODE = { ' ': 'Space', arrowdown: 'ArrowDown', arrowup: 'ArrowUp', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', p: 'KeyP', h: 'KeyH', enter: 'Enter', escape: 'Escape', w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD' };
  var MOVE_KEYS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1 };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  function clearInput() {
    if (!S) return;
    S.keys = {}; S.ptrs = {};
    if (S.hold) S.hold = { on: false, t: 0, src: '' };
    S.gp.ax = 0; S.gp.ay = 0; S.gp.hold = false;
    syncPad();
  }
  function humanAiming() { return S && S.phase === 'play' && !S.paused && !S.cardKind && S.G && S.sub === 'aim' && !curP(S.G).cpu; }
  function startHold(src) {
    if (!humanAiming() || S.hold.on) return;
    S.hold = { on: true, t: 0, src: src };
    S.snd.tone(300, 0.05, 'sine', 0.015);
    syncPad();
  }
  function release(src) {
    if (!S || !S.hold.on || S.hold.src !== src) return;
    throwNow();
    syncPad();
  }
  function cancelHold() { if (S && S.hold.on) { S.hold = { on: false, t: 0, src: '' }; syncPad(); } }
  // Gamepad: stick / d-pad aims, A holds, Start pauses; between matches A presses the big button.
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
    if (!p) { gp.ax = gp.ay = 0; if (gp.hold) { gp.hold = false; release('pad-gp'); } return; }
    var ax = p.axes[0] || 0, ay = p.axes[1] || 0;
    gp.ax = Math.abs(ax) > 0.18 ? ax : 0; gp.ay = Math.abs(ay) > 0.18 ? -ay : 0;
    if (btnOn(p, 14)) gp.ax = -1; if (btnOn(p, 15)) gp.ax = 1; if (btnOn(p, 12)) gp.ay = 1; if (btnOn(p, 13)) gp.ay = -1;
    var a = btnOn(p, 0) || btnOn(p, 7);
    if (a && !gp.hold) { gp.hold = true; if (S.sub === 'wait') skipWait(); else startHold('pad-gp'); }
    else if (!a && gp.hold) { gp.hold = false; release('pad-gp'); }
    var st = btnOn(p, 9);
    if (st && !gp.start && S.phase === 'play' && !S.paused) pause();
    gp.start = st;
  }
  function pollMenus() {
    if (!S || running()) return;
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
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (t && t.isContentEditable && !S.panel.contains(t)) return;
    var code = keyCode(e);
    S.keys.Shift = e.shiftKey;
    if (code === 'Escape') {
      e.preventDefault();
      if (S.phase === 'play' && !S.paused && !S.cardKind) pause();
      else if (S.cardKind === 'help') padAction('back');
      else closePanel();
      return;
    }
    if (S.phase === 'play' && !S.cardKind) {
      if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) pause(); return; }
      if (MOVE_KEYS[code]) { e.preventDefault(); S.keys[code] = true; return; }
      if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
        e.preventDefault();
        if (e.repeat) return;
        if (S.sub === 'wait') skipWait(); else startHold('key');
      }
      return;
    }
    if (S.paused && (code === 'KeyP' || code === 'Space' || code === 'Enter')) { e.preventDefault(); if (!e.repeat) resume(); return; }
    // between matches Space / Enter does the big button's job — unless a button in the panel has focus
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      if (!S.panel.contains(t) && t !== document.body && t && t.isContentEditable) return;
      e.preventDefault();
      if (!e.repeat) padAction();
    }
  }
  function onKeyUp(e) {
    if (!S) return;
    var code = keyCode(e);
    S.keys.Shift = e.shiftKey;
    if (S.keys[code]) delete S.keys[code];
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') release('key');
  }
  // canvas point → board coordinates
  function toBoard(e) {
    var r = S.cv.getBoundingClientRect();
    var lx = (e.clientX - r.left) / (r.width || 1) * VW, ly = (e.clientY - r.top) / (r.height || 1) * VH;
    return { x: (lx - CX) / BR, y: -(ly - CY) / BR, s: (r.width || VW) / VW };
  }

  // ---- layout ----
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height) return vh - (vw <= 560 ? 260 : 280);
    var chrome = r.height - (S.stage.offsetHeight || 0);
    if (S.panel.classList.contains('cade-solo-panel')) {
      var hd = S.panel.querySelector('.cade-panel-head');
      chrome = (hd ? hd.offsetHeight : 40) + (S.pad.offsetHeight || 56) + (S.sb.offsetHeight || 0) + 44;
    }
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 10;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var s = Math.min((vw - (phone ? 34 : 48)) / VW, phone ? 1.3 : solo ? 2.2 : 1.35), ah = availH(vw, vh);
    if (ah / VH < s) s = Math.max(phone ? 0.7 : 0.8, ah / VH);
    var cw = Math.floor(VW * s), ch = Math.floor(VH * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--dt-w', Math.max(cw, phone ? 0 : 340) + 'px');
    var nw = Math.round(cw * dpr), nh = Math.round(ch * dpr);
    var changed = nw !== S.cv.width || nh !== S.cv.height;
    S.cv.width = nw; S.cv.height = nh;
    S.k = S.cv.width / VW;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    if (S.col && (changed || !S.bcv)) fitFont();
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
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    if (s.atl) freeCanvas(s.atl.cv);
    freeCanvas(s.bcv);
    freeCanvas(s.cv);
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    if (S && S.G && S.phase === 'play') saveMatch();
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
    var body = '<div class="dt"><div class="dt-sb" style="display:none"></div><div class="dt-stage"><canvas class="dt-cv"></canvas><div class="dt-ovl" style="display:none"></div></div>' +
      '<div class="dt-pad"></div><div class="dt-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🎯 Darts', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'dt-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, sb: p.querySelector('.dt-sb'), stage: p.querySelector('.dt-stage'), cv: p.querySelector('.dt-cv'), ovl: p.querySelector('.dt-ovl'),
      pad: p.querySelector('.dt-pad'), liveEl: p.querySelector('.dt-live'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'home', G: null, sub: 'idle', paused: false, raf: 0, last: 0, acc: 0, t: 0,
      keys: {}, ptrs: {}, gp: { ax: 0, ay: 0, hold: false, start: false, menuA: false }, gpT: 0,
      hold: { on: false, t: 0, src: '' }, aims: [], rx: 0, ry: 0.6, prx: 0, pry: 0.6, ramp: 0.1, ph: 0,
      stuck: [], stuckT: 9, fl: null, cpu: null, wait: 0, hint: null, shake: 0, big: null,
      r: rng((Math.random() * 4294967295) >>> 0),
      pal: new Array(NPAL), col: null, atl: null, bcv: null, k: 1, tab: 'play', resetArm: false, padMode: '', cardKind: null
    };
    makeFx();
    S.ctx = S.cv.getContext('2d');
    p._onClose = function () { if (S && S.G && S.phase === 'play') saveMatch(); teardown(); };
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
        if (S.cardKind === 'help') closeHelp();
        else if (S.phase === 'play' && !S.cardKind) { pause(); if (S.paused) { S.helpBack = { card: 'pause', pad: 'resume' }; showCard('help'); setPad('resume'); } }
        else { S.helpBack = { card: S.cardKind || 'home', pad: S.padMode || 'go' }; showCard('help'); setPad('back'); }
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

    // the board: mouse points to aim; touch taps to place the aim and holds (with a relative drag) to throw
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (S.phase !== 'play' || S.paused || S.cardKind) return;
      if (S.sub === 'wait') { skipWait(); return; }
      if (!humanAiming() || S.hold.on) return;
      try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
      var b = toBoard(e), a = S.aims[S.G.cur];
      S.ptrs[e.pointerId] = { type: e.pointerType, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, t: performance.now(), moved: false, sc: b.s };
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') { a.x = b.x; a.y = b.y; clampAim(a); }
      startHold('ptr' + e.pointerId);
    });
    S.cv.addEventListener('pointermove', function (e) {
      if (!S || !humanAiming()) return;
      var a = S.aims[S.G.cur], pt = S.ptrs[e.pointerId];
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
        var b = toBoard(e); a.x = b.x; a.y = b.y; clampAim(a);
        return;
      }
      if (!pt) return;
      var dx = e.clientX - pt.lx, dy = e.clientY - pt.ly;
      pt.lx = e.clientX; pt.ly = e.clientY;
      if (Math.abs(e.clientX - pt.x) + Math.abs(e.clientY - pt.y) > 10) pt.moved = true;
      if (pt.moved) { a.x += dx / (BR * pt.sc); a.y -= dy / (BR * pt.sc); clampAim(a); }
    });
    function ptrUp(e) {
      if (!S) return;
      var pt = S.ptrs[e.pointerId];
      if (!pt) return;
      delete S.ptrs[e.pointerId];
      if (e.type !== 'pointerup') { if (S.hold.src === 'ptr' + e.pointerId) cancelHold(); return; }
      // touch: a quick tap places the aim instead of throwing
      if (pt.type === 'touch' && !pt.moved && performance.now() - pt.t < 220 && humanAiming()) {
        var b = toBoard(e), a = S.aims[S.G.cur];
        a.x = b.x; a.y = b.y; clampAim(a);
        cancelHold();
        S.snd.tone(660, 0.03, 'sine', 0.015);
        return;
      }
      release('ptr' + e.pointerId);
    }
    ['pointerup', 'pointercancel'].forEach(function (t) { S.cv.addEventListener(t, ptrUp); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // the pad's big hold button
    S.pad.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-k]') : null;
      if (!b || !S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (S.sub === 'wait') { skipWait(); return; }
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      startHold('padb');
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) {
      S.pad.addEventListener(t, function (e) {
        if (!S || S.hold.src !== 'padb') return;
        if (e.type === 'pointerup') release('padb'); else cancelHold();
      });
    });
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
      var set = b.getAttribute('data-set'), tab = b.getAttribute('data-tab'), act = b.getAttribute('data-act');
      if (set) {
        var su = S.save.setup, v = b.getAttribute('data-v');
        if (set === 'mode') su.mode = v;
        else if (set === 'start') su.start = +v;
        else if (set === 'dout') su.doubleOut = v === '1';
        else if (set === 'legs') su.legs = +v;
        else if (set === 'opp') su.opp = v;
        else if (set === 'level') su.level = +v;
        else if (set === 'hand') su.hand = +v;
        S.save = normSave(S.save);
        persist();
        S.snd.tone(988, 0.04, 'sine', 0.025);
        var st = S.ovl.scrollTop;
        showCard('home');
        S.ovl.scrollTop = st;
        var nb = e.detail === 0 && S.ovl.querySelector('[data-set="' + set + '"][data-v="' + v + '"]');
        if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
      } else if (tab) {
        S.tab = tab; S.resetArm = false; showCard('home');
      } else if (act === 'reset') { S.resetArm = true; showCard('home'); }
      else if (act === 'reset-no') { S.resetArm = false; showCard('home'); }
      else if (act === 'reset-yes') {
        S.save.stats = newSave().stats; S.resetArm = false; persist();
        Cade.showToast && Cade.showToast('Stats reset', 'info', 1600);
        showCard('home');
      } else if (act === 'resume-match') {
        var G = normMatch(S.save.match);
        if (G) startMatch(G); else { S.save.match = null; persist(); showCard('home'); }
      } else if (act === 'drop-match') { S.save.match = null; persist(); showCard('home'); }
      else if (act === 'close-help') closeHelp();
      else if (act === 'resume') resume();
      else if (act === 'quit') quitMatch();
    });

    toHome();
    if (S.firstRun) { persist(); showCard('help'); setPad('back'); }
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); redraw(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('600 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); redraw(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: '501 and Cricket with a wobbling aim — vs CPU or pass-and-play',
    icon: '🎯',
    tags: 'game,sport,fun,darts,501,301,cricket,around the clock,practice,2 player,cpu,pub,board,ascii',
    open: open,
    _engine: ENGINE
  });
})();
