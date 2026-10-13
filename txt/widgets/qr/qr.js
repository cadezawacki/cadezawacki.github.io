/* QR Code — generate and scan QR codes.
 *
 * GENERATE: a text box prefilled from the selection (or the URL / word under
 * the cursor), or a preset form (Wi-Fi, email, phone, SMS, vCard) that builds
 * the standard payload string. Live preview; error correction L/M/Q/H, export
 * size, quiet-zone margin and dark/light colours (default black on white —
 * the most scannable). Insert into the document as an image, copy the PNG
 * (ClipboardItem), download PNG, or copy / download SVG.
 *
 * Insert reuses the core's embedded-image pipeline exactly like the
 * Whiteboard (txt/widgets/draw/draw.js): window.insertImageFile(file)
 * compresses, content-hashes, stores/uploads the bytes and drops the core's
 * own "![img:<code>#<hash>]" token at the cursor — no token format of ours.
 * The PNG is rendered at an INTEGER pixels-per-module size no larger than the
 * core's 800px resize cap, so its lossy re-encode never resamples modules.
 *
 * SCAN: camera (getUserMedia, rear camera preferred) decoded with the native
 * BarcodeDetector when it supports QR, else jsQR lazy-loaded from a pinned
 * CDN URL on first need; frames are sampled ~8 fps from a downscaled canvas.
 * Also decodes an image file / pasted / dropped image. The camera stream and
 * the frame loop always stop on Stop, tab switch, Escape and panel close.
 *
 * ENCODER: a compact, self-contained QR Model 2 encoder (ISO/IEC 18004):
 * numeric / alphanumeric / byte (UTF-8) single-segment, versions 1–40, all
 * four ECC levels, automatic mask selection by the standard penalty rules.
 * Verified by round-tripping every version × ECC level through jsQR.
 *
 * Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('qr.css');
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'qr-panel';
  var PREFS_KEY = 'cade-qr-prefs';
  // Pinned fallback decoder (only fetched when BarcodeDetector can't do QR).
  var JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
  var INSERT_MAX_PX = 800;   // core compressImage resizes anything larger
  var FRAME_MS = 125;        // ~8 fps camera sampling
  var FRAME_MAX = 640;       // downscale frames before jsQR (speed)

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
  function segmentBits(seg, ver) {
    var cc = MODES[seg.mode].cc[ver <= 9 ? 0 : ver <= 26 ? 1 : 2];
    if (seg.n >= (1 << cc)) return Infinity;
    var n = seg.n, b;
    if (seg.mode === 'num') b = Math.floor(n / 3) * 10 + [0, 4, 7][n % 3];
    else if (seg.mode === 'alnum') b = Math.floor(n / 2) * 11 + (n % 2) * 6;
    else b = n * 8;
    return 4 + cc + b;
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
    put(seg.n, MODES[seg.mode].cc[ver <= 9 ? 0 : ver <= 26 ? 1 : 2]);
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
      var d = (ECL_FORMAT_BITS[e] << 3) | mask, r = d;
      for (var q = 0; q < 10; q++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      var b = ((d << 10) | r) ^ 0x5412;
      var g = function (n) { return ((b >>> n) & 1) !== 0; };
      for (q = 0; q <= 5; q++) setF(8, q, g(q));
      setF(8, 7, g(6)); setF(8, 8, g(7)); setF(7, 8, g(8));
      for (q = 9; q < 15; q++) setF(14 - q, 8, g(q));
      for (q = 0; q < 8; q++) setF(size - 1 - q, 8, g(q));
      for (q = 8; q < 15; q++) setF(8, size - 15 + q, g(q));
      setF(8, size - 8, true);                            // the dark module
    }
    formatBits(0);                                        // reserve the areas
    if (ver >= 7) {
      var vr = ver;
      for (i = 0; i < 12; i++) vr = (vr << 1) ^ ((vr >>> 11) * 0x1f25);
      var vb = (ver << 12) | vr;
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
    canvas.width = px; canvas.height = px;
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
  // Integer modules-per-pixel so modules stay crisp; ≥ 1.
  function scaleFor(qr, margin, px) { return Math.max(1, Math.round(px / (qr.size + margin * 2))); }

  // ============================================================ payload builders
  var PRESETS = [
    { id: 'text', label: 'Text / URL', icon: '✎' },
    { id: 'wifi', label: 'Wi-Fi', icon: '📶' },
    { id: 'email', label: 'Email', icon: '✉' },
    { id: 'phone', label: 'Phone', icon: '☎' },
    { id: 'sms', label: 'SMS', icon: '💬' },
    { id: 'vcard', label: 'Contact', icon: '👤' }
  ];
  // Field specs per preset: [key, label, type, placeholder]
  var FIELDS = {
    wifi: [['ssid', 'Network name (SSID)', 'text', 'MyNetwork'], ['pass', 'Password', 'text', ''],
           ['sec', 'Security', 'select:WPA=WPA / WPA2 / WPA3|WEP=WEP|nopass=None (open)', ''], ['hidden', 'Hidden network', 'check', '']],
    email: [['to', 'To', 'email', 'name@example.com'], ['subject', 'Subject', 'text', ''], ['body', 'Message', 'area', '']],
    phone: [['tel', 'Phone number', 'tel', '+1 555 123 4567']],
    sms: [['tel', 'Phone number', 'tel', '+1 555 123 4567'], ['msg', 'Message', 'area', '']],
    vcard: [['first', 'First name', 'text', ''], ['last', 'Last name', 'text', ''], ['org', 'Organisation', 'text', ''],
            ['title', 'Job title', 'text', ''], ['tel', 'Phone', 'tel', ''], ['email', 'Email', 'email', ''],
            ['url', 'Website', 'url', ''], ['note', 'Note', 'text', '']]
  };
  function wifiEsc(s) { return String(s).replace(/([\\;,":])/g, '\\$1'); }
  function vEsc(s) { return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
  function cleanTel(s) { return String(s).replace(/[^\d+*#]/g, ''); }
  function buildPayload(preset, f) {
    f = f || {};
    var v = function (k) { return String(f[k] == null ? '' : f[k]).trim(); };
    switch (preset) {
      case 'wifi': {
        if (!v('ssid')) return '';
        var sec = f.sec || 'WPA';
        var out = 'WIFI:T:' + sec + ';S:' + wifiEsc(v('ssid')) + ';';
        if (sec !== 'nopass' && f.pass) out += 'P:' + wifiEsc(f.pass) + ';';
        if (f.hidden) out += 'H:true;';
        return out + ';';
      }
      case 'email': {
        if (!v('to') && !v('subject') && !v('body')) return '';
        var q = [];
        if (v('subject')) q.push('subject=' + encodeURIComponent(v('subject')));
        if (v('body')) q.push('body=' + encodeURIComponent(String(f.body).replace(/\r?\n/g, '\r\n')));
        return 'mailto:' + v('to').replace(/\s+/g, '') + (q.length ? '?' + q.join('&') : '');
      }
      case 'phone':
        return cleanTel(v('tel')) ? 'tel:' + cleanTel(v('tel')) : '';
      case 'sms':
        if (!cleanTel(v('tel')) && !v('msg')) return '';
        return 'SMSTO:' + cleanTel(v('tel')) + ':' + String(f.msg || '');
      case 'vcard': {
        var fn = (v('first') + ' ' + v('last')).trim();
        if (!fn && !v('org') && !v('tel') && !v('email')) return '';
        var L = ['BEGIN:VCARD', 'VERSION:3.0', 'N:' + vEsc(v('last')) + ';' + vEsc(v('first')) + ';;;', 'FN:' + vEsc(fn || v('org'))];
        if (v('org')) L.push('ORG:' + vEsc(v('org')));
        if (v('title')) L.push('TITLE:' + vEsc(v('title')));
        if (v('tel')) L.push('TEL;TYPE=CELL:' + v('tel'));
        if (v('email')) L.push('EMAIL:' + v('email'));
        if (v('url')) L.push('URL:' + v('url'));
        if (v('note')) L.push('NOTE:' + vEsc(v('note')));
        L.push('END:VCARD');
        return L.join('\n');
      }
      default:
        return String(f.text == null ? '' : f.text);
    }
  }

  // ================================================================== helpers
  var prefs = { ecl: 'M', size: 320, margin: 4, dark: '#000000', light: '#ffffff', preset: 'text' };
  function loadPrefs() {
    try {
      var p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {};
      if (p.ecl in ECL_INDEX) prefs.ecl = p.ecl;
      if (p.size >= 64 && p.size <= 2048) prefs.size = p.size | 0;
      if (p.margin >= 0 && p.margin <= 16) prefs.margin = p.margin | 0;
      if (/^#[0-9a-f]{6}$/i.test(p.dark || '')) prefs.dark = p.dark;
      if (/^#[0-9a-f]{6}$/i.test(p.light || '')) prefs.light = p.light;
      if (FIELDS[p.preset] || p.preset === 'text') prefs.preset = p.preset;
    } catch (e) {}
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }

  function hexRgb(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function lum(h) {
    var c = hexRgb(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function copyText(text, label) {
    var done = function () { Cade.showToast('Copied ' + (label || 'text'), 'success', 1400); };
    var fail = function () { Cade.showToast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      ta.remove();
    }
  }
  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 5000);
  }
  function editorWritable() {
    var ed = Cade.editor;
    if (!ed) return null;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode — editing is locked', 'error', 2000); return null; }
    return ed;
  }
  function slug(s) {
    var t = String(s || '').replace(/^[a-z]+:\/*/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 32).toLowerCase();
    return t || 'code';
  }

  // Selection, else the URL under the cursor, else the word under the cursor.
  function seedFromEditor() {
    try {
      var ed = Cade.editor, st = ed.state, sel = st.selection.main;
      if (!sel.empty) {
        var s = st.sliceDoc(sel.from, Math.min(sel.to, sel.from + 4000));
        if (s.trim()) return s;
      }
      var line = st.doc.lineAt(sel.head);
      if (line.length > 2000) return '';
      var col = sel.head - line.from, t = line.text, m;
      var re = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
      while ((m = re.exec(t)) !== null) {
        if (col >= m.index && col <= m.index + m[0].length) return m[0].replace(/[.,;:!?)\]}>'"]+$/, '');
      }
      var a = col, b = col;
      while (a > 0 && !/\s/.test(t.charAt(a - 1))) a--;
      while (b < t.length && !/\s/.test(t.charAt(b))) b++;
      var w = t.slice(a, b).replace(/^[(\["'<]+|[.,;:!?)\]}>'"]+$/g, '');
      if (w.indexOf('![img:') === 0) return '';
      return w;
    } catch (e) { return ''; }
  }

  // ==================================================================== state
  var S = null;           // live panel session (null when closed)
  var lastText = '';      // text box survives panel close (in memory only)
  var forms = {};         // preset form values, in memory only (never stored — passwords)

  function panel() { return document.getElementById(PANEL_ID); }

  // ----------------------------------------------------------------- generate
  function currentPayload() {
    if (prefs.preset === 'text') return lastText;
    return buildPayload(prefs.preset, forms[prefs.preset]);
  }

  function renderForm() {
    var box = S.p.querySelector('.qr-form');
    var pr = prefs.preset;
    if (pr === 'text') {
      box.innerHTML = '<textarea class="qr-text" rows="3" placeholder="Text or URL to encode…" spellcheck="false" aria-label="Text to encode"></textarea>';
      box.querySelector('.qr-text').value = lastText;
    } else {
      var f = forms[pr] || (forms[pr] = pr === 'wifi' ? { sec: 'WPA' } : {});
      var html = '';
      FIELDS[pr].forEach(function (d) {
        var key = d[0], label = d[1], type = d[2], ph = d[3];
        if (type === 'check') {
          html += '<label class="qr-chk"><input type="checkbox" data-k="' + key + '"' + (f[key] ? ' checked' : '') + '> ' + esc(label) + '</label>';
        } else if (type.indexOf('select:') === 0) {
          html += '<label class="qr-fld"><span>' + esc(label) + '</span><select data-k="' + key + '">' +
            type.slice(7).split('|').map(function (o) {
              var kv = o.split('=');
              return '<option value="' + esc(kv[0]) + '"' + ((f[key] || '') === kv[0] ? ' selected' : '') + '>' + esc(kv[1]) + '</option>';
            }).join('') + '</select></label>';
        } else if (type === 'area') {
          html += '<label class="qr-fld"><span>' + esc(label) + '</span><textarea rows="2" data-k="' + key + '" placeholder="' + esc(ph) + '">' + esc(f[key] || '') + '</textarea></label>';
        } else {
          html += '<label class="qr-fld"><span>' + esc(label) + '</span><input type="' + type + '" data-k="' + key + '" value="' + esc(f[key] || '') +
            '" placeholder="' + esc(ph) + '" autocomplete="off" autocapitalize="off" spellcheck="false"></label>';
        }
      });
      html += '<div class="qr-payload" title="Encoded payload"></div>';
      box.innerHTML = html;
      var pw = box.querySelector('[data-k="pass"]');
      if (pw) pw.disabled = f.sec === 'nopass';
    }
    S.p.querySelectorAll('.qr-preset').forEach(function (b) {
      var on = b.getAttribute('data-p') === pr;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function schedule() {
    if (!S) return;
    clearTimeout(S.genTimer);
    S.genTimer = setTimeout(regenerate, 70);
  }

  function regenerate() {
    if (!S) return;
    var p = S.p, payload = currentPayload();
    var info = p.querySelector('.qr-info'), cv = p.querySelector('.qr-canvas');
    var pl = p.querySelector('.qr-payload');
    if (pl) pl.textContent = payload || '';
    S.qr = null;
    p.classList.toggle('qr-empty', !payload);
    if (!payload) {
      info.textContent = prefs.preset === 'text' ? 'Type or paste something to encode' : 'Fill in the form to build a code';
      info.className = 'qr-info';
      drawPlaceholder(cv);
      return;
    }
    try {
      S.qr = encode(payload, prefs.ecl);
    } catch (e) {
      info.textContent = 'Too long for a QR code at level ' + prefs.ecl + ' — shorten it or use level L (max 2953 bytes)';
      info.className = 'qr-info bad';
      drawPlaceholder(cv);
      return;
    }
    var qr = S.qr, dpr = window.devicePixelRatio || 1;
    var n = qr.size + prefs.margin * 2;
    // Preview at an integer scale near the on-screen size; CSS keeps it pixelated.
    drawQR(cv, qr, Math.max(1, Math.floor(220 * dpr / n)), prefs.margin, prefs.dark, prefs.light);
    var px = n * scaleFor(qr, prefs.margin, prefs.size);
    var msg = 'v' + qr.version + ' · ' + qr.size + '×' + qr.size + ' · ' + qr.bytes + (qr.mode === 'byte' ? ' bytes' : ' chars') +
      ' · ECC ' + qr.ecl + ' · ' + px + 'px';
    var cls = 'qr-info';
    var ld = lum(prefs.dark), ll = lum(prefs.light);
    var ratio = (Math.max(ld, ll) + 0.05) / (Math.min(ld, ll) + 0.05);
    if (ld > ll) { msg += ' — inverted colours: many scanners can\'t read these'; cls += ' warn'; }
    else if (ratio < 4) { msg += ' — low contrast, may not scan'; cls += ' warn'; }
    else if (prefs.margin < 2) { msg += ' — small margin, may not scan'; cls += ' warn'; }
    info.textContent = msg;
    info.className = cls;
  }

  function drawPlaceholder(cv) {
    cv.width = cv.height = 10;
    var g = cv.getContext('2d');
    g.clearRect(0, 0, 10, 10);
  }

  function exportCanvas(maxPx) {
    if (!S || !S.qr) return null;
    var qr = S.qr, n = qr.size + prefs.margin * 2;
    var scale = scaleFor(qr, prefs.margin, prefs.size);
    if (maxPx && n * scale > maxPx) scale = Math.max(1, Math.floor(maxPx / n));
    var c = document.createElement('canvas');
    drawQR(c, qr, scale, prefs.margin, prefs.dark, prefs.light);
    return c;
  }
  function canvasBlob(c) {
    return new Promise(function (resolve) {
      if (!c || !c.toBlob) { resolve(null); return; }
      c.toBlob(function (b) { resolve(b || null); }, 'image/png');
    });
  }
  function needQR() {
    if (S && S.qr) return true;
    Cade.showToast('Nothing to encode yet', 'info', 1600);
    return false;
  }

  function doInsertImage() {
    if (!needQR()) return;
    var ed = editorWritable();
    if (!ed) return;
    if (typeof window.insertImageFile !== 'function') { Cade.showToast('Image pipeline unavailable', 'error', 2500); return; }
    // insertImageFile REPLACES the selection at the cursor. The selection is
    // usually the very text being encoded, and a cursor inside a word/URL
    // would split it — so park the cursor at the end of that line first and
    // the image lands on its own line below.
    var sel = ed.state.selection.main, line = ed.state.doc.lineAt(sel.to);
    if (!sel.empty || (sel.head > line.from && sel.head < line.to)) {
      ed.dispatch({ selection: { anchor: line.to } });
    }
    canvasBlob(exportCanvas(INSERT_MAX_PX)).then(function (blob) {
      if (!blob) { Cade.showToast('Could not render PNG', 'error', 2500); return; }
      // Same path as the Whiteboard: the core compresses, hashes, stores and
      // inserts its own image token at the cursor (and toasts).
      return window.insertImageFile(new File([blob], 'qr-code.png', { type: 'image/png' }));
    }).catch(function (e) { Cade.showToast('Insert failed: ' + ((e && e.message) || e), 'error', 3000); });
  }

  function doCopyImage() {
    if (!needQR()) return;
    if (!navigator.clipboard || !navigator.clipboard.write || typeof window.ClipboardItem === 'undefined') {
      Cade.showToast('Image copy isn\'t supported here — use PNG download', 'error', 2600); return;
    }
    var blobP = canvasBlob(exportCanvas());
    var ok = function () { Cade.showToast('QR image copied', 'success', 1400); };
    var fail = function () { Cade.showToast('Copy failed — use PNG download', 'error', 2400); };
    // Safari needs the ClipboardItem built synchronously inside the gesture
    // (promise value); older Chromium only accepts a resolved Blob — retry.
    var item;
    try { item = new window.ClipboardItem({ 'image/png': blobP }); } catch (e) { item = null; }
    var retry = function () {
      return blobP.then(function (b) {
        if (!b) throw new Error('no blob');
        return navigator.clipboard.write([new window.ClipboardItem({ 'image/png': b })]);
      }).then(ok, fail);
    };
    if (!item) { retry(); return; }
    navigator.clipboard.write([item]).then(ok, retry);
  }

  function doDownloadPng() {
    if (!needQR()) return;
    canvasBlob(exportCanvas()).then(function (b) {
      if (b) download(b, 'qr-' + slug(currentPayload()) + '.png');
      else Cade.showToast('Could not render PNG', 'error', 2000);
    });
  }
  function svgString() {
    var qr = S.qr, n = qr.size + prefs.margin * 2;
    return toSVG(qr, prefs.margin, prefs.dark, prefs.light, n * scaleFor(qr, prefs.margin, prefs.size));
  }
  function doCopySvg() { if (needQR()) copyText(svgString(), 'SVG'); }
  function doDownloadSvg() {
    if (!needQR()) return;
    download(new Blob([svgString()], { type: 'image/svg+xml' }), 'qr-' + slug(currentPayload()) + '.svg');
  }

  function renderOpts() {
    var p = S.p;
    p.querySelectorAll('.qr-ecl').forEach(function (b) {
      var on = b.getAttribute('data-e') === prefs.ecl;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    p.querySelector('.qr-size').value = prefs.size;
    p.querySelector('.qr-size-v').textContent = prefs.size + 'px';
    p.querySelector('.qr-margin').value = prefs.margin;
    p.querySelector('.qr-margin-v').textContent = prefs.margin;
    p.querySelector('.qr-dark').value = prefs.dark;
    p.querySelector('.qr-light').value = prefs.light;
  }

  // --------------------------------------------------------------------- scan
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

  // Decode a drawable source (video / image / bitmap) → text or null.
  function decodeSource(src, w, h, maxDim, invert) {
    return getDetector().then(function (det) {
      if (det) {
        return det.detect(src).then(function (codes) {
          for (var i = 0; i < codes.length; i++) if (codes[i] && codes[i].rawValue != null) return String(codes[i].rawValue);
          return null;
        }, function () { _detector = null; return decodeWithJsQR(src, w, h, maxDim, invert); });
      }
      return decodeWithJsQR(src, w, h, maxDim, invert);
    });
  }
  function decodeWithJsQR(src, w, h, maxDim, invert) {
    return loadJsQR().then(function (jsQR) {
      if (!w || !h) return null;
      var s = Math.min(1, maxDim / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
      var c = S && S.frame ? S.frame : document.createElement('canvas');
      if (S && !S.frame) S.frame = c;
      if (c.width !== cw) c.width = cw;
      if (c.height !== ch) c.height = ch;
      var g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(src, 0, 0, cw, ch);
      var img = g.getImageData(0, 0, cw, ch);
      var res = jsQR(img.data, cw, ch, { inversionAttempts: invert ? 'attemptBoth' : 'dontInvert' });
      return res ? res.data : null;
    });
  }

  function setStatus(msg, cls) {
    if (!S) return;
    var el = S.p.querySelector('.qr-status');
    el.textContent = msg || '';
    el.className = 'qr-status' + (cls ? ' ' + cls : '');
  }

  function startCamera() {
    if (!S || S.stream) return;
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) {
      setStatus(window.isSecureContext === false ? 'The camera needs a secure (https) page' : 'No camera access in this browser', 'bad');
      return;
    }
    setStatus('Starting camera…');
    var sess = S;
    // Warm the decoder in parallel with the permission prompt.
    getDetector().then(function (d) { if (!d) loadJsQR().catch(function () {}); });
    md.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(function (stream) {
        if (S !== sess || sess.tab !== 'scan') { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        sess.stream = stream;
        var v = sess.p.querySelector('.qr-video');
        v.srcObject = stream;
        v.setAttribute('playsinline', '');
        v.muted = true;
        var pr = v.play();
        if (pr && pr.catch) pr.catch(function () {});
        sess.p.querySelector('.qr-cam').hidden = false;
        sess.p.querySelector('.qr-cam-btn').textContent = '■ Stop camera';
        setStatus('Point the camera at a QR code');
        scanTick();
      }, function (err) {
        var n = err && err.name;
        setStatus(n === 'NotAllowedError' || n === 'SecurityError' ? 'Camera permission was denied'
          : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'No camera found'
          : n === 'NotReadableError' ? 'The camera is busy in another app'
          : 'Could not start the camera', 'bad');
      });
  }

  function stopCamera() {
    if (!S) return;
    clearTimeout(S.scanTimer);
    S.scanTimer = null;
    S.scanBusy = false;
    if (S.stream) {
      S.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      S.stream = null;
    }
    var v = S.p.querySelector('.qr-video');
    if (v) { try { v.pause(); } catch (e) {} v.srcObject = null; }
    var cam = S.p.querySelector('.qr-cam');
    if (cam) cam.hidden = true;
    var b = S.p.querySelector('.qr-cam-btn');
    if (b) b.textContent = '📷 Scan with camera';
  }

  function scanTick() {
    var sess = S;
    if (!sess || !sess.stream) return;
    var v = sess.p.querySelector('.qr-video');
    if (!v || v.readyState < 2 || !v.videoWidth) { sess.scanTimer = setTimeout(scanTick, FRAME_MS); return; }
    var t0 = Date.now();
    decodeSource(v, v.videoWidth, v.videoHeight, FRAME_MAX, false).then(function (txt) {
      if (S !== sess || !sess.stream) return;
      if (txt != null && txt !== '') {
        Cade.haptic && Cade.haptic(30);
        stopCamera();
        showResult(txt);
        return;
      }
      sess.scanTimer = setTimeout(scanTick, Math.max(20, FRAME_MS - (Date.now() - t0)));
    }, function (e) {
      if (S !== sess) return;
      stopCamera();
      setStatus('Decoder unavailable' + (navigator.onLine ? '' : ' offline — it needs one online load to cache'), 'bad');
    });
  }

  function loadImageSource(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file).then(function (bm) { return { src: bm, w: bm.width, h: bm.height, done: function () { try { bm.close(); } catch (e) {} } }; });
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { resolve({ src: img, w: img.naturalWidth, h: img.naturalHeight, done: function () { URL.revokeObjectURL(url); } }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  function scanFile(file) {
    if (!S || !file) return;
    if (!/^image\//.test(file.type || '')) { setStatus('That isn\'t an image', 'bad'); return; }
    if (S.tab !== 'scan') setTab('scan');
    stopCamera();
    setStatus('Reading image…');
    var sess = S;
    loadImageSource(file).then(function (im) {
      // Try full detail first, then a smaller copy (jsQR sometimes locks on
      // better when a huge photo is downscaled).
      return decodeSource(im.src, im.w, im.h, 1400, true).then(function (t) {
        if (t != null || Math.max(im.w, im.h) <= 700) return t;
        return decodeSource(im.src, im.w, im.h, 700, true);
      }).then(function (t) { im.done(); return t; }, function (e) { im.done(); throw e; });
    }).then(function (txt) {
      if (S !== sess) return;
      if (txt != null && txt !== '') showResult(txt);
      else setStatus('No QR code found in that image', 'bad');
    }, function (e) {
      if (S !== sess) return;
      setStatus(/decoder/.test((e && e.message) || '') ? 'Decoder unavailable — needs one online load to cache' : 'Couldn\'t read that image', 'bad');
    });
  }

  function safeHttpUrl(t) {
    var s = String(t).trim();
    if (!/^https?:\/\/[^\s]+$/i.test(s)) return null;
    try { var u = new URL(s); return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null; } catch (e) { return null; }
  }

  function showResult(txt) {
    if (!S) return;
    S.result = txt;
    var box = S.p.querySelector('.qr-result');
    box.hidden = false;
    box.querySelector('.qr-result-text').textContent = txt;
    var a = box.querySelector('.qr-open');
    var url = safeHttpUrl(txt);
    if (url) { a.href = url; a.hidden = false; } else { a.removeAttribute('href'); a.hidden = true; }
    setStatus('Decoded ' + txt.length + ' character' + (txt.length === 1 ? '' : 's'), 'ok');
  }

  function insertResult() {
    if (!S || S.result == null) return;
    var ed = editorWritable();
    if (!ed) return;
    ed.dispatch(ed.state.replaceSelection(S.result), { userEvent: 'input', scrollIntoView: true });
    Cade.showToast('Inserted', 'success', 1100);
  }

  // ---------------------------------------------------------------- tabs/open
  function setTab(tab) {
    if (!S) return;
    S.tab = tab;
    S.p.querySelectorAll('.qr-tab').forEach(function (b) {
      var on = b.getAttribute('data-tab') === tab;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    S.p.querySelector('.qr-gen').hidden = tab !== 'gen';
    S.p.querySelector('.qr-scan').hidden = tab !== 'scan';
    if (tab !== 'scan') stopCamera();
  }

  function cleanup() {
    if (!S) return;
    stopCamera();
    clearTimeout(S.genTimer);
    S = null;
  }
  function close() {
    var p = panel();
    if (p) { p.remove(); if (p._onClose) p._onClose(); }
  }

  function open() {
    Cade.closeAllMenus();
    var existing = panel();
    if (existing) { close(); return; }
    loadPrefs();
    var seed = seedFromEditor();
    if (seed) { lastText = seed; prefs.preset = 'text'; }

    var presetBtns = PRESETS.map(function (pr) {
      return '<button class="qr-preset" data-p="' + pr.id + '" title="' + esc(pr.label) + '"><span aria-hidden="true">' + pr.icon + '</span> ' + esc(pr.label) + '</button>';
    }).join('');
    var p = Cade.mkPanel(PANEL_ID, '▦ QR Code',
      '<div class="qr-tabs" role="tablist">' +
        '<button class="qr-tab on" data-tab="gen" role="tab">Generate</button>' +
        '<button class="qr-tab" data-tab="scan" role="tab">Scan</button>' +
      '</div>' +
      '<div class="qr-gen">' +
        '<div class="qr-presets" role="group" aria-label="Content type">' + presetBtns + '</div>' +
        '<div class="qr-form"></div>' +
        '<div class="qr-preview"><canvas class="qr-canvas" width="10" height="10" aria-label="QR code preview"></canvas></div>' +
        '<div class="qr-info"></div>' +
        '<div class="qr-acts">' +
          '<button class="qr-btn primary" data-act="insert" title="Insert into the document as an image">⤓ Insert</button>' +
          '<button class="qr-btn" data-act="copyimg" title="Copy the PNG image">⧉ Copy image</button>' +
          '<button class="qr-btn" data-act="png" title="Download PNG">↓ PNG</button>' +
          '<button class="qr-btn" data-act="copysvg" title="Copy SVG markup">⧉ SVG</button>' +
          '<button class="qr-btn" data-act="svg" title="Download SVG">↓ SVG</button>' +
        '</div>' +
        '<details class="qr-opts"><summary>Options</summary>' +
          '<div class="qr-row"><span class="qr-lbl" title="Error correction: higher survives more damage but makes a denser code">Error correction</span>' +
            '<span class="qr-seg">' +
              '<button class="qr-ecl" data-e="L" title="Low — ~7% recovery">L</button>' +
              '<button class="qr-ecl" data-e="M" title="Medium — ~15% recovery">M</button>' +
              '<button class="qr-ecl" data-e="Q" title="Quartile — ~25% recovery">Q</button>' +
              '<button class="qr-ecl" data-e="H" title="High — ~30% recovery">H</button>' +
            '</span></div>' +
          '<label class="qr-row"><span class="qr-lbl">Size</span><input class="qr-size" type="range" min="128" max="1024" step="16"><span class="qr-size-v qr-v"></span></label>' +
          '<label class="qr-row"><span class="qr-lbl">Margin</span><input class="qr-margin" type="range" min="0" max="10" step="1"><span class="qr-margin-v qr-v"></span></label>' +
          '<div class="qr-row"><span class="qr-lbl">Colours</span>' +
            '<label class="qr-col" title="Dark modules"><input class="qr-dark" type="color"> Dark</label>' +
            '<label class="qr-col" title="Background"><input class="qr-light" type="color"> Light</label>' +
            '<button class="qr-btn sm" data-act="swap" title="Swap colours">⇄</button>' +
            '<button class="qr-btn sm" data-act="reset" title="Black on white (most scannable)">Reset</button>' +
          '</div>' +
        '</details>' +
      '</div>' +
      '<div class="qr-scan" hidden>' +
        '<div class="qr-acts">' +
          '<button class="qr-btn primary qr-cam-btn" data-act="camera">📷 Scan with camera</button>' +
          '<button class="qr-btn" data-act="pick">🖼 Scan from image</button>' +
          '<input class="qr-file" type="file" accept="image/*" hidden>' +
        '</div>' +
        '<div class="qr-cam" hidden><video class="qr-video" playsinline muted></video><div class="qr-reticle" aria-hidden="true"></div></div>' +
        '<div class="qr-drop" tabindex="0" role="button" aria-label="Paste or drop an image containing a QR code">Paste (Ctrl/⌘+V) or drop an image with a QR code here</div>' +
        '<div class="qr-status" aria-live="polite"></div>' +
        '<div class="qr-result" hidden>' +
          '<div class="qr-result-text"></div>' +
          '<div class="qr-acts">' +
            '<button class="qr-btn primary" data-act="rinsert">⤓ Insert</button>' +
            '<button class="qr-btn" data-act="rcopy">⧉ Copy</button>' +
            '<a class="qr-btn qr-open" target="_blank" rel="noopener noreferrer" hidden>↗ Open link</a>' +
          '</div>' +
        '</div>' +
      '</div>');

    S = { p: p, tab: 'gen', qr: null, stream: null, scanTimer: null, genTimer: null, frame: null, result: null };
    p._onClose = cleanup;

    p.addEventListener('click', function (e) {
      var t = e.target;
      var b = t.closest && t.closest('button, a.qr-btn');
      if (!b || !S) return;
      if (b.classList.contains('qr-tab')) { setTab(b.getAttribute('data-tab')); return; }
      if (b.classList.contains('qr-preset')) {
        prefs.preset = b.getAttribute('data-p'); savePrefs(); renderForm(); regenerate();
        var first = p.querySelector('.qr-form input, .qr-form textarea');
        if (first && !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) first.focus();
        return;
      }
      if (b.classList.contains('qr-ecl')) { prefs.ecl = b.getAttribute('data-e'); savePrefs(); renderOpts(); regenerate(); return; }
      switch (b.getAttribute('data-act')) {
        case 'insert': doInsertImage(); break;
        case 'copyimg': doCopyImage(); break;
        case 'png': doDownloadPng(); break;
        case 'copysvg': doCopySvg(); break;
        case 'svg': doDownloadSvg(); break;
        case 'swap': var d = prefs.dark; prefs.dark = prefs.light; prefs.light = d; savePrefs(); renderOpts(); regenerate(); break;
        case 'reset': prefs.dark = '#000000'; prefs.light = '#ffffff'; prefs.margin = 4; savePrefs(); renderOpts(); regenerate(); break;
        case 'camera': if (S.stream) { stopCamera(); setStatus(''); } else startCamera(); break;
        case 'pick': p.querySelector('.qr-file').click(); break;
        case 'rinsert': insertResult(); break;
        case 'rcopy': if (S.result != null) copyText(S.result, 'result'); break;
      }
    });
    // One delegated listener for whichever form is showing (renderForm only
    // swaps innerHTML, so nothing accumulates across preset switches).
    var onField = function (ev) {
      var el = ev.target;
      if (!S || !el || !el.closest || !el.closest('.qr-form')) return;
      if (el.classList.contains('qr-text')) { lastText = el.value; schedule(); return; }
      var k = el.getAttribute('data-k'), f = forms[prefs.preset];
      if (!k || !f) return;
      f[k] = el.type === 'checkbox' ? el.checked : el.value;
      if (k === 'sec') { var pw = p.querySelector('.qr-form [data-k="pass"]'); if (pw) pw.disabled = f.sec === 'nopass'; }
      schedule();
    };
    var form = p.querySelector('.qr-form');
    form.addEventListener('input', onField);
    form.addEventListener('change', onField);
    p.querySelector('.qr-size').addEventListener('input', function (e) {
      prefs.size = +e.target.value; p.querySelector('.qr-size-v').textContent = prefs.size + 'px'; savePrefs(); schedule();
    });
    p.querySelector('.qr-margin').addEventListener('input', function (e) {
      prefs.margin = +e.target.value; p.querySelector('.qr-margin-v').textContent = prefs.margin; savePrefs(); schedule();
    });
    p.querySelector('.qr-dark').addEventListener('input', function (e) { prefs.dark = e.target.value; savePrefs(); schedule(); });
    p.querySelector('.qr-light').addEventListener('input', function (e) { prefs.light = e.target.value; savePrefs(); schedule(); });
    p.querySelector('.qr-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) scanFile(f);
    });
    // Pasted / dropped images decode — handled on the PANEL only, so pasting
    // into the document while the panel is open still embeds as usual.
    p.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          var f = items[i].getAsFile();
          if (f) { e.preventDefault(); scanFile(f); return; }
        }
      }
    });
    var drop = p.querySelector('.qr-drop');
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault(); drop.classList.remove('over');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) scanFile(f);
    });
    drop.addEventListener('click', function () { drop.focus(); });
    p.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (S && S.stream) { stopCamera(); setStatus(''); } else close();
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && S && S.tab === 'gen') { e.preventDefault(); doInsertImage(); }
      e.stopPropagation(); // keep editor/global shortcuts out of the panel's fields
    });

    renderOpts();
    renderForm();
    regenerate();
    if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) {
      setTimeout(function () {
        var ta = p.querySelector('.qr-text');
        if (ta) { ta.focus(); ta.select(); }
      }, 0);
    }
  }

  Cade.registerWidget({
    name: 'QR Code',
    description: 'Make QR codes (text, URL, Wi-Fi, contact…) — insert, copy or save; scan with the camera or from an image',
    icon: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='7' height='7' rx='1'/><rect x='14' y='3' width='7' height='7' rx='1'/><rect x='3' y='14' width='7' height='7' rx='1'/><path d='M14 14h3v3h-3zM21 14v.01M14 21h.01M17.5 21H21v-3.5'/></svg>",
    tags: 'qr,qr code,qrcode,barcode,2d code,scan,scanner,reader,decode,camera,photo,generate,generator,maker,create,wifi,wi-fi,password,vcard,contact,email,sms,phone,link,url,share,code,png,svg,image',
    open: open,
    _encode: encode,           // exposed for tests / other modules
    _payload: buildPayload
  });
})();
