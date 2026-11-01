/* Tiny Farm — an idle ASCII farm that grows in real time, for Cade.txt.
 * Plant crops in your plots, water them (wet soil grows twice as fast), harvest
 * when ripe and sell the harvest at the market in your barn. Everything runs on
 * real timestamps: close the panel (or the app) and the farm keeps growing —
 * on open the engine replays the time you were away, deterministically, and a
 * "while you were away" card says what happened.
 * Seasons turn every 7 real days (spring, summer, autumn, winter) and each crop
 * can only be sown in its seasons. Weather changes every 3 hours: rain waters
 * every plot, snow slows anything that isn't a winter crop. Crows land on young
 * crops (tap to shoo them before they peck), bugs stop a plot growing until
 * squashed, bees speed crops up, neighbours leave gifts. Upgrades: a bigger
 * watering can, sprinklers, a scarecrow and a bigger barn; more land; chickens
 * and cows that lay / give while you're away. Daily gift with a streak, levels
 * that unlock seeds, a daily-moving market, golden crops, achievements.
 * The pure engine (top half) has no DOM and is unit-checked in node
 * (tinyfarm.test.js). The UI draws an animated ASCII scene on a canvas (cached
 * glyph atlas, theme colours) and the plots as DOM buttons in a monospace grid.
 * Not a game panel: nothing global is captured, typing elsewhere keeps working.
 * Persisted in Cade.store under cade-tinyfarm-* (versioned save). No assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
  var VERSION = 1;
  var WX_BLOCK = 3 * HOUR;          // weather changes this often
  var EV_BLOCK = 15 * MIN;          // at most one farm event (crow / bug / bees / gift) per block
  var CROW_WAIT = 90 * SEC;         // a crow pecks this long after landing unless shooed
  var PEST_MAX = 2 * HOUR;          // a bug wanders off after this long
  var PECK = 0.2;                   // a peck sets the crop back by this share of its grow time
  var BEES = 0.25;                  // bees push a crop on by this share
  var WET_MUL = 2, SNOW_MUL = 0.5;
  var SEASON_DAYS = 7, MAX_AWAY = 45 * DAY;
  var GOLD_P = 0.04, GOLD_X = 5, GOLD_EGG_P = 0.03;
  var START_PLOTS = 6, MAX_PLOTS = 24, START_COINS = 30, MAX_LV = 30;
  var SP = 1, SU = 2, AU = 4, WI = 8, ANY = 15;

  var SEASONS = [
    { id: 'spring', name: 'Spring', ch: '*' },
    { id: 'summer', name: 'Summer', ch: 'O' },
    { id: 'autumn', name: 'Autumn', ch: '%' },
    { id: 'winter', name: 'Winter', ch: '#' }
  ];
  var WX = {
    sun: { id: 'sun', name: 'Sunny', ch: 'O', wet: false },
    cloud: { id: 'cloud', name: 'Cloudy', ch: '=', wet: false },
    rain: { id: 'rain', name: 'Rain', ch: '/', wet: true },
    storm: { id: 'storm', name: 'Storm', ch: 'Z', wet: true },
    snow: { id: 'snow', name: 'Snow', ch: '*', wet: false }
  };
  var WX_TABLE = [
    [['sun', 0.45], ['cloud', 0.25], ['rain', 0.25], ['storm', 0.05]],
    [['sun', 0.62], ['cloud', 0.16], ['rain', 0.14], ['storm', 0.08]],
    [['sun', 0.36], ['cloud', 0.32], ['rain', 0.27], ['storm', 0.05]],
    [['sun', 0.3], ['cloud', 0.32], ['snow', 0.33], ['rain', 0.05]]
  ];

  // Crops. grow: seconds to ripen when dry; cost: seed price; sell: base price per unit;
  // y: units per harvest; lv: level that unlocks it; re/reN: regrows in re seconds, reN harvests in all.
  // a: ready art (3 lines x 5), m: its colour mask (f fruit, g leaf, b brown).
  var CROPS = [
    { id: 'cress', name: 'Cress', ch: ':', col: 'lime', sea: ANY, grow: 120, cost: 2, sell: 4, y: 1, xp: 1, lv: 1,
      a: ['     ', ' .:. ', ' \\|/ '], m: ['     ', ' fff ', ' ggg '] },
    { id: 'radish', name: 'Radish', ch: 'o', col: 'pink', sea: SP | AU, grow: 300, cost: 5, sell: 13, y: 1, xp: 2, lv: 1,
      a: ['     ', ' \\|/ ', ' (o) '], m: ['     ', ' ggg ', ' fff '] },
    { id: 'lettuce', name: 'Lettuce', ch: '@', col: 'lime', sea: SP | SU, grow: 600, cost: 8, sell: 28, y: 1, xp: 3, lv: 2,
      a: ['     ', ' .@. ', '(@@@)'], m: ['     ', ' fff ', 'fffff'] },
    { id: 'kale', name: 'Kale', ch: '}', col: 'sky', sea: AU | WI, grow: 900, cost: 6, sell: 30, y: 1, xp: 3, lv: 2,
      a: ['     ', '{\\|/}', ' }|{ '], m: ['     ', 'fgggf', ' fgf '] },
    { id: 'carrot', name: 'Carrot', ch: 'V', col: 'orange', sea: SP | AU, grow: 1500, cost: 10, sell: 22, y: 2, xp: 4, lv: 3,
      a: ['  |  ', ' \\|/ ', ' \\V/ '], m: ['  g  ', ' ggg ', ' fff '] },
    { id: 'wheat', name: 'Wheat', ch: ';', col: 'gold', sea: SP | SU | AU, grow: 1800, cost: 6, sell: 14, y: 3, xp: 4, lv: 3,
      a: [' ; ; ', ';|;|;', '|||||'], m: [' f f ', 'fgfgf', 'ggggg'] },
    { id: 'tomato', name: 'Tomato', ch: 'o', col: 'red', sea: SU, grow: 2700, cost: 25, sell: 20, y: 2, xp: 5, lv: 4, re: 1200, reN: 4,
      a: [' \\|/ ', 'o-|-o', '  |o '], m: [' ggg ', 'fgggf', '  gf '] },
    { id: 'peas', name: 'Peas', ch: '0', col: 'lime', sea: WI | SP, grow: 2400, cost: 15, sell: 8, y: 3, xp: 4, lv: 4, re: 900, reN: 4,
      a: [' ~|~ ', '0~|~0', ' ~|~ '], m: [' ggg ', 'fgggf', ' ggg '] },
    { id: 'corn', name: 'Corn', ch: '#', col: 'gold', sea: SU | AU, grow: 5400, cost: 30, sell: 55, y: 2, xp: 8, lv: 5,
      a: ['  ^  ', ' {#} ', ' \\|/ '], m: ['  g  ', ' gfg ', ' ggg '] },
    { id: 'sunflower', name: 'Sunflower', ch: '*', col: 'gold', sea: SU, grow: 3600, cost: 20, sell: 90, y: 1, xp: 7, lv: 5,
      a: [' \\*/ ', ' -@- ', '  |  '], m: [' fff ', ' fbf ', '  g  '] },
    { id: 'garlic', name: 'Garlic', ch: 'W', col: 'bone', sea: WI, grow: 7200, cost: 25, sell: 40, y: 3, xp: 9, lv: 6,
      a: ['  |  ', '  |  ', ' (W) '], m: ['  g  ', '  g  ', ' fff '] },
    { id: 'berry', name: 'Berries', ch: '%', col: 'violet', sea: SP | SU, grow: 3600, cost: 40, sell: 12, y: 3, xp: 6, lv: 6, re: 1800, reN: 5,
      a: [' o o ', 'o\\|/o', ' \\|/ '], m: [' f f ', 'fgggf', ' ggg '] },
    { id: 'melon', name: 'Melon', ch: '=', col: 'leaf', sea: SU, grow: 14400, cost: 80, sell: 300, y: 1, xp: 18, lv: 7,
      a: ['     ', ' ~\\_ ', '(=#=)'], m: ['     ', ' ggg ', 'fffff'] },
    { id: 'pumpkin', name: 'Pumpkin', ch: 'O', col: 'orange', sea: AU, grow: 18000, cost: 90, sell: 380, y: 1, xp: 22, lv: 7,
      a: ['  \\_ ', '.-|-.', '(_|_)'], m: ['  gg ', 'fffff', 'fffff'] },
    { id: 'mushroom', name: 'Mushrooms', ch: 'T', col: 'brown', sea: AU | WI, grow: 10800, cost: 50, sell: 75, y: 2, xp: 12, lv: 8,
      a: ['     ', ' .-. ', '(___)'], m: ['     ', ' fff ', 'fffff'] },
    { id: 'starfruit', name: 'Starfruit', ch: '+', col: 'gold', sea: ANY, grow: 43200, cost: 300, sell: 1500, y: 1, xp: 60, lv: 10,
      a: [' \\*/ ', '-*+*-', ' /|\\ '], m: [' fff ', 'fffff', ' ggg '] }
  ];
  var CROP = {};
  for (var ci0 = 0; ci0 < CROPS.length; ci0++) { CROPS[ci0].idx = ci0; CROP[CROPS[ci0].id] = CROPS[ci0]; }
  // growing stages, shared by every crop
  var STAGES = [
    { a: ['     ', '     ', '  .  '], m: ['     ', '     ', '  b  '] },
    { a: ['     ', '  ,  ', '  |  '], m: ['     ', '  g  ', '  g  '] },
    { a: ['     ', ' \\|/ ', '  |  '], m: ['     ', ' ggg ', '  g  '] }
  ];

  var ANIMALS = [
    { id: 'chicken', name: 'Chicken', prod: 'egg', period: 30 * MIN, cap: 3, max: 6, lv: 3, cost: [150, 250, 400, 600, 850, 1200] },
    { id: 'cow', name: 'Cow', prod: 'milk', period: 2 * HOUR, cap: 2, max: 4, lv: 6, cost: [1000, 1600, 2500, 4000] }
  ];
  var ANIMAL = { chicken: ANIMALS[0], cow: ANIMALS[1] };
  var PRODUCTS = [
    { id: 'egg', name: 'Egg', col: 'bone', sell: 22, ch: 'o' },
    { id: 'milk', name: 'Milk', col: 'sky', sell: 110, ch: 'U' }
  ];
  // everything the barn can hold (golden variants are "<id>*")
  var ITEMS = {};
  CROPS.forEach(function (c, i) { ITEMS[c.id] = { id: c.id, name: c.name, col: c.col, sell: c.sell, crop: c, idx: i }; });
  PRODUCTS.forEach(function (p, i) { ITEMS[p.id] = { id: p.id, name: p.name, col: p.col, sell: p.sell, crop: null, idx: 40 + i }; });

  var UPGRADES = [
    { id: 'can', name: 'Watering can', max: 3, cost: [80, 500, 2500], lv: [1, 3, 6], val: [10 * MIN, 30 * MIN, 90 * MIN, 4 * HOUR] },
    { id: 'sprinkler', name: 'Sprinklers', max: 4, cost: [500, 2000, 6000, 15000], lv: [3, 5, 8, 11], val: [0, 4, 8, 16, 24] },
    { id: 'scarecrow', name: 'Scarecrow', max: 3, cost: [200, 1200, 4000], lv: [2, 4, 7], val: [1, 0.5, 0.2, 0] },
    { id: 'barn', name: 'Barn', max: 4, cost: [200, 900, 3000, 9000], lv: [1, 3, 5, 8], val: [40, 80, 160, 320, 640] }
  ];
  var UPG = {};
  UPGRADES.forEach(function (u) { UPG[u.id] = u; });

  // Achievements: test(s) over the save; reward in coins.
  var ACHS = [
    { id: 'first', name: 'Green thumb', info: 'Harvest your first crop', r: 10, test: function (s) { return s.st.harv >= 1; } },
    { id: 'harv100', name: 'Busy bee', info: 'Harvest 100 times', r: 150, test: function (s) { return s.st.harv >= 100; } },
    { id: 'harv1k', name: 'Bumper crop', info: 'Harvest 1,000 times', r: 1500, test: function (s) { return s.st.harv >= 1000; } },
    { id: 'gold', name: 'Golden touch', info: 'Harvest a golden crop', r: 50, test: function (s) { return s.st.gold >= 1; } },
    { id: 'earn1k', name: 'Market regular', info: 'Earn $1,000 selling', r: 100, test: function (s) { return s.st.earned >= 1000; } },
    { id: 'earn10k', name: 'Cash crop', info: 'Earn $10,000 selling', r: 800, test: function (s) { return s.st.earned >= 10000; } },
    { id: 'earn100k', name: 'Agribusiness', info: 'Earn $100,000 selling', r: 5000, test: function (s) { return s.st.earned >= 100000; } },
    { id: 'shoo', name: 'Shoo!', info: 'Shoo 10 crows', r: 60, test: function (s) { return s.st.shoo >= 10; } },
    { id: 'bugs', name: 'Bug patrol', info: 'Squash 10 bugs', r: 60, test: function (s) { return s.st.bugs >= 10; } },
    { id: 'land', name: 'Landowner', info: 'Own all ' + MAX_PLOTS + ' plots', r: 1000, test: function (s) { return s.plots.length >= MAX_PLOTS; } },
    { id: 'variety', name: 'Variety show', info: 'Harvest every kind of crop', r: 2000, test: function (s) { for (var i = 0; i < CROPS.length; i++) if (!s.st.crops[CROPS[i].id]) return false; return true; } },
    { id: 'seasons', name: 'All year round', info: 'Harvest in all four seasons', r: 400, test: function (s) { return !!(s.st.seasons[0] && s.st.seasons[1] && s.st.seasons[2] && s.st.seasons[3]); } },
    { id: 'streak', name: 'Regular', info: 'A 7-day gift streak', r: 300, test: function (s) { return s.daily.best >= 7; } },
    { id: 'hens', name: 'Hen house', info: 'Keep 6 chickens', r: 300, test: function (s) { return s.an.chicken.n >= 6; } },
    { id: 'cow', name: 'Moo', info: 'Buy a cow', r: 100, test: function (s) { return s.an.cow.n >= 1; } },
    { id: 'eggs', name: 'Egg basket', info: 'Collect 50 eggs', r: 150, test: function (s) { return s.st.eggs >= 50; } },
    { id: 'star', name: 'Wish upon it', info: 'Harvest a starfruit', r: 500, test: function (s) { return !!s.st.crops.starfruit; } },
    { id: 'lv10', name: 'Old hand', info: 'Reach level 10', r: 500, test: function (s) { return s.lv >= 10; } }
  ];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d, lo, hi) { v = +v; if (!isFinite(v)) return d; return clamp(v, lo, hi); }
  function int(v, d, lo, hi) { return Math.floor(num(v, d, lo, hi)); }
  function hash2(a, b) {
    var h = Math.imul((a | 0) ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul((b | 0) + 0x632BE5AB, 0xC2B2AE35);
    h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
    return h >>> 0;
  }
  function unit(a, b) { return hash2(a, b) / 4294967296; }

  // ---- the calendar (local time via the timezone offset captured in the save) ----
  function local(s, t) { return t - s.tzo * MIN; }
  function dayOf(s, t) { return Math.floor(local(s, t) / DAY); }
  function hourOf(s, t) { var l = local(s, t) % DAY; if (l < 0) l += DAY; return l / HOUR; }
  function farmDay(s, t) { return dayOf(s, t) - s.d0; }      // 0 on the day the farm was started
  function seasonOf(s, t) { var d = Math.floor(farmDay(s, t) / SEASON_DAYS) % 4; return d < 0 ? d + 4 : d; }
  function seasonDay(s, t) { var d = farmDay(s, t) % SEASON_DAYS; return (d < 0 ? d + SEASON_DAYS : d) + 1; }
  function year(s, t) { return Math.floor(Math.max(0, farmDay(s, t)) / (SEASON_DAYS * 4)) + 1; }
  function inSeason(crop, season) { return !!(crop.sea & (1 << season)); }
  // Weather of the 3-hour block containing t (deterministic per farm).
  function weatherAt(s, t) {
    if (s._wx) return s._wx;                                 // tests pin the weather
    var b = Math.floor(t / WX_BLOCK), r = unit(s.seed ^ 0x77E4, b), tab = WX_TABLE[seasonOf(s, b * WX_BLOCK)];
    for (var i = 0; i < tab.length - 1; i++) { if (r < tab[i][1]) return tab[i][0]; r -= tab[i][1]; }
    return tab[tab.length - 1][0];
  }
  function isDaytime(s, t) { var h = hourOf(s, t); return h >= 6 && h < 20; }

  // ---- levels ----
  function xpFor(lv) { return lv <= 1 ? 0 : 50 * (lv - 1) * (lv - 1); }
  function levelOf(xp) { var lv = 1; while (lv < MAX_LV && xp >= xpFor(lv + 1)) lv++; return lv; }
  function levelInfo(s) {
    var lv = levelOf(s.xp), a = xpFor(lv), b = lv >= MAX_LV ? a : xpFor(lv + 1);
    return { lv: lv, xp: s.xp, cur: s.xp - a, need: b - a, frac: b > a ? (s.xp - a) / (b - a) : 1, max: lv >= MAX_LV };
  }
  function addXp(s, n) { s.xp += n; var lv = levelOf(s.xp); if (lv > s.lv) { s.lv = lv; logMsg(s, s.t, 'Reached level ' + lv + '!'); } }

  // ---- save ----
  function emptyPlot() { return { c: null, g: 0, w: 0, h: 0, pest: 0, crow: 0 }; }
  function newStats() { return { harv: 0, gold: 0, earned: 0, shoo: 0, bugs: 0, eggs: 0, milk: 0, water: 0, planted: 0, pecked: 0, crops: {}, seasons: {} }; }
  function newSave(now, seed, tzo) {
    var s = {
      v: VERSION, seed: (seed >>> 0) || 1, tzo: int(tzo, 0, -900, 900), t: now, t0: now, d0: 0, evB: Math.floor(now / EV_BLOCK) + 1,
      coins: START_COINS, xp: 0, lv: 1, plots: [], seeds: { cress: 6, radish: 3 }, inv: {},
      upg: { can: 0, sprinkler: 0, scarecrow: 0, barn: 0 },
      an: { chicken: { n: 0, stash: 0, t: now }, cow: { n: 0, stash: 0, t: now } },
      sel: 'cress', daily: { last: -1, streak: 0, best: 0 }, st: newStats(), ach: {}, log: []
    };
    s.d0 = dayOf(s, now);
    for (var i = 0; i < START_PLOTS; i++) s.plots.push(emptyPlot());
    logMsg(s, now, 'A new farm! Six plots of good earth.');
    return s;
  }
  // Defensive load: anything odd falls back to a sane value; unknown crops are dropped.
  function normSave(o, now) {
    if (!o || typeof o !== 'object' || !isFinite(+o.t)) return newSave(now, hash2(now | 0, (now / 4294967296) | 0), 0);
    var s = newSave(num(o.t0, now, 0, 1e15), o.seed >>> 0, o.tzo);
    s.v = VERSION;
    s.t = num(o.t, now, 0, 1e15);
    s.d0 = int(o.d0, s.d0, -1e8, 1e8);
    s.evB = int(o.evB, Math.floor(s.t / EV_BLOCK) + 1, 0, 1e13);
    s.coins = int(o.coins, START_COINS, 0, 1e12);
    s.xp = int(o.xp, 0, 0, 1e12);
    s.lv = levelOf(s.xp);
    var P = Array.isArray(o.plots) ? o.plots : [], n = clamp(P.length, START_PLOTS, MAX_PLOTS);
    if (n % 2) n++;
    s.plots = [];
    for (var i = 0; i < n; i++) {
      var q = P[i] && typeof P[i] === 'object' ? P[i] : {}, p = emptyPlot(), c = CROP[q.c];
      if (c) {
        p.c = c.id; p.g = num(q.g, 0, 0, c.grow); p.h = int(q.h, 0, 0, c.reN || 0);
        p.pest = num(q.pest, 0, 0, 1e15); p.crow = num(q.crow, 0, 0, 1e15);
      }
      p.w = num(q.w, 0, 0, 1e15);
      s.plots.push(p);
    }
    s.seeds = {};
    var sd = o.seeds && typeof o.seeds === 'object' ? o.seeds : {};
    CROPS.forEach(function (c) { var k = int(sd[c.id], 0, 0, 99999); if (k) s.seeds[c.id] = k; });
    s.inv = {};
    var iv = o.inv && typeof o.inv === 'object' ? o.inv : {};
    Object.keys(ITEMS).forEach(function (k) {
      var a = int(iv[k], 0, 0, 1e6), b = int(iv[k + '*'], 0, 0, 1e6);
      if (a) s.inv[k] = a;
      if (b) s.inv[k + '*'] = b;
    });
    var u = o.upg && typeof o.upg === 'object' ? o.upg : {};
    UPGRADES.forEach(function (d) { s.upg[d.id] = int(u[d.id], 0, 0, d.max); });
    var an = o.an && typeof o.an === 'object' ? o.an : {};
    ANIMALS.forEach(function (d) {
      var a = an[d.id] && typeof an[d.id] === 'object' ? an[d.id] : {}, k = int(a.n, 0, 0, d.max);
      s.an[d.id] = { n: k, stash: int(a.stash, 0, 0, k * d.cap), t: num(a.t, s.t, 0, 1e15) };
    });
    s.sel = CROP[o.sel] ? o.sel : 'cress';
    var dl = o.daily && typeof o.daily === 'object' ? o.daily : {};
    s.daily = { last: int(dl.last, -1, -1, 1e8), streak: int(dl.streak, 0, 0, 1e6), best: int(dl.best, 0, 0, 1e6) };
    var st = o.st && typeof o.st === 'object' ? o.st : {};
    Object.keys(s.st).forEach(function (k) {
      if (k === 'crops' || k === 'seasons') {
        var m = st[k] && typeof st[k] === 'object' ? st[k] : {};
        Object.keys(m).forEach(function (j) {
          if ((k === 'crops' && CROP[j]) || (k === 'seasons' && /^[0-3]$/.test(j))) { if (m[j]) s.st[k][j] = 1; }
        });
      } else s.st[k] = num(st[k], 0, 0, 1e15);
    });
    s.ach = {};
    var ah = o.ach && typeof o.ach === 'object' ? o.ach : {};
    ACHS.forEach(function (a) { if (ah[a.id]) s.ach[a.id] = num(ah[a.id], 1, 1, 1e15); });
    s.log = [];
    if (Array.isArray(o.log)) o.log.slice(-40).forEach(function (e) {
      if (e && typeof e.m === 'string' && isFinite(+e.t)) s.log.push({ t: +e.t, m: e.m.slice(0, 120) });
    });
    return s;
  }
  function logMsg(s, t, m) { s.log.push({ t: t, m: m }); if (s.log.length > 40) s.log.splice(0, s.log.length - 40); }

  // ---- derived ----
  function canDur(s) { return UPG.can.val[s.upg.can]; }
  function sprinkled(s) { return UPG.sprinkler.val[s.upg.sprinkler]; }
  function barnCap(s) { return UPG.barn.val[s.upg.barn]; }
  function invCount(s) { var n = 0; for (var k in s.inv) n += s.inv[k]; return n; }
  function isReady(p) { var c = CROP[p.c]; return !!c && p.g >= c.grow - 1e-6; }
  function isWet(s, i, t) { return t < s.plots[i].w || i < sprinkled(s) || WX[weatherAt(s, t)].wet; }
  function rateAt(s, p, i, t, c) {
    if (p.pest) return 0;
    var w = weatherAt(s, t), r = 1;
    if (t < p.w || i < sprinkled(s) || WX[w].wet) r *= WET_MUL;
    if (w === 'snow' && !(c.sea & WI)) r *= SNOW_MUL;
    return r;
  }
  // 0 seed, 1 sprout, 2 young, 3 ready; -1 empty
  function stageOf(p) {
    var c = CROP[p.c];
    if (!c) return -1;
    if (isReady(p)) return 3;
    if (p.h > 0) return 2;
    var r = p.g / c.grow;
    return r < 0.12 ? 0 : r < 0.5 ? 1 : 2;
  }
  // Milliseconds of real time until plot i ripens, from s.t, if nothing changes (weather included).
  function etaOf(s, i) {
    var p = s.plots[i], c = CROP[p.c];
    if (!c) return -1;
    if (isReady(p)) return 0;
    if (p.pest) return Infinity;
    var g = p.g, t = s.t, lim = s.t + 30 * DAY;
    while (t < lim) {
      var e = Math.min(lim, (Math.floor(t / WX_BLOCK) + 1) * WX_BLOCK);
      if (p.w > t && p.w < e) e = p.w;
      var r = rateAt(s, p, i, t, c), need = (c.grow - g) / r * SEC;
      if (t + need <= e) return t + need - s.t;
      g += r * (e - t) / SEC; t = e;
    }
    return Infinity;
  }

  // ---- time passing ----
  function newRep() { return { ripe: [], crows: [], pecked: 0, pests: 0, bugsLeft: 0, bees: 0, gift: 0, prod: { egg: 0, milk: 0 }, wetH: 0, snowH: 0 }; }
  // Grow plot i from a to b with no crow / bug changes in between.
  function growPlot(s, p, i, a, b, rep) {
    var c = CROP[p.c];
    if (!c || isReady(p) || b <= a) return;
    var t = a;
    while (t < b) {
      var e = Math.min(b, (Math.floor(t / WX_BLOCK) + 1) * WX_BLOCK);
      if (p.w > t && p.w < e) e = p.w;
      var r = rateAt(s, p, i, t, c);
      if (r > 0 && t + (c.grow - p.g) / r * SEC <= e) { p.g = c.grow; if (rep) rep.ripe.push(i); return; }
      p.g += r * (e - t) / SEC;
      t = e;
    }
  }
  function peck(s, p, i, t, rep) {
    var c = CROP[p.c];
    p.crow = 0;
    if (!c) return;
    p.g = Math.max(0, Math.min(p.g, c.grow) - PECK * c.grow);
    s.st.pecked++;
    if (rep) rep.pecked++;
    logMsg(s, t, 'A crow pecked your ' + c.name.toLowerCase() + ' (plot ' + (i + 1) + ').');
  }
  // Move every plot and animal from s.t to t1 (no new events).
  function advance(s, t1, rep) {
    if (!(t1 > s.t)) return;
    for (var i = 0; i < s.plots.length; i++) {
      var p = s.plots[i], t = s.t;
      for (var guard = 0; guard < 8; guard++) {
        var nx = t1;
        if (p.crow && p.crow < nx) nx = Math.max(t, p.crow);
        if (p.pest && p.pest + PEST_MAX < nx) nx = Math.max(t, p.pest + PEST_MAX);
        growPlot(s, p, i, t, nx, rep);
        t = nx;
        if (p.crow && p.crow <= t) peck(s, p, i, t, rep);
        if (p.pest && p.pest + PEST_MAX <= t) { p.pest = 0; if (rep) rep.bugsLeft++; }
        if (t >= t1) break;
      }
    }
    ANIMALS.forEach(function (d) {
      var A = s.an[d.id], cap = A.n * d.cap;
      if (!A.n || A.stash >= cap) { A.t = Math.max(A.t, t1); return; }
      if (A.t > t1) A.t = t1;
      var u = Math.floor((t1 - A.t) / d.period);
      if (u <= 0) return;
      var add = Math.min(cap - A.stash, u * A.n);
      A.stash += add;
      if (rep) rep.prod[d.prod] += add;
      if (A.stash >= cap) A.t = t1; else A.t += u * d.period;
    });
    if (rep) {                                                      // how wet / snowy it was
      for (var b = Math.floor(s.t / WX_BLOCK); b * WX_BLOCK < t1; b++) {
        var a0 = Math.max(s.t, b * WX_BLOCK), a1 = Math.min(t1, (b + 1) * WX_BLOCK), w = weatherAt(s, b * WX_BLOCK);
        if (WX[w].wet) rep.wetH += (a1 - a0) / HOUR; else if (w === 'snow') rep.snowH += (a1 - a0) / HOUR;
      }
    }
    s.t = t1;
  }
  function eventAt(s, b) {
    var h = hash2(s.seed ^ 0x5EED, b);
    return { b: b, t: b * EV_BLOCK + (h % (EV_BLOCK / SEC)) * SEC, r: unit(h, 7), pick: hash2(h, 13) };
  }
  function eligible(s, f) { var L = []; for (var i = 0; i < s.plots.length; i++) if (f(s.plots[i])) L.push(i); return L; }
  function applyEvent(s, e, rep) {
    if (s._noEv) return;
    var season = seasonOf(s, e.t), wx = WX[weatherAt(s, e.t)], day = isDaytime(s, e.t);
    var pc = day && !wx.wet ? 0.2 * UPG.scarecrow.val[s.upg.scarecrow] : 0;
    var pp = season !== 3 ? 0.06 : 0;
    var pb = season < 2 && day && !wx.wet ? 0.06 : 0;
    var pg = 0.015, r = e.r, L, i;
    if (r < pc) {
      L = eligible(s, function (p) { return p.c && !isReady(p) && !p.crow && !p.pest; });
      if (!L.length) return;
      i = L[e.pick % L.length];
      s.plots[i].crow = e.t + CROW_WAIT;
      if (rep) rep.crows.push(i);
    } else if ((r -= pc) < pp) {
      L = eligible(s, function (p) { return p.c && !isReady(p) && !p.pest && !p.crow; });
      if (!L.length) return;
      i = L[e.pick % L.length];
      s.plots[i].pest = e.t;
      if (rep) rep.pests++;
      logMsg(s, e.t, 'A bug is chewing plot ' + (i + 1) + '.');
    } else if ((r -= pp) < pb) {
      L = eligible(s, function (p) { return p.c && !isReady(p) && !p.pest; });
      if (!L.length) return;
      i = L[e.pick % L.length];
      var p = s.plots[i], c = CROP[p.c];
      p.g = Math.min(c.grow, p.g + BEES * c.grow);
      if (isReady(p) && rep) rep.ripe.push(i);
      if (rep) rep.bees++;
      logMsg(s, e.t, 'Bees buzzed through your ' + c.name.toLowerCase() + '.');
    } else if ((r -= pb) < pg) {
      var g = 10 + s.lv * 5;
      s.coins += g;
      if (rep) rep.gift += g;
      logMsg(s, e.t, 'A neighbour left a basket: +$' + g + '.');
    }
  }
  // Bring the farm up to `now`: growth, weather, events, animals. Returns what happened.
  function tick(s, now, rep) {
    rep = rep || newRep();
    if (!isFinite(now)) return rep;
    if (now < s.t) {                                 // the clock went back: no growth, just follow it
      s.t = now;                                     // (events already replayed stay replayed)
      return rep;
    }
    if (now - s.t > MAX_AWAY) { s.t = now - MAX_AWAY; ANIMALS.forEach(function (d) { s.an[d.id].t = Math.max(s.an[d.id].t, s.t); }); }
    if (s.evB < Math.floor(s.t / EV_BLOCK)) s.evB = Math.floor(s.t / EV_BLOCK);
    for (;;) {
      var e = eventAt(s, s.evB);
      if (e.t > now) break;
      if (e.t >= s.t) { advance(s, e.t, rep); applyEvent(s, e, rep); }
      s.evB++;
    }
    advance(s, now, rep);
    return rep;
  }

  // ---- actions (call tick(s, now) first so s.t is now) ----
  function unlocked(s, c) { return s.lv >= c.lv; }
  function canPlant(s, id, now) {
    var c = CROP[id];
    if (!c) return 'unknown';
    if (!unlocked(s, c)) return 'level';
    if (!inSeason(c, seasonOf(s, now))) return 'season';
    if (!(s.seeds[id] > 0) && s.coins < c.cost) return 'coins';
    return '';
  }
  function plant(s, i, id, now) {
    var p = s.plots[i], c = CROP[id];
    if (!p) return { err: 'plot' };
    if (p.c) return { err: 'busy' };
    var why = canPlant(s, id, now);
    if (why) return { err: why };
    var bought = false;
    if (s.seeds[id] > 0) { if (!--s.seeds[id]) delete s.seeds[id]; } else { s.coins -= c.cost; bought = true; }
    p.c = id; p.g = 0; p.h = 0; p.pest = 0; p.crow = 0;
    s.st.planted++;
    return { ok: true, bought: bought };
  }
  function water(s, i, now) {
    var p = s.plots[i];
    if (!p) return false;
    if (i < sprinkled(s)) return false;                       // the sprinkler has it
    var d = canDur(s);
    if (p.w - now > d * 0.5) return false;                    // still well watered
    p.w = now + d;
    s.st.water++;
    return true;
  }
  function needsWater(s, i, now) { var p = s.plots[i]; return !!p.c && !isReady(p) && i >= sprinkled(s) && p.w - now <= canDur(s) * 0.5; }
  function shoo(s, i) {
    var p = s.plots[i];
    if (!p || !p.crow) return false;
    p.crow = 0; s.st.shoo++; addXp(s, 1);
    return true;
  }
  function squash(s, i) {
    var p = s.plots[i];
    if (!p || !p.pest) return false;
    p.pest = 0; s.st.bugs++; addXp(s, 1);
    return true;
  }
  function dig(s, i) { var p = s.plots[i]; if (!p || !p.c) return false; var w = p.w; s.plots[i] = emptyPlot(); s.plots[i].w = w; return true; }
  // rnd: () -> [0,1) for the golden roll.
  function harvest(s, i, now, rnd) {
    var p = s.plots[i];
    if (!p || !isReady(p)) return { err: 'notready' };
    var c = CROP[p.c];
    if (invCount(s) + c.y > barnCap(s)) return { err: 'full' };
    var gold = (rnd ? rnd() : Math.random()) < GOLD_P, key = c.id + (gold ? '*' : '');
    s.inv[key] = (s.inv[key] || 0) + c.y;
    s.st.harv++; s.st.crops[c.id] = 1; s.st.seasons[seasonOf(s, now)] = 1;
    if (gold) { s.st.gold++; logMsg(s, now, 'A golden ' + c.name.toLowerCase() + '!'); }
    addXp(s, c.xp);
    if (c.re && p.h + 1 < c.reN) { p.h++; p.g = c.grow - c.re; }
    else { var w = p.w; s.plots[i] = emptyPlot(); s.plots[i].w = w; }
    return { ok: true, crop: c.id, n: c.y, gold: gold, xp: c.xp, regrow: !!s.plots[i].c };
  }
  function harvestAll(s, now, rnd) {
    var out = { n: 0, plots: [], gold: 0, full: false };
    for (var i = 0; i < s.plots.length; i++) {
      if (!isReady(s.plots[i])) continue;
      var r = harvest(s, i, now, rnd);
      if (r.err === 'full') { out.full = true; break; }
      if (r.ok) { out.n++; out.plots.push({ i: i, r: r }); if (r.gold) out.gold++; }
    }
    return out;
  }
  function plantAll(s, id, now) {
    var n = 0, err = '';
    for (var i = 0; i < s.plots.length; i++) {
      if (s.plots[i].c) continue;
      var r = plant(s, i, id, now);
      if (r.err) { err = r.err; break; }
      n++;
    }
    return { n: n, err: n ? '' : err || 'none' };
  }
  function waterAll(s, now) { var n = 0; for (var i = 0; i < s.plots.length; i++) if (needsWater(s, i, now) && water(s, i, now)) n++; return n; }
  function buySeeds(s, id, n) {
    var c = CROP[id];
    n = Math.max(1, n | 0);
    if (!c || !unlocked(s, c) || s.coins < c.cost * n) return false;
    s.coins -= c.cost * n; s.seeds[id] = (s.seeds[id] || 0) + n;
    return true;
  }
  function priceOf(s, key, t) {
    var gold = key.charAt(key.length - 1) === '*', id = gold ? key.slice(0, -1) : key, it = ITEMS[id];
    if (!it) return 0;
    var m = 0.85 + 0.3 * unit(s.seed ^ 0xBEEF, dayOf(s, t) * 64 + it.idx);
    if (it.crop && !inSeason(it.crop, seasonOf(s, t))) m *= 1.2;
    return Math.max(1, Math.round(it.sell * m * (gold ? GOLD_X : 1)));
  }
  function trendOf(s, key, t) {
    var gold = key.charAt(key.length - 1) === '*', it = ITEMS[gold ? key.slice(0, -1) : key];
    return it ? priceOf(s, key, t) / (it.sell * (gold ? GOLD_X : 1)) : 1;
  }
  function sell(s, key, n, now) {
    var have = s.inv[key] || 0;
    n = Math.min(have, n == null ? have : Math.max(0, n | 0));
    if (!n) return 0;
    var got = priceOf(s, key, now) * n;
    s.inv[key] = have - n;
    if (!s.inv[key]) delete s.inv[key];
    s.coins += got; s.st.earned += got;
    return got;
  }
  function sellAll(s, now) { var g = 0; Object.keys(s.inv).forEach(function (k) { g += sell(s, k, null, now); }); return g; }
  function upgCost(s, id) { var d = UPG[id], k = s.upg[id]; return k >= d.max ? -1 : d.cost[k]; }
  function upgLv(s, id) { var d = UPG[id], k = s.upg[id]; return k >= d.max ? 0 : d.lv[k]; }
  function buyUpg(s, id) {
    var d = UPG[id];
    if (!d) return false;
    var c = upgCost(s, id);
    if (c < 0 || s.coins < c || s.lv < upgLv(s, id)) return false;
    s.coins -= c; s.upg[id]++;
    return true;
  }
  function expandCost(s) { var k = (s.plots.length - START_PLOTS) / 2; return s.plots.length >= MAX_PLOTS ? -1 : Math.round(100 * Math.pow(2.1, k)); }
  function expand(s) {
    var c = expandCost(s);
    if (c < 0 || s.coins < c) return false;
    s.coins -= c; s.plots.push(emptyPlot(), emptyPlot());
    return true;
  }
  function animalCost(s, id) { var d = ANIMAL[id], n = s.an[id].n; return n >= d.max ? -1 : d.cost[n]; }
  function buyAnimal(s, id, now) {
    var d = ANIMAL[id];
    if (!d) return false;
    var c = animalCost(s, id), A = s.an[id];
    if (c < 0 || s.coins < c || s.lv < d.lv) return false;
    s.coins -= c;
    if (!A.n || A.stash >= A.n * d.cap) A.t = now;
    A.n++;
    return true;
  }
  function waiting(s) { var n = 0; ANIMALS.forEach(function (d) { n += s.an[d.id].stash; }); return n; }
  function collect(s, now, rnd) {
    var out = { egg: 0, milk: 0, gold: 0, full: false };
    ANIMALS.forEach(function (d) {
      var A = s.an[d.id];
      while (A.stash > 0) {
        if (invCount(s) >= barnCap(s)) { out.full = true; return; }
        if (A.stash >= A.n * d.cap) A.t = now;              // it was full: production restarts now
        A.stash--;
        var g = d.prod === 'egg' && (rnd ? rnd() : Math.random()) < GOLD_EGG_P, k = d.prod + (g ? '*' : '');
        s.inv[k] = (s.inv[k] || 0) + 1;
        out[d.prod]++;
        if (g) out.gold++;
        if (d.prod === 'egg') s.st.eggs++; else s.st.milk++;
      }
    });
    return out;
  }
  // ---- the daily gift ----
  function canDaily(s, now) { return dayOf(s, now) > s.daily.last; }
  function dailyReward(s, now) {
    var d = dayOf(s, now), streak = d === s.daily.last + 1 ? s.daily.streak + 1 : 1, season = seasonOf(s, now);
    var L = CROPS.filter(function (c) { return unlocked(s, c) && inSeason(c, season) && c.id !== 'cress'; });
    if (!L.length) L = [CROP.cress];
    var c = L[hash2(s.seed, d) % L.length];
    return { day: d, streak: streak, coins: 20 + 10 * Math.min(streak, 7) + (streak % 7 === 0 ? 50 : 0), seed: c.id, n: 3 };
  }
  function claimDaily(s, now) {
    if (!canDaily(s, now)) return null;
    var r = dailyReward(s, now);
    s.daily.last = r.day; s.daily.streak = r.streak; s.daily.best = Math.max(s.daily.best, r.streak);
    s.coins += r.coins; s.seeds[r.seed] = (s.seeds[r.seed] || 0) + r.n;
    return r;
  }
  // ---- achievements: newly earned ones (their rewards are paid) ----
  function checkAch(s, now) {
    var got = [];
    ACHS.forEach(function (a) {
      if (s.ach[a.id] || !a.test(s)) return;
      s.ach[a.id] = now || s.t || 1; s.coins += a.r; got.push(a);
      logMsg(s, now || s.t, 'Achievement: ' + a.name + ' (+$' + a.r + ').');
    });
    return got;
  }

  var ENGINE = {
    VERSION: VERSION, SEC: SEC, MIN: MIN, HOUR: HOUR, DAY: DAY, WX_BLOCK: WX_BLOCK, EV_BLOCK: EV_BLOCK, CROW_WAIT: CROW_WAIT, PEST_MAX: PEST_MAX,
    WET_MUL: WET_MUL, SNOW_MUL: SNOW_MUL, SEASON_DAYS: SEASON_DAYS, MAX_AWAY: MAX_AWAY, PECK: PECK, GOLD_X: GOLD_X,
    START_PLOTS: START_PLOTS, MAX_PLOTS: MAX_PLOTS, START_COINS: START_COINS,
    SEASONS: SEASONS, WX: WX, CROPS: CROPS, CROP: CROP, STAGES: STAGES, ANIMALS: ANIMALS, ANIMAL: ANIMAL, PRODUCTS: PRODUCTS, ITEMS: ITEMS,
    UPGRADES: UPGRADES, UPG: UPG, ACHS: ACHS,
    hash2: hash2, dayOf: dayOf, hourOf: hourOf, farmDay: farmDay, seasonOf: seasonOf, seasonDay: seasonDay, year: year, inSeason: inSeason,
    weatherAt: weatherAt, isDaytime: isDaytime, xpFor: xpFor, levelOf: levelOf, levelInfo: levelInfo,
    newSave: newSave, normSave: normSave, emptyPlot: emptyPlot,
    canDur: canDur, sprinkled: sprinkled, barnCap: barnCap, invCount: invCount, isReady: isReady, isWet: isWet, stageOf: stageOf, etaOf: etaOf,
    newRep: newRep, tick: tick, advance: advance, eventAt: eventAt,
    unlocked: unlocked, canPlant: canPlant, plant: plant, water: water, needsWater: needsWater, shoo: shoo, squash: squash, dig: dig,
    harvest: harvest, harvestAll: harvestAll, plantAll: plantAll, waterAll: waterAll, buySeeds: buySeeds,
    priceOf: priceOf, trendOf: trendOf, sell: sell, sellAll: sellAll, upgCost: upgCost, upgLv: upgLv, buyUpg: buyUpg,
    expandCost: expandCost, expand: expand, animalCost: animalCost, buyAnimal: buyAnimal, waiting: waiting, collect: collect,
    canDaily: canDaily, dailyReward: dailyReward, claimDaily: claimDaily, checkAch: checkAch
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('tinyfarm.css');
  var PANEL_ID = 'tinyfarm-panel', NAME = 'Tiny Farm';
  var KEY = 'cade-tinyfarm-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var CW = 7, RH = 11, ROWS = 11;          // the scene's glyph cell (logical px) and height in rows
  var S = null;                            // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.tinyfarm = { live: function () { return S; } };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave(now) {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    if (!o) {
      var s = newSave(now, (Math.random() * 4294967295) >>> 0, new Date(now).getTimezoneOffset());
      return { save: s, fresh: true };
    }
    var n = normSave(o, now);
    n.tzo = clamp(new Date(now).getTimezoneOffset(), -900, 900);   // follow the device's timezone
    return { save: n, fresh: false };
  }
  function persist() { if (S) { S.dirty = false; sset(SAVE_KEY, JSON.stringify(S.s)); } }

  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function fmtInt(n) {
    n = Math.round(n);
    var s = String(Math.abs(n)), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }
  function money(n) { return '$' + fmtInt(n); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDur(ms) {
    if (!isFinite(ms)) return '--';
    var s = Math.max(0, Math.ceil(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 10) return m + 'm ' + pad2(s % 60) + 's';
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + pad2(m % 60) + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }
  function fmtAgo(ms) { return ms < 60000 ? 'just now' : fmtDur(ms).replace(/ \d+s$/, '') + ' ago'; }
  function plural(n, w) { return fmtInt(n) + ' ' + w + (n === 1 ? '' : 's'); }

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
  var SFX = {
    plant: function (n) { n.tone(330, 0.07, 'triangle', 0.06, 260); },
    water: function (n) { n.tone(1100, 0.16, 'sine', 0.03, 420); n.tone(700, 0.1, 'sine', 0.02, 300, 0.05); },
    harvest: function (n) { n.tone(660, 0.06, 'square', 0.03); n.tone(990, 0.09, 'square', 0.03, 0, 0.06); },
    gold: function (n) { [784, 988, 1175, 1568].forEach(function (f, i) { n.tone(f, 0.12, 'square', 0.03, 0, i * 0.07); }); },
    sell: function (n) { n.tone(1318, 0.06, 'square', 0.025); n.tone(1760, 0.14, 'square', 0.025, 0, 0.06); },
    caw: function (n) { n.tone(560, 0.16, 'sawtooth', 0.035, 320); n.tone(540, 0.14, 'sawtooth', 0.03, 300, 0.2); },
    shoo: function (n) { n.tone(260, 0.14, 'triangle', 0.05, 900); },
    squash: function (n) { n.tone(170, 0.09, 'square', 0.05, 70); },
    ripe: function (n) { n.tone(1245, 0.07, 'sine', 0.025); },
    level: function (n) { [523, 659, 784, 1047].forEach(function (f, i) { n.tone(f, 0.16, 'triangle', 0.05, 0, i * 0.09); }); },
    buy: function (n) { n.tone(784, 0.07, 'square', 0.03); n.tone(1175, 0.12, 'square', 0.03, 0, 0.07); },
    no: function (n) { n.tone(150, 0.12, 'square', 0.03); },
    cluck: function (n) { n.tone(720, 0.05, 'square', 0.025, 480); n.tone(760, 0.05, 'square', 0.02, 520, 0.08); },
    tap: function (n) { n.tone(880, 0.04, 'sine', 0.025); }
  };
  function sfx(k) { if (S && S.snd.on) { S.snd.ensure(); SFX[k](S.snd); } }
  function buzz(ms) { try { if (Cade.haptic) Cade.haptic(ms || 6); } catch (e) {} }

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');

  // ---- ASCII art as coloured HTML (cached) ----
  var ART = {};
  function artHtml(a, m, col) {
    var out = [];
    for (var r = 0; r < a.length; r++) {
      var line = '', cur = null, run = '';
      for (var k = 0; k < a[r].length; k++) {
        var mk = m[r].charAt(k), cls = mk === 'f' ? 'tf-c-' + col : mk === 'g' ? 'tf-c-leaf' : mk === 'b' ? 'tf-c-brown' : mk === 'x' ? 'tf-c-faint' : '';
        if (cls !== cur) { if (run) line += cur ? '<i class="' + cur + '">' + esc(run) + '</i>' : esc(run); run = ''; cur = cls; }
        run += a[r].charAt(k);
      }
      if (run) line += cur ? '<i class="' + cur + '">' + esc(run) + '</i>' : esc(run);
      out.push(line);
    }
    return out.join('\n');
  }
  var EMPTY_ART = { a: ['     ', '  +  ', '     '], m: ['     ', '  x  ', '     '] };
  function plotArt(p) {
    var st = stageOf(p), c = CROP[p.c], key = st < 0 ? 'e' : st === 3 ? c.id : 's' + st + (st === 0 ? '' : '');
    if (!ART[key]) ART[key] = st < 0 ? artHtml(EMPTY_ART.a, EMPTY_ART.m, 'leaf') : st === 3 ? artHtml(c.a, c.m, c.col) : artHtml(STAGES[st].a, STAGES[st].m, 'leaf');
    return ART[key];
  }
  var ICON = {};
  CROPS.forEach(function (c) { ICON[c.id] = c.ch; });
  ICON.egg = 'o'; ICON.milk = 'U';
  function itemName(k) {
    var g = k.charAt(k.length - 1) === '*', it = ITEMS[g ? k.slice(0, -1) : k];
    return it ? (g ? 'Golden ' + it.name.toLowerCase() : it.name) : k;
  }
  function itemIcon(k) {
    var g = k.charAt(k.length - 1) === '*', id = g ? k.slice(0, -1) : k, it = ITEMS[id];
    return '<b class="tf-ic tf-c-' + (g ? 'gold' : it ? it.col : 'leaf') + (g ? ' tf-shine' : '') + '">' + esc(ICON[id] || '*') + '</b>';
  }
  function seedWord(c) { return c.id === 'peas' ? 'pea' : c.id; }   // 'mushroom seeds', not 'mushrooms seeds'
  function seasonsTxt(c) {
    if (c.sea === 15) return 'any season';
    var o = [];
    for (var i = 0; i < 4; i++) if (c.sea & (1 << i)) o.push(SEASONS[i].name.slice(0, 3));
    return o.join(' ');
  }

  // ---- theme colours for the scene canvas ----
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOLD = 4, C_RED = 5, C_SKY = 6, C_ORANGE = 7, C_LEAF = 8, C_VIOLET = 9,
    C_LIME = 10, C_PINK = 11, C_BROWN = 12, C_CLOUD = 13, C_STAR = 14, C_HILL = 15, C_STORM = 16, NPAL = 17;
  var COL_SLOT = { gold: C_GOLD, red: C_RED, sky: C_SKY, orange: C_ORANGE, leaf: C_LEAF, violet: C_VIOLET, lime: C_LIME, pink: C_PINK, brown: C_BROWN, bone: C_TEXT };
  var HUES = {
    gold: ['#b07d06', '#f2c544'], red: ['#cf3f3f', '#f06a6a'], sky: ['#2878b5', '#7cc7f2'], orange: ['#e2611f', '#ff8f3f'],
    leaf: ['#2f8f3a', '#7ed37a'], violet: ['#7351c4', '#b79cf5'], lime: ['#6a9a12', '#b5e06a'], pink: ['#c2477e', '#f59ac4'], brown: ['#8a5a2b', '#c99a6b']
  };
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
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45, d = dark ? 1 : 0;
    var P = S.pal;
    S.dark = dark;
    P[C_TEXT] = css(tx); P[C_MUTED] = css(parseCol(v('--text-muted'), mix(bg, tx, 0.55))); P[C_FAINT] = css(parseCol(v('--text-faint'), mix(bg, tx, 0.35)));
    P[C_ACC] = css(ac);
    Object.keys(COL_SLOT).forEach(function (k) { if (HUES[k]) P[COL_SLOT[k]] = HUES[k][d]; });
    P[C_CLOUD] = css(mix(bg, tx, dark ? 0.4 : 0.36)); P[C_STAR] = css(mix(bg, tx, dark ? 0.55 : 0.3));
    P[C_HILL] = css(mix(bg, parseCol(HUES.leaf[d]), dark ? 0.35 : 0.3)); P[C_STORM] = css(mix(bg, tx, dark ? 0.45 : 0.45));
    S.col = { bg: css(bg), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace', flash: css(tx, dark ? 0.1 : 0.07) };
    fitFont();
  }

  // ---- glyph atlas (as Dusk Dash): each (colour, char) rendered once, stamped with drawImage ----
  var AT_COLS = 24, AT_ROWS = 16;
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '600 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = CW / adv;
    S.fnt = '600 ' + S.fpx.toFixed(3) + 'px ' + f;
    buildAtlas();
  }
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.k || !S.col) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    a.cwp = Math.ceil((CW + 4) * S.k); a.chp = Math.ceil((RH + 6) * S.k);
    a.cv.width = a.cwp * AT_COLS; a.cv.height = a.chp * AT_ROWS;
    a.c = a.cv.getContext('2d');
    a.c.font = '600 ' + (S.fpx * S.k).toFixed(3) + 'px ' + S.col.font;
    a.c.textAlign = 'center'; a.c.textBaseline = 'middle';
    a.cw = a.cwp / S.k; a.ch = a.chp / S.k; a.n = 0; a.max = AT_COLS * AT_ROWS;
    S.gmap = [];
    for (var i = 0; i < NPAL; i++) { var m = new Int16Array(128); for (var j = 0; j < 128; j++) m[j] = -1; S.gmap.push(m); }
  }
  function glyph(c, ci, code, x, y) {
    if (code === 32) return;
    var a = S.atl, m = S.gmap[ci], i = code < 128 ? m[code] : -1;
    if (i < 0 && code < 128 && a.n < a.max) {
      i = a.n++;
      a.c.fillStyle = S.pal[ci];
      a.c.fillText(String.fromCharCode(code), (i % AT_COLS) * a.cwp + a.cwp / 2, ((i / AT_COLS) | 0) * a.chp + a.chp / 2);
      m[code] = i;
    }
    if (i < 0) { c.font = S.fnt; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = S.pal[ci]; c.fillText(String.fromCharCode(code), x, y); return; }
    var dx = Math.round((x - a.cw / 2) * S.k) / S.k, dy = Math.round((y - a.ch / 2) * S.k) / S.k;
    c.drawImage(a.cv, (i % AT_COLS) * a.cwp, ((i / AT_COLS) | 0) * a.chp, a.cwp, a.chp, dx, dy, a.cw, a.ch);
  }
  // text at a cell (col, row may be fractional); spaces are transparent
  function put(c, ci, s, col, row) {
    var y = row * RH + RH / 2;
    for (var i = 0; i < s.length; i++) glyph(c, ci, s.charCodeAt(i), (col + i) * CW + CW / 2, y);
  }
  // art lines with a colour mask: mask chars map through `map` to palette slots
  function putArt(c, lines, mask, map, col, row) {
    for (var r = 0; r < lines.length; r++) {
      var L = lines[r], M = mask[r], y = (row + r) * RH + RH / 2;
      for (var k = 0; k < L.length; k++) {
        var ch = L.charCodeAt(k);
        if (ch !== 32) glyph(c, map[M.charAt(k)] != null ? map[M.charAt(k)] : C_TEXT, ch, (col + k) * CW + CW / 2, y);
      }
    }
  }

  // ---- the scene: sky, weather, barn, animals and a little map of the field ----
  var BARN = {
    a: ['    /\\    ', '   /  \\__ ', '  /____\\ \\', '  |[] |  |', '  |_#_|__|'],
    m: ['    rr    ', '   r  rrr ', '  rrrrrr r', '  bwwbb  b', '  bbbbbbbb']
  };
  var SILO = { a: [' _ ', '(_)', '| |', '|=|', '| |', '|_|'], m: [' t ', 'ttt', 't t', 'tbt', 't t', 'ttt'] };
  var COOP = { a: [' /\\ ', '|<>|'], m: [' rr ', 'bbbb'] };
  var SCARE = { a: [' ^ ', '(o)', '-+-', ' | '], m: [' y ', 'tbt', 'bbb', ' b '] };
  var COW = { a: ['^__^', '(oo)'], m: ['tttt', 'tbbt'] };
  var CLOUDS = [[' .--. ', '(    )'], ['  .-.  ', '.(   ).', ' `---` '], [' .-~-. ', '(_____)']];

  function sceneInit() {
    var s = S.s, sc = S.sc = { t: 0, clouds: [], drops: [], birds: [], hens: [], cows: [], flies: [], flash: 0, bolt: null, nextBolt: 3 };
    for (var i = 0; i < 7; i++) sc.clouds.push({ x: Math.random() * 80, y: Math.random() * 2.2, sp: 0.4 + Math.random() * 0.6, k: i % CLOUDS.length });
    for (i = 0; i < 6; i++) sc.hens.push({ x: Math.random(), d: Math.random() < 0.5 ? -1 : 1, t: Math.random() * 3, peck: 0 });
    for (i = 0; i < 4; i++) sc.cows.push({ x: Math.random(), d: Math.random() < 0.5 ? -1 : 1, t: Math.random() * 6 });
    for (i = 0; i < 8; i++) sc.flies.push({ x: Math.random(), y: Math.random(), p: Math.random() * 6 });
    void s;
  }
  function stepScene(dt) {
    var sc = S.sc, s = S.s, now = Date.now(), wx = weatherAt(s, now), cols = S.cols;
    sc.t += dt;
    var nc = wx === 'sun' ? 2 : wx === 'cloud' ? 5 : wx === 'snow' ? 4 : 6;
    for (var i = 0; i < sc.clouds.length; i++) {
      var cl = sc.clouds[i];
      cl.x += cl.sp * dt * (wx === 'storm' ? 2.2 : 1);
      if (cl.x > cols + 2) { cl.x = -9; cl.y = Math.random() * 2.2; }
      cl.on = i < nc;
    }
    // rain / snow
    var want = wx === 'rain' ? 26 : wx === 'storm' ? 44 : wx === 'snow' ? 30 : 0;
    if (S.rm) want = Math.ceil(want / 3);
    while (sc.drops.length < want) sc.drops.push({ x: Math.random() * cols, y: Math.random() * 9, v: 0 });
    if (sc.drops.length > want) sc.drops.length = want;
    for (i = 0; i < sc.drops.length; i++) {
      var d = sc.drops[i];
      if (wx === 'snow') { d.y += dt * 1.6; d.x += Math.sin(sc.t * 1.3 + i) * dt * 0.8; }
      else { d.y += dt * (wx === 'storm' ? 15 : 11); d.x += dt * (wx === 'storm' ? 6 : 1.5); }
      if (d.y > 10.5) { d.y = 1 + Math.random() * 1.5; d.x = Math.random() * (cols + 6) - 6; }
    }
    if (wx === 'storm' && !S.rm) {
      sc.nextBolt -= dt;
      if (sc.nextBolt <= 0) { sc.nextBolt = 4 + Math.random() * 7; sc.flash = 0.18; sc.bolt = { x: 8 + Math.random() * (cols - 16), t: 0.25 }; }
    }
    if (sc.flash > 0) sc.flash = Math.max(0, sc.flash - dt);
    if (sc.bolt && (sc.bolt.t -= dt) <= 0) sc.bolt = null;
    // a few birds cross the sky in daytime
    if (isDaytime(s, now) && !WX[wx].wet && sc.birds.length < 2 && Math.random() < dt * 0.08) sc.birds.push({ x: -2, y: 0.6 + Math.random() * 2.4, sp: 3 + Math.random() * 3 });
    for (i = sc.birds.length - 1; i >= 0; i--) { sc.birds[i].x += sc.birds[i].sp * dt; if (sc.birds[i].x > cols + 2) sc.birds.splice(i, 1); }
    // hens wander and peck; cows amble
    sc.hens.forEach(function (h) {
      h.t -= dt;
      if (h.peck > 0) h.peck -= dt;
      else h.x += h.d * dt * 0.05;
      if (h.t <= 0) { h.t = 0.8 + Math.random() * 2.5; if (Math.random() < 0.4) h.peck = 0.5; else if (Math.random() < 0.5) h.d = -h.d; }
      if (h.x < 0) { h.x = 0; h.d = 1; } if (h.x > 1) { h.x = 1; h.d = -1; }
    });
    sc.cows.forEach(function (w) {
      w.t -= dt;
      if (w.t <= 0) { w.t = 2 + Math.random() * 5; w.mv = Math.random() < 0.5; if (Math.random() < 0.4) w.d = -w.d; }
      if (w.mv) w.x += w.d * dt * 0.02;
      if (w.x < 0) { w.x = 0; w.d = 1; } if (w.x > 1) { w.x = 1; w.d = -1; }
    });
  }
  function fieldBox() {
    var n = S.s.plots.length, per = Math.ceil(n / 2), pw = per * 3 <= S.cols - 30 ? 3 : 2, w = per * pw;
    return { per: per, pw: pw, x: S.cols - w - 1, w: w };
  }
  // a tree that dresses for the season
  var TREE = { a: [' .@@@. ', '@@@@@@@', ' \@@@/ ', '   |   ', '  _|_  '], m: [' ggggg ', 'ggggggg', ' bgggb ', '   b   ', '  bbb  '] };
  var TREE_BARE = { a: ['  \|/  ', '\_\|/_/', '  \|/  ', '   |   ', '  _|_  '], m: ['  bbb  ', 'bbbbbbb', '  bbb  ', '   b   ', '  bbb  '] };
  function drawTree(c, x, season, T) {
    if (season === 3) { putArt(c, TREE_BARE.a, TREE_BARE.m, { b: C_BROWN }, x, 5); put(c, C_STAR, '*  *', x + 1.5, 4.6); return; }
    var leaf = season === 2 ? C_ORANGE : C_LEAF;
    putArt(c, TREE.a, TREE.m, { g: leaf, b: C_BROWN }, x, 5);
    if (season === 0) { put(c, C_PINK, '*', x + 2, 5); put(c, C_PINK, '*', x + 5, 6); put(c, C_PINK, '*', x + 1, 6); }
    if (season === 1) { put(c, C_RED, 'o', x + 4, 6); put(c, C_RED, 'o', x + 2, 7); }
    if (season === 2) {                                     // falling leaves
      for (var k = 0; k < 3; k++) {
        var ph = (T * 0.35 + k * 0.33) % 1;
        put(c, k % 2 ? C_GOLD : C_ORANGE, ',', x + 1 + k * 2 + Math.sin(T * 2 + k) * 0.8, 6 + ph * 4);
      }
    }
  }
  function drawScene() {
    if (!S || !S.ctx || !S.atl) return;
    var c = S.ctx, s = S.s, sc = S.sc, now = Date.now(), cols = S.cols, i, k;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.clearRect(0, 0, S.W, S.H);
    var hour = hourOf(s, now), night = hour < 6 || hour >= 20, wx = weatherAt(s, now), season = seasonOf(s, now), T = sc.t;
    if (sc.flash > 0) { c.fillStyle = S.col.flash; c.fillRect(0, 0, S.W, S.H); }
    // stars
    if (night && wx !== 'storm' && wx !== 'rain') {
      for (i = 0; i < 26; i++) {
        var hx = hash2(i, 91), sx = hx % cols, sy = (hx >>> 8) % 5, tw = Math.sin(T * (1 + (i % 3)) + i) > 0.6;
        put(c, tw ? C_STAR : C_FAINT, tw && i % 4 === 0 ? '*' : '.', sx, sy * 0.85);
      }
    }
    // sun or moon on an arc across the day / night
    var frac = night ? ((hour - 20 + 24) % 24) / 10 : (hour - 6) / 14, bx = 2 + frac * (cols - 5), by = 3.3 - 3 * Math.sin(Math.PI * frac);
    var dim = wx !== 'sun';
    if (night) put(c, dim ? C_FAINT : C_STAR, 'C', bx, by);
    else {
      put(c, dim ? C_FAINT : C_GOLD, 'O', bx, by);
      if (!dim) {
        var ph = Math.floor(T * 2) % 2;
        put(c, C_GOLD, ph ? '-' : '~', bx - 1.15, by); put(c, C_GOLD, ph ? '-' : '~', bx + 1.15, by);
        put(c, C_GOLD, ph ? '\'' : '.', bx, by - 0.85);
      }
    }
    // far hills
    for (i = 0; i < cols; i++) {
      var hh = Math.sin(i * 0.21) + 0.6 * Math.sin(i * 0.53 + 1.3), ch = hh > 0.9 ? '^' : hh > 0.2 ? '-' : hh > -0.6 ? '_' : '.';
      put(c, C_HILL, ch, i, hh > 0.9 ? 4.6 : 5);
    }
    // clouds
    for (i = 0; i < sc.clouds.length; i++) {
      var cl = sc.clouds[i];
      if (!cl.on) continue;
      var sh = CLOUDS[cl.k];
      for (k = 0; k < sh.length; k++) put(c, wx === 'storm' || wx === 'rain' ? C_STORM : C_CLOUD, sh[k], Math.round(cl.x), cl.y + k * 0.9);
    }
    if (sc.bolt) { var bx2 = Math.round(sc.bolt.x); put(c, C_GOLD, '/', bx2, 2); put(c, C_GOLD, '\\', bx2, 3); put(c, C_GOLD, '/', bx2, 4); }
    // birds
    for (i = 0; i < sc.birds.length; i++) put(c, C_FAINT, Math.floor(T * 4 + i) % 2 ? 'v' : '^', sc.birds[i].x, sc.birds[i].y);
    // the barn (and a silo once it's bigger)
    var bmap = { r: C_RED, b: C_BROWN, w: night ? C_GOLD : C_FAINT, t: C_MUTED };
    putArt(c, BARN.a, BARN.m, bmap, 0, 5);
    if (s.upg.barn >= 2) putArt(c, SILO.a, SILO.m, bmap, 10, 4);
    var fb = fieldBox(), left = s.upg.barn >= 2 ? 14 : 11, mid = fb.x - 5;
    // a tree between the yard and the field, when there's room
    var hens = s.an.chicken.n, cows = s.an.cow.n;
    if (mid - left - (hens ? 7 : 0) - cows * 5 >= 9) { drawTree(c, mid - 8, season, T); mid -= 8; }
    // the coop + hens
    if (hens && mid - left >= 6) {                      // (on a very narrow scene a big field leaves no yard)
      putArt(c, COOP.a, COOP.m, bmap, left, 8);
      var hx0 = left + 4, hw = Math.max(0, mid - hx0 - 2);
      for (i = 0; i < hens; i++) {
        var h = sc.hens[i], x = hx0 + h.x * hw;
        put(c, i % 3 === 2 ? C_BROWN : C_TEXT, h.peck > 0 ? (h.d > 0 ? 'o.' : '.o') : (h.d > 0 ? 'o>' : '<o'), x, 9.4 + (i % 2) * 0.5);
      }
      if (s.an.chicken.stash) put(c, Math.floor(T * 2) % 2 ? C_GOLD : C_TEXT, s.an.chicken.stash > 1 ? 'oo' : 'o', left + 1, 7);
    }
    var cx0 = left + (hens ? 5 : 0), fit = Math.min(cows, Math.floor((mid - cx0) / 5));
    if (fit > 0) {                                      // each cow grazes in its own patch of the yard
      var lane = Math.max(5, (mid - cx0 - 1) / fit);
      for (i = 0; i < fit; i++) {
        var w = sc.cows[i];
        putArt(c, COW.a, COW.m, { t: C_TEXT, b: C_BROWN }, Math.round(cx0 + i * lane + w.x * Math.max(0, lane - 5)), 6 + (i % 2) * 0.5);
      }
      if (s.an.cow.stash) put(c, Math.floor(T * 2) % 2 ? C_SKY : C_TEXT, 'U', cx0 + 1.5, 5);
    }
    // the scarecrow guards the field
    if (s.upg.scarecrow) putArt(c, SCARE.a, SCARE.m, { y: C_GOLD, t: C_TEXT, b: C_BROWN }, fb.x - 3.5, 6);
    // the field: a fence, then plants in two rows over their soil
    var fence = '';
    for (i = 0; i < fb.w + 1; i++) fence += i % fb.pw ? '-' : '+';
    put(c, C_BROWN, fence, fb.x - 0.5, 6);
    var spr = sprinkled(s), half = (fb.pw - 1) / 2;
    for (i = 0; i < s.plots.length; i++) {
      var p = s.plots[i], row = i < fb.per ? 0 : 1, col = fb.x + (i % fb.per) * fb.pw, py = 7 + row * 2, st = stageOf(p), cr = CROP[p.c];
      var wet = isWet(s, i, now);
      put(c, wet ? C_SKY : C_BROWN, wet ? '~~~'.slice(0, fb.pw - 1) : '___'.slice(0, fb.pw - 1), col, py + 1);
      if (st >= 0) {
        var g = st === 0 ? '.' : st === 1 ? ',' : st === 2 ? (p.h ? 'Y' : 'i') : ICON[cr.id];
        var sway = st === 3 && Math.sin(T * 2 + i) > 0.85 ? -0.12 : 0;
        put(c, st === 3 ? COL_SLOT[cr.col] : C_LEAF, g, col + half - 0.5 + sway + 0.5, py);
        if (st === 3 && Math.sin(T * 3 + i * 1.7) > 0.93) put(c, C_GOLD, '\'', col + half + 0.7, py - 0.6);
      }
      if (i < spr && Math.floor(T * 3 + i) % 4 === 0) put(c, C_SKY, '\'', col + half + 0.8, py - 0.5);
      if (p.crow) put(c, C_TEXT, Math.floor(T * 5 + i) % 2 ? 'v' : 'w', col + half, py - 0.9 - Math.abs(Math.sin(T * 6 + i)) * 0.3);
      if (p.pest) put(c, C_RED, Math.floor(T * 4) % 2 ? '*' : 'x', col + half + 0.8, py);
    }
    // seasonal ground cover
    for (i = 0; i < fb.x - 1; i++) {
      var gh = hash2(i, season + 7), gc = gh % 7;
      if (gc > 3) { put(c, C_HILL, '_', i, 9.6); continue; }
      var gch = season === 3 ? (gc ? '.' : '*') : season === 2 ? (gc ? ',' : '%') : (gc ? '"' : '*');
      var gco = season === 3 ? C_STAR : season === 2 ? (gc ? C_ORANGE : C_GOLD) : gc ? C_LEAF : (season === 0 ? C_PINK : C_GOLD);
      put(c, gco, gch, i, 10);
    }
    // fireflies on summer nights
    if (night && season === 1 && !WX[wx].wet) {
      for (i = 0; i < sc.flies.length; i++) {
        var f = sc.flies[i];
        if (Math.sin(T * 2 + f.p) < 0.2) continue;
        put(c, C_GOLD, '.', (f.x * cols + Math.sin(T * 0.5 + f.p) * 3 + cols) % cols, 5 + f.y * 4 + Math.sin(T + f.p) * 0.5);
      }
    }
    // rain / snow over everything
    for (i = 0; i < sc.drops.length; i++) {
      var d = sc.drops[i];
      put(c, wx === 'snow' ? (i % 3 ? C_STAR : C_TEXT) : C_SKY, wx === 'snow' ? (i % 3 ? '.' : '*') : wx === 'storm' ? '/' : '\'', d.x, d.y);
    }
  }
  function loop(ts) {
    if (!S) return;
    S.raf = 0;
    if (!running()) return;
    var dt = S.lastF ? Math.min(0.1, (ts - S.lastF) / 1000) : 0.016;
    var minDt = S.rm ? 0.5 : 1 / 30;
    if (S.lastF && dt < minDt - 0.004) { S.raf = requestAnimationFrame(loop); return; }   // ~30 fps is plenty here
    S.lastF = ts;
    stepScene(dt);
    drawScene();
    S.raf = requestAnimationFrame(loop);
  }
  function running() { return !!S && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function startLoop() { if (S && !S.raf && running()) { S.lastF = 0; S.raf = requestAnimationFrame(loop); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function layoutScene() {
    var w = Math.max(240, S.stage.clientWidth || 300), h = ROWS * RH, dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.height = h + 'px';
    S.cv.width = Math.round(w * dpr); S.cv.height = Math.round(h * dpr);
    S.k = S.cv.width / w; S.W = w; S.H = h;
    S.cols = Math.floor(w / CW);
    if (S.col) fitFont();
  }

  // ---- the panel ----
  function now() { return Date.now(); }
  function step() {                        // bring the farm up to now; react to what happened
    var rep = tick(S.s, now());
    react(rep, true);
    return rep;
  }
  function react(rep, live) {
    var s = S.s, any = false;
    if (rep.ripe.length) { any = true; if (live) { sfx('ripe'); rep.ripe.forEach(function (i) { fxPlot(i, '*', 'ripe'); }); } }
    if (rep.crows.length) { any = true; if (live) { sfx('caw'); say('A crow landed on plot ' + (rep.crows[0] + 1) + ' - tap it!'); } }
    if (rep.pecked) { any = true; if (live) toast('A crow pecked a crop. A scarecrow keeps them away.'); }
    if (rep.pests) { any = true; if (live) say('A bug is chewing a crop - tap to squash it.'); }
    if (rep.bees) any = true;
    if (rep.gift) { any = true; if (live) { sfx('sell'); toast('A neighbour left you a basket: +' + money(rep.gift)); } }
    if (rep.prod.egg || rep.prod.milk) { any = true; if (live) sfx('cluck'); }
    if (rep.bugsLeft) any = true;
    if (any) S.dirty = true;
    afterChange();
    void s;
  }
  function toast(m) { try { if (Cade.showToast) Cade.showToast(m, 'info', 2200); } catch (e) {} }
  function say(m) { if (S && S.liveEl) S.liveEl.textContent = m; }
  function afterChange() {
    var s = S.s, got = checkAch(s, now());
    if (got.length) {
      S.dirty = true; sfx('gold');
      got.forEach(function (a) { toast('Achievement: ' + a.name + ' (+' + money(a.r) + ')'); });
    }
    if (s.lv > S.lastLv) {
      var un = CROPS.filter(function (c) { return c.lv > S.lastLv && c.lv <= s.lv; }).map(function (c) { return c.name; });
      S.lastLv = s.lv; S.dirty = true;
      sfx('level'); buzz(20);
      toast('Level ' + s.lv + '!' + (un.length ? ' New seeds: ' + un.join(', ') : ''));
      S.hud.classList.remove('tf-pulse'); void S.hud.offsetWidth; S.hud.classList.add('tf-pulse');
    }
  }
  function commit() { S.dirty = true; afterChange(); persist(); render(); }

  // ---- views ----
  function hudHtml() {
    var s = S.s, t = now(), li = levelInfo(s), se = seasonOf(s, t), w = wxShown(s, t);
    return '<span class="tf-money">' + money(s.coins) + '</span>' +
      '<span class="tf-lv" title="' + fmtInt(li.cur) + ' / ' + fmtInt(li.need) + ' xp">Lv ' + li.lv + '<i class="tf-xp"><b style="width:' + Math.round(li.frac * 100) + '%"></b></i></span>' +
      '<span class="tf-sky"><b>' + SEASONS[se].name + '</b> ' + seasonDay(s, t) + '/7 <i>' + esc(w.ch) + '</i> ' + esc(w.name) + '</span>';
  }
  function wxShown(s, t) { var w = WX[weatherAt(s, t)]; return w.id === 'sun' && !isDaytime(s, t) ? { ch: 'C', name: 'Clear' } : w; }
  function renderHud() { var h = hudHtml(); if (h !== S.hudSig) { S.hudSig = h; S.hud.innerHTML = h; } }
  function tabsHtml() {
    var s = S.s, rd = 0;
    s.plots.forEach(function (p) { if (isReady(p) || p.crow || p.pest) rd++; });
    var inv = invCount(s), cap = barnCap(s), gift = canDaily(s, now());
    function tb(id, label, badge) {
      return '<button type="button" role="tab" data-tab="' + id + '" class="' + (S.tab === id ? 'on' : '') + '" aria-selected="' + (S.tab === id) + '">' + label + (badge ? ' <em>' + badge + '</em>' : '') + '</button>';
    }
    return tb('field', 'Farm', rd ? rd : '') + tb('shop', 'Shop', '') + tb('barn', 'Barn', inv ? (inv >= cap ? 'full' : fmtInt(inv)) : '') + tb('goals', 'Goals', gift ? 'gift' : '');
  }
  function renderTabs() { var h = tabsHtml(); if (h !== S.tabSig) { S.tabSig = h; S.tabs.innerHTML = h; } }

  function render() {
    if (!S) return;
    renderHud(); renderTabs();
    if (S.tab === 'field') renderField(); else renderPage(false);
  }

  // Field: seed chips, the plots, the action row and an info line.
  function buildField() {
    var s = S.s, h = '<div class="tf-seeds" role="listbox" aria-label="Seed to sow"></div><div class="tf-gridw"><div class="tf-grid">';
    for (var i = 0; i < s.plots.length; i++) {
      h += '<button type="button" class="tf-plot" data-i="' + i + '"><span class="tf-art"></span><span class="tf-soil"></span>' +
        '<span class="tf-bar"><b></b></span><span class="tf-nm"></span><span class="tf-tm"></span><span class="tf-bad" aria-hidden="true"></span></button>';
    }
    h += '</div><div class="tf-fx" aria-hidden="true"></div></div><div class="tf-acts"></div><div class="tf-info"></div>';
    S.view.innerHTML = h;
    S.view.className = 'tf-view tf-v-field';
    S.grid = S.view.querySelector('.tf-grid'); S.fx = S.view.querySelector('.tf-fx');
    S.plotEls = Array.prototype.slice.call(S.grid.children).map(function (el) {
      return { el: el, art: el.children[0], soil: el.children[1], bar: el.children[2].firstChild, nm: el.children[3], tm: el.children[4], bad: el.children[5], sig: {} };
    });
    S.fieldN = s.plots.length; S.pageSig = '';
    S.seedSig = S.actSig = S.infoSig = '';
  }
  function setTxt(o, k, el, v, html) { if (o.sig[k] !== v) { o.sig[k] = v; if (html) el.innerHTML = v; else el.textContent = v; } }
  function renderField() {
    var s = S.s, t = now(), i;
    if (S.view.className.indexOf('tf-v-field') < 0 || S.fieldN !== s.plots.length) buildField();
    // seed chips
    var se = seasonOf(s, t), chips = '';
    CROPS.forEach(function (c) {
      if (!unlocked(s, c)) return;
      var ok = inSeason(c, se), have = s.seeds[c.id] || 0;
      chips += '<button type="button" role="option" class="tf-chip' + (s.sel === c.id ? ' on' : '') + (ok ? '' : ' off') + '" data-a="sel" data-id="' + c.id + '" aria-selected="' + (s.sel === c.id) + '"' +
        ' title="' + esc(c.name + ' - ' + (ok ? (have ? have + ' seeds' : money(c.cost) + ' a seed') : 'sow in ' + seasonsTxt(c))) + '">' +
        '<b class="tf-c-' + c.col + '">' + esc(ICON[c.id]) + '</b>' + esc(c.name) + '<i>' + (ok ? (have ? 'x' + have : money(c.cost)) : 'zz') + '</i></button>';
    });
    if (chips !== S.seedSig) {
      S.seedSig = chips;
      var sb = S.view.querySelector('.tf-seeds'), sl = sb.scrollLeft;
      sb.innerHTML = chips; sb.scrollLeft = sl;
    }
    var selC = CROP[s.sel], ready = 0, thirsty = 0, empty = 0;
    for (i = 0; i < s.plots.length; i++) {
      var p = s.plots[i], o = S.plotEls[i], st = stageOf(p), c = CROP[p.c], wet = isWet(s, i, t), cls = 'tf-plot';
      if (st === 3) { cls += ' ready'; ready++; }
      if (wet) cls += ' wet';
      if (p.crow) cls += ' crow';
      if (p.pest) cls += ' pest';
      if (st < 0) { cls += ' empty'; empty++; }
      if (i === S.selPlot) cls += ' sel';
      if (needsWater(s, i, t)) thirsty++;
      if (o.sig.cls !== cls) { o.sig.cls = cls; o.el.className = cls; }
      setTxt(o, 'art', o.art, plotArt(p), true);
      setTxt(o, 'soil', o.soil, wet ? '~~~~~' : '_._._');
      var pct = !c ? 0 : st === 3 ? 100 : Math.min(99, Math.floor(p.g / c.grow * 100));
      if (o.sig.pct !== pct) { o.sig.pct = pct; o.bar.style.width = pct + '%'; }
      var nm, tm;
      if (p.crow) { nm = 'CROW!'; tm = 'tap to shoo'; }
      else if (p.pest) { nm = 'BUG!'; tm = 'tap to squash'; }
      else if (!c) { nm = selC ? '+ ' + selC.name : 'empty'; tm = 'tap to sow'; }
      else if (st === 3) { nm = c.name; tm = 'READY'; }
      else { nm = c.name; tm = fmtDur(etaOf(s, i)); }
      setTxt(o, 'nm', o.nm, nm);
      setTxt(o, 'tm', o.tm, tm);
      setTxt(o, 'bad', o.bad, p.crow ? '\\v/' : p.pest ? '<*>' : '');
      var al = 'Plot ' + (i + 1) + ': ' + (c ? c.name + ', ' + (st === 3 ? 'ready to harvest' : pct + '% grown') + (wet ? ', watered' : '') : 'empty') + (p.crow ? ', a crow is on it' : '') + (p.pest ? ', a bug is on it' : '');
      if (o.sig.al !== al) { o.sig.al = al; o.el.setAttribute('aria-label', al); }
    }
    // actions
    var waiting_ = waiting(s), acts =
      '<button type="button" class="tf-btn' + (ready ? ' hot' : '') + '" data-a="harvest-all"' + (ready ? '' : ' disabled') + '>Harvest all' + (ready ? ' <em>' + ready + '</em>' : '') + '</button>' +
      '<button type="button" class="tf-btn" data-a="water-all"' + (thirsty ? '' : ' disabled') + '>Water all' + (thirsty ? ' <em>' + thirsty + '</em>' : '') + '</button>' +
      '<button type="button" class="tf-btn" data-a="plant-all"' + (empty ? '' : ' disabled') + '>Sow all' + (empty ? ' <em>' + empty + '</em>' : '') + '</button>' +
      (s.an.chicken.n || s.an.cow.n ? '<button type="button" class="tf-btn' + (waiting_ ? ' hot' : '') + '" data-a="collect"' + (waiting_ ? '' : ' disabled') + '>Collect' + (waiting_ ? ' <em>' + waiting_ + '</em>' : '') + '</button>' : '');
    if (acts !== S.actSig) { S.actSig = acts; S.view.querySelector('.tf-acts').innerHTML = acts; }
    // info line
    var info = infoHtml(t);
    if (info !== S.infoSig) { S.infoSig = info; S.view.querySelector('.tf-info').innerHTML = info; }
  }
  function infoHtml(t) {
    var s = S.s, i = S.selPlot, p = s.plots[i];
    if (!p) {
      var hint = HINTS[Math.floor(t / 12000) % HINTS.length];
      if (invCount(s) >= barnCap(s)) hint = 'Your barn is full - sell something in the <b>Barn</b>.';
      return '<span class="tf-hint">' + hint + '</span>';
    }
    var c = CROP[p.c], wet = isWet(s, i, t), parts = ['<b>Plot ' + (i + 1) + '</b>'];
    if (!c) parts.push('empty - tap to sow ' + esc(CROP[s.sel].name.toLowerCase()));
    else {
      var st = stageOf(p);
      parts.push(esc(c.name) + (c.re ? ' (harvest ' + (p.h + 1) + '/' + c.reN + ')' : ''));
      parts.push(st === 3 ? '<b class="tf-ok">ready</b>' : Math.floor(p.g / c.grow * 100) + '% - ' + (p.pest ? 'stopped by a bug' : 'ready in ' + fmtDur(etaOf(s, i))));
      parts.push(c.y + ' x ' + money(priceOf(s, c.id, t)));
    }
    if (i < sprinkled(s)) parts.push('<span class="tf-c-sky">sprinkler</span>');
    else if (p.w > t) parts.push('<span class="tf-c-sky">wet ' + fmtDur(p.w - t) + '</span>');
    else if (wet) parts.push('<span class="tf-c-sky">rain</span>');
    else parts.push('dry');
    var btns = '';
    if (c && stageOf(p) !== 3 && needsWater(s, i, t)) btns += '<button type="button" class="tf-lnk" data-a="water" data-i="' + i + '">water</button>';
    if (c) btns += S.digArm === i ? '<button type="button" class="tf-lnk danger" data-a="dig-yes" data-i="' + i + '">dig it up?</button>' :
      '<button type="button" class="tf-lnk" data-a="dig" data-i="' + i + '">dig up</button>';
    return '<span>' + parts.join(' &middot; ') + '</span>' + (btns ? '<span class="tf-ib">' + btns + '</span>' : '');
  }
  var HINTS = [
    'Tap a plot: sow, water, harvest - whatever it needs.',
    'Wet soil grows twice as fast. Rain waters every plot.',
    'Your farm keeps growing while the panel is closed.',
    'Market prices change daily - check the <b>Barn</b>.',
    'Crows peck young crops. Tap them away, or buy a scarecrow.',
    'Seasons turn every 7 days. Each crop has its seasons.',
    'Long crops are made for nights and busy days.',
    'Golden crops sell for five times the price.'
  ];

  // Shop / Barn / Goals pages: rebuilt only when what they show changes.
  function renderPage(force) {
    var h = S.tab === 'shop' ? shopHtml() : S.tab === 'barn' ? barnHtml() : goalsHtml();
    if (!force && h === S.pageSig && S.view.className.indexOf('tf-v-' + S.tab) >= 0) return;
    var keep = S.view.className.indexOf('tf-v-' + S.tab) >= 0 ? S.view.scrollTop : 0;
    var fk = document.activeElement && S.view.contains(document.activeElement) ? focusKey(document.activeElement) : null;
    S.pageSig = h; S.fieldN = -1;
    S.view.className = 'tf-view tf-v-' + S.tab;
    S.view.innerHTML = h;
    S.view.scrollTop = keep;
    if (fk) { var nb = S.view.querySelector(fk); if (nb) { try { nb.focus({ preventScroll: true }); } catch (e) {} } }
  }
  function focusKey(el) {
    var a = el.getAttribute('data-a');
    if (!a) return null;
    var sel = '[data-a="' + a + '"]';
    ['data-id', 'data-k', 'data-n'].forEach(function (k) { var v = el.getAttribute(k); if (v != null) sel += '[' + k + '="' + v + '"]'; });
    return sel;
  }
  function btn(a, label, ok, attrs, cls) {
    return '<button type="button" class="tf-buy' + (cls ? ' ' + cls : '') + '" data-a="' + a + '"' + (attrs || '') + (ok ? '' : ' aria-disabled="true"') + '>' + label + '</button>';
  }
  function pips(k, max) { var o = ''; for (var i = 0; i < max; i++) o += i < k ? '#' : '-'; return '<span class="tf-pips">[' + o + ']</span>'; }
  function shopHtml() {
    var s = S.s, t = now(), se = seasonOf(s, t), h = '<div class="tf-sec"><div class="tf-h">Seeds <i>' + SEASONS[se].name.toLowerCase() + ' now</i></div>';
    CROPS.forEach(function (c) {
      var lock = !unlocked(s, c), have = s.seeds[c.id] || 0, ok = inSeason(c, se);
      h += '<div class="tf-row' + (lock ? ' locked' : '') + '">' + '<b class="tf-ic tf-c-' + c.col + '">' + esc(lock ? '?' : ICON[c.id]) + '</b>' +
        '<span class="tf-nm2">' + esc(c.name) + (have ? ' <i class="tf-have">x' + have + '</i>' : '') +
        '<small>' + (ok ? '' : '<span class="tf-off">') + seasonsTxt(c) + (ok ? '' : '</span>') + ' &middot; ' + fmtDur(c.grow * 1000) + (c.y > 1 ? ' &middot; x' + c.y : '') + (c.re ? ' &middot; regrows x' + (c.reN - 1) : '') + '</small></span>' +
        '<span class="tf-pr">' + money(c.cost) + ' <i>&rarr; ' + money(c.sell) + (c.y > 1 ? '&times;' + c.y : '') + '</i></span>';
      if (lock) h += '<span class="tf-need">Lv ' + c.lv + '</span>';
      else h += btn('seed', '+1', s.coins >= c.cost, ' data-id="' + c.id + '" data-n="1"') + btn('seed', '+5', s.coins >= c.cost * 5, ' data-id="' + c.id + '" data-n="5"');
      h += '</div>';
    });
    h += '</div><div class="tf-sec"><div class="tf-h">Land <i>' + s.plots.length + ' / ' + MAX_PLOTS + ' plots</i></div>';
    var ec = expandCost(s);
    h += '<div class="tf-row"><b class="tf-ic tf-c-brown">#</b><span class="tf-nm2">Clear more land<small>' + (ec < 0 ? 'every plot is yours' : '+2 plots') + '</small></span>' +
      (ec < 0 ? '<span class="tf-need">max</span>' : btn('expand', money(ec), s.coins >= ec, '', 'wide')) + '</div>';
    h += '</div><div class="tf-sec"><div class="tf-h">Upgrades</div>';
    UPGRADES.forEach(function (u) {
      var k = s.upg[u.id], cost = upgCost(s, u.id), need = upgLv(s, u.id), next = upgNext(u, k);
      h += '<div class="tf-row"><b class="tf-ic tf-c-' + UPG_COL[u.id] + '">' + UPG_IC[u.id] + '</b><span class="tf-nm2">' + esc(u.name) + ' ' + pips(k, u.max) +
        '<small>' + upgNow(u, k) + (next ? ' &rarr; ' + next : '') + '</small></span>' +
        (cost < 0 ? '<span class="tf-need">max</span>' : s.lv < need ? '<span class="tf-need">Lv ' + need + '</span>' : btn('upg', money(cost), s.coins >= cost, ' data-id="' + u.id + '"', 'wide')) + '</div>';
    });
    h += '</div><div class="tf-sec"><div class="tf-h">Animals</div>';
    ANIMALS.forEach(function (d) {
      var n = s.an[d.id].n, cost = animalCost(s, d.id), pr = ITEMS[d.prod];
      h += '<div class="tf-row' + (s.lv < d.lv ? ' locked' : '') + '"><b class="tf-ic tf-c-' + (d.id === 'cow' ? 'sky' : 'bone') + '">' + (d.id === 'cow' ? 'M' : '&gt;') + '</b><span class="tf-nm2">' + d.name + 's <i class="tf-have">' + n + '/' + d.max + '</i>' +
        '<small>one ' + pr.name.toLowerCase() + ' every ' + fmtDur(d.period) + ' each, holds ' + d.cap + ' &middot; ' + money(pr.sell) + '</small></span>' +
        (cost < 0 ? '<span class="tf-need">max</span>' : s.lv < d.lv ? '<span class="tf-need">Lv ' + d.lv + '</span>' : btn('animal', money(cost), s.coins >= cost, ' data-id="' + d.id + '"', 'wide')) + '</div>';
    });
    return h + '</div>';
  }
  var UPG_IC = { can: 'U', sprinkler: 'T', scarecrow: '+', barn: 'A' }, UPG_COL = { can: 'sky', sprinkler: 'sky', scarecrow: 'gold', barn: 'red' };
  function upgNow(u, k) {
    if (u.id === 'can') return 'water lasts ' + fmtDur(u.val[k]);
    if (u.id === 'sprinkler') return k ? 'waters plots 1-' + u.val[k] : 'none yet';
    if (u.id === 'scarecrow') return k ? (u.val[k] ? Math.round((1 - u.val[k]) * 100) + '% fewer crows' : 'no crows at all') : 'none yet';
    return 'holds ' + u.val[k];
  }
  function upgNext(u, k) {
    if (k >= u.max) return '';
    if (u.id === 'can') return fmtDur(u.val[k + 1]);
    if (u.id === 'sprinkler') return 'plots 1-' + u.val[k + 1];
    if (u.id === 'scarecrow') return u.val[k + 1] ? Math.round((1 - u.val[k + 1]) * 100) + '%' : 'none';
    return '' + u.val[k + 1];
  }
  function barnHtml() {
    var s = S.s, t = now(), inv = invCount(s), cap = barnCap(s), keys = Object.keys(s.inv);
    keys.sort(function (a, b) { return priceOf(s, b, t) * s.inv[b] - priceOf(s, a, t) * s.inv[a]; });
    var total = 0;
    keys.forEach(function (k) { total += priceOf(s, k, t) * s.inv[k]; });
    var h = '<div class="tf-sec"><div class="tf-h">Barn <i>' + inv + ' / ' + cap + '</i></div>' +
      '<div class="tf-cap"><b style="width:' + Math.min(100, Math.round(inv / cap * 100)) + '%" class="' + (inv >= cap ? 'full' : '') + '"></b></div>';
    if (!keys.length) h += '<p class="tf-empty">Nothing here yet. Harvest a crop and it lands in the barn.</p>';
    else {
      h += '<div class="tf-row tf-total"><span class="tf-nm2">Everything<small>today\'s prices</small></span>' + btn('sell-all', 'Sell all ' + money(total), true, '', 'wide hot') + '</div>';
      keys.forEach(function (k) {
        var pr = priceOf(s, k, t), tr = trendOf(s, k, t), n = s.inv[k];
        var arrow = tr >= 1.05 ? '<span class="tf-up">^' + Math.round((tr - 1) * 100) + '%</span>' : tr <= 0.95 ? '<span class="tf-dn">v' + Math.round((1 - tr) * 100) + '%</span>' : '<span class="tf-fl">=</span>';
        h += '<div class="tf-row">' + itemIcon(k) + '<span class="tf-nm2">' + esc(itemName(k)) + ' <i class="tf-have">x' + n + '</i><small>' + money(pr) + ' each ' + arrow + '</small></span>' +
          btn('sell', 'Sell 1', true, ' data-k="' + esc(k) + '" data-n="1"') + btn('sell', money(pr * n), true, ' data-k="' + esc(k) + '" data-n="all"', 'wide') + '</div>';
      });
    }
    h += '</div>';
    // today's market
    var se = seasonOf(s, t), hot = Object.keys(ITEMS).filter(function (k) { var it = ITEMS[k]; return !it.crop || unlocked(s, it.crop); })
      .map(function (k) { return { k: k, tr: trendOf(s, k, t) }; }).sort(function (a, b) { return b.tr - a.tr; }).slice(0, 4);
    h += '<div class="tf-sec"><div class="tf-h">Market today</div><p class="tf-mk">' + hot.map(function (o) {
      return itemIcon(o.k) + ' ' + esc(ITEMS[o.k].name) + ' <span class="' + (o.tr >= 1 ? 'tf-up' : 'tf-dn') + '">' + (o.tr >= 1 ? '+' : '') + Math.round((o.tr - 1) * 100) + '%</span>';
    }).join(' &nbsp; ') + '</p><p class="tf-note">Prices move every day; crops sold out of season fetch 20% more. Now: ' + SEASONS[se].name + '.</p></div>';
    if (s.an.chicken.n || s.an.cow.n) {
      h += '<div class="tf-sec"><div class="tf-h">Animals</div>';
      ANIMALS.forEach(function (d) {
        var A = s.an[d.id];
        if (!A.n) return;
        var full = A.stash >= A.n * d.cap, next = full ? 0 : d.period - (t - A.t);
        h += '<div class="tf-row"><b class="tf-ic tf-c-' + (d.id === 'cow' ? 'sky' : 'bone') + '">' + (d.id === 'cow' ? 'M' : '&gt;') + '</b><span class="tf-nm2">' + plural(A.n, d.name.toLowerCase()) +
          '<small>' + A.stash + ' / ' + A.n * d.cap + ' ' + ITEMS[d.prod].name.toLowerCase() + 's waiting' + (full ? ' - full!' : ' &middot; next in ' + fmtDur(Math.max(0, next))) + '</small></span>' +
          btn('collect', 'Collect', A.stash > 0, '', 'wide') + '</div>';
      });
      h += '</div>';
    }
    return h;
  }
  function goalsHtml() {
    var s = S.s, t = now(), li = levelInfo(s), next = CROPS.filter(function (c) { return c.lv === li.lv + 1; }).map(function (c) { return c.name; });
    var h = '<div class="tf-sec"><div class="tf-h">Level ' + li.lv + ' <i>' + (li.max ? 'max' : fmtInt(li.cur) + ' / ' + fmtInt(li.need) + ' xp') + '</i></div>' +
      '<div class="tf-cap"><b style="width:' + Math.round(li.frac * 100) + '%"></b></div>' +
      (next.length ? '<p class="tf-note">Level ' + (li.lv + 1) + ' unlocks ' + esc(next.join(', ')) + '.</p>' : '') + '</div>';
    var dr = dailyReward(s, t), can = canDaily(s, t);
    h += '<div class="tf-sec"><div class="tf-h">Daily gift <i>streak ' + s.daily.streak + ', best ' + s.daily.best + '</i></div>' +
      '<div class="tf-row"><b class="tf-ic tf-c-gold">$</b><span class="tf-nm2">' + (can ? 'Today: ' + money(dr.coins) + ' + ' + dr.n + ' ' + esc(seedWord(CROP[dr.seed])) + ' seeds' : 'Collected today') +
      '<small>' + (can ? 'day ' + dr.streak + ' of your streak' : 'the next gift is ready tomorrow') + '</small></span>' + (can ? btn('claim', 'Claim', true, '', 'wide hot') : '') + '</div></div>';
    var done = 0;
    ACHS.forEach(function (a) { if (s.ach[a.id]) done++; });
    h += '<div class="tf-sec"><div class="tf-h">Achievements <i>' + done + ' / ' + ACHS.length + '</i></div><div class="tf-achs">';
    ACHS.forEach(function (a) {
      var ok = !!s.ach[a.id];
      h += '<div class="tf-ach' + (ok ? ' ok' : '') + '"><b>' + (ok ? '[x]' : '[ ]') + '</b><span>' + esc(a.name) + '<small>' + esc(a.info) + ' &middot; ' + money(a.r) + '</small></span></div>';
    });
    h += '</div></div>';
    var st = s.st, age = farmDay(s, t) + 1;
    h += '<div class="tf-sec"><div class="tf-h">Farm record</div><pre class="tf-tab">' +
      'farm age   <b>' + plural(age, 'day') + '</b> (year ' + year(s, t) + ')\n' +
      'harvests   <b>' + fmtInt(st.harv) + '</b>  golden <b>' + fmtInt(st.gold) + '</b>\n' +
      'earned     <b>' + money(st.earned) + '</b>\n' +
      'planted    <b>' + fmtInt(st.planted) + '</b>  watered <b>' + fmtInt(st.water) + '</b>\n' +
      'crows      <b>' + fmtInt(st.shoo) + '</b> shooed, <b>' + fmtInt(st.pecked) + '</b> pecks\n' +
      'bugs       <b>' + fmtInt(st.bugs) + '</b> squashed\n' +
      'eggs       <b>' + fmtInt(st.eggs) + '</b>  milk <b>' + fmtInt(st.milk) + '</b></pre></div>';
    h += '<div class="tf-sec"><div class="tf-h">Farm diary</div><ul class="tf-log">' + s.log.slice(-12).reverse().map(function (e) {
      return '<li><i>' + fmtAgo(Math.max(0, t - e.t)) + '</i>' + esc(e.m) + '</li>';
    }).join('') + '</ul></div>';
    h += '<div class="tf-foot">' + (S.resetArm ? '<span>Plough everything under and start over?</span><button type="button" class="tf-lnk danger" data-a="reset-yes">yes, reset</button><button type="button" class="tf-lnk" data-a="reset-no">keep my farm</button>' :
      '<button type="button" class="tf-lnk" data-a="help">how to play</button><button type="button" class="tf-lnk" data-a="reset">reset farm</button>') + '</div>';
    return h;
  }

  // ---- cards over the panel ----
  function showCard(html) {
    S.ovl.innerHTML = '<div class="tf-card" role="dialog" aria-modal="true">' + html + '</div>';
    S.ovl.hidden = false;
    S.root.classList.add('dim');
    var b = S.ovl.querySelector('.tf-go');
    if (b && !S.coarse) { try { b.focus({ preventScroll: true }); } catch (e) {} }
  }
  function hideCard() { S.ovl.hidden = true; S.ovl.innerHTML = ''; S.root.classList.remove('dim'); S.card = null; nextCard(); }
  function queueCard(k, data) { S.cards.push({ k: k, d: data }); if (!S.card) nextCard(); }
  function nextCard() {
    if (S.card || !S.cards.length) return;
    S.card = S.cards.shift();
    var k = S.card.k, d = S.card.d;
    if (k === 'help') showCard(helpHtml(d));
    else if (k === 'away') showCard(awayHtml(d));
    else if (k === 'daily') {
      if (!canDaily(S.s, now())) { S.card = null; nextCard(); return; }
      showCard(dailyHtml());
    }
  }
  var FARM_ART = [
    '   _\\/_       ,      ',
    '    /\\   .  \\|/  .   ',
    '   /__\\  |  \\|/  |   ',
    '~~~|[]|~~~~~~~~~~~~~~'
  ].join('\n');
  function helpHtml(first) {
    return '<div class="tf-title">TINY FARM</div><pre class="tf-art2">' + esc(FARM_ART) + '</pre>' +
      (first ? '<p>A little farm that grows in <b>real time</b> - even while this panel is closed.</p>' : '') +
      '<div class="tf-keys">' +
      '<span><b>Tap a plot</b> and it does what it needs: sow the chosen seed, water it, harvest it.</span>' +
      '<span><b>Wet soil</b> grows twice as fast. Rain waters everything; snow slows all but winter crops.</span>' +
      '<span><b>Sell</b> in the Barn (prices move daily); buy seeds, land and upgrades in the Shop.</span>' +
      '<span><b>Crows</b> peck young crops - tap them away. <b>Bugs</b> stop a crop until squashed.</span>' +
      '<span><b>Seasons</b> turn every 7 days; each crop has its own. Chickens and cows produce while you\'re away.</span>' +
      '</div><p class="tf-note">Come back every day for a gift. Golden crops sell for 5x.</p>' +
      '<button type="button" class="tf-go" data-a="card-ok">' + (first ? 'Start farming' : 'Back to the farm') + '</button>';
  }
  function awayHtml(d) {
    var L = [], r = d.rep;
    if (r.ripe.length) L.push(plural(r.ripe.length, 'crop') + ' ripened');
    if (r.wetH >= 1) L.push('it rained for ' + fmtDur(r.wetH * HOUR).replace(/ 0+m$/, ''));
    if (r.snowH >= 1) L.push('it snowed for ' + fmtDur(r.snowH * HOUR).replace(/ 0+m$/, ''));
    if (r.bees) L.push('bees helped ' + plural(r.bees, 'crop'));
    if (r.pecked) L.push('crows pecked ' + plural(r.pecked, 'time'));
    if (r.pests) L.push(plural(r.pests, 'bug') + ' came by');
    if (r.gift) L.push('a neighbour left ' + money(r.gift));
    if (r.prod.egg) L.push(plural(r.prod.egg, 'egg') + ' laid');
    if (r.prod.milk) L.push(r.prod.milk + ' milk ready');
    if (d.clamped) L.push('(only the last ' + Math.round(MAX_AWAY / DAY) + ' days count)');
    var ready = S.s.plots.filter(isReady).length;
    return '<div class="tf-title">WELCOME BACK</div><p class="tf-sub">You were away ' + fmtDur(d.ms).replace(/ \d+s$/, '') + '.</p>' +
      '<ul class="tf-away">' + L.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      (ready ? '<p class="tf-big">' + ready + ' ready</p>' : '') +
      '<button type="button" class="tf-go" data-a="card-ok">To the farm</button>';
  }
  function dailyHtml() {
    var r = dailyReward(S.s, now()), c = CROP[r.seed], bar = '';
    for (var i = 1; i <= 7; i++) bar += i <= ((r.streak - 1) % 7) + 1 ? '#' : '-';
    return '<div class="tf-title">DAILY GIFT</div><pre class="tf-art2 tf-c-gold">' + esc('  _____\n |__$__|\n |  |  |\n |__|__|') + '</pre>' +
      '<p class="tf-big">' + money(r.coins) + '</p><p class="tf-sub">+ ' + r.n + ' <b class="tf-c-' + c.col + '">' + esc(ICON[c.id]) + '</b> ' + esc(seedWord(c)) + ' seeds</p>' +
      '<p class="tf-sub tf-streak">streak [' + bar + '] day ' + r.streak + (r.streak % 7 === 0 ? ' - bonus!' : '') + '</p>' +
      '<button type="button" class="tf-go" data-a="claim">Claim</button>';
  }

  // ---- doing things ----
  function rnd() { return Math.random(); }
  function fxPlot(i, text, kind) {
    if (!S || S.tab !== 'field' || !S.plotEls || !S.plotEls[i] || !S.fx) return;
    var el = S.plotEls[i].el, sp = document.createElement('span');
    sp.className = 'tf-pop ' + (kind || '');
    sp.textContent = text;
    sp.style.left = (el.offsetLeft + el.offsetWidth / 2) + 'px';
    sp.style.top = (el.offsetTop + 10) + 'px';
    S.fx.appendChild(sp);
    setTimeout(function () { if (sp.parentNode) sp.parentNode.removeChild(sp); }, 1100);
    if (kind && kind !== 'ripe') { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
  }
  function tapPlot(i) {
    var s = S.s, t = now();
    S.snd.ensure();
    step();
    var p = s.plots[i];
    if (!p) return;
    if (S.selPlot !== i) S.digArm = -1;
    S.selPlot = i;
    if (p.crow) { shoo(s, i); sfx('shoo'); buzz(8); fxPlot(i, 'shoo!', 'act'); }
    else if (p.pest) { squash(s, i); sfx('squash'); buzz(12); fxPlot(i, 'squish', 'act'); }
    else if (!p.c) {
      var r = plant(s, i, s.sel, t);
      if (r.ok) { sfx('plant'); buzz(5); fxPlot(i, r.bought ? '-' + money(CROP[s.sel].cost) : 'sown', 'act'); }
      else { sfx('no'); toast(plantWhy(r.err, CROP[s.sel])); }
    } else if (isReady(p)) {
      var h = harvest(s, i, t, rnd);
      if (h.ok) {
        if (h.gold) { sfx('gold'); buzz(25); fxPlot(i, 'GOLDEN!', 'gold'); toast('A golden ' + CROP[h.crop].name.toLowerCase() + '! Worth 5x.'); }
        else { sfx('harvest'); buzz(8); fxPlot(i, '+' + h.n + ' ' + CROP[h.crop].name.toLowerCase(), 'act'); }
      } else if (h.err === 'full') { sfx('no'); toast('The barn is full - sell something first.'); }
    } else if (needsWater(s, i, t)) { water(s, i, t); sfx('water'); buzz(5); fxPlot(i, '~ ~', 'wet'); }
    else sfx('tap');
    commit();
  }
  function plantWhy(err, c) {
    if (err === 'season') return c.name + ' only grows in ' + seasonsTxt(c) + '.';
    if (err === 'coins') return 'Not enough money for ' + c.name.toLowerCase() + ' seeds (' + money(c.cost) + ').';
    if (err === 'level') return c.name + ' unlocks at level ' + c.lv + '.';
    return 'Can\'t sow that here.';
  }
  function doAction(a, b) {
    var s = S.s, t = now(), id = b.getAttribute('data-id'), r;
    S.snd.ensure();
    step();
    if (a === 'sel') {
      if (CROP[id]) {
        s.sel = id; sfx('tap');
        var c = CROP[id];
        if (!inSeason(c, seasonOf(s, t))) say(c.name + ' only grows in ' + seasonsTxt(c));
      }
    } else if (a === 'harvest-all') {
      r = harvestAll(s, t, rnd);
      if (r.n) { sfx(r.gold ? 'gold' : 'harvest'); buzz(10); r.plots.forEach(function (o) { fxPlot(o.i, o.r.gold ? 'GOLDEN!' : '+' + o.r.n, o.r.gold ? 'gold' : 'act'); }); }
      if (r.full) { sfx('no'); toast('The barn is full - sell something first.'); }
      if (r.gold) toast(plural(r.gold, 'golden crop') + '! Worth 5x.');
    } else if (a === 'water-all') {
      var n = 0;
      s.plots.forEach(function (p, i) { if (needsWater(s, i, t)) { water(s, i, t); n++; fxPlot(i, '~', 'wet'); } });
      if (n) { sfx('water'); buzz(6); }
    } else if (a === 'plant-all') {
      var before = s.plots.map(function (p) { return !p.c; });
      r = plantAll(s, s.sel, t);
      if (r.n) { sfx('plant'); buzz(6); before.forEach(function (e, i) { if (e && s.plots[i].c) fxPlot(i, 'sown', 'act'); }); }
      if (r.err && r.err !== 'none') { sfx('no'); toast(plantWhy(r.err, CROP[s.sel])); }
    } else if (a === 'collect') {
      r = collect(s, t, rnd);
      var parts = [];
      if (r.egg) parts.push(plural(r.egg, 'egg'));
      if (r.milk) parts.push(r.milk + ' milk');
      if (parts.length) { sfx(r.gold ? 'gold' : 'cluck'); toast('Collected ' + parts.join(' and ') + (r.gold ? ' (' + r.gold + ' golden!)' : '') + '.'); }
      if (r.full) { sfx('no'); toast('The barn is full - sell something first.'); }
    } else if (a === 'water') { if (water(s, +b.getAttribute('data-i'), t)) sfx('water'); }
    else if (a === 'dig') { S.digArm = +b.getAttribute('data-i'); }
    else if (a === 'dig-yes') { dig(s, +b.getAttribute('data-i')); S.digArm = -1; sfx('squash'); }
    else if (a === 'seed') {
      var nn = +b.getAttribute('data-n') || 1, cc = CROP[id];
      if (buySeeds(s, id, nn)) { sfx('buy'); say('Bought ' + nn + ' ' + seedWord(cc) + ' seeds'); }
      else { sfx('no'); toast('Not enough money (' + money(cc.cost * nn) + ').'); }
    } else if (a === 'expand') {
      if (expand(s)) { sfx('buy'); buzz(15); toast('Two new plots cleared!'); } else { sfx('no'); toast('Not enough money.'); }
    } else if (a === 'upg') {
      if (buyUpg(s, id)) { sfx('buy'); buzz(15); toast(UPG[id].name + ': ' + upgNow(UPG[id], s.upg[id]) + '.'); } else { sfx('no'); toast('Not enough money.'); }
    } else if (a === 'animal') {
      if (buyAnimal(s, id, t)) { sfx('cluck'); buzz(15); toast('A new ' + ANIMAL[id].name.toLowerCase() + ' joins the farm!'); } else { sfx('no'); toast('Not enough money.'); }
    } else if (a === 'sell') {
      var k = b.getAttribute('data-k'), m = b.getAttribute('data-n'), got = sell(s, k, m === 'all' ? null : +m, t);
      if (got) { sfx('sell'); say('Sold for ' + money(got)); }
    } else if (a === 'sell-all') {
      var g = sellAll(s, t);
      if (g) { sfx('sell'); buzz(10); toast('Sold everything for ' + money(g) + '.'); }
    } else if (a === 'claim') {
      r = claimDaily(s, t);
      if (r) { sfx('gold'); buzz(20); toast('Gift: ' + money(r.coins) + ' and ' + r.n + ' ' + seedWord(CROP[r.seed]) + ' seeds.'); }
      if (S.card && S.card.k === 'daily') hideCard();
    } else if (a === 'help') { queueCard('help', false); }
    else if (a === 'card-ok') { hideCard(); }
    else if (a === 'reset') { S.resetArm = true; }
    else if (a === 'reset-no') { S.resetArm = false; }
    else if (a === 'reset-yes') {
      S.resetArm = false;
      S.s = newSave(t, (Math.random() * 4294967295) >>> 0, new Date(t).getTimezoneOffset());
      S.lastLv = 1; S.selPlot = -1; S.tab = 'field'; S.fieldN = -1;
      toast('A fresh farm. Good luck!');
      queueCard('daily');
    }
    commit();
  }

  // ---- open / close ----
  function stopTimer() { if (S && S.timer) { clearInterval(S.timer); S.timer = 0; } }
  function startTimer() { if (S && !S.timer) S.timer = setInterval(onTimer, 1000); }
  function onTimer() {
    if (!S) return;
    if (!running()) return;
    step();
    render();
    if (S.dirty && now() - S.savedAt > 15000) { S.savedAt = now(); persist(); }
  }
  function teardown() {
    if (!S) return;
    var s = S;
    try { tick(s.s, now()); sset(SAVE_KEY, JSON.stringify(s.s)); } catch (e) {}
    S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearInterval(s.timer);
    clearTimeout(s.resizeT);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('pagehide', s.onHide);
    window.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    if (s.atl) freeCanvas(s.atl.cv);
    freeCanvas(s.cv);
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
  }
  // Coming back (open, tab shown again, restored from the dock): reload the save (another
  // tab may have played), replay the time away and say what happened.
  function welcome(first) {
    var t = now(), from = S.s.t, ms = t - from, rep = newRep();
    var clamped = ms > MAX_AWAY;
    tick(S.s, t, rep);
    react(rep, false);
    var news = rep.ripe.length || rep.pecked || rep.pests || rep.bees || rep.gift || rep.prod.egg || rep.prod.milk;
    if (!first && ms >= 3 * MIN && news) queueCard('away', { ms: ms, rep: rep, clamped: clamped });
    if (canDaily(S.s, t)) queueCard('daily');
    persist();
  }
  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="tf"><div class="tf-hud"></div><div class="tf-stage"><canvas class="tf-cv" aria-label="Your farm"></canvas></div>' +
      '<div class="tf-tabs" role="tablist"></div><div class="tf-view"></div><div class="tf-ovl" hidden></div><div class="tf-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🌱 Tiny Farm', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'tf-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button><button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var t = now(), ld = loadSave(t), mm = window.matchMedia;
    S = {
      panel: p, root: p.querySelector('.tf'), hud: p.querySelector('.tf-hud'), stage: p.querySelector('.tf-stage'), cv: p.querySelector('.tf-cv'),
      tabs: p.querySelector('.tf-tabs'), view: p.querySelector('.tf-view'), ovl: p.querySelector('.tf-ovl'), liveEl: p.querySelector('.tf-live'), headBtns: hb,
      s: ld.save, snd: new Snd(sget(SOUND_KEY) === '1'), dirty: false, savedAt: t, lastLv: ld.save.lv,
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      tab: 'field', selPlot: -1, digArm: -1, resetArm: false, cards: [], card: null, pal: new Array(NPAL), col: null, atl: null, k: 1,
      raf: 0, timer: 0, lastF: 0, fieldN: -1
    };
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    layoutScene();
    readTheme();
    sceneInit();
    syncHead();
    if (ld.fresh) { persist(); queueCard('help', true); }
    welcome(ld.fresh);
    render();
    drawScene();
    startTimer(); startLoop();

    S.onVis = function () {
      if (!S) return;
      if (document.hidden) { stopLoop(); stepSave(); }
      else { resync(); startLoop(); }
    };
    document.addEventListener('visibilitychange', S.onVis);
    S.onHide = function () { stepSave(); };
    window.addEventListener('pagehide', S.onHide);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) { stopLoop(); stepSave(); } });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        layoutScene(); resync(); startLoop();
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && running()) { layoutScene(); drawScene(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (!running()) { S.themeDirty = true; return; }
        readTheme(); drawScene();
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); sfx('tap');
        syncHead();
      } else if (h === 'help') {
        if (S.card && S.card.k === 'help') hideCard(); else queueCard('help', false);
      }
      try { b.blur(); } catch (er) {}
    });

    // Fast taps never zoom, select or open callouts: CSS does most of it; the plot grid and the
    // scene take their taps on touchend (cancelled, so no double-tap zoom or ghost click) and the
    // panel swallows gesture / dblclick events. Scrolling (touchmove) is left alone.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (ty) { p.addEventListener(ty, noTouch, { passive: false }); });
    var tch = null;
    S.view.addEventListener('touchstart', function (e) {
      var b = e.target.closest ? e.target.closest('.tf-plot') : null;
      tch = b && e.touches.length === 1 ? { b: b, x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });
    S.view.addEventListener('touchmove', function (e) {
      if (tch && (Math.abs(e.touches[0].clientX - tch.x) > 10 || Math.abs(e.touches[0].clientY - tch.y) > 10)) tch = null;
    }, { passive: true });
    S.view.addEventListener('touchend', function (e) {
      var b = e.target.closest ? e.target.closest('.tf-plot') : null;
      if (!tch || b !== tch.b) { tch = null; return; }
      tch = null;
      noTouch(e);
      if (S && !S.card) tapPlot(+b.getAttribute('data-i'));
    }, { passive: false });
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    S.cv.addEventListener('contextmenu', noTouch);
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      S.snd.ensure();
      step();
      var r = S.cv.getBoundingClientRect(), col = (e.clientX - r.left) / CW, row = (e.clientY - r.top) / RH, fb = fieldBox();
      if (col >= fb.x - 0.5 && row >= 6) {                   // a plot on the little map
        var ci = Math.floor((col - fb.x) / fb.pw), i = ci + (row >= 8.5 ? fb.per : 0);
        if (ci >= 0 && ci < fb.per && i < S.s.plots.length) { tapPlot(i); return; }
      }
      if (waiting(S.s)) doAction('collect', S.cv);
      else say(wxShown(S.s, now()).name + ', ' + SEASONS[seasonOf(S.s, now())].name.toLowerCase());
    });
    S.root.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S.root.contains(b)) return;
      if (b.classList.contains('tf-plot')) { if (!S.card) tapPlot(+b.getAttribute('data-i')); return; }
      var tab = b.getAttribute('data-tab');
      if (tab) {
        S.snd.ensure();
        if (S.tab !== tab) { S.tab = tab; S.resetArm = false; S.view.scrollTop = 0; sfx('tap'); }
        step(); render();
        var tb = e.detail === 0 && S.tabs.querySelector('[data-tab="' + tab + '"]');
        if (tb) { try { tb.focus({ preventScroll: true }); } catch (er) {} }
        return;
      }
      var a = b.getAttribute('data-a');
      if (a) doAction(a, b);
    });
    // arrow keys move between plots (inside the panel only)
    S.view.addEventListener('keydown', function (e) {
      if (!S || S.tab !== 'field') return;
      var b = e.target.closest ? e.target.closest('.tf-plot') : null;
      if (!b) return;
      var i = +b.getAttribute('data-i'), cols = Math.max(1, Math.round(S.grid.clientWidth / b.offsetWidth)), j = -1;
      if (e.key === 'ArrowRight') j = i + 1; else if (e.key === 'ArrowLeft') j = i - 1;
      else if (e.key === 'ArrowDown') j = i + cols; else if (e.key === 'ArrowUp') j = i - cols;
      if (j >= 0 && j < S.plotEls.length) { e.preventDefault(); S.plotEls[j].el.focus(); }
    });
    requestAnimationFrame(function () { if (S && S.panel === p) { layoutScene(); drawScene(); } });
    try {
      if (document.fonts && document.fonts.load) document.fonts.load('600 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); drawScene(); } }, function () {});
    } catch (e) {}
  }
  function stepSave() { if (!S) return; try { tick(S.s, now()); } catch (e) {} persist(); }
  function resync() {
    if (!S) return;
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    if (o && +o.t > S.s.t) { S.s = normSave(o, now()); S.s.tzo = clamp(new Date().getTimezoneOffset(), -900, 900); S.fieldN = -1; S.lastLv = Math.max(S.lastLv, S.s.lv); }
    welcome(false);
    render();
  }
  function syncHead() {
    var b = S.headBtns.querySelector('[data-h="sound"]');
    b.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    b.title = S.snd.on ? 'Sound on' : 'Sound off';
    b.setAttribute('aria-label', b.title);
    b.classList.toggle('on', S.snd.on);
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Plant ASCII crops that grow in real time while you\'re away',
    icon: '🌱',
    tags: 'game,sim,idle,farm,crops,garden,harvest,seasons,weather,chickens,ascii',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
