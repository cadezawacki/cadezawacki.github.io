/* Unit tests for the Money Calculator widget's pure logic: input parsing,
 * amortization (known values, 0%, rounding, extra payments), compound growth
 * and the goal solvers, percent tools, markup vs margin, ROI and break-even.
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/moneycalc/moneycalc.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var L = require('./moneycalc.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ' ± ' + tol + ', got ' + a); }
function sum(a, f) { return a.reduce(function (s, x) { return s + f(x); }, 0); }
function loan(dollars, rate, n, ppy, extra) { return L.amortize({ principal: Math.round(dollars * 100), rate: rate, n: n, ppy: ppy || 12, extra: extra ? Math.round(extra * 100) : 0 }); }
// A schedule must pay the principal exactly, end at 0 and never go negative.
function checkSchedule(s) {
  var bal = s.principal;
  s.rows.forEach(function (r, i) {
    assert.strictEqual(r.int, Math.round(r.int), 'integer interest');
    assert.ok(r.prin >= 0 && r.extra >= 0, 'no negative principal');
    assert.strictEqual(r.pay, r.int + r.prin + r.extra);
    bal -= r.prin + r.extra;
    assert.strictEqual(r.bal, bal, 'running balance at ' + i);
    assert.ok(r.bal >= 0);
  });
  assert.strictEqual(bal, 0, 'paid off exactly');
  assert.strictEqual(sum(s.rows, function (r) { return r.prin + r.extra; }), s.principal);
  assert.strictEqual(sum(s.rows, function (r) { return r.int; }), s.interest);
  assert.strictEqual(s.paid, s.principal + s.interest);
  assert.strictEqual(s.count, s.rows.length);
}

// ---------------------------------------------------------------- parsing
test('parseNum: "250k", "1,200.50", "6.5%", symbols, both decimal styles', function () {
  var cases = [['250k', 250000], ['1,200.50', 1200.5], ['1.200,50', 1200.5], ['6.5%', 6.5], ['$300,000', 300000], ['€ 1.234,56', 1234.56],
    ['1.5m', 1500000], ['12,5', 12.5], ['  42  ', 42], ['-3.25', -3.25], ['0.065', 0.065], ['1e3', NaN]];
  cases.forEach(function (c) {
    var r = L.parseNum(c[0], false);
    if (isNaN(c[1])) assert.strictEqual(r, null, c[0]);
    else assert.strictEqual(r.v, c[1], c[0]);
  });
  assert.strictEqual(L.parseNum('6.5%').pct, true);
  assert.strictEqual(L.parseNum('6.5').pct, false);
  assert.strictEqual(L.parseNum('1.200', true).v, 1200);
  assert.strictEqual(L.parseNum('2,5%', true).v, 2.5);
  assert.ok(isNaN(L.num('abc')));
});

// ---------------------------------------------------------------- amortization
test('amortize: $300,000 at 6.5% for 30 years → $1,896.20 a month', function () {
  var s = loan(300000, 6.5, 360);
  assert.strictEqual(s.pmt, 189620);
  assert.strictEqual(s.count, 360);
  checkSchedule(s);
  near(s.interest / 100, 382632, 10, 'total interest');   // 1896.20 × 360 − 300,000 = 382,632 before rounding drift
  assert.strictEqual(s.rows[0].int, 162500);                 // 300,000 × 6.5% / 12
  assert.strictEqual(s.rows[0].prin, 27120);
  near(s.last, s.pmt, 1000, 'last payment absorbs only the rounding');
});
test('amortize: other known payments', function () {
  assert.strictEqual(loan(200000, 4.5, 360).pmt, 101337);    // $1,013.37
  assert.strictEqual(loan(25000, 7, 60).pmt, 49503);         // $495.03
  assert.strictEqual(loan(10000, 5, 36).pmt, 29971);         // $299.71
  assert.strictEqual(loan(100000, 12, 12).pmt, 888488);      // $8,884.88
  [loan(200000, 4.5, 360), loan(25000, 7, 60), loan(10000, 5, 36), loan(100000, 12, 12)].forEach(checkSchedule);
});
test('amortize: 0% rate splits the principal evenly; the last payment takes the odd cents', function () {
  var s = loan(30000, 0, 60);
  assert.strictEqual(s.pmt, 50000);
  assert.strictEqual(s.interest, 0);
  checkSchedule(s);
  var odd = loan(1000, 0, 7);
  assert.strictEqual(odd.pmt, 14286);
  assert.strictEqual(odd.last, 100000 - 14286 * 6);
  checkSchedule(odd);
});
test('amortize: payment frequencies', function () {
  var bi = loan(300000, 6.5, 780, 26);
  assert.strictEqual(bi.pmt, L.rnd(L.payment(30000000, 0.065 / 26, 780)));
  checkSchedule(bi);
  assert.ok(bi.interest < loan(300000, 6.5, 360).interest, 'paying every 2 weeks costs less interest');
  checkSchedule(loan(50000, 8, 40, 4));
  checkSchedule(loan(50000, 8, 10, 1));
  checkSchedule(loan(12345.67, 3.25, 520, 52));
  assert.strictEqual(loan(50000, 8, 10, 1).pmt, L.rnd(5000000 * 0.08 / (1 - Math.pow(1.08, -10))));
});
test('amortize: an extra payment pays off sooner and saves interest', function () {
  var base = loan(300000, 6.5, 360), ex = loan(300000, 6.5, 360, 12, 200);
  checkSchedule(ex);
  assert.strictEqual(ex.pmt, base.pmt);
  assert.ok(ex.count < base.count);
  // closed form: n = −ln(1 − rP/A) / ln(1 + r) with A = 1,896.20 + 200 → 276.3 → 277 payments
  var r = 0.065 / 12;
  assert.strictEqual(ex.count, Math.ceil(-Math.log(1 - r * 300000 / 2096.2) / Math.log(1 + r)));
  assert.strictEqual(ex.count, 277);
  assert.ok(ex.interest < base.interest);
  // closed form for the interest with the extra: A × n_exact − P (n_exact = 276.3)
  var nExact = -Math.log(1 - r * 300000 / 2096.2) / Math.log(1 + r);
  near(ex.interest / 100, 2096.2 * nExact - 300000, 5, 'interest with the extra');
  near((base.interest - ex.interest) / 100, 103450, 5, 'interest saved');
  assert.strictEqual(sum(ex.rows, function (r) { return r.extra; }) % 20000 === 0 || ex.rows[ex.count - 1].extra < 20000, true);
  // an extra bigger than the balance just pays it off
  var huge = loan(1000, 5, 12, 12, 5000);
  checkSchedule(huge);
  assert.strictEqual(huge.count, 1);
});
test('amortize: rejects nonsense and never loops forever', function () {
  assert.strictEqual(L.amortize({ principal: 0, rate: 5, n: 12, ppy: 12 }), null);
  assert.strictEqual(L.amortize({ principal: 1000, rate: -1, n: 12, ppy: 12 }), null);
  assert.strictEqual(L.amortize({ principal: 1000, rate: 5, n: 0, ppy: 12 }), null);
  assert.strictEqual(L.amortize({ principal: 1000, rate: NaN, n: 12, ppy: 12 }), null);
  // a payment that would round below the interest is nudged up so the loan still amortizes
  var s = L.amortize({ principal: 100000000, rate: 99, n: 600, ppy: 12 });
  checkSchedule(s);
  assert.ok(s.rows[0].prin > 0);
});
test('amortize: random loans always end at exactly zero', function () {
  var seed = 3;
  function R() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  for (var t = 0; t < 300; t++) {
    var ppy = [12, 26, 24, 52, 4, 1][t % 6], years = 1 + Math.floor(R() * 30);
    var s = L.amortize({ principal: 100 + Math.floor(R() * 1e8), rate: Math.round(R() * 1500) / 100, n: years * ppy, ppy: ppy, extra: t % 3 ? 0 : Math.floor(R() * 50000) });
    checkSchedule(s);
    assert.ok(s.count <= years * ppy);
  }
});
test('yearly: summarises the schedule by loan year', function () {
  var s = loan(300000, 6.5, 360), ys = L.yearly(s);
  assert.strictEqual(ys.length, 30);
  assert.strictEqual(sum(ys, function (y) { return y.prin; }), 30000000);
  assert.strictEqual(sum(ys, function (y) { return y.int; }), s.interest);
  assert.strictEqual(ys[29].bal, 0);
  assert.strictEqual(ys[0].bal, s.rows[11].bal);
  assert.strictEqual(ys[0].from, 0);
  assert.strictEqual(ys[0].to, 12);
  var ex = loan(300000, 6.5, 360, 12, 200), ye = L.yearly(ex);
  assert.strictEqual(ye.length, Math.ceil(ex.count / 12));
  assert.strictEqual(ye[ye.length - 1].bal, 0);
  assert.ok(ye[0].extra === 240000);
});
test('dates: months clamp to the month end; other frequencies step by days', function () {
  var iso = L.isoDate;
  assert.strictEqual(iso(L.addPeriods(new Date(2024, 0, 31), 1, 12)), '2024-02-29');
  assert.strictEqual(iso(L.addPeriods(new Date(2023, 0, 31), 1, 12)), '2023-02-28');
  assert.strictEqual(iso(L.addPeriods(new Date(2024, 0, 31), 13, 12)), '2025-02-28');
  assert.strictEqual(iso(L.addPeriods(new Date(2026, 10, 1), 359, 12)), '2056-10-01');
  assert.strictEqual(iso(L.addPeriods(new Date(2026, 0, 1), 1, 26)), '2026-01-15');
  assert.strictEqual(iso(L.addPeriods(new Date(2026, 0, 1), 2, 52)), '2026-01-15');
  assert.strictEqual(iso(L.addPeriods(new Date(2026, 0, 1), 3, 24)), '2026-02-16');
  assert.strictEqual(iso(L.addPeriods(new Date(2026, 0, 15), 1, 4)), '2026-04-15');
  assert.strictEqual(iso(L.addPeriods(new Date(2026, 0, 15), 2, 1)), '2028-01-15');
  assert.strictEqual(iso(L.parseDate('2026-03-09')), '2026-03-09');
  assert.strictEqual(L.parseDate('2026-02-30'), null);
  assert.strictEqual(L.parseDate('nope'), null);
});
test('duration labels', function () {
  assert.strictEqual(L.duration(89), '7 yrs 5 mos');
  assert.strictEqual(L.duration(12), '1 yr');
  assert.strictEqual(L.duration(13), '1 yr 1 mo');
  assert.strictEqual(L.duration(5), '5 mos');
  assert.strictEqual(L.duration(0), '0 mos');
});

// ---------------------------------------------------------------- savings
test('compound growth: known values', function () {
  near(L.fv(10000, 0, L.monthlyRate(5, 1), 120), 16288.95, 0.005, 'yearly');      // 10,000 × 1.05^10
  near(L.fv(10000, 0, L.monthlyRate(5, 12), 120), 16470.09, 0.005, 'monthly');    // 10,000 × (1 + .05/12)^120
  near(L.fv(10000, 0, L.monthlyRate(5, 365), 120), 16486.65, 0.005, 'daily');
  near(L.fv(10000, 0, L.monthlyRate(5, 4), 120), 16436.19, 0.005, 'quarterly');
  near(L.fv(1000, 0, L.monthlyRate(5, 0), 12), 1000 * Math.exp(0.05), 1e-9, 'continuous');
  near(L.fv(0, 100, L.monthlyRate(6, 12), 120), 16387.93, 0.005, '$100/month, end of month');
  near(L.fv(5000, 200, L.monthlyRate(7, 12), 240), 5000 * Math.pow(1 + 0.07 / 12, 240) + 200 * (Math.pow(1 + 0.07 / 12, 240) - 1) / (0.07 / 12), 1e-6);
  assert.strictEqual(L.fv(1000, 50, 0, 24), 2200);
  assert.strictEqual(L.monthlyRate(0, 12), 0);
  near(L.monthlyRate(12, 12), 0.01, 1e-15);
});
test('growth series: contributions vs growth by year', function () {
  var i = L.monthlyRate(7, 12), s = L.growthSeries(10000, 500, i, 246);
  assert.strictEqual(s.length, 1 + 20 + 1);
  assert.deepStrictEqual(s[0], { m: 0, bal: 10000, contrib: 10000, growth: 0 });
  assert.strictEqual(s[s.length - 1].m, 246);
  near(s[s.length - 1].bal, L.fv(10000, 500, i, 246), 1e-9);
  s.forEach(function (p) { near(p.bal, p.contrib + p.growth, 1e-6); assert.strictEqual(p.contrib, 10000 + 500 * p.m); });
  assert.strictEqual(L.growthSeries(1, 1, 0, 24).length, 3);
});
test('solver: months to reach a target', function () {
  var i = 0.005;
  assert.strictEqual(L.monthsToTarget(0, 100, i, 16387.93), 120);
  assert.strictEqual(L.monthsToTarget(0, 100, i, 16388), 121);
  assert.strictEqual(L.monthsToTarget(5000, 0, 0, 1000), 0);
  assert.strictEqual(L.monthsToTarget(0, 100, 0, 1000), 10);
  assert.strictEqual(L.monthsToTarget(0, 100, 0, 1001), 11);
  assert.strictEqual(L.monthsToTarget(1000, 0, 0, 2000), Infinity);
  assert.strictEqual(L.monthsToTarget(1000, 0, i, 2000), Math.ceil(Math.log(2) / Math.log(1.005)));
  assert.strictEqual(L.monthsToTarget(1, 0, 0.0001, 1e9), Infinity);   // beyond 100 years
  assert.ok(isNaN(L.monthsToTarget(1, 1, i, 0)));
  // the answer is the first month at or past the target
  var R = 1;
  for (var t = 0; t < 200; t++) {
    R = (R * 16807) % 2147483647;
    var P = R % 20000, C = 50 + R % 900, ii = L.monthlyRate((R % 1200) / 100, 12), X = P + 1000 + (R % 400000);
    var k = L.monthsToTarget(P, C, ii, X);
    if (!isFinite(k)) continue;
    assert.ok(L.fv(P, C, ii, k) >= X - 1e-6, 'reached at k');
    if (k > 0) assert.ok(L.fv(P, C, ii, k - 1) < X, 'not before k');
  }
});
test('solver: monthly contribution needed', function () {
  var i = 0.005;
  near(L.monthlyNeeded(0, i, 120, 16387.93), 100, 1e-4);
  near(L.monthlyNeeded(0, 0, 10, 1000), 100, 1e-12);
  assert.strictEqual(L.monthlyNeeded(100000, i, 120, 1000), 0);
  var need = L.monthlyNeeded(10000, L.monthlyRate(7, 12), 240, 500000);
  near(L.fv(10000, need, L.monthlyRate(7, 12), 240), 500000, 1e-6, 'round trip');
  var g = Math.pow(1 + 0.07 / 12, 240);
  near(need, (500000 - 10000 * g) * (0.07 / 12) / (g - 1), 1e-9);
  near(need, 882.30, 0.005);
});
test('inflation: real value', function () {
  near(L.realValue(1000, 3, 12), 1000 / 1.03, 1e-9);
  near(L.realValue(16288.95, 5, 120), 10000, 0.01);
  assert.strictEqual(L.realValue(500, 0, 60), 500);
});

// ---------------------------------------------------------------- percent tools
test('percent: of, what %, change', function () {
  near(L.pctOf(15, 80), 12, 1e-12);
  near(L.whatPct(12, 80), 15, 1e-12);
  assert.ok(isNaN(L.whatPct(5, 0)));
  near(L.pctChange(80, 100), 25, 1e-12);
  near(L.pctChange(100, 80), -20, 1e-12);
  near(L.pctChange(-50, -25), 50, 1e-12);
  assert.ok(isNaN(L.pctChange(0, 5)));
});
test('percent: add / subtract / remove an included percent (VAT, discounts)', function () {
  near(L.addPct(100, 20), 120, 1e-12);
  near(L.subPct(100, 20), 80, 1e-12);
  near(L.removePct(120, 20), 100, 1e-12);
  near(L.removePct(100, 20), 83.333333, 1e-6);
  near(L.removePct(108.875, 8.875), 100, 1e-12);
  assert.ok(isNaN(L.removePct(100, -100)));
});
test('markup vs margin', function () {
  var a = L.markupMargin(60, 'price', 100);
  near(a.profit, 40, 1e-12); near(a.markup, 66.6667, 1e-4); near(a.margin, 40, 1e-12);
  var b = L.markupMargin(100, 'markup', 50);
  near(b.price, 150, 1e-12); near(b.margin, 33.3333, 1e-4);
  var c = L.markupMargin(60, 'margin', 40);
  near(c.price, 100, 1e-12); near(c.markup, 66.6667, 1e-4);
  assert.strictEqual(L.markupMargin(60, 'margin', 100), null);
  var z = L.markupMargin(0, 'price', 10);
  assert.ok(isNaN(z.markup)); near(z.margin, 100, 1e-12);
});

// ---------------------------------------------------------------- ROI / break-even
test('ROI and annualized return', function () {
  var r = L.roi(10000, 14500, 3);
  assert.strictEqual(r.gain, 4500);
  near(r.pct, 45, 1e-12);
  near(r.cagr, (Math.pow(1.45, 1 / 3) - 1) * 100, 1e-9);
  near(r.cagr, 13.1851, 1e-4);
  var loss = L.roi(1000, 800, 2);
  near(loss.pct, -20, 1e-12); near(loss.cagr, (Math.sqrt(0.8) - 1) * 100, 1e-9);
  assert.ok(isNaN(L.roi(1000, 1200).cagr));
  assert.strictEqual(L.roi(0, 100, 1), null);
});
test('break-even units and revenue', function () {
  var b = L.breakEven(12000, 25, 10);
  assert.strictEqual(b.units, 800); assert.strictEqual(b.whole, 800);
  near(b.revenue, 20000, 1e-9); near(b.cmPct, 60, 1e-12);
  var c = L.breakEven(1000, 7, 4);
  near(c.units, 333.333, 1e-3); assert.strictEqual(c.whole, 334);
  assert.strictEqual(L.breakEven(1000, 5, 5).units, Infinity);
  assert.strictEqual(L.breakEven(-1, 5, 1), null);
});

// ---------------------------------------------------------------- formatting
test('money and number formatting', function () {
  assert.strictEqual(L.money(189620, 'USD', 'en-US'), '$1,896.20');
  assert.strictEqual(L.money(-189620, 'USD', 'en-US'), '−$1,896.20');
  assert.strictEqual(L.money(189620, 'EUR', 'de-DE').replace(/\s/g, ' '), '1.896,20 €');
  assert.strictEqual(L.money0(1234567.8, 'USD', 'en-US'), '$1,234,568');
  assert.strictEqual(L.fmtNum(83.333333, 'en-US'), '83.3333');
  assert.strictEqual(L.fmtNum(12345.678, 'en-US'), '12,345.68');
  assert.strictEqual(L.fmtNum(-0.00001, 'en-US'), '0');
  assert.strictEqual(L.fmtPct(15, 'en-US'), '15%');
  assert.strictEqual(L.fmtPct(13.18512, 'en-US', 2), '13.19%');
  assert.strictEqual(L.guessCur('en-GB'), 'GBP');
  assert.strictEqual(L.curSymbol('USD', 'en-US'), '$');
});

test('safeLocale: odd system locales become usable BCP 47 tags', function () {
  assert.strictEqual(L.safeLocale('en-US@posix'), 'en-US');
  assert.strictEqual(L.safeLocale('de_DE.UTF-8'), 'de-DE');
  assert.strictEqual(L.safeLocale('fr-CA'), 'fr-CA');
  assert.strictEqual(L.safeLocale(''), 'en-US');
  assert.strictEqual(L.safeLocale('!!'), 'en-US');
  assert.doesNotThrow(function () { new Date(2026, 0, 1).toLocaleDateString(L.safeLocale('en-US@posix'), { month: 'short' }); });
});

// ---------------------------------------------------------------- widget registration
test('widget registers as "Money Calculator" (equal to the manifest entry name)', function () {
  var widget = null, css = null;
  var win = { Cade: { loadCSS: function (c) { css = c; }, registerWidget: function (w) { widget = w; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'moneycalc.js'), 'utf8'), { window: win, Intl: Intl, Math: Math, Date: Date, JSON: JSON }, { filename: 'moneycalc.js' });
  assert.ok(widget, 'registerWidget was called');
  assert.strictEqual(widget.name, 'Money Calculator');
  assert.strictEqual(css, 'moneycalc.css');
  var entry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === 'moneycalc'; })[0];
  assert.strictEqual(entry.name, widget.name);
  assert.strictEqual(entry.description, widget.description);
  assert.strictEqual(entry.icon, widget.icon);
  assert.strictEqual(entry.tags, widget.tags);
  assert.strictEqual(entry.entry, 'widgets/moneycalc/moneycalc.js');
  assert.strictEqual(entry.css, 'widgets/moneycalc/moneycalc.css');
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
