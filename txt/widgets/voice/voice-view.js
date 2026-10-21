/* Voice notes in the editor — renders each ```voice block (format: voice-core.js)
 * as a player card. The card stays a card: tapping it, arrowing past it or a
 * caret landing next to it never opens it (rendered blocks are atomic for
 * cursor motion). Only ✎ shows the plain text; ✓ Done, Escape or moving the
 * selection out of the block turns it back into the card. Typing right before
 * or after a card goes on its own line instead of into the hidden fence.
 *
 * The card: ▶/❚❚, the waveform drawn from the block's glyph line (played part
 * in --accent, the rest --text-faint; tap or drag it to seek), 0:12 / 0:42,
 * and a bar with the title, speed 1× → 1.5× → 2×, ✎ edit, ⤓ download
 * (Cade.files.save) and 🗑 delete (tap twice; refused when read-only).
 *
 * Audio is fetched lazily from the file store (Cade.files.get) when ▶ / ⤓ is
 * pressed — the fetch starts on pointerdown, so when the bytes are ready by
 * the click, play() runs inside the tap (iOS needs that); otherwise a spinner,
 * then play() — if the browser refuses it there, "Tap ▶ again". get() → null:
 * the bytes haven't synced to this device yet (retry). A format this browser
 * can't decode (webm on older iOS) says so and offers the download. A deleted
 * note's bytes are kept a while so undo brings the audio back too (see trash).
 *
 * Cheap by design, like the postcard view: a StateField of the closed ```voice
 * blocks (one line scan on load; later edits that touch no ``` line only map
 * the blocks) + block-replace widgets equal by content hash. One audio plays
 * at a time; one shared rAF loop runs only while something plays; a card
 * scrolled out of the rendered range keeps playing while its block exists.
 * Object URLs are revoked and audio stopped when a card goes for good and when
 * the plugin is disabled (the ViewPlugin owns the observers, loop and players).
 * voice-core.js loads when the first card is drawn. The block finder is pure
 * and exported for node tests. */
