/* Checks for Typewriter sounds: the synthesized sample arrays (length, no NaN,
 * no clipping, envelopes, profiles that really differ), per-keystroke
 * variation bounds, the throttle / voice cap, the once-per-line margin bell,
 * key and transaction classification, and the plugin registration. Not loaded
 * by the app. Run: node txt/widgets/typewriter/typewriter.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var T = require('./typewriter.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

// The manifest entry this module needs (proposed; the manifest doesn't list it yet).
var MANIFEST = {
  id: 'typewriter',
  type: 'plugin',
  name: 'Typewriter sounds',
  description: 'Plays a short key sound as you type in the editor — mechanical keyboard, typewriter (carriage return and bell) or soft laptop taps. Off unless you turn it on; once on, its style, volume and bell options appear in this section',
  entry: 'widgets/typewriter/typewriter.js',
  settingKey: 'plugins.typewriter',
  section: 'Editor',
  default: false,
};

var SR = 48000;
function peak(x) { var m = 0; for (var i = 0; i < x.length; i++) { var a = Math.abs(x[i]); if (a > m) m = a; } return m; }
function ms(n) { return n / SR * 1000; }
function attackMs(x) { var m = peak(x), i = 0; while (Math.abs(x[i]) < m * 0.5) i++; return ms(i); }
// Time after which the signal stays below `frac` of its peak.
function tailMs(x, frac) { var m = peak(x), i = x.length - 1; while (i > 0 && Math.abs(x[i]) < m * frac) i--; return ms(i); }
function energy(x) { var s = 0; for (var i = 0; i < x.length; i++) s += x[i] * x[i]; return s; }
// Spectral centroid (Hz) of the first 2048 samples, by plain DFT.
function centroid(x) {
  var N = 2048, num = 0, den = 0;
  for (var k = 1; k < N / 2; k += 2) {
    var re = 0, im = 0;
    for (var n = 0; n < N && n < x.length; n++) { var w = 2 * Math.PI * k * n / N; re += x[n] * Math.cos(w); im -= x[n] * Math.sin(w); }
    var mag = Math.sqrt(re * re + im * im);
    num += mag * k * SR / N; den += mag;
  }
  return num / den;
}
// Share of energy (first 4096 samples) between lo and hi Hz, by plain DFT.
function bandShare(x, lo, hi) {
  var N = 4096, inB = 0, all = 0;
  for (var k = 1; k < N / 2; k++) {
    var re = 0, im = 0;
    for (var n = 0; n < N && n < x.length; n++) { var w = 2 * Math.PI * k * n / N; re += x[n] * Math.cos(w); im -= x[n] * Math.sin(w); }
    var f = k * SR / N, p = re * re + im * im;
    all += p; if (f >= lo && f < hi) inB += p;
  }
  return inB / all;
}
// RMS per 5 ms frame.
function envelope(x) { var f = Math.round(0.005 * SR), out = []; for (var i = 0; i + f <= x.length; i += f) { var s = 0; for (var j = i; j < i + f; j++) s += x[j] * x[j]; out.push(Math.sqrt(s / f)); } return out; }

test('every profile × kind × variant: finite, peak ≤ 1, sensible length', function () {
  T.PROFILES.forEach(function (p) {
    T.KINDS.forEach(function (k) {
      for (var v = 0; v < T.variantsFor(p, k); v++) {
        var x = T.synth(p, k, SR, v);
        assert.ok(x instanceof Float32Array && x.length > 0, p + ' ' + k);
        for (var i = 0; i < x.length; i++) if (!isFinite(x[i])) throw new Error('non-finite sample in ' + p + ' ' + k + ' @' + i);
        var m = peak(x);
        assert.ok(m <= 1 && m > 0.1, p + ' ' + k + ' peak ' + m);
        var len = ms(x.length);
        if (k === 'bell') assert.ok(len >= 1000 && len <= 1500, 'bell ' + len);
        else if (T.isLong(p, k)) assert.ok(len >= 300 && len <= 600, 'return ' + len);
        else assert.ok(len >= 60 && len <= 170, p + ' ' + k + ' ' + len);
        assert.ok(Math.abs(x[x.length - 1]) < 1e-3, 'ends silent ' + p + ' ' + k);
      }
    });
  });
});

test('other sample rates give proportional lengths', function () {
  assert.strictEqual(T.synth('mechanical', 'key', 44100, 0).length, Math.round(0.12 * 44100));
  assert.strictEqual(T.synth('typewriter', 'bell', 44100, 0).length, Math.round(1.3 * 44100));
});

test('deterministic per variant, different across variants', function () {
  var a = T.synth('typewriter', 'key', SR, 1), b = T.synth('typewriter', 'key', SR, 1), c = T.synth('typewriter', 'key', SR, 2);
  assert.deepStrictEqual(Array.from(a.slice(0, 200)), Array.from(b.slice(0, 200)));
  var diff = 0; for (var i = 0; i < a.length; i++) diff += Math.abs(a[i] - c[i]);
  assert.ok(diff > 1, 'variants differ');
});

test('envelopes: fast attack, key sounds die out within ~150 ms, bell rings ~1 s', function () {
  T.PROFILES.forEach(function (p) {
    ['key', 'space', 'back', 'paste'].concat(p === 'typewriter' ? [] : ['enter']).forEach(function (k) {
      var x = T.synth(p, k, SR, 0);
      assert.ok(attackMs(x) < 3, p + ' ' + k + ' attack ' + attackMs(x));
      var t40 = tailMs(x, 0.01);
      assert.ok(t40 < 150, p + ' ' + k + ' −40 dB at ' + t40);
    });
  });
  var bell = T.synth('typewriter', 'bell', SR, 0);
  assert.ok(attackMs(bell) < 3);
  var env = envelope(bell);
  assert.ok(env[Math.round(500 / 5)] > env[1] * 0.08, 'still ringing at 0.5 s');     // > −22 dB
  assert.ok(tailMs(bell, 0.03) > 800, 'audible past 0.8 s');
  assert.ok(tailMs(bell, 0.01) < 1300, 'below −40 dB before the end');
  // carriage return: the first transient (lever) is immediate, the end thunk lands ~0.3 s later
  var ret = T.synth('typewriter', 'enter', SR, 0);
  var i = 0; while (Math.abs(ret[i]) < peak(ret) * 0.2) i++;
  assert.ok(ms(i) < 3, 'lever click at once');
  var pk = 0; for (i = 0; i < ret.length; i++) if (Math.abs(ret[i]) === peak(ret)) { pk = i; break; }
  assert.ok(ms(pk) > 250 && ms(pk) < 380, 'end thunk at ' + ms(pk));
});

test('profiles sound different: brightness and loudness', function () {
  var c = {}, e = {};
  T.PROFILES.forEach(function (p) { var x = T.synth(p, 'key', SR, 0); c[p] = centroid(x); e[p] = energy(x); });
  assert.ok(c.typewriter > c.soft * 1.3, 'typewriter brighter than soft ' + JSON.stringify(c));
  assert.ok(c.mechanical > c.soft * 1.2, 'mechanical brighter than soft ' + JSON.stringify(c));
  // typewriter: metallic strike puts far more of its energy above 3 kHz
  var hi = {}; T.PROFILES.forEach(function (p) { hi[p] = bandShare(T.synth(p, 'key', SR, 0), 3000, 24000); });
  assert.ok(hi.typewriter > hi.mechanical * 2 && hi.typewriter > hi.soft * 4, 'treble share ' + JSON.stringify(hi));
  // envelope shape: mechanical peaks at the bottom-out (a few ms in), typewriter at the strike
  var pkMs = function (x) { var e = envelope(x), m = 0; for (var i = 1; i < e.length; i++) if (e[i] > e[m]) m = i; return m * 5; };
  assert.ok(pkMs(T.synth('mechanical', 'key', SR, 0)) >= 5 && pkMs(T.synth('typewriter', 'key', SR, 0)) === 0);
  assert.ok(e.soft < e.mechanical * 0.4 && e.soft < e.typewriter * 0.4, 'soft is quiet ' + JSON.stringify(e));
  // the typewriter space bar is a heavier, darker thunk than its keys
  assert.ok(centroid(T.synth('typewriter', 'space', SR, 0)) < c.typewriter * 0.6);
  // each kind is its own sound within a profile
  T.PROFILES.forEach(function (p) {
    var k = T.synth(p, 'key', SR, 0), b = T.synth(p, 'back', SR, 0), s = T.synth(p, 'space', SR, 0);
    assert.ok(Math.abs(centroid(k) - centroid(b)) > 80 || Math.abs(energy(k) - energy(b)) > energy(k) * 0.15, p + ' key vs back');
    assert.ok(Math.abs(centroid(k) - centroid(s)) > 150, p + ' key vs space');
  });
  // the bell is tonal and high
  var bc = centroid(T.synth('typewriter', 'bell', SR, 0));
  assert.ok(bc > 2000 && bc < 5000, 'bell centroid ' + bc);
});

test('per-keystroke variation stays within bounds', function () {
  var r = T.prng(42), lo = { rate: 9, gain: 9, delay: 9 }, hi = { rate: 0, gain: 0, delay: 0 };
  for (var i = 0; i < 5000; i++) {
    var j = T.jitter(r);
    ['rate', 'gain', 'delay'].forEach(function (k) { lo[k] = Math.min(lo[k], j[k]); hi[k] = Math.max(hi[k], j[k]); });
  }
  assert.ok(lo.rate >= 0.96 && hi.rate <= 1.04 && hi.rate - lo.rate > 0.06, 'rate ' + lo.rate + '..' + hi.rate);
  assert.ok(lo.gain >= 0.85 && hi.gain <= 1.1 && hi.gain - lo.gain > 0.2, 'gain');
  assert.ok(lo.delay >= 0 && hi.delay <= 0.003, 'delay');
  // worst case level: loudest buffer × top jitter stays under full scale
  var maxPeak = 0;
  T.PROFILES.forEach(function (p) { T.KINDS.forEach(function (k) { maxPeak = Math.max(maxPeak, peak(T.synth(p, k, SR, 0))); }); });
  assert.ok(maxPeak * T.CFG.gainHi * T.volumeGain(100) <= 1, 'no clipping at 100 %');
});

test('volume curve', function () {
  assert.strictEqual(T.volumeGain(100), 1);
  assert.ok(T.volumeGain(10) > 0.02 && T.volumeGain(10) < 0.05);
  assert.ok(T.volumeGain(50) > T.volumeGain(40));
  assert.strictEqual(T.volumeGain(500), 1);
  assert.strictEqual(T.volumeGain('abc'), T.volumeGain(50));
});

test('throttle: duplicates dropped, auto-repeat thinned, normal fast typing passes', function () {
  var th = T.makeThrottle();
  assert.ok(th.admit(1000, false));
  assert.ok(!th.admit(1005, false), 'double event');
  assert.ok(th.admit(1040, false), '25 keys/s still fine');
  // auto-repeat at 30 ms for 1 s -> about one sound per 75 ms
  var n = 0;
  for (var t = 2000; t < 3000; t += 30) if (th.admit(t, true)) n++;
  assert.ok(n >= 11 && n <= 15, 'repeat sounds ' + n);
});

test('voice pool: never more than the cap, oldest stolen first, finished ones pruned', function () {
  var pool = T.makePool(6), stolen = [];
  for (var i = 0; i < 10; i++) stolen = stolen.concat(pool.add(i * 0.01, i * 0.01 + 0.12, 'v' + i));
  assert.strictEqual(pool.size(), 6);
  assert.deepStrictEqual(stolen, ['v0', 'v1', 'v2', 'v3']);
  // much later: all ended, nothing stolen
  assert.deepStrictEqual(pool.add(5, 5.1, 'late'), []);
  assert.strictEqual(pool.size(), 1);
  pool.remove('late');
  assert.strictEqual(pool.size(), 0);
  assert.strictEqual(T.CFG.maxVoices, 6);
});

test('margin bell: once per line when it passes 72', function () {
  var b = T.makeMarginBell(72);
  assert.ok(!b.check(0, 70, 71));
  assert.ok(b.check(0, 71, 72), 'crosses');
  assert.ok(!b.check(0, 72, 73), 'already past');
  assert.ok(!b.check(0, 71, 72), 'back below and over again: same line, no second ring');
  assert.ok(b.check(100, 71, 72), 'next line rings');
  // the remembered line start moves with edits above it
  b.map(function (p) { return p + 5; });
  assert.ok(!b.check(105, 71, 72));
  assert.ok(b.check(0, 71, 72), 'other line');
  b.reset();
  assert.ok(b.check(0, 71, 72));
  assert.ok(!T.makeMarginBell(72).check(0, 60, 65));
  assert.ok(T.makeMarginBell(72).check(0, 60, 90), 'paste-like jump still crosses');
});

test('keydown classification', function () {
  var C = function (key, more) { var e = { key: key }; for (var k in more) e[k] = more[k]; return T.classifyKey(e); };
  assert.strictEqual(C('a'), 'key');
  assert.strictEqual(C('Z', { shiftKey: true }), 'key');
  assert.strictEqual(C('7'), 'key');
  assert.strictEqual(C('é'), 'key');
  assert.strictEqual(C('😀'), 'key');
  assert.strictEqual(C('∂', { altKey: true }), 'key', 'Mac option chars type');
  assert.strictEqual(C(' '), 'space');
  assert.strictEqual(C('Tab'), 'space');
  assert.strictEqual(C('Enter'), 'enter');
  assert.strictEqual(C('Enter', { shiftKey: true }), 'enter');
  assert.strictEqual(C('Backspace'), 'back');
  assert.strictEqual(C('Delete'), 'back');
  ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Escape', 'ArrowLeft', 'ArrowDown', 'Home', 'End', 'PageUp', 'F5', 'Dead', 'Process', 'Unidentified', 'AudioVolumeUp', 'MediaPlayPause', ''].forEach(function (k) {
    assert.strictEqual(C(k), null, k);
  });
  assert.strictEqual(C('s', { ctrlKey: true }), null, 'shortcut');
  assert.strictEqual(C('z', { metaKey: true }), null, 'shortcut');
  assert.strictEqual(C('Enter', { ctrlKey: true }), null);
  assert.strictEqual(C('@', { ctrlKey: true, altKey: true, altGraph: true }), 'key', 'AltGr characters type');
  assert.strictEqual(C('a', { isComposing: true }), null, 'IME composing');
  assert.strictEqual(C('a', { keyCode: 229 }), null, 'IME / Android 229');
  assert.strictEqual(T.classifyKey(null), null);
});

test('transaction classification (input without a keydown)', function () {
  var C = T.classifyChange;
  assert.strictEqual(C('input.type', 'a', 0), 'key');
  assert.strictEqual(C('input.type', 'the ', 3), 'space', 'autocorrect + space');
  assert.strictEqual(C('input.type', '\n', 0), 'enter');
  assert.strictEqual(C('input.type.compose', 'か', 1), 'key');
  assert.strictEqual(C('input.type', '', 1), 'back');
  assert.strictEqual(C('delete.backward', '', 1), 'back');
  assert.strictEqual(C('delete.forward', '', 1), 'back');
  assert.strictEqual(C('delete.selection', '', 5), 'back');
  assert.strictEqual(C('input', '\n', 0), 'enter', 'the Enter command');
  assert.strictEqual(C('input', '\n  - ', 0), 'enter', 'list continuation');
  assert.strictEqual(C('input', '\n2. ', 0), 'enter');
  assert.strictEqual(C('input', '\n- [ ] ', 0), 'enter');
  assert.strictEqual(C('input', '12:30', 0), null, 'a widget inserting text');
  assert.strictEqual(C('input', '\nsome text', 0), null);
  assert.strictEqual(C('input.paste', 'x', 0), null, 'paste is the DOM event\'s job');
  assert.strictEqual(C('delete.cut', '', 4), null);
  assert.strictEqual(C(null, 'x', 0), null, 'programmatic / sync');
});

test('credits: a keydown sound covers exactly one transaction, briefly', function () {
  var c = T.makeCredits(300);
  assert.ok(!c.take(0));
  c.give(100);
  assert.ok(c.take(120));
  assert.ok(!c.take(130), 'used up');
  c.give(200);
  assert.ok(!c.take(600), 'expired');
  c.give(1000); c.give(1010);
  assert.ok(c.take(1020) && c.take(1030) && !c.take(1040));
});

test('manifest entry + plugin registration (no audio until typing)', function () {
  var man = MANIFEST;
  assert.strictEqual(man.type, 'plugin');
  assert.strictEqual(man.settingKey, 'plugins.typewriter');
  assert.strictEqual(man.section, 'Editor');
  assert.strictEqual(man.default, false);
  assert.strictEqual(man.name, 'Typewriter sounds');
  assert.ok(/Off unless you turn it on/.test(man.description));
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', man.entry)), 'entry exists');
  var plug = null, settings = [], touched = [];
  var trap = function (what) { return function () { touched.push(what); }; };
  var fake = {
    Cade: {
      baseURL: function () { return './txt/widgets/typewriter/'; },
      loadCSS: trap('loadCSS'),
      registerPlugin: function (o) { plug = o; },
      registerSetting: function (d) { settings.push(d); if (d.apply) d.apply(d.default); },
      CM: { ViewPlugin: { define: function (f) { return { __vp: f }; } }, EditorView: {} },
    },
    AudioContext: trap('AudioContext'), webkitAudioContext: trap('webkitAudioContext'),
    addEventListener: trap('addEventListener'), setTimeout: trap('setTimeout'),
  };
  var doc = { addEventListener: trap('document.addEventListener'), createElement: trap('createElement'), head: { appendChild: trap('appendChild') } };
  new Function('window', 'module', 'document', fs.readFileSync(path.join(__dirname, 'typewriter.js'), 'utf8'))(fake, undefined, doc);
  assert.ok(plug, 'registered');
  assert.strictEqual(plug.id, man.id);
  assert.ok(plug.ext && plug.ext.__vp, 'lifetime tied to an editor ViewPlugin');
  assert.deepStrictEqual(touched, [], 'no AudioContext, listeners or DOM until the plugin starts and the user types');
  assert.deepStrictEqual(settings.map(function (d) { return d.key; }), ['typewriter.profile', 'typewriter.volume', 'typewriter.bell']);
  settings.forEach(function (d) {
    assert.strictEqual(d.section, 'Editor');
    assert.ok(/^Typewriter sounds: /.test(d.label), d.label);
    assert.ok(['select', 'toggle'].indexOf(d.type) >= 0);
  });
  assert.deepStrictEqual(settings[0].options.map(function (o) { return o.value; }), ['mechanical', 'typewriter', 'soft']);
  assert.deepStrictEqual(settings[1].options.map(function (o) { return o.value; }), ['10', '20', '30', '40', '50', '60', '70', '80', '90', '100']);
  assert.ok(fake.__cadeTypewriter && typeof fake.__cadeTypewriter.state === 'function', 'debug hook');
  assert.strictEqual(fake.__cadeTypewriter.state().ctx, false);
});
console.log((process.exitCode ? 'FAILED, ' : '') + 'typewriter: ' + passed + ' passed');
