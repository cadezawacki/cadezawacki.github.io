#!/usr/bin/env node
/* build-puzzles.js — pre-generates the Mini Crossword puzzle set.
 *
 *   node txt/widgets/crossword/build-puzzles.js [count]      build (default 365)
 *   node txt/widgets/crossword/build-puzzles.js --check      validate crossword-data.js
 *
 * Reads clues.tsv (WORD<TAB>clue<TAB>optional alt clue; 3-5 letters) and fills
 * 5x5 grids by backtracking: the most-constrained slot is filled first, each
 * slot's candidates come from per-position letter bitsets, and every placement
 * is forward-checked against the crossing slots. Black squares follow a few
 * 180-degree symmetric patterns (0, 2 or 4 blacks) in which every across/down
 * entry is 3+ letters and every white cell is checked both ways.
 *
 * Variety: a word may appear in at most MAX_USE puzzles, less-used words are
 * tried first, a word's alternative clue is used on its second appearance,
 * and no puzzle contains the same answer twice (or both CAT and CATS).
 * Deterministic: a seeded PRNG means the same list always builds the same set.
 *
 * Output: crossword-data.js — one compact string per puzzle,
 *   "GRID25|across clues in number order|down clues in number order"
 * where GRID25 is the 25 cells row by row ('#' = black). The widget derives
 * the numbering from the grid, so nothing else needs storing. */
'use strict';
var fs = require('fs');
var path = require('path');

var DIR = __dirname;
var LIST = path.join(DIR, 'clues.tsv');
var OUT = path.join(DIR, 'crossword-data.js');
var SEED = 'cade-mini-crossword-v1';
var EPOCH = '2026-10-01';            // date of puzzle #1 for the Daily rotation
var MAX_USE = 3;                     // appearances allowed per word across the set
var NODE_LIMIT = 4000;               // backtracking nodes per attempt before giving up
var N = 5;

// Black-square patterns (rows top to bottom). Weights steer the mix.
var PATTERNS = [
  { w: 2, rows: ['.....', '.....', '.....', '.....', '.....'] },
  { w: 3, rows: ['#....', '.....', '.....', '.....', '....#'] },
  { w: 3, rows: ['....#', '.....', '.....', '.....', '#....'] },
  { w: 3, rows: ['#...#', '.....', '.....', '.....', '#...#'] },
  { w: 2, rows: ['##...', '.....', '.....', '.....', '...##'] },
  { w: 2, rows: ['...##', '.....', '.....', '.....', '##...'] },
  { w: 2, rows: ['#....', '#....', '.....', '....#', '....#'] },
  { w: 2, rows: ['....#', '....#', '.....', '#....', '#....'] }
];

