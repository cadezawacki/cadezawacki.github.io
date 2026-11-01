/* Headless checks for the License Plate Game engine (data, rarity, scoring, trips, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/plates/plates.test.js */
'use strict';
var assert = require('assert');

var E = require('./plates.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./plates.js')];
require('./plates.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var T0 = new Date(2026, 6, 4, 9, 0, 0).getTime();
function mk(o) { var s = E.newSave(); return { s: s, t: E.startTrip(s, o || {}, T0) }; }

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'License Plate Game' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'plates.css');
  assert.strictEqual(widget._engine.US_N, 51);
});

test('data: 50 states + DC, unique codes, extras sized right', function () {
  var n = {};
  E.PLACES.forEach(function (p) { n[p.g] = (n[p.g] || 0) + 1; assert.ok(p.t >= 1 && p.t <= 5, p.c); assert.ok(E.BY[p.c] === p); });
  assert.strictEqual(n.us, 51); assert.strictEqual(n.ca, 13); assert.strictEqual(n.mx, 32);
  assert.strictEqual(n.terr, 5); assert.strictEqual(n.sp, 5);
  assert.strictEqual(Object.keys(E.BY).length, E.PLACES.length);
  E.PLACES.forEach(function (p) {
    if (p.g === 'us' || p.g === 'ca' || p.g === 'mx') assert.ok(isFinite(p.lat) && isFinite(p.lon), p.c);
    assert.ok(E.REGIONS.some(function (r) { return r.id === p.r; }), 'region of ' + p.c);
  });
  var us = E.REGIONS.filter(function (r) { return r.g === 'us'; }).reduce(function (a, r) { return a + E.REGION_N[r.id]; }, 0);
  assert.strictEqual(us, 51);
});

test('tile map: every US state has a unique cell inside the grid', function () {
  var cells = {}, k = Object.keys(E.MAP_POS);
  assert.strictEqual(k.length, 51);
  k.forEach(function (c) {
    var p = E.MAP_POS[c];
    assert.ok(E.BY[c] && E.BY[c].g === 'us', c);
    assert.ok(p[0] >= 0 && p[0] < E.MAP_ROWS && p[1] >= 0 && p[1] < E.MAP_COLS, c);
    var key = p.join(',');
    assert.ok(!cells[key], 'cell clash ' + c);
    cells[key] = 1;
  });
});

test('rarity: base tiers, home state shifts them sensibly', function () {
  assert.strictEqual(E.tierOf('CA', ''), 1);
  assert.strictEqual(E.tierOf('HI', ''), 5);
  assert.strictEqual(E.tierOf('OH', 'OH'), 1);
  assert.ok(E.tierOf('PA', 'OH') <= E.tierOf('PA', ''), 'neighbour gets commoner');
  assert.ok(E.tierOf('CA', 'ME') > E.tierOf('CA', 'NV'), 'far gets rarer');
  assert.strictEqual(E.tierOf('HI', 'NY'), 5);
  assert.strictEqual(E.tierOf('AK', 'AK'), 1);
  assert.strictEqual(E.tierOf('ca-ON', 'MI') < E.tierOf('ca-ON', 'TX'), true);
  assert.strictEqual(E.tierOf('PR', 'FL'), E.BY.PR.t, 'no distance for territories');
  E.PLACES.forEach(function (p) {
    ['', 'OH', 'CA', 'AK', 'HI', 'ca-QC'].forEach(function (h) { var t = E.tierOf(p.c, h); assert.ok(t >= 1 && t <= 5); });
  });
  var d = E.distKm(E.BY.NY, E.BY.CA);
  assert.ok(d > 3500 && d < 4300, 'NY-CA ~ 3900 km, got ' + d);
  assert.strictEqual(E.pointsOf('HI', ''), 8);
  assert.strictEqual(E.homeDist('OH', ''), null);
  assert.strictEqual(E.homeDist('OH', 'OH'), 0);
});

test('new trip defaults and options', function () {
  var x = mk({ name: '  Summer   run ', players: ['Ann', '', 'Bob'], home: 'OH', extras: { ca: true }, rule: 'each' });
  var t = x.t;
  assert.strictEqual(t.name, 'Summer run');
  assert.deepStrictEqual(t.players.map(function (p) { return p.name; }), ['Ann', 'Bob']);
  assert.strictEqual(t.home, 'OH'); assert.strictEqual(t.rule, 'each');
  assert.strictEqual(t.extras.ca, true); assert.strictEqual(t.extras.mx, false);
  assert.strictEqual(x.s.active, t.id);
  var y = mk({ home: 'sp-GOV' });
  assert.strictEqual(y.t.home, '', 'special plates are not a home');
  assert.strictEqual(y.t.players.length, 1);
  assert.ok(/^Road trip/.test(y.t.name));
  assert.strictEqual(E.placesFor(y.t).length, 51);
  assert.strictEqual(E.placesFor(t).length, 64);
});

