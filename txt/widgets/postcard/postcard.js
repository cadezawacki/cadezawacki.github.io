/* ASCII Postcard — turn a photo into coloured text art kept in the note: a
 * visual diary that is still just text (format: postcard-core.js).
 *
 * Pick a photo (the file picker offers camera or library on a phone), paste
 * one (⌘V on the photo area, or 📋 where the clipboard can be read) or drop
 * one; it is decoded (EXIF orientation applied) and immediately shrunk to at
 * most 960 px, so no 12 MP bitmap is kept. Style, colour mode, paper, width,
 * brightness, contrast, gamma, dithering, invert and auto levels re-render on
 * the next animation frame (conversion runs on the main thread: ~5–20 ms).
 * The caption is the date (and an optional place).
 *
 * Insert writes the fenced block at the caret (own lines; refused in read-only
 * mode); Copy text copies the plain art; PNG downloads the card; Share hands a
 * PNG to the share sheet where the browser can (iPhone). "In this note" lists
 * the note's postcards as thumbnails — tap one to scroll to it.
 * Nothing runs until the panel opens; close removes every listener and frees
 * the picture. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('postcard.css');
  var CORE_URL = Cade.asset ? Cade.asset('postcard-core.js') : './txt/widgets/postcard/postcard-core.js';
  var PANEL_ID = 'postcard-panel', PREFS_KEY = 'cade-postcard-prefs';
  var MAX_SRC = 960;

  var META = {
    name: 'ASCII Postcard',
    description: 'Turn a photo into coloured text art kept in your note — classic, dense, blocks, braille, edges or your own words; copy it, save a PNG or share it. A visual diary that is still just text',
    icon: '🖼',
    tags: 'ascii,ascii art,postcard,photo,picture,image,camera,text art,braille,diary,journal,memory,art,colour,color,png,share,convert,draw'
  };

  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2000); } catch (e) {} }
  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function isPhone() { try { return window.matchMedia('(max-width: 560px)').matches; } catch (e) { return false; } }
  function themeDark() { try { return document.documentElement.getAttribute('data-theme') === 'dark'; } catch (e) { return false; } }

  function loadCore() {
    if (window.__cadePostcard) return Promise.resolve(window.__cadePostcard);
    if (!window.__cadePostcardP) {
      window.__cadePostcardP = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = CORE_URL;
        s.onload = function () { if (window.__cadePostcard) res(window.__cadePostcard); else { window.__cadePostcardP = null; rej(new Error('missing')); } };
        s.onerror = function () { window.__cadePostcardP = null; rej(new Error('ASCII Postcard failed to load (offline?)')); };
        document.head.appendChild(s);
      });
    }
    return window.__cadePostcardP;
  }

  // ---- prefs (UI units: sliders -100..100, gamma ×100) ----
  var DEF = { cols: 64, style: 'classic', mode: 'color', bg: '', tint: '#e07a5f', bright: 0, contrast: 0, gamma: 100, invert: false, dither: false, auto: true, colors: 32, phrase: 'POSTCARD', place: '' };
  var prefs = {};
  function loadPrefs() {
    var p = {};
    try { p = JSON.parse(sget(PREFS_KEY) || '{}') || {}; } catch (e) { p = {}; }
    for (var k in DEF) prefs[k] = p[k] !== undefined && typeof p[k] === typeof DEF[k] ? p[k] : DEF[k];
    if (['dark', 'light', 'paper'].indexOf(prefs.bg) < 0) prefs.bg = themeDark() ? 'dark' : 'light';
  }
  function savePrefs() { sset(PREFS_KEY, JSON.stringify(prefs)); }
  function opts() {
    return {
      cols: prefs.cols, style: prefs.style, mode: prefs.mode, bg: prefs.bg, tint: prefs.tint,
      brightness: prefs.bright / 100, contrast: prefs.contrast / 100, gamma: prefs.gamma / 100,
      invert: prefs.invert, dither: prefs.dither, auto: prefs.auto, colors: prefs.colors, phrase: prefs.phrase,
      caption: caption()
    };
  }
  function today() {
    var d = new Date(), M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + M[d.getMonth()] + ' ' + d.getFullYear();
  }
  function caption() {
    if (!el.place) return '';
    var place = el.place.value.trim(), date = el.date.value.trim();
    return place && date ? place + ', ' + date : place || date;
  }

  // ---- panel ----
  var P = null, el = {}, PC = null, src = null, card = null, raf = 0, listTimer = 0, busy = false;
  var STYLES = [['classic', 'classic', 'Ten-step ramp  .:-=+*#%@'], ['dense', 'dense', 'Seventy characters, finest tones'], ['blocks', 'blocks', 'Shade blocks ░▒▓█'], ['braille', 'braille', 'Braille dots: 2×4 per character, the most detail'], ['edges', 'edges', 'Outlines drawn with - | / \\'], ['text', 'words', 'Your words, repeated — the colour carries the picture']];
  var MODES = [['color', 'colour', 'Every character in its own colour'], ['mono', 'mono', 'Text colour only'], ['tint', 'tint', 'One colour of your choice'], ['green', 'green', 'Green terminal'], ['sepia', 'sepia', 'Old photo brown']];
  var BGS = [['dark', 'dark', 'Dark paper: bright parts get the dense characters'], ['light', 'light', 'Light paper: dark parts get the dense characters'], ['paper', 'paper', 'Warm paper']];
  var COLORS = [8, 16, 32, 64];
  var SLIDERS = [['cols', 'Width', 24, 160, 1], ['bright', 'Bright', -100, 100, 1], ['contrast', 'Contrast', -100, 100, 1], ['gamma', 'Gamma', 30, 300, 5]];

  function bodyHtml() {
    function seg(name, items) {
      return '<div class="pc-seg" role="group" data-seg="' + name + '">' + items.map(function (it) {
        return '<button type="button" class="pc-sb" data-' + name + '="' + it[0] + '" title="' + esc(it[2] || '') + '">' + esc(it[1]) + '</button>';
      }).join('') + '</div>';
    }
    return '<div class="pc">' +
      '<div class="pc-tabs" role="tablist">' +
        '<button type="button" class="pc-tab on" data-tab="make" role="tab">Create</button>' +
        '<button type="button" class="pc-tab" data-tab="list" role="tab">In this note <span class="pc-cnt"></span></button>' +
      '</div>' +
      '<div class="pc-make">' +
        '<div class="pc-stage" tabindex="0" role="button" aria-label="Photo — tap to choose one, paste or drop">' +
          '<canvas class="pc-cv" hidden></canvas>' +
          '<div class="pc-empty"><div class="pc-empty-i" aria-hidden="true">🖼</div><b>Choose a photo</b><span>tap to take or pick one · paste · drop</span></div>' +
          '<div class="pc-dropping">Drop the photo here</div>' +
        '</div>' +
        '<div class="pc-row pc-pick">' +
          '<button type="button" class="pc-btn" data-act="pick">📷 Photo…</button>' +
          '<button type="button" class="pc-btn" data-act="paste" title="Paste a copied image">📋 Paste</button>' +
          '<button type="button" class="pc-btn" data-act="sample" title="Try it on a sample picture">✦ Sample</button>' +
          '<span class="pc-meta" aria-live="polite"></span>' +
        '</div>' +
        '<input type="file" accept="image/*" class="pc-file" tabindex="-1" aria-hidden="true">' +
        '<div class="pc-ctl">' +
          '<div class="pc-f"><span class="pc-l">Style</span>' + seg('style', STYLES) + '</div>' +
          '<div class="pc-f"><span class="pc-l">Colour</span>' + seg('mode', MODES) +
            '<input type="color" class="pc-tint" title="Tint colour" aria-label="Tint colour"></div>' +
          '<div class="pc-f pc-only-color"><span class="pc-l">Palette</span>' + seg('colors', COLORS.map(function (n) { return [n, String(n), n + ' colours at most']; })) + '</div>' +
          '<div class="pc-f"><span class="pc-l">Paper</span>' + seg('bg', BGS) + '</div>' +
          '<div class="pc-f pc-only-text"><span class="pc-l">Words</span><input type="text" class="pc-in pc-phrase" maxlength="80" placeholder="a word or phrase" autocomplete="off" spellcheck="false"></div>' +
          '<div class="pc-sls">' + SLIDERS.map(function (s) {
            return '<label class="pc-sl"><span class="pc-l">' + s[1] + '</span><input type="range" data-sl="' + s[0] + '" min="' + s[2] + '" max="' + s[3] + '" step="' + s[4] + '">' +
              '<button type="button" class="pc-v" data-reset="' + s[0] + '" title="Reset"></button></label>';
          }).join('') + '</div>' +
          '<div class="pc-f pc-tgs">' +
            '<button type="button" class="pc-tg" data-tog="dither" title="Floyd–Steinberg dithering: smoother tones from fewer characters">dither</button>' +
            '<button type="button" class="pc-tg" data-tog="invert" title="Swap which parts get the dense characters">invert</button>' +
            '<button type="button" class="pc-tg" data-tog="auto" title="Stretch the tones to the full range first">auto levels</button>' +
          '</div>' +
          '<div class="pc-f pc-capf"><span class="pc-l">Caption</span>' +
            '<input type="text" class="pc-in pc-place" maxlength="60" placeholder="Place (optional)" autocomplete="off">' +
            '<input type="text" class="pc-in pc-date" maxlength="40" aria-label="Date" autocomplete="off"></div>' +
        '</div>' +
        '<div class="pc-acts">' +
          '<button type="button" class="pc-btn pc-go" data-act="insert" title="Insert the postcard at the cursor">↧ Insert into note</button>' +
          '<button type="button" class="pc-btn" data-act="copy" title="Copy the art as plain text">Copy<span class="pc-wide"> text</span></button>' +
          '<button type="button" class="pc-btn" data-act="png" title="Download as a PNG picture">PNG</button>' +
          '<button type="button" class="pc-btn pc-share" data-act="share" title="Share as a picture">Share</button>' +
        '</div>' +
      '</div>' +
      '<div class="pc-list" hidden></div>' +
    '</div>';
  }
  function q(s) { return P.querySelector(s); }

  function paint() {
    var bs = P.querySelectorAll('.pc-sb');
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i], on = false;
      if (b.hasAttribute('data-style')) on = b.getAttribute('data-style') === prefs.style;
      else if (b.hasAttribute('data-mode')) on = b.getAttribute('data-mode') === prefs.mode;
      else if (b.hasAttribute('data-bg')) on = b.getAttribute('data-bg') === prefs.bg;
      else if (b.hasAttribute('data-colors')) on = +b.getAttribute('data-colors') === prefs.colors;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    var tg = P.querySelectorAll('[data-tog]');
    for (i = 0; i < tg.length; i++) { var k = tg[i].getAttribute('data-tog'); tg[i].classList.toggle('on', !!prefs[k]); tg[i].setAttribute('aria-pressed', prefs[k] ? 'true' : 'false'); }
    SLIDERS.forEach(function (s) {
      var inp = P.querySelector('[data-sl="' + s[0] + '"]'), out = P.querySelector('[data-reset="' + s[0] + '"]');
      if (+inp.value !== prefs[s[0]]) inp.value = prefs[s[0]];
      out.textContent = s[0] === 'gamma' ? (prefs.gamma / 100).toFixed(2) : s[0] === 'cols' ? String(prefs.cols) : (prefs[s[0]] > 0 ? '+' : '') + prefs[s[0]];
    });
    el.tint.value = prefs.tint;
    P.setAttribute('data-style', prefs.style);
    P.setAttribute('data-mode', prefs.mode);
  }
  function setMeta(t) { if (el.meta) el.meta.textContent = t; }
  function hasPic(on) {
    P.classList.toggle('pc-has', !!on);
    el.cv.hidden = !on;
  }

  // ---- rendering (one conversion per animation frame at most) ----
  function schedule() { if (!raf && P) raf = requestAnimationFrame(run); }
  function run() {
    raf = 0;
    if (!P || !src || !PC) return;
    if (Cade.isMinimized && Cade.isMinimized(P)) return;
    var t0 = performance.now();
    card = PC.convert(src.data, src.w, src.h, opts());
    var t1 = performance.now();
    drawPreview();
    setMeta(card.cols + '×' + card.rows + (card.palette ? ' · ' + card.palette.length / 3 + ' colours' : '') + ' · ' + Math.round(t1 - t0) + ' ms');
  }
  function drawPreview() {
    var st = el.stage, sw = Math.max(120, st.clientWidth - 2);
    var maxH = Math.max(160, window.innerHeight * (isPhone() ? 0.36 : 0.46));
    var aspect = (card.rows * 2 + 2) / (card.cols + 2);
    var cssW = Math.min(sw, maxH / aspect), dpr = Math.min(2, window.devicePixelRatio || 1);
    PC.render(el.cv, card, { width: Math.round(cssW * dpr), font: PC.monoFont() });
    el.cv.style.width = Math.round(cssW) + 'px';
  }

  // ---- getting a picture in ----
  function isImage(f) { return !!f && (/^image\//.test(f.type || '') || /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i.test(f.name || '')); }
  function viaImg(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { res({ src: img, w: img.naturalWidth, h: img.naturalHeight, done: function () { URL.revokeObjectURL(url); img.src = ''; } }); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src = url;
    });
  }
  function decodeImage(blob) {
    if (typeof createImageBitmap !== 'function') return viaImg(blob);
    function wrap(b) { return { src: b, w: b.width, h: b.height, done: function () { try { b.close(); } catch (e) {} } }; }
    return createImageBitmap(blob, { imageOrientation: 'from-image' }).then(wrap, function () {
      return createImageBitmap(blob).then(wrap);
    }).catch(function () { return viaImg(blob); });
  }
  // Halve until close, then one high-quality step: RGBA of at most MAX_SRC px.
  function shrink(im) {
    var w = im.w, h = im.h, s = Math.min(1, MAX_SRC / Math.max(w, h)), tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
    var cur = im.src, cw = w, ch = h, tmp = null;
    while (cw > tw * 2 && ch > th * 2) {
      var nw = Math.round(cw / 2), nh = Math.round(ch / 2), c = document.createElement('canvas');
      c.width = nw; c.height = nh;
      var cx = c.getContext('2d'); cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
      cx.drawImage(cur, 0, 0, nw, nh);
      if (tmp) tmp.width = tmp.height = 0;
      cur = tmp = c; cw = nw; ch = nh;
    }
    var f = document.createElement('canvas');
    f.width = tw; f.height = th;
    var fx = f.getContext('2d', { willReadFrequently: true });
    fx.imageSmoothingEnabled = true; fx.imageSmoothingQuality = 'high';
    fx.drawImage(cur, 0, 0, tw, th);
    var data = fx.getImageData(0, 0, tw, th).data;
    if (tmp) tmp.width = tmp.height = 0;
    f.width = f.height = 0;
    return { data: data, w: tw, h: th };
  }
  function takeFile(file) {
    if (!P) return;
    if (!isImage(file)) { toast('That isn’t a picture', 'error'); return; }
    if (busy) return;
    busy = true;
    setMeta('reading…');
    Promise.all([loadCore(), decodeImage(file)]).then(function (r) {
      PC = r[0];
      var im = r[1];
      try { src = shrink(im); } finally { im.done(); }
      busy = false;
      if (!P) { src = null; return; }
      hasPic(true);
      schedule();
    }).catch(function (e) {
      busy = false;
      setMeta('');
      toast(/load/.test(e && e.message) ? e.message : 'Couldn’t read that picture', 'error', 2600);
    });
  }
  function useSample() {
    loadCore().then(function (core) {
      PC = core;
      if (!P) return;
      var d = PC.demoImage(640, 420);
      src = { data: d.data, w: d.width, h: d.height };
      hasPic(true);
      schedule();
    }, function (e) { toast(e.message, 'error'); });
  }
  function pasteButton() {
    var cb = navigator.clipboard;
    if (!cb || !cb.read) { toast('Copy a picture, then press ' + (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘V' : 'Ctrl+V') + ' on the photo area', 'info', 2800); el.stage.focus(); return; }
    cb.read().then(function (items) {
      for (var i = 0; i < items.length; i++) {
        var types = items[i].types || [];
        for (var j = 0; j < types.length; j++) {
          if (/^image\//.test(types[j])) {
            var t = types[j];
            return items[i].getType(t).then(function (blob) { takeFile(new File([blob], 'pasted', { type: blob.type || t })); });
          }
        }
      }
      toast('No picture on the clipboard', 'info');
    }).catch(function () { toast('Couldn’t read the clipboard — try ⌘V / Ctrl+V on the photo area', 'info', 2800); });
  }
  function onPaste(e) {
    var cd = e.clipboardData, items = cd && cd.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
        var f = items[i].getAsFile();
        if (f) { e.preventDefault(); e.stopPropagation(); takeFile(f); return; }
      }
    }
  }
  function hasFiles(e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0; }
  var dragN = 0;
  function onDragEnter(e) { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); dragN++; P.classList.add('pc-drag'); }
  function onDragOver(e) { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); try { e.dataTransfer.dropEffect = 'copy'; } catch (x) {} }
  function onDragLeave(e) { if (!hasFiles(e)) return; e.stopPropagation(); dragN = Math.max(0, dragN - 1); if (!dragN) P.classList.remove('pc-drag'); }
  function onDrop(e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    dragN = 0; P.classList.remove('pc-drag');
    // the app's own drop overlay counts enters/leaves on window — let it reset
    try { window.dispatchEvent(new Event('dragleave')); } catch (x) {}
    var fs = e.dataTransfer.files;
    for (var i = 0; i < fs.length; i++) if (isImage(fs[i])) { takeFile(fs[i]); return; }
    toast('That isn’t a picture', 'error');
  }

  // ---- output ----
  function finalCard() {
    if (!card) return null;
    card.caption = PC.cleanCaption(caption());
    return card;
  }
  function needPic() { if (!card) { toast('Choose a photo first', 'info'); return true; } return false; }
  function insert() {
    if (needPic()) return;
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
    var c = finalCard();
    PC.cardToText(c).then(function (text) {
      var e2 = Cade.editor;
      if (!e2 || e2.state.readOnly) return;
      var st = e2.state, sel = st.selection.main, end = fenceEndAt(st.doc, sel.from);
      if (end >= 0) {
        // the caret is inside a ``` block: a fence inside a fence would break both — go after it
        var ins2 = '\n' + text + '\n';
        e2.dispatch({ changes: { from: end, insert: ins2 }, selection: { anchor: end + ins2.length }, userEvent: 'input.paste', scrollIntoView: true });
      } else {
        var before = sel.from > 0 ? st.doc.sliceString(sel.from - 1, sel.from) : '\n';
        var ins = (before === '\n' ? '' : '\n') + text + '\n';
        e2.dispatch(e2.state.replaceSelection(ins), { userEvent: 'input.paste', scrollIntoView: true });
      }
      toast('Postcard inserted', 'success', 1400);
      if (isPhone() && Cade.minimizePanel) Cade.minimizePanel(P);
    });
  }
  // End of the ``` block holding pos (the editor's rule: a line starting with
  // ``` opens or closes one), or -1 when pos is outside every block.
  function fenceEndAt(doc, pos) {
    var open = -1;
    for (var it = doc.iterLines(), from = 0; !it.next().done;) {
      var t = it.value, lf = from;
      from += t.length + 1;
      if (open < 0 && lf > pos) return -1;          // past the caret outside any block
      if (t.charCodeAt(0) === 96 && t.lastIndexOf('```', 0) === 0) {
        if (open < 0) open = lf;
        else { if (pos <= lf + t.length) return lf + t.length; open = -1; }
      }
    }
    return open >= 0 && pos >= open ? doc.length : -1;
  }
  function copyText(s) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s);
    return new Promise(function (res, rej) {
      var ta = document.createElement('textarea');
      ta.value = s; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      if (ok) res(); else rej(new Error('copy failed'));
    });
  }
  function pngBlob() { return PC.toPng(finalCard()); }
  function fileName() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    var place = (el.place.value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
    return 'postcard-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + (place ? '-' + place : '') + '.png';
  }
  function download(blob, name) { PC.download(blob, name); }
  function savePng() {
    if (needPic()) return;
    pngBlob().then(function (b) { download(b, fileName()); }, function () { toast('Couldn’t make the picture', 'error'); });
  }
  function canShareFiles() {
    try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] })); } catch (e) { return false; }
  }
  // iOS only shares inside the tap's user activation; building the PNG is
  // async, so when the sheet is refused the picture is kept and the next tap
  // shares it at once.
  var shareReady = null;
  function share() {
    if (needPic()) return;
    var key = card, cap = caption();
    if (shareReady && shareReady.card === key && shareReady.cap === cap) { sendShare(shareReady.file, false); return; }
    pngBlob().then(function (b) {
      shareReady = { card: key, cap: cap, file: new File([b], fileName(), { type: 'image/png' }) };
      sendShare(shareReady.file, true);
    }).catch(function () { toast('Couldn\u2019t make the picture', 'error'); });
  }
  function sendShare(f, late) {
    var data = { files: [f], title: caption() || 'ASCII postcard' };
    if (!(navigator.canShare && navigator.canShare(data))) { download(f, f.name); toast('Sharing pictures isn\u2019t available here — saved the PNG', 'info', 2400); return; }
    navigator.share(data).then(function () { shareReady = null; }, function (e) {
      if (e && e.name === 'AbortError') return;
      if (late && e && e.name === 'NotAllowedError') toast('Picture ready — tap Share again', 'info', 2600);
      else toast('Couldn\u2019t share the picture', 'error');
    });
  }

  // ---- "In this note" ----
  function noteBlocks() {
    var ed = Cade.editor;
    if (!ed || !PC) return [];
    var doc = ed.state.doc, t = doc.toString();
    return PC.findBlocks(t);
  }
  function countBadge(n) { var c = q('.pc-cnt'); if (c) c.textContent = n ? '(' + n + ')' : ''; }
  function showTab(tab) {
    var list = tab === 'list';
    P.querySelectorAll('.pc-tab').forEach(function (b) { var on = b.getAttribute('data-tab') === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    q('.pc-make').hidden = list;
    el.list.hidden = !list;
    if (list) loadCore().then(function (c) { PC = c; renderList(); }, function (e) { toast(e.message, 'error'); });
  }
  function renderList() {
    if (!P || el.list.hidden) return;
    var bl = noteBlocks();
    countBadge(bl.length);
    if (!bl.length) { el.list.innerHTML = '<div class="pc-none">No postcards in this note yet — make one and insert it.</div>'; return; }
    var html = '';
    bl.forEach(function (b, i) {
      var c = b.card;
      html += '<div class="pc-li"><button type="button" class="pc-item" data-line="' + b.line + '">' +
        '<span class="pc-thumb pc-thumb-' + esc(c ? c.bg : 'dark') + '"><canvas data-i="' + i + '"></canvas></span>' +
        '<span class="pc-it"><b>' + esc(c && c.caption ? c.caption : 'Untitled postcard') + '</b>' +
        '<small>' + (c ? c.cols + '×' + c.rows + ' · ' + esc(c.style) + ' · ' : '') + 'line ' + b.line + '</small></span></button>' +
        (c ? '<button type="button" class="pc-dl" data-png="' + i + '" title="Download as a PNG picture" aria-label="Download PNG">⤓ PNG</button>' : '') + '</div>';
    });
    el.list.innerHTML = html;
    var font = PC.monoFont();
    PC.fontReady(font).then(function () {
      if (!P) return;
      var cvs = el.list.querySelectorAll('canvas[data-i]'), dpr = Math.min(2, window.devicePixelRatio || 1);
      for (var i = 0; i < cvs.length; i++) {
        var c = bl[+cvs[i].getAttribute('data-i')].card;
        if (c) PC.render(cvs[i], c, { width: Math.round(132 * dpr), font: font });
      }
    });
  }
  // ⤓ PNG on a postcard in the list
  function listPng(i, btn) {
    var bl = noteBlocks(), c = bl[i] && bl[i].card;
    if (!c) return;
    btn.disabled = true;
    PC.toPng(c).then(function (blob) {
      btn.disabled = false;
      PC.download(blob, PC.pngName(c.caption));
      toast('Postcard saved as a PNG', 'success');
    }, function () { btn.disabled = false; toast('Couldn\u2019t make the picture', 'error'); });
  }
  function jumpTo(line) {
    var ed = Cade.editor, CM = Cade.CM;
    if (!ed) return;
    var n = Math.min(line, ed.state.doc.lines), pos = ed.state.doc.line(n).from;
    ed.dispatch({ effects: CM.EditorView.scrollIntoView(pos, { y: 'start', yMargin: 70 }) });
    if (isPhone() && Cade.minimizePanel) Cade.minimizePanel(P);
  }
  function onEditorUpdate(u) {
    if (!P || !u.docChanged) return;
    clearTimeout(listTimer);
    listTimer = setTimeout(function () {
      if (!P || !PC) return;
      if (!el.list.hidden) renderList();
      else countBadge(noteBlocks().length);
    }, 500);
  }

  // ---- events ----
  function onClick(e) {
    var b = e.target.closest ? e.target.closest('button,[data-act],.pc-stage') : null;
    if (!b || !P.contains(b)) return;
    if (b.classList.contains('pc-stage')) { if (!P.classList.contains('pc-has')) el.file.click(); return; }
    var a = b.getAttribute('data-act');
    if (b.hasAttribute('data-tab')) { showTab(b.getAttribute('data-tab')); return; }
    if (b.hasAttribute('data-line')) { jumpTo(+b.getAttribute('data-line')); return; }
    if (b.hasAttribute('data-png')) { listPng(+b.getAttribute('data-png'), b); return; }
    var changed = true;
    if (b.hasAttribute('data-style')) prefs.style = b.getAttribute('data-style');
    else if (b.hasAttribute('data-mode')) { prefs.mode = b.getAttribute('data-mode'); if (prefs.mode === 'green' && prefs.bg !== 'dark') prefs.bg = 'dark'; }
    else if (b.hasAttribute('data-bg')) prefs.bg = b.getAttribute('data-bg');
    else if (b.hasAttribute('data-colors')) prefs.colors = +b.getAttribute('data-colors');
    else if (b.hasAttribute('data-tog')) { var k = b.getAttribute('data-tog'); prefs[k] = !prefs[k]; }
    else if (b.hasAttribute('data-reset')) { var r = b.getAttribute('data-reset'); prefs[r] = DEF[r]; }
    else {
      changed = false;
      if (a === 'pick') el.file.click();
      else if (a === 'paste') pasteButton();
      else if (a === 'sample') useSample();
      else if (a === 'insert') insert();
      else if (a === 'copy') { if (!needPic()) copyText(PC.plainText(card)).then(function () { toast('Art copied as text', 'success', 1200); }, function () { toast('Copy failed', 'error'); }); }
      else if (a === 'png') savePng();
      else if (a === 'share') share();
    }
    if (changed) { savePrefs(); paint(); schedule(); }
  }
  function onInput(e) {
    var t = e.target;
    if (t.hasAttribute && t.hasAttribute('data-sl')) {
      prefs[t.getAttribute('data-sl')] = +t.value;
      paint(); schedule();
    } else if (t === el.tint) { prefs.tint = t.value; schedule(); }
    else if (t === el.phrase) { prefs.phrase = t.value; if (prefs.style === 'text') schedule(); }
    else if (t === el.place) { prefs.place = t.value; }
    else return;
    clearTimeout(onInput.t);
    onInput.t = setTimeout(function () { onInput.t = 0; savePrefs(); }, 400);
  }
  function onKey(e) {
    if (e.key === 'Escape' && !(e.target && /INPUT|TEXTAREA/.test(e.target.tagName) && e.target.type === 'text' && e.target.value)) { e.preventDefault(); close(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target === el.stage) { e.preventDefault(); el.file.click(); }
  }
  function onFile() {
    var f = el.file.files && el.file.files[0];
    if (f) takeFile(f);
    el.file.value = '';
  }
  function onMin() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  function onRestore() { schedule(); }
  var resizeT = 0;
  function onResize() { clearTimeout(resizeT); resizeT = setTimeout(function () { if (P && card) drawPreview(); }, 150); }

  function cleanup() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(listTimer); clearTimeout(resizeT);
    if (onInput.t) { clearTimeout(onInput.t); onInput.t = 0; savePrefs(); }  // a pending slider / caption save
    try { Cade.offEditorUpdate(onEditorUpdate); } catch (e) {}
    window.removeEventListener('resize', onResize);
    if (el.cv) el.cv.width = el.cv.height = 0;
    P = null; el = {}; src = null; card = null; busy = false; dragN = 0; shareReady = null;
  }
  function close() {
    var p = P;
    cleanup();
    if (p) p.remove();
    try { if (!isPhone()) Cade.editor.focus(); } catch (e) {}
  }
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    loadPrefs();
    P = Cade.mkPanel(PANEL_ID, '🖼 ASCII Postcard', bodyHtml());
    P._onClose = cleanup;
    el = {
      stage: q('.pc-stage'), cv: q('.pc-cv'), file: q('.pc-file'), meta: q('.pc-meta'), list: q('.pc-list'),
      tint: q('.pc-tint'), phrase: q('.pc-phrase'), place: q('.pc-place'), date: q('.pc-date')
    };
    el.phrase.value = prefs.phrase;
    el.place.value = prefs.place;
    el.date.value = today();
    if (!canShareFiles()) q('.pc-share').hidden = true;
    P.addEventListener('click', onClick);
    P.addEventListener('input', onInput);
    P.addEventListener('keydown', onKey);
    P.addEventListener('paste', onPaste);
    P.addEventListener('dragenter', onDragEnter);
    P.addEventListener('dragover', onDragOver);
    P.addEventListener('dragleave', onDragLeave);
    P.addEventListener('drop', onDrop);
    P.addEventListener('cade-panel-minimize', onMin);
    P.addEventListener('cade-panel-restore', onRestore);
    el.file.addEventListener('change', onFile);
    window.addEventListener('resize', onResize);
    Cade.onEditorUpdate(onEditorUpdate);
    paint();
    hasPic(false);
    // the core is small; fetch it now so the first photo converts at once
    loadCore().then(function (c) { PC = c; if (P) countBadge(noteBlocks().length); }, function () {});
  }

  var W = {
    name: META.name, description: META.description, icon: META.icon, tags: META.tags,
    open: open, close: close
  };
  Cade.registerWidget(W);
})();
