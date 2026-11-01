/* Letter Tiles — a crossword tile game for Cade.txt.
 * Draw seven letter tiles, lay words across or down on a 15x15 board so they
 * cross what's already there, and score the letters of every word you make.
 * The board has its own premium layout (2L / 3L letter squares, 2W / 3W word
 * squares), a 50 point BINGO for playing all seven tiles, two blanks, swaps
 * and passes. Words are checked as you lay them against a bundled offline
 * dictionary (lettertiles-words.js, ~270k words from word-list@4.1.0, MIT),
 * so there are no challenges: a play is either valid or it isn't.
 * Play against 1-3 CPUs (easy: any valid move; medium: a decent one; hard:
 * a full anchor / cross-check search for the best score plus a rack-leave
 * heuristic — run a board line at a time so the UI never stalls) or pass and
 * play with 2-4 people on one device, with a privacy screen hiding the racks.
 * Drag tiles (mouse or touch), tap a tile then a square, tap a square then
 * tiles, or click a square and type on a keyboard. The game in progress and
 * records persist in Cade.store (cade-lettertiles-*). */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var N = 15, NN = N * N, CENTER = 112, RACK = 7, BINGO = 50, ALL = (1 << 26) - 1, BLANK = 26;
  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  // Our own bag: [count, value] per letter, 100 tiles with the two blanks.
  var TILESET = {
    A: [9, 1], B: [2, 3], C: [2, 3], D: [4, 2], E: [12, 1], F: [2, 4], G: [3, 3], H: [3, 3], I: [8, 1], J: [1, 8],
    K: [1, 5], L: [4, 1], M: [2, 3], N: [6, 1], O: [7, 1], P: [2, 3], Q: [1, 10], R: [6, 1], S: [5, 1], T: [6, 1],
    U: [4, 2], V: [2, 5], W: [2, 4], X: [1, 8], Y: [2, 3], Z: [1, 9], '?': [2, 0]
  };
  var VAL = [];
  for (var li = 0; li < 26; li++) VAL.push(TILESET[LETTERS.charAt(li)][1]);
  var TOTAL = 0;
  Object.keys(TILESET).forEach(function (k) { TOTAL += TILESET[k][0]; });

  // Premium squares: one octant (row <= col <= 7), mirrored eight ways. An
  // original layout: triple-letter corners, triple words off the corners,
  // a ring of double words around the start and down the middle lines.
  var OCTANT = { '0,0': 'tl', '0,4': 'tw', '1,3': 'dl', '1,5': 'tl', '1,7': 'dw', '2,2': 'dw', '2,6': 'dl', '3,3': 'tl', '3,7': 'dl', '4,5': 'dl', '5,5': 'dw', '6,6': 'dl', '7,7': 'dw' };
  var PREM = [], LMUL = new Int8Array(NN), WMUL = new Int8Array(NN);
  (function () {
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
      var a = Math.min(r, N - 1 - r), b = Math.min(c, N - 1 - c);
      if (a > b) { var t = a; a = b; b = t; }
      var p = OCTANT[a + ',' + b] || '', i = r * N + c;
      PREM.push(p);
      LMUL[i] = p === 'dl' ? 2 : p === 'tl' ? 3 : 1;
      WMUL[i] = p === 'dw' ? 2 : p === 'tw' ? 3 : 1;
    }
  })();

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // A game's random stream lives in the save (g.rs), so a resumed game draws the same tiles.
  function rand(g) {
    g.rs = (g.rs + 0x6D2B79F5) | 0;
    var t = Math.imul(g.rs ^ (g.rs >>> 15), 1 | g.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function popcnt(x) { x = x - ((x >>> 1) & 0x55555555); x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }

  function code(ch) { var k = ch.charCodeAt(0); return k >= 97 ? k - 97 : k - 65; }
  function isBlankCh(ch) { var k = ch.charCodeAt(0); return k >= 97 && k <= 122; }
  function tileVal(ch) { return !ch || ch === '?' || isBlankCh(ch) ? 0 : VAL[code(ch)]; }

  // ---- the dictionary: a trie in typed arrays ----
  // Node 0 is the root. Each node has a 26-bit mask of its children's letters,
  // its first child and next sibling (children in letter order) and a word-end flag.
  function dictBuilder(D) {
    var parts = D.p, cap = 2;
    for (var q = 0; q < parts.length; q++) cap += parts[q].length;
    var d = { mask: new Int32Array(cap), first: new Int32Array(cap), next: new Int32Array(cap), ch: new Uint8Array(cap), term: new Uint8Array(cap), n: 1, words: 0 };
    d.first[0] = -1; d.next[0] = -1;
    var path = new Int32Array(17), part = 0, pos = 0, word = new Uint8Array(16);
    function addWord(k, len) {
      var j = k, node = path[k];
      for (; j < len; j++) {
        var c = word[j], e = child(d, node, c);
        if (e >= 0) { node = e; path[j + 1] = e; continue; }
        e = d.n++;
        d.ch[e] = c; d.first[e] = -1; d.next[e] = -1;
        if (d.mask[node] === 0) d.first[node] = e;
        else { var s = d.first[node]; while (d.next[s] >= 0) s = d.next[s]; d.next[s] = e; }
        d.mask[node] |= 1 << c;
        node = e; path[j + 1] = e;
      }
      d.term[node] = 1;
      d.words++;
    }
    return {
      dict: d, done: false,
      // Decode up to `max` words; true once the whole list is in.
      step: function (max) {
        var n = 0;
        while (part < parts.length && n < max) {
          var s = parts[part];
          if (pos >= s.length) { part++; pos = 0; continue; }
          var k = s.charCodeAt(pos++) - 48, len = k;
          while (pos < s.length) { var cc = s.charCodeAt(pos); if (cc < 97) break; word[len++] = cc - 97; pos++; }
          path[0] = 0;
          addWord(Math.min(k, len), len);
          n++;
        }
        if (part >= parts.length) this.done = true;
        return this.done;
      }
    };
  }
  function buildDict(D) { var b = dictBuilder(D); while (!b.step(1e9)); return b.dict; }
  // A dictionary from a plain word array (tests).
  function dictFrom(words) {
    var list = words.map(function (w) { return String(w).toLowerCase(); }).filter(function (w) { return /^[a-z]{2,15}$/.test(w); }).sort();
    var by = {}, prev = {};
    list.forEach(function (w) {
      var f = w.charAt(0), p = prev[f] || '', k = 0;
      if (w === p) return;
      while (k < 9 && k < p.length && p.charAt(k) === w.charAt(k)) k++;
      by[f] = (by[f] || '') + k + w.slice(k);
      prev[f] = w;
    });
    return buildDict({ p: Object.keys(by).sort().map(function (k) { return by[k]; }) });
  }
  function child(d, node, c) {
    if (!((d.mask[node] >>> c) & 1)) return -1;
    for (var e = d.first[node]; e >= 0; e = d.next[e]) if (d.ch[e] === c) return e;
    return -1;
  }
  function walk(d, node, s) {
    for (var i = 0; i < s.length && node >= 0; i++) node = child(d, node, code(s.charAt(i)));
    return node;
  }
  function hasWord(d, w) { var n = walk(d, 0, String(w)); return n >= 0 && d.term[n] === 1; }

  // ---- game state ----
  // board: 225 strings — '' empty, 'A'..'Z' a tile, 'a'..'z' a blank played as that letter.
  // racks: arrays of 'A'..'Z' / '?'. Everything is plain JSON (the save is the state).
  function newBag() {
    var bag = [];
    Object.keys(TILESET).forEach(function (k) { for (var i = 0; i < TILESET[k][0]; i++) bag.push(k); });
    return bag;
  }
  function draw(g, rack) {
    while (rack.length < RACK && g.bag.length) {
      var i = Math.floor(rand(g) * g.bag.length);
      rack.push(g.bag[i]);
      g.bag[i] = g.bag[g.bag.length - 1];
      g.bag.pop();
    }
  }
  function cleanName(s, d) { s = String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14); return s || d; }
  function newGame(opts) {
    opts = opts || {};
    var ps = (opts.players && opts.players.length ? opts.players : [{ name: 'You', cpu: 0 }, { name: 'CPU', cpu: 2 }]).slice(0, 4);
    if (ps.length < 2) ps.push({ name: 'CPU', cpu: 2 });
    var g = {
      v: 1, rs: (opts.seed >>> 0) || 1, board: [], bag: newBag(), turn: 0, moves: 0, scoreless: 0, over: false,
      players: ps.map(function (p, i) {
        var cpu = Math.max(0, Math.min(3, p.cpu | 0));
        return { name: cleanName(p.name, cpu ? 'CPU' : 'Player ' + (i + 1)), cpu: cpu, score: 0, rack: [], bingos: 0, best: 0, bestW: '' };
      }),
      log: [], last: [], result: null, started: opts.now || 0
    };
    for (var i = 0; i < NN; i++) g.board.push('');
    // the first player is random (from the seed), so CPUs open some games
    g.turn = Math.floor(rand(g) * g.players.length);
    g.players.forEach(function (p) { draw(g, p.rack); });
    return g;
  }
  function boardEmpty(board) { for (var i = 0; i < NN; i++) if (board[i]) return false; return true; }
  function tilesLeft(g) { var n = g.bag.length; g.players.forEach(function (p) { n += p.rack.length; }); return n; }

  // Every word a placement makes, scored. pl: [{ i, ch }] (ch 'A'..'Z', or 'a'..'z' for a blank).
  // Returns { ok, err, words: [{ w, sc, ok, cells }], score, bingo, dir, tiles }.
  function evalPlay(board, dict, pl) {
    var res = { ok: false, err: '', words: [], score: 0, bingo: false, dir: 0, tiles: pl ? pl.length : 0 };
    if (!pl || !pl.length) { res.err = 'Place some tiles'; return res; }
    var at = {}, i, k;
    for (k = 0; k < pl.length; k++) {
      var p = pl[k];
      if (!(p.i >= 0 && p.i < NN) || p.i !== Math.floor(p.i)) { res.err = 'Off the board'; return res; }
      if (board[p.i] || at[p.i]) { res.err = 'That square is taken'; return res; }
      if (!/^[A-Za-z]$/.test(p.ch || '')) { res.err = 'Pick a letter for the blank'; return res; }
      at[p.i] = p.ch;
    }
    function get(r, c) { if (r < 0 || c < 0 || r >= N || c >= N) return ''; var j = r * N + c; return at[j] || board[j] || ''; }
    var r0 = Math.floor(pl[0].i / N), c0 = pl[0].i % N, sameR = true, sameC = true;
    for (k = 1; k < pl.length; k++) {
      if (Math.floor(pl[k].i / N) !== r0) sameR = false;
      if (pl[k].i % N !== c0) sameC = false;
    }
    if (!sameR && !sameC) { res.err = 'Tiles must be in one row or column'; return res; }
    var dir;   // 0 across, 1 down
    if (pl.length > 1) dir = sameR ? 0 : 1;
    else dir = (get(r0, c0 - 1) || get(r0, c0 + 1)) ? 0 : 1;
    res.dir = dir;
    var dr = dir ? 1 : 0, dc = dir ? 0 : 1;
    // contiguous between the first and last placed tile
    var lo = Infinity, hi = -Infinity;
    pl.forEach(function (q) { var v = dir ? Math.floor(q.i / N) : q.i % N; if (v < lo) lo = v; if (v > hi) hi = v; });
    for (k = lo; k <= hi; k++) if (!(dir ? get(k, c0) : get(r0, k))) { res.err = 'Leave no gaps in a word'; return res; }
    var first = boardEmpty(board);
    if (first) {
      if (!at[CENTER]) { res.err = 'The first word must cover the centre *'; return res; }
      if (pl.length < 2) { res.err = 'The first word needs at least two letters'; return res; }
    }
    function wordAt(r, c, wdr, wdc) {
      while (get(r - wdr, c - wdc)) { r -= wdr; c -= wdc; }
      var w = '', sum = 0, wm = 1, cells = [], newT = 0;
      while (get(r, c)) {
        var j = r * N + c, ch = get(r, c), v = tileVal(ch);
        if (at[j]) { v *= LMUL[j]; wm *= WMUL[j]; newT++; }
        sum += v; w += ch.toUpperCase(); cells.push(j);
        r += wdr; c += wdc;
      }
      return { w: w, sc: sum * wm, cells: cells, n: newT };
    }
    var main = wordAt(r0, c0, dr, dc), touches = main.cells.length > pl.length;
    if (main.w.length >= 2) res.words.push(main);
    pl.forEach(function (q) {
      var r = Math.floor(q.i / N), c = q.i % N, w = wordAt(r, c, dc, dr);
      if (w.w.length >= 2) { res.words.push(w); touches = true; }
    });
    if (!res.words.length) { res.err = first ? 'Make a word of two or more letters' : 'Connect to the tiles on the board'; return res; }
    if (!first && !touches) { res.err = 'Connect to the tiles on the board'; return res; }
    var bad = [];
    res.words.forEach(function (w) { w.ok = hasWord(dict, w.w.toLowerCase()); if (!w.ok) bad.push(w.w); delete w.n; });
    res.bingo = pl.length === RACK;
    res.score = res.words.reduce(function (s, w) { return s + w.sc; }, 0) + (res.bingo ? BINGO : 0);
    if (bad.length) { res.err = (bad.length > 1 ? 'Not words: ' : 'Not a word: ') + bad.join(', '); return res; }
    res.ok = true;
    return res;
  }

  // ---- the move generator (Appel & Jacobson: anchors, cross-checks, a trie) ----
  // makeSearch(dict, board, rack) works a board line (a row or column) per
  // step(), so the UI can spread it over frames. Moves: { cells, chars, d, sc, word, n }.
  function makeSearch(dict, board, rack) {
    var cd = new Int8Array(NN), bl = new Uint8Array(NN), empty = true, i, d;
    for (i = 0; i < NN; i++) {
      var ch = board[i];
      if (ch) { cd[i] = code(ch); bl[i] = isBlankCh(ch) ? 1 : 0; empty = false; } else cd[i] = -1;
    }
    var rc = new Int32Array(27);
    for (i = 0; i < rack.length; i++) { if (rack[i] === '?') rc[BLANK]++; else rc[code(rack[i])]++; }
    var M = dict.mask, F = dict.first, X = dict.next, CH = dict.ch, T = dict.term;
    function occ(r, c) { return r >= 0 && c >= 0 && r < N && c < N && cd[r * N + c] >= 0; }
    // cross-checks: cm[d][i] = letters allowed at i when the main word runs in d; cs = the perpendicular word's tile sum
    var cm = [new Int32Array(NN), new Int32Array(NN)], cs = [new Int32Array(NN), new Int32Array(NN)], hc = [new Uint8Array(NN), new Uint8Array(NN)];
    var anchor = new Uint8Array(NN);
    for (i = 0; i < NN; i++) {
      if (cd[i] >= 0) continue;
      var r = Math.floor(i / N), c = i % N;
      if (occ(r - 1, c) || occ(r + 1, c) || occ(r, c - 1) || occ(r, c + 1)) anchor[i] = 1;
      for (d = 0; d < 2; d++) {
        var pr = d ? 0 : 1, pc = d ? 1 : 0;          // the perpendicular step
        if (!occ(r - pr, c - pc) && !occ(r + pr, c + pc)) { cm[d][i] = ALL; continue; }
        hc[d][i] = 1;
        var sr = r, sc0 = c, sum = 0, node = 0;
        while (occ(sr - pr, sc0 - pc)) { sr -= pr; sc0 -= pc; }
        for (; sr !== r || sc0 !== c; sr += pr, sc0 += pc) {
          var j = sr * N + sc0;
          if (!bl[j]) sum += VAL[cd[j]];
          if (node >= 0) node = child(dict, node, cd[j]);
        }
        var suf = [], tr = r + pr, tc = c + pc;
        while (occ(tr, tc)) { var j2 = tr * N + tc; suf.push(cd[j2]); if (!bl[j2]) sum += VAL[cd[j2]]; tr += pr; tc += pc; }
        cs[d][i] = sum;
        var mask = 0;
        if (node >= 0) {
          for (var e = F[node]; e >= 0; e = X[e]) {
            var n2 = e;
            for (var q = 0; q < suf.length && n2 >= 0; q++) n2 = child(dict, n2, suf[q]);
            if (n2 >= 0 && T[n2]) mask |= 1 << CH[e];
          }
        }
        cm[d][i] = mask;
      }
    }
    if (empty) anchor[CENTER] = 1;
    var tasks = [];
    for (d = 0; d < 2; d++) for (var L = 0; L < N; L++) {
      var any = false;
      for (var p0 = 0; p0 < N; p0++) if (anchor[d ? p0 * N + L : L * N + p0]) { any = true; break; }
      if (any) tasks.push(d * N + L);
    }
    var moves = [], seen = {};
    // line state
    var lcell = new Int32Array(N), lc = new Int8Array(N), lm = new Int32Array(N), plc = new Uint8Array(N), plt = new Int8Array(N), pbl = new Uint8Array(N);
    var D = 0, A = 0, leftL = new Int8Array(N), leftB = new Uint8Array(N), cmD = null, csD = null, hcD = null;
    function record(start, end) {
      var mainS = 0, wm = 1, cross = 0, n = 0, cells = [], chars = [], word = '';
      for (var p = start; p < end; p++) {
        var cell = lcell[p];
        if (plc[p]) {
          var v = pbl[p] ? 0 : VAL[plt[p]], lmul = LMUL[cell], wmul = WMUL[cell];
          mainS += v * lmul; wm *= wmul; n++;
          if (hcD[cell]) cross += (csD[cell] + v * lmul) * wmul;
          cells.push(cell); chars.push(pbl[p] ? LETTERS.charAt(plt[p]).toLowerCase() : LETTERS.charAt(plt[p]));
          word += LETTERS.charAt(plt[p]);
        } else {
          if (!bl[cell]) mainS += VAL[lc[p]];
          word += LETTERS.charAt(lc[p]);
        }
      }
      if (n === 1) {                                     // a lone tile can read both ways: keep it once
        var key = cells[0] * 64 + chars[0].charCodeAt(0);
        if (seen[key]) return;
        seen[key] = 1;
      }
      moves.push({ cells: cells, chars: chars, d: D, sc: mainS * wm + cross + (n === RACK ? BINGO : 0), word: word, n: n });
    }
    function extend(node, pos, start) {
      if (pos >= N) { if (pos > A && T[node]) record(start, pos); return; }
      if (lc[pos] >= 0) {
        var e0 = child(dict, node, lc[pos]);
        if (e0 >= 0) extend(e0, pos + 1, start);
        return;
      }
      if (pos > A && T[node]) record(start, pos);
      var allow = M[node] & lm[pos];
      if (!allow) return;
      for (var e = F[node]; e >= 0; e = X[e]) {
        var c = CH[e];
        if (!((allow >>> c) & 1)) continue;
        plc[pos] = 1; plt[pos] = c;
        if (rc[c] > 0) { rc[c]--; pbl[pos] = 0; extend(e, pos + 1, start); rc[c]++; }
        if (rc[BLANK] > 0) { rc[BLANK]--; pbl[pos] = 1; extend(e, pos + 1, start); rc[BLANK]++; }
        plc[pos] = 0;
      }
    }
    function left(node, len, limit) {
      var s = A - len, k;
      for (k = 0; k < len; k++) { plc[s + k] = 1; plt[s + k] = leftL[k]; pbl[s + k] = leftB[k]; }
      extend(node, A, s);
      for (k = 0; k < len; k++) plc[s + k] = 0;
      if (len >= limit) return;
      for (var e = F[node]; e >= 0; e = X[e]) {
        var c = CH[e];
        leftL[len] = c;
        if (rc[c] > 0) { rc[c]--; leftB[len] = 0; left(e, len + 1, limit); rc[c]++; }
        if (rc[BLANK] > 0) { rc[BLANK]--; leftB[len] = 1; left(e, len + 1, limit); rc[BLANK]++; }
      }
    }
    function line(t) {
      D = t >= N ? 1 : 0;
      var L = t % N, p;
      cmD = cm[D]; csD = cs[D]; hcD = hc[D];
      for (p = 0; p < N; p++) {
        var cell = D ? p * N + L : L * N + p;
        lcell[p] = cell; lc[p] = cd[cell]; lm[p] = cmD[cell]; plc[p] = 0;
      }
      for (A = 0; A < N; A++) {
        if (!anchor[lcell[A]]) continue;
        if (A > 0 && lc[A - 1] >= 0) {                  // tiles to the left are the left part
          var s = A - 1;
          while (s > 0 && lc[s - 1] >= 0) s--;
          var node = 0;
          for (p = s; p < A && node >= 0; p++) node = child(dict, node, lc[p]);
          if (node >= 0) extend(node, A, s);
        } else {
          var limit = 0;
          for (p = A - 1; p >= 0 && lc[p] < 0 && !anchor[lcell[p]]; p--) limit++;
          left(0, 0, Math.min(limit, rack.length - 1));
        }
      }
    }
    var S = {
      moves: moves, done: !tasks.length, lines: tasks.length, at: 0,
      step: function () {
        if (S.at < tasks.length) line(tasks[S.at++]);
        if (S.at >= tasks.length) S.done = true;
        return S.done;
      }
    };
    return S;
  }
  function genMoves(dict, board, rack) { var s = makeSearch(dict, board, rack); while (!s.step()); return s.moves; }

  // ---- the CPU ----
  var LEAVE = { '?': 16, S: 7, E: 3, R: 2, X: 2, Z: 1, A: 1, T: 1, N: 1, L: 1, H: 1, D: 0.5, I: 0, C: 0, M: 0, P: 0, O: -0.5, Y: -1, G: -2, B: -2, F: -2, K: -2, U: -3, W: -3, J: -3, V: -5, Q: -8 };
  function isVowel(ch) { return 'AEIOU'.indexOf(ch) >= 0; }
  // How good the tiles kept after a move are (heuristic; hard CPU).
  function leaveValue(leave, bagN) {
    if (!leave.length) return bagN ? 4 : 0;
    if (!bagN) { var stuck = 0; leave.forEach(function (ch) { stuck += tileVal(ch); }); return -2 * stuck; }
    var v = 0, seen = {}, vow = 0, cons = 0, hasU = false, hasQ = false;
    leave.forEach(function (ch) {
      v += LEAVE[ch] || 0;
      if (seen[ch]) v -= ch === '?' ? 6 : 3;
      seen[ch] = 1;
      if (ch === 'U') hasU = true;
      if (ch === 'Q') hasQ = true;
      if (ch !== '?') { if (isVowel(ch)) vow++; else cons++; }
    });
    if (hasQ && !hasU) v -= 4;
    var n = vow + cons;
    if (n) v -= 2.5 * Math.abs(vow - 0.42 * n);
    return v;
  }
  function leaveOf(rack, move) {
    var left = rack.slice();
    move.chars.forEach(function (ch) {
      var k = left.indexOf(isBlankCh(ch) ? '?' : ch);
      if (k >= 0) left.splice(k, 1);
    });
    return left;
  }
  // Picks the CPU's turn from its generated moves. level 1 easy, 2 medium, 3 hard.
  // Returns { type: 'play', move } | { type: 'swap', tiles } | { type: 'pass' }.
  function cpuDecide(moves, level, rack, bagN, rnd) {
    rnd = rnd || Math.random;
    var canSwap = bagN >= RACK;
    if (!moves.length) {
      if (!canSwap) return { type: 'pass' };
      return { type: 'swap', tiles: level >= 3 ? swapPick(rack).map(function (k) { return rack[k]; }) : rack.slice() };
    }
    if (level <= 1) {
      // any valid move, but shorter, plainer words are likelier
      var pool = moves.filter(function (m) { return m.n <= 4 && m.word.length <= 6; });
      if (!pool.length) pool = moves;
      return { type: 'play', move: pool[Math.floor(rnd() * pool.length)] };
    }
    if (level === 2) {
      var sorted = moves.slice().sort(function (a, b) { return b.sc - a.sc; }), top = sorted[0].sc;
      // something decent: a move scoring roughly half to three quarters of the best
      var band = sorted.filter(function (m) { return m.sc >= top * 0.45 && m.sc <= top * 0.8; });
      if (!band.length) band = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.3)));
      return { type: 'play', move: band[Math.floor(rnd() * band.length)] };
    }
    var best = null, bestV = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i], v = m.sc + leaveValue(leaveOf(rack, m), Math.max(0, bagN - m.n));
      if (v > bestV) { bestV = v; best = m; }
    }
    if (canSwap && best.sc < 10 && bestV < 6) {
      var sw = swapPick(rack);
      if (sw.length && leaveValue(rack.filter(function (ch, k) { return sw.indexOf(k) < 0; }), bagN) > bestV - best.sc + 4) return { type: 'swap', tiles: sw.map(function (k) { return rack[k]; }) };
    }
    return { type: 'play', move: best };
  }
  // Which tiles a hard CPU throws back (indices): all but a small good keep.
  function swapPick(rack) {
    var keep = {}, out = [];
    rack.forEach(function (ch, k) {
      var good = ch === '?' || ch === 'S' || ((ch === 'E' || ch === 'A' || ch === 'R' || ch === 'T' || ch === 'N' || ch === 'L') && !keep[ch]);
      if (good) keep[ch] = 1; else out.push(k);
    });
    if (!out.length) out = [0, 1, 2];
    return out;
  }

  // ---- turns ----
  function logPush(g, e) { g.log.push(e); if (g.log.length > 200) g.log.splice(0, g.log.length - 200); }
  function current(g) { return g.players[g.turn]; }
  function nextTurn(g) { g.turn = (g.turn + 1) % g.players.length; g.moves++; }
  // Plays tiles for the current player. Returns the evaluation (ok false: nothing changed).
  function play(g, dict, pl) {
    if (g.over) return { ok: false, err: 'The game is over' };
    var p = current(g), rack = p.rack.slice(), k;
    for (k = 0; k < pl.length; k++) {
      var need = isBlankCh(pl[k].ch) ? '?' : pl[k].ch, at = rack.indexOf(need);
      if (at < 0) return { ok: false, err: 'Those tiles are not on your rack' };
      rack.splice(at, 1);
    }
    var res = evalPlay(g.board, dict, pl);
    if (!res.ok) return res;
    pl.forEach(function (q) { g.board[q.i] = q.ch; });
    p.rack = rack;
    p.score += res.score;
    if (res.bingo) p.bingos++;
    var mainW = res.words[0].w;
    if (res.score > p.best) { p.best = res.score; p.bestW = mainW; }
    draw(g, p.rack);
    g.scoreless = 0;
    g.last = pl.map(function (q) { return q.i; });
    logPush(g, { p: g.turn, t: 'play', w: res.words.map(function (w) { return w.w; }), sc: res.score, b: res.bingo ? 1 : 0, cells: g.last.slice() });
    if (!p.rack.length && !g.bag.length) finish(g, g.turn);
    else nextTurn(g);
    return res;
  }
  function pass(g) {
    if (g.over) return false;
    g.scoreless++;
    logPush(g, { p: g.turn, t: 'pass' });
    g.last = [];
    if (g.scoreless >= 2 * g.players.length) finish(g, -1);
    else nextTurn(g);
    return true;
  }
  // Swap tiles (letters, '?' for a blank) back into the bag for new ones.
  function swap(g, tiles) {
    if (g.over || g.bag.length < RACK || !tiles || !tiles.length) return false;
    var p = current(g), rack = p.rack.slice();
    for (var k = 0; k < tiles.length; k++) { var at = rack.indexOf(tiles[k]); if (at < 0) return false; rack.splice(at, 1); }
    var drawn = 0;
    while (rack.length < RACK && g.bag.length) { var i = Math.floor(rand(g) * g.bag.length); rack.push(g.bag[i]); g.bag[i] = g.bag[g.bag.length - 1]; g.bag.pop(); drawn++; }
    tiles.forEach(function (t) { g.bag.push(t); });
    p.rack = rack;
    g.scoreless++;
    g.last = [];
    logPush(g, { p: g.turn, t: 'swap', n: tiles.length });
    if (g.scoreless >= 2 * g.players.length) finish(g, -1);
    else nextTurn(g);
    return true;
  }
  // End of game: unplayed tiles count against their owner; whoever went out gets them all.
  function finish(g, out) {
    g.over = true;
    var adj = g.players.map(function () { return 0; }), pool = 0;
    g.players.forEach(function (p, i) {
      var v = 0;
      p.rack.forEach(function (ch) { v += tileVal(ch); });
      if (i !== out) { adj[i] = -v; pool += v; }
    });
    if (out >= 0) adj[out] = pool;
    g.players.forEach(function (p, i) { p.score += adj[i]; });
    var top = Math.max.apply(null, g.players.map(function (p) { return p.score; }));
    var win = [];
    g.players.forEach(function (p, i) { if (p.score === top) win.push(i); });
    g.result = { out: out, adj: adj, win: win };
    logPush(g, { p: out, t: 'end', adj: adj });
  }

  // ---- saves ----
  function normGame(o) {
    if (!o || typeof o !== 'object' || o.v !== 1) return null;
    if (!Array.isArray(o.board) || o.board.length !== NN || !Array.isArray(o.players) || o.players.length < 2 || o.players.length > 4 || !Array.isArray(o.bag)) return null;
    var count = {}, i;
    function tally(ch) { count[ch] = (count[ch] || 0) + 1; }
    var g = { v: 1, rs: (o.rs | 0) || 1, board: [], bag: [], turn: 0, moves: Math.max(0, o.moves | 0), scoreless: Math.max(0, o.scoreless | 0), over: !!o.over, players: [], log: [], last: [], result: null, started: +o.started || 0 };
    for (i = 0; i < NN; i++) {
      var b = o.board[i];
      if (b === '' || b == null) { g.board.push(''); continue; }
      if (typeof b !== 'string' || !/^[A-Za-z]$/.test(b)) return null;
      g.board.push(b); tally(isBlankCh(b) ? '?' : b);
    }
    for (i = 0; i < o.bag.length; i++) { if (typeof o.bag[i] !== 'string' || !/^([A-Z]|\?)$/.test(o.bag[i])) return null; g.bag.push(o.bag[i]); tally(o.bag[i]); }
    for (i = 0; i < o.players.length; i++) {
      var p = o.players[i];
      if (!p || !Array.isArray(p.rack) || p.rack.length > RACK) return null;
      var q = { name: cleanName(p.name, 'Player ' + (i + 1)), cpu: Math.max(0, Math.min(3, p.cpu | 0)), score: +p.score || 0, rack: [], bingos: Math.max(0, p.bingos | 0), best: Math.max(0, +p.best || 0), bestW: typeof p.bestW === 'string' ? p.bestW.slice(0, 15) : '' };
      for (var k = 0; k < p.rack.length; k++) { if (typeof p.rack[k] !== 'string' || !/^([A-Z]|\?)$/.test(p.rack[k])) return null; q.rack.push(p.rack[k]); tally(p.rack[k]); }
      g.players.push(q);
    }
    // every tile accounted for
    var keys = Object.keys(TILESET);
    for (i = 0; i < keys.length; i++) if ((count[keys[i]] || 0) !== TILESET[keys[i]][0]) return null;
    g.turn = Math.max(0, Math.min(g.players.length - 1, o.turn | 0));
    if (Array.isArray(o.log)) o.log.slice(-200).forEach(function (e) {
      if (!e || typeof e !== 'object' || typeof e.t !== 'string') return;
      var x = { p: e.p | 0, t: e.t };
      if (Array.isArray(e.w)) x.w = e.w.filter(function (w) { return typeof w === 'string'; }).map(function (w) { return w.slice(0, 15); });
      if (e.sc != null) x.sc = +e.sc || 0;
      if (e.b) x.b = 1;
      if (e.n != null) x.n = e.n | 0;
      if (Array.isArray(e.cells)) x.cells = e.cells.filter(function (c) { return c >= 0 && c < NN; }).map(function (c) { return c | 0; });
      if (Array.isArray(e.adj)) x.adj = e.adj.map(function (a) { return +a || 0; });
      g.log.push(x);
    });
    if (Array.isArray(o.last)) g.last = o.last.filter(function (c) { return c >= 0 && c < NN && g.board[c]; }).map(function (c) { return c | 0; });
    if (g.over) {
      var r = o.result && typeof o.result === 'object' ? o.result : {};
      g.result = { out: r.out | 0, adj: Array.isArray(r.adj) ? r.adj.map(function (a) { return +a || 0; }) : g.players.map(function () { return 0; }), win: Array.isArray(r.win) ? r.win.map(function (a) { return a | 0; }) : [] };
    }
    return g;
  }
  function newRecords() { return { games: 0, cpu: { 1: { w: 0, l: 0, t: 0 }, 2: { w: 0, l: 0, t: 0 }, 3: { w: 0, l: 0, t: 0 } }, hi: 0, move: 0, moveW: '', bingos: 0, long: '' }; }
  function normRecords(o) {
    var r = newRecords();
    if (!o || typeof o !== 'object') return r;
    r.games = Math.max(0, o.games | 0);
    [1, 2, 3].forEach(function (k) {
      var s = o.cpu && o.cpu[k];
      if (s && typeof s === 'object') r.cpu[k] = { w: Math.max(0, s.w | 0), l: Math.max(0, s.l | 0), t: Math.max(0, s.t | 0) };
    });
    r.hi = Math.max(0, o.hi | 0); r.move = Math.max(0, o.move | 0); r.bingos = Math.max(0, o.bingos | 0);
    r.moveW = typeof o.moveW === 'string' ? o.moveW.slice(0, 15) : '';
    r.long = typeof o.long === 'string' && /^[A-Z]{0,15}$/.test(o.long) ? o.long : '';
    return r;
  }
  // Folds a finished game into the records (people's achievements only). Returns the new bests.
  function settle(rec, g) {
    var news = [], humans = [], cpus = [];
    g.players.forEach(function (p, i) { if (p.cpu) cpus.push(i); else humans.push(i); });
    if (!humans.length) return news;
    rec.games++;
    humans.forEach(function (i) {
      var p = g.players[i];
      if (p.score > rec.hi) { rec.hi = p.score; news.push('score'); }
      if (p.best > rec.move) { rec.move = p.best; rec.moveW = p.bestW; news.push('move'); }
      rec.bingos += p.bingos;
    });
    g.log.forEach(function (e) {
      if (e.t !== 'play' || !g.players[e.p] || g.players[e.p].cpu || !e.w) return;
      e.w.forEach(function (w) { if (w.length > rec.long.length) { rec.long = w; if (news.indexOf('word') < 0) news.push('word'); } });
    });
    // vs CPU: the best person against the toughest CPU in the game
    if (cpus.length && humans.length === 1) {
      var lvl = Math.max.apply(null, cpus.map(function (i) { return g.players[i].cpu; })), h = g.players[humans[0]];
      var bestCpu = Math.max.apply(null, cpus.map(function (i) { return g.players[i].score; }));
      var s = rec.cpu[lvl];
      if (h.score > bestCpu) s.w++; else if (h.score < bestCpu) s.l++; else s.t++;
    }
    return news;
  }

  var ENGINE = {
    N: N, NN: NN, CENTER: CENTER, RACK: RACK, BINGO: BINGO, LETTERS: LETTERS, TILESET: TILESET, VAL: VAL, TOTAL: TOTAL, PREM: PREM, LMUL: LMUL, WMUL: WMUL,
    rng: rng, rand: rand, popcnt: popcnt, tileVal: tileVal, isBlankCh: isBlankCh,
    dictBuilder: dictBuilder, buildDict: buildDict, dictFrom: dictFrom, hasWord: hasWord, walk: walk, child: child,
    newGame: newGame, newBag: newBag, boardEmpty: boardEmpty, tilesLeft: tilesLeft, evalPlay: evalPlay,
    makeSearch: makeSearch, genMoves: genMoves, cpuDecide: cpuDecide, leaveValue: leaveValue, leaveOf: leaveOf, swapPick: swapPick,
    current: current, play: play, pass: pass, swap: swap, finish: finish,
    normGame: normGame, newRecords: newRecords, normRecords: normRecords, settle: settle
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('lettertiles.css');
  var DATA_URL = Cade.asset('lettertiles-words.js');   // resolve now, while the loader's context is ours

  var PANEL_ID = 'lettertiles-panel', NAME = 'Letter Tiles';
  var KEY = 'cade-lettertiles-', GAME_KEY = KEY + 'game', REC_KEY = KEY + 'rec', SETUP_KEY = KEY + 'setup', SOUND_KEY = KEY + 'sound', SEEN_KEY = KEY + 'seen';
  var LEVELS = ['Person', 'CPU easy', 'CPU medium', 'CPU hard'], LEVEL_SHORT = ['', 'easy', 'med', 'hard'];
  var S = null;           // the live session (one panel at a time)
  var DICT = null, dictLoad = null, dictPct = 0;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.lettertiles = { live: function () { return S; }, dict: function () { return DICT; }, engine: ENGINE };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { Cade.store.remove(k); } catch (e) {} }
  function jget(k) { var raw = sget(k); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function toast(m, t) { try { Cade.showToast(m, t || 'info', 2000); } catch (e) {} }
  function haptic(ms) { try { if (Cade.haptic) Cade.haptic(ms); } catch (e) {} }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function minimized() { return !!(S && Cade.isMinimized && Cade.isMinimized(S.panel)); }

  // ---- the dictionary: loaded on demand (a script with one big string), built a slice per tick ----
  function loadDict() {
    if (DICT) return Promise.resolve(DICT);
    if (dictLoad) return dictLoad;
    dictLoad = new Promise(function (resolve, reject) {
      function build(D) {
        var b = E_dictBuilder(D);
        (function tick() {
          var t0 = now();
          while (!b.step(15000)) {
            dictPct = Math.min(99, Math.round(100 * b.dict.words / (D.n || 270000)));
            if (now() - t0 > 12) { if (S) syncDictNote(); setTimeout(tick, 0); return; }
          }
          DICT = b.dict; dictPct = 100;
          try { window.__cadeLetterTilesWords = null; } catch (e) {}
          resolve(DICT);
        })();
      }
      if (window.__cadeLetterTilesWords && window.__cadeLetterTilesWords.p) { build(window.__cadeLetterTilesWords); return; }
      var s = document.createElement('script');
      s.src = DATA_URL; s.async = true;
      s.onload = function () {
        s.remove();
        var D = window.__cadeLetterTilesWords;
        if (D && D.p) build(D); else { dictLoad = null; reject(new Error('no words')); }
      };
      s.onerror = function () { s.remove(); dictLoad = null; reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
    return dictLoad;
  }
  var E_dictBuilder = dictBuilder;

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
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };
  function sfx(kind, n) {
    if (!S) return;
    var s = S.snd;
    if (!s.on) return;
    if (kind === 'pick') s.tone(420, 0.04, 'triangle', 0.025);
    else if (kind === 'place') s.tone(560 + 40 * (n || 0), 0.05, 'triangle', 0.035);
    else if (kind === 'back') s.tone(360, 0.05, 'triangle', 0.025, 300);
    else if (kind === 'shuffle') [520, 460, 600, 500].forEach(function (f, j) { s.tone(f, 0.04, 'triangle', 0.02, 0, j * 0.035); });
    else if (kind === 'bad') s.tone(170, 0.18, 'sawtooth', 0.03, 120);
    else if (kind === 'play') {
      var k = Math.min(5, 2 + Math.floor((n || 0) / 12));
      [523, 659, 784, 1047, 1319, 1568].slice(0, k).forEach(function (f, j) { s.tone(f, 0.12, 'triangle', 0.035, 0, j * 0.06); });
    } else if (kind === 'bingo') [523, 659, 784, 1047, 784, 1047, 1319, 1568].forEach(function (f, j) { s.tone(f, 0.14, 'square', 0.022, 0, j * 0.07); });
    else if (kind === 'cpu') s.tone(480 + 30 * (n || 0), 0.05, 'sine', 0.03);
    else if (kind === 'swap') [400, 520, 400].forEach(function (f, j) { s.tone(f, 0.05, 'triangle', 0.025, 0, j * 0.05); });
    else if (kind === 'pass') s.tone(330, 0.12, 'sine', 0.03, 260);
    else if (kind === 'win') [523, 659, 784, 1047, 1319].forEach(function (f, j) { s.tone(f, 0.18, 'triangle', 0.035, 0, j * 0.1); });
    else if (kind === 'lose') [392, 349, 311, 262].forEach(function (f, j) { s.tone(f, 0.2, 'triangle', 0.03, 0, j * 0.12); });
    else if (kind === 'turn') s.tone(880, 0.07, 'sine', 0.03);
  }

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_MENU = svg('<path d="M4 7h16M4 12h16M4 17h16"/>');
  var IC_LOG = svg('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>');

  // ---- helpers ----
  function humans(g) { var n = 0; g.players.forEach(function (p) { if (!p.cpu) n++; }); return n; }
  function pname(g, i) { var p = g.players[i]; return p ? p.name : '?'; }
  function letterOf(ch) { return ch === '?' ? '' : ch.toUpperCase(); }
  function tileHtml(ch, cls) {
    var blank = ch === '?' || isBlankCh(ch), L = letterOf(ch), v = blank ? '' : String(VAL[code(L)]);
    return '<span class="lt-t' + (blank ? ' lt-bl' : '') + (cls ? ' ' + cls : '') + '"><b>' + (L || '&nbsp;') + '</b>' + (v ? '<i>' + v + '</i>' : '') + '</span>';
  }
  var PREM_LABEL = { dl: '2L', tl: '3L', dw: '2W', tw: '3W' };

  // ---- persistence ----
  function saveGame() {
    if (!S || !S.g) return;
    if (S.g.over) sdel(GAME_KEY); else sset(GAME_KEY, JSON.stringify(S.g));
  }
  function loadGame() { return normGame(jget(GAME_KEY)); }
  function saveRec() { if (S) sset(REC_KEY, JSON.stringify(S.rec)); }
  function normSetup(o) {
    var d = { n: 2, p: [{ name: 'You', cpu: 0 }, { name: 'CPU', cpu: 2 }, { name: 'CPU 2', cpu: 2 }, { name: 'CPU 3', cpu: 2 }] };
    if (!o || typeof o !== 'object' || !Array.isArray(o.p)) return d;
    d.n = Math.max(2, Math.min(4, o.n | 0));
    for (var i = 0; i < 4; i++) {
      var q = o.p[i];
      if (q && typeof q === 'object') d.p[i] = { name: cleanName(q.name, d.p[i].name), cpu: Math.max(0, Math.min(3, q.cpu | 0)) };
    }
    return d;
  }

  // ---- layout ----
  function layout() {
    if (!S) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 640, solo = S.panel.classList.contains('cade-solo-panel');
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    S.panel.classList.toggle('lt-phone', phone);
    var cs;
    if (phone) {
      cs = Math.floor((Math.min(vw, 560) - 34) / N);
      var room = vh - (solo ? 250 : 290);
      if (room / N < cs) cs = Math.max(19, Math.floor(room / N));
      cs = Math.max(19, Math.min(cs, 36));
    } else {
      var byH = Math.floor((vh - (solo ? 220 : 270)) / N), byW = Math.floor((vw - (solo ? 300 : 340)) / N);
      cs = Math.max(24, Math.min(byH, byW, solo ? 46 : 38));
    }
    S.cs = cs;
    S.panel.style.setProperty('--lt-cs', cs + 'px');
    // then measure: shrink the board until the panel fits the window (its real chrome, wherever it sits)
    for (var k = 0; k < 3; k++) {
      var r = S.panel.getBoundingClientRect();
      if (!r.height) break;
      var over = Math.max(0, r.top) + (solo ? S.root.getBoundingClientRect().bottom - r.top + 12 : r.height) - (vh - 6);
      if (over <= 0 || S.cs <= 19) break;
      S.cs = Math.max(19, S.cs - Math.ceil(over / N));
      S.panel.style.setProperty('--lt-cs', S.cs + 'px');
    }
  }

  // ---- rendering ----
  function render() {
    if (!S) return;
    renderTop(); renderBoard(); renderRack(); renderActs(); renderPreview(); renderSide(); syncHead();
  }
  function renderTop() {
    var g = S.g, h = '';
    if (!g) { S.top.innerHTML = '<span class="lt-brand">LETTER TILES</span>'; return; }
    g.players.forEach(function (p, i) {
      var on = !g.over && g.turn === i, win = g.over && g.result && g.result.win.indexOf(i) >= 0;
      h += '<span class="lt-pl' + (on ? ' on' : '') + (win ? ' win' : '') + (S.thinking && on ? ' think' : '') + '" title="' + esc(p.name + (p.cpu ? ' (' + LEVELS[p.cpu] + ')' : '')) + '">' +
        '<span class="lt-pn">' + (on ? '&gt; ' : '') + esc(p.name) + (p.cpu ? '<em>' + LEVEL_SHORT[p.cpu] + '</em>' : '') + '</span>' +
        '<b class="lt-ps">' + p.score + '</b></span>';
    });
    h += '<span class="lt-bag" title="Tiles left in the bag">bag <b>' + g.bag.length + '</b></span>';
    S.top.innerHTML = h;
  }
  function tentAt(i) { for (var k = 0; k < S.tent.length; k++) if (S.tent[k].i === i) return k; return -1; }
  function renderBoard() {
    var g = S.g, h = '', last = {}, k;
    var board = g ? g.board : null;
    if (g) g.last.forEach(function (c) { last[c] = 1; });
    var prevOk = S.prev && S.prev.ok;
    for (var i = 0; i < NN; i++) {
      var cls = 'lt-c', inner = '', t = g ? tentAt(i) : -1;
      var pm = PREM[i];
      if (board && board[i]) {
        cls += ' has';
        inner = tileHtml(board[i], last[i] ? 'lt-last' + (S.fresh && S.fresh[i] ? ' lt-new' : '') : '');
      } else if (t >= 0) {
        cls += ' has';
        inner = tileHtml(S.tent[t].ch, 'lt-tent' + (prevOk ? ' ok' : ''));
      } else {
        if (pm) cls += ' p-' + pm;
        if (i === CENTER) { cls += ' p-st'; inner = '<span class="lt-pm">*</span>'; }
        else if (pm) inner = '<span class="lt-pm">' + PREM_LABEL[pm] + '</span>';
        if (S.cur === i && S.phase === 'play') { cls += ' cur'; inner = '<span class="lt-arw">' + (S.dir ? 'v' : '&gt;') + '</span>'; }
      }
      h += '<div class="' + cls + '" data-i="' + i + '">' + inner + '</div>';
    }
    S.boardEl.innerHTML = h;
    S.fresh = null;
    k = 0;
  }
  function soleHuman(g) { var at = -1; for (var i = 0; i < g.players.length; i++) if (!g.players[i].cpu) { if (at >= 0) return -1; at = i; } return at; }
  function renderRack() {
    var g = S.g, h = '', show = [], backs = false, mine = myTurn();
    if (g && mine) show = S.slots;
    else if (g && S.hidden) { backs = true; show = g.players[g.turn].rack.length ? g.players[g.turn].rack : []; }
    else if (g) {
      var hi = soleHuman(g);
      if (hi >= 0) { var ord = S.orders[hi], rk = g.players[hi].rack; show = ord && ord.slice().sort().join('') === rk.slice().sort().join('') ? ord : rk; }
    }
    for (var k = 0; k < RACK; k++) {
      var ch = show[k];
      if (ch == null) { h += '<div class="lt-slot empty" data-s="' + k + '"></div>'; continue; }
      var cls = 'lt-slot';
      if (mine && S.sel === k) cls += ' sel';
      if (mine && S.swapSel && S.swapSel[k]) cls += ' mark';
      h += '<div class="' + cls + '" data-s="' + k + '">' + (backs ? '<span class="lt-t lt-back"><b>&middot;</b></span>' : tileHtml(ch)) + '</div>';
    }
    S.rackEl.innerHTML = h;
    S.rackEl.classList.toggle('off', !mine);
  }
  function myTurn() { var g = S.g; return !!g && !g.over && !g.players[g.turn].cpu && S.phase === 'play'; }
  function renderActs() {
    var g = S.g, h = '';
    if (!g) { S.acts.innerHTML = ''; return; }
    if (g.over) {
      h = '<button type="button" class="lt-b" data-a="menu">Menu</button><button type="button" class="lt-b go" data-a="again">New game</button>';
    } else if (S.swapSel) {
      var n = Object.keys(S.swapSel).length;
      h = '<button type="button" class="lt-b" data-a="swap-cancel">Cancel</button>' +
        '<button type="button" class="lt-b go" data-a="swap-do"' + (n ? '' : ' disabled') + '>Swap ' + (n || '') + '</button>';
    } else {
      var mine = myTurn(), anyTent = S.tent.length > 0, ok = S.prev && S.prev.ok;
      h = '<button type="button" class="lt-b" data-a="' + (anyTent ? 'recall' : 'shuffle') + '"' + (mine ? '' : ' disabled') + '>' + (anyTent ? 'Recall' : 'Shuffle') + '</button>' +
        '<button type="button" class="lt-b" data-a="swap"' + (mine && g.bag.length >= RACK ? '' : ' disabled') + ' title="' + (g.bag.length >= RACK ? 'Swap tiles for new ones (uses your turn)' : 'Needs ' + RACK + '+ tiles in the bag') + '">Swap</button>' +
        '<button type="button" class="lt-b' + (S.passArm ? ' warn' : '') + '" data-a="pass"' + (mine ? '' : ' disabled') + '>' + (S.passArm ? 'Pass?' : 'Pass') + '</button>' +
        '<button type="button" class="lt-b go" data-a="play"' + (mine && ok ? '' : ' disabled') + '>Play' + (anyTent && S.prev && S.prev.words && S.prev.words.length ? ' <span>' + S.prev.score + '</span>' : '') + '</button>';
    }
    S.acts.innerHTML = h;
  }
  function wordsHtml(ws) {
    return ws.map(function (w) { return '<span class="' + (w.ok ? 'ok' : 'bad') + '">' + esc(w.w) + ' <i>' + w.sc + '</i></span>'; }).join(' ');
  }
  function renderPreview() {
    var g = S.g, h = '';
    if (!g) { S.prevEl.innerHTML = ''; return; }
    if (S.tent.length && S.prev) {
      var p = S.prev;
      if (p.words && p.words.length) {
        h = wordsHtml(p.words) + (p.bingo ? ' <span class="bingo">BINGO +' + BINGO + '</span>' : '') + (p.ok ? ' <b class="tot">= ' + p.score + '</b>' : '');
        if (!p.ok) h += ' <span class="err">' + esc(p.err) + '</span>';
      } else h = '<span class="err">' + esc(p.err) + '</span>';
    } else if (S.swapSel) h = '<span class="hint">Tap the tiles to swap, then Swap. It uses your turn.</span>';
    else if (S.phase === 'cpu') h = '<span class="hint">' + esc(pname(g, g.turn)) + ' is thinking<span class="lt-dots"></span></span>';
    else if (g.over) h = '<span class="hint">Game over</span>';
    else if (S.note) h = S.note;
    else if (myTurn()) h = '<span class="hint">' + (S.coarse ? 'Drag tiles, or tap a square (twice turns the arrow) then tiles' : 'Drag tiles, or click a square and type (Space turns the arrow)') + '</span>';
    S.prevEl.innerHTML = h;
  }
  function logLine(g, e) {
    var who = e.p >= 0 ? esc(pname(g, e.p)) : '';
    if (e.t === 'play') return '<li><span class="w">' + who + '</span> ' + (e.w || []).map(esc).join(', ') + (e.b ? ' <span class="bingo">BINGO</span>' : '') + ' <b>+' + e.sc + '</b></li>';
    if (e.t === 'swap') return '<li><span class="w">' + who + '</span> <i>swapped ' + e.n + '</i></li>';
    if (e.t === 'pass') return '<li><span class="w">' + who + '</span> <i>passed</i></li>';
    if (e.t === 'end') return '<li class="end"><i>' + (e.p >= 0 ? who + ' went out' : 'no more plays') + ' &mdash; game over</i></li>';
    return '';
  }
  function unseen(g) {
    // tiles not on the board or on the viewer's rack: the bag plus the other racks
    var c = {}, me = S.hidden ? -1 : !g.players[g.turn].cpu ? g.turn : soleHuman(g);
    Object.keys(TILESET).forEach(function (k) { c[k] = TILESET[k][0]; });
    g.board.forEach(function (ch) { if (ch) c[isBlankCh(ch) ? '?' : ch]--; });
    if (me >= 0) g.players[me].rack.forEach(function (ch) { c[ch]--; });
    return c;
  }
  function unseenHtml(g) {
    var c = unseen(g), h = '';
    (LETTERS + '?').split('').forEach(function (k) { if (c[k] > 0) h += '<span>' + (k === '?' ? '_' : k) + (c[k] > 1 ? '<sub>' + c[k] + '</sub>' : '') + '</span>'; });
    return h || '<i>none</i>';
  }
  function renderSide() {
    var g = S.g;
    if (!g) { S.side.innerHTML = ''; return; }
    var lines = g.log.slice(-60).map(function (e) { return logLine(g, e); }).reverse().join('');
    S.side.innerHTML = '<div class="lt-h">Moves</div><ol class="lt-log">' + (lines || '<li><i>No moves yet</i></li>') + '</ol>' +
      '<div class="lt-h">Unseen tiles</div><div class="lt-un">' + unseenHtml(g) + '</div>';
  }
  function syncHead() {
    if (!S) return;
    var sb = S.head.querySelector('[data-h="sound"]');
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
    var lb = S.head.querySelector('[data-h="log"]');
    if (lb) lb.disabled = !S.g;
  }
  function say(t) { if (S && S.live) S.live.textContent = t; }

  // ---- the tentative play ----
  function updatePrev() {
    var g = S.g;
    S.prev = g && S.tent.length && DICT ? evalPlay(g.board, DICT, S.tent.map(function (t) { return { i: t.i, ch: t.ch }; })) : null;
  }
  function changed() { S.passArm = false; updatePrev(); renderBoard(); renderRack(); renderActs(); renderPreview(); }
  function placeTile(slot, cell, letter) {
    var g = S.g;
    if (!g || g.board[cell] || slot < 0 || slot >= S.slots.length) return false;
    var t = S.slots[slot];
    var old = tentAt(cell);
    if (old >= 0) { S.slots.push(S.tent[old].t); S.tent.splice(old, 1); }
    S.slots.splice(slot, 1);
    if (t === '?' && !letter) {
      S.tent.push({ i: cell, ch: '?', t: '?' });
      askBlank(cell);
    } else S.tent.push({ i: cell, ch: t === '?' ? letter.toLowerCase() : t, t: t });
    sfx('place', S.tent.length);
    haptic(5);
    return true;
  }
  function unplace(k, at) {
    var t = S.tent[k];
    S.tent.splice(k, 1);
    if (at == null || at > S.slots.length) at = S.slots.length;
    S.slots.splice(at, 0, t.t);
    sfx('back');
  }
  function recall() { while (S.tent.length) unplace(S.tent.length - 1); S.cur = -1; S.sel = -1; changed(); }
  function shuffle() {
    var a = S.slots;
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    S.sel = -1;
    sfx('shuffle');
    renderRack();
  }
  // the next empty, untaken square from `cell` along the typing direction (or -1)
  function nextFree(cell, dir, step) {
    var r = Math.floor(cell / N), c = cell % N;
    step = step || 1;
    while (r >= 0 && c >= 0 && r < N && c < N) {
      var i = r * N + c;
      if (!S.g.board[i] && tentAt(i) < 0) return i;
      if (dir) r += step; else c += step;
    }
    return -1;
  }
  function advanceCursor(from) {
    var r = Math.floor(from / N), c = from % N;
    if (S.dir) r++; else c++;
    S.cur = r < N && c < N ? nextFree(r * N + c, S.dir) : -1;
  }
  // the direction the tentative tiles run in, if they're in a line of 2+
  function tentDir() {
    if (S.tent.length < 2) return -1;
    var r0 = Math.floor(S.tent[0].i / N), sameR = S.tent.every(function (t) { return Math.floor(t.i / N) === r0; });
    if (sameR) return 0;
    var c0 = S.tent[0].i % N;
    return S.tent.every(function (t) { return t.i % N === c0; }) ? 1 : -1;
  }
  function typeLetter(L) {
    var g = S.g;
    if (S.cur < 0) {
      if (S.tent.length) {
        var d = tentDir(); if (d >= 0) S.dir = d;
        advanceCursor(S.tent[S.tent.length - 1].i);
      } else if (boardEmpty(g.board)) { S.cur = CENTER; }
      if (S.cur < 0) { S.note = '<span class="hint">Click a square to type from (Space turns the arrow)</span>'; renderPreview(); S.note = ''; sfx('bad'); return; }
    }
    var slot = S.slots.indexOf(L), letter = null;
    if (slot < 0) { slot = S.slots.indexOf('?'); letter = L; }
    if (slot < 0) { sfx('bad'); S.note = '<span class="err">No ' + L + ' on your rack</span>'; renderPreview(); S.note = ''; return; }
    var cell = S.cur;
    placeTile(slot, cell, letter);
    advanceCursor(cell);
    changed();
  }
  function backspace() {
    if (!S.tent.length) return;
    var t = S.tent[S.tent.length - 1];
    unplace(S.tent.length - 1);
    S.cur = t.i;
    changed();
  }
  function moveCursor(dr, dc) {
    if (S.cur < 0) { S.cur = CENTER; }
    else {
      var r = Math.floor(S.cur / N) + dr, c = S.cur % N + dc;
      r = Math.max(0, Math.min(N - 1, r)); c = Math.max(0, Math.min(N - 1, c));
      var i = r * N + c, guard = 0;
      while ((S.g.board[i] || tentAt(i) >= 0) && guard++ < N) {
        r += dr; c += dc;
        if (r < 0 || c < 0 || r >= N || c >= N) { i = S.cur; break; }
        i = r * N + c;
      }
      S.cur = i;
    }
    S.dir = dc ? 0 : 1;
    renderBoard();
  }

  // ---- the blank picker ----
  function askBlank(cell) {
    S.blankCell = cell;
    showCard('blank');
  }
  function setBlank(L) {
    var k = tentAt(S.blankCell);
    if (k >= 0) {
      if (L) S.tent[k].ch = L.toLowerCase();
      else unplace(k);
    }
    S.blankCell = -1;
    showCard(null);
    changed();
  }

  // ---- turns ----
  function startGame(players) {
    var g = newGame({ players: players, seed: (Math.random() * 4294967295) >>> 0, now: Date.now() });
    S.g = g; S.orders = {};
    S.tent = []; S.slots = []; S.sel = -1; S.cur = -1; S.swapSel = null; S.passArm = false;
    saveGame();
    showCard(null);
    sfx('turn');
    beginTurn(true);
    relayout();
  }
  function relayout() { requestAnimationFrame(function () { if (S && !minimized()) layout(); }); }
  // Sets up whoever's turn it is: a CPU thinks, a person maybe gets the privacy screen first.
  function beginTurn(fresh) {
    var g = S.g;
    S.tent = []; S.sel = -1; S.cur = -1; S.swapSel = null; S.passArm = false; S.prev = null; S.thinking = false;
    if (!g) return;
    if (g.over) { gameOver(); return; }
    var p = g.players[g.turn];
    if (p.cpu) { S.phase = 'cpu'; S.hidden = humans(g) > 1; render(); cpuTurn(); return; }
    if (humans(g) > 1 && (fresh || S.lastHuman !== g.turn)) {
      S.phase = 'hand'; S.hidden = true;
      render(); showCard('hand');
      return;
    }
    showRack();
  }
  function showRack() {
    var g = S.g, p = g.players[g.turn];
    S.phase = 'play'; S.hidden = false; S.lastHuman = g.turn;
    var ord = S.orders[g.turn];
    S.slots = ord && ord.slice().sort().join('') === p.rack.slice().sort().join('') ? ord.slice() : p.rack.slice();
    if (!DICT) S.note = '<span class="hint">Loading the dictionary&hellip;</span>';
    showCard(null);
    render();
    S.note = '';
    say(p.name + "'s turn. " + p.rack.length + ' tiles.');
  }
  function afterMove() {
    var g = S.g;
    saveGame();
    S.thinking = false;
    if (g.over) { settleNow(); render(); setTimeout(function () { if (S && S.g === g) gameOver(); }, 700); return; }
    beginTurn(false);
  }
  function humanPlay() {
    var g = S.g;
    if (!myTurn() || !DICT) return;
    updatePrev();
    if (!S.prev || !S.prev.ok) {
      sfx('bad'); haptic(20);
      S.boardEl.classList.remove('shake'); void S.boardEl.offsetWidth; S.boardEl.classList.add('shake');
      renderPreview();
      return;
    }
    var pl = S.tent.map(function (t) { return { i: t.i, ch: t.ch }; }), me = g.turn;
    var leftOrder = S.slots.slice();
    var res = play(g, DICT, pl);
    if (!res.ok) { sfx('bad'); toast(res.err || 'Not a valid play'); return; }
    // keep the player's rack order (new tiles go on the end)
    var order = leftOrder.slice(), rest = g.players[me].rack.slice();
    order.forEach(function (ch) { var k = rest.indexOf(ch); if (k >= 0) rest.splice(k, 1); });
    S.orders[me] = order.concat(rest);
    celebrate(res, pl.map(function (q) { return q.i; }), me);
    S.tent = [];
    afterMove();
  }
  function celebrate(res, cells, who) {
    S.fresh = {};
    cells.forEach(function (c) { S.fresh[c] = 1; });
    sfx(res.bingo ? 'bingo' : 'play', res.score);
    haptic(res.bingo ? 30 : 12);
    popScore(cells[cells.length - 1], '+' + res.score);
    if (res.bingo) banner('BINGO! +' + BINGO);
    say(pname(S.g, who) + ' played ' + res.words.map(function (w) { return w.w; }).join(', ') + ' for ' + res.score + '.');
  }
  function popScore(cell, text) {
    var wrap = S.stage, el = document.createElement('div');
    var r = Math.floor(cell / N), c = cell % N;
    el.className = 'lt-pop';
    el.textContent = text;
    el.style.left = ((c + 0.5) * S.cs + 3) + 'px';
    el.style.top = (r * S.cs + 3) + 'px';
    wrap.appendChild(el);
    setTimeout(function () { el.remove(); }, 1200);
  }
  function banner(text) {
    var el = document.createElement('div');
    el.className = 'lt-banner';
    el.textContent = text;
    S.stage.appendChild(el);
    setTimeout(function () { el.remove(); }, 1600);
  }
  function humanPass() {
    if (!myTurn()) return;
    if (!S.passArm) { S.passArm = true; renderActs(); clearTimeout(S.passT); S.passT = setTimeout(function () { if (S) { S.passArm = false; renderActs(); } }, 3000); return; }
    S.passArm = false;
    var me = S.g.turn;
    S.orders[me] = S.slots.concat(S.tent.map(function (t) { return t.t; }));
    pass(S.g);
    sfx('pass');
    say(pname(S.g, me) + ' passed.');
    afterMove();
  }
  function startSwap() {
    if (!myTurn() || S.g.bag.length < RACK) return;
    if (S.tent.length) recall();
    S.swapSel = {}; S.sel = -1; S.cur = -1;
    renderBoard(); renderRack(); renderActs(); renderPreview();
  }
  function doSwap() {
    var ks = Object.keys(S.swapSel || {}).map(Number);
    if (!ks.length) return;
    var me = S.g.turn, tiles = ks.map(function (k) { return S.slots[k]; });
    var keep = S.slots.filter(function (ch, k) { return !S.swapSel[k]; });
    S.swapSel = null;
    if (!swap(S.g, tiles)) { toast('Can’t swap now'); render(); return; }
    var rest = S.g.players[me].rack.slice();
    keep.forEach(function (ch) { var k = rest.indexOf(ch); if (k >= 0) rest.splice(k, 1); });
    S.orders[me] = keep.concat(rest);
    sfx('swap');
    say(pname(S.g, me) + ' swapped ' + tiles.length + ' tiles.');
    afterMove();
  }

  // ---- the CPU: the search runs a board line at a time between frames ----
  function cpuTurn() {
    var g = S.g, me = g.turn, p = g.players[me], t0 = now(), sess = S;
    S.thinking = true; renderTop(); renderPreview();
    loadDict().then(function (dict) {
      if (S !== sess || S.g !== g || g.turn !== me) return;
      var search = makeSearch(dict, g.board, p.rack);
      (function tick() {
        if (S !== sess || S.g !== g) return;
        var t1 = now();
        while (!search.done && now() - t1 < 10) search.step();
        if (!search.done) { S.cpuT = setTimeout(tick, 0); return; }
        var wait = Math.max(0, 650 + Math.random() * 450 - (now() - t0));
        S.cpuT = setTimeout(function act() {
          if (S !== sess || S.g !== g) return;
          if (minimized()) { S.cpuT = setTimeout(act, 300); return; }   // finish the move when the panel is back
          cpuAct(search.moves);
        }, wait);
      })();
    }, function () { if (S === sess) { S.phase = 'error'; showCard('error'); } });
  }
  function cpuAct(moves) {
    var g = S.g, me = g.turn, p = g.players[me];
    var dec = cpuDecide(moves, p.cpu, p.rack, g.bag.length, Math.random);
    if (dec.type === 'play') {
      var pl = dec.move.cells.map(function (c, k) { return { i: c, ch: dec.move.chars[k] }; });
      var res = play(g, DICT, pl);
      if (res.ok) {
        celebrate(res, dec.move.cells, me);
        pl.forEach(function (q, k) { setTimeout(function () { sfx('cpu', k); }, k * 45); });
        S.note = '<span class="hint">' + esc(p.name) + ' played</span> ' + wordsHtml(res.words) + (res.bingo ? ' <span class="bingo">BINGO</span>' : '') + ' <b class="tot">+' + res.score + '</b>';
      } else { pass(g); }
    } else if (dec.type === 'swap') {
      if (!swap(g, dec.tiles)) pass(g);
      else { sfx('swap'); S.note = '<span class="hint">' + esc(p.name) + ' swapped ' + dec.tiles.length + ' tiles</span>'; say(p.name + ' swapped tiles.'); }
    } else { pass(g); sfx('pass'); S.note = '<span class="hint">' + esc(p.name) + ' passed</span>'; say(p.name + ' passed.'); }
    afterMove();
  }

  // Records are folded in as soon as the game ends (even if the panel closes before the card shows).
  function settleNow() {
    if (!S || !S.g || !S.g.over || S.settled) return false;
    S.settled = true;
    S.news = settle(S.rec, S.g);
    saveRec();
    saveGame();
    return true;
  }
  function gameOver() {
    var g = S.g;
    S.phase = 'over'; S.hidden = false; S.thinking = false;
    if (settleNow()) {
      var h = humans(g), won = g.result.win.some(function (i) { return !g.players[i].cpu; });
      sfx(h && won ? 'win' : 'lose');
    }
    render();
    showCard('over');
  }

  // ---- cards ----
  function art() {
    return '<pre class="lt-art" aria-hidden="true">' +
      '+---+---+---+---+---+---+\n| L | E | T | T | E | R |\n+---+---+---+---+---+---+\n    | T | I | L | E | S |\n    +---+---+---+---+---+</pre>';
  }
  function dictNoteHtml() {
    return DICT ? '' : '<div class="lt-note lt-dictnote">' + (dictLoad ? 'Loading the dictionary&hellip; ' + dictPct + '%' : 'Dictionary didn’t load &mdash; <button type="button" class="lt-lnk" data-act="retry">retry</button>') + '</div>';
  }
  function syncDictNote() {
    var el = S && S.ovl.querySelector('.lt-dictnote');
    if (el) el.outerHTML = dictNoteHtml() || '<div class="lt-note lt-dictnote">Dictionary ready</div>';
  }
  function scoreLine(g) {
    return g.players.map(function (p) { return esc(p.name) + ' ' + p.score; }).join(' &middot; ');
  }
  function homeHtml() {
    var sv = S.saved, h = '<div class="lt-card lt-home">' + art();
    if (sv && !sv.over) {
      var tp = sv.players[sv.turn];
      h += '<button type="button" class="lt-go" data-act="resume">Resume game<small>' + scoreLine(sv) + ' &middot; ' + esc(tp.name) + (tp.cpu ? ' to play' : '’s turn') + '</small></button>';
    }
    h += '<button type="button" class="lt-go' + (sv && !sv.over ? ' alt' : '') + '" data-act="setup">New game</button>';
    h += '<div class="lt-btns"><button type="button" class="lt-go alt" data-act="records">Records</button><button type="button" class="lt-go alt" data-act="help">How to play</button></div>';
    h += dictNoteHtml();
    return h + '</div>';
  }
  function setupHtml() {
    var st = S.setup, h = '<div class="lt-card lt-setup"><div class="lt-title">NEW GAME</div>';
    h += '<div class="lt-row"><span class="lt-h">Players</span><span class="lt-seg">' + [2, 3, 4].map(function (n) {
      return '<button type="button" data-n="' + n + '" class="' + (st.n === n ? 'on' : '') + '" aria-pressed="' + (st.n === n) + '">' + n + '</button>';
    }).join('') + '</span></div>';
    for (var i = 0; i < st.n; i++) {
      var q = st.p[i];
      h += '<div class="lt-seat"><div class="lt-seat-top"><span class="lt-num">' + (i + 1) + '</span>' +
        '<input class="lt-name" data-pi="' + i + '" maxlength="14" value="' + esc(q.name) + '" aria-label="Player ' + (i + 1) + ' name" autocomplete="off" spellcheck="false"></div>' +
        '<span class="lt-seg lt-kind">' + LEVELS.map(function (lb, k) {
          return '<button type="button" data-pi="' + i + '" data-cpu="' + k + '" class="' + (q.cpu === k ? 'on' : '') + '" aria-pressed="' + (q.cpu === k) + '">' + (k ? LEVEL_SHORT[k].replace('med', 'medium') : 'person') + '</button>';
        }).join('') + '</span></div>';
    }
    var hs = 0; for (i = 0; i < st.n; i++) if (!st.p[i].cpu) hs++;
    h += '<div class="lt-note">' + (hs === 0 ? 'Everyone is a CPU: sit back and watch.' : hs > 1 ? 'Pass and play: racks stay hidden between turns.' : 'CPU easy plays any word, medium a decent one, hard the best it can find.') + '</div>';
    h += '<div class="lt-btns"><button type="button" class="lt-go alt" data-act="home">Back</button><button type="button" class="lt-go" data-act="start"' + (DICT ? '' : ' disabled') + '>' + (DICT ? 'Start' : 'Loading&hellip;') + '</button></div>';
    h += dictNoteHtml();
    return h + '</div>';
  }
  function recordsHtml() {
    var r = S.rec, rows = [];
    function line(a, b) { return esc(a) + new Array(Math.max(1, 26 - a.length - String(b).length) + 1).join(' ') + '<b>' + esc(b) + '</b>'; }
    rows.push(line('Games played', String(r.games)));
    [1, 2, 3].forEach(function (k) { var s = r.cpu[k]; rows.push(line('vs CPU ' + LEVEL_SHORT[k].replace('med', 'medium'), s.w + '-' + s.l + (s.t ? '-' + s.t : ''))); });
    rows.push(line('Best game', r.hi ? String(r.hi) : '-'));
    rows.push(line('Best move', r.move ? r.move + (r.moveW ? ' ' + r.moveW : '') : '-'));
    rows.push(line('Bingos', String(r.bingos)));
    rows.push(line('Longest word', r.long || '-'));
    return '<div class="lt-card"><div class="lt-title">RECORDS</div><pre class="lt-tab">' + rows.join('\n') + '</pre>' +
      '<div class="lt-note">vs CPU: wins-losses against the toughest CPU in one-person games</div>' +
      '<div class="lt-foot">' + (S.resetArm ? '<span class="lt-confirm">Erase all records?</span><span><button type="button" class="lt-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="lt-lnk" data-act="reset-no">Keep</button></span>' :
        '<span></span><button type="button" class="lt-lnk" data-act="reset">Reset records</button>') + '</div>' +
      '<button type="button" class="lt-go alt" data-act="back">Back</button></div>';
  }
  function legend() {
    return '<div class="lt-legend">' + ['dl', 'tl', 'dw', 'tw'].map(function (k) {
      return '<span><span class="lt-c p-' + k + '"><span class="lt-pm">' + PREM_LABEL[k] + '</span></span>' + { dl: 'letter x2', tl: 'letter x3', dw: 'word x2', tw: 'word x3' }[k] + '</span>';
    }).join('') + '</div>';
  }
  function valuesHtml() {
    var by = {};
    LETTERS.split('').forEach(function (L) { var v = VAL[code(L)]; (by[v] = by[v] || []).push(L); });
    return '<pre class="lt-tab lt-vals">' + Object.keys(by).sort(function (a, b) { return a - b; }).map(function (v) { return '<b>' + (v < 10 ? ' ' : '') + v + '</b>  ' + by[v].join(' '); }).join('\n') + '\n<b> 0</b>  blank (_) &mdash; any letter</pre>';
  }
  function helpHtml() {
    var keys = S.coarse ?
      '<div><b>drag</b> a tile onto a square, or</div><div><b>tap</b> a tile, then a square &mdash; or a square, then tiles</div><div><b>tap</b> a placed tile to take it back</div>' :
      '<div><b>drag</b> tiles, or <b>click a square and type</b></div><div><b>Space</b> / arrows &nbsp;turn the typing arrow</div><div><b>Backspace</b> take back &nbsp;<b>Enter</b> play &nbsp;<b>Esc</b> recall</div>';
    return '<div class="lt-card lt-help"><div class="lt-title">HOW TO PLAY</div>' +
      '<p>Make words on the board with the tiles on your rack, in one row or one column, reading left to right or top to bottom. ' +
      'The first word covers the centre <b>*</b>; after that every word must join the tiles already down.</p>' +
      '<p>You score every word you make or extend, crossing words too. Premium squares count once, for the tile laid on them:</p>' + legend() +
      '<p>Use all seven tiles in one turn for a <b>BINGO: +' + BINGO + '</b>. Blanks (_) can be any letter, worth 0.</p>' +
      '<div class="lt-keys">' + keys + '</div>' +
      '<p><b>Swap</b> tiles for new ones (while 7+ are in the bag) or <b>Pass</b> &mdash; both use your turn. Words are checked as you lay them, so there are no challenges.</p>' +
      '<p>The game ends when someone uses their last tile with the bag empty (they collect what the others have left) or after two rounds with no score. Tiles left on a rack count against you.</p>' +
      '<div class="lt-h">Tile values</div>' + valuesHtml() +
      '<button type="button" class="lt-go" data-act="back">' + (S.g && !S.g.over ? 'Back to the game' : 'Got it') + '</button></div>';
  }
  function handHtml() {
    var g = S.g, p = g.players[g.turn], since = [], i;
    // what happened since this player's last turn
    for (i = g.log.length - 1; i >= 0 && since.length < g.players.length - 1; i--) {
      if (g.log[i].p === g.turn) break;
      since.unshift(g.log[i]);
    }
    return '<div class="lt-card lt-hand"><div class="lt-title">PASS TO ' + esc(p.name.toUpperCase()) + '</div>' +
      '<div class="lt-sub">' + scoreLine(g) + '</div>' +
      (since.length ? '<ol class="lt-log lt-since">' + since.map(function (e) { return logLine(g, e); }).join('') + '</ol>' : '') +
      '<button type="button" class="lt-go big" data-act="ready">' + esc(p.name) + ', tap when ready</button>' +
      '<div class="lt-note">Racks stay hidden until the right player is holding the device.</div></div>';
  }
  function overHtml() {
    var g = S.g, r = g.result, order = g.players.map(function (p, i) { return i; }).sort(function (a, b) { return g.players[b].score - g.players[a].score; });
    var wins = r.win.map(function (i) { return g.players[i].name; }), h = humans(g), title;
    if (wins.length > 1) title = 'A TIE';
    else if (h === 1) title = g.players[r.win[0]].cpu ? 'CPU WINS' : 'YOU WIN';
    else title = esc(wins[0].toUpperCase()) + ' WINS';
    var rows = order.map(function (i, k) {
      var p = g.players[i], a = r.adj[i] || 0, nm = p.name + (p.cpu ? ' (' + LEVEL_SHORT[p.cpu] + ')' : '');
      var right = p.score + (a ? ' (' + (a > 0 ? '+' : '') + a + ')' : '');
      return (r.win.indexOf(i) >= 0 ? '<span class="g">' : '') + (k + 1) + '. ' + esc(nm) + new Array(Math.max(1, 25 - nm.length - right.length) + 1).join(' ') + '<b>' + esc(right) + '</b>' + (r.win.indexOf(i) >= 0 ? '</span>' : '');
    });
    var best = order.map(function (i) { return g.players[i]; }).filter(function (p) { return p.best; }).sort(function (a, b) { return b.best - a.best; })[0];
    var news = (S.news || []).map(function (n) { return { score: 'best game', move: 'best move', word: 'longest word' }[n]; });
    return '<div class="lt-card lt-over"><div class="lt-title">' + title + '</div>' +
      '<pre class="lt-tab">' + rows.join('\n') + '</pre>' +
      (best ? '<div class="lt-sub">Top move: ' + esc(best.bestW) + ' for ' + best.best + ' (' + esc(best.name) + ')</div>' : '') +
      '<div class="lt-note">' + (r.out >= 0 ? esc(pname(g, r.out)) + ' went out and collects the tiles left over' : 'No one could score: tiles left count against their owners') + '</div>' +
      (news.length ? '<div class="lt-new">new record &mdash; ' + news.join(', ') + '</div>' : '') +
      '<div class="lt-btns"><button type="button" class="lt-go alt" data-act="view">See the board</button><button type="button" class="lt-go" data-act="again">Rematch</button></div>' +
      '<button type="button" class="lt-lnk" data-act="menu">Menu</button></div>';
  }
  function blankHtml() {
    return '<div class="lt-card lt-blankpick"><div class="lt-title">BLANK</div><div class="lt-sub">Which letter is it?</div><div class="lt-abc">' +
      LETTERS.split('').map(function (L) { return '<button type="button" data-L="' + L + '">' + L + '</button>'; }).join('') +
      '</div><button type="button" class="lt-go alt" data-act="blank-cancel">Take it back</button></div>';
  }
  function logHtml() {
    var g = S.g;
    return '<div class="lt-card lt-logcard"><div class="lt-title">MOVES</div>' +
      '<ol class="lt-log">' + (g.log.slice().reverse().map(function (e) { return logLine(g, e); }).join('') || '<li><i>No moves yet</i></li>') + '</ol>' +
      '<div class="lt-h">Unseen tiles</div><div class="lt-un">' + unseenHtml(g) + '</div>' +
      '<button type="button" class="lt-go alt" data-act="back">Back</button></div>';
  }
  function errorHtml() {
    return '<div class="lt-card"><div class="lt-title">NO DICTIONARY</div><p>The word list didn’t load. It is saved for offline use after one load online.</p>' +
      '<div class="lt-btns"><button type="button" class="lt-go alt" data-act="menu">Menu</button><button type="button" class="lt-go" data-act="retry">Retry</button></div></div>';
  }
  // Cards: home / setup / records / help / hand / over / blank / log / error over the board.
  function showCard(kind) {
    S.card = kind;
    var h = '';
    if (kind === 'home') h = homeHtml();
    else if (kind === 'setup') h = setupHtml();
    else if (kind === 'records') h = recordsHtml();
    else if (kind === 'help') h = helpHtml();
    else if (kind === 'hand') h = handHtml();
    else if (kind === 'over') h = overHtml();
    else if (kind === 'blank') h = blankHtml();
    else if (kind === 'log') h = logHtml();
    else if (kind === 'error') h = errorHtml();
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.root.classList.toggle('dim', !!kind);
    S.root.classList.toggle('carded', !!kind);
    if (kind) S.ovl.scrollTop = 0;
  }
  function goHome() {
    S.cardBack = null;
    S.saved = S.g && !S.g.over ? S.g : loadGame();
    if (S.g && S.g.over) S.g = null;
    clearTimeout(S.cpuT);
    if (S.g && !S.g.over) { S.phase = 'menu'; }
    else { S.phase = 'home'; }
    S.thinking = false;
    render();
    showCard('home');
  }
  function resumeGame() {
    var g = S.saved && !S.saved.over ? S.saved : loadGame();
    if (!g) { goHome(); return; }
    if (S.g !== g) { S.g = g; S.orders = {}; S.lastHuman = -1; }
    S.settled = false;
    showCard(null);
    beginTurn(true);
    relayout();
  }
  // a card opened over the game (help, log) goes back to what was there
  function overlay(kind) {
    S.cardBack = S.card;
    showCard(kind);
  }
  function closeOverlay() {
    var back = S.cardBack;
    S.cardBack = null;
    if (back) showCard(back);
    else if (S.phase === 'home' || S.phase === 'menu') showCard('home');
    else showCard(null);
  }

  // ---- input: pointer (drag / tap) ----
  function cellFromPoint(x, y) {
    var doc = S.panel.ownerDocument, el = doc.elementFromPoint(x, y);
    if (!el || !S.panel.contains(el)) return null;
    var c = el.closest('[data-i]');
    if (c && S.boardEl.contains(c)) return { cell: +c.getAttribute('data-i') };
    if (el.closest('.lt-rack')) {
      // insert position from the slots' centres
      var slots = S.rackEl.querySelectorAll('.lt-slot'), at = 0;
      for (var k = 0; k < slots.length; k++) { var rr = slots[k].getBoundingClientRect(); if (x > rr.left + rr.width / 2) at = k + 1; }
      return { rack: at };
    }
    return null;
  }
  function onDown(e) {
    if (!S || e.button > 0 || !S.g) return;
    S.snd.ensure();
    var t = e.target, slotEl = t.closest('.lt-slot'), cellEl = t.closest('[data-i]');
    if (S.card) return;
    var src = null;
    if (slotEl && S.rackEl.contains(slotEl) && !slotEl.classList.contains('empty') && myTurn()) src = { kind: 'rack', slot: +slotEl.getAttribute('data-s'), el: slotEl };
    else if (cellEl && S.boardEl.contains(cellEl)) {
      var i = +cellEl.getAttribute('data-i'), k = tentAt(i);
      src = k >= 0 && myTurn() ? { kind: 'tent', cell: i, el: cellEl } : { kind: 'cell', cell: i, el: cellEl };
    }
    if (!src) return;
    e.preventDefault();
    S.drag = { src: src, x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, ghost: null, over: null, touch: e.pointerType !== 'mouse' };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {}
  }
  function onMove(e) {
    var d = S && S.drag;
    if (!d || e.pointerId !== d.id) return;
    var dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved) {
      if (dx * dx + dy * dy < 36 || S.swapSel || (d.src.kind !== 'rack' && d.src.kind !== 'tent')) return;
      d.moved = true;
      var ch = d.src.kind === 'rack' ? S.slots[d.src.slot] : S.tent[tentAt(d.src.cell)].ch;
      var gh = S.panel.ownerDocument.createElement('div');
      gh.className = 'lt-ghost';
      gh.style.setProperty('--gs', Math.round(Math.max(S.cs * 1.5, d.touch ? 46 : 36)) + 'px');
      gh.innerHTML = tileHtml(ch);
      S.panel.appendChild(gh);
      d.ghost = gh;
      d.src.el.classList.add('lift');
      sfx('pick');
    }
    e.preventDefault();
    var gx = e.clientX, gy = e.clientY - (d.touch ? Math.max(34, S.cs * 1.4) : 0);
    var pr = S.panel.getBoundingClientRect();
    d.ghost.style.transform = 'translate(' + (gx - pr.left) + 'px,' + (gy - pr.top) + 'px) translate(-50%,-50%)';
    var over = cellFromPoint(gx, gy), key = over ? (over.cell != null ? 'c' + over.cell : 'r') : '';
    if (key !== d.overKey) {
      if (d.overEl) d.overEl.classList.remove('over');
      d.overEl = null;
      if (over && over.cell != null && !S.g.board[over.cell]) { d.overEl = S.boardEl.children[over.cell]; d.overEl.classList.add('over'); }
      else if (over && over.rack != null) { d.overEl = S.rackEl; S.rackEl.classList.add('over'); }
      d.overKey = key;
    }
    d.over = over;
  }
  function onUp(e) {
    var d = S && S.drag;
    if (!d || e.pointerId !== d.id) return;
    S.drag = null;
    if (d.ghost) d.ghost.remove();
    if (d.overEl) d.overEl.classList.remove('over');
    if (d.src.el) d.src.el.classList.remove('lift');
    if (e.type === 'pointercancel') { if (d.moved) changed(); return; }
    if (d.moved) drop(d.src, d.over);
    else tap(d.src);
  }
  function drop(src, over) {
    if (!over || !myTurn()) { changed(); return; }
    var g = S.g;
    if (src.kind === 'rack') {
      if (over.cell != null) {
        if (g.board[over.cell]) { changed(); return; }
        S.sel = -1;
        placeTile(src.slot, over.cell);
        S.cur = -1;
      } else if (over.rack != null) {
        var ch = S.slots.splice(src.slot, 1)[0], at = over.rack > src.slot ? over.rack - 1 : over.rack;
        S.slots.splice(Math.min(at, S.slots.length), 0, ch);
        S.sel = -1;
        sfx('back');
      }
    } else if (src.kind === 'tent') {
      var k = tentAt(src.cell);
      if (k < 0) { changed(); return; }
      if (over.cell != null && over.cell !== src.cell) {
        if (g.board[over.cell]) { changed(); return; }
        var other = tentAt(over.cell);
        if (other >= 0) { var tmp = S.tent[other].i; S.tent[other].i = src.cell; S.tent[k].i = tmp; }
        else S.tent[k].i = over.cell;
        sfx('place', S.tent.length);
      } else if (over.rack != null) unplace(k, over.rack);
    }
    if (S.card !== 'blank') changed();
  }
  function tap(src) {
    var g = S.g;
    if (!g || S.card) return;
    if (src.kind === 'rack') {
      if (S.swapSel) {
        if (S.swapSel[src.slot]) delete S.swapSel[src.slot]; else S.swapSel[src.slot] = 1;
        sfx('pick');
        renderRack(); renderActs();
        return;
      }
      if (S.cur >= 0 && !g.board[S.cur] && tentAt(S.cur) < 0) {
        var cell = S.cur;
        S.sel = -1;
        placeTile(src.slot, cell);
        if (S.card !== 'blank') advanceCursor(cell); else S.cur = -1;
        if (S.card !== 'blank') changed();
        return;
      }
      S.sel = S.sel === src.slot ? -1 : src.slot;
      sfx('pick');
      renderRack();
      return;
    }
    if (!myTurn() || S.swapSel) return;
    if (src.kind === 'tent') {
      var k = tentAt(src.cell);
      if (k >= 0) { unplace(k); S.cur = -1; changed(); }
      return;
    }
    // an empty square
    var i = src.cell;
    if (g.board[i]) { if (S.cur >= 0) { S.cur = -1; renderBoard(); } return; }
    if (S.sel >= 0) {
      var slot = S.sel;
      S.sel = -1;
      placeTile(slot, i);
      var d = tentDir();
      if (d >= 0) S.dir = d;
      S.cur = -1;
      if (S.card !== 'blank') changed();
      return;
    }
    if (S.cur === i) S.dir = S.dir ? 0 : 1;
    else {
      S.cur = i;
      // aim the arrow along the tiles it touches: beside a word reads across, above or below one reads down
      var r = Math.floor(i / N), c = i % N, b = g.board;
      var lr = (c > 0 && b[i - 1]) || (c < N - 1 && b[i + 1]), ud = (r > 0 && b[i - N]) || (r < N - 1 && b[i + N]);
      if (lr && !ud) S.dir = 0; else if (ud && !lr) S.dir = 1;
    }
    sfx('pick');
    renderBoard();
  }

  // ---- input: keys ----
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (minimized()) return;   // parked in the dock: keys belong to the editor
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
      if (S.panel.contains(t) && e.key === 'Enter' && S.card === 'setup') { e.preventDefault(); clickAct('start'); }
      return;
    }
    if (t && t.isContentEditable) return;
    var k = e.key;
    if (S.card) {
      if (S.card === 'blank' && /^[a-zA-Z]$/.test(k)) { e.preventDefault(); setBlank(k.toUpperCase()); return; }
      if (k === 'Escape') {
        e.preventDefault();
        if (S.card === 'blank') setBlank(null);
        else if (S.card === 'help' || S.card === 'log' || S.card === 'records') closeOverlay();
        else if (S.card === 'setup') goHome();
        else if (S.card === 'home' && S.g && !S.g.over) resumeGame();
        return;
      }
      if ((k === 'Enter' || k === ' ') && S.card === 'hand') { e.preventDefault(); if (!e.repeat) clickAct('ready'); }
      return;
    }
    if (!myTurn()) return;
    if (S.swapSel) { if (k === 'Escape') { e.preventDefault(); S.swapSel = null; render(); } return; }
    if (/^[a-zA-Z]$/.test(k)) { e.preventDefault(); typeLetter(k.toUpperCase()); return; }
    if (k === 'Backspace') { e.preventDefault(); backspace(); return; }
    if (k === 'Enter') { e.preventDefault(); if (!e.repeat) humanPlay(); return; }
    if (k === 'Escape') { e.preventDefault(); if (S.tent.length) recall(); else if (S.cur >= 0) { S.cur = -1; renderBoard(); } return; }
    if (k === ' ') { e.preventDefault(); if (S.cur < 0 && !S.tent.length) shuffle(); else { S.dir = S.dir ? 0 : 1; renderBoard(); } return; }
    if (k === 'ArrowLeft') { e.preventDefault(); moveCursor(0, -1); return; }
    if (k === 'ArrowRight') { e.preventDefault(); moveCursor(0, 1); return; }
    if (k === 'ArrowUp') { e.preventDefault(); moveCursor(-1, 0); return; }
    if (k === 'ArrowDown') { e.preventDefault(); moveCursor(1, 0); return; }
  }

  // ---- buttons ----
  function clickAct(a, b) {
    if (!S) return;
    S.snd.ensure();
    if (a === 'resume') resumeGame();
    else if (a === 'setup') { S.setup = normSetup(jget(SETUP_KEY)); showCard('setup'); if (!DICT) ensureDict(); }
    else if (a === 'home') goHome();
    else if (a === 'menu') { if (S.g && S.g.over) S.g = null; goHome(); }
    else if (a === 'records') { S.resetArm = false; overlay('records'); }
    else if (a === 'help') overlay('help');
    else if (a === 'back') closeOverlay();
    else if (a === 'reset') { S.resetArm = true; showCard('records'); }
    else if (a === 'reset-no') { S.resetArm = false; showCard('records'); }
    else if (a === 'reset-yes') { S.rec = newRecords(); saveRec(); S.resetArm = false; showCard('records'); toast('Records reset'); }
    else if (a === 'start') {
      if (!DICT) return;
      readNames();
      sset(SETUP_KEY, JSON.stringify(S.setup));
      S.settled = false; S.news = null;
      startGame(S.setup.p.slice(0, S.setup.n));
    } else if (a === 'again') {
      var g = S.g, ps = g ? g.players.map(function (p) { return { name: p.name, cpu: p.cpu }; }) : S.setup.p.slice(0, S.setup.n);
      S.settled = false; S.news = null;
      startGame(ps);
    } else if (a === 'view') { showCard(null); S.phase = 'over'; render(); }
    else if (a === 'ready') { sfx('turn'); showRack(); }
    else if (a === 'blank-cancel') setBlank(null);
    else if (a === 'retry') { ensureDict(); if (S.card === 'error') goHome(); else showCard(S.card); }
    else if (a === 'play') humanPlay();
    else if (a === 'recall') recall();
    else if (a === 'shuffle') shuffle();
    else if (a === 'pass') humanPass();
    else if (a === 'swap') startSwap();
    else if (a === 'swap-cancel') { S.swapSel = null; render(); }
    else if (a === 'swap-do') doSwap();
  }
  function readNames() {
    var ins = S.ovl.querySelectorAll('.lt-name');
    for (var k = 0; k < ins.length; k++) {
      var i = +ins[k].getAttribute('data-pi'), q = S.setup.p[i];
      q.name = cleanName(ins[k].value, q.cpu ? 'CPU' : 'Player ' + (i + 1));
    }
  }
  function ensureDict() {
    loadDict().then(function () { if (S) { syncDictNote(); if (S.card === 'setup') { readNames(); showCard('setup'); } if (S.phase === 'play') { updatePrev(); renderPreview(); renderActs(); } } },
      function () { if (S) syncDictNote(); });
    if (S) syncDictNote();
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    clearTimeout(s.cpuT); clearTimeout(s.passT); clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    window.removeEventListener('resize', s.onResize);
    window.removeEventListener('blur', s.dropDrag);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.drag && s.drag.ghost) s.drag.ghost.remove();
    s.snd.close();
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
  }
  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="lt">' +
      '<div class="lt-top"></div>' +
      '<div class="lt-main"><div class="lt-stage"><div class="lt-board" role="grid" aria-label="Board"></div></div><div class="lt-side"></div></div>' +
      '<div class="lt-prev" aria-live="off"></div>' +
      '<div class="lt-rack" aria-label="Your rack"></div>' +
      '<div class="lt-acts"></div>' +
      '<div class="lt-ovl" style="display:none"></div>' +
      '<div class="lt-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🔤 Letter Tiles', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'lt-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="log" class="lt-logbtn" title="Moves" aria-label="Moves">' + IC_LOG + '</button>' +
      '<button type="button" data-h="sound"></button>' +
      '<button type="button" data-h="menu" title="Menu" aria-label="Menu">' + IC_MENU + '</button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var root = p.querySelector('.lt');
    S = {
      panel: p, root: root, head: hb, top: p.querySelector('.lt-top'), stage: p.querySelector('.lt-stage'), boardEl: p.querySelector('.lt-board'),
      side: p.querySelector('.lt-side'), prevEl: p.querySelector('.lt-prev'), rackEl: p.querySelector('.lt-rack'), acts: p.querySelector('.lt-acts'),
      ovl: p.querySelector('.lt-ovl'), live: p.querySelector('.lt-live'),
      snd: new Snd(sget(SOUND_KEY) === '1'), rec: normRecords(jget(REC_KEY)), setup: normSetup(jget(SETUP_KEY)),
      g: null, saved: null, phase: 'home', card: null, cardBack: null, tent: [], slots: [], sel: -1, cur: -1, dir: 0, swapSel: null,
      hidden: false, prev: null, note: '', orders: {}, lastHuman: -1, cs: 30, coarse: false, drag: null, settled: false, news: null, blankCell: -1
    };
    p._onClose = teardown;
    layout();

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !minimized()) layout(); }, 100);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    // a drag can't outlive the window losing focus or the panel going to the dock
    S.dropDrag = function () {
      if (!S || !S.drag) return;
      var d = S.drag;
      S.drag = null;
      if (d.ghost) d.ghost.remove();
      if (d.overEl) d.overEl.classList.remove('over');
      if (S.g) changed();
    };
    window.addEventListener('blur', S.dropDrag);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) S.dropDrag(); });
    p.addEventListener('cade-panel-restore', function () { if (S && S.panel === p) requestAnimationFrame(function () { if (S) layout(); }); });

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
      } else if (h === 'help') { if (S.card === 'help') closeOverlay(); else if (S.card !== 'blank') overlay('help'); }
      else if (h === 'log') { if (S.card === 'log') closeOverlay(); else if (S.g && (!S.card || S.card === 'over')) overlay('log'); }
      else if (h === 'menu') {
        if (S.card === 'home' && S.g && !S.g.over) resumeGame();
        else if (S.card !== 'blank') { if (S.tent.length) recall(); goHome(); }
      }
      try { b.blur(); } catch (er) {}
    });

    // Fast taps must never zoom, select, magnify or open a callout: the play
    // surfaces take no browser gestures and cancel their touches outright, and
    // the panel swallows gesture / dblclick events (the CSS does the rest).
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    [S.boardEl, S.rackEl].forEach(function (el) {
      el.addEventListener('touchstart', noTouch, { passive: false });
      el.addEventListener('touchmove', noTouch, { passive: false });
      el.addEventListener('touchend', noTouch, { passive: false });
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
      el.addEventListener('contextmenu', noTouch);
    });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    S.acts.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-a]') : null;
      if (b && !b.disabled) clickAct(b.getAttribute('data-a'));
    });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var act = b.getAttribute('data-act'), L = b.getAttribute('data-L');
      if (L) { setBlank(L); return; }
      if (b.hasAttribute('data-n')) { readNames(); S.setup.n = +b.getAttribute('data-n'); showCard('setup'); sfx('pick'); return; }
      if (b.hasAttribute('data-cpu')) {
        readNames();
        var i = +b.getAttribute('data-pi'), q = S.setup.p[i], was = q.cpu;
        q.cpu = +b.getAttribute('data-cpu');
        // a seat changing between person and CPU gets a sensible default name
        if (!was !== !q.cpu) {
          if (q.cpu && !/^CPU/.test(q.name)) q.name = 'CPU' + (i ? ' ' + (i + 1) : '');
          else if (!q.cpu && /^CPU/.test(q.name)) q.name = i ? 'Player ' + (i + 1) : 'You';
        }
        showCard('setup'); sfx('pick');
        return;
      }
      if (act) clickAct(act);
    });

    syncHead();
    S.saved = loadGame();
    if (!sget(SEEN_KEY)) { sset(SEEN_KEY, '1'); render(); showCard('help'); S.cardBack = 'home'; }
    else if (S.saved && !S.saved.over) {
      S.g = S.saved;
      // straight back into a one-person game; pass-and-play waits on the menu
      if (humans(S.g) <= 1) { render(); beginTurn(true); }
      else goHome();
    } else goHome();
    ensureDict();
    requestAnimationFrame(function () { if (S && S.panel === p) layout(); });
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Build crossing words on a board for points — vs CPU or pass-and-play',
    icon: '🔤',
    tags: 'game,word,board,tiles,crossword,2 player,cpu,letters,pass and play,bingo',
    open: open,
    _engine: ENGINE
  });
})();