test('sightings: counts, first flags, disabled extras refused', function () {
  var t = mk({ players: ['A', 'B'] }).t, A = t.players[0].id, B = t.players[1].id;
  var r1 = E.addSighting(t, 'OH', A, T0 + 1000);
  assert.ok(r1.isNew && r1.mineNew && r1.count === 1);
  var r2 = E.addSighting(t, 'OH', B, T0 + 2000, 'I-71');
  assert.ok(!r2.isNew && r2.mineNew && r2.count === 2 && r2.ev.n === 'I-71');
  var r3 = E.addSighting(t, 'OH', B, T0 + 3000);
  assert.ok(!r3.isNew && !r3.mineNew && r3.count === 3);
  assert.strictEqual(E.addSighting(t, 'ca-ON', A, T0), null);
  assert.strictEqual(E.addSighting(t, 'ZZ', A, T0), null);
  var r4 = E.addSighting(t, 'TX', 999, T0 + 4000);
  assert.strictEqual(r4.ev.p, A, 'unknown player falls back to the first');
  var T = E.tally(t);
  assert.strictEqual(T.per.OH.n, 3); assert.strictEqual(T.per.OH.by[B], 2);
  assert.strictEqual(T.core.seen, 2); assert.strictEqual(T.sightings, 4);
  assert.strictEqual(T.per.OH.last.t, T0 + 3000);
});

test('scoring: first call claims a state; repeats score nothing', function () {
  var t = mk({ players: ['A', 'B'] }).t, A = t.players[0].id, B = t.players[1].id;
  E.addSighting(t, 'HI', B, T0 + 1);   // 8
  E.addSighting(t, 'HI', A, T0 + 2);
  E.addSighting(t, 'CA', A, T0 + 3);   // 1
  E.addSighting(t, 'VT', A, T0 + 4);   // 8
  var T = E.tally(t);
  assert.strictEqual(T.points, 17);
  assert.strictEqual(T.players[0].pts, 9); assert.strictEqual(T.players[1].pts, 8);
  assert.strictEqual(T.ranked[0].id, A);
  assert.strictEqual(T.best.c, 'HI');
  assert.deepStrictEqual(T.tiers, [0, 1, 0, 0, 0, 2]);
});

test('scoring: "everyone" rule lets each player collect each state', function () {
  var t = mk({ players: ['A', 'B'], rule: 'each' }).t, A = t.players[0].id, B = t.players[1].id;
  E.addSighting(t, 'HI', B, T0 + 1);
  E.addSighting(t, 'HI', A, T0 + 2);
  E.addSighting(t, 'HI', A, T0 + 3);
  var T = E.tally(t);
  assert.strictEqual(T.points, 8);
  assert.strictEqual(T.players[0].pts, 8); assert.strictEqual(T.players[1].pts, 8);
  assert.strictEqual(T.players[0].uniq, 1); assert.strictEqual(T.players[0].n, 2);
});

test('region bonus goes to the team and the completing claimer', function () {
  var t = mk({ players: ['A', 'B'] }).t, A = t.players[0].id, B = t.players[1].id;
  var ne = E.regionPlaces('ne', t), sum = 0, before = E.tally(t);
  ne.forEach(function (p, i) { E.addSighting(t, p.c, i === ne.length - 1 ? B : A, T0 + i); sum += E.pointsOf(p.c, ''); });
  var T = E.tally(t);
  assert.strictEqual(T.points, sum + E.REGION_BONUS);
  var reg = T.regions.filter(function (r) { return r.id === 'ne'; })[0];
  assert.ok(reg.done && reg.seen === 6 && reg.total === 6);
  assert.strictEqual(T.players[1].bonus, E.REGION_BONUS);
  var ms = E.milestones(before, T);
  assert.ok(ms.some(function (m) { return m.kind === 'region' && m.id === 'ne'; }));
  assert.ok(ms.some(function (m) { return m.kind === 'states' && m.n === 5; }));
  assert.ok(ms.some(function (m) { return m.kind === 'legend'; }), 'VT is legendary');
});

