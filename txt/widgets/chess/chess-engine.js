/* Chess engine for Cade.txt — shared by the Chess and Chess Puzzles widgets.
 * Pure JavaScript, no DOM. One file, three ways to load it:
 *   - node:        module.exports = ENGINE (headless tests, the puzzle builder)
 *   - a page:      window.__cadeChessEngine = ENGINE (a plain <script>)
 *   - a Web Worker: new Worker('chess-engine.js') answers search requests, so
 *                  the computer thinks off the UI thread.
 *
 * Board: 0x88 (sq = rank * 16 + file, a1 = 0, h8 = 119). Pieces are small ints:
 * type 1..6 = P N B R Q K, plus 8 for black. A move is one int:
 * from | to << 7 | promo-type << 14 | flags << 17 (flags: capture, en passant,
 * castle, double push). make / unmake keep an undo stack, a 64-bit Zobrist key
 * (two 32-bit halves) and the key history for repetition draws.
 *
 * Rules: castling (through / out of check), en passant, promotion to any piece,
 * check, mate, stalemate, threefold repetition, the 50-move rule and
 * insufficient material. SAN in and out, FEN in and out, PGN, perft.
 *
 * Search: negamax alpha-beta with iterative deepening inside a time budget,
 * PVS, a transposition table (typed arrays), TT-move / MVV-LVA / killer /
 * history move ordering, null-move pruning, late-move reductions, check
 * extension and a quiescence search. Evaluation: tapered (middlegame /
 * endgame) material + piece-square tables, pawn structure (passed, doubled,
 * isolated), rooks on open files, bishop pair, a king shelter and a mop-up
 * term so the computer can actually mate a lone king.
 *
 * Mate solver: an exact AND/OR proof search (mate in n, with memo), used to
 * build and verify the bundled puzzles and to answer for the defence. */
