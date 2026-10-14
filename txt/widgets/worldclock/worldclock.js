/* World Clock — your places at a glance, a meeting planner and a converter.
 *
 *   Clocks    your zone pinned first, then your places: local time (12/24 h),
 *             Today / Tomorrow / Yesterday, UTC offset, difference from you,
 *             DST (and a clock change coming up), and day / dawn / dusk /
 *             night from the sun's altitude (built-in cities carry
 *             approximate coordinates; bare IANA zones fall back to the clock).
 *   Planner   one bar per place across the 24 hours of YOUR day on the chosen
 *             date (DST-correct: 23 or 25 hours on change days), with working
 *             hours / awake / night / weekend shading, the hours when everyone
 *             is working, and a cursor you drag or tap (15-minute steps) →
 *             Insert / Copy "Tue 14 Oct · 09:00 New York · 14:00 London · …".
 *   Convert   "3pm London", "tomorrow 9:30 Tokyo", "noon PT", "15:00 UTC+5:30"
 *             — or pick a place, time and date — shown in every place.
 *
 * Every offset comes from Intl.DateTimeFormat(timeZone).formatToParts; none is
 * hard-coded. Places + settings live in Cade.syncedBlob('worldclock'), so they
 * follow you across devices (Cade.store fallback on an older core).
 *
 * Cost: nothing runs until the panel opens. While open, ONE timer re-renders
 * on the minute boundary (on the second only with "Show seconds" on the Clocks
 * tab); it stops while minimized, while the page is hidden and on close, when
 * the visibility listener goes and the city index is dropped.
 *
 * The DOM-free core (Core) is exported for node and unit-tested by
 * worldclock.test.js. Self-contained IIFE. */
