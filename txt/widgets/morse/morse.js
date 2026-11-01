/* Morse Trainer — learn Morse code by ear, for Cade.txt.
 * Koch method lessons: start with two characters at full character speed,
 * copy groups by ear, reach 90% and the next character joins the set.
 * Farnsworth spacing (character speed vs effective speed), adjustable WPM,
 * tone pitch and volume. Four ways to train:
 *   Copy   — listen and type what you hear (groups from the lesson set)
 *   Send   — see a letter and key it: a straight key (hold Space / the big
 *            button; an adaptive timing decoder reads your fist) or iambic
 *            paddles (Z / X or ← / →, two big buttons; squeeze to alternate)
 *   Words  — common words, operator abbreviations and made-up callsigns
 *   Arcade — codes fall as beeps; type them before they land; the speed ramps
 * Every answer feeds per-character accuracy (a moving average); weak
 * characters come up more often everywhere. Progress persists in Cade.store
 * (cade-morse-*). The arcade runs a fixed 120 Hz step with an accumulator and
 * interpolates its glyph-atlas canvas. Keys are taken only while focus is in
 * the panel, so the editor keeps its typing. Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var CODE = {
    A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
    K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
    U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
    '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.', '=': '-...-', '+': '.-.-.'
  };
  var DECODE = {};
  for (var ck in CODE) if (Object.prototype.hasOwnProperty.call(CODE, ck)) DECODE[CODE[ck]] = ck;
  // The Koch order: rhythmically distinct characters first.
  var KOCH = 'KMURESNAPTLWI.JZ=FOY,VG5/Q92H38B?47C1D60X+'.split('');
  var ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  var ALL = KOCH.slice();
  var MIN_LESSON = 2, PASS = 0.9;

  var WORDS = ('THE AND FOR ARE BUT NOT YOU ALL ANY CAN HAD HER WAS ONE OUR OUT DAY GET HAS HIM HIS HOW MAN NEW NOW OLD SEE TWO WAY WHO ' +
    'BOY DID ITS LET PUT SAY SHE TOO USE THAT WITH HAVE THIS WILL YOUR FROM THEY KNOW WANT BEEN GOOD MUCH SOME TIME VERY WHEN COME HERE ' +
    'JUST LIKE LONG MAKE MANY OVER SUCH TAKE THAN THEM WELL WERE WHAT SAID EACH WORD HOME HAND HIGH YEAR LAST WORK BACK CALL CAME ' +
    'RADIO SIGNAL WAVE TONE NOISE CODE SEND COPY KEY HEAR LISTEN SPEED NAME CLEAR NIGHT MORNING WEATHER SUNNY RAIN WIND COLD WARM ' +
    'ABOUT AFTER AGAIN BELOW COULD EVERY FIRST FOUND GREAT HOUSE LARGE LIGHT MIGHT NEVER OTHER PLACE POINT RIGHT SMALL SOUND STILL ' +
    'STUDY THEIR THERE THESE THING THINK THREE WATER WHERE WHICH WORLD WOULD WRITE QUICK BROWN JUMPS LAZY FOX ZERO OXYGEN JAZZ').split(' ');
  // Operator shorthand (generic, traditional).
  var ABBR = ('CQ DE K KN SK AR BK RST UR ES TNX TU FB OM YL HR QTH QRZ QSL QRS QRQ QSB QRM QRN QSY QRP QRL WX ANT PWR RIG ' +
    'GM GA GE GN OP NAME AGN PSE HW CPY CUL 73 88 599 579 5NN BTU SRI NR FER ABT').split(' ');
  var PREFIX = ['K', 'W', 'N', 'AA', 'KB', 'KC', 'VE', 'VA', 'G', 'M', 'F', 'DL', 'DJ', 'EA', 'I', 'IK', 'OH', 'SM', 'LA', 'OZ', 'PA', 'ON',
    'JA', 'JH', 'VK', 'ZL', 'PY', 'LU', 'CE', 'XE', 'HB', 'OE', 'SP', 'OK', 'YO', 'UA', 'ZS', 'VU', 'BV', 'HL', 'EI', 'GM'];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  // Small seeded PRNG (mulberry32).
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function codeOf(ch) { return CODE[String(ch).toUpperCase()] || ''; }
  function charOf(code) { return DECODE[code] || ''; }
  function encode(text) {
    return String(text).toUpperCase().split(/\s+/).filter(Boolean).map(function (w) {
      return w.split('').map(codeOf).filter(Boolean).join(' ');
    }).filter(Boolean).join(' / ');
  }
  function lessonSet(n) { return KOCH.slice(0, clamp(n | 0, MIN_LESSON, KOCH.length)); }

  // ---- timing: PARIS standard (50 dot units a word); Farnsworth stretches only the gaps ----
  // wpm: character speed; eff: effective (overall) speed ≤ wpm. Seconds.
  function timing(wpm, eff) {
    wpm = clamp(+wpm || 20, 5, 60);
    eff = clamp(+eff || wpm, 2, wpm);
    var dot = 1.2 / wpm, cg = 3 * dot, wg = 7 * dot;
    if (eff < wpm) {
      var ta = (60 * wpm - 37.2 * eff) / (eff * wpm);   // ARRL: total stretched delay per PARIS word
      cg = 3 * ta / 19; wg = 7 * ta / 19;
    }
    return { wpm: wpm, eff: eff, dot: dot, dash: 3 * dot, gap: dot, cg: cg, wg: wg };
  }
  // A text as tone segments: { tones: [{t, d}], marks: [{ch, t0, t1}], dur } (seconds).
  function schedule(text, tm) {
    var tones = [], marks = [], t = 0, words = String(text).toUpperCase().split(/\s+/).filter(Boolean);
    for (var w = 0; w < words.length; w++) {
      var chars = words[w].split('').filter(function (c) { return !!CODE[c]; });
      if (!chars.length) continue;
      if (marks.length) t += tm.wg;
      for (var i = 0; i < chars.length; i++) {
        if (i) t += tm.cg;
        var code = CODE[chars[i]], t0 = t;
        for (var j = 0; j < code.length; j++) {
          if (j) t += tm.gap;
          var d = code.charAt(j) === '.' ? tm.dot : tm.dash;
          tones.push({ t: t, d: d });
          t += d;
        }
        marks.push({ ch: chars[i], t0: t0, t1: t });
      }
    }
    return { tones: tones, marks: marks, dur: t };
  }
  function toneAt(sch, t) {
    var a = sch.tones;
    for (var i = 0; i < a.length; i++) { if (t < a[i].t) return false; if (t < a[i].t + a[i].d) return true; }
    return false;
  }

  // ---- straight key decoder ----
  // Times in ms. Element length is judged against separate running dot and dash
  // estimates (split at their geometric mean), so it follows the sender's fist.
  function newDecoder(wpm) {
    var dot = 1200 / clamp(wpm || 15, 4, 60);
    return { dot: dot, dash: dot * 3, isDown: false, downAt: 0, upAt: 0, sym: '', els: [] };
  }
  function decDown(d, t) {
    if (d.isDown) return;
    // a gap inside a character is one dot long: another sample of the sender's speed
    if (d.sym) { var g = t - d.upAt; if (g > 0 && g < decGap(d)) d.dot = clamp(d.dot * 0.85 + g * 0.15, 25, 600); fitRatio(d, '.'); }
    d.isDown = true; d.downAt = t;
  }
  // keep dash / dot between 2 and 4, moving the estimate that was not just measured
  function fitRatio(d, keep) {
    if (d.dash < d.dot * 2) { if (keep === '.') d.dash = d.dot * 2; else d.dot = d.dash / 2; }
    else if (d.dash > d.dot * 4) { if (keep === '.') d.dash = d.dot * 4; else d.dot = d.dash / 4; }
  }
  function decUp(d, t) {
    if (!d.isDown) return '';
    d.isDown = false;
    var len = Math.max(1, t - d.downAt), split = Math.sqrt(d.dot * d.dash), el = len < split ? '.' : '-';
    if (el === '.') d.dot = clamp(d.dot * 0.7 + len * 0.3, 25, 600);
    else d.dash = clamp(d.dash * 0.7 + len * 0.3, 60, 1800);
    fitRatio(d, el);
    d.sym += el; d.upAt = t; d.els.push(len);
    if (d.sym.length > 7) d.sym = d.sym.slice(-7);
    return el;
  }
  // The character gap: past it, the symbol so far is a character.
  function decGap(d) { return Math.max(2.4 * d.dot, 0.8 * d.dash); }
  // → { code, ch } when a character has just completed, else null.
  function decTick(d, t) {
    if (d.isDown || !d.sym || t - d.upAt < decGap(d)) return null;
    var code = d.sym;
    d.sym = '';
    return { code: code, ch: charOf(code) };
  }
  function decWpm(d) { return Math.round(1200 / ((d.dot + d.dash / 3) / 2)); }

  // ---- iambic keyer (mode B style memory): paddles in, timed elements out ----
  function newKeyer(wpm) {
    return { dot: 1200 / clamp(wpm || 15, 4, 60), st: 'idle', until: 0, idle: 0, last: '', dit: false, dah: false, mDit: false, mDah: false, sq: false, cur: '', sym: '' };
  }
  function keyPaddle(k, which, on, t) {
    if (which === 'dit') { if (on && !k.dit && k.st === 'el' && k.cur === '-') k.mDit = true; k.dit = !!on; }
    else { if (on && !k.dah && k.st === 'el' && k.cur === '.') k.mDah = true; k.dah = !!on; }
    if (k.st === 'el' && k.dit && k.dah) k.sq = true;   // squeezed during this element (mode B adds one more)
  }
  // Advance to time t: → { els: [{el, t0, d}], done: {code, ch} | null }.
  function keyStep(k, t) {
    var out = { els: [], done: null }, guard = 0;
    while (guard++ < 64) {
      if (k.st === 'el') {
        if (t < k.until) break;
        k.st = 'gap'; k.until += k.dot;
        continue;
      }
      var start = k.st === 'gap' ? k.until : t;
      if (k.st === 'gap' && t < k.until) break;
      var nx = '';
      if (k.dit && k.dah) nx = k.last === '.' ? '-' : '.';
      else if (k.mDit || k.mDah) nx = k.mDit && (!k.mDah || k.last === '-') ? '.' : '-';
      else if (k.dit) nx = '.';
      else if (k.dah) nx = '-';
      else if (k.sq) nx = k.last === '.' ? '-' : '.';
      k.sq = false;
      if (nx === '.') k.mDit = false; else if (nx === '-') k.mDah = false;
      if (!nx) { if (k.st === 'gap') { k.st = 'idle'; k.idle = k.until; } break; }
      var d = nx === '.' ? k.dot : 3 * k.dot;
      k.st = 'el'; k.cur = nx; k.last = nx; k.until = start + d; k.sq = k.dit && k.dah;
      k.sym += nx;
      out.els.push({ el: nx, t0: start, d: d });
    }
    if (k.st === 'idle' && k.sym && t - k.idle >= 2 * k.dot) {
      out.done = { code: k.sym, ch: charOf(k.sym) };
      k.sym = ''; k.last = '';
    }
    return out;
  }

  // ---- per-character stats; weak characters come up more ----
  function newStat() { return { n: 0, ok: 0, ema: 0.5 }; }
  function record(stats, ch, ok) {
    ch = String(ch).toUpperCase();
    if (!CODE[ch]) return null;
    var s = stats[ch] || (stats[ch] = newStat());
    s.n++; if (ok) s.ok++;
    s.ema = s.ema * 0.8 + (ok ? 0.2 : 0);
    return s;
  }
  function accOf(stats, ch) { var s = stats[ch]; return s && s.n ? s.ok / s.n : 0; }
  function skill(stats, ch) { var s = stats[ch]; return s ? s.ema : 0.5; }
  function weight(stats, ch) {
    var s = stats[ch];
    if (!s || s.n < 4) return 3;
    return 1 + 6 * (1 - s.ema) * (1 - s.ema) + (s.n < 10 ? 0.6 : 0);
  }
  function pick(pool, stats, r, avoid) {
    var tw = 0, i, w = [];
    for (i = 0; i < pool.length; i++) { w[i] = weight(stats, pool[i]) * (pool[i] === avoid && pool.length > 1 ? 0.25 : 1); tw += w[i]; }
    var x = r() * tw;
    for (i = 0; i < pool.length - 1 && x >= w[i]; i++) x -= w[i];
    return pool[i];
  }
  // A group of n characters; the lesson's newest character is guaranteed a place often.
  function makeGroup(pool, stats, n, r) {
    var g = '', prev = '';
    for (var i = 0; i < n; i++) { prev = pick(pool, stats, r, prev); g += prev; }
    return g;
  }
  function weakest(stats, pool, n) {
    return pool.filter(function (c) { return stats[c] && stats[c].n >= 5; })
      .sort(function (a, b) { return skill(stats, a) - skill(stats, b) || accOf(stats, a) - accOf(stats, b); })
      .filter(function (c) { return skill(stats, c) < 0.7; }).slice(0, n || 3);
  }
  // Compare a typed answer with what was sent, position by position.
  function grade(sent, typed) {
    sent = String(sent).toUpperCase(); typed = String(typed).toUpperCase();
    var res = [], ok = 0;
    for (var i = 0; i < sent.length; i++) {
      var good = typed.charAt(i) === sent.charAt(i);
      if (good) ok++;
      res.push({ ch: sent.charAt(i), got: typed.charAt(i), ok: good });
    }
    return { res: res, ok: ok, n: sent.length, acc: sent.length ? ok / sent.length : 0, exact: sent === typed };
  }
  function lessonPassed(ok, n) { return n >= 10 && ok / n >= PASS; }

  function callsign(r) {
    var p = PREFIX[Math.floor(r() * PREFIX.length)], s = p + Math.floor(r() * 10), n = 1 + Math.floor(r() * 3);
    if (p.length === 1 && n === 1) n = 2;
    for (var i = 0; i < n; i++) s += ALPHA[Math.floor(r() * 26)];
    if (r() < 0.08) s += '/P';
    return s;
  }
  // kind: 'words' | 'calls' | 'abbr' | 'mix'
  function drillItem(kind, r) {
    if (kind === 'mix') kind = r() < 0.4 ? 'words' : r() < 0.6 ? 'calls' : 'abbr';
    if (kind === 'calls') return callsign(r);
    var L = kind === 'abbr' ? ABBR : WORDS;
    return L[Math.floor(r() * L.length)];
  }

  // ---- arcade: codes fall; type them before they land ----
  var STEP = 1 / 120, LIVES = 3, COLS = 5;
  function arcadePool(base, lv) {
    var p = base && base.length >= 4 ? base.slice() : KOCH.slice(0, 4);
    var extra = Math.max(0, lv - 1);
    for (var i = 0; i < KOCH.length && extra > 0; i++) if (p.indexOf(KOCH[i]) < 0) { p.push(KOCH[i]); extra--; }
    return p;
  }
  function newArcade(seed, opts) {
    opts = opts || {};
    var a = {
      seed: seed >>> 0, r: rng(seed), base: (opts.pool || []).slice(), stats: opts.stats || {}, ears: !!opts.ears,
      phase: 'run', t: 0, acc: 0, lv: 1, score: 0, combo: 0, bestCombo: 0, lives: LIVES, hits: 0, misses: 0, wrong: 0,
      items: [], nextId: 1, spawnT: 1.0, events: [], steps: 0,
      dot: clamp(+opts.dot || 0, 0, 0.5)   // seconds per dot of the spawn beep (0: no audio pacing)
    };
    a.pool = arcadePool(a.base, 1);
    return a;
  }
  function arcFall(lv) { return Math.min(0.34, 0.09 + 0.012 * (lv - 1)); }        // screen heights per second
  function arcGap(lv) { return Math.max(0.7, 2.3 - 0.15 * (lv - 1)); }           // seconds between codes
  // How long a code takes to sound (seconds), with a character gap after it.
  function codeDur(code, dot) {
    var u = 0;
    for (var i = 0; i < code.length; i++) u += (code.charAt(i) === '.' ? 1 : 3) + (i ? 1 : 0);
    return (u + 3) * dot;
  }
  function arcMult(a) { return Math.min(5, 1 + Math.floor(a.combo / 5)) * (a.ears ? 2 : 1); }
  function arcSpawn(a) {
    var used = {}, i, it;
    for (i = 0; i < a.items.length; i++) if (a.items[i].y < 0.35) used[a.items[i].col] = 1;
    var free = [];
    for (i = 0; i < COLS; i++) if (!used[i]) free.push(i);
    if (!free.length) for (i = 0; i < COLS; i++) free.push(i);
    var ch = pick(a.pool, a.stats, a.r);
    it = { id: a.nextId++, ch: ch, code: CODE[ch], col: free[Math.floor(a.r() * free.length)], y: 0, py: 0, v: arcFall(a.lv) * (0.9 + a.r() * 0.2), age: 0 };
    a.items.push(it);
    a.events.push({ k: 'spawn', it: it });
    return it;
  }
  function arcStep(a) {
    if (a.phase !== 'run') return;
    a.t += STEP; a.steps++;
    a.spawnT -= STEP;
    if (a.spawnT <= 0) {
      var sp = arcSpawn(a);
      // the beeps never pile up: the next code waits until this one has sounded
      a.spawnT = Math.max(arcGap(a.lv) * (0.85 + a.r() * 0.3), codeDur(sp.code, a.dot));
    }
    for (var i = a.items.length - 1; i >= 0; i--) {
      var it = a.items[i];
      it.py = it.y; it.y += it.v * STEP; it.age += STEP;
      if (it.y >= 1) {
        a.items.splice(i, 1);
        a.lives--; a.combo = 0; a.misses++;
        record(a.stats, it.ch, false);
        a.events.push({ k: 'land', it: it });
        if (a.lives <= 0) { a.phase = 'done'; a.events.push({ k: 'over' }); return; }
      }
    }
  }
  // Fixed steps for dt seconds; → interpolation alpha.
  function arcAdvance(a, dt) {
    a.acc = Math.min(a.acc + dt, 0.25);
    while (a.acc >= STEP && a.phase === 'run') { arcStep(a); a.acc -= STEP; }
    return a.acc / STEP;
  }
  // A typed character: clears the lowest matching code. → the item hit, or null.
  function arcType(a, ch) {
    if (a.phase !== 'run') return null;
    ch = String(ch).toUpperCase();
    var best = -1;
    for (var i = 0; i < a.items.length; i++) if (a.items[i].ch === ch && (best < 0 || a.items[i].y > a.items[best].y)) best = i;
    if (best < 0) { a.combo = 0; a.wrong++; a.events.push({ k: 'wrong', ch: ch }); return null; }
    var it = a.items.splice(best, 1)[0];
    a.combo++; a.bestCombo = Math.max(a.bestCombo, a.combo); a.hits++;
    var pts = (10 + Math.round((1 - it.y) * 15)) * arcMult(a);
    a.score += pts;
    record(a.stats, it.ch, true);
    a.events.push({ k: 'hit', it: it, pts: pts });
    var lv = 1 + Math.floor(a.hits / 8);
    if (lv > a.lv) {
      var before = a.pool.length;
      a.lv = lv; a.pool = arcadePool(a.base, lv);
      a.events.push({ k: 'level', lv: lv, added: a.pool.length > before ? a.pool[a.pool.length - 1] : '' });
    }
    return it;
  }

  // ---- the save ----
  var DEF_SET = { wpm: 20, eff: 10, kwpm: 13, pitch: 600, vol: 0.6, keyer: 'straight', group: 3, len: 25, pool: 'lesson', drill: 'mix', ears: false, hint: true, lamp: true };
  function newSave() {
    return { v: 1, lesson: MIN_LESSON, maxLesson: MIN_LESSON, stats: {}, set: JSON.parse(JSON.stringify(DEF_SET)),
      rec: { arcade: 0, arcadeLv: 0, combo: 0, copyAcc: 0, sendWpm: 0, words: 0 }, tot: { chars: 0, sessions: 0, sent: 0 }, seen: [] };
  }
  function num(v, d, a, b) { v = +v; return isFinite(v) ? clamp(v, a, b) : d; }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    s.lesson = Math.round(num(o.lesson, MIN_LESSON, MIN_LESSON, KOCH.length));
    s.maxLesson = Math.round(num(o.maxLesson, s.lesson, s.lesson, KOCH.length));
    if (o.stats && typeof o.stats === 'object') {
      for (var c in o.stats) {
        if (!Object.prototype.hasOwnProperty.call(o.stats, c) || !CODE[c]) continue;
        var x = o.stats[c] || {}, n = Math.round(num(x.n, 0, 0, 1e7));
        if (!n) continue;
        s.stats[c] = { n: n, ok: Math.round(num(x.ok, 0, 0, n)), ema: num(x.ema, 0.5, 0, 1) };
      }
    }
    var st = o.set || {}, d = DEF_SET;
    s.set.wpm = Math.round(num(st.wpm, d.wpm, 5, 45));
    s.set.eff = Math.round(num(st.eff, Math.min(d.eff, s.set.wpm), 3, s.set.wpm));
    s.set.kwpm = Math.round(num(st.kwpm, d.kwpm, 5, 40));
    s.set.pitch = Math.round(num(st.pitch, d.pitch, 300, 1200));
    s.set.vol = num(st.vol, d.vol, 0.05, 1);
    s.set.keyer = st.keyer === 'iambic' ? 'iambic' : 'straight';
    s.set.group = Math.round(num(st.group, d.group, 1, 5));
    s.set.len = Math.round(num(st.len, d.len, 10, 60));
    s.set.pool = st.pool === 'all' ? 'all' : 'lesson';
    s.set.drill = ['words', 'calls', 'abbr', 'mix'].indexOf(st.drill) >= 0 ? st.drill : d.drill;
    s.set.ears = !!st.ears;
    s.set.hint = st.hint == null ? true : !!st.hint;
    s.set.lamp = st.lamp == null ? true : !!st.lamp;
    var r = o.rec || {};
    for (var k in s.rec) s.rec[k] = num(r[k], 0, 0, 1e9);
    var t = o.tot || {};
    for (k in s.tot) s.tot[k] = Math.round(num(t[k], 0, 0, 1e9));
    if (Array.isArray(o.seen)) s.seen = o.seen.filter(function (c, i, a) { return typeof c === 'string' && !!CODE[c] && a.indexOf(c) === i; });
    return s;
  }
  // Settle a copy session at the current lesson: → { passed, newChar }.
  function settleLesson(s, ok, n) {
    s.tot.sessions++;
    var acc = n ? ok / n : 0, out = { passed: false, newChar: '', acc: acc };
    if (n >= 10) s.rec.copyAcc = Math.max(s.rec.copyAcc, Math.round(acc * 100));
    if (lessonPassed(ok, n) && s.lesson < KOCH.length) {
      s.lesson++;
      s.maxLesson = Math.max(s.maxLesson, s.lesson);
      out.passed = true; out.newChar = KOCH[s.lesson - 1];
    } else if (lessonPassed(ok, n)) out.passed = true;
    return out;
  }
  function settleArcade(s, a) {
    var best = a.score > s.rec.arcade;
    s.rec.arcade = Math.max(s.rec.arcade, a.score);
    s.rec.arcadeLv = Math.max(s.rec.arcadeLv, a.lv);
    s.rec.combo = Math.max(s.rec.combo, a.bestCombo);
    s.tot.sessions++;
    return { best: best };
  }

  var ENGINE = {
    CODE: CODE, KOCH: KOCH, ALPHA: ALPHA, ALL: ALL, WORDS: WORDS, ABBR: ABBR, STEP: STEP, LIVES: LIVES, COLS: COLS, PASS: PASS, MIN_LESSON: MIN_LESSON, DEF_SET: DEF_SET,
    rng: rng, codeOf: codeOf, charOf: charOf, encode: encode, lessonSet: lessonSet, timing: timing, schedule: schedule, toneAt: toneAt,
    newDecoder: newDecoder, decDown: decDown, decUp: decUp, decTick: decTick, decGap: decGap, decWpm: decWpm,
    newKeyer: newKeyer, keyPaddle: keyPaddle, keyStep: keyStep,
    record: record, accOf: accOf, skill: skill, weight: weight, pick: pick, makeGroup: makeGroup, weakest: weakest, grade: grade, lessonPassed: lessonPassed,
    callsign: callsign, drillItem: drillItem,
    arcadePool: arcadePool, newArcade: newArcade, arcStep: arcStep, arcAdvance: arcAdvance, arcType: arcType, arcMult: arcMult, arcFall: arcFall, arcGap: arcGap, codeDur: codeDur,
    newSave: newSave, normSave: normSave, settleLesson: settleLesson, settleArcade: settleArcade
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('morse.css');
  var PANEL_ID = 'morse-panel', NAME = 'Morse Trainer';
  var KEY = 'cade-morse-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var DRILLS = [['mix', 'Mix'], ['words', 'Words'], ['calls', 'Callsigns'], ['abbr', 'Q & abbr']];
  var KB_ROWS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM', '.,?/=+'];
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.morse = { live: function () { return S; } };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function fmtInt(n) {
    n = Math.round(n);
    var s = String(Math.abs(n)), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function toast(m) { if (Cade.showToast) Cade.showToast(m, 'info', 1800); }

  // ---- sound: one output bus; Morse as gain-shaped oscillators scheduled on the audio clock ----
  function Au(on) { this.on = !!on; this.ac = null; this.out = null; this.sd = null; this.live = []; this.busy = 0; }
  Au.prototype.ensure = function () {
    if (!this.ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ac = new AC(); this.out = this.ac.createGain(); this.out.gain.value = 1; this.out.connect(this.ac.destination); } catch (e) { this.ac = null; return; }
    }
    if (this.ac.state === 'suspended') { try { this.ac.resume(); } catch (e) {} }
  };
  Au.prototype.ok = function () { return this.on && !!this.ac && this.ac.state !== 'closed'; };
  Au.prototype.now = function () { return this.ac ? this.ac.currentTime : 0; };
  // tones: [{t, d}] seconds, from audio time `at`
  Au.prototype.tones = function (tones, at, f, v) {
    if (!this.ok() || !tones.length) return;
    try {
      var ac = this.ac, o = ac.createOscillator(), g = ac.createGain(), R = 0.005, end = at, live = this.live;
      o.type = 'sine'; o.frequency.setValueAtTime(f, at);
      g.gain.setValueAtTime(0, at);
      for (var i = 0; i < tones.length; i++) {
        var t0 = at + tones[i].t, t1 = t0 + tones[i].d;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(v, t0 + R);
        g.gain.setValueAtTime(v, Math.max(t0 + R, t1 - R));
        g.gain.linearRampToValueAtTime(0, t1);
        end = t1;
      }
      o.connect(g); g.connect(this.out);
      o.start(at); o.stop(end + 0.05);
      live.push(o);
      o.onended = function () { var j = live.indexOf(o); if (j >= 0) live.splice(j, 1); try { o.disconnect(); g.disconnect(); } catch (e) {} };
      this.busy = Math.max(this.busy, end);
    } catch (e) {}
  };
  Au.prototype.hush = function () {
    var l = this.live.slice();
    this.live.length = 0; this.busy = 0;
    l.forEach(function (o) { try { o.stop(); } catch (e) {} });
  };
  // the sidetone for a straight key: a running oscillator, gated
  Au.prototype.key = function (down, f, v) {
    if (!this.ok()) return;
    try {
      var ac = this.ac, t = ac.currentTime;
      if (!this.sd) {
        if (!down) return;
        var o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine'; g.gain.value = 0; o.connect(g); g.connect(this.out); o.start();
        this.sd = { o: o, g: g };
      }
      this.sd.o.frequency.setValueAtTime(f, t);
      var gg = this.sd.g.gain;
      gg.cancelScheduledValues(t); gg.setValueAtTime(gg.value, t); gg.linearRampToValueAtTime(down ? v : 0, t + 0.005);
    } catch (e) {}
  };
  Au.prototype.keyOff = function () {
    if (!this.sd) return;
    try { this.sd.o.stop(); this.sd.o.disconnect(); this.sd.g.disconnect(); } catch (e) {}
    this.sd = null;
  };
  Au.prototype.blip = function (f, dur, type, vol, slide, delay) {
    if (!this.ok()) return;
    try {
      var ac = this.ac, t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.out);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Au.prototype.close = function () { this.hush(); this.keyOff(); if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };
  function vol() { return S.save.set.vol * 0.32; }
  function sfx(kind) {
    var a = S.au, v = 0.035 * S.save.set.vol + 0.01;
    if (kind === 'good') { a.blip(1046, 0.06, 'triangle', v); a.blip(1568, 0.08, 'triangle', v, 0, 0.05); }
    else if (kind === 'bad') a.blip(220, 0.18, 'square', v * 0.6, 150);
    else if (kind === 'land') { a.blip(160, 0.3, 'sawtooth', v * 0.7, 60); }
    else if (kind === 'level') [523, 659, 784, 1046].forEach(function (f, i) { a.blip(f, 0.1, 'triangle', v, 0, i * 0.07); });
    else if (kind === 'win') [659, 784, 988, 1319].forEach(function (f, i) { a.blip(f, 0.13, 'triangle', v, 0, i * 0.09); });
    else if (kind === 'tick') a.blip(1400, 0.03, 'sine', v * 0.5);
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

  // ---- small HTML helpers ----
  function codeHtml(code, cls) {
    var h = '<span class="mo-code' + (cls ? ' ' + cls : '') + '" aria-label="' + (code || '').replace(/\./g, 'dit ').replace(/-/g, 'dah ').trim() + '">';
    for (var i = 0; i < code.length; i++) h += '<i class="' + (code.charAt(i) === '.' ? 'dit' : 'dah') + '"></i>';
    return h + '</span>';
  }
  function skillCls(c) {
    var st = S.save.stats[c];
    if (!st || st.n < 5) return 'k0';
    var k = st.ema;
    return k >= 0.85 ? 'k4' : k >= 0.7 ? 'k3' : k >= 0.5 ? 'k2' : 'k1';
  }
  function opt(name, val, cur, label) {
    return '<button type="button" class="mo-opt' + (String(val) === String(cur) ? ' on' : '') + '" data-opt="' + name + '" data-v="' + esc(val) + '" aria-pressed="' + (String(val) === String(cur)) + '">' + esc(label) + '</button>';
  }
  function kbHtml(keys, extra) {
    var h = '<div class="mo-kb" role="group" aria-label="Keyboard">';
    if (keys === 'full') {
      KB_ROWS.forEach(function (r, ri) {
        h += '<div class="mo-kr">' + r.split('').map(function (c) { return '<button type="button" class="mo-key" data-key="' + esc(c) + '">' + esc(c) + '</button>'; }).join('');
        if (ri === 3) h += '<button type="button" class="mo-key wide" data-key="BS" aria-label="Backspace">&#9003;</button>';
        if (ri === 4) h += '<button type="button" class="mo-key wide go" data-key="ENTER" aria-label="Enter">enter</button>';
        h += '</div>';
      });
    } else {
      h += '<div class="mo-kr wrap">' + keys.map(function (c) { return '<button type="button" class="mo-key ' + skillCls(c) + '" data-key="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>';
    }
    return h + (extra || '') + '</div>';
  }
  function speedLine() {
    var st = S.save.set;
    return st.wpm + ' wpm' + (st.eff < st.wpm ? ' (eff ' + st.eff + ')' : '') + ' · ' + st.pitch + ' Hz';
  }
  function practicePool() { return S.save.set.pool === 'all' ? ALL.slice() : lessonSet(S.save.lesson); }

  // ---- screens ----
  function render(html, screen) {
    clearLater();
    S.screen = screen;
    S.scr.innerHTML = html;
    S.scr.setAttribute('data-screen', screen);
    S.lampEl = S.scr.querySelector('.mo-lamp');
    S.lampOn = false;
    S.scr.scrollTop = 0;
    syncHead();
  }
  function later(fn, ms) {
    var id = setTimeout(function () { var i = S ? S.tm.indexOf(id) : -1; if (i >= 0) S.tm.splice(i, 1); if (S) fn(); }, ms);
    S.tm.push(id);
  }
  function clearLater() { if (!S) return; S.tm.forEach(clearTimeout); S.tm.length = 0; }

  function homeHtml() {
    var sv = S.save, L = sv.lesson, chips = '';
    KOCH.forEach(function (c, i) {
      var cls = i < L ? skillCls(c) + (i === L - 1 ? ' new' : '') : 'lock';
      chips += '<button type="button" class="mo-lc ' + cls + '" data-act="hear" data-ch="' + esc(c) + '" title="' + esc(c + '  ' + CODE[c]) + '">' + esc(c) + '</button>';
    });
    var weak = weakest(sv.stats, lessonSet(L), 3);
    function mode(act, t, d, b) {
      return '<button type="button" class="mo-mode" data-act="' + act + '"><b>' + t + '</b><span>' + d + '</span>' + (b ? '<em>' + b + '</em>' : '') + '</button>';
    }
    return '<div class="mo-card mo-home">' +
      '<div class="mo-title">MORSE TRAINER</div>' +
      '<div class="mo-art" aria-hidden="true">' + codeHtml('--') + ' ' + codeHtml('---') + ' ' + codeHtml('.-.') + ' ' + codeHtml('...') + ' ' + codeHtml('.') + '</div>' +
      '<div class="mo-sec"><div class="mo-lrow"><span class="mo-h">Koch lesson</span>' +
      '<button type="button" class="mo-step" data-act="les-" aria-label="Previous lesson"' + (L <= MIN_LESSON ? ' disabled' : '') + '>&lsaquo;</button>' +
      '<b class="mo-lnum">' + (L - 1) + '</b><span class="mo-lof">/ ' + (KOCH.length - 1) + '</span>' +
      '<button type="button" class="mo-step" data-act="les+" aria-label="Next lesson"' + (L >= KOCH.length ? ' disabled' : '') + '>&rsaquo;</button>' +
      '<span class="mo-lhint">' + L + ' characters</span></div>' +
      '<div class="mo-lset">' + chips + '</div>' +
      '<div class="mo-note">' + (weak.length ? 'Weak: <b>' + weak.map(esc).join(' ') + '</b> — drilled more often' : 'Tap a character to hear it · reach 90% in Copy to unlock the next') + '</div></div>' +
      '<div class="mo-modes">' +
      mode('go-copy', 'Copy', 'listen &amp; type', 'lesson ' + (L - 1)) +
      mode('go-send', 'Send', 'see it, key it', sv.set.keyer === 'iambic' ? 'paddles' : 'straight key') +
      mode('go-words', 'Words', 'words &amp; callsigns', sv.rec.words ? 'best ' + sv.rec.words + '/10' : '') +
      mode('go-arcade', 'Arcade', 'catch falling codes', sv.rec.arcade ? 'best ' + fmtInt(sv.rec.arcade) : '') +
      '</div>' +
      '<div class="mo-foot"><span>' + esc(speedLine()) + '</span><span>' +
      '<button type="button" class="mo-lnk" data-act="stats">Stats</button>' +
      '<button type="button" class="mo-lnk" data-act="settings">Settings</button>' +
      '<button type="button" class="mo-lnk" data-act="help">Help</button></span></div></div>';
  }
  function toHome() {
    stopPlay();
    render(homeHtml(), 'home');
  }

  function helpHtml() {
    var c = S.coarse;
    return '<div class="mo-card mo-help"><div class="mo-title">HOW IT WORKS</div>' +
      '<p><b>Koch method.</b> You learn by sound at full character speed from day one, starting with just two characters. ' +
      'Copy a session at <b>90%</b> or better and the next character joins the set. Don’t count dots — let each rhythm become a sound you recognise.</p>' +
      '<p><b>Farnsworth spacing.</b> Characters are sent at the full speed (e.g. 20 wpm) but the gaps between them are stretched to an easier effective speed. Close the gap as you improve.</p>' +
      '<div class="mo-keys">' +
      '<span><b>Copy</b> — listen, type each character as you hear it. ' + (c ? 'Tap the keys.' : 'Type on your keyboard; <b>Enter</b> replays, <b>Space</b> skips.') + '</span>' +
      '<span><b>Send</b> — see a letter, key it. Straight key: ' + (c ? 'hold the big key' : 'hold <b>Space</b>') + ' (short = dit, long = dah; the decoder learns your speed). ' +
      'Paddles: ' + (c ? 'the DIT and DAH buttons' : '<b>Z</b> / <b>←</b> dit, <b>X</b> / <b>→</b> dah') + ', squeeze both to alternate.</span>' +
      '<span><b>Words</b> — common words, operator shorthand and made-up callsigns. Type the whole thing' + (c ? '.' : ', <b>Enter</b> to check (or replay when empty).') + '</span>' +
      '<span><b>Arcade</b> — codes fall and beep as they appear; type the character before it lands. Tap a code to hear it again. Ears-only mode hides the codes for double points.</span>' +
      '</div>' +
      '<p>Every answer updates per-character accuracy; your weakest characters come up more often everywhere. ' + (c ? '' : '<b>Esc</b> goes back.') + '</p>' +
      '<div class="mo-btns"><button type="button" class="mo-go" data-act="home">Got it</button></div></div>';
  }

  // ---- copy: listen & type ----
  function startCopy() {
    var sv = S.save, set = sv.set;
    if (set.pool === 'lesson') {
      var fresh = lessonSet(sv.lesson).filter(function (c) { return sv.seen.indexOf(c) < 0; });
      if (fresh.length) { introCard(fresh.slice(-3)); return; }
    }
    S.cp = { pool: practicePool(), len: set.len, group: set.group, g: '', pos: 0, n: 0, ok: 0, miss: {}, replays: 0, r: rng((Math.random() * 4294967295) >>> 0), wait: false };
    render(copyHtml(), 'copy');
    later(nextGroup, 450);
  }
  function introCard(chars) {
    S.intro = chars;
    var h = '<div class="mo-card mo-intro"><div class="mo-title">NEW ' + (chars.length > 1 ? 'CHARACTERS' : 'CHARACTER') + '</div>';
    chars.forEach(function (c) {
      h += '<button type="button" class="mo-big" data-act="hear3" data-ch="' + esc(c) + '"><b>' + esc(c) + '</b>' + codeHtml(CODE[c], 'lg') + '</button>';
    });
    h += '<div class="mo-lamp-row"><span class="mo-lamp"></span></div>' +
      '<p>Listen until the rhythm sticks — tap a character to hear it again. Then copy a session with the lesson set.</p>' +
      '<div class="mo-btns"><button type="button" class="mo-go" data-act="intro-go">Start copying</button><button type="button" class="mo-go alt" data-act="home">Menu</button></div></div>';
    render(h, 'intro');
    var txt = chars.map(function (c) { return c + ' ' + c + ' ' + c; }).join(' ');
    later(function () { play(txt); }, 350);
  }
  function copyHtml() {
    var cp = S.cp, sv = S.save, label = sv.set.pool === 'lesson' ? 'Lesson ' + (sv.lesson - 1) : 'All characters';
    return '<div class="mo-play">' +
      '<div class="mo-bar"><span>' + esc(label) + ' · ' + esc(speedLine()) + '</span><span class="mo-cnt"></span></div>' +
      '<div class="mo-prog"><i></i></div>' +
      '<div class="mo-stage-row"><span class="mo-lamp"></span><div class="mo-slots" aria-live="polite"></div></div>' +
      '<div class="mo-msg">Listen…</div>' +
      kbHtml(cp.pool) +
      '<div class="mo-ctl"><button type="button" class="mo-go alt" data-act="replay">Replay' + (S.coarse ? '' : ' <small>enter</small>') + '</button>' +
      '<button type="button" class="mo-go alt" data-act="skip">Skip' + (S.coarse ? '' : ' <small>space</small>') + '</button>' +
      '<button type="button" class="mo-go alt" data-act="home">End</button></div></div>';
  }
  function copySync() {
    var cp = S.cp, el = S.scr;
    var cnt = el.querySelector('.mo-cnt'), pr = el.querySelector('.mo-prog i'), sl = el.querySelector('.mo-slots');
    if (cnt) cnt.textContent = cp.n + ' / ' + cp.len + (cp.n ? ' · ' + pct(cp.ok / cp.n) : '');
    if (pr) pr.style.width = (100 * cp.n / cp.len) + '%';
    if (sl) {
      var h = '';
      for (var i = 0; i < cp.g.length; i++) {
        var r = cp.res && cp.res[i];
        if (!r) h += '<span class="mo-slot' + (i === cp.pos ? ' cur' : '') + '">_</span>';
        else h += '<span class="mo-slot ' + (r.ok ? 'ok' : 'bad') + '">' + esc(r.got || '·') + (r.ok ? '' : '<small>' + esc(r.ch) + '</small>') + '</span>';
      }
      sl.innerHTML = h;
    }
  }
  function msg(t, cls) {
    var m = S.scr.querySelector('.mo-msg');
    if (!m) return;
    m.className = 'mo-msg' + (cls ? ' ' + cls : '');
    m.innerHTML = t;
  }
  function nextGroup() {
    var cp = S.cp;
    if (!cp) return;
    if (cp.n >= cp.len) { finishCopy(); return; }
    cp.g = makeGroup(cp.pool, S.save.stats, Math.min(cp.group, cp.len - cp.n), cp.r);
    cp.pos = 0; cp.res = []; cp.wait = false;
    copySync();
    msg('Listen &amp; type…');
    play(cp.g, function () { if (S.cp === cp && cp.pos < cp.g.length) msg('Type what you heard'); });
  }
  function copyChar(ch) {
    var cp = S.cp;
    if (!cp || cp.wait || !cp.g || cp.pos >= cp.g.length) return;
    var exp = cp.g.charAt(cp.pos), ok = ch === exp;
    record(S.save.stats, exp, ok);
    S.save.tot.chars++;
    cp.res[cp.pos] = { ch: exp, got: ch, ok: ok };
    cp.pos++; cp.n++;
    if (ok) cp.ok++;
    else {
      cp.miss[exp] = (cp.miss[exp] || 0) + 1;
      msg('<b>' + esc(exp) + '</b> ' + codeHtml(CODE[exp]) + (ch ? ' — you typed <b>' + esc(ch) + '</b> ' + codeHtml(CODE[ch] || '') : ' — skipped'), 'bad');
      sfx('bad');
      if (S.save.set.group === 1 || cp.pos >= cp.g.length) cp.slow = true;
    }
    flashKey(ch, ok);
    copySync();
    if (cp.pos >= cp.g.length) {
      cp.wait = true;
      if (ok && !cp.slow) msg(cp.res.every(function (r) { return r.ok; }) ? 'Good copy' : 'Next group…', ok ? 'ok' : '');
      var delay = cp.slow ? 1300 : 550;
      cp.slow = false;
      var go = function () { later(nextGroup, delay); };
      if (S.pl) S.pl.done = go; else go();
    }
  }
  function replay() {
    if (S.screen === 'copy' && S.cp && S.cp.g) {
      var cp = S.cp;
      if (cp.wait && !S.pl && !S.tm.length) { nextGroup(); return; }
      if (cp.pos >= cp.g.length) return;
      cp.replays++;
      msg('Again…');
      play(cp.g, function () { if (S.cp === cp && cp.pos < cp.g.length) msg('Type what you heard'); });
    } else if (S.screen === 'words' && S.wd) {
      var wd = S.wd;
      if (wd.shown) { if (!S.tm.length) nextWord(); return; }
      wd.replays++;
      play(wd.item);
    } else if (S.screen === 'intro' && S.intro) play(S.intro.map(function (c) { return c + ' ' + c + ' ' + c; }).join(' '));
  }
  function finishCopy() {
    var cp = S.cp, sv = S.save;
    stopPlay();
    var out = sv.set.pool === 'lesson' ? settleLesson(sv, cp.ok, cp.n) : { passed: cp.n >= 10 && cp.ok / cp.n >= 0.9, newChar: '', acc: cp.n ? cp.ok / cp.n : 0 };
    if (sv.set.pool !== 'lesson') { sv.tot.sessions++; if (cp.n >= 10) sv.rec.copyAcc = Math.max(sv.rec.copyAcc, Math.round(out.acc * 100)); }
    persist();
    S.cp = null;
    var miss = Object.keys(cp.miss).sort(function (a, b) { return cp.miss[b] - cp.miss[a]; });
    var h = '<div class="mo-card mo-res"><div class="mo-title">' + (out.passed ? 'LESSON PASSED' : 'SESSION DONE') + '</div>' +
      '<div class="mo-bigv">' + pct(out.acc) + '</div>' +
      '<div class="mo-sub">' + cp.ok + ' / ' + cp.n + ' correct · ' + esc(speedLine()) + (cp.replays ? ' · ' + cp.replays + ' replay' + (cp.replays > 1 ? 's' : '') : '') + '</div>';
    if (out.newChar) h += '<div class="mo-new">New character unlocked: <b>' + esc(out.newChar) + '</b> ' + codeHtml(CODE[out.newChar]) + '</div>';
    else if (out.passed && sv.set.pool === 'lesson' && sv.lesson >= KOCH.length) h += '<div class="mo-new">You know every character. Raise the effective speed!</div>';
    else if (!out.passed && sv.set.pool === 'lesson') h += '<div class="mo-note">Reach <b>90%</b> to unlock the next character.</div>';
    if (miss.length) {
      h += '<div class="mo-sec"><div class="mo-h">Missed</div><div class="mo-miss">' + miss.slice(0, 8).map(function (c) {
        return '<button type="button" class="mo-mi" data-act="hear" data-ch="' + esc(c) + '"><b>' + esc(c) + '</b>' + codeHtml(CODE[c]) + '<i>×' + cp.miss[c] + '</i></button>';
      }).join('') + '</div></div>';
    }
    h += '<div class="mo-btns"><button type="button" class="mo-go" data-act="go-copy">' + (out.newChar ? 'Next lesson' : 'Again') + '</button><button type="button" class="mo-go alt" data-act="home">Menu</button></div></div>';
    render(h, 'result');
    sfx(out.passed ? 'win' : 'tick');
  }

  // ---- send: see a letter, key it ----
  function startSend() {
    var set = S.save.set;
    S.sd = {
      iambic: set.keyer === 'iambic', pool: practicePool(), len: Math.min(set.len, 30), n: 0, ok: 0, target: '', wait: false, strip: '',
      dec: newDecoder(set.kwpm), kr: newKeyer(set.kwpm), r: rng((Math.random() * 4294967295) >>> 0), src: {}, dit: {}, dah: {}, lastEl: null, miss: {}, wpms: []
    };
    render(sendHtml(), 'send');
    nextTarget();
    kick();
  }
  function sendHtml() {
    var sd = S.sd, c = S.coarse;
    var pad = sd.iambic ?
      '<div class="mo-pad"><button type="button" class="mo-hold" data-k="dit">DIT<span>' + (c ? '·' : 'Z / ←') + '</span></button><button type="button" class="mo-hold" data-k="dah">DAH<span>' + (c ? '—' : 'X / →') + '</span></button></div>' :
      '<div class="mo-pad"><button type="button" class="mo-hold" data-k="key">KEY<span>' + (c ? 'hold' : 'hold space') + '</span></button></div>';
    return '<div class="mo-play">' +
      '<div class="mo-bar"><span>Send · ' + (sd.iambic ? 'iambic paddles' : 'straight key') + ' · ' + S.save.set.kwpm + ' wpm</span><span class="mo-cnt"></span></div>' +
      '<div class="mo-prog"><i></i></div>' +
      '<div class="mo-target"><b class="mo-tch"></b><div class="mo-thint"></div></div>' +
      '<div class="mo-stage-row"><span class="mo-lamp"></span><div class="mo-strip"></div></div>' +
      '<div class="mo-msg">Key the character</div>' + pad +
      '<div class="mo-ctl"><button type="button" class="mo-go alt' + (S.save.set.hint ? ' on' : '') + '" data-act="hint">Hint</button>' +
      '<button type="button" class="mo-go alt" data-act="sskip">Skip</button><button type="button" class="mo-go alt" data-act="home">End</button></div></div>';
  }
  function sendSync() {
    var sd = S.sd, el = S.scr;
    var cnt = el.querySelector('.mo-cnt'), pr = el.querySelector('.mo-prog i');
    if (cnt) cnt.textContent = sd.n + ' / ' + sd.len + (sd.n ? ' · ' + pct(sd.ok / sd.n) : '');
    if (pr) pr.style.width = (100 * sd.n / sd.len) + '%';
    var tc = el.querySelector('.mo-tch'), th = el.querySelector('.mo-thint');
    if (tc) tc.textContent = sd.target;
    if (th) th.innerHTML = S.save.set.hint ? codeHtml(CODE[sd.target] || '') : '<span class="mo-faint">hint off</span>';
    stripSync();
  }
  function stripSync() {
    var st = S.scr.querySelector('.mo-strip');
    if (st) st.innerHTML = S.sd.strip ? codeHtml(S.sd.strip, 'lg') : '<span class="mo-faint">' + (S.sd.wait ? '' : '…') + '</span>';
  }
  function nextTarget() {
    var sd = S.sd;
    if (!sd) return;
    if (sd.n >= sd.len) { finishSend(); return; }
    sd.target = pick(sd.pool, S.save.stats, sd.r, sd.target);
    sd.strip = ''; sd.wait = false;
    sd.dec.sym = ''; sd.kr.sym = '';
    sendSync();
    msg('Key the character');
  }
  function onSent(res) {
    var sd = S.sd;
    if (!sd || sd.wait || !sd.target) return;
    var want = CODE[sd.target], ok = res.code === want;
    record(S.save.stats, sd.target, ok);
    S.save.tot.sent++;
    sd.n++; if (ok) sd.ok++; else sd.miss[sd.target] = (sd.miss[sd.target] || 0) + 1;
    sd.wait = true;
    var w = sd.iambic ? 0 : decWpm(sd.dec);
    if (!sd.iambic && ok) sd.wpms.push(w);
    if (ok) {
      msg('<b>' + esc(sd.target) + '</b> — clean' + (w ? ' · your fist ≈ ' + w + ' wpm' : ''), 'ok');
      sfx('good');
    } else {
      msg('You sent ' + codeHtml(res.code) + (res.ch ? ' (<b>' + esc(res.ch) + '</b>)' : ' (not a character)') + ' — <b>' + esc(sd.target) + '</b> is ' + codeHtml(want), 'bad');
      sfx('bad');
    }
    sendSync();
    later(nextTarget, ok ? 650 : 1700);
  }
  // key / paddle state from every source (keys, pointers, gamepad)
  function anyOn(o) { for (var k in o) if (o[k]) return true; return false; }
  function setKey(which, src, on) {
    var sd = S.sd;
    if (!sd) return;
    var now = performance.now();
    if (!sd.iambic) {
      if (which !== 'key') return;
      var was = anyOn(sd.src);
      if (on) sd.src[src] = 1; else delete sd.src[src];
      var is = anyOn(sd.src);
      if (was === is) return;
      if (sd.wait) { syncKeyBtns(); return; }
      if (is) { decDown(sd.dec, now); S.au.key(true, S.save.set.pitch, vol()); lamp(true); }
      else {
        var el = decUp(sd.dec, now);
        S.au.key(false, S.save.set.pitch, vol()); lamp(false);
        if (el) { sd.strip = sd.dec.sym; stripSync(); }
      }
      syncKeyBtns();
      return;
    }
    if (which !== 'dit' && which !== 'dah') return;
    var set = which === 'dit' ? sd.dit : sd.dah, w0 = anyOn(set);
    if (on) set[src] = 1; else delete set[src];
    var w1 = anyOn(set);
    if (w0 !== w1 && !sd.wait) keyPaddle(sd.kr, which, w1, now);
    else if (sd.wait && !w1) keyPaddle(sd.kr, which, false, now);
    syncKeyBtns();
    sendTick(now);
    kick();
  }
  function syncKeyBtns() {
    var sd = S.sd;
    S.scr.querySelectorAll('.mo-hold').forEach(function (b) {
      var k = b.getAttribute('data-k');
      b.classList.toggle('on', k === 'key' ? anyOn(sd.src) : k === 'dit' ? anyOn(sd.dit) : anyOn(sd.dah));
    });
  }
  var KEY_LAT = 0.02;   // paddle elements sound this long after their ideal start: covers frame lateness, keeps spacing even
  function sendTick(now) {
    var sd = S.sd;
    if (!sd) return;
    pollPad();
    if (!sd.iambic) {
      var r = decTick(sd.dec, now);
      if (r) onSent(r);
      return;
    }
    if (sd.wait) { sd.kr.dit = false; sd.kr.dah = false; sd.kr.mDit = sd.kr.mDah = sd.kr.sq = false; }
    var o = keyStep(sd.kr, now);
    for (var i = 0; i < o.els.length; i++) {
      var e = o.els[i];
      S.au.tones([{ t: 0, d: e.d / 1000 }], S.au.now() + Math.max(0.002, (e.t0 - now) / 1000 + KEY_LAT), S.save.set.pitch, vol());
      sd.lastEl = e;
      if (!sd.wait) { sd.strip = sd.kr.sym; stripSync(); }
    }
    var le = sd.lastEl;
    lamp(!!le && now >= le.t0 + KEY_LAT * 1000 && now < le.t0 + KEY_LAT * 1000 + le.d);
    if (o.done) { if (!sd.wait) onSent(o.done); }
  }
  function finishSend() {
    var sd = S.sd, sv = S.save;
    var avg = sd.wpms.length ? Math.round(sd.wpms.reduce(function (a, b) { return a + b; }, 0) / sd.wpms.length) : 0;
    if (avg && sd.ok / Math.max(1, sd.n) >= 0.8) sv.rec.sendWpm = Math.max(sv.rec.sendWpm, avg);
    sv.tot.sessions++;
    persist();
    S.au.keyOff();
    S.sd = null;
    var miss = Object.keys(sd.miss);
    var h = '<div class="mo-card mo-res"><div class="mo-title">SENDING DONE</div>' +
      '<div class="mo-bigv">' + pct(sd.n ? sd.ok / sd.n : 0) + '</div>' +
      '<div class="mo-sub">' + sd.ok + ' / ' + sd.n + ' sent clean' + (avg ? ' · your fist ≈ ' + avg + ' wpm' : '') + '</div>';
    if (miss.length) h += '<div class="mo-sec"><div class="mo-h">Practise</div><div class="mo-miss">' + miss.slice(0, 8).map(function (c) {
      return '<button type="button" class="mo-mi" data-act="hear" data-ch="' + esc(c) + '"><b>' + esc(c) + '</b>' + codeHtml(CODE[c]) + '</button>';
    }).join('') + '</div></div>';
    h += '<div class="mo-btns"><button type="button" class="mo-go" data-act="go-send">Again</button><button type="button" class="mo-go alt" data-act="home">Menu</button></div></div>';
    render(h, 'result');
    sfx('win');
  }

  // ---- words / callsigns ----
  function wordsStartHtml() {
    var set = S.save.set;
    return '<div class="mo-card"><div class="mo-title">WORD DRILL</div>' +
      '<p>Ten items at ' + esc(speedLine()) + '. Hear the whole thing, then type it.</p>' +
      '<div class="mo-opts">' + DRILLS.map(function (d) { return opt('drill', d[0], set.drill, d[1]); }).join('') + '</div>' +
      '<div class="mo-note">' + (S.save.rec.words ? 'Best: <b>' + S.save.rec.words + ' / 10</b>' : 'Callsigns are made up — a prefix, a digit and a suffix') + '</div>' +
      '<div class="mo-btns"><button type="button" class="mo-go" data-act="words-go">Start</button><button type="button" class="mo-go alt" data-act="home">Menu</button></div></div>';
  }
  function startWords() {
    S.wd = { kind: S.save.set.drill, n: 0, len: 10, ok: 0, item: '', typed: '', shown: false, replays: 0, r: rng((Math.random() * 4294967295) >>> 0), wrong: [] };
    render(wordsHtml(), 'words');
    later(nextWord, 400);
  }
  function wordsHtml() {
    var lab = DRILLS.filter(function (d) { return d[0] === S.wd.kind; })[0][1];
    return '<div class="mo-play">' +
      '<div class="mo-bar"><span>' + esc(lab) + ' · ' + esc(speedLine()) + '</span><span class="mo-cnt"></span></div>' +
      '<div class="mo-prog"><i></i></div>' +
      '<div class="mo-stage-row"><span class="mo-lamp"></span><div class="mo-slots wide" aria-live="polite"></div></div>' +
      '<div class="mo-msg">Listen…</div>' + kbHtml('full') +
      '<div class="mo-ctl"><button type="button" class="mo-go alt" data-act="replay">Replay</button><button type="button" class="mo-go alt" data-act="wcheck">Check' + (S.coarse ? '' : ' <small>enter</small>') + '</button>' +
      '<button type="button" class="mo-go alt" data-act="home">End</button></div></div>';
  }
  function wordsSync() {
    var wd = S.wd, el = S.scr, cnt = el.querySelector('.mo-cnt'), pr = el.querySelector('.mo-prog i'), sl = el.querySelector('.mo-slots');
    if (cnt) cnt.textContent = wd.n + ' / ' + wd.len + (wd.n ? ' · ' + wd.ok + ' right' : '');
    if (pr) pr.style.width = (100 * wd.n / wd.len) + '%';
    if (!sl) return;
    var h = '', L = Math.max(wd.item.length, wd.typed.length + (wd.shown ? 0 : 1));
    for (var i = 0; i < L; i++) {
      var t = wd.typed.charAt(i), e = wd.item.charAt(i);
      if (wd.shown) h += '<span class="mo-slot ' + (t === e ? 'ok' : 'bad') + '">' + esc(t || '·') + (t === e ? '' : '<small>' + esc(e || '') + '</small>') + '</span>';
      else h += '<span class="mo-slot' + (i === wd.typed.length ? ' cur' : '') + (t ? ' t' : '') + (i >= wd.item.length ? ' x' : '') + '">' + esc(t || '_') + '</span>';
    }
    sl.innerHTML = h;
  }
  function nextWord() {
    var wd = S.wd;
    if (!wd) return;
    if (wd.n >= wd.len) { finishWords(); return; }
    var it = drillItem(wd.kind, wd.r), guard = 0;
    while (it === wd.item && guard++ < 5) it = drillItem(wd.kind, wd.r);
    wd.item = it; wd.typed = ''; wd.shown = false;
    wordsSync();
    msg('Listen…');
    play(it, function () { if (S.wd === wd && !wd.shown) msg('Type it' + (S.coarse ? '' : ' — Enter checks')); });
  }
  function wordsChar(ch) {
    var wd = S.wd;
    if (!wd || wd.shown || !wd.item) return;
    if (ch === 'BS') { wd.typed = wd.typed.slice(0, -1); wordsSync(); return; }
    if (ch === 'ENTER') { if (wd.typed) checkWord(); else replay(); return; }
    if (wd.typed.length >= wd.item.length + 4) return;
    wd.typed += ch;
    flashKey(ch, true);
    wordsSync();
    if (wd.typed.length === wd.item.length && wd.typed === wd.item) checkWord();
  }
  function checkWord() {
    var wd = S.wd;
    if (!wd || wd.shown || !wd.item) return;
    var g = grade(wd.item, wd.typed);
    g.res.forEach(function (r) { record(S.save.stats, r.ch, r.ok); });
    S.save.tot.chars += g.n;
    wd.shown = true; wd.n++;
    if (g.exact) { wd.ok++; msg('<b>' + esc(wd.item) + '</b> — copied', 'ok'); sfx('good'); }
    else { wd.wrong.push(wd.item); msg('It was <b>' + esc(wd.item) + '</b> &nbsp;' + esc(encode(wd.item)), 'bad'); sfx('bad'); }
    stopPlay();
    wordsSync();
    later(nextWord, g.exact ? 900 : 2200);
  }
  function finishWords() {
    var wd = S.wd, sv = S.save, best = wd.ok > sv.rec.words;
    sv.rec.words = Math.max(sv.rec.words, wd.ok);
    sv.tot.sessions++;
    persist();
    S.wd = null;
    var h = '<div class="mo-card mo-res"><div class="mo-title">DRILL DONE</div>' +
      '<div class="mo-bigv">' + wd.ok + ' / ' + wd.len + '</div>' +
      '<div class="mo-sub">' + esc(speedLine()) + (wd.replays ? ' · ' + wd.replays + ' replay' + (wd.replays > 1 ? 's' : '') : '') + '</div>' +
      (best ? '<div class="mo-new">NEW BEST</div>' : '');
    if (wd.wrong.length) h += '<div class="mo-sec"><div class="mo-h">Missed</div><div class="mo-miss">' + wd.wrong.slice(0, 6).map(function (w) {
      return '<button type="button" class="mo-mi" data-act="hearw" data-w="' + esc(w) + '"><b>' + esc(w) + '</b></button>';
    }).join('') + '</div></div>';
    h += '<div class="mo-btns"><button type="button" class="mo-go" data-act="words-go">Again</button><button type="button" class="mo-go alt" data-act="go-words">Change</button><button type="button" class="mo-go alt" data-act="home">Menu</button></div></div>';
    render(h, 'result');
    sfx(wd.ok >= 8 ? 'win' : 'tick');
  }

  // ---- stats & settings ----
  function statsHtml() {
    var sv = S.save, st = sv.stats, r = sv.rec, cells = '';
    KOCH.forEach(function (c, i) {
      var s = st[c], lock = i >= sv.lesson && !s;
      cells += '<button type="button" class="mo-sc ' + (lock ? 'lock' : skillCls(c)) + '" data-act="hear" data-ch="' + esc(c) + '">' +
        '<b>' + esc(c) + '</b><i>' + (s ? pct(s.ok / s.n) : '–') + '</i><u style="width:' + (s ? Math.round(s.ema * 100) : 0) + '%"></u></button>';
    });
    var weak = weakest(st, ALL, 5);
    function row(k, v) { return '<span>' + k + '</span><b>' + v + '</b>'; }
    return '<div class="mo-card mo-stats"><div class="mo-title">STATS</div>' +
      '<div class="mo-grid">' + cells + '</div>' +
      '<div class="mo-note">Bar = recent skill · % = all-time accuracy · tap to hear</div>' +
      (weak.length ? '<div class="mo-sub">Weakest: <b>' + weak.map(esc).join(' ') + '</b></div>' : '') +
      '<div class="mo-recs">' +
      row('Koch lesson', (sv.lesson - 1) + ' / ' + (KOCH.length - 1)) + row('Best copy', r.copyAcc ? r.copyAcc + '%' : '–') +
      row('Arcade best', r.arcade ? fmtInt(r.arcade) + ' (lv ' + r.arcadeLv + ')' : '–') + row('Best combo', r.combo || '–') +
      row('Words best', r.words ? r.words + ' / 10' : '–') + row('Fist speed', r.sendWpm ? r.sendWpm + ' wpm' : '–') +
      row('Characters copied', fmtInt(sv.tot.chars)) + row('Characters sent', fmtInt(sv.tot.sent)) + row('Sessions', fmtInt(sv.tot.sessions)) +
      '</div>' +
      '<div class="mo-foot">' + (S.resetArm ?
        '<span class="mo-confirm">Erase all progress?</span><span><button type="button" class="mo-lnk danger" data-act="reset-yes">Erase</button><button type="button" class="mo-lnk" data-act="reset-no">Keep</button></span>' :
        '<span></span><button type="button" class="mo-lnk" data-act="reset">Reset progress</button>') + '</div>' +
      '<div class="mo-btns"><button type="button" class="mo-go" data-act="home">Back</button></div></div>';
  }
  function rng2(name, lab, min, max, stepv, val, unit) {
    return '<label class="mo-rg"><span>' + lab + '</span><input type="range" data-set="' + name + '" min="' + min + '" max="' + max + '" step="' + stepv + '" value="' + val + '"><b data-out="' + name + '">' + val + unit + '</b></label>';
  }
  function settingsHtml() {
    var st = S.save.set;
    return '<div class="mo-card mo-set"><div class="mo-title">SETTINGS</div>' +
      '<div class="mo-sec"><div class="mo-h">Speed &amp; tone</div>' +
      rng2('wpm', 'Character speed', 5, 45, 1, st.wpm, ' wpm') +
      rng2('eff', 'Effective (Farnsworth)', 3, st.wpm, 1, st.eff, ' wpm') +
      rng2('pitch', 'Tone pitch', 300, 1200, 10, st.pitch, ' Hz') +
      rng2('vol', 'Volume', 5, 100, 5, Math.round(st.vol * 100), '%') +
      '<button type="button" class="mo-go alt sm" data-act="test">&#9654; Test: PARIS</button></div>' +
      '<div class="mo-sec"><div class="mo-h">Copy</div>' +
      '<div class="mo-orow"><span>Group size</span><div class="mo-opts">' + [1, 2, 3, 4, 5].map(function (n) { return opt('group', n, st.group, n); }).join('') + '</div></div>' +
      '<div class="mo-orow"><span>Session</span><div class="mo-opts">' + [10, 25, 40, 60].map(function (n) { return opt('len', n, st.len, n); }).join('') + '</div></div>' +
      '<div class="mo-orow"><span>Practice set</span><div class="mo-opts">' + opt('pool', 'lesson', st.pool, 'Lesson') + opt('pool', 'all', st.pool, 'Everything') + '</div></div>' +
      '<div class="mo-orow"><span>Flash lamp</span><div class="mo-opts">' + opt('lamp', 1, st.lamp ? 1 : 0, 'On') + opt('lamp', 0, st.lamp ? 1 : 0, 'Off') + '</div></div></div>' +
      '<div class="mo-sec"><div class="mo-h">Send</div>' +
      '<div class="mo-orow"><span>Key</span><div class="mo-opts">' + opt('keyer', 'straight', st.keyer, 'Straight') + opt('keyer', 'iambic', st.keyer, 'Iambic paddles') + '</div></div>' +
      rng2('kwpm', 'Keying speed', 5, 40, 1, st.kwpm, ' wpm') +
      '<div class="mo-orow"><span>Code hint</span><div class="mo-opts">' + opt('hint', 1, st.hint ? 1 : 0, 'Show') + opt('hint', 0, st.hint ? 1 : 0, 'Hide') + '</div></div></div>' +
      '<div class="mo-btns"><button type="button" class="mo-go" data-act="home">Done</button></div></div>';
  }
  function setOpt(name, v) {
    var st = S.save.set;
    if (name === 'group' || name === 'len') st[name] = +v;
    else if (name === 'lamp' || name === 'hint' || name === 'ears') st[name] = v === '1' || v === 'true';
    else st[name] = v;
    S.save = normSave(S.save);
    persist();
  }
  function setRange(name, v) {
    var st = S.save.set;
    v = +v;
    if (name === 'vol') st.vol = v / 100; else st[name] = v;
    if (name === 'wpm' && st.eff > st.wpm) st.eff = st.wpm;
    S.save = normSave(S.save);
    persist();
    var out = S.scr.querySelector('[data-out="' + name + '"]');
    if (out) out.textContent = (name === 'vol' ? Math.round(st.vol * 100) : st[name]) + (name === 'pitch' ? ' Hz' : name === 'vol' ? '%' : ' wpm');
    if (name === 'wpm') {
      var e = S.scr.querySelector('[data-set="eff"]');
      if (e) { e.max = st.wpm; e.value = st.eff; }
      var eo = S.scr.querySelector('[data-out="eff"]');
      if (eo) eo.textContent = st.eff + ' wpm';
    }
  }

  // ---- arcade ----
  var VW = 340, CW = 8, RH = 12;
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOOD = 4, C_BAD = 5, C_GOLD = 6, NPAL = 7;
  function arcadeHtml() {
    return '<div class="mo-play mo-arc">' +
      '<div class="mo-stagebox"><canvas class="mo-cv" aria-label="Arcade: Morse codes fall; type each character before it lands"></canvas><div class="mo-ovl"></div></div>' +
      kbHtml(arcadePool(practicePool(), 1)) + '</div>';
  }
  function startArcadeScreen() {
    stopPlay();
    render(arcadeHtml(), 'arcade');
    S.cv = S.scr.querySelector('.mo-cv'); S.ovl = S.scr.querySelector('.mo-ovl'); S.stg = S.scr.querySelector('.mo-stagebox');
    S.ctx = S.cv.getContext('2d');
    S.ar = null; S.paused = false;
    arcLayout(); readTheme();
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    S.cv.addEventListener('pointerdown', arcTap);
    arcCard('start');
    arcDraw(1);
    requestAnimationFrame(function () { if (S && S.screen === 'arcade') { arcLayout(); arcDraw(1); } });
  }
  function leaveArcade() {
    stopLoop();
    if (S.atl) { freeCanvas(S.atl.cv); S.atl = null; }
    if (S.cv) freeCanvas(S.cv);
    S.cv = null; S.ctx = null; S.ar = null; S.paused = false;
  }
  function arcCard(kind) {
    S.card = kind;
    var sv = S.save, a = S.ar, h = '';
    if (kind === 'start') {
      h = '<div class="mo-card"><div class="mo-title">ARCADE</div>' +
        '<p>Codes fall and beep as they appear. Type the character before it lands. Every 8 catches the speed goes up and a new character joins.</p>' +
        '<div class="mo-opts">' + opt('ears', 0, sv.set.ears ? 1 : 0, 'Codes + sound') + opt('ears', 1, sv.set.ears ? 1 : 0, 'Ears only ×2') + '</div>' +
        '<div class="mo-note">' + (sv.rec.arcade ? 'Best <b>' + fmtInt(sv.rec.arcade) + '</b> · level ' + sv.rec.arcadeLv : 'Tap a falling code to hear it again') + '</div>' +
        '<div class="mo-btns"><button type="button" class="mo-go" data-act="arc-go">Play' + (S.coarse ? '' : ' <small>enter</small>') + '</button><button type="button" class="mo-go alt" data-act="home">Menu</button></div></div>';
    } else if (kind === 'pause') {
      h = '<div class="mo-card"><div class="mo-title">PAUSED</div><div class="mo-sub">' + fmtInt(a.score) + ' points · level ' + a.lv + '</div>' +
        '<div class="mo-btns"><button type="button" class="mo-go" data-act="arc-resume">Resume</button><button type="button" class="mo-go alt" data-act="arc-quit">End game</button></div>' +
        '<div class="mo-note">' + (S.coarse ? '' : 'Esc / Enter to resume') + '</div></div>';
    } else if (kind === 'over') {
      h = '<div class="mo-card mo-res"><div class="mo-title">SIGNAL LOST</div><div class="mo-bigv">' + fmtInt(a.score) + '</div>' +
        (S.arBest ? '<div class="mo-new">NEW BEST</div>' : '<div class="mo-note">Best ' + fmtInt(sv.rec.arcade) + '</div>') +
        '<div class="mo-sub">level ' + a.lv + ' · ' + a.hits + ' caught · best combo ' + a.bestCombo + '</div>';
      var lost = S.arLost || [];
      if (lost.length) h += '<div class="mo-sec"><div class="mo-h">Got past you</div><div class="mo-miss">' + lost.slice(0, 6).map(function (c) {
        return '<button type="button" class="mo-mi" data-act="hear" data-ch="' + esc(c) + '"><b>' + esc(c) + '</b>' + codeHtml(CODE[c]) + '</button>';
      }).join('') + '</div></div>';
      h += '<div class="mo-btns"><button type="button" class="mo-go" data-act="arc-go">Again' + (S.coarse ? '' : ' <small>enter</small>') + '</button><button type="button" class="mo-go alt" data-act="home">Menu</button></div></div>';
    }
    S.ovl.innerHTML = h;
    S.ovl.style.display = h ? '' : 'none';
    S.stg.classList.toggle('dim', !!h);
    syncHead();
  }
  function arcStart() {
    S.au.ensure();
    S.ar = newArcade((Math.random() * 4294967295) >>> 0, { pool: practicePool(), stats: S.save.stats, ears: S.save.set.ears, dot: 1.2 / S.save.set.wpm });
    S.paused = false; S.arLost = []; S.arBest = false;
    S.fx = { parts: [], pops: [], shake: 0, flash: 0, msg: null };
    var kb = S.scr.querySelector('.mo-kb');
    if (kb) kb.outerHTML = kbHtml(S.ar.pool);
    arcCard(null);
    arcSay('READY', C_ACC, 1.1);
    kick();
  }
  function arcPause() {
    if (!S || S.screen !== 'arcade' || !S.ar || S.ar.phase !== 'run' || S.paused) return;
    S.paused = true;
    stopLoop(); S.au.hush();
    arcCard('pause');
    arcDraw(1);
  }
  function arcResume() {
    if (!S || !S.paused) return;
    S.paused = false;
    arcCard(null);
    kick();
  }
  function arcOver() {
    var a = S.ar;
    S.arBest = settleArcade(S.save, a).best;
    persist();
    stopLoop();
    arcCard('over');
    arcDraw(1);
    sfx(S.arBest ? 'win' : 'land');
  }
  function arcSay(text, ci, dur) { S.fx.msg = { text: text, ci: ci, t: 0, dur: dur || 1.2 }; }
  function colX(col) { var pad = 10, w = (VW - 2 * pad) / COLS; return pad + w * (col + 0.5); }
  var TOP = 30;
  function groundY() { return S.VH - 26; }
  function itemY(it, alpha) { var y = it.py + (it.y - it.py) * alpha; return TOP + (groundY() - TOP - 10) * y; }
  function arcTap(e) {
    if (!S || !S.ar || S.ar.phase !== 'run' || S.paused) return;
    e.preventDefault();
    var r = S.cv.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * VW, y = (e.clientY - r.top) / r.height * S.VH;
    var best = null, bd = 1e9;
    S.ar.items.forEach(function (it) {
      var dx = Math.abs(colX(it.col) - x), dy = Math.abs(itemY(it, 1) - y);
      if (dx < 36 && dy < 26 && dx + dy < bd) { bd = dx + dy; best = it; }
    });
    if (best) beepCode(best.code, true);
  }
  function beepCode(code, tap) {
    var a = S.au;
    if (!a.ok()) return;
    if (tap && a.busy - a.now() > 1.5) return;   // already a queue of beeps: don't pile on
    var tm = timing(S.save.set.wpm, S.save.set.wpm), sch = { tones: [] }, t = 0;
    for (var i = 0; i < code.length; i++) { var d = code.charAt(i) === '.' ? tm.dot : tm.dash; sch.tones.push({ t: t, d: d }); t += d + tm.dot; }
    var at = Math.max(a.now() + 0.03, a.busy + tm.dot * 3);
    a.tones(sch.tones, at, S.save.set.pitch, vol());
  }
  function arcEvents() {
    var a = S.ar, fx = S.fx, ev = a.events;
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e.k === 'spawn') beepCode(e.it.code);
      else if (e.k === 'hit') {
        var x = colX(e.it.col), y = itemY(e.it, 1);
        burst(x, y, 12, 70, '*+.\'', C_GOOD);
        fx.pops.push({ x: x, y: y - 16, t: 0, s: '+' + e.pts, ci: C_GOLD });
        fx.pops.push({ x: x, y: y + 10, t: 0, s: e.it.ch, ci: C_GOOD, big: true });
        sfx('good');
        if (Cade.haptic) Cade.haptic(6);
      } else if (e.k === 'land') {
        var lx = colX(e.it.col);
        burst(lx, groundY() - 4, 14, 80, '#*x', C_BAD);
        fx.pops.push({ x: lx, y: groundY() - 18, t: 0, s: e.it.ch, ci: C_BAD, big: true });
        fx.shake = 0.3; fx.flash = 0.25;
        if (S.arLost.indexOf(e.it.ch) < 0) S.arLost.push(e.it.ch);
        sfx('land');
        if (Cade.haptic) Cade.haptic(25);
      } else if (e.k === 'wrong') { sfx('bad'); fx.flash = Math.max(fx.flash, 0.08); flashKey(e.ch, false); }
      else if (e.k === 'level') {
        arcSay('LEVEL ' + e.lv + (e.added ? '   NEW: ' + e.added : ''), C_ACC, 1.8);
        sfx('level');
        var kb = S.scr.querySelector('.mo-kb');
        if (kb && e.added) kb.outerHTML = kbHtml(a.pool);
      }
    }
    ev.length = 0;
  }
  function burst(x, y, n, sp, codes, ci) {
    if (S.rm) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var an = Math.random() * Math.PI * 2, v = sp * (0.35 + Math.random() * 0.65);
      S.fx.parts.push({ x: x, y: y, vx: Math.cos(an) * v, vy: Math.sin(an) * v - 20, t: 0, life: 0.5 + Math.random() * 0.4, code: codes.charCodeAt(i % codes.length), ci: ci });
    }
    if (S.fx.parts.length > 160) S.fx.parts.splice(0, S.fx.parts.length - 160);
  }
  function stepFx(dt) {
    var fx = S.fx, i;
    for (i = fx.parts.length - 1; i >= 0; i--) {
      var p = fx.parts[i];
      p.t += dt;
      if (p.t >= p.life) { fx.parts.splice(i, 1); continue; }
      p.vy += 160 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (i = fx.pops.length - 1; i >= 0; i--) if ((fx.pops[i].t += dt) > 0.9) fx.pops.splice(i, 1);
    if (fx.shake > 0) fx.shake = Math.max(0, fx.shake - dt);
    if (fx.flash > 0) fx.flash = Math.max(0, fx.flash - dt);
    if (fx.msg && (fx.msg.t += dt) > fx.msg.dur) fx.msg = null;
  }
  function arcFrame(ts) {
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    var a = S.ar, alpha = arcAdvance(a, dt);
    arcEvents();
    stepFx(dt);
    arcDraw(alpha);
    if (a.phase === 'done') arcOver();
  }

  // ---- theme + glyph atlas (arcade canvas) ----
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
  function cssc(c, al) {
    var r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
    return al == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + al + ')';
  }
  function readTheme() {
    if (!S.cv) return;
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.55)), fa = parseCol(v('--text-faint'), mix(bg, tx, 0.35));
    var su = parseCol(v('--surface'), bg);
    S.pal = [cssc(tx), cssc(mu), cssc(fa), cssc(ac), dark ? '#7ed37a' : '#2f8f3a', dark ? '#f06a6a' : '#cf3f3f', dark ? '#f2c544' : '#b07d06'];
    S.col = { bg: cssc(bg), surf: cssc(su), acc: ac, bgv: bg, dark: dark, grid: cssc(mix(bg, tx, dark ? 0.08 : 0.06)), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace' };
    fitFont();
  }
  var AT_COLS = 24, AT_ROWS = 14;
  function fitFont() {
    if (!S.ctx || !S.col) return;
    var c = S.ctx, f = S.col.font;
    c.font = '600 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = CW / adv;
    S.fnt = '600 ' + S.fpx.toFixed(3) + 'px ' + f;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    a.sc = 2.5;
    a.cwp = Math.ceil((CW + 4) * S.k * a.sc); a.chp = Math.ceil((RH + 6) * S.k * a.sc);
    a.cv.width = a.cwp * AT_COLS; a.cv.height = a.chp * AT_ROWS;
    a.c = a.cv.getContext('2d');
    a.c.font = '600 ' + (S.fpx * S.k * a.sc).toFixed(3) + 'px ' + f;
    a.c.textAlign = 'center'; a.c.textBaseline = 'middle';
    a.cw = a.cwp / S.k / a.sc; a.ch = a.chp / S.k / a.sc; a.n = 0; a.max = AT_COLS * AT_ROWS;
    S.gmap = [];
    for (var i = 0; i < NPAL; i++) { var m = new Int16Array(128); for (var j = 0; j < 128; j++) m[j] = -1; S.gmap.push(m); }
  }
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function gIdx(ci, code) {
    if (code >= 128) return -1;
    var m = S.gmap[ci], i = m[code], a = S.atl;
    if (i >= 0) return i;
    if (a.n >= a.max) return -1;
    i = a.n++;
    a.c.fillStyle = S.pal[ci];
    a.c.fillText(String.fromCharCode(code), (i % AT_COLS) * a.cwp + a.cwp / 2, ((i / AT_COLS) | 0) * a.chp + a.chp / 2);
    m[code] = i;
    return i;
  }
  function glyph(c, ci, code, x, y, sc) {
    if (code === 32) return;
    var i = gIdx(ci, code), a = S.atl;
    if (i < 0) { c.font = S.fnt; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = S.pal[ci]; c.fillText(String.fromCharCode(code), x, y); return; }
    sc = sc || 1;
    var w = a.cw * sc, h = a.ch * sc, dx = x - w / 2, dy = y - h / 2;
    if (sc === 1) { dx = Math.round(dx * S.k) / S.k; dy = Math.round(dy * S.k) / S.k; }
    c.drawImage(a.cv, (i % AT_COLS) * a.cwp, ((i / AT_COLS) | 0) * a.chp, a.cwp, a.chp, dx, dy, w, h);
  }
  function drawStr(c, ci, s, x, y, align, sc) {
    sc = sc || 1;
    var n = s.length, cw = CW * sc, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, s.charCodeAt(i), x0 + i * cw + cw / 2, y, sc);
  }
  function rrect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r); c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h); c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r); c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }
  function arcLayout() {
    if (!S.cv) return;
    var w = S.stg.parentNode.clientWidth || 340, vh = window.innerHeight || 700, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var s = w / VW, kb = S.scr.querySelector('.mo-kb'), kbh = kb ? kb.offsetHeight : 120;
    var pr = S.panel.getBoundingClientRect(), hd = S.panel.querySelector('.cade-panel-head');
    var avail = vh - Math.max(0, Math.min(pr.top, 120)) - (hd ? hd.offsetHeight : 40) - kbh - 40;
    S.VH = Math.round(clamp(avail / s, 250, 440));
    var cw = Math.floor(w), ch = Math.floor(S.VH * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stg.style.height = ch + 'px';
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / VW;
    S.VH = S.cv.height / S.k;
    if (S.col) fitFont();
  }
  function arcDraw(alpha) {
    var c = S.ctx, a = S.ar, fx = S.fx || { parts: [], pops: [], shake: 0, flash: 0 }, P = S.pal, VH = S.VH, gy = groundY(), i;
    if (!c || !S.atl) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = S.col.bg; c.fillRect(0, 0, S.cv.width, S.cv.height);
    var sx = fx.shake > 0 && !S.rm ? (Math.random() - 0.5) * 6 * fx.shake / 0.3 : 0;
    c.setTransform(S.k, 0, 0, S.k, sx * S.k, 0);
    // column guides: faint dotted lanes
    c.globalAlpha = 0.5;
    for (i = 0; i < COLS; i++) for (var y = TOP + 6; y < gy - 8; y += 14) glyph(c, C_FAINT, 46, colX(i), y);
    c.globalAlpha = 1;
    // ground: the station
    var gc = fx.flash > 0 ? C_BAD : C_FAINT;
    for (var x = 4; x < VW; x += CW) glyph(c, gc, 61, x, gy + 4);
    drawStr(c, C_MUTED, '/|\\', VW / 2, gy - 8, 'center');
    glyph(c, C_ACC, 42, VW / 2, gy - 20);
    // the falling codes
    var items = a ? a.items : [];
    for (i = 0; i < items.length; i++) {
      var it = items[i], cx = colX(it.col), cy = itemY(it, alpha), danger = it.y > 0.72;
      var code = it.code, DIT = 4, DAH = 11, GAP = 3, wcode = 0, k;
      for (k = 0; k < code.length; k++) wcode += (code.charAt(k) === '.' ? DIT : DAH) + (k ? GAP : 0);
      var bw = a.ears ? 34 : Math.max(26, wcode + 14), bh = 18;
      c.fillStyle = S.col.surf;
      rrect(c, cx - bw / 2, cy - bh / 2, bw, bh, 6); c.fill();
      c.lineWidth = danger ? 1.6 : 1; c.strokeStyle = danger ? P[C_BAD] : P[C_ACC]; c.stroke();
      c.fillStyle = danger ? P[C_BAD] : P[C_TEXT];
      if (a.ears) drawStr(c, danger ? C_BAD : C_MUTED, '?', cx, cy, 'center');
      else {
        var px = cx - wcode / 2;
        for (k = 0; k < code.length; k++) {
          var ew = code.charAt(k) === '.' ? DIT : DAH;
          rrect(c, px, cy - 2, ew, 4, 2); c.fill();
          px += ew + GAP;
        }
      }
    }
    // particles and pop-ups
    for (i = 0; i < fx.parts.length; i++) {
      var p = fx.parts[i];
      c.globalAlpha = Math.max(0, 1 - p.t / p.life);
      glyph(c, p.ci, p.code, p.x, p.y);
    }
    for (i = 0; i < fx.pops.length; i++) {
      var q = fx.pops[i];
      c.globalAlpha = Math.max(0, 1 - q.t / 0.9);
      drawStr(c, q.ci, q.s, q.x, q.y - q.t * (q.big ? 14 : 24), 'center', q.big ? 2 : 1);
    }
    c.globalAlpha = 1;
    // HUD
    if (a) {
      drawStr(c, C_TEXT, 'SCORE ' + fmtInt(a.score), 8, 12, 'left');
      var m = arcMult(a);
      if (m > 1) drawStr(c, C_GOLD, 'x' + m, 8, 25, 'left');
      drawStr(c, C_MUTED, 'LV ' + a.lv, VW / 2, 12, 'center');
      // lives as signal-strength bars
      drawStr(c, C_MUTED, 'SIG', VW - 34, 12, 'right');
      for (i = 0; i < LIVES; i++) {
        var bh2 = 4 + i * 3.5;
        c.fillStyle = i < a.lives ? (a.lives === 1 ? P[C_BAD] : P[C_ACC]) : P[C_FAINT];
        c.globalAlpha = i < a.lives ? 1 : 0.45;
        c.fillRect(VW - 30 + i * 8, 17 - bh2, 5, bh2);
      }
      c.globalAlpha = 1;
    } else {
      drawStr(c, C_MUTED, 'BEST ' + fmtInt(S.save.rec.arcade), 8, 12, 'left');
    }
    if (fx.msg) {
      c.globalAlpha = Math.min(1, (fx.msg.dur - fx.msg.t) / 0.3);
      drawStr(c, fx.msg.ci, fx.msg.text, VW / 2, VH * 0.42, 'center', 1.4);
      c.globalAlpha = 1;
    }
  }

  // ---- playback with the lamp ----
  function play(text, onDone) {
    stopPlay();
    var set = S.save.set, tm = timing(set.wpm, set.eff), sch = schedule(text, tm), lead = 0.08;
    S.au.ensure();
    if (S.au.ok()) { lead = Math.max(lead, S.au.busy - S.au.now() + 0.05); S.au.tones(sch.tones, S.au.now() + lead, set.pitch, vol()); }
    S.pl = { sch: sch, t0: performance.now() + lead * 1000, done: onDone || null };
    kick();
  }
  function stopPlay() {
    if (!S) return;
    if (S.pl) { S.pl = null; lamp(false); }
    S.au.hush();
  }
  function lamp(on) {
    if (!S.lampEl || S.lampOn === on) return;
    S.lampOn = on;
    S.lampEl.classList.toggle('on', on);
  }
  function flashKey(ch, ok) {
    var b = S.scr.querySelector('.mo-key[data-key="' + (ch === '"' ? '' : ch) + '"]');
    if (!b) return;
    b.classList.remove('hit', 'miss');
    void b.offsetWidth;
    b.classList.add(ok ? 'hit' : 'miss');
  }

  // ---- the loop: runs only while something is playing, a key is live, or the arcade runs ----
  function needLoop() {
    if (!S || document.hidden || (Cade.isMinimized && Cade.isMinimized(S.panel))) return false;
    return !!S.pl || (S.screen === 'send' && !!S.sd) || (S.screen === 'arcade' && !!S.ar && S.ar.phase === 'run' && !S.paused);
  }
  function kick() { if (S && !S.raf && needLoop()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!needLoop()) return;
    var now = performance.now();
    if (S.pl) {
      var e = (now - S.pl.t0) / 1000;
      lamp(S.save.set.lamp && e >= 0 && toneAt(S.pl.sch, e));
      if (e >= S.pl.sch.dur + 0.03) { var cb = S.pl.done; S.pl = null; lamp(false); if (cb) cb(); }
    }
    if (S.screen === 'send' && S.sd) sendTick(now);
    if (S.screen === 'arcade' && S.ar && S.ar.phase === 'run' && !S.paused) arcFrame(ts);
    if (S && !S.raf && needLoop()) S.raf = requestAnimationFrame(frame);
  }
  // pause everything (blur, hidden tab, minimize)
  function hold() {
    if (!S) return;
    if (S.screen === 'arcade') arcPause();
    else if (S.screen === 'copy' || S.screen === 'words') {
      var had = !!S.pl || S.tm.length;
      clearLater(); stopPlay();
      if (had) msg('Paused — ' + (S.coarse ? 'tap Replay' : 'press Enter') + ' to carry on');
      if (S.cp) S.cp.wait = S.cp.pos >= (S.cp.g || '').length;
    }
    if (S.sd) { S.sd.src = {}; S.sd.dit = {}; S.sd.dah = {}; S.sd.kr.dit = S.sd.kr.dah = false; S.au.key(false, S.save.set.pitch, 0); if (S.sd.dec.isDown) decUp(S.sd.dec, performance.now()); syncKeyBtns(); }
    stopLoop();
  }

  // ---- gamepad (send mode): A = straight key; LB / ← dit, RB / → dah ----
  function readPad() {
    var pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) return pads[i];
    return null;
  }
  function btnOn(p, i) { var b = p.buttons[i]; return !!b && (b.pressed || b.value > 0.5); }
  function pollPad() {
    if (!S.padSeen) return;
    var p = readPad(), sd = S.sd;
    if (!p || !sd) return;
    if (sd.iambic) {
      var di = btnOn(p, 4) || btnOn(p, 14) || btnOn(p, 2), da = btnOn(p, 5) || btnOn(p, 15) || btnOn(p, 1);
      if (!!sd.dit.pad !== di) setKey('dit', 'pad', di);
      if (!!sd.dah.pad !== da) setKey('dah', 'pad', da);
    } else {
      var k = btnOn(p, 0) || btnOn(p, 7) || btnOn(p, 5);
      if (!!sd.src.pad !== k) setKey('key', 'pad', k);
    }
  }

  // ---- keyboard: only while focus is in the panel (the editor keeps its typing) ----
  var DIT_KEYS = { KeyZ: 1, ArrowLeft: 1, BracketLeft: 1 }, DAH_KEYS = { KeyX: 1, ArrowRight: 1, BracketRight: 1 };
  function ours(e) {
    if (!S || !S.panel.isConnected) return false;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return false;
    var ae = document.activeElement;
    return !!ae && S.panel.contains(ae);
  }
  function onKey(e) {
    if (!S) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || !ours(e)) return;
    var t = e.target, code = e.code || '', key = e.key || '', isBtn = t && t.tagName === 'BUTTON', isInput = t && t.tagName === 'INPUT';
    if (key === 'Escape') {
      e.preventDefault();
      if (S.screen === 'arcade' && S.ar && S.ar.phase === 'run') { if (S.paused) arcResume(); else arcPause(); }
      else if (S.screen === 'home') closePanel();
      else goHome();
      return;
    }
    if (isInput) return;
    var scr = S.screen;
    if (scr === 'send' && S.sd) {
      var sd = S.sd;
      if (!sd.iambic && (code === 'Space' || key === ' ')) { e.preventDefault(); if (!e.repeat) setKey('key', 'kb', true); return; }
      if (sd.iambic && (DIT_KEYS[code] || DAH_KEYS[code])) { e.preventDefault(); if (!e.repeat) setKey(DIT_KEYS[code] ? 'dit' : 'dah', 'kb' + code, true); return; }
      if (key === 'Enter' && !isBtn) { e.preventDefault(); return; }
      return;
    }
    var ch = key.length === 1 ? key.toUpperCase() : '';
    if (scr === 'copy' && S.cp) {
      if (key === 'Enter') { e.preventDefault(); if (!e.repeat) replay(); return; }
      if (key === ' ') { e.preventDefault(); if (!e.repeat) copyChar(''); return; }
      if (CODE[ch]) { e.preventDefault(); copyChar(ch); }
      return;
    }
    if (scr === 'words' && S.wd) {
      if (key === 'Enter') { e.preventDefault(); if (!e.repeat) { if (S.wd.shown) replay(); else wordsChar('ENTER'); } return; }
      if (key === 'Backspace') { e.preventDefault(); wordsChar('BS'); return; }
      if (key === ' ') { e.preventDefault(); return; }
      if (CODE[ch]) { e.preventDefault(); wordsChar(ch); }
      return;
    }
    if (scr === 'intro' && key === 'Enter' && !isBtn) { e.preventDefault(); act('intro-go'); return; }
    if (scr === 'arcade') {
      if (S.ar && S.ar.phase === 'run') {
        if (S.paused) { if ((key === 'Enter' || key === ' ') && !isBtn) { e.preventDefault(); arcResume(); } return; }
        if (CODE[ch]) { e.preventDefault(); arcType(S.ar, ch); arcEvents(); return; }
        if (key === ' ' || key === 'Enter') e.preventDefault();
        return;
      }
      if ((key === 'Enter' || key === ' ') && !isBtn) { e.preventDefault(); if (!e.repeat) act('arc-go'); }
    }
  }
  function onKeyUp(e) {
    if (!S) return;
    var code = e.code || '';
    if ((code === 'Space' || e.key === ' ') && ours(e) && /^(send|copy|words|arcade)$/.test(S.screen) && e.target && e.target.tagName === 'BUTTON') e.preventDefault();
    if (!S.sd) return;
    if (code === 'Space' || e.key === ' ') setKey('key', 'kb', false);
    if (DIT_KEYS[code]) setKey('dit', 'kb' + code, false);
    if (DAH_KEYS[code]) setKey('dah', 'kb' + code, false);
  }

  // ---- actions ----
  function goHome() {
    if (S.screen === 'arcade') leaveArcade();
    if (S.sd) { S.au.keyOff(); }
    S.cp = null; S.sd = null; S.wd = null; S.intro = null; S.resetArm = false;
    persist();
    toHome();
  }
  function act(a, b) {
    var sv = S.save;
    S.au.ensure();
    switch (a) {
      case 'home': goHome(); break;
      case 'help': stopPlay(); render(helpHtml(), 'help'); break;
      case 'stats': stopPlay(); S.resetArm = false; render(statsHtml(), 'stats'); break;
      case 'settings': stopPlay(); render(settingsHtml(), 'settings'); break;
      case 'les-': case 'les+':
        sv.lesson = clamp(sv.lesson + (a === 'les+' ? 1 : -1), MIN_LESSON, KOCH.length);
        sv.maxLesson = Math.max(sv.maxLesson, sv.lesson);
        persist(); render(homeHtml(), 'home');
        var nb = S.scr.querySelector('[data-act="' + a + '"]');
        if (nb && !nb.disabled) { try { nb.focus({ preventScroll: true }); } catch (e) {} }
        if (a === 'les+') play(KOCH[sv.lesson - 1]);
        break;
      case 'hear': if (b) { play(b.getAttribute('data-ch')); sayCode(b.getAttribute('data-ch')); } break;
      case 'hear3': if (b) play(b.getAttribute('data-ch') + ' ' + b.getAttribute('data-ch') + ' ' + b.getAttribute('data-ch')); break;
      case 'hearw': if (b) play(b.getAttribute('data-w')); break;
      case 'test': play('PARIS'); break;
      case 'go-copy': if (S.screen === 'arcade') leaveArcade(); startCopy(); break;
      case 'intro-go':
        (S.intro || []).forEach(function (c) { if (sv.seen.indexOf(c) < 0) sv.seen.push(c); });
        persist(); S.intro = null; stopPlay(); startCopy(); break;
      case 'replay': replay(); break;
      case 'skip': copyChar(''); break;
      case 'go-send': stopPlay(); startSend(); break;
      case 'hint': sv.set.hint = !sv.set.hint; persist(); if (b) b.classList.toggle('on', sv.set.hint); if (S.sd) sendSync(); break;
      case 'sskip':
        if (S.sd && !S.sd.wait) { record(sv.stats, S.sd.target, false); S.sd.n++; S.sd.miss[S.sd.target] = 1; S.sd.wait = true; msg('<b>' + esc(S.sd.target) + '</b> is ' + codeHtml(CODE[S.sd.target]), 'bad'); sendSync(); later(nextTarget, 1500); }
        break;
      case 'go-words': stopPlay(); render(wordsStartHtml(), 'wstart'); break;
      case 'words-go': stopPlay(); startWords(); break;
      case 'wcheck': if (S.wd && !S.wd.shown) { if (S.wd.typed) checkWord(); else replay(); } break;
      case 'go-arcade': startArcadeScreen(); break;
      case 'arc-go': if (S.screen === 'arcade' && (!S.ar || S.ar.phase === 'done')) arcStart(); break;
      case 'arc-resume': arcResume(); break;
      case 'arc-quit': if (S.ar) { S.ar.phase = 'done'; S.paused = false; arcOver(); } break;
      case 'reset': S.resetArm = true; render(statsHtml(), 'stats'); break;
      case 'reset-no': S.resetArm = false; render(statsHtml(), 'stats'); break;
      case 'reset-yes':
        var keepSet = sv.set;
        S.save = newSave(); S.save.set = keepSet; S.resetArm = false;
        persist(); toast('Progress reset'); toHome(); break;
    }
  }
  function sayCode(ch) {
    if (S.screen !== 'home' && S.screen !== 'stats') return;
    var n = S.scr.querySelector('.mo-note');
    if (n && CODE[ch]) n.innerHTML = '<b>' + esc(ch) + '</b> ' + codeHtml(CODE[ch]) + skillNote(ch);
  }
  function skillNote(ch) {
    var s = S.save.stats[ch];
    return s ? ' &nbsp;<span class="mo-faint">' + pct(s.ok / s.n) + ' of ' + s.n + '</span>' : '';
  }

  // ---- header ----
  function syncHead() {
    if (!S || !S.head) return;
    var sb = S.head.querySelector('[data-h="sound"]'), pb = S.head.querySelector('[data-h="pause"]');
    sb.innerHTML = S.au.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.au.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.au.on ? 'true' : 'false');
    sb.classList.toggle('on', S.au.on);
    var live = S.screen === 'arcade' && S.ar && S.ar.phase === 'run';
    pb.style.display = S.screen === 'arcade' ? '' : 'none';
    pb.disabled = !live;
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.title = S.paused ? 'Resume' : 'Pause';
    pb.setAttribute('aria-label', pb.title);
  }

  // ---- open / close ----
  function noTouch(e) { if (e.cancelable) e.preventDefault(); }
  function teardown() {
    if (!S) return;
    var s = S;
    clearLater();
    S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('keyup', s.onKeyUp, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    window.removeEventListener('gamepadconnected', s.onPad);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.au.close();
    if (s.atl) freeCanvas(s.atl.cv);
    if (s.cv) freeCanvas(s.cv);
    try { sset(SAVE_KEY, JSON.stringify(s.save)); } catch (e) {}
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }

  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var p = Cade.mkPanel(PANEL_ID, '📡 Morse Trainer', '<div class="mo" tabindex="-1"><div class="mo-scr"></div></div>');
    try { Cade.editor.contentDOM.blur(); } catch (e) {}
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'mo-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How it works" aria-label="How it works">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, root: p.querySelector('.mo'), scr: p.querySelector('.mo-scr'), save: ld.save, au: new Au(sget(SOUND_KEY) !== '0'),
      coarse: !!(mm && mm('(pointer: coarse)').matches), rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches),
      screen: '', tm: [], raf: 0, last: 0, pl: null, cp: null, sd: null, wd: null, ar: null, paused: false, resetArm: false, padSeen: false,
      cv: null, ctx: null, atl: null, k: 1, VH: 360, fx: null
    };
    p._onClose = teardown;

    S.onKey = onKey; S.onKeyUp = onKeyUp;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKeyUp, true);
    S.onVis = function () { if (document.hidden) hold(); else kick(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { hold(); };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) hold(); });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        if (S.screen === 'arcade') { arcLayout(); arcDraw(1); }
        kick();
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && S.screen === 'arcade' && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { arcLayout(); arcDraw(1); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    S.onPad = function () { if (S) S.padSeen = true; };
    window.addEventListener('gamepadconnected', S.onPad);
    if (readPad()) S.padSeen = true;
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S || !S.cv) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); arcDraw(1);
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    // header: help / sound / pause (the header drags the panel — these are controls)
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.au.on = !S.au.on;
        sset(SOUND_KEY, S.au.on ? '1' : '0');
        if (!S.au.on) { S.au.hush(); S.au.keyOff(); }
        S.au.ensure(); sfx('tick');
        syncHead();
      } else if (h === 'pause') { if (S.paused) arcResume(); else arcPause(); }
      else if (h === 'help') {
        if (S.screen === 'arcade' && S.ar && S.ar.phase === 'run') { arcPause(); return; }
        if (S.screen === 'help') goHome();
        else { if (S.screen === 'arcade') leaveArcade(); S.cp = S.sd = S.wd = null; S.au.keyOff(); act('help'); }
      }
      S.root.focus({ preventScroll: true });
    });

    // Rapid tapping must never zoom, select, magnify or open a callout. CSS does most
    // of it; the key pads and hold buttons cancel their touches outright and the panel
    // swallows gesture / dblclick events.
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    S.root.addEventListener('touchstart', function (e) {
      var k = e.target.closest ? e.target.closest('.mo-key, .mo-hold') : null;
      if (k) noTouch(e);
    }, { passive: false });
    S.root.addEventListener('touchend', function (e) {
      var k = e.target.closest ? e.target.closest('.mo-key, .mo-hold') : null;
      if (k) noTouch(e);
    }, { passive: false });
    S.root.addEventListener('contextmenu', function (e) { if (e.target.closest && e.target.closest('.mo-key, .mo-hold, .mo-cv')) e.preventDefault(); });

    // keep focus in the panel so keys reach us (Safari doesn't focus buttons on click)
    S.root.addEventListener('pointerdown', function (e) {
      if (!S) return;
      S.au.ensure();
      var tg = e.target;
      if (tg && tg.tagName === 'INPUT') return;
      if (!S.root.contains(document.activeElement) || document.activeElement === document.body) {
        try { S.root.focus({ preventScroll: true }); } catch (er) {}
      }
      // virtual keys act on press (fast typing); hold buttons key the sidetone
      var key = tg.closest ? tg.closest('.mo-key') : null;
      if (key && e.button <= 0) {
        e.preventDefault();
        var ch = key.getAttribute('data-key');
        try { S.root.focus({ preventScroll: true }); } catch (er) {}
        if (S.screen === 'copy') copyChar(ch);
        else if (S.screen === 'words') wordsChar(ch);
        else if (S.screen === 'arcade' && S.ar && S.ar.phase === 'run' && !S.paused) { arcType(S.ar, ch); arcEvents(); }
        else if (CODE[ch]) play(ch);
        return;
      }
      var hk = tg.closest ? tg.closest('.mo-hold') : null;
      if (hk && e.button <= 0) {
        e.preventDefault();
        try { hk.setPointerCapture(e.pointerId); } catch (er) {}
        try { S.root.focus({ preventScroll: true }); } catch (er) {}
        setKey(hk.getAttribute('data-k'), 'p' + e.pointerId, true);
      }
    });
    function holdUp(e) {
      if (!S || !S.sd) return;
      var hk = e.target.closest ? e.target.closest('.mo-hold') : null;
      if (hk) setKey(hk.getAttribute('data-k'), 'p' + e.pointerId, false);
    }
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.root.addEventListener(t, holdUp); });

    S.root.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || b.classList.contains('mo-key') || b.classList.contains('mo-hold')) return;
      var o = b.getAttribute('data-opt');
      if (o) {
        setOpt(o, b.getAttribute('data-v'));
        b.parentNode.querySelectorAll('.mo-opt').forEach(function (x) { var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
        sfx('tick');
        return;
      }
      var a = b.getAttribute('data-act');
      if (a) act(a, b);
      if (e.detail !== 0 && S && b.isConnected === false) { try { S.root.focus({ preventScroll: true }); } catch (er) {} }
    });
    S.root.addEventListener('input', function (e) {
      var n = e.target.getAttribute && e.target.getAttribute('data-set');
      if (n) setRange(n, e.target.value);
    });
    S.root.addEventListener('change', function (e) {
      var n = e.target.getAttribute && e.target.getAttribute('data-set');
      if (n === 'pitch' || n === 'vol') { play('E'); }
    });

    if (ld.fresh) { persist(); render(helpHtml(), 'help'); }
    else toHome();
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Learn Morse code by ear — Koch lessons, Farnsworth timing, copy, send with a key or paddles, word drills and an arcade mode',
    icon: '📡',
    tags: 'game,learning,morse,code,radio,training,cw,koch,farnsworth,ham,telegraph,keyer,paddle,callsign,arcade',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
