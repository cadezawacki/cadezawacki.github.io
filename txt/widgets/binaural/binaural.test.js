/* Unit tests for Binaural Beats' DOM-free core (presets, journeys, envelope,
 * noise beds, the seamless loop renderer and the WAV encoder).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/binaural/binaural.test.js */
'use strict';
var assert = require('assert');
var C = require('./binaural.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function near(a, b, eps, msg) { assert.ok(Math.abs(a - b) <= (eps || 1e-9), (msg || '') + ' ' + a + ' ≉ ' + b); }

test('bands: edges and the top band', function () {
  assert.strictEqual(C.band(0.5).id, 'delta');
  assert.strictEqual(C.band(3.99).id, 'delta');
  assert.strictEqual(C.band(4).id, 'theta');
  assert.strictEqual(C.band(7.83).id, 'theta');
  assert.strictEqual(C.band(8).id, 'alpha');
  assert.strictEqual(C.band(12.9).id, 'alpha');
  assert.strictEqual(C.band(13).id, 'beta');
  assert.strictEqual(C.band(29.9).id, 'beta');
  assert.strictEqual(C.band(30).id, 'gamma');
  assert.strictEqual(C.band(45).id, 'gamma');
  assert.strictEqual(C.band(999).id, 'gamma');
});

test('presets: unique ids, known groups, in range, normalize to themselves', function () {
  var ids = {}, groups = {}, n = 0;
  C.GROUPS.forEach(function (g) { groups[g.id] = 0; });
  C.PRESETS.forEach(function (p) {
    assert.ok(!ids[p.id], 'dup ' + p.id); ids[p.id] = 1;
    assert.ok(p.group in groups && p.group !== 'mine', p.id + ' group');
    groups[p.group]++;
    assert.ok(p.name && p.desc, p.id + ' name/desc');
    var c = C.presetCfg(p.id);
    assert.strictEqual(c.id, p.id);
    assert.strictEqual(c.name, p.name);
    assert.ok(c.carrier >= 40 && c.carrier <= 1000, p.id);
    assert.ok(c.beat >= 0.5 && c.beat <= 45, p.id);
    if (p.beat != null) assert.strictEqual(c.beat, p.beat, p.id + ' beat kept');
    assert.strictEqual(c.carrier, p.carrier, p.id + ' carrier kept');
    if (p.path) { assert.deepStrictEqual(c.path, p.path, p.id + ' path kept'); assert.strictEqual(c.beat, p.path[0][1]); }
    else assert.strictEqual(c.path, null);
    if (p.mins != null) assert.ok(C.TIMERS.indexOf(p.mins) > 0, p.id + ' timer is one of the menu values');
    assert.ok(C.sameSound(c, C.normalizeCfg(JSON.parse(JSON.stringify(c)))), p.id + ' round-trips');
    // a binaural beat needs both ears audible: the right ear stays under 1.1 kHz
    assert.ok(C.freqs(c, 45).r <= 1100);
    n++;
  });
  assert.ok(n >= 36, 'lots of presets (' + n + ')');
  Object.keys(groups).forEach(function (g) { if (g !== 'mine') assert.ok(groups[g] >= 4, g + ' has presets'); });
  assert.strictEqual(C.presetCfg('nope'), null);
});

test('normalizeCfg: junk → defaults, clamps, strings', function () {
  [null, undefined, 5, 'x', [], {}].forEach(function (j) {
    var c = C.normalizeCfg(j);
    assert.strictEqual(c.carrier, 200); assert.strictEqual(c.beat, 10); assert.strictEqual(c.mode, 'binaural');
    assert.strictEqual(c.noise, 'off'); assert.strictEqual(c.path, null); assert.strictEqual(c.name, 'Custom');
  });
  var c = C.normalizeCfg({ carrier: 5, beat: 900, mode: 'weird', tone: 3, noise: 'purple', nvol: -1, fadeIn: 1e6, fadeOut: -5, name: '  x'.repeat(30) });
  assert.strictEqual(c.carrier, 40); assert.strictEqual(c.beat, 45); assert.strictEqual(c.mode, 'binaural');
  assert.strictEqual(c.tone, 1); assert.strictEqual(c.noise, 'off'); assert.strictEqual(c.nvol, 0);
  assert.strictEqual(c.fadeIn, 120); assert.strictEqual(c.fadeOut, 0); assert.ok(c.name.length <= 40);
  c = C.normalizeCfg({ carrier: '136.1', beat: '7.834', tone: '' });
  assert.strictEqual(c.carrier, 136.1); assert.strictEqual(c.beat, 7.83); assert.strictEqual(c.tone, 0.6);
});

test('normPath: sorts, dedupes times, adds a start point, needs two points', function () {
  assert.strictEqual(C.normPath(null), null);
  assert.strictEqual(C.normPath([[0, 10]]), null);
  assert.strictEqual(C.normPath([['a', 1], [0]]), null);
  assert.deepStrictEqual(C.normPath([[20, 6], [0, 14]]), [[0, 14], [20, 6]]);
  assert.deepStrictEqual(C.normPath([[0, 14], [5, 9], [5, 8]]), [[0, 14], [5, 8]]);
  assert.deepStrictEqual(C.normPath([[10, 4]], 12), [[0, 12], [10, 4]]);
  assert.deepStrictEqual(C.normPath([[0, 0.1], [999, 99]]), [[0, 0.5], [180, 45]]);
  var long = []; for (var i = 0; i < 20; i++) long.push([i, 5]);
  assert.strictEqual(C.normPath(long).length, 8);
  var c = C.normalizeCfg({ beat: 12, path: [[10, 4]] });
  assert.strictEqual(c.beat, 12);
  assert.deepStrictEqual(c.path, [[0, 12], [10, 4]]);
});

test('beatAt / pathAfter follow a journey and hold its end', function () {
  var c = C.presetCfg('power-nap');           // 10 → 4 (5 min) → 4 (18) → 14 (25)
  near(C.beatAt(c, 0), 10); near(C.beatAt(c, -5), 10);
  near(C.beatAt(c, 150), 7);                   // halfway down the first ramp
  near(C.beatAt(c, 300), 4); near(C.beatAt(c, 600), 4);
  near(C.beatAt(c, 21.5 * 60), 9);
  near(C.beatAt(c, 25 * 60), 14); near(C.beatAt(c, 99999), 14);
  assert.strictEqual(C.pathSecs(c), 1500);
  assert.deepStrictEqual(C.pathAfter(c, 300), [[1080, 4], [1500, 14]]);
  assert.deepStrictEqual(C.pathAfter(c, 0), [[300, 4], [1080, 4], [1500, 14]]);
  assert.deepStrictEqual(C.pathAfter(c, 1500), []);
  var s = C.presetCfg('calm');
  near(C.beatAt(s, 1234), 10); assert.deepStrictEqual(C.pathAfter(s, 0), []); assert.strictEqual(C.pathSecs(s), 0);
  assert.strictEqual(C.pathLabel(c), '10 → 4 → 4 → 14 Hz · 25 min');
});

test('freqs: right ear sits a beat above the carrier; isochronic pulses', function () {
  var c = C.normalizeCfg({ carrier: 200, beat: 10 });
  assert.deepStrictEqual(C.freqs(c, 10), { l: 200, r: 210, pulse: 0 });
  c.mode = 'monaural';
  assert.deepStrictEqual(C.freqs(c, 6), { l: 200, r: 206, pulse: 0 });
  c.mode = 'iso';
  assert.deepStrictEqual(C.freqs(c, 40), { l: 200, r: 200, pulse: 40 });
});

test('envelope: fade in, timer fade out, skip-in, plan breakpoints agree', function () {
  var c = C.normalizeCfg({ fadeIn: 10, fadeOut: 30 });
  near(C.envAt(c, 0, 0), 0); near(C.envAt(c, 5, 0), 0.5); near(C.envAt(c, 10, 0), 1); near(C.envAt(c, 1e5, 0), 1);
  near(C.envAt(c, 0, 0, true), 1);
  var T = 600;
  near(C.envAt(c, 570, T), 1); near(C.envAt(c, 585, T), 0.5); near(C.envAt(c, 600, T), 0); near(C.envAt(c, 700, T), 0);
  // a short timer squeezes both fades into thirds
  near(C.envAt(c, 10, 30), 1); near(C.envAt(c, 25, 30), 0.5);
  assert.deepStrictEqual(C.envPlan(c, 0, T), [[0, 0], [10, 1], [570, 1], [600, 0]]);
  assert.deepStrictEqual(C.envPlan(c, 20, T), [[20, 1], [570, 1], [600, 0]]);
  assert.deepStrictEqual(C.envPlan(c, 585, T), [[585, 0.5], [600, 0]]);
  assert.deepStrictEqual(C.envPlan(c, 0, 0), [[0, 0], [10, 1]]);
  assert.deepStrictEqual(C.envPlan(c, 0, 0, true), [[0, 1]]);
  assert.deepStrictEqual(C.envPlan(c, 650, T), [[650, 0]]);
  // linear interpolation of the plan matches envAt everywhere
  var plan = C.envPlan(c, 3, T);
  for (var s = 3; s <= 600; s += 7) {
    var j = 1; while (j < plan.length && plan[j][0] < s) j++;
    var a = plan[j - 1], b = plan[Math.min(j, plan.length - 1)], v = b[0] > a[0] ? a[1] + (b[1] - a[1]) * (s - a[0]) / (b[0] - a[0]) : a[1];
    near(v, C.envAt(c, s, T), 1e-9, 's=' + s);
  }
  var z = C.normalizeCfg({ fadeIn: 0, fadeOut: 0 });
  near(C.envAt(z, 0, 60), 1); near(C.envAt(z, 59.9, 60), 1); near(C.envAt(z, 60, 60), 0);
});

test('formatting and slider maps', function () {
  assert.strictEqual(C.fmtHz(7.83), '7.83'); assert.strictEqual(C.fmtHz(10), '10'); assert.strictEqual(C.fmtHz(2.5), '2.5'); assert.strictEqual(C.fmtHz(6.666666), '6.67');
  assert.strictEqual(C.fmtClock(0), '0:00'); assert.strictEqual(C.fmtClock(65.9), '1:05'); assert.strictEqual(C.fmtClock(3600), '1:00:00'); assert.strictEqual(C.fmtClock(-4), '0:00');
  [0.5, 1, 2.5, 7.83, 10, 40, 45].forEach(function (v) { near(C.fromPos(C.toPos(v, 0.5, 45), 0.5, 45), v, v * 0.006, 'beat ' + v); });
  assert.strictEqual(C.toPos(0.5, 0.5, 45), 0); assert.strictEqual(C.toPos(45, 0.5, 45), 1000); assert.strictEqual(C.toPos(999, 0.5, 45), 1000);
  near(C.fromPos(-1, 40, 1000), 40); near(C.fromPos(5000, 40, 1000), 1000);
  assert.strictEqual(C.snapBeat(7.86), 7.9); assert.strictEqual(C.snapBeat(14.3), 14.5); assert.strictEqual(C.snapBeat(38.6), 39); assert.strictEqual(C.snapBeat(0.01), 0.5);
  assert.strictEqual(C.snapCarrier(136.4), 136); assert.strictEqual(C.snapCarrier(432.4), 430); assert.strictEqual(C.snapCarrier(9999), 1000);
});

test('pulse: smoothed square peaks at ±1, gain stays in 0..1, ~50% duty', function () {
  var t = C.pulseTable(), mx = -9, mn = 9, on = 0;
  for (var i = 0; i < t.length; i++) { mx = Math.max(mx, t[i]); mn = Math.min(mn, t[i]); if (t[i] > 0) on++; }
  near(mx, 1, 1e-6); near(mn, -1, 1e-6);
  near(on / t.length, 0.5, 0.01);
  var c = C.pulseCoefs();
  assert.strictEqual(c.real.length, c.imag.length);
  assert.ok(c.imag[1] > c.imag[3] && c.imag[3] > c.imag[5] && c.imag[2] === 0, 'odd harmonics, decaying');
});

test('noise beds: normalized RMS, no DC, seamless loop point, deterministic with a seed', function () {
  var sr = 8000, n = 16000;
  ['white', 'pink', 'brown', 'rain', 'ocean'].forEach(function (k) {
    var b = C.noiseBuf(k, sr, n, C.rng(7)), ss = 0, mean = 0, i, maxStep = 0;
    for (i = 0; i < n; i++) { ss += b[i] * b[i]; mean += b[i]; }
    near(Math.sqrt(ss / n), C.NOISE_RMS, 1e-4, k + ' rms');
    assert.ok(Math.abs(mean / n) < 0.02, k + ' dc ' + mean / n);
    // the jump across the loop point is no bigger than ordinary sample-to-sample steps
    for (i = 1; i < n; i++) maxStep = Math.max(maxStep, Math.abs(b[i] - b[i - 1]));
    assert.ok(Math.abs(b[0] - b[n - 1]) <= maxStep, k + ' seam');
    var again = C.noiseBuf(k, sr, n, C.rng(7));
    assert.strictEqual(again[1234], b[1234], k + ' seeded');
  });
  // brown is darker than white: much smaller sample-to-sample steps at equal RMS
  function meanStep(b) { var s = 0; for (var i = 1; i < b.length; i++) s += Math.abs(b[i] - b[i - 1]); return s / b.length; }
  assert.ok(meanStep(C.noiseBuf('brown', sr, n, C.rng(1))) < meanStep(C.noiseBuf('white', sr, n, C.rng(1))) / 4);
  near(C.swell(0, 10), 0.3); near(C.swell(5, 10), 1); near(C.swell(10, 10), 0.3);
  near(C.swellPeriod(60), 10); near(C.swellPeriod(36), 9);
});

test('loop: whole cycles per loop, seamless wrap for every mode', function () {
  var secs = 2, sr = 8000, n = secs * sr;
  var c = C.normalizeCfg({ carrier: 136.1, beat: 7.83, tone: 1, noise: 'off' });
  var fq = C.loopFreqs(c, 7.83, secs);
  near(fq.l * secs, Math.round(fq.l * secs)); near(fq.r * secs, Math.round(fq.r * secs));
  assert.ok(Math.abs(fq.l - 136.1) <= 0.5 / secs && Math.abs(fq.r - 143.93) <= 0.5 / secs);
  near(C.loopFreqs(c, 7.83, 60).r - C.loopFreqs(c, 7.83, 60).l, 7.83, 1 / 60 + 1e-9);   // beat kept to 1/60 Hz
  ['binaural', 'monaural', 'iso'].forEach(function (mode) {
    var cc = C.normalizeCfg({ carrier: 200, beat: 10, tone: 1, mode: mode, noise: 'off' });
    var out = C.synthLoop(cc, { sr: sr, secs: secs, vol: 1 });
    var L = out.chans[0], R = out.chans[1];
    assert.strictEqual(L.length, n);
    // sample n would be sample 0 again: compare the step across the wrap with the opening step
    var wl = 2 * Math.PI * out.freqs.l / sr;
    near(Math.sin(wl * n), Math.sin(0), 1e-6, mode + ' wraps');
    near(L[0], 0, 1e-9, mode + ' starts at a zero crossing');
    var mx = 0; for (var i = 0; i < n; i++) mx = Math.max(mx, Math.abs(L[i]), Math.abs(R[i]));
    assert.ok(mx <= C.TONE_GAIN + 1e-6 && mx > C.TONE_GAIN * 0.9, mode + ' peak ' + mx);
    if (mode === 'binaural') assert.notStrictEqual(L[1000], R[1000]);
    else assert.strictEqual(L[1000], R[1000]);
  });
  var iso = C.normalizeCfg({ carrier: 200, beat: 4, mode: 'iso', tone: 1 });
  var o = C.synthLoop(iso, { sr: sr, secs: 1 }).chans[0];
  // the pulse gates the tone: quiet for part of every 1/4 s cycle
  var quiet = 0; for (var k = 0; k < sr; k += 50) if (Math.abs(o[k]) < 0.02) quiet++;
  assert.ok(quiet > 30, 'pulses have gaps (' + quiet + ')');
});

test('loop: noise and volume mix, clamped, deterministic, beat override', function () {
  var c = C.normalizeCfg({ carrier: 200, beat: 10, tone: 0, noise: 'ocean', nvol: 1 });
  var a = C.synthLoop(c, { sr: 8000, secs: 2, vol: 0.5, rnd: C.rng(3) }), b = C.synthLoop(c, { sr: 8000, secs: 2, vol: 0.5, rnd: C.rng(3) });
  assert.strictEqual(a.chans[0][777], b.chans[0][777]);
  assert.notStrictEqual(a.chans[0][777], a.chans[1][777], 'stereo noise is decorrelated');
  var loud = C.synthLoop(C.normalizeCfg({ tone: 1, noise: 'white', nvol: 1 }), { sr: 8000, secs: 1, vol: 1, rnd: C.rng(1) }), mx = 0;
  for (var i = 0; i < loud.chans[0].length; i++) mx = Math.max(mx, Math.abs(loud.chans[0][i]));
  assert.ok(mx <= 1);
  var j = C.presetCfg('drift-off'), at = C.synthLoop(j, { sr: 8000, secs: 1, beat: 5, rnd: C.rng(1) });
  near(at.freqs.r - at.freqs.l, 5, 1e-9);
  var silent = C.synthLoop(C.normalizeCfg({ tone: 0, noise: 'off' }), { sr: 8000, secs: 1 });
  assert.ok(silent.chans[0].every(function (x) { return x === 0; }));
});

test('encodeWAV: header, interleaving, clipping', function () {
  var buf = C.encodeWAV([new Float32Array([0, 1, -1, 2]), new Float32Array([0.5, -0.5, 0, -3])], 22050), v = new DataView(buf);
  function s4(o) { var s = ''; for (var j = 0; j < 4; j++) s += String.fromCharCode(v.getUint8(o + j)); return s; }
  assert.strictEqual(s4(0), 'RIFF'); assert.strictEqual(s4(8), 'WAVE'); assert.strictEqual(s4(12), 'fmt '); assert.strictEqual(s4(36), 'data');
  assert.strictEqual(v.getUint16(22, true), 2); assert.strictEqual(v.getUint32(24, true), 22050); assert.strictEqual(v.getUint16(34, true), 16);
  assert.strictEqual(v.getUint32(40, true), 16); assert.strictEqual(buf.byteLength, 44 + 16);
  var got = []; for (var i = 0; i < 8; i++) got.push(v.getInt16(44 + i * 2, true));
  assert.deepStrictEqual(got, [0, 16384, 32767, -16384, -32768, 0, 32767, -32768]);
});

test('normalizeMine: keeps valid presets, fixes ids, caps the list', function () {
  assert.deepStrictEqual(C.normalizeMine('x'), []);
  var m = C.normalizeMine([{ id: 'mine-a', name: 'A', beat: 6 }, null, { id: 'mine-a', name: 'B' }, { id: 'calm', name: 'C' }]);
  assert.strictEqual(m.length, 3);
  assert.strictEqual(m[0].id, 'mine-a'); assert.strictEqual(m[0].beat, 6);
  assert.ok(/^mine-/.test(m[1].id) && m[1].id !== 'mine-a');
  assert.ok(/^mine-/.test(m[2].id));
  var many = []; for (var i = 0; i < 90; i++) many.push({ id: 'mine-' + i });
  assert.strictEqual(C.normalizeMine(many).length, 60);
});

test('render cost: a full 60 s loop at 22 kHz renders quickly', function () {
  var c = C.presetCfg('night-ocean'), t0 = Date.now();
  var out = C.synthLoop(c, { vol: 0.7 }), wav = C.encodeWAV(out.chans, out.sr), ms = Date.now() - t0;
  assert.strictEqual(out.chans[0].length, C.LOOP_SECS * C.LOOP_SR);
  assert.strictEqual(wav.byteLength, 44 + C.LOOP_SECS * C.LOOP_SR * 4);
  assert.ok(ms < 3000, 'took ' + ms + ' ms');
});

if (!process.exitCode) console.log('ok — ' + passed + ' passed');
