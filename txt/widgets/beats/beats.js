/* Beat Maker — a looping step sequencer + sound board for Cade.txt.
 *
 * Eleven tracks, every sound synthesized live with the Web Audio API (no
 * samples): kick, snare, clap, closed / open hat, low tom, rim, cowbell,
 * shaker, a bass synth and a keys track (chord stabs, EP, pluck, lead, bell)
 * with a scale-aware note per step. Four patterns (A–D) per song, a chain
 * (song) mode, nine preset grooves, randomize / mutate, a pad screen of
 * one-shot FX that play over the loop (plus a kit bank that records into the
 * pattern, quantized), save / load in Cade.store, an ASCII drum tab that goes
 * into the note and comes back out of it, and a seamless WAV loop rendered
 * with OfflineAudioContext.
 *
 * Timing: the classic lookahead scheduler ("A Tale of Two Clocks") — a 25 ms
 * timer schedules every hit ~100 ms ahead on AudioContext.currentTime, and the
 * playhead is drawn from that same audio clock (requestAnimationFrame only
 * while playing and visible). The loop keeps playing while the panel is
 * minimized; closing the panel stops it and closes the AudioContext.
 *
 * Cost: nothing runs until the panel opens; the AudioContext is created on the
 * first sound-making tap (iOS needs that) and suspended after a few idle
 * seconds while stopped. Each hit builds a few short-lived nodes that are
 * disconnected when they end; noise / metal buffers are made once per context.
 *
 * The pattern model, presets, timing math, tab export / import and the WAV
 * encoder (Core) are DOM-free and unit-tested: node txt/widgets/beats/beats.test.js
 */
