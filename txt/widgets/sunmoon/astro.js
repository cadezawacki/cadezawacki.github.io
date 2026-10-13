/* Sun & Moon — offline astronomy for the sunmoon widget (no network, no deps).
 *
 * Accuracy target: event times within ~1 minute (sun) / ~2 minutes (moon) of
 * high-precision ephemerides, which is far below what weather and terrain
 * change anyway. Verified in node against astronomy-engine (see widget notes).
 *
 *  - Sun: Meeus, "Astronomical Algorithms" ch. 25 low-precision series
 *    (apparent longitude of date) + GMST of date, so frames are consistent.
 *  - Moon: Meeus ch. 47 main periodic terms (18 longitude, 8 latitude,
 *    13 distance) — ~0.02° — instead of the single-term SunCalc model.
 *  - Rise/set/twilight: altitude is sampled across the LOCAL day (in the
 *    place's time zone, so DST days of 23/25 h just work) and every crossing
 *    of a threshold is refined by bisection. Polar day/night simply means
 *    "no crossing" — no special-casing of acos domains.
 *  - New/full moon instants: Meeus ch. 49 with all periodic + planetary
 *    corrections (seconds-level accuracy).
 *
 * API design follows SunCalc (c) 2011-2015 Vladimir Agafonkin, BSD-2-Clause,
 * https://github.com/mourner/suncalc — whose notice is reproduced here:
 *   Redistribution and use in source and binary forms, with or without
 *   modification, are permitted provided that the following conditions are met:
 *   1. Redistributions of source code must retain the above copyright notice,
 *      this list of conditions and the following disclaimer.
 *   2. Redistributions in binary form must reproduce the above copyright notice,
 *      this list of conditions and the following disclaimer in the documentation
 *      and/or other materials provided with the distribution.
 *   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 *   AND ANY EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED.
 *
 * Exposes window.__cadeAstro (browser) / module.exports (node tests). */
