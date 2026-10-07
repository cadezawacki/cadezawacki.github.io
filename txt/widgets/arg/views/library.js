/* ============================================================
   ARG Desk — Library view
   Research (links + sources) and Ideas (half-thoughts) in one
   place. Quick-add bar on top; dense cards that are edited in
   place on desktop and phone. Model v3: research supports events
   (inside chapters), puzzles, characters, places, timeline entries,
   clues and questions; ideas promote into puzzles, events and pages.

   Routes: research · ideas → { tab }
   Entity pages (R01, I03) belong to the Codex view.

   Rendering: the whole view is rebuilt as an HTML string and
   morphed into the live DOM (keyed by data-k), so the field the
   user is typing in is never replaced and keeps its caret, even
   when a remote change from another device arrives mid-sentence.
   ============================================================ */
(function () {
  'use strict';
  var esc = Kit.esc;

  var RES_STATUS = [['to read', 'To read'], ['read', 'Read'], ['verified', 'Verified']];
  var REL = [['primary', 'Primary', 'tone-teal'], ['scholarly', 'Scholarly', 'tone-blue'], ['popular', 'Popular', 'tone-neutral'], ['fringe', 'Fringe', 'tone-purple']];
  var RES_KINDS = (Kit.FIELDS.research.kind || {}).values || ['web', 'book', 'article', 'archive', 'story', 'video', 'other'];
  var IDEA_ST = [['raw', 'Raw', 'Just captured'], ['exploring', 'Exploring', 'Being worked out'], ['used', 'Used', 'In the game'], ['parked', 'Parked', 'Not now']];
  var PROMOTE = ['puzzle', 'event', 'character', 'question', 'research', 'note'];
  var LINK_TYPES = Kit.CLAIM_TYPES.concat(['puzzle', 'question']);
  var GROUPS = [['none', 'None'], ['tag', 'Tag'], ['status', 'Status'], ['event', 'What it supports']];

  var IC = {
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    grip: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  };

  /* view state that survives remounts within one game (reset when another game opens) */
  var S = {
    gid: null,
    rs: { status: 'all', rel: [], tags: [], unlinked: false, q: '', group: 'none' },
    rsMore: false,   /* phone: secondary research filters unfolded */
    id: { status: 'all', tags: [], q: '' },
    details: {},     /* id → true: the card's detail fields are open */
    showField: {},   /* 'R05:excerpt' → true: an empty field the user asked to fill */
    confirmDel: null,
    menu: null,      /* { id, kind } */
    promoted: {},    /* ideaId → id created from it this session */
    sel: null,
    flash: null,
  };
  function freshState(gid) {
    S.gid = gid;
    S.rs = { status: 'all', rel: [], tags: [], unlinked: false, q: '', group: S.rs.group };
    S.id = { status: 'all', tags: [], q: '' };
    S.details = {}; S.showField = {}; S.promoted = {};
    S.confirmDel = null; S.menu = null; S.sel = null; S.flash = null; S.riskAll = false;
  }
  /* the only thing kept in localStorage: whether the risk list is folded (one tiny pref) */
  var RISK_KEY = 'argdesk-library-risk';
  (function migrateKeys() {
    try {
      var old = localStorage.getItem('arg-lib-risk-collapsed');
      if (old != null) {
        if (localStorage.getItem(RISK_KEY) == null) localStorage.setItem(RISK_KEY, old);
        localStorage.removeItem('arg-lib-risk-collapsed');
      }
    } catch (e) { /* storage off */ }
  })();
  /* no stored choice: open on desktop, folded on phone (it would fill the first screen) */
  function riskCollapsed() {
    var v = null;
    try { v = localStorage.getItem(RISK_KEY); } catch (e) { /* storage off */ }
    return v == null ? Desk.isPhone() : v === '1';
  }
  function setRiskCollapsed(v) { try { localStorage.setItem(RISK_KEY, v ? '1' : '0'); } catch (e) { /* storage off */ } }

  /* ---------- small helpers ---------- */
  function cls(s) { return String(s || '').replace(/\s+/g, '-'); }
  function num(id) { var m = String(id).match(/(\d+)$/); return m ? +m[1] : 0; }
  function attr(s) { return esc(s == null ? '' : s); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function relInfo(v) { return REL.filter(function (r) { return r[0] === v; })[0] || ['', v || '—', 'tone-neutral']; }
  function ideaInfo(v) { return IDEA_ST.filter(function (r) { return r[0] === v; })[0] || [v, v, '']; }
  function resLabel(v) { var r = RES_STATUS.filter(function (x) { return x[0] === v; })[0]; return r ? r[1] : v; }
  /* puzzles that rely on a source: the ones it supports directly, plus the puzzles
     inside any event it supports (the event's record stands on it) */
  function reliance(r) {
    var direct = [], via = [], all = [];
    (r.supports || []).forEach(function (x) {
      var t = Kit.type(x);
      if (t === 'puzzle') { if (direct.indexOf(x) < 0) direct.push(x); }
      else if (t === 'event') {
        var ps = ((Kit.get(x) || {}).puzzles || []).filter(function (p) { return Kit.type(p) === 'puzzle'; });
        if (ps.length) via.push({ ev: x, ps: ps });
      }
    });
    direct.forEach(function (p) { all.push(p); });
    via.forEach(function (v) { v.ps.forEach(function (p) { if (all.indexOf(p) < 0) all.push(p); }); });
    return { direct: direct, via: via, all: all };
  }
  function isRisk(r) { return r.status !== 'verified' && reliance(r).all.length > 0; }
  function todayYear() { return Kit.today.getFullYear(); }

  /* ---------- quick-add parsing (no network: titles come from the URL) ---------- */
  var URL_RE = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s<>"']*/i;
  function parseQuick(raw) {
    var text = String(raw || ''), url = null, m = text.match(URL_RE);
    if (m) {
      url = m[0];
      /* drop trailing punctuation, but keep a ")" that closes a "(" in the link (Wikipedia slugs) */
      for (var guard = 0; guard < 8; guard++) {
        var last = url.slice(-1);
        if (/[.,;:!?\]'"]/.test(last)) url = url.slice(0, -1);
        else if (last === ')' && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) url = url.slice(0, -1);
        else break;
      }
      text = text.replace(m[0], ' ');
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    }
    var tags = [], refs = [], bare;
    text = text.replace(/(^|\s)#([A-Za-z0-9][\w-]*)/g, function (all, pre, word) {
      /* #E01, #TL01, #P04, #c-ida … link to that page (coded ids also match typed in lower case) */
      var id = Kit.has(word) ? word : (/^[a-z]{1,2}\d+$/i.test(word) && Kit.has(word.toUpperCase()) ? word.toUpperCase() : null);
      if (id) { if (refs.indexOf(id) < 0) refs.push(id); return pre + '\u0000' + id; }
      var t = word.toLowerCase();
      if (tags.indexOf(t) < 0) tags.push(t);
      return pre;
    });
    /* text keeps "#P04" as "P04" (reads as a sentence); bare drops it (for titles) */
    bare = text.replace(/\u0000\S+/g, ' ').replace(/\s+/g, ' ').trim();
    text = text.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
    return { url: url, text: text, bare: bare, tags: tags, refs: refs };
  }
  function deslug(s, dashes) {
    try { s = decodeURIComponent(s); } catch (e) { /* keep raw */ }
    return s.replace(dashes ? /[-_+]+/g : /[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  /* Wikipedia slug → words; anything else → domain / last path segment */
  function titleFromUrl(url) {
    var u;
    try { u = new URL(url); } catch (e) { return { title: url, author: '' }; }
    var host = u.hostname.replace(/^www\./, '');
    var wm = /(^|\.)wikipedia\.org$/i.test(u.hostname) && u.pathname.match(/^\/wiki\/([^/]+)/);
    if (wm) return { title: deslug(wm[1], false) || host, author: 'Wikipedia' };
    var segs = u.pathname.split('/').filter(Boolean);
    var last = segs.length ? deslug(segs[segs.length - 1].replace(/\.(html?|php|aspx?|jsp|pdf)$/i, ''), true) : '';
    return { title: last ? host + ' / ' + last : host, author: '' };
  }
  function normUrl(u) {
    return String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '')
      .replace(/^([a-z-]+)\.m\.wikipedia/, '$1.wikipedia').replace(/#.*$/, '').replace(/\/+$/, '');
  }
  function firstSentence(t) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    var m = t.match(/^(.{12,}?[.!?])(?=\s+["'(A-Z0-9]|$)/);
    var s = (m ? m[1] : t).replace(/[.!?]+$/, '').trim();
    if (s.length > 80) s = s.slice(0, 78).replace(/\s+\S*$/, '') + '…';
    return s;
  }
  function normTag(t) { return String(t || '').trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, ''); }

  /* ---------- DOM morph: update the live tree from a freshly rendered one ----------
     Keyed by data-k among siblings. The focused input/textarea keeps its node, value and caret. */
  function keyOf(n) { return n.nodeType === 1 ? n.getAttribute('data-k') : null; }
  function syncAttrs(from, to) {
    var a = to.attributes, i, skipStyle = from.tagName === 'TEXTAREA';
    for (i = 0; i < a.length; i++) {
      if (skipStyle && a[i].name === 'style') continue;
      if (from.getAttribute(a[i].name) !== a[i].value) from.setAttribute(a[i].name, a[i].value);
    }
    var b = from.attributes;
    for (i = b.length - 1; i >= 0; i--) {
      if (skipStyle && b[i].name === 'style') continue;
      if (!to.hasAttribute(b[i].name)) from.removeAttribute(b[i].name);
    }
  }
  var resized = [];
  function morph(from, to) {
    syncAttrs(from, to);
    var tag = from.tagName, focused = document.activeElement === from;
    if (tag === 'TEXTAREA') {
      if (!focused && from.value !== to.value) { from.value = to.value; resized.push(from); }
      return;
    }
    if (tag === 'INPUT') {
      if (!focused && from.value !== to.value) from.value = to.value;
      return;
    }
    morphChildren(from, to);
    if (tag === 'SELECT' && from.value !== to.value) from.value = to.value;
  }
  function morphChildren(from, to) {
    var kids = Array.prototype.slice.call(to.childNodes), keyed = {}, c, active = document.activeElement;
    for (c = from.firstChild; c; c = c.nextSibling) { var k0 = keyOf(c); if (k0) keyed[k0] = c; }
    var cursor = from.firstChild;
    kids.forEach(function (nk) {
      var k = keyOf(nk), match = null;
      if (k) {
        match = keyed[k] || null;
        if (match && match.tagName !== nk.tagName) match = null;
        if (match) delete keyed[k];
      } else if (cursor && !keyOf(cursor) && cursor.nodeType === nk.nodeType && (nk.nodeType !== 1 || cursor.tagName === nk.tagName)) {
        match = cursor;
      }
      if (!match) { from.insertBefore(nk, cursor); if (nk.nodeType === 1) collectNew(nk); return; }
      if (match !== cursor) {
        if (match.parentNode === from && active && match.contains(active)) {
          /* never move the node holding focus: drop what sits before it instead */
          while (cursor && cursor !== match) { var nx = cursor.nextSibling; from.removeChild(cursor); cursor = nx; }
        } else from.insertBefore(match, cursor);
      }
      if (nk.nodeType === 1) morph(match, nk);
      else if (match.nodeValue !== nk.nodeValue) match.nodeValue = nk.nodeValue;
      cursor = match.nextSibling;
    });
    while (cursor) { var nx2 = cursor.nextSibling; from.removeChild(cursor); cursor = nx2; }
  }
  function collectNew(el) {
    if (el.tagName === 'TEXTAREA') resized.push(el);
    else if (el.querySelectorAll) Array.prototype.forEach.call(el.querySelectorAll('textarea'), function (t) { resized.push(t); });
  }
  var FIELD_SIZING = !!(window.CSS && CSS.supports && CSS.supports('field-sizing', 'content'));

  /* ============================================================ */
  Desk.registerView({
    id: 'library', title: 'Library',
    routes: function (t) { return t === 'research' || t === 'ideas' ? { tab: t } : null; },
    mount: function (root, params, ctx) {
      var tab = params.tab === 'ideas' ? 'ideas' : 'research';
      var dead = false, renderT = null, liveT = null, liveEl = null, flashT = null, pendingRender = false;
      var drag = null, suppressClick = false;
      var mq = window.matchMedia('(max-width: 760px)');
      var lastPhone = mq.matches;
      if (S.gid !== Kit.games.current()) freshState(Kit.games.current());

      /* ---------------- render ---------------- */
      function scroller() { return root.querySelector('.lib-scroll'); }
      function render() {
        if (dead) return;
        clearTimeout(renderT);
        if (drag && drag.active) { pendingRender = true; return; }
        var html = '<div class="lib-scroll scroll" data-k="scroll">' + headHtml() +
          '<div class="lib-body is-' + tab + '" data-k="body-' + tab + '">' + (tab === 'research' ? viewResearch() : viewIdeas()) + '</div></div>';
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        resized = [];
        morphChildren(root, tmp);
        autosize(resized);
        resized = [];
        setStatus();
        if (S.flash) {
          var fid = S.flash; S.flash = null;
          var card = root.querySelector('.lib-card[data-id="' + fid + '"]');
          if (card) {
            card.classList.remove('lib-flash'); void card.offsetWidth; card.classList.add('lib-flash');
            card.scrollIntoView({ block: 'nearest' });
            clearTimeout(flashT);
            flashT = setTimeout(function () { card.classList.remove('lib-flash'); }, 1400);
          }
        }
      }
      function scheduleRender() { clearTimeout(renderT); renderT = setTimeout(render, 40); }

      function autosize(list) {
        if (FIELD_SIZING || !list.length) return;
        var sc = scroller(), st = sc ? sc.scrollTop : 0;
        list.forEach(function (t) { t.style.height = '0px'; });
        var hs = list.map(function (t) { return t.scrollHeight; });
        list.forEach(function (t, i) { t.style.height = (hs[i] + 2) + 'px'; });
        if (sc) sc.scrollTop = st;
      }

      /* ---------------- header: tabs + quick add ---------------- */
      function tabEmpty() { return tab === 'research' ? !Kit.list('research').length : !Kit.list('idea').length; }
      /* the capture box: in the sticky top bar, or front and centre when the tab is empty */
      function qaForm(hero) {
        var isR = tab === 'research';
        var ph = hero ? (isR ? 'Paste a link to start your research library…' : 'Jot an idea… (#tags)') : 'Paste a link or jot an idea… (#tags)';
        return '<form class="lib-qa' + (hero ? ' is-hero' : '') + '" data-k="qa-form" autocomplete="off" novalidate>' +
          '<label class="lib-qa-field" data-k="qa-field"><span class="lib-qa-plus">' + Kit.ICONS.plus + '</span>' +
            '<input class="lib-qa-in" id="lib-qa" data-k="qa" type="text" enterkeyhint="done" autocapitalize="sentences" placeholder="' + attr(ph) + '" aria-label="Quick add to ' + (isR ? 'Research' : 'Ideas') + '">' +
            (hero ? '' : '<span class="kbd lib-qa-kbd" aria-hidden="true" title="Press / to jump here">/</span>') + '</label>' +
          '<button class="btn primary lib-qa-btn" data-k="qa-btn" type="submit">' + (hero ? (isR ? 'Add source' : 'Add idea') : 'Add') + '</button>' +
          (hero ? '' : '<div class="lib-qa-hint" data-k="qa-hint">' + (isR
            ? 'Adds a source to read. Wikipedia links name themselves; other links use the site and page name.'
            : 'Adds a raw idea dated today. A link in the text is kept as its inspiration.') +
            ' <b>#word</b> adds a tag; <b>#E01</b>, <b>#P04</b> or <b>#TL01</b> links to that page.</div>') +
        '</form>';
      }
      function headHtml() {
        function tabBtn(t, ico, name, n) {
          return '<button type="button" class="lib-tab" data-k="tab-' + t + '" data-act="tab" data-tab="' + t + '"' + (tab === t ? ' aria-current="page"' : '') + '>' +
            '<span class="lib-tab-ico">' + ico + '</span>' + name + '<span class="lib-tab-n">' + n + '</span></button>';
        }
        return '<div class="lib-top' + (tabEmpty() ? ' is-bare' : '') + '" data-k="top">' +
          '<nav class="lib-tabs" data-k="tabs" aria-label="Library">' +
            tabBtn('research', 'RES', 'Research', Kit.list('research').length) + tabBtn('ideas', 'IDA', 'Ideas', Kit.list('idea').length) +
          '</nav>' + (tabEmpty() ? '' : qaForm(false)) + '</div>';
      }
      function tip(code, text) { return '<li><b>' + esc(code) + '</b><span>' + esc(text) + '</span></li>'; }
      /* empty research library: say what goes here, and capture the first link right here */
      function heroResearch() {
        return '<section class="lib-hero" data-k="hero-r" aria-labelledby="lib-hero-h">' +
          '<span class="lib-hero-ico" aria-hidden="true">RES</span>' +
          '<h2 id="lib-hero-h">Start your research library</h2>' +
          '<p>Every source the game leans on: Wikipedia pages, books, archive scans, articles. Read each one, then mark it verified once the facts check out. ' +
            'Anything a puzzle relies on that isn\'t verified gets flagged here, because players will Google everything.</p>' +
          '<div class="lib-hero-flow" aria-hidden="true"><span class="lib-stag st-to-read">To read</span><i></i><span class="lib-stag st-read">Read</span><i></i><span class="lib-stag st-verified">Verified</span></div>' +
          qaForm(true) +
          '<ul class="lib-hero-tips">' +
            tip('en.wikipedia.org/wiki/Tunguska_event', 'is saved as “Tunguska event”') +
            tip('#1908', 'adds a tag') +
            tip('#E01', 'says which event it supports') +
          '</ul></section>';
      }
      /* empty idea board: capture box front and centre, the four lanes waiting underneath */
      function heroIdeas(phone) {
        var h = '<section class="lib-hero is-ideas" data-k="hero-i" aria-labelledby="lib-hero-h">' +
          '<span class="lib-hero-ico" aria-hidden="true">IDA</span>' +
          '<h2 id="lib-hero-h">Catch ideas before they get away</h2>' +
          '<p>Half-thoughts, odd facts, a link you\'ll want later. New ideas land in Raw. Move them along as you work on them, and promote the good ones into a puzzle, event, character, question, research or note.</p>' +
          qaForm(true) +
          '<ul class="lib-hero-tips">' +
            tip('#audio', 'adds a tag') +
            tip('https://…', 'a pasted link is kept as its inspiration') +
            tip('#E01', 'links it to an event') +
          '</ul></section>';
        if (phone) {
          h += '<div class="lib-lanes" data-k="lanes" aria-label="How ideas move">' + IDEA_ST.map(function (s) {
            return '<div class="lib-lane col-' + s[0] + '"><span class="lib-col-name">' + s[1] + '</span><span class="lib-col-d">' + s[2] + '</span></div>';
          }).join('') + '</div>';
        } else {
          h += '<div class="id-board is-empty" data-k="board-empty">' + IDEA_ST.map(function (s) {
            return '<section class="lib-col col-' + s[0] + '" data-k="col:' + s[0] + '" aria-label="' + s[1] + ' ideas">' +
              '<header class="lib-col-h"><span class="lib-col-name">' + s[1] + '</span><span class="count">0</span><span class="lib-col-d">' + s[2] + '</span></header>' +
              '<div class="lib-col-body" data-k="cb"><div class="lib-col-empty" data-k="ce">' + {
                raw: 'Your first idea lands here.',
                exploring: 'Ideas you are working out.',
                used: 'Ideas that made it into the game. Promoting one moves it here.',
                parked: 'Not now, but not deleted.',
              }[s[0]] + '</div></div></section>';
          }).join('') + '</div>';
        }
        return h;
      }

      /* ================= RESEARCH ================= */
      function hay(o) {
        var parts = [o.id, o.title, o.text, o.author, o.year, o.url, o.excerpt, o.notes, (o.tags || []).join(' '), o.kind, o.reliability, o.status];
        (o.supports || o.links || []).forEach(function (x) { parts.push(x, Kit.label(x)); });
        return parts.filter(function (x) { return x != null; }).join(' ').toLowerCase();
      }
      function matchQ(o, q) {
        var h = hay(o);
        return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (t) { return h.indexOf(t) >= 0; });
      }
      function passR(r, except) {
        var f = S.rs;
        if (except !== 'status' && f.status !== 'all' && r.status !== f.status) return false;
        if (except !== 'rel' && f.rel.length && f.rel.indexOf(r.reliability) < 0) return false;
        if (except !== 'tags' && f.tags.length && !(r.tags || []).some(function (t) { return f.tags.indexOf(t) >= 0; })) return false;
        if (except !== 'unlinked' && f.unlinked && (r.supports || []).length) return false;
        if (f.q.trim() && !matchQ(r, f.q)) return false;
        return true;
      }
      function filtersActiveR() { var f = S.rs; return f.status !== 'all' || f.rel.length || f.tags.length || f.unlinked || f.q.trim(); }
      function clearFiltersR() { var g = S.rs.group; S.rs = { status: 'all', rel: [], tags: [], unlinked: false, q: '', group: g }; }
      function newestFirst(a, b) { return num(b.id) - num(a.id) || (a.id < b.id ? 1 : -1); }

      function viewResearch() {
        var all = Kit.list('research');
        if (!all.length) return heroResearch();
        var list = all.filter(function (r) { return passR(r); }).sort(newestFirst);
        var h = riskHtml() + toolbarR(all, list.length);
        if (!list.length) {
          h += '<div class="lib-empty" data-k="empty-f"><b>Nothing matches these filters.</b><button type="button" class="btn sm" data-act="f-clear">Clear filters</button></div>';
        } else h += groupsR(list);
        return h;
      }

      function riskHtml() {
        var items = Kit.list('research').filter(isRisk).sort(function (a, b) {
          var o = { 'to read': 0, read: 1 }; return (o[a.status] - o[b.status]) || num(a.id) - num(b.id);
        });
        if (!items.length) {
          return '<div class="lib-risk is-ok" data-k="risk-ok"><span class="lib-risk-ic ok">' + IC.check + '</span>Every source a puzzle relies on is verified.</div>';
        }
        var open = !riskCollapsed();
        var h = '<section class="lib-risk" data-k="risk" aria-label="Unverified research that puzzles rely on">' +
          '<button type="button" class="lib-risk-h" data-k="risk-h" data-act="risk-toggle" aria-expanded="' + open + '">' +
            '<span class="lib-risk-ic">' + IC.warn + '</span>' +
            '<span class="lib-risk-t"><b>' + plural(items.length, 'source') + ' that puzzles rely on ' + (items.length === 1 ? 'is' : 'are') + ' not verified.</b> ' +
            '<span class="lib-risk-why">Players will Google everything. Check these before anything else.</span></span>' + IC.chev + '</button>';
        if (open) {
          var RISK_CAP = 5, more = items.length - RISK_CAP;
          var shownItems = S.riskAll || more <= 1 ? items : items.slice(0, RISK_CAP);
          h += '<div class="lib-risk-list" data-k="risk-list">' + shownItems.map(function (r) {
            return '<div class="lib-risk-row" data-k="rr:' + attr(r.id) + '">' +
              '<button type="button" class="lib-risk-jump" data-act="jump" data-id="' + attr(r.id) + '" title="Show this card">' +
                '<span class="id">' + esc(r.id) + '</span><span class="lib-risk-name">' + esc(r.title || 'Untitled source') + '</span></button>' +
              '<span class="lib-risk-meta"><span class="lib-stag st-' + cls(r.status) + '">' + esc(resLabel(r.status)) + '</span>' +
              '<span class="lib-risk-deps"><span class="faint">relied on by</span>' + depsHtml(r) + '</span></span>' +
              '<button type="button" class="btn sm lib-verify" data-act="verify" data-id="' + attr(r.id) + '">' + IC.check + 'Mark verified</button>' +
            '</div>';
          }).join('') +
          (more > 1 ? '<button type="button" class="lib-risk-more" data-k="risk-more" data-act="risk-all" aria-expanded="' + !!S.riskAll + '">' +
            (S.riskAll ? 'Show the first ' + RISK_CAP : 'Show ' + more + ' more') + '</button>' : '') + '</div>';
        }
        return h + '</section>';
      }

      /* "P04" for a puzzle it supports directly; "P01 via E01" for puzzles inside an event it supports */
      function depsHtml(r) {
        var rel = reliance(r), seen = {}, out = [];
        rel.direct.forEach(function (p) { seen[p] = 1; out.push(Kit.refHtml(p, { idOnly: true })); });
        rel.via.forEach(function (v) {
          var ps = v.ps.filter(function (p) { return !seen[p]; });
          if (!ps.length) return;
          ps.forEach(function (p) { seen[p] = 1; });
          out.push('<span class="lib-via">' + ps.map(function (p) { return Kit.refHtml(p, { idOnly: true }); }).join('') + '<span class="faint">via</span>' + Kit.refHtml(v.ev, { idOnly: true }) + '</span>');
        });
        return out.join('');
      }
      function relianceTitle(r) {
        var rel = reliance(r), parts = rel.direct.slice();
        rel.via.forEach(function (v) { parts.push(v.ps.join(', ') + ' (inside ' + v.ev + ')'); });
        return 'Not verified, and these puzzles depend on it: ' + parts.join('; ');
      }
      function searchHtml(key, val, label) {
        return '<label class="lib-search" data-k="srch-' + key + '">' + Kit.ICONS.search +
          '<input class="input" type="search" data-k="' + key + '" data-act="q" value="' + attr(val) + '" placeholder="' + attr(label) + '" aria-label="' + attr(label) + '" autocomplete="off" spellcheck="false"></label>';
      }
      function fchip(act, v, label, n, on, tone, extra) {
        return '<button type="button" class="lib-fchip ' + (tone || '') + (n ? '' : ' zero') + '" data-k="' + act + ':' + attr(v) + '" data-act="' + act + '" data-v="' + attr(v) + '" aria-pressed="' + !!on + '">' +
          (extra || '') + '<span>' + esc(label) + '</span><span class="n">' + n + '</span></button>';
      }

      function toolbarR(all, shown) {
        var f = S.rs;
        var cnt = { all: 0, 'to read': 0, read: 0, verified: 0 };
        all.forEach(function (r) { if (passR(r, 'status')) { cnt.all++; cnt[r.status] = (cnt[r.status] || 0) + 1; } });
        var seg = '<div class="seg lib-seg" data-k="seg-st" role="group" aria-label="Filter by reading status">' +
          [['all', 'All']].concat(RES_STATUS).map(function (s) {
            return '<button type="button" class="v-' + cls(s[0]) + '" data-k="fs:' + cls(s[0]) + '" data-act="f-status" data-v="' + s[0] + '" aria-pressed="' + (f.status === s[0]) + '">' +
              esc(s[1]) + '<span class="n">' + (cnt[s[0]] || 0) + '</span></button>';
          }).join('') + '</div>';
        var relC = {};
        all.forEach(function (r) { if (passR(r, 'rel')) relC[r.reliability] = (relC[r.reliability] || 0) + 1; });
        var rel = REL.map(function (x) { return fchip('f-rel', x[0], x[1], relC[x[0]] || 0, f.rel.indexOf(x[0]) >= 0, x[2], '<i class="dot"></i>'); }).join('');
        var tagC = {};
        all.forEach(function (r) { (r.tags || []).forEach(function (t) { if (!(t in tagC)) tagC[t] = 0; }); });
        f.tags.forEach(function (t) { if (!(t in tagC)) tagC[t] = 0; });
        all.forEach(function (r) { if (passR(r, 'tags')) (r.tags || []).forEach(function (t) { tagC[t]++; }); });
        var tagKeys = Object.keys(tagC).sort(function (a, b) { return tagC[b] - tagC[a] || (a < b ? -1 : 1); });
        var tags = tagKeys.map(function (t) { return fchip('f-tag', t, '#' + t, tagC[t], f.tags.indexOf(t) >= 0, ''); }).join('');
        var unl = all.filter(function (r) { return passR(r, 'unlinked') && !(r.supports || []).length; }).length;
        var groupSel = '<label class="lib-group" data-k="grp-l">Group by <select class="input" data-k="f-group" data-act="f-group" aria-label="Group research by">' +
          GROUPS.map(function (g) { return '<option value="' + g[0] + '"' + (f.group === g[0] ? ' selected' : '') + '>' + g[1] + '</option>'; }).join('') + '</select></label>';
        var hidden = f.rel.length + f.tags.length + (f.unlinked ? 1 : 0) + (f.group !== 'none' ? 1 : 0);
        return '<div class="lib-tb' + (S.rsMore ? ' is-open' : '') + '" data-k="tb-r">' +
          '<div class="lib-tb-row" data-k="tb-r1">' + searchHtml('rq', f.q, 'Search research') +
            '<button type="button" class="btn lib-ffold" data-k="ffold" data-act="f-fold" aria-expanded="' + S.rsMore + '">Filters' + (hidden ? '<span class="lib-ffold-n">' + hidden + '</span>' : '') + IC.chev + '</button>' +
            '<div class="lib-seg-wrap" data-k="segw">' + seg + '</div>' +
            '<div class="lib-tb-more lib-tb-inline" data-k="more1">' +
              '<button type="button" class="lib-switch" data-k="f-unl" data-act="f-unlinked" aria-pressed="' + f.unlinked + '"><span class="tr" aria-hidden="true"></span>Not linked to anything<span class="n">' + unl + '</span></button>' +
              '<span class="lib-sp" data-k="sp"></span>' + groupSel +
            '</div>' +
          '</div>' +
          '<div class="lib-tb-row lib-facets lib-tb-more" data-k="tb-r2">' +
            '<div class="lib-facet" data-k="fac-rel"><span class="eyebrow">Trust</span>' + rel + '</div>' +
            (tagKeys.length ? '<div class="lib-facet lib-facet-tags" data-k="fac-tags"><span class="eyebrow">Tags</span><div class="lib-chips" data-k="chips">' + tags + '</div></div>' : '') +
          '</div>' +
          (filtersActiveR() && shown ? '<div class="lib-shown" data-k="shown">Showing ' + shown + ' of ' + all.length + '<button type="button" class="linkish" data-act="f-clear">Clear filters</button></div>' : '') +
        '</div>';
      }

      function groupsR(list) {
        var g = S.rs.group;
        if (g === 'none') return '<div class="rs-list" data-k="list-none">' + list.map(cardR).join('') + '</div>';
        var groups = [];
        if (g === 'status') {
          RES_STATUS.forEach(function (s) {
            groups.push({ key: cls(s[0]), label: '<span class="lib-stag st-' + cls(s[0]) + '">' + esc(s[1]) + '</span>', items: list.filter(function (r) { return r.status === s[0]; }) });
          });
        } else if (g === 'tag') {
          var tc = {};
          list.forEach(function (r) { (r.tags || []).forEach(function (t) { tc[t] = (tc[t] || 0) + 1; }); });
          Object.keys(tc).sort(function (a, b) { return tc[b] - tc[a] || (a < b ? -1 : 1); }).forEach(function (t) {
            groups.push({ key: 't-' + t, label: '<span class="lib-grp-tag">#' + esc(t) + '</span>', items: list.filter(function (r) { return (r.tags || []).indexOf(t) >= 0; }) });
          });
          groups.push({ key: 'none', label: '<span class="muted">No tags</span>', items: list.filter(function (r) { return !(r.tags || []).length; }) });
        } else if (g === 'event') {
          /* events in trail order: chapter by chapter, then the ones not placed yet */
          var evs = [];
          Kit.chapters().forEach(function (c) { Kit.eventsIn(c.id).forEach(function (ev) { evs.push({ ev: ev, ch: c }); }); });
          Kit.eventsIn(null).forEach(function (ev) { evs.push({ ev: ev, ch: null }); });
          evs.forEach(function (x) {
            var where = x.ch ? 'Ch ' + x.ch.n + ' · ' + x.ch.title : 'Not placed';
            groups.push({ key: 'e-' + x.ev.id, label: '<span class="lib-grp-ch" title="' + attr(where) + '">' + esc(where) + '</span>' + Kit.refHtml(x.ev.id),
              items: list.filter(function (r) { return (r.supports || []).indexOf(x.ev.id) >= 0; }) });
          });
          groups.push({ key: 'none', label: '<span class="muted">Not tied to an event</span>', items: list.filter(function (r) { return !(r.supports || []).some(function (x) { return Kit.type(x) === 'event'; }); }) });
        }
        var note = g === 'tag' || g === 'event' ? '<p class="lib-grp-note" data-k="gnote">A source with several ' + (g === 'tag' ? 'tags' : 'events') + ' appears in each group.</p>' : '';
        return note + groups.filter(function (x) { return x.items.length; }).map(function (x) {
          return '<section class="rs-grp" data-k="g:' + attr(g + ':' + x.key) + '"><h3 class="rs-grp-h">' + x.label + '<span class="count">' + x.items.length + '</span></h3>' +
            '<div class="rs-list">' + x.items.map(cardR).join('') + '</div></section>';
        }).join('');
      }

      function ta(id, field, val, klass, label, ph) {
        return '<textarea class="lib-ta ' + klass + '" data-k="' + attr(id + ':' + field) + '" data-id="' + attr(id) + '" data-field="' + field + '" rows="1" aria-label="' + attr(label + ', ' + id) + '" placeholder="' + attr(ph) + '">' + esc(val || '') + '</textarea>';
      }
      function prop(key, label, val) {
        return '<div class="lib-prop" data-k="p:' + key + '"><span class="lib-prop-l">' + label + '</span><div class="lib-prop-v">' + val + '</div></div>';
      }
      function refsHtml(id, field, ids) {
        return '<div class="lib-refs" data-k="refs-' + field + '">' + (ids || []).map(function (x) {
          return '<span class="lib-refx" data-k="rx:' + attr(x) + '">' + Kit.refHtml(x) +
            '<button type="button" class="lib-x" data-act="link-rm" data-id="' + attr(id) + '" data-f="' + field + '" data-v="' + attr(x) + '" aria-label="Unlink ' + attr(x) + ' from ' + attr(id) + '" title="Unlink">' + IC.x + '</button></span>';
        }).join('') +
          '<button type="button" class="lib-add" data-k="add-' + field + '" data-act="link-add" data-id="' + attr(id) + '" data-f="' + field + '">+ Link</button></div>';
      }
      function tagsHtml(id, tags) {
        return '<div class="lib-tags" data-k="tags">' + (tags || []).map(function (t) {
          return '<span class="lib-tag" data-k="t:' + attr(t) + '">#' + esc(t) +
            '<button type="button" class="lib-x" data-act="tag-rm" data-id="' + attr(id) + '" data-v="' + attr(t) + '" aria-label="Remove tag ' + attr(t) + '" title="Remove tag">' + IC.x + '</button></span>';
        }).join('') +
          '<input class="lib-tagin" data-k="tagin" data-id="' + attr(id) + '" type="text" placeholder="+ tag" aria-label="Add a tag to ' + attr(id) + '" enterkeyhint="done" autocapitalize="none" autocomplete="off" spellcheck="false"></div>';
      }
      function confirmHtml(id) {
        return '<span class="lib-confirm" data-k="confirm" role="group" aria-label="Confirm delete"><span>Delete ' + esc(id) + '?</span>' +
          '<button type="button" class="btn sm danger" data-act="del-yes" data-id="' + attr(id) + '">Delete</button>' +
          '<button type="button" class="btn sm ghost" data-act="del-no">Cancel</button></span>';
      }

      function cardR(r) {
        var id = r.id, risk = isRisk(r), ri = relInfo(r.reliability), det = !!S.details[id];
        var h = '<article class="lib-card rs-card st-' + cls(r.status) + (risk ? ' is-risk' : '') + (S.sel === id ? ' is-sel' : '') + '" data-k="card:' + attr(id) + '" data-id="' + attr(id) + '" aria-label="' + attr('Research ' + id + ': ' + (r.title || '')) + '">';
        /* title row */
        h += '<div class="rs-top" data-k="top"><div class="rs-head" data-k="head"><span class="id">' + esc(id) + '</span>' + ta(id, 'title', r.title, 'rs-title', 'Title', 'Untitled source') + '</div>' +
          '<div class="rs-acts" data-k="acts">' + (S.confirmDel === id ? confirmHtml(id) :
            '<button type="button" class="btn sm ghost" data-k="a-open" data-act="open" data-id="' + attr(id) + '">Open page</button>' +
            '<button type="button" class="btn sm ghost" data-k="a-copy" data-act="copy" data-id="' + attr(id) + '" title="Copy this source as JSON for an LLM">' + Kit.ICONS.copy + 'Copy for LLM</button>' +
            '<button type="button" class="btn sm ghost lib-del" data-k="a-del" data-act="del" data-id="' + attr(id) + '">Delete</button>') +
          '</div></div>';
        /* left: meta, details, excerpt, notes · right: properties */
        var meta = [];
        if (r.url) meta.push('<a class="rs-dom" href="' + attr(r.url) + '" target="_blank" rel="noopener" title="' + attr(r.url) + '">' + esc(Kit.domain(r.url) || r.url) + IC.ext + '</a>');
        else meta.push('<span class="faint">No link</span>');
        if (r.author) meta.push('<span>' + esc(r.author) + '</span>');
        if (r.year) meta.push('<span class="mono">' + esc(r.year) + '</span>');
        if (r.kind) meta.push('<span class="rs-kind">' + esc(r.kind) + '</span>');
        h += '<div class="rs-grid" data-k="grid"><div class="rs-main" data-k="main">' +
          '<div class="rs-meta" data-k="meta">' + meta.join('<span class="sep" aria-hidden="true">·</span>') +
            '<button type="button" class="lib-tool" data-k="det" data-act="details" data-id="' + attr(id) + '" aria-expanded="' + det + '">' + IC.pencil + '<span>' + (det ? 'Done' : 'Edit details') + '</span></button>' +
            (risk ? (function () { var ps = reliance(r).all; return '<span class="lib-mk" title="' + attr(relianceTitle(r)) + '">' + IC.warn + 'Unverified · ' + esc(ps.join(', ')) + (ps.length === 1 ? ' relies' : ' rely') + ' on it</span>'; })() : '') +
          '</div>';
        if (det) {
          h += '<div class="rs-det" data-k="det-row">' +
            '<label class="field f-url" data-k="d-url"><span class="field-label">Link</span><input class="input" type="url" inputmode="url" data-k="' + attr(id) + ':url" data-id="' + attr(id) + '" data-field="url" value="' + attr(r.url || '') + '" placeholder="https://…" autocomplete="off" spellcheck="false"></label>' +
            '<label class="field" data-k="d-author"><span class="field-label">Author or site</span><input class="input" type="text" data-k="' + attr(id) + ':author" data-id="' + attr(id) + '" data-field="author" value="' + attr(r.author || '') + '"></label>' +
            '<label class="field" data-k="d-year"><span class="field-label">Year</span><input class="input" type="text" inputmode="numeric" data-k="' + attr(id) + ':year" data-id="' + attr(id) + '" data-field="year" value="' + attr(r.year == null ? '' : r.year) + '" placeholder="—"></label>' +
            '<label class="field" data-k="d-kind"><span class="field-label">Kind</span><select class="input" data-k="' + attr(id) + ':kind" data-id="' + attr(id) + '" data-field="kind">' +
              RES_KINDS.map(function (k) { return '<option value="' + k + '"' + (r.kind === k ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select></label>' +
          '</div>';
        }
        var showEx = !!(r.excerpt || S.showField[id + ':excerpt']), showNo = !!(r.notes || S.showField[id + ':notes']);
        if (showEx) h += '<div class="rs-ex" data-k="ex">' + ta(id, 'excerpt', r.excerpt, 'doc rs-ex-ta', 'Excerpt', 'Paste the key quote…') + '</div>';
        if (showNo) h += '<div class="rs-no" data-k="no">' + ta(id, 'notes', r.notes, 'rs-notes', 'Notes', 'Notes…') + '</div>';
        if (!showEx || !showNo) {
          h += '<div class="rs-adds" data-k="adds">' +
            (showEx ? '' : '<button type="button" class="lib-add" data-k="add-ex" data-act="show-field" data-id="' + attr(id) + '" data-f="excerpt">+ Excerpt</button>') +
            (showNo ? '' : '<button type="button" class="lib-add" data-k="add-no" data-act="show-field" data-id="' + attr(id) + '" data-f="notes">+ Notes</button>') + '</div>';
        }
        h += '</div><div class="rs-props" data-k="props">' +
          prop('st', 'Status', '<div class="seg rs-st" role="group" aria-label="Reading status of ' + attr(id) + '">' + RES_STATUS.map(function (s) {
            return '<button type="button" class="v-' + cls(s[0]) + '" data-k="st:' + cls(s[0]) + '" data-act="st" data-id="' + attr(id) + '" data-v="' + s[0] + '" aria-pressed="' + (r.status === s[0]) + '">' +
              (s[0] === 'verified' ? IC.check : '') + esc(s[1]) + '</button>';
          }).join('') + '</div>' +
            '<select class="input rs-rel ' + ri[2] + '" data-k="rel" data-id="' + attr(id) + '" data-field="reliability" aria-label="Reliability of ' + attr(id) + '" title="How far to trust it">' +
            REL.map(function (x) { return '<option value="' + x[0] + '"' + (r.reliability === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select>') +
          prop('sup', 'Supports', refsHtml(id, 'supports', r.supports)) +
          prop('tags', 'Tags', tagsHtml(id, r.tags)) +
        '</div></div></article>';
        return h;
      }

      /* ================= IDEAS ================= */
      function passI(i, except) {
        var f = S.id;
        if (except !== 'tags' && f.tags.length && !(i.tags || []).some(function (t) { return f.tags.indexOf(t) >= 0; })) return false;
        if (f.q.trim() && !matchQ(i, f.q)) return false;
        return true;
      }
      function newestIdea(a, b) { return String(b.created || '').localeCompare(String(a.created || '')) || num(b.id) - num(a.id); }
      function isBoard() { return !ctx.isPhone(); }

      function viewIdeas() {
        var all = Kit.list('idea'), phone = !isBoard();
        if (!all.length) return heroIdeas(phone);
        var list = all.filter(function (i) { return passI(i); }).sort(newestIdea);
        var h = toolbarI(all, list, phone);
        if (phone) {
          var shown = S.id.status === 'all' ? list : list.filter(function (i) { return i.status === S.id.status; });
          if (!shown.length) {
            return h + '<div class="lib-empty" data-k="empty-f"><b>Nothing here.</b>' + (S.id.tags.length || S.id.q.trim() || S.id.status !== 'all'
              ? '<button type="button" class="btn sm" data-act="i-clear">Show all ideas</button>' : 'Jot an idea in the box above.') + '</div>';
          }
          return h + '<div class="id-list" data-k="id-list">' + shown.map(function (i) { return cardI(i, true); }).join('') + '</div>';
        }
        if (!list.length) return h + '<div class="lib-empty" data-k="empty-f"><b>No ideas match.</b><button type="button" class="btn sm" data-act="i-clear">Clear filters</button></div>';
        return h + '<div class="id-board" data-k="board">' + IDEA_ST.map(function (s) {
          var items = list.filter(function (i) { return i.status === s[0]; });
          return '<section class="lib-col col-' + s[0] + '" data-k="col:' + s[0] + '" data-status="' + s[0] + '" aria-label="' + s[1] + ' ideas">' +
            '<header class="lib-col-h"><span class="lib-col-name">' + s[1] + '</span><span class="count">' + items.length + '</span><span class="lib-col-d">' + s[2] + '</span></header>' +
            '<div class="lib-col-body" data-k="cb">' + (items.length ? items.map(function (i) { return cardI(i, false); }).join('')
              : '<div class="lib-col-empty" data-k="ce">' + (s[0] === 'raw' ? 'New ideas land here. Type one in the box above.' : 'Drag a card here, or use Move on a card.') + '</div>') + '</div></section>';
        }).join('') + '</div>';
      }

      function toolbarI(all, list, phone) {
        var f = S.id;
        var tagC = {};
        all.forEach(function (i) { (i.tags || []).forEach(function (t) { if (!(t in tagC)) tagC[t] = 0; }); });
        f.tags.forEach(function (t) { if (!(t in tagC)) tagC[t] = 0; });
        all.forEach(function (i) { if (passI(i, 'tags')) (i.tags || []).forEach(function (t) { tagC[t]++; }); });
        var tagKeys = Object.keys(tagC).sort(function (a, b) { return tagC[b] - tagC[a] || (a < b ? -1 : 1); });
        var h = '<div class="lib-tb" data-k="tb-i"><div class="lib-tb-row" data-k="tb-i1">' + searchHtml('iq', f.q, 'Search ideas');
        if (phone) {
          var c = { all: list.length };
          list.forEach(function (i) { c[i.status] = (c[i.status] || 0) + 1; });
          h += '<div class="lib-seg-wrap" data-k="segw"><div class="seg lib-seg" role="group" aria-label="Show ideas by status">' +
            [['all', 'All']].concat(IDEA_ST).map(function (s) {
              return '<button type="button" data-k="is:' + s[0] + '" data-act="i-status" data-v="' + s[0] + '" aria-pressed="' + (f.status === s[0]) + '">' + s[1] + '<span class="n">' + (c[s[0]] || 0) + '</span></button>';
            }).join('') + '</div></div>';
        } else {
          h += '<span class="lib-sp" data-k="sp"></span><span class="lib-hint" data-k="hint">Drag a card to another column, or use <b>Move</b> on the card. <b>Promote</b> turns an idea into a puzzle, event or page.</span>';
        }
        h += '</div>';
        if (tagKeys.length) {
          h += '<div class="lib-tb-row lib-facets" data-k="tb-i2"><div class="lib-facet lib-facet-tags" data-k="fac-tags"><span class="eyebrow">Tags</span><div class="lib-chips" data-k="chips">' +
            tagKeys.map(function (t) { return fchip('i-tag', t, '#' + t, tagC[t], f.tags.indexOf(t) >= 0, ''); }).join('') + '</div></div></div>';
        }
        if ((f.tags.length || f.q.trim()) && list.length) h += '<div class="lib-shown" data-k="shown">Showing ' + list.length + ' of ' + all.length + '<button type="button" class="linkish" data-act="i-clear">Clear filters</button></div>';
        return h + '</div>';
      }

      function menuBtn(id, kind, label, opts) {
        opts = opts || {};
        var open = !!(S.menu && S.menu.id === id && S.menu.kind === kind);
        return '<span class="lib-mw' + (opts.right ? ' right' : '') + '" data-k="mw:' + kind + '">' +
          '<button type="button" class="btn sm lib-mbtn' + (opts.icon ? ' icon' : '') + '" data-act="menu" data-id="' + attr(id) + '" data-menu="' + kind + '" aria-haspopup="menu" aria-expanded="' + open + '"' + (opts.aria ? ' aria-label="' + attr(opts.aria) + '" title="' + attr(opts.aria) + '"' : '') + '>' +
            (opts.icon || (esc(label) + IC.chev)) + '</button>' +
          (open ? menuHtml(id, kind) : '') + '</span>';
      }
      function menuHtml(id, kind) {
        var o = Kit.get(id) || {}, items = [];
        if (kind === 'promote') {
          items = PROMOTE.map(function (t) { return { act: 'promote', v: t, ic: Kit.TYPES[t].icon, label: Kit.TYPES[t].label }; });
        } else if (kind === 'move') {
          items = IDEA_ST.filter(function (s) { return s[0] !== o.status; }).map(function (s) { return { act: 'move', v: s[0], ic: '<i class="lib-dot s-' + s[0] + '"></i>', label: 'Move to ' + s[1] }; });
        } else {
          items = [{ act: 'open', v: '', ic: 'PG', label: 'Open page' }, { act: 'copy', v: '', ic: 'JSON', label: 'Copy for LLM' }, { act: 'del', v: '', ic: '×', label: 'Delete…', danger: true }];
        }
        var head = kind === 'promote' ? '<div class="lib-menu-h">Create from ' + esc(id) + '</div>' : '';
        return '<div class="lib-menu m-' + kind + '" data-k="menu" role="menu" aria-label="' + attr(kind === 'promote' ? 'Promote to' : kind === 'move' ? 'Move to' : 'More actions') + '">' + head +
          items.map(function (it) {
            return '<button type="button" role="menuitem" class="lib-mi' + (it.danger ? ' danger' : '') + '" data-act="' + it.act + '" data-id="' + attr(id) + '" data-v="' + attr(it.v) + '"><span class="lib-mi-ic">' + it.ic + '</span>' + esc(it.label) + '</button>';
          }).join('') + '</div>';
      }

      function cardI(i, listMode) {
        var id = i.id, det = !!S.details[id], st = ideaInfo(i.status);
        var menuOpen = S.menu && S.menu.id === id;
        var h = '<article class="lib-card id-card s-' + cls(i.status) + (S.sel === id ? ' is-sel' : '') + (menuOpen ? ' has-menu' : '') + '" data-k="card:' + attr(id) + '" data-id="' + attr(id) + '" aria-label="' + attr('Idea ' + id) + '">';
        h += '<div class="id-top" data-k="top">' + (listMode ? '' : '<span class="id-grip" title="Drag to another column">' + IC.grip + '</span>') +
          '<span class="id">' + esc(id) + '</span>' +
          (listMode ? '<span class="lib-stag s-' + cls(i.status) + '">' + esc(st[1]) + '</span>' : '') +
          '<span class="id-date" title="Captured ' + attr(Kit.fmtDate(i.created)) + '">' + esc(i.created ? Kit.fmtDate(i.created, { noYear: Kit.year(i.created) === todayYear() }) : '—') + '</span></div>';
        h += ta(id, 'text', i.text, 'id-text', 'Idea', 'Write the idea…');
        h += '<div class="id-url" data-k="url">' + (i.url ? '<a class="rs-dom" href="' + attr(i.url) + '" target="_blank" rel="noopener" title="' + attr(i.url) + '">' + esc(Kit.domain(i.url) || i.url) + IC.ext + '</a>' : '') +
          '<button type="button" class="lib-tool" data-k="det" data-act="details" data-id="' + attr(id) + '" aria-expanded="' + det + '">' + (i.url ? IC.pencil + '<span>' + (det ? 'Done' : 'Edit') + '</span>' : '<span>' + (det ? 'Done' : '+ Inspiration link') + '</span>') + '</button></div>';
        if (det) {
          h += '<div class="id-det" data-k="det-row">' +
            '<label class="field" data-k="d-url"><span class="field-label">Link</span><input class="input" type="url" inputmode="url" data-k="' + attr(id) + ':url" data-id="' + attr(id) + '" data-field="url" value="' + attr(i.url || '') + '" placeholder="https://…" autocomplete="off" spellcheck="false"></label>' +
            '<label class="field" data-k="d-created"><span class="field-label">Captured</span><input class="input" type="date" data-k="' + attr(id) + ':created" data-id="' + attr(id) + '" data-field="created" value="' + attr(i.created || '') + '"></label></div>';
        }
        h += '<div class="id-row" data-k="r-tags"><span class="id-row-l">Tags</span>' + tagsHtml(id, i.tags) + '</div>';
        h += '<div class="id-row" data-k="r-links"><span class="id-row-l">Links</span>' + refsHtml(id, 'links', i.links) + '</div>';
        var pid = S.promoted[id];
        if (pid && Kit.has(pid) && (i.links || []).indexOf(pid) >= 0) {
          var pt = Kit.type(pid), po = Kit.get(pid), where = '';
          if (pt === 'event') where = po.chapter ? '' : ', not in a chapter yet';
          else if (pt === 'puzzle') where = po.event ? ' in ' + po.event : ', not inside an event yet';
          h += '<div class="id-promoted" data-k="promoted"><span>Created <b>' + esc(pid) + '</b> · ' + esc(Kit.typeName(pid).toLowerCase() + where) + '</span><button type="button" class="btn sm" data-act="open" data-id="' + attr(pid) + '">Open ' + esc(pid) + '</button></div>';
        }
        h += '<div class="id-foot" data-k="foot">' + (S.confirmDel === id ? confirmHtml(id) :
          menuBtn(id, 'promote', 'Promote to…') + menuBtn(id, 'move', 'Move') + '<span class="lib-sp"></span>' +
          menuBtn(id, 'more', '', { icon: IC.dots, aria: 'More actions for ' + id, right: true })) + '</div>';
        return h + '</article>';
      }

      /* ---------------- status bar ---------------- */
      function setStatus() {
        if (tab === 'research') {
          var R = Kit.list('research'), by = { 'to read': 0, read: 0, verified: 0 };
          if (!R.length) { ctx.setStatus(['Library · Research', 'No sources yet: paste a link to start']); return; }
          R.forEach(function (r) { by[r.status] = (by[r.status] || 0) + 1; });
          var risk = R.filter(isRisk).length, unl = R.filter(function (r) { return !(r.supports || []).length; }).length;
          var shown = R.filter(function (r) { return passR(r); }).length;
          ctx.setStatus(['Library · Research', plural(R.length, 'source'), by.verified + ' verified', by['to read'] + ' to read',
            risk ? risk + ' unverified that puzzles rely on' : 'puzzle sources verified',
            unl ? unl + ' not linked' : null, shown !== R.length ? 'showing ' + shown : null]);
        } else {
          var I = Kit.list('idea'), c = {};
          if (!I.length) { ctx.setStatus(['Library · Ideas', 'No ideas yet: jot one to start']); return; }
          I.forEach(function (i) { c[i.status] = (c[i.status] || 0) + 1; });
          ctx.setStatus(['Library · Ideas', plural(I.length, 'idea')].concat(IDEA_ST.map(function (s) { return (c[s[0]] || 0) + ' ' + s[1].toLowerCase(); })));
        }
      }

      /* ---------------- actions ---------------- */
      function quickAdd(input) {
        var raw = input.value.trim();
        if (!raw) { input.focus(); return; }
        var p = parseQuick(raw), hadFocus = document.activeElement === input;
        function keepFocus() {
          var q = root.querySelector('.lib-qa-in');
          if (hadFocus && q && q !== document.activeElement) q.focus({ preventScroll: true });
        }
        if (tab === 'research') {
          if (p.url) {
            var dup = Kit.list('research').filter(function (r) { return r.url && normUrl(r.url) === normUrl(p.url); })[0];
            if (dup) {
              input.value = '';
              if (!passR(dup)) clearFiltersR();
              S.flash = dup.id; render();
              Kit.toast('Already in Research as ' + dup.id + ' · ' + (dup.title || ''));
              return;
            }
          }
          var t = p.url ? titleFromUrl(p.url) : { title: p.bare, author: '' };
          var obj = {
            title: t.title || p.bare || p.text || 'Untitled source', url: p.url || null, author: t.author || '',
            kind: p.url ? 'web' : 'other', reliability: 'popular', status: 'to read',
            notes: p.url ? p.bare : '', excerpt: '', tags: p.tags, supports: p.refs,
          };
          var snap = Kit.snapshot();
          var nid = Kit.create('research', obj);
          input.value = '';
          var o = Kit.get(nid);
          if (!passR(o)) clearFiltersR();
          S.flash = nid; render(); keepFocus();
          Kit.toast('Added ' + nid + ' · ' + o.title, { label: 'Undo', run: function () { Kit.restore(snap); Kit.toast('Removed ' + nid); } });
        } else {
          var text = p.text || (p.url ? titleFromUrl(p.url).title : '');
          var snap2 = Kit.snapshot();
          var iid = Kit.create('idea', { text: text, url: p.url || null, tags: p.tags, status: 'raw', created: Kit.todayIso(), links: p.refs });
          input.value = '';
          if (!passI(Kit.get(iid))) S.id.tags = [], S.id.q = '';
          if (S.id.status !== 'all' && S.id.status !== 'raw') S.id.status = 'all';
          S.flash = iid; render(); keepFocus();
          Kit.toast('Added ' + iid + ' to Ideas', { label: 'Undo', run: function () { Kit.restore(snap2); Kit.toast('Removed ' + iid); } });
        }
      }

      function commitField(el) {
        var id = el.getAttribute('data-id'), f = el.getAttribute('data-field'), o = Kit.get(id);
        if (!o || !f) return;
        var v = el.value, patch = {};
        if (f === 'year') { v = v.trim(); v = v === '' ? null : (isNaN(+v) ? o.year : +v); }
        else if (f === 'url') { v = v.trim(); if (v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'https://' + v; v = v || null; }
        else if (f === 'title') { v = v.replace(/\s*\n\s*/g, ' ').trim(); if (!v) return; }
        else if (f === 'created') { v = v || o.created; }
        if ((o[f] == null ? '' : o[f]) === (v == null ? '' : v)) return;
        patch[f] = v;
        Kit.update(id, patch);
      }
      function scheduleLive(el) {
        clearTimeout(liveT); liveEl = el;
        liveT = setTimeout(function () { var e = liveEl; liveEl = null; if (e && e.isConnected) commitField(e); }, 600);
      }
      function flushLive() { clearTimeout(liveT); var e = liveEl; liveEl = null; if (e && e.isConnected) commitField(e); }

      function addTags(input) {
        var id = input.getAttribute('data-id'), o = Kit.get(id);
        var raw = input.value; input.value = '';
        if (!o) return;
        var add = raw.split(/[\s,]+/).map(normTag).filter(Boolean);
        var cur = (o.tags || []).slice(), changed = false;
        add.forEach(function (t) { if (cur.indexOf(t) < 0) { cur.push(t); changed = true; } });
        if (changed) Kit.update(id, { tags: cur });
      }
      function linkAdd(id, field, btn) {
        var o = Kit.get(id); if (!o) return;
        var cur = (o[field] || []).slice();
        Kit.pick({
          title: (field === 'supports' ? 'What does ' : 'Link ') + id + (field === 'supports' ? ' support?' : ' to…'),
          types: field === 'supports' ? LINK_TYPES : undefined,
          exclude: [id].concat(cur),
          onPick: function (x) {
            var now = Kit.get(id); if (!now) return;
            var arr = (now[field] || []).slice();
            if (arr.indexOf(x) < 0) arr.push(x);
            var patch = {}; patch[field] = arr;
            Kit.update(id, patch);
            Kit.toast('Linked ' + id + ' to ' + x + ' · ' + Kit.label(x));
            render();
            var b = root.querySelector('.lib-card[data-id="' + id + '"] [data-act="link-add"]');
            if (b) b.focus({ preventScroll: true });
          },
        });
      }
      function linkRm(id, field, x) {
        var o = Kit.get(id); if (!o) return;
        var patch = {}; patch[field] = (o[field] || []).filter(function (v) { return v !== x; });
        Kit.update(id, patch);
      }
      function copyEntity(id) {
        if (!Kit.has(id)) return;
        var json = Kit.bundleToJSON(Kit.exportBundle({ kind: 'entity', ids: [id] }, { guide: false }));
        Kit.copy(json).then(function (copied) {
          if (copied || dead) return;
          /* clipboard refused (sandbox): show the JSON selected so it can be copied by hand */
          var pre = Kit.h('pre', { class: 'codebox', tabindex: '0', 'aria-label': 'JSON for ' + id }, json);
          Kit.sheet({ title: 'Copy ' + id + ' for an LLM', width: 560, body: pre, noFocus: true });
          setTimeout(function () {
            try { pre.focus(); var rg = document.createRange(); rg.selectNodeContents(pre); var sl = window.getSelection(); sl.removeAllRanges(); sl.addRange(rg); } catch (e) { /* selection unavailable */ }
          }, 40);
        });
      }
      function del(id) {
        if (!Kit.has(id)) return;
        var label = Kit.label(id), snap = Kit.snapshot();
        S.confirmDel = null;
        if (S.sel === id) S.sel = null;
        Kit.remove(id);
        Kit.toast('Deleted ' + id + ' · ' + (label.length > 40 ? label.slice(0, 38) + '…' : label), { label: 'Undo', run: function () { Kit.restore(snap); S.flash = id; Kit.toast('Restored ' + id); } });
      }
      function setResStatus(id, v, withToast) {
        var o = Kit.get(id); if (!o || o.status === v) return;
        var was = o.status;
        Kit.update(id, { status: v });
        if (withToast) Kit.toast('Marked ' + id + ' ' + resLabel(v).toLowerCase(), { label: 'Undo', run: function () { Kit.update(id, { status: was }); } });
      }
      function moveIdea(id, v) {
        var o = Kit.get(id); if (!o || o.status === v) return;
        var was = o.status;
        S.menu = null;
        Kit.update(id, { status: v });
        S.flash = id;
        Kit.toast('Moved ' + id + ' to ' + ideaInfo(v)[1], { label: 'Undo', run: function () { if (Kit.get(id)) { Kit.update(id, { status: was }); S.flash = id; } } });
      }
      function promote(ideaId, type) {
        var idea = Kit.get(ideaId); if (!idea || !Kit.TYPES[type]) return;
        var text = String(idea.text || '').trim();
        var fromUrl = idea.url ? titleFromUrl(idea.url) : null;
        var title = firstSentence(text) || (fromUrl ? fromUrl.title : 'Untitled');
        var withUrl = text + (idea.url ? (text ? '\n\n' : '') + idea.url : '');
        var links = (idea.links || []).slice(), obj;
        switch (type) {
          /* a puzzle goes inside the first event the idea is linked to (its chapter follows); otherwise it waits unplaced */
          case 'puzzle': obj = { title: title, status: 'idea', notes: 'From idea ' + ideaId + ': ' + withUrl,
            event: links.filter(function (x) { return Kit.type(x) === 'event'; })[0] || null }; break;
          /* a new event starts in the parking lot (no chapter) on the pseudo layer; place it from the Codex or the Trail */
          case 'event': obj = { title: title, twist: withUrl, layer: 'pseudo', chapter: null, order: Kit.eventsIn(null).length + 1 }; break;
          case 'character': obj = { name: title, role: withUrl }; break;
          case 'question': obj = { text: text || title, kind: 'design', links: links }; break;
          case 'research': obj = { title: fromUrl ? fromUrl.title : title, url: idea.url || null, author: fromUrl ? fromUrl.author : '', kind: idea.url ? 'web' : 'other',
            reliability: 'popular', status: 'to read', tags: (idea.tags || []).slice(), notes: text,
            supports: links.filter(function (x) { return Kit.type(x) === 'event'; }) }; break;
          case 'note': obj = { title: title, body: withUrl + (links.length ? '\n\nLinked: ' + links.map(function (x) { return '#' + x; }).join(' ') : '') + '\n\nFrom idea #' + ideaId }; break;
        }
        var snap = Kit.snapshot(), newId = null;
        S.menu = null;
        Kit.batch(function () {
          newId = Kit.create(type, obj);
          var cur = (Kit.get(ideaId).links || []).filter(function (x) { return x !== newId; });
          Kit.update(ideaId, { links: cur.concat([newId]), status: 'used' });
        });
        S.promoted[ideaId] = newId;
        S.flash = ideaId;
        Kit.toast('Created ' + newId + ' from ' + ideaId, { label: 'Undo', run: function () { Kit.restore(snap); delete S.promoted[ideaId]; Kit.toast('Undone: ' + newId + ' removed, ' + ideaId + ' restored'); } });
        render();
      }
      function jumpTo(id) {
        var r = Kit.get(id); if (!r) return;
        if (!passR(r)) clearFiltersR();
        S.flash = id; render();
        var t = root.querySelector('.lib-card[data-id="' + id + '"] .rs-title');
        if (t) t.focus({ preventScroll: true });
      }
      function setSel(id) {
        if (S.sel === id) return;
        S.sel = id;
        Array.prototype.forEach.call(root.querySelectorAll('.lib-card'), function (c) { c.classList.toggle('is-sel', c.getAttribute('data-id') === id); });
      }
      function closeMenu(refocus) {
        if (!S.menu) return;
        var m = S.menu; S.menu = null;
        render();
        if (refocus) {
          var b = root.querySelector('.lib-card[data-id="' + m.id + '"] [data-menu="' + m.kind + '"]');
          if (b) b.focus({ preventScroll: true });
        }
      }
      function toggleArr(arr, v) { var i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }

      /* ---------------- events ---------------- */
      root.addEventListener('submit', function (e) {
        e.preventDefault();
        var inp = e.target.querySelector && e.target.querySelector('.lib-qa-in');
        if (inp) quickAdd(inp);
      });

      root.addEventListener('click', function (e) {
        if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
        var a = e.target.closest('[data-act]');
        if (!a || !root.contains(a) || /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
        var act = a.getAttribute('data-act'), id = a.getAttribute('data-id'), v = a.getAttribute('data-v'), f = a.getAttribute('data-f');
        switch (act) {
          case 'tab': if (a.getAttribute('data-tab') !== tab) ctx.go(a.getAttribute('data-tab')); break;
          /* research filters */
          case 'f-status': S.rs.status = v; render(); break;
          case 'f-rel': toggleArr(S.rs.rel, v); render(); break;
          case 'f-tag': toggleArr(S.rs.tags, v); render(); break;
          case 'f-unlinked': S.rs.unlinked = !S.rs.unlinked; render(); break;
          case 'f-clear': clearFiltersR(); render(); break;
          case 'f-fold': S.rsMore = !S.rsMore; render(); break;
          case 'risk-toggle': setRiskCollapsed(!riskCollapsed()); render(); break;
          case 'risk-all': S.riskAll = !S.riskAll; render(); break;
          case 'jump': jumpTo(id); break;
          case 'verify': setResStatus(id, 'verified', true); break;
          /* idea filters */
          case 'i-status': S.id.status = v; render(); break;
          case 'i-tag': toggleArr(S.id.tags, v); render(); break;
          case 'i-clear': S.id.tags = []; S.id.q = ''; S.id.status = 'all'; render(); break;
          /* card actions */
          case 'st': setResStatus(id, v, false); break;
          case 'details':
            S.details[id] = !S.details[id]; render();
            if (S.details[id]) { var fi = root.querySelector('.lib-card[data-id="' + id + '"] [data-field="url"]'); if (fi) fi.focus({ preventScroll: true }); }
            break;
          case 'show-field':
            S.showField[id + ':' + f] = true; render();
            var tf = root.querySelector('.lib-card[data-id="' + id + '"] textarea[data-field="' + f + '"]');
            if (tf) tf.focus();
            break;
          case 'tag-rm': { var o = Kit.get(id); if (o) Kit.update(id, { tags: (o.tags || []).filter(function (t) { return t !== v; }) }); break; }
          case 'link-add': linkAdd(id, f, a); break;
          case 'link-rm': linkRm(id, f, v); break;
          case 'open': S.menu = null; if (Kit.has(id)) ctx.go(id); break;
          case 'copy': S.menu = null; copyEntity(id); render(); break;
          case 'del': S.menu = null; S.confirmDel = id; render(); { var y = root.querySelector('[data-act="del-yes"]'); if (y) y.focus({ preventScroll: true }); } break;
          case 'del-no': { var cid = S.confirmDel; S.confirmDel = null; render(); var db = cid && root.querySelector('.lib-card[data-id="' + cid + '"] [data-act="del"], .lib-card[data-id="' + cid + '"] [data-menu="more"]'); if (db) db.focus({ preventScroll: true }); break; }
          case 'del-yes': del(id); break;
          case 'menu': {
            var kind = a.getAttribute('data-menu');
            var same = S.menu && S.menu.id === id && S.menu.kind === kind;
            S.menu = same ? null : { id: id, kind: kind };
            S.confirmDel = null;
            render();
            if (!same && e.detail === 0) { var mi = root.querySelector('.lib-menu .lib-mi'); if (mi) mi.focus(); }
            break;
          }
          case 'move': moveIdea(id, v); break;
          case 'promote': promote(id, v); break;
        }
      });

      root.addEventListener('change', function (e) {
        var t = e.target;
        if (t.classList.contains('lib-tagin')) { if (t.value.trim()) addTags(t); return; }
        if (t.getAttribute('data-act') === 'f-group') { S.rs.group = t.value; render(); return; }
        if (t.hasAttribute('data-field')) {
          if (t === liveEl) { clearTimeout(liveT); liveEl = null; }
          commitField(t);
        }
      });

      root.addEventListener('input', function (e) {
        var t = e.target;
        if (t.classList.contains('lib-ta')) { autosize([t]); scheduleLive(t); }
        else if (t.getAttribute('data-act') === 'q') {
          if (tab === 'research') S.rs.q = t.value; else S.id.q = t.value;
          render();
        }
      });

      root.addEventListener('keydown', function (e) {
        var t = e.target;
        if (t.classList && t.classList.contains('lib-ta')) {
          if (e.key === 'Escape') {
            if (typeof t._orig === 'string') { t.value = t._orig; autosize([t]); }
            clearTimeout(liveT); liveEl = null; commitField(t); t.blur(); e.preventDefault();
          } else if (e.key === 'Enter' && (t.getAttribute('data-field') === 'title' || e.ctrlKey || e.metaKey)) {
            e.preventDefault(); t.blur();
          }
        } else if (t.classList && t.classList.contains('lib-tagin')) {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); if (t.value.trim()) addTags(t); }
          else if (e.key === 'Escape') { e.preventDefault(); t.value = ''; t.blur(); }
        } else if (t.matches && t.matches('input[data-field]')) {
          if (e.key === 'Enter') { e.preventDefault(); t.blur(); }
          else if (e.key === 'Escape') {
            /* Esc cancels the edit (and never closes the desk) */
            e.preventDefault();
            if (typeof t._orig === 'string') t.value = t._orig;
            t.blur();
          }
        } else if (t.getAttribute && t.getAttribute('data-act') === 'q' && e.key === 'Escape') {
          e.preventDefault();
          if (t.value) { t.value = ''; if (tab === 'research') S.rs.q = ''; else S.id.q = ''; render(); }
          else t.blur();
        } else if (t.closest && t.closest('.lib-menu')) {
          var items = Array.prototype.slice.call(t.closest('.lib-menu').querySelectorAll('.lib-mi')), i = items.indexOf(t);
          if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
          else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
          else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
          else if (e.key === 'Tab') { S.menu = null; scheduleRender(); }
        } else if (t.classList && t.classList.contains('lib-qa-in') && e.key === 'Escape') {
          e.preventDefault(); t.blur();
        }
      });

      root.addEventListener('focusin', function (e) {
        var t = e.target;
        if (t.matches && t.matches('.lib-ta, input[data-field]')) t._orig = t.value;
        var card = t.closest && t.closest('.lib-card');
        if (card) setSel(card.getAttribute('data-id'));
      });
      root.addEventListener('focusout', function (e) {
        var t = e.target;
        if (t.classList && t.classList.contains('lib-ta')) {
          if (t === liveEl) flushLive();
          var key = t.getAttribute('data-id') + ':' + t.getAttribute('data-field');
          if (!t.value.trim() && S.showField[key]) delete S.showField[key]; /* collapses on the next render */
        }
      });

      /* ---------- selection + drag (board) ---------- */
      root.addEventListener('pointerdown', function (e) {
        var card = e.target.closest('.lib-card');
        if (card && root.contains(card)) setSel(card.getAttribute('data-id'));
        else if (!e.target.closest('.lib-top, .lib-tb, .lib-menu, .lib-risk')) setSel(null);
        if (!card || !card.classList.contains('id-card') || !card.closest('.id-board')) return;
        if ((e.pointerType === 'mouse' && e.button !== 0) || e.target.closest('textarea, input, select, button, a, label, .lib-menu')) return;
        drag = { id: card.getAttribute('data-id'), card: card, x0: e.clientX, y0: e.clientY, pid: e.pointerId, type: e.pointerType, active: false, timer: null, col: null, ghost: null };
        if (e.pointerType === 'mouse') e.preventDefault(); /* no text selection while dragging */
        else drag.timer = setTimeout(startDrag, 380);   /* long-press on touch */
        document.addEventListener('pointermove', onDragMove);
        document.addEventListener('pointerup', onDragUp);
        document.addEventListener('pointercancel', onDragCancel);
      });
      function startDrag() {
        if (!drag || drag.active) return;
        if (document.activeElement && root.contains(document.activeElement) && document.activeElement.blur) document.activeElement.blur();
        drag.active = true;
        if (S.menu) { S.menu = null; render(); }
        var card = root.querySelector('.lib-card[data-id="' + drag.id + '"]') || drag.card;
        drag.card = card;
        var r = card.getBoundingClientRect();
        drag.offX = drag.x0 - r.left; drag.offY = drag.y0 - r.top;
        var g = card.cloneNode(true);
        g.classList.add('lib-ghost'); g.classList.remove('is-sel', 'lib-flash');
        g.removeAttribute('data-k'); g.setAttribute('aria-hidden', 'true');
        g.style.width = r.width + 'px'; g.style.left = r.left + 'px'; g.style.top = r.top + 'px';
        root.appendChild(g);
        drag.ghost = g;
        card.classList.add('is-dragging');
        root.classList.add('lib-dragging');
        try { card.setPointerCapture(drag.pid); } catch (err) { /* pointer already gone */ }
        overCol(drag.x0, drag.y0);
      }
      function overCol(x, y) {
        var el = document.elementFromPoint(x, y), col = el && el.closest ? el.closest('.v-library .lib-col') : null;
        if (col !== drag.col) {
          if (drag.col) drag.col.classList.remove('is-over');
          drag.col = col;
          if (col) col.classList.add('is-over');
        }
      }
      function onDragMove(e) {
        if (!drag || e.pointerId !== drag.pid) return;
        var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0, dist = Math.sqrt(dx * dx + dy * dy);
        if (!drag.active) {
          if (drag.type === 'mouse') { if (dist > 4) startDrag(); else return; }
          else { if (dist > 10) endDrag(); return; }
        }
        drag.ghost.style.left = (e.clientX - drag.offX) + 'px';
        drag.ghost.style.top = (e.clientY - drag.offY) + 'px';
        overCol(e.clientX, e.clientY);
        var sc = scroller();
        if (sc) {
          var b = sc.getBoundingClientRect();
          if (e.clientY < b.top + 48) sc.scrollTop -= 14; else if (e.clientY > b.bottom - 48) sc.scrollTop += 14;
        }
      }
      function onDragUp(e) {
        if (!drag || e.pointerId !== drag.pid) return;
        var d = drag, target = d.active && d.col ? d.col.getAttribute('data-status') : null;
        if (d.active) suppressClick = true;
        endDrag();
        setTimeout(function () { suppressClick = false; }, 0);
        if (target) {
          var o = Kit.get(d.id);
          if (o && o.status !== target) moveIdea(d.id, target);
          else render();
        }
      }
      function onDragCancel(e) { if (drag && e.pointerId === drag.pid) endDrag(); }
      function endDrag() {
        if (!drag) return;
        clearTimeout(drag.timer);
        if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
        if (drag.col) drag.col.classList.remove('is-over');
        if (drag.card) drag.card.classList.remove('is-dragging');
        root.classList.remove('lib-dragging');
        document.removeEventListener('pointermove', onDragMove);
        document.removeEventListener('pointerup', onDragUp);
        document.removeEventListener('pointercancel', onDragCancel);
        drag = null;
        if (pendingRender && !dead) { pendingRender = false; render(); }
      }
      /* keep the page from scrolling under a touch drag (must be registered up front to be cancelable) */
      root.addEventListener('touchmove', function (e) { if (drag && drag.active) e.preventDefault(); }, { passive: false });
      root.addEventListener('contextmenu', function (e) { if (drag) e.preventDefault(); });

      /* ---------- document-level listeners (removed on unmount) ---------- */
      /* capture phase, so it runs before the shell's "Esc goes back to the editor": every Esc this view
         handles (drag, menus, inline delete confirm) is preventDefault()ed so the desk stays open */
      function onDocKey(e) {
        if (e.key === 'Escape') {
          if (drag) { e.preventDefault(); var wasActive = drag.active; endDrag(); if (wasActive) render(); return; }
          if (S.menu) { e.preventDefault(); closeMenu(true); return; }
          if (S.confirmDel && root.contains(document.activeElement)) {
            e.preventDefault();
            var cid = S.confirmDel; S.confirmDel = null; render();
            var db = root.querySelector('.lib-card[data-id="' + cid + '"] [data-act="del"], .lib-card[data-id="' + cid + '"] [data-menu="more"]');
            if (db) db.focus({ preventScroll: true });
            return;
          }
          /* a sheet opened from here (copy fallback, export…): Kit closes it; don't let the same Esc close the desk too */
          if (document.querySelector('.kit-sheet-overlay')) e.preventDefault();
          return;
        }
        if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          var t = e.target;
          if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
          if (Kit.palette && Kit.palette.el && !Kit.palette.el.hidden) return;
          if (document.querySelector('.kit-sheet-overlay')) return;
          var q = root.querySelector('.lib-qa-in');
          if (q) { e.preventDefault(); q.focus(); }
        }
      }
      function onDocDown(e) {
        if (S.menu && !(e.target.closest && e.target.closest('.v-library .lib-mw'))) { S.menu = null; render(); }
      }
      function onMq() { if (mq.matches !== lastPhone) { lastPhone = mq.matches; S.menu = null; render(); } }
      var resizeT = null;
      function onResize() { if (FIELD_SIZING) return; clearTimeout(resizeT); resizeT = setTimeout(function () { autosize(Array.prototype.slice.call(root.querySelectorAll('textarea.lib-ta'))); }, 120); }
      document.addEventListener('keydown', onDocKey, true);
      document.addEventListener('pointerdown', onDocDown, true);
      if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
      window.addEventListener('resize', onResize);
      var off = Kit.on('change', function () { if (!dead) scheduleRender(); });

      render();
      autosize(Array.prototype.slice.call(root.querySelectorAll('textarea.lib-ta')));

      return {
        update: function (p) {
          var next = p && p.tab === 'ideas' ? 'ideas' : 'research';
          if (next === tab) return;
          flushLive();
          tab = next; S.menu = null; S.confirmDel = null; S.sel = null;
          render();
          var sc = scroller(); if (sc) sc.scrollTop = 0;
        },
        unmount: function () {
          var a = document.activeElement;
          flushLive();
          if (a && root.contains(a) && a.hasAttribute && a.hasAttribute('data-field')) commitField(a);
          dead = true;
          off();
          endDrag();
          clearTimeout(renderT); clearTimeout(flashT); clearTimeout(resizeT); clearTimeout(liveT);
          S.menu = null; S.confirmDel = null;
          document.removeEventListener('keydown', onDocKey, true);
          document.removeEventListener('pointerdown', onDocDown, true);
          if (mq.removeEventListener) mq.removeEventListener('change', onMq); else if (mq.removeListener) mq.removeListener(onMq);
          window.removeEventListener('resize', onResize);
        },
        exportScope: function () {
          var type = tab === 'research' ? 'research' : 'idea';
          if (S.sel && Kit.has(S.sel) && Kit.type(S.sel) === type) return { kind: 'entity', ids: [S.sel] };
          return { kind: 'collection', type: type };
        },
        navToken: function () { return tab; },
      };
    },
  });
})();
