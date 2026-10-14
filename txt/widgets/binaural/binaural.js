/* Binaural Beats — a brainwave-beat generator for Cade.txt.
 *
 * Two sine tones a few hertz apart, one per ear (binaural), both in both ears
 * (monaural) or one tone pulsed on and off (isochronic — no headphones
 * needed). About forty presets in seven groups (sleep, relax, meditate, focus,
 * energy, journeys, tones), plus a custom mixer: beat and carrier frequency,
 * mode, tone level, a background noise bed (white, pink, brown, rain, ocean),
 * journeys that glide the beat from one band to another over minutes, fade
 * in / out, a sleep timer and saved presets of your own.
 *
 * Two outputs:
 *  · Live — Web Audio oscillators. Every change glides in real time and
 *    journeys ramp smoothly on the audio clock.
 *  · Loop — a seamless 60-second recording (rendered here, no samples) played
 *    through an <audio> element, which iPhone keeps playing with the screen
 *    locked and shows on the lock screen. A journey steps its loop as it goes.
 *
 * Cost: nothing runs until the panel opens and nothing makes sound until Play.
 * The AudioContext is made on the first Play (iOS needs a tap) and suspended
 * while paused. A one-second UI tick runs only while playing and the page is
 * visible. Closing the panel stops everything, closes the AudioContext and
 * frees the loop. Minimize (–) parks it in the footer, still playing, as a
 * chip with the beat and time left.
 *
 * The preset table, beat / envelope maths and the loop + WAV renderer (Core)
 * are DOM-free and unit-tested: node txt/widgets/binaural/binaural.test.js
 */
