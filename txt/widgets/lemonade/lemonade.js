/* Lemonade Stand — run a corner stand day by day, for Cade.txt.
 * Each morning: buy lemons, sugar, ice and cups at prices that drift from day
 * to day, read the forecast (its confidence varies, and the further ahead the
 * shakier), set the recipe (lemons and sugar per pitcher, ice per cup) and the
 * price. Then open up and watch the day play out on an ASCII street: people
 * walk by and buy — or don't — depending on the price, the weather, how
 * thirsty they are and the stand's reputation. They say what they think of
 * the taste ("Too sour!", "Needs ice") and of the price. Ice melts through the
 * day (faster when hot) and overnight, lemons spoil after a few days, and a
 * pitcher's leftovers are poured out at closing. Events come with a warning in
 * the news: heat waves, rainy spells, street festivals, road works, a lemon
 * shortage, a sugar sale. Upgrades: weather radio, sign, cooler, awning,
 * juicer. A 30-day season (high scores by final cash) or an endless run you
 * retire from; the end report draws ASCII charts of the whole season.
 * The day's sales are decided by a pure, seeded engine the moment the stand
 * opens; the street then replays them on a canvas of monospace glyphs (from a
 * cached glyph atlas) on a fixed 60 Hz step with an accumulator and render
 * interpolation. The loop runs only while a day is playing; it pauses on blur,
 * tab hide and minimize. The game in progress, records and the sound toggle
 * persist in Cade.store (cade-lemonade-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // Money is in whole cents. Unit prices are fractional cents.
  var DAY_MIN = 480;                 // 9:00 → 17:00
  var OPEN_H = 9;
  var SEASON = 30;
  var MAX_HIST = 400;
  var BASE_TRAFFIC = 72;

  var DIFFS = {
    easy: { id: 'easy', name: 'Relaxed', cash: 3000, traffic: 1.15, wtp: 1.15, acc: 0.06, info: '$30 to start, generous customers' },
    normal: { id: 'normal', name: 'Normal', cash: 2000, traffic: 1, wtp: 1, acc: 0, info: '$20 to start' },
    hard: { id: 'hard', name: 'Tough', cash: 1200, traffic: 0.9, wtp: 0.86, acc: -0.06, info: '$12 to start, picky customers, shaky forecasts' }
  };
  var DIFF_IDS = ['easy', 'normal', 'hard'];

  var SUPPLIES = [
    { id: 'lemons', name: 'Lemons', one: 'lemon', base: 8, lo: 4, hi: 22, packs: [12, 24, 48], disc: [1, 0.94, 0.88] },
    { id: 'sugar', name: 'Sugar', one: 'cup of sugar', base: 6, lo: 3, hi: 15, packs: [8, 20, 48], disc: [1, 0.94, 0.88] },
    { id: 'ice', name: 'Ice', one: 'cube', base: 0.8, lo: 0.4, hi: 2, packs: [50, 200, 500], disc: [1, 0.9, 0.8] },
    { id: 'cups', name: 'Cups', one: 'cup', base: 2, lo: 1, hi: 4.5, packs: [25, 75, 150], disc: [1, 0.93, 0.86] }
  ];
  var SUP = {};
  for (var si0 = 0; si0 < SUPPLIES.length; si0++) SUP[SUPPLIES[si0].id] = SUPPLIES[si0];

  var UPGRADES = [
    { id: 'radio', name: 'Weather radio', price: 1200, info: 'forecasts are 15% more reliable' },
    { id: 'sign', name: 'Painted sign', price: 1500, info: '+20% passers-by, and they pay a little more' },
    { id: 'cooler', name: 'Cooler', price: 2500, info: 'ice melts much slower and half survives the night; lemons keep 7 days, not 4' },
    { id: 'awning', name: 'Striped awning', price: 3000, info: 'shade and shelter: +60% customers in rain, +8% they pay above 85°F' },
    { id: 'juicer', name: 'Juicer', price: 4000, info: '14 cups per pitcher instead of 10 — 40% more lemonade per lemon' }
  ];
  var UPG = {};
  for (var ui0 = 0; ui0 < UPGRADES.length; ui0++) UPG[UPGRADES[ui0].id] = UPGRADES[ui0];

  // Weather types in order of gloom (a missed forecast is off by one or two steps).
  var WX = [
    { id: 'sunny', name: 'Sunny', ch: '*', traffic: 1, thirst: 0.08, temp: 0 },
    { id: 'cloudy', name: 'Partly cloudy', ch: '~', traffic: 0.86, thirst: 0, temp: -3 },
    { id: 'overcast', name: 'Overcast', ch: '=', traffic: 0.66, thirst: -0.06, temp: -6 },
    { id: 'rain', name: 'Rain', ch: '/', traffic: 0.32, thirst: -0.12, temp: -9 },
    { id: 'storm', name: 'Thunderstorm', ch: '!', traffic: 0.14, thirst: -0.15, temp: -11 }
  ];

  var EVENTS = [
    { id: 'heat', name: 'Heat wave', len: [2, 4], w: 3, news: 'Heat wave on the way: scorching days ahead' },
    { id: 'rain', name: 'Rainy spell', len: [2, 3], w: 3, news: 'A rainy spell is rolling in' },
    { id: 'festival', name: 'Street festival', len: [1, 2], w: 2, news: 'Street festival on your block: big crowds expected' },
    { id: 'construction', name: 'Road works', len: [2, 4], w: 2, news: 'Road works on your street: fewer people, thirsty workers' },
    { id: 'shortage', name: 'Lemon shortage', len: [2, 4], w: 2, news: 'Lemon shortage: lemon prices soar' },
    { id: 'sale', name: 'Sugar sale', len: [1, 3], w: 2, news: 'Sugar sale at the grocer' }
  ];
  var EVT = {};
  for (var ei0 = 0; ei0 < EVENTS.length; ei0++) EVT[EVENTS[ei0].id] = EVENTS[ei0];

  var KINDS = [
    { id: 'adult', w: 5, wtp: 1, th: 0 },
    { id: 'kid', w: 2, wtp: 0.7, th: 0.08 },
    { id: 'elder', w: 2, wtp: 1.1, th: -0.05 },
    { id: 'jogger', w: 1.5, wtp: 0.95, th: 0.18 },
    { id: 'suit', w: 1.5, wtp: 1.3, th: -0.04 },
    { id: 'worker', w: 0, wtp: 1.1, th: 0.22 },   // road works only
    { id: 'fan', w: 0, wtp: 1.2, th: 0.1 }        // festival only
  ];
  var KIND = {};
  for (var ki0 = 0; ki0 < KINDS.length; ki0++) KIND[KINDS[ki0].id] = KINDS[ki0];

  // What customers say, by reason.
  var SAY = {
    price: ['Too pricey!', '$$$?!', 'No way!'],
    pricey: ['Pricey...', 'Hmm, no', 'Next time'],
    thirst: ['Not thirsty', 'Maybe later', 'No thanks'],
    out: ['Sold out?!', 'Aww...', 'Empty?!'],
    sour: ['Too sour!', 'Sour!', 'Needs sugar'],
    sweet: ['Too sweet!', 'Sugary...', 'So sweet'],
    watery: ['Watery...', 'Weak!', 'Bland'],
    strong: ['So lemony!', 'Too strong', 'Whoa, tart'],
    warm: ['Needs ice', 'Warm...', 'Not cold'],
    icy: ['Brain freeze!', 'Too icy', 'All ice!'],
    good: ['Yum!', 'Refreshing!', 'Ahh!', 'Perfect!', 'Tasty!'],
    deal: ['What a deal!', 'Bargain!', 'Cheap!']
  };
  var ISSUE_NAME = {
    price: 'too pricey', thirst: 'not thirsty', out: 'sold out', sour: 'too sour', sweet: 'too sweet',
    watery: 'watery', strong: 'too lemony', warm: 'needs ice', icy: 'too icy', good: 'loved it', deal: 'a bargain'
  };

  var REC_LIM = { L: [1, 12], S: [0, 12], ice: [0, 10], price: [5, 500] };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { v = +v; return isFinite(v) ? v : d; }
  function int(v, a, b, d) { v = Math.round(num(v, d)); return clamp(v, a, b); }

  // Small seeded PRNG (mulberry32) and an integer hash, so a day is reproducible.
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(a, b) {
    var h = Math.imul((a | 0) ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul((b | 0) + 0x632BE5AB, 0xC2B2AE35);
    h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
    return h >>> 0;
  }
  function pick(r, arr) { return arr[Math.floor(r() * arr.length) % arr.length]; }

  // ---- a new game ----
  function newGame(o) {
    o = o || {};
    var diff = DIFFS[o.diff] ? o.diff : 'normal', mode = o.mode === 'endless' ? 'endless' : 'season';
    var seed = (o.seed == null ? Math.floor(Math.random() * 4294967295) : num(o.seed, 1)) >>> 0;
    var g = {
      v: 1, mode: mode, diff: diff, seed: seed, day: 1, phase: 'plan', cash: DIFFS[diff].cash, start: DIFFS[diff].cash, rep: 50,
      px: {}, pxPrev: {}, inv: { lemons: [], sugar: 0, ice: 0, cups: 0 },
      rec: { L: 4, S: 4, ice: 3, price: 25 }, up: {}, events: [], hist: [], spent: 0, upSpent: 0, last: null,
      tot: { cust: 0, sold: 0, rev: 0, spent: 0, spoiled: 0, melted: 0, poured: 0, satSum: 0, satN: 0, out: 0 },
      endReason: ''
    };
    for (var i = 0; i < SUPPLIES.length; i++) { g.px[SUPPLIES[i].id] = SUPPLIES[i].base; g.pxPrev[SUPPLIES[i].id] = SUPPLIES[i].base; }
    scheduleEvents(g, true);
    return g;
  }

  // ---- events: one at a time, always announced at least a day ahead ----
  function eventOn(g, day, id) {
    for (var i = 0; i < g.events.length; i++) {
      var e = g.events[i];
      if (e.id === id && day >= e.s && day < e.s + e.n) return true;
    }
    return false;
  }
  function eventsOn(g, day) {
    var out = [];
    for (var i = 0; i < g.events.length; i++) { var e = g.events[i]; if (day >= e.s && day < e.s + e.n) out.push(e.id); }
    return out;
  }
  function scheduleEvents(g, first) {
    var r = rng(hash2(g.seed ^ 0xE7E7, g.day)), busy = 0, i;
    for (i = 0; i < g.events.length; i++) busy = Math.max(busy, g.events[i].s + g.events[i].n - 1);
    var start = first ? 3 + Math.floor(r() * 4) : g.day + 2 + Math.floor(r() * 2);
    if (busy >= start - 1) return null;
    if (!first && r() > 0.26) return null;
    var tw = 0, k;
    for (i = 0; i < EVENTS.length; i++) tw += EVENTS[i].w;
    k = r() * tw;
    for (i = 0; i < EVENTS.length - 1 && k >= EVENTS[i].w; i++) k -= EVENTS[i].w;
    var E = EVENTS[i], n = E.len[0] + Math.floor(r() * (E.len[1] - E.len[0] + 1));
    if (g.mode === 'season' && start > SEASON) return null;
    var ev = { id: E.id, s: start, n: n };
    g.events.push(ev);
    return ev;
  }
  // News for the planning screen: events running today or starting within two days.
  function news(g) {
    var out = [];
    for (var i = 0; i < g.events.length; i++) {
      var e = g.events[i], E = EVT[e.id], end = e.s + e.n - 1;
      if (g.day >= e.s && g.day <= end) out.push({ id: e.id, name: E.name, when: 'now', left: end - g.day + 1, text: E.news });
      else if (e.s > g.day && e.s - g.day <= 2) out.push({ id: e.id, name: E.name, when: e.s - g.day === 1 ? 'tomorrow' : 'in 2 days', left: e.n, text: E.news });
    }
    return out;
  }

  // ---- weather: the truth for a day, and a forecast of it ----
  function weatherFor(g, day) {
    var r = rng(hash2(g.seed, day * 7 + 1));
    var cyc = g.mode === 'season' ? Math.sin(Math.PI * (day - 0.5) / SEASON) : 0.5 + 0.5 * Math.sin(2 * Math.PI * day / 40 - 1.2);
    var base = 66 + 20 * cyc + (r() - 0.5) * 14, u = r(), i;
    i = u < 0.36 ? 0 : u < 0.6 ? 1 : u < 0.78 ? 2 : u < 0.94 ? 3 : 4;
    if (day === 1) { i = Math.min(i, 1); base = Math.max(base, 72); }   // a friendly opening day
    if (eventOn(g, day, 'heat')) { i = r() < 0.8 ? 0 : 1; base += 16; }
    else if (eventOn(g, day, 'rain')) i = r() < 0.75 ? 3 : 4;
    var temp = Math.round(clamp(base + WX[i].temp, 45, 108));
    return { i: i, id: WX[i].id, temp: temp };
  }
  function dayAcc(g, day) { return 0.55 + rng(hash2(g.seed ^ 0xF0CA, day))() * 0.38; }
  function forecastFor(g, day, lead) {
    lead = lead || 0;
    var w = weatherFor(g, day);
    var acc = clamp(dayAcc(g, day) - 0.14 * lead + (g.up.radio ? 0.15 : 0) + DIFFS[g.diff].acc, 0.3, 0.98);
    var r = rng(hash2(g.seed ^ 0xF0E5, day * 8 + lead)), i = w.i;
    if (r() >= acc) {
      i = clamp(w.i + (r() < 0.5 ? -1 : 1) * (r() < 0.25 ? 2 : 1), 0, WX.length - 1);
      if (i === w.i) i = w.i === 0 ? 1 : w.i - 1;
    }
    var spread = Math.max(1, Math.ceil((1 - acc) * 14));
    var temp = w.temp + Math.round((r() * 2 - 1) * (1 - acc) * 22);
    return { i: i, id: WX[i].id, temp: temp, lo: temp - spread, hi: temp + spread, acc: Math.round(acc * 100) };
  }

  // ---- market ----
  function priceOf(g, id, day) {
    var p = g.px[id];
    if (day == null) day = g.day;
    if (id === 'lemons' && eventOn(g, day, 'shortage')) p *= 1.8;
    if (id === 'sugar' && eventOn(g, day, 'sale')) p *= 0.55;
    return p;
  }
  function packCost(g, id, k) { var s = SUP[id]; return Math.max(1, Math.round(priceOf(g, id) * s.packs[k] * s.disc[k])); }
  function lemonCount(g) { var n = 0; for (var i = 0; i < g.inv.lemons.length; i++) n += g.inv.lemons[i].n; return n; }
  function stock(g, id) { return id === 'lemons' ? lemonCount(g) : id === 'ice' ? Math.floor(g.inv.ice) : g.inv[id]; }
  function lemonLife(g) { return g.up.cooler ? 7 : 4; }
  function spoilingTonight(g) {
    var n = 0, life = lemonLife(g);
    for (var i = 0; i < g.inv.lemons.length; i++) if (g.day - g.inv.lemons[i].d + 1 >= life) n += g.inv.lemons[i].n;
    return n;
  }
  function buySupply(g, id, k) {
    var s = SUP[id];
    if (!s || g.phase !== 'plan' || !(k >= 0 && k < s.packs.length)) return 0;
    var cost = packCost(g, id, k), q = s.packs[k];
    if (cost > g.cash) return 0;
    g.cash -= cost; g.spent += cost; g.tot.spent += cost;
    if (id === 'lemons') {
      var L = g.inv.lemons, last = L[L.length - 1];
      if (last && last.d === g.day) last.n += q; else L.push({ n: q, d: g.day });
    } else g.inv[id] += q;
    return cost;
  }
  function buyUpgrade(g, id) {
    var u = UPG[id];
    if (!u || g.up[id] || g.phase !== 'plan' || g.cash < u.price) return false;
    g.cash -= u.price; g.upSpent += u.price; g.tot.spent += u.price;
    g.up[id] = true;
    return true;
  }
  function setRecipe(g, key, v) {
    var lim = REC_LIM[key];
    if (!lim) return g.rec[key];
    v = Math.round(num(v, g.rec[key]));
    if (key === 'price') v = Math.round(v / 5) * 5;
    g.rec[key] = clamp(v, lim[0], lim[1]);
    return g.rec[key];
  }
  function cupsPerPitcher(g) { return g.up.juicer ? 14 : 10; }
  // Cups the stock can make today (ice isn't required: warm lemonade still sells).
  function cupsPossible(g) {
    var rec = g.rec, p = Math.floor(lemonCount(g) / rec.L);
    if (rec.S > 0) p = Math.min(p, Math.floor(g.inv.sugar / rec.S));
    return Math.max(0, Math.min(p * cupsPerPitcher(g), g.inv.cups));
  }
  function costPerCup(g) {
    var rec = g.rec, cpp = cupsPerPitcher(g);
    return (rec.L * priceOf(g, 'lemons') + rec.S * priceOf(g, 'sugar')) / cpp + rec.ice * priceOf(g, 'ice') + priceOf(g, 'cups');
  }
  function meltRate(g, temp) {
    var k = 0.0007 + Math.max(0, temp - 55) * 0.00004;     // per minute
    return g.up.cooler ? k * 0.4 : k;
  }
  // Expected passers-by for a forecast (the real count varies ±15%).
  function trafficFor(g, wi, temp, day) {
    var W = WX[wi], t = BASE_TRAFFIC * W.traffic * clamp(0.5 + (temp - 50) / 45, 0.45, 1.75) * (0.7 + 0.6 * g.rep / 100) * DIFFS[g.diff].traffic;
    if (g.up.sign) t *= 1.2;
    if (g.up.awning && wi >= 3) t *= 1.6;
    if (eventOn(g, day, 'festival')) t *= 2.1;
    if (eventOn(g, day, 'construction')) t *= 0.55;
    return t;
  }

  // ---- taste: balance of lemon and sugar, and ice for the heat ----
  // Returns { score 0..1, issue } where issue is the biggest complaint.
  function idealIce(temp) { return clamp((temp - 50) / 8, 0, 6); }
  function taste(rec, temp, iceUsed) {
    var s = rec.L, S = rec.S, ice = iceUsed == null ? rec.ice : iceUsed;
    var dS = s - 5, pS = Math.max(0, Math.abs(dS) - 0.75) / 3.5;
    var dB = S - 0.8 * s, pB = Math.max(0, Math.abs(dB) - 0.75) / 3;
    var dI = ice - idealIce(temp), pI = Math.max(0, Math.abs(dI) - 1) / 4;
    var score = clamp(1 - 0.55 * pS - 0.5 * pB - 0.3 * pI, 0, 1);
    var issue = '', worst = 0.02;
    if (0.55 * pS > worst) { worst = 0.55 * pS; issue = dS < 0 ? 'watery' : 'strong'; }
    if (0.5 * pB > worst) { worst = 0.5 * pB; issue = dB < 0 ? 'sour' : 'sweet'; }
    if (0.3 * pI > worst) { worst = 0.3 * pI; issue = dI < 0 ? 'warm' : 'icy'; }
    return { score: score, issue: issue };
  }

  function pickKind(r, fest, road) {
    var tw = 0, i, w = [];
    for (i = 0; i < KINDS.length; i++) {
      var k = KINDS[i], x = k.w;
      if (k.id === 'worker' && road) x = 4;
      if (k.id === 'fan' && fest) x = 5;
      w.push(x); tw += x;
    }
    var u = r() * tw;
    for (i = 0; i < KINDS.length - 1 && u >= w[i]; i++) u -= w[i];
    return KINDS[i].id;
  }
  function useLemons(g, n) {
    var L = g.inv.lemons;
    while (n > 0 && L.length) {
      var take = Math.min(n, L[0].n);
      L[0].n -= take; n -= take;
      if (L[0].n <= 0) L.shift();
    }
  }

  // ---- the day: decides every passer-by in time order, applies the results ----
  function simDay(g) {
    if (g.phase !== 'plan') return null;
    var r = rng(hash2(g.seed ^ 0x5A1E, g.day)), D = DIFFS[g.diff];
    var wx = weatherFor(g, g.day), W = WX[wx.i], temp = wx.temp, fc = forecastFor(g, g.day, 0);
    var fest = eventOn(g, g.day, 'festival'), road = eventOn(g, g.day, 'construction');
    var n = Math.max(0, Math.round(trafficFor(g, wx.i, temp, g.day) * (0.85 + 0.3 * r())));
    var rec = { L: g.rec.L, S: g.rec.S, ice: g.rec.ice, price: g.rec.price }, price = rec.price, cpp = cupsPerPitcher(g);
    var ts = [], i;
    for (i = 0; i < n; i++) {
      var u = r() < 0.3 ? 210 + (r() + r() + r() - 1.5) * 110 : r() * DAY_MIN;   // a lunchtime bump
      ts.push(clamp(u, 0, DAY_MIN - 1));
    }
    ts.sort(function (a, b) { return a - b; });
    var ice = g.inv.ice, iceStart = ice, k = meltRate(g, temp), tPrev = 0, melted = 0;
    var pitcher = 0, pitchers = 0, sold = 0, rev = 0, cust = [], said = {}, out = 0, pricey = 0, thirsty = 0;
    var satSum = 0, tasteSum = 0, dRep = 0, outAt = -1, lastSay = -99;
    var repBefore = g.rep;
    for (i = 0; i < n; i++) {
      var t = ts[i], dt = t - tPrev;
      if (dt > 0) { var ni = ice * Math.exp(-k * dt); melted += ice - ni; ice = ni; tPrev = t; }
      var kind = pickKind(r, fest, road), K = KIND[kind];
      var thirst = clamp(0.45 + (temp - 68) / 55 + W.thirst * 0.7 + K.th + (r() + r() - 1) * 0.3, 0, 1);
      var wtp = (12 + 78 * Math.pow(thirst, 1.2)) * (0.65 + 0.7 * g.rep / 100) * (0.75 + 0.5 * r()) * D.wtp * K.wtp;
      if (g.up.sign) wtp *= 1.05;
      if (fest) wtp *= 1.2;
      if (g.up.awning && temp >= 85) wtp *= 1.08;
      var c = { t: t, dir: r() < 0.5 ? 1 : -1, kind: kind, buy: false, why: '', say: '', mood: 0, sp: 0.85 + 0.3 * r(), off: r(), v: r() };
      var talk = r(), say = '';
      if (thirst < 0.16) { c.why = 'thirst'; thirsty++; if (talk < 0.25) say = 'thirst'; }
      else if (price > wtp) {
        c.why = 'price'; pricey++; dRep -= 0.03; c.mood = -1;
        if (talk < 0.6) say = price > wtp * 1.5 ? 'price' : 'pricey';
      } else {
        if (pitcher <= 0 && rec.L <= lemonCount(g) && rec.S <= g.inv.sugar) {
          useLemons(g, rec.L); g.inv.sugar -= rec.S; pitcher = cpp; pitchers++;
        }
        if (pitcher <= 0 || g.inv.cups < 1) {
          c.why = 'out'; out++; dRep -= 0.3; c.mood = -1;
          if (outAt < 0) outAt = t;
          if (talk < 0.7) say = 'out';
        } else {
          pitcher--; g.inv.cups--;
          var iu = rec.ice;
          if (ice < iu) iu = Math.floor(ice);
          ice -= iu;
          var tz = taste(rec, temp, iu), value = clamp(0.5 + (wtp - price) / wtp, 0, 1), sat = 0.7 * tz.score + 0.3 * value;
          sold++; rev += price; satSum += sat; tasteSum += tz.score; dRep += (sat - 0.64) * 0.2;
          c.buy = true; c.sat = sat; c.mood = sat > 0.72 ? 1 : sat < 0.5 ? -1 : 0;
          if (tz.score < 0.82 && tz.issue) { c.why = tz.issue; if (talk < 0.8) say = tz.issue; }
          else if (value > 0.85 && talk < 0.35) { c.why = 'deal'; say = 'deal'; }
          else { c.why = 'good'; if (talk < 0.45) say = 'good'; }
        }
      }
      said[c.why] = (said[c.why] || 0) + 1;
      if (say) { c.say = pick(r, SAY[say]); if (t - lastSay < 6) c.quiet = true; else lastSay = t; }
      c.snap = { cups: g.inv.cups, lemons: lemonCount(g), sugar: g.inv.sugar, ice: Math.floor(ice), pitcher: pitcher, sold: sold, rev: rev };
      cust.push(c);
    }
    if (DAY_MIN > tPrev) { var ne = ice * Math.exp(-k * (DAY_MIN - tPrev)); melted += ice - ne; ice = ne; }
    var kept = g.up.cooler ? Math.floor(ice * 0.5) : 0;
    melted += ice - kept;
    g.inv.ice = kept;
    var poured = pitcher;
    // lemons that reach the end of their life tonight
    var life = lemonLife(g), spoiled = 0, L = g.inv.lemons;
    for (i = L.length - 1; i >= 0; i--) if (g.day - L[i].d + 1 >= life) { spoiled += L[i].n; L.splice(i, 1); }
    dRep = clamp(dRep, -12, 9);
    g.rep = Math.round(clamp(g.rep + dRep + (50 - g.rep) * 0.04, 0, 100) * 10) / 10;
    g.cash += rev;
    var profit = rev - g.spent - g.upSpent;
    var res = {
      day: g.day, wx: wx, fc: fc, events: eventsOn(g, g.day), n: n, sold: sold, rev: rev, spent: g.spent, upSpent: g.upSpent, profit: profit,
      cash: g.cash, price: price, out: out, outAt: outAt, pricey: pricey, thirsty: thirsty,
      sat: sold ? Math.round(satSum / sold * 100) : 0, taste: sold ? Math.round(tasteSum / sold * 100) : 0,
      repBefore: repBefore, rep: g.rep, pitchers: pitchers, poured: poured, melted: Math.round(melted), iceStart: Math.floor(iceStart),
      iceKept: kept, spoiled: spoiled, said: said, rec: rec
    };
    var t2 = g.tot;
    t2.cust += n; t2.sold += sold; t2.rev += rev; t2.spoiled += spoiled; t2.melted += Math.round(melted); t2.poured += poured;
    t2.satSum += satSum; t2.satN += sold; t2.out += out;
    g.hist.push({ d: g.day, w: wx.i, t: temp, n: n, sold: sold, rev: rev, spent: g.spent + g.upSpent, profit: profit, cash: g.cash, rep: g.rep, price: price });
    if (g.hist.length > MAX_HIST) g.hist.splice(0, g.hist.length - MAX_HIST);
    g.last = res;
    g.phase = 'report';
    // the street replay gets the customer list; the saved summary doesn't
    return { sum: res, cust: cust };
  }

  // Tips for the results card, from what happened.
  function tipsFor(res, g) {
    var out = [], s = res.said || {}, tot = res.sold || 0;
    if (res.out > 0) {
      var why = g && g.inv.cups < 1 ? 'cups' : g && lemonCount(g) < res.rec.L ? 'lemons' : g && g.inv.sugar < res.rec.S ? 'sugar' : 'lemonade';
      out.push('You ran out of ' + why + ' — ' + res.out + ' customers left empty-handed (that hurts your reputation).');
    }
    if (res.pricey > Math.max(3, res.n * 0.25)) out.push(res.pricey + ' people walked away over the price.');
    else if (tot > 10 && res.pricey === 0 && res.out === 0 && (s.deal || 0) > tot * 0.2) out.push('Nobody balked at the price — you could charge more.');
    var issues = ['sour', 'sweet', 'watery', 'strong', 'warm', 'icy'], worst = '', wn = 0;
    for (var i = 0; i < issues.length; i++) if ((s[issues[i]] || 0) > wn) { wn = s[issues[i]]; worst = issues[i]; }
    if (wn > Math.max(2, tot * 0.15)) {
      var fix = { sour: 'add sugar', sweet: 'use less sugar', watery: 'add lemons', strong: 'use fewer lemons', warm: 'more ice per cup', icy: 'less ice per cup' }[worst];
      out.push('Customers say ' + ISSUE_NAME[worst] + ' — ' + fix + '.');
    }
    if (res.spoiled > 0) out.push(res.spoiled + ' lemons spoiled — buy closer to what you need' + (g && !g.up.cooler ? ' (a cooler helps)' : '') + '.');
    if (res.iceStart > 0 && res.melted > res.iceStart * 0.6 && g && !g.up.cooler) out.push('Most of the ice melted — a cooler keeps it.');
    if (!out.length && tot > 0) out.push('A smooth day. Keep an eye on the forecast.');
    return out;
  }

  // ---- between days ----
  function driftPrices(g) {
    var r = rng(hash2(g.seed ^ 0xD71F, g.day));
    for (var i = 0; i < SUPPLIES.length; i++) {
      var s = SUPPLIES[i], p = g.px[s.id];
      g.pxPrev[s.id] = p;
      p = p * Math.exp((r() + r() - 1) * 0.12) + (s.base - p) * 0.12;
      g.px[s.id] = Math.round(clamp(p, s.lo, s.hi) * 100) / 100;
    }
  }
  function nextDay(g) {
    if (g.phase !== 'report') return false;
    if (g.mode === 'season' && g.day >= SEASON) { g.phase = 'over'; g.endReason = 'season'; return true; }
    g.day++; g.spent = 0; g.upSpent = 0;
    driftPrices(g);
    for (var i = g.events.length - 1; i >= 0; i--) if (g.events[i].s + g.events[i].n - 1 < g.day) g.events.splice(i, 1);
    scheduleEvents(g, false);
    g.phase = 'plan';
    if (!canOperate(g)) { g.phase = 'over'; g.endReason = 'broke'; }
    return true;
  }
  // Can the stand still make and sell at least one cup (with stock, or with cash for the smallest packs)?
  function canOperate(g) {
    var need = 0;
    if (lemonCount(g) < 1) need += packCost(g, 'lemons', 0);
    if (g.inv.cups < 1) need += packCost(g, 'cups', 0);
    if (g.inv.sugar < 1 && g.rec.S > 0) need += 0;   // sugarless lemonade is allowed (S can be 0)
    return need <= g.cash;
  }
  function retire(g) { if (g.phase === 'over') return false; g.phase = 'over'; g.endReason = 'retired'; return true; }

  // ---- records ----
  function newRecs() { return { season: [], endless: [], bestDay: 0, bestCups: 0, games: 0 }; }
  function normList(a) {
    var out = [];
    if (Array.isArray(a)) for (var i = 0; i < a.length && out.length < 5; i++) {
      var e = a[i];
      if (e && typeof e === 'object' && isFinite(+e.s)) out.push({ s: Math.round(+e.s), d: int(e.d, 0, 100000, 0), diff: DIFFS[e.diff] ? e.diff : 'normal', at: num(e.at, 0), why: typeof e.why === 'string' ? e.why.slice(0, 12) : '' });
    }
    out.sort(function (x, y) { return y.s - x.s; });
    return out;
  }
  function normRecs(o) {
    var R = newRecs();
    if (!o || typeof o !== 'object') return R;
    R.season = normList(o.season); R.endless = normList(o.endless);
    R.bestDay = Math.max(0, Math.round(num(o.bestDay, 0))); R.bestCups = Math.max(0, Math.round(num(o.bestCups, 0)));
    R.games = Math.max(0, Math.round(num(o.games, 0)));
    return R;
  }
  function noteDay(R, res) {
    var nb = false;
    if (res.profit > R.bestDay) { R.bestDay = res.profit; nb = true; }
    if (res.sold > R.bestCups) { R.bestCups = res.sold; nb = true; }
    return nb;
  }
  // Adds a finished game; returns its rank (1..5) or 0.
  function addRecord(R, g, at) {
    // d = days actually played (a retire or a bankruptcy happens on the morning after the last day)
    var played = g.hist.length ? g.hist[g.hist.length - 1].d : 0;
    var list = R[g.mode === 'endless' ? 'endless' : 'season'], e = { s: g.cash, d: played, diff: g.diff, at: at || 0, why: g.endReason };
    R.games++;
    list.push(e);
    list.sort(function (x, y) { return y.s - x.s; });
    var rank = list.indexOf(e) + 1;
    if (list.length > 5) list.length = 5;
    return rank <= 5 ? rank : 0;
  }

  // ---- saves ----
  function normGame(o) {
    if (!o || typeof o !== 'object' || o.v !== 1) return null;
    var g = newGame({ mode: o.mode, diff: o.diff, seed: num(o.seed, 1) });
    g.events = [];
    g.day = int(o.day, 1, 100000, 1);
    if (g.mode === 'season') g.day = Math.min(g.day, SEASON);
    g.phase = o.phase === 'report' || o.phase === 'over' ? o.phase : 'plan';
    g.cash = int(o.cash, -1e9, 1e9, g.cash);
    g.start = int(o.start, 0, 1e9, g.start);
    g.rep = clamp(num(o.rep, 50), 0, 100);
    var i, s;
    for (i = 0; i < SUPPLIES.length; i++) {
      s = SUPPLIES[i];
      g.px[s.id] = clamp(num(o.px && o.px[s.id], s.base), s.lo, s.hi);
      g.pxPrev[s.id] = clamp(num(o.pxPrev && o.pxPrev[s.id], g.px[s.id]), s.lo, s.hi);
    }
    var inv = o.inv && typeof o.inv === 'object' ? o.inv : {};
    if (Array.isArray(inv.lemons)) for (i = 0; i < inv.lemons.length && g.inv.lemons.length < 60; i++) {
      var lot = inv.lemons[i];
      if (lot && +lot.n >= 1) g.inv.lemons.push({ n: int(lot.n, 1, 1e6, 1), d: int(lot.d, -100, g.day, g.day) });
    }
    g.inv.sugar = int(inv.sugar, 0, 1e6, 0); g.inv.cups = int(inv.cups, 0, 1e6, 0);
    g.inv.ice = clamp(num(inv.ice, 0), 0, 1e6);
    var rec = o.rec && typeof o.rec === 'object' ? o.rec : {};
    for (var key in REC_LIM) if (REC_LIM.hasOwnProperty(key)) setRecipe(g, key, num(rec[key], g.rec[key]));
    if (o.up && typeof o.up === 'object') for (i = 0; i < UPGRADES.length; i++) if (o.up[UPGRADES[i].id] === true) g.up[UPGRADES[i].id] = true;
    if (Array.isArray(o.events)) for (i = 0; i < o.events.length && g.events.length < 8; i++) {
      var e = o.events[i];
      if (e && EVT[e.id]) g.events.push({ id: e.id, s: int(e.s, 1, 100000, 1), n: int(e.n, 1, 10, 1) });
    }
    if (Array.isArray(o.hist)) for (i = Math.max(0, o.hist.length - MAX_HIST); i < o.hist.length; i++) {
      var h = o.hist[i];
      if (!h || typeof h !== 'object') continue;
      g.hist.push({
        d: int(h.d, 1, 100000, 1), w: int(h.w, 0, WX.length - 1, 0), t: int(h.t, 0, 130, 70), n: int(h.n, 0, 1e5, 0), sold: int(h.sold, 0, 1e5, 0),
        rev: int(h.rev, 0, 1e9, 0), spent: int(h.spent, 0, 1e9, 0), profit: int(h.profit, -1e9, 1e9, 0), cash: int(h.cash, -1e9, 1e9, 0),
        rep: clamp(num(h.rep, 50), 0, 100), price: int(h.price, 0, 1e4, 0)
      });
    }
    g.spent = int(o.spent, 0, 1e9, 0); g.upSpent = int(o.upSpent, 0, 1e9, 0);
    var t = o.tot && typeof o.tot === 'object' ? o.tot : {};
    for (var tk in g.tot) if (g.tot.hasOwnProperty(tk)) g.tot[tk] = Math.max(0, num(t[tk], 0));
    g.last = o.last && typeof o.last === 'object' && isFinite(+o.last.day) ? normLast(o.last) : null;
    g.endReason = o.endReason === 'season' || o.endReason === 'broke' || o.endReason === 'retired' ? o.endReason : '';
    if (g.phase === 'over' && !g.endReason) g.endReason = 'retired';
    return g;
  }
  function normLast(l) {
    var res = {};
    var nums = ['day', 'n', 'sold', 'rev', 'spent', 'upSpent', 'profit', 'cash', 'price', 'out', 'outAt', 'pricey', 'thirsty', 'sat', 'taste', 'repBefore', 'rep', 'pitchers', 'poured', 'melted', 'iceStart', 'iceKept', 'spoiled'];
    for (var i = 0; i < nums.length; i++) res[nums[i]] = num(l[nums[i]], 0);
    var w = l.wx && typeof l.wx === 'object' ? l.wx : {};
    var wi = int(w.i, 0, WX.length - 1, 0);
    res.wx = { i: wi, id: WX[wi].id, temp: int(w.temp, 0, 130, 70) };
    var f = l.fc && typeof l.fc === 'object' ? l.fc : {};
    var fi = int(f.i, 0, WX.length - 1, wi);
    res.fc = { i: fi, id: WX[fi].id, temp: int(f.temp, 0, 140, res.wx.temp), lo: int(f.lo, 0, 140, res.wx.temp), hi: int(f.hi, 0, 140, res.wx.temp), acc: int(f.acc, 0, 100, 70) };
    res.events = Array.isArray(l.events) ? l.events.filter(function (e) { return !!EVT[e]; }) : [];
    res.said = {};
    if (l.said && typeof l.said === 'object') for (var k in ISSUE_NAME) if (ISSUE_NAME.hasOwnProperty(k) && +l.said[k] > 0) res.said[k] = Math.round(+l.said[k]);
    var rc = l.rec && typeof l.rec === 'object' ? l.rec : {};
    res.rec = { L: int(rc.L, 1, 12, 4), S: int(rc.S, 0, 12, 4), ice: int(rc.ice, 0, 10, 3), price: int(rc.price, 5, 500, 25) };
    return res;
  }

  // ---- ASCII charts for the books and the end report ----
  var BLOCKS = ' ▁▂▃▄▅▆▇█';
  function spark(vals) {
    if (!vals.length) return '';
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), out = '';
    for (var i = 0; i < vals.length; i++) {
      var f = hi > lo ? (vals[i] - lo) / (hi - lo) : 0.5;
      out += BLOCKS.charAt(1 + Math.round(f * 7));
    }
    return out;
  }
  // Vertical bars (one column per value) with a zero line; negatives hang below it.
  // Returns { lines: [...], posRows, negRows }.
  function bars(vals, h) {
    h = h || 6;
    var max = 0, min = 0, i, r;
    for (i = 0; i < vals.length; i++) { max = Math.max(max, vals[i]); min = Math.min(min, vals[i]); }
    var unit = (max - min) / h || 1, pos = max > 0 ? Math.ceil(max / unit - 1e-9) : 0, neg = min < 0 ? Math.ceil(-min / unit - 1e-9) : 0, lines = [];
    if (!pos && !neg) pos = 1;
    for (r = pos - 1; r >= 0; r--) {
      var line = '';
      for (i = 0; i < vals.length; i++) {
        var v = vals[i] > 0 ? vals[i] / unit - r : 0;
        line += v >= 1 ? '█' : v > 0 ? BLOCKS.charAt(Math.max(1, Math.round(v * 8))) : ' ';
      }
      lines.push(line);
    }
    var axis = '';
    for (i = 0; i < vals.length; i++) axis += '─';
    lines.push(axis);
    for (r = 0; r < neg; r++) {
      var ln = '';
      for (i = 0; i < vals.length; i++) {
        var nv = vals[i] < 0 ? -vals[i] / unit - r : 0;
        ln += nv >= 0.75 ? '█' : nv > 0.25 ? '▀' : ' ';
      }
      lines.push(ln);
    }
    return { lines: lines, posRows: pos, negRows: neg, unit: unit };
  }
  function wxStrip(hist) { var s = ''; for (var i = 0; i < hist.length; i++) s += WX[hist[i].w].ch; return s; }
  function summary(g) {
    var t = g.tot, best = null, worst = null;
    for (var i = 0; i < g.hist.length; i++) {
      var h = g.hist[i];
      if (!best || h.profit > best.profit) best = h;
      if (!worst || h.profit < worst.profit) worst = h;
    }
    return {
      days: g.hist.length, cash: g.cash, gain: g.cash - g.start, cust: t.cust, sold: t.sold, rev: t.rev, spent: t.spent,
      conv: t.cust ? Math.round(t.sold / t.cust * 100) : 0, sat: t.satN ? Math.round(t.satSum / t.satN * 100) : 0,
      spoiled: t.spoiled, melted: t.melted, poured: t.poured, out: t.out, best: best, worst: worst, rep: g.rep,
      ups: UPGRADES.filter(function (u) { return g.up[u.id]; }).length
    };
  }

  var ENGINE = {
    DAY_MIN: DAY_MIN, OPEN_H: OPEN_H, SEASON: SEASON, DIFFS: DIFFS, DIFF_IDS: DIFF_IDS, SUPPLIES: SUPPLIES, SUP: SUP, UPGRADES: UPGRADES, UPG: UPG,
    WX: WX, EVENTS: EVENTS, EVT: EVT, KINDS: KINDS, SAY: SAY, ISSUE_NAME: ISSUE_NAME, REC_LIM: REC_LIM, BLOCKS: BLOCKS,
    rng: rng, hash2: hash2, newGame: newGame, normGame: normGame, eventOn: eventOn, eventsOn: eventsOn, scheduleEvents: scheduleEvents, news: news,
    weatherFor: weatherFor, forecastFor: forecastFor, priceOf: priceOf, packCost: packCost, lemonCount: lemonCount, stock: stock,
    lemonLife: lemonLife, spoilingTonight: spoilingTonight, buySupply: buySupply, buyUpgrade: buyUpgrade, setRecipe: setRecipe,
    cupsPerPitcher: cupsPerPitcher, cupsPossible: cupsPossible, costPerCup: costPerCup, meltRate: meltRate, trafficFor: trafficFor,
    idealIce: idealIce, taste: taste, simDay: simDay, tipsFor: tipsFor, driftPrices: driftPrices, nextDay: nextDay, canOperate: canOperate,
    retire: retire, newRecs: newRecs, normRecs: normRecs, noteDay: noteDay, addRecord: addRecord, spark: spark, bars: bars, wxStrip: wxStrip,
    summary: summary
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('lemonade.css');

  var PANEL_ID = 'lemonade-panel', NAME = 'Lemonade Stand';
  var KEY = 'cade-lemonade-', GAME_KEY = KEY + 'game', REC_KEY = KEY + 'recs', SOUND_KEY = KEY + 'sound', SPEED_KEY = KEY + 'speed', SEEN_KEY = KEY + 'seen';
  var COLS = 56, ROWS = 12, STEP = 1 / 60, DAY_SECS = 30, MIN_PER_SEC = DAY_MIN / DAY_SECS;
  var WALK = 1.1;                      // columns per game minute at a customer's speed 1
  var SX = 20;                         // the stand's left column (15 wide)
  var STAND_C = SX + 7;
  var TABS = [['market', 'Market'], ['recipe', 'Recipe'], ['weather', 'Weather'], ['upgrades', 'Upgrades'], ['books', 'Books']];
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.lemonade = { live: function () { return S; }, E: ENGINE, render: function () { render(); } };   // test-only peek

  // palette slots, filled from the theme
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_LEMON = 4, C_RED = 5, C_SKY = 6, C_LEAF = 7, C_ORANGE = 8, C_VIOLET = 9,
    C_CLOUD = 10, C_HOUSE = 11, C_SUN = 12, NPAL = 13;
  var KIND_COL = { adult: C_TEXT, kid: C_ACC, elder: C_MUTED, jogger: C_LEAF, suit: C_SKY, worker: C_ORANGE, fan: C_VIOLET };

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { if (Cade.store.remove) Cade.store.remove(k); else Cade.store.set(k, ''); } catch (e) {} }
  function loadJSON(k) { var raw = sget(k); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } }
  function saveGame() { if (!S) return; if (S.g) sset(GAME_KEY, JSON.stringify(S.g)); else sdel(GAME_KEY); }
  function saveRecs() { if (S) sset(REC_KEY, JSON.stringify(S.R)); }

  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function money(c) {
    c = Math.round(c);
    var neg = c < 0, a = Math.abs(c), d = Math.floor(a / 100), s = String(d), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (neg ? '-' : '') + '$' + s + out + '.' + ('0' + (a % 100)).slice(-2);
  }
  function cents(c) { return c < 100 ? Math.round(c) + '¢' : money(c); }
  function unitPx(p) { return p < 1 ? p.toFixed(2) + '¢' : p < 10 ? p.toFixed(1) + '¢' : Math.round(p) + '¢'; }
  function clock(min) {
    var m = Math.floor(clamp(min, 0, DAY_MIN)), h = OPEN_H + Math.floor(m / 60), mm = m % 60;
    return (h > 12 ? h - 12 : h) + ':' + ('0' + mm).slice(-2) + (h >= 12 ? 'pm' : 'am');
  }
  function repStars(rep) {
    var n = Math.max(0, Math.min(5, Math.round(rep / 20)));
    return '<span class="lm-stars" title="Reputation ' + Math.round(rep) + '/100">' + '★★★★★'.slice(0, n) + '<i>' + '★★★★★'.slice(0, 5 - n) + '</i></span>';
  }

  // ---- sound: a tiny WebAudio voice, created on a user gesture (iOS), closed with the panel ----
  function Snd(on) { this.on = !!on; this.ac = null; }
  Snd.prototype.ensure = function () {
    if (!this.on) return;
    if (!this.ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ac = new AC(); } catch (e) { this.ac = null; return; }
    }
    if (this.ac.state === 'suspended') { try { this.ac.resume(); } catch (e) {} }
  };
  Snd.prototype.tone = function (f, dur, type, vol, slide, delay) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      var t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };
  function sfx(kind) {
    if (!S || !S.snd.on) return;
    var s = S.snd;
    if (kind === 'sale') { s.tone(1319, 0.05, 'triangle', 0.03); s.tone(1760, 0.09, 'triangle', 0.028, 0, 0.05); }
    else if (kind === 'buy') s.tone(660, 0.05, 'square', 0.02);
    else if (kind === 'nope') s.tone(220, 0.08, 'sine', 0.03, 180);
    else if (kind === 'out') s.tone(160, 0.14, 'sawtooth', 0.02, 120);
    else if (kind === 'step') s.tone(880, 0.025, 'sine', 0.015);
    else if (kind === 'open') { s.tone(784, 0.1, 'sine', 0.04); s.tone(1047, 0.1, 'sine', 0.04, 0, 0.1); s.tone(1319, 0.18, 'sine', 0.04, 0, 0.2); }
    else if (kind === 'close') { s.tone(1047, 0.12, 'sine', 0.035); s.tone(784, 0.2, 'sine', 0.035, 0, 0.12); }
    else if (kind === 'upgrade') { s.tone(523, 0.08, 'square', 0.025); s.tone(659, 0.08, 'square', 0.025, 0, 0.08); s.tone(784, 0.08, 'square', 0.025, 0, 0.16); s.tone(1047, 0.2, 'square', 0.025, 0, 0.24); }
    else if (kind === 'thunder') s.tone(70, 0.6, 'sawtooth', 0.03, 40);
    else if (kind === 'fanfare') { [523, 659, 784, 1047, 1319].forEach(function (f, i) { s.tone(f, 0.16, 'triangle', 0.03, 0, i * 0.11); }); }
  }

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_MENU = svg('<path d="M4 6h16M4 12h16M4 18h16"/>');

  // ---- theme colours (derived from the app's CSS variables) ----
  function parseCol(s, d) {
    s = (s || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    return m ? [+m[1], +m[2], +m[3]] : d;
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function css(c, a) {
    var r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
    return a == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var sf = parseCol(v('--surface'), bg);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.55)), fa = parseCol(v('--text-faint'), mix(bg, tx, 0.35));
    var P = S.pal;
    S.dark = dark;
    P[C_TEXT] = css(tx); P[C_MUTED] = css(mu); P[C_FAINT] = css(fa); P[C_ACC] = css(ac);
    P[C_LEMON] = dark ? '#f2d24a' : '#a88300'; P[C_RED] = dark ? '#f06a6a' : '#cf3f3f';
    P[C_SKY] = dark ? '#7cc7f2' : '#2878b5'; P[C_LEAF] = dark ? '#7ed37a' : '#2f8f3a';
    P[C_ORANGE] = dark ? '#ff9a4a' : '#d9601a'; P[C_VIOLET] = dark ? '#b79cf5' : '#7351c4';
    P[C_CLOUD] = css(mix(bg, tx, dark ? 0.32 : 0.28)); P[C_HOUSE] = css(mix(bg, tx, dark ? 0.22 : 0.18));
    P[C_SUN] = dark ? '#ffc04d' : '#e08a00';
    S.bgCol = css(bg); S.surfCol = css(sf); S.flashCol = dark ? 'rgba(220,230,255,' : 'rgba(255,255,255,';
    S.font = (v('--font-mono') || '').trim() || 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    fitFont();
  }

  // ---- the glyph grid: a cached atlas of (glyph, colour) cells ----
  var AT_COLS = 32, AT_ROWS = 24;
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function fitFont() {
    if (!S.ctx || !S.cwp) return;
    var c = S.ctx;
    c.font = '600 100px ' + S.font;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = Math.min(S.cwp / adv, S.rhp * 0.86);
    S.fnt = '600 ' + S.fpx.toFixed(2) + 'px ' + S.font;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    a.w = Math.ceil(S.cwp) + 4; a.h = Math.ceil(S.rhp) + 2;
    a.cv.width = a.w * AT_COLS; a.cv.height = a.h * AT_ROWS;
    a.c = a.cv.getContext('2d');
    a.c.font = S.fnt; a.c.textAlign = 'center'; a.c.textBaseline = 'middle';
    a.n = 0; a.max = AT_COLS * AT_ROWS; a.map = {};
  }
  function gIdx(ci, ch) {
    var a = S.atl, key = ci + ch, i = a.map[key];
    if (i !== undefined) return i;
    if (a.n >= a.max) return -1;
    i = a.n++;
    a.c.fillStyle = S.pal[ci];
    a.c.fillText(ch, (i % AT_COLS) * a.w + a.w / 2, ((i / AT_COLS) | 0) * a.h + a.h / 2);
    a.map[key] = i;
    return i;
  }
  // One glyph with its cell's left edge at column x (fractional) on row y.
  function glyph(ch, ci, x, y) {
    if (ch === ' ') return;
    var a = S.atl, i = gIdx(ci, ch), px = Math.round(x * S.cwp), py = Math.round(y * S.rhp);
    if (i < 0) {
      var c = S.ctx;
      c.font = S.fnt; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = S.pal[ci];
      c.fillText(ch, px + S.cwp / 2, py + S.rhp / 2);
      return;
    }
    S.ctx.drawImage(a.cv, (i % AT_COLS) * a.w, ((i / AT_COLS) | 0) * a.h, a.w, a.h, px + S.cwp / 2 - a.w / 2, py + S.rhp / 2 - a.h / 2, a.w, a.h);
  }
  function text(str, ci, x, y) { for (var i = 0; i < str.length; i++) glyph(str.charAt(i), ci, x + i, y); }
  function textR(str, ci, xr, y) { text(str, ci, xr - str.length, y); }
  function cellFill(x, y, w, h, col) {
    S.ctx.fillStyle = col;
    S.ctx.fillRect(Math.round(x * S.cwp), Math.round(y * S.rhp), Math.round(w * S.cwp), Math.round(h * S.rhp));
  }

  // ---- the street ----
  var HOUSES = [
    '    /\\        ',
    '   /  \\    _  ',
    '   |[]|   |=| ',
    '   |  |_  | | ',
    '   |__|_|_|_| '
  ];
  var TREES = [
    '   @@@        ',
    '  @@@@@  .-.  ',
    '   @@@   |#|  ',
    '    |    |#|  ',
    '    |    |_|  '
  ];
  var CLOUD = [' .--.  ', '(    ).', ' `--`  '];
  var SUN = [' \\ | / ', '-- O --', ' / | \\ '];

  function sceneWx() {
    if (!S.g) return { i: 0, temp: 78 };
    if (S.sim) return S.sim.sum.wx;
    if (S.g.phase === 'plan') { var f = forecastFor(S.g, S.g.day, 0); return { i: f.i, temp: f.temp, fc: true }; }
    if (S.g.last) return S.g.last.wx;
    return { i: 0, temp: 78 };
  }
  function draw(alpha) {
    if (!S || !S.ctx || !S.atl) return;
    var c = S.ctx, sim = S.sim, g = S.g;
    var T = sim ? sim.prev + (sim.clock - sim.prev) * alpha : 0;
    var wx = sceneWx(), wi = wx.i, hot = wx.temp >= 90;
    var evs = g ? eventsOn(g, g.day) : [];
    var fest = evs.indexOf('festival') >= 0 && !!g && (S.sim || g.phase === 'plan'), road = evs.indexOf('construction') >= 0 && !!g && (S.sim || g.phase === 'plan');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = S.bgCol;
    c.fillRect(0, 0, S.cv.width, S.cv.height);
    if (sim && sim.flash > 0) { c.fillStyle = S.flashCol + (sim.flash * 0.5).toFixed(3) + ')'; c.fillRect(0, 0, S.cv.width, S.cv.height); }
    var drift = sim ? T * 0.04 : 0, i, x;
    // sky: sun, clouds, bunting
    if (wi <= 1) {
      for (i = 0; i < 3; i++) text(SUN[i], hot ? C_ORANGE : C_SUN, 46, 1 + i);
      if (hot) { glyph('~', C_ORANGE, 44, 2); glyph('~', C_ORANGE, 54, 2); }
    }
    var nCloud = [0, 2, 4, 4, 5][wi], cloudCol = wi >= 3 ? C_MUTED : C_CLOUD;
    for (i = 0; i < nCloud; i++) {
      x = ((i * 14.3 + 3 + drift * (0.6 + i * 0.15)) % (COLS + 8)) - 8;
      var cy = 1 + (i % 2);
      for (var r0 = 0; r0 < 2; r0++) text(CLOUD[r0], cloudCol, x, cy + r0);
    }
    if (fest) {
      for (x = 0; x < COLS; x++) glyph((x % 2) ? '^' : 'v', [C_RED, C_LEMON, C_SKY, C_LEAF, C_VIOLET][(x >> 1) % 5], x, 1);
    }
    // background: houses and trees
    for (i = 0; i < HOUSES.length; i++) { text(HOUSES[i], C_HOUSE, 0, 4 + i); text(TREES[i], C_HOUSE, 42, 4 + i); }
    drawStand(T, sim);
    // curb and road
    for (x = 0; x < COLS; x++) glyph('_', C_FAINT, x, 9.55);
    var lane = sim ? (T * 0.9) % 4 : 0;
    for (x = -4; x < COLS + 4; x += 4) text('--', C_HOUSE, x + (sim ? -lane : 0), 11);
    if (road) {
      text('A', C_ORANGE, 6, 10.8); text('A', C_ORANGE, 12, 10.8); text('[ROAD WORK]', C_ORANGE, 15, 10.8); text('A', C_ORANGE, 28, 10.8);
    }
    if (sim) {
      drawCars(T);
      drawPeople(T);
      drawParts();
      // rain over everything outside
      if (wi >= 3) for (i = 0; i < sim.drops.length; i++) { var d = sim.drops[i]; glyph(wi === 4 ? '/' : ',', C_SKY, d.x, d.y); }
      if (sim.bolt > 0) { text('\\', C_LEMON, sim.boltX, 1); text('/', C_LEMON, sim.boltX - 1, 2); text('\\', C_LEMON, sim.boltX, 3); }
    }
    else if (wi >= 3) for (i = 0; i < 40; i++) {         // a still of the rain while planning
      var hx = hash2(i, 991);
      glyph(',', C_SKY, (hx % 600) / 10 - 2, 1 + ((hx >>> 10) % 95) / 10);
    }
    // HUD line
    cellFill(0, 0, COLS, 1, S.bgCol);
    if (sim) {
      text(clock(T), C_TEXT, 1, 0);
      var tn = WX[wi].name + ' ' + wx.temp + '°F';
      textR(tn, wi >= 3 ? C_SKY : hot ? C_ORANGE : C_MUTED, COLS - 1, 0);
      var snap = sim.snapNow, ss = 'sold ' + (snap ? snap.sold : 0) + '  ' + money(snap ? snap.rev : 0);
      text(ss, C_LEMON, Math.floor((COLS - ss.length) / 2), 0);
    } else if (g) {
      text(g.phase === 'over' ? 'CLOSED' : 'DAY ' + g.day + (g.mode === 'season' ? '/' + SEASON : ''), C_TEXT, 1, 0);
      if (g.phase === 'plan') {
        var f = forecastFor(g, g.day, 0), ft = 'forecast: ' + WX[f.i].name.toLowerCase() + ' ~' + f.temp + '°F';
        textR(ft, C_MUTED, COLS - 1, 0);
      } else if (g.last) textR(WX[g.last.wx.i].name + ' ' + g.last.wx.temp + '°F', C_MUTED, COLS - 1, 0);
    } else {
      text('LEMONADE STAND', C_LEMON, 1, 0);
      textR('fresh daily', C_FAINT, COLS - 1, 0);
    }
  }
  function drawStand(T, sim) {
    var g = S.g, up = g ? g.up : {}, price = g ? g.rec.price : 25;
    var soldOut = sim && sim.outShown;
    var ps = price < 100 ? price + '¢' : '$' + (price / 100).toFixed(price % 100 ? 2 : 0);
    var top = up.awning ? '/\\/\\/\\/\\/\\/\\/\\/' : '.-------------.';
    if (up.awning) {
      for (var i = 0; i < 15; i++) glyph(top.charAt(i), (i >> 1) % 2 ? C_LEMON : C_RED, SX + i, 3);
      text('_______________', C_MUTED, SX, 2.45);
    } else text(top, C_MUTED, SX, 3);
    text('|', C_MUTED, SX, 4); text('|', C_MUTED, SX + 14, 4);
    if (soldOut) text(' SOLD  OUT! ', C_RED, SX + 1, 4);
    else {
      text('LEMONADE', C_LEMON, SX + 1, 4);
      textR(ps, C_TEXT, SX + 14, 4);
    }
    text("'-------------'", C_MUTED, SX, 5);
    text('|', C_MUTED, SX + 1, 6); text('|', C_MUTED, SX + 13, 6);
    // on the counter: the pitcher, a bowl of lemons, gadgets
    var snap = sim && sim.snapNow, lem = snap ? snap.lemons : g ? lemonCount(g) : 6, pit = snap ? snap.pitcher : 0;
    text('[', C_SKY, SX + 3, 6); glyph(pit > 0 || !sim ? '~' : '_', pit > 0 || !sim ? C_LEMON : C_FAINT, SX + 4, 6); text(']', C_SKY, SX + 5, 6);
    var bowl = lem > 20 ? 'ooo' : lem > 6 ? 'oo' : lem > 0 ? 'o' : '';
    text(bowl, C_LEMON, SX + 6, 6);
    if (up.juicer) glyph('Y', C_LEAF, SX + 12, 6);
    if (up.radio) text('[:]', C_VIOLET, SX + 9, 6);
    text('|===========|', C_MUTED, SX + 1, 7);
    text('|', C_MUTED, SX + 1, 8); text('|', C_MUTED, SX + 13, 8);
    text('|___________|', C_MUTED, SX + 1, 9);
    if (!sim && g && g.phase !== 'over') text('CLOSED', C_FAINT, SX + 4, 8);
    if (!sim && g && g.phase === 'over') text('FOR SALE', C_RED, SX + 3, 8);
    if (up.cooler) { text('[==]', C_SKY, SX - 5, 8); text('[__]', C_SKY, SX - 5, 9); }
    if (up.sign) {
      var sw = Math.max(3, ps.length), dash = '', sp = '';
      for (var q = 0; q < sw; q++) { dash += '-'; sp += ' '; }
      var pad = Math.floor((sw - ps.length) / 2);
      text('.' + dash + '.', C_ACC, SX + 16, 7);
      text('|' + (sp.slice(0, pad) + ps + sp).slice(0, sw) + '|', C_ACC, SX + 16, 8);
      text('/' + sp + '\\', C_ACC, SX + 16, 9);
    }
  }
  function drawCars(T) {
    var sim = S.sim;
    for (var i = 0; i < sim.cars.length; i++) {
      var car = sim.cars[i], x = car.x0 + car.v * (T - car.t);
      if (x < -8 || x > COLS + 8) continue;
      text(car.dir > 0 ? 'o[__]>' : '<[__]o', car.col, x, 10.8);
    }
  }
  // A passer-by's column at game minute T (null when off screen) and what it's doing.
  function personAt(p, T) {
    var v = WALK * p.sp, stop = STAND_C + (p.off - 0.5) * 10, wait = p.buy ? 7 + 6 * p.v : 0, span = (COLS / 2 + 10) / v;
    if (T < p.t - span || T > p.t + wait + span) return null;
    var x, st;
    if (T < p.t) { x = stop - p.dir * (p.t - T) * v; st = 0; }
    else if (T < p.t + wait) { x = stop; st = 1; }
    else { x = stop + p.dir * (T - p.t - wait) * v; st = 2; }
    if (x < -4 || x > COLS + 3) return null;
    return { x: x, st: st };
  }
  var BODY = {
    adult: [['o', '/|\\', '/ \\'], ['o', '/|\\', ' | ']],
    elder: [['o', '/|\\', '/ )'], ['o', '/|\\', ' |)']],
    suit: [['o', '/H\\', '/ \\'], ['o', '/H\\', ' | ']],
    jogger: [['o', '<|\\', '/ >'], ['o', '/|>', '<\\ ']],
    worker: [['n', '[#]', '/ \\'], ['n', '[#]', ' | ']],
    fan: [['o', '\\|/', '/ \\'], ['o', '\\|/', ' | ']],
    kid: [['', 'o', '/^\\'], ['', 'o', '/^ ']]
  };
  function drawPeople(T) {
    var sim = S.sim, L = sim.cust, bubbles = [];
    for (var i = 0; i < L.length; i++) {
      var p = L[i], at = personAt(p, T);
      if (!at) continue;
      var fr = at.st === 1 ? 0 : (Math.floor(Math.abs(at.x) * 1.2) % 2), spr = BODY[p.kind] || BODY.adult, rows = spr[fr];
      var col = KIND_COL[p.kind] || C_TEXT, x0 = at.x - 1;
      for (var r = 0; r < 3; r++) {
        var line = rows[r];
        if (!line) continue;
        var off = Math.floor((3 - line.length) / 2);
        for (var k = 0; k < line.length; k++) {
          var ch = line.charAt(k);
          if (ch === ' ') continue;
          cellFill(x0 + off + k, 7 + r, 1, 1, S.bgCol);
        }
        text(line, col, x0 + off, 7 + r);
      }
      if (p.buy && at.st >= 1) glyph('u', C_LEMON, at.x + (at.st === 2 ? p.dir : 1) * 1.6 - 0.5, 8);
      if (p.say && !p.quiet && T >= p.t && T < p.t + 15) bubbles.push({ s: p.say, x: at.x, m: p.mood });
    }
    var taken = [];
    for (var b = bubbles.length - 1; b >= 0; b--) {      // newest first; an overlapped older bubble gives way
      var bb = bubbles[b], w = bb.s.length + 2, bx = clamp(Math.round(bb.x - w / 2), 0, COLS - w), clash = false;
      for (var q = 0; q < taken.length; q++) if (bx < taken[q][1] + 1 && bx + w + 1 > taken[q][0]) clash = true;
      if (clash) continue;
      taken.push([bx, bx + w]);
      cellFill(bx, 5.9, w, 1, S.surfCol);
      S.ctx.strokeStyle = S.pal[bb.m > 0 ? C_LEAF : bb.m < 0 ? C_RED : C_FAINT];
      S.ctx.lineWidth = Math.max(1, S.k);
      S.ctx.strokeRect(Math.round(bx * S.cwp) + 0.5, Math.round(5.9 * S.rhp) + 0.5, Math.round(w * S.cwp) - 1, Math.round(S.rhp) - 1);
      text(bb.s, bb.m > 0 ? C_LEAF : bb.m < 0 ? C_RED : C_TEXT, bx + 1, 5.9);
    }
  }
  function drawParts() {
    var P = S.sim.parts;
    for (var i = 0; i < P.length; i++) {
      var p = P[i], a = p.life / p.max;
      if (a < 0.15 && (Math.floor(p.life * 20) % 2)) continue;   // flicker out
      text(p.s, p.col, p.x, p.y);
    }
  }

  // ---- the day replay ----
  function startSim(out) {
    var sum = out.sum, cust = out.cust, r = rng(hash2(S.g.seed ^ 0xCA75, sum.day));
    var cars = [], n = road() ? 4 : 18, i;
    function road() { return sum.events.indexOf('construction') >= 0; }
    for (i = 0; i < n; i++) {
      var dir = r() < 0.5 ? 1 : -1, v = (2.5 + r() * 2) * dir;
      cars.push({ t: r() * (DAY_MIN + 40) - 20, dir: dir, v: v, x0: dir > 0 ? -7 : COLS + 1, col: [C_RED, C_SKY, C_LEAF, C_VIOLET, C_MUTED][Math.floor(r() * 5)] });
    }
    var end = DAY_MIN;
    for (i = 0; i < cust.length; i++) if (cust[i].buy) end = Math.max(end, cust[i].t + 14);
    S.sim = {
      sum: sum, cust: cust, clock: 0, prev: 0, end: Math.min(end, DAY_MIN + 40), idx: 0, secs: 0, acc: 0, parts: [], drops: [], cars: cars,
      flash: 0, bolt: 0, boltX: 0, snapNow: { sold: 0, rev: 0, cups: sum0('cups'), lemons: sum0('lemons'), sugar: sum0('sugar'), ice: sum0('ice'), pitcher: 0 },
      outShown: false, r: r, said: {}, feed: []
    };
    function sum0(k) { return out.before[k]; }
    S.screen = 'sim'; S.paused = false;
    sfx('open');
    render();
    startLoop();
  }
  function startLoop() {
    if (!S || S.raf || !S.sim || S.paused) return;
    S.last = 0;
    S.raf = requestAnimationFrame(frame);
  }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.sim || S.paused) return;
    if (!S.panel.isConnected) { teardown(); return; }
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : STEP;
    S.last = ts;
    var sim = S.sim;
    sim.acc += dt;
    var guard = 0;
    while (sim.acc >= STEP && guard++ < 12) { simStep(); sim.acc -= STEP; if (!S.sim) return; }
    if (guard >= 12) sim.acc = 0;
    draw(sim.acc / STEP);
    S.raf = requestAnimationFrame(frame);
  }
  function simStep() {
    var sim = S.sim, wi = sim.sum.wx.i;
    sim.prev = sim.clock;
    sim.secs += STEP;
    sim.clock = Math.min(sim.end, sim.clock + MIN_PER_SEC * S.speed * STEP);
    // customers reaching the counter
    var changed = false;
    while (sim.idx < sim.cust.length && sim.cust[sim.idx].t <= sim.clock) {
      var p = sim.cust[sim.idx++];
      sim.snapNow = p.snap; changed = true;
      sim.said[p.why] = (sim.said[p.why] || 0) + 1;
      if (p.say && !p.quiet) { sim.feed.unshift({ s: p.say, m: p.mood, t: p.t }); if (sim.feed.length > 4) sim.feed.length = 4; }
      if (p.buy) {
        if (sim.parts.length < 5) sim.parts.push({ s: '+' + cents(sim.sum.price), col: C_LEMON, x: STAND_C - 8 + (sim.idx % 4) * 4.5, y: 2.6 - (sim.idx % 2) * 0.5, vy: -1.4, life: 1, max: 1 });
        if (S.speed < 4 || sim.idx % 3 === 0) sfx('sale');
      } else if (p.why === 'out') {
        if (!sim.outShown) { sim.outShown = true; sfx('out'); }
      } else if (p.why === 'price' && p.say && !p.quiet && S.speed === 1) sfx('nope');
    }
    if (changed) syncTicker();
    // particles
    for (var i = sim.parts.length - 1; i >= 0; i--) {
      var q = sim.parts[i];
      q.life -= STEP; q.y += q.vy * STEP;
      if (q.life <= 0) sim.parts.splice(i, 1);
    }
    // rain and storm
    if (wi >= 3) {
      var want = wi === 4 ? 60 : 34, r = sim.r;
      while (sim.drops.length < want) sim.drops.push({ x: r() * (COLS + 6), y: 1 + r() * 10, v: 9 + r() * 5 });
      for (i = 0; i < sim.drops.length; i++) {
        var d = sim.drops[i];
        d.y += d.v * STEP; d.x -= d.v * STEP * (wi === 4 ? 0.6 : 0.25);
        if (d.y > 11.5) { d.y = 1; d.x = r() * (COLS + 6); }
      }
      if (wi === 4) {
        if (sim.flash > 0) sim.flash = Math.max(0, sim.flash - STEP * 3);
        if (sim.bolt > 0) sim.bolt -= STEP;
        if (r() < STEP * 0.12 * S.speed) { sim.flash = 1; sim.bolt = 0.25; sim.boltX = 4 + Math.floor(r() * (COLS - 8)); sfx('thunder'); }
      }
    }
    if (sim.clock >= sim.end) finishSim();
  }
  function finishSim() {
    if (!S || !S.sim) return;
    stopLoop();
    S.sim = null;
    S.screen = 'report';
    sfx('close');
    render();
    draw(1);
  }
  function skipSim() {
    if (!S || !S.sim) return;
    var sim = S.sim;
    sim.idx = sim.cust.length;
    finishSim();
  }

  // ---- DOM: header, top bar, tabs, cards, pad ----
  function syncHead() {
    if (!S) return;
    var b = S.head.querySelector('[data-h="sound"]');
    b.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    b.classList.toggle('on', S.snd.on);
    b.title = S.snd.on ? 'Sound on' : 'Sound off'; b.setAttribute('aria-label', b.title);
    var pb = S.head.querySelector('[data-h="pause"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.screen !== 'sim';
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)'; pb.setAttribute('aria-label', pb.title);
  }
  function syncTop() {
    var g = S.g, el = S.top;
    if (!g || S.screen === 'menu' || S.screen === 'help' && !g) {
      el.innerHTML = '<span class="lm-brand">LEMONADE STAND</span><span class="lm-note">' + (g && g.phase !== 'over' ? 'game in progress' : 'a 30-day season') + '</span>';
      return;
    }
    var cash = S.sim ? g.cash - S.sim.sum.rev + (S.sim.snapNow ? S.sim.snapNow.rev : 0) : g.cash;
    el.innerHTML = '<span class="lm-day">DAY <b>' + g.day + '</b>' + (g.mode === 'season' ? '<i>/' + SEASON + '</i>' : '<i> endless</i>') + '</span>' +
      '<span class="lm-cash">' + money(cash) + '</span>' + repStars(S.sim ? S.sim.sum.repBefore : g.rep);
  }
  function syncTicker() {
    if (!S || !S.sim || !S.tick) return;
    var sn = S.sim.snapNow, sim = S.sim;
    var f = sim.feed.map(function (x) { return '<span class="' + (x.m > 0 ? 'g' : x.m < 0 ? 'b' : '') + '">' + esc(x.s) + '</span>'; }).join('');
    S.tick.innerHTML =
      '<div class="lm-tk-row"><span><i>sold</i> <b>' + sn.sold + '</b></span><span><i>takings</i> <b class="y">' + money(sn.rev) + '</b></span>' +
      '<span><i>passed</i> <b>' + sim.idx + '</b></span></div>' +
      '<div class="lm-tk-row lm-tk-inv">' + invChip('cups', sn.cups) + invChip('lemons', sn.lemons) + invChip('sugar', sn.sugar) + invChip('ice', sn.ice) +
      '<span><i>pitcher</i> <b>' + sn.pitcher + '</b></span></div>' +
      '<div class="lm-feed">' + (f || '<span class="q">…</span>') + '</div>';
    syncTop();
  }
  function invChip(id, n) { return '<span class="' + (n <= 0 ? 'b' : '') + '"><i>' + id + '</i> <b>' + n + '</b></span>'; }

  function render() {
    if (!S) return;
    syncTop(); syncHead();
    var g = S.g, scr = S.screen;
    S.root.classList.toggle('lm-simming', scr === 'sim');
    // the body under the street: tabs while planning, the ticker while open
    if (scr === 'sim') {
      S.body.innerHTML = '<div class="lm-tick"></div>';
      S.tick = S.body.querySelector('.lm-tick');
      syncTicker();
    } else if (g && (scr === 'plan' || scr === 'report' || scr === 'over')) {
      S.tick = null;
      if (g.phase === 'plan') renderPlan(); else S.body.innerHTML = '<div class="lm-tabbody lm-quiet"></div>';
    } else { S.tick = null; S.body.innerHTML = '<div class="lm-tabbody lm-quiet"></div>'; }
    // overlay card
    var card = '';
    if (scr === 'menu') card = menuCard();
    else if (scr === 'help') card = helpCard();
    else if (scr === 'report') card = reportCard();
    else if (scr === 'over') card = overCard();
    else if (scr === 'confirm') card = confirmCard();
    if (S.paused && scr === 'sim') card = pauseCard();
    S.ovl.innerHTML = card;
    S.ovl.style.display = card ? '' : 'none';
    S.main.classList.toggle('dim', !!card);
    if (card) S.ovl.scrollTop = 0;
    setPad();
    draw(1);
  }

  function renderPlan() {
    var keepScroll = S.body.querySelector('.lm-tabbody'), st = keepScroll ? keepScroll.scrollTop : 0, same = S.lastTab === S.tab;
    var tabs = '<div class="lm-tabs" role="tablist">' + TABS.map(function (t, i) {
      return '<button type="button" role="tab" data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '" aria-selected="' + (S.tab === t[0]) + '" title="' + t[1] + ' (' + (i + 1) + ')">' + t[1] + '</button>';
    }).join('') + '</div>';
    var html = S.tab === 'recipe' ? tabRecipe() : S.tab === 'weather' ? tabWeather() : S.tab === 'upgrades' ? tabUpgrades() : S.tab === 'books' ? tabBooks() : tabMarket();
    S.body.innerHTML = tabs + '<div class="lm-tabbody">' + html + '</div>';
    if (same) S.body.querySelector('.lm-tabbody').scrollTop = st;
    S.lastTab = S.tab;
  }
  function trend(g, id) {
    var p = g.px[id], q = g.pxPrev[id];
    if (p > q * 1.02) return '<span class="up" title="up since yesterday">▲</span>';
    if (p < q * 0.98) return '<span class="dn" title="down since yesterday">▼</span>';
    return '<span class="fl">·</span>';
  }
  function tabMarket() {
    var g = S.g, out = '', cpp = cupsPerPitcher(g);
    for (var i = 0; i < SUPPLIES.length; i++) {
      var s = SUPPLIES[i], n = stock(g, s.id), note = '';
      if (s.id === 'lemons') { var sp = spoilingTonight(g); if (sp) note = '<span class="warn">' + sp + ' spoil tonight</span>'; }
      if (s.id === 'ice') note = '<span class="lm-faint">' + (g.up.cooler ? 'half keeps overnight' : 'melts by tonight') + '</span>';
      var ev = (s.id === 'lemons' && eventOn(g, g.day, 'shortage')) ? ' <span class="warn">shortage</span>' : (s.id === 'sugar' && eventOn(g, g.day, 'sale')) ? ' <span class="good">sale!</span>' : '';
      out += '<div class="lm-sup"><div class="lm-sup-h"><b>' + s.name.toUpperCase() + '</b><span class="lm-stock' + (n <= 0 ? ' none' : '') + '">' + n + ' in stock</span>' + note +
        '<span class="lm-px">' + unitPx(priceOf(g, s.id)) + ' ea ' + trend(g, s.id) + ev + '</span></div><div class="lm-packs">';
      for (var k = 0; k < s.packs.length; k++) {
        var cost = packCost(g, s.id, k), poor = cost > g.cash;
        out += '<button type="button" class="lm-pack' + (poor ? ' poor' : '') + '" data-buy="' + s.id + '" data-k="' + k + '"' + (poor ? ' aria-disabled="true"' : '') +
          ' title="Buy ' + s.packs[k] + ' for ' + money(cost) + '">+' + s.packs[k] + ' <i>' + money(cost) + '</i></button>';
      }
      out += '</div></div>';
    }
    var can = cupsPossible(g), rec = g.rec;
    out += '<div class="lm-need">Recipe: <b>' + rec.L + '</b> lemons + <b>' + rec.S + '</b> sugar per pitcher (' + cpp + ' cups), <b>' + rec.ice + '</b> ice a cup. ' +
      'Stock makes <b class="' + (can ? '' : 'bad') + '">' + can + '</b> cups' + (rec.ice ? ' · ice for ~' + Math.floor(g.inv.ice / Math.max(1, rec.ice)) : '') + '.</div>';
    return out;
  }
  function stepper(key, label, sub, val) {
    return '<div class="lm-rrow"><span class="lm-lab">' + label + ' <i>' + sub + '</i></span><span class="lm-step">' +
      '<button type="button" data-step="' + key + '" data-d="-1" aria-label="less ' + label + '">−</button><b>' + val + '</b>' +
      '<button type="button" data-step="' + key + '" data-d="1" aria-label="more ' + label + '">+</button></span></div>';
  }
  function tabRecipe() {
    var g = S.g, rec = g.rec, cpc = costPerCup(g), last = g.last && g.last.day === g.day - 1 ? g.last : null;
    var out = '<div class="lm-recipe">' + stepper('L', 'Lemons', 'per pitcher', rec.L) + stepper('S', 'Sugar', 'cups per pitcher', rec.S) +
      stepper('ice', 'Ice', 'cubes per cup', rec.ice) + stepper('price', 'Price', 'per cup', cents(rec.price)) + '</div>';
    var margin = rec.price - cpc;
    out += '<div class="lm-need">Costs about <b>' + unitPx(cpc) + '</b> a cup at today\'s prices · margin <b class="' + (margin > 0 ? 'good' : 'bad') + '">' + (margin >= 0 ? '' : '−') + unitPx(Math.abs(margin)) + '</b> · a pitcher makes ' + cupsPerPitcher(g) + ' cups.</div>';
    if (last) {
      var s = last.said, keys = Object.keys(s).filter(function (k) { return k !== 'thirst'; }).sort(function (a, b) { return s[b] - s[a]; }).slice(0, 4);
      if (keys.length) out += '<div class="lm-need">Yesterday people said: ' + keys.map(function (k) {
        var cl = k === 'good' || k === 'deal' ? 'good' : 'bad';
        return '<span class="' + cl + '">' + ISSUE_NAME[k] + ' ×' + s[k] + '</span>';
      }).join(' · ') + '</div>';
    } else out += '<div class="lm-need lm-faint">Tip: balance lemons and sugar; hot days call for more ice. Customers will tell you.</div>';
    return out;
  }
  var WX_ART = [
    [' \\ | / ', '-- O --', ' / | \\ '],
    [' \\ .--.', '-(    ).', ' `----` '],
    ['  .--.  ', '.(    ).', '(___.__)'],
    [' .--.  ', '(____). ', ' , , , '],
    [' .--.  ', '(____). ', ' /_ , /']
  ];
  function wxArt(i) { return WX_ART[i].join('\n'); }
  function tabWeather() {
    var g = S.g, f = forecastFor(g, g.day, 0), out = '';
    var est = Math.round(trafficFor(g, f.i, f.temp, g.day));
    out += '<div class="lm-wx"><pre class="lm-wx-art wx' + f.i + '">' + esc(wxArt(f.i)) + '</pre><div class="lm-wx-txt"><b>Today: ' + WX[f.i].name + '</b>' +
      '<span>' + f.lo + '–' + f.hi + '°F</span><span class="lm-conf">confidence <b>' + f.acc + '%</b> <span class="lm-bar"><i style="width:' + f.acc + '%"></i></span></span>' +
      '<span class="lm-faint">expect ~' + est + ' passers-by</span></div></div>';
    var outl = '';
    for (var lead = 1; lead <= 2; lead++) {
      var d = g.day + lead;
      if (g.mode === 'season' && d > SEASON) break;
      var ff = forecastFor(g, d, lead);
      outl += '<div class="lm-ol"><span>' + (lead === 1 ? 'Tomorrow' : 'Day ' + d) + '</span><span class="wxc wx' + ff.i + '">' + WX[ff.i].ch + '</span><span>' + WX[ff.i].name + ', ~' + ff.temp + '°F</span><span class="lm-faint">' + ff.acc + '%</span></div>';
    }
    if (outl) out += '<div class="lm-h">Outlook</div>' + outl;
    var nw = news(g);
    out += '<div class="lm-h">News</div>';
    if (nw.length) out += nw.map(function (n) {
      return '<div class="lm-news ev-' + n.id + '"><b>' + esc(n.name) + '</b> <span class="lm-when">' + (n.when === 'now' ? 'today' + (n.left > 1 ? ' (' + n.left + ' days left)' : ' (last day)') : n.when + ' · ' + n.left + ' day' + (n.left > 1 ? 's' : '')) + '</span><div class="lm-faint">' + esc(n.text) + '</div></div>';
    }).join('');
    else out += '<div class="lm-faint">A quiet week on the block.</div>';
    if (!g.up.radio) out += '<div class="lm-faint lm-tip">A weather radio makes forecasts more reliable.</div>';
    return out;
  }
  function tabUpgrades() {
    var g = S.g, out = '';
    for (var i = 0; i < UPGRADES.length; i++) {
      var u = UPGRADES[i], own = !!g.up[u.id], poor = !own && u.price > g.cash;
      out += '<div class="lm-up' + (own ? ' own' : '') + '"><div><b>' + u.name + '</b><div class="lm-faint">' + esc(u.info) + '</div></div>' +
        (own ? '<span class="lm-owned">OWNED</span>' : '<button type="button" class="lm-pack' + (poor ? ' poor' : '') + '" data-up="' + u.id + '"' + (poor ? ' aria-disabled="true"' : '') + '>' + money(u.price) + '</button>') + '</div>';
    }
    return out;
  }
  function tabBooks() {
    var g = S.g, sm = summary(g), out = '';
    out += '<div class="lm-books"><div><i>cash</i> <b>' + money(g.cash) + '</b></div><div><i>since start</i> <b class="' + (sm.gain >= 0 ? 'good' : 'bad') + '">' + (sm.gain >= 0 ? '+' : '') + money(sm.gain) + '</b></div>' +
      '<div><i>reputation</i> <b>' + Math.round(g.rep) + '</b>/100</div><div><i>cups sold</i> <b>' + sm.sold + '</b></div>' +
      '<div><i>customers</i> <b>' + sm.cust + '</b> (' + sm.conv + '% bought)</div><div><i>satisfaction</i> <b>' + sm.sat + '%</b></div>' +
      '<div><i>wasted</i> ' + sm.spoiled + ' lemons, ' + sm.melted + ' ice</div>' + (sm.best ? '<div><i>best day</i> <b>' + money(sm.best.profit) + '</b> (day ' + sm.best.d + ')</div>' : '') + '</div>';
    if (g.hist.length >= 2) {
      var H = g.hist.slice(-30);
      out += '<pre class="lm-chart"><i>profit </i>' + esc(spark(H.map(function (h) { return h.profit; }))) + '\n<i>cash   </i>' + esc(spark(H.map(function (h) { return h.cash; }))) +
        '\n<i>sky    </i>' + esc(wxStrip(H)) + '</pre>';
    }
    out += '<div class="lm-btns">' + (g.mode === 'endless' ? '<button type="button" class="lm-go alt" data-act="retire">Retire &amp; score</button>' : '<button type="button" class="lm-go alt" data-act="abandon">Abandon season</button>') +
      '<button type="button" class="lm-go alt" data-act="menu">Menu</button></div>';
    return out;
  }

  // ---- overlay cards ----
  var LOGO = [
    "   .-----------.   ",
    "  /  LEMONADE   \\  ",
    "  |_____________|  ",
    "   |  [~] ooo  |   ",
    "   |===========|   "
  ].join('\n');
  function recRows(list) {
    if (!list.length) return '<i>no finished games yet</i>';
    return list.map(function (e, i) {
      return (i + 1) + '. <b>' + padL(money(e.s), 10) + '</b> <i>' + padR(DIFFS[e.diff].name, 7) + (e.d ? ' d' + e.d : '') + '</i>';
    }).join('\n');
  }
  function padL(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }
  function padR(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function menuCard() {
    var g = S.g, live = g && g.phase !== 'over', R = S.R;
    var h = '<div class="lm-card"><pre class="lm-art">' + esc(LOGO) + '</pre>';
    if (live) h += '<button type="button" class="lm-go" data-act="continue">Continue — day ' + g.day + (g.mode === 'season' ? '/' + SEASON : '') + ', ' + money(g.cash) + '</button>';
    h += '<div class="lm-h">New game</div><div class="lm-chips">' + DIFF_IDS.map(function (id) {
      return '<button type="button" class="lm-chip' + (S.newDiff === id ? ' on' : '') + '" data-diff="' + id + '" title="' + esc(DIFFS[id].info) + '">' + DIFFS[id].name + '</button>';
    }).join('') + '</div><div class="lm-note">' + esc(DIFFS[S.newDiff].info) + '</div>';
    h += '<div class="lm-btns"><button type="button" class="lm-go' + (live ? ' alt' : '') + '" data-act="new-season">Season · 30 days</button><button type="button" class="lm-go alt" data-act="new-endless">Endless</button></div>';
    h += '<div class="lm-h">High scores</div><pre class="lm-tab">' + '<b>season</b>\n' + recRows(R.season) + (R.endless.length ? '\n<b>endless</b>\n' + recRows(R.endless) : '') +
      (R.bestDay > 0 ? '\n<i>best day</i> ' + money(R.bestDay) + '  <i>most cups</i> ' + R.bestCups : '') + '</pre>';
    h += '<div class="lm-foot"><button type="button" class="lm-lnk" data-act="help">How to play</button>' + (g ? '<button type="button" class="lm-lnk" data-act="close-menu">Back</button>' : '') + '</div></div>';
    return h;
  }
  function helpCard() {
    return '<div class="lm-card"><div class="lm-title">HOW TO PLAY</div>' +
      '<p>Every morning, <b>buy supplies</b> (Market), set the <b>recipe and price</b> (Recipe), check the <b>forecast</b> (Weather), then <b>open the stand</b> and watch the day.</p>' +
      '<p>People buy when they are thirsty and the price is right. Hot, sunny days bring crowds; rain keeps them home. A good <b>reputation</b> brings more people who will pay more — earn it with tasty lemonade at a fair price, and never run out.</p>' +
      '<p><b>Taste:</b> balance lemons and sugar, and use more ice when it is hot. Customers say what they think — listen to them.</p>' +
      '<p><b>Waste:</b> ice melts through the day and overnight, lemons spoil after 4 days, a pitcher\'s leftovers are poured out at closing.</p>' +
      '<p><b>Forecasts</b> come with a confidence, and the outlook is shakier. The news warns of heat waves, rain, festivals, road works and price swings.</p>' +
      '<div class="lm-keys"><span><b>Enter</b> open stand / next day</span><span><b>1–5</b> tabs · <b>P</b> pause · <b>S</b> skip the day</span><span><b>Esc</b> pause / close</span></div>' +
      '<button type="button" class="lm-go" data-act="close-help">Got it</button></div>';
  }
  function pauseCard() {
    return '<div class="lm-card"><div class="lm-title">PAUSED</div><p class="lm-sub">' + clock(S.sim ? S.sim.clock : 0) + ' — the street waits.</p>' +
      '<div class="lm-btns"><button type="button" class="lm-go" data-act="resume">Resume</button><button type="button" class="lm-go alt" data-act="skip">Skip to closing</button></div></div>';
  }
  function confirmCard() {
    var c = S.confirm || {};
    return '<div class="lm-card"><div class="lm-title">' + esc(c.title || 'SURE?') + '</div><p class="lm-sub">' + esc(c.text || '') + '</p>' +
      '<div class="lm-btns"><button type="button" class="lm-go danger" data-act="confirm-yes">' + esc(c.yes || 'Yes') + '</button><button type="button" class="lm-go alt" data-act="confirm-no">Cancel</button></div></div>';
  }
  function reportCard() {
    var g = S.g, r = g.last;
    if (!r) return '';
    var W = WX[r.wx.i], F = WX[r.fc.i], hit = r.fc.i === r.wx.i, conv = r.n ? Math.round(r.sold / r.n * 100) : 0;
    var dRep = Math.round((r.rep - r.repBefore) * 10) / 10;
    var lines = [];
    lines.push(row('passers-by', r.n + '  <i>bought ' + r.sold + ' (' + conv + '%)</i>'));
    lines.push(row('takings', money(r.rev) + '  <i>' + r.sold + ' × ' + cents(r.price) + '</i>'));
    lines.push(row('supplies', '−' + money(r.spent)));
    if (r.upSpent) lines.push(row('upgrades', '−' + money(r.upSpent)));
    lines.push(row('profit', '<b class="' + (r.profit >= 0 ? 'g' : 'r') + '">' + (r.profit >= 0 ? '+' : '−') + money(Math.abs(r.profit)) + '</b>'));
    lines.push(row('cash', money(r.cash)));
    lines.push(row('reputation', Math.round(r.repBefore) + ' → <b>' + Math.round(r.rep) + '</b> ' + (dRep > 0.4 ? '<span class="g">▲</span>' : dRep < -0.4 ? '<span class="r">▼</span>' : '<i>·</i>')));
    if (r.sold) lines.push(row('taste', r.taste + '%  <i>happy ' + r.sat + '%</i>'));
    var waste = [];
    if (r.spoiled) waste.push(r.spoiled + ' lemons spoiled');
    if (r.melted) waste.push(r.melted + ' ice melted');
    if (r.poured) waste.push(r.poured + ' cups poured out');
    var s = r.said, keys = Object.keys(s).sort(function (a, b) { return s[b] - s[a]; }).slice(0, 5);
    var h = '<div class="lm-card"><div class="lm-title">DAY ' + r.day + '</div>' +
      '<div class="lm-sub"><span class="wxc wx' + r.wx.i + '">' + W.ch + '</span> ' + W.name + ', ' + r.wx.temp + '°F' +
      (hit ? ' <i class="g">forecast right</i>' : ' <i>forecast said ' + F.name.toLowerCase() + '</i>') + '</div>' +
      (r.events.length ? '<div class="lm-note">' + r.events.map(function (e) { return EVT[e].name; }).join(' · ') + '</div>' : '') +
      '<pre class="lm-tab">' + lines.join('\n') + '</pre>';
    if (keys.length) h += '<div class="lm-said">' + keys.map(function (k) {
      var cl = k === 'good' || k === 'deal' ? 'g' : k === 'thirst' ? '' : 'r';
      return '<span class="' + cl + '">' + ISSUE_NAME[k] + ' <b>×' + s[k] + '</b></span>';
    }).join('') + '</div>';
    if (r.outAt >= 0) h += '<p class="r">Sold out at ' + clock(r.outAt) + ' — ' + r.out + ' turned away.</p>';
    if (waste.length) h += '<p class="lm-faint">Waste: ' + waste.join(' · ') + '</p>';
    var tips = tipsFor(r, g);
    if (tips.length) h += '<div class="lm-tips">' + tips.map(function (t) { return '<p>› ' + esc(t) + '</p>'; }).join('') + '</div>';
    if (S.newBest) h += '<div class="lm-new">★ new record day ★</div>';
    var last = g.mode === 'season' && g.day >= SEASON;
    h += '<button type="button" class="lm-go" data-act="next">' + (last ? 'Season report ▶' : 'Next day ▶') + '</button></div>';
    return h;
    function row(k, v) { return '<i>' + padR(k, 11) + '</i>' + v; }
  }
  function overCard() {
    var g = S.g, sm = summary(g), why = g.endReason;
    var title = why === 'broke' ? 'OUT OF BUSINESS' : why === 'retired' ? 'RETIRED' : 'SEASON OVER';
    var H = g.hist.slice(-30), h = '<div class="lm-card wide"><div class="lm-title">' + title + '</div>';
    h += '<div class="lm-big">' + money(g.cash) + '</div><div class="lm-sub">' + (why === 'broke' ? 'Out of cash and stock on day ' + g.day + '.' : 'after ' + sm.days + ' day' + (sm.days === 1 ? '' : 's') + ' · ' + DIFFS[g.diff].name + (g.mode === 'endless' ? ' · endless' : '')) + '</div>';
    if (S.rank) h += '<div class="lm-new">#' + S.rank + ' on the ' + (g.mode === 'endless' ? 'endless' : 'season') + ' board' + (S.rank === 1 ? ' — a new high score!' : '') + '</div>';
    if (H.length) {
      var B = bars(H.map(function (x) { return x.profit; }), 6), lab = [];
      var top = money(B.unit * B.posRows), bot = B.negRows ? '−' + money(B.unit * B.negRows) : '';
      for (var i = 0; i < B.lines.length; i++) {
        var l = i === 0 ? top : i === B.posRows ? '$0' : i === B.lines.length - 1 && bot ? bot : '';
        lab.push(padL(l, 8) + ' ' + B.lines[i]);
      }
      var axis = '', dl = '';
      for (i = 0; i < H.length; i++) { axis += (H[i].d % 5 === 0) ? '|' : ' '; }
      for (i = 0; i < H.length; i++) {
        if (H[i].d % 5 === 0 && dl.length <= i) { var sd = String(H[i].d); dl += padR('', i - dl.length) + sd; }
      }
      h += '<div class="lm-h">Profit per day</div><pre class="lm-chart">' + esc(lab.join('\n')) + '\n' + padL('day', 8) + ' ' + esc(dl) + '</pre>';
      h += '<pre class="lm-chart"><i>cash    </i>' + esc(spark(H.map(function (x) { return x.cash; }))) + '\n<i>cups    </i>' + esc(spark(H.map(function (x) { return x.sold; }))) +
        '\n<i>rep     </i>' + esc(spark(H.map(function (x) { return x.rep; }))) + '\n<i>sky     </i>' + esc(wxStrip(H)) + '\n<i>         * sun ~ cloud = grey / rain ! storm</i></pre>';
    }
    h += '<pre class="lm-tab"><i>cups sold   </i><b>' + sm.sold + '</b>  <i>of ' + sm.cust + ' passers-by (' + sm.conv + '%)</i>\n' +
      '<i>takings     </i>' + money(sm.rev) + '  <i>spent</i> ' + money(sm.spent) + '\n' +
      '<i>happiness   </i>' + sm.sat + '%  <i>reputation</i> ' + Math.round(sm.rep) + '\n' +
      (sm.best ? '<i>best day    </i>' + money(sm.best.profit) + ' <i>(day ' + sm.best.d + ')</i>\n' : '') +
      '<i>waste       </i>' + sm.spoiled + ' lemons · ' + sm.melted + ' ice · ' + sm.poured + ' cups\n' +
      '<i>upgrades    </i>' + sm.ups + '/' + UPGRADES.length + '</pre>';
    h += '<div class="lm-btns"><button type="button" class="lm-go" data-act="new-same">Play again</button><button type="button" class="lm-go alt" data-act="menu">Menu</button></div></div>';
    return h;
  }

  function setPad() {
    var scr = S.screen, g = S.g, h = '';
    if (scr === 'sim') {
      h = '<button type="button" class="lm-act alt" data-act="speed" title="Speed (F)">×' + S.speed + '<small>speed</small></button>' +
        '<button type="button" class="lm-act" data-act="skip">Skip to closing ▸▸</button>';
    } else if (scr === 'plan' && g && g.phase === 'plan') {
      var can = cupsPossible(g);
      h = '<button type="button" class="lm-act" data-act="open">Open stand ▶<small>' + (can ? can + ' cups ready · ' + cents(g.rec.price) : 'nothing to sell yet') + '</small></button>';
    } else if (scr === 'report') {
      h = '<button type="button" class="lm-act" data-act="next">' + (g && g.mode === 'season' && g.day >= SEASON ? 'Season report ▶' : 'Next day ▶') + '</button>';
    } else if (scr === 'over') {
      h = '<button type="button" class="lm-act" data-act="new-same">Play again ▶</button>';
    } else if (scr === 'menu') {
      h = g && g.phase !== 'over' ? '<button type="button" class="lm-act" data-act="continue">Continue ▶</button>' : '<button type="button" class="lm-act" data-act="new-season">New season ▶</button>';
    } else if (scr === 'help') h = '<button type="button" class="lm-act" data-act="close-help">Got it ▶</button>';
    else if (scr === 'confirm') h = '<button type="button" class="lm-act alt" data-act="confirm-no">Cancel</button>';
    if (S.padHtml !== h) {
      // A new big button lands where the old one was: ignore taps on it for a moment, so a quick
      // double tap on "Next day" doesn't also open the stand (or "Open stand" also skip the day).
      var acts = h.replace(/[^]*?data-act="([^"]*)"|[^]+$/g, '$1,');
      if (S.padActs != null && S.padActs !== acts) S.padAt = Date.now();
      S.pad.innerHTML = h; S.padHtml = h; S.padActs = acts;
    }
  }

  // ---- actions ----
  function screenFor(g) { return !g ? 'menu' : g.phase === 'plan' ? 'plan' : g.phase === 'report' ? 'report' : 'over'; }
  function newGameNow(mode) {
    S.g = newGame({ mode: mode, diff: S.newDiff });
    S.rank = 0; S.newBest = false; S.tab = 'market'; S.lastMode = mode;
    saveGame();
    S.screen = 'plan';
    sfx('open');
    render();
    say('Day 1. Buy some supplies to get started.');
  }
  function askNew(mode) {
    if (S.g && S.g.phase !== 'over' && S.g.day > 1) {
      S.confirm = { title: 'NEW GAME?', text: 'This ends the game in progress (day ' + S.g.day + ', ' + money(S.g.cash) + ') without a score.', yes: 'Start over', then: function () { newGameNow(mode); }, back: 'menu' };
      S.screen = 'confirm'; render();
      return;
    }
    newGameNow(mode);
  }
  function openStand() {
    var g = S.g;
    if (!g || g.phase !== 'plan' || S.sim) return;
    if (cupsPossible(g) <= 0 && S.armOpen && Date.now() - (S.armAt || 0) < 500) return;   // a double tap is not a "yes"
    if (cupsPossible(g) <= 0 && !S.armOpen) {
      S.armOpen = true; S.armAt = Date.now();
      var why = g.inv.cups < 1 ? 'cups' : lemonCount(g) < g.rec.L ? 'lemons' : 'sugar';
      if (Cade.showToast) Cade.showToast('No ' + why + ' — you can\'t sell anything. Press again to open anyway.', 'info', 2600);
      S.tab = 'market'; render();
      return;
    }
    S.armOpen = false;
    var before = { cups: g.inv.cups, lemons: lemonCount(g), sugar: g.inv.sugar, ice: Math.floor(g.inv.ice) };
    var out = simDay(g);
    if (!out) return;
    out.before = before;
    S.newBest = noteDay(S.R, out.sum) && out.sum.profit > 0;
    saveGame(); saveRecs();
    startSim(out);
  }
  function nextDayNow() {
    var g = S.g;
    if (!g) return;
    if (g.phase === 'report') nextDay(g);
    S.newBest = false;
    if (g.phase === 'over') endGame();
    else {
      saveGame();
      S.screen = 'plan';
      var nw = news(g).filter(function (n) { return n.when !== 'now' || n.left === EVT[n.id].len[0]; });
      render();
      say('Day ' + g.day + '. ' + (nw.length ? nw[0].name + ' ' + (nw[0].when === 'now' ? 'today' : nw[0].when) + '.' : ''));
      if (nw.length && Cade.showToast) {
        var first = nw[0];
        if (first.when !== 'now' || g.events.some(function (e) { return e.id === first.id && e.s === g.day; })) Cade.showToast('📰 ' + first.text, 'info', 2600);
      }
    }
  }
  function endGame() {
    var g = S.g;
    S.rank = addRecord(S.R, g, Date.now());
    saveRecs(); saveGame();
    S.screen = 'over';
    sfx(g.endReason === 'broke' ? 'out' : 'fanfare');
    render();
  }
  function stepRecipe(key, d) {
    var g = S.g;
    if (!g || g.phase !== 'plan') return false;
    var before = g.rec[key], step = key === 'price' ? (g.rec.price >= 100 ? 10 : 5) : 1;
    if (key === 'price' && d < 0 && g.rec.price <= 100 && g.rec.price > 95) step = 5;
    setRecipe(g, key, before + d * step);
    if (g.rec[key] === before) return false;
    saveGame(); sfx('step'); S.armOpen = false;
    renderPlan(); setPad(); draw(1);
    return true;
  }
  function pause() {
    if (!S || S.screen !== 'sim' || S.paused) return;
    S.paused = true; stopLoop(); render();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false; render(); startLoop();
  }
  function say(t) { if (S && S.live) S.live.textContent = t; }
  function primary() {
    var scr = S.screen;
    if (scr === 'plan') openStand();
    else if (scr === 'report') nextDayNow();
    else if (scr === 'over') act('new-same');
    else if (scr === 'menu') act(S.g && S.g.phase !== 'over' ? 'continue' : 'new-season');
    else if (scr === 'help') act('close-help');
    else if (scr === 'sim') { if (S.paused) resume(); }
  }
  function act(a, el) {
    if (!S) return;
    var g = S.g;
    if (a === 'open') openStand();
    else if (a === 'next') nextDayNow();
    else if (a === 'skip') { if (S.paused) S.paused = false; skipSim(); }
    else if (a === 'speed') { S.speed = S.speed === 1 ? 2 : S.speed === 2 ? 4 : 1; sset(SPEED_KEY, S.speed); S.padHtml = ''; setPad(); }
    else if (a === 'resume') resume();
    else if (a === 'continue' || a === 'close-menu') { S.screen = screenFor(g); render(); }
    else if (a === 'new-season') askNew('season');
    else if (a === 'new-endless') askNew('endless');
    else if (a === 'new-same') { S.g = null; saveGame(); newGameNow(S.lastMode || (g && g.mode) || 'season'); }
    else if (a === 'menu') { S.screen = 'menu'; render(); }
    else if (a === 'help') { S.helpBack = S.screen; S.screen = 'help'; render(); }
    else if (a === 'close-help') { S.screen = S.helpBack && S.helpBack !== 'help' ? S.helpBack : screenFor(g); if (!S.g && S.screen !== 'menu') S.screen = 'menu'; render(); }
    else if (a === 'retire') {
      S.confirm = { title: 'RETIRE?', text: 'Close the stand for good and put ' + money(g.cash) + ' on the endless board.', yes: 'Retire', then: function () { retire(S.g); endGame(); }, back: 'plan' };
      S.screen = 'confirm'; render();
    } else if (a === 'abandon') {
      S.confirm = { title: 'ABANDON?', text: 'Throw away this season (day ' + g.day + ') without a score.', yes: 'Abandon', then: function () { S.g = null; saveGame(); S.screen = 'menu'; render(); }, back: 'plan' };
      S.screen = 'confirm'; render();
    } else if (a === 'confirm-yes') { var c = S.confirm; S.confirm = null; if (c && c.then) c.then(); }
    else if (a === 'confirm-no') { var c2 = S.confirm; S.confirm = null; S.screen = c2 && c2.back === 'plan' && S.g ? screenFor(S.g) : 'menu'; render(); }
    void el;
  }

  // ---- layout ----
  function layout() {
    var vw = window.innerWidth || 800, solo = S.panel.classList.contains('cade-solo-panel'), phone = vw <= 560;
    var w = Math.floor(Math.min(vw - (phone ? 34 : 48), solo ? 760 : 540));
    w = Math.max(260, w);
    var cw = w / COLS, rh = Math.round(cw * 1.72 * 100) / 100, h = Math.round(rh * ROWS), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.root.style.setProperty('--lm-w', w + 'px');
    S.cv.style.width = w + 'px'; S.cv.style.height = h + 'px';
    S.cv.width = Math.round(w * dpr); S.cv.height = Math.round(h * dpr);
    S.k = dpr; S.cwp = S.cv.width / COLS; S.rhp = S.cv.height / ROWS;
    if (S.font) fitFont();
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT); clearTimeout(s.holdT); clearInterval(s.holdI);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    window.removeEventListener('pointerup', s.onHoldEnd, true);
    window.removeEventListener('pointercancel', s.onHoldEnd, true);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    if (s.atl) freeCanvas(s.atl.cv);
    freeCanvas(s.cv);
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (t && t.isContentEditable && !S.panel.contains(t)) return;
    var k = e.key, scr = S.screen;
    if (k === 'Escape') {
      e.preventDefault();
      if (scr === 'sim') { if (S.paused) resume(); else pause(); }
      else if (scr === 'help') act('close-help');
      else if (scr === 'confirm') act('confirm-no');
      else if (scr === 'menu' && S.g) act('close-menu');
      else closePanel();
      return;
    }
    if (scr === 'sim') {
      if (k === 'p' || k === 'P' || k === ' ') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
      if (k === 's' || k === 'S') { e.preventDefault(); act('skip'); return; }
      if (k === 'f' || k === 'F') { e.preventDefault(); act('speed'); return; }
      if (k === 'Enter') { e.preventDefault(); if (S.paused) resume(); return; }
      return;
    }
    if (scr === 'plan' && /^[1-5]$/.test(k)) { e.preventDefault(); S.tab = TABS[+k - 1][0]; renderPlan(); return; }
    if (k === 'Enter' || k === ' ') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;   // a focused button does its own thing
      e.preventDefault();
      if (!e.repeat) primary();
    }
  }

  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="lm"><div class="lm-top"></div><div class="lm-main"><div class="lm-stage"><canvas class="lm-cv"></canvas></div>' +
      '<div class="lm-body"></div><div class="lm-ovl" style="display:none"></div></div><div class="lm-pad"></div><div class="lm-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🍋 Lemonade Stand', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'lm-hb';
    hb.innerHTML = '<button type="button" data-h="menu" title="Menu" aria-label="Menu">' + IC_MENU + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-popbtn') || p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var g = normGame(loadJSON(GAME_KEY)), sp = +sget(SPEED_KEY);
    S = {
      panel: p, head: hb, root: p.querySelector('.lm'), top: p.querySelector('.lm-top'), main: p.querySelector('.lm-main'), stage: p.querySelector('.lm-stage'),
      cv: p.querySelector('.lm-cv'), body: p.querySelector('.lm-body'), ovl: p.querySelector('.lm-ovl'), pad: p.querySelector('.lm-pad'), live: p.querySelector('.lm-live'),
      g: g, R: normRecs(loadJSON(REC_KEY)), snd: new Snd(sget(SOUND_KEY) === '1'), pal: new Array(NPAL), atl: null,
      screen: 'menu', tab: 'market', lastTab: null, speed: sp === 2 || sp === 4 ? sp : 1, paused: false, sim: null, raf: 0, last: 0,
      newDiff: g ? g.diff : 'normal', lastMode: g ? g.mode : 'season', rank: 0, newBest: false, confirm: null, padHtml: null, armOpen: false
    };
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    layout();
    readTheme();
    if (g) S.screen = g.phase === 'over' ? 'over' : 'menu';
    if (g && g.phase === 'over') { S.rank = 0; }
    if (!g && !sget(SEEN_KEY)) { sset(SEEN_KEY, '1'); S.screen = 'help'; S.helpBack = 'menu'; }

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { pause(); };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (!S || S.panel !== p) return; pause(); stopLoop(); });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        layout(); draw(1);
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); draw(1); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); draw(1);
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    // header: menu / help / sound / pause (the header drags the panel — these are controls)
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') {
        if (S.screen === 'sim') { pause(); return; }
        if (S.screen === 'help') act('close-help'); else act('help');
      } else if (h === 'menu') {
        if (S.screen === 'sim') { pause(); return; }
        if (S.screen === 'menu') { if (S.g) act('close-menu'); } else act('menu');
      }
      try { b.blur(); } catch (er) {}
    });

    // Rapid tapping must never zoom, select, magnify or open a callout.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.cv.addEventListener('pointerdown', function () {
      if (!S) return;
      S.snd.ensure();
      if (S.screen === 'sim') { if (S.paused) resume(); }
    });
    // steppers: press (and hold to repeat)
    function holdEnd() { if (!S) return; clearTimeout(S.holdT); clearInterval(S.holdI); S.holdT = 0; S.holdI = 0; }
    S.onHoldEnd = holdEnd;
    window.addEventListener('pointerup', holdEnd, true);
    window.addEventListener('pointercancel', holdEnd, true);
    S.body.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-step]') : null;
      if (!b || !S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      var key = b.getAttribute('data-step'), d = +b.getAttribute('data-d');
      holdEnd();
      stepRecipe(key, d);
      S.holdT = setTimeout(function () { if (S) S.holdI = setInterval(function () { if (!S || !stepRecipe(key, d)) holdEnd(); }, key === 'price' ? 70 : 140); }, 380);
    });
    S.body.addEventListener('touchstart', function (e) { if (e.target.closest && e.target.closest('[data-step]')) noTouch(e); }, { passive: false });
    S.body.addEventListener('touchend', function (e) { if (e.target.closest && e.target.closest('[data-step]')) noTouch(e); }, { passive: false });
    S.body.addEventListener('contextmenu', function (e) { if (e.target.closest && e.target.closest('[data-step]')) e.preventDefault(); });
    S.body.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var g = S.g;
      if (b.hasAttribute('data-step')) {
        if (e.detail === 0) stepRecipe(b.getAttribute('data-step'), +b.getAttribute('data-d'));   // keyboard
        refocus('[data-step="' + b.getAttribute('data-step') + '"][data-d="' + b.getAttribute('data-d') + '"]', e);
        return;
      }
      var tab = b.getAttribute('data-tab'), buy = b.getAttribute('data-buy'), up = b.getAttribute('data-up'), a = b.getAttribute('data-act');
      if (tab) { S.tab = tab; renderPlan(); refocus('[data-tab="' + tab + '"]', e); }
      else if (buy && g) {
        var k = +b.getAttribute('data-k'), cost = buySupply(g, buy, k);
        if (cost) {
          sfx('buy'); saveGame(); S.armOpen = false;
          b.classList.add('flash');
          renderPlan(); syncTop(); setPad(); draw(1);
          say('Bought ' + SUP[buy].packs[k] + ' ' + SUP[buy].name.toLowerCase() + ' for ' + money(cost));
          refocus('[data-buy="' + buy + '"][data-k="' + k + '"]', e, true);
        } else {
          sfx('nope');
          if (Cade.showToast) Cade.showToast('Not enough cash (' + money(g.cash) + ')', 'info', 1600);
        }
      } else if (up && g) {
        if (buyUpgrade(g, up)) {
          sfx('upgrade'); saveGame(); Cade.haptic && Cade.haptic(10);
          renderPlan(); syncTop(); draw(1);
          if (Cade.showToast) Cade.showToast(UPG[up].name + ' installed!', 'success', 1800);
        } else { sfx('nope'); if (Cade.showToast) Cade.showToast('Needs ' + money(UPG[up].price) + ' (you have ' + money(g.cash) + ')', 'info', 1800); }
      } else if (a) act(a, b);
    });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var d = b.getAttribute('data-diff');
      if (d) { S.newDiff = d; render(); refocus('[data-diff="' + d + '"]', e); return; }
      var a = b.getAttribute('data-act');
      if (a) act(a, b);
    });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b || !S) return;
      if (e.detail !== 0 || e.isTrusted === false) { if (Date.now() - (S.padAt || 0) < 350) return; }
      S.snd.ensure();
      act(b.getAttribute('data-act'), b);
    });
    S.pad.addEventListener('touchend', function (e) {
      // quick double taps on the pad must not zoom; turn the tap into a click ourselves
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      noTouch(e);
      b.click();
    }, { passive: false });

    render();
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); draw(1); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('600 12px ' + S.font).then(function () { if (S && S.panel === p) { fitFont(); draw(1); } }, function () {});
      }
    } catch (e) {}
  }
  // After a re-render the clicked button is a new element: keep keyboard focus on its twin.
  function refocus(sel, e, always) {
    if (!S || (!always && e && e.detail !== 0)) return;
    if (e && e.detail !== 0) return;
    var nb = S.panel.querySelector(sel);
    if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Run a lemonade stand for a 30-day season — supplies, recipe, price, fickle weather, events and upgrades',
    icon: '🍋',
    tags: 'game,sim,business,lemonade,economy,tycoon,weather,shop,stand,ascii',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
