/* Anagram Solver — unscramble letters: exact anagrams first, then every word
 * the letters can make, grouped by length (longest first). `?` or `*` in the
 * letters is a blank tile (any letter). Optional filters (starts with / ends
 * with / contains / pattern like c?t or re*ing) narrow the results; with no
 * letters the filters search the whole dictionary (crossword helper). Sort
 * A–Z or by Scrabble score (blanks score 0). Click a word to copy it; Insert
 * puts it at the cursor (replacing the selection). Opens prefilled with the
 * selected word and says whether the input itself is a word.
 *
 * DICTIONARY: npm word-list@4.1.0 (MIT, ~274k words, 2.8 MB / ~0.8 MB
 * compressed) fetched lazily from jsDelivr on first open; the service worker
 * caches it, so it works offline after one online use.
 *
 * INDEX: built once in a Web Worker (inline Blob; main-thread fallback with a
 * setTimeout-chunked build) so the UI never blocks. Compact typed arrays, no
 * per-word objects: word offsets into the raw text, length buckets, 26-bit
 * letter masks (fast rejection), and an order-independent letter-multiset
 * hash sorted for binary search (the "sorted letters" signature, used for the
 * is-it-a-word lookup). ~10 MB with the text. MEMORY: the worker (and so the index)
 * stays alive while the panel is open and for 3 minutes after it closes, so
 * a quick reopen is instant; after that it is terminated and everything is
 * released (a later open re-reads the cached file and rebuilds, ~0.3 s). */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('anagram.css');
  var esc = Cade.escapeHtml;

  var DICT_URL = 'https://cdn.jsdelivr.net/npm/word-list@4.1.0/words.txt';
  var PANEL_ID = 'anagram-panel';
  var PREFS_KEY = 'cade-anagram-prefs';
  var KEEP_MS = 3 * 60 * 1000;   // index lifetime after the panel closes
  var MAX_LETTERS = 20, MAX_BLANKS = 5;
  var LIMIT = 20000;             // results per query (a long rack with blanks can match far more)
  var PAGE = 150;                // chips rendered per group before "Show all"
  var VAL = { a: 1, b: 3, c: 3, d: 2, e: 1, f: 4, g: 2, h: 4, i: 1, j: 8, k: 5, l: 1, m: 3, n: 1, o: 1, p: 3, q: 10, r: 1, s: 1, t: 1, u: 1, v: 4, w: 4, x: 8, y: 4, z: 10 };

  // ---- search engine ---------------------------------------------------------
  // Self-contained: stringified into the worker, or run on the main thread
  // with a stub `self` when Workers are unavailable. Speaks messages only.
  function engine(self) {
    var text = '', N = 0, MAXL = 0;
    var off, len, mask, byLen, lenStart, sigH, sigI;
    var ready = false, queue = [];
    // Per-letter random 32-bit constants; a word's signature is their sum, so
    // anagrams share it by construction (a hash of the sorted letters).
    var R = new Uint32Array(26);
    (function () { var s = 0x2545F491; for (var i = 0; i < 26; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; R[i] = s >>> 0; } })();
    var SHIFT = 1048576; // 2^20 > word count: hash * SHIFT + index packs into one exact float64

    function sigOf(str) { var h = 0; for (var k = 0; k < str.length; k++) h = (h + R[str.charCodeAt(k) - 97]) >>> 0; return h; }

    function build(t, done) {
      text = t;
      var T = t.length, n = 1, i;
      for (i = 0; i < T; i++) if (t.charCodeAt(i) === 10) n++;
      off = new Int32Array(n); len = new Uint8Array(n); mask = new Int32Array(n);
      var hash = new Uint32Array(n), pos = 0, w = 0;
      // Parse in slices so a main-thread fallback never blocks for long.
      (function parse() {
        for (var c = 0; c < 30000 && pos <= T; c++) {
          var s = pos, m = 0, h = 0, ok = true, ch;
          while (pos < T && (ch = t.charCodeAt(pos)) !== 10) {
            if (ch === 13) { pos++; continue; }
            if (ch < 97 || ch > 122) ok = false;
            else { m |= 1 << (ch - 97); h = (h + R[ch - 97]) >>> 0; }
            pos++;
          }
          var L = pos - s;
          if (pos > s && t.charCodeAt(pos - 1) === 13) L--;
          pos++;
          if (!ok || L < 1 || L > 255) continue;
          off[w] = s; len[w] = L; mask[w] = m; hash[w] = h; w++;
          if (L > MAXL) MAXL = L;
        }
        if (pos <= T) { setTimeout(parse, 0); return; }
        N = w;
        // Length buckets (counting sort): a scan only visits lengths that can fit.
        lenStart = new Int32Array(MAXL + 2);
        for (i = 0; i < N; i++) lenStart[len[i] + 1]++;
        for (i = 1; i < MAXL + 2; i++) lenStart[i] += lenStart[i - 1];
        var fill = lenStart.slice(0, MAXL + 1);
        byLen = new Int32Array(N);
        for (i = 0; i < N; i++) byLen[fill[len[i]]++] = i;
        setTimeout(function () {
          var keys = new Float64Array(N);
          for (i = 0; i < N; i++) keys[i] = hash[i] * SHIFT + i;
          keys.sort();
          sigH = new Uint32Array(N); sigI = new Int32Array(N);
          for (i = 0; i < N; i++) { var hh = Math.floor(keys[i] / SHIFT); sigH[i] = hh; sigI[i] = keys[i] - hh * SHIFT; }
          done();
        }, 0);
      })();
    }

    function isWord(str) {
      if (!str || /[^a-z]/.test(str)) return false;
      var h = sigOf(str), lo = 0, hi = N;
      while (lo < hi) { var mid = (lo + hi) >>> 1; if (sigH[mid] < h) lo = mid + 1; else hi = mid; }
      for (; lo < N && sigH[lo] === h; lo++) {
        var i = sigI[lo];
        if (len[i] === str.length && text.substr(off[i], len[i]) === str) return true;
      }
      return false;
    }

    function compilePattern(p) {
      var src = '^', fixed = true, n = 0;
      for (var k = 0; k < p.length; k++) {
        var ch = p.charAt(k);
        if (ch === '*') { src += '[a-z]*'; fixed = false; }
        else if (ch === '?' || ch === '.' || ch === '_') { src += '[a-z]'; n++; }
        else if (ch >= 'a' && ch <= 'z') { src += ch; n++; }
      }
      return { re: new RegExp(src + '$'), fixed: fixed, n: n };
    }

    function popcount(x) { x = x - ((x >>> 1) & 0x55555555); x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }

    function query(q) {
      var t0 = Date.now();
      var letters = q.letters || '', b = q.blanks | 0, total = letters.length + b;
      var starts = q.starts || '', ends = q.ends || '', contains = q.contains || '';
      var pat = q.pattern ? compilePattern(q.pattern) : null;
      var cnt = new Int32Array(26), use = new Int32Array(26), rackMask = 0, k;
      for (k = 0; k < letters.length; k++) { var c0 = letters.charCodeAt(k) - 97; cnt[c0]++; rackMask |= 1 << c0; }
      var minL = Math.max(2, starts.length, ends.length, contains.length, pat ? pat.n : 0);
      var maxL = total ? Math.min(total, MAXL) : MAXL;
      if (pat && pat.fixed) { minL = Math.max(minL, pat.n); maxL = Math.min(maxL, pat.n); }
      var out = [], truncated = false, limit = q.limit || 20000;
      var sl = starts.length, el = ends.length;
      outer:
      for (var L = maxL; L >= minL; L--) {
        for (var j = lenStart[L], jEnd = lenStart[L + 1]; j < jEnd; j++) {
          var i = byLen[j], o = off[i];
          if (total) {
            var extra = mask[i] & ~rackMask;
            if (extra && (!b || popcount(extra) > b)) continue; // letters the rack can't supply
            var miss = 0;
            for (k = 0; k < L; k++) {
              var c = text.charCodeAt(o + k) - 97;
              if (++use[c] > cnt[c] && ++miss > b) break;
            }
            var upto = k < L ? k : L - 1;
            for (var z = 0; z <= upto; z++) use[text.charCodeAt(o + z) - 97] = 0;
            if (k < L) continue;
          }
          if (sl) { for (k = 0; k < sl; k++) if (text.charCodeAt(o + k) !== starts.charCodeAt(k)) break; if (k < sl) continue; }
          if (el) { for (k = 0; k < el; k++) if (text.charCodeAt(o + L - el + k) !== ends.charCodeAt(k)) break; if (k < el) continue; }
          var word = null;
          if (contains) { word = text.substr(o, L); if (word.indexOf(contains) === -1) continue; }
          if (pat) { word = word || text.substr(o, L); if (!pat.re.test(word)) continue; }
          out.push(word || text.substr(o, L));
          if (out.length >= limit) { truncated = true; break outer; }
        }
      }
      return {
        type: 'result', id: q.id, words: out, truncated: truncated, ms: Date.now() - t0,
        isWord: q.check ? isWord(q.check) : null, check: q.check || '',
      };
    }

    self.onmessage = function (e) {
      var d = e.data || {};
      if (d.type === 'load') {
        var t;
        try { t = typeof d.text === 'string' ? d.text : new TextDecoder('utf-8').decode(new Uint8Array(d.buf)); }
        catch (err) { self.postMessage({ type: 'error', message: String(err && err.message || err) }); return; }
        var t0 = Date.now();
        build(t.toLowerCase(), function () {
          ready = true;
          self.postMessage({ type: 'ready', count: N, ms: Date.now() - t0 });
          var qs = queue; queue = [];
          qs.forEach(function (q) { self.postMessage(query(q)); });
        });
      } else if (d.type === 'query') {
        if (!ready) { queue = [d]; return; } // only the newest pending query matters
        try { self.postMessage(query(d)); }
        catch (err) { self.postMessage({ type: 'result', id: d.id, words: [], error: String(err && err.message || err) }); }
      }
    };
    return self;
  }

  // ---- engine host: worker if possible, else main thread ------------------------
  var host = null;        // { post(msg, transfer), kill() }
  var dict = { state: 'none', count: 0, error: '' }; // none | loading | indexing | ready | error
  var onResult = null;    // current panel's result handler
  var releaseTimer = 0;

  function makeWorkerHost() {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || !window.URL || !URL.createObjectURL) return null;
    var url = null;
    try {
      url = URL.createObjectURL(new Blob(['(' + engine.toString() + ')(self);'], { type: 'application/javascript' }));
      var w = new Worker(url);
      URL.revokeObjectURL(url);
      w.onmessage = function (e) { handle(e.data); };
      w.onerror = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        // A blocked/crashed worker: fall back to the main thread and retry.
        if (host && host.worker === w) { host.kill(); host = null; startEngine(true); }
      };
      return { worker: w, post: function (m, tr) { w.postMessage(m, tr || []); }, kill: function () { w.terminate(); } };
    } catch (err) {
      if (url) try { URL.revokeObjectURL(url); } catch (e2) {}
      return null;
    }
  }
  function makeMainHost() {
    var stub = { postMessage: function (m) { setTimeout(function () { if (host && host.stub === stub) handle(m); }, 0); } };
    engine(stub);
    return { stub: stub, post: function (m) { stub.onmessage({ data: m }); }, kill: function () { stub.onmessage = function () {}; } };
  }

  function startEngine(noWorker) {
    if (host) return;
    clearTimeout(releaseTimer);
    host = (!noWorker && makeWorkerHost()) || makeMainHost();
    var h = host;
    dict.state = 'loading'; dict.error = '';
    paintStatus();
    fetch(DICT_URL).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return h.worker ? r.arrayBuffer() : r.text();
    }).then(function (data) {
      if (host !== h) return;
      dict.state = 'indexing'; paintStatus();
      if (h.worker) h.post({ type: 'load', buf: data }, [data]); // transfer, no copy
      else h.post({ type: 'load', text: data });
    }).catch(function (err) {
      if (host !== h) return;
      h.kill(); host = null;
      dict.state = 'error';
      dict.error = navigator.onLine === false ? 'You’re offline — the dictionary needs one online load to cache.' : 'Couldn’t load the dictionary (' + (err && err.message || 'network error') + ').';
      paintStatus();
    });
  }
  function handle(m) {
    if (!m) return;
    if (m.type === 'ready') { dict.state = 'ready'; dict.count = m.count; paintStatus(); runQuery(); }
    else if (m.type === 'error') { dict.state = 'error'; dict.error = 'Couldn’t read the dictionary: ' + m.message; if (host) host.kill(); host = null; paintStatus(); }
    else if (m.type === 'result' && onResult) onResult(m);
  }
  function scheduleRelease() {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(function () {
      if (document.getElementById(PANEL_ID)) return;
      if (host) host.kill();
      host = null; dict.state = 'none'; dict.count = 0;
    }, KEEP_MS);
  }

  // ---- pure helpers (also used by tests) -----------------------------------------
  // Parse the letters box: a-z letters + blanks (? or *); everything else ignored.
  function parseRack(s) {
    s = String(s || '').toLowerCase();
    var letters = '', blanks = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch >= 'a' && ch <= 'z') letters += ch;
      else if (ch === '?' || ch === '*') blanks++;
    }
    return { letters: letters, blanks: blanks };
  }
  // Score with real tiles first; letters the rack lacks are blanks (0 points).
  // Returns the score and which positions were blanks.
  function scoreWord(w, letters) {
    var left = {}, s = 0, bl = [], i;
    for (i = 0; i < letters.length; i++) left[letters[i]] = (left[letters[i]] || 0) + 1;
    for (i = 0; i < w.length; i++) {
      var ch = w[i];
      if (letters && !(left[ch] > 0)) { bl.push(i); continue; }
      if (letters) left[ch]--;
      s += VAL[ch] || 0;
    }
    return { score: s, blanks: bl };
  }
  function letterOnly(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }
  function patternOnly(s) { return String(s || '').toLowerCase().replace(/[^a-z?*._]/g, ''); }

  // ---- panel state ------------------------------------------------------------------
  var P = null;
  var prefs = { sort: 'az', filters: false };
  var inputs = { letters: '', starts: '', ends: '', contains: '', pattern: '' }; // kept for the session
  var seq = 0, lastQ = null, result = null, expanded = {}, sel = '', qTimer = 0;

  function readPrefs() {
    try { var p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}'); if (p.sort === 'score') prefs.sort = 'score'; prefs.filters = !!p.filters; } catch (e) {}
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }
  function q(sel_) { return P ? P.querySelector(sel_) : null; }

  function currentQuery() {
    var rack = parseRack(inputs.letters);
    return {
      letters: rack.letters.slice(0, MAX_LETTERS), blanks: Math.min(rack.blanks, MAX_BLANKS),
      rawBlanks: rack.blanks,
      starts: letterOnly(inputs.starts), ends: letterOnly(inputs.ends), contains: letterOnly(inputs.contains),
      pattern: patternOnly(inputs.pattern),
    };
  }

  function runQuery() {
    if (!P || dict.state !== 'ready' || !host) return;
    var cq = currentQuery();
    var hasFilter = cq.starts || cq.ends || cq.contains || /[a-z?._]/.test(cq.pattern);
    if (!cq.letters && !cq.blanks && !hasFilter) { result = null; lastQ = cq; paintResults(); paintStatus(); return; }
    var id = ++seq;
    lastQ = cq;
    host.post({
      type: 'query', id: id, letters: cq.letters, blanks: cq.blanks, starts: cq.starts, ends: cq.ends,
      contains: cq.contains, pattern: cq.pattern, limit: LIMIT,
      check: !cq.blanks && cq.letters.length >= 2 ? letterOnly(inputs.letters) : '',
    });
    onResult = function (m) {
      if (m.id !== seq || !P) return; // stale
      result = m; result.q = cq; expanded = {};
      if (sel && result.words.indexOf(sel) === -1) sel = '';
      paintResults(); paintStatus(); paintFoot();
    };
  }
  function schedule() { clearTimeout(qTimer); qTimer = setTimeout(runQuery, 90); }

  // ---- rendering -----------------------------------------------------------------------
  function paintStatus() {
    var el = q('.ag-status'); if (!el) return;
    if (dict.state === 'loading') { el.innerHTML = '<span class="ag-spin"></span>Loading dictionary (≈ 0.8 MB, once)…'; return; }
    if (dict.state === 'indexing') { el.innerHTML = '<span class="ag-spin"></span>Indexing words…'; return; }
    if (dict.state === 'error') { el.innerHTML = '<span class="ag-bad">' + esc(dict.error) + '</span> <button class="ag-link" data-act="retry">Retry</button>'; return; }
    if (dict.state !== 'ready') { el.textContent = ''; return; }
    var cq = lastQ || currentQuery(), bits = [];
    if (result && result.check && result.q === cq) {
      bits.push(result.isWord
        ? '<span class="ag-ok">✓ “' + esc(result.check) + '” is a word</span>'
        : '<span class="ag-bad">✗ “' + esc(result.check) + '” isn’t in the word list</span>');
    }
    if (cq.letters || cq.blanks) {
      bits.push((cq.letters.length + cq.blanks) + ' tiles' + (cq.blanks ? ' (' + cq.blanks + ' blank' + (cq.blanks > 1 ? 's' : '') + ')' : ''));
      if (cq.rawBlanks > MAX_BLANKS) bits.push('max ' + MAX_BLANKS + ' blanks');
    }
    if (result && result.q === cq) bits.push(result.words.length.toLocaleString() + (result.truncated ? '+' : '') + ' word' + (result.words.length === 1 ? '' : 's'));
    if (!bits.length) bits.push(dict.count.toLocaleString() + ' words ready');
    el.innerHTML = bits.join(' · ');
  }

  function chip(w, letters) {
    var sc = scoreWord(w, letters), html = '', bi = 0;
    for (var i = 0; i < w.length; i++) {
      if (sc.blanks[bi] === i) { html += '<i class="ag-bl" title="blank">' + w[i] + '</i>'; bi++; }
      else html += w[i];
    }
    return '<button class="ag-w' + (w === sel ? ' sel' : '') + '" data-w="' + w + '" title="' + sc.score + ' pt' + (sc.score === 1 ? '' : 's') + '">' + html +
      (prefs.sort === 'score' ? '<sup>' + sc.score + '</sup>' : '') + '</button>';
  }

  function paintResults() {
    var box = q('.ag-res'); if (!box) return;
    if (dict.state !== 'ready') { box.innerHTML = ''; return; }
    if (!result) {
      box.innerHTML = '<div class="ag-empty">Type letters to unscramble — use <b>?</b> for a blank tile.<br>' +
        'Or leave Letters empty and use the filters to search the whole dictionary (e.g. pattern <b>c?t</b> or <b>*ology</b>).</div>';
      return;
    }
    var cq = result.q, total = cq.letters.length + cq.blanks, words = result.words;
    if (!words.length) { box.innerHTML = '<div class="ag-empty">No words found' + (cq.starts || cq.ends || cq.contains || cq.pattern ? ' — try loosening the filters' : '') + '.</div>'; return; }
    // Group: exact anagrams (all tiles used), then each shorter length.
    var groups = [], byLen = {};
    words.forEach(function (w) { (byLen[w.length] = byLen[w.length] || []).push(w); });
    Object.keys(byLen).map(Number).sort(function (a, b) { return b - a; }).forEach(function (L) {
      var exact = total > 0 && L === total;
      groups.push({ key: String(L), title: exact ? 'Exact anagrams' : L + ' letters', sub: exact ? 'all ' + L + ' tiles' : '', words: byLen[L], exact: exact });
    });
    var scores = null;
    if (prefs.sort === 'score') {
      scores = {};
      words.forEach(function (w) { scores[w] = scoreWord(w, cq.letters).score; });
    }
    var html = '';
    if (total && !groups[0].exact) html += '<div class="ag-sec"><span>Exact anagrams</span><em>none</em></div>';
    groups.forEach(function (g) {
      var ws = g.words.slice();
      if (scores) ws.sort(function (a, b) { return scores[b] - scores[a] || (a < b ? -1 : a > b ? 1 : 0); });
      else ws.sort();
      var n = expanded[g.key] ? ws.length : Math.min(ws.length, PAGE);
      html += '<div class="ag-sec' + (g.exact ? ' exact' : '') + '"><span>' + g.title + '</span>' + (g.sub ? '<small>' + g.sub + '</small>' : '') + '<em>' + ws.length.toLocaleString() + '</em></div><div class="ag-grid">';
      for (var i = 0; i < n; i++) html += chip(ws[i], cq.letters);
      if (n < ws.length) html += '<button class="ag-more" data-more="' + g.key + '">Show all ' + ws.length.toLocaleString() + '</button>';
      html += '</div>';
    });
    if (result.truncated) html += '<div class="ag-empty">Showing the first ' + LIMIT.toLocaleString() + ' matches — add letters or filters to narrow it down.</div>';
    var keepScroll = box.scrollTop;
    box.innerHTML = html;
    box.scrollTop = keepScroll && result._painted ? keepScroll : 0;
    result._painted = true;
  }

  function paintFoot() {
    var f = q('.ag-sel'); if (!f) return;
    var has = !!sel;
    q('.ag-copy').disabled = !has; q('.ag-insert').disabled = !has;
    if (!has) { f.innerHTML = '<span class="ag-faint">Click a word to copy it</span>'; return; }
    var sc = scoreWord(sel, result && result.q ? result.q.letters : '');
    f.innerHTML = '<b>' + esc(sel) + '</b> <span class="ag-faint">· ' + sel.length + ' letters · ' + sc.score + ' pt' + (sc.score === 1 ? '' : 's') + '</span>';
  }

  function paintSort() {
    P.querySelectorAll('.ag-sort button').forEach(function (b) {
      var on = b.getAttribute('data-sort') === prefs.sort;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // ---- actions -----------------------------------------------------------------------------
  function copyText(text) {
    var done = function () { Cade.showToast('Copied ' + text, 'success', 1200); };
    var fail = function () { Cade.showToast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      ta.remove();
    }
  }
  function insertWord(w) {
    if (!w) return;
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode — editing is locked', 'error', 2000); return; }
    ed.dispatch(ed.state.replaceSelection(w), { userEvent: 'input', scrollIntoView: true });
    Cade.showToast('Inserted ' + w, 'success', 1100);
  }
  function selectWord(w, copy) {
    sel = w;
    var old = P.querySelector('.ag-w.sel'); if (old) old.classList.remove('sel');
    var b = P.querySelector('.ag-w[data-w="' + w + '"]'); if (b) b.classList.add('sel');
    paintFoot();
    if (copy) copyText(w);
  }

  function selectionWord() {
    try {
      var st = Cade.editor.state, m = st.selection.main;
      if (m.empty || m.to - m.from > 40) return '';
      var s = st.sliceDoc(m.from, m.to).trim();
      return /^[A-Za-z?*][A-Za-z?* ]*$/.test(s) && s.replace(/\s/g, '').length <= MAX_LETTERS ? s.replace(/\s+/g, '') : '';
    } catch (e) { return ''; }
  }

  function close() { var p = P; if (p) { p.remove(); cleanup(); } }
  function cleanup() {
    clearTimeout(qTimer);
    P = null; onResult = null; result = null; expanded = {};
    scheduleRelease();
  }

  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById(PANEL_ID);
    if (existing) { var li = existing.querySelector('.ag-in'); if (li) { li.focus(); li.select(); } return; }
    readPrefs();
    var fromSel = selectionWord();
    if (fromSel) inputs.letters = fromSel;
    var field = function (key, label, ph, title) {
      return '<label class="ag-f"><span>' + label + '</span><input data-in="' + key + '" type="text" placeholder="' + ph + '" title="' + title + '" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="24"></label>';
    };
    P = Cade.mkPanel(PANEL_ID, '🔤 Anagram Solver',
      '<div class="ag-top">' +
        '<input class="ag-in" data-in="letters" type="text" placeholder="Letters — e.g. listen or ret?ain" aria-label="Letters (? = blank)" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search" maxlength="40">' +
        '<button class="ag-x" data-act="clear" title="Clear letters" aria-label="Clear letters">×</button>' +
      '</div>' +
      '<div class="ag-status" aria-live="polite"></div>' +
      '<div class="ag-bar">' +
        '<button class="ag-ftog" data-act="filters" aria-expanded="false">Filters <span class="ag-fcount"></span><span class="ag-caret">▾</span></button>' +
        '<div class="ag-sort" role="group" aria-label="Sort">' +
          '<button data-sort="az" title="Alphabetical">A–Z</button><button data-sort="score" title="Scrabble score (blanks = 0)">Score</button>' +
        '</div>' +
      '</div>' +
      '<div class="ag-filters" hidden>' +
        field('starts', 'Starts with', 'e.g. re', 'Word must start with these letters') +
        field('ends', 'Ends with', 'e.g. ing', 'Word must end with these letters') +
        field('contains', 'Contains', 'e.g. ate', 'Word must contain this run of letters') +
        field('pattern', 'Pattern', 'e.g. c?t or *ology', '? = any one letter, * = any run of letters (whole word)') +
      '</div>' +
      '<div class="ag-res"></div>' +
      '<div class="ag-foot"><div class="ag-sel"></div>' +
        '<button class="ag-btn ag-copy" data-act="copy" disabled>Copy</button>' +
        '<button class="ag-btn primary ag-insert" data-act="insert" disabled title="Insert at the cursor (replaces the selection)">Insert</button>' +
      '</div>');
    P._onClose = cleanup;
    sel = '';

    P.querySelectorAll('[data-in]').forEach(function (inp) {
      inp.value = inputs[inp.getAttribute('data-in')] || '';
      inp.addEventListener('input', function () { inputs[inp.getAttribute('data-in')] = inp.value; paintFilterCount(); schedule(); });
    });
    P.addEventListener('click', onClick);
    P.addEventListener('dblclick', function (e) {
      var b = e.target.closest && e.target.closest('.ag-w');
      if (b) { e.preventDefault(); insertWord(b.getAttribute('data-w')); }
    });
    // Chips and buttons shouldn't steal focus from the letters box (keeps typing flowing).
    P.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('.ag-w, .ag-more, .ag-btn, .ag-sort button, .ag-x')) e.preventDefault();
    });
    P.addEventListener('keydown', onKey);
    setFiltersOpen(prefs.filters || !!(inputs.starts || inputs.ends || inputs.contains || inputs.pattern));
    paintSort(); paintFilterCount(); paintFoot(); paintResults(); paintStatus();

    if (dict.state === 'ready' && host) { clearTimeout(releaseTimer); runQuery(); }
    else if (!host) startEngine(false);
    // Desktop: type straight away. Touch: don't pop the keyboard over the results.
    if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) {
      setTimeout(function () { var li = q('.ag-in'); if (li) { li.focus(); li.select(); } }, 0);
    }
  }

  function setFiltersOpen(on) {
    var f = q('.ag-filters'), t = q('.ag-ftog');
    f.hidden = !on; t.setAttribute('aria-expanded', on ? 'true' : 'false'); t.classList.toggle('on', on);
  }
  function paintFilterCount() {
    var n = ['starts', 'ends', 'contains', 'pattern'].filter(function (k) { return inputs[k] && inputs[k].trim(); }).length;
    var c = q('.ag-fcount'); if (c) c.textContent = n ? '(' + n + ')' : '';
  }

  function onClick(e) {
    var t = e.target.closest ? e.target : null, b;
    if (!t || !P) return;
    if ((b = t.closest('.ag-w'))) {
      var w = b.getAttribute('data-w');
      if (e.shiftKey) insertWord(w);
      else if (e.detail < 2) selectWord(w, true); // 2nd click of a double-click inserts (dblclick handler)
      return;
    }
    if ((b = t.closest('.ag-more'))) { expanded[b.getAttribute('data-more')] = true; paintResults(); return; }
    if ((b = t.closest('[data-sort]'))) { prefs.sort = b.getAttribute('data-sort'); savePrefs(); paintSort(); paintResults(); return; }
    if ((b = t.closest('[data-act]'))) {
      var act = b.getAttribute('data-act');
      if (act === 'clear') { var li = q('.ag-in'); li.value = ''; inputs.letters = ''; li.focus(); runQuery(); }
      else if (act === 'filters') { prefs.filters = q('.ag-filters').hidden; savePrefs(); setFiltersOpen(prefs.filters); }
      else if (act === 'copy') { if (sel) copyText(sel); }
      else if (act === 'insert') insertWord(sel);
      else if (act === 'retry') startEngine(false);
    }
  }

  function onKey(e) {
    if (!P) return;
    var inLetters = e.target.classList && e.target.classList.contains('ag-in');
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (inLetters && e.target.value) { e.target.value = ''; inputs.letters = ''; runQuery(); }
      else close();
    } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      // Enter inserts the selected word (or the first exact anagram).
      e.preventDefault(); e.stopPropagation();
      var w = sel;
      if (!w) { var first = P.querySelector('.ag-sec.exact + .ag-grid .ag-w'); if (first) w = first.getAttribute('data-w'); }
      if (w) insertWord(w);
    } else {
      e.stopPropagation(); // keep editor/global shortcuts out of the panel's text boxes
    }
  }

  Cade.registerWidget({
    name: 'Anagram Solver',
    description: 'Unscramble letters (? = blank): anagrams & every word they make',
    icon: '🔤',
    tags: 'anagram,unscramble,scrabble,words with friends,word finder,word unscrambler,crossword,pattern,jumble,letters,word game,solver',
    open: open,
    // Engine + helpers exposed for tests / tooling (no side effects).
    _logic: { engine: engine, parseRack: parseRack, scoreWord: scoreWord, DICT_URL: DICT_URL },
  });
})();
