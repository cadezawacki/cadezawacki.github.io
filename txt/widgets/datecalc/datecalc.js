/* Date Calculator — three tools in one panel:
 *   Difference  between two dates: days, weeks + days, months + days,
 *               years/months/days, business days (Mon–Fri), hours/minutes;
 *               optionally counting the end date too.
 *   Add / sub   date ± N days / weeks / months / years / business days.
 *   Date info   weekday, ISO week, day of year, quarter, days until/since
 *               today, Unix timestamps, leap year, days in month.
 * Rows click-to-copy; Copy / Insert act on a one-line summary. Dates default
 * to today; a selected date (or two) in the editor prefills the inputs.
 *
 * All maths runs on whole calendar days (UTC day numbers), so DST shifts and
 * time zones can't produce off-by-one answers. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('datecalc.css');
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'datecalc-panel';
  var PREFS_KEY = 'cade-datecalc-prefs';
  var DAY = 864e5;

  // ---- date utils (pure) ------------------------------------------------------
  // A date is {y, m (1-12), d}; a "day number" (dn) is days since 1970-01-01.
  function dn(y, m, d) {
    var t = new Date(0);
    t.setUTCFullYear(y, m - 1, d); // unlike Date.UTC, keeps years 0-99 literal
    return Math.round(t.getTime() / DAY);
  }
  function dnOf(o) { return dn(o.y, o.m, o.d); }
  function fromDn(n) { var t = new Date(n * DAY); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; }
  function weekday(n) { return ((n % 7) + 7 + 4) % 7; } // 1970-01-01 was a Thursday; 0 = Sunday
  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  function daysInMonth(y, m) { return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }
  function valid(o) { return !!o && o.y >= 1 && o.y <= 9999 && o.m >= 1 && o.m <= 12 && o.d >= 1 && o.d <= daysInMonth(o.y, o.m); }
  function todayDate() { var t = new Date(); return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() }; }
  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
  function iso(o) { return pad(o.y, 4) + '-' + pad(o.m) + '-' + pad(o.d); }

  // Add calendar months, clamping to the month's last day (Jan 31 + 1 month = Feb 28/29).
  function addMonths(o, n) {
    var t = o.y * 12 + (o.m - 1) + n;
    var y = Math.floor(t / 12), m = t - y * 12 + 1;
    var dim = daysInMonth(y, m);
    return { y: y, m: m, d: Math.min(o.d, dim), clamped: o.d > dim };
  }
  // Whole months from a to b (a <= b) plus leftover days.
  function monthsBetween(a, b) {
    var months = (b.y - a.y) * 12 + (b.m - a.m);
    while (months > 0 && dnOf(addMonths(a, months)) > dnOf(b)) months--;
    return { months: months, days: dnOf(b) - dnOf(addMonths(a, months)) };
  }
  // Weekdays (Mon–Fri) in the half-open day range [s, e).
  function businessDays(s, e) {
    if (e <= s) return 0;
    var n = e - s, full = Math.floor(n / 7), count = full * 5;
    for (var k = s + full * 7; k < e; k++) { var w = weekday(k); if (w !== 0 && w !== 6) count++; }
    return count;
  }
  // Step n business days from day number s (skipping Sat/Sun).
  function addBusinessDays(s, n) {
    var step = n < 0 ? -1 : 1, left = Math.abs(n), cur = s;
    if (left > 5) {
      // any 7 consecutive days hold exactly 5 weekdays, so jump whole weeks
      var weeks = Math.floor((left - 1) / 5);
      cur += step * weeks * 7; left -= weeks * 5;
    }
    while (left > 0) {
      cur += step;
      var w = weekday(cur);
      if (w !== 0 && w !== 6) left--;
    }
    return cur;
  }
  function isoWeek(o) {
    var n = dnOf(o), wd = (weekday(n) + 6) % 7; // Monday = 0
    var thu = n - wd + 3, ty = fromDn(thu).y;
    return { year: ty, week: Math.floor((thu - dn(ty, 1, 1)) / 7) + 1 };
  }

  // ---- parsing selected text ------------------------------------------------------
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
  function monthIdx(s) { return MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1; }
  function fullYear(y) { y = +y; return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y; }
  function dayFirst() {
    var l = (navigator.language || 'en-US').toLowerCase();
    return !/^en-(us|ph|ca)$|^en$/.test(l);
  }
  var PATTERNS = [
    // 2026-10-12, 2026/10/12, 2026.10.12
    { re: /\b(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/g, f: function (m) { return { y: +m[1], m: +m[2], d: +m[3] }; } },
    // 10/12/2026, 12.10.2026, 12-10-26
    { re: /\b(\d{1,2})([\/.\-])(\d{1,2})\2(\d{4}|\d{2})\b/g, f: function (m) {
      var a = +m[1], b = +m[3], y = fullYear(m[4]);
      var dmy = a > 12 || (b <= 12 && (m[2] === '.' || dayFirst()));
      return dmy ? { y: y, m: b, d: a } : { y: y, m: a, d: b };
    } },
    // Oct 12, 2026 · October 12th · Oct 12
    { re: new RegExp('\\b' + MON_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b', 'gi'), f: function (m) {
      return { y: m[3] ? +m[3] : todayDate().y, m: monthIdx(m[1]), d: +m[2] };
    } },
    // 12 Oct 2026 · 12th of October · 12 October
    { re: new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MON_RE + '(?:,?\\s+(\\d{4}))?\\b', 'gi'), f: function (m) {
      return { y: m[3] ? +m[3] : todayDate().y, m: monthIdx(m[2]), d: +m[1] };
    } },
    { re: /\b(today|tomorrow|yesterday)\b/gi, f: function (m) {
      var k = m[1].toLowerCase(), t = dnOf(todayDate());
      return fromDn(t + (k === 'tomorrow' ? 1 : k === 'yesterday' ? -1 : 0));
    } }
  ];
  // All dates in a piece of text, in order of appearance.
  function findDates(text) {
    var hits = [];
    PATTERNS.forEach(function (p) {
      p.re.lastIndex = 0;
      var m;
      while ((m = p.re.exec(text))) {
        var o = p.f(m);
        if (!valid(o)) continue;
        var s = m.index, e = s + m[0].length;
        if (hits.some(function (h) { return s < h.e && e > h.s; })) continue; // earlier patterns win overlaps
        hits.push({ s: s, e: e, date: { y: o.y, m: o.m, d: o.d } });
      }
    });
    hits.sort(function (a, b) { return a.s - b.s; });
    return hits.map(function (h) { return h.date; });
  }

  // ---- formatting --------------------------------------------------------------------
  function plural(n, w) { return n + ' ' + w + (Math.abs(n) === 1 ? '' : 's'); }
  function local(o, opts) { try { return new Date(o.y, o.m - 1, o.d, 12).toLocaleDateString(undefined, opts); } catch (e) { return iso(o); } }
  function longDate(o) { return local(o, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }); }
  function fmtDate(o, f) {
    if (f === 'long') return local(o, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    if (f === 'local') return local(o, {});
    return iso(o);
  }
  function group(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function joinParts(parts) {
    var p = parts.filter(function (x) { return x; });
    return p.length ? p.join(', ') : '0 days';
  }

  // ---- state + persistence -------------------------------------------------------
  var prefs = { tab: 'diff', inclEnd: false, op: '+', n: '30', unit: 'days', fmt: 'iso' };
  var dates = { from: null, to: null, start: null, info: null };
  function loadPrefs() {
    try {
      var p = JSON.parse(Cade.store.get(PREFS_KEY) || 'null');
      if (p && typeof p === 'object') for (var k in prefs) if (typeof p[k] === typeof prefs[k]) prefs[k] = p[k];
    } catch (e) {}
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }

  function panel() { return document.getElementById(PANEL_ID); }
  function readDate(cls) {
    var p = panel(), el = p && p.querySelector(cls);
    if (!el || !el.value) return null;
    var m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(el.value);
    var o = m ? { y: +m[1], m: +m[2], d: +m[3] } : (findDates(el.value)[0] || null);
    return valid(o) ? o : null;
  }
  function setDate(cls, o) { var p = panel(), el = p && p.querySelector(cls); if (el && o) el.value = iso(o); }

  // ---- computations (each returns {rows:[[label,value]], summary} or {error}) ----------
  function computeDiff() {
    var a = readDate('.dc-from'), b = readDate('.dc-to');
    if (!a || !b) return { error: 'Pick both dates' };
    var sa = dnOf(a), sb = dnOf(b), sign = sb < sa ? -1 : 1;
    var lo = sign > 0 ? a : b, hi = sign > 0 ? b : a;
    var hiEnd = prefs.inclEnd ? fromDn(dnOf(hi) + 1) : hi; // counting the end date = one more day
    var days = dnOf(hiEnd) - dnOf(lo);
    var mb = monthsBetween(lo, hiEnd);
    var ys = Math.floor(mb.months / 12), ms = mb.months % 12;
    var bd = businessDays(dnOf(lo), dnOf(hiEnd));
    var neg = sign < 0 ? '\u2212' : '';
    var wk = Math.floor(days / 7), wr = days % 7;
    var rows = [
      ['Days', neg + group(days) + ' day' + (days === 1 ? '' : 's')],
      ['Weeks', neg + joinParts([wk ? plural(wk, 'week') : '', wr || !wk ? plural(wr, 'day') : ''])],
      ['Months', neg + joinParts([mb.months ? plural(mb.months, 'month') : '', mb.days || !mb.months ? plural(mb.days, 'day') : ''])],
      ['Years', neg + joinParts([ys ? plural(ys, 'year') : '', ms ? plural(ms, 'month') : '', mb.days || (!ys && !ms) ? plural(mb.days, 'day') : ''])],
      ['Business days', neg + group(bd) + ' (Mon\u2013Fri)'],
      ['Weekend days', neg + group(days - bd)],
      ['Hours', neg + group(days * 24)],
      ['Minutes', neg + group(days * 1440)],
      ['Seconds', neg + group(days * 86400)]
    ];
    var summary = iso(a) + ' \u2192 ' + iso(b) + ': ' + neg + plural(days, 'day') +
      (days >= 7 ? ' (' + rows[ys ? 3 : (mb.months ? 2 : 1)][1].replace(/^\u2212/, '') + ')' : '') +
      ', ' + plural(bd, 'business day') + (prefs.inclEnd ? ', end date included' : '');
    return { rows: rows, summary: summary, note: (sign < 0 ? 'End is before start \u2014 shown as negative. ' : '') + longDate(a) + ' \u2192 ' + longDate(b) };
  }

  function computeAdd() {
    var s = readDate('.dc-start');
    if (!s) return { error: 'Pick a start date' };
    var raw = String(prefs.n).trim();
    if (!/^\d{1,7}$/.test(raw)) return { error: 'Enter a whole number' };
    var n = +raw * (prefs.op === '-' ? -1 : 1), r, clamped = false;
    if (prefs.unit === 'days') r = fromDn(dnOf(s) + n);
    else if (prefs.unit === 'weeks') r = fromDn(dnOf(s) + 7 * n);
    else if (prefs.unit === 'months' || prefs.unit === 'years') { r = addMonths(s, prefs.unit === 'years' ? 12 * n : n); clamped = r.clamped; }
    else r = fromDn(addBusinessDays(dnOf(s), n));
    if (!valid(r)) return { error: 'Out of range' };
    var diff = dnOf(r) - dnOf(s);
    var rows = [
      ['Result', fmtDate(r, prefs.fmt)],
      ['ISO', iso(r)],
      ['Weekday', local(r, { weekday: 'long' })],
      ['Long', local(r, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })],
      ['Span', (diff < 0 ? '\u2212' : '') + plural(Math.abs(diff), 'day') + ' \u00b7 ' + plural(businessDays(Math.min(dnOf(s), dnOf(r)), Math.max(dnOf(s), dnOf(r))), 'business day')]
    ];
    var unitWord = prefs.unit === 'business' ? 'business day' : prefs.unit.replace(/s$/, '');
    return {
      rows: rows, result: r,
      summary: fmtDate(r, prefs.fmt),
      note: iso(s) + ' ' + (n < 0 ? '\u2212' : '+') + ' ' + plural(Math.abs(n), unitWord) + ' = ' + longDate(r) +
        (clamped ? ' (day clamped to the end of the month)' : '')
    };
  }

  function computeInfo() {
    var o = readDate('.dc-info');
    if (!o) return { error: 'Pick a date' };
    var n = dnOf(o), t = dnOf(todayDate()), rel = n - t;
    var w = isoWeek(o), doy = n - dn(o.y, 1, 1) + 1, ylen = isLeap(o.y) ? 366 : 365;
    var localTs = Math.floor(new Date(o.y, o.m - 1, o.d).getTime() / 1000);
    var rows = [
      ['Weekday', local(o, { weekday: 'long' })],
      ['ISO week', w.year + '-W' + pad(w.week) + ' (week ' + w.week + ')'],
      ['Day of year', doy + ' of ' + ylen + ' (' + (ylen - doy) + ' left)'],
      ['Quarter', 'Q' + Math.ceil(o.m / 3) + ' ' + o.y],
      ['From today', rel === 0 ? 'Today' : rel > 0 ? 'In ' + plural(rel, 'day') : plural(-rel, 'day') + ' ago'],
      ['Business days', rel === 0 ? '0' : (rel > 0 ? businessDays(t + 1, n + 1) + ' until' : businessDays(n, t) + ' since')],
      ['Unix (local 00:00)', String(localTs)],
      ['Unix (UTC 00:00)', String(n * 86400)],
      ['Leap year', isLeap(o.y) ? 'Yes' : 'No'],
      ['Days in month', String(daysInMonth(o.y, o.m))]
    ];
    return {
      rows: rows,
      summary: iso(o) + ' \u2014 ' + rows[0][1] + ', ' + w.year + '-W' + pad(w.week) + ', day ' + doy + ', Q' + Math.ceil(o.m / 3),
      note: local(o, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    };
  }

  var last = null;
  function render() {
    var p = panel(); if (!p) return;
    p.querySelectorAll('.dc-tab').forEach(function (b) {
      var on = b.getAttribute('data-tab') === prefs.tab;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on));
    });
    p.querySelectorAll('.dc-sec').forEach(function (s) { s.hidden = s.getAttribute('data-sec') !== prefs.tab; });
    last = prefs.tab === 'diff' ? computeDiff() : prefs.tab === 'add' ? computeAdd() : computeInfo();
    var out = p.querySelector('.dc-out');
    if (last.error) { out.innerHTML = '<div class="dc-empty">' + esc(last.error) + '</div>'; return; }
    out.innerHTML = '<div class="dc-note">' + esc(last.note || '') + '</div>' + last.rows.map(function (r, i) {
      return '<div class="dc-row' + (i === 0 ? ' main' : '') + '" data-i="' + i + '" title="Click to copy"><span class="dc-k">' + esc(r[0]) + '</span><span class="dc-v">' + esc(r[1]) + '</span></div>';
    }).join('');
  }

  // ---- actions ----------------------------------------------------------------------
  function copyText(text) {
    var done = function () { Cade.showToast('Copied ' + text, 'success', 1400); };
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
    if (!ed || !text) return;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode \u2014 editing is locked', 'error', 2000); return; }
    ed.dispatch(ed.state.replaceSelection(text), { userEvent: 'input', scrollIntoView: true });
    Cade.showToast('Inserted ' + (text.length > 48 ? text.slice(0, 48) + '\u2026' : text), 'success', 1200);
  }

  function close() {
    var p = panel();
    if (!p) return;
    p.remove();
    if (p._onClose) p._onClose();
  }

  // One date selected → info (and start points); two → a difference.
  function seedFromSelection() {
    try {
      var ed = Cade.editor, sel = ed.state.selection.main;
      if (sel.empty || sel.to - sel.from > 200) return;
      var found = findDates(ed.state.sliceDoc(sel.from, sel.to));
      if (found.length >= 2) {
        dates.from = found[0]; dates.to = found[1]; dates.start = found[0]; dates.info = found[0];
        prefs.tab = 'diff';
      } else if (found.length === 1) {
        dates.from = dates.start = dates.info = found[0];
        if (prefs.tab === 'diff') prefs.tab = 'info';
      }
    } catch (e) {}
  }

  function dateField(cls, label) {
    return '<label class="dc-field"><span>' + label + '</span><input type="date" class="dc-date ' + cls + '" min="0001-01-01" max="9999-12-31">' +
      '<button class="dc-today" data-for="' + cls + '" title="Set to today">Today</button></label>';
  }

  function open() {
    Cade.closeAllMenus();
    var existing = panel();
    if (existing) { existing.remove(); if (existing._onClose) existing._onClose(); }
    loadPrefs();
    var t = todayDate();
    dates = { from: t, to: t, start: t, info: t };
    seedFromSelection();
    var p = Cade.mkPanel(PANEL_ID, '\ud83d\udcc5 Date Calculator',
      '<div class="dc-tabs" role="tablist">' +
        '<button class="dc-tab" data-tab="diff" role="tab">Difference</button>' +
        '<button class="dc-tab" data-tab="add" role="tab">Add / subtract</button>' +
        '<button class="dc-tab" data-tab="info" role="tab">Date info</button>' +
      '</div>' +
      '<div class="dc-sec" data-sec="diff">' +
        dateField('dc-from', 'From') + dateField('dc-to', 'To') +
        '<label class="dc-check"><input type="checkbox" class="dc-incl"> Include the end date (count both days)</label>' +
      '</div>' +
      '<div class="dc-sec" data-sec="add" hidden>' +
        dateField('dc-start', 'Start') +
        '<div class="dc-addrow">' +
          '<select class="dc-op" aria-label="Add or subtract"><option value="+">+ add</option><option value="-">\u2212 subtract</option></select>' +
          '<input class="dc-n" type="text" inputmode="numeric" aria-label="Amount" autocomplete="off">' +
          '<select class="dc-unit" aria-label="Unit"><option value="days">days</option><option value="weeks">weeks</option>' +
            '<option value="months">months</option><option value="years">years</option><option value="business">business days</option></select>' +
        '</div>' +
        '<label class="dc-check">Result format <select class="dc-fmt"><option value="iso">2026-12-31</option><option value="long">Long</option><option value="local">Local</option></select></label>' +
      '</div>' +
      '<div class="dc-sec" data-sec="info" hidden>' + dateField('dc-info', 'Date') + '</div>' +
      '<div class="dc-out"></div>' +
      '<div class="dc-acts">' +
        '<button class="dc-btn primary" data-act="insert" title="Insert the summary at the cursor">\u21b5 Insert</button>' +
        '<button class="dc-btn" data-act="copy" title="Copy the summary">\u29c9 Copy</button>' +
        '<span class="dc-hint">Click a row to copy it</span>' +
      '</div>');

    setDate('.dc-from', dates.from); setDate('.dc-to', dates.to); setDate('.dc-start', dates.start); setDate('.dc-info', dates.info);
    p.querySelector('.dc-incl').checked = prefs.inclEnd;
    p.querySelector('.dc-op').value = prefs.op;
    p.querySelector('.dc-n').value = prefs.n;
    p.querySelector('.dc-unit').value = prefs.unit;
    p.querySelector('.dc-fmt').value = prefs.fmt;

    p.addEventListener('input', function (e) {
      var c = e.target.classList;
      if (c.contains('dc-n')) prefs.n = e.target.value;
      render(); savePrefs();
    });
    p.addEventListener('change', function (e) {
      var c = e.target.classList;
      if (c.contains('dc-incl')) prefs.inclEnd = e.target.checked;
      else if (c.contains('dc-op')) prefs.op = e.target.value;
      else if (c.contains('dc-unit')) prefs.unit = e.target.value;
      else if (c.contains('dc-fmt')) prefs.fmt = e.target.value;
      savePrefs(); render();
    });
    p.addEventListener('click', function (e) {
      var t2 = e.target;
      if (!t2 || !t2.closest) return;
      var b;
      if ((b = t2.closest('.dc-tab'))) { prefs.tab = b.getAttribute('data-tab'); savePrefs(); render(); }
      else if ((b = t2.closest('.dc-today'))) { e.preventDefault(); setDate('.' + b.getAttribute('data-for'), todayDate()); render(); }
      else if ((b = t2.closest('.dc-row'))) { if (last && last.rows) copyText(last.rows[+b.getAttribute('data-i')][1]); }
      else if ((b = t2.closest('[data-act]'))) {
        if (!last || last.error) { Cade.showToast(last ? last.error : 'Nothing yet', 'info', 1400); return; }
        if (b.getAttribute('data-act') === 'copy') copyText(last.summary); else insertText(last.summary);
      }
    });
    p.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); try { Cade.editor.focus(); } catch (x) {} }
      e.stopPropagation(); // keep editor/global shortcuts out of the panel
    });
    render();
  }

  Cade.registerWidget({
    name: 'Date Calculator',
    description: 'Days between dates, business days, add/subtract days or months, week numbers',
    icon: '\ud83d\udcc5',
    tags: 'date,dates,calculator,days,between,difference,duration,business days,workdays,add days,weeks,months,iso week,week number,day of year,countdown,unix timestamp',
    open: open,
    _utils: { dn: dn, fromDn: fromDn, weekday: weekday, addMonths: addMonths, monthsBetween: monthsBetween, businessDays: businessDays,
      addBusinessDays: addBusinessDays, isoWeek: isoWeek, findDates: findDates, valid: valid }, // exposed for tests
  });
})();