(function () {
  'use strict';

  var P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6, BLACK = 8;
  var F_CAP = 1, F_EP = 2, F_CASTLE = 4, F_DOUBLE = 8;
  var MATE = 30000, INF = 32000, MAXPLY = 96;
  var VAL = [0, 100, 320, 330, 500, 950, 0];
  var PCH = '.PNBRQK..pnbrqk';
  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  var KN_OFF = [33, 31, 18, 14, -33, -31, -18, -14];
  var KI_OFF = [1, -1, 16, -16, 15, 17, -15, -17];
  var BI_OFF = [15, 17, -15, -17];
  var RO_OFF = [1, -1, 16, -16];

  function sqName(s) { return 'abcdefgh'.charAt(s & 7) + ((s >> 4) + 1); }
  function sqParse(n) {
    if (!n || n.length < 2) return -1;
    var f = n.charCodeAt(0) - 97, r = n.charCodeAt(1) - 49;
    return f < 0 || f > 7 || r < 0 || r > 7 ? -1 : r * 16 + f;
  }
  function mFrom(m) { return m & 127; }
  function mTo(m) { return (m >> 7) & 127; }
  function mPromo(m) { return (m >> 14) & 7; }
  function mFlags(m) { return m >> 17; }
  function mk(from, to, promo, fl) { return from | (to << 7) | (promo << 14) | (fl << 17); }

  // ---- Zobrist keys (deterministic) ----
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var ZL = new Int32Array(16 * 128), ZH = new Int32Array(16 * 128), ZCL = new Int32Array(16), ZCH = new Int32Array(16);
  var ZEL = new Int32Array(8), ZEH = new Int32Array(8), ZSL, ZSH;
  (function () {
    var r = rng(0xC4E55), i;
    function r32() { return (r() * 4294967296) | 0; }
    for (i = 0; i < ZL.length; i++) { ZL[i] = r32(); ZH[i] = r32(); }
    for (i = 0; i < 16; i++) { ZCL[i] = r32(); ZCH[i] = r32(); }
    for (i = 0; i < 8; i++) { ZEL[i] = r32(); ZEH[i] = r32(); }
    ZSL = r32(); ZSH = r32();
  })();
  // castling rights kept after a move touches a square
  var CMASK = new Int8Array(128);
  for (var ci = 0; ci < 128; ci++) CMASK[ci] = 15;
  CMASK[4] = 12; CMASK[0] = 13; CMASK[7] = 14; CMASK[116] = 3; CMASK[112] = 7; CMASK[119] = 11;

  // ================= position =================
  function Pos() {
    this.b = new Int8Array(128);
    this.side = 0; this.castle = 0; this.ep = -1; this.epz = 0; this.half = 0; this.full = 1;
    this.kings = [4, 116]; this.lo = 0; this.hi = 0;
    this.st = []; this.sp = 0;        // undo stack (8 numbers a ply)
    this.hl = []; this.hh = [];       // keys of earlier positions (repetition)
  }
  Pos.prototype.clone = function () {
    var p = new Pos();
    p.b.set(this.b); p.side = this.side; p.castle = this.castle; p.ep = this.ep; p.epz = this.epz; p.half = this.half; p.full = this.full;
    p.kings = this.kings.slice(); p.lo = this.lo; p.hi = this.hi; p.hl = this.hl.slice(); p.hh = this.hh.slice();
    return p;
  };
  // en passant counts for the key only when a pawn could actually take
  Pos.prototype.epCapturable = function (ep, side) {
    if (ep < 0) return false;
    var pawn = side ? P | BLACK : P, from1 = side ? ep + 15 : ep - 15, from2 = side ? ep + 17 : ep - 17;
    return (!(from1 & 0x88) && this.b[from1] === pawn) || (!(from2 & 0x88) && this.b[from2] === pawn);
  };
  Pos.prototype.rehash = function () {
    var lo = 0, hi = 0, b = this.b;
    for (var s = 0; s < 128; s++) { if (s & 0x88) { s += 7; continue; } if (b[s]) { lo ^= ZL[b[s] * 128 + s]; hi ^= ZH[b[s] * 128 + s]; } }
    lo ^= ZCL[this.castle]; hi ^= ZCH[this.castle];
    this.epz = this.epCapturable(this.ep, this.side) ? (this.ep & 7) + 1 : 0;
    if (this.epz) { lo ^= ZEL[this.epz - 1]; hi ^= ZEH[this.epz - 1]; }
    if (this.side) { lo ^= ZSL; hi ^= ZSH; }
    this.lo = lo; this.hi = hi;
  };

  function fromFEN(fen) {
    var p = new Pos(), parts = String(fen || '').trim().split(/\s+/), rows = (parts[0] || '').split('/');
    if (rows.length !== 8) throw new Error('bad FEN');
    var kc = [0, 0];
    for (var r = 0; r < 8; r++) {
      var f = 0, row = rows[7 - r];
      for (var i = 0; i < row.length; i++) {
        var ch = row.charAt(i);
        if (/\d/.test(ch)) { f += +ch; continue; }
        var t = 'pnbrqk'.indexOf(ch.toLowerCase()) + 1;
        if (!t || f > 7) throw new Error('bad FEN');
        var pc = t | (ch === ch.toLowerCase() ? BLACK : 0), sq = r * 16 + f;
        p.b[sq] = pc;
        if (t === K) { p.kings[pc >> 3] = sq; kc[pc >> 3]++; }
        f++;
      }
      if (f !== 8) throw new Error('bad FEN');
    }
    if (kc[0] !== 1 || kc[1] !== 1) throw new Error('bad FEN: kings');
    p.side = parts[1] === 'b' ? 1 : 0;
    var c = parts[2] || '-';
    p.castle = (c.indexOf('K') >= 0 ? 1 : 0) | (c.indexOf('Q') >= 0 ? 2 : 0) | (c.indexOf('k') >= 0 ? 4 : 0) | (c.indexOf('q') >= 0 ? 8 : 0);
    // drop rights the pieces can't back up
    if (p.b[4] !== K) p.castle &= 12;
    if (p.b[7] !== R) p.castle &= ~1;
    if (p.b[0] !== R) p.castle &= ~2;
    if (p.b[116] !== (K | BLACK)) p.castle &= 3;
    if (p.b[119] !== (R | BLACK)) p.castle &= ~4;
    if (p.b[112] !== (R | BLACK)) p.castle &= ~8;
    p.ep = parts[3] && parts[3] !== '-' ? sqParse(parts[3]) : -1;
    p.half = Math.max(0, parseInt(parts[4], 10) || 0);
    p.full = Math.max(1, parseInt(parts[5], 10) || 1);
    p.rehash();
    return p;
  }
  Pos.prototype.fen = function () {
    var out = '', b = this.b;
    for (var r = 7; r >= 0; r--) {
      var e = 0;
      for (var f = 0; f < 8; f++) {
        var pc = b[r * 16 + f];
        if (!pc) { e++; continue; }
        if (e) { out += e; e = 0; }
        out += PCH.charAt(pc);
      }
      if (e) out += e;
      if (r) out += '/';
    }
    var c = (this.castle & 1 ? 'K' : '') + (this.castle & 2 ? 'Q' : '') + (this.castle & 4 ? 'k' : '') + (this.castle & 8 ? 'q' : '');
    return out + ' ' + (this.side ? 'b' : 'w') + ' ' + (c || '-') + ' ' + (this.ep >= 0 ? sqName(this.ep) : '-') + ' ' + this.half + ' ' + this.full;
  };

  // Is square s attacked by colour `by`?
  Pos.prototype.attacked = function (s, by) {
    var b = this.b, i, t, d, pc, cb = by << 3;
    if (by) { t = s + 15; if (!(t & 0x88) && b[t] === (P | BLACK)) return true; t = s + 17; if (!(t & 0x88) && b[t] === (P | BLACK)) return true; }
    else { t = s - 15; if (!(t & 0x88) && b[t] === P) return true; t = s - 17; if (!(t & 0x88) && b[t] === P) return true; }
    for (i = 0; i < 8; i++) {
      t = s + KN_OFF[i]; if (!(t & 0x88) && b[t] === (N | cb)) return true;
      t = s + KI_OFF[i]; if (!(t & 0x88) && b[t] === (K | cb)) return true;
    }
    for (i = 0; i < 4; i++) {
      d = BI_OFF[i]; t = s + d;
      while (!(t & 0x88)) { pc = b[t]; if (pc) { if (pc === (B | cb) || pc === (Q | cb)) return true; break; } t += d; }
      d = RO_OFF[i]; t = s + d;
      while (!(t & 0x88)) { pc = b[t]; if (pc) { if (pc === (R | cb) || pc === (Q | cb)) return true; break; } t += d; }
    }
    return false;
  };
  Pos.prototype.inCheck = function () { return this.attacked(this.kings[this.side], this.side ^ 1); };

  Pos.prototype.make = function (m) {
    var b = this.b, from = m & 127, to = (m >> 7) & 127, pr = (m >> 14) & 7, fl = m >> 17, pc = b[from], cap = b[to], side = this.side;
    var lo = this.lo, hi = this.hi, st = this.st, sp = this.sp;
    this.hl.push(lo); this.hh.push(hi);
    if (this.epz) { lo ^= ZEL[this.epz - 1]; hi ^= ZEH[this.epz - 1]; }
    lo ^= ZCL[this.castle]; hi ^= ZCH[this.castle];
    lo ^= ZL[pc * 128 + from]; hi ^= ZH[pc * 128 + from];
    b[from] = 0;
    if (fl & F_EP) {
      var cs = side ? to + 16 : to - 16;
      cap = b[cs]; b[cs] = 0;
      lo ^= ZL[cap * 128 + cs]; hi ^= ZH[cap * 128 + cs];
    } else if (cap) { lo ^= ZL[cap * 128 + to]; hi ^= ZH[cap * 128 + to]; }
    st[sp] = m; st[sp + 1] = cap; st[sp + 2] = this.castle; st[sp + 3] = this.ep; st[sp + 4] = this.half; st[sp + 5] = this.epz; st[sp + 6] = this.lo; st[sp + 7] = this.hi;
    this.sp = sp + 8;
    var np = pr ? pr | (side << 3) : pc;
    b[to] = np; lo ^= ZL[np * 128 + to]; hi ^= ZH[np * 128 + to];
    if (fl & F_CASTLE) {
      var rf, rt, rk = R | (side << 3);
      if (to > from) { rf = from + 3; rt = from + 1; } else { rf = from - 4; rt = from - 1; }
      b[rf] = 0; b[rt] = rk;
      lo ^= ZL[rk * 128 + rf] ^ ZL[rk * 128 + rt]; hi ^= ZH[rk * 128 + rf] ^ ZH[rk * 128 + rt];
    }
    if ((pc & 7) === K) this.kings[side] = to;
    this.castle &= CMASK[from] & CMASK[to];
    lo ^= ZCL[this.castle]; hi ^= ZCH[this.castle];
    this.ep = -1; this.epz = 0;
    if (fl & F_DOUBLE) {
      var e = (from + to) >> 1;
      this.ep = e;
      if (this.epCapturable(e, side ^ 1)) { this.epz = (e & 7) + 1; lo ^= ZEL[e & 7]; hi ^= ZEH[e & 7]; }
    }
    this.half = (pc & 7) === P || cap ? 0 : this.half + 1;
    if (side) this.full++;
    this.side = side ^ 1;
    this.lo = lo ^ ZSL; this.hi = hi ^ ZSH;
  };
  Pos.prototype.unmake = function () {
    var st = this.st, sp = this.sp - 8, b = this.b;
    this.sp = sp;
    var m = st[sp], cap = st[sp + 1], from = m & 127, to = (m >> 7) & 127, pr = (m >> 14) & 7, fl = m >> 17;
    this.castle = st[sp + 2]; this.ep = st[sp + 3]; this.half = st[sp + 4]; this.epz = st[sp + 5]; this.lo = st[sp + 6]; this.hi = st[sp + 7];
    this.hl.pop(); this.hh.pop();
    var side = this.side ^ 1;
    this.side = side;
    if (side) this.full--;
    var pc = pr ? P | (side << 3) : b[to];
    b[from] = pc;
    if (fl & F_EP) { b[to] = 0; b[side ? to + 16 : to - 16] = cap; }
    else b[to] = cap;
    if (fl & F_CASTLE) {
      var rk = R | (side << 3);
      if (to > from) { b[from + 3] = rk; b[from + 1] = 0; } else { b[from - 4] = rk; b[from - 1] = 0; }
    }
    if ((pc & 7) === K) this.kings[side] = from;
  };
  // A pass (null move) for the search.
  Pos.prototype.makeNull = function () {
    var st = this.st, sp = this.sp, lo = this.lo, hi = this.hi;
    this.hl.push(lo); this.hh.push(hi);
    st[sp] = 0; st[sp + 1] = 0; st[sp + 2] = this.castle; st[sp + 3] = this.ep; st[sp + 4] = this.half; st[sp + 5] = this.epz; st[sp + 6] = lo; st[sp + 7] = hi;
    this.sp = sp + 8;
    if (this.epz) { lo ^= ZEL[this.epz - 1]; hi ^= ZEH[this.epz - 1]; }
    this.ep = -1; this.epz = 0; this.half = 0;
    this.side ^= 1; this.lo = lo ^ ZSL; this.hi = hi ^ ZSH;
  };
  Pos.prototype.unmakeNull = function () {
    var st = this.st, sp = this.sp - 8;
    this.sp = sp;
    this.castle = st[sp + 2]; this.ep = st[sp + 3]; this.half = st[sp + 4]; this.epz = st[sp + 5]; this.lo = st[sp + 6]; this.hi = st[sp + 7];
    this.hl.pop(); this.hh.pop();
    this.side ^= 1;
  };

  // Pseudo-legal moves into `out` (captures + queen promotions only when capsOnly).
  Pos.prototype.gen = function (out, capsOnly) {
    var b = this.b, side = this.side, cb = side << 3, s, pc, t, i, d, to, c;
    for (s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      pc = b[s];
      if (!pc || (pc >> 3) !== side) continue;
      t = pc & 7;
      if (t === P) {
        var fw = side ? -16 : 16, r = s >> 4, last = side ? 1 : 6;
        to = s + fw;
        if (!b[to]) {
          if (r === last) { out.push(mk(s, to, Q, 0)); if (!capsOnly) { out.push(mk(s, to, N, 0)); out.push(mk(s, to, R, 0)); out.push(mk(s, to, B, 0)); } }
          else if (!capsOnly) { out.push(mk(s, to, 0, 0)); if (r === (side ? 6 : 1) && !b[to + fw]) out.push(mk(s, to + fw, 0, F_DOUBLE)); }
        }
        for (i = -1; i <= 1; i += 2) {
          to = s + fw + i;
          if (to & 0x88) continue;
          c = b[to];
          if (c && (c >> 3) !== side) {
            if (r === last) { out.push(mk(s, to, Q, F_CAP)); if (!capsOnly) { out.push(mk(s, to, N, F_CAP)); out.push(mk(s, to, R, F_CAP)); out.push(mk(s, to, B, F_CAP)); } }
            else out.push(mk(s, to, 0, F_CAP));
          } else if (to === this.ep && !c) out.push(mk(s, to, 0, F_CAP | F_EP));
        }
      } else if (t === N || t === K) {
        var offs = t === N ? KN_OFF : KI_OFF;
        for (i = 0; i < 8; i++) {
          to = s + offs[i];
          if (to & 0x88) continue;
          c = b[to];
          if (!c) { if (!capsOnly) out.push(mk(s, to, 0, 0)); }
          else if ((c >> 3) !== side) out.push(mk(s, to, 0, F_CAP));
        }
        if (t === K && !capsOnly && this.castle) {
          var home = side ? 116 : 4, ks = side ? 4 : 1, qs = side ? 8 : 2, op = side ^ 1;
          if (s === home) {
            if ((this.castle & ks) && !b[s + 1] && !b[s + 2] && b[s + 3] === (R | cb) && !this.attacked(s, op) && !this.attacked(s + 1, op)) out.push(mk(s, s + 2, 0, F_CASTLE));
            if ((this.castle & qs) && !b[s - 1] && !b[s - 2] && !b[s - 3] && b[s - 4] === (R | cb) && !this.attacked(s, op) && !this.attacked(s - 1, op)) out.push(mk(s, s - 2, 0, F_CASTLE));
          }
        }
      } else {
        var dirs = t === B ? BI_OFF : t === R ? RO_OFF : KI_OFF, nd = dirs.length;
        for (i = 0; i < nd; i++) {
          d = dirs[i]; to = s + d;
          while (!(to & 0x88)) {
            c = b[to];
            if (!c) { if (!capsOnly) out.push(mk(s, to, 0, 0)); }
            else { if ((c >> 3) !== side) out.push(mk(s, to, 0, F_CAP)); break; }
            to += d;
          }
        }
      }
    }
    return out;
  };
  // Make m if it is legal (returns true, the move stays made), else leave the position as it was.
  Pos.prototype.tryMake = function (m) {
    this.make(m);
    if (this.attacked(this.kings[this.side ^ 1], this.side)) { this.unmake(); return false; }
    return true;
  };
  Pos.prototype.legalMoves = function () {
    var ms = this.gen([], false), out = [];
    for (var i = 0; i < ms.length; i++) if (this.tryMake(ms[i])) { out.push(ms[i]); this.unmake(); }
    return out;
  };
  Pos.prototype.hasLegal = function () {
    var ms = this.gen([], false);
    for (var i = 0; i < ms.length; i++) if (this.tryMake(ms[i])) { this.unmake(); return true; }
    return false;
  };
  // Has this position occurred before (same side to move, since the last irreversible move)?
  Pos.prototype.isRep = function () {
    var hl = this.hl, hh = this.hh, n = hl.length, stop = Math.max(0, n - this.half);
    for (var i = n - 2; i >= stop; i -= 2) if (hl[i] === this.lo && hh[i] === this.hi) return true;
    return false;
  };
  Pos.prototype.repCount = function () {
    var hl = this.hl, hh = this.hh, n = hl.length, stop = Math.max(0, n - this.half), c = 1;
    for (var i = n - 2; i >= stop; i -= 2) if (hl[i] === this.lo && hh[i] === this.hi) c++;
    return c;
  };
  Pos.prototype.insufficient = function () {
    var b = this.b, minors = 0, bishops = [0, 0], knights = 0, s, t;
    for (s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      t = b[s] & 7;
      if (!t || t === K) continue;
      if (t === P || t === R || t === Q) return false;
      minors++;
      if (t === N) knights++; else bishops[((s >> 4) + (s & 7)) & 1]++;
    }
    if (minors <= 1) return true;
    return knights === 0 && (bishops[0] === 0 || bishops[1] === 0);   // bishops all on one colour
  };
  Pos.prototype.pieceAt = function (name) { var s = sqParse(name); return s < 0 ? 0 : this.b[s]; };

  // Game state: { over, result, reason, check }
  function status(pos) {
    var chk = pos.inCheck(), any = pos.hasLegal();
    if (!any) return chk ? { over: true, result: pos.side ? '1-0' : '0-1', reason: 'checkmate', check: true, winner: pos.side ^ 1 }
      : { over: true, result: '1/2-1/2', reason: 'stalemate', check: false, winner: -1 };
    if (pos.insufficient()) return { over: true, result: '1/2-1/2', reason: 'insufficient material', check: chk, winner: -1 };
    if (pos.half >= 100) return { over: true, result: '1/2-1/2', reason: 'fifty-move rule', check: chk, winner: -1 };
    if (pos.repCount() >= 3) return { over: true, result: '1/2-1/2', reason: 'threefold repetition', check: chk, winner: -1 };
    return { over: false, result: '*', reason: '', check: chk, winner: -1 };
  }

  // ---- notation ----
  function toUCI(m) { var p = mPromo(m); return sqName(mFrom(m)) + sqName(mTo(m)) + (p ? 'nbrq'.charAt(p - 2) : ''); }
  function fromUCI(pos, s) {
    s = String(s || '').toLowerCase();
    var f = sqParse(s.slice(0, 2)), t = sqParse(s.slice(2, 4)), pr = s.length > 4 ? 'nbrq'.indexOf(s.charAt(4)) + 2 : 0;
    if (f < 0 || t < 0) return 0;
    var ms = pos.legalMoves();
    for (var i = 0; i < ms.length; i++) if (mFrom(ms[i]) === f && mTo(ms[i]) === t && mPromo(ms[i]) === (pr > 1 ? pr : 0)) return ms[i];
    return 0;
  }
  // SAN of a legal move m in pos (with + / #).
  function toSAN(pos, m, legal) {
    var from = mFrom(m), to = mTo(m), pc = pos.b[from], t = pc & 7, fl = mFlags(m), s;
    if (fl & F_CASTLE) s = to > from ? 'O-O' : 'O-O-O';
    else {
      var cap = fl & F_CAP;
      if (t === P) s = (cap ? 'abcdefgh'.charAt(from & 7) + 'x' : '') + sqName(to) + (mPromo(m) ? '=' + 'NBRQ'.charAt(mPromo(m) - 2) : '');
      else {
        legal = legal || pos.legalMoves();
        var amb = false, sameF = false, sameR = false;
        for (var i = 0; i < legal.length; i++) {
          var o = legal[i], of = mFrom(o);
          if (o === m || of === from || mTo(o) !== to || pos.b[of] !== pc) continue;
          amb = true;
          if ((of & 7) === (from & 7)) sameF = true;
          if ((of >> 4) === (from >> 4)) sameR = true;
        }
        var dis = '';
        if (amb) dis = !sameF ? 'abcdefgh'.charAt(from & 7) : !sameR ? String((from >> 4) + 1) : sqName(from);
        s = 'PNBRQK'.charAt(t - 1) + dis + (cap ? 'x' : '') + sqName(to);
      }
    }
    pos.make(m);
    if (pos.inCheck()) s += pos.hasLegal() ? '+' : '#';
    pos.unmake();
    return s;
  }
  function fromSAN(pos, san) {
    var clean = String(san || '').replace(/[+#!?]/g, '').replace(/^0-0-0$/, 'O-O-O').replace(/^0-0$/, 'O-O').trim();
    if (!clean) return 0;
    var ms = pos.legalMoves();
    for (var i = 0; i < ms.length; i++) if (toSAN(pos, ms[i], ms).replace(/[+#]/g, '') === clean) return ms[i];
    // lenient: a missing "=" before the promotion piece, or a long-algebraic / UCI move
    var alt = clean.replace(/([a-h][18])([NBRQ])$/, '$1=$2');
    for (i = 0; i < ms.length; i++) if (toSAN(pos, ms[i], ms).replace(/[+#]/g, '') === alt) return ms[i];
    return fromUCI(pos, clean.replace(/[-x=]/g, ''));
  }

  function perft(pos, depth) {
    if (depth === 0) return 1;
    var ms = pos.gen([], false), n = 0;
    for (var i = 0; i < ms.length; i++) {
      if (!pos.tryMake(ms[i])) continue;
      n += depth === 1 ? 1 : perft(pos, depth - 1);
      pos.unmake();
    }
    return n;
  }

  // ================= evaluation =================
  // Piece-square tables, written from White's side with rank 8 on top (a8 first).
  var PST_MG = {}, PST_EG = {};
  PST_MG[P] = [
    0, 0, 0, 0, 0, 0, 0, 0,
    55, 62, 62, 68, 68, 62, 62, 55,
    18, 22, 30, 38, 38, 30, 22, 18,
    4, 8, 14, 26, 26, 14, 8, 4,
    0, 2, 8, 22, 22, 6, 2, 0,
    4, 0, 2, 6, 6, -4, 0, 4,
    2, 6, 6, -16, -16, 8, 8, 2,
    0, 0, 0, 0, 0, 0, 0, 0];
  PST_EG[P] = [
    0, 0, 0, 0, 0, 0, 0, 0,
    90, 90, 85, 80, 80, 85, 90, 90,
    55, 55, 50, 45, 45, 50, 55, 55,
    30, 28, 24, 20, 20, 24, 28, 30,
    16, 14, 12, 10, 10, 12, 14, 16,
    6, 6, 4, 4, 4, 4, 6, 6,
    2, 2, 2, 2, 2, 2, 2, 2,
    0, 0, 0, 0, 0, 0, 0, 0];
  PST_MG[N] = [
    -60, -40, -30, -30, -30, -30, -40, -60,
    -40, -20, 0, 4, 4, 0, -20, -40,
    -30, 4, 12, 16, 16, 12, 4, -30,
    -30, 6, 16, 22, 22, 16, 6, -30,
    -30, 2, 14, 20, 20, 14, 2, -30,
    -30, 4, 10, 14, 14, 10, 4, -30,
    -40, -20, 0, 4, 4, 0, -20, -40,
    -55, -32, -30, -30, -30, -30, -32, -55];
  PST_EG[N] = [
    -50, -36, -28, -26, -26, -28, -36, -50,
    -36, -18, -6, 0, 0, -6, -18, -36,
    -28, -6, 6, 12, 12, 6, -6, -28,
    -26, 0, 12, 18, 18, 12, 0, -26,
    -26, 0, 12, 18, 18, 12, 0, -26,
    -28, -6, 6, 12, 12, 6, -6, -28,
    -36, -18, -6, 0, 0, -6, -18, -36,
    -50, -36, -28, -26, -26, -28, -36, -50];
  PST_MG[B] = [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 6, 10, 10, 6, 0, -10,
    -10, 6, 6, 12, 12, 6, 6, -10,
    -10, 2, 12, 12, 12, 12, 2, -10,
    -10, 10, 10, 8, 8, 10, 10, -10,
    -10, 12, 2, 2, 2, 2, 12, -10,
    -20, -10, -14, -10, -10, -14, -10, -20];
  PST_EG[B] = [
    -14, -8, -8, -6, -6, -8, -8, -14,
    -8, 0, 0, 2, 2, 0, 0, -8,
    -8, 0, 6, 8, 8, 6, 0, -8,
    -6, 2, 8, 12, 12, 8, 2, -6,
    -6, 2, 8, 12, 12, 8, 2, -6,
    -8, 0, 6, 8, 8, 6, 0, -8,
    -8, 0, 0, 2, 2, 0, 0, -8,
    -14, -8, -8, -6, -6, -8, -8, -14];
  PST_MG[R] = [
    4, 6, 8, 10, 10, 8, 6, 4,
    18, 22, 22, 24, 24, 22, 22, 18,
    -4, 0, 2, 4, 4, 2, 0, -4,
    -6, -2, 0, 2, 2, 0, -2, -6,
    -6, -2, 0, 2, 2, 0, -2, -6,
    -6, -2, 0, 2, 2, 0, -2, -6,
    -8, -4, 0, 2, 2, 0, -4, -8,
    -4, -2, 2, 8, 8, 6, -2, -4];
  PST_EG[R] = [
    8, 8, 8, 8, 8, 8, 8, 8,
    12, 12, 12, 12, 12, 12, 12, 12,
    4, 4, 4, 4, 4, 4, 4, 4,
    2, 2, 2, 2, 2, 2, 2, 2,
    0, 0, 0, 0, 0, 0, 0, 0,
    -2, -2, -2, -2, -2, -2, -2, -2,
    -4, -4, -4, -4, -4, -4, -4, -4,
    -4, -2, 0, 0, 0, 0, -2, -4];
  PST_MG[Q] = [
    -18, -10, -8, -4, -4, -8, -10, -18,
    -10, -4, 0, 2, 2, 0, -4, -10,
    -8, 0, 4, 4, 4, 4, 0, -8,
    -4, 0, 4, 4, 4, 4, 0, -4,
    -4, 0, 4, 4, 4, 4, 0, -4,
    -8, 2, 4, 4, 4, 4, 2, -8,
    -10, -2, 2, 2, 2, 2, -2, -10,
    -18, -10, -8, 0, -4, -8, -10, -18];
  PST_EG[Q] = [
    -16, -8, -6, -4, -4, -6, -8, -16,
    -8, 0, 4, 6, 6, 4, 0, -8,
    -6, 4, 8, 10, 10, 8, 4, -6,
    -4, 6, 10, 14, 14, 10, 6, -4,
    -4, 6, 10, 14, 14, 10, 6, -4,
    -6, 4, 8, 10, 10, 8, 4, -6,
    -8, 0, 4, 6, 6, 4, 0, -8,
    -16, -8, -6, -4, -4, -6, -8, -16];
  PST_MG[K] = [
    -40, -46, -46, -54, -54, -46, -46, -40,
    -40, -46, -46, -54, -54, -46, -46, -40,
    -40, -46, -46, -54, -54, -46, -46, -40,
    -36, -42, -42, -50, -50, -42, -42, -36,
    -26, -34, -34, -42, -42, -34, -34, -26,
    -14, -22, -24, -28, -28, -24, -22, -14,
    14, 14, -6, -12, -12, -6, 16, 14,
    16, 30, 10, -6, 0, 8, 32, 18];
  PST_EG[K] = [
    -50, -36, -28, -22, -22, -28, -36, -50,
    -32, -14, -4, 0, 0, -4, -14, -32,
    -26, -4, 16, 22, 22, 16, -4, -26,
    -24, 0, 22, 30, 30, 22, 0, -24,
    -24, 0, 22, 30, 30, 22, 0, -24,
    -26, -4, 16, 22, 22, 16, -4, -26,
    -32, -16, -4, 0, 0, -4, -16, -32,
    -50, -36, -28, -24, -24, -28, -36, -50];
  // flattened [piece code * 128 + sq] → value (incl. material), both phases
  var MG_V = [0, 82, 330, 360, 480, 1000, 0], EG_V = [0, 100, 290, 310, 520, 950, 0];
  var TMG = new Int16Array(16 * 128), TEG = new Int16Array(16 * 128);
  (function () {
    for (var t = 1; t <= 6; t++) for (var s = 0; s < 128; s++) {
      if (s & 0x88) continue;
      var r = s >> 4, f = s & 7, wi = (7 - r) * 8 + f, bi = r * 8 + f;
      TMG[t * 128 + s] = MG_V[t] + PST_MG[t][wi]; TEG[t * 128 + s] = EG_V[t] + PST_EG[t][wi];
      TMG[(t | BLACK) * 128 + s] = MG_V[t] + PST_MG[t][bi]; TEG[(t | BLACK) * 128 + s] = EG_V[t] + PST_EG[t][bi];
    }
  })();
  var PHASE = [0, 0, 1, 1, 2, 4, 0];
  var PASSED_MG = [0, 4, 8, 14, 24, 40, 60, 0], PASSED_EG = [0, 10, 16, 28, 48, 80, 130, 0];
  var pcnt = new Int8Array(16), wMin = new Int8Array(8), bMax = new Int8Array(8);
  function centerDist(s) { var r = s >> 4, f = s & 7; return Math.max(3 - r, r - 4) + Math.max(3 - f, f - 4); }

  // Static evaluation, centipawns from the side to move's view.
  function evaluate(pos) {
    var b = pos.b, s, pc, t, c, r, f, mgW = 0, mgB = 0, egW = 0, egB = 0, phase = 0;
    var bishW = 0, bishB = 0, matW = 0, matB = 0, pawnsW = 0, pawnsB = 0;
    for (f = 0; f < 8; f++) { pcnt[f] = 0; pcnt[f + 8] = 0; wMin[f] = 9; bMax[f] = -1; }
    for (s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      pc = b[s];
      if (!pc) continue;
      t = pc & 7;
      if (pc < BLACK) { mgW += TMG[pc * 128 + s]; egW += TEG[pc * 128 + s]; }
      else { mgB += TMG[pc * 128 + s]; egB += TEG[pc * 128 + s]; }
      phase += PHASE[t];
      if (t === P) {
        r = s >> 4; f = s & 7;
        if (pc < BLACK) { pcnt[f]++; pawnsW++; if (r < wMin[f]) wMin[f] = r; }
        else { pcnt[f + 8]++; pawnsB++; if (r > bMax[f]) bMax[f] = r; }
      } else if (t !== K) {
        if (pc < BLACK) { matW += VAL[t]; if (t === B) bishW++; } else { matB += VAL[t]; if (t === B) bishB++; }
      }
    }
    // pawn structure, rooks on files
    for (s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      pc = b[s];
      if (!pc) continue;
      t = pc & 7; f = s & 7; r = s >> 4;
      if (t === P) {
        if (pc < BLACK) {
          var passW = true;
          for (c = Math.max(0, f - 1); c <= Math.min(7, f + 1); c++) if (bMax[c] > r) { passW = false; break; }
          if (passW) { mgW += PASSED_MG[r]; egW += PASSED_EG[r]; }
          if ((f === 0 || !pcnt[f - 1]) && (f === 7 || !pcnt[f + 1])) { mgW -= 10; egW -= 14; }
        } else {
          var passB = true;
          for (c = Math.max(0, f - 1); c <= Math.min(7, f + 1); c++) if (wMin[c] < r) { passB = false; break; }
          if (passB) { mgB += PASSED_MG[7 - r]; egB += PASSED_EG[7 - r]; }
          if ((f === 0 || !pcnt[f + 7]) && (f === 7 || !pcnt[f + 9])) { mgB -= 10; egB -= 14; }
        }
      } else if (t === R) {
        if (pc < BLACK) { if (!pcnt[f]) { var ow = pcnt[f + 8] ? 8 : 18; mgW += ow; egW += ow >> 1; } }
        else if (!pcnt[f + 8]) { var ob = pcnt[f] ? 8 : 18; mgB += ob; egB += ob >> 1; }
      }
    }
    for (f = 0; f < 8; f++) {
      if (pcnt[f] > 1) { mgW -= 8 * (pcnt[f] - 1); egW -= 16 * (pcnt[f] - 1); }
      if (pcnt[f + 8] > 1) { mgB -= 8 * (pcnt[f + 8] - 1); egB -= 16 * (pcnt[f + 8] - 1); }
    }
    if (bishW >= 2) { mgW += 25; egW += 40; }
    if (bishB >= 2) { mgB += 25; egB += 40; }
    // king shelter: own pawns in front of a castled-looking king
    mgW += shelter(b, pos.kings[0], 0); mgB += shelter(b, pos.kings[1], 1);
    if (phase > 24) phase = 24;
    var sc = ((mgW - mgB) * phase + (egW - egB) * (24 - phase)) / 24;
    // mop-up: drive a lone king to the edge and walk the king in
    if (pawnsB === 0 && matB <= 330 && matW - matB >= 400) sc += mopUp(pos.kings[1], pos.kings[0]);
    else if (pawnsW === 0 && matW <= 330 && matB - matW >= 400) sc -= mopUp(pos.kings[0], pos.kings[1]);
    // no pawns and only a minor piece up: it can't win
    if (sc > 0 && pawnsW === 0 && matW - matB < 400) sc /= 8;
    else if (sc < 0 && pawnsB === 0 && matB - matW < 400) sc /= 8;
    sc = sc | 0;
    return (pos.side ? -sc : sc) + 10;
  }
  function shelter(b, ks, side) {
    var r = ks >> 4, f = ks & 7, home = side ? 7 : 0, fw = side ? -16 : 16, pawn = P | (side << 3), v = 0;
    if (r !== home || (f > 2 && f < 5)) return 0;
    for (var c = Math.max(0, f - 1); c <= Math.min(7, f + 1); c++) {
      var s1 = ks - f + c + fw;
      if (b[s1] === pawn) v += 12; else if (b[s1 + fw] === pawn) v += 6; else v -= 10;
    }
    return v;
  }
  function mopUp(loser, winner) {
    var dr = Math.abs((loser >> 4) - (winner >> 4)), df = Math.abs((loser & 7) - (winner & 7));
    return 12 * centerDist(loser) + 5 * (14 - dr - df);
  }

  // ================= search =================
  var TT_BITS = 18, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
  var TTL = new Int32Array(TT_SIZE), TTH = new Int32Array(TT_SIZE), TTM = new Int32Array(TT_SIZE);
  var TTS = new Int16Array(TT_SIZE), TTD = new Int8Array(TT_SIZE), TTF = new Int8Array(TT_SIZE);
  var EXACT = 1, LOWER = 2, UPPER = 3;
  var KILL = new Int32Array(MAXPLY * 2), HIST = new Int32Array(16 * 128);
  var SR = { nodes: 0, stop: false, deadline: 0, maxNodes: 0, rootBest: 0, rootScore: 0 };
  function now() { return Date.now(); }
  function clearTT() { TTL.fill(0); TTH.fill(0); TTM.fill(0); TTD.fill(0); TTF.fill(0); }
  function toTT(s, ply) { return s > MATE - 1000 ? s + ply : s < -MATE + 1000 ? s - ply : s; }
  function fromTT(s, ply) { return s > MATE - 1000 ? s - ply : s < -MATE + 1000 ? s + ply : s; }
  function tick() {
    if ((++SR.nodes & 1023) === 0) {
      if ((SR.deadline && now() >= SR.deadline) || (SR.maxNodes && SR.nodes >= SR.maxNodes)) SR.stop = true;
    }
    return SR.stop;
  }
  function hasPieces(pos, side) {
    var b = pos.b;
    for (var s = 0; s < 128; s++) { if (s & 0x88) { s += 7; continue; } var pc = b[s]; if (pc && (pc >> 3) === side && (pc & 7) > P && (pc & 7) < K) return true; }
    return false;
  }
  // Order scores, in parallel to the move list.
  function scoreMoves(pos, ms, sc, ttMove, ply) {
    var b = pos.b, k1 = KILL[ply * 2], k2 = KILL[ply * 2 + 1];
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i], fl = m >> 17;
      if (m === ttMove) sc[i] = 2000000;
      else if (fl & F_CAP) { var v = fl & F_EP ? P : b[(m >> 7) & 127] & 7; sc[i] = 1000000 + VAL[v] * 10 - (b[m & 127] & 7); }
      else if ((m >> 14) & 7) sc[i] = 900000 + ((m >> 14) & 7);
      else if (m === k1) sc[i] = 800000;
      else if (m === k2) sc[i] = 700000;
      else sc[i] = HIST[b[m & 127] * 128 + ((m >> 7) & 127)];
    }
  }
  function pick(ms, sc, i) {
    var bi = i, bs = sc[i];
    for (var j = i + 1; j < ms.length; j++) if (sc[j] > bs) { bs = sc[j]; bi = j; }
    if (bi !== i) { var t = ms[i]; ms[i] = ms[bi]; ms[bi] = t; t = sc[i]; sc[i] = sc[bi]; sc[bi] = t; }
    return ms[i];
  }
  function qsearch(pos, alpha, beta, ply) {
    if (tick()) return 0;
    var chk = pos.inCheck(), best = -INF, sp = 0;
    if (!chk) {
      sp = evaluate(pos);
      if (sp >= beta || ply >= MAXPLY - 1) return sp;
      if (sp > alpha) alpha = sp;
      best = sp;
    } else if (ply >= MAXPLY - 1) return evaluate(pos);
    var ms = pos.gen([], !chk), sc = [], legal = 0;
    scoreMoves(pos, ms, sc, 0, ply);
    for (var i = 0; i < ms.length; i++) {
      var m = pick(ms, sc, i);
      if (!chk && !((m >> 14) & 7)) {
        var fl = m >> 17, v = fl & F_EP ? P : pos.b[(m >> 7) & 127] & 7;
        if (sp + VAL[v] + 200 < alpha) continue;         // delta pruning
      }
      if (!pos.tryMake(m)) continue;
      legal++;
      var s = -qsearch(pos, -beta, -alpha, ply + 1);
      pos.unmake();
      if (SR.stop) return 0;
      if (s > best) { best = s; if (s > alpha) { alpha = s; if (s >= beta) break; } }
    }
    if (chk && !legal) return -MATE + ply;
    return best;
  }
  function negamax(pos, depth, alpha, beta, ply, nullOk) {
    if (tick()) return 0;
    var chk = pos.inCheck();
    if (ply > 0) {
      if (pos.half >= 100 || pos.isRep()) return 0;
      var ma = -MATE + ply, mb = MATE - ply - 1;
      if (alpha < ma) alpha = ma;
      if (beta > mb) beta = mb;
      if (alpha >= beta) return alpha;
    }
    if (chk && ply < MAXPLY / 2) depth++;
    if (depth <= 0) return qsearch(pos, alpha, beta, ply);
    if (ply >= MAXPLY - 1) return evaluate(pos);
    var idx = pos.lo & TT_MASK, ttMove = 0, pv = beta - alpha > 1;
    if (TTL[idx] === pos.lo && TTH[idx] === pos.hi) {
      ttMove = TTM[idx];
      if (ply > 0 && !pv && TTD[idx] >= depth) {
        var ts = fromTT(TTS[idx], ply), tf = TTF[idx];
        if (tf === EXACT || (tf === LOWER && ts >= beta) || (tf === UPPER && ts <= alpha)) return ts;
      }
    }
    if (nullOk && !pv && !chk && depth >= 3 && ply > 0 && beta < MATE - 1000 && hasPieces(pos, pos.side) && evaluate(pos) >= beta) {
      pos.makeNull();
      var ns = -negamax(pos, depth - 3 - (depth > 6 ? 1 : 0), -beta, -beta + 1, ply + 1, false);
      pos.unmakeNull();
      if (SR.stop) return 0;
      if (ns >= beta) return beta;
    }
    var ms = pos.gen([], false), sc = [], legal = 0, best = -INF, bestM = 0, a0 = alpha;
    scoreMoves(pos, ms, sc, ttMove, ply);
    for (var i = 0; i < ms.length; i++) {
      var m = pick(ms, sc, i);
      if (!pos.tryMake(m)) continue;
      legal++;
      var quiet = !((m >> 17) & F_CAP) && !((m >> 14) & 7), s;
      if (legal === 1) s = -negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
      else {
        var red = 0;
        if (depth >= 3 && quiet && !chk && legal > 3 && sc[i] < 700000 && !pos.inCheck()) red = legal > 10 && depth > 4 ? 2 : 1;
        s = -negamax(pos, depth - 1 - red, -alpha - 1, -alpha, ply + 1, true);
        if (s > alpha && !SR.stop && (red || s < beta)) s = -negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
      }
      pos.unmake();
      if (SR.stop) return 0;
      if (s > best) {
        best = s; bestM = m;
        if (ply === 0) { SR.rootBest = m; SR.rootScore = s; }
        if (s > alpha) {
          alpha = s;
          if (s >= beta) {
            if (quiet) {
              if (KILL[ply * 2] !== m) { KILL[ply * 2 + 1] = KILL[ply * 2]; KILL[ply * 2] = m; }
              var hi = pos.b[m & 127] * 128 + ((m >> 7) & 127);
              HIST[hi] += depth * depth;
              if (HIST[hi] > 400000) for (var h = 0; h < HIST.length; h++) HIST[h] >>= 1;
            }
            break;
          }
        }
      }
    }
    if (!legal) return chk ? -MATE + ply : 0;
    TTL[idx] = pos.lo; TTH[idx] = pos.hi; TTM[idx] = bestM; TTS[idx] = toTT(best, ply); TTD[idx] = depth;
    TTF[idx] = best <= a0 ? UPPER : best >= beta ? LOWER : EXACT;
    return best;
  }
  function pvLine(pos, first, max) {
    var line = [first], made = 0;
    if (!pos.tryMake(first)) return line;
    made++;
    while (line.length < max) {
      var idx = pos.lo & TT_MASK;
      if (TTL[idx] !== pos.lo || TTH[idx] !== pos.hi || !TTM[idx]) break;
      var m = TTM[idx], ok = false, lm = pos.legalMoves();
      for (var i = 0; i < lm.length; i++) if (lm[i] === m) ok = true;
      if (!ok || pos.isRep()) break;
      pos.make(m); made++; line.push(m);
    }
    while (made--) pos.unmake();
    return line;
  }

  // Computer levels: depth / time caps and how loose its choice is (cp noise).
  var LEVELS = [
    { id: 1, name: 'Novice', depth: 1, time: 250, noise: 260, blunder: 0.2 },
    { id: 2, name: 'Casual', depth: 2, time: 350, noise: 110, blunder: 0.08 },
    { id: 3, name: 'Club', depth: 3, time: 500, noise: 40, blunder: 0 },
    { id: 4, name: 'Strong', depth: 64, time: 700, noise: 0, blunder: 0 },
    { id: 5, name: 'Expert', depth: 64, time: 1500, noise: 0, blunder: 0 },
    { id: 6, name: 'Master', depth: 64, time: 3000, noise: 0, blunder: 0 }
  ];

  // Search pos. opts: { time ms, depth, nodes, noise cp, blunder p, rand fn, variety cp }.
  // Returns { move, score, depth, nodes, pv:[moves], mate: n (moves, signed) or 0 } or null when there's no legal move.
  function search(pos, opts) {
    opts = opts || {};
    var rand = opts.rand || Math.random, legal = pos.legalMoves();
    if (!legal.length) return null;
    var maxD = Math.max(1, Math.min(opts.depth || 64, 64)), t0 = now();
    SR.nodes = 0; SR.stop = false; SR.maxNodes = opts.nodes || 0;
    SR.deadline = opts.time ? t0 + opts.time : 0;
    KILL.fill(0);
    for (var h = 0; h < HIST.length; h++) HIST[h] >>= 2;
    var best = legal[0], bestS = 0, done = 0, d;
    if (opts.noise || opts.blunder) {
      // a loose player: score every move a few plies deep, then choose with noise
      var dd = maxD, sc = [];
      SR.deadline = 0; SR.maxNodes = 0;
      for (var i = 0; i < legal.length; i++) {
        pos.make(legal[i]);
        var s = pos.isRep() || pos.half >= 100 ? 0 : -negamax(pos, dd - 1, -INF, INF, 1, true);
        pos.unmake();
        sc.push(s);
      }
      var bi = 0, bv = -INF, top = Math.max.apply(null, sc);
      var noise = opts.noise || 0;
      if (opts.blunder && rand() < opts.blunder) noise *= 3;
      for (i = 0; i < legal.length; i++) {
        if (top >= MATE - 100 && sc[i] < MATE - 100) continue;       // never miss a mate it saw
        var v = sc[i] + (rand() - 0.5) * 2 * noise;
        if (v > bv) { bv = v; bi = i; }
      }
      return { move: legal[bi], score: sc[bi], depth: dd, nodes: SR.nodes, pv: [legal[bi]], mate: mateIn(sc[bi]), time: now() - t0 };
    }
    for (d = 1; d <= maxD; d++) {
      SR.rootBest = 0;
      var sd = negamax(pos, d, -INF, INF, 0, false);
      if (SR.rootBest && (!SR.stop || SR.rootScore > -INF)) { best = SR.rootBest; bestS = SR.stop ? SR.rootScore : sd; }
      if (SR.stop) break;
      done = d;
      if (Math.abs(sd) >= MATE - 100 && d >= (MATE - Math.abs(sd)) + 1) break;   // a mate is proven
      if (legal.length === 1 && d >= 2) break;
      if (SR.deadline && now() - t0 > (SR.deadline - t0) * 0.55) break;          // the next ply won't finish
    }
    // a little variety in the opening for the strong levels
    if (opts.variety && pos.hl.length < 10) {
      var cands = [];
      for (i = 0; i < legal.length && cands.length < 4; i++) {
        pos.make(legal[i]);
        var idx = pos.lo & TT_MASK;
        if (TTL[idx] === pos.lo && TTH[idx] === pos.hi && TTF[idx] === EXACT) { var vs = -fromTT(TTS[idx], 1); if (vs >= bestS - opts.variety) cands.push(legal[i]); }
        pos.unmake();
      }
      if (cands.length > 1) best = cands[Math.floor(rand() * cands.length)];
    }
    return { move: best, score: bestS, depth: Math.max(done, 1), nodes: SR.nodes, pv: pvLine(pos, best, 12), mate: mateIn(bestS), time: now() - t0 };
  }
  function mateIn(s) {
    if (s >= MATE - 200) return Math.ceil((MATE - s) / 2);
    if (s <= -MATE + 200) return -Math.ceil((MATE + s) / 2);
    return 0;
  }
  function levelOpts(level, timeCap) {
    var L = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, (level | 0) - 1))];
    var t = L.time;
    if (timeCap && timeCap > 0) t = Math.max(80, Math.min(t, timeCap));
    return { depth: L.depth, time: t, noise: L.noise, blunder: L.blunder, variety: L.noise ? 0 : 18 };
  }

  // ================= mate solver (exact) =================
  // mateAttack: can the side to move force mate within n of its moves?
  function mateAttack(pos, n, memo) {
    var key = pos.lo + ',' + pos.hi + ',' + n;
    if (memo && memo.has(key)) return memo.get(key);
    var ms = pos.gen([], false), quiet = [], i, m, res = false;
    for (i = 0; i < ms.length && !res; i++) {
      m = ms[i];
      if (!pos.tryMake(m)) continue;
      if (pos.inCheck()) res = n === 1 ? !pos.hasLegal() : mateDefend(pos, n, memo);
      else if (n > 1) quiet.push(m);
      pos.unmake();
    }
    for (i = 0; i < quiet.length && !res; i++) {
      pos.make(quiet[i]);
      res = mateDefend(pos, n, memo);
      pos.unmake();
    }
    if (memo) memo.set(key, res);
    return res;
  }
  // After the attacker's move: is every defence mated within n - 1 more attacker moves?
  function mateDefend(pos, n, memo) {
    var ms = pos.gen([], false), any = false;
    for (var i = 0; i < ms.length; i++) {
      if (!pos.tryMake(ms[i])) continue;
      any = true;
      var ok = n > 1 && !pos.insufficient() && mateAttack(pos, n - 1, memo);
      pos.unmake();
      if (!ok) return false;
    }
    return any ? true : pos.inCheck();
  }
  // Fewest moves to a forced mate for the side to move (≤ maxN), else 0.
  function mateDistance(pos, maxN, memo) {
    memo = memo || new Map();
    for (var n = 1; n <= maxN; n++) if (mateAttack(pos, n, memo)) return n;
    return 0;
  }
  // The first moves that force mate within n.
  function mateMoves(pos, n, memo) {
    memo = memo || new Map();
    var ms = pos.legalMoves(), out = [];
    for (var i = 0; i < ms.length; i++) {
      pos.make(ms[i]);
      if (mateDefend(pos, n, memo)) out.push(ms[i]);
      pos.unmake();
    }
    return out;
  }
  // For the attacker: the move that mates fastest (within n). For the defender
  // (after the attacker's move): the reply that holds out longest. Returns {move, n}.
  function bestAttack(pos, n, memo) {
    memo = memo || new Map();
    for (var k = 1; k <= n; k++) { var ms = mateMoves(pos, k, memo); if (ms.length) return { move: ms[0], n: k, all: ms }; }
    return null;
  }
  function bestDefence(pos, n, memo) {
    memo = memo || new Map();
    var ms = pos.legalMoves(), best = null, bestK = -1;
    for (var i = 0; i < ms.length; i++) {
      pos.make(ms[i]);
      var k = 0;
      for (var j = 1; j <= n; j++) if (mateAttack(pos, j, memo)) { k = j; break; }
      if (!k) k = 99;                    // escapes (shouldn't happen in a sound puzzle)
      var cap = (ms[i] >> 17) & F_CAP;
      pos.unmake();
      if (k > bestK || (k === bestK && cap && best && !((best >> 17) & F_CAP))) { bestK = k; best = ms[i]; }
    }
    return best ? { move: best, n: bestK } : null;
  }
  // Check a mate-in-n puzzle: a forced mate in exactly n, the first move unique.
  function verifyPuzzle(fen, n) {
    var pos = fromFEN(fen), memo = new Map();
    if (pos.attacked(pos.kings[pos.side ^ 1], pos.side)) return { ok: false, why: 'side not to move is in check' };
    if (n > 1 && mateAttack(pos, n - 1, memo)) return { ok: false, why: 'shorter mate exists' };
    var ms = mateMoves(pos, n, memo);
    if (ms.length !== 1) return { ok: false, why: ms.length ? 'first move not unique (' + ms.length + ')' : 'no forced mate' };
    return { ok: true, move: ms[0], uci: toUCI(ms[0]) };
  }
  // The main line of a mate-in-n puzzle: first move, longest defence, fastest mate, ...
  function solutionLine(fen, n) {
    var pos = fromFEN(fen), memo = new Map(), line = [], left = n;
    while (left > 0) {
      var a = bestAttack(pos, left, memo);
      if (!a) break;
      line.push(toUCI(a.move)); pos.make(a.move); left = a.n - 1;
      if (left <= 0 || !pos.hasLegal()) break;
      var d = bestDefence(pos, left, memo);
      if (!d) break;
      line.push(toUCI(d.move)); pos.make(d.move);
    }
    return line;
  }

  // ================= game record helpers =================
  // Replay uci moves from a FEN; returns { pos, sans, moves } or null on a bad move.
  function replay(fen, ucis) {
    var pos;
    try { pos = fromFEN(fen || START_FEN); } catch (e) { return null; }
    var sans = [], moves = [];
    for (var i = 0; i < (ucis || []).length; i++) {
      var m = fromUCI(pos, ucis[i]);
      if (!m) return null;
      sans.push(toSAN(pos, m)); moves.push(m);
      pos.make(m);
    }
    return { pos: pos, sans: sans, moves: moves };
  }
  function pgn(info) {
    // info: { white, black, result, date 'YYYY.MM.DD', fen, sans, event }
    var startPos = fromFEN(info.fen || START_FEN), tags = [
      ['Event', info.event || 'Casual game'], ['Site', 'Cade.txt'], ['Date', info.date || '????.??.??'], ['Round', '-'],
      ['White', info.white || 'White'], ['Black', info.black || 'Black'], ['Result', info.result || '*']];
    if (info.fen && info.fen !== START_FEN) { tags.push(['SetUp', '1']); tags.push(['FEN', info.fen]); }
    if (info.termination) tags.push(['Termination', info.termination]);
    var out = tags.map(function (t) { return '[' + t[0] + ' "' + String(t[1]).replace(/"/g, "'") + '"]'; }).join('\n') + '\n\n';
    var toks = [], num = startPos.full, side = startPos.side;
    (info.sans || []).forEach(function (s, i) {
      if (side === 0) toks.push(num + '.');
      else if (i === 0) toks.push(num + '...');
      toks.push(s);
      if (side === 1) num++;
      side ^= 1;
    });
    toks.push(info.result || '*');
    var line = '', lines = [];
    toks.forEach(function (t) { if (line.length + t.length + 1 > 79) { lines.push(line); line = t; } else line = line ? line + ' ' + t : t; });
    if (line) lines.push(line);
    return out + lines.join('\n') + '\n';
  }
  // Material of each side (pawn = 1 …) and the captured pieces, from the board.
  // `base`: the game's start position (default: the standard one) — what's missing since then was captured.
  function counts(pos) {
    var have = [[0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]];
    for (var s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      var pc = pos.b[s];
      if (pc && (pc & 7) !== K) have[pc >> 3][pc & 7]++;
    }
    return have;
  }
  var STD_COUNTS = [[0, 8, 2, 2, 2, 1, 0], [0, 8, 2, 2, 2, 1, 0]];
  function material(pos, base) {
    var have = counts(pos), start = base ? counts(base) : STD_COUNTS, pts = [0, 0], PV = [0, 1, 3, 3, 5, 9, 0], cap = [[], []];
    for (var c = 0; c < 2; c++) {
      for (var t = 1; t <= 5; t++) pts[c] += have[c][t] * PV[t];
      // a promoted piece stands in for its pawn: count a missing pawn only if it isn't now a piece
      var extra = 0;
      for (t = 2; t <= 5; t++) extra += Math.max(0, have[c][t] - start[c][t]);
      for (t = 5; t >= 1; t--) {
        var gone = start[c][t] - have[c][t];
        if (t === 1) gone -= extra;
        for (var k = 0; k < gone; k++) cap[c].push(t);
      }
    }
    return { pts: pts, diff: pts[0] - pts[1], captured: cap };
  }

  var ENGINE = {
    P: P, N: N, B: B, R: R, Q: Q, K: K, BLACK: BLACK, F_CAP: F_CAP, F_EP: F_EP, F_CASTLE: F_CASTLE, F_DOUBLE: F_DOUBLE,
    MATE: MATE, START_FEN: START_FEN, LEVELS: LEVELS,
    Pos: Pos, fromFEN: fromFEN, sqName: sqName, sqParse: sqParse,
    mFrom: mFrom, mTo: mTo, mPromo: mPromo, mFlags: mFlags,
    toUCI: toUCI, fromUCI: fromUCI, toSAN: toSAN, fromSAN: fromSAN, perft: perft, status: status,
    evaluate: evaluate, search: search, levelOpts: levelOpts, clearTT: clearTT, mateIn: mateIn,
    mateAttack: mateAttack, mateDefend: mateDefend, mateDistance: mateDistance, mateMoves: mateMoves,
    bestAttack: bestAttack, bestDefence: bestDefence, verifyPuzzle: verifyPuzzle, solutionLine: solutionLine,
    replay: replay, pgn: pgn, material: material, rng: rng
  };

  // Worker requests: { id, fen, moves:[uci], opts } → { id, uci, score, mate, depth, nodes, pv:[uci], time }
  function handle(msg) {
    var r = replay(msg.fen, msg.moves);
    if (!r) return { id: msg.id, error: 'bad position' };
    var opts = msg.opts || {};
    if (opts.level) { var lo = levelOpts(opts.level, opts.timeCap); for (var k in lo) if (opts[k] == null) opts[k] = lo[k]; }
    var res = search(r.pos, opts);
    if (!res) return { id: msg.id, uci: null };
    return { id: msg.id, uci: toUCI(res.move), score: res.score, mate: res.mate, depth: res.depth, nodes: res.nodes, time: res.time, pv: res.pv.map(toUCI) };
  }
  ENGINE.handle = handle;

  if (typeof module !== 'undefined' && module.exports) { module.exports = ENGINE; return; }
  if (typeof window === 'undefined' && typeof self !== 'undefined' && typeof importScripts === 'function') {
    self.onmessage = function (e) {
      var out;
      try { out = handle(e.data || {}); } catch (err) { out = { id: (e.data || {}).id, error: String(err && err.message || err) }; }
      self.postMessage(out);
    };
    return;
  }
  if (typeof window !== 'undefined') window.__cadeChessEngine = ENGINE;
})();
