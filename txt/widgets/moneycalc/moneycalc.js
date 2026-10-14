/* Money Calculator — loans & mortgages, savings growth, percentages, ROI.
 *
 *  Loan: a loan amount, or a home price less a down payment (an amount or a
 *    %); annual rate; term in years or months; payment frequency; first
 *    payment date; optional extra per payment. → the periodic payment, total
 *    interest, payoff date; with an extra payment, how much sooner and how
 *    much interest it saves; a yearly amortization schedule (tap a year for
 *    its payments) and a balance chart.
 *  Savings: initial deposit, monthly contribution, rate, years, compounding,
 *    optional inflation → future value, contributions vs growth (chart and
 *    yearly table), and two solvers: how long to reach a goal, and the
 *    monthly contribution needed to reach it in the chosen years.
 *  Percent: x% of y · x is what % of y · % change · add / subtract / remove a
 *    % (VAT, discounts) · markup vs margin.
 *  ROI: return and annualized return (CAGR); break-even units and revenue.
 *
 * Accuracy (unit-checked in moneycalc.test.js):
 *  - Loans: the standard amortization formula P·r / (1 − (1 + r)^−n) with
 *    r = APR / payments per year (0% → P / n). The payment is rounded to the
 *    cent, each period's interest is rounded to the cent, and the last
 *    payment absorbs the rounding so the balance ends at exactly 0.
 *    $300,000 at 6.5% for 30 years → $1,896.20 a month.
 *  - Savings: contributions are made at the END of each month; interest
 *    compounds at the chosen frequency, applied each month at the
 *    equivalent monthly rate (1 + APR/k)^(k/12) − 1 (continuous: e^(APR/12) − 1).
 *    The UI states this assumption.
 *
 * Inputs accept "250k", "1,200.50", "1.200,50", "6.5%", "$1,000". Results
 * update live; Copy gives plain text, Insert puts a markdown summary (or
 * table) into the note. Prefs (currency, number format, the last inputs of
 * every tab, the tab) live in Cade.store 'cade-moneycalc-prefs'.
 *
 * Nothing runs until the panel opens; there are no timers, and every
 * listener lives on the panel and goes with it (the one animation frame, for
 * the phone result bar, is cancelled on close). The DOM-free logic is
 * exported for node tests (moneycalc.test.js). Self-contained IIFE, ES5. */