test('all 51 states: 100% and the big milestone', function () {
  var t = mk({ extras: { ca: true } }).t, before = null;
  E.PLACES.forEach(function (p, i) {
    if (p.g !== 'us') return;
    before = E.tally(t);
    E.addSighting(t, p.c, t.players[0].id, T0 + i * 1000);
  });
  var T = E.tally(t);
  assert.strictEqual(T.core.pct, 100); assert.strictEqual(T.core.seen, 51);
  assert.strictEqual(T.all.total, 64); assert.strictEqual(T.all.pct, Math.round(51 * 100 / 64));
  assert.ok(E.milestones(before, T).some(function (m) { return m.kind === 'all'; }));
  assert.strictEqual(T.bonus, 6 * E.REGION_BONUS);
});

test('undo: remove latest (prefers own), remove by id, notes', function () {
  var t = mk({ players: ['A', 'B'] }).t, A = t.players[0].id, B = t.players[1].id;
  var e1 = E.addSighting(t, 'OH', A, T0 + 1).ev;
  E.addSighting(t, 'OH', B, T0 + 2);
  var gone = E.removeLatest(t, 'OH', A);
  assert.strictEqual(gone.i, e1.i);
  assert.strictEqual(E.tally(t).per.OH.n, 1);
  var g2 = E.removeLatest(t, 'OH', A);  // none by A left -> anyone's latest
  assert.strictEqual(g2.p, B);
  assert.strictEqual(E.removeLatest(t, 'OH', A), null);
  var e3 = E.addSighting(t, 'WY', A, T0 + 3).ev;
  assert.ok(E.setNote(t, e3.i, '  near   Cheyenne '));
  assert.strictEqual(t.ev[0].n, 'near Cheyenne');
  E.setNote(t, e3.i, '');
  assert.ok(!('n' in t.ev[0]));
  assert.strictEqual(E.removeEvent(t, e3.i).c, 'WY');
  assert.strictEqual(E.tally(t).sightings, 0);
  var e4 = E.addSighting(t, 'WY', A, T0 + 4).ev;
  assert.ok(e4.i > e3.i, 'ids never reused');
});

test('removing the first sighting hands the claim to the next spotter', function () {
  var t = mk({ players: ['A', 'B'] }).t, A = t.players[0].id, B = t.players[1].id;
  var e = E.addSighting(t, 'AK', A, T0 + 1).ev;
  E.addSighting(t, 'AK', B, T0 + 2);
  assert.strictEqual(E.tally(t).players[0].pts, 8);
  E.removeEvent(t, e.i);
  var T = E.tally(t);
  assert.strictEqual(T.players[0].pts, 0); assert.strictEqual(T.players[1].pts, 8);
});

test('editing a trip: rename, extras, home re-tiers, players keep or move sightings', function () {
  var t = mk({ players: ['A', 'B', 'C'] }).t, ids = t.players.map(function (p) { return p.id; });
  E.addSighting(t, 'OH', ids[2], T0);
  E.addSighting(t, 'PA', ids[1], T0 + 1);
  assert.strictEqual(E.tally(t).per.PA.tier, 1);
  E.editTrip(t, { name: 'Renamed', home: 'CA', extras: { mx: true }, players: [{ id: ids[1], name: 'Bea' }, { id: 0, name: 'Dee' }] });
  assert.strictEqual(t.name, 'Renamed');
  assert.deepStrictEqual(t.players.map(function (p) { return p.name; }), ['Bea', 'Dee']);
  assert.strictEqual(t.players[0].id, ids[1]);
  assert.ok(t.players[1].id > ids[2], 'new player gets a fresh id');
  assert.strictEqual(t.ev[0].p, ids[1], 'dropped player sightings move to the first');
  assert.strictEqual(t.extras.mx, true); assert.strictEqual(t.extras.ca, false);
  assert.strictEqual(E.tally(t).per.PA.tier, 2, 'PA is rarer seen from California');
  assert.strictEqual(E.renameTrip(t, '   '), false);
  assert.strictEqual(t.name, 'Renamed');
});

test('extras switched off hide their sightings without losing them', function () {
  var t = mk({ extras: { ca: true } }).t;
  E.addSighting(t, 'ca-BC', t.players[0].id, T0);
  assert.strictEqual(E.tally(t).all.seen, 1);
  E.editTrip(t, { extras: { ca: false } });
  assert.strictEqual(E.tally(t).all.seen, 0);
  assert.strictEqual(t.ev.length, 1);
  E.editTrip(t, { extras: { ca: true } });
  assert.strictEqual(E.tally(t).all.seen, 1);
});

