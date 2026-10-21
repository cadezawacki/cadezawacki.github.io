/* Typewriter sounds ("typewriter" plugin) — optional key sounds while typing in
 * the editor. Off by default (Settings → Editor).
 *
 * Profiles, all synthesized here (no audio files):
 *   mechanical  a rounded "thock": a muted click, the bottom-out and a low body
 *               thump; space / Enter get the stabilizer's deeper thock.
 *   typewriter  a soft wooden strike with the type bar and a faint escapement
 *               tick, a heavier thunk for space, a carriage return (soft ratchet
 *               + slide + settle) for Enter, and a gentle chime when
 *               Enter is pressed at the end of a line or a line passes the
 *               72-character margin (once per line).
 *   soft        muted laptop-keyboard taps, quiet.
 * Normal keys, space, Enter, Backspace/Delete and paste each have their own
 * sound. Every sound is pre-rendered in a few variants (seeded noise + small
 * parameter changes) into AudioBuffers; a keystroke just plays one through a
 * gain with a little random pitch / level / timing so it never sounds like a
 * machine gun. At most 6 key voices (2 long ones: bell, carriage return) play
 * at once — the oldest is faded out — and auto-repeat is throttled.
 *
 * What triggers a sound: a keydown in the editor's own text (capture phase on
 * the editor, so the state is still the pre-keystroke one), classified by key;
 * not shortcuts, modifiers, navigation keys, IME keydowns (229 / Process) or
 * keys in inputs inside the editor/panels, and never while read-only. Input
 * that arrives without a classifiable keydown (Android soft keyboards, IME
 * commits, autocorrect) is picked up from the editor's own typing/deleting
 * transactions (userEvent input.type / delete.backward|forward|selection) —
 * each keydown sound leaves a short-lived "credit" that its transaction
 * consumes, so nothing double-fires. Paste / drop / cut play one soft sound
 * from the DOM event (widgets that insert text with userEvent input.paste
 * stay silent). Programmatic changes and sync carry no such userEvent.
 *
 * Lifecycle: nothing exists until the plugin is on AND the user types — the
 * first keystroke (a user gesture, which iOS requires) creates the
 * AudioContext ('interactive' latency) and renders the current profile's
 * buffers. A context that was suspended or 'interrupted' (iOS call, Siri) is
 * resumed by the next keystroke; that keystroke stays silent rather than
 * playing late. Nothing plays while document.hidden (and the context is
 * suspended then). Turning the plugin off (ViewPlugin destroy) stops every
 * voice, closes the AudioContext and drops the buffers.
 *
 * Settings: the core makes the on/off toggle (Preferences → Editor) from the
 * manifest. Style, volume and bell live in View → Widget preferences: the
 * manifest entry's "prefs" (= SCHEMA below) and Cade.prefs('typewriter'),
 * listened to live while the plugin is on. Values from the old Preferences
 * rows (cade-pref:typewriter.*) are moved over once.
 *
 * Debug/test hook: window.__cadeTypewriter.state() / .render(profile, kind,
 * sampleRate, variant). Pure synthesis + logic is exported for node tests. */
