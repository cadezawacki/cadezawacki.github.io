/* Design Calculators — five small CSS / UI calculators in one tabbed panel.
 *
 *  - Units: px <-> rem <-> em <-> pt <-> % against an editable root (rem) and
 *    parent (em, %) font size. Any row accepts a value with its own unit
 *    ("1.5rem" typed into the px row converts from rem).
 *  - Ratio: W x H -> reduced ratio, decimal and the nearest familiar ratio; or a
 *    ratio (preset, "16:9", "1.85", "golden") + one side -> the other side. The
 *    lock decides which: unlocked, editing a side re-measures the ratio; locked,
 *    it solves the other side.
 *  - Type scale: base size x a musical ratio -> xs ... display with a live "Aa"
 *    preview (scaled down proportionally when the biggest wouldn't fit) and the
 *    whole scale as CSS custom properties.
 *  - Contrast: WCAG 2.x ratio of any two CSS colours (translucent colours are
 *    composited first), AA / AAA verdicts for normal and large text and UI
 *    components, a live sample, and the nearest passing colours found by
 *    nudging HSL lightness (hue and saturation kept).
 *  - Fluid type: min/max size x min/max viewport -> a clamp() expression.
 *
 * Every result has copy / insert buttons; the tab and all inputs are
 * remembered. The maths lives in L (exposed as widget._lib so it can be
 * unit-checked in node). Self-contained IIFE, nothing runs until opened. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('designcalc.css');
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'designcalc-panel';
  var PREFS_KEY = 'cade-designcalc-prefs';
  var PHI = (1 + Math.sqrt(5)) / 2;

  // ======================================================================
  // Pure maths
  // ======================================================================
  // Round to d decimals and drop trailing zeros ("1.5000" -> "1.5").
  function fmt(n, d) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    d = d == null ? 4 : d;
    var p = Math.pow(10, d);
    var s = (Math.round(n * p) / p).toFixed(d);
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }
  function num(s) {
    var v = parseFloat(String(s == null ? '' : s).replace(',', '.'));
    return isFinite(v) ? v : NaN;
  }

  // ---- units ----
  var UNITS = ['px', 'rem', 'em', 'pt', '%'];
  // 1pt = 1/72in and 1px = 1/96in in CSS, so 1pt = 4/3 px.
  function toPx(v, u, root, parent) {
    switch (u) {
      case 'rem': return v * root;
      case 'em': return v * parent;
      case 'pt': return v * 4 / 3;
      case '%': return v * parent / 100;
      default: return v;
    }
  }
  function fromPx(px, u, root, parent) {
    switch (u) {
      case 'rem': return px / root;
      case 'em': return px / parent;
      case 'pt': return px * 0.75;
      case '%': return px / parent * 100;
      default: return px;
    }
  }
  // "1.5rem" / "24" / "12 pt" -> {v, u}; a bare number takes dfltUnit.
  function parseLen(s, dfltUnit) {
    var m = /^\s*([+-]?(?:\d+[.,]?\d*|[.,]\d+))\s*(px|rem|em|pt|%)?\s*$/i.exec(String(s || ''));
    if (!m) return null;
    return { v: num(m[1]), u: (m[2] || dfltUnit).toLowerCase() };
  }

  // ---- aspect ratio ----
  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = a % b; a = b; b = t; } return a; }
  // Exact reduction of a W:H pair (decimals up to 4 places are scaled to integers first).
  function reduce(w, h) {
    if (!(w > 0 && h > 0)) return null;
    var k = 1;
    var isInt = function (x) { return Math.abs(x - Math.round(x)) < 1e-6; };
    while (k < 10000 && !(isInt(w * k) && isInt(h * k))) k *= 10;
    var a = Math.round(w * k), b = Math.round(h * k), g = gcd(a, b) || 1;
    return [a / g, b / g];
  }
  // Best small-integer approximation p/q of x with q <= maxDen.
  function approx(x, maxDen) {
    if (!(x > 0)) return null;
    maxDen = maxDen || 32;
    var best = null;
    for (var q = 1; q <= maxDen; q++) {
      var p = Math.max(1, Math.round(x * q));
      var err = Math.abs(x - p / q);
      if (!best || err < best.err - 1e-12) best = { p: p, q: q, err: err };
    }
    return [best.p, best.q];
  }
  var RATIO_PRESETS = [['16:9', 16 / 9], ['4:3', 4 / 3], ['1:1', 1], ['21:9', 21 / 9], ['9:16', 9 / 16], ['3:2', 1.5], ['4:5', 0.8], ['Golden', PHI]];
  function nearestPreset(x, tol) {
    tol = tol == null ? 0.01 : tol;
    var best = null;
    RATIO_PRESETS.forEach(function (p) {
      var d = Math.abs(x / p[1] - 1);
      if (d <= tol && (!best || d < best.d)) best = { name: p[0], d: d, v: p[1] };
    });
    return best;
  }
  // "16:9", "16/9", "16x9", "1.85", "golden" -> W/H as a number (null if not a ratio).
  function parseRatio(s) {
    s = String(s || '').trim().toLowerCase();
    if (!s) return null;
    if (/^(golden|phi|\u03c6)/.test(s)) return PHI;
    var m = /^(\d*[.,]?\d+)\s*(?::|\/|x|\u00d7|by)\s*(\d*[.,]?\d+)$/.exec(s);
    if (m) { var a = num(m[1]), b = num(m[2]); return a > 0 && b > 0 ? a / b : null; }
    m = /^(\d*[.,]?\d+)(?:\s*:\s*1)?$/.exec(s);
    if (m && num(m[1]) > 0) return num(m[1]);
    return null;
  }
  // Human label for a measured W x H: "16:9" when the reduced terms are small, else "1.7786:1".
  function ratioLabel(w, h) {
    var r = reduce(w, h);
    if (r && r[0] <= 100 && r[1] <= 100) return r[0] + ':' + r[1];
    return fmt(w / h, 4) + ':1';
  }
  // Label for a ratio the user typed / picked: keeps their terms ("21:9"
  // stays 21:9, not 7:3); decimals and the golden ratio read as "n:1".
  function ratioName(text, v) {
    if (Math.abs(v - PHI) < 1e-6) return '1.618:1';
    var m = /^(\d*[.,]?\d+)\s*(?::|\/|x|\u00d7|by)\s*(\d*[.,]?\d+)$/.exec(String(text || '').trim().toLowerCase());
    if (m) return fmt(num(m[1]), 4) + ':' + fmt(num(m[2]), 4);
    return fmt(v, 4) + ':1';
  }

  // ---- type scale ----
  var SCALES = [
    ['Minor second', 1.067], ['Major second', 1.125], ['Minor third', 1.2], ['Major third', 1.25],
    ['Perfect fourth', 1.333], ['Augmented fourth', 1.414], ['Perfect fifth', 1.5], ['Minor sixth', 1.6],
    ['Golden ratio', 1.618], ['Major sixth', 1.667], ['Minor seventh', 1.778], ['Major seventh', 1.875], ['Octave', 2],
  ];
  var STEPS = [['display', 6], ['h1', 5], ['h2', 4], ['h3', 3], ['h4', 2], ['h5', 1], ['h6', 0], ['small', -1], ['xs', -2]];
  function typeScale(base, ratio) {
    return STEPS.map(function (s) { return { name: s[0], step: s[1], px: base * Math.pow(ratio, s[1]) }; });
  }
  function sizeStr(px, unit, root) { return unit === 'px' ? fmt(px, 2) + 'px' : fmt(px / root, 4) + 'rem'; }
  function scaleCss(rows, unit, root) {
    var out = ':root {\n';
    rows.forEach(function (r) {
      out += '  --fs-' + r.name + ': ' + sizeStr(r.px, unit, root) + ';' + (unit === 'px' ? '' : ' /* ' + fmt(r.px, 2) + 'px */') + '\n';
      if (r.step === 0) out += '  --fs-body: ' + sizeStr(r.px, unit, root) + ';\n';
    });
    return out + '}';
  }

  // ---- colour / WCAG contrast ----
  function hex2(n) { return ('0' + Math.max(0, Math.min(255, Math.round(n))).toString(16)).slice(-2); }
  function toHex(c) { return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b); }
  function parseHex(s) {
    var m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(s || '').trim());
    if (!m) return null;
    var h = m[1];
    if (h.length <= 4) h = h.replace(/./g, function (c) { return c + c; });
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  // WCAG 2.2 relative luminance (sRGB, 0.04045 knee).
  function chan(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function lum(c) { return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b); }
  function contrast(a, b) {
    var la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  // Composite a (possibly translucent) colour over an opaque one.
  function over(fg, bg) {
    var a = fg.a == null ? 1 : fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  // Thresholds compare the unrounded ratio (4.499 fails AA), so the shown
  // value is floored: it can never read 4.50 while failing.
  function grade(r) { return { aaN: r >= 4.5, aaL: r >= 3, aaaN: r >= 7, aaaL: r >= 4.5, ui: r >= 3 }; }
  function ratioText(r) { return (Math.floor(r * 100 + 1e-9) / 100).toFixed(2) + ':1'; }
  function rgbToHsl(c) {
    var r = c.r / 255, g = c.g / 255, b = c.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return { h: h, s: s, l: l };
  }
  function hslToRgb(h, s, l) {
    var f = function (p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    if (s === 0) { var v = Math.round(l * 255); return { r: v, g: v, b: v, a: 1 }; }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return { r: Math.round(f(p, q, h + 1 / 3) * 255), g: Math.round(f(p, q, h) * 255), b: Math.round(f(p, q, h - 1 / 3) * 255), a: 1 };
  }
  // Nearest colour to `fix` (same hue & saturation, lightness nudged either
  // way) that reaches `target` against `other`. Scans in 0.1% lightness steps
  // on the 8-bit-rounded colour, so the returned hex really passes.
  // Returns {c, r, d} (d = lightness change, 0..1) or null when unreachable.
  function suggest(fix, other, target) {
    if (contrast(fix, other) >= target) return { c: fix, r: contrast(fix, other), d: 0 };
    var hsl = rgbToHsl(fix), best = null;
    [-1, 1].forEach(function (dir) {
      for (var i = 1; i <= 1000; i++) {
        var l = Math.max(0, Math.min(1, hsl.l + dir * i / 1000));
        var c = hslToRgb(hsl.h, hsl.s, l), r = contrast(c, other);
        if (r >= target) { if (!best || i < best.i) best = { c: c, r: r, d: i / 1000, i: i }; break; }
        if (l === 0 || l === 1) break;
      }
    });
    return best;
  }

  // ---- fluid type ----
  // Linear interpolation between (minVw, minPx) and (maxVw, maxPx), clamped:
  //   size = intercept + slope * 100vw  ->  clamp(lo, intercept + (slope*100)vw, hi)
  function fluid(minPx, maxPx, minVw, maxVw, root, unit) {
    if (!(maxVw > minVw) || !(minPx > 0) || !(maxPx > 0) || !(root > 0)) return null;
    var slope = (maxPx - minPx) / (maxVw - minVw);
    var icpt = minPx - slope * minVw;
    var u = function (px) { return sizeStr(px, unit, root); };
    var vwS = fmt(Math.abs(slope) * 100, 4) + 'vw', pref;
    if (Math.abs(slope) < 1e-9) pref = u(icpt);
    else if (Math.abs(icpt) < 1e-9) pref = slope > 0 ? vwS : 'calc(-1 * ' + vwS + ')';
    else if (icpt > 0) pref = u(icpt) + (slope > 0 ? ' + ' : ' - ') + vwS;
    else pref = vwS + ' - ' + u(-icpt);
    var lo = Math.min(minPx, maxPx), hi = Math.max(minPx, maxPx);
    return {
      expr: 'clamp(' + u(lo) + ', ' + pref + ', ' + u(hi) + ')',
      slope: slope, intercept: icpt, lo: lo, hi: hi,
      at: function (vw) { return Math.max(lo, Math.min(hi, icpt + slope * vw)); },
    };
  }

  var L = {
    fmt: fmt, toPx: toPx, fromPx: fromPx, parseLen: parseLen, gcd: gcd, reduce: reduce, approx: approx,
    parseRatio: parseRatio, nearestPreset: nearestPreset, ratioLabel: ratioLabel, ratioName: ratioName, typeScale: typeScale,
    scaleCss: scaleCss, parseHex: parseHex, lum: lum, contrast: contrast, over: over, grade: grade,
    ratioText: ratioText, rgbToHsl: rgbToHsl, hslToRgb: hslToRgb, toHex: toHex, suggest: suggest, fluid: fluid,
  };

  // ======================================================================
  // Panel
  // ======================================================================
  var TABS = [['units', 'Units'], ['ratio', 'Ratio'], ['scale', 'Type scale'], ['contrast', 'Contrast'], ['fluid', 'Fluid']];
  var DEFAULTS = {
    tab: 'units', root: 16, parent: 16, px: 24,
    rw: 1920, rh: 1080, rlock: false, rr: '16:9',
    sb: 16, sr: 1.25, su: 'rem',
    fg: '#57534e', bg: '#ffffff',
    fmin: 16, fmax: 24, fvmin: 320, fvmax: 1280, fu: 'rem', fvw: 768,
  };
  var P = null;          // prefs (live state)
  var ratioVal = 16 / 9; // current ratio (W/H)
  var colorCtx = null;
  var saveTimer = null;

  function loadPrefs() {
    var p = {};
    try { p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {}; } catch (e) { p = {}; }
    P = {};
    for (var k in DEFAULTS) P[k] = p[k] !== undefined && typeof p[k] === typeof DEFAULTS[k] ? p[k] : DEFAULTS[k];
    if (!TABS.some(function (t) { return t[0] === P.tab; })) P.tab = 'units';
    ratioVal = parseRatio(P.rr) || P.rw / P.rh || 16 / 9;
  }
  function savePrefs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { try { Cade.store.set(PREFS_KEY, JSON.stringify(P)); } catch (e) {} }, 300);
  }

  // Any CSS colour -> {r,g,b,a} (sRGB). Hex is parsed directly; everything
  // else (names, rgb(), hsl(), oklch(), color-mix() ...) is painted into a 1x1
  // canvas and read back, which also gamut-maps wide-gamut colours.
  function parseColor(str) {
    str = String(str || '').trim();
    if (!str) return null;
    var h = parseHex(str);
    if (h) return h;
    try {
      if (!colorCtx) {
        var cv = document.createElement('canvas'); cv.width = cv.height = 1;
        colorCtx = cv.getContext('2d', { willReadFrequently: true });
      }
      var ctx = colorCtx;
      ctx.fillStyle = '#010203'; ctx.fillStyle = str; var a1 = ctx.fillStyle;
      ctx.fillStyle = '#040506'; ctx.fillStyle = str; var a2 = ctx.fillStyle;
      if (a1 !== a2) return null; // rejected: fillStyle kept the previous value
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      var d = ctx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    } catch (e) { return null; }
  }

  function panel() { return document.getElementById(PANEL_ID); }
  function q(sel) { var p = panel(); return p ? p.querySelector(sel) : null; }
  function field(k) { return q('[data-k="' + k + '"]'); }

  function copyText(text) {
    var done = function () { Cade.showToast('Copied ' + (text.length > 40 ? text.slice(0, 38) + '…' : text), 'success', 1400); };
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
  function insertText(text) {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode — editing is locked', 'error', 2000); return; }
    ed.dispatch(ed.state.replaceSelection(text), { userEvent: 'input', scrollIntoView: true });
    Cade.showToast('Inserted ' + (text.length > 40 ? text.slice(0, 38) + '…' : text), 'success', 1200);
  }

  var ACTS = '<span class="dz-ra"><button class="dz-ib" data-act="copy" title="Copy" aria-label="Copy">⧉</button>' +
    '<button class="dz-ib" data-act="ins" title="Insert at cursor" aria-label="Insert at cursor">↵</button></span>';
  function resRow(label, value, cls) {
    return '<div class="dz-res' + (cls ? ' ' + cls : '') + '" data-val="' + esc(value) + '">' +
      '<span class="dz-k">' + esc(label) + '</span><code class="dz-v">' + esc(value) + '</code>' + ACTS + '</div>';
  }
  function numIn(k, label, suffix, attrs) {
    return '<label class="dz-f"><span class="dz-fl">' + label + '</span><span class="dz-fi">' +
      '<input class="dz-in" data-k="' + k + '" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"' + (attrs || '') + '>' +
      (suffix ? '<span class="dz-suf">' + suffix + '</span>' : '') + '</span></label>';
  }
  function seg(k, opts) {
    return '<div class="dz-seg" data-seg="' + k + '" role="group">' + opts.map(function (o) {
      return '<button type="button" data-v="' + o[0] + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }

  function bodyHtml() {
    var tabs = TABS.map(function (t) {
      return '<button class="dz-tab" role="tab" data-tab="' + t[0] + '">' + t[1] + '</button>';
    }).join('');
    var unitRows = UNITS.map(function (u) {
      return '<div class="dz-res dz-urow" data-u="' + esc(u) + '"><span class="dz-k">' + u + '</span>' +
        '<input class="dz-in dz-uin" data-unit="' + esc(u) + '" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="' + u + '">' + ACTS + '</div>';
    }).join('');
    var common = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64].map(function (px) {
      return '<button class="dz-chip dz-two" data-px="' + px + '"><b>' + px + '</b><span></span></button>';
    }).join('');
    var presets = RATIO_PRESETS.map(function (p) {
      return '<button class="dz-chip" data-ratio="' + esc(p[0]) + '">' + esc(p[0]) + '</button>';
    }).join('');
    var scaleOpts = SCALES.map(function (s) {
      return '<option value="' + s[1] + '">' + s[0] + ' · ' + s[1] + '</option>';
    }).join('') + '<option value="custom">Custom</option>';
    return '<div class="dz-tabs" role="tablist">' + tabs + '</div>' +
      '<div class="dz-scroll">' +
      // ---- units
      '<section class="dz-pane" data-pane="units">' +
        '<div class="dz-grid2">' + numIn('root', 'Root (rem)', 'px') + numIn('parent', 'Parent (em, %)', 'px') + '</div>' +
        '<div class="dz-list">' + unitRows + '</div>' +
        '<div class="dz-sub">Common sizes <span class="dz-faint">— tap to convert</span></div>' +
        '<div class="dz-chips dz-common">' + common + '</div>' +
      '</section>' +
      // ---- ratio
      '<section class="dz-pane" data-pane="ratio">' +
        '<div class="dz-wh">' + numIn('rw', 'Width', '') + '<span class="dz-x">×</span>' + numIn('rh', 'Height', '') +
          '<button class="dz-lock" data-act="lock" title="Lock the ratio: editing one side solves the other" aria-pressed="false">' +
          '<span class="dz-lock-i"></span></button></div>' +
        '<label class="dz-f"><span class="dz-fl">Ratio</span><span class="dz-fi"><input class="dz-in" data-k="rr" type="text" autocomplete="off" spellcheck="false" placeholder="16:9, 1.85, golden"></span></label>' +
        '<div class="dz-chips">' + presets + '</div>' +
        '<div class="dz-out" data-out="ratio"></div>' +
      '</section>' +
      // ---- type scale
      '<section class="dz-pane" data-pane="scale">' +
        '<div class="dz-grid2">' + numIn('sb', 'Base size', 'px') +
          '<label class="dz-f"><span class="dz-fl">Ratio</span><span class="dz-fi">' +
          '<select class="dz-in dz-sel" data-k="ss">' + scaleOpts + '</select>' +
          '<input class="dz-in dz-rnum" data-k="sr" type="text" inputmode="decimal" autocomplete="off" aria-label="Ratio value"></span></label></div>' +
        '<div class="dz-bar">' + seg('su', [['rem', 'rem'], ['px', 'px']]) + '<span class="dz-note" data-note="scale"></span></div>' +
        '<div class="dz-out" data-out="scale"></div>' +
        '<div class="dz-acts"><button class="dz-btn" data-act="scale-copy">⧉ Copy CSS variables</button>' +
          '<button class="dz-btn primary" data-act="scale-ins">↵ Insert</button></div>' +
      '</section>' +
      // ---- contrast
      '<section class="dz-pane" data-pane="contrast">' +
        '<div class="dz-crow"><span class="dz-fl">Text</span><input class="dz-in" data-k="fg" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Text colour">' +
          '<label class="dz-sw" title="Pick a colour"><input type="color" data-pick="fg" aria-label="Pick text colour"></label></div>' +
        '<div class="dz-crow"><span class="dz-fl">Background</span><input class="dz-in" data-k="bg" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Background colour">' +
          '<label class="dz-sw" title="Pick a colour"><input type="color" data-pick="bg" aria-label="Pick background colour"></label></div>' +
        '<div class="dz-acts"><button class="dz-btn" data-act="swap" title="Swap text and background">⇅ Swap</button></div>' +
        '<div class="dz-out" data-out="contrast"></div>' +
      '</section>' +
      // ---- fluid
      '<section class="dz-pane" data-pane="fluid">' +
        '<div class="dz-grid2">' + numIn('fmin', 'Min size', 'px') + numIn('fmax', 'Max size', 'px') +
          numIn('fvmin', 'Min viewport', 'px') + numIn('fvmax', 'Max viewport', 'px') + '</div>' +
        '<div class="dz-bar">' + seg('fu', [['rem', 'rem'], ['px', 'px']]) +
          '<span class="dz-note">rem uses the root size from Units (<b data-note="froot"></b>)</span></div>' +
        '<div class="dz-out" data-out="fluid"></div>' +
        '<div class="dz-prev">' +
          '<label class="dz-sub">Preview at <b data-note="fvw"></b> wide → <b data-note="fsize"></b></label>' +
          '<input class="dz-range" data-k="fvw" type="range" min="200" max="1920" step="1" aria-label="Viewport width">' +
          '<div class="dz-fsample">Aa The quick brown fox</div>' +
        '</div>' +
      '</section>' +
      '</div>';
  }

  // ---- tab switching ----
  function showTab(t) {
    var p = panel(); if (!p) return;
    P.tab = t;
    p.querySelectorAll('.dz-tab').forEach(function (b) {
      var on = b.getAttribute('data-tab') === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    p.querySelectorAll('.dz-pane').forEach(function (s) { s.hidden = s.getAttribute('data-pane') !== t; });
    var sc = p.querySelector('.dz-scroll'); if (sc) sc.scrollTop = 0;
    savePrefs();
  }

  // ---- units ----
  function renderUnits(fromUnit) {
    var p = panel(); if (!p) return;
    var root = P.root > 0 ? P.root : 16, parent = P.parent > 0 ? P.parent : root;
    p.querySelectorAll('.dz-urow').forEach(function (row) {
      var u = row.getAttribute('data-u');
      var v = fmt(fromPx(P.px, u, root, parent), u === 'px' ? 3 : 4);
      row.setAttribute('data-val', v + u);
      if (u !== fromUnit) row.querySelector('.dz-uin').value = v;
    });
    p.querySelectorAll('.dz-common .dz-chip').forEach(function (b) {
      var px = +b.getAttribute('data-px');
      b.querySelector('span').textContent = fmt(px / root, 4) + 'rem';
      b.classList.toggle('on', Math.abs(px - P.px) < 1e-9);
    });
    var fr = q('[data-note="froot"]'); if (fr) fr.textContent = fmt(root, 2) + 'px';
  }

  // ---- ratio ----
  function renderRatio(from) {
    var p = panel(); if (!p) return;
    var lockBtn = q('.dz-lock');
    lockBtn.classList.toggle('on', !!P.rlock);
    lockBtn.setAttribute('aria-pressed', P.rlock ? 'true' : 'false');
    lockBtn.querySelector('.dz-lock-i').textContent = P.rlock ? '🔒' : '🔓';
    var w = P.rw, h = P.rh, out = q('[data-out="ratio"]');
    if (from !== 'rw') field('rw').value = w > 0 ? fmt(w, 2) : field('rw').value;
    if (from !== 'rh') field('rh').value = h > 0 ? fmt(h, 2) : field('rh').value;
    if (!(w > 0 && h > 0)) { out.innerHTML = '<div class="dz-empty">Enter a width and a height</div>'; return; }
    var r = w / h;
    var red = reduce(w, h);
    var label = P.rlock ? ratioName(P.rr, ratioVal) : ratioLabel(w, h);
    if (from !== 'rr') field('rr').value = P.rlock ? P.rr : label;
    var near = nearestPreset(r, 0.01), ap = approx(r, 32), hint = '';
    if (near && label !== near.name) {
      hint = near.d < 1e-6 ? '= ' + near.name : '≈ ' + near.name + ' (' + (r > near.v ? '+' : '−') + fmt(near.d * 100, 2) + '%)';
    } else if (!near && ap && ap[0] + ':' + ap[1] !== label) hint = '≈ ' + ap[0] + ':' + ap[1];
    p.querySelectorAll('[data-ratio]').forEach(function (b) {
      var pr = RATIO_PRESETS.filter(function (x) { return x[0] === b.getAttribute('data-ratio'); })[0];
      b.classList.toggle('on', !!pr && Math.abs(pr[1] / r - 1) < 1e-6);
    });
    var cssR = red && red[0] <= 1000 && red[1] <= 1000 ? red[0] + ' / ' + red[1] : fmt(r, 4);
    out.innerHTML =
      resRow('Ratio', label, 'main') +
      (hint ? '<div class="dz-hint">' + esc(hint) + (red && label !== red[0] + ':' + red[1] && red[0] <= 100000 ? ' · exact ' + red[0] + ':' + red[1] : '') + '</div>' : '') +
      resRow('Decimal', fmt(r, 4)) +
      resRow('Size', fmt(w, 2) + ' × ' + fmt(h, 2)) +
      resRow('CSS', 'aspect-ratio: ' + cssR + ';') +
      resRow('Padding hack', 'padding-top: ' + fmt(h / w * 100, 4) + '%;');
  }
  function setRatio(v, text) {
    ratioVal = v;
    P.rr = text;
    P.rlock = true;
    if (P.rw > 0) P.rh = P.rw / v;
    else if (P.rh > 0) P.rw = P.rh * v;
    savePrefs();
  }

  // ---- type scale ----
  function renderScale() {
    var p = panel(); if (!p) return;
    var out = q('[data-out="scale"]'), note = q('[data-note="scale"]');
    var base = P.sb, r = P.sr, root = P.root > 0 ? P.root : 16;
    p.querySelectorAll('[data-seg="su"] button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === P.su); });
    if (!(base > 0 && r > 0)) { out.innerHTML = '<div class="dz-empty">Enter a base size and a ratio</div>'; note.textContent = ''; return; }
    var rows = typeScale(base, r);
    // Previews keep their proportions: scale everything down so the biggest
    // "Aa" fits the panel instead of clipping it.
    var maxPx = Math.max(rows[0].px, rows[rows.length - 1].px);
    var k = Math.min(1, 72 / maxPx);
    note.textContent = k < 1 ? 'Previews at ' + Math.round(k * 100) + '%' : 'Previews at actual size';
    var html = '<div class="dz-scale">';
    rows.forEach(function (row) {
      var v = sizeStr(row.px, P.su, root);
      html += '<div class="dz-res dz-srow' + (row.step === 0 ? ' base' : '') + '" data-val="' + esc(v) + '">' +
        '<span class="dz-k">' + (row.step === 0 ? 'h6 · body' : row.name) + '</span>' +
        '<span class="dz-aa" style="font-size:' + (row.px * k).toFixed(2) + 'px">Aa</span>' +
        '<code class="dz-v">' + esc(v) + (P.su === 'px' ? '' : '<small>' + fmt(row.px, 1) + 'px</small>') + '</code>' + ACTS + '</div>';
    });
    out.innerHTML = html + '</div>';
  }
  function scaleCssText() { return scaleCss(typeScale(P.sb, P.sr), P.su, P.root > 0 ? P.root : 16); }
  function syncScaleSelect() {
    var sel = field('ss'), hit = 'custom';
    SCALES.forEach(function (s) { if (Math.abs(s[1] - P.sr) < 1e-9) hit = String(s[1]); });
    sel.value = hit;
  }

  // ---- contrast ----
  function renderContrast(from) {
    var p = panel(); if (!p) return;
    var out = q('[data-out="contrast"]');
    var fgIn = field('fg'), bgIn = field('bg');
    if (from !== 'fg') fgIn.value = P.fg;
    if (from !== 'bg') bgIn.value = P.bg;
    var fg0 = parseColor(P.fg), bg0 = parseColor(P.bg);
    fgIn.classList.toggle('bad', !fg0);
    bgIn.classList.toggle('bad', !bg0);
    if (fg0) p.querySelector('[data-pick="fg"]').value = toHex(fg0);
    if (bg0) p.querySelector('[data-pick="bg"]').value = toHex(bg0);
    if (fg0) p.querySelector('[data-pick="fg"]').parentNode.style.background = toHex(fg0);
    if (bg0) p.querySelector('[data-pick="bg"]').parentNode.style.background = toHex(bg0);
    if (!fg0 || !bg0) { out.innerHTML = '<div class="dz-empty">Enter two CSS colours — #hex, rgb(), hsl(), names…</div>'; return; }
    // A translucent background sits on white; a translucent text colour on that.
    var bg = over(bg0, { r: 255, g: 255, b: 255 }), fg = over(fg0, bg);
    var r = contrast(fg, bg), g = grade(r), rt = ratioText(r);
    var pill = function (ok, label, need) {
      return '<span class="dz-pill ' + (ok ? 'ok' : 'no') + '" title="Needs ' + need + ':1">' + (ok ? '✓ ' : '✗ ') + label + '</span>';
    };
    var sw = 'background:' + toHex(bg) + ';color:' + toHex(fg) + ';border-color:' + toHex(fg);
    var fix = function (which, target) {
      var s = which === 'fg' ? suggest(fg, bg, target) : suggest(bg, fg, target);
      if (!s) return '<span class="dz-sug none">not reachable</span>';
      var hx = toHex(s.c);
      if (s.d === 0) return '<span class="dz-sug none">✓ passes</span>';
      return '<button class="dz-sug" data-apply="' + which + '" data-hex="' + hx + '" title="Use ' + hx + ' (' + ratioText(s.r) + ')">' +
        '<i style="background:' + hx + '"></i>' + hx + '<small>' + ratioText(s.r) + '</small></button>' +
        '<button class="dz-ib" data-copyhex="' + hx + '" title="Copy ' + hx + '" aria-label="Copy ' + hx + '">⧉</button>';
    };
    var summary = toHex(fg) + ' on ' + toHex(bg) + ' — ' + rt + ' · AA ' + (g.aaN ? 'pass' : 'fail') +
      ' (large ' + (g.aaL ? 'pass' : 'fail') + ') · AAA ' + (g.aaaN ? 'pass' : 'fail') + ' (large ' + (g.aaaL ? 'pass' : 'fail') + ') · UI ' + (g.ui ? 'pass' : 'fail');
    out.innerHTML =
      '<div class="dz-ratio"><b>' + rt + '</b><span>' + (g.aaaN ? 'Excellent' : g.aaN ? 'Good' : g.aaL ? 'Large text only' : 'Poor') + '</span></div>' +
      '<div class="dz-verdicts">' +
        '<div><span class="dz-vk">Normal text</span>' + pill(g.aaN, 'AA', '4.5') + pill(g.aaaN, 'AAA', '7') + '</div>' +
        '<div><span class="dz-vk">Large text <small>≥ 24px / 18.66px bold</small></span>' + pill(g.aaL, 'AA', '3') + pill(g.aaaL, 'AAA', '4.5') + '</div>' +
        '<div><span class="dz-vk">UI components &amp; graphics</span>' + pill(g.ui, 'AA', '3') + '</div>' +
      '</div>' +
      '<div class="dz-sample" style="' + sw + '">' +
        '<div class="dz-s1">Normal text — the quick brown fox jumps over the lazy dog.</div>' +
        '<div class="dz-s2">Large text 24px</div>' +
        '<div class="dz-s3"><span class="dz-sbtn" style="border-color:' + toHex(fg) + '">Button</span><span class="dz-sicon" style="background:' + toHex(fg) + '"></span><span class="dz-sicon ring" style="border-color:' + toHex(fg) + '"></span></div>' +
      '</div>' +
      resRow('Ratio', rt) +
      resRow('Summary', summary) +
      '<div class="dz-sub">Nearest passing colours</div>' +
      '<div class="dz-fix"><span class="dz-vk">Text AA</span>' + fix('fg', 4.5) + '</div>' +
      '<div class="dz-fix"><span class="dz-vk">Text AAA</span>' + fix('fg', 7) + '</div>' +
      '<div class="dz-fix"><span class="dz-vk">Background AA</span>' + fix('bg', 4.5) + '</div>' +
      '<div class="dz-fix"><span class="dz-vk">Background AAA</span>' + fix('bg', 7) + '</div>';
  }

  // ---- fluid ----
  function renderFluid() {
    var p = panel(); if (!p) return;
    var out = q('[data-out="fluid"]'), root = P.root > 0 ? P.root : 16;
    p.querySelectorAll('[data-seg="fu"] button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === P.fu); });
    var f = fluid(P.fmin, P.fmax, P.fvmin, P.fvmax, root, P.fu);
    var rng = field('fvw');
    var lo = Math.max(100, Math.round(Math.min(P.fvmin, P.fvmax) * 0.6)), hi = Math.round(Math.max(P.fvmin, P.fvmax, 400) * 1.3);
    rng.min = lo; rng.max = hi;
    if (!(P.fvw >= lo && P.fvw <= hi)) P.fvw = Math.round((P.fvmin + P.fvmax) / 2) || lo;
    rng.value = P.fvw;
    if (!f) {
      out.innerHTML = '<div class="dz-empty">Sizes must be positive and the max viewport wider than the min</div>';
      q('[data-note="fvw"]').textContent = ''; q('[data-note="fsize"]').textContent = '';
      return;
    }
    out.innerHTML =
      resRow('clamp()', f.expr, 'main') +
      resRow('CSS', 'font-size: ' + f.expr + ';') +
      '<div class="dz-hint">' + fmt(f.lo, 2) + 'px below ' + fmt(P.fvmin, 0) + 'px wide · ' + fmt(f.hi, 2) + 'px above ' + fmt(P.fvmax, 0) +
        'px · slope ' + fmt(f.slope * 100, 4) + 'vw' + '</div>';
    updateFluidPreview(f);
  }
  function updateFluidPreview(f) {
    f = f || fluid(P.fmin, P.fmax, P.fvmin, P.fvmax, P.root > 0 ? P.root : 16, P.fu);
    if (!f) return;
    var size = f.at(P.fvw);
    q('[data-note="fvw"]').textContent = P.fvw + 'px';
    q('[data-note="fsize"]').textContent = fmt(size, 2) + 'px';
    q('.dz-fsample').style.fontSize = size + 'px';
  }

  function renderAll() {
    renderUnits(); renderRatio(); syncScaleSelect(); field('sb').value = fmt(P.sb, 3); field('sr').value = fmt(P.sr, 4);
    renderScale(); renderContrast(); renderFluid();
    field('root').value = fmt(P.root, 3); field('parent').value = fmt(P.parent, 3);
    ['fmin', 'fmax', 'fvmin', 'fvmax'].forEach(function (k) { field(k).value = fmt(P[k], 3); });
  }

  // ---- input handling ----
  function onInput(e) {
    var t = e.target;
    var k = t.getAttribute('data-k'), v;
    if (t.classList.contains('dz-uin')) {
      var u = t.getAttribute('data-unit'), pl = parseLen(t.value, u);
      t.classList.toggle('bad', !pl && !!t.value.trim());
      if (!pl) return;
      P.px = toPx(pl.v, pl.u, P.root > 0 ? P.root : 16, P.parent > 0 ? P.parent : P.root);
      renderUnits(u); // the field being typed keeps its text ("2rem" in the px row) until it loses focus
      savePrefs();
      return;
    }
    var pick = t.getAttribute('data-pick');
    if (pick) { P[pick] = t.value; renderContrast(); savePrefs(); return; }
    if (!k) return;
    switch (k) {
      case 'root': case 'parent':
        v = num(t.value); t.classList.toggle('bad', !(v > 0));
        if (!(v > 0)) return;
        P[k] = v; renderUnits(); renderScale(); renderFluid(); break;
      case 'rw': case 'rh':
        v = num(t.value); t.classList.toggle('bad', !(v > 0) && !!t.value.trim());
        if (!(v > 0)) return;
        P[k] = v;
        if (P.rlock) { if (k === 'rw') P.rh = v / ratioVal; else P.rw = v * ratioVal; }
        else ratioVal = P.rw / P.rh;
        renderRatio(k); break;
      case 'rr':
        v = parseRatio(t.value); t.classList.toggle('bad', !v && !!t.value.trim());
        if (!v) return;
        setRatio(v, t.value.trim()); renderRatio('rr'); break;
      case 'sb':
        v = num(t.value); t.classList.toggle('bad', !(v > 0));
        if (!(v > 0)) return;
        P.sb = v; renderScale(); break;
      case 'ss':
        if (t.value !== 'custom') { P.sr = +t.value; field('sr').value = fmt(P.sr, 4); renderScale(); }
        else field('sr').focus();
        break;
      case 'sr':
        v = num(t.value); t.classList.toggle('bad', !(v > 0));
        if (!(v > 0)) return;
        P.sr = v; syncScaleSelect(); renderScale(); break;
      case 'fg': case 'bg':
        if (!parseColor(t.value)) { t.classList.toggle('bad', !!t.value.trim()); return; }
        P[k] = t.value.trim(); renderContrast(k); break;
      case 'fmin': case 'fmax': case 'fvmin': case 'fvmax':
        v = num(t.value); t.classList.toggle('bad', !(v > 0));
        if (!(v > 0)) return;
        P[k] = v; renderFluid(); break;
      case 'fvw':
        P.fvw = +t.value; updateFluidPreview(); break;
      default: return;
    }
    savePrefs();
  }

  function onClick(e) {
    var t = e.target.closest ? e.target : null;
    if (!t) return;
    var b;
    if ((b = t.closest('.dz-tab'))) { showTab(b.getAttribute('data-tab')); return; }
    if ((b = t.closest('.dz-ib[data-act], .dz-ib[data-copyhex]'))) {
      if (b.hasAttribute('data-copyhex')) { copyText(b.getAttribute('data-copyhex')); return; }
      var row = b.closest('[data-val]');
      if (!row) return;
      var val = row.getAttribute('data-val');
      if (b.getAttribute('data-act') === 'copy') copyText(val); else insertText(val);
      return;
    }
    if ((b = t.closest('[data-px]'))) { P.px = +b.getAttribute('data-px'); renderUnits(); savePrefs(); return; }
    if ((b = t.closest('[data-ratio]'))) {
      var name = b.getAttribute('data-ratio');
      var pr = RATIO_PRESETS.filter(function (x) { return x[0] === name; })[0];
      if (pr) { setRatio(pr[1], name === 'Golden' ? 'golden' : name); renderRatio(); }
      return;
    }
    if ((b = t.closest('[data-seg] button'))) {
      var k = b.parentNode.getAttribute('data-seg');
      P[k] = b.getAttribute('data-v');
      if (k === 'su') renderScale(); else renderFluid();
      savePrefs();
      return;
    }
    if ((b = t.closest('[data-apply]'))) {
      P[b.getAttribute('data-apply')] = b.getAttribute('data-hex');
      renderContrast(); savePrefs();
      return;
    }
    if ((b = t.closest('[data-act]'))) {
      var act = b.getAttribute('data-act');
      if (act === 'lock') {
        P.rlock = !P.rlock;
        if (P.rlock && P.rw > 0 && P.rh > 0) { ratioVal = P.rw / P.rh; P.rr = ratioLabel(P.rw, P.rh); }
        renderRatio(); savePrefs();
      } else if (act === 'swap') {
        var tmp = P.fg; P.fg = P.bg; P.bg = tmp; renderContrast(); savePrefs();
      } else if (act === 'scale-copy') copyText(scaleCssText());
      else if (act === 'scale-ins') insertText(scaleCssText());
    }
  }

  // Seed from a short selection: "24px" -> Units, "1920x1080" -> Ratio, a colour -> Contrast.
  function seedFromSelection() {
    try {
      var ed = Cade.editor, sel = ed.state.selection.main;
      if (sel.empty || sel.to - sel.from > 48) return;
      var s = ed.state.sliceDoc(sel.from, sel.to).trim();
      if (!s || s.indexOf('\n') !== -1) return;
      var pl = /[a-z%]$/i.test(s) ? parseLen(s, 'px') : null;
      if (pl && pl.v > 0) { P.px = toPx(pl.v, pl.u, P.root, P.parent); P.tab = 'units'; return; }
      var m = /^(\d*\.?\d+)\s*(?:x|\u00d7|by)\s*(\d*\.?\d+)$/i.exec(s);
      if (m && +m[1] > 0 && +m[2] > 0) { P.rw = +m[1]; P.rh = +m[2]; P.rlock = false; ratioVal = P.rw / P.rh; P.tab = 'ratio'; return; }
      if (/^(#|rgb|hsl|hwb|lab|lch|oklab|oklch|color)/i.test(s) && parseColor(s)) { P.fg = s; P.tab = 'contrast'; }
    } catch (e) {}
  }

  function close() {
    var p = panel();
    if (!p) return;
    p.remove();
    if (p._onClose) p._onClose();
  }

  function open() {
    Cade.closeAllMenus();
    if (panel()) { close(); return; }
    loadPrefs();
    seedFromSelection();
    var p = Cade.mkPanel(PANEL_ID, '📐 Design Calculators', bodyHtml());
    p.addEventListener('input', onInput);
    p.addEventListener('change', function (e) { if (e.target.tagName === 'SELECT') onInput(e); });
    p.addEventListener('click', onClick);
    p.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      // Enter in a field tidies it (re-render from state) instead of submitting anything.
      if (e.key === 'Enter' && e.target.classList.contains('dz-in')) { e.preventDefault(); e.target.blur(); }
      e.stopPropagation(); // keep editor / global shortcuts out of the panel's fields
    });
    // Leaving a field snaps it back to its tidy, normalised value.
    p.addEventListener('focusout', function (e) {
      var t = e.target;
      if (!t.classList || !t.classList.contains('dz-in') || t.tagName === 'SELECT') return;
      t.classList.remove('bad');
      var k = t.getAttribute('data-k');
      if (t.classList.contains('dz-uin')) renderUnits();
      else if (k === 'rw' || k === 'rh' || k === 'rr') renderRatio();
      else if (k === 'fg' || k === 'bg') { if (!parseColor(t.value)) renderContrast(); } // back to the last valid colour
      else if (k && typeof P[k] === 'number') t.value = fmt(P[k], k === 'sr' ? 4 : 3);
    });
    p._onClose = function () {
      clearTimeout(saveTimer);
      try { Cade.store.set(PREFS_KEY, JSON.stringify(P)); } catch (e) {}
    };
    renderAll();
    showTab(P.tab);
  }

  Cade.registerWidget({
    name: 'Design Calculators',
    description: 'px ↔ rem, aspect ratio, type scale, WCAG contrast checker, fluid clamp() — copy or insert',
    icon: '📐',
    tags: 'design,css,px,rem,em,pt,unit,convert,aspect,ratio,16:9,type scale,modular scale,typography,contrast,wcag,accessibility,a11y,color,clamp,fluid,responsive',
    open: open,
    _lib: L,
  });
})();
