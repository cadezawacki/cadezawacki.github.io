/* Beam QR stream — core: the wire format and fountain code behind
 * beam-qr.js (moving a file between two screens as an animated QR code read
 * by the other device's camera, no network). Pure; no DOM.
 *
 * PAYLOAD: the file bytes, deflate-raw compressed when that is smaller
 * (CompressionStream; raw otherwise), split into K source blocks of B bytes
 * (B a multiple of 4; the last block zero-padded). A small metadata record
 * (name, mime, original size, CRC32 of the original bytes, compressed flag)
 * travels alongside, in pieces, in every frame header.
 *
 * FOUNTAIN: frames are numbered x = 0, 1, 2, … for ever. x < K is the
 * systematic block x; x ≥ K is an LT symbol — the XOR of a pseudo-random
 * subset of blocks drawn from a mulberry32 PRNG seeded with x: its size from
 * a robust soliton distribution, or, for K ≤ 400, a uniformly random subset
 * (a random linear fountain, which elimination decodes from ≈ K + 2 symbols
 * whatever was missed). Nothing about the schedule is shared state, so a
 * receiver can join at any frame, miss any number of them and see them out
 * of order. The receiver peels (a symbol with one unknown block reveals it)
 * and finishes the last ≤ 400 unknown blocks by Gaussian elimination over
 * GF(2); it is done once all K blocks are known. The distribution uses only
 * IEEE + − × ÷ and sqrt (no Math.log, which engines may round differently),
 * so every browser derives the identical subset from a seed.
 *
 * FRAME (big-endian), then Base45 (RFC 9285) so the QR code can use its
 * ALPHANUMERIC mode (5.5 bits per character):
 *   0  u8  magic + version 0xB1      11 u32 x (block index < K ≤ LT seed)
 *   1  u32 transfer id               15 u8  meta piece index m (= x mod pieces)
 *   5  u32 L, payload length         16 u8  MC, meta piece size
 *   9  u16 B, block size             17 MC  meta piece, then B symbol bytes,
 *                                           then u32 CRC32 of everything before
 * K = max(1, ceil(L / B)). The meta stream is [len][flags][size u32][crc u32]
 * [nameLen][name][mimeLen][mime]; when a whole transfer fits one frame the
 * piece is the whole stream.
 *
 * UMD: module.exports in node, window.__cadeBeamQRCore in the browser. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__cadeBeamQRCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAGIC = 0xB1;
  var HEAD = 17, TAIL = 4, MC_DEFAULT = 8;
  var MAX_L = 26 * 1024 * 1024;         // receiver refuses bigger payloads (sender caps files at 25 MB)
  var NAME_MAX = 120, MIME_MAX = 60;    // UTF-8 bytes kept in the meta record
  // Robust soliton parameters (tuned by simulation; see the overhead tests).
  var LT_C = 0.05, LT_DELTA = 0.5;
  // Gaussian elimination budget: transfers of ≤ DENSE_MAX blocks use dense
  // symbols decoded by elimination; bigger ones peel, and eliminate once
  // ≤ GE_MAX blocks are left.
  var DENSE_MAX = 400, GE_MAX = 400;

  // Density presets → QR version + ECC level; frame rates.
  var DENSITY = {
    S: { ver: 15, ecl: 'M', label: 'S' },
    M: { ver: 22, ecl: 'M', label: 'M' },
    L: { ver: 30, ecl: 'L', label: 'L' }
  };
  var SPEEDS = [4, 6, 10];

  // ==================================================================== Base45
  var B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  var B45_REV = [];
  (function () {
    for (var i = 0; i < 128; i++) B45_REV.push(-1);
    for (i = 0; i < 45; i++) B45_REV[B45.charCodeAt(i)] = i;
  })();
  function b45len(n) { return Math.floor(n / 2) * 3 + (n % 2) * 2; }
  // Most bytes whose Base45 text fits in `chars` characters.
  function bytesForChars(chars) { return Math.floor(chars / 3) * 2 + (chars % 3 === 2 ? 1 : 0); }
  function b45encode(bytes) {
    var n = bytes.length, codes = [], out = '', v, i;
    for (i = 0; i + 1 < n; i += 2) {
      v = bytes[i] * 256 + bytes[i + 1];
      codes.push(B45.charCodeAt(v % 45), B45.charCodeAt(Math.floor(v / 45) % 45), B45.charCodeAt(Math.floor(v / 2025)));
      if (codes.length >= 8190) { out += String.fromCharCode.apply(null, codes); codes = []; }
    }
    if (n % 2) { v = bytes[n - 1]; codes.push(B45.charCodeAt(v % 45), B45.charCodeAt(Math.floor(v / 45))); }
    return out + String.fromCharCode.apply(null, codes);
  }
  function b45val(str, i) {
    var c = str.charCodeAt(i), v = c < 128 ? B45_REV[c] : -1;
    if (v < 0) throw new Error('base45');
    return v;
  }
  // Throws Error('base45') on a character outside the alphabet, a dangling
  // single character, or a group whose value doesn't fit.
  function b45decode(str) {
    str = String(str);
    var n = str.length;
    if (n % 3 === 1) throw new Error('base45');
    var out = new Uint8Array(Math.floor(n / 3) * 2 + (n % 3 === 2 ? 1 : 0)), o = 0, v;
    for (var i = 0; i < n; i += 3) {
      if (i + 2 < n) {
        v = b45val(str, i) + b45val(str, i + 1) * 45 + b45val(str, i + 2) * 2025;
        if (v > 65535) throw new Error('base45');
        out[o++] = v >> 8; out[o++] = v & 255;
      } else {
        v = b45val(str, i) + b45val(str, i + 1) * 45;
        if (v > 255) throw new Error('base45');
        out[o++] = v;
      }
    }
    return out;
  }

  // ===================================================================== CRC32
  var CRC_T = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, start, end) {
    var c = 0xFFFFFFFF, i = start || 0, e = end == null ? bytes.length : end;
    for (; i < e; i++) c = CRC_T[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ================================================================== helpers
  function utf8(s) { return new TextEncoder().encode(String(s)); }
  function unutf8(b) { return new TextDecoder().decode(b); }
  function w16(a, o, v) { a[o] = (v >>> 8) & 255; a[o + 1] = v & 255; }
  function w32(a, o, v) { a[o] = (v >>> 24) & 255; a[o + 1] = (v >>> 16) & 255; a[o + 2] = (v >>> 8) & 255; a[o + 3] = v & 255; }
  function r16(a, o) { return (a[o] << 8) | a[o + 1]; }
  function r32(a, o) { return ((a[o] << 24) | (a[o + 1] << 16) | (a[o + 2] << 8) | a[o + 3]) >>> 0; }
  function pad4(n) { return (n + 3) & ~3; }
  function randomTid() {
    try {
      var a = new Uint32Array(1);
      (typeof crypto !== 'undefined' ? crypto : self.crypto).getRandomValues(a);
      return a[0];
    } catch (e) { return (Math.random() * 4294967296) >>> 0; }
  }
  // Shorten a name to ≤ max UTF-8 bytes, keeping its extension.
  function clipName(name, max) {
    name = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '');
    if (utf8(name).length <= max) return name;
    var dot = name.lastIndexOf('.'), ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    var base = Array.from ? Array.from(ext ? name.slice(0, dot) : name) : (ext ? name.slice(0, dot) : name).split('');
    while (base.length && utf8(base.join('') + ext).length > max) base.pop();
    return base.join('') + ext;
  }

  // ===================================================================== meta
  function packMeta(m) {
    var name = utf8(clipName(m.name || 'file', NAME_MAX));
    var mime = utf8(clipName(m.mime || 'application/octet-stream', MIME_MAX));
    var len = 1 + 4 + 4 + 1 + name.length + 1 + mime.length;
    var out = new Uint8Array(1 + len), o = 0;
    out[o++] = len;
    out[o++] = m.compressed ? 1 : 0;
    w32(out, o, m.size >>> 0); o += 4;
    w32(out, o, m.crc >>> 0); o += 4;
    out[o++] = name.length; out.set(name, o); o += name.length;
    out[o++] = mime.length; out.set(mime, o);
    return out;
  }
  // The stream as packed above (length byte first) → record; throws Error('meta').
  function unpackMeta(s) {
    var len = s[0];
    if (!len || s.length < 1 + len || len < 11) throw new Error('meta');
    var o = 1, flags = s[o++];
    var size = r32(s, o); o += 4;
    var crc = r32(s, o); o += 4;
    var nl = s[o++];
    if (o + nl + 1 > 1 + len) throw new Error('meta');
    var name = unutf8(s.subarray(o, o + nl)); o += nl;
    var ml = s[o++];
    if (o + ml !== 1 + len) throw new Error('meta');
    var mime = unutf8(s.subarray(o, o + ml));
    return { compressed: !!(flags & 1), size: size, crc: crc, name: name || 'file', mime: mime || 'application/octet-stream' };
  }

  // ================================================================ transfer
  // Block layout for a payload of L bytes + a meta stream, given how many bytes
  // a frame may hold (capBytes, from the QR version's alphanumeric capacity).
  function plan(L, metaLen, capBytes) {
    var one = HEAD + metaLen + pad4(Math.max(1, L)) + TAIL;
    if (one <= capBytes) return { K: 1, B: pad4(Math.max(1, L)), MC: metaLen };
    var MC = Math.min(MC_DEFAULT, metaLen);
    var Bmax = (capBytes - HEAD - MC - TAIL) & ~3;
    if (Bmax < 16) throw new Error('capacity');
    var K = Math.max(1, Math.ceil(L / Bmax));
    if (K * Bmax > MAX_L + Bmax) throw new Error('too big');
    return { K: K, B: pad4(Math.ceil(L / K)), MC: MC };
  }
  function makeTransfer(payload, metaStream, opts) {
    var p = plan(payload.length, metaStream.length, opts.capBytes);
    var blocks = new Uint8Array(p.K * p.B);
    blocks.set(payload);
    return {
      tid: (opts.tid == null ? randomTid() : opts.tid) >>> 0,
      L: payload.length, K: p.K, B: p.B, MC: p.MC,
      meta: metaStream, pieces: Math.ceil(metaStream.length / p.MC),
      frameLen: HEAD + p.MC + p.B + TAIL,
      blocks: blocks
    };
  }
  // file = { bytes: Uint8Array, name, mime } → Promise<transfer>.
  // opts = { capBytes, tid?, compress? (default true) }.
  function prepare(file, opts) {
    var raw = file.bytes, crc = crc32(raw);
    return (opts.compress === false ? Promise.resolve(null) : deflate(raw)).then(function (z) {
      var useZ = !!(z && z.length < raw.length);
      var meta = packMeta({ name: file.name, mime: file.mime, size: raw.length, crc: crc, compressed: useZ });
      var t = makeTransfer(useZ ? z : raw, meta, opts);
      t.size = raw.length; t.compressed = useZ; t.name = file.name; t.mime = file.mime;
      return t;
    });
  }

  // Symbol x of a transfer, XOR-ed into dst at off (dst is zeroed there).
  function symbolInto(t, x, dst, off) {
    var B = t.B, blk = t.blocks;
    if (x < t.K) { dst.set(blk.subarray(x * B, x * B + B), off); return; }
    var idx = ltIndices(t.K, x);
    dst.set(blk.subarray(idx[0] * B, idx[0] * B + B), off);
    for (var j = 1; j < idx.length; j++) {
      var s = idx[j] * B;
      for (var i = 0; i < B; i++) dst[off + i] ^= blk[s + i];
    }
  }
  function frameBytes(t, x) {
    var f = new Uint8Array(t.frameLen), MC = t.MC;
    f[0] = MAGIC;
    w32(f, 1, t.tid); w32(f, 5, t.L); w16(f, 9, t.B); w32(f, 11, x >>> 0);
    var m = x % t.pieces, mo = m * MC;
    f[15] = m; f[16] = MC;
    for (var i = 0; i < MC; i++) f[HEAD + i] = mo + i < t.meta.length ? t.meta[mo + i] : 0;
    symbolInto(t, x, f, HEAD + MC);
    w32(f, HEAD + MC + t.B, crc32(f, 0, HEAD + MC + t.B));
    return f;
  }
  function frameText(t, x) { return b45encode(frameBytes(t, x)); }

  // Text (Base45) or bytes → frame record; throws Error(reason) for anything
  // that isn't an intact Beam frame.
  function parseFrame(input) {
    var f = typeof input === 'string' ? b45decode(input) : input;
    if (f.length < HEAD + TAIL + 4) throw new Error('short');
    if (f[0] !== MAGIC) throw new Error('magic');
    var MC = f[16], B = r16(f, 9);
    if (f.length !== HEAD + MC + B + TAIL) throw new Error('length');
    if (r32(f, HEAD + MC + B) !== crc32(f, 0, HEAD + MC + B)) throw new Error('crc');
    var L = r32(f, 5);
    if (!MC || !B || (B & 3) || L > MAX_L) throw new Error('header');
    return {
      tid: r32(f, 1), L: L, B: B, K: Math.max(1, Math.ceil(L / B)), x: r32(f, 11),
      m: f[15], MC: MC, piece: f.subarray(HEAD, HEAD + MC), data: f.subarray(HEAD + MC, HEAD + MC + B)
    };
  }

  // ======================================================================= LT
  function mix32(h) {
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }
  // mulberry32, seeded through a hash so consecutive seeds don't correlate.
  function prng(seed) {
    var s = mix32((seed ^ 0x9e3779b9) >>> 0) | 0;
    return function () {
      s = (s + 0x6d2b79f5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    };
  }
  // Natural log from + − × ÷ only, so every engine gets the same bits.
  function detLn(x) {
    var k = 0;
    while (x >= 2) { x /= 2; k++; }
    while (x < 1) { x *= 2; k--; }
    var z = (x - 1) / (x + 1), z2 = z * z, term = z, sum = 0;
    for (var n = 1; n < 48; n += 2) { sum += term / n; term *= z2; }
    return 2 * sum + k * 0.6931471805599453;
  }
  var _cdf = {};
  var _cdfKeys = [];
  // Robust soliton CDF over degrees 1..K (cdf[d - 1] = P(degree ≤ d)).
  function degreeCDF(K) {
    if (_cdf[K]) return _cdf[K];
    var R = LT_C * detLn(K / LT_DELTA) * Math.sqrt(K);
    var spike = Math.max(1, Math.min(K, Math.floor(K / R)));
    var lnRd = R > LT_DELTA ? detLn(R / LT_DELTA) : 0;
    var p = new Float64Array(K), sum = 0, d;
    for (d = 1; d <= K; d++) {
      var rho = d === 1 ? 1 / K : 1 / (d * (d - 1));
      var tau = d < spike ? R / (d * K) : d === spike ? R * lnRd / K : 0;
      p[d - 1] = rho + tau; sum += p[d - 1];
    }
    var acc = 0;
    for (d = 0; d < K; d++) { acc += p[d]; p[d] = acc / sum; }
    p[K - 1] = 1;
    if (_cdfKeys.length >= 4) delete _cdf[_cdfKeys.shift()];
    _cdfKeys.push(K);
    return (_cdf[K] = p);
  }
  var _mark = null;
  // The block indices LT symbol `seed` combines (distinct). Up to DENSE_MAX
  // blocks the receiver can afford Gaussian elimination on everything, so a
  // symbol is a uniformly random non-empty subset (a random linear fountain:
  // ≈ K + 2 symbols decode from any mix of frames, and one is nearly always
  // useful to a receiver that is missing only a few blocks). Above that the
  // degree comes from the robust soliton distribution for the peeling decoder.
  function ltIndices(K, seed) {
    if (K <= 1) return [0];
    var rnd = prng(seed), out = [], i, j;
    if (K <= DENSE_MAX) {
      while (!out.length) {
        for (i = 0; i < K; i += 32) {
          var bits = rnd();
          for (j = 0; j < 32 && i + j < K; j++) if ((bits >>> j) & 1) out.push(i + j);
        }
      }
      return out;
    }
    var cdf = degreeCDF(K);
    var u = rnd() / 4294967296, lo = 0, hi = K - 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (u < cdf[mid]) hi = mid; else lo = mid + 1; }
    var d = lo + 1;
    if (!_mark || _mark.length < K) _mark = new Uint8Array(Math.max(K, 1024));
    var pickExcluded = d > K / 2, want = pickExcluded ? K - d : d, picked = [];
    while (picked.length < want) {
      j = Math.floor(rnd() * K / 4294967296);
      if (!_mark[j]) { _mark[j] = 1; picked.push(j); }
    }
    if (pickExcluded) {
      for (i = 0; i < K; i++) if (!_mark[i]) out.push(i);
    } else out = picked;
    for (i = 0; i < picked.length; i++) _mark[picked[i]] = 0;
    return out;
  }

  // =================================================================== peeler
  // Belief-propagation ("peeling") decoder over K blocks of B bytes (B % 4 = 0).
  // A symbol whose unknown neighbours drop to one reveals that block, which
  // is XOR-ed out of every symbol waiting on it, and so on. Peeling alone
  // needs ~1.2–1.6·K symbols for small K, so once few blocks remain unknown
  // (≤ GE_MAX) and there are at least as many stuck symbols as unknowns, a
  // Gaussian elimination over GF(2) finishes the job (≈ K + 2 symbols).
  // add(indices, data) → true if the symbol told us anything new.
  function createPeeler(K, B) {
    var W = B >> 2;
    var buf = new Uint8Array(K * B), buf32 = new Uint32Array(buf.buffer);
    var known = new Uint8Array(K), syms = [], waiters = new Array(K), queue = [], live = [];
    var P = { K: K, B: B, known: 0, buf: buf, pending: 0, complete: false, solves: 0 };
    var nextSolve = 0;
    function xorBlock(d32, j) { var o = j * W; for (var i = 0; i < W; i++) d32[i] ^= buf32[o + i]; }
    function settle() {
      while (queue.length) {
        var it = queue.pop(), j = it[0];
        if (known[j]) continue;
        known[j] = 1; P.known++;
        buf32.set(it[1], j * W);
        var w = waiters[j];
        waiters[j] = null;
        if (!w) continue;
        for (var k = 0; k < w.length; k++) {
          var s = syms[w[k]];
          if (!s) continue;
          xorBlock(s.d, j);
          s.n--; s.xi ^= j;
          if (s.n <= 1) { syms[w[k]] = null; P.pending--; if (s.n === 1) queue.push([s.xi, s.d]); }
        }
      }
      if (P.known === K) { P.complete = true; syms = []; waiters = []; live = []; P.pending = 0; }
    }
    // Reduced row echelon form of the stuck symbols over the unknown blocks;
    // every row left with a single unknown reveals it.
    function solve() {
      var U = [], col = {}, i, j, c, r;
      for (j = 0; j < K; j++) if (!known[j]) { col[j] = U.length; U.push(j); }
      var CW = (U.length + 31) >> 5, rows = [], keep = [];
      for (i = 0; i < live.length; i++) {
        var s = syms[live[i]];
        if (!s) continue;
        keep.push(live[i]);
        var bits = new Uint32Array(CW);
        for (j = 0; j < s.u.length; j++) if (!known[s.u[j]]) { c = col[s.u[j]]; bits[c >> 5] |= 1 << (c & 31); }
        rows.push({ b: bits, d: s.d.slice() });
      }
      live = keep;
      var rank = 0, pc = [];
      for (c = 0; c < U.length && rank < rows.length; c++) {
        var wi = c >> 5, bit = 1 << (c & 31);
        for (r = rank; r < rows.length && !(rows[r].b[wi] & bit); r++);
        if (r === rows.length) continue;
        var t = rows[r]; rows[r] = rows[rank]; rows[rank] = t;
        for (i = 0; i < rows.length; i++) {
          if (i === rank || !(rows[i].b[wi] & bit)) continue;
          var a = rows[i];
          for (j = wi; j < CW; j++) a.b[j] ^= t.b[j];
          for (j = 0; j < W; j++) a.d[j] ^= t.d[j];
        }
        pc.push(c); rank++;
      }
      for (r = 0; r < rank; r++) {
        var only = true, row = rows[r].b, w0 = pc[r] >> 5;
        for (j = 0; j < CW && only; j++) if (row[j] !== (j === w0 ? 1 << (pc[r] & 31) : 0)) only = false;
        if (only) queue.push([U[pc[r]], rows[r].d]);
      }
      P.solves++;
      return U.length - rank;
    }
    function maybeSolve() {
      var unknown = K - P.known;
      if (P.complete || unknown > GE_MAX || P.pending < unknown || P.pending < nextSolve) return;
      var deficit = solve();
      settle();
      // Retry once enough new symbols could cover what was missing.
      nextSolve = P.pending + Math.max(1, deficit);
    }
    P.add = function (idx, data) {
      if (P.complete) return false;
      var d = new Uint32Array(W);
      new Uint8Array(d.buffer).set(data.subarray ? data.subarray(0, B) : data);
      var n = 0, xi = 0, unk = [];
      for (var i = 0; i < idx.length; i++) {
        var j = idx[i];
        if (known[j]) xorBlock(d, j); else { n++; xi ^= j; unk.push(j); }
      }
      if (!n) return false;
      if (n === 1) queue.push([xi, d]);
      else {
        var id = syms.length;
        syms.push({ n: n, xi: xi, d: d, u: unk });
        live.push(id);
        P.pending++;
        for (i = 0; i < unk.length; i++) (waiters[unk[i]] || (waiters[unk[i]] = [])).push(id);
      }
      settle();
      maybeSolve();
      return true;
    };
    P.isKnown = function (j) { return !!known[j]; };
    // For a progress bar: known blocks plus stuck symbols (each one is,
    // roughly, a block's worth of information), short of K until it's done.
    P.progress = function () { return P.complete ? K : Math.min(K - 1, P.known + P.pending); };
    return P;
  }

  // ================================================================= receiver
  // Feed it frames (Base45 text, bytes or parsed records); it follows one
  // transfer at a time, switching when two frames of another one arrive.
  function createReceiver() {
    var R = { tid: null, K: 0, B: 0, L: 0, MC: 0, frames: 0, valid: 0, fresh: 0, dups: 0, bad: 0, meta: null, done: false, peeler: null };
    var seen = {}, pieces = {}, nPieces = 0, other = null;
    function start(f) {
      R.tid = f.tid; R.K = f.K; R.B = f.B; R.L = f.L; R.MC = f.MC;
      R.valid = 0; R.fresh = 0; R.dups = 0; R.meta = null; R.done = false;
      R.peeler = createPeeler(f.K, f.B);
      seen = {}; pieces = {}; nPieces = 0; other = null;
    }
    function takePiece(f) {
      if (R.meta || pieces[f.m]) return;
      pieces[f.m] = f.piece.slice();
      if (!nPieces && pieces[0]) nPieces = Math.ceil((1 + pieces[0][0]) / R.MC);
      if (!nPieces) return;
      for (var i = 0; i < nPieces; i++) if (!pieces[i]) return;
      var s = new Uint8Array(nPieces * R.MC);
      for (i = 0; i < nPieces; i++) s.set(pieces[i], i * R.MC);
      try { R.meta = unpackMeta(s); } catch (e) { pieces = {}; nPieces = 0; }
    }
    function status(f, extra) {
      var st = { ok: true, x: f.x, known: R.peeler.known, progress: R.peeler.progress(), K: R.K, meta: R.meta };
      for (var k in extra) st[k] = extra[k];
      st.done = R.done;
      return st;
    }
    R.push = function (input) {
      R.frames++;
      var f;
      try { f = input && input.data && input.piece ? input : parseFrame(input); } catch (e) { R.bad++; return { ok: false, reason: e.message }; }
      var switched = false;
      if (R.tid === null) { start(f); switched = true; }
      else if (f.tid !== R.tid) {
        if (R.done) return { ok: true, other: true, x: f.x, known: R.K, K: R.K, meta: R.meta, done: true };
        if (!other || other.tid !== f.tid) other = { tid: f.tid, x: f.x };
        if (other.x === f.x) return { ok: true, other: true, x: f.x, known: R.peeler.known, K: R.K, meta: R.meta, done: false };
        start(f); switched = true;
      }
      if (f.L !== R.L || f.B !== R.B || f.MC !== R.MC) { R.bad++; return { ok: false, reason: 'mismatch' }; }
      R.valid++;
      takePiece(f);
      if (seen[f.x]) {
        R.dups++;
        R.done = R.peeler.complete && !!R.meta;
        return status(f, { dup: true, switched: switched });
      }
      seen[f.x] = 1;
      R.fresh++;
      var news = R.peeler.complete ? false : R.peeler.add(f.x < R.K ? [f.x] : ltIndices(R.K, f.x), f.data);
      R.done = R.peeler.complete && !!R.meta;
      return status(f, { fresh: true, useful: news, switched: switched });
    };
    // → Promise<{ bytes, name, mime, size }>; rejects Error('size' | 'checksum' | 'inflate').
    R.finish = function () {
      if (!R.done) return Promise.reject(new Error('incomplete'));
      var meta = R.meta, payload = R.peeler.buf.subarray(0, R.L);
      return (meta.compressed ? inflate(payload) : Promise.resolve(payload.slice())).then(function (bytes) {
        if (bytes.length !== meta.size) throw new Error('size');
        if (crc32(bytes) !== meta.crc) throw new Error('checksum');
        return { bytes: bytes, name: meta.name, mime: meta.mime, size: meta.size };
      });
    };
    return R;
  }

  // ============================================================== compression
  function pipeBytes(bytes, stream) {
    var s = new Blob([bytes]).stream().pipeThrough(stream);
    return new Response(s).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }
  // → Promise<Uint8Array | null> (null: no CompressionStream / it failed).
  function deflate(bytes) {
    var cs;
    try { cs = new CompressionStream('deflate-raw'); } catch (e) { return Promise.resolve(null); }
    return pipeBytes(bytes, cs).catch(function () { return null; });
  }
  function inflate(bytes) {
    var ds;
    try { ds = new DecompressionStream('deflate-raw'); } catch (e) { return Promise.reject(new Error('inflate')); }
    return pipeBytes(bytes, ds).catch(function () { throw new Error('inflate'); });
  }

  // =============================================================== estimates
  // Frame capacity in bytes for a density preset, given qr-core's maxChars.
  function capBytesFor(density, maxChars) {
    var d = DENSITY[density] || DENSITY.M;
    return bytesForChars(maxChars(d.ver, d.ecl, 'alnum'));
  }
  // { bps, passSec } — payload bytes per second and one systematic pass.
  function estimate(t, fps) { return { bps: t.B * fps, passSec: t.K / fps }; }

  return {
    MAGIC: MAGIC, HEAD: HEAD, TAIL: TAIL, MC_DEFAULT: MC_DEFAULT, MAX_L: MAX_L,
    DENSITY: DENSITY, SPEEDS: SPEEDS, LT_C: LT_C, LT_DELTA: LT_DELTA,
    b45encode: b45encode, b45decode: b45decode, b45len: b45len, bytesForChars: bytesForChars,
    crc32: crc32, utf8: utf8, clipName: clipName,
    packMeta: packMeta, unpackMeta: unpackMeta,
    plan: plan, makeTransfer: makeTransfer, prepare: prepare,
    frameBytes: frameBytes, frameText: frameText, parseFrame: parseFrame,
    prng: prng, detLn: detLn, degreeCDF: degreeCDF, ltIndices: ltIndices,
    createPeeler: createPeeler, createReceiver: createReceiver,
    deflate: deflate, inflate: inflate,
    capBytesFor: capBytesFor, estimate: estimate, randomTid: randomTid
  };
});
