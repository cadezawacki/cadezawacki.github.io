/* Pros & Cons — a weighted decision helper.
 *
 * A decision is a question plus two lists (Pros / Cons) of items, each with
 * a weight 1–5 (tap a dot). Items can be added, edited in place, deleted,
 * reordered (↑ / ↓ or Alt+↑ / Alt+↓) and moved to the other side (⇄). Live
 * totals drive a verdict bar: pros score vs cons score as a percentage, with
 * a plain-language verdict (strong / leaning / toss-up).
 *
 * Several decisions are kept (switch from the dropdown), stored in Cade.store
 * under "cade-proscons" with hard caps on count, items, text length and the
 * total serialized size (oldest decisions are dropped first).
 *
 * IMPORT from the selection: "+ item" / "- item" lines, or bullet/plain
 * lines under "Pros:" / "Cons:" style headings (advantages, drawbacks, for,
 * against…), or a markdown table with Pros / Cons columns (our own export
 * round-trips). Optional weights: "(3)", "[3]", "(3/5)", "x3", "×3" or
 * stars "★★★". A leading "# heading" or first plain line becomes the title.
 *
 * INSERT as a markdown table (Pros | Weight | Cons | Weight + totals row and
 * a verdict line; the core renders it as a real table) or as two lists.
 *
 * Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('proscons.css');
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'proscons-panel';
  var STORE_KEY = 'cade-proscons';
  var PREFS_KEY = 'cade-proscons-prefs';
  var MAX_DECISIONS = 30;
  var MAX_ITEMS = 40;          // per side
  var MAX_TEXT = 200;
  var MAX_TITLE = 160;
  var MAX_BYTES = 150000;      // serialized cap; oldest decisions dropped beyond it
  var DEFAULT_W = 3;
  var SIDES = ['pros', 'cons'];

  var db = null;               // { v:1, cur, list: [{id,title,pros:[{t,w}],cons:[{t,w}],updated}] }
  var prefs = { fmt: 'table' };
  var S = null;                // { p, saveTimer }

  // ------------------------------------------------------------- persistence
  function clampW(w) { w = Math.round(+w); return w >= 1 && w <= 5 ? w : DEFAULT_W; }
  function cleanItem(it) {
    if (!it || typeof it.t !== 'string') return null;
    return { t: it.t.slice(0, MAX_TEXT), w: clampW(it.w) };
  }
  function cleanDecision(d) {
    if (!d || typeof d !== 'object') return null;
    var out = {
      id: typeof d.id === 'string' && d.id ? d.id.slice(0, 40) : newId(),
      title: typeof d.title === 'string' ? d.title.slice(0, MAX_TITLE) : '',
      pros: [], cons: [],
      updated: +d.updated || Date.now()
    };
    SIDES.forEach(function (s) {
      if (Array.isArray(d[s])) out[s] = d[s].map(cleanItem).filter(Boolean).slice(0, MAX_ITEMS);
    });
    return out;
  }
  function newId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function blankDecision() { return { id: newId(), title: '', pros: [], cons: [], updated: Date.now() }; }

  function loadDb() {
    var raw = null;
    try { raw = JSON.parse(Cade.store.get(STORE_KEY) || 'null'); } catch (e) {}
    var list = raw && Array.isArray(raw.list) ? raw.list.map(cleanDecision).filter(Boolean).slice(0, MAX_DECISIONS) : [];
    if (!list.length) list.push(blankDecision());
    db = { v: 1, cur: raw && typeof raw.cur === 'string' ? raw.cur : list[0].id, list: list };
    if (!findDecision(db.cur)) db.cur = list[0].id;
    try {
      var p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {};
      if (p.fmt === 'table' || p.fmt === 'lists') prefs.fmt = p.fmt;
    } catch (e) {}
  }
  function saveDb() {
    if (!db) return;
    // Enforce caps: count, then serialized size (drop the oldest non-current).
    var byAge = function () { return db.list.slice().sort(function (a, b) { return a.updated - b.updated; }); };
    while (db.list.length > MAX_DECISIONS) dropOldest(byAge());
    var json = JSON.stringify(db);
    while (json.length > MAX_BYTES && db.list.length > 1) { dropOldest(byAge()); json = JSON.stringify(db); }
    try { Cade.store.set(STORE_KEY, json); } catch (e) { Cade.showToast('Couldn\'t save decisions (storage full?)', 'error', 2500); }
  }
  function dropOldest(sorted) {
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].id !== db.cur) { db.list.splice(db.list.indexOf(sorted[i]), 1); return; }
    }
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }
  // Debounced save for typing; structural edits save immediately.
  function touch(now) {
    var d = cur();
    if (d) d.updated = Date.now();
    if (!S) { saveDb(); return; }
    clearTimeout(S.saveTimer);
    if (now) saveDb();
    else S.saveTimer = setTimeout(saveDb, 400);
  }
  function findDecision(id) {
    for (var i = 0; i < db.list.length; i++) if (db.list[i].id === id) return db.list[i];
    return null;
  }
  function cur() { return findDecision(db.cur) || db.list[0]; }

  // ------------------------------------------------------------------ scoring
  function score(d) {
    var P = 0, C = 0;
    d.pros.forEach(function (it) { P += it.w; });
    d.cons.forEach(function (it) { C += it.w; });
    var T = P + C, pct = T ? Math.round(P / T * 100) : 50;
    var verdict, tone;
    if (!T) { verdict = 'Add pros and cons to see a verdict'; tone = 'none'; }
    else if (Math.abs(pct - 50) <= 5) { verdict = 'Toss-up — too close to call'; tone = 'even'; }
    else if (pct > 50) { verdict = pct >= 70 ? 'Strong yes — pros clearly win' : 'Leaning yes'; tone = 'yes'; }
    else { verdict = pct <= 30 ? 'Strong no — cons clearly win' : 'Leaning no'; tone = 'no'; }
    return { P: P, C: C, T: T, pct: pct, verdict: verdict, tone: tone };
  }

  // ------------------------------------------------------------------ parsing
  var PRO_HEADS = ['pro', 'pros', 'advantage', 'advantages', 'benefit', 'benefits', 'upside', 'upsides', 'positive', 'positives',
    'for', 'reasons for', 'arguments for', 'plus', 'pluses', 'plusses', 'the good', 'strengths'];
  var CON_HEADS = ['con', 'cons', 'disadvantage', 'disadvantages', 'drawback', 'drawbacks', 'downside', 'downsides', 'negative', 'negatives',
    'against', 'reasons against', 'arguments against', 'minus', 'minuses', 'the bad', 'weaknesses', 'risks'];
  var WEIGHT_RE = /\s*(?:[([{]\s*(?:w(?:eight)?\s*[:=]?\s*)?([1-5])(?:\s*\/\s*5)?\s*[)\]}]|[x×]\s*([1-5]))\s*$/i;
  var STARS_RE = /\s*([★⭐]{1,5})\s*$/;
  var BULLET_RE = /^\s*(?:[-*+•–—−]|\d{1,3}[.)])\s+/;

  // "Higher salary (5)" → {t:'Higher salary', w:5}
  function splitWeight(text) {
    var t = String(text).replace(/^\s*\[[ xX]\]\s+/, '').trim(), w = DEFAULT_W, m;
    if ((m = WEIGHT_RE.exec(t))) { w = +(m[1] || m[2]); t = t.slice(0, m.index).trim(); }
    else if ((m = STARS_RE.exec(t))) { w = m[1].length; t = t.slice(0, m.index).trim(); }
    t = t.replace(/^\*\*(.+)\*\*$/, '$1').replace(/[:\s]+$/, '').trim();
    return { t: t.slice(0, MAX_TEXT), w: clampW(w) };
  }
  // Is this line a Pros / Cons heading? → 'pros' | 'cons' | null
  function headingSide(line) {
    var s = line.trim();
    if (!s || s.length > 60) return null;
    s = s.replace(/^#{1,6}\s*/, '').replace(/^[*_]+|[*_]+$/g, '')
      .replace(/\(\s*\d+\s*\)\s*$/, '').replace(/[*_]+/g, '').trim()
      .replace(/:\s*$/, '').trim()
      .replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z]+$/, '').toLowerCase();
    if (PRO_HEADS.indexOf(s) >= 0) return 'pros';
    if (CON_HEADS.indexOf(s) >= 0) return 'cons';
    return null;
  }
  // Split a markdown table row into cells ("\\|" is an escaped pipe). No
  // regex lookbehind — it would be a parse error on older Safari.
  function splitRow(line) {
    var s = line.trim(), cells = [], cell = '';
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.slice(-1) === '|' && s.slice(-2) !== '\\|') s = s.slice(0, -1);
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '\\' && s.charAt(i + 1) === '|') { cell += '|'; i++; continue; }
      if (ch === '|') { cells.push(cell.trim()); cell = ''; continue; }
      cell += ch;
    }
    cells.push(cell.trim());
    return cells;
  }

  function parseDecision(text) {
    var lines = String(text).split(/\r?\n/);
    var d = blankDecision(), side = null, sawBullet = false, tbl = null;
    var push = function (s, raw) {
      var it = splitWeight(raw);
      if (it.t && !/^\(?none\)?$/i.test(it.t) && d[s].length < MAX_ITEMS) d[s].push(it);
    };
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], tr = line.trim();
      if (!tr) continue;
      if (/^\[table\b[^\]]*\]$/i.test(tr)) continue;
      // Markdown table with Pros/Cons columns (header detection, then rows).
      if (tr.charAt(0) === '|') {
        var cells = splitRow(tr);
        if (/^\|?\s*:?-{2,}/.test(tr)) continue; // separator row
        if (!tbl) {
          var pc = -1, cc = -1;
          cells.forEach(function (c, k) {
            var h = headingSide(c);
            if (h === 'pros' && pc < 0) pc = k;
            if (h === 'cons' && cc < 0) cc = k;
          });
          if (pc >= 0 || cc >= 0) {
            var wcol = function (k) { return k >= 0 && cells[k + 1] && /^(weight|w|score|pts|points|\(?1-5\)?)$/i.test(cells[k + 1].replace(/[*_]/g, '')) ? k + 1 : -1; };
            tbl = { pc: pc, cc: cc, pw: wcol(pc), cw: wcol(cc) };
          }
          continue;
        }
        [['pros', tbl.pc, tbl.pw], ['cons', tbl.cc, tbl.cw]].forEach(function (sp) {
          if (sp[1] < 0) return;
          var t = (cells[sp[1]] || '').trim();
          if (!t || /^\**\s*total\s*\**$/i.test(t)) return;
          var wv = sp[2] >= 0 ? (cells[sp[2]] || '').replace(/[*_\s]/g, '') : '';
          push(sp[0], /^[1-5]$/.test(wv) ? t + ' (' + wv + ')' : t);
        });
        continue;
      }
      tbl = null;
      var isBullet = BULLET_RE.test(line);
      // Headings are never bullets ("- Good" is an item, "Pros:" a heading).
      var h = (isBullet || /^[+\-\u2013\u2014\u2212]/.test(tr)) ? null : headingSide(tr);
      if (h) { side = h; sawBullet = false; continue; }
      if (/^\**\s*(verdict|total|totals|score|result)\b/i.test(tr)) { side = null; continue; }
      if (side) {
        if (isBullet) { push(side, line.replace(BULLET_RE, '')); sawBullet = true; continue; }
        if (!sawBullet && !/^#/.test(tr)) { push(side, tr); continue; }
        side = null; // a plain line after a bulleted section ends it
      }
      var m = /^\s*([+\-–—−])\s*(.+)$/.exec(line);
      if (m && !/^-{2,}/.test(tr)) { push(m[1] === '+' ? 'pros' : 'cons', m[2]); continue; }
      if (!d.title && !d.pros.length && !d.cons.length) {
        d.title = tr.replace(/^#{1,6}\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1').trim().slice(0, MAX_TITLE);
      }
    }
    if (/^pros\s*(&|and)\s*cons$/i.test(d.title)) d.title = ''; // our export's default heading
    return d;
  }

  // ------------------------------------------------------------------ export
  function cellEsc(s) { return String(s).replace(/\|/g, '\\|'); }
  function verdictLine(d) {
    var sc = score(d);
    if (!sc.T) return '**Verdict:** no items yet';
    return '**Verdict:** ' + sc.pct + '% in favour — ' + sc.verdict.replace(/ — .*$/, '').toLowerCase() +
      ' (pros ' + sc.P + ' vs cons ' + sc.C + ')';
  }
  function toTable(d, forDoc) {
    var sc = score(d), n = Math.max(d.pros.length, d.cons.length, 1), out = [];
    out.push('### ' + (d.title.trim() || 'Pros & Cons'), '');
    if (forDoc) out.push('[table: total=on]'); // core table directive: pin + style the totals row
    out.push('| Pros | Weight | Cons | Weight |', '| --- | :---: | --- | :---: |');
    for (var i = 0; i < n; i++) {
      var p = d.pros[i], c = d.cons[i];
      out.push('| ' + (p ? cellEsc(p.t) : '') + ' | ' + (p ? p.w : '') + ' | ' + (c ? cellEsc(c.t) : '') + ' | ' + (c ? c.w : '') + ' |');
    }
    out.push('| **Total** | **' + sc.P + '** | **Total** | **' + sc.C + '** |', '', verdictLine(d));
    return out.join('\n');
  }
  function toLists(d) {
    var sc = score(d), out = ['### ' + (d.title.trim() || 'Pros & Cons'), ''];
    out.push('**Pros** (' + sc.P + ')');
    if (d.pros.length) d.pros.forEach(function (it) { out.push('- ' + it.t + ' (' + it.w + ')'); });
    else out.push('- (none)');
    out.push('', '**Cons** (' + sc.C + ')');
    if (d.cons.length) d.cons.forEach(function (it) { out.push('- ' + it.t + ' (' + it.w + ')'); });
    else out.push('- (none)');
    out.push('', verdictLine(d));
    return out.join('\n');
  }

  // ------------------------------------------------------------------ editor
  function writableEditor() {
    var ed = Cade.editor;
    if (!ed) return null;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode — editing is locked', 'error', 2000); return null; }
    return ed;
  }
  // Insert a block as its own paragraph (cursor mid-line → after that line).
  function insertBlock(text) {
    var ed = writableEditor();
    if (!ed) return false;
    var st = ed.state, sel = st.selection.main, from = sel.from, to = sel.to;
    var line = st.doc.lineAt(from);
    if (sel.empty && from > line.from && from < line.to) from = to = line.to;
    var pre = '';
    if (st.doc.sliceString(line.from, from).trim()) pre = '\n\n';
    else if (from === line.from && line.number > 1 && st.doc.line(line.number - 1).text.trim()) pre = '\n';
    var after = st.doc.sliceString(to, st.doc.lineAt(to).to);
    var ins = pre + text + (after.trim() ? '\n\n' : '\n');
    ed.dispatch({ changes: { from: from, to: to, insert: ins }, selection: { anchor: from + ins.length }, userEvent: 'input', scrollIntoView: true });
    return true;
  }
  function copyText(text, label) {
    var done = function () { Cade.showToast('Copied ' + (label || ''), 'success', 1300); };
    var fail = function () { Cade.showToast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      ta.remove();
    }
  }

  // --------------------------------------------------------------- rendering
  function panel() { return document.getElementById(PANEL_ID); }

  function dots(w) {
    var h = '';
    for (var k = 1; k <= 5; k++) {
      h += '<button class="pc-dot' + (k <= w ? ' on' : '') + '" data-act="w" data-w="' + k + '" title="Weight ' + k + '" aria-label="Weight ' + k +
        '" aria-pressed="' + (k === w) + '"></button>';
    }
    return h;
  }
  function itemHtml(side, it, i, n) {
    return '<li class="pc-item" data-side="' + side + '" data-i="' + i + '">' +
      '<input class="pc-text" value="' + esc(it.t) + '" maxlength="' + MAX_TEXT + '" aria-label="' + (side === 'pros' ? 'Pro' : 'Con') + ' ' + (i + 1) + '">' +
      '<div class="pc-item-bar">' +
        '<span class="pc-dots" role="group" aria-label="Weight">' + dots(it.w) + '<span class="pc-wnum">' + it.w + '</span></span>' +
        '<span class="pc-ops">' +
          '<button class="pc-op" data-act="up" title="Move up (Alt+↑)"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button class="pc-op" data-act="down" title="Move down (Alt+↓)"' + (i === n - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button class="pc-op" data-act="swap" title="Move to ' + (side === 'pros' ? 'cons' : 'pros') + '">⇄</button>' +
          '<button class="pc-op del" data-act="del" title="Delete">✕</button>' +
        '</span>' +
      '</div></li>';
  }
  function renderSelect() {
    var sel = S.p.querySelector('.pc-select');
    var list = db.list.slice().sort(function (a, b) { return b.updated - a.updated; });
    sel.innerHTML = list.map(function (d) {
      var label = (d.title.trim() || 'Untitled decision');
      if (label.length > 48) label = label.slice(0, 47) + '…';
      return '<option value="' + esc(d.id) + '"' + (d.id === db.cur ? ' selected' : '') + '>' + esc(label) + '</option>';
    }).join('');
  }
  function renderSide(side) {
    var d = cur(), ul = S.p.querySelector('.pc-col[data-side="' + side + '"] .pc-list');
    var arr = d[side];
    ul.innerHTML = arr.length ? arr.map(function (it, i) { return itemHtml(side, it, i, arr.length); }).join('')
      : '<li class="pc-none">No ' + side + ' yet</li>';
    var add = S.p.querySelector('.pc-col[data-side="' + side + '"] .pc-add');
    add.disabled = arr.length >= MAX_ITEMS;
  }
  function renderScore() {
    var d = cur(), sc = score(d), p = S.p;
    p.querySelector('.pc-col[data-side="pros"] .pc-sum').textContent = sc.P;
    p.querySelector('.pc-col[data-side="cons"] .pc-sum').textContent = sc.C;
    var bar = p.querySelector('.pc-bar');
    bar.classList.toggle('empty', !sc.T);
    p.querySelector('.pc-bar-pro').style.width = (sc.T ? sc.pct : 50) + '%';
    p.querySelector('.pc-bar-pro').textContent = sc.T && sc.pct >= 12 ? sc.pct + '%' : '';
    p.querySelector('.pc-bar-con').textContent = sc.T && 100 - sc.pct >= 12 ? (100 - sc.pct) + '%' : '';
    bar.setAttribute('aria-label', sc.T ? 'Pros ' + sc.pct + '%, cons ' + (100 - sc.pct) + '%' : 'No items');
    var v = p.querySelector('.pc-vtext');
    v.textContent = sc.T ? sc.verdict + ' · pros ' + sc.P + ' vs cons ' + sc.C : sc.verdict;
    v.setAttribute('data-tone', sc.tone);
  }
  function renderFmt() {
    S.p.querySelectorAll('.pc-fmt').forEach(function (b) {
      var on = b.getAttribute('data-fmt') === prefs.fmt;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function renderAll() {
    var d = cur();
    var t = S.p.querySelector('.pc-title');
    if (t.value !== d.title) t.value = d.title;
    renderSelect();
    renderSide('pros');
    renderSide('cons');
    renderScore();
    renderFmt();
  }
  function focusItem(side, i, sel) {
    var el = S.p.querySelector('.pc-item[data-side="' + side + '"][data-i="' + i + '"] ' + (sel || '.pc-text'));
    if (el && !el.disabled) { try { el.focus({ preventScroll: false }); } catch (e) { el.focus(); } }
  }

  // ----------------------------------------------------------------- actions
  function addItem(side, raw) {
    var d = cur();
    if (d[side].length >= MAX_ITEMS) { Cade.showToast('That list is full (' + MAX_ITEMS + ' items)', 'error', 1800); return false; }
    var it = splitWeight(raw);
    if (!it.t) return false;
    d[side].push(it);
    touch(true);
    renderSide(side); renderScore();
    return true;
  }
  function moveItem(side, i, dir) {
    var arr = cur()[side], j = i + dir;
    if (j < 0 || j >= arr.length) return;
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    touch(true);
    renderSide(side);
    return j;
  }
  function swapSide(side, i) {
    var d = cur(), other = side === 'pros' ? 'cons' : 'pros';
    if (d[other].length >= MAX_ITEMS) { Cade.showToast('The other list is full', 'error', 1800); return; }
    d[other].push(d[side].splice(i, 1)[0]);
    touch(true);
    renderSide('pros'); renderSide('cons'); renderScore();
  }
  function deleteItem(side, i) {
    cur()[side].splice(i, 1);
    touch(true);
    renderSide(side); renderScore();
  }
  function newDecision(d) {
    d = d || blankDecision();
    db.list.unshift(d);
    db.cur = d.id;
    touch(true);
    renderAll();
  }
  function deleteDecision() {
    var d = cur();
    var empty = !d.title.trim() && !d.pros.length && !d.cons.length;
    if (!empty && !window.confirm('Delete “' + (d.title.trim() || 'Untitled decision') + '”?')) return;
    db.list.splice(db.list.indexOf(d), 1);
    if (!db.list.length) db.list.push(blankDecision());
    db.cur = db.list.slice().sort(function (a, b) { return b.updated - a.updated; })[0].id;
    saveDb();
    renderAll();
  }
  function importSelection() {
    var ed = Cade.editor, text = '';
    try {
      var sel = ed.state.selection.main;
      if (!sel.empty) text = ed.state.sliceDoc(sel.from, Math.min(sel.to, sel.from + 50000));
    } catch (e) {}
    if (!text.trim()) {
      Cade.showToast('Select lines like “+ cheaper rent (4)” and “- longer commute”, or Pros:/Cons: lists, first', 'info', 3500);
      return;
    }
    var d = parseDecision(text);
    if (!d.pros.length && !d.cons.length) {
      Cade.showToast('No pros or cons found — start lines with + / - or put them under Pros: / Cons:', 'error', 3200);
      return;
    }
    newDecision(d);
    Cade.showToast('Imported ' + d.pros.length + ' pros and ' + d.cons.length + ' cons', 'success', 1800);
  }
  function exportText(forDoc) { return prefs.fmt === 'lists' ? toLists(cur()) : toTable(cur(), forDoc); }

  function close() {
    var p = panel();
    if (p) { p.remove(); if (p._onClose) p._onClose(); }
  }

  function onClick(e) {
    var b = e.target.closest && e.target.closest('button');
    if (!b || !S || b.disabled) return;
    var li = b.closest('.pc-item');
    var side = li ? li.getAttribute('data-side') : null, i = li ? +li.getAttribute('data-i') : -1;
    var act = b.getAttribute('data-act');
    if (b.classList.contains('pc-fmt')) { prefs.fmt = b.getAttribute('data-fmt'); savePrefs(); renderFmt(); return; }
    switch (act) {
      case 'w':
        var it = cur()[side][i];
        if (!it) return;
        it.w = clampW(b.getAttribute('data-w'));
        touch(true);
        li.querySelector('.pc-dots').innerHTML = dots(it.w) + '<span class="pc-wnum">' + it.w + '</span>';
        renderScore();
        var nb = li.querySelector('.pc-dot[data-w="' + it.w + '"]');
        if (nb && document.activeElement === document.body) nb.focus();
        break;
      case 'up': case 'down':
        var j = moveItem(side, i, act === 'up' ? -1 : 1);
        if (j != null) focusItem(side, j, '.pc-op[data-act="' + act + '"]');
        break;
      case 'swap': swapSide(side, i); break;
      case 'del': deleteItem(side, i); break;
      case 'add':
        var col = b.closest('.pc-col'), inp = col.querySelector('.pc-add');
        if (addItem(col.getAttribute('data-side'), inp.value)) inp.value = '';
        inp.focus();
        break;
      case 'new': newDecision(); S.p.querySelector('.pc-title').focus(); break;
      case 'import': importSelection(); break;
      case 'delete': deleteDecision(); break;
      case 'insert':
        if (insertBlock(exportText(true))) Cade.showToast('Inserted as ' + (prefs.fmt === 'lists' ? 'lists' : 'a table'), 'success', 1300);
        break;
      case 'copy': copyText(exportText(false), prefs.fmt === 'lists' ? 'lists' : 'table'); break;
    }
  }

  function onInput(e) {
    var t = e.target;
    if (!S || !t.classList) return;
    if (t.classList.contains('pc-title')) {
      cur().title = t.value.slice(0, MAX_TITLE);
      touch(false);
      clearTimeout(S.selTimer);
      S.selTimer = setTimeout(function () { if (S) renderSelect(); }, 500);
    } else if (t.classList.contains('pc-text')) {
      var li = t.closest('.pc-item'), it = cur()[li.getAttribute('data-side')][+li.getAttribute('data-i')];
      if (it) { it.t = t.value.slice(0, MAX_TEXT); touch(false); }
    }
  }
  // An item whose text was cleared is removed once the field loses focus.
  function onChange(e) {
    var t = e.target;
    if (!S || !t.classList) return;
    if (t.classList.contains('pc-select')) { db.cur = t.value; saveDb(); renderAll(); return; }
    if (t.classList.contains('pc-text') && !t.value.trim()) {
      // Deferred, and by identity not index: a click on another row's button
      // (or this row's ✕) that caused the blur must land first, untouched.
      var li = t.closest('.pc-item'), side = li.getAttribute('data-side');
      var it = cur()[side][+li.getAttribute('data-i')];
      setTimeout(function () {
        if (!S || !it) return;
        var arr = cur()[side], k = arr.indexOf(it);
        if (k < 0 || it.t.trim()) return;
        // Keep focus where the user moved it (re-render rebuilds the rows).
        var a = document.activeElement, ali = a && a.closest && a.closest('.pc-item');
        var fSide = ali && ali.getAttribute('data-side'), fI = ali ? +ali.getAttribute('data-i') : -1;
        var fSel = a && a.classList && a.classList.contains('pc-text') ? '.pc-text' : null;
        deleteItem(side, k);
        if (fSel && fSide) focusItem(fSide, fSide === side && fI > k ? fI - 1 : fI, fSel);
      }, 150);
    }
  }
  function onKey(e) {
    if (!S) return;
    var t = e.target;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (t.classList && t.classList.contains('pc-add') && e.key === 'Enter') {
      e.preventDefault();
      var side = t.closest('.pc-col').getAttribute('data-side');
      if (addItem(side, t.value)) t.value = '';
    } else if (t.classList && t.classList.contains('pc-text')) {
      var li = t.closest('.pc-item'), side2 = li.getAttribute('data-side'), i = +li.getAttribute('data-i');
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        var j = moveItem(side2, i, e.key === 'ArrowUp' ? -1 : 1);
        if (j != null) focusItem(side2, j);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        S.p.querySelector('.pc-col[data-side="' + side2 + '"] .pc-add').focus();
      } else if (e.altKey && /^[1-5]$/.test(e.key)) {
        e.preventDefault();
        var it = cur()[side2][i];
        if (it) { it.w = +e.key; touch(true); li.querySelector('.pc-dots').innerHTML = dots(it.w) + '<span class="pc-wnum">' + it.w + '</span>'; renderScore(); }
      }
    } else if (t.classList && t.classList.contains('pc-title') && e.key === 'Enter') {
      e.preventDefault();
      S.p.querySelector('.pc-col[data-side="pros"] .pc-add').focus();
    }
    e.stopPropagation(); // keep editor/global shortcuts out of the panel
  }

  function colHtml(side) {
    var pro = side === 'pros';
    return '<div class="pc-col" data-side="' + side + '">' +
      '<div class="pc-col-h"><span>' + (pro ? '👍 Pros' : '👎 Cons') + '</span><span class="pc-sum" title="Total weight">0</span></div>' +
      '<ul class="pc-list"></ul>' +
      '<div class="pc-addrow"><input class="pc-add" placeholder="Add a ' + (pro ? 'pro' : 'con') + '… (Enter)" maxlength="' + (MAX_TEXT + 12) +
        '" aria-label="Add a ' + (pro ? 'pro' : 'con') + '" enterkeyhint="done">' +
        '<button class="pc-op addbtn" data-act="add" title="Add" aria-label="Add">＋</button></div>' +
    '</div>';
  }

  function open() {
    Cade.closeAllMenus();
    if (panel()) { close(); return; }
    loadDb();
    var p = Cade.mkPanel(PANEL_ID, '⚖ Pros & Cons',
      '<div class="pc-top">' +
        '<select class="pc-select" aria-label="Saved decisions"></select>' +
        '<button class="pc-btn" data-act="new" title="New decision">＋ New</button>' +
        '<button class="pc-btn" data-act="import" title="Import “+ / -” lines or Pros:/Cons: lists from the selection">⇣ Import</button>' +
        '<button class="pc-btn danger" data-act="delete" title="Delete this decision" aria-label="Delete this decision">🗑</button>' +
      '</div>' +
      '<input class="pc-title" placeholder="What are you deciding? e.g. Should I take the new job?" maxlength="' + MAX_TITLE + '" aria-label="Decision">' +
      '<div class="pc-verdict">' +
        '<div class="pc-bar" role="img"><div class="pc-bar-pro"></div><div class="pc-bar-con"></div></div>' +
        '<div class="pc-vtext"></div>' +
      '</div>' +
      '<div class="pc-cols">' + colHtml('pros') + colHtml('cons') + '</div>' +
      '<div class="pc-foot">' +
        '<span class="pc-fmts"><span>Insert as</span>' +
          '<button class="pc-fmt" data-fmt="table">Table</button>' +
          '<button class="pc-fmt" data-fmt="lists">Lists</button>' +
        '</span>' +
        '<span class="pc-acts">' +
          '<button class="pc-btn primary" data-act="insert" title="Insert into the document">⤓ Insert</button>' +
          '<button class="pc-btn" data-act="copy" title="Copy as markdown">⧉ Copy</button>' +
        '</span>' +
      '</div>');
    S = { p: p, saveTimer: null, selTimer: null };
    p._onClose = function () {
      if (!S) return;
      clearTimeout(S.saveTimer); clearTimeout(S.selTimer);
      saveDb(); // flush pending typing
      S = null;
    };
    p.addEventListener('click', onClick);
    p.addEventListener('input', onInput);
    p.addEventListener('change', onChange);
    p.addEventListener('keydown', onKey);
    renderAll();
    var d = cur();
    if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) {
      setTimeout(function () {
        var el = p.querySelector(d.title ? '.pc-col[data-side="pros"] .pc-add' : '.pc-title');
        if (el) el.focus();
      }, 0);
    }
  }

  Cade.registerWidget({
    name: 'Pros & Cons',
    description: 'Weigh a decision: weighted pros vs cons, live verdict, saved decisions; import + / - lines, insert as a table',
    icon: '⚖',
    tags: 'pros,cons,pros and cons,decision,decide,choice,choose,compare,weigh,weighted,list,verdict,should i,dilemma,matrix,table,advantages,disadvantages',
    open: open,
    _t: { parse: parseDecision, table: toTable, lists: toLists, score: score }  // test hooks
  });
})();
