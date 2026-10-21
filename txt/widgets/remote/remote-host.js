/* Remote — host: what a receiver does when a controller connects (loaded on the
 * first hello by remote-recv.js).
 *
 * Sessions: one per controller (keyed by its instance id). Input arrives as
 * state packets (see remote-link.js) over the WebRTC data channel once it is
 * open, through the cloud relay until then; whichever is newer wins.
 *
 * Targets: on every packet the host looks at what is on screen — a game panel,
 * the Teleprompter or Big Text overlays, else the editor — and maps the
 * controller's buttons through that target's profile:
 *   - games and overlays get synthetic keyboard events (the same keys a
 *     keyboard would send; every game reads keys on the document) dispatched
 *     on the game's own panel, with auto-repeat where a held key should repeat;
 *   - the editor gets presenter actions: page / scroll / auto-scroll.
 * The controller is told what it is driving (name, which buttons matter, their
 * labels) so its screen can relabel itself. A held button with no heartbeat
 * for RELEASE_AFTER ms is released; a controller silent for GONE_AFTER ms is
 * dropped. A small chip shows who is connected and how (direct / via cloud). */
(function (root) {
  'use strict';

  // ---- profiles (pure) ------------------------------------------------------------------------
  var D = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  function ext(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }
  // keys: button → key ('' = unused); labels shown on the controller; rep: button → [delay ms, interval ms]
  // for keys that should auto-repeat while held; tilt: [button for tilt-left, button for tilt-right].
  var PROFILES = [
    { id: 'tetris-panel', name: 'Tetris', keys: ext(D, { a: 'ArrowUp', b: ' ' }), labels: { up: 'rotate', down: 'soft drop', a: 'rotate', b: 'drop' }, rep: { left: [170, 55], right: [170, 55], down: [0, 45] } },
    { id: 'snake-panel', name: 'Snake', keys: ext(D, { a: ' ' }), labels: { a: 'again' } },
    { id: 'g2048-panel', name: '2048', keys: ext(D, { select: ' ' }), labels: { select: 'new' } },
    { id: 'game-panel', name: 'Brick Breaker', keys: { left: 'ArrowLeft', right: 'ArrowRight', a: ' ' }, labels: { a: 'launch' }, rep: { left: [0, 22], right: [0, 22] }, tilt: ['left', 'right'] },
    { id: 'pong-panel', name: 'Pong', keys: ext(D, { a: ' ', start: 'p' }), labels: { a: 'serve', start: 'pause' } },
    { id: 'flappy-panel', name: 'Flit', keys: { up: 'ArrowUp', a: ' ', start: 'p' }, labels: { up: 'flap', a: 'flap', start: 'pause' } },
    { id: 'asteroids-panel', name: 'Asteroids', keys: { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', a: ' ', b: 'h', start: 'p', select: 'Enter' }, labels: { up: 'thrust', down: 'hyper', a: 'fire', b: 'hyper', start: 'pause', select: 'start' }, tilt: ['left', 'right'] },
    { id: 'invaders-panel', name: 'Invaders', keys: { left: 'ArrowLeft', right: 'ArrowRight', a: ' ', start: 'p', select: 'Enter' }, labels: { a: 'fire', start: 'pause', select: 'start' }, tilt: ['left', 'right'] },
    { id: 'uphill-panel', name: 'Uphill Rush', keys: { right: 'ArrowRight', left: 'ArrowLeft', up: 'ArrowUp', down: 'ArrowDown', a: 'd', b: 'a', x: ' ', y: 'g', start: 'p', select: 'r' }, labels: { right: 'gas', left: 'brake', up: 'gas', down: 'brake', a: 'lean ▶', b: '◀ lean', x: 'go', y: 'ghost', start: 'pause', select: 'restart' }, tilt: ['b', 'a'] },
    { id: 'learntofly-panel', name: 'Learn to Fly', keys: ext(D, { a: ' ', start: 'p' }), labels: { up: 'nose up', down: 'nose down', a: 'boost', start: 'pause' }, tilt: ['up', 'down'] },
    { id: 'papertoss-panel', name: 'Paper Toss', keys: { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', a: ' ' }, labels: { left: 'aim', right: 'aim', a: 'throw' }, rep: { left: [0, 40], right: [0, 40] } },
    { id: 'inkdrop-panel', name: 'Ink Drop', keys: { left: 'ArrowLeft', right: 'ArrowRight', a: ' ', b: 'z' }, labels: { left: 'level', right: 'level', a: 'go', b: 'undo' } },
    { id: 'crawler-panel', name: 'Dungeon Crawler', keys: ext(D, { a: 'Enter', b: ' ' }), labels: { a: 'use', b: 'rest' }, rep: { up: [260, 140], down: [260, 140], left: [260, 140], right: [260, 140] } },
    { id: 'fifteen-panel', name: '15-Puzzle', keys: ext(D, { a: 'Enter', select: 'n' }), labels: { a: 'ok', select: 'new' } },
    { id: 'sudoku-panel', name: 'Sudoku', keys: ext(D, { a: 'Enter', start: ' ' }), labels: { start: 'pause' }, rep: { up: [260, 90], down: [260, 90], left: [260, 90], right: [260, 90] } },
    { id: 'connect4-panel', name: 'Connect Four', keys: { left: 'ArrowLeft', right: 'ArrowRight', a: 'Enter', b: 'u' }, labels: { a: 'drop', b: 'undo' } },
    { id: 'towerdefense2-panel', name: 'Tower Defense V2', keys: ext(D, { a: 'Enter', b: 'u', x: 's', start: ' ', select: 'f' }), labels: { a: 'build', b: 'upgrade', x: 'sell', start: 'next wave', select: 'speed' }, rep: { up: [260, 90], down: [260, 90], left: [260, 90], right: [260, 90] } },
    { id: 'towerdefense-panel', name: 'Tower Defense', keys: ext(D, { a: 'Enter', b: 'u', x: 's', start: ' ', select: 'f' }), labels: { a: 'build', b: 'upgrade', x: 'sell', start: 'next wave', select: 'speed' }, rep: { up: [260, 90], down: [260, 90], left: [260, 90], right: [260, 90] } },
    // presenter targets (overlays, matched by selector)
    { sel: '.tp-ov', name: 'Teleprompter', present: true,
      keys: { prev: 'ArrowLeft', next: 'ArrowRight', play: ' ', faster: 'ArrowUp', slower: 'ArrowDown', home: 'Home', end: 'End', bigger: '+', smaller: '-',
        left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', a: ' ' },
      labels: { prev: 'back', next: 'forward', play: 'play / pause', faster: 'faster', slower: 'slower', home: 'restart', bigger: 'bigger', smaller: 'smaller' },
      rep: { faster: [300, 120], slower: [300, 120] } },
    { sel: '.bt-ov', name: 'Big Text', present: true,
      keys: { prev: 'ArrowLeft', next: 'ArrowRight', home: 'Home', end: 'End', left: 'ArrowLeft', right: 'ArrowRight', a: 'ArrowRight' },
      labels: { prev: 'previous', next: 'next', home: 'first', end: 'last' } }
  ];
  // The editor: presenter actions instead of keys.
  var EDITOR = { id: 'editor', name: 'the note', present: true,
    keys: { prev: '@pageUp', next: '@pageDown', play: '@auto', faster: '@faster', slower: '@slower', home: '@top', end: '@bottom',
      up: '@lineUp', down: '@lineDown', left: '@pageUp', right: '@pageDown', a: '@auto' },
    labels: { prev: 'page up', next: 'page down', play: 'auto-scroll', faster: 'faster', slower: 'slower', home: 'top', end: 'bottom' },
    rep: { up: [0, 60], down: [0, 60] } };

  // What the controller gets told: name, kind and the buttons that do something.
  function ctxOf(p) {
    var btns = [], k;
    for (k in p.keys) if (p.keys[k]) btns.push(k);
    return { id: p.id || p.sel || 'editor', name: p.name, kind: p.present ? 'present' : 'game', btns: btns.sort(), labels: p.labels || {}, tilt: p.tilt || ['left', 'right'], scroll: p === EDITOR || !!p.scroll };
  }
  // Pick the profile among what's showing. cands: [{id or sel, z, order}] of visible
  // targets (overlays outrank panels; then highest z-index, then latest in the DOM).
  function pick(cands) {
    var best = null;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!best || (c.ov ? 1 : 0) > (best.ov ? 1 : 0) || ((c.ov ? 1 : 0) === (best.ov ? 1 : 0) && (c.z > best.z || (c.z === best.z && c.order > best.order)))) best = c;
    }
    return best;
  }

  var Pure = { PROFILES: PROFILES, EDITOR: EDITOR, ctxOf: ctxOf, pick: pick };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Pure; return; }
  if (typeof window === 'undefined' || !window.Cade || window.__cadeRemoteHost) return;

  // ---- host (browser) -------------------------------------------------------------------------
  var Cade = window.Cade, L = window.__cadeRemoteLink;
  Cade.loadCSS('remote.css');
  var sessions = {}, stopRelay = null, tick = 0, chip = null;

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (Cade.isMinimized(el)) return false;
    var r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden';
  }
  // The profile + element input should go to right now.
  function target() {
    var cands = [], all = document.querySelectorAll('.cade-panel, .tp-ov, .bt-ov');
    for (var i = 0; i < all.length; i++) {
      var el = all[i], p = null;
      for (var j = 0; j < PROFILES.length; j++) {
        var P = PROFILES[j];
        if ((P.id && el.id === P.id) || (P.sel && el.matches(P.sel))) { p = P; break; }
      }
      if (!p || !visible(el)) continue;
      cands.push({ p: p, el: el, ov: !!p.sel, z: parseInt(getComputedStyle(el).zIndex, 10) || 0, order: i });
    }
    var b = pick(cands);
    return b ? { p: b.p, el: b.el } : { p: EDITOR, el: null };
  }

  // ---- key synthesis --------------------------------------------------------------------------
  function fire(el, type, key, repeat) {
    var d = L.keyDef(key);
    var ev;
    try { ev = new KeyboardEvent(type, { key: d[0], code: d[1], bubbles: true, cancelable: true, repeat: !!repeat }); }
    catch (e) { return; }
    try { Object.defineProperty(ev, 'keyCode', { get: function () { return d[2]; } }); Object.defineProperty(ev, 'which', { get: function () { return d[2]; } }); } catch (e) {}
    (el && el.isConnected ? el : document).dispatchEvent(ev);
  }

  // ---- editor presenter actions -----------------------------------------------------------------
  var auto = { on: false, speed: 60, raf: 0, last: 0, acc: 0 };   // px per second
  function sd() { return Cade.editor ? Cade.editor.scrollDOM : null; }
  function scrollBy(dy, smooth) { var s = sd(); if (s) s.scrollBy({ top: dy, behavior: smooth ? 'smooth' : 'auto' }); }
  function autoStep(ts) {
    auto.raf = 0;
    if (!auto.on) return;
    var s = sd();
    if (!s || document.visibilityState !== 'visible') { autoStop(); return; }
    if (auto.last) {
      auto.acc += auto.speed * Math.min(0.1, (ts - auto.last) / 1000);
      var px = Math.floor(auto.acc);
      if (px) { s.scrollTop += px; auto.acc -= px; }
      if (s.scrollTop + s.clientHeight >= s.scrollHeight - 1) { autoStop(); return; }
    }
    auto.last = ts;
    auto.raf = requestAnimationFrame(autoStep);
  }
  function autoStart() { auto.on = true; auto.last = 0; if (!auto.raf) auto.raf = requestAnimationFrame(autoStep); paintChip(); }
  function autoStop() { auto.on = false; if (auto.raf) cancelAnimationFrame(auto.raf); auto.raf = 0; paintChip(); }
  function editorAction(a) {
    var s = sd();
    if (!s) return;
    var page = Math.max(80, s.clientHeight * 0.85);
    if (a === '@pageDown') scrollBy(page, true);
    else if (a === '@pageUp') scrollBy(-page, true);
    else if (a === '@lineDown') scrollBy(48, false);
    else if (a === '@lineUp') scrollBy(-48, false);
    else if (a === '@top') s.scrollTo({ top: 0, behavior: 'smooth' });
    else if (a === '@bottom') s.scrollTo({ top: s.scrollHeight, behavior: 'smooth' });
    else if (a === '@auto') { if (auto.on) autoStop(); else autoStart(); }
    else if (a === '@faster') { auto.speed = Math.min(600, Math.round(auto.speed * 1.25)); if (!auto.on) autoStart(); }
    else if (a === '@slower') auto.speed = Math.max(10, Math.round(auto.speed / 1.25));
  }

  // ---- applying input ---------------------------------------------------------------------------
  function press(s, t, btn, kind) {
    var key = t.p.keys[btn];
    if (!key) return;
    if (key.charAt(0) === '@') {
      if (kind === 'down') editorAction(key);
      var r = t.p.rep && t.p.rep[btn];
      if (r) { stopRep(s, btn); if (kind === 'down') startRep(s, btn, r, function () { editorAction(key); }); }
      return;
    }
    if (kind === 'down') {
      if (t.p.blurEditor !== false && Cade.editor && Cade.editor.hasFocus && !t.p.present) { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
      fire(t.el, 'keydown', key, false);
      var rp = t.p.rep && t.p.rep[btn];
      if (rp) startRep(s, btn, rp, function () { fire(t.el, 'keydown', key, true); });
    } else {
      stopRep(s, btn);
      fire(t.el, 'keyup', key, false);
    }
  }
  function startRep(s, btn, r, fn) {
    stopRep(s, btn);
    var st = s.rep[btn] = { t: 0, i: 0 };
    st.t = setTimeout(function () { fn(); st.i = setInterval(fn, r[1]); }, r[0] || r[1]);
  }
  function stopRep(s, btn) { var st = s.rep[btn]; if (st) { clearTimeout(st.t); clearInterval(st.i); delete s.rep[btn]; } }

  function apply(s, next) {
    var t = target();
    if (s.ctxId !== (t.p.id || t.p.sel)) sendCtx(s, t);
    var ev = L.diffButtons(s.st, next), dy = next.y - s.st.y;
    s.st = next;
    for (var i = 0; i < ev.length; i++) press(s, t, ev[i][0], ev[i][1]);
    if (dy) {
      if (t.p === EDITOR) scrollBy(dy, false);
      else if (t.el) { try { t.el.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true })); } catch (e) {} }
    }
    clearTimeout(s.wd);
    if (s.st.h) s.wd = setTimeout(function () { releaseHeld(s); }, L.RELEASE_AFTER);
  }
  function releaseHeld(s) {
    var t = target(), ev = L.releaseAll(s.st);
    s.st = { h: 0, n: s.st.n, y: s.st.y };
    for (var i = 0; i < ev.length; i++) press(s, t, ev[i][0], 'up');
  }

  // ---- sessions ---------------------------------------------------------------------------------
  function send(s, m) {
    if (s.dc && s.dc.readyState === 'open') { try { s.dc.send(JSON.stringify(m)); return; } catch (e) {} }
    s.relay.send(m);
  }
  function sendCtx(s, t) {
    t = t || target();
    s.ctxId = t.p.id || t.p.sel;
    var c = ctxOf(t.p);
    c.auto = auto.on;
    send(s, { ctx: c, via: s.dc && s.dc.readyState === 'open' ? 'direct' : 'cloud', host: Cade.cloud.device.name });
  }
  function onSig(from, m) {
    if (m.t === 'hello' || m.t === 'offer') {
      var s = ensure(from, m);
      if (m.t === 'offer' && m.sdp) answer(s, m.sdp);
    } else if (m.t === 'bye') end(from, 'bye');
  }
  function ensure(from, m) {
    var s = sessions[from];
    if (s && s.sid !== m.sid) { end(from, 'replaced'); s = null; }
    if (!s) {
      s = sessions[from] = { from: from, sid: m.sid, name: m.name || 'Device', st: L.blankState(), q: -1, last: Date.now(), rep: {}, wd: 0, relay: L.relayWriter(from + '~c'), pc: null, dc: null, ctxId: '' };
      if (!stopRelay) stopRelay = L.listenRelay('r', onRelay);
      if (!tick) tick = setInterval(onTick, 1000);
      try { Cade.showToast('🎮 ' + s.name + ' connected', 'success', 1600); } catch (e) {}
      sendCtx(s);
      paintChip();
    }
    s.last = Date.now();
    return s;
  }
  function answer(s, sdp) {
    if (!L.rtcOk()) return;
    L.closePc(s.pc, s.dc); s.pc = null; s.dc = null;
    var a;
    try { a = L.rtcAnswer(sdp, function (dc) { bindDc(s, dc); }); } catch (e) { return; }
    s.pc = a.pc;
    a.sdp.then(function (ans) { if (sessions[s.from] === s) return L.sendSig(s.from + '~c', { t: 'answer', sid: s.sid, sdp: ans }); }).catch(function () {});
  }
  function bindDc(s, dc) {
    s.dc = dc;
    dc.onopen = function () { paintChip(); sendCtx(s); };
    dc.onclose = function () { if (s.dc === dc) { s.dc = null; paintChip(); } };
    dc.onmessage = function (e) { var m; try { m = JSON.parse(e.data); } catch (x) { return; } onMsg(s, m); };
  }
  function onRelay(from, m) { var s = sessions[from]; if (s) onMsg(s, m); }
  function onMsg(s, m) {
    s.last = Date.now();
    if (m.ping) { send(s, { pong: m.ping }); return; }
    if (m.sid !== s.sid || typeof m.q !== 'number' || m.q <= s.q) return;
    s.q = m.q;
    if (m.n) apply(s, { h: m.h | 0, n: m.n, y: +m.y || 0 });
    if (m.hi) sendCtx(s);
  }
  function onTick() {
    var now = Date.now(), any = false;
    for (var k in sessions) {
      var s = sessions[k];
      if (now - s.last > L.GONE_AFTER) { end(k, 'timeout'); continue; }
      any = true;
      var t = target();
      if (s.ctxId !== (t.p.id || t.p.sel)) sendCtx(s, t);
    }
    if (!any) idle();
  }
  function end(from, why) {
    var s = sessions[from];
    if (!s) return;
    releaseHeld(s);
    for (var b in s.rep) stopRep(s, b);
    clearTimeout(s.wd);
    L.closePc(s.pc, s.dc);
    s.relay.close();
    delete sessions[from];
    if (why === 'bye' || why === 'timeout') { try { Cade.showToast('🎮 ' + s.name + ' disconnected', 'info', 1400); } catch (e) {} }
    if (why === 'kick') { L.sendSig(from + '~c', { t: 'bye', sid: s.sid }).catch(function () {}); }
    paintChip();
    if (!Object.keys(sessions).length) idle();
  }
  function idle() {
    if (Object.keys(sessions).length) return;
    clearInterval(tick); tick = 0;
    if (stopRelay) { stopRelay(); stopRelay = null; }
    autoStop();
    paintChip();
  }
  function endAll(why) { Object.keys(sessions).forEach(function (k) { end(k, why); }); idle(); }

  // ---- connected chip ---------------------------------------------------------------------------
  function paintChip() {
    var list = Object.keys(sessions).map(function (k) { return sessions[k]; });
    if (!list.length) { if (chip) { chip.remove(); chip = null; } return; }
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'rc-chip';
      chip.setAttribute('role', 'status');
      chip.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('[data-kick]');
        if (b) endAll('kick');
      });
      document.body.appendChild(chip);
    }
    var s = list[0], direct = !!(s.dc && s.dc.readyState === 'open');
    chip.innerHTML = '<span class="rc-dot' + (direct ? ' on' : '') + '"></span><span class="rc-ct">🎮 ' + Cade.escapeHtml(s.name) + (list.length > 1 ? ' +' + (list.length - 1) : '') +
      ' · ' + (direct ? 'direct' : 'via cloud') + (auto.on ? ' · auto-scroll' : '') + '</span>' +
      '<button type="button" class="rc-x" data-kick title="Disconnect" aria-label="Disconnect">✕</button>';
  }

  window.__cadeRemoteHost = { onSig: onSig, endAll: endAll, sessions: function () { return Object.keys(sessions).map(function (k) { var s = sessions[k]; return { from: k, name: s.name, direct: !!(s.dc && s.dc.readyState === 'open') }; }); } };
})(typeof self !== 'undefined' ? self : this);
