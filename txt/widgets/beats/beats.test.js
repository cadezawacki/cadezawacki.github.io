/* Unit tests for Beat Maker's pure core (pattern model, presets, timing math,
 * scheduler order, ASCII tab export / import, WAV encoder).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/beats/beats.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var C = require('./beats.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function rng(seed) {                      // deterministic randomness (mulberry32)
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function near(a, b, eps, msg) { assert.ok(Math.abs(a - b) <= (eps || 1e-9), (msg || '') + ' ' + a + ' ≈ ' + b); }
function row(p, t) { return p.v[t].slice(0, p.len).map(function (v) { return C.VEL_CH[v]; }).join(''); }

// ---- module shape -------------------------------------------------------------------
test('module parses as a browser script and exports the core in node', function () {
  var src = fs.readFileSync(path.join(__dirname, 'beats.js'), 'utf8');
  assert.doesNotThrow(function () { new Function(src); });
  assert.ok(/Cade\.registerWidget\(\{\s*name: 'Beat Maker'/.test(src), 'registers "Beat Maker"');
  assert.ok(/Cade\.loadCSS\('beats\.css'\)/.test(src), 'loads its CSS at module load');
  assert.strictEqual(typeof C.normalizeSong, 'function');
  // the module must not touch window/document at load in node
  var win = { called: 0 };
  assert.doesNotThrow(function () { new Function('module', 'window', src)(undefined, undefined); });
  assert.strictEqual(win.called, 0);
});
test('manifest entry matches the registered widget', function () {
  var m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === 'beats'; })[0];
  var src = fs.readFileSync(path.join(__dirname, 'beats.js'), 'utf8');
  assert.strictEqual(m.id, 'beats'); assert.strictEqual(m.type, 'widget');
  assert.strictEqual(m.entry, 'widgets/beats/beats.js'); assert.strictEqual(m.css, 'widgets/beats/beats.css');
  ['name', 'description', 'icon', 'tags'].forEach(function (k) {
    assert.ok(src.indexOf(k + ': ' + JSON.stringify(m[k])) >= 0 || src.indexOf(k + ": '" + m[k].replace(/'/g, "\\'") + "'") >= 0, k + ' matches beats.js');
  });
});

// ---- model -------------------------------------------------------------------------
test('tracks: 11 with unique two-letter codes, two melodic', function () {
  assert.strictEqual(C.NT, 11);
  var codes = C.TRACKS.map(function (t) { return t.code; });
  assert.strictEqual(new Set(codes).size, 11);
  codes.forEach(function (c) { assert.ok(/^[A-Z]{2}$/.test(c), c); });
  assert.deepStrictEqual(C.TRACKS.filter(function (t) { return t.note; }).map(function (t) { return t.code; }), ['BS', 'KY']);
});
test('empty song is valid and has four 16-step patterns', function () {
  var s = C.emptySong();
  assert.strictEqual(s.pats.length, 4);
  s.pats.forEach(function (p) { assert.strictEqual(p.len, 16); assert.strictEqual(p.v.length, 11); assert.strictEqual(p.v[0].length, 32); });
  assert.deepStrictEqual(s.chain, [0]);
  assert.strictEqual(C.patternHits(s.pats[0]), 0);
});
test('serialize → normalize round-trips every field', function () {
  var s = C.presetSong(2);
  s.id = 'abc123'; s.name = 'My jam'; s.human = 17; s.master = 0.6; s.echo = 0.4; s.mode = 'loop';
  s.mix[3] = { vol: 0.33, mute: true, solo: false }; s.mix[0].solo = true;
  s.pats[3].len = 32; s.pats[3].v[C.KY][31] = 1; s.pats[3].n[C.KY][31] = 13;
  var j = JSON.parse(JSON.stringify(C.serialize(s)));
  var r = C.normalizeSong(j);
  assert.deepStrictEqual(C.serialize(r), C.serialize(s));
  assert.strictEqual(r.pats[3].n[C.KY][31], 13);
  assert.strictEqual(r.mix[3].mute, true); assert.strictEqual(r.mix[0].solo, true);
  assert.strictEqual(typeof j.pats[0].t.KK, 'string');
  assert.strictEqual(j.pats[0].t.KK.length, 32);
  assert.ok(!j.pats[0].t.TM, 'empty tracks are not stored');
});
test('normalize clamps and repairs junk', function () {
  var r = C.normalizeSong({ bpm: 999, swing: -5, key: 40, scale: 'nope', kit: 'x', bass: 1, keys: null, chain: 'AZBQd', mix: [[5, 1, 0], 'x'],
    pats: [{ len: 12, t: { KK: 'X?x-g', ZZ: 'xxxx' }, n: {} }, null, 'bad'], name: '  a\nb  ', id: '../evil' });
  assert.strictEqual(r.bpm, 200); assert.strictEqual(r.swing, 0); assert.strictEqual(r.key, 11);
  assert.strictEqual(r.scale, 'minor'); assert.strictEqual(r.kit, '909'); assert.strictEqual(r.bass, 'sub'); assert.strictEqual(r.keys, 'stab');
  assert.deepStrictEqual(r.chain, [0, 1, 3]);
  assert.strictEqual(r.mix[0].vol, 1); assert.strictEqual(r.mix[0].mute, true);
  assert.strictEqual(r.mix[1].vol, C.TRACKS[1].vol);
  assert.strictEqual(r.pats[0].len, 16);
  assert.deepStrictEqual(r.pats[0].v[0].slice(0, 6), [3, 0, 2, 0, 1, 0]);
  assert.strictEqual(r.name, 'a b'); assert.strictEqual(r.id, 'evil');
  assert.deepStrictEqual(C.serialize(C.normalizeSong(null)), C.serialize(C.emptySong()));
  assert.deepStrictEqual(C.normalizeSong({ chain: [] }).chain, [0]);
  assert.strictEqual(C.normalizeSong({ chain: 'ABCDABCDABCDABCDABCD' }).chain.length, 16);
});
test('copy / clear / cloneSong are deep', function () {
  var s = C.presetSong(0), q = C.copyPattern(s.pats[0]);
  q.v[0][0] = 0;
  assert.strictEqual(s.pats[0].v[0][0], 2);
  var c = C.cloneSong(s);
  c.pats[0].v[0][0] = 0; c.mix[0].vol = 0;
  assert.strictEqual(s.pats[0].v[0][0], 2); assert.ok(s.mix[0].vol > 0);
  C.clearPattern(q);
  assert.strictEqual(C.patternHits(q), 0);
});

// ---- presets -------------------------------------------------------------------------
test('at least 8 presets in different styles, all sane', function () {
  assert.ok(C.PRESETS.length >= 8);
  var names = C.PRESETS.map(function (p) { return p.name; });
  ['House', 'Boom Bap', 'Techno', 'Trap', 'Dembow', 'Rock', 'Funk', 'Drum & Bass', 'Lo-fi'].forEach(function (n) { assert.ok(names.indexOf(n) >= 0, n); });
  C.PRESETS.forEach(function (ps, i) {
    ps.pats.forEach(function (rows, pi) {
      Object.keys(rows).forEach(function (k) {
        assert.ok(rows[k].length <= 32 && [8, 16, 32].indexOf(rows[k].length) >= 0, ps.name + ' ' + 'ABCD'[pi] + ' ' + k + ' length ' + rows[k].length);
        assert.ok(/^[A-Z]{2}v?$/.test(k), 'row key ' + k);
        if (!/v$/.test(k)) assert.ok(C.TRACKS.some(function (t) { return t.code === k; }), ps.name + ': unknown track ' + k);
      });
    });
    var s = C.presetSong(i);
    assert.strictEqual(s.name, ps.name);
    assert.ok(s.bpm >= 60 && s.bpm <= 200);
    assert.ok(C.patternHits(s.pats[0]) > 6, ps.name + ' has a groove');
    assert.ok(C.trackHits(s.pats[0], C.KK) > 0, ps.name + ' has a kick');
    assert.ok(C.trackHits(s.pats[0], C.BS) > 0, ps.name + ' has a bassline');
    s.chain.forEach(function (c) { assert.ok(C.patternHits(s.pats[c]) > 0, ps.name + ' chain hits an empty pattern'); });
    assert.deepStrictEqual(C.serialize(C.normalizeSong(C.serialize(s))), C.serialize(s));
    // melodic notes stay in a playable range
    [C.BS, C.KY].forEach(function (t) { s.pats.forEach(function (p) { for (var k = 0; k < 32; k++) assert.ok(p.n[t][k] >= 0 && p.n[t][k] <= 21); }); });
  });
  var names2 = {};
  C.PRESETS.forEach(function (p) { assert.ok(!names2[p.name]); names2[p.name] = 1; });
});
test('preset strings decode with velocities and note overlays', function () {
  var house = C.presetSong(0), techno = C.presetSong(2);
  assert.strictEqual(row(house.pats[0], C.KK), 'x---x---x---x---');
  assert.strictEqual(row(house.pats[0], C.OH), '--X---X---X---X-');
  assert.strictEqual(row(house.pats[0], C.SH), '-g-g-g-g-g-g-g-g');
  assert.strictEqual(house.pats[0].n[C.BS][13], 3);
  assert.strictEqual(techno.pats[0].v[C.BS][2], 3, 'acid accent overlay');
  assert.strictEqual(techno.pats[0].n[C.BS][2], 7);
  assert.strictEqual(techno.pats[0].v[C.BS][0], 2);
  assert.strictEqual(techno.pats[0].v[C.BS][1], 0);
  assert.deepStrictEqual(house.chain, [0, 0, 1, 1]);
  assert.strictEqual(house.mode, 'song');
});

// ---- timing -------------------------------------------------------------------------
test('step duration and swing math', function () {
  near(C.stepDur(120), 0.125); near(C.stepDur(60), 0.25); near(C.barDur(120), 2);
  assert.strictEqual(C.swingOffset(0, 120, 60), 0);
  assert.strictEqual(C.swingOffset(2, 120, 100), 0);
  near(C.swingOffset(1, 120, 100), 0.0625, 1e-12, 'dotted at 100%');
  near(C.swingOffset(3, 120, 50), 0.03125);
  near(C.swingOffset(1, 120, 66.6667), 0.125 / 3, 1e-6, 'triplet feel near 66%');
  assert.strictEqual(C.swingOffset(1, 120, 0), 0);
  near(C.swingOffset(1, 120, 250), 0.0625, 1e-12, 'clamped');
  near(C.stepTime(10, 5, 120, 50), 10 + 5 * 0.125 + 0.03125);
  // swung odd steps always stay before the next even step
  for (var sw = 0; sw <= 100; sw += 10) assert.ok(C.stepTime(0, 1, 97, sw) < C.stepTime(0, 2, 97, sw));
});
test('noteSteps wraps to the next hit of the same track', function () {
  var p = C.emptyPattern(16);
  p.v[C.BS][0] = 2; p.v[C.BS][6] = 2; p.v[C.BS][12] = 2;
  assert.strictEqual(C.noteSteps(p, C.BS, 0), 6);
  assert.strictEqual(C.noteSteps(p, C.BS, 12), 4);
  p.v[C.BS][6] = 0; p.v[C.BS][12] = 0;
  assert.strictEqual(C.noteSteps(p, C.BS, 0), 16);
});
test('cursor loops a pattern, follows a cue, and walks the chain', function () {
  var s = C.emptySong();
  s.pats[1].len = 8; s.chain = [0, 0, 1, 2];
  var c = new C.Cursor(s, 'loop', 2), seen = [];
  for (var i = 0; i < 20; i++) { seen.push(c.pat + ':' + c.step); c.advance(); }
  assert.strictEqual(seen[16], '2:0');
  c = new C.Cursor(s, 'loop', 0);
  for (i = 0; i < 5; i++) c.advance();
  c.cue = 1;
  for (i = 5; i < 16; i++) { assert.strictEqual(c.pat, 0); c.advance(); }
  assert.strictEqual(c.pat, 1); assert.strictEqual(c.step, 0); assert.strictEqual(c.cue, -1);
  c = new C.Cursor(s, 'song', 3);
  var order = [];
  for (i = 0; i < 16 + 16 + 8 + 16 + 4; i++) { if (c.step === 0) order.push(c.pat); c.advance(); }
  assert.deepStrictEqual(order, [0, 0, 1, 2, 0]);
  assert.strictEqual(C.songSteps(s), 56);
  // shrinking a pattern while the cursor is past the new end wraps on the next step
  c = new C.Cursor(s, 'loop', 0);
  for (i = 0; i < 12; i++) c.advance();
  s.pats[0].len = 8;
  c.advance();
  assert.strictEqual(c.step, 0);
});
test('plan: event times, swing, chain order and note lengths', function () {
  var s = C.emptySong();
  s.bpm = 120; s.swing = 50;
  var p = s.pats[0];
  p.v[C.KK][0] = 3; p.v[C.CH][1] = 2; p.v[C.BS][0] = 2; p.n[C.BS][0] = 4; p.v[C.BS][8] = 1;
  var r = C.plan(s, { mode: 'loop', pat: 0, steps: 32 });
  near(r.duration, 4);
  assert.strictEqual(r.events.length, 8);
  var hat = r.events.filter(function (e) { return e.track === C.CH; });
  near(hat[0].time, 0.125 + 0.03125); near(hat[1].time, 2 + 0.125 + 0.03125);
  var bass = r.events.filter(function (e) { return e.track === C.BS; });
  near(bass[0].len, 8 * 0.125); assert.strictEqual(bass[0].deg, 4); assert.strictEqual(bass[1].vel, 1);
  assert.ok(r.events.every(function (e, i, a) { return !i || a[i - 1].time <= e.time + 1e-12; }), 'time-ordered');
  // song mode follows the chain
  s.pats[1].v[C.SN][0] = 2; s.chain = [1, 0]; s.swing = 0;
  r = C.plan(s, { mode: 'song', steps: C.songSteps(s) });
  assert.strictEqual(r.events[0].track, C.SN); near(r.events[0].time, 0);
  assert.strictEqual(r.events[1].track, C.KK); near(r.events[1].time, 2);
});
test('quantize snaps live taps to the nearest step', function () {
  var sd = C.stepDur(120);
  assert.deepStrictEqual(C.quantize(10.0, 10, 4, sd, 16), { k: 0, step: 4 });
  assert.strictEqual(C.quantize(10.07, 10, 4, sd, 16).step, 5);
  assert.strictEqual(C.quantize(10.05, 10, 4, sd, 16).step, 4);
  assert.strictEqual(C.quantize(10 + 0.13 * 2, 10, 15, sd, 16).step, 1, 'wraps');
  assert.strictEqual(C.quantize(9.9, 10, 0, sd, 16).step, 15, 'early tap wraps back');
});
test('tap tempo', function () {
  assert.strictEqual(C.tapTempo([0]), null);
  assert.strictEqual(C.tapTempo([0, 0.5, 1, 1.5]), 120);
  assert.strictEqual(C.tapTempo([0, 5, 5.6, 6.2]), 100, 'ignores taps before a long gap');
  assert.strictEqual(C.tapTempo([0, 0.27, 0.54]), 200, 'clamped');
  assert.strictEqual(C.tapTempo([0, 1.9]), 60, 'clamped low');
});

// ---- notes -------------------------------------------------------------------------
test('scale degrees → MIDI, names and chords', function () {
  assert.strictEqual(C.degreeMidi(0, 0, 'minor', C.BS), 36);
  assert.strictEqual(C.degreeMidi(2, 0, 'minor', C.BS), 39);
  assert.strictEqual(C.degreeMidi(7, 0, 'minor', C.BS), 48);
  assert.strictEqual(C.degreeMidi(5, 9, 'pentmin', C.KY), 57 + 12, 'A pentatonic, an octave up');
  assert.strictEqual(C.degreeMidi(0, 7, 'major', C.BS), 31, 'G bass sits low');
  assert.strictEqual(C.degreeMidi(0, 6, 'major', C.KY), 66);
  near(C.midiFreq(69), 440); near(C.midiFreq(57), 220, 1e-9);
  assert.strictEqual(C.noteName(60), 'C4'); assert.strictEqual(C.noteName(63), 'Eb4'); assert.strictEqual(C.noteName(34, false), 'Bb');
  assert.deepStrictEqual(C.chordDegrees(3, 4), [3, 5, 7, 9]);
  C.SCALE_ORDER.forEach(function (k) { assert.ok(C.SCALES[k].steps[0] === 0 && C.SCALES[k].steps.length >= 5); });
});

test('notes are spelled in the key', function () {
  assert.deepStrictEqual(C.spellScale(5, 'minor'), ['F', 'G', 'Ab', 'Bb', 'C', 'Db', 'Eb']);
  assert.deepStrictEqual(C.spellScale(1, 'minor'), ['C#', 'D#', 'E', 'F#', 'G#', 'A', 'B']);
  assert.deepStrictEqual(C.spellScale(1, 'major'), ['Db', 'Eb', 'F', 'Gb', 'Ab', 'Bb', 'C']);
  assert.deepStrictEqual(C.spellScale(9, 'harmonic'), ['A', 'B', 'C', 'D', 'E', 'F', 'G#']);
  assert.deepStrictEqual(C.spellScale(2, 'dorian'), ['D', 'E', 'F', 'G', 'A', 'B', 'C']);
  assert.deepStrictEqual(C.spellScale(4, 'pentmin'), ['E', 'G', 'A', 'B', 'D']);
  assert.deepStrictEqual(C.spellScale(9, 'blues'), ['A', 'C', 'D', 'Eb', 'E', 'G']);
  assert.strictEqual(C.noteName(61, true, 5, 'minor'), 'Db4');
  assert.strictEqual(C.noteName(61, false, 9, 'major'), 'C#');
  assert.strictEqual(C.noteName(61, true), 'C#4', 'generic without a key');
  assert.strictEqual(C.rootName(3, 'minor'), 'D#', 'Eb minor sits on the sharp side (parent F#)');
  assert.strictEqual(C.rootName(10, 'minor'), 'Bb');
  // every 7-note scale in every key uses each letter once
  for (var k = 0; k < 12; k++) C.SCALE_ORDER.forEach(function (sc) {
    var n = C.spellScale(k, sc);
    if (n.length === 7) assert.strictEqual(new Set(n.map(function (x) { return x.charAt(0); })).size, 7, k + ' ' + sc);
  });
});

// ---- tools ---------------------------------------------------------------------------
test('shift rotates within the pattern length', function () {
  var p = C.emptyPattern(8);
  p.v[C.KK][0] = 3; p.v[C.BS][7] = 2; p.n[C.BS][7] = 5;
  C.shiftPattern(p, 1);
  assert.strictEqual(p.v[C.KK][1], 3); assert.strictEqual(p.v[C.KK][0], 0);
  assert.strictEqual(p.v[C.BS][0], 2); assert.strictEqual(p.n[C.BS][0], 5);
  C.shiftPattern(p, -1);
  assert.strictEqual(p.v[C.KK][0], 3); assert.strictEqual(p.n[C.BS][7], 5);
  assert.strictEqual(p.v[C.KK][8], 0, 'nothing leaks past len');
});
test('randomize makes a groove (kick on 1, snare on 2 & 4) and stays in range', function () {
  for (var seed = 1; seed < 40; seed++) {
    var p = C.emptyPattern(seed % 3 === 0 ? 32 : 16), r = rng(seed);
    C.randomizePattern(p, r, seed % 2 ? 'minor' : 'pentmin');
    assert.ok(p.v[C.KK][0] > 0); assert.ok(p.v[C.SN][4] > 0 && p.v[C.SN][12] > 0);
    for (var t = 0; t < C.NT; t++) for (var k = 0; k < 32; k++) {
      assert.ok(p.v[t][k] >= 0 && p.v[t][k] <= 3);
      if (k >= p.len) assert.strictEqual(p.v[t][k], 0);
      assert.ok(p.n[t][k] >= 0 && p.n[t][k] <= 21);
    }
  }
});
test('mutate keeps the backbone and changes something', function () {
  var changed = 0;
  for (var seed = 1; seed < 30; seed++) {
    var s = C.presetSong(seed % C.PRESETS.length), p = s.pats[0], before = JSON.stringify(p);
    C.mutatePattern(p, rng(seed), s.scale);
    if (JSON.stringify(p) !== before) changed++;
    assert.ok(p.v[C.KK][0] > 0, 'downbeat kick survives');
  }
  assert.ok(changed > 25);
});

// ---- ASCII tab ----------------------------------------------------------------------
test('pattern → tab in the documented format', function () {
  var s = C.presetSong(0);
  var tab = C.toTab(s, 0);
  var lines = tab.split('\n');
  assert.ok(/^Beat Maker · House · pattern A · 124 BPM · swing 12% · F minor$/.test(lines[0]), lines[0]);
  assert.ok(lines.indexOf('KK |x---x---x---x---|') > 0);
  assert.ok(lines.indexOf('OH |--X---X---X---X-|') > 0);
  assert.ok(lines.indexOf('BS |--1---1---1--41-|') > 0, 'notes as 1-based degrees');
  assert.ok(lines.indexOf('TM |') < 0, 'empty tracks omitted');
  assert.strictEqual(lines[lines.length - 1], '(BS, KY = scale degrees, 1 = root)');
  var p = C.emptyPattern(32); p.v[C.KK][0] = 2; p.v[C.KK][16] = 3; s.pats[2] = p;
  assert.ok(C.toTab(s, 2).split('\n').indexOf('KK |x---------------|X---------------|') > 0, '32 steps → two bars');
});
test('tab round-trips a pattern exactly (drums + notes)', function () {
  for (var i = 0; i < C.PRESETS.length; i++) {
    var s = C.presetSong(i), tab = C.toTab(s, 0), t = C.emptySong();
    var parsed = C.fromTab(tab);
    assert.strictEqual(parsed.bpm, s.bpm);
    assert.strictEqual(parsed.swing, s.swing ? s.swing : null);
    C.applyTab(t, parsed, 2);
    var a = s.pats[0], b = t.pats[2];
    assert.strictEqual(b.len, a.len);
    for (var tr = 0; tr < C.NT; tr++) {
      for (var k = 0; k < a.len; k++) {
        var va = a.v[tr][k];
        assert.strictEqual(b.v[tr][k], va, s.name + ' ' + C.TRACKS[tr].code + ':' + k);
        if (va && C.TRACKS[tr].note) assert.strictEqual(b.n[tr][k], a.n[tr][k]);
      }
    }
  }
});
test('note tracks get a velocity lane only when they need one', function () {
  var techno = C.toTab(C.presetSong(2), 0).split('\n'), house = C.toTab(C.presetSong(0), 0);
  assert.ok(techno.indexOf('BS |1-81-1-41-81-1-6|') > 0);
  assert.ok(techno.indexOf('BSv|x-Xx-x-xx-Xx-x-X|') > 0, 'acid accents survive in a lane');
  assert.ok(/BSv, KYv = their velocities\)$/.test(techno[techno.length - 1]));
  assert.ok(house.indexOf('BSv') < 0 && house.indexOf('KYv') < 0);
  // a lane without its note row changes nothing; one before its row still applies
  var r = C.fromTab('BSv|X-g-|\nBS |1-3-|'), s = C.emptySong();
  C.applyTab(s, r, 0);
  assert.deepStrictEqual(s.pats[0].v[C.BS].slice(0, 4), [3, 0, 1, 0]);
  assert.strictEqual(C.fromTab('KYv|X---|').tracks, 0);
});
test('song tab round-trips every used pattern and the chain', function () {
  var s = C.presetSong(5), tab = C.toTab(s, 0, true), t = C.emptySong();
  assert.ok(/\n\[A\] 16 steps\n/.test(tab) && /\n\[C\] 16 steps\n/.test(tab));
  assert.ok(/\nchain: A A B C\n/.test(tab + '\n'));
  var parsed = C.fromTab(tab);
  assert.strictEqual(parsed.blocks.length, 3);
  var done = C.applyTab(t, parsed, 3);
  assert.deepStrictEqual(done, [0, 1, 2]);
  assert.deepStrictEqual(t.chain, [0, 0, 1, 2]);
  assert.strictEqual(row(t.pats[2], C.SN), row(s.pats[2], C.SN));
  assert.strictEqual(C.patternHits(t.pats[3]), 0);
});
test('tab import accepts common drum-tab dialects', function () {
  var txt = [
    'Some groove, 96 bpm',
    'HH|x-x-x-x-x-x-x-x-|',
    'SD|----o-------o---|',
    'BD|o-------o-o-----|',
    'CR|X---------------|',
    'Zz|x---|',
    'not a tab line',
    'B |x...|'
  ].join('\n');
  var r = C.fromTab(txt);
  assert.strictEqual(r.bpm, 96);
  assert.strictEqual(r.blocks.length, 1);
  assert.deepStrictEqual(r.unknown, ['ZZ']);
  var s = C.emptySong();
  C.applyTab(s, r, 1);
  var p = s.pats[1];
  assert.strictEqual(p.len, 16);
  assert.strictEqual(row(p, C.CH), 'x-x-x-x-x-x-x-x-');
  assert.strictEqual(row(p, C.SN), '----x-------x---');
  assert.strictEqual(row(p, C.KK), 'x---------------', 'a later row for the same track wins (B |x...|)');
  assert.strictEqual(row(p, C.OH), 'X---------------');
  // melodic rows: degrees, uppercase letter = accent, x = root
  r = C.fromTab('BS |1--5--a-|\nKY |x--C----|');
  s = C.emptySong(); C.applyTab(s, r, 0);
  assert.strictEqual(s.pats[0].len, 8);
  assert.deepStrictEqual([s.pats[0].n[C.BS][3], s.pats[0].n[C.BS][6], s.pats[0].v[C.BS][6]], [4, 9, 2]);
  assert.deepStrictEqual([s.pats[0].v[C.KY][0], s.pats[0].n[C.KY][0], s.pats[0].v[C.KY][3], s.pats[0].n[C.KY][3]], [2, 0, 3, 11]);
  assert.strictEqual(C.fromTab('hello\nworld').tracks, 0);
  assert.strictEqual(C.fromTab('').blocks.length, 0);
});

// ---- WAV ----------------------------------------------------------------------------
test('WAV encoder writes a valid 16-bit PCM file', function () {
  var sr = 44100, n = 1000, L = new Float32Array(n), R = new Float32Array(n);
  for (var i = 0; i < n; i++) { L[i] = Math.sin(i / 10); R[i] = -L[i] * 0.5; }
  L[0] = 2; L[1] = -2; L[2] = 1; L[3] = -1; R[0] = -0.5;
  var buf = C.encodeWAV([L, R], sr), info = C.wavInfo(buf);
  assert.strictEqual(buf.byteLength, 44 + n * 4);
  assert.deepStrictEqual(info, { channels: 2, sampleRate: sr, bits: 16, frames: n, dataBytes: n * 4, format: 1 });
  var v = new DataView(buf);
  assert.strictEqual(v.getInt16(44, true), 32767, 'clipped high');
  assert.strictEqual(v.getInt16(48, true), -32768, 'clipped low');
  assert.strictEqual(v.getInt16(46, true), Math.round(-1 * 0.5 * 0x8000), 'right channel interleaved');
  assert.strictEqual(v.getUint32(4, true), 36 + n * 4);
  assert.strictEqual(C.wavInfo(new ArrayBuffer(10)), null);
});
test('foldTail makes a seamless loop of exactly the loop length', function () {
  var a = new Float32Array([1, 2, 3, 4, 5, 6, 7]);
  var f = C.foldTail([a], 3)[0];
  assert.deepStrictEqual(Array.from(f), [1 + 4 + 7, 2 + 5, 3 + 6]);
  var bars = 2, bpm = 90, sr = 44100, loop = Math.round(bars * C.barDur(bpm) * sr);
  var r = C.foldTail([new Float32Array(loop + sr)], loop);
  assert.strictEqual(r[0].length, loop);
  assert.strictEqual(C.peak([new Float32Array([0.1, -0.7, 0.3])]).toFixed(1), '0.7');
});

console.log(passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
