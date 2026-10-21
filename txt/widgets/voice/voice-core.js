/* Voice Note — the note format and the pure helpers shared by the recorder
 * (voice.js), the editor's player cards (voice-view.js) and the node tests.
 * UMD: module.exports in node, window.__cadeVoiceCore in the browser. No DOM.
 *
 * A voice note in the text is a closed fenced block:
 *
 *   ```voice 0:42 "Idea for the intro"
 *   ▁▂▅▇▆▃▂▁▃▅▇█▆▄▂▁▂▃▅▆▅▃▂▁
 *   ![file:voice-2026-10-21-1532.m4a#<hash>|s123456]
 *   ```
 *
 * Fence info: "voice", then the duration (m:ss) and an optional quoted title,
 * in any order (unknown tokens are ignored). Body: the waveform as U+2581..
 * U+2588 (8 levels, one glyph per ~0.5 s, 24..96 glyphs) and the file token
 * exactly as Cade.files.store returns it (the audio bytes live in the
 * encrypted, synced file store; the core garbage-collects them once no note
 * holds the token). With the plugin off it still reads as plain text.
 *
 * The editor's fence rule applies: any line starting with ``` opens or closes
 * a fence, and only closed ```voice blocks count. */
(function (root) {
  'use strict';

  var GLYPH0 = 0x2581, LEVELS = 8, TOP = LEVELS - 1;
  var MIN_GLYPHS = 24, MAX_GLYPHS = 96, SEC_PER_GLYPH = 0.5;
  var ENV_MS = 50;                        // one envelope sample per 50 ms of recording
  var MAX_SEC = 600, WARN_SEC = 570;      // 10 minutes, a warning at 9:30
  var ABS_FLOOR = 0.003;                  // RMS below ~-50 dBFS is silence
  var REL_FLOOR = 0.02;                   // …and so is anything 34 dB under the loudest part
  var MIMES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  var EXT = { 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
  var OPEN_RE = /^```voice(?:\s|$)/;
  var FILE_RE = /!\[file:([^\]\n#|]{1,120})#([a-f0-9]{16,64})(?:\|s(\d{1,12}))?\]/;
  var WAVE_RE = /^[▁-█]+$/;
  var DUR_RE = /^(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)$/;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ---- durations ----
  // seconds → "m:ss" ("h:mm:ss" from an hour); rounds unless floor is set.
  function fmtDuration(sec, floor) {
    sec = +sec;
    if (!(sec > 0) || !isFinite(sec)) sec = 0;
    var s = floor ? Math.floor(sec) : Math.round(sec), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    s %= 60;
    return h ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }
  // "0:42" / "12:05" / "1:02:03" → seconds, else null.
  function parseDuration(t) {
    var m = DUR_RE.exec(String(t == null ? '' : t).trim());
    if (!m) return null;
    var h = m[1] ? +m[1] : 0, min = +m[2];
    if (m[1] && min > 59) return null;
    return h * 3600 + min * 60 + +m[3];
  }

  // ---- fence info ----
  function cleanTitle(s) {
    return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/[`"]/g, '\'').replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  // 'voice 0:42 "Title"' (the text after ```) → { dur, durText, title }, or null if it isn't a voice note.
  function parseInfo(info) {
    var s = String(info == null ? '' : info), re = /"([^"]*)"?|(\S+)/g, m, first = true;
    var o = { dur: null, durText: '', title: '' };
    while ((m = re.exec(s))) {
      if (first) { if (m[2] !== 'voice') return null; first = false; continue; }
      if (m[1] != null) { if (!o.title) o.title = cleanTitle(m[1]); continue; }
      if (o.dur == null) { var d = parseDuration(m[2]); if (d != null) { o.dur = d; o.durText = m[2]; } }
    }
    return first ? null : o;
  }
  function formatInfo(dur, title) {
    var t = cleanTitle(title);
    return 'voice ' + fmtDuration(dur) + (t ? ' "' + t + '"' : '');
  }

  // ---- waveform glyphs ----
  function levelsToGlyphs(levels) {
    var s = '';
    for (var i = 0; i < (levels || []).length; i++) s += String.fromCharCode(GLYPH0 + clamp(Math.round(+levels[i] || 0), 0, TOP));
    return s;
  }
  // Any string → levels; characters that aren't wave glyphs are skipped.
  function glyphsToLevels(str) {
    var out = [];
    str = String(str == null ? '' : str);
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i) - GLYPH0;
      if (c >= 0 && c < LEVELS) out.push(c);
    }
    return out;
  }
  function isWaveLine(t) { return WAVE_RE.test(String(t == null ? '' : t).trim()); }
  // How many glyphs a recording of `sec` seconds gets.
  function glyphCount(sec) { return clamp(Math.round((+sec || 0) / SEC_PER_GLYPH), MIN_GLYPHS, MAX_GLYPHS); }

  // ---- the block ----
  // A fenced block's text → { dur, durText, title, wave, levels, token, name, hash, size, closed }, or null.
  function parseBlock(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    if (!OPEN_RE.test(lines[0])) return null;
    var info = parseInfo(lines[0].slice(3));
    if (!info) return null;
    var end = lines.length;
    for (var i = 1; i < lines.length; i++) if (lines[i].lastIndexOf('```', 0) === 0) { end = i; break; }
    var wave = '', tok = null;
    for (i = 1; i < end; i++) {
      var t = lines[i].trim();
      if (!wave && isWaveLine(t)) { wave = t; continue; }
      if (!tok) { var m = FILE_RE.exec(lines[i]); if (m) tok = m; }
    }
    return {
      dur: info.dur, durText: info.durText, title: info.title, wave: wave, levels: glyphsToLevels(wave),
      token: tok ? tok[0] : '', name: tok ? tok[1] : '', hash: tok ? tok[2] : '', size: tok && tok[3] ? +tok[3] : null,
      closed: end < lines.length
    };
  }
  // { dur, title, levels | wave, token } → the fenced block (no trailing newline).
  function formatBlock(v) {
    var wave = v.levels ? levelsToGlyphs(v.levels) : String(v.wave || '').trim();
    if (!wave) for (var i = glyphCount(v.dur); i > 0; i--) wave += String.fromCharCode(GLYPH0);
    return '```' + formatInfo(v.dur, v.title) + '\n' + wave + '\n' + String(v.token || '').trim() + '\n```';
  }
  // Every closed ```voice block → [{ line (1-based), from, to, text, voice }].
  function findBlocks(text) {
    var out = [];
    text = String(text == null ? '' : text);
    if (text.indexOf('```voice') < 0) return out;
    var lines = text.split('\n'), pos = 0, open = -1, openLine = 0, isV = false;
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i], from = pos;
      pos += t.length + 1;
      if (t.charCodeAt(0) !== 96 || t.lastIndexOf('```', 0) !== 0) continue;
      if (open < 0) { open = from; openLine = i; isV = OPEN_RE.test(t); }
      else {
        if (isV) {
          var blk = text.slice(open, from + t.replace(/\r$/, '').length);
          out.push({ line: openLine + 1, from: open, to: from + t.length, text: blk, voice: parseBlock(blk) });
        }
        open = -1;
      }
    }
    return out;
  }

  // ---- the envelope (RMS of the mic signal, one value per ENV_MS) ----
  function rms(buf) {
    var n = buf ? buf.length : 0, s = 0;
    for (var i = 0; i < n; i++) s += buf[i] * buf[i];
    return n ? Math.sqrt(s / n) : 0;
  }
  // Keep env at one sample per ENV_MS of recorded time: append v until it
  // covers elapsedMs (a frame that came late — a hidden tab — fills the gap).
  function envPush(env, elapsedMs, v) {
    var want = Math.floor(Math.max(0, elapsedMs) / ENV_MS);
    if (env.length > want) return env;
    var gap = want - env.length;
    while (env.length < want) env.push(gap > 40 ? 0 : v);  // a long gap: the frames stopped, don't invent sound
    env.push(v);
    return env;
  }
  // RMS envelope → n levels 0..7: RMS per bucket, then sqrt (perceived
  // loudness grows much slower than amplitude) of the share of the loudest
  // bucket; buckets under the quiet floor are ▁.
  function downsample(env, n) {
    n = Math.max(1, Math.round(n) || 1);
    var L = env ? env.length : 0, b = new Array(n), out = new Array(n), vmax = 0, i, j;
    for (i = 0; i < n; i++) {
      var a = Math.floor(i * L / n), z = Math.max(a + 1, Math.floor((i + 1) * L / n)), s = 0, c = 0;
      for (j = a; j < z && j < L; j++) { var v = +env[j] || 0; s += v * v; c++; }
      b[i] = c ? Math.sqrt(s / c) : 0;
      if (b[i] > vmax) vmax = b[i];
    }
    var floor = Math.max(ABS_FLOOR, vmax * REL_FLOOR);
    for (i = 0; i < n; i++) out[i] = vmax < ABS_FLOOR || b[i] < floor ? 0 : clamp(Math.round(Math.sqrt(b[i] / vmax) * TOP), 0, TOP);
    return out;
  }
  function waveFor(env, sec) { return downsample(env, glyphCount(sec)); }

  // ---- files ----
  function baseMime(m) { return String(m == null ? '' : m).split(';')[0].trim().toLowerCase(); }
  function extOf(mime) {
    var b = baseMime(mime), m = /^audio\/([a-z0-9]{2,8})$/.exec(b);
    return EXT[b] || (m ? m[1] : 'webm');
  }
  function fileName(date, mime) {
    var d = date instanceof Date && !isNaN(date) ? date : new Date();
    return 'voice-' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + '.' + extOf(mime);
  }
  // "voice-2026-10-21-1532.m4a" → a Date (local time), else null.
  function dateOf(name) {
    var m = /voice-(\d{4})-(\d\d)-(\d\d)-(\d\d)(\d\d)/.exec(String(name || ''));
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    return isNaN(d) || d.getMonth() !== +m[2] - 1 ? null : d;
  }
  // The recorder's format: the first of MIMES the browser can record, else '' (its default).
  function pickMime(isSupported) {
    for (var i = 0; i < MIMES.length; i++) { try { if (isSupported(MIMES[i])) return MIMES[i]; } catch (e) {} }
    return '';
  }

  // ---- drawing (any 2D context; sizes in device pixels) ----
  // Bars centred on the middle line, ▁ as a short stub; the part before
  // `progress` (0..1) in o.played, the rest in o.rest.
  function waveBars(levels, w, h, o) {
    o = o || {};
    var n = levels.length, out = [];
    if (!n || !(w > 0) || !(h > 0)) return out;
    var dpr = o.dpr || 1, slot = w / n, bw = Math.max(1, Math.min(slot * 0.62, (o.maxBar || 5) * dpr));
    var hMin = Math.max(2 * dpr, h * 0.1);
    for (var i = 0; i < n; i++) {
      var bh = hMin + (h - hMin) * clamp(levels[i], 0, TOP) / TOP;
      out.push({ x: i * slot + (slot - bw) / 2, y: (h - bh) / 2, w: bw, h: bh });
    }
    return out;
  }
  function drawWave(ctx, levels, o) {
    var w = o.w, h = o.h, bars = waveBars(levels, w, h, o), p = clamp(+o.progress || 0, 0, 1);
    ctx.clearRect(0, 0, w, h);
    function paint(color) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (var i = 0; i < bars.length; i++) {
        var b = bars[i], r = Math.min(b.w / 2, b.h / 2);
        if (ctx.roundRect) ctx.roundRect(b.x, b.y, b.w, b.h, r); else ctx.rect(b.x, b.y, b.w, b.h);
      }
      ctx.fill();
    }
    paint(o.rest);
    if (p > 0) {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, w * p, h); ctx.clip();
      paint(o.played);
      ctx.restore();
    }
    return bars.length;
  }

  var api = {
    GLYPH0: GLYPH0, LEVELS: LEVELS, MIN_GLYPHS: MIN_GLYPHS, MAX_GLYPHS: MAX_GLYPHS, SEC_PER_GLYPH: SEC_PER_GLYPH,
    ENV_MS: ENV_MS, MAX_SEC: MAX_SEC, WARN_SEC: WARN_SEC, MIMES: MIMES, OPEN_RE: OPEN_RE, FILE_RE: FILE_RE,
    fmtDuration: fmtDuration, parseDuration: parseDuration, cleanTitle: cleanTitle, parseInfo: parseInfo, formatInfo: formatInfo,
    levelsToGlyphs: levelsToGlyphs, glyphsToLevels: glyphsToLevels, isWaveLine: isWaveLine, glyphCount: glyphCount,
    parseBlock: parseBlock, formatBlock: formatBlock, findBlocks: findBlocks,
    rms: rms, envPush: envPush, downsample: downsample, waveFor: waveFor,
    baseMime: baseMime, extOf: extOf, fileName: fileName, dateOf: dateOf, pickMime: pickMime,
    waveBars: waveBars, drawWave: drawWave
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__cadeVoiceCore = api;
})(typeof self !== 'undefined' ? self : this);
