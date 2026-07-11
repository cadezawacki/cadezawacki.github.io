/* Whiteboard — free-draw sketch widget for Cade.txt.
 *
 * Draw with pen / highlighter / eraser on an ALWAYS-WHITE canvas (so sketches
 * read identically in both themes and as exported PNGs), then download the
 * result or insert it into the document through the core's embedded-image
 * pipeline: window.insertImageFile(file) compresses, content-addresses with a
 * hash, uploads for sync, and drops a "![img:<code>#<hash>]" token at the
 * cursor (see txt.html: insertImageFile / compressImage / _imgHash).
 *
 * Every stroke is recorded as vector data — {tool, color, w, pts:[[x,y],...]}
 * in canvas-logical coordinates — and the canvas is always redrawn in full
 * from that array. That single model powers undo (pop), clear (empty array),
 * and re-editing. On insert, the strokes JSON is saved to Cade.idbStore under
 * "drawstrokes:<hash>" (the content hash the core just minted for the PNG),
 * indexed by "drawstrokes:__index" (pruned to the 100 most recent).
 * window.__drawEditByHash(hash) reopens a saved drawing for further editing;
 * saving from an edit session replaces the old image token in the document.
 *
 * LIMITATION: stroke data is DEVICE-LOCAL (IndexedDB) — it does not sync.
 * Other devices that sync the document see only the flattened PNG; they can
 * draw over it only as a locked background layer, and only if the core
 * exposes window.resolveImageRef (as of this writing txt.html defines
 * resolveImageRef internally but does NOT put it on window), otherwise
 * __drawEditByHash reports "No editable stroke data on this device".
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
  // Hash-ref image tokens only (the core's legacy inline form uses ':').
  // Matches the core's format "![img:<code>#<hash>]" where code ∈ j/w/a and
  // hash is 32 lowercase hex chars (see IMG_TOKEN_RE + _imgHash in txt.html).
  var TOKEN_RE_SRC = '!\\[img:([a-z0-9]+)#([a-f0-9]+)\\]';
  // Fixed ink hexes — mid-dark and saturated so they read on the white canvas
  // (and therefore in both app themes), plus a black/white pair.
  var COLORS = ['#e03131', '#e8590c', '#f5a623', '#2f9e44', '#1971c2', '#9c36b5', '#111111', '#ffffff'];
  var WIDTHS = [2, 5, 10];                    // logical px (pen); hl/eraser are scaled up
  var HL_ALPHA = 0.35;                        // highlighter translucency
  var HL_SCALE = 2.2;                         // highlighter width multiplier
  var ERASER_SCALE = 2.6;                     // eraser width multiplier

  // Live session state; null when the panel is closed.
  // { panel, canvas, ctx, W, H, strokes, cur, drawingId, tool, color, width,
  //   editingHash, bg, ui:{...}, _key }
  var S = null;

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
  function drawStroke(ctx2, st) {
    var pts = st.pts;
    if (!pts || !pts.length) return;
    ctx2.save();
    ctx2.lineCap = 'round';
    ctx2.lineJoin = 'round';
    if (st.tool === 'hl') ctx2.globalAlpha = HL_ALPHA;
    // Eraser = white stroke: the canvas background is always white, so this is
    // both the visual eraser AND exactly what the exported PNG shows.
    ctx2.strokeStyle = (st.tool === 'eraser') ? '#ffffff' : st.color;
    ctx2.lineWidth = st.w;
    ctx2.beginPath();
    ctx2.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 1) ctx2.lineTo(pts[0][0] + 0.01, pts[0][1]); // dot (round cap)
    else for (var i = 1; i < pts.length; i++) ctx2.lineTo(pts[i][0], pts[i][1]);
    ctx2.stroke();
    ctx2.restore();
  }

  // Full scene paint: white background → locked bg layer (if any) → strokes.
  // Redrawing everything from the strokes array on every change is what makes
  // undo/clear/re-edit trivially correct (and highlighter alpha uniform).
  function paintScene(ctx2, sess) {
    ctx2.save();
    ctx2.globalAlpha = 1;
    ctx2.fillStyle = '#ffffff';
    ctx2.fillRect(0, 0, sess.W, sess.H);
    if (sess.bg) { try { ctx2.drawImage(sess.bg, 0, 0, sess.W, sess.H); } catch (e) {} }
    ctx2.restore();
    for (var i = 0; i < sess.strokes.length; i++) drawStroke(ctx2, sess.strokes[i]);
    if (sess.cur) drawStroke(ctx2, sess.cur);
  }

  function redraw() {
    if (!S || !S.ctx) return;
    paintScene(S.ctx, S);
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
  // deleted too so IndexedDB doesn't grow without bound.
  async function saveStrokes(hash, strokes, dims) {
    try {
      await Cade.idbStore.set(KEY_PREFIX + hash,
        JSON.stringify({ v: 1, w: dims.w, h: dims.h, strokes: strokes }));
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
  // Render the strokes (over the white bg / locked layer) to a PNG blob at
  // logical size (≤ 520×420, comfortably under the core's 800px re-compress cap).
  function exportBlob(sess) {
    return new Promise(function (resolve) {
      try {
        var c = document.createElement('canvas');
        c.width = sess.W; c.height = sess.H;
        var x = c.getContext('2d');
        paintScene(x, sess);
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

    var hash = null;
    if (sess.editingHash) {
      hash = await replaceEditedToken(file, sess.editingHash);
      if (hash === null) return; // insert failed — keep the panel open to retry
    } else {
      // Fresh insert at the user's cursor; the core compresses, hashes,
      // stores/uploads the bytes, inserts the token, and toasts.
      await window.insertImageFile(file);
      hash = findInsertedHashNearCursor();
    }
    // Persist the vector strokes under the NEW content hash so this exact
    // image can be re-edited later (device-local — see header LIMITATION).
    // hash is null when the core fell back to a legacy inline token; the image
    // is still in the doc, it just can't be re-edited.
    if (hash) {
      await saveStrokes(hash, strokes, dims);
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
  // opts: { strokes?, w?, h?, editingHash?, bg? (locked background Image) }
  function openSession(opts) {
    opts = opts || {};
    Cade.closeAllMenus();
    closePanel(); // rebuild fresh (re-edit may need different canvas dims)

    var panel = Cade.mkPanel(PANEL_ID, '✏️ Whiteboard', '');
    var body = panel.querySelector('.cade-panel-body');

    var sess = {
      panel: panel, canvas: null, ctx: null,
      W: 0, H: 0,
      strokes: Array.isArray(opts.strokes) ? opts.strokes : [],
      cur: null, drawingId: null,
      tool: 'pen', color: COLORS[6] /* black */, width: WIDTHS[1],
      editingHash: opts.editingHash || null,
      bg: opts.bg || null,
      ui: {},
    };

    // Canvas geometry: logical size ~ min(82vw, 520) × min(55vh, 420). A
    // re-edited drawing keeps its ORIGINAL logical size (so saved stroke
    // coordinates stay valid) and is CSS-scaled down to fit if needed —
    // pointer coords are mapped through getBoundingClientRect either way.
    var maxW = Math.max(120, Math.min(Math.round(window.innerWidth * 0.82), 520));
    var maxH = Math.max(120, Math.min(Math.round(window.innerHeight * 0.55), 420));
    sess.W = Math.round(opts.w > 0 ? opts.w : maxW);
    sess.H = Math.round(opts.h > 0 ? opts.h : maxH);
    var fit = Math.min(1, maxW / sess.W, maxH / sess.H);

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

    // --- toolbar row 2: widths + undo/clear + save/insert
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
    var undoBtn = el('button', 'draw-btn', '↩ Undo');
    undoBtn._baseClass = 'draw-btn';
    undoBtn.title = 'Undo last stroke';
    undoBtn.setAttribute('data-act', 'undo');
    undoBtn.addEventListener('click', undoStroke);
    row2.appendChild(undoBtn);
    var clearBtn = el('button', 'draw-btn', '✕ Clear');
    clearBtn._baseClass = 'draw-btn';
    clearBtn.title = 'Clear the canvas';
    clearBtn.setAttribute('data-act', 'clear');
    clearBtn.addEventListener('click', clearAll);
    row2.appendChild(clearBtn);
    row2.appendChild(el('span', 'draw-spacer'));
    var saveBtn = el('button', 'draw-btn', '⬇ PNG');
    saveBtn._baseClass = 'draw-btn';
    saveBtn.title = 'Download as PNG';
    saveBtn.setAttribute('data-act', 'save');
    saveBtn.addEventListener('click', doSavePng);
    row2.appendChild(saveBtn);
    var insertBtn = el('button', 'draw-btn draw-primary', sess.editingHash ? 'Update' : 'Insert');
    insertBtn._baseClass = 'draw-btn draw-primary';
    insertBtn.title = sess.editingHash
      ? 'Replace the original image in the document'
      : 'Insert into the document as an embedded image';
    insertBtn.setAttribute('data-act', 'insert');
    insertBtn.addEventListener('click', function () { doInsert(); });
    row2.appendChild(insertBtn);

    body.appendChild(row1);
    body.appendChild(row2);

    // --- edit-mode hint
    if (sess.editingHash) {
      var hint = el('div', 'draw-hint',
        sess.bg
          ? 'Drawing over a flattened image (strokes from another device aren’t editable) — Update replaces it in the doc.'
          : 'Editing an embedded drawing — Update replaces it in the doc.');
      body.appendChild(hint);
      sess.ui.hint = hint;
    }

    // --- canvas (always-white; devicePixelRatio backing store for crispness)
    var canvas = el('canvas', 'draw-canvas');
    var dpr = Math.max(1, window.devicePixelRatio || 1);
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
    sess.ui.insertBtn = insertBtn;
    setActive(toolBtns, toolBtns[0]);       // pen
    setActive(swatchBtns, swatchBtns[6]);   // black
    setActive(widthBtns, widthBtns[1]);     // medium
    redraw();
    return sess;
  }

  // Palette entry point — toggles like the other widgets.
  function open() {
    if (document.getElementById(PANEL_ID)) { closePanel(); return; }
    openSession({});
  }

  // ------------------------------------------------------------------ re-edit
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

  // Re-open a previously inserted drawing by its image-token hash.
  // Exposed on window so it can be wired to UI (or called from the console):
  //   await window.__drawEditByHash('3fa9…')
  window.__drawEditByHash = async function (hash) {
    hash = String(hash || '').toLowerCase().replace(/[^a-f0-9]/g, '');
    if (!hash) { Cade.showToast('Bad image hash', 'error', 2000); return false; }

    // 1) Preferred: this device still has the vector strokes.
    var rec = await getStrokesRecord(hash);
    if (rec) {
      openSession({ strokes: rec.strokes, w: rec.w, h: rec.h, editingHash: hash });
      return true;
    }

    // 2) Fallback: no local strokes (drawn on another device, or pruned).
    // If the core exposes resolveImageRef on window we can at least load the
    // flattened image as a LOCKED background layer to draw over. NOTE: current
    // txt.html keeps resolveImageRef internal (it is not on window), so today
    // this branch is dormant and we fall through to the toast.
    if (typeof window.resolveImageRef === 'function') {
      var ref = null;
      try { ref = await window.resolveImageRef('png', hash); } catch (e) {}
      if (ref && ref.url) {
        var img = await loadImageEl(ref.url);
        if (img) {
          var iw = img.naturalWidth || img.width || 520;
          var ih = img.naturalHeight || img.height || 420;
          openSession({ strokes: [], bg: img, w: iw, h: ih, editingHash: hash });
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
      findInsertedHashNearCursor: findInsertedHashNearCursor,
      saveStrokes: saveStrokes,
      replaceEditedToken: replaceEditedToken,
    };
  }
})();
