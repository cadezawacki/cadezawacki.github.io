/* QR core — the QR Model 2 encoder and the decoder loaders, shared by the
 * QR Code widget (qr.js) and Beam's QR stream (../beam/beam-qr.js).
 *
 * ENCODER: a compact, self-contained QR Model 2 encoder (ISO/IEC 18004):
 * numeric / alphanumeric / byte (UTF-8) single-segment, versions 1–40, all
 * four ECC levels, automatic mask selection by the standard penalty rules.
 * encode(text, ecl, { minVersion, mask }) → { size, version, ecl, mask, mode,
 * bytes, modules: [y][x] booleans }; throws Error('too long') when no version
 * holds it. maxChars(version, ecl, mode) is the matching capacity table.
 *
 * DECODER: the native BarcodeDetector when it supports QR, else jsQR
 * lazy-loaded from a pinned CDN URL on first need (the only network use).
 * decodeSource(src, w, h, maxDim, invert, holder) → Promise<text | null>;
 * `holder.frame` caches the scratch canvas between calls.
 *
 * UMD: window.__cadeQRCore in the browser, module.exports in node (the
 * encoder is pure; the decoder helpers need a DOM). Not a widget itself. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__cadeQRCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pinned fallback decoder (only fetched when BarcodeDetector can't do QR).
  var JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';

  // =================================================================== encoder
  var ECL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
  var ECL_FORMAT_BITS = [1, 0, 3, 2];          // L, M, Q, H as stored in format info
  // ECC codewords per block and number of blocks, [ecl][version] (index 0 unused).
  var ECC_PER_BLOCK = [
    [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  var NUM_BLOCKS = [
    [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];
  var ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  // Mode indicator + character-count bit widths for versions 1–9 / 10–26 / 27–40.
  var MODES = {
    num: { ind: 1, cc: [10, 12, 14] },
    alnum: { ind: 2, cc: [9, 11, 13] },
    byte: { ind: 4, cc: [8, 16, 16] }
  };

  // GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
  var GF_EXP = new Array(512), GF_LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      GF_EXP[i] = x; GF_LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();
  function gfMul(a, b) { return (a && b) ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0; }

  var _genCache = {};
  // Reed–Solomon generator polynomial ∏(x − α^i), i < deg; coefficients
  // highest degree first, leading 1 included.
  function rsGenerator(deg) {
    if (_genCache[deg]) return _genCache[deg];
    var g = [1];
    for (var i = 0; i < deg; i++) {
      var ng = [];
      for (var k = 0; k <= g.length; k++) ng.push(0);
      for (var j = 0; j < g.length; j++) {
        ng[j] ^= g[j];
        ng[j + 1] ^= gfMul(g[j], GF_EXP[i]);
      }
      g = ng;
    }
    return (_genCache[deg] = g);
  }
  function rsRemainder(data, gen) {
    var deg = gen.length - 1, res = [], i, j;
    for (i = 0; i < deg; i++) res.push(0);
    for (i = 0; i < data.length; i++) {
      var f = data[i] ^ res.shift();
      res.push(0);
      if (f) for (j = 0; j < deg; j++) res[j] ^= gfMul(gen[j + 1], f);
    }
    return res;
  }

  function numRawDataModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var na = Math.floor(ver / 7) + 2;
      r -= (25 * na - 10) * na - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  function numDataCodewords(ver, e) {
    return Math.floor(numRawDataModules(ver) / 8) - ECC_PER_BLOCK[e][ver] * NUM_BLOCKS[e][ver];
  }
  function alignPositions(ver) {
    if (ver === 1) return [];
    var n = Math.floor(ver / 7) + 2;
    var step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
    var out = [6];
    for (var pos = ver * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
    return out;
  }

  function utf8Bytes(s) {
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(s));
    var bin = unescape(encodeURIComponent(s)), out = [];
    for (var i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
    return out;
  }

  // Pick the most compact single mode for the whole string.
  function makeSegment(text) {
    if (/^[0-9]*$/.test(text)) return { mode: 'num', n: text.length, text: text };
    var alnum = true;
    for (var i = 0; i < text.length; i++) if (ALNUM.indexOf(text.charAt(i)) < 0) { alnum = false; break; }
    if (alnum) return { mode: 'alnum', n: text.length, text: text };
    var bytes = utf8Bytes(text);
    return { mode: 'byte', n: bytes.length, bytes: bytes };
  }
  function ccBits(mode, ver) { return MODES[mode].cc[ver <= 9 ? 0 : ver <= 26 ? 1 : 2]; }
  function segmentBits(seg, ver) {
    var cc = ccBits(seg.mode, ver);
    if (seg.n >= (1 << cc)) return Infinity;
    var n = seg.n, b;
    if (seg.mode === 'num') b = Math.floor(n / 3) * 10 + [0, 4, 7][n % 3];
    else if (seg.mode === 'alnum') b = Math.floor(n / 2) * 11 + (n % 2) * 6;
    else b = n * 8;
    return 4 + cc + b;
  }

  // Most characters (bytes for 'byte') one segment of `mode` holds at this
  // version + ECC level — the standard capacity table.
  function maxChars(ver, eclName, mode) {
    var e = ECL_INDEX[eclName] != null ? ECL_INDEX[eclName] : 1;
    mode = MODES[mode] ? mode : 'byte';
    var bits = numDataCodewords(ver, e) * 8 - 4 - ccBits(mode, ver), n;
    if (mode === 'num') n = Math.floor(bits / 10) * 3 + (bits % 10 >= 7 ? 2 : bits % 10 >= 4 ? 1 : 0);
    else if (mode === 'alnum') n = Math.floor(bits / 11) * 2 + (bits % 11 >= 6 ? 1 : 0);
    else n = Math.floor(bits / 8);
    return Math.min(n, (1 << ccBits(mode, ver)) - 1);
  }

  // Encode text → { size, version, ecl, mask, mode, bytes, modules: [y][x] booleans }.
  // Throws Error('too long') when no version holds it.
  function encode(text, eclName, opts) {
    opts = opts || {};
    var e = ECL_INDEX[eclName] != null ? ECL_INDEX[eclName] : 1;
    var seg = makeSegment(String(text));
    var ver, used;
    for (ver = Math.max(1, opts.minVersion || 1); ver <= 40; ver++) {
      used = segmentBits(seg, ver);
      if (used <= numDataCodewords(ver, e) * 8) break;
    }
    if (ver > 40) throw new Error('too long');

    // ---- data bits
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(MODES[seg.mode].ind, 4);
    put(seg.n, ccBits(seg.mode, ver));
    var i, t = seg.text;
    if (seg.mode === 'num') {
      for (i = 0; i < t.length; i += 3) {
        var chunk = t.substr(i, 3);
        put(parseInt(chunk, 10), chunk.length * 3 + 1);
      }
    } else if (seg.mode === 'alnum') {
      for (i = 0; i + 1 < t.length; i += 2) put(ALNUM.indexOf(t.charAt(i)) * 45 + ALNUM.indexOf(t.charAt(i + 1)), 11);
      if (t.length % 2) put(ALNUM.indexOf(t.charAt(t.length - 1)), 6);
    } else {
      for (i = 0; i < seg.bytes.length; i++) put(seg.bytes[i], 8);
    }
    var capBits = numDataCodewords(ver, e) * 8;
    put(0, Math.min(4, capBits - bits.length));          // terminator
    put(0, (8 - bits.length % 8) % 8);                    // byte align
    for (var pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
    var data = [];
    for (i = 0; i < bits.length; i += 8) {
      var by = 0;
      for (var k = 0; k < 8; k++) by = (by << 1) | bits[i + k];
      data.push(by);
    }

    // ---- split into blocks, append ECC, interleave
    var nb = NUM_BLOCKS[e][ver], eccLen = ECC_PER_BLOCK[e][ver];
    var raw = Math.floor(numRawDataModules(ver) / 8);
    var numShort = nb - raw % nb, shortLen = Math.floor(raw / nb);
    var gen = rsGenerator(eccLen), blocks = [], off = 0;
    for (i = 0; i < nb; i++) {
      var dl = shortLen - eccLen + (i < numShort ? 0 : 1);
      var dat = data.slice(off, off + dl);
      off += dl;
      var ecc = rsRemainder(dat, gen);
      if (i < numShort) dat.push(0);                     // placeholder, skipped below
      blocks.push(dat.concat(ecc));
    }
    var cw = [];
    for (i = 0; i < blocks[0].length; i++) {
      for (var j = 0; j < nb; j++) {
        if (i !== shortLen - eccLen || j >= numShort) cw.push(blocks[j][i]);
      }
    }

    // ---- matrix
    var size = ver * 4 + 17;
    var mod = [], fn = [];
    for (i = 0; i < size; i++) {
      mod.push(new Array(size)); fn.push(new Array(size));
      for (j = 0; j < size; j++) { mod[i][j] = false; fn[i][j] = false; }
    }
    function setF(x, y, dark) { mod[y][x] = dark; fn[y][x] = true; }
    for (i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        var d = Math.max(Math.abs(dx), Math.abs(dy));
        setF(x, y, d !== 2 && d !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    var ap = alignPositions(ver), na = ap.length;
    for (i = 0; i < na; i++) for (j = 0; j < na; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
      for (var ay = -2; ay <= 2; ay++) for (var ax = -2; ax <= 2; ax++) {
        setF(ap[i] + ax, ap[j] + ay, Math.max(Math.abs(ax), Math.abs(ay)) !== 1);
      }
    }
    function formatBits(mask) {
      var b = formatWord(e, mask);
      var g = function (n) { return ((b >>> n) & 1) !== 0; };
      for (var q = 0; q <= 5; q++) setF(8, q, g(q));
      setF(8, 7, g(6)); setF(8, 8, g(7)); setF(7, 8, g(8));
      for (q = 9; q < 15; q++) setF(14 - q, 8, g(q));
      for (q = 0; q < 8; q++) setF(size - 1 - q, 8, g(q));
      for (q = 8; q < 15; q++) setF(8, size - 15 + q, g(q));
      setF(8, size - 8, true);                            // the dark module
    }
    formatBits(0);                                        // reserve the areas
    if (ver >= 7) {
      var vb = versionWord(ver);
      for (i = 0; i < 18; i++) {
        var bit = ((vb >>> i) & 1) !== 0, a = size - 11 + i % 3, b2 = Math.floor(i / 3);
        setF(a, b2, bit); setF(b2, a, bit);
      }
    }
    // Zig-zag data placement, two columns at a time from the bottom right.
    var bi = 0, total = cw.length * 8;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      var up = ((right + 1) & 2) === 0;
      for (var v = 0; v < size; v++) {
        var y = up ? size - 1 - v : v;
        for (k = 0; k < 2; k++) {
          var x = right - k;
          if (fn[y][x]) continue;
          if (bi < total) { mod[y][x] = ((cw[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0; bi++; }
        }
      }
    }

    // ---- mask selection
    function applyMask(m) {
      for (var yy = 0; yy < size; yy++) for (var xx = 0; xx < size; xx++) {
        if (!fn[yy][xx] && maskFn(m, xx, yy)) mod[yy][xx] = !mod[yy][xx];
      }
    }
    var best = -1, bestScore = Infinity;
    var forced = (opts.mask >= 0 && opts.mask <= 7) ? opts.mask : -1;
    for (var m = 0; m < 8; m++) {
      if (forced >= 0 && m !== forced) continue;
      applyMask(m); formatBits(m);
      var sc = forced >= 0 ? 0 : penalty(mod, size);
      if (sc < bestScore) { bestScore = sc; best = m; }
      applyMask(m);                                       // XOR undoes it
    }
    applyMask(best); formatBits(best);
    return { size: size, version: ver, ecl: eclName in ECL_INDEX ? eclName : 'M', mask: best, mode: seg.mode, bytes: seg.n, modules: mod };
  }

  // 15-bit format word (BCH(15,5), XOR-masked) for ECC index + mask.
  function formatWord(e, mask) {
    var d = (ECL_FORMAT_BITS[e] << 3) | mask, r = d;
    for (var q = 0; q < 10; q++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    return ((d << 10) | r) ^ 0x5412;
  }
  // 18-bit version word (BCH(18,6)) for versions 7–40.
  function versionWord(ver) {
    var vr = ver;
    for (var i = 0; i < 12; i++) vr = (vr << 1) ^ ((vr >>> 11) * 0x1f25);
    return (ver << 12) | vr;
  }
  function maskFn(m, x, y) {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }

  // Standard penalty score (rules N1–N4); lower is better.
  var FP_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], FP_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  function penalty(mod, size) {
    var score = 0, dark = 0, x, y, i, run, c, line = new Array(size);
    for (var pass = 0; pass < 2; pass++) {
      for (y = 0; y < size; y++) {
        for (x = 0; x < size; x++) line[x] = pass ? (mod[x][y] ? 1 : 0) : (mod[y][x] ? 1 : 0);
        run = 1;
        for (x = 1; x <= size; x++) {
          if (x < size && line[x] === line[x - 1]) run++;
          else { if (run >= 5) score += run - 2; run = 1; }
        }
        for (x = 0; x + 11 <= size; x++) {
          var ma = true, mb = true;
          for (i = 0; i < 11 && (ma || mb); i++) {
            c = line[x + i];
            if (c !== FP_A[i]) ma = false;
            if (c !== FP_B[i]) mb = false;
          }
          if (ma) score += 40;
          if (mb) score += 40;
        }
      }
    }
    for (y = 0; y < size; y++) {
      for (x = 0; x < size; x++) {
        if (mod[y][x]) dark++;
        if (x < size - 1 && y < size - 1) {
          var d = mod[y][x];
          if (d === mod[y][x + 1] && d === mod[y + 1][x] && d === mod[y + 1][x + 1]) score += 3;
        }
      }
    }
    var tot = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - tot * 10) / tot) - 1) * 10;
    return score;
  }

  // ================================================================= rendering
  function drawQR(canvas, qr, scale, margin, dark, light) {
    var n = qr.size + margin * 2, px = n * scale;
    if (canvas.width !== px) canvas.width = px;
    if (canvas.height !== px) canvas.height = px;
    var g = canvas.getContext('2d');
    g.fillStyle = light; g.fillRect(0, 0, px, px);
    g.fillStyle = dark;
    for (var y = 0; y < qr.size; y++) {
      var row = qr.modules[y], x = 0;
      while (x < qr.size) {
        if (!row[x]) { x++; continue; }
        var s = x;
        while (x < qr.size && row[x]) x++;
        g.fillRect((s + margin) * scale, (y + margin) * scale, (x - s) * scale, scale);
      }
    }
  }
  function toSVG(qr, margin, dark, light, px) {
    var n = qr.size + margin * 2, d = '';
    for (var y = 0; y < qr.size; y++) {
      var row = qr.modules[y], x = 0;
      while (x < qr.size) {
        if (!row[x]) { x++; continue; }
        var s = x;
        while (x < qr.size && row[x]) x++;
        d += 'M' + (s + margin) + ' ' + (y + margin) + 'h' + (x - s) + 'v1h-' + (x - s) + 'z';
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" width="' + px + '" height="' + px +
      '" shape-rendering="crispEdges"><rect width="' + n + '" height="' + n + '" fill="' + light + '"/><path fill="' + dark + '" d="' + d + '"/></svg>';
  }
  // Integer pixels-per-module so modules stay crisp; ≥ 1.
  function scaleFor(qr, margin, px) { return Math.max(1, Math.round(px / (qr.size + margin * 2))); }

  // ================================================================== decoder
  var jsqrLoading = null;
  function loadJsQR() {
    if (typeof window.jsQR === 'function') return Promise.resolve(window.jsQR);
    if (jsqrLoading) return jsqrLoading;
    jsqrLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = JSQR_URL;
      s.async = true;
      s.onload = function () {
        if (typeof window.jsQR === 'function') resolve(window.jsQR);
        else { jsqrLoading = null; reject(new Error('decoder missing')); }
      };
      s.onerror = function () { jsqrLoading = null; s.remove(); reject(new Error('decoder failed to load')); };
      document.head.appendChild(s);
    });
    return jsqrLoading;
  }

  var _detector;        // undefined = not probed; null = unavailable
  function getDetector() {
    if (_detector !== undefined) return Promise.resolve(_detector);
    if (typeof window.BarcodeDetector !== 'function') { _detector = null; return Promise.resolve(null); }
    var fmts = window.BarcodeDetector.getSupportedFormats ? window.BarcodeDetector.getSupportedFormats() : Promise.resolve(['qr_code']);
    return Promise.resolve(fmts).then(function (list) {
      _detector = (list && list.indexOf('qr_code') >= 0) ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
      return _detector;
    }, function () { _detector = null; return null; });
  }
  // A detector that threw on detect() is dropped for good (jsQR from then on).
  function dropDetector() { _detector = null; }

  // Decode a drawable source (video / image / bitmap) → text or null.
  function decodeSource(src, w, h, maxDim, invert, holder) {
    return getDetector().then(function (det) {
      if (det) {
        return det.detect(src).then(function (codes) {
          for (var i = 0; i < codes.length; i++) if (codes[i] && codes[i].rawValue != null) return String(codes[i].rawValue);
          return null;
        }, function () { _detector = null; return decodeWithJsQR(src, w, h, maxDim, invert, holder); });
      }
      return decodeWithJsQR(src, w, h, maxDim, invert, holder);
    });
  }
  function decodeWithJsQR(src, w, h, maxDim, invert, holder) {
    return loadJsQR().then(function (jsQR) {
      if (!w || !h) return null;
      return jsqrRegion(jsQR, src, null, w, h, maxDim, invert, holder);
    });
  }
  // Synchronous jsQR pass over `src` (or the rect r = [sx, sy, sw, sh] of it),
  // downscaled so the longer side is ≤ maxDim, on holder.frame (made on demand).
  function jsqrRegion(jsQR, src, r, w, h, maxDim, invert, holder) {
    var sw = r ? r[2] : w, sh = r ? r[3] : h;
    var s = Math.min(1, maxDim / Math.max(sw, sh));
    var cw = Math.max(1, Math.round(sw * s)), ch = Math.max(1, Math.round(sh * s));
    var c = holder && holder.frame ? holder.frame : document.createElement('canvas');
    if (holder && !holder.frame) holder.frame = c;
    if (c.width !== cw) c.width = cw;
    if (c.height !== ch) c.height = ch;
    var g = c.getContext('2d', { willReadFrequently: true });
    if (r) g.drawImage(src, r[0], r[1], r[2], r[3], 0, 0, cw, ch);
    else g.drawImage(src, 0, 0, cw, ch);
    var img = g.getImageData(0, 0, cw, ch);
    var res = jsQR(img.data, cw, ch, { inversionAttempts: invert ? 'attemptBoth' : 'dontInvert' });
    return res ? res.data : null;
  }

  return {
    JSQR_URL: JSQR_URL,
    ECL_INDEX: ECL_INDEX,
    ALNUM: ALNUM,
    encode: encode,
    maxChars: maxChars,
    numDataCodewords: numDataCodewords,
    formatWord: formatWord,
    versionWord: versionWord,
    penalty: penalty,
    drawQR: drawQR,
    toSVG: toSVG,
    scaleFor: scaleFor,
    loadJsQR: loadJsQR,
    getDetector: getDetector,
    dropDetector: dropDetector,
    decodeSource: decodeSource,
    decodeWithJsQR: decodeWithJsQR,
    jsqrRegion: jsqrRegion
  };
});
