/* Self-destructing links — share a note with someone who has no Cade.txt
 * account: a link that works once, or until a timer runs out (or both), read
 * only or live-editable, end-to-end encrypted. burn-core.js holds the pure
 * logic and the storage layout (see its header); this file is the UI and the
 * Firebase wiring for both sides:
 *
 *  - OWNER (Share → "Self-destructing link…", or Ctrl+K "Self-destructing
 *    links"): a dialog to create a link (expiry, one-time, editing, saving a
 *    copy) and the list of links with their status, time left and Revoke.
 *    The list lives in Cade.syncedBlob('burn') — encrypted with the sync key,
 *    so every device of the owner can show and revoke the links, and keep
 *    editable ones live. The core loads this module at boot only while that
 *    blob lists links that haven't ended (ownerBoot): it sweeps them (expired
 *    / opened ones are destructed) and runs the live merge for editable ones.
 *  - RECIPIENT (the core sees #burn= on load and calls openLink): a full-page
 *    screen over the app with its own named Firebase app, so their own sync,
 *    rooms and Firebase connection are never touched and nothing is imported
 *    into their rooms. When the link ends, the text is wiped from the page
 *    and from storage.
 *
 * Live editing: both sides run a LiveDoc — throttled (~350 ms) encrypted
 * pushes as compare-and-swap transactions on the share's doc, and a three-way
 * merge (merge-core.js via burn-core's mergeLive) whenever someone else's
 * version arrives first. On the owner side the merged text goes into the room
 * through Cade.roomsApi.write, whether or not the room is open. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Cade) return;
  var Cade = window.Cade;
  var BASE = Cade.baseURL();
  Cade.loadCSS('burn.css');

  var NAME = 'Self-destructing links';
  var META = {
    name: NAME,
    description: 'Share a note by a link that self-destructs — after one open, or when a timer runs out — end-to-end encrypted, optionally live-editable; for people without Cade.txt',
    icon: '🔥',
    tags: 'share,link,self-destruct,burn,burn after reading,one-time,expiring,expire,secret,private,encrypted,live,collaborate,guest,send'
  };
  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  var PUSH_MS = 350;
  var SESSION_KEY = 'cade-burn-open';       // sessionStorage: the open link, so a reload of this tab reopens it

  // ---- libraries ------------------------------------------------------------------------------------
  var libP = null;
  function addScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = true; s.onload = res;
      s.onerror = function () { rej(new Error('Could not load ' + src.split('/').pop() + ' (offline?)')); };
      document.head.appendChild(s);
    });
  }
  function libs() {
    if (!libP) {
      libP = Promise.all([
        window.__cadeBurnCore ? null : addScript(BASE + 'burn-core.js'),
        window.__cadeMergeCore ? null : addScript(BASE + '../merge/merge-core.js')
      ]).then(function () {
        if (!window.__cadeBurnCore || !window.__cadeMergeCore) throw new Error('Self-destructing links failed to load');
        return { C: window.__cadeBurnCore, M: window.__cadeMergeCore };
      }).catch(function (e) { libP = null; throw e; });
    }
    return libP;
  }
  var C = null, M = null;

  // ---- Firebase -------------------------------------------------------------------------------------
  function waitFirebase(ms) {
    var t0 = Date.now();
    return new Promise(function (res, rej) {
      (function poll() {
        var fb = window.firebase;
        if (fb && typeof fb.initializeApp === 'function' && typeof fb.database === 'function') return res(fb);
        if (Date.now() - t0 > ms) return rej(new Error('offline'));
        setTimeout(poll, 150);
      })();
    });
  }
  // A Firebase app of our own (never the user's sync app): the recipient
  // always; the owner only when a link lives in a database other than the
  // current sync one.
  function ownApp(db, tag) {
    return waitFirebase(15000).then(function (fb) {
      var app = fb.initializeApp({ databaseURL: db }, 'cade-burn-' + tag + '-' + Math.random().toString(36).slice(2, 8));
      return { app: app, db: fb.database(app) };
    });
  }
  var ownerApps = {};
  function ownerRoot(db) {
    var syncUrl = Cade.store.get('cade-firebase-url') || '';
    var viaSync = db === syncUrl && Cade.cloud.configured()
      ? Cade.cloud.ref('burn').then(function (r) { return r && r.root ? r.root : null; }).catch(function () { return null; })
      : Promise.resolve(null);
    return viaSync.then(function (root) {
      if (root) return root;
      if (!ownerApps[db]) ownerApps[db] = ownApp(db, 'o').catch(function (e) { delete ownerApps[db]; throw e; });
      return ownerApps[db].then(function (a) { return a.db.ref(); });
    });
  }
  function nodeOf(root, id) { return root.child(C.nodePath(id)); }
  function once(ref, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error('offline')); }, ms || 15000);
      ref.once('value').then(function (s) { clearTimeout(t); res(s.val()); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error('offline')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  // The plain parts of a node (never the ciphertext).
  function readPlain(node, ms) {
    return Promise.all(['meta', 'tomb', 'claim'].map(function (k) { return once(node.child(k), ms); }))
      .then(function (v) { return { meta: v[0], tomb: v[1], claim: v[2] }; });
  }
  function tombOf(meta, why, at) { return { meta: meta || null, tomb: { why: why, at: at } }; }
  function txn(ref, fn) {
    // applyLocally = false: no optimistic local events — a version counts only once the server took it.
    return ref.transaction(fn, undefined, false);
  }

  // ---- LiveDoc: one side of a live-editable share ---------------------------------------------------
  // o: { node, id, key, me, now(), get() → text|Promise|null, apply(merged, seen) → Promise,
  //      loadBase() → Promise<{ver,text}|null>, saveBase(shared), adoptFirst (bool), onGone(), onSync(state) }
  function LiveDoc(o) {
    var docRef = o.node.child('doc');
    var shared = null, latest = null, stopped = false, timer = 0, retry = 0, fails = 0, chain = Promise.resolve(), baseLoaded = null;
    function enqueue(fn) {
      chain = chain.then(function () { if (!stopped) return fn(); }).catch(function (e) { console.warn('burn live:', e); });
      return chain;
    }
    function state(s) { if (o.onSync) try { o.onSync(s); } catch (e) {} }
    function onVal(s) { latest = s.val(); enqueue(incoming); }
    docRef.on('value', onVal);

    function incoming() {
      var v = latest;
      if (!v) { stop(); o.onGone(); return; }
      if (shared && (v.ct === shared.ct || v.ver <= shared.ver)) return;
      var theirsP = C.open(o.key, o.id, 'v' + v.ver, v.ct).then(function (x) { return String(x && x.t != null ? x.t : ''); });
      if (!baseLoaded) baseLoaded = Promise.resolve(o.loadBase ? o.loadBase() : null).catch(function () { return null; });
      return Promise.all([theirsP, baseLoaded]).then(function (r) {
        var theirs = r[0], base = shared || r[1];
        if (stopped) return;
        if (!base) {
          // First sight with nothing to merge against: adopt it (the guest
          // shows it; an owner device without a base leaves the room alone).
          shared = { ver: v.ver, text: theirs, ct: v.ct };
          if (o.saveBase) o.saveBase(shared);
          if (o.adoptFirst) return Promise.resolve(o.apply(theirs, null)).then(function () { state('synced'); });
          state('synced');
          return;
        }
        if (base.ver >= v.ver) { shared = { ver: base.ver, text: base.text, ct: base.ct }; return; }
        return Promise.resolve(o.get()).then(function (local) {
          if (local == null) throw new Error('no local text');
          var merged = C.mergeLive(M, base.text, local, theirs);
          var applied = merged === local ? null : o.apply(merged, local);
          return Promise.resolve(applied).then(function () {
            shared = { ver: v.ver, text: theirs, ct: v.ct };
            if (o.saveBase) o.saveBase(shared);
            fails = 0;
            if (merged !== theirs) schedule(); else state('synced');
          });
        });
      }).catch(function (e) {
        // Couldn't apply it here right now (a busy / locked room…): try again soon from the newest version.
        if (stopped) return;
        state('retry');
        clearTimeout(retry);
        if (++fails <= 40) retry = setTimeout(function () { enqueue(incoming); }, Math.min(1500 * fails, 15000));
        throw e;
      });
    }

    function push() {
      if (!shared) return;
      return Promise.resolve(o.get()).then(function (local) {
        if (stopped || local == null || local === shared.text) { state('synced'); return; }
        var baseVer = shared.ver, ver = baseVer + 1, me = o.me;
        state('saving');
        return C.seal(o.key, o.id, 'v' + ver, { t: local }).then(function (ct) {
          if (stopped || shared.ver !== baseVer) return;      // someone else's version came in meanwhile
          return txn(docRef, function (cur) {
            if (cur === null) return null;                       // gone (or not cached yet: the server reruns us)
            if (cur.ver !== baseVer) return undefined;           // lost the race: merge, then retry
            return { ver: ver, ct: ct, by: me, base: baseVer, at: o.now() };
          }).then(function (r) {
            var val = r && r.snapshot ? r.snapshot.val() : null;
            if (r && r.committed && !val) { stop(); o.onGone(); return; }
            if (r && r.committed && val && val.ct === ct) {
              if (!shared || shared.ver < ver) { shared = { ver: ver, text: local, ct: ct }; if (o.saveBase) o.saveBase(shared); }
            }
            // Typed on while it was in flight, or lost the race (the value listener merges first): go again.
            return Promise.resolve(o.get()).then(function (now) { if (now != null && shared && now !== shared.text) schedule(); else state('synced'); });
          });
        });
      });
    }
    function schedule() {
      if (stopped || timer) return;
      state('pending');
      timer = setTimeout(function () { timer = 0; enqueue(push); }, PUSH_MS);
    }
    function flush() { clearTimeout(timer); timer = 0; return enqueue(push); }
    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer); clearTimeout(retry);
      try { docRef.off('value', onVal); } catch (e) {}
    }
    return { changed: schedule, flush: flush, stop: stop, get shared() { return shared; } };
  }

  // =====================================================================================================
  // RECIPIENT
  // =====================================================================================================
  var R = null;    // the open recipient view

  var ENDED = {
    opened: ['🔥', 'This link has already been opened', 'It was a one-time link. Its note was deleted from the server when it was first opened.'],
    claimed: ['🔒', 'This link is open in another browser', 'It was a one-time live link — only the first browser that opened it can use it.'],
    expired: ['⌛', 'This link has expired', 'Its time ran out. The note was deleted and can no longer be read.'],
    revoked: ['🚫', 'The owner ended this link', 'The note was deleted from the server.'],
    gone: ['🔥', 'This link is no longer available', 'It was opened, expired, or ended by its owner.'],
    bad: ['🔗', 'This link is incomplete', 'Part of it is missing. Ask for the whole link — including everything after the #.'],
    key: ['🔑', 'This link can’t be read', 'Its key doesn’t match the note — the link may have been changed or cut short.'],
    offline: ['📡', 'Can’t reach the server', 'Check your connection and try again. The link hasn’t been used up.']
  };

  function rvShell() {
    var el = document.createElement('div');
    el.className = 'burn-rv';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Self-destructing note');
    el.innerHTML =
      '<header class="burn-rv-top">' +
        '<div class="burn-rv-brand"><span class="burn-rv-ic" aria-hidden="true">🔥</span><span class="burn-rv-title">Self-destructing note</span></div>' +
        '<div class="burn-rv-chips">' +
          '<span class="burn-chip burn-chip-live" hidden><i></i><span>Live — your edits are shared</span></span>' +
          '<span class="burn-chip burn-chip-clock" hidden title="Time left"><span class="burn-clock-ic" aria-hidden="true">⏱</span><b>–</b></span>' +
        '</div>' +
        '<button type="button" class="burn-x" data-act="close" aria-label="Close">×</button>' +
      '</header>' +
      '<main class="burn-rv-main"><div class="burn-rv-wait"><span class="burn-spin" aria-hidden="true"></span><span>Opening…</span></div></main>' +
      '<footer class="burn-rv-foot" hidden></footer>';
    // The app's own shortcuts mustn't act on keys typed here.
    el.addEventListener('keydown', function (e) { if (e.key !== 'Escape') e.stopPropagation(); });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var a = b.getAttribute('data-act');
      if (a === 'close') rvClose();
      else if (a === 'retry') { var p = R && R.payload; rvClose(true); openLink(p); }
      else if (a === 'copy') rvCopy();
      else if (a === 'save') rvSave();
    });
    document.body.appendChild(el);
    return el;
  }
  function rvMain() { return R && R.el.querySelector('.burn-rv-main'); }
  function rvFoot(html) {
    var f = R && R.el.querySelector('.burn-rv-foot');
    if (!f) return;
    f.hidden = !html; f.innerHTML = html || '';
  }
  function setSession(p) { try { if (p) sessionStorage.setItem(SESSION_KEY, p); else sessionStorage.removeItem(SESSION_KEY); } catch (e) {} }

  // Entry point (the core calls it for #burn=…; the hash is already gone from the address bar).
  function openLink(payload) {
    if (R) rvClose(true);
    R = { payload: payload, el: null, app: null, offs: [], live: null, ended: false, tick: 0, meta: null, me: null, id: null };
    R.el = rvShell();
    var r = R;
    return libs().then(function (L) {
      C = L.C; M = L.M;
      if (r !== R) return;
      var link = C.decodeLink(payload);
      if (!link) return rvEnd('bad');
      r.id = link.id; r.key = link.key;
      setSession(payload);
      return ownApp(link.db, 'r').then(function (a) {
        if (r !== R) { a.app.delete().catch(function () {}); return; }
        r.app = a.app; r.db = a.db;
        r.offset = 0;
        var offRef = a.db.ref('.info/serverTimeOffset');
        var offFn = function (s) { r.offset = s.val() || 0; };
        offRef.on('value', offFn);
        r.offs.push(function () { offRef.off('value', offFn); });
        r.node = a.db.ref(C.nodePath(link.id));
        return rvGo(r);
      });
    }).catch(function (e) {
      if (r !== R) return;
      console.warn('burn open:', e);
      rvEnd(/offline/.test(String(e && e.message)) ? 'offline' : 'gone', true);
    });
  }
  function rvNow() { return Date.now() + ((R && R.offset) || 0); }
  function meKey(id) { return 'cade-burn-me:' + id; }

  function rvGo(r) {
    var node = r.node;
    r.me = Cade.store.get(meKey(r.id)) || C.newViewer();
    return readPlain(node, 15000).then(function (plain) {
      if (r !== R) return;
      r.meta = plain.meta;
      var g = C.gate(plain, rvNow(), r.me);
      if (!g.ok) {
        if (g.why === 'expired' && !plain.tomb) node.set(tombOf(plain.meta, 'expired', rvNow())).catch(function () {});
        return rvEnd(g.why);
      }
      var claim = !g.needClaim ? Promise.resolve(true) : txn(node.child('claim'), function (cur) { return C.claimUpdate(cur, r.me, rvNow()); })
        .then(function (res) { return C.claimIsMine(res && res.snapshot && res.snapshot.val(), r.me); });
      return withTimeout(claim, 15000).then(function (mine) {
        if (r !== R) return;
        if (!mine) return rvEnd(plain.meta.editable ? 'claimed' : 'opened');
        if (plain.meta.oneTime && plain.meta.editable) Cade.store.set(meKey(r.id), r.me);   // this browser may come back
        return Promise.all([once(node.child('head')), once(node.child('doc'))]).then(function (v) {
          if (r !== R) return;
          var head = v[0], doc = v[1];
          if (!doc || !head) return rvEnd('gone');
          return Promise.all([C.open(r.key, r.id, 'head', head), C.open(r.key, r.id, 'v' + doc.ver, doc.ct)]).then(function (x) {
            if (r !== R) return;
            r.head = x[0] || {};
            var text = String(x[1] && x[1].t != null ? x[1].t : '');
            if (plain.meta.oneTime && !plain.meta.editable) {
              // Read once: delete the ciphertext now (meta + tombstone stay, so a second open can say why).
              node.set(tombOf(plain.meta, 'opened', rvNow())).catch(function () {});
              setSession(null);
            }
            rvShow(r, text, doc);
          }, function () { return rvEnd('key'); });
        });
      });
    });
  }

  function rvShow(r, text, doc) {
    var meta = r.meta, editable = !!meta.editable, copy = !!(r.head && r.head.copy);
    var title = String((r.head && r.head.title) || '').trim();
    r.el.querySelector('.burn-rv-title').textContent = title || 'Shared note';
    r.el.classList.toggle('burn-nocopy', !copy && !editable);
    var main = rvMain();
    main.innerHTML = editable
      ? '<textarea class="burn-rv-text burn-rv-edit" spellcheck="true" autocapitalize="sentences" aria-label="Shared note (live)"></textarea>'
      : '<div class="burn-rv-text burn-rv-read" tabindex="0"></div>';
    var box = main.firstChild;
    if (editable) box.value = text; else box.textContent = text;
    r.box = box;
    r.el.querySelector('.burn-chip-live').hidden = !editable;
    // Footer: what will happen, honestly.
    var bits = [];
    if (meta.oneTime && !editable) bits.push('<b>One-time link:</b> the note was deleted from the server when you opened it. Close this page and it’s gone.');
    else if (meta.oneTime) bits.push('<b>One-time link:</b> it works only in this browser now.');
    if (editable) bits.push('You and the owner are editing the same note — changes appear on both sides as you type.');
    if (meta.expiresAt) bits.push('It self-destructs in <b class="burn-left">' + esc(C.fmtLeft(C.msLeft(meta, rvNow()))) + '</b>.');
    if (!copy && !editable) bits.push('The owner turned off saving a copy.');
    var acts = copy ? '<div class="burn-rv-acts"><button type="button" class="btn" data-act="copy">Copy text</button><button type="button" class="btn" data-act="save">Download .txt</button></div>' : '';
    rvFoot('<p>' + bits.join(' ') + '</p>' + acts);
    // Countdown.
    if (meta.expiresAt) {
      r.el.querySelector('.burn-chip-clock').hidden = false;
      var tick = function () {
        if (r !== R || r.ended) return;
        var left = C.msLeft(meta, rvNow());
        var b = r.el.querySelector('.burn-chip-clock b'); if (b) b.textContent = C.fmtClock(left);
        var f = r.el.querySelector('.burn-left'); if (f) f.textContent = C.fmtLeft(left);
        r.el.querySelector('.burn-chip-clock').classList.toggle('burn-soon', left < 60000);
        if (left <= 0) {
          r.node.set(tombOf(meta, 'expired', rvNow())).catch(function () {});
          return rvEnd('expired');
        }
        r.tick = setTimeout(tick, left > 3600000 ? 30000 : 1000 - (rvNow() % 1000) + 5);
      };
      tick();
    }
    // The owner ending it (or a timer elsewhere) ends it here too.
    var tombRef = r.node.child('tomb'), metaRef = r.node.child('meta');
    var onTomb = function (s) { var t = s.val(); if (t && !(t.why === 'opened' && meta.oneTime && !editable)) rvEnd(t.why || 'gone'); };
    var onMeta = function (s) { if (s.val() === null) rvEnd('gone'); };
    tombRef.on('value', onTomb); metaRef.on('value', onMeta);
    r.offs.push(function () { tombRef.off('value', onTomb); metaRef.off('value', onMeta); });
    // Presence (the owner's list shows "N viewers"); not for a burned one-time read.
    if (!(meta.oneTime && !editable)) {
      var pres = r.node.child('presence/' + r.me);
      var ts = (window.firebase && firebase.database && firebase.database.ServerValue) ? firebase.database.ServerValue.TIMESTAMP : rvNow();
      pres.set({ at: ts, ed: editable }).catch(function () {});
      try { pres.onDisconnect().remove(); } catch (e) {}
      r.offs.push(function () { try { pres.onDisconnect().cancel(); } catch (e) {} pres.remove().catch(function () {}); });
    }
    if (editable) {
      // Seeded with the version just shown, so the first remote change merges instead of replacing.
      var seed = { ver: doc.ver, text: String(box.value), ct: doc.ct };
      r.live = LiveDoc({
        node: r.node, id: r.id, key: r.key, me: 'g:' + r.me, now: rvNow, adoptFirst: false,
        loadBase: function () { return seed; },
        get: function () { return r.box ? r.box.value : null; },
        apply: function (merged) {
          var ta = r.box; if (!ta) return;
          var prev = ta.value, s0 = ta.selectionStart, s1 = ta.selectionEnd, dir = ta.selectionDirection, focused = document.activeElement === ta;
          var st = ta.scrollTop;
          ta.value = merged;
          if (focused) { try { ta.setSelectionRange(C.mapPos(prev, merged, s0), C.mapPos(prev, merged, s1), dir); } catch (e) {} }
          ta.scrollTop = st;
        },
        onGone: function () { rvEnd('gone'); },
        onSync: function (s) { var c = r.el.querySelector('.burn-chip-live'); if (c) c.classList.toggle('burn-busy', s === 'pending' || s === 'saving' || s === 'retry'); }
      });
      box.addEventListener('input', function () { if (r.live) r.live.changed(); });
    }
  }

  // Ends the view: wipes the text from the page and from storage, says why.
  function rvEnd(why, keepSession) {
    var r = R;
    if (!r || r.ended) return;
    r.ended = true;
    rvTeardown(r, keepSession);
    var e = ENDED[why] || ENDED.gone;
    var main = rvMain();
    r.el.querySelector('.burn-chip-live').hidden = true;
    r.el.querySelector('.burn-chip-clock').hidden = true;
    r.el.querySelector('.burn-rv-title').textContent = 'Self-destructing note';
    r.el.classList.add('burn-ended');
    main.innerHTML = '<div class="burn-end" role="status"><div class="burn-end-ic" aria-hidden="true">' + e[0] + '</div><h2>' + esc(e[1]) + '</h2><p>' + esc(e[2]) + '</p>' +
      (r.shown ? '<p class="burn-end-wiped">The text has been removed from this page.</p>' : '') +
      '<div class="burn-end-acts">' + (why === 'offline' ? '<button type="button" class="btn btn-primary" data-act="retry">Try again</button>' : '') +
      '<button type="button" class="btn" data-act="close">Close</button></div></div>';
    rvFoot('');
  }
  function rvTeardown(r, keepSession) {
    clearTimeout(r.tick);
    if (r.live) { r.live.stop(); r.live = null; }
    r.offs.forEach(function (f) { try { f(); } catch (e) {} });
    r.offs = [];
    if (r.box) { r.shown = true; if ('value' in r.box) r.box.value = ''; r.box.textContent = ''; r.box = null; }
    var app = r.app; r.app = null; r.db = null;
    // Let the presence removal reach the server before the app goes.
    if (app) setTimeout(function () { try { app.delete().catch(function () {}); } catch (e) {} }, 1200);
    if (!keepSession) {
      setSession(null);
      if (r.id) Cade.store.remove(meKey(r.id));
    }
    r.head = null;
  }
  function rvClose(silent) {
    var r = R;
    if (!r) return;
    var finish = function () {
      if (!r.ended) { r.ended = true; rvTeardown(r, false); }
      if (r.el && r.el.parentNode) r.el.parentNode.removeChild(r.el);
      if (R === r) R = null;
    };
    if (!silent && r.live) { var l = r.live; withTimeout(l.flush(), 2000).then(finish, finish); }
    else finish();
  }
  function rvText() { return R && R.box ? ('value' in R.box && R.box.tagName === 'TEXTAREA' ? R.box.value : R.box.textContent) : ''; }
  function rvCopy() {
    var t = rvText();
    navigator.clipboard.writeText(t).then(function () { Cade.showToast('Copied', 'success', 1500); }, function () { Cade.showToast('Couldn’t copy — select the text instead', 'error', 2500); });
  }
  function rvSave() {
    var t = rvText(), name = (String((R && R.head && R.head.title) || 'note').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'note') + '.txt';
    var blob = new Blob([t], { type: 'text/plain;charset=utf-8' });
    if (Cade.files && Cade.files.save) Cade.files.save(blob, name);
    else { var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000); }
  }

  // =====================================================================================================
  // OWNER
  // =====================================================================================================
  var blob = null, entries = [], engines = {}, sweepTimer = 0, sweeping = null, booted = false, roomOff = null, visHooked = false;
  var editorHook = null;

  function now() { return Cade.cloud.serverNow ? Cade.cloud.serverNow() : Date.now(); }
  function loadBlob() {
    if (!blob) blob = Cade.syncedBlob('burn', { onChange: function (d) { entries = C.normBlob(d).shares; reconcileOwner(); renderList(); } });
    entries = C.normBlob(blob.get()).shares;
  }
  function saveBlob() { blob.set({ v: 1, shares: entries }); }
  function entryById(id) { for (var i = 0; i < entries.length; i++) if (entries[i].id === id) return entries[i]; return null; }
  function metaOf(e) { return { v: 1, created: e.created, expiresAt: e.expiresAt, oneTime: e.oneTime, editable: e.editable }; }
  function baseKey(id) { return 'cade-burn-base:' + id; }

  // Called by the core at boot when the synced list has live links, and whenever the dialog opens.
  function ownerBoot() {
    return libs().then(function (L) {
      C = L.C; M = L.M;
      if (!Cade.cloud.configured()) return;
      loadBlob();
      booted = true;
      if (!visHooked) {
        visHooked = true;
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && entries.length) sweep(); });
      }
      return sweep();
    });
  }

  // Look at every link that hasn't ended: destruct expired / opened ones, note
  // the ones that ended elsewhere, forget long-ended ones; then keep the live
  // ones running and wake up again at the next expiry.
  function sweep() {
    if (sweeping) return sweeping;
    var t = now(), changed = false;
    sweeping = Promise.all(entries.slice().map(function (e) {
      var pre = C.sweepAction(e, undefined, t);
      if (pre.act === 'purge') {
        return ownerRoot(e.db).then(function (root) { return nodeOf(root, e.id).remove(); }).then(function () {
          entries = entries.filter(function (x) { return x.id !== e.id; }); changed = true;
          Cade.idbStore.remove(baseKey(e.id));
        }).catch(function () {});
      }
      if (e.ended) return null;
      return ownerRoot(e.db).then(function (root) {
        var node = nodeOf(root, e.id);
        return readPlain(node, 12000).then(function (plain) {
          var a = C.sweepAction(e, plain, now());
          if (a.act === 'tomb') return node.set(tombOf(plain.meta || metaOf(e), a.why, now())).then(function () { e.ended = { why: a.why, at: now() }; changed = true; });
          if (a.act === 'end') { e.ended = { why: a.why, at: now() }; changed = true; }
        });
      }).catch(function () {});
    })).then(function () {
      if (changed) saveBlob();
      reconcileOwner();
      renderList();
    }).then(function () { sweeping = null; }, function () { sweeping = null; });
    return sweeping;
  }
  function scheduleSweep() {
    clearTimeout(sweepTimer); sweepTimer = 0;
    var d = C.nextSweepIn(entries, now());
    if (d >= 0) sweepTimer = setTimeout(sweep, Math.min(d, 2147483000));
  }

  // Start / stop the live engines to match the list.
  function reconcileOwner() {
    var want = {};
    entries.forEach(function (e) { if (e.editable && !e.ended && e.room && !(e.expiresAt && now() >= e.expiresAt)) want[e.id] = e; });
    Object.keys(engines).forEach(function (id) { if (!want[id]) { engines[id].stop(); delete engines[id]; } });
    Object.keys(want).forEach(function (id) { if (!engines[id]) startEngine(want[id]); });
    hookRooms(Object.keys(engines).length > 0);
    scheduleSweep();
  }
  function roomText(name) {
    var api = Cade.roomsApi;
    if (!api) return Promise.resolve(null);
    if (api.activeRoom() === name && Cade.editor) return Cade.editor.state.doc.toString();
    return api.read(name);
  }
  function startEngine(e) {
    var holder = { stop: function () { holder.stopped = true; if (holder.live) holder.live.stop(); }, live: null, entry: e };
    engines[e.id] = holder;
    ownerRoot(e.db).then(function (root) {
      if (holder.stopped) return;
      holder.live = LiveDoc({
        node: nodeOf(root, e.id), id: e.id, key: e.key, me: 'o:' + ((Cade.cloud.device && Cade.cloud.device.id) || 'x'), now: now, adoptFirst: false,
        get: function () { return roomText(holder.entry.room); },
        apply: function (merged, seen) {
          return Cade.roomsApi.write(holder.entry.room, merged, { base: seen, reason: 'burn' });
        },
        loadBase: function () { return Cade.idbStore.get(baseKey(e.id)).then(function (s) { try { return s ? (typeof s === 'string' ? JSON.parse(s) : s) : null; } catch (x) { return null; } }); },
        saveBase: function (sh) { Cade.idbStore.set(baseKey(e.id), JSON.stringify({ ver: sh.ver, text: sh.text, ct: sh.ct })); },
        onGone: function () { var x = entryById(e.id); if (x && !x.ended) { x.ended = { why: 'gone', at: now() }; saveBlob(); } reconcileOwner(); renderList(); }
      });
    }).catch(function (err) { console.warn('burn owner live:', err); delete engines[e.id]; });
  }
  // Owner edits → the live shares of that room.
  function hookRooms(on) {
    if (on && !editorHook) {
      editorHook = function (u) {
        if (!u.docChanged) return;
        var room = Cade.roomsApi && Cade.roomsApi.activeRoom();
        Object.keys(engines).forEach(function (id) { var h = engines[id]; if (h.live && h.entry.room === room) h.live.changed(); });
      };
      Cade.onEditorUpdate(editorHook);
      roomOff = Cade.roomsApi.onChange(function (name, text, info) {
        if (info.kind === 'rename') {
          var ch = false;
          entries.forEach(function (x) { if (x.room === info.from) { x.room = name; ch = true; } });
          if (ch) saveBlob();
          return;
        }
        if (info.kind !== 'text' || info.reason === 'burn' || info.source === 'editor') return;
        Object.keys(engines).forEach(function (id) { var h = engines[id]; if (h.live && h.entry.room === name && info.source === 'api') h.live.changed(); });
      });
    } else if (!on && editorHook) {
      Cade.offEditorUpdate(editorHook); editorHook = null;
      if (roomOff) { roomOff(); roomOff = null; }
    }
  }

  function revoke(e) {
    return ownerRoot(e.db).then(function (root) {
      return withTimeout(nodeOf(root, e.id).set(tombOf(metaOf(e), 'revoked', now())), 12000);
    }).then(function () {
      var x = entryById(e.id); if (x) x.ended = { why: 'revoked', at: now() };
      saveBlob(); Cade.idbStore.remove(baseKey(e.id));
      reconcileOwner(); renderList();
      Cade.showToast('Link revoked — the note was deleted from the server', 'success', 2500);
    }, function () { Cade.showToast('Couldn’t reach the server — the link is still active', 'error', 3000); });
  }
  function forget(e) {
    entries = entries.filter(function (x) { return x.id !== e.id; });
    saveBlob(); renderList();
    ownerRoot(e.db).then(function (root) { return nodeOf(root, e.id).remove(); }).catch(function () {});
    Cade.idbStore.remove(baseKey(e.id));
  }
  function linkFor(e) { return C.encodeLink(location.href.split('#')[0].split('?')[0], e); }

  function create(opts) {
    var api = Cade.roomsApi, room = (api && api.activeRoom()) || '';
    if (!room && opts.editable) return Promise.reject(new Error('Live editing works on a room — open or add one first'));
    var text = Cade.editor.state.doc.toString();
    var t = now();
    var e = {
      id: C.newId(), key: C.newKey(), db: Cade.store.get('cade-firebase-url') || '', room: room, title: room || 'Shared note', created: t,
      expiresAt: C.expiryFrom(opts.expiry, opts.custom, t), oneTime: !!opts.oneTime, editable: !!opts.editable, copy: !!opts.copy, ended: null
    };
    C.checkOptions({ expiresAt: e.expiresAt, oneTime: e.oneTime, text: text });
    if (!C.validDb(e.db)) return Promise.reject(new Error('Set up Sync first'));
    return Promise.all([C.seal(e.key, e.id, 'head', { title: e.title, copy: e.copy }), C.seal(e.key, e.id, 'v1', { t: text }), ownerRoot(e.db)]).then(function (x) {
      // Listed first, so a write that lands late is still swept / revocable.
      entries.unshift(e); saveBlob();
      var node = nodeOf(x[2], e.id);
      var doc = { ver: 1, ct: x[1], by: 'o:create', base: 0, at: t };
      return withTimeout(node.set({ meta: metaOf(e), head: x[0], doc: doc }), 15000).then(function () {
        if (e.editable) Cade.idbStore.set(baseKey(e.id), JSON.stringify({ ver: 1, text: text, ct: x[1] }));
        reconcileOwner();
        return e;
      }, function (err) {
        entries = entries.filter(function (y) { return y.id !== e.id; }); saveBlob();
        node.remove().catch(function () {});
        throw new Error(/offline/.test(err && err.message) ? 'No connection to your database — try again when you’re online' : (err && err.message) || 'Could not create the link');
      });
    });
  }

  // ---- owner dialog ---------------------------------------------------------------------------------
  var D = null;     // { el, tick, listens: { id: off } , nodes: { id: plain } }
  function toggleRow(key, label, hint, on) {
    return '<label class="burn-tog"><span class="burn-tog-t"><span class="burn-tog-l">' + esc(label) + '</span><span class="burn-tog-h" data-hint="' + key + '">' + esc(hint) + '</span></span>' +
      '<input type="checkbox" role="switch" data-k="' + key + '"' + (on ? ' checked' : '') + '><span class="burn-sw" aria-hidden="true"></span></label>';
  }
  function openOwner() {
    if (D) { D.el.querySelector('.burn-dlg').focus(); return Promise.resolve(); }
    return libs().then(function (L) {
      C = L.C; M = L.M;
      if (D) return;
      var el = document.createElement('div');
      el.className = 'burn-ov';
      var room = Cade.roomsApi && Cade.roomsApi.activeRoom();
      var configured = Cade.cloud.configured();
      var opts = C.PRESETS.map(function (p) { return '<option value="' + p.v + '"' + (p.v === '1h' ? ' selected' : '') + '>' + esc(p.label) + '</option>'; }).join('');
      el.innerHTML =
        '<div class="burn-dlg" role="dialog" aria-modal="true" aria-label="Self-destructing link" tabindex="-1">' +
          '<div class="burn-hd"><div class="burn-h"><span aria-hidden="true">🔥</span> Self-destructing link</div><button type="button" class="burn-x" data-act="close" aria-label="Close">×</button></div>' +
          '<div class="burn-body">' +
          (configured ?
            '<section class="burn-form">' +
              '<p class="burn-room">Shares ' + (room ? '<b>' + esc(room) + '</b>' : '<b>this note</b>') + ' with someone who doesn’t need Cade.txt. End-to-end encrypted: the key is only in the link.</p>' +
              '<label class="burn-field"><span class="burn-fl">Expires after</span><select class="form-input burn-exp">' + opts + '</select></label>' +
              '<div class="burn-custom" hidden><input class="form-input burn-cn" type="number" inputmode="decimal" min="1" step="1" value="2" aria-label="How long"><select class="form-input burn-cu" aria-label="Unit"><option value="min">minutes</option><option value="h" selected>hours</option><option value="d">days</option></select></div>' +
              toggleRow('oneTime', 'One-time', '', true) +
              toggleRow('editable', 'Allow editing', 'Their edits appear in your note as they type, and yours appear for them.', false) +
              toggleRow('copy', 'Allow saving a copy', 'Shows Copy and Download buttons. (Nothing can stop a screenshot.)', false) +
              '<div class="burn-err" role="alert" hidden></div>' +
              '<button type="button" class="btn btn-primary burn-create" data-act="create">Create link</button>' +
            '</section>' +
            '<section class="burn-result" hidden>' +
              '<div class="burn-ok">✓ Link ready</div>' +
              '<input class="form-input burn-link" readonly aria-label="Link" spellcheck="false">' +
              '<div class="burn-sum"></div>' +
              '<div class="burn-acts"><button type="button" class="btn btn-primary" data-act="copy">Copy link</button>' +
                (navigator.share ? '<button type="button" class="btn" data-act="share">Share…</button>' : '') +
                '<button type="button" class="btn" data-act="new">New link</button></div>' +
            '</section>' +
            '<section class="burn-list"><div class="burn-lh">Your links</div><ul class="burn-ul"></ul><p class="burn-empty">No links yet.</p></section>' +
            '<p class="burn-fine">Self-destruction is done by the apps — yours and the reader’s — not by the server: an opened or expired link’s note is deleted from your database, and anyone can still take a screenshot of what they saw.</p>'
          :
            '<section class="burn-nosync"><p><b>Self-destructing links need Sync.</b> The encrypted note is kept in your own sync database until the link destructs — the reader doesn’t need an account.</p>' +
            '<p>Set up Sync once (Settings → Sync), then come back here.</p>' +
            '<div class="burn-acts"><button type="button" class="btn btn-primary" data-act="sync">Set up Sync…</button><button type="button" class="btn" data-act="close">Not now</button></div></section>') +
          '</div>' +
        '</div>';
      document.body.appendChild(el);
      D = { el: el, tick: 0, listens: {}, nodes: {}, armed: null };
      el.addEventListener('click', onDlgClick);
      el.addEventListener('change', onDlgChange);
      el.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeOwner(); } });
      if (configured) {
        updateHints();
        loadBlob();
        if (!booted) ownerBoot(); else sweep();
        renderList();
        D.tick = setInterval(renderList, 1000);
      }
      setTimeout(function () { var d = el.querySelector('.burn-dlg'); if (d) d.focus(); }, 0);
    });
  }
  function closeOwner() {
    if (!D) return;
    clearInterval(D.tick);
    Object.keys(D.listens).forEach(function (id) { D.listens[id](); });
    if (D.el.parentNode) D.el.parentNode.removeChild(D.el);
    D = null;
  }
  function q(sel) { return D && D.el.querySelector(sel); }
  function val(k) { var i = q('input[data-k="' + k + '"]'); return !!(i && i.checked); }
  function updateHints() {
    if (!D) return;
    var ed = val('editable'), h = q('[data-hint="oneTime"]');
    if (h) h.textContent = ed ? 'Only the first browser that opens it can use it; it stays live there until the timer ends or you revoke it.'
      : 'Deleted from the server when it’s first opened.';
    var exp = q('.burn-exp');
    if (exp) q('.burn-custom').hidden = exp.value !== 'custom';
  }
  function showErr(msg) { var e = q('.burn-err'); if (e) { e.textContent = msg || ''; e.hidden = !msg; } }
  function onDlgChange() { updateHints(); showErr(''); }
  function onDlgClick(ev) {
    if (ev.target === D.el) { closeOwner(); return; }
    var b = ev.target.closest('[data-act]');
    if (!b) return;
    var a = b.getAttribute('data-act');
    if (a === 'close') closeOwner();
    else if (a === 'sync') { closeOwner(); if (window.openSyncModal) window.openSyncModal(); }
    else if (a === 'create') doCreate(b);
    else if (a === 'copy') copyText(q('.burn-link').value);
    else if (a === 'share') { var l = q('.burn-link').value; if (l && navigator.share) navigator.share({ url: l, title: 'Self-destructing note' }).catch(function () {}); }
    else if (a === 'new') { q('.burn-result').hidden = true; q('.burn-form').hidden = false; }
    else if (a === 'row-copy') { var e1 = entryById(b.getAttribute('data-id')); if (e1) copyText(linkFor(e1)); }
    else if (a === 'row-revoke') {
      var id = b.getAttribute('data-id'), e2 = entryById(id);
      if (!e2) return;
      if (D.armed !== id) { D.armed = id; b.textContent = 'Tap again to revoke'; b.classList.add('burn-armed'); setTimeout(function () { if (D && D.armed === id) { D.armed = null; renderList(); } }, 3500); return; }
      D.armed = null; b.disabled = true; b.textContent = 'Revoking…';
      revoke(e2);
    }
    else if (a === 'row-forget') { var e3 = entryById(b.getAttribute('data-id')); if (e3) forget(e3); }
  }
  function copyText(t) {
    if (!t) return;
    navigator.clipboard.writeText(t).then(function () { Cade.showToast('Link copied', 'success', 1800); },
      function () { var i = q('.burn-link'); if (i) { i.focus(); i.select(); } Cade.showToast('Press Ctrl/Cmd+C to copy', 'info', 2500); });
  }
  function doCreate(btn) {
    showErr('');
    var opts = {
      expiry: q('.burn-exp').value, custom: { n: q('.burn-cn').value, unit: q('.burn-cu').value },
      oneTime: val('oneTime'), editable: val('editable'), copy: val('copy')
    };
    btn.disabled = true; btn.textContent = 'Creating…';
    var p;
    try { p = create(opts); } catch (e) { p = Promise.reject(e); }
    p.then(function (e) {
      if (!D) return;
      q('.burn-link').value = linkFor(e);
      var parts = [e.oneTime ? (e.editable ? 'One browser only' : 'Opens once') : 'Opens any number of times',
        e.expiresAt ? 'expires in ' + C.fmtLeft(e.expiresAt - now()) : 'no time limit',
        e.editable ? 'live editing' : 'read-only'];
      if (e.copy) parts.push('saving a copy allowed');
      q('.burn-sum').textContent = parts.join(' · ');
      q('.burn-form').hidden = true; q('.burn-result').hidden = false;
      var inp = q('.burn-link'); inp.focus(); inp.select();
      renderList();
    }, function (err) { showErr((err && err.message) || 'Could not create the link'); })
      .then(function () { btn.disabled = false; btn.textContent = 'Create link'; });
  }
  // Watch the plain parts of each link that's still going while the dialog is open.
  function listen(e) {
    if (!D || D.listens[e.id]) return;
    var offs = [], gone = false;
    D.listens[e.id] = function () { gone = true; offs.forEach(function (f) { f(); }); delete D.listens[e.id]; };
    ownerRoot(e.db).then(function (root) {
      if (gone || !D) return;
      var node = nodeOf(root, e.id), plain = D.nodes[e.id] = D.nodes[e.id] || {};
      ['meta', 'tomb', 'claim', 'presence'].forEach(function (k) {
        var r = node.child(k), fn = function (s) {
          plain[k] = s.val();
          var x = entryById(e.id);
          if (x && !x.ended && (k === 'tomb' && plain.tomb)) { x.ended = { why: plain.tomb.why || 'gone', at: now() }; saveBlob(); reconcileOwner(); }
          renderList();
        };
        r.on('value', fn); offs.push(function () { r.off('value', fn); });
      });
    }).catch(function () {});
  }
  function renderList() {
    if (!D) return;
    var ul = q('.burn-ul');
    if (!ul) return;
    var t = now(), rows = [];
    entries.slice().sort(function (a, b) { return b.created - a.created; }).forEach(function (e) {
      var plain = D.nodes[e.id];
      var st = C.statusOf(e, plain && 'meta' in plain ? plain : undefined, t);
      if (!st.ended) listen(e); else if (D.listens[e.id]) D.listens[e.id]();
      var kind = [e.oneTime ? 'one-time' : '', e.editable ? 'editable' : 'read-only'].filter(Boolean).join(' · ');
      var left = !st.ended && e.expiresAt ? C.fmtLeft(st.left) + ' left' : (!st.ended ? 'no timer' : '');
      var armed = D.armed === e.id;
      rows.push('<li class="burn-li burn-st-' + st.state + (st.ended ? ' burn-ended' : '') + '"><div class="burn-li-main"><div class="burn-li-t"><b>' + esc(e.title || e.room) + '</b><span class="burn-kind">' + esc(kind) + '</span></div>' +
        '<div class="burn-li-s"><span class="burn-dot"></span><span class="burn-st">' + esc(st.label) + '</span>' + (left ? '<span class="burn-left2">' + esc(left) + '</span>' : '') + '</div></div>' +
        '<div class="burn-li-a">' + (st.ended
          ? '<button type="button" class="btn burn-sm" data-act="row-forget" data-id="' + e.id + '">Remove</button>'
          : '<button type="button" class="btn burn-sm" data-act="row-copy" data-id="' + e.id + '" aria-label="Copy link">Copy</button><button type="button" class="btn burn-sm burn-rev' + (armed ? ' burn-armed' : '') + '" data-act="row-revoke" data-id="' + e.id + '">' + (armed ? 'Tap again to revoke' : 'Revoke') + '</button>') +
        '</div></li>');
    });
    var html = rows.join('');
    if (ul.__html !== html) { ul.innerHTML = html; ul.__html = html; }
    q('.burn-empty').hidden = rows.length > 0;
  }

  // ---- registration ---------------------------------------------------------------------------------
  window.__cadeBurn = { openLink: openLink, openOwner: openOwner, ownerBoot: ownerBoot, closeOwner: closeOwner, close: function () { rvClose(true); } };
  Cade.registerWidget({ name: META.name, description: META.description, icon: META.icon, tags: META.tags, open: function () { openOwner(); } });
})();
