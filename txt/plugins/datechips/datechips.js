/* Natural Date Chips — dates written in prose get a subtle underline/tint:
 * "today", "tonight", "tomorrow at 3pm", "next Friday", "in 3 days",
 * "2 weeks ago", "next month", "end of month", "this weekend", "Oct 20",
 * "20th of October 2026", "2026-10-20", "10/20" (M/D or D/M from the
 * browser's locale), with optional times ("at 3pm", "3:30 pm", "15:00",
 * "noon", "Friday evening"). Hover (desktop) shows the absolute date and how
 * far away it is; a click / tap opens a small popover:
 *   Add to Calendar  — the Calendar Events widget's add form, prefilled (the
 *                      widget is loaded through the palette when needed)
 *   Set reminder     — appends / updates the line's @remind!<when>!<msg> token
 *                      (the Reminders module's own format)
 *   Replace with date — writes the absolute YYYY-MM-DD [HH:MM]
 *   Copy date
 *
 * Relative phrases resolve against TODAY, not against when the line was
 * written — the tooltip says so. A month/day without a year takes the
 * occurrence closest to today.
 *
 * The parser is our own (≈ 250 lines, no library) and never uses regex
 * lookbehind (iOS < 16.4): the character before a match is checked by hand.
 * Skipped: ``` fences, `inline code`, URLs, markdown link targets, @remind
 * tokens, lines over 2000 chars. Viewport-only decorations, rebuilt on doc /
 * viewport changes (and when the day rolls over), with a per-line cache.
 * window.__cadeDateParse(text, now?) exposes the parser to other modules.
 * Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;

  // ---- the parser (pure: text + "now" in, chips out) ----------------------------------
  // parseDates(text, now, order) → [{ from, to, y, mo (0-11), d, time: {h, mi}|null,
  //   implicit (time guessed from "tonight"/"morning"), rel (resolved against
  //   today), inferredYear, wdMismatch }]. Positions are offsets into `text`.
  // No lookbehind anywhere (iOS < 16.4): the character before a match is
  // checked by hand in edgeOK().
  var WD = 'mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?';
  var MON = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
  var NUM = '\\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:a\\s+)?couple(?:\\s+of)?|(?:a\\s+)?few';
  var UNIT = 'days?|weeks?|wks?|months?|mos?|years?|yrs?|hours?|hrs?|minutes?|mins?';
  var TIME = '(?:(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?m\\.?(?![a-z])|(\\d{1,2}):(\\d{2})(?!\\d)|(noon|midday|midnight)(?![a-z]))';
  var WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  var WD_IDX = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };
  var MON_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var PART = { morning: 9, afternoon: 14, evening: 18, night: 20 };

  var R_ABS_MD = new RegExp('\\b(?:(' + WD + ')\\.?,?\\s+)?(' + MON + ')\\.?(?![a-z])\\s*(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])((?:,\\s*|\\s+)(\\d{4})(?!\\d))?', 'gi');
  var R_ABS_DM = new RegExp('\\b(?:(' + WD + ')\\.?,?\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + MON + ')\\.?(?![a-z])((?:,\\s*|\\s+)(\\d{4})(?!\\d))?', 'gi');
  var R_ISO = /\b(\d{4})([-\/])(\d{1,2})\2(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?(?!\d)/gi;
  var R_NUM_Y = /\b(\d{1,2})([\/.\-])(\d{1,2})\2(\d{4}|\d{2})(?!\d)/g;
  var R_NUM = /\b(\d{1,2})\/(\d{1,2})(?![\d\/])/g;
  var R_WORD = /\b(?:(?:the\s+)?day\s+(after\s+tomorrow|before\s+yesterday)|(today|tonight|tomorrow|tmrw|yesterday)|this\s+(morning|afternoon|evening))(?![a-z])/gi;
  var R_WDAY = new RegExp('\\b(?:(next|this\\s+coming|this|last|coming|past)\\s+)?(' + WD + ')(?![a-z])\\.?', 'gi');
  var R_IN = new RegExp('\\bin\\s+(' + NUM + ')\\s+(' + UNIT + ')(?![a-z])', 'gi');
  var R_AGO = new RegExp('\\b(' + NUM + ')\\s+(' + UNIT + ')\\s+(ago|from\\s+now|from\\s+today)(?![a-z])', 'gi');
  var R_PERIOD = /\b(?:(next|last|coming)\s+(week|month)|(?:the\s+)?end\s+of\s+(?:the\s+)?(?:(this|next|last)\s+)?(week|month|year)|(?:(this|next|last)\s+)?weekend)(?![a-z])/gi;
  var R_T_AFTER = new RegExp('^(?:,?\\s*(?:at|@|around|by|from)\\s*|,\\s*|\\s+)' + TIME, 'i');
  var R_T_BARE = /^,?\s*(?:at|@)\s*(\d{1,2})(?![\d:]|\s*[ap]\.?m)/i;
  var R_T_PART = /^,?\s+(?:in\s+the\s+)?(morning|afternoon|evening|night)(?![a-z])/i;
  var R_T_BEFORE = new RegExp('(?:^|[^\\w:.])' + TIME + '\\s+(?:on\\s+)?$', 'i');
  var R_PREP = /(?:^|\s)(?:on|by|due|until|till|til|before|after|from|since|thru|through|starting|ending)\s+$/i;

  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function mkDate(y, mo, d) { return new Date(y, mo, d, 12); } // noon: DST-proof day maths
  function ymd(dt) { return { y: dt.getFullYear(), mo: dt.getMonth(), d: dt.getDate() }; }
  function addDays(b, n) { return ymd(mkDate(b.y, b.mo, b.d + n)); }
  function dim(y, mo) { return new Date(y, mo + 1, 0).getDate(); }
  function addMonths(b, n) {
    var t = b.y * 12 + b.mo + n, y = Math.floor(t / 12), mo = t - y * 12;
    return { y: y, mo: mo, d: Math.min(b.d, dim(y, mo)) };
  }
  function dow(b) { return mkDate(b.y, b.mo, b.d).getDay(); }
  function mondayOf(b) { return addDays(b, -((dow(b) + 6) % 7)); }
  function dayDiff(a, b) { return Math.round((Date.UTC(b.y, b.mo, b.d) - Date.UTC(a.y, a.mo, a.d)) / 864e5); }
  function wdIdx(s) { return WD_IDX[s.slice(0, 2).toLowerCase()]; }
  function monIdx(s) { return MON_IDX[s.slice(0, 3).toLowerCase()]; }
  function numWord(s) {
    s = s.toLowerCase();
    if (/^\d/.test(s)) return parseInt(s, 10);
    if (s.indexOf('couple') >= 0) return 2;
    if (s.indexOf('few') >= 0) return 3;
    return WORDS[s] || 0;
  }
  function validYMD(y, mo, d) { return y >= 1900 && y <= 2199 && mo >= 0 && mo < 12 && d >= 1 && d <= dim(y, mo); }

  // A chip must stand alone: not glued to a word, a path, an @link / ¥tag,
  // or a longer number ("v2.10/20", "1.5/2", "10/20/30/40"). `range` lets a
  // dash join two of them ("Oct 20-22", "09:00-10:00", "10/20-10/22").
  function edgeOK(t, s, e, range) {
    var a = t.charAt(s - 1), a2 = t.charAt(s - 2), z = t.charAt(e), z2 = t.charAt(e + 1);
    if (a && /[\w@\u00a5\u20ac\u00a7#\/\\$]/.test(a)) return false;
    if (a && (range ? /[.:,+]/ : /[.\-:,+]/).test(a) && /\d/.test(a2)) return false;
    if (z && /[\w@\/\\%\u00b0]/.test(z)) return false;
    if (z && (range ? /[.:\/,]/ : /[.\-:\/,]/).test(z) && /\d/.test(z2)) return false;
    return true;
  }
  // Year for a month/day written without one: the occurrence closest to today
  // (Jan 5 written in December is next January's) — matching the weekday when
  // one was given ("Fri, Oct 16").
  function inferYear(base, mo, d, wd) {
    var best = null, bestDist = 1e9;
    for (var y = base.y - 1; y <= base.y + 1; y++) {
      if (!validYMD(y, mo, d)) continue;
      var dist = Math.abs(dayDiff(base, { y: y, mo: mo, d: d }));
      if (wd != null && mkDate(y, mo, d).getDay() !== wd) dist += 200; // a typo, not last year
      if (dist < bestDist) { bestDist = dist; best = y; }
    }
    return best;
  }
  function absChip(base, s, e, y, mo, d, wdTok) {
    var wd = wdTok ? wdIdx(wdTok) : null, inferred = false;
    if (y == null) { y = inferYear(base, mo, d, wd); inferred = true; if (y == null) return null; }
    if (!validYMD(y, mo, d)) return null;
    return { from: s, to: e, y: y, mo: mo, d: d, time: null, rel: false, inferredYear: inferred,
      wdMismatch: wd != null && mkDate(y, mo, d).getDay() !== wd };
  }
  function relChip(s, e, b, extra) {
    var c = { from: s, to: e, y: b.y, mo: b.mo, d: b.d, time: null, rel: true, inferredYear: false, wdMismatch: false };
    if (extra) for (var k in extra) c[k] = extra[k];
    return c;
  }
  // "3pm" / "3:30 p.m." / "15:00" / "noon" from a TIME match starting at group i.
  function timeOf(m, i) {
    var h, mi = 0;
    if (m[i + 5]) { var w = m[i + 5].toLowerCase(); return { h: w === 'midnight' ? 0 : 12, mi: 0 }; }
    if (m[i + 3] != null) {
      h = +m[i + 3]; mi = +m[i + 4];
      return h <= 23 && mi <= 59 ? { h: h, mi: mi } : null;
    }
    h = +m[i]; mi = m[i + 1] != null ? +m[i + 1] : 0;
    if (h < 1 || h > 12 || mi > 59) return null;
    var pm = m[i + 2].toLowerCase() === 'p';
    return { h: (h % 12) + (pm ? 12 : 0), mi: mi };
  }

  function weekdayChip(base, s, e, mod, tok) {
    var full = tok.length >= 6, low = tok.toLowerCase();
    if (!mod && !full) return null;               // bare "Fri"/"sat"/"sun": too ambiguous
    if (mod && (low === 'sat' || low === 'sun')) return null; // "this sun", "last sat"
    var t = wdIdx(tok), wd = dow(base), n;
    mod = mod ? mod.toLowerCase().replace(/\s+/g, ' ') : '';
    if (mod === 'next') n = 7 - (wd + 6) % 7 + (t + 6) % 7;   // that day of NEXT (Mon-first) week
    else if (mod === 'last' || mod === 'past') n = -(((wd - t + 7) % 7) || 7);
    else if (mod === 'coming' || mod === 'this coming') n = ((t - wd + 7) % 7) || 7;
    else n = (t - wd + 7) % 7;                     // bare / "this": the coming one, today included
    return relChip(s, e, addDays(base, n));
  }
  function spanChip(base, now, s, e, nTok, unit, sign) {
    var n = numWord(nTok) * sign, u = unit.toLowerCase().charAt(0), b;
    if (!n && n !== 0) return null;
    if (Math.abs(n) > 999) return null;
    if (u === 'd') b = addDays(base, n);
    else if (u === 'w') b = addDays(base, 7 * n);
    else if (u === 'y') b = addMonths(base, 12 * n);
    else if (unit.toLowerCase().indexOf('mo') === 0) b = addMonths(base, n);
    else { // hours / minutes: a moment, so it carries a time
      var ms = (u === 'h' ? 36e5 : 6e4) * n, t = new Date(now.getTime() + ms);
      return relChip(s, e, ymd(t), { time: { h: t.getHours(), mi: t.getMinutes() } });
    }
    return relChip(s, e, b);
  }

  function collect(text, base, now, order) {
    var out = [], m, re, c;
    function each(r, fn, range) {
      r.lastIndex = 0;
      while ((m = r.exec(text)) !== null) {
        var s = m.index, e = s + m[0].length;
        if (edgeOK(text, s, e, range)) { c = fn(m, s, e); if (c) out.push(c); }
        r.lastIndex = s + 1;
      }
    }
    each(R_ABS_MD, function (m, s, e) {
      if (m[2].toLowerCase() === 'may' && m[2] !== 'May' && m[2] !== 'MAY') return null; // "you may 2…"
      var y = m[5] ? +m[5] : null;
      if (y != null && (y < 1900 || y > 2199)) { e -= m[4].length; y = null; }
      return absChip(base, s, e, y, monIdx(m[2]), +m[3], m[1]);
    }, true);
    each(R_ABS_DM, function (m, s, e) {
      if (m[3].toLowerCase() === 'may' && m[3] !== 'May' && m[3] !== 'MAY') return null;
      var y = m[5] ? +m[5] : null;
      if (y != null && (y < 1900 || y > 2199)) { e -= m[4].length; y = null; }
      return absChip(base, s, e, y, monIdx(m[3]), +m[2], m[1]);
    }, true);
    each(R_ISO, function (m, s, e) {
      var c = absChip(base, s, e, +m[1], +m[3] - 1, +m[4]);
      if (c && m[5] != null) {
        if (+m[5] > 23 || +m[6] > 59) { c.to = s + m[1].length + m[3].length + m[4].length + 2; }
        else c.time = { h: +m[5], mi: +m[6] };
      }
      return c;
    }, true);
    each(R_NUM_Y, function (m, s, e) {
      var sep = m[2], y = +m[4];
      if (sep === '.' && m[4].length !== 4) return null;          // "1.2.30" is a version
      if (m[4].length === 2) y += 2000;
      var a = +m[1], b = +m[3], dm = sep === '.' || order === 'DM';
      var mo = (dm ? b : a) - 1, d = dm ? a : b;
      if (!validYMD(y, mo, d)) { mo = (dm ? a : b) - 1; d = dm ? b : a; } // 25/12/2026 in a M/D locale
      return absChip(base, s, e, y, mo, d);
    });
    each(R_NUM, function (m, s, e) {
      var a = m[1], b = m[2];
      if (a + '/' + b === '24/7') return null;
      // Fractions and scores ("1/2 cup", "7/10") need a date word in front.
      if ((a.length === 1 && b.length === 1) || (b === '10' && +a <= 10)) {
        if (!R_PREP.test(text.slice(Math.max(0, s - 14), s))) return null;
      }
      var dm = order === 'DM';
      return absChip(base, s, e, null, (dm ? +b : +a) - 1, dm ? +a : +b);
    }, true);
    each(R_WORD, function (m, s, e) {
      if (m[1]) return relChip(s, e, addDays(base, /after/i.test(m[1]) ? 2 : -2));
      if (m[3]) return relChip(s, e, base, { time: { h: PART[m[3].toLowerCase()], mi: 0 }, implicit: true, evening: /evening/i.test(m[3]) });
      var w = m[2].toLowerCase();
      if (w === 'today') return relChip(s, e, base);
      if (w === 'tonight') return relChip(s, e, base, { time: { h: 20, mi: 0 }, implicit: true, evening: true });
      if (w === 'yesterday') return relChip(s, e, addDays(base, -1));
      return relChip(s, e, addDays(base, 1));
    });
    each(R_WDAY, function (m, s, e) { return weekdayChip(base, s, e, m[1], m[2]); });
    each(R_IN, function (m, s, e) { return spanChip(base, now, s, e, m[1], m[2], 1); });
    each(R_AGO, function (m, s, e) { return spanChip(base, now, s, e, m[1], m[2], /ago/i.test(m[3]) ? -1 : 1); });
    each(R_PERIOD, function (m, s, e) {
      var mon = mondayOf(base), b;
      if (m[2]) {
        var k = m[1].toLowerCase() === 'last' ? -1 : 1;
        b = m[2].toLowerCase() === 'week' ? addDays(mon, 7 * k) : { y: addMonths(base, k).y, mo: addMonths(base, k).mo, d: 1 };
      } else if (m[4]) {
        var mod = (m[3] || 'this').toLowerCase(), k2 = mod === 'next' ? 1 : mod === 'last' ? -1 : 0, u = m[4].toLowerCase();
        if (u === 'week') b = addDays(mon, 4 + 7 * k2);                     // Friday
        else if (u === 'month') { var x = addMonths({ y: base.y, mo: base.mo, d: 1 }, k2); b = { y: x.y, mo: x.mo, d: dim(x.y, x.mo) }; }
        else b = { y: base.y + k2, mo: 11, d: 31 };
      } else {
        var mod2 = (m[5] || 'this').toLowerCase();
        if (mod2 === 'this' && dow(base) === 0) b = base;                  // Sunday: it's the weekend now
        else b = addDays(mon, 5 + (mod2 === 'next' ? 7 : mod2 === 'last' ? -7 : 0)); // Saturday
      }
      return relChip(s, e, b);
    });
    return out;
  }

  // Overlaps: the earliest, then the longest wins ("next Friday" over "Friday",
  // "Fri, Oct 16" over "Fri").
  function pick(cands) {
    cands.sort(function (a, b) { return a.from - b.from || (b.to - b.from) - (a.to - a.from); });
    var out = [], end = -1;
    for (var i = 0; i < cands.length; i++) if (cands[i].from >= end) { out.push(cands[i]); end = cands[i].to; }
    return out;
  }

  // Glue a time on: "tomorrow at 3pm", "Oct 20, 15:00", "Friday evening",
  // "tonight at 8"; or in front: "3pm tomorrow", "at 9:30 on Friday".
  function attachTimes(text, chips) {
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i], lim = i + 1 < chips.length ? chips[i + 1].from : text.length, m, t;
      for (var pass = 0; pass < 2; pass++) {
        if (c.time && !c.implicit) break;
        var rest = text.slice(c.to, Math.min(lim, c.to + 40)), e = 0;
        t = null;
        if ((m = R_T_AFTER.exec(rest)) && (t = timeOf(m, 1))) e = m[0].length;
        else if ((m = R_T_BARE.exec(rest))) {
          var h = +m[1];
          if (h >= 1 && h <= 12) {
            if (c.evening) h = h % 12 + 12;
            else if (h <= 6) h += 12;                    // "at 3" means the afternoon
            t = { h: h, mi: 0 }; e = m[0].length;
          }
        } else if (!c.time && c.rel && (m = R_T_PART.exec(rest)) && edgeOK(text, c.from, c.to + m[0].length)) {
          var w = m[1].toLowerCase();
          c.time = { h: PART[w], mi: 0 }; c.implicit = true; c.evening = w === 'evening' || w === 'night';
          c.to += m[0].length;
          continue;                                      // "Friday evening at 7"
        }
        if (t && edgeOK(text, c.from, c.to + e, true)) { c.time = t; c.implicit = false; c.to += e; }
        break;
      }
      if (c.time) continue;
      var lo = i > 0 ? chips[i - 1].to : 0, before = text.slice(Math.max(lo, c.from - 30), c.from);
      if ((m = R_T_BEFORE.exec(before)) && (t = timeOf(m, 1))) {
        // m[0] may start with the one boundary character before the time
        var lead = m[0].length - (/^[^\da-z]/i.test(m[0]) ? 1 : 0);
        var s = c.from - lead;
        if (s >= lo && edgeOK(text, s, c.to)) { c.time = t; c.from = s; }
      }
    }
    return chips;
  }

  function parseDates(text, now, order) {
    now = now || new Date();
    var base = ymd(now);
    return attachTimes(text, pick(collect(text, base, now, order || 'MD')));
  }

  // Numeric dates follow the browser's locale: 10/20 is M/D in en-US, D/M in
  // most other places (year-first locales write Y/M/D, so M/D for "10/20").
  var ORDER = (function () {
    try {
      var lang = (navigator.languages && navigator.languages[0]) || navigator.language || 'en-US';
      var parts = new Intl.DateTimeFormat(lang, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(2026, 10, 22));
      var mi = -1, di = -1;
      for (var i = 0; i < parts.length; i++) { if (parts[i].type === 'month') mi = i; if (parts[i].type === 'day') di = i; }
      return mi >= 0 && di >= 0 && di < mi ? 'DM' : 'MD';
    } catch (e) { return 'MD'; }
  })();

  window.__cadeDateParse = function (text, now) { return parseDates(String(text || ''), now || new Date(), ORDER); };

  var CM = Cade.CM;
  if (!CM || !CM.ViewPlugin || !CM.Decoration) return;
  Cade.loadCSS('datechips.css');
  var ViewPlugin = CM.ViewPlugin, Decoration = CM.Decoration;

  var MAX_LINE = 2000;
  // Cheap gate before the real parse: nothing date-like → skip the line.
  var MAYBE = /\d|to(?:d|n|m)|tmrw|yesterday|mon|tue|wed|thu|fri|sat|sun|week|month|year|ago|noon|night|morning|evening|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i;
  // Spans where a date is not prose: `code`, URLs, ](link targets), @remind tokens (to EOL).
  var NO_GO = /`[^`\n]+`|\bhttps?:\/\/\S+|\bwww\.\S+|\]\([^)\n]*\)|@remind![^\n]*/gi;
  var REMIND_RE = /@remind!([^!\n]{3,40})(?:!([^\n]*))?/i;

  function inFence(pos) { try { return !!(Cade.inCodeFence && Cade.inCodeFence(pos)); } catch (e) { return false; } }
  function todayYMD(now) { return { y: now.getFullYear(), mo: now.getMonth(), d: now.getDate() }; }
  function dayKeyOf(now) { return now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate()); }
  function isoOf(c) { return c.y + '-' + p2(c.mo + 1) + '-' + p2(c.d); }
  function hmOf(t) { return p2(t.h) + ':' + p2(t.mi); }

  // Chips of one line, minus the no-go spans.
  function lineChips(text, now) {
    if (!text || text.length > MAX_LINE || !MAYBE.test(text)) return [];
    var chips = parseDates(text, now, ORDER);
    if (!chips.length) return chips;
    var bad = [], m;
    NO_GO.lastIndex = 0;
    while ((m = NO_GO.exec(text)) !== null) bad.push([m.index, m.index + m[0].length]);
    if (!bad.length) return chips;
    return chips.filter(function (c) {
      for (var i = 0; i < bad.length; i++) if (c.from < bad[i][1] && c.to > bad[i][0]) return false;
      return true;
    });
  }

  // ---- formatting -------------------------------------------------------------------
  function fmtDate(c, now) {
    var o = { weekday: 'short', month: 'short', day: 'numeric' };
    if (c.y !== now.getFullYear()) o.year = 'numeric';
    try { return new Date(c.y, c.mo, c.d, 12).toLocaleDateString(undefined, o); } catch (e) { return isoOf(c); }
  }
  function fmtTime(t) {
    try { return new Date(2000, 0, 1, t.h, t.mi).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return hmOf(t); }
  }
  function relLabel(c, now) {
    var n = dayDiff(todayYMD(now), c), a = Math.abs(n), u, k;
    if (n === 0 && c.time && !c.implicit) {
      var mins = Math.round((new Date(c.y, c.mo, c.d, c.time.h, c.time.mi).getTime() - now.getTime()) / 6e4), am = Math.abs(mins);
      if (am < 1) return 'now';
      var s = am < 60 ? am + ' min' : Math.round(am / 60) + ' h';
      return mins > 0 ? 'in ' + s : s + ' ago';
    }
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    if (a < 14) { k = a; u = 'day'; }
    else if (a < 60) { k = Math.round(a / 7); u = 'week'; }
    else if (a < 730) { k = Math.round(a / 30.44); u = 'month'; }
    else { k = Math.round(a / 365.25); u = 'year'; }
    var w = k + ' ' + u + (k === 1 ? '' : 's');
    return n > 0 ? 'in ' + w : w + ' ago';
  }
  function whenLabel(c, now) { return fmtDate(c, now) + (c.time ? ' \u00b7 ' + fmtTime(c.time) : ''); }
  function noteLabel(c, raw) {
    if (c.rel) return '\u201c' + raw + '\u201d counted from today';
    if (c.wdMismatch) return 'Weekday doesn\u2019t match this date';
    if (c.inferredYear) return 'No year given \u2014 nearest one assumed';
    return '';
  }

  // Line text → an event title / reminder message: the line without its
  // list / heading / quote marker, the date phrase and dangling "on" / "at".
  function cleanTitle(text, c) {
    var t = text.slice(0, c.from) + ' ' + text.slice(c.to);
    t = t.replace(/@remind![^\n]*/i, '')
      .replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+\u2022]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+(?:\[[ xX]\]\s+)?|\[[ xX]\]\s+)?/, '')
      .replace(/\*\*|__|~~|==/g, '')
      .replace(/\s+/g, ' ').trim();
    for (var i = 0; i < 3; i++) {
      t = t.replace(/[\s,;:(\-\u2013\u2014]*\b(?:on|at|by|due|for|from|until|till|before|after|in|this|next)$/i, '')
        .replace(/^(?:on|at|by|due)\b[\s,:]*/i, '').trim();
    }
    return t.replace(/^[\s,;:\-\u2013\u2014]+|[\s,;:(\-\u2013\u2014]+$/g, '').slice(0, 200);
  }

  // ---- decorations ---------------------------------------------------------------------
  var DECO = {
    fut: Decoration.mark({ class: 'cm-dchip' }),
    today: Decoration.mark({ class: 'cm-dchip cm-dchip-today' }),
    past: Decoration.mark({ class: 'cm-dchip cm-dchip-past' }),
  };
  var cache = new Map(); // dayKey + text → [[from, to, kind]]
  function cachedChips(text, now, dk) {
    var key = dk + '\u0001' + text;
    var v = cache.get(key);
    if (v) return v;
    var base = todayYMD(now);
    v = lineChips(text, now).map(function (c) {
      var n = dayDiff(base, c);
      return [c.from, c.to, n === 0 ? 'today' : n < 0 ? 'past' : 'fut'];
    });
    if (cache.size > 1500) cache.clear();
    cache.set(key, v);
    return v;
  }
  function build(view, dk) {
    var doc = view.state.doc, out = [], now = new Date(), vr = view.visibleRanges, last = 0;
    for (var r = 0; r < vr.length; r++) {
      var a = Math.max(doc.lineAt(vr[r].from).number, last + 1), b = doc.lineAt(vr[r].to).number;
      for (var i = a; i <= b; i++) {
        var line = doc.line(i), t = line.text;
        if (t.length < 3 || t.length > MAX_LINE || !MAYBE.test(t) || inFence(line.from)) continue;
        var cs = cachedChips(t, now, dk);
        for (var k = 0; k < cs.length; k++) out.push(DECO[cs[k][2]].range(line.from + cs[k][0], line.from + cs[k][1]));
      }
      last = b;
    }
    return out.length ? Decoration.set(out, true) : Decoration.none;
  }

  // The chip under document position `pos` (re-parsed now, so "in 2 hours"
  // and "today" are always current): { c, line, raw } or null.
  function chipAt(state, pos) {
    if (pos < 0 || pos > state.doc.length) return null;
    var line = state.doc.lineAt(pos);
    if (inFence(line.from)) return null;
    var cs = lineChips(line.text, new Date()), off = pos - line.from;
    for (var i = 0; i < cs.length; i++) {
      if (off >= cs[i].from && off <= cs[i].to) return { c: cs[i], line: line, raw: line.text.slice(cs[i].from, cs[i].to) };
    }
    return null;
  }

  // ---- floating UI (tooltip + popover) --------------------------------------------------
  var ICON = {
    cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 14v4M10 16h4"/>',
    rem: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    rep: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  };
  function svg(n) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[n] + '</svg>';
  }
  function esc(s) { return Cade.escapeHtml(String(s == null ? '' : s)); }
  function toast(m, type) { try { Cade.showToast(m, type || 'info', 2200); } catch (e) {} }
  function copyText(text) {
    var done = function () { toast('Copied ' + text, 'success'); };
    var fail = function () { toast('Copy failed', 'error'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      ta.remove();
    }
  }
  var CAN_HOVER = (function () { try { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; } catch (e) { return false; } })();

  // Place `el` (position: fixed) under / over the doc range [from, to], inside
  // the VISUAL viewport (a phone's keyboard must not cover it).
  function place(view, el, from, to) {
    view.requestMeasure({
      key: el,
      read: function (v) {
        if (!el.isConnected || to > v.state.doc.length) return null;
        return { a: v.coordsAtPos(from, 1), b: v.coordsAtPos(to, -1), w: el.offsetWidth, h: el.offsetHeight };
      },
      write: function (m) {
        if (!m || !el.isConnected) return;
        if (!m.a) { el.style.visibility = 'hidden'; return; }
        el.style.visibility = '';
        var vv = window.visualViewport;
        var vTop = vv ? vv.offsetTop : 0, vH = vv ? vv.height : window.innerHeight;
        var vLeft = vv ? vv.offsetLeft : 0, vW = vv ? vv.width : window.innerWidth;
        var bottom = Math.max(m.a.bottom, m.b ? m.b.bottom : 0), top = Math.min(m.a.top, m.b ? m.b.top : m.a.top);
        var down = vTop + vH - bottom - 8 >= m.h || top - vTop < m.h + 8;
        el.style.left = Math.max(vLeft + 8, Math.min(m.a.left - 6, vLeft + vW - m.w - 8)) + 'px';
        el.style.top = (down ? bottom + 6 : top - 6 - m.h) + 'px';
      },
    });
  }

  function addToCalendar(dk, title, time) {
    if (typeof window.__calAddEventFor === 'function') { window.__calAddEventFor(dk, title, time); return; }
    // Lazy module: the palette row loads + opens it; its hook appears with it.
    if (!Cade.runCommand || !Cade.runCommand('Calendar Events')) { toast('Calendar Events is not available', 'error'); return; }
    var t0 = Date.now();
    (function poll() {
      if (typeof window.__calAddEventFor === 'function' && document.getElementById('cal-panel')) {
        window.__calAddEventFor(dk, title, time);
        return;
      }
      if (Date.now() - t0 < 8000) setTimeout(poll, 60);
    })();
  }

  // ---- the plugin -----------------------------------------------------------------------
  function Chips(view) {
    this.view = view;
    this.dk = dayKeyOf(new Date());
    this.decorations = build(view, this.dk);
    this.pop = null;   // { el, from, to }
    this.tip = null;   // { el, from, to }
    this.tipTimer = 0;
    var self = this;
    this.onClick = function (e) { self.click(e); };
    this.onOver = function (e) { self.over(e); };
    this.onOut = function (e) { self.out(e); };
    this.onDocDown = function (e) { if (self.pop && !self.pop.el.contains(e.target)) self.closePop(); };
    this.onKey = function (e) {
      if (e.key === 'Escape' && self.pop) { e.preventDefault(); e.stopPropagation(); self.closePop(); }
    };
    this.onMove = function () {
      if (self.pop) place(self.view, self.pop.el, self.pop.from, self.pop.to);
      self.hideTip();
    };
    view.contentDOM.addEventListener('click', this.onClick);
    if (CAN_HOVER) {
      view.contentDOM.addEventListener('mouseover', this.onOver);
      view.contentDOM.addEventListener('mouseout', this.onOut);
    }
  }

  Chips.prototype.update = function (u) {
    var dk = dayKeyOf(new Date());
    if (u.docChanged || u.viewportChanged || dk !== this.dk) {
      this.dk = dk;
      this.decorations = build(u.view, dk);
    }
    if (u.docChanged) { this.closePop(); this.hideTip(); }
    else if (this.pop && u.selectionSet) {
      var sel = u.state.selection.main;
      if (!sel.empty || sel.head < this.pop.from || sel.head > this.pop.to) this.closePop();
    }
  };

  Chips.prototype.destroy = function () {
    this.closePop();
    this.hideTip();
    this.view.contentDOM.removeEventListener('click', this.onClick);
    this.view.contentDOM.removeEventListener('mouseover', this.onOver);
    this.view.contentDOM.removeEventListener('mouseout', this.onOut);
  };

  // The chip element's own position (exact even when other marks split it),
  // else the pointer's.
  Chips.prototype.posFromEvent = function (e, el) {
    var p = null;
    try { p = this.view.posAtDOM(el); } catch (x) {}
    if (p == null) try { p = this.view.posAtCoords({ x: e.clientX, y: e.clientY }); } catch (x) { p = null; }
    return p;
  };

  // -- hover tooltip (mouse only) --
  Chips.prototype.over = function (e) {
    var el = e.target && e.target.closest ? e.target.closest('.cm-dchip') : null;
    if (!el || this.pop) return;
    var self = this;
    clearTimeout(this.tipTimer);
    this.tipTimer = setTimeout(function () {
      if (!el.isConnected) return;
      var pos = self.posFromEvent(e, el), hit = pos == null ? null : chipAt(self.view.state, pos);
      if (hit) self.showTip(hit);
    }, 350);
  };
  Chips.prototype.out = function (e) {
    var to = e.relatedTarget;
    if (to && to.closest && to.closest('.cm-dchip')) return;
    this.hideTip();
  };
  Chips.prototype.showTip = function (hit) {
    this.hideTip();
    var now = new Date(), c = hit.c, note = noteLabel(c, hit.raw);
    var el = document.createElement('div');
    el.className = 'dc-tip';
    el.setAttribute('role', 'tooltip');
    el.innerHTML = '<div class="dc-tip-main">' + esc(whenLabel(c, now)) + ' <span class="dc-tip-rel">\u00b7 ' + esc(relLabel(c, now)) + '</span></div>' +
      (note ? '<div class="dc-tip-note">' + esc(note) + '</div>' : '');
    el.style.visibility = 'hidden';
    document.body.appendChild(el);
    var from = hit.line.from + c.from, to = hit.line.from + c.to;
    this.tip = { el: el, from: from, to: to };
    this.view.scrollDOM.addEventListener('scroll', this.onMove, { passive: true });
    place(this.view, el, from, to);
  };
  Chips.prototype.hideTip = function () {
    clearTimeout(this.tipTimer);
    if (!this.tip) return;
    this.tip.el.remove();
    this.tip = null;
    if (!this.pop) this.view.scrollDOM.removeEventListener('scroll', this.onMove);
  };

  // -- click / tap popover --
  Chips.prototype.click = function (e) {
    var el = e.target && e.target.closest ? e.target.closest('.cm-dchip') : null;
    if (!el || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    var sel = this.view.state.selection.main;
    if (!sel.empty) return; // a drag-select / double-click, not a tap on the chip
    var pos = this.posFromEvent(e, el), hit = pos == null ? null : chipAt(this.view.state, pos);
    if (!hit) return;
    this.hideTip();
    this.openPop(hit);
  };

  Chips.prototype.openPop = function (hit) {
    this.closePop();
    var view = this.view, now = new Date(), c = hit.c, note = noteLabel(c, hit.raw);
    var from = hit.line.from + c.from, to = hit.line.from + c.to;
    var iso = isoOf(c) + (c.time && !c.implicit ? ' ' + hmOf(c.time) : '');
    var hasRem = REMIND_RE.test(hit.line.text), ro = view.state.readOnly;
    var el = document.createElement('div');
    el.className = 'dc-pop';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Date: ' + whenLabel(c, now));
    el.innerHTML =
      '<div class="dc-head"><div class="dc-when">' + esc(whenLabel(c, now)) + '</div>' +
        '<div class="dc-rel">' + esc(relLabel(c, now)) + '</div>' +
        (note ? '<div class="dc-note">' + esc(note) + '</div>' : '') + '</div>' +
      '<div class="dc-acts">' +
        '<button type="button" class="dc-act" data-a="cal">' + svg('cal') + '<span>Add to Calendar</span></button>' +
        '<button type="button" class="dc-act" data-a="rem"' + (ro ? ' disabled' : '') + '>' + svg('rem') + '<span>' + (hasRem ? 'Update reminder' : 'Set reminder') + '</span></button>' +
        '<button type="button" class="dc-act" data-a="rep"' + (ro ? ' disabled' : '') + '>' + svg('rep') + '<span>Replace with <b>' + esc(iso) + '</b></span></button>' +
        '<button type="button" class="dc-act" data-a="copy">' + svg('copy') + '<span>Copy date</span></button>' +
      '</div>';
    el.style.visibility = 'hidden';
    // Keep the editor's focus (and a phone's keyboard state) while tapping buttons.
    el.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    var self = this;
    el.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('.dc-act') : null;
      if (!b || b.disabled) return;
      self.act(b.getAttribute('data-a'), from, to);
    });
    document.body.appendChild(el);
    this.pop = { el: el, from: from, to: to };
    document.addEventListener('pointerdown', this.onDocDown, true);
    document.addEventListener('keydown', this.onKey, true);
    view.scrollDOM.addEventListener('scroll', this.onMove, { passive: true });
    window.addEventListener('resize', this.onMove);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this.onMove);
      window.visualViewport.addEventListener('scroll', this.onMove);
    }
    place(view, el, from, to);
  };

  Chips.prototype.closePop = function () {
    if (!this.pop) return;
    this.pop.el.remove();
    this.pop = null;
    document.removeEventListener('pointerdown', this.onDocDown, true);
    document.removeEventListener('keydown', this.onKey, true);
    if (!this.tip) this.view.scrollDOM.removeEventListener('scroll', this.onMove);
    window.removeEventListener('resize', this.onMove);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this.onMove);
      window.visualViewport.removeEventListener('scroll', this.onMove);
    }
  };

  Chips.prototype.act = function (a, from, to) {
    var view = this.view, hit = chipAt(view.state, from);
    this.closePop();
    if (!hit || hit.line.from + hit.c.from !== from) { toast('That date changed \u2014 tap it again', 'error'); return; }
    var c = hit.c, line = hit.line, now = new Date();
    var iso = isoOf(c), withTime = iso + (c.time && !c.implicit ? ' ' + hmOf(c.time) : '');
    if (a === 'copy') { copyText(withTime); return; }
    if (a === 'cal') { addToCalendar(iso, cleanTitle(line.text, c) || hit.raw, c.time ? hmOf(c.time) : ''); return; }
    if (view.state.readOnly) { toast('Read-only mode \u2014 unlock to edit', 'error'); return; }
    if (a === 'rep') {
      view.dispatch({ changes: { from: from, to: to, insert: withTime }, selection: { anchor: from + withTime.length }, userEvent: 'input' });
      return;
    }
    if (a === 'rem') {
      // Date only: the Reminders module rings at 09:00 — except today, where
      // that may be gone already, so the next full hour instead.
      var t = c.time, spec;
      if (!t && dayDiff(todayYMD(now), c) === 0) t = { h: Math.min(23, now.getHours() + 1), mi: 0 };
      spec = t ? iso + ' ' + hmOf(t) : iso;
      var at = t ? new Date(c.y, c.mo, c.d, t.h, t.mi) : new Date(c.y, c.mo, c.d, 9, 0);
      if (at.getTime() < now.getTime() - 60000) { toast('That time has already passed', 'error'); return; }
      var m = REMIND_RE.exec(line.text), changes;
      if (m) {
        var s0 = line.from + m.index + '@remind!'.length;
        changes = { from: s0, to: s0 + m[1].length, insert: spec };
      } else {
        var msg = cleanTitle(line.text, c) || 'Reminder';
        var pad = /\s$/.test(line.text) || !line.text ? '' : ' ';
        changes = { from: line.to, insert: pad + '@remind!' + spec + '!' + msg };
      }
      view.dispatch({ changes: changes, userEvent: 'input' });
      toast('Reminder set for ' + whenLabel({ y: c.y, mo: c.mo, d: c.d, time: t }, now) + (t ? '' : ' (09:00)'), 'success');
    }
  };

  var plugin = ViewPlugin.fromClass(Chips, { decorations: function (v) { return v.decorations; } });
  Cade.registerPlugin({ id: 'datechips', ext: plugin });
})();
