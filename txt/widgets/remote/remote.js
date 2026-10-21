/* Remote — use this device to control another of yours: a gamepad for the
 * games (D-pad, A/B/X/Y, start/select, tilt-to-steer) or a presenter remote
 * (next / back, play-pause, speed, size, a scroll strip and a stopwatch) for
 * the Teleprompter, Big Text or the note itself.
 *
 * Pick a device — every open, visible copy of the app on your account that has
 * "Let my other devices control this one" on (remote-recv.js) shows up — and
 * the other side tells this one what it is showing (which game, which buttons
 * do something, what they're called), so the pad relabels itself and switches
 * between gamepad and presenter on its own. Input goes as state packets
 * (remote-link.js): direct over WebRTC when the two can see each other, via the
 * cloud otherwise; the status line shows which and the round trip.
 *
 * While connected the screen stays awake (Wake Lock). Everything — listeners,
 * timers, the peer connection, the wake lock, tilt — stops on disconnect and
 * close. Keyboard works too (arrows, space, enter, p) when the panel has focus. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Cade) return;
  var Cade = window.Cade;
  Cade.loadCSS('remote.css');
  var LINK_URL = Cade.asset('remote-link.js');
  var PANEL_ID = 'remote-panel', PREFS_KEY = 'cade-remote-prefs';
  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };

  var linkP = null;
  function loadLink() {
    if (window.__cadeRemoteLink) return Promise.resolve(window.__cadeRemoteLink);
    if (linkP) return linkP;
    return (linkP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = LINK_URL; s.async = true;
      s.onload = function () { res(window.__cadeRemoteLink); };
      s.onerror = function () { linkP = null; rej(new Error('Remote failed to load (offline?)')); };
      document.head.appendChild(s);
    }));
  }

  var prefs = { mode: 'pad', lastDid: '', tilt: false };
  function loadPrefs() { try { var p = JSON.parse(Cade.store.get(PREFS_KEY) || 'null'); if (p) for (var k in prefs) if (k in p) prefs[k] = p[k]; } catch (e) {} }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }

  var P = null, L = null, el = {}, devices = [], stopDevs = null, stopSig = null;
  var C = null;          // the connection
  var down = {};         // button → number of sources holding it (fingers, D-pad, tilt, keys)
  var ptr = {};          // pointerId → button (face / presenter buttons)
  var dpadPtr = null, dpadDirs = '';
  var stripPtr = null, stripY = 0;
  var wake = null, tiltOn = false, tiltDirs = '';
  var timer = { on: false, t0: 0, acc: 0, iv: 0 };

  // ---- markup -----------------------------------------------------------------------------------
  function bodyHtml() {
    function b(name, txt, cls) { return '<button type="button" class="rc-b ' + (cls || '') + '" data-b="' + name + '"><span class="rc-bt">' + txt + '</span><small class="rc-lb" data-lb="' + name + '"></small></button>'; }
    return '<div class="rc" tabindex="-1">' +
      '<div class="rc-top">' +
        '<button type="button" class="rc-dev" data-act="pick" aria-haspopup="true"><span class="rc-dot"></span><span class="rc-dn">Choose a device</span><span class="rc-car">▾</span></button>' +
        '<div class="rc-seg" role="group" aria-label="Mode"><button type="button" data-mode="pad">🎮 Pad</button><button type="button" data-mode="pres">▶ Present</button></div>' +
      '</div>' +
      '<div class="rc-ctx"><span class="rc-what">Not connected</span><span class="rc-st"></span></div>' +
      '<div class="rc-pad">' +
        '<div class="rc-sys">' + b('select', 'select', 'rc-pill') + '<button type="button" class="rc-pill rc-tilt" data-act="tilt" aria-pressed="false"><span class="rc-bt">tilt</span><small class="rc-lb rc-tl"></small></button>' + b('start', 'start', 'rc-pill') + '</div>' +
        '<div class="rc-main">' +
          '<div class="rc-dpad" aria-label="D-pad">' +
            '<span class="rc-arm rc-u" data-d="up">▲<small class="rc-lb" data-lb="up"></small></span>' +
            '<span class="rc-arm rc-l" data-d="left">◀<small class="rc-lb" data-lb="left"></small></span>' +
            '<span class="rc-arm rc-r" data-d="right">▶<small class="rc-lb" data-lb="right"></small></span>' +
            '<span class="rc-arm rc-d" data-d="down">▼<small class="rc-lb" data-lb="down"></small></span>' +
            '<span class="rc-hub"></span>' +
          '</div>' +
          '<div class="rc-face">' + b('y', 'Y', 'rc-f rc-fy') + b('x', 'X', 'rc-f rc-fx') + b('b', 'B', 'rc-f rc-fb') + b('a', 'A', 'rc-f rc-fa') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="rc-pres">' +
        '<button type="button" class="rc-clock" data-act="clock" title="Tap: start / pause · hold: reset">00:00</button>' +
        b('next', 'next ▶', 'rc-next') +
        '<div class="rc-row">' + b('prev', '◀ back') + b('play', '▶ ❚❚') + '</div>' +
        '<div class="rc-row">' + b('slower', '− slower') + b('faster', 'faster +') + '</div>' +
        '<div class="rc-row rc-row4">' + b('home', '⏮') + b('smaller', 'A−') + b('bigger', 'A+') + b('end', '⏭') + '</div>' +
        '<div class="rc-strip" aria-label="Drag to scroll"><span>drag to scroll</span></div>' +
      '</div>' +
      '<div class="rc-sheet" hidden></div>' +
    '</div>';
  }
  function q(s) { return P.querySelector(s); }

  // ---- input state ------------------------------------------------------------------------------
  function press(b) {
    if (!L || !C) return;
    if ((down[b] = (down[b] || 0) + 1) === 1) {
      C.st.h = L.setHeld(C.st.h, b, true);
      C.st.n[L.BI[b]]++;
      send();
      try { Cade.haptic(8); } catch (e) {}
    }
    var e = P && P.querySelector('[data-b="' + b + '"],[data-d="' + b + '"]');
    if (e) e.classList.add('on');
  }
  function release(b) {
    if (!L || !C || !down[b]) return;
    if (--down[b] === 0) {
      C.st.h = L.setHeld(C.st.h, b, false);
      send();
      var e = P && P.querySelector('[data-b="' + b + '"],[data-d="' + b + '"]');
      if (e) e.classList.remove('on');
    }
  }
  function releaseAllLocal() {
    for (var b in down) { down[b] = 1; release(b); }
    down = {}; ptr = {}; dpadPtr = null; dpadDirs = ''; tiltDirs = '';
    if (P) P.querySelectorAll('.on').forEach(function (e) { if (!e.matches('[data-mode],[data-act="tilt"]')) e.classList.remove('on'); });
  }
  // Packets: whole state, sequence-numbered. Direct: sent twice (unreliable channel); cloud: coalesced.
  function send(extra) {
    if (!C) return;
    var m = { sid: C.sid, q: ++C.q, h: C.st.h, n: C.st.n, y: Math.round(C.st.y) };
    if (extra) for (var k in extra) m[k] = extra[k];
    var dc = C.dc;
    if (dc && dc.readyState === 'open') {
      var s = JSON.stringify(m);
      try { dc.send(s); } catch (e) {}
      clearTimeout(C.dup);
      C.dup = setTimeout(function () { if (C && C.dc === dc && dc.readyState === 'open') { try { dc.send(s); } catch (e) {} } }, 40);
    } else C.relay.send(m);
  }

  // ---- connection -------------------------------------------------------------------------------
  function connect(dev) {
    disconnect(true);
    var me = Cade.cloud.device;
    C = { to: dev.inst, did: dev.did, name: dev.name, sid: L.rid(10), q: 0, st: L.blankState(), relay: L.relayWriter(dev.inst),
      pc: null, dc: null, via: 'connecting', rtt: 0, ctx: null, lastReply: 0, t0: Date.now(), dup: 0, hb: 0, ping: 0, manualMode: false };
    prefs.lastDid = dev.did; savePrefs();
    C.stopRelay = L.listenRelay('c', onReply);
    L.sendSig(dev.inst, { t: 'hello', sid: C.sid, name: me.name, kind: me.kind }).catch(function () {});
    send({ hi: 1 });
    if (L.rtcOk()) {
      try {
        var o = L.rtcOffer(), c = C;
        C.pc = o.pc; C.dc = o.dc;
        o.dc.onopen = function () { if (C === c) { C.via = 'direct'; send({ hi: 1 }); ping(); paint(); } };
        o.dc.onclose = function () { if (C === c && C.dc === o.dc) { C.dc = null; C.via = C.lastReply ? 'cloud' : 'connecting'; paint(); } };
        o.dc.onmessage = function (e) { var m; try { m = JSON.parse(e.data); } catch (x) { return; } if (C === c) onMsg(m); };
        o.sdp.then(function (sdp) { if (C === c) return L.sendSig(dev.inst, { t: 'offer', sid: c.sid, sdp: sdp, name: me.name, kind: me.kind }); }).catch(function () {});
      } catch (e) {}
    }
    C.hb = setInterval(beat, L.HEARTBEAT_HELD);
    C.ping = setInterval(ping, 2000);
    keepAwake(true);
    closeSheet();
    paint();
  }
  function disconnect(quiet) {
    var c = C;
    if (!c) return;
    releaseAllLocal();
    C = null;
    clearInterval(c.hb); clearInterval(c.ping); clearTimeout(c.dup);
    if (c.stopRelay) c.stopRelay();
    L.sendSig(c.to, { t: 'bye', sid: c.sid }).catch(function () {});
    c.relay.close();
    L.closePc(c.pc, c.dc);
    keepAwake(false);
    if (!quiet) paint();
  }
  function beat() {
    if (!C) return;
    var now = Date.now();
    if (C.st.h) send();                                                  // keep held buttons held
    else if (now - (C.lastSend || 0) > L.HEARTBEAT_IDLE) send();          // still here
    C.lastSend = now;
    if (!C.lastReply && now - C.t0 > 6000 && C.via !== 'none') { C.via = 'none'; paint(); }
  }
  function ping() {
    if (!C) return;
    var m = { ping: Math.round(performance.now() * 10) / 10 };
    if (C.dc && C.dc.readyState === 'open') { try { C.dc.send(JSON.stringify(m)); } catch (e) {} }
    else C.relay.send(m);
  }
  function onReply(from, m) { if (C && from === C.to) onMsg(m); }
  function onMsg(m) {
    if (!C) return;
    C.lastReply = Date.now();
    if (m.pong) { C.rtt = Math.max(0, performance.now() - m.pong); if (C.via === 'connecting' || C.via === 'none') C.via = C.dc && C.dc.readyState === 'open' ? 'direct' : 'cloud'; paintStatus(); return; }
    if (m.ctx) {
      var was = C.ctx && C.ctx.kind;
      C.ctx = m.ctx;
      if (C.via === 'connecting' || C.via === 'none') C.via = C.dc && C.dc.readyState === 'open' ? 'direct' : 'cloud';
      if (!C.manualMode && m.ctx.kind !== was) setMode(m.ctx.kind === 'present' ? 'pres' : 'pad', false);
      paint();
    }
  }
  function onSig(from, m) {
    if (!C || from !== C.to || m.sid !== C.sid) return;
    if (m.t === 'answer' && C.pc && m.sdp) L.rtcAccept(C.pc, m.sdp).catch(function () {});
    else if (m.t === 'bye') { var n = C.name; disconnect(); try { Cade.showToast('Disconnected by ' + n, 'info', 1600); } catch (e) {} }
  }

  // ---- screen -----------------------------------------------------------------------------------
  function setMode(mode, manual) {
    prefs.mode = mode === 'pres' ? 'pres' : 'pad';
    if (manual) { savePrefs(); if (C) C.manualMode = true; }
    if (P) P.setAttribute('data-rcmode', prefs.mode);
    var bs = P ? P.querySelectorAll('[data-mode]') : [];
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-mode') === prefs.mode);
  }
  function paintStatus() {
    if (!P) return;
    var st = el.st, dot = el.dot, v = C ? C.via : '';
    dot.className = 'rc-dot' + (v === 'direct' ? ' on' : v === 'cloud' ? ' mid' : v === 'none' ? ' bad' : '');
    st.textContent = !C ? '' : v === 'direct' ? 'direct · ' + Math.round(C.rtt) + ' ms' : v === 'cloud' ? 'via cloud' + (C.rtt ? ' · ' + Math.round(C.rtt) + ' ms' : '')
      : v === 'none' ? 'no answer — is it open?' : 'connecting…';
  }
  function paint() {
    if (!P) return;
    el.dn.textContent = C ? C.name : 'Choose a device';
    var ctx = C && C.ctx;
    el.what.textContent = !C ? (Cade.cloud.configured() ? 'Not connected — choose a device' : 'Set up Sync to find your devices')
      : ctx ? (ctx.kind === 'present' ? '▶ ' : '🎮 ') + ctx.name : 'Connecting to ' + C.name + '…';
    var btns = ctx ? ctx.btns : null, labels = ctx ? ctx.labels || {} : {};
    P.querySelectorAll('[data-lb]').forEach(function (e) { e.textContent = labels[e.getAttribute('data-lb')] || ''; });
    P.querySelectorAll('[data-b],[data-d]').forEach(function (e) {
      var n = e.getAttribute('data-b') || e.getAttribute('data-d');
      e.classList.toggle('off', !!btns && btns.indexOf(n) < 0);
    });
    var tl = q('.rc-tl');
    if (tl) tl.textContent = ctx && ctx.tilt ? ctx.tilt.map(function (b) { return labels[b] || b; }).join(' / ') : '';
    paintStatus();
  }

  // ---- device sheet ------------------------------------------------------------------------------
  function openSheet() {
    var sh = el.sheet;
    sh.hidden = false;
    renderSheet();
  }
  function closeSheet() { if (el.sheet) el.sheet.hidden = true; }
  function renderSheet() {
    var sh = el.sheet;
    if (!sh || sh.hidden) return;
    var me = Cade.cloud.device, rs = window.__cadeRemoteRecv ? window.__cadeRemoteRecv.status() : null;
    var h = '<div class="rc-sh-head"><b>Control a device</b><button type="button" class="rc-x" data-act="close-sheet" aria-label="Close">✕</button></div>';
    if (!Cade.cloud.configured()) {
      h += '<p class="rc-note">Remote finds your other devices through Sync. Set up Sync (same database and key) on each device, then open the app there.</p>';
    } else {
      var others = devices.filter(function (d) { return !d.self; });
      if (!others.length) h += '<p class="rc-note">' + (devices === null ? 'Looking…' : 'No other device is ready. Open the app on the device you want to control (it must be on screen), with “Let my other devices control this one” on in Settings.') + '</p>';
      else {
        var names = {};
        others.forEach(function (d) { names[d.name] = (names[d.name] || 0) + 1; });
        h += '<div class="rc-list">' + others.map(function (d) {
          var icon = d.kind === 'phone' ? '📱' : d.kind === 'tablet' ? '📲' : '💻';
          var on = C && C.to === d.inst;
          return '<button type="button" class="rc-item' + (on ? ' on' : '') + '" data-inst="' + esc(d.inst) + '"><span class="rc-ic">' + icon + '</span><span class="rc-in">' + esc(d.name) +
            (names[d.name] > 1 ? ' <small>tab ' + esc(d.inst.split('-')[1] || '') + '</small>' : '') + (d.sameDevice ? ' <small>(this device, another tab)</small>' : '') + '</span>' +
            '<span class="rc-is">' + (on ? 'connected' : 'connect') + '</span></button>';
        }).join('') + '</div>';
      }
      if (C) h += '<button type="button" class="rc-btn" data-act="disconnect">Disconnect from ' + esc(C.name) + '</button>';
    }
    h += '<div class="rc-me"><label>This device <input type="text" class="rc-name" maxlength="40" value="' + esc(me.name) + '" aria-label="This device’s name"></label>' +
      '<small>' + (rs ? (!rs.enabled ? 'Can’t be controlled — turn on “Let my other devices control this one” in Settings.' : rs.online ? 'Ready to be controlled by your other devices.' : rs.configured ? 'Going online…' : 'Needs Sync to be controlled.') : '') + '</small></div>';
    sh.innerHTML = h;
  }
  function onDevices(list) {
    devices = list || [];
    renderSheet();
    // our device came back under a new tab id (reload): follow it
    if (C && !devices.some(function (d) { return d.inst === C.to; })) {
      var again = devices.filter(function (d) { return !d.self && d.did === C.did; })[0];
      if (again) connect(again);
    }
    // first open: reconnect to the device used last time if it's here
    if (!C && !P.__auto && prefs.lastDid) {
      var last = devices.filter(function (d) { return !d.self && d.did === prefs.lastDid; })[0];
      if (last) { P.__auto = true; connect(last); }
    }
  }

  // ---- touch: buttons, D-pad, scroll strip -------------------------------------------------------
  function onDown(e) {
    var t = e.target;
    if (!t.closest) return;
    var dp = t.closest('.rc-dpad'), b = t.closest('[data-b]'), strip = t.closest('.rc-strip');
    if (dp && dpadPtr == null) { e.preventDefault(); dpadPtr = e.pointerId; try { dp.setPointerCapture(e.pointerId); } catch (x) {} dpadMove(e, dp); return; }
    if (b && C) { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (x) {} ptr[e.pointerId] = b.getAttribute('data-b'); press(ptr[e.pointerId]); return; }
    if (strip && C && stripPtr == null) { e.preventDefault(); stripPtr = e.pointerId; stripY = e.clientY; try { strip.setPointerCapture(e.pointerId); } catch (x) {} strip.classList.add('on'); return; }
  }
  function onMove(e) {
    if (e.pointerId === dpadPtr) { e.preventDefault(); dpadMove(e, el.dpad); }
    else if (e.pointerId === stripPtr && C) {
      e.preventDefault();
      var dy = e.clientY - stripY; stripY = e.clientY;
      C.st.y -= dy * 2.2;                     // drag up → scroll down, like a trackpad
      send();
    }
  }
  function onUp(e) {
    if (e.pointerId === dpadPtr) { dpadPtr = null; setDpad(''); return; }
    if (e.pointerId === stripPtr) { stripPtr = null; if (el.strip) el.strip.classList.remove('on'); return; }
    var b = ptr[e.pointerId];
    if (b) { delete ptr[e.pointerId]; release(b); }
  }
  // 8-way from the finger's angle around the hub, with a dead zone in the middle.
  function dpadMove(e, dp) {
    var r = dp.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var dx = e.clientX - cx, dy = e.clientY - cy, dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < r.width * 0.12) { setDpad(''); return; }
    var a = Math.atan2(dy, dx) * 180 / Math.PI, sector = Math.round(((a + 360) % 360) / 45) % 8;
    setDpad(['right', 'right down', 'down', 'down left', 'left', 'left up', 'up', 'up right'][sector]);
  }
  function setDpad(dirs) {
    if (dirs === dpadDirs) return;
    var old = dpadDirs ? dpadDirs.split(' ') : [], now = dirs ? dirs.split(' ') : [];
    old.forEach(function (d) { if (now.indexOf(d) < 0) release(d); });
    now.forEach(function (d) { if (old.indexOf(d) < 0) press(d); });
    dpadDirs = dirs;
  }

  // ---- tilt to steer --------------------------------------------------------------------------------
  function onTilt(e) {
    if (!C) return;
    var ang = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    var v = ang === 90 ? e.beta : ang === -90 || ang === 270 ? -e.beta : e.gamma;     // left/right tilt in any orientation
    if (v == null) return;
    var map = (C.ctx && C.ctx.tilt) || ['left', 'right'];
    var want = tiltDirs;
    if (v < -14) want = map[0]; else if (v > 14) want = map[1]; else if (Math.abs(v) < 8) want = '';
    if (want === tiltDirs) return;
    if (tiltDirs) release(tiltDirs);
    if (want) press(want);
    tiltDirs = want;
  }
  function setTilt(on) {
    var btn = q('[data-act="tilt"]');
    if (on && !tiltOn) {
      var go = function () { tiltOn = true; window.addEventListener('deviceorientation', onTilt); if (btn) { btn.classList.add('on'); btn.setAttribute('aria-pressed', 'true'); } };
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(function (r) { if (r === 'granted') go(); else Cade.showToast('Motion access was declined', 'error', 2000); }, function () { Cade.showToast('Motion access needs a tap to allow', 'error', 2000); });
      } else if (typeof DeviceOrientationEvent !== 'undefined') go();
      else Cade.showToast('This device has no motion sensor', 'info', 1800);
    } else if (!on && tiltOn) {
      tiltOn = false;
      window.removeEventListener('deviceorientation', onTilt);
      if (tiltDirs) { release(tiltDirs); tiltDirs = ''; }
      if (btn) { btn.classList.remove('on'); btn.setAttribute('aria-pressed', 'false'); }
    }
  }

  // ---- keyboard (desktop as a controller) ------------------------------------------------------------
  var KEYMAP_PAD = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', ' ': 'a', Enter: 'b', x: 'x', y: 'y', p: 'start', Backspace: 'select' };
  var KEYMAP_PRES = { ArrowRight: 'next', PageDown: 'next', ' ': 'play', ArrowLeft: 'prev', PageUp: 'prev', ArrowUp: 'faster', ArrowDown: 'slower', Home: 'home', End: 'end', '+': 'bigger', '=': 'bigger', '-': 'smaller' };
  var keysDown = {};
  function onKey(e) {
    if (!P || !C || e.ctrlKey || e.metaKey || e.altKey || !P.contains(document.activeElement) || (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName))) return;
    var map = prefs.mode === 'pres' ? KEYMAP_PRES : KEYMAP_PAD, b = map[e.key] || map[e.key.toLowerCase && e.key.toLowerCase()];
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (e.type === 'keydown') { if (!keysDown[e.key]) { keysDown[e.key] = b; press(b); } }
    else if (keysDown[e.key]) { release(keysDown[e.key]); delete keysDown[e.key]; }
  }

  // ---- wake lock, stopwatch ----------------------------------------------------------------------
  function keepAwake(on) {
    if (on) {
      if (wake || !navigator.wakeLock || document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen').then(function (w) { if (!C || !P) { w.release(); return; } wake = w; w.addEventListener('release', function () { if (wake === w) wake = null; }); }, function () {});
    } else if (wake) { try { wake.release(); } catch (e) {} wake = null; }
  }
  function onVis() {
    if (!P) return;
    if (document.visibilityState === 'visible') {
      if (C) {
        keepAwake(true);
        // the screen was off long enough for the other side to give up: start over
        if (Date.now() - (C.lastReply || C.t0) > 10000) { var d = { inst: C.to, did: C.did, name: C.name }; connect(d); }
      }
    } else releaseAllLocal();
  }
  function paintClock() {
    var ms = timer.acc + (timer.on ? Date.now() - timer.t0 : 0), s = Math.floor(ms / 1000);
    if (el.clock) el.clock.textContent = (s >= 3600 ? Math.floor(s / 3600) + ':' : '') + ('0' + Math.floor(s / 60) % 60).slice(-2) + ':' + ('0' + s % 60).slice(-2);
  }
  var clockHold = 0;
  function clockDown() { clockHold = setTimeout(function () { clockHold = -1; timer.on = false; timer.acc = 0; clearInterval(timer.iv); timer.iv = 0; paintClock(); el.clock.classList.remove('on'); }, 650); }
  function clockUp() {
    if (clockHold === -1) { clockHold = 0; return; }
    clearTimeout(clockHold); clockHold = 0;
    if (timer.on) { timer.acc += Date.now() - timer.t0; timer.on = false; clearInterval(timer.iv); timer.iv = 0; }
    else { timer.on = true; timer.t0 = Date.now(); timer.iv = setInterval(paintClock, 500); }
    el.clock.classList.toggle('on', timer.on);
    paintClock();
  }

  // ---- panel lifecycle -------------------------------------------------------------------------------
  function onClick(e) {
    var t = e.target.closest ? e.target.closest('[data-act],[data-mode],[data-inst]') : null;
    if (!t) return;
    var a = t.getAttribute('data-act');
    if (t.hasAttribute('data-mode')) setMode(t.getAttribute('data-mode'), true);
    else if (t.hasAttribute('data-inst')) {
      var d = devices.filter(function (x) { return x.inst === t.getAttribute('data-inst'); })[0];
      if (d) { if (C && C.to === d.inst) closeSheet(); else connect(d); }
    }
    else if (a === 'pick') { if (el.sheet.hidden) openSheet(); else closeSheet(); }
    else if (a === 'close-sheet') closeSheet();
    else if (a === 'disconnect') { disconnect(); renderSheet(); }
    else if (a === 'tilt') { if (!C) return; prefs.tilt = !tiltOn; savePrefs(); setTilt(!tiltOn); }
  }
  function onNameChange(e) {
    if (!e.target.classList || !e.target.classList.contains('rc-name')) return;
    Cade.cloud.setDeviceName(e.target.value);
    if (window.__cadeRemoteRecv) window.__cadeRemoteRecv.refresh();
  }
  function cleanup() {
    disconnect(true);
    setTilt(false);
    keepAwake(false);
    if (stopDevs) { stopDevs(); stopDevs = null; }
    if (stopSig) { stopSig(); stopSig = null; }
    clearInterval(timer.iv); timer.iv = 0; timer.on = false;
    clearTimeout(clockHold);
    document.removeEventListener('visibilitychange', onVis);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keyup', onKey, true);
    P = null; el = {};
  }
  function close() { var p = P; cleanup(); if (p) p.remove(); }
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    loadPrefs();
    P = Cade.mkPanel(PANEL_ID, '🎮 Remote', bodyHtml());
    P._onClose = cleanup;
    el = { dn: q('.rc-dn'), dot: q('.rc-dot'), st: q('.rc-st'), what: q('.rc-what'), sheet: q('.rc-sheet'), dpad: q('.rc-dpad'), strip: q('.rc-strip'), clock: q('.rc-clock') };
    setMode(prefs.mode, false);
    var root = q('.rc');
    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onUp);
    root.addEventListener('lostpointercapture', onUp);
    root.addEventListener('contextmenu', function (e) { if (e.target.closest && e.target.closest('.rc-pad,.rc-pres')) e.preventDefault(); });
    root.addEventListener('click', onClick);
    root.addEventListener('change', onNameChange);
    el.clock.addEventListener('pointerdown', clockDown);
    el.clock.addEventListener('pointerup', clockUp);
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKey, true);
    P.addEventListener('cade-panel-minimize', function () { releaseAllLocal(); keepAwake(false); });
    P.addEventListener('cade-panel-restore', function () { if (C) keepAwake(true); });
    try { root.focus({ preventScroll: true }); } catch (e) {}
    paint();
    if (!Cade.cloud.configured()) { openSheet(); return; }
    var p = P;
    loadLink().then(function (link) {
      if (P !== p) return;
      L = link;
      stopSig = L.listenSig('c', onSig);
      stopDevs = L.watchDevices(onDevices);
      setTimeout(function () { if (P === p && !C) openSheet(); }, 900);   // nothing to reconnect to: show the list
      if (prefs.tilt) { /* tilt needs a tap on iOS — re-enabled from the button */ }
    }, function (e) { if (P === p) { el.what.textContent = e.message; } });
  }

  Cade.registerWidget({
    name: 'Remote',
    description: 'Use your phone as a game controller or presenter remote for your other devices — D-pad, buttons and tilt for the games; next, play, speed and scroll for the Teleprompter, Big Text or the note',
    icon: '🎮',
    tags: 'remote,controller,gamepad,game controller,joystick,presenter,clicker,slides,teleprompter,phone,devices,control,tilt,multi-device',
    open: open,
    close: close
  });
})();