(function () {
  'use strict';

  // =========================================================================
  // Core — pure model + maths. No DOM, no Web Audio, no Cade.
  // =========================================================================
  var Core = (function () {
    var LIM = { carrier: [40, 1000], beat: [0.5, 45], pathMins: 180, fadeIn: 120, fadeOut: 300 };
    var MODES = ['binaural', 'monaural', 'iso'];
    var MODE_NAMES = { binaural: 'Binaural', monaural: 'Monaural', iso: 'Isochronic' };
    var NOISES = ['off', 'white', 'pink', 'brown', 'rain', 'ocean'];
    var NOISE_NAMES = { off: 'None', white: 'White', pink: 'Pink', brown: 'Brown', rain: 'Rain', ocean: 'Ocean' };
    var TONE_GAIN = 0.5;          // per-ear sine peak at tone = 1, volume = 1
    var NOISE_RMS = 0.18;         // noise beds are normalized to this RMS before nvol / volume
    var LOOP_SECS = 60, LOOP_SR = 22050;
    var TIMERS = [0, 10, 15, 20, 25, 30, 45, 60, 90, 120, 180];   // minutes (0 = no timer)

    var BANDS = [
      { id: 'delta', sym: 'δ', name: 'Delta', lo: 0.5, hi: 4, feel: 'deep sleep' },
      { id: 'theta', sym: 'θ', name: 'Theta', lo: 4, hi: 8, feel: 'meditation · drowsy · dreamy' },
      { id: 'alpha', sym: 'α', name: 'Alpha', lo: 8, hi: 13, feel: 'relaxed · calm focus' },
      { id: 'beta', sym: 'β', name: 'Beta', lo: 13, hi: 30, feel: 'alert · active focus' },
      { id: 'gamma', sym: 'γ', name: 'Gamma', lo: 30, hi: 45, feel: 'high focus · 40 Hz' }
    ];
    function band(hz) {
      for (var i = 0; i < BANDS.length - 1; i++) if (hz < BANDS[i].hi) return BANDS[i];
      return BANDS[BANDS.length - 1];
    }

    var GROUPS = [
      { id: 'sleep', name: 'Sleep' }, { id: 'relax', name: 'Relax' }, { id: 'meditate', name: 'Meditate' },
      { id: 'focus', name: 'Focus' }, { id: 'energy', name: 'Energy' }, { id: 'journey', name: 'Journeys' },
      { id: 'tones', name: 'Tones' }, { id: 'mine', name: 'Mine' }
    ];
    // Presets. beat / carrier in Hz; path = [[minute, beat Hz], …] glides the
    // beat (first point at 0); mins = a suggested sleep timer.
    var PRESETS = [
      { id: 'deep-sleep', group: 'sleep', name: 'Deep Sleep', beat: 2, carrier: 100, noise: 'brown', nvol: 0.3, mins: 60, fadeOut: 60, desc: 'Slow delta for deep, dreamless sleep' },
      { id: 'sleep', group: 'sleep', name: 'Sleep', beat: 3, carrier: 150, noise: 'pink', nvol: 0.2, mins: 45, fadeOut: 60, desc: 'Gentle delta to settle into sleep' },
      { id: 'night-ocean', group: 'sleep', name: 'Night Ocean', beat: 2.5, carrier: 110, noise: 'ocean', nvol: 0.45, mins: 60, fadeOut: 60, desc: 'Delta under slow ocean swells' },
      { id: 'rain-sleep', group: 'sleep', name: 'Rain & Delta', beat: 1.5, carrier: 120, noise: 'rain', nvol: 0.4, mins: 60, fadeOut: 60, desc: 'Very slow delta behind steady rain' },
      { id: 'dream', group: 'sleep', name: 'Dream State', beat: 5, carrier: 180, noise: 'pink', nvol: 0.15, desc: 'Low theta — the drowsy, dreamy edge of sleep' },

      { id: 'calm', group: 'relax', name: 'Calm', beat: 10, carrier: 200, desc: 'Classic alpha for relaxed, easy calm' },
      { id: 'unwind', group: 'relax', name: 'Unwind', beat: 8.5, carrier: 180, noise: 'pink', nvol: 0.2, desc: 'Low alpha to loosen up after work' },
      { id: 'decompress', group: 'relax', name: 'Decompress', beat: 9, carrier: 160, noise: 'ocean', nvol: 0.35, desc: 'Alpha with waves for winding down stress' },
      { id: 'schumann', group: 'relax', name: 'Schumann 7.83', beat: 7.83, carrier: 136.1, desc: "Earth's resonance on the Om carrier (136.1 Hz)" },
      { id: 'reading', group: 'relax', name: 'Light Reading', beat: 11, carrier: 220, desc: 'Upper alpha — calm but awake' },
      { id: 'rainy', group: 'relax', name: 'Rainy Window', beat: 8, carrier: 190, noise: 'rain', nvol: 0.35, desc: 'Soft alpha with rain on the glass' },

      { id: 'meditation', group: 'meditate', name: 'Meditation', beat: 6, carrier: 150, desc: 'Theta for settled, inward attention' },
      { id: 'deep-med', group: 'meditate', name: 'Deep Meditation', beat: 4.5, carrier: 136.1, noise: 'brown', nvol: 0.2, desc: 'Low theta on the Om tone' },
      { id: 'mindful', group: 'meditate', name: 'Mindfulness', beat: 7, carrier: 174, desc: 'High theta, open awareness' },
      { id: 'creative', group: 'meditate', name: 'Creative Flow', beat: 7.5, carrier: 210, desc: 'The alpha–theta border, loose and imaginative' },
      { id: 'breath', group: 'meditate', name: 'Breath & Stretch', beat: 8, carrier: 160, noise: 'ocean', nvol: 0.3, desc: 'Low alpha with a slow swell to breathe with' },

      { id: 'focus', group: 'focus', name: 'Focus', beat: 14, carrier: 220, noise: 'pink', nvol: 0.15, desc: 'Low beta for steady concentration' },
      { id: 'deep-work', group: 'focus', name: 'Deep Work', beat: 16, carrier: 250, noise: 'brown', nvol: 0.35, desc: 'Beta + brown noise to shut out the room' },
      { id: 'study', group: 'focus', name: 'Study (SMR)', beat: 13, carrier: 200, desc: 'Sensorimotor rhythm — calm, alert learning' },
      { id: 'coding', group: 'focus', name: 'Coding', beat: 15, carrier: 240, noise: 'brown', nvol: 0.4, desc: 'Beta over brown noise, the classic coding mix' },
      { id: 'problem', group: 'focus', name: 'Problem Solving', beat: 18, carrier: 260, desc: 'Mid beta for analytical work' },
      { id: 'gamma', group: 'focus', name: 'Gamma 40 Hz', beat: 40, carrier: 400, desc: '40 Hz gamma for peak focus' },
      { id: 'gamma-pulse', group: 'focus', name: '40 Hz Pulse', beat: 40, carrier: 300, mode: 'iso', tone: 0.5, desc: 'Isochronic 40 Hz — works on speakers' },

      { id: 'wake', group: 'energy', name: 'Wake Up', beat: 20, carrier: 250, desc: 'High beta to shake off grogginess' },
      { id: 'morning', group: 'energy', name: 'Morning Boost', beat: 18, carrier: 300, noise: 'pink', nvol: 0.15, desc: 'Bright beta to start the day' },
      { id: 'workout', group: 'energy', name: 'Workout', beat: 25, carrier: 300, desc: 'Fast beta for movement and energy' },
      { id: 'alert-pulse', group: 'energy', name: 'Alert Pulse', beat: 18, carrier: 280, mode: 'iso', tone: 0.5, desc: 'Isochronic beta — no headphones needed' },

      { id: 'wind-down', group: 'journey', name: 'Wind Down', carrier: 180, noise: 'pink', nvol: 0.2, path: [[0, 14], [20, 6]], mins: 30, desc: 'Beta → theta over 20 min, then hold' },
      { id: 'drift-off', group: 'journey', name: 'Drift Off', carrier: 140, noise: 'brown', nvol: 0.3, path: [[0, 10], [15, 5], [35, 2]], mins: 60, fadeOut: 90, desc: 'Alpha → theta → delta for falling asleep' },
      { id: 'power-nap', group: 'journey', name: 'Power Nap', carrier: 180, path: [[0, 10], [5, 4], [18, 4], [25, 14]], mins: 25, fadeOut: 10, desc: 'Sink to theta, rest, rise to beta to wake' },
      { id: 'wake-gently', group: 'journey', name: 'Wake Gently', carrier: 200, path: [[0, 3], [10, 8], [20, 16]], mins: 25, fadeIn: 60, desc: 'Delta → alpha → beta over 20 min' },
      { id: 'focus-ramp', group: 'journey', name: 'Focus Ramp', carrier: 230, noise: 'brown', nvol: 0.25, path: [[0, 10], [8, 15]], desc: 'Ease from alpha into focused beta' },
      { id: 'med-descent', group: 'journey', name: 'Meditation Descent', carrier: 136.1, path: [[0, 10], [10, 6], [20, 4.5]], mins: 30, desc: 'Alpha → theta → deep theta' },

      { id: 'hz174', group: 'tones', name: '174 Hz', beat: 3, carrier: 174, desc: 'Solfeggio 174 Hz carrier · delta' },
      { id: 'hz396', group: 'tones', name: '396 Hz', beat: 6, carrier: 396, desc: 'Solfeggio 396 Hz carrier · theta' },
      { id: 'hz432', group: 'tones', name: '432 Hz', beat: 10, carrier: 432, desc: '432 Hz tuning carrier · alpha' },
      { id: 'hz528', group: 'tones', name: '528 Hz', beat: 8, carrier: 528, desc: 'Solfeggio 528 Hz carrier · alpha' },
      { id: 'hz639', group: 'tones', name: '639 Hz', beat: 10, carrier: 639, desc: 'Solfeggio 639 Hz carrier · alpha' },
      { id: 'hz852', group: 'tones', name: '852 Hz', beat: 7, carrier: 852, desc: 'Solfeggio 852 Hz carrier · theta' }
    ];
    var BY_ID = {};
    PRESETS.forEach(function (p) { BY_ID[p.id] = p; });

    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
    function num(v, d) { v = typeof v === 'string' && v.trim() === '' ? NaN : +v; return isFinite(v) ? v : d; }
    function r2(v) { return Math.round(v * 100) / 100; }

    // Journey points → [[minute, hz], …] sorted, first at minute 0, 2–8 points; null if not a journey.
    function normPath(p, beat) {
      if (!Array.isArray(p)) return null;
      var pts = [];
      p.forEach(function (q) {
        if (!Array.isArray(q) || q.length < 2) return;
        var m = num(q[0], NaN), hz = num(q[1], NaN);
        if (!isFinite(m) || !isFinite(hz)) return;
        pts.push([r2(clamp(m, 0, LIM.pathMins)), r2(clamp(hz, LIM.beat[0], LIM.beat[1]))]);
      });
      pts.sort(function (a, b) { return a[0] - b[0]; });
      var out = [];
      pts.forEach(function (q) { if (out.length && out[out.length - 1][0] === q[0]) out[out.length - 1] = q; else out.push(q); });
      if (out.length && out[0][0] > 0) out.unshift([0, beat != null ? beat : out[0][1]]);
      if (out.length > 8) out = out.slice(0, 8);
      return out.length >= 2 ? out : null;
    }
    function normalizeCfg(o) {
      o = o && typeof o === 'object' && !Array.isArray(o) ? o : {};
      var beat = r2(clamp(num(o.beat, 10), LIM.beat[0], LIM.beat[1]));
      var c = {
        id: typeof o.id === 'string' ? o.id.slice(0, 40) : '',
        name: (typeof o.name === 'string' && o.name.trim() ? o.name.trim() : 'Custom').slice(0, 40),
        carrier: r2(clamp(num(o.carrier, 200), LIM.carrier[0], LIM.carrier[1])),
        beat: beat,
        mode: MODES.indexOf(o.mode) >= 0 ? o.mode : 'binaural',
        tone: r2(clamp(num(o.tone, 0.6), 0, 1)),
        noise: NOISES.indexOf(o.noise) >= 0 ? o.noise : 'off',
        nvol: r2(clamp(num(o.nvol, 0.3), 0, 1)),
        path: normPath(o.path, beat),
        fadeIn: Math.round(clamp(num(o.fadeIn, 10), 0, LIM.fadeIn)),
        fadeOut: Math.round(clamp(num(o.fadeOut, 30), 0, LIM.fadeOut))
      };
      if (c.path) c.beat = c.path[0][1];
      return c;
    }
    function presetCfg(id) {
      var p = BY_ID[id];
      if (!p) return null;
      var c = normalizeCfg({ id: p.id, name: p.name, beat: p.beat != null ? p.beat : (p.path ? p.path[0][1] : 10), carrier: p.carrier, mode: p.mode, tone: p.tone,
        noise: p.noise, nvol: p.nvol != null ? p.nvol : 0.3, path: p.path, fadeIn: p.fadeIn, fadeOut: p.fadeOut });
      return c;
    }
    // Same sound? (ids and names aside) — used to tell an edited preset from the original.
    function sameSound(a, b) {
      if (!a || !b) return false;
      var k = ['carrier', 'beat', 'mode', 'tone', 'noise', 'nvol', 'fadeIn', 'fadeOut'];
      for (var i = 0; i < k.length; i++) if (a[k[i]] !== b[k[i]]) return false;
      return JSON.stringify(a.path) === JSON.stringify(b.path);
    }

    // ---- time: beat along a journey, the envelope (fade in, timer fade out) ----
    function pathSecs(cfg) { return cfg.path ? cfg.path[cfg.path.length - 1][0] * 60 : 0; }
    function beatAt(cfg, sec) {
      var p = cfg.path;
      if (!p) return cfg.beat;
      var m = sec / 60;
      if (!(m > p[0][0])) return p[0][1];
      for (var i = 1; i < p.length; i++) {
        if (m <= p[i][0]) {
          var a = p[i - 1], b = p[i], f = b[0] > a[0] ? (m - a[0]) / (b[0] - a[0]) : 1;
          return a[1] + (b[1] - a[1]) * f;
        }
      }
      return p[p.length - 1][1];
    }
    // Upcoming journey points after `sec` as [[sec, hz], …].
    function pathAfter(cfg, sec) {
      if (!cfg.path) return [];
      return cfg.path.map(function (q) { return [q[0] * 60, q[1]]; }).filter(function (q) { return q[0] > sec; });
    }
    // Ear / pulse frequencies at a beat: left = carrier, right = carrier + beat;
    // isochronic is one tone at the carrier pulsed at the beat.
    function freqs(cfg, beat) {
      if (cfg.mode === 'iso') return { l: cfg.carrier, r: cfg.carrier, pulse: beat };
      return { l: cfg.carrier, r: cfg.carrier + beat, pulse: 0 };
    }
    function fades(cfg, T) {
      var fi = cfg.fadeIn, fo = cfg.fadeOut;
      if (T > 0) { fi = Math.min(fi, T / 3); fo = Math.min(fo, T / 3); }
      return { fi: fi, fo: fo };
    }
    // Envelope 0..1 at session second `sec` with a timer of T seconds (0 = none).
    // skipIn: the session restarted while already audible (a preset switch) — no fade in.
    function envAt(cfg, sec, T, skipIn) {
      var f = fades(cfg, T), v = 1;
      if (!skipIn && f.fi > 0) v = Math.min(1, Math.max(0, sec) / f.fi);
      if (T > 0) {
        if (sec >= T) return 0;
        if (f.fo > 0 && sec > T - f.fo) v = Math.min(v, (T - sec) / f.fo);
      }
      return clamp(v, 0, 1);
    }
    // Breakpoints of the envelope from `sec` on: [[sec, value], …] joined by linear ramps.
    function envPlan(cfg, sec, T, skipIn) {
      var f = fades(cfg, T), pts = [[sec, envAt(cfg, sec, T, skipIn)]];
      if (!skipIn && f.fi > 0 && sec < f.fi) pts.push([f.fi, 1]);
      if (T > 0) {
        if (f.fo > 0 && sec < T - f.fo) pts.push([T - f.fo, envAt(cfg, T - f.fo, T, skipIn)]);
        if (sec < T) pts.push([T, 0]);
      }
      return pts;
    }

    // ---- formatting / slider maps ----
    function fmtHz(v) { return String(r2(v)); }
    function fmtClock(s) {
      s = Math.max(0, Math.floor(s));
      var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
      return (h ? h + ':' + (m < 10 ? '0' : '') + m : m) + ':' + (ss < 10 ? '0' : '') + ss;
    }
    function pathLabel(cfg) {
      if (!cfg.path) return '';
      return cfg.path.map(function (q) { return fmtHz(q[1]); }).join(' → ') + ' Hz · ' + cfg.path[cfg.path.length - 1][0] + ' min';
    }
    // Log-scale slider: position 0..1000 ↔ value lo..hi.
    function toPos(v, lo, hi) { return Math.round(1000 * Math.log(clamp(v, lo, hi) / lo) / Math.log(hi / lo)); }
    function fromPos(x, lo, hi) { return lo * Math.pow(hi / lo, clamp(+x || 0, 0, 1000) / 1000); }
    function snapBeat(v) { var s = v < 10 ? 0.1 : v < 20 ? 0.5 : 1; return r2(clamp(Math.round(v / s) * s, LIM.beat[0], LIM.beat[1])); }
    function snapCarrier(v) { var s = v < 300 ? 1 : 5; return clamp(Math.round(v / s) * s, LIM.carrier[0], LIM.carrier[1]); }

    // ---- isochronic pulse: a smoothed square wave (odd harmonics, Lanczos σ) ----
    var PULSE_H = [1, 3, 5, 7, 9, 11];
    function pulseCoefs() {
      var n = PULSE_H[PULSE_H.length - 1] + 1, real = new Float32Array(n + 1), imag = new Float32Array(n + 1);
      PULSE_H.forEach(function (k) { var x = Math.PI * k / (n + 2); imag[k] = 4 / (Math.PI * k) * (Math.sin(x) / x); });
      return { real: real, imag: imag };
    }
    var PULSE_TAB = null;
    // Pulse table: 1024 samples of one period, peak-normalized to ±1 (as a PeriodicWave is).
    function pulseTable() {
      if (PULSE_TAB) return PULSE_TAB;
      var c = pulseCoefs(), N = 1024, t = new Float32Array(N), mx = 0, i, k;
      for (i = 0; i < N; i++) {
        var s = 0;
        for (k = 1; k < c.imag.length; k++) if (c.imag[k]) s += c.imag[k] * Math.sin(2 * Math.PI * k * i / N);
        t[i] = s; if (Math.abs(s) > mx) mx = Math.abs(s);
      }
      for (i = 0; i < N; i++) t[i] /= mx;
      return (PULSE_TAB = t);
    }

    // ---- noise beds (seamless loops) ----
    function rng(seed) {   // mulberry32
      var a = seed >>> 0;
      return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        var t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    // One channel of `kind` noise, n samples long, normalized to NOISE_RMS; its
    // tail is cross-faded (equal power) into its head so it loops without a seam.
    function noiseBuf(kind, sr, n, rnd) {
      rnd = rnd || Math.random;
      var x = Math.max(1, Math.min(Math.floor(n / 4), Math.round(sr * 0.75))), m = n + x, raw = new Float32Array(m);
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0, hpY = 0, hpX = 0, lp = 0;
      var hpA = 1 / (1 + 2 * Math.PI * 500 / sr), lpA = 1 - Math.exp(-2 * Math.PI * 7000 / sr);
      var warm = Math.min(4096, n), i;
      for (i = -warm; i < m; i++) {
        var w = rnd() * 2 - 1, v;
        if (kind === 'white') v = w;
        else if (kind === 'brown' || kind === 'ocean') { br = (br + 0.02 * w) / 1.02; v = br * 3.5; }
        else {
          b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
          v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
          if (kind === 'rain') { hpY = hpA * (hpY + v - hpX); hpX = v; lp += lpA * (hpY - lp); v = lp; }
        }
        if (i >= 0) raw[i] = v;
      }
      var mean = 0;
      for (i = 0; i < m; i++) mean += raw[i];
      mean /= m;
      var out = new Float32Array(n);
      for (i = 0; i < n; i++) out[i] = raw[i] - mean;
      for (i = 0; i < x; i++) { var f = i / x; out[i] = out[i] * Math.sqrt(f) + (raw[n + i] - mean) * Math.sqrt(1 - f); }
      var ss = 0;
      for (i = 0; i < n; i++) ss += out[i] * out[i];
      var g = ss > 0 ? NOISE_RMS / Math.sqrt(ss / n) : 0;
      for (i = 0; i < n; i++) out[i] *= g;
      return out;
    }
    // Ocean swell gain at time t (s) for a swell period P (s): 0.3 … 1.
    function swell(t, P) { return 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t / P)); }
    function swellPeriod(secs) { return secs / Math.max(1, Math.round(secs / 10)); }

    // ---- the lock-screen loop: render `secs` seconds that repeat seamlessly ----
    // Frequencies are rounded to whole cycles per loop (1/60 Hz steps), so every
    // tone ends exactly where it began; noise beds are cross-faded loops.
    function loopFreqs(cfg, beat, secs) {
      var fr = freqs(cfg, beat), q = function (f) { return Math.max(1, Math.round(f * secs)) / secs; };
      return { l: q(fr.l), r: q(fr.r), pulse: fr.pulse ? q(fr.pulse) : 0 };
    }
    function synthLoop(cfg, o) {
      o = o || {};
      var sr = o.sr || LOOP_SR, secs = o.secs || LOOP_SECS, n = Math.round(sr * secs), vol = o.vol != null ? o.vol : 1;
      var beat = o.beat != null ? o.beat : cfg.beat, fq = loopFreqs(cfg, beat, secs);
      var L = new Float32Array(n), R = new Float32Array(n), A = TONE_GAIN * cfg.tone * vol, i, t;
      var wl = 2 * Math.PI * fq.l / sr, wr = 2 * Math.PI * fq.r / sr;
      if (A > 0) {
        if (cfg.mode === 'binaural') {
          for (i = 0; i < n; i++) { L[i] = A * Math.sin(wl * i); R[i] = A * Math.sin(wr * i); }
        } else if (cfg.mode === 'monaural') {
          for (i = 0; i < n; i++) L[i] = R[i] = A * 0.5 * (Math.sin(wl * i) + Math.sin(wr * i));
        } else {
          var tab = pulseTable(), N = tab.length, pp = fq.pulse / sr;
          for (i = 0; i < n; i++) {
            var ph = (i * pp) % 1, p = tab[Math.floor(ph * N) % N];
            L[i] = R[i] = A * Math.sin(wl * i) * (0.5 + 0.5 * p);
          }
        }
      }
      if (cfg.noise !== 'off' && cfg.nvol > 0) {
        var rnd = o.rnd || Math.random, nL = noiseBuf(cfg.noise, sr, n, rnd), nR = noiseBuf(cfg.noise, sr, n, rnd);
        var g = cfg.nvol * vol, P = swellPeriod(secs), oc = cfg.noise === 'ocean';
        for (i = 0; i < n; i++) {
          t = oc ? g * swell(i / sr, P) : g;
          L[i] += nL[i] * t; R[i] += nR[i] * t;
        }
      }
      for (i = 0; i < n; i++) { L[i] = clamp(L[i], -1, 1); R[i] = clamp(R[i], -1, 1); }
      return { chans: [L, R], sr: sr, freqs: fq };
    }
    // 16-bit PCM WAV (little-endian).
    function encodeWAV(chans, sr) {
      var nc = chans.length, n = chans[0].length, bytes = n * nc * 2;
      var buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
      function s4(off, s) { for (var j = 0; j < 4; j++) v.setUint8(off + j, s.charCodeAt(j)); }
      s4(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); s4(8, 'WAVE');
      s4(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
      v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
      s4(36, 'data'); v.setUint32(40, bytes, true);
      var pcm = new Int16Array(buf, 44, n * nc);
      for (var i = 0, o = 0; i < n; i++) {
        for (var c = 0; c < nc; c++, o++) {
          var x = chans[c][i];
          x = x < -1 ? -1 : x > 1 ? 1 : x;
          pcm[o] = x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff);
        }
      }
      return buf;
    }

    // ---- saved presets ("Mine") ----
    function normalizeMine(list) {
      if (!Array.isArray(list)) return [];
      var out = [], seen = {};
      list.forEach(function (o) {
        if (!o || typeof o !== 'object' || out.length >= 60) return;
        var c = normalizeCfg(o);
        if (!/^mine-/.test(c.id) || seen[c.id]) c.id = 'mine-' + out.length + '-' + Math.floor(Math.random() * 1e6).toString(36);
        seen[c.id] = 1;
        out.push(c);
      });
      return out;
    }

    return {
      LIM: LIM, MODES: MODES, MODE_NAMES: MODE_NAMES, NOISES: NOISES, NOISE_NAMES: NOISE_NAMES, BANDS: BANDS, GROUPS: GROUPS,
      PRESETS: PRESETS, TIMERS: TIMERS, TONE_GAIN: TONE_GAIN, NOISE_RMS: NOISE_RMS, LOOP_SECS: LOOP_SECS, LOOP_SR: LOOP_SR,
      band: band, clamp: clamp, normPath: normPath, normalizeCfg: normalizeCfg, presetCfg: presetCfg, preset: function (id) { return BY_ID[id] || null; },
      sameSound: sameSound, pathSecs: pathSecs, beatAt: beatAt, pathAfter: pathAfter, freqs: freqs, envAt: envAt, envPlan: envPlan,
      fmtHz: fmtHz, fmtClock: fmtClock, pathLabel: pathLabel, toPos: toPos, fromPos: fromPos, snapBeat: snapBeat, snapCarrier: snapCarrier,
      pulseCoefs: pulseCoefs, pulseTable: pulseTable, rng: rng, noiseBuf: noiseBuf, swell: swell, swellPeriod: swellPeriod,
      loopFreqs: loopFreqs, synthLoop: synthLoop, encodeWAV: encodeWAV, normalizeMine: normalizeMine
    };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('binaural.css');

  var PANEL_ID = 'binaural-panel';
  var K_STATE = 'cade-binaural', K_MINE = 'cade-binaural-mine';
  var AC = window.AudioContext || window.webkitAudioContext;
  var NAV = window.navigator || {};
  var IS_IOS = /iP(hone|ad|od)/.test(NAV.userAgent || '') || (NAV.platform === 'MacIntel' && NAV.maxTouchPoints > 1);
  var GLIDE = 1.2, SLIDE = 0.12;            // seconds: preset switch / slider drag
  var BAND_HZ = { delta: 2, theta: 6, alpha: 10, beta: 18, gamma: 40 };
  var ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" fill="currentColor"/></svg>';
  var ICON_STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor"/></svg>';
  var SILENT_URL = null;

  function esc(s) { return Cade.escapeHtml(String(s)); }
  function noop() {}
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 1800); } catch (e) {} }
  function nowMs() { return window.performance && performance.now ? performance.now() : Date.now(); }
  function loadJSON(k) { try { var s = Cade.store.get(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function saveJSON(k, o) { try { Cade.store.set(k, JSON.stringify(o)); } catch (e) {} }
  function timerLabel(m) { return m ? (m < 60 ? m + ' min' : (m / 60) + ' h') : 'Off'; }

  // =========================================================================
  // Widget state (only while the panel is open)
  // =========================================================================
  var P = null;
  function q(sel) { return P ? P.el.querySelector(sel) : null; }
  function isMin() { return !!(P && Cade.isMinimized && Cade.isMinimized(P.el)); }
  function gainOf(v) { return v * v; }                     // volume slider → gain (perceptual)
  function findCfg(id) {
    if (!id) return null;
    if (/^mine-/.test(id)) { for (var i = 0; i < P.mine.length; i++) if (P.mine[i].id === id) return JSON.parse(JSON.stringify(P.mine[i])); return null; }
    return Core.presetCfg(id);
  }
  function normPrefs(p) {
    p = p || {};
    var groups = Core.GROUPS.map(function (g) { return g.id; }), v = +p.vol;
    return {
      vol: isFinite(v) ? Core.clamp(v, 0, 1) : 0.6,
      mins: Core.TIMERS.indexOf(p.mins) >= 0 ? p.mins : 0,
      out: p.out === 'loop' ? 'loop' : 'live',
      group: groups.indexOf(p.group) >= 0 ? p.group : 'relax',
      adj: !!p.adj
    };
  }
  function saveSoon() {
    if (!P) return;
    clearTimeout(P.saveT);
    P.saveT = setTimeout(saveNow, 400);
  }
  function saveNow() {
    if (!P) return;
    clearTimeout(P.saveT); P.saveT = 0;
    saveJSON(K_STATE, { cfg: P.cfg, prefs: P.prefs });
  }

  // ---- session clock ----
  // Live: the AudioContext clock (it stops while suspended, so pauses and iOS
  // interruptions don't count). Loop: wall-clock time while the loop plays.
  function elapsed() {
    var S = P.S;
    if (!S.on) return 0;
    if (S.eng === 'live') return P.A && S.t0 != null ? Math.max(0, P.A.ac.currentTime - S.t0) : S.acc;
    return S.acc + (S.playing && S.startMs ? (nowMs() - S.startMs) / 1000 : 0);
  }
  function timerEnd() { return P.prefs.mins ? P.S.tOff + P.prefs.mins * 60 : 0; }
  function curBeat() { return Core.beatAt(P.cfg, P.S.on ? elapsed() - P.S.pathAt : 0); }

  // =========================================================================
  // Live engine — Web Audio
  // =========================================================================
  // Param automation: hold the current value at t, dropping later events.
  function hold(prm, t) {
    if (prm.cancelAndHoldAtTime) { try { prm.cancelAndHoldAtTime(t); return; } catch (e) {} }
    var v = prm.value;
    prm.cancelScheduledValues(t);
    prm.setValueAtTime(v, t);
  }
  function liveCtx() {
    if (!AC) { toast('This browser has no Web Audio', 'error', 2500); return null; }
    var A = P.A;
    if (!A) {
      var ac;
      try { ac = new AC({ latencyHint: 'playback' }); } catch (e) { try { ac = new AC(); } catch (e2) { toast('Could not start audio', 'error'); return null; } }
      A = P.A = { ac: ac, R: {}, T: null, N: null, wave: null, master: ac.createGain(), env: ac.createGain() };
      A.master.gain.value = gainOf(P.prefs.vol);
      A.master.connect(ac.destination);
      A.env.gain.value = 0;
      A.env.connect(A.master);
      try { var b = ac.createBufferSource(); b.buffer = ac.createBuffer(1, 1, ac.sampleRate); b.connect(ac.destination); b.start(0); } catch (e) {} // iOS unlock
      ac.onstatechange = function () { if (P && P.A === A) renderPlay(); };
    }
    if (A.ac.state !== 'running') { try { var pr = A.ac.resume(); if (pr && pr.catch) pr.catch(noop); } catch (e) {} }
    playbackSession(true);
    return A;
  }
  function mkOsc(ac, f, t) {
    var o = ac.createOscillator();
    o.type = 'sine'; o.frequency.value = f; o.start(t);
    return o;
  }
  function toneLevel() { return Core.TONE_GAIN * P.cfg.tone; }
  function buildTone(A, t, fadeS) {
    var c = P.cfg, ac = A.ac, fr = Core.freqs(c, curBeat()), lvl = ac.createGain();
    var X = { lvl: lvl, srcs: [], nodes: [lvl], f: {}, mode: c.mode };
    lvl.gain.setValueAtTime(0, t);
    lvl.gain.linearRampToValueAtTime(toneLevel(), t + (fadeS || 0.05));
    lvl.connect(A.env);
    if (c.mode === 'iso') {
      var o = mkOsc(ac, fr.l, t), am = ac.createGain(), dep = ac.createGain(), lfo = ac.createOscillator();
      if (!A.wave) { var pc = Core.pulseCoefs(); A.wave = ac.createPeriodicWave(pc.real, pc.imag); }
      lfo.setPeriodicWave(A.wave); lfo.frequency.value = fr.pulse; lfo.start(t);
      am.gain.value = 0.5; dep.gain.value = 0.5;              // gain = 0.5 + 0.5·pulse → 0 … 1
      lfo.connect(dep); dep.connect(am.gain); o.connect(am); am.connect(lvl);
      X.srcs = [o, lfo]; X.nodes.push(am, dep); X.f = { l: o.frequency, pulse: lfo.frequency };
    } else {
      var oL = mkOsc(ac, fr.l, t), oR = mkOsc(ac, fr.r, t), mix;
      if (c.mode === 'binaural') { mix = ac.createChannelMerger(2); oL.connect(mix, 0, 0); oR.connect(mix, 0, 1); }
      else { mix = ac.createGain(); mix.gain.value = 0.5; oL.connect(mix); oR.connect(mix); }
      mix.connect(lvl);
      X.srcs = [oL, oR]; X.nodes.push(mix); X.f = { l: oL.frequency, r: oR.frequency };
    }
    return X;
  }
  function noiseBuffer(A, kind) {
    if (A.R[kind]) return A.R[kind];
    var ac = A.ac, sr = ac.sampleRate, n = Math.round(sr * 8), b = ac.createBuffer(2, n, sr);
    for (var ch = 0; ch < 2; ch++) b.getChannelData(ch).set(Core.noiseBuf(kind, sr, n));
    A.R = {};                                                  // keep one bed in memory
    return (A.R[kind] = b);
  }
  function buildNoise(A, t, fadeS) {
    var c = P.cfg;
    if (c.noise === 'off') return null;
    var ac = A.ac, src = ac.createBufferSource(), lvl = ac.createGain(), out = src;
    var X = { lvl: lvl, srcs: [src], nodes: [lvl], kind: c.noise };
    src.buffer = noiseBuffer(A, c.noise); src.loop = true;
    lvl.gain.setValueAtTime(0, t);
    lvl.gain.linearRampToValueAtTime(c.nvol, t + (fadeS || 0.05));
    if (c.noise === 'ocean') {                                 // a slow swell, as Core.swell
      var sw = ac.createGain(), dep = ac.createGain(), lfo = ac.createOscillator();
      sw.gain.value = 0.65; dep.gain.value = 0.35; lfo.frequency.value = 0.1;
      lfo.connect(dep); dep.connect(sw.gain); lfo.start(t);
      src.connect(sw); out = sw;
      X.srcs.push(lfo); X.nodes.push(sw, dep);
    }
    out.connect(lvl); lvl.connect(A.env);
    src.start(t, Math.random() * 7);
    return X;
  }
  // Fade a tone / noise chain out and let it go.
  function dropChain(X, t) {
    if (!X) return;
    try { hold(X.lvl.gain, t); X.lvl.gain.setTargetAtTime(0, t, 0.06); } catch (e) {}
    X.srcs.forEach(function (s) { try { s.stop(t + 0.5); } catch (e) {} });
    X.srcs[0].onended = function () { X.srcs.concat(X.nodes).forEach(function (n) { try { n.disconnect(); } catch (e) {} }); };
  }
  // Frequencies from now on: glide to the value `glide` s ahead, then follow the journey.
  function schedFreqs(A, t, glide) {
    var X = A.T, S = P.S, c = P.cfg;
    if (!X) return;
    var ps = t - S.t0 - S.pathAt, g = glide || 0, sa = ps + g, fa = Core.freqs(c, Core.beatAt(c, sa)), next = Core.pathAfter(c, sa);
    Object.keys(X.f).forEach(function (k) {
      var prm = X.f[k];
      hold(prm, t);
      if (g > 0) { prm.setTargetAtTime(fa[k], t, g / 5); prm.setValueAtTime(fa[k], t + g); }
      else prm.setValueAtTime(fa[k], t);
      next.forEach(function (pt) { prm.linearRampToValueAtTime(Core.freqs(c, pt[1])[k], t + (pt[0] - ps)); });
    });
  }
  // The envelope from now on (fade in, timer fade out); rampIn fades up from silence.
  function schedEnv(A, t, rampIn) {
    var S = P.S, g = A.env.gain, sec = t - S.t0, r = rampIn || 0;
    var plan = Core.envPlan(P.cfg, sec + r, timerEnd(), S.skipIn);
    hold(g, t);
    if (r > 0) { g.setValueAtTime(0, t); g.linearRampToValueAtTime(plan[0][1], t + r); }
    else g.setValueAtTime(plan[0][1], t);
    for (var i = 1; i < plan.length; i++) g.linearRampToValueAtTime(plan[i][1], S.t0 + plan[i][0]);
  }
  function liveStart(sec, rampIn) {
    var A = liveCtx();
    if (!A) return false;
    var t = A.ac.currentTime + 0.04;
    P.S.t0 = t - sec;
    dropChain(A.T, t); dropChain(A.N, t);
    A.T = buildTone(A, t); A.N = buildNoise(A, t);
    schedFreqs(A, t, 0);
    schedEnv(A, t, rampIn || 0.05);
    return true;
  }
  function liveResume() {
    var A = liveCtx();
    if (!A) return false;
    clearTimeout(P.susT); P.susT = 0;
    if (!A.T || P.S.t0 == null) return liveStart(P.S.t0 == null ? P.S.acc : elapsed(), 0.4);
    schedEnv(A, A.ac.currentTime + 0.03, 0.4);
    return true;
  }
  function livePause(drop) {
    var A = P.A;
    if (!A) return;
    var t = A.ac.currentTime + 0.01;
    hold(A.env.gain, t);
    A.env.gain.linearRampToValueAtTime(0, t + 0.25);
    if (drop) { dropChain(A.T, t + 0.3); dropChain(A.N, t + 0.3); A.T = A.N = null; }
    clearTimeout(P.susT);
    P.susT = setTimeout(function () {
      P.susT = 0;
      if (P && P.A === A && (!P.S.playing || P.S.eng !== 'live')) { try { var pr = A.ac.suspend(); if (pr && pr.catch) pr.catch(noop); } catch (e) {} }
    }, 400);
  }
  // Settings changed mid-session: rebuild what changed kind, glide the rest.
  function liveRetune(glide) {
    var A = P.A, S = P.S, c = P.cfg;
    if (!A || S.t0 == null) return;
    var t = A.ac.currentTime + 0.02;
    if (!A.T || A.T.mode !== c.mode) { dropChain(A.T, t); A.T = buildTone(A, t, 0.25); }
    else { hold(A.T.lvl.gain, t); A.T.lvl.gain.setTargetAtTime(toneLevel(), t, 0.04); }
    var nk = c.noise === 'off' ? null : c.noise;
    if ((A.N ? A.N.kind : null) !== nk) { dropChain(A.N, t); A.N = buildNoise(A, t, 0.8); }
    else if (A.N) { hold(A.N.lvl.gain, t); A.N.lvl.gain.setTargetAtTime(c.nvol, t, 0.04); }
    schedFreqs(A, t, glide);
    if (S.playing) schedEnv(A, t, 0);
  }

  // =========================================================================
  // Loop engine — a rendered 60 s loop in an <audio> element (lock screen)
  // =========================================================================
  function loopEl() {
    var L = P.L;
    if (L.el) return L.el;
    var el = document.createElement('audio');
    el.loop = true; el.preload = 'auto';
    el.setAttribute('playsinline', ''); el.setAttribute('x-webkit-airplay', 'deny');
    el.addEventListener('timeupdate', onLoopTime);
    el.addEventListener('pause', onLoopPause);
    el.addEventListener('play', onLoopPlay);
    return (L.el = el);
  }
  function loopBeat() {
    var b = Core.beatAt(P.cfg, elapsed() - P.S.pathAt);
    return P.cfg.path ? Math.round(b * 4) / 4 : b;            // a journey steps its loop every ¼ Hz
  }
  function loopRender() {
    var L = P.L, c = P.cfg, beat = loopBeat(), vol = gainOf(P.prefs.vol);
    var key = [c.carrier, beat, c.mode, c.tone, c.noise, c.nvol, vol].join('|');
    if (key === L.key && L.url) return;
    var out, url;
    try {
      out = Core.synthLoop(c, { beat: beat, vol: vol });
      url = URL.createObjectURL(new Blob([Core.encodeWAV(out.chans, out.sr)], { type: 'audio/wav' }));
    } catch (e) { toast('Could not render the loop', 'error'); return; }
    var el = loopEl(), old = L.url;
    L.url = url; L.key = key;
    L.quietUntil = nowMs() + 800;                              // a src swap may fire 'pause'
    el.src = url;
    if (P.S.playing) loopPlay();
    if (old) setTimeout(function () { try { URL.revokeObjectURL(old); } catch (e) {} }, 1500);
  }
  function loopSoon() {
    clearTimeout(P.renderT);
    P.renderT = setTimeout(function () { if (P) { P.renderT = 0; if (P.S.on && P.S.eng === 'loop') loopRender(); } }, 350);
  }
  function loopPlay() {
    var el = P.L.el;
    if (!el) return;
    try {
      var pr = el.play();
      if (pr && pr.catch) pr.catch(function (e) {
        if (P && P.S.playing && P.S.eng === 'loop' && e && e.name === 'NotAllowedError') { pauseState(); toast('Tap ▶ to start the loop'); }
      });
    } catch (e) {}
  }
  function loopHalt(full) {
    var L = P.L;
    clearTimeout(P.renderT); P.renderT = 0;
    if (!L.el) return;
    L.quietUntil = nowMs() + 800;
    try { L.el.pause(); } catch (e) {}
    if (full) {
      try { L.el.removeAttribute('src'); L.el.load(); } catch (e) {}
      if (L.url) { try { URL.revokeObjectURL(L.url); } catch (e) {} }
      L.url = null; L.key = '';
    }
  }
  function onLoopTime() {
    if (!P || P.S.eng !== 'loop' || !P.S.playing) return;
    var n = nowMs();
    if (n - P.ltAt < 950) return;
    P.ltAt = n;
    stepSession();
  }
  // The lock screen / an interruption paused or resumed the element itself.
  function onLoopPause() {
    if (!P || P.S.eng !== 'loop' || !P.S.playing || nowMs() < P.L.quietUntil) return;
    pauseState();
  }
  function onLoopPlay() {
    if (!P || P.S.eng !== 'loop' || P.S.playing || !P.S.on) return;
    P.S.startMs = nowMs(); P.S.playing = true;
    afterPlayState();
  }

  // ---- iOS: Web Audio follows the ring / silent switch. The Audio Session API
  // (iOS 17+) or a silent looping <audio> switches the page to "playback". ----
  function playbackSession(on) {
    var s = NAV.audioSession;
    if (s) {
      try {
        if (on && s.type !== 'playback') { if (P.prevSession == null) P.prevSession = s.type || 'auto'; s.type = 'playback'; }
        if (!on && P.prevSession != null) { s.type = P.prevSession; P.prevSession = null; }
      } catch (e) {}
      return;
    }
    if (!IS_IOS) return;
    if (on) {
      if (!P.silent) {
        if (!SILENT_URL) SILENT_URL = URL.createObjectURL(new Blob([Core.encodeWAV([new Float32Array(4000)], 8000)], { type: 'audio/wav' }));
        var el = document.createElement('audio');
        el.setAttribute('x-webkit-airplay', 'deny'); el.setAttribute('playsinline', '');
        el.preload = 'auto'; el.loop = true; el.src = SILENT_URL;
        P.silent = el;
      }
      if (P.silent.paused) { try { var pr = P.silent.play(); if (pr && pr.catch) pr.catch(noop); } catch (e) {} }
    } else if (P.silent) { try { P.silent.pause(); } catch (e) {} }
  }
  // Lock-screen / headset controls and the now-playing title.
  function mediaSession(off) {
    var ms = NAV.mediaSession;
    if (!ms) return;
    try {
      if (off) {
        ['play', 'pause', 'stop'].forEach(function (a) { try { ms.setActionHandler(a, null); } catch (e) {} });
        ms.metadata = null;
        ms.playbackState = 'none';
        return;
      }
      var b = curBeat(), bd = Core.band(b);
      if (typeof window.MediaMetadata === 'function') {
        ms.metadata = new window.MediaMetadata({ title: P.cfg.name, artist: bd.sym + ' ' + bd.name + ' · ' + Core.fmtHz(b) + ' Hz ' + Core.MODE_NAMES[P.cfg.mode].toLowerCase(), album: 'Binaural Beats' });
      }
      ms.setActionHandler('play', function () { if (P) play(); });
      ms.setActionHandler('pause', function () { if (P) pause(); });
      try { ms.setActionHandler('stop', function () { if (P) stopSession(); }); } catch (e) {}
      ms.playbackState = P.S.playing ? 'playing' : 'paused';
    } catch (e) {}
  }

  // =========================================================================
  // Transport
  // =========================================================================
  function play() {
    var S = P.S;
    if (S.playing) {                                          // iOS may have interrupted the context
      if (S.eng === 'live' && P.A && P.A.ac.state !== 'running') liveCtx();
      return;
    }
    if (!S.on) {
      S.on = true; S.eng = P.prefs.out; S.t0 = null; S.acc = 0; S.pathAt = 0; S.tOff = 0; S.skipIn = false;
      S.playing = true;
      if (S.eng === 'live') { if (!liveStart(0, 0.05)) { S.on = S.playing = false; return; } }
      else { S.startMs = nowMs(); loopRender(); loopPlay(); }
    } else {
      S.playing = true;
      if (S.eng === 'live') { if (!liveResume()) { S.playing = false; return; } }
      else { S.startMs = nowMs(); loopRender(); loopPlay(); }
    }
    afterPlayState();
    try { Cade.haptic(8); } catch (e) {}
  }
  function afterPlayState() {
    mediaSession(); armEnd(); startTick(); renderPlay(); renderChip();
  }
  function pause() {
    if (!P.S.playing) return;
    if (P.S.eng === 'live') { P.S.playing = false; livePause(false); }
    else { P.S.acc = elapsed(); P.S.startMs = 0; P.S.playing = false; loopHalt(false); }
    afterPauseState();
  }
  function pauseState() {                                     // the loop element paused on its own
    var S = P.S;
    S.acc = elapsed(); S.startMs = 0; S.playing = false;
    afterPauseState();
  }
  function afterPauseState() {
    if (P.silent) { try { P.silent.pause(); } catch (e) {} }
    clearTimeout(P.endT); P.endT = 0;
    stopTick(); mediaSession(); renderPlay(); renderLive(); renderChip();
  }
  function togglePlay() { if (P.S.playing) pause(); else play(); }
  function stopSession(done) {
    var S = P.S;
    if (!S.on) return;
    if (S.eng === 'live') { S.playing = false; livePause(true); } else loopHalt(true);
    S.on = S.playing = false; S.t0 = null; S.acc = 0; S.startMs = 0; S.pathAt = 0; S.tOff = 0; S.skipIn = false;
    clearTimeout(P.endT); P.endT = 0;
    if (P.silent) { try { P.silent.pause(); } catch (e) {} }
    stopTick(); mediaSession(); renderNow(); renderChip();
    if (done) { toast('Session complete', 'success', 2400); try { Cade.haptic(20); } catch (e) {} }
  }
  // A new preset while a session runs: its clock (journey, timer) restarts; no
  // second fade-in while it's audible — the tones glide over instead.
  function restartSession() {
    var S = P.S;
    S.pathAt = 0; S.tOff = 0;
    if (S.eng === 'live' && P.A && S.t0 != null) {
      S.skipIn = S.playing;
      S.t0 = P.A.ac.currentTime + 0.02;
      liveRetune(GLIDE);
    } else {
      S.acc = 0; S.startMs = S.playing ? nowMs() : 0; S.skipIn = false;
      if (S.eng === 'loop') loopRender();
    }
    armEnd();
  }
  // Output switched mid-session: hand the session clock to the other engine.
  function setOut(out) {
    if (out === P.prefs.out) return;
    P.prefs.out = out;
    saveSoon();
    var S = P.S;
    if (S.on) {
      var sec = elapsed(), was = S.playing;
      if (S.eng === 'live') { S.playing = false; livePause(true); } else loopHalt(true);
      S.eng = out; S.acc = sec; S.t0 = null; S.startMs = 0; S.playing = false;
      if (P.silent) { try { P.silent.pause(); } catch (e) {} }       // the loop is its own media session
      if (was) play();
    }
    renderAdj(); renderNow();
  }
  function armEnd() {
    clearTimeout(P.endT); P.endT = 0;
    var T = timerEnd();
    if (!T || !P.S.playing) return;
    var left = T - elapsed();
    P.endT = setTimeout(function () {
      if (!P) return;
      P.endT = 0;
      if (P.S.playing && elapsed() >= timerEnd() - 0.5) stopSession(true); else armEnd();
    }, Math.max(0, left * 1000 + 150));
  }
  // Once a second while playing: timer, the loop's journey steps, the readouts.
  function stepSession() {
    if (!P || !P.S.on) return;
    var sec = elapsed(), T = timerEnd();
    if (P.S.playing && T && sec >= T) { stopSession(true); return; }
    if (P.S.eng === 'loop' && P.S.playing && P.cfg.path) loopRender();
    if (!document.hidden) renderLive(sec);
  }
  function startTick() {
    if (!P || P.uiT || document.hidden || !P.S.playing) return;
    P.uiT = setInterval(stepSession, 1000);
  }
  function stopTick() { if (P && P.uiT) { clearInterval(P.uiT); P.uiT = 0; } }

  // =========================================================================
  // Editing
  // =========================================================================
  function applyCfg(c, mins) {
    P.cfg = c;
    P.base = JSON.parse(JSON.stringify(c));
    if (mins) P.prefs.mins = mins;
    saveSoon();
    if (P.S.on) restartSession();
    if (!P.S.playing) play();
    else { mediaSession(); armEnd(); }
    renderNow(); renderGrid(); renderAdj(); renderTimer();
  }
  function edited(glide) {
    P.cfg = Core.normalizeCfg(P.cfg);
    saveSoon();
    if (P.S.on) {
      if (P.S.eng === 'live') liveRetune(glide); else loopSoon();
      if (P.S.playing) mediaSession();
    }
    renderNow(); renderMarks();
  }
  function setBeat(v) {
    if (P.cfg.path) P.cfg.path[0][1] = v; else P.cfg.beat = v;
    P.cfg.beat = v;
  }
  function setRamp(on) {
    var c = P.cfg;
    if (on && !c.path) c.path = [[0, c.beat], [20, c.beat >= 8 ? 4 : 12]];
    if (!on) c.path = null;
  }
  function setRampEnd(to, over) {
    var c = P.cfg, last = c.path ? c.path[c.path.length - 1] : [20, 4];
    if (to == null) to = last[1];
    if (over == null) over = last[0];
    c.path = [[0, c.path ? c.path[0][1] : c.beat], [Core.clamp(over, 1, Core.LIM.pathMins), to]];
  }
  function applyVol() {
    if (P.A) { var t = P.A.ac.currentTime; hold(P.A.master.gain, t); P.A.master.gain.setTargetAtTime(gainOf(P.prefs.vol), t, 0.03); }
    if (P.S.on && P.S.eng === 'loop') loopSoon();
    var vv = q('.bn-volv');
    if (vv) vv.textContent = Math.round(P.prefs.vol * 100);
    saveSoon();
  }
  function saveMine() {
    var inp = q('[data-in="sname"]'), name = (inp && inp.value.trim()) || ('My mix ' + (P.mine.length + 1));
    if (P.mine.length >= 60) { toast('60 saved mixes is the limit — delete one first', 'error', 2600); return; }
    var c = Core.normalizeCfg(P.cfg);
    c.id = 'mine-' + Date.now().toString(36);
    c.name = name.slice(0, 40);
    P.mine.push(c);
    saveJSON(K_MINE, P.mine);
    P.cfg.id = c.id; P.cfg.name = c.name; P.base = JSON.parse(JSON.stringify(c));
    if (inp) inp.value = '';
    P.prefs.group = 'mine';
    saveSoon();
    renderTabs(); renderGrid(); renderNow();
    toast('Saved “' + c.name + '”', 'success');
  }
  function delMine(id) {
    P.mine = P.mine.filter(function (m) { return m.id !== id; });
    saveJSON(K_MINE, P.mine);
    if (P.cfg.id === id) { P.cfg.id = ''; P.base = null; }
    renderGrid(); renderNow();
  }

  // =========================================================================
  // Rendering
  // =========================================================================
  function bandOf(c) { return Core.band(c.path ? c.path[0][1] : c.beat).id; }
  function presetFreqLabel(c) {
    var s = Core.band(c.beat).sym + ' ';
    if (c.path) {                                              // 10→4→14 (holds dropped)
      var v = [];
      c.path.forEach(function (pt) { if (!v.length || v[v.length - 1] !== pt[1]) v.push(pt[1]); });
      return s + v.map(Core.fmtHz).join('→') + ' Hz';
    }
    return s + Core.fmtHz(c.beat) + ' Hz';
  }
  function skeleton() {
    var timers = Core.TIMERS.map(function (m) { return '<option value="' + m + '">' + (m ? '⏲ ' : '⏲ Timer ') + timerLabel(m) + '</option>'; }).join('');
    var seg = function (attr, list, names) {
      return '<span class="bn-seg" role="group">' + list.map(function (v) { return '<button type="button" ' + attr + '="' + v + '">' + esc(names[v]) + '</button>'; }).join('') + '</span>';
    };
    var ticks = Core.BANDS.map(function (b) {
      return '<button type="button" class="bn-tick" data-band="' + b.id + '" data-tick="' + b.id + '" title="' + esc(b.name + ' · ' + b.lo + '–' + b.hi + ' Hz · ' + b.feel) + '">' +
        b.sym + ' <span>' + BAND_HZ[b.id] + '</span></button>';
    }).join('');
    return '<div class="bn">' +
      '<section class="bn-now" aria-label="Now playing">' +
        '<svg class="bn-wave" viewBox="0 0 320 64" preserveAspectRatio="none" aria-hidden="true"><path class="bn-we"/><path class="bn-wv"/></svg>' +
        '<div class="bn-top">' +
          '<button type="button" class="bn-play" data-act="play" aria-label="Play">' + ICON_PLAY + '</button>' +
          '<div class="bn-info">' +
            '<div class="bn-name"></div>' +
            '<div class="bn-hz"><b class="bn-beat"></b><span class="bn-unit">Hz</span><span class="bn-band"></span></div>' +
            '<div class="bn-sub"></div>' +
          '</div>' +
          '<button type="button" class="bn-stop" data-act="stop" aria-label="Stop" title="Stop">' + ICON_STOP + '</button>' +
        '</div>' +
        '<div class="bn-prog" aria-hidden="true"><i></i></div>' +
        '<div class="bn-meta"><span class="bn-time">0:00</span>' +
          '<select class="bn-timer" data-in="mins" aria-label="Sleep timer">' + timers + '</select><span class="bn-next"></span></div>' +
        '<label class="bn-vol"><span aria-hidden="true">🔈</span><input type="range" min="0" max="100" step="1" data-in="vol" aria-label="Volume"><span class="bn-volv"></span></label>' +
      '</section>' +
      '<div class="bn-tabs" role="tablist" aria-label="Preset groups">' + Core.GROUPS.map(function (g) {
        return '<button type="button" role="tab" data-group="' + g.id + '">' + esc(g.name) + '</button>';
      }).join('') + '</div>' +
      '<div class="bn-grid"></div>' +
      '<details class="bn-adj"><summary>Adjust</summary><div class="bn-adjb">' +
        '<div class="bn-row"><span class="bn-l">Beat</span><div class="bn-c">' +
          '<input type="range" class="bn-r" min="0" max="1000" step="1" data-in="beat" aria-label="Beat frequency">' +
          '<input type="number" class="bn-n" inputmode="decimal" step="any" min="0.5" max="45" data-num="beat" aria-label="Beat Hz"><span class="bn-u">Hz</span>' +
          '<div class="bn-ticks">' + ticks + '</div></div></div>' +
        '<div class="bn-row"><span class="bn-l">Carrier</span><div class="bn-c">' +
          '<input type="range" class="bn-r" min="0" max="1000" step="1" data-in="carrier" aria-label="Carrier frequency">' +
          '<input type="number" class="bn-n" inputmode="decimal" step="any" min="40" max="1000" data-num="carrier" aria-label="Carrier Hz"><span class="bn-u">Hz</span></div></div>' +
        '<div class="bn-row"><span class="bn-l">Mode</span><div class="bn-c">' + seg('data-mode', Core.MODES, Core.MODE_NAMES) + '<span class="bn-hint bn-modeh"></span></div></div>' +
        '<div class="bn-row"><span class="bn-l">Tone</span><div class="bn-c"><input type="range" class="bn-r" min="0" max="100" step="1" data-in="tone" aria-label="Tone level"></div></div>' +
        '<div class="bn-row"><span class="bn-l">Noise</span><div class="bn-c">' + seg('data-noise', Core.NOISES, Core.NOISE_NAMES) +
          '<input type="range" class="bn-r" min="0" max="100" step="1" data-in="nvol" aria-label="Noise level"></div></div>' +
        '<div class="bn-row"><span class="bn-l">Journey</span><div class="bn-c">' +
          '<label class="bn-chk"><input type="checkbox" data-in="ramp"> Glide to</label><span class="bn-nw">' +
          '<input type="number" class="bn-n bn-ns" inputmode="decimal" step="any" min="0.5" max="45" data-num="to" aria-label="Glide to Hz"><span class="bn-u">Hz over</span>' +
          '<input type="number" class="bn-n bn-ns" inputmode="numeric" step="1" min="1" max="180" data-num="over" aria-label="Glide minutes"><span class="bn-u">min</span></span>' +
          '<span class="bn-hint bn-pathl"></span></div></div>' +
        '<div class="bn-row"><span class="bn-l">Fade</span><div class="bn-c"><span class="bn-nw"><span class="bn-u">in</span>' +
          '<input type="number" class="bn-n bn-ns" inputmode="numeric" step="1" min="0" max="120" data-num="fadeIn" aria-label="Fade in seconds"><span class="bn-u">s</span></span><span class="bn-nw"><span class="bn-u">out</span>' +
          '<input type="number" class="bn-n bn-ns" inputmode="numeric" step="1" min="0" max="300" data-num="fadeOut" aria-label="Fade out seconds"><span class="bn-u">s</span></span></div></div>' +
        '<div class="bn-row"><span class="bn-l">Output</span><div class="bn-c">' + seg('data-out', ['live', 'loop'], { live: 'Live', loop: 'Lock-screen loop' }) +
          '<span class="bn-hint bn-outh"></span></div></div>' +
        '<div class="bn-row"><span class="bn-l">Save</span><div class="bn-c">' +
          '<input type="text" class="bn-t" data-in="sname" maxlength="40" placeholder="Name this mix" aria-label="Preset name" autocomplete="off">' +
          '<button type="button" class="bn-btn" data-act="save">Save</button></div></div>' +
      '</div></details>' +
      '<p class="bn-note">🎧 Binaural needs headphones; monaural and isochronic work on speakers. Keep the volume low, and don’t listen while driving.</p>' +
    '</div>';
  }
  function setText(el, s) { if (el && el.textContent !== s) el.textContent = s; }
  function renderPlay() {
    var b = q('.bn-play'), S = P.S;
    if (!b) return;
    var on = S.playing && !(S.eng === 'live' && P.A && P.A.ac.state !== 'running' && !P.susT);
    if (b.__on !== on) { b.__on = on; b.innerHTML = on ? ICON_PAUSE : ICON_PLAY; b.setAttribute('aria-label', on ? 'Pause' : 'Play'); }
    b.classList.toggle('bn-stalled', S.playing && !on);
    q('.bn-stop').disabled = !S.on;
    P.root.classList.toggle('bn-playing', S.playing);
  }
  function wavePaths(c, beat) {
    var W = 320, H = 64, mid = H / 2, amp = H * 0.42, cyc = Core.clamp(Math.round(c.carrier / Math.max(beat, 0.5) / 3), 5, 16);
    var tab = c.mode === 'iso' ? Core.pulseTable() : null, d = '', e = '';
    for (var x = 0; x <= W; x += 2) {
      var u = x / W * 2, env;
      if (tab) env = 0.5 + 0.5 * tab[Math.floor((u % 1) * tab.length) % tab.length];
      else env = Math.abs(Math.cos(Math.PI * u));
      var y = mid - amp * env * Math.sin(2 * Math.PI * cyc * u);
      d += (x ? 'L' : 'M') + x + ' ' + y.toFixed(1);
      e += (x ? 'L' : 'M') + x + ' ' + (mid - amp * env).toFixed(1);
    }
    return [d, e];
  }
  function renderWave(beat) {
    var c = P.cfg, key = c.mode + '|' + c.carrier + '|' + Math.round(beat * 4);
    if (P.waveKey === key) return;
    P.waveKey = key;
    var p = wavePaths(c, beat);
    q('.bn-wv').setAttribute('d', p[0]);
    q('.bn-we').setAttribute('d', p[1]);
  }
  function displayName() {
    var c = P.cfg, n = c.name || 'Custom';
    if (!P.base || !c.id) return c.id ? n : 'Custom';
    return Core.sameSound(c, P.base) ? n : n + ' · edited';
  }
  function renderNow() {
    if (!P) return;
    var c = P.cfg, b = curBeat(), bd = Core.band(b), noise = c.noise !== 'off' ? ' + ' + Core.NOISE_NAMES[c.noise].toLowerCase() + ' noise' : '';
    P.root.setAttribute('data-band', bd.id);
    setText(q('.bn-name'), displayName());
    var sub = c.mode === 'iso'
      ? Core.fmtHz(c.carrier) + ' Hz tone, pulsed · isochronic' + noise
      : 'L ' + Core.fmtHz(c.carrier) + ' · R ' + Core.fmtHz(c.carrier + b) + ' Hz · ' + Core.MODE_NAMES[c.mode].toLowerCase() + noise;
    setText(q('.bn-sub'), sub);
    renderLive();
    renderPlay();
  }
  function renderLive(sec) {
    if (!P || isMin()) { renderChip(); return; }
    var S = P.S, c = P.cfg;
    if (sec == null) sec = elapsed();
    var b = Core.beatAt(c, S.on ? sec - S.pathAt : 0), bd = Core.band(b), T = timerEnd();
    setText(q('.bn-beat'), c.path && S.on ? (Math.round(b * 10) / 10).toFixed(1) : Core.fmtHz(b));
    setText(q('.bn-band'), bd.sym + ' ' + bd.name);
    q('.bn-band').title = bd.feel;
    if (P.root.getAttribute('data-band') !== bd.id) P.root.setAttribute('data-band', bd.id);
    if (c.path && S.on && c.mode !== 'iso') setText(q('.bn-sub'), 'L ' + Core.fmtHz(c.carrier) + ' · R ' + (Math.round((c.carrier + b) * 10) / 10) + ' Hz · ' + Core.MODE_NAMES[c.mode].toLowerCase() + (c.noise !== 'off' ? ' + ' + Core.NOISE_NAMES[c.noise].toLowerCase() + ' noise' : ''));
    renderWave(b);
    var time = Core.fmtClock(sec), next = '', frac = 0;
    if (T) { time += ' · ' + Core.fmtClock(T - sec) + ' left'; frac = (sec - S.tOff) / (T - S.tOff); }
    if (c.path) {
      // the next point that changes the beat: "→ 2 Hz in 12:00", else "holding 2 Hz"
      var ps = S.on ? sec - S.pathAt : 0, ahead = Core.pathAfter(c, ps), nx = null;
      for (var i = 0; i < ahead.length && !nx; i++) if (Math.abs(ahead[i][1] - b) >= 0.05) nx = ahead[i];
      next = nx ? '→ ' + Core.fmtHz(nx[1]) + ' Hz in ' + Core.fmtClock(nx[0] - ps) : 'holding ' + Core.fmtHz(b) + ' Hz';
      if (!T) frac = Math.min(1, ps / Core.pathSecs(c));
    }
    if (!S.on) { time = T ? 'Timer ' + timerLabel(P.prefs.mins) : 'Ready'; frac = 0; if (c.path) next = Core.pathLabel(c); }
    setText(q('.bn-time'), time);
    setText(q('.bn-next'), next);
    var bar = q('.bn-prog i'), w = (Core.clamp(frac || 0, 0, 1) * 100).toFixed(2) + '%';
    if (bar.style.width !== w) bar.style.width = w;
    renderChip();
  }
  function chipLabel() {
    if (!P) return '🎧 Binaural';
    var S = P.S, b = curBeat(), bd = Core.band(b), T = timerEnd();
    var s = '🎧 ' + (S.on && !S.playing ? '❚❚ ' : '') + bd.sym + ' ' + (P.cfg.path && S.on ? (Math.round(b * 10) / 10).toFixed(1) : Core.fmtHz(b)) + ' Hz';
    if (S.on && T) s += ' · ' + Core.fmtClock(T - elapsed());
    return s;
  }
  function renderChip() {
    var chip = P && P.el.__dockChip;
    if (chip && chip.isConnected) setText(chip, chipLabel());
  }
  function renderTabs() {
    var bs = P.el.querySelectorAll('[data-group]'), row = q('.bn-tabs');
    for (var i = 0; i < bs.length; i++) {
      var on = bs[i].getAttribute('data-group') === P.prefs.group;
      bs[i].classList.toggle('on', on);
      bs[i].setAttribute('aria-selected', on ? 'true' : 'false');
      // keep the selected group in view in the sideways-scrolling row
      if (on && row && (bs[i].offsetLeft < row.scrollLeft || bs[i].offsetLeft + bs[i].offsetWidth > row.scrollLeft + row.clientWidth)) row.scrollLeft = bs[i].offsetLeft - 8;
    }
  }
  function renderGrid() {
    var g = P.prefs.group, list, html;
    if (g === 'mine') list = P.mine;
    else list = Core.PRESETS.filter(function (p) { return p.group === g; }).map(function (p) { var c = Core.presetCfg(p.id); c.desc = p.desc; return c; });
    if (!list.length) html = '<p class="bn-empty">No saved mixes yet — set one up under <b>Adjust</b> and tap <b>Save</b>.</p>';
    else html = list.map(function (c) {
      var mine = g === 'mine', d = c.desc || (Core.MODE_NAMES[c.mode] + (c.noise !== 'off' ? ' · ' + Core.NOISE_NAMES[c.noise].toLowerCase() + ' noise' : '') + (c.path ? ' · ' + c.path[c.path.length - 1][0] + ' min journey' : ''));
      return '<button type="button" class="bn-p" data-preset="' + esc(c.id) + '" data-band="' + bandOf(c) + '" title="' + esc(d) + '">' +
        '<span class="bn-pn">' + esc(c.name) + '</span><span class="bn-pf">' + esc(presetFreqLabel(c)) + (c.mode === 'iso' ? ' · pulse' : '') + '</span>' +
        '<span class="bn-pd">' + esc(d) + '</span>' +
        (mine ? '<span class="bn-del" role="button" data-del="' + esc(c.id) + '" aria-label="Delete ' + esc(c.name) + '" title="Delete">×</span>' : '') + '</button>';
    }).join('');
    var grid = q('.bn-grid');
    grid.innerHTML = html;
    renderMarks();
  }
  function renderMarks() {
    var bs = P.el.querySelectorAll('.bn-p'), c = P.cfg, base = P.base;
    for (var i = 0; i < bs.length; i++) {
      var on = !!c.id && bs[i].getAttribute('data-preset') === c.id;
      bs[i].classList.toggle('on', on);
      bs[i].classList.toggle('bn-edited', on && !!base && !Core.sameSound(c, base));
      bs[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  function renderTimer() {
    var s = q('[data-in="mins"]');
    if (s) s.value = String(P.prefs.mins);
  }
  function syncNum(k) {
    var n = q('[data-num="' + k + '"]');
    if (n && document.activeElement !== n) n.value = String(k === 'beat' ? (P.cfg.path ? P.cfg.path[0][1] : P.cfg.beat) : P.cfg[k]);
  }
  function renderAdj() {
    var c = P.cfg, i, bs;
    q('[data-in="beat"]').value = Core.toPos(c.beat, 0.5, 45);
    q('[data-in="carrier"]').value = Core.toPos(c.carrier, 40, 1000);
    q('[data-in="tone"]').value = Math.round(c.tone * 100);
    q('[data-in="nvol"]').value = Math.round(c.nvol * 100);
    q('[data-in="nvol"]').disabled = c.noise === 'off';
    syncNum('beat'); syncNum('carrier');
    q('[data-num="fadeIn"]').value = c.fadeIn;
    q('[data-num="fadeOut"]').value = c.fadeOut;
    var ramp = q('[data-in="ramp"]'), to = q('[data-num="to"]'), over = q('[data-num="over"]');
    ramp.checked = !!c.path;
    to.disabled = over.disabled = !c.path;
    var last = c.path ? c.path[c.path.length - 1] : null;
    to.value = last ? last[1] : '';
    over.value = last ? last[0] : '';
    setText(q('.bn-pathl'), c.path && c.path.length > 2 ? Core.pathLabel(c) + ' (editing makes it one glide)' : '');
    [['data-mode', c.mode], ['data-noise', c.noise], ['data-out', P.prefs.out]].forEach(function (a) {
      bs = P.el.querySelectorAll('[' + a[0] + ']');
      for (i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].getAttribute(a[0]) === a[1]);
    });
    setText(q('.bn-modeh'), c.mode === 'binaural' ? 'needs headphones' : 'works on speakers');
    setText(q('.bn-outh'), P.prefs.out === 'loop'
      ? 'Plays a seamless 60 s loop like music, so it keeps going with the screen locked. Journeys step every ¼ Hz; fades are skipped; use the volume buttons.'
      : (IS_IOS ? 'Smooth, instant changes. If sound stops when the screen locks, switch to Lock-screen loop.' : 'Smooth, instant changes while the page is open.'));
    var ad = q('.bn-adj');
    if (ad.open !== P.prefs.adj) ad.open = P.prefs.adj;
  }
  function renderAll() {
    q('[data-in="vol"]').value = Math.round(P.prefs.vol * 100);
    setText(q('.bn-volv'), String(Math.round(P.prefs.vol * 100)));
    renderTabs(); renderGrid(); renderAdj(); renderTimer(); renderNow();
  }

  // =========================================================================
  // Events
  // =========================================================================
  function onClick(e) {
    var t = e.target, b;
    if (!t.closest) return;
    if ((b = t.closest('[data-del]'))) {
      e.stopPropagation();
      var id = b.getAttribute('data-del');
      if (P.delArm === id) { P.delArm = null; clearTimeout(P.delT); delMine(id); return; }
      P.delArm = id; b.textContent = 'Delete?'; b.classList.add('arm');
      clearTimeout(P.delT);
      P.delT = setTimeout(function () { if (!P) return; P.delArm = null; var x = P.el.querySelector('.bn-del.arm'); if (x) { x.textContent = '×'; x.classList.remove('arm'); } }, 3000);
      return;
    }
    if ((b = t.closest('[data-act]'))) {
      var act = b.getAttribute('data-act');
      if (act === 'play') togglePlay();
      else if (act === 'stop') stopSession();
      else if (act === 'save') saveMine();
      return;
    }
    if ((b = t.closest('[data-preset]'))) {
      var pid = b.getAttribute('data-preset');
      if (pid === P.cfg.id && P.S.on && P.base && Core.sameSound(P.cfg, P.base)) { if (!P.S.playing) play(); return; }
      var c = findCfg(pid), pr = Core.preset(pid);
      if (c) { try { Cade.haptic(6); } catch (er) {} applyCfg(c, pr && pr.mins); }
      return;
    }
    if ((b = t.closest('[data-group]'))) { P.prefs.group = b.getAttribute('data-group'); saveSoon(); renderTabs(); renderGrid(); return; }
    if ((b = t.closest('[data-mode]'))) { P.cfg.mode = b.getAttribute('data-mode'); edited(0); renderAdj(); return; }
    if ((b = t.closest('[data-noise]'))) { P.cfg.noise = b.getAttribute('data-noise'); edited(0); renderAdj(); return; }
    if ((b = t.closest('[data-out]'))) { setOut(b.getAttribute('data-out')); return; }
    if ((b = t.closest('[data-tick]'))) { setBeat(BAND_HZ[b.getAttribute('data-tick')]); edited(SLIDE * 4); renderAdj(); return; }
  }
  function onInput(e) {
    var t = e.target, k = t.getAttribute && t.getAttribute('data-in');
    if (!k) return;
    if (k === 'vol') { P.prefs.vol = (+t.value || 0) / 100; applyVol(); return; }
    if (k === 'beat') { setBeat(Core.snapBeat(Core.fromPos(t.value, 0.5, 45))); syncNum('beat'); edited(SLIDE); return; }
    if (k === 'carrier') { P.cfg.carrier = Core.snapCarrier(Core.fromPos(t.value, 40, 1000)); syncNum('carrier'); edited(SLIDE); return; }
    if (k === 'tone' || k === 'nvol') { P.cfg[k] = (+t.value || 0) / 100; edited(0); return; }
  }
  function onChange(e) {
    var t = e.target, k = t.getAttribute && t.getAttribute('data-in'), n = t.getAttribute && t.getAttribute('data-num');
    if (k === 'mins') {
      P.prefs.mins = +t.value || 0;
      P.S.tOff = P.S.on ? elapsed() : 0;                       // a timer set mid-session counts from now
      saveSoon(); armEnd();
      if (P.S.on && P.S.eng === 'live' && P.A && P.S.playing) schedEnv(P.A, P.A.ac.currentTime + 0.02, 0);
      renderLive();
      return;
    }
    if (k === 'ramp') { setRamp(t.checked); edited(0); renderAdj(); return; }
    if (!n) return;
    var v = parseFloat(String(t.value).replace(',', '.'));
    if (!isFinite(v)) { renderAdj(); return; }
    if (n === 'beat') setBeat(Core.clamp(v, 0.5, 45));
    else if (n === 'carrier') P.cfg.carrier = Core.clamp(v, 40, 1000);
    else if (n === 'to') setRampEnd(Core.clamp(v, 0.5, 45), null);
    else if (n === 'over') setRampEnd(null, Math.round(v));
    else if (n === 'fadeIn' || n === 'fadeOut') P.cfg[n] = v;
    edited(n === 'beat' || n === 'carrier' ? SLIDE * 4 : 0);
    renderAdj();
  }
  function onToggle() { var ad = q('.bn-adj'); if (ad) { P.prefs.adj = ad.open; saveSoon(); } }
  function focusOk() {
    var ae = document.activeElement;
    if (!ae || ae === document.body || ae === document.documentElement) return false;
    if (!P.el.contains(ae)) return false;                       // the editor or another panel has the keyboard
    if (ae.isContentEditable || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT') return false;
    if (ae.tagName === 'INPUT' && !/^(range|checkbox|radio|button)$/.test(ae.type)) return false;
    return true;
  }
  function onKey(e) {
    if (!P || isMin() || !focusOk()) return;
    if ((e.key === ' ' || e.key === 'Spacebar') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      var ae = document.activeElement;
      if (ae && ae.blur && ae.tagName === 'BUTTON') ae.blur();
      if (!e.repeat) togglePlay();
    }
  }
  function onVis() {
    if (!P) return;
    if (document.hidden) { stopTick(); return; }
    if (P.S.playing) {
      if (P.S.eng === 'live' && P.A && P.A.ac.state !== 'running') liveCtx();
      startTick(); stepSession();
    }
    renderPlay();
  }

  // ---- open / close ----
  function teardown() {
    if (!P) return;
    var st = P;
    clearInterval(st.uiT); clearTimeout(st.endT); clearTimeout(st.susT); clearTimeout(st.renderT); clearTimeout(st.delT);
    saveNow();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVis);
    mediaSession(true);
    playbackSession(false);
    if (st.silent) { try { st.silent.pause(); st.silent.removeAttribute('src'); st.silent.load(); } catch (e) {} st.silent = null; }
    if (SILENT_URL) { try { URL.revokeObjectURL(SILENT_URL); } catch (e) {} SILENT_URL = null; }
    var el = st.L.el;
    if (el) {
      el.removeEventListener('timeupdate', onLoopTime); el.removeEventListener('pause', onLoopPause); el.removeEventListener('play', onLoopPlay);
      try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {}
    }
    if (st.L.url) { try { URL.revokeObjectURL(st.L.url); } catch (e) {} }
    if (st.A) { try { st.A.ac.onstatechange = null; st.A.ac.close(); } catch (e) {} }
    P = null;
  }
  function close() {
    var el = document.getElementById(PANEL_ID);
    if (el) el.remove();
    teardown();
  }
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    var st = loadJSON(K_STATE) || {};
    var el = Cade.mkPanel(PANEL_ID, '🎧 Binaural Beats', skeleton());
    P = {
      el: el, root: el.querySelector('.bn'), cfg: Core.normalizeCfg(st.cfg || Core.presetCfg('calm')), base: null, prefs: normPrefs(st.prefs),
      mine: Core.normalizeMine(loadJSON(K_MINE)),
      S: { on: false, playing: false, eng: 'live', t0: null, acc: 0, startMs: 0, pathAt: 0, tOff: 0, skipIn: false },
      A: null, L: { el: null, url: null, key: '', quietUntil: 0 },
      uiT: 0, endT: 0, susT: 0, saveT: 0, renderT: 0, delT: 0, delArm: null, ltAt: 0, waveKey: '', silent: null, prevSession: null
    };
    P.base = findCfg(P.cfg.id);
    if (!P.base) P.cfg.id = '';
    el._onClose = teardown;
    // Minimize (–) parks it in the footer, still playing, showing the beat and time left.
    el.__cadeMinTo = 'footer';
    el.__cadeMinLabel = chipLabel;
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    q('.bn-adj').addEventListener('toggle', onToggle);
    q('[data-in="sname"]').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveMine(); } });
    el.addEventListener('cade-panel-restore', function () { if (P) { P.waveKey = ''; renderNow(); } });
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', onVis);
    renderAll();
    // the group row can only scroll to the saved group once the stylesheet has laid it out
    requestAnimationFrame(function () { if (P && P.el === el) renderTabs(); });
    setTimeout(function () { if (P && P.el === el) renderTabs(); }, 450);
  }

  Cade.registerWidget({
    name: 'Binaural Beats',
    description: 'Brainwave beat generator — sleep, relax, meditate, focus & energy presets, journeys, noise beds, sleep timer, lock-screen playback',
    icon: '🎧',
    tags: 'binaural,binaural beats,beats,brainwave,brain waves,isochronic,monaural,delta,theta,alpha,beta,gamma,40 hz,sleep,focus,study,meditation,meditate,relax,calm,white noise,pink noise,brown noise,rain,ocean,solfeggio,432,528,schumann,ambient,audio,sound,headphones',
    open: open,
    close: close,
    _core: Core,                                               // exposed for tests
    _state: function () { return P; }
  });
})();