test('trips: start, delete, active pointer, records across trips', function () {
  var s = E.newSave();
  var a = E.startTrip(s, { name: 'A' }, T0);
  E.addSighting(a, 'HI', a.players[0].id, T0);
  E.addSighting(a, 'OH', a.players[0].id, T0 + 1);
  E.addSighting(a, 'OH', a.players[0].id, T0 + 2);
  var b = E.startTrip(s, { name: 'B' }, T0 + 86400000);
  ['CA', 'TX', 'FL', 'NY'].forEach(function (c, i) { E.addSighting(b, c, b.players[0].id, T0 + 86400000 + i); });
  assert.notStrictEqual(a.id, b.id);
  assert.strictEqual(s.active, b.id); assert.strictEqual(s.trips[0], b);
  var R = E.records(s);
  assert.strictEqual(R.trips, 2); assert.strictEqual(R.sightings, 7);
  assert.strictEqual(R.mostStates.n, 4); assert.strictEqual(R.mostStates.trip, 'B');
  assert.strictEqual(R.mostPoints.trip, 'A');
  assert.strictEqual(R.rarest.c, 'HI');
  assert.strictEqual(R.lifeCore, 6);
  assert.strictEqual(R.mostOne.c, 'OH'); assert.strictEqual(R.mostOne.n, 2);
  assert.strictEqual(R.bestDay.n, 4);
  assert.ok(E.deleteTrip(s, b.id));
  assert.strictEqual(s.active, null);
  assert.ok(!E.deleteTrip(s, 'nope'));
  assert.strictEqual(E.activeTrip(s), null);
});

test('save round-trips through JSON and normalises junk defensively', function () {
  var x = mk({ players: ['A', 'B'], home: 'TX', extras: { sp: true } }), t = x.t;
  E.addSighting(t, 'sp-GOV', t.players[1].id, T0, 'van');
  E.addSighting(t, 'AZ', t.players[0].id, T0 + 5);
  var back = E.normSave(JSON.parse(JSON.stringify(x.s)));
  assert.deepStrictEqual(back, x.s);
  [null, 7, 'x', [], { trips: 'no' }, { trips: [null, 3, {}] }].forEach(function (junk) {
    var s = E.normSave(junk);
    assert.ok(Array.isArray(s.trips)); assert.strictEqual(s.v, E.SCHEMA);
    s.trips.forEach(function (tr) { assert.ok(tr.players.length >= 1); E.tally(tr); });
  });
  var weird = E.normSave({ active: 'q', trips: [
    { id: 'q', name: 42, start: 'soon', players: [{ id: 2, name: 'Z' }, { id: 2, name: 'dup' }, { id: -1 }],
      ev: [{ c: 'OH', p: 9, t: 'x' }, { c: 'NOPE', p: 2 }, { c: 'TX', p: 2, i: 5, n: 99 }, { c: 'UT', p: 2, i: 5 }], extras: 'yes', rule: 'odd' },
    { id: 'q', name: 'twin' }
  ] });
  var w = weird.trips[0];
  assert.strictEqual(weird.active, 'q');
  assert.strictEqual(w.name, 'Road trip');
  assert.deepStrictEqual(w.players, [{ id: 2, name: 'Z' }]);
  assert.strictEqual(w.ev.length, 3);
  assert.strictEqual(w.ev[0].p, 2);
  var ids = w.ev.map(function (e) { return e.i; });
  assert.strictEqual(new Set(ids).size, 3, 'event ids made unique');
  assert.ok(w.eseq >= Math.max.apply(null, ids));
  assert.strictEqual(w.rule, 'first'); assert.strictEqual(w.extras.ca, false);
  assert.notStrictEqual(weird.trips[1].id, 'q', 'duplicate trip ids split');
  var r = E.addSighting(w, 'NV', 2, T0);
  assert.ok(ids.indexOf(r.ev.i) < 0);
});

test('search and typed codes', function () {
  var t = mk({ extras: { ca: true, mx: true } }).t, pl = E.placesFor(t);
  var r = E.search(pl, 'new');
  assert.ok(r.length >= 5 && /^New/.test(r[0].n));
  assert.strictEqual(E.search(pl, 'oh')[0].c, 'OH');
  assert.ok(E.search(pl, 'carolina').length === 2);
  assert.ok(E.search(pl, 'princeedward').some(function (p) { return p.c === 'ca-PE'; }));
  assert.strictEqual(E.search(pl, '').length, pl.length);
  assert.strictEqual(E.codeFor(t, 'oh'), 'OH');
  assert.strictEqual(E.codeFor(t, 'bc'), 'ca-BC');
  assert.strictEqual(E.codeFor(t, 'pr'), null, 'territories off');
  assert.strictEqual(E.codeFor(t, 'zz'), null);
  assert.strictEqual(E.codeFor(t, 'ohx'), null);
});