(function () {
  'use strict';

  // ---- pure core (node-testable; see typewriter.test.js) --------------------
  var CFG = {
    margin: 72,         // soft margin for the typewriter bell
    maxVoices: 6,       // key sounds playing at once
    maxLong: 2,         // bell / carriage return playing at once
    repeatMs: 75,       // auto-repeat: at most one sound per 75 ms
    minGapMs: 12,       // two sounds closer than this are one (double events)
    creditMs: 300,      // a keydown sound covers its transaction for this long
    variants: 4,        // pre-rendered variants per short sound
    longVariants: 2,    // … per long sound
    rate: 0.04,         // playback-rate jitter ±4 %
    gainLo: 0.85, gainHi: 1.1,   // level jitter
    delayMax: 0.003,    // start jitter, seconds
  };
  var PROFILES = ['mechanical', 'typewriter', 'soft'];
  // Widget preferences page — must equal the manifest entry's "prefs".
  var SCHEMA = {
    title: 'Typewriter sounds',
    fields: [
      { key: 'profile', type: 'radio', label: 'Style', default: 'typewriter',
        hint: 'Mechanical keyboard, a typewriter (carriage return and bell) or soft laptop taps',
        options: [{ value: 'mechanical', label: 'Mechanical' }, { value: 'typewriter', label: 'Typewriter' }, { value: 'soft', label: 'Soft' }] },
      { key: 'volume', type: 'slider', label: 'Volume', default: 50, min: 10, max: 100, step: 5, unit: '%' },
      { key: 'bell', type: 'toggle', label: 'Bell at end of line', default: true,
        hint: 'Typewriter style: a ding when you press Enter at the end of a line, and when a line passes ' + CFG.margin + ' characters' },
    ],
  };
  var KINDS = ['key', 'space', 'enter', 'back', 'paste', 'bell'];

  // Small fast seeded PRNG (mulberry32) — variants are reproducible.
  function prng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // RBJ biquad coefficients (normalised by a0).
  function biquad(type, f, q, sr) {
    var w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr;
    var c = Math.cos(w), al = Math.sin(w) / (2 * (q || 0.707));
    var b0, b1, b2;
    if (type === 'lowpass') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else if (type === 'highpass') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else { b0 = al; b1 = 0; b2 = -al; }                   // bandpass, 0 dB peak
    var a0 = 1 + al;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 };
  }
  function runFilter(x, k) {
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) {
      var x0 = x[i];
      var y0 = k.b0 * x0 + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0; x[i] = y0;
    }
    return x;
  }

  // Layers add into `out`. Envelope: linear attack `att` s, then exponential
  // decay with time constant `tau` s; each layer stops after ~7 tau (−60 dB).
  function layerLen(out, sr, at, att, tau) {
    var start = Math.round((at || 0) * sr);
    var a = Math.max(1, Math.round((att || 0.0005) * sr));
    return { start: start, att: a, len: Math.max(0, Math.min(out.length - start, a + Math.ceil(tau * sr * 7))) };
  }
  // Filtered noise. o: { at, f, q, type, tau, att, gain }
  function addNoise(out, sr, rnd, o) {
    var L = layerLen(out, sr, o.at, o.att, o.tau);
    if (L.len < 2) return;
    var b = new Float32Array(L.len), i;
    for (i = 0; i < L.len; i++) b[i] = rnd() * 2 - 1;
    runFilter(b, biquad(o.type || 'bandpass', o.f, o.q, sr));
    if (o.type2) runFilter(b, biquad(o.type2, o.f2 || o.f, o.q2 || 0.707, sr));
    var ss = 0;
    for (i = 0; i < L.len; i++) ss += b[i] * b[i];
    var rms = Math.sqrt(ss / L.len);
    if (!(rms > 1e-9)) return;
    var g = (o.gain == null ? 1 : o.gain) * 0.3 / rms, k = Math.exp(-1 / (o.tau * sr)), e = 1;
    for (i = 0; i < L.len; i++) {
      var env = i < L.att ? i / L.att : (e *= k);
      out[L.start + i] += b[i] * g * env;
    }
  }
  // Sine with an exponential pitch glide f → f1. o: { at, f, f1, glide, tau, att, gain }
  function addTone(out, sr, o) {
    var L = layerLen(out, sr, o.at, o.att, o.tau);
    var f1 = o.f1 == null ? o.f : o.f1, df = o.f - f1;
    var kg = o.glide ? Math.exp(-1 / (o.glide * sr)) : 0, gl = 1;
    var k = Math.exp(-1 / (o.tau * sr)), e = 1, ph = 0, w = 2 * Math.PI / sr, g = o.gain == null ? 1 : o.gain;
    for (var i = 0; i < L.len; i++) {
      ph += w * (f1 + df * gl); gl *= kg;
      var env = i < L.att ? i / L.att : (e *= k);
      out[L.start + i] += Math.sin(ph) * env * g;
    }
  }
  // Inharmonic partials of f0 (metal ticks, the bell). list: [ratio, amp, tau]
  function addPartials(out, sr, f0, list, o) {
    for (var i = 0; i < list.length; i++) {
      addTone(out, sr, { at: o.at, att: o.att, f: f0 * list[i][0], tau: list[i][2], gain: list[i][1] * (o.gain == null ? 1 : o.gain) });
    }
  }
  // 4 ms fade-out (no click when the buffer ends) and normalise to `peak`.
  function finish(out, sr, peak) {
    var n = Math.min(out.length, Math.round(0.004 * sr)), i, m = 0;
    for (i = 0; i < n; i++) out[out.length - 1 - i] *= i / n;
    for (i = 0; i < out.length; i++) { var a = Math.abs(out[i]); if (a > m) m = a; }
    if (m > 0) { var s = peak / m; for (i = 0; i < out.length; i++) out[i] *= s; }
    return out;
  }

  // ---- the sounds ------------------------------------------------------------
  // Tuned to be easy to listen to for a long time: no clangy inharmonic metal
  // partials, noise kept in the low-mids, a slightly rounded attack, and every
  // sound finally passed through a gentle low-pass (see WARM) — wood and felt
  // rather than steel.
  function mechanical(kind, sr, rnd, J) {
    var o, d;
    if (kind === 'key' || kind === 'back') {
      var back = kind === 'back';
      o = new Float32Array(Math.round(0.12 * sr));
      d = 0.004 + rnd() * 0.002;                          // switch bottoms out
      addNoise(o, sr, rnd, { f: (back ? 1700 : 2100) * J(0.1), q: 0.8, att: 0.0008, tau: 0.0025, gain: 1.1 });
      addNoise(o, sr, rnd, { at: d, type: 'lowpass', f: (back ? 900 : 1100) * J(0.1), q: 0.7, att: 0.0008, tau: back ? 0.006 : 0.007, gain: 0.8 });
      addTone(o, sr, { at: d, f: (back ? 185 : 215) * J(0.08), f1: back ? 135 : 150, glide: 0.01, tau: back ? 0.013 : 0.016, att: 0.0012, gain: 0.45 }); // "thock"
      addTone(o, sr, { at: d, f: 430 * J(0.08), tau: 0.008, att: 0.001, gain: 0.18 });   // case resonance
      return finish(o, sr, back ? 0.55 : 0.62);
    }
    if (kind === 'space' || kind === 'enter') {
      var ent = kind === 'enter';
      o = new Float32Array(Math.round(0.15 * sr));
      d = 0.0025 + rnd() * 0.0015;
      addNoise(o, sr, rnd, { type: 'lowpass', f: (ent ? 1300 : 1000) * J(0.1), q: 0.7, att: 0.001, tau: 0.004, gain: 1.2 });
      addNoise(o, sr, rnd, { at: d, type: 'lowpass', f: (ent ? 800 : 650) * J(0.1), q: 0.7, att: 0.001, tau: 0.011, gain: 0.7 });
      addTone(o, sr, { at: d, f: (ent ? 165 : 132) * J(0.06), f1: ent ? 112 : 95, glide: 0.015, tau: ent ? 0.022 : 0.026, att: 0.0015, gain: 0.75 });
      addNoise(o, sr, rnd, { at: d + 0.008 + rnd() * 0.004, f: 1500 * J(0.15), q: 0.8, att: 0.0006, tau: 0.002, gain: 0.12 }); // stabilizer
      return finish(o, sr, ent ? 0.72 : 0.7);
    }
    if (kind === 'paste') {
      o = new Float32Array(Math.round(0.12 * sr));
      addNoise(o, sr, rnd, { type: 'lowpass', f: 1300 * J(0.1), q: 0.7, att: 0.0015, tau: 0.008, gain: 0.8 });
      addTone(o, sr, { f: 170 * J(0.06), f1: 130, glide: 0.012, tau: 0.018, att: 0.002, gain: 0.6 });
      return finish(o, sr, 0.38);
    }
    return null;
  }

  function carriageReturn(sr, rnd, J) {
    var o = new Float32Array(Math.round(0.5 * sr)), i;
    addNoise(o, sr, rnd, { type: 'lowpass', f: 1400 * J(0.08), q: 0.7, att: 0.0008, tau: 0.004, gain: 0.6 });   // lever
    addTone(o, sr, { f: 260 * J(0.06), f1: 200, glide: 0.01, tau: 0.012, att: 0.001, gain: 0.3 });
    // Ratchet: soft wooden clicks, the gaps shrinking as the carriage speeds up.
    var n = 12 + Math.floor(rnd() * 4);
    for (i = 0; i < n; i++) {
      var t = 0.04 + 0.26 * Math.pow(i / (n - 1), 0.75);
      addNoise(o, sr, rnd, { at: t, f: 1600 * J(0.15), q: 0.9, att: 0.0006, tau: 0.0015, gain: 0.2 * J(0.3) });
    }
    addNoise(o, sr, rnd, { at: 0.03, type: 'lowpass', f: 800 * J(0.1), q: 0.6, att: 0.03, tau: 0.12, gain: 0.14 });   // slide
    var end = 0.31 + rnd() * 0.01;                        // carriage settles against the stop
    addTone(o, sr, { at: end, f: 105 * J(0.05), f1: 75, glide: 0.02, tau: 0.03, att: 0.0015, gain: 0.9 });
    addNoise(o, sr, rnd, { at: end, type: 'lowpass', f: 700, q: 0.7, att: 0.0008, tau: 0.012, gain: 0.6 });
    return finish(o, sr, 0.5);
  }

  // A soft chime (G6, near-harmonic partials, felt hammer) instead of a bright
  // brass ding; two partials a hair apart give it a slow, gentle shimmer.
  function bell(sr, rnd, J) {
    var o = new Float32Array(Math.round(1.3 * sr));
    var f0 = 1568 * J(0.005);
    addPartials(o, sr, f0, [[1, 1, 0.42], [1.0025, 0.45, 0.36], [2.0, 0.16, 0.16], [3.0, 0.05, 0.07]], { att: 0.0025 });
    addTone(o, sr, { f: f0 / 2, tau: 0.12, att: 0.003, gain: 0.18 });                             // warm body
    addNoise(o, sr, rnd, { type: 'lowpass', f: 2500, q: 0.7, att: 0.0008, tau: 0.0015, gain: 0.06 }); // felt hammer
    return finish(o, sr, 0.32);
  }

  function typewriter(kind, sr, rnd, J) {
    var o, d;
    if (kind === 'key') {
      o = new Float32Array(Math.round(0.12 * sr));
      addNoise(o, sr, rnd, { type: 'lowpass', f: 2000 * J(0.1), q: 0.7, att: 0.0008, tau: 0.0025, gain: 0.9 });   // strike
      addTone(o, sr, { f: 420 * J(0.06), f1: 300, glide: 0.006, tau: 0.012, att: 0.001, gain: 0.45 });             // wooden knock
      addTone(o, sr, { at: 0.0015, f: 220 * J(0.08), f1: 165, glide: 0.008, tau: 0.012, att: 0.001, gain: 0.4 });  // type bar
      addNoise(o, sr, rnd, { at: 0.001, type: 'lowpass', f: 900, q: 0.7, att: 0.0008, tau: 0.015, gain: 0.5 });    // platen
      d = 0.022 + rnd() * 0.006;                          // escapement advances
      addNoise(o, sr, rnd, { at: d, f: 1700 * J(0.1), q: 0.9, att: 0.0006, tau: 0.002, gain: 0.14 });
      return finish(o, sr, 0.62);
    }
    if (kind === 'space') {
      o = new Float32Array(Math.round(0.16 * sr));
      addNoise(o, sr, rnd, { type: 'lowpass', f: 520 * J(0.1), q: 0.7, att: 0.001, tau: 0.012, gain: 0.8 });
      addTone(o, sr, { f: 95 * J(0.06), f1: 68, glide: 0.02, tau: 0.032, att: 0.0015, gain: 1 });   // thunk
      addTone(o, sr, { f: 190 * J(0.06), f1: 145, glide: 0.01, tau: 0.016, att: 0.0012, gain: 0.5 });
      d = 0.018 + rnd() * 0.006;
      addNoise(o, sr, rnd, { at: d, f: 1300 * J(0.1), q: 0.9, att: 0.0006, tau: 0.002, gain: 0.1 });
      return finish(o, sr, 0.68);
    }
    if (kind === 'back') {                                // carriage pulled back a step
      o = new Float32Array(Math.round(0.12 * sr));
      addNoise(o, sr, rnd, { type: 'lowpass', f: 1300 * J(0.1), q: 0.7, att: 0.0008, tau: 0.003, gain: 0.8 });
      addTone(o, sr, { f: 330 * J(0.06), f1: 250, glide: 0.006, tau: 0.01, att: 0.001, gain: 0.3 });
      addTone(o, sr, { f: 150 * J(0.06), f1: 120, glide: 0.01, tau: 0.018, att: 0.0012, gain: 0.55 });
      addNoise(o, sr, rnd, { at: 0.012 + rnd() * 0.004, f: 1500 * J(0.1), q: 0.9, att: 0.0006, tau: 0.0018, gain: 0.15 });
      return finish(o, sr, 0.52);
    }
    if (kind === 'enter') return carriageReturn(sr, rnd, J);
    if (kind === 'paste') {
      o = new Float32Array(Math.round(0.12 * sr));
      addNoise(o, sr, rnd, { type: 'lowpass', f: 1200 * J(0.1), q: 0.7, att: 0.0012, tau: 0.01, gain: 0.7 });
      addTone(o, sr, { f: 200 * J(0.06), f1: 150, glide: 0.01, tau: 0.016, att: 0.0015, gain: 0.45 });
      return finish(o, sr, 0.36);
    }
    return null;
  }

  function soft(kind, sr, rnd, J) {
    var o;
    if (kind === 'key' || kind === 'back') {
      var back = kind === 'back';
      o = new Float32Array(Math.round(0.08 * sr));
      addNoise(o, sr, rnd, { type: 'lowpass', f: (back ? 1300 : 1600) * J(0.1), q: 0.7, att: 0.0012, tau: back ? 0.0025 : 0.003, gain: 0.7 });
      addTone(o, sr, { f: (back ? 255 : 300) * J(0.1), f1: back ? 205 : 230, glide: 0.006, tau: back ? 0.006 : 0.007, att: 0.0012, gain: 0.4 });
      addNoise(o, sr, rnd, { at: 0.002, type: 'lowpass', f: 700 * J(0.1), q: 0.7, att: 0.0008, tau: 0.005, gain: 0.35 });
      return finish(o, sr, back ? 0.26 : 0.28);
    }
    if (kind === 'space' || kind === 'enter') {
      var ent = kind === 'enter';
      o = new Float32Array(Math.round(0.1 * sr));
      addNoise(o, sr, rnd, { type: 'lowpass', f: (ent ? 1100 : 900) * J(0.1), q: 0.7, att: 0.0015, tau: 0.006, gain: 0.8 });
      addTone(o, sr, { f: (ent ? 200 : 170) * J(0.06), f1: ent ? 150 : 130, glide: 0.01, tau: 0.013, att: 0.0015, gain: 0.6 });
      return finish(o, sr, ent ? 0.34 : 0.32);
    }
    if (kind === 'paste') {
      o = new Float32Array(Math.round(0.1 * sr));
      addNoise(o, sr, rnd, { type: 'lowpass', f: 800 * J(0.1), q: 0.7, att: 0.0015, tau: 0.008, gain: 0.8 });
      addTone(o, sr, { f: 180 * J(0.06), tau: 0.01, att: 0.0015, gain: 0.5 });
      return finish(o, sr, 0.18);
    }
    return null;
  }
  // The final gentle low-pass per profile (Hz): takes the edge off everything.
  var WARM = { mechanical: 3200, typewriter: 2800, soft: 2000, bell: 5200 };
  function warm(out, sr, f) {
    if (!out || !(f < sr / 2.2)) return out;
    var peak = 0, i;
    for (i = 0; i < out.length; i++) { var a = Math.abs(out[i]); if (a > peak) peak = a; }
    runFilter(out, biquad('lowpass', f, 0.6, sr));
    var m = 0;
    for (i = 0; i < out.length; i++) { var b = Math.abs(out[i]); if (b > m) m = b; }
    if (m > 0 && peak > 0) { var k = Math.min(1, peak / m); for (i = 0; i < out.length; i++) out[i] *= k; }
    return out;
  }

  // synth(profile, kind, sampleRate, variant) -> Float32Array (mono, |x| <= 1).
  // The bell is the same for every profile (only the typewriter rings it).
  function synth(profile, kind, sr, variant) {
    sr = sr || 48000;
    var seed = ((variant | 0) + 1) * 2654435761 + (PROFILES.indexOf(profile) + 1) * 97 + (KINDS.indexOf(kind) + 1) * 7919;
    var rnd = prng(seed);
    var J = function (a) { return 1 + (rnd() * 2 - 1) * a; };
    if (kind === 'bell') return warm(bell(sr, rnd, J), sr, WARM.bell);
    var out = profile === 'typewriter' ? typewriter(kind, sr, rnd, J) : profile === 'soft' ? soft(kind, sr, rnd, J) : mechanical(kind, sr, rnd, J);
    return warm(out, sr, WARM[profile] || WARM.mechanical);
  }
  function isLong(profile, kind) { return kind === 'bell' || (profile === 'typewriter' && kind === 'enter'); }
  function variantsFor(profile, kind) { return isLong(profile, kind) ? CFG.longVariants : CFG.variants; }

  // Per-keystroke variation: { rate, gain, delay (s) }.
  function jitter(rnd) {
    return {
      rate: 1 + (rnd() * 2 - 1) * CFG.rate,
      gain: CFG.gainLo + rnd() * (CFG.gainHi - CFG.gainLo),
      delay: rnd() * CFG.delayMax,
    };
  }
  // Volume setting (10–100 %) -> master gain; a little curved so the low end
  // is usable.
  function volumeGain(pct) {
    var v = Math.max(0, Math.min(100, Number(pct)));
    if (!(v >= 0)) v = 50;
    return Math.pow(v / 100, 1.5);
  }

  // Keydown -> 'key' | 'space' | 'enter' | 'back' | null (no sound).
  // e: { key, keyCode, ctrlKey, metaKey, altKey, isComposing, altGraph }
  var SILENT_KEYS = /^(Shift|Control|Alt|AltGraph|Meta|OS|Hyper|Super|CapsLock|NumLock|ScrollLock|Fn|FnLock|Escape|Esc|Arrow\w+|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|ContextMenu|Pause|PrintScreen|F\d{1,2}|Dead|Process|Unidentified|Compose|Media\w+|Audio\w+|Volume\w+|Browser\w+|Launch\w+)$/;
  function classifyKey(e) {
    if (!e || e.isComposing || e.keyCode === 229) return null;
    var k = e.key;
    if (typeof k !== 'string' || !k || SILENT_KEYS.test(k)) return null;
    if ((e.ctrlKey || e.metaKey) && !e.altGraph) return null;       // shortcuts
    if (k === 'Enter') return 'enter';
    if (k === 'Backspace' || k === 'Delete') return 'back';
    if (k === ' ' || k === 'Spacebar' || k === 'Tab') return 'space';
    return k.length <= 2 ? 'key' : null;                  // one character (astral = 2 units)
  }
  // A typing transaction that arrived without a keydown sound.
  // ev: the matched userEvent; ins: inserted text; del: deleted length.
  var ENTER_INS = /^\n[ \t]*(?:[-*+>] |\d+[.)] |[-*+] \[[ xX]\] )?$/;
  function classifyChange(ev, ins, del) {
    if (ev === 'input.type' || ev === 'input.type.compose') {
      if (ins.indexOf('\n') >= 0) return 'enter';
      if (/[ \t]$/.test(ins)) return 'space';
      if (ins.length) return 'key';
      return del > 0 ? 'back' : null;
    }
    if (ev === 'delete.backward' || ev === 'delete.forward' || ev === 'delete.selection') return 'back';
    if (ev === 'input') return ENTER_INS.test(ins) ? 'enter' : null;   // the Enter command (others' 'input' = widgets)
    return null;
  }

  // Sound throttle: drops near-duplicates and thins auto-repeat.
  function makeThrottle(cfg) {
    cfg = cfg || CFG;
    var last = -1e9, lastRep = -1e9;
    return {
      admit: function (now, repeat) {
        if (now - last < cfg.minGapMs) return false;
        if (repeat && now - lastRep < cfg.repeatMs) return false;
        last = now; if (repeat) lastRep = now;
        return true;
      },
    };
  }
  // Voice pool: add(now, end, voice) returns the voices to steal (oldest first)
  // so that at most `cap` play at once; finished ones are pruned first.
  function makePool(cap) {
    var list = [];
    return {
      add: function (now, end, v) {
        list = list.filter(function (x) { return x.end > now; });
        var stolen = [];
        while (list.length >= cap) stolen.push(list.shift().v);
        list.push({ end: end, v: v });
        return stolen;
      },
      remove: function (v) { list = list.filter(function (x) { return x.v !== v; }); },
      size: function (now) { return list.filter(function (x) { return now == null || x.end > now; }).length; },
      all: function () { return list.map(function (x) { return x.v; }); },
      clear: function () { list = []; },
    };
  }
  // Margin bell: rings when a line grows past the margin, once per line (the
  // line is remembered by its start, mapped through later edits).
  function makeMarginBell(margin) {
    var rung = -1;
    return {
      map: function (fn) { if (rung >= 0) rung = fn(rung); },
      check: function (lineFrom, before, after) {
        if (!(before < margin && after >= margin) || lineFrom === rung) return false;
        rung = lineFrom;
        return true;
      },
      reset: function () { rung = -1; },
    };
  }
  // Credits: each keydown sound leaves one; the transaction it causes takes it.
  function makeCredits(ms) {
    var q = [];
    return {
      give: function (now) { q.push(now); if (q.length > 4) q.shift(); },
      take: function (now) {
        while (q.length && now - q[0] > ms) q.shift();
        if (!q.length) return false;
        q.shift(); return true;
      },
    };
  }

  var api = {
    CFG: CFG, PROFILES: PROFILES, KINDS: KINDS, prng: prng, synth: synth, isLong: isLong, variantsFor: variantsFor,
    SCHEMA: SCHEMA, jitter: jitter, volumeGain: volumeGain, classifyKey: classifyKey, classifyChange: classifyChange,
    makeThrottle: makeThrottle, makePool: makePool, makeMarginBell: makeMarginBell, makeCredits: makeCredits,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ---- runtime ---------------------------------------------------------------
  var Cade = window.Cade, CM = Cade.CM;
  if (!CM || !CM.ViewPlugin) return;

  var conf = { profile: 'typewriter', volume: 50, bell: true };
  var S = {
    refs: 0, stopT: 0, ctx: null, master: null, born: 0, bufs: {}, prerT: 0,
    pool: makePool(CFG.maxVoices), longPool: makePool(CFG.maxLong),
    throttle: makeThrottle(), credits: makeCredits(CFG.creditMs), margin: makeMarginBell(CFG.margin),
    rnd: Math.random, prefsOff: null, visOn: false,
    played: 0, kinds: {}, lastKind: null, contexts: 0,
  };
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  // ---- preferences (Widget preferences page "typewriter") ----------------------
  function prefsOf(id, fields) {
    if (Cade.prefs) return Cade.prefs(id);
    var d = {}; fields.forEach(function (f) { if (f.key) d[f.key] = f.default; });
    return { get: function (k) { return d[k]; }, all: function () { var o = {}; for (var k in d) o[k] = d[k]; return o; }, set: function (k, v) { d[k] = v; }, on: function () { return function () {}; } };
  }
  var P = prefsOf('typewriter', SCHEMA.fields);
  // One-time move of the values set in the old Preferences rows.
  (function migrate() {
    var st = Cade.store;
    if (!st || !Cade.prefs) return;
    ['profile', 'volume', 'bell'].forEach(function (k) {
      var old = 'cade-pref:typewriter.' + k, v = st.get(old);
      if (v == null) return;
      try { P.set(k, k === 'volume' ? Number(v) : k === 'bell' ? String(v) === 'true' : v); } catch (e) {}
      st.remove(old);
    });
  })();
  function applyPref(key, v) {
    if (key === 'profile') {
      var p = PROFILES.indexOf(v) >= 0 ? v : 'typewriter';
      if (p !== conf.profile) { conf.profile = p; if (S.ctx) schedulePrerender(); }
    } else if (key === 'volume') {
      conf.volume = Math.max(10, Math.min(100, Number(v) || 50));
      if (S.master) { try { S.master.gain.setTargetAtTime(volumeGain(conf.volume), S.ctx.currentTime, 0.01); } catch (e) {} }
    } else if (key === 'bell') conf.bell = v !== false;
  }
  function loadPrefs() {
    var all = P.all() || {};
    ['profile', 'volume', 'bell'].forEach(function (k) { if (k in all) applyPref(k, all[k]); });
  }
  loadPrefs();

  // ---- audio -------------------------------------------------------------------
  function ensureCtx() {
    if (S.ctx && S.ctx.state !== 'closed') return S.ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    var ctx;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ctx = new AC(); } catch (e2) { return null; } }
    S.ctx = ctx; S.born = now(); S.bufs = {}; S.contexts++;
    S.pool.clear(); S.longPool.clear();
    S.master = ctx.createGain();
    S.master.gain.value = volumeGain(conf.volume);
    S.master.connect(ctx.destination);
    if (!S.visOn) { document.addEventListener('visibilitychange', onVis); S.visOn = true; }
    schedulePrerender();
    return ctx;
  }
  function onVis() {
    // Hidden: stop the audio hardware; the next keystroke resumes it.
    if (document.hidden && S.ctx && S.ctx.state === 'running') { try { S.ctx.suspend(); } catch (e) {} }
  }
  function buffer(kind, idx) {
    var key = conf.profile + ':' + kind, list = S.bufs[key];
    if (!list) list = S.bufs[key] = [];
    if (!list[idx]) {
      var sr = S.ctx.sampleRate, data = synth(conf.profile, kind, sr, idx);
      var b = S.ctx.createBuffer(1, data.length, sr);
      if (b.copyToChannel) b.copyToChannel(data, 0); else b.getChannelData(0).set(data);
      list[idx] = b;
    }
    return list[idx];
  }
  // Render the rest of the current profile after the first keystroke, one
  // buffer per tick (each ≤ a few ms) so typing never stalls; a keystroke
  // that needs a missing buffer renders just that one.
  function schedulePrerender() {
    clearTimeout(S.prerT);
    var keep = {}, todo = [];
    KINDS.forEach(function (k) {
      if (k === 'bell' && conf.profile !== 'typewriter') return;
      keep[conf.profile + ':' + k] = 1;
      for (var i = 0; i < variantsFor(conf.profile, k); i++) todo.push([k, i]);
    });
    Object.keys(S.bufs).forEach(function (k) { if (!keep[k]) delete S.bufs[k]; });
    var step = function () {
      S.prerT = 0;
      if (!S.ctx || !todo.length) return;
      var t = todo.shift();
      buffer(t[0], t[1]);
      S.prerT = setTimeout(step, 16);
    };
    S.prerT = setTimeout(step, 40);
  }
  function stopVoice(v, t) {
    try { v.g.gain.setTargetAtTime(0, t, 0.004); v.src.stop(t + 0.03); } catch (e) {}
  }
  function fire(kind) {
    var ctx = S.ctx, long = isLong(conf.profile, kind);
    var b = buffer(kind, Math.floor(S.rnd() * variantsFor(conf.profile, kind)));
    var j = jitter(S.rnd), t = ctx.currentTime + j.delay;
    var src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = b;
    src.playbackRate.value = kind === 'bell' ? 1 + (j.rate - 1) * 0.25 : j.rate;
    g.gain.value = j.gain;
    src.connect(g); g.connect(S.master);
    var v = { src: src, g: g }, pool = long ? S.longPool : S.pool;
    pool.add(t, t + b.duration / src.playbackRate.value, v).forEach(function (o) { stopVoice(o, ctx.currentTime); });
    src.onended = function () { pool.remove(v); try { g.disconnect(); } catch (e) {} };
    src.start(t);
    S.played++; S.lastKind = kind; S.kinds[kind] = (S.kinds[kind] || 0) + 1;
  }
  // Play `kind` for a keystroke; `repeat` = keyboard auto-repeat.
  function play(kind, repeat) {
    if (document.hidden) return false;
    if (kind !== 'bell' && !S.throttle.admit(now(), !!repeat)) return false;
    var fresh = !S.ctx || S.ctx.state === 'closed';
    var ctx = ensureCtx();
    if (!ctx) return false;
    if (ctx.state !== 'running') {
      try { var p = ctx.resume(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
      // A brand-new context: start the sound inside the gesture (that's what
      // unlocks iOS). A suspended/interrupted one: stay silent rather than
      // queue sounds that would all play late on resume.
      if (!fresh && now() - S.born > 500) return false;
    }
    try { fire(kind); } catch (e) { console.error('typewriter: play failed', e); return false; }
    return true;
  }
  function wantBell() { return conf.bell && conf.profile === 'typewriter'; }
  function atLineEnd(state) {
    var sel = state.selection.main;
    if (!sel.empty) return false;
    var line = state.doc.lineAt(sel.head);
    return line.length > 0 && sel.head === line.to;
  }

  function release() {
    S.stopT = 0;
    clearTimeout(S.prerT); S.prerT = 0;
    if (S.visOn) { document.removeEventListener('visibilitychange', onVis); S.visOn = false; }
    if (S.ctx) {
      var ctx = S.ctx;
      S.pool.all().concat(S.longPool.all()).forEach(function (v) { try { v.src.onended = null; v.src.stop(); } catch (e) {} });
      try { var p = ctx.close(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    }
    S.ctx = null; S.master = null; S.bufs = {};
    S.pool.clear(); S.longPool.clear(); S.margin.reset();
    if (S.prefsOff) { S.prefsOff(); S.prefsOff = null; }
  }

  // ---- the editor side ----------------------------------------------------------
  function editable(view) {
    if (view.state.readOnly) return false;
    try { if (CM.EditorView && CM.EditorView.editable && !view.state.facet(CM.EditorView.editable)) return false; } catch (e) {}
    return true;
  }
  // The event comes from the editor's own text (not an input inside a widget
  // or a CodeMirror panel).
  function inText(view, t) {
    if (!t || !view.contentDOM.contains(t)) return false;
    var tag = t.nodeType === 1 ? t.tagName : '';
    return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
  }
  // The transaction's userEvent, narrowed to what classifyChange knows. Plain
  // 'input' must match exactly (subtypes like input.paste / input.snippet are
  // widgets and commands, not typing), so read the annotation itself.
  var TYPING = ['input.type.compose', 'input.type', 'delete.backward', 'delete.forward', 'delete.selection'];
  function typingEvent(tr) {
    for (var k = 0; k < TYPING.length; k++) if (tr.isUserEvent(TYPING[k])) return TYPING[k];
    var UE = tr.constructor && tr.constructor.userEvent;
    return UE && tr.annotation(UE) === 'input' ? 'input' : null;
  }

  function attach(view) {
    var onKey = function (e) {
      if (!inText(view, e.target) || !editable(view)) return;
      var kind = classifyKey({
        key: e.key, keyCode: e.keyCode, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.isComposing,
        altGraph: e.getModifierState ? e.getModifierState('AltGraph') : false,
      });
      if (!kind) return;
      var bellToo = kind === 'enter' && wantBell() && !e.repeat && atLineEnd(view.state);
      // The credit is given even when the sound was throttled, so the
      // keystroke's own transaction can't sneak a sound past the throttle.
      S.credits.give(now());
      if (play(kind, e.repeat) && bellToo) play('bell');
    };
    var onPaste = function (e) {
      if (!inText(view, e.target) || !editable(view)) return;
      play('paste');
    };
    var dom = view.dom;
    dom.addEventListener('keydown', onKey, true);
    dom.addEventListener('paste', onPaste, true);
    dom.addEventListener('drop', onPaste, true);
    dom.addEventListener('cut', onPaste, true);
    return function () {
      dom.removeEventListener('keydown', onKey, true);
      dom.removeEventListener('paste', onPaste, true);
      dom.removeEventListener('drop', onPaste, true);
      dom.removeEventListener('cut', onPaste, true);
    };
  }

  function onUpdate(u) {
    if (!u.docChanged) return;
    for (var i = 0; i < u.transactions.length; i++) {
      var tr = u.transactions[i];
      if (!tr.docChanged) continue;
      S.margin.map(function (p) { return tr.changes.mapPos(p, -1); });
      var ev = typingEvent(tr);
      if (!ev) continue;
      var ins = '', del = 0;
      tr.changes.iterChanges(function (fa, ta, fb, tb, text) { ins += text.toString(); del += ta - fa; });
      var kind = classifyChange(ev, ins, del);
      if (!kind) continue;
      var t = now();
      if (!S.credits.take(t) && !document.hidden) {
        // No keydown sound covered this one (soft keyboard / IME / autocorrect).
        if (play(kind, false) && kind === 'enter' && wantBell() && atLineEnd(tr.startState)) play('bell');
      }
      if ((kind === 'key' || kind === 'space') && wantBell() && ev.indexOf('input.type') === 0) {
        var before = tr.startState.doc.lineAt(tr.startState.selection.main.head).length;
        var line = tr.state.doc.lineAt(tr.state.selection.main.head);
        if (S.margin.check(line.from, before, line.length)) play('bell');
      }
    }
  }

  window.__cadeTypewriter = {
    state: function () {
      return {
        active: S.refs > 0, ctx: !!S.ctx, ctxState: S.ctx ? S.ctx.state : null, contexts: S.contexts,
        played: S.played, kinds: JSON.parse(JSON.stringify(S.kinds)), lastKind: S.lastKind,
        voices: S.pool.size(S.ctx ? S.ctx.currentTime : null), profile: conf.profile, volume: conf.volume, bell: conf.bell,
        buffers: Object.keys(S.bufs).reduce(function (n, k) { return n + S.bufs[k].filter(Boolean).length; }, 0),
      };
    },
    render: function (profile, kind, sr, variant) { return synth(profile, kind, sr, variant); },
  };

  var plugin = CM.ViewPlugin.define(function (view) {
    S.refs++;
    clearTimeout(S.stopT); S.stopT = 0;
    if (!S.prefsOff) { loadPrefs(); S.prefsOff = P.on(applyPref); }   // live changes while on
    var detach = attach(view);
    return {
      update: onUpdate,
      destroy: function () {
        detach();
        // Deferred: a room switch rebuilds the plugin at once; only a real
        // "off" leaves refs at 0 when the timer fires.
        if (--S.refs <= 0) { S.refs = 0; clearTimeout(S.stopT); S.stopT = setTimeout(release, 0); }
      },
    };
  });
  Cade.registerPlugin({ id: 'typewriter', ext: plugin });
})();
