/* Split the Bill — one restaurant bill, or the shared costs of a trip / a flat.
 *
 *  Quick split: bill, tip (chips or a custom %), optional tax (a % or an
 *    amount; the tip on the pre-tax or on the taxed amount), number of people,
 *    round each share up (to 0.50 / 1), and uneven splits: items one person
 *    had alone (the steak) are theirs; tax and tip are spread in proportion to
 *    what each person ordered.
 *  Groups: named groups with members; expenses split equally among the
 *    selected members, by exact amounts, by shares or by percentages; running
 *    balances; the fewest settle-up payments ("Ana pays Ben $23.40"); a
 *    payment marked settled is recorded (and can be undone).
 *
 * Money is integer minor units everywhere (cents; whole yen for JPY …).
 * Splits use the largest-remainder method so the parts always add up to the
 * whole; the odd cents go round the participants in a rotation keyed by the
 * expense id — deterministic on every device, and nobody always pays the
 * extra penny. Balances therefore sum to exactly zero. Settle-up: the members
 * with a balance are first partitioned into the largest number of sub-groups
 * that settle among themselves (exact search up to 15 people), then each
 * sub-group is settled greedily, biggest debtor → biggest creditor (min cash
 * flow). That is the fewest possible transfers, never more than people − 1.
 *
 * Storage: groups live in Cade.syncedBlob('splitbill') (synced across the
 * account's devices, whole-blob last-write-wins, normalized defensively on
 * every read); prefs and the last quick-split inputs in Cade.store
 * ('cade-splitbill-prefs'). Blob shape:
 *   { v: 1, groups: [ { id, name, cur: 'USD', dg: 2 (currency digits), c: created ms, u: updated ms,
 *       members: [ { id, name } ],
 *       ex:  [ { id, d: description, a: amount (minor units > 0), p: payer id,
 *                m: 'eq' | 'ex' | 'sh' | 'pc', s: { memberId: 1 | minor units | shares | percent }, t: ms } ],
 *       pay: [ { id, f: from id, to: to id, a: amount, t: ms } ] } ] }
 *
 * Nothing runs until the panel opens (the synced blob is attached the first
 * time the Groups tab shows); there are no timers, and every listener lives
 * on the panel and goes with it (the one animation frame, for the phone
 * result bar, is cancelled on close). The DOM-free logic below is exported
 * for node: splitbill.test.js. Self-contained IIFE, ES5. */