test('export text summarises the trip', function () {
  var t = mk({ name: 'Beach', players: ['Ann', 'Bob'], home: 'OH' }).t;
  E.addSighting(t, 'FL', t.players[0].id, T0);
  E.addSighting(t, 'FL', t.players[1].id, T0 + 1);
  E.addSighting(t, 'HI', t.players[1].id, T0 + 2);
  var txt = E.exportText(t, E.tally(t), T0);
  assert.ok(/License Plate Game — Beach/.test(txt));
  assert.ok(/States: 2\/51 \(4%\)/.test(txt));
  assert.ok(/from Ohio/.test(txt));
  assert.ok(/Players: Bob \d+ · Ann \d+/.test(txt));
  assert.ok(/Rarest: Hawaii \(Legendary\)/.test(txt));
  assert.ok(/FL×2/.test(txt));
  assert.ok(/Still missing: 49 states/.test(txt));
});

test('helpers: bar, stars, dates, relative time', function () {
  var b = E.bar(0.5, 10);
  assert.strictEqual(b.on, '#####'); assert.strictEqual(b.off, '.....');
  assert.strictEqual(E.bar(2, 4).on, '####'); assert.strictEqual(E.bar(-1, 4).off, '....');
  assert.strictEqual(E.stars(3), '***');
  assert.strictEqual(E.fmtDay('2026-07-04'), 'Jul 4');
  assert.strictEqual(E.fmtRange('2026-07-04', '2026-07-09'), 'Jul 4 – Jul 9, 2026');
  assert.strictEqual(E.fmtRange('2026-07-04', null), 'Jul 4, 2026');
  assert.strictEqual(E.relTime(T0, T0 + 10000), 'just now');
  assert.strictEqual(E.relTime(T0, T0 + 5 * 60000), '5 min ago');
  assert.strictEqual(E.fmtClock(T0), '9:00 am');
});

test('determinism + stress: random taps keep the tally consistent', function () {
  var seed = 12345;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  var t = mk({ players: ['A', 'B', 'C'], extras: { ca: true, mx: true, terr: true, sp: true } }).t, pl = E.placesFor(t);
  for (var i = 0; i < 3000; i++) {
    var p = pl[Math.floor(rnd() * pl.length)], who = t.players[Math.floor(rnd() * 3)].id;
    if (rnd() < 0.1) E.removeLatest(t, p.c, who); else E.addSighting(t, p.c, who, T0 + i * 1000);
  }
  var T = E.tally(t), sum = 0, uniq = 0, pp = 0;
  for (var c in T.per) { sum += T.per[c].n; uniq++; }
  T.players.forEach(function (P) { pp += P.pts; });
  assert.strictEqual(sum, T.sightings); assert.strictEqual(sum, t.ev.length);
  assert.strictEqual(uniq, T.all.seen);
  assert.strictEqual(pp, T.points, 'first-call: player points add up to the team');
  assert.deepStrictEqual(E.tally(E.normTrip(JSON.parse(JSON.stringify(t)), 0)).points, T.points);
});

test('review: "everyone" rule pays each player a region bonus for their own full region', function () {
  var x = mk({ players: ['A', 'B'], rule: 'each' }), t = x.t;
  var ne = E.regionPlaces('ne', t).map(function (p) { return p.c; });
  ne.forEach(function (c, i) { E.addSighting(t, c, 1, T0 + i); });
  var T = E.tally(t);
  assert.strictEqual(T.players[0].bonus, E.REGION_BONUS);
  assert.strictEqual(T.players[1].bonus, 0);
  ne.slice(0, -1).forEach(function (c, i) { E.addSighting(t, c, 2, T0 + 100 + i); });
  assert.strictEqual(E.tally(t).players[1].bonus, 0, 'one short: no bonus yet');
  E.addSighting(t, ne[ne.length - 1], 2, T0 + 200);
  T = E.tally(t);
  assert.strictEqual(T.players[1].bonus, E.REGION_BONUS);
  assert.strictEqual(T.bonus, E.REGION_BONUS, 'team bonus counted once');
  assert.strictEqual(T.players[0].pts, T.players[1].pts);
});

