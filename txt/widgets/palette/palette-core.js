/* Photo Palette — the pure part (no DOM): colour conversions, the palette
 * extractor, colour naming and every text the widget copies or inserts.
 * Loaded by palette.js in the browser (window.__cadePaletteCore) and by
 * palette.test.js in node (module.exports).
 *
 * Extraction: the RGBA buffer (the widget hands over ≤ 200×200; anything
 * bigger is sampled with a stride) is converted to OKLab, so distances are
 * perceptual. Pixels are pre-binned at 5 bits per channel (each bin keeps the
 * exact mean of its pixels, so flat colours come back exactly), alpha below
 * 8 is ignored and translucent pixels count by their alpha. The bins are
 * over-clustered with a seeded k-means++ (deterministic: same picture, same
 * palette), near-duplicates (ΔE_OK < MERGE_DE) are merged, and the k most
 * prominent clusters are kept: prominence is √share × (1 + 6·chroma), so a
 * 4% bright accent outranks a neutral four times its size. They are listed
 * by √share × (1 + 3·chroma): mostly by area, vivid colours a little ahead.
 * Shares are then recounted against the chosen colours only (they sum to 1),
 * and each colour gets the pixel that best represents it (closest to the
 * centroid, in a solid area) for the photo marker. */
(function (root) {
  'use strict';

  // ---- sRGB <-> linear <-> OKLab / OKLCH (Björn Ottosson's matrices) ----
  var LIN = new Float64Array(256);
  for (var i = 0; i < 256; i++) { var v = i / 255; LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function toLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function fromLin(x) { x = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; return x * 255; }
  function cbrt(x) { return x < 0 ? -Math.pow(-x, 1 / 3) : Math.pow(x, 1 / 3); }
  function clamp255(x) { return x < 0 ? 0 : x > 255 ? 255 : Math.round(x); }

  function linToOklab(r, g, b) {
    var l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return {
      L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    };
  }
  // 0–255 sRGB (integers or not) → OKLab {L 0..1, a, b}
  function rgbToOklab(r, g, b) {
    if (typeof r === 'object') { b = r.b; g = r.g; r = r.r; }
    var ri = r | 0, gi = g | 0, bi = b | 0;
    if (ri === r && gi === g && bi === b && ri >= 0 && ri < 256 && gi >= 0 && gi < 256 && bi >= 0 && bi < 256) return linToOklab(LIN[ri], LIN[gi], LIN[bi]);
    return linToOklab(toLin(r), toLin(g), toLin(b));
  }
  // OKLab → sRGB; exact (unrounded, unclamped) unless round is set
  function oklabToRgb(L, a, b, round) {
    if (typeof L === 'object') { round = a; b = L.b; a = L.a; L = L.L; }
    var l = L + 0.3963377774 * a + 0.2158037573 * b;
    var m = L - 0.1055613458 * a - 0.0638541728 * b;
    var s = L - 0.0894841775 * a - 1.2914855480 * b;
    l = l * l * l; m = m * m * m; s = s * s * s;
    var r = fromLin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
    var g = fromLin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
    var bb = fromLin(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
    if (round !== false) return { r: clamp255(r), g: clamp255(g), b: clamp255(bb) };
    return { r: r, g: g, b: bb };
  }
  function oklabToOklch(lab) {
    var C = Math.sqrt(lab.a * lab.a + lab.b * lab.b), h = Math.atan2(lab.b, lab.a) * 180 / Math.PI;
    if (h < 0) h += 360;
    return { L: lab.L, C: C, h: C < 1e-4 ? 0 : h };
  }
  function oklchToOklab(lch) {
    var hr = lch.h * Math.PI / 180;
    return { L: lch.L, a: lch.C * Math.cos(hr), b: lch.C * Math.sin(hr) };
  }
  function deltaE(p, q) { var dL = p.L - q.L, da = p.a - q.a, db = p.b - q.b; return Math.sqrt(dL * dL + da * da + db * db); }

  // ---- hex / rgb / hsl ----
  function hex2(n) { return ('0' + clamp255(n).toString(16)).slice(-2); }
  function rgbToHex(r, g, b) { if (typeof r === 'object') { b = r.b; g = r.g; r = r.r; } return '#' + hex2(r) + hex2(g) + hex2(b); }
  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  // → { h 0..360, s 0..1, l 0..1 }
  function rgbToHsl(c) {
    var r = c.r / 255, g = c.g / 255, b = c.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s, l: l };
  }
  function hslToRgb(hsl) {
    var h = ((hsl.h % 360) + 360) % 360 / 360, s = hsl.s, l = hsl.l;
    if (!s) { var g0 = clamp255(l * 255); return { r: g0, g: g0, b: g0 }; }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    function f(t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    return { r: clamp255(f(h + 1 / 3) * 255), g: clamp255(f(h) * 255), b: clamp255(f(h - 1 / 3) * 255) };
  }

  // ---- the strings the cards copy ----
  function fmtHex(c) { return rgbToHex(c); }
  function fmtRgb(c) { return 'rgb(' + clamp255(c.r) + ', ' + clamp255(c.g) + ', ' + clamp255(c.b) + ')'; }
  function fmtHsl(c) {
    var x = rgbToHsl(c), h = Math.round(x.h) % 360;
    return 'hsl(' + h + ', ' + Math.round(x.s * 100) + '%, ' + Math.round(x.l * 100) + '%)';
  }
  function trim0(s) { return s.indexOf('.') < 0 ? s : s.replace(/0+$/, '').replace(/\.$/, ''); }
  function fmtOklch(c) {
    var lch = oklabToOklch(rgbToOklab(c));
    var C = lch.C < 0.0005 ? 0 : lch.C;
    return 'oklch(' + trim0((lch.L * 100).toFixed(1)) + '% ' + trim0(C.toFixed(3)) + ' ' + (C ? trim0(lch.h.toFixed(1)) : '0') + ')';
  }

  // ---- WCAG contrast ----
  function relLum(c) { return 0.2126 * LIN[clamp255(c.r)] + 0.7152 * LIN[clamp255(c.g)] + 0.0722 * LIN[clamp255(c.b)]; }
  function contrast(c1, c2) { var a = relLum(c1) + 0.05, b = relLum(c2) + 0.05; return a > b ? a / b : b / a; }
  // Black or white, whichever reads better on c → { color, ratio }
  function textColor(c) {
    var w = contrast(c, { r: 255, g: 255, b: 255 }), k = contrast(c, { r: 0, g: 0, b: 0 });
    return w >= k ? { color: '#ffffff', ratio: w } : { color: '#000000', ratio: k };
  }

  // ---- names: the CSS named colours (grey spelt the British way, aliases
  //      aqua/fuchsia dropped) plus a few everyday names CSS lacks ----
  var CSS_NAMES = 'Alice blue f0f8ff,Antique white faebd7,Aquamarine 7fffd4,Azure f0ffff,Beige f5f5dc,Bisque ffe4c4,Black 000000,' +
    'Blanched almond ffebcd,Blue 0000ff,Blue violet 8a2be2,Brown a52a2a,Burlywood deb887,Cadet blue 5f9ea0,Chartreuse 7fff00,' +
    'Chocolate d2691e,Coral ff7f50,Cornflower blue 6495ed,Cornsilk fff8dc,Crimson dc143c,Cyan 00ffff,Dark blue 00008b,Dark cyan 008b8b,' +
    'Dark goldenrod b8860b,Dark grey a9a9a9,Dark green 006400,Dark khaki bdb76b,Dark magenta 8b008b,Dark olive green 556b2f,' +
    'Dark orange ff8c00,Dark orchid 9932cc,Dark red 8b0000,Dark salmon e9967a,Dark sea green 8fbc8f,Dark slate blue 483d8b,' +
    'Dark slate grey 2f4f4f,Dark turquoise 00ced1,Dark violet 9400d3,Deep pink ff1493,Deep sky blue 00bfff,Dim grey 696969,' +
    'Dodger blue 1e90ff,Firebrick b22222,Floral white fffaf0,Forest green 228b22,Gainsboro dcdcdc,Ghost white f8f8ff,Gold ffd700,' +
    'Goldenrod daa520,Grey 808080,Green 008000,Green yellow adff2f,Honeydew f0fff0,Hot pink ff69b4,Indian red cd5c5c,Indigo 4b0082,' +
    'Ivory fffff0,Khaki f0e68c,Lavender e6e6fa,Lavender blush fff0f5,Lawn green 7cfc00,Lemon chiffon fffacd,Light blue add8e6,' +
    'Light coral f08080,Light cyan e0ffff,Light goldenrod yellow fafad2,Light grey d3d3d3,Light green 90ee90,Light pink ffb6c1,' +
    'Light salmon ffa07a,Light sea green 20b2aa,Light sky blue 87cefa,Light slate grey 778899,Light steel blue b0c4de,' +
    'Light yellow ffffe0,Lime 00ff00,Lime green 32cd32,Linen faf0e6,Magenta ff00ff,Maroon 800000,Medium aquamarine 66cdaa,' +
    'Medium blue 0000cd,Medium orchid ba55d3,Medium purple 9370db,Medium sea green 3cb371,Medium slate blue 7b68ee,' +
    'Medium spring green 00fa9a,Medium turquoise 48d1cc,Medium violet red c71585,Midnight blue 191970,Mint cream f5fffa,' +
    'Misty rose ffe4e1,Moccasin ffe4b5,Navajo white ffdead,Navy 000080,Old lace fdf5e6,Olive 808000,Olive drab 6b8e23,Orange ffa500,' +
    'Orange red ff4500,Orchid da70d6,Pale goldenrod eee8aa,Pale green 98fb98,Pale turquoise afeeee,Pale violet red db7093,' +
    'Papaya whip ffefd5,Peach puff ffdab9,Peru cd853f,Pink ffc0cb,Plum dda0dd,Powder blue b0e0e6,Purple 800080,Rebecca purple 663399,' +
    'Red ff0000,Rosy brown bc8f8f,Royal blue 4169e1,Saddle brown 8b4513,Salmon fa8072,Sandy brown f4a460,Sea green 2e8b57,' +
    'Seashell fff5ee,Sienna a0522d,Silver c0c0c0,Sky blue 87ceeb,Slate blue 6a5acd,Slate grey 708090,Snow fffafa,Spring green 00ff7f,' +
    'Steel blue 4682b4,Tan d2b48c,Teal 008080,Thistle d8bfd8,Tomato ff6347,Turquoise 40e0d0,Violet ee82ee,Wheat f5deb3,White ffffff,' +
    'White smoke f5f5f5,Yellow ffff00,Yellow green 9acd32';
  var EXTRA_NAMES = 'Charcoal 36454f,Cream fffdd0,Mustard e1ad01,Sage b2ac88,Rust b7410e,Terracotta e2725b,Burgundy 800020,' +
    'Sand c2b280,Ochre cc7722,Denim 1560bd,Oxford blue 002147,Prussian blue 003153,Petrol 005f6a,Bottle green 006a4e,' +
    'Moss green 8a9a5b,Wine 722f37,Raspberry b3446c,Aubergine 3d0734,Mauve b784a7,Taupe 483c32,Graphite 3c3c3c,Jet 242424';
  function parseNames(s, extra) {
    return s.split(',').map(function (e) {
      var sp = e.lastIndexOf(' '), rgb = hexToRgb(e.slice(sp + 1));
      return { name: e.slice(0, sp), hex: '#' + e.slice(sp + 1), rgb: rgb, lab: rgbToOklab(rgb), extra: !!extra };
    });
  }
  var NAMES = parseNames(CSS_NAMES).concat(parseNames(EXTRA_NAMES, true));
  function nameOf(c) {
    var lab = c.L != null ? c : rgbToOklab(c), best = null, bd = 1e9;
    for (var i = 0; i < NAMES.length; i++) { var d = deltaE(lab, NAMES[i].lab); if (d < bd) { bd = d; best = NAMES[i]; } }
    return best.name;
  }

  // ---- seeded PRNG (mulberry32) ----
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var MERGE_DE = 0.04;     // OKLab ΔE under which two palette colours count as one
  var COUNTS = [5, 6, 8, 10];

  // Weighted k-means++ over bins (parallel arrays L/A/B/W, n entries).
  function kmeans(L, A, B, W, n, k, seed, iters) {
    var rand = rng(seed || 1), cL = [], cA = [], cB = [];
    if (n === 0 || k <= 0) return { L: cL, A: cA, B: cB };
    k = Math.min(k, n);
    // first centre: the heaviest bin (deterministic and always a real colour)
    var first = 0;
    for (var i = 1; i < n; i++) if (W[i] > W[first]) first = i;
    cL.push(L[first]); cA.push(A[first]); cB.push(B[first]);
    var D = new Float64Array(n);
    for (i = 0; i < n; i++) D[i] = sq(i, 0);
    function sq(i, c) { var dl = L[i] - cL[c], da = A[i] - cA[c], db = B[i] - cB[c]; return dl * dl + da * da + db * db; }
    while (cL.length < k) {
      var tot = 0;
      for (i = 0; i < n; i++) tot += W[i] * D[i];
      if (tot <= 1e-12) break;              // every bin already sits on a centre
      var r = rand() * tot, pick = n - 1;
      for (i = 0; i < n; i++) { r -= W[i] * D[i]; if (r <= 0) { pick = i; break; } }
      cL.push(L[pick]); cA.push(A[pick]); cB.push(B[pick]);
      var c = cL.length - 1;
      for (i = 0; i < n; i++) { var d = sq(i, c); if (d < D[i]) D[i] = d; }
    }
    k = cL.length;
    var asg = new Int32Array(n);
    for (var it = 0; it < (iters || 24); it++) {
      var sL = new Float64Array(k), sA = new Float64Array(k), sB = new Float64Array(k), sW = new Float64Array(k);
      for (i = 0; i < n; i++) {
        var bi = 0, bd = 1e9;
        for (c = 0; c < k; c++) { d = sq(i, c); if (d < bd) { bd = d; bi = c; } }
        asg[i] = bi;
        sL[bi] += L[i] * W[i]; sA[bi] += A[i] * W[i]; sB[bi] += B[i] * W[i]; sW[bi] += W[i];
      }
      var moved = 0;
      for (c = 0; c < k; c++) {
        if (!sW[c]) continue;
        var nl = sL[c] / sW[c], na = sA[c] / sW[c], nb = sB[c] / sW[c];
        moved = Math.max(moved, Math.abs(nl - cL[c]) + Math.abs(na - cA[c]) + Math.abs(nb - cB[c]));
        cL[c] = nl; cA[c] = na; cB[c] = nb;
      }
      if (moved < 2e-4) break;   // well below a visible difference (JND ≈ 0.02)
    }
    return { L: cL, A: cA, B: cB };
  }

  // data: RGBA (Uint8ClampedArray / array), w×h. opts: { k (default 6),
  // seed, maxPixels (default 40000), iters }. → { colors: [...], total, w, h }
  function extract(data, w, h, opts) {
    opts = opts || {};
    var k = Math.max(1, Math.min(16, opts.k | 0 || 6));
    var step = 1, maxPx = opts.maxPixels || 40000;
    while ((Math.ceil(w / step) * Math.ceil(h / step)) > maxPx) step++;
    var gw = Math.ceil(w / step), gh = Math.ceil(h / step), N = gw * gh;
    // per sample: its bin (-1 = transparent) and OKLab, for the markers
    var pBin = new Int32Array(N), pL = new Float32Array(N), pA = new Float32Array(N), pB = new Float32Array(N);
    var binOf = new Int32Array(32768).fill(-1);
    var bL = [], bA = [], bB = [], bW = [], nb = 0, total = 0;
    for (var gy = 0; gy < gh; gy++) for (var gx = 0; gx < gw; gx++) {
      var pi = gy * gw + gx, o = ((gy * step) * w + gx * step) * 4, al = data[o + 3];
      if (al < 8) { pBin[pi] = -1; continue; }
      var r = data[o], g = data[o + 1], b = data[o + 2];
      var lab = linToOklab(LIN[r], LIN[g], LIN[b]);
      pL[pi] = lab.L; pA[pi] = lab.a; pB[pi] = lab.b;
      var key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3), bi = binOf[key], wt = al / 255;
      if (bi < 0) { bi = binOf[key] = nb++; bL.push(0); bA.push(0); bB.push(0); bW.push(0); }
      bL[bi] += lab.L * wt; bA[bi] += lab.a * wt; bB[bi] += lab.b * wt; bW[bi] += wt;
      pBin[pi] = bi; total += wt;
    }
    var out = { colors: [], total: total, w: gw, h: gh };
    if (!nb) return out;
    for (var i = 0; i < nb; i++) { bL[i] /= bW[i]; bA[i] /= bW[i]; bB[i] /= bW[i]; }

    // 1. over-cluster
    var K0 = Math.min(nb, Math.max(k + 8, k * 2));
    var km = kmeans(bL, bA, bB, bW, nb, K0, opts.seed || 7, opts.iters);
    var cl = [];
    for (i = 0; i < km.L.length; i++) cl.push({ L: km.L[i], a: km.A[i], b: km.B[i], w: 0 });
    assign(cl, bL, bA, bB, bW, nb);
    cl = cl.filter(function (c) { return c.w > 0; });
    // 2. merge near-duplicates (closest pair first) into their weighted mean
    for (;;) {
      var bi2 = -1, bj = -1, bd = MERGE_DE;
      for (i = 0; i < cl.length; i++) for (var j = i + 1; j < cl.length; j++) {
        var d = deltaE(cl[i], cl[j]);
        if (d < bd) { bd = d; bi2 = i; bj = j; }
      }
      if (bi2 < 0) break;
      var p = cl[bi2], q = cl[bj], W = p.w + q.w;
      cl[bi2] = { L: (p.L * p.w + q.L * q.w) / W, a: (p.a * p.w + q.a * q.w) / W, b: (p.b * p.w + q.b * q.w) / W, w: W };
      cl.splice(bj, 1);
    }
    // 3. keep the k most prominent (a strong vivid boost here, so an accent
    //    survives several bigger neutrals), then recount shares against those
    cl.forEach(function (c) { c.score = prominence(c.w / total, Math.sqrt(c.a * c.a + c.b * c.b), 6); });
    cl.sort(function (x, y) { return y.score - x.score || y.w - x.w; });
    cl = pickDiverse(cl, k);
    var binC = assign(cl, bL, bA, bB, bW, nb);   // bin → index into cl as it is now
    // listing order: population first, with a milder boost for vivid colours
    cl.forEach(function (c, idx) { c.i0 = idx; c.score = prominence(c.w / total, Math.sqrt(c.a * c.a + c.b * c.b), 3); });
    cl.sort(function (x, y) { return y.score - x.score || y.w - x.w; });
    var order = new Int32Array(cl.length), best = [], bestD = [];
    cl.forEach(function (c, idx) { order[c.i0] = idx; });
    // 4. the most typical sample of each colour: nearest its centre, preferring
    //    one whose 4 neighbours belong to the same colour (inside a solid area)
    //    and, among equals, nearest the middle of where that colour lies
    var mx = new Float64Array(cl.length), my = new Float64Array(cl.length), mn = new Float64Array(cl.length);
    for (pi = 0; pi < N; pi++) {
      if (pBin[pi] < 0) continue;
      var c1 = order[binC[pBin[pi]]];
      mx[c1] += (pi % gw) / gw; my[c1] += Math.floor(pi / gw) / gh; mn[c1]++;
    }
    for (i = 0; i < cl.length; i++) { best.push(-1); bestD.push(1e9); if (mn[i]) { mx[i] /= mn[i]; my[i] /= mn[i]; } }
    for (pi = 0; pi < N; pi++) {
      var bn = pBin[pi];
      if (bn < 0) continue;
      var ci = order[binC[bn]], c0 = cl[ci];
      var dl = pL[pi] - c0.L, da = pA[pi] - c0.a, db = pB[pi] - c0.b, dd = Math.sqrt(dl * dl + da * da + db * db);
      var x = pi % gw, y = (pi - x) / gw, odd = 0;
      if (x > 0 && !same(pi - 1)) odd++;
      if (x < gw - 1 && !same(pi + 1)) odd++;
      if (y > 0 && !same(pi - gw)) odd++;
      if (y < gh - 1 && !same(pi + gw)) odd++;
      var sx = x / gw - mx[ci], sy = y / gh - my[ci];
      dd += odd * 0.05 + 0.008 * Math.sqrt(sx * sx + sy * sy);
      if (dd < bestD[ci]) { bestD[ci] = dd; best[ci] = pi; }
    }
    function same(qi) { var b2 = pBin[qi]; return b2 >= 0 && order[binC[b2]] === ci; }
    out.colors = cl.map(function (c, idx) {
      var rgb = oklabToRgb(c.L, c.a, c.b), pix = best[idx];
      var col = describe(rgb, c.w / total);
      col.x = pix < 0 ? 0.5 : ((pix % gw) + 0.5) / gw;
      col.y = pix < 0 ? 0.5 : (Math.floor(pix / gw) + 0.5) / gh;
      return col;
    }).filter(function (c) { return c.share > 0; });
    return out;
  }
  // Greedy choice of k: each pick maximises prominence × how far it is from
  // the colours already picked (full weight from DIVERSE_DE on), so the
  // slices of one big gradient don't crowd out a sun or a hill.
  var DIVERSE_DE = 0.15;
  function pickDiverse(cl, k) {
    if (cl.length <= k) return cl;
    var left = cl.slice(), out = [];
    while (out.length < k && left.length) {
      var bi = 0, bv = -1;
      for (var i = 0; i < left.length; i++) {
        var dmin = 1;
        for (var j = 0; j < out.length; j++) dmin = Math.min(dmin, deltaE(left[i], out[j]));
        var v = left[i].score * Math.min(1, dmin / DIVERSE_DE);
        if (v > bv) { bv = v; bi = i; }
      }
      out.push(left.splice(bi, 1)[0]);
    }
    return out;
  }
  function prominence(share, chroma, boost) { return Math.sqrt(share) * (1 + boost * Math.min(chroma, 0.25)); }
  // Nearest-centre assignment of the bins; sets each cluster's weight w.
  // → Int32Array: bin → cluster index
  function assign(cl, L, A, B, W, n) {
    var of = new Int32Array(n), k = cl.length;
    cl.forEach(function (c) { c.w = 0; });
    for (var i = 0; i < n; i++) {
      var bi = 0, bd = 1e9;
      for (var c = 0; c < k; c++) {
        var dl = L[i] - cl[c].L, da = A[i] - cl[c].a, db = B[i] - cl[c].b, d = dl * dl + da * da + db * db;
        if (d < bd) { bd = d; bi = c; }
      }
      of[i] = bi; cl[bi].w += W[i];
    }
    return of;
  }
  // Everything a card shows / copies for one colour.
  function describe(rgb, share) {
    var lab = rgbToOklab(rgb), lch = oklabToOklch(lab), t = textColor(rgb);
    return {
      r: rgb.r, g: rgb.g, b: rgb.b,
      hex: fmtHex(rgb), rgb: fmtRgb(rgb), hsl: fmtHsl(rgb), oklch: fmtOklch(rgb),
      lab: lab, lch: lch, share: share == null ? 0 : share,
      text: t.color, contrast: t.ratio, name: nameOf(lab)
    };
  }

  // ---- outputs ----
  function pct(share) { var p = Math.round(share * 100); return p < 1 && share > 0 ? '<1%' : p + '%'; }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function cssVars(colors) {
    return ':root {\n' + colors.map(function (c, i) {
      return '  --palette-' + (i + 1) + ': ' + c.hex + '; /* ' + c.name + ' */';
    }).join('\n') + '\n}';
  }
  function jsonArray(colors) {
    return JSON.stringify(colors.map(function (c) {
      return { hex: c.hex, rgb: [c.r, c.g, c.b], hsl: c.hsl, oklch: c.oklch, name: c.name, share: Math.round(c.share * 1000) / 1000 };
    }), null, 2);
  }
  function hexList(colors) { return colors.map(function (c) { return c.hex; }).join('\n'); }
  function cleanCaption(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80); }
  // The block kept in the note: a heading and one Markdown list line per
  // colour (the editor tints #hex and rgb() literals with their own colour).
  function noteBlock(colors, caption) {
    var cap = cleanCaption(caption);
    var lines = ['### Palette' + (cap ? ' — ' + cap : '')];
    colors.forEach(function (c) { lines.push('- ' + c.hex + '  ' + c.rgb + '  ' + c.name + '  (' + pct(c.share) + ')'); });
    return lines.join('\n');
  }
  // End of the ``` block holding pos (a line starting with ``` opens or
  // closes one, as in the editor), or -1 when pos is outside every block.
  function fenceEndAt(text, pos) {
    var open = -1, from = 0, n = text.length;
    while (from <= n) {
      var nl = text.indexOf('\n', from), end = nl < 0 ? n : nl, lf = from;
      if (open < 0 && lf > pos) return -1;
      if (text.charCodeAt(lf) === 96 && text.lastIndexOf('```', lf) === lf) {
        if (open < 0) open = lf;
        else { if (pos <= end) return end; open = -1; }
      }
      if (nl < 0) break;
      from = nl + 1;
    }
    return open >= 0 && pos >= open ? n : -1;
  }
  // Where and what to insert so the block stands on its own lines with a
  // blank line around it; after the fence when the caret is inside one.
  // → { from, to, insert, cursor }
  function insertPlan(text, from, to, block) {
    var fe = fenceEndAt(text, from);
    if (fe >= 0) from = to = fe;
    var before = text.slice(0, from), after = text.slice(to);
    var pre = !before || /\n\n$/.test(before) ? '' : /\n$/.test(before) ? '\n' : '\n\n';
    var post = !after ? '\n' : /^\n\n/.test(after) ? '' : /^\n/.test(after) ? '\n' : '\n\n';
    var ins = pre + block + post;
    return { from: from, to: to, insert: ins, cursor: from + pre.length + block.length };
  }

  // ---- the PNG strip: equal swatches with hex, name and share ----
  function stripSize(n) { return { width: Math.max(1200, n * 170), height: 420 }; }
  // Draws on any 2D-context-like object (tested with a recorder).
  function drawStrip(ctx, colors, opts) {
    opts = opts || {};
    var n = colors.length, sz = stripSize(n), W = opts.width || sz.width, H = opts.height || sz.height;
    var mono = opts.mono || 'ui-monospace, Menlo, monospace', sans = opts.sans || 'system-ui, -apple-system, sans-serif';
    var cap = cleanCaption(opts.caption), capH = cap ? 56 : 0;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    var sw = W / Math.max(1, n), sh = H - capH;
    var big = Math.max(14, Math.min(40, Math.floor((sw - 28) / 4.6)));
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    colors.forEach(function (c, i) {
      var x = Math.round(i * sw), x2 = Math.round((i + 1) * sw);
      ctx.fillStyle = c.hex;
      ctx.fillRect(x, 0, x2 - x, sh);
      ctx.fillStyle = c.text;
      ctx.font = '700 ' + big + 'px ' + mono;
      ctx.fillText(c.hex.toUpperCase(), x + 16, sh - 24 - Math.round(big * 1.2));
      ctx.font = '500 ' + Math.round(big * 0.55) + 'px ' + sans;
      ctx.fillText(c.name + ' · ' + pct(c.share), x + 16, sh - 24);
    });
    if (cap) {
      ctx.fillStyle = '#e7e5e4';   // a hairline, so a white swatch still has an edge
      ctx.fillRect(0, sh, W, 1);
      ctx.fillStyle = '#1c1917';
      ctx.font = '600 24px ' + sans;
      ctx.fillText(cap, 16, H - 20);
    }
    return { width: W, height: H };
  }
  function pngName(caption, d) {
    d = d || new Date();
    var p = function (x) { return (x < 10 ? '0' : '') + x; }, s = slug(cleanCaption(caption)).slice(0, 30);
    return 'palette-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + (s ? '-' + s : '') + '.png';
  }

  var api = {
    rgbToOklab: rgbToOklab, oklabToRgb: oklabToRgb, oklabToOklch: oklabToOklch, oklchToOklab: oklchToOklab, deltaE: deltaE,
    rgbToHex: rgbToHex, hexToRgb: hexToRgb, rgbToHsl: rgbToHsl, hslToRgb: hslToRgb,
    fmtHex: fmtHex, fmtRgb: fmtRgb, fmtHsl: fmtHsl, fmtOklch: fmtOklch,
    relLum: relLum, contrast: contrast, textColor: textColor,
    NAMES: NAMES, nameOf: nameOf, rng: rng, kmeans: kmeans,
    extract: extract, describe: describe, MERGE_DE: MERGE_DE, COUNTS: COUNTS,
    pct: pct, cssVars: cssVars, jsonArray: jsonArray, hexList: hexList, cleanCaption: cleanCaption,
    noteBlock: noteBlock, fenceEndAt: fenceEndAt, insertPlan: insertPlan,
    stripSize: stripSize, drawStrip: drawStrip, pngName: pngName
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__cadePaletteCore = api;
})(typeof self !== 'undefined' ? self : this);
