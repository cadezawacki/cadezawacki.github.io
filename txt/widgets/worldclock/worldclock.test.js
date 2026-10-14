/* Unit tests for the World Clock widget's pure core (offsets, DST, conversion,
 * overlap, search, parsing, formatting). Not loaded by the app (not in the
 * manifest). Node has full ICU, so Intl time zones work here.
 * Run: node txt/widgets/worldclock/worldclock.test.js */
'use strict';
var assert = require('assert');
var C = require('./worldclock.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var MIN = 60000, HOUR = 3600000;
function U(y, mo, d, h, mi) { return Date.UTC(y, mo - 1, d, h || 0, mi || 0); }
function iso(ms) { return new Date(ms).toISOString().slice(0, 16) + 'Z'; }
var IANA = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
var I = C.buildIndex(C.CITIES, IANA);
function names(q, n) { return C.search(I, q, n || 5).map(function (r) { return r.e.name; }); }
function P(text, now, local) {
  return C.parseQuery(text, { now: now || U(2026, 10, 14, 20, 0), localZone: local || 'America/Chicago', index: I });
}

// ---- offsets & DST --------------------------------------------------------------------
test('basic offsets', function () {
  assert.strictEqual(C.offsetAt('UTC', U(2026, 1, 1)), 0);
  assert.strictEqual(C.offsetAt('Asia/Tokyo', U(2026, 7, 1)), 540);
  assert.strictEqual(C.offsetAt('Europe/Paris', U(2026, 1, 15)), 60);
  assert.strictEqual(C.offsetAt('Europe/Paris', U(2026, 7, 15)), 120);
  assert.strictEqual(C.offsetAt('+05:30', U(2026, 1, 1)), 330);
  assert.strictEqual(C.offsetAt('-03:00', U(2026, 1, 1)), -180);
});

test('America/New_York DST: March 8 2026 spring forward at 2:00 EST (07:00Z)', function () {
  var z = 'America/New_York';
  assert.strictEqual(C.offsetAt(z, U(2026, 3, 8, 6, 59)), -300);
  assert.strictEqual(C.offsetAt(z, U(2026, 3, 8, 7, 0)), -240);
  var r = C.dayRange({ y: 2026, m: 3, d: 8 }, z);
  assert.strictEqual(iso(r.start), '2026-03-08T05:00Z');
  assert.strictEqual((r.end - r.start) / HOUR, 23, 'a 23-hour day');
  // 2:30 doesn't exist: moves forward to 3:30 EDT
  assert.strictEqual(iso(C.zonedToUtc(2026, 3, 8, 2, 30, z)), '2026-03-08T07:30Z');
  var p = C.partsAt(z, C.zonedToUtc(2026, 3, 8, 2, 30, z));
  assert.deepStrictEqual([p.h, p.mi], [3, 30]);
  assert.strictEqual(iso(C.zonedToUtc(2026, 3, 8, 1, 59, z)), '2026-03-08T06:59Z');
  assert.strictEqual(iso(C.zonedToUtc(2026, 3, 8, 3, 0, z)), '2026-03-08T07:00Z');
});

test('America/New_York DST: November 1 2026 fall back (1:30 happens twice)', function () {
  var z = 'America/New_York';
  assert.strictEqual(C.offsetAt(z, U(2026, 11, 1, 5, 59)), -240);
  assert.strictEqual(C.offsetAt(z, U(2026, 11, 1, 6, 0)), -300);
  assert.strictEqual(iso(C.zonedToUtc(2026, 11, 1, 1, 30, z)), '2026-11-01T05:30Z', 'first (EDT) occurrence');
  var r = C.dayRange({ y: 2026, m: 11, d: 1 }, z);
  assert.strictEqual((r.end - r.start) / HOUR, 25, 'a 25-hour day');
  assert.strictEqual(iso(C.zonedToUtc(2026, 11, 1, 3, 0, z)), '2026-11-01T08:00Z');
});

test('Europe/London DST: March 29 and October 25 2026', function () {
  var z = 'Europe/London';
  assert.strictEqual(C.offsetAt(z, U(2026, 3, 29, 0, 59)), 0);
  assert.strictEqual(C.offsetAt(z, U(2026, 3, 29, 1, 0)), 60);
  assert.strictEqual(C.offsetAt(z, U(2026, 10, 25, 0, 59)), 60);
  assert.strictEqual(C.offsetAt(z, U(2026, 10, 25, 1, 0)), 0);
  assert.strictEqual((function () { var r = C.dayRange({ y: 2026, m: 3, d: 29 }, z); return (r.end - r.start) / HOUR; })(), 23);
  assert.strictEqual((function () { var r = C.dayRange({ y: 2026, m: 10, d: 25 }, z); return (r.end - r.start) / HOUR; })(), 25);
  assert.strictEqual(iso(C.zonedToUtc(2026, 3, 29, 1, 30, z)), '2026-03-29T01:30Z', '01:30 skipped → 02:30 BST');
  assert.strictEqual(iso(C.zonedToUtc(2026, 10, 25, 1, 30, z)), '2026-10-25T00:30Z', '01:30 twice → first (BST)');
});

test('New York ↔ London gap shrinks to 4 h between the US and EU switches', function () {
  var t = U(2026, 3, 16, 15, 0);   // US already on EDT, UK still on GMT
  assert.strictEqual(C.offsetAt('Europe/London', t) - C.offsetAt('America/New_York', t), 240);
  t = U(2026, 4, 16, 15, 0);
  assert.strictEqual(C.offsetAt('Europe/London', t) - C.offsetAt('America/New_York', t), 300);
  t = U(2026, 10, 28, 15, 0);      // UK back on GMT, US still on EDT
  assert.strictEqual(C.offsetAt('Europe/London', t) - C.offsetAt('America/New_York', t), 240);
});

test('isDst: both hemispheres, and zones without DST', function () {
  assert.strictEqual(C.isDst('America/New_York', U(2026, 7, 1)), true);
  assert.strictEqual(C.isDst('America/New_York', U(2026, 1, 15)), false);
  assert.strictEqual(C.isDst('Australia/Sydney', U(2026, 1, 15)), true);
  assert.strictEqual(C.isDst('Australia/Sydney', U(2026, 7, 1)), false);
  assert.strictEqual(C.isDst('Asia/Tokyo', U(2026, 7, 1)), false);
  assert.strictEqual(C.isDst('America/Phoenix', U(2026, 7, 1)), false);
  assert.strictEqual(C.isDst('+05:30', U(2026, 7, 1)), false);
});

test('nextTransition finds the exact instant', function () {
  var tr = C.nextTransition('America/New_York', U(2026, 10, 14, 12, 0), 30);
  assert.ok(tr);
  assert.strictEqual(iso(tr.at), '2026-11-01T06:00Z');
  assert.deepStrictEqual([tr.from, tr.to], [-240, -300]);
  assert.strictEqual(C.changeNote('America/New_York', tr), 'Clocks go back 1 h on Sun 1 Nov');
  var lon = C.nextTransition('Europe/London', U(2026, 3, 20), 14);
  assert.strictEqual(iso(lon.at), '2026-03-29T01:00Z');
  assert.strictEqual(C.changeNote('Europe/London', lon), 'Clocks go forward 1 h on Sun 29 Mar');
  assert.strictEqual(C.nextTransition('America/New_York', U(2026, 10, 14), 14), null, 'more than 14 days away');
  assert.strictEqual(C.nextTransition('Asia/Tokyo', U(2026, 1, 1), 365), null);
  var lh = C.nextTransition('Australia/Lord_Howe', U(2026, 9, 25), 14);  // 30-minute DST
  assert.ok(lh && lh.to - lh.from === 30, 'Lord Howe moves 30 min');
  assert.ok(/forward 30 min/.test(C.changeNote('Australia/Lord_Howe', lh)));
});

// ---- half-hour / 45-minute zones ------------------------------------------------------
test(':30 and :45 zones', function () {
  var jan = U(2026, 1, 15, 12), jul = U(2026, 7, 15, 12);
  assert.strictEqual(C.offsetAt('Asia/Kolkata', jan), 330);
  assert.strictEqual(C.offsetAt('Asia/Kathmandu', jan), 345);
  assert.strictEqual(C.offsetAt('Asia/Tehran', jul), 210);
  assert.strictEqual(C.offsetAt('Asia/Kabul', jul), 270);
  assert.strictEqual(C.offsetAt('Asia/Yangon', jul), 390);
  assert.strictEqual(C.offsetAt('Australia/Eucla', jul), 525);
  assert.strictEqual(C.offsetAt('Pacific/Marquesas', jul), -570);
  // Chatham: +12:45 in (southern) winter, +13:45 in summer
  assert.strictEqual(C.offsetAt('Pacific/Chatham', jul), 765);
  assert.strictEqual(C.offsetAt('Pacific/Chatham', jan), 825);
  // Newfoundland: −3:30 / −2:30
  assert.strictEqual(C.offsetAt('America/St_Johns', jan), -210);
  assert.strictEqual(C.offsetAt('America/St_Johns', jul), -150);
  // Adelaide: +9:30 / +10:30
  assert.strictEqual(C.offsetAt('Australia/Adelaide', jul), 570);
  assert.strictEqual(C.offsetAt('Australia/Adelaide', jan), 630);
  // conversions keep the minutes
  var t = C.zonedToUtc(2026, 10, 14, 9, 0, 'America/New_York');
  var m = C.partsAt('Asia/Kolkata', t);
  assert.deepStrictEqual([m.h, m.mi, m.d], [18, 30, 14]);
  var k = C.partsAt('Asia/Kathmandu', t);
  assert.deepStrictEqual([k.h, k.mi], [18, 45]);
  assert.strictEqual(C.fmtDiff(C.offsetAt('Asia/Kolkata', t) - C.offsetAt('America/New_York', t)), '+9:30');
  assert.strictEqual(C.fmtDiff(C.offsetAt('America/St_Johns', t) - C.offsetAt('Europe/London', t)), '−3:30');
});

test('hour marks follow each zone\'s own whole hours', function () {
  var r = C.dayRange({ y: 2026, m: 10, d: 14 }, 'Europe/London');
  var mk = C.hourMarks('Asia/Kolkata', r.start, r.end);
  assert.strictEqual(mk.length, 24);
  assert.strictEqual((mk[0].t - r.start) / MIN, 30, 'first whole Mumbai hour is 30 min into the London day');
  assert.strictEqual(mk[0].h, 5);
  var nk = C.hourMarks('Asia/Kathmandu', r.start, r.end);
  assert.strictEqual((nk[0].t - r.start) / MIN, 15);
  var ny = C.dayRange({ y: 2026, m: 3, d: 8 }, 'America/New_York');
  var own = C.hourMarks('America/New_York', ny.start, ny.end);
  assert.strictEqual(own.length, 23);
  assert.deepStrictEqual(own.slice(0, 4).map(function (x) { return x.h; }), [0, 1, 3, 4], 'no 2 AM that day');
  var lh = C.dayRange({ y: 2026, m: 10, d: 4 }, 'Australia/Lord_Howe');  // DST starts: 2:00 → 2:30
  var lm = C.hourMarks('Australia/Lord_Howe', lh.start, lh.end);
  lm.forEach(function (x) { assert.strictEqual(C.partsAt('Australia/Lord_Howe', x.t).mi, 0); });
});

// ---- date line ----------------------------------------------------------------------
test('date line: Auckland vs Honolulu', function () {
  var t = U(2026, 10, 14, 20, 0);
  var hnl = C.partsAt('Pacific/Honolulu', t), akl = C.partsAt('Pacific/Auckland', t);
  assert.deepStrictEqual([hnl.d, hnl.h, hnl.off], [14, 10, -600]);
  assert.deepStrictEqual([akl.d, akl.h, akl.off], [15, 9, 780]);
  assert.strictEqual(C.dayDiff(hnl, akl), 1);
  assert.strictEqual(C.relDay(C.dayDiff(hnl, akl)), 'Tomorrow');
  assert.strictEqual(C.relDay(C.dayDiff(akl, hnl)), 'Yesterday');
  assert.strictEqual(C.fmtDiff(akl.off - hnl.off), '+23 h');
  // NZ in winter is +12 → 22 h apart
  var w = U(2026, 7, 1, 0, 0);
  assert.strictEqual(C.offsetAt('Pacific/Auckland', w) - C.offsetAt('Pacific/Honolulu', w), 1320);
  // +14 and −11 are 25 h apart: an hour later on the wall clock, a day ahead
  var k = C.partsAt('Pacific/Kiritimati', t), pp = C.partsAt('Pacific/Pago_Pago', t);
  assert.strictEqual(k.off - pp.off, 25 * 60);
  assert.deepStrictEqual([pp.d, pp.h, k.d, k.h], [14, 9, 15, 10]);
  assert.strictEqual(C.dayDiff(pp, k), 1);
});

test('Samoa skipped 30 Dec 2011 (crossed the date line)', function () {
  var r = C.dayRange({ y: 2011, m: 12, d: 29 }, 'Pacific/Apia');
  var next = C.partsAt('Pacific/Apia', r.end);
  assert.deepStrictEqual([next.d, next.m], [31, 12]);
});

// ---- overlap ----------------------------------------------------------------------------
function ovFor(zones, ymd, local, ws, we, wk) {
  var r = C.dayRange(ymd, local), n = Math.round((r.end - r.start) / C.SLOT);
  var o = C.overlap(zones.map(function (z) { return { zone: z, weekend: wk ? C.weekendOf(wk[z] || '') : null }; }), r.start, n, ws == null ? 540 : ws, we == null ? 1020 : we);
  o.spans = o.runs.map(function (run) {
    var a = C.partsAt(local, r.start + run.from * C.SLOT), b = C.partsAt(local, r.start + run.to * C.SLOT);
    return C.fmtTime(a.h, a.mi, false) + '-' + C.fmtTime(b.h, b.mi, false);
  });
  return o;
}
test('overlap: New York + London (9–17)', function () {
  var o = ovFor(['America/New_York', 'Europe/London'], { y: 2026, m: 10, d: 14 }, 'America/New_York');
  assert.strictEqual(o.all, true);
  assert.deepStrictEqual(o.spans, ['09:00-12:00']);
  // the US-only-DST weeks: London is 4 h ahead → an hour more
  o = ovFor(['America/New_York', 'Europe/London'], { y: 2026, m: 3, d: 16 }, 'America/New_York');
  assert.deepStrictEqual(o.spans, ['09:00-13:00']);
});
test('overlap: half-hour zone gives a 30-minute-aligned window', function () {
  var o = ovFor(['Europe/London', 'Asia/Kolkata'], { y: 2026, m: 10, d: 14 }, 'Europe/London');
  assert.deepStrictEqual(o.spans, ['09:00-12:30'], 'Mumbai 13:30-17:00');
  var o2 = ovFor(['Europe/London', 'Asia/Kathmandu'], { y: 2026, m: 1, d: 14 }, 'Europe/London');
  assert.deepStrictEqual(o2.spans, ['09:00-11:15']);
});
test('overlap: none for everyone → best partial', function () {
  // LA, London and Tokyo 9–17 tile the clock exactly: no two of them ever overlap
  var t = ovFor(['America/Los_Angeles', 'Europe/London', 'Asia/Tokyo'], { y: 2026, m: 10, d: 14 }, 'America/Los_Angeles');
  assert.strictEqual(t.all, false);
  assert.strictEqual(t.max, 1);
  var o = ovFor(['America/Los_Angeles', 'America/New_York', 'Asia/Tokyo'], { y: 2026, m: 10, d: 14 }, 'America/Los_Angeles');
  assert.strictEqual(o.all, false);
  assert.strictEqual(o.max, 2);
  assert.deepStrictEqual(o.spans, ['09:00-14:00'], 'LA + New York');
  var o2 = ovFor(['America/Los_Angeles', 'Asia/Kolkata'], { y: 2026, m: 10, d: 14 }, 'America/Los_Angeles');
  assert.strictEqual(o2.all, false);
  assert.strictEqual(o2.max, 1);
});
test('overlap: weekends are off (and Fri–Sat where that is the weekend)', function () {
  // Friday in Chicago is already Saturday morning in Auckland: no shared working hours
  var o = ovFor(['America/Chicago', 'Pacific/Auckland'], { y: 2026, m: 10, d: 16 }, 'America/Chicago', 540, 1020,
    { 'America/Chicago': 'United States', 'Pacific/Auckland': 'New Zealand' });
  assert.strictEqual(o.all, false);
  // without the weekend rule, Thu 16:00-17:00 Chicago = Fri 10:00-11:00 Auckland... (Fri is a work day)
  var o2 = ovFor(['America/Chicago', 'Pacific/Auckland'], { y: 2026, m: 10, d: 15 }, 'America/Chicago', 540, 1020,
    { 'America/Chicago': 'United States', 'Pacific/Auckland': 'New Zealand' });
  assert.strictEqual(o2.all, true);
  assert.deepStrictEqual(o2.spans, ['15:00-17:00']);
  assert.deepStrictEqual(C.weekendOf('Saudi Arabia'), [5, 6]);
  assert.deepStrictEqual(C.weekendOf('United Kingdom'), [0, 6]);
  // Sunday is a work day in Riyadh
  var o3 = ovFor(['Europe/London', 'Asia/Riyadh'], { y: 2026, m: 10, d: 18 }, 'Europe/London', 540, 1020,
    { 'Europe/London': 'United Kingdom', 'Asia/Riyadh': 'Saudi Arabia' });
  assert.strictEqual(o3.max, 1, 'Sunday: only Riyadh works');
});
test('overlap: DST day in the local zone (23 h) keeps slot math right', function () {
  var o = ovFor(['America/New_York', 'Europe/London'], { y: 2026, m: 3, d: 8 }, 'America/New_York', 540, 1020);
  assert.strictEqual(o.counts.length, 92);
  var o2 = ovFor(['America/New_York'], { y: 2026, m: 11, d: 1 }, 'America/New_York', 540, 1020);
  assert.strictEqual(o2.counts.length, 100);
  assert.deepStrictEqual(o2.spans, ['09:00-17:00']);
});
test('inWork handles an overnight shift and a full day', function () {
  assert.strictEqual(C.inWork(23 * 60, 22 * 60, 6 * 60), true);
  assert.strictEqual(C.inWork(5 * 60 + 45, 22 * 60, 6 * 60), true);
  assert.strictEqual(C.inWork(6 * 60, 22 * 60, 6 * 60), false);
  assert.strictEqual(C.inWork(0, 0, 1440), true);
  assert.strictEqual(C.inWork(1439, 0, 1440), true);
  assert.strictEqual(C.inWork(17 * 60, 540, 1020), false);
});
test('bands cover the whole day', function () {
  var r = C.dayRange({ y: 2026, m: 10, d: 17 }, 'Europe/London'), n = Math.round((r.end - r.start) / C.SLOT);
  var b = C.bands('Asia/Kolkata', r.start, n, 540, 1020, C.weekendOf('India'));
  assert.strictEqual(b[0].from, 0);
  assert.strictEqual(b[b.length - 1].to, n);
  for (var i = 1; i < b.length; i++) assert.strictEqual(b[i].from, b[i - 1].to);
  assert.ok(b.every(function (x) { return x.kind !== 'work'; }), 'Saturday in India: no work');
  assert.ok(b.some(function (x) { return x.kind === 'off'; }));
});
test('offsetsOver matches offsetAt slot by slot across a transition', function () {
  var r = C.dayRange({ y: 2026, m: 11, d: 1 }, 'America/New_York'), n = Math.round((r.end - r.start) / C.SLOT);
  ['America/New_York', 'Europe/London', 'Asia/Kolkata', 'Australia/Lord_Howe', '+05:45'].forEach(function (z) {
    var offs = C.offsetsOver(z, r.start, n, C.SLOT);
    for (var i = 0; i < n; i++) assert.strictEqual(offs[i], C.offsetAt(z, r.start + i * C.SLOT), z + ' slot ' + i);
  });
});

// ---- formatting --------------------------------------------------------------------------
test('formatting', function () {
  assert.strictEqual(C.fmtTime(9, 5, false), '09:05');
  assert.strictEqual(C.fmtTime(0, 0, true), '12:00 AM');
  assert.strictEqual(C.fmtTime(12, 30, true), '12:30 PM');
  assert.strictEqual(C.fmtTime(23, 59, true, 7), '11:59:07 PM');
  assert.strictEqual(C.fmtOffset(330), 'UTC+5:30');
  assert.strictEqual(C.fmtOffset(-210), 'UTC−3:30');
  assert.strictEqual(C.fmtOffset(0), 'UTC+0');
  assert.strictEqual(C.fmtOffset(-600), 'UTC−10');
  assert.strictEqual(C.fmtDiff(360), '+6 h');
  assert.strictEqual(C.fmtDiff(-180), '−3 h');
  assert.strictEqual(C.fmtDiff(-210), '−3:30');
  assert.strictEqual(C.fmtDiff(345), '+5:45');
  assert.strictEqual(C.fmtDiff(0), 'same time');
  assert.strictEqual(C.fmtDur(150), '2 h 30 min');
  assert.strictEqual(C.fmtDur(45), '45 min');
  assert.strictEqual(C.fmtDate({ y: 2026, m: 10, d: 14, wd: 3 }), 'Wed 14 Oct');
  assert.strictEqual(C.hourLabel(0, true), '12');
  assert.strictEqual(C.hourLabel(13, true), '1');
  assert.strictEqual(C.hourLabel(13, false), '13');
  assert.strictEqual(C.relDay(0), 'Today');
  assert.strictEqual(C.relDay(2), '+2 days');
});
test('abbreviations come from Intl (no hard-coding)', function () {
  assert.strictEqual(C.abbrAt('America/New_York', U(2026, 7, 1)), 'EDT');
  assert.strictEqual(C.abbrAt('America/New_York', U(2026, 1, 1)), 'EST');
  assert.strictEqual(C.abbrAt('Europe/London', U(2026, 7, 1)), 'BST');
  assert.strictEqual(C.abbrAt('Europe/London', U(2026, 1, 1)), 'GMT');
  assert.strictEqual(C.abbrAt('Asia/Kolkata', U(2026, 7, 1)), 'IST');
  assert.strictEqual(C.abbrAt('Australia/Sydney', U(2026, 1, 1)), 'AEDT');
  assert.strictEqual(C.abbrAt('+05:30', U(2026, 1, 1)), '');
  assert.ok(!/GMT[+-]/.test(C.abbrAt('Asia/Tokyo', U(2026, 1, 1))), 'no "GMT+9" pseudo-abbreviation');
});

test('meeting text: one line and a line per place', function () {
  var t = C.zonedToUtc(2026, 10, 14, 9, 0, 'America/New_York');
  var rows = [['New York', 'America/New_York'], ['London', 'Europe/London'], ['Mumbai', 'Asia/Kolkata'], ['Auckland', 'Pacific/Auckland']]
    .map(function (x) { return { label: x[0], p: C.partsAt(x[1], t), abbr: C.abbrAt(x[1], t) }; });
  assert.strictEqual(C.meetingText(rows.slice(0, 3), false, 'line'), 'Wed 14 Oct · 09:00 New York · 14:00 London · 18:30 Mumbai');
  assert.strictEqual(C.meetingText(rows, true, 'line'), 'Wed 14 Oct · 9:00 AM New York · 2:00 PM London · 6:30 PM Mumbai · 2:00 AM Auckland (Thu)');
  assert.strictEqual(C.meetingText(rows, false, 'lines'), [
    'Wed 14 Oct · 09:00 · New York (EDT)', 'Wed 14 Oct · 14:00 · London (BST)',
    'Wed 14 Oct · 18:30 · Mumbai (IST)', 'Thu 15 Oct · 02:00 · Auckland (NZDT)'].join('\n'));
  assert.strictEqual(C.meetingText([], false, 'line'), '');
});

// ---- sun ---------------------------------------------------------------------------------
test('sun phases (approximate)', function () {
  // London, 21 June: noon high, midnight dark
  assert.ok(C.sunAltitude(51.5, -0.13, U(2026, 6, 21, 12, 0)) > 60);
  assert.strictEqual(C.sunPhase(51.5, -0.13, U(2026, 6, 21, 12, 0)), 'day');
  assert.strictEqual(C.sunPhase(51.5, -0.13, U(2026, 12, 21, 0, 0)), 'night');
  // Reykjavik midsummer midnight: twilight, not night
  assert.notStrictEqual(C.sunPhase(64.15, -21.94, U(2026, 6, 21, 0, 30)), 'night');
  // London sunset ≈ 16:00 UTC on 21 Dec → 16:20 is dusk, 07:50 is dawn
  assert.strictEqual(C.sunPhase(51.5, -0.13, U(2026, 12, 21, 16, 20)), 'dusk');
  assert.strictEqual(C.sunPhase(51.5, -0.13, U(2026, 12, 21, 7, 50)), 'dawn');
  // no coordinates → by the clock
  assert.strictEqual(C.sunPhase(null, null, 0, { h: 13, mi: 0 }), 'day');
  assert.strictEqual(C.sunPhase(null, null, 0, { h: 2, mi: 0 }), 'night');
  assert.strictEqual(C.sunPhase(null, null, 0, { h: 6, mi: 30 }), 'dawn');
});

// ---- the city table & search ----------------------------------------------------------------
test('city table: valid zones, coordinates, every offset band', function () {
  assert.ok(C.CITIES.length >= 300 && C.CITIES.length <= 560, C.CITIES.length + ' cities');
  var offs = {}, t1 = U(2026, 1, 15), t7 = U(2026, 7, 15), seen = {};
  C.CITIES.forEach(function (l) {
    var f = l.split('|');
    assert.strictEqual(f.length, 6, l);
    assert.ok(C.validZone(f[2]), 'zone ' + f[2]);
    if (f[2] !== 'UTC') {
      assert.ok(Math.abs(+f[3]) <= 90 && Math.abs(+f[4]) <= 180 && f[3] !== '' && f[4] !== '', 'coords ' + l);
    }
    assert.ok(!seen[f[0] + '|' + f[1]], 'duplicate ' + f[0]);
    seen[f[0] + '|' + f[1]] = 1;
    offs[C.offsetAt(f[2], t1)] = 1; offs[C.offsetAt(f[2], t7)] = 1;
  });
  [-660, -600, -570, -540, -480, -420, -360, -300, -240, -210, -180, -150, -120, -60, 0, 60, 120, 180, 210, 240, 270, 300,
    330, 345, 360, 390, 420, 480, 525, 540, 570, 600, 630, 660, 720, 765, 780, 825, 840].forEach(function (o) {
    assert.ok(offs[o], 'some city at ' + C.fmtOffset(o));
  });
});
test('capitals are in', function () {
  ['Kabul', 'Tirana', 'Canberra', 'Ottawa', 'Brasília', 'Abuja', 'Naypyidaw', 'Ngerulmud', 'Gitega', 'Funafuti', 'Bern', 'Vaduz',
    'Thimphu', 'Wellington', 'Pyongyang', 'Montevideo', 'Port Moresby', 'Washington', 'Astana', 'Dodoma'].forEach(function (c) {
    assert.ok(C.CITIES.some(function (l) { return l.split('|')[0] === c; }), c);
  });
});
test('search ranking', function () {
  assert.strictEqual(names('lon')[0], 'London');
  assert.strictEqual(names('London')[0], 'London');
  assert.strictEqual(names('new')[0], 'New York');
  assert.strictEqual(names('york')[0], 'New York');
  assert.strictEqual(names('nyc')[0], 'New York');
  assert.strictEqual(names('sf')[0], 'San Francisco');
  assert.strictEqual(names('bombay')[0], 'Mumbai');
  assert.strictEqual(names('bangalore')[0], 'Bengaluru');
  assert.strictEqual(names('sao paulo')[0], 'São Paulo');
  assert.strictEqual(names('zurich')[0], 'Zurich');
  assert.strictEqual(names('zürich')[0], 'Zurich');
  assert.strictEqual(names('india')[0], 'Mumbai');
  assert.strictEqual(names('japan')[0], 'Tokyo');
  assert.deepStrictEqual(names('new zealand', 2), ['Auckland', 'Wellington']);
  assert.strictEqual(names('ist')[0], 'Mumbai', 'IST abbreviation beats the Istanbul prefix');
  assert.strictEqual(names('ist')[1], 'Istanbul');
  assert.strictEqual(names('pst')[0], 'Los Angeles');
  assert.strictEqual(names('cet')[0], 'Paris');
  assert.strictEqual(names('Europe/London')[0], 'London');
  assert.strictEqual(names('america/new_york')[0], 'New York');
  assert.strictEqual(names('paris france')[0], 'Paris');
  assert.strictEqual(names('st johns')[0], 'St. John\'s');
  assert.strictEqual(C.search(I, 'st johns', 2)[0].e.country, 'Canada');
  assert.strictEqual(names('UTC+5:30')[0], 'UTC+5:30');
  assert.strictEqual(C.search(I, 'utc+5:30', 1)[0].e.zone, '+05:30');
  assert.strictEqual(C.search(I, 'gmt-3', 1)[0].e.zone, '-03:00');
  assert.deepStrictEqual(names(''), []);
  assert.deepStrictEqual(names('xyzzyq'), []);
});
test('IANA zones beyond the table are searchable, without duplicates', function () {
  if (!IANA.length) return;
  var r = C.search(I, 'knox', 3).map(function (x) { return x.e; });
  assert.ok(r.some(function (e) { return e.iana && /Indiana\/Knox/.test(e.zone); }), 'America/Indiana/Knox');
  var lon = I.list.filter(function (e) { return C.norm(e.name) === 'london'; });
  assert.strictEqual(lon.length, 1, 'Europe/London is not listed twice');
  var kol = I.list.filter(function (e) { return C.norm(e.name) === 'kolkata'; });
  assert.strictEqual(kol.length, 1, 'Asia/Calcutta (ICU) is not a second Kolkata');
  assert.ok(I.list.every(function (e) { return !/^Etc\//.test(e.zone); }));
  // the widget indexes cities on open and adds the zones on first search: same result
  var lazy = C.buildIndex(C.CITIES, null);
  assert.strictEqual(lazy.list.length, C.CITIES.length);
  C.addZones(lazy, IANA);
  C.addZones(lazy, IANA);   // idempotent
  assert.strictEqual(lazy.list.length, I.list.length);
});
test('placeForZone: legacy / engine-canonical ids map to a city', function () {
  assert.strictEqual(C.placeForZone(I, 'America/Chicago').name, 'Chicago');
  assert.strictEqual(C.placeForZone(I, 'Asia/Calcutta').name, 'Mumbai');
  assert.strictEqual(C.placeForZone(I, 'Europe/Kyiv').name, 'Kyiv');
  assert.strictEqual(C.placeForZone(I, 'UTC').name, 'UTC');
  assert.strictEqual(C.placeForZone(I, 'Etc/UTC').name, 'UTC');
  assert.strictEqual(C.placeForZone(I, 'US/Eastern').name, 'New York');
  assert.strictEqual(C.zoneCity('America/Indiana/Indianapolis'), 'Indianapolis');
  assert.strictEqual(C.zoneCity('Asia/Saigon'), 'Ho Chi Minh City');
  assert.strictEqual(C.zoneCity('+05:45'), 'UTC+5:45');
  assert.ok(C.sameZone('Asia/Kolkata', 'Asia/Calcutta'));
  assert.ok(!C.sameZone('Europe/Paris', 'Europe/Berlin'), 'same offset, different zones');
});
test('typo suggestions', function () {
  assert.strictEqual(C.suggest(I, 'Londn').name, 'London');
  assert.strictEqual(C.suggest(I, 'tokio').name, 'Tokyo');
  assert.strictEqual(C.suggest(I, 'frankfrut').name, 'Frankfurt');
  assert.strictEqual(C.suggest(I, 'qq'), null);
  assert.strictEqual(C.editDist('abcd', 'abdc', 2), 1);
});

// ---- parsing "3pm London" -------------------------------------------------------------------
function show(r) { return r.ok ? r.place.name + ' ' + C.ymdKey(r.date) + ' ' + C.fmtTime(r.h, r.mi, false) + ' = ' + iso(r.utc) : 'ERR ' + r.error; }
test('parse: times and places', function () {
  // now = Wed 14 Oct 2026 15:00 in Chicago (20:00Z)
  assert.strictEqual(show(P('3pm London')), 'London 2026-10-14 15:00 = 2026-10-14T14:00Z');
  assert.strictEqual(show(P('3 pm in New York')), 'New York 2026-10-14 15:00 = 2026-10-14T19:00Z');
  assert.strictEqual(show(P('London 3pm')), 'London 2026-10-14 15:00 = 2026-10-14T14:00Z');
  assert.strictEqual(show(P('3:30 p.m. Paris')), 'Paris 2026-10-14 15:30 = 2026-10-14T13:30Z');
  assert.strictEqual(show(P('15:30 tokyo')), 'Tokyo 2026-10-15 15:30 = 2026-10-15T06:30Z', 'Tokyo is already on the 15th');
  assert.strictEqual(show(P('noon NYC')), 'New York 2026-10-14 12:00 = 2026-10-14T16:00Z');
  assert.strictEqual(show(P('midnight UTC')), 'UTC 2026-10-14 00:00 = 2026-10-14T00:00Z');
  assert.strictEqual(show(P('9am')), 'Local 2026-10-14 09:00 = 2026-10-14T14:00Z', 'no place = your zone');
  assert.strictEqual(show(P('9am my time')), 'Local 2026-10-14 09:00 = 2026-10-14T14:00Z');
  assert.strictEqual(show(P('9am local time')), 'Local 2026-10-14 09:00 = 2026-10-14T14:00Z');
  assert.strictEqual(show(P('at 9am here')), 'Local 2026-10-14 09:00 = 2026-10-14T14:00Z');
  assert.strictEqual(show(P('3pm PT')), 'Los Angeles 2026-10-14 15:00 = 2026-10-14T22:00Z');
  assert.strictEqual(show(P('3pm Pacific time')), 'Los Angeles 2026-10-14 15:00 = 2026-10-14T22:00Z');
  assert.strictEqual(show(P('10:00 UTC+5:30')), 'UTC+5:30 2026-10-15 10:00 = 2026-10-15T04:30Z');
  assert.strictEqual(show(P('15h30 Paris')), 'Paris 2026-10-14 15:30 = 2026-10-14T13:30Z');
  assert.strictEqual(show(P('3pm Japan')), 'Tokyo 2026-10-15 15:00 = 2026-10-15T06:00Z');
  assert.strictEqual(show(P('14:00 The Hague')), 'The Hague 2026-10-14 14:00 = 2026-10-14T12:00Z');
  assert.strictEqual(show(P('9:30 am Kathmandu')), 'Kathmandu 2026-10-15 09:30 = 2026-10-15T03:45Z');
  assert.strictEqual(show(P('4pm St. John\'s')), 'St. John\'s 2026-10-14 16:00 = 2026-10-14T18:30Z');
});
test('parse: dates', function () {
  assert.strictEqual(show(P('tomorrow 9am London')), 'London 2026-10-15 09:00 = 2026-10-15T08:00Z');
  assert.strictEqual(show(P('9am London yesterday')), 'London 2026-10-13 09:00 = 2026-10-13T08:00Z');
  assert.strictEqual(show(P('fri 9am berlin')), 'Berlin 2026-10-16 09:00 = 2026-10-16T07:00Z');
  assert.strictEqual(show(P('wed 9am berlin')), 'Berlin 2026-10-14 09:00 = 2026-10-14T07:00Z', 'today counts');
  assert.strictEqual(show(P('next wed 9am berlin')), 'Berlin 2026-10-21 09:00 = 2026-10-21T07:00Z');
  assert.strictEqual(show(P('20 Oct 14:00 Sydney')), 'Sydney 2026-10-20 14:00 = 2026-10-20T03:00Z');
  assert.strictEqual(show(P('Nov 2, 2026 9am New York')), 'New York 2026-11-02 09:00 = 2026-11-02T14:00Z', 'EST after the switch');
  assert.strictEqual(show(P('2026-03-30 09:00 London')), 'London 2026-03-30 09:00 = 2026-03-30T08:00Z', 'BST');
  assert.strictEqual(show(P('2026-03-27 09:00 London')), 'London 2026-03-27 09:00 = 2026-03-27T09:00Z', 'GMT');
});
test('parse: DST gap and errors', function () {
  var g = P('2:30am new york 2026-03-08');
  assert.ok(g.ok && g.gap, 'flags the skipped time');
  assert.strictEqual(iso(g.utc), '2026-03-08T07:30Z');
  assert.ok(!P('25:00 London').ok);
  assert.ok(!P('13am London').ok);
  assert.strictEqual(show(P('15:30pm London')), 'London 2026-10-14 15:30 = 2026-10-14T14:30Z', 'lenient: 24 h + pm');
  assert.ok(!P('London').ok, 'needs a time');
  assert.ok(/time/i.test(P('London').error));
  var bad = P('3pm Londn');
  assert.ok(!bad.ok);
  assert.strictEqual(bad.suggest.name, 'London');
  assert.strictEqual(bad.rest, 'Londn');
  assert.ok(!P('31 Feb 9am Paris').ok);
  assert.ok(P('').empty);
});
test('parse: "now" in a place', function () {
  var r = P('now in Kathmandu');
  assert.ok(r.ok);
  assert.strictEqual(r.utc, U(2026, 10, 14, 20, 0));
});

test('dates & keys', function () {
  assert.deepStrictEqual(C.addDays({ y: 2026, m: 12, d: 31 }, 1), { y: 2027, m: 1, d: 1 });
  assert.deepStrictEqual(C.addDays({ y: 2028, m: 3, d: 1 }, -1), { y: 2028, m: 2, d: 29 });
  assert.strictEqual(C.ymdKey({ y: 2026, m: 3, d: 8 }), '2026-03-08');
  assert.deepStrictEqual(C.parseYmd('2026-02-28'), { y: 2026, m: 2, d: 28 });
  assert.strictEqual(C.parseYmd('2026-02-30'), null);
  assert.strictEqual(C.parseYmd('nope'), null);
  assert.strictEqual(C.validZone('Mars/Olympus'), false);
  assert.strictEqual(C.validZone('Europe/London'), true);
  assert.strictEqual(C.validZone('+05:30'), true);
});

console.log((process.exitCode ? 'FAILED — ' : 'OK — ') + passed + ' tests passed');
