/* Bubble Burst — an original bubble shooter for Cade.txt.
 * A hex-offset grid of glossy bubbles hangs from a ceiling. Aim the launcher
 * (drag and let go, mouse + click, or arrow keys + Space), bank shots off the
 * side walls, and land next to bubbles of the same color: 3 or more connected
 * pop, and anything no longer hanging from the ceiling falls for a big bonus.
 * Two modes: Stages (generative, seeded layouts — patterns, symmetric shapes,
 * rising color counts and hazards — with stars and a stage select) and
 * Endless (rows push in from the top, faster and faster; chase the high
 * score). Powerups: Bomb, Rainbow, Fireball, Sight, Freeze, Paint. Hazards:
 * stone bubbles (never match, only fall) and ice / locked bubbles (1 or 2
 * hits or neighboring pops to thaw). The full aiming guideline is only shown
 * on stage 1, with an active Sight, or with the Assist setting (half score).
 * Every color also carries a glyph (toggle) for color-blind play.
 * Engine (top) is pure — no DOM — and unit-checked in node (bubbles.test.js).
 * Settings, progress, records and a run in progress persist in Cade.store
 * (cade-bubbles-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM) =================
  // World units: bubble radius R = 1, the field is W x H, y grows downward.
  var VERSION = 1;
  var COLS = 11, R = 1, ROWH = Math.sqrt(3), W = COLS * 2, H = 28, DEAD_ROWS = 13;
  var CEIL0 = 0.6, LX = W / 2, LY = 25.3, NX = 6.2, NY = 26.2;
  var DEAD_Y = CEIL0 + R + (DEAD_ROWS - 0.5) * ROWH;
  var STEP = 1 / 120, SPEED = 42, HIT = 1.72, MIN_ANG = 0.12, BOMB_R = 4.1, FIRE_MAX = 14;
  var NCOL = 7, MAX_INV = 3, SIGHT_SHOTS = 8, FREEZE_SHOTS = 5, ASSIST_MUL = 0.5, STUB_LEN = 6.2;
  var PWS = ['bomb', 'rainbow', 'fire', 'sight', 'freeze', 'paint'];
  var PW_W = { bomb: 3, rainbow: 3, fire: 2, sight: 3, freeze: 2, paint: 3 };
  var DIFFS = [
    { id: 'easy', name: 'Easy', sc: 3, ec: 4, miss: 7, push: 9, mul: 0.8 },
    { id: 'normal', name: 'Normal', sc: 4, ec: 5, miss: 5, push: 7, mul: 1 },
    { id: 'hard', name: 'Hard', sc: 5, ec: 6, miss: 4, push: 5, mul: 1.5 }
  ];
  var PI = Math.PI;

  // seeded RNG (mulberry32) — the state lives on the object so a saved run replays the same ammo
  function rnd(o) {
    var t = o.rs = (o.rs + 0x6D2B79F5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function ri(o, n) { return Math.floor(rnd(o) * n); }
  function hash(n) {
    n = (n ^ 0x9e3779b9) | 0;
    n = Math.imul(n ^ (n >>> 16), 0x85ebca6b);
    n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
    return (n ^ (n >>> 16)) | 0;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function pickPw(o) {
    var tot = 0, k;
    for (k in PW_W) tot += PW_W[k];
    var x = rnd(o) * tot;
    for (var i = 0; i < PWS.length; i++) { x -= PW_W[PWS[i]]; if (x < 0) return PWS[i]; }
    return 'bomb';
  }

  // ---- the hex grid: odd rows (by parity) sit half a bubble to the right, one cell shorter ----
  function rowOff(g, r) { return (r + g.par) & 1; }
  function rowLen(g, r) { return COLS - rowOff(g, r); }
  function cellX(g, r, c) { return R + 2 * c + rowOff(g, r); }
  function cellY(g, r) { return CEIL0 + R + (r + g.drop) * ROWH; }
  function ceilOf(g) { return CEIL0 + g.drop * ROWH; }
  function inGrid(g, r, c) { return r >= 0 && c >= 0 && c < rowLen(g, r); }
  function at(g, r, c) { var row = g.grid[r]; return row && c >= 0 && c < row.length ? row[c] : null; }
  function blankRow(g, r) { var a = [], n = rowLen(g, r); for (var i = 0; i < n; i++) a.push(null); return a; }
  function put(g, r, c, b) { while (g.grid.length <= r) g.grid.push(blankRow(g, g.grid.length)); g.grid[r][c] = b; }
  function nbrs(g, r, c) {
    var o = rowOff(g, r), a = o ? c : c - 1, b = o ? c + 1 : c;
    var L = [[r, c - 1], [r, c + 1], [r - 1, a], [r - 1, b], [r + 1, a], [r + 1, b]], out = [];
    for (var i = 0; i < 6; i++) if (inGrid(g, L[i][0], L[i][1])) out.push(L[i]);
    return out;
  }
  function each(g, fn) {
    for (var r = 0; r < g.grid.length; r++) { var row = g.grid[r]; for (var c = 0; c < row.length; c++) if (row[c]) fn(row[c], r, c); }
  }
  function count(g, pred) { var n = 0; each(g, function (b) { if (!pred || pred(b)) n++; }); return n; }
  function trimRows(g) {
    while (g.grid.length) {
      var row = g.grid[g.grid.length - 1], any = false;
      for (var i = 0; i < row.length; i++) if (row[i]) { any = true; break; }
      if (any) break;
      g.grid.pop();
    }
  }
  function lowest(g) {
    for (var r = g.grid.length - 1; r >= 0; r--) { var row = g.grid[r]; for (var c = 0; c < row.length; c++) if (row[c]) return r; }
    return -1;
  }
  function key(r, c) { return r * 64 + c; }
  // same-color group from (r, c): only plain bubbles ('n') match — stones and ice never do
  function flood(g, r, c, col) {
    var b0 = at(g, r, c);
    if (!b0 || b0.t !== 'n' || b0.c !== col) return [];
    var seen = {}, out = [], q = [[r, c]];
    seen[key(r, c)] = 1;
    while (q.length) {
      var p = q.pop();
      out.push(p);
      var nb = nbrs(g, p[0], p[1]);
      for (var i = 0; i < nb.length; i++) {
        var k = key(nb[i][0], nb[i][1]), b = at(g, nb[i][0], nb[i][1]);
        if (seen[k] || !b || b.t !== 'n' || b.c !== col) continue;
        seen[k] = 1; q.push(nb[i]);
      }
    }
    return out;
  }
  // every bubble still hanging from the ceiling (row 0), as a key set
  function attached(g) {
    var seen = {}, q = [], row0 = g.grid[0] || [];
    for (var c = 0; c < row0.length; c++) if (row0[c]) { seen[key(0, c)] = 1; q.push([0, c]); }
    while (q.length) {
      var p = q.pop(), nb = nbrs(g, p[0], p[1]);
      for (var i = 0; i < nb.length; i++) {
        var k = key(nb[i][0], nb[i][1]);
        if (seen[k] || !at(g, nb[i][0], nb[i][1])) continue;
        seen[k] = 1; q.push(nb[i]);
      }
    }
    return seen;
  }
  function presentColors(g, withIce) {
    var seen = {}, out = [];
    each(g, function (b) { if ((b.t === 'n' || (withIce && b.t === 'i')) && b.c >= 0 && !seen[b.c]) { seen[b.c] = 1; out.push(b.c); } });
    out.sort(function (a, b) { return a - b; });
    return out;
  }
  // the empty cell a shot at (x, y) snaps into: it must hang from the ceiling or touch a bubble
  function canHold(g, r, c) {
    if (!inGrid(g, r, c) || at(g, r, c)) return false;
    if (r === 0) return true;
    var nb = nbrs(g, r, c);
    for (var i = 0; i < nb.length; i++) if (at(g, nb[i][0], nb[i][1])) return true;
    return false;
  }
  function nearestCell(g, x, y) {
    var rf = (y - CEIL0 - R) / ROWH - g.drop, r0 = Math.floor(rf) - 1, best = null, bd = 1e9, r, c;
    function tryCell(r, c) {
      if (!canHold(g, r, c)) return;
      var dx = cellX(g, r, c) - x, dy = cellY(g, r) - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = { r: r, c: c }; }
    }
    for (r = Math.max(0, r0); r <= r0 + 3; r++) {
      var cc = Math.round((x - R - rowOff(g, r)) / 2);
      for (c = cc - 1; c <= cc + 1; c++) tryCell(r, c);
    }
    if (!best) for (r = 0; r <= g.grid.length; r++) for (c = 0; c < rowLen(g, r); c++) tryCell(r, c);
    return best;
  }
  function hitAt(g, x, y) {
    var r0 = Math.max(0, Math.floor((y - CEIL0 - R - HIT) / ROWH - g.drop)), r1 = Math.min(g.grid.length - 1, Math.ceil((y - CEIL0 - R + HIT) / ROWH - g.drop));
    for (var r = r0; r <= r1; r++) {
      var row = g.grid[r], cy = cellY(g, r);
      for (var c = 0; c < row.length; c++) {
        if (!row[c]) continue;
        var dx = cellX(g, r, c) - x, dy = cy - y;
        if (dx * dx + dy * dy < HIT * HIT) return [r, c];
      }
    }
    return null;
  }
  function clampAng(a) {
    if (!(a === a)) a = -PI / 2;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    if (a > 0) a = a > PI / 2 ? -PI + MIN_ANG : -MIN_ANG;
    return clamp(a, -PI + MIN_ANG, -MIN_ANG);
  }
  function comboMul(s) { return s <= 1 ? 1 : 1 + Math.min(s - 1, 8) * 0.25; }
  function starsFor(shots, par) { return shots <= par ? 3 : shots <= Math.ceil(par * 1.4) ? 2 : 1; }
  function emit(g, e) { g.ev.push(e); }

  // ---- stages: seeded, generative layouts ----
  var PATS = ['full', 'pyramid', 'vee', 'diamond', 'pillars', 'mirror', 'waves', 'arch', 'hourglass', 'checker'];
  function stageInfo(n, diff) {
    var d = DIFFS[clamp(diff | 0, 0, 2)];
    n = Math.max(1, n | 0);
    return {
      rows: Math.min(9, 4 + Math.floor(n / 2)),
      colors: n === 1 ? 3 : Math.min(NCOL, d.sc + Math.floor((n - 1) / 5)),
      miss: n === 1 ? d.miss + 2 : Math.max(2, d.miss - Math.floor((n - 1) / 6)),
      same: n === 1 ? 0.8 : Math.max(0.26, 0.6 - n * 0.014),
      stones: n < 4 ? 0 : Math.min(9, Math.floor((n - 2) / 2)),
      ice: n < 6 ? 0 : Math.min(8, n - 5),
      locks: n < 9 ? 0 : Math.min(6, Math.floor((n - 7) / 2)),
      pws: n === 1 ? 1 : 1 + (n % 3 === 0 ? 1 : 0) + (n > 12 ? 1 : 0)
    };
  }
  function shapeOn(pat, r, x, rows, o, mm, ph) {
    var xn = (x - LX) / (LX - R), rn = rows > 1 ? r / (rows - 1) : 0, ax = Math.abs(xn), band = Math.floor((Math.abs(x - LX) + 1) / 3);
    if (r === 0 && pat !== 'pillars' && pat !== 'checker') return true;
    switch (pat) {
      case 'pyramid': return ax <= 1.05 - rn * 0.72;
      case 'vee': return ax >= rn * 0.9 - 0.22;
      case 'diamond': return ax < 0.12 || ax + Math.abs(rn - 0.55) * 1.4 <= 0.92;
      case 'pillars': return r < 2 || band % 2 === 0;
      case 'mirror':
        var mk = r + ':' + Math.round(Math.abs(x - LX));
        if (!(mk in mm)) mm[mk] = rnd(o) < 0.95 - rn * 0.5;
        return mm[mk];
      case 'waves': return rn <= 0.55 + 0.45 * Math.sin(ax * 3.2 + ph);
      case 'arch': return !(rn > 0.4 && ax < 0.5 - (rn - 0.4) * 0.25);
      case 'hourglass': return ax <= 0.3 + Math.abs(rn - 0.5) * 1.4;
      case 'checker': return r < 2 || ((r >> 1) + band) % 2 === 0;
      default: return true;
    }
  }
  function genStage(n, diff, forcePat) {
    n = Math.max(1, n | 0);
    var I = stageInfo(n, diff), o = { rs: hash(n * 7919 + 101) }, oc = { rs: hash(n * 97 + (diff | 0) * 1013 + 3) };
    var pat = forcePat || (n === 1 ? 'full' : PATS[ri(o, PATS.length)]);
    var g = { grid: [], par: 0, drop: 0 }, rows = I.rows, ph = rnd(o) * 6.28, mm = {}, r, c;
    for (r = 0; r < rows; r++) {
      var row = blankRow(g, r);
      for (c = 0; c < row.length; c++) if (shapeOn(pat, r, cellX(g, r, c), rows, o, mm, ph)) row[c] = { t: 'n', c: -1 };
      g.grid.push(row);
    }
    // colors: clustered random fill (stage 1 very clustered), often mirrored for symmetric shapes
    var mirror = pat !== 'full' && pat !== 'waves' && rnd(oc) < 0.7;
    for (r = 0; r < rows; r++) for (c = 0; c < rowLen(g, r); c++) {
      var b = at(g, r, c);
      if (!b || (mirror && cellX(g, r, c) > LX)) continue;
      var nb = nbrs(g, r, c).map(function (q) { return at(g, q[0], q[1]); }).filter(function (x) { return x && x.c >= 0; });
      b.c = nb.length && rnd(oc) < I.same ? nb[ri(oc, nb.length)].c : ri(oc, I.colors);
    }
    if (mirror) for (r = 0; r < rows; r++) for (c = 0; c < rowLen(g, r); c++) {
      var mb = at(g, r, c);
      if (mb && cellX(g, r, c) > LX) { var tw = at(g, r, rowLen(g, r) - 1 - c); mb.c = tw && tw.c >= 0 ? tw.c : ri(oc, I.colors); }
    }
    // anything not hanging from the ceiling goes
    var att = attached(g);
    each(g, function (b, r, c) { if (!att[key(r, c)]) g.grid[r][c] = null; });
    trimRows(g);
    if (count(g) < 18 && pat !== 'full') return genStage(n, diff, 'full');
    // hazards: stones (lower down), ice (1 hit), locks (2 hits); then powerup bubbles
    function convert(k, minR, fn) {
      for (var i = 0, tries = 0; i < k && tries < 400; tries++) {
        var rr = minR + ri(oc, Math.max(1, g.grid.length - minR)), row = g.grid[rr];
        if (!row) continue;
        var cc = ri(oc, row.length), bb = row[cc];
        if (!bb || bb.t !== 'n' || bb.p) continue;
        if (fn(bb, rr)) i++;
      }
    }
    var lowR = Math.max(1, Math.floor(g.grid.length / 3));
    convert(I.stones, 1, function (b, rr) { if (rr < lowR && rnd(oc) < 0.7) return false; b.t = 's'; b.c = -1; return true; });
    convert(I.ice, 0, function (b) { b.t = 'i'; b.hp = 1; return true; });
    convert(I.locks, 1, function (b) { b.t = 'i'; b.hp = 2; return true; });
    convert(I.pws, 1, function (b) { b.p = n === 1 ? 'bomb' : pickPw(oc); return true; });
    var hits = 0, cells = 0;
    each(g, function (b) { if (b.t !== 's') cells++; if (b.t === 'i') hits += b.hp; });
    return { grid: g.grid, pat: pat, info: I, par: Math.ceil(cells * 0.36 + hits * 0.5) + 2 };
  }

  // ---- endless: a new row pushes in from the top ----
  function pushEvery(g) { return Math.max(3, DIFFS[g.diff].push - Math.floor(g.pushed / 12)); }
  function pushRow(g, quiet) {
    g.par ^= 1;                                   // keep every existing bubble where it is
    var row = blankRow(g, 0), lvl = g.pushed, old = { grid: [row].concat(g.grid), par: g.par, drop: 0 };
    g.grid.unshift(row);
    var pStone = quiet ? 0 : Math.min(0.07, Math.max(0, (lvl - 6) * 0.003)),
      pIce = quiet ? 0 : Math.min(0.08, Math.max(0, (lvl - 10) * 0.003));
    for (var c = 0; c < row.length; c++) {
      var col, x = rnd(g), below = nbrs(old, 0, c).filter(function (q) { return q[0] === 1; }).map(function (q) { return at(old, 1, q[1]); })
        .filter(function (b) { return b && b.t === 'n'; });
      if (c > 0 && row[c - 1] && row[c - 1].c >= 0 && x < 0.4) col = row[c - 1].c;
      else if (below.length && x < 0.65) col = below[ri(g, below.length)].c;
      else col = ri(g, g.nColors);
      var b = { t: 'n', c: col }, y = rnd(g);
      if (y < pStone) { b.t = 's'; b.c = -1; }
      else if (y < pStone + pIce) { b.t = 'i'; b.hp = lvl > 40 && rnd(g) < 0.4 ? 2 : 1; }
      else if (!quiet && rnd(g) < 0.025) b.p = pickPw(g);
      row[c] = b;
    }
    if (!quiet) {
      g.pushed++;
      g.nColors = Math.min(NCOL, DIFFS[g.diff].ec + Math.floor(g.pushed / 30));
      emit(g, { k: 'push' });
    }
  }

  // ---- a game ----
  function ammo(g) {
    var cs = presentColors(g);
    if (!cs.length) cs = presentColors(g, true);
    return { k: 'n', c: cs.length ? cs[ri(g, cs.length)] : ri(g, g.nColors) };
  }
  function newGame(o) {
    o = o || {};
    var diff = clamp(o.diff | 0, 0, 2), mode = o.mode === 'endless' ? 'endless' : 'stages', stage = Math.max(1, o.stage | 0), d = DIFFS[diff];
    var g = {
      v: VERSION, mode: mode, diff: diff, stage: stage, assist: !!o.assist, grid: [], par: 0, drop: 0,
      score: 0, shots: 0, streak: 0, bestStreak: 0, popped: 0, fell: 0,
      inv: { bomb: 0, rainbow: 0, fire: 0, sight: 0, freeze: 0, paint: 0 }, sight: 0, freeze: 0,
      cur: null, next: null, stash: null, shot: null, phase: 'aim', ev: [], rs: 1,
      nColors: d.ec, missAllow: 0, missLeft: 0, pushLeft: 0, pushed: 0, parShots: 0, stars: 0, bonus: 0, tutorial: false, pat: ''
    };
    if (mode === 'stages') {
      var L = genStage(stage, diff);
      g.grid = L.grid; g.nColors = L.info.colors; g.missAllow = g.missLeft = L.info.miss; g.parShots = L.par; g.pat = L.pat;
      g.tutorial = stage === 1; g.rs = hash(stage * 131 + diff * 17 + 5);
    } else {
      g.rs = (o.seed == null ? (Date.now() ^ Math.floor(Math.random() * 1e9)) : o.seed) | 0;
      for (var i = 0; i < 6; i++) pushRow(g, true);
      g.pushLeft = pushEvery(g);
    }
    g.cur = ammo(g); g.next = ammo(g);
    return g;
  }
  function guideMode(g) { return g.tutorial || g.assist || g.sight > 0 ? 'full' : 'stub'; }

  function fire(g, ang) {
    if (!g || g.phase !== 'aim') return false;
    ang = clampAng(ang);
    var a = g.cur;
    g.shot = { x: LX, y: LY, vx: Math.cos(ang) * SPEED, vy: Math.sin(ang) * SPEED, k: a.k, c: a.c, burn: 0 };
    if (g.stash) { g.cur = g.stash; g.stash = null; } else { g.cur = g.next; g.next = ammo(g); }
    g.phase = 'fly'; g.shots++;
    if (g.sight > 0) g.sight--;
    emit(g, { k: 'fire', s: a.k });
    return true;
  }
  function swap(g) {
    if (!g || g.phase !== 'aim' || g.stash) return false;
    var t = g.cur; g.cur = g.next; g.next = t;
    return true;
  }
  // tap an item: Sight / Freeze apply at once, Bomb / Rainbow / Fireball load into the
  // launcher (tap again to put back), Paint asks for a color (then paint())
  function useItem(g, k) {
    if (!g || g.phase !== 'aim' || PWS.indexOf(k) < 0) return false;
    var armed = g.stash ? g.cur.k : null;
    if (armed === k) { g.inv[k]++; g.cur = g.stash; g.stash = null; return 'disarmed'; }
    if (g.inv[k] <= 0) return false;
    if (k === 'sight') { g.inv[k]--; g.sight += SIGHT_SHOTS; emit(g, { k: 'use', p: k }); return 'used'; }
    if (k === 'freeze') { g.inv[k]--; g.freeze += FREEZE_SHOTS; emit(g, { k: 'use', p: k }); return 'used'; }
    if (k === 'paint') return 'pick';
    if (armed) { g.inv[armed]++; g.cur = g.stash; g.stash = null; }
    g.inv[k]--; g.stash = g.cur; g.cur = { k: k, c: -1 };
    emit(g, { k: 'use', p: k });
    return 'armed';
  }
  function paint(g, col) {
    if (!g || g.phase !== 'aim' || g.inv.paint <= 0 || !(col >= 0 && col < NCOL)) return false;
    var t = g.stash || g.cur;
    g.inv.paint--; t.c = col; t.painted = true;
    emit(g, { k: 'use', p: 'paint' });
    return true;
  }
  function award(g, p) {
    if (g.inv[p] >= MAX_INV) { g.score += 250; emit(g, { k: 'pw', p: p, full: true }); return; }
    g.inv[p]++;
    emit(g, { k: 'pw', p: p });
  }
  function crack(g, r, c) {
    var b = at(g, r, c);
    if (!b || b.t !== 'i') return;
    b.hp--;
    emit(g, { k: 'thaw', x: cellX(g, r, c), y: cellY(g, r), hp: b.hp, c: b.c });
    if (b.hp <= 0) { b.t = 'n'; delete b.hp; }
  }
  // pop a list of cells (nearest the impact first), then thaw ice touching them
  function popCells(g, list, x, y, why) {
    var seen = {}, cells = [], thaw = {}, i;
    for (i = 0; i < list.length; i++) {
      var k = key(list[i][0], list[i][1]);
      if (seen[k] || !at(g, list[i][0], list[i][1])) continue;
      seen[k] = 1; cells.push(list[i]);
    }
    cells.sort(function (a, b) {
      var da = Math.pow(cellX(g, a[0], a[1]) - x, 2) + Math.pow(cellY(g, a[0]) - y, 2), db = Math.pow(cellX(g, b[0], b[1]) - x, 2) + Math.pow(cellY(g, b[0]) - y, 2);
      return da - db;
    });
    for (i = 0; i < cells.length; i++) {
      var r = cells[i][0], c = cells[i][1], b = at(g, r, c);
      g.grid[r][c] = null;
      emit(g, { k: 'pop', x: cellX(g, r, c), y: cellY(g, r), c: b.c, t: b.t, hp: b.hp, p: b.p, i: i, why: why || '' });
      if (b.p) award(g, b.p);
      if (why !== 'bomb') nbrs(g, r, c).forEach(function (q) { var nb = at(g, q[0], q[1]); if (nb && nb.t === 'i') thaw[key(q[0], q[1])] = q; });
    }
    for (var t in thaw) crack(g, thaw[t][0], thaw[t][1]);
    return cells.length;
  }
  function dropOrphans(g) {
    var att = attached(g), n = 0;
    each(g, function (b, r, c) {
      if (att[key(r, c)]) return;
      g.grid[r][c] = null;
      emit(g, { k: 'fall', x: cellX(g, r, c), y: cellY(g, r), c: b.c, t: b.t, hp: b.hp, p: b.p, i: n });
      if (b.p) award(g, b.p);
      n++;
    });
    return n;
  }
  function burn(g, r, c) {
    var b = at(g, r, c);
    g.grid[r][c] = null;
    emit(g, { k: 'pop', x: cellX(g, r, c), y: cellY(g, r), c: b.c, t: b.t, hp: b.hp, p: b.p, i: 0, why: 'fire' });
    if (b.p) award(g, b.p);
  }
  function step(g, dt) {
    var s = g.shot;
    if (!g || g.phase !== 'fly' || !s) return;
    var n = Math.max(1, Math.ceil(SPEED * dt / 0.3)), h = dt / n;
    for (var i = 0; i < n; i++) {
      s.x += s.vx * h; s.y += s.vy * h;
      if (s.x < R) { s.x = 2 * R - s.x; s.vx = Math.abs(s.vx); emit(g, { k: 'bounce', x: s.x, y: s.y }); }
      else if (s.x > W - R) { s.x = 2 * (W - R) - s.x; s.vx = -Math.abs(s.vx); emit(g, { k: 'bounce', x: s.x, y: s.y }); }
      var ceil = ceilOf(g);
      if (s.y - R <= ceil) { s.y = ceil + R; if (s.k === 'fire') endFire(g); else land(g, null); return; }
      if (s.k === 'fire') {
        var q;
        while ((q = hitAt(g, s.x, s.y))) { burn(g, q[0], q[1]); s.burn++; if (s.burn >= FIRE_MAX) { endFire(g); return; } }
        continue;
      }
      var hit = hitAt(g, s.x, s.y);
      if (hit) { land(g, hit); return; }
      if (s.y > H + 4) { g.shot = null; settle(g, { pop: 0, fall: 0, x: s.x, y: s.y }); return; }
    }
  }
  function endFire(g) {
    var s = g.shot; g.shot = null;
    emit(g, { k: 'fizzle', x: s.x, y: s.y });
    var fall = dropOrphans(g);
    settle(g, { pop: s.burn, fall: fall, x: s.x, y: Math.max(s.y, 3) });
  }
  function land(g, hit) {
    var s = g.shot; g.shot = null;
    var res = { pop: 0, fall: 0, x: s.x, y: s.y };
    if (s.k === 'bomb') {
      var list = [], bc = nearestCell(g, s.x, s.y);
      if (bc) { s.x = cellX(g, bc.r, bc.c); s.y = cellY(g, bc.r); res.x = s.x; res.y = s.y; }
      each(g, function (b, r, c) { var dx = cellX(g, r, c) - s.x, dy = cellY(g, r) - s.y; if (dx * dx + dy * dy <= BOMB_R * BOMB_R) list.push([r, c]); });
      emit(g, { k: 'bomb', x: s.x, y: s.y });
      res.pop = popCells(g, list, s.x, s.y, 'bomb');
    } else {
      if (hit) crack(g, hit[0], hit[1]);                 // a direct hit cracks ice
      var cell = nearestCell(g, s.x, s.y);
      if (cell) {
        var b = { t: 'n', c: s.k === 'rainbow' ? -2 : s.c }, bx = cellX(g, cell.r, cell.c), by = cellY(g, cell.r);
        put(g, cell.r, cell.c, b);
        res.x = bx; res.y = by;
        emit(g, { k: 'land', x: bx, y: by, r: cell.r, c: cell.c, s: s.k });
        if (s.k === 'rainbow') {
          // wild: joins every neighboring color group of 2+
          var cols = [], tot = [[cell.r, cell.c]], any = false;
          nbrs(g, cell.r, cell.c).forEach(function (q) { var nb = at(g, q[0], q[1]); if (nb && nb.t === 'n' && nb.c >= 0 && cols.indexOf(nb.c) < 0) cols.push(nb.c); });
          cols.forEach(function (col) {
            var grp = [], seen = {};
            nbrs(g, cell.r, cell.c).forEach(function (q) {
              flood(g, q[0], q[1], col).forEach(function (p) { var k = key(p[0], p[1]); if (!seen[k]) { seen[k] = 1; grp.push(p); } });
            });
            if (grp.length >= 2) { tot = tot.concat(grp); any = true; }
          });
          if (any) res.pop = popCells(g, tot, bx, by, 'rainbow');
          else { var pc = presentColors(g); b.c = cols.length ? cols[0] : pc.length ? pc[ri(g, pc.length)] : ri(g, g.nColors); }
        } else {
          var grp = flood(g, cell.r, cell.c, b.c);
          if (grp.length >= 3) res.pop = popCells(g, grp, bx, by);
        }
      }
    }
    res.fall = dropOrphans(g);
    settle(g, res);
  }
  function settle(g, res) {
    var d = DIFFS[g.diff], hit = res.pop > 0;
    if (hit) g.streak++; else g.streak = 0;
    if (g.streak > g.bestStreak) g.bestStreak = g.streak;
    var mul = comboMul(g.streak) * d.mul * (g.assist ? ASSIST_MUL : 1);
    var base = res.pop * 10 + (res.fall ? res.fall * 20 + res.fall * res.fall * 5 : 0), pts = Math.round(base * mul);
    if (pts) { g.score += pts; emit(g, { k: 'score', x: res.x, y: res.y, v: pts, m: mul, fall: res.fall }); }
    g.popped += res.pop; g.fell += res.fall;
    if (hit && g.streak >= 2) emit(g, { k: 'streak', n: g.streak, m: comboMul(g.streak) });
    if (hit && g.streak % 5 === 0) award(g, pickPw(g));
    if (res.fall >= 8) award(g, pickPw(g));
    // pressure
    var frozen = g.freeze > 0;
    if (frozen) g.freeze--;
    if (g.mode === 'stages') {
      if (!hit && !frozen) {
        g.missLeft--;
        if (g.missLeft <= 0) { g.drop++; g.missLeft = g.missAllow; emit(g, { k: 'drop' }); }
      }
    } else if (!frozen) {
      g.pushLeft -= hit ? 1 : 2;
      while (g.pushLeft <= 0) { pushRow(g); g.pushLeft += pushEvery(g); }
    }
    trimRows(g);
    // cleared: no colored bubbles left (leftover stones crumble)
    if (!count(g, function (b) { return b.t !== 's'; })) {
      var rest = 0;
      each(g, function (b, r, c) { g.grid[r][c] = null; emit(g, { k: 'fall', x: cellX(g, r, c), y: cellY(g, r), c: -1, t: 's', i: rest++ }); });
      trimRows(g);
      var am = d.mul * (g.assist ? ASSIST_MUL : 1);
      if (g.mode === 'stages') {
        g.stars = starsFor(g.shots, g.parShots);
        g.bonus = Math.round((1000 + Math.max(0, g.parShots - g.shots) * 100 + rest * 50) * am);
        g.score += g.bonus;
        g.phase = 'won';
        emit(g, { k: 'won', stars: g.stars, bonus: g.bonus });
        return;
      }
      var cb = Math.round(1500 * am);
      g.score += cb;
      emit(g, { k: 'clear', v: cb });
      for (var i = 0; i < 4; i++) pushRow(g);
    }
    if (lowest(g) + g.drop >= DEAD_ROWS) { g.phase = 'lost'; emit(g, { k: 'lost' }); return; }
    g.phase = 'aim';
    // keep the loaded bubbles to colors still on the board
    var pc = presentColors(g);
    if (pc.length) [g.cur, g.next, g.stash].forEach(function (a) { if (a && a.k === 'n' && !a.painted && pc.indexOf(a.c) < 0) a.c = pc[ri(g, pc.length)]; });
  }
  // where a shot fired at `ang` goes: the bounce path and the cell it would snap into
  function trace(g, ang, maxLen) {
    ang = clampAng(ang);
    var x = LX, y = LY, vx = Math.cos(ang), vy = Math.sin(ang), pts = [[x, y]], len = 0, hs = 0.2, ceil = ceilOf(g), end = false;
    maxLen = maxLen || 200;
    while (len < maxLen) {
      x += vx * hs; y += vy * hs; len += hs;
      if (x < R) { x = 2 * R - x; vx = -vx; pts.push([R, y]); }
      else if (x > W - R) { x = 2 * (W - R) - x; vx = -vx; pts.push([W - R, y]); }
      if (y - R <= ceil) { y = ceil + R; end = true; break; }
      if (hitAt(g, x, y)) { end = true; break; }
    }
    pts.push([x, y]);
    return { pts: pts, cell: end ? nearestCell(g, x, y) : null, len: len, x: x, y: y };
  }
  function danger(g) { return lowest(g) + g.drop >= DEAD_ROWS - 2; }

  // ---- save / restore a run (only between shots) ----
  function snap(g) {
    if (!g || g.phase !== 'aim') return null;
    var o = JSON.parse(JSON.stringify(g));
    o.ev = []; o.shot = null;
    return o;
  }
  function restore(o) {
    if (!o || o.v !== VERSION || !Array.isArray(o.grid) || !o.cur || !o.next || !o.inv) return null;
    if (o.mode !== 'stages' && o.mode !== 'endless') return null;
    if (o.phase !== 'aim') return null;
    for (var r = 0; r < o.grid.length; r++) if (!Array.isArray(o.grid[r]) || o.grid[r].length !== rowLen(o, r)) return null;
    o.ev = []; o.shot = null;
    PWS.forEach(function (k) { o.inv[k] = clamp(o.inv[k] | 0, 0, MAX_INV); });
    return o;
  }

  var ENGINE = {
    VERSION: VERSION, CEIL0: CEIL0, COLS: COLS, R: R, ROWH: ROWH, W: W, H: H, DEAD_ROWS: DEAD_ROWS, DEAD_Y: DEAD_Y, LX: LX, LY: LY, NX: NX, NY: NY,
    STEP: STEP, SPEED: SPEED, HIT: HIT, BOMB_R: BOMB_R, NCOL: NCOL, MAX_INV: MAX_INV, SIGHT_SHOTS: SIGHT_SHOTS, FREEZE_SHOTS: FREEZE_SHOTS,
    STUB_LEN: STUB_LEN, ASSIST_MUL: ASSIST_MUL, PWS: PWS, DIFFS: DIFFS, PATS: PATS,
    rnd: rnd, hash: hash, rowOff: rowOff, rowLen: rowLen, cellX: cellX, cellY: cellY, ceilOf: ceilOf, at: at, put: put, nbrs: nbrs, each: each, count: count,
    lowest: lowest, flood: flood, attached: attached, presentColors: presentColors, nearestCell: nearestCell, hitAt: hitAt, clampAng: clampAng,
    comboMul: comboMul, starsFor: starsFor, stageInfo: stageInfo, genStage: genStage, pushRow: pushRow, pushEvery: pushEvery,
    newGame: newGame, guideMode: guideMode, fire: fire, swap: swap, useItem: useItem, paint: paint, step: step, trace: trace, danger: danger,
    snap: snap, restore: restore
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('bubbles.css');

  var PANEL_ID = 'bubbles-panel', NAME = 'Bubble Burst';
  var KEY = 'cade-bubbles-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound', RUN_KEY = KEY + 'run';
  var PW_ICON = { bomb: '💣', rainbow: '🌈', fire: '🔥', sight: '🎯', freeze: '❄️', paint: '🎨' };
  var PW_NAME = { bomb: 'Bomb', rainbow: 'Rainbow', fire: 'Fireball', sight: 'Sight', freeze: 'Freeze', paint: 'Paint' };
  var PW_DESC = {
    bomb: 'blasts every bubble around where it hits',
    rainbow: 'wild — joins any color group it touches',
    fire: 'burns straight through a line of bubbles',
    sight: 'full aiming guide for ' + SIGHT_SHOTS + ' shots',
    freeze: 'stops the ceiling for ' + FREEZE_SHOTS + ' shots',
    paint: 'recolor the loaded bubble'
  };
  var GLYPH_CH = ['▲', '●', '■', '◆', '★', '✚', '✖'];
  var COL_NAME = ['red', 'blue', 'yellow', 'green', 'purple', 'cyan', 'pink'];
  var TAU = PI * 2;
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.bubbles = { live: function () { return S; } };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { if (Cade.store.remove) Cade.store.remove(k); else Cade.store.set(k, ''); } catch (e) {} }
  function newSave() {
    return { v: 1, diff: 1, glyphs: true, assist: false, mode: 'stages', sel: 1, page: 0, games: 0,
      prog: [0, 1, 2].map(function () { return { un: 1, st: {}, hs: {} }; }), eBest: [0, 0, 0], eRows: [0, 0, 0] };
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    s.diff = clamp(o.diff | 0, 0, 2);
    s.glyphs = o.glyphs !== false;
    s.assist = !!o.assist;
    s.mode = o.mode === 'endless' ? 'endless' : 'stages';
    s.sel = Math.max(1, o.sel | 0);
    s.page = Math.max(0, o.page | 0);
    s.games = Math.max(0, o.games | 0);
    if (Array.isArray(o.prog)) for (var i = 0; i < 3; i++) {
      var p = o.prog[i];
      if (p && typeof p === 'object') { s.prog[i].un = Math.max(1, p.un | 0); s.prog[i].st = p.st && typeof p.st === 'object' ? p.st : {}; s.prog[i].hs = p.hs && typeof p.hs === 'object' ? p.hs : {}; }
    }
    if (Array.isArray(o.eBest)) for (i = 0; i < 3; i++) s.eBest[i] = Math.max(0, o.eBest[i] | 0);
    if (Array.isArray(o.eRows)) for (i = 0; i < 3; i++) s.eRows[i] = Math.max(0, o.eRows[i] | 0);
    return s;
  }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function loadRun() {
    var raw = sget(RUN_KEY);
    if (!raw) return null;
    try { return restore(JSON.parse(raw)); } catch (e) { return null; }
  }
  function saveRun() { if (S && S.g && !S.preview) { var o = snap(S.g); if (o) sset(RUN_KEY, JSON.stringify(o)); } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function fmt(n) { n = Math.round(n || 0); return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  // ---- sound ----
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
  var IC_SWAP = svg('<path d="M7 7h11l-3-3M17 17H6l3 3"/>');

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
  function lum(c) { return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
  var BUB_LIGHT = [[226, 58, 70], [40, 116, 226], [244, 182, 24], [46, 166, 80], [138, 80, 214], [20, 178, 190], [236, 92, 168]];
  var BUB_DARK = [[255, 92, 102], [82, 152, 255], [255, 204, 64], [84, 204, 112], [174, 124, 255], [54, 212, 214], [255, 128, 196]];
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var dark = lum(bg) < 0.45;
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.55)), fa = parseCol(v('--text-faint'), mix(bg, tx, 0.35));
    var red = dark ? [240, 106, 106] : [207, 63, 63];
    S.dark = dark;
    S.bub = dark ? BUB_DARK : BUB_LIGHT;
    S.col = {
      bg: css(bg), bgA: bg, tx: tx, text: css(tx), muted: css(mu), faint: css(fa), acc: css(ac), accA: ac, red: css(red), redA: red,
      font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace',
      field1: css(mix(bg, ac, dark ? 0.07 : 0.06)), field2: css(bg),
      ceil: css(mix(bg, tx, dark ? 0.16 : 0.12)), ceilLine: css(mix(bg, tx, dark ? 0.32 : 0.3)), hatch: css(mix(bg, tx, dark ? 0.24 : 0.2)),
      base: css(mix(bg, tx, dark ? 0.12 : 0.08)), baseEdge: css(mix(bg, tx, dark ? 0.3 : 0.25)),
      stone: dark ? [128, 122, 114] : [136, 128, 118], dot: css(mix(bg, tx, 0.45)),
      shadow: dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.16)'
    };
    buildSprites();
  }

  // ---- sprites: every bubble look rendered once at the current scale ----
  function mkSpr(fn) {
    var px = Math.max(8, Math.ceil(2.3 * S.sc * S.k)), cv = document.createElement('canvas');
    cv.width = cv.height = px;
    var c = cv.getContext('2d'), u = px / 2.3;
    c.translate(px / 2, px / 2); c.scale(u, u);
    fn(c, u, px);
    return { cv: cv, wu: 2.3 };
  }
  function paintBall(c, rgb, gloss) {
    var dk = mix(rgb, [0, 0, 0], 0.42), lt = mix(rgb, [255, 255, 255], 0.5);
    var gr = c.createRadialGradient(-0.32, -0.38, 0.05, 0, 0, 1);
    gr.addColorStop(0, css(lt)); gr.addColorStop(0.5, css(rgb)); gr.addColorStop(1, css(dk));
    c.beginPath(); c.arc(0, 0, 0.95, 0, TAU); c.fillStyle = gr; c.fill();
    c.lineWidth = 0.06; c.strokeStyle = css(mix(rgb, [0, 0, 0], 0.55), 0.85); c.stroke();
    if (gloss === false) return;
    c.beginPath(); c.arc(0, 0, 0.78, 0.2 * PI, 0.8 * PI); c.strokeStyle = 'rgba(255,255,255,0.24)'; c.lineWidth = 0.09; c.stroke();
    c.save(); c.translate(-0.34, -0.43); c.rotate(-0.62);
    c.beginPath(); c.ellipse(0, 0, 0.3, 0.16, 0, 0, TAU); c.fillStyle = 'rgba(255,255,255,0.78)'; c.fill();
    c.restore();
    c.beginPath(); c.arc(0.44, 0.4, 0.08, 0, TAU); c.fillStyle = 'rgba(255,255,255,0.32)'; c.fill();
  }
  function paintGlyph(c, i, rgb, s) {
    var light = lum(rgb) > 0.6, f = light ? 'rgba(50,34,6,0.62)' : 'rgba(255,255,255,0.86)';
    s = s || 1;
    c.save(); c.translate(0, 0.06); c.scale(s, s);
    c.fillStyle = f; c.strokeStyle = f; c.lineJoin = 'round';
    c.beginPath();
    switch (i) {
      case 0: c.moveTo(0, -0.36); c.lineTo(0.34, 0.26); c.lineTo(-0.34, 0.26); c.closePath(); c.fill(); break;
      case 1: c.arc(0, 0, 0.24, 0, TAU); c.lineWidth = 0.13; c.stroke(); break;
      case 2: c.rect(-0.25, -0.25, 0.5, 0.5); c.fill(); break;
      case 3: c.moveTo(0, -0.37); c.lineTo(0.3, 0); c.lineTo(0, 0.37); c.lineTo(-0.3, 0); c.closePath(); c.fill(); break;
      case 4:
        for (var k = 0; k < 10; k++) { var a = -PI / 2 + k * PI / 5, rr = k % 2 ? 0.16 : 0.38; c[k ? 'lineTo' : 'moveTo'](Math.cos(a) * rr, Math.sin(a) * rr); }
        c.closePath(); c.fill(); break;
      case 5: c.rect(-0.1, -0.34, 0.2, 0.68); c.rect(-0.34, -0.1, 0.68, 0.2); c.fill(); break;
      case 6: c.rotate(PI / 4); c.rect(-0.09, -0.36, 0.18, 0.72); c.rect(-0.36, -0.09, 0.72, 0.18); c.fill(); break;
    }
    c.restore();
  }
  function buildSprites() {
    if (!S.col || !S.sc) return;
    var sp = { c: [], g: [], ice1: null, ice2: null, stone: null, bomb: null, rainbow: null, fire: null, pw: {} };
    var glyphs = S.save.glyphs;
    for (var i = 0; i < NCOL; i++) {
      (function (i) {
        var rgb = S.bub[i];
        sp.c.push(mkSpr(function (c) { paintBall(c, rgb); if (glyphs) paintGlyph(c, i, rgb); }));
      })(i);
    }
    sp.stone = mkSpr(function (c) {
      var rgb = S.col.stone;
      c.beginPath();
      for (var k = 0; k < 9; k++) { var a = k / 9 * TAU, rr = 0.9 + ((k * 37) % 7) / 70; c[k ? 'lineTo' : 'moveTo'](Math.cos(a) * rr, Math.sin(a) * rr); }
      c.closePath();
      var gr = c.createRadialGradient(-0.3, -0.35, 0.05, 0, 0, 1);
      gr.addColorStop(0, css(mix(rgb, [255, 255, 255], 0.35))); gr.addColorStop(1, css(mix(rgb, [0, 0, 0], 0.45)));
      c.fillStyle = gr; c.fill();
      c.lineWidth = 0.07; c.strokeStyle = css(mix(rgb, [0, 0, 0], 0.6)); c.stroke();
      c.beginPath(); c.moveTo(-0.5, -0.2); c.lineTo(-0.1, 0.05); c.lineTo(0.05, 0.45); c.moveTo(-0.1, 0.05); c.lineTo(0.42, -0.12); c.lineTo(0.55, -0.42);
      c.strokeStyle = css(mix(rgb, [0, 0, 0], 0.62)); c.lineWidth = 0.07; c.stroke();
      [[-0.45, 0.4], [0.35, 0.35], [0.1, -0.55], [-0.15, -0.5]].forEach(function (p) { c.beginPath(); c.arc(p[0], p[1], 0.06, 0, TAU); c.fillStyle = css(mix(rgb, [0, 0, 0], 0.3)); c.fill(); });
    });
    function frost(c, hp) {
      c.save();
      c.beginPath(); c.arc(0, 0, 0.95, 0, TAU); c.clip();
      c.fillStyle = hp > 1 ? 'rgba(205,232,250,0.52)' : 'rgba(215,240,255,0.42)'; c.fillRect(-1, -1, 2, 2);
      c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = 0.05;
      c.beginPath(); c.moveTo(-0.9, -0.1); c.lineTo(-0.3, -0.35); c.lineTo(0.2, -0.9); c.moveTo(-0.3, -0.35); c.lineTo(0.1, 0.25); c.lineTo(0.9, 0.1);
      c.moveTo(0.1, 0.25); c.lineTo(-0.2, 0.9); c.stroke();
      if (hp > 1) {
        c.fillStyle = 'rgba(120,134,150,0.92)';
        c.save(); c.rotate(0.7); c.fillRect(-1, -0.12, 2, 0.24); c.rotate(-1.4); c.fillRect(-1, -0.12, 2, 0.24); c.restore();
        c.beginPath(); c.arc(0, -0.12, 0.17, PI, 0); c.lineWidth = 0.08; c.strokeStyle = 'rgba(70,80,92,1)'; c.stroke();
        c.fillStyle = 'rgba(70,80,92,1)'; c.fillRect(-0.24, -0.12, 0.48, 0.36);
        c.fillStyle = 'rgba(230,236,242,1)'; c.fillRect(-0.04, 0, 0.08, 0.14);
      }
      c.restore();
      c.beginPath(); c.arc(0, 0, 0.93, 0, TAU); c.lineWidth = hp > 1 ? 0.14 : 0.1; c.strokeStyle = 'rgba(180,225,255,0.95)'; c.stroke();
    }
    sp.ice1 = mkSpr(function (c) { frost(c, 1); });
    sp.ice2 = mkSpr(function (c) { frost(c, 2); });
    sp.bomb = mkSpr(function (c) {
      paintBall(c, S.dark ? [70, 72, 84] : [52, 54, 64]);
      c.beginPath(); c.moveTo(0.35, -0.75); c.quadraticCurveTo(0.6, -1.05, 0.85, -0.95); c.strokeStyle = '#c9a36b'; c.lineWidth = 0.1; c.stroke();
      c.fillStyle = '#ff9d2e'; c.beginPath(); c.arc(0.88, -0.95, 0.12, 0, TAU); c.fill();
    });
    sp.rainbow = mkSpr(function (c) {
      for (var k = 0; k < 7; k++) {
        c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, 0.95, k / 7 * TAU - PI / 2, (k + 1) / 7 * TAU - PI / 2); c.closePath();
        c.fillStyle = css(S.bub[k]); c.fill();
      }
      var gr = c.createRadialGradient(-0.32, -0.38, 0.05, 0, 0, 1);
      gr.addColorStop(0, 'rgba(255,255,255,0.7)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.05)'); gr.addColorStop(1, 'rgba(0,0,0,0.3)');
      c.beginPath(); c.arc(0, 0, 0.95, 0, TAU); c.fillStyle = gr; c.fill();
      c.lineWidth = 0.06; c.strokeStyle = 'rgba(0,0,0,0.4)'; c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.9)'; c.beginPath();
      for (var j = 0; j < 10; j++) { var a = -PI / 2 + j * PI / 5, rr = j % 2 ? 0.13 : 0.32; c[j ? 'lineTo' : 'moveTo'](Math.cos(a) * rr, Math.sin(a) * rr); }
      c.closePath(); c.fill();
    });
    sp.fire = mkSpr(function (c) {
      var gr = c.createRadialGradient(-0.2, -0.25, 0.05, 0, 0, 1);
      gr.addColorStop(0, '#fff6c2'); gr.addColorStop(0.35, '#ffc23a'); gr.addColorStop(0.75, '#ff6a1a'); gr.addColorStop(1, '#c72e0e');
      c.beginPath(); c.arc(0, 0, 0.95, 0, TAU); c.fillStyle = gr; c.fill();
      c.beginPath(); c.moveTo(0, -0.55); c.quadraticCurveTo(0.42, -0.05, 0.18, 0.42); c.quadraticCurveTo(0, 0.6, -0.18, 0.42); c.quadraticCurveTo(-0.42, -0.05, 0, -0.55);
      c.fillStyle = 'rgba(255,255,255,0.75)'; c.fill();
    });
    PWS.forEach(function (p) {
      sp.pw[p] = mkSpr(function (c, u, px) {
        c.beginPath(); c.arc(0.5, -0.5, 0.5, 0, TAU); c.fillStyle = S.dark ? 'rgba(20,20,24,0.92)' : 'rgba(255,255,255,0.95)'; c.fill();
        c.lineWidth = 0.07; c.strokeStyle = S.col.acc; c.stroke();
        c.save(); c.setTransform(1, 0, 0, 1, 0, 0);
        c.font = Math.round(0.62 * u) + 'px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(PW_ICON[p], px / 2 + 0.5 * u, px / 2 - 0.46 * u);
        c.restore();
      });
    });
    S.spr = sp;
  }
  function sprOf(b) {
    var sp = S.spr;
    if (!sp) return null;
    if (b.t === 's') return sp.stone;
    if (b.k === 'bomb') return sp.bomb;
    if (b.k === 'rainbow' || b.c === -2) return sp.rainbow;
    if (b.k === 'fire') return sp.fire;
    return sp.c[clamp(b.c | 0, 0, NCOL - 1)];
  }
  function blit(spr, x, y, sc, alpha) {
    if (!spr) return;
    var c = S.ctx, s = spr.wu * (sc || 1);
    if (alpha != null && alpha < 1) { var a0 = c.globalAlpha; c.globalAlpha = a0 * Math.max(0, alpha); c.drawImage(spr.cv, x - s / 2, y - s / 2, s, s); c.globalAlpha = a0; }
    else c.drawImage(spr.cv, x - s / 2, y - s / 2, s, s);
  }
  function drawBubble(b, x, y, sc, alpha) {
    blit(sprOf(b), x, y, sc, alpha);
    if (b.t === 'i') blit(b.hp > 1 ? S.spr.ice2 : S.spr.ice1, x, y, sc, alpha);
    if (b.p) blit(S.spr.pw[b.p], x, y, sc, alpha);
  }

  // ---- fx ----
  function clearFx() { S.parts = []; S.pops = []; S.falls = []; S.texts = []; S.rings = []; S.shake = 0; S.yOffB = 0; S.yOffC = 0; }
  function part(x, y, vx, vy, life, col, size, grav) {
    if (S.parts.length > 400) S.parts.shift();
    S.parts.push({ x: x, y: y, vx: vx, vy: vy, t: 0, life: life, col: col, sz: size || 0.18, gv: grav == null ? 20 : grav });
  }
  function burst(x, y, col, n, spd) {
    n = S.rm ? Math.ceil(n / 3) : n;
    for (var i = 0; i < n; i++) {
      var a = Math.random() * TAU, v = (0.4 + Math.random()) * (spd || 9);
      part(x, y, Math.cos(a) * v, Math.sin(a) * v, 0.35 + Math.random() * 0.35, col, 0.12 + Math.random() * 0.16);
    }
  }
  function popup(x, y, text, col, big) { S.texts.push({ x: x, y: y, s: text, col: col, t: 0, big: !!big }); }
  function bcol(c) { return c >= 0 ? css(S.bub[c]) : c === -2 ? S.col.acc : css(S.col.stone); }
  function stepFx(dt) {
    var i, p;
    for (i = S.parts.length - 1; i >= 0; i--) {
      p = S.parts[i]; p.t += dt;
      if (p.t >= p.life) { S.parts.splice(i, 1); continue; }
      p.vy += p.gv * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (i = S.pops.length - 1; i >= 0; i--) { p = S.pops[i]; p.t += dt; if (p.t > p.d + 0.2) S.pops.splice(i, 1); else if (!p.fx && p.t >= p.d) { p.fx = 1; popFx(p); } }
    for (i = S.falls.length - 1; i >= 0; i--) {
      p = S.falls[i]; p.t += dt;
      if (p.t < p.d) continue;
      p.vy += 55 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.x < R) { p.x = R; p.vx = Math.abs(p.vx) * 0.5; } else if (p.x > W - R) { p.x = W - R; p.vx = -Math.abs(p.vx) * 0.5; }
      if (p.y > H + 2) S.falls.splice(i, 1);
    }
    for (i = S.texts.length - 1; i >= 0; i--) { p = S.texts[i]; p.t += dt; p.y -= dt * 2.2; if (p.t > (p.big ? 1.5 : 1)) S.texts.splice(i, 1); }
    for (i = S.rings.length - 1; i >= 0; i--) { p = S.rings[i]; p.t += dt; if (p.t > p.life) S.rings.splice(i, 1); }
    S.shake = Math.max(0, S.shake - dt * 2.6);
    S.yOffB *= Math.pow(0.0008, dt); if (Math.abs(S.yOffB) < 0.01) S.yOffB = 0;
    S.yOffC *= Math.pow(0.0008, dt); if (Math.abs(S.yOffC) < 0.01) S.yOffC = 0;
  }
  function popFx(p) {
    var col = bcol(p.b.c);
    burst(p.x, p.y, col, p.b.why === 'fire' ? 6 : 9, 8);
    if (p.b.p) popup(p.x, p.y - 1, PW_ICON[p.b.p], S.col.acc);
    S.snd.tone(520 + Math.min(p.i, 14) * 55, 0.07, 'sine', 0.035, 900 + Math.min(p.i, 14) * 60);
  }

  // ---- events from the engine ----
  function handleEvents() {
    var g = S.g, ev = g.ev, i, e, maxPop = 0;
    for (i = 0; i < ev.length; i++) {
      e = ev[i];
      switch (e.k) {
        case 'fire':
          S.snd.tone(e.s === 'fire' ? 220 : 480, 0.08, 'triangle', 0.04, e.s === 'fire' ? 440 : 760);
          S.recoil = 1;
          break;
        case 'bounce': S.snd.tone(980, 0.03, 'sine', 0.02); burst(e.x, e.y, S.col.muted, 3, 4); break;
        case 'land': S.snd.tone(210, 0.06, 'sine', 0.04, 140); S.land = { r: e.r, c: e.c, t: 0 }; break;
        case 'pop':
          var d = e.why === 'fire' ? 0 : e.why === 'bomb' ? 0.02 * e.i : 0.035 * e.i;
          maxPop = Math.max(maxPop, d);
          S.pops.push({ x: e.x, y: e.y, b: e, i: e.i, d: d, t: 0 });
          if (e.why === 'fire') { burst(e.x, e.y, '#ff8a2a', 5, 7); }
          break;
        case 'fall':
          S.falls.push({ x: e.x, y: e.y, vx: (Math.random() - 0.5) * 6, vy: -2 - Math.random() * 5, b: e, d: maxPop + 0.08 + e.i * 0.012, t: 0 });
          if (e.i === 0) S.snd.tone(380, 0.3, 'triangle', 0.035, 140, maxPop + 0.08);
          break;
        case 'score':
          popup(e.x, e.y, '+' + fmt(e.v), e.fall >= 4 ? S.col.acc : S.col.text, e.fall >= 4);
          if (e.fall >= 4) { popup(LX, 9, e.fall + ' DROPPED!', S.col.acc, true); }
          break;
        case 'streak':
          if (e.n >= 3) popup(LX, 13, 'COMBO x' + e.m.toFixed(e.m % 1 ? 2 : 0).replace(/0$/, ''), S.col.acc, true);
          break;
        case 'bomb':
          S.shake = S.rm ? 0.25 : 0.9;
          S.rings.push({ x: e.x, y: e.y, t: 0, life: 0.45, r: BOMB_R + 0.8, col: '#ff9d2e' });
          burst(e.x, e.y, '#ffb03a', 26, 16);
          S.snd.tone(110, 0.4, 'sawtooth', 0.07, 40); S.snd.tone(70, 0.45, 'square', 0.04, 30, 0.02);
          try { Cade.haptic && Cade.haptic(40); } catch (er) {}
          break;
        case 'fizzle': burst(e.x, e.y, '#ff8a2a', 10, 8); break;
        case 'thaw':
          burst(e.x, e.y, 'rgba(190,230,255,0.95)', 8, 7);
          S.snd.tone(1500, 0.05, 'square', 0.02, 1100);
          break;
        case 'drop':
          S.yOffB -= ROWH; S.yOffC -= ROWH; S.shake = Math.max(S.shake, S.rm ? 0.1 : 0.4);
          S.snd.tone(150, 0.22, 'square', 0.05, 80);
          popup(LX, DEAD_Y - 3, 'CEILING DROPS', S.col.red, true);
          live('The ceiling dropped a row');
          break;
        case 'push':
          S.yOffB -= ROWH; S.snd.tone(170, 0.12, 'triangle', 0.035, 110);
          break;
        case 'pw':
          if (e.full) popup(LX, 11, PW_ICON[e.p] + ' full +250', S.col.muted, true);
          else { popup(LX, 11, '+' + PW_ICON[e.p] + ' ' + PW_NAME[e.p].toUpperCase(), S.col.acc, true); S.flash = { p: e.p, t: 0 }; live('Got a ' + PW_NAME[e.p]); }
          S.snd.tone(660, 0.08, 'sine', 0.04); S.snd.tone(880, 0.08, 'sine', 0.04, 0, 0.07); S.snd.tone(1320, 0.12, 'sine', 0.04, 0, 0.14);
          break;
        case 'use': S.snd.tone(e.p === 'freeze' ? 1200 : 760, 0.1, 'sine', 0.035, e.p === 'freeze' ? 600 : 1100); break;
        case 'clear':
          popup(LX, 10, 'BOARD CLEAR +' + fmt(e.v), S.col.acc, true);
          S.snd.tone(523, 0.12, 'sine', 0.05); S.snd.tone(784, 0.18, 'sine', 0.05, 0, 0.1);
          break;
        case 'won':
          S.snd.tone(523, 0.12, 'sine', 0.05); S.snd.tone(659, 0.12, 'sine', 0.05, 0, 0.1); S.snd.tone(784, 0.12, 'sine', 0.05, 0, 0.2); S.snd.tone(1047, 0.3, 'sine', 0.05, 0, 0.3);
          popup(LX, 11, 'STAGE CLEAR', S.col.acc, true);
          break;
        case 'lost':
          S.shake = S.rm ? 0.2 : 0.7;
          S.snd.tone(330, 0.25, 'triangle', 0.05, 220); S.snd.tone(220, 0.4, 'triangle', 0.05, 110, 0.22);
          break;
      }
    }
    ev.length = 0;
  }

  // ---- drawing ----
  function U() { return S.sc * S.k; }
  function setT() { var u = U(), sh = S.shake; S.shx = sh ? (Math.random() - 0.5) * sh : 0; S.shy = sh ? (Math.random() - 0.5) * sh : 0; S.ctx.setTransform(u, 0, 0, u, S.shx * u, S.shy * u); }
  function wtext(str, x, y, size, color, align, weight, alpha, outline) {
    var c = S.ctx, u = U();
    c.save(); c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = alpha == null ? 1 : Math.max(0, alpha);
    c.font = (weight || 700) + ' ' + Math.max(8, Math.round(size * u)) + 'px ' + S.col.font;
    c.textAlign = align || 'center'; c.textBaseline = 'middle';
    var px = (x + S.shx) * u, py = (y + S.shy) * u;
    if (outline) { c.lineJoin = 'round'; c.lineWidth = Math.max(2, 0.28 * u); c.strokeStyle = S.col.bg; c.strokeText(str, px, py); }
    c.fillStyle = color; c.fillText(str, px, py);
    c.restore();
  }
  function draw() {
    if (!S || !S.ctx || !S.col || !S.spr) return;
    var c = S.ctx, g = S.g, t = S.animT;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, S.cv.width, S.cv.height);
    setT();
    // field
    var gr = c.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, S.col.field1); gr.addColorStop(1, S.col.field2);
    c.fillStyle = gr; c.fillRect(-1, -1, W + 2, H + 2);
    if (!g) return;
    var ceilY = Math.max(CEIL0, ceilOf(g) + S.yOffC);
    // deadline
    var dz = danger(g), warn = dz ? 0.55 + 0.45 * Math.sin(t * 8) : 0;
    c.save();
    c.setLineDash([0.5, 0.4]); c.lineWidth = 0.1;
    c.strokeStyle = dz ? css(S.col.redA, 0.5 + warn * 0.5) : css(S.col.redA, 0.35);
    c.beginPath(); c.moveTo(0, DEAD_Y); c.lineTo(W, DEAD_Y); c.stroke();
    c.restore();
    if (dz) { c.fillStyle = css(S.col.redA, 0.06 + warn * 0.06); c.fillRect(0, DEAD_Y, W, H - DEAD_Y); }
    // bubbles (clipped below the ceiling so pushed rows slide out from behind it)
    c.save();
    c.beginPath(); c.rect(-1, ceilY, W + 2, H); c.clip();
    var yo = S.yOffB, wob = g.mode === 'stages' && g.missLeft === 1 && g.freeze <= 0 && g.phase === 'aim' ? 0.06 : 0;
    for (var r = 0; r < g.grid.length; r++) {
      var row = g.grid[r], y = cellY(g, r) + yo;
      for (var ci = 0; ci < row.length; ci++) {
        var b = row[ci];
        if (!b) continue;
        var x = cellX(g, r, ci), sc = 1;
        if (S.land && S.land.r === r && S.land.c === ci) sc = 1 + 0.12 * Math.max(0, 1 - S.land.t / 0.15) * Math.sin(S.land.t * 30);
        if (wob) x += Math.sin(t * 34 + r * 1.7 + ci) * wob;
        if (b.p) { c.beginPath(); c.arc(x, y, 1.05 + Math.sin(t * 5) * 0.06, 0, TAU); c.strokeStyle = css(S.col.accA, 0.45); c.lineWidth = 0.1; c.stroke(); }
        drawBubble(b, x, y, sc);
      }
    }
    // popping bubbles
    for (var i = 0; i < S.pops.length; i++) {
      var p = S.pops[i];
      if (p.t < p.d) drawBubble(p.b, p.x, p.y + yo, 1);
      else { var k = (p.t - p.d) / 0.2; drawBubble(p.b, p.x, p.y + yo, 1 + k * 0.5, 1 - k); }
    }
    c.restore();
    // ceiling
    c.fillStyle = S.col.ceil; c.fillRect(-1, -1, W + 2, ceilY + 1);
    if (ceilY > CEIL0 + 0.2) {
      c.save(); c.beginPath(); c.rect(0, 0, W, ceilY); c.clip();
      c.strokeStyle = S.col.hatch; c.lineWidth = 0.12;
      c.beginPath();
      for (var hx = -ceilY; hx < W; hx += 1.1) { c.moveTo(hx, ceilY); c.lineTo(hx + ceilY, 0); }
      c.stroke(); c.restore();
    }
    c.fillStyle = S.col.ceilLine; c.fillRect(-1, ceilY - 0.16, W + 2, 0.16);
    if (ceilY > CEIL0 + 0.5) for (var rv = 1; rv < W; rv += 3) { c.beginPath(); c.arc(rv, ceilY - 0.42, 0.1, 0, TAU); c.fillStyle = S.col.ceilLine; c.fill(); }
    // aim guide
    if (g.phase === 'aim' && !S.preview) drawGuide(g);
    // the shot in flight
    if (g.shot) {
      var s = g.shot, ang = Math.atan2(s.vy, s.vx);
      for (var tr = 1; tr <= 4; tr++) {
        c.beginPath(); c.arc(s.x - Math.cos(ang) * tr * 0.55, s.y - Math.sin(ang) * tr * 0.55, 0.8 - tr * 0.15, 0, TAU);
        c.fillStyle = s.k === 'fire' ? 'rgba(255,140,40,' + (0.4 - tr * 0.08) + ')' : css(S.col.tx, 0.08 - tr * 0.015); c.fill();
      }
      if (s.k === 'fire' && Math.random() < 0.9) part(s.x, s.y, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, 0.3, Math.random() < 0.5 ? '#ffb03a' : '#ff5a1a', 0.25, -4);
      drawBubble({ t: 'n', k: s.k, c: s.c }, s.x, s.y, 1);
    }
    // falling clusters
    for (i = 0; i < S.falls.length; i++) { var f = S.falls[i]; drawBubble(f.b, f.x, f.y + (f.t < f.d ? yo : 0), 1, f.y > H - 2 ? (H + 2 - f.y) / 4 : 1); }
    // launcher
    drawLauncher(g);
    // particles, rings, popups
    for (i = 0; i < S.parts.length; i++) {
      var q = S.parts[i], a = 1 - q.t / q.life;
      c.globalAlpha = a; c.fillStyle = q.col;
      c.beginPath(); c.arc(q.x, q.y, q.sz * (0.5 + a * 0.5), 0, TAU); c.fill();
    }
    c.globalAlpha = 1;
    for (i = 0; i < S.rings.length; i++) {
      var rg = S.rings[i], kk = rg.t / rg.life;
      c.beginPath(); c.arc(rg.x, rg.y, rg.r * (0.3 + kk * 0.9), 0, TAU); c.lineWidth = 0.35 * (1 - kk); c.strokeStyle = rg.col; c.globalAlpha = 1 - kk; c.stroke();
    }
    c.globalAlpha = 1;
    for (i = 0; i < S.texts.length; i++) {
      var tx = S.texts[i], life = tx.big ? 1.5 : 1, al = tx.t < life - 0.3 ? 1 : (life - tx.t) / 0.3;
      wtext(tx.s, clamp(tx.x, 3, W - 3), tx.y, tx.big ? 1.25 : 0.95, tx.col, 'center', 800, al, true);
    }
    // a short status by the launcher
    if (!S.preview) {
      var st = [];
      if (g.sight > 0 && !g.tutorial && !g.assist) st.push('🎯' + g.sight);
      if (g.freeze > 0) st.push('❄️' + g.freeze);
      if (st.length) wtext(st.join('  '), W - 0.6, NY + 0.2, 0.9, S.col.muted, 'right', 700);
      if (g.tutorial && g.shots < 3 && g.phase === 'aim') wtext(S.coarse ? 'drag to aim · let go to shoot' : 'aim with the mouse · click to shoot', LX, DEAD_Y - 1.1, 0.8, S.col.muted, 'center', 600, 0.6 + 0.4 * Math.sin(t * 3), true);
    }
  }
  function drawGuide(g) {
    var c = S.ctx, mode = guideMode(g), tr = trace(g, S.aim, mode === 'full' ? 220 : STUB_LEN);
    var pts = tr.pts, col = css(S.col.tx, S.dark ? 0.55 : 0.45);
    if (g.cur.k === 'n') col = css(mix(S.bub[g.cur.c] || S.col.tx, S.col.tx, 0.25), 0.75);
    // dots along the path
    var gap = 0.75, off = (S.animT * 2.4) % gap, acc = 0;
    c.fillStyle = col;
    for (var i = 0; i < pts.length - 1; i++) {
      var ax = pts[i][0], ay = pts[i][1], bx = pts[i + 1][0], by = pts[i + 1][1], dx = bx - ax, dy = by - ay, L = Math.sqrt(dx * dx + dy * dy);
      if (L < 1e-6) continue;
      var d0 = (gap - ((acc - off) % gap + gap) % gap) % gap;
      for (var d = d0; d < L; d += gap) {
        var tot = acc + d, fade = mode === 'stub' ? Math.max(0, 1 - Math.max(0, tot - 3.1) / (STUB_LEN - 3.1) * 0.85) : 1;
        if (tot < 3.1) continue;
        c.globalAlpha = fade;
        c.beginPath(); c.arc(ax + dx * d / L, ay + dy * d / L, 0.15, 0, TAU); c.fill();
      }
      acc += L;
    }
    c.globalAlpha = 1;
    if (mode === 'full' && tr.cell && g.cur.k !== 'fire') {
      var x = cellX(g, tr.cell.r, tr.cell.c), y = cellY(g, tr.cell.r) + S.yOffB;
      c.save(); c.setLineDash([0.3, 0.25]); c.lineWidth = 0.1; c.strokeStyle = col;
      c.beginPath(); c.arc(x, y, g.cur.k === 'bomb' ? BOMB_R : 0.92, 0, TAU); c.stroke(); c.restore();
    }
  }
  function drawLauncher(g) {
    var c = S.ctx, ang = S.aim, rc = S.recoil || 0;
    // base
    c.beginPath(); c.arc(LX, LY + 0.9, 2.3, PI, 0); c.closePath();
    c.fillStyle = S.col.base; c.fill(); c.lineWidth = 0.1; c.strokeStyle = S.col.baseEdge; c.stroke();
    // barrel
    var bl = 2.7 - rc * 0.5, ex = LX + Math.cos(ang) * bl, ey = LY + Math.sin(ang) * bl;
    c.lineCap = 'round';
    c.beginPath(); c.moveTo(LX, LY); c.lineTo(ex, ey); c.lineWidth = 0.55; c.strokeStyle = S.col.baseEdge; c.stroke();
    c.beginPath(); c.moveTo(LX, LY); c.lineTo(ex, ey); c.lineWidth = 0.3; c.strokeStyle = S.col.acc; c.stroke();
    c.lineCap = 'butt';
    // arrowhead
    c.beginPath();
    c.moveTo(ex + Math.cos(ang) * 0.55, ey + Math.sin(ang) * 0.55);
    c.lineTo(ex + Math.cos(ang + 2.4) * 0.5, ey + Math.sin(ang + 2.4) * 0.5);
    c.lineTo(ex + Math.cos(ang - 2.4) * 0.5, ey + Math.sin(ang - 2.4) * 0.5);
    c.closePath(); c.fillStyle = S.col.acc; c.fill();
    if (S.preview) return;
    // loaded bubble and the next one
    if (g.phase === 'aim' || g.phase === 'fly') {
      var pulse = g.cur.k !== 'n' ? 1 + Math.sin(S.animT * 8) * 0.05 : 1;
      if (g.cur.k !== 'n') { c.beginPath(); c.arc(LX, LY, 1.25, 0, TAU); c.strokeStyle = css(S.col.accA, 0.5 + Math.sin(S.animT * 8) * 0.3); c.lineWidth = 0.15; c.stroke(); }
      drawBubble({ t: 'n', k: g.cur.k, c: g.cur.c }, LX, LY, pulse);
    }
    var nb = g.stash ? g.stash : g.next;
    c.beginPath(); c.arc(NX, NY, 1.05, 0, TAU); c.fillStyle = S.col.base; c.fill(); c.lineWidth = 0.08; c.strokeStyle = S.col.baseEdge; c.stroke();
    drawBubble({ t: 'n', k: nb.k, c: nb.c }, NX, NY, 0.72, g.stash ? 0.55 : 1);
    wtext(g.stash ? 'held' : 'next', NX - 1.6, NY + 0.1, 0.62, S.col.faint, 'right', 700);
    if (!g.stash) {
      c.save(); c.strokeStyle = S.col.faint; c.lineWidth = 0.1;
      c.beginPath(); c.arc((NX + LX) / 2 - 0.25, NY - 0.2, 1.2, PI * 1.15, PI * 1.85); c.stroke();
      var ax2 = (NX + LX) / 2 - 0.25 + Math.cos(PI * 1.85) * 1.2, ay2 = NY - 0.2 + Math.sin(PI * 1.85) * 1.2;
      c.beginPath(); c.moveTo(ax2, ay2); c.lineTo(ax2 - 0.4, ay2 - 0.05); c.moveTo(ax2, ay2); c.lineTo(ax2 - 0.05, ay2 + 0.4); c.stroke();
      c.restore();
    }
  }

  // ---- HUD / pad / cards ----
  function stageLabel(g) { return g.mode === 'stages' ? 'STAGE ' + g.stage : 'ENDLESS · LV ' + (1 + Math.floor(g.pushed / 12)); }
  function syncHud() {
    var g = S.g;
    if (!g || S.preview) { if (S.hudKey !== '') { S.hud.innerHTML = ''; S.hudKey = ''; } S.hud.classList.add('off'); return; }
    S.hud.classList.remove('off');
    var mul = comboMul(g.streak), pr;
    if (g.mode === 'stages') pr = g.freeze > 0 ? '❄️ frozen' : '▼ drop in <b' + (g.missLeft <= 1 ? ' class="hot"' : '') + '>' + g.missLeft + '</b>';
    else pr = g.freeze > 0 ? '❄️ frozen' : '▼ row in <b' + (g.pushLeft <= 2 ? ' class="hot"' : '') + '>' + Math.ceil(g.pushLeft / 1) + '</b>';
    var h = '<span class="bb-s"><b>' + fmt(g.score) + '</b></span><span class="bb-lv">' + stageLabel(g) + (g.assist ? ' <i>assist</i>' : '') + '</span>' +
      '<span class="bb-x' + (mul > 1 ? ' on' : '') + '">x' + (mul % 1 ? mul.toFixed(2).replace(/0$/, '') : mul) + '</span><span class="bb-pr">' + pr + '</span>';
    if (h !== S.hudKey) { S.hud.innerHTML = h; S.hudKey = h; }
  }
  function syncPad() {
    var g = S.g, h = '';
    if (!g || S.preview) h = '';
    else if (S.picking) {
      var cs = presentColors(g);
      if (!cs.length) cs = [0, 1, 2];
      h = '<div class="bb-pick"><span class="bb-pl">Paint</span>' + cs.map(function (ci, i) {
        return '<button type="button" class="bb-sw" data-col="' + ci + '" style="--sw:' + css(S.bub[ci]) + '" aria-label="Paint ' + COL_NAME[ci] + ' (' + (i + 1) + ')"><span>' + (S.save.glyphs ? GLYPH_CH[ci] : '') + '</span></button>';
      }).join('') + '<button type="button" class="bb-pb bb-cancel" data-act="pick-cancel" aria-label="Cancel">✕</button></div>';
    } else {
      var armed = g.stash ? g.cur.k : null, can = g.phase === 'aim';
      h = '<div class="bb-inv">' + PWS.map(function (p, i) {
        var n = g.inv[p], on = armed === p || (p === 'sight' && g.sight > 0 && !g.tutorial) || (p === 'freeze' && g.freeze > 0);
        return '<button type="button" class="bb-pb' + (on ? ' on' : '') + (n ? '' : ' none') + (S.flash && S.flash.p === p && S.flash.t < 0.8 ? ' new' : '') +
          '" data-pw="' + p + '"' + ((n || armed === p) && can ? '' : ' disabled') + ' title="' + PW_NAME[p] + ' (' + (i + 1) + ') — ' + PW_DESC[p] + '" aria-label="' + PW_NAME[p] + ', ' + n + ' left">' +
          '<span class="ic">' + PW_ICON[p] + '</span><b>' + n + '</b></button>';
      }).join('') + '<button type="button" class="bb-pb bb-swap" data-act="swap"' + (can && !g.stash ? '' : ' disabled') + ' title="Swap with next (X / ↓)" aria-label="Swap with next">' + IC_SWAP + '</button></div>';
    }
    if (h !== S.padKey) { S.pad.innerHTML = h; S.padKey = h; }
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
  function live(t) { if (S && S.liveEl) S.liveEl.textContent = t; }
  function starStr(n) { return n ? '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n) : '☆☆☆'; }
  var ART = '  o  .  O    .  o\n .  O  (o)  o  .\n(O)(o)(O)(o)(O)(o)';

  function menuHtml() {
    var sv = S.save, pg = sv.prog[sv.diff], h = '<div class="bb-card bb-menu">';
    h += '<pre class="bb-art" aria-hidden="true">' + ART + '</pre>';
    h += '<div class="bb-top"><span class="bb-brand">BUBBLE BURST</span><span class="bb-meta">' + DIFFS[sv.diff].name + '</span></div>';
    if (S.resume) {
      var o = S.resume;
      h += '<button type="button" class="bb-resume" data-act="resume-run"><b>Resume run</b><span>' + esc(o.mode === 'stages' ? 'Stage ' + o.stage : 'Endless') + ' · ' + DIFFS[o.diff].name + ' · ' + fmt(o.score) + ' pts</span></button>';
    }
    h += '<div class="bb-tabs" role="tablist">' + ['stages', 'endless'].map(function (m) {
      return '<button type="button" role="tab" data-mode="' + m + '" aria-selected="' + (sv.mode === m) + '" class="' + (sv.mode === m ? 'on' : '') + '">' + (m === 'stages' ? 'Stages' : 'Endless') + '</button>';
    }).join('') + '</div>';
    if (sv.mode === 'stages') {
      var per = 20, pages = Math.max(1, Math.ceil((pg.un + 1) / per)), page = clamp(sv.page, 0, pages - 1), totStars = 0;
      for (var k in pg.st) totStars += pg.st[k] | 0;
      h += '<div class="bb-sec"><div class="bb-h">Stage <i>' + totStars + ' ★ · ' + (pg.un - 1) + ' cleared</i></div><div class="bb-grid">';
      for (var i = page * per + 1; i <= page * per + per; i++) {
        var lock = i > pg.un, st = pg.st[i] | 0;
        h += '<button type="button" class="bb-st' + (i === sv.sel ? ' on' : '') + (lock ? ' lock' : '') + '" data-stage="' + i + '"' + (lock ? ' disabled' : '') + ' aria-label="Stage ' + i + (lock ? ' (locked)' : st ? ', ' + st + ' stars' : '') + '">' +
          '<b>' + i + '</b><i>' + (lock ? '·' : starStr(st)) + '</i></button>';
      }
      h += '</div>';
      if (pages > 1) h += '<div class="bb-pager"><button type="button" class="bb-sq" data-act="pg-prev"' + (page ? '' : ' disabled') + ' aria-label="Previous stages">&lt;</button><span>' + (page * per + 1) + '–' + (page * per + per) + '</span><button type="button" class="bb-sq" data-act="pg-next"' + (page < pages - 1 ? '' : ' disabled') + ' aria-label="More stages">&gt;</button></div>';
      var inf = stageInfo(sv.sel, sv.diff), best = pg.hs[sv.sel] | 0;
      h += '<div class="bb-note">' + inf.colors + ' colors · ' + inf.miss + ' misses per drop' + (inf.stones ? ' · stones' : '') + (inf.ice ? ' · ice' : '') + (inf.locks ? ' · locks' : '') + (best ? ' · best ' + fmt(best) : '') + '</div></div>';
    } else {
      h += '<div class="bb-sec"><p>Rows push in from the top — faster as you go, with more colors, stones and ice. Clear the board for a big bonus.</p>' +
        '<pre class="bb-tab">' + DIFFS.map(function (d, i) { var b = fmt(sv.eBest[i]); return d.name + new Array(Math.max(1, 22 - d.name.length - b.length) + 1).join(' ') + '<b>' + b + '</b>'; }).join('\n') + '</pre></div>';
    }
    h += '<div class="bb-sec"><div class="bb-h">Difficulty</div><div class="bb-chips">' + DIFFS.map(function (d, i) {
      return '<button type="button" class="bb-chip' + (sv.diff === i ? ' on' : '') + '" data-diff="' + i + '" aria-pressed="' + (sv.diff === i) + '">' + d.name + '</button>';
    }).join('') + '</div></div>';
    h += '<div class="bb-sec"><div class="bb-h">Options</div><div class="bb-chips">' +
      '<button type="button" class="bb-chip' + (sv.glyphs ? ' on' : '') + '" data-act="glyphs" aria-pressed="' + sv.glyphs + '">Color glyphs <i>' + (sv.glyphs ? 'on' : 'off') + '</i></button>' +
      '<button type="button" class="bb-chip' + (sv.assist ? ' on' : '') + '" data-act="assist" aria-pressed="' + sv.assist + '">Assist guide <i>' + (sv.assist ? 'on · ½ score' : 'off') + '</i></button></div></div>';
    h += '<button type="button" class="bb-go" data-act="play">LET’S PLAY' + (sv.mode === 'stages' ? ' — STAGE ' + sv.sel : ' — ENDLESS') + '</button>';
    h += '<div class="bb-foot"><button type="button" class="bb-lnk" data-act="help">How to play</button>' +
      (S.resetArm ? '<span><span class="bb-confirm">Erase progress?</span> <button type="button" class="bb-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="bb-lnk" data-act="reset-no">Keep</button></span>' :
        '<button type="button" class="bb-lnk" data-act="reset">Reset progress</button>') + '</div>';
    return h + '</div>';
  }
  function helpHtml(first) {
    var keys = S.coarse ?
      '<div><b>touch &amp; drag</b> &nbsp;to aim, <b>let go</b> to shoot</div><div><b>drag down</b> below the launcher to cancel</div><div><b>tap next</b> &nbsp;or ⇄ to swap bubbles</div>' :
      '<div><b>mouse</b> &nbsp;aims, <b>click</b> shoots &nbsp; <b>← →</b> aim (Shift: fine)</div><div><b>Space / Enter</b> &nbsp;shoot &nbsp; <b>↑</b> straight up &nbsp; <b>X / ↓</b> swap</div><div><b>1–6</b> &nbsp;powerups &nbsp; <b>P / Esc</b> &nbsp;pause</div>';
    return '<div class="bb-card bb-help">' +
      '<pre class="bb-art" aria-hidden="true">' + ART + '</pre>' +
      '<div class="bb-title">BUBBLE BURST</div>' +
      '<p>Shoot bubbles into the pile. Land next to <b>2 or more of the same color</b> to pop them; anything left hanging from nothing <b>falls</b> for a big bonus. Bank shots off the walls.</p>' +
      '<p>Every shot that pops nothing counts down to a <b>ceiling drop</b> (in Endless, new rows push in). If a bubble crosses the red line, it’s over. Pop on consecutive shots for a <b>combo</b> multiplier.</p>' +
      '<div class="bb-keys">' + keys + '</div>' +
      '<div class="bb-keys bb-legend">' + PWS.map(function (p) { return '<div><b>' + PW_ICON[p] + ' ' + PW_NAME[p] + '</b> &nbsp;<span>' + PW_DESC[p] + '</span></div>'; }).join('') +
      '<div class="bb-sub2">Pop bubbles wearing a badge, chain 5 shots, or drop 8+ at once to earn powerups. Tap one to use it.</div></div>' +
      '<div class="bb-keys bb-legend"><div><b>stone</b> &nbsp;<span>never matches — only falls</span></div><div><b>ice</b> &nbsp;<span>one hit or a pop next to it thaws it</span></div><div><b>locked</b> &nbsp;<span>needs two</span></div></div>' +
      '<p class="bb-tip">The full aiming guide is a stage 1 treat — after that you get a short stub unless you use <b>🎯 Sight</b> or turn on <b>Assist</b> (half score).</p>' +
      (first ? '<button type="button" class="bb-go" data-act="first-play">LET’S PLAY</button>' : '<button type="button" class="bb-go alt" data-act="close-help">Back</button>') + '</div>';
  }
  function pauseHtml() {
    var g = S.g;
    return '<div class="bb-card bb-pause"><div class="bb-title">PAUSED</div>' +
      '<div class="bb-big">' + fmt(g.score) + '</div><div class="bb-sub">' + stageLabel(g) + ' · ' + DIFFS[g.diff].name + ' · ' + g.shots + ' shots</div>' +
      '<div class="bb-chips bb-center"><button type="button" class="bb-chip' + (S.save.glyphs ? ' on' : '') + '" data-act="glyphs">Color glyphs <i>' + (S.save.glyphs ? 'on' : 'off') + '</i></button></div>' +
      '<button type="button" class="bb-go" data-act="resume">RESUME</button>' +
      '<div class="bb-btns"><button type="button" class="bb-go alt" data-act="restart">Restart</button><button type="button" class="bb-go alt" data-act="menu">Menu</button></div>' +
      '<div class="bb-note">Your run is saved — Menu keeps it to resume later.</div></div>';
  }
  function endHtml() {
    var g = S.g, r = S.result || {}, h = '<div class="bb-card bb-end">';
    if (g.phase === 'won') {
      h += '<div class="bb-title">STAGE ' + g.stage + ' CLEAR</div><div class="bb-stars">' + starStr(g.stars) + '</div>' +
        '<div class="bb-big">' + fmt(g.score) + '</div>' + (r.newBest ? '<div class="bb-new">NEW STAGE BEST</div>' : '') +
        '<pre class="bb-tab">' + [['Shots', g.shots + ' (par ' + g.parShots + ')'], ['Popped', String(g.popped)], ['Dropped', String(g.fell)], ['Best combo', 'x' + comboMul(g.bestStreak)], ['Clear bonus', '+' + fmt(g.bonus)]].map(function (q) {
          return esc(q[0]) + new Array(Math.max(1, 24 - q[0].length - q[1].length) + 1).join(' ') + '<b>' + esc(q[1]) + '</b>';
        }).join('\n') + '</pre>' +
        '<button type="button" class="bb-go" data-act="next">NEXT — STAGE ' + (g.stage + 1) + '</button>' +
        '<div class="bb-btns"><button type="button" class="bb-go alt" data-act="restart">Retry</button><button type="button" class="bb-go alt" data-act="menu">Menu</button></div>';
    } else {
      h += '<pre class="bb-art" aria-hidden="true">  _______\n (o)(O)(o)\n--------- !</pre><div class="bb-title">' + (g.mode === 'stages' ? 'CRUSHED' : 'GAME OVER') + '</div>' +
        '<div class="bb-big">' + fmt(g.score) + '</div>' + (r.newBest ? '<div class="bb-new">NEW HIGH SCORE</div>' : (r.best ? '<div class="bb-note">best ' + fmt(r.best) + '</div>' : '')) +
        '<div class="bb-sub">' + stageLabel(g) + ' · ' + g.shots + ' shots · ' + g.popped + ' popped · ' + g.fell + ' dropped</div>' +
        '<button type="button" class="bb-go" data-act="restart">TRY AGAIN</button><div class="bb-btns"><button type="button" class="bb-go alt" data-act="menu">Menu</button></div>';
    }
    return h + '</div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'menu' ? menuHtml() : kind === 'help' ? helpHtml(S.firstRun) : kind === 'pause' ? pauseHtml() : kind === 'end' ? endHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stageEl.classList.toggle('dim', !!kind);
    if (kind) S.ovl.scrollTop = 0;
  }

  // ---- flow ----
  function previewGame() {
    var g = newGame({ mode: 'endless', diff: S.save.diff, seed: 12345 });
    for (var i = 0; i < 2; i++) pushRow(g, true);
    g.ev.length = 0;
    return g;
  }
  function toMenu() {
    stopLoop();
    if (S.g && !S.preview && S.phase === 'play') saveRun();
    S.phase = 'menu'; S.paused = false; S.picking = false; S.resetArm = false; S.ptr = null;
    S.resume = loadRun();
    S.g = previewGame(); S.preview = true; S.aim = -PI / 2;
    clearFx(); syncHud(); syncPad();
    showCard('menu'); syncHead();
    draw();
  }
  function startGame(o) {
    S.snd.ensure();
    if (o && o.v) S.g = o;
    else {
      var sv = S.save;
      S.g = newGame({ mode: sv.mode, stage: sv.sel, diff: sv.diff, assist: sv.assist });
      sv.games++; persist();
    }
    S.preview = false; S.phase = 'play'; S.paused = false; S.picking = false; S.endT = 0; S.result = null; S.aim = -PI / 2;
    clearFx();
    saveRun();
    showCard(null); syncHud(); syncPad(); syncHead();
    if (S.g.mode === 'stages') live('Stage ' + S.g.stage + '. ' + S.g.nColors + ' colors.');
    else live('Endless');
    kick();
  }
  function pause() {
    if (!S || S.phase !== 'play' || S.paused) return;
    S.paused = true; S.ptr = null; S.keys = {};
    stopLoop(); saveRun();
    showCard('pause'); syncHead(); draw();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null); syncHead(); kick();
  }
  function endRun() {
    stopLoop();
    var g = S.g, sv = S.save, pg = sv.prog[g.diff], r = { newBest: false, best: 0 };
    sdel(RUN_KEY);
    if (g.mode === 'stages') {
      var prev = pg.hs[g.stage] | 0;
      if (g.phase === 'won') {
        pg.un = Math.max(pg.un, g.stage + 1);
        pg.st[g.stage] = Math.max(pg.st[g.stage] | 0, g.stars);
        if (!g.assist && g.score > prev) { pg.hs[g.stage] = g.score; r.newBest = prev > 0; }
        sv.sel = g.stage + 1; sv.page = Math.floor((sv.sel - 1) / 20);
      }
      r.best = pg.hs[g.stage] | 0;
    } else {
      r.best = sv.eBest[g.diff];
      if (!g.assist && g.score > r.best) { r.newBest = true; sv.eBest[g.diff] = g.score; }
      sv.eRows[g.diff] = Math.max(sv.eRows[g.diff], g.pushed);
    }
    persist();
    S.result = r; S.phase = 'end';
    showCard('end'); syncHead(); syncPad();
    live(g.phase === 'won' ? 'Stage clear! ' + g.stars + ' stars, ' + g.score + ' points' : 'Game over, ' + g.score + ' points');
    draw();
  }

  // ---- loop ----
  function running() { return !!S && (S.phase === 'play' || S.phase === 'ending') && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0, g = S.g;
    S.last = ts; S.animT += dt;
    keyAim(dt);
    var was = g.phase;
    S.acc = Math.min((S.acc || 0) + dt, 0.25);
    while (S.acc >= STEP) { step(g, STEP); S.acc -= STEP; }
    handleEvents();
    stepFx(dt);
    if (S.land) { S.land.t += dt; if (S.land.t > 0.3) S.land = null; }
    if (S.flash) { S.flash.t += dt; if (S.flash.t > 0.8) S.flash = null; }
    S.recoil = Math.max(0, (S.recoil || 0) - dt * 6);
    if (was === 'fly' && g.phase === 'aim') saveRun();
    if ((g.phase === 'won' || g.phase === 'lost') && S.phase === 'play') { S.phase = 'ending'; S.endT = 0; S.picking = false; }
    syncHud(); syncPad();
    draw();
    if (S.phase === 'ending') {
      S.endT += dt;
      if (S.endT > 1.4) { endRun(); return; }
    }
    S.raf = requestAnimationFrame(frame);
  }

  // ---- input ----
  function canAim() { return S && S.phase === 'play' && !S.paused && S.g && (S.g.phase === 'aim' || S.g.phase === 'fly'); }
  function doFire() {
    if (!canAim() || S.picking || S.g.phase !== 'aim') return;
    S.snd.ensure();
    fire(S.g, S.aim);
  }
  function doSwap() {
    if (!canAim() || S.picking) return;
    if (swap(S.g)) S.snd.tone(700, 0.05, 'sine', 0.03, 520);
  }
  function doItem(p) {
    if (!canAim() || S.g.phase !== 'aim') return;
    S.snd.ensure();
    var r = useItem(S.g, p);
    if (r === 'pick') { S.picking = true; }
    else if (r === 'disarmed') S.snd.tone(400, 0.05, 'sine', 0.03);
    else if (!r) S.snd.tone(160, 0.06, 'square', 0.02);
    syncPad();
  }
  function doPaint(ci) {
    if (!S.picking) return;
    if (paint(S.g, ci)) S.picking = false;
    syncPad();
  }
  function keyAim(dt) {
    var k = S.keys, l = k.ArrowLeft || k.KeyA, r = k.ArrowRight || k.KeyD;
    if (!canAim() || (!l && !r)) { S.aimHeld = 0; return; }
    S.aimHeld = (S.aimHeld || 0) + dt;
    var fine = k.ShiftLeft || k.ShiftRight, rate = (fine ? 0.22 : 1.25) * Math.min(1, 0.35 + S.aimHeld * 1.6);
    S.aim = clampAng(S.aim + (r ? 1 : -1) * rate * dt);
  }
  var KEY2CODE = { ' ': 'Space', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', enter: 'Enter', escape: 'Escape', p: 'KeyP', x: 'KeyX', a: 'KeyA', d: 'KeyD', shift: 'ShiftLeft' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
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
      if (S.picking) { S.picking = false; syncPad(); }
      else if (S.phase === 'play' && !S.paused) pause();
      else if (S.paused && S.cardKind === 'pause') resume();
      else if (S.cardKind === 'help' && !S.firstRun) toMenuOrBack();
      else if (S.phase === 'end') toMenu();
      else if (S.phase === 'menu') closePanel();
      return;
    }
    if (code === 'KeyP' && S.phase === 'play') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
    if (S.phase === 'play' && !S.paused) {
      if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'KeyA' || code === 'KeyD') { e.preventDefault(); S.keys[code] = true; return; }
      if (code === 'ArrowUp' || code === 'KeyW') { e.preventDefault(); S.aim = -PI / 2; return; }
      if (code === 'ArrowDown' || code === 'KeyX' || code === 'KeyS') { e.preventDefault(); if (!e.repeat) doSwap(); return; }
      if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') { e.preventDefault(); if (!e.repeat) doFire(); return; }
      var dg = /^(Digit|Numpad)([1-9])$/.exec(code);
      if (dg) {
        e.preventDefault();
        var n = +dg[2];
        if (S.picking) { var cs = presentColors(S.g); if (!cs.length) cs = [0, 1, 2]; if (n <= cs.length) doPaint(cs[n - 1]); }
        else if (n <= PWS.length) doItem(PWS[n - 1]);
      }
      return;
    }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (e.repeat) return;
      if (S.paused) resume();
      else if (S.cardKind === 'help') { if (S.firstRun) firstPlay(); else toMenuOrBack(); }
      else if (S.phase === 'menu') startGame(null);
      else if (S.phase === 'end') { if (S.g.phase === 'won') nextStage(); else restart(); }
    }
  }
  function onKeyUp(e) { if (!S) return; var code = keyCode(e); if (S.keys[code]) delete S.keys[code]; }
  function toMenuOrBack() { if (S.paused) showCard('pause'); else if (S.phase === 'menu') showCard('menu'); else if (S.phase === 'end') showCard('end'); }
  function firstPlay() { S.firstRun = false; S.save.mode = 'stages'; S.save.sel = 1; persist(); startGame(null); }
  function restart() {
    var g = S.g;
    if (!g) return;
    sdel(RUN_KEY);
    S.save.mode = g.mode; S.save.sel = g.stage; S.save.diff = g.diff;
    S.g = newGame({ mode: g.mode, stage: g.stage, diff: g.diff, assist: g.assist });
    startGame(S.g);
  }
  function nextStage() {
    var g = S.g;
    S.save.mode = 'stages'; S.save.sel = g.stage + 1; persist();
    S.g = newGame({ mode: 'stages', stage: g.stage + 1, diff: g.diff, assist: g.assist });
    startGame(S.g);
  }

  // ---- layout ----
  function chromeH() {
    var r = S.panel.getBoundingClientRect(), bd = S.panel.querySelector('.cade-panel-body');
    if (!r.height || !bd) return 0;
    return (r.height - bd.clientHeight) + bd.scrollHeight - (S.stageEl.offsetHeight || 0);
  }
  function availH(vw, vh, chrome) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height || !chrome) return vh - 200;
    var room = vh - Math.min(Math.max(0, r.top), 140), mx = getComputedStyle(S.panel).maxHeight, mh = /px$/.test(mx) ? parseFloat(mx) : 0;
    if (mh > 0) room = Math.min(room, mh);
    return room - chrome - 6;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.width && vv.scale <= 1.01) vw = Math.min(vw, vv.width);
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var maxW = Math.min(vw - (phone ? (solo ? 20 : 30) : 48), solo ? 640 : 500);
    var ch = chromeH(), ah = Math.max(220, availH(vw, vh, ch));
    var sc = Math.max(8, Math.min(maxW / W, ah / H));
    var cw = Math.floor(W * sc), chh = Math.floor(H * sc);
    var dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    S.cv.style.width = cw + 'px'; S.cv.style.height = chh + 'px';
    S.stageEl.style.width = cw + 'px'; S.stageEl.style.height = chh + 'px';
    S.panel.style.setProperty('--bb-w', Math.max(cw, phone ? 0 : 300) + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(chh * dpr);
    S.k = S.cv.width / cw; S.sc = cw / W;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    S.lay = { chrome: ch };
    if (S.col) buildSprites();
  }
  function relayoutIfMoved() {
    if (!S || !S.lay || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var ch = chromeH();
    if (ch && Math.abs(ch - S.lay.chrome) > 1) { layout(); if (!S.raf) draw(); }
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('keyup', s.onKeyUp, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    window.removeEventListener('orientationchange', s.onResize);
    if (s.ro) s.ro.disconnect();
    if (s.themeObs) s.themeObs.disconnect();
    if (s.phase === 'play' && s.g && !s.preview) { try { var o = snap(s.g); if (o) sset(RUN_KEY, JSON.stringify(o)); } catch (e) {} }
    s.snd.close();
    if (s.cv) { s.cv.width = 0; s.cv.height = 0; }
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
    var body = '<div class="bb"><div class="bb-hud off"></div><div class="bb-stage"><canvas class="bb-cv"></canvas><div class="bb-ovl" style="display:none"></div></div>' +
      '<div class="bb-pad"></div><div class="bb-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🫧 Bubble Burst', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'bb-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, hud: p.querySelector('.bb-hud'), stageEl: p.querySelector('.bb-stage'), cv: p.querySelector('.bb-cv'), ovl: p.querySelector('.bb-ovl'),
      pad: p.querySelector('.bb-pad'), liveEl: p.querySelector('.bb-live'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) !== '0'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'menu', g: null, preview: true, paused: false, raf: 0, last: 0, acc: 0, animT: 0, aim: -PI / 2,
      keys: {}, ptr: null, picking: false, cardKind: null, hudKey: null, padKey: null, resume: null, resetArm: false,
      parts: [], pops: [], falls: [], texts: [], rings: [], shake: 0, shx: 0, shy: 0, yOffB: 0, yOffC: 0, sc: 0, k: 1
    };
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    layout();
    readTheme();

    S.onKey = onKey; S.onKeyUp = onKeyUp;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKeyUp, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { S.keys = {}; } };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (!S || S.panel !== p) return; pause(); stopLoop(); });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        layout(); draw();
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); if (!S.raf) draw(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    window.addEventListener('orientationchange', S.onResize);
    try {
      S.ro = new ResizeObserver(function () { if (S && S.panel === p) requestAnimationFrame(relayoutIfMoved); });
      S.ro.observe(S.hud); S.ro.observe(S.pad);
    } catch (e) {}
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); S.padKey = null; syncPad(); if (!S.raf) draw();
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
      else if (h === 'help') {
        if (S.phase === 'play' && !S.paused) pause();
        if (S.cardKind === 'help') toMenuOrBack();
        else if (S.phase !== 'ending') showCard('help');
      }
      try { b.blur(); } catch (er) {}
    });

    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchmove', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    S.pad.addEventListener('touchend', function (e) {
      var b = e.target.closest && e.target.closest('button');
      if (!b) return;
      noTouch(e);
      if (!b.disabled) b.click();
    }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    // aiming: touch / drag and let go to shoot; the mouse aims on hover and shoots on click
    function worldPt(e) {
      var r = S.cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) / (r.width || 1) * W, y: (e.clientY - r.top) / (r.height || 1) * H };
    }
    function aimAt(q) {
      var dy = q.y - LY;
      if (dy > -0.4) dy = -0.4;
      S.aim = clampAng(Math.atan2(dy, q.x - LX));
    }
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (!canAim() || S.ptr) return;
      var q = worldPt(e);
      // tap the next bubble to swap
      if (Math.pow(q.x - NX, 2) + Math.pow(q.y - NY, 2) < 2.4 * 2.4) { doSwap(); return; }
      try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
      S.ptr = { id: e.pointerId, cancel: false };
      aimAt(q);
    });
    S.cv.addEventListener('pointermove', function (e) {
      if (!S || !canAim()) return;
      var q = worldPt(e);
      if (S.ptr && S.ptr.id === e.pointerId) { S.ptr.cancel = q.y > LY + 0.6; if (!S.ptr.cancel) aimAt(q); }
      else if (!S.ptr && e.pointerType === 'mouse') aimAt(q);
    });
    function endPtr(e, cancel) {
      if (!S || !S.ptr || S.ptr.id !== e.pointerId) return;
      var d = S.ptr;
      S.ptr = null;
      if (!cancel && !d.cancel) doFire();
    }
    S.cv.addEventListener('pointerup', function (e) { endPtr(e, false); });
    S.cv.addEventListener('pointercancel', function (e) { endPtr(e, true); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S || b.disabled) return;
      var pw = b.getAttribute('data-pw'), col = b.getAttribute('data-col'), a = b.getAttribute('data-act');
      if (pw) doItem(pw);
      else if (col !== null) doPaint(+col);
      else if (a === 'swap') doSwap();
      else if (a === 'pick-cancel') { S.picking = false; syncPad(); }
      try { b.blur(); } catch (er) {}
    });
    // cards
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || b.disabled) return;
      S.snd.ensure();
      var sv = S.save, a = b.getAttribute('data-act'), mode = b.getAttribute('data-mode'), stg = b.getAttribute('data-stage'), df = b.getAttribute('data-diff');
      if (mode) { sv.mode = mode; }
      else if (stg) { sv.sel = +stg; }
      else if (df !== null) { sv.diff = +df; S.g = previewGame(); var pgx = sv.prog[sv.diff]; if (sv.sel > pgx.un) sv.sel = pgx.un; sv.page = Math.floor((sv.sel - 1) / 20); }
      else if (a === 'pg-prev') sv.page = Math.max(0, sv.page - 1);
      else if (a === 'pg-next') sv.page++;
      else if (a === 'glyphs') { sv.glyphs = !sv.glyphs; buildSprites(); S.padKey = null; persist(); showCard(S.cardKind); draw(); return; }
      else if (a === 'assist') sv.assist = !sv.assist;
      else if (a === 'reset') S.resetArm = true;
      else if (a === 'reset-no') S.resetArm = false;
      else if (a === 'reset-yes') {
        var keep = { diff: sv.diff, glyphs: sv.glyphs, assist: sv.assist };
        S.save = newSave(); S.save.diff = keep.diff; S.save.glyphs = keep.glyphs; S.save.assist = keep.assist;
        S.resetArm = false; sdel(RUN_KEY); S.resume = null;
        if (Cade.showToast) Cade.showToast('Progress reset', 'info', 1600);
      }
      else if (a === 'play') { persist(); startGame(null); return; }
      else if (a === 'first-play') { firstPlay(); return; }
      else if (a === 'resume-run') { var o = loadRun(); if (o) startGame(o); else { S.resume = null; showCard('menu'); } return; }
      else if (a === 'help') { showCard('help'); return; }
      else if (a === 'close-help') { toMenuOrBack(); return; }
      else if (a === 'resume') { resume(); return; }
      else if (a === 'restart') { restart(); return; }
      else if (a === 'menu') { if (S.phase === 'end') S.g = null; toMenu(); return; }
      else if (a === 'next') { nextStage(); return; }
      else return;
      persist();
      if (S.phase === 'menu') {
        showCard('menu'); draw();
        var sel = e.detail === 0 && (S.ovl.querySelector('[data-mode="' + mode + '"]') || S.ovl.querySelector('[data-stage="' + stg + '"]') || S.ovl.querySelector('[data-diff="' + df + '"]') || S.ovl.querySelector('[data-act="' + a + '"]'));
        if (sel) { try { sel.focus({ preventScroll: true }); } catch (er) {} }
      }
      S.snd.tone(988, 0.04, 'sine', 0.025);
    });

    if (S.firstRun) {
      persist();
      S.g = previewGame(); S.preview = true; S.phase = 'menu';
      showCard('help'); syncHead(); draw();
    } else toMenu();
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); layout(); draw(); } });
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Aim, bank and pop matching bubbles — generative stages with stars, an endless rising ceiling, powerups and hazards',
    icon: '🫧',
    tags: 'game,arcade,puzzle,bubble,shooter,match 3,endless,powerups,fun',
    open: open,
    _engine: ENGINE
  });
})();