test('review: Canada bonus only counts provinces when Canada is on; region total follows extras', function () {
  var x = mk({ extras: { ca: true } }), t = x.t;
  E.PLACES.filter(function (p) { return p.g === 'ca'; }).forEach(function (p, i) { E.addSighting(t, p.c, 1, T0 + i); });
  var T = E.tally(t);
  assert.strictEqual(T.bonus, E.REGION_BONUS);
  assert.strictEqual(T.core.seen, 0, 'provinces are not states');
  assert.strictEqual(T.all.total, 51 + 13);
  E.editTrip(t, { extras: { ca: false } });
  T = E.tally(t);
  assert.strictEqual(T.points, 0); assert.strictEqual(T.all.total, 51);
  assert.ok(!T.regions.some(function (r) { return r.id === 'can'; }));
});

test('review: minus falls back to anyone\'s latest; nothing to remove returns null', function () {
  var t = mk({ players: ['A', 'B'] }).t;
  E.addSighting(t, 'OH', 1, T0); E.addSighting(t, 'OH', 1, T0 + 1);
  var e = E.removeLatest(t, 'OH', 2);
  assert.ok(e && e.p === 1 && e.t === T0 + 1);
  assert.strictEqual(E.removeLatest(t, 'TX', 1), null);
  assert.strictEqual(E.removeEvent(t, 9999), null);
  assert.strictEqual(E.tally(t).per.OH.n, 1);
});

test('review: completing all 51 with the last region yields both milestones', function () {
  var t = mk({}).t;
  var us = E.PLACES.filter(function (p) { return p.g === 'us'; });
  us.slice(0, -1).forEach(function (p, i) { E.addSighting(t, p.c, 1, T0 + i); });
  var before = E.tally(t);
  E.addSighting(t, us[us.length - 1].c, 1, T0 + 999);
  var kinds = E.milestones(before, E.tally(t)).map(function (m) { return m.kind; });
  assert.ok(kinds.indexOf('all') >= 0 && kinds.indexOf('region') >= 0, kinds.join());
  assert.deepStrictEqual(E.milestones(E.tally(t), E.tally(t)), [], 'nothing new, nothing to celebrate');
});

test('review: save normaliser repairs duplicate trip/event ids, bad players, bad active', function () {
  var raw = { v: 1, active: 'dup', seq: -4, trips: [
    { id: 'dup', name: 'A', players: [{ id: 3, name: 'Z' }, { id: 3, name: 'Y' }, { id: 'x' }], ev: [{ i: 2, c: 'OH', p: 3, t: T0 }, { i: 2, c: 'PA', p: 7, t: T0 + 1 }, { c: 'ZZ' }, null], eseq: 0 },
    { id: 'dup', name: '', players: 'nope', ev: 'nope', start: 'yesterday' },
    7, 'str'
  ] };
  var s = E.normSave(JSON.parse(JSON.stringify(raw)));
  assert.strictEqual(s.trips.length, 2);
  assert.notStrictEqual(s.trips[0].id, s.trips[1].id);
  assert.strictEqual(s.active, 'dup');
  var a = s.trips[0];
  assert.strictEqual(a.players.length, 1);
  assert.strictEqual(a.ev.length, 2);
  assert.notStrictEqual(a.ev[0].i, a.ev[1].i, 'event ids made unique');
  assert.strictEqual(a.ev[1].p, 3, 'unknown player mapped to the first');
  assert.ok(a.eseq >= 3);
  var n = E.addSighting(a, 'TX', 3, T0 + 5);
  assert.ok(a.ev.filter(function (e) { return e.i === n.ev.i; }).length === 1, 'new ids never collide');
  assert.strictEqual(s.trips[1].players[0].name, 'Me');
  assert.ok(/^\d{4}-\d\d-\d\d$/.test(s.trips[1].start));
  assert.ok(s.seq >= 2);
});

test('review: typed codes reach provinces / territories only when their extras are on', function () {
  var t = mk({}).t;
  assert.strictEqual(E.codeFor(t, 'on'), null);
  assert.strictEqual(E.codeFor(t, 'pr'), null);
  E.editTrip(t, { extras: { ca: true, terr: true } });
  assert.strictEqual(E.codeFor(t, 'on'), 'ca-ON');
  assert.strictEqual(E.codeFor(t, 'pr'), 'PR');
  assert.strictEqual(E.codeFor(t, 'oh'), 'OH');
  assert.strictEqual(E.codeFor(t, 'o'), null);
});

console.log(passed + ' passed');
