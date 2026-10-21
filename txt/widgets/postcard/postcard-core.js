/* ASCII Postcard — core: photo → coloured text art, the note format, a sync
 * decoder (with its own small inflate) and the canvas renderer. Pure ES5, no
 * DOM needed except for render()/fontReady(): window.__cadePostcard in the
 * browser, module.exports in node (txt/widgets/postcard/postcard.test.js).
 *
 * ---- The note format (plain text first; the colour is an optional extra) ----
 *
 *   ```postcard 64x32 classic color dark "Lisbon, 21 Oct 2026"
 *   <rows lines of exactly cols characters: the art itself>
 *   ~ <base64 colour layer — only for colour mode>
 *   ```
 *
 * Fence info, tokens in any order after "postcard": COLSxROWS; a style
 * (classic dense blocks braille edges text); a colour mode (color, mono,
 * green, sepia, tint:#rrggbb); the paper it was made for (dark — the default
 * — light, paper: on dark paper bright pixels get the dense characters, on
 * light paper dark ones do); a "caption" (no " or ` inside). Unknown tokens
 * are ignored, so later versions can add some.
 *
 * Colour layer: base64 of [version=1, flags, payload]; flags bit 0 = the
 * payload is deflate-raw compressed (CompressionStream where the browser has
 * it, else stored raw). Payload = [n (1..64), n × (r, g, b), cols×rows palette
 * indices, row-major]. Blank cells carry the index of the cell before them,
 * which costs nothing after deflate. Anything that doesn't add up — wrong
 * size, bad base64, corrupt deflate, an index ≥ n, an unknown version —
 * decodes to "no colours" and the card renders monochrome; nothing throws.
 *
 * ---- The converter ----
 * The picture is box-filtered onto a grid of 2×4 sub-pixels per character
 * cell (a cell is ~0.5 as wide as tall, so every sub-pixel is square), toned
 * (auto levels, brightness, contrast, gamma), turned into ink density and then
 * into characters: a ramp (optionally Floyd–Steinberg dithered), braille dots
 * (each sub-pixel one dot; Bayer-ordered, or Floyd–Steinberg with dither),
 * Sobel edge directions (structure tensor per cell),
 * or a phrase repeated over the inked cells. Cell colours are averaged and
 * quantized to ≤ 64 colours (median cut on a 15-bit histogram + k-means). */
