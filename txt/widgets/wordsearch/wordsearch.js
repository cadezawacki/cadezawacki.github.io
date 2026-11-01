/* Word Search — find the hidden words, for Cade.txt.
 * Generated letter grids (8×8 to 15×15) with words hidden in up to eight
 * directions. Difficulty sets the grid size, the directions (backwards,
 * diagonals), how often words overlap and how sneaky the filler letters are.
 * Words come from 32 bundled theme packs (wordsearch-data.js, loaded on
 * demand), from the note that is open ("From my note": its distinct, longer
 * words), or from a custom list. Drag or swipe across a word (the line snaps
 * to the eight directions), or tap its first and last letters, or use the
 * arrow keys + Enter. Found words are boxed and struck in colour.
 * Modes: Solo (timer, hints, best times), the Daily puzzle (one per day, a
 * streak), vs CPU (a real-time race on one shared grid — the CPU finds words
 * over time at three skill levels) and 2 players on one device: alternate
 * finds on a shared grid with a turn clock, or take turns solving the same
 * grid (a hand-off screen hides it in between) — fastest time wins.
 * Pure engine on top (unit-checked in node), DOM UI below. Progress persists
 * in Cade.store (cade-wordsearch-*). Offline module. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // Directions as [dRow, dCol]; the first four read forwards, the rest backwards.
  var DIRS = [[0, 1], [1, 0], [1, 1], [-1, 1], [0, -1], [-1, 0], [-1, -1], [1, -1]];
  var DIR_NAMES = ['E', 'S', 'SE', 'NE', 'W', 'N', 'NW', 'SW'];
  var LEVELS = {
    easy: { id: 'easy', name: 'Easy', size: 8, words: 6, dirs: [0, 1], w: [1, 1], overlap: 0, bias: 0, info: 'across and down' },
    medium: { id: 'medium', name: 'Medium', size: 10, words: 9, dirs: [0, 1, 2, 3], w: [3, 3, 2, 2], overlap: 0.25, bias: 0.1, info: 'plus diagonals' },
    hard: { id: 'hard', name: 'Hard', size: 12, words: 12, dirs: [0, 1, 2, 3, 4, 5, 6, 7], w: [2, 2, 2, 2, 1, 1, 1, 1], overlap: 0.45, bias: 0.25, info: 'all 8 ways, backwards too' },
    expert: { id: 'expert', name: 'Expert', size: 15, words: 16, dirs: [0, 1, 2, 3, 4, 5, 6, 7], w: [1, 1, 1, 1, 1.4, 1.4, 1.4, 1.4], overlap: 0.75, bias: 0.5, info: 'all 8 ways, crossing, decoy letters' }
  };
  var LEVEL_IDS = ['easy', 'medium', 'hard', 'expert'];
  var CPU_LEVELS = {
    easy: { id: 'easy', name: 'Easy', base: 17 },
    medium: { id: 'medium', name: 'Medium', base: 11 },
    hard: { id: 'hard', name: 'Hard', base: 6.5 }
  };
  var CPU_IDS = ['easy', 'medium', 'hard'];
  var HINT_SEC = 15, HINT_PTS = 2, TURN_SEC = 40, CPU_GRACE = 4;
  var MIN_LEN = 3, MAX_LIST = 40;
  // English-ish letter frequencies for the filler.
  var FILL = 'EEEEEEEEEEEETTTTTTTTTAAAAAAAAOOOOOOOIIIIIIINNNNNNNSSSSSSRRRRRRHHHHHDDDDLLLLUUUCCCMMMFFYYWWGGPPBBVKXQJZ';
  var STOP = ('about above after again against all also although always among another anyone anything around because been before being below between both but cannot could does doing done down during each either else enough even ever every from further have having here hers herself himself however into itself just like made make many maybe might more most much must myself near need neither never next none nothing often once only other others ought ours ourselves over own perhaps please quite rather really same several shall should since some something soon still such than that their theirs them themselves then there these they thing things this those though through thus till together too toward towards under until upon used very want was were what whatever when where whether which while whom whose will with within without would yeah year years your yours yourself yourselves also http https www com org net html todo done note notes just okay '
    + 'the and for are not you can its our out her his him she has had how why who use way get got let put see say said new one two three four five six seven eight nine ten first last per via etc any few lot lots tbd yes').split(' ');
  var STOPSET = {};
  for (var si = 0; si < STOP.length; si++) STOPSET[STOP[si]] = 1;

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
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function shuffle(a, r) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // ---- words ----
  function norm(w) {
    var s = String(w == null ? '' : w);
    if (s.normalize) { try { s = s.normalize('NFD'); } catch (e) {} }
    return s.replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
  }
  function disp(w) {
    var s = String(w == null ? '' : w).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s === s.toUpperCase() || s === s.toLowerCase()) s = s.toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function rev(s) { return s.split('').reverse().join(''); }
  // Choose up to `count` words from a pool: cleaned, deduped, fitting the grid,
  // and never one inside another (or inside its reverse) — so every selection is unambiguous.
  function pickWords(pool, count, maxLen, r) {
    var seen = {}, cand = [], i;
    for (i = 0; i < pool.length; i++) {
      var w = norm(pool[i]);
      if (w.length < MIN_LEN || w.length > maxLen || seen[w]) continue;
      seen[w] = 1;
      cand.push({ w: w, disp: disp(pool[i]) });
    }
    shuffle(cand, r);
    var out = [];
    for (i = 0; i < cand.length && out.length < count; i++) {
      var c = cand[i], ok = true, rv = rev(c.w);
      for (var k = 0; k < out.length && ok; k++) {
        var o = out[k].w;
        if (o.indexOf(c.w) >= 0 || c.w.indexOf(o) >= 0 || o.indexOf(rv) >= 0 || rv.indexOf(o) >= 0) ok = false;
      }
      if (ok) out.push(c);
    }
    return out;
  }
  // Distinct words from a note, the most used (then longest) first.
  function noteWords(text, max) {
    var t = String(text || '').replace(/https?:\/\/\S+/g, ' ').replace(/[`*_#>~[\]()]/g, ' ');
    var toks = t.split(/[^A-Za-zÀ-ɏ'’-]+/), freq = {}, first = {}, order = 0, i;
    for (i = 0; i < toks.length; i++) {
      var raw = toks[i].replace(/^['’-]+|['’-]+$/g, '');
      if (!raw || /['’]/.test(raw) || raw.indexOf('-') >= 0) continue;
      var low = raw.toLowerCase(), key = norm(low);
      if (key.length < 4 || key.length > 12 || STOPSET[low] || /^(.)\1+$/.test(key)) continue;
      if (!freq[key]) { freq[key] = 0; first[key] = { w: low, o: order++ }; }
      freq[key]++;
    }
    var keys = Object.keys(freq);
    keys.sort(function (a, b) { return (freq[b] - freq[a]) || (b.length - a.length) || (first[a].o - first[b].o); });
    var out = [];
    for (i = 0; i < keys.length && out.length < (max || MAX_LIST); i++) out.push(first[keys[i]].w);
    return out;
  }
  // A custom list: words separated by commas, semicolons or new lines.
  function parseList(text) {
    var parts = String(text || '').split(/[\n,;]+/), words = [], bad = [], seen = {};
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      var k = norm(p);
      if (k.length < MIN_LEN || k.length > 15) { bad.push(p); continue; }
      if (seen[k]) continue;
      seen[k] = 1;
      words.push(p);
    }
    return { words: words, bad: bad };
  }

  // ---- the grid ----
  function placeCells(size, r, c, d, len) {
    var out = [], dr = DIRS[d][0], dc = DIRS[d][1];
    for (var k = 0; k < len; k++) out.push((r + dr * k) * size + (c + dc * k));
    return out;
  }
  function wordCells(pz, i) { var p = pz.words[i]; return placeCells(pz.size, p.r, p.c, p.d, p.w.length); }
  function tryPlace(g, size, word, lv, r) {
    var L = word.length, cands = [], wsum = 0, best = 0, k, d, rr, cc;
    for (var di = 0; di < lv.dirs.length; di++) {
      d = lv.dirs[di];
      var dr = DIRS[d][0], dc = DIRS[d][1], wt = lv.w[di];
      for (rr = 0; rr < size; rr++) {
        var er = rr + dr * (L - 1);
        if (er < 0 || er >= size) continue;
        for (cc = 0; cc < size; cc++) {
          var ec = cc + dc * (L - 1);
          if (ec < 0 || ec >= size) continue;
          var ov = 0, ok = true;
          for (k = 0; k < L; k++) {
            var ch = g[(rr + dr * k) * size + cc + dc * k];
            if (!ch) continue;
            if (!lv.overlap || ch !== word.charAt(k)) { ok = false; break; }
            ov++;
          }
          if (!ok || ov >= L - 1) continue;
          cands.push({ r: rr, c: cc, d: d, ov: ov, wt: wt });
          if (ov > best) best = ov;
        }
      }
    }
    if (!cands.length) return null;
    var pool = cands, want = best > 0 && r() < lv.overlap ? best : 0, sub = [];
    for (k = 0; k < cands.length; k++) if (cands[k].ov === want) sub.push(cands[k]);
    if (sub.length) pool = sub;
    for (k = 0; k < pool.length; k++) wsum += pool[k].wt;
    var pick = r() * wsum;
    for (k = 0; k < pool.length - 1 && pick >= pool[k].wt; k++) pick -= pool[k].wt;
    return pool[k];
  }
  // Every straight run (any of the 8 directions) spelling `w`, as distinct cell sets.
  function occurrences(grid, size, w) {
    var out = [], seen = {}, L = w.length, f = w.charAt(0);
    for (var i = 0; i < size * size; i++) {
      if (grid.charAt(i) !== f) continue;
      var r0 = Math.floor(i / size), c0 = i % size;
      for (var d = 0; d < 8; d++) {
        var er = r0 + DIRS[d][0] * (L - 1), ec = c0 + DIRS[d][1] * (L - 1);
        if (er < 0 || er >= size || ec < 0 || ec >= size) continue;
        var ok = true, cells = [];
        for (var k = 0; k < L && ok; k++) {
          var j = (r0 + DIRS[d][0] * k) * size + c0 + DIRS[d][1] * k;
          if (grid.charAt(j) !== w.charAt(k)) ok = false; else cells.push(j);
        }
        if (!ok) continue;
        var key = cells.slice().sort(function (a, b) { return a - b; }).join(',');
        if (!seen[key]) { seen[key] = 1; out.push(cells); }
      }
    }
    return out;
  }
  // Build a puzzle from a word pool. opts: { size, count, theme, title }.
  function generate(pool, levelId, seed, opts) {
    opts = opts || {};
    var lv = LEVELS[levelId] || LEVELS.medium, size = clamp(opts.size | 0 || lv.size, 8, 15);
    var count = clamp(opts.count | 0 || lv.words, 1, 30), r = rng(hash2(seed, 0x5EA4C4));
    var cand = pickWords(pool, count + 8, size, r);
    cand.sort(function (a, b) { return b.w.length - a.w.length; });
    var g = new Array(size * size), placed = [], i;
    for (i = 0; i < g.length; i++) g[i] = '';
    for (i = 0; i < cand.length && placed.length < count; i++) {
      var p = tryPlace(g, size, cand[i].w, lv, r);
      if (!p) continue;
      var cells = placeCells(size, p.r, p.c, p.d, cand[i].w.length);
      for (var k = 0; k < cells.length; k++) g[cells[k]] = cand[i].w.charAt(k);
      placed.push({ w: cand[i].w, disp: cand[i].disp, r: p.r, c: p.c, d: p.d });
    }
    var used = {}, letters = '';
    for (i = 0; i < g.length; i++) if (g[i]) { used[i] = 1; letters += g[i]; }
    function fillCh() { return (letters && r() < lv.bias) ? letters.charAt(Math.floor(r() * letters.length)) : FILL.charAt(Math.floor(r() * FILL.length)); }
    for (i = 0; i < g.length; i++) if (!used[i]) g[i] = fillCh();
    // The filler must not spell a hidden word a second time: re-roll a filler letter of any extra copy.
    for (var guard = 0; guard < 400; guard++) {
      var fixed = false, grid = g.join('');
      for (i = 0; i < placed.length && !fixed; i++) {
        var occ = occurrences(grid, size, placed[i].w);
        if (occ.length < 2) continue;
        var mine = placeCells(size, placed[i].r, placed[i].c, placed[i].d, placed[i].w.length).slice().sort(function (a, b) { return a - b; }).join(',');
        for (var o = 0; o < occ.length && !fixed; o++) {
          if (occ[o].slice().sort(function (a, b) { return a - b; }).join(',') === mine) continue;
          for (var q = 0; q < occ[o].length; q++) {
            var cell = occ[o][q];
            if (used[cell]) continue;
            var was = g[cell];
            do { g[cell] = FILL.charAt(Math.floor(r() * FILL.length)); } while (g[cell] === was);
            fixed = true;
            break;
          }
        }
      }
      if (!fixed) break;
    }
    // Reading order for the word list: alphabetical.
    placed.sort(function (a, b) { return a.w < b.w ? -1 : a.w > b.w ? 1 : 0; });
    return { v: 1, size: size, level: lv.id, seed: seed >>> 0, grid: g.join(''), words: placed, theme: opts.theme || '', title: opts.title || '' };
  }

  // ---- selecting: a line from a start cell towards a pointer, snapped to 8 directions ----
  // (fy, fx) is the pointer position in cell units (fractional).
  function snap(size, r0, c0, fy, fx) {
    var dy = fy - (r0 + 0.5), dx = fx - (c0 + 0.5);
    if (dy * dy + dx * dx < 0.36) return { r0: r0, c0: c0, r1: r0, c1: c0, d: -1, n: 1 };
    var oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
    var sr = [0, 1, 1, 1, 0, -1, -1, -1][(oct + 8) % 8], sc = [1, 1, 0, -1, -1, -1, 0, 1][(oct + 8) % 8];
    var n = Math.round((dy * sr + dx * sc) / (sr * sr + sc * sc));
    n = Math.max(0, n);
    while (n > 0 && (r0 + sr * n < 0 || r0 + sr * n >= size || c0 + sc * n < 0 || c0 + sc * n >= size)) n--;
    return { r0: r0, c0: c0, r1: r0 + sr * n, c1: c0 + sc * n, d: dirOf(sr, sc), n: n + 1 };
  }
  function dirOf(dr, dc) {
    for (var d = 0; d < 8; d++) if (DIRS[d][0] === dr && DIRS[d][1] === dc) return d;
    return -1;
  }
  // Cells of a straight line between two cells (or null if not one of the 8 directions).
  function lineCells(size, r0, c0, r1, c1) {
    var dr = r1 - r0, dc = c1 - c0, n = Math.max(Math.abs(dr), Math.abs(dc));
    if (n === 0) return [r0 * size + c0];
    if (dr !== 0 && dc !== 0 && Math.abs(dr) !== Math.abs(dc)) return null;
    var sr = dr / n, sc = dc / n, out = [];
    for (var k = 0; k <= n; k++) {
      var rr = r0 + sr * k, cc = c0 + sc * k;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) return null;
      out.push(rr * size + cc);
    }
    return out;
  }
  // Which unfound word a line of cells spells (either way round), or -1.
  function matchCells(pz, cells, found) {
    if (!cells || cells.length < 2) return -1;
    var s = '';
    for (var i = 0; i < cells.length; i++) s += pz.grid.charAt(cells[i]);
    var rs = rev(s);
    for (i = 0; i < pz.words.length; i++) {
      if (found && found[i]) continue;
      if (pz.words[i].w === s || pz.words[i].w === rs) return i;
    }
    return -1;
  }
  function isBack(p) { return p.d >= 4; }
  function isDiag(p) { var d = DIRS[p.d]; return d[0] !== 0 && d[1] !== 0; }
  function wordPoints(p) { return p.w.length + (isDiag(p) ? 1 : 0) + (isBack(p) ? 2 : 0); }

  // ---- a game ----
  // mode: solo | daily | cpu | alt (2P, alternate finds) | relay (2P, take turns on the same grid)
  function newGame(pz, cfg) {
    cfg = cfg || {};
    var n = pz.words.length, g = {
      pz: pz, mode: cfg.mode || 'solo', cpu: CPU_LEVELS[cfg.cpu] ? cfg.cpu : 'medium',
      found: [], hints: [], t: 0, penalty: 0, nHints: 0, misses: 0, score: [0, 0, 0], turn: 0, turnT: TURN_SEC,
      rs: hash2(pz.seed, 0xC9) >>> 0, cpuT: 0, done: false, nFound: 0, order: []
    };
    for (var i = 0; i < n; i++) { g.found.push(null); g.hints.push(0); }
    if (g.mode === 'cpu') g.cpuT = CPU_GRACE + cpuDelay(g, -1);
    return g;
  }
  function grnd(g) {   // serializable RNG step
    var f = rng(g.rs), v = f();
    g.rs = hash2(g.rs, 0x2545F491);
    return v;
  }
  function wordDifficulty(p) {
    return 1 + (isBack(p) ? 0.45 : 0) + (isDiag(p) ? 0.25 : 0) + Math.max(0, 6 - p.w.length) * 0.07;
  }
  function cpuDelay(g, i) {
    var lv = CPU_LEVELS[g.cpu], df = i >= 0 ? wordDifficulty(g.pz.words[i]) : 1;
    return lv.base * (g.pz.size / 10) * df * (0.6 + 0.8 * grnd(g));
  }
  function cpuPick(g) {
    var tot = 0, i, ws = [];
    for (i = 0; i < g.pz.words.length; i++) {
      var w = g.found[i] ? 0 : 1 / wordDifficulty(g.pz.words[i]);
      ws.push(w); tot += w;
    }
    if (tot <= 0) return -1;
    var x = grnd(g) * tot;
    for (i = 0; i < ws.length; i++) { if (ws[i] <= 0) continue; if (x < ws[i]) return i; x -= ws[i]; }
    for (i = ws.length - 1; i >= 0; i--) if (ws[i] > 0) return i;
    return -1;
  }
  function markFound(g, i, who, cells) {
    var p = g.pz.words[i], pts = wordPoints(p);
    g.found[i] = { by: who, cells: cells || wordCells(g.pz, i), t: g.t };
    g.order.push(i);
    g.nFound++;
    g.score[who] += pts;
    if (g.nFound >= g.pz.words.length) g.done = true;
    return pts;
  }
  // A player selects a line (cells). → { i, pts } or null (a miss).
  function submit(g, cells, who) {
    if (g.done) return null;
    who = who == null ? (g.mode === 'alt' ? g.turn : 0) : who;
    var i = matchCells(g.pz, cells, g.found);
    if (i < 0) { if (cells && cells.length > 1) g.misses++; return null; }
    var pts = markFound(g, i, who, cells);
    if (g.mode === 'alt' && !g.done) { g.turn = 1 - g.turn; g.turnT = TURN_SEC; }
    return { i: i, pts: pts };
  }
  // A hint: the first letter of an unfound word, then (again) its last letter. → { i, level } or null.
  function hint(g, who) {
    if (g.done) return null;
    var lo = 3, cands = [], i;
    for (i = 0; i < g.found.length; i++) if (!g.found[i] && g.hints[i] < lo) lo = g.hints[i];
    if (lo >= 2) return null;
    for (i = 0; i < g.found.length; i++) if (!g.found[i] && g.hints[i] === lo) cands.push(i);
    i = cands[Math.floor(grnd(g) * cands.length)];
    g.hints[i]++;
    g.nHints++;
    if (g.mode === 'cpu' || g.mode === 'alt') {
      who = who == null ? (g.mode === 'alt' ? g.turn : 0) : who;
      g.score[who] -= HINT_PTS;
    } else g.penalty += HINT_SEC;
    return { i: i, level: g.hints[i] };
  }
  function hintCells(g) {
    var out = [];
    for (var i = 0; i < g.found.length; i++) {
      if (g.found[i] || !g.hints[i]) continue;
      var c = wordCells(g.pz, i);
      out.push(c[0]);
      if (g.hints[i] > 1) out.push(c[c.length - 1]);
    }
    return out;
  }
  // Advance the clock (seconds). Returns events: { cpu: i, pts } / { timeout: playerWhoseTurnEnded }.
  function tick(g, dt) {
    var ev = [];
    if (g.done || !(dt > 0)) return ev;
    dt = Math.min(dt, 1);
    g.t += dt;
    if (g.mode === 'alt') {
      g.turnT -= dt;
      if (g.turnT <= 0) { ev.push({ timeout: g.turn }); g.turn = 1 - g.turn; g.turnT = TURN_SEC; }
    } else if (g.mode === 'cpu') {
      g.cpuT -= dt;
      if (g.cpuT <= 0) {
        var i = cpuPick(g);
        if (i >= 0) {
          var pts = markFound(g, i, 2);
          ev.push({ cpu: i, pts: pts });
          g.cpuT = cpuDelay(g, i);
        }
      }
    }
    return ev;
  }
  function finalTime(g) { return g.t + g.penalty; }
  // Take-turns (relay) result from the two times (with penalties) and whether each finished.
  // → 0 / 1 = that player wins, -1 = dead heat, -2 = nobody finished. Compared to the tenth, as shown.
  function relayResult(t0, t1, done0, done1) {
    if (!done0 && !done1) return -2;
    if (!done0) return 1;
    if (!done1) return 0;
    var q0 = Math.floor(t0 * 10), q1 = Math.floor(t1 * 10);
    return q0 < q1 ? 0 : q1 < q0 ? 1 : -1;
  }
  function outcome(g) {   // 1 = player 1 / you won, -1 = lost (CPU or player 2), 0 = draw
    if (g.forfeit) return -1;
    var other = g.mode === 'cpu' ? 2 : 1;
    return g.score[0] > g.score[other] ? 1 : g.score[0] < g.score[other] ? -1 : 0;
  }

  // ---- days ----
  function dayNum(date) { return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 864e5); }
  function dayKey(n) { var d = new Date(n * 864e5); return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
  function dailySpec(n, nThemes) {
    return { seed: hash2(n, 0xDA11), theme: ((n * 7) % nThemes + nThemes) % nThemes, level: 'medium', key: dayKey(n) };
  }
  function streak(daily, today) {
    var n = daily[dayKey(today)] ? today : today - 1, s = 0;
    while (daily[dayKey(n)]) { s++; n--; }
    return s;
  }

  // ---- saves ----
  function newSave() {
    var s = {
      v: 1, best: {}, bestClean: {}, daily: {}, cpu: {},
      stats: { played: 0, solved: 0, words: 0, hints: 0 },
      prefs: { mode: 'solo', src: 'theme', theme: 'random', level: 'medium', cpu: 'medium', p2: 'alt' }
    };
    for (var i = 0; i < LEVEL_IDS.length; i++) { s.best[LEVEL_IDS[i]] = 0; s.bestClean[LEVEL_IDS[i]] = 0; }
    for (i = 0; i < CPU_IDS.length; i++) s.cpu[CPU_IDS[i]] = { w: 0, l: 0, d: 0 };
    return s;
  }
  function num(v, max) { v = +v; return isFinite(v) && v > 0 ? Math.min(v, max || 1e9) : 0; }
  function normSave(o) {
    var s = newSave(), i, k;
    if (!o || typeof o !== 'object') return s;
    for (i = 0; i < LEVEL_IDS.length; i++) {
      k = LEVEL_IDS[i];
      if (o.best) s.best[k] = num(o.best[k], 359999);
      if (o.bestClean) s.bestClean[k] = num(o.bestClean[k], 359999);
    }
    if (o.daily && typeof o.daily === 'object') {
      var keys = Object.keys(o.daily).filter(function (x) { return /^\d{4}-\d\d-\d\d$/.test(x) && num(o.daily[x]); }).sort().slice(-120);
      for (i = 0; i < keys.length; i++) s.daily[keys[i]] = num(o.daily[keys[i]], 359999);
    }
    for (i = 0; i < CPU_IDS.length; i++) {
      var c = o.cpu && o.cpu[CPU_IDS[i]];
      if (c) s.cpu[CPU_IDS[i]] = { w: Math.floor(num(c.w)), l: Math.floor(num(c.l)), d: Math.floor(num(c.d)) };
    }
    if (o.stats) for (k in s.stats) s.stats[k] = Math.floor(num(o.stats[k]));
    var p = o.prefs || {};
    if (/^(solo|cpu|p2)$/.test(p.mode)) s.prefs.mode = p.mode;
    if (/^(theme|note|custom)$/.test(p.src)) s.prefs.src = p.src;
    if (typeof p.theme === 'string' && /^[a-z0-9]{1,20}$/.test(p.theme)) s.prefs.theme = p.theme;
    if (LEVELS[p.level]) s.prefs.level = p.level;
    if (CPU_LEVELS[p.cpu]) s.prefs.cpu = p.cpu;
    if (/^(alt|relay)$/.test(p.p2)) s.prefs.p2 = p.p2;
    return s;
  }
  // A puzzle loaded from storage: every word must really be in the grid where it says.
  function normPuzzle(p) {
    if (!p || typeof p !== 'object') return null;
    var size = p.size | 0;
    if (size < 5 || size > 15 || typeof p.grid !== 'string' || p.grid.length !== size * size || !/^[A-Z]+$/.test(p.grid)) return null;
    if (!Array.isArray(p.words) || !p.words.length || p.words.length > 30) return null;
    var words = [];
    for (var i = 0; i < p.words.length; i++) {
      var w = p.words[i];
      if (!w || typeof w.w !== 'string' || !/^[A-Z]{2,15}$/.test(w.w)) return null;
      var r = w.r | 0, c = w.c | 0, d = w.d | 0;
      if (d < 0 || d > 7) return null;
      var cells = lineCells(size, r, c, r + DIRS[d][0] * (w.w.length - 1), c + DIRS[d][1] * (w.w.length - 1));
      if (!cells) return null;
      for (var k = 0; k < cells.length; k++) if (p.grid.charAt(cells[k]) !== w.w.charAt(k)) return null;
      words.push({ w: w.w, disp: typeof w.disp === 'string' && w.disp ? w.disp.slice(0, 40) : disp(w.w), r: r, c: c, d: d });
    }
    return { v: 1, size: size, level: LEVELS[p.level] ? p.level : 'medium', seed: (p.seed >>> 0), grid: p.grid, words: words,
      theme: typeof p.theme === 'string' ? p.theme.slice(0, 20) : '', title: typeof p.title === 'string' ? p.title.slice(0, 40) : '' };
  }
  // A saved solo / daily game in progress.
  function packGame(g, extra) {
    var f = [];
    for (var i = 0; i < g.found.length; i++) f.push(g.found[i] ? 1 : 0);
    return { v: 1, pz: g.pz, mode: g.mode, found: f, hints: g.hints.slice(), t: Math.round(g.t * 10) / 10, penalty: g.penalty, nHints: g.nHints, misses: g.misses, day: extra && extra.day || '' };
  }
  function unpackGame(o) {
    if (!o || typeof o !== 'object' || !/^(solo|daily)$/.test(o.mode)) return null;
    var pz = normPuzzle(o.pz);
    if (!pz) return null;
    var g = newGame(pz, { mode: o.mode });
    for (var i = 0; i < pz.words.length; i++) {
      if (Array.isArray(o.found) && o.found[i]) markFound(g, i, 0);
      if (Array.isArray(o.hints)) g.hints[i] = clamp(o.hints[i] | 0, 0, 2);
    }
    if (g.done) return null;
    g.t = num(o.t, 359999); g.penalty = num(o.penalty, 359999); g.nHints = Math.floor(num(o.nHints)); g.misses = Math.floor(num(o.misses));
    g.day = typeof o.day === 'string' && /^\d{4}-\d\d-\d\d$/.test(o.day) ? o.day : '';
    return g;
  }
  // Fold a finished game into the save. → { time, best, newBest, clean, res }
  function settle(save, g, day) {
    var st = save.stats, out = { time: finalTime(g), newBest: false, best: 0, res: 0 }, lv = g.pz.level;
    st.played++;
    st.words += g.order.filter(function (i) { return g.found[i].by !== 2; }).length;
    st.hints += g.nHints;
    if (g.mode === 'solo' || g.mode === 'daily') {
      if (g.done) st.solved++;
      var t = Math.max(1, Math.round(out.time));
      if (g.done && LEVELS[lv]) {
        if (!save.best[lv] || t < save.best[lv]) { save.best[lv] = t; out.newBest = true; }
        if (!g.nHints && (!save.bestClean[lv] || t < save.bestClean[lv])) save.bestClean[lv] = t;
        out.best = save.best[lv];
      }
      if (g.mode === 'daily' && g.done && day) {
        var prev = save.daily[day];
        if (!prev || t < prev) save.daily[day] = t;
        out.dayBest = save.daily[day];
      }
    } else if (g.mode === 'cpu') {
      var res = outcome(g), c = save.cpu[g.cpu];
      out.res = res;
      if (res > 0) c.w++; else if (res < 0) c.l++; else c.d++;
      if (res > 0) st.solved++;
    }
    return out;
  }

  var ENGINE = {
    DIRS: DIRS, DIR_NAMES: DIR_NAMES, LEVELS: LEVELS, LEVEL_IDS: LEVEL_IDS, CPU_LEVELS: CPU_LEVELS, CPU_IDS: CPU_IDS,
    HINT_SEC: HINT_SEC, HINT_PTS: HINT_PTS, TURN_SEC: TURN_SEC,
    rng: rng, hash2: hash2, hashStr: hashStr, norm: norm, disp: disp, pickWords: pickWords, noteWords: noteWords, parseList: parseList,
    generate: generate, occurrences: occurrences, placeCells: placeCells, wordCells: wordCells, snap: snap, lineCells: lineCells,
    matchCells: matchCells, wordPoints: wordPoints, isBack: isBack, isDiag: isDiag,
    newGame: newGame, submit: submit, hint: hint, hintCells: hintCells, tick: tick, cpuPick: cpuPick, cpuDelay: cpuDelay,
    finalTime: finalTime, outcome: outcome, relayResult: relayResult, dayNum: dayNum, dayKey: dayKey, dailySpec: dailySpec, streak: streak,
    newSave: newSave, normSave: normSave, normPuzzle: normPuzzle, packGame: packGame, unpackGame: unpackGame, settle: settle
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('wordsearch.css');
  var DATA_URL = Cade.asset('wordsearch-data.js');   // resolve now, while the module context is ours

  var PANEL_ID = 'wordsearch-panel', NAME = 'Word Search';
  var KEY = 'cade-wordsearch-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound', GAME_KEY = KEY + 'game', LIST_KEY = KEY + 'custom';
  var NHUE = 7;   // solo: found words cycle through these hues (CSS .ws-h0 … .ws-h6)
  var S = null;
  var data = null, loading = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.wordsearch = { live: function () { return S; }, engine: ENGINE };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { Cade.store.remove(k); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function toast(m, type, ms) { try { Cade.showToast(m, type || 'info', ms || 2200); } catch (e) {} }
  function fmtT(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (h ? h + ':' + ('0' + m).slice(-2) : m) + ':' + ('0' + s).slice(-2);
  }
  function fmtT10(sec) { return fmtT(sec) + '.' + Math.floor((sec % 1) * 10); }
  function today() { return dayNum(new Date()); }

  function loadData() {
    if (data) return Promise.resolve(data);
    if (window.__cadeWordSearchData && window.__cadeWordSearchData.themes) { data = window.__cadeWordSearchData; return Promise.resolve(data); }
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = DATA_URL; s.async = true;
      s.onload = function () {
        if (window.__cadeWordSearchData && window.__cadeWordSearchData.themes) { data = window.__cadeWordSearchData; resolve(data); }
        else { loading = null; reject(new Error('no data')); }
      };
      s.onerror = function () { loading = null; s.remove(); reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
    return loading;
  }
  function themes() { return data ? data.themes : []; }
  function themeById(id) { var T = themes(); for (var i = 0; i < T.length; i++) if (T[i][0] === id) return T[i]; return null; }
  function themeWords(t) { return t[3].split(' '); }

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
  var SCALE = [523, 587, 659, 784, 880, 1047, 1175, 1319, 1568];
  function sfx(kind, n) {
    if (!S) return;
    var s = S.snd, i;
    if (kind === 'tick') s.tone(1200, 0.025, 'sine', 0.015);
    else if (kind === 'find') { for (i = 0; i < Math.min(5, 2 + Math.floor(n / 3)); i++) s.tone(SCALE[i * 2 % SCALE.length], 0.12, 'triangle', 0.04, 0, i * 0.055); }
    else if (kind === 'cpu') { s.tone(330, 0.1, 'square', 0.02); s.tone(262, 0.14, 'square', 0.02, 0, 0.08); }
    else if (kind === 'miss') s.tone(180, 0.14, 'sawtooth', 0.025, 120);
    else if (kind === 'hint') { s.tone(988, 0.08, 'sine', 0.035); s.tone(1319, 0.1, 'sine', 0.03, 0, 0.07); }
    else if (kind === 'turn') s.tone(660, 0.08, 'sine', 0.03);
    else if (kind === 'win') { for (i = 0; i < 6; i++) s.tone(SCALE[[0, 2, 4, 5, 7, 8][i]], 0.18, 'triangle', 0.045, 0, i * 0.09); }
    else if (kind === 'lose') { s.tone(392, 0.2, 'triangle', 0.04); s.tone(330, 0.2, 'triangle', 0.04, 0, 0.18); s.tone(262, 0.35, 'triangle', 0.04, 0, 0.36); }
  }

  function svgI(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svgI('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svgI('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svgI('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svgI('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svgI('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');

  // ---------------- home (menu) ----------------
  function chip(attr, val, label, on, extra) {
    return '<button type="button" class="ws-chip' + (on ? ' on' : '') + '" ' + attr + '="' + esc(val) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' + (extra || '') + '>' + label + '</button>';
  }
  function noteText() {
    try { return Cade.editor ? Cade.editor.state.doc.toString() : ''; } catch (e) { return ''; }
  }
  function homeHtml() {
    var sv = S.save, p = sv.prefs, h = '', i, T = themes();
    h += '<div class="ws-title">WORD SEARCH</div>';
    if (S.resume) {
      var rg = S.resume, tl = rg.pz.title || 'Puzzle';
      h += '<button type="button" class="ws-go ws-cont" data-act="continue">Continue <small>' + esc(tl) + ' · ' + LEVELS[rg.pz.level].name + ' · ' +
        rg.nFound + '/' + rg.pz.words.length + ' · ' + fmtT(finalTime(rg)) + '</small></button>';
    }
    // daily
    var tn = today(), ds = T.length ? dailySpec(tn, T.length) : null, done = ds && sv.daily[ds.key], stk = streak(sv.daily, tn);
    if (ds) {
      var dt = T[ds.theme];
      h += '<div class="ws-daily"><div><b>Daily puzzle</b> <span class="ws-mut">' + esc(new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })) + ' · ' +
        dt[1] + ' ' + esc(dt[2]) + '</span><div class="ws-note">' + (done ? '✓ solved in ' + fmtT(done) : 'not solved yet') + (stk ? ' · streak ' + stk + (stk > 1 ? ' days' : ' day') : '') + '</div></div>' +
        '<button type="button" class="ws-go sm" data-act="daily">' + (done ? 'Replay' : 'Play') + '</button></div>';
    }
    h += '<div class="ws-tabs" role="tablist">' +
      ['solo', 'cpu', 'p2'].map(function (m) {
        return '<button type="button" role="tab" data-mode="' + m + '" class="' + (p.mode === m ? 'on' : '') + '" aria-selected="' + (p.mode === m) + '">' + (m === 'solo' ? 'Solo' : m === 'cpu' ? 'vs CPU' : '2 Players') + '</button>';
      }).join('') + '</div>';
    if (p.mode === 'cpu') {
      h += '<div class="ws-sec"><div class="ws-h">CPU skill</div><div class="ws-chips">';
      for (i = 0; i < CPU_IDS.length; i++) {
        var cr = sv.cpu[CPU_IDS[i]];
        h += chip('data-cpu', CPU_IDS[i], CPU_LEVELS[CPU_IDS[i]].name + (cr.w + cr.l + cr.d ? ' <i>' + cr.w + '–' + cr.l + '</i>' : ''), p.cpu === CPU_IDS[i]);
      }
      h += '</div><p class="ws-tip">Race the CPU on one grid. Longer, diagonal and backwards words score more.</p></div>';
    } else if (p.mode === 'p2') {
      h += '<div class="ws-sec"><div class="ws-h">Two players, one device</div><div class="ws-chips">' +
        chip('data-p2', 'alt', 'Alternate finds', p.p2 === 'alt') + chip('data-p2', 'relay', 'Take turns', p.p2 === 'relay') + '</div>' +
        '<p class="ws-tip">' + (p.p2 === 'alt' ? 'One shared grid: find a word, then it’s the other player’s turn (' + TURN_SEC + ' s each). Most points wins.'
          : 'Each player solves the same grid in turn, hidden from the other. Fastest time wins.') + '</p></div>';
    }
    // words
    h += '<div class="ws-sec"><div class="ws-h">Words</div><div class="ws-chips">' +
      chip('data-src', 'theme', 'Theme pack', p.src === 'theme') + chip('data-src', 'note', 'From my note', p.src === 'note') + chip('data-src', 'custom', 'Custom list', p.src === 'custom') + '</div>';
    if (p.src === 'theme') {
      h += '<div class="ws-chips ws-themes">' + chip('data-theme-id', 'random', '🎲 Random', p.theme === 'random');
      for (i = 0; i < T.length; i++) h += chip('data-theme-id', T[i][0], T[i][1] + ' ' + esc(T[i][2]), p.theme === T[i][0]);
      if (!T.length) h += '<span class="ws-note">loading packs…</span>';
      h += '</div>';
    } else if (p.src === 'note') {
      var nw = noteWords(noteText(), MAX_LIST);
      h += '<p class="ws-tip">' + (nw.length >= 4 ? 'Hides words from the open note — ' + nw.length + (nw.length >= MAX_LIST ? '+' : '') + ' to pick from, e.g. <b>' +
        nw.slice(0, 5).map(esc).join(', ') + '</b>.' : 'The open note has too few distinct words (needs 4+ of 4 letters or more) — a theme pack will be used instead.') + '</p>';
    } else {
      var pl = parseList(S.custom);
      h += '<textarea class="ws-ta" rows="3" spellcheck="false" placeholder="apple, banana, cherry …  (commas or new lines)">' + esc(S.custom) + '</textarea>' +
        '<p class="ws-tip ws-cl">' + listInfo(pl) + '</p>';
    }
    h += '</div>';
    // difficulty
    h += '<div class="ws-sec"><div class="ws-h">Difficulty</div><div class="ws-chips">';
    for (i = 0; i < LEVEL_IDS.length; i++) {
      var L = LEVELS[LEVEL_IDS[i]];
      h += chip('data-level', L.id, L.name + ' <i>' + L.size + '×' + L.size + '</i>', p.level === L.id);
    }
    h += '</div><p class="ws-tip">' + esc(LEVELS[p.level].info) + ' · ' + LEVELS[p.level].words + ' words</p></div>';
    h += '<button type="button" class="ws-go" data-act="play">Play' + (S.coarse ? '' : ' <small>enter</small>') + '</button>';
    // records
    var rec = LEVEL_IDS.map(function (id) { return '<span>' + LEVELS[id].name + ' <b>' + (sv.best[id] ? fmtT(sv.best[id]) : '–') + '</b></span>'; }).join('');
    h += '<div class="ws-recs"><div class="ws-h">Best times</div><div class="ws-rec">' + rec + '</div>' +
      '<div class="ws-foot"><span>' + sv.stats.solved + ' solved · ' + sv.stats.words + ' words found</span>' +
      (S.resetArm ? '<span class="ws-confirm">Erase records? <button type="button" class="ws-lnk danger" data-act="reset-yes">Erase</button><button type="button" class="ws-lnk" data-act="reset-no">Keep</button></span>'
        : '<button type="button" class="ws-lnk" data-act="reset">Reset records</button>') + '</div></div>';
    return '<div class="ws-card ws-homecard">' + h + '</div>';
  }
  function listInfo(pl) {
    var n = pl.words.length;
    return n ? n + ' word' + (n === 1 ? '' : 's') + (n < 3 ? ' — add at least 3' : '') + (pl.bad.length ? ' · skipped: ' + pl.bad.slice(0, 3).map(esc).join(', ') + (pl.bad.length > 3 ? '…' : '') : '') + ' · the grid grows to fit the longest word'
      : 'Type or paste 3+ words (3–15 letters).';
  }
  function helpHtml() {
    return '<div class="ws-card"><div class="ws-title">HOW TO PLAY</div>' +
      '<p>Find every word in the list hidden in the grid — across, down, diagonally and (on Hard and Expert) <b>backwards</b>.</p>' +
      '<div class="ws-keys"><span><b>Drag</b> or <b>swipe</b> from the first letter to the last — the line snaps straight.</span>' +
      '<span><b>Tap</b> the first letter, then the last.</span>' +
      '<span><b>Arrows</b> move · <b>Enter</b> marks start / end · <b>H</b> hint · <b>P</b> pause · <b>Esc</b> cancel</span></div>' +
      '<p><b>Hints</b> light up a word’s first letter (ask again for its last): +' + HINT_SEC + ' s on your time, or −' + HINT_PTS + ' points in a match.</p>' +
      '<p><b>vs CPU</b>: a race on one grid — the CPU finds words as you play. <b>2 Players</b>: alternate finds with a ' + TURN_SEC + ' s turn clock, or take turns solving the same grid.</p>' +
      '<p>Points: one per letter, +1 diagonal, +2 backwards. Words can come from 32 theme packs, the note you have open, or your own list.</p>' +
      '<button type="button" class="ws-go" data-act="close-help">Got it</button></div>';
  }

  // ---------------- starting a game ----------------
  function wordPool(p, r) {
    if (p.src === 'note') {
      var nw = noteWords(noteText(), MAX_LIST);
      if (nw.length >= 4) return { pool: nw, title: 'My note', theme: 'note' };
      toast('Not enough words in this note — using a theme pack', 'info');
    } else if (p.src === 'custom') {
      var pl = parseList(S.custom);
      if (pl.words.length >= 3) return { pool: pl.words, title: 'My list', theme: 'custom' };
      toast('Add at least 3 words to the custom list — using a theme pack', 'info');
    }
    var T = themes(), t = p.theme !== 'random' && themeById(p.theme) || T[Math.floor(r() * T.length)];
    return { pool: themeWords(t), title: t[2], theme: t[0], icon: t[1] };
  }
  function startFromPrefs() {
    if (!data) { toast('Loading word packs…'); return; }
    var p = S.save.prefs, seed = (Math.random() * 4294967295) >>> 0, r = rng(seed);
    var wp = wordPool(p, r), lv = LEVELS[p.level], go2 = { theme: wp.theme, title: wp.title };
    if (wp.theme === 'custom') {
      // your own list: use all of it (up to 24), on a grid big enough for the longest word
      var mx = 0, tot = 0;
      wp.pool.slice(0, 24).forEach(function (w) { var n = norm(w).length; mx = Math.max(mx, n); tot += n; });
      go2.size = clamp(Math.max(lv.size, mx, Math.ceil(Math.sqrt(tot * 1.8))), 8, 15);
      go2.count = Math.min(wp.pool.length, 24);
    }
    var pz = generate(wp.pool, p.level, seed, go2);
    if (go2.count && pz.words.length < go2.count) toast((go2.count - pz.words.length) + ' word' + (go2.count - pz.words.length > 1 ? 's' : '') + ' did not fit — try a bigger grid', 'info');
    if (pz.words.length < Math.min(3, lv.words)) { toast('Could not fit enough words — try a bigger grid', 'error'); return; }
    var mode = p.mode === 'cpu' ? 'cpu' : p.mode === 'p2' ? p.p2 : 'solo';
    if (mode === 'solo') clearResume();
    begin(pz, mode);
  }
  function startDaily() {
    if (!data) return;
    var T = themes(), ds = dailySpec(today(), T.length), t = T[ds.theme];
    var pz = generate(themeWords(t), ds.level, ds.seed, { theme: t[0], title: 'Daily · ' + t[2] });
    clearResume();
    begin(pz, 'daily', { day: ds.key });
  }
  function begin(pz, mode, extra) {
    S.snd.ensure();
    var g = newGame(pz, { mode: mode, cpu: S.save.prefs.cpu });
    g.day = extra && extra.day || '';
    S.g = g; S.relay = null; S.revealed = false; S.anchor = -1; S.cur = -1; S.sel = null; S.flash = [];
    if (mode === 'relay') { S.relay = { p: 0, times: [0, 0], hints: [0, 0] }; }
    S.phase = 'play';
    S.paused = false;
    buildBoard();
    if (mode === 'alt' || mode === 'relay') pass(0, true);
    else go();
  }
  function resumeSaved() {
    var g = S.resume;
    if (!g) return;
    S.resume = null;
    S.snd.ensure();
    S.g = g; S.relay = null; S.revealed = false; S.anchor = -1; S.cur = -1; S.sel = null;
    S.phase = 'play';
    buildBoard();
    pause();
  }
  function go() {
    S.phase = 'play'; S.paused = false;
    showOvl(null);
    S.stage.classList.remove('veil');
    syncAll();
    startLoop();
  }
  // Hand-off screen: the grid is hidden until the next player taps.
  function pass(player, first) {
    stopLoop();
    S.phase = 'pass'; S.passTo = player;
    S.stage.classList.add('veil');
    var g = S.g, msg;
    if (g.mode === 'relay') {
      msg = first ? '<p>Player 1 solves the grid first, then Player 2 gets the same one. Fastest time wins (hints +' + HINT_SEC + ' s).</p>'
        : '<p>Player 1 is done — the time stays secret until the end. Player 2: same grid, beat it!</p>';
    } else msg = '<p>Take turns: find one word, then pass. ' + TURN_SEC + ' s per turn. Most points wins.</p>';
    showOvl('<div class="ws-card"><div class="ws-title">PASS</div><div class="ws-big ws-p' + player + '">Player ' + (player + 1) + '</div>' + msg +
      '<button type="button" class="ws-go" data-act="ready">Pass to Player ' + (player + 1) + ' — tap when ready</button></div>');
    syncAll();
  }
  function ready() {
    if (S.phase !== 'pass') return;
    sfx('turn');
    go();
  }

  // ---------------- board ----------------
  function buildBoard() {
    var g = S.g, pz = g.pz, N = pz.size, h = '';
    S.home.style.display = 'none';
    S.play.style.display = '';
    for (var i = 0; i < N * N; i++) h += '<span class="ws-cell" data-i="' + i + '">' + pz.grid.charAt(i) + '</span>';
    S.grid.innerHTML = h;
    S.grid.style.gridTemplateColumns = 'repeat(' + N + ', 1fr)';
    S.cells = S.grid.children;
    S.root.classList.toggle('vs', g.mode === 'cpu' || g.mode === 'alt');
    layout();
    renderList();
    renderMarks();
    syncAll();
  }
  function ownerClass(g, i) {
    var f = g.found[i];
    if (!f) return '';
    if (g.mode === 'cpu') return f.by === 2 ? 'ws-cpu' : 'ws-p0';
    if (g.mode === 'alt') return 'ws-p' + f.by;
    return 'ws-h' + (g.order.indexOf(i) % NHUE);
  }
  function renderList() {
    var g = S.g, pz = g.pz, h = '', idx = pz.words.map(function (w, i) { return i; });
    for (var k = 0; k < idx.length; k++) {
      var i = idx[k], f = g.found[i], w = pz.words[i];
      var tag = f ? (g.mode === 'cpu' ? (f.by === 2 ? 'CPU' : 'YOU') : g.mode === 'alt' ? 'P' + (f.by + 1) : '') : '';
      h += '<li class="' + (f ? 'got ' + ownerClass(g, i) : S.revealed ? 'missed' : '') + '" data-w="' + i + '"><span class="ws-wd">' + esc(w.disp) + '</span>' +
        (tag ? '<i>' + tag + '</i>' : f && (g.mode === 'cpu' || g.mode === 'alt') ? '' : '') + '</li>';
    }
    S.list.innerHTML = h;
  }
  // The found-word boxes (and the drag line) as SVG capsules under the letters.
  function capsule(cells, cls, N) {
    var a = cells[0], b = cells[cells.length - 1], cs = S.cs;
    var x0 = (a % N + 0.5) * cs, y0 = (Math.floor(a / N) + 0.5) * cs, x1 = (b % N + 0.5) * cs, y1 = (Math.floor(b / N) + 0.5) * cs;
    var len = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)), hgt = cs * 0.78, w = len + hgt;
    var ang = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return '<rect class="' + cls + '" x="' + (cx - w / 2).toFixed(1) + '" y="' + (cy - hgt / 2).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + hgt.toFixed(1) +
      '" rx="' + (hgt / 2).toFixed(1) + '" transform="rotate(' + ang.toFixed(1) + ' ' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ')"/>';
  }
  function renderMarks() {
    if (!S || !S.g) return;
    var g = S.g, pz = g.pz, N = pz.size, h = '', i, gw = N * S.cs;
    S.svg.setAttribute('viewBox', '0 0 ' + gw + ' ' + gw);
    S.svg.setAttribute('width', gw); S.svg.setAttribute('height', gw);
    for (i = 0; i < pz.words.length; i++) {
      if (g.found[i]) h += capsule(g.found[i].cells, 'cap ' + ownerClass(g, i) + (S.fresh === i ? ' fresh' : ''), N);
      else if (S.revealed) h += capsule(wordCells(pz, i), 'cap miss', N);
    }
    if (S.sel && S.sel.length) h += capsule(S.sel, 'cap sel' + (S.selBad ? ' bad' : ''), N);
    S.svg.innerHTML = h;
    // letters: found / hint / cursor / anchor classes
    var mark = {}, hc = (S.revealed || g.done) ? [] : hintCells(g);
    for (i = 0; i < pz.words.length; i++) if (g.found[i]) g.found[i].cells.forEach(function (c) { mark[c] = 1; });
    var hm = {};
    hc.forEach(function (c) { hm[c] = 1; });
    var selm = {};
    if (S.sel) S.sel.forEach(function (c) { selm[c] = 1; });
    for (i = 0; i < S.cells.length; i++) {
      var el = S.cells[i], cl = 'ws-cell' + (mark[i] ? ' got' : '') + (hm[i] ? ' hint' : '') + (selm[i] ? ' on' : '') + (i === S.cur && S.kbd ? ' cur' : '') + (i === S.anchor ? ' anc' : '');
      if (el.className !== cl) el.className = cl;
    }
  }

  // ---------------- HUD / pad / header ----------------
  function hudHtml() {
    var g = S.g, t = '<span class="ws-tm">' + fmtT(finalTime(g)) + '</span>';
    var cnt = '<span class="ws-cnt">' + g.nFound + '/' + g.pz.words.length + '</span>';
    var title = '<span class="ws-tl">' + esc(g.pz.title || 'Puzzle') + ' · ' + LEVELS[g.pz.level].name + '</span>';
    if (g.mode === 'cpu') {
      return '<span class="ws-sc ws-p0 on">YOU <b>' + g.score[0] + '</b></span>' + cnt + t + '<span class="ws-sc ws-cpu">CPU <b>' + g.score[2] + '</b></span>';
    }
    if (g.mode === 'alt') {
      var on0 = g.turn === 0 && S.phase === 'play', on1 = g.turn === 1 && S.phase === 'play';
      return '<span class="ws-sc ws-p0' + (on0 ? ' on' : '') + '">P1 <b>' + g.score[0] + '</b></span>' +
        '<span class="ws-turn">' + (S.phase === 'play' ? 'P' + (g.turn + 1) + ' · <span class="ws-tt">' + Math.ceil(g.turnT) + '</span>s' : cnt) + '</span>' +
        '<span class="ws-sc ws-p1' + (on1 ? ' on' : '') + '">P2 <b>' + g.score[1] + '</b></span>';
    }
    if (g.mode === 'relay') return '<span class="ws-sc ws-p' + S.relay.p + ' on">Player ' + (S.relay.p + 1) + '</span>' + cnt + t;
    return title + cnt + t;
  }
  function syncHud() { if (S && S.g) S.hud.innerHTML = hudHtml(); }
  function syncPad() {
    var g = S.g, h = '';
    if (!g) { S.pad.innerHTML = ''; return; }
    if (S.phase === 'play' && !S.paused) {
      var cost = (g.mode === 'cpu' || g.mode === 'alt') ? '−' + HINT_PTS + ' pts' : '+' + HINT_SEC + ' s';
      h = '<button type="button" class="ws-act alt" data-act="hint">Hint <small>' + cost + '</small></button>' +
        '<button type="button" class="ws-act alt" data-act="pause">Pause</button>';
    } else if (S.phase === 'done' && !S.ovlOn) {
      h = '<button type="button" class="ws-act" data-act="again">New puzzle</button><button type="button" class="ws-act alt" data-act="results">Results</button>';
    }
    S.pad.innerHTML = h;
    S.pad.style.display = h ? '' : 'none';
  }
  function syncHead() {
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
  function syncAll() { syncHud(); syncPad(); syncHead(); }
  function showOvl(html) {
    S.ovlOn = !!html;
    S.ovl.innerHTML = html || '';
    S.ovl.style.display = html ? '' : 'none';
    S.stage.classList.toggle('dim', !!html);
    if (html) {
      var b = S.ovl.querySelector('.ws-go');
      if (b && !S.coarse) { try { b.focus({ preventScroll: true }); } catch (e) {} }
    }
  }
  function say(text) { if (S && S.liveEl) S.liveEl.textContent = text; }
  function banner(text, cls) {
    if (!S) return;
    var old = S.fx.querySelectorAll('.ws-banner');
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
    var b = document.createElement('div');
    b.className = 'ws-banner ' + (cls || '');
    b.textContent = text;
    S.fx.appendChild(b);
    setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 1300);
  }

  // ---------------- the loop (only while a game is being played) ----------------
  function running() { return !!S && S.phase === 'play' && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function startLoop() {
    if (!S || S.raf) return;
    S.last = 0;
    S.raf = requestAnimationFrame(frame);
  }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!running()) return;
    var dt = S.last ? Math.min(0.25, (ts - S.last) / 1000) : 0;
    S.last = ts;
    var g = S.g, sec0 = Math.floor(finalTime(g)), tt0 = Math.ceil(g.turnT);
    var ev = tick(g, dt);
    for (var k = 0; k < ev.length; k++) {
      var e = ev[k];
      if (e.cpu != null) onFound(e.cpu, 2, e.pts);
      else if (e.timeout != null) {
        sfx('turn');
        banner('Time! Player ' + (g.turn + 1) + '’s turn', 'ws-p' + g.turn);
        say('Time is up. Player ' + (g.turn + 1) + '’s turn.');
        clearSel();
        syncHud();
      }
    }
    if (!S || S.g !== g) return;
    if (g.done) { finish(); return; }
    if (Math.floor(finalTime(g)) !== sec0 || Math.ceil(g.turnT) !== tt0) {
      syncHud();
      if (g.mode === 'alt' && g.turnT <= 5.5 && Math.ceil(g.turnT) !== tt0) sfx('tick');
    }
    S.raf = requestAnimationFrame(frame);
  }
  function pause() {
    if (!S || S.phase !== 'play' || S.paused) return;
    S.paused = true;
    stopLoop();
    clearSel();
    S.stage.classList.add('veil');
    saveProgress();
    var g = S.g, solo = g.mode === 'solo' || g.mode === 'daily';
    showOvl('<div class="ws-card"><div class="ws-title">PAUSED</div><div class="ws-big">' + fmtT(finalTime(g)) + '</div>' +
      '<div class="ws-sub">' + g.nFound + ' of ' + g.pz.words.length + ' words found</div>' +
      '<button type="button" class="ws-go" data-act="resume">Resume' + (S.coarse ? '' : ' <small>P</small>') + '</button>' +
      '<div class="ws-btns"><button type="button" class="ws-go alt" data-act="reveal">' + (solo ? 'Give up & reveal' : 'End & reveal') + '</button>' +
      '<button type="button" class="ws-go alt" data-act="menu">' + (solo ? 'Menu (saved)' : 'Menu') + '</button></div></div>');
    syncAll();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.snd.ensure();
    S.paused = false;
    go();
  }

  // ---------------- finding words ----------------
  function clearSel() { if (!S) return; S.sel = null; S.selBad = false; S.drag = null; S.anchor = -1; renderMarks(); }
  function trySubmit(cells) {
    var g = S.g;
    if (!g || S.phase !== 'play' || S.paused) return;
    var who = g.mode === 'alt' ? g.turn : 0;
    var r = submit(g, cells, who);
    if (r) { S.sel = null; onFound(r.i, who, r.pts); }
    else if (cells && cells.length > 1) {
      sfx('miss');
      S.sel = cells; S.selBad = true; renderMarks();
      var gg = g;
      setTimeout(function () { if (S && S.g === gg && S.selBad) { S.sel = null; S.selBad = false; renderMarks(); } }, 260);
      try { Cade.haptic && Cade.haptic(12); } catch (e) {}
    } else { S.sel = null; renderMarks(); }
  }
  function onFound(i, who, pts) {
    var g = S.g, w = g.pz.words[i], cells = g.found[i].cells;
    S.fresh = i;
    S.anchor = -1;
    renderMarks(); renderList();
    var li = S.list.querySelector('[data-w="' + i + '"]');
    if (li) { li.classList.add('pop'); try { li.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
    var cls = ownerClass(g, i);
    for (var k = 0; k < cells.length; k++) {
      var el = S.cells[cells[k]];
      if (el && el.animate && !S.rm) el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 320, delay: k * 35, easing: 'ease-out' });
    }
    burstAt(cells[Math.floor(cells.length / 2)], cls, who === 2 ? 5 : 10);
    if (who === 2) { sfx('cpu'); banner('CPU found ' + w.disp.toUpperCase(), 'ws-cpu'); say('The CPU found ' + w.disp + '.'); }
    else {
      sfx('find', w.w.length);
      try { Cade.haptic && Cade.haptic(8); } catch (e) {}
      var extra = (isBack(w) ? ' backwards' : '') + (isDiag(w) ? ' diagonal' : '');
      say((g.mode === 'alt' ? 'Player ' + (who + 1) + ' found ' : 'Found ') + w.disp + '.' + (g.done ? '' : ' ' + (g.pz.words.length - g.nFound) + ' to go.'));
      if (g.mode === 'cpu' || g.mode === 'alt') banner('+' + pts + extra, cls);
      if (g.mode === 'alt' && !g.done) setTimeout(function () { if (S && S.g === g && !g.done) { banner('Player ' + (g.turn + 1) + '’s turn', 'ws-p' + g.turn); sfx('turn'); } }, 650);
    }
    setTimeout(function () { if (S && S.fresh === i) { S.fresh = -1; if (S.g === g) renderMarks(); } }, 600);
    syncHud();
    saveProgress();
    if (g.done) setTimeout(function () { if (S && S.g === g && S.phase === 'play') finish(); }, 380);
  }
  function burstAt(cell, cls, n) {
    if (!S || !S.cs) return;
    if (S.rm) n = Math.ceil(n / 3);
    var N = S.g.pz.size, x = (cell % N + 0.5) * S.cs, y = (Math.floor(cell / N) + 0.5) * S.cs, G = '*+.o·';
    for (var k = 0; k < n; k++) {
      var s = document.createElement('span');
      s.className = 'ws-spark ' + cls;
      s.textContent = G.charAt(k % G.length);
      s.style.left = x + 'px'; s.style.top = y + 'px';
      S.fx.appendChild(s);
      var a = Math.random() * Math.PI * 2, d = S.cs * (1 + Math.random() * 1.8);
      if (s.animate) {
        var an = s.animate([{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
          { transform: 'translate(calc(-50% + ' + (Math.cos(a) * d).toFixed(0) + 'px), calc(-50% + ' + (Math.sin(a) * d).toFixed(0) + 'px)) scale(0.6)', opacity: 0 }],
        { duration: 500 + Math.random() * 300, easing: 'cubic-bezier(.2,.7,.3,1)' });
        an.onfinish = (function (el) { return function () { if (el.parentNode) el.parentNode.removeChild(el); }; })(s);
      } else setTimeout((function (el) { return function () { if (el.parentNode) el.parentNode.removeChild(el); }; })(s), 600);
    }
  }
  function doHint() {
    var g = S.g;
    if (!g || S.phase !== 'play' || S.paused) return;
    var h = hint(g);
    if (!h) { toast('Every word already has its hints'); return; }
    sfx('hint');
    renderMarks(); syncHud();
    var c = wordCells(g.pz, h.i), cell = h.level > 1 ? c[c.length - 1] : c[0], el = S.cells[cell];
    if (el && el.animate && !S.rm) el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.5)' }, { transform: 'scale(1)' }], { duration: 450, iterations: 2 });
    say('Hint: a word ' + (h.level > 1 ? 'ends' : 'starts') + ' at the highlighted ' + g.pz.grid.charAt(cell) + '.');
    saveProgress();
  }

  // ---------------- the end ----------------
  function finish() {
    var g = S.g;
    stopLoop();
    clearSel();
    if (g.mode === 'relay' && S.relay.p === 0) {
      S.relay.times[0] = finalTime(g); S.relay.hints[0] = g.nHints;
      sfx('win');
      burstAll();
      S.g = newGame(g.pz, { mode: 'relay' });
      S.relay.p = 1;
      S.fresh = -1;
      renderMarks(); renderList();
      pass(1, false);
      return;
    }
    S.phase = 'done';
    S.revealed = true;
    S.stage.classList.remove('veil');
    var out = null;
    if (g.mode === 'relay') { S.relay.times[1] = finalTime(g); S.relay.hints[1] = g.nHints; }
    else if (g.mode !== 'alt') {
      if (g.mode === 'cpu' && !g.done) g.forfeit = true;   // ending a race early concedes it
      out = settle(S.save, g, g.day); persist();
    }
    if (g.mode === 'solo' || g.mode === 'daily') clearResume();
    renderMarks(); renderList();
    S.results = resultsHtml(g, out);
    var win = g.done && (g.mode === 'solo' || g.mode === 'daily' || (g.mode === 'cpu' ? outcome(g) >= 0 : true));
    if (win) { sfx('win'); burstAll(); } else sfx('lose');
    showOvl(S.results);
    syncAll();
  }
  function burstAll() {
    var g = S.g;
    for (var i = 0; i < g.pz.words.length; i++) if (g.found[i]) burstAt(g.found[i].cells[0], ownerClass(g, i), 3);
  }
  function resultsHtml(g, out) {
    var h = '<div class="ws-card">', st;
    if (g.mode === 'cpu') {
      var o = outcome(g);
      h += '<div class="ws-title">' + (g.forfeit ? 'CONCEDED' : o > 0 ? 'YOU WIN' : o < 0 ? 'CPU WINS' : 'DRAW') + '</div>' +
        '<div class="ws-big">' + g.score[0] + ' <span class="ws-mut">–</span> ' + g.score[2] + '</div>' +
        '<div class="ws-sub">' + countBy(g, 0) + ' words vs ' + countBy(g, 2) + ' · ' + CPU_LEVELS[g.cpu].name + ' CPU · ' + fmtT(g.t) + '</div>';
      var c = S.save.cpu[g.cpu];
      h += '<div class="ws-note">Record vs ' + CPU_LEVELS[g.cpu].name + ': ' + c.w + ' won · ' + c.l + ' lost' + (c.d ? ' · ' + c.d + ' drawn' : '') + '</div>';
    } else if (g.mode === 'alt') {
      var oa = outcome(g);
      h += '<div class="ws-title">' + (oa > 0 ? 'PLAYER 1 WINS' : oa < 0 ? 'PLAYER 2 WINS' : 'DRAW') + '</div>' +
        '<div class="ws-big"><span class="ws-p0">' + g.score[0] + '</span> <span class="ws-mut">–</span> <span class="ws-p1">' + g.score[1] + '</span></div>' +
        '<div class="ws-sub">' + countBy(g, 0) + ' words vs ' + countBy(g, 1) + ' · ' + fmtT(g.t) + '</div>';
    } else if (g.mode === 'relay') {
      var t0 = S.relay.times[0], t1 = S.relay.times[1], done1 = g.done, done0 = t0 < 359999;
      var w = relayResult(t0, t1, done0, done1);
      h += '<div class="ws-title">' + (w === -2 ? 'NO WINNER' : w < 0 ? 'DEAD HEAT' : 'PLAYER ' + (w + 1) + ' WINS') + '</div>' +
        '<pre class="ws-tab">' + '<span class="ws-p0">Player 1</span>  <b>' + pad(done0 ? fmtT10(t0) : 'gave up', 9) + '</b>' + (S.relay.hints[0] ? '  <i>' + S.relay.hints[0] + ' hint' + (S.relay.hints[0] > 1 ? 's' : '') + '</i>' : '') +
        '\n<span class="ws-p1">Player 2</span>  <b>' + pad(done1 ? fmtT10(t1) : 'gave up', 9) + '</b>' + (S.relay.hints[1] ? '  <i>' + S.relay.hints[1] + ' hint' + (S.relay.hints[1] > 1 ? 's' : '') + '</i>' : '') + '</pre>';
    } else {
      h += '<div class="ws-title">' + (g.done ? (g.mode === 'daily' ? 'DAILY SOLVED' : 'SOLVED') : 'REVEALED') + '</div>' +
        '<div class="ws-big">' + fmtT(finalTime(g)) + '</div>';
      if (g.done && out && out.newBest) h += '<div class="ws-new">★ NEW BEST · ' + LEVELS[g.pz.level].name.toUpperCase() + '</div>';
      st = g.nFound + '/' + g.pz.words.length + ' words' + (g.nHints ? ' · ' + g.nHints + ' hint' + (g.nHints > 1 ? 's' : '') + ' (+' + fmtT(g.penalty) + ')' : ' · no hints') + (g.misses ? ' · ' + g.misses + ' miss' + (g.misses > 1 ? 'es' : '') : '');
      h += '<div class="ws-sub">' + st + '</div>';
      if (g.done && out && out.best && !out.newBest) h += '<div class="ws-note">Best ' + LEVELS[g.pz.level].name + ': ' + fmtT(out.best) + '</div>';
      if (g.mode === 'daily' && g.done) {
        var sk = streak(S.save.daily, today());
        h += '<div class="ws-note">Daily streak: ' + sk + (sk === 1 ? ' day' : ' days') + ' · a new puzzle tomorrow</div>';
      }
    }
    h += '<div class="ws-btns"><button type="button" class="ws-go" data-act="again">' + (g.mode === 'daily' ? 'Random puzzle' : 'New puzzle') + '</button>' +
      '<button type="button" class="ws-go alt" data-act="view">View grid</button></div>' +
      '<button type="button" class="ws-go alt" data-act="menu">Menu</button></div>';
    return h;
  }
  function pad(s, n) { while (s.length < n) s = ' ' + s; return s; }
  function countBy(g, who) { var n = 0; for (var i = 0; i < g.found.length; i++) if (g.found[i] && g.found[i].by === who) n++; return n; }
  function reveal() {
    var g = S.g;
    S.paused = false;
    if (g.mode === 'solo' || g.mode === 'daily') { clearResume(); }
    if (g.mode === 'relay' && S.relay.p === 0) {
      // Player 1 gave up: player 2 still plays, and wins by finishing.
      S.relay.times[0] = 359999; S.relay.hints[0] = g.nHints;
      S.g = newGame(g.pz, { mode: 'relay' }); S.relay.p = 1;
      renderMarks(); renderList();
      pass(1, false);
      return;
    }
    finish();
  }

  // ---------------- saves of a game in progress ----------------
  function saveProgress() {
    if (!S || !S.g) return;
    var g = S.g;
    if ((g.mode !== 'solo' && g.mode !== 'daily') || g.done || S.phase === 'done') return;
    if (!g.nFound && g.t < 5) return;
    sset(GAME_KEY, JSON.stringify(packGame(g, { day: g.day })));
  }
  function clearResume() { sdel(GAME_KEY); if (S) S.resume = null; }
  function loadResume() {
    var raw = sget(GAME_KEY);
    if (!raw) return null;
    try { return unpackGame(JSON.parse(raw)); } catch (e) { return null; }
  }

  // ---------------- home ----------------
  function toHome() {
    stopLoop();
    if (S.g && S.phase === 'play') saveProgress();
    S.resume = loadResume();
    S.phase = 'home'; S.paused = false; S.g = null; S.resetArm = false; S.revealed = false;
    showOvl(null);
    S.play.style.display = 'none';
    S.home.style.display = '';
    renderHome();
    syncHead();
    layout();
  }
  function renderHome(help) {
    var st = S.home.scrollTop;
    S.home.innerHTML = help ? helpHtml() : homeHtml();
    S.homeHelp = !!help;
    S.home.scrollTop = help ? 0 : st;
    var ta = S.home.querySelector('.ws-ta');
    if (ta) {
      ta.addEventListener('input', function () {
        S.custom = ta.value.slice(0, 4000);
        sset(LIST_KEY, S.custom);
        var cl = S.home.querySelector('.ws-cl');
        if (cl) cl.innerHTML = listInfo(parseList(S.custom));
      });
    }
  }

  // ---------------- layout ----------------
  function layout() {
    if (!S) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    var N = S.g ? S.g.pz.size : LEVELS[S.save.prefs.level].size;
    var side = !phone && vw >= 680, LIST_W = 168;
    var availW = phone ? vw - 36 : Math.min(vw - 60, solo ? 1100 : 860);
    var top = Math.max(0, Math.min(S.panel.getBoundingClientRect().top || 50, 140));
    var availH = vh - top - (phone ? 150 : 170);
    var maxGrid = side ? availW - LIST_W - 14 : availW;
    var cs = Math.floor(Math.min(maxGrid / N, (phone ? Math.max(availH - 90, maxGrid) : availH) / N, phone ? 46 : solo ? 52 : 40));
    cs = clamp(cs, 18, 52);
    S.cs = cs;
    var gw = cs * N;
    S.root.classList.toggle('side', side);
    S.root.classList.toggle('phone', phone);
    var rootW = phone ? vw - 36 : side ? Math.max(gw + LIST_W + 14, 520) : Math.max(gw, 400);
    S.root.style.width = phone ? '' : rootW + 'px';
    S.root.style.setProperty('--cs', cs + 'px');
    S.stage.style.width = gw + 'px'; S.stage.style.height = gw + 'px';
    S.list.style.maxHeight = side ? gw + 'px' : '';
    S.home.style.maxHeight = Math.max(260, vh - top - 70) + 'px';
    if (S.g) renderMarks();
  }

  // ---------------- input ----------------
  function cellFromPoint(x, y) {
    var r = S.grid.getBoundingClientRect(), N = S.g.pz.size, cs = r.width / N;
    var fx = (x - r.left) / cs, fy = (y - r.top) / cs;
    return { fx: fx, fy: fy, r: clamp(Math.floor(fy), 0, N - 1), c: clamp(Math.floor(fx), 0, N - 1), inside: fx >= 0 && fy >= 0 && fx < N && fy < N };
  }
  function canPlay() { return S && S.g && S.phase === 'play' && !S.paused && !S.ovlOn; }
  function onDown(e) {
    if (!canPlay() || e.button > 0) return;
    e.preventDefault();
    S.snd.ensure();
    var p = cellFromPoint(e.clientX, e.clientY);
    if (!p.inside) return;
    try { S.grid.setPointerCapture(e.pointerId); } catch (x) {}
    S.kbd = false;
    var N = S.g.pz.size, i = p.r * N + p.c;
    S.drag = { id: e.pointerId, r0: p.r, c0: p.c, start: i, moved: false, anchor: S.anchor };
    if (S.anchor < 0) { S.sel = [i]; S.selBad = false; renderMarks(); }
  }
  function onMove(e) {
    if (!S || !S.drag || S.drag.id !== e.pointerId || !canPlay()) return;
    var d = S.drag, N = S.g.pz.size, p = cellFromPoint(e.clientX, e.clientY);
    var dx = p.fx - (d.c0 + 0.5), dy = p.fy - (d.r0 + 0.5);
    if (!d.moved && dx * dx + dy * dy < 0.5) return;
    d.moved = true;
    var a = d.start;
    var sn = snap(N, Math.floor(a / N), a % N, p.fy, p.fx), cells = lineCells(N, sn.r0, sn.c0, sn.r1, sn.c1);
    if (cells && (!S.sel || cells.join() !== S.sel.join())) {
      S.sel = cells; S.selBad = false; S.anchor = -1;
      if (cells.length > 1 && (!S.lastN || S.lastN !== cells.length)) sfx('tick');
      S.lastN = cells.length;
      renderMarks();
    }
  }
  function onUp(e) {
    if (!S || !S.drag || S.drag.id !== e.pointerId) return;
    var d = S.drag;
    S.drag = null; S.lastN = 0;
    if (!canPlay()) return;
    if (d.moved) { trySubmit(S.sel); return; }
    // a tap: first letter, then last letter
    if (d.anchor < 0) { S.anchor = d.start; S.sel = [d.start]; renderMarks(); return; }
    if (d.anchor === d.start) { S.anchor = -1; S.sel = null; renderMarks(); return; }
    var N = S.g.pz.size, cells = lineCells(N, Math.floor(d.anchor / N), d.anchor % N, d.r0, d.c0);
    S.anchor = -1;
    if (!cells) { S.anchor = d.start; S.sel = [d.start]; renderMarks(); return; }
    trySubmit(cells);
  }
  function onCancel(e) { if (S && S.drag && S.drag.id === e.pointerId) { S.drag = null; S.sel = null; renderMarks(); } }

  function keyAct(k) {
    var g = S.g, N = g.pz.size;
    if (S.cur < 0) S.cur = S.anchor >= 0 ? S.anchor : Math.floor(N / 2) * N + Math.floor(N / 2);
    var r = Math.floor(S.cur / N), c = S.cur % N;
    if (k === 'ArrowUp') r--; else if (k === 'ArrowDown') r++; else if (k === 'ArrowLeft') c--; else if (k === 'ArrowRight') c++;
    S.cur = clamp(r, 0, N - 1) * N + clamp(c, 0, N - 1);
    S.kbd = true;
    if (S.anchor >= 0) {
      var cells = lineCells(N, Math.floor(S.anchor / N), S.anchor % N, Math.floor(S.cur / N), S.cur % N);
      S.sel = cells || [S.anchor];
    }
    renderMarks();
  }
  function keyMark() {
    var g = S.g, N = g.pz.size;
    S.kbd = true;
    if (S.cur < 0) { keyAct(''); return; }
    if (S.anchor < 0) { S.anchor = S.cur; S.sel = [S.cur]; renderMarks(); say('Start at ' + g.pz.grid.charAt(S.cur) + '. Move to the last letter and press Enter.'); return; }
    var cells = lineCells(N, Math.floor(S.anchor / N), S.anchor % N, Math.floor(S.cur / N), S.cur % N);
    S.anchor = -1;
    if (!cells || cells.length < 2) { S.sel = null; renderMarks(); return; }
    trySubmit(cells);
  }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    // only while the panel is "ours": focus inside it, or nothing focused (body)
    var inside = S.panel.contains(t) || t === document.body || !t;
    if (!inside) return;
    var k = e.key;
    if (S.phase === 'home') {
      if (k === 'Enter' && !(t && t.tagName === 'BUTTON' && S.panel.contains(t))) { e.preventDefault(); if (S.homeHelp) renderHome(); else startFromPrefs(); }
      else if (k === 'Escape') { e.preventDefault(); if (S.homeHelp) renderHome(); else closePanel(); }
      return;
    }
    if (S.phase === 'pass') {
      if (k === 'Enter' || k === ' ') { if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return; e.preventDefault(); ready(); }
      else if (k === 'Escape') { e.preventDefault(); toHome(); }
      return;
    }
    if (S.phase === 'done') {
      if (k === 'Escape') { e.preventDefault(); toHome(); }
      return;
    }
    if (S.paused) {
      if (k === 'p' || k === 'P' || ((k === 'Enter' || k === ' ') && !(t && t.tagName === 'BUTTON' && S.panel.contains(t)))) { e.preventDefault(); resume(); }
      else if (k === 'Escape') { e.preventDefault(); toHome(); }
      return;
    }
    if (k === 'p' || k === 'P') { e.preventDefault(); pause(); }
    else if (k === 'h' || k === 'H') { e.preventDefault(); doHint(); }
    else if (k === 'Escape') { e.preventDefault(); if (S.anchor >= 0 || S.sel) clearSel(); else pause(); }
    else if (/^Arrow/.test(k)) { e.preventDefault(); keyAct(k); }
    else if (k === 'Enter' || k === ' ') { if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return; e.preventDefault(); keyMark(); }
  }

  // ---------------- open / close ----------------
  function teardown() {
    if (!S) return;
    saveProgress();
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    s.snd.close();
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }
  function open() {
    try { Cade.closeAllMenus(); } catch (e) {}
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="ws">' +
      '<div class="ws-home"></div>' +
      '<div class="ws-play" style="display:none"><div class="ws-hud"></div><div class="ws-main">' +
      '<div class="ws-stage"><svg class="ws-svg" aria-hidden="true"></svg><div class="ws-grid" role="grid" aria-label="Letter grid"></div><div class="ws-fx"></div><div class="ws-ovl" style="display:none"></div></div>' +
      '<ul class="ws-list" aria-label="Words to find"></ul></div><div class="ws-pad"></div></div>' +
      '<div class="ws-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🔎 Word Search', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'ws-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, root: p.querySelector('.ws'), home: p.querySelector('.ws-home'), play: p.querySelector('.ws-play'),
      hud: p.querySelector('.ws-hud'), stage: p.querySelector('.ws-stage'), svg: p.querySelector('.ws-svg'), grid: p.querySelector('.ws-grid'),
      fx: p.querySelector('.ws-fx'), ovl: p.querySelector('.ws-ovl'), list: p.querySelector('.ws-list'), pad: p.querySelector('.ws-pad'), liveEl: p.querySelector('.ws-live'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) === '1'), custom: sget(LIST_KEY) || '',
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'home', g: null, paused: false, raf: 0, last: 0, cs: 30, cells: [], sel: null, selBad: false, drag: null, anchor: -1, cur: -1, kbd: false,
      fresh: -1, revealed: false, resume: null, resetArm: false, ovlOn: false, relay: null, homeHelp: false
    };
    p._onClose = teardown;

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) pause(); };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) { pause(); stopLoop(); } });
    p.addEventListener('cade-panel-restore', function () { if (S && S.panel === p) requestAnimationFrame(function () { if (S && S.panel === p) layout(); }); });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) layout(); }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);

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
        if (S.phase === 'home') renderHome(!S.homeHelp);
        else {
          if (S.phase === 'play' && !S.paused) pause();
          if (S.paused || S.phase === 'done' || S.phase === 'pass') {
            S.helpBack = S.ovl.innerHTML;
            showOvl(helpHtml());
          }
        }
      }
      try { b.blur(); } catch (er) {}
    });

    // Fast taps must never zoom, select, magnify or open a callout.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.grid.addEventListener('touchstart', noTouch, { passive: false });
    S.grid.addEventListener('touchmove', noTouch, { passive: false });
    S.grid.addEventListener('touchend', noTouch, { passive: false });
    S.pad.addEventListener('touchend', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (b && e.cancelable) { e.preventDefault(); b.click(); }
    }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    S.grid.addEventListener('pointerdown', onDown);
    S.grid.addEventListener('pointermove', onMove);
    S.grid.addEventListener('pointerup', onUp);
    S.grid.addEventListener('pointercancel', onCancel);
    S.grid.addEventListener('lostpointercapture', function (e) { if (S && S.drag && S.drag.id === e.pointerId) onUp(e); });
    S.grid.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    function act(a, b) {
      if (!S) return;
      S.snd.ensure();
      if (a === 'play') startFromPrefs();
      else if (a === 'daily') startDaily();
      else if (a === 'continue') resumeSaved();
      else if (a === 'close-help') { if (S.phase === 'home') renderHome(); else showOvl(S.helpBack || null); }
      else if (a === 'reset') { S.resetArm = true; renderHome(); }
      else if (a === 'reset-no') { S.resetArm = false; renderHome(); }
      else if (a === 'reset-yes') {
        var pr = S.save.prefs;
        S.save = newSave(); S.save.prefs = pr; S.resetArm = false;
        persist(); toast('Records reset'); renderHome();
      } else if (a === 'resume') resume();
      else if (a === 'menu') toHome();
      else if (a === 'reveal') reveal();
      else if (a === 'ready') ready();
      else if (a === 'hint') doHint();
      else if (a === 'pause') pause();
      else if (a === 'again') {
        var g = S.g, mode = g ? g.mode : 'solo';
        if (mode === 'daily') { S.save.prefs.mode = 'solo'; persist(); }
        startFromPrefs();
      } else if (a === 'view') { showOvl(null); syncPad(); }
      else if (a === 'results') { showOvl(S.results); syncPad(); }
    }
    p.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S || !S.root.contains(b)) return;
      var a = b.getAttribute('data-act'), pr = S.save.prefs, v;
      if (a) { act(a, b); return; }
      if ((v = b.getAttribute('data-mode'))) pr.mode = v;
      else if ((v = b.getAttribute('data-cpu'))) pr.cpu = v;
      else if ((v = b.getAttribute('data-p2'))) pr.p2 = v;
      else if ((v = b.getAttribute('data-src'))) pr.src = v;
      else if ((v = b.getAttribute('data-theme-id'))) pr.theme = v;
      else if ((v = b.getAttribute('data-level'))) pr.level = v;
      else return;
      persist();
      sfx('tick');
      var sel = '[' + ['data-mode', 'data-cpu', 'data-p2', 'data-src', 'data-theme-id', 'data-level'].filter(function (x) { return b.hasAttribute(x); })[0] + '="' + v + '"]';
      renderHome();
      layout();
      var nb = e.detail === 0 && S.home.querySelector(sel);
      if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
      if (pr.src === 'custom' && b.hasAttribute('data-src')) { var ta = S.home.querySelector('.ws-ta'); if (ta && !S.coarse) ta.focus(); }
    });

    S.resume = loadResume();
    renderHome(S.firstRun);
    if (S.firstRun) persist();
    syncHead();
    layout();
    loadData().then(function () { if (S && S.panel === p && S.phase === 'home') renderHome(S.homeHelp); },
      function () { toast('Could not load the word packs', 'error'); });
    requestAnimationFrame(function () { if (S && S.panel === p) layout(); });
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Find hidden words in a letter grid — 32 themed packs, words from your note or your own list; daily puzzle, vs CPU, 2 players',
    icon: '🔎',
    tags: 'game,puzzle,word,search,find,grid,note,daily,hidden words,wordsearch,vs cpu,2 player,themes',
    open: open,
    _engine: ENGINE
  });
})();