(function () {
  'use strict';

  // ======================================================================
  // Pure logic (no DOM)
  // ======================================================================
  var Logic = (function () {
    var MULT = { k: 1e3, m: 1e6, mm: 1e6, b: 1e9, bn: 1e9 };
    function clean(x) { return Number(x.toPrecision(15)); }
    // Round half away from zero to an integer (cents), shaving binary noise first.
    function rnd(x) {
      if (typeof x !== 'number' || !isFinite(x)) return NaN;
      var a = Math.round(clean(Math.abs(x)));
      return x < 0 ? -a : a;
    }

    // ---- input parsing -----------------------------------------------------------------
    // "1,200.50", "1.200,50", "$12", "250k", "1.5m", "6.5%", "−3" → { v, pct } | null.
    // A lone separator: the locale's decimal mark is decimal; the other one
    // groups thousands when exactly 3 digits follow ("1,200" = 1200), else
    // it's decimal too ("12,5" = 12.5).
    function groupedOk(intPart, sep) { return new RegExp('^\\d{1,3}(?:\\' + sep + '\\d{3})+$').test(intPart); }
    function parseNum(input, decComma) {
      if (typeof input === 'number') return isFinite(input) ? { v: input, pct: false } : null;
      var s = String(input == null ? '' : input).trim();
      if (!s) return null;
      s = s.replace(/[−‒–—﹣－]/g, '-').replace(/[\s    '’_]/g, '');
      var neg = false, pct = false;
      if (s.charAt(0) === '+') s = s.slice(1);
      if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
      s = s.replace(/^(?:[A-Z]{3}|R\$|[$€£¥₹₩₽₺₪฿₫₱¢₣₴₦])/, '');
      if (s.charAt(0) === '-') { neg = !neg; s = s.slice(1); }
      s = s.replace(/(?:[A-Z]{3}|kr|zł|[$€£¥₹₩₽₺₪฿₫₱¢])$/, '');
      if (s.charAt(s.length - 1) === '%') { pct = true; s = s.slice(0, -1); }
      var mult = 1, m = /(bn|mm|[kmb])$/i.exec(s);
      if (m) { mult = MULT[m[1].toLowerCase()]; s = s.slice(0, -m[1].length); }
      if (!pct && s.charAt(s.length - 1) === '%') { pct = true; s = s.slice(0, -1); }
      if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
      var hasDot = s.indexOf('.') >= 0, hasComma = s.indexOf(',') >= 0;
      if (hasDot && hasComma) {
        var dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
        var grp = dec === '.' ? ',' : '.';
        var parts = s.split(dec);
        if (parts.length !== 2 || parts[1].indexOf(grp) >= 0 || !groupedOk(parts[0], grp)) return null;
        s = parts[0].split(grp).join('') + '.' + parts[1];
      } else if (hasDot || hasComma) {
        var sep = hasDot ? '.' : ',';
        var bits = s.split(sep);
        if (bits.length > 2) {
          if (!groupedOk(s, sep)) return null;
          s = bits.join('');
        } else {
          var isDecMark = (sep === ',') === !!decComma;
          if (!isDecMark && bits[1].length === 3 && /^[1-9]\d{0,2}$/.test(bits[0])) s = bits[0] + bits[1];
          else s = bits[0] + '.' + bits[1];
        }
      }
      if (s === '.') return null;
      var v = parseFloat(s);
      if (!isFinite(v)) return null;
      v = clean(v * mult);
      return { v: neg ? -v : v, pct: pct };
    }
    function num(s, decComma) { var r = parseNum(s, decComma); return r ? r.v : NaN; }

    // ---- formatting -----------------------------------------------------------------------
    var fmtCache = {};
    function nf(loc, opts, key) {
      var k = (loc || '') + '|' + key;
      if (!fmtCache[k]) {
        try { fmtCache[k] = new Intl.NumberFormat(loc || undefined, opts); }
        catch (e) { fmtCache[k] = new Intl.NumberFormat('en-US', opts.style === 'currency' ? { style: 'currency', currency: 'USD' } : opts); }
      }
      return fmtCache[k];
    }
    function validCur(c) {
      if (!/^[A-Z]{3}$/.test(String(c || ''))) return false;
      try { new Intl.NumberFormat('en', { style: 'currency', currency: c }); return true; } catch (e) { return false; }
    }
    // cents → "$1,234.50" (always 2 decimals: rates and interest are cent-precise).
    function money(cents, cur, loc) {
      if (typeof cents !== 'number' || !isFinite(cents)) return '—';
      var s = nf(loc, { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }, 'c2' + cur).format(Math.abs(cents) / 100);
      return cents < 0 ? '−' + s : s;
    }
    // A whole-unit figure for big projections ("$1,234,567").
    function money0(v, cur, loc) {
      if (typeof v !== 'number' || !isFinite(v)) return '—';
      var s = nf(loc, { style: 'currency', currency: cur, minimumFractionDigits: 0, maximumFractionDigits: 0 }, 'c0' + cur).format(Math.abs(v));
      return v < 0 ? '−' + s : s;
    }
    function curSymbol(cur, loc) {
      try {
        var parts = nf(loc, { style: 'currency', currency: cur }, 'cs' + cur).formatToParts(1);
        for (var i = 0; i < parts.length; i++) if (parts[i].type === 'currency') return parts[i].value;
      } catch (e) {}
      return cur;
    }
    // Plain number with grouping; up to `dec` decimals (trailing zeros dropped).
    function fmtNum(v, loc, dec) {
      if (typeof v !== 'number' || !isFinite(v)) return '—';
      if (dec == null) dec = Math.abs(v) >= 1000 ? 2 : 4;
      var s = nf(loc, { maximumFractionDigits: dec }, 'n' + dec).format(Math.abs(v));
      return (v < 0 && s !== '0' ? '−' : '') + s;
    }
    function fmtPct(v, loc, dec) { return typeof v === 'number' && isFinite(v) ? fmtNum(v, loc, dec == null ? 2 : dec) + '%' : '—'; }
    var decCache = {};
    function decimalComma(loc) {
      var k = loc || '';
      if (decCache[k] == null) {
        try { decCache[k] = new Intl.NumberFormat(loc || undefined).format(1.5).indexOf(',') >= 0; } catch (e) { decCache[k] = false; }
      }
      return decCache[k];
    }
    var REGION_CUR = {
      US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', IN: 'INR', JP: 'JPY', CN: 'CNY', KR: 'KRW', BR: 'BRL', MX: 'MXN',
      CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', ZA: 'ZAR', SG: 'SGD', HK: 'HKD', TR: 'TRY',
      IL: 'ILS', AE: 'AED', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', IE: 'EUR',
      FI: 'EUR', GR: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', LU: 'EUR', MT: 'EUR', CY: 'EUR', HR: 'EUR',
    };
    var LANG_CUR = { ja: 'JPY', ko: 'KRW', zh: 'CNY', de: 'EUR', fr: 'EUR', es: 'EUR', it: 'EUR', nl: 'EUR', pt: 'EUR', fi: 'EUR', el: 'EUR', sv: 'SEK', nb: 'NOK', da: 'DKK', pl: 'PLN', cs: 'CZK', hu: 'HUF', tr: 'TRY', he: 'ILS', hi: 'INR' };
    function guessCur(loc) {
      var m = /^([a-z]{2,3})(?:[-_][A-Za-z]{4})?(?:[-_]([A-Z]{2}))?/i.exec(String(loc || ''));
      if (!m) return 'USD';
      if (m[2] && REGION_CUR[m[2].toUpperCase()]) return REGION_CUR[m[2].toUpperCase()];
      return LANG_CUR[m[1].toLowerCase()] || 'USD';
    }
    // A usable BCP 47 tag ("en-US@posix" / "de_DE.UTF-8" → "en-US" / "de-DE"; junk → "en-US").
    var locCache = {};
    function safeLocale(l) {
      l = String(l || '');
      if (locCache[l]) return locCache[l];
      var out = 'en-US', cands = [l, l.split(/[@.]/)[0].replace(/_/g, '-')];
      for (var i = 0; i < cands.length; i++) {
        if (!cands[i]) continue;
        try { var c = Intl.getCanonicalLocales(cands[i])[0]; if (c) { new Intl.NumberFormat(c); out = c; break; } } catch (e) {}
      }
      locCache[l] = out;
      return out;
    }
    // 89 → "7 yrs 5 mos"; 12 → "1 yr"; 5 → "5 mos".
    function duration(months) {
      if (!isFinite(months)) return '—';
      months = Math.max(0, Math.round(months));
      var y = Math.floor(months / 12), m = months % 12, out = [];
      if (y) out.push(y + (y === 1 ? ' yr' : ' yrs'));
      if (m || !y) out.push(m + (m === 1 ? ' mo' : ' mos'));
      return out.join(' ');
    }

    // ---- dates -----------------------------------------------------------------------------------
    function addMonths(d, k) {
      var y = d.getFullYear(), m = d.getMonth() + k, day = d.getDate();
      var ty = y + Math.floor(m / 12), tm = ((m % 12) + 12) % 12;
      var last = new Date(ty, tm + 1, 0).getDate();
      return new Date(ty, tm, Math.min(day, last));
    }
    function addDays(d, k) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + k); }
    // The date of payment number k (0 = the first) for `ppy` payments a year.
    function addPeriods(d, k, ppy) {
      switch (ppy) {
        case 52: return addDays(d, 7 * k);
        case 26: return addDays(d, 14 * k);
        case 24: return addDays(addMonths(d, Math.floor(k / 2)), k % 2 ? 15 : 0);
        case 4: return addMonths(d, 3 * k);
        case 1: return addMonths(d, 12 * k);
        default: return addMonths(d, k);
      }
    }
    function parseDate(s) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
      if (!m) return null;
      var d = new Date(+m[1], +m[2] - 1, +m[3]);
      return d.getMonth() === +m[2] - 1 ? d : null;
    }
    function isoDate(d) { var p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }

    // ---- loans ---------------------------------------------------------------------------------------
    var FREQS = [[12, 'Monthly', 'month'], [26, 'Every 2 weeks', 'payment'], [24, 'Twice a month', 'payment'], [52, 'Weekly', 'week'], [4, 'Quarterly', 'quarter'], [1, 'Yearly', 'year']];
    // The exact (unrounded) level payment for principal P, periodic rate r, n payments.
    function payment(P, r, n) {
      if (!(n > 0)) return NaN;
      if (!r) return P / n;
      return P * r / (1 - Math.pow(1 + r, -n));
    }
    // o: { principal (cents), rate (annual %), n (payments), ppy, extra (cents per payment), pmt? (cents) }
    // → { pmt, r, rows: [{ k, int, prin, extra, pay, bal }], interest, paid, count, last }
    function amortize(o) {
      var P = Math.round(o.principal), n = Math.round(o.n), ppy = o.ppy || 12;
      if (!(P > 0) || !(n >= 1) || !isFinite(o.rate) || o.rate < 0) return null;
      var r = o.rate / 100 / ppy, extra = o.extra > 0 ? Math.round(o.extra) : 0;
      var pmt = o.pmt > 0 ? Math.round(o.pmt) : rnd(payment(P, r, n));
      // A payment that rounds down to (or below) the first period's interest would never amortize.
      var firstInt = rnd(P * r);
      if (pmt <= firstInt) pmt = firstInt + 1;
      var rows = [], bal = P, totInt = 0, k = 0;
      while (bal > 0 && k < n) {
        k++;
        var it = rnd(bal * r), pr = pmt - it, ex = 0;
        if (k >= n || pr >= bal) pr = bal;            // last payment: whatever is left
        else ex = Math.min(extra, bal - pr);
        bal -= pr + ex;
        totInt += it;
        rows.push({ k: k, int: it, prin: pr, extra: ex, pay: it + pr + ex, bal: bal });
      }
      return { pmt: pmt, r: r, rows: rows, interest: totInt, paid: P + totInt, count: rows.length, last: rows[rows.length - 1].pay, principal: P, ppy: ppy, n: n };
    }
    // Per loan year: { y, prin (incl. extra), int, extra, bal, from, to } (row indexes [from, to)).
    function yearly(sched) {
      var out = [], ppy = sched.ppy, rows = sched.rows;
      for (var i = 0; i < rows.length; i += ppy) {
        var y = { y: out.length + 1, prin: 0, int: 0, extra: 0, bal: 0, from: i, to: Math.min(rows.length, i + ppy) };
        for (var j = y.from; j < y.to; j++) { y.prin += rows[j].prin + rows[j].extra; y.int += rows[j].int; y.extra += rows[j].extra; }
        y.bal = rows[y.to - 1].bal;
        out.push(y);
      }
      return out;
    }

    // ---- savings -------------------------------------------------------------------------------------
    var COMPS = [[12, 'Monthly'], [365, 'Daily'], [4, 'Quarterly'], [2, 'Twice a year'], [1, 'Yearly'], [0, 'Continuously']];
    // Equivalent monthly rate for an annual rate (%) compounded `k` times a year (0 = continuously).
    function monthlyRate(annualPct, k) {
      var r = annualPct / 100;
      if (!r) return 0;
      if (k === 0) return Math.exp(r / 12) - 1;
      return Math.pow(1 + r / k, k / 12) - 1;
    }
    // Future value after n months: initial P, contribution C at the END of every month, monthly rate i.
    function fv(P, C, i, n) {
      if (!i) return P + C * n;
      var g = Math.pow(1 + i, n);
      return P * g + C * (g - 1) / i;
    }
    // Year-end points (and the final month if it isn't a whole year): { m, bal, contrib, growth }.
    function growthSeries(P, C, i, months) {
      var out = [{ m: 0, bal: P, contrib: P, growth: 0 }];
      for (var m = 12; m <= months; m += 12) out.push(point(m));
      if (months % 12) out.push(point(months));
      function point(mm) { var b = fv(P, C, i, mm), c = P + C * mm; return { m: mm, bal: b, contrib: c, growth: b - c }; }
      return out;
    }
    // Months until the balance reaches X (Infinity when it never does within 100 years).
    function monthsToTarget(P, C, i, X) {
      if (!(X > 0) || !isFinite(P) || !isFinite(C)) return NaN;
      if (P >= X) return 0;
      var n;
      if (!i) n = C > 0 ? (X - P) / C : Infinity;
      else {
        var A = X + C / i, B = P + C / i;
        n = B !== 0 && A / B > 0 ? Math.log(A / B) / Math.log(1 + i) : Infinity;
      }
      if (!isFinite(n) || n < 0) return Infinity;
      var k = Math.max(0, Math.ceil(n - 1e-9));
      while (k <= 1200 && fv(P, C, i, k) < X - 1e-7) k++;
      if (k > 0 && fv(P, C, i, k - 1) >= X - 1e-7) k--;
      return k > 1200 ? Infinity : k;
    }
    // Monthly contribution (end of month) that reaches X after n months; 0 when P alone gets there.
    function monthlyNeeded(P, i, n, X) {
      if (!(n > 0) || !isFinite(X)) return NaN;
      var g = i ? Math.pow(1 + i, n) : 1;
      var need = i ? (X - P * g) * i / (g - 1) : (X - P) / n;
      return need > 0 ? need : 0;
    }
    function realValue(v, inflPct, months) { return inflPct ? v / Math.pow(1 + inflPct / 100, months / 12) : v; }

    // ---- percent ---------------------------------------------------------------------------------------
    function pctOf(x, y) { return x / 100 * y; }
    function whatPct(x, y) { return y ? x / y * 100 : NaN; }
    function pctChange(a, b) { return a ? (b - a) / Math.abs(a) * 100 : NaN; }
    function addPct(y, x) { return y * (1 + x / 100); }
    function subPct(y, x) { return y * (1 - x / 100); }
    // A gross amount that INCLUDES x% (e.g. a price with 20% VAT) → the net amount.
    function removePct(y, x) { return x > -100 ? y / (1 + x / 100) : NaN; }
    // mode 'price' | 'markup' | 'margin' with its value → { cost, price, profit, markup %, margin % } | null.
    function markupMargin(cost, mode, v) {
      var price;
      if (mode === 'markup') price = cost * (1 + v / 100);
      else if (mode === 'margin') { if (!(v < 100)) return null; price = cost / (1 - v / 100); }
      else price = v;
      if (!isFinite(price) || !isFinite(cost)) return null;
      var profit = price - cost;
      return { cost: cost, price: price, profit: profit, markup: cost ? profit / cost * 100 : NaN, margin: price ? profit / price * 100 : NaN };
    }

    // ---- ROI / break-even ----------------------------------------------------------------------------------
    function roi(cost, value, years) {
      if (!(cost > 0) || !isFinite(value)) return null;
      var gain = value - cost, out = { gain: gain, pct: gain / cost * 100, cagr: NaN };
      if (years > 0 && value >= 0) out.cagr = (Math.pow(value / cost, 1 / years) - 1) * 100;
      return out;
    }
    function breakEven(fixed, price, unitCost) {
      if (!(fixed >= 0) || !isFinite(price) || !isFinite(unitCost)) return null;
      var cm = price - unitCost;
      if (!(cm > 0)) return { cm: cm, cmPct: price ? cm / price * 100 : NaN, units: Infinity, whole: Infinity, revenue: Infinity };
      var units = fixed / cm, whole = Math.ceil(clean(units));
      return { cm: cm, cmPct: price ? cm / price * 100 : NaN, units: units, whole: whole, revenue: fixed / (cm / price) };
    }

    return {
      rnd: rnd, parseNum: parseNum, num: num, validCur: validCur, money: money, money0: money0, curSymbol: curSymbol,
      fmtNum: fmtNum, fmtPct: fmtPct, decimalComma: decimalComma, guessCur: guessCur, duration: duration, safeLocale: safeLocale,
      addMonths: addMonths, addPeriods: addPeriods, parseDate: parseDate, isoDate: isoDate,
      FREQS: FREQS, payment: payment, amortize: amortize, yearly: yearly,
      COMPS: COMPS, monthlyRate: monthlyRate, fv: fv, growthSeries: growthSeries, monthsToTarget: monthsToTarget,
      monthlyNeeded: monthlyNeeded, realValue: realValue,
      pctOf: pctOf, whatPct: whatPct, pctChange: pctChange, addPct: addPct, subPct: subPct, removePct: removePct, markupMargin: markupMargin,
      roi: roi, breakEven: breakEven,
    };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = Logic;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ======================================================================
  // Panel
  // ======================================================================
  var Cade = window.Cade;
  Cade.loadCSS('moneycalc.css');

  var L = Logic;
  var PANEL_ID = 'moneycalc-panel';
  var PREFS_KEY = 'cade-moneycalc-prefs';
  var MAX_YEARS = 50;
  var TABS = [['loan', 'Loan'], ['save', 'Savings'], ['pct', 'Percent'], ['roi', 'ROI']];
  var CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'HKD', 'SGD', 'INR', 'KRW', 'MXN', 'BRL', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'ILS', 'AED', 'ZAR'];
  var LOCALES = [['', 'Auto'], ['en-US', '1,234.56'], ['en-GB', '1,234.56 (UK)'], ['de-DE', '1.234,56'], ['fr-FR', '1 234,56'], ['de-CH', '1’234.56'], ['en-IN', '12,34,567.89']];
  var DEF = {
    tab: 'loan', cur: '', loc: '',
    loan: { kind: 'home', amt: '25,000', price: '375,000', down: '20%', rate: '6.5', term: '30', unit: 'y', freq: '12', start: '', extra: '' },
    save: { init: '10,000', monthly: '500', rate: '7', years: '20', comp: '12', infl: '', goal: '500k' },
    pct: { a1: '15', b1: '80', a2: '12', b2: '80', a3: '80', b3: '100', a4: '100', b4: '20', mc: '60', mm: 'price', mv: '100' },
    roi: { cost: '10,000', val: '14,500', yrs: '3', fixed: '12,000', price: '25', vc: '10' },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 1600); } catch (e) {} }

  // ---- prefs ----
  var P = null;
  function loadPrefs() {
    var raw = {};
    try { raw = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {}; } catch (e) { raw = {}; }
    P = { tab: typeof raw.tab === 'string' ? raw.tab : DEF.tab, cur: L.validCur(raw.cur) ? raw.cur : '', loc: typeof raw.loc === 'string' ? raw.loc.slice(0, 20) : '' };
    if (!TABS.some(function (t) { return t[0] === P.tab; })) P.tab = 'loan';
    ['loan', 'save', 'pct', 'roi'].forEach(function (t) {
      var src = raw[t] && typeof raw[t] === 'object' ? raw[t] : {}, d = DEF[t];
      P[t] = {};
      for (var k in d) P[t][k] = typeof src[k] === 'string' ? src[k].slice(0, 40) : d[k];
    });
  }
  // Written through at once: ~1 KB, and a phone may drop the page right after typing.
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(P)); } catch (e) {} }
  function loc() { return L.safeLocale(P.loc || (typeof navigator !== 'undefined' && navigator.language) || 'en-US'); }
  function cur() { return P.cur || L.guessCur(loc()); }
  function dc() { return L.decimalComma(loc()); }
  function n(s) { return L.num(s, dc()); }
  function pn(s) { return L.parseNum(s, dc()); }
  function m2(c) { return L.money(c, cur(), loc()); }
  function m0(v) { return L.money0(v, cur(), loc()); }
  function mf(v) { return L.money(L.rnd(v * 100), cur(), loc()); } // a float amount → "$1,234.57"
  function nm(v, d) { return L.fmtNum(v, loc(), d); }
  function pc(v, d) { return L.fmtPct(v, loc(), d); }

  var ui = null; // { panel, open: {year: true}, res: {}, headBtn, showSettings }
  function q(sel) { return ui ? ui.panel.querySelector(sel) : null; }
  function qa(sel) { return ui ? ui.panel.querySelectorAll(sel) : []; }

  function copyText(text) {
    var done = function () { toast('Copied', 'success', 1200); };
    var fail = function () { toast('Copy failed', 'error', 2000); };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { if (document.execCommand('copy')) done(); else fail(); } catch (e) { fail(); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
  // Insert at the cursor; a multi-line block goes on its own lines (blank line
  // before when the cursor follows text, so a table renders as a table).
  function insertText(text, block) {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
    var st = ed.state, sel = st.selection.main, doc = st.doc, ins = text;
    if (block) {
      var lf = doc.lineAt(sel.from), lt = doc.lineAt(sel.to);
      var before = lf.text.slice(0, sel.from - lf.from), after = lt.text.slice(sel.to - lt.from);
      var pre = before.trim() ? '\n\n' : (!before && lf.number > 1 && doc.line(lf.number - 1).text.trim() ? '\n' : '');
      ins = pre + text + (after.trim() ? '\n\n' : '\n');
    }
    ed.dispatch({ changes: { from: sel.from, to: sel.to, insert: ins }, selection: { anchor: sel.from + ins.length }, scrollIntoView: true, userEvent: 'input' });
    toast('Inserted into the note', 'success', 1200);
  }

  // ======================================================================
  // HTML
  // ======================================================================
  function field(tab, k, label, opts) {
    opts = opts || {};
    var pre = opts.pre ? '<span class="mc-pre">' + opts.pre + '</span>' : '';
    var suf = opts.suf ? '<span class="mc-suf">' + opts.suf + '</span>' : '';
    return '<label class="mc-f' + (opts.cls ? ' ' + opts.cls : '') + '"><span class="mc-fl">' + label + '</span>' +
      '<span class="mc-fi' + (opts.pre ? ' has-pre' : '') + (opts.suf ? ' has-suf' : '') + '">' + pre +
      '<input class="mc-in" type="text" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done" data-t="' + tab + '" data-k="' + k + '"' +
      (opts.ph ? ' placeholder="' + esc(opts.ph) + '"' : '') + ' aria-label="' + esc(opts.aria || label.replace(/<[^>]+>/g, '')) + '">' + suf + '</span>' +
      (opts.hint ? '<span class="mc-fh" data-hint="' + k + '">' + opts.hint + '</span>' : '') + '</label>';
  }
  function seg(tab, k, opts, cls) {
    return '<div class="mc-seg' + (cls ? ' ' + cls : '') + '" data-t="' + tab + '" data-seg="' + k + '" role="group">' + opts.map(function (o) {
      return '<button type="button" data-v="' + esc(o[0]) + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function select(tab, k, label, opts) {
    return '<label class="mc-f"><span class="mc-fl">' + label + '</span><select class="mc-in mc-sel" data-t="' + tab + '" data-k="' + k + '">' +
      opts.map(function (o) { return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>'; }).join('') + '</select></label>';
  }
  var CS = '<span class="mc-cs"></span>';
  function bodyHtml() {
    var tabs = TABS.map(function (t) { return '<button class="mc-tab" role="tab" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('');
    return '<div class="mc-settings" hidden></div><div class="mc-tabs" role="tablist">' + tabs + '</div><div class="mc-scroll">' +
      // ---- loan
      '<section class="mc-pane" data-pane="loan">' +
        seg('loan', 'kind', [['loan', 'Loan'], ['home', 'Mortgage']], 'mc-wide') +
        '<div class="mc-grid2 mc-k-home">' + field('loan', 'price', 'Home price', { pre: CS, ph: '375,000' }) +
          field('loan', 'down', 'Down payment', { pre: '', ph: '20% or 75k' }) + '</div>' +
        '<div class="mc-k-home mc-fh mc-downnote" data-out="down"></div>' +
        '<div class="mc-k-loan">' + field('loan', 'amt', 'Loan amount', { pre: CS, ph: '25,000' }) + '</div>' +
        '<div class="mc-grid2">' + field('loan', 'rate', 'Interest rate <small>APR</small>', { suf: '%', ph: '6.5', aria: 'Interest rate (APR)' }) +
          '<div class="mc-f"><span class="mc-fl">Term</span><span class="mc-fi mc-term">' +
            '<input class="mc-in" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" enterkeyhint="done" data-t="loan" data-k="term" placeholder="30" aria-label="Term">' +
            seg('loan', 'unit', [['y', 'yrs'], ['m', 'mos']], 'mc-mini') + '</span></div></div>' +
        '<div class="mc-grid2">' + select('loan', 'freq', 'Payments', L.FREQS.map(function (f) { return [String(f[0]), f[1]]; })) +
          '<label class="mc-f"><span class="mc-fl">First payment</span><input class="mc-in mc-date" type="date" data-t="loan" data-k="start" aria-label="First payment date"></label></div>' +
        field('loan', 'extra', '<span data-lbl="extra">Extra each month</span> <small>optional</small>', { pre: CS, ph: '0', aria: 'Extra payment' }) +
        '<div class="mc-out" data-out="loan" aria-live="polite"></div>' +
      '</section>' +
      // ---- savings
      '<section class="mc-pane" data-pane="save">' +
        '<div class="mc-grid2">' + field('save', 'init', 'Initial deposit', { pre: CS, ph: '0' }) + field('save', 'monthly', 'Monthly contribution', { pre: CS, ph: '0' }) + '</div>' +
        '<div class="mc-grid2">' + field('save', 'rate', 'Annual return', { suf: '%', ph: '7' }) + field('save', 'years', 'Years', { ph: '20' }) + '</div>' +
        '<div class="mc-grid2">' + select('save', 'comp', 'Compounding', L.COMPS.map(function (c) { return [String(c[0]), c[1]]; })) +
          field('save', 'infl', 'Inflation <small>optional</small>', { suf: '%', ph: '0', aria: 'Inflation per year' }) + '</div>' +
        '<div class="mc-out" data-out="save" aria-live="polite"></div>' +
        '<div class="mc-card mc-goal"><div class="mc-ch">Goal</div>' +
          field('save', 'goal', 'Target amount', { pre: CS, ph: '1m' }) +
          '<div data-out="goal" aria-live="polite"></div></div>' +
        '<p class="mc-note">Contributions are made at the end of each month. Interest compounds at the chosen frequency, credited monthly at the equivalent monthly rate. Returns aren\'t guaranteed — this is arithmetic, not a forecast.</p>' +
      '</section>' +
      // ---- percent
      '<section class="mc-pane" data-pane="pct">' +
        '<div class="mc-card"><div class="mc-ch">Percent of a number</div><div class="mc-sent">' +
          sIn('pct', 'a1', '15', 'Percent') + '<span>% of</span>' + sIn('pct', 'b1', '80', 'Number') + '</div><div data-out="p1"></div></div>' +
        '<div class="mc-card"><div class="mc-ch">What percent is it?</div><div class="mc-sent">' +
          sIn('pct', 'a2', '12', 'Part') + '<span>is what % of</span>' + sIn('pct', 'b2', '80', 'Whole') + '</div><div data-out="p2"></div></div>' +
        '<div class="mc-card"><div class="mc-ch">Percent change</div><div class="mc-sent"><span>from</span>' +
          sIn('pct', 'a3', '80', 'From') + '<span>to</span>' + sIn('pct', 'b3', '100', 'To') + '</div><div data-out="p3"></div></div>' +
        '<div class="mc-card"><div class="mc-ch">Add or remove a percent <small>VAT, sales tax, discounts</small></div><div class="mc-sent">' +
          sIn('pct', 'a4', '100', 'Amount') + '<span>and</span>' + sIn('pct', 'b4', '20', 'Percent') + '<span>%</span></div><div data-out="p4"></div></div>' +
        '<div class="mc-card"><div class="mc-ch">Markup vs margin</div>' +
          '<div class="mc-grid2">' + field('pct', 'mc', 'Cost', { pre: CS, ph: '60' }) +
          '<div class="mc-f"><span class="mc-fl">and</span>' + seg('pct', 'mm', [['price', 'Price'], ['markup', 'Markup %'], ['margin', 'Margin %']], 'mc-mini3') + '</div></div>' +
          field('pct', 'mv', '<span data-lbl="mv">Selling price</span>', { pre: '<span data-pre="mv"></span>', ph: '100', aria: 'Value' }) +
          '<div data-out="p5"></div>' +
          '<p class="mc-note">Markup is profit ÷ cost; margin is profit ÷ price. A 50% markup is a 33.3% margin.</p></div>' +
      '</section>' +
      // ---- roi
      '<section class="mc-pane" data-pane="roi">' +
        '<div class="mc-card"><div class="mc-ch">Return on investment</div>' +
          '<div class="mc-grid2">' + field('roi', 'cost', 'Invested', { pre: CS, ph: '10,000' }) + field('roi', 'val', 'Worth now / returned', { pre: CS, ph: '14,500' }) + '</div>' +
          field('roi', 'yrs', 'Years held <small>for the annual rate</small>', { ph: '3', aria: 'Years held' }) +
          '<div data-out="roi"></div></div>' +
        '<div class="mc-card"><div class="mc-ch">Break-even</div>' +
          field('roi', 'fixed', 'Fixed costs', { pre: CS, ph: '12,000' }) +
          '<div class="mc-grid2">' + field('roi', 'price', 'Price per unit', { pre: CS, ph: '25' }) + field('roi', 'vc', 'Cost per unit', { pre: CS, ph: '10' }) + '</div>' +
          '<div data-out="be"></div></div>' +
      '</section>' +
      '</div>' +
      '<button type="button" class="mc-sum" data-act="to-result" hidden aria-label="Show the result"></button>';
  }
  function sIn(tab, k, ph, aria) {
    return '<input class="mc-in mc-sin" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" enterkeyhint="done" data-t="' + tab + '" data-k="' + k + '" placeholder="' + esc(ph) + '" aria-label="' + esc(aria) + '">';
  }
  // A result line with copy / insert buttons; `ins` is the text both use.
  function resRow(label, value, ins, cls) {
    return '<div class="mc-res' + (cls ? ' ' + cls : '') + '" data-val="' + esc(ins || value) + '"><span class="mc-rk">' + esc(label) + '</span>' +
      '<b class="mc-rv">' + esc(value) + '</b><span class="mc-ra">' +
      '<button type="button" class="mc-ib" data-act="copy" title="Copy" aria-label="Copy">⧉</button>' +
      '<button type="button" class="mc-ib" data-act="ins" title="Insert into the note" aria-label="Insert into the note">↵</button></span></div>';
  }
  function kv(k, v, cls) { return '<div class="mc-kv' + (cls ? ' ' + cls : '') + '"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>'; }
  function acts(key, extra) {
    return '<div class="mc-acts">' + (extra || '') + '<button type="button" class="mc-btn" data-act="copy-' + key + '">Copy</button>' +
      '<button type="button" class="mc-btn primary" data-act="ins-' + key + '">Insert into note</button></div>';
  }
  function empty(msg) { return '<div class="mc-empty">' + esc(msg) + '</div>'; }

  // ======================================================================
  // Charts (inline SVG; colours from theme variables via CSS classes)
  // ======================================================================
  var VW = 300, VH = 120;
  // series: [{ cls, pts: [[x, y]], area }], xMax, yMax → { svg, xs }
  function chartHtml(id, series, xMax, yMax, xLabels, yLabel, legend) {
    var path = function (pts, area) {
      var d = '';
      for (var i = 0; i < pts.length; i++) {
        var x = (pts[i][0] / xMax * VW).toFixed(2), y = (VH - pts[i][1] / yMax * VH).toFixed(2);
        d += (i ? 'L' : 'M') + x + ' ' + y;
      }
      if (area && pts.length) d += 'L' + (pts[pts.length - 1][0] / xMax * VW).toFixed(2) + ' ' + VH + 'L' + (pts[0][0] / xMax * VW).toFixed(2) + ' ' + VH + 'Z';
      return d;
    };
    var g = '';
    for (var gl = 1; gl <= 3; gl++) g += '<line class="mc-grid" x1="0" x2="' + VW + '" y1="' + (VH * gl / 4) + '" y2="' + (VH * gl / 4) + '"/>';
    series.forEach(function (s) {
      if (s.area) g += '<path class="mc-area ' + s.cls + '" d="' + path(s.pts, true) + '"/>';
      g += '<path class="mc-line ' + s.cls + '" d="' + path(s.pts, false) + '"/>';
    });
    g += '<line class="mc-guide" x1="-10" x2="-10" y1="0" y2="' + VH + '"/>';
    return '<div class="mc-chart" data-chart="' + id + '">' +
      '<div class="mc-cap">' + legend + '</div>' +
      '<div class="mc-plot"><span class="mc-ymax">' + esc(yLabel) + '</span>' +
      '<svg viewBox="0 0 ' + VW + ' ' + VH + '" preserveAspectRatio="none" aria-hidden="true">' + g + '</svg></div>' +
      '<div class="mc-xl">' + xLabels.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</div></div>';
  }
  function legendItem(cls, label) { return '<span class="mc-lg ' + cls + '"><i></i>' + esc(label) + '</span>'; }
  // Hover / touch on a chart: a guide line + the values at that point in the caption.
  function chartPoint(e) {
    var ch = e.target.closest ? e.target.closest('.mc-chart') : null;
    if (!ch || !ui || !ui.hover) return;
    var h = ui.hover[ch.getAttribute('data-chart')];
    if (!h) return;
    var svg = ch.querySelector('svg'), r = svg.getBoundingClientRect();
    if (!r.width) return;
    var f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    var i = Math.round(f * (h.pts.length - 1)), x = (h.pts[i] / h.xMax * VW).toFixed(2);
    var gl = svg.querySelector('.mc-guide');
    gl.setAttribute('x1', x); gl.setAttribute('x2', x);
    ch.querySelector('.mc-cap').innerHTML = h.label(i);
  }
  function chartLeave(e) {
    var ch = e.target.closest ? e.target.closest('.mc-chart') : null;
    if (!ch || !ui || !ui.hover) return;
    var h = ui.hover[ch.getAttribute('data-chart')];
    if (!h) return;
    var gl = ch.querySelector('.mc-guide');
    gl.setAttribute('x1', -10); gl.setAttribute('x2', -10);
    ch.querySelector('.mc-cap').innerHTML = h.legend;
  }
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function short(v) {
    var a = Math.abs(v), s;
    if (a >= 1e9) s = nm(v / 1e9, 1) + 'B';
    else if (a >= 1e6) s = nm(v / 1e6, a >= 1e8 ? 0 : 1) + 'M';
    else if (a >= 1e3) s = nm(v / 1e3, a >= 1e5 ? 0 : 1) + 'k';
    else s = nm(v, 0);
    return L.curSymbol(cur(), loc()) + s;
  }

  // ======================================================================
  // Loan
  // ======================================================================
  function freqInfo(ppy) { for (var i = 0; i < L.FREQS.length; i++) if (L.FREQS[i][0] === ppy) return L.FREQS[i]; return L.FREQS[0]; }
  function defaultStart() { return L.addMonths(new Date(), 1); }
  function loanCalc() {
    var o = P.loan, ppy = +o.freq || 12, fi = freqInfo(ppy), principal, down = null, err = '';
    if (o.kind === 'home') {
      var price = n(o.price), dr = pn(o.down);
      if (!(price > 0)) err = 'Enter the home price';
      else {
        var dv = !o.down.trim() ? 0 : dr ? (dr.pct ? price * dr.v / 100 : dr.v) : NaN;
        if (!(dv >= 0)) err = 'The down payment isn\'t a number';
        else if (dv >= price) err = 'The down payment covers the whole price';
        else { down = { amt: dv, pct: dv / price * 100, price: price }; principal = price - dv; }
      }
    } else {
      principal = n(o.amt);
      if (!(principal > 0)) err = 'Enter the loan amount';
    }
    var rate = n(o.rate), term = n(o.term);
    if (!err && !(rate >= 0)) err = 'Enter the interest rate (0 is fine)';
    if (!err && rate > 100) err = 'That rate is over 100% a year';
    if (!err && !(term > 0)) err = 'Enter the term';
    var years = o.unit === 'm' ? term / 12 : term;
    if (!err && years > MAX_YEARS) err = 'Terms up to ' + MAX_YEARS + ' years';
    var count = Math.round(years * ppy);
    if (!err && count < 1) err = 'The term is shorter than one payment';
    var extra = o.extra.trim() ? n(o.extra) : 0;
    if (!err && !(extra >= 0)) err = 'The extra payment isn\'t a number';
    if (!err && principal > 1e12) err = 'That amount is too large';
    if (err) return { err: err, down: down };
    var cents = L.rnd(principal * 100), ex = L.rnd(extra * 100);
    var base = L.amortize({ principal: cents, rate: rate, n: count, ppy: ppy });
    var withEx = ex > 0 ? L.amortize({ principal: cents, rate: rate, n: count, ppy: ppy, extra: ex }) : null;
    var start = L.parseDate(o.start) || defaultStart();
    return { base: base, ex: withEx, extra: ex, rate: rate, years: years, ppy: ppy, fi: fi, start: start, down: down, principal: cents };
  }
  function dateLabel(d, ppy) {
    try {
      return ppy === 12 || ppy === 4 || ppy === 1 ? d.toLocaleDateString(loc(), { month: 'short', year: 'numeric' })
        : d.toLocaleDateString(loc(), { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) { return L.isoDate(d); }
  }
  function renderLoan() {
    var out = q('[data-out="loan"]');
    if (!out) return;
    var o = P.loan;
    qa('.mc-k-home').forEach(function (el) { el.hidden = o.kind !== 'home'; });
    qa('.mc-k-loan').forEach(function (el) { el.hidden = o.kind === 'home'; });
    var lbl = q('[data-lbl="extra"]');
    var R = loanCalc();
    var dn = q('[data-out="down"]');
    if (dn) dn.textContent = R.down ? 'Down ' + m2(L.rnd(R.down.amt * 100)) + ' (' + pc(R.down.pct, 1) + ') · loan ' + m2(L.rnd((R.down.price - R.down.amt) * 100)) : '';
    if (lbl) lbl.textContent = (+o.freq || 12) === 12 ? 'Extra each month' : 'Extra each payment';
    ui.res.loan = R.err ? null : R;
    if (R.err) { out.innerHTML = empty(R.err); ui.hover.loan = null; return; }
    var b = R.base, x = R.ex, fi = R.fi, ppy = R.ppy;
    var last = x || b;
    var payoff = L.addPeriods(R.start, last.count - 1, ppy), basePayoff = L.addPeriods(R.start, b.count - 1, ppy);
    var h = '<div class="mc-card mc-result">' +
      '<div class="mc-hero"><span class="mc-hv">' + esc(m2(b.pmt)) + '</span><span class="mc-hl">per ' + fi[2] + (x ? ' + ' + esc(m2(R.extra)) + ' extra' : '') + '</span></div>' +
      '<div class="mc-kvs">' +
        kv('Loan amount', m2(R.principal)) +
        kv('Total interest', m2(last.interest)) +
        kv('Total of payments', m2(last.paid)) +
        kv('Payoff', dateLabel(payoff, ppy) + ' · ' + last.count + (last.count === 1 ? ' payment' : ' payments')) +
        (last.last !== last.pmt + (x ? R.extra : 0) && last.count > 1 ? kv('Last payment', m2(last.last), 'faint') : '') +
      '</div>';
    if (x) {
      var savedP = b.count - x.count, months = Math.round(savedP * 12 / ppy);
      h += '<div class="mc-save">' +
        '<b>' + esc(L.duration(months)) + ' sooner</b> and <b>' + esc(m2(b.interest - x.interest)) + '</b> less interest than without the extra ' +
        '<span class="mc-faint">(' + esc(dateLabel(basePayoff, ppy)) + ', ' + b.count + ' payments, ' + esc(m2(b.interest)) + ' interest)</span></div>';
    }
    h += acts('loan', '<button type="button" class="mc-btn" data-act="ins-sched">Insert schedule</button>') + '</div>';
    // chart: balance by year
    var ys = L.yearly(last), ysB = x ? L.yearly(b) : ys;
    var toPts = function (yy) { var pts = [[0, R.principal / 100]]; yy.forEach(function (y, i) { pts.push([Math.min(i + 1, (y.to) / ppy), y.bal / 100]); }); return pts; };
    var ptsA = toPts(ys), ptsB = toPts(ysB), xMax = Math.max(ptsB[ptsB.length - 1][0], 1), yMax = niceMax(R.principal / 100);
    var series = [];
    if (x) series.push({ cls: 'c2', pts: ptsB, area: false });
    series.push({ cls: 'c1', pts: ptsA, area: true });
    var legend = legendItem('c1', x ? 'Balance with extra' : 'Balance') + (x ? legendItem('c2 dash', 'Without extra') : '');
    var yr0 = R.start.getFullYear();
    var xl = [String(yr0), String(yr0 + Math.round(xMax / 2)), String(yr0 + Math.round(xMax))];
    h += chartHtml('loan', series, xMax, yMax, xl, short(yMax), legend);
    ui.hover.loan = {
      legend: legend, xMax: xMax, pts: ptsB.map(function (p) { return p[0]; }),
      label: function (i) {
        var a = ptsA[Math.min(i, ptsA.length - 1)], bb = ptsB[i];
        return '<span class="mc-lg c1"><i></i>Year ' + (i) + ': ' + esc(m0(i < ptsA.length ? a[1] : 0)) + ' left</span>' +
          (x ? '<span class="mc-lg c2 dash"><i></i>' + esc(m0(bb[1])) + '</span>' : '');
      },
    };
    // schedule
    h += '<div class="mc-sched"><div class="mc-ch">Amortization schedule <small>tap a year for its payments</small></div>' +
      '<table class="mc-tbl"><thead><tr><th>Year</th><th>Principal' + (x ? '*' : '') + '</th><th>Interest</th><th>Balance</th></tr></thead><tbody>' +
      ys.map(function (y) {
        var op = !!ui.open[y.y];
        var rowsH = '<tr class="mc-yr' + (op ? ' open' : '') + '" data-year="' + y.y + '" tabindex="0" aria-expanded="' + op + '"><td><span class="mc-tw">▸</span>' + y.y + '</td><td>' + esc(m2(y.prin)) + '</td><td>' + esc(m2(y.int)) + '</td><td>' + esc(m2(y.bal)) + '</td></tr>';
        if (op) {
          for (var j = y.from; j < y.to; j++) {
            var rw = last.rows[j];
            rowsH += '<tr class="mc-mo"><td>' + esc(shortDate(L.addPeriods(R.start, j, ppy), ppy)) + '</td><td>' + esc(m2(rw.prin + rw.extra)) + '</td><td>' + esc(m2(rw.int)) + '</td><td>' + esc(m2(rw.bal)) + '</td></tr>';
          }
        }
        return rowsH;
      }).join('') + '</tbody></table>' +
      (x ? '<div class="mc-note">* Principal includes the extra payments.</div>' : '') + '</div>' +
      '<p class="mc-note">The rate is the nominal annual rate (APR), divided evenly over the payments. Payments are rounded to the cent; the last one absorbs the rounding. Taxes, insurance and fees aren\'t included.</p>';
    out.innerHTML = h;
  }
  function shortDate(d, ppy) {
    try { return ppy === 12 || ppy === 4 || ppy === 1 ? d.toLocaleDateString(loc(), { month: 'short', year: 'numeric' }) : d.toLocaleDateString(loc(), { day: 'numeric', month: 'short' }); }
    catch (e) { return L.isoDate(d); }
  }
  function loanTitle(R) {
    var yrs = P.loan.unit === 'm' ? n(P.loan.term) + ' months' : nm(R.years, 2) + (R.years === 1 ? ' year' : ' years');
    return (P.loan.kind === 'home' ? 'Mortgage' : 'Loan') + ' — ' + m2(R.principal) + ' at ' + pc(R.rate, 3) + ' for ' + yrs + ', ' + R.fi[1].toLowerCase();
  }
  function loanMarkdown(R) {
    var b = R.base, x = R.ex, last = x || b, ppy = R.ppy;
    var Lines = ['**' + loanTitle(R) + '**', '', '| Item | Amount |', '|---|---:|'];
    if (R.down) Lines.push('| Home price | ' + m2(L.rnd(R.down.price * 100)) + ' |', '| Down payment (' + pc(R.down.pct, 1) + ') | ' + m2(L.rnd(R.down.amt * 100)) + ' |');
    Lines.push('| Payment (per ' + R.fi[2] + ') | ' + m2(b.pmt) + ' |');
    if (x) Lines.push('| Extra per payment | ' + m2(R.extra) + ' |');
    Lines.push('| Payments | ' + last.count + ' (' + dateLabel(R.start, ppy) + ' – ' + dateLabel(L.addPeriods(R.start, last.count - 1, ppy), ppy) + ') |');
    Lines.push('| Total interest | ' + m2(last.interest) + ' |');
    Lines.push('| Total of payments | ' + m2(last.paid) + ' |');
    if (x) Lines.push('| Saved by the extra | ' + m2(b.interest - x.interest) + ' interest, ' + L.duration(Math.round((b.count - x.count) * 12 / ppy)) + ' sooner |');
    return Lines.join('\n');
  }
  function loanText(R) {
    var b = R.base, x = R.ex, last = x || b;
    return loanTitle(R) + ': ' + m2(b.pmt) + ' per ' + R.fi[2] + (x ? ' + ' + m2(R.extra) + ' extra' : '') + ', ' + last.count + ' payments, total interest ' +
      m2(last.interest) + ', paid off ' + dateLabel(L.addPeriods(R.start, last.count - 1, R.ppy), R.ppy) + '.';
  }
  function schedMarkdown(R) {
    var last = R.ex || R.base, ys = L.yearly(last);
    var Lines = ['**Amortization — ' + loanTitle(R) + '**', '', '| Year | Principal | Interest | Balance |', '|---:|---:|---:|---:|'];
    ys.forEach(function (y) { Lines.push('| ' + y.y + ' | ' + m2(y.prin) + ' | ' + m2(y.int) + ' | ' + m2(y.bal) + ' |'); });
    return Lines.join('\n');
  }

  // ======================================================================
  // Savings
  // ======================================================================
  function saveCalc() {
    var o = P.save;
    var init = o.init.trim() ? n(o.init) : 0, mon = o.monthly.trim() ? n(o.monthly) : 0, rate = n(o.rate), years = n(o.years), infl = o.infl.trim() ? n(o.infl) : 0;
    var comp = +o.comp;
    if (!(init >= 0)) return { err: 'The initial deposit isn\'t a number' };
    if (!(mon >= 0)) return { err: 'The monthly contribution isn\'t a number' };
    if (!(init > 0 || mon > 0)) return { err: 'Enter an initial deposit or a monthly contribution' };
    if (!isFinite(rate)) return { err: 'Enter the interest or return rate (0 is fine)' };
    if (rate <= -100 || rate > 100) return { err: 'Rates between −100% and 100% a year' };
    if (!(years > 0)) return { err: 'Enter the number of years' };
    if (years > 100) return { err: 'Up to 100 years' };
    if (!isFinite(infl) || infl <= -100) return { err: 'The inflation rate isn\'t a number' };
    var months = Math.max(1, Math.round(years * 12)), i = L.monthlyRate(rate, [0, 1, 2, 4, 12, 365].indexOf(comp) >= 0 ? comp : 12);
    var fvv = L.fv(init, mon, i, months), contrib = init + mon * months;
    return { init: init, mon: mon, rate: rate, years: years, months: months, i: i, fv: fvv, contrib: contrib, growth: fvv - contrib, infl: infl, real: L.realValue(fvv, infl, months), comp: comp };
  }
  function compLabel(c) { for (var i = 0; i < L.COMPS.length; i++) if (L.COMPS[i][0] === c) return L.COMPS[i][1]; return 'Monthly'; }
  function renderSave() {
    var out = q('[data-out="save"]');
    if (!out) return;
    var R = saveCalc();
    ui.res.save = R.err ? null : R;
    if (R.err) { out.innerHTML = empty(R.err); ui.hover.save = null; renderGoal(); return; }
    var effAnnual = (Math.pow(1 + R.i, 12) - 1) * 100;
    var h = '<div class="mc-card mc-result"><div class="mc-hero"><span class="mc-hv">' + esc(mf(R.fv)) + '</span><span class="mc-hl">after ' + esc(L.duration(R.months)) + '</span></div>' +
      '<div class="mc-split"><i class="c3" style="width:' + Math.max(0, Math.min(100, R.contrib / R.fv * 100)).toFixed(2) + '%"></i></div>' +
      '<div class="mc-kvs">' +
        kv('Contributions', mf(R.contrib) + (R.fv > 0 ? ' · ' + pc(R.contrib / R.fv * 100, 0) : ''), 'k3') +
        kv(R.growth >= 0 ? 'Growth' : 'Loss', mf(R.growth) + (R.fv > 0 && R.growth > 0 ? ' · ' + pc(R.growth / R.fv * 100, 0) : ''), 'k1') +
        (R.infl ? kv('In today\'s money', mf(R.real) + ' at ' + pc(R.infl, 2) + ' inflation') : '') +
        kv('Effective annual rate', pc(effAnnual, 3), 'faint') +
      '</div>' + acts('save') + '</div>';
    var pts = L.growthSeries(R.init, R.mon, R.i, R.months);
    var xMax = R.months / 12, yMax = niceMax(Math.max.apply(null, pts.map(function (p) { return Math.max(p.bal, p.contrib); })));
    var bal = pts.map(function (p) { return [p.m / 12, Math.max(0, p.bal)]; }), con = pts.map(function (p) { return [p.m / 12, p.contrib]; });
    var legend = legendItem('c1', 'Balance') + legendItem('c3', 'Contributions');
    var yr0 = new Date().getFullYear();
    h += chartHtml('save', [{ cls: 'c1', pts: bal, area: true }, { cls: 'c3', pts: con, area: true }], xMax, yMax,
      ['Now', 'Year ' + nm(Math.round(xMax / 2), 0), 'Year ' + nm(xMax, 1)], short(yMax), legend);
    ui.hover.save = {
      legend: legend, xMax: xMax, pts: pts.map(function (p) { return p.m / 12; }),
      label: function (k) {
        var p = pts[k];
        return '<span class="mc-lg c1"><i></i>' + esc(p.m ? L.duration(p.m) + ' (' + (yr0 + Math.ceil(p.m / 12)) + ')' : 'Now') + ': ' + esc(m0(p.bal)) + '</span>' +
          '<span class="mc-lg c3"><i></i>' + esc(m0(p.contrib)) + ' in</span>';
      },
    };
    h += '<details class="mc-det"' + (ui.open.saveTbl ? ' open' : '') + ' data-det="saveTbl"><summary>Year by year</summary>' +
      '<table class="mc-tbl"><thead><tr><th>Year</th><th>Contributed</th><th>Growth</th><th>Balance</th></tr></thead><tbody>' +
      pts.slice(1).map(function (p) {
        return '<tr><td>' + esc(p.m % 12 ? nm(p.m / 12, 2) : String(p.m / 12)) + '</td><td>' + esc(m0(p.contrib)) + '</td><td>' + esc(m0(p.growth)) + '</td><td>' + esc(m0(p.bal)) + '</td></tr>';
      }).join('') + '</tbody></table></details>';
    out.innerHTML = h;
    renderGoal();
  }
  function goalCalc(R) {
    var goal = n(P.save.goal);
    if (!P.save.goal.trim()) return { msg: 'Enter a target to see how long it takes.' };
    if (!(goal > 0)) return { msg: 'The target isn\'t a number.' };
    var o = { goal: goal };
    if (!R) return { msg: 'Fill in the savings above first.' };
    o.months = L.monthsToTarget(R.init, R.mon, R.i, goal);
    o.need = L.monthlyNeeded(R.init, R.i, R.months, goal);
    return o;
  }
  function renderGoal() {
    var out = q('[data-out="goal"]');
    if (!out) return;
    var R = ui.res.save, G = goalCalc(R);
    ui.res.goal = G.msg ? null : G;
    if (G.msg) { out.innerHTML = '<div class="mc-hint">' + esc(G.msg) + '</div>'; return; }
    var when = G.months === 0 ? 'Already there with the initial deposit' : !isFinite(G.months) ? 'Not within 100 years at this rate' :
      L.duration(G.months) + ' (' + dateLabel(L.addMonths(new Date(), G.months), 12) + ')';
    out.innerHTML = resRow('Time to reach ' + m0(G.goal), when, 'Time to reach ' + m0(G.goal) + ': ' + when) +
      resRow('Monthly needed for ' + L.duration(R.months), G.need > 0 ? mf(G.need) + ' / month' : 'Nothing more — ' + (R.init > 0 ? 'the deposit grows enough' : 'already there'),
        'To reach ' + m0(G.goal) + ' in ' + L.duration(R.months) + ' (' + mf(R.init) + ' initial, ' + pc(R.rate, 3) + '/yr): ' + (G.need > 0 ? mf(G.need) + ' a month' : 'no monthly contributions needed'));
  }
  function saveMarkdown(R) {
    var Lines = ['**Savings — ' + mf(R.init) + ' initial + ' + mf(R.mon) + '/month at ' + pc(R.rate, 3) + ' (' + compLabel(R.comp).toLowerCase() + ') for ' + L.duration(R.months) + '**', '',
      '| Item | Amount |', '|---|---:|',
      '| Future value | ' + mf(R.fv) + ' |', '| Contributions | ' + mf(R.contrib) + ' |', '| Growth | ' + mf(R.growth) + ' |'];
    if (R.infl) Lines.push('| In today\'s money (' + pc(R.infl, 2) + ' inflation) | ' + mf(R.real) + ' |');
    var G = ui.res.goal;
    if (G) {
      Lines.push('| Time to reach ' + m0(G.goal) + ' | ' + (G.months === 0 ? 'already there' : isFinite(G.months) ? L.duration(G.months) : 'over 100 years') + ' |');
      Lines.push('| Monthly needed for ' + m0(G.goal) + ' in ' + L.duration(R.months) + ' | ' + mf(G.need) + ' |');
    }
    Lines.push('', '_Contributions at the end of each month._');
    return Lines.join('\n');
  }
  function saveText(R) {
    return mf(R.init) + ' + ' + mf(R.mon) + '/month at ' + pc(R.rate, 3) + ' for ' + L.duration(R.months) + ' → ' + mf(R.fv) +
      ' (' + mf(R.contrib) + ' contributed, ' + mf(R.growth) + ' growth' + (R.infl ? '; ' + mf(R.real) + ' in today\'s money' : '') + ')';
  }

  // ======================================================================
  // Percent & ROI
  // ======================================================================
  function renderPct() {
    var o = P.pct, out;
    var a1 = n(o.a1), b1 = n(o.b1);
    out = q('[data-out="p1"]');
    if (out) out.innerHTML = isFinite(a1) && isFinite(b1) ? resRow(nm(a1) + '% of ' + nm(b1), nm(L.pctOf(a1, b1)), nm(a1) + '% of ' + nm(b1) + ' = ' + nm(L.pctOf(a1, b1)), 'main') : '';
    var a2 = n(o.a2), b2 = n(o.b2), w = L.whatPct(a2, b2);
    out = q('[data-out="p2"]');
    if (out) out.innerHTML = isFinite(a2) && isFinite(b2) ? (isFinite(w) ? resRow(nm(a2) + ' of ' + nm(b2), pc(w, 4), nm(a2) + ' is ' + pc(w, 4) + ' of ' + nm(b2), 'main') : empty('The whole can\'t be zero')) : '';
    var a3 = n(o.a3), b3 = n(o.b3), ch = L.pctChange(a3, b3);
    out = q('[data-out="p3"]');
    if (out) {
      if (!(isFinite(a3) && isFinite(b3))) out.innerHTML = '';
      else if (!isFinite(ch)) out.innerHTML = empty('A change from zero has no percentage');
      else {
        var word = ch > 0 ? 'increase' : ch < 0 ? 'decrease' : 'no change', diff = b3 - a3;
        out.innerHTML = resRow(word.charAt(0).toUpperCase() + word.slice(1), (ch > 0 ? '+' : '') + pc(ch, 4), nm(a3) + ' → ' + nm(b3) + ': ' + (ch > 0 ? '+' : '') + pc(ch, 4), 'main') +
          '<div class="mc-hint">Difference ' + esc((diff > 0 ? '+' : '') + nm(diff)) + (a3 > 0 && b3 > 0 ? ' · ' + esc(nm(b3 / a3, 4)) + '× the start' : '') + '</div>';
      }
    }
    var a4 = n(o.a4), b4 = n(o.b4);
    out = q('[data-out="p4"]');
    if (out) {
      if (!(isFinite(a4) && isFinite(b4))) out.innerHTML = '';
      else {
        var net = L.removePct(a4, b4);
        out.innerHTML = resRow('+ ' + pc(b4, 4), nm(L.addPct(a4, b4)), nm(a4) + ' + ' + pc(b4, 4) + ' = ' + nm(L.addPct(a4, b4))) +
          resRow('− ' + pc(b4, 4), nm(L.subPct(a4, b4)), nm(a4) + ' − ' + pc(b4, 4) + ' = ' + nm(L.subPct(a4, b4))) +
          (isFinite(net) ? resRow('Without the ' + pc(b4, 4) + ' included', nm(net), nm(a4) + ' including ' + pc(b4, 4) + ' = ' + nm(net) + ' + ' + nm(a4 - net)) +
            '<div class="mc-hint">' + esc(nm(a4)) + ' already including ' + esc(pc(b4, 4)) + ' (e.g. VAT) is ' + esc(nm(net)) + ' plus ' + esc(nm(a4 - net)) + '.</div>' : '');
      }
    }
    // markup / margin
    var mode = o.mm === 'markup' || o.mm === 'margin' ? o.mm : 'price';
    qa('[data-seg="mm"] button').forEach(function (bb) { bb.classList.toggle('on', bb.getAttribute('data-v') === mode); });
    var lb = q('[data-lbl="mv"]'), pre = q('[data-pre="mv"]');
    if (lb) lb.textContent = mode === 'price' ? 'Selling price' : mode === 'markup' ? 'Markup' : 'Margin';
    if (pre) pre.textContent = mode === 'price' ? L.curSymbol(cur(), loc()) : '%';
    if (pre) pre.parentNode.parentNode.classList.toggle('pct-pre', mode !== 'price');
    var c = n(o.mc), v = n(o.mv), mm = isFinite(c) && isFinite(v) ? L.markupMargin(c, mode, v) : null;
    out = q('[data-out="p5"]');
    if (out) {
      if (!(isFinite(c) && isFinite(v))) out.innerHTML = '';
      else if (!mm) out.innerHTML = empty('A margin must be under 100%');
      else out.innerHTML = resRow('Price', mf(mm.price), 'Price ' + mf(mm.price), mode === 'price' ? '' : 'main') +
        resRow('Profit', mf(mm.profit), 'Profit ' + mf(mm.profit) + ' on cost ' + mf(c)) +
        resRow('Markup', pc(mm.markup, 2), 'Markup ' + pc(mm.markup, 2), mode === 'markup' ? '' : 'main') +
        resRow('Margin', pc(mm.margin, 2), 'Margin ' + pc(mm.margin, 2), mode === 'margin' ? '' : 'main');
    }
  }
  function renderRoi() {
    var o = P.roi, out = q('[data-out="roi"]');
    var c = n(o.cost), v = n(o.val), y = o.yrs.trim() ? n(o.yrs) : NaN, r = L.roi(c, v, y);
    if (out) {
      if (!o.cost.trim() || !o.val.trim()) out.innerHTML = '';
      else if (!r) out.innerHTML = empty('The amount invested must be more than zero');
      else out.innerHTML = resRow(r.gain >= 0 ? 'Gain' : 'Loss', mf(r.gain), (r.gain >= 0 ? 'Gain ' : 'Loss ') + mf(r.gain)) +
        resRow('ROI', (r.pct > 0 ? '+' : '') + pc(r.pct, 2), 'ROI ' + (r.pct > 0 ? '+' : '') + pc(r.pct, 2) + ' (' + mf(c) + ' → ' + mf(v) + ')', 'main') +
        (isFinite(r.cagr) ? resRow('Per year (CAGR)', (r.cagr > 0 ? '+' : '') + pc(r.cagr, 2), 'Annualized return ' + pc(r.cagr, 2) + ' over ' + nm(y, 2) + ' years') :
          '<div class="mc-hint">Add the years held for the annualized rate.</div>');
    }
    var f = n(o.fixed), p = n(o.price), vc = n(o.vc), be = L.breakEven(f, p, vc);
    out = q('[data-out="be"]');
    if (out) {
      if (!o.fixed.trim() || !o.price.trim() || !o.vc.trim()) out.innerHTML = '';
      else if (!be) out.innerHTML = empty('Enter numbers for all three');
      else if (!isFinite(be.units)) out.innerHTML = empty('The price must be above the cost per unit to ever break even');
      else out.innerHTML = resRow('Units to break even', nm(be.whole, 0), 'Break-even: ' + nm(be.whole, 0) + ' units (' + mf(f) + ' fixed, ' + mf(p) + ' price, ' + mf(vc) + ' unit cost)', 'main') +
        resRow('Revenue at break-even', mf(be.revenue), 'Break-even revenue ' + mf(be.revenue)) +
        resRow('Contribution per unit', mf(be.cm) + ' · ' + pc(be.cmPct, 1), 'Contribution margin ' + mf(be.cm) + ' per unit (' + pc(be.cmPct, 1) + ')');
    }
  }

  // ======================================================================
  // Panel plumbing
  // ======================================================================
  function renderTab(t) {
    if (t === 'loan') renderLoan();
    else if (t === 'save') renderSave();
    else if (t === 'pct') renderPct();
    else renderRoi();
    updateSum();
  }
  // Phones: the result sits below the inputs — while it's out of view a bar at
  // the bottom of the panel shows the headline figure (tap → scroll to it).
  function updateSum() {
    if (!ui) return;
    var bar = q('.mc-sum'), sc = q('.mc-scroll');
    if (!bar || !sc) return;
    var R = P.tab === 'loan' ? ui.res.loan : P.tab === 'save' ? ui.res.save : null;
    var card = R ? q('[data-pane="' + P.tab + '"] .mc-result') : null, show = false;
    if (card) {
      var sr = sc.getBoundingClientRect();
      show = sr.height > 0 && card.getBoundingClientRect().top > sr.bottom - 56;
    }
    if (show) {
      if (P.tab === 'loan') {
        var last = R.ex || R.base;
        bar.innerHTML = '<b>' + esc(m2(R.base.pmt)) + '</b><span>/ ' + esc(R.fi[2]) + ' · ' + esc(m2(last.interest)) + ' interest</span><i aria-hidden="true">↓</i>';
      } else {
        bar.innerHTML = '<b>' + esc(mf(R.fv)) + '</b><span>after ' + esc(L.duration(R.months)) + '</span><i aria-hidden="true">↓</i>';
      }
    }
    bar.hidden = !show;
  }
  function onScroll() {
    if (!ui || ui.sumRaf) return;
    ui.sumRaf = requestAnimationFrame(function () { if (ui) { ui.sumRaf = 0; updateSum(); } });
  }
  function fillInputs() {
    qa('[data-t][data-k]').forEach(function (el) {
      var t = el.getAttribute('data-t'), k = el.getAttribute('data-k');
      if (P[t] && P[t][k] != null && document.activeElement !== el) el.value = P[t][k];
      if (k === 'start' && !P.loan.start) el.value = L.isoDate(defaultStart());
    });
    qa('[data-seg]').forEach(function (sg) {
      var t = sg.getAttribute('data-t'), k = sg.getAttribute('data-seg');
      sg.querySelectorAll('button').forEach(function (b) {
        var on = P[t] && P[t][k] === b.getAttribute('data-v');
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    });
    var sym = L.curSymbol(cur(), loc());
    qa('.mc-cs').forEach(function (s) { s.textContent = sym; });
    qa('.mc-fi.has-pre').forEach(function (f) { var pr = f.querySelector('.mc-pre'); f.classList.toggle('long-pre', !!pr && pr.textContent.length > 1); });
  }
  function showTab(t) {
    P.tab = TABS.some(function (x) { return x[0] === t; }) ? t : 'loan';
    qa('.mc-tab').forEach(function (b) {
      var on = b.getAttribute('data-tab') === P.tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    qa('.mc-pane').forEach(function (s) { s.hidden = s.getAttribute('data-pane') !== P.tab; });
    renderTab(P.tab);
    var sc = q('.mc-scroll'); if (sc) sc.scrollTop = 0;
    savePrefs();
  }
  function renderSettings() {
    var host = q('.mc-settings');
    if (!host) return;
    host.hidden = !ui.showSettings;
    if (!ui.showSettings) return;
    var c = cur(), list = CURRENCIES.slice();
    if (list.indexOf(c) < 0) list.unshift(c);
    host.innerHTML = '<div class="mc-grid2">' +
      '<label class="mc-f"><span class="mc-fl">Currency</span><select class="mc-in mc-sel" data-set="cur">' +
        list.map(function (x) { return '<option value="' + x + '"' + (x === c ? ' selected' : '') + '>' + x + ' · ' + esc(L.curSymbol(x, loc())) + '</option>'; }).join('') + '</select></label>' +
      '<label class="mc-f"><span class="mc-fl">Number format</span><select class="mc-in mc-sel" data-set="loc">' +
        LOCALES.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === P.loc ? ' selected' : '') + '>' + esc(o[0] ? o[1] : 'Auto (' + L.safeLocale(navigator.language) + ')') + '</option>'; }).join('') +
      '</select></label></div><div class="mc-hint">Fields accept 1,200.50 · 1.200,50 · 250k · 1.5m · 6.5%.</div>';
  }
  function onInput(e) {
    var t = e.target, tab = t.getAttribute('data-t'), k = t.getAttribute('data-k');
    if (!tab || !k || !P[tab]) return;
    P[tab][k] = String(t.value).slice(0, 40);
    if (t.tagName === 'INPUT' && t.type === 'text') t.classList.toggle('bad', !!t.value.trim() && !pn(t.value));
    if (tab === 'loan') ui.open = {};
    if (tab === 'save' && k === 'goal') renderGoal(); else renderTab(tab);
    savePrefs();
  }
  function onChange(e) {
    var t = e.target, k = t.getAttribute('data-set');
    if (k) {
      if (k === 'cur') P.cur = t.value; else P.loc = t.value;
      savePrefs(); syncHead(); renderSettings(); fillInputs(); renderTab(P.tab);
      return;
    }
    if (t.tagName === 'SELECT' || t.type === 'date') onInput(e);
  }
  function onClick(e) {
    var t = e.target && e.target.closest ? e.target : null, b;
    if (!t || !ui) return;
    if ((b = t.closest('.mc-tab'))) { showTab(b.getAttribute('data-tab')); return; }
    if ((b = t.closest('[data-seg] button'))) {
      var sg = b.parentNode, tab = sg.getAttribute('data-t'), k = sg.getAttribute('data-seg');
      P[tab][k] = b.getAttribute('data-v');
      sg.querySelectorAll('button').forEach(function (x) { var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      if (tab === 'loan') ui.open = {};
      renderTab(tab); savePrefs();
      return;
    }
    if ((b = t.closest('.mc-yr'))) { toggleYear(b); return; }
    if (!(b = t.closest('[data-act]')) || b.disabled) return;
    var act = b.getAttribute('data-act'), row;
    if (act === 'copy' || act === 'ins') {
      row = b.closest('[data-val]');
      if (!row) return;
      if (act === 'copy') copyText(row.getAttribute('data-val')); else insertText(row.getAttribute('data-val'), false);
      return;
    }
    var R;
    switch (act) {
      case 'head': ui.showSettings = !ui.showSettings; renderSettings(); updateSum(); break;
      case 'to-result': var rc = q('[data-pane="' + P.tab + '"] .mc-result'); if (rc) rc.scrollIntoView({ block: 'start', behavior: 'smooth' }); break;
      case 'copy-loan': if ((R = ui.res.loan)) copyText(loanText(R)); break;
      case 'ins-loan': if ((R = ui.res.loan)) insertText(loanMarkdown(R), true); break;
      case 'ins-sched': if ((R = ui.res.loan)) insertText(schedMarkdown(R), true); break;
      case 'copy-save': if ((R = ui.res.save)) copyText(saveText(R)); break;
      case 'ins-save': if ((R = ui.res.save)) insertText(saveMarkdown(R), true); break;
    }
  }
  function toggleYear(tr) {
    var y = +tr.getAttribute('data-year');
    ui.open[y] = !ui.open[y];
    var sc = q('.mc-scroll'), top = sc ? sc.scrollTop : 0;
    renderLoan();
    if (sc) sc.scrollTop = top;
    var again = q('.mc-yr[data-year="' + y + '"]');
    if (again && document.activeElement === document.body) { try { again.focus({ preventScroll: true }); } catch (e2) {} }
  }
  function onKey(e) {
    if (!ui) return;
    var t = e.target;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (ui.showSettings) { ui.showSettings = false; renderSettings(); } else close();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && t && t.classList && t.classList.contains('mc-yr')) { e.preventDefault(); toggleYear(t); return; }
    if (e.key === 'Enter' && t && t.tagName === 'INPUT') { e.preventDefault(); t.blur(); }
  }
  // Fields whose unit is already a percent (a "%" suffix or "…% of" after them).
  var PCT_FIELDS = { 'loan.rate': 1, 'save.rate': 1, 'save.infl': 1, 'pct.a1': 1, 'pct.b4': 1 };
  function onFocusOut(e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('mc-in') || t.tagName !== 'INPUT' || t.type !== 'text') return;
    if (!t.value.trim() || pn(t.value)) t.classList.remove('bad');
    var tab = t.getAttribute('data-t'), k = t.getAttribute('data-k');
    var isPct = PCT_FIELDS[tab + '.' + k] || (tab === 'pct' && k === 'mv' && P.pct.mm !== 'price');
    // "6.5%" → "6.5": the field already says %
    if (isPct && /%\s*$/.test(t.value) && pn(t.value)) {
      t.value = P[tab][k] = t.value.replace(/\s*%\s*$/, '');
      savePrefs();
    }
  }
  function syncHead() { if (ui && ui.headBtn) ui.headBtn.textContent = cur(); }

  function close() {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    p.remove();
    if (p._onClose) p._onClose();
  }
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    loadPrefs();
    var p = Cade.mkPanel(PANEL_ID, '💰 Money Calculator', bodyHtml());
    ui = { panel: p, open: {}, res: {}, hover: {}, headBtn: null, showSettings: false, sumRaf: 0 };
    var hb = document.createElement('button');
    hb.type = 'button';
    hb.className = 'mc-hbtn';
    hb.setAttribute('data-act', 'head');
    hb.title = 'Currency and number format';
    hb.setAttribute('aria-label', 'Currency and number format');
    var head = p.querySelector('.cade-panel-head');
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); }); // a button, not a drag handle
    ui.headBtn = hb;
    syncHead();
    p.addEventListener('input', onInput);
    p.addEventListener('change', onChange);
    p.addEventListener('click', onClick);
    p.addEventListener('keydown', onKey);
    p.addEventListener('focusout', onFocusOut);
    p.querySelector('.mc-scroll').addEventListener('scroll', onScroll, { passive: true });
    p.addEventListener('cade-panel-restore', function () { updateSum(); });
    p.addEventListener('pointermove', chartPoint);
    p.addEventListener('pointerdown', chartPoint);
    p.addEventListener('pointerout', function (e) {
      var ch = e.target.closest ? e.target.closest('.mc-chart') : null;
      if (ch && !(e.relatedTarget && ch.contains(e.relatedTarget))) chartLeave(e);
    });
    p.addEventListener('toggle', function (e) {
      var d = e.target;
      if (ui && d.getAttribute && d.getAttribute('data-det')) ui.open[d.getAttribute('data-det')] = d.open;
    }, true);
    var st = ui;
    p._onClose = function () {
      if (st.sumRaf) cancelAnimationFrame(st.sumRaf);
      savePrefs();
      if (ui === st) ui = null;
    };
    fillInputs();
    showTab(P.tab);
  }

  Cade.registerWidget({
    name: 'Money Calculator',
    description: 'Loan & mortgage payments with amortization, savings growth and goals, percentages, markup vs margin, ROI and break-even',
    icon: '💰',
    tags: 'money,finance,calculator,loan,mortgage,payment,amortization,interest,apr,rate,extra payment,payoff,savings,compound interest,investment,future value,retirement,goal,inflation,percent,percentage,percent change,vat,sales tax,discount,markup,margin,roi,return,cagr,break even,profit',
    open: open,
    close: close,
    _lib: Logic,
  });
})();