(function () {
  'use strict';

  // ===========================================================================
  // Pure core — no DOM, no Cade.
  // ===========================================================================
  var Core = (function () {
    var MIN = 60000, HOUR = 3600000, DAY = 86400000, SLOT = 15 * MIN;
    var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var MINUS = '−';

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    // ---- zones & offsets -------------------------------------------------------
    // A zone is an IANA id ("Europe/London", "UTC") or a fixed offset "+05:30".
    var FIXED_RE = /^([+-])(\d{2}):(\d{2})$/;
    function fixedOff(z) {
      var m = FIXED_RE.exec(z || '');
      return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : null;
    }
    function fixedZone(off) {
      var a = Math.abs(off);
      return (off < 0 ? '-' : '+') + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
    }
    var dtfs = {};
    function dtf(z) {
      var f = dtfs[z];
      if (f === undefined) {
        try {
          f = new Intl.DateTimeFormat('en-US', { timeZone: z, hour12: false, year: 'numeric', month: 'numeric',
            day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
        } catch (e) { f = null; }
        dtfs[z] = f;
      }
      return f;
    }
    function validZone(z) { return typeof z === 'string' && z.length < 64 && (fixedOff(z) !== null || !!dtf(z)); }
    var canon = {};
    // The engine's canonical id ("Asia/Kolkata" → "Asia/Calcutta" in ICU) — for equality only.
    function canonZone(z) {
      if (fixedOff(z) !== null) return z;
      if (canon[z] === undefined) {
        try { canon[z] = new Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions().timeZone; } catch (e) { canon[z] = ''; }
      }
      return canon[z];
    }
    function sameZone(a, b) { return a === b || (!!canonZone(a) && canonZone(a) === canonZone(b)); }

    // Minutes east of UTC in zone z at instant ms.
    function offsetAt(z, ms) {
      var fo = fixedOff(z);
      if (fo !== null) return fo;
      var f = dtf(z);
      if (!f) return 0;
      var parts = f.formatToParts(new Date(ms)), v = {};
      for (var i = 0; i < parts.length; i++) v[parts[i].type] = parts[i].value;
      var asUtc = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour % 24, +v.minute, +v.second);
      return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MIN);
    }
    function partsOf(ms, off) {
      var d = new Date(ms + off * MIN);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(),
        mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay(), off: off };
    }
    function partsAt(z, ms) { return partsOf(ms, offsetAt(z, ms)); }

    // Wall-clock time in zone z → UTC ms. A time skipped by a DST jump (2:30 on
    // spring-forward night) moves forward by the gap (→ 3:30); a repeated one
    // (1:30 on fall-back night) is the first occurrence. Overflowing fields
    // (d + 1, h 24) roll over like Date.UTC.
    function zonedToUtc(y, mo, d, h, mi, z) {
      var guess = Date.UTC(y, mo - 1, d, h, mi);
      var oA = offsetAt(z, guess - DAY), oB = offsetAt(z, guess + DAY);
      var tA = guess - oA * MIN, tB = guess - oB * MIN;
      var okA = offsetAt(z, tA) === oA, okB = offsetAt(z, tB) === oB;
      if (okA && okB) return Math.min(tA, tB);
      if (okA) return tA;
      if (okB) return tB;
      return tA;
    }
    function addDays(o, n) {
      var t = new Date(Date.UTC(o.y, o.m - 1, o.d + n));
      return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
    }
    function dayNum(o) { return Math.round(Date.UTC(o.y, o.m - 1, o.d) / DAY); }
    function dayDiff(a, b) { return dayNum(b) - dayNum(a); }
    function ymdKey(o) { return o.y + '-' + pad2(o.m) + '-' + pad2(o.d); }
    function parseYmd(s) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
      if (!m) return null;
      var o = { y: +m[1], m: +m[2], d: +m[3] }, c = addDays(o, 0);
      return c.y === o.y && c.m === o.m && c.d === o.d ? o : null;
    }
    // The local day {y,m,d} in zone z as [start, end) instants (23/24/25 h).
    function dayRange(o, z) {
      return { start: zonedToUtc(o.y, o.m, o.d, 0, 0, z), end: zonedToUtc(o.y, o.m, o.d + 1, 0, 0, z) };
    }
    // Offsets at start + i*step, i < n. Probes once per hour and fills in, so a
    // day of 15-minute slots costs ~25 Intl calls, not 96 (one DST change per hour, max).
    function offsetsOver(z, start, n, step) {
      var out = new Array(n), fo = fixedOff(z), k;
      if (fo !== null) { for (k = 0; k < n; k++) out[k] = fo; return out; }
      if (!n) return out;
      var per = Math.max(1, Math.round(HOUR / step)), i = 0, oi = offsetAt(z, start);
      out[0] = oi;
      while (i < n - 1) {
        var j = Math.min(n - 1, i + per), oj = offsetAt(z, start + j * step);
        for (k = i + 1; k < j; k++) out[k] = oj === oi ? oi : offsetAt(z, start + k * step);
        out[j] = oj; i = j; oi = oj;
      }
      return out;
    }
    function isDst(z, ms) {
      if (fixedOff(z) !== null) return false;
      var y = new Date(ms).getUTCFullYear(), a = offsetAt(z, Date.UTC(y, 0, 1)), b = offsetAt(z, Date.UTC(y, 6, 1));
      return a !== b && offsetAt(z, ms) === Math.max(a, b);
    }
    // The next offset change within `days` days → { at, from, to } or null.
    function nextTransition(z, ms, days) {
      if (fixedOff(z) !== null) return null;
      var o = offsetAt(z, ms), t = ms, lim = ms + days * DAY;
      while (t < lim) {
        var t2 = Math.min(t + DAY, lim), o2 = offsetAt(z, t2);
        if (o2 !== o) {
          var lo = Math.floor(t / MIN) * MIN, hi = Math.ceil(t2 / MIN) * MIN;
          while (hi - lo > MIN) {
            var mid = lo + Math.floor((hi - lo) / MIN / 2) * MIN;
            if (offsetAt(z, mid) === o) lo = mid; else hi = mid;
          }
          return { at: hi, from: o, to: offsetAt(z, hi) };
        }
        t = t2;
      }
      return null;
    }
    // Letter abbreviation ("EDT", "BST", "IST", "AEDT") or '' when no English
    // locale has one for this zone (the UTC offset is shown anyway).
    var abbrs = {};
    function abbrLocales(z) {
      if (/^Australia\//.test(z)) return ['en-AU'];
      if (/^Pacific\/(Auckland|Chatham)$|^Antarctica\/McMurdo$/.test(z)) return ['en-NZ'];
      if (/^Asia\/(Kolkata|Calcutta)$/.test(z)) return ['en-IN'];
      if (/^Africa\/(Johannesburg|Maseru|Mbabane)$/.test(z)) return ['en-ZA'];
      if (/^(Europe|Atlantic|Africa)\//.test(z)) return ['en-GB'];
      if (/^(America|US|Canada)\/|^Pacific\/Honolulu$/.test(z)) return ['en-US', 'en-CA'];
      return ['en-US', 'en-GB'];
    }
    function abbrAt(z, ms) {
      if (fixedOff(z) !== null) return '';
      var off = offsetAt(z, ms), k = z + '|' + off;
      if (abbrs[k] !== undefined) return abbrs[k];
      var out = '', locs = abbrLocales(z);
      for (var i = 0; i < locs.length && !out; i++) {
        var name = '';
        try {
          var parts = new Intl.DateTimeFormat(locs[i], { timeZone: z, timeZoneName: 'short' }).formatToParts(new Date(ms));
          for (var j = 0; j < parts.length; j++) if (parts[j].type === 'timeZoneName') name = parts[j].value;
        } catch (e) { name = ''; }
        if (/^[A-Z]{2,5}$/.test(name) && (off === 0 || !/^(GMT|UTC|UT)$/.test(name))) out = name;
      }
      abbrs[k] = out;
      return out;
    }
    function deviceZone() {
      try { return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
    }
    function deviceH12() {
      try {
        var o = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions();
        return o.hourCycle ? o.hourCycle === 'h12' || o.hourCycle === 'h11' : !!o.hour12;
      } catch (e) { return false; }
    }

    // ---- formatting ---------------------------------------------------------------
    function fmtTime(h, mi, h12, s) {
      var sec = s != null ? ':' + pad2(s) : '';
      if (h12) return ((h + 11) % 12 + 1) + ':' + pad2(mi) + sec + ' ' + (h < 12 ? 'AM' : 'PM');
      return pad2(h) + ':' + pad2(mi) + sec;
    }
    function fmtOffset(off) {
      var a = Math.abs(off), h = Math.floor(a / 60), mi = a % 60;
      return 'UTC' + (off < 0 ? MINUS : '+') + h + (mi ? ':' + pad2(mi) : '');
    }
    // Difference from you: "+6 h", "−3:30", "same time".
    function fmtDiff(min) {
      if (!min) return 'same time';
      var a = Math.abs(min), h = Math.floor(a / 60), mi = a % 60, sg = min < 0 ? MINUS : '+';
      return mi ? sg + h + ':' + pad2(mi) : sg + h + ' h';
    }
    function fmtDur(min) {
      var h = Math.floor(min / 60), mi = min % 60;
      return h ? h + ' h' + (mi ? ' ' + mi + ' min' : '') : mi + ' min';
    }
    function fmtDate(p) { return WD[p.wd] + ' ' + p.d + ' ' + MON[p.m - 1]; }
    function fmtDateY(p) { return fmtDate(p) + ' ' + p.y; }
    function relDay(n) {
      if (n === 0) return 'Today';
      if (n === 1) return 'Tomorrow';
      if (n === -1) return 'Yesterday';
      return (n > 0 ? '+' : MINUS) + Math.abs(n) + ' days';
    }
    function hourLabel(h, h12) { return String(h12 ? (h + 11) % 12 + 1 : h); }
    // "Clocks go back 1 h on Sun 26 Oct" for a transition from nextTransition().
    function changeNote(z, tr) {
      if (!tr) return '';
      var d = tr.to - tr.from, a = Math.abs(d);
      var amt = a % 60 ? (a >= 60 ? Math.floor(a / 60) + ' h ' : '') + (a % 60) + ' min' : a / 60 + ' h';
      return 'Clocks go ' + (d > 0 ? 'forward ' : 'back ') + amt + ' on ' + fmtDate(partsAt(z, tr.at));
    }

    // ---- the sun (day / dawn / dusk / night) -----------------------------------------
    // Solar altitude in degrees (low-precision almanac formula: ±0.1°, plenty here).
    function sunAltitude(lat, lon, ms) {
      var rad = Math.PI / 180, d = ms / DAY - 10957.5;            // days since J2000.0
      var g = (357.529 + 0.98560028 * d) * rad;
      var q = 280.459 + 0.98564736 * d;
      var L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
      var e = (23.439 - 0.00000036 * d) * rad;
      var ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
      var dec = Math.asin(Math.sin(e) * Math.sin(L));
      var gmst = 18.697374558 + 24.06570982441908 * d;
      var ha = ((gmst % 24) * 15 + lon) * rad - ra, la = lat * rad;
      return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)) / rad;
    }
    // 'day' | 'dawn' | 'dusk' | 'night'. Without coordinates: by the local clock.
    function sunPhase(lat, lon, ms, p) {
      if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) {
        var m = p.h * 60 + p.mi;
        return m >= 420 && m < 1140 ? 'day' : m >= 360 && m < 420 ? 'dawn' : m >= 1140 && m < 1200 ? 'dusk' : 'night';
      }
      var a = sunAltitude(lat, lon, ms);
      if (a > -0.833) return 'day';
      if (a > -6) return sunAltitude(lat, lon, ms + 10 * MIN) > a ? 'dawn' : 'dusk';
      return 'night';
    }

    // ---- working hours & overlap --------------------------------------------------------
    var FRI_SAT = { 'Saudi Arabia': 1, Israel: 1, Palestine: 1, Egypt: 1, Qatar: 1, Kuwait: 1, Bahrain: 1, Oman: 1, Jordan: 1,
      Iraq: 1, Algeria: 1, Sudan: 1, Yemen: 1, Bangladesh: 1, Libya: 1, Syria: 1, Maldives: 1 };
    function weekendOf(country) {
      if (FRI_SAT[country]) return [5, 6];
      if (country === 'Afghanistan') return [4, 5];
      if (country === 'Iran') return [5];
      if (country === 'Nepal') return [6];
      return [0, 6];
    }
    // Is minute-of-day m inside [ws, we)? (we < ws = an overnight shift.)
    function inWork(m, ws, we) { return ws <= we ? m >= ws && m < we : m >= ws || m < we; }
    var NIGHT_FROM = 22 * 60, NIGHT_TO = 7 * 60;
    function slotKind(p, ws, we, weekend) {
      var m = p.h * 60 + p.mi, wk = !!weekend && weekend.indexOf(p.wd) >= 0;
      if (!wk && inWork(m, ws, we)) return 'work';
      if (m >= NIGHT_FROM || m < NIGHT_TO) return 'night';
      return wk ? 'off' : 'day';
    }
    // One place's day as runs of slot kinds: [{ kind, from, to }] in slot indices.
    function bands(z, start, n, ws, we, weekend) {
      var offs = offsetsOver(z, start, n, SLOT), out = [], cur = null;
      for (var i = 0; i < n; i++) {
        var k = slotKind(partsOf(start + i * SLOT, offs[i]), ws, we, weekend);
        if (cur && cur.kind === k) cur.to = i + 1;
        else { cur = { kind: k, from: i, to: i + 1 }; out.push(cur); }
      }
      return out;
    }
    // Each whole local hour of zone z inside [start, end): [{ t, h, wd, d }].
    function hourMarks(z, start, end) {
      var out = [], p = partsAt(z, start);
      var t = start + (p.mi || p.s ? (60 - p.mi) * MIN - p.s * 1000 : 0), guard = 0;
      while (t < end && guard++ < 60) {
        var q = partsAt(z, t);
        if (q.mi) { t += (60 - q.mi) * MIN; continue; }   // a 30-minute DST shift (Lord Howe) realigns
        out.push({ t: t, h: q.h, wd: q.wd, d: q.d, m: q.m });
        t += HOUR;
      }
      return out;
    }
    // How many places are working in each 15-minute slot of [start, start + n*SLOT).
    // places: [{ zone, weekend|null }] → { n, counts, max, all, runs: [{ from, to }] }
    // runs = the slots where `max` places work (everyone when all is true).
    function overlap(places, start, n, ws, we) {
      var counts = [], i;
      for (i = 0; i < n; i++) counts.push(0);
      places.forEach(function (pl) {
        var offs = offsetsOver(pl.zone, start, n, SLOT);
        for (var j = 0; j < n; j++) {
          var p = partsOf(start + j * SLOT, offs[j]);
          if (!(pl.weekend && pl.weekend.indexOf(p.wd) >= 0) && inWork(p.h * 60 + p.mi, ws, we)) counts[j]++;
        }
      });
      var max = 0;
      for (i = 0; i < n; i++) if (counts[i] > max) max = counts[i];
      var runs = [], cur = null;
      if (max > 0) {
        for (i = 0; i < n; i++) {
          if (counts[i] === max) { if (cur && cur.to === i) cur.to = i + 1; else { cur = { from: i, to: i + 1 }; runs.push(cur); } }
        }
      }
      return { n: places.length, counts: counts, max: max, all: max > 0 && max === places.length, runs: runs };
    }

    // ---- places: the built-in city table + IANA zones -------------------------------------
    function norm(s) {
      return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[.'\u2019`\u02bb]/g, '').replace(/[_\/,()\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    }
    // Abbreviations / region words → the zone they usually mean (DST-following).
    var ABBR = {
      UTC: 'UTC', GMT: 'UTC', UT: 'UTC', Z: 'UTC', ZULU: 'UTC',
      ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York', EASTERN: 'America/New_York',
      CT: 'America/Chicago', CST: 'America/Chicago', CDT: 'America/Chicago', CENTRAL: 'America/Chicago',
      MT: 'America/Denver', MST: 'America/Denver', MDT: 'America/Denver', MOUNTAIN: 'America/Denver',
      PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PACIFIC: 'America/Los_Angeles',
      AKT: 'America/Anchorage', AKST: 'America/Anchorage', AKDT: 'America/Anchorage',
      HT: 'Pacific/Honolulu', HST: 'Pacific/Honolulu', HAST: 'Pacific/Honolulu',
      AT: 'America/Halifax', AST: 'America/Halifax', ADT: 'America/Halifax', ATLANTIC: 'America/Halifax',
      NT: 'America/St_Johns', NST: 'America/St_Johns', NDT: 'America/St_Johns',
      BST: 'Europe/London', WET: 'Europe/Lisbon', WEST: 'Europe/Lisbon', CET: 'Europe/Paris', CEST: 'Europe/Paris',
      EET: 'Europe/Athens', EEST: 'Europe/Athens', MSK: 'Europe/Moscow',
      IST: 'Asia/Kolkata', PKT: 'Asia/Karachi', NPT: 'Asia/Kathmandu', SGT: 'Asia/Singapore', HKT: 'Asia/Hong_Kong',
      JST: 'Asia/Tokyo', KST: 'Asia/Seoul', AWST: 'Australia/Perth', ACST: 'Australia/Adelaide', ACDT: 'Australia/Adelaide',
      AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney', AET: 'Australia/Sydney', NZST: 'Pacific/Auckland',
      NZDT: 'Pacific/Auckland', NZT: 'Pacific/Auckland', BRT: 'America/Sao_Paulo', ART: 'America/Argentina/Buenos_Aires',
      SAST: 'Africa/Johannesburg', WAT: 'Africa/Lagos', CAT: 'Africa/Maputo', EAT: 'Africa/Nairobi', GST: 'Asia/Dubai',
      ICT: 'Asia/Bangkok', WIB: 'Asia/Jakarta', PHT: 'Asia/Manila', IRST: 'Asia/Tehran', AFT: 'Asia/Kabul', MMT: 'Asia/Yangon'
    };
    // Engine-canonical / legacy ids → the id the city table uses.
    var MODERN = {
      'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Katmandu': 'Asia/Kathmandu',
      'Asia/Rangoon': 'Asia/Yangon', 'Europe/Kyiv': 'Europe/Kiev', 'Africa/Asmera': 'Africa/Asmara',
      'Atlantic/Faeroe': 'Atlantic/Faroe', 'America/Nuuk': 'America/Godthab', 'Pacific/Kanton': 'Pacific/Enderbury',
      'Asia/Ulan_Bator': 'Asia/Ulaanbaatar', 'Asia/Dacca': 'Asia/Dhaka', 'Asia/Thimbu': 'Asia/Thimphu',
      'Asia/Macao': 'Asia/Macau', 'Pacific/Ponape': 'Pacific/Pohnpei', 'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
      'America/Cordoba': 'America/Argentina/Cordoba', 'America/Mendoza': 'America/Argentina/Mendoza',
      'America/Indianapolis': 'America/Indiana/Indianapolis', 'America/Louisville': 'America/Kentucky/Louisville',
      'Asia/Tel_Aviv': 'Asia/Jerusalem', 'Asia/Istanbul': 'Europe/Istanbul', 'Europe/Nicosia': 'Asia/Nicosia',
      'Etc/UTC': 'UTC', 'Etc/GMT': 'UTC', 'Etc/UCT': 'UTC', 'Etc/Universal': 'UTC', 'Etc/Zulu': 'UTC', GMT: 'UTC',
      UCT: 'UTC', Universal: 'UTC', Zulu: 'UTC', 'US/Eastern': 'America/New_York', 'US/Central': 'America/Chicago',
      'US/Mountain': 'America/Denver', 'US/Pacific': 'America/Los_Angeles', 'US/Hawaii': 'Pacific/Honolulu',
      'US/Alaska': 'America/Anchorage', 'US/Arizona': 'America/Phoenix', 'Canada/Eastern': 'America/Toronto',
      'Canada/Pacific': 'America/Vancouver', 'Canada/Central': 'America/Winnipeg', 'Canada/Mountain': 'America/Edmonton',
      'Canada/Atlantic': 'America/Halifax', 'Canada/Newfoundland': 'America/St_Johns', 'Europe/Belfast': 'Europe/London',
      'GB': 'Europe/London', 'NZ': 'Pacific/Auckland', 'Japan': 'Asia/Tokyo', 'Singapore': 'Asia/Singapore', 'Hongkong': 'Asia/Hong_Kong'
    };
    var RENAME = { Calcutta: 'Kolkata', Saigon: 'Ho Chi Minh City', Katmandu: 'Kathmandu', Rangoon: 'Yangon', Kiev: 'Kyiv',
      Asmera: 'Asmara', Faeroe: 'Faroe Islands', Godthab: 'Nuuk', Enderbury: 'Kanton', Ulan_Bator: 'Ulaanbaatar',
      Dacca: 'Dhaka', Thimbu: 'Thimphu', Macao: 'Macau', Ponape: 'Pohnpei', Truk: 'Chuuk', Uzhgorod: 'Uzhhorod',
      Zaporozhye: 'Zaporizhzhia' };
    // "America/Indiana/Indianapolis" → "Indianapolis"
    function zoneCity(z) {
      if (z === 'UTC') return 'UTC';
      var fo = fixedOff(z);
      if (fo !== null) return fmtOffset(fo);
      var last = String(z).split('/').pop();
      return RENAME[last] || last.replace(/_/g, ' ');
    }
    function parseCity(line, i) {
      var f = line.split('|');
      var lat = f[3] === '' || f[3] == null ? null : +f[3], lon = f[4] === '' || f[4] == null ? null : +f[4];
      var al = f[5] ? f[5].split(',') : [];
      return { name: f[0], country: f[1], zone: f[2], lat: lat, lon: lon, aliases: al, idx: i,
        n: norm(f[0]), na: al.map(norm), nc: norm(f[1]), nz: norm(f[2]) };
    }
    // { list, byZone } from the city lines + (optionally) Intl.supportedValuesOf('timeZone').
    function buildIndex(lines, ianaZones) {
      var index = { list: [], byZone: {}, names: {}, zones: false }, i;
      for (i = 0; i < lines.length; i++) {
        var e = parseCity(lines[i], i);
        index.list.push(e);
        if (!index.byZone[e.zone]) index.byZone[e.zone] = e;
        index.names[e.n] = 1;
        for (var k = 0; k < e.na.length; k++) index.names[e.na[k]] = 1;
      }
      if (ianaZones) addZones(index, ianaZones);
      return index;
    }
    // Every IANA zone no city already covers, as a searchable place (added on demand).
    function addZones(index, ianaZones) {
      if (index.zones) return index;
      index.zones = true;
      var list = index.list, byZone = index.byZone, names = index.names;
      (ianaZones || []).forEach(function (z) {
        if (/^(Etc|SystemV|US|Canada|Mexico|Brazil|Chile)\//.test(z) || z.indexOf('/') < 0) return;
        var nm = zoneCity(z), nn = norm(nm);
        if (names[nn] || byZone[z] || byZone[MODERN[z]]) return;           // a city already covers it
        names[nn] = 1;
        list.push({ name: nm, country: '', zone: z, lat: null, lon: null, aliases: [], idx: list.length, iana: true,
          n: nn, na: [], nc: '', nz: norm(z) });
      });
      return index;
    }
    // The city the table lists first for zone z (or null).
    function placeForZone(index, z) {
      var e = index.byZone[z] || index.byZone[MODERN[z]];
      if (e) return e;
      var cz = canonZone(z);
      if (!cz) return null;
      for (var k in index.byZone) if (canonZone(k) === cz) return index.byZone[k];
      return null;
    }
    function wordPrefix(hay, q) { return hay.indexOf(q) === 0 || hay.indexOf(' ' + q) >= 0; }
    var FIXED_Q = /^(?:utc|gmt)?\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?$/i;
    function fixedEntry(q) {
      var m = FIXED_Q.exec(String(q).trim());
      if (!m || !/^(utc|gmt|[+\-−])/i.test(String(q).trim())) return null;
      var off = (+m[2] * 60 + (+m[3] || 0)) * (m[1] === '+' ? 1 : -1);
      if (Math.abs(off) > 14 * 60 || (+m[3] || 0) >= 60) return null;
      var z = off === 0 ? 'UTC' : fixedZone(off);
      return { name: off === 0 ? 'UTC' : fmtOffset(off), country: 'Fixed offset', zone: z, lat: null, lon: null, aliases: [], idx: -1, fixed: true };
    }
    function score(e, q, toks) {
      if (e.n === q) return 1000;
      var i;
      for (i = 0; i < e.na.length; i++) if (e.na[i] === q) return 950;
      if (e.n.indexOf(q) === 0) return 800;
      for (i = 0; i < e.na.length; i++) if (e.na[i].indexOf(q) === 0) return 750;
      if (wordPrefix(e.n, q)) return 700;
      if (e.nz === q) return 900;
      if (e.nc && e.nc === q) return 820;
      if (toks.length > 1) {
        var hay = e.n + ' ' + e.na.join(' ') + ' ' + e.nc + ' ' + e.nz, all = true;
        for (i = 0; i < toks.length && all; i++) all = wordPrefix(hay, toks[i]);
        if (all && wordPrefix(e.n + ' ' + e.na.join(' '), toks[0])) return 650;
        if (all) return 420;
      }
      if (e.nc && q.length > 1 && wordPrefix(e.nc, q)) return 450;
      if (q.length > 1 && wordPrefix(e.nz, q)) return 400;
      if (q.length > 2 && e.n.indexOf(q) > 0) return 300;
      return 0;
    }
    // Ranked places for a query → [{ e, s }] (best first; table order breaks ties).
    function search(index, query, limit) {
      var raw = String(query || '').trim(), q = norm(raw), out = [], i;
      if (!q && !/^[+\-−]/.test(raw)) return out;
      var fx = fixedEntry(raw);
      if (fx) out.push({ e: fx, s: 1100 });
      var ab = ABBR[raw.toUpperCase().replace(/\s+TIME$/, '')], abSeen = false;
      var toks = q.split(' ').filter(Boolean);
      for (i = 0; i < index.list.length; i++) {
        var e = index.list[i], s = q ? score(e, q, toks) : 0;
        if (ab && e.zone === ab) { s = Math.max(s, abSeen ? 350 : 900); abSeen = true; }
        if (s > 0) out.push({ e: e, s: s });
      }
      out.sort(function (a, b) { return b.s - a.s || a.e.idx - b.e.idx; });
      return out.slice(0, limit || 30);
    }
    // Optimal-string-alignment distance (typos incl. swapped letters), capped at max + 1.
    function editDist(a, b, max) {
      if (Math.abs(a.length - b.length) > max) return max + 1;
      var pp = null, prev = [], cur, i, j;
      for (j = 0; j <= b.length; j++) prev[j] = j;
      for (i = 1; i <= a.length; i++) {
        cur = [i];
        var lo = i;
        for (j = 1; j <= b.length; j++) {
          var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
          if (pp && i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) v = Math.min(v, pp[j - 2] + 1);
          cur[j] = v;
          if (v < lo) lo = v;
        }
        if (lo > max) return max + 1;
        pp = prev; prev = cur;
      }
      return prev[b.length];
    }
    // "Did you mean …?" for a misspelt place (null when nothing is close).
    function suggest(index, text) {
      var q = norm(text);
      if (q.length < 3) return null;
      var max = q.length < 5 ? 1 : q.length < 9 ? 2 : 3, best = null, bd = max + 1;
      for (var i = 0; i < index.list.length && bd > 0; i++) {
        var e = index.list[i], names = [e.n].concat(e.na);
        for (var k = 0; k < names.length; k++) {
          var d = editDist(q, names[k], Math.min(max, bd - 1 < 0 ? 0 : bd - 1));
          if (d < bd) { bd = d; best = e; }
        }
      }
      return best;
    }
    // The place a phrase means, or null: exact / prefix / abbreviation / offset matches only.
    function resolvePlace(index, text) {
      var r = search(index, text, 1)[0];
      return r && r.s >= 600 ? r.e : null;
    }

    // ---- parsing "3pm London" ---------------------------------------------------------------
    var MON_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
    var WD_RE = /\b(next\s+)?(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\b/i;
    function monIdx(s) { return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(s.slice(0, 3).toLowerCase()) + 1; }
    function cut(s, i, len) { return s.slice(0, i) + ' ' + s.slice(i + len); }
    // → { h, mi, now?, rest } or { err } or null (no time in the text)
    function findTime(s) {
      var m, h, mi;
      if ((m = /\b(noon|midday)\b/i.exec(s))) return { h: 12, mi: 0, rest: cut(s, m.index, m[0].length) };
      if ((m = /\bmidnight\b/i.exec(s))) return { h: 0, mi: 0, rest: cut(s, m.index, m[0].length) };
      if ((m = /\bnow\b/i.exec(s))) return { now: true, rest: cut(s, m.index, m[0].length) };
      // 3pm · 3 pm · 3:30pm · 3.30 p.m. · 11a
      if ((m = /(^|[^\d:.])(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?(?:m\b\.?)?(?![a-z])/i.exec(s))) {
        h = +m[2]; mi = m[3] ? +m[3] : 0;
        var pm = /p/i.test(m[4]);
        if (mi > 59) return { err: 'Minutes go up to 59' };
        if (h > 12 && h < 24 && pm) { /* "15:30pm" — take it as 15:30 */ }
        else if (h < 1 || h > 12) return { err: '"' + m[0].trim() + '" isn’t a time' };
        else h = h % 12 + (pm ? 12 : 0);
        return { h: h, mi: mi, rest: cut(s, m.index + m[1].length, m[0].length - m[1].length) };
      }
      // 15:30 · 9:05 · 15h30 · 15.30
      if ((m = /(^|[^\d:.\/])(\d{1,2})[:h.](\d{2})(?![\d:.\/])/i.exec(s))) {
        h = +m[2]; mi = +m[3];
        if (h > 23 || mi > 59) return { err: '"' + m[0].trim() + '" isn’t a time' };
        return { h: h, mi: mi, rest: cut(s, m.index + m[1].length, m[0].length - m[1].length) };
      }
      // 15h · 1530h · 0900 hrs
      if ((m = /(^|[^\d])(\d{1,2})\s?(?:h|hrs)\b/i.exec(s)) && +m[2] < 24) {
        return { h: +m[2], mi: 0, rest: cut(s, m.index + m[1].length, m[0].length - m[1].length) };
      }
      if ((m = /(^|[^\d])([01]\d|2[0-3])([0-5]\d)\s?(?:h|hrs|hours)\b/i.exec(s))) {
        return { h: +m[2], mi: +m[3], rest: cut(s, m.index + m[1].length, m[0].length - m[1].length) };
      }
      return null;
    }
    // → { shift } | { date } | { wd, next } (and rest), or null
    function findDate(s, today) {
      var m;
      if ((m = /\b(today|tonight|this (?:morning|afternoon|evening))\b/i.exec(s))) return { shift: 0, rest: cut(s, m.index, m[0].length) };
      if ((m = /\b(tomorrow|tmrw|tmr|tomorow|tommorow)\b/i.exec(s))) return { shift: 1, rest: cut(s, m.index, m[0].length) };
      if ((m = /\byesterday\b/i.exec(s))) return { shift: -1, rest: cut(s, m.index, m[0].length) };
      if ((m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s))) {
        var o = parseYmd(m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]));
        return o ? { date: o, rest: cut(s, m.index, m[0].length) } : { err: 'No such date: ' + m[0] };
      }
      var dm = new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MON_RE + '(?:,?\\s+(\\d{4}))?\\b', 'i').exec(s);
      var md = new RegExp('\\b' + MON_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?', 'i').exec(s);
      if (dm || md) {
        var y = (dm ? dm[3] : md[3]) ? +(dm ? dm[3] : md[3]) : today.y;
        var mo = monIdx(dm ? dm[2] : md[1]), d = +(dm ? dm[1] : md[2]), mm = dm || md;
        var od = parseYmd(y + '-' + pad2(mo) + '-' + pad2(d));
        return od ? { date: od, rest: cut(s, mm.index, mm[0].length) } : { err: 'No such date: ' + mm[0].trim() };
      }
      if ((m = WD_RE.exec(s))) {
        var want = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(m[2].slice(0, 3).toLowerCase());
        return { wd: want, next: !!m[1], rest: cut(s, m.index, m[0].length) };
      }
      return null;
    }
    var LOCAL_RE = /^(?:local(?: time)?|here|me|my|my time|mine|you|your time|my place|this device)$/i;
    // "3pm London" → { ok, h, mi, place, date: {y,m,d}, utc, gap } | { ok: false, error, suggest }
    // opts: { now, localZone, localPlace, index }
    function parseQuery(text, opts) {
      var s = ' ' + String(text || '').replace(/[–—]/g, '-') + ' ';
      if (!s.trim()) return { ok: false, empty: true, error: '' };
      var t = findTime(s);
      if (!t) return { ok: false, error: 'Add a time — e.g. 3pm, 15:30 or noon' };
      if (t.err) return { ok: false, error: t.err };
      s = t.rest;
      var dt = findDate(s, partsAt(opts.localZone, opts.now));
      if (dt && dt.err) return { ok: false, error: dt.err };
      if (dt) s = dt.rest;
      var raw = s.replace(/[@,;]+/g, ' ').replace(/\s+/g, ' ').replace(/^(?:in|at)\s+/i, '').trim();
      var rest = raw.replace(/\b(in|at|on|for|from|time|o'?clock|the|of)\b/gi, ' ').replace(/\s+/g, ' ').trim();
      var place;
      if (!rest || LOCAL_RE.test(rest) || LOCAL_RE.test(raw)) place = opts.localPlace || { name: 'Local', zone: opts.localZone, local: true };
      else {
        place = resolvePlace(opts.index, rest);
        if (!place) {
          var sug = search(opts.index, rest, 1)[0];
          return { ok: false, error: 'Unknown place “' + rest + '”', rest: rest, suggest: sug && sug.s >= 300 ? sug.e : suggest(opts.index, rest) };
        }
      }
      var z = place.zone, today = partsAt(z, opts.now), date;
      if (!dt || dt.shift != null) date = addDays(today, dt ? dt.shift : 0);
      else if (dt.date) date = dt.date;
      else {
        var ahead = (dt.wd - today.wd + 7) % 7;
        if (dt.next && ahead === 0) ahead = 7;
        date = addDays(today, ahead);
      }
      var h = t.h, mi = t.mi;
      if (t.now) { h = today.h; mi = today.mi; date = { y: today.y, m: today.m, d: today.d }; }
      var utc = zonedToUtc(date.y, date.m, date.d, h, mi, z), got = partsAt(z, utc);
      return { ok: true, h: h, mi: mi, place: place, date: date, utc: utc, gap: got.h !== h || got.mi !== mi };
    }

    // ---- meeting text --------------------------------------------------------------------------
    // rows: [{ label, p (parts at the instant), abbr? }], first = the reference.
    // 'line'  → "Tue 14 Oct · 09:00 New York · 14:00 London · 22:30 Mumbai (Wed)"
    // 'lines' → one "Tue 14 Oct · 09:00 · New York (EDT)" line per place
    function meetingText(rows, h12, mode) {
      if (!rows.length) return '';
      var ref = rows[0].p;
      if (mode === 'lines') {
        return rows.map(function (r) {
          return fmtDate(r.p) + ' · ' + fmtTime(r.p.h, r.p.mi, h12) + ' · ' + r.label + (r.abbr ? ' (' + r.abbr + ')' : '');
        }).join('\n');
      }
      return fmtDate(ref) + ' · ' + rows.map(function (r) {
        var other = r.p.y !== ref.y || r.p.m !== ref.m || r.p.d !== ref.d;
        return fmtTime(r.p.h, r.p.mi, h12) + ' ' + r.label + (other ? ' (' + WD[r.p.wd] + ')' : '');
      }).join(' · ');
    }

    return {
      MIN: MIN, HOUR: HOUR, DAY: DAY, SLOT: SLOT, WD: WD, MON: MON,
      fixedOff: fixedOff, fixedZone: fixedZone, validZone: validZone, canonZone: canonZone, sameZone: sameZone,
      offsetAt: offsetAt, partsOf: partsOf, partsAt: partsAt, zonedToUtc: zonedToUtc, addDays: addDays,
      dayDiff: dayDiff, ymdKey: ymdKey, parseYmd: parseYmd, dayRange: dayRange, offsetsOver: offsetsOver,
      isDst: isDst, nextTransition: nextTransition, abbrAt: abbrAt, deviceZone: deviceZone, deviceH12: deviceH12,
      fmtTime: fmtTime, fmtOffset: fmtOffset, fmtDiff: fmtDiff, fmtDur: fmtDur, fmtDate: fmtDate, fmtDateY: fmtDateY,
      relDay: relDay, hourLabel: hourLabel, changeNote: changeNote,
      sunAltitude: sunAltitude, sunPhase: sunPhase,
      weekendOf: weekendOf, inWork: inWork, slotKind: slotKind, bands: bands, hourMarks: hourMarks, overlap: overlap,
      norm: norm, zoneCity: zoneCity, buildIndex: buildIndex, addZones: addZones, placeForZone: placeForZone, search: search,
      resolvePlace: resolvePlace, suggest: suggest, editDist: editDist, parseQuery: parseQuery, meetingText: meetingText, ABBR: ABBR,
      CITIES: CITIES()
    };

    // ~500 places: every capital, big cities, and every inhabited UTC offset
    // (−11 … +14, incl. −9:30, −3:30, +3:30, +4:30, +5:30, +5:45, +6:30, +8:45,
    // +9:30, +10:30, +12:45). "City|Country|IANA zone|lat|lon|aliases", most
    // useful first (ties in search go to the earlier line). Coordinates are
    // approximate (day/night only).
    function CITIES() {
      return [
        'UTC|Coordinated Universal Time|UTC|||GMT,Zulu,Universal Time,Greenwich Mean Time',
        'London|United Kingdom|Europe/London|51.51|-0.13|UK,England,Britain',
        'New York|United States|America/New_York|40.71|-74.01|NYC,New York City,Manhattan,Brooklyn',
        'Los Angeles|United States|America/Los_Angeles|34.05|-118.24|LA,Hollywood',
        'San Francisco|United States|America/Los_Angeles|37.77|-122.42|SF,San Fran,Bay Area,Silicon Valley',
        'Chicago|United States|America/Chicago|41.88|-87.63|',
        'Tokyo|Japan|Asia/Tokyo|35.68|139.69|',
        'Paris|France|Europe/Paris|48.86|2.35|',
        'Berlin|Germany|Europe/Berlin|52.52|13.40|',
        'Singapore|Singapore|Asia/Singapore|1.35|103.82|',
        'Hong Kong|Hong Kong|Asia/Hong_Kong|22.32|114.17|HK',
        'Sydney|Australia|Australia/Sydney|-33.87|151.21|',
        'Dubai|United Arab Emirates|Asia/Dubai|25.20|55.27|UAE',
        'Mumbai|India|Asia/Kolkata|19.08|72.88|Bombay',
        'New Delhi|India|Asia/Kolkata|28.61|77.21|Delhi',
        'Bengaluru|India|Asia/Kolkata|12.97|77.59|Bangalore',
        'Shanghai|China|Asia/Shanghai|31.23|121.47|',
        'Beijing|China|Asia/Shanghai|39.90|116.41|Peking',
        'Seoul|South Korea|Asia/Seoul|37.57|126.98|Korea',
        'Toronto|Canada|America/Toronto|43.65|-79.38|',
        'Washington|United States|America/New_York|38.90|-77.04|Washington DC,DC',
        'São Paulo|Brazil|America/Sao_Paulo|-23.55|-46.63|',
        'Mexico City|Mexico|America/Mexico_City|19.43|-99.13|CDMX,Ciudad de Mexico',
        'Amsterdam|Netherlands|Europe/Amsterdam|52.37|4.90|Holland',
        'Zurich|Switzerland|Europe/Zurich|47.38|8.54|Zürich',
        'Frankfurt|Germany|Europe/Berlin|50.11|8.68|',
        'Madrid|Spain|Europe/Madrid|40.42|-3.70|',
        'Dublin|Ireland|Europe/Dublin|53.35|-6.26|',
        'Seattle|United States|America/Los_Angeles|47.61|-122.33|',
        'Boston|United States|America/New_York|42.36|-71.06|',
        'Austin|United States|America/Chicago|30.27|-97.74|',
        'Denver|United States|America/Denver|39.74|-104.99|',
        'Moscow|Russia|Europe/Moscow|55.76|37.62|Moskva',
        'Istanbul|Turkey|Europe/Istanbul|41.01|28.98|',
        'Tel Aviv|Israel|Asia/Jerusalem|32.09|34.78|',
        'Johannesburg|South Africa|Africa/Johannesburg|-26.20|28.05|Joburg',
        'Lagos|Nigeria|Africa/Lagos|6.52|3.38|',
        'Nairobi|Kenya|Africa/Nairobi|-1.29|36.82|',
        'Cairo|Egypt|Africa/Cairo|30.04|31.24|',
        'Bangkok|Thailand|Asia/Bangkok|13.76|100.50|',
        'Jakarta|Indonesia|Asia/Jakarta|-6.21|106.85|',
        'Manila|Philippines|Asia/Manila|14.60|120.98|',
        'Taipei|Taiwan|Asia/Taipei|25.03|121.57|',
        'Auckland|New Zealand|Pacific/Auckland|-36.85|174.76|',
        'Honolulu|United States|Pacific/Honolulu|21.31|-157.86|Hawaii',
        'Anchorage|United States|America/Anchorage|61.22|-149.90|Alaska',
        'Vancouver|Canada|America/Vancouver|49.28|-123.12|',
        'Buenos Aires|Argentina|America/Argentina/Buenos_Aires|-34.60|-58.38|',
        'Kathmandu|Nepal|Asia/Kathmandu|27.72|85.32|Katmandu',
        'St. John\'s|Canada|America/St_Johns|47.56|-52.71|Newfoundland',
        'Adelaide|Australia|Australia/Adelaide|-34.93|138.60|',
        'Tehran|Iran|Asia/Tehran|35.69|51.39|',
        'Kabul|Afghanistan|Asia/Kabul|34.53|69.17|',
        'Yangon|Myanmar|Asia/Yangon|16.87|96.20|Rangoon',
        'Colombo|Sri Lanka|Asia/Colombo|6.93|79.86|',
        'Halifax|Canada|America/Halifax|44.65|-63.57|Nova Scotia',
        'Lisbon|Portugal|Europe/Lisbon|38.72|-9.14|Lisboa',
        'Athens|Greece|Europe/Athens|37.98|23.73|',
        'Karachi|Pakistan|Asia/Karachi|24.86|67.01|',
        'Perth|Australia|Australia/Perth|-31.95|115.86|',
        'Maputo|Mozambique|Africa/Maputo|-25.97|32.57|',
        // United States
        'Houston|United States|America/Chicago|29.76|-95.37|',
        'Dallas|United States|America/Chicago|32.78|-96.80|',
        'Phoenix|United States|America/Phoenix|33.45|-112.07|Arizona',
        'Philadelphia|United States|America/New_York|39.95|-75.17|Philly',
        'San Diego|United States|America/Los_Angeles|32.72|-117.16|',
        'San Jose|United States|America/Los_Angeles|37.34|-121.89|',
        'San Antonio|United States|America/Chicago|29.42|-98.49|',
        'Atlanta|United States|America/New_York|33.75|-84.39|',
        'Miami|United States|America/New_York|25.76|-80.19|',
        'Detroit|United States|America/Detroit|42.33|-83.05|',
        'Minneapolis|United States|America/Chicago|44.98|-93.27|',
        'Portland|United States|America/Los_Angeles|45.52|-122.68|',
        'Las Vegas|United States|America/Los_Angeles|36.17|-115.14|Vegas',
        'Salt Lake City|United States|America/Denver|40.76|-111.89|',
        'Nashville|United States|America/Chicago|36.16|-86.78|',
        'New Orleans|United States|America/Chicago|29.95|-90.07|',
        'Charlotte|United States|America/New_York|35.23|-80.84|',
        'Indianapolis|United States|America/Indiana/Indianapolis|39.77|-86.16|',
        'Columbus|United States|America/New_York|39.96|-83.00|',
        'Pittsburgh|United States|America/New_York|40.44|-80.00|',
        'Kansas City|United States|America/Chicago|39.10|-94.58|',
        'St. Louis|United States|America/Chicago|38.63|-90.20|Saint Louis',
        'Orlando|United States|America/New_York|28.54|-81.38|',
        'Tampa|United States|America/New_York|27.95|-82.46|',
        'Raleigh|United States|America/New_York|35.78|-78.64|',
        'Baltimore|United States|America/New_York|39.29|-76.61|',
        'Sacramento|United States|America/Los_Angeles|38.58|-121.49|',
        'Albuquerque|United States|America/Denver|35.08|-106.65|',
        'Boise|United States|America/Boise|43.62|-116.20|',
        'Louisville|United States|America/Kentucky/Louisville|38.25|-85.76|',
        'Milwaukee|United States|America/Chicago|43.04|-87.91|',
        'Cleveland|United States|America/New_York|41.50|-81.69|',
        'Cincinnati|United States|America/New_York|39.10|-84.51|',
        'Oklahoma City|United States|America/Chicago|35.47|-97.52|',
        'Tucson|United States|America/Phoenix|32.22|-110.97|',
        'El Paso|United States|America/Denver|31.76|-106.49|',
        'Omaha|United States|America/Chicago|41.26|-95.93|',
        'Memphis|United States|America/Chicago|35.15|-90.05|',
        'Juneau|United States|America/Juneau|58.30|-134.42|',
        'Adak|United States|America/Adak|51.88|-176.66|Aleutian Islands',
        'San Juan|Puerto Rico|America/Puerto_Rico|18.47|-66.11|',
        'Hagåtña|Guam|Pacific/Guam|13.44|144.79|Hagatna,Guam',
        'Pago Pago|American Samoa|Pacific/Pago_Pago|-14.28|-170.70|',
        'Saipan|Northern Mariana Islands|Pacific/Saipan|15.18|145.75|',
        'Charlotte Amalie|U.S. Virgin Islands|America/St_Thomas|18.34|-64.93|St Thomas',
        // Canada
        'Ottawa|Canada|America/Toronto|45.42|-75.70|',
        'Montreal|Canada|America/Toronto|45.50|-73.57|Montréal',
        'Quebec City|Canada|America/Toronto|46.81|-71.21|Québec',
        'Calgary|Canada|America/Edmonton|51.05|-114.07|',
        'Edmonton|Canada|America/Edmonton|53.55|-113.49|',
        'Winnipeg|Canada|America/Winnipeg|49.90|-97.14|',
        'Regina|Canada|America/Regina|50.45|-104.61|Saskatchewan',
        'Whitehorse|Canada|America/Whitehorse|60.72|-135.06|Yukon',
        'Yellowknife|Canada|America/Edmonton|62.45|-114.37|',
        'Iqaluit|Canada|America/Iqaluit|63.75|-68.52|',
        // Mexico, Central America, Caribbean
        'Guadalajara|Mexico|America/Mexico_City|20.67|-103.35|',
        'Monterrey|Mexico|America/Monterrey|25.69|-100.32|',
        'Tijuana|Mexico|America/Tijuana|32.51|-117.04|',
        'Cancún|Mexico|America/Cancun|21.16|-86.85|',
        'Hermosillo|Mexico|America/Hermosillo|29.07|-110.96|',
        'Chihuahua|Mexico|America/Chihuahua|28.63|-106.07|',
        'Mazatlán|Mexico|America/Mazatlan|23.25|-106.41|',
        'Mérida|Mexico|America/Merida|20.97|-89.62|',
        'Guatemala City|Guatemala|America/Guatemala|14.63|-90.51|',
        'Belmopan|Belize|America/Belize|17.25|-88.77|',
        'San Salvador|El Salvador|America/El_Salvador|13.69|-89.22|',
        'Tegucigalpa|Honduras|America/Tegucigalpa|14.07|-87.19|',
        'Managua|Nicaragua|America/Managua|12.11|-86.24|',
        'San José|Costa Rica|America/Costa_Rica|9.93|-84.08|',
        'Panama City|Panama|America/Panama|8.98|-79.52|',
        'Havana|Cuba|America/Havana|23.11|-82.37|La Habana',
        'Kingston|Jamaica|America/Jamaica|18.00|-76.79|',
        'Nassau|Bahamas|America/Nassau|25.05|-77.35|',
        'Port-au-Prince|Haiti|America/Port-au-Prince|18.59|-72.31|',
        'Santo Domingo|Dominican Republic|America/Santo_Domingo|18.49|-69.93|',
        'Bridgetown|Barbados|America/Barbados|13.10|-59.62|',
        'Port of Spain|Trinidad and Tobago|America/Port_of_Spain|10.66|-61.51|',
        'Castries|Saint Lucia|America/St_Lucia|14.01|-60.99|',
        'Kingstown|Saint Vincent and the Grenadines|America/St_Vincent|13.16|-61.22|',
        'St. George\'s|Grenada|America/Grenada|12.06|-61.75|',
        'Roseau|Dominica|America/Dominica|15.30|-61.39|',
        'Basseterre|Saint Kitts and Nevis|America/St_Kitts|17.30|-62.72|',
        'St. John\'s|Antigua and Barbuda|America/Antigua|17.12|-61.85|',
        'Hamilton|Bermuda|Atlantic/Bermuda|32.29|-64.78|',
        'George Town|Cayman Islands|America/Cayman|19.29|-81.37|',
        'Oranjestad|Aruba|America/Aruba|12.52|-70.03|',
        'Willemstad|Curaçao|America/Curacao|12.11|-68.93|',
        'Fort-de-France|Martinique|America/Martinique|14.60|-61.07|',
        'Pointe-à-Pitre|Guadeloupe|America/Guadeloupe|16.24|-61.53|',
        'Cockburn Town|Turks and Caicos Islands|America/Grand_Turk|21.46|-71.14|',
        // South America
        'Bogotá|Colombia|America/Bogota|4.71|-74.07|',
        'Medellín|Colombia|America/Bogota|6.24|-75.58|',
        'Cali|Colombia|America/Bogota|3.45|-76.53|',
        'Lima|Peru|America/Lima|-12.05|-77.04|',
        'Quito|Ecuador|America/Guayaquil|-0.18|-78.47|',
        'Guayaquil|Ecuador|America/Guayaquil|-2.19|-79.89|',
        'Galápagos|Ecuador|Pacific/Galapagos|-0.90|-89.60|',
        'Caracas|Venezuela|America/Caracas|10.48|-66.90|',
        'Santiago|Chile|America/Santiago|-33.45|-70.67|',
        'Punta Arenas|Chile|America/Punta_Arenas|-53.16|-70.91|',
        'Easter Island|Chile|Pacific/Easter|-27.11|-109.35|Rapa Nui',
        'La Paz|Bolivia|America/La_Paz|-16.50|-68.15|',
        'Sucre|Bolivia|America/La_Paz|-19.04|-65.26|',
        'Santa Cruz|Bolivia|America/La_Paz|-17.78|-63.18|',
        'Asunción|Paraguay|America/Asuncion|-25.26|-57.58|',
        'Montevideo|Uruguay|America/Montevideo|-34.90|-56.16|',
        'Córdoba|Argentina|America/Argentina/Cordoba|-31.42|-64.18|',
        'Mendoza|Argentina|America/Argentina/Mendoza|-32.89|-68.83|',
        'Ushuaia|Argentina|America/Argentina/Ushuaia|-54.80|-68.30|',
        'Brasília|Brazil|America/Sao_Paulo|-15.79|-47.88|',
        'Rio de Janeiro|Brazil|America/Sao_Paulo|-22.91|-43.17|Rio',
        'Belo Horizonte|Brazil|America/Sao_Paulo|-19.92|-43.94|',
        'Porto Alegre|Brazil|America/Sao_Paulo|-30.03|-51.23|',
        'Curitiba|Brazil|America/Sao_Paulo|-25.43|-49.27|',
        'Salvador|Brazil|America/Bahia|-12.97|-38.50|Bahia',
        'Recife|Brazil|America/Recife|-8.05|-34.88|',
        'Fortaleza|Brazil|America/Fortaleza|-3.73|-38.52|',
        'Belém|Brazil|America/Belem|-1.46|-48.50|',
        'Manaus|Brazil|America/Manaus|-3.12|-60.02|Amazon',
        'Cuiabá|Brazil|America/Cuiaba|-15.60|-56.10|',
        'Rio Branco|Brazil|America/Rio_Branco|-9.97|-67.81|Acre',
        'Fernando de Noronha|Brazil|America/Noronha|-3.85|-32.42|Noronha',
        'Georgetown|Guyana|America/Guyana|6.80|-58.16|',
        'Paramaribo|Suriname|America/Paramaribo|5.85|-55.20|',
        'Cayenne|French Guiana|America/Cayenne|4.92|-52.31|',
        'Stanley|Falkland Islands|Atlantic/Stanley|-51.69|-57.86|Falklands',
        'King Edward Point|South Georgia|Atlantic/South_Georgia|-54.28|-36.50|South Georgia',
        'Nuuk|Greenland|America/Godthab|64.18|-51.72|Godthab',
        'Saint-Pierre|Saint Pierre and Miquelon|America/Miquelon|46.78|-56.18|Miquelon',
        // Europe
        'Manchester|United Kingdom|Europe/London|53.48|-2.24|',
        'Birmingham|United Kingdom|Europe/London|52.49|-1.89|',
        'Edinburgh|United Kingdom|Europe/London|55.95|-3.19|Scotland',
        'Glasgow|United Kingdom|Europe/London|55.86|-4.25|',
        'Belfast|United Kingdom|Europe/London|54.60|-5.93|Northern Ireland',
        'Cardiff|United Kingdom|Europe/London|51.48|-3.18|Wales',
        'Liverpool|United Kingdom|Europe/London|53.41|-2.98|',
        'Leeds|United Kingdom|Europe/London|53.80|-1.55|',
        'Bristol|United Kingdom|Europe/London|51.45|-2.59|',
        'Cambridge|United Kingdom|Europe/London|52.20|0.12|',
        'Oxford|United Kingdom|Europe/London|51.75|-1.26|',
        'Cork|Ireland|Europe/Dublin|51.90|-8.47|',
        'Porto|Portugal|Europe/Lisbon|41.15|-8.61|Oporto',
        'Ponta Delgada|Portugal|Atlantic/Azores|37.74|-25.67|Azores',
        'Funchal|Portugal|Atlantic/Madeira|32.65|-16.91|Madeira',
        'Barcelona|Spain|Europe/Madrid|41.39|2.17|',
        'Valencia|Spain|Europe/Madrid|39.47|-0.38|',
        'Seville|Spain|Europe/Madrid|37.39|-5.98|Sevilla',
        'Bilbao|Spain|Europe/Madrid|43.26|-2.93|',
        'Málaga|Spain|Europe/Madrid|36.72|-4.42|',
        'Palma|Spain|Europe/Madrid|39.57|2.65|Mallorca,Majorca',
        'Las Palmas|Spain|Atlantic/Canary|28.12|-15.43|Gran Canaria,Canary Islands',
        'Santa Cruz de Tenerife|Spain|Atlantic/Canary|28.46|-16.25|Tenerife',
        'Marseille|France|Europe/Paris|43.30|5.37|',
        'Lyon|France|Europe/Paris|45.76|4.84|',
        'Toulouse|France|Europe/Paris|43.60|1.44|',
        'Nice|France|Europe/Paris|43.70|7.27|',
        'Bordeaux|France|Europe/Paris|44.84|-0.58|',
        'Strasbourg|France|Europe/Paris|48.57|7.75|',
        'Lille|France|Europe/Paris|50.63|3.06|',
        'Monaco|Monaco|Europe/Monaco|43.74|7.42|Monte Carlo',
        'Andorra la Vella|Andorra|Europe/Andorra|42.51|1.52|',
        'Brussels|Belgium|Europe/Brussels|50.85|4.35|Bruxelles,Brussel',
        'Antwerp|Belgium|Europe/Brussels|51.22|4.40|Antwerpen',
        'Luxembourg|Luxembourg|Europe/Luxembourg|49.61|6.13|',
        'Rotterdam|Netherlands|Europe/Amsterdam|51.92|4.48|',
        'The Hague|Netherlands|Europe/Amsterdam|52.08|4.30|Den Haag',
        'Utrecht|Netherlands|Europe/Amsterdam|52.09|5.12|',
        'Eindhoven|Netherlands|Europe/Amsterdam|51.44|5.47|',
        'Munich|Germany|Europe/Berlin|48.14|11.58|München',
        'Hamburg|Germany|Europe/Berlin|53.55|9.99|',
        'Cologne|Germany|Europe/Berlin|50.94|6.96|Köln',
        'Stuttgart|Germany|Europe/Berlin|48.78|9.18|',
        'Düsseldorf|Germany|Europe/Berlin|51.23|6.77|',
        'Leipzig|Germany|Europe/Berlin|51.34|12.37|',
        'Geneva|Switzerland|Europe/Zurich|46.20|6.14|Genève',
        'Bern|Switzerland|Europe/Zurich|46.95|7.45|Berne',
        'Basel|Switzerland|Europe/Zurich|47.56|7.59|',
        'Lausanne|Switzerland|Europe/Zurich|46.52|6.63|',
        'Vaduz|Liechtenstein|Europe/Vaduz|47.14|9.52|',
        'Vienna|Austria|Europe/Vienna|48.21|16.37|Wien',
        'Salzburg|Austria|Europe/Vienna|47.81|13.04|',
        'Rome|Italy|Europe/Rome|41.90|12.50|Roma',
        'Milan|Italy|Europe/Rome|45.46|9.19|Milano',
        'Naples|Italy|Europe/Rome|40.85|14.27|Napoli',
        'Turin|Italy|Europe/Rome|45.07|7.69|Torino',
        'Florence|Italy|Europe/Rome|43.77|11.26|Firenze',
        'Venice|Italy|Europe/Rome|45.44|12.32|Venezia',
        'Bologna|Italy|Europe/Rome|44.49|11.34|',
        'Palermo|Italy|Europe/Rome|38.12|13.36|Sicily',
        'Vatican City|Vatican City|Europe/Vatican|41.90|12.45|Holy See',
        'San Marino|San Marino|Europe/San_Marino|43.94|12.45|',
        'Valletta|Malta|Europe/Malta|35.90|14.51|',
        'Copenhagen|Denmark|Europe/Copenhagen|55.68|12.57|København',
        'Stockholm|Sweden|Europe/Stockholm|59.33|18.07|',
        'Gothenburg|Sweden|Europe/Stockholm|57.71|11.97|Göteborg',
        'Malmö|Sweden|Europe/Stockholm|55.60|13.00|',
        'Oslo|Norway|Europe/Oslo|59.91|10.75|',
        'Bergen|Norway|Europe/Oslo|60.39|5.32|',
        'Longyearbyen|Svalbard|Arctic/Longyearbyen|78.22|15.65|Svalbard',
        'Helsinki|Finland|Europe/Helsinki|60.17|24.94|',
        'Reykjavík|Iceland|Atlantic/Reykjavik|64.15|-21.94|',
        'Tórshavn|Faroe Islands|Atlantic/Faroe|62.01|-6.77|',
        'Tallinn|Estonia|Europe/Tallinn|59.44|24.75|',
        'Riga|Latvia|Europe/Riga|56.95|24.11|',
        'Vilnius|Lithuania|Europe/Vilnius|54.69|25.28|',
        'Warsaw|Poland|Europe/Warsaw|52.23|21.01|Warszawa',
        'Kraków|Poland|Europe/Warsaw|50.06|19.94|Cracow',
        'Wrocław|Poland|Europe/Warsaw|51.11|17.04|Wroclaw',
        'Gdańsk|Poland|Europe/Warsaw|54.35|18.65|',
        'Prague|Czechia|Europe/Prague|50.08|14.44|Praha,Czech Republic',
        'Brno|Czechia|Europe/Prague|49.20|16.61|',
        'Bratislava|Slovakia|Europe/Bratislava|48.15|17.11|',
        'Budapest|Hungary|Europe/Budapest|47.50|19.04|',
        'Ljubljana|Slovenia|Europe/Ljubljana|46.06|14.51|',
        'Zagreb|Croatia|Europe/Zagreb|45.81|15.98|',
        'Split|Croatia|Europe/Zagreb|43.51|16.44|',
        'Sarajevo|Bosnia and Herzegovina|Europe/Sarajevo|43.86|18.41|',
        'Belgrade|Serbia|Europe/Belgrade|44.79|20.45|Beograd',
        'Podgorica|Montenegro|Europe/Podgorica|42.43|19.26|',
        'Pristina|Kosovo|Europe/Belgrade|42.66|21.17|Prishtina',
        'Skopje|North Macedonia|Europe/Skopje|42.00|21.43|Macedonia',
        'Tirana|Albania|Europe/Tirane|41.33|19.82|Tirane',
        'Sofia|Bulgaria|Europe/Sofia|42.70|23.32|',
        'Bucharest|Romania|Europe/Bucharest|44.43|26.10|București',
        'Cluj-Napoca|Romania|Europe/Bucharest|46.77|23.60|Cluj',
        'Chișinău|Moldova|Europe/Chisinau|47.01|28.86|Kishinev',
        'Thessaloniki|Greece|Europe/Athens|40.64|22.94|',
        'Nicosia|Cyprus|Asia/Nicosia|35.19|33.38|',
        'Limassol|Cyprus|Asia/Nicosia|34.68|33.04|',
        'Kyiv|Ukraine|Europe/Kiev|50.45|30.52|Kiev',
        'Kharkiv|Ukraine|Europe/Kiev|49.99|36.23|Kharkov',
        'Odesa|Ukraine|Europe/Kiev|46.48|30.72|Odessa',
        'Lviv|Ukraine|Europe/Kiev|49.84|24.03|Lvov',
        'Minsk|Belarus|Europe/Minsk|53.90|27.56|',
        'Saint Petersburg|Russia|Europe/Moscow|59.93|30.34|St Petersburg,Leningrad',
        'Kazan|Russia|Europe/Moscow|55.79|49.12|',
        'Sochi|Russia|Europe/Moscow|43.60|39.73|',
        'Kaliningrad|Russia|Europe/Kaliningrad|54.71|20.51|',
        'Samara|Russia|Europe/Samara|53.20|50.15|',
        'Volgograd|Russia|Europe/Volgograd|48.71|44.51|',
        'Gibraltar|Gibraltar|Europe/Gibraltar|36.14|-5.35|',
        'Douglas|Isle of Man|Europe/Isle_of_Man|54.15|-4.48|Isle of Man',
        'St Helier|Jersey|Europe/Jersey|49.19|-2.11|',
        'St Peter Port|Guernsey|Europe/Guernsey|49.46|-2.54|',
        'Ankara|Turkey|Europe/Istanbul|39.93|32.86|',
        'Izmir|Turkey|Europe/Istanbul|38.42|27.14|',
        'Antalya|Turkey|Europe/Istanbul|36.90|30.70|',
        // Russia east of the Urals
        'Yekaterinburg|Russia|Asia/Yekaterinburg|56.84|60.60|Ekaterinburg',
        'Omsk|Russia|Asia/Omsk|54.99|73.37|',
        'Novosibirsk|Russia|Asia/Novosibirsk|55.01|82.93|',
        'Krasnoyarsk|Russia|Asia/Krasnoyarsk|56.01|92.85|',
        'Irkutsk|Russia|Asia/Irkutsk|52.29|104.30|',
        'Yakutsk|Russia|Asia/Yakutsk|62.03|129.73|',
        'Vladivostok|Russia|Asia/Vladivostok|43.12|131.89|',
        'Yuzhno-Sakhalinsk|Russia|Asia/Sakhalin|46.96|142.73|Sakhalin',
        'Magadan|Russia|Asia/Magadan|59.56|150.80|',
        'Petropavlovsk-Kamchatsky|Russia|Asia/Kamchatka|53.02|158.65|Kamchatka',
        'Anadyr|Russia|Asia/Anadyr|64.73|177.50|Chukotka',
        // Middle East & Caucasus
        'Jerusalem|Israel|Asia/Jerusalem|31.77|35.21|',
        'Haifa|Israel|Asia/Jerusalem|32.79|34.99|',
        'Ramallah|Palestine|Asia/Hebron|31.90|35.20|West Bank',
        'Gaza|Palestine|Asia/Gaza|31.50|34.47|',
        'Amman|Jordan|Asia/Amman|31.95|35.93|',
        'Beirut|Lebanon|Asia/Beirut|33.89|35.50|',
        'Damascus|Syria|Asia/Damascus|33.51|36.29|',
        'Baghdad|Iraq|Asia/Baghdad|33.31|44.36|',
        'Erbil|Iraq|Asia/Baghdad|36.19|44.01|',
        'Basra|Iraq|Asia/Baghdad|30.51|47.81|',
        'Riyadh|Saudi Arabia|Asia/Riyadh|24.71|46.68|',
        'Jeddah|Saudi Arabia|Asia/Riyadh|21.49|39.19|Jiddah',
        'Mecca|Saudi Arabia|Asia/Riyadh|21.39|39.86|Makkah',
        'Dammam|Saudi Arabia|Asia/Riyadh|26.43|50.10|',
        'Kuwait City|Kuwait|Asia/Kuwait|29.38|47.99|',
        'Manama|Bahrain|Asia/Bahrain|26.23|50.59|',
        'Doha|Qatar|Asia/Qatar|25.29|51.53|',
        'Abu Dhabi|United Arab Emirates|Asia/Dubai|24.45|54.38|',
        'Sharjah|United Arab Emirates|Asia/Dubai|25.35|55.40|',
        'Muscat|Oman|Asia/Muscat|23.59|58.41|',
        'Sanaa|Yemen|Asia/Aden|15.37|44.19|Sana\'a',
        'Aden|Yemen|Asia/Aden|12.79|45.03|',
        'Mashhad|Iran|Asia/Tehran|36.30|59.60|',
        'Isfahan|Iran|Asia/Tehran|32.65|51.67|',
        'Tbilisi|Georgia|Asia/Tbilisi|41.72|44.79|',
        'Yerevan|Armenia|Asia/Yerevan|40.18|44.51|',
        'Baku|Azerbaijan|Asia/Baku|40.41|49.87|',
        // Central & South Asia
        'Tashkent|Uzbekistan|Asia/Tashkent|41.30|69.24|',
        'Samarkand|Uzbekistan|Asia/Samarkand|39.65|66.96|',
        'Ashgabat|Turkmenistan|Asia/Ashgabat|37.96|58.33|',
        'Dushanbe|Tajikistan|Asia/Dushanbe|38.56|68.79|',
        'Bishkek|Kyrgyzstan|Asia/Bishkek|42.87|74.59|',
        'Almaty|Kazakhstan|Asia/Almaty|43.24|76.89|Alma-Ata',
        'Astana|Kazakhstan|Asia/Almaty|51.17|71.43|Nur-Sultan',
        'Islamabad|Pakistan|Asia/Karachi|33.68|73.05|',
        'Lahore|Pakistan|Asia/Karachi|31.55|74.34|',
        'Kolkata|India|Asia/Kolkata|22.57|88.36|Calcutta',
        'Chennai|India|Asia/Kolkata|13.08|80.27|Madras',
        'Hyderabad|India|Asia/Kolkata|17.39|78.49|',
        'Pune|India|Asia/Kolkata|18.52|73.86|Poona',
        'Ahmedabad|India|Asia/Kolkata|23.02|72.57|',
        'Jaipur|India|Asia/Kolkata|26.91|75.79|',
        'Kochi|India|Asia/Kolkata|9.93|76.27|Cochin',
        'Lucknow|India|Asia/Kolkata|26.85|80.95|',
        'Chandigarh|India|Asia/Kolkata|30.73|76.78|',
        'Gurugram|India|Asia/Kolkata|28.46|77.03|Gurgaon',
        'Noida|India|Asia/Kolkata|28.54|77.39|',
        'Goa|India|Asia/Kolkata|15.50|73.83|Panaji',
        'Dhaka|Bangladesh|Asia/Dhaka|23.81|90.41|Dacca',
        'Chittagong|Bangladesh|Asia/Dhaka|22.36|91.78|Chattogram',
        'Thimphu|Bhutan|Asia/Thimphu|27.47|89.64|',
        'Pokhara|Nepal|Asia/Kathmandu|28.21|83.99|',
        'Malé|Maldives|Indian/Maldives|4.18|73.51|',
        'Sri Jayawardenepura Kotte|Sri Lanka|Asia/Colombo|6.89|79.92|Kotte',
        'Naypyidaw|Myanmar|Asia/Yangon|19.76|96.08|Nay Pyi Taw',
        // East & Southeast Asia
        'Guangzhou|China|Asia/Shanghai|23.13|113.26|Canton',
        'Shenzhen|China|Asia/Shanghai|22.54|114.06|',
        'Chengdu|China|Asia/Shanghai|30.57|104.07|',
        'Chongqing|China|Asia/Shanghai|29.56|106.55|',
        'Wuhan|China|Asia/Shanghai|30.59|114.31|',
        'Xi\'an|China|Asia/Shanghai|34.34|108.94|',
        'Hangzhou|China|Asia/Shanghai|30.27|120.15|',
        'Nanjing|China|Asia/Shanghai|32.06|118.80|',
        'Tianjin|China|Asia/Shanghai|39.34|117.36|',
        'Macau|Macau|Asia/Macau|22.20|113.54|Macao',
        'Kaohsiung|Taiwan|Asia/Taipei|22.63|120.30|',
        'Osaka|Japan|Asia/Tokyo|34.69|135.50|',
        'Kyoto|Japan|Asia/Tokyo|35.01|135.77|',
        'Yokohama|Japan|Asia/Tokyo|35.44|139.64|',
        'Nagoya|Japan|Asia/Tokyo|35.18|136.91|',
        'Sapporo|Japan|Asia/Tokyo|43.06|141.35|',
        'Fukuoka|Japan|Asia/Tokyo|33.59|130.40|',
        'Naha|Japan|Asia/Tokyo|26.21|127.68|Okinawa',
        'Busan|South Korea|Asia/Seoul|35.18|129.08|Pusan',
        'Incheon|South Korea|Asia/Seoul|37.46|126.71|',
        'Pyongyang|North Korea|Asia/Pyongyang|39.04|125.76|',
        'Ulaanbaatar|Mongolia|Asia/Ulaanbaatar|47.89|106.91|Ulan Bator',
        'Hanoi|Vietnam|Asia/Ho_Chi_Minh|21.03|105.85|',
        'Ho Chi Minh City|Vietnam|Asia/Ho_Chi_Minh|10.82|106.63|Saigon,HCMC',
        'Da Nang|Vietnam|Asia/Ho_Chi_Minh|16.05|108.20|Danang',
        'Phnom Penh|Cambodia|Asia/Phnom_Penh|11.56|104.92|',
        'Vientiane|Laos|Asia/Vientiane|17.98|102.63|',
        'Chiang Mai|Thailand|Asia/Bangkok|18.79|98.98|',
        'Phuket|Thailand|Asia/Bangkok|7.88|98.39|',
        'Kuala Lumpur|Malaysia|Asia/Kuala_Lumpur|3.14|101.69|KL',
        'Penang|Malaysia|Asia/Kuala_Lumpur|5.41|100.33|',
        'Kuching|Malaysia|Asia/Kuching|1.55|110.36|',
        'Kota Kinabalu|Malaysia|Asia/Kuching|5.98|116.07|',
        'Bandar Seri Begawan|Brunei|Asia/Brunei|4.90|114.94|',
        'Surabaya|Indonesia|Asia/Jakarta|-7.25|112.75|',
        'Bandung|Indonesia|Asia/Jakarta|-6.92|107.62|',
        'Medan|Indonesia|Asia/Jakarta|3.60|98.67|',
        'Pontianak|Indonesia|Asia/Pontianak|-0.03|109.33|',
        'Denpasar|Indonesia|Asia/Makassar|-8.65|115.22|Bali',
        'Makassar|Indonesia|Asia/Makassar|-5.15|119.43|',
        'Jayapura|Indonesia|Asia/Jayapura|-2.53|140.72|Papua',
        'Cebu|Philippines|Asia/Manila|10.32|123.89|',
        'Davao|Philippines|Asia/Manila|7.19|125.46|',
        'Dili|Timor-Leste|Asia/Dili|-8.56|125.57|East Timor',
        // Africa
        'Algiers|Algeria|Africa/Algiers|36.75|3.06|',
        'Tunis|Tunisia|Africa/Tunis|36.81|10.18|',
        'Tripoli|Libya|Africa/Tripoli|32.89|13.19|',
        'Alexandria|Egypt|Africa/Cairo|31.20|29.92|',
        'Rabat|Morocco|Africa/Casablanca|34.02|-6.84|',
        'Casablanca|Morocco|Africa/Casablanca|33.57|-7.59|',
        'Marrakesh|Morocco|Africa/Casablanca|31.63|-8.00|Marrakech',
        'Laayoune|Western Sahara|Africa/El_Aaiun|27.15|-13.20|El Aaiun',
        'Nouakchott|Mauritania|Africa/Nouakchott|18.08|-15.98|',
        'Dakar|Senegal|Africa/Dakar|14.72|-17.47|',
        'Banjul|Gambia|Africa/Banjul|13.45|-16.58|',
        'Bissau|Guinea-Bissau|Africa/Bissau|11.86|-15.60|',
        'Conakry|Guinea|Africa/Conakry|9.64|-13.58|',
        'Freetown|Sierra Leone|Africa/Freetown|8.48|-13.23|',
        'Monrovia|Liberia|Africa/Monrovia|6.30|-10.80|',
        'Abidjan|Côte d\'Ivoire|Africa/Abidjan|5.36|-4.01|Ivory Coast',
        'Yamoussoukro|Côte d\'Ivoire|Africa/Abidjan|6.82|-5.28|',
        'Bamako|Mali|Africa/Bamako|12.64|-8.00|',
        'Ouagadougou|Burkina Faso|Africa/Ouagadougou|12.37|-1.52|',
        'Niamey|Niger|Africa/Niamey|13.51|2.11|',
        'Accra|Ghana|Africa/Accra|5.60|-0.19|',
        'Lomé|Togo|Africa/Lome|6.13|1.22|',
        'Porto-Novo|Benin|Africa/Porto-Novo|6.50|2.60|',
        'Cotonou|Benin|Africa/Porto-Novo|6.37|2.39|',
        'Abuja|Nigeria|Africa/Lagos|9.08|7.40|',
        'Kano|Nigeria|Africa/Lagos|12.00|8.52|',
        'N\'Djamena|Chad|Africa/Ndjamena|12.13|15.06|',
        'Yaoundé|Cameroon|Africa/Douala|3.87|11.52|',
        'Douala|Cameroon|Africa/Douala|4.05|9.70|',
        'Bangui|Central African Republic|Africa/Bangui|4.39|18.56|',
        'Malabo|Equatorial Guinea|Africa/Malabo|3.75|8.78|',
        'Libreville|Gabon|Africa/Libreville|0.42|9.47|',
        'São Tomé|São Tomé and Príncipe|Africa/Sao_Tome|0.34|6.73|',
        'Brazzaville|Republic of the Congo|Africa/Brazzaville|-4.27|15.28|',
        'Kinshasa|DR Congo|Africa/Kinshasa|-4.32|15.31|Congo',
        'Lubumbashi|DR Congo|Africa/Lubumbashi|-11.66|27.48|',
        'Luanda|Angola|Africa/Luanda|-8.84|13.23|',
        'Khartoum|Sudan|Africa/Khartoum|15.50|32.56|',
        'Juba|South Sudan|Africa/Juba|4.85|31.58|',
        'Addis Ababa|Ethiopia|Africa/Addis_Ababa|9.03|38.74|',
        'Asmara|Eritrea|Africa/Asmara|15.32|38.93|',
        'Djibouti|Djibouti|Africa/Djibouti|11.59|43.15|',
        'Mogadishu|Somalia|Africa/Mogadishu|2.05|45.32|',
        'Mombasa|Kenya|Africa/Nairobi|-4.04|39.67|',
        'Kampala|Uganda|Africa/Kampala|0.35|32.58|',
        'Kigali|Rwanda|Africa/Kigali|-1.95|30.06|',
        'Gitega|Burundi|Africa/Bujumbura|-3.43|29.93|',
        'Bujumbura|Burundi|Africa/Bujumbura|-3.38|29.36|',
        'Dodoma|Tanzania|Africa/Dar_es_Salaam|-6.16|35.75|',
        'Dar es Salaam|Tanzania|Africa/Dar_es_Salaam|-6.79|39.21|',
        'Zanzibar|Tanzania|Africa/Dar_es_Salaam|-6.16|39.20|',
        'Lusaka|Zambia|Africa/Lusaka|-15.39|28.32|',
        'Lilongwe|Malawi|Africa/Blantyre|-13.96|33.79|',
        'Harare|Zimbabwe|Africa/Harare|-17.83|31.05|',
        'Gaborone|Botswana|Africa/Gaborone|-24.65|25.91|',
        'Windhoek|Namibia|Africa/Windhoek|-22.56|17.08|',
        'Pretoria|South Africa|Africa/Johannesburg|-25.75|28.19|Tshwane',
        'Cape Town|South Africa|Africa/Johannesburg|-33.92|18.42|',
        'Durban|South Africa|Africa/Johannesburg|-29.86|31.03|',
        'Maseru|Lesotho|Africa/Maseru|-29.31|27.48|',
        'Mbabane|Eswatini|Africa/Mbabane|-26.31|31.14|Swaziland',
        'Antananarivo|Madagascar|Indian/Antananarivo|-18.88|47.51|',
        'Port Louis|Mauritius|Indian/Mauritius|-20.16|57.50|',
        'Victoria|Seychelles|Indian/Mahe|-4.62|55.45|',
        'Moroni|Comoros|Indian/Comoro|-11.70|43.26|',
        'Saint-Denis|Réunion|Indian/Reunion|-20.88|55.45|',
        'Mamoudzou|Mayotte|Indian/Mayotte|-12.78|45.23|',
        'Praia|Cabo Verde|Atlantic/Cape_Verde|14.93|-23.51|Cape Verde',
        'Jamestown|Saint Helena|Atlantic/St_Helena|-15.93|-5.72|St Helena',
        // Oceania & the Pacific, Indian Ocean, Antarctica
        'Melbourne|Australia|Australia/Melbourne|-37.81|144.96|',
        'Brisbane|Australia|Australia/Brisbane|-27.47|153.03|Queensland',
        'Canberra|Australia|Australia/Sydney|-35.28|149.13|',
        'Darwin|Australia|Australia/Darwin|-12.46|130.84|',
        'Hobart|Australia|Australia/Hobart|-42.88|147.33|Tasmania',
        'Gold Coast|Australia|Australia/Brisbane|-28.02|153.40|',
        'Cairns|Australia|Australia/Brisbane|-16.92|145.77|',
        'Alice Springs|Australia|Australia/Darwin|-23.70|133.88|',
        'Broken Hill|Australia|Australia/Broken_Hill|-31.95|141.47|',
        'Eucla|Australia|Australia/Eucla|-31.68|128.88|',
        'Lord Howe Island|Australia|Australia/Lord_Howe|-31.55|159.08|Lord Howe',
        'Norfolk Island|Norfolk Island|Pacific/Norfolk|-29.06|167.96|',
        'Wellington|New Zealand|Pacific/Auckland|-41.29|174.78|',
        'Christchurch|New Zealand|Pacific/Auckland|-43.53|172.64|',
        'Queenstown|New Zealand|Pacific/Auckland|-45.03|168.66|',
        'Chatham Islands|New Zealand|Pacific/Chatham|-43.95|-176.56|Chatham,Waitangi',
        'Suva|Fiji|Pacific/Fiji|-18.14|178.44|',
        'Port Moresby|Papua New Guinea|Pacific/Port_Moresby|-9.44|147.18|',
        'Honiara|Solomon Islands|Pacific/Guadalcanal|-9.43|159.95|',
        'Port Vila|Vanuatu|Pacific/Efate|-17.73|168.32|',
        'Nouméa|New Caledonia|Pacific/Noumea|-22.28|166.46|',
        'Apia|Samoa|Pacific/Apia|-13.83|-171.76|',
        'Nuku\'alofa|Tonga|Pacific/Tongatapu|-21.14|-175.20|',
        'Funafuti|Tuvalu|Pacific/Funafuti|-8.52|179.20|',
        'South Tarawa|Kiribati|Pacific/Tarawa|1.33|172.98|Tarawa',
        'Kiritimati|Kiribati|Pacific/Kiritimati|1.87|-157.43|Christmas Island Kiribati,Line Islands',
        'Kanton|Kiribati|Pacific/Enderbury|-2.80|-171.70|Phoenix Islands,Enderbury',
        'Majuro|Marshall Islands|Pacific/Majuro|7.09|171.38|',
        'Palikir|Micronesia|Pacific/Pohnpei|6.92|158.16|Pohnpei',
        'Yaren|Nauru|Pacific/Nauru|-0.55|166.92|',
        'Ngerulmud|Palau|Pacific/Palau|7.50|134.62|Koror',
        'Papeete|French Polynesia|Pacific/Tahiti|-17.54|-149.57|Tahiti',
        'Taiohae|French Polynesia|Pacific/Marquesas|-8.91|-140.10|Marquesas',
        'Rikitea|French Polynesia|Pacific/Gambier|-23.12|-134.97|Gambier',
        'Avarua|Cook Islands|Pacific/Rarotonga|-21.21|-159.78|Rarotonga',
        'Alofi|Niue|Pacific/Niue|-19.06|-169.92|',
        'Adamstown|Pitcairn Islands|Pacific/Pitcairn|-25.07|-130.10|Pitcairn',
        'Mata-Utu|Wallis and Futuna|Pacific/Wallis|-13.28|-176.17|Wallis',
        'Fakaofo|Tokelau|Pacific/Fakaofo|-9.38|-171.22|',
        'McMurdo Station|Antarctica|Antarctica/McMurdo|-77.85|166.67|McMurdo',
        'Diego Garcia|British Indian Ocean Territory|Indian/Chagos|-7.31|72.41|Chagos',
        'Flying Fish Cove|Christmas Island|Indian/Christmas|-10.42|105.68|',
        'West Island|Cocos (Keeling) Islands|Indian/Cocos|-12.19|96.83|Cocos'
      ];
    }
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ===========================================================================
  // Widget
  // ===========================================================================
  var Cade = window.Cade;
  Cade.loadCSS('worldclock.css');

  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  var PANEL_ID = 'worldclock-panel';
  var UI_KEY = 'cade-worldclock-ui';          // per device: last tab
  var DATA_KEY = 'cade-worldclock-data';      // only without Cade.syncedBlob (old core)
  var MIN = Core.MIN, SLOT = Core.SLOT;
  var MAX_PLACES = 30;
  var SUGGEST = ['London', 'New York', 'Tokyo', 'San Francisco', 'Singapore', 'Sydney', 'Berlin', 'Mumbai', 'Dubai', 'Hong Kong', 'Chicago', 'São Paulo'];
  var SUN = { day: '\u2600\ufe0e', dawn: '\u2600\ufe0e', dusk: '\u2600\ufe0e', night: '\u263e' };  // VS15: text, not emoji
  var SUN_T = { day: 'Daylight', dawn: 'Dawn', dusk: 'Dusk', night: 'Night' };
  var ICON_GEAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  var store = null;   // { get, set } — synced blob (or Cade.store fallback)
  var data = null;    // normalized places + prefs
  var S = null;       // state of the open panel
  var index = null;   // city / zone search index (dropped on close)

  // ---- data -----------------------------------------------------------------------
  function defaults() { return { v: 1, places: [], h24: null, secs: false, ws: 540, we: 1020, wkend: true, ins: 'line', names: {} }; }
  function str(v, n) { return typeof v === 'string' ? v.trim().slice(0, n) : ''; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function newId() { return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
  // Defensive: another device may run older (or newer) code. A place whose zone
  // this browser doesn't know is KEPT (just not shown), so saving here never
  // deletes it from a device that can show it.
  function normalize(d) {
    var o = defaults(), seen = {};
    if (!d || typeof d !== 'object') return o;
    if (Array.isArray(d.places)) {
      d.places.forEach(function (p) {
        if (!p || typeof p !== 'object' || typeof p.zone !== 'string' || !/^[A-Za-z0-9_+\-\/:]{1,64}$/.test(p.zone) || o.places.length >= MAX_PLACES) return;
        var id = /^[A-Za-z0-9]{1,24}$/.test(p.id) ? p.id : newId();
        if (seen[id]) id = newId();
        seen[id] = 1;
        o.places.push({ id: id, zone: p.zone, name: str(p.name, 60) || Core.zoneCity(p.zone), country: str(p.country, 60),
          label: str(p.label, 60), lat: num(p.lat), lon: num(p.lon) });
      });
    }
    if (typeof d.h24 === 'boolean') o.h24 = d.h24;
    o.secs = d.secs === true;
    if (typeof d.ws === 'number' && d.ws >= 0 && d.ws < 1440 && d.ws % 30 === 0) o.ws = d.ws;
    if (typeof d.we === 'number' && d.we > 0 && d.we <= 1440 && d.we % 30 === 0) o.we = d.we;
    if (o.ws === o.we) { o.ws = 540; o.we = 1020; }
    o.wkend = d.wkend !== false;
    o.ins = d.ins === 'lines' ? 'lines' : 'line';
    if (d.names && typeof d.names === 'object') {
      for (var k in d.names) if (Object.prototype.hasOwnProperty.call(d.names, k) && str(d.names[k], 60) && Object.keys(o.names).length < 20) o.names[k.slice(0, 64)] = str(d.names[k], 60);
    }
    return o;
  }
  function storeInit() {
    if (store) return;
    if (typeof Cade.syncedBlob === 'function') {
      try {
        var b = Cade.syncedBlob('worldclock', { onChange: function (d) { data = normalize(d); onRemote(); } });
        store = { get: function () { return b.get(); }, set: function (v) { b.set(v); } };
      } catch (e) { store = null; }
    }
    if (!store) {
      store = {
        get: function () { try { return JSON.parse(Cade.store.get(DATA_KEY) || 'null'); } catch (e) { return null; } },
        set: function (v) { try { Cade.store.set(DATA_KEY, JSON.stringify(v)); } catch (e) {} }
      };
    }
    data = normalize(store.get());
  }
  function save() { try { store.set(JSON.parse(JSON.stringify(data))); } catch (e) {} }
  function uiGet() { try { return JSON.parse(Cade.store.get(UI_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function uiSet(o) { try { Cade.store.set(UI_KEY, JSON.stringify(o)); } catch (e) {} }

  // The city table is indexed on open; the ~400 IANA zones join on the first search / conversion.
  function idx() {
    if (!index) index = Core.buildIndex(Core.CITIES, null);
    return index;
  }
  function idxAll() {
    var ix = idx();
    if (!ix.zones) {
      var iana = [];
      try { if (typeof Intl.supportedValuesOf === 'function') iana = Intl.supportedValuesOf('timeZone'); } catch (e) {}
      Core.addZones(ix, iana);
    }
    return ix;
  }
  var devH12 = null;   // the device's 12/24-hour habit, read once per open
  function h12() {
    if (data.h24 != null) return !data.h24;
    if (devH12 == null) devH12 = Core.deviceH12();
    return devH12;
  }
  function label(p) { return p.label || p.name; }
  // Your own zone (from this device). Its custom name is keyed by the table's zone id,
  // so Chrome's "Asia/Calcutta" and Safari's "Asia/Kolkata" share one label.
  function makeLocal() {
    var z = Core.deviceZone(), e = Core.placeForZone(idx(), z), key = e ? e.zone : z;
    return { id: 'local', local: true, zone: z, key: key, name: e ? e.name : Core.zoneCity(z), country: e ? e.country : '',
      label: data.names[key] || '', lat: e ? e.lat : null, lon: e ? e.lon : null };
  }
  function mine() { return data.places.filter(function (p) { return Core.validZone(p.zone); }); }   // the ones this browser can show
  function places() { return [S.local].concat(mine()); }
  function byId(id) { var all = places(); for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i]; return null; }
  function weekendFor(p) { return data.wkend ? Core.weekendOf(p.country) : null; }
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 1800); } catch (e) {} }
  function q(sel) { return S ? S.panel.querySelector(sel) : null; }
  function qa(sel) { return S ? Array.prototype.slice.call(S.panel.querySelectorAll(sel)) : []; }
  function pct(f) { return (Math.round(f * 100000) / 1000) + '%'; }
  // "2:42" + small "PM" (12 h) or "14:42"; seconds small too.
  function timeHtml(p, withSecs) {
    var t = Core.fmtTime(p.h, p.mi, h12()), m = /^(.*?)( [AP]M)?$/.exec(t);
    return esc(m[1]) + (withSecs ? '<small class="wc-s">:' + (p.s < 10 ? '0' : '') + p.s + '</small>' : '') + (m[2] ? '<small>' + m[2].trim() + '</small>' : '');
  }
  function fmtT(p) { return Core.fmtTime(p.h, p.mi, h12()); }

  // ---- panel ------------------------------------------------------------------------------
  function tabBtn(v, t) { return '<button type="button" class="wc-tab" role="tab" data-tab="' + v + '" aria-selected="false">' + t + '</button>'; }
  function workOptions(sel, end) {
    var h = '';
    for (var m = end ? 30 : 0; m <= (end ? 1440 : 1410); m += 30) {
      var t = m === 1440 ? (h12() ? '12:00 AM (midnight)' : '24:00') : Core.fmtTime(Math.floor(m / 60), m % 60, h12());
      h += '<option value="' + m + '"' + (m === sel ? ' selected' : '') + '>' + t + '</option>';
    }
    return h;
  }
  function bodyHtml() {
    return '<div class="wc-tabs" role="tablist" aria-label="World Clock views">' + tabBtn('clocks', 'Clocks') + tabBtn('plan', 'Planner') + tabBtn('conv', 'Convert') + '</div>' +
      '<div class="wc-view" data-v="clocks" role="tabpanel" hidden>' +
        '<div class="wc-list"></div>' +
        '<div class="wc-undo" hidden><span class="wc-undo-t"></span><button type="button" class="wc-btn" data-act="undo">Undo</button></div>' +
        '<div class="wc-add" hidden>' +
          '<div class="wc-addbar"><input class="wc-search wc-in" type="search" placeholder="City, country or time zone" aria-label="Search places" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go">' +
          '<button type="button" class="wc-btn" data-act="add-close">Done</button></div>' +
          '<div class="wc-hits" role="listbox" aria-label="Matching places"></div>' +
        '</div>' +
        '<div class="wc-tools"><button type="button" class="wc-btn wc-addbtn" data-act="add">+ Add place</button><button type="button" class="wc-btn wc-editbtn" data-act="edit">Edit</button></div>' +
      '</div>' +
      '<div class="wc-view" data-v="plan" role="tabpanel" hidden>' +
        '<div class="wc-datebar">' +
          '<button type="button" class="wc-ibtn" data-act="day-prev" aria-label="Previous day">‹</button>' +
          '<label class="wc-datewrap"><span class="wc-date"></span><input class="wc-dinput" type="date" aria-label="Meeting date (your calendar)"></label>' +
          '<button type="button" class="wc-ibtn" data-act="day-next" aria-label="Next day">›</button>' +
          '<button type="button" class="wc-chip" data-act="day-today">Today</button>' +
        '</div>' +
        '<div class="wc-tl" tabindex="0" role="slider" aria-label="Meeting time, your time (arrow keys: 15 minutes)"></div>' +
        '<button type="button" class="wc-ovsum" data-act="jump"></button>' +
        '<div class="wc-legend" aria-hidden="true"><span><i class="wc-sw work"></i>Working</span><span><i class="wc-sw day"></i>Awake</span><span><i class="wc-sw night"></i>Night</span><span class="wc-lg-off"><i class="wc-sw off"></i>Weekend</span></div>' +
        '<div class="wc-acts"><button type="button" class="wc-btn" data-act="plan-now">Now</button><span class="wc-sp"></span>' +
          '<button type="button" class="wc-btn" data-act="plan-copy">Copy</button><button type="button" class="wc-btn primary" data-act="plan-insert" title="Insert this time for every place into the note">Insert</button></div>' +
      '</div>' +
      '<div class="wc-view" data-v="conv" role="tabpanel" hidden>' +
        '<input class="wc-q wc-in" type="text" placeholder="3pm London · tomorrow 9:30 Tokyo · noon PT" aria-label="Time to convert, e.g. 3pm London" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done">' +
        '<div class="wc-qstat" aria-live="polite"></div>' +
        '<div class="wc-pick">' +
          '<select class="wc-psel wc-in" aria-label="Place"></select>' +
          '<input class="wc-ptime wc-in" type="time" aria-label="Time there">' +
          '<input class="wc-pdate wc-in" type="date" aria-label="Date there">' +
        '</div>' +
        '<div class="wc-res"></div>' +
        '<div class="wc-acts"><button type="button" class="wc-btn" data-act="conv-plan" title="Open this time in the meeting planner">Planner</button><span class="wc-sp"></span>' +
          '<button type="button" class="wc-btn" data-act="conv-copy">Copy</button><button type="button" class="wc-btn primary" data-act="conv-insert" title="Insert this time for every place into the note">Insert</button></div>' +
      '</div>' +
      '<div class="wc-sheet" hidden role="dialog" aria-label="World Clock settings">' +
        '<div class="wc-sheet-h"><span>Settings</span><button type="button" class="wc-btn" data-act="sheet-close">Done</button></div>' +
        '<div class="wc-sheet-b"></div>' +
      '</div>';
  }
  function sheetHtml() {
    var hv = data.h24 == null ? 'auto' : data.h24 ? '24' : '12';
    return '<label class="wc-pref"><span>Clock</span><select class="wc-in" data-pref="h24">' +
        '<option value="auto"' + (hv === 'auto' ? ' selected' : '') + '>Device default (' + (Core.deviceH12() ? '12' : '24') + '-hour)</option>' +
        '<option value="12"' + (hv === '12' ? ' selected' : '') + '>12-hour</option><option value="24"' + (hv === '24' ? ' selected' : '') + '>24-hour</option></select></label>' +
      '<label class="wc-pref wc-check"><input type="checkbox" data-pref="secs"' + (data.secs ? ' checked' : '') + '><span>Show seconds</span></label>' +
      '<div class="wc-pref wc-whrow"><span>Working hours</span><span class="wc-wh"><select class="wc-in" data-pref="ws" aria-label="Working hours start">' + workOptions(data.ws, false) + '</select>' +
        '<span class="wc-dash">–</span><select class="wc-in" data-pref="we" aria-label="Working hours end">' + workOptions(data.we, true) + '</select></span></div>' +
      '<label class="wc-pref wc-check"><input type="checkbox" data-pref="wkend"' + (data.wkend ? ' checked' : '') + '><span>Weekends aren’t working hours <small>(Fri–Sat where that’s the weekend)</small></span></label>' +
      '<label class="wc-pref"><span>Insert / Copy as</span><select class="wc-in" data-pref="ins">' +
        '<option value="line"' + (data.ins === 'line' ? ' selected' : '') + '>One line</option><option value="lines"' + (data.ins === 'lines' ? ' selected' : '') + '>A line per place</option></select></label>' +
      '<p class="wc-fine">Your places and these settings sync across your devices when sync is on. Your own time zone always comes from the device you’re on.</p>';
  }

  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    storeInit();
    var ui = uiGet();
    var p = Cade.mkPanel(PANEL_ID, '🕐 World Clock', bodyHtml());
    var gear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'wc-hbtn';
    gear.title = 'Settings';
    gear.setAttribute('aria-label', 'World Clock settings');
    gear.innerHTML = ICON_GEAR;
    var head = p.querySelector('.cade-panel-head');
    if (head) head.insertBefore(gear, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    gear.addEventListener('pointerdown', function (e) { e.stopPropagation(); }); // the header drags the panel; this is a control
    gear.addEventListener('click', function () { toggleSheet(); });

    devH12 = null;
    S = { panel: p, gear: gear, timer: 0, tab: '', local: null, editing: false, adding: false, rows: {}, todayKey: '',
      plan: null, conv: null, pd: null, raf: 0, drag: null, undo: null, undoT: 0, trCache: {}, pendingRemote: false, searchT: 0, convT: 0 };
    S.local = makeLocal();
    var now = Date.now(), lp = Core.partsAt(S.local.zone, now);
    S.todayKey = Core.ymdKey(lp);
    S.plan = { ymd: { y: lp.y, m: lp.m, d: lp.d }, cur: Math.floor(now / SLOT) * SLOT, wall: lp.h * 60 + Math.floor(lp.mi / 15) * 15 };
    var nh = Core.partsAt(S.local.zone, Core.zonedToUtc(lp.y, lp.m, lp.d, lp.h + 1, 0, S.local.zone));   // the next whole hour here
    S.conv = { src: 'local', tmp: null, ymd: { y: nh.y, m: nh.m, d: nh.d }, h: nh.h, mi: nh.mi };

    bind(p);
    S.onVis = function () { if (!S) return; if (document.hidden) stopTimer(); else resume(); };
    S.onMin = function () { stopTimer(); };
    S.onRestore = function () { resume(); };
    document.addEventListener('visibilitychange', S.onVis);
    p.addEventListener('cade-panel-minimize', S.onMin);
    p.addEventListener('cade-panel-restore', S.onRestore);
    p._onClose = teardown;

    renderClocks();
    switchTab(ui.tab === 'plan' || ui.tab === 'conv' ? ui.tab : 'clocks', true);
  }
  function close() {
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    teardown();
  }
  function teardown() {
    if (!S) return;
    stopTimer();
    clearTimeout(S.undoT); clearTimeout(S.searchT); clearTimeout(S.convT);
    if (S.raf) cancelAnimationFrame(S.raf);
    document.removeEventListener('visibilitychange', S.onVis);
    S.panel.removeEventListener('cade-panel-minimize', S.onMin);
    S.panel.removeEventListener('cade-panel-restore', S.onRestore);
    S = null;
    index = null; // ~1k search entries: rebuilt in a few ms on the next open
  }

  // ---- timer: on the minute (or the second), only while visible --------------------------
  function paused() { return !S || document.hidden || !S.panel.isConnected || !!(Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function stopTimer() { if (S && S.timer) { clearTimeout(S.timer); S.timer = 0; } }
  function schedule() {
    stopTimer();
    if (paused()) return;
    var now = Date.now(), secs = data.secs && S.tab === 'clocks' && !S.editing;
    S.timer = setTimeout(tick, secs ? 1000 - now % 1000 + 10 : MIN - now % MIN + 20);
  }
  function tick() { if (!S) return; S.timer = 0; if (paused()) return; refresh(false); schedule(); }
  function resume() { if (paused()) return; refresh(true); schedule(); }
  function refresh(full) {
    var now = Date.now(), lp = Core.partsAt(S.local.zone, now), key = Core.ymdKey(lp);
    if (key !== S.todayKey) { S.todayKey = key; full = true; }
    if (S.tab === 'clocks' && !S.editing) updateClocks(now, full || lp.s < 1 || data.secs === false);
    else if (S.tab === 'plan') { updateNow(now); updateTodayChip(); }
    else if (S.tab === 'conv' && full) renderConv();
  }

  // ---- tabs & events --------------------------------------------------------------------------
  function switchTab(v, first) {
    if (!S || (S.tab === v && !first)) return;
    if (S.editing && v !== 'clocks') setEditing(false);
    S.tab = v;
    qa('.wc-tab').forEach(function (b) { var on = b.getAttribute('data-tab') === v; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    qa('.wc-view').forEach(function (el) { el.hidden = el.getAttribute('data-v') !== v; });
    var ui = uiGet(); ui.tab = v; uiSet(ui);
    if (v === 'clocks') updateClocks(Date.now(), true);
    else if (v === 'plan') renderPlan();
    else renderConv();
    schedule();
  }
  function bind(p) {
    var body = p.querySelector('.cade-panel-body');
    body.addEventListener('click', function (e) {
      if (!S) return;
      var t = e.target, b = t.closest ? t.closest('[data-act],[data-tab],[data-hit],[data-sug]') : null;
      if (!b || !body.contains(b)) return;
      if (b.hasAttribute('data-tab')) { switchTab(b.getAttribute('data-tab')); return; }
      if (b.hasAttribute('data-hit')) { addHit(+b.getAttribute('data-hit')); return; }
      if (b.hasAttribute('data-sug')) { addByName(b.getAttribute('data-sug')); return; }
      act(b.getAttribute('data-act'), b, e);
    });
    body.addEventListener('change', function (e) {
      var t = e.target;
      if (!S || !t) return;
      if (t.hasAttribute('data-pref')) setPref(t.getAttribute('data-pref'), t.type === 'checkbox' ? t.checked : t.value);
      else if (t.classList.contains('wc-lbl')) rename(t.getAttribute('data-id'), t.value);
      else if (t.classList.contains('wc-dinput')) { var o = Core.parseYmd(t.value); if (o) setPlanDate(o); }
      else if (t.classList.contains('wc-psel') || t.classList.contains('wc-ptime') || t.classList.contains('wc-pdate')) convFromPick();
    });
    body.addEventListener('input', function (e) {
      var t = e.target;
      if (!S || !t) return;
      if (t.classList.contains('wc-search')) { clearTimeout(S.searchT); S.searchT = setTimeout(renderHits, 60); }
      else if (t.classList.contains('wc-q')) { clearTimeout(S.convT); S.convT = setTimeout(convFromText, 120); }
    });
    body.addEventListener('keydown', function (e) {
      var t = e.target;
      if (!S || !t) return;
      if (t.classList.contains('wc-search')) searchKey(e);
      else if (t.classList.contains('wc-lbl') && e.key === 'Enter') { e.preventDefault(); t.blur(); }
      else if (t.classList.contains('wc-q') && e.key === 'Enter') { e.preventDefault(); clearTimeout(S.convT); convFromText(); }
      else if (t.classList.contains('wc-tl')) planKey(e);
      else if (e.key === 'Escape' && !S.panel.querySelector('.wc-sheet').hidden) { e.preventDefault(); toggleSheet(false); }
    });
    var tl = p.querySelector('.wc-tl');
    tl.addEventListener('pointerdown', planDown);
    tl.addEventListener('pointermove', planMove);
    tl.addEventListener('pointerup', planUp);
    tl.addEventListener('pointercancel', function () { if (S) S.pd = null; });
    var list = p.querySelector('.wc-list');
    list.addEventListener('pointerdown', gripDown);
    list.addEventListener('pointermove', gripMove);
    list.addEventListener('pointerup', gripUp);
    list.addEventListener('pointercancel', gripUp);
  }
  function act(a, b) {
    switch (a) {
      case 'add': setAdding(true); break;
      case 'add-close': setAdding(false); break;
      case 'edit': setEditing(!S.editing); break;
      case 'up': case 'down': move(b.getAttribute('data-id'), a === 'up' ? -1 : 1); break;
      case 'del': removePlace(b.getAttribute('data-id')); break;
      case 'undo': undoRemove(); break;
      case 'sheet-close': toggleSheet(false); break;
      case 'day-prev': setPlanDate(Core.addDays(S.plan.ymd, -1)); break;
      case 'day-next': setPlanDate(Core.addDays(S.plan.ymd, 1)); break;
      case 'day-today': planNow(); break;
      case 'plan-now': planNow(); break;
      case 'jump': if (S.plan.jumpTo != null) setCursor(S.plan.jumpTo); break;
      case 'plan-copy': copyText(planText()); break;
      case 'plan-insert': insertText(planText()); break;
      case 'conv-copy': copyText(convText()); break;
      case 'conv-insert': insertText(convText()); break;
      case 'conv-plan': convToPlan(); break;
      case 'conv-add': if (S.conv.tmp) addEntry(S.conv.tmp, true); break;
      case 'conv-sug': useSuggestion(); break;
      case 'search-sug': var si = q('.wc-search'); si.value = b.getAttribute('data-q'); renderHits(); if (!coarse()) si.focus(); break;
    }
  }

  // ---- settings sheet ----------------------------------------------------------------------------
  function toggleSheet(on) {
    var sh = q('.wc-sheet');
    if (!sh) return;
    if (on == null) on = sh.hidden;
    if (on) { q('.wc-sheet-b').innerHTML = sheetHtml(); sh.hidden = false; S.gear.classList.add('on'); var f = sh.querySelector('select'); if (f && !coarse()) f.focus(); }
    else { sh.hidden = true; S.gear.classList.remove('on'); }
  }
  function setPref(k, v) {
    var fixed = false;
    if (k === 'h24') data.h24 = v === 'auto' ? null : v === '24';
    else if (k === 'secs') data.secs = !!v;
    else if (k === 'wkend') data.wkend = !!v;
    else if (k === 'ins') data.ins = v === 'lines' ? 'lines' : 'line';
    else if (k === 'ws' || k === 'we') {
      var n = +v;
      if (k === 'ws') data.ws = n; else data.we = n;
      if (data.ws === data.we) { toast('Working hours need a start and an end', 'error'); fixed = true; if (k === 'ws') data.ws = (data.we + 1410) % 1440; else data.we = data.ws + 30; }
    }
    save();
    if (k === 'h24' || fixed) q('.wc-sheet-b').innerHTML = sheetHtml();   // labels follow the format; a fixed-up range shows
    rerenderAll();
  }
  function rerenderAll() {
    if (!S) return;
    renderClocks();
    if (S.tab === 'plan') renderPlan(); else if (S.tab === 'conv') renderConv(); else updateClocks(Date.now(), true);
    schedule();
  }
  function onRemote() {
    if (!S) return;
    if (S.editing || S.adding) { S.pendingRemote = true; return; }
    S.local.label = data.names[S.local.key] || '';
    rerenderAll();
  }
  function coarse() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }

  // ---- Clocks ---------------------------------------------------------------------------------------
  function renderClocks() {
    if (!S) return;
    var list = q('.wc-list'), all = places(), html = '';
    S.rows = {};
    all.forEach(function (p, i) {
      if (S.editing) {
        html += '<div class="wc-row edit' + (p.local ? ' local' : '') + '" data-id="' + esc(p.id) + '">' +
          (p.local ? '<span class="wc-pin" title="Your time zone — always first" aria-hidden="true">⌂</span>' : '<span class="wc-grip" role="img" aria-label="Drag to reorder" title="Drag to reorder">⠇</span>') +
          '<input class="wc-lbl wc-in" data-id="' + esc(p.id) + '" value="' + esc(label(p)) + '" aria-label="Name for ' + esc(p.name) + '" maxlength="60" placeholder="' + esc(p.name) + '" spellcheck="false" enterkeyhint="done">' +
          (p.local ? '<span class="wc-edit-note">your zone</span>'
            : '<button type="button" class="wc-ib" data-act="up" data-id="' + esc(p.id) + '" aria-label="Move ' + esc(label(p)) + ' up"' + (i <= 1 ? ' disabled' : '') + '>▲</button>' +
              '<button type="button" class="wc-ib" data-act="down" data-id="' + esc(p.id) + '" aria-label="Move ' + esc(label(p)) + ' down"' + (i === all.length - 1 ? ' disabled' : '') + '>▼</button>' +
              '<button type="button" class="wc-ib wc-del" data-act="del" data-id="' + esc(p.id) + '" aria-label="Remove ' + esc(label(p)) + '">✕</button>') +
          '</div>';
      } else {
        html += '<div class="wc-row' + (p.local ? ' local' : '') + '" data-id="' + esc(p.id) + '">' +
          '<span class="wc-sun" role="img"></span>' +
          '<div class="wc-mid"><div class="wc-name"><span class="wc-nm">' + esc(label(p)) + '</span>' + (p.local ? '<span class="wc-you">you</span>' : '') + '</div>' +
            '<div class="wc-sub"></div><div class="wc-note" hidden></div></div>' +
          '<div class="wc-right"><div class="wc-time"></div><div class="wc-rel"></div></div>' +
          '</div>';
      }
    });
    if (!S.editing && !S.adding && !mine().length) html += suggestHtml();
    list.innerHTML = html;
    list.classList.toggle('editing', S.editing);
    if (!S.editing) {
      qa('.wc-list .wc-row').forEach(function (el) {
        S.rows[el.getAttribute('data-id')] = { sun: el.querySelector('.wc-sun'), sub: el.querySelector('.wc-sub'), note: el.querySelector('.wc-note'),
          time: el.querySelector('.wc-time'), rel: el.querySelector('.wc-rel'), k: {} };
      });
    }
    var eb = q('.wc-editbtn');
    if (eb) { eb.textContent = S.editing ? 'Done' : 'Edit'; eb.classList.toggle('primary', S.editing); eb.hidden = !mine().length && !S.editing; }
    var tools = q('.wc-tools');
    if (tools) tools.hidden = S.adding;
    if (S.tab === 'clocks' && !S.editing) updateClocks(Date.now(), true);
  }
  function suggestHtml() {
    var L = S.local, chips = SUGGEST.filter(function (n) {
      var e = Core.resolvePlace(idx(), n);
      return e && e.name !== L.name && !Core.sameZone(e.zone, L.zone);
    }).slice(0, 6);
    return '<div class="wc-empty"><b>Add the places you work with.</b> Their time, date and offset show here, and the Planner finds hours that suit everyone.' +
      '<div class="wc-sugs">' + chips.map(function (n) { return '<button type="button" class="wc-sug" data-sug="' + esc(n) + '">+ ' + esc(n) + '</button>'; }).join('') + '</div></div>';
  }
  function setText(r, k, el, v, html) {
    if (r.k[k] === v) return;
    r.k[k] = v;
    if (html) el.innerHTML = v; else el.textContent = v;
  }
  // Cheap per-tick update: textContent only where something changed.
  function updateClocks(now, full) {
    if (!S || S.editing) return;
    var L = S.local, lp = Core.partsAt(L.zone, now), secs = data.secs;
    places().forEach(function (p) {
      var r = S.rows[p.id];
      if (!r) return;
      var pp = Core.partsAt(p.zone, now);
      setText(r, 't', r.time, timeHtml(pp, secs), true);
      if (!full && secs && pp.s) return;             // the rest only changes on the minute
      var dd = Core.dayDiff(lp, pp), diff = pp.off - lp.off;
      setText(r, 'rel', r.rel, p.local ? Core.fmtDate(pp) : '<span class="' + (dd ? 'wc-day' : '') + '">' + esc(Core.relDay(dd)) + '</span> · ' + esc(Core.fmtDiff(diff)), true);
      var ab = Core.abbrAt(p.zone, now), dst = Core.isDst(p.zone, now);
      setText(r, 'sub', r.sub, (ab ? ab + ' · ' : '') + Core.fmtOffset(pp.off) + (dst ? ' · DST' : '') + (p.label ? ' · ' + p.name : ''));
      var ph = Core.sunPhase(p.lat, p.lon, now, pp);
      if (r.k.ph !== ph) {
        r.k.ph = ph;
        r.sun.className = 'wc-sun ' + ph;
        r.sun.textContent = SUN[ph];
        r.sun.setAttribute('aria-label', SUN_T[ph]);
        r.sun.title = SUN_T[ph] + (typeof p.lat === 'number' ? '' : ' (by the clock)');
      }
      var note = transitionNote(p.zone, now);
      if (r.k.note !== note) { r.k.note = note; r.note.textContent = note; r.note.hidden = !note; }
    });
  }
  // "Clocks go back 1 h on Sun 26 Oct" within two weeks; cached per zone for an hour.
  function transitionNote(z, now) {
    var c = S.trCache[z];
    if (!c || now >= c.until) {
      var tr = Core.nextTransition(z, now, 14);
      c = S.trCache[z] = { note: Core.changeNote(z, tr), until: tr ? Math.min(tr.at, now + Core.HOUR) : now + Core.HOUR };
    }
    return c.note;
  }

  // ---- add / edit places -------------------------------------------------------------------------------
  function setAdding(on) {
    if (!S) return;
    if (on && S.editing) setEditing(false);
    S.adding = on;
    q('.wc-add').hidden = !on;
    q('.wc-view[data-v="clocks"]').classList.toggle('adding', on);   // phones: the search moves to the top
    renderClocks();
    if (on) {
      var inp = q('.wc-search');
      inp.value = '';
      renderHits();
      try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); }
      setTimeout(function () { if (S && S.adding) q('.wc-add').scrollIntoView({ block: 'nearest' }); }, 30);
    } else {
      q('.wc-hits').innerHTML = '';
      if (S.pendingRemote) { S.pendingRemote = false; onRemote(); }
    }
  }
  function renderHits() {
    if (!S || !S.adding) return;
    var qv = q('.wc-search').value, box = q('.wc-hits'), now = Date.now(), list;
    if (!qv.trim()) {
      list = SUGGEST.map(function (n) { return Core.resolvePlace(idx(), n); }).filter(Boolean).map(function (e) { return { e: e }; });
    } else list = Core.search(idxAll(), qv, 40);
    S.hits = list.map(function (r) { return r.e; }).filter(function (e) { return Core.validZone(e.zone); }).slice(0, 30);
    S.hitSel = S.hits.length ? 0 : -1;
    if (!S.hits.length) {
      var sg = Core.suggest(idxAll(), qv);
      box.innerHTML = '<div class="wc-nohit">No place or time zone matches “' + esc(qv.trim()) + '”.' +
        (sg ? ' Did you mean <button type="button" class="wc-link" data-act="search-sug" data-q="' + esc(sg.name) + '">' + esc(sg.name) + '</button>?' : '') +
        ' Try a city, a country, an IANA zone (Europe/Paris) or an offset (UTC+5:30).</div>';
      return;
    }
    var lp = Core.partsAt(S.local.zone, now);
    box.innerHTML = (qv.trim() ? '' : '<div class="wc-hithead">Popular</div>') + S.hits.map(function (e, i) {
      var pp = Core.partsAt(e.zone, now), have = data.places.some(function (p) { return p.zone === e.zone && p.name === e.name; });
      var sub = e.iana ? e.zone : (e.country || '') + (e.fixed ? '' : ' · ' + e.zone.replace(/_/g, ' '));
      return '<button type="button" class="wc-hit' + (i === S.hitSel ? ' sel' : '') + (have ? ' have' : '') + '" role="option" data-hit="' + i + '" aria-selected="' + (i === S.hitSel) + '">' +
        '<span class="wc-hn">' + esc(e.name) + (have ? ' <i>added</i>' : '') + '<small>' + esc(sub) + '</small></span>' +
        '<span class="wc-ht">' + esc(fmtT(pp)) + '<small>' + esc(Core.fmtOffset(pp.off)) + (Core.dayDiff(lp, pp) ? ' · ' + Core.relDay(Core.dayDiff(lp, pp)) : '') + '</small></span></button>';
    }).join('');
  }
  function searchKey(e) {
    var n = S.hits ? S.hits.length : 0;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!n) return;
      e.preventDefault();
      S.hitSel = (S.hitSel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      qa('.wc-hit').forEach(function (b, i) { b.classList.toggle('sel', i === S.hitSel); b.setAttribute('aria-selected', i === S.hitSel ? 'true' : 'false'); if (i === S.hitSel) b.scrollIntoView({ block: 'nearest' }); });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (S.hitSel >= 0) addHit(S.hitSel);
    } else if (e.key === 'Escape') { e.preventDefault(); setAdding(false); }
  }
  function addHit(i) { var e = S.hits && S.hits[i]; if (e) addEntry(e, false); }
  function addByName(n) { var e = Core.resolvePlace(idx(), n); if (e) addEntry(e, false); }
  function addEntry(e, fromConv) {
    if (data.places.some(function (p) { return p.zone === e.zone && p.name === e.name; })) { toast(e.name + ' is already in your list'); return; }
    if (data.places.length >= MAX_PLACES) { toast('That’s ' + MAX_PLACES + ' places — remove one first', 'error', 2600); return; }
    var p = { id: newId(), zone: e.zone, name: e.name, country: e.country || '', label: '', lat: num(e.lat), lon: num(e.lon) };
    data.places.push(p);
    save();
    toast('Added ' + e.name, 'success', 1200);
    if (fromConv) { S.conv.src = p.id; S.conv.tmp = null; renderClocks(); renderConv(); return; }
    renderClocks();
    if (S.adding) {
      var inp = q('.wc-search');
      inp.value = '';
      renderHits();
      if (!coarse()) inp.focus();
    }
  }
  function setEditing(on) {
    if (!S) return;
    if (on && S.adding) setAdding(false);
    if (!on) { var a = document.activeElement; if (a && a.classList && a.classList.contains('wc-lbl')) rename(a.getAttribute('data-id'), a.value); }
    S.editing = on;
    renderClocks();
    if (!on && S.pendingRemote) { S.pendingRemote = false; onRemote(); }
    schedule();
  }
  function rename(id, v) {
    var p = byId(id);
    if (!p) return;
    v = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    var lbl = v && v !== p.name ? v : '';
    if (p.local) {
      if ((data.names[p.key] || '') === lbl) return;
      if (lbl) data.names[p.key] = lbl; else delete data.names[p.key];
      S.local.label = lbl;
    } else {
      if (p.label === lbl) return;
      p.label = lbl;
    }
    save();
  }
  function pidx(id) { for (var i = 0; i < data.places.length; i++) if (data.places[i].id === id) return i; return -1; }
  function move(id, d) {
    var vis = mine(), k = -1;
    for (var n = 0; n < vis.length; n++) if (vis[n].id === id) k = n;
    if (k < 0 || k + d < 0 || k + d >= vis.length) return;
    var i = pidx(id), j = pidx(vis[k + d].id);                      // swap with the visible neighbour
    var t = data.places[i]; data.places[i] = data.places[j]; data.places[j] = t;
    save();
    renderClocks();
    var b = q('.wc-row[data-id="' + id + '"] [data-act="' + (d < 0 ? 'up' : 'down') + '"]');
    if (b && !b.disabled) b.focus(); else { b = q('.wc-row[data-id="' + id + '"] .wc-lbl'); if (b && !coarse()) b.focus(); }
  }
  function removePlace(id) {
    var i = pidx(id);
    if (i < 0) return;
    var p = data.places.splice(i, 1)[0];
    save();
    S.undo = { p: p, i: i };
    if (!mine().length) S.editing = false;
    renderClocks();
    var u = q('.wc-undo');
    q('.wc-undo-t').textContent = 'Removed ' + label(p);
    u.hidden = false;
    clearTimeout(S.undoT);
    S.undoT = setTimeout(function () { if (S) { q('.wc-undo').hidden = true; S.undo = null; } }, 6000);
  }
  function undoRemove() {
    if (!S.undo) return;
    data.places.splice(Math.min(S.undo.i, data.places.length), 0, S.undo.p);
    S.undo = null;
    clearTimeout(S.undoT);
    q('.wc-undo').hidden = true;
    save();
    renderClocks();
  }
  // Drag the ⠇ grip to reorder (edit mode). Pointer-captured: no document listeners.
  function gripDown(e) {
    var g = e.target.closest && e.target.closest('.wc-grip');
    if (!g || !S.editing) return;
    var row = g.closest('.wc-row');
    e.preventDefault();
    try { g.setPointerCapture(e.pointerId); } catch (x) {}
    S.drag = { id: e.pointerId, row: row, moved: false };
    row.classList.add('dragging');
  }
  function gripMove(e) {
    var D = S && S.drag;
    if (!D || e.pointerId !== D.id) return;
    e.preventDefault();
    var list = q('.wc-list'), rows = qa('.wc-list .wc-row:not(.local)');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r === D.row) continue;
      var rc = r.getBoundingClientRect(), mid = rc.top + rc.height / 2;
      var before = D.row.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (before && e.clientY > mid) { list.insertBefore(D.row, r.nextSibling); D.moved = true; return; }
      if (!before && e.clientY < mid) { list.insertBefore(D.row, r); D.moved = true; return; }
    }
  }
  function gripUp(e) {
    var D = S && S.drag;
    if (!D || e.pointerId !== D.id) return;
    S.drag = null;
    D.row.classList.remove('dragging');
    if (!D.moved) return;
    var order = qa('.wc-list .wc-row:not(.local)').map(function (r) { return r.getAttribute('data-id'); });
    var at = function (p) { var k = order.indexOf(p.id); return k < 0 ? 1e6 : k; };   // places this browser can't show stay last
    data.places.sort(function (a, b) { return at(a) - at(b); });
    save();
    renderClocks();
  }

  // ---- Planner ---------------------------------------------------------------------------------------
  function renderPlan() {
    if (!S) return;
    var P = S.plan, L = S.local, r = Core.dayRange(P.ymd, L.zone), n = Math.round((r.end - r.start) / SLOT);
    P.start = r.start; P.end = r.end; P.n = n;
    var all = places(), ws = data.ws, we = data.we, H12 = h12(), span = r.end - r.start;
    var rows = all.map(function (p) {
      var bd = Core.bands(p.zone, r.start, n, ws, we, weekendFor(p));
      var marks = Core.hourMarks(p.zone, r.start, r.end);
      var h = '<div class="wc-prow' + (p.local ? ' local' : '') + '"><div class="wc-plbl"><span class="wc-pn">' + esc(label(p)) +
        (p.local ? ' <i class="wc-you">you</i>' : '') + '</span><span class="wc-pt"></span></div><div class="wc-bar">';
      bd.forEach(function (b) { h += '<i class="wc-seg ' + b.kind + '" style="left:' + pct(b.from / n) + ';width:' + pct((b.to - b.from) / n) + '"></i>'; });
      marks.forEach(function (m) {
        var x = (m.t - r.start) / span, part = r.end - m.t < Core.HOUR * 0.6, w = Math.min(Core.HOUR, r.end - m.t) / span;
        h += '<span class="wc-hr' + (m.h === 0 ? ' mid' : '') + '" style="left:' + pct(x) + ';width:' + pct(w) + '"' +
          (m.h === 0 ? ' title="' + Core.WD[m.wd] + ' ' + m.d + ' ' + Core.MON[m.m - 1] + '"' : '') + '>' +
          (part ? '' : m.h === 0 ? Core.WD[m.wd].slice(0, 2) : Core.hourLabel(m.h, H12)) + '</span>';
      });
      return h + '<i class="wc-now" hidden></i><i class="wc-cur"></i></div></div>';
    });
    var ov = P.ov = Core.overlap(all.map(function (p) { return { zone: p.zone, weekend: weekendFor(p) }; }), r.start, n, ws, we);
    var oh = '<div class="wc-prow wc-orow"><div class="wc-plbl"><span class="wc-pn">' + (ov.all ? 'Everyone working' : ov.max ? 'Most working (' + ov.max + ' of ' + ov.n + ')' : 'Nobody working') +
      '</span><span class="wc-pt"></span></div><div class="wc-bar wc-obar">';
    ov.runs.forEach(function (run) { oh += '<i class="wc-oseg' + (ov.all ? '' : ' part') + '" style="left:' + pct(run.from / n) + ';width:' + pct((run.to - run.from) / n) + '"></i>'; });
    oh += '<i class="wc-now" hidden></i><i class="wc-cur"></i></div></div>';
    var tl = q('.wc-tl');
    tl.innerHTML = '<div class="wc-axis"><span class="wc-knob"></span></div>' + rows.join('') + (all.length > 1 ? oh : '');
    tl.setAttribute('aria-valuemin', '0');
    tl.setAttribute('aria-valuemax', String(n - 1));
    S.planEls = { curs: qa('.wc-tl .wc-cur'), nows: qa('.wc-tl .wc-now'), pts: qa('.wc-tl .wc-prow:not(.wc-orow) .wc-pt'), knob: q('.wc-knob'), bar: q('.wc-tl .wc-bar') };
    q('.wc-lg-off').hidden = !data.wkend;
    // the date bar
    var mid = Core.partsAt(L.zone, r.start + span / 2);
    q('.wc-date').textContent = Core.fmtDateY(mid) + (span !== Core.DAY ? ' · ' + Math.round(span / Core.HOUR) + ' h day' : '');
    q('.wc-dinput').value = Core.ymdKey(P.ymd);
    updateTodayChip();
    // summary
    var sum = q('.wc-ovsum');
    P.jumpTo = null;
    if (all.length < 2) { sum.textContent = 'Add places on the Clocks tab to compare their hours here.'; sum.disabled = true; }
    else if (!ov.max) { sum.textContent = 'Nobody is in working hours on this date (weekend?).'; sum.disabled = true; }
    else {
      // Several best windows: yours-in-working-hours first, then the longest; show two.
      var runs = ov.runs.slice(), wkL = weekendFor(L);
      var yours = function (run) { return Core.slotKind(Core.partsAt(L.zone, r.start + run.from * SLOT), ws, we, wkL) === 'work' ? 1 : 0; };
      if (!ov.all) runs.sort(function (a, b) { return yours(b) - yours(a) || (b.to - b.from) - (a.to - a.from) || a.from - b.from; });
      var shown = ov.all ? runs : runs.slice(0, 2), more = runs.length - shown.length;
      var spans = shown.map(function (run) { return fmtT(Core.partsAt(L.zone, r.start + run.from * SLOT)) + '–' + fmtT(Core.partsAt(L.zone, r.start + run.to * SLOT)); });
      var tot = shown.reduce(function (s, run) { return s + (run.to - run.from) * 15; }, 0);
      P.jumpTo = r.start + shown[0].from * SLOT;
      sum.disabled = false;
      sum.innerHTML = ov.all
        ? '<b>✓ Everyone is working</b> ' + esc(spans.join(', ')) + ' your time (' + esc(Core.fmtDur(tot)) + ') <span class="wc-jump">→ go</span>'
        : '<b>No time suits everyone.</b> Best (' + ov.max + ' of ' + ov.n + ' working): ' + esc(spans.join(' or ')) + ' your time' +
          (more ? ' · ' + more + ' more' : '') + ' <span class="wc-jump">→ go</span>';
    }
    // cursor: keep the chosen wall-clock time on the new date
    setCursor(Core.zonedToUtc(P.ymd.y, P.ymd.m, P.ymd.d, Math.floor(P.wall / 60), P.wall % 60, L.zone), true);
    updateNow(Date.now());
  }
  function updateTodayChip() {
    if (!S || !S.plan) return;
    var c = q('.wc-chip');
    if (c) c.hidden = Core.ymdKey(S.plan.ymd) === S.todayKey;
  }
  function updateNow(now) {
    if (!S || !S.planEls) return;
    var P = S.plan, on = now >= P.start && now < P.end, x = pct((now - P.start) / (P.end - P.start));
    S.planEls.nows.forEach(function (el) { el.hidden = !on; if (on) el.style.left = x; });
  }
  function setPlanDate(o) {
    S.plan.ymd = { y: o.y, m: o.m, d: o.d };
    renderPlan();
  }
  function planNow() {
    var now = Date.now(), lp = Core.partsAt(S.local.zone, now);
    S.plan.ymd = { y: lp.y, m: lp.m, d: lp.d };
    S.plan.wall = lp.h * 60 + Math.floor(lp.mi / 15) * 15;
    renderPlan();
  }
  // Move the cursor to instant t (snapped to 15 minutes, kept inside the day).
  function setCursor(t, keepWall) {
    var P = S.plan;
    t = Math.round(t / SLOT) * SLOT;
    t = Math.max(P.start, Math.min(P.end - SLOT, t));
    P.cur = t;
    var lp = Core.partsAt(S.local.zone, t);
    if (!keepWall) P.wall = lp.h * 60 + lp.mi;
    var f = (t - P.start) / (P.end - P.start), x = pct(f), E = S.planEls;
    E.curs.forEach(function (el) { el.style.left = x; });
    if (E.knob) { E.knob.style.left = x; E.knob.style.transform = 'translateX(-' + x + ')'; E.knob.textContent = fmtT(lp); }
    var all = places(), H12 = h12();
    E.pts.forEach(function (el, i) {
      var p = all[i];
      if (!p) return;
      var pp = Core.partsAt(p.zone, t), dd = Core.dayDiff(lp, pp);
      el.innerHTML = esc(Core.fmtTime(pp.h, pp.mi, H12)) + ' <span class="' + (dd ? 'wc-day' : '') + '">' + esc(Core.WD[pp.wd] + ' ' + pp.d) + '</span>';
      el.parentNode.parentNode.classList.toggle('in-work', Core.slotKind(pp, data.ws, data.we, weekendFor(p)) === 'work');
    });
    var tl = q('.wc-tl');
    tl.setAttribute('aria-valuenow', String(Math.round((t - P.start) / SLOT)));
    tl.setAttribute('aria-valuetext', fmtT(lp) + ' your time, ' + Core.fmtDate(lp));
  }
  function xToTime(clientX) {
    var P = S.plan, rc = S.planEls.bar.getBoundingClientRect();
    var f = Math.max(0, Math.min(1, (clientX - rc.left) / rc.width));
    return P.start + f * (P.end - P.start);
  }
  function planDown(e) {
    if (e.button > 0 || !S.planEls) return;
    S.pd = { id: e.pointerId, x: e.clientX, y: e.clientY, drag: e.pointerType === 'mouse' };
    if (S.pd.drag) { try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {} planTo(e.clientX); }
  }
  function planMove(e) {
    var D = S && S.pd;
    if (!D || D.id !== e.pointerId) return;
    if (!D.drag) {
      var dx = Math.abs(e.clientX - D.x), dy = Math.abs(e.clientY - D.y);
      if (dx > 8 && dx > dy) { D.drag = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {} }
      else if (dy > 10) { S.pd = null; return; }   // a vertical swipe scrolls the panel
      else return;
    }
    planTo(e.clientX);
  }
  function planUp(e) {
    var D = S && S.pd;
    if (!D || D.id !== e.pointerId) return;
    if (!D.drag) planTo(e.clientX);                  // a tap
    S.pd = null;
  }
  function planTo(x) {
    S.pendingX = x;
    if (S.raf) return;
    S.raf = requestAnimationFrame(function () { if (!S) return; S.raf = 0; setCursor(xToTime(S.pendingX)); });
  }
  function planKey(e) {
    var P = S.plan, k = e.key, step = e.shiftKey ? 4 * SLOT : SLOT, t = null;
    if (k === 'ArrowRight' || k === 'ArrowUp') t = P.cur + step;
    else if (k === 'ArrowLeft' || k === 'ArrowDown') t = P.cur - step;
    else if (k === 'PageUp') t = P.cur + 4 * SLOT;
    else if (k === 'PageDown') t = P.cur - 4 * SLOT;
    else if (k === 'Home') t = P.start;
    else if (k === 'End') t = P.end - SLOT;
    if (t == null) return;
    e.preventDefault();
    setCursor(t);
  }
  function rowsAt(t, first) {
    var all = places();
    if (first) all = [first].concat(all.filter(function (p) { return p !== first; }));
    return all.map(function (p) { return { label: label(p), p: Core.partsAt(p.zone, t), abbr: Core.abbrAt(p.zone, t) || Core.fmtOffset(Core.offsetAt(p.zone, t)) }; });
  }
  function planText() { return Core.meetingText(rowsAt(S.plan.cur), h12(), data.ins); }

  // ---- Converter ---------------------------------------------------------------------------------------
  function convSrc() {
    var c = S.conv;
    if (c.src === 'tmp' && c.tmp) return { id: 'tmp', zone: c.tmp.zone, name: c.tmp.name, country: c.tmp.country || '', label: '', lat: c.tmp.lat, lon: c.tmp.lon, tmp: true };
    return byId(c.src) || S.local;
  }
  function convUtc() { var c = S.conv; return Core.zonedToUtc(c.ymd.y, c.ymd.m, c.ymd.d, c.h, c.mi, convSrc().zone); }
  function renderConv() {
    if (!S) return;
    var c = S.conv, src = convSrc();
    if (c.src !== 'tmp' && !byId(c.src)) c.src = 'local';
    var sel = q('.wc-psel'), opts = places().map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(label(p)) + (p.local ? ' (you)' : '') + '</option>'; });
    if (c.tmp) opts.push('<option value="tmp">' + esc(c.tmp.name) + ' (not in your list)</option>');
    sel.innerHTML = opts.join('');
    sel.value = c.tmp && c.src === 'tmp' ? 'tmp' : src.id;
    q('.wc-ptime').value = (c.h < 10 ? '0' : '') + c.h + ':' + (c.mi < 10 ? '0' : '') + c.mi;
    q('.wc-pdate').value = Core.ymdKey(c.ymd);
    var t = convUtc(), lp = Core.partsAt(S.local.zone, t), sp = Core.partsAt(src.zone, t), H12 = h12();
    var list = [src].concat(places().filter(function (p) { return p.id !== src.id; }));
    var html = list.map(function (p) {
      var pp = Core.partsAt(p.zone, t), dd = Core.dayDiff(lp, pp), isSrc = p === src, ph = Core.sunPhase(p.lat, p.lon, t, pp), ab = Core.abbrAt(p.zone, t);
      return '<div class="wc-row wc-crow' + (isSrc ? ' src' : '') + '">' +
        '<span class="wc-sun ' + ph + '" role="img" aria-label="' + SUN_T[ph] + '" title="' + SUN_T[ph] + '">' + SUN[ph] + '</span>' +
        '<div class="wc-mid"><div class="wc-name"><span class="wc-nm">' + esc(label(p)) + '</span>' + (p.local ? '<span class="wc-you">you</span>' : '') + (isSrc ? '<span class="wc-srctag">from</span>' : '') + '</div>' +
          '<div class="wc-sub">' + esc(Core.fmtDate(pp)) + ' · ' + esc((ab ? ab + ' · ' : '') + Core.fmtOffset(pp.off)) + '</div></div>' +
        '<div class="wc-right"><div class="wc-time">' + timeHtml(pp, false) + '</div><div class="wc-rel">' +
          (p.local ? 'your time' : (dd ? '<span class="wc-day">' + esc(dd === 1 ? 'next day' : dd === -1 ? 'prev day' : Core.relDay(dd)) + '</span> · ' : '') + esc(Core.fmtDiff(pp.off - lp.off))) + '</div></div>' +
        (p.tmp ? '<button type="button" class="wc-btn wc-cadd" data-act="conv-add">+ Add to my places</button>' : '') +
        '</div>';
    }).join('');
    q('.wc-res').innerHTML = html;
    var st = q('.wc-qstat');
    if (!c.err) {
      st.className = 'wc-qstat';
      st.textContent = fmtT(sp) + ' ' + Core.fmtDate(sp) + ' in ' + label(src) + ' →' + (c.gap ? ' (that time is skipped by a clock change there — shown as the moment after)' : '');
    }
  }
  function convFromText() {
    if (!S) return;
    var c = S.conv, v = q('.wc-q').value, st = q('.wc-qstat');
    if (!v.trim()) { c.err = ''; renderConv(); return; }
    var r = Core.parseQuery(v, { now: Date.now(), localZone: S.local.zone, localPlace: S.local, index: idxAll() });
    if (!r.ok) {
      c.err = r.error;
      c.sug = r.suggest || null;
      st.className = 'wc-qstat err';
      st.innerHTML = esc(r.error) + (r.suggest ? ' — <button type="button" class="wc-link" data-act="conv-sug">' + esc(r.suggest.name) + '?</button>' : '');
      c.sugFor = r.rest || '';
      return;
    }
    c.err = '';
    c.gap = r.gap;
    var pl = r.place, hit = null, vis = mine();
    if (pl.local) hit = S.local;
    else vis.forEach(function (p) { if (!hit && p.zone === pl.zone && p.name === pl.name) hit = p; });
    if (!hit) vis.forEach(function (p) { if (!hit && Core.sameZone(p.zone, pl.zone) && Core.norm(label(p)) === Core.norm(pl.name)) hit = p; });
    if (hit) { c.src = hit.id; c.tmp = null; }
    else { c.src = 'tmp'; c.tmp = pl; }
    c.ymd = r.date; c.h = r.h; c.mi = r.mi;
    renderConv();
  }
  // "3pm Londn" → "3pm London"
  function useSuggestion() {
    var qi = q('.wc-q'), c = S.conv;
    if (!qi || !c.sug) return;
    var words = String(c.sugFor || '').split(' ').filter(Boolean).map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
    var re = words.length ? new RegExp(words.join('[\\s,@]+(?:(?:in|at|the|of)\\s+)?'), 'i') : null;
    qi.value = re && re.test(qi.value) ? qi.value.replace(re, c.sug.name) : qi.value.trim() + ' ' + c.sug.name;
    convFromText();
  }
  function convFromPick() {
    q('.wc-q').value = '';
    var c = S.conv, sv = q('.wc-psel').value, tv = /^(\d{2}):(\d{2})/.exec(q('.wc-ptime').value || ''), dv = Core.parseYmd(q('.wc-pdate').value);
    c.src = sv;
    if (tv) { c.h = +tv[1]; c.mi = +tv[2]; }
    if (dv) c.ymd = dv;
    var t = convUtc(), got = Core.partsAt(convSrc().zone, t);
    c.gap = got.h !== c.h || got.mi !== c.mi;
    c.err = '';
    renderConv();
  }
  function convText() { return Core.meetingText(rowsAt(convUtc(), convSrc()), h12(), data.ins); }
  function convToPlan() {
    var t = convUtc(), lp = Core.partsAt(S.local.zone, t);
    S.plan.ymd = { y: lp.y, m: lp.m, d: lp.d };
    S.plan.wall = lp.h * 60 + Math.round(lp.mi / 15) * 15;
    if (S.plan.wall >= 1440) S.plan.wall = 1425;
    switchTab('plan');
  }

  // ---- output ------------------------------------------------------------------------------------------
  function copyText(text) {
    var done = function () { toast('Copied', 'success', 1200); };
    var fail = function () { toast('Copy failed', 'error', 2000); };
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { if (document.execCommand('copy')) done(); else fail(); } catch (e) { fail(); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
  // On its own line at the cursor (replacing a selection); the editor isn't focused,
  // so the phone keyboard stays down.
  function insertText(text) {
    var ed = Cade.editor;
    if (!ed || !text) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
    var st = ed.state, sel = st.selection.main, line = st.doc.lineAt(sel.from), end = st.doc.lineAt(sel.to);
    var ins = (sel.from > line.from && /\S/.test(st.doc.sliceString(line.from, sel.from)) ? '\n' : '') + text + (sel.to < end.to ? '\n' : '');
    ed.dispatch({ changes: { from: sel.from, to: sel.to, insert: ins }, selection: { anchor: sel.from + ins.length }, userEvent: 'input', scrollIntoView: true });
    toast('Inserted', 'success', 1200);
  }

  Cade.registerWidget({
    name: 'World Clock',
    description: 'Times in your places, a meeting planner that finds hours that suit everyone, and a time-zone converter',
    icon: '🕐',
    tags: 'world clock,time zone,timezone,time zones,clock,clocks,cities,meeting planner,meeting,schedule,scheduler,overlap,working hours,convert time,time converter,utc,gmt,dst,daylight saving,jet lag,international,remote team',
    open: open,
    close: close
  });
})();
