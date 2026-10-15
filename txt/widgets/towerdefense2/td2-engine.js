/* Tower Defense V2 (Glyph Defense) — the engine. Pure and deterministic: a
 * fixed 60 Hz step, no DOM, no Math.random (a seeded xorshift per game), pooled
 * enemies / projectiles / effects. Loaded after td2-maps.js and td2-data.js by
 * td2.js; required directly by td2.test.js.
 *
 * Damage resolution (per the design rules): detection and eligibility, then hit
 * geometry, then shields; physical armor subtracts per hit (min 1); weakness
 * (x1.5) and resistances multiply; external buffs + vulnerabilities share a +50%
 * cap. Damage over time ticks every 0.5 s. One live game object `g` holds
 * everything; serialize()/restore() round-trip it as plain JSON. */
(function (root) {
  'use strict';
  var NODE = typeof module !== 'undefined' && module.exports;
  var D = NODE ? require('./td2-data.js') : root.__TD2Data;
  var MP = NODE ? require('./td2-maps.js') : root.__TD2Maps;
  var ENEMIES = D.ENEMIES, TOWERS = D.TOWERS, TKEY = D.TKEY, DTI = D.DTI;
  var TL = MP.T;

  var STEP = 1 / 60, TICK = 0.5;
  var WAVE_GAP = 15, GROUP_GAP = 1.6, MAX_SPAWNERS = 3, SELL_RATE = 0.7;
  var MAX_ENEMIES = 700, MAX_PROJ = 500, MAX_FX = 420, MAX_EV = 400;
  var MODES = ['first', 'last', 'strong', 'weak', 'close'];
  var PHYS = 0, FIRE = 1, FROST = 2, SHOCK = 3, ACID = 4, SONIC = 5, ARCANE = 6;
  // hit flags
  var F_PROJ = 1, F_HIT = 2, F_SPLASH = 4, F_DOT = 8, F_AREA = 16, F_ECHO = 32, F_LINK = 64;
  var BAL = { budget: 120, growth: 1.085, hpPer: 0.015, payBase: 40, payPer: 8, earlyRate: 1.2, gold0: 4.2 };
  // Shapes that fire straight at a target: need line of sight; highland adds 15% range.
  var DIRECT = { bolt: 1, hitscan: 1, flak: 1, line: 1, beam: 1, prism: 1, drones: 1, chain: 1, swarm: 1, cone: 1, boomer: 1, drain: 1 };
  var ATTACK_SHAPES = { bolt: 1, hitscan: 1, arc: 1, flak: 1, ring: 1, cone: 1, chain: 1, line: 1, beam: 1, prism: 1, drones: 1, swarm: 1, orbit: 1, mine: 1, boomer: 1 };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function hash3(a, b, c) { var h = (a * 73856093) ^ (b * 19349663) ^ (c * 83492791); h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); return (h ^ (h >>> 15)) >>> 0; }
  function r1(n) { return Math.round(n * 10) / 10; }

  // ---------------- maps: geometry + rules merged ----------------
  var MAPS = [];
  (function () {
    for (var i = 0; i < MP.MAPS.length; i++) {
      var G = MP.MAPS[i], P = D.PLAY[G.id] || [20, 1 + i, 0.7, 30, 'a b c', '', '', '', 0, 2];
      var only = D.ONLY[G.id] || null, traits = P[6] ? P[6].split(' ') : [];
      MAPS.push({
        i: i, id: G.id, name: G.name, region: G.region, w: G.w, h: G.h, ultra: !!G.ultra, biome: G.biome, blurb: G.blurb || '',
        geo: G, waves: P[0], lvl: P[1], pace: P[2], lives: P[3], pool: P[4].split(' '), bosses: P[5] ? P[5].split(' ') : [],
        traits: traits, unlock: P[7] || '', slots: P[8] || 0, base: P[9] || 2, only: only
      });
    }
  })();
  function hasTrait(M, k) { return M.traits.indexOf(k) >= 0; }

  // Runtime map data, built once per map: grid, routes (ground + air), gates, exits.
  var MD = [];
  // pts in cell coordinates (a waypoint [x, y] is the centre of that cell, + off).
  function mkRoute(pts, air, off) {
    var n = pts.length, R = { x: new Float64Array(n), y: new Float64Array(n), cum: new Float64Array(n), len: 0, n: n, air: !!air };
    for (var i = 0; i < n; i++) {
      R.x[i] = pts[i][0] + off; R.y[i] = pts[i][1] + off;
      if (i) { var dx = R.x[i] - R.x[i - 1], dy = R.y[i] - R.y[i - 1]; R.len += Math.sqrt(dx * dx + dy * dy); R.cum[i] = R.len; }
    }
    return R;
  }
  function mapData(mi) {
    if (MD[mi]) return MD[mi];
    var M = MAPS[mi], G = M.geo, B = MP.build(G), routes = [], air = [], gates = [], exits = [], i;
    for (i = 0; i < G.paths.length; i++) {
      var pts = G.paths[i], cells = B.roads[i];
      routes.push(mkRoute(pts, false, 0.5));
      // Flyers: the map's own air route (world units: 6.5 is the centre of column 6),
      // else straight from the gate to the exit.
      var A = G.air && G.air[i];
      air.push(A ? mkRoute(A, true, 0) : mkRoute([pts[0], pts[pts.length - 1]], true, 0.5));
      gates.push(cells[0]); exits.push(cells[cells.length - 1]);
    }
    // Road sample points (every road cell centre, per route, with its distance) for mines and strips.
    var samples = [];
    for (i = 0; i < routes.length; i++) {
      var R = routes[i], s = [];
      for (var d = 0.5; d < R.len - 0.5; d += 0.5) s.push(d);
      samples.push(s);
    }
    MD[mi] = { w: G.w, h: G.h, grid: B.grid, roads: B.roads, routes: routes, air: air, gates: gates, exits: exits, samples: samples };
    return MD[mi];
  }
  // Point at distance d along a route (writes into out {x,y,fx,fy}); seg is a hint.
  var _pt = { x: 0, y: 0, fx: 1, fy: 0, seg: 0 };
  function routePos(R, d, seg, out) {
    out = out || _pt;
    var n = R.n - 1;
    if (seg == null || seg < 0 || seg >= n) seg = 0;
    while (seg > 0 && R.cum[seg] > d) seg--;
    while (seg < n - 1 && R.cum[seg + 1] <= d) seg++;
    var L = R.cum[seg + 1] - R.cum[seg], f = L > 0 ? (d - R.cum[seg]) / L : 0;
    if (f < 0) f = 0; if (f > 1) f = 1;
    var dx = R.x[seg + 1] - R.x[seg], dy = R.y[seg + 1] - R.y[seg];
    out.x = R.x[seg] + dx * f; out.y = R.y[seg] + dy * f;
    var l = Math.sqrt(dx * dx + dy * dy) || 1;
    out.fx = dx / l; out.fy = dy / l; out.seg = seg;
    return out;
  }

  // ---------------- levels, waves ----------------
  function level(mi, w) { var M = MAPS[mi]; return M.lvl + (w - 1) * M.pace; }
  function hpScale(L) { return 1 + BAL.hpPer * (L - 1); }
  function budget(L) { return BAL.budget * Math.pow(BAL.growth, L - 1); }
  // Extra roads split a defense: maps with more of them pay a little more.
  function routeMul(mi, a) { return 1 + a * (MAPS[mi].geo.paths.length - 1); }
  function wavePay(mi, w) { return Math.round((BAL.payBase + BAL.payPer * level(mi, w)) * (hasTrait(MAPS[mi], 'austerity') ? 1.3 : 1) * routeMul(mi, 0.15)); }
  // The first waves of a map ease in (you start from an empty field).
  var WARM = [0.6, 0.75, 0.9], WARM_ULTRA = [0.5, 0.6, 0.7, 0.8, 0.9];
  function warm(w, mi) { var W = mi != null && MAPS[mi].ultra ? WARM_ULTRA : WARM; return w <= W.length ? W[w - 1] : 1; }
  function startGold(mi) {
    var M = MAPS[mi], g = Math.max(300, BAL.gold0 * budget(M.lvl) * warm(1)) * routeMul(mi, 0.3);
    if (M.ultra) g *= 1.6;
    if (hasTrait(M, 'austerity')) g *= 0.75;
    return Math.round(g / 10) * 10;
  }
  // The wave each pool entry first appears on this map.
  function poolIntro(mi) {
    var M = MAPS[mi], n = M.pool.length, base = Math.min(M.base, n), extra = n - base, last = Math.max(3, Math.floor(M.waves * 0.7)), out = [];
    for (var i = 0; i < n; i++) {
      if (i < base) out.push(1);
      else out.push(extra > 1 ? 2 + Math.round((i - base) * (last - 2) / (extra - 1)) : 2);
    }
    return out;
  }
  function isBossWave(mi, w) {
    var M = MAPS[mi];
    if (!M.bosses.length) return false;
    if (w > M.waves) return w % 10 === 0;
    return w % 10 === 0 || w === M.waves;
  }
  function bossFor(mi, w) {
    var M = MAPS[mi];
    if (!isBossWave(mi, w)) return '';
    if (w === M.waves) return M.bosses[M.bosses.length - 1];
    return M.bosses[(Math.floor(w / 10) - 1) % M.bosses.length];
  }
  function spawnGap(k, L) {
    var E = ENEMIES[k], s = E.size, b = s === 'S' ? 1.4 : s === 'M' ? 1.5 : s === 'L' ? 1.7 : s === 'XL' ? 2.4 : 3;
    return b * Math.max(0.5, 1 - 0.011 * (L - 1));
  }
  var WCACHE = {};
  // Wave w on map mi: { L, groups: [{k, n, gap, ri}], boss, fresh }.
  function waveSpec(mi, w) {
    var key = mi + ':' + w;
    if (WCACHE[key]) return WCACHE[key];
    var M = MAPS[mi], L = level(mi, w), rnd = MP.rng(hash3(mi + 11, w + 5, 977)), md = mapData(mi);
    var intro = poolIntro(mi), avail = [], wt = [], fresh = '', i;
    for (i = 0; i < M.pool.length; i++) {
      if (intro[i] > w) continue;
      var k = M.pool[i], E = ENEMIES[k];
      avail.push(k);
      var x = 1 + 2 * (intro[i] / Math.max(1, M.waves));       // later arrivals weigh more
      if (E.cap) x *= hasTrait(M, 'elite') ? 1.6 : 0.55;
      if (/[0-9!?]/.test(k)) x *= 0.7;
      if (k === '?' && hasTrait(M, 'night')) x *= 2.5;
      wt.push(x);
      if (intro[i] === w && w > 1) fresh = k;
    }
    var bud = budget(L) * (mi ? warm(w, mi) : 1), boss = bossFor(mi, w), groups = [];
    if (hasTrait(M, 'swarm')) bud *= 1.5;
    if (w > M.waves) bud *= 1 + 0.04 * (w - M.waves);
    if (boss) bud *= 0.35;
    if (fresh) {
      var fn = ENEMIES[fresh].cap ? 1 : 4;
      groups.push({ k: fresh, n: fn });
      bud -= fn * ENEMIES[fresh].threat * 0.6;
    }
    var guard = 0;
    while (bud > 8 && groups.length < 6 && guard++ < 40) {
      var tot = 0, pick = -1;
      for (i = 0; i < avail.length; i++) if (ENEMIES[avail[i]].threat <= bud * 1.15 || i === 0) tot += wt[i];
      var rr = rnd() * tot;
      for (i = 0; i < avail.length; i++) {
        if (!(ENEMIES[avail[i]].threat <= bud * 1.15 || i === 0)) continue;
        rr -= wt[i];
        if (rr <= 0) { pick = i; break; }
      }
      if (pick < 0) pick = 0;
      // flyers skip the road's length: they cost more of the budget than their listed threat
      var kk = avail[pick], th = ENEMIES[kk].threat * (ENEMIES[kk].air ? 1.6 : 1);
      var share = bud * (groups.length ? 0.45 + rnd() * 0.35 : 0.4);
      var n = Math.max(1, Math.round(share / th));
      n = Math.min(n, ENEMIES[kk].cap ? 6 : 12 + Math.floor(L / 3));
      wt[pick] *= 0.4;                                          // vary the mix
      if (n * th > bud * 1.25 && groups.length) { if (th > bud) break; n = Math.max(1, Math.floor(bud / th)); }
      groups.push({ k: kk, n: n });
      bud -= n * th;
    }
    // merge neighbours of the same kind
    for (i = groups.length - 1; i > 0; i--) if (groups[i].k === groups[i - 1].k) { groups[i - 1].n += groups[i].n; groups.splice(i, 1); }
    var nr = md.routes.length;
    for (i = 0; i < groups.length; i++) {
      var G2 = groups[i];
      if (G2.k === '2' && G2.n % 2) G2.n++;
      G2.gap = spawnGap(G2.k, L);
      G2.ri = (i + w) % nr;
    }
    if (boss) groups.splice(Math.min(1, groups.length), 0, { k: boss, n: 1, gap: 3, ri: w % nr, boss: true });
    var spec = { L: L, groups: groups, boss: boss, fresh: fresh, w: w };
    WCACHE[key] = spec;
    return spec;
  }
  function waveCount(mi, w) { var s = waveSpec(mi, w), c = 0; for (var i = 0; i < s.groups.length; i++) c += s.groups[i].n; return c; }

  // ---------------- tower stats ----------------
  // Merged stats for type at level lvl (0..3) or branch b (0..1, lvl 4). Cached; never mutate.
  var SCACHE = {};
  function towerStat(type, lvl, b) {
    var key = type * 10 + (lvl >= 4 ? 4 + b : lvl);
    if (SCACHE[key]) return SCACHE[key];
    var T = TOWERS[type], o = { shape: T.shape, tgt: T.tgt }, k, i;
    for (k in T.base) o[k] = T.base[k];
    for (i = 0; i < Math.min(lvl, 3); i++) for (k in T.ups[i][1]) o[k] = T.ups[i][1][k];
    if (lvl >= 4) for (k in T.brs[b][3]) o[k] = T.brs[b][3][k];
    SCACHE[key] = o;
    return o;
  }
  function stat(st, k) { return st[k] || 0; }
  function isAttack(type) { return !!ATTACK_SHAPES[TOWERS[type].shape]; }
  function upgradeCost(g, t, b) {
    var T = TOWERS[t.type];
    if (t.lvl >= 4) return 0;
    var c = t.lvl < 3 ? T.ups[t.lvl][0] : T.brs[b === 1 ? 1 : 0][1];
    return Math.round(c * g.mod.upCost);
  }
  function sellValue(g, t) { return Math.floor(t.spent * g.mod.sell); }

  // ---------------- line of sight ----------------
  // Ridges block sight for direct attacks. Each such tower keeps a mask of the
  // cells it can see within its reach, computed when built or when it reaches further.
  function losMask(g, t, R) {
    var md = MD[g.map], w = md.w, h = md.h, grid = md.grid, size = 2 * R + 1, m = new Uint8Array(size * size), i, j;
    var x0 = t.x, y0 = t.y;
    for (j = -R; j <= R; j++) for (i = -R; i <= R; i++) {
      var cx = t.c + i, cy = t.r + j, ok = 1;
      if (i * i + j * j > (R + 0.5) * (R + 0.5)) { m[(j + R) * size + i + R] = 0; continue; }
      var x1 = cx + 0.5, y1 = cy + 0.5, dx = x1 - x0, dy = y1 - y0, L = Math.sqrt(dx * dx + dy * dy), n = Math.ceil(L / 0.2);
      for (var s = 1; s < n && ok; s++) {
        var px = Math.floor(x0 + dx * s / n), py = Math.floor(y0 + dy * s / n);
        if ((px === t.c && py === t.r) || (px === cx && py === cy)) continue;
        if (px >= 0 && py >= 0 && px < w && py < h && grid[py * w + px] === TL.RIDGE) ok = 0;
      }
      m[(j + R) * size + i + R] = ok;
    }
    t.los = m; t.losR = R;
  }
  function sees(t, x, y) {
    if (!t.los) return true;
    var R = t.losR, i = Math.floor(x) - t.c + R, j = Math.floor(y) - t.r + R, s = 2 * R + 1;
    if (i < 0 || j < 0 || i >= s || j >= s) return false;
    return t.los[j * s + i] === 1;
  }

  // ---------------- perks / map modifiers ----------------
  function cleanPerks(p) {
    var o = {};
    for (var i = 0; i < D.PERKS.length; i++) {
      var v = p && typeof p === 'object' ? p[D.PERKS[i].id] | 0 : 0;
      if (v > 0) o[D.PERKS[i].id] = clamp(v, 0, D.PERKS[i].max);
    }
    return o;
  }
  function perkCost(p) { var s = 0; for (var i = 0; i < D.PERKS.length; i++) s += (p[D.PERKS[i].id] | 0) * D.PERKS[i].cost; return s; }
  function mods(perks, M) {
    var p = cleanPerks(perks);
    function r(id) { return p[id] | 0; }
    var hard = M && hasTrait(M, 'hardcore');
    return {
      gold: 1 + 0.08 * r('chest'), dmg: 1 + 0.05 * r('steel'), range: 1 + 0.05 * r('optics'),
      lives: (hard ? 1 : 5) * r('walls'), bounty: 1 + 0.08 * r('plunder'), upCost: 1 - 0.06 * r('eng'),
      sell: SELL_RATE + 0.08 * r('salvage'), early: 1 + 0.5 * r('early'), spot: r('scouts') ? 1.2 : 0, slots: r('slot')
    };
  }
  // Which towers a map allows (before the player's own unlocks).
  function allowed(mi, type) {
    var M = MAPS[mi], T = TOWERS[type], O = M.only;
    if (hasTrait(M, 'noeco') && T.cat === 'eco') return false;
    if (!O) return true;
    if (O.cats && O.cats.indexOf(T.cat) < 0) return false;
    if (O.types && O.types.indexOf(T.type) < 0) return false;
    if (O.ban && O.ban.indexOf(T.key) >= 0) return false;
    return true;
  }
  function slotsFor(mi, perks) { var M = MAPS[mi]; return (M.slots || 8) + mods(perks, M).slots; }

  // ---------------- game ----------------
  var BK = 2;                                  // enemy bucket size (tiles)
  function newGame(mi, perks, loadout) {
    var M = MAPS[mi], md = mapData(mi), mod = mods(perks, M), i;
    var g = {
      v: 1, map: mi, perks: cleanPerks(perks), mod: mod, loadout: [],
      gold: Math.round(startGold(mi) * mod.gold), lives: M.lives + mod.lives, maxLives: M.lives + mod.lives,
      wave: 0, phase: 'build', endless: false, livesAtWin: 0, countdown: 0, t: 0, steps: 0, nextId: 1, rs: hash3(mi + 3, 7, 1999) || 1,
      kills: 0, leaks: 0, towers: [], enemies: [], proj: [], fx: [], ev: [], zones: [], mines: [], spawners: [],
      waveLeft: [], waveLost: [], waveBoss: [], tgrid: [], pads: {}, events: [], fxOn: true, bonusLast: 0, dirty: true,
      epool: [], ppool: [], fxpool: [], evpool: [], zpool: [], qList: [], wavesStarted: 0, zap: 0, seen: {}, leakBy: {},
      typeMul: [1, 1, 1, 1, 1, 1, 1], hpMul: 1, bountyMul: mod.bounty * (hasTrait(M, 'rich') ? 1.25 : 1),
      gap: hasTrait(M, 'rush') ? 9 : WAVE_GAP, bankHeld: 0, ecoKills: {}, acc: 0
    };
    if (hasTrait(M, 'heat')) { g.typeMul[FIRE] = 0.75; g.typeMul[FROST] = 1.25; }
    if (hasTrait(M, 'cold')) { g.typeMul[FROST] = 0.75; g.typeMul[FIRE] = 1.25; }
    if (hasTrait(M, 'static')) g.typeMul[SHOCK] = 1.25;
    if (hasTrait(M, 'mud')) g.hpMul *= 1.15;
    if (hasTrait(M, 'swarm')) g.hpMul *= 0.7;
    for (i = 0; i < md.w * md.h; i++) g.tgrid.push(null);
    g.bw = Math.ceil(md.w / BK); g.bh = Math.ceil(md.h / BK);
    g.bHead = new Int32Array(g.bw * g.bh); g.bNext = new Int32Array(MAX_ENEMIES + 8); g.bHead.fill(-1);
    g.Q = []; g.Q2 = []; g.Q3 = [];
    setLoadout(g, loadout);
    return g;
  }
  function setLoadout(g, lo) {
    var out = [], n = slotsFor(g.map, g.perks);
    if (lo) for (var i = 0; i < lo.length && out.length < n; i++) {
      var ti = typeof lo[i] === 'number' ? lo[i] : TKEY[lo[i]];
      if (ti != null && TOWERS[ti] && allowed(g.map, ti) && out.indexOf(ti) < 0) out.push(ti);
    }
    g.loadout = out;
    return out;
  }
  function grand(g) { var s = g.rs; s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; g.rs = s; return s / 4294967296; }

  function inGrid(g, c, r) { var md = MD[g.map]; return c >= 0 && r >= 0 && c < md.w && r < md.h; }
  function tileAt(g, c, r) { var md = MD[g.map]; return inGrid(g, c, r) ? md.grid[r * md.w + c] : -1; }
  function towerAt(g, c, r) { return inGrid(g, c, r) ? g.tgrid[r * MD[g.map].w + c] : null; }
  // Terrain letter for building: G grass / H highland / S shore / W water; pads count as Grass (any, Biome Workshop).
  function landOf(g, c, r) {
    var t = tileAt(g, c, r), pad = g.pads[r * MD[g.map].w + c];
    if (pad) return 'P';
    return t === TL.GRASS ? 'G' : t === TL.HIGH ? 'H' : t === TL.SHORE ? 'S' : t === TL.WATER ? 'W' : '';
  }
  function canPlace(g, c, r, type) {
    if (g.phase === 'won' || g.phase === 'lost' || !inGrid(g, c, r) || towerAt(g, c, r)) return false;
    var T = TOWERS[type], land = landOf(g, c, r);
    if (!land) return false;
    if (land === 'P') {
      if (!isAttack(type)) return false;
      var pt = g.towers.filter(function (o) { return o.id === g.pads[r * MD[g.map].w + c]; })[0];
      if (pt && pt.st && pt.st.anyPad) return true;
      return T.land.indexOf('G') >= 0;
    }
    return T.land.indexOf(land) >= 0;
  }
  // Why a tower can't go here ('' when it can).
  function placeWhy(g, c, r, type) {
    if (!inGrid(g, c, r)) return 'off the map';
    if (towerAt(g, c, r)) return 'occupied';
    var land = landOf(g, c, r), t = tileAt(g, c, r);
    if (!land) return t === TL.ROAD ? 'that\'s the road' : t === TL.RIDGE ? 'can\'t build on a ridge' : t === TL.LAVA ? 'lava' : t === TL.VOID ? 'nothing to build on' : 'can\'t build there';
    if (canPlace(g, c, r, type)) return '';
    if (land === 'P') return 'pads take attack towers only';
    var T = TOWERS[type];
    return T.name + ' builds on ' + landNames(T.land);
  }
  function landNames(s) {
    var n = { G: 'grass', H: 'highland', S: 'shore', W: 'water' }, o = [];
    for (var i = 0; i < s.length; i++) o.push(n[s.charAt(i)]);
    return o.length > 1 ? o.slice(0, -1).join(', ') + ' or ' + o[o.length - 1] : o[0];
  }
  function ecoCount(g, type) {
    var n = 0, same = 0;
    for (var i = 0; i < g.towers.length; i++) {
      var T = TOWERS[g.towers[i].type];
      if (T.cat === 'eco') { n++; if (g.towers[i].type === type) same++; }
    }
    return { all: n, same: same };
  }
  function canBuildType(g, type) {
    var T = TOWERS[type];
    if (g.loadout.indexOf(type) < 0) return 'not in your loadout';
    if (T.cat === 'eco') { var e = ecoCount(g, type); if (e.same >= 1) return 'one ' + T.name + ' at a time'; if (e.all >= 2) return 'two economy towers at most'; }
    return '';
  }

  function addTower(g, type, c, r, lvl, br, spent) {
    var md = MD[g.map], t = {
      id: g.nextId++, type: type, lvl: lvl | 0, br: br == null ? -1 : br, c: c, r: r, x: c + 0.5, y: r + 0.5,
      cd: 0.2, mode: TOWERS[type].key === 'sniper' || TOWERS[type].key === 'rail' ? 2 : 0, spent: spent || 0, kills: 0, dmg: 0,
      ax: 0, ay: -1, fireT: 0, since: g.wavesStarted, high: tileAt(g, c, r) === TL.HIGH, pad: !!g.pads[r * md.w + c],
      st: null, bDmg: 0, bHaste: 0, bRange: 0, bPspd: 0, supRed: 0, armIgnore: 0, padR: 0, echoF: 0, echoCd: 0, echoT: 0, echoRic: 0,
      jamF: 0, jamT: 0, yowlF: 0, yowlT: 0, supImm: 0, nullT: 0, nullImm: 0, cleanT: 0,
      focusId: 0, focusT: 0, shots: 0, beamId: 0, beamT: 0, swId: 0, swArr: 0, swCd: 0, ang: 0, revHits: null, ptype: 0,
      principal: 0, bankOn: 1, marks: 0, paid: 0, paidW: 0, mineI: 0, los: null, losR: 0, links: null
    };
    g.towers.push(t);
    g.tgrid[r * md.w + c] = t;
    g.dirty = true;
    return t;
  }
  function build(g, c, r, type) {
    if (type == null || type < 0 || type >= TOWERS.length) return null;
    if (canBuildType(g, type) || !canPlace(g, c, r, type)) return null;
    var cost = TOWERS[type].cost;
    if (g.gold < cost) return null;
    g.gold -= cost;
    var t = addTower(g, type, c, r, 0, -1, cost);
    if (TOWERS[type].shape === 'terra') makePads(g, t);
    g.events.push('build');
    return t;
  }
  // Upgrade one level (lvl 0..2 → +1), or at lvl 3 take branch b (0..2).
  function upgrade(g, t, b) {
    if (!t || t.lvl >= 4 || g.phase === 'won' || g.phase === 'lost') return false;
    if (t.lvl === 3 && !(b === 0 || b === 1)) return false;
    var cost = upgradeCost(g, t, b);
    if (g.gold < cost) return false;
    g.gold -= cost; t.spent += cost;
    if (t.lvl === 3) { t.lvl = 4; t.br = b; } else t.lvl++;
    g.dirty = true;
    if (TOWERS[t.type].shape === 'terra') makePads(g, t);
    g.events.push(t.lvl === 4 ? 'spec' : 'upgrade');
    return true;
  }
  function padOccupied(g, t) {
    var md = MD[g.map];
    for (var k in g.pads) if (g.pads[k] === t.id && g.tgrid[+k]) return true;
    return false;
  }
  function sell(g, t) {
    var i = g.towers.indexOf(t);
    if (i < 0) return -1;
    if (TOWERS[t.type].shape === 'terra' && padOccupied(g, t)) return -1;
    var v = sellValue(g, t) + (t.principal || 0);
    if (t.principal) g.bankHeld -= t.principal;
    g.towers.splice(i, 1);
    g.tgrid[t.r * MD[g.map].w + t.c] = null;
    if (TOWERS[t.type].shape === 'terra') for (var k in g.pads) if (g.pads[k] === t.id) delete g.pads[k];
    for (var j = g.mines.length - 1; j >= 0; j--) if (g.mines[j].by === t) g.mines.splice(j, 1);
    g.gold += v;
    g.dirty = true;
    g.events.push('sell');
    return v;
  }
  function aims(t) { var s = t.st ? t.st.shape : TOWERS[t.type].shape; return s === 'bolt' || s === 'hitscan' || s === 'arc' || s === 'flak' || s === 'cone' || s === 'chain' || s === 'line' || s === 'beam' || s === 'prism' || s === 'drones' || s === 'swarm' || s === 'boomer' || s === 'drain' || s === 'gate' || s === 'etch' || s === 'mute' || s === 'grav' || s === 'tide' || s === 'chrono'; }
  function cycleMode(t) { if (aims(t)) t.mode = (t.mode + 1) % MODES.length; return t.mode; }
  var PRISM_T = [ARCANE, FIRE, FROST, SHOCK];
  function cyclePrism(t) { t.ptype = (t.ptype + 1) % 4; return t.ptype; }

  // Terraformer: raise pads on the nearest unbuildable cells (ridge, water, lava, void) beside the road.
  function makePads(g, t) {
    var md = MD[g.map], st = towerStat(t.type, t.lvl, t.br), want = st.pads, R = st.range, have = 0, k, cand = [];
    for (k in g.pads) if (g.pads[k] === t.id) have++;
    if (have >= want) return;
    var r0 = Math.ceil(R);
    for (var j = -r0; j <= r0; j++) for (var i = -r0; i <= r0; i++) {
      var c = t.c + i, r = t.r + j;
      if (!inGrid(g, c, r) || i * i + j * j > R * R) continue;
      var cell = r * md.w + c, tt = md.grid[cell];
      if (g.pads[cell] || g.tgrid[cell]) continue;
      if (tt !== TL.RIDGE && tt !== TL.WATER && tt !== TL.LAVA && tt !== TL.VOID) continue;
      // prefer cells next to the road
      var road = 9;
      for (var q = 0; q < 4; q++) {
        var cc = c + (q === 0 ? 1 : q === 1 ? -1 : 0), rr = r + (q === 2 ? 1 : q === 3 ? -1 : 0);
        if (inGrid(g, cc, rr) && md.grid[rr * md.w + cc] === TL.ROAD) road = 0;
      }
      cand.push({ cell: cell, s: road * 100 + i * i + j * j });
    }
    cand.sort(function (a, b) { return a.s - b.s || a.cell - b.cell; });
    for (k = 0; k < cand.length && have < want; k++) { g.pads[cand[k].cell] = t.id; have++; }
    g.events.push('pads');
  }

  // Live stats from base + level + perks + map + support auras. Rebuilt only when towers change.
  function recalc(g) {
    g.dirty = false;
    var tw = g.towers, m = g.mod, M = MAPS[g.map], fog = hasTrait(M, 'fog') ? 0.85 : 1, i, j, t, s;
    for (i = 0; i < tw.length; i++) {
      t = tw[i];
      var base = towerStat(t.type, t.lvl, t.br), st = t.st || (t.st = {});
      for (var k0 in st) delete st[k0];
      for (var k in base) st[k] = base[k];
      t.bDmg = 0; t.bHaste = 0; t.bRange = 0; t.bPspd = 0; t.supRed = 0; t.armIgnore = 0; t.padR = 0; t.echoF = 0; t.echoCdL = 0; t.echoRic = 0;
      t.pad = !!g.pads[t.r * MD[g.map].w + t.c];
    }
    // support auras (capacity-limited, nearest first; same kind: strongest only)
    for (i = 0; i < tw.length; i++) {
      s = tw[i];
      var sh = s.st.shape;
      if (sh === 'terra' && s.st.padRange) {
        for (j = 0; j < tw.length; j++) if (tw[j].pad && g.pads[tw[j].r * MD[g.map].w + tw[j].c] === s.id) tw[j].padR = Math.max(tw[j].padR, s.st.padRange);
        continue;
      }
      if (sh !== 'haste' && sh !== 'amp' && sh !== 'survey' && sh !== 'relay' && sh !== 'echo') continue;
      if (s.nullT > 0) continue;
      var R2 = s.st.range * s.st.range, list = [];
      for (j = 0; j < tw.length; j++) {
        t = tw[j];
        if (t === s || !isAttack(t.type)) continue;
        var dx = t.x - s.x, dy = t.y - s.y, d2 = dx * dx + dy * dy;
        if (d2 <= R2) list.push({ t: t, d: d2 });
      }
      list.sort(function (a, b) { return a.d - b.d || a.t.id - b.t.id; });
      s.links = [];
      for (j = 0; j < list.length && j < (s.st.cap || 0); j++) {
        t = list[j].t; s.links.push(t.id);
        if (sh === 'haste') { t.bHaste = Math.max(t.bHaste, s.st.haste || 0); if (s.st.dmgB) t.bDmg = Math.max(t.bDmg, s.st.dmgB); }
        else if (sh === 'amp') { t.bDmg = Math.max(t.bDmg, s.st.dmgB); if (s.st.armIgnore) t.armIgnore = Math.max(t.armIgnore, s.st.armIgnore); }
        else if (sh === 'survey') { t.bRange = Math.max(t.bRange, s.st.rangeB || 0); if (s.st.pspdB) t.bPspd = Math.max(t.bPspd, s.st.pspdB); }
        else if (sh === 'relay') t.supRed = Math.max(t.supRed, s.st.supRed);
        else if (sh === 'echo') { if ((s.st.echo || 0) > t.echoF) { t.echoF = s.st.echo; t.echoCdL = s.st.echoCd; t.echoRic = s.st.ric || 0; } }
      }
    }
    for (i = 0; i < tw.length; i++) {
      t = tw[i];
      var st2 = t.st, atk = isAttack(t.type);
      if (atk) {
        st2.dmg = (st2.dmg || 0) * m.dmg; if (st2.sec) st2.sec *= m.dmg;
        if (st2.burn) st2.burn *= m.dmg; if (st2.corrode) st2.corrode *= m.dmg; if (st2.wake) st2.wake *= m.dmg;
        if (st2.after) st2.after *= m.dmg; if (st2.cluster) st2.cluster *= m.dmg;
        var bonus = (t.high && DIRECT[st2.shape] ? 0.15 : 0) + t.bRange + t.padR;
        st2.range *= m.range * fog * (1 + Math.min(0.4, bonus));
        if (st2.pspd) st2.pspd *= 1 + t.bPspd;
        if (st2.det || DIRECT[st2.shape]) { var need = Math.ceil(st2.range * 1.45) + 1; if (DIRECT[st2.shape] && (!t.los || t.losR < need)) losMask(g, t, need); }
      }
      if (st2.shape === 'reveal') st2.range *= m.range;
    }
  }
  function stats(g, t) { if (g.dirty || !t.st) recalc(g); return t.st; }
  // Effective range/interval right now (jams and yowls are temporary).
  function effRange(t) { var r = t.st.range * (t.jamT > 0 ? 1 - t.jamF : 1); return r < 1 ? 1 : r; }
  function effInt(t) {
    var h = 1 + Math.min(0.5, t.bHaste), y = t.yowlT > 0 ? 1 - t.yowlF : 1, v = (t.st.int || 1) / (h * y);
    return v < 0.15 ? 0.15 : v;
  }

  // ---------------- enemy buckets ----------------
  function rebuildBuckets(g) {
    var en = g.enemies, head = g.bHead, nx = g.bNext, bw = g.bw, bh = g.bh, i;
    head.fill(-1);
    for (i = 0; i < en.length; i++) {
      var e = en[i];
      if (!e.alive) continue;
      var bx = Math.floor(e.x / BK), by = Math.floor(e.y / BK);
      if (bx < 0) bx = 0; else if (bx >= bw) bx = bw - 1;
      if (by < 0) by = 0; else if (by >= bh) by = bh - 1;
      var b = by * bw + bx;
      nx[i] = head[b]; head[b] = i;
    }
  }
  // Living enemies within r of (x, y), into out[0..n). Returns n.
  function near(g, x, y, r, out) {
    var en = g.enemies, head = g.bHead, nx = g.bNext, bw = g.bw, bh = g.bh, n = 0, r2 = r * r;
    var x0 = Math.max(0, Math.floor((x - r) / BK)), x1 = Math.min(bw - 1, Math.floor((x + r) / BK));
    var y0 = Math.max(0, Math.floor((y - r) / BK)), y1 = Math.min(bh - 1, Math.floor((y + r) / BK));
    for (var by = y0; by <= y1; by++) for (var bx = x0; bx <= x1; bx++) {
      for (var i = head[by * bw + bx]; i >= 0; i = nx[i]) {
        var e = en[i];
        if (!e || !e.alive) continue;
        var dx = e.x - x, dy = e.y - y;
        if (dx * dx + dy * dy <= r2) out[n++] = e;
      }
    }
    return n;
  }

  // ---------------- enemies ----------------
  var EFIELDS = ['slowF', 'slowT', 'stunT', 'hcImm', 'silT', 'revealT', 'burnD', 'burnT', 'burnCut', 'corD', 'corT', 'armRA', 'armRT',
    'etchA', 'etchT', 'noRegT', 'resCutA', 'resCutT', 'britA', 'britT', 'wetA', 'wetT', 'wetS', 'markT', 'markV', 'markBy', 'lockShT',
    'tempAr', 'tempArT', 'auraH', 'auraT', 'alarmH', 'alarmT', 'umbA', 'umbT', 'landT', 'disp', 'dispImm', 'frzN', 'frzBy', 'frzCd',
    'stunCd', 'silCd', 'dotT', 'hurtT', 'flash', 'ghostT', 'abT', 'abT2', 'dodT', 'escT', 'escF', 'kStack', 'kCdT', 'kClrT', 'expT',
    'buried', 'high', 'alone', 'partner', 'dashT', 'guardN', 'guardT', 'stolen', 'stole', 'adaptK', 'stepAcc', 'blinks', 'warnT',
    'revived', 'revT', 'count', 'disguise', 'summoned', 'healed', 'openT', 'phase', 'mode', 'prevT', 'veilT', 'linkT', 'flyT',
    'hideT', 'surgeT', 'thr', 'sprT', 'prot', 'root', 'delayT', 'lockIn'];
  function resetEnemy(e) {
    for (var i = 0; i < EFIELDS.length; i++) e[EFIELDS[i]] = 0;
    e.adaptK = -1; e.disguise = ''; e.links = null; e.burnBy = null; e.corBy = null; e.slick = null; e.pr = null;
    e.lid = -1; e.healMark = -1; e.zap = 0;
  }
  function spawnEnemy(g, k, w, L, ri, d, orig) {
    if (g.enemies.length >= MAX_ENEMIES) return null;
    var E = ENEMIES[k], M = MAPS[g.map], e = g.epool.length ? g.epool.pop() : {};
    resetEnemy(e);
    var id = g.nextId++, h = hash3(id, 17, 3);
    e.id = id; e.k = k; e.w = w; e.L = L; e.ri = ri | 0; e.fly = E.air; e.air = E.air; e.alive = true; e.orig = orig ? 1 : 0;
    var hs = hpScale(L) * g.hpMul;
    e.maxHp = e.hp = Math.ceil(E.hp * hs);
    e.sh = e.shMax = 0;
    if (k === '0') e.sh = e.shMax = Math.ceil(250 * hs);
    e.ar = E.ar; e.lives = E.lives;
    e.spd = E.spd * (E.air ? (hasTrait(M, 'tailwind') ? 1.25 : 1) : (hasTrait(M, 'mud') ? 0.85 : 1));
    e.bounty = orig ? Math.round(E.bounty * g.bountyMul) : 0;
    e.d = d || 0; e.seg = 0; e.age = 0;
    e.lat = E.boss ? 0 : ((h & 255) / 255 - 0.5) * 0.34;
    // per-glyph starting timers
    switch (k) {
      case 'd': e.abT = 4; break; case 'D': e.abT = 3; break;
      case 's': case 'S': e.abT = 2; break;
      case 't': e.abT = 3; break; case 'T': e.abT = 2.5; break;
      case 'w': e.abT = 3; break; case 'W': e.abT = 2; break;
      case 'h': e.abT = 1.8; break; case 'H': e.abT = 1.5; break;
      case 'j': case 'J': case 'm': case 'M': case 'n': case 'N': case '6': e.abT = 4; break;
      case 'p': e.abT = 4; break; case 'P': e.abT = 3.5; break;
      case 'o': case 'O': e.abT = 3; break;
      case 'y': case 'Y': e.abT = 5; break;
      case '1': case '2': case 'u': case 'U': case 'v': case 'V': e.abT = 0.25; break;
      case '4': e.abT = 1; break;
      case '9': e.abT = 1.5; e.count = 9; break;
      case '!': e.abT = 3; break;
      case '@': e.abT = 10; break;
      case 'Ω': e.abT = 9; break;
      case '₩': e.abT = 12; break;
      case '₼': e.abT = 5; e.phase = 0; break;
      case '&': e.abT = 3; break;
      case '%': e.abT = 10; break;
      case '¶': e.abT = 14; break;
      case '¤': e.abT = 6; break;
      case '※': e.abT = 12; e.prevT = 3; e.mode = 0; break;
      case '?':
        if (grand(g) < 0.35) {
          var pool = [], intro = poolIntro(g.map), cur = g.wave;
          for (var pi = 0; pi < M.pool.length; pi++) if ('abcdefgh'.indexOf(M.pool[pi]) >= 0 && intro[pi] <= cur) pool.push(M.pool[pi]);
          e.disguise = pool.length ? pool[Math.floor(grand(g) * pool.length)] : 'a';
        }
        break;
    }
    if (E.boss) e.thr = 0;
    placeEnemy(g, e);
    e.px = e.x; e.py = e.y;
    g.enemies.push(e);
    if (!g.seen[k]) { g.seen[k] = 1; g.events.push('seen:' + k); }
    return e;
  }
  // A child / summon mid-road: counts toward its wave, pays nothing, briefly untouchable.
  function spawnChild(g, k, par, d, ri) {
    g.waveLeft[par.w] = (g.waveLeft[par.w] || 0) + 1;
    var c = spawnEnemy(g, k, par.w, par.L, ri == null ? par.ri : ri, Math.max(0, d), false);
    if (!c) { g.waveLeft[par.w]--; return null; }
    c.prot = 0.25;
    return c;
  }
  function routeOf(g, e) { var md = MD[g.map]; return e.fly ? md.air[e.ri] : md.routes[e.ri]; }
  function placeEnemy(g, e) {
    var R = routeOf(g, e), p = routePos(R, e.d, e.seg, _pt);
    e.seg = p.seg; e.fx = p.fx; e.fy = p.fy;
    e.x = p.x - p.fy * e.lat; e.y = p.y + p.fx * e.lat;
    e.rem = R.len - e.d;
  }
  // 1 ground · 2 air · 3 either (a low wavewing, a grounded flyer)
  function layerOf(e) {
    if (e.fly) { if (e.landT > 0) return 3; if ((e.k === 'w' || e.k === 'W') && !e.high) return 3; return 2; }
    if (e.k === '₩' && e.flyT > 0) return 2;
    return 1;
  }
  function isHidden(e) { return e.k === '?' || e.buried || e.hideT > 0 || e.veilT > 0; }
  function isBoss(e) { return ENEMIES[e.k].boss; }

  // ---- statuses ----
  function slowCap(e) { var k = e.k; return ENEMIES[k].boss ? 0.25 : k === 'g' ? 0.25 : k === 'G' ? 0.15 : 0.6; }
  // zone: from Barricade / Gravity Well (Crosswalkers walk through those)
  function applySlow(e, f, dur, zone) {
    if (zone && (e.k === 'x' || e.k === 'X')) return;
    f = Math.min(f, slowCap(e));
    if (f <= 0 || dur <= 0) return;
    if (f > e.slowF || e.slowT <= 0) { e.slowF = f; e.slowT = dur; }
    else if (f === e.slowF && dur > e.slowT) e.slowT = dur;
    if (f >= 0.3 && (e.k === 'd' || e.k === 'D')) e.dodT = 0;
  }
  function frenzy(e) { return (e.k === 'z' && e.hp < e.maxHp * 0.35) || (e.k === 'Z' && e.hp < e.maxHp * 0.5); }
  function applyStun(e, dur) {
    if (isBoss(e) || e.hcImm > 0 || dur <= 0 || frenzy(e)) return false;
    var k = e.k;
    if (k === 'e') dur *= 0.5; else if (k === 'E') dur *= 0.25; else if (k === 'g') dur *= 0.5; else if (k === 'G') dur *= 0.35;
    e.stunT = Math.min(1.5, Math.max(e.stunT, dur));
    return true;
  }
  function applySilence(e, dur) {
    if (isBoss(e)) dur *= 0.25;
    if (dur > e.silT) e.silT = dur;
    if (e.k === '7' && e.warnT > 0) { e.warnT = 0; e.stepAcc = 0; }
    if (e.k === '&') e.linkT = 0;
    if (e.k === '!' && e.abT < 3) e.abT = 3;
  }
  function applyBurn(e, dps, dur, src, cut) {
    if (e.k === 'c' || e.k === 'C' || dps <= 0) return;
    if (e.burnT <= 0 || dps >= e.burnD) { e.burnD = dps; e.burnBy = src; e.burnCut = cut || 0; }
    if (dur > e.burnT) e.burnT = dur;
  }
  function applyCorrode(e, dps, dur, src, ared, aredDur) {
    if (dps > 0) { if (e.corT <= 0 || dps >= e.corD) { e.corD = dps; e.corBy = src; } if (dur > e.corT) e.corT = dur; }
    if (ared > 0) { if (ared >= e.armRA || e.armRT <= 0) e.armRA = ared; if (aredDur > e.armRT) e.armRT = aredDur; }
  }
  function displace(g, e, tiles) {
    if (isBoss(e) || e.k === 'g' || e.k === 'G' || e.dispImm > 0 || e.revT > 0) return 0;
    var room = 3 - e.disp;
    tiles = Math.min(tiles, room, e.d);
    if (tiles <= 0.01) return 0;
    e.d -= tiles; e.disp += tiles; e.dispImm = 5;
    placeEnemy(g, e); e.px = e.x; e.py = e.y;
    return tiles;
  }

  // ---- damage ----
  function frontOf(e, sx, sy) {
    var vx = sx - e.x, vy = sy - e.y, l = Math.sqrt(vx * vx + vy * vy);
    return l < 0.01 || (vx * e.fx + vy * e.fy) / l >= 0.5;
  }
  function resist(e, t, src) {
    var E = ENEMIES[e.k], r = E.res[t], k = e.k;
    if ((k === 'c' || k === 'C') && t === FIRE && e.expT > 0) r = 0;
    else if ((k === 'i' || k === 'I') && t === SHOCK && e.expT > 0) r = 0;
    else if (k === '6' && e.adaptK === t) r = 0.65;
    else if (k === '₩' && t === SHOCK && e.flyT > 0) r = 0.3;
    else if (k === '₼') r = e.phase === 0 ? (t === PHYS ? 0.6 : 0) : e.phase === 1 ? (t !== PHYS ? 0.6 : 0) : 0;
    if (r > 0 && e.resCutT > 0 && (t === FIRE || t === SHOCK)) r = Math.max(0, r - e.resCutA);
    if (r > 0 && src && src.st && src.st.resPen) r = Math.max(0, r - src.st.resPen);
    return r;
  }
  function armorOf(e, src, fl) {
    var a = e.ar + (e.tempArT > 0 ? e.tempAr : 0);
    if ((e.k === 'b' || e.k === 'B') && (fl & F_HIT) && src && frontOf(e, src.x, src.y)) a += e.k === 'b' ? 18 : 36;
    if (e.k === '※' && e.mode === 0 && e.prevT <= 0) a += 20;
    a -= (e.armRT > 0 ? e.armRA : 0) + (e.etchT > 0 ? e.etchA : 0);
    if (a <= 0) return 0;
    if (src && src.st) { if (src.armIgnore) a = Math.max(0, a - src.armIgnore); a *= 1 - (src.st.pierce || 0); }
    return a;
  }
  // The main damage entry. t: damage type index; src: tower or null; fl: hit flags.
  function hurt(g, e, amt, t, src, fl) {
    if (!e.alive || e.revT > 0 || e.prot > 0 || !(amt > 0)) return 0;
    var E = ENEMIES[e.k];
    if (!(fl & F_LINK)) {
      var up = (src && !(fl & F_ECHO) ? src.bDmg : 0) + (t === PHYS && e.britT > 0 ? e.britA : 0) + (t === SHOCK && e.wetT > 0 ? e.wetA : 0) + (e.markT > 0 ? e.markV : 0);
      if (up > 0) amt *= 1 + (up > 0.5 ? 0.5 : up);
    }
    var mul = 1;
    if (!(fl & F_LINK)) {
      if (E.weak === t) mul *= 1.5;
      if ((e.k === '₼' && e.phase === 2) || (e.k === '※' && e.prevT > 0)) mul *= 1.5;
      mul *= (1 - resist(e, t, src)) * g.typeMul[t];
      if (src && src.st) {
        if (src.st.ghostB && (e.k === '?' || e.ghostT > 0)) mul *= 1 + src.st.ghostB;
        if (src.st.execute && e.hp < e.maxHp * 0.3) mul *= 1 + src.st.execute;
      }
    }
    if (e.sh > 0 && !(fl & F_LINK)) {
      var sm = 1;
      if (t === SONIC && src && src.st && src.st.shieldMul) sm = src.st.shieldMul;
      if (t === SHOCK && (e.k === '0' || e.k === '¤')) sm *= 1.5;
      var sAmt = amt * sm;
      if (sAmt <= e.sh) {
        e.sh -= sAmt; if (!(fl & F_DOT)) e.flash = 0.08; e.hurtT = 0;
        if (src) src.dmg += sAmt;
        return sAmt;
      }
      var used = e.sh; e.sh = 0; amt = (sAmt - used) / sm;
      if (src) src.dmg += used;
      g.events.push('shield');
    }
    if (t === PHYS && !(fl & F_LINK)) amt = Math.max(1, amt - armorOf(e, src, fl));
    amt *= mul;
    if ((fl & F_SPLASH) && e.umbT > 0) amt *= 1 - e.umbA;
    if ((fl & F_HIT) && !(fl & F_LINK)) {
      if (e.k === '3' && e.guardT > 0) amt *= 0.4;
      else if (e.k === 'Ω' && e.openT <= 0 && src && frontOf(e, src.x, src.y)) amt *= 0.4;
      else if (e.k === '%' && e.openT <= 0) { var c1 = e.maxHp * 0.01; if (amt > c1) amt = c1 + 0.25 * (amt - c1); }
    }
    if ((e.k === 'l' || e.k === 'L') && !(fl & F_DOT)) { var cap = e.maxHp * (e.k === 'l' ? 0.2 : 0.12); if (amt > cap) amt = cap; }
    if (e.k === '&' && e.linkT > 0 && !(fl & F_LINK)) amt = linkSplit(g, e, amt, t);
    amt = Math.round(amt * 10) / 10;
    if (amt <= 0) return 0;
    if (amt > e.hp) amt = e.hp;
    e.hp -= amt; e.hurtT = 0;
    if (!(fl & F_DOT)) e.flash = 0.08;
    if (src) src.dmg += amt;
    if ((fl & F_HIT) && !(fl & F_LINK)) {
      if (e.k === 'k' || e.k === 'K') { if (e.kCdT <= 0) { e.kStack = Math.min(e.k === 'k' ? 8 : 10, e.kStack + 1); e.kCdT = 0.25; } e.kClrT = e.k === 'k' ? 2 : 3; }
      else if (e.k === '3' && e.guardT <= 0) { if (++e.guardN >= 3) { e.guardN = 0; e.guardT = 1; } }
    }
    if (e.k === '6' && e.adaptK < 0 && e.silT <= 0) e.adaptK = t;
    else if ((e.k === 'c' || e.k === 'C') && t === FROST) e.expT = e.k === 'c' ? 3 : 2;
    else if ((e.k === 'i' || e.k === 'I') && t === ACID) e.expT = e.k === 'i' ? 3 : 2;
    if (E.boss) bossThresholds(g, e);
    if (e.hp <= 0.05) kill(g, e, src);
    return amt;
  }
  // Conjunction: 30% of its damage goes, split evenly, to its linked allies (unmodified).
  function linkSplit(g, e, amt, t) {
    var L = e.links, live = 0, i;
    if (!L) return amt;
    for (i = 0; i < L.length; i++) if (L[i].alive && L[i].id === L[i].lid) live++;
    if (!live) return amt;
    var share = amt * 0.3 / live;
    for (i = 0; i < L.length; i++) if (L[i].alive && L[i].id === L[i].lid) hurt(g, L[i], share, t, null, F_LINK);
    return amt * 0.7;
  }
  function bossThresholds(g, e) {
    var f = e.hp / e.maxHp, k = e.k;
    if (k === '₷') {
      for (var q = 0; q < 3; q++) {
        var at = 0.75 - q * 0.25, bit = 1 << q;
        if (f <= at && !(e.thr & bit) && e.summoned < 6) {
          e.thr |= bit;
          for (var s = 0; s < 2; s++) { var c = spawnChild(g, 'h', e, e.d - 0.3 - s * 0.4); if (c) { c.root = e.id; e.summoned++; } }
          g.events.push('summon');
        }
      }
    } else if (f <= 0.5 && !(e.thr & 8)) {
      if (k === '@') { e.thr |= 8; for (var b = 0; b < 4; b++) spawnChild(g, 'b', e, e.d - 0.25 * (b + 1)); g.events.push('summon'); }
      else if (k === '¤') { e.thr |= 8; for (var b2 = 0; b2 < 4; b2++) spawnChild(g, '?', e, e.d - 0.3 * (b2 + 1)); g.events.push('summon'); }
      else if (k === '※') { e.thr |= 8; }
    }
  }

  function kill(g, e, src) {
    var E = ENEMIES[e.k];
    if (e.k === '8' && !e.revived && e.silT <= 0) {           // second loop: back once at half health
      e.revived = 1; e.revT = 1.5; e.hp = Math.ceil(e.maxHp * 0.5);
      g.events.push('revive');
      return;
    }
    e.alive = false; e.hp = 0;
    g.kills++;
    if (src) src.kills++;
    var b = e.bounty;
    if (e.stolen) { b += e.stolen; e.stolen = 0; g.events.push('refund'); }
    if (e.orig) b += ecoKill(g, e);
    if (b) { g.gold += b; addFx(g, 5, e.x, e.y, 0, 0, 0.9, 0, '+' + b); }
    g.events.push(E.boss ? 'bosskill' : 'kill');
    addFx(g, 6, e.x, e.y, 0, 0, 0.3, E.boss ? 1.4 : E.cap ? 0.9 : 0.5, '');
    if (E.split) {
      for (var j = 0; j < E.split; j++) spawnChild(g, E.lower, e, e.d - (E.split > 1 ? j / (E.split - 1) : 0));
      g.events.push('split');
    }
    if (e.k === '?' && e.disguise) {
      var c = spawnChild(g, e.disguise, e, e.d);
      if (c) { c.ghostT = 5; c.prot = 0; }
      g.events.push('unmask');
    }
    if (e.k === '2') {
      for (var i = 0; i < g.enemies.length; i++) { var o = g.enemies[i]; if (o.alive && o.k === '2' && o.partner === e.id) o.dashT = 3; }
    }
    waveDone(g, e.w);
  }
  function leak(g, e) {
    e.alive = false;
    var R = routeOf(g, e);
    g.lives -= e.lives; g.leaks += e.lives;
    g.leakBy[e.k] = (g.leakBy[e.k] || 0) + e.lives;
    g.waveLost[e.w] = (g.waveLost[e.w] || 0) + e.lives;
    if (e.orig) ecoLeak(g, e);
    g.events.push('leak');
    addFx(g, 5, R.x[R.n - 1] - (R.x[R.n - 1] - R.x[R.n - 2]) * 0.0, R.y[R.n - 1], 0, 0, 1.1, 1, '-' + e.lives + '♥');
    waveDone(g, e.w);
    if (g.lives <= 0 && g.phase !== 'lost') { g.lives = 0; g.phase = 'lost'; g.events.push('lose'); }
  }
  function addFx(g, kind, x, y, x2, y2, life, a, txt) {
    if (!g.fxOn || g.fx.length >= MAX_FX) return null;
    var f = g.fxpool.length ? g.fxpool.pop() : {};
    f.kind = kind; f.x = x; f.y = y; f.x2 = x2; f.y2 = y2; f.t = 0; f.life = life; f.a = a; f.txt = txt || ''; f.c = 0;
    g.fx.push(f);
    return f;
  }

  // ---- per-step enemy update: statuses, DoT, abilities, movement ----
  function tick(v, dt) { return v > 0 ? (v > dt ? v - dt : 0) : 0; }
  function stepEnemy(g, e, dt, md) {
    var k = e.k, E = ENEMIES[k], wasStun = e.stunT > 0, Q = g.Q2, n, i, o;
    e.px = e.x; e.py = e.y; e.age += dt;
    if (e.prot > 0) e.prot = tick(e.prot, dt);
    if (e.revT > 0) { e.revT = tick(e.revT, dt); return; }
    // timers
    if (e.slowT > 0 && (e.slowT -= dt) <= 0) { e.slowT = 0; e.slowF = 0; }
    if (e.stunT > 0) { e.stunT = tick(e.stunT, dt); if (e.stunT <= 0 && wasStun) { e.hcImm = 4; if (k === 'e' || k === 'E') { e.escT = k === 'e' ? 1 : 1.5; e.escF = k === 'e' ? 0.4 : 0.6; } } }
    if (e.hcImm > 0) e.hcImm = tick(e.hcImm, dt);
    if (e.silT > 0) e.silT = tick(e.silT, dt);
    if (e.revealT > 0) e.revealT = tick(e.revealT, dt);
    if (e.armRT > 0) e.armRT = tick(e.armRT, dt);
    if (e.etchT > 0) e.etchT = tick(e.etchT, dt);
    if (e.noRegT > 0) e.noRegT = tick(e.noRegT, dt);
    if (e.resCutT > 0) e.resCutT = tick(e.resCutT, dt);
    if (e.britT > 0) e.britT = tick(e.britT, dt);
    if (e.wetT > 0) e.wetT = tick(e.wetT, dt);
    if (e.markT > 0) e.markT = tick(e.markT, dt);
    if (e.lockShT > 0) e.lockShT = tick(e.lockShT, dt);
    if (e.tempArT > 0) e.tempArT = tick(e.tempArT, dt);
    if (e.auraT > 0 && (e.auraT -= dt) <= 0) { e.auraT = 0; e.auraH = 0; }
    if (e.alarmT > 0 && (e.alarmT -= dt) <= 0) { e.alarmT = 0; e.alarmH = 0; }
    if (e.umbT > 0) e.umbT = tick(e.umbT, dt);
    if (e.landT > 0) e.landT = tick(e.landT, dt);
    if (e.dispImm > 0) e.dispImm = tick(e.dispImm, dt);
    if (e.frzCd > 0) e.frzCd = tick(e.frzCd, dt);
    if (e.stunCd > 0) e.stunCd = tick(e.stunCd, dt);
    if (e.silCd > 0) e.silCd = tick(e.silCd, dt);
    if (e.flash > 0) e.flash = tick(e.flash, dt);
    if (e.ghostT > 0) e.ghostT = tick(e.ghostT, dt);
    if (e.escT > 0) e.escT = tick(e.escT, dt);
    if (e.dashT > 0) e.dashT = tick(e.dashT, dt);
    if (e.expT > 0) e.expT = tick(e.expT, dt);
    if (e.delayT > 0) e.delayT = tick(e.delayT, dt);
    e.hurtT += dt;
    // damage over time, in 0.5 s ticks
    if (e.burnT > 0 || e.corT > 0) {
      e.dotT += dt;
      if (e.dotT >= TICK) {
        e.dotT -= TICK;
        if (e.burnT > 0) { hurt(g, e, e.burnD * TICK, FIRE, e.burnBy, F_DOT); if (!e.alive) return; }
        if (e.corT > 0) { hurt(g, e, e.corD * TICK, ACID, e.corBy, F_DOT); if (!e.alive) return; }
      }
      if (e.burnT > 0 && (e.burnT -= dt) <= 0) { e.burnT = 0; e.burnD = 0; e.burnBy = null; }
      if (e.corT > 0 && (e.corT -= dt) <= 0) { e.corT = 0; e.corD = 0; e.corBy = null; }
    } else e.dotT = 0;
    if (e.revT > 0) return;
    // abilities: active ones pause while silenced or held by Missed Beat
    var act = e.silT <= 0 && e.delayT <= 0, stunned = e.stunT > 0;
    switch (k) {
      case 'd': case 'D':
        if (e.dodT > 0) e.dodT = tick(e.dodT, dt);
        if ((e.abT -= dt) <= 0) { e.abT += k === 'd' ? 4 : 3; if (!(e.slowT > 0 && e.slowF >= 0.3)) e.dodT = k === 'd' ? 1 : 1.4; }
        break;
      case 'h': case 'H':
        if (act && (e.abT -= dt) <= 0) {
          e.abT += k === 'h' ? 3 : 2.5;
          var hr = k === 'h' ? 1.5 : 1.75, hc = k === 'h' ? 3 : 4, hp = k === 'h' ? 0.06 : 0.1, hcap = e.maxHp * (k === 'h' ? 0.4 : 0.3);
          n = near(g, e.x, e.y, hr, Q);
          var any = 0;
          for (var hh = 0; hh < hc; hh++) {
            var best = null, bf = 1;
            for (i = 0; i < n; i++) { o = Q[i]; if (o === e || isBoss(o) || o.healMark === g.steps) continue; var f2 = o.hp / o.maxHp; if (f2 < bf) { bf = f2; best = o; } }
            if (!best) break;
            best.healMark = g.steps;
            best.hp = Math.min(best.maxHp, best.hp + Math.min(hcap, best.maxHp * hp)); any = 1;
          }
          if (any) { addFx(g, 8, e.x, e.y, 0, 0, 0.6, hr, ''); g.events.push('heal'); }
        }
        break;
      case 'j': case 'J':
        if (act && (e.abT -= dt) <= 0) { e.abT += 4; suppressTowers(g, e, k === 'j' ? 2 : 2.25, k === 'j' ? 1 : 2, 'jam', k === 'j' ? 0.35 : 0.5); }
        break;
      case 'k': case 'K':
        if (e.kCdT > 0) e.kCdT = tick(e.kCdT, dt);
        if (e.kClrT > 0 && (e.kClrT -= dt) <= 0) { e.kClrT = 0; e.kStack = 0; }
        break;
      case 'm': case 'M':
        if (act && (e.abT -= dt) <= 0) {
          e.abT += 4;
          var mr = k === 'm' ? 1 : 1.5, md2 = k === 'm' ? 2 : 3, hit = 0;
          for (i = 0; i < g.mines.length; i++) {
            var mn = g.mines[i], dx = mn.x - e.x, dy = mn.y - e.y;
            if (dx * dx + dy * dy <= mr * mr && mn.supImm <= 0) { mn.supT = md2; mn.supImm = md2 + 3; hit = 1; }
          }
          addFx(g, 13, e.x, e.y, 0, 0, 0.5, mr, '');
          if (hit) g.events.push('sweep');
        }
        break;
      case 'n': case 'N':
        if (act && (e.abT -= dt) <= 0) {
          e.abT += 4;
          var nr = k === 'n' ? 1.5 : 2, nn = k === 'n' ? 1 : 2, ndur = k === 'n' ? 1.5 : 2, picked = 0;
          var sup = g.towers.filter(function (t) { return TOWERS[t.type].cat === 'sup' && t.nullImm <= 0 && (t.x - e.x) * (t.x - e.x) + (t.y - e.y) * (t.y - e.y) <= nr * nr; });
          sup.sort(function (a, b) { return ((a.x - e.x) * (a.x - e.x) + (a.y - e.y) * (a.y - e.y)) - ((b.x - e.x) * (b.x - e.x) + (b.y - e.y) * (b.y - e.y)) || a.id - b.id; });
          for (i = 0; i < sup.length && picked < nn; i++) { sup[i].nullT = ndur; sup[i].nullImm = ndur + 3; picked++; addFx(g, 14, sup[i].x, sup[i].y, e.x, e.y, 0.5, 0, ''); }
          if (picked) { g.dirty = true; g.events.push('null'); }
        }
        break;
      case 'o': case 'O':
        if ((e.abT -= dt) <= 0 && !stunned) {
          e.abT += 3;
          if (e.slick && e.slick.life > e.slick.t && e.slick.by === e.id) e.slick.t = e.slick.life;
          e.slick = addZone(g, 'slick', e.x, e.y, k === 'o' ? 0.6 : 0.8, k === 'o' ? 2 : 3, k === 'o' ? 8 : 12, 0, null);
          if (e.slick) e.slick.by = e.id;
        }
        break;
      case 'p': case 'P':
        if (act && (e.abT -= dt) <= 0) {
          e.abT += k === 'p' ? 4 : 3.5;
          n = near(g, e.x, e.y, k === 'p' ? 1.5 : 2, Q);
          var cl = 0, cmax = k === 'p' ? 3 : 4;
          for (i = 0; i < n && cl < cmax; i++) {
            o = Q[i];
            if (o === e || isBoss(o) || !(o.slowT > 0 || o.burnT > 0 || o.corT > 0)) continue;
            o.slowT = 0; o.slowF = 0; o.burnT = 0; o.burnD = 0; o.corT = 0; o.corD = 0; cl++;
          }
          if (cl) { addFx(g, 8, e.x, e.y, 0, 0, 0.5, 1.5, '*'); g.events.push('cleanse'); }
        }
        break;
      case 'q': case 'Q': g.qList.push(e); break;
      case 'r': case 'R':
        if (e.hurtT >= (k === 'r' ? 3 : 2) && e.hp < e.maxHp && e.noRegT <= 0) {
          var rate = (k === 'r' ? 0.08 : 0.12) * (e.burnT > 0 ? 1 - e.burnCut : 1);
          e.hp = Math.min(e.maxHp, e.hp + e.maxHp * rate * dt);
        }
        break;
      case 's': case 'S':
        if (e.sprT > 0) e.sprT = tick(e.sprT, dt);
        if ((e.abT -= dt) <= 0) { e.abT += k === 's' ? 5 : 4.5; e.sprT = k === 's' ? 1.2 : 1.6; }
        break;
      case 't': case 'T':
        if (!stunned && (e.abT -= dt) <= 0) {
          e.buried = e.buried ? 0 : 1;
          e.abT += e.buried ? (k === 't' ? 2 : 2.5) : (k === 't' ? 3 : 2.5);
          g.events.push(e.buried ? 'burrow' : 'emerge');
        }
        break;
      case 'u': case 'U': case 'v': case 'V':
        if (act && (e.abT -= dt) <= 0) {
          e.abT += 0.25;
          var au = k === 'u' || k === 'U', ar = k === 'u' ? 1.2 : k === 'U' ? 1.6 : k === 'v' ? 1 : 1.5, av = k === 'u' ? 0.4 : k === 'U' ? 0.55 : k === 'v' ? 0.2 : 0.3;
          n = near(g, e.x, e.y, ar, Q);
          for (i = 0; i < n; i++) {
            o = Q[i];
            if (o === e || isBoss(o)) continue;
            if (au) { if (av >= o.umbA || o.umbT <= 0) o.umbA = av; o.umbT = 0.35; }
            else { if (av >= o.auraH || o.auraT <= 0) o.auraH = av; o.auraT = 0.35; }
          }
        }
        break;
      case 'w': case 'W':
        if ((e.abT -= dt) <= 0) { e.high = e.high ? 0 : 1; e.abT += e.high ? (k === 'w' ? 3 : 4) : (k === 'w' ? 3 : 2); }
        break;
      case 'y': case 'Y':
        if (act && (e.abT -= dt) <= 0) { e.abT += 5; suppressTowers(g, e, k === 'y' ? 2 : 2.25, k === 'y' ? 2 : 3, 'yowl', k === 'y' ? 0.25 : 0.4); }
        break;
      case '1':
        if ((e.abT -= dt) <= 0) {
          e.abT += 0.5;
          n = near(g, e.x, e.y, 2, Q);
          e.alone = 1;
          for (i = 0; i < n; i++) if (Q[i] !== e) { e.alone = 0; break; }
        }
        break;
      case '2':
        if ((e.abT -= dt) <= 0) {
          e.abT += 0.25;
          var pr = e.pr;
          if (!pr || !pr.alive || pr.id !== e.partner) { pr = null; for (i = 0; i < g.enemies.length; i++) if (g.enemies[i].id === e.partner && g.enemies[i].alive) { pr = g.enemies[i]; break; } e.pr = pr; }
          if (pr && (pr.x - e.x) * (pr.x - e.x) + (pr.y - e.y) * (pr.y - e.y) <= 9) { if (e.tempAr <= 8 || e.tempArT <= 0) e.tempAr = 8; e.tempArT = 0.4; }
        }
        break;
      case '3': if (e.guardT > 0) e.guardT = tick(e.guardT, dt); break;
      case '4':
        if (act && (e.abT -= dt) <= 0) {
          e.abT += 1;
          n = near(g, e.x, e.y, 2, Q);
          var picks = nearestOthers(e, Q, n, 4);
          for (i = 0; i < picks; i++) { o = Q[i]; if (o.tempAr <= 8 || o.tempArT <= 0) o.tempAr = Math.max(o.tempArT > 0 ? o.tempAr : 0, 8); o.tempArT = 1.5; }
        }
        break;
      case '5':
        if (!e.stole && e.d >= routeOf(g, e).len * 0.5) {
          e.stole = 1;
          var take = Math.min(20, Math.max(0, g.gold));
          if (take > 0) { g.gold -= take; e.stolen = take; addFx(g, 5, e.x, e.y, 0, 0, 1.1, 1, '-$' + take); g.events.push('steal'); }
        }
        break;
      case '6':
        if (act && (e.abT -= dt) <= 0) { e.abT += 4; e.adaptK = -1; }
        break;
      case '7':
        if (e.warnT > 0) {
          if (!act) { e.warnT = 0; e.stepAcc = 0; }
          else if ((e.warnT -= dt) <= 0) {
            e.warnT = 0;
            if (routeOf(g, e).len - e.d > 3) { e.d += 1; e.blinks++; placeEnemy(g, e); e.px = e.x; e.py = e.y; addFx(g, 14, e.x, e.y, 0, 0, 0.4, 1, '»'); g.events.push('blink'); }
          }
        } else if (e.stepAcc >= 7 && e.blinks < 2 && act && routeOf(g, e).len - e.d > 4) { e.stepAcc = 0; e.warnT = 1.5; }
        break;
      case '9':
        if (e.count > 0 && act && (e.abT -= dt) <= 0) {
          e.abT += 1.5;
          if (--e.count <= 0) { for (i = 0; i < 3; i++) spawnChild(g, 'a', e, e.d - 0.25 * i); g.events.push('summon'); }
        }
        break;
      case '!':
        if (act && (e.abT -= dt) <= 0) {
          e.abT += 8;
          n = near(g, e.x, e.y, 3, Q);
          for (i = 0; i < n; i++) { o = Q[i]; if (o !== e && !isBoss(o)) { o.alarmH = 0.3; o.alarmT = 3; } }
          addFx(g, 4, e.x, e.y, 0, 0, 0.6, 3, '!'); g.events.push('alarm');
        }
        break;
      default:
        if (E.boss) bossStep(g, e, dt, act, Q);
    }
    // movement
    var v = speedOf(e);
    if (v > 0) {
      e.d += v * dt;
      if (k === '7') e.stepAcc += v * dt;
      var R = routeOf(g, e);
      if (e.d >= R.len) { leak(g, e); return; }
    }
    placeEnemy(g, e);
  }
  function speedOf(e) {
    if (e.stunT > 0 || e.revT > 0) return 0;
    var k = e.k, v = e.spd;
    if (k === 's' || k === 'S') { if (e.sprT > 0) v = (k === 's' ? 2.4 : 2.7) * (e.spd / ENEMIES[k].spd); }
    else if (k === 'z' || k === 'Z') { if (frenzy(e)) v *= k === 'z' ? 1.75 : 2; }
    else if (k === '1') { if (e.alone) v = 1.8 * (e.spd / ENEMIES[k].spd); }
    else if (k === 'k' || k === 'K') v *= 1 + (k === 'k' ? 0.05 : 0.07) * e.kStack;
    else if (k === 'Ω') { if (e.openT > 0) v *= 1.4; }
    else if (k === '¶') { if (e.surgeT > 0) v *= 1.3; }
    if (e.escT > 0) v *= 1 + e.escF;
    if (e.dashT > 0) v *= 1.25;
    var hs = (e.auraT > 0 ? e.auraH : 0) + (e.alarmT > 0 ? e.alarmH : 0);
    if (hs > 0) v *= 1 + (hs > 0.6 ? 0.6 : hs);
    var s = e.slowT > 0 ? e.slowF : 0;
    if (e.wetT > 0 && e.wetS > s) s = Math.min(e.wetS, slowCap(e));
    return v * (1 - s);
  }
  // Order Q[0..n) so its first `want` are the nearest others (not e, not bosses); returns how many.
  function nearestOthers(e, Q, n, want) {
    var m = 0, i;
    for (i = 0; i < n; i++) if (Q[i] !== e && !isBoss(Q[i])) Q[m++] = Q[i];
    for (i = 0; i < m && i < want; i++) {
      var bi = i, bd = 1e9;
      for (var j = i; j < m; j++) { var dx = Q[j].x - e.x, dy = Q[j].y - e.y, d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; bi = j; } }
      var tmp = Q[i]; Q[i] = Q[bi]; Q[bi] = tmp;
    }
    return Math.min(m, want);
  }
  // Jammer / Yowler: the `cnt` nearest attacking towers within r.
  function suppressTowers(g, e, r, cnt, kind, f) {
    var list = [], i;
    for (i = 0; i < g.towers.length; i++) {
      var t = g.towers[i];
      if (!isAttack(t.type) || t.supImm > 0) continue;
      var dx = t.x - e.x, dy = t.y - e.y, d2 = dx * dx + dy * dy;
      if (d2 <= r * r) list.push({ t: t, d: d2 });
    }
    list.sort(function (a, b) { return a.d - b.d || a.t.id - b.t.id; });
    for (i = 0; i < list.length && i < cnt; i++) {
      var t2 = list[i].t, dur = 2 * (1 - Math.min(0.75, t2.supRed));
      if (kind === 'jam') { if (f >= t2.jamF || t2.jamT <= 0) t2.jamF = f; t2.jamT = Math.max(t2.jamT, dur); }
      else { if (f >= t2.yowlF || t2.yowlT <= 0) t2.yowlF = f; t2.yowlT = Math.max(t2.yowlT, dur); }
      t2.supImm = dur + 3;
      addFx(g, 14, t2.x, t2.y, e.x, e.y, 0.6, kind === 'jam' ? 1 : 2, '');
    }
    if (list.length) { addFx(g, 13, e.x, e.y, 0, 0, 0.5, r, ''); g.events.push(kind); }
  }
  function bossStep(g, e, dt, act, Q) {
    var k = e.k, n, i, o, below = e.hp < e.maxHp * 0.5;
    if (e.warnT > 0) e.warnT = tick(e.warnT, dt);
    if (e.openT > 0) e.openT = tick(e.openT, dt);
    if (e.surgeT > 0) e.surgeT = tick(e.surgeT, dt);
    switch (k) {
      case '@':
        if ((e.abT -= dt) <= 0) { e.abT += 10; e.warnT = 1.5; e.abT2 = 1; }
        if (e.abT2 && e.warnT <= 0) {
          e.abT2 = 0;
          n = near(g, e.x, e.y, 3, Q);
          var pulled = 0;
          for (i = 0; i < n && pulled < 6; i++) {
            o = Q[i];
            if (o === e || isBoss(o) || o.fly || o.ri !== e.ri || o.d <= e.d) continue;
            o.d -= Math.min(1, o.d - e.d); placeEnemy(g, o); o.px = o.x; o.py = o.y; pulled++;
          }
          addFx(g, 8, e.x, e.y, 0, 0, 0.7, 3, '@'); g.events.push('pull');
        }
        break;
      case 'Ω':
        if ((e.abT -= dt) <= 0) { e.abT += 9; e.openT = below ? 3 : 2; g.events.push('open'); }
        break;
      case '₩':
        if (e.flyT > 0) { if ((e.flyT -= dt) <= 0) { e.flyT = 0; g.events.push('land'); } }
        else if (e.abT2) { if (e.warnT <= 0) { e.abT2 = 0; e.flyT = 4; g.events.push('takeoff'); } }
        else if ((e.abT -= dt) <= 0) { e.abT += 12; e.warnT = 2; e.abT2 = 1; }
        break;
      case '₼':
        if ((e.abT -= dt) <= 0) {
          if (e.phase === 2) { e.mode = e.mode ? 0 : 1; e.phase = e.mode; e.abT += 5; }
          else { e.phase = 2; e.abT += 1; }
        }
        break;
      case '₷':
        if (act && e.healed < e.maxHp * 0.15 && e.hp < e.maxHp) {
          var anchor = false;
          n = near(g, e.x, e.y, 3, Q);
          for (i = 0; i < n; i++) if (Q[i].root === e.id && Q[i].k === 'h') { anchor = true; break; }
          if (anchor) { var hv = Math.min(e.maxHp * 0.01 * dt, e.maxHp * 0.15 - e.healed, e.maxHp - e.hp); e.hp += hv; e.healed += hv; }
        }
        break;
      case '&':
        if (e.linkT > 0) {
          e.linkT = tick(e.linkT, dt);
          if (e.links) for (i = 0; i < e.links.length; i++) { o = e.links[i]; if (o.alive && ((o.x - e.x) * (o.x - e.x) + (o.y - e.y) * (o.y - e.y) > 9)) o.lid = -1; }
        }
        if (act && (e.abT -= dt) <= 0) {
          e.abT += 10;
          n = near(g, e.x, e.y, 3, Q);
          var cnt = nearestOthers(e, Q, n, 3);
          e.links = [];
          for (i = 0; i < cnt; i++) { Q[i].lid = Q[i].id; e.links.push(Q[i]); }
          if (cnt) { e.linkT = 5; g.events.push('link'); }
        }
        break;
      case '%':
        if ((e.abT -= dt) <= 0) { e.abT += 10; e.openT = 2; g.events.push('open'); }
        break;
      case '¶':
        if (e.abT2) {
          if (e.warnT <= 0) {
            e.abT2 = 0;
            var md = MD[g.map];
            if (md.routes.length > 1) {
              var R0 = md.routes[e.ri], f = e.d / R0.len, ni = (e.ri + 1) % md.routes.length;
              e.ri = ni; e.seg = 0; e.d = f * md.routes[ni].len; placeEnemy(g, e); e.px = e.x; e.py = e.y;
              addFx(g, 14, e.x, e.y, 0, 0, 0.6, 1, '¶'); g.events.push('shift');
            } else { e.surgeT = 3; g.events.push('surge'); }
          }
        } else if ((e.abT -= dt) <= 0) { e.abT += 14; e.warnT = 3; e.abT2 = 1; }
        break;
      case '¤':
        if (e.hideT > 0) { if ((e.hideT -= dt) <= 0) { e.hideT = 0; e.sh = 0; } }
        else if ((e.abT -= dt) <= 0) { e.abT += 12; e.hideT = 4; e.sh = e.shMax = Math.ceil(1200 * hpScale(e.L) * g.hpMul); g.events.push('hide'); }
        break;
      case '※':
        if (e.veilT > 0) e.veilT = tick(e.veilT, dt);
        if (e.prevT > 0 && (e.prevT -= dt) <= 0) {
          e.prevT = 0;
          if (e.mode === 1 && e.summoned < 12) { if (act) { for (i = 0; i < 3; i++) spawnChild(g, 'm', e, e.d - 0.3 * (i + 1)); e.summoned += 3; g.events.push('summon'); } }
          else if (e.mode === 2) e.veilT = 4;
        }
        if ((e.abT -= dt) <= 0) {
          e.abT += 12; e.prevT = 3;
          e.mode = below ? (e.mode + 2) % 3 : (e.mode + 1) % 3;
          g.events.push('mode');
        }
        break;
    }
  }

  // ---------------- targeting ----------------
  function maskOf(t) { var g2 = t.st.tgt; return g2 === 'both' ? 3 : g2 === 'ground' ? 1 : g2 === 'air' ? 2 : 3; }
  // Can tower t see (detect) enemy e at squared distance d2?
  function visibleTo(g, t, e, d2) {
    if (!isHidden(e) || e.revealT > 0) return true;
    if (t && t.st && t.st.det) return true;
    return !!(t && g.mod.spot && d2 <= g.mod.spot * g.mod.spot && isAttack(t.type));
  }
  // Candidates for t within range r into out; filter: 0 any, 1 shielded, 2 displaceable, 3 unmarked original, 4 unmarked elite.
  function gather(g, t, r, sight, out, filter, cx, cy) {
    var x = cx == null ? t.x : cx, y = cy == null ? t.y : cy;
    var n = near(g, x, y, r, out), m = 0, mask = maskOf(t), minR = t.st.minR || 0;
    for (var i = 0; i < n; i++) {
      var e = out[i];
      if (e.revT > 0 || e.prot > 0 || !(layerOf(e) & mask)) continue;
      var dx = e.x - t.x, dy = e.y - t.y, d2 = dx * dx + dy * dy;
      if (minR && d2 < minR * minR) continue;
      if (!visibleTo(g, t, e, d2)) continue;
      if (sight && !sees(t, e.x, e.y)) continue;
      if (filter === 1 && !(e.sh > 0)) continue;
      if (filter === 2 && (isBoss(e) && !t.st.slow || e.k === 'g' || e.k === 'G' || (!isBoss(e) && (e.dispImm > 0 || e.disp >= 3)))) continue;
      if (filter >= 3 && (!e.orig || e.markT > 0 || (filter === 4 && !(ENEMIES[e.k].cap || isBoss(e))))) continue;
      out[m++] = e;
    }
    return m;
  }
  function score(t, e) {
    var md = t.mode;
    if (md === 0) return -e.rem;
    if (md === 1) return e.rem;
    if (md === 2) return e.hp + e.sh;
    if (md === 3) return -(e.hp + e.sh);
    var dx = e.x - t.x, dy = e.y - t.y; return -(dx * dx + dy * dy);
  }
  // Move the best k of out[0..n) to the front, best first. Returns min(k, n).
  function rank(t, out, n, k) {
    for (var i = 0; i < n && i < k; i++) {
      var bi = i, bs = score(t, out[i]);
      for (var j = i + 1; j < n; j++) { var s = score(t, out[j]); if (s > bs || (s === bs && out[j].id < out[bi].id)) { bs = s; bi = j; } }
      var tmp = out[i]; out[i] = out[bi]; out[bi] = tmp;
    }
    return Math.min(n, k);
  }
  // Order out[0..n) by distance to (x, y), nearest first, keeping at most k.
  var DIST = new Float64Array(MAX_ENEMIES + 8);
  function byDist(out, n, x, y, k) {
    var i, j;
    for (i = 0; i < n; i++) { var dx = out[i].x - x, dy = out[i].y - y; DIST[i] = dx * dx + dy * dy; }
    for (i = 0; i < n && i < k; i++) {
      var bi = i;
      for (j = i + 1; j < n; j++) if (DIST[j] < DIST[bi]) bi = j;
      if (bi !== i) { var te = out[i]; out[i] = out[bi]; out[bi] = te; var td = DIST[i]; DIST[i] = DIST[bi]; DIST[bi] = td; }
    }
    return Math.min(n, k);
  }
  var _pp = { x: 0, y: 0, fx: 1, fy: 0, seg: 0 };
  // Where e will be in s seconds at its current speed (for shells).
  function predict(g, e, s) {
    var R = routeOf(g, e), d = Math.min(R.len, e.d + speedOf(e) * s), p = routePos(R, d, e.seg, _pp);
    return { x: p.x - p.fy * e.lat, y: p.y + p.fx * e.lat };
  }

  // ---------------- hits and statuses ----------------
  function dtOf(t) {
    var s = t.st;
    if (TOWERS[t.type].shape === 'prism') return PRISM_T[t.ptype];
    var ty = TOWERS[t.type].type;
    return ty === 'none' ? PHYS : DTI[ty];
  }
  // A primary hit from tower t (with its on-hit effects). Returns damage dealt.
  function strike(g, t, e, dmg, ty, fl, primary) {
    var st = t.st, E = ENEMIES[e.k];
    var done = hurt(g, e, dmg, ty, t, fl);
    if (!e.alive) return done;
    if (st.slow && st.shape !== 'gate') applySlow(e, st.slow, st.slowDur || 2, false);
    if (st.freezeN && !E.boss) {
      if (e.frzBy === t.id) e.frzN++; else { e.frzBy = t.id; e.frzN = 1; }
      if (e.frzN >= st.freezeN && e.frzCd <= 0) { e.frzN = 0; if (applyStun(e, st.freezeDur)) { e.frzCd = 5; addFx(g, 4, e.x, e.y, 0, 0, 0.35, 0.5, '*'); } }
    }
    if (st.brittle) { e.britA = Math.max(e.britT > 0 ? e.britA : 0, st.brittle); e.britT = st.brittleDur || 3; }
    if (st.burn) applyBurn(e, st.burn, st.burnDur || 3, t, st.regenCut);
    if (st.corrode || st.armRed) applyCorrode(e, st.corrode || 0, st.corrodeDur || 3, t, st.armRed || 0, st.armRedDur || 4);
    if (st.resCut) { e.resCutA = Math.max(e.resCutT > 0 ? e.resCutA : 0, st.resCut); e.resCutT = 4; }
    if (st.stun && st.shape === 'chain' && e.stunCd <= 0) { if (applyStun(e, st.stun)) e.stunCd = st.stunCd || 4; }
    if (st.silence && st.shape === 'ring' && e.silCd <= 0) { applySilence(e, st.silence); e.silCd = st.silenceCd || 5; }
    if (st.revealHit) e.revealT = Math.max(e.revealT, st.revealHit);
    if (primary && t.echoF > 0 && t.echoT <= 0 && !(fl & F_ECHO)) {
      var frac = Math.min(t.echoF, 0.5 - Math.min(0.5, t.bDmg));
      if (frac > 0) { t.echoT = t.echoCdL || 4; queueEv(g, 'echo', 0.3, e.x, e.y, e, t, dmg * frac, ty); }
    }
    return done;
  }

  // ---------------- projectiles ----------------
  function launch(g, t, e, kind, dmg, ty, extra) {
    if (g.proj.length >= MAX_PROJ) return null;
    var p = g.ppool.length ? g.ppool.pop() : {};
    p.kind = kind; p.x = p.px = t.x; p.y = p.py = t.y - 0.1; p.tg = e; p.tid = e.id; p.tx = e.x; p.ty = e.y;
    p.spd = t.st.pspd || 10; p.dmg = dmg; p.dt = ty; p.t = t; p.extra = extra || 0; p.g = TOWERS[t.type].g;
    g.proj.push(p);
    return p;
  }
  function stepProj(g, dt) {
    var pr = g.proj, ql = g.qList, i, j;
    for (i = pr.length - 1; i >= 0; i--) {
      var p = pr[i], tg = p.tg;
      p.px = p.x; p.py = p.y;
      var live = tg && tg.id === p.tid && tg.alive;
      if (live) { p.tx = tg.x; p.ty = tg.y; }
      else if (p.kind !== 1) { pr[i] = pr[pr.length - 1]; pr.pop(); p.tg = null; p.t = null; g.ppool.push(p); continue; }
      var sp = p.spd;
      for (j = 0; j < ql.length; j++) {
        var q = ql[j], qr = q.k === 'q' ? 1 : 1.3, dx0 = q.x - p.x, dy0 = q.y - p.y;
        if (q.alive && q.silT <= 0 && dx0 * dx0 + dy0 * dy0 <= qr * qr) { sp *= q.k === 'q' ? 0.5 : 0.25; break; }
      }
      var dx = p.tx - p.x, dy = p.ty - p.y, d = Math.sqrt(dx * dx + dy * dy), s = sp * dt;
      if (d <= s) {
        p.x = p.tx; p.y = p.ty;
        pr[i] = pr[pr.length - 1]; pr.pop();
        impact(g, p, live);
        p.tg = null; p.t = null; g.ppool.push(p);
      } else { p.x += dx / d * s; p.y += dy / d * s; }
    }
  }
  function impact(g, p, live) {
    var t = p.t, e = p.tg;
    if (p.kind === 1) {                                       // flak: burst around the target (or where it was)
      var st = t.st;
      if (live && (e.dodT > 0)) { addFx(g, 12, e.x, e.y, 0, 0, 0.5, 0, 'miss'); return; }
      if (!(st.splash > 0)) { if (live) strike(g, t, e, p.dmg, p.dt, F_PROJ | F_HIT, true); return; }
      blast(g, t, p.x, p.y, st.splash, st.maxT || 5, p.dmg, p.dt, maskOf(t), F_SPLASH, st.groundMul || 1);
      addFx(g, 1, p.x, p.y, 0, 0, 0.3, st.splash, 'f');
      return;
    }
    if (!live) return;
    if (p.kind === 2) {                                       // shield drain: shields only
      if (e.sh > 0) { var dr = Math.min(e.sh, p.dmg); e.sh -= dr; t.dmg += dr; if (t.st.lockSh) e.lockShT = isBoss(e) ? 1 : t.st.lockSh; addFx(g, 4, e.x, e.y, 0, 0, 0.3, 0.45, '∞'); g.events.push('drain'); }
      return;
    }
    if (e.dodT > 0) { addFx(g, 12, e.x, e.y, 0, 0, 0.5, 0, 'miss'); g.events.push('miss'); return; }
    strike(g, t, e, p.dmg + p.extra, p.dt, F_PROJ | F_HIT, true);
  }

  // Explosion at (x, y): up to maxT nearest eligible enemies, each hit once.
  function blast(g, t, x, y, rad, maxT, dmg, ty, mask, fl, groundMul) {
    var Q = g.Q3, n = near(g, x, y, rad, Q), m = 0, i;
    for (i = 0; i < n; i++) {
      var e = Q[i];
      if (e.revT > 0 || e.prot > 0 || !(layerOf(e) & mask)) continue;
      if (isHidden(e) && !(e.revealT > 0) && !(t && t.st.det)) continue;
      Q[m++] = e;
    }
    m = byDist(Q, m, x, y, maxT);
    var st = t ? t.st : null;
    for (i = 0; i < m; i++) {
      var e2 = Q[i], dd = dmg * (groundMul && groundMul !== 1 && layerOf(e2) === 1 ? groundMul : 1);
      if (st) {
        hurt(g, e2, dd, ty, t, fl);
        if (e2.alive) {
          if (st.slow && st.shape !== 'arc') applySlow(e2, st.slow, st.slowDur || 2, false);
          if (st.shape === 'mine' && st.slow) applySlow(e2, st.slow, st.slowDur || 3, false);
          if (st.corrode) applyCorrode(e2, st.corrode, st.corrodeDur || 3, t, st.armRed || 0, st.armRedDur || 4);
        }
      } else hurt(g, e2, dd, ty, null, fl);
    }
    return m;
  }

  // ---------------- delayed events (shells, second blasts, echoes, return passes) ----------------
  function queueEv(g, kind, delay, x, y, e, t, dmg, ty, a, b, c) {
    if (g.ev.length >= MAX_EV) return null;
    var v = g.evpool.length ? g.evpool.pop() : {};
    v.kind = kind; v.t = delay; v.x = x; v.y = y; v.e = e; v.eid = e ? e.id : 0; v.src = t; v.dmg = dmg; v.ty = ty; v.a = a || 0; v.b = b || 0; v.c = c || 0;
    g.ev.push(v);
    return v;
  }
  function stepEv(g, dt) {
    var ev = g.ev, i;
    for (i = ev.length - 1; i >= 0; i--) {
      var v = ev[i];
      if ((v.t -= dt) > 0) continue;
      ev[i] = ev[ev.length - 1]; ev.pop();
      runEv(g, v);
      v.e = null; v.src = null; g.evpool.push(v);
    }
  }
  function runEv(g, v) {
    var t = v.src, st = t.st, e = v.e, live = e && e.alive && e.id === v.eid;
    switch (v.kind) {
      case 'arc':
        blast(g, t, v.x, v.y, st.splash, st.maxT || 6, v.dmg, v.ty, maskOf(t), F_SPLASH);
        addFx(g, 1, v.x, v.y, 0, 0, 0.35, st.splash, '');
        g.events.push('boom');
        if (st.after) queueEv(g, 'after', st.afterT || 0.4, v.x, v.y, null, t, st.after, v.ty);
        if (st.crater) { var z = addZone(g, 'crater', v.x, v.y, st.splash, st.craterDur || 3, st.crater, 8, t); }
        if (st.cluster) queueEv(g, 'cluster', 0.35, v.x, v.y, null, t, st.cluster, v.ty);
        break;
      case 'after':
        blast(g, t, v.x, v.y, st.splash, st.maxT || 8, v.dmg, v.ty, maskOf(t), F_SPLASH);
        addFx(g, 1, v.x, v.y, 0, 0, 0.3, st.splash * 0.8, '');
        break;
      case 'cluster':
        for (var q = 0; q < 6; q++) {
          var a = q * Math.PI / 3, cx = v.x + Math.cos(a) * 1.1, cy = v.y + Math.sin(a) * 1.1;
          blast(g, t, cx, cy, 0.45, 6, v.dmg, v.ty, maskOf(t), F_SPLASH);
          addFx(g, 1, cx, cy, 0, 0, 0.25, 0.45, '');
        }
        break;
      case 'shot':                                            // a burst's later shot (Double Tap)
        if (!live || !inReach(g, t, e)) { var n = gather(g, t, effRange(t), true, g.Q, 0); if (!rank(t, g.Q, n, 1)) break; e = g.Q[0]; }
        strike(g, t, e, v.dmg, v.ty, F_HIT, true);
        addFx(g, 3, t.x, t.y, e.x, e.y, 0.18, 0, '');
        g.events.push('snipe');
        break;
      case 'ret':                                             // boomerang coming back
        linePass(g, t, t.x, t.y, v.a, v.b, v.c, v.dmg, v.ty, st.pen || 3, st.keep || 0.8, st.lineW || 0.35);
        break;
      case 'echo':
        if (v.src.ric) {}
        var tgt = live ? e : null;
        if (t.echoRic && live) {
          var n2 = near(g, e.x, e.y, t.echoRic, g.Q3), pick = null;
          for (var k = 0; k < n2; k++) { var o = g.Q3[k]; if (o !== e && (layerOf(o) & maskOf(t)) && visibleTo(g, t, o, 0)) { pick = o; break; } }
          tgt = pick;
        }
        if (tgt && inReach(g, t, tgt)) { hurt(g, tgt, v.dmg, v.ty, t, F_HIT | F_ECHO); addFx(g, 4, tgt.x, tgt.y, 0, 0, 0.3, 0.4, '⌬'); }
        break;
    }
  }
  function inReach(g, t, e) {
    var dx = e.x - t.x, dy = e.y - t.y, r = effRange(t);
    return dx * dx + dy * dy <= r * r && (layerOf(e) & maskOf(t)) && visibleTo(g, t, e, dx * dx + dy * dy) && (!DIRECT[t.st.shape] || sees(t, e.x, e.y));
  }

  // ---------------- zones ----------------
  function addZone(g, kind, x, y, r, life, val, maxT, by) {
    if (g.zones.length > 120) return null;
    var z = g.zpool.length ? g.zpool.pop() : {};
    z.kind = kind; z.x = x; z.y = y; z.r = r; z.life = life; z.t = 0; z.val = val; z.maxT = maxT || 99; z.by = by; z.tick = 0;
    z.ri = 0; z.d0 = 0; z.d1 = 0; z.ux = 1; z.uy = 0; z.ang = 0; z.len = 0;
    g.zones.push(z);
    return z;
  }
  function stepZones(g, dt) {
    var zs = g.zones, Q = g.Q3, i, j, n, e, md = MD[g.map];
    for (i = zs.length - 1; i >= 0; i--) {
      var z = zs[i];
      z.t += dt;
      if (z.t >= z.life) { zs[i] = zs[zs.length - 1]; zs.pop(); z.by = null; g.zpool.push(z); continue; }
      switch (z.kind) {
        case 'slick':
          n = near(g, z.x, z.y, z.r, Q);
          for (j = 0; j < n; j++) { e = Q[j]; if (e.id === z.by || e.fly || isBoss(e)) continue; if (z.val >= e.tempAr || e.tempArT <= 0) e.tempAr = z.val; e.tempArT = Math.max(e.tempArT, 0.1); }
          break;
        case 'crater': case 'grav':
          n = near(g, z.x, z.y, z.r, Q);
          var c = 0;
          for (j = 0; j < n && c < z.maxT; j++) {
            e = Q[j];
            if (z.kind === 'crater' && e.fly) continue;
            if (isHidden(e) && !(e.revealT > 0)) continue;
            applySlow(e, z.val, 0.1, z.kind === 'grav'); c++;
          }
          break;
        case 'barr':
          var en = g.enemies, cnt = 0;
          for (j = 0; j < en.length && cnt < z.maxT; j++) {
            e = en[j];
            if (!e.alive || e.fly || e.ri !== z.ri || e.d < z.d0 || e.d > z.d1) continue;
            if (isHidden(e) && !(e.revealT > 0)) continue;
            applySlow(e, z.val, 0.1, true); cnt++;
          }
          break;
        case 'wake':
          if ((z.tick += dt) >= TICK) {
            z.tick -= TICK;
            n = near(g, z.x, z.y, z.len, Q);
            var hit = 0, half = z.ang * Math.PI / 360, cs = Math.cos(half);
            for (j = 0; j < n && hit < 6; j++) {
              e = Q[j];
              if (e.fly || (isHidden(e) && !(e.revealT > 0))) continue;
              var dx = e.x - z.x, dy = e.y - z.y, l = Math.sqrt(dx * dx + dy * dy) || 1;
              if ((dx * z.ux + dy * z.uy) / l < cs) continue;
              hurt(g, e, z.val * TICK, FIRE, z.by, F_DOT | F_AREA); hit++;
            }
          }
          break;
      }
    }
  }

  // ---------------- mines ----------------
  function minePoints(g, t) {
    if (t.mpts && t.mptsR === t.st.range) return t.mpts;
    var md = MD[g.map], r = t.st.range, pts = [];
    for (var ri = 0; ri < md.routes.length; ri++) {
      var R = md.routes[ri], S = md.samples[ri];
      for (var i = 0; i < S.length; i++) {
        var p = routePos(R, S[i], 0, _pp), dx = p.x - t.x, dy = p.y - t.y;
        if (dx * dx + dy * dy <= r * r) pts.push({ x: p.x, y: p.y, d: S[i] / R.len });
      }
    }
    pts.sort(function (a, b) { return b.d - a.d; });
    t.mpts = pts; t.mptsR = t.st.range;
    return pts;
  }
  function layMine(g, t) {
    var pts = minePoints(g, t), st = t.st, mine = null, i, own = [];
    if (!pts.length) return false;
    for (i = 0; i < g.mines.length; i++) if (g.mines[i].by === t) own.push(g.mines[i]);
    var spot = null;
    for (var k = 0; k < pts.length && !spot; k++) {
      var p = pts[(t.mineI + k) % pts.length], ok = true;
      for (i = 0; i < own.length; i++) { var dx = own[i].x - p.x, dy = own[i].y - p.y; if (dx * dx + dy * dy < 0.64) { ok = false; break; } }
      if (ok) { spot = p; t.mineI = (t.mineI + k + 1) % pts.length; }
    }
    if (!spot) return false;
    if (own.length >= (st.mines || 3)) {                      // full: replace the oldest
      var old = own[0];
      for (i = 1; i < own.length; i++) if (own[i].age > old.age) old = own[i];
      g.mines.splice(g.mines.indexOf(old), 1);
    }
    g.mines.push({ x: spot.x, y: spot.y, by: t, armT: 0.5, age: 0, life: st.mineLife || 12, supT: 0, supImm: 0 });
    return true;
  }
  function stepMines(g, dt) {
    var ms = g.mines, Q = g.Q3, i;
    for (i = ms.length - 1; i >= 0; i--) {
      var m = ms[i];
      m.age += dt;
      if (m.armT > 0) m.armT -= dt;
      if (m.supT > 0) m.supT -= dt;
      if (m.supImm > 0) m.supImm -= dt;
      if (m.age >= m.life) { ms.splice(i, 1); continue; }
      if (m.armT > 0 || m.supT > 0) continue;
      var t = m.by, st = t.st, n = near(g, m.x, m.y, st.trigR || 0.35, Q), trig = false;
      for (var j = 0; j < n; j++) { var e = Q[j]; if (!e.fly && layerOf(e) & 1 && !(isHidden(e) && !(e.revealT > 0)) && e.prot <= 0) { trig = true; break; } }
      if (!trig) continue;
      ms.splice(i, 1);
      blast(g, t, m.x, m.y, st.splash || 0.8, st.maxT || 6, st.dmg, PHYS, 1, F_SPLASH);
      addFx(g, 1, m.x, m.y, 0, 0, 0.35, st.splash || 0.8, 'x');
      g.events.push('boom');
    }
  }

  // ---------------- tower behaviour ----------------
  function aimAt(t, x, y) { t.ax = x - t.x; t.ay = y - t.y; t.fireT = 0.12; }
  // Rail / beam sweep / boomerang: hit up to pen enemies along a segment (clipped at ridges).
  function lineClip(g, t, ux, uy, L) {
    var md = MD[g.map], step = 0.25;
    for (var s = 0.5; s <= L; s += step) {
      var cx = Math.floor(t.x + ux * s), cy = Math.floor(t.y + uy * s);
      if (cx === t.c && cy === t.r) continue;
      if (cx >= 0 && cy >= 0 && cx < md.w && cy < md.h && md.grid[cy * md.w + cx] === TL.RIDGE) return s;
    }
    return L;
  }
  function linePass(g, t, x0, y0, ux, uy, L, dmg, ty, pen, keep, W) {
    var Q = g.Q3, n = near(g, x0 + ux * L / 2, y0 + uy * L / 2, L / 2 + W + 0.3, Q), m = 0, i, mask = maskOf(t), half = W / 2 + 0.25;
    for (i = 0; i < n; i++) {
      var e = Q[i];
      if (e.revT > 0 || e.prot > 0 || !(layerOf(e) & mask) || !visibleTo(g, t, e, 0)) continue;
      var dx = e.x - x0, dy = e.y - y0, al = dx * ux + dy * uy, pe = Math.abs(dx * uy - dy * ux);
      if (al < 0 || al > L || pe > half) continue;
      DIST[m] = al; Q[m++] = e;
    }
    for (i = 0; i < m && i < pen; i++) {
      var bi = i;
      for (var j = i + 1; j < m; j++) if (DIST[j] < DIST[bi]) bi = j;
      var te = Q[i]; Q[i] = Q[bi]; Q[bi] = te; var td = DIST[i]; DIST[i] = DIST[bi]; DIST[bi] = td;
    }
    var hits = Math.min(m, pen), d = dmg;
    for (i = 0; i < hits; i++) { strike(g, t, Q[i], d, ty, F_HIT, i === 0); d *= keep; }
    return hits;
  }
  function fire(g, t) {
    var st = t.st, sh = st.shape, range = effRange(t), Q = g.Q, n, k, i, e, ty = dtOf(t), dmg = st.dmg || 0;
    switch (sh) {
      case 'bolt': case 'drones': {
        n = gather(g, t, range, true, Q, 0);
        k = rank(t, Q, n, st.multi || 1);
        if (!k) return false;
        e = Q[0];
        var extra = 0;
        if (st.every5) { t.shots = (t.shots + 1) % 5; if (!t.shots) extra = st.every5; }
        if (st.focusT) {
          if (t.focusId === e.id) t.focusT += effInt(t); else { t.focusId = e.id; t.focusT = 0; }
          if (t.focusT >= st.focusT) dmg *= 1 + st.focusB;
        }
        aimAt(t, e.x, e.y);
        var count = st.multi || 1;
        for (i = 0; i < count; i++) launch(g, t, Q[i < k ? i : 0], sh === 'drones' ? 3 : 0, i ? st.dmg : dmg, ty, i ? 0 : extra);
        g.events.push(sh === 'drones' ? 'drone' : TOWERS[t.type].key === 'gatling' ? 'gat' : 'shot');
        return true;
      }
      case 'drain': {
        n = gather(g, t, range, true, Q, 1);
        k = rank(t, Q, n, st.multi || 1);
        if (!k) return false;
        aimAt(t, Q[0].x, Q[0].y);
        for (i = 0; i < k; i++) launch(g, t, Q[i], 2, st.drain, SHOCK, 0);
        return true;
      }
      case 'flak': {
        n = gather(g, t, range, true, Q, 0);
        if (!rank(t, Q, n, 1)) return false;
        aimAt(t, Q[0].x, Q[0].y);
        launch(g, t, Q[0], 1, dmg, ty, 0);
        g.events.push('flak');
        return true;
      }
      case 'hitscan': {
        n = gather(g, t, range, true, Q, 0);
        if (!rank(t, Q, n, 1)) return false;
        e = Q[0];
        aimAt(t, e.x, e.y);
        strike(g, t, e, dmg, ty, F_HIT, true);
        addFx(g, 3, t.x, t.y, e.x, e.y, 0.18, 0, '');
        for (i = 1; i < (st.burst || 1); i++) queueEv(g, 'shot', (st.burstGap || 0.2) * i, e.x, e.y, e, t, dmg, ty);
        g.events.push('snipe');
        return true;
      }
      case 'arc': {
        n = gather(g, t, range, false, Q, 0);
        if (!rank(t, Q, n, 1)) return false;
        e = Q[0];
        var fl = st.flight || 0.8, pos = predict(g, e, fl);
        aimAt(t, pos.x, pos.y);
        queueEv(g, 'arc', fl, pos.x, pos.y, null, t, dmg, ty);
        addFx(g, 9, t.x, t.y, pos.x, pos.y, fl, 0, TOWERS[t.type].key === 'acid' ? '·' : TOWERS[t.type].key === 'mortar' ? ',' : '•');
        g.events.push('lob');
        return true;
      }
      case 'ring': {
        n = gather(g, t, range, false, Q, 0);
        if (!n) return false;
        k = byDist(Q, n, t.x, t.y, st.maxT || 6);
        for (i = 0; i < k; i++) strike(g, t, Q[i], dmg, ty, F_AREA, i === 0);
        addFx(g, 4, t.x, t.y, 0, 0, 0.4, range, '≈');
        t.fireT = 0.2;
        g.events.push('pulse');
        return true;
      }
      case 'cone': case 'wind': {
        var gust = sh === 'wind';
        n = gather(g, t, range, !gust, Q, 0);
        if (!rank(t, Q, n, 1)) return false;
        e = Q[0];
        var ux = e.x - t.x, uy = e.y - t.y, ul = Math.sqrt(ux * ux + uy * uy) || 1;
        ux /= ul; uy /= ul;
        var half = (st.cone || 60) * Math.PI / 360, cs = Math.cos(half), m = 0;
        for (i = 0; i < n; i++) {
          var o = Q[i], dx = o.x - t.x, dy = o.y - t.y, l = Math.sqrt(dx * dx + dy * dy) || 1;
          if ((dx * ux + dy * uy) / l < cs && o !== e) continue;
          DIST[m] = Math.abs(dx * uy - dy * ux); Q[m++] = o;
        }
        k = Math.min(m, st.maxT || 5);
        for (i = 0; i < k; i++) {
          var bi = i;
          for (var j = i + 1; j < m; j++) if (DIST[j] < DIST[bi]) bi = j;
          var te = Q[i]; Q[i] = Q[bi]; Q[bi] = te; var td = DIST[i]; DIST[i] = DIST[bi]; DIST[bi] = td;
        }
        aimAt(t, e.x, e.y);
        for (i = 0; i < k; i++) {
          if (gust) { applySlow(Q[i], st.slow, st.slowDur || 3, false); if (st.land && !isBoss(Q[i]) && Q[i].fly) Q[i].landT = st.land; }
          else strike(g, t, Q[i], dmg, ty, F_AREA, i === 0);
        }
        if (st.wake) { var z = addZone(g, 'wake', t.x, t.y, range, st.wakeDur || 2, st.wake, 6, t); if (z) { z.ux = ux; z.uy = uy; z.ang = st.cone || 60; z.len = range; } }
        addFx(g, gust ? 11 : 7, t.x, t.y, ux, uy, gust ? 0.5 : 0.25, range, String(st.cone || 60));
        g.events.push(gust ? 'gust' : TOWERS[t.type].key === 'blade' ? 'slash' : 'flame');
        return true;
      }
      case 'chain': {
        n = gather(g, t, range, true, Q, 0);
        var chains = st.chains || 1;
        k = rank(t, Q, n, chains);
        if (!k) return false;
        var stamp = ++g.zap, starts = [];
        for (i = 0; i < k; i++) starts.push(Q[i]);
        aimAt(t, starts[0].x, starts[0].y);
        for (var c = 0; c < starts.length; c++) {
          var cur = starts[c];
          if (cur.zap === stamp) continue;
          cur.zap = stamp;
          var d = dmg;
          addFx(g, 2, t.x, t.y - 0.15, cur.x, cur.y, 0.2, 0, '');
          strike(g, t, cur, d, ty, F_HIT, c === 0);
          for (var jn = 0; jn < (st.chain || 3); jn++) {
            if ((cur.k === 'i' || cur.k === 'I') && !(cur.expT > 0)) break;      // insulators end the chain
            var nb = near(g, cur.x, cur.y, st.chainR || 1.4, g.Q2), nx = null, nd = 1e9;
            for (i = 0; i < nb; i++) {
              var o2 = g.Q2[i];
              if (o2.zap === stamp || o2.revT > 0 || o2.prot > 0 || !(layerOf(o2) & maskOf(t)) || !visibleTo(g, t, o2, 0)) continue;
              var ddx = o2.x - cur.x, ddy = o2.y - cur.y, dd = ddx * ddx + ddy * ddy;
              if (dd < nd) { nd = dd; nx = o2; }
            }
            if (!nx) break;
            nx.zap = stamp; d *= st.keep || 0.75;
            addFx(g, 2, cur.x, cur.y, nx.x, nx.y, 0.2, 0, '');
            strike(g, t, nx, d, ty, F_HIT, false);
            cur = nx;
          }
        }
        g.events.push('zap');
        return true;
      }
      case 'line': {
        n = gather(g, t, range, true, Q, 0);
        if (!rank(t, Q, n, 1)) return false;
        e = Q[0];
        var lx = e.x - t.x, ly = e.y - t.y, ll = Math.sqrt(lx * lx + ly * ly) || 1;
        lx /= ll; ly /= ll;
        aimAt(t, e.x, e.y);
        var L = lineClip(g, t, lx, ly, range);
        if (st.lines === 2) {
          var L2 = lineClip(g, t, -lx, -ly, range), L3 = lineClip(g, t, -ly, lx, range), L4 = lineClip(g, t, ly, -lx, range);
          linePass(g, t, t.x - lx * L2, t.y - ly * L2, lx, ly, L + L2, dmg, ty, st.pen || 6, st.keep || 0.8, st.lineW || 0.3);
          linePass(g, t, t.x + ly * L4, t.y - lx * L4, -ly, lx, L3 + L4, dmg, ty, st.pen || 6, st.keep || 0.8, st.lineW || 0.3);
          addFx(g, 10, t.x - lx * L2, t.y - ly * L2, t.x + lx * L, t.y + ly * L, 0.25, 0, '=');
          addFx(g, 10, t.x + ly * L4, t.y - lx * L4, t.x - ly * L3, t.y + lx * L3, 0.25, 0, '=');
        } else {
          linePass(g, t, t.x, t.y, lx, ly, L, dmg, ty, st.pen || 4, st.keep == null ? 0.75 : st.keep, st.lineW || 0.25);
          addFx(g, 10, t.x, t.y, t.x + lx * L, t.y + ly * L, 0.25, 0, '=');
        }
        g.events.push('rail');
        return true;
      }
      case 'boomer': {
        n = gather(g, t, range, true, Q, 0);
        if (!rank(t, Q, n, 1)) return false;
        e = Q[0];
        var bx = e.x - t.x, by = e.y - t.y, bl = Math.sqrt(bx * bx + by * by) || 1, fan = st.fan || 1;
        aimAt(t, e.x, e.y);
        for (i = 0; i < fan; i++) {
          var a0 = Math.atan2(by, bx) + (fan > 1 ? (i - (fan - 1) / 2) * 25 * Math.PI / 180 : 0), ux2 = Math.cos(a0), uy2 = Math.sin(a0);
          var LB = lineClip(g, t, ux2, uy2, range);
          linePass(g, t, t.x, t.y, ux2, uy2, LB, dmg, ty, st.pen || 3, st.keep || 0.8, st.lineW || 0.35);
          queueEv(g, 'ret', 2 * LB / 9, 0, 0, null, t, dmg * (st.retMul || 1), ty, ux2, uy2, LB);
          addFx(g, 15, t.x, t.y, t.x + ux2 * LB, t.y + uy2 * LB, 2 * LB / 9 + 0.1, 0, '');
        }
        g.events.push('throw');
        return true;
      }
      case 'prism': {
        n = gather(g, t, range, true, Q, 0);
        k = rank(t, Q, n, st.multi || 3);
        if (!k) return false;
        aimAt(t, Q[0].x, Q[0].y);
        for (i = 0; i < k; i++) {
          var pt = ty;
          if (st.auto) {
            var best = -1, bv = -1;
            for (var pi = 0; pi < 4; pi++) {
              var T2 = PRISM_T[pi], v2 = (1 - resist(Q[i], T2, t)) * (ENEMIES[Q[i].k].weak === T2 ? 1.5 : 1);
              if (v2 > bv + 1e-9) { bv = v2; best = T2; }
            }
            pt = best;
          }
          strike(g, t, Q[i], i ? (st.sec || dmg * 0.5) : dmg, pt, F_HIT, i === 0);
          var fx = addFx(g, 3, t.x, t.y, Q[i].x, Q[i].y, 0.2, 1, '');
          if (fx) fx.c = pt;
        }
        g.events.push('prism');
        return true;
      }
      case 'mine':
        if (!layMine(g, t)) return false;
        g.events.push('mine');
        return true;
      case 'etch': case 'mute': case 'tide': case 'chrono': case 'gate': {
        var filt = sh === 'gate' ? 2 : 0;
        n = gather(g, t, range, sh === 'gate' && !st.pulseR, Q, filt);
        if (!rank(t, Q, n, 1)) return false;
        e = Q[0];
        var R = st.pulseR || 0, cxp = e.x, cyp = e.y, tgts = 1;
        if (R > 0) {
          n = gather(g, t, R, false, Q, filt, cxp, cyp);
          tgts = byDist(Q, n, cxp, cyp, st.maxT || 6);
        } else Q[0] = e;
        if (sh === 'tide') { var mk = maskOf(t); for (i = 0; i < tgts; i++) if (!(layerOf(Q[i]) & mk)) { Q.splice(i, 1); i--; tgts--; } }
        aimAt(t, cxp, cyp);
        for (i = 0; i < tgts; i++) {
          var o3 = Q[i], boss = isBoss(o3);
          if (sh === 'etch') { var ab = st.armBreak; if (ab >= o3.etchA || o3.etchT <= 0) o3.etchA = ab; o3.etchT = st.armBreakDur || 5; if (st.noRegen) o3.noRegT = boss ? 1.5 : st.noRegen; }
          else if (sh === 'mute') applySilence(o3, st.silence);
          else if (sh === 'tide') { if (st.wet >= o3.wetA || o3.wetT <= 0) o3.wetA = st.wet; o3.wetT = st.wetDur || 4; if (st.wetSlow) o3.wetS = st.wetSlow; }
          else if (sh === 'chrono') {
            if (st.delay) { if (o3.frzCd <= 0) { o3.delayT = boss ? 0.5 : st.delay; o3.frzCd = 6; } applySlow(o3, st.slow, st.slowDur || 2, false); }
            else if (boss) applySlow(o3, st.bossSlow, st.bossSlowDur || 1, false);
            else applyStun(o3, st.stun);
          } else if (sh === 'gate') {
            if (!boss) displace(g, o3, st.tele);
            if (st.slow) applySlow(o3, st.slow, st.slowDur || 3, false);
          }
        }
        addFx(g, 4, cxp, cyp, 0, 0, 0.45, R || 0.6, TOWERS[t.type].g);
        g.events.push(sh);
        return tgts > 0;
      }
      case 'grav': {
        n = gather(g, t, range, false, Q, 0);
        if (!rank(t, Q, n, 1)) return false;
        e = Q[0];
        var zf = addZone(g, 'grav', e.x, e.y, st.field, st.fieldDur || 3, st.slow, st.maxT || 10, t);
        if (st.pull) { n = near(g, e.x, e.y, st.field, g.Q2); for (i = 0; i < n; i++) displace(g, g.Q2[i], st.pull); }
        aimAt(t, e.x, e.y);
        g.events.push('grav');
        return !!zf;
      }
      case 'barr': {
        n = gather(g, t, range, false, Q, 0);
        var used = [];
        k = rank(t, Q, n, n);
        var made = 0;
        for (i = 0; i < k && made < (st.strips || 1); i++) {
          e = Q[i];
          if (e.fly) continue;
          var clash = false;
          for (var u = 0; u < used.length; u++) if (used[u].ri === e.ri && Math.abs(used[u].d - e.d) < st.strip) clash = true;
          if (clash) continue;
          var zb = addZone(g, 'barr', e.x, e.y, 0.5, st.stripDur || 3, st.slow, st.maxT || 8, t);
          if (zb) { zb.ri = e.ri; zb.d0 = e.d - st.strip / 2; zb.d1 = e.d + st.strip / 2; used.push({ ri: e.ri, d: e.d }); made++; }
        }
        if (made) { aimAt(t, Q[0].x, Q[0].y); g.events.push('barr'); }
        return made > 0;
      }
    }
    return false;
  }
  // Sine Beam: holds one target, ticking; focus builds while it holds.
  function beamStep(g, t, dt) {
    var st = t.st, e = null, i, range = effRange(t);
    for (i = 0; i < g.enemies.length && t.beamId; i++) if (g.enemies[i].id === t.beamId) { e = g.enemies[i]; break; }
    if (e && (!e.alive || !inReach(g, t, e) || e.revT > 0)) e = null;
    if (!e) {
      var n = gather(g, t, range, true, g.Q, 0);
      if (!rank(t, g.Q, n, 1)) { t.beamId = 0; t.beamT = 0; t.cd = Math.max(t.cd, 0); return; }
      e = g.Q[0]; t.beamId = e.id; t.beamT = 0;
      g.events.push('beam');
    }
    t.beamT += dt; t.fireT = 0.1; t.ax = e.x - t.x; t.ay = e.y - t.y;
    if (t.cd > 0) { t.cd -= dt; if (t.cd > 0) return; }
    t.cd += effInt(t);
    var dmg = st.dmg * (st.focusT && t.beamT >= st.focusT ? 1 + (st.focusB || 0) : 1);
    if (st.pen) {
      var ux = t.ax, uy = t.ay, l = Math.sqrt(ux * ux + uy * uy) || 1;
      linePass(g, t, t.x, t.y, ux / l, uy / l, lineClip(g, t, ux / l, uy / l, range), st.dmg, dtOf(t), st.pen, 1, st.lineW || 0.45);
    } else strike(g, t, e, dmg, dtOf(t), F_HIT, true);
  }
  // Arch Chainblade: blades sweep the ring; each enemy once per blade per turn.
  function orbitStep(g, t, dt) {
    var st = t.st, R = effRange(t), W = st.orbitW || 0.5, per = effInt(t), a0 = t.ang, a1 = a0 + 2 * Math.PI * dt / per;
    t.ang = a1;
    if (a1 >= 2 * Math.PI) { t.ang = a1 - 2 * Math.PI; t.revHits = null; }
    var n = near(g, t.x, t.y, R + 0.3, g.Q), blades = st.blades || 1, i;
    if (!n) return;
    if (!t.revHits) t.revHits = [[], []];
    t.fireT = 0.1;
    for (var b = 0; b < blades; b++) {
      var off = b * Math.PI, s0 = a0 + off, hits = t.revHits[b];
      if (hits.length >= (st.maxT || 6)) continue;
      for (i = 0; i < n; i++) {
        var e = g.Q[i];
        if (e.fly && !(layerOf(e) & 1)) continue;
        if (e.revT > 0 || e.prot > 0 || !visibleTo(g, t, e, 0)) continue;
        var dx = e.x - t.x, dy = e.y - t.y, dd = Math.sqrt(dx * dx + dy * dy);
        if (dd < R - W - 0.15 || dd > R + 0.15) continue;
        var ang = Math.atan2(dy, dx), rel = ang - s0;
        rel = rel - 2 * Math.PI * Math.floor(rel / (2 * Math.PI));
        if (rel > a1 - a0) continue;
        if (hits.indexOf(e.id) >= 0) continue;
        hits.push(e.id);
        strike(g, t, e, st.dmg, PHYS, F_AREA, hits.length === 1);
        if (hits.length >= (st.maxT || 6)) break;
      }
    }
  }
  // Hive Swarm: drones fly out, latch on, and chew until the target is gone.
  function swarmStep(g, t, dt) {
    var st = t.st, e = null, i, range = effRange(t);
    if (t.swId) for (i = 0; i < g.enemies.length; i++) if (g.enemies[i].id === t.swId) { e = g.enemies[i]; break; }
    if (e && (!e.alive || !inReach(g, t, e))) {
      var was = e; e = null;
      if (st.xfer && was && !was.alive) {
        var n2 = gather(g, t, range, true, g.Q, 0), best = null, bd = 1.44;
        for (i = 0; i < n2; i++) { var dx = g.Q[i].x - was.x, dy = g.Q[i].y - was.y, d2 = dx * dx + dy * dy; if (d2 <= bd) { bd = d2; best = g.Q[i]; } }
        if (best) { e = best; t.swId = e.id; t.swArr = Math.sqrt(bd) / (st.pspd || 8); }
      }
      if (!e) { t.swId = 0; t.swRet = 0.3; }
    }
    if (t.swRet > 0) { t.swRet -= dt; return; }
    if (!e) {
      var n = gather(g, t, range, true, g.Q, 0);
      if (!rank(t, g.Q, n, 1)) return;
      e = g.Q[0]; t.swId = e.id;
      var ddx = e.x - t.x, ddy = e.y - t.y;
      t.swArr = Math.sqrt(ddx * ddx + ddy * ddy) / (st.pspd || 8); t.swCd = 0;
      g.events.push('swarm');
    }
    t.ax = e.x - t.x; t.ay = e.y - t.y;
    if (t.swArr > 0) { t.swArr -= dt; return; }
    t.fireT = 0.1;
    if ((t.swCd -= dt) > 0) return;
    t.swCd += effInt(t);
    for (i = 0; i < (st.drones || 5) && e.alive; i++) strike(g, t, e, st.dmg, PHYS, F_HIT, i === 0);
  }
  function revealStep(g, t) {
    var st = t.st, n = near(g, t.x, t.y, st.range, g.Q);
    for (var i = 0; i < n; i++) {
      var e = g.Q[i];
      if (!isHidden(e)) continue;
      if (e.revealT < st.linger) e.revealT = st.linger;
      if (st.exSlow && e.k === '?') applySlow(e, st.exSlow, 0.1, false);
    }
  }
  function bountyStep(g, t, dt) {
    var st = t.st;
    if ((t.cd -= dt) > 0) return;
    t.cd += st.markEvery || 2;
    var live = 0, i;
    for (i = 0; i < g.enemies.length; i++) { var e = g.enemies[i]; if (e.alive && e.markT > 0 && e.markBy === t.id) live++; }
    if (live >= (st.marks || 2)) return;
    var n = gather(g, t, st.range, false, g.Q, st.markElite ? 4 : 3);
    if (!rank(t, g.Q, n, 1)) return;
    var m = g.Q[0];
    m.markT = st.markDur || 8; m.markBy = t.id; m.markV = st.markVuln || 0;
    addFx(g, 4, m.x, m.y, 0, 0, 0.4, 0.5, '⊓');
  }
  function stepTower(g, t, dt) {
    var st = t.st, sh = st.shape;
    if (t.fireT > 0) t.fireT -= dt;
    if (t.jamT > 0) t.jamT = tick(t.jamT, dt);
    if (t.yowlT > 0) t.yowlT = tick(t.yowlT, dt);
    if (t.supImm > 0) t.supImm = tick(t.supImm, dt);
    if (t.nullImm > 0) t.nullImm = tick(t.nullImm, dt);
    if (t.nullT > 0 && (t.nullT -= dt) <= 0) { t.nullT = 0; g.dirty = true; }
    if (t.echoT > 0) t.echoT = tick(t.echoT, dt);
    switch (sh) {
      case 'beam': beamStep(g, t, dt); return;
      case 'orbit': orbitStep(g, t, dt); return;
      case 'swarm': swarmStep(g, t, dt); return;
      case 'reveal': revealStep(g, t); return;
      case 'bounty': bountyStep(g, t, dt); return;
      case 'relay':
        if (st.cleanse && (t.cd -= dt) <= 0) {
          t.cd += st.cleanse;
          var L = t.links || [];
          for (var i = 0; i < g.towers.length; i++) { var o = g.towers[i]; if (L.indexOf(o.id) >= 0 && (o.jamT > 0 || o.yowlT > 0)) { o.jamT = 0; o.yowlT = 0; o.supImm = 2; addFx(g, 4, o.x, o.y, 0, 0, 0.4, 0.5, '⊕'); } }
        }
        return;
      case 'haste': case 'amp': case 'survey': case 'echo': case 'terra': case 'mint': case 'bank': case 'salvage':
        return;
    }
    if (t.cd > 0) { t.cd -= dt; if (t.cd > 0) return; }
    if (fire(g, t)) t.cd += effInt(t);
    else t.cd = 0.1;
    if (t.cd < -0.5) t.cd = 0;
  }

  // ---------------- economy ----------------
  // Extra pay for an original enemy's death: Salvage Yards in range, Bounty Office marks.
  function ecoKill(g, e) {
    var b = 0;
    for (var i = 0; i < g.towers.length; i++) {
      var t = g.towers[i], st = t.st;
      if (!st) continue;
      if (st.shape === 'salvage') {
        var dx = e.x - t.x, dy = e.y - t.y;
        if (dx * dx + dy * dy <= st.range * st.range && t.paid < st.salvageMax) { t.paid++; b += st.salvage; }
      } else if (st.shape === 'bounty' && e.markT > 0 && e.markBy === t.id && t.paid < st.markMax) { t.paid++; b += st.markPay; }
    }
    return b;
  }
  function ecoLeak(g, e) {
    for (var i = 0; i < g.towers.length; i++) {
      var t = g.towers[i], st = t.st;
      if (st && st.leakPay && (t.leaks || 0) < st.leakMax) { t.leaks = (t.leaks || 0) + 1; g.gold += st.leakPay; addFx(g, 5, t.x, t.y - 0.3, 0, 0, 1, 0, '+' + st.leakPay); }
    }
  }

  // ---------------- waves: start / clear / call early ----------------
  function moreWaves(g) { return g.endless || g.wave < MAPS[g.map].waves; }
  function spawnLeft(g, sp) {
    var spec = waveSpec(g.map, sp.w), G = spec.groups, s = Math.max(0, sp.t);
    if (sp.gi < G.length) s += (sp.left - 1) * G[sp.gi].gap;
    for (var i = sp.gi + 1; i < G.length; i++) s += GROUP_GAP + (G[i].n - 1) * G[i].gap;
    return s;
  }
  function timeToNext(g) {
    if (g.phase !== 'wave' || !moreWaves(g)) return null;
    if (g.spawners.length) {
      var m = 0;
      for (var i = 0; i < g.spawners.length; i++) m = Math.max(m, spawnLeft(g, g.spawners[i]));
      return m + g.gap;
    }
    return g.countdown;
  }
  function earlyBonus(g) {
    var t = timeToNext(g);
    return t == null ? 0 : Math.floor(t * BAL.earlyRate * (1 + 0.04 * level(g.map, g.wave + 1)) * g.mod.early);
  }
  function canCallWave(g) {
    if (g.phase === 'build') return true;
    return g.phase === 'wave' && moreWaves(g) && g.spawners.length < MAX_SPAWNERS;
  }
  function startWave(g) {
    g.wave++; g.wavesStarted = g.wave;
    var w = g.wave, spec = waveSpec(g.map, w), total = 0, i;
    for (i = 0; i < spec.groups.length; i++) total += spec.groups[i].n;
    g.spawners.push({ w: w, gi: 0, left: spec.groups[0].n, t: 0.3 });
    g.waveLeft[w] = total; g.waveLost[w] = 0; g.waveBoss[w] = spec.boss ? 1 : 0;
    g.countdown = 0; g.phase = 'wave';
    if (g.dirty) recalc(g);
    for (i = 0; i < g.towers.length; i++) {
      var t = g.towers[i], st = t.st;
      t.paid = 0; t.leaks = 0;
      if (st.shape === 'bank' && t.bankOn && !t.principal) {
        var dep = Math.min(st.bankCap, Math.max(0, g.gold));
        if (dep > 0) { t.principal = dep; t.bankW = w; g.gold -= dep; g.bankHeld += dep; addFx(g, 5, t.x, t.y - 0.3, 0, 0, 1, 0, '≡' + dep); }
      }
    }
    g.events.push(spec.boss ? 'boss' : 'wave');
  }
  function nextWave(g) {
    if (!canCallWave(g)) return -1;
    var bonus = g.phase === 'wave' ? earlyBonus(g) : 0;
    g.gold += bonus;
    g.bonusLast = bonus;
    startWave(g);
    return bonus;
  }
  function waveDone(g, w) {
    if (--g.waveLeft[w] === 0) waveClear(g, w);
  }
  function waveClear(g, w) {
    if (g.phase === 'lost') return;
    var pay = wavePay(g.map, w), inc = 0, i;
    for (i = 0; i < g.towers.length; i++) {
      var t = g.towers[i], st = t.st;
      if (!st) continue;
      if (st.shape === 'mint' && t.since < w) {
        var a = st.income || 0;
        if (st.relief) a += Math.min(48, st.relief * (g.waveLost[w] || 0));
        if (st.bonds && g.waveBoss[w]) a += st.bonds;
        inc += a; addFx(g, 5, t.x, t.y - 0.3, 0, 0, 1.2, 0, '+$' + a);
      } else if (st.shape === 'bank') {
        if (t.principal && t.bankW === w) {
          var it = Math.min(st.bankMax, Math.floor(t.principal * st.bankRate));
          g.gold += t.principal + it; g.bankHeld -= t.principal; t.principal = 0; inc += 0;
          addFx(g, 5, t.x, t.y - 0.3, 0, 0, 1.2, 0, '+$' + it);
          g.lastInterest = it;
        }
        if (st.dividend && t.since < w) inc += st.dividend;
      }
    }
    g.gold += pay + inc;
    g.lastClear = { w: w, pay: pay, inc: inc };
    g.events.push('clear');
  }
  function spawnStep(g, dt) {
    for (var i = 0; i < g.spawners.length; i++) {
      var sp = g.spawners[i], spec = waveSpec(g.map, sp.w), G = spec.groups;
      sp.t -= dt;
      while (sp.t <= 0 && sp.gi < G.length) {
        var gr = G[sp.gi];
        if (gr.k === '2') {
          var a = spawnEnemy(g, '2', sp.w, spec.L, gr.ri, 0, true), b = spawnEnemy(g, '2', sp.w, spec.L, gr.ri, 0, true);
          if (a && b) { a.partner = b.id; b.partner = a.id; b.d = 0; a.d = 0.45; placeEnemy(g, a); a.px = a.x; a.py = a.y; }
          else { if (!a) g.waveLeft[sp.w]--; if (!b) g.waveLeft[sp.w]--; }
          sp.left -= 2;
        } else {
          if (!spawnEnemy(g, gr.k, sp.w, spec.L, gr.ri, 0, true)) waveDone(g, sp.w);
          sp.left--;
        }
        if (sp.left > 0) sp.t += gr.gap;
        else { sp.gi++; if (sp.gi < G.length) { sp.left = G[sp.gi].n; sp.t += GROUP_GAP; } }
      }
      if (sp.gi >= G.length) {
        g.spawners.splice(i, 1); i--;
        if (!g.spawners.length && moreWaves(g)) g.countdown = g.gap;
      }
    }
    if (!g.spawners.length && g.countdown > 0) {
      g.countdown -= dt;
      if (g.countdown <= 0) { g.countdown = 0; if (moreWaves(g)) startWave(g); }
    }
  }

  // ---------------- one fixed step ----------------
  function step(g) {
    if (g.phase !== 'wave') return;
    var dt = STEP, i, md = MD[g.map], en = g.enemies;
    g.t += dt; g.steps++;
    if (g.dirty) recalc(g);
    spawnStep(g, dt);
    g.qList.length = 0;
    for (i = 0; i < en.length; i++) if (en[i].alive) stepEnemy(g, en[i], dt, md);
    rebuildBuckets(g);
    stepZones(g, dt);
    if (g.dirty) recalc(g);
    for (i = 0; i < g.towers.length; i++) stepTower(g, g.towers[i], dt);
    stepMines(g, dt);
    stepProj(g, dt);
    stepEv(g, dt);
    // sweep the dead into the pool
    for (i = en.length - 1; i >= 0; i--) {
      var e = en[i];
      if (!e.alive) { e.burnBy = null; e.corBy = null; e.links = null; e.pr = null; e.slick = null; en[i] = en[en.length - 1]; en.pop(); g.epool.push(e); }
    }
    rebuildBuckets(g);
    var fx = g.fx;
    for (i = fx.length - 1; i >= 0; i--) {
      fx[i].t += dt;
      if (fx[i].t >= fx[i].life) { var f = fx[i]; fx[i] = fx[fx.length - 1]; fx.pop(); g.fxpool.push(f); }
    }
    if (g.phase === 'wave' && !moreWaves(g) && !g.spawners.length && !en.length) { g.phase = 'won'; g.events.push('win'); }
  }
  // Fixed-timestep accumulator: real seconds x speed in STEP slices. Returns the render alpha.
  function advance(g, dt, speed) {
    g.acc = (g.acc || 0) + clamp(dt, 0, 0.1) * (speed || 1);
    var n = 0, cap = 6 * (speed || 1);
    while (g.acc >= STEP - 1e-7) {
      step(g);
      g.acc -= STEP;
      if (++n >= cap) { g.acc = 0; break; }
    }
    return clamp(g.acc / STEP, 0, 1);
  }

  function starsFor(lives, maxLives) { var f = lives / maxLives; return f >= 0.9 ? 3 : f >= 0.5 ? 2 : 1; }
  function stars(g) {
    if (g.phase !== 'won' && !g.endless) return 0;
    return starsFor(g.endless ? g.livesAtWin : g.lives, g.maxLives);
  }
  function goEndless(g) {
    if (g.phase !== 'won') return false;
    g.livesAtWin = g.lives; g.endless = true; g.phase = 'wave'; g.countdown = g.gap;
    return true;
  }
  // The enemy nearest (x, y) within r (for inspecting), or null.
  function enemyNear(g, x, y, r) {
    var best = null, bd = r * r;
    for (var i = 0; i < g.enemies.length; i++) {
      var e = g.enemies[i];
      if (!e.alive) continue;
      var dx = e.x - x, dy = e.y - y, d2 = dx * dx + dy * dy;
      if (d2 <= bd) { bd = d2; best = e; }
    }
    return best;
  }
  function enemyById(g, id) { for (var i = 0; i < g.enemies.length; i++) if (g.enemies[i].id === id && g.enemies[i].alive) return g.enemies[i]; return null; }

  // ---------------- save / restore (plain JSON) ----------------
  var ECORE = ['id', 'k', 'w', 'L', 'ri', 'fly', 'air', 'orig', 'maxHp', 'hp', 'sh', 'shMax', 'ar', 'lives', 'spd', 'bounty', 'd', 'seg', 'age', 'lat', 'zap'];
  var TKEYS = ['id', 'type', 'lvl', 'br', 'c', 'r', 'cd', 'mode', 'spent', 'kills', 'dmg', 'since', 'principal', 'bankOn', 'bankW', 'ptype', 'paid', 'leaks', 'ang', 'mineI'];
  function num(v) { return typeof v === 'number' ? (v % 1 ? +v.toFixed(4) : v) : v; }
  function serialize(g) {
    var o = {
      v: 2, map: g.map, mapId: MAPS[g.map].id, perks: cleanPerks(g.perks), loadout: g.loadout.slice(), gold: g.gold, lives: g.lives, maxLives: g.maxLives,
      wave: g.wave, phase: g.phase, endless: g.endless, livesAtWin: g.livesAtWin, countdown: num(g.countdown), t: num(g.t), steps: g.steps,
      nextId: g.nextId, rs: g.rs, kills: g.kills, leaks: g.leaks, wavesStarted: g.wavesStarted, bankHeld: g.bankHeld, zap: g.zap || 0,
      waveLeft: [], waveLost: [], waveBoss: [], pads: {}, seen: g.seen || {}, towers: [], enemies: [], spawners: []
    }, i, k;
    for (i = 0; i <= g.wave; i++) { o.waveLeft.push(g.waveLeft[i] | 0); o.waveLost.push(g.waveLost[i] | 0); o.waveBoss.push(g.waveBoss[i] | 0); }
    for (k in g.pads) o.pads[k] = g.pads[k];
    for (i = 0; i < g.towers.length; i++) { var t = g.towers[i], a = []; for (var j = 0; j < TKEYS.length; j++) a.push(num(t[TKEYS[j]] || 0)); o.towers.push(a); }
    for (i = 0; i < g.enemies.length; i++) {
      var e = g.enemies[i];
      if (!e.alive) continue;
      var r = {};
      for (j = 0; j < ECORE.length; j++) r[ECORE[j]] = num(e[ECORE[j]]);
      for (j = 0; j < EFIELDS.length; j++) { var v = e[EFIELDS[j]]; if (v) r[EFIELDS[j]] = num(v); }
      o.enemies.push(r);
    }
    for (i = 0; i < g.spawners.length; i++) { var sp = g.spawners[i]; o.spawners.push({ w: sp.w, gi: sp.gi, left: sp.left, t: num(sp.t) }); }
    return o;
  }
  function restore(o) {
    if (!o || o.v !== 2) return null;
    var mi = o.map;
    if (o.mapId) for (var q = 0; q < MAPS.length; q++) if (MAPS[q].id === o.mapId) mi = q;
    if (!MAPS[mi]) return null;
    var g = newGame(mi, o.perks, o.loadout), i, j;
    g.gold = o.gold; g.lives = o.lives; g.maxLives = o.maxLives; g.wave = o.wave; g.phase = o.phase; g.endless = !!o.endless;
    g.livesAtWin = o.livesAtWin || 0; g.countdown = o.countdown || 0; g.t = o.t || 0; g.steps = o.steps || 0; g.rs = o.rs || 1;
    g.kills = o.kills || 0; g.leaks = o.leaks || 0; g.wavesStarted = o.wavesStarted || o.wave; g.bankHeld = o.bankHeld || 0; g.zap = o.zap || 0;
    g.waveLeft = (o.waveLeft || []).slice(); g.waveLost = (o.waveLost || []).slice(); g.waveBoss = (o.waveBoss || []).slice();
    g.seen = o.seen || {};
    for (var k in o.pads) g.pads[k] = o.pads[k];
    var md = MD[mi];
    for (i = 0; i < o.towers.length; i++) {
      var a = o.towers[i], rec = {};
      for (j = 0; j < TKEYS.length; j++) rec[TKEYS[j]] = a[j];
      if (!TOWERS[rec.type] || !inGrid(g, rec.c, rec.r) || towerAt(g, rec.c, rec.r)) continue;
      var t = addTower(g, rec.type, rec.c, rec.r, clamp(rec.lvl | 0, 0, 4), rec.lvl >= 4 ? clamp(rec.br | 0, 0, 1) : -1, rec.spent);
      for (j = 0; j < TKEYS.length; j++) if (TKEYS[j] !== 'type' && TKEYS[j] !== 'c' && TKEYS[j] !== 'r') t[TKEYS[j]] = rec[TKEYS[j]];
      if (t.lvl < 4) t.br = -1;
    }
    for (i = 0; i < o.enemies.length; i++) {
      var r = o.enemies[i];
      if (!ENEMIES[r.k]) continue;
      var e = g.epool.length ? g.epool.pop() : {};
      resetEnemy(e);
      for (k in r) e[k] = r[k];
      e.alive = true;
      var nr = e.fly ? md.air.length : md.routes.length;
      if (!(e.ri >= 0 && e.ri < nr)) e.ri = 0;
      e.seg = 0;
      placeEnemy(g, e); e.px = e.x; e.py = e.y;
      g.enemies.push(e);
    }
    for (i = 0; i < (o.spawners || []).length; i++) { var s = o.spawners[i]; g.spawners.push({ w: s.w, gi: s.gi, left: s.left, t: s.t }); }
    g.nextId = Math.max(o.nextId || 1, g.nextId);
    g.events.length = 0;
    recalc(g);
    rebuildBuckets(g);
    return g;
  }

  var ENGINE = {
    STEP: STEP, MODES: MODES, BAL: BAL, MAPS: MAPS, REGIONS: MP.REGIONS, TOWERS: TOWERS, TKEY: TKEY, ENEMIES: ENEMIES, D: D, MP: MP, TL: TL,
    PRISM_T: PRISM_T, DIRECT: DIRECT, MAX_SPAWNERS: MAX_SPAWNERS,
    mapData: mapData, routePos: routePos, level: level, hpScale: hpScale, budget: budget, waveSpec: waveSpec, waveCount: waveCount,
    isBossWave: isBossWave, bossFor: bossFor, startGold: startGold, wavePay: wavePay, poolIntro: poolIntro, hasTrait: hasTrait,
    towerStat: towerStat, upgradeCost: upgradeCost, sellValue: sellValue, isAttack: isAttack,
    newGame: newGame, setLoadout: setLoadout, allowed: allowed, slotsFor: slotsFor, canPlace: canPlace, placeWhy: placeWhy, canBuildType: canBuildType,
    build: build, upgrade: upgrade, sell: sell, aims: aims, cycleMode: cycleMode, cyclePrism: cyclePrism, padOccupied: padOccupied, ecoCount: ecoCount,
    nextWave: nextWave, canCallWave: canCallWave, earlyBonus: earlyBonus, timeToNext: timeToNext, moreWaves: moreWaves,
    step: step, advance: advance, stars: stars, starsFor: starsFor, goEndless: goEndless,
    serialize: serialize, restore: restore, stats: stats, recalc: recalc, effRange: effRange, effInt: effInt,
    isHidden: isHidden, layerOf: layerOf, visibleTo: visibleTo, speedOf: speedOf, resist: resist,
    mods: mods, cleanPerks: cleanPerks, perkCost: perkCost, spawnEnemy: spawnEnemy, hurt: hurt, kill: kill,
    towerAt: towerAt, tileAt: tileAt, landOf: landOf, enemyNear: enemyNear, enemyById: enemyById, sees: sees,
    applySlow: applySlow, applyStun: applyStun, applySilence: applySilence, displace: displace, rebuildBuckets: rebuildBuckets,
    placeEnemy: placeEnemy, applyBurn: applyBurn, applyCorrode: applyCorrode, routeOf: routeOf,
    PHYS: PHYS, FIRE: FIRE, FROST: FROST, SHOCK: SHOCK, ACID: ACID, SONIC: SONIC, ARCANE: ARCANE,
    F_PROJ: F_PROJ, F_HIT: F_HIT, F_SPLASH: F_SPLASH, F_DOT: F_DOT, F_AREA: F_AREA
  };
  if (NODE) module.exports = ENGINE;
  else root.__TD2Engine = ENGINE;
})(typeof window !== 'undefined' ? window : this);
