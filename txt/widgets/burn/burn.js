/* Self-destructing links — share a note with someone who has no Cade.txt
 * account: a link that works for one person, up to N people, or anyone until
 * a timer runs out, read only or live-editable, end-to-end encrypted. burn-core.js holds the pure
 * logic and the storage layout (see its header); this file is the UI and the
 * Firebase wiring for both sides:
 *
 *  - OWNER (Share → "Self-destructing link…", or Ctrl+K "Self-destructing
 *    links"): a dialog to create a link — expiry, who can open it, editing
 *    up top; under "More options" the name and icon the reader sees, the
 *    countdown, saving a copy and the tidy-up tools (an allow-list of the
 *    app's own text scripts, run on the reader's text) — and the list of
 *    links with their status, time left and Revoke.
 *    The list lives in Cade.syncedBlob('burn') — encrypted with the sync key,
 *    so every device of the owner can show and revoke the links, and keep
 *    editable ones live. The core loads this module at boot only while that
 *    blob lists links that haven't ended (ownerBoot): it sweeps them (expired
 *    / opened ones are destructed) and runs the live merge for editable ones.
 *  - RECIPIENT (the core sees #burn= on load and calls openLink): a full-page,
 *    opaque screen over the app with its own named Firebase app, so their own
 *    sync, rooms and Firebase connection are never touched and nothing is
 *    imported into their rooms. It has no way out to the app. When the link
 *    ends, the text is wiped from the page and from storage.
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
    return Promise.all(['meta', 'tomb', 'claim', 'claims'].map(function (k) { return once(node.child(k), ms); }))
      .then(function (v) { return { meta: v[0], tomb: v[1], claim: v[2], claims: v[3] }; });
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

  // Why a link can't be shown (or stopped being shown): [icon, heading, text].
  function endCopy(why, meta) {
    var cap = C ? C.capOf(meta) : 0;
    var E = {
      opened: cap > 1
        ? ['📭', 'This link has been used up', 'Up to ' + cap + ' people could open it, and they all have. Its note was deleted from the server.']
        : ['📭', 'This link has already been opened', 'It could be opened only once. Its note was deleted from the server when it was first opened.'],
      claimed: cap > 1
        ? ['🔒', 'This link is full', 'Up to ' + cap + ' people could open it, and they already have — it works only in their browsers.']
        : ['🔒', 'This link is open in another browser', 'Only the first browser that opened it can use it.'],
      expired: ['⌛', 'This link has expired', 'Its time ran out. The note was deleted and can no longer be read.'],
      revoked: ['🚫', 'The owner ended this link', 'The note was deleted from the server.'],
      gone: ['📭', 'This link is no longer available', 'It was opened, expired, or ended by its owner.'],
      bad: ['🔗', 'This link is incomplete', 'Part of it is missing. Ask for the whole link — including everything after the #.'],
      key: ['🔑', 'This link can’t be read', 'Its key doesn’t match the note — the link may have been changed or cut short.'],
      offline: ['📡', 'Can’t reach the server', 'Check your connection and try again. The link hasn’t been used up.']
    };
    return E[why] || E.gone;
  }

  function rvShell() {
    var el = document.createElement('div');
    el.className = 'burn-rv';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Shared note');
    // No way back to the app from here: the reader came for this note only.
    el.innerHTML =
      '<header class="burn-rv-top">' +
        '<div class="burn-rv-brand"><span class="burn-rv-ic" aria-hidden="true" hidden></span><span class="burn-rv-title">Shared note</span></div>' +
        '<div class="burn-rv-chips">' +
          '<span class="burn-chip burn-chip-live" hidden><i></i><span>Live — your edits are shared</span></span>' +
          '<span class="burn-chip burn-chip-clock" hidden title="Time left"><span class="burn-clock-ic" aria-hidden="true">⏱</span><b>–</b></span>' +
        '</div>' +
        '<div class="burn-tidy-w" hidden><button type="button" class="btn burn-tidy" data-act="tidy" aria-haspopup="menu" aria-expanded="false">Tidy up <span aria-hidden="true">▾</span></button></div>' +
      '</header>' +
      '<main class="burn-rv-main"><div class="burn-rv-wait"><span class="burn-spin" aria-hidden="true"></span><span>Opening…</span></div></main>' +
      '<footer class="burn-rv-foot" hidden></footer>';
    // The app's own shortcuts mustn't act on keys typed here.
    el.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (!R || !R.menu || R.menu.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); tidyMenu(false); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var items = Array.prototype.slice.call(R.menu.querySelectorAll('.burn-mi')), i = items.indexOf(document.activeElement);
        var next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1) + (i < 0 && e.key === 'ArrowUp' ? 1 : 0)) % items.length];
        if (next) { e.preventDefault(); next.focus(); }
      }
    });
    // Remember the reader's selection before a tap on "Tidy up" can blur it.
    el.addEventListener('pointerdown', function (e) {
      if (R && R.box && e.target.closest('.burn-tidy, .burn-menu')) R.sel = { from: R.box.selectionStart, to: R.box.selectionEnd, len: R.box.value.length };
    }, true);
    el.addEventListener('mousedown', function (e) { if (e.target.closest('.burn-tidy, .burn-menu')) e.preventDefault(); });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (R && R.menu && !R.menu.hidden && !e.target.closest('.burn-menu') && !(b && b.getAttribute('data-act') === 'tidy')) tidyMenu(false);
      if (!b) return;
      var a = b.getAttribute('data-act');
      if (a === 'retry') { var p = R && R.payload; rvClose(true); openLink(p); }
      else if (a === 'copy') rvCopy();
      else if (a === 'save') rvSave();
      else if (a === 'tidy') tidyMenu(R && R.menu ? R.menu.hidden : true);
      else if (a === 'tidy-run') rvTidy(b.getAttribute('data-id'));
      else if (a === 'tidy-undo') rvUndo();
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
  function rvBrand(title, icon) {
    var r = R; if (!r) return;
    r.el.querySelector('.burn-rv-title').textContent = title;
    var ic = r.el.querySelector('.burn-rv-ic');
    ic.textContent = icon || ''; ic.hidden = !icon;
    r.el.setAttribute('aria-label', title);
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
      var meta = r.meta = plain.meta;
      var g = C.gate(plain, rvNow(), r.me);
      if (!g.ok) {
        if (g.why === 'expired' && !plain.tomb) node.set(tombOf(meta, 'expired', rvNow())).catch(function () {});
        return rvEnd(g.why);
      }
      var cap = C.capOf(meta), v1 = C.isV1Claim(meta), claim;
      // One slot per browser, taken by a transaction: of N simultaneous
      // openers of the last slot, exactly one wins.
      if (!g.needClaim) claim = Promise.resolve({ mine: true, claims: plain.claims });
      else if (v1) {
        claim = txn(node.child('claim'), function (cur) { return C.claimUpdate(cur, r.me, rvNow()); })
          .then(function (res) { return { mine: C.claimIsMine(res && res.snapshot && res.snapshot.val(), r.me), claims: null }; });
      } else {
        claim = txn(node.child('claims'), function (cur) { return C.claimsUpdate(cur, r.me, rvNow(), cap); })
          .then(function (res) { var v = res && res.snapshot && res.snapshot.val(); return { mine: C.holdsSlot(v, r.me), claims: v }; });
      }
      return withTimeout(claim, 15000).then(function (c) {
        if (r !== R) return;
        if (!c.mine) return rvEnd(meta.editable ? 'claimed' : 'opened');
        // This browser may come back (a reload, or later) without using up another slot.
        if (cap && (!v1 || meta.editable)) Cade.store.set(meKey(r.id), r.me);
        var burn = C.burnsAfterRead(meta, c.claims);
        return Promise.all([once(node.child('head')), once(node.child('doc'))]).then(function (v) {
          if (r !== R) return;
          var head = v[0], doc = v[1];
          if (!doc || !head) return rvEnd('gone');
          return Promise.all([C.open(r.key, r.id, 'head', head), C.open(r.key, r.id, 'v' + doc.ver, doc.ct)]).then(function (x) {
            if (r !== R) return;
            r.head = C.readHead(x[0]);
            var text = String(x[1] && x[1].t != null ? x[1].t : '');
            if (burn) {
              // The last one who may read it: delete the ciphertext now (meta +
              // tombstone stay, so a later open can say why).
              node.set(tombOf(meta, 'opened', rvNow())).catch(function () {});
              setSession(null);
              Cade.store.remove(meKey(r.id));
            }
            r.burned = burn;
            rvShow(r, text, doc);
          }, function () { return rvEnd('key'); });
        });
      });
    });
  }

  function rvShow(r, text, doc) {
    var meta = r.meta, head = r.head, editable = !!meta.editable, copy = head.copy, cap = C.capOf(meta);
    rvBrand(head.title || 'Shared note', head.icon);
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
    if (r.burned) bits.push(cap > 1 ? '<b>You were the last who could open it:</b> the note was deleted from the server just now. Close this page and it’s gone.'
      : '<b>One-time link:</b> the note was deleted from the server when you opened it. Close this page and it’s gone.');
    else if (cap === 1) bits.push('<b>Just for you:</b> it works only in this browser now.');
    else if (cap > 1) bits.push('<b>Up to ' + cap + ' people</b> can open it; it keeps working in this browser.');
    if (editable) bits.push('You and the owner are editing the same note — changes appear on both sides as you type.');
    if (meta.expiresAt) bits.push(head.timer ? 'It self-destructs in <b class="burn-left">' + esc(C.fmtLeft(C.msLeft(meta, rvNow()))) + '</b>.' : 'It self-destructs when its time is up.');
    if (!copy && !editable) bits.push('The owner turned off saving a copy.');
    var acts = copy ? '<div class="burn-rv-acts"><button type="button" class="btn" data-act="copy">Copy text</button><button type="button" class="btn" data-act="save">Download .txt</button></div>' : '';
    rvFoot('<p>' + bits.join(' ') + '</p>' + acts);
    // Tidy-up tools the owner chose (live links only).
    if (editable && head.scripts.length) tidySetup(r, head.scripts);
    // Countdown — the timer runs (and ends the link) whether or not it's shown.
    if (meta.expiresAt) {
      var chip = r.el.querySelector('.burn-chip-clock');
      chip.hidden = !head.timer;
      var tick = function () {
        if (r !== R || r.ended) return;
        var left = C.msLeft(meta, rvNow());
        if (head.timer) {
          var b = chip.querySelector('b'); if (b) b.textContent = C.fmtClock(left);
          var f = r.el.querySelector('.burn-left'); if (f) f.textContent = C.fmtLeft(left);
          chip.classList.toggle('burn-soon', left < 60000);
        }
        if (left <= 0) {
          r.node.set(tombOf(meta, 'expired', rvNow())).catch(function () {});
          return rvEnd('expired');
        }
        r.tick = setTimeout(tick, left > 3600000 ? 30000 : !head.timer ? Math.min(left + 5, 30000) : 1000 - (rvNow() % 1000) + 5);
      };
      tick();
    }
    // The owner ending it (or a timer elsewhere) ends it here too. An
    // 'opened' tombstone doesn't: whoever is already reading a read-only
    // capped link keeps what they opened.
    var tombRef = r.node.child('tomb'), metaRef = r.node.child('meta');
    var onTomb = function (s) { var t = s.val(); if (t && !(t.why === 'opened' && cap && !editable)) rvEnd(t.why || 'gone'); };
    var onMeta = function (s) { if (s.val() === null) rvEnd('gone'); };
    tombRef.on('value', onTomb); metaRef.on('value', onMeta);
    r.offs.push(function () { tombRef.off('value', onTomb); metaRef.off('value', onMeta); });
    // Presence (the owner's list shows "N viewers"); not once the note is burned.
    if (!r.burned) {
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

  // ---- tidy-up menu (the owner's chosen scripts, for a live link) ---------------------------------------
  var packCache = {};
  // A script pack's code, fetched and parsed without registering anything in the app.
  function loadPack(name) {
    if (!packCache[name]) {
      packCache[name] = fetch(new URL(BASE + '../../scripts/' + name + '/' + name + '.js', location.href).href)
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
        .then(function (src) { return C.parsePack(src); })
        .catch(function (e) { delete packCache[name]; console.warn('burn tidy:', e); throw new Error('Couldn’t load this tool — check your connection'); });
    }
    return packCache[name];
  }
  function tidySetup(r, ids) {
    var groups = [], by = {};
    ids.forEach(function (id) {
      var s = C.scriptById(id); if (!s) return;
      if (!by[s.group]) { by[s.group] = []; groups.push(s.group); }
      by[s.group].push(s);
    });
    var html = '<div class="burn-menu" role="menu" aria-label="Tidy up" hidden>' +
      '<div class="burn-menu-h">Works on the text you’ve selected — or on the whole note if nothing is selected.</div>' +
      groups.map(function (g) {
        return (groups.length > 1 ? '<div class="burn-menu-g">' + esc(g) + '</div>' : '') + by[g].map(function (s) {
          return '<button type="button" role="menuitem" class="burn-mi" data-act="tidy-run" data-id="' + s.id + '"><span class="burn-mi-l">' + esc(s.label) + '</span><span class="burn-mi-h">' + esc(s.hint) + '</span></button>';
        }).join('');
      }).join('') + '</div>';
    var w = r.el.querySelector('.burn-tidy-w');
    w.insertAdjacentHTML('beforeend', html);
    w.hidden = false;
    r.menu = w.querySelector('.burn-menu');
    r.tidyIds = ids;
  }
  function tidyMenu(open) {
    var r = R;
    if (!r || !r.menu) return;
    if (open && (r.ended || !r.box)) open = false;
    var b = r.el.querySelector('.burn-tidy');
    if (!open && r.menu.contains(document.activeElement) && b) b.focus({ preventScroll: true });
    r.menu.hidden = !open;
    if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      // Fetch the packs now, so a pick runs at once.
      C.packsFor(r.tidyIds).forEach(function (p) { loadPack(p).catch(function () {}); });
      var first = r.menu.querySelector('.burn-mi'); if (first && !('ontouchstart' in window)) first.focus({ preventScroll: true });
    }
  }
  // The selection to work on: the live one, or the one remembered before a tap moved focus.
  function rvSelection(r) {
    var ta = r.box, s = r.sel;
    r.sel = null;
    if (s && s.len === ta.value.length && document.activeElement !== ta) return s;
    return { from: ta.selectionStart, to: ta.selectionEnd };
  }
  function rvTidy(id) {
    var r = R, s = C && C.scriptById(id);
    if (!r || !r.box || r.ended || !s || r.tidyIds.indexOf(id) < 0) return;
    var sel = rvSelection(r);
    tidyMenu(false);
    loadPack(s.pack).then(function (codes) {
      if (r !== R || !r.box) return;
      var code = codes[s.script];
      if (!code) throw new Error('This tool isn’t available any more');
      var ta = r.box, before = ta.value, res;
      try { res = C.runScript(code, before, sel.from, sel.to); }
      catch (e) { throw new Error(/JSON/.test(String(e && e.message)) ? 'That isn’t valid JSON — nothing was changed' : 'Couldn’t ' + s.label.toLowerCase() + ' here — nothing was changed'); }
      if (res.insert == null) { Cade.showToast((res.messages[0] && res.messages[0].text) || 'Nothing to change', 'info', 2200); return; }
      ta.setRangeText(res.insert, res.from, res.to, sel.from < sel.to ? 'select' : 'preserve');
      if (!('ontouchstart' in window)) ta.focus({ preventScroll: true });     // (a phone keeps its keyboard down)
      r.undo = { before: before, after: ta.value };
      if (r.live) r.live.changed();
      rvDone(s.label);
    }).catch(function (e) { Cade.showToast((e && e.message) || 'Couldn’t run that', 'error', 3000); });
  }
  // "✓ Done · Undo" for a few seconds after a tidy-up.
  function rvDone(label) {
    var r = R; if (!r) return;
    var n = r.el.querySelector('.burn-done');
    if (!n) { n = document.createElement('div'); n.className = 'burn-done'; n.setAttribute('role', 'status'); rvMain().appendChild(n); }
    n.innerHTML = '<span>✓ ' + esc(label) + '</span><button type="button" class="btn burn-sm" data-act="tidy-undo">Undo</button>';
    n.hidden = false;
    clearTimeout(r.doneT);
    r.doneT = setTimeout(function () { if (n) n.hidden = true; }, 8000);
  }
  function rvUndo() {
    var r = R; if (!r || !r.box || !r.undo) return;
    var ta = r.box, u = r.undo;
    r.undo = null;
    var n = r.el.querySelector('.burn-done'); if (n) n.hidden = true;
    if (ta.value !== u.after) { Cade.showToast('The note changed since — undo with your keyboard instead', 'info', 3000); return; }
    var d = C.minimalEdit(u.after, u.before);
    ta.setRangeText(d.insert, d.from, d.to, 'select');
    if (r.live) r.live.changed();
  }

  // Ends the view: wipes the text from the page and from storage, says why.
  // Fully opaque, and no way out to the app — just the reason.
  function rvEnd(why, keepSession) {
    var r = R;
    if (!r || r.ended) return;
    r.ended = true;
    rvTeardown(r, keepSession);
    var e = endCopy(why, r.meta);
    var main = rvMain();
    r.el.querySelector('.burn-chip-live').hidden = true;
    r.el.querySelector('.burn-chip-clock').hidden = true;
    var tw = r.el.querySelector('.burn-tidy-w'), menu = tw.querySelector('.burn-menu');
    tw.hidden = true; if (menu) menu.parentNode.removeChild(menu);
    r.menu = null;
    rvBrand('Shared note', '');
    r.el.classList.add('burn-rv-over');
    main.innerHTML = '<div class="burn-end" role="status"><div class="burn-end-ic" aria-hidden="true">' + e[0] + '</div><h2>' + esc(e[1]) + '</h2><p>' + esc(e[2]) + '</p>' +
      (r.shown ? '<p class="burn-end-wiped">The text has been removed from this page.</p>' : '') +
      (why === 'offline' ? '<div class="burn-end-acts"><button type="button" class="btn btn-primary" data-act="retry">Try again</button></div>' : '') + '</div>';
    rvFoot('');
  }
  function rvTeardown(r, keepSession) {
    clearTimeout(r.tick); clearTimeout(r.doneT);
    if (r.live) { r.live.stop(); r.live = null; }
    r.offs.forEach(function (f) { try { f(); } catch (e) {} });
    r.offs = [];
    if (r.box) { r.shown = true; if ('value' in r.box) r.box.value = ''; r.box.textContent = ''; r.box = null; }
    r.undo = null; r.sel = null;
    var app = r.app; r.app = null; r.db = null;
    // Let the presence removal reach the server before the app goes.
    if (app) setTimeout(function () { try { app.delete().catch(function () {}); } catch (e) {} }, 1200);
    if (!keepSession) {
      setSession(null);
      if (r.id) Cade.store.remove(meKey(r.id));
    }
    r.head = null;
  }
  // Not offered to the reader; used to reopen (retry / another link) and by tests.
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

  // ---- the owner's clock --------------------------------------------------------------------------------
  // Links are timed in server time. The core's Cade.cloud.serverNow() is this
  // device's clock plus the sync connection's .info/serverTimeOffset — hooked
  // only on the first Cade.cloud.ref() call and taken from that connection's
  // handshake, so it can be missing (0) or stale (a tab iOS froze mid-connect).
  // The owner therefore measures the offset itself from a server-stamped write
  // (each link's meta.created, or a probe when the dialog opens) and keeps it.
  var CLOCK_KEY = 'cade-burn-clock', CLOCK_FRESH = 12 * 3600000;
  var clockOff = null;
  function measuredOffset() {
    if (clockOff != null) return clockOff;
    try {
      var c = JSON.parse(Cade.store.get(CLOCK_KEY) || 'null');
      if (c && typeof c.off === 'number' && Math.abs(Date.now() - c.at) < CLOCK_FRESH) return (clockOff = c.off);
    } catch (e) {}
    return null;
  }
  function setClock(off) {
    if (off == null || !isFinite(off)) return;
    clockOff = off;
    Cade.store.set(CLOCK_KEY, JSON.stringify({ off: off, at: Date.now() }));
  }
  function now() {
    var off = measuredOffset();
    if (off != null) return Date.now() + off;
    return Cade.cloud.serverNow ? Cade.cloud.serverNow() : Date.now();
  }
  // A value straight from the server (not the local cache's estimate).
  function serverVal(ref, ms) {
    var p = typeof ref.get === 'function' ? ref.get().then(function (s) { return s.val(); }) : ref.once('value').then(function (s) { return s.val(); });
    return withTimeout(p, ms || 8000);
  }
  var probing = null;
  function measureClock() {
    if (probing || measuredOffset() != null || !Cade.cloud.configured()) return probing;
    probing = Cade.cloud.ref('burn', 'clock').then(function (ref) {
      if (!ref) return;
      var l0 = Date.now();
      return withTimeout(ref.set({ at: Cade.cloud.TIMESTAMP }), 8000).then(function () { return serverVal(ref.child('at')); }).then(function (at) {
        setClock(C.clockOffset(at, l0, Date.now()));
        return ref.remove();
      });
    }).catch(function () {}).then(function () { probing = null; renderList(); });
    return probing;
  }

  function loadBlob() {
    if (!blob) blob = Cade.syncedBlob('burn', { onChange: function (d) { entries = C.normBlob(d).shares; reconcileOwner(); renderList(); } });
    entries = C.normBlob(blob.get()).shares;
  }
  function saveBlob() { blob.set({ v: 1, shares: entries }); }
  function entryById(id) { for (var i = 0; i < entries.length; i++) if (entries[i].id === id) return entries[i]; return null; }
  // The plain meta of a link (v1 links keep their v1 shape).
  function metaOf(e) {
    var cap = C.capOfEntry(e);
    var m = { v: e.v === 2 ? 2 : 1, created: e.created, expiresAt: e.expiresAt, oneTime: cap === 1, editable: e.editable };
    if (e.v === 2) m.maxOpens = cap;
    return m;
  }
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

  // opts: { expiry, custom, who, n, editable, copy, title, icon, timer, scripts }
  function create(opts) {
    var api = Cade.roomsApi, room = (api && api.activeRoom()) || '';
    if (!room && opts.editable) return Promise.reject(new Error('Live editing works on a room — open or add one first'));
    var text = Cade.editor.state.doc.toString();
    var db = Cade.store.get('cade-firebase-url') || '';
    var maxOpens = C.capFrom(opts.who, opts.n);
    var ttl = C.expiryFrom(opts.expiry, opts.custom, 0);     // a duration: anchored on the server's clock below
    C.checkOptions({ expiresAt: ttl, maxOpens: maxOpens, text: text });
    if (!C.validDb(db)) return Promise.reject(new Error('Set up Sync first'));
    var head = C.makeHead({ title: opts.title || room || 'Shared note', copy: opts.copy, icon: opts.icon, timer: opts.timer, editable: opts.editable, scripts: opts.scripts });
    // The root first: for the sync database that also hooks the core's server-clock offset.
    return ownerRoot(db).then(function (root) {
      var t = now();
      var e = {
        v: 2, id: C.newId(), key: C.newKey(), db: db, room: room, title: head.title, created: t, ttl: ttl, expiresAt: ttl ? t + ttl : 0,
        maxOpens: maxOpens, oneTime: maxOpens === 1, editable: !!opts.editable, copy: head.copy, ended: null
      };
      return Promise.all([C.seal(e.key, e.id, 'head', head), C.seal(e.key, e.id, 'v1', { t: text })]).then(function (x) {
        // Listed first, so a write that lands late is still swept / revocable.
        entries.unshift(e); saveBlob();
        var node = nodeOf(root, e.id);
        var meta = metaOf(e); meta.created = Cade.cloud.TIMESTAMP;
        var doc = { ver: 1, ct: x[1], by: 'o:create', base: 0, at: t };
        var l0 = Date.now();
        return withTimeout(node.set({ meta: meta, head: x[0], doc: doc }), 15000).then(function () {
          if (e.editable) Cade.idbStore.set(baseKey(e.id), JSON.stringify({ ver: 1, text: text, ct: x[1] }));
          // Anchor the timer on the moment the server stamped the link, and
          // learn this device's clock offset from it.
          return serverVal(node.child('meta/created')).then(function (sc) {
            var off = C.clockOffset(sc, l0, Date.now());
            if (off == null) return;
            setClock(off);
            e.created = sc;
            if (e.ttl && e.expiresAt !== sc + e.ttl) { e.expiresAt = sc + e.ttl; return withTimeout(node.child('meta/expiresAt').set(e.expiresAt), 8000); }
          }).catch(function () {}).then(function () {
            saveBlob();
            reconcileOwner();
            return e;
          });
        }, function (err) {
          entries = entries.filter(function (y) { return y.id !== e.id; }); saveBlob();
          node.remove().catch(function () {});
          throw new Error(/offline/.test(err && err.message) ? 'No connection to your database — try again when you’re online' : (err && err.message) || 'Could not create the link');
        });
      });
    });
  }

  // ---- owner dialog ---------------------------------------------------------------------------------
  var D = null;     // { el, tick, listens: { id: off }, nodes: { id: plain }, armed, icon }
  var ICONS = ['🔥', '🔒', '📝', '✉️', '🤫', '⭐', '🎁', '👋'];
  function toggleRow(key, label, hint, on) {
    return '<label class="burn-tog" data-row="' + key + '"><span class="burn-tog-t"><span class="burn-tog-l">' + esc(label) + '</span><span class="burn-tog-h" data-hint="' + key + '">' + esc(hint) + '</span></span>' +
      '<input type="checkbox" role="switch" data-k="' + key + '"' + (on ? ' checked' : '') + '><span class="burn-sw" aria-hidden="true"></span></label>';
  }
  function toolsHtml() {
    var last = '';
    return C.SCRIPTS.map(function (s) {
      var g = s.group !== last ? '<div class="burn-tools-g">' + esc(s.group) + '</div>' : '';
      last = s.group;
      return g + '<label class="burn-chk"><input type="checkbox" data-script="' + s.id + '"><span class="burn-chk-t"><span class="burn-chk-l">' + esc(s.label) + '</span><span class="burn-chk-h">' + esc(s.hint) + '</span></span></label>';
    }).join('');
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
          '<div class="burn-hd"><div class="burn-h">Self-destructing link</div><button type="button" class="burn-x" data-act="close" aria-label="Close">×</button></div>' +
          '<div class="burn-body">' +
          (configured ?
            '<section class="burn-form">' +
              '<p class="burn-room">Shares ' + (room ? '<b>' + esc(room) + '</b>' : '<b>this note</b>') + ' with someone who doesn’t need Cade.txt. End-to-end encrypted: the key is only in the link.</p>' +
              '<label class="burn-field"><span class="burn-fl">Expires after</span><select class="form-input burn-exp">' + opts + '</select></label>' +
              '<div class="burn-custom burn-cust" hidden><input class="form-input burn-cn" type="number" inputmode="decimal" min="1" step="1" value="2" aria-label="How long"><select class="form-input burn-cu" aria-label="Unit"><option value="min">minutes</option><option value="h" selected>hours</option><option value="d">days</option></select></div>' +
              '<div class="burn-fieldset">' +
                '<label class="burn-field"><span class="burn-fl">Who can open it</span><select class="form-input burn-who"><option value="one" selected>Just one person</option><option value="some">Up to … people</option><option value="any">Anyone with the link</option></select></label>' +
                '<div class="burn-custom burn-some" hidden><input class="form-input burn-max" type="number" inputmode="numeric" min="1" max="' + C.MAX_VIEWERS + '" step="1" value="3" aria-label="How many people"><span class="burn-unit">people</span></div>' +
                '<p class="burn-hint" data-hint="who"></p>' +
              '</div>' +
              toggleRow('editable', 'Allow editing', 'Their edits appear in your note as they type, and yours appear for them.', false) +
              '<details class="burn-more"><summary><span>More options</span><span class="burn-more-s"></span></summary><div class="burn-more-b">' +
                '<label class="burn-stack"><span class="burn-fl">Name they see</span><input class="form-input burn-name" type="text" maxlength="' + C.MAX_NAME + '" autocomplete="off" placeholder="' + esc(room || 'Shared note') + '"><span class="burn-hint">The title at the top of their page. Encrypted like the note.</span></label>' +
                '<div class="burn-stack"><span class="burn-fl" id="burn-icon-l">Icon</span><div class="burn-icons" role="group" aria-labelledby="burn-icon-l">' +
                  '<button type="button" class="burn-ico burn-ico-none" data-act="icon" data-icon="" aria-pressed="true">None</button>' +
                  ICONS.map(function (i) { return '<button type="button" class="burn-ico" data-act="icon" data-icon="' + i + '" aria-pressed="false" aria-label="' + i + '">' + i + '</button>'; }).join('') +
                  '<input class="form-input burn-ico-own" type="text" maxlength="16" autocomplete="off" placeholder="Other" aria-label="Your own icon (one emoji or symbol)">' +
                '</div><span class="burn-hint">Shown next to the name. One emoji or a short symbol of your own.</span></div>' +
                toggleRow('timer', 'Show the countdown', 'They see how long is left. The link expires on time either way.', true) +
                toggleRow('copy', 'Allow saving a copy', 'Shows Copy and Download buttons. (Nothing can stop a screenshot.)', false) +
                '<details class="burn-tools"><summary><span class="burn-fl">Tidy-up tools for them</span><span class="burn-tools-n">none</span></summary>' +
                  '<p class="burn-hint burn-tools-off">Turn on <b>Allow editing</b> to give them tools.</p>' +
                  '<div class="burn-tools-on"><p class="burn-hint">They get one “Tidy up” menu above the text with the tools you pick. Each works on what they select, or on the whole note.</p>' + toolsHtml() + '</div>' +
                '</details>' +
              '</div></details>' +
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
      D = { el: el, tick: 0, listens: {}, nodes: {}, armed: null, icon: '' };
      el.addEventListener('click', onDlgClick);
      el.addEventListener('change', onDlgChange);
      el.addEventListener('input', onDlgInput);
      el.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeOwner(); } });
      if (configured) {
        updateHints();
        loadBlob();
        if (!booted) ownerBoot(); else sweep();
        if (entries.some(function (e) { return !e.ended && e.expiresAt; })) measureClock();
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
  function chosenScripts() { return D ? Array.prototype.map.call(D.el.querySelectorAll('input[data-script]:checked'), function (i) { return i.getAttribute('data-script'); }) : []; }
  function updateHints() {
    if (!D || !q('.burn-form')) return;
    var ed = val('editable'), who = q('.burn-who').value, exp = q('.burn-exp').value;
    var n = Math.floor(Number(q('.burn-max').value)) || 0;
    q('.burn-cust').hidden = exp !== 'custom';
    q('.burn-some').hidden = who !== 'some';
    var them = who === 'some' ? (n > 0 ? 'the first ' + n + ' browsers' : 'the first few browsers') : '';
    var h = who === 'one'
      ? (ed ? 'Only the first browser that opens it can use it. It stays live there until the timer ends or you revoke it.' : 'Deleted from the server as soon as it’s opened.')
      : who === 'some'
        ? (ed ? 'Only ' + them + ' that open it can use it; each can come back to it.' : 'Only ' + them + ' that open it can read it — it’s deleted from the server once the last of them has.')
        : (exp === 'none' ? 'Anyone with the link — pick a time limit too, so it self-destructs.' : 'Anyone who has the link can open it until it expires.');
    q('[data-hint="who"]').textContent = h;
    var timer = q('[data-row="timer"]');
    timer.hidden = exp === 'none';
    q('.burn-tools-off').hidden = ed; q('.burn-tools-on').hidden = !ed;
    var picked = chosenScripts().length;
    q('.burn-tools-n').textContent = !ed ? 'needs editing' : picked ? picked + ' chosen' : 'none';
    // A one-line summary on the closed "More options".
    var bits = [];
    if (q('.burn-name').value.trim()) bits.push('name');
    if (D.icon) bits.push(D.icon);
    if (exp !== 'none' && !val('timer')) bits.push('no countdown');
    if (val('copy')) bits.push('copying on');
    if (ed && picked) bits.push(picked + ' tool' + (picked > 1 ? 's' : ''));
    q('.burn-more-s').textContent = bits.length ? bits.join(' · ') : '';
  }
  function setIcon(icon, fromOwn) {
    D.icon = C.cleanIcon(icon);
    Array.prototype.forEach.call(D.el.querySelectorAll('.burn-ico'), function (b) {
      b.setAttribute('aria-pressed', !fromOwn && b.getAttribute('data-icon') === D.icon ? 'true' : 'false');
    });
    if (!fromOwn) q('.burn-ico-own').value = '';
    q('.burn-ico-own').classList.toggle('burn-ico-on', !!(fromOwn && D.icon));
    updateHints();
  }
  function showErr(msg) { var e = q('.burn-err'); if (e) { e.textContent = msg || ''; e.hidden = !msg; } }
  function onDlgChange() { updateHints(); showErr(''); }
  function onDlgInput(ev) {
    if (ev.target.classList.contains('burn-ico-own')) {
      var v = ev.target.value;
      if (v.trim()) setIcon(v, true); else setIcon('', false);
      return;
    }
    if (ev.target.classList.contains('burn-max') || ev.target.classList.contains('burn-name')) updateHints();
  }
  function onDlgClick(ev) {
    if (ev.target === D.el) { closeOwner(); return; }
    var b = ev.target.closest('[data-act]');
    if (!b) return;
    var a = b.getAttribute('data-act');
    if (a === 'close') closeOwner();
    else if (a === 'sync') { closeOwner(); if (window.openSyncModal) window.openSyncModal(); }
    else if (a === 'icon') setIcon(b.getAttribute('data-icon'), false);
    else if (a === 'create') doCreate(b);
    else if (a === 'copy') copyText(q('.burn-link').value);
    else if (a === 'share') { var l = q('.burn-link').value; if (l && navigator.share) navigator.share({ url: l, title: 'Shared note' }).catch(function () {}); }
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
    var ed = val('editable');
    var opts = {
      expiry: q('.burn-exp').value, custom: { n: q('.burn-cn').value, unit: q('.burn-cu').value },
      who: q('.burn-who').value, n: q('.burn-max').value, editable: ed, copy: val('copy'),
      title: q('.burn-name').value, icon: D.icon, timer: val('timer'), scripts: ed ? chosenScripts() : []
    };
    btn.disabled = true; btn.textContent = 'Creating…';
    var p;
    try { p = create(opts); } catch (e) { p = Promise.reject(e); }
    p.then(function (e) {
      if (!D) return;
      q('.burn-link').value = linkFor(e);
      var cap = C.capOfEntry(e), tools = opts.scripts.length;
      var parts = [C.capLabel(cap),
        e.expiresAt ? 'expires in ' + C.fmtLeft(C.leftOf(e, now())) + (opts.timer ? '' : ' (countdown hidden)') : 'no time limit',
        e.editable ? 'live editing' : 'read-only'];
      if (e.copy) parts.push('saving a copy allowed');
      if (tools) parts.push(tools + ' tidy-up tool' + (tools > 1 ? 's' : ''));
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
      ['meta', 'tomb', 'claim', 'claims', 'presence'].forEach(function (k) {
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
      var cap = st.cap;
      var kind = [cap === 1 ? 'one person' : cap > 1 ? 'up to ' + cap : 'anyone', e.editable ? 'editable' : 'read-only'].join(' · ');
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
