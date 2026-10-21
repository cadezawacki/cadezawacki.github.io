/* Remote — the link between a controller (usually the phone) and a receiver
 * (any other open copy of the app on this account), shared by the Remote
 * widget (controller UI), remote-recv.js (the always-ready receiver plugin)
 * and remote-host.js (what the receiver does with input).
 *
 * Protocol: the controller never sends key events — it sends its whole input
 * STATE: which buttons are held (a bitmask), how many times each was pressed
 * (counters) and a running scroll total. The receiver diffs each state against
 * the last one it applied (diffButtons) and turns the difference into key
 * presses. So a lost or skipped packet can't leave a key stuck or swallow a
 * tap: the next packet carries everything, presses are counted, and a held
 * button is re-confirmed by a heartbeat (released by the receiver if the
 * heartbeat stops).
 *
 * Transport: a WebRTC data channel (unordered, no retransmits — the freshest
 * state wins, ~5–20 ms on the same Wi-Fi) set up with signalling through the
 * account's Firebase (Cade.cloud, sealed with the sync key). Until it opens —
 * or when it can't (some networks) — the same packets travel sealed through
 * Firebase ("via cloud", ~100–250 ms). Each packet carries a session id and a
 * sequence number, so whichever path delivers first wins and stale ones drop.
 *
 * Cloud layout (kind "rc", i.e. rooms/__cade_rc_<keyFp>/…):
 *   dev/<inst>             {s: sealed {n name, k kind, d deviceId}, at}   presence of ready receivers
 *   sig/<box>/<push>       {f: fromInst, s: sealed message}               hello / offer / answer / bye
 *   relay/<box>/<from>     {s: sealed packet}                             fallback path (latest state)
 * where a receiver's box is its instance id and a controller's is <inst>~c.
 * The pure part (button table, diff, key table, packet helpers) is exported
 * for node tests: node txt/widgets/remote/remote.test.js */
