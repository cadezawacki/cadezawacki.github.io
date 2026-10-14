/* Unit tests for the Habit Tracker widget's pure model (dates, schedules,
 * streaks, rates, blob normalize / merge / prune, summaries).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/habits/habits.test.js */
'use strict';
var assert = require('assert');
var M = require('./habits.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function withTZ(tz, fn) {
  var old = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
}
var NOW = 1792000000;                 // seconds (2026-10-14T…), used as "now" for stamps
var TODAY = '2026-10-14';             // a Wednesday
function habit(fields, id, created) {
  return M.makeHabit(fields || {}, id || 'h1', created || '2026-09-01', 100, 0);
}
function check(h, keys, v) { keys.forEach(function (k) { M.setCount(h, k, v == null ? h.target : v, NOW); }); }
function days(from, n) { var out = []; for (var i = 0; i < n; i++) out.push(M.addDays(from, i)); return out; }
function state(hs, cfg) { var s = M.emptyState(); s.habits = hs; if (cfg) { for (var k in cfg) s.cfg[k] = cfg[k]; } return s; }
function roundTrip(st) { return M.normalize(JSON.parse(JSON.stringify(M.serialize(st))), TODAY, NOW); }

// ---- day keys ---------------------------------------------------------------------------
test('keys: validity, arithmetic across months / years / leap days', function () {
  assert.ok(M.isKey('2026-10-14'));
  ['2026-02-29', '2026-13-01', '2026-00-10', '2026-1-1', '26-10-14', '', null, 20261014, '2026-10-14x', '1969-12-31'].forEach(function (k) {
    assert.strictEqual(M.isKey(k), false, String(k));
  });
  assert.ok(M.isKey('2028-02-29'));
  assert.strictEqual(M.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(M.addDays('2028-02-28', 1), '2028-02-29');
  assert.strictEqual(M.addDays('2028-03-01', -1), '2028-02-29');
  assert.strictEqual(M.addDays('2026-10-14', -731), '2024-10-13');
  assert.strictEqual(M.diffDays('2027-01-01', '2026-12-31'), 1);
  assert.strictEqual(M.diffDays('2026-03-09', '2026-03-07'), 2);
  assert.strictEqual(M.dow('2026-10-14'), 3);            // Wednesday
  assert.strictEqual(M.dow('1970-01-01'), 4);
  assert.strictEqual(M.weekStart('2026-10-14', 1), '2026-10-12');   // Monday
  assert.strictEqual(M.weekStart('2026-10-14', 0), '2026-10-11');   // Sunday
  assert.strictEqual(M.weekStart('2026-10-11', 1), '2026-10-05');   // a Sunday belongs to the week before (Mon start)
  assert.strictEqual(M.weekStart('2026-10-11', 0), '2026-10-11');
  assert.strictEqual(M.fmtDay('2026-10-14'), 'Wed 14 Oct');
  assert.strictEqual(M.fmtDay('2026-10-14', true), 'Wed 14 Oct 2026');
  assert.strictEqual(M.fmtDM('2026-01-05'), '5 Jan');
});

test('dayKey: the day-start hour (night owls)', function () {
  withTZ('Europe/Berlin', function () {
    assert.strictEqual(M.dayKey(new Date(2026, 9, 14, 0, 30), 0), '2026-10-14');
    assert.strictEqual(M.dayKey(new Date(2026, 9, 14, 3, 59), 4), '2026-10-13');
    assert.strictEqual(M.dayKey(new Date(2026, 9, 14, 4, 0), 4), '2026-10-14');
    assert.strictEqual(M.dayKey(new Date(2026, 0, 1, 2, 0), 4), '2025-12-31');   // across a year
    assert.strictEqual(M.dayKey(new Date(2026, 2, 1, 1, 0), 3), '2026-02-28');   // across a month
    assert.strictEqual(M.dayKey(new Date(2026, 9, 14, 11, 0), 12), '2026-10-13');
    var b = M.nextBoundary(new Date(2026, 9, 14, 3, 0), 4);
    assert.strictEqual(b.getHours(), 4); assert.strictEqual(b.getDate(), 14);
    b = M.nextBoundary(new Date(2026, 9, 14, 4, 0), 4);
    assert.strictEqual(b.getDate(), 15);
    b = M.nextBoundary(new Date(2026, 9, 14, 23, 59), 0);
    assert.strictEqual(b.getDate(), 15); assert.strictEqual(b.getHours(), 0);
  });
});

test('dayKey / nextBoundary across DST in many zones (hourly through a year)', function () {
  var zones = ['America/New_York', 'Europe/London', 'America/Santiago', 'Australia/Lord_Howe', 'Asia/Kolkata', 'Pacific/Auckland', 'America/Havana', 'UTC'];
  zones.forEach(function (tz) {
    withTZ(tz, function () {
      [0, 1, 2, 4].forEach(function (ds) {
        var start = new Date(2026, 0, 1, 0, 17).getTime();
        for (var t = start; t < start + 366 * 864e5; t += 3600e3) {
          var k = M.dayKey(t, ds), b = M.nextBoundary(t, ds);
          assert.ok(b.getTime() > t, tz + ' ds=' + ds + ' boundary after now @' + new Date(t).toString());
          assert.ok(b.getTime() - t <= 25 * 3600e3 + 1, tz + ' boundary within a day');
          assert.strictEqual(M.dayKey(b.getTime() - 1, ds), k, tz + ' ds=' + ds + ' same day until the boundary @' + new Date(t).toString());
          assert.strictEqual(M.dayKey(b, ds), M.addDays(k, 1), tz + ' ds=' + ds + ' next day at the boundary @' + new Date(t).toString());
        }
      });
    });
  });
  withTZ('America/New_York', function () {
    // spring forward 2026-03-08 02:00 → 03:00; fall back 2026-11-01 02:00 → 01:00
    assert.strictEqual(M.dayKey(new Date(2026, 2, 8, 1, 30), 2), '2026-03-07');
    assert.strictEqual(M.dayKey(new Date(2026, 2, 8, 3, 30), 2), '2026-03-08');
    var b = M.nextBoundary(new Date(2026, 2, 8, 1, 30), 2);   // 02:00 doesn't exist that night
    assert.strictEqual(b.getHours(), 3);
    assert.strictEqual(b.getTime() - new Date(2026, 2, 8, 1, 30).getTime(), 30 * 60e3);
    var fb = new Date(2026, 10, 1, 0, 30).getTime() + 2 * 3600e3;  // 01:30 for the second time
    assert.strictEqual(M.dayKey(fb, 2), '2026-10-31');
    assert.strictEqual(M.dayKey(fb + 3600e3, 2), '2026-11-01');
    // 25-hour day: midnight to midnight still advances exactly one key
    assert.strictEqual(M.nextBoundary(new Date(2026, 10, 1, 0, 0), 0).getTime() - new Date(2026, 10, 1, 0, 0).getTime(), 25 * 3600e3);
  });
});

test('travel: keys are local dates; a streak survives a time-zone change', function () {
  var h = habit({ name: 'Walk' }, 'h1', '2026-10-01');
  var keys = [];
  withTZ('America/Los_Angeles', function () { keys.push(M.dayKey(new Date(2026, 9, 10, 21, 0), 0)); keys.push(M.dayKey(new Date(2026, 9, 11, 20, 0), 0)); });
  withTZ('Asia/Tokyo', function () { keys.push(M.dayKey(new Date(2026, 9, 13, 9, 0), 0)); keys.push(M.dayKey(new Date(2026, 9, 14, 8, 0), 0)); });
  assert.deepStrictEqual(keys, ['2026-10-10', '2026-10-11', '2026-10-13', '2026-10-14']);
  check(h, ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']);
  assert.strictEqual(M.streaks(h, '2026-10-14', 1).cur, 5);
});

// ---- schedules ---------------------------------------------------------------------------
test('schedules: parse, normalize, labels', function () {
  assert.deepStrictEqual(M.parseSched('d'), { t: 'd' });
  assert.deepStrictEqual(M.parseSched('w:5,1,3,3'), { t: 'w', days: [1, 3, 5] });
  assert.deepStrictEqual(M.parseSched({ t: 'w', days: [6, '0', 9, -1, 1.5, null, {}] }), { t: 'w', days: [0, 6] });
  assert.deepStrictEqual(M.parseSched({ t: 'w', days: [] }), { t: 'd' });
  assert.deepStrictEqual(M.parseSched('w:0,1,2,3,4,5,6'), { t: 'd' });
  assert.deepStrictEqual(M.parseSched('n:3'), { t: 'n', n: 3 });
  assert.deepStrictEqual(M.parseSched({ t: 'n', n: 9 }), { t: 'd' });
  assert.deepStrictEqual(M.parseSched({ t: 'n', n: 0 }), { t: 'n', n: 1 });
  assert.deepStrictEqual(M.parseSched({ t: 'n', n: 'x' }), { t: 'n', n: 3 });
  assert.deepStrictEqual(M.parseSched('w:'), { t: 'd' });
  assert.deepStrictEqual(M.parseSched(42), { t: 'd' });
  assert.strictEqual(M.schedStr({ t: 'w', days: [1, 3, 5] }), 'w:1,3,5');
  assert.strictEqual(M.schedLabel({ t: 'w', days: [1, 3, 5] }, 1), 'Mon · Wed · Fri');
  assert.strictEqual(M.schedLabel({ t: 'w', days: [0, 3] }, 1), 'Wed · Sun');
  assert.strictEqual(M.schedLabel({ t: 'w', days: [0, 3] }, 0), 'Sun · Wed');
  assert.strictEqual(M.schedLabel({ t: 'w', days: [1, 2, 3, 4, 5] }, 1), 'Weekdays');
  assert.strictEqual(M.schedLabel({ t: 'n', n: 3 }, 1), '3× a week');
  assert.strictEqual(M.schedLabel({ t: 'd' }, 1), 'Every day');
});

// ---- streaks -------------------------------------------------------------------------------
test('streaks: daily — today is pending, a missed day breaks, best is kept', function () {
  var h = habit({ name: 'Read' }, 'h1', '2026-10-01');
  check(h, days('2026-10-01', 3));                 // 1..3
  check(h, days('2026-10-06', 8));                 // 6..13 (4 and 5 missed)
  var s = M.streaks(h, TODAY, 1);                  // today (14th) not done yet
  assert.deepStrictEqual(s, { cur: 8, best: 8, unit: 'd' });
  check(h, [TODAY]);
  assert.strictEqual(M.streaks(h, TODAY, 1).cur, 9);
  M.toggleDay(h, '2026-10-13', NOW);               // un-check yesterday → today alone
  assert.strictEqual(M.streaks(h, TODAY, 1).cur, 1);
  assert.strictEqual(M.streaks(h, TODAY, 1).best, 7);
  assert.strictEqual(M.streaks(h, '2026-10-16', 1).cur, 0);  // two days later, nothing since
  assert.deepStrictEqual(M.streaks(habit({}, 'h2', TODAY), TODAY, 1), { cur: 0, best: 0, unit: 'd' });
  assert.strictEqual(M.streaks(habit({}, 'h3', '2026-12-01'), TODAY, 1).cur, 0);   // created "in the future"
});

test('streaks: weekdays — off days never break, off-day check-ins are a bonus', function () {
  var h = habit({ name: 'Gym', sched: { t: 'w', days: [1, 3, 5] } }, 'h1', '2026-09-28');
  // Mon 28 Sep, Wed 30, Fri 2 Oct, Mon 5, Wed 7, Fri 9, Mon 12 done; Wed 14 = today
  check(h, ['2026-09-28', '2026-09-30', '2026-10-02', '2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12']);
  assert.deepStrictEqual(M.streaks(h, TODAY, 1), { cur: 7, best: 7, unit: 'd' });
  assert.strictEqual(M.streaks(h, '2026-10-13', 1).cur, 7);    // Tuesday: not broken
  check(h, ['2026-10-10', '2026-10-11']);                       // weekend bonus
  assert.strictEqual(M.streaks(h, TODAY, 1).cur, 7);            // doesn't count, doesn't hurt
  assert.strictEqual(M.streaks(h, '2026-10-15', 1).cur, 0);     // Wed 14 missed → broken on Thursday
  M.setCount(h, '2026-10-07', 0, NOW);                          // a missed Wednesday in the middle
  assert.deepStrictEqual(M.streaks(h, TODAY, 1), { cur: 2, best: 4, unit: 'd' });
  assert.strictEqual(M.scheduledOn(h, '2026-10-13'), false);
  assert.strictEqual(M.info(h, '2026-10-13', 1).due, false);
  assert.strictEqual(M.info(h, TODAY, 1).due, true);
});

test('streaks: N per week counts weeks; the current week is pending', function () {
  var h = habit({ name: 'Run', sched: { t: 'n', n: 3 } }, 'h1', '2026-09-14');
  // weeks (Mon start): 14 Sep ✓(3), 21 Sep ✓(4), 28 Sep ✗(2), 5 Oct ✓(3), 12 Oct (current) 1 so far
  check(h, ['2026-09-14', '2026-09-16', '2026-09-20']);
  check(h, ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24']);
  check(h, ['2026-09-29', '2026-10-01']);
  check(h, ['2026-10-05', '2026-10-09', '2026-10-11']);
  check(h, ['2026-10-12']);
  assert.deepStrictEqual(M.streaks(h, TODAY, 1), { cur: 1, best: 2, unit: 'w' });
  check(h, ['2026-10-13', TODAY]);                                // the week is met → counts now
  assert.deepStrictEqual(M.streaks(h, TODAY, 1), { cur: 2, best: 2, unit: 'w' });
  assert.strictEqual(M.weekDone(h, TODAY, 1, false), 3);
  // Sunday-start weeks group days differently: Sun 11 Oct moves into the week of the 11th
  assert.strictEqual(M.weekDone(h, TODAY, 0, false), 4);
  var s0 = M.streaks(h, TODAY, 0);
  assert.strictEqual(s0.unit, 'w');
  assert.ok(s0.cur >= 1);
  // a failed past week breaks it
  var g = habit({ sched: { t: 'n', n: 2 } }, 'h2', '2026-09-28');
  check(g, ['2026-09-28', '2026-09-29', '2026-10-12']);          // wk1 ✓, wk2 ✗ (0), wk3 current 1
  assert.deepStrictEqual(M.streaks(g, TODAY, 1), { cur: 0, best: 1, unit: 'w' });
});

test('N per week: due until the quota is met; today\'s own check-in keeps it in the list', function () {
  var h = habit({ sched: { t: 'n', n: 2 } }, 'h1', '2026-10-01');
  assert.strictEqual(M.info(h, TODAY, 1).due, true);
  check(h, ['2026-10-12']);
  assert.strictEqual(M.info(h, TODAY, 1).due, true);
  check(h, [TODAY]);
  var f = M.info(h, TODAY, 1);
  assert.strictEqual(f.due, true); assert.strictEqual(f.done, true); assert.strictEqual(f.week, 2);
  assert.strictEqual(M.info(h, '2026-10-15', 1).due, false);    // met already → rest day
  assert.strictEqual(M.info(h, '2026-10-19', 1).due, true);     // next week
});

test('counters: partial days are not done; streaks follow the target', function () {
  var h = habit({ name: 'Water', target: 8, step: 2, unit: 'glasses' }, 'h1', '2026-10-10');
  assert.strictEqual(h.step, 2);
  check(h, ['2026-10-10', '2026-10-11', '2026-10-12'], 8);
  M.setCount(h, '2026-10-13', 5, NOW);
  M.bump(h, TODAY, 1, NOW); M.bump(h, TODAY, 1, NOW);
  assert.strictEqual(M.count(h, TODAY), 4);
  assert.strictEqual(M.isDone(h, TODAY), false);
  assert.strictEqual(M.cellState(h, '2026-10-13', TODAY), 'p');
  assert.strictEqual(M.streaks(h, TODAY, 1).cur, 0);
  assert.strictEqual(M.streaks(h, TODAY, 1).best, 3);
  M.bump(h, TODAY, -1, NOW); M.bump(h, TODAY, -1, NOW); M.bump(h, TODAY, -1, NOW);
  assert.strictEqual(M.count(h, TODAY), 0);
  assert.ok(!(TODAY in h.log));
  M.setCount(h, '2026-10-13', 10, NOW);                           // over the target counts
  assert.strictEqual(M.streaks(h, TODAY, 1).cur, 4);
  M.updateHabit(h, { target: 9 }, NOW);                            // raising the target re-scores
  assert.strictEqual(M.streaks(h, TODAY, 1).cur, 1);
  assert.strictEqual(M.toggleDay(h, '2026-10-12', NOW), true);    // toggle a partial day → full
  assert.strictEqual(M.count(h, '2026-10-12'), 9);
  assert.strictEqual(M.toggleDay(h, '2026-10-12', NOW), false);
  assert.strictEqual(M.count(h, '2026-10-12'), 0);
});

test('rates: 7 / 30 / 90 days respect schedule, start date and a pending today', function () {
  var h = habit({}, 'h1', '2026-10-08');                         // 7 days so far incl. today
  check(h, ['2026-10-08', '2026-10-09', '2026-10-11', '2026-10-12', '2026-10-13']);
  var r = M.rate(h, TODAY, 7, 1);
  assert.deepStrictEqual([r.done, r.due], [5, 6]);              // today pending → not due yet
  check(h, [TODAY]);
  r = M.rate(h, TODAY, 7, 1);
  assert.deepStrictEqual([r.done, r.due], [6, 7]);
  assert.deepStrictEqual([M.rate(h, TODAY, 90, 1).done, M.rate(h, TODAY, 90, 1).due], [6, 7]);   // clipped at the start
  var w = habit({ sched: { t: 'w', days: [1, 3, 5] } }, 'h2', '2026-09-01');
  check(w, ['2026-10-05', '2026-10-09', '2026-10-10', '2026-10-12']);   // Sat 10 = bonus, ignored
  r = M.rate(w, TODAY, 14, 1);                                    // 1..14 Oct: Thu1? no: Fri 2, Mon 5, Wed 7, Fri 9, Mon 12 (+ Wed 14 pending)
  assert.deepStrictEqual([r.done, r.due], [3, 5]);
  var n = habit({ sched: { t: 'n', n: 3 } }, 'h3', '2026-09-01');
  check(n, ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);   // 5 in one week, capped at 3
  r = M.rate(n, '2026-10-11', 7, 1);
  assert.strictEqual(r.done, 3); assert.strictEqual(r.pct, 1);
  r = M.rate(n, '2026-10-18', 14, 1);                             // Sunday 18 pending → 13 days count
  assert.ok(Math.abs(r.pct - 3 / (3 * 13 / 7)) < 1e-9, r.pct);
  check(n, ['2026-10-18']);
  r = M.rate(n, '2026-10-18', 14, 1);                             // two whole weeks: (3 + 1) of 6
  assert.ok(Math.abs(r.pct - 4 / 6) < 1e-9, r.pct);
  assert.strictEqual(M.rate(habit({}, 'h4', TODAY), TODAY, 7, 1), null);   // nothing due yet
});

test('cellState and heatmap', function () {
  var h = habit({ sched: { t: 'w', days: [1, 3, 5] }, target: 2 }, 'h1', '2026-10-05');
  check(h, ['2026-10-05']);
  M.setCount(h, '2026-10-07', 1, NOW);
  check(h, ['2026-10-10']);
  assert.strictEqual(M.cellState(h, '2026-10-04', TODAY), 'b');
  assert.strictEqual(M.cellState(h, '2026-10-05', TODAY), 'd');
  assert.strictEqual(M.cellState(h, '2026-10-06', TODAY), 'o');
  assert.strictEqual(M.cellState(h, '2026-10-07', TODAY), 'p');
  assert.strictEqual(M.cellState(h, '2026-10-09', TODAY), 'm');
  assert.strictEqual(M.cellState(h, '2026-10-10', TODAY), 'd');   // off-day bonus still shows done
  assert.strictEqual(M.cellState(h, TODAY, TODAY), 't');
  assert.strictEqual(M.cellState(h, '2026-10-15', TODAY), 'f');
  var hm = M.heat(h, TODAY, 26, 1);
  assert.strictEqual(hm.cells.length, 26 * 7);
  assert.strictEqual(hm.first, M.addDays('2026-10-12', -7 * 25));
  assert.strictEqual(M.dow(hm.first), 1);
  assert.strictEqual(hm.cells[hm.cells.length - 1].k, '2026-10-18');
  assert.strictEqual(hm.cells[hm.cells.length - 1].s, 'f');
  assert.strictEqual(hm.cells[25 * 7 + 2].k, TODAY);
  assert.ok(hm.months.length >= 6 && hm.months.length <= 7);
  hm.months.forEach(function (m, i) { if (i) assert.ok(m.col > hm.months[i - 1].col); });
  assert.strictEqual(hm.months[hm.months.length - 1].label, 'Oct');
  var hm0 = M.heat(h, TODAY, 12, 0);
  assert.strictEqual(M.dow(hm0.first), 0);
  assert.strictEqual(hm0.cells.length, 84);
});

// ---- blob: encode / normalize / prune ---------------------------------------------------------
test('log encoding: compact month strings, big counts as arrays, round trip', function () {
  var log = { '2026-10-01': 1, '2026-10-03': 35, '2026-10-31': 2, '2026-11-02': 36, '2026-11-03': 1, '2026-09-30': 9 };
  var enc = M.encodeLog(log);
  assert.deepStrictEqual(Object.keys(enc), ['2026-09', '2026-10', '2026-11']);
  assert.strictEqual(enc['2026-10'], '10z' + new Array(28).join('0') + '2');
  assert.strictEqual(enc['2026-10'].length, 31);
  assert.deepStrictEqual(enc['2026-11'], [0, 36, 1]);
  assert.deepStrictEqual(M.decodeLog(enc, {}), log);
  // plain day maps are accepted too; junk is skipped
  assert.deepStrictEqual(M.decodeLog({ '2026-10-05': 3, '2026-10-06': -1, '2026-02-30': 1, 'x': 1, '2026-02': '00000000000000000000000000000001', '2026-13': '1' }, {}),
    { '2026-10-05': 3 });
  assert.deepStrictEqual(M.decodeLog({ '2026-10': '1?*2', '2026-11': [1, 'a', null, 2.7, 1e9] }, {}),
    { '2026-10-01': 1, '2026-10-04': 2, '2026-11-01': 1, '2026-11-04': 2, '2026-11-05': 99999 });
  assert.deepStrictEqual(M.decodeLog(null, {}), {});
  assert.deepStrictEqual(M.decodeLog(['2026-10'], {}), {});
});

test('blob stays small: 12 daily habits × 2 years', function () {
  var hs = [];
  for (var i = 0; i < 12; i++) {
    var h = habit({ name: 'Habit number ' + i, icon: '💧', target: i % 3 ? 1 : 8 }, 'h' + i, '2024-10-15');
    h.o = i;
    days('2024-10-15', 731).forEach(function (k, j) { if ((j + i) % 5) h.log[k] = i % 3 ? 1 : (j % 9) + 1; });
    for (var d = 0; d < 21; d++) h.m[M.addDays(TODAY, -d)] = NOW - d * 86400;
    hs.push(h);
  }
  var json = JSON.stringify(M.serialize(state(hs)));
  assert.ok(json.length < 30000, 'blob is ' + json.length + ' bytes');
  var back = roundTrip(state(hs));
  assert.ok(M.same(back, state(hs)));
});

test('normalize: malformed blobs never throw and come out clean', function () {
  [undefined, null, 0, 1, 'x', '{}', [], [1, 2], true, function () {}, { habits: null }, { habits: 'x' }, { habits: [null, 1, 'a', [], {}] }, { cfg: [] }, { gone: [] }].forEach(function (raw) {
    var s = M.normalize(raw, TODAY, NOW);
    assert.ok(s && Array.isArray(s.habits) && s.cfg && s.gone);
    s.habits.forEach(function (h) { assert.ok(/^[A-Za-z0-9_-]{1,24}$/.test(h.id)); assert.strictEqual(h.name, 'Habit'); });
  });
  var s = M.normalize({ habits: [{}] }, TODAY, NOW);
  assert.strictEqual(s.habits.length, 1);
  assert.strictEqual(s.habits[0].c, TODAY);
  var raw = {
    cfg: { ds: 99, wk: 'x', u: 'nope' },
    gone: { 'bad id!': 5, ok: NOW - 10, old: NOW - 500 * 86400, z: 'x' },
    habits: [
      { id: 'a', name: '  Read\n\tbooks  ', icon: { x: 1 }, color: 'chartreuse', sched: 'w:9', target: -4, step: 50, unit: 123, o: 'x', arch: 'yes', c: '2026-02-30', u: -5, lu: 'x',
        log: { '2026-10': '1101', '2026-10-20': 2, 'zz': 1 }, notes: { '2026-10-02': '  hi  ', '2026-10-03': '', bad: 'x', '2026-10-04': { a: 1 } }, m: { '2026-10-02': NOW, '2026-10-03': NOW - 90 * 86400, bad: 1 } },
      { id: 'a', name: 'dup older', u: 0 },
      { id: 'b', name: new Array(200).join('x'), target: 1e9, step: 0, o: 2, sched: { t: 'n', n: '4' }, arch: 1, log: { '2026-10': [0, 1e12, -3] } },
      { id: 'ok', name: 'tombstoned', u: NOW - 20 },
      { id: 'c', name: 'Bad <script>', icon: '🧘‍♀️🧘‍♀️🧘‍♀️🧘‍♀️', o: 1 },
    ],
  };
  s = M.normalize(raw, TODAY, NOW);
  assert.deepStrictEqual(s.cfg, { ds: 12, wk: 1, u: 0 });
  assert.deepStrictEqual(Object.keys(s.gone).sort(), ['ok']);
  assert.deepStrictEqual(s.habits.map(function (h) { return h.id; }), ['a', 'c', 'b']);
  var a = s.habits[0];
  assert.strictEqual(a.name, 'Read books');
  assert.strictEqual(a.icon, '');
  assert.strictEqual(a.color, 'teal');
  assert.deepStrictEqual(a.sched, { t: 'd' });
  assert.strictEqual(a.target, 1); assert.strictEqual(a.step, 1); assert.strictEqual(a.unit, '123');
  assert.strictEqual(a.o, 0); assert.strictEqual(a.arch, false);
  assert.strictEqual(a.c, '2026-10-01');                      // invalid → earliest check-in
  assert.deepStrictEqual(a.log, { '2026-10-01': 1, '2026-10-02': 1, '2026-10-04': 1, '2026-10-20': 2 });   // future key kept
  assert.deepStrictEqual(a.notes, { '2026-10-02': 'hi' });
  assert.deepStrictEqual(a.m, { '2026-10-02': NOW });          // 90-day-old stamp dropped
  var b = s.habits[2];
  assert.strictEqual(b.name.length, 60);
  assert.strictEqual(b.target, 9999); assert.strictEqual(b.step, 1);
  assert.deepStrictEqual(b.sched, { t: 'n', n: 4 });
  assert.strictEqual(b.arch, true);
  assert.deepStrictEqual(b.log, { '2026-10-02': 99999 });
  var c = s.habits[1];
  assert.ok(c.icon.length <= 16 && !/[\uD800-\uDBFF]$/.test(c.icon));
  assert.strictEqual(c.name, 'Bad <script>');                  // kept as text; the UI escapes it
  // invalid ids get a stable id
  var x1 = M.normalize({ habits: [{ id: 'no spaces allowed', name: 'X' }] }, TODAY, NOW).habits[0].id;
  var x2 = M.normalize({ habits: [{ id: 'no spaces allowed', name: 'X' }] }, TODAY, NOW).habits[0].id;
  assert.strictEqual(x1, x2);
  // idempotent
  assert.ok(M.same(roundTrip(s), s));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(M.serialize(roundTrip(s)))), JSON.parse(JSON.stringify(M.serialize(s))));
});

test('normalize: caps and pruning (~2 years), safe against a wrong clock', function () {
  var list = [];
  for (var i = 0; i < 130; i++) list.push({ id: 'h' + i, name: 'n' + i, o: i });
  assert.strictEqual(M.normalize({ habits: list }, TODAY, NOW).habits.length, M.MAX_HABITS);
  var h = habit({}, 'p', '2023-01-01');
  check(h, ['2023-06-01', '2024-10-12', '2024-10-13', '2026-10-01']);
  h.notes['2023-06-01'] = 'old'; h.notes['2026-10-01'] = 'new';
  var s = roundTrip(state([h]));                                   // kept: two years before the newest check-in
  assert.deepStrictEqual(Object.keys(s.habits[0].log).sort(), ['2024-10-12', '2024-10-13', '2026-10-01']);
  check(h, [TODAY]);
  s = roundTrip(state([h]));                                       // …and never more than two years before today
  assert.deepStrictEqual(Object.keys(s.habits[0].log).sort(), ['2024-10-13', '2026-10-01', TODAY]);
  assert.deepStrictEqual(s.habits[0].notes, { '2026-10-01': 'new' });
  assert.strictEqual(s.habits[0].c, '2023-01-01');
  // a device whose clock is years ahead must not wipe the history
  var far = M.normalize(JSON.parse(JSON.stringify(M.serialize(state([h])))), '2031-01-01', NOW);
  assert.ok('2026-10-01' in far.habits[0].log);
  assert.ok('2024-10-13' in far.habits[0].log);
  // …nor one whose clock is behind
  var past = M.normalize(JSON.parse(JSON.stringify(M.serialize(state([h])))), '2020-01-01', NOW);
  assert.ok('2026-10-01' in past.habits[0].log);
  // notes: cleaned, capped
  var n = habit({}, 'n1', '2026-01-01');
  M.setNote(n, TODAY, '  line one \r\n\r\n\r\n\r\nline two\u0000  ', NOW);
  assert.strictEqual(n.notes[TODAY], 'line one\n\nline two');
  M.setNote(n, TODAY, new Array(900).join('é'), NOW);
  assert.strictEqual(n.notes[TODAY].length, M.NOTE_MAX);
  assert.strictEqual(M.setNote(n, TODAY, '   ', NOW), true);
  assert.ok(!(TODAY in n.notes));
  assert.strictEqual(M.setNote(n, TODAY, '', NOW), false);    // unchanged → no stamp
});

// ---- merge ----------------------------------------------------------------------------------------
function twoDevices() {
  var base = state([habit({ name: 'Read' }, 'r', '2026-10-01'), habit({ name: 'Run', sched: 'n:3' }, 'u', '2026-10-01')]);
  check(base.habits[0], ['2026-10-10', '2026-10-11'], 1);
  base.habits.forEach(function (h) { h.m = {}; h.lu = NOW - 5000; });
  return { A: roundTrip(base), B: roundTrip(base) };
}
test('merge: edits to different habits / days on two devices both survive', function () {
  var d = twoDevices();
  M.setCount(M.findHabit(d.A, 'r'), '2026-10-12', 1, NOW + 1);   // phone, offline
  M.setCount(M.findHabit(d.B, 'u'), '2026-10-12', 1, NOW + 2);   // desktop
  M.setCount(M.findHabit(d.B, 'r'), '2026-10-13', 1, NOW + 3);   // desktop, same habit, other day
  var m = M.merge(d.A, d.B);
  assert.deepStrictEqual(Object.keys(M.findHabit(m, 'r').log).sort(), ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']);
  assert.deepStrictEqual(Object.keys(M.findHabit(m, 'u').log), ['2026-10-12']);
  assert.ok(M.same(m, M.merge(d.B, d.A)));                         // symmetric when nothing ties
  assert.ok(M.same(M.merge(m, d.B), m) && M.same(M.merge(d.B, m), m));   // converged: no further pushes
  assert.ok(!M.same(m, d.B));                                       // A had news → A pushes back
});
test('merge: the same day edited twice — the newest edit wins (un-checks too)', function () {
  var d = twoDevices();
  M.setCount(M.findHabit(d.A, 'r'), '2026-10-11', 0, NOW + 10);    // A un-checks later
  M.setNote(M.findHabit(d.B, 'r'), '2026-10-11', 'great', NOW + 5);
  var m = M.merge(d.B, d.A);
  assert.ok(!('2026-10-11' in M.findHabit(m, 'r').log));
  assert.ok(!('2026-10-11' in M.findHabit(m, 'r').notes));
  assert.strictEqual(M.findHabit(m, 'r').m['2026-10-11'], NOW + 10);
  // tie → remote copy wins (so nothing ping-pongs)
  var e = twoDevices();
  M.setCount(M.findHabit(e.A, 'r'), TODAY, 1, NOW + 7);
  M.setCount(M.findHabit(e.B, 'r'), TODAY, 0, NOW + 7);
  assert.ok(!(TODAY in M.findHabit(M.merge(e.A, e.B), 'r').log));
  assert.ok(TODAY in M.findHabit(M.merge(e.B, e.A), 'r').log);
});
test('merge: unstamped (old) days follow the newer check-in history', function () {
  var d = twoDevices();
  var a = M.findHabit(d.A, 'r'), b = M.findHabit(d.B, 'r');
  delete a.log['2026-10-10']; a.lu = NOW - 100;                     // an edit whose stamp aged out
  assert.ok(!('2026-10-10' in M.findHabit(M.merge(d.B, d.A), 'r').log));
  b.lu = NOW - 50;
  assert.ok('2026-10-10' in M.findHabit(M.merge(d.A, d.B), 'r').log);
});
test('merge: settings, order, archive and deletes', function () {
  var d = twoDevices();
  M.updateHabit(M.findHabit(d.A, 'r'), { name: 'Read 20 min', color: 'purple' }, NOW + 4);
  M.setOrder(d.B, ['u', 'r'], NOW + 2);
  var m = M.merge(d.A, d.B);
  assert.strictEqual(M.findHabit(m, 'r').name, 'Read 20 min');      // newer meta edit on A
  assert.strictEqual(M.findHabit(m, 'u').o, 0);                     // B moved Run first
  assert.strictEqual(M.findHabit(m, 'r').o, 0);                     // …but A's later edit of Read carried o=0
  assert.ok(M.findHabit(m, 'r').log['2026-10-10']);                 // reorder never touches check-ins
  // delete on B wins over A's older state, and stays deleted after a round trip
  var e = twoDevices();
  M.removeHabit(e.B, 'u', NOW + 3);
  M.setCount(M.findHabit(e.A, 'u'), TODAY, 1, NOW + 4);             // a check-in isn't a reason to resurrect
  var mm = M.merge(e.A, e.B);
  assert.strictEqual(M.findHabit(mm, 'u'), null);
  assert.strictEqual(mm.gone.u, NOW + 3);
  assert.strictEqual(M.findHabit(roundTrip(mm), 'u'), null);
  // …unless its settings were edited after the delete
  M.updateHabit(M.findHabit(e.A, 'u'), { name: 'Run again' }, NOW + 9);
  assert.ok(M.findHabit(M.merge(e.A, e.B), 'u'));
  // cfg: newest wins
  var f = twoDevices();
  M.setCfg(f.A, { ds: 4 }, NOW + 1);
  M.setCfg(f.B, { wk: 0 }, NOW + 2);
  assert.deepStrictEqual(M.merge(f.A, f.B).cfg, { ds: 0, wk: 0, u: NOW + 2 });
  assert.deepStrictEqual(M.merge(f.B, f.A).cfg, { ds: 0, wk: 0, u: NOW + 2 });
  // a habit created on each device: both kept
  var g = twoDevices();
  g.A.habits.push(habit({ name: 'A-only' }, 'a1', TODAY));
  g.B.habits.push(habit({ name: 'B-only' }, 'b1', TODAY));
  assert.strictEqual(M.merge(g.A, g.B).habits.length, 4);
  // merging never aliases the inputs
  var mg = M.merge(g.A, g.B);
  M.setCount(M.findHabit(mg, 'a1'), TODAY, 1, NOW);
  assert.ok(!(TODAY in M.findHabit(g.A, 'a1').log));
});

// ---- edits ------------------------------------------------------------------------------------------
test('edits stamp the day and the habit', function () {
  var h = habit({}, 'h1', '2026-10-01');
  M.toggleDay(h, '2026-10-05', NOW + 1);
  assert.strictEqual(h.m['2026-10-05'], NOW + 1);
  assert.strictEqual(h.lu, NOW + 1);
  var u = h.u;
  M.toggleDay(h, '2026-10-05', NOW + 2);
  assert.strictEqual(h.u, u);                                        // check-ins don't touch the settings time
  M.setArchived(h, true, NOW + 3);
  assert.strictEqual(h.arch, true); assert.strictEqual(h.u, NOW + 3);
  var st = state([habit({}, 'a'), habit({}, 'b'), habit({}, 'c')]);
  st.habits.forEach(function (x, i) { x.o = i; x.u = 1; });
  M.setOrder(st, ['c', 'a', 'b'], NOW);
  assert.deepStrictEqual(st.habits.map(function (x) { return x.id + x.o; }), ['c0', 'a1', 'b2']);
  M.setOrder(st, ['c', 'a', 'b'], NOW + 50);
  assert.ok(st.habits.every(function (x) { return x.u === NOW; }));  // unchanged places keep their time
  var mk = M.makeHabit({ name: '  Stretch ', icon: ' 🧘 ', color: 'nope', target: 30, step: 45, unit: 'min', sched: 'w:2,4' }, 'x', TODAY, NOW, 7);
  assert.deepStrictEqual([mk.name, mk.icon, mk.color, mk.target, mk.step, mk.unit, M.schedStr(mk.sched), mk.o, mk.c], ['Stretch', '🧘', 'teal', 30, 30, 'min', 'w:2,4', 7, TODAY]);
});

test('progress for the day counts only habits due today', function () {
  var st = state([
    habit({ name: 'Daily' }, 'a', '2026-10-01'),
    habit({ name: 'MWF', sched: { t: 'w', days: [1, 3, 5] } }, 'b', '2026-10-01'),
    habit({ name: 'TuTh', sched: { t: 'w', days: [2, 4] } }, 'c', '2026-10-01'),
    habit({ name: 'Archived' }, 'd', '2026-10-01'),
  ]);
  M.setArchived(st.habits[3], true, NOW);
  assert.deepStrictEqual(M.progress(st, TODAY), { done: 0, total: 2 });
  check(st.habits[0], [TODAY]);
  check(st.habits[2], [TODAY]);                                     // off-day bonus doesn't count
  assert.deepStrictEqual(M.progress(st, TODAY), { done: 1, total: 2 });
});

// ---- summaries + insertion --------------------------------------------------------------------------
test('summary: today as a checklist', function () {
  var st = state([
    habit({ name: 'Run', icon: '🏃' }, 'a', '2026-10-01'),
    habit({ name: 'Water', icon: '💧', target: 8, unit: 'glasses' }, 'b', '2026-10-01'),
    habit({ name: 'Gym', sched: { t: 'n', n: 3 } }, 'c', '2026-10-01'),
    habit({ name: 'Tue only', sched: { t: 'w', days: [2] } }, 'd', '2026-10-01'),
    habit({ name: 'Thu only', sched: { t: 'w', days: [4] } }, 'e', '2026-10-01'),
  ]);
  check(st.habits[0], ['2026-10-12', '2026-10-13', TODAY]);
  M.setCount(st.habits[1], TODAY, 5, NOW);
  check(st.habits[2], ['2026-10-12']);
  check(st.habits[4], [TODAY]);                                      // bonus
  var s = M.summaryToday(st, TODAY);
  assert.strictEqual(s, [
    '**Habits · Wed 14 Oct 2026** — 1/3 done',
    '',
    '- [x] 🏃 Run · 🔥 3',
    '- [ ] 💧 Water · 5/8 glasses',
    '- [ ] Gym · 1/3 this week',
    '- [x] Thu only · bonus',
  ].join('\n'));
  assert.strictEqual(M.summaryToday(state([]), TODAY), '');
});

test('summary: this week as a table', function () {
  var st = state([
    habit({ name: 'Run | jog', icon: '🏃', sched: { t: 'w', days: [1, 3, 5] } }, 'a', '2026-10-01'),
    habit({ name: 'Water', target: 8, unit: 'glasses' }, 'b', '2026-10-13'),
    habit({ name: 'Gym', sched: { t: 'n', n: 3 } }, 'c', '2026-10-01'),
  ]);
  check(st.habits[0], ['2026-10-09', '2026-10-12']);
  M.setCount(st.habits[1], '2026-10-13', 8, NOW);
  M.setCount(st.habits[1], TODAY, 3, NOW);
  check(st.habits[2], ['2026-10-12', '2026-10-13']);
  var lines = M.summaryWeek(st, TODAY).split('\n');
  assert.strictEqual(lines[0], '**Habits · week of Mon 12 Oct 2026**');
  assert.strictEqual(lines[2], '| Habit | Mon | Tue | Wed | Thu | Fri | Sat | Sun | Week | Streak |');
  assert.strictEqual(lines[3], '|:--|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|--:|');
  assert.strictEqual(lines[4], '| 🏃 Run \\| jog | ✓ | – | ○ |   |   |   |   | 1/2 | 2d |');
  assert.strictEqual(lines[5], '| Water (8 glasses) |   | ✓ | 3 |   |   |   |   | 1/2 | 1d |');
  assert.strictEqual(lines[6], '| Gym · 3×/wk | ✓ | ✓ | ○ |   |   |   |   | 2/3 | 0w |');
  // every row has the same number of cells
  lines.slice(2).forEach(function (l) { assert.strictEqual(l.replace(/\\\|/g, '').split('|').length, 12, l); });
  st.habits.push(habit({ name: 'Sat', sched: { t: 'w', days: [6] } }, 'd', '2026-10-01'));
  assert.strictEqual(M.summaryWeek(st, TODAY).split('\n')[7], '| Sat | – | – | – |   |   |   |   | – | 0d |');   // nothing due yet
  var sun = M.summaryWeek(st, TODAY, 0).split('\n');
  assert.strictEqual(sun[0], '**Habits · week of Sun 11 Oct 2026**');
  assert.ok(/^\| Habit \| Sun \| Mon/.test(sun[2]));
});

test('insertPlan: blank-line separation around the block', function () {
  function apply(doc, pos, block) {
    var starts = [0], lines = doc.split('\n'), i;
    for (i = 0; i < lines.length - 1; i++) starts.push(starts[i] + lines[i].length + 1);
    var n = 0;
    for (i = 0; i < lines.length; i++) if (pos >= starts[i] && pos <= starts[i] + lines[i].length) { n = i; break; }
    var p = M.insertPlan(lines[n], starts[n], starts[n] + lines[n].length, n ? lines[n - 1] : null, n < lines.length - 1 ? lines[n + 1] : null, block);
    var out = doc.slice(0, p.from) + p.insert + doc.slice(p.to);
    assert.strictEqual(out.slice(p.from, p.from + p.cursor).slice(-block.length), block);
    return out;
  }
  assert.strictEqual(apply('', 0, 'B'), 'B');
  assert.strictEqual(apply('a', 1, 'B'), 'a\n\nB');
  assert.strictEqual(apply('a\nb', 0, 'B'), 'a\n\nB\nb'.replace('B\nb', 'B\n\nb'));
  assert.strictEqual(apply('a\n\nb', 2, 'B'), 'a\n\nB\n\nb');
  assert.strictEqual(apply('a\n', 2, 'B'), 'a\n\nB');
  assert.strictEqual(apply('a\n\n\nb', 3, 'B'), 'a\n\nB\n\nb');
  assert.strictEqual(apply('a\n\nb', 0, 'B'), 'a\n\nB\n\nb');
  assert.strictEqual(apply('  \nb', 0, 'B'), 'B\nb'.replace('B\nb', 'B\n\nb'));
});

console.log((process.exitCode ? 'FAILED — ' : 'ok — ') + passed + ' tests passed');