(function () {
  'use strict';

  // =========================================================================
  // Core — pure model + math. No DOM, no Web Audio, no Cade.
  // =========================================================================
  var Core = (function () {
    var MAX = 32, LENS = [8, 16, 32], NPAT = 4, PAT_CH = 'ABCD';
    var TRACKS = [
      { id: 'kk', code: 'KK', name: 'Kick', note: false, vol: 0.9, pan: 0 },
      { id: 'sn', code: 'SN', name: 'Snare', note: false, vol: 0.74, pan: 0 },
      { id: 'cp', code: 'CP', name: 'Clap', note: false, vol: 0.62, pan: 0.06 },
      { id: 'ch', code: 'CH', name: 'Closed hat', note: false, vol: 0.5, pan: 0.2 },
      { id: 'oh', code: 'OH', name: 'Open hat', note: false, vol: 0.42, pan: 0.16 },
      { id: 'tm', code: 'TM', name: 'Low tom', note: false, vol: 0.64, pan: -0.14 },
      { id: 'rm', code: 'RM', name: 'Rim', note: false, vol: 0.5, pan: -0.2 },
      { id: 'cb', code: 'CB', name: 'Cowbell', note: false, vol: 0.38, pan: -0.26 },
      { id: 'sh', code: 'SH', name: 'Shaker', note: false, vol: 0.44, pan: 0.3 },
      { id: 'bs', code: 'BS', name: 'Bass', note: true, vol: 0.78, pan: 0 },
      { id: 'ky', code: 'KY', name: 'Keys', note: true, vol: 0.52, pan: 0 }
    ];
    var NT = TRACKS.length, BS = 9, KY = 10, KK = 0, SN = 1, CP = 2, CH = 3, OH = 4, TM = 5, RM = 6, CB = 7, SH = 8;
    // velocity levels: 0 off · 1 ghost · 2 normal · 3 accent
    var VEL_GAIN = [0, 0.42, 0.74, 1];
    var VEL_CH = '-gxX';
    var DEG_CH = '123456789abcdef';          // tab: scale degree, 1 = root
    var MAX_DEG = 21;

    var SCALES = {
      minor: { name: 'minor', steps: [0, 2, 3, 5, 7, 8, 10] },
      major: { name: 'major', steps: [0, 2, 4, 5, 7, 9, 11] },
      dorian: { name: 'dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
      phrygian: { name: 'phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
      mixolydian: { name: 'mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
      harmonic: { name: 'harm. minor', steps: [0, 2, 3, 5, 7, 8, 11] },
      pentmin: { name: 'pent. minor', steps: [0, 3, 5, 7, 10] },
      pentmaj: { name: 'pent. major', steps: [0, 2, 4, 7, 9] },
      blues: { name: 'blues', steps: [0, 3, 5, 6, 7, 10] }
    };
    var SCALE_ORDER = ['minor', 'major', 'dorian', 'phrygian', 'mixolydian', 'harmonic', 'pentmin', 'pentmaj', 'blues'];
    var NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

    // Drum kits: synthesis parameters read by the audio engine.
    //  kick  level kv (default 1), kf0→kf1 Hz over kpd s, amp decay kd, click kc, bus drive kdrv
    //  snare tone st Hz (decay std), noise level sn (decay snd) above shp Hz
    //  clap decay cld · hats high-pass hhp, closed hd / open ohd, metal hm / noise hn
    //  tom tf Hz / td · rim 'rim'|'clave' · shaker decay shd
    var KITS = {
      '909': { name: '909 punch', kf0: 200, kf1: 50, kpd: 0.05, kd: 0.42, kc: 0.55, kdrv: 1.7, st: 195, std: 0.09, sn: 0.85, snd: 0.19, shp: 1500, cld: 0.2, hhp: 7600, hd: 0.05, ohd: 0.36, hm: 0.5, hn: 0.65, tf: 150, td: 0.4, rim: 'rim', shd: 0.07 },
      '808': { name: '808 boom', kv: 0.8, kf0: 135, kf1: 42, kpd: 0.085, kd: 1.05, kc: 0.2, kdrv: 2.2, st: 175, std: 0.12, sn: 0.62, snd: 0.16, shp: 1900, cld: 0.24, hhp: 8200, hd: 0.045, ohd: 0.42, hm: 1.1, hn: 0.55, tf: 120, td: 0.5, rim: 'rim', shd: 0.08 },
      studio: { name: 'studio kit', kf0: 120, kf1: 54, kpd: 0.04, kd: 0.32, kc: 0.75, kdrv: 1.3, st: 205, std: 0.07, sn: 1, snd: 0.26, shp: 900, cld: 0.18, hhp: 6400, hd: 0.06, ohd: 0.5, hm: 0.35, hn: 0.6, tf: 115, td: 0.45, rim: 'rim', shd: 0.07 },
      dusty: { name: 'dusty (lo-fi)', kv: 0.88, kf0: 150, kf1: 46, kpd: 0.06, kd: 0.5, kc: 0.25, kdrv: 1.9, st: 185, std: 0.1, sn: 0.72, snd: 0.22, shp: 1100, cld: 0.22, hhp: 5600, hd: 0.04, ohd: 0.3, hm: 0.4, hn: 0.7, tf: 130, td: 0.42, rim: 'clave', shd: 0.09 }
    };
    var KIT_ORDER = ['909', '808', 'studio', 'dusty'];
    var BASS_SOUNDS = { sub: '808 sub', acid: 'acid', saw: 'saw / reese' };
    var BASS_ORDER = ['sub', 'acid', 'saw'];
    var KEY_SOUNDS = { stab: 'chord stab', keys: 'EP chords', pluck: 'pluck', lead: 'lead', bell: 'bell' };
    var KEY_ORDER = ['stab', 'keys', 'pluck', 'lead', 'bell'];

    function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
    function num(x, a, b, d) { x = +x; return isFinite(x) ? clamp(x, a, b) : d; }
    function str(x, n) { return typeof x === 'string' ? x.slice(0, n) : ''; }
    function zeros(n) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = 0; return a; }

    // ---- model ----------------------------------------------------------------
    function emptyPattern(len) {
      var p = { len: LENS.indexOf(len) >= 0 ? len : 16, v: [], n: [] };
      for (var t = 0; t < NT; t++) { p.v.push(zeros(MAX)); p.n.push(zeros(MAX)); }
      return p;
    }
    function defaultMix() {
      var m = [];
      for (var t = 0; t < NT; t++) m.push({ vol: TRACKS[t].vol, mute: false, solo: false });
      return m;
    }
    function emptySong() {
      var s = {
        v: 1, id: '', name: 'Untitled', bpm: 100, swing: 0, human: 0, key: 9, scale: 'minor', kit: '909',
        bass: 'sub', keys: 'stab', master: 0.7, tone: 1, echo: 0.25, mode: 'loop', chain: [0], mix: defaultMix(), pats: []
      };
      for (var i = 0; i < NPAT; i++) s.pats.push(emptyPattern(16));
      return s;
    }
    function copyPattern(p) {
      var q = { len: p.len, v: [], n: [] };
      for (var t = 0; t < NT; t++) { q.v.push(p.v[t].slice()); q.n.push(p.n[t].slice()); }
      return q;
    }
    function clearPattern(p) {
      for (var t = 0; t < NT; t++) for (var s = 0; s < MAX; s++) { p.v[t][s] = 0; p.n[t][s] = 0; }
    }
    function patternHits(p, t0, t1) {
      var n = 0;
      for (var t = t0 || 0; t < (t1 == null ? NT : t1); t++) for (var s = 0; s < p.len; s++) if (p.v[t][s]) n++;
      return n;
    }
    function trackHits(p, t) { return patternHits(p, t, t + 1); }

    // Compact JSON form (what Cade.store holds): one char per step.
    function serialize(s) {
      var o = {
        v: 1, id: s.id, name: s.name, bpm: s.bpm, swing: s.swing, human: s.human, key: s.key, scale: s.scale, kit: s.kit,
        bass: s.bass, keys: s.keys, master: s.master, tone: s.tone, echo: s.echo, mode: s.mode,
        chain: s.chain.map(function (i) { return PAT_CH[i]; }).join(''),
        mix: s.mix.map(function (m) { return [Math.round(m.vol * 100) / 100, m.mute ? 1 : 0, m.solo ? 1 : 0]; }),
        pats: []
      };
      for (var i = 0; i < NPAT; i++) {
        var p = s.pats[i], po = { len: p.len, t: {}, n: {} };
        for (var t = 0; t < NT; t++) {
          if (!trackHits(p, t)) continue;
          var vs = '', ns = '';
          for (var k = 0; k < MAX; k++) { vs += VEL_CH[p.v[t][k]]; ns += p.n[t][k].toString(36); }
          po.t[TRACKS[t].code] = vs;
          if (TRACKS[t].note) po.n[TRACKS[t].code] = ns;
        }
        o.pats.push(po);
      }
      return o;
    }
    // Anything (old, foreign, damaged) → a valid in-memory song.
    function normalizeSong(o) {
      var s = emptySong();
      if (!o || typeof o !== 'object') return s;
      s.id = str(o.id, 40).replace(/[^a-z0-9]/gi, '');
      s.name = str(o.name, 60).replace(/[\r\n]+/g, ' ').trim() || 'Untitled';
      s.bpm = Math.round(num(o.bpm, 60, 200, 100));
      s.swing = Math.round(num(o.swing, 0, 100, 0));
      s.human = Math.round(num(o.human, 0, 100, 0));
      s.key = Math.round(num(o.key, 0, 11, 9));
      s.scale = SCALES[o.scale] ? o.scale : 'minor';
      s.kit = KITS[o.kit] ? o.kit : '909';
      s.bass = BASS_SOUNDS[o.bass] ? o.bass : 'sub';
      s.keys = KEY_SOUNDS[o.keys] ? o.keys : 'stab';
      s.master = num(o.master, 0, 1, 0.7);
      s.tone = num(o.tone, 0, 1, 1);
      s.echo = num(o.echo, 0, 1, 0.25);
      s.mode = o.mode === 'song' ? 'song' : 'loop';
      var ch = typeof o.chain === 'string' ? o.chain.toUpperCase().replace(/[^ABCD]/g, '').split('').map(function (c) { return PAT_CH.indexOf(c); })
        : Array.isArray(o.chain) ? o.chain.filter(function (i) { return i === (i | 0) && i >= 0 && i < NPAT; }) : [];
      s.chain = ch.length ? ch.slice(0, 16) : [0];
      if (Array.isArray(o.mix)) {
        for (var t = 0; t < NT; t++) {
          var m = o.mix[t];
          if (Array.isArray(m)) s.mix[t] = { vol: num(m[0], 0, 1, TRACKS[t].vol), mute: !!m[1], solo: !!m[2] };
          else if (m && typeof m === 'object') s.mix[t] = { vol: num(m.vol, 0, 1, TRACKS[t].vol), mute: !!m.mute, solo: !!m.solo };
        }
      }
      if (Array.isArray(o.pats)) {
        for (var i = 0; i < NPAT; i++) {
          var po = o.pats[i], p = s.pats[i];
          if (!po || typeof po !== 'object') continue;
          p.len = LENS.indexOf(+po.len) >= 0 ? +po.len : 16;
          for (var tt = 0; tt < NT; tt++) {
            var code = TRACKS[tt].code;
            var vs = po.t && typeof po.t[code] === 'string' ? po.t[code] : '';
            var ns = po.n && typeof po.n[code] === 'string' ? po.n[code] : '';
            for (var k = 0; k < MAX; k++) {
              var vi = VEL_CH.indexOf(vs.charAt(k));
              p.v[tt][k] = vi > 0 ? vi : 0;
              var d = parseInt(ns.charAt(k), 36);
              p.n[tt][k] = isFinite(d) ? clamp(d, 0, MAX_DEG) : 0;
            }
          }
        }
      }
      return s;
    }
    function cloneSong(s) { return normalizeSong(JSON.parse(JSON.stringify(serialize(s)))); }

    // ---- presets ----------------------------------------------------------------
    // Drum rows: '.' off · 'g' ghost · 'x' hit · 'X' accent. Note rows: '.' off, a
    // scale degree in base 36 ('0' = root, '7' = an octave up in a 7-note scale);
    // an optional "<CODE>v" row overlays velocities on a note row.
    var PRESETS = [
      { name: 'House', style: 'four-on-the-floor', bpm: 124, swing: 12, key: 5, scale: 'minor', kit: '909', bass: 'saw', keys: 'stab', chain: 'AABB', pats: [
        { KK: 'x...x...x...x...', CP: '....x.......x...', CH: 'g...g...g...g...', OH: '..X...X...X...X.', SH: '.g.g.g.g.g.g.g.g', BS: '..0...0...0..30.', KY: '...0..0....0..0.' },
        { KK: 'x...x...x...x...', CP: '....x.......x..g', CH: 'g...g...g...g...', OH: '..X...X...X...X.', SH: '.g.g.g.g.g.g.g.g', RM: '.......x......x.', BS: '..5...5...5..45.', KY: '...5..5....5..5.' }] },
      { name: 'Boom Bap', style: 'dusty hip-hop', bpm: 90, swing: 55, key: 2, scale: 'minor', kit: 'dusty', bass: 'sub', keys: 'keys', chain: 'AAAB', pats: [
        { KK: 'x......x..x.....', SN: '....X.......X...', CH: 'x.x.x.x.x.x.x.x.', OH: '..............x.', BS: '0......0..5.....', KY: '0.......5.......' },
        { KK: 'x......x..x...x.', SN: '....X..g....X..g', CH: 'x.x.x.x.x.x.x.xx', OH: '......x.........', BS: '3......3..4.....', KY: '3.......4.......' }] },
      { name: 'Techno', style: 'warehouse acid', bpm: 130, swing: 0, key: 9, scale: 'minor', kit: '909', bass: 'acid', keys: 'pluck', chain: 'AABB', pats: [
        { KK: 'x...x...x...x...', CP: '....x.......x...', CH: 'g...g...g...g...', OH: '..x...x...x...x.', RM: '...x..x....x.x..', BS: '0.70.0.30.70.0.5', BSv: '..X.......X....X' },
        { KK: 'x...x...x...x...', CP: '....x.......x...', CH: 'g...g...g...g...', OH: '..x...x...x...x.', SH: '.g.g.g.g.g.g.g.g', TM: '..........x..x..', BS: '0.70.0.30.70.0.5', BSv: 'X.....X...X....X', KY: '7..5..3...7..5..' }] },
      { name: 'Trap', style: '808s + hat rolls', bpm: 140, swing: 0, key: 7, scale: 'minor', kit: '808', bass: 'sub', keys: 'bell', chain: 'AB', pats: [
        { KK: 'x.......x.x.....', SN: '........x.......', CP: '........X.......', CH: 'x.x.x.x.x.x.xxxx', BS: '0.......0.7.....', KY: '7...4...5...3...' },
        { KK: 'x.....x...x..x..', SN: '........x.....g.', CP: '........X.......', CH: 'x.x.x.xxx.x.xgXg', OH: '.......x........', BS: '0.....0...7..5..', KY: '7...4...2...0...' }] },
      { name: 'Dembow', style: 'reggaeton', bpm: 96, swing: 0, key: 11, scale: 'minor', kit: '808', bass: 'sub', keys: 'stab', chain: 'AB', pats: [
        { KK: 'x...x...x...x...', SN: '...X..X....X..X.', SH: 'g.x.g.x.g.x.g.x.', CH: '..g...g...g...g.', BS: '0.......5.......', KY: '0..0..0.5..5..5.' },
        { KK: 'x...x...x...x...', SN: '...X..X....X..X.', SH: 'g.x.g.x.g.x.g.x.', CH: '..g...g...g...g.', TM: '............x.x.', BS: '2.......6.......', KY: '2..2..2.6..6..6.' }] },
      { name: 'Rock', style: 'straight 8ths', bpm: 112, swing: 0, key: 4, scale: 'pentmin', kit: 'studio', bass: 'saw', keys: 'lead', chain: 'AABC', pats: [
        { KK: 'x.....x.x.......', SN: '....X.......X...', CH: 'X.x.X.x.X.x.X.x.', BS: '0.0.0.0.2.2.3.3.' },
        { KK: 'x.....x.x.x.....', SN: '....X.......X...', OH: 'x.x.x.x.x.x.x.x.', BS: '2.2.2.2.0.0.4.4.', KY: '5.......6...7...' },
        { KK: 'x.....x.x.......', SN: '....X.......xXXX', TM: '........x.x.x...', CH: 'X.x.X.x.........', BS: '0.0.0.0.3.3.4.4.' }] },
      { name: 'Funk', style: 'ghost-note groove', bpm: 104, swing: 30, key: 4, scale: 'dorian', kit: 'studio', bass: 'saw', keys: 'stab', chain: 'AABA', pats: [
        { KK: 'x.x.......x..x..', SN: '....X..g.g..X..g', CH: 'xgxgXgxgxgxgXg.g', OH: '..............x.', CB: '..x.....', BS: '0.70..0.3..30.75', KY: '..0...0...0..0..' },
        { KK: 'x.x.......x..x..', SN: '....X..g.g..X..g', CH: 'xgxgXgxgxgxgXg.g', OH: '..............x.', BS: '3.03..3.5..53.30', KY: '..3...3...3..3..' }] },
      { name: 'Drum & Bass', style: 'two-step + amen', bpm: 172, swing: 0, key: 5, scale: 'minor', kit: '909', bass: 'saw', keys: 'keys', chain: 'AAAB', pats: [
        { KK: 'x.........x.....', SN: '....X.......X...', CH: 'x.x.x.x.x.x.x.x.', SH: '.g.g.g.g.g.g.g.g', BS: '0...............', KY: '0...............' },
        { KK: 'x.x.......xx....', SN: '....X..g.g..X..g', CH: 'x.x.x.x.x.x.x.x.', OH: '..........x.....', BS: '5.......3.......', KY: '5.......3.......' }] },
      { name: 'Lo-fi', style: 'lazy jazz chords', bpm: 78, swing: 45, key: 3, scale: 'major', kit: 'dusty', bass: 'sub', keys: 'keys', tone: 0.55, chain: 'AABB', pats: [
        { KK: 'x.....x...x.....', SN: '....x.......x...', CH: 'x.g.x.gxx.g.x.g.', RM: '..........g.....', BS: '0.....0...3.....', KY: '0.......3.......' },
        { KK: 'x.....x...x...g.', SN: '....x.......x...', CH: 'x.g.x.gxx.g.x.gg', BS: '1.....1...4.....', KY: '1.......4.......' }] }
    ];
    function velOf(ch) {
      switch (ch) {
        case 'X': case 'O': case '#': case '@': return 3;
        case 'x': case 'o': case '*': case '+': case 'f': case 'd': case 'r': return 2;
        case 'g': case '(': return 1;
      }
      if (ch >= '1' && ch <= '9') { var d = +ch; return d <= 3 ? 1 : d <= 7 ? 2 : 3; }
      return 0;
    }
    function codeIndex(code) {
      for (var t = 0; t < NT; t++) if (TRACKS[t].code === code) return t;
      return -1;
    }
    function presetSong(i) {
      var ps = PRESETS[i], s = emptySong();
      if (!ps) return s;
      s.name = ps.name; s.bpm = ps.bpm; s.swing = ps.swing; s.key = ps.key; s.scale = ps.scale; s.kit = ps.kit;
      s.bass = ps.bass; s.keys = ps.keys; s.tone = ps.tone != null ? ps.tone : 1; s.mode = 'song';
      s.chain = ps.chain.split('').map(function (c) { return PAT_CH.indexOf(c); });
      ps.pats.forEach(function (rows, pi) {
        var p = s.pats[pi], len = 8;
        Object.keys(rows).forEach(function (code) {
          if (/v$/.test(code)) return;
          var t = codeIndex(code), row = rows[code], over = rows[code + 'v'] || '';
          if (t < 0) return;
          len = Math.max(len, row.length);
          for (var k = 0; k < row.length && k < MAX; k++) {
            var ch = row.charAt(k);
            if (TRACKS[t].note) {
              if (ch === '.') continue;
              p.v[t][k] = velOf(over.charAt(k)) || 2; p.n[t][k] = parseInt(ch, 36) || 0;
            } else p.v[t][k] = velOf(ch);
          }
        });
        p.len = len <= 8 ? 8 : len <= 16 ? 16 : 32;
      });
      return s;
    }

    // ---- timing ---------------------------------------------------------------
    // A step is a 16th note. Swing delays every odd 16th by up to half a step
    // (0% straight · ~66% triplet feel · 100% dotted).
    function stepDur(bpm) { return 15 / bpm; }
    function swingOffset(step, bpm, swing) { return (step & 1) ? clamp(swing, 0, 100) / 100 * 0.5 * stepDur(bpm) : 0; }
    function stepTime(start, step, bpm, swing) { return start + step * stepDur(bpm) + swingOffset(step, bpm, swing); }
    function barDur(bpm) { return 16 * stepDur(bpm); }
    // How many steps until this track's next hit (wrapping) — a note rings that long.
    function noteSteps(p, t, s) {
      var len = p.len, row = p.v[t];
      for (var k = 1; k <= len; k++) if (row[(s + k) % len]) return k;
      return len;
    }
    // Pattern / chain playback order.
    function Cursor(song, mode, pat) {
      this.song = song; this.mode = mode === 'song' ? 'song' : 'loop';
      this.chainPos = 0; this.pat = this.mode === 'song' ? song.chain[0] : (pat | 0); this.step = 0; this.cue = -1; this.loops = 0;
    }
    Cursor.prototype.advance = function () {
      this.step++;
      var len = this.song.pats[this.pat].len;
      if (this.step < len) return false;
      this.step = 0; this.loops++;
      if (this.mode === 'song') {
        var ch = this.song.chain;
        this.chainPos = (this.chainPos + 1) % ch.length;
        this.pat = ch[this.chainPos];
      } else if (this.cue >= 0) { this.pat = this.cue; this.cue = -1; }
      return true;
    };
    function songSteps(song) {
      var n = 0;
      for (var i = 0; i < song.chain.length; i++) n += song.pats[song.chain[i]].len;
      return n;
    }
    // Every hit for `steps` steps from the start: [{time, track, vel, deg, len, step, pat}].
    function plan(song, opts) {
      opts = opts || {};
      var cur = new Cursor(song, opts.mode || 'loop', opts.pat || 0), sd = stepDur(song.bpm), ev = [], t = 0;
      for (var k = 0; k < opts.steps; k++) {
        var p = song.pats[cur.pat], s = cur.step, at = t + swingOffset(s, song.bpm, song.swing);
        for (var tr = 0; tr < NT; tr++) {
          var v = p.v[tr][s];
          if (!v) continue;
          ev.push({ time: at, track: tr, vel: v, deg: p.n[tr][s], len: TRACKS[tr].note ? noteSteps(p, tr, s) * sd : 0, step: s, pat: cur.pat });
        }
        t += sd;
        cur.advance();
      }
      return { events: ev, duration: t, stepDur: sd };
    }
    // A live tap at audio time t → the nearest step, from an anchor step that has sounded.
    function quantize(t, anchorTime, anchorStep, sd, len) {
      var k = Math.round((t - anchorTime) / sd);
      return { k: k, step: ((anchorStep + k) % len + len) % len };
    }
    // Tap tempo from ascending tap times (s); null until two close taps.
    function tapTempo(times) {
      var iv = [];
      for (var i = times.length - 1; i > 0 && iv.length < 4; i--) {
        var d = times[i] - times[i - 1];
        if (d > 2 || d < 0.25) break;
        iv.push(d);
      }
      if (!iv.length) return null;
      var sum = 0;
      for (var j = 0; j < iv.length; j++) sum += iv[j];
      return clamp(Math.round(60 / (sum / iv.length)), 60, 200);
    }

    // ---- notes ----------------------------------------------------------------
    function rootMidi(track, key) { return (track === BS ? 36 : 60) + key - (key >= 7 ? 12 : 0); }
    function degreeMidi(deg, key, scale, track) {
      var st = (SCALES[scale] || SCALES.minor).steps, n = st.length, o = Math.floor(deg / n);
      return rootMidi(track, key) + st[deg - o * n] + 12 * o;
    }
    function midiFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
    // Spelling: a 7-note scale gets one letter per degree (F minor → Db, not C#); the
    // others follow the key signature of their parent major (flats for F, Bb, Eb, Ab, Db, C).
    var SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    var FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
    var PARENT = { major: 0, minor: 3, dorian: 10, phrygian: 8, mixolydian: 5, harmonic: 3, pentmin: 3, pentmaj: 0, blues: 3 };
    var FLAT_PARENT = { 0: 1, 1: 1, 3: 1, 5: 1, 8: 1, 10: 1 };
    var LETTERS = 'CDEFGAB', NATURAL = [0, 2, 4, 5, 7, 9, 11], spellCache = {};
    function keyNames(key, scale) { return FLAT_PARENT[(key + (PARENT[scale] || 0)) % 12] ? FLATS : SHARPS; }
    function rootName(key, scale) { return keyNames(key, scale)[key]; }
    function spellScale(key, scale) {
      var ck = key + ':' + scale;
      if (spellCache[ck]) return spellCache[ck];
      var st = (SCALES[scale] || SCALES.minor).steps, names = keyNames(key, scale), out = [], i;
      if (st.length === 7) {
        var li = LETTERS.indexOf(names[key].charAt(0));
        for (i = 0; i < 7; i++) {
          var L = (li + i) % 7, pc = (key + st[i]) % 12, d = ((pc - NATURAL[L]) % 12 + 12) % 12;
          if (d > 6) d -= 12;
          out.push(LETTERS.charAt(L) + (d === 1 ? '#' : d === 2 ? '##' : d === -1 ? 'b' : d === -2 ? 'bb' : ''));
        }
      } else for (i = 0; i < st.length; i++) out.push(names[(key + st[i]) % 12]);
      return (spellCache[ck] = out);
    }
    // MIDI → name; with key + scale, notes of the scale are spelled in that key.
    function noteName(m, oct, key, scale) {
      var pc = ((m % 12) + 12) % 12, nm = NOTE_NAMES[pc];
      if (key != null && scale) {
        var st = (SCALES[scale] || SCALES.minor).steps, i = st.indexOf(((pc - key) % 12 + 12) % 12);
        nm = i >= 0 ? spellScale(key, scale)[i] : keyNames(key, scale)[pc];
      }
      return nm + (oct === false ? '' : (Math.floor(m / 12) - 1));
    }
    function scaleLen(scale) { return (SCALES[scale] || SCALES.minor).steps.length; }
    // Chord tones (as degrees) stacked in thirds of the scale.
    function chordDegrees(deg, n) { var a = []; for (var i = 0; i < n; i++) a.push(deg + 2 * i); return a; }

    // ---- pattern tools ----------------------------------------------------------
    function shiftPattern(p, dir) {
      var len = p.len;
      for (var t = 0; t < NT; t++) {
        var v = p.v[t].slice(0, len), n = p.n[t].slice(0, len);
        for (var s = 0; s < len; s++) {
          var j = ((s - dir) % len + len) % len;
          p.v[t][s] = v[j]; p.n[t][s] = n[j];
        }
      }
    }
    function pick(rng, a) { return a[Math.floor(rng() * a.length) % a.length]; }
    // A fresh, groove-shaped pattern (density per track and step position).
    function randomizePattern(p, rng, scale) {
      var len = p.len, sl = scaleLen(scale);
      clearPattern(p);
      var use = { cp: rng() < 0.45, oh: rng() < 0.55, tm: rng() < 0.3, rm: rng() < 0.4, cb: rng() < 0.2, sh: rng() < 0.4, ky: rng() < 0.75 };
      var bassDeg = [0, 0, 0, sl, 3, 4, 5, 2], keyDeg = [0, 0, 3, 4, 5, 2];
      for (var s = 0; s < len; s++) {
        var q = s % 16, even = !(q & 1);
        var kp = q === 0 ? 1 : q === 8 ? 0.7 : (q === 10 || q === 6 || q === 14 || q === 7) ? 0.28 : even ? 0.1 : 0.05;
        if (rng() < kp) p.v[KK][s] = q === 0 ? 3 : 2;
        if (q === 4 || q === 12) p.v[SN][s] = rng() < 0.9 ? 3 : 2;
        else if (rng() < 0.07) p.v[SN][s] = 1;
        if (use.cp && (q === 12 || (q === 4 && rng() < 0.5) || rng() < 0.02)) p.v[CP][s] = 2;
        if (rng() < (even ? 0.8 : 0.3)) p.v[CH][s] = even ? (q % 4 === 0 ? 3 : 2) : 1;
        if (use.oh && q % 4 === 2 && rng() < 0.5) { p.v[OH][s] = 2; p.v[CH][s] = 0; }
        if (use.tm && rng() < (q >= 12 ? 0.25 : 0.05)) p.v[TM][s] = 2;
        if (use.rm && rng() < (even ? 0.06 : 0.16)) p.v[RM][s] = rng() < 0.5 ? 1 : 2;
        if (use.cb && rng() < 0.1) p.v[CB][s] = 2;
        if (use.sh && rng() < 0.6) p.v[SH][s] = even ? 1 : 2;
        if (rng() < (p.v[KK][s] ? 0.75 : 0.1)) { p.v[BS][s] = 2; p.n[BS][s] = pick(rng, bassDeg); }
        if (use.ky && rng() < (q === 0 || q === 8 ? 0.6 : even ? 0.1 : 0.06)) { p.v[KY][s] = 2; p.n[KY][s] = pick(rng, keyDeg); }
      }
    }
    // A variation of what's there: a few hits move, velocities wobble, notes step.
    function mutatePattern(p, rng, scale) {
      var len = p.len, sl = scaleLen(scale);
      for (var t = 0; t < NT; t++) {
        if (!trackHits(p, t)) continue;
        for (var s = 0; s < len; s++) {
          var v = p.v[t][s], keep = (t === KK && s % 16 === 0) || (t === SN && s % 16 % 8 === 4);
          if (v) {
            var r = rng();
            if (r < 0.07 && !keep) p.v[t][s] = 0;
            else if (r < 0.2) p.v[t][s] = 1 + Math.floor(rng() * 3);
            if (TRACKS[t].note && p.v[t][s] && rng() < 0.18) p.n[t][s] = clamp(p.n[t][s] + pick(rng, [-2, -1, 1, 2, sl]), 0, sl * 2);
          } else if (rng() < (TRACKS[t].note ? 0.03 : 0.05)) {
            p.v[t][s] = TRACKS[t].note ? 2 : (rng() < 0.5 ? 1 : 2);
            if (TRACKS[t].note) {
              var prev = 0;
              for (var j = s - 1; j >= 0; j--) if (p.v[t][j]) { prev = p.n[t][j]; break; }
              p.n[t][s] = prev;
            }
          }
        }
      }
    }

    // ---- ASCII drum tab ---------------------------------------------------------
    // vel: a note track's velocity lane ("BSv |--X-|"), written only when it isn't all plain hits.
    function tabRow(p, t, vel) {
      var row = '';
      for (var s = 0; s < p.len; s++) {
        if (s && s % 16 === 0) row += '|';
        var v = p.v[t][s];
        row += !v ? '-' : TRACKS[t].note && !vel ? DEG_CH.charAt(Math.min(p.n[t][s], DEG_CH.length - 1)) : VEL_CH.charAt(v);
      }
      return TRACKS[t].code + (vel ? 'v|' : ' |') + row + '|';
    }
    function plainVel(p, t) { for (var s = 0; s < p.len; s++) if (p.v[t][s] && p.v[t][s] !== 2) return false; return true; }
    function tabHeader(song, label) {
      return 'Beat Maker · ' + song.name + (label ? ' · ' + label : '') + ' · ' + song.bpm + ' BPM' +
        (song.swing ? ' · swing ' + song.swing + '%' : '') + ' · ' + rootName(song.key, song.scale) + ' ' + SCALES[song.scale].name;
    }
    // One pattern, or (all: true) every pattern the chain uses + the chain.
    function toTab(song, pi, all) {
      var out = [], used = [], notes = false, lanes = false, i, t;
      if (all) { for (i = 0; i < song.chain.length; i++) if (used.indexOf(song.chain[i]) < 0) used.push(song.chain[i]); used.sort(); }
      else used = [pi];
      out.push(tabHeader(song, all ? 'song' : 'pattern ' + PAT_CH[pi]));
      used.forEach(function (k) {
        var p = song.pats[k], rows = [];
        for (t = 0; t < NT; t++) {
          if (!trackHits(p, t)) continue;
          rows.push(tabRow(p, t));
          if (!TRACKS[t].note) continue;
          notes = true;
          if (!plainVel(p, t)) { rows.push(tabRow(p, t, true)); lanes = true; }
        }
        if (all) out.push('[' + PAT_CH[k] + '] ' + p.len + ' steps');
        if (!rows.length) rows.push('KK |' + new Array(p.len + 1).join('-') + '|');
        out.push.apply(out, rows);
      });
      if (all) out.push('chain: ' + song.chain.map(function (c) { return PAT_CH[c]; }).join(' '));
      if (notes) out.push('(BS, KY = scale degrees, 1 = root' + (lanes ? ' · BSv, KYv = their velocities' : '') + ')');
      return out.join('\n');
    }
    var ALIAS = {
      KK: KK, BD: KK, KD: KK, K: KK, KICK: KK, B: KK,
      SN: SN, SD: SN, S: SN, SNARE: SN,
      CP: CP, CLAP: CP, HC: CP,
      CH: CH, HH: CH, H: CH, HAT: CH, CHH: CH,
      OH: OH, O: OH, OHH: OH, HO: OH, CY: OH, CR: OH, RD: OH, RC: OH, CC: OH,
      TM: TM, T: TM, LT: TM, MT: TM, HT: TM, FT: TM, TOM: TM, T1: TM, T2: TM,
      RM: RM, RS: RM, RIM: RM, CL: RM, CLAVE: RM,
      CB: CB, COW: CB, BELL: CB,
      SH: SH, MA: SH, SK: SH, SHAKER: SH, TB: SH,
      BS: BS, BA: BS, BASS: BS,
      KY: KY, KEYS: KY, KEY: KY, LD: KY, LEAD: KY, ST: KY, STAB: KY, CHD: KY, SY: KY, PL: KY
    };
    // Text → { blocks: [{pat, len, rows: [{track, v[], n[]}]}], chain, bpm, swing, tracks, unknown[] }.
    function fromTab(text) {
      var res = { blocks: [], chain: null, bpm: null, swing: null, tracks: 0, unknown: [] };
      var blk = null, lines = String(text || '').split(/\r?\n/);
      function block(pat) { blk = { pat: pat, len: 0, rows: [], lanes: {} }; res.blocks.push(blk); return blk; }
      lines.forEach(function (line) {
        var m;
        if (res.bpm == null && (m = /(\d{2,3}(?:\.\d+)?)\s*bpm/i.exec(line))) res.bpm = clamp(Math.round(+m[1]), 60, 200);
        if (res.swing == null && (m = /swing\s*:?\s*(\d{1,3})\s*%/i.exec(line))) res.swing = clamp(+m[1], 0, 100);
        if ((m = /^\s*chain\s*:?\s*([A-D](?:[\s,>\-]*[A-D])*)\s*$/i.exec(line))) {
          res.chain = m[1].toUpperCase().replace(/[^A-D]/g, '').split('').map(function (c) { return PAT_CH.indexOf(c); }).slice(0, 16);
          return;
        }
        if ((m = /^\s*\[([A-D])\]/i.exec(line)) || (m = /^\s*pattern\s+([A-D])\b/i.exec(line))) { block(PAT_CH.indexOf(m[1].toUpperCase())); return; }
        var bar = line.indexOf('|');
        if (bar < 1) return;
        var name = line.slice(0, bar).trim().toUpperCase().replace(/[\s:.]+$/, '');
        if (!/^[A-Z][A-Z0-9]{0,6}$/.test(name)) return;
        var body = line.slice(bar + 1).replace(/\|\s*$/, '').replace(/[|\s]/g, '');
        if (!body.length) return;
        var t = Object.prototype.hasOwnProperty.call(ALIAS, name) ? ALIAS[name] : -1, k;
        var lane = t < 0 && /V$/.test(name) && Object.prototype.hasOwnProperty.call(ALIAS, name.slice(0, -1)) ? ALIAS[name.slice(0, -1)] : -1;
        if (lane >= 0 && TRACKS[lane].note) {
          if (!blk) block(-1);
          var lv = zeros(MAX);
          for (k = 0; k < Math.min(body.length, MAX); k++) lv[k] = velOf(body.charAt(k));
          blk.lanes[lane] = lv;
          return;
        }
        if (t < 0) { if (res.unknown.indexOf(name) < 0) res.unknown.push(name); return; }
        if (!blk) block(-1);
        var row = { track: t, v: zeros(MAX), n: zeros(MAX) }, len = Math.min(body.length, MAX);
        for (k = 0; k < len; k++) {
          var ch = body.charAt(k);
          if (TRACKS[t].note) {
            var d = DEG_CH.indexOf(ch.toLowerCase());
            if (d >= 0) { row.v[k] = ch !== ch.toLowerCase() ? 3 : 2; row.n[k] = d; }
            else if (velOf(ch) && !/[0-9]/.test(ch)) { row.v[k] = velOf(ch); row.n[k] = 0; }
          } else row.v[k] = velOf(ch);
        }
        blk.len = Math.max(blk.len, body.length);
        // a later row for the same track in one block wins
        blk.rows = blk.rows.filter(function (r) { return r.track !== t; });
        blk.rows.push(row);
      });
      res.blocks.forEach(function (b) {
        b.rows.forEach(function (r) {
          var lv = b.lanes[r.track];
          if (lv) for (var k = 0; k < MAX; k++) if (r.v[k] && lv[k]) r.v[k] = lv[k];
        });
        delete b.lanes;
      });
      res.blocks = res.blocks.filter(function (b) { return b.rows.length; });
      res.blocks.forEach(function (b) { b.len = b.len <= 8 ? 8 : b.len <= 16 ? 16 : 32; res.tracks += b.rows.length; });
      return res;
    }
    // Write a parsed tab into the song: labelled blocks into their patterns, an
    // unlabelled one into `cur`. Returns the patterns written.
    function applyTab(song, parsed, cur) {
      var done = [];
      parsed.blocks.forEach(function (b, i) {
        var pi = b.pat >= 0 ? b.pat : (i === 0 ? cur : -1);
        if (pi < 0 || done.indexOf(pi) >= 0) return;
        var p = song.pats[pi];
        clearPattern(p);
        p.len = b.len;
        b.rows.forEach(function (r) { p.v[r.track] = r.v.slice(); p.n[r.track] = r.n.slice(); });
        done.push(pi);
      });
      if (parsed.bpm) song.bpm = parsed.bpm;
      if (parsed.swing != null) song.swing = parsed.swing;
      if (parsed.chain && parsed.chain.length && done.length > 1) { song.chain = parsed.chain; }
      return done;
    }

    // ---- WAV ------------------------------------------------------------------------
    // Fold everything past loopLen back onto the start so the file loops seamlessly
    // (the tails of the last bar ring into the first, as they do when looping live).
    function foldTail(chans, loopLen) {
      return chans.map(function (c) {
        var o = new Float32Array(loopLen);
        for (var i = 0; i < c.length; i++) o[i % loopLen] += c[i];
        return o;
      });
    }
    function peak(chans) {
      var m = 0;
      chans.forEach(function (c) { for (var i = 0; i < c.length; i++) { var a = c[i] < 0 ? -c[i] : c[i]; if (a > m) m = a; } });
      return m;
    }
    // 16-bit PCM, interleaved. Returns an ArrayBuffer.
    function encodeWAV(chans, sr) {
      var nc = chans.length, n = chans[0].length, bytes = n * nc * 2;
      var buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
      function s4(o, t) { for (var j = 0; j < 4; j++) v.setUint8(o + j, t.charCodeAt(j)); }
      s4(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); s4(8, 'WAVE');
      s4(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
      v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
      s4(36, 'data'); v.setUint32(40, bytes, true);
      var o = 44;
      for (var i = 0; i < n; i++) {
        for (var c = 0; c < nc; c++, o += 2) {
          var x = chans[c][i];
          x = x < -1 ? -1 : x > 1 ? 1 : x;
          v.setInt16(o, x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff), true);
        }
      }
      return buf;
    }
    function wavInfo(buf) {
      var v = new DataView(buf);
      function s4(o) { var s = ''; for (var j = 0; j < 4; j++) s += String.fromCharCode(v.getUint8(o + j)); return s; }
      if (buf.byteLength < 44 || s4(0) !== 'RIFF' || s4(8) !== 'WAVE' || s4(12) !== 'fmt ' || s4(36) !== 'data') return null;
      var nc = v.getUint16(22, true), bits = v.getUint16(34, true), bytes = v.getUint32(40, true);
      return { channels: nc, sampleRate: v.getUint32(24, true), bits: bits, frames: bytes / (nc * bits / 8), dataBytes: bytes, format: v.getUint16(20, true) };
    }

    return {
      MAX: MAX, LENS: LENS, NPAT: NPAT, PAT_CH: PAT_CH, TRACKS: TRACKS, NT: NT, BS: BS, KY: KY, KK: KK, SN: SN, CP: CP, CH: CH, OH: OH,
      TM: TM, RM: RM, CB: CB, SH: SH, VEL_GAIN: VEL_GAIN, VEL_CH: VEL_CH, DEG_CH: DEG_CH, SCALES: SCALES, SCALE_ORDER: SCALE_ORDER,
      NOTE_NAMES: NOTE_NAMES, KITS: KITS, KIT_ORDER: KIT_ORDER, BASS_SOUNDS: BASS_SOUNDS, BASS_ORDER: BASS_ORDER,
      KEY_SOUNDS: KEY_SOUNDS, KEY_ORDER: KEY_ORDER, PRESETS: PRESETS,
      clamp: clamp, emptyPattern: emptyPattern, emptySong: emptySong, copyPattern: copyPattern, clearPattern: clearPattern,
      patternHits: patternHits, trackHits: trackHits, serialize: serialize, normalizeSong: normalizeSong, cloneSong: cloneSong,
      presetSong: presetSong, velOf: velOf, stepDur: stepDur, swingOffset: swingOffset, stepTime: stepTime, barDur: barDur,
      noteSteps: noteSteps, Cursor: Cursor, songSteps: songSteps, plan: plan, quantize: quantize, tapTempo: tapTempo,
      rootMidi: rootMidi, degreeMidi: degreeMidi, midiFreq: midiFreq, noteName: noteName, rootName: rootName, spellScale: spellScale, scaleLen: scaleLen, chordDegrees: chordDegrees,
      shiftPattern: shiftPattern, randomizePattern: randomizePattern, mutatePattern: mutatePattern,
      toTab: toTab, fromTab: fromTab, applyTab: applyTab, foldTail: foldTail, peak: peak, encodeWAV: encodeWAV, wavInfo: wavInfo
    };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  var Cade = window.Cade;
  Cade.loadCSS('beats.css');

  var PANEL_ID = 'beats-panel';
  var K_CUR = 'cade-beats-current', K_PREFS = 'cade-beats-prefs', K_INDEX = 'cade-beats-index', K_SONG = 'cade-beats-song-';
  var AC = window.AudioContext || window.webkitAudioContext;
  var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  var NAV = window.navigator || {};
  var IS_IOS = /iP(hone|ad|od)/.test(NAV.userAgent || '') || (NAV.platform === 'MacIntel' && NAV.maxTouchPoints > 1);
  var T = Core.TRACKS, NT = Core.NT, PAT_CH = Core.PAT_CH;
  var LOOK = 0.1, LOOK_HIDDEN = 1.2, TICK_MS = 25, IDLE_MS = 15000, WAV_MAX_S = 120;
  function esc(s) { return Cade.escapeHtml(String(s)); }
  function noop() {}
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 1800); } catch (e) {} }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // =========================================================================
  // Audio engine. Voices take (ac, R, out, t, gain, …) so the same code plays
  // live and renders in an OfflineAudioContext. R = per-context resources
  // (noise / metal buffers, chokes); every hit's nodes disconnect on end.
  // =========================================================================
  // Master soft clip: linear up to 0.7, then a smooth knee to 0.99; the 0.5 pre-gain
  // lets it take peaks up to +6 dB before anything clips hard.
  var CLIP = null;
  function clipCurve() {
    if (CLIP) return CLIP;
    var n = 2048, c = new Float32Array(n), knee = 0.7, room = 0.29;
    for (var i = 0; i < n; i++) {
      var u = (i / (n - 1) * 2 - 1) * 2, a = Math.abs(u);
      c[i] = (a <= knee ? a : knee + room * Math.tanh((a - knee) / room)) * (u < 0 ? -1 : 1);
    }
    return (CLIP = c);
  }
  function curveTanh(k) {
    var n = 1024, c = new Float32Array(n), d = Math.tanh(k);
    for (var i = 0; i < n; i++) c[i] = Math.tanh(k * (i / (n - 1) * 2 - 1)) / d;
    return c;
  }
  function makeRes(ac) {
    var sr = ac.sampleRate, R = { mono: {}, oh: null, fx: {}, sink: null, crowd: null }, i, k;
    var nb = ac.createBuffer(1, sr, sr), nd = nb.getChannelData(0);
    for (i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    R.noise = nb;
    // TR-808 style metal: six detuned square waves, summed once.
    var ml = Math.floor(sr * 0.8), mb = ac.createBuffer(1, ml, sr), md = mb.getChannelData(0);
    var F = [205.3, 304.4, 369.6, 522.7, 540, 800], ph = [0.1, 0.4, 0.7, 0.2, 0.5, 0.9];
    for (i = 0; i < ml; i++) {
      var s = 0;
      for (k = 0; k < 6; k++) { ph[k] += F[k] / sr; if (ph[k] >= 1) ph[k] -= 1; s += ph[k] < 0.5 ? 1 : -1; }
      md[i] = s / 6;
    }
    R.metal = mb;
    R.drive = curveTanh(2.5);
    return R;
  }
  function toneHz(x) { return 240 * Math.pow(20000 / 240, x); }
  function busGain(song, t) {
    var solo = false;
    for (var i = 0; i < NT; i++) if (song.mix[i].solo) solo = true;
    var m = song.mix[t];
    return m.mute || (solo && !m.solo) ? 0 : m.vol;
  }
  function echoTime(bpm) { return Math.min(1.9, 0.75 * 60 / bpm); } // dotted 8th
  // tracks → (drive) → pan → mix → tone (low-pass) → master → soft clip → out; pads → fx (+ echo) → mix
  function buildGraph(ac, song) {
    var G = { bus: [], shaper: [] };
    G.mix = ac.createGain();
    G.tone = bq(ac, 'lowpass', toneHz(song.tone), 0.8);
    G.master = gn(ac, song.master);
    G.pre = gn(ac, 0.5);
    G.clip = ac.createWaveShaper(); G.clip.curve = clipCurve(); G.clip.oversample = '2x';
    G.mix.connect(G.tone); G.tone.connect(G.master); G.master.connect(G.pre); G.pre.connect(G.clip); G.clip.connect(ac.destination);
    for (var t = 0; t < NT; t++) {
      var b = gn(ac, busGain(song, t)), node = b;
      if (t === Core.KK || t === Core.BS) {
        var sh = ac.createWaveShaper();
        sh.curve = curveTanh(t === Core.KK ? Core.KITS[song.kit].kdrv : 2.2);
        b.connect(sh); node = sh; G.shaper[t] = sh;
      }
      if (T[t].pan && ac.createStereoPanner) { var pn = ac.createStereoPanner(); pn.pan.value = T[t].pan; node.connect(pn); node = pn; }
      node.connect(G.mix);
      G.bus.push(b);
    }
    G.fx = gn(ac, 0.9);
    G.fx.connect(G.mix);
    G.dly = ac.createDelay(2); G.dly.delayTime.value = echoTime(song.bpm);
    G.dlp = bq(ac, 'lowpass', 2800, 0.7); G.fb = gn(ac, 0.36); G.wet = gn(ac, song.echo * 0.6);
    G.fx.connect(G.dly); G.dly.connect(G.dlp); G.dlp.connect(G.fb); G.fb.connect(G.dly); G.dlp.connect(G.wet); G.wet.connect(G.mix);
    return G;
  }

  // ---- node helpers ----
  function gn(ac, v) { var g = ac.createGain(); g.gain.value = v == null ? 1 : v; return g; }
  function bq(ac, type, f, q) { var b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q != null) b.Q.value = q; return b; }
  function osc(ac, type, f) { var o = ac.createOscillator(); o.type = type; o.frequency.value = f; return o; }
  function perc(p, t, peak, a, d) {
    p.setValueAtTime(0.0001, t);
    p.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    p.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function run(R, s, t, end, off) {
    if (off != null) s.start(t, off); else s.start(t);
    s.stop(end);
    if (R.sink) R.sink.push(s);
    return s;
  }
  function noise(ac, R, t, dur) {
    var s = ac.createBufferSource();
    s.buffer = R.noise;
    if (dur > 0.95) { s.loop = true; return run(R, s, t, t + dur, Math.random() * 0.9); }
    return run(R, s, t, t + dur, Math.random() * (1 - dur));
  }
  function wire(a) { for (var i = 0; i < a.length - 1; i++) a[i].connect(a[i + 1]); }
  // Disconnect a hit's nodes when its last source ends, so they can be collected.
  function done(src, nodes) {
    src.onended = function () {
      src.onended = null;
      for (var i = 0; i < nodes.length; i++) { try { nodes[i].disconnect(); } catch (e) {} }
    };
  }
  function timer(ac, R, t, end, nodes) { // a silent source whose end cleans up voices without one
    var s = ac.createBufferSource(); s.buffer = R.noise; run(R, s, t, end, 0); done(s, nodes.concat([s]));
  }

  // ---- drum voices ----
  function vKick(ac, R, out, t, g, K) {
    var o = osc(ac, 'sine', K.kf0), a = gn(ac, 0);
    o.frequency.setValueAtTime(K.kf0 * (0.9 + 0.1 * g), t);
    o.frequency.exponentialRampToValueAtTime(K.kf1, t + K.kpd);
    perc(a.gain, t, g * (K.kv || 1), 0.002, K.kd);
    o.connect(a); a.connect(out);
    run(R, o, t, t + K.kd + 0.05);
    var n = noise(ac, R, t, 0.025), f = bq(ac, 'highpass', 2400, 0.7), c = gn(ac, 0);
    perc(c.gain, t, g * K.kc, 0.0006, 0.014);
    wire([n, f, c, out]);
    done(o, [o, a, n, f, c]);
  }
  function vSnare(ac, R, out, t, g, K) {
    var o = osc(ac, 'triangle', K.st), og = gn(ac, 0);
    o.frequency.setValueAtTime(K.st * 1.55, t);
    o.frequency.exponentialRampToValueAtTime(K.st, t + 0.035);
    perc(og.gain, t, g * 0.5, 0.001, K.std);
    o.connect(og); og.connect(out);
    run(R, o, t, t + K.std + 0.05);
    var n = noise(ac, R, t, K.snd + 0.06), hp = bq(ac, 'highpass', K.shp, 0.7), pk = bq(ac, 'peaking', 5200, 1), ng = gn(ac, 0);
    pk.gain.value = 5;
    perc(ng.gain, t, g * K.sn * 0.72, 0.0012, K.snd);
    wire([n, hp, pk, ng, out]);
    done(n, [o, og, n, hp, pk, ng]);
  }
  function vClap(ac, R, out, t, g, K) {
    var n = noise(ac, R, t, 0.06 + K.cld), bp = bq(ac, 'bandpass', 1150, 1.2), hp = bq(ac, 'highpass', 650, 0.7), a = gn(ac, 0), p = a.gain;
    for (var i = 0; i < 3; i++) {                   // three quick slaps, then the tail
      var ti = t + i * 0.0105;
      p.setValueAtTime(g * 4, ti);
      p.exponentialRampToValueAtTime(g * 0.35, ti + 0.0095);
    }
    var t3 = t + 0.0315;
    p.setValueAtTime(g * 3.5, t3);
    p.exponentialRampToValueAtTime(0.0001, t3 + K.cld);
    wire([n, bp, hp, a, out]);
    done(n, [n, bp, hp, a]);
  }
  function chokeOH(R, t) {
    var o = R.oh;
    if (o && o.t < t && o.end > t) { o.ck.gain.setTargetAtTime(0, t, 0.007); o.end = t; }
  }
  function vHat(ac, R, out, t, g, K, open) {
    var d = open ? K.ohd : K.hd, m = ac.createBufferSource(), n = noise(ac, R, t, d + 0.08);
    m.buffer = R.metal;
    run(R, m, t, t + d + 0.08, Math.random() * 0.15);
    var mg = gn(ac, K.hm), ng = gn(ac, K.hn), hp = bq(ac, 'highpass', K.hhp, 0.8), pk = bq(ac, 'peaking', 10500, 1.2), a = gn(ac, 0);
    pk.gain.value = 6;
    perc(a.gain, t, g * (open ? 0.9 : 1.05), 0.0008, d);
    m.connect(mg); n.connect(ng); mg.connect(hp); ng.connect(hp); hp.connect(pk); pk.connect(a);
    var nodes = [m, n, mg, ng, hp, pk, a];
    if (open) {
      var ck = gn(ac, 1);
      a.connect(ck); ck.connect(out); nodes.push(ck);
      R.oh = { ck: ck, t: t, end: t + d };
    } else a.connect(out);
    done(n, nodes);
  }
  function vTom(ac, R, out, t, g, K) {
    var o = osc(ac, 'sine', K.tf), a = gn(ac, 0);
    o.frequency.setValueAtTime(K.tf * 1.7, t);
    o.frequency.exponentialRampToValueAtTime(K.tf, t + 0.03);
    o.frequency.exponentialRampToValueAtTime(K.tf * 0.78, t + K.td);
    perc(a.gain, t, g * 1.1, 0.002, K.td);
    o.connect(a); a.connect(out);
    run(R, o, t, t + K.td + 0.05);
    var n = noise(ac, R, t, 0.05), lp = bq(ac, 'lowpass', 1600, 0.7), ng = gn(ac, 0);
    perc(ng.gain, t, g * 0.3, 0.001, 0.035);
    wire([n, lp, ng, out]);
    done(o, [o, a, n, lp, ng]);
  }
  function vRim(ac, R, out, t, g, K) {
    if (K.rim === 'clave') {
      var c = osc(ac, 'sine', 2480), ca = gn(ac, 0);
      perc(ca.gain, t, g * 0.8, 0.0005, 0.055);
      wire([c, ca, out]);
      run(R, c, t, t + 0.08);
      done(c, [c, ca]);
      return;
    }
    var o1 = osc(ac, 'triangle', 1720), o2 = osc(ac, 'square', 470), g2 = gn(ac, 0.25), hp = bq(ac, 'highpass', 380, 0.7), a = gn(ac, 0);
    perc(a.gain, t, g * 0.8, 0.0004, 0.028);
    o1.connect(hp); o2.connect(g2); g2.connect(hp); hp.connect(a); a.connect(out);
    run(R, o1, t, t + 0.06); run(R, o2, t, t + 0.06);
    var n = noise(ac, R, t, 0.015), nh = bq(ac, 'highpass', 3000, 0.7), ng = gn(ac, 0);
    perc(ng.gain, t, g * 0.4, 0.0003, 0.008);
    wire([n, nh, ng, out]);
    done(o1, [o1, o2, g2, hp, a, n, nh, ng]);
  }
  function vCow(ac, R, out, t, g) {
    var o1 = osc(ac, 'square', 540), o2 = osc(ac, 'square', 800), m = gn(ac, 0.5), bp = bq(ac, 'bandpass', 2000, 0.9), a = gn(ac, 0), p = a.gain;
    p.setValueAtTime(0.0001, t);
    p.exponentialRampToValueAtTime(g * 1.2, t + 0.002);
    p.exponentialRampToValueAtTime(g * 0.35, t + 0.05);
    p.exponentialRampToValueAtTime(0.0001, t + 0.38);
    o1.connect(m); o2.connect(m); wire([m, bp, a, out]);
    run(R, o1, t, t + 0.4); run(R, o2, t, t + 0.4);
    done(o1, [o1, o2, m, bp, a]);
  }
  function vShaker(ac, R, out, t, g, K) {
    var n = noise(ac, R, t, K.shd + 0.04), bp = bq(ac, 'bandpass', 6800, 1.1), hp = bq(ac, 'highpass', 3500, 0.7), a = gn(ac, 0), p = a.gain;
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(g * 1.1, t + 0.014);
    p.exponentialRampToValueAtTime(0.0001, t + K.shd);
    wire([n, bp, hp, a, out]);
    done(n, [n, bp, hp, a]);
  }
  function vCrash(ac, R, out, t, g) {
    var m = ac.createBufferSource(), n = noise(ac, R, t, 2.2);
    m.buffer = R.metal; m.loop = true; m.playbackRate.value = 1.45;
    run(R, m, t, t + 2.2, 0);
    var mg = gn(ac, 0.55), ng = gn(ac, 0.75), hp = bq(ac, 'highpass', 4200, 0.6), pk = bq(ac, 'peaking', 7500, 0.8), a = gn(ac, 0);
    pk.gain.value = 5;
    perc(a.gain, t, g * 0.6, 0.002, 1.9);
    m.connect(mg); n.connect(ng); mg.connect(hp); ng.connect(hp); wire([hp, pk, a, out]);
    done(n, [m, n, mg, ng, hp, pk, a]);
  }

  // ---- melodic voices (monophonic per track: a new note chokes the last) ----
  function mono(R, key, t, ck, end) {
    var m = R.mono[key];
    if (m && m.end > t) { m.ck.gain.setTargetAtTime(0, t, 0.01); m.end = t; }
    R.mono[key] = { ck: ck, end: end };
  }
  function vBass(ac, R, out, t, g, f, len, sd, type, acc) {
    var ck = gn(ac, 1), nodes = [ck], src, end;
    ck.connect(out);
    if (type === 'acid') {
      var o = osc(ac, 'sawtooth', f), lp = bq(ac, 'lowpass', 400, acc ? 17 : 11), a = gn(ac, 0);
      var gate = Math.max(0.03, Math.min(len - 0.01, sd * (acc ? 1.1 : 0.8)));
      lp.frequency.setValueAtTime(Math.min(8000, (acc ? 3400 : 1500) + 1200 * g), t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(f * 1.6, 180), t + (acc ? 0.3 : 0.17));
      a.gain.setValueAtTime(0.0001, t);
      a.gain.exponentialRampToValueAtTime(g * 0.42, t + 0.004);
      a.gain.setValueAtTime(g * 0.42, t + gate);
      a.gain.exponentialRampToValueAtTime(0.0001, t + gate + 0.03);
      wire([o, lp, a, ck]);
      end = t + gate + 0.05; run(R, o, t, end); nodes.push(o, lp, a); src = o;
    } else if (type === 'saw') {
      var cut = 500 + 900 * g, o1 = osc(ac, 'sawtooth', f), o2 = osc(ac, 'sawtooth', f), lp2 = bq(ac, 'lowpass', cut, 1.4), a2 = gn(ac, 0);
      var gate2 = Math.max(0.03, Math.min(len * 0.95, 2));
      o1.detune.value = -9; o2.detune.value = 9;
      lp2.frequency.setValueAtTime(cut * 2.2, t);
      lp2.frequency.exponentialRampToValueAtTime(cut, t + 0.15);
      a2.gain.setValueAtTime(0.0001, t);
      a2.gain.exponentialRampToValueAtTime(g * 0.32, t + 0.008);
      a2.gain.setValueAtTime(g * 0.32, t + gate2);
      a2.gain.exponentialRampToValueAtTime(0.0001, t + gate2 + 0.06);
      o1.connect(lp2); o2.connect(lp2); lp2.connect(a2); a2.connect(ck);
      end = t + gate2 + 0.08; run(R, o1, t, end); run(R, o2, t, end); nodes.push(o1, o2, lp2, a2); src = o1;
    } else {                                           // 808 sub: a pitch-punched sine that rings to the next note
      var o3 = osc(ac, 'sine', f), a3 = gn(ac, 0), dur = Math.max(0.06, Math.min(len, 1.8));
      o3.frequency.setValueAtTime(f * 2.1, t);
      o3.frequency.exponentialRampToValueAtTime(f, t + 0.04);
      a3.gain.setValueAtTime(0.0001, t);
      a3.gain.exponentialRampToValueAtTime(g * 0.6, t + 0.005);
      a3.gain.setTargetAtTime(0.0001, t + 0.03, Math.max(0.05, dur * 0.42));
      a3.gain.setTargetAtTime(0, t + dur, 0.02);
      o3.connect(a3); a3.connect(ck);
      end = t + dur + 0.12; run(R, o3, t, end); nodes.push(o3, a3); src = o3;
    }
    mono(R, 'bs', t, ck, end);
    done(src, nodes);
  }
  function vKeys(ac, R, out, t, g, song, deg, len) {
    var type = song.keys, ck = gn(ac, 1), nodes = [ck], src, end;
    ck.connect(out);
    function fr(d, up) { return Core.midiFreq(Core.degreeMidi(d, song.key, song.scale, Core.KY) + (up || 0)); }
    if (type === 'stab') {
      var lp = bq(ac, 'lowpass', 900, 2), a = gn(ac, 0), dur = Math.min(0.42, Math.max(0.12, len));
      lp.frequency.setValueAtTime(4200 * (0.6 + 0.4 * g), t);
      lp.frequency.exponentialRampToValueAtTime(800, t + 0.22);
      perc(a.gain, t, g * 0.32, 0.004, dur);
      lp.connect(a); a.connect(ck); nodes.push(lp, a);
      end = t + dur + 0.05;
      Core.chordDegrees(deg, 3).forEach(function (d) {
        [-7, 7].forEach(function (dt) { var o = osc(ac, 'sawtooth', fr(d)); o.detune.value = dt; o.connect(lp); run(R, o, t, end); nodes.push(o); src = o; });
      });
    } else if (type === 'keys') {                     // FM electric piano, 7th chords
      var a2 = gn(ac, 0), dur2 = Math.min(Math.max(len, 0.15), 2.6);
      a2.gain.setValueAtTime(0.0001, t);
      a2.gain.exponentialRampToValueAtTime(g * 0.28, t + 0.006);
      a2.gain.setTargetAtTime(0.0001, t + 0.02, dur2 * 0.45);
      a2.gain.setTargetAtTime(0, t + dur2, 0.04);
      a2.connect(ck); nodes.push(a2);
      end = t + dur2 + 0.25;
      Core.chordDegrees(deg, 4).forEach(function (d) {
        var f = fr(d), c = osc(ac, 'sine', f), m = osc(ac, 'sine', f), mg = gn(ac, 0);
        mg.gain.setValueAtTime(f * 2.2 * g, t);
        mg.gain.exponentialRampToValueAtTime(f * 0.15, t + 0.6);
        m.connect(mg); mg.connect(c.frequency); c.connect(a2);
        run(R, c, t, end); run(R, m, t, end); nodes.push(c, m, mg); src = c;
      });
    } else if (type === 'bell') {                     // FM bell, rings over the next notes
      var bf = fr(deg, 12), bc = osc(ac, 'sine', bf), bm = osc(ac, 'sine', bf * 3.5), bmg = gn(ac, 0), ba = gn(ac, 0);
      bmg.gain.setValueAtTime(bf * 4 * g, t);
      bmg.gain.exponentialRampToValueAtTime(bf * 0.2, t + 1.4);
      perc(ba.gain, t, g * 0.6, 0.002, 1.6);
      bm.connect(bmg); bmg.connect(bc.frequency); bc.connect(ba); ba.connect(ck);
      end = t + 1.7; run(R, bc, t, end); run(R, bm, t, end); nodes.push(bc, bm, bmg, ba); src = bc;
    } else if (type === 'pluck') {
      var pf = fr(deg, 12), po = osc(ac, 'square', pf), plp = bq(ac, 'lowpass', 5200, 3), pa = gn(ac, 0);
      plp.frequency.setValueAtTime(5200, t);
      plp.frequency.exponentialRampToValueAtTime(Math.max(500, pf * 1.2), t + 0.2);
      perc(pa.gain, t, g * 0.6, 0.002, 0.32);
      wire([po, plp, pa, ck]);
      end = t + 0.36; run(R, po, t, end); nodes.push(po, plp, pa); src = po;
    } else {                                           // lead: saw + square, held to the next note
      var lf = fr(deg, 12), l1 = osc(ac, 'sawtooth', lf), l2 = osc(ac, 'square', lf), llp = bq(ac, 'lowpass', 2600, 2), la = gn(ac, 0);
      var lgate = Math.max(0.04, Math.min(len * 0.92, 1.2));
      l2.detune.value = 6;
      la.gain.setValueAtTime(0.0001, t);
      la.gain.exponentialRampToValueAtTime(g * 0.24, t + 0.01);
      la.gain.setValueAtTime(g * 0.24, t + lgate);
      la.gain.exponentialRampToValueAtTime(0.0001, t + lgate + 0.06);
      l1.connect(llp); l2.connect(llp); llp.connect(la); la.connect(ck);
      end = t + lgate + 0.08; run(R, l1, t, end); run(R, l2, t, end); nodes.push(l1, l2, llp, la); src = l1;
    }
    if (type !== 'bell' && type !== 'pluck') mono(R, 'ky', t, ck, end);
    done(src, nodes);
  }
  // One step hit on track tr at time t. len (s) = how long a note may ring.
  function hit(ac, R, G, song, tr, t, vel, deg, len, gmul) {
    var K = Core.KITS[song.kit], g = Math.min(1.15, Core.VEL_GAIN[vel] * (gmul || 1)), out = G.bus[tr], sd = Core.stepDur(song.bpm);
    switch (tr) {
      case 0: vKick(ac, R, out, t, g, K); break;
      case 1: vSnare(ac, R, out, t, g, K); break;
      case 2: vClap(ac, R, out, t, g, K); break;
      case 3: chokeOH(R, t); vHat(ac, R, out, t, g, K, false); break;
      case 4: vHat(ac, R, out, t, g, K, true); break;
      case 5: vTom(ac, R, out, t, g, K); break;
      case 6: vRim(ac, R, out, t, g, K); break;
      case 7: vCow(ac, R, out, t, g); break;
      case 8: vShaker(ac, R, out, t, g, K); break;
      case 9: vBass(ac, R, out, t, g, Core.midiFreq(Core.degreeMidi(deg, song.key, song.scale, Core.BS)), len || sd * 4, sd, song.bass, vel === 3); break;
      case 10: vKeys(ac, R, out, t, g, song, deg, len || sd * 4); break;
    }
  }

  // ---- sound board FX (one-shots; a pad re-hit fades its last one out) ----
  var FX = [
    { id: 'horn', name: 'AIR HORN' }, { id: 'laser', name: 'LASER' }, { id: 'riser', name: 'RISER' }, { id: 'impact', name: 'IMPACT' },
    { id: 'scratch', name: 'SCRATCH' }, { id: 'crowd', name: 'CROWD' }, { id: 'siren', name: 'SIREN' }, { id: 'bell', name: 'BELL' },
    { id: 'drop', name: 'SUB DROP' }, { id: 'coin', name: 'COIN' }, { id: 'whoosh', name: 'WHOOSH' }, { id: 'orch', name: 'ORCH HIT' },
    { id: 'crash', name: 'CRASH' }, { id: 'roll', name: 'SNARE ROLL' }, { id: 'rewind', name: 'REWIND' }, { id: 'hey', name: 'HEY!' }
  ];
  var KIT_PADS = ['KICK', 'SNARE', 'CLAP', 'C.HAT', 'O.HAT', 'TOM', 'RIM', 'COWBELL', 'SHAKER', 'BASS', 'KEYS', 'CRASH'];
  var PAD_KEYS = '1234qwerasdfzxcv';
  function crowdBuf(ac, R) {
    if (R.crowd) return R.crowd;
    var sr = ac.sampleRate, len = Math.floor(sr * 2.8), b = ac.createBuffer(2, len, sr);
    for (var c = 0; c < 2; c++) {
      var d = b.getChannelData(c), k, i;
      for (k = 0; k < 200; k++) {                      // lots of tiny claps …
        var at = Math.floor(Math.random() * (len - sr * 0.03)), amp = 0.25 + Math.random() * 0.75, L = Math.floor(sr * (0.006 + Math.random() * 0.01)), tau = L / 3;
        for (i = 0; i < L; i++) d[at + i] += (Math.random() * 2 - 1) * amp * Math.exp(-i / tau);
      }
      for (i = 0; i < len; i++) { var x = i / len; d[i] *= Math.min(1, x / 0.12) * Math.min(1, (1 - x) / 0.45) * 0.55; } // … that swell and fade
    }
    return (R.crowd = b);
  }
  function formantRate(params, list, ts, te, r0, r1) {
    list.forEach(function (x) { params[x[0]].setValueAtTime(x[1] * r0, ts); params[x[0]].exponentialRampToValueAtTime(x[1] * r1, te); });
  }
  var FXF = {
    horn: function (ac, R, out, t) {                 // dancehall air horn: "bap bap baaap"
      var pre = gn(ac, 0.3), sh = ac.createWaveShaper(), lp = bq(ac, 'lowpass', 3400, 0.9), pk = bq(ac, 'peaking', 1500, 1.4), a = gn(ac, 0), nodes = [pre, sh, lp, pk, a], src;
      var segs = [[0, 0.12], [0.17, 0.29], [0.34, 1.15]];
      sh.curve = R.drive; pk.gain.value = 7;
      [466.2, 468.9, 699.2].forEach(function (f) {
        var o = osc(ac, 'sawtooth', f);
        segs.forEach(function (s) { o.frequency.setValueAtTime(f * 0.86, t + s[0]); o.frequency.exponentialRampToValueAtTime(f, t + s[0] + 0.045); });
        o.connect(pre); run(R, o, t, t + 1.2); nodes.push(o); src = o;
      });
      var p = a.gain;
      p.setValueAtTime(0, t);
      segs.forEach(function (s) { p.setValueAtTime(0, t + s[0]); p.linearRampToValueAtTime(0.4, t + s[0] + 0.015); p.setValueAtTime(0.4, t + s[1] - 0.025); p.linearRampToValueAtTime(0, t + s[1]); });
      wire([pre, sh, lp, pk, a, out]);
      return { end: t + 1.2, src: src, nodes: nodes };
    },
    laser: function (ac, R, out, t) {
      var o = osc(ac, 'square', 2600), s = osc(ac, 'sine', 2600), lfo = osc(ac, 'sine', 38), lg = gn(ac, 180), lp = bq(ac, 'lowpass', 4500, 1), a = gn(ac, 0);
      [o, s].forEach(function (x) { x.frequency.setValueAtTime(2600, t); x.frequency.exponentialRampToValueAtTime(140, t + 0.34); });
      lfo.connect(lg); lg.connect(o.frequency);
      perc(a.gain, t, 0.3, 0.002, 0.34);
      o.connect(lp); s.connect(lp); lp.connect(a); a.connect(out);
      run(R, o, t, t + 0.4); run(R, s, t, t + 0.4); run(R, lfo, t, t + 0.4);
      return { end: t + 0.4, src: o, nodes: [o, s, lfo, lg, lp, a] };
    },
    riser: function (ac, R, out, t, song) {          // one bar of rising noise + saw
      var d = Math.min(4, Core.barDur(song.bpm)), n = noise(ac, R, t, d + 0.05), bp = bq(ac, 'bandpass', 300, 2.2), ng = gn(ac, 2.2);
      var o = osc(ac, 'sawtooth', 110), og = gn(ac, 0.12), a = gn(ac, 0), p = a.gain;
      bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(9000, t + d);
      o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(880, t + d);
      p.setValueAtTime(0.0001, t); p.exponentialRampToValueAtTime(0.5, t + d); p.setValueAtTime(0.5, t + d); p.linearRampToValueAtTime(0, t + d + 0.03);
      wire([n, bp, ng, a]); o.connect(og); og.connect(a); a.connect(out);
      run(R, o, t, t + d + 0.05);
      return { end: t + d + 0.05, src: n, nodes: [n, bp, ng, o, og, a] };
    },
    impact: function (ac, R, out, t) {
      var o = osc(ac, 'sine', 110), pre = gn(ac, 0.8), sh = ac.createWaveShaper(), a = gn(ac, 0);
      sh.curve = R.drive;
      o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(30, t + 1.0);
      perc(a.gain, t, 0.8, 0.003, 1.6);
      wire([o, pre, sh, a, out]);
      var n = noise(ac, R, t, 0.6), lp = bq(ac, 'lowpass', 2400, 0.8), ng = gn(ac, 0);
      lp.frequency.setValueAtTime(2400, t); lp.frequency.exponentialRampToValueAtTime(120, t + 0.5);
      perc(ng.gain, t, 0.75, 0.001, 0.5);
      wire([n, lp, ng, out]);
      run(R, o, t, t + 1.7);
      return { end: t + 1.7, src: o, nodes: [o, pre, sh, a, n, lp, ng] };
    },
    scratch: function (ac, R, out, t) {             // a synthetic "ahh" pushed and pulled like vinyl
      var o = osc(ac, 'sawtooth', 160), n = noise(ac, R, t, 0.6), ng = gn(ac, 0.25), mix = gn(ac, 1);
      var f1 = bq(ac, 'bandpass', 800, 5), f2 = bq(ac, 'bandpass', 1250, 6), g1 = gn(ac, 2.4), g2 = gn(ac, 1.8), a = gn(ac, 0), p = a.gain;
      o.connect(mix); n.connect(ng); ng.connect(mix); mix.connect(f1); mix.connect(f2); f1.connect(g1); f2.connect(g2); g1.connect(a); g2.connect(a); a.connect(out);
      var params = { o: o.frequency, f1: f1.frequency, f2: f2.frequency }, list = [['o', 160], ['f1', 800], ['f2', 1250]];
      p.setValueAtTime(0, t);
      [[0, 0.075, 0.35, 2.2], [0.075, 0.07, 2.2, 0.25], [0.16, 0.055, 0.3, 1.9], [0.215, 0.055, 1.9, 0.3], [0.3, 0.12, 0.35, 2.4]].forEach(function (s) {
        var ts = t + s[0], te = ts + s[1];
        formantRate(params, list, ts, te, s[2], s[3]);
        p.setValueAtTime(0, ts); p.linearRampToValueAtTime(0.7, ts + 0.008); p.setValueAtTime(0.7, te - 0.012); p.linearRampToValueAtTime(0, te);
      });
      run(R, o, t, t + 0.45);
      return { end: t + 0.6, src: n, nodes: [o, n, ng, mix, f1, f2, g1, g2, a] };
    },
    crowd: function (ac, R, out, t) {
      var s = ac.createBufferSource(), bp = bq(ac, 'bandpass', 2300, 0.55), hp = bq(ac, 'highpass', 500, 0.7), a = gn(ac, 2.2);
      s.buffer = crowdBuf(ac, R);
      wire([s, bp, hp, a, out]);
      run(R, s, t, t + 2.85, 0);
      return { end: t + 2.85, src: s, nodes: [s, bp, hp, a] };
    },
    siren: function (ac, R, out, t) {                // dub siren
      var d = 2.6, o = osc(ac, 'square', 620), lfo = osc(ac, 'sawtooth', 3), lg = gn(ac, 330), lp = bq(ac, 'lowpass', 2400, 1), a = gn(ac, 0), p = a.gain;
      lfo.frequency.setValueAtTime(2.6, t); lfo.frequency.linearRampToValueAtTime(6.5, t + d);
      lfo.connect(lg); lg.connect(o.frequency);
      p.setValueAtTime(0.0001, t); p.exponentialRampToValueAtTime(0.3, t + 0.03); p.setValueAtTime(0.3, t + d - 0.35); p.exponentialRampToValueAtTime(0.0001, t + d);
      wire([o, lp, a, out]);
      run(R, o, t, t + d); run(R, lfo, t, t + d);
      return { end: t + d, src: o, nodes: [o, lfo, lg, lp, a] };
    },
    bell: function (ac, R, out, t, song) {
      var f = Core.midiFreq(Core.rootMidi(Core.KY, song.key) + 24), c = osc(ac, 'sine', f), m = osc(ac, 'sine', f * 3.5), mg = gn(ac, 0);
      var c2 = osc(ac, 'sine', f * 2.76), g2 = gn(ac, 0), a = gn(ac, 0);
      mg.gain.setValueAtTime(f * 5, t); mg.gain.exponentialRampToValueAtTime(f * 0.15, t + 2.2);
      m.connect(mg); mg.connect(c.frequency);
      perc(a.gain, t, 0.4, 0.002, 2.6); perc(g2.gain, t, 0.45, 0.002, 1.2);
      c.connect(a); c2.connect(g2); g2.connect(a); a.connect(out);
      run(R, c, t, t + 2.7); run(R, m, t, t + 2.7); run(R, c2, t, t + 2.7);
      return { end: t + 2.7, src: c, nodes: [c, m, mg, c2, g2, a] };
    },
    drop: function (ac, R, out, t) {
      var o = osc(ac, 'sine', 170), pre = gn(ac, 0.9), sh = ac.createWaveShaper(), a = gn(ac, 0), p = a.gain;
      sh.curve = R.drive;
      o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(32, t + 1.5);
      p.setValueAtTime(0.0001, t); p.exponentialRampToValueAtTime(0.75, t + 0.01); p.setValueAtTime(0.75, t + 0.9); p.exponentialRampToValueAtTime(0.0001, t + 1.9);
      wire([o, pre, sh, a, out]);
      run(R, o, t, t + 1.95);
      return { end: t + 1.95, src: o, nodes: [o, pre, sh, a] };
    },
    coin: function (ac, R, out, t) {
      var o = osc(ac, 'square', 988), lp = bq(ac, 'lowpass', 6000, 0.7), a = gn(ac, 0), p = a.gain;
      o.frequency.setValueAtTime(988, t); o.frequency.setValueAtTime(1319, t + 0.075);
      p.setValueAtTime(0.0001, t); p.linearRampToValueAtTime(0.32, t + 0.003); p.setValueAtTime(0.32, t + 0.075); p.exponentialRampToValueAtTime(0.0001, t + 0.5);
      wire([o, lp, a, out]);
      run(R, o, t, t + 0.52);
      return { end: t + 0.52, src: o, nodes: [o, lp, a] };
    },
    whoosh: function (ac, R, out, t) {
      var d = 1.05, n = noise(ac, R, t, d + 0.05), bp = bq(ac, 'bandpass', 250, 1.6), a = gn(ac, 0), p = a.gain, nodes = [n, bp, a], last = a;
      bp.frequency.setValueAtTime(250, t); bp.frequency.exponentialRampToValueAtTime(4800, t + 0.48); bp.frequency.exponentialRampToValueAtTime(300, t + d);
      p.setValueAtTime(0.0001, t); p.exponentialRampToValueAtTime(1.4, t + 0.45); p.exponentialRampToValueAtTime(0.0001, t + d);
      n.connect(bp); bp.connect(a);
      if (ac.createStereoPanner) {
        var pn = ac.createStereoPanner();
        pn.pan.setValueAtTime(-0.9, t); pn.pan.linearRampToValueAtTime(0.9, t + d);
        a.connect(pn); last = pn; nodes.push(pn);
      }
      last.connect(out);
      return { end: t + d + 0.05, src: n, nodes: nodes };
    },
    orch: function (ac, R, out, t, song) {          // orchestra hit on the song's root
      var r = Core.rootMidi(Core.KY, song.key) - 12, third = Core.SCALES[song.scale].steps.indexOf(4) >= 0 ? 4 : 3;
      var lp = bq(ac, 'lowpass', 5000, 1.2), a = gn(ac, 0), nodes = [lp, a], src;
      lp.frequency.setValueAtTime(6000, t); lp.frequency.exponentialRampToValueAtTime(900, t + 0.5);
      perc(a.gain, t, 0.22, 0.003, 0.75);
      [r, r + 7, r + 12, r + 12 + third, r + 19, r + 24].forEach(function (m, i) {
        var o = osc(ac, i % 2 ? 'square' : 'sawtooth', Core.midiFreq(m));
        o.detune.value = (i % 3 - 1) * 8; o.connect(lp); run(R, o, t, t + 0.8); nodes.push(o); src = o;
      });
      lp.connect(a); a.connect(out);
      var n = noise(ac, R, t, 0.15), hp = bq(ac, 'highpass', 2500, 0.7), ng = gn(ac, 0);
      perc(ng.gain, t, 0.3, 0.001, 0.12);
      wire([n, hp, ng, out]); nodes.push(n, hp, ng);
      return { end: t + 0.8, src: src, nodes: nodes };
    },
    crash: function (ac, R, out, t) {
      vCrash(ac, R, out, t, 0.95);
      return { end: t + 2.2, src: null, nodes: [] };
    },
    roll: function (ac, R, out, t, song) {         // one-bar snare build: 8ths, 16ths, 32nds, louder
      var sd = Core.stepDur(song.bpm), K = Core.KITS[song.kit], times = [], k;
      for (k = 0; k < 4; k++) times.push(k * 2 * sd);
      for (k = 0; k < 4; k++) times.push(8 * sd + k * sd);
      for (k = 0; k < 8; k++) times.push(12 * sd + k * sd / 2);
      times.forEach(function (dt, i) { vSnare(ac, R, out, t + dt, 0.3 + 0.7 * i / (times.length - 1), K); });
      return { end: t + 16 * sd + 0.3, src: null, nodes: [] };
    },
    rewind: function (ac, R, out, t) {             // tape spin-back: accelerating chirps
      var o = osc(ac, 'sawtooth', 300), n = noise(ac, R, t, 1.3), ng = gn(ac, 0.2), mix = gn(ac, 1), f1 = bq(ac, 'bandpass', 900, 4), boost = gn(ac, 3.2), a = gn(ac, 0), p = a.gain;
      o.connect(mix); n.connect(ng); ng.connect(mix); wire([mix, f1, boost, a, out]);
      var ts = t, dur = 0.16, amp = 0.6;
      p.setValueAtTime(0, t);
      for (var i = 0; i < 12 && ts < t + 1.15; i++) {
        var te = ts + dur;
        o.frequency.setValueAtTime(260, ts); o.frequency.exponentialRampToValueAtTime(1500, te);
        f1.frequency.setValueAtTime(700, ts); f1.frequency.exponentialRampToValueAtTime(3800, te);
        p.setValueAtTime(0, ts); p.linearRampToValueAtTime(amp, ts + 0.01); p.linearRampToValueAtTime(amp * 0.3, te);
        ts = te; dur *= 0.86; amp *= 0.93;
      }
      p.linearRampToValueAtTime(0, ts + 0.01);
      run(R, o, t, ts + 0.05);
      return { end: t + 1.3, src: n, nodes: [o, n, ng, mix, f1, boost, a] };
    },
    hey: function (ac, R, out, t) {                // breathy "h" + a voiced vowel through three formants
      var mix = gn(ac, 1), nodes = [mix], src;
      var n = noise(ac, R, t, 0.4), nbp = bq(ac, 'bandpass', 1700, 1.2), ng = gn(ac, 0);
      ng.gain.setValueAtTime(0.0001, t); ng.gain.exponentialRampToValueAtTime(0.5, t + 0.02); ng.gain.exponentialRampToValueAtTime(0.06, t + 0.07); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      wire([n, nbp, ng, mix]); nodes.push(n, nbp, ng);
      var vg = gn(ac, 0);
      vg.gain.setValueAtTime(0.0001, t + 0.03); vg.gain.exponentialRampToValueAtTime(0.65, t + 0.06); vg.gain.setValueAtTime(0.65, t + 0.2); vg.gain.exponentialRampToValueAtTime(0.0001, t + 0.36);
      [205, 209].forEach(function (f) {
        var o = osc(ac, 'sawtooth', f);
        o.frequency.setValueAtTime(f * 1.08, t); o.frequency.exponentialRampToValueAtTime(f * 0.82, t + 0.35);
        o.connect(vg); run(R, o, t, t + 0.4); nodes.push(o); src = o;
      });
      [[620, 7, 1], [1900, 10, 0.55], [2600, 12, 0.35]].forEach(function (F) {
        var b = bq(ac, 'bandpass', F[0], F[1]), g = gn(ac, F[2] * 3);
        vg.connect(b); b.connect(g); g.connect(mix); nodes.push(b, g);
      });
      mix.connect(out); nodes.push(vg);
      return { end: t + 0.42, src: n, nodes: nodes };
    }
  };
  function fxPlay(ac, R, G, song, i, t) {
    var prev = R.fx[i];
    if (prev && prev.end > t) { prev.ck.gain.setTargetAtTime(0, t, 0.03); prev.end = t; }
    var ck = gn(ac, 1);
    ck.connect(G.fx);
    var r = FXF[FX[i].id](ac, R, ck, t, song);
    R.fx[i] = { ck: ck, end: r.end };
    if (r.src) done(r.src, r.nodes.concat([ck]));
    else timer(ac, R, t, r.end, [ck]);
  }

  // =========================================================================
  // Widget state (only while the panel is open)
  // =========================================================================
  var P = null;   // panel state
  var A = null;   // { ac, R, G, lat } — the live AudioContext, made on the first sound
  var SILENT_URL = null;

  function loadJSON(k) { try { var s = Cade.store.get(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function saveJSON(k, o) { try { Cade.store.set(k, JSON.stringify(o)); return true; } catch (e) { return false; } }
  function isMin() { return !!(P && Cade.isMinimized && Cade.isMinimized(P.el)); }
  function curPat() { return P.song.pats[P.cur]; }
  function q(sel) { return P ? P.el.querySelector(sel) : null; }

  // ---- audio lifecycle ----
  function wake() {
    if (!AC) { toast('This browser has no Web Audio', 'error', 2500); return null; }
    if (!A) {
      var ac;
      try { ac = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ac = new AC(); } catch (e2) { toast('Could not start audio', 'error'); return null; } }
      A = { ac: ac, R: makeRes(ac), G: null, lat: 0 };
      A.G = buildGraph(ac, P.song);
      try { var b = ac.createBufferSource(); b.buffer = ac.createBuffer(1, 1, ac.sampleRate); b.connect(ac.destination); b.start(0); } catch (e) {} // iOS unlock
      ac.onstatechange = function () { if (P) syncTransport(); };
    }
    A.want = true;
    if (A.ac.state !== 'running') { try { var pr = A.ac.resume(); if (pr && pr.catch) pr.catch(noop); } catch (e) {} }
    playbackSession(true);
    A.lat = Math.min(0.25, Math.max(0, A.ac.outputLatency || A.ac.baseLatency || 0));
    armIdle();
    return A;
  }
  // iOS: Web Audio follows the ring / silent switch. The Audio Session API (iOS 17+)
  // or a silent looping <audio> element switches the page to "playback".
  function playbackSession(on) {
    var s = NAV.audioSession;
    if (s) {
      try {
        if (on && s.type !== 'playback') { if (P && P.prevSession == null) P.prevSession = s.type || 'auto'; s.type = 'playback'; }
        if (!on && P && P.prevSession != null) { s.type = P.prevSession; P.prevSession = null; }
      } catch (e) {}
      return;
    }
    if (!IS_IOS || !P) return;
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
  function armIdle() {
    if (!P) return;
    clearTimeout(P.idleT);
    P.idleT = setTimeout(function () {
      if (!P || !A || P.playing) return;
      A.want = false;
      try { if (A.ac.state === 'running') A.ac.suspend(); } catch (e) {}
      if (P.silent) { try { P.silent.pause(); } catch (e) {} }
    }, IDLE_MS);
  }
  function applyMix(what) {
    if (!A) return;
    var G = A.G, now = A.ac.currentTime, s = P.song;
    if (!what || what === 'bus') for (var t = 0; t < NT; t++) G.bus[t].gain.setTargetAtTime(busGain(s, t), now, 0.012);
    if (!what || what === 'master') G.master.gain.setTargetAtTime(s.master, now, 0.02);
    if (!what || what === 'tone') G.tone.frequency.setTargetAtTime(toneHz(s.tone), now, 0.03);
    if (!what || what === 'echo') { G.wet.gain.setTargetAtTime(s.echo * 0.6, now, 0.03); G.dly.delayTime.setTargetAtTime(echoTime(s.bpm), now, 0.05); }
    if (!what || what === 'kit') G.shaper[Core.KK].curve = curveTanh(Core.KITS[s.kit].kdrv);
  }

  // ---- the lookahead scheduler ----
  function play() {
    if (!P || P.playing) return;
    var a = wake();
    if (!a) return;
    P.cursor = new Core.Cursor(P.song, P.song.mode, P.cur);
    P.nextTime = a.ac.currentTime + 0.06;
    P.abs = 0; P.queue.length = 0; P.pend.length = 0; P.mq.length = 0; P.skip = {}; P.lastStep = null; P.playPat = -1; P.hold = false; P.follow = true;
    P.playing = true;
    P.look = document.hidden ? LOOK_HIDDEN : LOOK;
    P.timer = setInterval(tick, TICK_MS);
    tick();
    startRaf();
    syncTransport(); renderPats();
  }
  function stop() {
    if (!P || !P.playing) return;
    P.playing = false;
    clearInterval(P.timer); P.timer = 0;
    if (A) {
      var now = A.ac.currentTime, R = A.R;
      // hits already queued for the next ~100 ms never start; ringing bass / keys / open hat fade
      P.pend.forEach(function (e) { if (e.t > now) e.srcs.forEach(function (s) { try { s.stop(now); } catch (er) {} }); });
      ['bs', 'ky'].forEach(function (k) { var m = R.mono[k]; if (m && m.end > now) { m.ck.gain.setTargetAtTime(0, now, 0.03); m.end = now; } });
      chokeOH(R, now + 0.001);
    }
    P.pend.length = 0; P.queue.length = 0; P.mq.length = 0; P.cursor = null; P.playPat = -1; P.lastStep = null;
    stopRaf(); setPlayhead(-1); syncTransport(); renderPats(); resetMeters();
    armIdle();
  }
  function togglePlay() { if (P.playing) stop(); else play(); }
  function tick() {
    if (!P || !P.playing || !A) return;
    var ac = A.ac, now = ac.currentTime;
    if (P.nextTime < now - 0.15) P.nextTime = now + 0.03;   // the clock jumped (suspended / stalled): skip ahead, never burst
    var end = now + P.look, n = 0;
    while (P.nextTime < end && n++ < 256) {
      scheduleStep(P.nextTime);
      P.nextTime += Core.stepDur(P.song.bpm);
      P.cursor.advance();
      P.abs++;
    }
    while (P.pend.length && P.pend[0].t < now - 0.5) P.pend.shift();
    if (!P.raf) {                                   // minimized / hidden: nobody draws, keep the queues short
      if (P.queue.length > 48) P.queue.splice(0, P.queue.length - 32);
      if (P.mq.length > 96) P.mq.length = 0;
    }
  }
  function scheduleStep(gt) {
    var s = P.song, c = P.cursor, pi = c.pat, st = c.step, p = s.pats[pi], ac = A.ac;
    var at = gt + Core.swingOffset(st, s.bpm, s.swing), h = s.human / 100, sd = Core.stepDur(s.bpm);
    for (var tr = 0; tr < NT; tr++) {
      var v = p.v[tr][st];
      if (!v) continue;
      var key = tr + ':' + P.abs;
      if (P.skip[key]) { delete P.skip[key]; continue; }   // just recorded live from a pad
      var t = at, gm = 1;
      if (h) { t += (Math.random() * 2 - 1) * h * 0.014; gm = 1 + (Math.random() * 2 - 1) * h * 0.3; }
      if (t < ac.currentTime) t = ac.currentTime;
      var srcs = [];
      A.R.sink = srcs;
      try { hit(ac, A.R, A.G, s, tr, t, v, p.n[tr][st], T[tr].note ? Core.noteSteps(p, tr, st) * sd : 0, gm); } catch (e) {}
      A.R.sink = null;
      P.pend.push({ t: t, srcs: srcs });
      P.mq.push({ t: t, tr: tr, g: Core.VEL_GAIN[v] * gm });
    }
    P.queue.push({ t: at, gt: gt, pat: pi, step: st, chain: c.chainPos, abs: P.abs });
  }

  // ---- drawing from the audio clock ----
  function startRaf() { if (P && !P.raf && P.playing && !isMin() && !document.hidden) P.raf = requestAnimationFrame(frame); }
  function stopRaf() { if (P && P.raf) { cancelAnimationFrame(P.raf); P.raf = 0; } }
  function frame() {
    if (!P) return;
    P.raf = 0;
    if (!P.playing || !A) return;
    var now = A.ac.currentTime - A.lat, e = null;
    while (P.queue.length && P.queue[0].t <= now) e = P.queue.shift();
    if (e) showStep(e);
    meters(now);
    P.raf = requestAnimationFrame(frame);
  }
  function showStep(e) {
    P.lastStep = e;
    var s = P.song, p = s.pats[e.pat];
    if (e.pat !== P.playPat) {
      P.playPat = e.pat;
      if (s.mode === 'song' && !P.hold && P.cur !== e.pat) { P.cur = e.pat; P.page = 0; if (P.pick) closePop(); renderGrid(); renderToolbar(); }
      renderPats();
    }
    var col = -1;
    if (e.pat === P.cur && P.view === 'seq') {
      var pg = Math.floor(e.step / P.per);
      // follow the playhead to its page — but not while a finger is on (or just left) the grid
      if (pg !== P.page && P.follow && !P.g && performance.now() - P.touchT > 1500) { P.page = pg; if (P.pick) closePop(); renderGrid(); renderPages(); }
      if (pg === P.page) col = e.step - P.page * P.per;
    }
    setPlayhead(col);
    P.ui.pos.textContent = PAT_CH[e.pat] + ' ' + pad2(e.step + 1) + '/' + pad2(p.len) + (s.mode === 'song' && !P.narrow ? ' · ' + (e.chain + 1) + '/' + s.chain.length : '');
    if (P.view === 'song' && s.mode === 'song' && e.step === 0) markChain(e.chain);
  }
  function setPlayhead(col) {
    if (!P || col === P.phCol) return;
    var cols = P.colCells, i;
    if (P.phCol >= 0 && cols[P.phCol]) for (i = 0; i < cols[P.phCol].length; i++) cols[P.phCol][i].classList.remove('ph');
    if (col >= 0 && cols[col]) for (i = 0; i < cols[col].length; i++) cols[col][i].classList.add('ph');
    P.phCol = col;
  }
  // ASCII level meters (MIX view), fed by the scheduled hits — no analysers.
  var METER_W = 8;
  function meterText(x) { var n = Math.max(0, Math.min(METER_W, Math.round(x * METER_W))); return new Array(n + 1).join('■') + new Array(METER_W - n + 1).join('·'); }
  function meters(now) {
    var mq = P.mq;
    while (mq.length && mq[0].t <= now) { var m = mq.shift(); P.hitT[m.tr] = m.t; P.hitG[m.tr] = m.g; }
    if (P.view !== 'mix' || !P.ui.meters) return;
    var top = 0;
    for (var t = 0; t < NT; t++) {
      var lv = P.hitG[t] ? P.hitG[t] * busGain(P.song, t) * Math.exp(-(now - P.hitT[t]) / 0.16) : 0;
      if (lv > top) top = lv;
      drawMeter(t, lv);
    }
    drawMeter(NT, Math.min(1, top * P.song.master * 1.2));
  }
  function drawMeter(i, lv) {
    if (!P.ui.meters) return;
    var n = Math.round(Math.min(1, lv) * METER_W);
    if (P.meterN[i] === n) return;
    P.meterN[i] = n;
    var el = P.ui.meters[i];
    if (el) el.textContent = meterText(n / METER_W);
  }
  function resetMeters() { if (!P) return; for (var i = 0; i <= NT; i++) { P.hitG[i] = 0; drawMeter(i, 0); } }

  // ---- edits ----
  function pushUndo() {
    P.undo.push(JSON.stringify(Core.serialize(P.song)));
    if (P.undo.length > 40) P.undo.shift();
  }
  function undo() {
    if (!P.undo.length) { toast('Nothing to undo'); return; }
    var keepId = P.song.id;
    P.song = Core.normalizeSong(JSON.parse(P.undo.pop()));
    if (!P.song.id) P.song.id = keepId;
    afterSongChange(false);
    toast('Undone', 'info', 1000);
  }
  function markDirty() {
    if (!P) return;
    clearTimeout(P.saveT);
    P.saveT = setTimeout(saveNow, 600);
  }
  function saveNow() {
    if (!P) return;
    clearTimeout(P.saveT); P.saveT = 0;
    saveJSON(K_CUR, Core.serialize(P.song));
    saveJSON(K_PREFS, { view: P.view, cur: P.cur, bank: P.bank, follow: P.follow, vel: P.velMode, wav: P.wavBars, brush: [P.brush[Core.BS], P.brush[Core.KY]] });
  }
  // The whole song changed (undo, preset, load, new, import): rebuild everything that shows it.
  // Playback carries on; with `restart` it moves to the new song's start at the next bar.
  function afterSongChange(restart) {
    var s = P.song, c = P.cursor;
    P.cur = Math.min(P.cur, Core.NPAT - 1);
    P.page = 0;
    if (c) {
      c.song = s; c.mode = s.mode;
      if (c.pat >= Core.NPAT) c.pat = 0;
      if (restart) { P.hold = false; if (s.mode === 'song') { c.chainPos = s.chain.length - 1; c.cue = -1; } else c.cue = P.cur; }
      else if (c.chainPos >= s.chain.length) c.chainPos = 0;
    }
    applyMix();
    closePop();
    renderAll();
    markDirty();
  }
  function setStep(tr, s, v, deg) {
    var p = curPat(), was = p.v[tr][s];
    p.v[tr][s] = v;
    if (T[tr].note && v) p.n[tr][s] = deg != null ? deg : (was ? p.n[tr][s] : P.brush[tr]);
    renderCell(tr, s);
    if (!was !== !v) renderPats();
    markDirty();
  }
  var NEXT_VEL = [3, 2, 3, 1];   // off→accent, ghost→normal, normal→accent, accent→ghost
  function cycleVel(tr, s, audition) {
    pushUndo();
    var v = curPat().v[tr][s];
    setStep(tr, s, NEXT_VEL[v]);
    if (audition && !P.playing) preview(tr, curPat().n[tr][s], NEXT_VEL[v]);
    try { Cade.haptic(8); } catch (e) {}
  }
  function tapStep(tr, s) {
    var p = curPat(), v = p.v[tr][s];
    if (P.velMode) { cycleVel(tr, s, true); return; }
    pushUndo();
    setStep(tr, s, v ? 0 : 2);
    if (!v && !P.playing) preview(tr, p.n[tr][s], 2);
  }
  function preview(tr, deg, vel) {
    var a = wake();
    if (!a) return;
    var sd = Core.stepDur(P.song.bpm);
    hit(a.ac, a.R, a.G, P.song, tr, a.ac.currentTime + 0.005, vel || 2, deg || 0, T[tr].note ? sd * 4 : 0, 1);
  }
  function toggleMute(tr) {
    var m = P.song.mix[tr];
    m.mute = !m.mute;
    applyMix('bus'); renderTrackStates(); markDirty();
  }
  function toggleSolo(tr) {
    var m = P.song.mix[tr];
    m.solo = !m.solo;
    applyMix('bus'); renderTrackStates(); markDirty();
    try { Cade.haptic(10); } catch (e) {}
  }
  function selectPattern(i) {
    if (i === P.cur) return;
    P.cur = i; P.page = 0;
    if (P.playing && P.cursor) {
      if (P.song.mode === 'loop') P.cursor.cue = P.cursor.pat === i ? -1 : i;   // switch at the end of the bar
      else P.hold = i !== P.cursor.pat;                                           // song mode: look at it without being pulled away
    }
    closePop(); renderPats(); renderGrid(); renderToolbar(); markDirty();
  }
  function setMode(m) {
    var s = P.song;
    if (s.mode === m) return;
    s.mode = m;
    if (P.cursor) {
      P.cursor.mode = m;
      if (m === 'song') { P.cursor.chainPos = s.chain.length - 1; P.cursor.cue = -1; P.hold = false; }  // the chain starts at the next bar
      else P.cursor.cue = P.cur !== P.cursor.pat ? P.cur : -1;
    }
    syncTransport(); renderPats(); markDirty();
    if (P.view === 'song') renderSong();
  }
  function setLen(len) {
    var p = curPat(), old = p.len;
    if (len === old) return;
    pushUndo();
    if (len > old) {                                   // growing into silence repeats what's there
      var empty = true, t, s;
      for (t = 0; t < NT && empty; t++) for (s = old; s < len; s++) if (p.v[t][s]) { empty = false; break; }
      if (empty) for (t = 0; t < NT; t++) for (s = old; s < len; s++) { p.v[t][s] = p.v[t][s % old]; p.n[t][s] = p.n[t][s % old]; }
    }
    p.len = len; P.page = 0;
    renderGrid(); renderToolbar(); renderPats(); markDirty();
  }
  function setBpm(b, fromField) {
    var n = Math.round(Core.clamp(+b || P.song.bpm, 60, 200));
    P.song.bpm = n;
    if (P.ui.bpm && !fromField) P.ui.bpm.value = n;
    applyMix('echo'); markDirty();
  }
  function tapTempo() {
    var now = performance.now() / 1000, taps = P.taps;
    if (taps.length && now - taps[taps.length - 1] > 2) taps.length = 0;
    taps.push(now);
    if (taps.length > 6) taps.shift();
    var b = Core.tapTempo(taps);
    if (b) { setBpm(b); flash(P.ui.bpm); }
  }
  function flash(el) {
    if (!el || !el.animate) return;
    try { el.animate([{ backgroundColor: 'var(--accent-bg)' }, { backgroundColor: 'transparent' }], { duration: 260 }); } catch (e) {}
  }

  // ---- pattern tools ----
  function tool(name) {
    var p = curPat(), L = PAT_CH[P.cur];
    closePop();
    if (name === 'undo') { undo(); return; }
    if (/^len\d+$/.test(name)) { setLen(+name.slice(3)); return; }
    if (name === 'acc') { P.velMode = !P.velMode; renderToolbar(); markDirty(); toast('Accent mode ' + (P.velMode ? 'on — taps cycle x → X → g' : 'off'), 'info', 1400); return; }
    if (name === 'follow') { P.follow = !P.follow; renderPages(); markDirty(); return; }
    if (name === 'copy') { P.clip = Core.copyPattern(p); P.clipFrom = P.cur; toast('Copied pattern ' + L, 'info', 1200); return; }
    if (name === 'paste') {
      if (!P.clip) { toast('Copy a pattern first'); return; }
      pushUndo(); P.song.pats[P.cur] = Core.copyPattern(P.clip);
      toast('Pasted ' + PAT_CH[P.clipFrom] + ' → ' + L, 'info', 1200);
    } else if (name === 'clear') { pushUndo(); Core.clearPattern(p); toast('Cleared ' + L + ' (⋯ → Undo to bring it back)', 'info', 2200); }
    else if (name === 'random') { pushUndo(); Core.randomizePattern(p, Math.random, P.song.scale); }
    else if (name === 'mutate') { pushUndo(); Core.mutatePattern(p, Math.random, P.song.scale); }
    else if (name === 'left' || name === 'right') { pushUndo(); Core.shiftPattern(p, name === 'left' ? -1 : 1); }
    else return;
    renderGrid(); renderPats(); markDirty();
  }

  // ---- pads ----
  function padHit(i) {
    var a = wake();
    if (!a) return;
    var t = a.ac.currentTime + 0.003;
    if (P.bank === 'fx') { if (i < FX.length) fxPlay(a.ac, a.R, a.G, P.song, i, t); }
    else if (i < NT) {
      hit(a.ac, a.R, a.G, P.song, i, t, 2, P.brush[i] || 0, T[i].note ? Core.stepDur(P.song.bpm) * 4 : 0, 1.15);
      recordHit(i);
    } else if (i === NT) vCrash(a.ac, a.R, a.G.fx, t, 0.9);
    flashPad(i);
  }
  function flashPad(i) {
    var el = P.ui.pads && P.ui.pads[i];
    if (!el) return;
    if (el.animate) { try { el.animate([{ transform: 'scale(0.94)', filter: 'brightness(1.25)' }, { transform: 'none', filter: 'none' }], { duration: 170, easing: 'ease-out' }); } catch (e) {} }
  }
  // KIT + REC while playing: write the hit at the nearest step of the playing pattern.
  function recordHit(tr) {
    if (!P.rec || !P.playing || !A) return;
    var tap = A.ac.currentTime - A.lat - 0.012, an = P.lastStep;
    for (var i = 0; i < P.queue.length; i++) if (P.queue[i].t <= tap) an = P.queue[i];
    if (!an) return;
    var p = P.song.pats[an.pat], r = Core.quantize(tap, an.gt, an.step, Core.stepDur(P.song.bpm), p.len), abs = an.abs + r.k;
    if (!p.v[tr][r.step]) {
      p.v[tr][r.step] = 2;
      if (T[tr].note) p.n[tr][r.step] = P.brush[tr];
      if (an.pat === P.cur) renderCell(tr, r.step);
      renderPats(); markDirty();
    }
    if (abs >= P.abs) P.skip[tr + ':' + abs] = 1;    // not scheduled yet: it already sounded live
  }

  // ---- songs: presets, save / load ----
  function songIndex() { var a = loadJSON(K_INDEX); return Array.isArray(a) ? a.filter(function (x) { return x && x.id; }) : []; }
  function loadPreset(i) {
    pushUndo();
    var keep = P.song;
    P.song = Core.presetSong(i);
    P.song.master = keep.master;
    P.cur = 0;
    afterSongChange(true);
    toast('Loaded ' + P.song.name + ' · ' + P.song.bpm + ' BPM', 'success', 1400);
  }
  function saveSong(asNew) {
    var s = P.song, idx = songIndex(), nameEl = q('.bt-name');
    if (nameEl) s.name = (nameEl.value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60) || 'Untitled';
    if (asNew || !s.id || !idx.some(function (x) { return x.id === s.id; })) s.id = Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    if (!saveJSON(K_SONG + s.id, Core.serialize(s))) { toast('Could not save — storage is full?', 'error', 2600); return; }
    idx = idx.filter(function (x) { return x.id !== s.id; });
    idx.unshift({ id: s.id, name: s.name, bpm: s.bpm, t: Date.now() });
    saveJSON(K_INDEX, idx);
    saveNow(); renderSong();
    toast('Saved "' + s.name + '"', 'success', 1400);
  }
  function loadSong(id) {
    var o = loadJSON(K_SONG + id);
    if (!o) { toast('That song is gone', 'error'); return; }
    pushUndo();
    P.song = Core.normalizeSong(o);
    P.song.id = id;
    P.cur = 0;
    afterSongChange(true);
    toast('Loaded "' + P.song.name + '"', 'success', 1200);
  }
  function deleteSong(id) {
    var idx = songIndex(), it = idx.filter(function (x) { return x.id === id; })[0];
    if (!it || !window.confirm('Delete "' + it.name + '"?')) return;
    try { Cade.store.remove(K_SONG + id); } catch (e) {}
    saveJSON(K_INDEX, idx.filter(function (x) { return x.id !== id; }));
    if (P.song.id === id) P.song.id = '';
    renderSong();
  }
  function newSong() {
    pushUndo();
    var keep = P.song;
    P.song = Core.emptySong();
    P.song.master = keep.master; P.song.bpm = keep.bpm; P.song.kit = keep.kit;
    P.cur = 0;
    afterSongChange(true);
    toast('New song (⋯ → Undo to go back)', 'info', 1600);
  }

  // ---- ASCII tab in / out of the note ----
  function insertTab(all) {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
    var text = Core.toTab(P.song, P.cur, all), sel = ed.state.selection.main, line = ed.state.doc.lineAt(sel.to);
    var ins = (sel.to > line.from ? '\n' : '') + '```\n' + text + '\n```\n';
    ed.dispatch({ changes: { from: sel.to, insert: ins }, selection: { anchor: sel.to + ins.length }, scrollIntoView: true, userEvent: 'input' });
    toast(all ? 'Song tab inserted into the note' : 'Pattern ' + PAT_CH[P.cur] + ' inserted into the note', 'success', 1600);
  }
  function fenceAround(ed, pos) {
    var doc = ed.state.doc, ln = doc.lineAt(pos).number, a = -1, b = -1, i;
    for (i = ln; i >= 1 && i > ln - 300; i--) if (/^\s*```/.test(doc.line(i).text)) { a = i; break; }
    for (i = ln + (a === ln ? 1 : 0); i <= doc.lines && i < ln + 300; i++) if (i !== a && /^\s*```/.test(doc.line(i).text)) { b = i; break; }
    if (a < 0 || b < 0 || b - a < 2) return null;
    return ed.state.sliceDoc(doc.line(a + 1).from, doc.line(b - 1).to);
  }
  function importTab() {
    var ed = Cade.editor;
    if (!ed) return;
    var sel = ed.state.selection.main, text = sel.empty ? '' : ed.state.sliceDoc(sel.from, Math.min(sel.to, sel.from + 200000));
    if (!text.trim()) text = fenceAround(ed, sel.head) || ed.state.sliceDoc(0, Math.min(ed.state.doc.length, 200000));
    var r = Core.fromTab(text);
    if (!r.tracks) { toast('No drum tab found — select lines like "KK |x---x---|"', 'error', 3200); return; }
    pushUndo();
    var done = Core.applyTab(P.song, r, P.cur);
    if (done.length) P.cur = done[0];
    afterSongChange(true);
    toast('Imported ' + r.tracks + ' row' + (r.tracks === 1 ? '' : 's') + ' into ' + done.map(function (i) { return PAT_CH[i]; }).join(', ') +
      (r.unknown.length ? ' · skipped ' + r.unknown.slice(0, 4).join(', ') : ''), 'success', 2600);
  }

  // ---- WAV export (OfflineAudioContext) ----
  function slug(s) { return String(s || 'beat').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'beat'; }
  function renderWav() {
    if (!OAC) { toast('This browser cannot render audio offline', 'error', 2400); return; }
    if (P.rendering) return;
    var song = Core.cloneSong(P.song), songMode = P.wavBars === 'song', steps = songMode ? Core.songSteps(song) : (+P.wavBars || 4) * 16;
    var sd = Core.stepDur(song.bpm);
    steps = Math.min(steps, Math.floor(WAV_MAX_S / sd));
    var plan = Core.plan(song, { mode: songMode ? 'song' : 'loop', pat: P.cur, steps: steps }), sr = 44100;
    var loopLen = Math.round(plan.duration * sr), tail = Math.round(2.5 * sr), oac;
    try { oac = new OAC(2, loopLen + tail, sr); } catch (e) { toast('Could not start the renderer', 'error'); return; }
    var R = makeRes(oac), G = buildGraph(oac, song), h = song.human / 100;
    plan.events.forEach(function (e) {
      var t = e.time + 0.004, gm = 1;
      if (h) { t += (Math.random() * 2 - 1) * h * 0.012; gm = 1 + (Math.random() * 2 - 1) * h * 0.3; }
      try { hit(oac, R, G, song, e.track, Math.max(0, t), e.vel, e.deg, e.len, gm); } catch (er) {}
    });
    P.rendering = true;
    var st = P, btn = q('[data-act="wav"]');
    if (btn) { btn.disabled = true; btn.textContent = 'rendering…'; }
    var finish = function (buf) {
      if (P !== st) return;
      P.rendering = false;
      var chans = [buf.getChannelData(0), buf.getChannelData(1)];
      var out = songMode ? chans.map(function (c) { return new Float32Array(c); }) : Core.foldTail(chans, loopLen);
      var pk = Core.peak(out);
      if (pk > 0.98) out.forEach(function (c) { for (var i = 0; i < c.length; i++) c[i] *= 0.98 / pk; });
      var blob = new Blob([Core.encodeWAV(out, sr)], { type: 'audio/wav' });
      var name = slug(song.name) + '-' + (songMode ? 'song' : PAT_CH[P.cur] + '-' + P.wavBars + 'bar') + '-' + song.bpm + 'bpm.wav';
      download(blob, name);
      renderSong();
      toast('WAV ready · ' + (out[0].length / sr).toFixed(1) + ' s' + (songMode ? '' : ' · loops seamlessly'), 'success', 2200);
    };
    var fail = function () { if (P === st) { P.rendering = false; renderSong(); toast('Rendering failed', 'error'); } };
    try {
      var pr = oac.startRendering();
      if (pr && pr.then) pr.then(finish, fail);
      else oac.oncomplete = function (ev) { finish(ev.renderedBuffer); };
    } catch (e) { fail(); }
  }
  function download(blob, name) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    P.urls.push(url);
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
  }

  // =========================================================================
  // UI
  // =========================================================================
  var VIEWS = [['seq', 'SEQ'], ['pads', 'PADS'], ['mix', 'MIX'], ['song', 'SONG']];
  function opt(v, label, cur) { return '<option value="' + esc(v) + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + esc(label) + '</option>'; }
  function skeleton() {
    var touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    return '<div class="bt">' +
      '<div class="bt-tr">' +
        '<button type="button" class="bt-play" data-act="play" title="Play / stop (Space)" aria-label="Play">▶</button>' +
        '<span class="bt-bpm"><button type="button" class="bt-ib bt-rep" data-act="bpm" data-d="-1" aria-label="Slower">−</button>' +
          '<input class="bt-bpmin" type="text" inputmode="numeric" maxlength="3" aria-label="Tempo in BPM" spellcheck="false">' +
          '<button type="button" class="bt-ib bt-rep" data-act="bpm" data-d="1" aria-label="Faster">+</button><small>BPM</small></span>' +
        '<button type="button" class="bt-btn" data-act="tap" title="Tap tempo">TAP</button>' +
        '<button type="button" class="bt-btn bt-mode" data-act="mode" title="Loop the pattern, or play the chain"></button>' +
        '<span class="bt-pos" aria-live="off">–</span>' +
      '</div>' +
      '<div class="bt-tr2">' +
        '<span class="bt-pats" role="group" aria-label="Patterns"></span>' +
        '<span class="bt-pages"></span>' +
        '<label class="bt-sw"><span>SWING</span><input type="range" min="0" max="100" step="1" data-in="swing" aria-label="Swing"><b class="bt-swv"></b></label>' +
        '<button type="button" class="bt-btn bt-more" data-act="tools" title="Steps, accent mode, copy, paste, randomize…" aria-label="Pattern tools">⋯</button>' +
      '</div>' +
      '<div class="bt-v" data-v="seq">' +
        '<div class="bt-tools">' +
          '<span class="bt-seg bt-lens" role="group" aria-label="Steps"></span>' +
          '<span class="bt-sp"></span>' +
          '<button type="button" class="bt-btn bt-velm" data-act="velmode" title="Accent mode: taps cycle velocity (x → X → g)">ACC</button>' +
          '<button type="button" class="bt-btn" data-act="tools" title="Copy, paste, clear, randomize…" aria-label="Pattern tools">⋯</button>' +
        '</div>' +
        '<div class="bt-grid" role="grid" aria-label="Steps"></div>' +
        '<p class="bt-help">' + (touch ? 'tap: on/off · hold: accent (drums) / note (BS, KY) · tap name: mute · hold name: solo'
          : 'click/drag: paint · shift-click or right-click: accent / note · click name: mute · right-click name: solo · Space: play') +
          (IS_IOS ? '<br><span class="bt-ios">🔇 No sound? Check the silent switch.</span>' : '') + '</p>' +
      '</div>' +
      '<div class="bt-v" data-v="pads" hidden></div>' +
      '<div class="bt-v" data-v="mix" hidden></div>' +
      '<div class="bt-v" data-v="song" hidden></div>' +
      '<div class="bt-pop" hidden></div>' +
    '</div>';
  }
  function renderAll() {
    syncTransport(); renderPats(); renderToolbar(); renderGrid();
    if (P.view === 'pads') renderPads(); else if (P.view === 'mix') renderMix(); else if (P.view === 'song') renderSong();
  }
  function syncTransport() {
    if (!P) return;
    var s = P.song, u = P.ui;
    u.play.textContent = P.playing ? '■' : '▶';
    u.play.classList.toggle('on', P.playing);
    u.play.setAttribute('aria-label', P.playing ? 'Stop' : 'Play');
    if (document.activeElement !== u.bpm) u.bpm.value = s.bpm;
    u.mode.textContent = s.mode === 'song' ? '⛓ SONG' : '⟳ LOOP';
    u.mode.classList.toggle('on', s.mode === 'song');
    u.swing.value = s.swing; u.swv.textContent = s.swing + '%';
    if (!P.playing) u.pos.textContent = PAT_CH[P.cur] + ' --/' + pad2(curPat().len) + (s.mode === 'song' && !P.narrow ? ' · ' + s.chain.map(function (c) { return PAT_CH[c]; }).join('') : '');
    var sus = A && P.playing && A.ac.state !== 'running';
    P.el.classList.toggle('bt-sus', !!sus);
  }
  function renderPats() {
    if (!P) return;
    var h = '', s = P.song, cue = P.cursor && P.cursor.cue;
    for (var i = 0; i < Core.NPAT; i++) {
      var cls = 'bt-pat' + (i === P.cur ? ' on' : '') + (P.playing && i === P.playPat ? ' play' : '') + (P.playing && cue === i ? ' cue' : '') + (Core.patternHits(s.pats[i]) ? '' : ' empty');
      h += '<button type="button" class="' + cls + '" data-act="pat" data-p="' + i + '" aria-pressed="' + (i === P.cur) + '" title="Pattern ' + PAT_CH[i] + '">' + PAT_CH[i] + '</button>';
    }
    if (P.ui.pats.innerHTML !== h) P.ui.pats.innerHTML = h;
  }
  function pagesOf() { return Math.max(1, Math.ceil(curPat().len / P.per)); }
  function renderToolbar() {
    var p = curPat(), h = '';
    Core.LENS.forEach(function (l) { h += '<button type="button" class="' + (p.len === l ? 'on' : '') + '" data-act="len" data-l="' + l + '">' + l + '</button>'; });
    P.ui.lens.innerHTML = h;
    P.ui.velm.classList.toggle('on', P.velMode);
    renderPages();
  }
  function renderPages() {
    var n = pagesOf(), h = '';
    if (P.page >= n) P.page = 0;
    if (n > 1) {
      for (var i = 0; i < n; i++) h += '<button type="button" class="' + (i === P.page ? 'on' : '') + '" data-act="page" data-pg="' + i + '" title="Steps ' + (i * P.per + 1) + '–' + ((i + 1) * P.per) + '">' + (n > 2 ? i + 1 : (i * P.per + 1) + '–' + ((i + 1) * P.per)) + '</button>';
      if (!P.narrow) h += '<button type="button" class="bt-follow' + (P.follow ? ' on' : '') + '" data-act="follow" title="Follow the playhead">⇥</button>';
    }
    P.ui.pages.innerHTML = h;
    P.ui.pages.classList.toggle('bt-seg', n > 1);
  }
  function cellHTML(tr, s, p) {
    var v = p.v[tr][s], cls = 'bt-c' + (v ? ' v' + v : '') + ((s >> 2) & 1 ? ' alt' : '') + (s % 4 === 0 ? ' b' : '');
    var txt = '·';
    if (v) {
      if (T[tr].note) {
        var m = Core.degreeMidi(p.n[tr][s], P.song.key, P.song.scale, tr);
        txt = Core.noteName(m, false, P.song.key, P.song.scale) + '<i>' + (Math.floor(m / 12) - 1) + '</i>';
      } else txt = Core.VEL_CH.charAt(v);
    }
    return '<span class="' + cls + '" data-t="' + tr + '" data-s="' + s + '">' + txt + '</span>';
  }
  function brushName(tr) { return Core.noteName(Core.degreeMidi(P.brush[tr] || 0, P.song.key, P.song.scale, tr), true, P.song.key, P.song.scale); }
  function renderGrid() {
    if (!P) return;
    var p = curPat(), per = P.per, pages = pagesOf();
    if (P.page >= pages) P.page = 0;
    var s0 = P.page * per, n = Math.min(per, p.len - s0), h = '<div class="bt-row bt-ruler" aria-hidden="true"><span class="bt-lab"></span>', s, tr;
    for (s = s0; s < s0 + n; s++) h += '<span class="bt-rc' + (s % 4 === 0 ? ' b' : '') + '">' + (s % 4 === 0 ? (s / 4 + 1) : '·') + '</span>';
    h += '</div>';
    for (tr = 0; tr < NT; tr++) {
      h += '<div class="bt-row bt-t' + tr + '" data-row="' + tr + '"><span class="bt-lab" data-lab="' + tr + '" title="' + esc(T[tr].name) + ' — tap: mute · hold: solo">' +
        '<b>' + T[tr].code + '</b>' + (T[tr].note ? '<small>' + brushName(tr) + '</small>' : '') + '</span>';
      for (s = s0; s < s0 + n; s++) h += cellHTML(tr, s, p);
      h += '</div>';
    }
    var g = P.ui.grid;
    g.style.setProperty('--n', n);
    g.innerHTML = h;
    P.colCells = []; P.cells = []; P.phCol = -1;
    var rows = g.children;
    for (var c = 0; c < n; c++) P.colCells.push([rows[0].children[c + 1]]);
    for (tr = 0; tr < NT; tr++) {
      var kids = rows[tr + 1].children, arr = [];
      for (c = 0; c < n; c++) { arr.push(kids[c + 1]); P.colCells[c].push(kids[c + 1]); }
      P.cells.push(arr);
    }
    P.gridS0 = s0; P.gridN = n;
    renderTrackStates();
  }
  function renderCell(tr, s) {
    var i = s - P.gridS0;
    if (i < 0 || i >= P.gridN || !P.cells[tr]) return;
    var old = P.cells[tr][i], tmp = document.createElement('div');
    tmp.innerHTML = cellHTML(tr, s, curPat());
    var el = tmp.firstChild;
    if (old.classList.contains('ph')) el.classList.add('ph');
    old.parentNode.replaceChild(el, old);
    P.cells[tr][i] = el;
    var col = P.colCells[i];
    for (var k = 0; k < col.length; k++) if (col[k] === old) col[k] = el;
  }
  function renderTrackStates() {
    var g = P.ui.grid, solo = P.song.mix.some(function (m) { return m.solo; });
    for (var tr = 0; tr < NT; tr++) {
      var row = g.querySelector('[data-row="' + tr + '"]'), m = P.song.mix[tr];
      if (!row) continue;
      row.classList.toggle('mute', m.mute);
      row.classList.toggle('solo', m.solo);
      row.classList.toggle('dim', !m.mute && solo && !m.solo);
    }
    if (P.view === 'mix') syncMixRows();
  }
  function setView(v) {
    if (v === P.view) return;
    P.view = v;
    P.root.setAttribute('data-cur', v);
    closePop();
    var vs = P.el.querySelectorAll('.bt-v');
    for (var i = 0; i < vs.length; i++) vs[i].hidden = vs[i].getAttribute('data-v') !== v;
    var bs = P.seg.querySelectorAll('[data-view]');
    for (i = 0; i < bs.length; i++) { var on = bs[i].getAttribute('data-view') === v; bs[i].classList.toggle('on', on); bs[i].setAttribute('aria-selected', on ? 'true' : 'false'); }
    if (v === 'seq') { refreshPer(true); setPlayhead(-1); }
    else if (v === 'pads') renderPads();
    else if (v === 'mix') renderMix();
    else renderSong();
    markDirty();
  }

  // ---- PADS view ----
  function renderPads() {
    var box = q('.bt-v[data-v="pads"]'), fx = P.bank === 'fx', n = fx ? FX.length : KIT_PADS.length, h = '', fine = !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    h += '<div class="bt-tools">' +
      '<span class="bt-seg"><button type="button" data-act="bank" data-b="fx" class="' + (fx ? 'on' : '') + '">FX</button><button type="button" data-act="bank" data-b="kit" class="' + (fx ? '' : 'on') + '">KIT</button></span>' +
      (fx ? '' : '<button type="button" class="bt-btn bt-rec' + (P.rec ? ' on' : '') + '" data-act="rec" title="Record kit hits into the playing pattern (quantized to 1/16)">● REC</button>') +
      '<span class="bt-sp"></span>' +
      (fx ? '<label class="bt-sw bt-echo"><span>ECHO</span><input type="range" min="0" max="100" data-in="echo" value="' + Math.round(P.song.echo * 100) + '" aria-label="Echo on the FX pads"><b>' + Math.round(P.song.echo * 100) + '%</b></label>' : '') +
      '</div><div class="bt-pads' + (fx ? '' : ' kit') + '">';
    for (var i = 0; i < n; i++) {
      var name = fx ? FX[i].name : KIT_PADS[i];
      h += '<button type="button" class="bt-pad' + (fx ? ' fx f' + (i >> 2) : ' bt-t' + Math.min(i, NT - 1) + (i === NT ? ' crash' : '')) + '" data-pad="' + i + '">' +
        '<b>' + esc(name) + '</b>' + (!fx && T[i] && T[i].note ? '<small>' + brushName(i) + '</small>' : '') + (fine ? '<kbd>' + PAD_KEYS.charAt(i).toUpperCase() + '</kbd>' : '') + '</button>';
    }
    var kr = function (a) { return a.map(function (x) { return '<span class="bt-nw">' + x + '</span>'; }).join(' · '); };
    h += '</div><p class="bt-help">' + (fx ? 'One-shots that play over the loop' + (fine ? '. Keys: ' + kr(['1–4', 'Q–R', 'A–F', 'Z–V']) : '') + '.'
      : 'Finger-drum the kit' + (fine ? ' (keys ' + kr(['1–4', 'Q–R', 'A–F']) + ')' : '') + '. With ● REC on and the loop playing, hits land in the playing pattern, quantized to 1/16.') +
      (IS_IOS ? '<br><span class="bt-ios">🔇 No sound? Check the silent switch.</span>' : '') + '</p>';
    box.innerHTML = h;
    P.ui.pads = box.querySelectorAll('.bt-pad');
  }

  // ---- MIX view ----
  function renderMix() {
    var box = q('.bt-v[data-v="mix"]'), s = P.song, h = '', i;
    function sel(name, label, opts) { return '<label class="bt-f"><span>' + label + '</span><select data-sel="' + name + '">' + opts + '</select></label>'; }
    var kits = Core.KIT_ORDER.map(function (k) { return opt(k, Core.KITS[k].name, s.kit); }).join('');
    var keys = Core.NOTE_NAMES.map(function (n, k) { return opt(k, Core.rootName(k, s.scale), s.key); }).join('');
    var scales = Core.SCALE_ORDER.map(function (k) { return opt(k, Core.SCALES[k].name, s.scale); }).join('');
    var bass = Core.BASS_ORDER.map(function (k) { return opt(k, Core.BASS_SOUNDS[k], s.bass); }).join('');
    var ksnd = Core.KEY_ORDER.map(function (k) { return opt(k, Core.KEY_SOUNDS[k], s.keys); }).join('');
    function slider(key, label, val, txt) { return '<label class="bt-sl"><span>' + label + '</span><input type="range" min="0" max="100" data-in="' + key + '" value="' + val + '" aria-label="' + label + '"><b data-out="' + key + '">' + txt + '</b></label>'; }
    h += '<div class="bt-h">── master</div>' +
      '<div class="bt-mrow bt-master"><span class="bt-mname"><b>OUT</b><small>master</small></span><input type="range" min="0" max="100" data-in="master" value="' + Math.round(s.master * 100) + '" aria-label="Master volume"><b class="bt-mv" data-out="master">' + Math.round(s.master * 100) + '</b><span class="bt-meter" data-meter="' + NT + '"></span></div>' +
      slider('swing', 'SWING', s.swing, s.swing + '%') +
      slider('tone', 'TONE', Math.round(s.tone * 100), toneLabel(s.tone)) +
      slider('human', 'HUMANIZE', s.human, s.human + '%') +
      '<div class="bt-fs">' + sel('kit', 'KIT', kits) + sel('key', 'KEY', keys) + sel('scale', 'SCALE', scales) + sel('bass', 'BASS', bass) + sel('keys', 'KEYS', ksnd) + '</div>' +
      '<div class="bt-h">── tracks</div>';
    for (i = 0; i < NT; i++) {
      var m = s.mix[i];
      h += '<div class="bt-mrow bt-t' + i + '" data-mrow="' + i + '"><span class="bt-mname"><b>' + T[i].code + '</b><small>' + esc(T[i].name) + '</small></span>' +
        '<input type="range" min="0" max="100" data-in="vol" data-t="' + i + '" value="' + Math.round(m.vol * 100) + '" aria-label="' + esc(T[i].name) + ' volume">' +
        '<button type="button" class="bt-ms' + (m.mute ? ' on' : '') + '" data-act="mute" data-t="' + i + '" aria-pressed="' + m.mute + '" title="Mute">M</button>' +
        '<button type="button" class="bt-ms solo' + (m.solo ? ' on' : '') + '" data-act="solo" data-t="' + i + '" aria-pressed="' + m.solo + '" title="Solo">S</button>' +
        '<span class="bt-meter" data-meter="' + i + '"></span></div>';
    }
    box.innerHTML = h;
    P.ui.meters = [];
    var ms = box.querySelectorAll('[data-meter]');
    for (i = 0; i < ms.length; i++) P.ui.meters[+ms[i].getAttribute('data-meter')] = ms[i];
    P.meterN = [];
    for (i = 0; i <= NT; i++) drawMeter(i, 0);
    syncMixRows();
  }
  function toneLabel(x) { return x >= 0.99 ? 'open' : (toneHz(x) >= 1000 ? (toneHz(x) / 1000).toFixed(1) + 'k' : Math.round(toneHz(x))) ; }
  function syncMixRows() {
    var box = q('.bt-v[data-v="mix"]'), solo = P.song.mix.some(function (m) { return m.solo; });
    if (!box || box.hidden) return;
    for (var i = 0; i < NT; i++) {
      var row = box.querySelector('[data-mrow="' + i + '"]'), m = P.song.mix[i];
      if (!row) continue;
      var b = row.querySelectorAll('.bt-ms');
      b[0].classList.toggle('on', m.mute); b[0].setAttribute('aria-pressed', m.mute);
      b[1].classList.toggle('on', m.solo); b[1].setAttribute('aria-pressed', m.solo);
      row.classList.toggle('dim', m.mute || (solo && !m.solo));
    }
  }

  // ---- SONG view ----
  function renderSong() {
    var box = q('.bt-v[data-v="song"]');
    if (!box || box.hidden) return;
    var s = P.song, idx = songIndex(), h = '', i;
    h += '<div class="bt-h">── song</div>' +
      '<div class="bt-line"><input class="bt-name" type="text" maxlength="60" value="' + esc(s.name) + '" aria-label="Song name" spellcheck="false">' +
      '<button type="button" class="bt-btn pri" data-act="save">SAVE</button><button type="button" class="bt-btn" data-act="saveas" title="Save as a new song">COPY</button><button type="button" class="bt-btn" data-act="new" title="Start an empty song">NEW</button></div>' +
      '<div class="bt-h">── chain <small>' + (s.mode === 'song' ? 'playing in SONG mode' : 'plays in ⛓ SONG mode') + '</small></div>' +
      '<div class="bt-chain">';
    for (i = 0; i < s.chain.length; i++) h += '<button type="button" class="bt-cs" data-act="cslot" data-ci="' + i + '" title="Tap to change">' + PAT_CH[s.chain[i]] + '</button>';
    h += '</div><div class="bt-line bt-cadd">';
    for (i = 0; i < Core.NPAT; i++) h += '<button type="button" class="bt-btn" data-act="cadd" data-p="' + i + '"' + (s.chain.length >= 16 ? ' disabled' : '') + '>+' + PAT_CH[i] + '</button>';
    h += '<button type="button" class="bt-btn" data-act="cpop"' + (s.chain.length < 2 ? ' disabled' : '') + ' aria-label="Remove the last">⌫</button></div>' +
      '<div class="bt-h">── presets</div><div class="bt-presets">';
    Core.PRESETS.forEach(function (ps, k) { h += '<button type="button" class="bt-pre" data-act="preset" data-i="' + k + '"><b>' + esc(ps.name) + '</b><small>' + ps.bpm + ' · ' + esc(ps.style) + '</small></button>'; });
    h += '</div><div class="bt-h">── saved <small>' + idx.length + '</small></div>';
    if (!idx.length) h += '<p class="bt-note">Nothing saved yet — SAVE keeps this song on this device.</p>';
    else {
      h += '<div class="bt-songs">';
      idx.forEach(function (it) {
        h += '<div class="bt-srow' + (it.id === s.id ? ' on' : '') + '"><button type="button" class="bt-sload" data-act="load" data-id="' + esc(it.id) + '"><b>' + esc(it.name) + '</b><small>' + (+it.bpm || '') + ' BPM · ' + ago(it.t) + '</small></button>' +
          '<button type="button" class="bt-ib" data-act="del" data-id="' + esc(it.id) + '" aria-label="Delete ' + esc(it.name) + '">×</button></div>';
      });
      h += '</div>';
    }
    var wb = P.wavBars, wopts = [['1', '1 bar'], ['2', '2 bars'], ['4', '4 bars'], ['8', '8 bars'], ['song', 'whole chain']].map(function (o) { return opt(o[0], o[1], wb); }).join('');
    h += '<div class="bt-h">── export</div>' +
      '<div class="bt-line"><button type="button" class="bt-btn" data-act="tab" data-all="0" title="Insert pattern ' + PAT_CH[P.cur] + ' into the note as an ASCII drum tab">⇣ TAB ' + PAT_CH[P.cur] + '</button>' +
      '<button type="button" class="bt-btn" data-act="tab" data-all="1" title="Insert every pattern in the chain + the chain">⇣ SONG TAB</button>' +
      '<button type="button" class="bt-btn" data-act="import" title="Read a drum tab from the selection (or the ``` block at the cursor)">⇡ IMPORT</button></div>' +
      '<div class="bt-line"><label class="bt-f"><span>WAV</span><select data-sel="wav">' + wopts + '</select></label>' +
      '<button type="button" class="bt-btn pri" data-act="wav"' + (P.rendering ? ' disabled' : '') + '>' + (P.rendering ? 'rendering…' : '⤓ DOWNLOAD WAV') + '</button></div>' +
      '<p class="bt-note">Loops render seamlessly (the tail wraps to the start). Tabs go in a ``` block at the cursor; IMPORT reads the selection, the block at the cursor, or the note.</p>';
    box.innerHTML = h;
    if (P.playing && s.mode === 'song' && P.lastStep) markChain(P.lastStep.chain);
  }
  function markChain(ci) {
    var cs = P.el.querySelectorAll('.bt-cs');
    for (var i = 0; i < cs.length; i++) cs[i].classList.toggle('play', i === ci);
  }
  function ago(t) {
    var d = (Date.now() - (+t || 0)) / 1000;
    return d < 90 ? 'just now' : d < 3600 ? Math.round(d / 60) + ' min ago' : d < 86400 ? Math.round(d / 3600) + ' h ago' : Math.round(d / 86400) + ' d ago';
  }

  // ---- popover: note picker / tools ----
  function openPop(html, anchor) {
    var pop = P.ui.pop;
    pop.innerHTML = html;
    pop.hidden = false;
    P.pop = true;
    var pr = P.el.getBoundingClientRect(), ar = anchor.getBoundingClientRect(), w = pop.offsetWidth, hgt = pop.offsetHeight;
    var x = Math.max(6, Math.min(pr.width - w - 6, ar.left - pr.left + ar.width / 2 - w / 2));
    var y = ar.bottom - pr.top + 6;
    if (y + hgt > pr.height - 6) y = Math.max(6, ar.top - pr.top - hgt - 6);
    pop.style.left = x + 'px'; pop.style.top = y + 'px';
  }
  function closePop() {
    if (!P || !P.pop) return;
    P.pop = false; P.pick = null;
    P.ui.pop.hidden = true; P.ui.pop.innerHTML = '';
  }
  function openPicker(tr, s, cell) {
    var song = P.song, p = curPat(), sl = Core.scaleLen(song.scale), v = p.v[tr][s], cur = v ? p.n[tr][s] : P.brush[tr];
    P.pick = { tr: tr, s: s };
    var h = '<div class="bt-pk-h"><b>' + T[tr].code + '</b> step ' + (s + 1) + ' <small>' + Core.rootName(song.key, song.scale) + ' ' + Core.SCALES[song.scale].name + '</small><button type="button" class="bt-ib" data-pk="x" aria-label="Close">×</button></div><div class="bt-pk-n" style="--c:' + sl + '">';
    for (var o = 2; o >= 0; o--) {
      for (var i = 0; i < sl; i++) {
        var d = o * sl + i;
        if (o === 2 && i > 0) { h += '<span></span>'; continue; }
        var m = Core.degreeMidi(d, song.key, song.scale, tr);
        h += '<button type="button" data-pk="n" data-d="' + d + '" class="' + (d === cur ? 'on' : '') + (i === 0 ? ' root' : '') + '">' + Core.noteName(m, true, song.key, song.scale) + '</button>';
      }
    }
    h += '</div><div class="bt-pk-v"><button type="button" data-pk="v" data-v="1" class="' + (v === 1 ? 'on' : '') + '">g soft</button><button type="button" data-pk="v" data-v="2" class="' + (v === 2 ? 'on' : '') + '">x norm</button>' +
      '<button type="button" data-pk="v" data-v="3" class="' + (v === 3 ? 'on' : '') + '">X acc</button><button type="button" data-pk="v" data-v="0" class="clr">clear</button></div>';
    openPop(h, cell);
  }
  function pickerAct(b) {
    var pk = P.pick;
    if (!pk) return;
    var kind = b.getAttribute('data-pk'), p = curPat();
    if (kind === 'x') { closePop(); return; }
    pushUndo();
    if (kind === 'n') {
      var d = +b.getAttribute('data-d');
      P.brush[pk.tr] = d;
      setStep(pk.tr, pk.s, p.v[pk.tr][pk.s] || 2, d);
      if (!P.playing) preview(pk.tr, d, p.v[pk.tr][pk.s]);
      closePop();
      renderBrush(pk.tr);
    } else {
      var v = +b.getAttribute('data-v');
      setStep(pk.tr, pk.s, v);
      if (!v) { closePop(); return; }
      if (!P.playing) preview(pk.tr, p.n[pk.tr][pk.s], v);
      var vb = P.ui.pop.querySelectorAll('[data-pk="v"]');
      for (var i = 0; i < vb.length; i++) vb[i].classList.toggle('on', +vb[i].getAttribute('data-v') === v);
    }
  }
  function renderBrush(tr) {
    var lab = P.ui.grid.querySelector('[data-lab="' + tr + '"] small');
    if (lab) lab.textContent = brushName(tr);
    markDirty();
  }
  function openTools(anchor) {
    var L = PAT_CH[P.cur];
    var items = [['copy', 'Copy ' + L], ['paste', 'Paste' + (P.clip ? ' ' + PAT_CH[P.clipFrom] + ' → ' + L : '')], ['clear', 'Clear ' + L],
      ['random', '⚄ Randomize ' + L], ['mutate', '≈ Mutate ' + L], ['left', '◂ Shift left'], ['right', 'Shift right ▸'], ['undo', '↶ Undo' + (P.undo.length ? '' : ' (nothing)')]];
    var h = '<div class="bt-menu" role="menu">';
    if (P.narrow) {
      h += '<div class="bt-mlens"><span>STEPS</span>' + Core.LENS.map(function (l) { return '<button type="button" data-tool="len' + l + '" class="' + (curPat().len === l ? 'on' : '') + '">' + l + '</button>'; }).join('') + '</div>' +
        '<button type="button" role="menuitemcheckbox" data-tool="acc" aria-checked="' + P.velMode + '">' + (P.velMode ? '☑' : '☐') + ' Accent mode (taps cycle x → X → g)</button>' +
        '<button type="button" role="menuitemcheckbox" data-tool="follow" aria-checked="' + P.follow + '">' + (P.follow ? '☑' : '☐') + ' Follow the playhead</button><hr>';
    }
    items.forEach(function (it) { h += '<button type="button" role="menuitem" data-tool="' + it[0] + '"' + ((it[0] === 'paste' && !P.clip) || (it[0] === 'undo' && !P.undo.length) ? ' disabled' : '') + '>' + esc(it[1]) + '</button>'; });
    openPop(h + '</div>', anchor);
  }

  // ---- input ----
  function cellOf(el) { return el && el.closest ? el.closest('.bt-c') : null; }
  function onGridDown(e) {
    if (!P || e.button > 0) return;
    var t = e.target, lab = t.closest && t.closest('.bt-lab[data-lab]'), cell = cellOf(t);
    if (!lab && !cell) return;
    closePop();
    P.touchT = performance.now();
    var g = P.g = { id: e.pointerId, x: e.clientX, y: e.clientY, mouse: e.pointerType === 'mouse', done: false, moved: false, lp: 0 };
    if (lab) {
      g.lab = true; g.tr = +lab.getAttribute('data-lab');
      g.lp = setTimeout(function () { g.done = true; toggleSolo(g.tr); }, 450);
      return;
    }
    g.tr = +cell.getAttribute('data-t'); g.s = +cell.getAttribute('data-s'); g.el = cell;
    if (g.mouse) {
      if (e.shiftKey) { g.done = true; longAction(g.tr, g.s, cell); return; }
      var v = curPat().v[g.tr][g.s];
      if (P.velMode) { g.done = true; cycleVel(g.tr, g.s, true); return; }
      pushUndo();
      g.paint = v ? 0 : 2;
      setStep(g.tr, g.s, g.paint);
      if (!v && !P.playing) preview(g.tr, curPat().n[g.tr][g.s], 2);
      return;
    }
    g.lp = setTimeout(function () { g.done = true; longAction(g.tr, g.s, P.cells[g.tr][g.s - P.gridS0] || cell); }, 420);
  }
  function onGridMove(e) {
    var g = P && P.g;
    if (!g || e.pointerId !== g.id) return;
    if (g.mouse && g.paint != null && !g.lab) {
      if (!(e.buttons & 1)) return;
      var cell = cellOf(document.elementFromPoint(e.clientX, e.clientY));
      if (!cell || +cell.getAttribute('data-t') !== g.tr) return;
      var s = +cell.getAttribute('data-s');
      if (curPat().v[g.tr][s] !== g.paint && !(g.paint && curPat().v[g.tr][s])) setStep(g.tr, s, g.paint);
      return;
    }
    if (Math.abs(e.clientX - g.x) > 10 || Math.abs(e.clientY - g.y) > 10) { g.moved = true; clearTimeout(g.lp); }
  }
  function onGridUp(e) {
    var g = P && P.g;
    if (!g || e.pointerId !== g.id) return;
    P.g = null;
    clearTimeout(g.lp);
    if (g.done || g.moved) return;
    if (g.lab) { toggleMute(g.tr); return; }
    if (!g.mouse) tapStep(g.tr, g.s);
  }
  function onGridCancel() { if (P && P.g) { clearTimeout(P.g.lp); P.g = null; } }
  function onGridCtx(e) {
    var t = e.target, lab = t.closest && t.closest('.bt-lab[data-lab]'), cell = cellOf(t);
    if (!lab && !cell) return;
    e.preventDefault();
    if (P.g && P.g.done) return;                       // the touch long-press already acted
    if (P.g) { clearTimeout(P.g.lp); P.g.done = true; }
    if (lab) toggleSolo(+lab.getAttribute('data-lab'));
    else longAction(+cell.getAttribute('data-t'), +cell.getAttribute('data-s'), cell);
  }
  function longAction(tr, s, cell) {
    try { Cade.haptic(12); } catch (e) {}
    if (T[tr].note) openPicker(tr, s, cell);
    else cycleVel(tr, s, true);
  }
  function onClick(e) {
    if (!P) return;
    var t = e.target, b;
    if (!t || !t.closest) return;
    if ((b = t.closest('[data-pk]'))) { pickerAct(b); return; }
    if ((b = t.closest('[data-tool]'))) { tool(b.getAttribute('data-tool')); return; }
    if ((b = t.closest('[data-view]'))) { setView(b.getAttribute('data-view')); return; }
    if (!(b = t.closest('[data-act]'))) return;
    var act = b.getAttribute('data-act');
    switch (act) {
      case 'play': togglePlay(); break;
      case 'bpm': if (e.detail === 0) setBpm(P.song.bpm + +b.getAttribute('data-d')); break;   // keyboard; pointers repeat on hold
      case 'tap': tapTempo(); break;
      case 'mode': setMode(P.song.mode === 'song' ? 'loop' : 'song'); break;
      case 'pat': selectPattern(+b.getAttribute('data-p')); break;
      case 'len': setLen(+b.getAttribute('data-l')); break;
      case 'page': P.page = +b.getAttribute('data-pg'); P.follow = false; renderGrid(); renderPages(); break;
      case 'follow': P.follow = !P.follow; renderPages(); markDirty(); break;
      case 'velmode': P.velMode = !P.velMode; renderToolbar(); markDirty(); break;
      case 'tools': if (P.pop) closePop(); else openTools(b); break;
      case 'bank': P.bank = b.getAttribute('data-b'); renderPads(); markDirty(); break;
      case 'rec': P.rec = !P.rec; if (P.rec) { pushUndo(); if (!P.playing) toast('Recording arms — press ▶ and play the pads', 'info', 2000); } renderPads(); break;
      case 'mute': toggleMute(+b.getAttribute('data-t')); break;
      case 'solo': toggleSolo(+b.getAttribute('data-t')); break;
      case 'save': saveSong(false); break;
      case 'saveas': saveSong(true); break;
      case 'new': newSong(); break;
      case 'preset': loadPreset(+b.getAttribute('data-i')); break;
      case 'load': loadSong(b.getAttribute('data-id')); break;
      case 'del': deleteSong(b.getAttribute('data-id')); break;
      case 'cslot': { var ci = +b.getAttribute('data-ci'); P.song.chain[ci] = (P.song.chain[ci] + 1) % Core.NPAT; renderSong(); syncTransport(); markDirty(); break; }
      case 'cadd': if (P.song.chain.length < 16) { P.song.chain.push(+b.getAttribute('data-p')); renderSong(); syncTransport(); markDirty(); } break;
      case 'cpop': if (P.song.chain.length > 1) { P.song.chain.pop(); renderSong(); syncTransport(); markDirty(); } break;
      case 'tab': insertTab(b.getAttribute('data-all') === '1'); break;
      case 'import': importTab(); break;
      case 'wav': renderWav(); break;
    }
  }
  function onInput(e) {
    var t = e.target, k = t.getAttribute && t.getAttribute('data-in');
    if (!k || !P) return;
    var v = +t.value, s = P.song, out = function (txt) { var o = q('[data-out="' + k + '"]'); if (o) o.textContent = txt; };
    if (k === 'swing') { s.swing = v; P.ui.swv.textContent = v + '%'; if (t !== P.ui.swing) P.ui.swing.value = v; out(v + '%'); }
    else if (k === 'vol') { s.mix[+t.getAttribute('data-t')].vol = v / 100; applyMix('bus'); }
    else if (k === 'master') { s.master = v / 100; out(v); applyMix('master'); }
    else if (k === 'tone') { s.tone = v / 100; out(toneLabel(s.tone)); applyMix('tone'); }
    else if (k === 'human') { s.human = v; out(v + '%'); }
    else if (k === 'echo') { s.echo = v / 100; var o = t.parentNode.querySelector('b'); if (o) o.textContent = v + '%'; applyMix('echo'); }
    markDirty();
  }
  function onChange(e) {
    var t = e.target, k = t.getAttribute && t.getAttribute('data-sel'), s = P && P.song;
    if (!s) return;
    if (t === P.ui.bpm) { setBpm(t.value, true); t.value = s.bpm; return; }
    if (!k) return;
    if (k === 'wav') { P.wavBars = t.value; markDirty(); return; }
    if (k === 'key') s.key = +t.value;
    else if (k === 'scale') s.scale = t.value;
    else if (k === 'kit') { s.kit = t.value; applyMix('kit'); }
    else if (k === 'bass') s.bass = t.value;
    else if (k === 'keys') s.keys = t.value;
    if (k === 'key' || k === 'scale') renderGrid();
    if (k === 'scale' && P.view === 'mix') renderMix();
    if (!P.playing) {
      if (k === 'kit') preview(Core.KK, 0, 3);
      else if (k === 'bass') preview(Core.BS, P.brush[Core.BS], 2);
      else if (k === 'keys' || k === 'key' || k === 'scale') preview(Core.KY, P.brush[Core.KY], 2);
    }
    markDirty();
  }
  // Hold − / + to keep changing the tempo.
  function onRepDown(e) {
    var b = e.target.closest && e.target.closest('.bt-rep');
    if (!b || e.button > 0) return;
    e.preventDefault();
    try { b.setPointerCapture(e.pointerId); } catch (er) {}
    var d = +b.getAttribute('data-d');
    setBpm(P.song.bpm + d);
    stopRep();
    P.rep = setTimeout(function () { P.repI = setInterval(function () { setBpm(P.song.bpm + d); }, 70); }, 380);
  }
  function stopRep() { if (!P) return; clearTimeout(P.rep); clearInterval(P.repI); P.rep = P.repI = 0; }
  function onPadDown(e) {
    var b = e.target.closest && e.target.closest('[data-pad]');
    if (!b || e.button > 0) return;
    e.preventDefault();
    padHit(+b.getAttribute('data-pad'));
  }
  // Panel-wide: a tap anywhere resumes audio that iOS (or the idle timer) suspended;
  // a tap outside the popover closes it.
  function onPanelDown(e) {
    if (P.pop && !(e.target.closest && e.target.closest('.bt-pop, [data-act="tools"]'))) closePop();
    if (A && (P.playing || e.target.closest('[data-pad], .bt-c, [data-act="play"]')) && A.ac.state !== 'running') { try { A.ac.resume().catch(noop); } catch (er) {} }
  }
  function focusOk() {
    var ae = document.activeElement;
    if (!ae || ae === document.body || ae === document.documentElement) return true;
    if (!P.el.contains(ae)) return false;              // the editor or another panel has the keyboard
    if (ae.isContentEditable || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT') return false;
    if (ae.tagName === 'INPUT' && !/^(range|checkbox|radio|button)$/.test(ae.type)) return false;
    return true;
  }
  function onKey(e) {
    if (!P) return;
    if (Cade.isMinimized && Cade.isMinimized(P.el)) return;   // parked in the dock: keys belong to the editor
    if (!focusOk()) return;
    var k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && (k === 'z' || k === 'Z')) { e.preventDefault(); undo(); return; }
    if (mod || e.altKey) return;
    var ae = document.activeElement;
    if (k === ' ' || k === 'Spacebar') {
      e.preventDefault(); e.stopPropagation();
      if (ae && ae !== document.body && ae.blur) ae.blur();       // no button "click" on keyup
      if (!e.repeat) togglePlay();
      return;
    }
    if (k === 'Escape' && P.pop) { e.preventDefault(); closePop(); return; }
    if (P.view === 'pads' && k.length === 1) {
      var i = PAD_KEYS.indexOf(k.toLowerCase()), n = P.bank === 'fx' ? FX.length : KIT_PADS.length;
      if (i >= 0 && i < n) { e.preventDefault(); if (!e.repeat) padHit(i); }
    }
  }
  function onVis() {
    if (!P) return;
    if (document.hidden) { P.look = LOOK_HIDDEN; stopRaf(); if (P.playing) tick(); }
    else {
      P.look = LOOK;
      if (A && P.playing && A.ac.state !== 'running') { try { A.ac.resume().catch(noop); } catch (e) {} }
      startRaf();
    }
  }
  // 16 steps per page when they fit (≥ 30 px each), else 8.
  function refreshPer(force) {
    if (!P || P.view !== 'seq' || isMin()) return;
    var w = P.ui.grid.clientWidth || P.el.clientWidth;
    if (!w) return;
    var per = w >= 560 ? 16 : 8, narrow = per === 8;
    if (narrow !== P.narrow) { P.narrow = narrow; P.root.classList.toggle('bt-narrow', narrow); syncTransport(); force = true; }
    if (per !== P.per || force) {
      if (per !== P.per && P.lastStep && P.playing) P.page = Math.floor(P.lastStep.step / per);
      P.per = per;
      renderPages(); renderGrid();
    }
  }

  // ---- open / close ----
  function teardown() {
    if (!P) return;
    var st = P;
    stop();
    clearTimeout(st.saveT); clearTimeout(st.idleT); stopRep(); stopRaf();
    if (st.g) clearTimeout(st.g.lp);
    saveNow();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVis);
    if (st.ro) st.ro.disconnect();
    playbackSession(false);
    if (st.silent) { try { st.silent.pause(); st.silent.removeAttribute('src'); st.silent.load(); } catch (e) {} st.silent = null; }
    if (SILENT_URL) { try { URL.revokeObjectURL(SILENT_URL); } catch (e) {} SILENT_URL = null; }
    st.urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    if (A) { var ac = A.ac; A = null; try { ac.onstatechange = null; ac.close(); } catch (e) {} }
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
    var saved = loadJSON(K_CUR), prefs = loadJSON(K_PREFS) || {};
    var el = Cade.mkPanel(PANEL_ID, '🥁 Beat Maker', skeleton());
    var seg = document.createElement('div');
    seg.className = 'bt-vseg';
    seg.setAttribute('role', 'tablist');
    seg.setAttribute('aria-label', 'View');
    seg.innerHTML = VIEWS.map(function (v) { return '<button type="button" role="tab" data-view="' + v[0] + '">' + v[1] + '</button>'; }).join('');
    var head = el.querySelector('.cade-panel-head');
    if (head) head.insertBefore(seg, el.querySelector('.cade-panel-minbtn') || el.querySelector('.cade-panel-x'));
    seg.addEventListener('pointerdown', function (e) { e.stopPropagation(); });   // a control, not a drag handle
    var brush = Array.isArray(prefs.brush) ? prefs.brush : [];
    P = {
      el: el, seg: seg, song: saved ? Core.normalizeSong(saved) : Core.presetSong(0),
      view: '', narrow: false, root: null, cur: Core.clamp(prefs.cur | 0, 0, Core.NPAT - 1), page: 0, per: 16, follow: prefs.follow !== false, hold: false, velMode: !!prefs.vel,
      bank: prefs.bank === 'kit' ? 'kit' : 'fx', rec: false, wavBars: ['1', '2', '4', '8', 'song'].indexOf(String(prefs.wav)) >= 0 ? String(prefs.wav) : '4',
      brush: {}, playing: false, cursor: null, nextTime: 0, timer: 0, look: LOOK, abs: 0, queue: [], pend: [], mq: [], skip: {},
      lastStep: null, playPat: -1, raf: 0, touchT: 0, phCol: -1, colCells: [], cells: [], gridS0: 0, gridN: 0, hitT: [], hitG: [], meterN: [],
      undo: [], clip: null, clipFrom: 0, taps: [], pop: false, pick: null, g: null, saveT: 0, idleT: 0, rep: 0, repI: 0,
      rendering: false, urls: [], silent: null, prevSession: null, ro: null, ui: {}
    };
    P.brush[Core.BS] = Core.clamp(brush[0] | 0, 0, 21); P.brush[Core.KY] = Core.clamp(brush[1] | 0, 0, 21);
    var u = P.ui;
    u.play = q('.bt-play'); u.bpm = q('.bt-bpmin'); u.mode = q('.bt-mode'); u.pos = q('.bt-pos'); u.swing = q('[data-in="swing"]'); u.swv = q('.bt-swv');
    P.root = q('.bt');
    u.pats = q('.bt-pats'); u.lens = q('.bt-lens'); u.pages = q('.bt-pages'); u.velm = q('.bt-velm'); u.grid = q('.bt-grid'); u.pop = q('.bt-pop');
    el._onClose = teardown;
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('pointerdown', onPanelDown, true);
    // iOS unlocks audio on touchend: resume a context made (suspended) in this tap's pointer handler
    el.addEventListener('touchend', function () { if (A && A.want && A.ac.state !== 'running') { try { A.ac.resume().catch(noop); } catch (e) {} } }, { passive: true });
    u.grid.addEventListener('pointerdown', onGridDown);
    u.grid.addEventListener('pointermove', onGridMove);
    u.grid.addEventListener('pointerup', onGridUp);
    u.grid.addEventListener('pointercancel', onGridCancel);
    u.grid.addEventListener('contextmenu', onGridCtx);
    q('.bt-tr').addEventListener('pointerdown', onRepDown);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) { q('.bt-tr').addEventListener(ev, stopRep); });
    q('.bt-v[data-v="pads"]').addEventListener('pointerdown', onPadDown);
    q('.bt-v[data-v="pads"]').addEventListener('contextmenu', function (e) { e.preventDefault(); });
    u.bpm.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); setBpm(u.bpm.value, true); u.bpm.value = P.song.bpm; u.bpm.blur(); } });
    u.bpm.addEventListener('focus', function () { try { u.bpm.select(); } catch (e) {} });
    q('.bt-v[data-v="song"]').addEventListener('change', function (e) { if (e.target.classList.contains('bt-name')) { P.song.name = e.target.value.trim().slice(0, 60) || 'Untitled'; markDirty(); } });
    el.addEventListener('cade-panel-minimize', function () { closePop(); stopRaf(); onGridCancel(); });
    el.addEventListener('cade-panel-restore', function () { refreshPer(); startRaf(); });
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', onVis);
    if (typeof ResizeObserver === 'function') {
      var rq = 0;
      P.ro = new ResizeObserver(function () { if (rq) return; rq = requestAnimationFrame(function () { rq = 0; refreshPer(); }); });
      P.ro.observe(u.grid);
    }
    var view = ['seq', 'pads', 'mix', 'song'].indexOf(prefs.view) >= 0 ? prefs.view : 'seq';
    P.view = 'seq';
    P.root.setAttribute('data-cur', 'seq');
    refreshPer(true);
    renderAll();
    if (view !== 'seq') setView(view);
    else { var bs = seg.querySelectorAll('[data-view]'); for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-view') === 'seq'); }
  }

  Cade.registerWidget({
    name: 'Beat Maker',
    description: 'Step sequencer + sound board — synthesized drums, bass & keys, preset grooves, FX pads, ASCII drum tab and WAV loop export',
    icon: '🥁',
    tags: 'music,beat,beats,beat maker,drum machine,drums,sequencer,step sequencer,groovebox,808,909,sound board,soundboard,pads,fx,synth,loop,bpm,tempo,drum tab,tab,wav,hip hop,house,techno,trap,reggaeton,lo-fi,jam,fun',
    open: open,
    close: close,
    _core: Core,                                        // exposed for tests
    _engine: { makeRes: makeRes, buildGraph: buildGraph, hit: hit, fxPlay: fxPlay, FX: FX }
  });
})();