(function (root) {
  'use strict';

  // ---- protocol (pure) ----------------------------------------------------------------------
  var BTN = ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'start', 'select',
    'prev', 'next', 'play', 'faster', 'slower', 'home', 'end', 'bigger', 'smaller'];
  var BI = {};
  BTN.forEach(function (b, i) { BI[b] = i; });

  function held(h, name) { return ((h >>> BI[name]) & 1) === 1; }
  function setHeld(h, name, on) { var m = 1 << BI[name]; return on ? (h | m) : (h & ~m); }
  function blankState() { var n = []; for (var i = 0; i < BTN.length; i++) n.push(0); return { h: 0, n: n, y: 0 }; }

  // The key events that take the receiver from state `prev` to state `next`:
  // a list of [button, 'down' | 'up'] in order. Counters count presses, so k
  // new presses with the button now up are k taps; with it still held, k − 1
  // taps and then a press that stays down. A hold that was in progress ends
  // before any new press.
  function diffButtons(prev, next) {
    var out = [];
    for (var i = 0; i < BTN.length; i++) {
      var b = BTN[i], k = ((next.n && next.n[i]) || 0) - ((prev.n && prev.n[i]) || 0);
      var was = ((prev.h >>> i) & 1) === 1, is = ((next.h >>> i) & 1) === 1;
      if (k < 0) k = 0;
      if (!k) {
        if (was && !is) out.push([b, 'up']);
        else if (!was && is) out.push([b, 'down']);
        continue;
      }
      if (was) out.push([b, 'up']);
      var taps = is ? k - 1 : k;
      for (var t = 0; t < taps; t++) { out.push([b, 'down']); out.push([b, 'up']); }
      if (is) out.push([b, 'down']);
    }
    return out;
  }
  // Every held button released (watchdog / disconnect).
  function releaseAll(prev) {
    var out = [];
    for (var i = 0; i < BTN.length; i++) if ((prev.h >>> i) & 1) out.push([BTN[i], 'up']);
    return out;
  }

  // Keyboard events the receiver synthesises: key, code and the legacy keyCode.
  var KEYDEF = {
    ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowDown: ['ArrowDown', 'ArrowDown', 40],
    ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowRight: ['ArrowRight', 'ArrowRight', 39],
    ' ': [' ', 'Space', 32], Enter: ['Enter', 'Enter', 13], Home: ['Home', 'Home', 36], End: ['End', 'End', 35],
    PageUp: ['PageUp', 'PageUp', 33], PageDown: ['PageDown', 'PageDown', 34], Tab: ['Tab', 'Tab', 9],
    '+': ['+', 'Equal', 187], '-': ['-', 'Minus', 189]
  };
  function keyDef(k) {
    if (KEYDEF[k]) return KEYDEF[k];
    if (/^[a-z]$/.test(k)) return [k, 'Key' + k.toUpperCase(), k.toUpperCase().charCodeAt(0)];
    if (/^[0-9]$/.test(k)) return [k, 'Digit' + k, k.charCodeAt(0)];
    return [k, k, 0];
  }

  function rid(n) {
    var s = '', a = '0123456789abcdefghijklmnopqrstuvwxyz';
    var r = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(n || 8)) : null;
    for (var i = 0; i < (n || 8); i++) s += a.charAt(r ? r[i] % 36 : Math.floor(Math.random() * 36));
    return s;
  }

  var api = {
    BTN: BTN, BI: BI, held: held, setHeld: setHeld, blankState: blankState, diffButtons: diffButtons, releaseAll: releaseAll,
    KEYDEF: KEYDEF, keyDef: keyDef, rid: rid,
    HEARTBEAT_HELD: 250, HEARTBEAT_IDLE: 3000, RELEASE_AFTER: 900, GONE_AFTER: 15000, ONLINE_FOR: 3 * 60 * 1000
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || !window.Cade || window.__cadeRemoteLink) return;
  var Cade = window.Cade;
  var KIND = 'rc';
  var ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];

  // ---- cloud helpers --------------------------------------------------------------------------
  function ref(sub) { return Cade.cloud.ref(KIND, sub); }
  function seal(o) { return Cade.cloud.seal(o); }
  function unseal(s) { return Cade.cloud.unseal(s); }
  function me() { return Cade.cloud.device; }
  // Mailboxes: a receiver reads <inst>, a controller reads <inst>~c — so one tab can be both.
  function box(role) { return me().inst + (role === 'c' ? '~c' : ''); }

  // Presence of a ready receiver (removed again on disconnect / hide).
  var presenceRef = null;
  function announce(extra) {
    var d = me();
    return ref('dev/' + d.inst).then(function (r) {
      if (!r) return false;
      presenceRef = r;
      var info = { n: d.name, k: d.kind, d: d.id };
      for (var x in extra || {}) info[x] = extra[x];
      return seal(info).then(function (s) {
        try { r.onDisconnect().remove(); } catch (e) {}
        return r.set({ s: s, at: Cade.cloud.TIMESTAMP });
      }).then(function () { return true; });
    }).catch(function () { return false; });
  }
  // Still here: bump the presence stamp (cheap, no re-seal).
  function touch() {
    if (!presenceRef) return Promise.resolve();
    return presenceRef.child('at').set(Cade.cloud.TIMESTAMP).catch(function () {});
  }
  function withdraw() {
    var r = presenceRef;
    presenceRef = null;
    if (!r) return Promise.resolve();
    try { r.onDisconnect().cancel(); } catch (e) {}
    return r.remove().catch(function () {});
  }
  // Ready receivers on this account, newest first: cb([{inst, name, kind, did, at, self}]).
  function watchDevices(cb) {
    var r = null, fn = null, gen = 0, stop = false;
    ref('dev').then(function (rr) {
      if (stop || !rr) { if (!rr) cb(null); return; }
      r = rr;
      fn = r.on('value', function (snap) {
        var v = snap.val() || {}, my = me(), g = ++gen, list = [];
        var keys = Object.keys(v);
        Promise.all(keys.map(function (inst) {
          var e = v[inst];
          if (!e || typeof e.s !== 'string') return null;
          return unseal(e.s).then(function (o) {
            if (!o) return;
            list.push({ inst: inst, name: o.n || 'Device', kind: o.k || 'desktop', did: o.d || '', at: +e.at || 0, self: inst === my.inst, sameDevice: o.d === my.id });
          });
        })).then(function () {
          if (stop || g !== gen) return;
          var now = Cade.cloud.serverNow();
          list = list.filter(function (x) { return !x.at || now - x.at < api.ONLINE_FOR; });   // receivers refresh `at` every minute
          list.sort(function (a, b) { return b.at - a.at; });
          cb(list);
        });
      });
    });
    return function () { stop = true; if (r && fn) try { r.off('value', fn); } catch (e) {} };
  }

  // Signalling: one-shot sealed messages, pushed under sig/<to>; the reader removes each.
  function sendSig(to, msg) {
    return ref('sig/' + to).then(function (r) {
      if (!r) throw new Error('Sync is not set up');
      return seal(msg).then(function (s) { return r.push({ f: me().inst, s: s, at: Cade.cloud.TIMESTAMP }); });
    });
  }
  function listenSig(role, cb) {
    var r = null, fn = null, stop = false;
    ref('sig/' + box(role)).then(function (rr) {
      if (stop || !rr) return;
      r = rr;
      fn = r.on('child_added', function (snap) {
        var v = snap.val();
        try { snap.ref.remove(); } catch (e) {}
        if (!v || typeof v.s !== 'string') return;
        // stale signalling (an old offer left behind) is ignored
        if (v.at && Cade.cloud.serverNow() - v.at > 60000) return;
        unseal(v.s).then(function (m) { if (m && !stop) cb(v.f, m); });
      });
    });
    return function () { stop = true; if (r && fn) try { r.off('child_added', fn); } catch (e) {} };
  }

  // Relay: the latest sealed packet per sender under relay/<to>/<from>.
  function relayWriter(to) {
    var r = null, busy = false, pending = null, lastAt = 0, timer = 0, dead = false;
    var ready = ref('relay/' + to + '/' + me().inst).then(function (rr) {
      r = rr;
      if (r) try { r.onDisconnect().remove(); } catch (e) {}
      return r;
    });
    function flush() {
      timer = 0;
      if (dead || busy || !pending) return;
      var wait = 35 - (Date.now() - lastAt);
      if (wait > 0) { timer = setTimeout(flush, wait); return; }
      var m = pending; pending = null; busy = true; lastAt = Date.now();
      ready.then(function (rr) {
        if (!rr || dead) return null;
        return seal(m).then(function (s) { return rr.set({ s: s }); });
      }).catch(function () {}).then(function () { busy = false; if (pending && !timer) flush(); });
    }
    return {
      send: function (m) { pending = m; if (!busy && !timer) flush(); },
      close: function () { dead = true; clearTimeout(timer); ready.then(function (rr) { if (rr) { try { rr.onDisconnect().cancel(); } catch (e) {} rr.remove().catch(function () {}); } }); }
    };
  }
  function listenRelay(role, cb) {
    var r = null, fns = [], stop = false;
    ref('relay/' + box(role)).then(function (rr) {
      if (stop || !rr) return;
      r = rr;
      var on = function (snap) {
        var v = snap.val();
        if (!v || typeof v.s !== 'string') return;
        unseal(v.s).then(function (m) { if (m && !stop) cb(snap.key, m); });
      };
      fns.push(['child_added', r.on('child_added', on)]);
      fns.push(['child_changed', r.on('child_changed', on)]);
    });
    return function () { stop = true; if (r) fns.forEach(function (f) { try { r.off(f[0], f[1]); } catch (e) {} }); };
  }

  // ---- WebRTC ---------------------------------------------------------------------------------
  function rtcOk() { return typeof RTCPeerConnection === 'function'; }
  // Non-trickle: wait (briefly) for candidates so one message carries the whole SDP.
  function gathered(pc, ms) {
    return new Promise(function (res) {
      if (pc.iceGatheringState === 'complete') { res(); return; }
      var t = setTimeout(done, ms || 1500);
      function done() { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', chk); res(); }
      function chk() { if (pc.iceGatheringState === 'complete') done(); }
      pc.addEventListener('icegatheringstatechange', chk);
    });
  }
  // Controller side: make an offer; returns {pc, dc, sdp promise}.
  function rtcOffer() {
    var pc = new RTCPeerConnection({ iceServers: ICE });
    var dc = pc.createDataChannel('rc', { ordered: false, maxRetransmits: 0 });
    var sdp = pc.createOffer().then(function (o) { return pc.setLocalDescription(o); })
      .then(function () { return gathered(pc, 1500); })
      .then(function () { return pc.localDescription.sdp; });
    return { pc: pc, dc: dc, sdp: sdp };
  }
  function rtcAccept(pc, sdp) { return pc.setRemoteDescription({ type: 'answer', sdp: sdp }); }
  // Receiver side: answer an offer; onChannel(dc) when the channel arrives.
  function rtcAnswer(offerSdp, onChannel) {
    var pc = new RTCPeerConnection({ iceServers: ICE });
    pc.ondatachannel = function (e) { onChannel(e.channel); };
    var sdp = pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
      .then(function () { return pc.createAnswer(); })
      .then(function (a) { return pc.setLocalDescription(a); })
      .then(function () { return gathered(pc, 1500); })
      .then(function () { return pc.localDescription.sdp; });
    return { pc: pc, sdp: sdp };
  }
  function closePc(pc, dc) {
    try { if (dc) dc.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
  }

  api.announce = announce; api.touch = touch; api.withdraw = withdraw; api.watchDevices = watchDevices;
  api.sendSig = sendSig; api.listenSig = listenSig; api.relayWriter = relayWriter; api.listenRelay = listenRelay;
  api.rtcOk = rtcOk; api.rtcOffer = rtcOffer; api.rtcAccept = rtcAccept; api.rtcAnswer = rtcAnswer; api.closePc = closePc;
  window.__cadeRemoteLink = api;
})(typeof self !== 'undefined' ? self : this);
