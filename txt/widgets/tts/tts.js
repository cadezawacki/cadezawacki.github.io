/* Read Aloud — text-to-speech mini player for the editor.
 *
 * WHAT: reads the selection, from the cursor to the end, or the whole note,
 * sentence by sentence, with play/pause/stop, previous/next sentence, speed,
 * pitch and a voice picker. The sentence being read (and, when the engine
 * reports word boundaries, the current word) is highlighted in the editor.
 *
 * TEXT: Markdown is stripped before speaking (heading/list/quote markers,
 * emphasis, inline code ticks, highlight sentinels, links -> link text, bare
 * URLs -> their host name); images and file attachments are skipped and a
 * fenced code block is announced as "Code block." Every spoken character keeps
 * its document offset, so highlights land exactly on the source text. Text is
 * chunked per sentence (and long sentences at clause breaks), which also dodges
 * Chrome's habit of cutting off utterances after ~15 s.
 *
 * ENGINES:
 *  - Standard (default): the browser's speechSynthesis. Voices are ranked by
 *    quality markers in their names ("Natural", "Neural", "Premium",
 *    "Enhanced", "Siri", "Google", "Online") and by language match; Edge's
 *    "Online (Natural)" and Chrome's "Google" voices stream from the network
 *    (marked with a cloud). Pause is implemented as cancel + resume-from-word,
 *    because native pause()/resume() is broken on Android and with Chrome's
 *    network voices.
 *  - HD (opt-in, one-time ~66 MB download, then offline): Piper neural TTS in
 *    a Web Worker (see tts-worker.js), played gaplessly through Web Audio with
 *    the next sentences synthesized ahead. Falls back to Standard with a toast
 *    when it can't load (no WebAssembly / module workers, offline before the
 *    first download, …).
 *
 * HIGHLIGHT: a tiny ViewPlugin (registered through Cade.registerPlugin only
 * while the panel is open) draws two mark decorations from module state; the
 * player nudges it with an effect-only transaction. Positions are mapped
 * through edits made while reading; a room switch just drops the highlight.
 *
 * Nothing runs until the panel opens; closing it stops speech, terminates the
 * worker, closes the AudioContext, clears the highlight and unregisters the
 * plugin. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('tts.css');
  var WORKER_URL = Cade.asset('tts-worker.js'); // resolve now, while currentScript is us
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'tts-panel';
  var PREFS_KEY = 'cade-tts-prefs';
  var HL_ID = 'tts-highlight';
  var MAX_CHUNK = 200;        // chars per utterance (Chrome cuts long ones off)
  var SCAN_LIMIT = 400000;    // doc chars processed per Play (huge notes)

  // ---- HD engine assets (pinned) ---------------------------------------------
  var HD_CACHE = 'cade-tts-hd-v1';   // must match tts-worker.js
  var ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
  var HD_RUNTIME = {
    ort: ORT + 'ort.wasm.min.mjs',
    glue: ORT + 'ort-wasm-simd-threaded.mjs',
    wasm: ORT + 'ort-wasm-simd-threaded.wasm',
    phon: 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js',
  };
  var HD_RUNTIME_SIZES = { ort: 48259, glue: 20856, wasm: 11210254, phon: 1322380 };
  var HD_RUNTIME_WIRE = 3100000; // what the brotli'd runtime actually costs to download
  var HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/c10ece1aade47bb51c153c893d14e5bf8e5b7117/';
  var HD_VOICES = [
    { id: 'en_US-lessac-medium', label: 'Lessac \u2014 US English, female', path: 'en/en_US/lessac/medium/', size: 63201294 },
    { id: 'en_US-amy-medium', label: 'Amy \u2014 US English, female', path: 'en/en_US/amy/medium/', size: 63201294 },
    { id: 'en_US-ryan-medium', label: 'Ryan \u2014 US English, male', path: 'en/en_US/ryan/medium/', size: 63201294 },
    { id: 'en_US-joe-medium', label: 'Joe \u2014 US English, male', path: 'en/en_US/joe/medium/', size: 63201294 },
    { id: 'en_GB-alba-medium', label: 'Alba \u2014 British English, female', path: 'en/en_GB/alba/medium/', size: 63201294 },
    { id: 'en_GB-northern_english_male-medium', label: 'Northern \u2014 British English, male', path: 'en/en_GB/northern_english_male/medium/', size: 63201294 },
  ];
  function hdVoice(id) {
    for (var i = 0; i < HD_VOICES.length; i++) if (HD_VOICES[i].id === id) return HD_VOICES[i];
    return HD_VOICES[0];
  }
  function hdUrls(v) {
    return {
      ort: HD_RUNTIME.ort, glue: HD_RUNTIME.glue, wasm: HD_RUNTIME.wasm, phon: HD_RUNTIME.phon,
      model: HF + v.path + v.id + '.onnx', config: HF + v.path + v.id + '.onnx.json',
    };
  }
  function mb(n) { return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB'; }

  // ---- prefs ---------------------------------------------------------------
  var prefs = { engine: 'web', voice: '', hdVoice: HD_VOICES[0].id, rate: 1, pitch: 1, scope: 'sel', settings: false };
  function loadPrefs() {
    try {
      var p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {};
      for (var k in prefs) if (p[k] !== undefined && typeof p[k] === typeof prefs[k]) prefs[k] = p[k];
    } catch (e) {}
    prefs.rate = clamp(+prefs.rate || 1, 0.5, 2);
    prefs.pitch = clamp(+prefs.pitch || 1, 0.5, 2);
    if (['sel', 'cursor', 'doc'].indexOf(prefs.scope) < 0) prefs.scope = 'sel';
    if (prefs.engine !== 'hd') prefs.engine = 'web';
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2600); } catch (e) {} }

  // ======================================================================
  // TEXT: markdown -> speakable sentences, each char mapped to a doc offset
  // ======================================================================
  var RE_FENCE = /^\s{0,3}(```|~~~)/;
  var RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
  var RE_TSEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
  var RE_SKIPLINE = /^\s*(?:\[table(?::[^\]]*)?\]|@complete)\s*$/i;
  var RE_TABLE = /^\s*\|.*\|\s*$/;
  // alignment sentinel, quote(s), heading, list marker, task box
  var RE_PREFIX = /^(\s*)(%%(?:center|right)%%\s?)?((?:>\s?)+)?(#{1,6}\s+)?((?:[-*+\u2022]|\d{1,3}[.)]|[A-Za-z][.)])\s+)?(\[[ xX]\]\s+)?/;
  var INLINE = [
    // [regex, handler(m, kill, protect), leadGroup] — applied in order on the
    // RAW line; a match starting inside already-removed or protected text is
    // ignored (leadGroup: group 1 is a boundary char, not part of the match).
    [/[\u200b-\u200f\u2060\ufeff]/g, function (m, k) { k(m.index, m.index + m[0].length); }],
    [/!\[(?:img|file):[^\]\n]*\]/g, function (m, k) { k(m.index, m.index + m[0].length); }],   // core image / attachment tokens
    [/!\[[^\]\n]*\]\([^)\n]*\)/g, function (m, k) { k(m.index, m.index + m[0].length); }],     // markdown images
    [/`([^`\n]+)`/g, function (m, k, p) { var e = m.index + m[0].length; k(m.index, m.index + 1); k(e - 1, e); p(m.index + 1, e - 1); }],
    [/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g, function (m, k) {               // [text](url) -> text
      k(m.index, m.index + 1); k(m.index + 1 + m[1].length, m.index + m[0].length);
    }],
    [/\[\[([^\]\n]+)\]\]/g, function (m, k) { var e = m.index + m[0].length; k(m.index, m.index + 2); k(e - 2, e); }],
    [/\[\^[^\]\s]+\]/g, function (m, k) { k(m.index, m.index + m[0].length); }],        // footnote refs
    [/\b(?:https?:\/\/|www\.)[^\s<>()[\]{}"']+/gi, function (m, k) {                   // bare URL -> host
      var u = m[0].replace(/[.,;:!?]+$/, ''), s = m.index, e = s + u.length;
      var hs = s + (/^https?:\/\//i.test(u) ? u.indexOf('//') + 2 : 0);
      if (/^www\./i.test(u.slice(hs - s))) hs += 4;
      var rest = u.slice(hs - s).search(/[/?#:]/);
      var he = rest < 0 ? e : hs + rest;
      k(s, hs); k(he, e);
    }],
    [/%%([^|%\n]{1,32})\|([^\n]+?)%%/g, function (m, k) { var e = m.index + m[0].length; k(m.index, m.index + 3 + m[1].length); k(e - 2, e); }],
    [/==([a-zA-Z]{3,10})\|([^\n]+?)==/g, function (m, k) { var e = m.index + m[0].length; k(m.index, m.index + 3 + m[1].length); k(e - 2, e); }],
    [/<\/?(?:u|b|i|em|strong|br|s|del|ins|sub|sup|mark|span|kbd|small|big|code|p|div)\b[^>\n]*>/gi, function (m, k) { k(m.index, m.index + m[0].length); }],
    [/\*\*([^*\n]+?)\*\*/g, pair(2)],
    [/__([^_\n]+?)__/g, pair(2)],
    [/~~([^~\n]+?)~~/g, pair(2)],
    [/\*([^*\s][^*\n]*?)\*/g, pair(1)],
    [/(^|[^\w])_([^_\n]+?)_(?!\w)/g, function (m, k) { var s = m.index + m[1].length, e = m.index + m[0].length; k(s, s + 1); k(e - 1, e); }, true],
    [/\\([\\`*_{}[\]()#+\-.!|~%=>])/g, function (m, k) { k(m.index, m.index + 1); }],
    [/(^|\s)#(?=[A-Za-z])/g, function (m, k) { var s = m.index + m[1].length; k(s, s + 1); }, true], // #tag -> tag
  ];
  function pair(n) { return function (m, k) { var e = m.index + m[0].length; k(m.index, m.index + n); k(e - n, e); }; }

  // One raw line -> { s: cleaned text, p: doc offset per char, kind }.
  // lo/hi clip the output to a selection.
  function cleanLine(line, base, lo, hi) {
    var L = line.length, del = new Uint8Array(L), prot = new Uint8Array(L), sub = null;
    var kind = 'text', i;
    var m = RE_PREFIX.exec(line), pre = m ? m[0].length : 0;
    if (m) {
      if (m[4]) kind = 'heading';
      else if (m[5] || m[6]) kind = 'list';
      else if (m[3]) kind = 'quote';
    }
    for (i = 0; i < pre; i++) del[i] = 1;
    if (RE_TABLE.test(line)) {
      kind = 'table'; sub = {};
      var first = line.indexOf('|'), last = line.lastIndexOf('|');
      for (i = 0; i < L; i++) {
        if (line.charCodeAt(i) !== 124 || (i > 0 && line[i - 1] === '\\')) continue;
        if (i === first || i === last) del[i] = 1; else sub[i] = ', ';
      }
    }
    var kill = function (a, b) { for (var x = Math.max(0, a); x < b && x < L; x++) del[x] = 1; };
    var protect = function (a, b) { for (var x = a; x < b; x++) prot[x] = 1; };
    for (var r = 0; r < INLINE.length; r++) {
      var re = INLINE[r][0], fn = INLINE[r][1], mm;
      re.lastIndex = 0;
      while ((mm = re.exec(line)) !== null) {
        if (!mm[0].length) { re.lastIndex++; continue; }
        var st = mm.index + (INLINE[r][2] ? mm[1].length : 0);
        if (del[st] || prot[st]) continue;
        fn(mm, kill, protect);
      }
    }
    var s = '', p = [];
    for (i = 0; i < L; i++) {
      if (del[i]) continue;
      var off = base + i;
      if (off < lo || off >= hi) continue;
      var c = sub && sub[i] !== undefined ? sub[i] : line[i];
      for (var j = 0; j < c.length; j++) {
        var ch = c[j];
        if (ch === '\t' || ch === '\u00a0' || ch === ' ') {
          if (!s.length || s.charCodeAt(s.length - 1) === 32) continue;
          ch = ' ';
        } else if ((ch === ',' || ch === '.') && s.charCodeAt(s.length - 1) === 32) {
          s = s.slice(0, -1); p.pop(); // "cell , cell" -> "cell, cell"
        }
        s += ch; p.push(off);
      }
    }
    while (s.length && s.charCodeAt(s.length - 1) === 32) { s = s.slice(0, -1); p.pop(); }
    return { s: s, p: p, kind: kind };
  }

  // ---- sentence splitting --------------------------------------------------
  var SEG = null;
  try { if (window.Intl && Intl.Segmenter) SEG = new Intl.Segmenter(navigator.language || 'en', { granularity: 'sentence' }); } catch (e) { SEG = null; }
  var ABBR_END = /(?:^|[\s("'])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|e\.g|i\.e|cf|approx|No|Fig|Figs|Inc|Ltd|Co|Gen|Capt|Lt|Sgt|Vol|pp|ca)\.$/i;
  var INITIAL_END = /(?:^|\s)[A-Z]\.$/;

  function rawSentences(s) {
    var out = [];
    if (SEG) {
      var it = SEG.segment(s)[Symbol.iterator]();
      for (var r = it.next(); !r.done; r = it.next()) out.push([r.value.index, r.value.index + r.value.segment.length]);
    } else {
      // [.!?…] (+ closing quotes/brackets) followed by whitespace or the end
      var start = 0;
      for (var i = 0; i < s.length; i++) {
        if ('.!?\u2026'.indexOf(s[i]) < 0) continue;
        var j = i + 1;
        while (j < s.length && '.!?\u2026"\')]\u201d\u2019'.indexOf(s[j]) >= 0) j++;
        if (j < s.length && s[j] !== ' ') { i = j - 1; continue; }
        while (j < s.length && s[j] === ' ') j++;
        if (j < s.length && /[a-z]/.test(s[j])) { i = j - 1; continue; } // "p.m. in", "?" he said
        out.push([start, j]); start = j; i = j - 1;
      }
      if (start < s.length) out.push([start, s.length]);
    }
    // ICU splits after "Dr." / "e.g." / initials — glue those back together.
    var merged = [];
    for (var k = 0; k < out.length; k++) {
      var cur = [out[k][0], out[k][1]];
      while (k + 1 < out.length) {
        var t = s.slice(cur[0], cur[1]).replace(/\s+$/, '');
        var nx = s.charAt(out[k + 1][0]);
        if (ABBR_END.test(t) || INITIAL_END.test(t) || (/(?:\betc\.|[?!]["'\u201d\u2019)]*)$/i.test(t) && /[a-z]/.test(nx))) {
          cur[1] = out[k + 1][1]; k++;
        } else break;
      }
      merged.push(cur);
    }
    return merged;
  }

  // Split [a,b) of s into chunks <= MAX_CHUNK, preferring clause breaks.
  function capChunks(s, a, b, out) {
    while (b - a > MAX_CHUNK) {
      var win = s.slice(a, a + MAX_CHUNK), cut = -1, m, re = /[,;:)\u2013\u2014](?= )/g;
      while ((m = re.exec(win)) !== null) if (m.index > MAX_CHUNK * 0.35) cut = m.index + 1;
      if (cut < 0) { cut = win.lastIndexOf(' '); if (cut < MAX_CHUNK * 0.35) cut = -1; }
      if (cut < 0) cut = MAX_CHUNK;
      out.push([a, a + cut]); a += cut;
    }
    if (b > a) out.push([a, b]);
  }

  var HAS_WORD = /[\p{L}\p{N}]/u;

  // A paragraph (joined lines) -> sentence objects appended to `out`.
  function emitParagraph(s, p, out) {
    if (!s) return;
    var P = Int32Array.from(p), chunks = [];
    rawSentences(s).forEach(function (r) { capChunks(s, r[0], r[1], chunks); });
    var first = out.length;
    chunks.forEach(function (c) {
      var a = c[0], b = c[1];
      while (a < b && s.charCodeAt(a) === 32) a++;
      while (b > a && s.charCodeAt(b - 1) === 32) b--;
      if (b <= a) return;
      var text = s.slice(a, b);
      if (!HAS_WORD.test(text)) return;
      out.push({ text: text, from: P[a], to: P[b - 1] + 1, pos: P.subarray(a, b), para: false });
    });
    if (out.length > first) out[out.length - 1].para = true;
  }

  // Is the start of line `n` inside a fenced code block?
  function fenceStateAt(doc, n) {
    var open = false;
    for (var i = 1; i < n; i++) if (RE_FENCE.test(doc.line(i).text)) open = !open;
    return open;
  }

  // doc range [from, to) -> sentences. `fencesKnown` false = assume we start
  // outside a fence (selection scope: the user picked exactly this text).
  function extract(doc, from, to, fencesKnown) {
    var out = [], truncated = false;
    var n0 = doc.lineAt(from).number, n1 = doc.lineAt(to).number;
    var fence = fencesKnown && n0 > 1 && fenceStateAt(doc, n0) ? { from: from } : null;
    var cur = null, scanned = 0;
    function flush() {
      if (cur) emitParagraph(cur.s, cur.p, out);
      cur = null;
    }
    for (var n = n0; n <= n1; n++) {
      var line = doc.line(n), text = line.text;
      if (RE_FENCE.test(text)) {
        flush();
        if (!fence) fence = { from: Math.max(line.from, from) };
        else {
          out.push({ text: 'Code block.', from: fence.from, to: Math.min(line.to, to), pos: null, para: true });
          fence = null;
        }
        continue;
      }
      if (fence) continue;
      if (!text.trim() || RE_HR.test(text) || RE_TSEP.test(text) || RE_SKIPLINE.test(text)) { flush(); continue; }
      scanned += text.length;
      if (scanned > SCAN_LIMIT) { truncated = true; break; }
      var c = cleanLine(text, line.from, from, to);
      if (!c.s) { if (c.kind !== 'text') flush(); continue; }
      var joinable = cur && cur.kind === c.kind && (c.kind === 'text' || c.kind === 'quote') &&
        cur.lastLen >= 45 && !/[.!?:;]["')\]\u201d\u2019]*$/.test(cur.s);
      if (joinable) {
        cur.s += ' '; cur.p.push(line.from - 1); // the newline
        cur.s += c.s; Array.prototype.push.apply(cur.p, c.p);
      } else {
        flush();
        cur = { s: c.s, p: c.p, kind: c.kind };
      }
      cur.lastLen = c.s.length;
      if (c.kind === 'heading' || c.kind === 'list' || c.kind === 'table') flush();
    }
    flush();
    if (fence) out.push({ text: 'Code block.', from: fence.from, to: Math.min(doc.length, to), pos: null, para: true });
    return { list: out, truncated: truncated };
  }

  // Build the reading queue for the chosen scope.
  function buildQueue(state, scope) {
    var doc = state.doc, sel = state.selection.main;
    if (scope === 'sel' && !sel.empty) {
      var r = extract(doc, sel.from, sel.to, false);
      r.start = 0; r.what = 'selection';
      return r;
    }
    if (scope === 'doc') {
      var d = extract(doc, 0, doc.length, true);
      d.start = 0; d.what = 'document';
      return d;
    }
    // From the cursor: start at the paragraph so the first sentence is whole.
    var head = sel.head, ln = doc.lineAt(head).number, k = 0;
    while (ln > 1 && k < 60) {
      var prev = doc.line(ln - 1).text;
      if (!prev.trim() || RE_FENCE.test(prev)) break;
      ln--; k++;
    }
    var c = extract(doc, doc.line(ln).from, doc.length, true);
    c.start = c.list.length;
    for (var i = 0; i < c.list.length; i++) if (c.list[i].to > head) { c.start = i; break; }
    c.what = 'cursor';
    return c;
  }

  // ======================================================================
  // HIGHLIGHT (ViewPlugin, only registered while the panel is open)
  // ======================================================================
  var hl = { on: false, doc: null, ver: 0, sFrom: 0, sTo: 0, wFrom: -1, wTo: -1 };
  var hlExt = null, hlRegistered = false;
  function makeHlExt() {
    var CM = Cade.CM;
    if (!CM || !CM.ViewPlugin || !CM.Decoration) return null;
    var D = CM.Decoration;
    var sMark = D.mark({ class: 'cm-tts-sent' }), wMark = D.mark({ class: 'cm-tts-word' });
    function build(view) {
      if (!hl.on || view.state.doc !== hl.doc) return D.none;
      var len = view.state.doc.length, r = [];
      var a = clamp(hl.sFrom, 0, len), b = clamp(hl.sTo, 0, len);
      if (b > a) r.push(sMark.range(a, b));
      var wa = clamp(hl.wFrom, 0, len), wb = clamp(hl.wTo, 0, len);
      if (hl.wFrom >= 0 && wb > wa) r.push(wMark.range(wa, wb));
      return r.length ? D.set(r, true) : D.none;
    }
    function Plug(view) { this.ver = hl.ver; this.decorations = build(view); }
    Plug.prototype.update = function (u) {
      // our own nudges carry no doc change; edits just shift what's drawn
      if (this.ver !== hl.ver) { this.ver = hl.ver; this.decorations = build(u.view); }
      else if (u.docChanged && this.decorations.size) this.decorations = this.decorations.map(u.changes);
    };
    return CM.ViewPlugin.fromClass(Plug, { decorations: function (v) { return v.decorations; } });
  }
  function ensureHl() {
    if (hlRegistered) return true;
    if (!hlExt) hlExt = makeHlExt();
    if (!hlExt) return false;
    try { Cade.registerPlugin({ id: HL_ID, ext: hlExt }); hlRegistered = true; } catch (e) { return false; }
    return true;
  }
  function dropHl() {
    if (hl.on) { hl.on = false; nudge(false); }
    if (hlRegistered && typeof window.__unregisterPlugin === 'function') {
      try { window.__unregisterPlugin(HL_ID); } catch (e) {}
    }
    hlRegistered = false;
  }
  function nudge(scrollTo) {
    var ed = Cade.editor, CM = Cade.CM;
    if (!ed) return;
    hl.ver++;
    var eff = [];
    if (scrollTo != null && scrollTo !== false && CM && CM.EditorView && CM.EditorView.scrollIntoView) {
      try { eff.push(CM.EditorView.scrollIntoView(scrollTo, { y: 'nearest', yMargin: 64 })); } catch (e) {}
    }
    try { ed.dispatch({ effects: eff }); } catch (e) {}
  }

  // ======================================================================
  // READING SESSION (queue + position tracking through edits)
  // ======================================================================
  var R = {
    active: false, list: [], idx: 0, wordAt: 0,
    doc: null, changes: null, detached: false, lastEdit: 0,
    state: 'idle', // idle | loading | playing | paused
  };
  var panelOpen = false, hintTimer = null;
  // Hooks can't be removed: return immediately unless the panel is open.
  Cade.onEditorUpdate(function (u) {
    if (!panelOpen) return;
    if (!R.active) {
      // idle: keep the "press play to read the selection / from the cursor" hint honest
      if (u.selectionSet && !hintTimer) hintTimer = setTimeout(function () { hintTimer = null; if (R.state === 'idle') updateNow(); }, 250);
      return;
    }
    if (!u.docChanged) return;
    R.lastEdit = Date.now();
    if (u.startState.doc !== R.doc) { R.detached = true; return; }
    try { R.changes = R.changes ? R.changes.compose(u.changes) : u.changes; R.doc = u.state.doc; } catch (e) { R.detached = true; }
  });
  function mapPos(p, assoc) { return R.changes ? R.changes.mapPos(p, assoc) : p; }
  function attached() {
    var ed = Cade.editor;
    if (R.detached || !ed || ed.state.doc !== R.doc) { R.detached = true; return false; }
    return true;
  }
  function showSentence(i, scroll) {
    var s = R.list[i];
    if (!s || !attached()) { if (hl.on) { hl.on = false; nudge(false); } return; }
    if (!ensureHl()) return;
    hl.on = true; hl.doc = R.doc;
    hl.sFrom = mapPos(s.from, 1); hl.sTo = Math.max(hl.sFrom, mapPos(s.to, -1));
    hl.wFrom = hl.wTo = -1;
    // follow the reading, but not while the user is typing somewhere else
    nudge(scroll && Date.now() - R.lastEdit > 4000 ? hl.sFrom : false);
  }
  function showWord(i, ci, cj) {
    var s = R.list[i];
    if (!s || !s.pos || !hl.on || !attached()) return;
    ci = clamp(ci, 0, s.pos.length - 1); cj = clamp(cj, ci + 1, s.pos.length);
    hl.wFrom = mapPos(s.pos[ci], 1); hl.wTo = Math.max(hl.wFrom, mapPos(s.pos[cj - 1] + 1, -1));
    nudge(false);
  }
  function clearHighlight() { if (hl.on) { hl.on = false; nudge(false); } }

  // ======================================================================
  // ENGINE 1: Web Speech API
  // ======================================================================
  var WS = {
    ok: typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function',
    voices: [], gen: 0, utt: null, timer: null, started: false, sawSpeaking: false,
    idleTicks: 0, aliveTicks: 0, errors: 0, retried: false,
  };
  var UA = navigator.userAgent || '';
  var IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(UA) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(UA));
  var IS_CHROME = /Chrome\//.test(UA) && !/Edg\//.test(UA);
  var USER_LANG = (navigator.language || 'en-US').toLowerCase();
  function baseLang(l) { return String(l || '').toLowerCase().replace('_', '-').split('-')[0]; }
  // Old MacinTalk novelty voices: never auto-pick these.
  var NOVELTY = /\b(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Ralph|Kathy|Princess)\b/i;
  var ELOQUENCE = /\b(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/i;

  function voiceScore(v) {
    var n = v.name || '', l = String(v.lang || '').toLowerCase().replace('_', '-'), s = 0;
    if (l === USER_LANG) s += 40; else if (baseLang(l) === baseLang(USER_LANG)) s += 30; else if (baseLang(l) === 'en') s += 4;
    if (/natural/i.test(n)) s += 30;
    if (/neural/i.test(n)) s += 28;
    if (/premium/i.test(n)) s += 26;
    if (/enhanced/i.test(n)) s += 22;
    if (/siri/i.test(n)) s += 20;
    if (/^google\b/i.test(n)) s += 15;
    if (/online/i.test(n)) s += 8;
    if (/espeak|mbrola/i.test(n)) s -= 25;
    if (/compact/i.test(n)) s -= 10;
    if (NOVELTY.test(n)) s -= 45;
    if (ELOQUENCE.test(n)) s -= 15;
    if (v['default']) s += 3;
    return s;
  }
  function voiceKey(v) { return (v.voiceURI || '') + '\u0001' + (v.name || ''); }
  function loadVoices() {
    if (!WS.ok) return [];
    var vs = [];
    try { vs = window.speechSynthesis.getVoices() || []; } catch (e) {}
    WS.voices = vs.slice().sort(function (a, b) { return voiceScore(b) - voiceScore(a) || String(a.name).localeCompare(b.name); });
    return WS.voices;
  }
  function bestVoice(localOnly) {
    for (var i = 0; i < WS.voices.length; i++) {
      var v = WS.voices[i];
      if (localOnly && v.localService === false) continue;
      return v;
    }
    return null;
  }
  function currentVoice() {
    if (prefs.voice) {
      for (var i = 0; i < WS.voices.length; i++) if (voiceKey(WS.voices[i]) === prefs.voice) return WS.voices[i];
      var nm = prefs.voice.split('\u0001')[1];
      for (var j = 0; j < WS.voices.length; j++) if (WS.voices[j].name === nm) return WS.voices[j];
    }
    return bestVoice(false);
  }
  var WS_LOCAL_OVERRIDE = null; // set when a network voice failed offline
  function wsVoice() { return WS_LOCAL_OVERRIDE || currentVoice(); }

  function wsCancel() {
    WS.gen++;
    WS.utt = null;
    if (WS.ok) { try { window.speechSynthesis.cancel(); } catch (e) {} }
  }
  function wsStopTimer() { if (WS.timer) { clearInterval(WS.timer); WS.timer = null; } }

  // Speak sentence R.idx starting at char `offset` (resume / restart).
  function wsSpeak(offset) {
    var s = R.list[R.idx];
    if (!s) { finish(); return; }
    var ss = window.speechSynthesis;
    offset = clamp(offset || 0, 0, s.text.length);
    // resume at the start of a word
    while (offset > 0 && /\S/.test(s.text[offset - 1])) offset--;
    var text = s.text.slice(offset);
    if (!/\S/.test(text)) { wsAdvance(); return; }
    var gen = ++WS.gen;
    var u = new window.SpeechSynthesisUtterance(text);
    var v = wsVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = navigator.language || 'en-US';
    u.rate = prefs.rate; u.pitch = prefs.pitch; u.volume = 1;
    u.onstart = function () { if (gen === WS.gen) { WS.started = true; setStatus(); } };
    u.onboundary = function (e) {
      if (gen !== WS.gen || (e.name && e.name !== 'word')) return;
      var ci = offset + (e.charIndex || 0);
      var len = e.charLength || ((/^\S+/.exec(s.text.slice(ci)) || [''])[0].length) || 1;
      R.wordAt = ci;
      showWord(R.idx, ci, ci + len);
    };
    u.onend = function () { if (gen === WS.gen) { WS.errors = 0; wsAdvance(); } };
    u.onerror = function (e) {
      if (gen !== WS.gen) return;
      var err = e && e.error;
      if (err === 'interrupted' || err === 'canceled') return;
      wsError(err, v);
    };
    WS.utt = u; // keep a reference: Chrome GCs in-flight utterances and then never fires onend
    WS.started = false; WS.idleTicks = 0; WS.aliveTicks = 0;
    try {
      if (ss.speaking || ss.pending) ss.cancel();
      ss.speak(u);
    } catch (e2) { wsError('synthesis-failed', v); return; }
    wsWatch(v);
  }
  function wsAdvance() {
    if (R.state !== 'playing') return;
    R.idx++; R.wordAt = 0;
    if (R.idx >= R.list.length) { finish(); return; }
    showSentence(R.idx, true);
    updateNow();
    wsSpeak(0);
  }
  function wsError(err, v) {
    if (err === 'not-allowed') { // autoplay policy: needs a tap
      pause(); toast('Tap \u25b6 to start reading (the browser blocked speech)', 'info', 3000);
      return;
    }
    if ((err === 'network' || err === 'synthesis-unavailable' || err === 'voice-unavailable') && v && v.localService === false) {
      var loc = bestVoice(true);
      if (loc && loc !== v) {
        WS_LOCAL_OVERRIDE = loc;
        toast(v.name + ' needs the internet \u2014 using ' + loc.name, 'info', 3000);
        wsSpeak(R.wordAt);
        return;
      }
    }
    WS.errors++;
    if (WS.errors >= 3) { stop(); toast('Speech failed' + (err ? ' (' + err + ')' : ''), 'error', 3000); return; }
    wsAdvance(); // skip the sentence that failed
  }
  // Watchdog: some engines drop onend (Chrome/Android), and Chrome's network
  // voices go silent after ~15 s of one utterance unless poked.
  function wsWatch(v) {
    wsStopTimer();
    var keepAlive = IS_CHROME && !IS_MOBILE && v && v.localService === false && /^google/i.test(v.name);
    WS.timer = setInterval(function () {
      if (R.state !== 'playing' || HD.active) { wsStopTimer(); return; }
      if (!panelEl()) { cleanup(); return; }
      var ss = window.speechSynthesis;
      if (ss.speaking) WS.sawSpeaking = true;
      if (ss.speaking || ss.pending) {
        WS.idleTicks = 0;
        if (keepAlive && ++WS.aliveTicks >= 20) { WS.aliveTicks = 0; try { ss.pause(); ss.resume(); } catch (e) {} }
        return;
      }
      // Only trust "idle" on engines that report speaking at all.
      if (!WS.sawSpeaking) return;
      if (++WS.idleTicks < 6) return; // ~3 s of silence with no end event
      WS.idleTicks = 0;
      if (!WS.started && !WS.retried) { WS.retried = true; wsSpeak(R.wordAt); return; }
      WS.retried = false;
      wsAdvance();
    }, 500);
  }

  // ======================================================================
  // ENGINE 2: HD voice (Piper in a worker + Web Audio)
  // ======================================================================
  var HD = {
    active: false,          // engine in use for the current session
    worker: null, workerVoice: '', ready: false, loading: false, failed: '',
    sampleRate: 22050, ctx: null,
    gen: 0, reqIdx: 0, schedIdx: 0, nextT: 0, got: {}, sched: [], ticker: null,
    dl: { loaded: 0, total: 0 }, cached: {}, onReady: null, waiting: false,
    dirty: false,           // paused, then jumped: schedule must be rebuilt on resume
  };
  var AHEAD = 3; // sentences synthesized ahead of the one playing

  function hdSupported() {
    return typeof window.WebAssembly === 'object' && typeof window.Worker === 'function' &&
      !!(window.AudioContext || window.webkitAudioContext) && typeof window.BigInt64Array === 'function' &&
      !!window.caches && window.isSecureContext !== false;
  }
  // Is everything for voice `id` already in our Cache Storage bucket?
  function hdCheckCached(id) {
    if (!window.caches) return Promise.resolve(false);
    return window.caches.has(HD_CACHE).then(function (has) {
      if (!has) return false;
      return window.caches.open(HD_CACHE).then(function (c) {
        var u = hdUrls(hdVoice(id)), keys = Object.keys(u);
        return Promise.all(keys.map(function (k) { return c.match(u[k]); })).then(function (rs) {
          return rs.every(Boolean);
        });
      });
    }).then(function (ok) { HD.cached[id] = ok; return ok; }, function () { return false; });
  }
  function hdTerminate() {
    if (HD.worker) { try { HD.worker.terminate(); } catch (e) {} }
    HD.worker = null; HD.ready = false; HD.loading = false; HD.workerVoice = ''; HD.onReady = null;
  }
  // Create the worker and load (downloading first if needed) voice `id`.
  function hdLoad(id, onReady) {
    if (HD.worker && HD.workerVoice === id) {
      if (HD.ready) { if (onReady) onReady(); return; }
      HD.onReady = onReady || HD.onReady;
      return;
    }
    hdTerminate();
    if (!hdSupported()) { hdFail('this browser can\u2019t run it (needs WebAssembly + Web Audio)'); return; }
    var w;
    try { w = new window.Worker(WORKER_URL, { type: 'module' }); } catch (e) { hdFail('module workers are not supported'); return; }
    HD.worker = w; HD.workerVoice = id; HD.loading = true; HD.ready = false; HD.failed = '';
    HD.onReady = onReady || null;
    var v = hdVoice(id), u = hdUrls(v);
    HD.dl = { loaded: 0, total: 0 };
    w.onmessage = function (e) { hdMsg(w, e.data || {}); };
    w.onerror = function (e) {
      if (w !== HD.worker) return;
      try { e.preventDefault(); } catch (x) {}
      hdFail((e && e.message) || 'worker failed to start');
    };
    var sizes = { ort: HD_RUNTIME_SIZES.ort, glue: HD_RUNTIME_SIZES.glue, wasm: HD_RUNTIME_SIZES.wasm, phon: HD_RUNTIME_SIZES.phon, model: v.size, config: 5000 };
    w.postMessage({ type: 'init', files: u, sizes: sizes });
    renderHd();
  }
  function hdMsg(w, m) {
    if (w !== HD.worker) return;
    if (m.type === 'progress') {
      HD.dl.loaded = m.loaded; HD.dl.total = m.total;
      renderHdProgress();
    } else if (m.type === 'ready') {
      HD.ready = true; HD.loading = false; HD.sampleRate = m.sampleRate || 22050;
      HD.cached[HD.workerVoice] = true;
      renderHd();
      var cb = HD.onReady; HD.onReady = null;
      if (cb) cb();
    } else if (m.type === 'error') {
      hdFail(m.message);
    } else if (m.type === 'warn') {
      toast(m.message, 'info', 3500);
    } else if (m.type === 'audio' || m.type === 'synth-error') {
      hdAudio(m);
    }
  }
  // The HD engine couldn't load: say why, and carry on with the standard
  // voice for this session (the HD choice is kept so a retry is one tap away).
  function hdFail(msg) {
    var wasPlaying = R.state === 'loading' || (HD.active && (R.state === 'playing' || R.state === 'paused'));
    var v = HD.workerVoice || prefs.hdVoice;
    hdTerminate();
    HD.failed = msg || 'failed to load';
    var offline = navigator.onLine === false && !HD.cached[v];
    toast('HD voice unavailable \u2014 ' + (offline ? 'it needs one online download first' : HD.failed) +
      (wasPlaying && WS.ok ? '. Using the standard voice.' : '.'), 'error', 4200);
    renderSettings();
    if (wasPlaying) {
      hdStopAudio();
      HD.active = false;
      if (R.list.length && WS.ok) { R.state = 'playing'; showSentence(R.idx, true); updateNow(); wsSpeak(R.wordAt); }
      else stop();
    }
  }

  function hdEnsureCtx() {
    if (!HD.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      HD.ctx = new AC();
    }
    var ctx = HD.ctx;
    // iOS: resume + a silent blip inside the tap that started playback.
    try { if (ctx.state !== 'running') ctx.resume(); } catch (e) {}
    try {
      var b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
      s.buffer = b; s.connect(ctx.destination); s.start(0);
    } catch (e) {}
    return ctx;
  }
  function hdPitchFactor() { return Math.pow(prefs.pitch, 0.4); } // 0.5..2 -> ~0.76..1.32
  function hdStopAudio() {
    HD.gen++;
    HD.sched.forEach(function (x) { try { x.src.onended = null; x.src.stop(); x.src.disconnect(); } catch (e) {} });
    HD.sched = []; HD.got = {};
    if (HD.ticker) { clearInterval(HD.ticker); HD.ticker = null; }
    if (HD.worker) { try { HD.worker.postMessage({ type: 'cancel' }); } catch (e) {} }
  }
  // (Re)start HD playback at sentence i.
  function hdStart(i) {
    hdStopAudio();
    R.idx = i; R.wordAt = 0;
    HD.reqIdx = i; HD.schedIdx = i; HD.nextT = 0; HD.waiting = true;
    showSentence(i, true);
    updateNow();
    hdFill();
    HD.ticker = setInterval(hdTick, 90);
  }
  function hdFill() {
    if (!HD.worker) return;
    var f = hdPitchFactor(), ls = f / prefs.rate;
    while (HD.reqIdx < R.list.length && HD.reqIdx < R.idx + AHEAD + 1) {
      var i = HD.reqIdx++;
      HD.worker.postMessage({ type: 'synth', id: HD.gen + ':' + i, text: R.list[i].text, lengthScale: ls });
    }
  }
  function hdAudio(m) {
    var parts = String(m.id).split(':');
    if (+parts[0] !== HD.gen) return; // stale (stopped / jumped since)
    var i = +parts[1];
    if (m.type === 'synth-error' || !m.pcm || !m.pcm.length) {
      HD.got[i] = 'skip';
      if (m.type === 'synth-error') console.warn('[tts] HD synth failed:', m.message);
    } else {
      try {
        var buf = HD.ctx.createBuffer(1, m.pcm.length, m.sampleRate || HD.sampleRate);
        if (buf.copyToChannel) buf.copyToChannel(m.pcm, 0); else buf.getChannelData(0).set(m.pcm);
        HD.got[i] = buf;
      } catch (e) { HD.got[i] = 'skip'; }
    }
    hdSchedule();
  }
  function hdSchedule() {
    var ctx = HD.ctx, f = hdPitchFactor();
    while (HD.got[HD.schedIdx]) {
      var i = HD.schedIdx, buf = HD.got[i];
      delete HD.got[i];
      HD.schedIdx++;
      if (buf === 'skip') continue;
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = f;
      src.connect(ctx.destination);
      var t = Math.max(ctx.currentTime + 0.05, HD.nextT);
      src.start(t);
      var end = t + buf.duration / f;
      HD.sched.push({ i: i, start: t, end: end, src: src });
      // a beat between sentences, a longer one between paragraphs
      HD.nextT = end + (R.list[i].para ? 0.38 : 0.1) / prefs.rate;
      HD.waiting = false;
    }
  }
  function hdTick() {
    if (!panelEl()) { cleanup(); return; }
    if (R.state !== 'playing') return;
    var now = HD.ctx.currentTime, cur = null;
    for (var k = 0; k < HD.sched.length; k++) if (HD.sched[k].start <= now + 0.03) cur = HD.sched[k];
    if (cur && cur.i !== R.idx && now < cur.end + 0.05) {
      R.idx = cur.i;
      showSentence(R.idx, true);
      updateNow();
    }
    // drop finished sources
    while (HD.sched.length && HD.sched[0].end < now - 0.2 && HD.sched.length > 1) {
      var x = HD.sched.shift();
      try { x.src.disconnect(); } catch (e) {}
    }
    hdFill();
    var last = HD.sched[HD.sched.length - 1];
    var allDone = HD.schedIdx >= R.list.length && (!last || now >= last.end);
    if (allDone) { finish(); return; }
    var starving = !HD.sched.length || (last && now >= last.end);
    if (starving !== HD.waiting) { HD.waiting = starving; setStatus(); }
  }

  // ======================================================================
  // PLAYER (shared transport)
  // ======================================================================
  function useHd() { return prefs.engine === 'hd'; }

  function playPause() {
    if (R.state === 'playing') pause();
    else if (R.state === 'paused') resume();
    else if (R.state === 'idle') start();
  }

  function start() {
    var ed = Cade.editor;
    if (!ed) return;
    var q = buildQueue(ed.state, prefs.scope);
    if (!q.list.length || q.start >= q.list.length) {
      toast(q.what === 'cursor' ? 'Nothing to read after the cursor' : 'Nothing to read here', 'info', 2200);
      return;
    }
    if (q.truncated) toast('Long note \u2014 reading the first ' + Math.round(SCAN_LIMIT / 1000) + 'k characters', 'info', 3000);
    R.list = q.list; R.idx = q.start; R.wordAt = 0;
    R.active = true; R.doc = ed.state.doc; R.changes = null; R.detached = false; R.lastEdit = 0;
    WS.errors = 0; WS.retried = false;
    HD.active = false;
    if (useHd()) {
      var id = prefs.hdVoice, have = HD.worker && HD.workerVoice === id;
      if (!hdSupported()) {
        toast('HD voice isn\u2019t supported in this browser \u2014 using the standard voice', 'info', 3200);
      } else if (have || HD.cached[id] !== false) {
        HD.active = true;
        hdEnsureCtx(); // inside the tap (iOS unlock)
        if (have && HD.ready) { R.state = 'playing'; hdStart(R.idx); return; }
        R.state = 'loading';
        showSentence(R.idx, true);
        updateNow();
        var go = function () {
          if (R.state !== 'loading') return;
          R.state = 'playing'; hdStart(R.idx); setStatus();
        };
        if (have) hdLoad(id, go); // join the download / load already running
        else {
          hdCheckCached(id).then(function (ok) {
            if (R.state !== 'loading') return;
            if (ok) { hdLoad(id, go); return; }
            // Never start a ~66 MB download from Play: read with the standard voice.
            HD.active = false; renderHd();
            toast('HD voice isn\u2019t downloaded yet \u2014 using the standard voice (\u2699 \u2192 Download)', 'info', 3800);
            if (!WS.ok) { stop(); return; }
            R.state = 'playing'; showSentence(R.idx, true); updateNow(); wsSpeak(0);
          });
        }
        return;
      } else {
        toast('HD voice isn\u2019t downloaded yet \u2014 using the standard voice (\u2699 \u2192 Download)', 'info', 3800);
      }
    }
    if (!WS.ok) { toast('Speech isn\u2019t supported in this browser', 'error', 3000); R.active = false; return; }
    R.state = 'playing';
    showSentence(R.idx, true);
    updateNow();
    wsSpeak(0); // synchronously inside the tap: iOS requires it
  }

  function pause() {
    if (R.state !== 'playing' && R.state !== 'loading') return;
    if (R.state === 'loading') { stop(); return; }
    R.state = 'paused';
    if (HD.active) { try { HD.ctx.suspend(); } catch (e) {} }
    else { wsStopTimer(); wsCancel(); }
    updateNow();
  }
  function resume() {
    if (R.state !== 'paused') return;
    R.state = 'playing';
    if (HD.active) {
      hdEnsureCtx();
      if (HD.dirty || !HD.sched.length) { HD.dirty = false; hdStart(R.idx); }
    } else {
      showSentence(R.idx, false);
      wsSpeak(R.wordAt);
    }
    updateNow();
  }
  function stop() {
    var was = R.state;
    R.state = 'idle'; R.active = false;
    wsStopTimer(); wsCancel();
    hdStopAudio(); HD.active = false; HD.dirty = false;
    if (HD.ctx && HD.ctx.state === 'suspended') { try { HD.ctx.resume(); } catch (e) {} }
    clearHighlight();
    if (was !== 'idle') updateNow();
  }
  function finish() {
    stop();
    setStatus('Finished');
  }
  // Jump to sentence i (prev/next/seek), keeping play/pause state.
  function jump(i) {
    if (!R.list.length || R.state === 'idle' || R.state === 'loading') return;
    i = clamp(i, 0, R.list.length - 1);
    R.wordAt = 0;
    if (R.state === 'paused') {
      R.idx = i; showSentence(i, true); updateNow();
      if (HD.active) { hdStopAudio(); HD.dirty = true; }
      return;
    }
    if (HD.active) hdStart(i);
    else { R.idx = i; showSentence(i, true); updateNow(); wsSpeak(0); }
  }
  // Re-apply voice/rate/pitch to the sentence being read.
  var restartTimer = null;
  function restartSoon() {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(function () {
      if (R.state !== 'playing') { if (R.state === 'paused' && HD.active) { hdStopAudio(); HD.dirty = true; } return; }
      if (HD.active) hdStart(R.idx); else wsSpeak(R.wordAt);
    }, 280);
  }

  function cleanup() {
    panelOpen = false;
    clearTimeout(restartTimer); clearTimeout(hintTimer); hintTimer = null;
    stop();
    hdTerminate();
    if (HD.ctx) { try { HD.ctx.close(); } catch (e) {} HD.ctx = null; }
    dropHl();
    if (WS.ok && voicesListener) {
      try { window.speechSynthesis.removeEventListener('voiceschanged', voicesListener); } catch (e) {}
    }
    voicesListener = null;
    clearTimeout(voicePoll);
    R.list = [];
  }

  // ======================================================================
  // UI
  // ======================================================================
  function panelEl() { return document.getElementById(PANEL_ID); }
  function q(sel) { var p = panelEl(); return p ? p.querySelector(sel) : null; }

  var statusOverride = '';
  function setStatus(text) {
    if (text !== undefined) statusOverride = text;
    var el = q('.tts-status');
    if (!el) return;
    var t;
    if (R.state === 'loading') {
      t = HD.dl.total && HD.dl.loaded < HD.dl.total ? 'Downloading HD voice\u2026 ' + Math.floor(100 * HD.dl.loaded / HD.dl.total) + '%' : 'Loading HD voice\u2026';
    } else if (R.state === 'playing') t = HD.active && HD.waiting ? 'Preparing audio\u2026' : 'Reading';
    else if (R.state === 'paused') t = 'Paused';
    else t = statusOverride || 'Ready';
    if (R.state !== 'idle') statusOverride = '';
    el.textContent = t;
    el.classList.toggle('busy', R.state === 'loading' || (R.state === 'playing' && HD.active && HD.waiting));
  }
  function updateNow() {
    var p = panelEl(); if (!p) return;
    var playing = R.state === 'playing' || R.state === 'loading';
    var btn = p.querySelector('.tts-play');
    btn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    btn.title = (playing ? 'Pause' : R.state === 'paused' ? 'Resume' : 'Read aloud') + ' (Space)';
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    var has = R.state !== 'idle' && R.list.length;
    p.querySelector('[data-act="prev"]').disabled = !has || R.idx <= 0;
    p.querySelector('[data-act="next"]').disabled = !has || R.idx >= R.list.length - 1;
    p.querySelector('[data-act="stop"]').disabled = R.state === 'idle';
    var s = has ? R.list[R.idx] : null;
    var txt = p.querySelector('.tts-text');
    txt.textContent = s ? s.text : hintText();
    txt.classList.toggle('hint', !s);
    p.querySelector('.tts-count').textContent = has ? (R.idx + 1) + ' / ' + R.list.length : '';
    p.querySelector('.tts-bar-fill').style.width = has ? (100 * (R.idx + 1) / R.list.length).toFixed(2) + '%' : '0%';
    p.querySelector('.tts-bar').classList.toggle('off', !has);
    setStatus();
  }
  function hintText() {
    var ed = Cade.editor, selEmpty = !ed || ed.state.selection.main.empty;
    if (prefs.scope === 'doc') return 'Press \u25b6 to read the whole note.';
    if (prefs.scope === 'sel' && !selEmpty) return 'Press \u25b6 to read the selection.';
    return 'Press \u25b6 to read from the cursor' + (prefs.scope === 'sel' ? ' (or select text first).' : '.');
  }

  var PLAY_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
  var PAUSE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" fill="currentColor"/></svg>';
  var PREV_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 5h2v14H6zM9.5 12 19 18.5v-13z" fill="currentColor"/></svg>';
  var NEXT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M16 5h2v14h-2zM14.5 12 5 18.5v-13z" fill="currentColor"/></svg>';
  var STOP_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/></svg>';
  var GEAR_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4L10.7 6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.3 2.6h4l.3-2.6c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>';

  function langName(code) {
    try {
      if (window.Intl && Intl.DisplayNames) {
        var dn = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
        return dn.of(code) || code;
      }
    } catch (e) {}
    return code;
  }

  function renderVoices() {
    var sel = q('.tts-voice');
    if (!sel) return;
    if (useHd()) {
      sel.innerHTML = HD_VOICES.map(function (v) {
        return '<option value="' + esc(v.id) + '"' + (v.id === prefs.hdVoice ? ' selected' : '') + '>' + esc(v.label) + (HD.cached[v.id] ? ' \u2713' : '') + '</option>';
      }).join('');
      sel.disabled = false;
      sel.title = 'HD neural voices (English). \u2713 = downloaded';
      return;
    }
    if (!WS.ok) { sel.innerHTML = '<option>Speech not supported</option>'; sel.disabled = true; return; }
    var vs = WS.voices;
    if (!vs.length) { sel.innerHTML = '<option value="">Default voice</option>'; sel.disabled = false; return; }
    var best = bestVoice(false), mine = [], other = [];
    vs.forEach(function (v) { (baseLang(v.lang) === baseLang(USER_LANG) ? mine : other).push(v); });
    other.sort(function (a, b) { return String(a.lang).localeCompare(b.lang) || String(a.name).localeCompare(b.name); });
    function opt(v) {
      var k = voiceKey(v), label = v.name;
      return '<option value="' + esc(k) + '"' + (k === prefs.voice ? ' selected' : '') + '>' +
        esc(label) + (v.localService === false ? ' \u2601' : '') + ' \u00b7 ' + esc(v.lang) + '</option>';
    }
    var html = '<option value=""' + (!prefs.voice ? ' selected' : '') + '>Auto \u2014 ' + esc(best ? best.name : 'default') + '</option>';
    if (mine.length) html += '<optgroup label="' + esc(langName(baseLang(USER_LANG))) + '">' + mine.map(opt).join('') + '</optgroup>';
    if (other.length) html += '<optgroup label="Other languages">' + other.map(opt).join('') + '</optgroup>';
    sel.innerHTML = html;
    sel.disabled = false;
    sel.title = '\u2601 = streams from the internet';
  }

  function renderHdProgress() {
    var bar = q('.tts-prog'), fill = q('.tts-prog-fill'), st = q('.tts-hd-status');
    if (!bar) { setStatus(); return; }
    var on = HD.loading && HD.dl.total > 0;
    bar.hidden = !on;
    if (on) {
      var pct = Math.min(100, 100 * HD.dl.loaded / HD.dl.total);
      fill.style.width = pct.toFixed(1) + '%';
      st.textContent = (HD.cached[HD.workerVoice] ? 'Loading\u2026 ' : 'Downloading\u2026 ') + Math.floor(pct) + '% \u00b7 ' + mb(HD.dl.loaded) + ' of ' + mb(HD.dl.total);
    }
    setStatus();
  }

  // Look up which HD voices are already downloaded (cheap Cache Storage reads).
  var hdChecking = false;
  function hdCheckAll() {
    if (hdChecking) return;
    hdChecking = true;
    Promise.all(HD_VOICES.map(function (v) { return hdCheckCached(v.id); })).then(function () {
      hdChecking = false;
      if (useHd()) { renderHd(); renderVoices(); }
    }, function () { hdChecking = false; });
  }

  function renderHd() {
    var box = q('.tts-hd');
    if (!box) return;
    box.hidden = !useHd();
    if (!useHd()) return;
    var v = hdVoice(prefs.hdVoice), st = box.querySelector('.tts-hd-status');
    var dl = box.querySelector('[data-act="hd-dl"]'), cancel = box.querySelector('[data-act="hd-cancel"]'), rm = box.querySelector('[data-act="hd-rm"]');
    var cached = HD.cached[v.id];
    var anyCached = Object.keys(HD.cached).some(function (k) { return HD.cached[k]; });
    var mine = HD.workerVoice === v.id;
    var size = v.size + (anyCached ? 0 : HD_RUNTIME_WIRE);
    dl.hidden = true; cancel.hidden = true; rm.hidden = !anyCached;
    box.querySelector('.tts-prog').hidden = true;
    st.classList.remove('err');
    if (!hdSupported()) {
      st.textContent = 'Not available in this browser (needs WebAssembly, module workers & Web Audio).';
    } else if (mine && HD.loading) {
      cancel.hidden = false; rm.hidden = true;
      st.textContent = cached ? 'Loading voice\u2026' : 'Starting download\u2026';
      renderHdProgress();
    } else if (mine && HD.ready) {
      st.textContent = 'Ready \u2014 runs on this device, works offline.';
    } else if (HD.failed) {
      st.textContent = 'Couldn\u2019t load the HD voice (' + HD.failed + ').';
      st.classList.add('err');
      dl.hidden = false; dl.textContent = cached ? 'Retry' : 'Retry download (' + mb(size) + ')';
    } else if (cached === true) {
      st.textContent = 'Downloaded \u2014 loads when you press \u25b6.';
    } else if (cached === false) {
      st.textContent = 'A natural-sounding neural voice that runs on this device. One-time download, then it works offline.';
      dl.hidden = false; dl.textContent = 'Download (' + mb(size) + ')';
    } else {
      st.textContent = 'Checking\u2026';
      hdCheckAll();
    }
  }

  function renderSettings() {
    var p = panelEl(); if (!p) return;
    var box = p.querySelector('.tts-settings');
    box.hidden = !prefs.settings;
    p.querySelector('.tts-gear').classList.toggle('on', !!prefs.settings);
    p.querySelector('.tts-gear').setAttribute('aria-expanded', prefs.settings ? 'true' : 'false');
    var engs = p.querySelectorAll('.tts-eng');
    for (var i = 0; i < engs.length; i++) {
      var on = engs[i].getAttribute('data-eng') === prefs.engine;
      engs[i].classList.toggle('on', on); engs[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
    var scopes = p.querySelectorAll('.tts-sc');
    for (var j = 0; j < scopes.length; j++) {
      var son = scopes[j].getAttribute('data-scope') === prefs.scope;
      scopes[j].classList.toggle('on', son); scopes[j].setAttribute('aria-checked', son ? 'true' : 'false');
    }
    p.querySelector('.tts-rate').value = prefs.rate;
    p.querySelector('.tts-rate-v').textContent = prefs.rate.toFixed(2).replace(/0$/, '') + '\u00d7';
    p.querySelector('.tts-pitch').value = prefs.pitch;
    p.querySelector('.tts-pitch-v').textContent = prefs.pitch.toFixed(2).replace(/0$/, '');
    renderVoices();
    renderHd();
    keepOnScreen();
  }

  // The panel grows when settings open: keep its bottom edge on screen.
  function keepOnScreen() {
    var p = panelEl(); if (!p) return;
    var r = p.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) p.style.top = Math.max(8, window.innerHeight - 8 - r.height) + 'px';
  }

  function onClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-act], [data-scope], [data-eng], .tts-bar') : null;
    if (!t) return;
    if (t.classList.contains('tts-bar')) {
      if (!R.list.length || R.state === 'idle') return;
      var r = t.getBoundingClientRect();
      jump(Math.floor(clamp((e.clientX - r.left) / r.width, 0, 0.9999) * R.list.length));
      return;
    }
    var sc = t.getAttribute('data-scope');
    if (sc) {
      prefs.scope = sc; savePrefs(); renderSettings();
      if (R.state === 'idle') updateNow();
      return;
    }
    var eng = t.getAttribute('data-eng');
    if (eng) { setEngine(eng); return; }
    var act = t.getAttribute('data-act');
    if (act === 'play') playPause();
    else if (act === 'stop') { stop(); setStatus('Stopped'); }
    else if (act === 'prev') jump(R.idx - 1);
    else if (act === 'next') jump(R.idx + 1);
    else if (act === 'settings') { prefs.settings = !prefs.settings; savePrefs(); renderSettings(); }
    else if (act === 'hd-dl') {
      if (navigator.onLine === false) { toast('You\u2019re offline \u2014 connect to download the HD voice', 'error', 3000); return; }
      hdLoad(prefs.hdVoice, function () { toast('HD voice ready \u2014 works offline now', 'success', 2600); renderVoices(); });
    } else if (act === 'hd-cancel') {
      hdTerminate(); if (R.state === 'loading') stop();
      renderHd(); toast('Download cancelled', 'info', 1600);
    } else if (act === 'hd-rm') {
      if (!window.confirm('Remove the downloaded HD voice data from this device?')) return;
      stop(); hdTerminate();
      window.caches['delete'](HD_CACHE).then(function () {
        HD.cached = {};
        toast('HD voice data removed', 'success', 2000);
        renderHd(); renderVoices();
      }, function () { toast('Couldn\u2019t remove it', 'error', 2000); });
    }
  }

  function setEngine(eng) {
    if (eng === prefs.engine) return;
    var wasPlaying = R.state === 'playing' || R.state === 'paused' || R.state === 'loading';
    if (wasPlaying) stop();
    prefs.engine = eng === 'hd' ? 'hd' : 'web';
    if (prefs.engine === 'web') hdTerminate(); // free ~150 MB of model memory
    savePrefs();
    renderSettings();
    if (wasPlaying) setStatus('Engine changed \u2014 press \u25b6');
  }

  function onChange(e) {
    var t = e.target;
    if (t.classList.contains('tts-voice')) {
      if (useHd()) {
        prefs.hdVoice = hdVoice(t.value).id; savePrefs();
        if (HD.workerVoice && HD.workerVoice !== prefs.hdVoice) {
          var playing = R.state !== 'idle';
          if (playing) stop();
          hdTerminate();
          if (playing) setStatus('Voice changed \u2014 press \u25b6');
        }
        renderHd();
      } else {
        prefs.voice = t.value; WS_LOCAL_OVERRIDE = null; savePrefs();
        restartSoon();
      }
    }
  }
  function onInput(e) {
    var t = e.target;
    if (t.classList.contains('tts-rate')) {
      prefs.rate = clamp(+t.value || 1, 0.5, 2);
      q('.tts-rate-v').textContent = prefs.rate.toFixed(2).replace(/0$/, '') + '\u00d7';
      savePrefs(); restartSoon();
    } else if (t.classList.contains('tts-pitch')) {
      prefs.pitch = clamp(+t.value || 1, 0.5, 2);
      q('.tts-pitch-v').textContent = prefs.pitch.toFixed(2).replace(/0$/, '');
      savePrefs(); restartSoon();
    }
  }
  function onKey(e) {
    var t = e.target, tag = (t.tagName || '').toLowerCase();
    var field = tag === 'select' || tag === 'input' || tag === 'textarea';
    if (e.key === 'Escape' && tag !== 'select') {
      e.preventDefault(); e.stopPropagation();
      if (R.state !== 'idle') { stop(); setStatus('Stopped'); } else close();
      return;
    }
    if (field) { e.stopPropagation(); return; }
    if (e.key === ' ' && tag !== 'button') { e.preventDefault(); playPause(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); jump(R.idx - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); jump(R.idx + 1); }
    else return;
    e.stopPropagation();
  }

  var voicesListener = null, voicePoll = null;
  function watchVoices() {
    if (!WS.ok) return;
    loadVoices();
    voicesListener = function () { loadVoices(); if (!useHd()) renderVoices(); };
    try { window.speechSynthesis.addEventListener('voiceschanged', voicesListener); } catch (e) {}
    // Some engines never fire voiceschanged: poll briefly.
    var tries = 0;
    (function poll() {
      if (!panelEl() || WS.voices.length || tries++ > 10) return;
      voicePoll = setTimeout(function () { loadVoices(); if (WS.voices.length && !useHd()) renderVoices(); poll(); }, 400);
    })();
  }

  function close() {
    var p = panelEl();
    if (p) p.remove();
    cleanup();
  }

  function open() {
    Cade.closeAllMenus();
    var existing = panelEl();
    if (existing) { // toggle like other mini widgets
      close();
      return;
    }
    loadPrefs();
    var p = Cade.mkPanel(PANEL_ID, '\ud83d\udd0a Read Aloud',
      '<div class="tts-now">' +
        '<div class="tts-line"><span class="tts-status" aria-live="polite">Ready</span><span class="tts-count"></span></div>' +
        '<div class="tts-text hint"></div>' +
        '<div class="tts-bar off" title="Jump to a sentence"><div class="tts-bar-fill"></div></div>' +
      '</div>' +
      '<div class="tts-ctrls">' +
        '<button class="tts-btn" data-act="prev" title="Previous sentence (\u2190)" aria-label="Previous sentence">' + PREV_ICON + '</button>' +
        '<button class="tts-btn tts-play" data-act="play" title="Read aloud (Space)" aria-label="Play">' + PLAY_ICON + '</button>' +
        '<button class="tts-btn" data-act="next" title="Next sentence (\u2192)" aria-label="Next sentence">' + NEXT_ICON + '</button>' +
        '<button class="tts-btn" data-act="stop" title="Stop (Esc)" aria-label="Stop">' + STOP_ICON + '</button>' +
        '<span class="tts-spacer"></span>' +
        '<button class="tts-btn tts-gear" data-act="settings" title="Voice, speed &amp; pitch" aria-label="Settings" aria-expanded="false">' + GEAR_ICON + '</button>' +
      '</div>' +
      '<div class="tts-seg tts-scope" role="radiogroup" aria-label="What to read">' +
        '<button class="tts-sc" data-scope="sel" role="radio" title="The selected text (or from the cursor when nothing is selected)">Selection</button>' +
        '<button class="tts-sc" data-scope="cursor" role="radio" title="From the sentence at the cursor to the end">From cursor</button>' +
        '<button class="tts-sc" data-scope="doc" role="radio" title="The whole note from the top">Whole note</button>' +
      '</div>' +
      '<div class="tts-settings" hidden>' +
        '<div class="tts-row"><span class="tts-lbl">Engine</span>' +
          '<div class="tts-seg" role="radiogroup" aria-label="Speech engine">' +
            '<button class="tts-eng" data-eng="web" role="radio" title="Your device / browser voices">Standard</button>' +
            '<button class="tts-eng" data-eng="hd" role="radio" title="Neural voice running on this device (one-time download)">HD voice</button>' +
          '</div></div>' +
        '<label class="tts-row"><span class="tts-lbl">Voice</span><select class="tts-voice" aria-label="Voice"></select></label>' +
        '<div class="tts-hd" hidden>' +
          '<div class="tts-hd-status"></div>' +
          '<div class="tts-prog" hidden><div class="tts-prog-fill"></div></div>' +
          '<div class="tts-hd-acts">' +
            '<button class="tts-sbtn primary" data-act="hd-dl" hidden>Download</button>' +
            '<button class="tts-sbtn" data-act="hd-cancel" hidden>Cancel</button>' +
            '<button class="tts-sbtn" data-act="hd-rm" hidden title="Delete the downloaded HD voice data">Remove download</button>' +
          '</div>' +
        '</div>' +
        '<label class="tts-row"><span class="tts-lbl">Speed</span><input type="range" class="tts-rate" min="0.5" max="2" step="0.05" aria-label="Speed"><output class="tts-val tts-rate-v"></output></label>' +
        '<label class="tts-row"><span class="tts-lbl">Pitch</span><input type="range" class="tts-pitch" min="0.5" max="2" step="0.05" aria-label="Pitch"><output class="tts-val tts-pitch-v"></output></label>' +
      '</div>');
    p._onClose = cleanup;
    panelOpen = true;
    p.addEventListener('click', onClick);
    p.addEventListener('change', onChange);
    p.addEventListener('input', onInput);
    p.addEventListener('keydown', onKey);
    // Buttons shouldn't pull focus out of the editor (keeps the selection
    // visible and typing flowing); the panel's own keys still work via focus.
    p.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('.tts-btn, .tts-sc, .tts-eng, .tts-bar')) e.preventDefault();
    });
    watchVoices();
    renderSettings();
    updateNow();
    // Sit like a mini player near the bottom-right corner (re-checked once the
    // stylesheet has surely applied, since the first open loads it).
    var place = function () {
      if (!p.isConnected || p.style.left) return; // dragged: leave it alone
      p.style.top = Math.max(56, window.innerHeight - p.offsetHeight - 76) + 'px';
    };
    place();
    setTimeout(place, 200);
    if (!WS.ok && !hdSupported()) setStatus('Speech isn\u2019t supported here');
  }

  Cade.registerWidget({
    name: 'Read Aloud',
    description: 'Listen to your note \u2014 text-to-speech with live highlighting',
    icon: '\ud83d\udd0a',
    tags: 'tts,text to speech,speech,read aloud,voice,speak,listen,audio,narrate,accessibility',
    open: open,
    // internals for offline tests (not used by the app)
    _test: { cleanLine: cleanLine, extract: extract, buildQueue: buildQueue, rawSentences: rawSentences, voiceScore: voiceScore },
  });
})();