// ---- seeded PRNG (sfc32) ------------------------------------------------------
function rngFrom(seed) {
  var h = 1779033703 ^ seed.length;
  for (var k = 0; k < seed.length; k++) { h = Math.imul(h ^ seed.charCodeAt(k), 3432918353); h = (h << 13) | (h >>> 19); }
  function mix() { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return (h ^= h >>> 16) >>> 0; }
  var a = mix(), b = mix(), c = mix(), d = mix();
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    var t = (a + b) | 0;
    a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

// ---- word list ------------------------------------------------------------------
// A clue must never give its answer away (CATS / "Cat food", TIRED / "Tire out").
function giveaway(a, b) {
  if (a.length > b.length) { var t = a; a = b; b = t; }
  return a === b || [a + 'S', a + 'ES', a + 'D', a + 'ED', a + 'ER', a + 'ING', a + 'LY', a + 'Y'].indexOf(b) !== -1;
}
function loadList() {
  var words = {}, byLen = { 3: [], 4: [], 5: [] }, errs = [];
  fs.readFileSync(LIST, 'utf8').split('\n').forEach(function (line, i) {
    if (!line.trim() || line.charAt(0) === '#') return;
    var f = line.split('\t').map(function (s) { return s.trim(); }).filter(Boolean);
    var w = f[0];
    if (!/^[A-Z]{3,5}$/.test(w) || f.length < 2 || f.length > 3) { errs.push('line ' + (i + 1) + ': bad entry "' + line + '"'); return; }
    if (words[w]) { errs.push('duplicate word ' + w); return; }
    var clues = f.slice(1);
    clues.forEach(function (c) {
      if (/[|\n]/.test(c)) errs.push('clue for ' + w + ' contains a separator');
      (c.match(/[A-Za-z]+/g) || []).forEach(function (cw) { if (giveaway(cw.toUpperCase(), w)) errs.push('clue for ' + w + ' gives it away: ' + c); });
    });
    words[w] = clues;
    byLen[w.length].push(w);
  });
  if (errs.length) throw new Error('clues.tsv:\n  ' + errs.join('\n  '));
  return { words: words, byLen: byLen };
}

// ---- grid geometry -------------------------------------------------------------
// Slots in standard crossword numbering order; returns null if the pattern breaks
// the rules (run of 1-2 letters, unchecked cell, asymmetric).
function slotsFor(grid) {
  var num = [], n = 0, across = [], down = [], r, c;
  function white(rr, cc) { return rr >= 0 && rr < N && cc >= 0 && cc < N && grid[rr * N + cc] !== '#'; }
  for (var i = 0; i < N * N; i++) if ((grid[i] === '#') !== (grid[N * N - 1 - i] === '#')) return null;
  for (r = 0; r < N; r++) for (c = 0; c < N; c++) {
    if (!white(r, c)) continue;
    var sa = !white(r, c - 1) && white(r, c + 1), sd = !white(r - 1, c) && white(r + 1, c);
    if (sa || sd) num[r * N + c] = ++n;
    if (sa) { var cells = []; for (var k = c; white(r, k); k++) cells.push(r * N + k); across.push({ num: n, dir: 'A', cells: cells }); }
    if (sd) { var cd = []; for (var q = r; white(q, c); q++) cd.push(q * N + c); down.push({ num: n, dir: 'D', cells: cd }); }
  }
  var slots = across.concat(down), cover = {};
  for (var s = 0; s < slots.length; s++) {
    if (slots[s].cells.length < 3) return null;
    slots[s].cells.forEach(function (x) { cover[x] = (cover[x] || 0) + 1; });
  }
  for (i = 0; i < N * N; i++) if (grid[i] !== '#' && cover[i] !== 2) return null;
  return slots;
}

// ---- filler --------------------------------------------------------------------
function makeIndex(byLen) {
  var idx = {};
  [3, 4, 5].forEach(function (L) {
    var list = byLen[L], W = Math.ceil(list.length / 32), pos = [];
    for (var p = 0; p < L; p++) {
      var m = {};
      for (var ch = 65; ch <= 90; ch++) m[String.fromCharCode(ch)] = new Uint32Array(W);
      pos.push(m);
    }
    list.forEach(function (w, wi) { for (var p2 = 0; p2 < L; p2++) pos[p2][w[p2]][wi >> 5] |= 1 << (wi & 31); });
    var all = new Uint32Array(W);
    for (var wi = 0; wi < list.length; wi++) all[wi >> 5] |= 1 << (wi & 31);
    idx[L] = { list: list, W: W, pos: pos, all: all, avail: all.slice() };
  });
  return idx;
}
function popcount(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }
function related(a, b) {
  if (a === b) return true;
  if (a.length > b.length) { var t = a; a = b; b = t; }
  return b === a + 'S' || b === a + 'ES' || b === a + 'D' || b === a + 'ED';
}

function fill(pattern, idx, uses, rnd) {
  var grid = pattern.split(''), slots = slotsFor(grid), nodes = 0;
  if (!slots) throw new Error('bad pattern ' + pattern);
  var placed = [];                        // slot index -> word
  function candidates(s) {
    var I = idx[s.cells.length], m = I.avail.slice();
    for (var p = 0; p < s.cells.length; p++) {
      var ch = grid[s.cells[p]];
      if (ch === '.') continue;
      var b = I.pos[p][ch];
      for (var k = 0; k < I.W; k++) m[k] &= b[k];
    }
    return m;
  }
  function count(m) { var n = 0; for (var k = 0; k < m.length; k++) if (m[k]) n += popcount(m[k]); return n; }
  function rec() {
    if (++nodes > NODE_LIMIT) return false;
    var best = -1, bestMask = null, bestN = 1e9;
    for (var s = 0; s < slots.length; s++) {
      if (placed[s]) continue;
      var m = candidates(slots[s]), n = count(m);
      if (n === 0) return false;              // forward check: a crossing slot died
      if (n < bestN) { bestN = n; best = s; bestMask = m; }
    }
    if (best < 0) return true;                // every slot filled
    var S = slots[best], I = idx[S.cells.length], cand = [];
    for (var k = 0; k < I.W; k++) for (var bits = bestMask[k]; bits; bits &= bits - 1) {
      var w = I.list[(k << 5) + (31 - Math.clz32(bits & -bits))];
      var bad = false;
      for (var q = 0; q < placed.length && !bad; q++) if (placed[q] && related(placed[q], w)) bad = true;
      if (!bad) cand.push({ w: w, key: (uses[w] || 0) + rnd() * 1.5 });
    }
    cand.sort(function (a, b) { return a.key - b.key; });
    var saved = S.cells.map(function (x) { return grid[x]; });
    for (var c = 0; c < cand.length && c < 40; c++) {
      var word = cand[c].w;
      for (var p = 0; p < S.cells.length; p++) grid[S.cells[p]] = word[p];
      placed[best] = word;
      if (rec()) return true;
      placed[best] = undefined;
      for (p = 0; p < S.cells.length; p++) grid[S.cells[p]] = saved[p];
      if (nodes > NODE_LIMIT) return false;
    }
    return false;
  }
  if (!rec()) return null;
  return { grid: grid.join(''), slots: slots, words: placed };
}

function build(target) {
  var L = loadList(), idx = makeIndex(L.byLen), rnd = rngFrom(SEED), uses = {}, out = [], seen = {};
  var bag = [];
  PATTERNS.forEach(function (p, i) { for (var k = 0; k < p.w; k++) bag.push(i); });
  var tries = 0, fails = {};
  while (out.length < target && tries < target * 60) {
    tries++;
    var pi = bag[(rnd() * bag.length) | 0], pat = PATTERNS[pi].rows.join('');
    var res = fill(pat, idx, uses, rnd);
    if (!res || seen[res.grid]) { fails[pi] = (fails[pi] || 0) + 1; continue; }
    seen[res.grid] = 1;
    var clues = res.slots.map(function (s, si) {
      var w = res.words[si], cl = L.words[w], n = uses[w] || 0;
      return cl[n % cl.length];
    });
    res.words.forEach(function (w) {
      uses[w] = (uses[w] || 0) + 1;
      if (uses[w] >= MAX_USE) { var I = idx[w.length], wi = I.list.indexOf(w); I.avail[wi >> 5] &= ~(1 << (wi & 31)); }
    });
    out.push(res.grid + '|' + clues.join('|'));
    if (out.length % 50 === 0) process.stderr.write('  ' + out.length + ' puzzles (' + tries + ' attempts)\n');
  }
  var distinct = Object.keys(uses).length;
  process.stderr.write('built ' + out.length + ' puzzles in ' + tries + ' attempts; ' + distinct + ' distinct answers used; failures by pattern ' + JSON.stringify(fails) + '\n');
  return out;
}

function writeData(lines) {
  var head = '/* Generated by build-puzzles.js from clues.tsv — do not edit by hand.\n' +
    '   One puzzle per string: 25 grid cells row by row (\'#\' = black square), then the\n' +
    '   across clues and the down clues in standard numbering order, all \'|\'-separated.\n' +
    '   Daily puzzle = (days since epoch) mod count. */\n';
  var body = 'window.__cadeCrosswordData = {"v":1,"epoch":"' + EPOCH + '","p":[\n' +
    lines.map(function (l) { return JSON.stringify(l); }).join(',\n') + '\n]};\n';
  fs.writeFileSync(OUT, head + body);
}

// ---- validation (also run after every build) -------------------------------------
function check() {
  var L = loadList(), src = fs.readFileSync(OUT, 'utf8'), win = {};
  new Function('window', src)(win);
  var D = win.__cadeCrosswordData, errs = [], uses = {}, grids = {}, blacks = {};
  if (!D || !Array.isArray(D.p) || !/^\d{4}-\d\d-\d\d$/.test(D.epoch)) throw new Error('data shape');
  D.p.forEach(function (line, pi) {
    var f = line.split('|'), grid = f[0], tag = '#' + (pi + 1) + ' ';
    if (!/^[A-Z#]{25}$/.test(grid)) { errs.push(tag + 'grid'); return; }
    var slots = slotsFor(grid.split(''));
    if (!slots) { errs.push(tag + 'pattern breaks the rules (symmetry / short entry / unchecked cell)'); return; }
    var nb = grid.split('#').length - 1;
    blacks[nb] = (blacks[nb] || 0) + 1;
    if (nb > 5) errs.push(tag + 'too many blacks');
    if (f.length !== slots.length + 1) errs.push(tag + 'clue count ' + (f.length - 1) + ' != ' + slots.length);
    if (grids[grid]) errs.push(tag + 'duplicate of #' + grids[grid]);
    grids[grid] = pi + 1;
    var ws = slots.map(function (s) { return s.cells.map(function (x) { return grid[x]; }).join(''); });
    ws.forEach(function (w, si) {
      if (!L.words[w]) errs.push(tag + w + ' not in list');
      else if (L.words[w].indexOf(f[si + 1]) === -1) errs.push(tag + 'clue for ' + w + ' not from list');
      if (!f[si + 1]) errs.push(tag + 'missing clue for ' + w);
      for (var sj = 0; sj < si; sj++) if (related(ws[sj], w)) errs.push(tag + 'repeated/related answers ' + ws[sj] + ' ' + w);
      uses[w] = (uses[w] || 0) + 1;
    });
  });
  Object.keys(uses).forEach(function (w) { if (uses[w] > MAX_USE) errs.push(w + ' used ' + uses[w] + ' times'); });
  var nWords = Object.keys(L.words).length;
  console.log('list: ' + nWords + ' words (' + [3, 4, 5].map(function (n) { return L.byLen[n].length + 'x' + n; }).join(', ') + ')');
  console.log('puzzles: ' + D.p.length + ', black-square counts ' + JSON.stringify(blacks) + ', distinct answers ' + Object.keys(uses).length +
    ', data ' + (Buffer.byteLength(src) / 1024).toFixed(1) + ' KB');
  if (errs.length) { console.error(errs.slice(0, 40).join('\n')); console.error(errs.length + ' problem(s)'); process.exit(1); }
  console.log('check OK');
}

if (require.main === module) {
  if (process.argv[2] === '--check') check();
  else {
    var target = +(process.argv[2] || 365);
    var t0 = Date.now();
    writeData(build(target));
    process.stderr.write('wrote ' + path.relative(process.cwd(), OUT) + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's\n');
    check();
  }
}
module.exports = { slotsFor: slotsFor, loadList: loadList, related: related };
