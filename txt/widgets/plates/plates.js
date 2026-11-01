/* License Plate Game — a road-trip tracker for Cade.txt.
 * Spot a plate, tap its state. Every US state + DC (and, as extras, Canadian
 * provinces, Mexican states, US territories and special plates) has a rarity
 * tier 1-5 worth 1/2/3/5/8 points; a trip's home state makes nearby plates
 * commoner and far ones rarer. Taps count every sighting (x3, x4 ...), hold a
 * tile (or right-click) for its card: counts per player, last seen, notes,
 * the sightings themselves. Completing a region earns a bonus.
 * Several players can share one device: pick who spotted it, and either the
 * first to call a state claims it ("first call") or everyone keeps their own
 * list ("everyone").
 * Trips are saved: start new ones, resume, rename, end, delete, share a
 * summary; records run across all trips (most states, best day, rarest plate).
 * Views: an ASCII tile map of the US, region tiles, a searchable list, the
 * sighting log, trips and stats. DOM only, theme colours, no assets, offline.
 * Persisted in Cade.store (cade-plates-*), versioned schema. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var SCHEMA = 1;
  var REGION_BONUS = 10;
  var MAX_PLAYERS = 8, MAX_TRIPS = 200, MAX_EVENTS = 5000, NOTE_MAX = 80, NAME_MAX = 40;

  var TIERS = [
    null,
    { n: 'Common', p: 1 },
    { n: 'Uncommon', p: 2 },
    { n: 'Rare', p: 3 },
    { n: 'Epic', p: 5 },
    { n: 'Legendary', p: 8 }
  ];

  // Groups: us is always on; the rest are per-trip extras.
  var GROUPS = [
    { id: 'us', name: 'United States' },
    { id: 'ca', name: 'Canada' },
    { id: 'mx', name: 'Mexico' },
    { id: 'terr', name: 'US territories' },
    { id: 'sp', name: 'Special plates' }
  ];
  var EXTRAS = ['ca', 'mx', 'terr', 'sp'];

  // Regions (US ones get a completion bonus; extras groups count as one region each).
  var REGIONS = [
    { id: 'ne', name: 'New England', g: 'us' },
    { id: 'ma', name: 'Mid-Atlantic', g: 'us' },
    { id: 'se', name: 'Southeast', g: 'us' },
    { id: 'mw', name: 'Midwest', g: 'us' },
    { id: 'sw', name: 'Southwest', g: 'us' },
    { id: 'we', name: 'West', g: 'us' },
    { id: 'can', name: 'Canada', g: 'ca' },
    { id: 'mex', name: 'Mexico', g: 'mx' },
    { id: 'ter', name: 'Territories', g: 'terr' },
    { id: 'spc', name: 'Special', g: 'sp' }
  ];
  var BONUS_REGIONS = { ne: 1, ma: 1, se: 1, mw: 1, sw: 1, we: 1, can: 1, mex: 1, ter: 1 };

  // code | name | region | base tier (national view) | lat | lon (rough population centre)
  var US_DATA = [
    'AL|Alabama|se|3|33.0|-86.7', 'AK|Alaska|we|5|61.4|-149.6', 'AZ|Arizona|sw|2|33.5|-111.9', 'AR|Arkansas|se|3|35.0|-92.4',
    'CA|California|we|1|35.5|-119.3', 'CO|Colorado|we|2|39.6|-105.0', 'CT|Connecticut|ne|3|41.5|-72.8', 'DE|Delaware|ma|4|39.4|-75.5',
    'DC|District of Columbia|ma|4|38.9|-77.0', 'FL|Florida|se|1|27.8|-81.6', 'GA|Georgia|se|1|33.3|-83.9', 'HI|Hawaii|we|5|21.3|-157.8',
    'ID|Idaho|we|4|43.8|-115.4', 'IL|Illinois|mw|1|41.3|-88.4', 'IN|Indiana|mw|2|39.9|-86.3', 'IA|Iowa|mw|3|41.9|-93.0',
    'KS|Kansas|mw|3|38.4|-97.2', 'KY|Kentucky|se|3|37.8|-85.3', 'LA|Louisiana|se|3|30.7|-91.3', 'ME|Maine|ne|4|44.3|-69.8',
    'MD|Maryland|ma|2|39.1|-76.8', 'MA|Massachusetts|ne|2|42.3|-71.4', 'MI|Michigan|mw|1|42.9|-84.2', 'MN|Minnesota|mw|2|45.2|-93.6',
    'MS|Mississippi|se|3|32.6|-89.6', 'MO|Missouri|mw|2|38.4|-92.2', 'MT|Montana|we|4|46.6|-110.2', 'NE|Nebraska|mw|4|41.1|-97.4',
    'NV|Nevada|we|3|37.2|-115.5', 'NH|New Hampshire|ne|4|43.0|-71.5', 'NJ|New Jersey|ma|2|40.4|-74.4', 'NM|New Mexico|sw|3|34.6|-106.4',
    'NY|New York|ma|1|41.5|-74.6', 'NC|North Carolina|se|1|35.6|-79.7', 'ND|North Dakota|mw|5|47.4|-99.0', 'OH|Ohio|mw|1|40.5|-82.6',
    'OK|Oklahoma|sw|3|35.6|-96.8', 'OR|Oregon|we|3|44.7|-122.5', 'PA|Pennsylvania|ma|1|40.5|-76.8', 'RI|Rhode Island|ne|4|41.8|-71.4',
    'SC|South Carolina|se|2|34.0|-81.0', 'SD|South Dakota|mw|4|44.0|-98.4', 'TN|Tennessee|se|2|35.8|-86.4', 'TX|Texas|sw|1|30.9|-97.4',
    'UT|Utah|we|3|40.4|-111.9', 'VT|Vermont|ne|5|44.2|-72.8', 'VA|Virginia|se|2|37.8|-77.8', 'WA|Washington|we|2|47.3|-121.6',
    'WV|West Virginia|se|4|38.8|-80.8', 'WI|Wisconsin|mw|2|43.7|-89.0', 'WY|Wyoming|we|5|42.8|-106.9'
  ];
  var CA_DATA = [
    'BC|British Columbia|can|3|49.6|-122.6', 'AB|Alberta|can|4|52.3|-113.8', 'SK|Saskatchewan|can|4|51.4|-105.8', 'MB|Manitoba|can|4|50.2|-97.4',
    'ON|Ontario|can|3|44.3|-79.6', 'QC|Quebec|can|3|46.2|-72.6', 'NB|New Brunswick|can|4|46.0|-66.0', 'NS|Nova Scotia|can|4|45.0|-63.6',
    'PE|Prince Edward Island|can|5|46.3|-63.2', 'NL|Newfoundland and Labrador|can|5|48.2|-54.5', 'YT|Yukon|can|5|60.7|-135.1',
    'NT|Northwest Territories|can|5|62.5|-114.4', 'NU|Nunavut|can|5|63.7|-68.5'
  ];
  var MX_DATA = [
    'AGU|Aguascalientes|mex|5|21.9|-102.3', 'BCN|Baja California|mex|3|32.3|-116.2', 'BCS|Baja California Sur|mex|5|24.1|-110.3',
    'CAM|Campeche|mex|5|19.8|-90.5', 'CHP|Chiapas|mex|5|16.6|-93.0', 'CHH|Chihuahua|mex|3|30.0|-106.3', 'CMX|Mexico City|mex|4|19.4|-99.1',
    'COA|Coahuila|mex|3|26.6|-101.4', 'COL|Colima|mex|5|19.2|-103.7', 'DUR|Durango|mex|5|24.6|-104.7', 'GUA|Guanajuato|mex|5|20.9|-101.3',
    'GRO|Guerrero|mex|5|17.4|-99.6', 'HID|Hidalgo|mex|5|20.2|-98.8', 'JAL|Jalisco|mex|4|20.6|-103.4', 'MEX|State of Mexico|mex|5|19.5|-99.4',
    'MIC|Michoacan|mex|5|19.6|-101.6', 'MOR|Morelos|mex|5|18.8|-99.2', 'NAY|Nayarit|mex|5|21.6|-104.9', 'NLE|Nuevo Leon|mex|3|25.7|-100.3',
    'OAX|Oaxaca|mex|5|17.1|-96.7', 'PUE|Puebla|mex|5|19.0|-98.2', 'QUE|Queretaro|mex|5|20.6|-100.4', 'ROO|Quintana Roo|mex|5|20.6|-87.3',
    'SLP|San Luis Potosi|mex|5|22.2|-100.9', 'SIN|Sinaloa|mex|5|25.0|-107.4', 'SON|Sonora|mex|3|30.2|-110.9', 'TAB|Tabasco|mex|5|18.0|-92.9',
    'TAM|Tamaulipas|mex|3|25.8|-98.2', 'TLA|Tlaxcala|mex|5|19.3|-98.2', 'VER|Veracruz|mex|5|19.2|-96.4', 'YUC|Yucatan|mex|5|20.9|-89.6',
    'ZAC|Zacatecas|mex|5|22.8|-102.6'
  ];
  var TERR_DATA = ['PR|Puerto Rico|ter|4', 'GU|Guam|ter|5', 'VI|US Virgin Islands|ter|5', 'AS|American Samoa|ter|5', 'MP|Northern Mariana Islands|ter|5'];
  var SP_DATA = ['TMP|Temporary / dealer tag|spc|2', 'GOV|US Government|spc|3', 'ANT|Antique / historic|spc|3', 'DIP|Diplomatic|spc|4', 'TRB|Tribal nation|spc|4'];

  // The ASCII tile map: [row, col] of every US state on an 11 x 8 grid.
  var MAP_POS = {
    AK: [0, 0], ME: [0, 10],
    WI: [1, 5], VT: [1, 9], NH: [1, 10],
    WA: [2, 0], ID: [2, 1], MT: [2, 2], ND: [2, 3], MN: [2, 4], IL: [2, 5], MI: [2, 6], NY: [2, 8], MA: [2, 9],
    OR: [3, 0], NV: [3, 1], WY: [3, 2], SD: [3, 3], IA: [3, 4], IN: [3, 5], OH: [3, 6], PA: [3, 7], NJ: [3, 8], CT: [3, 9], RI: [3, 10],
    CA: [4, 0], UT: [4, 1], CO: [4, 2], NE: [4, 3], MO: [4, 4], KY: [4, 5], WV: [4, 6], VA: [4, 7], MD: [4, 8], DE: [4, 9],
    AZ: [5, 1], NM: [5, 2], KS: [5, 3], AR: [5, 4], TN: [5, 5], NC: [5, 6], SC: [5, 7], DC: [5, 8],
    OK: [6, 3], LA: [6, 4], MS: [6, 5], AL: [6, 6], GA: [6, 7],
    HI: [7, 0], TX: [7, 3], FL: [7, 8]
  };
  var MAP_COLS = 11, MAP_ROWS = 8;

  var PLACES = [], BY = {};
  function addPlaces(list, g, prefix) {
    for (var i = 0; i < list.length; i++) {
      var f = list[i].split('|');
      var p = { c: prefix + f[0], s: f[0], n: f[1], r: f[2], t: +f[3], g: g, lat: f[4] != null ? +f[4] : null, lon: f[5] != null ? +f[5] : null };
      PLACES.push(p); BY[p.c] = p;
    }
  }
  addPlaces(US_DATA, 'us', '');
  addPlaces(CA_DATA, 'ca', 'ca-');
  addPlaces(MX_DATA, 'mx', 'mx-');
  addPlaces(TERR_DATA, 'terr', '');
  addPlaces(SP_DATA, 'sp', 'sp-');
  var US_N = US_DATA.length;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function str(v, max, d) {
    if (typeof v !== 'string') return d;
    v = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return v ? v.slice(0, max) : d;
  }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  // Great-circle distance in km.
  function distKm(a, b) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // Rarity tier of a place for a trip starting from `home` (a code, or '').
  // Nearby plates are everyday sights; far ones are trophies; your own is common.
  function distAdj(d) { return d < 350 ? -2 : d < 800 ? -1 : d < 1800 ? 0 : 1; }
  function tierOf(code, home) {
    var p = BY[code];
    if (!p) return 1;
    var h = home ? BY[home] : null;
    if (!h || p.lat == null || h.lat == null) return p.t;
    if (p.c === h.c) return 1;
    return clamp(p.t + distAdj(distKm(h, p)), 1, 5);
  }
  function pointsOf(code, home) { return TIERS[tierOf(code, home)].p; }
  function homeDist(code, home) {
    var p = BY[code], h = home ? BY[home] : null;
    if (!p || !h || p.lat == null || h.lat == null) return null;
    return Math.round(distKm(h, p));
  }

  function placesFor(trip) {
    var ex = (trip && trip.extras) || {}, out = [];
    for (var i = 0; i < PLACES.length; i++) {
      var p = PLACES[i];
      if (p.g === 'us' || ex[p.g]) out.push(p);
    }
    return out;
  }
  function enabled(trip, code) { var p = BY[code]; return !!p && (p.g === 'us' || !!(trip.extras && trip.extras[p.g])); }
  function regionPlaces(rid, trip) {
    var out = [];
    for (var i = 0; i < PLACES.length; i++) if (PLACES[i].r === rid && (!trip || enabled(trip, PLACES[i].c))) out.push(PLACES[i]);
    return out;
  }
  var REGION_N = {};
  for (var ri0 = 0; ri0 < REGIONS.length; ri0++) REGION_N[REGIONS[ri0].id] = regionPlaces(REGIONS[ri0].id).length;
  function regionOn(trip, r) { return r.g === 'us' || !!(trip.extras && trip.extras[r.g]); }

  // ---- dates ----
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDay(key, withYear) {
    var m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(key || '');
    if (!m) return '';
    return MONTHS[+m[2] - 1] + ' ' + (+m[3]) + (withYear ? ', ' + m[1] : '');
  }
  function fmtRange(a, b) {
    if (!b || a === b) return fmtDay(a, true);
    if (a.slice(0, 4) === b.slice(0, 4)) return fmtDay(a) + ' – ' + fmtDay(b, true);
    return fmtDay(a, true) + ' – ' + fmtDay(b, true);
  }
  function fmtClock(ms) {
    var d = new Date(ms), h = d.getHours(), m = d.getMinutes();
    return ((h + 11) % 12 + 1) + ':' + pad2(m) + (h < 12 ? ' am' : ' pm');
  }
  function relTime(ms, now) {
    var s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (dayKey(ms).slice(0, 4) === dayKey(now).slice(0, 4)) return fmtDay(dayKey(ms));
    return fmtDay(dayKey(ms), true);
  }

  // ---- saves ----
  function newSave() { return { v: SCHEMA, trips: [], active: null, view: '', seq: 0 }; }
  function defaultName(day) { return 'Road trip — ' + (fmtDay(day) || 'new'); }
  function newTrip(o, now, seq) {
    o = o || {};
    now = num(now, Date.now());
    var day = /^\d{4}-\d\d-\d\d$/.test(o.start || '') ? o.start : dayKey(now);
    var names = Array.isArray(o.players) ? o.players : [];
    var players = [];
    for (var i = 0; i < names.length && players.length < MAX_PLAYERS; i++) {
      var nm = str(names[i], 20, '');
      if (nm) players.push({ id: players.length + 1, name: nm });
    }
    if (!players.length) players.push({ id: 1, name: 'Me' });
    var ex = {};
    for (var e = 0; e < EXTRAS.length; e++) ex[EXTRAS[e]] = !!(o.extras && o.extras[EXTRAS[e]]);
    return {
      id: 't' + now.toString(36) + '-' + ((seq | 0) + 1),
      name: str(o.name, NAME_MAX, defaultName(day)),
      start: day, end: null, created: now, updated: now,
      home: o.home && BY[o.home] && BY[o.home].lat != null ? o.home : '',
      players: players, pseq: players.length,
      extras: ex, rule: o.rule === 'each' ? 'each' : 'first',
      ev: [], eseq: 0
    };
  }
  function normTrip(o, i) {
    if (!o || typeof o !== 'object') return null;
    var now = Date.now();
    var t = {
      id: str(o.id, 40, 'trip' + i),
      name: str(o.name, NAME_MAX, 'Road trip'),
      start: /^\d{4}-\d\d-\d\d$/.test(o.start || '') ? o.start : dayKey(num(o.created, now)),
      end: /^\d{4}-\d\d-\d\d$/.test(o.end || '') ? o.end : null,
      created: num(o.created, now), updated: num(o.updated, num(o.created, now)),
      home: typeof o.home === 'string' && BY[o.home] && BY[o.home].lat != null ? o.home : '',
      players: [], pseq: 0, extras: {}, rule: o.rule === 'each' ? 'each' : 'first', ev: [], eseq: 0
    };
    var seen = {};
    var pl = Array.isArray(o.players) ? o.players : [];
    for (var a = 0; a < pl.length && t.players.length < MAX_PLAYERS; a++) {
      var p = pl[a];
      if (!p || typeof p !== 'object') continue;
      var id = Math.floor(num(p.id, 0));
      if (id < 1 || seen[id]) continue;
      seen[id] = 1;
      t.players.push({ id: id, name: str(p.name, 20, 'Player ' + id) });
    }
    if (!t.players.length) t.players.push({ id: 1, name: 'Me' });
    var maxId = 0;
    for (var b = 0; b < t.players.length; b++) maxId = Math.max(maxId, t.players[b].id);
    t.pseq = Math.max(maxId, Math.floor(num(o.pseq, 0)));
    for (var e = 0; e < EXTRAS.length; e++) t.extras[EXTRAS[e]] = !!(o.extras && o.extras[EXTRAS[e]]);
    var ev = Array.isArray(o.ev) ? o.ev : [], ids = {}, maxE = 0;
    for (var k = 0; k < ev.length && t.ev.length < MAX_EVENTS; k++) {
      var x = ev[k];
      if (!x || typeof x !== 'object' || typeof x.c !== 'string' || !BY[x.c]) continue;
      var ei = Math.floor(num(x.i, 0));
      if (ei < 1 || ids[ei]) ei = 0;
      var pid = Math.floor(num(x.p, 0));
      if (!seen[pid]) pid = t.players[0].id;
      var e2 = { i: ei, c: x.c, p: pid, t: num(x.t, t.created) };
      var n = str(x.n, NOTE_MAX, '');
      if (n) e2.n = n;
      if (ei) { ids[ei] = 1; maxE = Math.max(maxE, ei); }
      t.ev.push(e2);
    }
    for (var m = 0; m < t.ev.length; m++) if (!t.ev[m].i) { t.ev[m].i = ++maxE; }
    // a sighting of an extra that has been switched off stays stored; turn it back on to see it
    t.eseq = Math.max(maxE, Math.floor(num(o.eseq, 0)));
    return t;
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    var tr = Array.isArray(o.trips) ? o.trips : [], ids = {};
    for (var i = 0; i < tr.length && s.trips.length < MAX_TRIPS; i++) {
      var t = normTrip(tr[i], i);
      if (!t) continue;
      while (ids[t.id]) t.id += 'x';
      ids[t.id] = 1;
      s.trips.push(t);
    }
    s.active = typeof o.active === 'string' && ids[o.active] ? o.active : null;
    s.view = typeof o.view === 'string' ? o.view.slice(0, 12) : '';
    s.seq = Math.max(s.trips.length, Math.floor(num(o.seq, 0)));
    return s;
  }
  function tripById(save, id) {
    for (var i = 0; i < save.trips.length; i++) if (save.trips[i].id === id) return save.trips[i];
    return null;
  }
  function activeTrip(save) { return save.active ? tripById(save, save.active) : null; }
  function startTrip(save, o, now) {
    var t = newTrip(o, now, save.seq);
    save.seq++;
    save.trips.unshift(t);
    if (save.trips.length > MAX_TRIPS) save.trips.length = MAX_TRIPS;
    save.active = t.id;
    return t;
  }
  function deleteTrip(save, id) {
    for (var i = 0; i < save.trips.length; i++) {
      if (save.trips[i].id === id) {
        save.trips.splice(i, 1);
        if (save.active === id) save.active = null;
        return true;
      }
    }
    return false;
  }
  function renameTrip(trip, name) { var n = str(name, NAME_MAX, ''); if (!n) return false; trip.name = n; return true; }
  function hasPlayer(trip, pid) { for (var i = 0; i < trip.players.length; i++) if (trip.players[i].id === pid) return true; return false; }
  function playerName(trip, pid) { for (var i = 0; i < trip.players.length; i++) if (trip.players[i].id === pid) return trip.players[i].name; return '?'; }

  // Edit a trip's settings. players: [{id?, name}] — an id keeps that player's
  // sightings; a dropped player's sightings move to the first remaining one.
  function editTrip(trip, o) {
    if (o.name != null) renameTrip(trip, o.name);
    if (o.start && /^\d{4}-\d\d-\d\d$/.test(o.start)) trip.start = o.start;
    if (o.home != null) trip.home = BY[o.home] && BY[o.home].lat != null ? o.home : '';
    if (o.rule) trip.rule = o.rule === 'each' ? 'each' : 'first';
    if (o.extras) for (var e = 0; e < EXTRAS.length; e++) trip.extras[EXTRAS[e]] = !!o.extras[EXTRAS[e]];
    if (Array.isArray(o.players)) {
      var next = [], used = {};
      for (var i = 0; i < o.players.length && next.length < MAX_PLAYERS; i++) {
        var p = o.players[i] || {}, nm = str(p.name, 20, '');
        if (!nm) continue;
        var id = Math.floor(num(p.id, 0));
        if (!(id && hasPlayer(trip, id)) || used[id]) id = ++trip.pseq;
        used[id] = 1;
        next.push({ id: id, name: nm });
      }
      if (next.length) {
        var first = next[0].id;
        for (var k = 0; k < trip.ev.length; k++) if (!used[trip.ev[k].p]) trip.ev[k].p = first;
        trip.players = next;
      }
    }
  }

  // ---- sightings ----
  function addSighting(trip, code, pid, now, note) {
    if (!enabled(trip, code)) return null;
    if (!hasPlayer(trip, pid)) pid = trip.players[0].id;
    if (trip.ev.length >= MAX_EVENTS) return null;
    var firstTrip = true, firstMine = true, n = 0;
    for (var i = 0; i < trip.ev.length; i++) {
      if (trip.ev[i].c !== code) continue;
      n++; firstTrip = false;
      if (trip.ev[i].p === pid) firstMine = false;
    }
    var ev = { i: ++trip.eseq, c: code, p: pid, t: num(now, Date.now()) };
    var nt = str(note, NOTE_MAX, '');
    if (nt) ev.n = nt;
    trip.ev.push(ev);
    trip.updated = ev.t;
    return { ev: ev, isNew: firstTrip, mineNew: firstMine, count: n + 1 };
  }
  function removeEvent(trip, id) {
    for (var i = trip.ev.length - 1; i >= 0; i--) {
      if (trip.ev[i].i === id) { trip.updated = Date.now(); return trip.ev.splice(i, 1)[0]; }
    }
    return null;
  }
  // "−" on a state: drop that player's latest sighting of it (else anyone's latest).
  function removeLatest(trip, code, pid) {
    var any = -1;
    for (var i = trip.ev.length - 1; i >= 0; i--) {
      var e = trip.ev[i];
      if (e.c !== code) continue;
      if (any < 0) any = i;
      if (pid == null || e.p === pid) { trip.updated = Date.now(); return trip.ev.splice(i, 1)[0]; }
    }
    if (any >= 0) { trip.updated = Date.now(); return trip.ev.splice(any, 1)[0]; }
    return null;
  }
  function setNote(trip, id, note) {
    for (var i = 0; i < trip.ev.length; i++) {
      if (trip.ev[i].i === id) {
        var n = str(note, NOTE_MAX, '');
        if (n) trip.ev[i].n = n; else delete trip.ev[i].n;
        return true;
      }
    }
    return false;
  }

  // ---- tally: everything the views show, recomputed from the event log ----
  function tally(trip) {
    var home = trip.home, places = placesFor(trip);
    var per = {}, players = {}, order = [];
    for (var a = 0; a < trip.players.length; a++) {
      var pl = trip.players[a];
      players[pl.id] = { id: pl.id, name: pl.name, pts: 0, bonus: 0, uniq: 0, n: 0, seen: {}, reg: {} };
      order.push(players[pl.id]);
    }
    var regSeen = {}, regDone = {}, regions = [];
    var team = { pts: 0, bonus: 0 }, sightings = 0, coreSeen = 0, allSeen = 0, tiers = [0, 0, 0, 0, 0, 0];
    var best = null, days = {}, lastEv = null;
    function claim(P, c, pts, rid, ev) {
      P.pts += pts; P.uniq++; P.seen[c] = 1;
      if (trip.rule === 'each' && BONUS_REGIONS[rid]) {
        P.reg[rid] = (P.reg[rid] || 0) + 1;
        if (P.reg[rid] === regionPlaces(rid, trip).length) { P.pts += REGION_BONUS; P.bonus += REGION_BONUS; }
      }
      return ev;
    }
    for (var i = 0; i < trip.ev.length; i++) {
      var ev = trip.ev[i], c = ev.c;
      if (!enabled(trip, c)) continue;
      var P = players[ev.p] || order[0];
      var r = per[c], place = BY[c];
      sightings++; P.n++; lastEv = ev;
      if (!r) {
        var tier = tierOf(c, home);
        r = per[c] = { c: c, tier: tier, pts: TIERS[tier].p, n: 0, first: ev, last: ev, by: {} };
        allSeen++;
        if (place.g === 'us') coreSeen++;
        tiers[tier]++;
        team.pts += r.pts;
        var dk = dayKey(ev.t);
        days[dk] = (days[dk] || 0) + 1;
        if (!best || tier > best.tier) best = { c: c, tier: tier, t: ev.t };
        regSeen[place.r] = (regSeen[place.r] || 0) + 1;
        if (trip.rule !== 'each') claim(P, c, r.pts, place.r, ev);
        if (BONUS_REGIONS[place.r] && regSeen[place.r] === regionPlaces(place.r, trip).length) {
          regDone[place.r] = ev;
          team.pts += REGION_BONUS; team.bonus += REGION_BONUS;
          if (trip.rule !== 'each') { P.pts += REGION_BONUS; P.bonus += REGION_BONUS; }
        }
      }
      if (trip.rule === 'each' && !P.seen[c]) claim(P, c, r.pts, place.r, ev);
      r.n++; r.last = ev;
      r.by[P.id] = (r.by[P.id] || 0) + 1;
    }
    for (var g = 0; g < REGIONS.length; g++) {
      var R = REGIONS[g];
      if (!regionOn(trip, R)) continue;
      var tot = regionPlaces(R.id, trip).length;
      regions.push({ id: R.id, name: R.name, seen: regSeen[R.id] || 0, total: tot, done: !!regDone[R.id], bonus: !!BONUS_REGIONS[R.id] });
    }
    var bestDay = null;
    for (var d in days) if (!bestDay || days[d] > bestDay.n) bestDay = { day: d, n: days[d] };
    var ranked = order.slice().sort(function (x, y) { return y.pts - x.pts || y.uniq - x.uniq; });
    return {
      per: per, sightings: sightings, points: team.pts, bonus: team.bonus,
      core: { seen: coreSeen, total: US_N, pct: Math.round(coreSeen * 100 / US_N) },
      all: { seen: allSeen, total: places.length, pct: Math.round(allSeen * 100 / places.length) },
      players: order, ranked: ranked, regions: regions, tiers: tiers, best: best, bestDay: bestDay, last: lastEv
    };
  }

  // What a sighting just achieved, comparing tallies before and after.
  var MILESTONES = [5, 10, 20, 25, 30, 40, 45, 50];
  function milestones(before, after) {
    var out = [];
    for (var i = 0; i < MILESTONES.length; i++) {
      var m = MILESTONES[i];
      if (before.core.seen < m && after.core.seen >= m) out.push({ kind: 'states', n: m, text: m + ' STATES' });
    }
    if (before.core.seen < US_N && after.core.seen >= US_N) out.push({ kind: 'all', n: US_N, text: 'ALL 50 + DC' });
    for (var r = 0; r < after.regions.length; r++) {
      var R = after.regions[r];
      if (!R.done) continue;
      var was = false;
      for (var k = 0; k < before.regions.length; k++) if (before.regions[k].id === R.id && before.regions[k].done) was = true;
      if (!was) out.push({ kind: 'region', id: R.id, text: R.name.toUpperCase(), bonus: REGION_BONUS });
    }
    if (after.tiers[5] > before.tiers[5] && before.tiers[5] === 0) out.push({ kind: 'legend', text: 'LEGENDARY' });
    return out;
  }

  // ---- records across every trip ----
  function records(save) {
    var R = { trips: save.trips.length, sightings: 0, life: {}, lifeCore: 0, mostStates: null, mostPoints: null, rarest: null, mostOne: null, bestDay: null };
    for (var i = 0; i < save.trips.length; i++) {
      var t = save.trips[i], T = tally(t);
      R.sightings += T.sightings;
      if (T.core.seen && (!R.mostStates || T.core.seen > R.mostStates.n)) R.mostStates = { n: T.core.seen, trip: t.name, id: t.id };
      if (T.points && (!R.mostPoints || T.points > R.mostPoints.n)) R.mostPoints = { n: T.points, trip: t.name, id: t.id };
      if (T.best && (!R.rarest || T.best.tier > R.rarest.tier || (T.best.tier === R.rarest.tier && T.best.t < R.rarest.t))) {
        R.rarest = { c: T.best.c, tier: T.best.tier, t: T.best.t, trip: t.name, id: t.id };
      }
      if (T.bestDay && (!R.bestDay || T.bestDay.n > R.bestDay.n)) R.bestDay = { n: T.bestDay.n, day: T.bestDay.day, trip: t.name, id: t.id };
      for (var c in T.per) {
        if (!R.life[c]) { R.life[c] = 0; if (BY[c].g === 'us') R.lifeCore++; }
        R.life[c] += T.per[c].n;
        if (!R.mostOne || T.per[c].n > R.mostOne.n) R.mostOne = { c: c, n: T.per[c].n, trip: t.name, id: t.id };
      }
    }
    return R;
  }

  function bar(frac, w) {
    w = w || 20;
    var k = Math.round(clamp(frac, 0, 1) * w);
    return { on: new Array(k + 1).join('#'), off: new Array(w - k + 1).join('.') };
  }
  function stars(tier) { return new Array(tier + 1).join('*'); }

  function search(list, q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return list.slice();
    var a = [], b = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i], s = p.s.toLowerCase(), n = p.n.toLowerCase();
      if (s === q || n.indexOf(q) === 0) a.push(p);
      else if (s.indexOf(q) === 0 || n.indexOf(q) >= 0 || n.replace(/[^a-z]/g, '').indexOf(q.replace(/[^a-z]/g, '')) >= 0 && q.replace(/[^a-z]/g, '')) b.push(p);
    }
    return a.concat(b);
  }
  // Typed shortcut: 2-letter codes (US states + DC, provinces, territories) of the trip.
  function codeFor(trip, typed) {
    typed = String(typed || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(typed)) return null;
    var cands = [typed, 'ca-' + typed];
    for (var i = 0; i < cands.length; i++) if (BY[cands[i]] && enabled(trip, cands[i])) return cands[i];
    return null;
  }

  function exportText(trip, T, now) {
    var lines = [];
    var end = trip.end || (T.last ? dayKey(T.last.t) : '');
    if (end && end < trip.start) end = trip.start;
    lines.push('🚗 License Plate Game — ' + trip.name);
    var meta = fmtRange(trip.start, end);
    if (trip.home) meta += ' · from ' + BY[trip.home].n;
    lines.push(meta);
    lines.push('States: ' + T.core.seen + '/' + T.core.total + ' (' + T.core.pct + '%)' +
      (T.all.total > T.core.total ? ' · all plates ' + T.all.seen + '/' + T.all.total : '') +
      ' · ' + T.points + ' pts · ' + T.sightings + ' sighting' + (T.sightings === 1 ? '' : 's'));
    var b = bar(T.core.seen / T.core.total, 25);
    lines.push('[' + b.on + b.off + ']');
    if (T.players.length > 1) {
      lines.push('Players: ' + T.ranked.map(function (p) { return p.name + ' ' + p.pts; }).join(' · '));
    }
    if (T.best) lines.push('Rarest: ' + BY[T.best.c].n + ' (' + TIERS[T.best.tier].n + ')');
    var done = T.regions.filter(function (r) { return r.done; }).map(function (r) { return r.name; });
    if (done.length) lines.push('Regions complete: ' + done.join(', '));
    var seen = [], miss = [];
    var pl = placesFor(trip);
    for (var i = 0; i < pl.length; i++) {
      if (pl[i].g !== 'us') { if (T.per[pl[i].c]) seen.push(pl[i].s); continue; }
      (T.per[pl[i].c] ? seen : miss).push(pl[i].s + (T.per[pl[i].c] && T.per[pl[i].c].n > 1 ? '×' + T.per[pl[i].c].n : ''));
    }
    if (seen.length) lines.push('Seen: ' + seen.join(' '));
    if (miss.length && miss.length <= 30) lines.push('Still missing: ' + miss.join(' '));
    else if (miss.length) lines.push('Still missing: ' + miss.length + ' states');
    return lines.join('\n');
  }

  var ENGINE = {
    SCHEMA: SCHEMA, TIERS: TIERS, GROUPS: GROUPS, REGIONS: REGIONS, EXTRAS: EXTRAS, PLACES: PLACES, BY: BY, US_N: US_N,
    MAP_POS: MAP_POS, MAP_COLS: MAP_COLS, MAP_ROWS: MAP_ROWS, REGION_BONUS: REGION_BONUS, REGION_N: REGION_N, MAX_PLAYERS: MAX_PLAYERS,
    distKm: distKm, tierOf: tierOf, pointsOf: pointsOf, homeDist: homeDist, placesFor: placesFor, enabled: enabled, regionPlaces: regionPlaces,
    dayKey: dayKey, fmtDay: fmtDay, fmtRange: fmtRange, fmtClock: fmtClock, relTime: relTime,
    newSave: newSave, newTrip: newTrip, normTrip: normTrip, normSave: normSave, tripById: tripById, activeTrip: activeTrip,
    startTrip: startTrip, deleteTrip: deleteTrip, renameTrip: renameTrip, editTrip: editTrip, playerName: playerName, hasPlayer: hasPlayer,
    addSighting: addSighting, removeEvent: removeEvent, removeLatest: removeLatest, setNote: setNote,
    tally: tally, milestones: milestones, records: records, bar: bar, stars: stars, search: search, codeFor: codeFor, exportText: exportText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('plates.css');

  var PANEL_ID = 'plates-panel', NAME = 'License Plate Game';
  var KEY = 'cade-plates-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var VIEWS = [
    { id: 'map', label: 'Map' }, { id: 'tiles', label: 'Tiles' }, { id: 'list', label: 'List' },
    { id: 'log', label: 'Log' }, { id: 'trips', label: 'Trips' }, { id: 'stats', label: 'Stats' }
  ];
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.plates = { live: function () { return S; } };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return normSave(o);
  }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function toast(m, type, ms) { if (Cade.showToast) Cade.showToast(m, type || 'info', ms || 1800); }

  // ---- sound: a tiny WebAudio voice, created on a user gesture, closed with the panel ----
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
  var SCALE = [523, 587, 659, 784, 880, 1047, 1175, 1319];
  function sfxSpot(tier, isNew) {
    var s = S.snd;
    if (!isNew) { s.tone(660, 0.05, 'triangle', 0.035); return; }
    s.tone(SCALE[tier - 1], 0.08, 'square', 0.03);
    s.tone(SCALE[tier + 1], 0.12, 'square', 0.028, 0, 0.07);
    if (tier >= 4) s.tone(SCALE[tier + 2] * 2, 0.22, 'sine', 0.03, 0, 0.15);
  }
  function sfxFanfare() {
    var n = [523, 659, 784, 1047];
    for (var i = 0; i < n.length; i++) S.snd.tone(n[i], 0.16, 'square', 0.03, 0, i * 0.09);
  }
  function sfxUndo() { S.snd.tone(520, 0.12, 'triangle', 0.035, 300); }

  function svg(path) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');

  var CAR = '    ______\n __/__||__\\___\n|  _      _  |\n\'-(_)----(_)-\'';

  // ---------- rendering ----------
  function trip() { return S.trip; }
  function curPid() {
    var t = trip();
    if (!t) return 0;
    if (!hasPlayer(t, S.pid)) S.pid = t.players[0].id;
    return S.pid;
  }
  function recompute() { S.T = S.trip ? tally(S.trip) : null; }

  function renderAll() {
    var had = S.root.contains(document.activeElement);
    renderHead();
    renderTabs();
    renderView();
    keepFocus(had);
  }
  function barWidth() {
    var w = S.root ? S.root.clientWidth : 400;
    return clamp(Math.floor((w - 80) / 8.2), 10, 40);
  }
  function renderHead() {
    var t = trip(), T = S.T;
    var h = '';
    if (!t) {
      h = '<div class="pl-top"><span class="pl-brand">LICENSE PLATE GAME</span></div><div class="pl-sub">No trip yet — start one to begin spotting.</div>';
      S.headEl.innerHTML = h;
      S.playersEl.innerHTML = '';
      return;
    }
    var b = bar(T.core.seen / T.core.total, barWidth());
    h += '<div class="pl-top"><button type="button" class="pl-trip" data-act="view-trips" title="Trips">' +
      '<span class="pl-tname">' + esc(t.name) + '</span><span class="pl-caret">' + (t.end ? ' ended' : ' ▾') + '</span></button>' +
      '<span class="pl-score"><b>' + T.points + '</b> pts</span></div>';
    h += '<div class="pl-prog" aria-label="' + T.core.seen + ' of ' + T.core.total + ' states">[<span class="on">' + b.on + '</span><span class="off">' + b.off + '</span>] <b>' + T.core.pct + '%</b></div>';
    h += '<div class="pl-sub"><b>' + T.core.seen + '</b>/' + T.core.total + ' states';
    if (T.all.total > T.core.total) h += ' · <b>' + T.all.seen + '</b>/' + T.all.total + ' all (' + T.all.pct + '%)';
    h += ' · ' + T.sightings + ' seen';
    if (T.last) h += ' · last ' + esc(BY[T.last.c].s) + ' ' + relTime(T.last.t, Date.now());
    h += '</div>';
    S.headEl.innerHTML = h;
    var p = '';
    if (t.players.length > 1) {
      var pid = curPid();
      p += '<span class="pl-who">spotter</span>';
      for (var i = 0; i < T.players.length; i++) {
        var P = T.players[i];
        p += '<button type="button" class="pl-chip' + (P.id === pid ? ' on' : '') + '" data-pid="' + P.id + '" aria-pressed="' + (P.id === pid) + '">' +
          esc(P.name) + ' <i>' + P.pts + '</i></button>';
      }
    }
    S.playersEl.innerHTML = p;
  }
  function renderTabs() {
    var h = '';
    for (var i = 0; i < VIEWS.length; i++) {
      var v = VIEWS[i];
      h += '<button type="button" role="tab" data-view="' + v.id + '" class="' + (S.view === v.id ? 'on' : '') + '" aria-selected="' + (S.view === v.id) + '">' + v.label + '</button>';
    }
    S.tabsEl.innerHTML = h;
  }

  function tileHtml(p, cls) {
    var T = S.T, r = T && T.per[p.c], tier = r ? r.tier : tierOf(p.c, trip() ? trip().home : '');
    var c = 'pl-t t' + tier + (r ? ' seen' : '') + (cls ? ' ' + cls : '');
    if (r && trip().rule === 'each' && trip().players.length > 1) {
      var mine = T.players.filter(function (P) { return P.id === curPid(); })[0];
      if (mine && !mine.seen[p.c]) c += ' notmine';
    }
    var lbl = p.n + ', ' + TIERS[tier].n + ', ' + TIERS[tier].p + ' points' + (r ? ', seen ' + r.n + (r.n === 1 ? ' time' : ' times') : ', not seen yet');
    return '<button type="button" class="' + c + '" data-c="' + p.c + '" aria-label="' + esc(lbl) + '" title="' + esc(p.n + ' — ' + TIERS[tier].n) + '">' +
      '<b>' + p.s + '</b>' + (r && r.n > 1 ? '<i>' + r.n + '</i>' : '') + '<s>' + stars(tier) + '</s>' +
      (cls === 'big' ? '<u>' + esc(p.n) + '</u><em>' + TIERS[tier].p + ' pt' + (TIERS[tier].p > 1 ? 's' : '') + '</em>' : '') + '</button>';
  }
  function renderView() {
    var v = S.view, el = S.viewEl;
    if (!trip() && v !== 'trips' && v !== 'stats') { el.innerHTML = welcomeHtml(); el.className = 'pl-view v-welcome'; return; }
    var keep = el.getAttribute('data-v') === v ? el.scrollTop : 0;
    el.className = 'pl-view v-' + v;
    el.setAttribute('data-v', v);
    if (v === 'map') el.innerHTML = mapHtml();
    else if (v === 'tiles') el.innerHTML = tilesHtml();
    else if (v === 'list') { renderList(); return; }
    else if (v === 'log') el.innerHTML = logHtml();
    else if (v === 'trips') el.innerHTML = tripsHtml();
    else if (v === 'stats') el.innerHTML = statsHtml();
    el.scrollTop = keep;
  }
  function welcomeHtml() {
    return '<div class="pl-welcome"><pre class="pl-art">' + esc(CAR) + '</pre>' +
      '<div class="pl-title">ROAD TRIP</div>' +
      '<p>Spot license plates from every state. Rare plates score more, regions earn bonuses, and every trip is saved.</p>' +
      '<div class="pl-btns"><button type="button" class="pl-go" data-act="new">Start a trip</button>' +
      '<button type="button" class="pl-go alt" data-act="quick">Quick start</button></div>' +
      (S.save.trips.length ? '<button type="button" class="pl-lnk" data-act="view-trips">Resume a saved trip (' + S.save.trips.length + ')</button>' : '') +
      '</div>';
  }
  function mapHtml() {
    var h = '<div class="pl-map" style="--cols:' + MAP_COLS + ';--rows:' + MAP_ROWS + '">';
    for (var c in MAP_POS) {
      var pos = MAP_POS[c];
      h += tileHtml(BY[c], '').replace('<button ', '<button style="grid-row:' + (pos[0] + 1) + ';grid-column:' + (pos[1] + 1) + '" ');
    }
    h += '</div>';
    var t = trip();
    for (var g = 1; g < GROUPS.length; g++) {
      var G = GROUPS[g];
      if (!t.extras[G.id]) continue;
      h += '<div class="pl-h">' + esc(G.name) + '</div><div class="pl-strip">';
      for (var i = 0; i < PLACES.length; i++) if (PLACES[i].g === G.id) h += tileHtml(PLACES[i], 'x' + PLACES[i].s.length);
      h += '</div>';
    }
    h += legendHtml();
    return h;
  }
  function legendHtml() {
    var h = '<div class="pl-legend">';
    for (var i = 1; i <= 5; i++) h += '<span class="t' + i + '"><s>' + stars(i) + '</s> ' + TIERS[i].n + ' ' + TIERS[i].p + '</span>';
    h += '</div><div class="pl-hint">' + (S.coarse ? 'tap' : 'click') + ' = spotted (again = +1) · ' + (S.coarse ? 'hold' : 'right-click / hold') + ' = details' +
      (S.coarse ? '' : ' · type a code like <b>OH</b>') + '</div>';
    return h;
  }
  function tilesHtml() {
    var h = '', t = trip(), T = S.T;
    for (var r = 0; r < T.regions.length; r++) {
      var R = T.regions[r], b = bar(R.seen / R.total, 10);
      h += '<div class="pl-rh' + (R.done ? ' done' : '') + '"><span>' + esc(R.name) + '</span><span class="pl-rb">' +
        '<span class="on">' + b.on + '</span><span class="off">' + b.off + '</span> ' + R.seen + '/' + R.total +
        (R.done && R.bonus ? ' <b>+' + REGION_BONUS + '</b>' : '') + '</span></div><div class="pl-grid">';
      var list = regionPlaces(R.id, t);
      list.sort(function (a, b) { return a.n < b.n ? -1 : 1; });
      for (var i = 0; i < list.length; i++) h += tileHtml(list[i], 'big');
      h += '</div>';
    }
    return h + legendHtml();
  }

  // list: a search box + sort + filter that persist; only the rows re-render
  function renderList() {
    var el = S.viewEl;
    if (!el.querySelector('.pl-lbar')) {
      el.innerHTML = '<div class="pl-lbar"><input type="search" class="pl-q" placeholder="Search states…" aria-label="Search states" autocomplete="off" spellcheck="false">' +
        '<select class="pl-sort" aria-label="Sort">' +
        '<option value="az">A–Z</option><option value="rare">Rarest</option><option value="count">Most seen</option><option value="recent">Recent</option></select>' +
        '<select class="pl-filt" aria-label="Show"><option value="all">All</option><option value="miss">Missing</option><option value="seen">Seen</option></select></div>' +
        '<div class="pl-rows"></div>';
      el.querySelector('.pl-q').value = S.q;
      el.querySelector('.pl-sort').value = S.sort;
      el.querySelector('.pl-filt').value = S.filt;
    }
    var rows = el.querySelector('.pl-rows');
    var T = S.T, list = search(placesFor(trip()), S.q), now = Date.now();
    if (S.filt !== 'all') list = list.filter(function (p) { return S.filt === 'seen' ? !!T.per[p.c] : !T.per[p.c]; });
    if (!S.q || S.sort !== 'az') {
      var home = trip().home;
      list.sort(function (a, b) {
        var ra = T.per[a.c], rb = T.per[b.c];
        if (S.sort === 'rare') return tierOf(b.c, home) - tierOf(a.c, home) || (a.n < b.n ? -1 : 1);
        if (S.sort === 'count') return (rb ? rb.n : 0) - (ra ? ra.n : 0) || (a.n < b.n ? -1 : 1);
        if (S.sort === 'recent') return (rb ? rb.last.t : 0) - (ra ? ra.last.t : 0) || (a.n < b.n ? -1 : 1);
        return a.n < b.n ? -1 : 1;
      });
    }
    var h = '';
    for (var i = 0; i < list.length; i++) {
      var p = list[i], r = T.per[p.c], tier = r ? r.tier : tierOf(p.c, trip().home);
      h += '<div class="pl-row t' + tier + (r ? ' seen' : '') + '">' +
        '<button type="button" class="pl-rn" data-detail="' + p.c + '"><span class="pl-code">' + p.s + '</span>' +
        '<span class="pl-rt"><b>' + esc(p.n) + '</b><small><s>' + stars(tier) + '</s> ' + TIERS[tier].n + ' · ' + TIERS[tier].p + ' pt' + (TIERS[tier].p > 1 ? 's' : '') +
        (r ? ' · ' + relTime(r.last.t, now) : '') + (r && r.last.n ? ' · ' + esc(r.last.n) : '') + '</small></span></button>' +
        '<span class="pl-ctr"><button type="button" class="pl-pm" data-minus="' + p.c + '" aria-label="One fewer ' + esc(p.n) + '"' + (r ? '' : ' disabled') + '>−</button>' +
        '<b class="pl-n">' + (r ? r.n : 0) + '</b>' +
        '<button type="button" class="pl-pm plus" data-c="' + p.c + '" aria-label="Spotted ' + esc(p.n) + '">+</button></span></div>';
    }
    if (!list.length) h = '<div class="pl-empty">No plates match “' + esc(S.q) + '”.</div>';
    rows.innerHTML = h;
  }

  function logHtml() {
    var t = trip(), T = S.T, now = Date.now();
    if (!t.ev.length) return '<div class="pl-empty"><pre class="pl-art small">' + esc(CAR) + '</pre>No sightings yet. Tap a state on the Map when you spot its plate.</div>';
    var h = '<div class="pl-lhead"><span>' + T.sightings + ' sighting' + (T.sightings === 1 ? '' : 's') + '</span>' +
      '<button type="button" class="pl-lnk" data-act="undo-last">Undo last</button></div>';
    var firstIds = {};
    for (var c in T.per) firstIds[T.per[c].first.i] = 1;
    var day = '';
    for (var i = t.ev.length - 1; i >= 0 && i >= t.ev.length - 400; i--) {
      var e = t.ev[i], p = BY[e.c];
      if (!enabled(t, e.c)) continue;
      var dk = dayKey(e.t);
      if (dk !== day) { day = dk; h += '<div class="pl-h">' + fmtDay(dk, true) + '</div>'; }
      var tier = T.per[e.c] ? T.per[e.c].tier : 1;
      h += '<div class="pl-lrow t' + tier + '"><span class="pl-time">' + fmtClock(e.t) + '</span>' +
        '<button type="button" class="pl-rn" data-detail="' + e.c + '"><span class="pl-code">' + p.s + '</span><span class="pl-rt"><b>' + esc(p.n) + (firstIds[e.i] ? '<em>+' + TIERS[tier].p + ' new</em>' : '') + '</b>' +
        '<small>' + (t.players.length > 1 ? esc(playerName(t, e.p)) + ' · ' : '') + (e.n ? esc(e.n) : relTime(e.t, now)) + '</small></span></button>' +
        '<button type="button" class="pl-x" data-del="' + e.i + '" aria-label="Delete this sighting" title="Delete">×</button></div>';
    }
    return h;
  }

  function tripSummary(t) {
    var T = t === trip() ? S.T : tally(t);
    var end = t.end || (T.last ? dayKey(T.last.t) : '');
    if (end && end < t.start) end = t.start;
    return { T: T, line: fmtRange(t.start, end) + ' · ' + T.core.seen + '/' + T.core.total + ' · ' + T.core.pct + '% · ' + T.points + ' pts' };
  }
  function tripsHtml() {
    var h = '<button type="button" class="pl-go wide" data-act="new">+ New trip</button>';
    var t = trip();
    if (t) {
      var s = tripSummary(t), b = bar(s.T.core.seen / s.T.core.total, 18);
      h += '<div class="pl-h">Current trip</div><div class="pl-tc cur">' + tripRowHead(t, s) +
        '<div class="pl-prog sm">[<span class="on">' + b.on + '</span><span class="off">' + b.off + '</span>]</div>' +
        '<div class="pl-meta">' + (t.home ? 'from ' + esc(BY[t.home].n) + ' · ' : '') + t.players.length + ' player' + (t.players.length > 1 ? 's' : '') +
        (t.players.length > 1 ? ' (' + (t.rule === 'each' ? 'everyone scores' : 'first call') + ')' : '') + '</div>' +
        tripBtns(t, true) + '</div>';
    }
    var others = S.save.trips.filter(function (x) { return x !== t; });
    if (others.length) {
      h += '<div class="pl-h">Saved trips</div>';
      for (var i = 0; i < others.length; i++) {
        var o = others[i], so = tripSummary(o);
        h += '<div class="pl-tc">' + tripRowHead(o, so) + tripBtns(o, false) + '</div>';
      }
    } else if (!t) h += '<div class="pl-empty">No saved trips yet.</div>';
    return h;
  }
  function tripRowHead(t, s) {
    if (S.renaming === t.id) {
      return '<form class="pl-ren" data-ren="' + t.id + '"><input type="text" maxlength="' + NAME_MAX + '" value="' + esc(t.name) + '" aria-label="Trip name">' +
        '<button type="submit" class="pl-sm">Save</button><button type="button" class="pl-sm alt" data-act="ren-no">Cancel</button></form>';
    }
    return '<div class="pl-tn"><b>' + esc(t.name) + '</b>' + (t.end ? ' <span class="pl-tag">ended</span>' : '') + '</div><div class="pl-meta">' + esc(s.line) + '</div>';
  }
  function tripBtns(t, cur) {
    if (S.delArm === t.id) {
      return '<div class="pl-tb conf"><span>Delete “' + esc(t.name) + '” for good?</span><button type="button" class="pl-sm danger" data-tdel-yes="' + t.id + '">Delete</button>' +
        '<button type="button" class="pl-sm alt" data-act="del-no">Keep</button></div>';
    }
    var h = '<div class="pl-tb">';
    if (cur) {
      h += '<button type="button" class="pl-sm" data-act="edit">Settings</button>';
      h += t.end ? '<button type="button" class="pl-sm" data-act="reopen">Reopen</button>' : '<button type="button" class="pl-sm" data-act="end">End trip</button>';
    } else h += '<button type="button" class="pl-sm" data-resume="' + t.id + '">Resume</button>';
    h += '<button type="button" class="pl-sm alt" data-share="' + t.id + '">Share</button>' +
      '<button type="button" class="pl-sm alt" data-ren-start="' + t.id + '">Rename</button>' +
      '<button type="button" class="pl-sm alt" data-tdel="' + t.id + '">Delete</button></div>';
    return h;
  }

  function statsHtml() {
    var R = records(S.save), t = trip(), T = S.T, h = '';
    if (t) {
      h += '<div class="pl-h">This trip</div><pre class="pl-tab">';
      var max = Math.max(1, Math.max.apply(null, T.tiers));
      for (var i = 5; i >= 1; i--) {
        var w = Math.round(T.tiers[i] / max * 14);
        h += '<span class="t' + i + '">' + pad(TIERS[i].n, 10) + '<s>' + new Array(w + 1).join('#') + '</s></span>' + new Array(15 - w).join(' ') + ' <b>' + T.tiers[i] + '</b>\n';
      }
      h += '\n' + pad('Points', 12) + '<b>' + T.points + '</b>' + (T.bonus ? ' <i>(incl. +' + T.bonus + ' region bonus)</i>' : '') + '\n';
      if (T.best) h += pad('Rarest', 12) + '<b>' + esc(BY[T.best.c].n) + '</b> <i>' + TIERS[T.best.tier].n + '</i>\n';
      if (T.bestDay) h += pad('Best day', 12) + '<b>' + T.bestDay.n + '</b> new <i>' + fmtDay(T.bestDay.day) + '</i>\n';
      h += '</pre>';
      if (t.players.length > 1) {
        h += '<div class="pl-h">Leaderboard</div><pre class="pl-tab">';
        for (var k = 0; k < T.ranked.length; k++) {
          var P = T.ranked[k];
          h += (k === 0 && P.pts ? '<span class="g">' : '<span>') + (k + 1) + '. ' + pad(esc(P.name).slice(0, 14), 15) + '</span><b>' + pad(String(P.pts), 4) + '</b> pts  <i>' + P.uniq + ' plates · ' + P.n + ' taps</i>\n';
        }
        h += '</pre>';
      }
    }
    h += '<div class="pl-h">Records · all trips</div><pre class="pl-tab">';
    h += pad('Trips', 14) + '<b>' + R.trips + '</b>\n';
    h += pad('Sightings', 14) + '<b>' + R.sightings + '</b>\n';
    h += pad('States ever', 14) + '<b>' + R.lifeCore + '</b>/' + US_N + '\n';
    h += pad('Most states', 14) + (R.mostStates ? '<b>' + R.mostStates.n + '</b> <i>' + esc(R.mostStates.trip) + '</i>' : '<i>—</i>') + '\n';
    h += pad('Most points', 14) + (R.mostPoints ? '<b>' + R.mostPoints.n + '</b> <i>' + esc(R.mostPoints.trip) + '</i>' : '<i>—</i>') + '\n';
    h += pad('Best day', 14) + (R.bestDay ? '<b>' + R.bestDay.n + '</b> new <i>' + fmtDay(R.bestDay.day, true) + '</i>' : '<i>—</i>') + '\n';
    h += pad('Rarest plate', 14) + (R.rarest ? '<b>' + esc(BY[R.rarest.c].n) + '</b> <i>' + TIERS[R.rarest.tier].n + '</i>' : '<i>—</i>') + '\n';
    h += pad('Most of one', 14) + (R.mostOne ? '<b>' + esc(BY[R.mostOne.c].s) + ' ×' + R.mostOne.n + '</b> <i>' + esc(R.mostOne.trip) + '</i>' : '<i>—</i>') + '\n';
    h += '</pre>';
    h += '<div class="pl-h">Lifetime map · ' + R.lifeCore + '/' + US_N + '</div><div class="pl-map mini" style="--cols:' + MAP_COLS + ';--rows:' + MAP_ROWS + '">';
    for (var c in MAP_POS) {
      var pos = MAP_POS[c];
      h += '<span class="pl-m' + (R.life[c] ? ' seen' : '') + '" style="grid-row:' + (pos[0] + 1) + ';grid-column:' + (pos[1] + 1) + '" title="' + esc(BY[c].n) + (R.life[c] ? ' ×' + R.life[c] : '') + '">' + c + '</span>';
    }
    h += '</div>';
    return h;
  }
  function pad(s, n) { s = String(s); var l = s.replace(/&[a-z#0-9]+;/g, '_').length; return l >= n ? s + ' ' : s + new Array(n - l + 1).join(' '); }

  // ---------- overlay cards ----------
  function showCard(kind, arg) {
    S.card = kind; S.cardArg = arg;
    var h = '';
    if (kind === 'help') h = helpHtml();
    else if (kind === 'detail') h = detailHtml(arg);
    else if (kind === 'form') h = formHtml(arg);
    else if (kind === 'share') h = shareHtml(arg);
    if (!h) { hideCard(); return; }
    S.ovl.innerHTML = '<div class="pl-card" role="dialog" aria-modal="true">' + h + '</div>';
    S.ovl.hidden = false;
    S.root.classList.add('dim');
    if (kind === 'form') syncForm();
  }
  function hideCard() {
    var had = S.root.contains(document.activeElement);
    S.card = null; S.cardArg = null;
    S.ovl.hidden = true; S.ovl.innerHTML = '';
    S.root.classList.remove('dim');
    keepFocus(had);
  }
  function helpHtml() {
    return '<div class="pl-title">HOW TO PLAY</div>' +
      '<p>Spot a license plate, <b>tap its state</b>. Seen it again? Tap again — every sighting counts (×2, ×3 …). Mis-tap? <b>Undo</b> in the bar, or <b>−</b> in the List.</p>' +
      '<p><b>Hold</b> a tile (or right-click) for its card: counts per player, last seen, a note (“I-80 near Reno”), every sighting.</p>' +
      '<pre class="pl-tab">' + [1, 2, 3, 4, 5].map(function (i) { return '<span class="t' + i + '"><s>' + pad(stars(i), 6) + '</s>' + pad(TIERS[i].n, 10) + '</span><b>' + TIERS[i].p + '</b> pt' + (i > 1 ? 's' : ''); }).join('\n') + '</pre>' +
      '<p>Rarity comes from how often a plate travels nationally; with a <b>home state</b> set, nearby plates get commoner and far ones rarer. Your first sighting of a state scores; finish a region for <b>+' + REGION_BONUS + '</b>.</p>' +
      '<p><b>Players:</b> pick who spotted it before tapping. <i>First call</i>: the first to spot a state claims its points. <i>Everyone</i>: each player collects their own.</p>' +
      (S.coarse ? '' : '<div class="pl-keys"><span><b>OH</b> type a 2-letter code to log it (desktop)</span><span><b>1-8</b> pick the spotter · <b>Backspace</b> undo · <b>Esc</b> close</span></div>') +
      '<button type="button" class="pl-go" data-act="close">Got it</button>';
  }
  function detailHtml(c) {
    var t = trip(), p = BY[c];
    if (!t || !p) return '';
    var T = S.T, r = T.per[c], tier = r ? r.tier : tierOf(c, t.home), d = homeDist(c, t.home), now = Date.now();
    var region = null;
    for (var i = 0; i < REGIONS.length; i++) if (REGIONS[i].id === p.r) region = REGIONS[i];
    var h = '<div class="pl-title">' + esc(p.n.toUpperCase()) + '</div>' +
      '<div class="pl-dtop t' + tier + '"><span class="pl-plate"><small>' + esc(region ? region.name : '') + '</small><b>' + p.s + '</b></span>' +
      '<span class="pl-dinfo"><span><s>' + stars(tier) + '</s> <b>' + TIERS[tier].n + '</b> · ' + TIERS[tier].p + ' pt' + (TIERS[tier].p > 1 ? 's' : '') + '</span>' +
      (d != null ? '<span>' + (d === 0 ? 'your home state' : '≈ ' + d.toLocaleString() + ' km from ' + esc(BY[t.home].n)) + '</span>' : '') +
      (r ? '<span>first ' + (dayKey(r.first.t) === dayKey(now) ? '' : fmtDay(dayKey(r.first.t)) + ' ') + fmtClock(r.first.t) + (t.players.length > 1 ? ' by ' + esc(playerName(t, r.first.p)) : '') + ' · last ' + relTime(r.last.t, now) + '</span>' : '<span>not seen yet</span>') +
      '</span></div>';
    var pid = curPid();
    h += '<div class="pl-dctr"><button type="button" class="pl-big" data-minus="' + c + '"' + (r ? '' : ' disabled') + ' aria-label="One fewer">−</button>' +
      '<span class="pl-dn"><b>' + (r ? r.n : 0) + '</b><small>sighting' + (r && r.n === 1 ? '' : 's') + '</small></span>' +
      '<button type="button" class="pl-big plus" data-c="' + c + '" aria-label="Spotted again">+</button></div>';
    if (t.players.length > 1) {
      h += '<div class="pl-dpl">';
      for (var k = 0; k < t.players.length; k++) {
        var P = t.players[k];
        h += '<span' + (P.id === pid ? ' class="on"' : '') + '>' + esc(P.name) + ' <b>' + (r && r.by[P.id] || 0) + '</b></span>';
      }
      h += '</div>';
    }
    if (r) {
      h += '<label class="pl-lab">Note on the latest sighting<input type="text" class="pl-note" data-ev="' + r.last.i + '" maxlength="' + NOTE_MAX + '" placeholder="where? plate text? car?" value="' + esc(r.last.n || '') + '"></label>';
      var evs = t.ev.filter(function (e) { return e.c === c; }).slice(-12).reverse();
      h += '<div class="pl-dlist">';
      for (var j = 0; j < evs.length; j++) {
        var e = evs[j];
        h += '<div><span>' + fmtDay(dayKey(e.t)) + ' ' + fmtClock(e.t) + '</span><span>' + (t.players.length > 1 ? esc(playerName(t, e.p)) : '') + (e.n ? ' <i>' + esc(e.n) + '</i>' : '') + '</span>' +
          '<button type="button" class="pl-x" data-del="' + e.i + '" aria-label="Delete this sighting">×</button></div>';
      }
      h += '</div>';
    }
    h += '<button type="button" class="pl-go" data-act="close">Done</button>';
    return h;
  }
  function homeOptions(sel) {
    var h = '<option value="">— none —</option>';
    var list = PLACES.filter(function (p) { return p.lat != null && p.g !== 'mx'; }).sort(function (a, b) { return a.n < b.n ? -1 : 1; });
    for (var i = 0; i < list.length; i++) h += '<option value="' + list[i].c + '"' + (list[i].c === sel ? ' selected' : '') + '>' + esc(list[i].n) + '</option>';
    return h;
  }
  function formHtml(mode) {
    var t = mode === 'edit' ? trip() : null;
    var players = t ? t.players.map(function (p) { return { id: p.id, name: p.name }; }) : [{ id: 0, name: 'Me' }];
    var last = S.save.trips[0];
    var ex = t ? t.extras : (last ? last.extras : {});
    S.form = { players: players };
    var h = '<div class="pl-title">' + (t ? 'TRIP SETTINGS' : 'NEW TRIP') + '</div><form class="pl-form">' +
      '<label class="pl-lab">Trip name<input type="text" name="name" maxlength="' + NAME_MAX + '" placeholder="' + esc(defaultName(dayKey(Date.now()))) + '" value="' + esc(t ? t.name : '') + '"></label>' +
      '<div class="pl-two"><label class="pl-lab">Start date<input type="date" name="start" value="' + (t ? t.start : dayKey(Date.now())) + '"></label>' +
      '<label class="pl-lab">Home / start state<select name="home">' + homeOptions(t ? t.home : (last ? last.home : '')) + '</select></label></div>' +
      '<div class="pl-lab">Players<div class="pl-plist"></div><button type="button" class="pl-sm alt" data-act="padd">+ add player</button></div>' +
      '<div class="pl-lab pl-rule">Scoring with several players' +
      '<label class="pl-rad"><input type="radio" name="rule" value="first"' + (!t || t.rule !== 'each' ? ' checked' : '') + '> First call — first to spot a state claims it</label>' +
      '<label class="pl-rad"><input type="radio" name="rule" value="each"' + (t && t.rule === 'each' ? ' checked' : '') + '> Everyone — each player collects their own</label></div>' +
      '<div class="pl-lab">Extras<div class="pl-exs">' +
      '<label class="pl-ck"><input type="checkbox" name="ca"' + (ex.ca ? ' checked' : '') + '> Canada</label>' +
      '<label class="pl-ck"><input type="checkbox" name="mx"' + (ex.mx ? ' checked' : '') + '> Mexico</label>' +
      '<label class="pl-ck"><input type="checkbox" name="terr"' + (ex.terr ? ' checked' : '') + '> US territories</label>' +
      '<label class="pl-ck"><input type="checkbox" name="sp"' + (ex.sp ? ' checked' : '') + '> Special plates</label></div></div>' +
      '<div class="pl-btns"><button type="submit" class="pl-go">' + (t ? 'Save' : 'Start trip') + '</button><button type="button" class="pl-go alt" data-act="close">Cancel</button></div>' +
      '</form>';
    return h;
  }
  function syncForm() {
    var el = S.ovl.querySelector('.pl-plist');
    if (!el) return;
    var h = '', ps = S.form.players;
    for (var i = 0; i < ps.length; i++) {
      h += '<div class="pl-prow"><input type="text" maxlength="20" data-pi="' + i + '" value="' + esc(ps[i].name) + '" placeholder="Player ' + (i + 1) + '" aria-label="Player ' + (i + 1) + ' name">' +
        (ps.length > 1 ? '<button type="button" class="pl-x" data-prm="' + i + '" aria-label="Remove player">×</button>' : '') + '</div>';
    }
    el.innerHTML = h;
    var add = S.ovl.querySelector('[data-act="padd"]');
    if (add) add.disabled = ps.length >= MAX_PLAYERS;
    var rule = S.ovl.querySelector('.pl-rule');
    if (rule) rule.style.display = ps.length > 1 ? '' : 'none';
  }
  function readForm() {
    var f = S.ovl.querySelector('.pl-form');
    var ins = f.querySelectorAll('[data-pi]');
    for (var i = 0; i < ins.length; i++) S.form.players[+ins[i].getAttribute('data-pi')].name = ins[i].value;
    var rule = f.querySelector('input[name="rule"]:checked');
    return {
      name: f.elements.name.value, start: f.elements.start.value, home: f.elements.home.value, rule: rule ? rule.value : 'first',
      extras: { ca: f.elements.ca.checked, mx: f.elements.mx.checked, terr: f.elements.terr.checked, sp: f.elements.sp.checked },
      players: S.form.players
    };
  }
  function shareHtml(id) {
    var t = tripById(S.save, id);
    if (!t) return '';
    var txt = exportText(t, t === trip() ? S.T : tally(t), Date.now());
    S.shareText = txt;
    return '<div class="pl-title">SHARE</div><textarea class="pl-share" readonly rows="9" aria-label="Trip summary">' + esc(txt) + '</textarea>' +
      '<div class="pl-btns"><button type="button" class="pl-go" data-act="copy">Copy</button>' +
      (navigator.share ? '<button type="button" class="pl-go alt" data-act="native-share">Share…</button>' : '') +
      '<button type="button" class="pl-go alt" data-act="insert">Insert in note</button></div>' +
      '<button type="button" class="pl-lnk" data-act="close">Close</button>';
  }

  // ---------- actions ----------
  function setView(v) {
    if (S.view === v) return;
    var had = S.root.contains(document.activeElement);
    S.view = v; S.save.view = v; persist();
    S.delArm = null; S.renaming = null;
    renderTabs(); renderView();
    var tb = S.tabsEl.querySelector('[data-view="' + v + '"]');
    if (had && tb) { try { tb.focus({ preventScroll: true }); } catch (e) {} }
    keepFocus(had);
    S.viewEl.scrollTop = 0;
  }
  function refresh() {
    var had = S.root.contains(document.activeElement);
    recompute(); renderHead(); renderView();
    if (S.card === 'detail') showCard('detail', S.cardArg);
    keepFocus(had);
  }
  // a re-render drops the focused button: keep the keyboard on the panel (not the page)
  function keepFocus(had) {
    var a = document.activeElement;
    if (had && (!a || a === document.body || !S.root.contains(a))) { try { S.root.focus({ preventScroll: true }); } catch (e) {} }
  }

  function spot(c, srcEl) {
    var t = trip();
    if (!t) return;
    S.snd.ensure();
    var before = S.T;
    var res = addSighting(t, c, curPid(), Date.now());
    if (!res) { toast(t.ev.length >= 5000 ? 'This trip is full (5000 sightings)' : 'Not on this trip', 'info'); return; }
    persist();
    var rect = srcEl && srcEl.getBoundingClientRect ? srcEl.getBoundingClientRect() : null;
    refresh();
    var r = S.T.per[c], tier = r.tier, p = BY[c];
    var ms = milestones(before, S.T);
    sfxSpot(tier, res.isNew);
    if (Cade.haptic) Cade.haptic(res.isNew ? (tier >= 4 ? 25 : 12) : 6);
    var el = S.viewEl.querySelector('[data-c="' + c + '"]');
    if (el) { el.classList.add('pop'); if (res.isNew) el.classList.add('fresh'); }
    floatAt(rect, res.isNew ? '+' + TIERS[tier].p : '×' + res.count, res.isNew, tier);
    snack((res.isNew ? '<b>' + p.s + '</b> ' + esc(p.n) + ' — <span class="t' + tier + '">' + TIERS[tier].n + '</span> +' + TIERS[tier].p :
      '<b>' + p.s + '</b> ×' + res.count) + (t.players.length > 1 ? ' · ' + esc(playerName(t, res.ev.p)) : ''), res.ev.i);
    live((res.isNew ? 'New: ' : '') + p.n + (res.isNew ? ', ' + TIERS[tier].n + ', ' + TIERS[tier].p + ' points' : ', ' + res.count + ' sightings'));
    if (ms.length) setTimeout(function () { if (S) celebrate(ms); }, 260);
  }
  function unspot(c) {
    var t = trip();
    if (!t) return;
    var e = removeLatest(t, c, curPid());
    if (!e) return;
    S.snd.ensure(); sfxUndo();
    persist(); refresh();
    snack('<b>' + BY[c].s + '</b> −1', 0, e);
  }
  function delEvent(id) {
    var t = trip();
    if (!t) return;
    var e = removeEvent(t, id);
    if (!e) return;
    S.snd.ensure(); sfxUndo();
    persist(); refresh();
    snack('Deleted a <b>' + BY[e.c].s + '</b> sighting', 0, e);
  }
  function undoLast() {
    var t = trip();
    if (!t || !t.ev.length) return;
    var e = t.ev[t.ev.length - 1];
    removeEvent(t, e.i);
    S.snd.ensure(); sfxUndo();
    persist(); refresh();
    snack('Undid <b>' + BY[e.c].s + '</b>', 0, e);
  }
  // put a deleted event back (the snackbar's "Restore")
  function restore(e) {
    var t = trip();
    if (!t || !e) return;
    var at = t.ev.length;
    while (at > 0 && t.ev[at - 1].t > e.t) at--;
    t.ev.splice(at, 0, e);
    persist(); refresh();
    snack('Restored <b>' + BY[e.c].s + '</b>', 0);
  }

  function snack(html, undoId, restoreEv) {
    clearTimeout(S.snackT);
    S.snackUndo = undoId || 0; S.snackRestore = restoreEv || null;
    S.snackEl.innerHTML = '<span>' + html + '</span>' + (undoId ? '<button type="button" data-act="snack-undo">Undo</button>' : restoreEv ? '<button type="button" data-act="snack-restore">Restore</button>' : '');
    S.snackEl.hidden = false;
    S.snackEl.classList.remove('in'); void S.snackEl.offsetWidth; S.snackEl.classList.add('in');
    S.snackT = setTimeout(function () { if (S) hideSnack(); }, 4500);
  }
  function live(t) { if (S.liveEl) S.liveEl.textContent = t; }

  function floatAt(rect, text, big, tier) {
    if (!rect || S.rm) return;
    var root = S.root.getBoundingClientRect();
    var x = rect.left + rect.width / 2 - root.left, y = rect.top + rect.height / 2 - root.top;
    var f = document.createElement('span');
    f.className = 'pl-float t' + tier + (big ? ' big' : '');
    f.textContent = text;
    f.style.left = x + 'px'; f.style.top = y + 'px';
    S.fxEl.appendChild(f);
    var kill = [f];
    if (big) {
      var glyphs = tier >= 4 ? '*+*x*+' : '*+.*';
      var n = tier >= 4 ? 12 : 6;
      for (var i = 0; i < n; i++) {
        var s = document.createElement('span'), a = (i / n) * Math.PI * 2 + Math.random() * 0.4, d = 24 + Math.random() * (tier >= 4 ? 34 : 18);
        s.className = 'pl-spark t' + tier;
        s.textContent = glyphs.charAt(i % glyphs.length);
        s.style.left = x + 'px'; s.style.top = y + 'px';
        s.style.setProperty('--dx', Math.round(Math.cos(a) * d) + 'px');
        s.style.setProperty('--dy', Math.round(Math.sin(a) * d) + 'px');
        S.fxEl.appendChild(s); kill.push(s);
      }
    }
    setTimeout(function () { for (var k = 0; k < kill.length; k++) if (kill[k].parentNode) kill[k].parentNode.removeChild(kill[k]); }, 1100);
  }
  function celebrate(ms) {
    // the biggest news wins the banner: all states > region > first legendary > a states milestone
    var rank = { all: 4, region: 3, legend: 2, states: 1 }, m = ms[0];
    for (var i = 1; i < ms.length; i++) if ((rank[ms[i].kind] || 0) >= (rank[m.kind] || 0)) m = ms[i];
    var sub = m.kind === 'region' ? 'region complete · +' + m.bonus + ' bonus' : m.kind === 'all' ? 'every state on the road!' : m.kind === 'legend' ? 'first legendary plate' : 'spotted this trip';
    var art = m.kind === 'all' ? ' \\o/  \\o/  \\o/' : m.kind === 'legend' ? '  .*  *  *.' : ' \\o/';
    var b = document.createElement('div');
    b.className = 'pl-banner';
    b.innerHTML = '<pre>' + esc(art) + '</pre><div class="pl-title">' + esc(m.text) + '</div><div class="pl-sub">' + esc(sub) + '</div>';
    S.fxEl.appendChild(b);
    sfxFanfare();
    if (Cade.haptic) Cade.haptic(30);
    live(m.text + ' — ' + sub);
    setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 2300);
  }

  function hideSnack() { clearTimeout(S.snackT); S.snackEl.hidden = true; S.snackUndo = 0; S.snackRestore = null; }
  function setActive(t) {
    hideSnack();
    S.trip = t || null;
    S.save.active = t ? t.id : null;
    S.pid = t ? t.players[0].id : 0;
    persist(); recompute();
  }
  function submitForm() {
    var o = readForm(), now = Date.now();
    if (S.card === 'form' && S.cardArg === 'edit' && trip()) {
      editTrip(trip(), o);
      persist(); recompute(); hideCard(); renderAll();
      toast('Trip saved', 'success');
      return;
    }
    var names = o.players.map(function (p) { return p.name; });
    var t = startTrip(S.save, { name: o.name, start: o.start, home: o.home, rule: o.rule, extras: o.extras, players: names }, now);
    setActive(t);
    hideCard();
    S.view = S.view === 'trips' || S.view === 'stats' || !S.view ? (S.coarse ? 'tiles' : 'map') : S.view;
    S.save.view = S.view; persist();
    renderAll();
    S.snd.ensure(); sfxFanfare();
    toast('Trip started — happy spotting!', 'success');
  }
  function quickStart() {
    var t = startTrip(S.save, {}, Date.now());
    setActive(t);
    if (!S.view || S.view === 'trips' || S.view === 'stats') S.view = S.coarse ? 'tiles' : 'map';
    S.save.view = S.view; persist();
    renderAll();
    S.snd.ensure(); sfxFanfare();
  }
  function copyText(txt) {
    function fallback() {
      var ta = S.ovl.querySelector('.pl-share');
      if (ta) { ta.removeAttribute('readonly'); ta.select(); try { document.execCommand('copy'); toast('Copied', 'success'); } catch (e) { toast('Select the text and copy it', 'info'); } ta.setAttribute('readonly', ''); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function () { toast('Copied', 'success'); }, fallback);
    else fallback();
  }
  function insertText(txt) {
    try {
      var ed = Cade.editor, pos = ed.state.selection.main.head;
      var line = ed.state.doc.lineAt(pos);
      var ins = (line.length ? '\n\n' : '') + txt + '\n';
      ed.dispatch({ changes: { from: line.to, insert: ins }, selection: { anchor: line.to + ins.length } });
      toast('Inserted into the note', 'success');
      hideCard();
    } catch (e) { toast('Could not reach the note', 'error'); }
  }

  // ---------- open / close ----------
  function teardown() {
    if (!S) return;
    clearTimeout(S.snackT); clearTimeout(S.lpT); clearInterval(S.tickT);
    S.snd.close();
    S = null;
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID), oc = p && p._onClose;
    if (p) p.remove();
    if (oc) oc(); else teardown();
  }

  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="pl" tabindex="-1"><div class="pl-headbox"></div><div class="pl-players"></div>' +
      '<div class="pl-tabs" role="tablist"></div><div class="pl-view"></div>' +
      '<div class="pl-snack" hidden></div><div class="pl-ovl" hidden></div><div class="pl-fx" aria-hidden="true"></div><div class="pl-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🚗 License Plates', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'pl-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button><button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia;
    var save = loadSave();
    S = {
      panel: p, hb: hb, root: p.querySelector('.pl'), headEl: p.querySelector('.pl-headbox'), playersEl: p.querySelector('.pl-players'),
      tabsEl: p.querySelector('.pl-tabs'), viewEl: p.querySelector('.pl-view'), snackEl: p.querySelector('.pl-snack'),
      ovl: p.querySelector('.pl-ovl'), fxEl: p.querySelector('.pl-fx'), liveEl: p.querySelector('.pl-live'),
      save: save, trip: activeTrip(save), T: null, pid: 0, view: save.view, card: null, cardArg: null,
      q: '', sort: 'az', filt: 'all', delArm: null, renaming: null, form: null, typed: '', typedT: 0,
      snd: new Snd(sget(SOUND_KEY) === '1'),
      coarse: !!(mm && mm('(pointer: coarse)').matches), rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches)
    };
    var okView = false;
    for (var vi = 0; vi < VIEWS.length; vi++) if (VIEWS[vi].id === S.view) okView = true;
    if (!okView) S.view = S.coarse ? 'tiles' : 'map';
    if (S.trip) S.pid = S.trip.players[0].id;
    recompute();
    p._onClose = teardown;
    syncHead();
    renderAll();
    // the progress bar's width follows the panel; "x min ago" stays fresh
    S.tickT = setInterval(function () { if (S && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(p))) renderHead(); }, 30000);
    requestAnimationFrame(function () { if (S && S.panel === p) renderHead(); });
    if (!sget(SAVE_KEY) && !save.trips.length) showCard('help');

    // header: help / sound (the header drags the panel — these are controls)
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
      } else if (h === 'help') { if (S.card === 'help') hideCard(); else showCard('help'); }
      // hand the keyboard back to the panel (typed codes / Esc keep working)
      try { b.blur(); if (S && !S.coarse) S.root.focus({ preventScroll: true }); } catch (er) {}
    });

    // Rapid tapping must never zoom, select, magnify or open a callout: CSS does
    // most of it; the panel also swallows gesture / dblclick events, and the
    // tally buttons (tiles, + / −) cancel their touchend so iOS can't read two
    // quick taps as a double-tap zoom — they act on pointerup instead.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    var root = S.root;
    function tapTarget(e) {
      var t = e.target.closest ? e.target.closest('[data-c],[data-minus]') : null;
      return t && root.contains(t) && !t.disabled ? t : null;
    }
    // pointerup (which does the counting) fires before touchend, so don't wait on S.press here
    root.addEventListener('touchend', function (e) { if (S && tapTarget(e)) noTouch(e); }, { passive: false });
    root.addEventListener('contextmenu', function (e) {
      var t = e.target.closest ? e.target.closest('[data-c]') : null;
      if (t && S) { e.preventDefault(); if (!S.lpFired) openDetail(t.getAttribute('data-c')); S.lpFired = false; }
    });

    // tiles and + / −: tap on pointerup, long-press (450 ms) opens the card
    root.addEventListener('pointerdown', function (e) {
      if (!S || (e.button && e.button > 0)) return;
      var t = tapTarget(e);
      if (!t) return;
      S.snd.ensure();
      clearTimeout(S.lpT);
      S.lpFired = false;
      S.press = { el: t, id: e.pointerId, x: e.clientX, y: e.clientY };
      if (t.hasAttribute('data-c') && !t.classList.contains('pl-pm') && !t.classList.contains('pl-big')) {
        S.lpT = setTimeout(function () {
          if (!S || !S.press || S.press.el !== t) return;
          S.press = null; S.lpFired = true;
          if (Cade.haptic) Cade.haptic(15);
          openDetail(t.getAttribute('data-c'));
        }, 450);
      }
      t.classList.add('down');
    });
    function cancelPress() {
      if (!S) return;
      clearTimeout(S.lpT);
      if (S.press) S.press.el.classList.remove('down');
      S.press = null;
    }
    root.addEventListener('pointermove', function (e) {
      if (!S || !S.press || S.press.id !== e.pointerId) return;
      if (Math.abs(e.clientX - S.press.x) > 10 || Math.abs(e.clientY - S.press.y) > 10) cancelPress();
    });
    root.addEventListener('pointercancel', cancelPress);
    root.addEventListener('pointerleave', function (e) { if (S && S.press && S.press.id === e.pointerId && e.pointerType === 'mouse') cancelPress(); });
    root.addEventListener('pointerup', function (e) {
      if (!S || !S.press || S.press.id !== e.pointerId) return;
      var t = S.press.el;
      cancelPress();
      if (tapTarget(e) !== t) return;
      S.tapped = Date.now();
      if (t.hasAttribute('data-minus')) unspot(t.getAttribute('data-minus'));
      else spot(t.getAttribute('data-c'), t);
    });

    root.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button,[data-pid]') : null;
      if (!b || !root.contains(b)) return;
      // tally buttons act on pointerup; a click only counts from the keyboard
      if (b.hasAttribute('data-c') || b.hasAttribute('data-minus')) {
        if (e.detail === 0 && Date.now() - (S.tapped || 0) > 300) {
          if (b.hasAttribute('data-minus')) unspot(b.getAttribute('data-minus')); else spot(b.getAttribute('data-c'), b);
          var again = S.root.querySelector((S.card ? '.pl-ovl ' : '.pl-view ') + '[' + (b.hasAttribute('data-minus') ? 'data-minus' : 'data-c') + '="' + (b.getAttribute('data-minus') || b.getAttribute('data-c')) + '"]');
          if (again) { try { again.focus({ preventScroll: true }); } catch (er) {} }
        }
        return;
      }
      S.snd.ensure();
      var a = b.getAttribute('data-act');
      if (b.hasAttribute('data-view')) { setView(b.getAttribute('data-view')); return; }
      if (b.hasAttribute('data-pid')) {
        S.pid = +b.getAttribute('data-pid'); renderHead(); if (S.view === 'map' || S.view === 'tiles') renderView();
        S.snd.tone(990, 0.04, 'sine', 0.03);
        return;
      }
      if (b.hasAttribute('data-detail')) { openDetail(b.getAttribute('data-detail')); return; }
      if (b.hasAttribute('data-del')) { delEvent(+b.getAttribute('data-del')); return; }
      if (b.hasAttribute('data-resume')) {
        var rt = tripById(S.save, b.getAttribute('data-resume'));
        if (rt) {
          setActive(rt); S.view = S.coarse ? 'tiles' : 'map'; S.save.view = S.view; persist(); renderAll();
          toast('Resumed “' + rt.name + '”', 'success');
        }
        return;
      }
      if (b.hasAttribute('data-share')) { showCard('share', b.getAttribute('data-share')); return; }
      if (b.hasAttribute('data-ren-start')) {
        S.renaming = b.getAttribute('data-ren-start'); S.delArm = null; renderView();
        var inp = S.viewEl.querySelector('.pl-ren input');
        if (inp) { inp.focus(); inp.select(); }
        return;
      }
      if (b.hasAttribute('data-tdel')) { S.delArm = b.getAttribute('data-tdel'); S.renaming = null; renderView(); return; }
      if (b.hasAttribute('data-tdel-yes')) {
        var id = b.getAttribute('data-tdel-yes'), wasActive = S.save.active === id;
        deleteTrip(S.save, id);
        if (wasActive) setActive(null);
        S.delArm = null; persist(); renderAll();
        toast('Trip deleted', 'info');
        return;
      }
      if (b.hasAttribute('data-prm')) {
        readForm();
        S.form.players.splice(+b.getAttribute('data-prm'), 1); syncForm();
        return;
      }
      switch (a) {
        case 'view-trips': hideCard(); setView('trips'); break;
        case 'new': showCard('form', 'new'); focusFirst(); break;
        case 'quick': quickStart(); break;
        case 'edit': showCard('form', 'edit'); break;
        case 'end': trip().end = dayKey(Date.now()); persist(); recompute(); renderAll(); toast('Trip ended — it stays saved', 'info'); break;
        case 'reopen': trip().end = null; persist(); recompute(); renderAll(); break;
        case 'ren-no': S.renaming = null; renderView(); break;
        case 'del-no': S.delArm = null; renderView(); break;
        case 'undo-last': undoLast(); break;
        case 'snack-undo': if (S.snackUndo) { var ue = removeEvent(trip(), S.snackUndo); if (ue) { sfxUndo(); persist(); refresh(); snack('Undid <b>' + BY[ue.c].s + '</b>', 0); } } break;
        case 'snack-restore': restore(S.snackRestore); break;
        case 'close': hideCard(); break;
        case 'padd':
          readForm();
          if (S.form.players.length < MAX_PLAYERS) { S.form.players.push({ id: 0, name: '' }); syncForm(); var ins = S.ovl.querySelectorAll('[data-pi]'); if (ins.length) ins[ins.length - 1].focus(); }
          break;
        case 'copy': copyText(S.shareText); break;
        case 'native-share': try { navigator.share({ title: 'License Plate Game', text: S.shareText }).catch(function () {}); } catch (er) {} break;
        case 'insert': insertText(S.shareText); break;
      }
    });
    function focusFirst() { if (!S.coarse) { var i = S.ovl.querySelector('input[name="name"]'); if (i) i.focus(); } }
    S.ovl.addEventListener('pointerdown', function (e) { if (e.target === S.ovl) hideCard(); });

    root.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!S) return;
      var f = e.target;
      if (f.classList.contains('pl-form')) submitForm();
      else if (f.hasAttribute('data-ren')) {
        var t = tripById(S.save, f.getAttribute('data-ren'));
        if (t && renameTrip(t, f.querySelector('input').value)) { persist(); recompute(); }
        S.renaming = null; renderHead(); renderView();
      }
    });
    root.addEventListener('input', function (e) {
      if (!S) return;
      var t = e.target;
      if (t.classList.contains('pl-q')) { S.q = t.value; renderList(); }
    });
    root.addEventListener('change', function (e) {
      if (!S) return;
      var t = e.target;
      if (t.classList.contains('pl-sort')) { S.sort = t.value; renderList(); }
      else if (t.classList.contains('pl-filt')) { S.filt = t.value; renderList(); }
      else if (t.classList.contains('pl-note') && trip()) {
        var nid = +t.getAttribute('data-ev');
        setNote(trip(), nid, t.value); persist(); recompute();
        // patch the card's sighting row in place (a re-render here would swallow the tap that blurred the input)
        var xb = S.ovl.querySelector('[data-del="' + nid + '"]'), cell = xb && xb.previousElementSibling, ev = null;
        for (var ei = 0; ei < trip().ev.length; ei++) if (trip().ev[ei].i === nid) ev = trip().ev[ei];
        if (cell && ev) cell.innerHTML = (trip().players.length > 1 ? esc(playerName(trip(), ev.p)) : '') + (ev.n ? ' <i>' + esc(ev.n) + '</i>' : '');
        if (S.view !== 'map' && S.view !== 'tiles') renderView();
        toast('Note saved', 'success', 1200);
      }
    });

    // keys (panel-local: only while the panel has focus — never steals the editor's typing)
    root.addEventListener('keydown', function (e) {
      if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
      if (Cade.isMinimized && Cade.isMinimized(p)) return;
      var tg = e.target, typing = tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT');
      if (e.key === 'Escape') {
        if (S.card) { e.preventDefault(); e.stopPropagation(); hideCard(); try { root.focus({ preventScroll: true }); } catch (er) {} }
        return;
      }
      if (typing) {
        // Enter commits the note (change fires on blur); keep the keyboard on the panel
        if (e.key === 'Enter' && tg.classList.contains('pl-note')) { e.preventDefault(); try { root.focus({ preventScroll: true }); } catch (er) { tg.blur(); } }
        return;
      }
      if (!trip() || S.card === 'form' || S.card === 'share') return;
      if (/^[1-8]$/.test(e.key) && trip().players.length > 1) {
        var P = trip().players[+e.key - 1];
        if (P) { S.pid = P.id; renderHead(); if (S.view === 'map' || S.view === 'tiles') renderView(); e.preventDefault(); }
        return;
      }
      if (e.key === 'Backspace') { e.preventDefault(); undoLast(); return; }
      if (/^[a-zA-Z]$/.test(e.key) && !(S.view === 'trips' || S.view === 'stats')) {
        var now = Date.now();
        S.typed = (now - S.typedT < 1200 ? S.typed : '') + e.key.toUpperCase();
        S.typedT = now;
        if (S.typed.length >= 2) {
          var two = S.typed.slice(-2), c = codeFor(trip(), two);
          S.typed = '';
          if (c) { var tl = S.viewEl.querySelector('[data-c="' + c + '"]'); spot(c, tl); }
          else toast('No plate “' + two + '” on this trip — type a 2-letter code like OH', 'info', 1400);
        }
        e.preventDefault();
      }
    });
    p.addEventListener('pointerdown', function (e) {
      if (!S) return;
      var t = e.target;
      if (!(t.closest && t.closest('input,textarea,select,.cade-panel-head'))) { try { root.focus({ preventScroll: true }); } catch (er) {} }
    }, true);
    p.addEventListener('cade-panel-minimize', function () { if (S) { cancelPress(); S.typed = ''; } });
    p.addEventListener('cade-panel-restore', function () { if (S) requestAnimationFrame(function () { if (S) renderAll(); }); });
    S.onResize = function () { if (S) { clearTimeout(S.rsT); S.rsT = setTimeout(function () { if (S) renderHead(); }, 150); } };
    window.addEventListener('resize', S.onResize);
    var onResize = S.onResize;
    p._onClose = function () { window.removeEventListener('resize', onResize); teardown(); };
    if (!S.coarse) { try { root.focus({ preventScroll: true }); } catch (e) {} }
  }
  function openDetail(c) { if (S && trip() && BY[c]) showCard('detail', c); }
  function syncHead() {
    var b = S.hb.querySelector('[data-h="sound"]');
    b.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    b.classList.toggle('on', S.snd.on);
    b.title = S.snd.on ? 'Sound on' : 'Sound off';
    b.setAttribute('aria-label', b.title);
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Road-trip tracker for states seen — rarity scores, progress, saved trips',
    icon: '🚗',
    tags: 'game,road trip,license plate,states,travel,tracker,car,family,kids,bingo,plates,usa',
    open: open,
    _engine: ENGINE
  });
})();