(function (root) {
  'use strict';

  var ASPECT = 0.5;            // character cell width / height
  var MIN_COLS = 24, MAX_COLS = 160, MAX_ROWS = 240, MAX_DIM = 400;
  var RAMPS = {
    classic: ' .:-=+*#%@',
    // Paul Bourke's 70-level ramp, light → dense, minus ` and ~ (a ``` line
    // would end the fence; "~ " starts the colour line)
    dense: ' .\'^",:;Il!i><+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
    blocks: ' ░▒▓█',
  };
  var EDGE_FILL = ' .,:;';
  var STYLES = ['classic', 'dense', 'blocks', 'braille', 'edges', 'text'];
  var MODES = ['color', 'mono', 'tint', 'green', 'sepia'];
  var BGS = ['dark', 'light', 'paper'];
  var BRAILLE_BITS = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]]; // [column][row]
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(function (v) { return (v + 0.5) / 16; });

  // Card colours: background, ink, a muted tone for captions — per paper.
  var PAPER = { dark: '#111110', light: '#fafaf9', paper: '#f2e8d5' };
  var INK = {
    mono: { dark: '#e7e5e3', light: '#1c1917', paper: '#3b3024' },
    green: { dark: '#3dff7a', light: '#0a7d32', paper: '#2f6b2f' },
    sepia: { dark: '#d9b77e', light: '#704214', paper: '#6b4423' },
  };
  var MUTED = { dark: '#8c8a87', light: '#78716c', paper: '#7a6a55' };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { v = +v; return isFinite(v) ? v : d; }

  // ===================================================================== options
  var DEFAULTS = {
    cols: 64, style: 'classic', mode: 'color', bg: 'dark', tint: '#e07a5f',
    brightness: 0, contrast: 0, gamma: 1, invert: false, dither: false, auto: true,
    colors: 32, phrase: 'POSTCARD', caption: '',
  };
  function hexColor(s) {
    var m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(s || '').trim());
    if (!m) return null;
    var h = m[1].toLowerCase();
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    return '#' + h;
  }
  // Phrases fill the grid one character per cell: keep to single-width
  // scripts (Latin, Greek, Cyrillic) and never a backtick.
  function cleanPhrase(s) {
    var t = String(s == null ? '' : s).replace(/[`\r\n\t]+/g, ' ').replace(/[^\x20-\x7E\u00A0-\u02FF\u0370-\u052F]/g, '').replace(/\s+/g, ' ');
    return t.trim().slice(0, 80);
  }
  function cleanCaption(s) {
    return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/[`"]/g, '\'').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  function normalize(o) {
    o = o || {};
    var r = {};
    for (var k in DEFAULTS) r[k] = o[k] !== undefined ? o[k] : DEFAULTS[k];
    r.cols = clamp(Math.round(num(r.cols, 64)), MIN_COLS, MAX_COLS);
    if (STYLES.indexOf(r.style) < 0) r.style = 'classic';
    if (MODES.indexOf(r.mode) < 0) r.mode = 'color';
    if (BGS.indexOf(r.bg) < 0) r.bg = 'dark';
    r.tint = hexColor(r.tint) || DEFAULTS.tint;
    r.brightness = clamp(num(r.brightness, 0), -1, 1);
    r.contrast = clamp(num(r.contrast, 0), -1, 1);
    r.gamma = clamp(num(r.gamma, 1), 0.2, 5);
    r.invert = !!r.invert; r.dither = !!r.dither; r.auto = r.auto !== false;
    r.colors = clamp(Math.round(num(r.colors, 32)), 2, 64);
    r.phrase = cleanPhrase(r.phrase) || 'POSTCARD';
    r.caption = cleanCaption(r.caption);
    return r;
  }
  // Grid for a picture of w × h at `cols` characters wide.
  function gridSize(w, h, cols) {
    cols = clamp(Math.round(num(cols, 64)), MIN_COLS, MAX_COLS);
    var rows = Math.round(cols * (h / Math.max(1, w)) * ASPECT);
    return { cols: cols, rows: clamp(rows || 1, 2, MAX_ROWS) };
  }

  // ===================================================================== sampling
  // Box filter an RGBA buffer (w × h) down (or nearest-neighbour up) to gw × gh.
  // Transparent pixels are matted onto `matte` (0..1 grey). Returns
  // Float32Array(gw * gh * 3) of sRGB values in 0..1.
  function sample(rgba, w, h, gw, gh, matte) {
    var out = new Float32Array(gw * gh * 3), m = matte == null ? 0 : matte * 255;
    var xs = new Int32Array(gw + 1), xe = new Int32Array(gw), i, j, x, y;
    for (i = 0; i < gw; i++) {
      xs[i] = Math.min(w - 1, Math.floor(i * w / gw));
      xe[i] = Math.max(xs[i] + 1, Math.min(w, Math.floor((i + 1) * w / gw)));
    }
    for (j = 0; j < gh; j++) {
      var y0 = Math.min(h - 1, Math.floor(j * h / gh)), y1 = Math.max(y0 + 1, Math.min(h, Math.floor((j + 1) * h / gh)));
      for (i = 0; i < gw; i++) {
        var r = 0, g = 0, b = 0, n = 0, x0 = xs[i], x1 = xe[i];
        for (y = y0; y < y1; y++) {
          var p = (y * w + x0) * 4;
          for (x = x0; x < x1; x++, p += 4) {
            var a = rgba[p + 3];
            if (a === 255) { r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2]; }
            else { var f = a / 255, mf = m * (1 - f); r += rgba[p] * f + mf; g += rgba[p + 1] * f + mf; b += rgba[p + 2] * f + mf; }
            n++;
          }
        }
        var o = (j * gw + i) * 3, d = 1 / (n * 255);
        out[o] = r * d; out[o + 1] = g * d; out[o + 2] = b * d;
      }
    }
    return out;
  }
  function lumaOf(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
  // [lo, hi] luminance percentiles from a 256-bin histogram.
  function levels(lum, pLo, pHi) {
    var hist = new Uint32Array(256), n = lum.length, i;
    for (i = 0; i < n; i++) hist[clamp(Math.round(lum[i] * 255), 0, 255)]++;
    var a = n * pLo, b = n * pHi, acc = 0, lo = 0, hi = 255;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc > a) { lo = i; break; } }
    acc = 0;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= b) { hi = i; break; } }
    return [lo / 255, hi / 255];
  }
  // A tone curve (auto levels → contrast → brightness → gamma), as a function.
  function toner(o, lo, hi) {
    var span = Math.max(1e-6, hi - lo), c = o.contrast;
    var cf = c >= 0 ? 1 + c * 2 : 1 + c;        // 0 … 3
    var br = o.brightness * 0.5, ig = 1 / o.gamma;
    return function (v) {
      v = (v - lo) / span;
      v = (v - 0.5) * cf + 0.5 + br;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      return ig === 1 ? v : Math.pow(v, ig);
    };
  }

  // ===================================================================== dithering
  // Quantize vals (0..1, w × h) to `n` levels: Floyd–Steinberg when `dither`,
  // else nearest. Always returns indices in 0..n-1.
  function quantizeLevels(vals, w, h, n, dither) {
    var out = new Uint8Array(w * h), n1 = n - 1, x, y, i;
    if (!dither) {
      for (i = 0; i < out.length; i++) out[i] = clamp(Math.round(vals[i] * n1), 0, n1);
      return out;
    }
    var buf = new Float32Array(vals.length);
    for (i = 0; i < buf.length; i++) buf[i] = vals[i] * n1;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        var v = buf[i], q = clamp(Math.round(v), 0, n1), e = v - q;
        out[i] = q;
        if (e === 0) continue;
        if (x + 1 < w) buf[i + 1] += e * 7 / 16;
        if (y + 1 < h) {
          if (x > 0) buf[i + w - 1] += e * 3 / 16;
          buf[i + w] += e * 5 / 16;
          if (x + 1 < w) buf[i + w + 1] += e / 16;
        }
      }
    }
    return out;
  }

  // ===================================================================== edges
  // Sobel on the sub-pixel luminance, then per cell the structure tensor of its
  // 2 × 4 sub-pixels: orientation (double angle, so opposite gradients agree)
  // and RMS magnitude. Edge direction is perpendicular to the gradient; screen
  // coordinates (y down): 0° '-', 45° '\', 90° '|', 135° '/'.
  function edgeCells(lum, gw, gh, cols, rows) {
    var mag = new Float32Array(cols * rows), ang = new Float32Array(cols * rows);
    function L(x, y) { return lum[clamp(y, 0, gh - 1) * gw + clamp(x, 0, gw - 1)]; }
    for (var cy = 0; cy < rows; cy++) {
      for (var cx = 0; cx < cols; cx++) {
        var jxx = 0, jyy = 0, jxy = 0;
        for (var sy = 0; sy < 4; sy++) {
          for (var sx = 0; sx < 2; sx++) {
            var x = cx * 2 + sx, y = cy * 4 + sy;
            var gx = (L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1) - L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1)) / 8;
            var gy = (L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1) - L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1)) / 8;
            jxx += gx * gx; jyy += gy * gy; jxy += gx * gy;
          }
        }
        var c = cy * cols + cx;
        mag[c] = Math.sqrt((jxx + jyy) / 8);
        var th = 0.5 * Math.atan2(2 * jxy, jxx - jyy) * 180 / Math.PI + 90; // edge direction
        ang[c] = ((th % 180) + 180) % 180;
      }
    }
    return { mag: mag, ang: ang };
  }
  function edgeChar(a) {
    if (a < 22.5 || a >= 157.5) return '-';
    if (a < 67.5) return '\\';
    if (a < 112.5) return '|';
    return '/';
  }
  function percentile(arr, p) {
    var s = Array.prototype.slice.call(arr).sort(function (a, b) { return a - b; });
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
  }

  // ===================================================================== palette
  // Quantize n colours (rgb: Uint8Array n*3) to ≤ max colours. mask (optional)
  // marks the cells that count. → { palette: Uint8Array(k*3), idx: Uint8Array(n) }
  function quantize(rgb, n, max, mask) {
    max = clamp(max | 0 || 32, 1, 64);
    var cnt = new Uint32Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
    var i, k, keys = [];
    for (i = 0; i < n; i++) {
      if (mask && !mask[i]) continue;
      var r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
      k = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
      if (!cnt[k]) keys.push(k);
      cnt[k]++; sr[k] += r; sg[k] += g; sb[k] += b;
    }
    var idx = new Uint8Array(n);
    if (!keys.length) return { palette: new Uint8Array([128, 128, 128]), idx: idx };
    var P = keys.length, pr = new Float64Array(P), pg = new Float64Array(P), pb = new Float64Array(P), pw = new Float64Array(P);
    for (i = 0; i < P; i++) { k = keys[i]; pw[i] = cnt[k]; pr[i] = sr[k] / cnt[k]; pg[i] = sg[k] / cnt[k]; pb[i] = sb[k] / cnt[k]; }
    var cr = [], cg = [], cb = [];
    if (P <= max) {
      for (i = 0; i < P; i++) { cr.push(pr[i]); cg.push(pg[i]); cb.push(pb[i]); }
    } else {
      // median cut: split the box with the widest channel × weight at its weighted median
      var ch = [pr, pg, pb];
      var boxes = [mkBox(range(P))];
      while (boxes.length < max) {
        var best = -1, bs = 0;
        for (i = 0; i < boxes.length; i++) if (boxes[i].items.length > 1 && boxes[i].score > bs) { bs = boxes[i].score; best = i; }
        if (best < 0) break;
        var bx = boxes[best], c = ch[bx.axis], items = bx.items.slice().sort(function (a, b) { return c[a] - c[b]; });
        var half = bx.w / 2, acc = 0, cut = 1;
        for (i = 0; i < items.length - 1; i++) { acc += pw[items[i]]; if (acc >= half) { cut = i + 1; break; } cut = i + 1; }
        boxes.splice(best, 1, mkBox(items.slice(0, cut)), mkBox(items.slice(cut)));
      }
      for (i = 0; i < boxes.length; i++) { var m = boxMean(boxes[i].items); cr.push(m[0]); cg.push(m[1]); cb.push(m[2]); }
      // a few k-means rounds on the (weighted) histogram points
      for (var it = 0; it < 3; it++) {
        var K = cr.length, ar = new Float64Array(K), ag = new Float64Array(K), ab = new Float64Array(K), aw = new Float64Array(K);
        for (i = 0; i < P; i++) { var j = nearest(pr[i], pg[i], pb[i]); ar[j] += pr[i] * pw[i]; ag[j] += pg[i] * pw[i]; ab[j] += pb[i] * pw[i]; aw[j] += pw[i]; }
        for (j = 0; j < K; j++) if (aw[j]) { cr[j] = ar[j] / aw[j]; cg[j] = ag[j] / aw[j]; cb[j] = ab[j] / aw[j]; }
      }
    }
    var K2 = cr.length, pal = new Uint8Array(K2 * 3);
    for (i = 0; i < K2; i++) { pal[i * 3] = Math.round(cr[i]); pal[i * 3 + 1] = Math.round(cg[i]); pal[i * 3 + 2] = Math.round(cb[i]); cr[i] = pal[i * 3]; cg[i] = pal[i * 3 + 1]; cb[i] = pal[i * 3 + 2]; }
    var map = new Int16Array(32768);
    for (i = 0; i < P; i++) map[keys[i]] = nearest(pr[i], pg[i], pb[i]);
    for (i = 0; i < n; i++) {
      if (mask && !mask[i]) continue;
      idx[i] = map[(rgb[i * 3] >> 3) << 10 | (rgb[i * 3 + 1] >> 3) << 5 | (rgb[i * 3 + 2] >> 3)];
    }
    return { palette: pal, idx: idx };

    function nearest(r, g, b) {
      var bi = 0, bd = Infinity;
      for (var q = 0; q < cr.length; q++) {
        var dr = r - cr[q], dg = g - cg[q], db = b - cb[q], d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
        if (d < bd) { bd = d; bi = q; }
      }
      return bi;
    }
    function range(m) { var a = []; for (var q = 0; q < m; q++) a.push(q); return a; }
    function boxMean(items) {
      var r = 0, g = 0, b = 0, w = 0;
      for (var q = 0; q < items.length; q++) { var t = items[q]; r += pr[t] * pw[t]; g += pg[t] * pw[t]; b += pb[t] * pw[t]; w += pw[t]; }
      return [r / w, g / w, b / w];
    }
    function mkBox(items) {
      var lo = [255, 255, 255], hi = [0, 0, 0], w = 0, arr = [pr, pg, pb];
      for (var q = 0; q < items.length; q++) {
        var t = items[q]; w += pw[t];
        for (var a = 0; a < 3; a++) { var v = arr[a][t]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
      }
      var ax = 0, rg = -1;
      for (a = 0; a < 3; a++) if (hi[a] - lo[a] > rg) { rg = hi[a] - lo[a]; ax = a; }
      return { items: items, w: w, axis: ax, score: rg * Math.sqrt(w) };
    }
  }

  // ===================================================================== convert
  function isBlank(ch) { return ch === ' ' || ch === '\u2800'; }
  // rgba: RGBA bytes (ImageData.data or any array), w × h → a card:
  // { cols, rows, style, mode, tint, bg, caption, lines[], palette|null, idx|null }
  function convert(rgba, w, h, opts) {
    var o = normalize(opts), gs = gridSize(w, h, o.cols), cols = gs.cols, rows = gs.rows;
    var gw = cols * 2, gh = rows * 4, ns = gw * gh, nc = cols * rows, i, x, y, cx, cy;
    var dark = o.bg === 'dark';
    var sub = sample(rgba, w, h, gw, gh, dark ? 0 : 1);
    var lum = new Float32Array(ns);
    for (i = 0; i < ns; i++) lum[i] = lumaOf(sub[i * 3], sub[i * 3 + 1], sub[i * 3 + 2]);
    var lv = o.auto ? levels(lum, 0.01, 0.99) : [0, 1];
    if (lv[1] - lv[0] < 0.04) lv = [0, 1];
    var tone = toner(o, lv[0], lv[1]);
    var flip = dark ? o.invert : !o.invert;     // ink density from luminance
    var dens = new Float32Array(ns);
    for (i = 0; i < ns; i++) { lum[i] = tone(lum[i]); dens[i] = flip ? 1 - lum[i] : lum[i]; }
    // per-cell means
    var cd = new Float32Array(nc), crgb = new Float32Array(nc * 3);
    for (cy = 0; cy < rows; cy++) {
      for (cx = 0; cx < cols; cx++) {
        var c = cy * cols + cx, sd = 0, r = 0, g = 0, b = 0;
        for (y = cy * 4; y < cy * 4 + 4; y++) for (x = cx * 2; x < cx * 2 + 2; x++) {
          var s = y * gw + x; sd += dens[s]; r += sub[s * 3]; g += sub[s * 3 + 1]; b += sub[s * 3 + 2];
        }
        cd[c] = sd / 8; crgb[c * 3] = r / 8; crgb[c * 3 + 1] = g / 8; crgb[c * 3 + 2] = b / 8;
      }
    }
    var chars = new Array(nc);
    if (o.style === 'braille') {
      // one dot per sub-pixel: Floyd–Steinberg with "dither", else an ordered
      // (Bayer 4×4) threshold — a flat 50% cut would lose every mid tone
      var bits = o.dither ? quantizeLevels(dens, gw, gh, 2, true) : new Uint8Array(ns);
      if (!o.dither) for (y = 0; y < gh; y++) for (x = 0; x < gw; x++) bits[y * gw + x] = dens[y * gw + x] > BAYER[(y & 3) * 4 + (x & 3)] ? 1 : 0;
      for (cy = 0; cy < rows; cy++) for (cx = 0; cx < cols; cx++) {
        var code = 0;
        for (y = 0; y < 4; y++) for (x = 0; x < 2; x++) if (bits[(cy * 4 + y) * gw + cx * 2 + x]) code |= BRAILLE_BITS[x][y];
        chars[cy * cols + cx] = String.fromCharCode(0x2800 + code);
      }
    } else if (o.style === 'edges') {
      var E = edgeCells(lum, gw, gh, cols, rows), p95 = percentile(E.mag, 0.95);
      var T = Math.max(0.05, 0.45 * p95), fillN = EDGE_FILL.length;
      var fl = quantizeLevels(cd, cols, rows, fillN, o.dither);
      // a light fill under the outlines, kept faint so the edges carry the picture
      for (i = 0; i < nc; i++) chars[i] = E.mag[i] >= T ? edgeChar(E.ang[i]) : EDGE_FILL.charAt(Math.min(fillN - 1, Math.round(fl[i] * 0.6)));
    } else if (o.style === 'text') {
      var seq = o.phrase + ' ', cut = o.mode === 'color' ? 0.07 : 0.3, k = 0;
      for (i = 0; i < nc; i++) {
        var chx = seq.charAt(k % seq.length); k++;
        chars[i] = cd[i] < cut ? ' ' : chx;
      }
    } else {
      var ramp = RAMPS[o.style], lvq = quantizeLevels(cd, cols, rows, ramp.length, o.dither);
      for (i = 0; i < nc; i++) chars[i] = ramp.charAt(lvq[i]);
    }
    var lines = [];
    for (cy = 0; cy < rows; cy++) lines.push(chars.slice(cy * cols, cy * cols + cols).join(''));
    var card = { cols: cols, rows: rows, style: o.style, mode: o.mode, tint: o.tint, bg: o.bg, caption: o.caption, lines: lines, palette: null, idx: null };
    if (o.mode === 'color') {
      var rgb = new Uint8Array(nc * 3), mask = new Uint8Array(nc);
      for (i = 0; i < nc; i++) {
        var R = tone(crgb[i * 3]), G = tone(crgb[i * 3 + 1]), B = tone(crgb[i * 3 + 2]), mx = Math.max(R, G, B);
        // Ink only covers part of a cell, so on dark paper lift the value (the
        // character's coverage already carries the brightness); on light paper
        // deepen a little so pale colours still read.
        var f = dark ? (mx > 0.001 ? (0.38 + 0.62 * mx) / mx : 1) : 0.86;
        if (dark && mx <= 0.001) { R = G = B = 0.38; f = 1; }
        rgb[i * 3] = clamp(Math.round(R * f * 255), 0, 255);
        rgb[i * 3 + 1] = clamp(Math.round(G * f * 255), 0, 255);
        rgb[i * 3 + 2] = clamp(Math.round(B * f * 255), 0, 255);
        mask[i] = isBlank(chars[i]) ? 0 : 1;
      }
      var q = quantize(rgb, nc, o.colors, mask);
      card.palette = q.palette; card.idx = q.idx;
      fillBlanks(card);
    }
    return card;
  }
  // Blank cells take the previous cell's colour index (invisible either way,
  // and runs compress better).
  function fillBlanks(card) {
    var prev = 0, n = card.cols * card.rows;
    for (var i = 0; i < n; i++) {
      var ch = card.lines[(i / card.cols) | 0].charAt(i % card.cols);
      if (isBlank(ch)) card.idx[i] = prev; else prev = card.idx[i];
    }
    return card;
  }

  // ===================================================================== base64
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64R = null;
  function b64encode(bytes) {
    var out = [], i, n = bytes.length, v;
    for (i = 0; i + 2 < n; i += 3) {
      v = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
      out.push(B64.charAt(v >> 18 & 63) + B64.charAt(v >> 12 & 63) + B64.charAt(v >> 6 & 63) + B64.charAt(v & 63));
    }
    if (n - i === 1) { v = bytes[i] << 16; out.push(B64.charAt(v >> 18 & 63) + B64.charAt(v >> 12 & 63) + '=='); }
    else if (n - i === 2) { v = bytes[i] << 16 | bytes[i + 1] << 8; out.push(B64.charAt(v >> 18 & 63) + B64.charAt(v >> 12 & 63) + B64.charAt(v >> 6 & 63) + '='); }
    return out.join('');
  }
  // → Uint8Array, or null when it isn't base64 (url-safe letters accepted).
  function b64decode(s) {
    if (!B64R) { B64R = new Int16Array(128); for (var q = 0; q < 128; q++) B64R[q] = -1; for (q = 0; q < 64; q++) B64R[B64.charCodeAt(q)] = q; B64R[45] = 62; B64R[95] = 63; }
    s = String(s).replace(/[\s=]+/g, '');
    if (s.length % 4 === 1) return null;
    var out = new Uint8Array(Math.floor(s.length * 3 / 4)), o = 0, acc = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i), v = c < 128 ? B64R[c] : -1;
      if (v < 0) return null;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
    }
    return o === out.length ? out : out.subarray(0, o);
  }

  // ===================================================================== inflate
  // Raw DEFLATE (RFC 1951) decoder after Mark Adler's puff.c — small and
  // synchronous (DecompressionStream is async; renderers here are not).
  // Throws on anything malformed or bigger than `max` bytes.
  var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  var FIXED = null;
  function huffman(lens, off, n) {
    var count = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(n), i, left = 1;
    for (i = 0; i < n; i++) count[lens[off + i]]++;
    for (i = 1; i < 16; i++) { left = left * 2 - count[i]; if (left < 0) throw new Error('inflate: over-subscribed code'); }
    for (i = 1; i < 15; i++) offs[i + 1] = offs[i] + count[i];
    for (i = 0; i < n; i++) if (lens[off + i]) sym[offs[lens[off + i]]++] = i;
    return { count: count, sym: sym };
  }
  function inflateRaw(src, max) {
    var out = new Uint8Array(max), n = 0, pos = 0, bb = 0, bc = 0, last, type, i;
    function bits(k) {
      if (!k) return 0;
      while (bc < k) { if (pos >= src.length) throw new Error('inflate: truncated'); bb |= src[pos++] << bc; bc += 8; }
      var v = bb & ((1 << k) - 1); bb >>>= k; bc -= k; return v;
    }
    function decode(h) {
      var code = 0, first = 0, index = 0;
      for (var len = 1; len < 16; len++) {
        code |= bits(1);
        var c = h.count[len];
        if (code - c < first) return h.sym[index + (code - first)];
        index += c; first += c; first <<= 1; code <<= 1;
      }
      throw new Error('inflate: bad code');
    }
    function codes(lit, dist) {
      for (;;) {
        var s = decode(lit);
        if (s < 256) { if (n >= max) throw new Error('inflate: too long'); out[n++] = s; continue; }
        if (s === 256) return;
        s -= 257;
        if (s >= 29) throw new Error('inflate: bad length');
        var len = LBASE[s] + bits(LEXT[s]), ds = decode(dist);
        if (ds >= 30) throw new Error('inflate: bad distance');
        var d = DBASE[ds] + bits(DEXT[ds]);
        if (d > n) throw new Error('inflate: distance too far');
        if (n + len > max) throw new Error('inflate: too long');
        while (len--) { out[n] = out[n - d]; n++; }
      }
    }
    do {
      last = bits(1); type = bits(2);
      if (type === 0) {
        bb = 0; bc = 0;
        if (pos + 4 > src.length) throw new Error('inflate: truncated');
        var len = src[pos] | src[pos + 1] << 8, nlen = src[pos + 2] | src[pos + 3] << 8;
        pos += 4;
        if (len !== (~nlen & 0xffff)) throw new Error('inflate: bad stored block');
        if (pos + len > src.length) throw new Error('inflate: truncated');
        if (n + len > max) throw new Error('inflate: too long');
        for (i = 0; i < len; i++) out[n++] = src[pos++];
      } else if (type === 1) {
        if (!FIXED) {
          var fl = new Uint8Array(320);
          for (i = 0; i < 144; i++) fl[i] = 8;
          for (; i < 256; i++) fl[i] = 9;
          for (; i < 280; i++) fl[i] = 7;
          for (; i < 288; i++) fl[i] = 8;
          for (; i < 318; i++) fl[i] = 5;
          FIXED = [huffman(fl, 0, 288), huffman(fl, 288, 30)];
        }
        codes(FIXED[0], FIXED[1]);
      } else if (type === 2) {
        var nl = bits(5) + 257, nd = bits(5) + 1, nc = bits(4) + 4;
        if (nl > 286 || nd > 30) throw new Error('inflate: bad counts');
        var lens = new Uint8Array(320);
        for (i = 0; i < nc; i++) lens[CLORD[i]] = bits(3);
        var lc = huffman(lens, 0, 19);
        lens = new Uint8Array(320);
        i = 0;
        while (i < nl + nd) {
          var sym = decode(lc);
          if (sym < 16) { lens[i++] = sym; continue; }
          var rep, val = 0;
          if (sym === 16) { if (!i) throw new Error('inflate: repeat with no length'); val = lens[i - 1]; rep = 3 + bits(2); }
          else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (i + rep > nl + nd) throw new Error('inflate: too many lengths');
          while (rep--) lens[i++] = val;
        }
        if (!lens[256]) throw new Error('inflate: no end code');
        codes(huffman(lens, 0, nl), huffman(lens, nl, nd));
      } else throw new Error('inflate: bad block type');
    } while (!last);
    return out.subarray(0, n);
  }

  // ===================================================================== codec
  function packColors(card) {
    var n = card.palette.length / 3, nc = card.cols * card.rows, b = new Uint8Array(1 + n * 3 + nc);
    b[0] = n; b.set(card.palette, 1); b.set(card.idx.subarray(0, nc), 1 + n * 3);
    return b;
  }
  function colorLineOf(body, comp) {
    var useComp = false;
    if (comp && comp.length + 2 < body.length) {
      try { var chk = inflateRaw(comp, body.length); useComp = chk.length === body.length && eqBytes(chk, body); } catch (e) { useComp = false; }
    }
    var data = useComp ? comp : body, out = new Uint8Array(data.length + 2);
    out[0] = 1; out[1] = useComp ? 1 : 0; out.set(data, 2);
    return '~ ' + b64encode(out);
  }
  function eqBytes(a, b) { if (a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  // Synchronous: deflate is an optional function bytes → bytes (node's
  // zlib.deflateRawSync in tests); without one the layer is stored raw.
  function encodeColorsSync(card, deflate) {
    if (!card || !card.palette || !card.idx) return '';
    var body = packColors(card), comp = null;
    if (deflate) { try { comp = new Uint8Array(deflate(body)); } catch (e) { comp = null; } }
    return colorLineOf(body, comp);
  }
  // Browser: CompressionStream('deflate-raw') when there is one.
  function deflateRawAsync(bytes) {
    try {
      if (typeof CompressionStream !== 'function' || typeof Response !== 'function' || typeof Blob !== 'function') return Promise.resolve(null);
      var cs = new CompressionStream('deflate-raw');
      return new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer()
        .then(function (b) { return new Uint8Array(b); }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function encodeColors(card) {
    if (!card || !card.palette || !card.idx) return Promise.resolve('');
    var body = packColors(card);
    return deflateRawAsync(body).then(function (comp) { return colorLineOf(body, comp); });
  }
  // '~ …' (or just the base64) → { palette, idx } or null. Never throws.
  function decodeColors(line, cols, rows) {
    try {
      var nc = cols * rows;
      if (!(nc > 0)) return null;
      var bytes = b64decode(String(line).replace(/^\s*~\s*/, ''));
      if (!bytes || bytes.length < 3 || bytes[0] !== 1 || (bytes[1] & ~1)) return null;
      var body = bytes.subarray(2);
      if (bytes[1] & 1) body = inflateRaw(body, 1 + 64 * 3 + nc);
      var n = body[0];
      if (!(n >= 1 && n <= 64) || body.length !== 1 + n * 3 + nc) return null;
      var idx = body.slice(1 + n * 3);
      for (var i = 0; i < nc; i++) if (idx[i] >= n) return null;
      return { palette: body.slice(1, 1 + n * 3), idx: idx };
    } catch (e) { return null; }
  }

  // ---- fence info ----
  function modeToken(card) { return card.mode === 'tint' ? 'tint:' + (hexColor(card.tint) || DEFAULTS.tint) : card.mode; }
  function infoOf(card) {
    var cap = cleanCaption(card.caption);
    return 'postcard ' + card.cols + 'x' + card.rows + ' ' + card.style + ' ' + modeToken(card) + ' ' + (card.bg || 'dark') + (cap ? ' "' + cap + '"' : '');
  }
  // "postcard 64x32 classic color dark "Caption"" → meta, or null if it isn't a postcard.
  function parseInfo(info) {
    var s = String(info || '').replace(/^\s*`*\s*/, ''), re = /"([^"]*)"?|(\S+)/g, m, first = true;
    var meta = { cols: 0, rows: 0, style: 'classic', mode: 'mono', tint: DEFAULTS.tint, bg: 'dark', caption: '' };
    var gotMode = false;
    while ((m = re.exec(s))) {
      if (first) { if (m[2] == null || m[2].toLowerCase() !== 'postcard') return null; first = false; continue; }
      if (m[1] != null) { if (!meta.caption) meta.caption = cleanCaption(m[1]); continue; }
      var t = m[2].toLowerCase(), d = /^(\d{1,4})x(\d{1,4})$/.exec(t), tm;
      if (d) { meta.cols = +d[1]; meta.rows = +d[2]; }
      else if (STYLES.indexOf(t) >= 0) meta.style = t;
      else if (BGS.indexOf(t) >= 0) meta.bg = t;
      else if (t === 'color' || t === 'colour') { meta.mode = 'color'; gotMode = true; }
      else if (t === 'mono' || t === 'green' || t === 'sepia') { meta.mode = t; gotMode = true; }
      else if ((tm = /^tint(?:[:=]?(#?[0-9a-f]{3}|#?[0-9a-f]{6}))?$/.exec(t))) { meta.mode = 'tint'; gotMode = true; if (tm[1]) meta.tint = hexColor(tm[1]) || meta.tint; }
    }
    if (first) return null;
    meta.explicitMode = gotMode;
    if (meta.cols > MAX_DIM || meta.rows > MAX_DIM) { meta.cols = 0; meta.rows = 0; }
    return meta;
  }
  function hasSurrogates(s) { return /[\uD800-\uDFFF]/.test(s); }
  function fit(s, cols) {
    s = String(s || '').replace(/\t/g, ' ');
    if (hasSurrogates(s)) { var a = Array.from(s); s = a.slice(0, cols).join(''); var len = Math.min(a.length, cols); return len < cols ? s + new Array(cols - len + 1).join(' ') : s; }
    if (s.length >= cols) return s.slice(0, cols);
    return s + new Array(cols - s.length + 1).join(' ');
  }
  var COLOR_LINE_RE = /^~ ?[A-Za-z0-9+/=_-]{4,}\s*$/;
  // meta + the lines between the fences → card (colours null when absent / bad).
  function decode(meta, body) {
    body = body.slice();
    var colorLine = null;
    if (body.length > 1 && COLOR_LINE_RE.test(body[body.length - 1])) colorLine = body.pop();
    var cols = meta.cols, rows = meta.rows, y;
    if (!cols || !rows) {
      rows = Math.max(1, body.length); cols = 1;
      for (y = 0; y < body.length; y++) cols = Math.max(cols, Array.from(body[y]).length);
      cols = Math.min(cols, MAX_DIM); rows = Math.min(rows, MAX_DIM);
    }
    var lines = [];
    for (y = 0; y < rows; y++) lines.push(fit(body[y], cols));
    var card = { cols: cols, rows: rows, style: meta.style, mode: meta.mode, tint: meta.tint, bg: meta.bg, caption: meta.caption, lines: lines, palette: null, idx: null, colorError: false };
    // An explicit non-colour mode in the info wins: editing "color" to "mono"
    // is how you drop the colours without touching the data line.
    if (colorLine && (meta.mode === 'color' || !meta.explicitMode)) {
      var c = decodeColors(colorLine, cols, rows);
      if (c) { card.palette = c.palette; card.idx = c.idx; card.mode = 'color'; }
      else card.colorError = true;
    }
    if (card.mode === 'color' && !card.palette) { card.colorError = true; card.mode = 'mono'; }
    return card;
  }
  // A whole ```postcard … ``` block (closing fence optional) → card or null.
  function parseBlock(text) {
    try {
      var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
      if (lines[0].lastIndexOf('```', 0) !== 0) return null;
      var meta = parseInfo(lines[0].slice(3));
      if (!meta) return null;
      var end = lines.length;
      for (var i = 1; i < lines.length; i++) if (lines[i].lastIndexOf('```', 0) === 0) { end = i; break; }
      return decode(meta, lines.slice(1, end));
    } catch (e) { return null; }
  }
  // Every closed ```postcard block in a note (the editor's rule: a line that
  // starts with ``` opens or closes a fence). → [{ line (1-based), from, to, text, card }]
  function findBlocks(text) {
    var out = [];
    text = String(text == null ? '' : text);
    if (text.indexOf('```postcard') < 0) return out;
    var lines = text.split('\n'), pos = 0, open = -1, openLine = 0, isPc = false;
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i], from = pos;
      pos += t.length + 1;
      if (t.charCodeAt(0) !== 96 || t.lastIndexOf('```', 0) !== 0) continue;
      if (open < 0) { open = from; openLine = i; isPc = /^```postcard(?:\s|$)/.test(t); }
      else {
        if (isPc) {
          var blk = text.slice(open, from + t.replace(/\r$/, '').length);
          out.push({ line: openLine + 1, from: open, to: from + t.length, text: blk, card: parseBlock(blk) });
        }
        open = -1;
      }
    }
    return out;
  }
  function plainText(card) { return card.lines.join('\n'); }
  // card (+ its colour line, '' for none) → the fenced block, no trailing newline.
  function toText(card, colorLine) {
    return '```' + infoOf(card) + '\n' + card.lines.join('\n') + '\n' + (colorLine ? colorLine + '\n' : '') + '```';
  }
  function cardToText(card) { return encodeColors(card).then(function (cl) { return toText(card, cl); }); }

  function hash(s) {
    s = String(s);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h.toString(36) + s.length.toString(36);
  }

  // ===================================================================== render
  function hex2(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function colorsOf(card) {
    var bg = BGS.indexOf(card.bg) >= 0 ? card.bg : 'dark', pal = [];
    if (card.palette && card.idx) {
      for (var i = 0; i < card.palette.length; i += 3) pal.push('#' + hex2(card.palette[i]) + hex2(card.palette[i + 1]) + hex2(card.palette[i + 2]));
    } else {
      var m = card.mode === 'tint' ? null : INK[card.mode] || INK.mono;
      pal.push(m ? m[bg] : hexColor(card.tint) || DEFAULTS.tint);
    }
    return { bg: PAPER[bg], ink: INK.mono[bg], muted: MUTED[bg], palette: pal };
  }
  // Canvas geometry for a pixel width W: one cell of margin all round.
  function layout(card, W, withCaption) {
    var cw = W / (card.cols + 2), ch = cw * 2, capH = withCaption ? Math.round(Math.max(18, cw * 3.6)) : 0;
    return { width: Math.round(W), height: Math.round(cw * (card.rows * 2 + 2)) + capH, cw: cw, ch: ch, pad: cw, capH: capH };
  }
  // Drawing ops, grouped by colour so fillStyle changes once per colour:
  // text runs (consecutive same-colour ASCII), shade blocks, braille cells.
  function opsOf(card) {
    if (card._ops) return card._ops;
    var text = {}, blk = {}, brl = {}, cols = card.cols;
    var SHADE = { '░': 1, '▒': 2, '▓': 3, '█': 4 };
    for (var y = 0; y < card.rows; y++) {
      var line = card.lines[y], run = null;
      for (var x = 0; x < cols; x++) {
        var ch = line.charAt(x), code = ch.charCodeAt(0), ci = card.idx ? card.idx[y * cols + x] : 0;
        if (ch === ' ' || ch === '\u2800' || !ch) { run = null; continue; }
        if (code >= 0x2800 && code <= 0x28ff) { (brl[ci] || (brl[ci] = [])).push(x, y, code - 0x2800); run = null; continue; }
        if (SHADE[ch]) { var key = ci + ':' + SHADE[ch]; (blk[key] || (blk[key] = [])).push(x, y); run = null; continue; }
        var simple = code > 32 && code < 127;
        if (simple && run && run.ci === ci) { run.s += ch; continue; }
        run = { x: x, y: y, s: ch, ci: ci };
        (text[ci] || (text[ci] = [])).push(run);
        if (!simple) run = null;    // wide-ish / fallback glyphs sit in their own cell
      }
    }
    return (card._ops = { text: text, blk: blk, brl: brl });
  }
  // Draw onto a 2D context. o: { width (px), font (CSS family), captionFont,
  // caption (bool) }. Returns the layout. Sizes the canvas when given one.
  function draw(ctx, card, o) {
    o = o || {};
    var L = layout(card, o.width || 640, !!(o.caption && card.caption)), C = colorsOf(card), ops = opsOf(card);
    var fam = o.font || 'monospace', k, i, a;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, L.width, L.height);
    // fit the font so one advance = one cell
    ctx.font = '100px ' + fam;
    var adv = ctx.measureText('M').width || 60, advI = ctx.measureText('i').width || adv;
    var fs = 100 * L.cw / adv, mono = Math.abs(advI - adv) < adv * 0.02;
    ctx.font = fs.toFixed(2) + 'px ' + fam;
    try { ctx.textRendering = 'optimizeSpeed'; } catch (e) {}  // no ligatures where supported
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    var px = L.pad, py = L.pad, cw = L.cw, chh = L.ch;
    for (k in ops.text) {
      var runs = ops.text[k];
      ctx.fillStyle = C.palette[k] || C.palette[0];
      for (i = 0; i < runs.length; i++) {
        var r = runs[i], ty = py + (r.y + 0.5) * chh;
        if (mono || r.s.length === 1) ctx.fillText(r.s, px + r.x * cw, ty);
        else for (a = 0; a < r.s.length; a++) ctx.fillText(r.s.charAt(a), px + (r.x + a) * cw, ty);
      }
    }
    // shade blocks as rectangles: seamless, independent of the font
    for (k in ops.blk) {
      var parts = k.split(':'), cells = ops.blk[k];
      ctx.fillStyle = C.palette[+parts[0]] || C.palette[0];
      ctx.globalAlpha = +parts[1] / 4;
      for (i = 0; i < cells.length; i += 2) {
        var x0 = Math.round(px + cells[i] * cw), x1 = Math.round(px + (cells[i] + 1) * cw);
        var y0 = Math.round(py + cells[i + 1] * chh), y1 = Math.round(py + (cells[i + 1] + 1) * chh);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
      ctx.globalAlpha = 1;
    }
    // braille as round dots, one path per colour
    var dx = cw / 2, dy = chh / 4, rad = Math.max(0.5, Math.min(dx, dy) * 0.38);
    for (k in ops.brl) {
      var bl = ops.brl[k];
      ctx.fillStyle = C.palette[k] || C.palette[0];
      ctx.beginPath();
      for (i = 0; i < bl.length; i += 3) {
        var bx = px + bl[i] * cw, by = py + bl[i + 1] * chh, bits = bl[i + 2];
        for (var c = 0; c < 2; c++) for (var rr = 0; rr < 4; rr++) {
          if (!(bits & BRAILLE_BITS[c][rr])) continue;
          var cx = bx + (c + 0.5) * dx, cy = by + (rr + 0.5) * dy;
          ctx.moveTo(cx + rad, cy);
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
    if (L.capH) {
      var cy2 = L.height - L.capH / 2 - L.pad * 0.35, cfs = Math.max(11, L.capH * 0.42);
      ctx.fillStyle = C.ink;
      ctx.textBaseline = 'middle';
      ctx.font = 'italic ' + cfs.toFixed(1) + 'px ' + (o.captionFont || 'Georgia, serif');
      ctx.fillText(card.caption, L.pad, cy2, L.width * 0.68);
      ctx.fillStyle = C.muted;
      ctx.textAlign = 'right';
      ctx.font = (cfs * 0.72).toFixed(1) + 'px ' + fam;
      ctx.fillText(card.cols + '×' + card.rows + ' · ' + card.style, L.width - L.pad, cy2, L.width * 0.28);
      ctx.textAlign = 'left';
    }
    return L;
  }
  function render(canvas, card, o) {
    var L = layout(card, (o && o.width) || 640, !!(o && o.caption && card.caption));
    if (canvas.width !== L.width) canvas.width = L.width;
    if (canvas.height !== L.height) canvas.height = L.height;
    return draw(canvas.getContext('2d'), card, o);
  }
  // The app's monospace stack (--font-mono), for canvases.
  function monoFont() {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
      return v || 'monospace';
    } catch (e) { return 'monospace'; }
  }
  function bodyFont() {
    try { return getComputedStyle(document.documentElement).getPropertyValue('--font-body').trim() || 'sans-serif'; } catch (e) { return 'sans-serif'; }
  }
  // Resolves once the font can draw (or after a short wait: then a fallback draws).
  var fontWaits = {};
  function fontReady(fam) {
    fam = fam || monoFont();
    if (fontWaits[fam]) return fontWaits[fam];
    var p;
    try {
      if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) p = Promise.resolve();
      else p = Promise.race([document.fonts.load('16px ' + fam, 'M@#█').catch(function () {}), new Promise(function (r) { setTimeout(r, 1500); })]);
    } catch (e) { p = Promise.resolve(); }
    return (fontWaits[fam] = p.then(function () {}));
  }

  // ===================================================================== demo image
  // A procedural sunset (RGBA), for "Try a sample" and the tests.
  function demoImage(w, h) {
    var d = new Uint8ClampedArray(w * h * 4), sunX = w * 0.62, sunY = h * 0.5, sunR = Math.min(w, h) * 0.13;
    for (var y = 0; y < h; y++) {
      var t = y / h;
      for (var x = 0; x < w; x++) {
        var r, g, b, p = (y * w + x) * 4;
        var hill = h * (0.6 + 0.06 * Math.sin(x / w * 7 + 1) + 0.03 * Math.sin(x / w * 23));
        if (y < h * 0.62) {           // sky: purple → orange
          var s = t / 0.62;
          r = 70 + 185 * s; g = 40 + 110 * s * s; b = 120 - 60 * s;
          var dd = Math.hypot(x - sunX, y - sunY);
          if (dd < sunR) { r = 255; g = 236; b = 170; }
          else if (dd < sunR * 2.4) { var gl = 1 - (dd - sunR) / (sunR * 1.4); r += (255 - r) * gl * 0.6; g += (200 - g) * gl * 0.5; b += (120 - b) * gl * 0.3; }
        } else {                       // sea with a broken reflection
          var s2 = (t - 0.62) / 0.38;
          r = 30 + 30 * (1 - s2); g = 50 + 40 * (1 - s2); b = 90 + 50 * (1 - s2);
          var ref = Math.abs(x - sunX) < sunR * (0.5 + s2) && Math.sin(y * 0.9 + x * 0.05) > -0.2;
          if (ref) { r = 240; g = 170; b = 90; }
        }
        if (y > hill && y < h * 0.66 && x < w * 0.45) { r = 25; g = 30; b = 35; } // headland
        if (Math.abs(x - w * 0.3) < w * 0.045 && Math.abs(y - h * 0.68) < h * 0.012) { r = 20; g = 20; b = 20; } // boat
        if (Math.abs(x - w * 0.3) < w * 0.004 && y > h * 0.6 && y < h * 0.68) { r = 20; g = 20; b = 20; } // mast
        d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
      }
    }
    return { data: d, width: w, height: h };
  }

  var api = {
    version: 1, ASPECT: ASPECT, MIN_COLS: MIN_COLS, MAX_COLS: MAX_COLS, MAX_ROWS: MAX_ROWS,
    RAMPS: RAMPS, EDGE_FILL: EDGE_FILL, STYLES: STYLES, MODES: MODES, BGS: BGS, DEFAULTS: DEFAULTS, BRAILLE_BITS: BRAILLE_BITS,
    PAPER: PAPER, INK: INK,
    normalize: normalize, gridSize: gridSize, cleanCaption: cleanCaption, cleanPhrase: cleanPhrase, hexColor: hexColor,
    sample: sample, levels: levels, quantizeLevels: quantizeLevels, edgeCells: edgeCells, edgeChar: edgeChar,
    quantize: quantize, convert: convert, fillBlanks: fillBlanks,
    b64encode: b64encode, b64decode: b64decode, inflateRaw: inflateRaw,
    packColors: packColors, encodeColors: encodeColors, encodeColorsSync: encodeColorsSync, decodeColors: decodeColors,
    infoOf: infoOf, parseInfo: parseInfo, decode: decode, parseBlock: parseBlock, findBlocks: findBlocks,
    toText: toText, cardToText: cardToText, plainText: plainText, hash: hash,
    colorsOf: colorsOf, layout: layout, opsOf: opsOf, draw: draw, render: render,
    monoFont: monoFont, bodyFont: bodyFont, fontReady: fontReady, demoImage: demoImage,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__cadePostcard = api;
})(typeof self !== 'undefined' ? self : this);
