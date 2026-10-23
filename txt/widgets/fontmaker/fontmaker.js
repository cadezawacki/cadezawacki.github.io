/* Font Maker — turn your handwriting into a real font (maths and font build:
 * fontmaker-core.js; the .otf itself is written by the vendored opentype.js).
 *
 * Draw tab: a guided glyph strip (quick set A–Z a–z first, then digits and
 * punctuation, with progress), one drawing square with cap / x-height /
 * baseline / descender guides, pointer events with pen pressure (Apple
 * Pencil palm rejection: once a pen is seen, fingers stop drawing), undo,
 * clear, prev / next, up to three versions per letter, and a live preview
 * word. Strokes are stored as vectors (Cade.idbStore, one record per font
 * plus an index) — never bitmaps — so work survives reloads.
 * Font tab: name, stroke weight, letter spacing, slant, space width; the font
 * is rebuilt (debounced) and registered with the FontFace API for this
 * session, shown in a sample, optionally used for the note's text, and saved
 * as .otf / .woff (share sheet on touch devices, download elsewhere). Fonts
 * can be created, renamed, duplicated, deleted, and opted into Sync
 * (Cade.syncedBlob 'fontmaker', 256 KB cap — strokes are small).
 * Image tab: text (the note's selection by default) set in the font onto
 * plain / lined / grid / kraft / transparent paper with alignment, line height
 * and a little wobble, as a story / square / A5 card PNG: share, download,
 * copy or attach into the note (Cade.files.attach).
 *
 * Nothing runs until the panel opens; close removes every listener, timer and
 * observer (a registered FontFace and the "note in this font" style stay for
 * the session — that is what the user asked for). */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var BASE = (Cade.baseURL && Cade.baseURL()) || './txt/widgets/fontmaker/';
  Cade.loadCSS('fontmaker.css');

  var META = {
    name: 'Font Maker',
    description: 'Turn your handwriting into a real font — draw each letter with a finger or Apple Pencil, save it as an .otf, use it in the app and make pictures of text in it',
    icon: '✍️',
    tags: 'font,font maker,handwriting,hand writing,typeface,otf,woff,opentype,glyph,letters,lettering,calligraphy,pencil,apple pencil,draw,image,png,card'
  };
  var PREFS_FIELDS = [
    { key: 'ghost', type: 'toggle', label: 'Show a faint letter to trace over', default: true },
    { key: 'pencil', type: 'toggle', label: 'Pencil only once a pen is used', default: true, hint: 'On an iPad: after the Apple Pencil touches the drawing square, fingers and palms no longer draw' },
    { key: 'autoNext', type: 'toggle', label: 'Go to the next letter after a pause', default: false, hint: '1.5 s after you lift the pen' },
    { key: 'preview', type: 'text', label: 'Preview word', default: 'Hamburgefonts', placeholder: 'Hamburgefonts', maxLength: 40 }
  ];
  var PANEL_ID = 'fontmaker-panel', IDX_KEY = 'fontmaker:index', FONT_KEY = 'fontmaker:font:', LAST_KEY = 'cade-fontmaker-last', IMG_KEY = 'cade-fontmaker-img';
  var SYNC_MAX = 180000;   // JSON chars; the encrypted blob must stay under 256 KB

  function prefsOf(id, fields) {
    if (Cade.prefs) return Cade.prefs(id);
    var d = {}; fields.forEach(function (f) { if (f.key) d[f.key] = f.default; });
    return { get: function (k) { return d[k]; }, all: function () { var o = {}; for (var k in d) o[k] = d[k]; return o; }, set: function (k, v) { d[k] = v; }, on: function () { return function () {}; } };
  }
  var PDEF = {}; PREFS_FIELDS.forEach(function (f) { if (f.key) PDEF[f.key] = f.default; });
  var Pref = null;
  function pget(k) { var v; try { v = Pref && Pref.get(k); } catch (e) {} return v === undefined || v === null ? PDEF[k] : v; }

  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2200); } catch (e) {} }
  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function isTouch() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }
  function cssVar(n, d) { try { return getComputedStyle(P || document.documentElement).getPropertyValue(n).trim() || d; } catch (e) { return d; } }

  function loadScript(url, global) {
    if (window[global]) return Promise.resolve(window[global]);
    var key = '__fmLoad_' + global;
    if (!window[key]) {
      window[key] = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = url;
        s.onload = function () { if (window[global]) res(window[global]); else { window[key] = null; rej(new Error('missing ' + global)); } };
        s.onerror = function () { window[key] = null; rej(new Error('Font Maker failed to load (offline?)')); };
        document.head.appendChild(s);
      });
    }
    return window[key];
  }
  function loadCore() { return loadScript(BASE + 'fontmaker-core.js', '__cadeFontmaker'); }
  function loadOT() { return loadScript(BASE + 'opentype.min.js', 'opentype'); }

  // ---------------------------------------------------------------- state
  var P = null, el = {}, FM = null, OT = null;
  var fonts = [], font = null;                     // the index, the open font
  var cur = { set: 'quick', ch: 'A', vi: 0 }, tab = 'draw';
  var shapes = {}, rev = {};                       // outline cache per ch|vi, edit counters per ch
  var timers = {}, raf = 0, offPref = null, ro = null, mo = null;
  var stroke = null, penSeen = false;              // the stroke being drawn
  var built = null, building = null;               // { sig, otf, woff, family }
  var png = null;                                  // { sig, blob }
  var img = { text: '', preset: 'story', paper: 'lined', align: 'left', ink: '#1d2a4a', size: 96, lh: 1.5, wobble: 40, seed: 7 };
  var IMG_PRESETS = { story: [1080, 1920, 'Phone story'], square: [1080, 1080, 'Square'], card: [1748, 2480, 'A5 card'] };
  var PAPERS = [['plain', 'Plain'], ['lined', 'Lined'], ['grid', 'Grid'], ['kraft', 'Kraft'], ['none', 'None']];
  var INKS = [['#1d2a4a', 'Navy'], ['#1b1b1b', 'Black'], ['#1f56c9', 'Blue'], ['#b3261e', 'Red'], ['#2f6b3a', 'Green'], ['#6b6b6b', 'Pencil'], ['#ffffff', 'White']];
  // Session-wide (outlive the panel on purpose): the registered face and the editor style.
  var S = window.__fontmakerSession || (window.__fontmakerSession = { face: null, family: '', editor: false, styleEl: null });

  function clearTimer(k) { if (timers[k]) { clearTimeout(timers[k]); timers[k] = 0; } }
  function later(k, ms, fn) { clearTimer(k); timers[k] = setTimeout(function () { timers[k] = 0; if (P) fn(); }, ms); }
  function q(s) { return P.querySelector(s); }
  function qa(s) { return Array.prototype.slice.call(P.querySelectorAll(s)); }

  // ---------------------------------------------------------------- storage
  function idb() { return Cade.idbStore; }
  function saveIndex() { return idb().set(IDX_KEY, fonts.map(function (f) { return { id: f.id, name: f.name, updated: f.updated, sync: !!f.sync, count: f.count || 0 }; })); }
  function indexEntry(f) { return { id: f.id, name: f.name, updated: f.updated, sync: !!f.sync, count: FM.glyphCount(f) }; }
  function putFont(f) {
    var e = indexEntry(f), i = fonts.map(function (x) { return x.id; }).indexOf(f.id);
    if (i < 0) fonts.push(e); else fonts[i] = e;
    return Promise.all([idb().set(FONT_KEY + f.id, JSON.parse(JSON.stringify(f))), saveIndex()]);
  }
  function getFont(id) { return idb().get(FONT_KEY + id).then(function (f) { if (typeof f === 'string') { try { f = JSON.parse(f); } catch (e) { f = null; } } return f ? FM.normFont(f) : null; }); }
  // Debounced save of the open font (and a sync push when it is synced).
  function dirty() {
    if (!font) return;
    font.updated = Date.now();
    built = null; png = null;
    later('save', 500, flushSave);
    if (font.sync) later('sync', 2000, pushSync);
    if (tab === 'font') later('build', 600, buildAndRegister);
    if (tab === 'image') schedule();
  }
  function flushSave() {
    clearTimer('save');
    if (!font) return Promise.resolve();
    var f = font;
    return putFont(f).then(function (durable) { if (P && durable && durable[0] === false) toast('Saved in a fallback store (private mode?) — keep a copy of the font file', 'info', 3000); }, function () { toast('Couldn’t save the drawing', 'error'); });
  }
  function deviceName() { try { var d = Cade.cloud && Cade.cloud.device; return (d && d.name) || ''; } catch (e) { return ''; } }
  function defaultName() {
    var n = deviceName().split(/\s+[·|\-–]\s+/)[0].replace(/[’']s\b/, '').trim().slice(0, 40);
    if (!n) n = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : 'My';
    var base = n + ' Hand', name = base, k = 2;
    while (fonts.some(function (f) { return f.name === name; })) name = base + ' ' + k++;
    return name;
  }

  // ---------------------------------------------------------------- sync
  var blob = null;
  function syncAvailable() { try { return !!(Cade.syncedBlob && Cade.cloud && Cade.cloud.configured()); } catch (e) { return false; } }
  function ensureBlob() {
    if (!syncAvailable()) return null;
    if (!window.__fontmakerBlob) {
      try {
        window.__fontmakerBlob = Cade.syncedBlob('fontmaker', { onChange: function (data) { if (window.__fontmakerOnRemote) window.__fontmakerOnRemote(data); } });
      } catch (e) { return null; }
    }
    return (blob = window.__fontmakerBlob);
  }
  function blobData() { var d = blob && blob.get(); return d && typeof d === 'object' ? d : { fonts: {}, deleted: {} }; }
  // Adopt newer fonts from the blob; honour deletions; fonts unsynced elsewhere stop syncing here.
  function mergeRemote(data) {
    if (!data || typeof data !== 'object' || !P) return Promise.resolve();
    var rf = data.fonts && typeof data.fonts === 'object' ? data.fonts : {}, del = data.deleted && typeof data.deleted === 'object' ? data.deleted : {};
    var jobs = [], changedOpen = false;
    Object.keys(rf).forEach(function (id) {
      var f = FM.normFont(rf[id]);
      if (!f || del[id]) return;
      f.sync = true;
      var loc = fonts.filter(function (x) { return x.id === f.id; })[0];
      if (loc && loc.updated >= f.updated) return;
      if (font && font.id === f.id) { if (stroke) return; font = f; changedOpen = true; }
      jobs.push(putFont(f));
    });
    fonts.slice().forEach(function (loc) {
      if (del[loc.id] && del[loc.id] >= loc.updated) {
        jobs.push(idb().remove(FONT_KEY + loc.id));
        fonts = fonts.filter(function (x) { return x.id !== loc.id; });
        if (font && font.id === loc.id) font = null;
        changedOpen = true;
      } else if (loc.sync && !rf[loc.id]) {
        loc.sync = false;
        if (font && font.id === loc.id) font.sync = false;
        jobs.push(getFont(loc.id).then(function (f) { if (f) { f.sync = false; return idb().set(FONT_KEY + f.id, f); } }));
      }
    });
    return Promise.all(jobs).then(function () {
      if (!jobs.length) return;
      return saveIndex().then(function () {
        if (!P) return;
        if (!font) return openFont(fonts.length ? fonts[0].id : null);
        if (changedOpen) { shapes = {}; built = null; png = null; renderAll(); }
        else renderFontList();
      });
    });
  }
  function pushSync() {
    if (!ensureBlob()) return Promise.resolve(false);
    var ids = fonts.filter(function (f) { return f.sync; }).map(function (f) { return f.id; });
    return Promise.all(ids.map(function (id) { return font && font.id === id ? Promise.resolve(font) : getFont(id); })).then(function (list) {
      var prev = blobData(), data = { fonts: {}, deleted: prev.deleted || {} };
      list.forEach(function (f) { if (f) data.fonts[f.id] = f; });
      var dk = Object.keys(data.deleted).sort(function (a, b) { return data.deleted[b] - data.deleted[a]; });
      dk.slice(50).forEach(function (k) { delete data.deleted[k]; });
      var size = JSON.stringify(data).length;
      if (size > SYNC_MAX) { toast('Synced fonts are too big to sync (' + Math.round(size / 1024) + ' KB) — turn sync off for one', 'error', 4000); return false; }
      blob.set(data);
      return true;
    });
  }

  // ---------------------------------------------------------------- shapes
  function settingsSig() { return JSON.stringify(font.settings); }
  function shapeFor(ch, vi) {
    var vs = FM.variants(font, ch), strokes = vs[vi];
    if (!strokes) return null;
    var key = ch + '|' + vi, sig = (rev[ch] || 0) + '|' + strokes.length + '|' + settingsSig(), c = shapes[key];
    if (c && c.sig === sig) return c.shape;
    var shape = FM.glyphShape(strokes, font.settings);
    if (shape) shape.path2d = null;
    shapes[key] = { sig: sig, shape: shape };
    return shape;
  }
  function path2d(shape) {
    if (!shape.path2d) { try { shape.path2d = new Path2D(FM.pathToSvg(shape.commands, 0, false)); } catch (e) { shape.path2d = null; } }
    return shape.path2d;
  }
  function touched(ch) { rev[ch] = (rev[ch] || 0) + 1; }
  function glyphInfo(ch) {
    var n = FM.variants(font, ch).length;
    return { n: n, adv: function (vi) { var s = shapeFor(ch, vi); return s ? s.advance : 500; } };
  }

  // ---------------------------------------------------------------- panel HTML
  function seg(name, items, extraCls) {
    return '<div class="fm-seg ' + (extraCls || '') + '" role="group" data-seg="' + name + '">' + items.map(function (it) {
      return '<button type="button" class="fm-sb" data-' + name + '="' + esc(it[0]) + '"' + (it[2] ? ' title="' + esc(it[2]) + '"' : '') + '>' + esc(it[1]) + '</button>';
    }).join('') + '</div>';
  }
  function slider(key, label, min, max, stp) {
    return '<label class="fm-sl"><span class="fm-l">' + label + '</span><input type="range" data-sl="' + key + '" min="' + min + '" max="' + max + '" step="' + stp + '"><output class="fm-v" data-out="' + key + '"></output></label>';
  }
  function bodyHtml() {
    return '<div class="fm">' +
      '<div class="fm-top">' +
        '<select class="fm-fontsel" aria-label="Font"></select>' +
        '<div class="fm-tabs" role="tablist">' +
          '<button type="button" class="fm-tab" data-tab="draw" role="tab">Draw</button>' +
          '<button type="button" class="fm-tab" data-tab="font" role="tab">Font</button>' +
          '<button type="button" class="fm-tab" data-tab="image" role="tab">Image</button>' +
        '</div>' +
        '<button type="button" class="fm-ic" data-act="prefs" title="Widget preferences" aria-label="Widget preferences">⚙</button>' +
      '</div>' +
      // ---- draw
      '<div class="fm-pane" data-pane="draw">' +
        '<div class="fm-sets">' + FM.SETS.map(function (s) {
          return '<button type="button" class="fm-set" data-set="' + s.id + '"><b>' + esc(s.label) + '</b><span class="fm-cnt" data-cnt="' + s.id + '"></span></button>';
        }).join('') + '</div>' +
        '<div class="fm-bar" aria-hidden="true"><i></i></div>' +
        '<div class="fm-strip" role="listbox" aria-label="Letters"></div>' +
        '<div class="fm-stage">' +
          '<canvas class="fm-cv" aria-label="Drawing area: draw the letter here"></canvas>' +
          '<div class="fm-ch" aria-live="polite"></div>' +
          '<div class="fm-vers">' + [0, 1, 2].map(function (i) { return '<button type="button" class="fm-ver" data-vi="' + i + '" title="Version ' + (i + 1) + ' — draw 2 or 3 versions and the font alternates them">' + (i + 1) + '</button>'; }).join('') + '</div>' +
        '</div>' +
        '<div class="fm-ctl">' +
          '<button type="button" class="fm-btn fm-big" data-act="prev" aria-label="Previous letter">‹</button>' +
          '<button type="button" class="fm-btn" data-act="undo">↶ Undo</button>' +
          '<button type="button" class="fm-btn" data-act="clear">Clear</button>' +
          '<button type="button" class="fm-btn fm-big fm-go" data-act="next" aria-label="Next letter">›</button>' +
        '</div>' +
        '<canvas class="fm-word" aria-label="Preview word"></canvas>' +
      '</div>' +
      // ---- font
      '<div class="fm-pane" data-pane="font" hidden>' +
        '<label class="fm-f"><span class="fm-l">Name</span><input type="text" class="fm-in fm-name" maxlength="60" autocomplete="off" spellcheck="false"></label>' +
        '<div class="fm-row fm-manage">' +
          '<button type="button" class="fm-btn" data-act="new">＋ New font</button>' +
          '<button type="button" class="fm-btn" data-act="dup">Duplicate</button>' +
          '<button type="button" class="fm-btn fm-danger" data-act="del">Delete</button>' +
        '</div>' +
        slider('weight', 'Weight', FM.LIMITS.weight[0], FM.LIMITS.weight[1], 1) +
        slider('spacing', 'Spacing', FM.LIMITS.spacing[0], FM.LIMITS.spacing[1], 2) +
        slider('slant', 'Slant', FM.LIMITS.slant[0], FM.LIMITS.slant[1], 1) +
        slider('space', 'Space', FM.LIMITS.space[0], FM.LIMITS.space[1], 10) +
        '<div class="fm-sample" contenteditable="false"><span class="fm-s1">The quick brown fox jumps over the lazy dog.</span><span class="fm-s2">Hamburgefonts 0123456789</span></div>' +
        '<div class="fm-meta fm-fmeta" aria-live="polite"></div>' +
        '<div class="fm-row">' +
          '<button type="button" class="fm-btn fm-go" data-act="otf">⤓ Save .otf</button>' +
          '<button type="button" class="fm-btn" data-act="woff">.woff</button>' +
          '<button type="button" class="fm-btn fm-tg" data-act="editor" title="Show this note’s text in your font (this session)">Use for the note</button>' +
        '</div>' +
        '<label class="fm-check"><input type="checkbox" class="fm-sync"> <span>Keep this font on all my devices <small class="fm-synchint"></small></span></label>' +
      '</div>' +
      // ---- image
      '<div class="fm-pane" data-pane="image" hidden>' +
        '<textarea class="fm-in fm-text" rows="3" placeholder="Type something…" spellcheck="true"></textarea>' +
        '<div class="fm-imgtop">' +
        '<div class="fm-imgwrap"><canvas class="fm-img" aria-label="Picture preview"></canvas></div>' +
        '<div class="fm-meta fm-imeta" aria-live="polite"></div>' +
        '<div class="fm-row">' +
          '<button type="button" class="fm-btn fm-go" data-act="psave">' + (isTouch() ? 'Share / Save' : '⤓ Save PNG') + '</button>' +
          '<button type="button" class="fm-btn" data-act="pcopy">Copy</button>' +
          '<button type="button" class="fm-btn" data-act="pattach" title="Attach the picture to the note at the cursor">Attach to note</button>' +
          '<button type="button" class="fm-btn" data-act="shuffle" title="Different wobble and letter versions">↻</button>' +
        '</div>' +
        '</div>' +
        '<div class="fm-f"><span class="fm-l">Size</span>' + seg('preset', Object.keys(IMG_PRESETS).map(function (k) { return [k, IMG_PRESETS[k][2], IMG_PRESETS[k][0] + ' × ' + IMG_PRESETS[k][1]]; })) + '</div>' +
        '<div class="fm-f"><span class="fm-l">Paper</span>' + seg('paper', PAPERS) + '</div>' +
        '<div class="fm-f"><span class="fm-l">Align</span>' + seg('align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]) + '</div>' +
        '<div class="fm-f"><span class="fm-l">Ink</span><div class="fm-inks">' + INKS.map(function (c) {
          return '<button type="button" class="fm-ink" data-ink="' + c[0] + '" title="' + c[1] + '" aria-label="' + c[1] + ' ink" style="--c:' + c[0] + '"></button>';
        }).join('') + '<input type="color" class="fm-inkc" aria-label="Ink colour"></div></div>' +
        slider('size', 'Text', 32, 240, 2) +
        slider('lh', 'Lines', 1, 2.4, 0.05) +
        slider('wobble', 'Wobble', 0, 100, 5) +
      '</div>' +
    '</div>';
  }

  // ---------------------------------------------------------------- rendering
  function renderAll() {
    if (!P || !font) return;
    renderFontList();
    renderTabs();
    renderSets();
    renderStrip();
    renderVersions();
    sizeCanvas();
    if (tab === 'font') renderFontTab();
    if (tab === 'image') renderImageTab();
  }
  function renderFontList() {
    var sel = el.fontsel;
    sel.innerHTML = fonts.map(function (f) { return '<option value="' + esc(f.id) + '">' + esc(f.name) + (f.sync ? ' ⟳' : '') + '</option>'; }).join('');
    if (font) sel.value = font.id;
  }
  function renderTabs() {
    qa('.fm-tab').forEach(function (b) { var on = b.getAttribute('data-tab') === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    qa('.fm-pane').forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== tab; });
  }
  function setChars() { return (FM.SETS.filter(function (s) { return s.id === cur.set; })[0] || FM.SETS[0]).chars; }
  function renderSets() {
    FM.SETS.forEach(function (s) {
      var pr = FM.progress(font, s.id), c = q('[data-cnt="' + s.id + '"]');
      c.textContent = pr.done + '/' + pr.total;
      q('[data-set="' + s.id + '"]').classList.toggle('on', s.id === cur.set);
      q('[data-set="' + s.id + '"]').classList.toggle('done', pr.done === pr.total);
    });
    var all = FM.progress(font);
    q('.fm-bar i').style.width = Math.round(all.done / all.total * 100) + '%';
  }
  function cellSvg(ch) {
    var vs = FM.variants(font, ch);
    if (!vs.length) return '<span class="fm-cg">' + esc(ch) + '</span>';
    var r = font.settings.weight * 2, d = '';
    vs[0].forEach(function (s) {
      for (var i = 0; i + 2 < s.length; i += 3) d += (i ? 'L' : 'M') + s[i] + ' ' + (-s[i + 1]);
      if (s.length === 3) d += 'l0.1 0';
    });
    return '<svg viewBox="-100 -900 1200 1200" aria-hidden="true"><path d="' + d + '" fill="none" stroke="currentColor" stroke-width="' + r + '" stroke-linecap="round" stroke-linejoin="round"/></svg>' + (vs.length > 1 ? '<i class="fm-nv">' + vs.length + '</i>' : '');
  }
  function renderStrip() {
    var chars = setChars();
    el.strip.innerHTML = chars.map(function (ch) {
      return '<button type="button" class="fm-cell' + (FM.hasGlyph(font, ch) ? ' has' : '') + (ch === cur.ch ? ' on' : '') + '" data-ch="' + esc(ch) + '" role="option" aria-label="' + esc(ch) + '" aria-selected="' + (ch === cur.ch) + '">' + cellSvg(ch) + '</button>';
    }).join('');
    scrollCell();
  }
  function updateCell(ch) {
    var b = el.strip.querySelector('[data-ch="' + cssEsc(ch) + '"]');
    if (!b) return;
    b.innerHTML = cellSvg(ch);
    b.classList.toggle('has', FM.hasGlyph(font, ch));
  }
  function cssEsc(ch) { return window.CSS && CSS.escape ? CSS.escape(ch) : ch.replace(/["\\]/g, '\\$&'); }
  function scrollCell() {
    var b = el.strip.querySelector('.fm-cell.on');
    if (!b) return;
    var s = el.strip, l = b.offsetLeft - s.offsetLeft, w = b.offsetWidth;
    if (l < s.scrollLeft + 4 || l + w > s.scrollLeft + s.clientWidth - 4) s.scrollLeft = Math.max(0, l - s.clientWidth / 2 + w / 2);
  }
  function renderVersions() {
    var n = (font.glyphs[cur.ch] || []).length;
    qa('.fm-ver').forEach(function (b) {
      var i = +b.getAttribute('data-vi');
      b.classList.toggle('on', i === cur.vi);
      b.classList.toggle('has', !!(font.glyphs[cur.ch] && font.glyphs[cur.ch][i] && font.glyphs[cur.ch][i].length));
      b.disabled = i > n;    // the next empty version is offered, not ones after it
    });
    el.chLabel.textContent = cur.ch + (n > 1 || cur.vi ? ' · v' + (cur.vi + 1) : '');
  }
  function select(ch, vi) {
    if (stroke) return;
    clearTimer('auto');
    cur.ch = ch; cur.vi = vi || 0;
    var n = (font.glyphs[ch] || []).length;
    if (cur.vi > n) cur.vi = n;
    qa('.fm-cell').forEach(function (b) { var on = b.getAttribute('data-ch') === ch; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    scrollCell();
    renderVersions();
    drawCanvas();
    drawWord();
  }
  function go(dir) {
    var chars = setChars(), i = chars.indexOf(cur.ch);
    if (i < 0) { select(chars[0]); return; }
    var j = i + dir;
    if (j >= chars.length || j < 0) {
      // past the end of a set: on to the next set
      var si = FM.SETS.map(function (s) { return s.id; }).indexOf(cur.set), ns = FM.SETS[(si + (dir > 0 ? 1 : FM.SETS.length - 1)) % FM.SETS.length];
      cur.set = ns.id; renderSets(); cur.ch = dir > 0 ? ns.chars[0] : ns.chars[ns.chars.length - 1]; renderStrip(); select(cur.ch);
      return;
    }
    select(chars[j]);
  }

  // ---- the drawing square
  var cvSize = 0, dpr = 1;
  function sizeCanvas() {
    if (!el.cv) return;
    var w = el.stage.clientWidth || 300;
    var maxH = Math.max(220, (window.visualViewport ? window.visualViewport.height : window.innerHeight) * 0.42);
    var s = Math.round(Math.max(200, Math.min(w, maxH, 520)));
    dpr = Math.min(3, window.devicePixelRatio || 1);
    if (s !== cvSize || el.cv.width !== Math.round(s * dpr)) {
      cvSize = s;
      el.cv.style.width = el.cv.style.height = s + 'px';
      el.cv.width = el.cv.height = Math.round(s * dpr);
    }
    var ww = el.word.parentNode.clientWidth || w;
    el.word.style.width = ww + 'px'; el.word.style.height = '64px';
    el.word.width = Math.round(ww * dpr); el.word.height = Math.round(64 * dpr);
    drawCanvas(); drawWord();
  }
  function u2c(x, y) { var p = FM.fromUnits(x, y, cvSize, cvSize); return [p.x, p.y]; }
  function drawCanvas() {
    if (!el.cv || !font || !cvSize) return;
    var c = el.cv.getContext('2d'), s = cvSize, k = s / (FM.VIEW.x1 - FM.VIEW.x0);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, s, s);
    var text = cssVar('--text', '#222'), faint = cssVar('--text-faint', '#999'), border = cssVar('--border', '#ccc'), accent = cssVar('--accent', '#3b82f6');
    if (pget('ghost')) {
      c.save();
      c.globalAlpha = 0.09; c.fillStyle = text;
      c.font = Math.round(1000 * k) + 'px Georgia, "Times New Roman", serif';
      c.textAlign = 'center'; c.textBaseline = 'alphabetic';
      var b = u2c(450, 0); c.fillText(cur.ch, b[0], b[1]);
      c.restore();
    }
    var G = FM.METRICS;
    [[G.capHeight, 'cap', border, [6, 5]], [G.xHeight, 'x-height', border, [6, 5]], [0, 'baseline', accent, null], [G.descLine, 'descender', border, [6, 5]]].forEach(function (g) {
      var y = Math.round(u2c(0, g[0])[1]) + 0.5;
      c.save();
      c.strokeStyle = g[2]; c.globalAlpha = g[2] === accent ? 0.55 : 1; c.lineWidth = 1;
      if (g[3]) c.setLineDash(g[3]);
      c.beginPath(); c.moveTo(0, y); c.lineTo(s, y); c.stroke();
      c.restore();
      c.fillStyle = faint; c.font = '10px ' + cssVar('--font-mono', 'monospace');
      c.fillText(g[1], 6, y - 4);
    });
    // other versions, faint, so the new one can match their size
    var vs = font.glyphs[cur.ch] || [];
    vs.forEach(function (v, i) { if (i !== cur.vi && v.length) inkStrokes(c, v, k, faint, 0.35); });
    if (vs[cur.vi]) inkStrokes(c, vs[cur.vi], k, text, 1);
    if (stroke && stroke.pts.length) inkPts(c, stroke.pts, k, text);
  }
  function inkStrokes(c, strokes, k, color, alpha) {
    strokes.forEach(function (s) {
      var pts = [];
      for (var i = 0; i + 2 < s.length; i += 3) pts.push({ x: s[i], y: s[i + 1], p: s[i + 2] / 100 });
      c.save(); c.globalAlpha = alpha; inkPts(c, pts, k, color); c.restore();
    });
  }
  function inkPts(c, pts, k, color, from) {
    var w = font.settings.weight;
    c.strokeStyle = color; c.fillStyle = color; c.lineCap = 'round'; c.lineJoin = 'round';
    if (pts.length === 1) {
      var p0 = u2c(pts[0].x, pts[0].y);
      c.beginPath(); c.arc(p0[0], p0[1], FM.radiusAt(w, pts[0].p) * k, 0, 6.2832); c.fill();
      return;
    }
    for (var i = Math.max(1, from || 1); i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i], pa = u2c(a.x, a.y), pb = u2c(b.x, b.y);
      c.lineWidth = (FM.radiusAt(w, a.p) + FM.radiusAt(w, b.p)) * k;
      c.beginPath(); c.moveTo(pa[0], pa[1]); c.lineTo(pb[0], pb[1]); c.stroke();
    }
  }
  // The preview word in the real outlines (versions alternate as in the font).
  function drawWord() {
    if (!el.word || !font) return;
    var cv = el.word, c = cv.getContext('2d'), W = cv.width / dpr, H = cv.height / dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    var word = String(pget('preview') || 'Hamburgefonts').slice(0, 40);
    var text = cssVar('--text', '#222'), faint = cssVar('--text-faint', '#999');
    var size = 42, lay = FM.layoutText(word, glyphInfo, { size: size, width: 1e6, align: 'left', space: font.settings.space, missing: function () { return 520; } });
    var line = lay.lines[0];
    if (!line) return;
    var fit = Math.min(1, (W - 8) / Math.max(1, line.w)), sz = size * fit, k = sz / FM.EM;
    var x0 = Math.max(4, (W - line.w * fit) / 2), base = H * 0.68;
    line.items.forEach(function (it) {
      var x = x0 + it.x * fit;
      if (it.missing) {
        c.fillStyle = faint; c.font = Math.round(sz * 0.72) + 'px Georgia, serif';
        c.fillText(it.ch, x + 2, base);
        return;
      }
      if (it.ch === ' ') return;
      var sh = shapeFor(it.ch, it.vi), p = sh && path2d(sh);
      if (!p) return;
      c.save(); c.translate(x, base); c.scale(k, -k);
      c.fillStyle = it.ch === cur.ch ? cssVar('--accent', '#3b82f6') : text;
      c.fill(p); c.restore();
    });
  }

  // ---- pointer input
  function ptOf(e) {
    var r = el.cv.getBoundingClientRect(), u = FM.toUnits(e.clientX - r.left, e.clientY - r.top, r.width || cvSize, r.height || cvSize);
    return { x: u.x, y: u.y, p: FM.normPressure(e.pressure, e.pointerType) };
  }
  function onDown(e) {
    if (e.button > 0 || !font) return;
    if (e.pointerType === 'pen') penSeen = true;
    e.preventDefault();
    if (stroke) return;                                                // one pointer at a time
    if (pget('pencil') && penSeen && e.pointerType === 'touch') return; // palm rejection
    clearTimer('auto');
    try { var a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); } catch (er) {}
    try { el.cv.setPointerCapture(e.pointerId); } catch (er) {}
    stroke = { id: e.pointerId, pts: [ptOf(e)] };
    var c = el.cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    inkPts(c, stroke.pts, cvSize / (FM.VIEW.x1 - FM.VIEW.x0), cssVar('--text', '#222'));
  }
  function onMove(e) {
    if (!stroke || e.pointerId !== stroke.id) return;
    e.preventDefault();
    var evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    if (!evs.length) evs = [e];
    var from = stroke.pts.length;
    evs.forEach(function (ev) { stroke.pts.push(ptOf(ev)); });
    var c = el.cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    inkPts(c, stroke.pts, cvSize / (FM.VIEW.x1 - FM.VIEW.x0), cssVar('--text', '#222'), from);
  }
  function onUp(e) {
    if (!stroke || e.pointerId !== stroke.id) return;
    var s = stroke; stroke = null;
    try { el.cv.releasePointerCapture(e.pointerId); } catch (er) {}
    if (e.type === 'pointercancel' && s.pts.length < 3) { drawCanvas(); return; }
    var fin = FM.finishStroke(s.pts);
    if (fin && FM.addStroke(font, cur.ch, cur.vi, fin)) {
      touched(cur.ch);
      afterEdit();
      try { Cade.haptic && Cade.haptic(4); } catch (er) {}
      if (pget('autoNext')) later('auto', 1500, function () { if (!stroke) go(1); });
    } else drawCanvas();
  }
  function stopTouch(e) { if (e.cancelable) e.preventDefault(); }
  function afterEdit() {
    dirty();
    updateCell(cur.ch);
    renderSets();
    renderVersions();
    drawCanvas();
    drawWord();
  }

  // ---------------------------------------------------------------- font tab
  function renderFontTab() {
    el.name.value = font.name;
    ['weight', 'spacing', 'slant', 'space'].forEach(function (k) { setSlider(k, font.settings[k]); });
    el.sync.checked = !!font.sync;
    el.sync.disabled = !syncAvailable();
    el.synchint.textContent = syncAvailable() ? '' : '(needs Sync)';
    q('[data-act="editor"]').classList.toggle('on', !!S.editor);
    q('[data-act="editor"]').setAttribute('aria-pressed', S.editor ? 'true' : 'false');
    applySampleFont();
    buildAndRegister();
  }
  function setSlider(k, v) {
    var inp = q('[data-sl="' + k + '"]'), out = q('[data-out="' + k + '"]');
    if (!inp) return;
    if (+inp.value !== v) inp.value = v;
    out.textContent = k === 'slant' ? v + '°' : k === 'lh' ? (+v).toFixed(2) : k === 'wobble' ? v + '%' : String(v);
  }
  function fontSig() { return font.id + '|' + font.updated + '|' + font.name + '|' + settingsSig(); }
  function deflate(u8) {
    if (typeof CompressionStream === 'undefined') return null;
    var cs = new CompressionStream('deflate'), w = cs.writable.getWriter();
    w.write(u8); w.close();
    return new Response(cs.readable).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  // Build the .otf (+ .woff) for the open font; cached by signature.
  function build() {
    if (!font) return Promise.reject(new Error('no font'));
    var sig = fontSig();
    if (built && built.sig === sig) return Promise.resolve(built);
    if (building && building.sig === sig) return building.p;
    var f = font;
    var p = loadOT().then(function (ot) {
      OT = ot;
      if (!FM.glyphCount(f)) throw new Error('empty');
      var t0 = performance.now();
      var otf = FM.buildFont(ot, f, { cache: function (ch, vi) { return shapeFor(ch, vi); } }).toArrayBuffer();
      var ms = Math.round(performance.now() - t0);
      return FM.makeWoff(new Uint8Array(otf), typeof CompressionStream !== 'undefined' ? deflate : null).then(function (woff) {
        var b = { sig: sig, otf: otf, woff: woff, family: f.name, ms: ms, count: FM.glyphCount(f) };
        if (font && fontSig() === sig) built = b;
        return b;
      });
    });
    building = { sig: sig, p: p };
    p.then(function () { if (building && building.p === p) building = null; }, function () { if (building && building.p === p) building = null; });
    return p;
  }
  function buildAndRegister() {
    if (!font) return;
    if (!FM.glyphCount(font)) { fontMeta('Draw a few letters first — the font is built from what you have drawn.'); return; }
    fontMeta('Building…');
    build().then(register).then(function (b) {
      if (!P || !b) return;
      fontMeta(b.count + ' of ' + FM.ALL.length + ' characters · ' + Math.round(b.otf.byteLength / 1024) + ' KB · in use as “' + b.family + '” this session');
      applySampleFont();
    }, function (e) {
      if (e && e.message === 'empty') return;
      fontMeta('Couldn’t build the font' + (e && e.message ? ': ' + e.message : ''));
    });
  }
  function fontMeta(t) { if (el.fmeta) el.fmeta.textContent = t; }
  // FontFace for this session; replaces the previous build of the same font.
  function register(b) {
    if (!b || typeof FontFace === 'undefined') return b;
    if (S.face && S.face.__sig === b.sig) return b;
    var face = new FontFace(b.family, b.otf.slice(0));
    return face.load().then(function () {
      if (S.face) { try { document.fonts.delete(S.face); } catch (e) {} }
      face.__sig = b.sig;
      document.fonts.add(face);
      S.face = face; S.family = b.family;
      if (S.editor) applyEditorFont();
      return b;
    });
  }
  function quoteFamily(f) { return '"' + String(f).replace(/["\\]/g, '') + '"'; }
  function applySampleFont() {
    if (!el.sample) return;
    el.sample.style.fontFamily = S.family && font && S.family === font.name ? quoteFamily(S.family) + ', var(--font-body)' : '';
    el.sample.classList.toggle('fm-pending', !(S.family && font && S.family === font.name));
  }
  function applyEditorFont() {
    if (S.styleEl) { S.styleEl.remove(); S.styleEl = null; }
    if (!S.editor || !S.family) return;
    var st = document.createElement('style');
    st.id = 'fontmaker-editor-font';
    st.textContent = '.cm-editor .cm-content { font-family: ' + quoteFamily(S.family) + ', var(--font-body) !important; }';
    document.head.appendChild(st);
    S.styleEl = st;
  }
  function fileBase() { return (font.name || 'My Hand').replace(/[\\/:*?"<>|]+/g, '').trim() || 'My Hand'; }
  // Hand a file to the share sheet (touch devices) or download it.
  function deliver(data, name, mime) {
    var file;
    try { file = new File([data], name, { type: mime }); } catch (e) { file = new Blob([data], { type: mime }); file.name = name; }
    if (isTouch() && navigator.share && navigator.canShare) {
      var ok = false;
      try { ok = navigator.canShare({ files: [file] }); } catch (e) {}
      if (ok) {
        return navigator.share({ files: [file], title: name }).then(function () { return 'shared'; }, function (e) {
          if (e && e.name === 'AbortError') return 'cancelled';
          if (e && e.name === 'NotAllowedError') { toast('Ready — tap again to save it', 'info', 2600); return 'retry'; }
          download(file, name); return 'downloaded';
        });
      }
    }
    download(file, name);
    return Promise.resolve('downloaded');
  }
  function download(blobOrFile, name) {
    if (Cade.files && Cade.files.save) { try { Cade.files.save(blobOrFile, name); return; } catch (e) {} }
    var u = URL.createObjectURL(blobOrFile), a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
  }
  function saveFont(kind) {
    if (!FM.glyphCount(font)) { toast('Draw some letters first', 'info'); return; }
    var go2 = function (b) {
      var name = fileBase() + '.' + kind;
      return deliver(kind === 'woff' ? b.woff : b.otf, name, kind === 'woff' ? 'font/woff' : 'font/otf').then(function (r) {
        if (r === 'downloaded') toast('Saved ' + name, 'success');
      });
    };
    // Built already → share inside the tap (iOS needs the user gesture).
    if (built && built.sig === fontSig()) { go2(built); return; }
    build().then(function (b) { register(b); return go2(b); }, function () { toast('Couldn’t build the font', 'error'); });
  }

  // ---------------------------------------------------------------- image tab
  function loadImg() {
    try { var o = JSON.parse(sget(IMG_KEY) || '{}') || {}; for (var k in img) if (o[k] !== undefined && typeof o[k] === typeof img[k]) img[k] = o[k]; } catch (e) {}
    if (!IMG_PRESETS[img.preset]) img.preset = 'story';
  }
  function saveImg() { sset(IMG_KEY, JSON.stringify(img)); }
  function selectionText() {
    try {
      var st = Cade.editor.state, r = st.selection.main;
      if (!r.empty) return st.sliceDoc(r.from, Math.min(r.to, r.from + 2000));
    } catch (e) {}
    return '';
  }
  function renderImageTab() {
    qa('[data-preset]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-preset') === img.preset); });
    qa('[data-paper]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-paper') === img.paper); });
    qa('[data-align]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-align') === img.align); });
    qa('.fm-ink').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-ink').toLowerCase() === img.ink.toLowerCase()); });
    el.inkc.value = img.ink;
    setSlider('size', img.size); setSlider('lh', img.lh); setSlider('wobble', img.wobble);
    schedule();
  }
  function schedule() { if (!raf && P) raf = requestAnimationFrame(function () { raf = 0; renderImage(); }); }
  function paintPaper(c, W, H, kind, lines, top, lh) {
    if (kind === 'none') { c.clearRect(0, 0, W, H); return; }
    c.fillStyle = kind === 'kraft' ? '#c9a676' : '#fffdf7';
    c.fillRect(0, 0, W, H);
    if (kind === 'kraft') {
      var R = FM.rng(11);
      for (var i = 0; i < 2600; i++) { c.fillStyle = R() < 0.5 ? 'rgba(90,60,25,0.13)' : 'rgba(255,240,210,0.16)'; c.fillRect(R() * W, R() * H, 1 + R() * 3, 1 + R() * 2); }
    } else if (kind === 'lined') {
      c.strokeStyle = 'rgba(80,130,200,0.45)'; c.lineWidth = Math.max(1, W / 900);
      for (var y = top; y < H - lh * 0.3; y += lh) { c.beginPath(); c.moveTo(0, Math.round(y) + 0.5); c.lineTo(W, Math.round(y) + 0.5); c.stroke(); }
      c.strokeStyle = 'rgba(210,80,80,0.5)';
      c.beginPath(); c.moveTo(W * 0.06, 0); c.lineTo(W * 0.06, H); c.stroke();
    } else if (kind === 'grid') {
      var g = lh / 2;
      c.strokeStyle = 'rgba(90,130,190,0.22)'; c.lineWidth = Math.max(1, W / 1080);
      for (var x = (W % g) / 2; x < W; x += g) { c.beginPath(); c.moveTo(Math.round(x) + 0.5, 0); c.lineTo(Math.round(x) + 0.5, H); c.stroke(); }
      for (y = top % g; y < H; y += g) { c.beginPath(); c.moveTo(0, Math.round(y) + 0.5); c.lineTo(W, Math.round(y) + 0.5); c.stroke(); }
    }
  }
  function renderImage() {
    if (!P || !font || tab !== 'image' || (Cade.isMinimized && Cade.isMinimized(P))) return;
    var pr = IMG_PRESETS[img.preset], W = pr[0], H = pr[1], cv = el.img, c = cv.getContext('2d');
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    var margin = Math.round(W * (img.paper === 'lined' ? 0.1 : 0.08)), width = W - margin - Math.round(W * 0.07);
    var text = el.text.value, size = img.size * W / 1080, lay, fitted = false;
    var mctx = c;
    var missing = function (ch) { mctx.font = Math.round(size * 0.72) + 'px Georgia, serif'; return mctx.measureText(ch).width / (size / FM.EM); };
    for (var tries = 0; tries < 24; tries++) {
      lay = FM.layoutText(text, glyphInfo, { size: size, width: width, lineHeight: img.lh, align: img.align, jitter: img.wobble / 100, seed: img.seed, space: font.settings.space, missing: missing });
      if (lay.height <= H - 2 * margin || size < 14) break;
      size *= 0.92; fitted = true;
    }
    var lh = img.lh * size, top = margin + size * 0.9;
    paintPaper(c, W, H, img.paper, lay.lines.length, top, lh);
    c.fillStyle = img.ink;
    var k = size / FM.EM, drawn = 0, miss = {};
    lay.lines.forEach(function (line) {
      line.items.forEach(function (it) {
        if (it.ch === ' ') return;
        var x = margin + it.x, y = margin + it.y;
        if (it.missing) {
          miss[it.ch] = 1;
          c.save(); c.globalAlpha = 0.85; c.font = Math.round(size * 0.72) + 'px Georgia, serif'; c.fillText(it.ch, x, y); c.restore();
          return;
        }
        var sh = shapeFor(it.ch, it.vi), p = sh && path2d(sh);
        if (!p) return;
        c.save(); c.translate(x, y); if (it.rot) c.rotate(it.rot); c.scale(k * it.scale, -k * it.scale); c.fill(p); c.restore();
        drawn++;
      });
    });
    var mk = Object.keys(miss);
    el.imeta.textContent = W + ' × ' + H + (fitted ? ' · text shrunk to fit' : '') + (mk.length ? ' · not drawn yet: ' + mk.slice(0, 12).join(' ') + (mk.length > 12 ? ' …' : '') : '');
    png = null;
    later('png', 350, makePng);
  }
  function pngSig() { return fontSig() + '|' + JSON.stringify(img) + '|' + el.text.value; }
  function makePng() {
    if (!P || !el.img) return Promise.resolve(null);
    var sig = pngSig();
    if (png && png.sig === sig) return Promise.resolve(png.blob);
    return new Promise(function (res) {
      el.img.toBlob(function (b) { if (b && P) png = { sig: sig, blob: b }; res(b); }, 'image/png');
    });
  }
  function pngName() { return fileBase().replace(/\s+/g, '-').toLowerCase() + '-' + new Date().toISOString().slice(0, 10) + '.png'; }
  function imageAction(a) {
    if (a === 'pcopy') {
      if (!navigator.clipboard || typeof ClipboardItem === 'undefined') { toast('Copying pictures isn’t supported here', 'error'); return; }
      var pp = png && png.sig === pngSig() ? Promise.resolve(png.blob) : makePng();
      navigator.clipboard.write([new ClipboardItem({ 'image/png': pp })]).then(function () { toast('Picture copied', 'success'); }, function () { toast('Couldn’t copy the picture', 'error'); });
      return;
    }
    var withBlob = function (fn) { if (png && png.sig === pngSig()) fn(png.blob); else makePng().then(function (b) { if (b) fn(b); else toast('Couldn’t make the picture', 'error'); }); };
    if (a === 'psave') withBlob(function (b) { deliver(b, pngName(), 'image/png').then(function (r) { if (r === 'downloaded') toast('Picture saved', 'success'); }); });
    else if (a === 'pattach') withBlob(function (b) {
      if (!Cade.files || !Cade.files.attach) { toast('Attaching isn’t available', 'error'); return; }
      var f; try { f = new File([b], pngName(), { type: 'image/png' }); } catch (e) { f = b; }
      Promise.resolve(Cade.files.attach(f)).then(function () { toast('Picture attached to the note', 'success'); }, function (e) { toast((e && e.message) || 'Couldn’t attach the picture', 'error'); });
    });
  }

  // ---------------------------------------------------------------- fonts
  function openFont(id) {
    var p = id ? getFont(id) : Promise.resolve(null);
    return p.then(function (f) {
      if (!P) return;
      if (!f) {
        f = FM.newFont(defaultName());
        return putFont(f).then(function () { return useFont(f); });
      }
      return useFont(f);
    });
  }
  function useFont(f) {
    if (!P) return;
    font = f; shapes = {}; rev = {}; built = null; png = null;
    sset(LAST_KEY, f.id);
    var first = FM.step(font, setChars(), null, 1, true);
    if (!FM.hasGlyph(font, cur.ch) && first) cur.ch = first;
    cur.vi = 0;
    if (setChars().indexOf(cur.ch) < 0) cur.ch = setChars()[0];
    renderAll();
    drawCanvas(); drawWord();
  }
  function switchFont(id) { if (font && id === font.id) return; flushSave().then(function () { return openFont(id); }); }
  function newFontAct() {
    flushSave().then(function () {
      var f = FM.newFont(defaultName());
      return putFont(f).then(function () { useFont(f); tab = 'draw'; renderTabs(); sizeCanvas(); toast('New font “' + f.name + '”', 'success'); });
    });
  }
  function dupFont() {
    flushSave().then(function () {
      var f = FM.cloneFont(font, font.name + ' copy');
      return putFont(f).then(function () { useFont(f); toast('Duplicated as “' + f.name + '”', 'success'); });
    });
  }
  function delFont() {
    if (!window.confirm('Delete the font “' + font.name + '” and all its drawn letters?' + (font.sync ? ' It is removed from your other devices too.' : ''))) return;
    var f = font, wasSync = f.sync;
    clearTimer('save');
    fonts = fonts.filter(function (x) { return x.id !== f.id; });
    font = null;
    Promise.all([idb().remove(FONT_KEY + f.id), saveIndex()]).then(function () {
      if (wasSync && ensureBlob()) {
        var d = blobData(); d.deleted = d.deleted || {}; d.deleted[f.id] = Date.now();
        if (d.fonts) delete d.fonts[f.id];
        blob.set(d);
      }
      toast('Deleted “' + f.name + '”', 'info');
      return openFont(fonts.length ? fonts[0].id : null);
    });
  }
  function toggleSync(on) {
    if (!syncAvailable()) { el.sync.checked = false; toast('Set up Sync first (Settings → Sync)', 'info', 2600); return; }
    ensureBlob();
    font.sync = !!on;
    var e = fonts.filter(function (x) { return x.id === font.id; })[0]; if (e) e.sync = font.sync;
    flushSave().then(pushSync).then(function (ok) {
      if (on && ok === false) { font.sync = false; if (e) e.sync = false; el.sync.checked = false; flushSave(); }
      else toast(on ? 'This font now syncs to your other devices' : 'This font stays on this device', 'success');
      renderFontList();
    });
  }

  // ---------------------------------------------------------------- events
  function onClick(e) {
    var t = e.target.closest ? e.target.closest('button') : null;
    if (!t || !P.contains(t)) return;
    var a = t.getAttribute('data-act');
    if (t.hasAttribute('data-tab')) { tab = t.getAttribute('data-tab'); renderTabs(); if (tab === 'draw') sizeCanvas(); else if (tab === 'font') renderFontTab(); else { if (!el.text.value) el.text.value = selectionText() || img.text || 'Hello from my own handwriting!'; renderImageTab(); } return; }
    if (t.hasAttribute('data-set')) { cur.set = t.getAttribute('data-set'); renderSets(); var ch = FM.step(font, setChars(), null, 1, true) || setChars()[0]; renderStrip(); select(ch); return; }
    if (t.hasAttribute('data-ch')) { select(t.getAttribute('data-ch')); return; }
    if (t.hasAttribute('data-vi')) { select(cur.ch, +t.getAttribute('data-vi')); return; }
    if (t.hasAttribute('data-preset')) { img.preset = t.getAttribute('data-preset'); saveImg(); renderImageTab(); return; }
    if (t.hasAttribute('data-paper')) { img.paper = t.getAttribute('data-paper'); saveImg(); renderImageTab(); return; }
    if (t.hasAttribute('data-align')) { img.align = t.getAttribute('data-align'); saveImg(); renderImageTab(); return; }
    if (t.hasAttribute('data-ink')) { img.ink = t.getAttribute('data-ink'); saveImg(); renderImageTab(); return; }
    if (!a) return;
    if (a === 'prev') go(-1);
    else if (a === 'next') go(1);
    else if (a === 'undo') { if (FM.undoStroke(font, cur.ch, cur.vi)) { touched(cur.ch); cur.vi = Math.min(cur.vi, (font.glyphs[cur.ch] || []).length); afterEdit(); } }
    else if (a === 'clear') { if (FM.clearGlyph(font, cur.ch, cur.vi)) { touched(cur.ch); cur.vi = Math.min(cur.vi, (font.glyphs[cur.ch] || []).length); afterEdit(); } }
    else if (a === 'prefs') { if (Cade.prefs && Cade.prefs.open) Cade.prefs.open('fontmaker'); }
    else if (a === 'otf') saveFont('otf');
    else if (a === 'woff') saveFont('woff');
    else if (a === 'editor') {
      S.editor = !S.editor;
      if (S.editor && !(S.family && S.family === font.name)) build().then(register).then(applyEditorFont, function () {});
      else applyEditorFont();
      t.classList.toggle('on', S.editor); t.setAttribute('aria-pressed', S.editor ? 'true' : 'false');
    }
    else if (a === 'new') newFontAct();
    else if (a === 'dup') dupFont();
    else if (a === 'del') delFont();
    else if (a === 'shuffle') { img.seed = (img.seed * 7 + 13) % 9973 || 7; saveImg(); schedule(); }
    else imageAction(a);
  }
  function onInput(e) {
    var t = e.target;
    if (t === el.name) {
      var v = t.value.trim().slice(0, 60);
      if (v && v !== font.name) { font.name = v; fonts.forEach(function (x) { if (x.id === font.id) x.name = v; }); dirty(); later('names', 300, renderFontList); }
      return;
    }
    if (t === el.text) { img.text = t.value.slice(0, 4000); later('imgsave', 600, saveImg); schedule(); return; }
    if (t === el.inkc) { img.ink = t.value; saveImg(); renderImageTab(); return; }
    var k = t.getAttribute && t.getAttribute('data-sl');
    if (!k) return;
    var val = +t.value;
    if (k in font.settings) { font.settings[k] = val; font.settings = FM.normSettings(font.settings); setSlider(k, font.settings[k]); shapes = {}; dirty(); if (k === 'weight') renderStrip(); }
    else { img[k] = val; setSlider(k, val); later('imgsave', 600, saveImg); schedule(); }
  }
  function onChange(e) {
    if (e.target === el.fontsel) switchFont(el.fontsel.value);
    else if (e.target === el.sync) toggleSync(el.sync.checked);
    else if (e.target === el.name && !el.name.value.trim()) el.name.value = font.name;
  }
  function onKey(e) {
    if (Cade.isMinimized && Cade.isMinimized(P)) return;
    var tg = e.target, typing = tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT' || tg.isContentEditable);
    if (typing || tab !== 'draw') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); q('[data-act="undo"]').click(); }
  }
  function onMin() { if (raf) { cancelAnimationFrame(raf); raf = 0; } clearTimer('auto'); }
  function onRestore() { sizeCanvas(); if (tab === 'image') schedule(); }
  function onResize() { later('resize', 120, sizeCanvas); }
  function onRemote(data) { if (P) mergeRemote(data); }

  // ---------------------------------------------------------------- open / close
  function cleanup() {
    if (!P && !font) return;
    for (var k in timers) clearTimer(k);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (font) { var f = font; putFont(f); }
    if (font && font.sync) pushSync();
    if (offPref) { try { offPref(); } catch (e) {} offPref = null; }
    if (ro) { ro.disconnect(); ro = null; }
    if (mo) { mo.disconnect(); mo = null; }
    window.removeEventListener('resize', onResize);
    if (window.__fontmakerOnRemote === onRemote) window.__fontmakerOnRemote = null;
    if (el.cv) {
      el.cv.removeEventListener('touchstart', stopTouch);
      el.cv.removeEventListener('touchmove', stopTouch);
      el.cv.width = el.cv.height = 0;
    }
    if (el.img) el.img.width = el.img.height = 0;
    P = null; el = {}; font = null; fonts = []; shapes = {}; rev = {}; stroke = null; built = null; building = null; png = null; blob = null; cvSize = 0;
  }
  function close() {
    var p = P;
    cleanup();
    if (p) p.remove();
  }
  function open() {
    try { Cade.closeAllMenus(); } catch (e) {}
    if (document.getElementById(PANEL_ID)) { close(); return; }
    loadCore().then(function (core) {
      FM = core;
      if (document.getElementById(PANEL_ID)) return;
      Pref = prefsOf('fontmaker', PREFS_FIELDS);
      loadImg();
      P = Cade.mkPanel(PANEL_ID, '✍️ Font Maker', bodyHtml());
      P.dataset.prefs = 'fontmaker';
      P._onClose = cleanup;
      el = {
        fontsel: q('.fm-fontsel'), strip: q('.fm-strip'), stage: q('.fm-stage'), cv: q('.fm-cv'), chLabel: q('.fm-ch'), word: q('.fm-word'),
        name: q('.fm-name'), sync: q('.fm-sync'), synchint: q('.fm-synchint'), sample: q('.fm-sample'), fmeta: q('.fm-fmeta'),
        text: q('.fm-text'), img: q('.fm-img'), imeta: q('.fm-imeta'), inkc: q('.fm-inkc')
      };
      P.addEventListener('click', onClick);
      P.addEventListener('input', onInput);
      P.addEventListener('change', onChange);
      P.addEventListener('keydown', onKey);
      P.addEventListener('cade-panel-minimize', onMin);
      P.addEventListener('cade-panel-restore', onRestore);
      el.cv.addEventListener('pointerdown', onDown);
      el.cv.addEventListener('pointermove', onMove);
      el.cv.addEventListener('pointerup', onUp);
      el.cv.addEventListener('pointercancel', onUp);
      el.cv.addEventListener('touchstart', stopTouch, { passive: false });
      el.cv.addEventListener('touchmove', stopTouch, { passive: false });
      el.cv.addEventListener('contextmenu', stopTouch);
      window.addEventListener('resize', onResize);
      if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(onResize); ro.observe(el.stage); }
      mo = new MutationObserver(function () { drawCanvas(); drawWord(); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      offPref = Pref.on(function () { drawCanvas(); drawWord(); });
      window.__fontmakerOnRemote = onRemote;
      el.strip.innerHTML = '<div class="fm-meta">Loading your fonts…</div>';
      return idb().get(IDX_KEY).then(function (ix) {
        if (!P) return;
        if (typeof ix === 'string') { try { ix = JSON.parse(ix); } catch (e) { ix = null; } }
        fonts = Array.isArray(ix) ? ix.filter(function (f) { return f && f.id; }) : [];
        var last = sget(LAST_KEY);
        var id = fonts.some(function (f) { return f.id === last; }) ? last : fonts.length ? fonts[0].id : null;
        return openFont(id);
      }).then(function () {
        if (P && ensureBlob()) return mergeRemote(blob.get());
      });
    }).catch(function (e) { toast((e && e.message) || 'Font Maker failed to open', 'error'); });
  }

  Cade.registerWidget({ name: META.name, description: META.description, icon: META.icon, tags: META.tags, prefsFields: PREFS_FIELDS, open: open, close: close });
  // for tests: the panel's internals
  window.__fontmakerDebug = { state: function () { return { font: font, fonts: fonts, cur: cur, tab: tab, built: built, session: S }; }, build: function () { return build(); }, makePng: function () { return makePng(); } };
})();