(function () {
  'use strict';

  // ======================================================================
  // Pure logic (no DOM)
  // ======================================================================
  var Logic = (function () {
    var MAX_MINOR = 1e11;          // 1 billion in a 2-digit currency — sanity cap for any amount
    var MAX_PEOPLE = 50;
    var MAX_ITEMS = 1000;         // expenses (and payments) per group — keeps the synced blob small
    var MULT = { k: 1e3, m: 1e6, mm: 1e6, b: 1e9, bn: 1e9 };

    function clean(x) { return Number(x.toPrecision(15)); }
    // Round half away from zero, after shaving binary noise (1.005 * 100 → 100.5 → 101).
    function rnd(x) {
      if (typeof x !== 'number' || !isFinite(x)) return NaN;
      var a = Math.round(clean(Math.abs(x)));
      return x < 0 ? -a : a;
    }
    function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
    function fill(n, v) { var a = []; for (var i = 0; i < n; i++) a.push(v); return a; }

    // ---- input parsing ------------------------------------------------------------
    // "1,200.50", "1.200,50", "$12", "12 €", "250k", "1.5m", "6.5%", "−3" → { v, pct } | null.
    // A lone separator: the locale's decimal mark is decimal; the other one is a
    // thousands group when exactly 3 digits follow ("1,200" = 1200 in en), else
    // decimal ("12,5" = 12.5).
    function groupedOk(intPart, sep) {
      return new RegExp('^\\d{1,3}(?:\\' + sep + '\\d{3})+$').test(intPart);
    }
    function parseNum(input, decComma) {
      if (typeof input === 'number') return isFinite(input) ? { v: input, pct: false } : null;
      var s = String(input == null ? '' : input).trim();
      if (!s) return null;
      s = s.replace(/[\u2212\u2012\u2013\u2014\uFE63\uFF0D]/g, '-').replace(/[\s\u00a0\u202f\u2009\u2007'\u2019_]/g, '');
      var neg = false, pct = false;
      if (s.charAt(0) === '+') s = s.slice(1);
      if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
      s = s.replace(/^(?:[A-Z]{3}|R\$|[$\u20ac\u00a3\u00a5\u20b9\u20a9\u20bd\u20ba\u20aa\u0e3f\u20ab\u20b1\u00a2\u20a3\u20b4\u20a6])/, '');
      if (s.charAt(0) === '-') { neg = !neg; s = s.slice(1); }
      s = s.replace(/(?:[A-Z]{3}|kr|z\u0142|[$\u20ac\u00a3\u00a5\u20b9\u20a9\u20bd\u20ba\u20aa\u0e3f\u20ab\u20b1\u00a2])$/, '');
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
    // A typed amount → integer minor units (scale = 10^digits). NaN when not a number.
    function toMinor(v, scale) { return typeof v === 'number' && isFinite(v) ? rnd(v * scale) : NaN; }

    // ---- currency ---------------------------------------------------------------------
    var digCache = {};
    function validCur(c) {
      if (!/^[A-Z]{3}$/.test(String(c || ''))) return false;
      try { new Intl.NumberFormat('en', { style: 'currency', currency: c }); return true; } catch (e) { return false; }
    }
    function curDigits(cur) {
      if (digCache[cur] != null) return digCache[cur];
      var d = 2;
      try { d = new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch (e) { d = 2; }
      if (!(d >= 0 && d <= 3)) d = 2;
      digCache[cur] = d;
      return d;
    }
    var REGION_CUR = {
      US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', IN: 'INR', JP: 'JPY', CN: 'CNY', KR: 'KRW', BR: 'BRL', MX: 'MXN',
      CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', ZA: 'ZAR', SG: 'SGD', HK: 'HKD', TW: 'TWD',
      TH: 'THB', PH: 'PHP', ID: 'IDR', MY: 'MYR', TR: 'TRY', IL: 'ILS', AE: 'AED', SA: 'SAR', AR: 'ARS', CL: 'CLP', CO: 'COP',
      PE: 'PEN', IS: 'ISK', RO: 'RON', UA: 'UAH', VN: 'VND', EG: 'EGP', NG: 'NGN',
      DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', IE: 'EUR', FI: 'EUR', GR: 'EUR',
      SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', LU: 'EUR', MT: 'EUR', CY: 'EUR', HR: 'EUR',
    };
    var LANG_CUR = { ja: 'JPY', ko: 'KRW', zh: 'CNY', de: 'EUR', fr: 'EUR', es: 'EUR', it: 'EUR', nl: 'EUR', pt: 'EUR', fi: 'EUR', el: 'EUR', sv: 'SEK', nb: 'NOK', no: 'NOK', da: 'DKK', pl: 'PLN', cs: 'CZK', hu: 'HUF', tr: 'TRY', he: 'ILS', hi: 'INR', th: 'THB', vi: 'VND', uk: 'UAH', ro: 'RON', is: 'ISK' };
    function guessCur(loc) {
      var m = /^([a-z]{2,3})(?:[-_][A-Za-z]{4})?(?:[-_]([A-Z]{2}))?/i.exec(String(loc || ''));
      if (!m) return 'USD';
      if (m[2] && REGION_CUR[m[2].toUpperCase()]) return REGION_CUR[m[2].toUpperCase()];
      return LANG_CUR[m[1].toLowerCase()] || 'USD';
    }
    var fmtCache = {};
    function moneyFmt(cur, loc) {
      var key = (loc || '') + '|' + cur, f = fmtCache[key];
      if (f) return f;
      var d = curDigits(cur);
      try { f = new Intl.NumberFormat(loc || undefined, { style: 'currency', currency: cur, minimumFractionDigits: d, maximumFractionDigits: d }); }
      catch (e) { f = new Intl.NumberFormat('en-US', { style: 'currency', currency: validCur(cur) ? cur : 'USD' }); }
      fmtCache[key] = f;
      return f;
    }
    // minor units → "$1,234.50" ("−$3.00" with a real minus sign).
    function money(minor, cur, loc) {
      if (typeof minor !== 'number' || !isFinite(minor)) return '—';
      var s = moneyFmt(cur, loc).format(Math.abs(minor) / Math.pow(10, curDigits(cur)));
      return minor < 0 ? '\u2212' + s : s;
    }
    function curSymbol(cur, loc) {
      try {
        var parts = moneyFmt(cur, loc).formatToParts(1);
        for (var i = 0; i < parts.length; i++) if (parts[i].type === 'currency') return parts[i].value;
      } catch (e) {}
      return cur;
    }
    var decCache = {};
    function decimalComma(loc) {
      var k = loc || '';
      if (decCache[k] == null) {
        try { decCache[k] = new Intl.NumberFormat(loc || undefined).format(1.5).indexOf(',') >= 0; } catch (e) { decCache[k] = false; }
      }
      return decCache[k];
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
    function fmtPct(p, loc) {
      if (!isFinite(p)) return '—';
      try { return new Intl.NumberFormat(loc || undefined, { maximumFractionDigits: 3 }).format(p) + '%'; } catch (e) { return String(Math.round(p * 1000) / 1000) + '%'; }
    }

    // ---- allocation -----------------------------------------------------------------------
    // Split integer `total` into parts proportional to `weights` (largest
    // remainder). Parts are integers summing exactly to total. Ties for the
    // leftover units go round from index `offset` (deterministic).
    function allocate(total, weights, offset) {
      var n = weights.length, i;
      if (!n) return [];
      total = Math.round(total) || 0;
      var sign = total < 0 ? -1 : 1, T = Math.abs(total);
      // Integer weights (shares like 1.5 or 33.33% → scaled) keep the maths exact.
      var k = 1;
      while (k < 1e6) {
        var allInt = true;
        for (i = 0; i < n; i++) { var w0 = Math.max(0, +weights[i] || 0); if (Math.abs(w0 * k - Math.round(w0 * k)) > 1e-7) { allInt = false; break; } }
        if (allInt) break;
        k *= 10;
      }
      var iw = [], W = 0;
      for (i = 0; i < n; i++) { var w = Math.max(0, Math.round((+weights[i] || 0) * k)); iw.push(w); W += w; }
      if (W === 0) { iw = fill(n, 1); W = n; }
      var base = [], rem = [], used = 0, exact = T * W <= 9e15;
      for (i = 0; i < n; i++) {
        var b, r;
        if (exact) { b = Math.floor(T * iw[i] / W); r = T * iw[i] - b * W; }
        else { var x = T * iw[i] / W; b = Math.floor(x); r = x - b; }
        base.push(b); rem.push(r); used += b;
      }
      var left = T - used;
      if (left > 0) {
        offset = ((Math.floor(offset) || 0) % n + n) % n;
        var order = [];
        for (i = 0; i < n; i++) if (iw[i] > 0) order.push(i);
        order.sort(function (a, c) {
          if (rem[c] !== rem[a]) return rem[c] - rem[a];
          return ((a - offset + n) % n) - ((c - offset + n) % n);
        });
        for (i = 0; i < left; i++) base[order[i % order.length]]++;
      }
      if (sign < 0) for (i = 0; i < n; i++) base[i] = -base[i];
      return base;
    }
    // FNV-1a — a stable small hash for the odd-cent rotation.
    function hashStr(s) {
      s = String(s || '');
      var h = 0x811c9dc5;
      for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      return h >>> 0;
    }

    // ---- quick split ------------------------------------------------------------------------
    // o: { bill (minor), tipPct, tax (percent number or minor units), taxMode 'pct'|'amt',
    //      tipOn 'pre'|'post', people, step (round-up step in minor units, 0 = exact),
    //      extras: [ { p: person index, amt: minor } ] }
    function quickSplit(o) {
      var n = Math.max(1, Math.min(MAX_PEOPLE, Math.floor(+o.people) || 1));
      var bill = o.bill;
      if (typeof bill !== 'number' || !isFinite(bill) || bill < 0) return { err: 'Enter the bill amount' };
      if (bill > MAX_MINOR) return { err: 'That bill is too large' };
      var perExtra = fill(n, 0), exSum = 0, i;
      (o.extras || []).forEach(function (x) {
        if (x && x.amt > 0 && x.p >= 0 && x.p < n) { perExtra[x.p] += x.amt; exSum += x.amt; }
      });
      if (exSum > bill) return { err: 'The extra items add up to more than the bill' };
      var tax = 0, taxPct = null;
      if (o.taxMode === 'amt') tax = o.tax > 0 ? Math.round(o.tax) : 0;
      else if (o.tax > 0) { taxPct = o.tax; tax = rnd(bill * o.tax / 100); }
      var tipPct = o.tipPct > 0 ? o.tipPct : 0;
      var tipBase = o.tipOn === 'post' ? bill + tax : bill;
      var tip = rnd(tipBase * tipPct / 100);
      var total = bill + tax + tip;
      // What each person ordered: an equal part of the shared items plus their own.
      var equal = allocate(bill - exSum, fill(n, 1), 0), base = [], w = [];
      for (i = 0; i < n; i++) {
        base.push(equal[i] + perExtra[i]);
        w.push((bill - exSum) + n * perExtra[i]); // = n × (shared / n + extra), exact — no penny artefacts
      }
      // The total (with tax and tip) follows those proportions; an even split stays within 1 cent.
      var shares = allocate(total, w, 0);
      var step = o.step > 0 ? Math.round(o.step) : 0;
      var rounded = shares.map(function (s) { return step ? Math.ceil(s / step) * step : s; });
      var collected = sum(rounded);
      return {
        n: n, bill: bill, tax: tax, taxPct: taxPct, tip: tip, tipPct: tipPct, tipBase: tipBase, total: total,
        extras: perExtra, exSum: exSum, base: base, shares: shares, rounded: rounded, step: step,
        collected: collected, surplus: collected - total,
        effTipPct: tipBase > 0 ? (tip + collected - total) / tipBase * 100 : 0,
        uneven: exSum > 0,
      };
    }

    // ---- groups ------------------------------------------------------------------------------
    var MODES = ['eq', 'ex', 'sh', 'pc'];
    // How expense e divides among the group's members → { memberId: minor units } (sums to e.a).
    function expenseShares(e, memberIds) {
      var ids = [], w = [], i;
      for (i = 0; i < memberIds.length; i++) {
        var id = memberIds[i], v = e.s ? +e.s[id] : 0;
        if (!(v > 0)) continue;
        ids.push(id); w.push(e.m === 'eq' ? 1 : v);
      }
      if (!ids.length) { ids = memberIds.slice(); w = fill(ids.length, 1); }
      if (!ids.length) return {};
      var alloc;
      var exactOk = e.m === 'ex' && sum(w) === e.a && w.every(function (x) { return x === Math.round(x); });
      if (exactOk) alloc = w.slice();
      else alloc = allocate(e.a, w, hashStr(e.id) % ids.length);
      var out = {};
      for (i = 0; i < ids.length; i++) out[ids[i]] = alloc[i];
      return out;
    }
    // Per member: paid, share (what they consumed), sent / received settle-up
    // payments and the balance (+ is owed money, − owes). Balances sum to 0.
    function balances(g) {
      var idx = {}, ids = [];
      var rows = g.members.map(function (m, i) { idx[m.id] = i; ids.push(m.id); return { id: m.id, name: m.name, paid: 0, share: 0, sent: 0, recv: 0, bal: 0 }; });
      g.ex.forEach(function (e) {
        if (!(e.p in idx)) return;
        rows[idx[e.p]].paid += e.a;
        var sh = expenseShares(e, ids);
        for (var id in sh) if (id in idx) rows[idx[id]].share += sh[id];
      });
      g.pay.forEach(function (p) {
        if (!(p.f in idx) || !(p.to in idx)) return;
        rows[idx[p.f]].sent += p.a; rows[idx[p.to]].recv += p.a;
      });
      rows.forEach(function (r) { r.bal = r.paid - r.share + r.sent - r.recv; });
      return rows;
    }
    // Greedy min cash flow inside one zero-sum set: the biggest debtor pays the
    // biggest creditor (ties by member order) until everyone is square.
    function greedy(list, out) {
      var cred = [], debt = [], i;
      for (i = 0; i < list.length; i++) {
        if (list[i].b > 0) cred.push({ id: list[i].id, o: list[i].o, b: list[i].b });
        else if (list[i].b < 0) debt.push({ id: list[i].id, o: list[i].o, b: -list[i].b });
      }
      var by = function (a, c) { return c.b - a.b || a.o - c.o; };
      var guard = 0;
      while (cred.length && debt.length && guard++ < 10000) {
        cred.sort(by); debt.sort(by);
        var c = cred[0], d = debt[0], x = Math.min(c.b, d.b);
        out.push({ from: d.id, to: c.id, amt: x });
        c.b -= x; d.b -= x;
        if (!c.b) cred.shift();
        if (!d.b) debt.shift();
      }
    }
    // The members with a balance, split into the MOST sets that each sum to
    // zero (each set of k people settles in k − 1 transfers, so more sets =
    // fewer transfers). Bitmask DP, exact for up to MAX_EXACT people.
    var MAX_EXACT = 15;
    function zeroSumSets(list) {
      var n = list.length, N = 1 << n, i, mask;
      var tot = new Array(N), dp = new Int8Array(N);
      tot[0] = 0;
      for (mask = 1; mask < N; mask++) {
        var low = mask & -mask, bi = 31 - Math.clz32(low);
        tot[mask] = tot[mask ^ low] + list[bi].b;
      }
      for (mask = 1; mask < N; mask++) {
        var best = 0;
        for (i = 0; i < n; i++) if (mask & (1 << i)) { var v = dp[mask ^ (1 << i)]; if (v > best) best = v; }
        dp[mask] = best + (tot[mask] === 0 ? 1 : 0);
      }
      var sets = [], cur = [];
      mask = N - 1;
      while (mask) {
        var pick = -1, pv = -1;
        for (i = 0; i < n; i++) if (mask & (1 << i)) { var w = dp[mask ^ (1 << i)]; if (w > pv) { pv = w; pick = i; } }
        cur.push(list[pick]);
        mask ^= 1 << pick;
        if (tot[mask] === 0) { sets.push(cur); cur = []; }
      }
      if (cur.length) sets.push(cur);
      return sets;
    }
    // rows: [{ id, bal }] in member order → [{ from, to, amt }] (amt > 0).
    function settleUp(rows) {
      var list = [], i;
      for (i = 0; i < rows.length; i++) if (rows[i].bal) list.push({ id: rows[i].id, o: i, b: rows[i].bal });
      if (!list.length) return [];
      var sets = list.length <= MAX_EXACT ? zeroSumSets(list) : [list];
      var out = [];
      sets.forEach(function (s) { greedy(s, out); });
      var ord = {};
      rows.forEach(function (r, j) { ord[r.id] = j; });
      out.sort(function (a, b) { return ord[a.from] - ord[b.from] || b.amt - a.amt || ord[a.to] - ord[b.to]; });
      return out;
    }

    // ---- synced data: defensive normalization -----------------------------------------------------
    function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
    function okId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(id); }
    function str(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
    function intIn(v, lo, hi) { v = +v; return isFinite(v) && v === Math.round(v) && v >= lo && v <= hi ? v : null; }
    function normGroup(g, seen) {
      if (!g || typeof g !== 'object') return null;
      var id = okId(g.id) && !seen[g.id] ? g.id : genId();
      seen[id] = 1;
      var cur = validCur(g.cur) ? g.cur : 'USD';
      var dg = intIn(g.dg, 0, 3);
      if (dg == null) dg = curDigits(cur);
      var out = { id: id, name: str(g.name, 60) || 'Group', cur: cur, dg: dg, c: +g.c || 0, u: +g.u || 0, members: [], ex: [], pay: [] };
      var mseen = {};
      (Array.isArray(g.members) ? g.members : []).forEach(function (m) {
        if (!m || out.members.length >= MAX_PEOPLE) return;
        var mid = okId(m.id) && !mseen[m.id] ? m.id : null;
        if (!mid) return;
        mseen[mid] = 1;
        out.members.push({ id: mid, name: str(m.name, 40) || 'Member' });
      });
      var eseen = {};
      (Array.isArray(g.ex) ? g.ex : []).forEach(function (e) {
        if (!e || typeof e !== 'object' || out.ex.length >= MAX_ITEMS) return;
        var a = intIn(e.a, 1, MAX_MINOR);
        if (a == null || !mseen[e.p]) return;
        var eid = okId(e.id) && !eseen[e.id] ? e.id : genId();
        eseen[eid] = 1;
        var mode = MODES.indexOf(e.m) >= 0 ? e.m : 'eq';
        var s = {}, any = false;
        if (e.s && typeof e.s === 'object') {
          for (var k in e.s) {
            if (!Object.prototype.hasOwnProperty.call(e.s, k) || !mseen[k]) continue;
            var v = +e.s[k];
            if (!(isFinite(v) && v > 0 && v <= MAX_MINOR)) continue;
            s[k] = mode === 'eq' ? 1 : mode === 'ex' ? Math.round(v) : v;
            any = true;
          }
        }
        if (!any) { mode = 'eq'; out.members.forEach(function (m) { s[m.id] = 1; }); }
        out.ex.push({ id: eid, d: str(e.d, 80), a: a, p: e.p, m: mode, s: s, t: +e.t || 0 });
      });
      var pseen = {};
      (Array.isArray(g.pay) ? g.pay : []).forEach(function (p) {
        if (!p || typeof p !== 'object' || out.pay.length >= MAX_ITEMS) return;
        var a = intIn(p.a, 1, MAX_MINOR);
        if (a == null || !mseen[p.f] || !mseen[p.to] || p.f === p.to) return;
        var pid = okId(p.id) && !pseen[p.id] ? p.id : genId();
        pseen[pid] = 1;
        out.pay.push({ id: pid, f: p.f, to: p.to, a: a, t: +p.t || 0 });
      });
      return out;
    }
    function normalize(raw) {
      var out = { v: 1, groups: [] }, seen = {};
      var gs = raw && typeof raw === 'object' && Array.isArray(raw.groups) ? raw.groups : [];
      for (var i = 0; i < gs.length && out.groups.length < 40; i++) {
        var g = normGroup(gs[i], seen);
        if (g) out.groups.push(g);
      }
      return out;
    }
    // A group moved to a currency with other digits (USD → JPY): rescale every amount.
    function rescaleGroup(g, toDg) {
      var f = Math.pow(10, toDg - g.dg);
      if (f === 1) return g;
      var r = function (a) { return Math.max(1, rnd(a * f)); };
      g.ex.forEach(function (e) {
        e.a = r(e.a);
        if (e.m === 'ex') for (var k in e.s) e.s[k] = Math.max(0, rnd(e.s[k] * f));
      });
      g.pay.forEach(function (p) { p.a = r(p.a); });
      g.dg = toDg;
      return g;
    }
    function isReferenced(g, mid) {
      return g.ex.some(function (e) { return e.p === mid || (e.s && e.s[mid] > 0); }) ||
        g.pay.some(function (p) { return p.f === mid || p.to === mid; });
    }

    // ---- markdown --------------------------------------------------------------------------------
    function cell(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' '); }
    function signed(minor, cur, loc) { return (minor > 0 ? '+' : minor < 0 ? '-' : '') + money(Math.abs(minor), cur, loc); }
    function quickMarkdown(r, names, cur, loc) {
      var m = function (x) { return money(x, cur, loc); };
      var L = [];
      L.push('**Bill split** — ' + m(r.total) + ' total, ' + r.n + (r.n === 1 ? ' person' : ' people'));
      L.push('');
      L.push('| Item | Amount |');
      L.push('|---|---:|');
      L.push('| Bill | ' + m(r.bill) + ' |');
      if (r.tax) L.push('| Tax' + (r.taxPct != null ? ' (' + fmtPct(r.taxPct, loc) + ')' : '') + ' | ' + m(r.tax) + ' |');
      L.push('| Tip (' + fmtPct(r.tipPct, loc) + (r.tax ? r.tipBase > r.bill ? ' of the total with tax' : ' of the pre-tax bill' : '') + ') | ' + m(r.tip) + ' |');
      L.push('| **Total** | **' + m(r.total) + '** |');
      if (r.surplus > 0) L.push('| Rounded up (extra tip) | ' + m(r.surplus) + ' |');
      var all = r.rounded.every(function (x) { return x === r.rounded[0]; });
      if (all && !r.uneven) {
        L.push('| **Each (' + r.n + ')** | **' + m(r.rounded[0]) + '** |');
      } else {
        L.push('');
        L.push('| Person | Items | Pays |');
        L.push('|---|---:|---:|');
        for (var i = 0; i < r.n; i++) {
          L.push('| ' + cell(names[i] || 'Person ' + (i + 1)) + ' | ' + m(r.base[i]) + ' | ' + m(r.rounded[i]) + ' |');
        }
      }
      return L.join('\n');
    }
    function quickText(r, cur, loc) {
      var m = function (x) { return money(x, cur, loc); };
      var all = r.rounded.every(function (x) { return x === r.rounded[0]; });
      var s = 'Total ' + m(r.total) + ' (bill ' + m(r.bill) + (r.tax ? ' + tax ' + m(r.tax) : '') + ' + tip ' + m(r.tip) + ')';
      if (all && !r.uneven) s += ' — ' + m(r.rounded[0]) + ' each (' + r.n + ')';
      else s += ' — ' + r.rounded.map(function (x, i) { return 'P' + (i + 1) + ' ' + m(x); }).join(', ');
      return s;
    }
    function groupMarkdown(g, rows, transfers, loc) {
      var m = function (x) { return money(x, g.cur, loc); };
      var name = {};
      g.members.forEach(function (x) { name[x.id] = x.name; });
      var spent = 0;
      g.ex.forEach(function (e) { spent += e.a; });
      var L = [];
      L.push('### ' + cell(g.name) + ' — ' + m(spent) + ' spent');
      L.push('');
      L.push('| Member | Paid | Share | Balance |');
      L.push('|---|---:|---:|---:|');
      rows.forEach(function (r) {
        L.push('| ' + cell(r.name) + ' | ' + m(r.paid) + ' | ' + m(r.share) + ' | ' + signed(r.bal, g.cur, loc) + ' |');
      });
      L.push('');
      if (!transfers.length) L.push('**Settle up:** everyone is square.');
      else {
        L.push('**Settle up** (' + transfers.length + (transfers.length === 1 ? ' payment' : ' payments') + ')');
        L.push('');
        L.push('| From | To | Amount |');
        L.push('|---|---|---:|');
        transfers.forEach(function (t) { L.push('| ' + cell(name[t.from]) + ' | ' + cell(name[t.to]) + ' | ' + m(t.amt) + ' |'); });
      }
      return L.join('\n');
    }

    return {
      MAX_PEOPLE: MAX_PEOPLE, MAX_MINOR: MAX_MINOR, MAX_ITEMS: MAX_ITEMS, MODES: MODES,
      rnd: rnd, parseNum: parseNum, num: num, toMinor: toMinor,
      validCur: validCur, curDigits: curDigits, guessCur: guessCur, money: money, curSymbol: curSymbol,
      decimalComma: decimalComma, fmtPct: fmtPct, safeLocale: safeLocale,
      allocate: allocate, hashStr: hashStr, quickSplit: quickSplit,
      expenseShares: expenseShares, balances: balances, settleUp: settleUp, zeroSumSets: zeroSumSets, greedy: greedy,
      genId: genId, normalize: normalize, rescaleGroup: rescaleGroup, isReferenced: isReferenced,
      quickMarkdown: quickMarkdown, quickText: quickText, groupMarkdown: groupMarkdown,
    };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = Logic;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ======================================================================
  // Panel
  // ======================================================================
  var Cade = window.Cade;
  Cade.loadCSS('splitbill.css');

  var L = Logic;
  var PANEL_ID = 'splitbill-panel';
  var PREFS_KEY = 'cade-splitbill-prefs';
  var TIPS = [0, 10, 15, 18, 20, 25];
  var CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'HKD', 'SGD', 'INR', 'KRW', 'MXN', 'BRL', 'ARS', 'CLP', 'COP',
    'CHF', 'SEK', 'NOK', 'DKK', 'ISK', 'PLN', 'CZK', 'HUF', 'RON', 'TRY', 'ILS', 'AED', 'SAR', 'ZAR', 'THB', 'VND', 'PHP', 'IDR', 'MYR', 'TWD'];
  var LOCALES = [['', 'Auto'], ['en-US', '1,234.56'], ['en-GB', '1,234.56 (UK)'], ['de-DE', '1.234,56'], ['fr-FR', '1 234,56'], ['de-CH', '1’234.56'], ['en-IN', '12,34,567.89'], ['ja-JP', '日本']];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 1600); } catch (e) {} }

  // ---- prefs (Cade.store) ----
  var DEF = {
    tab: 'quick', cur: '', loc: '', grp: '',
    bill: '', tipSel: '18', tipCustom: '', tax: '', taxUnit: 'pct', tipOn: 'pre', people: 2, round: 0,
    names: [], extras: [], uneven: false,
  };
  var P = null;
  function loadPrefs() {
    var raw = {};
    try { raw = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {}; } catch (e) { raw = {}; }
    P = {};
    for (var k in DEF) P[k] = raw[k] !== undefined && typeof raw[k] === typeof DEF[k] && Array.isArray(raw[k]) === Array.isArray(DEF[k]) ? raw[k] : (Array.isArray(DEF[k]) ? [] : DEF[k]);
    if (P.tab !== 'quick' && P.tab !== 'groups') P.tab = 'quick';
    if (P.cur && !L.validCur(P.cur)) P.cur = '';
    P.people = Math.max(1, Math.min(L.MAX_PEOPLE, Math.round(P.people) || 2));
    if ([0, 1, 2].indexOf(P.round) < 0) P.round = 0;
    P.names = P.names.slice(0, L.MAX_PEOPLE).map(function (s) { return String(s || '').slice(0, 40); });
    P.extras = P.extras.filter(function (x) { return x && typeof x === 'object'; }).slice(0, 30).map(function (x) {
      return { p: Math.max(0, Math.round(+x.p) || 0), amt: String(x.amt || '').slice(0, 24), label: String(x.label || '').slice(0, 40) };
    });
  }
  // Written through at once: ~1 KB, and a phone may drop the page right after typing.
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(P)); } catch (e) {} }
  function loc() { return L.safeLocale(P.loc || (typeof navigator !== 'undefined' && navigator.language) || 'en-US'); }
  function prefCur() { return P.cur || L.guessCur(loc()); }
  function dc() { return L.decimalComma(loc()); }
  function numIn(s) { return L.num(s, dc()); }

  // ---- synced groups (lazy) ----
  var blob = null, data = { v: 1, groups: [] }, staleRaw = null;
  function ensureBlob() {
    if (blob) { if (staleRaw) { data = L.normalize(staleRaw.d); staleRaw = null; } return; }
    if (typeof Cade.syncedBlob !== 'function') { // an older core: keep the groups on this device only
      blob = {
        get: function () { try { return JSON.parse(Cade.store.get('cade-splitbill-groups') || 'null'); } catch (e) { return null; } },
        set: function (d) { try { Cade.store.set('cade-splitbill-groups', JSON.stringify(d)); } catch (e) {} },
      };
      data = L.normalize(blob.get());
      return;
    }
    blob = Cade.syncedBlob('splitbill', {
      onChange: function (d) {
        // Closed or minimized: no work now — normalize it when the panel next shows.
        if (!ui || (Cade.isMinimized && Cade.isMinimized(ui.panel))) { staleRaw = { d: d }; return; }
        staleRaw = null;                            // (a newer copy supersedes one that was waiting)
        data = L.normalize(d);
        if (P.tab === 'groups') requestGroupsRender();
      },
    });
    data = L.normalize(blob.get());
  }
  var sizeWarned = false;
  function persist(g) {
    if (g) g.u = Date.now();
    try {
      var json = JSON.stringify(data);
      // The synced copy is compressed + encrypted and capped (256 KB) by the core.
      if (json.length > 500000 && !sizeWarned) { sizeWarned = true; toast('Your groups are getting too big to sync — delete the ones you no longer need', 'error', 5000); }
      blob.set(JSON.parse(json));
    } catch (e) { toast('Could not save the group', 'error', 2400); }
  }
  function activeGroup() {
    var gs = data.groups;
    for (var i = 0; i < gs.length; i++) if (gs[i].id === P.grp) return gs[i];
    return gs[0] || null;
  }

  // ---- panel state ----
  var ui = null; // { panel, form, newGroup, renaming, pending, showSettings }
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
  // Insert a markdown block at the cursor, on its own lines (blank line before
  // when the cursor follows text, so a table renders as a table).
  function insertBlock(text) {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
    var st = ed.state, sel = st.selection.main, doc = st.doc;
    var lf = doc.lineAt(sel.from), lt = doc.lineAt(sel.to);
    var before = lf.text.slice(0, sel.from - lf.from), after = lt.text.slice(sel.to - lt.from);
    var pre = '';
    if (before.trim()) pre = '\n\n';
    else if (!before && lf.number > 1 && doc.line(lf.number - 1).text.trim()) pre = '\n';
    var post = after.trim() ? '\n\n' : '\n';
    var ins = pre + text + post;
    ed.dispatch({ changes: { from: sel.from, to: sel.to, insert: ins }, selection: { anchor: sel.from + ins.length }, scrollIntoView: true, userEvent: 'input' });
    toast('Inserted into the note', 'success', 1200);
  }

  // ======================================================================
  // HTML
  // ======================================================================
  function segHtml(key, opts, cls) {
    return '<div class="spb-seg' + (cls ? ' ' + cls : '') + '" data-seg="' + key + '" role="group">' + opts.map(function (o) {
      return '<button type="button" data-v="' + esc(o[0]) + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function inputHtml(attr, ph, extra) {
    return '<input class="spb-in" type="text" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false" ' + attr +
      (ph ? ' placeholder="' + esc(ph) + '"' : '') + (extra || '') + '>';
  }
  function bodyHtml() {
    return '<div class="spb-settings" hidden></div>' +
      '<div class="spb-tabs" role="tablist">' +
        '<button class="spb-tab" role="tab" data-tab="quick">Quick split</button>' +
        '<button class="spb-tab" role="tab" data-tab="groups">Groups</button>' +
      '</div>' +
      '<div class="spb-scroll">' +
        '<section class="spb-pane" data-pane="quick">' + quickHtml() + '</section>' +
        '<section class="spb-pane" data-pane="groups"><div class="spb-groups"></div></section>' +
      '</div>' +
      '<button type="button" class="spb-sum" data-act="to-result" hidden aria-label="Show the result"></button>';
  }
  function quickHtml() {
    var chips = TIPS.map(function (t) { return '<button type="button" class="spb-chip" data-tip="' + t + '">' + t + '%</button>'; }).join('');
    return '<label class="spb-f"><span class="spb-fl">Bill amount</span>' +
        '<span class="spb-money big"><span class="spb-cs"></span>' + inputHtml('data-q="bill" aria-label="Bill amount"', '0.00', ' enterkeyhint="done"') + '</span></label>' +
      '<div class="spb-f"><span class="spb-fl">Tip</span><div class="spb-tips">' + chips +
        '<span class="spb-cust">' + inputHtml('data-q="tipCustom" aria-label="Custom tip percent"', 'Custom') + '<span class="spb-suf">%</span></span></div></div>' +
      '<div class="spb-grid2">' +
        '<div class="spb-f"><span class="spb-fl">Tax <small>optional</small></span><span class="spb-fi">' +
          inputHtml('data-q="tax" aria-label="Tax"', '0') + segHtml('taxUnit', [['pct', '%'], ['amt', '<span class="spb-cs"></span>']], 'spb-mini') + '</span></div>' +
        '<div class="spb-f"><span class="spb-fl">People</span><span class="spb-step">' +
          '<button type="button" class="spb-sbtn" data-act="ppl-" aria-label="One person fewer">−</button>' +
          '<input class="spb-in" type="text" inputmode="numeric" pattern="[0-9]*" data-q="people" aria-label="Number of people" autocomplete="off">' +
          '<button type="button" class="spb-sbtn" data-act="ppl+" aria-label="One more person">+</button></span></div>' +
      '</div>' +
      '<div class="spb-f spb-tipon"><span class="spb-fl">Tip on</span>' + segHtml('tipOn', [['pre', 'Bill before tax'], ['post', 'Bill with tax']]) + '</div>' +
      '<div class="spb-f"><span class="spb-fl">Round each share up to</span>' + segHtml('round', [['0', 'Exact'], ['1', ''], ['2', '']], 'spb-round') + '</div>' +
      '<details class="spb-uneven"><summary>Uneven split <span class="spb-faint">— someone had something extra</span> <b class="spb-cnt"></b></summary>' +
        '<div class="spb-unbody">' +
          '<div class="spb-hint">Items only one person had come off the top; the rest of the bill is shared equally, and tax and tip follow what each person ordered.</div>' +
          '<div class="spb-sub">Names</div><div class="spb-names"></div>' +
          '<div class="spb-sub">Extra items</div><div class="spb-extras"></div>' +
          '<button type="button" class="spb-btn" data-act="extra+">+ Add an item</button>' +
        '</div></details>' +
      '<div class="spb-result" aria-live="polite"></div>';
  }

  // ======================================================================
  // Quick split
  // ======================================================================
  function stepMinor(cur) {
    var d = L.curDigits(cur), sc = Math.pow(10, d);
    if (P.round === 0) return 0;
    if (d === 0) return P.round === 1 ? 10 : 100;
    return P.round === 1 ? sc / 2 : sc;
  }
  function roundLabels(cur) {
    var d = L.curDigits(cur), sc = Math.pow(10, d);
    if (d === 0) return [L.money(10, cur, loc()), L.money(100, cur, loc())];
    return [L.money(sc / 2, cur, loc()), L.money(sc, cur, loc())];
  }
  function personName(i) { return (P.names[i] || '').trim() || 'Person ' + (i + 1); }
  function quickInputs() {
    var cur = prefCur(), sc = Math.pow(10, L.curDigits(cur));
    var billV = numIn(P.bill);
    var tipPct = P.tipSel === 'c' ? numIn(P.tipCustom) : +P.tipSel;
    var taxV = numIn(P.tax), taxR = L.parseNum(P.tax, dc());
    var taxMode = P.taxUnit === 'amt' && !(taxR && taxR.pct) ? 'amt' : 'pct';
    var extras = P.extras.map(function (x) { return { p: x.p, amt: L.toMinor(numIn(x.amt), sc) }; });
    return {
      bill: P.bill.trim() ? L.toMinor(billV, sc) : NaN, tipPct: isFinite(tipPct) ? tipPct : 0,
      tax: isFinite(taxV) && taxV > 0 ? (taxMode === 'amt' ? L.toMinor(taxV, sc) : taxV) : 0, taxMode: taxMode,
      tipOn: P.tipOn, people: P.people, step: stepMinor(cur), extras: extras, cur: cur,
    };
  }
  function syncQuickControls() {
    var cur = prefCur(), sym = L.curSymbol(cur, loc());
    qa('.spb-cs').forEach(function (s) { s.textContent = sym; });
    qa('[data-tip]').forEach(function (b) { b.classList.toggle('on', P.tipSel === b.getAttribute('data-tip')); });
    var cust = q('.spb-cust');
    if (cust) cust.classList.toggle('on', P.tipSel === 'c');
    segSync('taxUnit', P.taxUnit);
    segSync('tipOn', P.tipOn);
    segSync('round', String(P.round));
    var rl = roundLabels(cur), rb = qa('[data-seg="round"] button');
    if (rb.length === 3) { rb[1].textContent = rl[0]; rb[2].textContent = rl[1]; }
    var tipon = q('.spb-tipon');
    if (tipon) tipon.hidden = !(numIn(P.tax) > 0);
  }
  function segSync(key, v) {
    qa('[data-seg="' + key + '"] button').forEach(function (b) {
      var on = b.getAttribute('data-v') === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function fillQuickInputs() {
    var set = function (k, v) { var el = q('[data-q="' + k + '"]'); if (el && document.activeElement !== el) el.value = v; };
    set('bill', P.bill); set('tipCustom', P.tipCustom); set('tax', P.tax); set('people', String(P.people));
    var det = q('.spb-uneven');
    if (det) det.open = !!P.uneven;
  }
  function renderNames() {
    var host = q('.spb-names');
    if (!host) return;
    var h = '';
    for (var i = 0; i < P.people; i++) {
      h += '<input class="spb-in spb-txt spb-name" type="text" autocomplete="off" autocapitalize="words" spellcheck="false" maxlength="40" data-name="' + i +
        '" placeholder="Person ' + (i + 1) + '" value="' + esc(P.names[i] || '') + '" aria-label="Name of person ' + (i + 1) + '">';
    }
    host.innerHTML = h;
  }
  function personOptions(sel) {
    var h = '';
    for (var i = 0; i < P.people; i++) h += '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + esc(personName(i)) + '</option>';
    return h;
  }
  function renderExtras() {
    var host = q('.spb-extras');
    if (!host) return;
    if (!P.extras.length) { host.innerHTML = '<div class="spb-faint spb-pad">No extra items yet.</div>'; }
    else {
      host.innerHTML = P.extras.map(function (x, i) {
        return '<div class="spb-xrow" data-x="' + i + '">' +
          '<select class="spb-in spb-sel" data-xf="p" aria-label="Who had it">' + personOptions(x.p) + '</select>' +
          '<input class="spb-in spb-txt" type="text" autocomplete="off" spellcheck="false" maxlength="40" data-xf="label" placeholder="Item" value="' + esc(x.label) + '" aria-label="Item">' +
          '<span class="spb-money spb-xamt"><span class="spb-cs"></span>' + inputHtml('data-xf="amt" aria-label="Item amount" value="' + esc(x.amt) + '"', '0.00') + '</span>' +
          '<button type="button" class="spb-x" data-act="extra-" aria-label="Remove item" title="Remove">×</button></div>';
      }).join('');
    }
    var cnt = q('.spb-cnt');
    if (cnt) cnt.textContent = P.extras.length ? '· ' + P.extras.length : '';
    var sym = L.curSymbol(prefCur(), loc());
    host.querySelectorAll('.spb-cs').forEach(function (s) { s.textContent = sym; });
  }
  function renderQuick() {
    var out = q('.spb-result');
    if (!out) return;
    syncQuickControls();
    var inp = quickInputs(), cur = inp.cur, lc = loc();
    var m = function (x) { return L.money(x, cur, lc); };
    var r = !P.bill.trim() ? { err: '' } : !isFinite(inp.bill) ? { err: 'That bill amount isn\'t a number.' } : L.quickSplit(inp);
    if (r.err != null) {
      out.innerHTML = r.err ? '<div class="spb-empty spb-err">' + esc(r.err) + '</div>' : '<div class="spb-empty">Enter the bill to see each share.</div>';
      ui.quick = null; updateSum(); return;
    }
    ui.quick = r;
    var allEq = r.rounded.every(function (x) { return x === r.rounded[0]; });
    var lo = Math.min.apply(null, r.rounded), hi = Math.max.apply(null, r.rounded);
    var h = '<div class="spb-card">';
    if (allEq && !r.uneven) {
      h += '<div class="spb-hero"><span class="spb-hv">' + m(r.rounded[0]) + '</span><span class="spb-hl">' + (r.n === 1 ? 'to pay' : 'each · ' + r.n + ' people') + '</span></div>';
    } else if (!r.uneven) {
      var nHi = r.rounded.filter(function (x) { return x === hi; }).length;
      h += '<div class="spb-hero"><span class="spb-hv">' + m(lo) + '</span><span class="spb-hl">each · ' + r.n + ' people</span></div>' +
        '<div class="spb-note">' + nHi + ' of ' + r.n + ' pay ' + m(hi) + ' so the shares add up exactly to the total.</div>';
    } else {
      h += '<div class="spb-people">' + r.rounded.map(function (x, i) {
        return '<div class="spb-prow"><span class="spb-pn">' + esc(personName(i)) + '</span>' +
          (r.extras[i] ? '<span class="spb-px">incl. ' + m(r.extras[i]) + ' extra</span>' : '<span class="spb-px"></span>') +
          '<b class="spb-pv">' + m(x) + '</b></div>';
      }).join('') + '</div>';
    }
    h += '<div class="spb-rows">' +
      row('Bill', m(r.bill)) +
      (r.tax ? row('Tax' + (r.taxPct != null ? ' · ' + L.fmtPct(r.taxPct, lc) : ''), m(r.tax)) : '') +
      row('Tip · ' + L.fmtPct(r.tipPct, lc) + (r.tax ? (P.tipOn === 'post' ? ' of bill with tax' : ' of bill before tax') : ''), m(r.tip)) +
      row('Total', m(r.total), 'tot') +
      (r.surplus > 0 ? row('Rounded up', '+' + m(r.surplus) + ' → tip ' + L.fmtPct(Math.round(r.effTipPct * 10) / 10, lc), 'faint') : '') +
      (r.surplus > 0 ? row('Collected', m(r.collected)) : '') +
      '</div>' +
      '<div class="spb-acts"><button type="button" class="spb-btn" data-act="q-copy">Copy</button>' +
      '<button type="button" class="spb-btn primary" data-act="q-ins">Insert into note</button></div></div>';
    out.innerHTML = h;
    updateSum();
  }
  // Phones: the result card sits below the inputs — while it's out of view a
  // bar at the bottom of the panel shows the answer (tap → scroll to it).
  function updateSum() {
    if (!ui) return;
    var bar = q('.spb-sum'), sc = q('.spb-scroll'), card = P.tab === 'quick' && ui.quick ? q('.spb-result .spb-card') : null;
    if (!bar || !sc) return;
    var show = false;
    if (card) {
      var sr = sc.getBoundingClientRect();
      show = sr.height > 0 && card.getBoundingClientRect().top > sr.bottom - 56;
    }
    if (show) {
      var r = ui.quick, cur = prefCur(), lc = loc(), m = function (x) { return L.money(x, cur, lc); };
      var lo = Math.min.apply(null, r.rounded), hi = Math.max.apply(null, r.rounded);
      bar.innerHTML = r.uneven ? '<b>' + esc(m(r.collected)) + '</b><span>total · ' + r.n + ' shares below</span><i aria-hidden="true">↓</i>'
        : '<b>' + esc(lo === hi ? m(lo) : m(lo) + '–' + m(hi)) + '</b><span>each · total ' + esc(m(r.collected)) + '</span><i aria-hidden="true">↓</i>';
    }
    bar.hidden = !show;
  }
  function onScroll() {
    if (!ui || ui.sumRaf) return;
    ui.sumRaf = requestAnimationFrame(function () { if (ui) { ui.sumRaf = 0; updateSum(); } });
  }
  function row(k, v, cls) { return '<div class="spb-row' + (cls ? ' ' + cls : '') + '"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>'; }
  function quickNames() { var a = []; for (var i = 0; i < P.people; i++) a.push(personName(i)); return a; }

  function setPeople(n) {
    n = Math.max(1, Math.min(L.MAX_PEOPLE, Math.round(n) || 1));
    if (n === P.people) { fillQuickInputs(); return; }
    P.people = n;
    P.extras.forEach(function (x) { if (x.p >= n) x.p = n - 1; });
    var el = q('[data-q="people"]');
    if (el) el.value = String(n);
    renderNames(); renderExtras(); renderQuick(); savePrefs();
  }

  // ======================================================================
  // Groups
  // ======================================================================
  function requestGroupsRender() {
    if (!ui) return;
    var ae = document.activeElement, host = q('.spb-groups');
    // Someone is typing in the groups view: re-render when they leave the field.
    if (host && ae && host.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) { ui.pending = true; return; }
    renderGroups();
  }
  function gm(g) { return function (x) { return L.money(x, g.cur, loc()); }; }
  function memberName(g, id) {
    for (var i = 0; i < g.members.length; i++) if (g.members[i].id === id) return g.members[i].name;
    return '?';
  }
  function fmtDate(t) {
    if (!t) return '';
    try { return new Date(t).toLocaleDateString(loc(), { month: 'short', day: 'numeric' }); } catch (e) { return ''; }
  }
  function renderGroups() {
    var host = q('.spb-groups');
    if (!host) return;
    ui.pending = false;
    var g = activeGroup();
    if (g && P.grp !== g.id) { P.grp = g.id; savePrefs(); }
    syncHeadCur();
    if (!g || ui.newGroup) { host.innerHTML = newGroupHtml(!g); return; }
    // The expense being edited was deleted on another device: keep the draft as a new one.
    if (ui.form && ui.form.id && !g.ex.some(function (x) { return x.id === ui.form.id; })) ui.form.id = null;
    var m = gm(g), rows = L.balances(g), tr = L.settleUp(rows);
    var spent = 0; g.ex.forEach(function (e) { spent += e.a; });
    var h = '';
    // group bar
    h += '<div class="spb-gbar"><select class="spb-in spb-sel spb-gsel" data-g="sel" aria-label="Group">' +
      data.groups.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === g.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') +
      '</select><button type="button" class="spb-btn" data-act="g-new">+ New group</button></div>';
    // members
    h += '<div class="spb-members">' + g.members.map(function (mb) {
      if (ui.renaming === mb.id) {
        return '<span class="spb-mchip edit"><input class="spb-in spb-txt" type="text" maxlength="40" autocomplete="off" data-g="rename" data-id="' + esc(mb.id) + '" value="' + esc(mb.name) + '" aria-label="Member name"></span>';
      }
      var ref = L.isReferenced(g, mb.id);
      return '<span class="spb-mchip"><button type="button" class="spb-mname" data-act="m-ren" data-id="' + esc(mb.id) + '" title="Rename">' + esc(mb.name) + '</button>' +
        (ref ? '' : '<button type="button" class="spb-mx" data-act="m-del" data-id="' + esc(mb.id) + '" aria-label="Remove ' + esc(mb.name) + '" title="Remove">×</button>') + '</span>';
    }).join('') +
      '<span class="spb-madd"><input class="spb-in spb-txt" type="text" maxlength="40" autocomplete="off" autocapitalize="words" data-g="addm" placeholder="Add member" aria-label="New member name" enterkeyhint="done">' +
      '<button type="button" class="spb-sbtn" data-act="m-add" aria-label="Add member">+</button></span></div>';
    if (!g.members.length) {
      h += '<div class="spb-empty">Add the people in this group to start.</div>';
      host.innerHTML = h + groupSettingsHtml(g);
      return;
    }
    // balances
    h += '<div class="spb-sec"><div class="spb-sech"><span>Balances</span><span class="spb-faint">' + m(spent) + ' spent · ' + g.ex.length + (g.ex.length === 1 ? ' expense' : ' expenses') + '</span></div>' +
      rows.map(function (r) {
        var cls = r.bal > 0 ? 'pos' : r.bal < 0 ? 'neg' : 'zero';
        var txt = r.bal > 0 ? 'gets back ' + m(r.bal) : r.bal < 0 ? 'owes ' + m(-r.bal) : 'settled up';
        return '<div class="spb-brow"><span class="spb-bn">' + esc(r.name) + '</span><span class="spb-bd">paid ' + m(r.paid) + ' · share ' + m(r.share) + '</span>' +
          '<b class="spb-bv ' + cls + '">' + txt + '</b></div>';
      }).join('') + '</div>';
    // settle up
    h += '<div class="spb-sec"><div class="spb-sech"><span>Settle up</span><span class="spb-faint">' +
      (tr.length ? tr.length + (tr.length === 1 ? ' payment' : ' payments') : '') + '</span></div>' +
      (tr.length ? tr.map(function (t, i) {
        return '<div class="spb-trow"><span class="spb-tt"><b>' + esc(memberName(g, t.from)) + '</b> pays <b>' + esc(memberName(g, t.to)) + '</b></span>' +
          '<b class="spb-tv">' + m(t.amt) + '</b><button type="button" class="spb-btn spb-ok" data-act="t-done" data-i="' + i + '" data-key="' + esc(t.from + '>' + t.to + ':' + t.amt) +
          '" title="Record this payment as made">Settled</button></div>';
      }).join('') : '<div class="spb-empty spb-pad">' + (g.ex.length ? 'Everyone is square.' : 'No expenses yet.') + '</div>') + '</div>';
    // expenses
    h += '<div class="spb-sec"><div class="spb-sech"><span>Expenses</span>' +
      (ui.form ? '' : '<button type="button" class="spb-btn primary" data-act="e-new">+ Add expense</button>') + '</div>';
    if (ui.form && !ui.form.id) h += formHtml(g);
    var exs = g.ex.slice().sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
    h += exs.map(function (e) {
      if (ui.form && ui.form.id === e.id) return formHtml(g);
      var cnt = 0; for (var k in e.s) if (e.s[k] > 0) cnt++;
      var how = e.m === 'eq' ? (cnt === g.members.length ? 'split equally' : 'split ' + cnt + ' ways') : e.m === 'ex' ? 'exact amounts' : e.m === 'sh' ? 'by shares' : 'by %';
      return '<button type="button" class="spb-erow" data-act="e-edit" data-id="' + esc(e.id) + '">' +
        '<span class="spb-ed"><b>' + esc(e.d || 'Expense') + '</b><small>' + esc(memberName(g, e.p)) + ' paid · ' + how + (e.t ? ' · ' + esc(fmtDate(e.t)) : '') + '</small></span>' +
        '<b class="spb-ev">' + m(e.a) + '</b></button>';
    }).join('');
    if (!g.ex.length && !ui.form) h += '<div class="spb-empty spb-pad">Add what someone paid for — dinner, the rental car, groceries.</div>';
    h += '</div>';
    // payments
    if (g.pay.length) {
      h += '<div class="spb-sec"><div class="spb-sech"><span>Payments made</span></div>' +
        g.pay.slice().sort(function (a, b) { return (b.t || 0) - (a.t || 0); }).map(function (p) {
          return '<div class="spb-prow2"><span><b>' + esc(memberName(g, p.f)) + '</b> paid <b>' + esc(memberName(g, p.to)) + '</b>' +
            (p.t ? ' <small class="spb-faint">' + esc(fmtDate(p.t)) + '</small>' : '') + '</span><b class="spb-tv">' + m(p.a) + '</b>' +
            '<button type="button" class="spb-btn" data-act="p-undo" data-id="' + esc(p.id) + '" title="Remove this payment">Undo</button></div>';
        }).join('') + '</div>';
    }
    h += '<div class="spb-acts"><button type="button" class="spb-btn" data-act="g-copy">Copy summary</button>' +
      '<button type="button" class="spb-btn primary" data-act="g-ins">Insert into note</button></div>';
    h += groupSettingsHtml(g);
    host.innerHTML = h;
    if (ui.form) updateFormPreview();
    var rn = host.querySelector('[data-g="rename"]');
    if (rn) { rn.focus(); rn.select(); }
  }
  function newGroupHtml(first) {
    var ng = ui.newGroup || { name: '', members: '' };
    return '<div class="spb-card spb-newg">' +
      (first ? '<div class="spb-hint">Track shared costs for a trip, a flat or a night out. Groups sync across your devices.</div>' : '') +
      '<label class="spb-f"><span class="spb-fl">Group name</span><input class="spb-in spb-txt" type="text" maxlength="60" autocomplete="off" data-ng="name" placeholder="Lisbon trip" value="' + esc(ng.name) + '"></label>' +
      '<label class="spb-f"><span class="spb-fl">Members <small>comma-separated</small></span><input class="spb-in spb-txt" type="text" maxlength="600" autocomplete="off" autocapitalize="words" data-ng="members" placeholder="Ana, Ben, Cy" value="' + esc(ng.members) + '"></label>' +
      '<div class="spb-acts">' + (first ? '' : '<button type="button" class="spb-btn" data-act="g-cancel">Cancel</button>') +
      '<button type="button" class="spb-btn primary" data-act="g-create">Create group</button></div></div>';
  }
  function groupSettingsHtml(g) {
    return '<details class="spb-gset"' + (ui.gsetOpen ? ' open' : '') + '><summary>Group settings</summary><div class="spb-gsetb">' +
      '<label class="spb-f"><span class="spb-fl">Name</span><input class="spb-in spb-txt" type="text" maxlength="60" autocomplete="off" data-g="gname" value="' + esc(g.name) + '"></label>' +
      '<label class="spb-f"><span class="spb-fl">Currency</span><select class="spb-in spb-sel" data-g="gcur">' + curOptions(g.cur) + '</select></label>' +
      '<div class="spb-acts"><button type="button" class="spb-btn danger" data-act="g-del">Delete group</button></div>' +
      '<div class="spb-hint">Odd cents in a split go round the people sharing it, so nobody always pays the extra penny. Settle-up uses the fewest payments possible.</div>' +
      '</div></details>';
  }
  function curOptions(sel) {
    var list = CURRENCIES.slice();
    if (sel && list.indexOf(sel) < 0) list.unshift(sel);
    return list.map(function (c) { return '<option value="' + c + '"' + (c === sel ? ' selected' : '') + '>' + c + ' · ' + esc(L.curSymbol(c, loc())) + '</option>'; }).join('');
  }

  // ---- expense form ----
  function newForm(g) {
    var s = {};
    g.members.forEach(function (mb) { s[mb.id] = ''; });
    return { id: null, d: '', a: '', p: (g.members[0] || {}).id || '', m: 'eq', chk: allChecked(g), s: s };
  }
  function allChecked(g) { var c = {}; g.members.forEach(function (mb) { c[mb.id] = true; }); return c; }
  function formFromExpense(g, e) {
    var sc = Math.pow(10, g.dg), s = {}, chk = {};
    g.members.forEach(function (mb) {
      var v = e.s[mb.id];
      chk[mb.id] = e.m === 'eq' ? v > 0 : true;
      s[mb.id] = e.m === 'eq' || !(v > 0) ? '' : e.m === 'ex' ? fmtPlain(v / sc, g.dg) : String(v);
    });
    return { id: e.id, d: e.d, a: fmtPlain(e.a / sc, g.dg), p: e.p, m: e.m, chk: chk, s: s };
  }
  function fmtPlain(v, d) {
    var s = v.toFixed(d);
    return dc() ? s.replace('.', ',') : s;
  }
  function formHtml(g) {
    var f = ui.form;
    var opts = g.members.map(function (mb) { return '<option value="' + esc(mb.id) + '"' + (mb.id === f.p ? ' selected' : '') + '>' + esc(mb.name) + '</option>'; }).join('');
    var sym = L.curSymbol(g.cur, loc());
    var rows = g.members.map(function (mb) {
      var id = esc(mb.id), ctl;
      if (f.m === 'eq') ctl = '<input type="checkbox" class="spb-cb" data-ff="chk" data-id="' + id + '"' + (f.chk[mb.id] ? ' checked' : '') + ' aria-label="Include ' + esc(mb.name) + '">';
      else ctl = '<span class="spb-fi spb-sin' + (f.m === 'ex' ? '' : ' suf') + '">' + (f.m === 'ex' ? '<span class="spb-cs2">' + esc(sym) + '</span>' : '') +
        inputHtml('data-ff="s" data-id="' + id + '" value="' + esc(f.s[mb.id] || '') + '" aria-label="' + esc(mb.name) + '"', f.m === 'ex' ? '0.00' : f.m === 'sh' ? '0' : '0') +
        (f.m === 'pc' ? '<span class="spb-suf">%</span>' : f.m === 'sh' ? '<span class="spb-suf">sh</span>' : '') + '</span>';
      return '<label class="spb-srow">' + (f.m === 'eq' ? ctl : '') + '<span class="spb-sn">' + esc(mb.name) + '</span>' + (f.m === 'eq' ? '' : ctl) +
        '<span class="spb-sv" data-pv="' + id + '"></span></label>';
    }).join('');
    return '<div class="spb-form" data-form="1">' +
      '<div class="spb-grid2">' +
        '<label class="spb-f"><span class="spb-fl">Description</span><input class="spb-in spb-txt" type="text" maxlength="80" autocomplete="off" data-ff="d" placeholder="Dinner" value="' + esc(f.d) + '"></label>' +
        '<label class="spb-f"><span class="spb-fl">Amount</span><span class="spb-money"><span class="spb-cs2">' + esc(sym) + '</span>' +
          inputHtml('data-ff="a" value="' + esc(f.a) + '"', '0.00') + '</span></label>' +
      '</div>' +
      '<label class="spb-f"><span class="spb-fl">Paid by</span><select class="spb-in spb-sel" data-ff="p">' + opts + '</select></label>' +
      '<div class="spb-f"><span class="spb-fl">Split</span>' + segHtml('fmode', [['eq', 'Equally'], ['ex', 'Exact'], ['sh', 'Shares'], ['pc', '%']]) + '</div>' +
      '<div class="spb-splits m-' + f.m + '">' + rows + '</div>' +
      '<div class="spb-fnote" aria-live="polite"></div>' +
      '<div class="spb-acts">' + (f.id ? '<button type="button" class="spb-btn danger" data-act="e-del">Delete</button><span class="spb-sp"></span>' : '<span class="spb-sp"></span>') +
        '<button type="button" class="spb-btn" data-act="e-cancel">Cancel</button>' +
        '<button type="button" class="spb-btn primary" data-act="e-save">Save</button></div>' +
      '</div>';
  }
  // Build the expense the form describes → { e, err, note }.
  function formExpense(g) {
    var f = ui.form, sc = Math.pow(10, g.dg), m = gm(g);
    var a = L.toMinor(numIn(f.a), sc), s = {}, err = '', note = '';
    if (!f.a.trim()) err = 'Enter the amount';
    else if (!(a > 0)) err = 'The amount must be more than zero';
    else if (a > L.MAX_MINOR) err = 'That amount is too large';
    var ids = g.members.map(function (mb) { return mb.id; });
    if (f.m === 'eq') {
      ids.forEach(function (id) { if (f.chk[id]) s[id] = 1; });
      if (!Object.keys(s).length && !err) err = 'Pick who shares it';
    } else {
      var tot = 0, bad = false;
      ids.forEach(function (id) {
        var raw = (f.s[id] || '').trim();
        if (!raw) return;
        var v = numIn(raw);
        if (!(v >= 0)) { bad = true; return; }
        if (f.m === 'ex') v = L.toMinor(v, sc);
        if (v > 0) { s[id] = v; tot += v; }
      });
      if (bad && !err) err = 'One of the values isn\'t a number';
      if (!err) {
        if (!Object.keys(s).length) err = f.m === 'ex' ? 'Enter who paid what' : f.m === 'sh' ? 'Give someone a share' : 'Enter the percentages';
        else if (f.m === 'ex' && tot !== a) err = tot < a ? m(a - tot) + ' left to assign' : 'Over by ' + m(tot - a);
        else if (f.m === 'pc' && Math.abs(tot - 100) > 1e-6) {
          var left = Math.round((100 - tot) * 1000) / 1000;
          err = left > 0 ? 'Percentages add up to ' + L.fmtPct(tot, loc()) + ' — ' + L.fmtPct(left, loc()) + ' left' : 'Percentages add up to ' + L.fmtPct(tot, loc());
        }
      }
      if (f.m === 'sh' && !err) note = 'Total ' + (Math.round(tot * 1000) / 1000) + ' shares';
    }
    var e = { id: f.id || L.genId(), d: f.d.trim().slice(0, 80), a: a > 0 ? a : 0, p: f.p, m: f.m, s: s, t: 0 };
    if (!err && ids.indexOf(f.p) < 0) err = 'Pick who paid';
    return { e: e, err: err, note: note };
  }
  function updateFormPreview() {
    var g = activeGroup();
    if (!ui || !ui.form || !g) return;
    var r = formExpense(g), m = gm(g), sh = {}, f = ui.form;
    // Preview what each person owes: the real split once it's valid; while %s
    // don't add up yet, each row's literal share; exact amounts need none.
    if (r.e.a > 0 && Object.keys(r.e.s).length) {
      if (!r.err) sh = L.expenseShares(r.e, g.members.map(function (mb) { return mb.id; }));
      else if (f.m === 'pc') for (var id in r.e.s) sh[id] = L.rnd(r.e.a * r.e.s[id] / 100);
      else if (f.m === 'sh') sh = L.expenseShares(r.e, g.members.map(function (mb) { return mb.id; }));
    }
    qa('[data-pv]').forEach(function (el) {
      var v = f.m === 'ex' ? 0 : sh[el.getAttribute('data-pv')];
      el.textContent = v ? m(v) : '';
    });
    var n = q('.spb-fnote');
    if (n) { n.textContent = r.err || r.note || (r.e.a > 0 ? 'Each share is shown on the right.' : ''); n.classList.toggle('bad', !!r.err && !!ui.form.a.trim()); }
    var sv = q('[data-act="e-save"]');
    if (sv) sv.disabled = !!r.err;
    segSync('fmode', ui.form.m);
  }
  function saveForm() {
    var g = activeGroup();
    if (!g || !ui.form) return;
    var r = formExpense(g);
    if (r.err) { toast(r.err, 'error', 2000); return; }
    var e = r.e, old = null;
    for (var i = 0; i < g.ex.length; i++) if (g.ex[i].id === e.id) { old = g.ex[i]; break; }
    if (old) { e.t = old.t || Date.now(); g.ex[i] = e; }
    else { e.t = Date.now(); g.ex.push(e); }
    if (g.ex.length > L.MAX_ITEMS) { g.ex.pop(); toast('This group has ' + L.MAX_ITEMS + ' expenses — start a new one', 'error', 2600); return; }
    ui.form = null;
    persist(g);
    renderGroups();
  }

  function syncHeadCur() {
    var b = ui && ui.headBtn;
    if (!b) return;
    var g = P.tab === 'groups' ? activeGroup() : null;
    b.textContent = g ? g.cur : prefCur();
    b.title = g ? 'Currency of this group' : 'Currency and number format';
  }
  function renderSettings() {
    var host = q('.spb-settings');
    if (!host) return;
    host.hidden = !ui.showSettings;
    if (!ui.showSettings) return;
    var g = P.tab === 'groups' ? activeGroup() : null;
    host.innerHTML = '<div class="spb-grid2">' +
      '<label class="spb-f"><span class="spb-fl">' + (g ? 'Currency · ' + esc(g.name) : 'Currency') + '</span><select class="spb-in spb-sel" data-set="cur">' + curOptions(g ? g.cur : prefCur()) + '</select></label>' +
      '<label class="spb-f"><span class="spb-fl">Number format</span><select class="spb-in spb-sel" data-set="loc">' +
        LOCALES.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === P.loc ? ' selected' : '') + '>' + esc(o[0] ? o[1] : 'Auto (' + L.safeLocale(navigator.language) + ')') + '</option>'; }).join('') +
      '</select></label></div>' +
      '<div class="spb-hint">' + (g ? 'The group\'s currency is shared with everyone who syncs it. ' : 'Used for the quick split and new groups. ') + 'Typing accepts 1,200.50 · 1.200,50 · 250k · 6.5%.</div>';
  }
  function setGroupCur(g, cur) {
    if (!L.validCur(cur) || cur === g.cur) return;
    var dg = L.curDigits(cur);
    if (dg < g.dg && (g.ex.length || g.pay.length) && !window.confirm(cur + ' has ' + (dg === 0 ? 'no' : dg) + ' decimal places — amounts in this group will be rounded. Continue?')) { renderGroups(); renderSettings(); return; }
    L.rescaleGroup(g, dg);
    g.cur = cur;
    persist(g);
  }

  // ======================================================================
  // Events
  // ======================================================================
  function showTab(t) {
    P.tab = t === 'groups' ? 'groups' : 'quick';
    qa('.spb-tab').forEach(function (b) {
      var on = b.getAttribute('data-tab') === P.tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    qa('.spb-pane').forEach(function (s) { s.hidden = s.getAttribute('data-pane') !== P.tab; });
    if (P.tab === 'groups') { ensureBlob(); renderGroups(); }
    else renderQuick();
    syncHeadCur();
    if (ui.showSettings) renderSettings();
    var sc = q('.spb-scroll'); if (sc) sc.scrollTop = 0;
    updateSum();
    savePrefs();
  }

  function onInput(e) {
    var t = e.target, k;
    if ((k = t.getAttribute('data-q'))) {
      if (k === 'people') { var n = parseInt(t.value, 10); if (n >= 1) { P.people = Math.min(L.MAX_PEOPLE, n); P.extras.forEach(function (x) { if (x.p >= P.people) x.p = P.people - 1; }); renderNames(); renderExtras(); } }
      else {
        P[k] = t.value.slice(0, 40);
        if (k === 'tipCustom') P.tipSel = t.value.trim() ? 'c' : P.tipSel === 'c' ? '18' : P.tipSel;
        if (k === 'tax' || k === 'bill' || k === 'tipCustom') {
          var r = L.parseNum(t.value, dc());
          t.classList.toggle('bad', !!t.value.trim() && !r);
        }
      }
      renderQuick(); savePrefs(); return;
    }
    if (t.hasAttribute('data-name')) {
      var i = +t.getAttribute('data-name');
      while (P.names.length <= i) P.names.push('');
      P.names[i] = t.value.slice(0, 40);
      qa('.spb-extras select').forEach(function (s) { if (s.options[i]) s.options[i].textContent = personName(i); });
      renderQuick(); savePrefs(); return;
    }
    if ((k = t.getAttribute('data-xf'))) {
      var rowEl = t.closest('[data-x]'), x = rowEl ? P.extras[+rowEl.getAttribute('data-x')] : null;
      if (!x) return;
      if (k === 'p') x.p = +t.value;
      else x[k] = t.value.slice(0, 40);
      if (k === 'amt') t.classList.toggle('bad', !!t.value.trim() && !(numIn(t.value) >= 0));
      renderQuick(); savePrefs(); return;
    }
    if ((k = t.getAttribute('data-ff')) && ui.form) {
      if (k === 'chk') ui.form.chk[t.getAttribute('data-id')] = t.checked;
      else if (k === 's') ui.form.s[t.getAttribute('data-id')] = t.value;
      else ui.form[k] = t.value;
      updateFormPreview(); return;
    }
    if ((k = t.getAttribute('data-ng'))) { if (!ui.newGroup) ui.newGroup = { name: '', members: '' }; ui.newGroup[k] = t.value; return; }
  }
  function onChange(e) {
    handleChange(e);
    if (ui && ui.pending && P.tab === 'groups') requestGroupsRender();
  }
  function handleChange(e) {
    var t = e.target, k, g;
    if (t.getAttribute('data-xf') === 'p' || t.getAttribute('data-ff') === 'p' || t.getAttribute('data-ff') === 'chk') { onInput(e); return; }
    if ((k = t.getAttribute('data-set'))) {
      if (k === 'loc') { P.loc = t.value; }
      else {
        g = P.tab === 'groups' ? activeGroup() : null;
        if (g) setGroupCur(g, t.value); else P.cur = t.value;
      }
      savePrefs();
      renderSettings(); syncHeadCur();
      if (P.tab === 'groups') renderGroups(); else { renderExtras(); renderQuick(); }
      return;
    }
    if ((k = t.getAttribute('data-g'))) {
      g = activeGroup();
      if (k === 'sel') { P.grp = t.value; ui.form = null; ui.renaming = null; savePrefs(); renderGroups(); if (ui.showSettings) renderSettings(); }
      else if (k === 'gname' && g) { var nm = t.value.trim().slice(0, 60); if (nm && nm !== g.name) { g.name = nm; persist(g); renderGroups(); } }
      else if (k === 'gcur' && g) { setGroupCur(g, t.value); renderGroups(); if (ui.showSettings) renderSettings(); }
    }
  }
  function onClick(e) {
    handleClick(e);
    if (ui && ui.pending && P.tab === 'groups') requestGroupsRender();
  }
  function handleClick(e) {
    var t = e.target && e.target.closest ? e.target : null, b;
    if (!t || !ui) return;
    if ((b = t.closest('.spb-tab'))) { showTab(b.getAttribute('data-tab')); return; }
    if ((b = t.closest('[data-tip]'))) { P.tipSel = b.getAttribute('data-tip'); renderQuick(); savePrefs(); return; }
    if (t.getAttribute('data-q') === 'tipCustom' && t.value.trim() && P.tipSel !== 'c') { P.tipSel = 'c'; renderQuick(); savePrefs(); return; }
    if ((b = t.closest('[data-seg] button'))) {
      var key = b.parentNode.getAttribute('data-seg'), v = b.getAttribute('data-v');
      if (key === 'round') P.round = +v;
      else if (key === 'fmode') {
        if (ui.form && ui.form.m !== v) {
          // Values mean different things per mode (amounts / shares / %): start fresh; shares default to 1 each.
          ui.form.m = v;
          for (var sk in ui.form.s) ui.form.s[sk] = v === 'sh' ? '1' : '';
          renderGroups();
        }
        return;
      } else P[key] = v;
      renderQuick(); savePrefs(); return;
    }
    if (!(b = t.closest('[data-act]')) || b.disabled) return;
    var act = b.getAttribute('data-act'), g = activeGroup(), id = b.getAttribute('data-id');
    switch (act) {
      case 'ppl-': setPeople(P.people - 1); break;
      case 'ppl+': setPeople(P.people + 1); break;
      case 'extra+':
        if (P.extras.length >= 30) return;
        P.extras.push({ p: Math.min(P.extras.length, P.people - 1), amt: '', label: '' });
        P.uneven = true; renderExtras(); renderQuick(); savePrefs();
        var ins = qa('.spb-extras [data-xf="label"]'); if (ins.length) ins[ins.length - 1].focus();
        break;
      case 'extra-':
        var xr = b.closest('[data-x]');
        if (xr) { P.extras.splice(+xr.getAttribute('data-x'), 1); renderExtras(); renderQuick(); savePrefs(); }
        break;
      case 'q-copy': if (ui.quick) copyText(L.quickText(ui.quick, prefCur(), loc())); break;
      case 'q-ins': if (ui.quick) insertBlock(L.quickMarkdown(ui.quick, quickNames(), prefCur(), loc())); break;
      case 'head-cur': ui.showSettings = !ui.showSettings; renderSettings(); updateSum(); break;
      case 'to-result': var rc = q('.spb-result .spb-card'); if (rc) rc.scrollIntoView({ block: 'start', behavior: 'smooth' }); break;
      // groups
      case 'g-new': ui.newGroup = { name: '', members: '' }; ui.form = null; renderGroups(); focusSoon('[data-ng="name"]'); break;
      case 'g-cancel': ui.newGroup = null; renderGroups(); break;
      case 'g-create': createGroup(); break;
      case 'g-del':
        if (!g || !window.confirm('Delete "' + g.name + '" and all its expenses? This syncs to your other devices.')) return;
        data.groups = data.groups.filter(function (x) { return x !== g; });
        P.grp = data.groups[0] ? data.groups[0].id : ''; ui.form = null; ui.gsetOpen = false;
        persist(); savePrefs(); renderGroups(); toast('Group deleted', 'info', 1400);
        break;
      case 'g-copy': if (g) copyText(L.groupMarkdown(g, L.balances(g), L.settleUp(L.balances(g)), loc())); break;
      case 'g-ins': if (g) insertBlock(L.groupMarkdown(g, L.balances(g), L.settleUp(L.balances(g)), loc())); break;
      case 'm-add': addMember(); break;
      case 'm-ren': ui.renaming = id; renderGroups(); break;
      case 'm-del':
        if (!g || L.isReferenced(g, id)) return;
        g.members = g.members.filter(function (mb) { return mb.id !== id; });
        if (ui.form) ui.form = null;
        persist(g); renderGroups();
        break;
      case 'e-new': if (g) { ui.form = newForm(g); renderGroups(); focusSoon('[data-ff="d"]'); } break;
      case 'e-edit':
        if (!g) return;
        var ex = g.ex.filter(function (x) { return x.id === id; })[0];
        if (ex) { ui.form = formFromExpense(g, ex); renderGroups(); var fe = q('.spb-form'); if (fe && fe.scrollIntoView) fe.scrollIntoView({ block: 'nearest' }); }
        break;
      case 'e-cancel': ui.form = null; renderGroups(); break;
      case 'e-save': saveForm(); break;
      case 'e-del':
        if (!g || !ui.form || !ui.form.id) return;
        var fid = ui.form.id;
        g.ex = g.ex.filter(function (x) { return x.id !== fid; });
        ui.form = null; persist(g); renderGroups(); toast('Expense deleted', 'info', 1200);
        break;
      case 't-done':
        if (!g) return;
        var tr = L.settleUp(L.balances(g))[+b.getAttribute('data-i')];
        // The balances changed underneath (another device): show the new ones instead of guessing.
        if (!tr || tr.from + '>' + tr.to + ':' + tr.amt !== b.getAttribute('data-key')) { renderGroups(); toast('The balances just changed — check the payments again', 'info', 2400); return; }
        if (g.pay.length >= L.MAX_ITEMS) { toast('This group has ' + L.MAX_ITEMS + ' payments — start a new one', 'error', 2600); return; }
        g.pay.push({ id: L.genId(), f: tr.from, to: tr.to, a: tr.amt, t: Date.now() });
        persist(g); renderGroups();
        toast(memberName(g, tr.from) + ' paid ' + memberName(g, tr.to) + ' ' + L.money(tr.amt, g.cur, loc()), 'success', 1800);
        break;
      case 'p-undo':
        if (!g) return;
        g.pay = g.pay.filter(function (p) { return p.id !== id; });
        persist(g); renderGroups();
        break;
    }
  }
  function focusSoon(sel) {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return; // no surprise keyboard on phones
    var el = q(sel); if (el) el.focus();
  }
  function splitNames(s) {
    var seen = {}, out = [];
    String(s || '').split(/[,;\n]+/).forEach(function (n) {
      n = n.trim().slice(0, 40);
      if (n && !seen[n.toLowerCase()] && out.length < L.MAX_PEOPLE) { seen[n.toLowerCase()] = 1; out.push(n); }
    });
    return out;
  }
  function createGroup() {
    var ng = ui.newGroup || { name: '', members: '' };
    var name = (ng.name || '').trim().slice(0, 60) || 'Group ' + (data.groups.length + 1);
    if (data.groups.length >= 40) { toast('That is a lot of groups — delete an old one first', 'error', 2400); return; }
    var cur = prefCur();
    var g = { id: L.genId(), name: name, cur: cur, dg: L.curDigits(cur), c: Date.now(), u: Date.now(), members: [], ex: [], pay: [] };
    splitNames(ng.members).forEach(function (n) { g.members.push({ id: L.genId(), name: n }); });
    data.groups.unshift(g);
    P.grp = g.id; ui.newGroup = null; ui.form = null;
    persist(g); savePrefs(); renderGroups();
    if (ui.showSettings) renderSettings();
    if (!g.members.length) focusSoon('[data-g="addm"]');
  }
  function addMember() {
    var g = activeGroup(), inp = q('[data-g="addm"]');
    if (!g || !inp) return;
    var names = splitNames(inp.value), have = {};
    if (!names.length) { inp.focus(); return; }
    g.members.forEach(function (mb) { have[mb.name.toLowerCase()] = 1; });
    var added = 0;
    names.forEach(function (n) {
      if (have[n.toLowerCase()] || g.members.length >= L.MAX_PEOPLE) return;
      g.members.push({ id: L.genId(), name: n }); have[n.toLowerCase()] = 1; added++;
    });
    if (!added) { toast('Already in the group', 'info', 1400); return; }
    persist(g); renderGroups(); focusSoon('[data-g="addm"]');
  }
  function commitRename(inp) {
    var g = activeGroup(), id = inp.getAttribute('data-id'), nm = inp.value.trim().slice(0, 40);
    ui.renaming = null;
    if (g && nm) {
      g.members.forEach(function (mb) { if (mb.id === id && mb.name !== nm) { mb.name = nm; persist(g); } });
    }
    renderGroups();
  }
  function onKey(e) {
    if (!ui) return;
    var t = e.target;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (ui.renaming) { ui.renaming = null; renderGroups(); }
      else if (ui.form) { ui.form = null; renderGroups(); }
      else if (ui.newGroup && data.groups.length) { ui.newGroup = null; renderGroups(); }
      else close();
      return;
    }
    if (e.key !== 'Enter' || !t || t.tagName !== 'INPUT') return;
    var g = t.getAttribute('data-g');
    if (g === 'addm') { e.preventDefault(); addMember(); return; }
    if (g === 'rename') { e.preventDefault(); t.blur(); return; }
    if (t.hasAttribute('data-ng')) { e.preventDefault(); createGroup(); return; }
    if (t.hasAttribute('data-ff')) { e.preventDefault(); var sv = q('[data-act="e-save"]'); if (sv && !sv.disabled) saveForm(); else updateFormPreview(); return; }
    e.preventDefault(); t.blur();
  }
  function onFocusOut(e) {
    var t = e.target;
    if (!ui || !t) return;
    if (t.getAttribute && t.getAttribute('data-g') === 'rename' && ui.renaming) { commitRename(t); return; }
    var qk = t.getAttribute && t.getAttribute('data-q');
    if (qk === 'people') setPeople(parseInt(t.value, 10) || P.people);
    else if ((qk === 'tipCustom' || qk === 'tax') && /%\s*$/.test(t.value) && L.parseNum(t.value, dc())) {
      // "12.5%" → "12.5" (the field already says %); a % typed into tax switches it to percent
      t.value = P[qk] = t.value.replace(/\s*%\s*$/, '');
      if (qk === 'tax' && P.taxUnit !== 'pct') P.taxUnit = 'pct';
      savePrefs(); renderQuick();
    }
    // A change from another device that arrived while typing is drawn after the
    // next click / change completes — never here, where it could swap out the
    // button being clicked.
  }

  // ======================================================================
  // Open / close
  // ======================================================================
  function close() {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    p.remove();
    if (p._onClose) p._onClose();
  }
  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById(PANEL_ID);
    if (existing) { close(); return; }
    loadPrefs();
    if (P.tab === 'groups') ensureBlob();
    var p = Cade.mkPanel(PANEL_ID, '🧾 Split the Bill', bodyHtml());
    ui = { panel: p, form: null, newGroup: null, renaming: null, pending: false, showSettings: false, quick: null, gsetOpen: false, headBtn: null, sumRaf: 0 };
    // Currency button in the header, before the core's minimize button.
    var hb = document.createElement('button');
    hb.type = 'button';
    hb.className = 'spb-hbtn';
    hb.setAttribute('data-act', 'head-cur');
    hb.setAttribute('aria-label', 'Currency and number format');
    var head = p.querySelector('.cade-panel-head');
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); }); // a button, not a drag handle
    ui.headBtn = hb;
    p.addEventListener('input', onInput);
    p.addEventListener('change', onChange);
    p.addEventListener('click', onClick);
    p.addEventListener('keydown', onKey);
    p.addEventListener('focusout', onFocusOut);
    p.querySelector('.spb-scroll').addEventListener('scroll', onScroll, { passive: true });
    p.addEventListener('cade-panel-restore', function () {
      if (staleRaw && blob) { ensureBlob(); if (P.tab === 'groups') renderGroups(); } // a change that arrived while minimized
      updateSum();
    });
    p.addEventListener('toggle', function (e) {
      var t = e.target;
      if (t.classList && t.classList.contains('spb-uneven')) { P.uneven = t.open; savePrefs(); updateSum(); }
      else if (t.classList && t.classList.contains('spb-gset') && ui) ui.gsetOpen = t.open;
    }, true);
    var st = ui;
    p._onClose = function () {
      if (st.sumRaf) cancelAnimationFrame(st.sumRaf);
      savePrefs();
      if (ui === st) ui = null;
    };
    fillQuickInputs();
    renderNames();
    renderExtras();
    showTab(P.tab);
  }

  Cade.registerWidget({
    name: 'Split the Bill',
    description: 'Tip, tax and each person\'s share of a bill — or a group\'s shared expenses with balances and the fewest settle-up payments',
    icon: '🧾',
    tags: 'split,bill,tip,tip calculator,gratuity,tax,restaurant,check,divide,share,people,group,expenses,trip,travel,roommates,flatmates,splitwise,iou,owe,debts,balance,settle up,money,currency',
    open: open,
    close: close,
    _lib: Logic,
  });
})();