(function (root) {
  'use strict';
  var PI = Math.PI, RAD = PI / 180, DAY = 86400000;
  var J1970 = 2440587.5, J2000 = 2451545.0;
  var sin = Math.sin, cos = Math.cos, tan = Math.tan, asin = Math.asin, atan2 = Math.atan2;
  var AU_KM = 149597870.7, EARTH_R = 6378.14;

  function jdOf(ms) { return ms / DAY + J1970; }
  function msOf(jd) { return (jd - J1970) * DAY; }
  function n360(x) { x %= 360; return x < 0 ? x + 360 : x; }
  function nPi(x) { x %= 2 * PI; if (x > PI) x -= 2 * PI; else if (x < -PI) x += 2 * PI; return x; }
  function clamp1(x) { return x > 1 ? 1 : x < -1 ? -1 : x; }

  // ---- coordinates -------------------------------------------------------
  // d = days since J2000.0. UT is used for d (TT−UT ≈ 69 s moves the moon by
  // ~0.01°, invisible at minute precision).
  function sunEcl(d) {
    var T = d / 36525;
    var L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    var M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * RAD;
    var C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M) +
      (0.019993 - 0.000101 * T) * sin(2 * M) + 0.000289 * sin(3 * M);
    var e = 0.016708634 - 0.000042037 * T;
    var v = M + C * RAD;
    var R = 1.000001018 * (1 - e * e) / (1 + e * cos(v));
    var om = (125.04 - 1934.136 * T) * RAD;
    var lon = (L0 + C - 0.00569 - 0.00478 * sin(om)) * RAD;
    return { lon: n360(lon / RAD) * RAD, lat: 0, dist: R * AU_KM, om: om, T: T };
  }

  function obliquity(T, om) { return (23.439291 - 0.0130042 * T + 0.00256 * cos(om)) * RAD; }

  function toEquatorial(lon, lat, eps) {
    return {
      ra: atan2(sin(lon) * cos(eps) - tan(lat) * sin(eps), cos(lon)),
      dec: asin(clamp1(sin(lat) * cos(eps) + cos(lat) * sin(eps) * sin(lon))),
    };
  }

  // Meeus table 47.A/B, terms with amplitude ≥ 0.01° (lon/lat) or ≥ 48 km.
  // [D, M, M', F, coefficient]
  var MOON_LON = [
    [0, 0, 1, 0, 6.288774], [2, 0, -1, 0, 1.274027], [2, 0, 0, 0, 0.658314], [0, 0, 2, 0, 0.213618],
    [0, 1, 0, 0, -0.185116], [0, 0, 0, 2, -0.114332], [2, 0, -2, 0, 0.058793], [2, -1, -1, 0, 0.057066],
    [2, 0, 1, 0, 0.053322], [2, -1, 0, 0, 0.045758], [0, 1, -1, 0, -0.040923], [1, 0, 0, 0, -0.034720],
    [0, 1, 1, 0, -0.030383], [2, 0, 0, -2, 0.015327], [0, 0, 1, 2, -0.012528], [0, 0, 1, -2, 0.010980],
    [4, 0, -1, 0, 0.010675], [0, 0, 3, 0, 0.010034],
  ];
  var MOON_DIST = [
    [0, 0, 1, 0, -20905.355], [2, 0, -1, 0, -3699.111], [2, 0, 0, 0, -2955.968], [0, 0, 2, 0, -569.925],
    [0, 1, 0, 0, 48.888], [2, 0, -2, 0, 246.158], [2, -1, -1, 0, -152.138], [2, 0, 1, 0, -170.733],
    [2, -1, 0, 0, -204.586], [0, 1, -1, 0, -129.620], [1, 0, 0, 0, 108.743], [0, 1, 1, 0, 104.755],
    [2, 0, 0, -2, 10.321],
  ];
  var MOON_LAT = [
    [0, 0, 0, 1, 5.128122], [0, 0, 1, 1, 0.280602], [0, 0, 1, -1, 0.277693], [2, 0, 0, -1, 0.173237],
    [2, 0, -1, 1, 0.055413], [2, 0, -1, -1, 0.046271], [2, 0, 0, 1, 0.032573], [0, 0, 2, 1, 0.017198],
  ];

  function moonEcl(d) {
    var T = d / 36525;
    var Lp = 218.3164477 + 481267.88123421 * T;
    var D = (297.8501921 + 445267.1114034 * T) * RAD;
    var M = (357.5291092 + 35999.0502909 * T) * RAD;
    var Mp = (134.9633964 + 477198.8675055 * T) * RAD;
    var F = (93.2720950 + 483202.0175233 * T) * RAD;
    var E = 1 - 0.002516 * T - 0.0000074 * T * T;
    function sum(tab, fn) {
      var s = 0;
      for (var i = 0; i < tab.length; i++) {
        var t = tab[i], arg = t[0] * D + t[1] * M + t[2] * Mp + t[3] * F;
        var c = t[4];
        if (t[1] === 1 || t[1] === -1) c *= E; else if (t[1] === 2 || t[1] === -2) c *= E * E;
        s += c * fn(arg);
      }
      return s;
    }
    var lon = Lp + sum(MOON_LON, sin);
    var lat = sum(MOON_LAT, sin);
    var dist = 385000.56 + sum(MOON_DIST, cos);
    return { lon: n360(lon) * RAD, lat: lat * RAD, dist: dist, T: T };
  }

  function gmst(jdUT) {
    var d = jdUT - J2000, T = d / 36525;
    return n360(280.46061837 + 360.98564736629 * d + 0.000387933 * T * T) * RAD;
  }

  function horizontal(ms, lat, lon, eq) {
    var H = gmst(jdOf(ms)) + lon * RAD - eq.ra, phi = lat * RAD;
    var alt = asin(clamp1(sin(phi) * sin(eq.dec) + cos(phi) * cos(eq.dec) * cos(H)));
    var az = atan2(sin(H), cos(H) * sin(phi) - tan(eq.dec) * cos(phi)) + PI; // from north, clockwise
    return { alt: alt, az: az, H: nPi(H) };
  }

  function sunEq(ms) {
    var s = sunEcl(jdOf(ms) - J2000);
    var q = toEquatorial(s.lon, 0, obliquity(s.T, s.om));
    q.lon = s.lon; q.dist = s.dist;
    return q;
  }
  function moonEq(ms) {
    var m = moonEcl(jdOf(ms) - J2000);
    var om = (125.04 - 1934.136 * m.T) * RAD;
    var q = toEquatorial(m.lon, m.lat, obliquity(m.T, om));
    q.lon = m.lon; q.lat = m.lat; q.dist = m.dist;
    return q;
  }

  // Standard refraction (Bennett), degrees in/out; for display only.
  function refraction(hDeg) {
    if (hDeg < -1.9) return 0;
    return 1.02 / Math.tan((hDeg + 10.3 / (hDeg + 5.11)) * RAD) / 60;
  }

  function sunPosition(ms, lat, lon) {
    var h = horizontal(ms, lat, lon, sunEq(ms));
    return { altitude: h.alt / RAD, azimuth: n360(h.az / RAD), hourAngle: h.H };
  }

  function moonPosition(ms, lat, lon) {
    var q = moonEq(ms), h = horizontal(ms, lat, lon, q);
    var par = asin(EARTH_R / q.dist); // horizontal parallax
    var geo = h.alt / RAD;
    var topo = geo - asin(sin(par) * cos(h.alt)) / RAD;
    var phi = lat * RAD;
    var pa = atan2(sin(h.H), tan(phi) * cos(q.dec) - sin(q.dec) * cos(h.H)); // parallactic angle (Meeus 14.1)
    return {
      altitude: topo, geoAltitude: geo, apparentAltitude: topo + refraction(topo),
      azimuth: n360(h.az / RAD), distance: q.dist, parallax: par / RAD, parallacticAngle: pa,
    };
  }

  // ---- moon illumination -----------------------------------------------------
  function moonIllumination(ms) {
    var s = sunEq(ms), m = moonEq(ms);
    var psi = Math.acos(clamp1(sin(s.dec) * sin(m.dec) + cos(s.dec) * cos(m.dec) * cos(s.ra - m.ra)));
    var inc = atan2(s.dist * sin(psi), m.dist - s.dist * cos(psi));
    var elong = n360((m.lon - s.lon) / RAD); // 0 new → 180 full → 360
    var chi = atan2(cos(s.dec) * sin(s.ra - m.ra),
      sin(s.dec) * cos(m.dec) - cos(s.dec) * sin(m.dec) * cos(s.ra - m.ra));
    return {
      fraction: (1 + cos(inc)) / 2,
      phase: elong / 360,          // 0..1 through the cycle (by elongation)
      waxing: elong < 180,
      angle: chi,                  // position angle of the bright limb (rad, from north via east)
      distance: m.dist,
    };
  }

  // ---- Meeus ch. 49: true instants of new (q=0) / full (q=0.5) moon --------
  function phaseJDE(k, full) {
    var T = k / 1236.85, T2 = T * T, T3 = T2 * T, T4 = T3 * T;
    var jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.000000150 * T3 + 0.00000000073 * T4;
    var E = 1 - 0.002516 * T - 0.0000074 * T2;
    var M = (2.5534 + 29.10535670 * k - 0.0000014 * T2 - 0.00000011 * T3) * RAD;
    var Mp = (201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4) * RAD;
    var F = (160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4) * RAD;
    var Om = (124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3) * RAD;
    var c = full
      ? [-0.40614, 0.17302, 0.01614, 0.01043, 0.00734, -0.00515, 0.00209]
      : [-0.40720, 0.17241, 0.01608, 0.01039, 0.00739, -0.00514, 0.00208];
    var corr = c[0] * sin(Mp) + c[1] * E * sin(M) + c[2] * sin(2 * Mp) + c[3] * sin(2 * F) +
      c[4] * E * sin(Mp - M) + c[5] * E * sin(Mp + M) + c[6] * E * E * sin(2 * M) -
      0.00111 * sin(Mp - 2 * F) - 0.00057 * sin(Mp + 2 * F) + 0.00056 * E * sin(2 * Mp + M) -
      0.00042 * sin(3 * Mp) + 0.00042 * E * sin(M + 2 * F) + 0.00038 * E * sin(M - 2 * F) -
      0.00024 * E * sin(2 * Mp - M) - 0.00017 * sin(Om) - 0.00007 * sin(Mp + 2 * M) +
      0.00004 * sin(2 * Mp - 2 * F) + 0.00004 * sin(3 * M) + 0.00003 * sin(Mp + M - 2 * F) +
      0.00003 * sin(2 * Mp + 2 * F) - 0.00003 * sin(Mp + M + 2 * F) + 0.00003 * sin(Mp - M + 2 * F) -
      0.00002 * sin(Mp - M - 2 * F) - 0.00002 * sin(3 * Mp + M) + 0.00002 * sin(4 * Mp);
    var A = [
      299.77 + 0.107408 * k - 0.009173 * T2, 251.88 + 0.016321 * k, 251.83 + 26.651886 * k,
      349.42 + 36.412478 * k, 84.66 + 18.206239 * k, 141.74 + 53.303771 * k, 207.14 + 2.453732 * k,
      154.84 + 7.306860 * k, 34.52 + 27.261239 * k, 207.19 + 0.121824 * k, 291.34 + 1.844379 * k,
      161.72 + 24.198154 * k, 239.56 + 25.513099 * k, 331.55 + 3.592518 * k,
    ];
    var Ac = [0.000325, 0.000165, 0.000164, 0.000126, 0.000110, 0.000062, 0.000060, 0.000056,
      0.000047, 0.000042, 0.000040, 0.000037, 0.000035, 0.000023];
    var add = 0;
    for (var i = 0; i < 14; i++) add += Ac[i] * sin(A[i] * RAD);
    return jde + corr + add;
  }

  // TT − UT in seconds (Espenak & Meeus polynomial, fine for 1986–2150).
  function deltaT(year) {
    var t;
    if (year < 2005) { t = year - 2000; return 63.86 + 0.3345 * t - 0.060374 * t * t + 0.0017275 * t * t * t; }
    if (year < 2050) { t = year - 2000; return 62.92 + 0.32217 * t + 0.005589 * t * t; }
    t = (year - 1820) / 100; return -20 + 32 * t * t - 0.5628 * (2150 - year);
  }
  function phaseMs(k, full) {
    var jde = phaseJDE(full ? k + 0.5 : k, full);
    var year = 2000 + (jde - J2000) / 365.25;
    return msOf(jde - deltaT(year) / 86400);
  }
  // The k (integer) of the new moon at or before ms.
  function lunationIndex(ms) {
    var year = 1970 + ms / (365.2425 * DAY);
    var k = Math.floor((year - 2000) * 12.3685) + 1;
    while (phaseMs(k, false) > ms) k--;
    while (phaseMs(k + 1, false) <= ms) k++;
    return k;
  }
  // { prevNew, nextNew, nextFull, prevFull } as ms timestamps.
  function moonPhases(ms) {
    var k = lunationIndex(ms);
    var full = phaseMs(k, true);
    return {
      prevNew: phaseMs(k, false),
      nextNew: phaseMs(k + 1, false),
      nextFull: full > ms ? full : phaseMs(k + 1, true),
      prevFull: full <= ms ? full : phaseMs(k - 1, true),
    };
  }

  function phaseName(p) {
    var w = 1 / 29.53; // ≈ one day either side of the principal phases
    if (p < w || p > 1 - w) return 'New Moon';
    if (Math.abs(p - 0.25) < w) return 'First Quarter';
    if (Math.abs(p - 0.5) < w) return 'Full Moon';
    if (Math.abs(p - 0.75) < w) return 'Last Quarter';
    if (p < 0.25) return 'Waxing Crescent';
    if (p < 0.5) return 'Waxing Gibbous';
    if (p < 0.75) return 'Waning Gibbous';
    return 'Waning Crescent';
  }

  // ---- root finding over a day ---------------------------------------------
  // Sample g(t) every stepMs over [t0, t1]; every sign change is refined by
  // bisection to ~1 s. Returns [{ t, up }] where up = g goes − → +.
  function crossings(samples, g, level) {
    var out = [];
    for (var i = 1; i < samples.length; i++) {
      var a = samples[i - 1], b = samples[i];
      var fa = a.v - level, fb = b.v - level;
      if ((fa < 0) !== (fb < 0)) {
        var lo = a.t, hi = b.t, flo = fa;
        for (var k = 0; k < 22 && hi - lo > 800; k++) {
          var mid = (lo + hi) / 2, fm = g(mid) - level;
          if ((flo < 0) === (fm < 0)) { lo = mid; flo = fm; } else hi = mid;
        }
        out.push({ t: (lo + hi) / 2, up: fb > fa });
      }
    }
    return out;
  }
  function sample(g, t0, t1, stepMs) {
    var s = [];
    for (var t = t0; t < t1; t += stepMs) s.push({ t: t, v: g(t) });
    s.push({ t: t1, v: g(t1) });
    return s;
  }
  function firstOf(list, up) { for (var i = 0; i < list.length; i++) if (list[i].up === up) return list[i].t; return null; }
  function lastOf(list, up) { for (var i = list.length - 1; i >= 0; i--) if (list[i].up === up) return list[i].t; return null; }

  // Time spent above `level` within the sampled window (ms).
  function timeAbove(samples, list, level, t0, t1) {
    var total = 0, state = samples[0].v > level, from = t0;
    for (var i = 0; i < list.length; i++) {
      if (state) total += list[i].t - from;
      from = list[i].t; state = list[i].up;
    }
    if (state) total += t1 - from;
    return total;
  }

  // Thresholds (degrees of the sun's centre; −0.833 = standard refraction + semi-diameter).
  var SUN_LEVELS = { astro: -18, nautical: -12, civil: -6, blue: -4, rise: -0.833, golden: 6 };

  /* All sun events for the local day [t0, t1) (UTC ms of local midnights).
     Each pair is { am, pm } (rising / setting crossing) or null fields when
     the sun never crosses that level that day. */
  function sunDay(t0, t1, lat, lon) {
    var g = function (t) { return sunPosition(t, lat, lon).altitude; };
    // Sample 12 h past midnight so an evening event that slips past 00:00
    // (Reykjavik in June sets at 00:03) is still paired with its morning.
    var smp = sample(g, t0, t1 + 12 * 3600000, 15 * 60000);
    var day = smp.filter(function (p) { return p.t <= t1; });
    var res = { samples: day, levels: {} };
    for (var key in SUN_LEVELS) {
      var lv = SUN_LEVELS[key], cr = crossings(smp, g, lv);
      var inDay = cr.filter(function (c) { return c.t < t1; });
      var am = firstOf(inDay, true), pm = null;
      for (var j = 0; j < cr.length; j++) {
        if (!cr[j].up && (am == null ? cr[j].t < t1 : cr[j].t > am)) { pm = cr[j].t; break; }
      }
      res.levels[key] = { am: am, pm: pm, pmNextDay: pm != null && pm >= t1, list: inDay };
    }
    var rise = res.levels.rise;
    res.sunrise = rise.am; res.sunset = rise.pm; res.sunsetNextDay = rise.pmNextDay;
    res.dayLength = timeAbove(day, rise.list, SUN_LEVELS.rise, t0, t1);
    // Polar flags: never above / never below the horizon level today.
    var maxV = -99, minV = 99, maxT = t0;
    for (var i = 0; i < day.length; i++) {
      if (day[i].v > maxV) { maxV = day[i].v; maxT = day[i].t; }
      if (day[i].v < minV) minV = day[i].v;
    }
    res.polarDay = !rise.list.length && minV > SUN_LEVELS.rise;
    res.polarNight = !rise.list.length && maxV < SUN_LEVELS.rise;
    // Solar noon: hour angle 0 near the sampled maximum (Newton on H).
    var tn = maxT;
    for (var it = 0; it < 5; it++) {
      var H = sunPosition(tn, lat, lon).hourAngle;
      tn -= H / (2 * PI) * DAY / 1.0027379;
    }
    res.solarNoon = tn;
    res.noonAltitude = g(tn);
    return res;
  }

  // Moon rise/set within [t0, t1): geocentric altitude vs h0 = 0.7275·π − 0.5667°
  // (Meeus 15: parallax, refraction and semi-diameter at the horizon).
  function moonDay(t0, t1, lat, lon) {
    var g = function (t) {
      var p = moonPosition(t, lat, lon);
      return p.geoAltitude - (0.7275 * p.parallax - 0.5667);
    };
    var smp = sample(g, t0, t1, 20 * 60000);
    var cr = crossings(smp, g, 0);
    var above = 0, below = 0;
    for (var i = 0; i < smp.length; i++) { if (smp[i].v > 0) above++; else below++; }
    return {
      rise: firstOf(cr, true), set: firstOf(cr, false), list: cr,
      alwaysUp: !cr.length && !below, alwaysDown: !cr.length && !above,
    };
  }

  // ---- time zones ------------------------------------------------------------
  var _fmtCache = {};
  function partsFmt(tz) {
    if (_fmtCache[tz]) return _fmtCache[tz];
    _fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    return _fmtCache[tz];
  }
  function validTz(tz) {
    if (!tz || typeof tz !== 'string') return false;
    try { partsFmt(tz).format(0); return true; } catch (e) { delete _fmtCache[tz]; return false; }
  }
  var DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Wall-clock fields of `ms` in `tz`.
  function wall(ms, tz) {
    var p = partsFmt(tz).formatToParts(new Date(ms)), o = {};
    for (var i = 0; i < p.length; i++) o[p[i].type] = p[i].value;
    var h = +o.hour; if (h === 24) h = 0; // some engines print midnight as 24 with hour12:false
    return { y: +o.year, m: +o.month, d: +o.day, h: h, mi: +o.minute, s: +o.second, dow: DOW[o.weekday] };
  }
  // Minutes east of UTC for `tz` at instant `ms`.
  function tzOffset(ms, tz) {
    var w = wall(ms, tz);
    var asUTC = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
    return Math.round((asUTC - Math.floor(ms / 1000) * 1000) / 60000);
  }
  // UTC ms of local wall time y-m-d h:mi in tz (two passes settle DST edges).
  function zonedTime(y, m, d, h, mi, tz) {
    var guess = Date.UTC(y, m - 1, d, h || 0, mi || 0);
    var t = guess - tzOffset(guess, tz) * 60000;
    return guess - tzOffset(t, tz) * 60000;
  }
  // [start, end) of the local calendar day containing ms.
  function dayBounds(ms, tz) {
    var w = wall(ms, tz);
    var nx = new Date(Date.UTC(w.y, w.m - 1, w.d + 1));
    return {
      start: zonedTime(w.y, w.m, w.d, 0, 0, tz),
      end: zonedTime(nx.getUTCFullYear(), nx.getUTCMonth() + 1, nx.getUTCDate(), 0, 0, tz),
      y: w.y, m: w.m, d: w.d,
    };
  }

  var api = {
    sunPosition: sunPosition, moonPosition: moonPosition, moonIllumination: moonIllumination,
    moonPhases: moonPhases, phaseName: phaseName, sunDay: sunDay, moonDay: moonDay,
    SUN_LEVELS: SUN_LEVELS, refraction: refraction,
    validTz: validTz, wall: wall, tzOffset: tzOffset, zonedTime: zonedTime, dayBounds: dayBounds,
    _phaseJDE: phaseJDE,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.__cadeAstro = api;
})(typeof window !== 'undefined' ? window : null);
