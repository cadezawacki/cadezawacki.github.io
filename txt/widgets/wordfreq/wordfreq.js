/* Word Frequency — the most-used words and 2- / 3-word phrases in the note
 * (or the selection), for Cade.txt. Counts, share of all words and an inline
 * bar; filters: common English words, minimum length, case folding, merging
 * word forms (plural / -ing / -ed) and a search box. A click on a word selects
 * its next occurrence in the editor (wraps around). "Copy as table" and
 * "Insert table" give a Markdown table. Live and debounced; code blocks,
 * inline code, URLs and HTML tags are skipped.
 * Prefs: Cade.store cade-wordfreq-opts. Pure part is unit-checked in node:
 * node txt/widgets/wordfreq/wordfreq.test.js */
(function () {
  'use strict';

  // ================= pure analysis (node-testable) =================
  var MAX_CHARS = 400000;

  var STOP = Object.create(null);
  ('a,about,above,after,again,against,all,also,am,an,and,any,are,aren\'t,as,at,be,because,been,before,being,below,between,both,but,by,' +
   'can,can\'t,cannot,could,couldn\'t,did,didn\'t,do,does,doesn\'t,doing,don\'t,down,during,each,either,else,etc,even,ever,every,few,for,from,' +
   'further,get,gets,got,had,hadn\'t,has,hasn\'t,have,haven\'t,having,he,he\'d,he\'ll,he\'s,her,here,here\'s,hers,herself,him,himself,his,how,' +
   'how\'s,however,i,i\'d,i\'ll,i\'m,i\'ve,if,in,into,is,isn\'t,it,it\'s,its,itself,just,let\'s,like,may,me,might,more,most,much,must,mustn\'t,my,myself,' +
   'no,nor,not,now,of,off,on,once,one,only,or,other,ought,our,ours,ourselves,out,over,own,per,quite,rather,really,same,shall,shan\'t,she,she\'d,' +
   'she\'ll,she\'s,should,shouldn\'t,so,some,such,than,that,that\'s,the,their,theirs,them,themselves,then,there,there\'s,these,they,they\'d,' +
   'they\'ll,they\'re,they\'ve,this,those,though,through,thus,to,too,under,until,up,upon,us,very,via,was,wasn\'t,we,we\'d,we\'ll,we\'re,we\'ve,' +
   'were,weren\'t,what,what\'s,when,when\'s,where,where\'s,whether,which,while,who,who\'s,whom,whose,why,why\'s,will,with,within,without,won\'t,' +
   'would,wouldn\'t,yet,you,you\'d,you\'ll,you\'re,you\'ve,your,yours,yourself,yourselves,s,t,d,ll,m,re,ve,im,ive,dont,cant,wont,didnt,doesnt,isnt,thats,youre')
    .split(',').forEach(function (w) { STOP[w] = 1; });
  function isStop(lw) { return !!STOP[lw]; }

  // Ranges of the source that aren't prose: fenced code, inline code, URLs,
  // link targets, images, HTML tags, reference definitions and the tables
  // this widget inserts. Sorted, merged [start, end) pairs.
  var OWN_TABLE = /^\|\s*#\s*\|\s*(Word|Phrase)\s*\|\s*Count\s*\|/;
  function excludedRanges(text) {
    var r = [], m, re;
    var pos = 0, n = text.length, fence = null, fenceStart = 0, ownTable = -1;
    while (pos <= n) {
      var le = text.indexOf('\n', pos); if (le === -1) le = n;
      var line = text.slice(pos, le);
      if (fence) {
        var fc = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
        if (fc && fc[1][0] === fence[0] && fc[1].length >= fence.length) { r.push([fenceStart, le]); fence = null; }
      } else {
        var fo = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (fo) { fence = fo[1]; fenceStart = pos; }
        else if (ownTable === -1 && OWN_TABLE.test(line)) ownTable = pos;
        else if (ownTable !== -1 && !/^\s*\|/.test(line)) { r.push([ownTable, pos]); ownTable = -1; }
        if (/^\s{0,3}\[[^\]]+\]:\s*\S/.test(line)) r.push([pos, le]);
      }
      if (le >= n) break;
      pos = le + 1;
    }
    if (fence) r.push([fenceStart, n]);
    if (ownTable !== -1) r.push([ownTable, n]);
    var pats = [
      /!\[[^\]\n]*\]\([^)\n]*\)/g,                          // images (alt text too)
      /(`+)[^`\n]+?\1/g,                                    // inline code
      /\]\([^)\s]*(?:\s+"[^"\n]*")?\)/g,                    // link targets
      /(?:https?:\/\/|ftp:\/\/|mailto:|www\.)[^\s<>()\[\]]+/g, // bare URLs
      /<\/?[A-Za-z][^<>\n]*>|<!--[\s\S]*?-->/g              // HTML tags, comments
    ];
    for (var p = 0; p < pats.length; p++) {
      re = pats[p]; re.lastIndex = 0;
      while ((m = re.exec(text))) { r.push([m.index, m.index + m[0].length]); if (!m[0].length) re.lastIndex++; }
    }
    r.sort(function (a, b) { return a[0] - b[0] || b[1] - a[1]; });
    var out = [];
    for (var i = 0; i < r.length; i++) {
      var last = out[out.length - 1];
      if (last && r[i][0] <= last[1]) { if (r[i][1] > last[1]) last[1] = r[i][1]; }
      else out.push([r[i][0], r[i][1]]);
    }
    return out;
  }

  // Word tokens: { s, e, t (as written, possessive 's dropped), lw, num, brk }
  // brk = a phrase can't run from the previous token into this one
  // (sentence or clause punctuation, a block boundary, skipped code / URL).
  var TOKEN_RE;
  try { TOKEN_RE = new RegExp('[\\p{L}\\p{N}]+(?:[\'’\\-][\\p{L}\\p{N}]+)*', 'gu'); }
  catch (e) { TOKEN_RE = /[A-Za-z0-9À-ɏͰ-ϿЀ-ӿ]+(?:['’\-][A-Za-z0-9À-ɏͰ-ϿЀ-ӿ]+)*/g; }
  var BREAK_GAP = /[.!?;:,()"“”\[\]{}|…—–]|\n\s*\n|\n\s*(?:[#>*+\-|]|\d+[.)])|\s-\s/;
  function tokenize(text, limit) {
    text = String(text == null ? '' : text);
    if (limit && text.length > limit) text = text.slice(0, limit);
    var ex = excludedRanges(text), xi = 0;
    var toks = [], m, prevEnd = 0, pendingBrk = true;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) {
      var s = m.index, e = s + m[0].length;
      while (xi < ex.length && ex[xi][1] <= s) {
        if (ex[xi][0] >= prevEnd) pendingBrk = true;
        xi++;
      }
      if (xi < ex.length && ex[xi][0] < e) { pendingBrk = true; continue; }   // inside code / URL
      var t = m[0];
      var pm = /['’][sS]$/.exec(t);
      if (pm && t.length > 2) { t = t.slice(0, -2); e -= 2; }
      var brk = pendingBrk || BREAK_GAP.test(text.slice(prevEnd, s));
      pendingBrk = false;
      toks.push({ s: s, e: e, t: t, lw: t.toLowerCase().replace(/’/g, "'"), num: /^[\d\-'’]+$/.test(t), brk: brk });
      prevEnd = m.index + m[0].length;
    }
    return toks;
  }

  // A light English stemmer: plurals, -ing, -ed (and a silent final e) merge.
  function undouble(w) { return /([^aeiouslz])\1$/.test(w) ? w.slice(0, -1) : w; }
  function stem(w) {
    w = String(w).toLowerCase().replace(/’/g, "'");
    if (w.length <= 3 || /'/.test(w)) return w;
    if (/ies$/.test(w) && w.length > 4) w = w.slice(0, -3) + 'y';
    else if (/ied$/.test(w) && w.length > 4) w = w.slice(0, -3) + 'y';
    else if (/sses$/.test(w)) w = w.slice(0, -2);
    else if (/(ss|us|is|ous|ics)$/.test(w)) { /* glass, bus, this, famous, physics */ }
    else if (/s$/.test(w)) w = w.slice(0, -1);
    if (/ing$/.test(w) && w.length > 5 && /[aeiouy]/.test(w.slice(0, -3))) w = undouble(w.slice(0, -3));
    else if (/ed$/.test(w) && !/eed$/.test(w) && w.length > 3 && /[aeiouy]/.test(w.slice(0, -2))) w = undouble(w.slice(0, -2));
    if (/[^aeiou]e$/.test(w) && w.length > 2 && !/[^aeiou]le$/.test(w)) w = w.slice(0, -1);   // make / making, box(e)s
    return w;
  }

  function caseSig(t) { var l = t.toLowerCase(); return t === l ? 'l' : t === t.toUpperCase() ? 'U' : /^\p{Lu}/u.test(t) ? 'C' : 'm'; }
  function wordKey(tok, o) {
    var base = o.stem ? stem(tok.lw) : tok.lw;
    if (o.fold !== false) return base;
    return o.stem ? base + '\u0001' + caseSig(tok.t) : tok.t;
  }
  function wordForm(tok, o) { return o.fold !== false ? tok.lw : tok.t; }

  // Count words (n = 1) or n-word phrases.
  // opts: { n, stop, minLen, fold, stem, minCount }
  // → { entries: [{ key, label, count, pct, occ: [[from, to]], forms: [...] }], total, windows }
  function count(toks, opts) {
    var o = opts || {}, n = o.n || 1;
    var minLen = o.minLen == null ? 1 : o.minLen;
    var minCount = o.minCount == null ? (n > 1 ? 2 : 1) : o.minCount;
    var map = Object.create(null), keys = [], total = 0, windows = 0;
    for (var t = 0; t < toks.length; t++) if (!toks[t].num) total++;
    function bump(key, form, from, to) {
      var e = map[key];
      if (!e) { e = map[key] = { key: key, count: 0, occ: [], fc: Object.create(null), fl: [] }; keys.push(key); }
      e.count++; e.occ.push([from, to]);
      if (!e.fc[form]) { e.fc[form] = 0; e.fl.push(form); }
      e.fc[form]++;
    }
    if (n === 1) {
      for (var i = 0; i < toks.length; i++) {
        var tk = toks[i];
        if (tk.num) continue;
        if (tk.t.length < minLen) continue;
        if (o.stop && isStop(tk.lw)) continue;
        bump(wordKey(tk, o), wordForm(tk, o), tk.s, tk.e);
      }
      windows = total;
    } else {
      outer: for (var a = 0; a + n <= toks.length; a++) {
        for (var k = 0; k < n; k++) {
          if (toks[a + k].num) continue outer;
          if (k > 0 && toks[a + k].brk) continue outer;
        }
        windows++;
        var first = toks[a], last = toks[a + n - 1];
        if (o.stop) {
          if (isStop(first.lw) || isStop(last.lw)) continue;
        }
        var kp = [], fp = [];
        for (var q = 0; q < n; q++) { kp.push(wordKey(toks[a + q], o)); fp.push(wordForm(toks[a + q], o)); }
        bump(kp.join(' '), fp.join(' '), first.s, last.e);
      }
    }
    var entries = [];
    for (var z = 0; z < keys.length; z++) {
      var en = map[keys[z]];
      if (en.count < minCount) continue;
      var forms = en.fl.slice().sort(function (x, y) { return en.fc[y] - en.fc[x] || (x < y ? -1 : x > y ? 1 : 0); });
      entries.push({ key: en.key, label: forms[0], count: en.count, pct: windows ? en.count / windows * 100 : 0, occ: en.occ, forms: forms });
    }
    entries.sort(function (x, y) { return y.count - x.count || (x.label < y.label ? -1 : x.label > y.label ? 1 : 0); });
    return { entries: entries, total: total, windows: windows };
  }

  function filterEntries(entries, q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(function (e) {
      if (e.label.toLowerCase().indexOf(q) !== -1) return true;
      for (var i = 0; i < e.forms.length; i++) if (e.forms[i].toLowerCase().indexOf(q) !== -1) return true;
      return false;
    });
  }

  function fmtPct(p) { return p >= 10 ? p.toFixed(0) + '%' : p >= 0.1 ? p.toFixed(1) + '%' : p > 0 ? '<0.1%' : '0%'; }
  function toMarkdownTable(entries, opts) {
    var o = opts || {}, n = o.n || 1, limit = o.limit || 50;
    var col = n === 1 ? 'Word' : 'Phrase';
    var cell = function (s) { return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' '); };
    var lines = ['| # | ' + col + ' | Count | % |', '|--:|:--|--:|--:|'];
    entries.slice(0, limit).forEach(function (e, i) {
      lines.push('| ' + (i + 1) + ' | ' + cell(e.label) + ' | ' + e.count + ' | ' + fmtPct(e.pct) + ' |');
    });
    return lines.join('\n');
  }

  // Index of the occurrence to select next: the one after `cur` (the index
  // selected last), else the first one starting at or after `pos`; wraps.
  function nextOcc(occ, pos, cur) {
    if (!occ.length) return -1;
    if (cur != null && cur >= 0) return (cur + 1) % occ.length;
    for (var i = 0; i < occ.length; i++) if (occ[i][0] >= pos) return i;
    return 0;
  }

  var PURE = { STOP: STOP, isStop: isStop, excludedRanges: excludedRanges, tokenize: tokenize, stem: stem, count: count,
    filterEntries: filterEntries, toMarkdownTable: toMarkdownTable, nextOcc: nextOcc, fmtPct: fmtPct, MAX_CHARS: MAX_CHARS };
  if (typeof module !== 'undefined' && module.exports) module.exports = PURE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('wordfreq.css');
  var esc = Cade.escapeHtml || function (s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); };

  var PANEL_ID = 'wordfreq-panel', NAME = 'Word Frequency', K_OPTS = 'cade-wordfreq-opts';
  var PAGE = 150;
  var DEF = { tab: 1, stop: true, fold: true, stem: false, minLen: 3, mode: 'auto' };

  function loadOpts() {
    var o = {}; try { o = JSON.parse(Cade.store.get(K_OPTS) || '{}') || {}; } catch (e) { o = {}; }
    var r = {};
    for (var k in DEF) r[k] = o[k] == null ? DEF[k] : o[k];
    r.tab = [1, 2, 3].indexOf(+r.tab) === -1 ? 1 : +r.tab;
    r.minLen = Math.max(1, Math.min(12, parseInt(r.minLen, 10) || 3));
    r.stop = !!r.stop; r.fold = !!r.fold; r.stem = !!r.stem;
    r.mode = r.mode === 'note' ? 'note' : 'auto';
    return r;
  }
  function saveOpts() {
    if (!S) return;
    var o = {}; for (var k in DEF) o[k] = S.o[k];
    try { Cade.store.set(K_OPTS, JSON.stringify(o)); } catch (e) {}
  }

  var S = null;

  function q(sel) { return S.panel.querySelector(sel); }

  function schedule(delay) {
    if (!S) return;
    clearTimeout(S.t);
    if (S.idle && window.cancelIdleCallback) { try { window.cancelIdleCallback(S.idle); } catch (e) {} S.idle = 0; }
    S.t = setTimeout(function () {
      if (!S) return;
      S.t = 0;
      if (window.requestIdleCallback) S.idle = window.requestIdleCallback(function () { if (S) { S.idle = 0; scan(); } }, { timeout: 800 });
      else scan();
    }, delay == null ? 400 : delay);
  }
  // Selections made by a "jump to" in this or a sibling widget (Writing
  // Check / Word Frequency) carry this userEvent and don't change the scope.
  var JUMP = 'select.cadejump';
  function isJump(u) {
    var trs = u.transactions || [];
    for (var i = 0; i < trs.length; i++) if (trs[i].selection && trs[i].isUserEvent && trs[i].isUserEvent(JUMP)) return true;
    return false;
  }
  function sameSel(a, b) { return a && b && a.anchor === b.anchor && a.head === b.head; }
  function onUpdate(u) {
    if (!S || !S.panel.isConnected) return;
    if (Cade.roomAway && Cade.roomAway(S.panel)) return;
    var m = u.state.selection.main, cur = { anchor: m.anchor, head: m.head };
    if (u.docChanged && S.scope) {
      S.scope = { from: u.changes.mapPos(S.scope.from, 1), to: u.changes.mapPos(S.scope.to, -1) };
      if (S.scope.to <= S.scope.from) S.scope = null;
    }
    if (u.docChanged && S.own) S.own = { anchor: u.changes.mapPos(S.own.anchor), head: u.changes.mapPos(S.own.head) };
    var scopeChanged = false;
    if (u.selectionSet && isJump(u)) S.own = cur;
    if (u.selectionSet && !sameSel(cur, S.own)) {
      S.own = null; S.cyc = null;
      var next = m.empty ? null : { from: m.from, to: m.to };
      if (!(next === null && S.scope === null) && !(next && S.scope && next.from === S.scope.from && next.to === S.scope.to)) { S.scope = next; scopeChanged = true; }
    }
    if (u.docChanged) schedule(u.state.doc.length > 80000 ? 1200 : 450);
    else if (scopeChanged && S.o.mode !== 'note') schedule(250);
  }

  // Re-read the text (scope) and tokenise; then recount.
  function scan() {
    if (!S || !S.panel.isConnected) return;
    if (Cade.roomAway && Cade.roomAway(S.panel)) return;
    var view = Cade.editor; if (!view) return;
    var len = view.state.doc.length, sc = S.o.mode === 'note' ? null : S.scope, text, base = 0;
    if (sc && sc.to <= len) { text = view.state.sliceDoc(sc.from, sc.to); base = sc.from; }
    else { sc = null; text = view.state.sliceDoc(0, Math.min(len, MAX_CHARS)); }
    S.toks = tokenize(text);
    S.base = base; S.sc = sc; S.truncated = !sc && len > MAX_CHARS;
    S.cyc = null;
    recount();
  }
  function recount() {
    if (!S || !S.toks) return;
    var o = S.o;
    S.res = count(S.toks, { n: o.tab, stop: o.stop, minLen: o.tab === 1 ? o.minLen : 1, fold: o.fold, stem: o.stem });
    var uniq = o.tab === 1 ? S.res.entries.length : null;
    S.uniq = uniq;
    S.shown = PAGE;
    renderList();
  }

  function shell() {
    var o = S.o;
    var tab = function (n, l) { return '<button type="button" role="tab" class="wf-tab' + (o.tab === n ? ' on' : '') + '" data-tab="' + n + '" aria-selected="' + (o.tab === n) + '">' + l + '</button>'; };
    var tog = function (k, l, t) { return '<button type="button" class="wf-tog' + (o[k] ? ' on' : '') + '" data-tog="' + k + '" aria-pressed="' + !!o[k] + '" title="' + esc(t) + '"><i></i>' + l + '</button>'; };
    return '<div class="wf">' +
      '<div class="wf-head">' +
        '<div class="wf-tabs" role="tablist">' + tab(1, 'Words') + tab(2, '2-word') + tab(3, '3-word') + '</div>' +
        '<label class="wf-search"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
          '<input type="search" class="wf-q" placeholder="Filter words…" aria-label="Filter words" autocomplete="off" spellcheck="false"></label>' +
        '<div class="wf-opts">' +
          tog('stop', 'Skip common', 'Leave out common English words (the, and, of…); phrases may not start or end with one') +
          tog('fold', 'Ignore case', 'Count “Word” and “word” together') +
          tog('stem', 'Merge forms', 'Count plurals and -ing / -ed forms together (walk, walks, walked)') +
          '<span class="wf-min" title="Shortest word to count"><span>Min</span>' +
            '<button type="button" data-min="-1" aria-label="Shorter">−</button><b class="wf-minv">' + o.minLen + '</b><button type="button" data-min="1" aria-label="Longer">+</button></span>' +
        '</div>' +
      '</div>' +
      '<div class="wf-scope"></div>' +
      '<div class="wf-list" role="list"></div>' +
      '<div class="wf-foot">' +
        '<button type="button" class="wf-btn" data-act="copy" title="Copy the list (top 50, as filtered) as a Markdown table">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 10.5V3.8C3 3.4 3.4 3 3.8 3h6.7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>Copy as table</button>' +
        '<button type="button" class="wf-btn" data-act="insert" title="Insert the table (top 50, as filtered) into the note below the cursor">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 6.5h11M6.5 6.5V13" stroke="currentColor" stroke-width="1.4"/></svg>Insert table</button>' +
      '</div>' +
    '</div>';
  }

  function visible() { return S && S.res ? filterEntries(S.res.entries, S.query) : []; }

  function renderList() {
    if (!S) return;
    var list = q('.wf-list'), scope = q('.wf-scope');
    if (!S.res) { list.innerHTML = '<div class="wf-empty">Counting…</div>'; return; }
    var o = S.o, r = S.res, ents = visible();
    scope.innerHTML = '<span class="wf-scope-l">' + (S.sc ? 'Selection' : 'Whole note') + '</span><span class="wf-scope-r">' +
      r.total.toLocaleString() + ' words' + (o.tab === 1 ? ' · ' + r.entries.length.toLocaleString() + ' distinct' : ' · ' + r.entries.length.toLocaleString() + ' repeated') +
      (S.truncated ? ' · first ' + Math.round(MAX_CHARS / 1000) + 'k chars' : '') + '</span>';
    q('.wf-minv').textContent = o.minLen;
    q('.wf-min').classList.toggle('off', o.tab !== 1);
    if (!ents.length) {
      list.innerHTML = '<div class="wf-empty">' + (S.query ? 'Nothing matches “' + esc(S.query) + '”.' :
        o.tab === 1 ? 'No words to count yet.' : 'No phrase appears twice yet.') + '</div>';
      updateFoot(0);
      return;
    }
    var max = ents[0].count, n = Math.min(ents.length, S.shown), h = '';
    for (var i = 0; i < n; i++) {
      var e = ents[i], cy = S.cyc && S.cyc.key === e.key ? S.cyc : null;
      var forms = e.forms.length > 1 ? e.forms.slice(0, 8).join(', ') + (e.forms.length > 8 ? '…' : '') : '';
      h += '<button type="button" role="listitem" class="wf-row' + (cy ? ' cur' : '') + '" data-key="' + esc(e.key) + '" title="' +
        esc((forms ? 'Forms: ' + forms + '\n' : '') + 'Click to select the next of ' + e.count + ' in the note') + '">' +
        '<span class="wf-rank">' + (S.query ? '' : i + 1) + '</span>' +
        '<span class="wf-w">' + esc(e.label) + (forms ? '<sup>+' + (e.forms.length - 1) + '</sup>' : '') + '</span>' +
        '<span class="wf-track"><span class="wf-fill" style="width:' + Math.max(2, Math.round(100 * e.count / max)) + '%"></span></span>' +
        '<span class="wf-n">' + (cy ? '<em>' + (cy.i + 1) + '/</em>' : '') + e.count + '</span>' +
        '<span class="wf-pct">' + fmtPct(e.pct) + '</span></button>';
    }
    if (ents.length > n) h += '<button type="button" class="wf-more" data-act="more">Show ' + Math.min(PAGE, ents.length - n) + ' more of ' + (ents.length - n) + '</button>';
    var st = list.scrollTop;
    list.innerHTML = h;
    list.scrollTop = st;
    updateFoot(ents.length);
  }
  function updateFoot(n) {
    var b = S.panel.querySelectorAll('.wf-btn');
    for (var i = 0; i < b.length; i++) b[i].disabled = !n;
  }

  function findEntry(key) {
    var es = S.res ? S.res.entries : [];
    for (var i = 0; i < es.length; i++) if (es[i].key === key) return es[i];
    return null;
  }
  function selectNext(key, row) {
    var view = Cade.editor, e = findEntry(key);
    if (!view || !e) return;
    var occ = e.occ.map(function (r) { return [r[0] + S.base, r[1] + S.base]; });
    var cur = S.cyc && S.cyc.key === key ? S.cyc.i : null;
    var m = view.state.selection.main;
    var i = nextOcc(occ, m.from, cur);
    if (i < 0) return;
    var len = view.state.doc.length, a = Math.min(len, occ[i][0]), b = Math.min(len, occ[i][1]);
    S.own = { anchor: a, head: b };
    S.cyc = { key: key, i: i };
    var EV = Cade.CM && Cade.CM.EditorView, spec = { selection: { anchor: a, head: b }, userEvent: JUMP };
    if (EV && EV.scrollIntoView) spec.effects = EV.scrollIntoView(a, { y: 'center' }); else spec.scrollIntoView = true;
    try { view.dispatch(spec); } catch (err) { return; }
    var coarse = false; try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch (err) {}
    if (!coarse && !(Cade.isPoppedOut && Cade.isPoppedOut(S.panel))) { try { view.focus(); } catch (err) {} }
    // update just the rows (keeps scroll + hover)
    var prev = S.panel.querySelectorAll('.wf-row.cur');
    for (var k = 0; k < prev.length; k++) { prev[k].classList.remove('cur'); var em = prev[k].querySelector('.wf-n em'); if (em) em.remove(); }
    if (row) {
      row.classList.add('cur');
      var nEl = row.querySelector('.wf-n');
      nEl.innerHTML = '<em>' + (i + 1) + '/</em>' + e.count;
    }
  }

  function tableText() { return toMarkdownTable(visible(), { n: S.o.tab, limit: 50 }); }
  function copyText(text) {
    var win = S.panel.ownerDocument.defaultView || window;
    var done = function () { Cade.showToast && Cade.showToast('Copied the table', 'success', 1600); };
    var fallback = function () {
      var d = S.panel.ownerDocument, ta = d.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.top = '0';
      S.panel.appendChild(ta); ta.select();
      var ok = false; try { ok = d.execCommand('copy'); } catch (e) {}
      ta.remove();
      if (ok) done(); else Cade.showToast && Cade.showToast('Couldn’t copy — your browser blocked it', 'error');
    };
    try {
      if (win.navigator.clipboard && win.navigator.clipboard.writeText) win.navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    } catch (e) { fallback(); }
  }
  function insertTable() {
    var view = Cade.editor; if (!view) return;
    if (view.state.readOnly) { Cade.showToast && Cade.showToast('The note is read-only', 'error'); return; }
    var text = tableText(), st = view.state, m = st.selection.main;
    var line = st.doc.lineAt(m.to), at = line.to;
    var before = line.text.trim() ? '\n\n' : (line.number > 1 && st.doc.line(line.number - 1).text.trim() ? '\n' : '');
    var after = at < st.doc.length ? '\n' : '\n';
    if (!line.text.trim()) { at = line.from; before = line.number > 1 && st.doc.line(line.number - 1).text.trim() ? '\n' : ''; }
    var ins = before + text + after;
    try {
      view.dispatch({ changes: { from: at, insert: ins }, userEvent: 'input', scrollIntoView: true });
      Cade.showToast && Cade.showToast('Inserted the table', 'success', 1600);
    } catch (e) { Cade.showToast && Cade.showToast('Couldn’t insert the table', 'error'); }
  }

  function onClick(e) {
    var t = e.target.closest ? e.target.closest('button') : null;
    if (!t || !S) return;
    var o = S.o;
    if (t.classList.contains('wf-row')) { selectNext(t.getAttribute('data-key'), t); return; }
    if (t.hasAttribute('data-tab')) {
      o.tab = +t.getAttribute('data-tab');
      var tabs = S.panel.querySelectorAll('.wf-tab');
      for (var i = 0; i < tabs.length; i++) { var on = +tabs[i].getAttribute('data-tab') === o.tab; tabs[i].classList.toggle('on', on); tabs[i].setAttribute('aria-selected', on); }
      q('.wf-q').placeholder = o.tab === 1 ? 'Filter words…' : 'Filter phrases…';
      S.cyc = null; saveOpts(); recount(); q('.wf-list').scrollTop = 0; return;
    }
    if (t.hasAttribute('data-tog')) {
      var k = t.getAttribute('data-tog'); o[k] = !o[k];
      t.classList.toggle('on', o[k]); t.setAttribute('aria-pressed', o[k]);
      S.cyc = null; saveOpts(); recount(); return;
    }
    if (t.hasAttribute('data-min')) {
      o.minLen = Math.max(1, Math.min(12, o.minLen + (+t.getAttribute('data-min'))));
      S.cyc = null; saveOpts(); recount(); return;
    }
    var act = t.getAttribute('data-act');
    if (act === 'more') { S.shown += PAGE; renderList(); }
    else if (act === 'copy') copyText(tableText());
    else if (act === 'insert') insertTable();
  }

  function updateHead() {
    if (!S || !S.scopeBtn) return;
    var note = S.o.mode === 'note';
    S.scopeBtn.classList.toggle('on', note);
    S.scopeBtn.title = note ? 'Counting the whole note — click to follow the selection' : 'Following the selection — click to always count the whole note';
    S.scopeBtn.setAttribute('aria-label', S.scopeBtn.title);
  }
  function mkHeadBtn(panel, cls, svg, onAct) {
    var b = panel.ownerDocument.createElement('span');
    b.className = 'wf-hbtn ' + cls;
    b.setAttribute('role', 'button'); b.setAttribute('tabindex', '0');
    b.innerHTML = svg;
    b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    b.addEventListener('click', function (e) { e.stopPropagation(); onAct(); });
    b.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onAct(); } });
    var head = panel.querySelector('.cade-panel-head');
    if (head) head.insertBefore(b, panel.querySelector('.cade-panel-popbtn') || panel.querySelector('.cade-panel-minbtn') || panel.querySelector('.cade-panel-x'));
    return b;
  }
  var SVG_SCOPE = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 6h6M5 8.5h6M5 11h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

  function close() {
    if (!S) return;
    var s = S; S = null;
    clearTimeout(s.t); clearTimeout(s.qt);
    if (s.idle && window.cancelIdleCallback) { try { window.cancelIdleCallback(s.idle); } catch (e) {} }
    try { Cade.offEditorUpdate(onUpdate); } catch (e) {}
  }

  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById(PANEL_ID);
    if (existing) {
      if (Cade.isMinimized && Cade.isMinimized(existing) && Cade.restorePanel) { Cade.restorePanel(existing); return; }
      existing.remove(); if (existing._onClose) existing._onClose(); close(); return;
    }
    var view = Cade.editor, m = view && view.state.selection.main;
    S = { o: loadOpts(), t: 0, qt: 0, idle: 0, own: null, cyc: null, query: '', toks: null, res: null, base: 0, sc: null, shown: PAGE,
      scope: m && !m.empty ? { from: m.from, to: m.to } : null };
    var p = Cade.mkPanel(PANEL_ID, '📊 Word Frequency', '');
    S.panel = p;
    p.querySelector('.cade-panel-body').innerHTML = shell();
    q('.wf-q').placeholder = S.o.tab === 1 ? 'Filter words…' : 'Filter phrases…';
    S.scopeBtn = mkHeadBtn(p, 'wf-scopebtn', SVG_SCOPE, function () {
      if (!S) return;
      S.o.mode = S.o.mode === 'note' ? 'auto' : 'note';
      saveOpts(); updateHead(); scan();
    });
    updateHead();
    p.querySelector('.wf').addEventListener('click', onClick);
    q('.wf-q').addEventListener('input', function (e) {
      var v = e.target.value;
      clearTimeout(S.qt);
      S.qt = setTimeout(function () { if (!S) return; S.query = v; S.shown = PAGE; renderList(); q('.wf-list').scrollTop = 0; }, 120);
    });
    q('.wf-q').addEventListener('keydown', function (e) { if (e.key === 'Escape' && e.target.value) { e.stopPropagation(); e.target.value = ''; S.query = ''; renderList(); } });
    p._onClose = close;
    if (Cade.roomLock) {
      Cade.roomLock(p);
      p.addEventListener('cade-panel-room', function () { if (S) { S.scope = null; S.own = null; scan(); } });
    }
    Cade.onEditorUpdate(onUpdate);
    renderList();
    schedule(0);
  }

  document.addEventListener('cade-room-switched', function () {
    if (!S) return;
    S.scope = null; S.own = null; S.cyc = null;
    schedule(150);
  });

  Cade.registerWidget({
    name: NAME,
    description: 'Most-used words and phrases in the note or selection — counts, percentages, stop-word filter, copy as a table',
    icon: '📊',
    tags: 'word,frequency,count,words,phrases,ngrams,keywords,stats,vocabulary,repetition',
    open: open
  });
})();
