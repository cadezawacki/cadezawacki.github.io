/* RSS Feeds — a lightweight RSS/Atom feed reader panel. Subscriptions,
   bookmarks and read-marks live in a Cade.syncedBlob('rss') so they follow
   the account across devices; fetched feed items are cached IN MEMORY only
   (per session) and re-fetched on demand.

   Data shape (synced blob):
     { feeds:     [{ id, url, title }],
       bookmarks: [{ id, feedTitle, title, link, ts }],
       read:      { "<feedId>|<link-or-title>": firstReadTsMs } }
   Memory care: on every save, `read` is pruned to the newest 800 marks and
   `bookmarks` to the newest 300.

   CORS NOTE: this is a static app — feeds are fetched straight from the
   browser with fetch(url), so a feed is only readable if its server sends an
   Access-Control-Allow-Origin header. Many feeds do (most blog platforms,
   GitHub, HN mirrors, …); those that don't cannot be fetched from a static
   page and show an inline "⚠ can't fetch (CORS or offline)" error on that
   feed instead of breaking the rest of the list.

   Parsing supports RSS 2.0 (<channel><item>: title/link/pubDate) and Atom
   (<feed><entry>: title/<link href>/updated) via DOMParser('text/xml'),
   with a regex fallback for environments without DOMParser. All
   feed-derived strings are untrusted: tags are stripped from titles and
   everything is passed through Cade.escapeHtml before hitting innerHTML. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('rss.css');
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'rss-panel';
  var READ_MAX = 800;        // keep newest N read-marks
  var BOOKMARK_MAX = 300;    // keep newest N bookmarks
  var ITEMS_PER_FEED = 100;  // in-memory cap per feed
  var ITEMS_SHOWN = 120;     // merged-list display cap
  var AUTO_FETCH_MS = 10 * 60 * 1000; // auto-refresh on open if cache older
  var CORS_HINT = "Some feeds block cross-origin reads (CORS): feeds that send Access-Control-Allow-Origin work (many do), others can't be fetched from a static app.";

  function mkId() { return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ---- synced state (subscriptions + bookmarks + read-marks) ----
  function normalize(data) {
    var d = (data && typeof data === 'object') ? data : {};
    var out = { feeds: [], bookmarks: [], read: {} };
    if (Array.isArray(d.feeds)) d.feeds.forEach(function (f) {
      if (!f || typeof f.url !== 'string' || !f.url) return;
      out.feeds.push({ id: String(f.id || mkId()), url: f.url, title: String(f.title || f.url) });
    });
    if (Array.isArray(d.bookmarks)) d.bookmarks.forEach(function (b) {
      if (!b || (typeof b.link !== 'string' && typeof b.title !== 'string')) return;
      out.bookmarks.push({
        id: String(b.id || mkId()),
        feedTitle: String(b.feedTitle || ''),
        title: String(b.title || b.link || '(untitled)'),
        link: String(b.link || ''),
        ts: +b.ts || 0,
      });
    });
    if (d.read && typeof d.read === 'object') {
      for (var k in d.read) { var v = +d.read[k]; if (v > 0) out.read[k] = v; }
    }
    return out;
  }

  var state = { feeds: [], bookmarks: [], read: {} };
  var blobStore = Cade.syncedBlob('rss', { onChange: function (data) { state = normalize(data); render(); } });
  state = normalize(blobStore.get());

  function save() {
    // Prune before every push (memory care): newest 800 read-marks, 300 bookmarks.
    var keys = Object.keys(state.read);
    if (keys.length > READ_MAX) {
      keys.sort(function (a, b) { return state.read[b] - state.read[a]; });
      var read = {};
      keys.slice(0, READ_MAX).forEach(function (k) { read[k] = state.read[k]; });
      state.read = read;
    }
    if (state.bookmarks.length > BOOKMARK_MAX) state.bookmarks = state.bookmarks.slice(0, BOOKMARK_MAX);
    blobStore.set({ feeds: state.feeds, bookmarks: state.bookmarks, read: state.read });
  }

  // ---- session-only caches (never persisted) ----
  var cache = {};          // feedId -> { items:[{title,link,ts}], error:string|null, at:ts }
  var lastFetchAt = 0;     // last refresh-all timestamp (session)
  var fetchingCount = 0;   // in-flight fetches (for the status line)
  var currentView = 'items';
  var renderedItems = [];  // items as last rendered (indexed by inline onclick)

  // ---- feed text sanitizing (feed content is UNTRUSTED) ----
  function decodeEntities(s) {
    return String(s).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (m, e) {
      if (e.charAt(0) === '#') {
        var code = (e.charAt(1) === 'x' || e.charAt(1) === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { if (isFinite(code) && code > 0) return String.fromCodePoint(code); } catch (err) {}
        return m;
      }
      var map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      return Object.prototype.hasOwnProperty.call(map, e.toLowerCase()) ? map[e.toLowerCase()] : m;
    });
  }
  // Strip CDATA wrappers + every tag, collapse whitespace, decode entities.
  // The result is plain text; it is STILL escaped with Cade.escapeHtml at
  // render time (never innerHTML raw feed HTML).
  function cleanText(s) {
    return decodeEntities(
      String(s == null ? '' : s)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }
  function parseDate(s) {
    var t = Date.parse(String(s || '').trim());
    return isFinite(t) ? t : 0;
  }

  // ---- feed parsing: DOMParser path ----
  function parseFeedDoc(doc) {
    try {
      if (!doc || !doc.documentElement) return null;
      if (doc.getElementsByTagName('parsererror').length) return null;
      var rootName = String(doc.documentElement.localName || doc.documentElement.nodeName || '').toLowerCase();
      var out = { title: '', items: [] };
      if (rootName === 'feed') {
        // Atom: <feed><title>…<entry><title>/<link href>/<updated>
        var ft = doc.querySelector('feed > title');
        out.title = ft ? cleanText(ft.textContent) : '';
        var entries = doc.querySelectorAll('entry');
        for (var i = 0; i < entries.length && out.items.length < ITEMS_PER_FEED; i++) {
          var en = entries[i];
          var tEl = en.querySelector('title');
          var link = '', alt = '', links = en.querySelectorAll('link');
          for (var j = 0; j < links.length; j++) {
            var href = links[j].getAttribute('href') || '';
            if (!href) continue;
            var rel = links[j].getAttribute('rel');
            if (!rel || rel === 'alternate') { link = href; break; }
            if (!alt) alt = href;
          }
          if (!link) link = alt;
          var when = en.querySelector('updated') || en.querySelector('published');
          out.items.push({
            title: (tEl && cleanText(tEl.textContent)) || '(untitled)',
            link: link,
            ts: parseDate(when ? when.textContent : ''),
          });
        }
        return out;
      }
      // RSS 2.0 (and RDF-ish): <channel><title>…<item><title>/<link>/<pubDate>
      var chan = doc.querySelector('channel');
      if (!chan && rootName !== 'rss') return null;
      var ct = doc.querySelector('channel > title');
      out.title = ct ? cleanText(ct.textContent) : '';
      var items = doc.querySelectorAll('item');
      for (var k = 0; k < items.length && out.items.length < ITEMS_PER_FEED; k++) {
        var it = items[k];
        var tt = it.querySelector('title');
        // getElementsByTagName('link') matches the plain RSS <link> but not
        // a namespaced <atom:link rel="self"> (qualified-name match in XML).
        var ln = '', lns = it.getElementsByTagName('link');
        for (var m = 0; m < lns.length; m++) {
          var v = (lns[m].textContent || '').trim();
          if (v) { ln = v; break; }
        }
        var pd = it.querySelector('pubDate');
        out.items.push({
          title: (tt && cleanText(tt.textContent)) || '(untitled)',
          link: ln,
          ts: parseDate(pd ? pd.textContent : ''),
        });
      }
      return out;
    } catch (e) { return null; }
  }

  // ---- feed parsing: regex fallback (no DOMParser, e.g. tests/workers) ----
  function tagContent(src, name) {
    var m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '\\s*>', 'i').exec(src);
    return m ? m[1] : '';
  }
  function tagBlocks(src, name) {
    return src.match(new RegExp('<' + name + '(?:\\s[^>]*)?>[\\s\\S]*?</' + name + '\\s*>', 'gi')) || [];
  }
  function atomLinkFromBlock(block) {
    var links = block.match(/<link\b[^>]*\/?>/gi) || [], alt = '';
    for (var i = 0; i < links.length; i++) {
      var href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(links[i]);
      if (!href || !href[1]) continue;
      var rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(links[i]);
      if (!rel || rel[1] === 'alternate') return decodeEntities(href[1]);
      if (!alt) alt = decodeEntities(href[1]);
    }
    return alt;
  }
  function parseFeedFallback(text) {
    var t = String(text || '');
    if (/<feed[\s>]/i.test(t) && /<entry[\s>]/i.test(t)) {          // Atom
      var items = tagBlocks(t, 'entry').slice(0, ITEMS_PER_FEED).map(function (b) {
        return {
          title: cleanText(tagContent(b, 'title')) || '(untitled)',
          link: atomLinkFromBlock(b),
          ts: parseDate(cleanText(tagContent(b, 'updated') || tagContent(b, 'published'))),
        };
      });
      return { title: cleanText(tagContent(t.split(/<entry[\s>]/i)[0], 'title')), items: items };
    }
    if (/<(rss|rdf:RDF)[\s>]/i.test(t) || /<channel[\s>]/i.test(t)) { // RSS 2.0 / RDF
      var items2 = tagBlocks(t, 'item').slice(0, ITEMS_PER_FEED).map(function (b) {
        return {
          title: cleanText(tagContent(b, 'title')) || '(untitled)',
          link: cleanText(tagContent(b, 'link')),
          ts: parseDate(cleanText(tagContent(b, 'pubDate'))),
        };
      });
      return { title: cleanText(tagContent(t.split(/<item[\s>]/i)[0], 'title')), items: items2 };
    }
    return null;
  }

  // DOMParser when available (browsers), regex fallback otherwise.
  function parseFeedText(text) {
    var t = String(text || '').replace(/^\uFEFF/, ''); // strip BOM
    if (typeof DOMParser !== 'undefined') {
      try {
        var parsed = parseFeedDoc(new DOMParser().parseFromString(t, 'text/xml'));
        if (parsed) return parsed;
      } catch (e) {}
    }
    return parseFeedFallback(t);
  }

  // ---- fetching ----
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
  }
  function fetchFeed(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (text) {
      var parsed = parseFeedText(text);
      if (!parsed || !parsed.items) throw new Error('not a recognizable RSS/Atom feed');
      return parsed;
    });
  }
  function refreshAll() {
    if (!state.feeds.length) { render(); return Promise.resolve(); }
    lastFetchAt = Date.now();
    var jobs = state.feeds.map(function (f) {
      fetchingCount++;
      return fetchFeed(f.url).then(function (parsed) {
        cache[f.id] = { items: parsed.items, error: null, at: Date.now() };
      }).catch(function () {
        // Per-feed error: keep any stale items, flag inline, never break the list.
        cache[f.id] = { items: (cache[f.id] && cache[f.id].items) || [], error: "can't fetch (CORS or offline)", at: Date.now() };
      }).then(function () { fetchingCount--; render(); });
    });
    render();
    return Promise.all(jobs);
  }
  function addFeed(rawUrl) {
    var url = String(rawUrl || '').trim();
    if (!url) return Promise.resolve(false);
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (state.feeds.some(function (f) { return f.url === url; })) {
      Cade.showToast('Feed already added', 'info', 2000);
      return Promise.resolve(false);
    }
    fetchingCount++; render();
    return fetchFeed(url).then(function (parsed) {
      var f = { id: mkId(), url: url, title: parsed.title || hostOf(url) };
      state.feeds.push(f);
      cache[f.id] = { items: parsed.items, error: null, at: Date.now() };
      if (!lastFetchAt) lastFetchAt = Date.now();
      save();
      Cade.showToast('Subscribed: ' + f.title, 'success', 2500);
      return true;
    }).catch(function (e) {
      Cade.showToast("Can't add feed — " + ((e && e.message) || 'fetch failed') + ' (CORS-blocked or offline?)', 'error', 4500);
      return false;
    }).then(function (ok) { fetchingCount--; render(); return ok; });
  }

  // ---- item helpers ----
  function itemKey(feed, item) { return feed.id + '|' + (item.link || item.title); }
  function isBookmarked(row) {
    for (var i = 0; i < state.bookmarks.length; i++) {
      var b = state.bookmarks[i];
      if (row.link ? b.link === row.link : b.title === row.title) return true;
    }
    return false;
  }
  function toggleBookmark(row) {
    var idx = -1;
    for (var i = 0; i < state.bookmarks.length; i++) {
      var b = state.bookmarks[i];
      if (row.link ? b.link === row.link : b.title === row.title) { idx = i; break; }
    }
    if (idx >= 0) state.bookmarks.splice(idx, 1);
    else state.bookmarks.unshift({ id: mkId(), feedTitle: row.feedTitle, title: row.title, link: row.link, ts: row.ts || Date.now() });
    save();
    render();
  }
  function fmtRel(ts) {
    if (!ts) return '';
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 7 * 86400) return Math.floor(s / 86400) + 'd';
    return Math.floor(s / (7 * 86400)) + 'w';
  }

  // ---- rendering (every feed-derived string goes through esc()) ----
  function tabsHtml() {
    var tab = function (id, label) {
      return '<button class="rss-tab' + (currentView === id ? ' active' : '') + '" onclick="window.__rssTab(\'' + id + '\')">' + label + '</button>';
    };
    return '<div class="rss-tabs">' +
      tab('items', 'Items') +
      tab('feeds', 'Feeds' + (state.feeds.length ? ' (' + state.feeds.length + ')' : '')) +
      tab('bookmarks', 'Bookmarks' + (state.bookmarks.length ? ' (' + state.bookmarks.length + ')' : '')) +
      '</div>';
  }
  function itemsViewHtml() {
    renderedItems = [];
    var merged = [];
    state.feeds.forEach(function (f) {
      var c = cache[f.id];
      if (!c) return;
      c.items.forEach(function (it) {
        merged.push({ feedId: f.id, feedTitle: f.title, title: it.title, link: it.link, ts: it.ts, key: itemKey(f, it) });
      });
    });
    merged.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    merged = merged.slice(0, ITEMS_SHOWN);

    var status = fetchingCount > 0 ? 'fetching…'
      : lastFetchAt ? 'updated ' + fmtRel(lastFetchAt) + (fmtRel(lastFetchAt) === 'now' ? '' : ' ago')
      : '';
    var html = '<div class="rss-toolbar">' +
      '<button class="rss-btn" onclick="window.__rssRefresh()">↻ Refresh</button>' +
      '<span class="rss-status">' + esc(status) + '</span></div>';

    // Inline per-feed fetch errors (do not break the rest of the list).
    state.feeds.forEach(function (f) {
      var c = cache[f.id];
      if (c && c.error) html += '<div class="rss-err">⚠ ' + esc(f.title) + ': ' + esc(c.error) + '</div>';
    });

    if (!state.feeds.length) {
      html += '<div class="rss-empty">No subscriptions yet — add a feed URL in the <b>Feeds</b> tab.</div>';
    } else if (!merged.length && !fetchingCount) {
      html += '<div class="rss-empty">No items. Hit ↻ Refresh.</div>';
    }

    merged.forEach(function (row) {
      var i = renderedItems.length;
      renderedItems.push(row);
      var unread = !state.read[row.key];
      var starred = isBookmarked(row);
      html += '<div class="rss-item' + (unread ? ' unread' : '') + '">' +
        '<span class="rss-dot" title="' + (unread ? 'Mark read' : 'Read') + '" onclick="window.__rssMarkRead(' + i + ')"></span>' +
        '<span class="rss-main">' +
          '<span class="rss-feedlabel">' + esc(row.feedTitle) + '</span>' +
          '<a class="rss-title" href="#" onclick="return window.__rssOpenItem(' + i + ')">' + esc(row.title) + '</a>' +
        '</span>' +
        '<span class="rss-time">' + esc(fmtRel(row.ts)) + '</span>' +
        '<button class="rss-star' + (starred ? ' on' : '') + '" title="' + (starred ? 'Remove bookmark' : 'Bookmark') + '" onclick="window.__rssStar(' + i + ')">' + (starred ? '★' : '☆') + '</button>' +
        '</div>';
    });
    return html;
  }
  function feedsViewHtml(keepVal) {
    var html = '<div class="rss-addrow">' +
      '<input id="rss-add-url" type="url" placeholder="https://example.com/feed.xml" value="' + esc(keepVal || '') + '"' +
      ' onkeydown="if(event.key===\'Enter\')window.__rssAdd()">' +
      '<button class="rss-btn" onclick="window.__rssAdd()">＋ Add</button></div>' +
      '<div class="rss-hint">' + esc(CORS_HINT) + '</div>';
    if (!state.feeds.length) {
      html += '<div class="rss-empty">No feeds yet.</div>';
    }
    state.feeds.forEach(function (f) {
      var c = cache[f.id];
      html += '<div class="rss-feed">' +
        '<span class="rss-main">' +
          '<span class="rss-feedtitle">' + esc(f.title) + '</span>' +
          '<span class="rss-feedurl">' + esc(hostOf(f.url)) + '</span>' +
          (c && c.error ? '<span class="rss-err">⚠ ' + esc(c.error) + '</span>' : '') +
        '</span>' +
        '<button class="rss-x" title="Unsubscribe" onclick="window.__rssRemoveFeed(\'' + esc(f.id) + '\')">✕</button>' +
        '</div>';
    });
    return html;
  }
  function bookmarksViewHtml() {
    var html = '';
    if (!state.bookmarks.length) {
      html += '<div class="rss-empty">No bookmarks. Star ☆ an item in the Items tab.</div>';
    }
    state.bookmarks.forEach(function (b) {
      html += '<div class="rss-item">' +
        '<span class="rss-main">' +
          '<span class="rss-feedlabel">' + esc(b.feedTitle) + '</span>' +
          '<a class="rss-title" href="#" onclick="return window.__rssOpenBookmark(\'' + esc(b.id) + '\')">' + esc(b.title) + '</a>' +
        '</span>' +
        '<span class="rss-time">' + esc(fmtRel(b.ts)) + '</span>' +
        '<button class="rss-x" title="Remove bookmark" onclick="window.__rssRemoveBookmark(\'' + esc(b.id) + '\')">✕</button>' +
        '</div>';
    });
    return html;
  }
  function render() {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    var body = p.querySelector('.cade-panel-body');
    if (!body) return;
    var inp = document.getElementById('rss-add-url');
    var keepVal = inp ? inp.value : '';
    var hadFocus = inp && document.activeElement === inp;
    var html = tabsHtml();
    if (currentView === 'feeds') html += feedsViewHtml(keepVal);
    else if (currentView === 'bookmarks') html += bookmarksViewHtml();
    else html += itemsViewHtml();
    body.innerHTML = html;
    if (hadFocus) {
      var ni = document.getElementById('rss-add-url');
      if (ni) {
        ni.focus();
        try { ni.setSelectionRange(ni.value.length, ni.value.length); } catch (e) {}
      }
    }
  }

  // ---- inline onclick handlers (globals kept to window.__rss*) ----
  window.__rssTab = function (view) {
    currentView = view === 'feeds' || view === 'bookmarks' ? view : 'items';
    render();
  };
  window.__rssRefresh = function () { refreshAll(); };
  window.__rssAdd = function () {
    var inp = document.getElementById('rss-add-url');
    var url = inp ? inp.value : '';
    addFeed(url).then(function (ok) {
      if (ok) {
        var ni = document.getElementById('rss-add-url');
        if (ni) ni.value = '';
      }
    });
  };
  window.__rssRemoveFeed = function (id) {
    state.feeds = state.feeds.filter(function (f) { return f.id !== id; });
    delete cache[id];
    // Drop read-marks belonging to the removed feed (memory care).
    Object.keys(state.read).forEach(function (k) {
      if (k.indexOf(id + '|') === 0) delete state.read[k];
    });
    save();
    render();
  };
  window.__rssOpenItem = function (i) {
    var row = renderedItems[i];
    if (!row) return false;
    if (row.link) { try { window.open(row.link, '_blank', 'noopener'); } catch (e) {} }
    if (!state.read[row.key]) { state.read[row.key] = Date.now(); save(); }
    render();
    return false;
  };
  window.__rssMarkRead = function (i) {
    var row = renderedItems[i];
    if (!row || state.read[row.key]) return;
    state.read[row.key] = Date.now();
    save();
    render();
  };
  window.__rssStar = function (i) {
    var row = renderedItems[i];
    if (row) toggleBookmark(row);
  };
  window.__rssOpenBookmark = function (id) {
    for (var i = 0; i < state.bookmarks.length; i++) {
      if (state.bookmarks[i].id === id && state.bookmarks[i].link) {
        try { window.open(state.bookmarks[i].link, '_blank', 'noopener'); } catch (e) {}
        break;
      }
    }
    return false;
  };
  window.__rssRemoveBookmark = function (id) {
    state.bookmarks = state.bookmarks.filter(function (b) { return b.id !== id; });
    save();
    render();
  };

  // ---- widget entry ----
  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById(PANEL_ID);
    if (existing) { existing.remove(); return; }
    var p = Cade.mkPanel(PANEL_ID, '📰 RSS Feeds', '');
    p._onClose = function () {};
    render();
    // Auto-fetch on open when the session cache is stale (>10 min) or empty.
    if (state.feeds.length && Date.now() - lastFetchAt > AUTO_FETCH_MS) refreshAll();
  }

  Cade.registerWidget({
    name: 'RSS Feeds',
    description: 'Follow RSS/Atom feeds; subscriptions & bookmarks sync across devices',
    icon: '📰',
    tags: 'rss,atom,feed,news,reader,bookmarks,subscribe',
    open: open,
    // Internal hooks for the Node smoke test (harmless in production).
    _test: {
      parseFeedText: parseFeedText,
      addFeed: addFeed,
      refreshAll: refreshAll,
      toggleBookmark: toggleBookmark,
      normalize: normalize,
      getState: function () { return state; },
      getCache: function () { return cache; },
    },
  });
})();
