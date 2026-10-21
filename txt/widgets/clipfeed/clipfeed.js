/* Clipboard — a synced clipboard feed between your devices.
 *
 * Copy something on one device (in the app, with "Share copies to my Clipboard
 * feed" on — see clipfeed-capture.js — or by pasting / typing / dropping it
 * here) and it shows up as a card on your other devices. Tap a card to copy it.
 * Cards: text (first lines, "+N more lines"), links (domain + open), images
 * (thumbnail; the full picture is fetched when copied, shared or saved), the
 * device it came from and when, pin (pinned first) and delete. Long-press or ⋯:
 * insert into the note, open, share, save, pin, delete.
 *
 * The model lives in clipfeed-model.js (loaded on first open, shared with the
 * capture plugin): end-to-end encrypted items under Cade.cloud.ref('cb') with
 * Sync, else a local feed in IndexedDB. Rendering is incremental — one card is
 * built or updated per feed event, at most `limit` cards exist, and every
 * piece of user text goes in through textContent. Nothing runs while the panel
 * is closed: the feed subscription, the clock tick and every timer stop on close. */
(function () {
  'use strict';
  var META = {
    name: 'Clipboard',
    description: 'Synced clipboard feed — copy on one device, tap the card to copy it on another (text, links and images)',
    icon: '📋',
    tags: 'clipboard,copy,paste,sync,devices,share,transfer,history,feed,phone,laptop,image,screenshot,link,universal clipboard',
  };
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('clipfeed.css');
  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
  var MODEL_URL = abs(Cade.asset('clipfeed-model.js'));   // resolve now, while the module context is ours

  var PANEL_ID = 'clipfeed-panel';
  var STEP = 40;              // cards rendered at a time ("Show more" adds STEP)
  var LONG_MS = 480;          // long-press → actions menu
  var M = null;               // model, once loaded
  var V = null;               // panel state while open

  var ICON_PASTE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_SEARCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var ICON_PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 4 4v2h-5v6l-1 1-1-1v-6H6v-2l4-4z" fill="var(--cbf-pin-fill, none)" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  var ICON_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2200); } catch (e) {} }
  function coarse() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  // The panel may be popped out into its own window: clipboard calls go through that window.
  function win() { return (V && V.el.ownerDocument && V.el.ownerDocument.defaultView) || window; }
  // The capture plugin must not feed our own tap-to-copy back into the feed.
  function ownOn() { window.__cadeClipfeedOwn = (window.__cadeClipfeedOwn || 0) + 1; }
  function ownOff() { window.__cadeClipfeedOwn = Math.max(0, (window.__cadeClipfeedOwn || 1) - 1); }

  function loadModel() {
    if (window.__cadeClipfeed) return Promise.resolve(window.__cadeClipfeed);
    if (window.__cadeClipfeedLoading) return window.__cadeClipfeedLoading;
    var p = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = MODEL_URL;
      s.async = true;
      s.onload = function () { if (window.__cadeClipfeed) res(window.__cadeClipfeed); else rej(new Error('Clipboard did not load')); };
      s.onerror = function () { rej(new Error('Could not load the Clipboard' + (navigator.onLine ? '' : ' — it needs one online load to cache'))); };
      document.head.appendChild(s);
    });
    window.__cadeClipfeedLoading = p;
    p.catch(function () { if (window.__cadeClipfeedLoading === p) window.__cadeClipfeedLoading = null; });
    return p;
  }

  // ---- open / close ---------------------------------------------------------------------
  var SHELL =
    '<div class="cbf-root">' +
      '<div class="cbf-top">' +
        '<div class="cbf-compose">' +
          '<button type="button" class="cbf-btn cbf-paste" data-act="paste" title="Paste what is on this device’s clipboard">' + ICON_PASTE + '<span>Paste</span></button>' +
          '<textarea class="cbf-in" rows="1" placeholder="Type or paste to share…" aria-label="Text to share" enterkeyhint="send" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>' +
          '<button type="button" class="cbf-send" data-act="send" title="Add to the feed (Enter)" aria-label="Add to the feed" disabled>' + ICON_SEND + '</button>' +
        '</div>' +
        '<div class="cbf-bar">' +
          '<label class="cbf-search">' + ICON_SEARCH +
            '<input class="cbf-q" type="search" placeholder="Filter" aria-label="Filter the feed" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">' +
          '</label>' +
          '<span class="cbf-count" aria-live="polite"></span>' +
          '<button type="button" class="cbf-clear" data-act="clear" hidden>Clear all</button>' +
        '</div>' +
        '<div class="cbf-hint" hidden><span class="cbf-hint-t"></span><button type="button" class="cbf-link-btn" data-act="sync" hidden>Set up Sync</button></div>' +
      '</div>' +
      '<div class="cbf-scroll" tabindex="-1">' +
        '<div class="cbf-list" role="list" aria-label="Clipboard feed"></div>' +
        '<div class="cbf-empty" hidden></div>' +
        '<button type="button" class="cbf-btn cbf-morebtn" data-act="showmore" hidden></button>' +
      '</div>' +
      '<div class="cbf-menu" role="menu" hidden></div>' +
      '<div class="cbf-drop" hidden><span>Drop to share</span></div>' +
    '</div>';

  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    try { if (window.__cadeClipCapture) window.__cadeClipCapture.hideChip(); } catch (e) {}   // the feed shows it now
    var p = Cade.mkPanel(PANEL_ID, '📋 Clipboard', SHELL);
    var root = p.querySelector('.cbf-root');
    var st = V = {
      el: p, root: root, list: root.querySelector('.cbf-list'), scroll: root.querySelector('.cbf-scroll'),
      menu: root.querySelector('.cbf-menu'), input: root.querySelector('.cbf-in'), qEl: root.querySelector('.cbf-q'),
      feed: null, unsub: null, mode: '', devId: '', status: '', error: null, busy: '', q: '', limit: STEP,
      cards: {}, queued: false, dirty: false, pruned: false, menuKey: null, lp: null, lpFired: 0, flash: {}, tick: 0, newKey: null,
    };
    p._onClose = function () { teardown(st); };
    bind(st);
    st.tick = setInterval(function () { if (V === st && !document.hidden && !Cade.isMinimized(st.el)) refreshTimes(); }, 30000);
    if (!coarse()) { try { st.input.focus({ preventScroll: true }); } catch (e) {} }
    loadModel().then(function (svc) {
      if (V !== st) return;
      M = svc.M;
      st.mode = svc.mode();
      try { st.devId = Cade.cloud.device.id; } catch (e) { st.devId = ''; }
      st.feed = svc.feed();
      st.unsub = st.feed.attach(function (type, key, info) { onFeed(st, type, key, info); });
      updateHint();
      schedule();
    }, function (e) {
      if (V !== st) return;
      st.error = e;
      showEmpty(e.message || 'Could not load the Clipboard');
    });
  }
  function teardown(st) {
    if (V !== st) return;
    clearInterval(st.tick);
    if (st.lp && st.lp.t) clearTimeout(st.lp.t);
    for (var k in st.flash) clearTimeout(st.flash[k]);
    st.flash = {};
    if (st.unsub) { try { st.unsub(); } catch (e) {} st.unsub = null; }
    st.cards = {};
    V = null;
  }
  function close() {
    var p = document.getElementById(PANEL_ID);
    if (p) { p.remove(); if (p._onClose) p._onClose(); }
  }
  function q(sel) { return V ? V.root.querySelector(sel) : null; }

  function onFeed(st, type, key, info) {
    if (V !== st) return;
    if (type === 'status') { st.status = info; updateHint(); return; }
    if (type === 'error') { st.error = info; updateHint(); schedule(); return; }
    if (type === 'ready') {
      st.error = null;
      updateHint();
      if (!st.pruned) { st.pruned = true; st.feed.prune().catch(function () {}); }   // old items go even when nothing new is added
    }
    if (type === 'remove' && st.menuKey === key) closeMenu();
    schedule();
  }
  // Coalesce a burst of feed events (the initial replay) into one DOM pass.
  function schedule() {
    var st = V;
    if (!st || st.queued) return;
    st.queued = true;
    Promise.resolve().then(function () { st.queued = false; if (V === st) render(); });
  }

  // ---- rendering ---------------------------------------------------------------------------
  function now() { return V && V.mode === 'cloud' ? Cade.cloud.serverNow() : Date.now(); }
  function srcLabel(e) {
    var r = e.rec, name = r ? (r.by || 'Unknown device') : '…';
    return name + ' · ' + M.relTime(e.at, now());
  }
  function render() {
    var st = V;
    if (!st || !st.feed) return;
    if (Cade.isMinimized(st.el)) { st.dirty = true; return; }
    st.dirty = false;
    var feed = st.feed, all = feed.list(), qq = st.q.trim(), shown = [], waiting = 0, i, e;
    for (i = 0; i < all.length; i++) {
      e = all[i];
      if (qq) {
        if (e.st === 0) { waiting++; feed.decrypt(e.key); continue; }
        if (!M.matches(e.rec, qq)) continue;
      }
      shown.push(e);
    }
    var vis = shown.slice(0, st.limit), list = st.list, cur = list.firstChild, keep = {};
    for (i = 0; i < vis.length; i++) {
      e = vis[i];
      var card = st.cards[e.key];
      if (!card) { card = makeCard(e); st.cards[e.key] = card; }
      else if (card.__v !== e.v) fillCard(card, e);
      keep[e.key] = 1;
      var lastPin = !!(e.p && !(vis[i + 1] && vis[i + 1].p));
      if (card.__lastPin !== lastPin) { card.classList.toggle('cbf-lastpin', lastPin); card.__lastPin = lastPin; }
      if (card === cur) cur = cur.nextSibling; else list.insertBefore(card, cur);
      if (e.st === 0) feed.decrypt(e.key);
    }
    for (var k in st.cards) {
      if (keep[k]) continue;
      var c = st.cards[k];
      if (c.parentNode) c.parentNode.removeChild(c);
      delete st.cards[k];
    }
    // footer bits
    var more = q('.cbf-morebtn'), rest = shown.length - vis.length;
    more.hidden = rest <= 0;
    if (rest > 0) more.textContent = 'Show ' + Math.min(STEP, rest) + ' more';
    var cnt = feed.counts();
    q('.cbf-count').textContent = qq ? (shown.length + ' of ' + cnt.n) : (cnt.n ? plural(cnt.n, 'item') + (cnt.pinned ? ' · ' + cnt.pinned + ' pinned' : '') : '');
    q('.cbf-clear').hidden = !cnt.n || !!qq;
    if (!vis.length) {
      if (st.error && !all.length) showEmpty('Sync refused the feed (' + (st.error.code || st.error.message || 'error') + ').');
      else if (!feed.loaded && !all.length) showEmpty(st.status === 'connecting' ? 'Connecting to Sync…' : 'Loading…');
      else if (qq) showEmpty(waiting ? 'Searching…' : 'Nothing matches “' + qq + '”.');
      else showEmpty(st.mode === 'cloud'
        ? 'Nothing here yet. Copy something in the app — or paste it above — and it shows up here and on your other devices. Tap a card to copy it.'
        : 'Nothing here yet. Copy something in the app — or paste it above — and it shows up here. Tap a card to copy it.');
    } else showEmpty('');
  }
  function showEmpty(msg) {
    var e = q('.cbf-empty');
    if (!e) return;
    e.hidden = !msg;
    e.textContent = msg || '';
  }
  function refreshTimes() {
    if (!V || !V.feed) return;
    for (var k in V.cards) {
      var e = V.feed.get(k), s = V.cards[k].querySelector('.cbf-src');
      if (e && s) s.textContent = srcLabel(e);
    }
  }
  function updateHint() {
    var st = V;
    if (!st) return;
    var h = q('.cbf-hint'), t = q('.cbf-hint-t'), b = q('[data-act="sync"]'), msg = '', btn = false;
    if (st.busy) msg = st.busy;
    else if (st.mode === 'local') { msg = 'Only on this device — set up Sync to share between your devices.'; btn = typeof window.openSyncModal === 'function'; }
    else if (st.mode === 'cloud' && st.error) msg = 'Sync refused the feed: ' + (st.error.code || st.error.message || 'error');
    else if (st.mode === 'cloud' && st.status === 'connecting') msg = 'Connecting to Sync…';
    else if (st.mode === 'cloud' && navigator.onLine === false) msg = 'Offline — new items sync when you’re back online.';
    h.hidden = !msg;
    h.classList.toggle('cbf-busy', !!st.busy);
    t.textContent = msg;
    b.hidden = !btn || !!st.busy;
  }
  function setBusy(msg) { if (V) { V.busy = msg || ''; updateHint(); } }

  function makeCard(e) {
    var c = el('div', 'cbf-card');
    c.setAttribute('data-key', e.key);
    c.setAttribute('role', 'listitem');
    c.tabIndex = 0;
    c.__v = -1;
    c.__lastPin = false;
    fillCard(c, e);
    if (V.newKey === e.key) { c.classList.add('cbf-new'); V.newKey = null; }
    return c;
  }
  function iconBtn(act, html, label, cls) {
    var b = el('button', 'cbf-ib' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    b.setAttribute('data-act', act);
    b.setAttribute('aria-label', label);
    b.title = label;
    if (html.charAt(0) === '<') b.innerHTML = html; else b.textContent = html;   // our own static icons only
    return b;
  }
  function fillCard(c, e) {
    c.__v = e.v;
    var rec = e.rec, own = !!(rec && V.mode === 'cloud' && rec.did && rec.did === V.devId);
    var keepCls = ['cbf-copied', 'cbf-menuon', 'cbf-gone', 'cbf-new'].filter(function (k) { return c.classList.contains(k); }).map(function (k) { return ' ' + k; }).join('');
    c.className = 'cbf-card' + (e.p ? ' cbf-pinned' : '') + (own ? ' cbf-own' : '') + (e.st === 0 ? ' cbf-pending' : '') +
      (e.st === 2 ? ' cbf-bad' : '') + (rec && rec.img ? ' cbf-isimg' : '') + (c.__lastPin ? ' cbf-lastpin' : '') + keepCls;
    c.setAttribute('aria-label', e.st === 1 ? (rec.img ? 'Image' : 'Text') + ' from ' + (rec.by || 'unknown device') + ' — tap to copy' : 'Clipboard item');
    c.textContent = '';
    var body = el('div', 'cbf-body');
    if (e.st === 0) body.appendChild(el('div', 'cbf-ph'));
    else if (e.st === 2) body.appendChild(el('div', 'cbf-unread', 'Can’t read this item — it was sealed with a different sync key.'));
    else if (rec.img) {
      var img = el('img', 'cbf-img');
      img.alt = 'Image' + (rec.img.w ? ' ' + rec.img.w + '×' + rec.img.h : '');
      img.decoding = 'async';
      img.draggable = false;
      if (rec.img.w && rec.img.h) img.style.aspectRatio = rec.img.w + ' / ' + rec.img.h;
      img.src = rec.img.thumb;   // validated data:image/… by the model
      body.appendChild(img);
      if (rec.img.w) body.appendChild(el('div', 'cbf-more', rec.img.w + ' × ' + rec.img.h));
    } else {
      var u = M.findUrl(rec.t), pv = M.preview(rec.t, M.C.SHOW_LINES, 600, rec.big ? rec.big.lines : 0);
      if (u && u.only) {
        var row = el('div', 'cbf-urlrow');
        row.appendChild(el('span', 'cbf-host', u.host));
        body.appendChild(row);
      }
      var pre = el('pre', 'cbf-text' + (u && u.only ? ' cbf-urltext' : ''), pv.head);
      body.appendChild(pre);
      var moreTxt = pv.more ? '+' + pv.more + ' more line' + (pv.more === 1 ? '' : 's') : (pv.clipped || rec.big) ? M.fmtSize(rec.big ? rec.big.n : rec.t.length) + ' in all' : '';
      if (moreTxt) body.appendChild(el('div', 'cbf-more', moreTxt));
      if (u) {
        var a = el('a', 'cbf-open');
        a.href = u.url;               // http(s) only (findUrl)
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = 'Open ' + u.url;
        a.innerHTML = ICON_OPEN;
        a.appendChild(el('span', '', u.only ? 'Open' : u.host));
        body.appendChild(a);
      }
    }
    c.appendChild(body);
    var meta = el('div', 'cbf-meta');
    var src = el('span', 'cbf-src', e.st === 1 ? srcLabel(e) : '');
    if (own) src.title = 'From this device';
    meta.appendChild(src);
    if (rec && rec.cut) {
      var cut = el('span', 'cbf-tag', 'truncated');
      cut.title = 'Only the first ' + M.fmtSize(M.C.TEXT_MAX) + ' of ' + M.fmtSize(rec.cut) + ' were kept';
      meta.appendChild(cut);
    }
    meta.appendChild(el('span', 'cbf-ok', 'Copied ✓'));
    if (e.st === 1) {
      var pin = iconBtn('pin', ICON_PIN, e.p ? 'Unpin' : 'Pin to the top', 'cbf-pinb' + (e.p ? ' on' : ''));
      pin.setAttribute('aria-pressed', e.p ? 'true' : 'false');
      meta.appendChild(pin);
      meta.appendChild(iconBtn('more', '⋯', 'More actions', 'cbf-moreb'));
    }
    meta.appendChild(iconBtn('del', '×', 'Delete', 'cbf-delb'));
    c.appendChild(meta);
  }

  // ---- events (all on the panel — nothing global) -----------------------------------------
  function bind(st) {
    var root = st.root, inp = st.input;
    root.addEventListener('click', function (ev) {
      if (V !== st) return;
      var t = ev.target;
      var a = t.closest ? t.closest('[data-act]') : null;
      var card = t.closest ? t.closest('.cbf-card') : null;
      // the click that ends a long-press: the menu it opened stays, nothing is copied
      if (card && !a && st.lpFired && Date.now() - st.lpFired < 800) { st.lpFired = 0; return; }
      if (st.menuKey && !(t.closest && t.closest('.cbf-menu'))) {
        var was = st.menuKey;
        closeMenu();
        // a tap outside only dismisses the menu; ⋯ again on the same card toggles it shut
        if (!a || (a.getAttribute('data-act') === 'more' && card && card.getAttribute('data-key') === was)) return;
      }
      if (a) {
        var act = a.getAttribute('data-act'), key = card ? card.getAttribute('data-key') : st.menuKey;
        ev.preventDefault();
        switch (act) {
          case 'paste': pasteFromClipboard(); break;
          case 'send': sendCompose(); break;
          case 'clear': clearAll(); break;
          case 'showmore': st.limit += STEP; render(); break;
          case 'sync': if (typeof window.openSyncModal === 'function') window.openSyncModal(); break;
          case 'pin': togglePin(key); break;
          case 'more': openMenu(card, a); break;
          case 'del': removeItem(key, card); break;
          default: if (act.indexOf('m-') === 0) menuAction(act, a.getAttribute('data-key')); break;
        }
        return;
      }
      if (t.closest && t.closest('a')) return;   // the open-link icon
      if (!card) return;
      var sel = '';
      try { sel = String(win().getSelection() || ''); } catch (x) {}
      if (sel && !coarse()) return;   // selecting part of a card to copy it by hand
      copyItem(card.getAttribute('data-key'), card);
    });
    root.addEventListener('contextmenu', function (ev) {
      var card = ev.target.closest && ev.target.closest('.cbf-card');
      if (!card || (ev.target.closest && ev.target.closest('a, .cbf-menu'))) return;
      ev.preventDefault();
      openMenu(card, null);
    });
    // long-press (touch) → actions menu; pointerdown also starts fetching a big item's blob
    root.addEventListener('pointerdown', function (ev) {
      var card = ev.target.closest && ev.target.closest('.cbf-card');
      if (!card || (ev.target.closest && ev.target.closest('button, a'))) return;
      var key = card.getAttribute('data-key');
      prefetch(key);
      if (ev.pointerType === 'mouse') return;
      if (st.lp && st.lp.t) clearTimeout(st.lp.t);
      st.lp = { x: ev.clientX, y: ev.clientY, t: setTimeout(function () {
        st.lp.t = 0;
        if (V !== st || !card.isConnected) return;
        st.lpFired = Date.now();
        try { Cade.haptic(12); } catch (e) {}
        openMenu(card, null);
      }, LONG_MS) };
    });
    function cancelLp() { if (st.lp && st.lp.t) { clearTimeout(st.lp.t); st.lp.t = 0; } }
    root.addEventListener('pointerup', cancelLp);
    root.addEventListener('pointercancel', cancelLp);
    root.addEventListener('pointermove', function (ev) {
      if (st.lp && st.lp.t && (Math.abs(ev.clientX - st.lp.x) > 10 || Math.abs(ev.clientY - st.lp.y) > 10)) cancelLp();
    });
    st.scroll.addEventListener('scroll', function () { cancelLp(); if (st.menuKey) closeMenu(); }, { passive: true });

    root.addEventListener('input', function (ev) {
      var t = ev.target;
      if (t === inp) { grow(inp); q('.cbf-send').disabled = M ? M.isBlank(inp.value) : !inp.value.trim(); }
      else if (t === st.qEl) { st.q = t.value; st.limit = STEP; schedule(); }
    });
    root.addEventListener('keydown', function (ev) { if (V === st) onKey(ev); });
    root.addEventListener('paste', function (ev) { if (V === st) onPaste(ev); });
    ['dragenter', 'dragover'].forEach(function (type) {
      root.addEventListener(type, function (ev) {
        var k = dragKind(ev);
        if (!k || ev.target === inp) return;
        ev.preventDefault();
        ev.stopPropagation();   // keep the app's "drop files to import" overlay out of the panel
        try { ev.dataTransfer.dropEffect = 'copy'; } catch (e) {}
        showDrop(true);
      });
    });
    root.addEventListener('dragleave', function (ev) { if (!ev.relatedTarget || !root.contains(ev.relatedTarget)) showDrop(false); });
    root.addEventListener('drop', function (ev) {
      var k = dragKind(ev);
      if (!k || ev.target === inp) return;
      ev.preventDefault();
      ev.stopPropagation();
      showDrop(false);
      var dt = ev.dataTransfer;
      if (k === 'files') {
        var imgs = imageFiles(dt);
        if (!imgs.length) { toast('Only images (or text) can be dropped here', 'info', 2200); return; }
        addImages(imgs);
      } else addText(dt.getData('text/plain'));
    });
    // minimized: no DOM work; catch up on restore
    st.el.addEventListener('cade-panel-restore', function () { if (V === st) { if (st.dirty) render(); refreshTimes(); } });
    st.el.addEventListener('cade-panel-minimize', function () { if (V === st) closeMenu(); });
  }
  function grow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 132) + 'px';
  }
  function onKey(ev) {
    var t = ev.target, k = ev.key;
    if (ev.isComposing || ev.keyCode === 229) return;
    if (k === 'Escape') {
      ev.preventDefault(); ev.stopPropagation();
      if (V.menuKey) { var c = V.cards[V.menuKey]; closeMenu(); if (c) c.focus(); return; }
      if (t === V.qEl && V.q) { V.q = ''; V.qEl.value = ''; schedule(); return; }
      close();
      return;
    }
    if (t === V.input && k === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendCompose(); return; }
    var card = t.classList && t.classList.contains('cbf-card') ? t : null;
    if (card && (k === 'Enter' || k === ' ')) { ev.preventDefault(); copyItem(card.getAttribute('data-key'), card); return; }
    if (card && (k === 'ContextMenu' || (k === 'F10' && ev.shiftKey))) { ev.preventDefault(); openMenu(card, null, true); return; }
    if (card && (k === 'ArrowDown' || k === 'ArrowUp')) {
      ev.preventDefault();
      var n = k === 'ArrowDown' ? card.nextElementSibling : card.previousElementSibling;
      if (n) n.focus();
      return;
    }
    if (V.menuKey && (k === 'ArrowDown' || k === 'ArrowUp') && t.closest && t.closest('.cbf-menu')) {
      ev.preventDefault();
      var m = k === 'ArrowDown' ? t.nextElementSibling : t.previousElementSibling;
      if (m) m.focus();
    }
  }

  // ---- adding ------------------------------------------------------------------------------
  function ready() {
    if (V && V.feed) return true;
    toast('Still loading…', 'info', 1200);
    return false;
  }
  function added(st, r) {
    if (V !== st || !r) return;
    if (r.dup) { toast('Already the newest item', 'info', 1400); return; }
    if (r.skipped) { if (r.skipped !== 'empty') toast('Not added: ' + r.skipped, 'error', 2400); return; }
    var c = st.cards[r.key];
    if (c) { c.classList.remove('cbf-new'); void c.offsetWidth; c.classList.add('cbf-new'); } else st.newKey = r.key;
    st.scroll.scrollTop = 0;
  }
  function addFailed(st, e) {
    if (V === st) setBusy('');
    toast('Couldn’t add it: ' + ((e && e.message) || 'error'), 'error', 3200);
  }
  function addText(text) {
    var st = V;
    if (!ready()) return Promise.resolve();
    if (M.isBlank(text)) { toast('Nothing to add', 'info', 1400); return Promise.resolve(); }
    return st.feed.add({ text: text }).then(function (r) { added(st, r); }, function (e) { addFailed(st, e); });
  }
  function sendCompose() {
    var st = V, t = st.input.value;
    if (!ready() || M.isBlank(t)) return;
    addText(t).then(function () {
      if (V !== st) return;
      st.input.value = '';
      grow(st.input);
      q('.cbf-send').disabled = true;
    });
  }
  function addImages(blobs) {
    var st = V;
    if (!ready()) return;
    blobs = blobs.slice(0, 5);
    var i = 0;
    (function next() {
      if (V !== st || i >= blobs.length) { if (V === st) setBusy(''); return; }
      var b = blobs[i++];
      setBusy('Preparing image' + (blobs.length > 1 ? ' ' + i + ' of ' + blobs.length : '') + '…');
      makeImage(b).then(function (im) {
        if (V !== st) return null;
        return st.feed.add({ img: { w: im.w, h: im.h, thumb: im.thumb }, full: im.full });
      }).then(function (r) { added(st, r); next(); }, function (e) { addFailed(st, e); next(); });
    })();
  }
  function imageFiles(dt) {
    var out = [], i;
    if (!dt) return out;
    if (dt.items && dt.items.length) {
      for (i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        if (it.kind === 'file' && /^image\//.test(it.type)) { var f = it.getAsFile(); if (f) out.push(f); }
      }
    }
    if (!out.length && dt.files) for (i = 0; i < dt.files.length; i++) if (/^image\//.test(dt.files[i].type)) out.push(dt.files[i]);
    return out;
  }
  function dragKind(ev) {
    var dt = ev.dataTransfer, types = dt && dt.types ? Array.prototype.slice.call(dt.types) : [];
    if (types.indexOf('Files') >= 0) return 'files';
    if (types.indexOf('text/plain') >= 0) return 'text';
    return '';
  }
  function showDrop(on) { var d = q('.cbf-drop'); if (d) d.hidden = !on; }
  function onPaste(ev) {
    var t = ev.target, dt = ev.clipboardData;
    if (t === V.qEl || !dt) return;
    var imgs = imageFiles(dt);
    if (imgs.length) { ev.preventDefault(); addImages(imgs); return; }
    if (t === V.input) return;   // text lands in the box; Enter adds it
    var text = dt.getData('text/plain');
    if (text) { ev.preventDefault(); addText(text); }
  }
  // The Paste button. iOS shows its own "Paste" bubble for read(); a tap
  // elsewhere refuses, which is not an error worth more than a hint.
  function pasteFromClipboard() {
    var st = V, cb = win().navigator.clipboard;
    if (!ready()) return;
    function denied(e) {
      if (V !== st) return;
      var name = e && e.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') toast('Paste wasn’t allowed — long-press the text box and choose Paste', 'info', 3200);
      else toast('Couldn’t read the clipboard here — paste into the text box instead', 'info', 3000);
      try { st.input.focus(); } catch (x) {}
    }
    function viaText() {
      if (!cb || !cb.readText) { denied(null); return; }
      cb.readText().then(function (t) {
        if (V !== st) return;
        if (M.isBlank(t)) toast('The clipboard is empty', 'info', 1600); else addText(t);
      }, denied);
    }
    if (cb && cb.read) {
      cb.read().then(function (items) {
        if (V !== st) return;
        var img = null, txt = null, i, j;
        for (i = 0; i < items.length && !img; i++) for (j = 0; j < items[i].types.length; j++) if (/^image\//.test(items[i].types[j])) { img = { item: items[i], type: items[i].types[j] }; break; }
        if (!img) for (i = 0; i < items.length && !txt; i++) if (items[i].types.indexOf('text/plain') >= 0) txt = items[i];
        if (img) return img.item.getType(img.type).then(function (b) { addImages([b]); });
        if (txt) return txt.getType('text/plain').then(function (b) { return b.text(); }).then(function (t) {
          if (M.isBlank(t)) toast('The clipboard is empty', 'info', 1600); else addText(t);
        });
        toast('Nothing on the clipboard to paste', 'info', 1800);
      }, function (e) {
        // Some browsers have read() but refuse it for text-only content: try readText.
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) denied(e); else viaText();
      }).catch(denied);
    } else viaText();
  }

  // ---- images (compress: full ≤ 1600 px, thumbnail ≤ 160 px) -------------------------------
  var _mime = null;
  function encMime() {
    if (_mime) return _mime;
    var c = document.createElement('canvas'), ok = false;
    c.width = c.height = 2;
    try { ok = c.toDataURL('image/webp').indexOf('data:image/webp') === 0; } catch (e) {}
    return (_mime = ok ? 'image/webp' : 'image/jpeg');
  }
  function decode(blob) {
    function viaImg() {
      return new Promise(function (res, rej) {
        var u = URL.createObjectURL(blob), im = new Image();
        im.onload = function () { res({ src: im, w: im.naturalWidth, h: im.naturalHeight, done: function () { URL.revokeObjectURL(u); } }); };
        im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('couldn’t read that image')); };
        im.src = u;
      });
    }
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob).then(function (bm) {
        return { src: bm, w: bm.width, h: bm.height, done: function () { try { bm.close(); } catch (e) {} } };
      }, viaImg);
    }
    return viaImg();
  }
  function draw(img, max, qual) {
    var s = Math.min(1, max / Math.max(img.w, img.h)), w = Math.max(1, Math.round(img.w * s)), h = Math.max(1, Math.round(img.h * s));
    var c = document.createElement('canvas'), mime = encMime();
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    if (mime === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
    g.imageSmoothingQuality = 'high';
    g.drawImage(img.src, 0, 0, w, h);
    var d = c.toDataURL(mime, qual);
    c.width = c.height = 0;   // hand the canvas memory back now (iOS is strict about it)
    return { d: d, w: w, h: h };
  }
  function makeImage(blob) {
    return decode(blob).then(function (img) {
      try {
        if (!img.w || !img.h) throw new Error('couldn’t read that image');
        var full = null, max = 1600, qual = 0.82;
        for (var i = 0; i < 9; i++) {
          full = draw(img, max, qual);
          if (full.d.length <= M.C.IMG_MAX) break;
          if (qual > 0.62) qual -= 0.1; else max = Math.round(max * 0.8);
        }
        if (full.d.length > M.C.IMG_MAX) throw new Error('that image is too large to share');
        var th = draw(img, 160, 0.6);
        if (th.d.length > M.C.THUMB_MAX) th = draw(img, 112, 0.4);
        return { w: full.w, h: full.h, thumb: th.d, full: full.d };
      } finally { img.done(); }
    });
  }
  // Anything an <img> can show → PNG Blob (the image type every clipboard takes).
  function toPng(dataUrl) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () {
        var c = document.createElement('canvas');
        c.width = im.naturalWidth; c.height = im.naturalHeight;
        c.getContext('2d').drawImage(im, 0, 0);
        c.toBlob(function (b) { c.width = c.height = 0; if (b) res(b); else rej(new Error('encode failed')); }, 'image/png');
      };
      im.onerror = function () { rej(new Error('decode failed')); };
      im.src = dataUrl;
    });
  }
  function dataUrlFile(d, base) {
    var m = /^data:([^;,]+);base64,/.exec(d);
    if (!m) return null;
    var bin = atob(d.slice(m[0].length)), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    var ext = m[1] === 'image/png' ? 'png' : m[1] === 'image/webp' ? 'webp' : m[1] === 'image/gif' ? 'gif' : 'jpg';
    try { return new File([u8], base + '.' + ext, { type: m[1] }); } catch (e) { var b = new Blob([u8], { type: m[1] }); b.name = base + '.' + ext; return b; }
  }
  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  // ---- copying ----------------------------------------------------------------------------
  function prefetch(key) {
    var e = V && V.feed && V.feed.get(key);
    if (!e || e.st !== 1) return;
    if (e.rec.img) V.feed.fullImage(key).catch(function () {});
    else if (e.rec.big) V.feed.fullText(key).catch(function () {});
  }
  function legacyCopy(text) {
    var d = V ? V.el.ownerDocument : document, ta = d.createElement('textarea'), ok = false;
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    (V ? V.root : d.body).appendChild(ta);
    try { ta.focus({ preventScroll: true }); } catch (e) {}
    ta.select();
    try { ta.setSelectionRange(0, text.length); } catch (e) {}
    ownOn();
    try { ok = d.execCommand('copy'); } catch (e) { ok = false; }
    ownOff();
    ta.remove();
    return ok;
  }
  // Text onto the clipboard (writeText, else execCommand). Resolves true on success.
  function copyText(text) {
    var cb = win().navigator.clipboard, p = null;
    ownOn();
    try { if (cb && cb.writeText) p = cb.writeText(text); } catch (e) { p = null; }
    ownOff();
    if (!p) return Promise.resolve(legacyCopy(text));
    return p.then(function () { return true; }, function () { return legacyCopy(text); });
  }
  function copied(card, msg, type) {
    try { Cade.haptic(10); } catch (e) {}
    toast(msg || 'Copied', type || 'success', type === 'info' ? 2600 : 1200);
    if (!card || !V) return;
    var key = card.getAttribute('data-key'), st = V;
    card.classList.add('cbf-copied');
    if (st.flash[key]) clearTimeout(st.flash[key]);
    st.flash[key] = setTimeout(function () { delete st.flash[key]; card.classList.remove('cbf-copied'); }, 1400);
  }
  function copyFailed() { toast('Couldn’t copy here — long-press the card for Share', 'error', 3000); }
  // Tap = copy. Everything up to the clipboard call runs synchronously inside the
  // tap: iOS only lets a page write the clipboard during the user's gesture, which
  // is why a not-yet-fetched blob goes in as a Promise inside ClipboardItem.
  function copyItem(key, card) {
    var st = V, e = st && st.feed && st.feed.get(key);
    if (!e) return;
    if (e.st === 0) { st.feed.decrypt(key); toast('Still decrypting — tap again', 'info', 1200); return; }
    if (e.st === 2) { toast('Can’t read this item', 'error', 1800); return; }
    if (e.rec.img) { copyImage(e, card); return; }
    var text = st.feed.fullTextNow(key);
    if (text != null) { copyText(text).then(function (ok) { if (ok) copied(card); else copyFailed(); }); return; }
    var w = win(), CI = w.ClipboardItem, cb = w.navigator.clipboard;
    var tp = st.feed.fullText(key).then(function (t) { if (t == null) throw new Error('unavailable'); return t; });
    var later = function () {
      tp.then(copyText).then(function (ok) { if (ok) copied(card); else copyFailed(); },
        function () { toast('Couldn’t fetch the whole text — check the connection', 'error', 3000); });
    };
    if (!CI || !cb || !cb.write) { later(); return; }
    var p;
    ownOn();
    try { p = cb.write([new CI({ 'text/plain': tp.then(function (t) { return new Blob([t], { type: 'text/plain' }); }) })]); } catch (x) { p = null; }
    ownOff();
    if (!p) { later(); return; }
    p.then(function () { copied(card); }, later);
  }
  function copyImage(e, card) {
    var st = V, w = win(), CI = w.ClipboardItem, cb = w.navigator.clipboard, thumb = false;
    if (!CI || !cb || typeof cb.write !== 'function') { toast('This browser can’t copy images — use ⋯ → Share or Save', 'info', 3200); return; }
    var pngP = st.feed.fullImage(e.key).catch(function () { return null; }).then(function (d) {
      if (!d) { thumb = true; d = e.rec.img.thumb; }   // full image unreachable (offline): the preview is better than nothing
      return toPng(d);
    });
    var done = function () { copied(card, thumb ? 'Copied the preview — the full image isn’t reachable right now' : 'Image copied', thumb ? 'info' : 'success'); };
    var p;
    ownOn();
    try { p = cb.write([new CI({ 'image/png': pngP })]); } catch (x) { p = null; }
    ownOff();
    var retry = function () {   // a browser that wants the Blob itself, not a Promise of it
      return pngP.then(function (blob) {
        ownOn();
        try { return cb.write([new CI({ 'image/png': blob })]); } finally { ownOff(); }
      }).then(done, function () { toast('Couldn’t copy the image here — use ⋯ → Share or Save', 'error', 3200); });
    };
    if (!p) { retry(); return; }
    p.then(done, retry);
  }

  // ---- card actions --------------------------------------------------------------------------
  function togglePin(key) {
    var st = V, e = st.feed.get(key);
    if (!e) return;
    st.feed.setPin(key, !e.p).then(function (r) {
      if (V !== st) return;
      if (!r.ok && r.reason === 'cap') toast('Up to ' + M.C.PIN_CAP + ' pinned items — unpin one first', 'info', 2600);
    }, function (err) { toast('Couldn’t pin: ' + ((err && err.message) || 'error'), 'error', 2600); });
  }
  function removeItem(key, card) {
    var st = V;
    if (!key) return;
    if (card) card.classList.add('cbf-gone');
    st.feed.remove(key).then(null, function (err) {
      if (card) card.classList.remove('cbf-gone');
      toast('Couldn’t delete: ' + ((err && err.message) || 'error'), 'error', 2600);
    });
  }
  function clearAll() {
    var st = V, c = st.feed.counts(), un = c.n - c.pinned;
    if (!c.n) return;
    var all = !un;
    var msg = all ? 'Remove all ' + plural(c.pinned, 'pinned item') + '?'
      : 'Clear ' + plural(un, 'item') + (st.mode === 'cloud' ? ' from the feed on all your devices?' : ' from the feed?') + (c.pinned ? ' Pinned items stay.' : '');
    if (!win().confirm(msg)) return;
    closeMenu();
    st.feed.clear(all).then(function (n) { if (V === st) toast('Cleared ' + plural(n, 'item'), 'success', 1600); },
      function (err) { toast('Couldn’t clear: ' + ((err && err.message) || 'error'), 'error', 2600); });
  }
  function insertText(text) {
    var ed = Cade.editor;
    if (!ed) { toast('No note is open', 'error', 2000); return; }
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2200); return; }
    ed.dispatch(ed.state.replaceSelection(text), { scrollIntoView: true, userEvent: 'input.paste' });
    toast('Inserted into the note', 'success', 1400);
  }
  function shareItem(e) {
    var nav = win().navigator, st = V;
    var fail = function (err) { if (!err || err.name !== 'AbortError') toast('Share didn’t work here', 'error', 2200); };
    if (!nav.share) { toast('No share sheet in this browser', 'info', 2000); return; }
    if (e.rec.img) {
      var b = st.feed.cachedBlob(e.key), d = b && b.d;
      if (!d) { st.feed.fullImage(e.key).catch(function () {}); toast('Fetching the image — tap Share again in a moment', 'info', 2200); return false; }
      var f = dataUrlFile(d, 'clipboard-' + stamp());
      if (!f || (nav.canShare && !nav.canShare({ files: [f] }))) { toast('This browser can’t share images', 'info', 2200); return; }
      nav.share({ files: [f] }).catch(fail);
      return;
    }
    var t = st.feed.fullTextNow(e.key);
    if (t == null) { st.feed.fullText(e.key).catch(function () {}); toast('Fetching the text — tap Share again in a moment', 'info', 2200); return false; }
    var u = M.findUrl(t);
    nav.share(u && u.only ? { url: u.url } : { text: t }).catch(fail);
  }
  function saveImage(e) {
    var st = V;
    st.feed.fullImage(e.key).catch(function () { return null; }).then(function (d) {
      d = d || e.rec.img.thumb;
      var f = dataUrlFile(d, 'clipboard-' + stamp());
      if (!f) return;
      var url = URL.createObjectURL(f), a = document.createElement('a');
      a.href = url; a.download = f.name || 'clipboard-image';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    });
  }

  // ---- ⋯ menu ------------------------------------------------------------------------------------
  function openMenu(card, anchor, kbd) {
    var st = V, key = card && card.getAttribute('data-key'), e = key && st.feed.get(key);
    if (!e) return;
    if (st.menuKey === key && !st.menu.hidden) return;
    var rec = e.st === 1 ? e.rec : null, isImg = !!(rec && rec.img), u = rec && rec.t ? M.findUrl(rec.t) : null, nav = win().navigator;
    var items = [];
    if (rec) {
      items.push(['m-copy', isImg ? 'Copy image' : 'Copy']);
      if (!isImg) items.push(['m-insert', 'Insert into the note']);
      if (u) items.push(['m-open', 'Open ' + u.host]);
      if (nav.share) items.push(['m-share', 'Share…']);
      if (isImg) items.push(['m-save', 'Save image']);
      items.push(['m-pin', e.p ? 'Unpin' : 'Pin to the top']);
    }
    items.push(['m-del', 'Delete', 'danger']);
    var m = st.menu;
    m.textContent = '';
    items.forEach(function (it) {
      var b = el('button', it[2] || '', it[1]);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.setAttribute('data-act', it[0]);
      b.setAttribute('data-key', key);
      m.appendChild(b);
    });
    st.menuKey = key;
    m.hidden = false;
    card.classList.add('cbf-menuon');
    if (rec) prefetch(key);
    // place it under the ⋯ (or the card), flipped above when there's no room below
    var rr = st.root.getBoundingClientRect(), ar = (anchor || card).getBoundingClientRect(), mh = m.offsetHeight, mw = m.offsetWidth;
    var top = ar.bottom - rr.top + 4;
    if (top + mh > rr.height - 4) top = Math.max(4, ar.top - rr.top - mh - 4);
    var left = anchor ? ar.right - rr.left - mw : Math.min(ar.left - rr.left + 24, rr.width - mw - 8);
    m.style.top = Math.round(top) + 'px';
    m.style.left = Math.round(Math.max(8, Math.min(left, rr.width - mw - 8))) + 'px';
    if (kbd || !coarse()) { var f = m.querySelector('button'); if (f) { try { f.focus({ preventScroll: true }); } catch (x) {} } }
  }
  function closeMenu() {
    var st = V;
    if (!st || !st.menuKey) return;
    var c = st.cards[st.menuKey];
    if (c) c.classList.remove('cbf-menuon');
    st.menuKey = null;
    st.menu.hidden = true;
    st.menu.textContent = '';
  }
  function menuAction(act, key) {
    var st = V, e = st.feed.get(key), card = st.cards[key];
    if (!e) { closeMenu(); return; }
    var keepOpen = false;
    switch (act) {
      case 'm-copy': copyItem(key, card); break;
      case 'm-insert':
        var t = st.feed.fullTextNow(key);
        if (t != null) insertText(t);
        else st.feed.fullText(key).then(function (x) { if (x != null) insertText(x); else toast('Couldn’t fetch the whole text', 'error', 2400); });
        break;
      case 'm-open':
        var u = M.findUrl(e.rec.t);
        if (u) { var w = win().open(u.url, '_blank', 'noopener,noreferrer'); if (w) { try { w.opener = null; } catch (x) {} } }
        break;
      case 'm-share': keepOpen = shareItem(e) === false; break;
      case 'm-save': saveImage(e); break;
      case 'm-pin': togglePin(key); break;
      case 'm-del': removeItem(key, card); break;
    }
    if (!keepOpen) closeMenu();
  }

  Cade.registerWidget({
    name: META.name,
    description: META.description,
    icon: META.icon,
    tags: META.tags,
    open: open,
    close: close,
  });
})();
