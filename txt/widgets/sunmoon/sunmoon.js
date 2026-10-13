/* Sun & Moon — sunrise/sunset, twilight, golden & blue hour, day length,
 * sun position, moonrise/moonset, phase, illumination and the next full /
 * new moon for any place and date. Computed OFFLINE (astro.js, verified
 * against astronomy-engine to < 0.5 min); no network except the optional
 * city search / reverse geocode in the shared geo.js picker.
 *
 * Times are shown in the place's own time zone (from geocoding, else the
 * device's). The location is shared with the Weather widget (geo.js,
 * Cade.store 'cade-geo-location').
 *
 * Visuals: a day chart of the sun's altitude across the local day over
 * twilight bands (with the moon's path dashed and a live "now" marker) and a
 * moon disc whose terminator is drawn from the real illuminated fraction.
 *
 * Self-contained IIFE; nothing runs until the widget is opened. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('sunmoon.css');
  Cade.loadCSS('../weather/geo.css');
  var BASE = Cade.baseURL();
  var ASTRO_URL = Cade.asset('astro.js');
  var GEO_URL = (function () { try { return new URL('../weather/geo.js', BASE).href; } catch (e) { return BASE + '../weather/geo.js'; } })();
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'sunmoon-panel';
  var HOUR = 3600000, DAY = 86400000;

  function loadScript(url, test) {
    if (test()) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { if (test()) resolve(); else reject(new Error('Couldn\u2019t load ' + url.split('/').pop())); };
      s.onerror = function () { reject(new Error('Couldn\u2019t load ' + url.split('/').pop() + (navigator.onLine === false ? ' (offline)' : ''))); };
      document.head.appendChild(s);
    });
  }
  var ready = null;
  function loadDeps() {
    if (!ready) {
      ready = Promise.all([
        loadScript(ASTRO_URL, function () { return !!window.__cadeAstro; }),
        loadScript(GEO_URL, function () { return !!window.__cadeGeo; }),
      ]).catch(function (e) { ready = null; throw e; });
    }
    return ready;
  }
  function A() { return window.__cadeAstro; }
  function geo() { return window.__cadeGeo; }
  function panel() { return document.getElementById(PANEL_ID); }

  // ---- formatting --------------------------------------------------------------
  var fmtCache = {};
  function fmt(ms, tz, key, o) {
    var k = tz + '|' + key, f = fmtCache[k];
    if (!f) {
      try { f = new Intl.DateTimeFormat(undefined, Object.assign({ timeZone: tz }, o)); }
      catch (e) { f = new Intl.DateTimeFormat(undefined, o); }
      fmtCache[k] = f;
    }
    return f.format(new Date(ms));
  }
  function hm(ms, tz) { return ms == null ? '\u2014' : fmt(ms, tz, 'hm', { hour: 'numeric', minute: '2-digit' }); }
  function dur(ms) {
    var m = Math.round(Math.abs(ms) / 60000), h = Math.floor(m / 60);
    return h + 'h ' + (m % 60 < 10 ? '0' : '') + (m % 60) + 'm';
  }
  function deltaStr(ms) {
    var s = Math.round(Math.abs(ms) / 1000);
    if (s < 1) return 'same as yesterday';
    var m = Math.floor(s / 60);
    return (ms < 0 ? '\u2212' : '+') + (m ? m + 'm ' : '') + (s % 60) + 's vs yesterday';
  }
  function dirName(deg) {
    return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
  }
  function f1(n) { return Math.round(n * 10) / 10; }
  function deg1(n) { var v = (Math.round(n * 10) / 10).toFixed(1); return (v.charAt(0) === '-' ? '\u2212' + v.slice(1) : v) + '\u00b0'; }
  var PHASE_EMOJI = {
    'New Moon': '\ud83c\udf11', 'Waxing Crescent': '\ud83c\udf12', 'First Quarter': '\ud83c\udf13', 'Waxing Gibbous': '\ud83c\udf14',
    'Full Moon': '\ud83c\udf15', 'Waning Gibbous': '\ud83c\udf16', 'Last Quarter': '\ud83c\udf17', 'Waning Crescent': '\ud83c\udf18',
  };

  // ---- state -------------------------------------------------------------------------
  var S = null;
  function tzOf(loc) { return loc && loc.tz && geo().validTz(loc.tz) ? loc.tz : geo().deviceTz(); }
  function todayYMD(tz) { var w = A().wall(Date.now(), tz); return { y: w.y, m: w.m, d: w.d }; }
  function shiftYMD(ymd, days) {
    var t = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + days));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  function sameYMD(a, b) { return a.y === b.y && a.m === b.m && a.d === b.d; }
  function ymdStr(ymd) { return ymd.y + '-' + (ymd.m < 10 ? '0' : '') + ymd.m + '-' + (ymd.d < 10 ? '0' : '') + ymd.d; }

  // Everything for the selected place + day.
  function compute() {
    var loc = S.loc, tz = tzOf(loc), ast = A();
    var start = ast.zonedTime(S.ymd.y, S.ymd.m, S.ymd.d, 0, 0, tz);
    var nx = shiftYMD(S.ymd, 1), pv = shiftYMD(S.ymd, -1);
    var end = ast.zonedTime(nx.y, nx.m, nx.d, 0, 0, tz);
    var pStart = ast.zonedTime(pv.y, pv.m, pv.d, 0, 0, tz);
    var sun = ast.sunDay(start, end, loc.lat, loc.lon);
    var prev = ast.sunDay(pStart, start, loc.lat, loc.lon);
    var moon = ast.moonDay(start, end, loc.lat, loc.lon);
    var now = Date.now(), isToday = now >= start && now < end;
    var ref = isToday ? now : sun.solarNoon; // the moment the "now" numbers describe
    var illum = ast.moonIllumination(ref);
    var phases = ast.moonPhases(ref);
    // moon altitude across the day for the chart
    var mpath = [];
    for (var t = start; t <= end; t += 20 * 60000) mpath.push({ t: t, v: ast.moonPosition(t, loc.lat, loc.lon).altitude });
    return {
      tz: tz, start: start, end: end, sun: sun, prevLen: prev.dayLength, moon: moon, isToday: isToday, now: now, ref: ref,
      sunNow: ast.sunPosition(ref, loc.lat, loc.lon), moonNow: ast.moonPosition(ref, loc.lat, loc.lon),
      illum: illum, phases: phases, phaseName: ast.phaseName(illum.phase), age: (ref - phases.prevNew) / DAY, mpath: mpath,
    };
  }

  // ---- drawing -----------------------------------------------------------------------
  function dayChart(R) {
    var W = 360, H = 176, X0 = 10, X1 = 350, YT = 12, YB = 146;
    var smp = R.sun.samples, lo = 90, hi = -90, i;
    for (i = 0; i < smp.length; i++) { lo = Math.min(lo, smp[i].v); hi = Math.max(hi, smp[i].v); }
    var mhi = -90;
    for (i = 0; i < R.mpath.length; i++) mhi = Math.max(mhi, R.mpath[i].v);
    var yMax = Math.min(90, Math.max(24, hi + 10, mhi + 6)), yMin = Math.max(-54, Math.min(-24, lo - 4));
    function x(t) { return X0 + (t - R.start) / (R.end - R.start) * (X1 - X0); }
    function y(a) { return YT + (yMax - Math.max(yMin, Math.min(yMax, a))) / (yMax - yMin) * (YB - YT); }
    var h0 = y(0);
    var s = '<svg class="sm-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Sun altitude through the day">';
    s += '<defs><linearGradient id="sm-skyg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sm-sky0"/><stop offset="1" class="sm-sky1"/></linearGradient>' +
      '<clipPath id="sm-above"><rect x="0" y="0" width="' + W + '" height="' + f1(h0) + '"/></clipPath>' +
      '<clipPath id="sm-below"><rect x="0" y="' + f1(h0) + '" width="' + W + '" height="' + f1(H - h0) + '"/></clipPath>' +
      '<clipPath id="sm-plot"><rect x="' + X0 + '" y="' + YT + '" width="' + (X1 - X0) + '" height="' + (YB - YT) + '" rx="8"/></clipPath></defs>';
    // twilight bands
    s += '<g clip-path="url(#sm-plot)">';
    s += '<rect x="0" y="0" width="' + W + '" height="' + f1(h0) + '" fill="url(#sm-skyg)"/>';
    [[0, -6, 'sm-b1'], [-6, -12, 'sm-b2'], [-12, -18, 'sm-b3'], [-18, -90, 'sm-b4']].forEach(function (b) {
      var a = y(b[0]), c = y(b[1]);
      if (c > a) s += '<rect class="' + b[2] + '" x="0" y="' + f1(a) + '" width="' + W + '" height="' + f1(c - a) + '"/>';
    });
    // hour grid
    for (var hh = 3; hh < 24; hh += 3) {
      var gx = x(R.start + hh * HOUR);
      s += '<line class="sm-grid" x1="' + f1(gx) + '" y1="' + YT + '" x2="' + f1(gx) + '" y2="' + YB + '"/>';
    }
    // moon path (dashed) + sun path (warm above the horizon, muted below)
    var mp = R.mpath.map(function (p) { return f1(x(p.t)) + ' ' + f1(y(p.v)); }).join('L');
    s += '<path class="sm-mpath" d="M' + mp + '"/>';
    var sp = smp.map(function (p) { return f1(x(p.t)) + ' ' + f1(y(p.v)); }).join('L');
    s += '<path class="sm-spath lo" d="M' + sp + '" clip-path="url(#sm-below)"/>';
    s += '<path class="sm-spath" d="M' + sp + '" clip-path="url(#sm-above)"/>';
    s += '<line class="sm-horizon" x1="' + X0 + '" y1="' + f1(h0) + '" x2="' + X1 + '" y2="' + f1(h0) + '"/>';
    // solar noon
    if (R.sun.solarNoon >= R.start && R.sun.solarNoon < R.end) {
      var nx = x(R.sun.solarNoon), ny = y(R.sun.noonAltitude);
      s += '<circle class="sm-noon" cx="' + f1(nx) + '" cy="' + f1(ny) + '" r="2.6"/>' +
        '<text class="sm-lbl" x="' + f1(nx) + '" y="' + f1(Math.max(YT + 9, ny - 7)) + '" text-anchor="middle">' + deg1(R.sun.noonAltitude) + '</text>';
    }
    // now
    if (R.isToday) {
      var cx = x(R.now), cy = y(R.sunNow.altitude), my = y(R.moonNow.altitude);
      s += '<line class="sm-nowline" x1="' + f1(cx) + '" y1="' + YT + '" x2="' + f1(cx) + '" y2="' + YB + '"/>';
      if (R.moonNow.altitude > yMin) s += '<circle class="sm-moondot" cx="' + f1(cx) + '" cy="' + f1(my) + '" r="4"/>';
      s += '<circle class="sm-sunglow" cx="' + f1(cx) + '" cy="' + f1(cy) + '" r="11"/><circle class="sm-sundot' + (R.sunNow.altitude < 0 ? ' below' : '') + '" cx="' + f1(cx) + '" cy="' + f1(cy) + '" r="6"/>';
    }
    s += '</g>';
    // hour labels (actual local hours, so DST days stay honest)
    for (var k = 0; k <= 24; k += 6) {
      var t = Math.min(R.end, R.start + k * HOUR), lx = x(t);
      s += '<text class="sm-tick" x="' + f1(Math.max(X0 + 12, Math.min(X1 - 12, lx))) + '" y="' + (H - 14) + '" text-anchor="middle">' +
        esc(fmt(t, R.tz, 'h', { hour: 'numeric' })) + '</text>';
    }
    s += '<text class="sm-legend" x="' + X0 + '" y="' + (H - 1) + '"><tspan class="sm-lg-s">\u2014</tspan> Sun  <tspan class="sm-lg-m">- -</tspan> Moon  \u00b7  bands: civil / nautical / astronomical twilight</text>';
    return s + '</svg>';
  }

  // Lit fraction + terminator: limb half-circle on the lit side, back along
  // a half-ellipse of x-radius r·|1−2k| (bulging to the lit side for a
  // crescent, the dark side for a gibbous moon). Southern hemisphere mirrors.
  function moonDisc(k, waxing, south) {
    var r = 44, cx = 50, cy = 50, litRight = waxing !== south;
    var rx = f1(r * Math.abs(1 - 2 * k));
    var limb = litRight ? 1 : 0;
    var term = k < 0.5 ? (litRight ? 0 : 1) : (litRight ? 1 : 0);
    var lit = 'M' + cx + ' ' + (cy - r) + 'A' + r + ' ' + r + ' 0 0 ' + limb + ' ' + cx + ' ' + (cy + r) +
      'A' + rx + ' ' + r + ' 0 0 ' + term + ' ' + cx + ' ' + (cy - r) + 'Z';
    var craters = [[38, 34, 9], [62, 44, 6], [44, 62, 7], [66, 66, 4.5], [30, 52, 4], [55, 26, 3.5], [72, 30, 3]];
    var cr = craters.map(function (c) { return '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="' + c[2] + '"/>'; }).join('');
    return '<svg class="sm-moon" viewBox="0 0 100 100" role="img" aria-label="Moon ' + Math.round(k * 100) + '% illuminated">' +
      '<defs><radialGradient id="sm-mlit" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#fbf8ee"/><stop offset="1" stop-color="#d8cfb6"/></radialGradient>' +
      '<radialGradient id="sm-mglow"><stop offset="0.6" stop-color="#fff6d8" stop-opacity="' + (0.05 + 0.3 * k).toFixed(2) + '"/><stop offset="1" stop-color="#fff6d8" stop-opacity="0"/></radialGradient>' +
      '<clipPath id="sm-mclip"><circle cx="50" cy="50" r="' + r + '"/></clipPath></defs>' +
      '<circle cx="50" cy="50" r="50" fill="url(#sm-mglow)"/>' +
      '<circle class="sm-mdark" cx="50" cy="50" r="' + r + '"/>' +
      (k > 0.003 ? '<path d="' + lit + '" fill="url(#sm-mlit)"/>' : '') +
      '<g class="sm-craters" clip-path="url(#sm-mclip)">' + cr + '</g>' +
      '<circle class="sm-mrim" cx="50" cy="50" r="' + r + '"/></svg>';
  }

  // ---- rendering ---------------------------------------------------------------------
  function cell(label, value, sub, cls) {
    return '<div class="sm-cell' + (cls ? ' ' + cls : '') + '"><div class="sm-cl">' + label + '</div><div class="sm-cv">' + value + '</div>' +
      (sub ? '<div class="sm-cs">' + sub + '</div>' : '') + '</div>';
  }
  function win(a, b, tz, next) {
    if (a == null && b == null) return '\u2014';
    return hm(a, tz) + ' \u2013 ' + hm(b, tz) + (next ? '<sup>+1</sup>' : '');
  }
  // An evening crossing that falls after local midnight gets a "+1".
  function pmT(lv, tz) { return hm(lv.pm, tz) + (lv.pmNextDay ? '<sup>+1</sup>' : ''); }

  function render() {
    var p = panel(); if (!p || !S) return;
    p.querySelector('.sm-pname').textContent = S.loc ? S.loc.name : 'Choose a place';
    p.querySelector('.sm-psub').textContent = S.loc ? (geo().sublabel(S.loc) || (S.loc.lat.toFixed(2) + ', ' + S.loc.lon.toFixed(2))) : '';
    var main = p.querySelector('.sm-main');
    var foot = p.querySelector('.sm-tz');
    if (!S.loc) {
      p.querySelector('.sm-date').textContent = '';
      main.innerHTML = '<div class="sm-empty"><div class="sm-empty-art">' + moonDisc(0.62, true, false) + '</div>' +
        '<div class="sm-empty-t">Pick a place</div><div class="sm-empty-s">Everything is calculated on this device \u2014 works offline once loaded.</div>' +
        '<div class="sm-empty-pick"></div></div>';
      mountPicker(main.querySelector('.sm-empty-pick'), false);
      foot.textContent = '';
      setActs(false);
      return;
    }
    var R = S.R = compute(), tz = R.tz, sd = R.sun, L = sd.levels;
    var dateLbl = fmt(R.start + 12 * HOUR, tz, 'date', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    p.querySelector('.sm-date').textContent = dateLbl;
    p.querySelector('.sm-today').hidden = sameYMD(S.ymd, todayYMD(tz));
    var di = p.querySelector('.sm-dinput'); if (di) di.value = ymdStr(S.ymd);

    // headline numbers
    var riseTxt, setTxt;
    if (sd.polarDay) { riseTxt = 'Up all day'; setTxt = 'Midnight sun'; }
    else if (sd.polarNight) { riseTxt = 'Below horizon'; setTxt = 'Polar night'; }
    else { riseTxt = hm(sd.sunrise, tz); setTxt = hm(sd.sunset, tz) + (sd.sunsetNextDay ? '<sup>+1</sup>' : ''); }
    var len = sd.dayLength, dl = len - R.prevLen;
    var nowLine = R.isToday
      ? 'Now: sun ' + deg1(R.sunNow.altitude) + ' high, ' + Math.round(R.sunNow.azimuth) + '\u00b0 ' + dirName(R.sunNow.azimuth)
      : 'At solar noon: ' + deg1(sd.noonAltitude) + ' high';
    var sunHTML = '<section class="sm-card">' +
      '<div class="sm-h"><span>\u2600 Sun</span><span class="sm-h-r">' + esc(nowLine) + '</span></div>' +
      '<div class="sm-hero">' +
        '<div class="sm-ev"><span class="sm-ev-l">Sunrise</span><span class="sm-ev-v">' + riseTxt + '</span><span class="sm-ev-s">' + (sd.sunrise != null ? 'Azimuth ' + Math.round(A().sunPosition(sd.sunrise, S.loc.lat, S.loc.lon).azimuth) + '\u00b0' : '') + '</span></div>' +
        '<div class="sm-ev mid"><span class="sm-ev-l">Daylight</span><span class="sm-ev-v">' + dur(len) + '</span><span class="sm-ev-s ' + (dl < 0 ? 'neg' : 'pos') + '">' + deltaStr(dl) + '</span></div>' +
        '<div class="sm-ev end"><span class="sm-ev-l">Sunset</span><span class="sm-ev-v">' + setTxt + '</span><span class="sm-ev-s">' + (sd.sunset != null ? 'Azimuth ' + Math.round(A().sunPosition(sd.sunset, S.loc.lat, S.loc.lon).azimuth) + '\u00b0' : '') + '</span></div>' +
      '</div>' +
      dayChart(R) +
      '<div class="sm-grid4">' +
        cell('Solar noon', hm(sd.solarNoon, tz), deg1(sd.noonAltitude) + ' altitude') +
        cell('Golden hour', win(L.blue.am, L.golden.am, tz), 'evening ' + win(L.golden.pm, L.blue.pm, tz, L.blue.pmNextDay), 'gold') +
        cell('Blue hour', win(L.civil.am, L.blue.am, tz), 'evening ' + win(L.blue.pm, L.civil.pm, tz, L.civil.pmNextDay), 'blue') +
        cell('Sun now', R.isToday ? deg1(R.sunNow.altitude) : '\u2014', R.isToday ? 'azimuth ' + Math.round(R.sunNow.azimuth) + '\u00b0 ' + dirName(R.sunNow.azimuth) : 'pick today for live position') +
      '</div>' +
      '<table class="sm-tw"><thead><tr><th>Twilight</th><th>Dawn</th><th>Dusk</th></tr></thead><tbody>' +
        '<tr><td><i class="sm-sw b1"></i>Civil <small>\u22126\u00b0</small></td><td>' + hm(L.civil.am, tz) + '</td><td>' + pmT(L.civil, tz) + '</td></tr>' +
        '<tr><td><i class="sm-sw b2"></i>Nautical <small>\u221212\u00b0</small></td><td>' + hm(L.nautical.am, tz) + '</td><td>' + pmT(L.nautical, tz) + '</td></tr>' +
        '<tr><td><i class="sm-sw b3"></i>Astronomical <small>\u221218\u00b0</small></td><td>' + hm(L.astro.am, tz) + '</td><td>' + pmT(L.astro, tz) + '</td></tr>' +
      '</tbody></table>' +
      (L.astro.am == null && L.astro.pm == null && !sd.polarNight ? '<div class="sm-note">No astronomical night: the sun never gets 18\u00b0 below the horizon.</div>' : '') +
    '</section>';

    // moon
    var il = R.illum, south = S.loc.lat < 0, md = R.moon;
    var mr = md.alwaysUp ? 'Up all day' : md.alwaysDown ? 'Down all day' : hm(md.rise, tz);
    var ms = md.alwaysUp ? '\u2014' : md.alwaysDown ? '\u2014' : hm(md.set, tz);
    var fullDays = (R.phases.nextFull - R.ref) / DAY, newDays = (R.phases.nextNew - R.ref) / DAY;
    var when = function (t) { return fmt(t, tz, 'mdhm', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
    var inDays = function (d) { return d < 1 ? 'in ' + Math.max(1, Math.round(d * 24)) + ' h' : 'in ' + Math.round(d) + ' day' + (Math.round(d) === 1 ? '' : 's'); };
    var moonHTML = '<section class="sm-card">' +
      '<div class="sm-h"><span>\u263e Moon</span><span class="sm-h-r">' + (R.isToday ? 'Now: ' + deg1(R.moonNow.altitude) + ' \u00b7 ' + Math.round(R.moonNow.azimuth) + '\u00b0 ' + dirName(R.moonNow.azimuth) : 'At solar noon') + '</span></div>' +
      '<div class="sm-moonrow">' + moonDisc(il.fraction, il.waxing, south) +
        '<div class="sm-moontxt"><div class="sm-phase">' + esc(R.phaseName) + '</div>' +
        '<div class="sm-ill"><b>' + Math.round(il.fraction * 100) + '%</b> illuminated \u00b7 ' + (il.waxing ? 'waxing' : 'waning') + '</div>' +
        '<div class="sm-ill">Age <b>' + R.age.toFixed(1) + '</b> days \u00b7 ' + Math.round(il.distance).toLocaleString() + ' km away</div></div>' +
      '</div>' +
      '<div class="sm-grid4">' +
        cell('Moonrise', mr, md.rise != null ? 'azimuth ' + Math.round(A().moonPosition(md.rise, S.loc.lat, S.loc.lon).azimuth) + '\u00b0' : '') +
        cell('Moonset', ms, md.set != null ? 'azimuth ' + Math.round(A().moonPosition(md.set, S.loc.lat, S.loc.lon).azimuth) + '\u00b0' : '') +
        cell('\ud83c\udf15 Next full moon', esc(when(R.phases.nextFull)), inDays(fullDays)) +
        cell('\ud83c\udf11 Next new moon', esc(when(R.phases.nextNew)), inDays(newDays)) +
      '</div>' +
    '</section>';

    main.innerHTML = sunHTML + moonHTML;
    var tzNote = tz + ' (' + (A().tzOffset(R.start + 12 * HOUR, tz) >= 0 ? 'UTC+' : 'UTC\u2212') + offStr(Math.abs(A().tzOffset(R.start + 12 * HOUR, tz))) + ')';
    foot.textContent = 'Times in ' + tzNote + (S.loc.tz ? '' : ' \u00b7 device zone');
    foot.title = S.loc.lat.toFixed(4) + ', ' + S.loc.lon.toFixed(4);
    setActs(true);
  }
  function offStr(min) { var h = Math.floor(min / 60), m = min % 60; return h + (m ? ':' + (m < 10 ? '0' : '') + m : ''); }
  function setActs(on) {
    var p = panel(); if (!p) return;
    p.querySelector('.sm-insert').disabled = !on;
    p.querySelector('.sm-copy').disabled = !on;
  }

  // ---- summary -----------------------------------------------------------------------
  function summary() {
    if (!S || !S.loc || !S.R) return '';
    var R = S.R, tz = R.tz, sd = R.sun, out;
    if (sd.polarDay) out = '\u2600\ufe0f Midnight sun (up all day)';
    else if (sd.polarNight) out = '\ud83c\udf11 Polar night (sun stays down)';
    else out = '\u2600\ufe0f Sunrise ' + hm(sd.sunrise, tz) + ' \u00b7 Sunset ' + hm(sd.sunset, tz) + (sd.sunsetNextDay ? ' (+1)' : '');
    var dl = sd.dayLength - R.prevLen, s = Math.round(Math.abs(dl) / 1000);
    out += ' \u00b7 Day ' + dur(sd.dayLength) + (s >= 1 ? ' (' + (dl < 0 ? '\u2212' : '+') + (s >= 60 ? Math.floor(s / 60) + 'm ' : '') + (s % 60) + 's)' : '');
    out += ' \u00b7 ' + (PHASE_EMOJI[R.phaseName] || '\ud83c\udf19') + ' ' + R.phaseName + ' ' + Math.round(R.illum.fraction * 100) + '%';
    out += ' \u2014 ' + fmt(R.start + 12 * HOUR, tz, 'md', { month: 'short', day: 'numeric' }) + ', ' + S.loc.name;
    return out;
  }
  function copyText(text) {
    var done = function () { Cade.showToast('Copied sun & moon summary', 'success', 1400); };
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
    if (ed.state.readOnly) { Cade.showToast('Read-only mode \u2014 editing is locked', 'error', 2000); return; }
    ed.dispatch(ed.state.replaceSelection(text), { userEvent: 'input', scrollIntoView: true });
    Cade.showToast('Inserted sun & moon summary', 'success', 1200);
  }

  // ---- location sheet -----------------------------------------------------------------
  function setLoc(loc) {
    var wasToday = !S.loc || sameYMD(S.ymd, todayYMD(tzOf(S.loc)));
    S.loc = loc;
    if (wasToday) S.ymd = todayYMD(tzOf(loc)); // stay on "today" in the new zone
    render();
  }
  function mountPicker(host, inSheet) {
    if (S.picker) { S.picker.destroy(); S.picker = null; }
    S.picker = geo().picker({
      current: S.loc,
      onPick: function (loc) {
        var saved = geo().set(loc, 'sunmoon');
        closeSheet(true);
        setLoc(saved || loc);
      },
    });
    host.appendChild(S.picker.el);
    if (inSheet && !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) S.picker.focus();
  }
  function openSheet() {
    var p = panel(); if (!p) return;
    closeSheet();
    var sh = document.createElement('div');
    sh.className = 'sm-sheet';
    sh.innerHTML = '<div class="sm-sheet-h"><span>Location</span><button type="button" class="sm-ibtn sm-sheet-x" aria-label="Close">\u2715</button></div><div class="sm-sheet-b"></div>';
    p.querySelector('.cade-panel-body').appendChild(sh);
    mountPicker(sh.querySelector('.sm-sheet-b'), true);
    sh.querySelector('.sm-sheet-x').addEventListener('click', function () { closeSheet(); });
    requestAnimationFrame(function () { sh.classList.add('in'); });
  }
  function closeSheet(picked) {
    var p = panel(); if (!p) return false;
    var sh = p.querySelector('.sm-sheet');
    if (!sh) return false;
    var hadPicker = S && S.picker && sh.contains(S.picker.el);
    if (hadPicker) { S.picker.destroy(); S.picker = null; }
    sh.remove();
    if (hadPicker && !picked && S && !S.loc) render(); // the empty state's own picker was replaced — rebuild it
    return true;
  }

  // ---- open / close ---------------------------------------------------------------------
  function close() {
    var p = panel();
    if (p) { p.remove(); if (p._onClose) p._onClose(); }
  }
  function step(days) {
    if (!S || !S.loc) return;
    S.ymd = shiftYMD(S.ymd, days);
    render();
  }

  function open() {
    Cade.closeAllMenus();
    if (panel()) { close(); return; }
    var p = Cade.mkPanel(PANEL_ID, '\u263c Sun & Moon',
      '<div class="sm-top">' +
        '<button class="sm-place" type="button" title="Change location"><span class="sm-pin" aria-hidden="true">\u2316</span>' +
          '<span class="sm-ptxt"><span class="sm-pname">Loading\u2026</span><span class="sm-psub"></span></span><span class="sm-caret" aria-hidden="true">\u25be</span></button>' +
      '</div>' +
      '<div class="sm-datebar">' +
        '<button class="sm-ibtn sm-prev" type="button" title="Previous day (\u2190)" aria-label="Previous day">\u2039</button>' +
        '<label class="sm-datewrap" title="Pick a date"><span class="sm-date"></span><input class="sm-dinput" type="date" aria-label="Pick a date"></label>' +
        '<button class="sm-ibtn sm-next" type="button" title="Next day (\u2192)" aria-label="Next day">\u203a</button>' +
        '<button class="sm-chip sm-today" type="button" hidden>Today</button>' +
      '</div>' +
      '<div class="sm-scroll"><div class="sm-main"><div class="sm-loading">Calculating\u2026</div></div></div>' +
      '<div class="sm-foot">' +
        '<button class="sm-btn primary sm-insert" type="button" title="Insert a one-line summary at the cursor" disabled>\u21b5 Insert summary</button>' +
        '<button class="sm-btn sm-copy" type="button" disabled>\u29c9 Copy</button>' +
        '<span class="sm-tz"></span>' +
      '</div>');
    S = { loc: null, ymd: null, picker: null, R: null };
    var st = S;

    p.addEventListener('click', function (e) {
      var t = e.target; if (!t.closest || !A() || !geo()) return;
      if (t.closest('.sm-place')) openSheet();
      else if (t.closest('.sm-prev')) step(-1);
      else if (t.closest('.sm-next')) step(1);
      else if (t.closest('.sm-today')) { if (S.loc) { S.ymd = todayYMD(tzOf(S.loc)); render(); } }
      else if (t.closest('.sm-insert')) insert(summary());
      else if (t.closest('.sm-copy')) { var s = summary(); if (s) copyText(s); }
    });
    var dinput = p.querySelector('.sm-dinput');
    // Desktop browsers only open the calendar from its icon; ask for it directly.
    dinput.addEventListener('click', function () {
      if (typeof dinput.showPicker === 'function') { try { dinput.showPicker(); } catch (e) {} }
    });
    dinput.addEventListener('change', function () {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dinput.value);
      if (m && S.loc) { S.ymd = { y: +m[1], m: +m[2], d: +m[3] }; render(); }
    });
    p.addEventListener('keydown', function (e) {
      var inField = e.target && (e.target.tagName === 'INPUT');
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!closeSheet()) close(); return; }
      if (!inField && !p.querySelector('.sm-sheet')) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        else if (e.key === 't' || e.key === 'T') { if (S.loc) { S.ymd = todayYMD(tzOf(S.loc)); render(); } }
      }
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    });
    var onGeo = function (e) {
      var d = e.detail || {};
      if (S !== st || d.from === 'sunmoon' || !d.loc || !geo()) return;
      if (S.loc && geo().same(S.loc, d.loc)) return;
      setLoc(d.loc);
    };
    window.addEventListener('cade-geo-change', onGeo);
    // Keep the "now" marker and live numbers moving while showing today.
    var tick = setInterval(function () {
      if (S !== st || !panel() || !S.loc || !S.R || document.visibilityState === 'hidden') return;
      if (S.R.isToday || (Date.now() >= S.R.start && Date.now() < S.R.end)) {
        if (!p.querySelector('.sm-sheet')) { var sc = p.querySelector('.sm-scroll'), top = sc.scrollTop; render(); sc.scrollTop = top; }
      }
    }, 60000);
    p._onClose = function () {
      clearInterval(tick);
      window.removeEventListener('cade-geo-change', onGeo);
      if (st.picker) { st.picker.destroy(); st.picker = null; }
      if (S === st) S = null;
    };

    loadDeps().then(function () {
      if (S !== st || !panel()) return;
      S.loc = geo().get();
      if (S.loc) S.ymd = todayYMD(tzOf(S.loc));
      render();
    }, function (e) {
      if (S !== st) return;
      p.querySelector('.sm-main').innerHTML = '<div class="sm-empty"><div class="sm-empty-t">Couldn\u2019t start</div><div class="sm-empty-s">' + esc(e.message) + '</div></div>';
    });
  }

  Cade.registerWidget({
    name: 'Sun & Moon',
    description: 'Sunrise, sunset, twilight, golden hour, moon phase & moonrise \u2014 offline',
    icon: '\u263c',
    tags: 'sun,moon,sunrise,sunset,twilight,dawn,dusk,golden hour,blue hour,moon phase,full moon,new moon,moonrise,daylight,astronomy',
    open: open,
    _test: { moonDisc: moonDisc, dayChart: dayChart, setState: function (s) { S = s; }, compute: function () { return compute(); }, summary: summary },
  });
})();
