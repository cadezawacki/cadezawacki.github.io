/* Weather — current conditions, 48-hour strip, 10-day outlook and detail
 * tiles for a saved place, from Open-Meteo (free, no key, CORS).
 *
 * DATA: forecast + air-quality are POSTed (form body) — the app's service
 * worker only intercepts GETs, so live data is never served stale from, or
 * stored in, Cache Storage. Everything is requested in metric and converted
 * locally, so toggling units never refetches. The last reply per place is
 * kept (trimmed, columnar, ~5 KB, newest 4 places) in Cade.store for offline
 * use, shown with a "stale" badge when it couldn't be refreshed.
 *
 * LOCATION: shared with Sun & Moon through geo.js (Cade.store
 * 'cade-geo-location'); geolocation is only requested on a button press.
 *
 * VISUALS: hand-drawn inline SVG glyphs (sun rays turn, clouds drift, rain
 * and snow fall, lightning flashes, fog bands slide; all CSS animations that
 * stop under prefers-reduced-motion), a hero card tinted by condition and
 * time of day, a monotone-spline temperature line with precipitation bars,
 * iOS-style range bars on a shared scale, and drawn detail tiles.
 *
 * Self-contained IIFE; nothing runs until the widget is opened. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('weather.css');
  Cade.loadCSS('geo.css');
  var GEO_URL = Cade.asset('geo.js'); // resolve now, while currentScript is us
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'weather-panel';
  var PREFS_KEY = 'cade-weather-prefs';
  var CACHE_KEY = 'cade-weather-cache';
  var MAX_CACHE = 4;
  var FRESH_MS = 15 * 60000;      // reuse a reply this young on open
  var AUTO_MS = 30 * 60000;       // refresh while open once older than this
  var STALE_MS = 2 * 3600000;     // badge cached data older than this
  var FORECAST = 'https://api.open-meteo.com/v1/forecast';
  var AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
  var RAD = Math.PI / 180;
  var HOUR = 3600000;

  // ---- WMO weather codes -------------------------------------------------------
  // [label, glyph kind, emoji]
  var WMO = {
    0: ['Clear', 'clear', '☀️'],
    1: ['Mostly clear', 'mostly', '🌤️'],
    2: ['Partly cloudy', 'partly', '⛅'],
    3: ['Overcast', 'cloudy', '☁️'],
    45: ['Fog', 'fog', '🌫️'],
    48: ['Freezing fog', 'fog', '🌫️'],
    51: ['Light drizzle', 'drizzle', '🌦️'],
    53: ['Drizzle', 'drizzle', '🌦️'],
    55: ['Heavy drizzle', 'drizzle', '🌧️'],
    56: ['Freezing drizzle', 'sleet', '🌧️'],
    57: ['Heavy freezing drizzle', 'sleet', '🌧️'],
    61: ['Light rain', 'rain', '🌧️'],
    63: ['Rain', 'rain', '🌧️'],
    65: ['Heavy rain', 'heavy-rain', '🌧️'],
    66: ['Freezing rain', 'sleet', '🌧️'],
    67: ['Heavy freezing rain', 'sleet', '🌧️'],
    71: ['Light snow', 'snow', '🌨️'],
    73: ['Snow', 'snow', '🌨️'],
    75: ['Heavy snow', 'heavy-snow', '❄️'],
    77: ['Snow grains', 'snow', '🌨️'],
    80: ['Light showers', 'showers', '🌦️'],
    81: ['Showers', 'showers', '🌦️'],
    82: ['Violent showers', 'heavy-rain', '🌧️'],
    85: ['Snow showers', 'snow-showers', '🌨️'],
    86: ['Heavy snow showers', 'heavy-snow', '❄️'],
    95: ['Thunderstorm', 'thunder', '⛈️'],
    96: ['Thunderstorm with hail', 'hail', '⛈️'],
    99: ['Severe thunderstorm with hail', 'hail', '⛈️'],
  };
  function wmo(code, isDay) {
    var w = WMO[code];
    if (!w) {
      // Unknown future code: fall back to its decade's family.
      var c = Math.floor((+code || 0) / 10) * 10;
      w = WMO[c] || WMO[c + 1] || WMO[c + 3] || ['Unknown', 'cloudy', '🌡️'];
    }
    var emoji = w[2];
    if (isDay === false || isDay === 0) {
      if (w[1] === 'clear' || w[1] === 'mostly') emoji = '🌙';
      else if (w[1] === 'partly') emoji = '☁️';
    }
    return { label: w[0], kind: w[1], emoji: emoji };
  }
  var PRECIP_KINDS = { drizzle: 1, rain: 1, 'heavy-rain': 1, showers: 1, sleet: 1, snow: 1, 'heavy-snow': 1, 'snow-showers': 1, thunder: 1, hail: 1 };
  function precipWord(kind) {
    if (/snow/.test(kind)) return 'Snow';
    if (kind === 'thunder' || kind === 'hail') return 'Storms';
    if (kind === 'sleet') return 'Sleet';
    if (kind === 'drizzle') return 'Drizzle';
    return 'Rain';
  }

  // ---- units ---------------------------------------------------------------------
  var prefs = null;
  function defaultPrefs() {
    var langs = [].concat(navigator.languages || [], navigator.language || 'en-US');
    var region = '';
    for (var i = 0; i < langs.length && !region; i++) {
      var m = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/.exec(langs[i] || '');
      if (m) region = m[1].toUpperCase();
    }
    var imperial = ['US', 'LR', 'MM', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH'].indexOf(region) !== -1;
    var europe = /^(AT|BE|BG|CH|CY|CZ|DE|DK|EE|ES|FI|FR|GB|GR|HR|HU|IE|IS|IT|LI|LT|LU|LV|MT|NL|NO|PL|PT|RO|SE|SI|SK)$/.test(region);
    if (imperial) return { temp: 'F', wind: 'mph', precip: 'in', aqi: 'us' };
    if (region === 'GB') return { temp: 'C', wind: 'mph', precip: 'mm', aqi: 'eu' };
    return { temp: 'C', wind: 'kmh', precip: 'mm', aqi: europe ? 'eu' : 'us' };
  }
  function readJSON(k, d) {
    try { var v = JSON.parse(Cade.store.get(k) || 'null'); return v == null ? d : v; } catch (e) { return d; }
  }
  function writeJSON(k, v) { try { Cade.store.set(k, JSON.stringify(v)); } catch (e) {} }
  function loadPrefs() {
    var d = defaultPrefs(), p = readJSON(PREFS_KEY, {}) || {};
    prefs = {
      temp: p.temp === 'F' || p.temp === 'C' ? p.temp : d.temp,
      wind: /^(kmh|mph|ms|kn)$/.test(p.wind) ? p.wind : d.wind,
      precip: p.precip === 'in' || p.precip === 'mm' ? p.precip : d.precip,
      aqi: p.aqi === 'eu' || p.aqi === 'us' ? p.aqi : d.aqi,
    };
  }
  function savePrefs() { writeJSON(PREFS_KEY, prefs); }

  function tC(c) { return prefs.temp === 'F' ? c * 9 / 5 + 32 : c; }
  function tStr(c) { return c == null || isNaN(c) ? '–' : Math.round(tC(c)) + '°'; }
  function tUnit() { return '°' + prefs.temp; }
  var WIND_U = { kmh: ['km/h', 1], mph: ['mph', 1 / 1.609344], ms: ['m/s', 1 / 3.6], kn: ['kn', 1 / 1.852] };
  function wV(kmh) { return kmh * WIND_U[prefs.wind][1]; }
  function wStr(kmh) { return kmh == null ? '–' : Math.round(wV(kmh)) + ' ' + WIND_U[prefs.wind][0]; }
  function pStr(mm) {
    if (mm == null) return '–';
    if (prefs.precip === 'in') { var i = mm / 25.4; return (i < 0.1 && i > 0 ? i.toFixed(2) : i.toFixed(1)) + ' in'; }
    return (mm < 10 ? mm.toFixed(1) : Math.round(mm)) + ' mm';
  }
  function milesFirst() { return prefs.wind === 'mph' || prefs.precip === 'in'; }
  function pressStr(hpa) {
    if (hpa == null) return '–';
    return prefs.precip === 'in' ? (hpa * 0.0295300).toFixed(2) + ' inHg' : Math.round(hpa) + ' hPa';
  }
  function visStr(m) {
    if (m == null) return '–';
    if (milesFirst()) { var mi = m / 1609.344; return (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi'; }
    var km = m / 1000; return (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km';
  }
  var DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function dirName(deg) { return deg == null ? '' : DIRS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]; }
  var BEAUFORT = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  var BEAUFORT_N = ['Calm', 'Light air', 'Light breeze', 'Gentle breeze', 'Moderate breeze', 'Fresh breeze', 'Strong breeze',
    'Near gale', 'Gale', 'Strong gale', 'Storm', 'Violent storm', 'Hurricane force'];
  function beaufort(kmh) { var i = 0; while (i < BEAUFORT.length && kmh >= BEAUFORT[i]) i++; return BEAUFORT_N[i]; }

  // Temperature → colour (°C stops), for range bars and the hourly line.
  var TSTOPS = [[-25, [124, 108, 240]], [-10, [91, 141, 239]], [0, [56, 189, 248]], [8, [45, 212, 191]],
    [15, [163, 230, 53]], [21, [250, 204, 21]], [27, [251, 146, 60]], [33, [248, 113, 113]], [40, [225, 29, 72]]];
  function tempColor(c) {
    if (c <= TSTOPS[0][0]) return 'rgb(' + TSTOPS[0][1].join(',') + ')';
    for (var i = 1; i < TSTOPS.length; i++) {
      if (c <= TSTOPS[i][0]) {
        var a = TSTOPS[i - 1], b = TSTOPS[i], f = (c - a[0]) / (b[0] - a[0]);
        return 'rgb(' + [0, 1, 2].map(function (k) { return Math.round(a[1][k] + (b[1][k] - a[1][k]) * f); }).join(',') + ')';
      }
    }
    return 'rgb(' + TSTOPS[TSTOPS.length - 1][1].join(',') + ')';
  }

  var UV_LV = [[3, 'Low', '#3ea72d'], [6, 'Moderate', '#e2b007'], [8, 'High', '#f18b00'], [11, 'Very high', '#e53210'], [99, 'Extreme', '#b567a4']];
  function uvLevel(v) { for (var i = 0; i < UV_LV.length; i++) if (v < UV_LV[i][0]) return UV_LV[i]; return UV_LV[UV_LV.length - 1]; }
  var AQI_US = [[51, 'Good', '#22c55e'], [101, 'Moderate', '#eab308'], [151, 'Unhealthy for sensitive groups', '#f97316'],
    [201, 'Unhealthy', '#ef4444'], [301, 'Very unhealthy', '#a855f7'], [9999, 'Hazardous', '#9f1239']];
  var AQI_EU = [[20, 'Good', '#14b8a6'], [40, 'Fair', '#22c55e'], [60, 'Moderate', '#eab308'], [80, 'Poor', '#f97316'],
    [100, 'Very poor', '#ef4444'], [9999, 'Extremely poor', '#a855f7']];
  function aqiLevel(v, eu) { var t = eu ? AQI_EU : AQI_US; for (var i = 0; i < t.length; i++) if (v < t[i][0]) return t[i]; return t[t.length - 1]; }

  // ---- time formatting in the place's zone ---------------------------------------
  var fmtCache = {};
  function fmt(ms, tz, key, o) {
    var k = (tz || '') + '|' + key, f = fmtCache[k];
    if (!f) {
      try { f = new Intl.DateTimeFormat(undefined, Object.assign({ timeZone: tz || undefined }, o)); }
      catch (e) { f = new Intl.DateTimeFormat(undefined, o); }
      fmtCache[k] = f;
    }
    return f.format(new Date(ms));
  }
  function hm(ms, tz) { return fmt(ms, tz, 'hm', { hour: 'numeric', minute: '2-digit' }); }
  function hr(ms, tz) { return fmt(ms, tz, 'h', { hour: 'numeric' }); }
  function dur(ms) {
    var m = Math.round(Math.abs(ms) / 60000), h = Math.floor(m / 60);
    return h ? h + 'h ' + (m % 60) + 'm' : m + 'm';
  }
  function ago(ms) {
    var s = Math.max(0, Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400 * 2) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
  }

  // ---- glyphs ------------------------------------------------------------------------
  // One geometry, two renderings: the hero glyph (gradients + CSS animation
  // classes, colours tuned for the tinted card) and flat mini symbols for the
  // strip/list (theme-variable fills, a halo so clouds read over the sun).
  // 128×128 viewBox throughout.
  function f1(n) { return Math.round(n * 10) / 10; }
  var CLOUD = [['c', 46, 70, 17], ['c', 70, 58, 23], ['c', 92, 72, 15], ['r', 30, 70, 76, 20, 10]];
  function cloudShapes(cls, extra) {
    return CLOUD.map(function (s) {
      return s[0] === 'c'
        ? '<circle class="' + cls + '" cx="' + s[1] + '" cy="' + s[2] + '" r="' + s[3] + '"' + (extra || '') + '/>'
        : '<rect class="' + cls + '" x="' + s[1] + '" y="' + s[2] + '" width="' + s[3] + '" height="' + s[4] + '" rx="' + s[5] + '"' + (extra || '') + '/>';
    }).join('');
  }
  // tone: light | back | gray | dark
  function cloud(tf, tone, mini, cls) {
    var g = '<g transform="' + tf + '"' + (cls ? ' class="' + cls + '"' : '') + '>';
    if (mini) {
      g += cloudShapes('wxm-halo') + cloudShapes('wxm-cl wxm-cl-' + tone);
    } else {
      g += '<g transform="translate(0 3)" opacity="0.18">' + cloudShapes('wx-cshadow') + '</g>' +
        cloudShapes('wx-cl', ' fill="url(#wx-gc-' + tone + ')"');
    }
    return g + '</g>';
  }
  function sun(cx, cy, r, mini) {
    var r1 = r * 1.38, r2 = r * 1.86, rays = '';
    for (var i = 0; i < 8; i++) {
      var a = i * 45 * RAD;
      rays += '<line x1="' + f1(cx + Math.cos(a) * r1) + '" y1="' + f1(cy + Math.sin(a) * r1) +
        '" x2="' + f1(cx + Math.cos(a) * r2) + '" y2="' + f1(cy + Math.sin(a) * r2) + '"/>';
    }
    if (mini) {
      return '<g class="wxm-sun"><g class="wxm-rays" stroke-width="' + f1(r * 0.34) + '" stroke-linecap="round">' + rays + '</g>' +
        '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '"/></g>';
    }
    return '<g class="wx-sun">' +
      '<circle class="wx-glow" cx="' + cx + '" cy="' + cy + '" r="' + f1(r * 2.1) + '" fill="url(#wx-gglow)"/>' +
      '<g class="wx-rays" stroke-width="' + f1(r * 0.24) + '" stroke-linecap="round">' + rays + '</g>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="url(#wx-gsun)"/></g>';
  }
  // Crescent = disc minus an offset disc; boundary arcs computed from the
  // circles' intersection (outer arc the long way round, inner arc back).
  function crescentPath(cx, cy, R, ox, oy, r2) {
    var d = Math.sqrt(ox * ox + oy * oy), th = Math.atan2(oy, ox);
    var al = Math.acos((R * R + d * d - r2 * r2) / (2 * R * d));
    var p1x = cx + R * Math.cos(th + al), p1y = cy + R * Math.sin(th + al);
    var p2x = cx + R * Math.cos(th - al), p2y = cy + R * Math.sin(th - al);
    var large = 2 * Math.PI - 2 * al > Math.PI ? 1 : 0;
    // Inner arc: along the cut circle from p2 back to p1, through the side
    // that faces the moon's centre (angles grow clockwise in SVG's y-down).
    var qx = cx + ox, qy = cy + oy, TAU = 2 * Math.PI;
    var a1 = Math.atan2(p1y - qy, p1x - qx), a2 = Math.atan2(p2y - qy, p2x - qx), ac = Math.atan2(-oy, -ox);
    var inc = function (from, to) { var x = (to - from) % TAU; return x < 0 ? x + TAU : x; };
    var spanCw = inc(a2, a1), viaCentre = inc(a2, ac) < spanCw;
    var span = viaCentre ? spanCw : TAU - spanCw;
    return 'M' + f1(p1x) + ' ' + f1(p1y) + 'A' + f1(R) + ' ' + f1(R) + ' 0 ' + large + ' 1 ' + f1(p2x) + ' ' + f1(p2y) +
      'A' + f1(r2) + ' ' + f1(r2) + ' 0 ' + (span > Math.PI ? 1 : 0) + ' ' + (viaCentre ? 1 : 0) + ' ' + f1(p1x) + ' ' + f1(p1y) + 'Z';
  }
  function moon(cx, cy, R, mini) {
    var path = crescentPath(cx, cy, R, R * 0.58, -R * 0.42, R * 0.86);
    if (mini) return '<path class="wxm-moon" d="' + path + '"/>';
    return '<g class="wx-moon"><circle class="wx-mglow" cx="' + f1(cx - R * 0.15) + '" cy="' + f1(cy + R * 0.1) + '" r="' + f1(R * 1.7) + '" fill="url(#wx-gmglow)"/>' +
      '<path d="' + path + '" fill="url(#wx-gmoon)"/>' +
      '<circle cx="' + f1(cx - R * 0.42) + '" cy="' + f1(cy + R * 0.18) + '" r="' + f1(R * 0.13) + '" class="wx-crater"/>' +
      '<circle cx="' + f1(cx - R * 0.12) + '" cy="' + f1(cy + R * 0.55) + '" r="' + f1(R * 0.09) + '" class="wx-crater"/></g>';
  }
  function stars(mini) {
    if (mini) return '';
    var pts = [[100, 26, 4.5, 0], [110, 56, 3, 1.1], [26, 30, 3.5, 2], [20, 84, 2.6, 0.6]], s = '';
    pts.forEach(function (p) {
      var x = p[0], y = p[1], r = p[2];
      s += '<path class="wx-star" style="animation-delay:' + p[3] + 's" d="M' + x + ' ' + f1(y - r) + 'Q' + x + ' ' + y + ' ' + f1(x + r) + ' ' + y +
        'Q' + x + ' ' + y + ' ' + x + ' ' + f1(y + r) + 'Q' + x + ' ' + y + ' ' + f1(x - r) + ' ' + y + 'Q' + x + ' ' + y + ' ' + x + ' ' + f1(y - r) + 'Z"/>';
    });
    return s;
  }
  function drops(xs, y0, mini, heavy) {
    var s = '';
    xs.forEach(function (x, i) {
      var len = heavy ? 13 : 10;
      s += '<line class="' + (mini ? 'wxm-drop' : 'wx-drop') + '" x1="' + x + '" y1="' + y0 + '" x2="' + (x - 3) + '" y2="' + (y0 + len) + '"' +
        (mini ? '' : ' style="animation-delay:' + f1((i * 0.37) % 1 * (heavy ? 0.7 : 1)) + 's' + (heavy ? ';animation-duration:.7s' : '') + '"') + '/>';
    });
    return '<g stroke-linecap="round" stroke-width="' + (mini ? 7 : heavy ? 4 : 3.5) + '">' + s + '</g>';
  }
  function flakes(pts, mini) {
    var s = '';
    pts.forEach(function (p, i) {
      s += '<circle class="' + (mini ? 'wxm-flake' : 'wx-flake') + '" cx="' + p[0] + '" cy="' + p[1] + '" r="' + (mini ? 6 : 3.4) + '"' +
        (mini ? '' : ' style="animation-delay:' + f1(i * 0.53 % 2.6) + 's"') + '/>';
    });
    return s;
  }
  function bolt(mini) {
    return '<path class="' + (mini ? 'wxm-bolt' : 'wx-bolt') + '" d="M68 74 54 98h11l-7 22 23-30H70l8-16z"' + (mini ? '' : ' stroke-linejoin="round"') + '/>';
  }
  function fogBars(mini) {
    var s = '', bars = [[26, 100, 88], [36, 108, 99], [22, 92, 110]];
    bars.forEach(function (b, i) {
      s += '<line class="' + (mini ? 'wxm-fog' : 'wx-fogbar') + '" x1="' + b[0] + '" y1="' + b[2] + '" x2="' + b[1] + '" y2="' + b[2] + '"' +
        (mini ? '' : ' style="animation-delay:' + (i * -1.6) + 's"') + '/>';
    });
    return '<g stroke-linecap="round" stroke-width="' + (mini ? 9 : 6) + '">' + s + '</g>';
  }

  // The drawing for a weather kind; day=false swaps sun for moon (+ stars).
  function art(kind, day, mini) {
    var cel = function (cx, cy, r) { return day ? sun(cx, cy, r, mini) : moon(cx, cy, r * 1.12, mini); };
    var drift = mini ? '' : 'wx-drift', drift2 = mini ? '' : 'wx-drift2';
    var top = 'translate(-4 -12)';
    switch (kind) {
      case 'clear':
        return (day ? '' : stars(mini)) + cel(64, 64, 24);
      case 'mostly':
        return (day ? '' : stars(mini)) + cel(56, 54, 22) + cloud('translate(50 60) scale(.58)', 'light', mini, drift);
      case 'partly':
        return cel(46, 44, 18) + cloud('translate(2 6)', 'light', mini, drift);
      case 'cloudy':
        return cloud('translate(-14 -8) scale(.82)', 'back', mini, drift2) + cloud('translate(6 8)', 'light', mini, drift);
      case 'fog':
        return cloud('translate(-4 -22)', 'back', mini, drift) + fogBars(mini);
      case 'drizzle':
        return cloud(top, 'gray', mini, drift) + drops([46, 66, 86], 86, mini);
      case 'rain':
        return cloud(top, 'gray', mini, drift) + drops([42, 58, 74, 90], 86, mini);
      case 'heavy-rain':
        return cloud(top, 'dark', mini, drift) + drops(mini ? [42, 58, 74, 90] : [38, 50, 62, 74, 86, 98], 86, mini, true);
      case 'showers':
        return cel(44, 38, 16) + cloud('translate(4 -6)', 'gray', mini, drift) + drops([50, 68, 86], 92, mini);
      case 'sleet':
        return cloud(top, 'gray', mini, drift) + drops([44, 76], 86, mini) + flakes([[60, 94], [92, 92]], mini);
      case 'snow':
        return cloud(top, 'light', mini, drift) + flakes(mini ? [[44, 96], [64, 102], [84, 96]] : [[44, 92], [60, 100], [76, 92], [92, 100]], mini);
      case 'heavy-snow':
        return cloud(top, 'gray', mini, drift) + flakes(mini ? [[40, 94], [58, 108], [76, 94], [94, 108]] : [[40, 90], [54, 102], [68, 92], [82, 104], [96, 92], [61, 114]], mini);
      case 'snow-showers':
        return cel(44, 38, 16) + cloud('translate(4 -6)', 'light', mini, drift) + flakes([[52, 100], [70, 108], [88, 100]], mini);
      case 'thunder':
        return cloud(top, 'dark', mini, drift) + (mini ? '' : drops([40, 92], 86, mini)) + bolt(mini);
      case 'hail':
        return cloud(top, 'dark', mini, drift) + bolt(mini) + flakes(mini ? [[42, 100], [92, 100]] : [[40, 96], [92, 98], [50, 112]], mini).replace(/wx(m?)-flake/g, 'wx$1-hail');
    }
    return cloud('translate(-4 0)', 'light', mini, drift);
  }
  function glyphSVG(code, day, cls) {
    var w = wmo(code, day);
    return '<svg class="wx-glyph-svg ' + (cls || '') + '" viewBox="0 0 128 128" aria-hidden="true" focusable="false">' + art(w.kind, !!day, false) + '</svg>';
  }
  var KINDS = ['clear', 'mostly', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'heavy-rain', 'showers', 'sleet', 'snow', 'heavy-snow', 'snow-showers', 'thunder', 'hail'];
  var DAY_VARIANT = { clear: 1, mostly: 1, partly: 1, showers: 1, 'snow-showers': 1 };
  function symId(kind, day) { return 'wxm-' + kind + (DAY_VARIANT[kind] ? (day ? '-d' : '-n') : ''); }
  function mini(code, day, size) {
    var w = wmo(code, day);
    return '<svg class="wxm" width="' + size + '" height="' + size + '" viewBox="0 0 128 128" aria-hidden="true" focusable="false"><use href="#' + symId(w.kind, !!day) + '"/></svg>';
  }
  // Shared <defs>: gradients for the hero glyph + every mini symbol. Lives in
  // a zero-size (not display:none — gradients inside those don't paint) svg.
  function defsSVG() {
    var syms = '';
    KINDS.forEach(function (k) {
      if (DAY_VARIANT[k]) {
        syms += '<symbol id="' + symId(k, true) + '" viewBox="0 0 128 128">' + art(k, true, true) + '</symbol>';
        syms += '<symbol id="' + symId(k, false) + '" viewBox="0 0 128 128">' + art(k, false, true) + '</symbol>';
      } else syms += '<symbol id="' + symId(k, true) + '" viewBox="0 0 128 128">' + art(k, true, true) + '</symbol>';
    });
    function lg(id, a, b) {
      return '<linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="0" y1="34" x2="0" y2="92"><stop offset="0" stop-color="' + a + '"/><stop offset="1" stop-color="' + b + '"/></linearGradient>';
    }
    return '<svg class="wx-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>' +
      '<radialGradient id="wx-gsun" cx="0.42" cy="0.38" r="0.7"><stop offset="0" stop-color="#fff3b0"/><stop offset="0.45" stop-color="#ffcf3d"/><stop offset="1" stop-color="#ff9f1a"/></radialGradient>' +
      '<radialGradient id="wx-gglow"><stop offset="0.35" stop-color="#ffd54a" stop-opacity=".55"/><stop offset="1" stop-color="#ffd54a" stop-opacity="0"/></radialGradient>' +
      '<radialGradient id="wx-gmglow"><stop offset="0.4" stop-color="#fff4c8" stop-opacity=".3"/><stop offset="1" stop-color="#fff4c8" stop-opacity="0"/></radialGradient>' +
      '<linearGradient id="wx-gmoon" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fffbea"/><stop offset="1" stop-color="#f1d58d"/></linearGradient>' +
      lg('wx-gc-light', '#ffffff', '#dfe7f1') + lg('wx-gc-back', '#dbe3ec', '#a9b7c7') +
      lg('wx-gc-gray', '#eef2f6', '#a8b5c4') + lg('wx-gc-dark', '#aab4c2', '#5f6b7c') +
      '</defs>' + syms + '</svg>';
  }

  // ---- cache -----------------------------------------------------------------------
  function cacheAll() { var c = readJSON(CACHE_KEY, {}); return c && typeof c === 'object' ? c : {}; }
  function cacheGet(loc) {
    var e = cacheAll()[geo().keyOf(loc)];
    return e && e.m && e.m.h && e.m.d ? e.m : null;
  }
  function cachePut(loc, m) {
    var all = cacheAll();
    all[geo().keyOf(loc)] = { m: m };
    var keys = Object.keys(all).sort(function (a, b) { return (all[b].m.fetched || 0) - (all[a].m.fetched || 0); });
    keys.slice(MAX_CACHE).forEach(function (k) { delete all[k]; });
    writeJSON(CACHE_KEY, all);
  }

  // ---- fetch -------------------------------------------------------------------------
  function post(url, body, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || 15000) : 0;
    return fetch(url, {
      method: 'POST', body: body, cache: 'no-store', credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) {
        return r.json().then(function (j) { throw new Error(j && j.reason || 'HTTP ' + r.status); },
          function () { throw new Error('HTTP ' + r.status); });
      }
      return r.json();
    }, function (e) { clearTimeout(timer); throw e; });
  }
  function r1(v) { return v == null ? null : Math.round(v * 10) / 10; }
  function col(a, n, f) { a = (a || []).slice(0, n); return f ? a.map(f) : a; }
  // Keep only what we draw, rounded, columnar (small for Cade.store).
  function trim(fc, aq) {
    var c = fc.current || {}, h = fc.hourly || {}, d = fc.daily || {};
    var nH = Math.min((h.time || []).length, 48), nD = Math.min((d.time || []).length, 10);
    return {
      tz: fc.timezone || '', off: fc.utc_offset_seconds || 0, abbr: fc.timezone_abbreviation || '',
      c: {
        t: c.time * 1000, tp: r1(c.temperature_2m), fl: r1(c.apparent_temperature), rh: c.relative_humidity_2m,
        dp: r1(c.dew_point_2m), day: c.is_day, pr: r1(c.precipitation), code: c.weather_code, cc: c.cloud_cover,
        ps: r1(c.pressure_msl), ws: r1(c.wind_speed_10m), wd: c.wind_direction_10m, wg: r1(c.wind_gusts_10m),
        vis: c.visibility != null ? Math.round(c.visibility) : null, uv: r1(c.uv_index),
      },
      h: {
        t: col(h.time, nH, function (x) { return x * 1000; }), tp: col(h.temperature_2m, nH, r1),
        pp: col(h.precipitation_probability, nH), pr: col(h.precipitation, nH, r1), code: col(h.weather_code, nH),
        day: col(h.is_day, nH), ps: col(h.pressure_msl, nH, r1), ws: col(h.wind_speed_10m, nH, r1),
      },
      d: {
        t: col(d.time, nD, function (x) { return x * 1000; }), code: col(d.weather_code, nD),
        hi: col(d.temperature_2m_max, nD, r1), lo: col(d.temperature_2m_min, nD, r1),
        pp: col(d.precipitation_probability_max, nD), ps: col(d.precipitation_sum, nD, r1),
        sr: col(d.sunrise, nD, function (x) { return x * 1000; }), ss: col(d.sunset, nD, function (x) { return x * 1000; }),
        uv: col(d.uv_index_max, nD, r1), wm: col(d.wind_speed_10m_max, nD, r1), gm: col(d.wind_gusts_10m_max, nD, r1),
        wd: col(d.wind_direction_10m_dominant, nD),
      },
      aq: aq && aq.current ? {
        us: aq.current.us_aqi, eu: aq.current.european_aqi, pm25: r1(aq.current.pm2_5), pm10: r1(aq.current.pm10),
        o3: r1(aq.current.ozone), no2: r1(aq.current.nitrogen_dioxide),
      } : null,
      fetched: Date.now(),
    };
  }
  function fetchWeather(loc) {
    var base = 'latitude=' + loc.lat + '&longitude=' + loc.lon + '&timezone=auto&timeformat=unixtime';
    var fb = base +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,is_day,precipitation,weather_code,' +
      'cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,uv_index' +
      '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,is_day,pressure_msl,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,' +
      'sunrise,sunset,uv_index_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant' +
      '&forecast_days=10&forecast_hours=48&wind_speed_unit=kmh&temperature_unit=celsius&precipitation_unit=mm';
    var ab = base + '&current=us_aqi,european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide';
    return Promise.all([
      post(FORECAST, fb),
      post(AIR, ab, 10000).catch(function () { return null; }), // AQ is a nice-to-have
    ]).then(function (r) { return trim(r[0], r[1]); });
  }

  // ---- state -------------------------------------------------------------------------
  var S = null; // per-open state
  function panel() { return document.getElementById(PANEL_ID); }
  function geo() { return window.__cadeGeo; }
  var geoLoading = null;
  function loadGeo() {
    if (window.__cadeGeo) return Promise.resolve(window.__cadeGeo);
    if (geoLoading) return geoLoading;
    geoLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = GEO_URL;
      s.onload = function () { if (window.__cadeGeo) resolve(window.__cadeGeo); else { geoLoading = null; reject(new Error('geo')); } };
      s.onerror = function () { geoLoading = null; reject(new Error('Couldn’t load the location helper')); };
      document.head.appendChild(s);
    });
    return geoLoading;
  }
  function reduced() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }

  // ---- derived values ----------------------------------------------------------------
  function todayIdx(m, now) {
    var i = 0;
    while (i + 1 < m.d.t.length && m.d.t[i + 1] <= now) i++;
    return i;
  }
  function skyKey(m, now) {
    var c = m.c, w = wmo(c.code, c.day), k = w.kind, day = !!c.day;
    if (k === 'thunder' || k === 'hail') return 'storm';
    if (/snow/.test(k)) return day ? 'snow' : 'snow-night';
    if (PRECIP_KINDS[k]) return day ? 'rain' : 'rain-night';
    if (k === 'fog') return day ? 'fog' : 'fog-night';
    if (k === 'cloudy') return day ? 'cloudy' : 'cloudy-night';
    var di = todayIdx(m, now), sr = m.d.sr[di], ss = m.d.ss[di];
    if ((sr && Math.abs(now - sr) < 50 * 60000) || (ss && Math.abs(now - ss) < 50 * 60000)) return 'golden';
    if (k === 'partly') return day ? 'partly' : 'partly-night';
    return day ? 'clear' : 'clear-night';
  }
  // One-line outlook for the next 12 hours.
  function headline(m) {
    var h = m.h, n = Math.min(h.t.length, 13), cur = wmo(m.c.code, m.c.day), tz = m.tz, i;
    if (PRECIP_KINDS[cur.kind]) {
      for (i = 1; i < n; i++) {
        if ((h.pp[i] || 0) < 30 && !PRECIP_KINDS[wmo(h.code[i]).kind]) return precipWord(cur.kind) + ' easing around ' + hr(h.t[i], tz);
      }
      return precipWord(cur.kind) + ' continuing for the next hours';
    }
    for (i = 1; i < n; i++) {
      if ((h.pp[i] || 0) >= 50) {
        var k = wmo(h.code[i]).kind;
        return precipWord(PRECIP_KINDS[k] ? k : 'rain') + ' likely around ' + hr(h.t[i], tz) + ' (' + h.pp[i] + '%)';
      }
    }
    for (i = 1; i < n; i++) {
      if ((h.pp[i] || 0) >= 30) return 'Slight chance of ' + precipWord(wmo(h.code[i]).kind).toLowerCase() + ' around ' + hr(h.t[i], tz) + ' (' + h.pp[i] + '%)';
    }
    if (m.c.wg != null && m.c.wg >= 50) return 'Gusty — gusts up to ' + wStr(m.c.wg);
    var di = todayIdx(m, Date.now());
    if (m.d.uv[di] >= 8 && m.c.day) return 'Very high UV today (' + Math.round(m.d.uv[di]) + ') — sun protection advised';
    return 'No precipitation expected in the next 12 hours';
  }
  function headIcon(text) {
    if (/^No precip/.test(text)) return '✓';
    if (/Gust/.test(text)) return '≋';
    if (/UV/.test(text)) return '☀';
    if (/Snow/i.test(text)) return '❄';
    if (/Storm/i.test(text)) return '⚡';
    return '☂';
  }

  // ---- rendering -------------------------------------------------------------------------
  function render() {
    var p = panel(); if (!p || !S) return;
    var m = S.model;
    var name = p.querySelector('.wx-pname'), sub = p.querySelector('.wx-psub');
    name.textContent = S.loc ? S.loc.name : 'Choose a place';
    sub.textContent = S.loc ? (geo().sublabel(S.loc) || '') : '';
    p.querySelector('.wx-units-btn').textContent = tUnit();
    var main = p.querySelector('.wx-main');
    if (!S.loc) { renderEmpty(main); renderFoot(); return; }
    if (!m) {
      main.innerHTML = S.err
        ? '<div class="wx-msg"><div class="wx-msg-t">Couldn’t load the weather</div><div class="wx-msg-s">' + esc(S.err) +
          '</div><button class="wx-btn primary wx-retry" type="button">Try again</button></div>'
        : skeleton();
      renderFoot();
      return;
    }
    var now = Date.now();
    main.innerHTML = heroHTML(m, now) +
      '<section class="wx-card wx-hourly"><div class="wx-h">Next 48 hours</div><div class="wx-hscroll">' + hourlySVG(m) + '</div></section>' +
      '<section class="wx-card"><div class="wx-h">' + m.d.t.length + '-day forecast</div><div class="wx-days">' + dailyHTML(m, now) + '</div></section>' +
      '<div class="wx-tiles">' + tilesHTML(m, now) + '</div>' +
      '<div class="wx-attr">Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a> (CC BY 4.0)</div>';
    var hs = main.querySelector('.wx-hscroll');
    if (hs) {
      hs.scrollLeft = S.hScroll || 0;
      hs.addEventListener('scroll', function () { S.hScroll = hs.scrollLeft; }, { passive: true });
      hs.addEventListener('wheel', function (e) {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && hs.scrollWidth > hs.clientWidth) { hs.scrollLeft += e.deltaY; e.preventDefault(); }
      }, { passive: false });
    }
    renderFoot();
  }

  function skeleton() {
    return '<div class="wx-hero wx-skel" data-sky="cloudy"><div class="wx-sk wx-sk-a"></div><div class="wx-sk wx-sk-b"></div><div class="wx-sk wx-sk-c"></div></div>' +
      '<div class="wx-card wx-sk-card"></div><div class="wx-card wx-sk-card tall"></div>';
  }

  function renderEmpty(main) {
    main.innerHTML = '<div class="wx-empty"><div class="wx-empty-art">' + glyphSVG(2, 1) + '</div>' +
      '<div class="wx-msg-t">Where should we look?</div>' +
      '<div class="wx-msg-s">Search for a city or use your location. Nothing is sent anywhere until you choose.</div>' +
      '<div class="wx-empty-pick"></div></div>';
    mountPicker(main.querySelector('.wx-empty-pick'), false);
  }

  function heroHTML(m, now) {
    var c = m.c, w = wmo(c.code, c.day), di = todayIdx(m, now);
    var stale = S.offline || S.failed || now - m.fetched > STALE_MS;
    var badge = stale ? '<span class="wx-badge" title="Showing saved data">' + (navigator.onLine === false ? 'Offline · ' : 'Saved · ') + ago(m.fetched) + '</span>' : '';
    var line = headline(m);
    return '<div class="wx-hero" data-sky="' + skyKey(m, now) + '">' +
      '<div class="wx-hero-fx" aria-hidden="true"></div>' +
      '<div class="wx-hero-row">' +
        '<div class="wx-hero-l">' +
          '<div class="wx-now">Now ' + badge + '</div>' +
          '<div class="wx-temp">' + Math.round(tC(c.tp)) + '<span class="wx-deg">°</span></div>' +
          '<div class="wx-cond">' + esc(w.label) + '</div>' +
          '<div class="wx-hilo"><span>H ' + tStr(m.d.hi[di]) + '</span><span>L ' + tStr(m.d.lo[di]) + '</span><span>Feels ' + tStr(c.fl) + '</span></div>' +
        '</div>' +
        '<div class="wx-glyph">' + glyphSVG(c.code, c.day) + '</div>' +
      '</div>' +
      '<div class="wx-line"><span class="wx-line-i" aria-hidden="true">' + headIcon(line) + '</span>' + esc(line) + '</div>' +
    '</div>';
  }

  // Monotone cubic (Fritsch–Carlson / harmonic slopes): smooth, no overshoot.
  function monoPath(pts) {
    var n = pts.length; if (!n) return '';
    if (n === 1) return 'M' + pts[0][0] + ' ' + pts[0][1];
    var m = [], t = [], i;
    for (i = 0; i < n - 1; i++) m[i] = (pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]);
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : 2 * m[i - 1] * m[i] / (m[i - 1] + m[i]);
    var d = 'M' + f1(pts[0][0]) + ' ' + f1(pts[0][1]);
    for (i = 0; i < n - 1; i++) {
      var dx = (pts[i + 1][0] - pts[i][0]) / 3;
      d += 'C' + f1(pts[i][0] + dx) + ' ' + f1(pts[i][1] + t[i] * dx) + ' ' + f1(pts[i + 1][0] - dx) + ' ' +
        f1(pts[i + 1][1] - t[i + 1] * dx) + ' ' + f1(pts[i + 1][0]) + ' ' + f1(pts[i + 1][1]);
    }
    return d;
  }

  function hourlySVG(m) {
    var h = m.h, n = h.t.length, CW = 50, W = n * CW, HT = 150, tz = m.tz;
    if (!n) return '<div class="wx-msg-s">No hourly data</div>';
    var temps = h.tp.slice(0, n);
    temps[0] = m.c.tp != null ? m.c.tp : temps[0];
    var lo = Math.min.apply(null, temps), hi = Math.max.apply(null, temps);
    if (hi - lo < 3) { var mid = (hi + lo) / 2; lo = mid - 1.5; hi = mid + 1.5; }
    var yT = 72, yB = 100, base = HT - 6, barMax = 24;
    function yOf(v) { return yB - (v - lo) / (hi - lo) * (yB - yT); }
    var pts = temps.map(function (v, i) { return [i * CW + CW / 2, yOf(v)]; });
    var mids = {};
    m.d.t.forEach(function (t) { mids[t] = 1; });
    var s = '<svg class="wx-hsvg" width="' + W + '" height="' + HT + '" viewBox="0 0 ' + W + ' ' + HT + '" role="img" aria-label="Hourly temperature and precipitation chance">';
    // temperature gradient along x
    s += '<defs><linearGradient id="wx-hgrad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="' + W + '" y2="0">';
    pts.forEach(function (p, i) { s += '<stop offset="' + (p[0] / W).toFixed(4) + '" stop-color="' + tempColor(temps[i]) + '"/>'; });
    s += '</linearGradient><linearGradient id="wx-hfade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
      '<mask id="wx-hmask"><rect x="0" y="' + yT + '" width="' + W + '" height="' + (base - yT) + '" fill="url(#wx-hfade)"/></mask></defs>';
    // night bands
    var i, run = -1;
    for (i = 0; i <= n; i++) {
      var night = i < n && h.day[i] === 0;
      if (night && run < 0) run = i;
      if (!night && run >= 0) { s += '<rect class="wx-hnight" x="' + run * CW + '" y="0" width="' + (i - run) * CW + '" height="' + HT + '"/>'; run = -1; }
    }
    // day separators + labels
    for (i = 0; i < n; i++) {
      var x = i * CW + CW / 2, lbl, cls = 'wx-ht';
      if (i === 0) { lbl = 'Now'; cls += ' now'; }
      else if (mids[h.t[i]]) {
        lbl = fmt(h.t[i] + 12 * HOUR, tz, 'wd', { weekday: 'short' });
        cls += ' day';
        s += '<line class="wx-hsep" x1="' + i * CW + '" y1="4" x2="' + i * CW + '" y2="' + base + '"/>';
      } else lbl = hr(h.t[i], tz);
      s += '<text class="' + cls + '" x="' + x + '" y="15" text-anchor="middle">' + esc(lbl) + '</text>';
      s += '<use href="#' + symId(wmo(h.code[i], h.day[i]).kind, !!h.day[i]) + '" x="' + (x - 13) + '" y="24" width="26" height="26"/>';
    }
    // area + line
    var line = monoPath(pts);
    s += '<path d="' + line + 'L' + f1(pts[n - 1][0]) + ' ' + base + 'L' + f1(pts[0][0]) + ' ' + base + 'Z" fill="url(#wx-hgrad)" mask="url(#wx-hmask)" opacity=".22"/>';
    s += '<path class="wx-hline" d="' + line + '" stroke="url(#wx-hgrad)"/>';
    for (i = 0; i < n; i++) {
      var p = pts[i];
      s += '<circle class="wx-hdot' + (i === 0 ? ' now' : '') + '" cx="' + f1(p[0]) + '" cy="' + f1(p[1]) + '" r="' + (i === 0 ? 4 : 2.6) + '" stroke="' + tempColor(temps[i]) + '"/>';
      s += '<text class="wx-htemp" x="' + f1(p[0]) + '" y="' + f1(p[1] - 9) + '" text-anchor="middle">' + Math.round(tC(temps[i])) + '°</text>';
      var pp = h.pp[i] || 0;
      if (pp > 0) {
        var bh = Math.max(2, pp / 100 * barMax);
        s += '<rect class="wx-hbar" x="' + (i * CW + 15) + '" y="' + f1(base - bh) + '" width="' + (CW - 30) + '" height="' + f1(bh) + '" rx="2.5" opacity="' + (0.35 + 0.65 * pp / 100).toFixed(2) + '"/>';
        if (pp >= 15) s += '<text class="wx-hpp" x="' + (i * CW + CW / 2) + '" y="' + f1(base - bh - 3) + '" text-anchor="middle">' + pp + '%</text>';
      }
    }
    s += '<line class="wx-hbase" x1="0" y1="' + base + '" x2="' + W + '" y2="' + base + '"/>';
    return s + '</svg>';
  }

  function dailyHTML(m, now) {
    var d = m.d, n = d.t.length, tz = m.tz, di = todayIdx(m, now);
    if (!n) return '';
    var gLo = Math.min.apply(null, d.lo), gHi = Math.max.apply(null, d.hi);
    if (m.c.tp != null) { gLo = Math.min(gLo, m.c.tp); gHi = Math.max(gHi, m.c.tp); }
    var span = Math.max(1, gHi - gLo), out = '';
    for (var i = 0; i < n; i++) {
      var lo = d.lo[i], hi = d.hi[i];
      var l = (lo - gLo) / span * 100, w = Math.max(2, (hi - lo) / span * 100);
      var grad = 'linear-gradient(90deg,' + tempColor(lo) + ',' + tempColor((lo + hi) / 2) + ',' + tempColor(hi) + ')';
      var name = i === di ? 'Today' : fmt(d.t[i] + 12 * HOUR, tz, 'wd', { weekday: 'short' });
      var pp = d.pp[i];
      var nowDot = i === di && m.c.tp != null
        ? '<span class="wx-dnow" style="left:' + ((m.c.tp - gLo) / span * 100).toFixed(1) + '%" title="Now ' + tStr(m.c.tp) + '"></span>' : '';
      var open = S.openDay === i;
      out += '<button class="wx-day' + (open ? ' open' : '') + '" type="button" data-i="' + i + '" aria-expanded="' + open + '">' +
        '<span class="wx-dname">' + esc(name) + '</span>' +
        '<span class="wx-dico">' + mini(d.code[i], 1, 26) + (pp >= 20 ? '<span class="wx-dpp">' + pp + '%</span>' : '') + '</span>' +
        '<span class="wx-dlo">' + tStr(lo) + '</span>' +
        '<span class="wx-drange"><span class="wx-dbar" style="left:' + l.toFixed(1) + '%;width:' + w.toFixed(1) + '%;background:' + grad + '"></span>' + nowDot + '</span>' +
        '<span class="wx-dhi">' + tStr(hi) + '</span></button>';
      if (open) {
        var date = fmt(d.t[i] + 12 * HOUR, tz, 'md', { weekday: 'long', month: 'short', day: 'numeric' });
        out += '<div class="wx-dmore"><b>' + esc(date) + '</b> · ' + esc(wmo(d.code[i], 1).label) +
          '<div class="wx-dgrid">' +
          '<span>↑ Sunrise <b>' + (d.sr[i] ? hm(d.sr[i], tz) : '–') + '</b></span>' +
          '<span>↓ Sunset <b>' + (d.ss[i] ? hm(d.ss[i], tz) : '–') + '</b></span>' +
          '<span>Wind <b>' + wStr(d.wm[i]) + ' ' + dirName(d.wd[i]) + '</b></span>' +
          '<span>Gusts <b>' + wStr(d.gm[i]) + '</b></span>' +
          '<span>Precip. <b>' + pStr(d.ps[i]) + (pp != null ? ' · ' + pp + '%' : '') + '</b></span>' +
          '<span>UV max <b>' + (d.uv[i] != null ? Math.round(d.uv[i]) + ' ' + uvLevel(d.uv[i])[1] : '–') + '</b></span>' +
          '</div></div>';
      }
    }
    return out;
  }

  function tile(cls, label, body, title) {
    return '<div class="wx-tile ' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + '><div class="wx-tl">' + label + '</div>' + body + '</div>';
  }
  function meter(pct, color, stops) {
    pct = Math.max(0, Math.min(100, pct));
    return '<div class="wx-meter"' + (stops ? ' style="background:' + stops + '"' : '') + '>' +
      (color ? '<span class="wx-meter-fill" style="width:' + pct + '%;background:' + color + '"></span>' : '') +
      '<span class="wx-meter-dot" style="left:' + pct + '%"></span></div>';
  }

  function tilesHTML(m, now) {
    var c = m.c, d = m.d, h = m.h, tz = m.tz, di = todayIdx(m, now), out = '';
    // Wind: compass with an arrow pointing where the wind blows TO.
    var wd = c.wd != null ? c.wd : 0, ticks = '';
    for (var k = 0; k < 36; k++) {
      var a = k * 10 * RAD, r0 = k % 9 === 0 ? 30 : 33;
      ticks += '<line x1="' + f1(40 + Math.sin(a) * r0) + '" y1="' + f1(40 - Math.cos(a) * r0) + '" x2="' + f1(40 + Math.sin(a) * 36) + '" y2="' + f1(40 - Math.cos(a) * 36) + '"' + (k % 9 === 0 ? ' class="maj"' : '') + '/>';
    }
    var comp = '<svg class="wx-comp" viewBox="0 0 80 80" aria-hidden="true"><g class="wx-comp-t">' + ticks + '</g>' +
      '<text x="40" y="20" text-anchor="middle">N</text><text x="62" y="43.5" text-anchor="middle">E</text><text x="40" y="66" text-anchor="middle">S</text><text x="18" y="43.5" text-anchor="middle">W</text>' +
      '<g transform="rotate(' + ((wd + 180) % 360) + ' 40 40)"><path class="wx-comp-a" d="M40 10 46 22H42V58H38V22H34Z"/><circle class="wx-comp-c" cx="40" cy="40" r="3.4"/></g></svg>';
    out += tile('wx-wind', '≋ Wind',
      '<div class="wx-wind-row">' + comp + '<div><div class="wx-big">' + Math.round(wV(c.ws || 0)) + '<small> ' + WIND_U[prefs.wind][0] + '</small></div>' +
      '<div class="wx-sub">From ' + dirName(c.wd) + ' (' + Math.round(wd) + '°)</div>' +
      '<div class="wx-sub">Gusts ' + wStr(c.wg) + '</div><div class="wx-sub faint">' + beaufort(c.ws || 0) + '</div></div></div>');
    // Humidity
    var dp = c.dp, comfort = dp == null ? '' : dp < 10 ? 'Dry' : dp < 16 ? 'Comfortable' : dp < 18 ? 'Humid' : dp < 21 ? 'Muggy' : 'Oppressive';
    out += tile('', '◍ Humidity', '<div class="wx-big">' + (c.rh != null ? c.rh : '–') + '<small>%</small></div>' +
      meter(c.rh || 0, 'linear-gradient(90deg,#7dd3fc,#3b82f6)') +
      '<div class="wx-sub">Dew point ' + tStr(dp) + '</div><div class="wx-sub faint">' + comfort + '</div>');
    // UV
    var uv = c.uv != null ? c.uv : 0, ul = uvLevel(uv);
    out += tile('', '☀ UV index', '<div class="wx-big">' + Math.round(uv) + '<small> ' + ul[1] + '</small></div>' +
      meter(uv / 11 * 100, null, 'linear-gradient(90deg,#3ea72d,#e2b007 30%,#f18b00 55%,#e53210 75%,#b567a4)') +
      '<div class="wx-sub">Today’s max ' + (d.uv[di] != null ? Math.round(d.uv[di]) + ' · ' + uvLevel(d.uv[di])[1] : '–') + '</div>');
    // Air quality
    if (m.aq && (m.aq.us != null || m.aq.eu != null)) {
      var eu = prefs.aqi === 'eu' && m.aq.eu != null || m.aq.us == null, v = eu ? m.aq.eu : m.aq.us, lv = aqiLevel(v, eu);
      var stops = eu ? 'linear-gradient(90deg,#14b8a6,#22c55e 20%,#eab308 40%,#f97316 60%,#ef4444 80%,#a855f7)'
        : 'linear-gradient(90deg,#22c55e,#eab308 17%,#f97316 33%,#ef4444 50%,#a855f7 67%,#9f1239)';
      var pos = eu ? v : (v <= 300 ? v / 300 * 100 : 100);
      out += '<button class="wx-tile wx-aqtile" type="button" title="Switch between US and European AQI">' +
        '<div class="wx-tl">☁ Air quality <span class="wx-tl-r">' + (eu ? 'EU AQI' : 'US AQI') + ' ⇄</span></div>' +
        '<div class="wx-big" style="--wx-aq:' + lv[2] + '"><span class="wx-aqdot"></span>' + Math.round(v) + '</div>' +
        meter(pos, null, stops) +
        '<div class="wx-sub">' + esc(lv[1]) + '</div><div class="wx-sub faint">PM2.5 ' + (m.aq.pm25 != null ? m.aq.pm25 + ' µg/m³' : '–') + '</div></button>';
    } else {
      out += tile('', '☁ Air quality', '<div class="wx-big">–</div><div class="wx-sub faint">Not available here</div>');
    }
    out += sunTile(m, now, di);
    // Pressure gauge (950–1050 hPa over 240°) + 3-hour trend.
    var ps = c.ps, trend = '', dps = h.ps[3] != null && h.ps[0] != null ? h.ps[3] - h.ps[0] : 0;
    trend = dps > 1 ? '↗ Rising' : dps < -1 ? '↘ Falling' : '→ Steady';
    var frac = ps == null ? 0.5 : Math.max(0, Math.min(1, (ps - 950) / 100)), ang = (-120 + frac * 240) * RAD;
    var gauge = '<svg class="wx-gauge" viewBox="0 0 80 62" aria-hidden="true">' +
      '<path class="wx-gauge-t" d="' + arcPath(40, 40, 30, -120, 120) + '"/>' +
      '<path class="wx-gauge-f" d="' + arcPath(40, 40, 30, -120, -120 + frac * 240) + '"/>' +
      '<line class="wx-gauge-n" x1="40" y1="40" x2="' + f1(40 + Math.sin(ang) * 24) + '" y2="' + f1(40 - Math.cos(ang) * 24) + '"/>' +
      '<circle class="wx-comp-c" cx="40" cy="40" r="3"/><text x="13" y="60" text-anchor="middle">Low</text><text x="67" y="60" text-anchor="middle">High</text></svg>';
    out += tile('wx-press', '◔ Pressure', '<div class="wx-press-row">' + gauge + '<div><div class="wx-big sm">' + pressStr(ps) + '</div><div class="wx-sub">' + trend + '</div></div></div>');
    // Visibility
    var vis = c.vis, vdesc = vis == null ? '' : vis >= 20000 ? 'Excellent' : vis >= 10000 ? 'Good' : vis >= 4000 ? 'Moderate' : vis >= 1000 ? 'Poor' : 'Very poor · fog';
    out += tile('', '◉ Visibility', '<div class="wx-big sm">' + visStr(vis) + '</div>' + meter(vis == null ? 0 : Math.min(100, vis / 240), 'linear-gradient(90deg,#94a3b8,#38bdf8)') + '<div class="wx-sub">' + vdesc + '</div>');
    // Precipitation next 24 h
    var tot = 0, first = -1;
    for (var i = 0; i < Math.min(24, h.t.length); i++) { tot += h.pr[i] || 0; if (first < 0 && (h.pp[i] || 0) >= 50) first = i; }
    out += tile('', '☂ Precipitation', '<div class="wx-big sm">' + pStr(tot) + '</div><div class="wx-sub">in the next 24 h</div>' +
      '<div class="wx-sub faint">' + (first >= 0 ? 'Likely from ' + (first === 0 ? 'now' : hr(h.t[first], tz)) : 'Chance stays below 50%') + '</div>');
    // Cloud cover
    var cc = c.cc != null ? c.cc : 0, cdesc = cc < 12 ? 'Clear' : cc < 38 ? 'Mostly clear' : cc < 70 ? 'Partly cloudy' : cc < 88 ? 'Mostly cloudy' : 'Overcast';
    out += tile('', '☁ Cloud cover', '<div class="wx-big">' + cc + '<small>%</small></div>' + meter(cc, 'linear-gradient(90deg,#cbd5e1,#64748b)') + '<div class="wx-sub">' + cdesc + '</div>');
    // Feels like
    var diff = c.fl != null && c.tp != null ? c.fl - c.tp : 0;
    out += tile('', '♨ Feels like', '<div class="wx-big">' + tStr(c.fl) + '</div><div class="wx-sub">' +
      (Math.abs(diff) < 1.5 ? 'Similar to the actual temperature' : diff < 0 ? (c.ws > 10 ? 'Wind makes it feel colder' : 'Feels colder than it is') : (c.rh > 60 ? 'Humidity makes it feel warmer' : 'Feels warmer than it is')) + '</div>');
    return out;
  }

  // SVG arc on a circle; angles in degrees clockwise from 12 o'clock.
  function arcPath(cx, cy, r, a0, a1) {
    var p0 = [cx + Math.sin(a0 * RAD) * r, cy - Math.cos(a0 * RAD) * r], p1 = [cx + Math.sin(a1 * RAD) * r, cy - Math.cos(a1 * RAD) * r];
    return 'M' + f1(p0[0]) + ' ' + f1(p0[1]) + 'A' + r + ' ' + r + ' 0 ' + (a1 - a0 > 180 ? 1 : 0) + ' 1 ' + f1(p1[0]) + ' ' + f1(p1[1]);
  }

  function sunTile(m, now, di) {
    var d = m.d, tz = m.tz, sr = d.sr[di], ss = d.ss[di];
    if (!sr || !ss) {
      return tile('wx-suntile', '☀ Sun', '<div class="wx-sub">' + (m.c.day ? 'The sun doesn’t set today' : 'The sun doesn’t rise today') + '</div>');
    }
    var f = (now - sr) / (ss - sr), up = f >= 0 && f <= 1, cf = Math.max(0, Math.min(1, f));
    var X0 = 30, X1 = 330, CX = 180, RX = 150, RY = 66, HY = 86;
    var th = Math.PI * (1 - cf), sx = CX + RX * Math.cos(th), sy = HY - RY * Math.sin(th);
    var s = '<svg class="wx-sunarc" viewBox="0 0 360 112" aria-hidden="true">' +
      '<defs><linearGradient id="wx-sunfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc83d" stop-opacity=".38"/><stop offset="1" stop-color="#ffc83d" stop-opacity="0"/></linearGradient>' +
      '<clipPath id="wx-sunclip"><rect x="0" y="0" width="' + f1(sx) + '" height="' + HY + '"/></clipPath></defs>' +
      '<path class="wx-arc-t" d="M' + X0 + ' ' + HY + 'A' + RX + ' ' + RY + ' 0 0 1 ' + X1 + ' ' + HY + '"/>';
    if (f > 0) {
      s += '<path d="M' + X0 + ' ' + HY + 'A' + RX + ' ' + RY + ' 0 0 1 ' + X1 + ' ' + HY + 'Z" fill="url(#wx-sunfill)" clip-path="url(#wx-sunclip)"/>' +
        '<path class="wx-arc-f" d="M' + X0 + ' ' + HY + 'A' + RX + ' ' + RY + ' 0 0 1 ' + X1 + ' ' + HY + '" clip-path="url(#wx-sunclip)"/>';
    }
    s += '<line class="wx-horizon" x1="6" y1="' + HY + '" x2="354" y2="' + HY + '"/>';
    if (up) s += '<circle class="wx-sunglow" cx="' + f1(sx) + '" cy="' + f1(sy) + '" r="13"/><circle class="wx-sundot" cx="' + f1(sx) + '" cy="' + f1(sy) + '" r="7"/>';
    s += '<text class="wx-arc-l" x="' + X0 + '" y="104" text-anchor="middle">↑ ' + esc(hm(sr, tz)) + '</text>' +
      '<text class="wx-arc-l" x="' + X1 + '" y="104" text-anchor="middle">↓ ' + esc(hm(ss, tz)) + '</text></svg>';
    var len = ss - sr, msg;
    if (now < sr) msg = 'Sunrise in ' + dur(sr - now);
    else if (now <= ss) msg = 'Sunset in ' + dur(ss - now);
    else msg = d.sr[di + 1] ? 'Next sunrise ' + hm(d.sr[di + 1], tz) : 'Sun has set';
    var chg = '';
    if (d.sr[di + 1] && d.ss[di + 1]) {
      var delta = (d.ss[di + 1] - d.sr[di + 1]) - len, sec = Math.round(Math.abs(delta) / 1000);
      chg = 'Tomorrow ' + (sec < 30 ? 'about the same' : Math.floor(sec / 60) + 'm ' + (sec % 60) + 's ' + (delta < 0 ? 'shorter' : 'longer'));
    }
    return tile('wx-suntile', '☀ Sunrise & sunset',
      s + '<div class="wx-sunfoot"><span><b>' + dur(len) + '</b> of daylight</span><span>' + esc(msg) + '</span></div>' +
      (chg ? '<div class="wx-sub faint wx-center">' + esc(chg) + '</div>' : ''));
  }

  function renderFoot() {
    var p = panel(); if (!p || !S) return;
    var f = p.querySelector('.wx-upd'), m = S.model;
    var txt = S.busy ? 'Updating…' : m ? 'Updated ' + ago(m.fetched) : '';
    if (m && (S.failed || S.offline)) txt = (navigator.onLine === false ? 'Offline' : 'Couldn’t refresh') + ' · data ' + ago(m.fetched);
    f.textContent = txt;
    f.title = m ? 'Fetched ' + new Date(m.fetched).toLocaleString() : '';
    p.querySelector('.wx-refresh').classList.toggle('spin', !!S.busy);
    var dis = !m;
    p.querySelector('.wx-insert').disabled = dis;
    p.querySelector('.wx-copy').disabled = dis;
  }

  // ---- summary ------------------------------------------------------------------------
  function summary() {
    var m = S && S.model; if (!m) return '';
    var c = m.c, w = wmo(c.code, c.day), di = todayIdx(m, Date.now());
    var date = fmt(Date.now(), m.tz, 'mdy', { month: 'short', day: 'numeric' });
    var wind = c.ws != null ? ' · Wind ' + wStr(c.ws).replace(' ', ' ') + (c.ws >= 2 ? ' ' + dirName(c.wd) : '') : '';
    return w.emoji + ' ' + Math.round(tC(c.tp)) + tUnit() + ', ' + w.label.toLowerCase() +
      ' · H ' + tStr(m.d.hi[di]) + ' L ' + tStr(m.d.lo[di]) + wind +
      ' — ' + date + ', ' + (S.loc ? S.loc.name : '');
  }
  function copyText(text) {
    var done = function () { Cade.showToast('Copied weather summary', 'success', 1400); };
    var fail = function () { Cade.showToast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      ta.remove();
    }
  }
  function insert(text) {
    var ed = Cade.editor;
    if (!ed || !text) return;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode — editing is locked', 'error', 2000); return; }
    ed.dispatch(ed.state.replaceSelection(text), { userEvent: 'input', scrollIntoView: true });
    Cade.showToast('Inserted weather summary', 'success', 1200);
  }

  // ---- load / refresh -------------------------------------------------------------------
  function load(force) {
    if (!S || !S.loc) return;
    var loc = S.loc, cached = cacheGet(loc);
    if (cached && (!S.model || S.modelKey !== geo().keyOf(loc))) { S.model = cached; S.modelKey = geo().keyOf(loc); }
    if (!cached && S.modelKey !== geo().keyOf(loc)) { S.model = null; S.modelKey = ''; }
    S.err = null;
    var fresh = S.model && Date.now() - S.model.fetched < FRESH_MS;
    if (!force && fresh) { S.failed = false; S.offline = false; render(); return; }
    if (navigator.onLine === false) {
      S.offline = true;
      if (!S.model) S.err = 'You’re offline and there’s no saved forecast for this place yet.';
      render(); return;
    }
    S.busy = true; S.offline = false;
    render();
    var seq = ++S.seq;
    fetchWeather(loc).then(function (m) {
      if (!S || seq !== S.seq || !panel()) return;
      S.model = m; S.modelKey = geo().keyOf(loc); S.failed = false;
      cachePut(loc, m);
      if (!loc.tz && m.tz) geo().patchTz(loc, m.tz);
    }, function (e) {
      if (!S || seq !== S.seq) return;
      S.failed = true;
      if (!S.model) S.err = (e && e.name === 'AbortError') ? 'The request timed out.' : (e && e.message) || 'Network error';
      else Cade.showToast('Couldn’t refresh — showing saved data', 'error', 2200);
    }).then(function () {
      if (!S || seq !== S.seq) return;
      S.busy = false;
      render();
    });
  }

  function setLoc(loc, from) {
    if (!loc) return;
    S.loc = loc;
    S.openDay = -1; S.hScroll = 0;
    load(false);
  }

  // ---- sheets (location / units) ----------------------------------------------------------
  function mountPicker(host, inSheet) {
    if (S.picker) { S.picker.destroy(); S.picker = null; }
    S.picker = geo().picker({
      current: S.loc,
      onPick: function (loc) {
        var saved = geo().set(loc, 'weather');
        closeSheet();
        setLoc(saved || loc);
      },
    });
    host.appendChild(S.picker.el);
    if (inSheet && !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) S.picker.focus();
  }
  function seg(name, opts, cur) {
    return '<div class="wx-seg" role="group" aria-label="' + name + '">' + opts.map(function (o) {
      return '<button type="button" class="wx-segb' + (o[0] === cur ? ' on' : '') + '" data-v="' + o[0] + '" aria-pressed="' + (o[0] === cur) + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function openSheet(kind) {
    var p = panel(); if (!p) return;
    closeSheet();
    var sh = document.createElement('div');
    sh.className = 'wx-sheet';
    sh.setAttribute('data-kind', kind);
    var title = kind === 'units' ? 'Units' : 'Location';
    sh.innerHTML = '<div class="wx-sheet-h"><span>' + title + '</span><button type="button" class="wx-ibtn wx-sheet-x" aria-label="Close">✕</button></div><div class="wx-sheet-b"></div>';
    p.querySelector('.cade-panel-body').appendChild(sh);
    var b = sh.querySelector('.wx-sheet-b');
    if (kind === 'units') {
      b.innerHTML =
        '<div class="wx-urow"><span>Temperature</span>' + seg('temp', [['C', '°C'], ['F', '°F']], prefs.temp) + '</div>' +
        '<div class="wx-urow"><span>Wind</span>' + seg('wind', [['kmh', 'km/h'], ['mph', 'mph'], ['ms', 'm/s'], ['kn', 'kn']], prefs.wind) + '</div>' +
        '<div class="wx-urow"><span>Precipitation</span>' + seg('precip', [['mm', 'mm'], ['in', 'in']], prefs.precip) + '</div>' +
        '<div class="wx-urow"><span>Air quality</span>' + seg('aqi', [['us', 'US AQI'], ['eu', 'EU AQI']], prefs.aqi) + '</div>' +
        '<div class="wx-hint">Pressure follows precipitation (hPa / inHg); visibility follows wind or precipitation (km / mi).</div>';
      b.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('.wx-segb');
        if (!btn) return;
        var key = btn.parentNode.getAttribute('aria-label');
        prefs[key] = btn.getAttribute('data-v');
        savePrefs();
        btn.parentNode.querySelectorAll('.wx-segb').forEach(function (x) {
          x.classList.toggle('on', x === btn); x.setAttribute('aria-pressed', x === btn ? 'true' : 'false');
        });
        render();
      });
    } else {
      mountPicker(b, true);
    }
    sh.querySelector('.wx-sheet-x').addEventListener('click', closeSheet);
    requestAnimationFrame(function () { sh.classList.add('in'); });
  }
  function closeSheet() {
    var p = panel(); if (!p) return false;
    var sh = p.querySelector('.wx-sheet');
    if (!sh) return false;
    if (S && S.picker && sh.contains(S.picker.el)) { S.picker.destroy(); S.picker = null; }
    sh.remove();
    return true;
  }

  // ---- open / close -------------------------------------------------------------------------
  function close() {
    var p = panel();
    if (p) { p.remove(); if (p._onClose) p._onClose(); }
  }

  function open() {
    Cade.closeAllMenus();
    var ex = panel();
    if (ex) { close(); return; }
    loadPrefs();
    var p = Cade.mkPanel(PANEL_ID, '🌤 Weather',
      defsSVG() +
      '<div class="wx-top">' +
        '<button class="wx-place" type="button" title="Change location"><span class="wx-pin" aria-hidden="true">⌖</span>' +
          '<span class="wx-ptxt"><span class="wx-pname">Loading…</span><span class="wx-psub"></span></span><span class="wx-caret" aria-hidden="true">▾</span></button>' +
        '<button class="wx-ibtn wx-units-btn" type="button" title="Units">°C</button>' +
        '<button class="wx-ibtn wx-refresh" type="button" title="Refresh" aria-label="Refresh">↻</button>' +
      '</div>' +
      '<div class="wx-scroll"><div class="wx-main"></div></div>' +
      '<div class="wx-foot">' +
        '<button class="wx-btn primary wx-insert" type="button" title="Insert a one-line summary at the cursor">↵ Insert summary</button>' +
        '<button class="wx-btn wx-copy" type="button" title="Copy the summary">⧉ Copy</button>' +
        '<span class="wx-upd" aria-live="polite"></span>' +
      '</div>');
    if (reduced()) p.classList.add('wx-still');
    S = { loc: null, model: null, modelKey: '', busy: false, failed: false, offline: false, err: null, seq: 0, openDay: -1, hScroll: 0, picker: null };
    var st = S;

    p.addEventListener('click', function (e) {
      var t = e.target; if (!t.closest) return;
      var b;
      if (t.closest('.wx-place')) openSheet('loc');
      else if (t.closest('.wx-units-btn')) openSheet('units');
      else if (t.closest('.wx-refresh')) { if (S.loc) load(true); else openSheet('loc'); }
      else if (t.closest('.wx-retry')) load(true);
      else if (t.closest('.wx-insert')) insert(summary());
      else if (t.closest('.wx-copy')) { var s = summary(); if (s) copyText(s); }
      else if (t.closest('.wx-aqtile')) { prefs.aqi = prefs.aqi === 'eu' ? 'us' : 'eu'; savePrefs(); render(); }
      else if ((b = t.closest('.wx-day'))) {
        var i = +b.getAttribute('data-i');
        S.openDay = S.openDay === i ? -1 : i;
        var sc = p.querySelector('.wx-scroll'), top = sc.scrollTop;
        render(); sc.scrollTop = top;
      }
    });
    p.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (!closeSheet()) close();
        return;
      }
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    });

    var onGeo = function (e) {
      var d = e.detail || {};
      if (!S || S !== st || d.from === 'weather' || !d.loc) return;
      if (S.loc && geo().same(S.loc, d.loc)) return;
      setLoc(d.loc, 'event');
    };
    var onOnline = function () { if (S === st && S.loc && (S.failed || S.offline)) load(true); };
    var onVis = function () {
      if (document.visibilityState === 'visible' && S === st && S.model && Date.now() - S.model.fetched > AUTO_MS) load(true);
    };
    window.addEventListener('cade-geo-change', onGeo);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOnline);
    document.addEventListener('visibilitychange', onVis);
    // Once a minute: refresh relative times / sun position; refetch when old.
    var tick = setInterval(function () {
      if (S !== st || !panel()) return;
      if (S.model && !S.busy && Date.now() - S.model.fetched > AUTO_MS && navigator.onLine !== false && document.visibilityState !== 'hidden') load(true);
      else if (!document.querySelector('#' + PANEL_ID + ' .wx-sheet')) {
        var sc = p.querySelector('.wx-scroll'), top = sc ? sc.scrollTop : 0;
        render(); if (sc) sc.scrollTop = top;
      }
    }, 60000);
    p._onClose = function () {
      clearInterval(tick);
      window.removeEventListener('cade-geo-change', onGeo);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOnline);
      document.removeEventListener('visibilitychange', onVis);
      if (st.picker) { st.picker.destroy(); st.picker = null; }
      st.seq++;
      if (S === st) S = null;
    };

    p.querySelector('.wx-main').innerHTML = skeleton();
    loadGeo().then(function () {
      if (S !== st || !panel()) return;
      S.loc = geo().get();
      render();
      if (S.loc) load(false);
    }, function (e) {
      if (S !== st) return;
      p.querySelector('.wx-main').innerHTML = '<div class="wx-msg"><div class="wx-msg-t">Couldn’t start</div><div class="wx-msg-s">' + esc(e.message) + '</div></div>';
    });
  }

  Cade.registerWidget({
    name: 'Weather',
    description: 'Forecast, hourly & 10-day outlook, air quality, UV, wind — insert a summary',
    icon: '🌤',
    tags: 'weather,forecast,temperature,rain,wind,humidity,uv,air quality,aqi,sunrise,sunset,climate,open-meteo',
    open: open,
    _test: { wmo: wmo, glyphSVG: glyphSVG, defsSVG: defsSVG, art: art, trim: trim, monoPath: monoPath, tempColor: tempColor,
      headline: headline, hourlySVG: hourlySVG, tilesHTML: tilesHTML, dailyHTML: dailyHTML, heroHTML: heroHTML, skyKey: skyKey,
      crescentPath: crescentPath, setState: function (s) { S = s; }, setPrefs: function (p) { prefs = p; }, summary: summary },
  });
})();
