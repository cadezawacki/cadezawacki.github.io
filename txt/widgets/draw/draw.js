/* Whiteboard — free-draw sketch widget for Cade.txt.
 *
 * Draw with pen / highlighter / eraser over a TRANSPARENT background by
 * default (a checkerboard shows on screen; the exported PNG keeps real alpha),
 * or pick a solid white/black background from the toolbar — the choice is
 * remembered per device (Cade.store "cade-draw-bg"). Insert routes through the
 * core's embedded-image pipeline: window.insertImageFile(file) compresses,
 * content-addresses with a hash, uploads for sync, and drops a
 * "![img:<code>#<hash>]" token at the cursor (see txt.html: insertImageFile /
 * compressImage / _imgHash). AVIF/WebP re-encoding preserves the alpha
 * channel; on JPEG-only browsers a transparent export quietly falls back to
 * white (JPEG has no alpha — see alphaExportOK).
 *
 * Images can be imported as a LOCKED BACKGROUND LAYER to draw over — via the
 * toolbar's Import button (file picker) or window.__drawImportImage(mime, b64)
 * (wired to the doc's right-click image menu). The layer is scaled to fit the
 * canvas and centered; strokes render on their own layer above it, and the
 * eraser is a true eraser (destination-out) that cuts stroke pixels only —
 * never the background image or fill.
 *
 * Every stroke is recorded as vector data — {tool, color, w, pts:[[x,y],...]}
 * in canvas-logical coordinates — and the canvas is always redrawn in full
 * from that array. That single model powers undo (pop), clear (empty array),
 * re-editing, AND lossless panel resize (the bottom-right grip resizes the
 * canvas bitmap and repaints from the model; size persists per device under
 * Cade.store "cade-draw-size"). On insert, the strokes JSON (plus the
 * background mode and a snapshot of the locked layer) is saved to Cade.idbStore
 * under "drawstrokes:<hash>" (the content hash the core just minted),
 * indexed by "drawstrokes:__index" (pruned to the 100 most recent).
 * window.__drawEditByHash(hash) reopens a saved drawing for further editing;
 * saving from an edit session replaces the old image token in the document.
 *
 * LIMITATION: stroke data is DEVICE-LOCAL (IndexedDB) — it does not sync.
 * Other devices that sync the document see only the flattened image; they can
 * still draw over it, loaded as a locked background layer through
 * window.resolveImageRef (the core's top-level declaration — classic-script
 * function declarations bind to window). A round-3 core regression aliased
 * that same binding to a self-calling arrow ("Maximum call stack size
 * exceeded" on every ref-image render — the "insert a drawing → nothing
 * shows" bug); the alias is gone from txt.html, and repairResolveImageRef()
 * below is the guard that keeps this module working should it ever come back
 * (or a stale service-worker cache still serve the broken core): it probes the
 * global once and, only when broken, swaps in a local-bytes resolver.
 */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  // Load CSS at module-load time (the loader's per-module path context is only
  // valid during the synchronous load — see docs/README.md §4).
  Cade.loadCSS('draw.css');

  // ---------------------------------------------------------------- constants
  var PANEL_ID = 'draw-panel';
  var KEY_PREFIX = 'drawstrokes:';           // idbStore key per drawing
  var IDX_KEY = 'drawstrokes:__index';       // idbStore JSON array of hashes (oldest first)
  var MAX_SAVED = 100;                        // index prune cap
  var BG_KEY = 'cade-draw-bg';                // Cade.store: persisted background mode
  var SIZE_KEY = 'cade-draw-size';            // Cade.store: persisted logical canvas size
  // Hash-ref image tokens only (the core's legacy inline form uses ':').
  // Matches the core's format "![img:<code>#<hash>]" where code ∈ j/w/a and
  // hash is 32 lowercase hex chars (see IMG_TOKEN_RE + _imgHash in txt.html).
  var TOKEN_RE_SRC = '!\\[img:([a-z0-9]+)#([a-f0-9]+)\\]';
  // Fixed ink hexes — mid-dark and saturated so they read on light backgrounds
  // and the checkerboard, plus a black/white pair for either extreme.
  var COLORS = ['#e03131', '#e8590c', '#f5a623', '#2f9e44', '#1971c2', '#9c36b5', '#111111', '#ffffff'];
  var WIDTHS = [2, 5, 10];                    // logical px (pen); hl/eraser are scaled up
  var HL_ALPHA = 0.35;                        // highlighter translucency
  var HL_SCALE = 2.2;                         // highlighter width multiplier
  var ERASER_SCALE = 2.6;                     // eraser width multiplier
  var MIN_W = 160, MIN_H = 120;               // resize floor (logical px)
  var BG_MODES = [                            // exported-background choices
    { id: 'transparent', label: 'Transparent background (inserted image keeps alpha)' },
    { id: 'white', label: 'White background' },
    { id: 'black', label: 'Black background' },
  ];

  // Live session state; null when the panel is closed.
  // { panel, canvas, ctx, buf, W, H, dpr, fit, strokes, cur, drawingId, tool,
  //   color, width, editingHash, bg, bgMode, rs (grip drag), ui:{...}, _key }
  var S = null;

  // ------------------------------------------- core image-pipeline guard (#A)
  // Regression guard for the round-3 core bug (see header LIMITATION note): a
  // `window.resolveImageRef = (c, h) => resolveImageRef(c, h)` alias clobbers
  // the very function it aliases (a top-level declaration in a classic script
  // IS the window binding), so the arrow recurses into itself and every image
  // render throws. A healthy async function can never throw synchronously, so
  // probe once and, only if the global is the broken self-caller, replace it
  // with a resolver that mirrors the core's local byte store: idbStore
  // "img:<hash>" holds "<code>:<b64>"; resolve to {url, b64} exactly like the
  // original. (The original's Firebase fallback is core-internal and
  // unreachable from here — bytes not yet local keep showing the core's retry
  // placeholder instead of crashing the editor.)
  var REF_MIME = { j: 'image/jpeg', w: 'image/webp', a: 'image/avif' };
  var _refCache = {};   // hash -> {url, b64}
  var _refOrder = [];   // LRU order, oldest first
  function _payloadToRef(stored, code) {
    var s = String(stored);
    var ci = s.indexOf(':');
    var c = ci > 0 ? s.slice(0, ci) : (code || 'j');
    var b64 = ci > 0 ? s.slice(ci + 1) : s;
    var mime = REF_MIME[c] || 'image/jpeg';
    var url;
    try {
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    } catch (e) { url = 'data:' + mime + ';base64,' + b64; }
    return { url: url, b64: b64 };
  }
  function _localResolveImageRef(code, hash) {
    if (_refCache[hash]) return Promise.resolve(_refCache[hash]);
    return Cade.idbStore.get('img:' + hash).then(function (stored) {
      if (stored == null) return null;
      var rec = _payloadToRef(stored, code);
      _refCache[hash] = rec;
      _refOrder.push(hash);
      while (_refOrder.length > 32) {
        var h = _refOrder.shift();
        var old = _refCache[h];
        delete _refCache[h];
        if (old && old.url && old.url.indexOf('blob:') === 0) {
          try { URL.revokeObjectURL(old.url); } catch (e) {}
        }
      }
      return rec;
    }).catch(function () { return null; });
  }
  function repairResolveImageRef() {
    if (typeof window.resolveImageRef !== 'function') return; // core predates the alias
    try {
      var p = window.resolveImageRef('w', 'ffffffffffffffffffffffffffffffff');
      if (p && typeof p.catch === 'function') p.catch(function () {});
      return; // healthy — leave the core's resolver alone
    } catch (e) { /* RangeError: the self-recursive alias — replace it */ }
    window.resolveImageRef = _localResolveImageRef;
  }
  repairResolveImageRef();

  // ------------------------------------------------------------------ drawing
  function toLogical(e) {
    var r = S.canvas.getBoundingClientRect();
    var sx = (r.width > 0) ? S.W / r.width : 1;
    var sy = (r.height > 0) ? S.H / r.height : 1;
    var x = (e.clientX - r.left) * sx;
    var y = (e.clientY - r.top) * sy;
    // Round to 0.1px — keeps the saved JSON compact without visible loss.
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  }

  // Paint one recorded stroke onto a 2D context (logical coordinates).
  // The eraser is destination-out: it cuts pixels from the STROKE LAYER only
  // (see paintScene), so transparent exports get real holes — never white
  // paint — and the locked background image underneath is never touched.
  function drawStroke(ctx2, st) {
    var pts = st.pts;
    if (!pts || !pts.length) return;
    ctx2.save();
    ctx2.lineCap = 'round';
    ctx2.lineJoin = 'round';
    if (st.tool === 'hl') ctx2.globalAlpha = HL_ALPHA;
    if (st.tool === 'eraser') {
      ctx2.globalCompositeOperation = 'destination-out';
      ctx2.strokeStyle = '#000000'; // any opaque color — only alpha matters
    } else {
      ctx2.strokeStyle = st.color;
    }
    ctx2.lineWidth = st.w;
    ctx2.beginPath();
    ctx2.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 1) ctx2.lineTo(pts[0][0] + 0.01, pts[0][1]); // dot (round cap)
    else for (var i = 1; i < pts.length; i++) ctx2.lineTo(pts[i][0], pts[i][1]);
    ctx2.stroke();
    ctx2.restore();
  }

  function renderStrokes(ctx2, sess) {
    for (var i = 0; i < sess.strokes.length; i++) drawStroke(ctx2, sess.strokes[i]);
    if (sess.cur) drawStroke(ctx2, sess.cur);
  }

  // Fit the locked background image inside the canvas, centered, aspect kept.
  function bgFitRect(sess) {
    var iw = sess.bg.naturalWidth || sess.bg.width || sess.W;
    var ih = sess.bg.naturalHeight || sess.bg.height || sess.H;
    var s = Math.min(sess.W / iw, sess.H / ih);
    var w = iw * s, h = ih * s;
    return { x: (sess.W - w) / 2, y: (sess.H - h) / 2, w: w, h: h };
  }

  // The session's persistent stroke-layer canvas (screen paints), resized on
  // demand. Export paints build their own 1× throwaway layer instead.
  function ensureBuffer(sess, scale) {
    var w = Math.max(1, Math.round(sess.W * scale));
    var h = Math.max(1, Math.round(sess.H * scale));
    if (!sess.buf) sess.buf = document.createElement('canvas');
    if (sess.buf.width !== w) sess.buf.width = w;
    if (sess.buf.height !== h) sess.buf.height = h;
    return sess.buf;
  }

  // The doc pipeline re-encodes exports through compressImage → toDataURL
  // (avif|webp|jpeg — see bestImageFormat in txt.html). AVIF/WebP carry alpha;
  // JPEG composites it to BLACK. Mirror the core's format probe so transparent
  // exports quietly fall back to white where the codec would eat the alpha.
  var _alphaOK = null;
  function alphaExportOK() {
    if (_alphaOK !== null) return _alphaOK;
    try {
      var c = document.createElement('canvas');
      c.width = c.height = 2;
      _alphaOK = c.toDataURL('image/avif').indexOf('data:image/avif') === 0 ||
                 c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) { _alphaOK = false; }
    return _alphaOK;
  }

  // Full scene paint in logical coordinates: background (transparent / solid)
  // → locked bg image (fit + centered) → stroke layer. On screen a transparent
  // background shows draw.css's checkerboard THROUGH the canvas; the exported
  // PNG keeps real alpha there. opts: { scale (backing-store multiplier for
  // the stroke layer), forExport (fresh 1× layer + JPEG-fallback whitening) }.
  function paintScene(ctx2, sess, opts) {
    opts = opts || {};
    var mode = sess.bgMode || 'transparent';
    if (mode === 'transparent' && opts.forExport && !alphaExportOK()) mode = 'white';
    var scale = opts.scale > 0 ? opts.scale : 1;
    var buf, bctx;
    if (opts.forExport) {
      buf = document.createElement('canvas');
      buf.width = Math.max(1, Math.round(sess.W * scale));
      buf.height = Math.max(1, Math.round(sess.H * scale));
    } else {
      buf = ensureBuffer(sess, scale);
    }
    bctx = buf.getContext('2d');
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, buf.width, buf.height);
    bctx.setTransform(scale, 0, 0, scale, 0, 0);
    renderStrokes(bctx, sess);

    ctx2.save();
    ctx2.globalAlpha = 1;
    ctx2.clearRect(0, 0, sess.W, sess.H);
    if (mode !== 'transparent') {
      ctx2.fillStyle = (mode === 'black') ? '#000000' : '#ffffff';
      ctx2.fillRect(0, 0, sess.W, sess.H);
    }
    if (sess.bg) {
      var r = bgFitRect(sess);
      try { ctx2.drawImage(sess.bg, r.x, r.y, r.w, r.h); } catch (e) {}
    }
    try { ctx2.drawImage(buf, 0, 0, sess.W, sess.H); } catch (e) {}
    ctx2.restore();
  }

  function redraw() {
    if (!S || !S.ctx) return;
    paintScene(S.ctx, S, { scale: S.dpr || 1 });
  }

  // --------------------------------------------------------- pointer handlers
  // pointerdown/move/up + setPointerCapture cover mouse, touch and stylus with
  // one code path. preventDefault (plus touch-action:none in draw.css) keeps
  // the page from scrolling while sketching on mobile.
  function onDown(e) {
    if (!S) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { S.canvas.setPointerCapture(e.pointerId); } catch (err) {}
    S.drawingId = e.pointerId;
    var w = S.width * (S.tool === 'hl' ? HL_SCALE : S.tool === 'eraser' ? ERASER_SCALE : 1);
    S.cur = { tool: S.tool, color: S.color, w: w, pts: [toLogical(e)] };
    redraw();
  }
  function onMove(e) {
    if (!S || !S.cur || e.pointerId !== S.drawingId) return;
    e.preventDefault();
    var p = toLogical(e);
    var last = S.cur.pts[S.cur.pts.length - 1];
    if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.6) return; // thin dense input
    S.cur.pts.push(p);
    redraw();
  }
  function onUp(e) {
    if (!S || !S.cur || e.pointerId !== S.drawingId) return;
    e.preventDefault();
    try { S.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    S.strokes.push(S.cur);
    S.cur = null;
    S.drawingId = null;
    redraw();
  }

  function undoStroke() {
    if (!S) return;
    S.strokes.pop();
    redraw();
  }
  function clearAll() {
    if (!S) return;
    S.strokes = [];
    S.cur = null;
    redraw();
  }

  // -------------------------------------------------------- panel resize (#D)
  // Bottom-right grip: drag resizes the LOGICAL canvas (and with it the
  // panel). Deltas are divided by the session's CSS fit factor so an edit
  // session opened scaled-down resizes smoothly with no jump. The drawing
  // survives because strokes are vector data — applySize just repaints.
  function onGripDown(e) {
    if (!S) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    S.rs = { id: e.pointerId, x: e.clientX, y: e.clientY, w: S.W, h: S.H };
  }
  function onGripMove(e) {
    if (!S || !S.rs || e.pointerId !== S.rs.id) return;
    e.preventDefault();
    var fit = S.fit || 1;
    // Keep the panel usable on small screens: canvas CSS size stays inside the
    // viewport (panel chrome ≈ 20px sides, ≈ 150px of header + toolbars).
    var maxW = Math.max(MIN_W, Math.round((window.innerWidth - 36) / fit));
    var maxH = Math.max(MIN_H, Math.round((window.innerHeight - 150) / fit));
    var w = Math.round(Math.min(Math.max(MIN_W, S.rs.w + (e.clientX - S.rs.x) / fit), maxW));
    var h = Math.round(Math.min(Math.max(MIN_H, S.rs.h + (e.clientY - S.rs.y) / fit), maxH));
    if (w !== S.W || h !== S.H) applySize(w, h);
  }
  function onGripUp(e) {
    if (!S || !S.rs || e.pointerId !== S.rs.id) return;
    e.preventDefault();
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {}
    S.rs = null;
    try { Cade.store.set(SIZE_KEY, JSON.stringify({ w: S.W, h: S.H })); } catch (err) {}
  }
  // Resize the canvas bitmap to the session's new logical size and repaint
  // from the stroke model (resizing a canvas wipes its bitmap; the model is
  // the source of truth, so nothing is lost).
  function applySize(w, h) {
    if (!S) return;
    S.W = w;
    S.H = h;
    var dpr = S.dpr || 1, fit = S.fit || 1;
    S.canvas.width = Math.round(w * dpr);
    S.canvas.height = Math.round(h * dpr);
    S.canvas.style.width = Math.round(w * fit) + 'px';
    S.canvas.style.height = Math.round(h * fit) + 'px';
    try { S.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); } catch (e) {}
    redraw();
  }

  // ------------------------------------------------------------ persistence
  function getStrokesRecord(hash) {
    return Cade.idbStore.get(KEY_PREFIX + hash).then(function (raw) {
      if (raw == null) return null;
      try {
        var d = (typeof raw === 'string') ? JSON.parse(raw) : raw;
        return (d && Array.isArray(d.strokes)) ? d : null;
      } catch (e) { return null; }
    }).catch(function () { return null; });
  }

  // Save strokes under "drawstrokes:<hash>" and maintain the pruned index —
  // when the index exceeds MAX_SAVED, the evicted entries' stroke records are
  // deleted too so IndexedDB doesn't grow without bound. v2 records also carry
  // the background mode and a data-URL snapshot of the locked bg layer so a
  // re-edit restores the exact scene (v1 records predate both: they were drawn
  // on an always-white canvas, so they reopen with bgMode "white").
  async function saveStrokes(hash, strokes, dims, extra) {
    try {
      await Cade.idbStore.set(KEY_PREFIX + hash, JSON.stringify({
        v: 2, w: dims.w, h: dims.h, strokes: strokes,
        bgMode: (extra && extra.bgMode) || 'white',
        bg: (extra && extra.bg) || null,
      }));
      var idx = [];
      try { idx = JSON.parse((await Cade.idbStore.get(IDX_KEY)) || '[]') || []; } catch (e) { idx = []; }
      idx = idx.filter(function (h) { return h !== hash; });
      idx.push(hash); // most-recent last
      while (idx.length > MAX_SAVED) {
        var evicted = idx.shift();
        try { await Cade.idbStore.remove(KEY_PREFIX + evicted); } catch (e) {}
      }
      await Cade.idbStore.set(IDX_KEY, JSON.stringify(idx));
      return true;
    } catch (e) { return false; }
  }

  // Snapshot the locked background image as a compact data URL for the
  // drawstrokes record (device-local). Capped at 1024px on the long side.
  function bgSnapshot(img) {
    if (!img) return null;
    try {
      var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      if (!iw || !ih) return null;
      var s = Math.min(1, 1024 / Math.max(iw, ih));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(iw * s));
      c.height = Math.max(1, Math.round(ih * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return alphaExportOK() ? c.toDataURL('image/webp', 0.85) : c.toDataURL('image/png');
    } catch (e) { return null; }
  }

  // ------------------------------------------------- doc token find / replace
  // After `await window.insertImageFile(file)` the core has inserted
  // "![img:<code>#<hash>]\n" at the cursor and moved the cursor just past it.
  // Scan the current line ± 2 lines and take the token whose END sits nearest
  // the cursor (ties prefer the later match ⇒ the last-inserted token).
  function findInsertedHashNearCursor() {
    try {
      var state = Cade.editor.state, doc = state.doc;
      var pos = state.selection.main.head;
      var ln = doc.lineAt(pos).number;
      var from = doc.line(Math.max(1, ln - 2)).from;
      var to = doc.line(Math.min(doc.lines, ln + 2)).to;
      var text = doc.sliceString(from, to);
      var re = new RegExp(TOKEN_RE_SRC, 'g');
      var m, best = null;
      while ((m = re.exec(text)) !== null) {
        var end = from + m.index + m[0].length;
        if (!best || Math.abs(pos - end) <= Math.abs(pos - best.end)) best = { hash: m[2], end: end };
      }
      return best ? best.hash : null;
    } catch (e) { return null; }
  }

  // Re-edit save: replace the OLD image token with the newly inserted one.
  // We cannot build the new token ourselves — only the core knows the codec
  // and content hash it will mint (compressImage + _imgHash). So instead:
  //   (1) park the cursor right AFTER the old token,
  //   (2) let window.insertImageFile run its full pipeline there,
  //   (3) locate the token it just inserted (bounded scan right after the old
  //       token — the core inserts "\n" + token + "\n", the "\n" prefix
  //       because the char before the cursor is "]"),
  //   (4) delete the old token + that separator newline in one dispatch, so
  //       the new token fuses into the old token's exact spot.
  // Returns the new hash, or null if nothing was inserted (old token is then
  // left untouched). If the old hash appears more than once, the first
  // occurrence is the one replaced.
  async function replaceEditedToken(file, oldHash) {
    var ed = Cade.editor;
    var m = null, docText = '';
    if (/^[a-f0-9]{8,}$/.test(oldHash || '')) {
      docText = ed.state.doc.toString();
      m = new RegExp('!\\[img:[a-z0-9]+#' + oldHash + '\\]').exec(docText);
    }
    if (!m) {
      // Old token no longer in the doc (user deleted it) — plain insert at the
      // current cursor instead.
      await window.insertImageFile(file);
      return findInsertedHashNearCursor();
    }
    var oldFrom = m.index, oldTo = m.index + m[0].length, oldTok = m[0];

    // (1) + (2): cursor just after the old token, then run the core pipeline.
    ed.dispatch({ selection: { anchor: oldTo, head: oldTo } });
    await window.insertImageFile(file);

    // (3): the new token must start within a couple of chars of oldTo (just
    // the "\n" prefix). A bounded slice keeps this O(1) on huge documents.
    var newText = ed.state.doc.toString();
    var scan = newText.slice(oldTo, oldTo + 96);
    var m2 = new RegExp(TOKEN_RE_SRC).exec(scan);
    if (!m2 || m2.index > 2) {
      // Nothing landed next to the old token — insertImageFile failed (its own
      // toast explains why) or the doc changed underneath us. Keep the old
      // token so no drawing is lost.
      return null;
    }
    var newHash = m2[2];
    var newTokStart = oldTo + m2.index;
    var newTokEnd = newTokStart + m2[0].length;

    // (4): verify the old token is still exactly where we measured it before
    // deleting — if a concurrent edit moved it, leave both tokens rather than
    // risk corrupting unrelated text.
    if (newText.slice(oldFrom, oldTo) === oldTok) {
      var changes = [{ from: oldFrom, to: newTokStart, insert: '' }];
      // The core also appended a trailing "\n" after the new token; collapse
      // it when the old token already had its own newline (avoids growing a
      // blank line on every re-edit).
      if (newText.charAt(newTokEnd) === '\n' && newText.charAt(newTokEnd + 1) === '\n') {
        changes.push({ from: newTokEnd, to: newTokEnd + 1, insert: '' });
      }
      ed.dispatch({ changes: changes });
    }
    return newHash;
  }

  // ------------------------------------------------------------ insert / save
  // Render the scene (bg mode → locked layer → strokes) to a PNG blob at
  // logical size. PNG carries the alpha; the core's compressImage re-encodes
  // to AVIF/WebP which keep it (JPEG-only browsers were already whitened in
  // paintScene via alphaExportOK).
  function exportBlob(sess) {
    return new Promise(function (resolve) {
      try {
        var c = document.createElement('canvas');
        c.width = sess.W;
        c.height = sess.H;
        var x = c.getContext('2d');
        paintScene(x, sess, { forExport: true, scale: 1 });
        if (c.toBlob) c.toBlob(function (b) { resolve(b || null); }, 'image/png');
        else resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  async function doInsert() {
    var sess = S;
    if (!sess) return;
    if (!sess.strokes.length && !sess.bg) { Cade.showToast('Nothing drawn yet', 'info', 2000); return; }
    if (typeof window.insertImageFile !== 'function') {
      Cade.showToast('Image pipeline unavailable', 'error', 2500); return;
    }
    var blob = await exportBlob(sess);
    if (!blob) { Cade.showToast('Could not render PNG', 'error', 2500); return; }
    var file = new File([blob], 'drawing.png', { type: 'image/png' });
    var strokes = sess.strokes.slice();
    var dims = { w: sess.W, h: sess.H };
    var extra = { bgMode: sess.bgMode, bg: bgSnapshot(sess.bg) };

    var hash = null;
    try {
      if (sess.editingHash) {
        hash = await replaceEditedToken(file, sess.editingHash);
        if (hash === null) return; // insert failed — keep the panel open to retry
      } else {
        // Fresh insert at the user's cursor; the core compresses, hashes,
        // stores/uploads the bytes, inserts the token, and toasts.
        await window.insertImageFile(file);
        hash = findInsertedHashNearCursor();
      }
    } catch (e) {
      // Surface pipeline failures instead of silently leaving a stuck panel.
      Cade.showToast('Insert failed: ' + ((e && e.message) || e), 'error', 3000);
      return; // keep the panel (and the drawing) so nothing is lost
    }
    // Persist the vector strokes under the NEW content hash so this exact
    // image can be re-edited later (device-local — see header LIMITATION).
    // hash is null when the core fell back to a legacy inline token; the image
    // is still in the doc, it just can't be re-edited.
    if (hash) {
      await saveStrokes(hash, strokes, dims, extra);
      if (sess.editingHash) Cade.showToast('Drawing updated', 'success', 2000);
    }
    if (S === sess) closePanel(); // user may have closed it during the awaits
  }

  function doSavePng() {
    var sess = S;
    if (!sess) return;
    exportBlob(sess).then(function (blob) {
      if (!blob) { Cade.showToast('Could not render PNG', 'error', 2500); return; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'drawing.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 5000);
    });
  }

  // ------------------------------------------------------- background imports
  function loadImageEl(url) {
    return new Promise(function (resolve) {
      try {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { resolve(null); };
        img.src = url;
      } catch (e) { resolve(null); }
    });
  }

  // Install an Image as the session's locked background layer.
  function setBackground(img) {
    if (!S || !img) return;
    S.bg = img;
    redraw();
    Cade.showToast('Image set as locked background — draw over it', 'success', 2200);
  }

  function pickImportFile() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var url = URL.createObjectURL(f);
      loadImageEl(url).then(function (img) {
        // Safe to revoke once decoded; the Image element keeps its bitmap.
        try { URL.revokeObjectURL(url); } catch (e) {}
        if (!img) { Cade.showToast('Could not load that image', 'error', 2500); return; }
        setBackground(img);
      });
    });
    inp.click();
  }

  // ---------------------------------------------------------------- panel UI
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  // Active-state helper (plain className strings — no classList — so the group
  // logic stays trivial). base must equal the button's constructed class.
  function setActive(btns, active) {
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.className = b._baseClass + (b === active ? ' draw-active' : '');
    }
  }

  function closePanel() {
    if (S && S._key) { try { document.removeEventListener('keydown', S._key, true); } catch (e) {} }
    S = null;
    var p = document.getElementById(PANEL_ID);
    if (p) { p._onClose = null; p.remove(); }
    try { Cade.editor.focus(); } catch (e) {}
  }

  // Build (or rebuild) the whiteboard panel.
  // opts: { strokes?, w?, h?, editingHash?, bg? (locked background Image),
  //         bgMode? ('transparent'|'white'|'black') }
  function openSession(opts) {
    opts = opts || {};
    Cade.closeAllMenus();
    closePanel(); // rebuild fresh (re-edit may need different canvas dims)

    var panel = Cade.mkPanel(PANEL_ID, '✏️ Whiteboard', '');
    var body = panel.querySelector('.cade-panel-body');

    // Background mode: explicit (re-edit) → per-device preference → transparent.
    var storedBg = Cade.store.get(BG_KEY);
    var bgMode = opts.bgMode ||
      ((storedBg === 'transparent' || storedBg === 'white' || storedBg === 'black') ? storedBg : 'transparent');

    var sess = {
      panel: panel, canvas: null, ctx: null, buf: null,
      W: 0, H: 0, dpr: 1, fit: 1,
      strokes: Array.isArray(opts.strokes) ? opts.strokes : [],
      cur: null, drawingId: null, rs: null,
      tool: 'pen', color: COLORS[6] /* black */, width: WIDTHS[1],
      editingHash: opts.editingHash || null,
      bg: opts.bg || null,
      bgMode: bgMode,
      ui: {},
    };

    // Canvas geometry. Defaults to ~min(82vw, 520) × min(55vh, 420) but a
    // grip-resized size persists per device (SIZE_KEY) and a re-edited drawing
    // keeps its ORIGINAL logical size (so saved stroke coordinates stay
    // valid). Oversized canvases are CSS-scaled down to fit the viewport —
    // pointer coords are mapped through getBoundingClientRect either way.
    var defW = Math.max(160, Math.min(Math.round(window.innerWidth * 0.82), 520));
    var defH = Math.max(120, Math.min(Math.round(window.innerHeight * 0.55), 420));
    var storedSize = null;
    if (!(opts.w > 0)) {
      try { storedSize = JSON.parse(Cade.store.get(SIZE_KEY) || 'null'); } catch (e) { storedSize = null; }
    }
    sess.W = Math.round(opts.w > 0 ? opts.w : (storedSize && storedSize.w > 0 ? storedSize.w : defW));
    sess.H = Math.round(opts.h > 0 ? opts.h : (storedSize && storedSize.h > 0 ? storedSize.h : defH));
    sess.W = Math.min(Math.max(MIN_W, sess.W), 4096);
    sess.H = Math.min(Math.max(MIN_H, sess.H), 4096);
    var fitW = Math.max(MIN_W, window.innerWidth - 36);
    var fitH = Math.max(MIN_H, Math.round(window.innerHeight * 0.72));
    var fit = Math.min(1, fitW / sess.W, fitH / sess.H);

    // --- toolbar row 1: tools + colors
    var row1 = el('div', 'draw-toolbar');
    var toolDefs = [['pen', '✏️', 'Pen'], ['hl', '🖍️', 'Highlighter'], ['eraser', '🧽', 'Eraser']];
    var toolBtns = [];
    toolDefs.forEach(function (t) {
      var b = el('button', 'draw-btn draw-tool', t[1]);
      b._baseClass = 'draw-btn draw-tool';
      b.title = t[2];
      b.setAttribute('data-tool', t[0]);
      b.addEventListener('click', function () {
        if (!S) return;
        S.tool = t[0];
        setActive(toolBtns, b);
      });
      toolBtns.push(b);
      row1.appendChild(b);
    });
    row1.appendChild(el('span', 'draw-sep'));
    var swatchBtns = [];
    COLORS.forEach(function (hex, i) {
      var b = el('button', 'draw-swatch');
      b._baseClass = 'draw-swatch';
      b.title = hex;
      b.setAttribute('data-color', hex);
      b.style.background = hex;
      b.addEventListener('click', function () {
        if (!S) return;
        S.color = hex;
        setActive(swatchBtns, b);
        // Picking a color implies inking, not erasing.
        if (S.tool === 'eraser') { S.tool = 'pen'; setActive(toolBtns, toolBtns[0]); }
      });
      swatchBtns.push(b);
      row1.appendChild(b);
    });

    // --- toolbar row 2: widths + background selector + import
    var row2 = el('div', 'draw-toolbar');
    var widthBtns = [];
    WIDTHS.forEach(function (w, i) {
      var b = el('button', 'draw-btn draw-width');
      b._baseClass = 'draw-btn draw-width';
      b.title = 'Stroke width ' + w + 'px';
      b.setAttribute('data-width', String(w));
      var dot = el('span', 'draw-dot');
      var d = 4 + i * 4;
      dot.style.width = d + 'px';
      dot.style.height = d + 'px';
      b.appendChild(dot);
      b.addEventListener('click', function () {
        if (!S) return;
        S.width = w;
        setActive(widthBtns, b);
      });
      widthBtns.push(b);
      row2.appendChild(b);
    });
    row2.appendChild(el('span', 'draw-sep'));
    // Background selector — what the INSERTED image gets behind the strokes.
    // Transparent is the default; the on-screen checkerboard is CSS-only.
    var bgBtns = [];
    BG_MODES.forEach(function (m) {
      var b = el('button', 'draw-bgswatch draw-bgsw-' + m.id);
      b._baseClass = 'draw-bgswatch draw-bgsw-' + m.id;
      b.title = m.label;
      b.setAttribute('data-bg', m.id);
      b.addEventListener('click', function () {
        if (!S) return;
        S.bgMode = m.id;
        try { Cade.store.set(BG_KEY, m.id); } catch (e) {}
        setActive(bgBtns, b);
        S.canvas.className = 'draw-canvas draw-cv-' + m.id;
        redraw();
      });
      bgBtns.push(b);
      row2.appendChild(b);
    });
    row2.appendChild(el('span', 'draw-sep'));
    var importBtn = el('button', 'draw-btn', '🖼 Import');
    importBtn._baseClass = 'draw-btn';
    importBtn.title = 'Import an image as a locked background layer to draw over';
    importBtn.setAttribute('data-act', 'import');
    importBtn.addEventListener('click', pickImportFile);
    row2.appendChild(importBtn);

    // --- toolbar row 3: undo/clear + save/insert
    var row3 = el('div', 'draw-toolbar');
    var undoBtn = el('button', 'draw-btn', '↩ Undo');
    undoBtn._baseClass = 'draw-btn';
    undoBtn.title = 'Undo last stroke';
    undoBtn.setAttribute('data-act', 'undo');
    undoBtn.addEventListener('click', undoStroke);
    row3.appendChild(undoBtn);
    var clearBtn = el('button', 'draw-btn', '✕ Clear');
    clearBtn._baseClass = 'draw-btn';
    clearBtn.title = 'Clear the canvas (keeps a background image)';
    clearBtn.setAttribute('data-act', 'clear');
    clearBtn.addEventListener('click', clearAll);
    row3.appendChild(clearBtn);
    row3.appendChild(el('span', 'draw-spacer'));
    var saveBtn = el('button', 'draw-btn', '⬇ PNG');
    saveBtn._baseClass = 'draw-btn';
    saveBtn.title = 'Download as PNG';
    saveBtn.setAttribute('data-act', 'save');
    saveBtn.addEventListener('click', doSavePng);
    row3.appendChild(saveBtn);
    var insertBtn = el('button', 'draw-btn draw-primary', sess.editingHash ? 'Update' : 'Insert');
    insertBtn._baseClass = 'draw-btn draw-primary';
    insertBtn.title = sess.editingHash
      ? 'Replace the original image in the document'
      : 'Insert into the document as an embedded image';
    insertBtn.setAttribute('data-act', 'insert');
    insertBtn.addEventListener('click', function () { doInsert(); });
    row3.appendChild(insertBtn);

    body.appendChild(row1);
    body.appendChild(row2);
    body.appendChild(row3);

    // --- edit-mode hint
    if (sess.editingHash) {
      var hint = el('div', 'draw-hint',
        (sess.bg && !sess.strokes.length)
          ? 'Drawing over the flattened image as a locked layer — Update replaces it in the doc.'
          : 'Editing an embedded drawing — Update replaces it in the doc.');
      body.appendChild(hint);
      sess.ui.hint = hint;
    }

    // --- canvas (devicePixelRatio backing store for crispness)
    var canvas = el('canvas', 'draw-canvas draw-cv-' + sess.bgMode);
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    sess.dpr = dpr;
    sess.fit = fit;
    canvas.width = Math.round(sess.W * dpr);
    canvas.height = Math.round(sess.H * dpr);
    canvas.style.width = Math.round(sess.W * fit) + 'px';
    canvas.style.height = Math.round(sess.H * fit) + 'px';
    body.appendChild(canvas);
    sess.canvas = canvas;
    sess.ctx = canvas.getContext('2d');
    try { sess.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); } catch (e) {}

    // Pointer events (non-passive so preventDefault sticks on touch).
    canvas.addEventListener('pointerdown', onDown, { passive: false });
    canvas.addEventListener('pointermove', onMove, { passive: false });
    canvas.addEventListener('pointerup', onUp, { passive: false });
    canvas.addEventListener('pointercancel', onUp, { passive: false });

    // --- resize grip (bottom-right corner of the panel)
    var grip = el('div', 'draw-resize');
    grip.title = 'Drag to resize';
    grip.addEventListener('pointerdown', onGripDown, { passive: false });
    grip.addEventListener('pointermove', onGripMove, { passive: false });
    grip.addEventListener('pointerup', onGripUp, { passive: false });
    grip.addEventListener('pointercancel', onGripUp, { passive: false });
    panel.appendChild(grip);
    sess.ui.grip = grip;

    // Escape closes (capture so the editor doesn't swallow it); removed in
    // closePanel / _onClose.
    sess._key = function (e) {
      if (e.key === 'Escape' && document.getElementById(PANEL_ID)) { e.preventDefault(); closePanel(); }
    };
    document.addEventListener('keydown', sess._key, true);
    panel._onClose = function () {
      if (S && S._key === sess._key) {
        try { document.removeEventListener('keydown', sess._key, true); } catch (e) {}
        S = null;
      }
      try { Cade.editor.focus(); } catch (e) {}
    };

    S = sess;
    sess.ui.toolBtns = toolBtns;
    sess.ui.swatchBtns = swatchBtns;
    sess.ui.widthBtns = widthBtns;
    sess.ui.bgBtns = bgBtns;
    sess.ui.insertBtn = insertBtn;
    setActive(toolBtns, toolBtns[0]);       // pen
    setActive(swatchBtns, swatchBtns[6]);   // black
    setActive(widthBtns, widthBtns[1]);     // medium
    var bgIdx = 0;
    for (var bi = 0; bi < BG_MODES.length; bi++) if (BG_MODES[bi].id === sess.bgMode) bgIdx = bi;
    setActive(bgBtns, bgBtns[bgIdx]);
    redraw();
    return sess;
  }

  // Palette entry point — toggles like the other widgets.
  function open() {
    if (document.getElementById(PANEL_ID)) { closePanel(); return; }
    openSession({});
  }

  // Global opener: ensures the panel is OPEN (no toggle). Used by core hooks
  // and tests; also handy from the console.
  window.__drawOpen = function () {
    if (!document.getElementById(PANEL_ID)) openSession({});
    return true;
  };

  // Load an image (mime + base64, e.g. from the doc's right-click image menu)
  // as the locked background layer, opening the panel first if needed:
  //   await window.__drawImportImage('image/png', '<base64>')
  window.__drawImportImage = async function (mime, b64) {
    if (!b64) { Cade.showToast('No image data', 'error', 2000); return false; }
    var img = await loadImageEl('data:' + (mime || 'image/png') + ';base64,' + b64);
    if (!img) { Cade.showToast('Could not load that image', 'error', 2500); return false; }
    if (!S || !document.getElementById(PANEL_ID)) openSession({});
    setBackground(img);
    return true;
  };

  // ------------------------------------------------------------------ re-edit
  // Re-open a previously inserted drawing by its image-token hash.
  // Exposed on window so the core's image context menu can call it:
  //   await window.__drawEditByHash('3fa9…')
  window.__drawEditByHash = async function (hash) {
    hash = String(hash || '').toLowerCase().replace(/[^a-f0-9]/g, '');
    if (!hash) { Cade.showToast('Bad image hash', 'error', 2000); return false; }

    // 1) Preferred: this device still has the vector strokes (v2 records also
    // restore the background mode + locked layer snapshot).
    var rec = await getStrokesRecord(hash);
    if (rec) {
      var bgImg = rec.bg ? await loadImageEl(rec.bg) : null;
      openSession({
        strokes: rec.strokes, w: rec.w, h: rec.h, editingHash: hash,
        bgMode: rec.bgMode || 'white', bg: bgImg,
      });
      return true;
    }

    // 2) Fallback: no local strokes (drawn on another device, or pruned) —
    // load the flattened image as a LOCKED background layer to draw over.
    // bgMode "transparent" preserves whatever alpha the flattened image has.
    if (typeof window.resolveImageRef === 'function') {
      var ref = null;
      try { ref = await window.resolveImageRef('w', hash); } catch (e) {}
      if (ref && ref.url) {
        var img = await loadImageEl(ref.url);
        if (img) {
          var iw = img.naturalWidth || img.width || 520;
          var ih = img.naturalHeight || img.height || 420;
          openSession({ strokes: [], bg: img, w: iw, h: ih, editingHash: hash, bgMode: 'transparent' });
          return true;
        }
      }
    }

    Cade.showToast('No editable stroke data on this device', 'error', 3000);
    return false;
  };

  // ------------------------------------------------------------ registration
  Cade.registerWidget({
    name: 'Whiteboard',
    description: 'Free-draw sketches; insert into the doc as an image',
    icon: '✏️',
    tags: 'draw,whiteboard,sketch,doodle,pen,drawing,canvas',
    open: open,
  });

  // Test hook — Node-only (typeof process guard keeps it out of browsers).
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    window.__drawTest = {
      open: open,
      openSession: openSession,
      closePanel: closePanel,
      state: function () { return S; },
      down: onDown, move: onMove, up: onUp,
      undo: undoStroke, clearAll: clearAll, redraw: redraw,
      applySize: applySize,
      findInsertedHashNearCursor: findInsertedHashNearCursor,
      saveStrokes: saveStrokes,
      replaceEditedToken: replaceEditedToken,
      localResolveImageRef: _localResolveImageRef,
    };
  }
})();
