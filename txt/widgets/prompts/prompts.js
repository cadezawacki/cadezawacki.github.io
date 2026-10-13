/* Writing Prompts & Word of the Day.
 *
 * WORD OF THE DAY: deterministic by local calendar date — the day number
 * indexes a FIXED seeded shuffle of the bundled list, so every device shows
 * the same word on the same day and the list cycles without repeats. ‹ / ›
 * step through days (← / → keys); Insert / Copy the entry.
 *
 * PROMPTS: 340 prompts in 9 categories. Category chips filter (multi-select;
 * none = all), 🎲 Another picks at random while avoiding recent repeats, ↶
 * steps back. ☆ saves favourites (Cade.store, capped). Insert writes the
 * prompt as a quote / heading / plain line on its own paragraph; Start
 * sprint inserts it plus a blank line, closes the panel and puts the cursor
 * there, ready to write.
 *
 * DATA: prompts-data.js is loaded on first open (never at startup), resolved
 * with Cade.asset at module load. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('prompts.css');
  var DATA_URL = Cade.asset('prompts-data.js'); // resolve now, while the loader context is ours
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'prompts-panel';
  var PREFS_KEY = 'cade-prompts-prefs';
  var FAVS_KEY = 'cade-prompts-favs';
  var MAX_FAVS = 150;
  var RECENT_AVOID = 40;   // don't repeat any of the last N prompts
  var HISTORY_MAX = 50;
  var DAY_MS = 86400000;
  var SEED = 0x5eed1e;     // fixed: changing it reshuffles everyone's calendar

  var data = null;         // { words: [{w,pos,def,ex}], cats, prompts: {cat: [..]}, order: [] }
  var loading = null;
  var prefs = { tab: 'word', cats: [], style: 'quote', cur: null };
  var S = null;            // live panel state: { p, dayOff, hist: [], recent: [] }

  // ------------------------------------------------------------- persistence
  function readJSON(k, d) {
    try { var v = JSON.parse(Cade.store.get(k) || 'null'); return v == null ? d : v; } catch (e) { return d; }
  }
  function writeJSON(k, v) { try { Cade.store.set(k, JSON.stringify(v)); } catch (e) {} }
  function loadPrefs() {
    var p = readJSON(PREFS_KEY, {}) || {};
    if (p.tab === 'word' || p.tab === 'prompt' || p.tab === 'favs') prefs.tab = p.tab;
    if (Array.isArray(p.cats)) prefs.cats = p.cats.filter(function (c) { return typeof c === 'string'; }).slice(0, 20);
    if (p.style === 'quote' || p.style === 'heading' || p.style === 'plain') prefs.style = p.style;
    if (p.cur && typeof p.cur.c === 'string' && p.cur.i >= 0) prefs.cur = { c: p.cur.c, i: p.cur.i | 0 };
  }
  function savePrefs() { writeJSON(PREFS_KEY, prefs); }
  function favs() {
    var a = readJSON(FAVS_KEY, []);
    return Array.isArray(a) ? a.filter(function (f) { return f && typeof f.t === 'string'; }) : [];
  }
  function isFav(t) { return favs().some(function (f) { return f.t === t; }); }
  function toggleFav(t, c) {
    var a = favs(), had = false;
    a = a.filter(function (f) { if (f.t === t) { had = true; return false; } return true; });
    if (!had) a.unshift({ t: t, c: c || '' });
    writeJSON(FAVS_KEY, a.slice(0, MAX_FAVS));
    Cade.showToast(had ? 'Removed from favourites' : 'Saved to favourites', 'success', 1100);
    return !had;
  }

  // -------------------------------------------------------------------- data
  // Small deterministic PRNG (mulberry32) for the word-calendar shuffle.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function parse(d) {
    var words = [];
    (d.words || []).forEach(function (line) {
      var f = String(line).split('|');
      if (f.length >= 4) words.push({ w: f[0], pos: f[1], def: f[2], ex: f.slice(3).join('|') });
    });
    var order = [], i;
    for (i = 0; i < words.length; i++) order.push(i);
    var rnd = mulberry32(SEED);
    for (i = order.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1)), t = order[i];
      order[i] = order[j]; order[j] = t;
    }
    var cats = (d.cats || []).filter(function (c) { return d.prompts && Array.isArray(d.prompts[c.id]); });
    data = { words: words, order: order, cats: cats, prompts: d.prompts || {} };
  }
  function load() {
    if (data) return Promise.resolve();
    if (window.__cadePromptsData) { parse(window.__cadePromptsData); return Promise.resolve(); }
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = DATA_URL;
      s.onload = function () {
        if (window.__cadePromptsData) { parse(window.__cadePromptsData); resolve(); }
        else { loading = null; reject(new Error('no data')); }
      };
      s.onerror = function () { loading = null; s.remove(); reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  // Local calendar day → integer day number (DST-proof: built from Y/M/D).
  function dayNumber(d) { return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS); }
  function dateForOffset(off) { var d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + off); return d; }
  function wordFor(off) {
    var n = data.words.length;
    if (!n) return null;
    var day = dayNumber(dateForOffset(off));
    return data.words[data.order[((day % n) + n) % n]];
  }
  function catById(id) {
    for (var i = 0; i < data.cats.length; i++) if (data.cats[i].id === id) return data.cats[i];
    return null;
  }
  function promptAt(ref) {
    if (!ref || !data.prompts[ref.c]) return null;
    var t = data.prompts[ref.c][ref.i];
    return t ? { c: ref.c, i: ref.i, t: t } : null;
  }
  function activeCats() {
    var sel = prefs.cats.filter(function (c) { return !!catById(c); });
    return sel.length ? sel : data.cats.map(function (c) { return c.id; });
  }
  function randomPrompt() {
    var pool = [];
    activeCats().forEach(function (c) {
      for (var i = 0; i < data.prompts[c].length; i++) pool.push({ c: c, i: i });
    });
    if (!pool.length) return null;
    var recent = S ? S.recent : [];
    var fresh = pool.filter(function (r) { return recent.indexOf(r.c + ':' + r.i) < 0; });
    var from = fresh.length ? fresh : pool;
    var pick = from[Math.floor(Math.random() * from.length)];
    if (S) {
      S.recent.push(pick.c + ':' + pick.i);
      var cap = Math.min(RECENT_AVOID, Math.floor(pool.length / 2));
      while (S.recent.length > cap) S.recent.shift();
    }
    return pick;
  }

  // ------------------------------------------------------------------ editor
  function writableEditor() {
    var ed = Cade.editor;
    if (!ed) return null;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode — editing is locked', 'error', 2000); return null; }
    return ed;
  }
  // Insert a block on its own paragraph. A collapsed cursor inside a line
  // jumps to that line's end first (never splits a sentence); a selection is
  // replaced. Returns the editor or null.
  function insertBlock(text, blankAfter) {
    var ed = writableEditor();
    if (!ed) return null;
    var st = ed.state, sel = st.selection.main, from = sel.from, to = sel.to;
    var line = st.doc.lineAt(from);
    if (sel.empty && from > line.from && from < line.to) { from = to = line.to; }
    var before = st.doc.sliceString(line.from, from);
    var pre = '';
    if (before.trim()) pre = '\n\n';
    else if (from === line.from && line.number > 1 && st.doc.line(line.number - 1).text.trim()) pre = '\n';
    // Text right after the insertion point gets pushed onto its own paragraph.
    var after = st.doc.sliceString(to, st.doc.lineAt(to).to);
    var post = (blankAfter || after.trim()) ? '\n\n' : '\n';
    var ins = pre + text + post, caret = from + ins.length;
    // Sprint into existing text: leave an empty line to type on, between
    // the prompt and whatever follows.
    if (blankAfter && after.trim()) { ins += '\n'; caret = from + pre.length + text.length + 2; }
    ed.dispatch({
      changes: { from: from, to: to, insert: ins },
      selection: { anchor: caret },
      userEvent: 'input', scrollIntoView: true
    });
    return ed;
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
  function wordMarkdown(w) {
    return '**' + w.w + '** *(' + w.pos + ')* — ' + w.def + '\n> ' + w.ex;
  }
  function wordPlain(w) { return w.w + ' (' + w.pos + ') — ' + w.def + '\n“' + w.ex + '”'; }
  function promptLine(t) {
    if (prefs.style === 'heading') return '## ' + t;
    if (prefs.style === 'plain') return t;
    return '> **Prompt:** ' + t;
  }

  // ---------------------------------------------------------------- rendering
  function panel() { return document.getElementById(PANEL_ID); }

  function fmtDate(off) {
    var d = dateForOffset(off), s;
    try { s = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: off > 300 || off < -300 ? 'numeric' : undefined }); }
    catch (e) { s = d.toDateString(); }
    var rel = off === 0 ? 'Today' : off === -1 ? 'Yesterday' : off === 1 ? 'Tomorrow' : '';
    return rel ? rel + ' · ' + s : s;
  }

  function renderTabs() {
    var p = S.p;
    p.querySelectorAll('.pr-tab').forEach(function (b) {
      var on = b.getAttribute('data-tab') === prefs.tab;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    p.querySelector('.pr-pane-word').hidden = prefs.tab !== 'word';
    p.querySelector('.pr-pane-prompt').hidden = prefs.tab !== 'prompt';
    p.querySelector('.pr-pane-favs').hidden = prefs.tab !== 'favs';
    var n = favs().length;
    p.querySelector('.pr-tab[data-tab="favs"]').textContent = '★ Saved' + (n ? ' (' + n + ')' : '');
  }

  function renderWord() {
    var p = S.p, w = wordFor(S.dayOff);
    p.querySelector('.pr-date').textContent = fmtDate(S.dayOff);
    p.querySelector('.pr-today').hidden = S.dayOff === 0;
    var card = p.querySelector('.pr-wcard');
    if (!w) { card.innerHTML = '<div class="pr-empty">No words available</div>'; return; }
    card.innerHTML =
      '<div class="pr-word">' + esc(w.w) + '</div>' +
      '<div class="pr-pos">' + esc(w.pos) + '</div>' +
      '<div class="pr-def">' + esc(w.def) + '</div>' +
      '<div class="pr-ex">' + esc(w.ex) + '</div>';
  }

  function renderChips() {
    var box = S.p.querySelector('.pr-chips');
    var sel = prefs.cats;
    var html = '<button class="pr-chip' + (sel.length ? '' : ' on') + '" data-cat="" aria-pressed="' + (sel.length ? 'false' : 'true') + '">All</button>';
    data.cats.forEach(function (c) {
      var on = sel.indexOf(c.id) >= 0;
      html += '<button class="pr-chip' + (on ? ' on' : '') + '" data-cat="' + esc(c.id) + '" aria-pressed="' + on + '" title="' +
        data.prompts[c.id].length + ' prompts"><span aria-hidden="true">' + c.icon + '</span> ' + esc(c.label) + '</button>';
    });
    box.innerHTML = html;
  }

  function renderPrompt() {
    var p = S.p, cur = promptAt(prefs.cur);
    var card = p.querySelector('.pr-pcard');
    p.querySelector('.pr-back').disabled = !S.hist.length;
    if (!cur) { card.innerHTML = '<div class="pr-empty">Press 🎲 Another for a prompt</div>'; return; }
    var cat = catById(cur.c) || { icon: '✎', label: cur.c };
    var fav = isFav(cur.t);
    card.innerHTML =
      '<div class="pr-pcat"><span aria-hidden="true">' + cat.icon + '</span> ' + esc(cat.label) + '</div>' +
      '<div class="pr-ptext">' + esc(cur.t) + '</div>' +
      '<button class="pr-star' + (fav ? ' on' : '') + '" data-act="fav" title="' + (fav ? 'Remove from favourites' : 'Save to favourites') +
        '" aria-pressed="' + fav + '">' + (fav ? '★' : '☆') + '</button>';
    p.querySelectorAll('.pr-style').forEach(function (b) {
      var on = b.getAttribute('data-style') === prefs.style;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function renderFavs() {
    var box = S.p.querySelector('.pr-favs');
    var list = favs();
    if (!list.length) {
      box.innerHTML = '<div class="pr-empty">No saved prompts yet — tap ☆ on a prompt to keep it here.</div>';
      return;
    }
    box.innerHTML = list.map(function (f, i) {
      var cat = catById(f.c);
      return '<div class="pr-fav" data-i="' + i + '">' +
        '<div class="pr-fav-t">' + (cat ? '<span class="pr-fav-c" title="' + esc(cat.label) + '">' + cat.icon + '</span> ' : '') + esc(f.t) + '</div>' +
        '<div class="pr-fav-acts">' +
          '<button class="pr-btn sm" data-act="fins" title="Insert into the document">Insert</button>' +
          '<button class="pr-btn sm" data-act="fcopy" title="Copy">Copy</button>' +
          '<button class="pr-btn sm danger" data-act="fdel" title="Remove">✕</button>' +
        '</div></div>';
    }).join('');
  }

  function renderAll() {
    renderTabs();
    renderWord();
    renderChips();
    renderPrompt();
    renderFavs();
  }

  // ----------------------------------------------------------------- actions
  function nextPrompt() {
    var pick = randomPrompt();
    if (!pick) return;
    if (prefs.cur) { S.hist.push(prefs.cur); if (S.hist.length > HISTORY_MAX) S.hist.shift(); }
    prefs.cur = pick;
    savePrefs();
    renderPrompt();
  }
  function prevPrompt() {
    if (!S.hist.length) return;
    prefs.cur = S.hist.pop();
    savePrefs();
    renderPrompt();
  }
  function currentPromptText() { var c = promptAt(prefs.cur); return c ? c.t : ''; }

  function insertPrompt(t, sprint) {
    if (!t) return;
    var ed = insertBlock(promptLine(t), !!sprint);
    if (!ed) return;
    if (sprint) {
      close();
      setTimeout(function () { try { ed.focus(); } catch (e) {} }, 0);
      Cade.showToast('Sprint started — write!', 'success', 1500);
    } else {
      Cade.showToast('Prompt inserted', 'success', 1100);
    }
  }

  function close() {
    var p = panel();
    if (p) { p.remove(); if (p._onClose) p._onClose(); }
  }

  function onClick(e) {
    var b = e.target.closest && e.target.closest('button');
    if (!b || !S || !data) return;
    if (b.classList.contains('pr-tab')) {
      prefs.tab = b.getAttribute('data-tab'); savePrefs(); renderTabs();
      if (prefs.tab === 'favs') renderFavs();
      if (prefs.tab === 'prompt') renderPrompt();
      return;
    }
    if (b.classList.contains('pr-chip')) {
      var id = b.getAttribute('data-cat');
      if (!id) prefs.cats = [];
      else {
        var at = prefs.cats.indexOf(id);
        if (at >= 0) prefs.cats.splice(at, 1); else prefs.cats.push(id);
        if (prefs.cats.length === data.cats.length) prefs.cats = [];
      }
      savePrefs(); renderChips();
      // Keep the shown prompt only if it still matches the filter.
      if (!prefs.cur || activeCats().indexOf(prefs.cur.c) < 0) nextPrompt();
      return;
    }
    if (b.classList.contains('pr-style')) { prefs.style = b.getAttribute('data-style'); savePrefs(); renderPrompt(); return; }
    var w = wordFor(S.dayOff), f, row;
    switch (b.getAttribute('data-act')) {
      case 'prev': S.dayOff = Math.max(-3650, S.dayOff - 1); renderWord(); break;
      case 'next': S.dayOff = Math.min(3650, S.dayOff + 1); renderWord(); break;
      case 'today': S.dayOff = 0; renderWord(); break;
      case 'winsert': if (w && insertBlock(wordMarkdown(w), false)) Cade.showToast('Inserted “' + w.w + '”', 'success', 1100); break;
      case 'wcopy': if (w) copyText(wordPlain(w), '“' + w.w + '”'); break;
      case 'another': nextPrompt(); break;
      case 'back': prevPrompt(); break;
      case 'pinsert': insertPrompt(currentPromptText(), false); break;
      case 'pcopy': if (currentPromptText()) copyText(currentPromptText(), 'prompt'); break;
      case 'sprint': insertPrompt(currentPromptText(), true); break;
      case 'fav':
        var cur = promptAt(prefs.cur);
        if (cur) { toggleFav(cur.t, cur.c); renderPrompt(); renderTabs(); }
        break;
      case 'fins': case 'fcopy': case 'fdel':
        row = b.closest('.pr-fav');
        f = row && favs()[+row.getAttribute('data-i')];
        if (!f) break;
        if (b.getAttribute('data-act') === 'fins') insertPrompt(f.t, false);
        else if (b.getAttribute('data-act') === 'fcopy') copyText(f.t, 'prompt');
        else { toggleFav(f.t, f.c); renderFavs(); renderTabs(); }
        break;
    }
  }

  function onKey(e) {
    if (!S) return;
    var tag = (e.target && e.target.tagName) || '';
    var typing = tag === 'INPUT' || tag === 'TEXTAREA';
    var mod = e.ctrlKey || e.metaKey || e.altKey;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (!data || typing || mod) return;
    var handled = true;
    if (prefs.tab === 'word' && e.key === 'ArrowLeft') { S.dayOff = Math.max(-3650, S.dayOff - 1); renderWord(); }
    else if (prefs.tab === 'word' && e.key === 'ArrowRight') { S.dayOff = Math.min(3650, S.dayOff + 1); renderWord(); }
    else if (prefs.tab === 'prompt' && (e.key === 'n' || e.key === 'N')) nextPrompt();
    else if (prefs.tab === 'prompt' && (e.key === 'b' || e.key === 'B')) prevPrompt();
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  function open() {
    Cade.closeAllMenus();
    if (panel()) { close(); return; }
    loadPrefs();
    var p = Cade.mkPanel(PANEL_ID, '✍ Prompts & Word of the Day',
      '<div class="pr-tabs" role="tablist">' +
        '<button class="pr-tab" data-tab="word" role="tab">📚 Word of the day</button>' +
        '<button class="pr-tab" data-tab="prompt" role="tab">✍ Prompt</button>' +
        '<button class="pr-tab" data-tab="favs" role="tab">★ Saved</button>' +
      '</div>' +
      '<div class="pr-pane pr-pane-word" hidden>' +
        '<div class="pr-wnav">' +
          '<button class="pr-btn icon" data-act="prev" title="Previous day (←)" aria-label="Previous day">‹</button>' +
          '<span class="pr-date"></span>' +
          '<button class="pr-btn icon" data-act="next" title="Next day (→)" aria-label="Next day">›</button>' +
          '<button class="pr-btn sm pr-today" data-act="today" hidden>Today</button>' +
        '</div>' +
        '<div class="pr-card pr-wcard"><div class="pr-empty">Loading…</div></div>' +
        '<div class="pr-acts">' +
          '<button class="pr-btn primary" data-act="winsert" title="Insert into the document">⤓ Insert</button>' +
          '<button class="pr-btn" data-act="wcopy">⧉ Copy</button>' +
        '</div>' +
      '</div>' +
      '<div class="pr-pane pr-pane-prompt" hidden>' +
        '<div class="pr-chips" role="group" aria-label="Categories"></div>' +
        '<div class="pr-card pr-pcard"><div class="pr-empty">Loading…</div></div>' +
        '<div class="pr-acts">' +
          '<button class="pr-btn" data-act="back" title="Previous prompt (B)" aria-label="Previous prompt">↶</button>' +
          '<button class="pr-btn primary" data-act="another" title="Another prompt (N)">🎲 Another</button>' +
          '<button class="pr-btn" data-act="pinsert" title="Insert into the document">⤓ Insert</button>' +
          '<button class="pr-btn" data-act="pcopy">⧉ Copy</button>' +
          '<button class="pr-btn" data-act="sprint" title="Insert the prompt and a blank line, then jump to the editor">⏱ Start sprint</button>' +
        '</div>' +
        '<div class="pr-styles"><span>Insert as</span>' +
          '<button class="pr-style" data-style="quote" title="&gt; **Prompt:** …">Quote</button>' +
          '<button class="pr-style" data-style="heading" title="## …">Heading</button>' +
          '<button class="pr-style" data-style="plain" title="Plain line">Plain</button>' +
        '</div>' +
      '</div>' +
      '<div class="pr-pane pr-pane-favs" hidden><div class="pr-favs"></div></div>');

    S = { p: p, dayOff: 0, hist: [], recent: [] };
    p._onClose = function () { S = null; };
    p.addEventListener('click', onClick);
    p.addEventListener('keydown', onKey);
    // Make the panel focusable so ←/→ and N work right after opening.
    p.setAttribute('tabindex', '-1');

    load().then(function () {
      if (!S || S.p !== p) return;
      if (!promptAt(prefs.cur) || activeCats().indexOf(prefs.cur.c) < 0) prefs.cur = null;
      if (!prefs.cur) { var pick = randomPrompt(); if (pick) { prefs.cur = pick; savePrefs(); } }
      else S.recent.push(prefs.cur.c + ':' + prefs.cur.i);
      renderAll();
      if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) { try { p.focus({ preventScroll: true }); } catch (e) {} }
    }, function () {
      if (!S || S.p !== p) return;
      var msg = '<div class="pr-empty">Couldn\'t load prompts' + (navigator.onLine ? '' : ' — they need one online load to cache') + '</div>';
      p.querySelector('.pr-wcard').innerHTML = msg;
      p.querySelector('.pr-pcard').innerHTML = msg;
    });
    // Tabs work before the data arrives.
    renderTabs();
  }

  Cade.registerWidget({
    name: 'Writing Prompts & Word of the Day',
    description: 'Daily vocabulary word plus 340 writing prompts — fiction, journaling, poetry, worldbuilding, constraints…',
    icon: '✍',
    tags: 'prompt,prompts,writing prompt,word of the day,wotd,vocabulary,vocab,word,inspiration,idea,journal,journaling,poetry,fiction,story,worldbuilding,dialogue,six-word,micro,creative,writer,block,sprint',
    open: open
  });
})();
