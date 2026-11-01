/* Sea Battle — hide your fleet, hunt theirs, for Cade.txt.
 * The classic hidden-fleet guessing game (own names and art): each side
 * hides a fleet on a 10x10 (or quick 8x8) grid, then the sides take turns
 * calling shots at the other's waters — miss, hit, or sunk (a sunk ship is
 * announced and shown). Sink the whole enemy fleet to win.
 * Rules: Classic (one shot a turn), Salvo (one shot per ship you still have
 * afloat, fired as one volley) or Hit again (a hit earns another shot).
 * Ships may touch, or must keep a cell of open water between them.
 * Place the fleet by hand (tap a ship, tap the grid; drag to move; tap a
 * placed ship to turn it) or at random. Play vs the computer — Easy (random
 * shots), Medium (hunt / target: parity search, then follows a hit along its
 * line) or Hard (a probability-density heatmap over every placement the
 * remaining ships could have) — or pass-and-play on one device, with a
 * privacy screen between turns so neither fleet is ever shown to the other
 * player. The CPU only ever reads the public record of shots (never the
 * hidden layout): checked in node.
 * Boards are canvases drawn in monospace glyphs (a small glyph cache) with a
 * rolling ASCII ocean, falling shells, splashes and explosions; theme colours,
 * re-read on [data-theme] changes. Animations run on a loop that only lives
 * while a game is on screen, and stops on blur, tab hide and minimize.
 * Games autosave (replayable shot history) and resume; records live in
 * Cade.store (cade-seabattle-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var MODES = ['classic', 'salvo', 'bonus'];
  var LEVELS = ['easy', 'medium', 'hard'];
  var FLEETS = {
    10: [['flagship', 'Flagship', 5], ['cruiser', 'Cruiser', 4], ['sub', 'Submarine', 3], ['frigate', 'Frigate', 3], ['skiff', 'Skiff', 2]],
    8: [['cruiser', 'Cruiser', 4], ['sub', 'Submarine', 3], ['frigate', 'Frigate', 3], ['skiff', 'Skiff', 2]]
  };
  var LETTERS = 'ABCDEFGHIJ';
  var N8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  var N4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  var DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function cellName(n, i) { return LETTERS.charAt(i % n) + (Math.floor(i / n) + 1); }
  function shipArt(len, sunk) {
    if (sunk) { var x = ''; for (var i = 0; i < len; i++) x += 'x'; return x; }
    var s = '<';
    for (var j = 1; j < len - 1; j++) s += j === Math.floor((len - 1) / 2) ? '#' : '=';
    return s + '>';
  }

  function normOpts(o) {
    o = o && typeof o === 'object' ? o : {};
    return {
      n: o.n === 8 ? 8 : 10,
      mode: MODES.indexOf(o.mode) >= 0 ? o.mode : 'classic',
      vs: o.vs === '2p' ? '2p' : 'cpu',
      level: LEVELS.indexOf(o.level) >= 0 ? o.level : 'medium',
      apart: o.apart === true
    };
  }

  // ---- a board: one side's own waters (its fleet + the shots it has taken) ----
  // shot[i]: 0 unknown, 1 miss, 2 hit, 3 part of a sunk ship. occ[i]: ship index or -1.
  function newBoard(n) {
    var f = FLEETS[n] || FLEETS[10], b = { n: f === FLEETS[n] ? n : 10, ships: [], occ: [], shot: [] };
    for (var i = 0; i < b.n * b.n; i++) { b.occ.push(-1); b.shot.push(0); }
    for (var k = 0; k < f.length; k++) b.ships.push({ id: f[k][0], name: f[k][1], len: f[k][2], r: -1, c: -1, v: false, hits: 0 });
    return b;
  }
  function cellsAt(n, len, r, c, v) {
    if (r < 0 || c < 0 || r >= n || c >= n || (v ? r + len > n : c + len > n)) return null;
    var out = [];
    for (var k = 0; k < len; k++) out.push(v ? (r + k) * n + c : r * n + c + k);
    return out;
  }
  function shipCells(b, i) {
    var s = b.ships[i];
    return s && s.r >= 0 ? cellsAt(b.n, s.len, s.r, s.c, s.v) : [];
  }
  function canPlace(b, i, r, c, v, apart) {
    var s = b.ships[i];
    if (!s) return false;
    var cells = cellsAt(b.n, s.len, r, c, v), n = b.n;
    if (!cells) return false;
    for (var k = 0; k < cells.length; k++) {
      var o = b.occ[cells[k]];
      if (o !== -1 && o !== i) return false;
      if (apart) {
        var rr = Math.floor(cells[k] / n), cc = cells[k] % n;
        for (var d = 0; d < 8; d++) {
          var r2 = rr + N8[d][0], c2 = cc + N8[d][1];
          if (r2 < 0 || c2 < 0 || r2 >= n || c2 >= n) continue;
          var o2 = b.occ[r2 * n + c2];
          if (o2 !== -1 && o2 !== i) return false;
        }
      }
    }
    return true;
  }
  function unplace(b, i) {
    var cells = shipCells(b, i);
    for (var k = 0; k < cells.length; k++) b.occ[cells[k]] = -1;
    b.ships[i].r = b.ships[i].c = -1;
  }
  function place(b, i, r, c, v, apart) {
    if (!canPlace(b, i, r, c, v, apart)) return false;
    unplace(b, i);
    var s = b.ships[i];
    s.r = r; s.c = c; s.v = !!v;
    var cells = shipCells(b, i);
    for (var k = 0; k < cells.length; k++) b.occ[cells[k]] = i;
    return true;
  }
  // Place ship i with a cell near (r, c) as its bow, shifting it back inside the grid.
  function placeNear(b, i, r, c, v, apart) {
    var len = b.ships[i].len, n = b.n;
    if (v) r = Math.min(r, n - len); else c = Math.min(c, n - len);
    return place(b, i, Math.max(0, r), Math.max(0, c), v, apart);
  }
  // Turn a placed ship about its bow; if it doesn't fit, try sliding it along the new axis.
  function rotate(b, i, apart) {
    var s = b.ships[i];
    if (!s || s.r < 0) return false;
    var v = !s.v, r = s.r, c = s.c;
    for (var d = 0; d < s.len; d++) {
      if (v ? place(b, i, r - d, c, v, apart) : place(b, i, r, c - d, v, apart)) return true;
    }
    return false;
  }
  function allPlaced(b) { for (var i = 0; i < b.ships.length; i++) if (b.ships[i].r < 0) return false; return true; }
  function clearFleet(b) { for (var i = 0; i < b.ships.length; i++) unplace(b, i); }
  function randomFleet(b, rnd, apart) {
    var order = b.ships.map(function (s, i) { return i; }).sort(function (x, y) { return b.ships[y].len - b.ships[x].len; });
    for (var attempt = 0; attempt < 300; attempt++) {
      clearFleet(b);
      var ok = true;
      for (var q = 0; q < order.length && ok; q++) {
        var done = false;
        for (var t = 0; t < 400 && !done; t++) {
          var v = rnd() < 0.5;
          done = place(b, order[q], Math.floor(rnd() * b.n), Math.floor(rnd() * b.n), v, apart);
        }
        ok = done;
      }
      if (ok) return true;
    }
    clearFleet(b);
    return false;
  }
  function fireAt(b, idx) {
    if (!(idx >= 0 && idx < b.n * b.n) || idx !== Math.floor(idx) || b.shot[idx]) return { res: 'repeat', idx: idx };
    var si = b.occ[idx];
    if (si < 0) { b.shot[idx] = 1; return { res: 'miss', idx: idx }; }
    var s = b.ships[si];
    s.hits++;
    b.shot[idx] = 2;
    if (s.hits >= s.len) {
      var cells = shipCells(b, si);
      for (var k = 0; k < cells.length; k++) b.shot[cells[k]] = 3;
      return { res: 'sunk', idx: idx, ship: si, cells: cells };
    }
    return { res: 'hit', idx: idx, ship: si };
  }
  function afloat(b) { var n = 0; for (var i = 0; i < b.ships.length; i++) if (b.ships[i].hits < b.ships[i].len) n++; return n; }
  function unknownCount(b) { var n = 0; for (var i = 0; i < b.shot.length; i++) if (!b.shot[i]) n++; return n; }

  // ---- a game: two boards, b[p] is player p's own waters; p fires at b[1 - p] ----
  function newStat() { return { shots: 0, hits: 0, sunk: 0, turns: 0, streak: 0, bestStreak: 0 }; }
  function newGame(opts, seed) {
    var o = normOpts(opts);
    return { o: o, seed: seed >>> 0, b: [newBoard(o.n), newBoard(o.n)], phase: 'place', turn: 0, winner: -1, hist: [], st: [newStat(), newStat()] };
  }
  function startPlay(g) {
    if (g.phase !== 'place' || !allPlaced(g.b[0]) || !allPlaced(g.b[1])) return false;
    g.phase = 'play'; g.turn = 0;
    return true;
  }
  function shotsAllowed(g, p) {
    var k = g.o.mode === 'salvo' ? afloat(g.b[p]) : 1;
    return Math.max(1, Math.min(k, unknownCount(g.b[1 - p])));
  }
  // Fire a turn's shots (one, or a salvo). Returns null when illegal.
  function fireTurn(g, p, cells) {
    if (!g || g.phase !== 'play' || p !== g.turn || !Array.isArray(cells)) return null;
    var tb = g.b[1 - p], k = shotsAllowed(g, p), seen = {};
    if (cells.length !== k) return null;
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (typeof c !== 'number' || c !== Math.floor(c) || c < 0 || c >= tb.n * tb.n || tb.shot[c] || seen[c]) return null;
      seen[c] = 1;
    }
    var res = [], any = false, st = g.st[p];
    for (var j = 0; j < cells.length; j++) {
      var r = fireAt(tb, cells[j]);
      res.push(r);
      st.shots++;
      if (r.res === 'miss') st.streak = 0;
      else {
        any = true; st.hits++; st.streak++;
        if (st.streak > st.bestStreak) st.bestStreak = st.streak;
        if (r.res === 'sunk') st.sunk++;
      }
    }
    st.turns++;
    g.hist.push([p, cells.slice()]);
    var over = afloat(tb) === 0, again = false;
    if (over) { g.phase = 'over'; g.winner = p; }
    else if (g.o.mode === 'bonus' && any) again = true;
    else g.turn = 1 - p;
    return { p: p, results: res, again: again, over: over };
  }

  // ---- the computer: it reads only the public record (shot[] and which ships are afloat) ----
  function view(b) {
    var lens = [];
    for (var i = 0; i < b.ships.length; i++) if (b.ships[i].hits < b.ships[i].len) lens.push(b.ships[i].len);
    return { n: b.n, s: b.shot.slice(), lens: lens };
  }
  function inb(n, r, c) { return r >= 0 && c >= 0 && r < n && c < n; }
  // Cells known to be empty when ships keep apart: around a sunk ship, and diagonal to a hit.
  function blockedCells(K, apart) {
    var n = K.n, blk = new Uint8Array(n * n);
    if (!apart) return blk;
    for (var i = 0; i < n * n; i++) {
      var sv = K.s[i];
      if (sv !== 2 && sv !== 3) continue;
      var r = Math.floor(i / n), c = i % n, L = sv === 3 ? N8 : DIAG;
      for (var d = 0; d < L.length; d++) {
        var r2 = r + L[d][0], c2 = c + L[d][1];
        if (inb(n, r2, c2) && K.s[r2 * n + c2] === 0) blk[r2 * n + c2] = 1;
      }
    }
    return blk;
  }
  function pickOne(list, rnd) { return list.length ? list[Math.floor(rnd() * list.length)] : -1; }
  function openCells(K, ex, blk) {
    var out = [];
    for (var i = 0; i < K.n * K.n; i++) if (K.s[i] === 0 && !ex[i] && !(blk && blk[i])) out.push(i);
    return out;
  }
  function hitCells(K) { var h = []; for (var i = 0; i < K.s.length; i++) if (K.s[i] === 2) h.push(i); return h; }
  function adjOpen(K, cells, ex, blk) {
    var n = K.n, out = [], seen = {};
    for (var q = 0; q < cells.length; q++) {
      var r = Math.floor(cells[q] / n), c = cells[q] % n;
      for (var d = 0; d < 4; d++) {
        var r2 = r + N4[d][0], c2 = c + N4[d][1], j = r2 * n + c2;
        if (inb(n, r2, c2) && K.s[j] === 0 && !ex[j] && !(blk && blk[j]) && !seen[j]) { seen[j] = 1; out.push(j); }
      }
    }
    return out;
  }
  function pickEasy(K, ex, rnd) {
    var hits = hitCells(K);
    if (hits.length && rnd() < 0.4) {
      var a = adjOpen(K, hits, ex, null);
      if (a.length) return pickOne(a, rnd);
    }
    return pickOne(openCells(K, ex, null), rnd);
  }
  function pickMedium(K, ex, rnd, apart) {
    var n = K.n, blk = blockedCells(K, apart), hits = hitCells(K);
    if (hits.length) {
      // a line of two or more hits: extend it at either open end
      var line = [], seen = {};
      for (var q = 0; q < hits.length; q++) {
        var r = Math.floor(hits[q] / n), c = hits[q] % n;
        for (var d = 0; d < 4; d++) {
          var dr = N4[d][0], dc = N4[d][1];
          if (!inb(n, r + dr, c + dc) || K.s[(r + dr) * n + c + dc] !== 2) continue;
          var k = 1;
          while (inb(n, r + dr * k, c + dc * k) && K.s[(r + dr * k) * n + c + dc * k] === 2) k++;
          var j = (r + dr * k) * n + c + dc * k;
          if (inb(n, r + dr * k, c + dc * k) && K.s[j] === 0 && !ex[j] && !blk[j] && !seen[j]) { seen[j] = 1; line.push(j); }
        }
      }
      if (line.length) return pickOne(line, rnd);
      var a = adjOpen(K, hits, ex, blk);
      if (a.length) return pickOne(a, rnd);
    }
    // hunt on a checkerboard spaced for the smallest ship afloat
    var m = Math.max(2, Math.min.apply(null, K.lens.length ? K.lens : [2])), par = [];
    var open = openCells(K, ex, blk);
    for (var i = 0; i < open.length; i++) {
      var rr = Math.floor(open[i] / n), cc = open[i] % n;
      if ((rr + cc) % m === 0) par.push(open[i]);
    }
    if (par.length) return pickOne(par, rnd);
    if (open.length) return pickOne(open, rnd);
    return pickOne(openCells(K, ex, null), rnd);
  }
  // Probability density: count every placement of every ship still afloat that fits
  // the record; while hits are unexplained, only placements through them count.
  function density(K, ex, apart, targeting) {
    var n = K.n, d = new Float64Array(n * n), blk = blockedCells(K, apart), total = 0;
    for (var li = 0; li < K.lens.length; li++) {
      var len = K.lens[li];
      for (var v = 0; v < 2; v++) {
        for (var r = 0; r < n; r++) {
          for (var c = 0; c < n; c++) {
            var cells = cellsAt(n, len, r, c, !!v);
            if (!cells) continue;
            var ok = true, h = 0, k, inP = {};
            for (k = 0; k < len && ok; k++) {
              var sv = K.s[cells[k]];
              if (sv === 1 || sv === 3 || blk[cells[k]]) ok = false;
              else if (sv === 2) h++;
              inP[cells[k]] = 1;
            }
            if (!ok) continue;
            if (apart && h) {
              // a hit touching this placement from outside would be another ship touching it
              for (k = 0; k < len && ok; k++) {
                var r0 = Math.floor(cells[k] / n), c0 = cells[k] % n;
                for (var q = 0; q < 8; q++) {
                  var r2 = r0 + N8[q][0], c2 = c0 + N8[q][1], j = r2 * n + c2;
                  if (inb(n, r2, c2) && !inP[j] && K.s[j] === 2) { ok = false; break; }
                }
              }
              if (!ok) continue;
            }
            var w = targeting ? (h ? Math.pow(24, h) : 0) : 1;
            if (!w) continue;
            for (k = 0; k < len; k++) if (K.s[cells[k]] === 0 && !ex[cells[k]]) { d[cells[k]] += w; total += w; }
          }
        }
      }
    }
    return { d: d, total: total };
  }
  function heatmap(b, apart) {
    var K = view(b), targeting = hitCells(K).length > 0, ex = {};
    var D = density(K, ex, apart, targeting);
    if (targeting && !D.total) D = density(K, ex, apart, false);
    return D.d;
  }
  function pickHard(K, ex, rnd, apart) {
    var targeting = hitCells(K).length > 0, D = density(K, ex, apart, targeting);
    if (targeting && !D.total) D = density(K, ex, apart, false);
    if (!D.total) return pickMedium(K, ex, rnd, apart);
    var best = -1, list = [];
    for (var i = 0; i < D.d.length; i++) {
      if (K.s[i] !== 0 || ex[i]) continue;
      var v = D.d[i];
      if (v > best * (1 + 1e-9)) { best = v; list = [i]; }
      else if (v >= best * (1 - 1e-9)) list.push(i);
    }
    return pickOne(list, rnd);
  }
  // k shots at board b for the given level (a salvo picks k distinct cells).
  function aiPick(b, level, k, rnd, apart) {
    var K = view(b), ex = {}, out = [];
    k = Math.max(1, Math.min(k || 1, unknownCount(b)));
    for (var q = 0; q < k; q++) {
      var c = level === 'easy' ? pickEasy(K, ex, rnd) : level === 'hard' ? pickHard(K, ex, rnd, apart) : pickMedium(K, ex, rnd, apart);
      if (c < 0) c = pickOne(openCells(K, ex, null), rnd);
      if (c < 0) break;
      ex[c] = 1; out.push(c);
    }
    return out;
  }
  function cpuTurn(g, rnd) {
    if (!g || g.phase !== 'play') return null;
    var p = g.turn;
    return fireTurn(g, p, aiPick(g.b[1 - p], g.o.level, shotsAllowed(g, p), rnd, g.o.apart));
  }

  // ---- saves: a game is stored as its fleets + shot history and rebuilt by replay ----
  function saveGame(g) {
    return {
      v: 1, o: g.o, seed: g.seed,
      fleets: g.b.map(function (b) { return b.ships.map(function (s) { return [s.r, s.c, s.v ? 1 : 0]; }); }),
      hist: g.hist.map(function (h) { return [h[0], h[1].slice()]; })
    };
  }
  function restoreGame(raw) {
    try {
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fleets) || raw.fleets.length !== 2 || !Array.isArray(raw.hist)) return null;
      var g = newGame(raw.o, (raw.seed >>> 0) || 1);
      for (var p = 0; p < 2; p++) {
        var f = raw.fleets[p], b = g.b[p];
        if (!Array.isArray(f) || f.length !== b.ships.length) return null;
        for (var i = 0; i < f.length; i++) {
          var e = f[i];
          if (!Array.isArray(e) || !place(b, i, +e[0], +e[1], !!e[2], g.o.apart)) return null;
        }
      }
      if (!startPlay(g)) return null;
      for (var h = 0; h < raw.hist.length; h++) {
        var t = raw.hist[h];
        if (!Array.isArray(t) || !fireTurn(g, t[0], Array.isArray(t[1]) ? t[1] : null)) return null;
      }
      return g;
    } catch (e) { return null; }
  }
  function newRec() { return { w: 0, l: 0, shots: 0, hits: 0, best: 0 }; }
  function newSave() {
    return { v: 1, opts: normOpts(null), cpu: { easy: newRec(), medium: newRec(), hard: newRec() }, pvp: { games: 0, w: [0, 0] }, streak: 0, bestStreak: 0, sunk: 0, seen: false };
  }
  function nonneg(v) { v = Math.floor(+v); return isFinite(v) && v > 0 ? v : 0; }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    s.opts = normOpts(o.opts);
    LEVELS.forEach(function (lv) {
      var r = o.cpu && o.cpu[lv];
      if (r && typeof r === 'object') {
        s.cpu[lv] = { w: nonneg(r.w), l: nonneg(r.l), shots: nonneg(r.shots), hits: nonneg(r.hits), best: nonneg(r.best) };
        if (s.cpu[lv].hits > s.cpu[lv].shots) s.cpu[lv].hits = s.cpu[lv].shots;
      }
    });
    if (o.pvp && typeof o.pvp === 'object') {
      s.pvp.games = nonneg(o.pvp.games);
      if (Array.isArray(o.pvp.w)) s.pvp.w = [nonneg(o.pvp.w[0]), nonneg(o.pvp.w[1])];
    }
    s.streak = nonneg(o.streak); s.bestStreak = Math.max(nonneg(o.bestStreak), s.streak); s.sunk = nonneg(o.sunk);
    s.seen = o.seen === true;
    return s;
  }
  // Record a finished game (vs CPU: player 0 is the human).
  function recordGame(sv, g) {
    if (!g || g.phase !== 'over') return { best: false };
    var out = { best: false };
    if (g.o.vs === 'cpu') {
      var r = sv.cpu[g.o.level], st = g.st[0];
      r.shots += st.shots; r.hits += st.hits;
      sv.sunk += st.sunk;
      if (g.winner === 0) {
        r.w++; sv.streak++;
        if (sv.streak > sv.bestStreak) sv.bestStreak = sv.streak;
        if (g.o.n === 10 && g.o.mode === 'classic' && (!r.best || st.shots < r.best)) { out.best = !!r.best; r.best = st.shots; }
      } else { r.l++; sv.streak = 0; }
    } else {
      sv.pvp.games++; sv.pvp.w[g.winner]++;
      sv.sunk += g.st[0].sunk + g.st[1].sunk;
    }
    return out;
  }

  var ENGINE = {
    MODES: MODES, LEVELS: LEVELS, FLEETS: FLEETS, rng: rng, cellName: cellName, shipArt: shipArt, normOpts: normOpts,
    newBoard: newBoard, cellsAt: cellsAt, shipCells: shipCells, canPlace: canPlace, place: place, placeNear: placeNear, unplace: unplace,
    rotate: rotate, allPlaced: allPlaced, clearFleet: clearFleet, randomFleet: randomFleet, fireAt: fireAt, afloat: afloat,
    unknownCount: unknownCount, newGame: newGame, startPlay: startPlay, shotsAllowed: shotsAllowed, fireTurn: fireTurn,
    view: view, blockedCells: blockedCells, heatmap: heatmap, aiPick: aiPick, cpuTurn: cpuTurn,
    saveGame: saveGame, restoreGame: restoreGame, newSave: newSave, normSave: normSave, recordGame: recordGame
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('seabattle.css');

  var PANEL_ID = 'seabattle-panel', NAME = 'Sea Battle';
  var KEY = 'cade-seabattle-', SAVE_KEY = KEY + 'save', GAME_KEY = KEY + 'game', SOUND_KEY = KEY + 'sound';
  var LEVEL_NAME = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
  var MODE_NAME = { classic: 'Classic', salvo: 'Salvo', bonus: 'Hit again' };
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.seabattle = { live: function () { return S; } };

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { if (Cade.store.remove) Cade.store.remove(k); else Cade.store.set(k, ''); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return normSave(o);
  }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function loadGame() {
    var raw = sget(GAME_KEY);
    if (!raw) return null;
    try { var g = restoreGame(JSON.parse(raw)); return g && g.phase === 'play' ? g : null; } catch (e) { return null; }
  }
  function persistGame() {
    if (!S || !S.g) return;
    if (S.g.phase === 'play') sset(GAME_KEY, JSON.stringify(saveGame(S.g)));
    else sdel(GAME_KEY);
  }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function pct(h, s) { return s ? Math.round(100 * h / s) + '%' : '—'; }

  // ---- sound: a tiny WebAudio voice, created on a user gesture, closed with the panel ----
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
  // a burst of filtered noise: splashes and blasts
  Snd.prototype.noise = function (dur, freq, vol, delay, q) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      if (!this.nb) {
        var len = Math.floor(ac.sampleRate * 0.8), buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.nb = buf;
      }
      var t = ac.currentTime + (delay || 0), src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = this.nb;
      f.type = 'lowpass'; f.frequency.setValueAtTime(freq, t); f.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.25), t + dur);
      f.Q.value = q || 0.7;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.1, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(ac.destination);
      src.start(t); src.stop(t + dur + 0.05);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; this.nb = null; } };
  function sfx(kind) {
    if (!S || !S.snd.on) return;
    var s = S.snd;
    if (kind === 'fire') { s.tone(180, 0.12, 'square', 0.03, 70); s.noise(0.1, 1800, 0.05); }
    else if (kind === 'miss') { s.noise(0.32, 2400, 0.07); s.tone(520, 0.2, 'sine', 0.025, 220); }
    else if (kind === 'hit') { s.noise(0.45, 900, 0.16); s.tone(110, 0.3, 'sawtooth', 0.05, 45); }
    else if (kind === 'sunk') {
      s.noise(0.8, 700, 0.18); s.tone(90, 0.6, 'sawtooth', 0.05, 35);
      s.tone(392, 0.12, 'square', 0.025, 0, 0.3); s.tone(330, 0.12, 'square', 0.025, 0, 0.42); s.tone(262, 0.25, 'square', 0.025, 0, 0.54);
    }
    else if (kind === 'tick') s.tone(880, 0.04, 'sine', 0.025);
    else if (kind === 'place') { s.tone(330, 0.06, 'triangle', 0.04); s.tone(495, 0.06, 'triangle', 0.03, 0, 0.05); }
    else if (kind === 'bad') s.tone(140, 0.12, 'square', 0.03, 110);
    else if (kind === 'win') [523, 659, 784, 1047].forEach(function (f, i) { s.tone(f, 0.18, 'square', 0.03, 0, i * 0.12); });
    else if (kind === 'lose') [392, 330, 277, 220].forEach(function (f, i) { s.tone(f, 0.24, 'triangle', 0.04, 0, i * 0.16); });
    else if (kind === 'turn') s.tone(660, 0.07, 'sine', 0.03);
  }

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
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
    var sea = dark ? [110, 182, 232] : [34, 112, 176];
    S.dark = dark;
    S.pal = {
      bg: css(bg), text: css(tx), muted: css(mu), faint: css(fa), acc: css(ac), accA: css(ac, 0.22),
      seaBg: css(mix(bg, sea, dark ? 0.1 : 0.07)), wave: css(mix(bg, sea, dark ? 0.42 : 0.36)), wave2: css(mix(bg, sea, dark ? 0.26 : 0.22)),
      grid: css(mix(bg, sea, dark ? 0.2 : 0.16)), miss: css(mix(bg, sea, dark ? 0.75 : 0.7)),
      hull: css(mix(bg, tx, dark ? 0.2 : 0.13)), hullEdge: css(mix(bg, tx, dark ? 0.55 : 0.5)), ship: css(mix(bg, tx, 0.85)),
      wreck: css(mix(bg, tx, dark ? 0.12 : 0.1)),
      red: dark ? '#f06a6a' : '#cf3f3f', redA: dark ? 'rgba(240,106,106,0.2)' : 'rgba(207,63,63,0.16)',
      flame: dark ? '#ff8f3f' : '#e2611f', gold: dark ? '#f2c544' : '#b07d06', smoke: css(mix(bg, tx, 0.4)),
      ghostOk: css(ac, 0.3), ghostBad: dark ? 'rgba(240,106,106,0.3)' : 'rgba(207,63,63,0.26)'
    };
    S.font = (v('--font-mono') || '').trim() || 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    S.gc = {};   // glyph cache depends on colours
  }

  // ---- glyph cache: each (glyph, colour, size) is rendered once to a small canvas ----
  function glyph(ch, col, px, bold) {
    px = Math.max(6, Math.round(px));
    var key = ch + '|' + col + '|' + px + (bold ? 'b' : '');
    var g = S.gc[key];
    if (g) return g;
    var cv = document.createElement('canvas'), w = Math.ceil(px * 0.9) + 4, h = Math.ceil(px * 1.3) + 4;
    cv.width = w; cv.height = h;
    var x = cv.getContext('2d');
    x.font = (bold ? '700 ' : '500 ') + px + 'px ' + S.font;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = col;
    x.fillText(ch, w / 2, h / 2 + px * 0.04);
    g = S.gc[key] = { cv: cv, w: w, h: h };
    S.gcN = (S.gcN || 0) + 1;
    if (S.gcN > 1600) { S.gc = {}; S.gcN = 0; }
    return g;
  }
  function putG(ctx, ch, col, px, x, y, alpha, bold) {
    var g = glyph(ch, col, px, bold);
    if (alpha != null && alpha < 1) { ctx.globalAlpha = Math.max(0, alpha); ctx.drawImage(g.cv, x - g.w / 2, y - g.h / 2); ctx.globalAlpha = 1; }
    else ctx.drawImage(g.cv, x - g.w / 2, y - g.h / 2);
  }
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }

  // ---- who is who ----
  function vsCpu() { return S.g && S.g.o.vs === 'cpu'; }
  function pname(p) { return vsCpu() ? (p === 0 ? 'You' : 'CPU') : 'Player ' + (p + 1); }
  // which player's waters a slot shows: 'own' = the viewer's fleet, 'tgt' = the other side
  function slotBoard(slot) { return slot === 'own' ? S.view : 1 - S.view; }
  function slotOf(pb) { return pb === S.view ? 'own' : 'tgt'; }

  // ---- the loop: animation clock, timers, shells, particles ----
  function now() { return S.clock; }
  function after(ms, fn) { S.timers.push({ at: S.clock + ms, fn: fn }); kick(); }
  function busy() { return S.shells.length > 0 || S.timers.length > 0; }
  function canRun() {
    return !!S && !document.hidden && !S.blurred && !(Cade.isMinimized && Cade.isMinimized(S.panel)) && S.panel.isConnected;
  }
  function wantLoop() {
    if (!canRun()) return false;
    if (busy() || S.fx.length || S.shake.own > 0.05 || S.shake.tgt > 0.05) return true;
    return !S.rm && S.phase !== 'home';
  }
  function kick() {
    if (!S || S.raf || S.inFrame || !wantLoop()) return;
    S.last = 0;
    S.raf = requestAnimationFrame(frame);
  }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    // timers and shell callbacks below may call kick(): S.inFrame keeps that from
    // starting a second loop (the one requested at the end of this frame is the loop)
    S.inFrame = true;
    try { step(ts); } finally { if (S) S.inFrame = false; }
    if (S && !S.raf && wantLoop()) S.raf = requestAnimationFrame(frame);
  }
  function step(ts) {
    var dt = S.last ? Math.min(50, ts - S.last) : 16;
    S.last = ts;
    S.clock += dt;
    S.wt += S.rm ? 0 : dt / 1000;
    // timers
    if (S.timers.length) {
      var due = S.timers.filter(function (t) { return t.at <= S.clock; });
      S.timers = S.timers.filter(function (t) { return t.at > S.clock; });
      due.forEach(function (t) { if (S) t.fn(); });
      if (!S) return;
    }
    // shells
    for (var i = S.shells.length - 1; i >= 0; i--) {
      var sh = S.shells[i];
      if (S.clock >= sh.t0 + sh.dur) { S.shells.splice(i, 1); land(sh); if (!S) return; }
    }
    // particles
    var k = dt / 1000;
    for (var j = S.fx.length - 1; j >= 0; j--) {
      var p = S.fx[j];
      p.life -= k;
      if (p.life <= 0) { S.fx.splice(j, 1); continue; }
      p.vy += (p.g || 0) * k; p.x += p.vx * k; p.y += p.vy * k;
      if (p.drag) { p.vx *= Math.pow(p.drag, k); p.vy *= Math.pow(p.drag, k); }
    }
    S.shake.own *= Math.pow(0.004, k); S.shake.tgt *= Math.pow(0.004, k);
    // idle: waves only — draw at ~16 fps
    var active = busy() || S.fx.length || S.shake.own > 0.05 || S.shake.tgt > 0.05 || S.dirty;
    if (active || ts - (S.lastDraw || 0) > 62) { drawAll(); S.lastDraw = ts; S.dirty = false; }
  }
  function redraw() { if (!S) return; if (S.raf) S.dirty = true; else drawAll(); }

  // ---- shots: a shell falls, then lands with a splash or a blast ----
  function launch(pb, r, delay, cb) {
    var dur = S.rm ? 140 : 360;
    S.hidden[pb][r.idx] = 1;
    after(delay, function () { sfx('fire'); });
    S.shells.push({ pb: pb, r: r, t0: S.clock + delay, dur: dur, cb: cb });
    kick();
  }
  function cellXY(V, idx) {
    var n = V.n, r = Math.floor(idx / n), c = idx % n;
    return { x: c + 0.5, y: r + 0.5 };
  }
  function burst(pb, idx, kind) {
    var n = S.g.o.n, x = idx % n + 0.5, y = Math.floor(idx / n) + 0.5, P = S.pal, i, a, sp, m = S.rm ? 0.35 : 1;
    function add(o) { o.pb = pb; S.fx.push(o); }
    if (kind === 'miss') {
      for (i = 0; i < 14 * m; i++) {
        a = -Math.PI * (0.1 + 0.8 * Math.random()); sp = 1.5 + Math.random() * 2.5;
        add({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 1.4, g: 9, life: 0.55 + Math.random() * 0.3, max: 0.85, ch: Math.random() < 0.5 ? '.' : "'", col: P.wave, sz: 0.55 });
      }
      for (i = 0; i < 8 * m; i++) {
        a = i / 8 * Math.PI * 2; sp = 1.6;
        add({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 0.08, life: 0.6, max: 0.6, ch: '~', col: P.miss, sz: 0.5 });
      }
    } else {
      var big = kind === 'sunk', cnt = (big ? 34 : 20) * m, chars = '*#@+%&';
      for (i = 0; i < cnt; i++) {
        a = Math.random() * Math.PI * 2; sp = (big ? 2.5 : 1.6) + Math.random() * (big ? 4 : 2.6);
        var col = [P.flame, P.gold, P.red][i % 3];
        add({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1, g: 4, drag: 0.2, life: 0.4 + Math.random() * 0.5, max: 0.9, ch: chars.charAt(i % chars.length), col: col, sz: 0.6, bold: true });
      }
      for (i = 0; i < (big ? 10 : 5) * m; i++) {
        add({ x: x + (Math.random() - 0.5) * 0.6, y: y, vx: (Math.random() - 0.5) * 0.6, vy: -0.8 - Math.random() * 0.8, life: 1 + Math.random() * 0.6, max: 1.6, ch: Math.random() < 0.5 ? ',' : '.', col: P.smoke, sz: 0.6 });
      }
      if (big) {
        var cells = S.g.b[pb].ships[S.g.b[pb].occ[idx]] ? shipCells(S.g.b[pb], S.g.b[pb].occ[idx]) : [];
        cells.forEach(function (ci) {
          for (var q = 0; q < 3 * m; q++) add({ x: ci % n + 0.5, y: Math.floor(ci / n) + 0.5, vx: (Math.random() - 0.5) * 2, vy: -1.5 - Math.random() * 1.5, g: 3, life: 0.7, max: 0.7, ch: '*', col: P.flame, sz: 0.5 });
        });
      }
    }
  }
  function floatText(pb, idx, txt, col) {
    var n = S.g.o.n;
    S.fx.push({ pb: pb, x: idx % n + 0.5, y: Math.floor(idx / n) + 0.1, vx: 0, vy: -1.1, life: 1.1, max: 1.1, text: txt, col: col, sz: 0.62 });
  }
  function land(sh) {
    var pb = sh.pb, r = sh.r, P = S.pal, slot = slotOf(pb);
    delete S.hidden[pb][r.idx];
    burst(pb, r.idx, r.res);
    if (r.res === 'miss') { sfx('miss'); floatText(pb, r.idx, 'MISS', P.miss); }
    else if (r.res === 'hit') { sfx('hit'); S.shake[slot] = 0.18; floatText(pb, r.idx, 'HIT!', P.flame); if (Cade.haptic) Cade.haptic(12); }
    else {
      sfx('sunk'); S.shake[slot] = 0.35;
      floatText(pb, r.idx, 'SUNK', P.red);
      if (Cade.haptic) Cade.haptic(30);
    }
    S.lastShot[pb][r.idx] = 1;
    syncHud();
    if (sh.cb) sh.cb();
  }

  // ---- drawing ----
  function drawAll() {
    if (!S || !S.pal) return;
    drawBoard('tgt'); drawBoard('own');
  }
  function drawBoard(slot) {
    var V = S.V[slot];
    if (!V || !V.ctx || !V.W) return;
    var ctx = V.ctx, P = S.pal, g = S.g, n = V.n, cs = V.cs, ox = V.ox, oy = V.oy, W = V.W, t = S.wt;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    var sk = S.shake[slot] || 0;
    if (sk > 0.02) ctx.translate((Math.random() - 0.5) * sk * cs, (Math.random() - 0.5) * sk * cs);
    var pb = g ? slotBoard(slot) : -1, b = g ? g.b[pb] : null, hide = S.cover || !g;
    // water
    ctx.fillStyle = P.seaBg;
    roundRect(ctx, ox, oy, n * cs, n * cs, Math.max(3, cs * 0.18)); ctx.fill();
    // labels
    if (V.lab) {
      var lp = cs * 0.42;
      for (var q = 0; q < n; q++) {
        putG(ctx, LETTERS.charAt(q), P.faint, lp, ox + (q + 0.5) * cs, oy - cs * 0.36, 1, true);
        var num = String(q + 1);
        if (num.length > 1) { putG(ctx, '1', P.faint, lp, ox - cs * 0.5, oy + (q + 0.5) * cs, 1, true); putG(ctx, '0', P.faint, lp, ox - cs * 0.24, oy + (q + 0.5) * cs, 1, true); }
        else putG(ctx, num, P.faint, lp, ox - cs * 0.36, oy + (q + 0.5) * cs, 1, true);
      }
    }
    // grid lines
    ctx.strokeStyle = P.grid; ctx.lineWidth = Math.max(1, Math.round(V.dpr * 0.6));
    ctx.beginPath();
    for (var gl = 1; gl < n; gl++) {
      var gx = Math.round(ox + gl * cs) + 0.5, gy = Math.round(oy + gl * cs) + 0.5;
      ctx.moveTo(gx, oy + 2); ctx.lineTo(gx, oy + n * cs - 2);
      ctx.moveTo(ox + 2, gy); ctx.lineTo(ox + n * cs - 2, gy);
    }
    ctx.stroke();
    // which ships show: your own fleet always; theirs once sunk (all at the end)
    var showShip = [];
    if (b && !hide) for (var si = 0; si < b.ships.length; si++) {
      var s = b.ships[si];
      showShip[si] = s.r >= 0 && (slot === 'own' || g.phase === 'over' || (s.hits >= s.len && !anyHidden(pb, si)));
    }
    if (slot === 'own' && S.drag && S.drag.moved && S.phase === 'place') showShip[S.drag.i] = false;
    var wavePx = cs * 0.5;
    for (var i = 0; i < n * n; i++) {
      var r = Math.floor(i / n), c = i % n, cx = ox + (c + 0.5) * cs, cy = oy + (r + 0.5) * cs;
      var sv = hide ? 0 : (S.hidden[pb] && S.hidden[pb][i] ? 0 : b.shot[i]), occ = hide ? -1 : b.occ[i];
      if (occ >= 0 && showShip[occ]) continue;   // ships are drawn below
      if (sv === 1) { putG(ctx, 'o', P.miss, cs * 0.46, cx, cy, 1, true); continue; }
      if (sv === 2 || sv === 3) {
        ctx.fillStyle = P.redA; ctx.fillRect(ox + c * cs + 1, oy + r * cs + 1, cs - 2, cs - 2);
        putG(ctx, 'X', P.red, cs * 0.62, cx, cy, 1, true);
        if (!S.rm && ((t * 6 + i * 1.7) % 3) < 1) putG(ctx, '*', P.flame, cs * 0.36, cx + cs * 0.22, cy - cs * 0.26, 0.9, true);
        continue;
      }
      // the rolling ocean (calm under an aimed / marked square so its label reads)
      if (slot === 'tgt' && !hide && (S.aim === i || S.marks.indexOf(i) >= 0)) continue;
      var w = Math.sin(t * 1.4 + c * 0.62 + r * 0.95) + 0.6 * Math.sin(t * 0.8 - r * 0.45 + c * 0.3);
      var ch = w > 0.7 ? '~' : w > -0.35 ? '-' : '.';
      putG(ctx, ch, w > 0.7 ? P.wave : P.wave2, wavePx, cx + Math.sin(t * 0.9 + r) * cs * 0.06, cy, 1, false);
    }
    // ships
    if (b && !hide) for (var sj = 0; sj < b.ships.length; sj++) if (showShip[sj]) drawShip(ctx, V, b, sj, pb, slot);
    // overlays: last shots, aim / marks, placement ghost, keyboard cursor
    if (g && !hide) {
      var ls = S.lastShot[pb];
      for (var key in ls) {
        var li = +key;
        ctx.strokeStyle = P.gold; ctx.lineWidth = Math.max(1, V.dpr);
        ctx.strokeRect(ox + (li % n) * cs + 2.5, oy + Math.floor(li / n) * cs + 2.5, cs - 5, cs - 5);
      }
      if (slot === 'tgt' && S.phase === 'play' && humanTurn()) {
        for (var mk = 0; mk < S.marks.length; mk++) aimBox(ctx, V, S.marks[mk], P.acc, String(mk + 1));
        if (S.aim >= 0 && S.marks.indexOf(S.aim) < 0) aimBox(ctx, V, S.aim, P.acc, '+');
        if (S.hover >= 0 && S.hover !== S.aim && S.marks.indexOf(S.hover) < 0 && b.shot[S.hover] === 0) aimBox(ctx, V, S.hover, P.faint, '');
      }
      if (slot === 'own' && S.phase === 'place') drawGhost(ctx, V, b);
      if (S.kbOn && S.kbSlot === slot && S.kb >= 0 && (S.phase === 'place' || (S.phase === 'play' && humanTurn()))) {
        var kr = Math.floor(S.kb / n), kc = S.kb % n;
        ctx.strokeStyle = P.text; ctx.lineWidth = Math.max(1.5, V.dpr * 1.2);
        ctx.setLineDash([cs * 0.16, cs * 0.12]);
        ctx.strokeRect(ox + kc * cs + 1.5, oy + kr * cs + 1.5, cs - 3, cs - 3);
        ctx.setLineDash([]);
      }
    }
    // shells in flight
    for (var h = 0; h < S.shells.length; h++) {
      var sh = S.shells[h];
      if (sh.pb !== pb || hide) continue;
      var u = (S.clock - sh.t0) / sh.dur;
      if (u < 0) continue;
      var p0 = cellXY(V, sh.r.idx), sx = ox + p0.x * cs, sy = oy + p0.y * cs;
      ctx.strokeStyle = P.acc; ctx.globalAlpha = 0.25 + 0.5 * u; ctx.lineWidth = Math.max(1, V.dpr);
      ctx.beginPath(); ctx.arc(sx, sy, cs * (0.55 - 0.3 * u), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      putG(ctx, u < 0.5 ? 'O' : u < 0.8 ? 'o' : '.', P.text, cs * (1.0 - 0.55 * u), sx, sy - (1 - u) * cs * 1.6, 0.4 + 0.6 * u, true);
    }
    // particles
    for (var f = 0; f < S.fx.length; f++) {
      var p = S.fx[f];
      if (p.pb !== pb || hide) continue;
      var al = Math.min(1, p.life / (p.max * 0.5));
      if (p.text) {
        ctx.globalAlpha = al;
        ctx.font = '700 ' + Math.round(cs * p.sz) + 'px ' + S.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(2, cs * 0.12); ctx.strokeStyle = P.bg; ctx.strokeText(p.text, ox + p.x * cs, oy + p.y * cs);
        ctx.fillStyle = p.col; ctx.fillText(p.text, ox + p.x * cs, oy + p.y * cs);
        ctx.globalAlpha = 1;
      } else putG(ctx, p.ch, p.col, cs * p.sz, ox + p.x * cs, oy + p.y * cs, al, p.bold);
    }
  }
  function anyHidden(pb, si) {
    var hid = S.hidden[pb], cells = shipCells(S.g.b[pb], si);
    for (var i = 0; i < cells.length; i++) if (hid[cells[i]]) return true;
    return false;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  function hullPath(ctx, V, len, r, c, v) {
    var cs = V.cs, inset = cs * 0.1, x = V.ox + c * cs + inset, y = V.oy + r * cs + inset;
    var w = (v ? 1 : len) * cs - 2 * inset, h = (v ? len : 1) * cs - 2 * inset;
    roundRect(ctx, x, y, w, h, Math.min(w, h) * 0.45);
  }
  function shipGlyph(len, k, v) {
    if (k === 0) return v ? '^' : '<';
    if (k === len - 1) return v ? 'v' : '>';
    return k === Math.floor((len - 1) / 2) ? '#' : v ? '|' : '=';
  }
  function drawShip(ctx, V, b, si, pb, slot) {
    var s = b.ships[si], P = S.pal, cs = V.cs, sunk = s.hits >= s.len && !anyHidden(pb, si), t = S.wt;
    var hidden = slot === 'tgt' && !sunk;   // revealed at the end of the game: faint and dashed
    hullPath(ctx, V, s.len, s.r, s.c, s.v);
    ctx.fillStyle = sunk ? P.wreck : P.hull; ctx.fill();
    ctx.lineWidth = Math.max(1, V.dpr);
    ctx.strokeStyle = sunk ? P.red : P.hullEdge;
    if (hidden) ctx.setLineDash([cs * 0.14, cs * 0.1]);
    ctx.stroke(); ctx.setLineDash([]);
    if (slot === 'own' && S.phase === 'place' && S.sel === si) {
      ctx.strokeStyle = P.acc; ctx.lineWidth = Math.max(2, V.dpr * 1.6); ctx.stroke();
    }
    var cells = shipCells(b, si);
    for (var k = 0; k < cells.length; k++) {
      var i = cells[k], cx = V.ox + (i % b.n + 0.5) * cs, cy = V.oy + (Math.floor(i / b.n) + 0.5) * cs;
      var sv = S.hidden[pb][i] ? 0 : b.shot[i];
      if (sunk) putG(ctx, 'x', P.red, cs * 0.5, cx, cy, 0.85, true);
      else if (sv === 2) {
        ctx.fillStyle = P.redA; ctx.fillRect(V.ox + (i % b.n) * cs + 1, V.oy + Math.floor(i / b.n) * cs + 1, cs - 2, cs - 2);
        var fl = S.rm ? 0 : Math.floor(t * 8 + k * 3) % 3;
        putG(ctx, fl === 1 ? '#' : '*', fl === 2 ? P.gold : P.flame, cs * 0.6, cx, cy, 1, true);
        if (!S.rm) putG(ctx, '.', P.smoke, cs * 0.4, cx + Math.sin(t * 3 + k) * cs * 0.12, cy - cs * (0.3 + ((t * 0.8 + k * 0.3) % 1) * 0.3), 0.7, true);
      } else putG(ctx, shipGlyph(s.len, k, s.v), hidden ? P.muted : P.ship, cs * 0.52, cx, cy, hidden ? 0.8 : 1, true);
    }
  }
  function aimBox(ctx, V, idx, col, label) {
    var n = V.n, cs = V.cs, x = V.ox + (idx % n) * cs, y = V.oy + Math.floor(idx / n) * cs, L = cs * 0.28, pad = 2;
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, V.dpr * 1.4);
    ctx.beginPath();
    ctx.moveTo(x + pad, y + pad + L); ctx.lineTo(x + pad, y + pad); ctx.lineTo(x + pad + L, y + pad);
    ctx.moveTo(x + cs - pad - L, y + pad); ctx.lineTo(x + cs - pad, y + pad); ctx.lineTo(x + cs - pad, y + pad + L);
    ctx.moveTo(x + cs - pad, y + cs - pad - L); ctx.lineTo(x + cs - pad, y + cs - pad); ctx.lineTo(x + cs - pad - L, y + cs - pad);
    ctx.moveTo(x + pad + L, y + cs - pad); ctx.lineTo(x + pad, y + cs - pad); ctx.lineTo(x + pad, y + cs - pad - L);
    ctx.stroke();
    if (label) putG(ctx, label, col, cs * 0.5, x + cs / 2, y + cs / 2, 1, true);
  }
  function drawGhost(ctx, V, b) {
    var gh = ghost();
    if (!gh) return;
    var P = S.pal, s = b.ships[gh.i], cells = cellsAt(b.n, s.len, gh.r, gh.c, gh.v);
    if (!cells) return;
    var ok = canPlace(b, gh.i, gh.r, gh.c, gh.v, S.g.o.apart);
    hullPath(ctx, V, s.len, gh.r, gh.c, gh.v);
    ctx.fillStyle = ok ? P.ghostOk : P.ghostBad; ctx.fill();
    ctx.lineWidth = Math.max(1.5, V.dpr * 1.3); ctx.strokeStyle = ok ? P.acc : P.red;
    ctx.setLineDash([V.cs * 0.16, V.cs * 0.1]); ctx.stroke(); ctx.setLineDash([]);
    for (var k = 0; k < cells.length; k++) {
      var i = cells[k];
      putG(ctx, shipGlyph(s.len, k, gh.v), ok ? P.acc : P.red, V.cs * 0.52, V.ox + (i % b.n + 0.5) * V.cs, V.oy + (Math.floor(i / b.n) + 0.5) * V.cs, 0.9, true);
    }
  }
  // the ship being dragged / about to be placed, clamped inside the grid
  function ghost() {
    var b = S.g.b[S.view], n = b.n, i, r, c, v;
    if (S.drag && S.drag.moved && S.drag.cell >= 0) {
      i = S.drag.i; v = S.drag.v;
      r = Math.floor(S.drag.cell / n) - (v ? S.drag.off : 0); c = S.drag.cell % n - (v ? 0 : S.drag.off);
    } else {
      var at = S.hover >= 0 ? S.hover : (S.kbOn ? S.kb : -1);
      if (at < 0 || S.sel < 0 || b.ships[S.sel].r >= 0) return null;
      i = S.sel; v = S.vert; r = Math.floor(at / n); c = at % n;
    }
    var len = b.ships[i].len;
    if (v) r = Math.min(r, n - len); else c = Math.min(c, n - len);
    return { i: i, r: Math.max(0, r), c: Math.max(0, c), v: v };
  }

  // ---- HUD (DOM): status line, board headers, fleet trackers, side panel, pad ----
  function humanTurn() { return S.g && S.g.phase === 'play' && !(vsCpu() && S.g.turn === 1) && !S.locked; }
  function syncHud() {
    if (!S) return;
    var g = S.g, R = S.root;
    R.classList.toggle('ph-place', S.phase === 'place');
    R.classList.toggle('cover', !!S.cover);
    var tt = S.el.tgtT, ot = S.el.ownT;
    if (!g) {
      tt.textContent = 'ENEMY WATERS'; ot.textContent = 'YOUR FLEET';
      S.el.tgtK.innerHTML = ''; S.el.ownK.innerHTML = ''; S.el.side.innerHTML = ''; setMsg('');
      return;
    }
    var other = 1 - S.view;
    tt.textContent = vsCpu() ? 'ENEMY WATERS' : (pname(other) + '’S WATERS').toUpperCase();
    ot.textContent = vsCpu() ? 'YOUR FLEET' : (pname(S.view) + '’S FLEET').toUpperCase();
    if (S.cover) { S.el.tgtK.innerHTML = ''; S.el.ownK.innerHTML = ''; S.el.side.innerHTML = ''; return; }
    var tb = g.b[other], ob = g.b[S.view];
    S.el.tgtK.innerHTML = '<span class="sb-left">' + afloatShown(other) + '/' + tb.ships.length + '</span>' + trackerShown(other);
    S.el.ownK.innerHTML = '<span class="sb-left">' + afloatShown(S.view) + '/' + ob.ships.length + '</span>' + trackerShown(S.view);
    var st = g.st[S.view];
    S.el.side.innerHTML = '<div class="sb-stat"><span>shots <b>' + st.shots + '</b></span><span>hits <b>' + st.hits + '</b></span><span>acc <b>' + pct(st.hits, st.shots) + '</b></span></div>' +
      '<div class="sb-log">' + S.log.slice(-3).map(function (l) { return '<div class="' + l.cls + '">' + esc(l.t) + '</div>'; }).join('') + '</div>';
  }
  // trackers show a ship as sunk only once its last shell has landed
  function trackerShown(pb) {
    var b = S.g.b[pb];
    return b.ships.map(function (s, si) {
      var sunk = s.hits >= s.len && !anyHidden(pb, si);
      return '<span class="sb-tk' + (sunk ? ' sunk' : '') + '" title="' + esc(s.name) + ' (' + s.len + ')' + (sunk ? ' — sunk' : '') + '">' + esc(shipArt(s.len, false)) + '</span>';
    }).join('');
  }
  function afloatShown(pb) {
    var b = S.g.b[pb], n = 0;
    b.ships.forEach(function (s, si) { if (!(s.hits >= s.len && !anyHidden(pb, si))) n++; });
    return n;
  }
  function setMsg(html, cls) {
    S.el.msg.innerHTML = html;
    S.el.msg.className = 'sb-msg' + (cls ? ' ' + cls : '');
  }
  function say(t) { if (S && S.el.live) S.el.live.textContent = t; }
  function addLog(t, cls) { S.log.push({ t: t, cls: cls || '' }); if (S.log.length > 30) S.log.shift(); }

  function setPad(mode) {
    var h = '', g = S.g;
    S.padMode = mode;
    if (mode === 'place') {
      var ready = allPlaced(g.b[S.view]);
      h = '<button type="button" class="sb-act alt" data-act="rotate" title="Rotate (R)">⟳ <small>rotate</small></button>' +
        '<button type="button" class="sb-act alt" data-act="random" title="Random fleet (X)">⚄ <small>random</small></button>' +
        '<button type="button" class="sb-act" data-act="ready"' + (ready ? '' : ' disabled') + '>Ready ▸</button>';
    } else if (mode === 'aim') {
      var k = shotsAllowed(g, g.turn), salvo = g.o.mode === 'salvo';
      if (salvo) {
        h = '<button type="button" class="sb-act alt" data-act="clear"' + (S.marks.length ? '' : ' disabled') + '>Clear</button>' +
          '<button type="button" class="sb-act" data-act="fire"' + (S.marks.length === k ? '' : ' disabled') + '>Fire ' + S.marks.length + '/' + k + '</button>';
      } else {
        h = '<button type="button" class="sb-act" data-act="fire"' + (S.aim >= 0 ? '' : ' disabled') + '>Fire' + (S.aim >= 0 ? ' ▸ ' + cellName(g.o.n, S.aim) : '') + '</button>';
      }
    } else if (mode === 'wait') {
      h = '<button type="button" class="sb-act alt" disabled>' + esc(S.waitLabel || '…') + '</button>';
    } else if (mode === 'over') {
      h = '<button type="button" class="sb-act alt" data-act="menu">Menu</button><button type="button" class="sb-act" data-act="rematch">Rematch</button>';
    } else if (mode === 'home') {
      h = '';
    }
    S.el.pad.innerHTML = h;
    S.el.pad.style.display = h ? '' : 'none';
  }
  function syncHead() {
    if (!S) return;
    var sb = S.head.querySelector('[data-h="sound"]');
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }

  // ---- cards ----
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'home' ? homeHtml() : kind === 'help' ? helpHtml() : kind === 'stats' ? statsHtml() : kind === 'pass' ? passHtml() :
      kind === 'over' ? overHtml() : '';
    S.el.ovl.innerHTML = h;
    S.el.ovl.style.display = kind ? '' : 'none';
    S.root.classList.toggle('dim', !!kind);
    fitCard();
    if (kind) {
      var f = S.el.ovl.querySelector('[data-focus]');
      if (f && !S.coarse) { try { f.focus({ preventScroll: true }); } catch (e) {} }
      S.el.ovl.scrollTop = 0;
    }
  }
  // a card taller than the boards grows the play area (within the viewport) rather than clipping
  function fitCard() {
    var R = S.root, c = S.cardKind && S.el.ovl.firstChild;
    R.style.minHeight = '';
    if (!c || !c.offsetHeight) return;
    var h = c.offsetHeight + 18, max = (window.innerHeight || 600) - Math.max(0, R.getBoundingClientRect().top) - 16;
    if (h > R.offsetHeight) R.style.minHeight = Math.max(R.offsetHeight, Math.min(h, max)) + 'px';
  }
  var ART = [
    '          |>',
    '        __|__',
    '   ____|_____|____',
    '   \\  o  o  o  o /',
    ' ~~~\\___________/~~~'
  ].join('\n');
  function chips(name, cur, list) {
    return '<div class="sb-chips" role="group">' + list.map(function (it) {
      return '<button type="button" class="sb-chip' + (String(it[0]) === String(cur) ? ' on' : '') + '" data-opt="' + name + '" data-val="' + it[0] + '" aria-pressed="' + (String(it[0]) === String(cur)) + '">' + it[1] + '</button>';
    }).join('') + '</div>';
  }
  function homeHtml() {
    var o = S.save.opts, sg = S.saved;
    var resume = sg ? '<button type="button" class="sb-go alt" data-act="resume" data-focus>Resume <small>' + esc(sg.o.vs === 'cpu' ? 'vs CPU · ' + LEVEL_NAME[sg.o.level] : '2 players') + ' · ' + MODE_NAME[sg.o.mode] + '</small></button>' : '';
    return '<div class="sb-card">' +
      '<div class="sb-title">SEA BATTLE</div>' +
      '<pre class="sb-art" aria-hidden="true">' + esc(ART) + '</pre>' +
      '<p class="sb-sub">Hide your fleet. Hunt theirs.</p>' +
      '<div class="sb-sec"><div class="sb-h">Opponent</div>' + chips('vs', o.vs, [['cpu', 'vs CPU'], ['2p', '2 players']]) + '</div>' +
      (o.vs === 'cpu' ? '<div class="sb-sec"><div class="sb-h">CPU</div>' + chips('level', o.level, [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']]) + '</div>' : '') +
      '<div class="sb-sec"><div class="sb-h">Rules</div>' + chips('mode', o.mode, [['classic', 'Classic'], ['salvo', 'Salvo'], ['bonus', 'Hit again']]) + '</div>' +
      '<div class="sb-sec sb-two"><div><div class="sb-h">Waters</div>' + chips('n', o.n, [[10, '10×10'], [8, '8×8']]) + '</div>' +
      '<div><div class="sb-h">Ships</div>' + chips('apart', o.apart ? 1 : 0, [[0, 'may touch'], [1, 'apart']]) + '</div></div>' +
      '<p class="sb-note">' + esc(ruleNote(o)) + '</p>' +
      '<div class="sb-btns">' + resume + '<button type="button" class="sb-go" data-act="new"' + (sg ? '' : ' data-focus') + '>New game</button></div>' +
      '<div class="sb-foot"><button type="button" class="sb-lnk" data-act="stats">Records</button><button type="button" class="sb-lnk" data-act="help">How to play</button></div>' +
      '</div>';
  }
  function ruleNote(o) {
    var m = o.mode === 'salvo' ? 'Salvo: one shot for every ship you still have afloat, fired together.' :
      o.mode === 'bonus' ? 'Hit again: every hit earns another shot.' : 'Classic: one shot a turn.';
    var lv = o.vs === 'cpu' ? (o.level === 'easy' ? ' Easy fires mostly at random.' : o.level === 'medium' ? ' Medium hunts, then chases hits.' : ' Hard reads the odds of every square.') : ' Pass the device between turns.';
    return m + lv;
  }
  function helpHtml() {
    return '<div class="sb-card">' +
      '<div class="sb-title">HOW TO PLAY</div>' +
      '<p>Both sides hide a fleet in their own waters, then take turns calling shots into the other’s grid. <b>o</b> is a miss, <b class="sb-red">X</b> a hit; when every square of a ship is hit it is <b>sunk</b> and shown. Sink the whole enemy fleet to win.</p>' +
      '<p><b>Deploy:</b> tap a ship in the list, then tap the grid. Drag a ship to move it; tap a placed ship to turn it. Or roll a random fleet.</p>' +
      '<p><b>Fire:</b> click a square (on touch: tap to aim, tap again or press Fire). In <b>Salvo</b> mark one square per ship you have afloat, then Fire.</p>' +
      '<div class="sb-keys"><span><b>arrows</b> move · <b>enter / space</b> place / fire</span><span><b>R</b> rotate · <b>X</b> random fleet · <b>1-5</b> pick a ship</span><span><b>esc</b> back / menu</span></div>' +
      '<p><b>2 players:</b> pass the device when asked — a cover hides both boards until the next player taps.</p>' +
      '<div class="sb-btns"><button type="button" class="sb-go" data-act="close-help" data-focus>Got it</button></div>' +
      '</div>';
  }
  function statsHtml() {
    var sv = S.save, rows = LEVELS.map(function (lv) {
      var r = sv.cpu[lv];
      return '<b>' + pad(LEVEL_NAME[lv], 7) + '</b>' + pad(r.w + '-' + r.l, 8) + pad(pct(r.hits, r.shots), 6) + (r.best ? r.best : '—');
    });
    return '<div class="sb-card">' +
      '<div class="sb-title">RECORDS</div>' +
      '<pre class="sb-tab"><i>' + pad('vs CPU', 7) + pad('W-L', 8) + pad('acc', 6) + 'best</i>\n' + rows.join('\n') + '</pre>' +
      '<p class="sb-note">best = fewest shots to win (10×10, Classic)</p>' +
      '<pre class="sb-tab">' + 'win streak   <b>' + sv.streak + '</b>  (best ' + sv.bestStreak + ')\n' +
      'ships sunk   <b>' + sv.sunk + '</b>\n' +
      '2P games     <b>' + sv.pvp.games + '</b>  (P1 ' + sv.pvp.w[0] + ' · P2 ' + sv.pvp.w[1] + ')</pre>' +
      (S.resetArm ? '<p class="sb-confirm">Reset all records?</p><div class="sb-btns"><button type="button" class="sb-go alt" data-act="reset-no">Keep</button><button type="button" class="sb-go danger" data-act="reset-yes">Reset</button></div>' :
        '<div class="sb-btns"><button type="button" class="sb-go" data-act="close-help" data-focus>Back</button></div><div class="sb-foot"><span></span><button type="button" class="sb-lnk danger" data-act="reset">Reset records</button></div>') +
      '</div>';
  }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function passHtml() {
    var p = S.passTo, place = S.passPlace;
    return '<div class="sb-card sb-pass">' +
      '<div class="sb-title">PASS</div>' +
      '<pre class="sb-art" aria-hidden="true">' + esc('  ~  ~ ~   ~  ~\n ~ ~   ~  ~ ~  ~\n  ~  ~ ~   ~  ~') + '</pre>' +
      '<div class="sb-big">' + esc(pname(p)) + '</div>' +
      '<p class="sb-sub">' + (place ? 'Hide your fleet — no peeking, ' + esc(pname(1 - p)) + '.' : 'Your turn to fire. ' + esc(pname(1 - p)) + ', look away.') + '</p>' +
      (S.passNote ? '<p class="sb-note">' + esc(S.passNote) + '</p>' : '') +
      '<div class="sb-btns"><button type="button" class="sb-go" data-act="ready-pass" data-focus>Tap when ready</button></div>' +
      '</div>';
  }
  function overHtml() {
    var g = S.g, w = g.winner, st = g.st, cpu = vsCpu(), won = cpu ? w === 0 : true;
    var title = cpu ? (w === 0 ? 'VICTORY' : 'DEFEAT') : pname(w).toUpperCase() + ' WINS';
    var line = function (p) { return '<b>' + pad(pname(p), 9) + '</b>' + pad(st[p].shots, 6) + pad(st[p].hits, 5) + pad(pct(st[p].hits, st[p].shots), 5) + st[p].bestStreak; };
    return '<div class="sb-card">' +
      '<div class="sb-title">' + esc(title) + '</div>' +
      '<pre class="sb-art' + (won ? '' : ' sad') + '" aria-hidden="true">' + esc(won ? '   \\ | /\n  -- * --\n   / | \\' : '   . , .\n  ~~x x~~\n ~~~~~~~~') + '</pre>' +
      (S.newBest ? '<div class="sb-new">NEW RECORD — ' + st[0].shots + ' SHOTS</div>' : '') +
      '<pre class="sb-tab"><i>' + pad('', 9) + pad('shots', 6) + pad('hits', 5) + pad('acc', 5) + 'run</i>\n' + line(0) + '\n' + line(1) + '</pre>' +
      '<p class="sb-note">' + esc(MODE_NAME[g.o.mode] + ' · ' + g.o.n + '×' + g.o.n + (cpu ? ' · ' + LEVEL_NAME[g.o.level] : '') + ' · run = most hits in a row') + '</p>' +
      '<div class="sb-btns"><button type="button" class="sb-go alt" data-act="look">See boards</button><button type="button" class="sb-go" data-act="rematch" data-focus>Rematch</button></div>' +
      '<div class="sb-foot"><span></span><button type="button" class="sb-lnk" data-act="menu">Menu</button></div>' +
      '</div>';
  }

  // ---- flow ----
  function toHome() {
    S.phase = 'home'; S.g = null; S.cover = false; S.resetArm = false; S.locked = false;
    S.timers = []; S.shells = []; S.fx = []; S.drag = null;
    S.saved = loadGame();
    S.view = 0;
    setPad('home'); syncHud(); setMsg('');
    S.focus = 'tgt';
    layout();
    showCard(S.save.seen ? 'home' : 'help');
    if (!S.save.seen) { S.save.seen = true; persist(); S.helpBack = 'home'; }
    drawAll(); kick();
  }
  function resetView() {
    S.hidden = [{}, {}]; S.lastShot = [{}, {}]; S.marks = []; S.aim = -1; S.hover = -1; S.kb = -1; S.kbOn = false;
    S.timers = []; S.shells = []; S.fx = []; S.log = []; S.drag = null; S.locked = false; S.newBest = false;
  }
  function newGameFlow() {
    S.snd.ensure();
    sdel(GAME_KEY); S.saved = null;
    var seed = (Math.random() * 4294967295) >>> 0;
    S.g = newGame(S.save.opts, seed);
    S.rnd = rng(seed ^ 0x5EA);
    resetView();
    S.view = 0;
    if (S.g.o.vs === 'cpu') randomFleet(S.g.b[1], S.rnd, S.g.o.apart);
    if (S.g.o.vs === '2p') { passScreen(0, true); return; }
    beginPlace(0);
  }
  function beginPlace(p) {
    S.phase = 'place'; S.view = p; S.cover = false;
    S.sel = 0; S.vert = false; S.kbSlot = 'own'; S.kb = -1;
    showCard(null);
    setMsg(vsCpu() ? 'Deploy your fleet' : esc(pname(p)) + ': deploy your fleet', 'turn');
    renderDock(); setPad('place'); syncHud(); layout(); redraw(); kick();
  }
  function renderDock() {
    var b = S.g.b[S.view];
    S.el.dock.innerHTML = '<div class="sb-ships">' + b.ships.map(function (s, i) {
      var on = s.r >= 0;
      return '<button type="button" class="sb-ship' + (on ? ' set' : '') + (S.sel === i ? ' sel' : '') + '" data-ship="' + i + '">' +
        '<span class="sb-sa">' + esc(shipArt(s.len, false)) + '</span><span class="sb-sn">' + (i + 1) + ' ' + esc(s.name) + '</span><span class="sb-ok">' + (on ? '✓' : '') + '</span></button>';
    }).join('') + '</div>' +
      '<p class="sb-tip">' + (S.coarse ? 'Tap a ship, then the grid · drag to move · tap a placed ship to turn it.' : 'Pick a ship, click the grid. Drag to move; click a placed ship (or R) to turn it.') +
      (S.g.o.apart ? ' Ships must not touch.' : '') + ' <button type="button" class="sb-lnk" data-act="clearfleet">Clear</button></p>';
  }
  function nextUnplaced(from) {
    var b = S.g.b[S.view], n = b.ships.length;
    for (var k = 1; k <= n; k++) { var i = (from + k) % n; if (b.ships[i].r < 0) return i; }
    return -1;
  }
  function afterPlaceChange() { renderDock(); setPad('place'); redraw(); }
  function placeReady() {
    var g = S.g;
    if (!allPlaced(g.b[S.view])) { sfx('bad'); return; }
    sfx('place');
    if (g.o.vs === '2p' && S.view === 0) { passScreen(1, true); return; }
    startPlay(g);
    persistGame();
    addLog(vsCpu() ? 'Fleets deployed. You fire first.' : 'Fleets deployed. Player 1 fires first.', 'dim');
    if (g.o.vs === '2p') passScreen(0, false);
    else beginTurn();
  }
  function passScreen(p, placing, note) {
    S.phase = placing ? 'pass-place' : 'pass';
    S.passTo = p; S.passPlace = placing; S.passNote = note || '';
    S.cover = true; S.drag = null; S.marks = []; S.aim = -1; S.hover = -1;
    setPad('home'); setMsg(''); syncHud();
    showCard('pass');
    redraw();
  }
  function passReady() {
    var p = S.passTo;
    S.cover = false;
    S.snd.ensure();
    if (S.passPlace) beginPlace(p);
    else { S.view = p; beginTurn(); }
  }
  function beginTurn() {
    var g = S.g;
    if (g.phase !== 'play') return;
    S.phase = 'play'; S.locked = false; S.marks = []; S.aim = -1;
    showCard(null);
    var cpuT = vsCpu() && g.turn === 1;
    S.focus = cpuT ? 'own' : 'tgt';
    S.kbSlot = 'tgt';
    syncHud();
    if (cpuT) {
      S.locked = true;
      S.waitLabel = 'CPU is aiming…'; setPad('wait');
      setMsg('<span class="sb-think">CPU is aiming<b>.</b><b>.</b><b>.</b></span>', 'cpu');
      after(S.rm ? 250 : 520 + Math.random() * 380, cpuFire);
    } else {
      var k = shotsAllowed(g, g.turn);
      setMsg(g.o.mode === 'salvo' ? (vsCpu() ? 'Your' : esc(pname(g.turn)) + '’s') + ' salvo — mark <b>' + k + '</b> square' + (k > 1 ? 's' : '') : (vsCpu() ? 'Your turn' : esc(pname(g.turn)) + '’s turn') + ' — pick a target', 'turn');
      setPad('aim');
      sfx('turn');
    }
    layout(); kick();
  }
  function resLine(who, g, r, pb) {
    var cn = cellName(g.o.n, r.idx);
    if (r.res === 'miss') return who + ' ' + cn + ' — miss';
    if (r.res === 'hit') return who + ' ' + cn + ' — hit!';
    return who + ' ' + cn + ' — sank ' + (pb === S.view && vsCpu() ? 'your ' : 'the ') + g.b[pb].ships[r.ship].name + '!';
  }
  function humanFire(cells) {
    var g = S.g, p = g.turn;
    if (!humanTurn()) return;
    var res = fireTurn(g, p, cells);
    if (!res) { sfx('bad'); return; }
    S.locked = true; S.marks = []; S.aim = -1; S.hover = -1;
    S.lastShot[1 - p] = {};
    S.waitLabel = 'Firing…'; setPad('wait');
    setMsg(esc(pname(p)) + (cells.length > 1 ? ' fire' + (vsCpu() ? '' : 's') + ' a salvo of <b>' + cells.length + '</b>…' : ' fire' + (vsCpu() ? '' : 's') + ' at <b>' + cellName(g.o.n, cells[0]) + '</b>…'), 'turn');
    persistGame();
    animate(res, function () {
      if (res.over) return finish();
      if (res.again) { S.locked = false; addLog('Hit — fire again!', 'hit'); beginTurn(); setMsg('Hit — <b>fire again!</b>', 'turn hit'); return; }
      if (vsCpu()) { after(250, beginTurn); return; }
      // pass-and-play: let the shooter see the result, then cover the boards
      after(S.rm ? 400 : 900, function () { passScreen(g.turn, false, lastSummary(res)); });
    });
  }
  function lastSummary(res) {
    var hits = res.results.filter(function (r) { return r.res !== 'miss'; }).length, sunk = res.results.filter(function (r) { return r.res === 'sunk'; });
    var who = pname(res.p);
    if (sunk.length) return who + ' sank ' + sunk.map(function (r) { return S.g.b[1 - res.p].ships[r.ship].name; }).join(' and ') + '.';
    return who + (res.results.length > 1 ? ' fired ' + res.results.length + ' shots: ' + hits + ' hit' + (hits === 1 ? '' : 's') + '.' : hits ? ' scored a hit.' : ' missed.');
  }
  function cpuFire() {
    var g = S.g;
    if (!g || g.phase !== 'play' || g.turn !== 1) return;
    var res = cpuTurn(g, S.rnd);
    if (!res) return;
    S.lastShot[0] = {};
    persistGame();
    animate(res, function () {
      if (res.over) return finish();
      if (res.again) { after(S.rm ? 200 : 450, cpuFire); return; }
      after(300, beginTurn);
    });
  }
  // shells fall one after another on the board being fired at, then the callback
  function animate(res, cb) {
    var g = S.g, tb = 1 - res.p, left = res.results.length, gap = S.rm ? 90 : 230;
    S.focus = slotOf(tb);
    layout();
    res.results.forEach(function (r, i) {
      launch(tb, r, i * gap, function () {
        var who = pname(res.p);
        addLog(resLine(who, g, r, tb), r.res === 'miss' ? 'dim' : r.res === 'sunk' ? 'sunk' : 'hit');
        if (r.res === 'sunk') {
          var nm = g.b[tb].ships[r.ship].name;
          setMsg(tb === S.view && g.o.vs === 'cpu' ? 'Your <b>' + esc(nm) + '</b> was sunk!' : esc(who) + ' sank ' + (tb === S.view ? 'your ' : 'the ') + '<b>' + esc(nm) + '</b>!', 'sunk');
          say(who + ' sank the ' + nm);
        } else {
          setMsg(esc(who) + ' · ' + cellName(g.o.n, r.idx) + ' — <b>' + (r.res === 'hit' ? 'HIT' : 'miss') + '</b>', r.res === 'hit' ? 'hit' : '');
          say(who + ' ' + cellName(g.o.n, r.idx) + ' ' + r.res);
        }
        syncHud();
        if (--left === 0) after(S.rm ? 150 : 420, cb);
      });
    });
  }
  function finish() {
    var g = S.g;
    S.phase = 'over'; S.locked = true;
    sdel(GAME_KEY); S.saved = null;
    S.newBest = recordGame(S.save, g).best;
    persist();
    S.focus = 'tgt';
    var win = vsCpu() ? g.winner === 0 : true;
    sfx(win ? 'win' : 'lose');
    setMsg(vsCpu() ? (win ? '<b>Victory!</b> The enemy fleet is sunk.' : '<b>Defeat.</b> Your fleet is lost.') : '<b>' + esc(pname(g.winner)) + ' wins!</b>', win ? 'turn' : 'sunk');
    say(vsCpu() ? (win ? 'Victory' : 'Defeat') : pname(g.winner) + ' wins');
    if (win && !S.rm) {   // fireworks over the beaten fleet
      var lb = 1 - g.winner;
      for (var q = 0; q < 6; q++) (function (q) {
        after(q * 160, function () { if (S && S.g === g) burst(lb, Math.floor(Math.random() * g.o.n * g.o.n), 'hit'); });
      })(q);
    }
    setPad('over'); syncHud(); layout();
    after(S.rm ? 300 : 1300, function () { if (S && S.g === g && S.phase === 'over') showCard('over'); });
  }
  function resume() {
    var g = loadGame();
    if (!g) { S.saved = null; showCard('home'); return; }
    S.snd.ensure();
    S.g = g; S.rnd = rng((g.seed ^ 0x5EA ^ g.hist.length * 7919) >>> 0);
    resetView();
    S.view = 0;
    addLog('Game resumed.', 'dim');
    if (g.o.vs === '2p') passScreen(g.turn, false, 'Game resumed.');
    else beginTurn();
  }
  function rematch() {
    S.cardKind = null;
    newGameFlow();
  }

  // ---- input: boards ----
  function cellFromEvent(slot, e) {
    var V = S.V[slot];
    if (!V || !V.W) return -1;
    var rc = V.cv.getBoundingClientRect(), k = V.W / (rc.width || 1);
    var x = (e.clientX - rc.left) * k, y = (e.clientY - rc.top) * k;
    var c = Math.floor((x - V.ox) / V.cs), r = Math.floor((y - V.oy) / V.cs);
    if (r < 0 || c < 0 || r >= V.n || c >= V.n) return -1;
    return r * V.n + c;
  }
  function boardDown(slot, e) {
    if (!S || !S.g || e.button > 0) return;
    e.preventDefault();
    S.snd.ensure(); S.blurred = false;
    S.kbOn = false;
    var cell = cellFromEvent(slot, e);
    if (S.phase === 'place' && slot === 'own') return placeDown(e, cell);
    if (S.phase === 'play' && slot === 'tgt') return aimAt(cell, e.pointerType === 'mouse');
  }
  function aimAt(cell, mouse) {
    var g = S.g;
    if (!humanTurn() || cell < 0) return;
    var tb = g.b[1 - g.turn];
    if (tb.shot[cell]) { sfx('bad'); return; }
    if (g.o.mode === 'salvo') {
      var at = S.marks.indexOf(cell), k = shotsAllowed(g, g.turn);
      if (at >= 0) S.marks.splice(at, 1);
      else if (S.marks.length < k) S.marks.push(cell);
      else { sfx('bad'); return; }
      sfx('tick');
      S.aim = -1;
      setPad('aim'); redraw();
      return;
    }
    if (mouse || S.aim === cell) { humanFire([cell]); return; }
    S.aim = cell; sfx('tick');
    setPad('aim'); redraw();
  }
  function fireNow() {
    var g = S.g;
    if (!humanTurn()) return;
    if (g.o.mode === 'salvo') { if (S.marks.length === shotsAllowed(g, g.turn)) humanFire(S.marks.slice()); else sfx('bad'); }
    else if (S.aim >= 0) humanFire([S.aim]);
  }
  function placeDown(e, cell) {
    if (cell < 0) return;
    var b = S.g.b[S.view], n = b.n, si = b.occ[cell];
    if (si >= 0) {
      var s = b.ships[si], off = s.v ? Math.floor(cell / n) - s.r : cell % n - s.c;
      S.sel = si;
      S.drag = { i: si, off: off, v: s.v, cell: cell, start: cell, moved: false, fresh: false, id: e.pointerId };
    } else if (S.sel >= 0 && b.ships[S.sel].r < 0) {
      S.drag = { i: S.sel, off: 0, v: S.vert, cell: cell, start: cell, moved: true, fresh: true, id: e.pointerId };
    } else {
      var nx = nextUnplaced(-1);
      if (nx < 0) { sfx('tick'); return; }
      S.sel = nx;
      S.drag = { i: nx, off: 0, v: S.vert, cell: cell, start: cell, moved: true, fresh: true, id: e.pointerId };
    }
    try { S.V.own.cv.setPointerCapture(e.pointerId); } catch (x) {}
    renderDock(); redraw();
  }
  function placeMove(e) {
    if (!S || S.phase !== 'place') return;
    var cell = cellFromEvent('own', e);
    if (S.drag && S.drag.id === e.pointerId) {
      if (cell >= 0 && cell !== S.drag.cell) { S.drag.cell = cell; S.drag.moved = true; redraw(); }
      return;
    }
    if (e.pointerType === 'mouse' && cell !== S.hover) { S.hover = cell; redraw(); }
  }
  function placeUp(e) {
    if (!S || !S.drag || S.drag.id !== e.pointerId) return;
    var d = S.drag, b = S.g.b[S.view];
    S.drag = null;
    if (e.type === 'pointercancel') { redraw(); return; }
    if (!d.moved) {
      if (rotate(b, d.i, S.g.o.apart)) sfx('place'); else { sfx('bad'); bump(); }
    } else {
      var gh = ghostFor(d);
      if (gh && place(b, d.i, gh.r, gh.c, gh.v, S.g.o.apart)) {
        sfx('place');
        if (d.fresh) { var nx = nextUnplaced(d.i); S.sel = nx; }
      } else { sfx('bad'); bump(); }
    }
    if (e.pointerType !== 'mouse') S.hover = -1;
    afterPlaceChange();
  }
  function ghostFor(d) {
    var n = S.g.o.n, len = S.g.b[S.view].ships[d.i].len, r = Math.floor(d.cell / n) - (d.v ? d.off : 0), c = d.cell % n - (d.v ? 0 : d.off);
    if (d.v) r = Math.min(r, n - len); else c = Math.min(c, n - len);
    return { r: Math.max(0, r), c: Math.max(0, c), v: d.v };
  }
  function bump() { S.shake.own = 0.12; kick(); }
  function rotateSel() {
    var b = S.g.b[S.view];
    if (S.sel < 0) return;
    if (b.ships[S.sel].r >= 0) { if (rotate(b, S.sel, S.g.o.apart)) sfx('place'); else { sfx('bad'); bump(); } }
    else { S.vert = !S.vert; sfx('tick'); }
    afterPlaceChange();
  }
  function randomPlace() {
    var g = S.g;
    randomFleet(g.b[S.view], S.rnd, g.o.apart);
    S.sel = -1;
    sfx('place');
    afterPlaceChange();
  }

  // ---- input: keyboard ----
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (t && t.isContentEditable && !S.panel.contains(t)) return;
    var k = e.key, inBtn = t && t.tagName === 'BUTTON' && S.panel.contains(t);
    if (k === 'Escape') {
      e.preventDefault();
      if (S.cardKind === 'help' || S.cardKind === 'stats') { closeHelp(); return; }
      if (S.phase === 'home') { closePanel(); return; }
      if (S.cardKind === 'over') { showCard(null); return; }
      if (S.phase === 'place' && S.drag) { S.drag = null; redraw(); return; }
      toHome();
      return;
    }
    if (S.cardKind) {
      if ((k === 'Enter' || k === ' ') && !inBtn) {
        var f = S.el.ovl.querySelector('[data-focus]');
        if (f) { e.preventDefault(); f.click(); }
      }
      return;
    }
    var g = S.g;
    if (!g) return;
    var slot = S.phase === 'place' ? 'own' : S.phase === 'play' && humanTurn() ? 'tgt' : null;
    if (!slot) return;
    var n = g.o.n, dir = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], w: [-1, 0], s: [1, 0], a: [0, -1], d: [0, 1] }[k];
    if (dir) {
      e.preventDefault();
      if (S.kb < 0 || !S.kbOn) S.kb = S.kb >= 0 ? S.kb : Math.floor(n / 2) * n + Math.floor(n / 2) - 1;
      else {
        var r = Math.floor(S.kb / n) + dir[0], c = S.kb % n + dir[1];
        S.kb = Math.max(0, Math.min(n - 1, r)) * n + Math.max(0, Math.min(n - 1, c));
      }
      S.kbOn = true; S.kbSlot = slot; S.hover = -1;
      if (S.phase === 'play' && g.o.mode !== 'salvo') { S.aim = -1; setPad('aim'); }
      redraw();
      return;
    }
    if (k === 'Enter' || k === ' ') {
      if (inBtn) return;
      e.preventDefault();
      if (e.repeat) return;
      if (S.phase === 'play') {
        if (S.kbOn && S.kb >= 0) {
          if (g.o.mode === 'salvo') { if (S.marks.indexOf(S.kb) >= 0 || S.marks.length < shotsAllowed(g, g.turn)) aimAt(S.kb, true); else fireNow(); }
          else aimAt(S.kb, true);
        } else fireNow();
      } else if (S.phase === 'place') {
        if (allPlaced(g.b[S.view]) && !(S.kbOn && S.kb >= 0 && S.sel >= 0)) { placeReady(); return; }
        if (S.kbOn && S.kb >= 0) {
          var b = g.b[S.view], i = S.sel >= 0 ? S.sel : nextUnplaced(-1);
          if (i < 0) return;
          var v = b.ships[i].r >= 0 ? b.ships[i].v : S.vert;
          if (placeNear(b, i, Math.floor(S.kb / n), S.kb % n, v, g.o.apart)) { sfx('place'); S.sel = nextUnplaced(i); }
          else { sfx('bad'); bump(); }
          afterPlaceChange();
        }
      }
      return;
    }
    if (S.phase === 'play' && g.o.mode === 'salvo' && (k === 'f' || k === 'F')) { e.preventDefault(); fireNow(); return; }
    if (S.phase === 'place') {
      if (k === 'r' || k === 'R') { e.preventDefault(); rotateSel(); return; }
      if (k === 'x' || k === 'X') { e.preventDefault(); randomPlace(); return; }
      var num = parseInt(k, 10);
      if (num >= 1 && num <= g.b[S.view].ships.length) { e.preventDefault(); S.sel = num - 1; sfx('tick'); afterPlaceChange(); }
    }
  }
  function closeHelp() {
    S.resetArm = false;
    if (S.phase === 'home') showCard('home');
    else if (S.phase === 'over') showCard('over');
    else showCard(null);
  }

  // ---- layout ----
  function layout() {
    if (!S) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 640, solo = S.panel.classList.contains('cade-solo-panel');
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    var R = S.root;
    R.classList.toggle('phone', phone);
    var place = S.phase === 'place';
    var r = S.panel.getBoundingClientRect(), top = solo ? 50 : Math.min(Math.max(0, r.top || 50), 120);
    var padH = S.coarse ? 62 : 50, big, cap, k = phone && !place ? 1.46 : 1;
    if (phone) {
      cap = vw - 34;
      big = Math.min(cap, (vh - top - 44 - 18 - 30 - padH - 30 - (place ? 170 : 60)) / k);
    } else {
      cap = Math.min(solo ? 500 : 340, (vw - 100) / 2);
      big = Math.min(cap, vh - top - 250);
    }
    var bigSlot = place ? 'own' : S.focus || 'tgt';
    R.classList.toggle('f-own', phone && bigSlot === 'own');
    R.classList.toggle('f-tgt', phone && bigSlot !== 'own');
    function apply(b) {
      b = Math.max(200, Math.floor(Math.min(cap, b)));
      var small = Math.max(110, Math.floor(b * 0.46));
      R.style.setProperty('--sb-big', b + 'px');
      R.style.setProperty('--sb-small', small + 'px');
      sizeBoard('tgt', phone && bigSlot !== 'tgt' ? small : b);
      sizeBoard('own', phone && bigSlot !== 'own' ? small : b);
      return b;
    }
    var mh = R.style.minHeight;
    R.style.minHeight = '';
    big = apply(big);
    // measure: fit the real chrome (status, headers, dock, pad) into the visible height
    for (var pass = 0; pass < 2; pass++) {
      var rb = R.getBoundingClientRect();
      if (!rb.height) break;
      var over = rb.bottom + 12 - vh;
      if (Math.abs(over) < 4 || (over < 0 && big >= Math.floor(cap))) break;
      big = apply(big - over / k);
    }
    R.style.minHeight = mh;
    if (S.cardKind) fitCard();
    drawAll();
  }
  function sizeBoard(slot, sz) {
    var V = S.V[slot], n = S.g ? S.g.o.n : S.save.opts.n, dpr = Math.min(2.5, window.devicePixelRatio || 1);
    var W = Math.round(sz * dpr);
    if (V.cv.width !== W || V.cv.height !== W) { V.cv.width = W; V.cv.height = W; }
    V.cv.style.width = sz + 'px'; V.cv.style.height = sz + 'px';
    V.wrap.style.width = sz + 'px';
    V.W = W; V.n = n; V.dpr = dpr;
    V.lab = sz >= 170;
    var pad = 2 * dpr, lab = V.lab ? 0.72 : 0;
    V.cs = (W - pad * 2) / (n + lab);
    V.ox = pad + lab * V.cs; V.oy = pad + lab * V.cs;
    V.ctx = V.ctx || V.cv.getContext('2d');
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('focus', s.onFocus);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    for (var k in s.gc) freeCanvas(s.gc[k].cv);
    s.gc = {};
    freeCanvas(s.V.tgt.cv); freeCanvas(s.V.own.cv);
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }

  function open() {
    if (Cade.closeAllMenus) Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var bd = function (slot, title) {
      return '<div class="sb-bd sb-' + slot + '"><div class="sb-bh"><span class="sb-bt">' + title + '</span><span class="sb-tks"></span></div>' +
        '<canvas class="sb-cv" data-slot="' + slot + '"></canvas></div>';
    };
    var body = '<div class="sb"><div class="sb-msg" aria-hidden="true"></div>' +
      '<div class="sb-boards">' + bd('tgt', 'ENEMY WATERS') + bd('own', 'YOUR FLEET') + '<div class="sb-dock"></div><div class="sb-side"></div></div>' +
      '<div class="sb-pad"></div><div class="sb-ovl" style="display:none"></div><div class="sb-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🚢 Sea Battle', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'sb-hb';
    hb.innerHTML = '<button type="button" data-h="menu" title="Menu (Esc)" aria-label="Menu">' + IC_MENU + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia, q = function (s) { return p.querySelector(s); };
    S = {
      panel: p, head: hb, root: q('.sb'),
      el: {
        msg: q('.sb-msg'), pad: q('.sb-pad'), ovl: q('.sb-ovl'), live: q('.sb-live'), dock: q('.sb-dock'), side: q('.sb-side'),
        tgtT: q('.sb-tgt .sb-bt'), ownT: q('.sb-own .sb-bt'), tgtK: q('.sb-tgt .sb-tks'), ownK: q('.sb-own .sb-tks')
      },
      V: { tgt: { cv: q('.sb-tgt canvas'), wrap: q('.sb-tgt') }, own: { cv: q('.sb-own canvas'), wrap: q('.sb-own') } },
      save: loadSave(), snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'home', g: null, view: 0, focus: 'tgt', cover: false, raf: 0, last: 0, clock: 0, wt: 0, dirty: false,
      timers: [], shells: [], fx: [], shake: { own: 0, tgt: 0 }, hidden: [{}, {}], lastShot: [{}, {}], log: [],
      marks: [], aim: -1, hover: -1, kb: -1, kbOn: false, kbSlot: 'tgt', sel: 0, vert: false, drag: null, locked: false,
      gc: {}, gcN: 0, pal: null, cardKind: null, padMode: '', blurred: false, rnd: rng((Math.random() * 4294967295) >>> 0)
    };
    p._onClose = teardown;
    readTheme();
    syncHead();

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (!S) return; if (document.hidden) stopLoop(); else kick(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { S.blurred = true; stopLoop(); if (S.drag) { S.drag = null; redraw(); } } };
    S.onFocus = function () { if (S) { S.blurred = false; kick(); } };
    window.addEventListener('blur', S.onBlur);
    window.addEventListener('focus', S.onFocus);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) { S.drag = null; stopLoop(); } });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        layout(); kick();
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) layout(); }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); redraw();
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    // header buttons (the header drags the panel — these are controls)
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
      } else if (h === 'help') {
        if (S.cardKind === 'help') closeHelp();
        else if (S.cardKind !== 'pass') showCard('help');
      } else if (h === 'menu') {
        if (S.phase === 'home') { if (S.cardKind !== 'home') showCard('home'); }
        else toHome();
      }
      try { b.blur(); } catch (er) {}
    });

    // Fast taps must never zoom, select, magnify or open a callout: CSS handles most of
    // it; the boards and the pad also cancel their touches, and the panel swallows
    // gesture / dblclick events.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    [S.V.tgt.cv, S.V.own.cv].forEach(function (cv) {
      cv.addEventListener('touchstart', noTouch, { passive: false });
      cv.addEventListener('touchmove', noTouch, { passive: false });
      cv.addEventListener('touchend', noTouch, { passive: false });
      cv.addEventListener('contextmenu', noTouch);
    });
    S.el.pad.addEventListener('touchend', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (b && !b.disabled && e.cancelable) { e.preventDefault(); b.click(); }
    }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    S.V.tgt.cv.addEventListener('pointerdown', function (e) { boardDown('tgt', e); });
    S.V.own.cv.addEventListener('pointerdown', function (e) { boardDown('own', e); });
    S.V.own.cv.addEventListener('pointermove', placeMove);
    ['pointerup', 'pointercancel'].forEach(function (t) { S.V.own.cv.addEventListener(t, placeUp); });
    S.V.own.cv.addEventListener('pointerleave', function () { if (S && S.hover >= 0 && !S.drag) { S.hover = -1; redraw(); } });
    S.V.tgt.cv.addEventListener('pointermove', function (e) {
      if (!S || e.pointerType !== 'mouse' || S.phase !== 'play') return;
      var c = cellFromEvent('tgt', e);
      if (c !== S.hover) { S.hover = c; S.kbOn = false; redraw(); }
    });
    S.V.tgt.cv.addEventListener('pointerleave', function () { if (S && S.hover >= 0) { S.hover = -1; redraw(); } });

    S.el.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b || !S || b.disabled) return;
      S.snd.ensure();
      act(b.getAttribute('data-act'));
      try { if (S && S.coarse) b.blur(); } catch (er) {}
    });
    S.el.dock.addEventListener('click', function (e) {
      if (!S || S.phase !== 'place') return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      var si = b.getAttribute('data-ship');
      if (si != null) { S.sel = +si; sfx('tick'); afterPlaceChange(); return; }
      act(b.getAttribute('data-act'));
    });
    S.el.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var opt = b.getAttribute('data-opt');
      if (opt) {
        var o = S.save.opts, v = b.getAttribute('data-val');
        if (opt === 'n') o.n = +v; else if (opt === 'apart') o.apart = v === '1'; else o[opt] = v;
        S.save.opts = normOpts(o);
        persist(); sfx('tick');
        showCard('home');
        if (opt === 'n') layout();
        var nb = e.detail === 0 && S.el.ovl.querySelector('[data-opt="' + opt + '"][data-val="' + v + '"]');
        if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
        return;
      }
      act(b.getAttribute('data-act'));
    });

    toHome();
    requestAnimationFrame(function () { if (S && S.panel === p) layout(); });
    try {
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (S && S.panel === p) { S.gc = {}; redraw(); } }, function () {});
    } catch (e) {}
  }
  function act(a) {
    if (!S || !a) return;
    switch (a) {
      case 'new': newGameFlow(); break;
      case 'resume': resume(); break;
      case 'stats': S.resetArm = false; showCard('stats'); break;
      case 'help': showCard('help'); break;
      case 'close-help': closeHelp(); break;
      case 'reset': S.resetArm = true; showCard('stats'); break;
      case 'reset-no': S.resetArm = false; showCard('stats'); break;
      case 'reset-yes': {
        var o = S.save.opts; S.save = newSave(); S.save.opts = o; S.save.seen = true; persist();
        S.resetArm = false; showCard('stats');
        if (Cade.showToast) Cade.showToast('Records reset', 'info', 1600);
        break;
      }
      case 'ready-pass': passReady(); break;
      case 'rotate': if (S.phase === 'place') rotateSel(); break;
      case 'random': if (S.phase === 'place') randomPlace(); break;
      case 'clearfleet': if (S.phase === 'place') { clearFleet(S.g.b[S.view]); S.sel = 0; sfx('tick'); afterPlaceChange(); } break;
      case 'ready': if (S.phase === 'place') placeReady(); break;
      case 'fire': fireNow(); break;
      case 'clear': S.marks = []; setPad('aim'); redraw(); break;
      case 'rematch': rematch(); break;
      case 'menu': toHome(); break;
      case 'look': showCard(null); break;
    }
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Hide your fleet, hunt theirs — vs CPU (easy, hunt/target, probability heatmap) or pass-and-play; Classic, Salvo and Hit-again rules',
    icon: '🚢',
    tags: 'game,board,battleship,sea battle,ships,2 player,cpu,salvo,ascii',
    open: open,
    _engine: ENGINE
  });
})();
