/* Checks for Voice Note: the block format (parse / format round trips), the
 * block finder's edge cases, the envelope → waveform downsampling, glyphs,
 * durations, file names, the recorder's format choice, the wave drawing, the
 * editor plugin's own scan (it must agree with the core), and that the widget
 * and plugin register as the manifest says.
 * Not loaded by the app. Run: node txt/widgets/voice/voice.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var VC = require('./voice-core.js');
var V = require('./voice-view.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

// ---- registration ----
var WIDGET_ENTRY = {
  id: 'voice', type: 'widget', name: 'Voice Note',
  description: 'Record a voice memo into your note — a player with a waveform; the audio syncs encrypted to your other devices',
  icon: '🎙',
  tags: 'voice,voice note,voice memo,memo,record,recording,recorder,audio,microphone,mic,dictaphone,speech,sound,waveform,podcast,listen',
  entry: 'widgets/voice/voice.js', css: 'widgets/voice/voice.css', precache: ['widgets/voice/voice-core.js']
};
var PLUGIN_ENTRY = {
  id: 'voice-view', type: 'plugin', name: 'Voice notes in the editor',
  description: 'Play ```voice blocks (made with Voice Note) as a card with a waveform — tap to seek, change the speed, download; ✎ shows its text',
  entry: 'widgets/voice/voice-view.js', css: 'widgets/voice/voice-view.css', precache: ['widgets/voice/voice-core.js'],
  settingKey: 'plugins.voice-view', section: 'Editor', default: true
};
function manifestEntry(id) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === id; })[0] || null; } catch (e) { return null; }
}
test('widget registers with the manifest entry\'s name, description, icon and tags', function () {
  var live = manifestEntry('voice'), reg = null, css = [];
  var src = fs.readFileSync(path.join(__dirname, 'voice.js'), 'utf8');
  new Function('window', 'module', src)({ Cade: { loadCSS: function (p) { css.push(p); }, asset: function (p) { return './txt/widgets/voice/' + p; }, registerWidget: function (o) { reg = o; }, escapeHtml: String } }, undefined);
  assert.ok(reg, 'registered');
  [WIDGET_ENTRY].concat(live ? [live] : []).forEach(function (entry) {
    ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(reg[k], entry[k], k); });
    assert.strictEqual(entry.entry, 'widgets/voice/voice.js');
    assert.strictEqual(entry.css, 'widgets/voice/voice.css');
    entry.precache.forEach(function (f) { assert.ok(fs.existsSync(path.join(__dirname, '..', '..', f)), f); });
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', entry.css)));
  });
  assert.strictEqual(typeof reg.open, 'function');
  assert.deepStrictEqual(css, ['voice.css']);
});
test('editor plugin registers its StateField + lifetime ViewPlugin under the manifest id (and loads its css)', function () {
  var live = manifestEntry('voice-view');
  [PLUGIN_ENTRY].concat(live ? [live] : []).forEach(function (e) {
    assert.strictEqual(e.id, 'voice-view'); assert.strictEqual(e.type, 'plugin');
    assert.strictEqual(e.settingKey, 'plugins.voice-view'); assert.strictEqual(e.default, true); assert.strictEqual(e.section, 'Editor');
    [e.entry, e.css].concat(e.precache).forEach(function (f) { assert.ok(fs.existsSync(path.join(__dirname, '..', '..', f)), f); });
  });
  var reg = null, css = [], field = null, vp = null, keys = null;
  function WT() {}
  var CM = {
    StateField: { define: function (spec) { field = spec; return { field: true }; } },
    StateEffect: { define: function () { return { of: function (v) { return { value: v }; } }; } },
    EditorState: { transactionFilter: { of: function (fn) { return { filter: fn }; } } },
    ViewPlugin: { define: function (fn) { vp = fn; return { viewPlugin: true }; } },
    Prec: { high: function (x) { return { high: x }; } }, keymap: { of: function (k) { keys = k; return { keymap: k }; } },
    Decoration: { none: { size: 0 }, line: function () { return { range: function () {} }; }, replace: function () { return { range: function () {} }; }, set: function () {} },
    WidgetType: WT, EditorView: { decorations: { from: function () { return { deco: true }; } }, atomicRanges: { of: function () { return { atomic: true }; } } }
  };
  var src = fs.readFileSync(path.join(__dirname, 'voice-view.js'), 'utf8');
  var added = [], removed = [];
  var win = { Cade: { CM: CM, loadCSS: function (p) { css.push(p); }, asset: function (p) { return p; }, registerPlugin: function (o) { reg = o; } },
    addEventListener: function (t) { added.push(t); }, removeEventListener: function (t) { removed.push(t); } };
  new Function('window', 'module', src)(win, undefined);
  assert.ok(reg && reg.id === 'voice-view' && Array.isArray(reg.ext), 'registered');
  assert.ok(reg.ext[0].field && typeof reg.ext[1].filter === 'function' && reg.ext[2].high.keymap && reg.ext[3].viewPlugin, 'field, edge guard, Escape, lifetime');
  assert.ok(field && typeof field.create === 'function' && typeof field.update === 'function' && typeof field.provide === 'function');
  var provided = field.provide({});
  assert.ok(provided[0].deco && provided[1].atomic, 'cards are decorations and atomic ranges');
  assert.strictEqual(keys[0].key, 'Escape');
  assert.deepStrictEqual(css, ['voice-view.css']);
  assert.deepStrictEqual(added, [], 'nothing listens before the plugin is live');
  var inst = vp({});
  assert.deepStrictEqual(added, ['cade-voice-play']);
  inst.destroy();
  assert.deepStrictEqual(removed, ['cade-voice-play'], 'destroy removes what the plugin added');
});

// ---- the format ----
var TOKEN = '![file:voice-2026-10-21-1532.m4a#0123456789abcdef0123456789abcdef|s123456]';
var EXAMPLE = '```voice 0:42 "Idea for the intro"\n▁▂▅▇▆▃▂▁▃▅▇█▆▄▂▁▂▃▅▆▅▃▂▁\n' + TOKEN + '\n```';
test('the documented example parses', function () {
  var v = VC.parseBlock(EXAMPLE);
  assert.strictEqual(v.dur, 42); assert.strictEqual(v.durText, '0:42'); assert.strictEqual(v.title, 'Idea for the intro');
  assert.strictEqual(v.levels.length, 24);
  assert.deepStrictEqual(v.levels.slice(0, 5), [0, 1, 4, 6, 5]);
  assert.strictEqual(v.levels[11], 7);
  assert.strictEqual(v.token, TOKEN); assert.strictEqual(v.name, 'voice-2026-10-21-1532.m4a');
  assert.strictEqual(v.hash, '0123456789abcdef0123456789abcdef'); assert.strictEqual(v.size, 123456);
  assert.strictEqual(v.closed, true);
});
test('format → parse → format is stable; parse → format gives the same text', function () {
  var levels = [0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0, 0, 3, 5, 7, 2, 1, 0, 0];
  var t = VC.formatBlock({ dur: 42.4, title: 'Idea for the intro', levels: levels, token: TOKEN });
  assert.strictEqual(t.split('\n').length, 4);
  assert.ok(/^```voice 0:42 "Idea for the intro"\n[▁-█]{24}\n!\[file:/.test(t), t);
  var v = VC.parseBlock(t);
  assert.deepStrictEqual(v.levels, levels);
  assert.strictEqual(VC.formatBlock({ dur: v.dur, title: v.title, wave: v.wave, token: v.token }), t);
  assert.strictEqual(VC.formatBlock({ dur: v.dur, title: v.title, levels: v.levels, token: v.token }), t);
  assert.strictEqual(VC.formatBlock(VC.parseBlock(EXAMPLE)), EXAMPLE, 'the example round-trips');
  // no title → no quotes; no levels → a flat line of the right length
  var u = VC.formatBlock({ dur: 3, token: TOKEN });
  assert.strictEqual(u.split('\n')[0], '```voice 0:03');
  assert.strictEqual(u.split('\n')[1], new Array(25).join('▁'));
});
test('fence info: any order, unknown tokens ignored, titles cleaned', function () {
  assert.deepStrictEqual(VC.parseInfo('voice "Hi there" 1:05 mono x=3'), { dur: 65, durText: '1:05', title: 'Hi there' });
  assert.deepStrictEqual(VC.parseInfo('voice'), { dur: null, durText: '', title: '' });
  assert.deepStrictEqual(VC.parseInfo('voice 0:07 0:09 "a" "b"'), { dur: 7, durText: '0:07', title: 'a' }, 'the first of each');
  assert.strictEqual(VC.parseInfo('voice "unclosed title').title, 'unclosed title');
  assert.strictEqual(VC.parseInfo('voice 1:02:03').dur, 3723);
  assert.strictEqual(VC.parseInfo('voice 0:60').dur, null, 'seconds over 59 are no duration');
  assert.strictEqual(VC.parseInfo('voice 1:75:00').dur, null);
  assert.strictEqual(VC.parseInfo('voices 0:42'), null);
  assert.strictEqual(VC.parseInfo('js'), null);
  assert.strictEqual(VC.parseInfo(''), null);
  assert.strictEqual(VC.cleanTitle(' a\n"b"\t`c`  '), 'a \'b\' \'c\'');
  assert.strictEqual(VC.cleanTitle(new Array(200).join('x')).length, 80);
  assert.strictEqual(VC.formatInfo(5, 'say "hi"'), 'voice 0:05 "say \'hi\'"');
  // a title with a quote in it survives the round trip (as an apostrophe)
  assert.strictEqual(VC.parseBlock('```' + VC.formatInfo(5, 'say "hi"') + '\n' + TOKEN + '\n```').title, 'say \'hi\'');
});
test('parseBlock: lenient body, missing pieces, not a voice block', function () {
  var v = VC.parseBlock('```voice "x" 0:05\n  ' + TOKEN + '  \n  ▁█  \nnoise\n```');
  assert.deepStrictEqual(v.levels, [0, 7], 'wave and token in any order, trimmed');
  assert.strictEqual(v.hash, '0123456789abcdef0123456789abcdef');
  var n = VC.parseBlock('```voice 0:05\n```');
  assert.deepStrictEqual([n.levels, n.token, n.hash, n.size], [[], '', '', null]);
  assert.strictEqual(VC.parseBlock('```voice 0:05\n▁▁ x\n```').levels.length, 0, 'a line with other text is not the wave');
  assert.strictEqual(VC.parseBlock('```js\nx\n```'), null);
  assert.strictEqual(VC.parseBlock('no fence'), null);
  assert.strictEqual(VC.parseBlock(EXAMPLE.slice(0, -4)).closed, false);
  assert.strictEqual(VC.parseBlock(EXAMPLE.replace(/\n/g, '\r\n')).token, TOKEN, 'CRLF');
  assert.strictEqual(VC.parseBlock(EXAMPLE.replace('|s123456', '')).size, null);
});

// ---- the finder ----
test('findBlocks: closed blocks only, other languages skipped, positions exact', function () {
  var note = 'intro\n```js\nlet a = "```voice"\n```\n' + EXAMPLE + '\nmid\n' + EXAMPLE + '\n```voice 0:01\nunclosed';
  var b = VC.findBlocks(note);
  assert.strictEqual(b.length, 2);
  assert.strictEqual(b[0].line, 5); assert.strictEqual(b[1].line, 10);
  b.forEach(function (x) { assert.strictEqual(note.slice(x.from, x.to), EXAMPLE); assert.strictEqual(x.text, EXAMPLE); assert.strictEqual(x.voice.dur, 42); });
  assert.deepStrictEqual(VC.findBlocks('nothing here'), []);
  assert.deepStrictEqual(VC.findBlocks('```voiceover 0:42\nx\n```'), [], 'another language');
  assert.deepStrictEqual(VC.findBlocks('```voice 0:42\nx'), [], 'unclosed');
  assert.strictEqual(VC.findBlocks('```voice\n```').length, 1, 'bare "voice" counts (the plugin needs a token to draw it)');
  // a ```voice line that closes another fence is a closing fence, not an opener
  assert.deepStrictEqual(VC.findBlocks('```md\ntext\n```voice 0:01\n' + TOKEN + '\n```'), []);
  // indented fences aren't fences in the editor's rule
  assert.deepStrictEqual(VC.findBlocks(' ```voice 0:01\n' + TOKEN + '\n ```'), []);
  assert.deepStrictEqual(VC.findBlocks(null), []);
});
test('findBlocks: CRLF text keeps positions in the original string', function () {
  var note = 'a\r\n' + EXAMPLE.replace(/\n/g, '\r\n') + '\r\nb';
  var b = VC.findBlocks(note);
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].from, 3);
  assert.strictEqual(note.slice(b[0].from, b[0].to), EXAMPLE.replace(/\n/g, '\r\n') + '\r', 'to is the end of the closing fence line');
  assert.ok(!/\r$/.test(b[0].text));
  assert.strictEqual(b[0].voice.title, 'Idea for the intro');
  assert.strictEqual(b[0].voice.token, TOKEN);
});

// ---- waveform ----
test('glyphs ↔ levels', function () {
  assert.strictEqual(VC.levelsToGlyphs([0, 1, 2, 3, 4, 5, 6, 7]), '▁▂▃▄▅▆▇█');
  assert.deepStrictEqual(VC.glyphsToLevels('▁▂▃▄▅▆▇█'), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.strictEqual(VC.levelsToGlyphs([-3, 9, 2.6, NaN]), '▁█▄▁', 'clamped and rounded');
  assert.deepStrictEqual(VC.glyphsToLevels('a█ ▀▉▁'), [7, 0], 'U+2580 / U+2589 are not wave glyphs');
  assert.ok(VC.isWaveLine(' ▁█ ') && !VC.isWaveLine('') && !VC.isWaveLine('▁ █'));
  for (var i = 0; i < 50; i++) {
    var lv = []; for (var j = 0; j < 30; j++) lv.push(Math.floor(Math.random() * 8));
    assert.deepStrictEqual(VC.glyphsToLevels(VC.levelsToGlyphs(lv)), lv);
  }
});
test('glyph count: one per ~0.5 s, 24..96', function () {
  assert.strictEqual(VC.glyphCount(0), 24);
  assert.strictEqual(VC.glyphCount(3), 24);
  assert.strictEqual(VC.glyphCount(12), 24);
  assert.strictEqual(VC.glyphCount(30), 60);
  assert.strictEqual(VC.glyphCount(42), 84);
  assert.strictEqual(VC.glyphCount(48), 96);
  assert.strictEqual(VC.glyphCount(600), 96);
});
test('downsample: silence is all ▁, whatever the length', function () {
  [0, 1, 10, 200].forEach(function (L) {
    var env = []; for (var i = 0; i < L; i++) env.push(0);
    assert.deepStrictEqual(VC.downsample(env, 24), new Array(24).fill(0), 'zeros ' + L);
  });
  var hiss = []; for (var i = 0; i < 300; i++) hiss.push(0.001 + (i % 3) * 0.0005);
  assert.deepStrictEqual(VC.downsample(hiss, 30), new Array(30).fill(0), 'room hiss under the floor');
  assert.deepStrictEqual(VC.downsample(null, 5), [0, 0, 0, 0, 0]);
});
test('downsample: a single spike is one █ at its place, the rest ▁', function () {
  var env = new Array(240).fill(0);
  env[123] = 0.4;
  var lv = VC.downsample(env, 24);
  assert.strictEqual(lv.length, 24);
  assert.strictEqual(lv[12], 7, 'sample 123 of 240 is in bucket 12');
  assert.strictEqual(lv.filter(function (x) { return x; }).length, 1);
  // the same spike over quiet speech-level noise still tops out, the noise stays low
  var env2 = env.map(function (v, i) { return v || (i % 2 ? 0.01 : 0.012); });
  var lv2 = VC.downsample(env2, 24);
  assert.strictEqual(lv2[12], 7);
  assert.ok(Math.max.apply(null, lv2.filter(function (x, i) { return i !== 12; })) <= 3, lv2.join(''));
});
test('downsample: a ramp rises steadily from ▁ to █ (sqrt: perceived loudness)', function () {
  var env = []; for (var i = 0; i < 480; i++) env.push(i / 479 * 0.5);
  var lv = VC.downsample(env, 48);
  assert.strictEqual(lv.length, 48);
  assert.strictEqual(lv[0], 0); assert.strictEqual(lv[47], 7);
  for (i = 1; i < lv.length; i++) assert.ok(lv[i] >= lv[i - 1], 'non-decreasing at ' + i + ': ' + lv.join(''));
  // sqrt scaling: half the loudest amplitude reads well above half height
  var mid = VC.downsample([0.25, 1], 2);
  assert.deepStrictEqual(mid, [Math.round(Math.sqrt(0.25) * 7), 7]);
  // loudness is relative: the same shape at a tenth of the level draws the same
  assert.deepStrictEqual(VC.downsample(env.map(function (v) { return v / 10; }), 48).slice(10), lv.slice(10));
});
test('downsample: lengths — fewer samples than glyphs, more, exact', function () {
  assert.deepStrictEqual(VC.downsample([0.1, 0.5], 4), [3, 3, 7, 7], 'fewer samples than glyphs: each sample stretched (sqrt(0.1 / 0.5) × 7 ≈ 3)');
  assert.strictEqual(VC.downsample(new Array(1000).fill(0.2), 96).length, 96);
  assert.deepStrictEqual(VC.downsample(new Array(1000).fill(0.2), 96), new Array(96).fill(7), 'steady sound: full bars');
  assert.strictEqual(VC.downsample([0.3, 0.3, 0.3], 3).length, 3);
  assert.strictEqual(VC.downsample([0.3], 0).length, 1);
  assert.strictEqual(VC.waveFor(new Array(60).fill(0.1), 3).length, 24);
  assert.strictEqual(VC.waveFor(new Array(12000).fill(0.1), 600).length, 96);
});
test('envelope: one RMS sample per 50 ms of recording, gaps filled', function () {
  assert.strictEqual(VC.rms(new Float32Array([0.5, -0.5, 0.5, -0.5])), 0.5);
  assert.strictEqual(VC.rms([]), 0);
  var env = [];
  [0, 16, 33, 50, 66, 120, 140, 260].forEach(function (t, i) { VC.envPush(env, t, i + 1); });
  assert.deepStrictEqual(env, [1, 4, 6, 8, 8, 8], 'the first frame of each 50 ms; a late frame fills the slots it missed');
  // a frame after a long pause in the frames (a hidden tab): zeros, not made-up sound
  VC.envPush(env, 5000, 0.9);
  assert.strictEqual(env.length, 101);
  assert.strictEqual(env[50], 0); assert.strictEqual(env[100], 0.9);
  VC.envPush(env, 4000, 0.5);
  assert.strictEqual(env.length, 101, 'time never runs backwards');
});

// ---- time, files, format choice ----
test('durations', function () {
  assert.strictEqual(VC.fmtDuration(0), '0:00');
  assert.strictEqual(VC.fmtDuration(42.4), '0:42');
  assert.strictEqual(VC.fmtDuration(42.6), '0:43');
  assert.strictEqual(VC.fmtDuration(42.6, true), '0:42');
  assert.strictEqual(VC.fmtDuration(600), '10:00');
  assert.strictEqual(VC.fmtDuration(3723), '1:02:03');
  assert.strictEqual(VC.fmtDuration(-5), '0:00'); assert.strictEqual(VC.fmtDuration(Infinity), '0:00'); assert.strictEqual(VC.fmtDuration(NaN), '0:00');
  ['0:00', '0:42', '9:30', '10:00', '1:02:03'].forEach(function (t) { assert.strictEqual(VC.fmtDuration(VC.parseDuration(t)), t); });
  assert.strictEqual(VC.parseDuration('42'), null); assert.strictEqual(VC.parseDuration('0:4'), null); assert.strictEqual(VC.parseDuration(null), null);
  assert.strictEqual(V.fmt(65.9), '1:05'); assert.strictEqual(V.fmt(3723), '1:02:03'); assert.strictEqual(V.fmt(-1), '0:00');
  assert.deepStrictEqual([V.nextRate(1), V.nextRate(1.5), V.nextRate(2)], [1.5, 2, 1]);
  assert.strictEqual(VC.MAX_SEC, 600); assert.strictEqual(VC.WARN_SEC, 570);
});
test('file names from the date and the recorder format', function () {
  var d = new Date(2026, 9, 21, 15, 32);
  assert.strictEqual(VC.fileName(d, 'audio/mp4;codecs=mp4a.40.2'), 'voice-2026-10-21-1532.m4a');
  assert.strictEqual(VC.fileName(d, 'audio/mp4'), 'voice-2026-10-21-1532.m4a');
  assert.strictEqual(VC.fileName(d, 'audio/webm;codecs=opus'), 'voice-2026-10-21-1532.webm');
  assert.strictEqual(VC.fileName(d, 'audio/ogg; codecs=opus'), 'voice-2026-10-21-1532.ogg');
  assert.strictEqual(VC.fileName(new Date(2026, 0, 5, 7, 4), 'AUDIO/WEBM'), 'voice-2026-01-05-0704.webm');
  assert.strictEqual(VC.extOf(''), 'webm'); assert.strictEqual(VC.extOf('audio/flac'), 'flac');
  assert.strictEqual(+VC.dateOf('voice-2026-10-21-1532.m4a'), +d);
  assert.strictEqual(VC.dateOf('voice-2026-13-21-1532.m4a'), null); assert.strictEqual(VC.dateOf('memo.m4a'), null);
  assert.ok(VC.FILE_RE.test('![file:' + VC.fileName(d, 'audio/mp4') + '#0123456789abcdef|s9]'), 'a valid token name');
});
test('recorder format: the first the browser can record, AAC first', function () {
  assert.strictEqual(VC.pickMime(function () { return true; }), 'audio/mp4;codecs=mp4a.40.2');
  assert.strictEqual(VC.pickMime(function (t) { return t === 'audio/mp4' || /webm/.test(t); }), 'audio/mp4');
  assert.strictEqual(VC.pickMime(function (t) { return /webm/.test(t); }), 'audio/webm;codecs=opus');
  assert.strictEqual(VC.pickMime(function (t) { return t === 'audio/webm'; }), 'audio/webm');
  assert.strictEqual(VC.pickMime(function () { return false; }), '');
  assert.strictEqual(VC.pickMime(function () { throw new Error('x'); }), '');
});
test('drawing: one bar per level, centred; the played part is clipped over the rest', function () {
  var calls = [];
  var ctx = {
    clearRect: function () { calls.push('clear'); }, beginPath: function () { calls.push('begin'); }, fill: function () { calls.push('fill:' + this.fillStyle); },
    rect: function (x, y, w, h) { calls.push(['rect', x, y, w, h]); }, clip: function () { calls.push('clip'); }, save: function () { calls.push('save'); }, restore: function () { calls.push('restore'); }
  };
  var lv = [0, 7, 3, 7];
  assert.strictEqual(VC.drawWave(ctx, lv, { w: 400, h: 80, dpr: 2, progress: 0, played: 'P', rest: 'R' }), 4);
  assert.deepStrictEqual(calls.filter(function (c) { return typeof c === 'string' && /fill|clip/.test(c); }), ['fill:R'], 'nothing played yet');
  calls = [];
  VC.drawWave(ctx, lv, { w: 400, h: 80, dpr: 2, progress: 0.5, played: 'P', rest: 'R' });
  assert.deepStrictEqual(calls.filter(function (c) { return typeof c === 'string' && /fill|clip/.test(c); }), ['fill:R', 'clip', 'fill:P']);
  assert.ok(calls.some(function (c) { return Array.isArray(c) && c[0] === 'rect' && c[3] === 200 && c[4] === 80; }), 'clip to the first half');
  var bars = VC.waveBars(lv, 400, 80, { dpr: 2 });
  assert.strictEqual(bars[1].h, 80); assert.strictEqual(bars[1].y, 0);
  assert.ok(bars[0].h >= 4 && bars[0].h < 10, 'a silent bar is a stub');
  bars.forEach(function (b) { assert.ok(Math.abs(b.y + b.h / 2 - 40) < 1e-9, 'centred'); assert.ok(b.w <= 10, 'thin bars'); });
  assert.ok(bars[2].x > bars[1].x && bars[3].x + bars[3].w <= 400);
  assert.deepStrictEqual(VC.waveBars([], 100, 10), []);
});

// ---- editor plugin: the block finder ----
function Doc(text) {
  var ls = text.split('\n'), st = [], p = 0;
  for (var i = 0; i < ls.length; i++) { st.push(p); p += ls[i].length + 1; }
  this.length = text.length; this.lines = ls.length;
  this.line = function (n) { return { number: n, from: st[n - 1], to: st[n - 1] + ls[n - 1].length, text: ls[n - 1] }; };
  this.lineAt = function (pos) { var lo = 0, hi = st.length - 1; while (lo < hi) { var m = (lo + hi + 1) >> 1; if (st[m] <= pos) lo = m; else hi = m - 1; } return this.line(lo + 1); };
  this.sliceString = function (a, b) { return text.slice(a, b); };
  this.iterLines = function () { var i = -1; return { done: false, value: '', next: function () { i++; this.done = i >= ls.length; this.value = this.done ? '' : ls[i]; return this; } }; };
}
test('view: scan finds the same blocks as the core, with the facts the card needs', function () {
  var other = VC.formatBlock({ dur: 7, title: '', levels: [1, 2, 3], token: TOKEN.replace('0123', 'ffff') });
  var note = 'intro\n```py\nprint(1)\n```\n' + EXAMPLE + '\nmid\n' + other + '\n```voice 0:01\nno token\n```\n```voice 0:02\n...';
  var sc = V.scan(new Doc(note)), core = VC.findBlocks(note);
  assert.strictEqual(sc.n, 4, 'four ```voice lines'); assert.strictEqual(sc.blocks.length, 3);
  sc.blocks.forEach(function (b, i) {
    var v = core[i].voice;
    assert.strictEqual(b.from, core[i].from); assert.strictEqual(b.to, core[i].to); assert.strictEqual(b.text, core[i].text);
    assert.deepStrictEqual([b.dur, b.title, b.ok, b.fh, b.name, b.size], [v.dur || 0, v.title, !!v.hash, v.hash, v.name, v.size]);
  });
  assert.strictEqual(sc.blocks[2].ok, false, 'no token: shown as text');
  assert.notStrictEqual(sc.blocks[0].h, sc.blocks[1].h);
  assert.strictEqual(V.scan(new Doc(EXAMPLE + '\n' + EXAMPLE)).blocks[1].h, V.scan(new Doc(EXAMPLE)).blocks[0].h, 'same content, same hash');
  assert.deepStrictEqual(V.scan(new Doc('plain\ntext\n```js\n```')), { n: 0, blocks: [] });
});
test('view: its fence-line reader agrees with the core', function () {
  ['voice 0:42 "Idea for the intro"', 'voice "x" 1:05', 'voice', 'voice 0:60 "y"', 'voice 1:02:03', 'voice 1:75:00 0:05', 'voice x"y" 0:42', 'voice "a\tb" "c"',
    'voice "un closed', 'voice 0:01 0:02', 'voice "say `hi`" 2:00', 'voice  \t 3:07'].forEach(function (info) {
    var c = VC.parseInfo(info), h = V.head('```' + info);
    assert.deepStrictEqual(h, { dur: c.dur || 0, title: c.title }, info);
  });
});
test('view: a card opens (raw text) only after ✎, and only while a selection end stays inside it', function () {
  var blocks = [{ from: 10, to: 50 }, { from: 60, to: 90 }];
  function sel(pairs) { return { ranges: pairs.map(function (p) { return { anchor: p[0], head: p[1] }; }) }; }
  // not opened: a caret inside or next to a card leaves it a card
  assert.strictEqual(V.openKey(sel([[0, 0]]), blocks, -1), '00');
  assert.strictEqual(V.openKey(sel([[10, 10]]), blocks, -1), '00');
  assert.strictEqual(V.openKey(sel([[30, 30]]), blocks, -1), '00');
  assert.strictEqual(V.openKey(sel([[0, 70]]), blocks, -1), '00');
  // opened with ✎ (edit = its from)
  assert.strictEqual(V.openKey(sel([[30, 30]]), blocks, 10), '10');
  assert.strictEqual(V.openKey(sel([[50, 50]]), blocks, 10), '10');
  assert.strictEqual(V.openKey(sel([[51, 51]]), blocks, 10), '00', 'the selection left it');
  assert.strictEqual(V.openKey(sel([[0, 100]]), blocks, 10), '00', 'select-all keeps the cards');
  assert.strictEqual(V.openKey(sel([[65, 65]]), blocks, 10), '00', 'a caret in another card doesn\u2019t open that one');
  assert.strictEqual(V.openKey(sel([[0, 0], [65, 65]]), blocks, 60), '01');
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'voice: ' + passed + ' passed');
