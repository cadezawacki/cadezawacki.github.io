/* Falling Sand — a cellular-automaton sandbox for Cade.txt.
 * Paint sand, water, stone, wood, fire, smoke, steam, oil, plants, lava, ice,
 * acid, gunpowder, salt, glass and walls onto a grid of glyph cells, then watch
 * them interact: water puts fire out in a puff of steam, lava turns water to
 * stone and sand to glass, plants drink water and grow, salt dissolves into
 * brine, acid eats nearly anything, gunpowder chain-explodes, ice melts.
 * Source and drain tools make taps and plugholes.
 * The grid lives in typed arrays and updates bottom-up with a random scan
 * direction per row; it is split into 16x16 chunks that sleep when nothing in
 * them moves (dirty regions), and the renderer only redraws cells whose glyph
 * changed, from a glyph atlas built per theme. The simulation runs on a fixed
 * tick (60/s at 1x) with an accumulator, so it is the same at 60 or 120 Hz.
 * Scenes save to Cade.store run-length + base64 compressed (cade-fallingsand-*).
 * Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var EMPTY = 0, WALL = 1, SAND = 2, WATER = 3, STONE = 4, WOOD = 5, FIRE = 6, SMOKE = 7, STEAM = 8, OIL = 9,
    PLANT = 10, LAVA = 11, ICE = 12, ACID = 13, POWDER = 14, SALT = 15, BRINE = 16, GLASS = 17, SOURCE = 18, DRAIN = 19;
  var NEL = 20;
  // kinds
  var K_NONE = 0, K_STATIC = 1, K_POWDER = 2, K_LIQUID = 3, K_GAS = 4, K_FIRE = 5;
  var CS = 16, CSH = 4;                 // chunk size (cells) and its shift
  var TPS = 60;                         // ticks per second at 1x
  var ANCHOR = 128, BLAST = 64;         // fire aux flags: burning in place (wood, plant, oil) / about to explode

  // id, key, name, kind, density, paint fill chance, glyphs (4 variants), info
  var ELS = [
    { id: EMPTY, key: 'erase', name: 'Eraser', kind: K_NONE, dens: 0, fill: 1, gl: '    ', info: 'clears anything, walls too' },
    { id: WALL, key: 'wall', name: 'Wall', kind: K_STATIC, dens: 255, fill: 1, gl: '####', info: 'indestructible' },
    { id: SAND, key: 'sand', name: 'Sand', kind: K_POWDER, dens: 30, fill: 0.55, gl: ':.:;', info: 'piles up; lava glazes it into glass' },
    { id: WATER, key: 'water', name: 'Water', kind: K_LIQUID, dens: 10, fill: 0.7, gl: '~~-~', info: 'flows, puts fire out, feeds plants' },
    { id: STONE, key: 'stone', name: 'Stone', kind: K_STATIC, dens: 255, fill: 1, gl: '%&%@', info: 'solid; blasts and acid wear it away' },
    { id: WOOD, key: 'wood', name: 'Wood', kind: K_STATIC, dens: 255, fill: 1, gl: '||!|', info: 'solid; burns slowly' },
    { id: FIRE, key: 'fire', name: 'Fire', kind: K_FIRE, dens: 1, fill: 0.6, gl: "*^^'", info: 'spreads to wood, plants and oil' },
    { id: SMOKE, key: 'smoke', name: 'Smoke', kind: K_GAS, dens: 2, fill: 0.5, gl: ":.'.", info: 'drifts up and fades' },
    { id: STEAM, key: 'steam', name: 'Steam', kind: K_GAS, dens: 2, fill: 0.5, gl: "oo.'", info: 'rises, then rains back as water' },
    { id: OIL, key: 'oil', name: 'Oil', kind: K_LIQUID, dens: 8, fill: 0.7, gl: '~=~-', info: 'floats on water; burns hot' },
    { id: PLANT, key: 'plant', name: 'Plant', kind: K_STATIC, dens: 255, fill: 1, gl: '"v"y', info: 'drinks water and grows' },
    { id: LAVA, key: 'lava', name: 'Lava', kind: K_LIQUID, dens: 15, fill: 0.7, gl: '~^~*', info: 'sets things alight; water cools it to stone' },
    { id: ICE, key: 'ice', name: 'Ice', kind: K_STATIC, dens: 255, fill: 1, gl: '=+=#', info: 'melts — fast near heat or salt' },
    { id: ACID, key: 'acid', name: 'Acid', kind: K_LIQUID, dens: 12, fill: 0.7, gl: '~o~.', info: 'eats almost anything (not glass)' },
    { id: POWDER, key: 'powder', name: 'Gunpowder', kind: K_POWDER, dens: 25, fill: 0.55, gl: ':%.:', info: 'explodes in a chain at a spark' },
    { id: SALT, key: 'salt', name: 'Salt', kind: K_POWDER, dens: 30, fill: 0.55, gl: ":.`'", info: 'dissolves in water; melts ice' },
    { id: BRINE, key: 'brine', name: 'Brine', kind: K_LIQUID, dens: 11, fill: 0.7, gl: '~-~=', info: 'salty water; boils back to salt' },
    { id: GLASS, key: 'glass', name: 'Glass', kind: K_STATIC, dens: 255, fill: 1, gl: '/|\\/', info: 'clear and acid-proof' },
    { id: SOURCE, key: 'source', name: 'Source', kind: K_STATIC, dens: 255, fill: 1, gl: '@@@@', info: 'pours out the last material you chose' },
    { id: DRAIN, key: 'drain', name: 'Drain', kind: K_STATIC, dens: 255, fill: 1, gl: 'OOOO', info: 'swallows anything that flows into it' }
  ];
  var KIND = new Uint8Array(NEL), DENS = new Uint8Array(NEL), FLAM = new Float32Array(NEL), BYKEY = {};
  for (var q0 = 0; q0 < NEL; q0++) { KIND[q0] = ELS[q0].kind; DENS[q0] = ELS[q0].dens; BYKEY[ELS[q0].key] = q0; }
  FLAM[WOOD] = 0.06; FLAM[PLANT] = 0.08; FLAM[OIL] = 0.25; FLAM[POWDER] = 1;
  // the painting palette, in order (keys 1-9, 0 pick the first ten)
  var TOOLS = ['sand', 'water', 'stone', 'wood', 'fire', 'oil', 'plant', 'lava', 'ice', 'acid', 'powder', 'salt', 'smoke', 'steam', 'glass', 'wall', 'source', 'drain', 'erase'];
  // what a source may pour (not walls / sources / drains / erase)
  function canSource(e) { return e > 0 && e < NEL && KIND[e] !== K_STATIC || e === PLANT || e === STONE || e === WOOD || e === ICE || e === GLASS; }
  var IMMUNE_ACID = new Uint8Array(NEL);
  [EMPTY, WALL, GLASS, ACID, SOURCE, DRAIN, FIRE, SMOKE, STEAM].forEach(function (e) { IMMUNE_ACID[e] = 1; });

  // ---- the grid ----
  function newGrid(w, h, seed) {
    w = Math.max(4, w | 0); h = Math.max(4, h | 0);
    var N = w * h, cw = (w + CS - 1) >> CSH, ch = (h + CS - 1) >> CSH;
    var G = {
      w: w, h: h, N: N, cw: cw, ch: ch,
      t: new Uint8Array(N), a: new Uint8Array(N), s: new Uint8Array(N), c: new Uint16Array(N),
      wc: new Uint8Array(cw * ch), wn: new Uint8Array(cw * ch), rd: new Uint8Array(cw * ch),
      tick: 0, stamp: 1, r: (seed >>> 0) || 0x9E3779B9,
      booms: 0, sizzles: 0, grown: 0, ev: [], active: 0
    };
    G.wn.fill(1); G.rd.fill(1);
    return G;
  }
  // xorshift32
  function rnd(G) { var x = G.r; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; G.r = x >>> 0; return G.r; }
  function chance(G, p) { return (rnd(G) & 0xffff) < p * 65536; }

  function wakeXY(G, x, y) {
    var x0 = (x > 0 ? x - 1 : 0) >> CSH, x1 = (x < G.w - 1 ? x + 1 : x) >> CSH;
    var y0 = (y > 0 ? y - 1 : 0) >> CSH, y1 = (y < G.h - 1 ? y + 1 : y) >> CSH;
    for (var cy = y0; cy <= y1; cy++) for (var cx = x0; cx <= x1; cx++) { var k = cy * G.cw + cx; G.wn[k] = 1; G.rd[k] = 1; }
  }
  function wakeI(G, i) { var y = (i / G.w) | 0; wakeXY(G, i - y * G.w, y); }
  function keep(G, x, y) { var k = (y >> CSH) * G.cw + (x >> CSH); G.wn[k] = 1; G.rd[k] = 1; }
  function wakeAll(G) { G.wn.fill(1); G.rd.fill(1); }

  function initAux(G, e, src) {
    if (e === FIRE) return 18 + (rnd(G) % 30);
    if (e === SMOKE) return 40 + (rnd(G) % 70);
    if (e === STEAM) return 90 + (rnd(G) % 120);
    if (e === SOURCE) return canSource(src) ? src : WATER;
    return 0;
  }
  function set(G, i, e, aux) {
    G.t[i] = e; G.a[i] = aux || 0; G.s[i] = rnd(G) & 3; G.c[i] = G.stamp;
    wakeI(G, i);
  }
  function spawn(G, i, e) { set(G, i, e, initAux(G, e)); }
  function swap(G, i, j) {
    var t = G.t, a = G.a, s = G.s, v;
    v = t[i]; t[i] = t[j]; t[j] = v;
    v = a[i]; a[i] = a[j]; a[j] = v;
    v = s[i]; s[i] = s[j]; s[j] = v;
    G.c[i] = G.c[j] = G.stamp;
    wakeI(G, i); wakeI(G, j);
    G.active++;
  }
  function get(G, x, y) { return x < 0 || y < 0 || x >= G.w || y >= G.h ? WALL : G.t[y * G.w + x]; }
  // can a cell of type e move into j (falling / flowing)? empty, or a lighter fluid
  function fluidAt(G, j) {
    var tj = G.t[j], k = KIND[tj];
    return k === K_LIQUID || k === K_GAS || (k === K_FIRE && !(G.a[j] & ANCHOR));
  }
  function canEnter(G, j, e) {
    var tj = G.t[j];
    return tj === EMPTY || (DENS[tj] < DENS[e] && fluidAt(G, j));
  }

  var NB8X = [-1, 0, 1, -1, 1, -1, 0, 1], NB8Y = [-1, -1, -1, 0, 0, 1, 1, 1];
  var NB4X = [0, -1, 1, 0], NB4Y = [-1, 0, 0, 1];

  // ---- movement ----
  function fall(G, x, y, i, e, slow) {
    var W = G.w;
    if (y + 1 >= G.h) return false;
    var j = i + W, tj = G.t[j];
    if (tj === EMPTY || (canEnter(G, j, e) && (!slow || chance(G, slow)))) { swap(G, i, j); return true; }
    var d = rnd(G) & 1 ? 1 : -1;
    for (var k = 0; k < 2; k++, d = -d) {
      var nx = x + d;
      if (nx < 0 || nx >= W) continue;
      j = i + W + d; tj = G.t[j];
      if (tj === EMPTY || (canEnter(G, j, e) && (!slow || chance(G, slow)))) {
        // don't slip diagonally through a gap between two solid cells
        if (G.t[i + d] !== EMPTY && !fluidAt(G, i + d)) continue;
        swap(G, i, j); return true;
      }
    }
    return false;
  }
  function flow(G, x, y, i, e, disp) {
    if (fall(G, x, y, i, e, 0)) return true;
    var W = G.w, d = rnd(G) & 1 ? 1 : -1;
    for (var k = 0; k < 2; k++, d = -d) {
      var last = 0;
      for (var n = 1; n <= disp; n++) {
        var nx = x + d * n;
        if (nx < 0 || nx >= W || !canEnter(G, i + d * n, e)) break;
        last = n;
        if (y + 1 < G.h && G.t[i + d * n + W] === EMPTY) break;      // a drop: fall from there
      }
      if (last) { swap(G, i, i + d * last); return true; }
    }
    return false;
  }
  function rise(G, x, y, i) {
    var W = G.w, j, tj, d;
    if (chance(G, 0.3)) {                             // billow sideways now and then
      d = rnd(G) & 1 ? 1 : -1;
      if (x + d >= 0 && x + d < W && G.t[i + d] === EMPTY) { swap(G, i, i + d); return; }
    }
    if (y > 0) {
      j = i - W; tj = G.t[j];
      if (tj === EMPTY || (KIND[tj] === K_LIQUID && chance(G, 0.5))) { swap(G, i, j); return; }
      d = rnd(G) & 1 ? 1 : -1;
      for (var k = 0; k < 2; k++, d = -d) {
        if (x + d < 0 || x + d >= W) continue;
        if (G.t[j + d] === EMPTY) { swap(G, i, j + d); return; }
      }
    }
    d = rnd(G) & 1 ? 1 : -1;
    if (x + d >= 0 && x + d < W && G.t[i + d] === EMPTY && chance(G, 0.5)) swap(G, i, i + d);
  }

  // ---- reactions ----
  function ignite(G, j, tj, x, y) {
    if (tj === POWDER) { set(G, j, FIRE, BLAST | 3 + (rnd(G) % 6)); return; }   // a fizzing grain: it blows a moment later
    var life = tj === WOOD ? 70 + (rnd(G) % 57) : tj === OIL ? 30 + (rnd(G) % 40) : 18 + (rnd(G) % 24);
    set(G, j, FIRE, ANCHOR | life);
  }
  function explode(G, x, y, r) {
    var W = G.w, H = G.h, t = G.t, r2 = r * r + r;
    G.booms++;
    if (G.ev.length < 24) G.ev.push({ k: 'boom', x: x, y: y });
    for (var dy = -r; dy <= r; dy++) {
      var yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (var dx = -r; dx <= r; dx++) {
        var xx = x + dx, d2 = dx * dx + dy * dy;
        if (xx < 0 || xx >= W || d2 > r2) continue;
        var j = yy * W + xx, tj = t[j];
        if (tj === WALL || tj === SOURCE || tj === DRAIN || tj === LAVA) continue;
        if (tj === POWDER) { set(G, j, FIRE, BLAST | 4 + (rnd(G) % 6)); continue; }
        if (tj === FIRE && (G.a[j] & 192) === BLAST) continue;
        if ((tj === STONE || tj === GLASS) && !chance(G, d2 <= 2 ? 0.6 : 0.2)) continue;
        if (tj === WATER || tj === BRINE || tj === ICE) { spawn(G, j, STEAM); continue; }
        var u = rnd(G) & 0xff;
        if (u < 130) set(G, j, FIRE, 8 + (rnd(G) % 14));
        else if (u < 180) spawn(G, j, SMOKE);
        else set(G, j, EMPTY, 0);
      }
    }
  }
  // water / brine meets heat: steam (brine leaves salt behind half the time)
  function boil(G, j, tj) {
    G.sizzles++;
    if (tj === BRINE && chance(G, 0.5)) set(G, j, SALT, 0); else spawn(G, j, STEAM);
  }
  function nbRandom(G, x, y) {
    var k = rnd(G) & 7, nx = x + NB8X[k], ny = y + NB8Y[k];
    if (nx < 0 || ny < 0 || nx >= G.w || ny >= G.h) return -1;
    return ny * G.w + nx;
  }

  function updFire(G, x, y, i) {
    var a = G.a[i], anch = a & ANCHOR, life = a & 63, t = G.t, W = G.w;
    if ((a & 192) === BLAST) {                                // a grain of gunpowder catching: boom
      if (life <= 1) { set(G, i, FIRE, 6 + (rnd(G) % 10)); explode(G, x, y, 2 + (rnd(G) % 2)); return; }
      G.a[i] = BLAST | (life - 1); keep(G, x, y); return;
    }
    life = a & 127;
    for (var n = anch ? 4 : 2; n > 0; n--) {
      var j = nbRandom(G, x, y);
      if (j < 0) continue;
      var tj = t[j];
      if (tj === WATER || tj === BRINE) { boil(G, j, tj); set(G, i, chance(G, 0.4) ? STEAM : EMPTY, initAux(G, STEAM)); return; }
      if (tj === ICE) { if (chance(G, 0.2)) set(G, j, WATER, 0); }
      else if (FLAM[tj] && chance(G, FLAM[tj])) ignite(G, j, tj, j % W, (j / W) | 0);
    }
    life--;
    if (life <= 0) {
      if (chance(G, anch ? 0.35 : 0.25)) spawn(G, i, SMOKE); else set(G, i, EMPTY, 0);
      return;
    }
    G.a[i] = anch | life;
    keep(G, x, y);
    if (anch) {                                               // burning in place: lick flames upward
      if (y > 0 && t[i - W] === EMPTY) {
        if (chance(G, 0.3)) set(G, i - W, FIRE, 4 + (rnd(G) % 10));
        else if (chance(G, 0.03)) spawn(G, i - W, SMOKE);
      }
      return;
    }
    if (y > 0 && t[i - W] === EMPTY && chance(G, 0.45)) { swap(G, i, i - W); return; }
    var d = rnd(G) & 1 ? 1 : -1;
    if (x + d >= 0 && x + d < W && t[i + d] === EMPTY && chance(G, 0.3)) swap(G, i, i + d);
  }
  function updGas(G, x, y, i, e) {
    var life = G.a[i];
    keep(G, x, y);
    if (life <= 1 || (y === 0 && e === STEAM && chance(G, 0.05))) {
      if (e === STEAM && chance(G, 0.4)) set(G, i, WATER, 0); else set(G, i, EMPTY, 0);
      return;
    }
    G.a[i] = life - 1;
    rise(G, x, y, i);
  }
  function updLava(G, x, y, i) {
    keep(G, x, y);
    var j = nbRandom(G, x, y), W = G.w;
    if (j >= 0) {
      var tj = G.t[j];
      if (tj === WATER || tj === BRINE) { boil(G, j, tj); set(G, i, STONE, 0); return; }
      if (tj === ICE) { set(G, j, WATER, 0); if (chance(G, 0.25)) { set(G, i, STONE, 0); return; } }
      else if (tj === SAND && chance(G, 0.03)) set(G, j, GLASS, 0);
      else if (tj === SALT && chance(G, 0.02)) set(G, j, EMPTY, 0);
      else if (FLAM[tj] && chance(G, Math.min(1, FLAM[tj] * 4))) ignite(G, j, tj, j % W, (j / W) | 0);
      else if (tj === EMPTY && j < i - 1 && chance(G, 0.006)) set(G, j, FIRE, 5 + (rnd(G) % 8));
    }
    if (chance(G, 0.00025)) { set(G, i, STONE, 0); return; }
    if (chance(G, 0.45)) flow(G, x, y, i, LAVA, 1);
  }
  function updAcid(G, x, y, i) {
    var W = G.w, H = G.h, k = rnd(G) % 4, nx = x + NB4X[k], ny = y + NB4Y[k];
    if (k === 0) { k = 3; nx = x; ny = y + 1; }              // acid eats down and sideways, not up
    if (nx >= 0 && ny >= 0 && nx < W && ny < H) {
      var j = ny * W + nx, tj = G.t[j];
      if (!IMMUNE_ACID[tj]) {
        keep(G, x, y);
        if (chance(G, tj === WATER || tj === BRINE ? 0.02 : 0.12)) {
          if (chance(G, 0.25)) spawn(G, j, SMOKE); else set(G, j, EMPTY, 0);
          G.sizzles++;
          if (chance(G, 0.3)) { set(G, i, EMPTY, 0); return; }
        }
      }
    }
    flow(G, x, y, i, ACID, 2);
  }
  function updPlant(G, x, y, i) {
    var W = G.w, H = G.h, t = G.t, wet = -1, n = 0;
    for (var k = 0; k < 8; k++) {
      var nx = x + NB8X[k], ny = y + NB8Y[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      var j = ny * W + nx;
      if (t[j] === WATER && (rnd(G) % (++n)) === 0) wet = j;
    }
    if (wet < 0) return;
    keep(G, x, y);
    if (!chance(G, 0.035)) return;
    G.grown++;
    if (chance(G, 0.35)) { set(G, wet, PLANT, 0); return; }   // grows into the water…
    set(G, wet, EMPTY, 0);                                   // …or drinks it and sprouts upward
    var d = (rnd(G) % 3) - 1, ux = x + d;
    if (y > 0 && ux >= 0 && ux < W && t[i - W + d] === EMPTY) set(G, i - W + d, PLANT, 0);
  }
  function updSalt(G, x, y, i) {
    var j = nbRandom(G, x, y);
    if (j >= 0) {
      var tj = G.t[j];
      if (tj === WATER) { keep(G, x, y); if (chance(G, 0.03)) { set(G, j, BRINE, 0); set(G, i, EMPTY, 0); return; } }
      else if (tj === ICE) { keep(G, x, y); if (chance(G, 0.02)) set(G, j, WATER, 0); }
    }
    fall(G, x, y, i, SALT, 0.5);
  }
  function updSource(G, x, y, i) {
    keep(G, x, y);
    var e = G.a[i];
    if (!canSource(e) || !chance(G, KIND[e] === K_STATIC ? 0.05 : 0.4)) return;
    var k = rnd(G) & 3, nx = x + NB4X[k], ny = y + NB4Y[k];
    if (KIND[e] === K_POWDER || KIND[e] === K_LIQUID) { if (chance(G, 0.6)) { nx = x; ny = y + 1; } }
    else if (KIND[e] === K_GAS || KIND[e] === K_FIRE) { if (chance(G, 0.6)) { nx = x; ny = y - 1; } }
    if (nx < 0 || ny < 0 || nx >= G.w || ny >= G.h) return;
    var j = ny * G.w + nx;
    if (G.t[j] === EMPTY) set(G, j, e, initAux(G, e));
  }
  function updDrain(G, x, y) {
    for (var k = 0; k < 4; k++) {
      var nx = x + NB4X[k], ny = y + NB4Y[k];
      if (nx < 0 || ny < 0 || nx >= G.w || ny >= G.h) continue;
      var j = ny * G.w + nx, tj = G.t[j], kd = KIND[tj];
      if (kd === K_POWDER || kd === K_LIQUID || kd === K_GAS || (kd === K_FIRE && !(G.a[j] & ANCHOR))) set(G, j, EMPTY, 0);
    }
  }

  function upd(G, x, y, i, e) {
    switch (e) {
      case SAND: fall(G, x, y, i, SAND, 0.5); break;
      case POWDER: fall(G, x, y, i, POWDER, 0.5); break;
      case SALT: updSalt(G, x, y, i); break;
      case WATER: flow(G, x, y, i, WATER, 4); break;
      case BRINE: flow(G, x, y, i, BRINE, 3); break;
      case OIL: flow(G, x, y, i, OIL, 2); break;
      case ACID: updAcid(G, x, y, i); break;
      case LAVA: updLava(G, x, y, i); break;
      case FIRE: updFire(G, x, y, i); break;
      case SMOKE: case STEAM: updGas(G, x, y, i, e); break;
      case PLANT: updPlant(G, x, y, i); break;
      case ICE: keep(G, x, y); if (chance(G, 0.0003)) set(G, i, WATER, 0); break;
      case SOURCE: updSource(G, x, y, i); break;
      case DRAIN: updDrain(G, x, y); break;
    }
  }

  // One tick: rows bottom-up, each row's scan direction random, sleeping chunks skipped.
  function step(G) {
    G.tick++; G.stamp = (G.tick % 65535) + 1;
    var cur = G.wn; G.wn = G.wc; G.wc = cur; G.wn.fill(0);
    var W = G.w, t = G.t, c = G.c, stamp = G.stamp, cw = G.cw, x, i, e;
    G.active = 0;
    for (var y = G.h - 1; y >= 0; y--) {
      var row = (y >> CSH) * cw, ltr = rnd(G) & 1, base = y * W;
      for (var k = 0; k < cw; k++) {
        var cx = ltr ? k : cw - 1 - k;
        if (!cur[row + cx]) continue;
        var x0 = cx << CSH, x1 = Math.min(W, x0 + CS);
        if (ltr) {
          for (x = x0; x < x1; x++) { i = base + x; e = t[i]; if (e !== EMPTY && c[i] !== stamp) upd(G, x, y, i, e); }
        } else {
          for (x = x1 - 1; x >= x0; x--) { i = base + x; e = t[i]; if (e !== EMPTY && c[i] !== stamp) upd(G, x, y, i, e); }
        }
      }
    }
  }
  function awakeChunks(G) { var n = 0; for (var k = 0; k < G.wn.length; k++) n += G.wn[k]; return n; }

  // What a cell looks like: element * 4 + variant (fire and gases by their life).
  function vis(G, i) {
    var e = G.t[i];
    if (e === EMPTY) return 0;
    if (e === FIRE) { var l = G.a[i] & 127; if ((G.a[i] & 192) === BLAST) return FIRE * 4; return FIRE * 4 + (l > 40 ? 0 : l > 18 ? 1 : l > 7 ? 2 : 3); }
    if (e === SMOKE || e === STEAM) { var g = G.a[i]; return e * 4 + (g > 70 ? 0 : g > 35 ? 1 : g > 14 ? 2 : 3); }
    return e * 4 + G.s[i];
  }
  function counts(G) {
    var n = new Uint32Array(NEL), t = G.t;
    for (var i = 0; i < G.N; i++) n[t[i]]++;
    return n;
  }

  // ---- painting ----
  function paintCell(G, i, e, src) {
    var t = G.t[i];
    if (e === EMPTY) { if (t !== EMPTY) set(G, i, EMPTY, 0); return; }
    if (KIND[e] === K_STATIC) {
      if (t === e && (e !== SOURCE || G.a[i] === src)) return;
      if (t === WALL && e !== WALL) return;
      set(G, i, e, initAux(G, e, src));
      return;
    }
    if (t === EMPTY && chance(G, ELS[e].fill)) set(G, i, e, initAux(G, e, src));
  }
  // A round brush of radius r (0 = one cell) at cell (cx, cy).
  function paint(G, cx, cy, r, e, src) {
    r = Math.max(0, r | 0);
    var r2 = r * r + r * 0.8;
    for (var dy = -r; dy <= r; dy++) {
      var y = cy + dy;
      if (y < 0 || y >= G.h) continue;
      for (var dx = -r; dx <= r; dx++) {
        var x = cx + dx;
        if (x < 0 || x >= G.w || dx * dx + dy * dy > r2) continue;
        paintCell(G, y * G.w + x, e, src);
      }
    }
  }
  // A stroke from (x0, y0) to (x1, y1), stamping the brush along it.
  function paintLine(G, x0, y0, x1, y1, r, e, src) {
    var dx = x1 - x0, dy = y1 - y0, n = Math.max(Math.abs(dx), Math.abs(dy)), st = Math.max(1, Math.floor(r / 2));
    var steps = Math.max(1, Math.ceil(n / st));
    for (var k = 0; k <= steps; k++) {
      var u = steps ? k / steps : 0;
      paint(G, Math.round(x0 + dx * u), Math.round(y0 + dy * u), r, e, src);
    }
  }
  function clear(G) { G.t.fill(0); G.a.fill(0); wakeAll(G); }
  function fillRect(G, x0, y0, x1, y1, e, src, p) {
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(G.w - 1, Math.round(x1)); y1 = Math.min(G.h - 1, Math.round(y1));
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
      if (p != null && !chance(G, p)) continue;
      set(G, y * G.w + x, e, initAux(G, e, src));
    }
  }
  function fillCircle(G, cx, cy, r, e, p) {
    for (var y = Math.floor(cy - r); y <= cy + r; y++) for (var x = Math.floor(cx - r); x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= G.w || y >= G.h || (x - cx) * (x - cx) + (y - cy) * (y - cy) > r * r) continue;
      if (p != null && !chance(G, p)) continue;
      set(G, y * G.w + x, e, initAux(G, e));
    }
  }
  function line(G, x0, y0, x1, y1, e, th) {
    var n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (var k = 0; k <= n; k++) {
      var x = Math.round(x0 + (x1 - x0) * k / n), y = Math.round(y0 + (y1 - y0) * k / n);
      fillRect(G, x - (th >> 1), y - (th >> 1), x + ((th - 1) >> 1), y + ((th - 1) >> 1), e);
    }
  }

  // ---- built-in scenes (any grid size: laid out in fractions) ----
  var PRESETS = [
    { id: 'garden', name: 'Garden', info: 'rain, soil and sprouts', make: function (G) {
      var W = G.w, H = G.h, gy = Math.round(H * 0.78);
      fillRect(G, 0, gy, W - 1, H - 1, SAND);
      for (var x = 0; x < W; x++) { var hh = Math.round(Math.sin(x / W * 6.28 * 1.5) * H * 0.04); fillRect(G, x, gy - hh - 1, x, gy, SAND); }
      var n = Math.max(3, Math.round(W / 14));
      for (var k = 0; k < n; k++) {
        var px = Math.round((k + 0.5) * W / n);
        var top = gy; while (top > 0 && G.t[(top - 1) * W + px] !== EMPTY) top--;
        fillRect(G, px, top - 2, px, top - 1, PLANT);
      }
      fillRect(G, Math.round(W * 0.1), 1, Math.round(W * 0.9), 1, WALL);
      for (k = 0; k < 3; k++) { var sx = Math.round(W * (0.2 + 0.3 * k)); fillRect(G, sx, 2, sx, 2, SOURCE, WATER); }
      fillRect(G, Math.round(W * 0.42), gy - Math.round(H * 0.12), Math.round(W * 0.58), gy - Math.round(H * 0.12), WOOD);
      fillRect(G, Math.round(W * 0.43), gy - Math.round(H * 0.12) - 3, Math.round(W * 0.57), gy - Math.round(H * 0.12) - 1, SALT, 0, 0.6);
    } },
    { id: 'hourglass', name: 'Hourglass', info: 'glass and falling sand', make: function (G) {
      var W = G.w, H = G.h, cx = W / 2, top = Math.round(H * 0.06), bot = Math.round(H * 0.94), mid = (top + bot) / 2, hw = Math.min(W * 0.36, H * 0.32);
      line(G, cx - hw, top, cx + hw, top, GLASS, 2);
      line(G, cx - hw, bot, cx + hw, bot, GLASS, 2);
      line(G, cx - hw, top, cx - 2, mid - 1, GLASS, 2); line(G, cx + hw, top, cx + 2, mid - 1, GLASS, 2);
      line(G, cx - 2, mid + 1, cx - hw, bot, GLASS, 2); line(G, cx + 2, mid + 1, cx + hw, bot, GLASS, 2);
      for (var y = top + 2; y < top + (mid - top) * 0.7; y++) {
        var f = (y - top) / (mid - top), half = hw * (1 - f) - 2;
        fillRect(G, cx - half, y, cx + half, y, SAND, 0, 0.85);
      }
    } },
    { id: 'volcano', name: 'Volcano', info: 'a lava chamber under stone', make: function (G) {
      var W = G.w, H = G.h, base = H - 1, cx = W / 2, peak = Math.round(H * 0.35);
      for (var x = 0; x < W; x++) {
        var d = Math.abs(x - cx) / (W * 0.42), top = Math.round(peak + (base - peak) * Math.min(1, d * d * 0.85 + d * 0.15));
        fillRect(G, x, top, x, base, STONE);
      }
      for (var y = peak; y < base - 3; y++) fillRect(G, cx - 1, y, cx + 1, y, LAVA);
      fillCircle(G, cx, base - Math.round(H * 0.12), Math.max(3, H * 0.08), LAVA);
      fillRect(G, cx, peak + 3, cx, peak + 3, SOURCE, LAVA);
      for (var k = 0; k < 4; k++) {
        var tx = Math.round(W * [0.06, 0.13, 0.87, 0.94][k]), ty = base;
        while (ty > 0 && G.t[(ty - 1) * W + tx] !== EMPTY) ty--;
        fillRect(G, tx, ty - 5, tx, ty - 1, WOOD); fillCircle(G, tx, ty - 7, 2.2, PLANT);
      }
      fillRect(G, 0, Math.round(H * 0.82), Math.round(W * 0.2), H - 1, WATER, 0, 0.9);
    } },
    { id: 'keg', name: 'Powder keg', info: 'a fuse, a spark, a chain', make: function (G) {
      var W = G.w, H = G.h, bx0 = Math.round(W * 0.55), bx1 = Math.round(W * 0.88), by0 = Math.round(H * 0.5), by1 = H - 2;
      fillRect(G, 0, H - 1, W - 1, H - 1, STONE);
      fillRect(G, bx0, by0, bx0, by1 - 2, WOOD); fillRect(G, bx1, by0, bx1, by1, WOOD); fillRect(G, bx0, by1, bx1, by1, WOOD);
      fillRect(G, bx0 + 1, by0 + 2, bx1 - 1, by1 - 1, POWDER);
      line(G, Math.round(W * 0.06), by1 - 1, bx0, by1 - 1, POWDER, 1);          // the fuse runs in through a gap in the keg
      fillRect(G, 0, by1, bx0, by1, STONE);
      set(G, (by1 - 2) * W + Math.round(W * 0.06), FIRE, 40);
      for (var k = 0; k < 3; k++) fillRect(G, Math.round(W * (0.2 + k * 0.1)), Math.round(H * 0.4), Math.round(W * (0.24 + k * 0.1)), Math.round(H * 0.7), STONE);
      fillRect(G, Math.round(W * 0.3), Math.round(H * 0.2), Math.round(W * 0.42), Math.round(H * 0.24), ICE);
    } },
    { id: 'tank', name: 'Oil & water', info: 'layers, acid and a lit match', make: function (G) {
      var W = G.w, H = G.h, x0 = Math.round(W * 0.12), x1 = Math.round(W * 0.88), y0 = Math.round(H * 0.3), y1 = H - 2;
      fillRect(G, x0, y0, x0, y1, GLASS); fillRect(G, x1, y0, x1, y1, GLASS); fillRect(G, x0, y1, x1, y1, GLASS);
      fillRect(G, x0 + 1, Math.round(H * 0.62), x1 - 1, y1 - 1, WATER);
      fillRect(G, x0 + 1, Math.round(H * 0.5), x1 - 1, Math.round(H * 0.61), OIL);
      fillRect(G, Math.round(W * 0.2), 2, Math.round(W * 0.24), 2, SOURCE, ACID);
      var mx = Math.round(W * 0.62), my0 = Math.round(H * 0.36), my1 = Math.round(H * 0.5) - 1;   // a match, burning down to the oil
      fillRect(G, mx, my0, mx + 1, my1, WOOD);
      for (var k = 0; k < 2; k++) set(G, (my0 - 1) * W + mx + k, FIRE, ANCHOR | 120);
      fillRect(G, Math.round(W * 0.78), Math.round(H * 0.2), Math.round(W * 0.84), Math.round(H * 0.28), ICE);
      fillRect(G, x1 - 2, y1 - 1, x1 - 1, y1 - 1, DRAIN);
    } }
  ];
  function presetById(id) { for (var k = 0; k < PRESETS.length; k++) if (PRESETS[k].id === id) return PRESETS[k]; return null; }
  function makePreset(G, id) {
    var p = presetById(id);
    if (!p) return false;
    clear(G); p.make(G); wakeAll(G);
    return true;
  }

  // ---- saving: run-length codes (source cells carry their material), varints, base64 ----
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64R = {};
  for (var q1 = 0; q1 < 64; q1++) B64R[B64.charAt(q1)] = q1;
  function b64enc(bytes, n) {
    var out = [], i, v;
    for (i = 0; i + 2 < n; i += 3) {
      v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out.push(B64.charAt(v >> 18), B64.charAt((v >> 12) & 63), B64.charAt((v >> 6) & 63), B64.charAt(v & 63));
    }
    if (n - i === 1) { v = bytes[i] << 16; out.push(B64.charAt(v >> 18), B64.charAt((v >> 12) & 63), '=='); }
    else if (n - i === 2) { v = (bytes[i] << 16) | (bytes[i + 1] << 8); out.push(B64.charAt(v >> 18), B64.charAt((v >> 12) & 63), B64.charAt((v >> 6) & 63), '='); }
    return out.join('');
  }
  function b64dec(s) {
    s = String(s).replace(/[^A-Za-z0-9+/]/g, '');
    var n = Math.floor(s.length * 3 / 4), out = new Uint8Array(n), o = 0, i, v;
    for (i = 0; i + 3 < s.length; i += 4) {
      v = (B64R[s.charAt(i)] << 18) | (B64R[s.charAt(i + 1)] << 12) | (B64R[s.charAt(i + 2)] << 6) | B64R[s.charAt(i + 3)];
      out[o++] = v >> 16; out[o++] = (v >> 8) & 255; out[o++] = v & 255;
    }
    var rest = s.length - i;
    if (rest >= 2) { v = (B64R[s.charAt(i)] << 18) | (B64R[s.charAt(i + 1)] << 12) | (rest === 3 ? B64R[s.charAt(i + 2)] << 6 : 0); out[o++] = v >> 16; if (rest === 3) out[o++] = (v >> 8) & 255; }
    return out.subarray(0, o);
  }
  function cellCode(G, i) { var e = G.t[i]; return e === SOURCE ? 64 + (canSource(G.a[i]) ? G.a[i] : WATER) : e; }
  function encode(G) {
    var N = G.N, buf = new Uint8Array(N * 4 + 16), n = 0, i = 0;
    while (i < N) {
      var code = cellCode(G, i), j = i + 1;
      while (j < N && cellCode(G, j) === code) j++;
      var len = j - i;
      buf[n++] = code;
      while (len >= 128) { buf[n++] = (len & 127) | 128; len >>>= 7; }
      buf[n++] = len;
      i = j;
    }
    return 'fs1.' + G.w + '.' + G.h + '.' + b64enc(buf, n);
  }
  // → { w, h, codes } or null for anything malformed
  function decode(str) {
    if (typeof str !== 'string') return null;
    var m = /^fs1\.(\d{1,4})\.(\d{1,4})\.([A-Za-z0-9+/=]*)$/.exec(str);
    if (!m) return null;
    var w = +m[1], h = +m[2];
    if (w < 4 || h < 4 || w * h > 400000) return null;
    var bytes, N = w * h, codes = new Uint8Array(N), o = 0, p = 0;
    try { bytes = b64dec(m[3]); } catch (e) { return null; }
    while (p < bytes.length && o < N) {
      var code = bytes[p++], len = 0, sh = 0, b;
      do { if (p >= bytes.length) return null; b = bytes[p++]; len += (b & 127) * Math.pow(2, sh); sh += 7; } while ((b & 128) && sh < 35);
      var e = code >= 64 ? SOURCE : code;
      if (e >= NEL || (code >= 64 && !canSource(code - 64))) return null;
      if (len < 1 || o + len > N) return null;
      codes.fill(code, o, o + len); o += len;
    }
    if (o !== N) return null;
    return { w: w, h: h, codes: codes };
  }
  // Load decoded codes into G, scaling (nearest neighbour) when the sizes differ.
  function loadCodes(G, d) {
    var t = G.t, a = G.a, s = G.s;
    for (var y = 0; y < G.h; y++) {
      var sy = Math.min(d.h - 1, Math.floor((y + 0.5) * d.h / G.h));
      for (var x = 0; x < G.w; x++) {
        var sx = Math.min(d.w - 1, Math.floor((x + 0.5) * d.w / G.w)), code = d.codes[sy * d.w + sx], i = y * G.w + x;
        if (code >= 64) { t[i] = SOURCE; a[i] = code - 64; }
        else { t[i] = code; a[i] = initAux(G, code); }
        s[i] = rnd(G) & 3;
      }
    }
    wakeAll(G);
    return G;
  }
  // A new grid of another size holding (a scaled copy of) G.
  function resize(G, w, h) {
    var g = newGrid(w, h, G ? G.r : 1);
    if (G) { var d = decode(encode(G)); if (d) loadCodes(g, d); g.booms = G.booms; g.grown = G.grown; }
    return g;
  }

  // ---- saved data ----
  var SLOTS = 6;
  function normPrefs(o) {
    var p = { tool: 'sand', src: 'water', brush: 2, speed: 2, grain: 1 };
    if (!o || typeof o !== 'object') return p;
    if (TOOLS.indexOf(o.tool) >= 0) p.tool = o.tool;
    if (BYKEY[o.src] != null && canSource(BYKEY[o.src])) p.src = o.src;
    var b = +o.brush; if (b >= 0 && b <= 12) p.brush = b | 0;
    var sp = +o.speed; if (sp >= 0 && sp < SPEEDS.length) p.speed = sp | 0;
    var g = +o.grain; if (g >= 0 && g < GRAINS.length) p.grain = g | 0;
    return p;
  }
  var SPEEDS = [0.25, 0.5, 1, 2, 3], GRAINS = [{ id: 'fine', name: 'Fine', px: 4 }, { id: 'normal', name: 'Normal', px: 7 }, { id: 'chunky', name: 'Chunky', px: 10 }];
  function normSlots(o) {
    var out = [];
    var src = o && Array.isArray(o.slots) ? o.slots : [];
    for (var k = 0; k < SLOTS; k++) {
      var s = src[k];
      if (s && typeof s === 'object' && typeof s.d === 'string' && decode(s.d)) {
        out.push({ name: String(s.name || ('Scene ' + (k + 1))).slice(0, 24), t: +s.t || 0, d: s.d });
      } else out.push(null);
    }
    return { v: 1, slots: out };
  }
  function normStats(o) {
    var s = { chain: 0, booms: 0, grown: 0, saves: 0 };
    if (!o || typeof o !== 'object') return s;
    for (var k in s) s[k] = Math.max(0, Math.floor(+o[k] || 0));
    return s;
  }

  var ENGINE = {
    EMPTY: EMPTY, WALL: WALL, SAND: SAND, WATER: WATER, STONE: STONE, WOOD: WOOD, FIRE: FIRE, SMOKE: SMOKE, STEAM: STEAM, OIL: OIL,
    PLANT: PLANT, LAVA: LAVA, ICE: ICE, ACID: ACID, POWDER: POWDER, SALT: SALT, BRINE: BRINE, GLASS: GLASS, SOURCE: SOURCE, DRAIN: DRAIN,
    NEL: NEL, ELS: ELS, KIND: KIND, DENS: DENS, BYKEY: BYKEY, TOOLS: TOOLS, PRESETS: PRESETS, SPEEDS: SPEEDS, GRAINS: GRAINS, SLOTS: SLOTS,
    K_NONE: K_NONE, K_STATIC: K_STATIC, K_POWDER: K_POWDER, K_LIQUID: K_LIQUID, K_GAS: K_GAS, K_FIRE: K_FIRE, CS: CS, TPS: TPS,
    newGrid: newGrid, step: step, paint: paint, paintLine: paintLine, clear: clear, set: set, get: get, explode: explode, vis: vis, counts: counts,
    awakeChunks: awakeChunks, makePreset: makePreset, presetById: presetById, canSource: canSource,
    encode: encode, decode: decode, loadCodes: loadCodes, resize: resize, b64enc: b64enc, b64dec: b64dec,
    normPrefs: normPrefs, normSlots: normSlots, normStats: normStats
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('fallingsand.css');

  var PANEL_ID = 'fallingsand-panel', NAME = 'Falling Sand';
  var KEY = 'cade-fallingsand-', PREFS_KEY = KEY + 'prefs', SCENES_KEY = KEY + 'scenes', STATS_KEY = KEY + 'stats', LAST_KEY = KEY + 'last', SOUND_KEY = KEY + 'sound';
  var MAX_CELLS = 46000, ATC = 16;
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.fallingsand = { live: function () { return S; } };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sjson(k) { var raw = sget(k); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function fmtInt(n) {
    n = Math.round(n);
    var s = String(Math.abs(n)), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }
  function fmtDate(t) {
    if (!t) return '';
    var d = new Date(t), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // ---- sound: a tiny WebAudio voice, created on a user gesture (iOS), closed with the panel ----
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
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  // filtered noise: booms (low-pass) and hisses (high-pass)
  Snd.prototype.noise = function (dur, vol, freq, hi) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      if (!this.nb) {
        this.nb = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
        var d = this.nb.getChannelData(0);
        for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      var t = ac.currentTime, src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = this.nb;
      f.type = hi ? 'highpass' : 'lowpass';
      f.frequency.setValueAtTime(freq, t);
      if (!hi) f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.25), t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(ac.destination);
      src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; this.nb = null; } };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_STEP = svg('<path d="M6 5l9 7-9 7z"/><path d="M18 5v14"/>');
  var IC_CLEAR = svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>');
  var IC_UNDO = svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>');
  var IC_SCENES = svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="15.5" cy="8.5" r="1.5"/>');

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
  // base hue per element: [light theme, dark theme]; fire and lava carry a hue per variant
  var HUES = {};
  HUES[SAND] = ['#b8860b', '#e3b95c']; HUES[WATER] = ['#2878b5', '#5aa9e6']; HUES[WOOD] = ['#8a5a2b', '#c48a55'];
  HUES[OIL] = ['#5e4b3c', '#b39b74']; HUES[PLANT] = ['#2f8f3a', '#7ed37a']; HUES[ICE] = ['#4f9cc0', '#a8e0f5'];
  HUES[ACID] = ['#5f9a0c', '#b6f04a']; HUES[POWDER] = ['#5c5560', '#a39aa8']; HUES[SALT] = ['#8b93a1', '#eef0f4'];
  HUES[BRINE] = ['#21848d', '#6cc8cf']; HUES[GLASS] = ['#6fa7b9', '#b5dbe6']; HUES[DRAIN] = ['#7351c4', '#b79cf5'];
  HUES[STEAM] = ['#7aa6c2', '#d6eaf7'];
  var FIRE_V = [['#d49b06', '#e2611f', '#cf3f3f', '#9a2a1a'], ['#ffd54a', '#ff8f3f', '#f06a6a', '#b8462e']];
  var LAVA_V = [['#e2611f', '#cf3f3f', '#e2611f', '#d49b06'], ['#ff8f3f', '#f06a6a', '#ff7a35', '#ffd54a']];
  // how much of the hue fills the cell behind the glyph
  var TINT = [0, 0.42, 0.16, 0.34, 0.3, 0.32, 0.22, 0.06, 0.08, 0.3, 0.2, 0.42, 0.36, 0.3, 0.16, 0.12, 0.3, 0.2, 0.3, 0.3];

  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45, di = dark ? 1 : 0;
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.55));
    S.dark = dark;
    var cols = [];
    for (var e = 0; e < NEL; e++) {
      var vs = [];
      for (var k = 0; k < 4; k++) {
        var c;
        if (e === FIRE) c = parseCol(FIRE_V[di][k]);
        else if (e === LAVA) c = parseCol(LAVA_V[di][k]);
        else if (e === SMOKE) c = mix(bg, tx, [0.55, 0.42, 0.3, 0.2][k]);
        else if (e === STEAM) c = mix(bg, parseCol(HUES[STEAM][di]), [1, 0.8, 0.6, 0.4][k]);
        else {
          var base = e === WALL ? mu : e === STONE ? mix(bg, tx, 0.5) : e === SOURCE ? ac : e === EMPTY ? bg : parseCol(HUES[e][di]);
          c = k === 0 ? base : k === 1 ? mix(base, bg, 0.16) : k === 2 ? mix(base, tx, 0.12) : mix(base, bg, 0.07);
        }
        vs.push(c);
      }
      cols.push(vs);
    }
    S.cols = cols; S.bg = bg; S.tx = tx; S.ac = ac;
    S.font = (v('--font-mono') || '').trim() || 'ui-monospace, monospace';
    buildAtlas();
    paintChips();
  }

  // ---- the glyph atlas: one opaque tile per (element, variant), at device resolution ----
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.cols || !S.dev) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') }), d = S.dev;
    a.cv.width = d * ATC; a.cv.height = d * Math.ceil(NEL * 4 / ATC);
    var c = a.cv.getContext('2d'), glyphs = S.cell >= 6, bg = S.bg;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = '700 ' + Math.max(6, Math.round(d * 1.02)) + 'px ' + S.font;
    for (var e = 0; e < NEL; e++) for (var k = 0; k < 4; k++) {
      var v = e * 4 + k, x = (v % ATC) * d, y = ((v / ATC) | 0) * d, col = S.cols[e][k];
      c.fillStyle = css(bg); c.fillRect(x, y, d, d);
      if (e === EMPTY) continue;
      if (glyphs) {
        c.fillStyle = css(mix(bg, col, TINT[e])); c.fillRect(x, y, d, d);
        c.fillStyle = css(col);
        c.fillText(ELS[e].gl.charAt(k), x + d / 2, y + d / 2 + d * 0.04);
      } else {
        c.fillStyle = css(mix(bg, col, e === SMOKE || e === STEAM ? 0.55 : 0.85)); c.fillRect(x, y, d, d);
      }
    }
    S.drawn.fill(0xffff);
    S.full = true;
  }

  // Draw only the cells whose look changed, in the chunks the engine marked.
  function render() {
    if (!S || !S.ctx || !S.atl) return;
    var G = S.G, c = S.ctx, d = S.dev, W = G.w, H = G.h, drawn = S.drawn, img = S.atl.cv, full = S.full, cw = G.cw;
    S.full = false;
    for (var cy = 0; cy < G.ch; cy++) {
      var y0 = cy << 4, y1 = Math.min(H, y0 + 16);
      for (var cx = 0; cx < cw; cx++) {
        var k = cy * cw + cx;
        if (!full && !G.rd[k]) continue;
        G.rd[k] = 0;
        var x0 = cx << 4, x1 = Math.min(W, x0 + 16);
        for (var y = y0; y < y1; y++) {
          for (var x = x0, i = y * W + x0; x < x1; x++, i++) {
            var v = vis(G, i);
            if (drawn[i] === v) continue;
            drawn[i] = v;
            c.drawImage(img, (v % ATC) * d, ((v / ATC) | 0) * d, d, d, x * d, y * d, d, d);
          }
        }
      }
    }
  }

  // ---- the brush outline over the field ----
  function drawCursor() {
    var c = S.cctx, cv = S.cur;
    if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    var h = S.hover;
    if (!h || S.cardKind) return;
    var d = S.dev, r = (S.prefs.brush + 0.5) * d, x = (h.x + 0.5) * d, y = (h.y + 0.5) * d, er = S.prefs.tool === 'erase' || (S.pen && S.pen.erase);
    c.lineWidth = Math.max(1, Math.round(d / 7));
    c.strokeStyle = css(er ? S.tx : S.ac, 0.85);
    if (er) c.setLineDash([d * 0.6, d * 0.5]);
    c.beginPath(); c.arc(x, y, Math.max(r, d * 0.7), 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
  }

  // ---- prefs, scenes, stats ----
  function persistPrefs() { sset(PREFS_KEY, JSON.stringify(S.prefs)); }
  function persistScenes() { sset(SCENES_KEY, JSON.stringify(S.scenes)); }
  function persistStats() { S.statsDirty = false; sset(STATS_KEY, JSON.stringify(S.stats)); }
  function persistLast() { if (S && S.G) { try { sset(LAST_KEY, encode(S.G)); } catch (e) {} } S.lastSave = Date.now(); }

  function toolEl(key) { return key === 'erase' ? EMPTY : BYKEY[key]; }
  function srcEl() { return BYKEY[S.prefs.src] || WATER; }
  function setTool(key) {
    if (TOOLS.indexOf(key) < 0) return;
    S.prefs.tool = key;
    var e = toolEl(key);
    if (key !== 'source' && canSource(e)) S.prefs.src = key;
    persistPrefs(); syncChips(); syncStat(); drawCursor();
    S.snd.tone(660 + TOOLS.indexOf(key) * 30, 0.04, 'sine', 0.025);
  }
  function setBrush(b) {
    S.prefs.brush = Math.max(0, Math.min(12, b));
    persistPrefs(); syncBar(); drawCursor();
  }
  var BRUSHES = [0, 1, 2, 3, 5, 8, 12];
  function brushStep(dir) {
    var b = S.prefs.brush, i = 0;
    while (i < BRUSHES.length - 1 && BRUSHES[i] < b) i++;
    if (BRUSHES[i] !== b && dir < 0) i++;
    setBrush(BRUSHES[Math.max(0, Math.min(BRUSHES.length - 1, i + dir))]);
  }
  function setSpeed(i) {
    S.prefs.speed = Math.max(0, Math.min(SPEEDS.length - 1, i));
    persistPrefs(); syncBar(); syncStat();
  }
  function spLabel(i) { var v = SPEEDS[i]; return (v === 0.25 ? '¼' : v === 0.5 ? '½' : String(v)) + '×'; }

  // ---- chips + bar ----
  function chipsHtml() {
    return TOOLS.map(function (key, n) {
      var e = toolEl(key), el = ELS[e], g = key === 'erase' ? 'x' : el.gl.charAt(0);
      var kb = n < 10 ? String((n + 1) % 10) : key === 'erase' ? 'X' : '';
      return '<button type="button" class="fs-mat" data-tool="' + key + '" title="' + esc(el.name + ' — ' + el.info) + (kb ? ' (' + kb + ')' : '') + '" aria-label="' + esc(el.name) + '">' +
        '<b class="fs-g">' + esc(g) + '</b><span class="fs-mn">' + esc(el.name) + '</span>' + (key === 'source' ? '<i class="fs-src"></i>' : '') + '</button>';
    }).join('');
  }
  function paintChips() {
    if (!S.mats) return;
    var bs = S.mats.querySelectorAll('.fs-mat');
    for (var k = 0; k < bs.length; k++) {
      var key = bs[k].getAttribute('data-tool'), e = toolEl(key);
      var col = key === 'erase' ? S.tx : S.cols[e][0];
      bs[k].style.setProperty('--fs-c', css(col));
      bs[k].style.setProperty('--fs-t', css(mix(S.bg, col, key === 'erase' ? 0.08 : Math.max(0.14, TINT[e] * 0.7))));
    }
  }
  function syncChips() {
    var bs = S.mats.querySelectorAll('.fs-mat'), on = null;
    for (var k = 0; k < bs.length; k++) {
      var sel = bs[k].getAttribute('data-tool') === S.prefs.tool;
      bs[k].classList.toggle('on', sel);
      bs[k].setAttribute('aria-pressed', sel ? 'true' : 'false');
      if (sel) on = bs[k];
    }
    var si = S.mats.querySelector('.fs-src');
    if (si) si.textContent = '> ' + ELS[srcEl()].name.toLowerCase();
    // keep the chosen chip in view in the phone's scrolling strip
    if (on && S.mats.scrollWidth > S.mats.clientWidth + 4) {
      var l = on.offsetLeft - S.mats.offsetLeft, r = l + on.offsetWidth;
      if (l < S.mats.scrollLeft) S.mats.scrollLeft = l - 8;
      else if (r > S.mats.scrollLeft + S.mats.clientWidth) S.mats.scrollLeft = r - S.mats.clientWidth + 8;
    }
  }
  function barHtml() {
    return '<div class="fs-grp fs-brush"><button type="button" data-b="brush-" title="Smaller brush ([)" aria-label="Smaller brush">&minus;</button>' +
      '<span class="fs-bs" aria-live="polite"></span><button type="button" data-b="brush+" title="Bigger brush (])" aria-label="Bigger brush">+</button></div>' +
      '<button type="button" class="fs-btn fs-play" data-b="play"></button>' +
      '<button type="button" class="fs-btn" data-b="step" title="Step one tick (.)" aria-label="Step one tick">' + IC_STEP + '<small>step</small></button>' +
      '<button type="button" class="fs-btn" data-b="speed" title="Speed (- / =)" aria-label="Speed"><b class="fs-sp"></b><small>speed</small></button>' +
      '<button type="button" class="fs-btn" data-b="clear"></button>' +
      '<button type="button" class="fs-btn" data-b="scenes" title="Scenes: starters, save and load" aria-label="Scenes">' + IC_SCENES + '<small>scenes</small></button>';
  }
  function canUndo() { return !!S.undo && Date.now() - S.undoT < 8000; }
  // the button still reads "undo" (e.g. the 8 s ran out while paused): honour what it says
  function undoVisible() { return !!S.undo && S.undoShown; }
  function syncBar() {
    if (!S) return;
    var b = S.prefs.brush, dot = b === 0 ? '.' : b <= 2 ? 'o' : b <= 5 ? 'O' : '@';
    S.bar.querySelector('.fs-bs').innerHTML = '<b>' + dot + '</b> ' + (b * 2 + 1);
    S.bar.querySelector('.fs-bs').title = 'Brush ' + (b * 2 + 1) + ' cells across';
    var pb = S.bar.querySelector('[data-b="play"]');
    pb.innerHTML = (S.paused ? IC_PLAY : IC_PAUSE) + '<small>' + (S.paused ? 'play' : 'pause') + '</small>';
    pb.title = S.paused ? 'Play (Space)' : 'Pause (Space)'; pb.setAttribute('aria-label', S.paused ? 'Play' : 'Pause');
    pb.classList.toggle('on', S.paused);
    S.bar.querySelector('.fs-sp').textContent = spLabel(S.prefs.speed);
    var cb = S.bar.querySelector('[data-b="clear"]'), u = canUndo();
    cb.innerHTML = (u ? IC_UNDO : IC_CLEAR) + '<small>' + (u ? 'undo' : 'clear') + '</small>';
    cb.title = u ? 'Undo (Z)' : 'Clear everything (C)'; cb.setAttribute('aria-label', u ? 'Undo' : 'Clear');
    cb.classList.toggle('on', u);
    S.stage.classList.toggle('paused', S.paused);
    syncHead();
  }
  function syncHead() {
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.title = S.paused ? 'Play (Space)' : 'Pause (Space)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }
  function syncStat() {
    if (!S) return;
    var n = 0, cnt = counts(S.G);
    for (var e = 2; e < NEL; e++) if (e !== WALL && e !== SOURCE && e !== DRAIN) n += cnt[e];
    S.cellsN = n;
    var el = ELS[toolEl(S.prefs.tool)];
    S.stat.innerHTML = '<span><b class="fs-dot" style="color:' + css(S.prefs.tool === 'erase' ? S.tx : S.cols[el.id][0]) + '">' + esc(S.prefs.tool === 'erase' ? 'x' : el.gl.charAt(0)) + '</b> ' +
      esc(el.name) + (S.prefs.tool === 'source' ? ' (' + esc(ELS[srcEl()].name.toLowerCase()) + ')' : '') + '</span>' +
      '<span>' + fmtInt(n) + ' grains · ' + S.G.w + '&times;' + S.G.h + (S.paused ? ' · <b class="fs-pz">paused</b>' : ' · ' + spLabel(S.prefs.speed)) + '</span>';
  }
  function say(text) {
    if (!S || !S.msg) return;
    S.msg.textContent = text;
    S.msg.classList.remove('on');
    void S.msg.offsetWidth;
    S.msg.classList.add('on');
  }

  // ---- loop ----
  function running() { return !!S && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)) && S.panel.isConnected; }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 1 / 60;
    S.last = ts;
    S.acc = Math.min(S.acc + dt * TPS * SPEEDS[S.prefs.speed], 6);
    var G = S.G;
    while (S.acc >= 1) {
      S.acc -= 1;
      if (S.pen && S.pen.pour) paintPen(S.pen.x, S.pen.y, S.pen.x, S.pen.y, true);
      step(G);
    }
    render();
    effects(dt);
    S.statT -= dt;
    if (S.statT <= 0) { S.statT = 0.3; syncStat(); if (S.undo && !canUndo() && S.undoShown) { S.undoShown = false; syncBar(); } }
    if (Date.now() - S.lastSave > 20000) persistLast();
    if (S.statsDirty && Date.now() - S.statsT > 5000) { S.statsT = Date.now(); persistStats(); }
    S.raf = requestAnimationFrame(frame);
  }
  // explosions, sizzles and growth from the engine → shake, flash, sounds, records
  function effects(dt) {
    var G = S.G, snd = S.snd, now = performance.now();
    var nb = 0;
    for (var k = 0; k < G.ev.length; k++) if (G.ev[k].k === 'boom') nb++;
    G.ev.length = 0;
    var booms = G.booms - S.seenBooms; S.seenBooms = G.booms;
    if (booms > 0) {
      S.stats.booms += booms; S.statsDirty = true;
      S.chain += booms; S.chainT = 0.7;
      if (now - S.boomAt > 90) {
        S.boomAt = now;
        snd.noise(0.35 + Math.min(0.5, booms * 0.02), Math.min(0.22, 0.06 + booms * 0.012), 900);
        snd.tone(90, 0.25, 'sine', Math.min(0.12, 0.04 + booms * 0.006), 40);
      }
      if (!S.rm) {
        S.shake = Math.min(1, S.shake + booms * 0.08);
        if (booms > 3) { S.flash.classList.remove('on'); void S.flash.offsetWidth; S.flash.classList.add('on'); }
      }
      if (Cade.haptic && now - S.hapAt > 120) { S.hapAt = now; Cade.haptic(Math.min(30, 8 + booms)); }
    } else if (S.chainT > 0) {
      S.chainT -= dt;
      if (S.chainT <= 0) {
        var n = S.chain; S.chain = 0;
        if (n >= 8) {
          if (n > S.stats.chain) {
            var first = S.stats.chain === 0;
            S.stats.chain = n; persistStats();
            say('BLAST x' + n + (first ? '' : ' — NEW RECORD'));
            if (!first) [659, 784, 988, 1319].forEach(function (fq, j) { snd.tone(fq, 0.12, 'triangle', 0.035, 0, j * 0.08); });
          } else say('BLAST x' + n);
        }
      }
    }
    var sz = G.sizzles - S.seenSz; S.seenSz = G.sizzles;
    if (sz > 0 && now - S.szAt > 160) { S.szAt = now; snd.noise(0.18, Math.min(0.05, 0.015 + sz * 0.004), 3500, true); }
    var gr = G.grown - S.seenGr; S.seenGr = G.grown;
    if (gr > 0) {
      S.stats.grown += gr; S.statsDirty = true;
      if (now - S.grAt > 420) { S.grAt = now; snd.tone(520 + Math.random() * 400, 0.06, 'sine', 0.015); }
    }
    if (S.shake > 0) {
      S.shake = Math.max(0, S.shake - dt * 3.2);
      var m = S.shake * 6;
      S.cv.style.transform = S.shake > 0.01 ? 'translate(' + ((Math.random() - 0.5) * m).toFixed(1) + 'px,' + ((Math.random() - 0.5) * m).toFixed(1) + 'px)' : '';
    }
  }

  // ---- play / pause ----
  function setPaused(p, auto) {
    if (!S) return;
    p = !!p;
    if (p === S.paused) { if (!p) S.autoP = false; return; }
    S.paused = p;
    S.autoP = p && !!auto;
    if (p) { stopLoop(); persistLast(); if (S.statsDirty) persistStats(); S.cv.style.transform = ''; S.shake = 0; }
    else kick();
    syncBar(); syncStat();
  }
  function autoPause() { if (S && !S.paused) setPaused(true, true); else if (S) persistLast(); }
  function autoResume() { if (S && S.paused && S.autoP && running0()) setPaused(false); }
  function running0() { return !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function stepOnce() {
    if (!S) return;
    if (!S.paused) setPaused(true);
    step(S.G); render(); effects(1 / 60); syncStat();
    S.snd.tone(1200, 0.025, 'square', 0.015);
  }

  // ---- scenes ----
  function snapshot() {
    S.undo = encode(S.G); S.undoT = Date.now(); S.undoShown = true; syncBar();
    clearTimeout(S.undoTimer);
    S.undoTimer = setTimeout(function () { if (S && S.undoShown && !canUndo()) { S.undoShown = false; syncBar(); } }, 8100);
  }
  function doUndo(force) {
    if (!(canUndo() || (force && undoVisible()))) return;
    var d = decode(S.undo);
    S.undo = null; S.undoShown = false;
    if (d) { loadCodes(S.G, d); S.drawn.fill(0xffff); S.full = true; render(); }
    say('UNDONE'); syncBar(); syncStat(); persistLast();
  }
  function doClear() {
    snapshot();
    clear(S.G); S.drawn.fill(0xffff); S.full = true; render();
    S.snd.noise(0.25, 0.04, 1200); syncStat(); persistLast();
    say('CLEARED');
  }
  function loadPreset(id) {
    var p = presetById(id);
    if (!p) return;
    snapshot();
    makePreset(S.G, id);
    S.drawn.fill(0xffff); S.full = true; render();
    showCard(null);
    say(p.name.toUpperCase());
    S.snd.tone(523, 0.08, 'triangle', 0.035); S.snd.tone(784, 0.12, 'triangle', 0.03, 0, 0.08);
    syncStat(); persistLast();
    if (S.paused) setPaused(false);
  }
  function loadSlot(k) {
    var sl = S.scenes.slots[k], d = sl && decode(sl.d);
    if (!d) return;
    snapshot();
    loadCodes(S.G, d);
    S.drawn.fill(0xffff); S.full = true; render();
    showCard(null);
    say('LOADED ' + sl.name.toUpperCase());
    S.snd.tone(784, 0.08, 'triangle', 0.035); S.snd.tone(1047, 0.12, 'triangle', 0.03, 0, 0.08);
    syncStat(); persistLast();
  }
  function saveSlot(k, name) {
    var nm = String(name || '').trim().slice(0, 24) || ('Scene ' + (k + 1));
    S.scenes.slots[k] = { name: nm, t: Date.now(), d: encode(S.G) };
    persistScenes();
    S.stats.saves++; persistStats();
    S.arm = null;
    S.snd.tone(988, 0.06, 'square', 0.025); S.snd.tone(1319, 0.1, 'square', 0.02, 0, 0.06);
    Cade.showToast && Cade.showToast('Saved "' + nm + '"', 'success', 1600);
    showCard('scenes');
  }
  function sceneName() {
    var inp = S.ovl.querySelector('.fs-name input');
    return inp ? inp.value : '';
  }

  // ---- cards ----
  function slotHtml(sl, k) {
    var armS = S.arm === 'save' + k, armD = S.arm === 'del' + k;
    if (!sl) {
      return '<div class="fs-slot empty"><span class="fs-th fs-th0">+</span><div class="fs-sm"><b>Empty slot</b><i>slot ' + (k + 1) + '</i></div>' +
        '<div class="fs-sb"><button type="button" class="fs-go sm" data-act="save" data-k="' + k + '">Save here</button></div></div>';
    }
    var d = decode(sl.d);
    return '<div class="fs-slot"><canvas class="fs-th" data-th="' + k + '" width="' + (d ? d.w : 1) + '" height="' + (d ? d.h : 1) + '"></canvas>' +
      '<div class="fs-sm"><b>' + esc(sl.name) + '</b><i>' + esc(fmtDate(sl.t)) + (d ? ' · ' + d.w + '&times;' + d.h : '') + '</i></div><div class="fs-sb">' +
      (armD ? '<button type="button" class="fs-go sm danger" data-act="del-yes" data-k="' + k + '">Delete</button><button type="button" class="fs-go sm alt" data-act="disarm">Keep</button>' :
        armS ? '<button type="button" class="fs-go sm" data-act="save-yes" data-k="' + k + '">Overwrite</button><button type="button" class="fs-go sm alt" data-act="disarm">Cancel</button>' :
          '<button type="button" class="fs-go sm" data-act="load" data-k="' + k + '">Load</button><button type="button" class="fs-go sm alt" data-act="save" data-k="' + k + '" title="Save the sandbox here">Save</button>' +
          '<button type="button" class="fs-x" data-act="del" data-k="' + k + '" title="Delete" aria-label="Delete ' + esc(sl.name) + '">&times;</button>') +
      '</div></div>';
  }
  function scenesHtml() {
    var free = 0;
    while (free < SLOTS && S.scenes.slots[free]) free++;
    var nm = S.nameDraft != null ? S.nameDraft : 'Scene ' + (Math.min(free, SLOTS - 1) + 1);
    return '<div class="fs-card fs-scenes"><div class="fs-title">SCENES</div>' +
      '<div class="fs-h">Starters</div><div class="fs-presets">' +
      PRESETS.map(function (p) { return '<button type="button" class="fs-pre" data-act="preset" data-id="' + p.id + '"><b>' + esc(p.name) + '</b><i>' + esc(p.info) + '</i></button>'; }).join('') + '</div>' +
      '<div class="fs-h">Your scenes</div>' +
      '<label class="fs-name"><span>Save as</span><input type="text" maxlength="24" spellcheck="false" autocomplete="off" value="' + esc(nm) + '" aria-label="Scene name"></label>' +
      '<div class="fs-slots">' + S.scenes.slots.map(slotHtml).join('') + '</div>' +
      '<div class="fs-h">Grid</div><div class="fs-seg" role="group" aria-label="Grid size">' +
      GRAINS.map(function (g, i) { return '<button type="button" data-act="grain" data-k="' + i + '" class="' + (S.prefs.grain === i ? 'on' : '') + '" aria-pressed="' + (S.prefs.grain === i) + '">' + g.name + '</button>'; }).join('') + '</div>' +
      '<div class="fs-note">Grid ' + S.G.w + '&times;' + S.G.h + ' · scenes rescale to fit</div>' +
      '<button type="button" class="fs-go" data-act="close">Back to the sandbox</button></div>';
  }
  function helpHtml(first) {
    var st = S.stats;
    var keys = S.coarse ?
      '<div><b>drag</b> on the field to paint &middot; pick a material below</div><div><b>&minus; / +</b> brush size &middot; <b>step</b> one tick at a time</div>' :
      '<div><b>drag</b> to paint &middot; <b>right-drag</b> to erase</div><div><b>1-9, 0</b> materials &middot; <b>Q / E</b> previous / next &middot; <b>X</b> eraser</div>' +
      '<div><b>[ ]</b> brush &middot; <b>- =</b> speed &middot; <b>Space</b> pause &middot; <b>.</b> step</div><div><b>C</b> clear &middot; <b>Z</b> undo &middot; <b>S</b> scenes &middot; <b>Esc</b> close</div>';
    var legend = TOOLS.map(function (key) {
      var e = toolEl(key), el = ELS[e];
      return '<div><b class="fs-g" style="color:' + css(key === 'erase' ? S.tx : S.cols[e][0]) + '">' + esc(key === 'erase' ? 'x' : el.gl.charAt(0)) + '</b> <b>' + esc(el.name) + '</b> <span>' + esc(el.info) + '</span></div>';
    }).join('');
    return '<div class="fs-card fs-help">' +
      '<pre class="fs-art" aria-hidden="true">   .  :  .\n  :.:;.:.:     ~~-~~\n :;:.:;:.:;  ~~~-~~~~</pre>' +
      '<div class="fs-title">FALLING SAND</div>' +
      '<p>Paint the elements and watch them fall, flow, burn, melt and grow. Mix them: water douses fire, lava turns water to stone and sand to glass, plants drink, salt dissolves, acid eats, gunpowder goes <b>boom</b>.</p>' +
      '<div class="fs-keys">' + keys + '</div>' +
      '<div class="fs-legend">' + legend + '</div>' +
      '<p class="fs-tip"><b>Source</b> pours whichever material you chose last &mdash; pick water, then Source, and paint a tap. <b>Drain</b> swallows whatever reaches it.</p>' +
      (st.booms || st.grown ? '<div class="fs-rec"><span>Biggest blast <b>' + (st.chain ? 'x' + fmtInt(st.chain) : '-') + '</b></span><span>Explosions <b>' + fmtInt(st.booms) + '</b></span><span>Plant growth <b>' + fmtInt(st.grown) + '</b></span></div>' : '') +
      '<button type="button" class="fs-go" data-act="close">' + (first ? 'Start playing' : 'Back to the sandbox') + '</button></div>';
  }
  function showCard(kind) {
    if (!S) return;
    if (S.thumbs) { S.thumbs.forEach(freeCanvas); S.thumbs = null; }
    S.cardKind = kind;
    if (kind !== 'scenes') { S.arm = null; S.nameDraft = null; }
    S.ovl.innerHTML = kind === 'help' ? helpHtml(S.firstRun) : kind === 'scenes' ? scenesHtml() : '';
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind);
    if (kind === 'scenes') drawThumbs();
    if (kind) { S.hover = null; drawCursor(); try { S.ovl.scrollTop = 0; } catch (e) {} }
    if (!kind) S.firstRun = false;
  }
  function drawThumbs() {
    var cvs = S.ovl.querySelectorAll('canvas[data-th]');
    S.thumbs = [];
    for (var n = 0; n < cvs.length; n++) {
      var cv = cvs[n], sl = S.scenes.slots[+cv.getAttribute('data-th')], d = sl && decode(sl.d);
      if (!d) continue;
      S.thumbs.push(cv);
      var c = cv.getContext('2d'), img = c.createImageData(d.w, d.h), px = img.data;
      var lut = [];
      for (var e = 0; e < NEL; e++) { var col = e === EMPTY ? S.bg : mix(S.bg, S.cols[e][0], e === SMOKE || e === STEAM ? 0.5 : 0.9); lut.push(col); }
      for (var i = 0; i < d.codes.length; i++) {
        var code = d.codes[i], cc = lut[code >= 64 ? SOURCE : code];
        px[i * 4] = cc[0]; px[i * 4 + 1] = cc[1]; px[i * 4 + 2] = cc[2]; px[i * 4 + 3] = 255;
      }
      c.putImageData(img, 0, 0);
    }
  }

  // ---- painting ----
  function cellAt(e) {
    var r = S.cv.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: Math.floor((e.clientX - r.left) / r.width * S.G.w), y: Math.floor((e.clientY - r.top) / r.height * S.G.h) };
  }
  function paintPen(x0, y0, x1, y1, tickPour) {
    var pen = S.pen, e = pen.erase ? EMPTY : toolEl(S.prefs.tool);
    paintLine(S.G, x0, y0, x1, y1, S.prefs.brush, e, srcEl());
    if (!tickPour) {
      var now = performance.now();
      if (now - S.paintAt > 70) {
        S.paintAt = now;
        var f = e === EMPTY ? 300 : 200 + (255 - Math.min(255, DENS[e])) * 2 + (KIND[e] === K_STATIC ? 0 : 150);
        S.snd.tone(f + Math.random() * 40, 0.035, KIND[e] === K_LIQUID ? 'sine' : 'triangle', 0.012);
      }
    }
    if (S.paused || !S.raf) { render(); }
  }
  function penDown(e) {
    if (!S || S.cardKind) return;
    if (e.button > 0 && e.button !== 2) return;
    e.preventDefault();
    S.snd.ensure();
    var p = cellAt(e);
    if (!p) return;
    try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
    var er = e.button === 2 || S.prefs.tool === 'erase', te = er ? EMPTY : toolEl(S.prefs.tool);
    S.pen = { id: e.pointerId, x: p.x, y: p.y, erase: er, pour: !er && KIND[te] !== K_STATIC };
    S.hover = p;
    paintPen(p.x, p.y, p.x, p.y);
    drawCursor();
  }
  function penMove(e) {
    if (!S || S.cardKind) return;
    var p = cellAt(e);
    if (!p) return;
    if (S.pen && S.pen.id === e.pointerId) {
      var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null, px = S.pen.x, py = S.pen.y;
      if (evs && evs.length > 1) {
        for (var k = 0; k < evs.length; k++) { var q = cellAt(evs[k]); if (q && (q.x !== px || q.y !== py)) { paintPen(px, py, q.x, q.y); px = q.x; py = q.y; } }
      } else if (p.x !== px || p.y !== py) paintPen(px, py, p.x, p.y);
      S.pen.x = p.x; S.pen.y = p.y;
    }
    if (e.pointerType !== 'touch' || S.pen) { S.hover = p; drawCursor(); }
  }
  function penUp(e) {
    if (!S) return;
    if (S.pen && S.pen.id === e.pointerId) {
      S.pen = null;
      if (e.pointerType === 'touch') S.hover = null;
      drawCursor();
      syncStat();
    }
  }

  // ---- keys ----
  function onKey(e) {
    if (!S || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    var t = e.target;
    if (t && t.tagName && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) {
      if (S.panel.contains(t) && e.key === 'Enter' && t.closest && t.closest('.fs-name')) { e.preventDefault(); var free = S.scenes.slots.indexOf(null); if (free >= 0) saveSlot(free, t.value); else if (Cade.showToast) Cade.showToast('All slots are full: pick one to overwrite', 'info', 1800); }
      else if (S.panel.contains(t) && e.key === 'Escape') { e.preventDefault(); t.blur(); }
      return;
    }
    var k = e.key || '', lk = k.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && lk === 'z') { if (canUndo()) { e.preventDefault(); doUndo(); } return; }
    if (e.ctrlKey || e.metaKey) return;
    if (k === 'Escape') { e.preventDefault(); if (S.cardKind) showCard(null); else closePanel(); return; }
    var onBtn = t && t.tagName === 'BUTTON' && S.panel.contains(t);
    if (S.cardKind) {
      if (lk === 'h' || k === '?') { e.preventDefault(); showCard(S.cardKind === 'help' ? null : 'help'); }
      else if (lk === 's') { e.preventDefault(); showCard(S.cardKind === 'scenes' ? null : 'scenes'); }
      return;
    }
    var used = true;
    if (k === ' ' || lk === 'p') { if (onBtn && k === ' ') return; if (!e.repeat) setPaused(!S.paused); }
    else if (k === '.' || lk === 'n') stepOnce();
    else if (k === '[') brushStep(-1);
    else if (k === ']') brushStep(1);
    else if (k === '-' || k === '_') setSpeed(S.prefs.speed - 1);
    else if (k === '=' || k === '+') setSpeed(S.prefs.speed + 1);
    else if (/^[0-9]$/.test(k)) setTool(TOOLS[(+k + 9) % 10]);
    else if (lk === 'q' || lk === 'e') setTool(TOOLS[(TOOLS.indexOf(S.prefs.tool) + (lk === 'e' ? 1 : TOOLS.length - 1)) % TOOLS.length]);
    else if (lk === 'x') setTool('erase');
    else if (lk === 'c') { if (!e.repeat) doClear(); }
    else if (lk === 'z') doUndo(true);
    else if (lk === 'h' || k === '?') showCard('help');
    else if (lk === 's') showCard('scenes');
    else used = false;
    if (used) e.preventDefault();
  }

  // ---- layout ----
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var maxW = phone ? vw - 34 : solo ? Math.min(vw - 60, 1100) : Math.min(vw - 48, 720);
    // the height the field may use: the viewport minus the panel's top and its other chrome
    // (title bar, materials, buttons, status line, padding), measured
    var r = S.panel.getBoundingClientRect(), hd = S.panel.querySelector('.cade-panel-head'), fs = S.panel.querySelector('.fs');
    var chrome = (hd ? hd.offsetHeight : 40) + (fs && fs.offsetHeight ? fs.offsetHeight - S.stage.offsetHeight : 150) + (phone ? 20 : 24);
    var top = solo ? Math.max(0, r.top || 0) : Math.min(Math.max(0, r.top || 50), 140);
    var avail = vh - top - chrome - 8;
    var maxH = Math.max(150, Math.min(avail, phone ? maxW * 1.45 : solo ? 760 : 430));
    var cell = GRAINS[S.prefs.grain].px;
    if (phone && cell < 5) cell = 5;
    var gw = Math.max(16, Math.floor(maxW / cell)), gh = Math.max(16, Math.floor(maxH / cell));
    while (gw * gh > MAX_CELLS) { cell++; gw = Math.max(16, Math.floor(maxW / cell)); gh = Math.max(16, Math.floor(maxH / cell)); }
    var dpr = Math.min(2, window.devicePixelRatio || 1), dev = Math.max(1, Math.round(cell * dpr));
    var devChanged = dev !== S.dev || cell !== S.cell;
    S.cell = cell; S.dev = dev; S.dpr = dpr;
    if (!S.G || S.G.w !== gw || S.G.h !== gh) {
      S.G = S.G ? resize(S.G, gw, gh) : newGrid(gw, gh, (Math.random() * 4294967295) >>> 0);
      S.seenBooms = S.G.booms; S.seenGr = S.G.grown; S.seenSz = S.G.sizzles;
      S.drawn = new Uint16Array(S.G.N);
      devChanged = true;
    }
    var cssW = gw * dev / dpr, cssH = gh * dev / dpr;
    if (S.cv.width !== gw * dev || S.cv.height !== gh * dev) { S.cv.width = gw * dev; S.cv.height = gh * dev; devChanged = true; }
    S.cur.width = gw * dev; S.cur.height = gh * dev;
    S.cv.style.width = S.cur.style.width = cssW + 'px'; S.cv.style.height = S.cur.style.height = cssH + 'px';
    S.stage.style.width = cssW + 'px'; S.stage.style.height = cssH + 'px';
    S.panel.style.setProperty('--fs-w', Math.max(cssW, phone ? 0 : 340) + 'px');
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    if (devChanged) { if (S.cols) buildAtlas(); S.drawn.fill(0xffff); S.full = true; }
    render(); drawCursor();
  }
  function relayout() { if (!S) return; layout(); syncStat(); }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S;
    try { persistLast(); if (s.statsDirty) persistStats(); } catch (e) {}
    S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT); clearTimeout(s.undoTimer);
    window.removeEventListener('pagehide', s.onHide);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('focus', s.onFocus);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    if (s.thumbs) s.thumbs.forEach(freeCanvas);
    if (s.atl) freeCanvas(s.atl.cv);
    freeCanvas(s.cv); freeCanvas(s.cur);
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
    var body = '<div class="fs"><div class="fs-stage"><canvas class="fs-cv" role="img"></canvas><canvas class="fs-cur" aria-hidden="true"></canvas>' +
      '<div class="fs-flash" aria-hidden="true"></div><div class="fs-badge" aria-hidden="true">paused</div><div class="fs-msg" aria-hidden="true"></div>' +
      '<div class="fs-ovl" style="display:none"></div></div>' +
      '<div class="fs-mats" role="toolbar" aria-label="Materials">' + chipsHtml() + '</div>' +
      '<div class="fs-bar">' + barHtml() + '</div><div class="fs-stat"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '⏳ Falling Sand', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'fs-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play (H)" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia, last = sget(LAST_KEY);
    S = {
      panel: p, head: hb, stage: p.querySelector('.fs-stage'), cv: p.querySelector('.fs-cv'), cur: p.querySelector('.fs-cur'),
      ovl: p.querySelector('.fs-ovl'), mats: p.querySelector('.fs-mats'), bar: p.querySelector('.fs-bar'), stat: p.querySelector('.fs-stat'),
      flash: p.querySelector('.fs-flash'), msg: p.querySelector('.fs-msg'),
      prefs: normPrefs(sjson(PREFS_KEY)), scenes: normSlots(sjson(SCENES_KEY)), stats: normStats(sjson(STATS_KEY)),
      snd: new Snd(sget(SOUND_KEY) === '1'), firstRun: !last,
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      G: null, drawn: new Uint16Array(1), atl: null, cols: null, cell: 0, dev: 0, full: true,
      paused: false, autoP: false, raf: 0, last: 0, acc: 0, statT: 0, lastSave: Date.now(), statsT: Date.now(), statsDirty: false,
      pen: null, hover: null, paintAt: 0, cardKind: null, arm: null, nameDraft: null, thumbs: null,
      undo: null, undoT: 0, undoShown: false,
      seenBooms: 0, seenSz: 0, seenGr: 0, chain: 0, chainT: 0, boomAt: 0, szAt: 0, grAt: 0, hapAt: 0, shake: 0
    };
    S.ctx = S.cv.getContext('2d', { alpha: false }) || S.cv.getContext('2d');
    S.cctx = S.cur.getContext('2d');
    p._onClose = teardown;
    layout();
    readTheme();
    // the sandbox as it was left, else a starter scene
    var d = last ? decode(last) : null;
    if (d) loadCodes(S.G, d); else makePreset(S.G, 'garden');
    S.drawn.fill(0xffff); S.full = true;
    render();
    syncChips(); syncBar(); syncStat();
    S.cv.setAttribute('aria-label', 'Falling sand play field. Drag to paint the chosen material.');

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (!S) return; if (document.hidden) autoPause(); else autoResume(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { S.pen = null; autoPause(); } };
    S.onFocus = function () { autoResume(); };
    window.addEventListener('blur', S.onBlur);
    window.addEventListener('focus', S.onFocus);
    S.onHide = function () { if (S) { persistLast(); if (S.statsDirty) persistStats(); } };
    window.addEventListener('pagehide', S.onHide);
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      S.pen = null; autoPause(); stopLoop();
    });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        relayout();
        autoResume();
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) relayout(); }, 140);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); render();
        if (S.cardKind) showCard(S.cardKind);
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    // header: help / sound / pause (the header drags the panel — these are controls)
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
      } else if (h === 'pause') setPaused(!S.paused);
      else if (h === 'help') showCard(S.cardKind === 'help' ? null : 'help');
      try { b.blur(); } catch (er) {}
    });

    // Rapid taps must never zoom, select, magnify or open a callout: CSS does most
    // of it; the play field cancels its touches outright and the panel swallows
    // gesture / dblclick events. (The scene-name input still takes typing.)
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchmove', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    S.bar.addEventListener('touchend', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (b && e.cancelable) { e.preventDefault(); b.click(); }   // instant, and never a double-tap zoom
    }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    S.cv.addEventListener('pointerdown', penDown);
    S.cv.addEventListener('pointermove', penMove);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.cv.addEventListener(t, penUp); });
    S.cv.addEventListener('pointerleave', function (e) { if (S && !S.pen && e.pointerType !== 'touch') { S.hover = null; drawCursor(); } });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    S.mats.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-tool]') : null;
      if (!b || !S) return;
      S.snd.ensure();
      setTool(b.getAttribute('data-tool'));
    });
    S.mats.addEventListener('wheel', function (e) {   // a mouse wheel scrolls the strip sideways on narrow screens
      if (S.mats.scrollWidth > S.mats.clientWidth + 4 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { S.mats.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
    S.bar.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-b]') : null;
      if (!b || !S) return;
      S.snd.ensure();
      var a = b.getAttribute('data-b');
      if (a === 'brush-') brushStep(-1);
      else if (a === 'brush+') brushStep(1);
      else if (a === 'play') { setPaused(!S.paused); S.snd.tone(S.paused ? 440 : 660, 0.05, 'sine', 0.03); }
      else if (a === 'step') stepOnce();
      else if (a === 'speed') { setSpeed((S.prefs.speed + 1) % SPEEDS.length); S.snd.tone(500 + S.prefs.speed * 120, 0.04, 'sine', 0.03); }
      else if (a === 'clear') { if (canUndo() || undoVisible()) doUndo(true); else doClear(); }
      else if (a === 'scenes') showCard(S.cardKind === 'scenes' ? null : 'scenes');
      if (S.cardKind && a !== 'scenes') showCard(null);
    });
    // cards
    S.ovl.addEventListener('input', function (e) { if (S && e.target.closest && e.target.closest('.fs-name')) S.nameDraft = e.target.value; });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) { if (e.target === S.ovl) showCard(null); return; }
      S.snd.ensure();
      var act = b.getAttribute('data-act'), k = +b.getAttribute('data-k');
      if (act === 'close') showCard(null);
      else if (act === 'preset') loadPreset(b.getAttribute('data-id'));
      else if (act === 'load') loadSlot(k);
      else if (act === 'save') { if (S.scenes.slots[k]) { S.arm = 'save' + k; showCard('scenes'); } else saveSlot(k, sceneName()); }
      else if (act === 'save-yes') saveSlot(k, sceneName());
      else if (act === 'del') { S.arm = 'del' + k; showCard('scenes'); }
      else if (act === 'del-yes') { S.scenes.slots[k] = null; persistScenes(); S.arm = null; showCard('scenes'); S.snd.tone(330, 0.08, 'sine', 0.03); }
      else if (act === 'disarm') { S.arm = null; showCard('scenes'); }
      else if (act === 'grain') {
        S.prefs.grain = k; persistPrefs();
        relayout(); showCard('scenes');
      }
    });

    if (S.firstRun) showCard('help');
    kick();
    // the field's size depends on the panel's real chrome: measure again once it's laid out,
    // and redraw the atlas when the mono font has loaded
    requestAnimationFrame(function () { if (S && S.panel === p) relayout(); });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('700 12px ' + S.font).then(function () { if (S && S.panel === p) { buildAtlas(); render(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'A sandbox of sand, water, fire, plants and more — watch it all interact',
    icon: '⏳',
    tags: 'toy,fun,sandbox,sand,simulation,physics,relax,powder,cellular automaton,fire,water,lava',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
