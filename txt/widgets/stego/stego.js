/* Steganography — hide a message inside an image (invisible LSB, optional
 * AES-GCM password) or inside ordinary text (zero-width characters), and
 * analyse any image to find data hidden in it (our format, then a CTF-style
 * toolbox: bit planes, configurable LSB extraction with a printable-text
 * score and auto-try, data appended after the end marker, PNG text chunks,
 * JPEG EXIF / comments, a strings pass, and a histogram / pixel inspector).
 *
 * The pure logic (the format, crypto, PNG codec, parsers, scorer, zero-width)
 * lives in stego-core.js; this file is only the panel, image I/O and canvases.
 * Nothing runs until the panel opens; close / hide / minimize releases every
 * listener, object URL and canvas this widget made. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var BASE = Cade.baseURL ? Cade.baseURL() : './txt/widgets/stego/';
  Cade.loadCSS('stego.css');
  var CORE_URL = BASE + 'stego-core.js';
  var PANEL_ID = 'stego-panel';
  var MAX_SIDE = 1600;            // scale huge photos down to this longest side

  var META = {
    name: 'Steganography',
    description: 'Conceal a secret message in an image (invisible LSB, optional AES-GCM password) or in ordinary text — and analyse any image for concealed data',
    icon: '🕵',
    tags: 'steganography,stego,hide message in image,hide in picture,hide in photo,hidden message,hidden data,secret message,conceal,image,photo,picture,lsb,least significant bit,encrypt,password,aes,zero-width,invisible,ctf,reveal,extract,decode,bit plane,exif,strings,watermark'
  };

  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2200); } catch (e) {} }
  function isPhone() { try { return window.matchMedia('(max-width: 560px)').matches; } catch (e) { return false; } }
  function touchy() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }

  function loadCore() {
    if (window.__cadeStegoCore) return Promise.resolve(window.__cadeStegoCore);
    if (!window.__cadeStegoCoreP) {
      window.__cadeStegoCoreP = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = CORE_URL;
        s.onload = function () { if (window.__cadeStegoCore) res(window.__cadeStegoCore); else { window.__cadeStegoCoreP = null; rej(new Error('missing')); } };
        s.onerror = function () { window.__cadeStegoCoreP = null; rej(new Error('Steganography failed to load (offline?)')); };
        document.head.appendChild(s);
      });
    }
    return window.__cadeStegoCoreP;
  }

  // ---- state (all reset on close) ----
  var P = null, el = {}, SC = null, tab = 'hide';
  var ownUrls = [];               // object URLs made here
  var timers = [];
  // hide state
  var cover = null;               // { px, w, h, previewUrl }
  var stegoResult = null;         // { pngBlob, pngUrl, px, w, h, header, name }
  // reveal state
  var analysed = null;            // { bytes, px, w, h, isImg, mime, name }
  var planeCh = 0, planeBit = 0;

  function bodyHtml() {
    return '<div class="sg">' +
      '<div class="sg-tabs" role="tablist">' +
        '<button type="button" class="sg-tab on" role="tab" data-tab="hide">Hide</button>' +
        '<button type="button" class="sg-tab" role="tab" data-tab="reveal">Reveal / analyse</button>' +
        '<button type="button" class="sg-tab" role="tab" data-tab="text">Text</button>' +
      '</div>' +
      hideHtml() + revealHtml() + textHtml() +
      '<input type="file" accept="image/*" class="sg-file" tabindex="-1" aria-hidden="true">' +
    '</div>';
  }

  function hideHtml() {
    return '<section class="sg-pane" data-pane="hide">' +
      '<label class="sg-l" for="sg-msg">Secret message</label>' +
      '<textarea id="sg-msg" class="sg-msg" rows="3" placeholder="Type or paste the text to hide…"></textarea>' +
      '<div class="sg-row sg-msgsrc">' +
        '<button type="button" class="sg-btn sg-sm" data-act="use-note">Use the note</button>' +
        '<button type="button" class="sg-btn sg-sm" data-act="use-sel">Use the selection</button>' +
      '</div>' +
      '<label class="sg-l">Cover image</label>' +
      '<div class="sg-stage" tabindex="0" role="button" aria-label="Cover image — tap to choose, paste or drop">' +
        '<canvas class="sg-cv" hidden></canvas>' +
        '<div class="sg-empty"><div class="sg-empty-i" aria-hidden="true">🖼</div><b>Choose a cover image</b><span>pick · paste · drop · from the note · or generate one below</span></div>' +
        '<div class="sg-dropping">Drop the image here</div>' +
      '</div>' +
      '<div class="sg-row">' +
        '<button type="button" class="sg-btn" data-act="pick">🖼 Image…</button>' +
        '<button type="button" class="sg-btn" data-act="paste">📋 Paste</button>' +
        '<button type="button" class="sg-btn" data-act="gen">✨ Generate</button>' +
      '</div>' +
      '<div class="sg-note" hidden><span class="sg-l">In note</span><div class="sg-strip"></div></div>' +
      '<label class="sg-pw-wrap"><span class="sg-l">Password <span class="sg-faint">(optional — encrypts with AES-GCM)</span></span>' +
        '<input type="password" class="sg-pw" placeholder="Leave empty for no encryption" autocomplete="new-password"></label>' +
      '<div class="sg-cap" aria-live="polite"></div>' +
      '<div class="sg-row sg-actions">' +
        '<button type="button" class="sg-btn sg-go" data-act="embed">Hide it ↓</button>' +
      '</div>' +
      '<div class="sg-result" hidden>' +
        '<div class="sg-preview"><div class="sg-prev-col"><span class="sg-cap-l">Result (PNG)</span><canvas class="sg-rcv"></canvas></div>' +
          '<div class="sg-prev-col"><span class="sg-cap-l">Amplified difference</span><canvas class="sg-dcv"></canvas></div></div>' +
        '<p class="sg-warn">⚠ Save and send as a <b>file</b>. Sending it as a “photo” in a messenger recompresses it and destroys the hidden message.</p>' +
        '<div class="sg-row sg-saverow">' +
          '<button type="button" class="sg-btn sg-go" data-act="save">💾 ' + (touchy() ? 'Save' : 'Download') + '</button>' +
          '<button type="button" class="sg-btn" data-act="attach">📎 Into note</button>' +
          '<button type="button" class="sg-btn" data-act="copy-img">⎘ Copy</button>' +
        '</div>' +
      '</div>' +
    '</section>';
  }

  function revealHtml() {
    return '<section class="sg-pane" data-pane="reveal" hidden>' +
      '<div class="sg-stage sg-rstage" tabindex="0" role="button" aria-label="Image to analyse — tap to choose, paste or drop">' +
        '<canvas class="sg-rimg" hidden></canvas>' +
        '<div class="sg-empty"><div class="sg-empty-i" aria-hidden="true">🔎</div><b>Drop an image to analyse</b><span>pick · paste · drop · from the note</span></div>' +
        '<div class="sg-dropping">Drop the image here</div>' +
      '</div>' +
      '<div class="sg-row">' +
        '<button type="button" class="sg-btn" data-act="r-pick">🖼 Image…</button>' +
        '<button type="button" class="sg-btn" data-act="r-paste">📋 Paste</button>' +
      '</div>' +
      '<div class="sg-rnote" hidden><span class="sg-l">In note</span><div class="sg-rstrip"></div></div>' +
      '<div class="sg-out" aria-live="polite"><div class="sg-none">Drop an image above to look for hidden data.</div></div>' +
    '</section>';
  }

  function textHtml() {
    return '<section class="sg-pane" data-pane="text" hidden>' +
      '<p class="sg-hint">Hide a short message inside ordinary text using invisible zero-width characters. Paste the carrier text, type a secret, and copy the result — it looks unchanged but carries the message. Paste text below to reveal one.</p>' +
      '<label class="sg-l" for="sg-tcar">Carrier text (visible)</label>' +
      '<textarea id="sg-tcar" class="sg-ta" rows="2" placeholder="This looks like an ordinary note."></textarea>' +
      '<label class="sg-l" for="sg-tsec">Secret to hide</label>' +
      '<textarea id="sg-tsec" class="sg-ta" rows="2" placeholder="Your hidden message…"></textarea>' +
      '<div class="sg-row">' +
        '<button type="button" class="sg-btn sg-go" data-act="zw-make">Hide in text ⎘</button>' +
        '<button type="button" class="sg-btn" data-act="zw-insert">Into note</button>' +
      '</div>' +
      '<div class="sg-tsep"></div>' +
      '<label class="sg-l" for="sg-trev">Reveal — paste text with hidden data</label>' +
      '<textarea id="sg-trev" class="sg-ta" rows="2" placeholder="Paste text here to extract a hidden message…"></textarea>' +
      '<button type="button" class="sg-btn" data-act="zw-reveal">Reveal from text</button>' +
      '<div class="sg-trout" aria-live="polite"></div>' +
    '</section>';
  }

  function q(s) { return P.querySelector(s); }
  function ownUrl(u) { ownUrls.push(u); return u; }

  // ---- image decode & scale ----
  function isImage(f) { return !!f && (/^image\//.test(f.type || '') || /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(f.name || '')); }
  function decode(blob) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob, { imageOrientation: 'from-image' }).then(function (b) { return { src: b, w: b.width, h: b.height, done: function () { try { b.close(); } catch (e) {} } }; },
        function () { return viaImg(blob); });
    }
    return viaImg(blob);
  }
  function viaImg(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { res({ src: img, w: img.naturalWidth, h: img.naturalHeight, done: function () { URL.revokeObjectURL(url); } }); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src = url;
    });
  }
  // Decode to an RGBA ImageData, scaling the longest side down to MAX_SIDE.
  function toPixels(blob) {
    return decode(blob).then(function (im) {
      var scale = Math.min(1, MAX_SIDE / Math.max(im.w, im.h));
      var w = Math.max(1, Math.round(im.w * scale)), h = Math.max(1, Math.round(im.h * scale));
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      var cx = c.getContext('2d', { willReadFrequently: true });
      cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
      cx.drawImage(im.src, 0, 0, w, h);
      im.done();
      var data = cx.getImageData(0, 0, w, h).data;
      c.width = c.height = 0;
      return { px: data, w: w, h: h, scaled: scale < 1, ow: im.w, oh: im.h };
    });
  }
  function pxToCanvas(cv, px, w, h) {
    cv.width = w; cv.height = h;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
  }
  function fitCanvas(cv, maxH) {
    if (!cv.width) return;
    var stageW = Math.max(120, (cv.parentNode ? cv.parentNode.clientWidth : 300) - 8);
    var s = Math.min(stageW / cv.width, (maxH || (isPhone() ? 150 : 240)) / cv.height, 1);
    cv.style.width = Math.round(cv.width * s) + 'px';
    cv.style.height = Math.round(cv.height * s) + 'px';
  }

  // ---- hide: take a cover image in ----
  function takeCover(blob) {
    if (!isImage(blob)) { toast('That isn’t an image', 'error'); return; }
    el.cap.textContent = 'reading image…';
    toPixels(blob).then(function (r) {
      if (!P) return;
      cover = { px: r.px, w: r.w, h: r.h };
      pxToCanvas(el.cv, r.px, r.w, r.h);
      el.cv.hidden = false;
      el.stage.classList.add('sg-has');
      fitCanvas(el.cv);
      stegoResult = null; el.result.hidden = true;
      updateCapacity(r.scaled ? r : null);
    }).catch(function () { toast('Couldn’t read that image', 'error'); el.cap.textContent = ''; });
  }
  function genCover() {
    if (!SC) { toast('Still loading…', 'info'); return; }
    var kinds = ['linear', 'diagonal', 'radial'], k = kinds[(Math.random() * 3) | 0];
    var w = 900, h = 650, seed = (Math.random() * 1e9) | 0;
    var px = SC.makeCover(w, h, k, seed);
    cover = { px: px, w: w, h: h };
    pxToCanvas(el.cv, px, w, h);
    el.cv.hidden = false; el.stage.classList.add('sg-has');
    fitCanvas(el.cv);
    stegoResult = null; el.result.hidden = true;
    updateCapacity(null);
    toast('Generated a ' + k + ' cover', 'success', 1500);
  }
  function currentMessage() { return el.msg.value || ''; }
  function updateCapacity(scaledInfo) {
    if (!SC || !cover) { el.cap.textContent = ''; return; }
    var cap = SC.capacity(cover.w, cover.h);
    var msg = currentMessage(), need = SC.utf8(msg).length;
    var pw = el.pw.value ? ' (+encryption overhead)' : '';
    var parts = ['Capacity: ' + SC.fmtBytes(cap) + ' · message: ~' + SC.fmtBytes(need) + pw];
    if (scaledInfo && scaledInfo.scaled) parts.push('scaled ' + scaledInfo.ow + '×' + scaledInfo.oh + ' → ' + cover.w + '×' + cover.h + ' for speed');
    el.cap.innerHTML = esc(parts.join(' · '));
    var over = need + (el.pw.value ? 44 : 0) > cap;
    el.cap.classList.toggle('sg-over', over);
    if (over) {
      var sz = SC.minSizeFor(need + (el.pw.value ? 44 : 0), cover.w / cover.h);
      el.cap.innerHTML += '<br><span class="sg-over-hint">Too small — needs about ' + sz.w + '×' + sz.h + '. Use a bigger image or shorten the message.</span>';
    }
    el.embedBtn.disabled = !msg || over;
  }

  // ---- hide: embed ----
  function doEmbed() {
    if (!SC || !cover) { toast('Choose a cover image first', 'info'); return; }
    var msg = currentMessage();
    if (!msg) { toast('Type a message to hide', 'info'); return; }
    var pw = el.pw.value;
    el.embedBtn.disabled = true; el.cap.textContent = 'hiding…';
    var px = new Uint8ClampedArray(cover.px);   // copy so the diff can compare to the original
    SC.hide(px, cover.w, cover.h, msg, pw || null, {}).then(function (info) {
      return SC.encodePNG(px, cover.w, cover.h).then(function (png) {
        if (!P) return;
        var blob = new Blob([png], { type: 'image/png' });
        var name = 'hidden-' + Date.now() + '.png';
        stegoResult = { pngBlob: blob, png: png, px: px, w: cover.w, h: cover.h, name: name };
        showResult();
        el.cap.textContent = 'Hidden ' + SC.fmtBytes(info.payloadLen) + (pw ? ' (encrypted)' : '') + ' · PNG ' + SC.fmtBytes(png.length);
        toast('Message hidden', 'success', 1500);
      });
    }).catch(function (e) {
      el.embedBtn.disabled = false;
      el.cap.textContent = '';
      toast((e && e.message) || 'Could not hide the message', 'error', 3000);
    });
  }
  function showResult() {
    el.result.hidden = false;
    pxToCanvas(el.rcv, stegoResult.px, stegoResult.w, stegoResult.h);
    var diff = SC.diffAmplified(cover.px, stegoResult.px, 40);
    pxToCanvas(el.dcv, diff, stegoResult.w, stegoResult.h);
    fitCanvas(el.rcv, isPhone() ? 120 : 180); fitCanvas(el.dcv, isPhone() ? 120 : 180);
  }
  function saveResult() {
    if (!stegoResult) return;
    if (Cade.files && Cade.files.save) Cade.files.save(stegoResult.pngBlob, stegoResult.name);
    else { var u = ownUrl(URL.createObjectURL(stegoResult.pngBlob)), a = document.createElement('a'); a.href = u; a.download = stegoResult.name; document.body.appendChild(a); a.click(); a.remove(); }
    toast(touchy() ? 'Use “Save to Files” (not Photos — that recompresses)' : 'Saved', 'success', 2600);
  }
  function attachResult() {
    if (!stegoResult || !Cade.files || !Cade.files.attach) { toast('Attaching files isn’t available here', 'error'); return; }
    var file = new File([stegoResult.pngBlob], stegoResult.name, { type: 'image/png' });
    Cade.files.attach(file).then(function () { toast('Attached to the note', 'success', 1600); }, function (e) { toast((e && e.message) || 'Could not attach', 'error'); });
  }
  function copyResult() {
    if (!stegoResult) return;
    if (!navigator.clipboard || !window.ClipboardItem) { toast('Copying images isn’t supported here — use Save', 'info', 2600); return; }
    try {
      navigator.clipboard.write([new window.ClipboardItem({ 'image/png': stegoResult.pngBlob })]).then(
        function () { toast('Copied — paste lossless to keep the message', 'success', 2400); },
        function () { toast('Copy failed — use Save', 'error'); });
    } catch (e) { toast('Copy failed — use Save', 'error'); }
  }

  // ---- reveal: take an image in (keep the raw bytes AND decoded pixels) ----
  function takeAnalyse(blob, name) {
    if (!isImage(blob)) { toast('That isn’t an image', 'error'); return; }
    el.out.innerHTML = '<div class="sg-none">reading…</div>';
    var fr = new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(new Uint8Array(r.result)); };
      r.onerror = function () { rej(new Error('read')); };
      r.readAsArrayBuffer(blob);
    });
    Promise.all([fr, toPixels(blob)]).then(function (a) {
      if (!P) return;
      analysed = { bytes: a[0], px: a[1].px, w: a[1].w, h: a[1].h, mime: blob.type || '', name: name || 'image' };
      pxToCanvas(el.rimg, a[1].px, a[1].w, a[1].h);
      el.rimg.hidden = false; el.rstage.classList.add('sg-has');
      fitCanvas(el.rimg, isPhone() ? 140 : 220);
      planeCh = 0; planeBit = 0;
      runReveal();
    }).catch(function () { toast('Couldn’t read that image', 'error'); el.out.innerHTML = '<div class="sg-none">Couldn’t read that image.</div>'; });
  }

  // Try our format first, then build the generic report.
  function runReveal(password) {
    if (!analysed || !SC) return;
    var A = analysed, html = [];
    SC.reveal(A.px, A.w, A.h, password || null).then(function (r) {
      html.push(ourFormatBlock(r, password));
      renderReport(html);
    }, function (e) {
      if (e.code === 'need-password') html.push(passwordBlock('This image holds a message in our format. Enter its password:', ''));
      else if (e.code === 'wrong-password') html.push(passwordBlock('Wrong password. Try again:', 'err'));
      else if (e.code === 'damaged') html.push('<div class="sg-card sg-bad">Our format’s header was found but the checksum failed — the image was probably recompressed, destroying the message.</div>');
      // 'none' → say nothing here; the generic analysis follows
      appendGeneric(A, html);
    });
  }
  function ourFormatBlock(r, password) {
    var h = r.header;
    return '<div class="sg-card sg-good"><div class="sg-card-h">✅ Hidden message found (our format)</div>' +
      '<div class="sg-meta-l">' + (h.encrypted ? 'AES-GCM encrypted · ' : '') + (h.compressed ? 'compressed · ' : '') + SC.fmtBytes(h.length) + '</div>' +
      '<pre class="sg-text">' + esc(r.text) + '</pre>' +
      '<div class="sg-row"><button type="button" class="sg-btn sg-sm" data-act="copy-text" data-text="' + esc(encodeURIComponent(r.text)) + '">⎘ Copy</button>' +
      '<button type="button" class="sg-btn sg-sm" data-act="insert-text" data-text="' + esc(encodeURIComponent(r.text)) + '">↧ Insert into note</button></div></div>';
  }
  function passwordBlock(msg, cls) {
    return '<div class="sg-card ' + (cls === 'err' ? 'sg-bad' : 'sg-good') + '"><div class="sg-card-h">🔒 Password needed</div>' +
      '<p>' + esc(msg) + '</p><div class="sg-row"><input type="password" class="sg-rpw" placeholder="Password" autocomplete="off">' +
      '<button type="button" class="sg-btn sg-sm" data-act="try-pw">Unlock</button></div></div>';
  }

  // The CTF-style generic report. Everything derives from A.bytes / A.px.
  function appendGeneric(A, head) {
    var html = head.slice();
    // 1. appended data after the end marker
    var app = SC.appendedData(A.bytes);
    if (app) {
      var text = SC.previewText(app.bytes, 400);
      html.push('<div class="sg-card"><div class="sg-card-h">📎 Data after the ' + app.kind + ' end marker (' + SC.fmtBytes(app.length) + ')</div>' +
        '<pre class="sg-text sg-mono">' + esc(text) + '</pre>' +
        '<div class="sg-row"><button type="button" class="sg-btn sg-sm" data-act="dl-appended">⬇ Download these bytes</button></div></div>');
    }
    // 2. metadata: PNG chunks / JPEG EXIF+comments
    var meta = [];
    if (SC.isPNG(A.bytes)) { var pc = SC.parsePNGChunks(A.bytes); meta = pc.text; }
    else if (SC.isJPEG(A.bytes)) { var jp = SC.parseJPEG(A.bytes); meta = jp.text; }
    if (meta.length) {
      html.push('<div class="sg-card"><div class="sg-card-h">🏷 Embedded text / metadata</div>' +
        meta.map(function (t) { return '<div class="sg-kv"><b>' + esc(t.kind + (t.keyword ? ':' + t.keyword : '')) + '</b><span>' + esc(t.value) + '</span></div>'; }).join('') + '</div>');
    }
    // 3. LSB auto-try (ranked)
    var combos = SC.lsbAutoTry(A.px, A.w, A.h, 512);
    var best = combos.slice(0, 5);
    html.push('<div class="sg-card"><div class="sg-card-h">🔬 LSB extraction — likely combinations</div>' +
      '<p class="sg-faint">Ranked by how much looks like text. Tap one to see more.</p>' +
      best.map(function (c, i) {
        return '<button type="button" class="sg-combo" data-combo="' + esc(JSON.stringify({ channels: c.channels, order: c.order, bit: c.bit })) + '">' +
          '<span class="sg-combo-l">' + esc(c.label) + '</span><span class="sg-combo-s" style="--s:' + (c.score * 100).toFixed(0) + '%">' + (c.score * 100).toFixed(0) + '%</span>' +
          '<span class="sg-combo-x">' + esc(c.sample.slice(0, 48)) + '</span></button>';
      }).join('') +
      '<div class="sg-lsb-out"></div></div>');
    // 4. bit-plane viewer
    html.push('<div class="sg-card"><div class="sg-card-h">🎚 Bit-plane viewer</div>' +
      '<div class="sg-row sg-plane-ctl">' +
        '<span class="sg-seg">' + ['R', 'G', 'B', 'A'].map(function (n, i) { return '<button type="button" class="sg-sb" data-plch="' + i + '">' + n + '</button>'; }).join('') + '</span>' +
        '<span class="sg-seg">' + [0,1,2,3,4,5,6,7].map(function (b) { return '<button type="button" class="sg-sb" data-plbit="' + b + '">' + b + '</button>'; }).join('') + '</span>' +
      '</div><canvas class="sg-plane"></canvas></div>');
    // 5. strings
    var runs = SC.strings(A.bytes, 5, 120);
    html.push('<div class="sg-card"><div class="sg-card-h">🔤 Strings (printable runs ≥ 5)</div>' +
      (runs.length ? '<pre class="sg-text sg-mono">' + esc(runs.map(function (r) { return r.text; }).join('\n')) + '</pre>' : '<p class="sg-faint">No notable strings.</p>') + '</div>');
    // 6. histogram + pixel inspector
    html.push('<div class="sg-card"><div class="sg-card-h">📊 Channel histogram &amp; pixel inspector</div>' +
      '<div class="sg-row sg-seg sg-hist-ctl">' + ['R', 'G', 'B', 'A'].map(function (n, i) { return '<button type="button" class="sg-sb' + (i === 0 ? ' on' : '') + '" data-hist="' + i + '">' + n + '</button>'; }).join('') + '</div>' +
      '<canvas class="sg-histcv" height="90"></canvas>' +
      '<div class="sg-pixout sg-faint">Tap the analysed image above to inspect a pixel.</div></div>');
    renderReport(html);
  }
  function renderReport(html) {
    el.out.innerHTML = html.join('');
    drawPlane();
    drawHist(0);
  }
  function drawPlane() {
    var cv = el.out.querySelector('.sg-plane'); if (!cv || !analysed) return;
    paintPlaneBtns();
    var p = SC.bitPlane(analysed.px, analysed.w, analysed.h, planeCh, planeBit);
    pxToCanvas(cv, p, analysed.w, analysed.h);
    fitCanvas(cv, isPhone() ? 150 : 220);
  }
  function paintPlaneBtns() {
    var chb = el.out.querySelectorAll('[data-plch]'), bb = el.out.querySelectorAll('[data-plbit]');
    for (var i = 0; i < chb.length; i++) chb[i].classList.toggle('on', +chb[i].getAttribute('data-plch') === planeCh);
    for (i = 0; i < bb.length; i++) bb[i].classList.toggle('on', +bb[i].getAttribute('data-plbit') === planeBit);
  }
  function drawHist(ch) {
    var cv = el.out.querySelector('.sg-histcv'); if (!cv || !analysed) return;
    var hist = SC.histogram(analysed.px, analysed.w, analysed.h, ch);
    var w = cv.clientWidth || 300; cv.width = w; cv.height = 90;
    var cx = cv.getContext('2d'), max = 1;
    for (var i = 0; i < 256; i++) if (hist[i] > max) max = hist[i];
    var col = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2a9d8f';
    cx.clearRect(0, 0, w, 90); cx.fillStyle = col;
    for (i = 0; i < 256; i++) { var bh = hist[i] / max * 86, x = i / 256 * w; cx.fillRect(x, 90 - bh, Math.max(1, w / 256), bh); }
    var hb = el.out.querySelectorAll('[data-hist]');
    for (i = 0; i < hb.length; i++) hb[i].classList.toggle('on', +hb[i].getAttribute('data-hist') === ch);
  }
  function showCombo(spec, btn) {
    var out = el.out.querySelector('.sg-lsb-out'); if (!out) return;
    var bytes = SC.lsbExtract(analysed.px, analysed.w, analysed.h, { channels: spec.channels, order: spec.order, bit: spec.bit, maxBytes: 4096 });
    out.innerHTML = '<pre class="sg-text sg-mono">' + esc(SC.previewText(bytes, 2000)) + '</pre>' +
      '<div class="sg-row"><button type="button" class="sg-btn sg-sm" data-act="copy-lsb">⎘ Copy text</button>' +
      '<button type="button" class="sg-btn sg-sm" data-act="dl-lsb">⬇ Download bytes</button></div>';
    out.__bytes = bytes;
  }
  function inspectPixel(ev) {
    if (!analysed) return;
    var cv = el.rimg, rect = cv.getBoundingClientRect();
    var x = Math.floor((ev.clientX - rect.left) / rect.width * analysed.w);
    var y = Math.floor((ev.clientY - rect.top) / rect.height * analysed.h);
    if (x < 0 || y < 0 || x >= analysed.w || y >= analysed.h) return;
    var p = SC.pixelAt(analysed.px, analysed.w, x, y);
    var out = el.out.querySelector('.sg-pixout');
    if (out) out.innerHTML = '(' + x + ',' + y + ') · RGBA ' + p.r + ',' + p.g + ',' + p.b + ',' + p.a + ' · #' + SC.hex(new Uint8Array([p.r, p.g, p.b]));
  }

  // ---- pictures already in the note (shared with Photo Palette's token form) ----
  var IMG_RE = /!\[img:(?:([jwa])([:#]))?([A-Za-z0-9+/=]+)(?:\|w(\d{2,4}))?\]/g;
  var MIME = { j: 'image/jpeg', w: 'image/webp', a: 'image/avif' };
  function noteImages() {
    var ed = Cade.editor, out = [], seen = {};
    if (!ed) return out;
    var t = ed.state.doc.toString();
    if (t.indexOf('![img:') < 0) return out;
    IMG_RE.lastIndex = 0; var m;
    while ((m = IMG_RE.exec(t)) !== null && out.length < 12) {
      var ref = m[2] === '#', key = ref ? m[3] : m[3].slice(0, 32) + m[3].length;
      if (seen[key]) continue; seen[key] = 1;
      out.push({ code: m[1] || 'j', ref: ref, data: m[3] });
    }
    return out;
  }
  function inlineUrl(code, b64) {
    try { var bin = atob(b64), bytes = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return ownUrl(URL.createObjectURL(new Blob([bytes], { type: MIME[code] || 'image/jpeg' }))); }
    catch (e) { return null; }
  }
  function refreshNote(stripEl, noteEl, onPick) {
    if (!P) return;
    var list = noteImages();
    stripEl.innerHTML = ''; noteEl.hidden = true;
    list.forEach(function (it) {
      var got = it.ref
        ? (typeof window.resolveImageRef === 'function' ? Promise.resolve(window.resolveImageRef(it.code, it.data)).then(function (r) { return r && r.url; }, function () { return null; }) : Promise.resolve(null))
        : Promise.resolve(inlineUrl(it.code, it.data));
      got.then(function (url) {
        if (!url || !P) return;
        var b = document.createElement('button'); b.type = 'button'; b.className = 'sg-ni'; b.title = 'Use this image';
        var img = document.createElement('img'); img.alt = 'Image in the note'; img.decoding = 'async'; img.src = url;
        b.appendChild(img); b.onclick = function () { useNoteUrl(url, onPick); };
        stripEl.appendChild(b); noteEl.hidden = false;
      });
    });
  }
  function useNoteUrl(url, onPick) {
    if (!/^(blob|data):/.test(url)) return;
    fetch(url).then(function (r) { return r.blob(); }).then(function (b) { onPick(b.type ? b : new File([b], 'note-image', { type: 'image/jpeg' }), 'note-image'); }).catch(function () { toast('Couldn’t read that image', 'error'); });
  }

  // ---- paste / clipboard ----
  function pasteInto(onPick) {
    var cb = navigator.clipboard;
    if (!cb || !cb.read) { toast('Copy an image, then paste with ' + (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘V' : 'Ctrl+V'), 'info', 2600); return; }
    cb.read().then(function (items) {
      for (var i = 0; i < items.length; i++) { var types = items[i].types || []; for (var j = 0; j < types.length; j++) if (/^image\//.test(types[j])) { var t = types[j]; return items[i].getType(t).then(function (blob) { onPick(new File([blob], 'pasted', { type: blob.type || t }), 'pasted'); }); } }
      toast('No image on the clipboard', 'info');
    }).catch(function () { toast('Couldn’t read the clipboard', 'info'); });
  }

  // ---- text / zero-width ----
  function zwMake(insert) {
    if (!SC) return;
    var carrier = el.tcar.value, secret = el.tsec.value;
    if (!secret) { toast('Type a secret to hide', 'info'); return; }
    var combined = SC.zwEncode(carrier, secret);
    if (insert) {
      var ed = Cade.editor;
      if (!ed || ed.state.readOnly) { toast('Read-only mode', 'error'); return; }
      var sel = ed.state.selection.main;
      ed.dispatch({ changes: { from: sel.from, to: sel.to, insert: combined }, selection: { anchor: sel.from + combined.length }, userEvent: 'input.paste', scrollIntoView: true });
      toast('Inserted into the note', 'success', 1600);
      if (isPhone() && Cade.minimizePanel) Cade.minimizePanel(P);
    } else copyText(combined).then(function () { toast('Copied — looks unchanged but carries the message', 'success', 2400); }, function () { toast('Copy failed', 'error'); });
  }
  function zwReveal() {
    var text = el.trev.value;
    var found = SC.zwDecode(text);
    el.trout.innerHTML = found != null
      ? '<div class="sg-card sg-good"><div class="sg-card-h">✅ Hidden message</div><pre class="sg-text">' + esc(found) + '</pre>' +
        '<button type="button" class="sg-btn sg-sm" data-act="copy-text" data-text="' + esc(encodeURIComponent(found)) + '">⎘ Copy</button></div>'
      : '<div class="sg-card">No zero-width hidden message in that text.</div>';
  }

  function copyText(s) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s);
    return new Promise(function (res, rej) { var ta = document.createElement('textarea'); ta.value = s; ta.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} ta.remove(); ok ? res() : rej(); });
  }
  function insertIntoNote(text) {
    var ed = Cade.editor;
    if (!ed || ed.state.readOnly) { toast('Read-only mode', 'error'); return; }
    var sel = ed.state.selection.main;
    ed.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length }, userEvent: 'input.paste', scrollIntoView: true });
    toast('Inserted into the note', 'success', 1600);
  }

  // ---- tabs ----
  function setTab(name) {
    tab = name;
    var tabs = P.querySelectorAll('.sg-tab'), panes = P.querySelectorAll('.sg-pane');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === name);
    for (i = 0; i < panes.length; i++) panes[i].hidden = panes[i].getAttribute('data-pane') !== name;
  }

  // ---- events ----
  var pickTarget = 'hide';   // which pane the hidden <input type=file> serves
  function onClick(e) {
    var b = e.target.closest ? e.target.closest('button,.sg-stage') : null;
    if (!b || !P.contains(b)) return;
    if (b.classList.contains('sg-tab')) { setTab(b.getAttribute('data-tab')); return; }
    if (b.classList.contains('sg-stage')) {
      if (b.classList.contains('sg-rstage')) { if (!analysed) { pickTarget = 'reveal'; el.file.click(); } else return; }
      else if (!cover) { pickTarget = 'hide'; el.file.click(); }
      return;
    }
    var a = b.getAttribute('data-act');
    if (b.hasAttribute('data-combo')) { try { showCombo(JSON.parse(b.getAttribute('data-combo')), b); } catch (x) {} return; }
    if (b.hasAttribute('data-plch')) { planeCh = +b.getAttribute('data-plch'); drawPlane(); return; }
    if (b.hasAttribute('data-plbit')) { planeBit = +b.getAttribute('data-plbit'); drawPlane(); return; }
    if (b.hasAttribute('data-hist')) { drawHist(+b.getAttribute('data-hist')); return; }
    if (a === 'copy-text') { copyText(decodeURIComponent(b.getAttribute('data-text'))).then(function () { toast('Copied', 'success', 1400); }, function () { toast('Copy failed', 'error'); }); return; }
    if (a === 'insert-text') { insertIntoNote(decodeURIComponent(b.getAttribute('data-text'))); return; }
    if (a === 'try-pw') { var pwi = b.parentNode.querySelector('.sg-rpw'); runReveal(pwi ? pwi.value : ''); return; }
    if (a === 'copy-lsb') { var o = el.out.querySelector('.sg-lsb-out'); if (o && o.__bytes) copyText(SC.previewText(o.__bytes, 1 << 20)).then(function () { toast('Copied', 'success', 1400); }); return; }
    if (a === 'dl-lsb') { var o2 = el.out.querySelector('.sg-lsb-out'); if (o2 && o2.__bytes) dlBytes(o2.__bytes, 'lsb-extract.bin'); return; }
    if (a === 'dl-appended') { var app = SC.appendedData(analysed.bytes); if (app) dlBytes(app.bytes, 'appended-data.bin'); return; }
    switch (a) {
      case 'pick': pickTarget = 'hide'; el.file.click(); break;
      case 'paste': pasteInto(takeCover); break;
      case 'gen': genCover(); break;
      case 'use-note': el.msg.value = (Cade.editor ? Cade.editor.state.doc.toString() : ''); updateCapacity(); break;
      case 'use-sel': { var ed = Cade.editor; if (ed) { var s = ed.state.selection.main; el.msg.value = s.empty ? '' : ed.state.sliceDoc(s.from, s.to); if (s.empty) toast('No selection', 'info'); } updateCapacity(); break; }
      case 'embed': doEmbed(); break;
      case 'save': saveResult(); break;
      case 'attach': attachResult(); break;
      case 'copy-img': copyResult(); break;
      case 'r-pick': pickTarget = 'reveal'; el.file.click(); break;
      case 'r-paste': pasteInto(takeAnalyse); break;
      case 'zw-make': zwMake(false); break;
      case 'zw-insert': zwMake(true); break;
      case 'zw-reveal': zwReveal(); break;
    }
  }
  function dlBytes(bytes, name) {
    var blob = new Blob([bytes], { type: 'application/octet-stream' });
    if (Cade.files && Cade.files.save) Cade.files.save(blob, name);
    else { var u = ownUrl(URL.createObjectURL(blob)), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  }
  function onInput(e) { if (e.target === el.msg || e.target === el.pw) updateCapacity(); }
  function onFile() { var f = el.file.files && el.file.files[0]; if (f) (pickTarget === 'reveal' ? takeAnalyse : takeCover)(f, f.name); el.file.value = ''; }
  function onPaste(e) {
    var items = e.clipboardData && e.clipboardData.items; if (!items) return;
    for (var i = 0; i < items.length; i++) if (items[i].kind === 'file' && /^image\//.test(items[i].type)) { var f = items[i].getAsFile(); if (f) { e.preventDefault(); (tab === 'reveal' ? takeAnalyse : takeCover)(f, 'pasted'); return; } }
  }
  function hasFiles(e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0; }
  var dragN = 0;
  function onDragEnter(e) { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); dragN++; P.classList.add('sg-drag'); }
  function onDragOver(e) { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); try { e.dataTransfer.dropEffect = 'copy'; } catch (x) {} }
  function onDragLeave(e) { if (!hasFiles(e)) return; e.stopPropagation(); dragN = Math.max(0, dragN - 1); if (!dragN) P.classList.remove('sg-drag'); }
  function onDrop(e) {
    if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); dragN = 0; P.classList.remove('sg-drag');
    try { window.dispatchEvent(new Event('dragleave')); } catch (x) {}
    var fs = e.dataTransfer.files;
    for (var i = 0; i < fs.length; i++) if (isImage(fs[i])) { (tab === 'reveal' ? takeAnalyse : takeCover)(fs[i], fs[i].name); return; }
    toast('That isn’t an image', 'error');
  }
  function onKey(e) {
    if (e.key === 'Escape' && !(e.target && /TEXTAREA|INPUT/.test(e.target.tagName) && e.target.value)) { e.preventDefault(); close(); return; }
    if (e.target && /TEXTAREA|INPUT/.test(e.target.tagName)) e.stopPropagation();   // keep editor shortcuts out
  }
  var resizeT = 0;
  function onResize() { clearTimeout(resizeT); resizeT = setTimeout(function () { [el.cv, el.rcv, el.dcv, el.rimg].forEach(function (c) { if (c && !c.hidden) fitCanvas(c); }); if (analysed) { drawPlane(); drawHist(0); } }, 150); }
  function onImgClick(e) { if (tab === 'reveal' && analysed) inspectPixel(e); }

  function cleanup() {
    clearTimeout(resizeT); timers.forEach(clearTimeout); timers = [];
    try { Cade.offEditorUpdate(onNoteUpdate); } catch (e) {}
    window.removeEventListener('resize', onResize);
    ownUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} }); ownUrls = [];
    [el.cv, el.rcv, el.dcv, el.rimg].forEach(function (c) { if (c) c.width = c.height = 0; });
    P = null; el = {}; cover = null; stegoResult = null; analysed = null; dragN = 0; tab = 'hide';
  }
  function close() { var p = P; cleanup(); if (p) p.remove(); try { if (!isPhone()) Cade.editor.focus(); } catch (e) {} }
  function onNoteUpdate(u) { if (P && u.docChanged) { clearTimeout(resizeT); timers.push(setTimeout(function () { if (!P) return; refreshNote(el.strip, el.note, takeCover); refreshNote(el.rstrip, el.rnote, takeAnalyse); }, 800)); } }

  function open() {
    try { Cade.closeAllMenus(); } catch (e) {}
    if (document.getElementById(PANEL_ID)) { close(); return; }
    P = Cade.mkPanel(PANEL_ID, '🕵 Steganography', bodyHtml());
    P._onClose = cleanup;
    el = {
      file: q('.sg-file'), msg: q('.sg-msg'), pw: q('.sg-pw'), cap: q('.sg-cap'), embedBtn: q('[data-act="embed"]'),
      stage: q('[data-pane="hide"] .sg-stage'), cv: q('.sg-cv'), empty: q('.sg-empty'),
      note: q('.sg-note'), strip: q('.sg-strip'),
      result: q('.sg-result'), rcv: q('.sg-rcv'), dcv: q('.sg-dcv'),
      rstage: q('.sg-rstage'), rimg: q('.sg-rimg'), rnote: q('.sg-rnote'), rstrip: q('.sg-rstrip'), out: q('.sg-out'),
      tcar: q('#sg-tcar'), tsec: q('#sg-tsec'), trev: q('#sg-trev'), trout: q('.sg-trout')
    };
    P.addEventListener('click', onClick);
    P.addEventListener('input', onInput);
    P.addEventListener('keydown', onKey);
    P.addEventListener('paste', onPaste);
    P.addEventListener('dragenter', onDragEnter);
    P.addEventListener('dragover', onDragOver);
    P.addEventListener('dragleave', onDragLeave);
    P.addEventListener('drop', onDrop);
    el.file.addEventListener('change', onFile);
    el.rimg.addEventListener('click', onImgClick);
    window.addEventListener('resize', onResize);
    Cade.onEditorUpdate(onNoteUpdate);
    setTab('hide');
    loadCore().then(function (c) {
      SC = c;
      el.pw.setAttribute('autocomplete', 'new-password');
      if (!(navigator.clipboard && navigator.clipboard.read)) { var pb = q('[data-act="paste"]'), rpb = q('[data-act="r-paste"]'); }
      refreshNote(el.strip, el.note, takeCover);
      refreshNote(el.rstrip, el.rnote, takeAnalyse);
      updateCapacity();
    }, function (e) { toast(e.message, 'error', 3000); });
  }

  Cade.registerWidget({ name: META.name, description: META.description, icon: META.icon, tags: META.tags, open: open, close: close });
})();