(function () {
  'use strict';

  var OPEN_RE = /^```voice(?:[ \t]|$)/;
  var TOKEN_RE = /!\[file:([^\]\n#|]{1,120})#([a-f0-9]{16,64})(?:\|s(\d{1,12}))?\]/;
  var DUR_RE = /^(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)$/;
  var MAX_SPAN = 3000; // a change spanning more lines than this just rescans
  var RATES = [1, 1.5, 2];
  function isFence(t) { return t.charCodeAt(0) === 96 && t.lastIndexOf('```', 0) === 0; }
  function hash(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h.toString(36) + s.length.toString(36);
  }
  // The fence line's facts (voice-core parseInfo, inlined so the field needs no core).
  function head(t) {
    var re = /"([^"]*)"?|(\S+)/g, s = t.slice(3), m, first = true, o = { dur: 0, title: '' }, gotDur = false;
    while ((m = re.exec(s))) {
      if (first) { first = false; continue; }
      if (m[1] != null) {
        if (!o.title) o.title = m[1].replace(/[\r\n\t]+/g, ' ').replace(/[`"]/g, '\'').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
        continue;
      }
      var d = gotDur ? null : DUR_RE.exec(m[2]);
      if (d && !(d[1] && +d[2] > 59)) { o.dur = (d[1] ? +d[1] * 3600 : 0) + +d[2] * 60 + +d[3]; gotDur = true; }
    }
    return o;
  }
  function mkBlock(doc, from, to) {
    var b = head(doc.lineAt(from).text), text = doc.sliceString(from, to), m = TOKEN_RE.exec(text);
    b.from = from; b.to = to; b.text = text; b.h = hash(text);
    b.ok = !!m; b.name = m ? m[1] : ''; b.fh = m ? m[2] : ''; b.size = m && m[3] ? +m[3] : null;
    return b;
  }
  // Whole doc: n = lines starting with ```voice (paired or not); blocks = closed voice fences.
  function scan(doc) {
    var blocks = [], n = 0, open = -1, isV = false, pos = 0;
    for (var it = doc.iterLines(); !it.next().done;) {
      var t = it.value, from = pos;
      pos += t.length + 1;
      if (t.charCodeAt(0) !== 96 || !isFence(t)) continue;
      var v = OPEN_RE.test(t);
      if (v) n++;
      if (open < 0) { open = from; isV = v; }
      else { if (isV) blocks.push(mkBlock(doc, open, from + t.length)); open = -1; }
    }
    return { n: n, blocks: blocks };
  }
  // Which block is shown raw ("1"): only the one opened with ✎ (it starts at
  // `edit`), and only while a selection end is still inside it.
  function openKey(sel, blocks, edit) {
    var k = '';
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i], on = false;
      if (b.from === edit) {
        for (var j = 0; j < sel.ranges.length && !on; j++) {
          var r = sel.ranges[j];
          on = (r.head >= b.from && r.head <= b.to) || (r.anchor >= b.from && r.anchor <= b.to);
        }
      }
      k += on ? '1' : '0';
    }
    return k;
  }
  function fmt(sec) {
    var s = Math.max(0, Math.floor(+sec || 0)), m = Math.floor(s / 60);
    s %= 60;
    return m >= 60 ? Math.floor(m / 60) + ':' + ((m % 60) < 10 ? '0' : '') + (m % 60) + ':' + (s < 10 ? '0' : '') + s : m + ':' + (s < 10 ? '0' : '') + s;
  }
  function nextRate(r) { var i = RATES.indexOf(r); return RATES[(i + 1) % RATES.length]; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { scan: scan, openKey: openKey, head: head, hash: hash, fmt: fmt, nextRate: nextRate, OPEN_RE: OPEN_RE };
    return;
  }
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade, CM = Cade.CM;
  if (!CM || !CM.StateField || !CM.Decoration || !CM.WidgetType || !CM.EditorView || !CM.ViewPlugin) return;
  Cade.loadCSS('voice-view.css');
  var StateField = CM.StateField, Decoration = CM.Decoration, WidgetType = CM.WidgetType, EditorView = CM.EditorView;
  var editFx = CM.StateEffect.define();   // value: the from of the block to show raw, or -1
  var CORE_URL = Cade.asset('voice-core.js');

  function loadCore() {
    if (window.__cadeVoiceCore) return Promise.resolve(window.__cadeVoiceCore);
    if (!window.__cadeVoiceCoreP) {
      window.__cadeVoiceCoreP = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = CORE_URL;
        s.onload = function () { if (window.__cadeVoiceCore) res(window.__cadeVoiceCore); else { window.__cadeVoiceCoreP = null; rej(new Error('voice core missing')); } };
        s.onerror = function () { window.__cadeVoiceCoreP = null; rej(new Error('voice core failed to load')); };
        document.head.appendChild(s);
      });
    }
    return window.__cadeVoiceCoreP;
  }
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 1800); } catch (e) {} }
  function dpr() { return Math.min(3, window.devicePixelRatio || 1); }

  // ---- the audio bytes: a small cache of files.get() results by file hash ----
  // { p, done, r ({ blob, mime, name } | null = not on this device yet), err }
  var blobs = new Map();
  function fetchBlob(fh) {
    var c = blobs.get(fh);
    if (c) { blobs.delete(fh); blobs.set(fh, c); return c; }
    c = { p: null, done: false, r: null, err: null };
    var files = Cade.files;
    c.p = (files && files.get ? Promise.resolve(fh).then(files.get.bind(files)) : Promise.reject(new Error('nofiles'))).then(function (r) {
      c.done = true; c.r = r || null;
      if (!r && blobs.get(fh) === c) blobs.delete(fh);       // a retry asks again
      return c.r;
    }, function (e) {
      c.done = true; c.err = e || new Error('decode');
      if (blobs.get(fh) === c) blobs.delete(fh);
      throw c.err;
    });
    c.p.catch(function () {});
    blobs.set(fh, c);
    while (blobs.size > 3) blobs.delete(blobs.keys().next().value);
    return c;
  }

  // ---- players: one per file hash, outliving a card that scrolls away while it plays ----
  var players = new Map(), live = new Set(), cur = null, raf = 0, lastRate = 1, colors = null;
  function Player(b) { this.fh = b.fh; this.name = b.name; this.dur = b.dur || 0; this.pos = 0; this.rate = lastRate; this.audio = null; this.url = null; this.el = null; this.busy = false; this.msg = ''; this.dead = false; }
  function durOf(p) { var d = p.audio && p.audio.duration; return d > 0 && isFinite(d) ? d : p.dur; }
  function playing(p) { return !!(p && p.audio && !p.audio.paused && !p.audio.ended && !p.audio.error); }
  function playerFor(s) {
    var p = s.p;
    if (!p || p.dead) { p = players.get(s.b.fh); if (!p || p.dead) { p = new Player(s.b); players.set(p.fh, p); } }
    attach(p, s.el);
    return p;
  }
  function attach(p, el) {
    if (p.el === el) return;
    if (p.el && p.el.__vn) { p.el.__vn.p = null; idle(p.el); }
    p.el = el;
    if (el && el.__vn) el.__vn.p = p;
    render(p);
  }
  function dispose(p) {
    if (!p || p.dead) return;
    p.dead = true;
    if (cur === p) cur = null;
    var a = p.audio;
    if (a) {
      try { a.pause(); } catch (e) {}
      a.onplay = a.onpause = a.onended = a.onerror = a.ondurationchange = a.onloadedmetadata = null;
      try { a.removeAttribute('src'); a.load(); } catch (e) {}
    }
    if (p.url) { try { URL.revokeObjectURL(p.url); } catch (e) {} }
    p.audio = null; p.url = null;
    if (p.el && p.el.__vn) { p.el.__vn.p = null; idle(p.el); }
    p.el = null;
    if (players.get(p.fh) === p) players.delete(p.fh);
  }
  function pauseAll(except) { players.forEach(function (p) { if (p !== except && playing(p)) p.audio.pause(); }); }
  function onOtherPlay(e) { if (!e.detail || e.detail.src !== 'view') pauseAll(null); }

  function canPlay(a, mime) {
    if (!mime || !a.canPlayType) return true;
    try { return a.canPlayType(mime) !== '' || a.canPlayType(mime.split(';')[0]) !== ''; } catch (e) { return true; }
  }
  function ensureAudio(p, r) {
    if (p.audio) return p.audio;
    var a = document.createElement('audio'), mime = r.mime || (r.blob && r.blob.type) || '';
    if (!canPlay(a, mime)) { p.msg = 'bad'; p.ext = extName(p.name); render(p); return null; }
    a.preload = 'auto';
    p.url = URL.createObjectURL(r.blob);
    a.onloadedmetadata = function () {
      if (p.pos > 0.05 && Math.abs(a.currentTime - p.pos) > 0.05) { try { a.currentTime = Math.min(p.pos, Math.max(0, durOf(p) - 0.05)); } catch (e) {} }
      render(p);
    };
    a.ondurationchange = function () { render(p); };
    a.onplay = function () { cur = p; p.msg = ''; render(p); loop(); };
    a.onpause = function () { p.pos = a.currentTime || p.pos; render(p); if (!p.el) dispose(p); };
    a.onended = function () { p.pos = 0; try { a.currentTime = 0; } catch (e) {} render(p); if (!p.el) dispose(p); };
    a.onerror = function () {
      var code = a.error && a.error.code;
      try { a.pause(); } catch (e) {}                       // a failed element can still claim it plays
      if (code === 3 || code === 4) { p.msg = 'bad'; p.ext = extName(p.name); }
      else p.msg = 'broken';
      p.busy = false; render(p);
    };
    a.src = p.url;
    a.playbackRate = a.defaultPlaybackRate = p.rate;
    p.audio = a;
    return a;
  }
  function extName(n) { var m = /\.([a-z0-9]{2,5})$/i.exec(n || ''); return m ? '.' + m[1].toLowerCase() : 'this'; }
  function start(p) {
    var a = p.audio;
    if (!a) return;
    pauseAll(p);
    try { window.dispatchEvent(new CustomEvent('cade-voice-play', { detail: { src: 'view' } })); } catch (e) {}
    try { a.playbackRate = p.rate; } catch (e) {}
    var pr;
    try { pr = a.play(); } catch (e) { pr = Promise.reject(e); }
    if (pr && pr.then) pr.then(null, function (e) {
      if (p.dead) return;
      var n = e && e.name;
      if (n === 'AbortError') return;                      // paused before it started
      p.msg = n === 'NotAllowedError' ? 'tap' : n === 'NotSupportedError' ? 'bad' : 'broken';
      if (p.msg === 'bad') p.ext = extName(p.name);
      render(p);
    });
  }
  // The bytes are in (or not): play — inside the tap when they were ready by the click.
  function got(p, c) {
    if (p.dead) return;
    p.busy = false;
    if (c.err) { p.msg = c.err.message === 'nofiles' ? 'nofiles' : 'broken'; render(p); return; }
    if (!c.r) { p.msg = 'sync'; render(p); return; }
    if (ensureAudio(p, c.r)) start(p);
  }
  function press(s) {
    var p = playerFor(s);
    if (p.audio) { if (!playing(p)) start(p); else { p.audio.pause(); render(p); } return; }
    if (p.busy || !s.b.fh) return;
    p.msg = '';
    var c = fetchBlob(s.b.fh);
    if (c.done) { got(p, c); return; }
    p.busy = true; render(p);
    c.p.then(function () { got(p, c); }, function () { got(p, c); });
  }
  function download(s, btn) {
    var c = fetchBlob(s.b.fh), name = s.b.name || 'voice-note';
    function save() {
      if (btn) btn.classList.remove('cm-vn-busy');
      if (c.err) { toast(c.err.message === 'nofiles' ? 'The file store isn’t available' : 'The recording’s data is damaged', 'error', 2600); return; }
      if (!c.r) { toast('Still syncing to this device — try again in a moment', 'info', 2600); return; }
      try { Cade.files.save(c.r.blob, name); } catch (e) { toast('Couldn’t save the recording', 'error'); }
    }
    if (c.done) { save(); return; }
    if (btn) btn.classList.add('cm-vn-busy');
    c.p.then(save, save);
  }

  // ---- drawing ----
  function themeColors(el) {
    if (colors) return colors;
    var cs = getComputedStyle(el);
    colors = { played: (cs.getPropertyValue('--accent') || '').trim() || '#0f9598', rest: (cs.getPropertyValue('--text-faint') || '').trim() || '#a8a29e' };
    return colors;
  }
  function levelsOf(s, VC) {
    if (!s.levels) {
      var v = VC.parseBlock(s.b.text), lv = v && v.levels.length ? v.levels : [];
      if (!lv.length) for (var i = VC.glyphCount(s.b.dur); i > 0; i--) lv.push(0);
      s.levels = lv;
    }
    return s.levels;
  }
  function paint(el, force) {
    var s = el.__vn;
    if (!s || !el.isConnected) return;
    var VC = window.__cadeVoiceCore;
    if (!VC) { loadCore().then(function () { paint(el, true); }, function () {}); return; }
    var cv = s.cv, r = dpr(), w = Math.round(cv.clientWidth * r), h = Math.round(cv.clientHeight * r);
    if (!w || !h) return;
    var p = s.p, d = p ? durOf(p) : s.b.dur, prog = p && d > 0 ? Math.min(1, p.pos / d) : 0, px = Math.round(prog * w);
    if (!force && cv.width === w && cv.height === h && s.px === px) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    s.px = px;
    var c = themeColors(el);
    VC.drawWave(cv.getContext('2d'), levelsOf(s, VC), { w: w, h: h, dpr: r, progress: prog, played: c.played, rest: c.rest });
  }
  var MSG = {
    sync: 'Still syncing to this device', bad: '', broken: 'The recording’s data is damaged',
    tap: 'Tap ▶ again', nofiles: 'The file store isn’t available'
  };
  function setMsg(s, key, p) {
    if (s.msgKey === key + (p && p.ext || '')) return;
    s.msgKey = key + (p && p.ext || '');
    var el = s.msg;
    el.textContent = '';
    s.el.classList.toggle('cm-vn-hasmsg', !!key);
    if (!key) return;
    var t = document.createElement('span');
    t.textContent = key === 'bad' ? 'Can’t play ' + (p.ext || 'this') + ' here' : MSG[key];
    t.title = key === 'bad' ? 'This browser can’t play ' + (p.ext || 'this') + ' recordings — download it to play it elsewhere' : t.textContent;
    el.appendChild(t);
    if (key === 'sync' || key === 'bad') {
      var b = document.createElement('button');
      b.type = 'button'; b.tabIndex = -1;
      b.setAttribute('data-act', key === 'sync' ? 'retry' : 'dl');
      b.textContent = key === 'sync' ? 'Retry' : '⤓ Download';
      el.appendChild(b);
    }
  }
  // The total shown is the block's own (what the text says); seeking uses the real length.
  function setTime(s, pos, d) {
    var t = fmt(pos) + ' / ' + fmt(Math.round(s.b.dur > 0 ? s.b.dur : d));
    if (s.timeTxt !== t) { s.timeTxt = t; s.time.textContent = t; }
  }
  function render(p) {
    var el = p.el, s = el && el.__vn;
    if (!s) return;
    var on = playing(p);
    s.el.classList.toggle('cm-vn-on', on);
    s.el.classList.toggle('cm-vn-loading', !!p.busy);
    s.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
    s.play.title = on ? 'Pause' : 'Play';
    s.rate.textContent = p.rate + '×';
    setTime(s, p.pos, durOf(p));
    setMsg(s, p.msg, p);
    paint(el);
  }
  function idle(el) {
    var s = el.__vn;
    if (!s) return;
    s.el.classList.remove('cm-vn-on', 'cm-vn-loading');
    s.play.setAttribute('aria-label', 'Play'); s.play.title = 'Play';
    s.rate.textContent = lastRate + '×';
    setTime(s, 0, s.b.dur);
    setMsg(s, '', null);
    paint(el);
  }
  // One loop, only while something plays.
  function loop() { if (!raf) raf = requestAnimationFrame(tick); }
  function tick() {
    raf = 0;
    var p = cur;
    if (!playing(p)) return;
    p.pos = p.audio.currentTime;
    if (p.el && p.el.__vn) { setTime(p.el.__vn, p.pos, durOf(p)); paint(p.el); }
    raf = requestAnimationFrame(tick);
  }
  function seek(s, clientX) {
    var r = s.wave.getBoundingClientRect();
    if (!r.width) return;
    var p = playerFor(s), f = Math.max(0, Math.min(1, (clientX - r.left) / r.width)), d = durOf(p);
    p.pos = f * d;
    if (p.audio) { try { p.audio.currentTime = Math.min(p.pos, Math.max(0, d - 0.05)); } catch (e) {} }
    setTime(s, p.pos, d);
    paint(s.el);
  }

  // ---- observers (made by the first card, dropped with the plugin) ----
  var ro = null, mo = null, moRaf = 0;
  function observe(el) {
    if (typeof ResizeObserver !== 'function') { requestAnimationFrame(function () { paint(el, true); }); return; }
    if (!ro) ro = new ResizeObserver(function (es) { for (var i = 0; i < es.length; i++) { var c = es[i].target.closest('.cm-vn'); if (c) paint(c); } });
    ro.observe(el.__vn.cv);
  }
  function watchTheme() {
    if (mo || typeof MutationObserver !== 'function') return;
    mo = new MutationObserver(function () {
      if (moRaf) return;
      moRaf = requestAnimationFrame(function () {
        moRaf = 0;
        var old = colors;
        colors = null;
        var any = live.values().next().value;
        if (!any) return;
        var c = themeColors(any);
        if (old && old.played === c.played && old.rest === c.rest) return;
        live.forEach(function (el) { paint(el, true); });
      });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
  }
  function shutdown() {
    gen++;
    Array.from(players.values()).forEach(dispose);
    players.clear(); blobs.clear(); live.clear(); trash.clear();
    timers.forEach(clearTimeout); timers.clear();
    if (raf) cancelAnimationFrame(raf);
    if (moRaf) cancelAnimationFrame(moRaf);
    raf = moRaf = 0; cur = null; colors = null;
    if (ro) { ro.disconnect(); ro = null; }
    if (mo) { mo.disconnect(); mo = null; }
  }

  // ---- undo after the file store's clean-up ----
  // The core drops a file's bytes (here and on the server) a few seconds after
  // the last note holding its token loses it. So a deleted voice note keeps its
  // bytes here for a while (the last 3, 15 minutes); when undo (or a paste)
  // brings the block back and the bytes are gone, they are stored again —
  // same content, same hash, the token in the text is valid again.
  var trash = new Map(), timers = new Set(), gen = 0, TRASH_MS = 15 * 60 * 1000;
  function fhs(blocks) {
    var o = {};
    for (var i = 0; i < blocks.length; i++) if (blocks[i].ok) o[blocks[i].fh] = blocks[i].name;
    return o;
  }
  function stash(fh, name) {
    var g = gen, c = blobs.get(fh), t0 = Date.now();
    function put(r) {
      if (!r || g !== gen) return;
      trash.delete(fh);
      trash.set(fh, { r: r, name: name, at: t0 });
      while (trash.size > 3) trash.delete(trash.keys().next().value);
    }
    trash.forEach(function (t, k) { if (t0 - t.at > TRASH_MS) trash.delete(k); });
    if (c && c.done && c.r) put(c.r);
    else if (Cade.files && Cade.files.get) Promise.resolve(fh).then(Cade.files.get.bind(Cade.files)).then(put, function () {});
  }
  // Checked now and once more after the core's clean-up delay (2.5 s + 4 s), in
  // case a clean-up pass was already under way when the block came back.
  function revive(fh, view) {
    var t = trash.get(fh), g = gen;
    trash.delete(fh);
    if (!t || Date.now() - t.at > TRASH_MS || !Cade.files || !Cade.files.store) return;
    function check() {
      if (g !== gen) return;
      var v = view.state.field(field, false);
      if (!v || !fhs(v.blocks)[fh]) return;                // gone again
      Promise.resolve(fh).then(Cade.files.get.bind(Cade.files)).then(function (r) {
        if (r || g !== gen) return;
        var name = t.name || t.r.name, f;
        try { f = new File([t.r.blob], name, { type: t.r.mime || t.r.blob.type }); } catch (e) { f = t.r.blob; }
        return Cade.files.store(f, name);
      }).catch(function () {});
    }
    check();
    var tm = setTimeout(function () { timers.delete(tm); check(); }, 7000);
    timers.add(tm);
  }

  // ---- the card ----
  var ICON = {
    play: '<svg class="cm-vn-i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>' +
      '<svg class="cm-vn-i-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/></svg>' +
      '<svg class="cm-vn-i-spin" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    dl: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 17v3h16v-3"/></svg>',
    del: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function metaOf(b) {
    var m = /voice-(\d{4})-(\d\d)-(\d\d)-(\d\d)(\d\d)/.exec(b.name || ''), out = [];
    if (m && +m[2] >= 1 && +m[2] <= 12) out.push(+m[3] + ' ' + MON[+m[2] - 1] + (+m[1] !== new Date().getFullYear() ? ' ' + m[1] : '') + ', ' + m[4] + ':' + m[5]);
    if (b.size != null && Cade.files && Cade.files.fmtBytes) out.push(Cade.files.fmtBytes(b.size));
    return out.join(' · ');
  }
  function Card(b) { this.b = b; this.h = b.h; }
  Card.prototype = Object.create(WidgetType.prototype);
  Card.prototype.constructor = Card;
  Card.prototype.eq = function (o) { return o.h === this.h; };
  Object.defineProperty(Card.prototype, 'estimatedHeight', { get: function () { return 128; } });
  Card.prototype.toDOM = function (view) {
    var b = this.b, wrap = document.createElement('div');
    wrap.className = 'cm-vn';
    wrap.setAttribute('contenteditable', 'false');
    wrap.innerHTML = '<div class="cm-vn-box"><div class="cm-vn-main">' +
      '<button type="button" tabindex="-1" class="cm-vn-play" data-act="play" aria-label="Play" title="Play">' + ICON.play + '</button>' +
      '<div class="cm-vn-mid"><div class="cm-vn-wave" data-act="seek" title="Tap or drag to seek"><canvas></canvas></div>' +
      '<div class="cm-vn-row"><span class="cm-vn-time"></span><span class="cm-vn-meta"></span><span class="cm-vn-msg" aria-live="polite"></span></div></div></div>' +
      '<div class="cm-vn-bar"><span class="cm-vn-cap"></span><span class="cm-vn-acts">' +
      '<button type="button" tabindex="-1" class="cm-vn-rate" data-act="rate" title="Playback speed" aria-label="Playback speed"></button>' +
      '<button type="button" tabindex="-1" data-act="edit" title="Edit the text" aria-label="Edit">' + ICON.edit + '</button>' +
      '<button type="button" tabindex="-1" data-act="dl" title="Download the recording" aria-label="Download">' + ICON.dl + '</button>' +
      '<button type="button" tabindex="-1" data-act="del" title="Delete this voice note" aria-label="Delete">' + ICON.del + '</button></span></div></div>';
    var s = wrap.__vn = {
      b: b, view: view, el: wrap, p: null, levels: null, px: -1, timeTxt: '', msgKey: '',
      play: wrap.querySelector('.cm-vn-play'), wave: wrap.querySelector('.cm-vn-wave'), cv: wrap.querySelector('canvas'),
      time: wrap.querySelector('.cm-vn-time'), msg: wrap.querySelector('.cm-vn-msg'), rate: wrap.querySelector('.cm-vn-rate')
    };
    wrap.querySelector('.cm-vn-cap').textContent = b.title || 'Voice note';
    wrap.querySelector('.cm-vn-meta').textContent = metaOf(b);
    wrap.setAttribute('aria-label', 'Voice note: ' + (b.title || 'untitled') + ', ' + fmt(b.dur));
    idle(wrap);
    var armed = 0, drag = null;
    wrap.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus / no caret drag
    wrap.addEventListener('pointerdown', function (e) {
      var t = e.target.closest ? e.target.closest('[data-act]') : null, act = t && t.getAttribute('data-act');
      // start fetching on press, so the click can play / save inside the tap
      if (wrap.__vn && (act === 'play' || act === 'retry' || act === 'dl') && s.b.fh && !(s.p && s.p.audio)) fetchBlob(s.b.fh);
    });
    // Seeking: a mouse seeks at once and drags; a finger seeks on lift, or once
    // it moves sideways — a vertical swipe stays a scroll (touch-action: pan-y).
    function grab(e) { drag.on = true; try { s.wave.setPointerCapture(e.pointerId); } catch (x) {} }
    s.wave.addEventListener('pointerdown', function (e) {
      if (!wrap.__vn || (e.pointerType === 'mouse' && e.button !== 0)) return;
      drag = { id: e.pointerId, x0: e.clientX, on: false };
      if (e.pointerType === 'mouse') { grab(e); seek(s, e.clientX); }
    });
    s.wave.addEventListener('pointermove', function (e) {
      if (!drag || drag.id !== e.pointerId || !wrap.__vn) return;
      if (!drag.on && Math.abs(e.clientX - drag.x0) > 6) grab(e);
      if (drag.on) seek(s, e.clientX);
    });
    s.wave.addEventListener('pointerup', function (e) {
      if (!drag || drag.id !== e.pointerId) return;
      drag = null;
      try { s.wave.releasePointerCapture(e.pointerId); } catch (x) {}
      if (wrap.__vn) seek(s, e.clientX);
    });
    s.wave.addEventListener('pointercancel', function () { drag = null; });
    wrap.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (!wrap.__vn) return;
      var btn = e.target.closest ? e.target.closest('[data-act]') : null, act = btn ? btn.getAttribute('data-act') : '';
      if (!act || act === 'seek') return;
      if (act === 'play' || act === 'retry') { press(s); return; }
      if (act === 'rate') {
        var p = playerFor(s);
        p.rate = lastRate = nextRate(p.rate);
        if (p.audio) { try { p.audio.playbackRate = p.audio.defaultPlaybackRate = p.rate; } catch (x) {} }
        render(p);
        return;
      }
      if (act === 'dl') { download(s, btn); return; }
      var v = s.view, from;
      try { from = v.posAtDOM(wrap); } catch (x) { return; }
      var st = v.state, doc = st.doc;
      if (from < 0 || from > doc.length) return;
      var L = doc.lineAt(from);
      if (!OPEN_RE.test(L.text)) return;
      var blk = null, fv = st.field(field, false);
      if (fv) for (var i = 0; i < fv.blocks.length; i++) if (fv.blocks[i].from === L.from) blk = fv.blocks[i];
      if (!blk) return;
      if (act === 'edit') {
        v.dispatch({ selection: { anchor: Math.min(doc.length, L.to + 1) }, effects: editFx.of(blk.from), scrollIntoView: true, userEvent: 'select' });
        v.focus();
      } else if (act === 'del') {
        if (st.readOnly) { toast('Read-only mode — editing is locked', 'error'); return; }
        if (!armed) {
          armed = setTimeout(function () { armed = 0; btn.classList.remove('cm-vn-armed'); btn.title = 'Delete this voice note'; }, 3000);
          btn.classList.add('cm-vn-armed'); btn.title = 'Tap again to delete';
          return;
        }
        clearTimeout(armed); armed = 0;
        var to = blk.to < doc.length && doc.sliceString(blk.to, blk.to + 1) === '\n' ? blk.to + 1 : blk.to;
        v.dispatch({ changes: { from: blk.from, to: to }, userEvent: 'delete' });
        toast('Voice note deleted — undo brings it back', 'info');
      }
    });
    wrap.__vnDisarm = function () { if (armed) { clearTimeout(armed); armed = 0; } };
    // a player still going for this recording (the card scrolled back in, or the text was edited)
    var p0 = b.fh ? players.get(b.fh) : null;
    if (p0 && !p0.dead && !p0.el) attach(p0, wrap);
    live.add(wrap);
    watchTheme();
    observe(wrap);
    return wrap;
  };
  Card.prototype.updateDOM = function () { return false; };
  Card.prototype.ignoreEvent = function () { return true; };
  Card.prototype.destroy = function (dom) {
    live.delete(dom);
    if (dom.__vnDisarm) dom.__vnDisarm();
    var s = dom.__vn;
    if (!s) return;
    if (ro) { try { ro.unobserve(s.cv); } catch (e) {} }
    var p = s.p;
    dom.__vn = null;
    if (p && p.el === dom) { p.el = null; if (!playing(p)) dispose(p); }
  };

  // ---- state field ---------------------------------------------------------------
  // Lines an edit touched (old and new text) — any of them a ``` line?
  function fenceTouched(tr) {
    var hit = false, od = tr.startState.doc, nd = tr.state.doc;
    tr.changes.iterChanges(function (fa, ta, fb, tb) {
      if (hit) return;
      var i, a = od.lineAt(fa).number, b = od.lineAt(ta).number;
      if (b - a > MAX_SPAN) { hit = true; return; }
      for (i = a; i <= b && !hit; i++) if (isFence(od.line(i).text)) hit = true;
      a = nd.lineAt(fb).number; b = nd.lineAt(tb).number;
      if (b - a > MAX_SPAN) { hit = true; return; }
      for (i = a; i <= b && !hit; i++) if (isFence(nd.line(i).text)) hit = true;
    });
    return hit;
  }
  // A note without voice notes: did this edit write a ```voice line?
  function voiceTyped(tr) {
    var hit = false, nd = tr.state.doc;
    tr.changes.iterChanges(function (fa, ta, fb, tb) {
      if (hit) return;
      var a = nd.lineAt(fb).number, b = nd.lineAt(tb).number;
      if (b - a > MAX_SPAN) { hit = true; return; }
      for (var i = a; i <= b && !hit; i++) { var t = nd.line(i).text; if (t.charCodeAt(0) === 96 && OPEN_RE.test(t)) hit = true; }
    });
    return hit;
  }
  // No fence line changed: blocks keep their pairing; map them, re-read the one an edit hit.
  function remap(tr, blocks) {
    var ch = tr.changes, nd = tr.state.doc, out = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i], from = ch.mapPos(b.from, 1), to = ch.mapPos(b.to, -1);
      if (ch.touchesRange(b.from, b.to)) { out.push(mkBlock(nd, from, to)); continue; }
      if (from === b.from && to === b.to) { out.push(b); continue; }
      var c = {}; for (var k in b) c[k] = b[k];
      c.from = from; c.to = to;
      out.push(c);
    }
    return out;
  }
  // ✓ Done at the end of the opening fence while a block is shown raw.
  function Done(from) { this.from = from; }
  Done.prototype = Object.create(WidgetType.prototype);
  Done.prototype.constructor = Done;
  Done.prototype.eq = function (o) { return o.from === this.from; };
  Done.prototype.toDOM = function (view) {
    var b = document.createElement('button');
    b.type = 'button'; b.tabIndex = -1; b.className = 'cm-vn-done'; b.textContent = '\u2713 Done';
    b.title = 'Show the player again (Esc)';
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); closeEdit(view); });
    return b;
  };
  Done.prototype.ignoreEvent = function () { return true; };
  // Back to the card: caret just after the block (on the next line when there is one).
  function closeEdit(view) {
    var v = view.state.field(field, false);
    if (!v || v.edit < 0) return false;
    var b = null;
    for (var i = 0; i < v.blocks.length; i++) if (v.blocks[i].from === v.edit) b = v.blocks[i];
    var doc = view.state.doc, at = b ? (b.to < doc.length ? b.to + 1 : b.to) : view.state.selection.main.head;
    view.dispatch({ selection: { anchor: at }, effects: editFx.of(-1), scrollIntoView: true, userEvent: 'select' });
    return true;
  }
  // Decorations, and the rendered cards alone as the atomic ranges.
  function build(doc, blocks, key) {
    var out = [], cards = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b.ok) continue;
      if (key.charAt(i) === '0') { var c = Decoration.replace({ widget: new Card(b), block: true }).range(b.from, b.to); out.push(c); cards.push(c); }
      else out.push(Decoration.widget({ widget: new Done(b.from), side: 1 }).range(doc.lineAt(b.from).to));
    }
    return { deco: out.length ? Decoration.set(out, true) : Decoration.none, atom: cards.length ? Decoration.set(cards) : Decoration.none };
  }
  function fxEdit(tr, edit) {
    for (var i = 0; i < tr.effects.length; i++) if (tr.effects[i].is(editFx)) edit = tr.effects[i].value;
    return edit;
  }
  function compute(v, st, tr) {
    var sc, edit = v ? v.edit : -1;
    if (tr && tr.docChanged && edit >= 0) edit = tr.changes.mapPos(edit, 1);
    if (tr && tr.effects.length) edit = fxEdit(tr, edit);
    if (!v) sc = scan(st.doc);
    else if (tr.docChanged) {
      if (!v.n) { if (!voiceTyped(tr)) return v; sc = scan(st.doc); }  // the common case: no voice notes
      else if (fenceTouched(tr)) sc = scan(st.doc);
      else sc = { n: v.n, blocks: v.blocks.length ? remap(tr, v.blocks) : v.blocks };
    } else if ((tr.selection || edit !== v.edit) && v.blocks.length) sc = v;
    else return v;
    if (!sc.blocks.length) return v && !v.blocks.length && v.n === sc.n ? v : { n: sc.n, blocks: sc.blocks, key: '', edit: -1, deco: Decoration.none, atom: Decoration.none };
    var key = openKey(st.selection, sc.blocks, edit);
    if (key.indexOf('1') < 0) edit = -1;                    // the selection left it: a card again
    if (v && sc === v && key === v.key && edit === v.edit) return v;   // the caret moved; nothing opened or closed
    var d = build(st.doc, sc.blocks, key);
    return { n: sc.n, blocks: sc.blocks, key: key, edit: edit, deco: d.deco, atom: d.atom };
  }
  var field = StateField.define({
    create: function (st) { return compute(null, st, null); },
    update: function (v, tr) { return compute(v, tr.state, tr); },
    provide: function (f) {
      return [
        EditorView.decorations.from(f, function (v) { return v.deco; }),
        // cursor motion steps over a rendered card instead of into its text
        EditorView.atomicRanges.of(function (view) { var v = view.state.field(f, false); return v ? v.atom : Decoration.none; }),
      ];
    },
  });
  // Typing right at a card's edge (the caret before / after it) starts its own
  // line, so it never lands inside the hidden fence line.
  var edgeGuard = CM.EditorState.transactionFilter.of(function (tr) {
    if (!tr.docChanged || !tr.isUserEvent('input') || tr.isUserEvent('input.type.compose')) return tr;
    var v = tr.startState.field(field, false);
    if (!v || !v.blocks.length) return tr;
    var n = 0, fix = null;
    tr.changes.iterChanges(function (fa, ta, fb, tb, ins) {
      n++;
      if (fa !== ta || !ins.length) return;
      var t = ins.toString();
      for (var i = 0; i < v.blocks.length; i++) {
        var b = v.blocks[i];
        if (!b.ok || v.key.charAt(i) !== '0') continue;
        if (fa === b.to && t.charAt(0) !== '\n') fix = { at: fa, insert: '\n' + t, caret: fa + 1 + t.length };
        else if (fa === b.from && t.charAt(t.length - 1) !== '\n') fix = { at: fa, insert: t + '\n', caret: fa + t.length };
      }
    });
    if (!fix || n !== 1) return tr;
    return { changes: { from: fix.at, insert: fix.insert }, selection: { anchor: fix.caret }, scrollIntoView: true, userEvent: 'input.type' };
  });
  var escKey = CM.Prec.high(CM.keymap.of([{ key: 'Escape', run: closeEdit }]));
  // The plugin's lifetime: listeners while enabled; everything stopped and freed when it's turned off.
  var life = CM.ViewPlugin.define(function (view) {
    window.addEventListener('cade-voice-play', onOtherPlay);
    return {
      update: function (u) {
        if (!u.docChanged) return;
        var a = u.startState.field(field, false), b = u.state.field(field, false);
        if (!a || !b || a.blocks === b.blocks) return;
        var was = fhs(a.blocks), now = fhs(b.blocks), k;
        for (k in was) if (!now[k]) stash(k, was[k]);
        for (k in now) if (!was[k] && trash.has(k)) revive(k, view);
        // a recording playing with no card on screen stops once its block is gone
        players.forEach(function (p) { if (!p.el && !now[p.fh]) dispose(p); });
      },
      destroy: function () {
        window.removeEventListener('cade-voice-play', onOtherPlay);
        shutdown();
      },
    };
  });

  Cade.registerPlugin({ id: 'voice-view', ext: [field, edgeGuard, escKey, life] });
})();
