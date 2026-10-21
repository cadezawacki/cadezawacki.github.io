/* Beam — the transport between this account's own devices, shared by the Beam
 * widget (sending) and beam-recv.js (the always-ready receiver plugin). Needs
 * beam-core.js loaded first (frames, CRC, manifest, meter).
 *
 * How a beam travels:
 *   1. The sender pushes a sealed offer (manifest + a WebRTC offer) to the
 *      receiver's signalling box; the receiver accepts on its own (same Sync
 *      key = same owner), answers and starts listening on its relay path.
 *   2. Direct: an ordered, reliable data channel. Chunks are binary frames of
 *      min(64 KB, the peer's sctp.maxMessageSize); the sender pauses above
 *      DC_HIGH buffered and resumes on bufferedamountlow. After each file a
 *      'fin' carries its CRC32; the receiver checks size + CRC and acks
 *      progress every ACK_EVERY bytes.
 *   3. Via cloud: if no channel opens within DIRECT_WAIT (or it drops half
 *      way), the sender writes sealed chunks (base64 inside) under
 *      relay/<to>/<x>/<seq>, resuming from the last acked byte. The receiver
 *      deletes each node as it reads it and acks under relay/<to>/<x>/ack, so
 *      the sender keeps at most RELAY_WINDOW in flight. The whole transfer
 *      node goes on disconnect, and the relay refuses more than RELAY_MAX.
 *   4. The receiver answers 'done' (per-file ok) over the channel and the
 *      signalling box; the sender then cleans up.
 * Nothing is stored in the cloud beyond the in-flight window; nothing is added
 * to a note.
 *
 * Cloud layout (kind "bm", i.e. rooms/__cade_bm_<keyFp>/…):
 *   dev/<inst>                {s: sealed {n name, k kind, d deviceId, t since}, at}   ready receivers
 *   sig/<box>/<push>          {f: fromInst, s: sealed message, at}                     offer / answer / relay / cancel / done
 *   relay/<inst>/<x>/<seq>    {s: sealed {q, f, o, d base64} | {q, t:'fin', f, crc} | {q, t:'end'}}
 *   relay/<inst>/<x>/ack      {q, f, o, at}                                            receiver's progress
 * A receiver's box is its instance id, a sender's <inst>~s.
 *
 * Also here: the receiver's inbox (window.__cadeBeamInbox) — received files kept
 * as Blobs in this browser's own IndexedDB ('cade-beam') for 7 days — and a
 * shared screen wake lock held while any transfer runs. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Cade || window.__cadeBeamLink) return;
  var Cade = window.Cade, K = window.__cadeBeamCore;
  if (!K) { console.error('beam-link: beam-core.js must load first'); return; }
  var C = K.C, KIND = 'bm';
  var ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];

  // ---- cloud helpers --------------------------------------------------------------------------
  function ref(sub) { return Cade.cloud.ref(KIND, sub); }
  function seal(o) { return Cade.cloud.seal(o); }
  function unseal(s) { return Cade.cloud.unseal(s); }
  function me() { return Cade.cloud.device; }
  function box(role) { return me().inst + (role === 's' ? '~s' : ''); }
  function now() { return Date.now(); }

  // ---- presence (receivers) -------------------------------------------------------------------
  var presenceRef = null, since = 0;
  function announce() {
    var d = me();
    if (!since) since = now();
    return ref('dev/' + d.inst).then(function (r) {
      if (!r) return false;
      presenceRef = r;
      return seal({ n: d.name, k: d.kind, d: d.id, t: since, v: C.V }).then(function (s) {
        try { r.onDisconnect().remove(); } catch (e) {}
        return r.set({ s: s, at: Cade.cloud.TIMESTAMP });
      }).then(function () { return true; });
    }).catch(function () { return false; });
  }
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
  // Ready receivers on this account, newest first: cb([{inst, name, kind, did, at, since, self, sameDevice}]) or cb(null) without Sync.
  function watchDevices(cb) {
    var r = null, fn = null, gen = 0, stop = false;
    ref('dev').then(function (rr) {
      if (stop) return;
      if (!rr) { cb(null); return; }
      r = rr;
      fn = r.on('value', function (snap) {
        var v = snap.val() || {}, my = me(), g = ++gen, list = [];
        Promise.all(Object.keys(v).map(function (inst) {
          var e = v[inst];
          if (!e || typeof e.s !== 'string') return null;
          return unseal(e.s).then(function (o) {
            if (!o) return;
            list.push({ inst: inst, name: String(o.n || 'Device').slice(0, 40), kind: o.k === 'phone' || o.k === 'tablet' ? o.k : 'desktop', did: o.d || '',
              at: +e.at || 0, since: +o.t || 0, self: inst === my.inst, sameDevice: o.d === my.id });
          });
        })).then(function () {
          if (stop || g !== gen) return;
          var t = Cade.cloud.serverNow();
          list = list.filter(function (x) { return !x.at || t - x.at < C.ONLINE_FOR; });
          list.sort(function (a, b) { return (b.since || b.at) - (a.since || a.at); });
          cb(list);
        });
      });
    }).catch(function () { if (!stop) cb(null); });
    return function () { stop = true; if (r && fn) try { r.off('value', fn); } catch (e) {} };
  }

  // ---- signalling -----------------------------------------------------------------------------
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
        if (!v || typeof v.s !== 'string' || typeof v.f !== 'string') return;
        if (v.at && Cade.cloud.serverNow() - v.at > C.SIG_STALE) return;
        unseal(v.s).then(function (m) { if (m && !stop) cb(v.f, m); });
      });
    }).catch(function () {});
    return function () { stop = true; if (r && fn) try { r.off('child_added', fn); } catch (e) {} };
  }

  // ---- WebRTC (non-trickle, like Remote) --------------------------------------------------------
  function rtcOk() { return typeof RTCPeerConnection === 'function'; }
  function gathered(pc, ms) {
    return new Promise(function (res) {
      if (pc.iceGatheringState === 'complete') { res(); return; }
      var t = setTimeout(done, ms || 1500);
      function done() { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', chk); res(); }
      function chk() { if (pc.iceGatheringState === 'complete') done(); }
      pc.addEventListener('icegatheringstatechange', chk);
    });
  }
  function closePc(J) {
    try { if (J.dc) J.dc.close(); } catch (e) {}
    try { if (J.pc) J.pc.close(); } catch (e) {}
    J.dc = null; J.pc = null;
  }
  // Same network or not: look at the selected candidate pair.
  function detectNote(J, onDone) {
    var pc = J.pc;
    if (!pc || !pc.getStats) return;
    pc.getStats().then(function (st) {
      var pairId = '', pair = null, cands = {};
      st.forEach(function (r) {
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
        if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r;
      });
      st.forEach(function (r) {
        if (r.type !== 'candidate-pair') return;
        if (pairId ? r.id === pairId : (r.selected || (r.nominated && r.state === 'succeeded'))) pair = r;
      });
      if (!pair) return;
      var l = cands[pair.localCandidateId], rm = cands[pair.remoteCandidateId];
      J.note = K.pathNote(l && (l.candidateType || l.type), rm && (rm.candidateType || rm.type));
      if (onDone) onDone();
    }).catch(function () {});
  }

  // ---- reading the sender's files ----------------------------------------------------------------
  function readBlob(b) {
    if (b.arrayBuffer) return b.arrayBuffer();
    return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { rej(fr.error); }; fr.readAsArrayBuffer(b); });
  }
  // Bytes [o, o+len) of file f if the current read block has them, else null
  // (and the block gets loaded; the job's pump runs again when it's there).
  function bytesAt(J, f, o, len) {
    var b = J.blk;
    if (b && b.f === f && o >= b.o && o + len <= b.o + b.data.length) return b.data.subarray(o - b.o, o - b.o + len);
    if (J.reading) return null;
    J.reading = true;
    var end = Math.min(J.sizes[f], o + Math.max(len, C.READ_BLOCK));
    readBlob(J.blobs[f].slice(o, end)).then(function (ab) {
      J.reading = false;
      if (J.over) return;
      J.blk = { f: f, o: o, data: new Uint8Array(ab) };
      if (J.path === 'direct') pumpDc(J); else if (J.path === 'relay') pumpRelay(J);
    }, function () { J.reading = false; fail(J, 'Could not read ' + J.man.files[f].n); });
    return null;
  }

  // ---- shared screen wake lock -------------------------------------------------------------------
  var wakeN = 0, wakeL = null, wakeAsk = false, wakeVis = false;
  function wake(d) {
    wakeN = Math.max(0, wakeN + d);
    if (wakeN && !wakeVis) { document.addEventListener('visibilitychange', wakeSync); wakeVis = true; }
    else if (!wakeN && wakeVis) { document.removeEventListener('visibilitychange', wakeSync); wakeVis = false; }
    wakeSync();
  }
  function wakeSync() {
    if (wakeN && !wakeL && !wakeAsk && navigator.wakeLock && document.visibilityState === 'visible') {
      wakeAsk = true;
      navigator.wakeLock.request('screen').then(function (w) {
        wakeAsk = false;
        if (!wakeN) { w.release(); return; }
        wakeL = w;
        w.addEventListener('release', function () { if (wakeL === w) wakeL = null; });
      }, function () { wakeAsk = false; });
    } else if (!wakeN && wakeL) { try { wakeL.release(); } catch (e) {} wakeL = null; }
  }

  // ---- jobs ------------------------------------------------------------------------------------------
  var outJobs = {}, inJobs = {}, stopSigS = null;
  var jobFns = [];
  function emit(J) {
    try { if (J.hooks.onUpdate) J.hooks.onUpdate(J); } catch (e) { console.error(e); }
    for (var i = 0; i < jobFns.length; i++) { try { jobFns[i](J); } catch (e) { console.error(e); } }
  }
  // fn(job) on every update of any transfer (≤ 4/s each); returns an unsubscribe.
  function onJobs(fn) { jobFns.push(fn); return function () { jobFns = jobFns.filter(function (f) { return f !== fn; }); }; }
  function progress(J) { J.prog = J.meter.update(J.done, now()); return J.prog; }
  function label(J) { return K.pathLabel(J.path, J.note); }

  // ===== sending =====================================================================================
  // files: [{ blob, name, mime }]; dev: { inst, name }; hooks: { onUpdate(job) }.
  function send(dev, files, hooks) {
    var x = K.rid(12);
    var man = K.makeManifest(x, files.map(function (f) { return { name: f.name, size: f.blob.size, type: f.mime || f.blob.type }; }));
    var J = {
      dir: 'out', x: x, to: dev.inst, peer: dev.name || 'Device', man: man, sizes: man.files.map(function (f) { return f.s; }),
      blobs: files.map(function (f) { return f.blob; }), hooks: hooks || {},
      state: 'connecting', path: 'connecting', note: '', err: '', over: false, answered: false,
      done: 0, sentPos: 0, ack: { f: 0, o: 0 }, ackBytes: 0, crc: man.files.map(function () { return { pos: 0, crc: 0 }; }),
      cur: null, pend: null, blk: null, reading: false, ended: false, msg: C.DC_MSG,
      pc: null, dc: null, rref: null, ackFn: null, rq: 0, inflight: [], t0: now(), lastProg: now(), offerAt: 0, timers: []
    };
    J.meter = K.meter(man.total);
    J.cancel = function () { cancelOut(J, ''); };
    J.label = function () { return label(J); };
    outJobs[x] = J;
    if (!stopSigS) stopSigS = listenSig('s', onSigS);
    wake(1);
    J.tick = setInterval(function () { tickOut(J); }, 250);
    if (rtcOk()) {
      try {
        J.pc = new RTCPeerConnection({ iceServers: ICE });
        J.dc = J.pc.createDataChannel('bm', { ordered: true });
        bindOutDc(J, J.dc);
        J.pc.oniceconnectionstatechange = function () { if (J.pc && J.pc.iceConnectionState === 'failed' && !J.over && J.path !== 'relay') goRelay(J); };
        J.pc.createOffer().then(function (o) { return J.pc.setLocalDescription(o); })
          .then(function () { return gathered(J.pc, 1500); })
          .then(function () { offer(J, J.pc ? J.pc.localDescription.sdp : ''); }, function () { closePc(J); offer(J, ''); });
      } catch (e) { closePc(J); offer(J, ''); }
    } else offer(J, '');
    emit(J);
    return J;
  }
  function offer(J, sdp) {
    if (J.over) return;
    var d = me();
    J.offerAt = now();
    sendSig(J.to, { t: 'offer', x: J.x, m: J.man, sdp: sdp || '', n: d.name, k: d.kind }).catch(function () { fail(J, 'Couldn’t reach the cloud (offline?)'); });
  }
  function bindOutDc(J, dc) {
    dc.binaryType = 'arraybuffer';
    try { dc.bufferedAmountLowThreshold = C.DC_LOW; } catch (e) {}
    dc.onopen = function () {
      if (J.over || J.dc !== dc || J.path === 'relay') return;
      J.path = 'direct'; J.state = 'sending'; J.lastProg = now();
      J.msg = K.msgSize(J.pc && J.pc.sctp && J.pc.sctp.maxMessageSize);
      J.cur = K.cursor(J.sizes, J.ack.f, J.ack.o); J.pend = null;
      detectNote(J, function () { emit(J); });
      emit(J);
      pumpDc(J);
    };
    dc.onbufferedamountlow = function () { pumpDc(J); };
    dc.onmessage = function (e) { if (typeof e.data === 'string') { var m; try { m = JSON.parse(e.data); } catch (x) { return; } onPeerOut(J, m); } };
    dc.onclose = dc.onerror = function () {
      if (J.over || J.dc !== dc) return;
      J.dc = null;
      // all of it confirmed: the 'done' also comes by signalling; else resume the rest via the cloud
      if (J.ended && J.ackBytes >= J.man.total) return;
      if (J.path !== 'relay') goRelay(J);
    };
  }
  function pumpDc(J) {
    var dc = J.dc;
    if (J.over || J.path !== 'direct' || J.ended || !dc || dc.readyState !== 'open') return;
    try {
      while (dc.bufferedAmount < C.DC_HIGH) {
        var st = J.pend || (J.pend = J.cur.next(J.msg - C.HDR));
        if (st.k === 'chunk') {
          var data = bytesAt(J, st.f, st.o, st.len);
          if (!data) return;
          K.crcAdvance(J.crc[st.f], st.o, data);
          dc.send(K.encodeFrame(st.f, st.o, data));
          J.sentPos = K.offsetOf(J.sizes, st.f, st.o + st.len);
        } else if (st.k === 'fin') {
          dc.send(JSON.stringify({ t: 'fin', f: st.f, crc: J.crc[st.f].crc }));
        } else {
          dc.send(JSON.stringify({ t: 'end' }));
          J.ended = true; J.pend = null; J.state = 'verifying'; emit(J);
          return;
        }
        J.pend = null;
      }
    } catch (e) { if (!J.over) goRelay(J); }
  }
  // No direct channel (or it dropped): carry on through the cloud from the last acked byte.
  function goRelay(J) {
    if (J.over || J.path === 'relay') return;
    var rest = J.man.total - J.ackBytes;
    if (rest > C.RELAY_MAX) {
      fail(J, 'No direct connection to ' + J.peer + ', and the cloud relay carries at most ' + K.fmtBytes(C.RELAY_MAX) + ' (' + K.fmtBytes(rest) + ' to go). Put both devices on the same Wi-Fi and try again.');
      return;
    }
    closePc(J);
    J.path = 'relay'; J.note = ''; J.state = 'sending'; J.ended = false; J.pend = null; J.lastProg = now();
    J.cur = K.cursor(J.sizes, J.ack.f, J.ack.o);
    J.done = J.ackBytes;
    sendSig(J.to, { t: 'relay', x: J.x, f: J.ack.f, o: J.ack.o }).catch(function () {});
    ref('relay/' + J.to + '/' + J.x).then(function (r) {
      if (J.over || !r) { if (!r) fail(J, 'Sync is not set up'); return; }
      J.rref = r;
      try { r.onDisconnect().remove(); } catch (e) {}
      var a = r.child('ack');
      J.ackRef = a;
      J.ackFn = a.on('value', function (snap) { onRelayAck(J, snap.val()); });
      pumpRelay(J);
    }, function () { fail(J, 'Couldn’t reach the cloud (offline?)'); });
    emit(J);
  }
  function inflight(J) { var n = 0; for (var i = 0; i < J.inflight.length; i++) n += J.inflight[i].n; return n; }
  function pumpRelay(J) {
    if (J.over || J.path !== 'relay' || !J.rref || J.ended) return;
    while (inflight(J) < C.RELAY_WINDOW) {
      var st = J.pend || (J.pend = J.cur.next(C.RELAY_CHUNK)), fr, n = 0;
      if (st.k === 'chunk') {
        var data = bytesAt(J, st.f, st.o, st.len);
        if (!data) return;
        K.crcAdvance(J.crc[st.f], st.o, data);
        fr = { f: st.f, o: st.o, d: K.b64enc(data) }; n = st.len;
      } else if (st.k === 'fin') fr = { t: 'fin', f: st.f, crc: J.crc[st.f].crc };
      else { fr = { t: 'end' }; J.ended = true; J.state = 'verifying'; }
      J.pend = null;
      fr.q = J.rq++;
      J.inflight.push({ q: fr.q, n: Math.max(n, 1) });
      writeRelay(J, fr);
      if (J.ended) { emit(J); return; }
    }
  }
  function writeRelay(J, fr) {
    seal(fr).then(function (s) {
      if (J.over || !J.rref) return null;
      return J.rref.child(String(fr.q)).set({ s: s });
    }).catch(function () { fail(J, 'Cloud relay write failed (offline?)'); });
  }
  function onRelayAck(J, v) {
    if (J.over || !v || typeof v.q !== 'number') return;
    J.inflight = J.inflight.filter(function (e) { return e.q > v.q; });
    if (typeof v.f === 'number' && typeof v.o === 'number') {
      var b = K.offsetOf(J.sizes, v.f, v.o);
      if (b > J.ackBytes) { J.ackBytes = b; J.ack = { f: v.f, o: v.o }; }
    }
    J.lastProg = now();
    pumpRelay(J);
  }
  function onSigS(from, m) {
    var J = m && outJobs[m.x];
    if (!J || from !== J.to) return;
    onPeerOut(J, m);
  }
  // Messages from the receiver (channel or signalling).
  function onPeerOut(J, m) {
    if (J.over) return;
    if (m.t === 'answer') {
      if (J.answered) return;
      J.answered = true; J.lastProg = now();
      if (J.pc && m.sdp) {
        J.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(function () { goRelay(J); });
        var wait = Math.max(3000, C.DIRECT_WAIT - (now() - J.offerAt));
        J.timers.push(setTimeout(function () { if (!J.over && J.path === 'connecting') goRelay(J); }, wait));
      } else goRelay(J);
      emit(J);
    } else if (m.t === 'ack') {
      if (typeof m.f === 'number' && typeof m.o === 'number') {
        var b = K.offsetOf(J.sizes, m.f, m.o);
        if (b > J.ackBytes) { J.ackBytes = b; J.ack = { f: m.f, o: m.o }; }
      }
      J.lastProg = now();
    } else if (m.t === 'done') {
      var ok = Array.isArray(m.ok) && m.ok.length === J.man.files.length && m.ok.every(Boolean);
      J.fileOk = Array.isArray(m.ok) ? m.ok : [];
      J.done = J.man.total;
      finishOut(J, ok ? 'done' : 'error', ok ? '' : (m.err || 'Some files arrived damaged — try again'));
    } else if (m.t === 'cancel') {
      finishOut(J, 'cancelled', m.why || ('Cancelled on ' + J.peer));
    }
  }
  function tickOut(J) {
    if (J.over) return;
    var t = now();
    if (J.path === 'direct' && J.dc) J.done = Math.max(J.ackBytes, Math.min(J.sentPos, J.sentPos - (J.dc.bufferedAmount || 0)));
    else if (J.path === 'relay') J.done = J.ackBytes;
    if (J.done !== J.lastDone) { J.lastDone = J.done; J.lastProg = t; }
    if (!J.answered && J.offerAt && t - J.offerAt > C.ANSWER_WAIT) { fail(J, 'No answer from ' + J.peer + ' — is txt open and on screen there?'); return; }
    // a direct channel can hang without closing (Wi-Fi switch, sleep): try the cloud for the rest
    if (J.path === 'direct' && !J.ended && t - J.lastProg > C.DIRECT_STALL) { goRelay(J); return; }
    if (J.answered && t - J.lastProg > C.STALL) { fail(J, 'Connection to ' + J.peer + ' lost'); return; }
    progress(J);
    emit(J);
  }
  function cancelOut(J, why) {
    if (J.over) return;
    try { if (J.dc && J.dc.readyState === 'open') J.dc.send(JSON.stringify({ t: 'cancel' })); } catch (e) {}
    sendSig(J.to, { t: 'cancel', x: J.x }).catch(function () {});
    finishOut(J, 'cancelled', why || 'Cancelled');
  }
  function fail(J, msg) {
    if (J.over) return;
    if (J.dir === 'in') { failIn(J, msg); return; }
    sendSig(J.to, { t: 'cancel', x: J.x, why: msg }).catch(function () {});
    finishOut(J, 'error', msg);
  }
  function finishOut(J, state, msg) {
    if (J.over) return;
    J.over = true; J.state = state; J.err = msg || '';
    clearInterval(J.tick);
    J.timers.forEach(clearTimeout);
    closePc(J);
    if (J.ackRef && J.ackFn) try { J.ackRef.off('value', J.ackFn); } catch (e) {}
    if (J.rref) { var r = J.rref; try { r.onDisconnect().cancel(); } catch (e) {} r.remove().catch(function () {}); J.rref = null; }
    J.blk = null; J.blobs = null;
    delete outJobs[J.x];
    if (!Object.keys(outJobs).length && stopSigS) { stopSigS(); stopSigS = null; }
    wake(-1);
    progress(J);
    emit(J);
  }

  // ===== receiving ===================================================================================
  // An offer from `from` (already unsealed). hooks: { onUpdate(job), onFile(job, i), onEnd(job) }.
  function receive(from, msg, hooks) {
    var man = K.validManifest(msg && msg.m);
    if (!man || typeof from !== 'string') return null;
    if (inJobs[man.x]) return inJobs[man.x];
    var J = {
      dir: 'in', x: man.x, from: from, rb: from + '~s', peer: String(msg.n || 'Device').slice(0, 40), peerKind: msg.k, man: man,
      sizes: man.files.map(function (f) { return f.s; }), hooks: hooks || {},
      files: man.files.map(function (f) { return { n: f.n, s: f.s, t: f.t, got: 0, crc: 0, parts: [], partBytes: 0, blobs: [], ok: null, blob: null, err: '' }; }),
      state: 'receiving', path: 'connecting', note: '', err: '', over: false, done: 0, lastAckAt: 0,
      pc: null, dc: null, rref: null, rfn: null, rq: 0, rbuf: {}, rAckT: 0, t0: now(), lastProg: now(), timers: []
    };
    J.meter = K.meter(man.total);
    J.cancel = function () { cancelIn(J); };
    J.label = function () { return label(J); };
    inJobs[J.x] = J;
    wake(1);
    J.tick = setInterval(function () { tickIn(J); }, 250);
    listenRelayIn(J);
    if (msg.sdp && rtcOk()) {
      try {
        J.pc = new RTCPeerConnection({ iceServers: ICE });
        J.pc.ondatachannel = function (e) { bindInDc(J, e.channel); };
        J.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
          .then(function () { return J.pc.createAnswer(); })
          .then(function (a) { return J.pc.setLocalDescription(a); })
          .then(function () { return gathered(J.pc, 1500); })
          .then(function () { answer(J, J.pc ? J.pc.localDescription.sdp : ''); }, function () { closePc(J); answer(J, ''); });
      } catch (e) { closePc(J); answer(J, ''); }
    } else answer(J, '');
    emit(J);
    return J;
  }
  function answer(J, sdp) { if (!J.over) sendSig(J.rb, { t: 'answer', x: J.x, sdp: sdp || '' }).catch(function () {}); }
  function bindInDc(J, dc) {
    J.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = function () { if (J.over) return; J.path = 'direct'; J.lastProg = now(); detectNote(J, function () { emit(J); }); emit(J); };
    dc.onmessage = function (e) {
      if (J.over) return;
      if (typeof e.data === 'string') { var m; try { m = JSON.parse(e.data); } catch (x) { return; } onCtl(J, m); return; }
      var fr = K.decodeFrame(e.data);
      if (fr) onChunk(J, fr.f, fr.o, fr.data);
    };
    dc.onclose = function () { if (J.dc === dc) { J.dc = null; if (!J.over && J.path === 'direct') { J.path = 'connecting'; emit(J); } } };
  }
  function onCtl(J, m) {
    if (m.t === 'fin') onFin(J, m.f, m.crc);
    else if (m.t === 'end') onEnd(J);
    else if (m.t === 'cancel') finishIn(J, 'cancelled', m.why || ('Cancelled on ' + J.peer));
  }
  function onChunk(J, f, o, data) {
    var F = J.files[f];
    if (!F || F.ok !== null) return;
    var ov = K.overlap(F.got, o, data.length);
    if (ov.gap) { failIn(J, 'Data arrived out of order — try again'); return; }
    if (ov.take < 0) return;
    var b = ov.take ? data.subarray(ov.take) : data;
    F.crc = K.crc32(b, F.crc);
    F.got += b.length; J.done += b.length; J.lastProg = now();
    F.parts.push(b); F.partBytes += b.length;
    // fold parts into a Blob now and then: big Blobs can live on disk, arrays can't
    if (F.partBytes >= 8 * 1024 * 1024) { F.blobs.push(new Blob(F.parts)); F.parts = []; F.partBytes = 0; }
    if (J.done - J.lastAckAt >= C.ACK_EVERY) ackDc(J, f, F.got);
  }
  function ackDc(J, f, o) {
    J.lastAckAt = J.done;
    try { if (J.dc && J.dc.readyState === 'open') J.dc.send(JSON.stringify({ t: 'ack', f: f, o: o })); } catch (e) {}
  }
  function onFin(J, f, crc) {
    var F = J.files[f];
    if (!F || F.ok !== null || typeof crc !== 'number') return;
    F.ok = F.got === F.s && (F.crc >>> 0) === (crc >>> 0);
    if (F.ok) {
      F.blob = new Blob(F.blobs.concat(F.parts), { type: F.t || 'application/octet-stream' });
      try { if (J.hooks.onFile) J.hooks.onFile(J, f); } catch (e) { console.error(e); }
    } else F.err = F.got !== F.s ? 'incomplete' : 'damaged (checksum mismatch)';
    F.parts = []; F.blobs = []; F.partBytes = 0;
    ackDc(J, f + 1 < J.files.length ? f + 1 : f, f + 1 < J.files.length ? 0 : F.got);
    emit(J);
  }
  function onEnd(J) {
    var ok = J.files.map(function (F) { return F.ok === true; });
    J.files.forEach(function (F) { if (F.ok === null) { F.ok = false; F.err = 'missing'; } });
    var all = ok.every(Boolean);
    var m = { t: 'done', x: J.x, ok: ok };
    if (!all) m.err = 'Some files arrived damaged — try again';
    try { if (J.dc && J.dc.readyState === 'open') J.dc.send(JSON.stringify(m)); } catch (e) {}
    sendSig(J.rb, m).catch(function () {});
    finishIn(J, all ? 'done' : 'error', all ? '' : m.err);
  }
  function listenRelayIn(J) {
    ref('relay/' + box('r') + '/' + J.x).then(function (r) {
      if (!r || J.over) return;
      J.rref = r;
      try { r.child('ack').onDisconnect().remove(); } catch (e) {}
      J.rfn = r.on('child_added', function (snap) {
        if (snap.key === 'ack') return;
        var v = snap.val();
        try { snap.ref.remove(); } catch (e) {}
        if (!v || typeof v.s !== 'string') return;
        unseal(v.s).then(function (fr) { if (fr && !J.over) onRelayFrame(J, fr); });
      });
    }).catch(function () {});
  }
  function onRelayFrame(J, fr) {
    if (typeof fr.q !== 'number' || fr.q < J.rq) return;
    J.rbuf[fr.q] = fr;
    if (!J.dc || J.dc.readyState !== 'open') { if (J.path !== 'relay') { J.path = 'relay'; J.note = ''; emit(J); } }
    while (J.rbuf[J.rq]) {
      var f = J.rbuf[J.rq];
      delete J.rbuf[J.rq];
      J.rq++;
      J.lastProg = now();
      if (f.t === 'fin') onFin(J, f.f, f.crc);
      else if (f.t === 'end') { ackRelay(J, true); onEnd(J); return; }
      else if (typeof f.d === 'string' && typeof f.f === 'number' && typeof f.o === 'number') { var d; try { d = K.b64dec(f.d); } catch (e) { failIn(J, 'Damaged relay data'); return; } onChunk(J, f.f, f.o, d); }
      if (J.over) return;
    }
    ackRelay(J, false);
  }
  // Tell the sender how far we are (throttled): frees its in-flight window.
  function ackRelay(J, now_) {
    if (J.rAckT && !now_) return;
    var write = function () {
      J.rAckT = 0;
      if (!J.rref) return;
      var f = 0;
      while (f < J.files.length - 1 && J.files[f].ok !== null) f++;
      J.rref.child('ack').set({ q: J.rq - 1, f: f, o: J.files[f].ok !== null ? J.files[f].s : J.files[f].got, at: Cade.cloud.TIMESTAMP }).catch(function () {});
    };
    if (now_) { clearTimeout(J.rAckT); write(); } else J.rAckT = setTimeout(write, 120);
  }
  function tickIn(J) {
    if (J.over) return;
    if (now() - J.lastProg > C.STALL) { failIn(J, 'Connection to ' + J.peer + ' lost'); return; }
    progress(J);
    emit(J);
  }
  function onSigR(from, m) {
    var J = m && inJobs[m.x];
    if (!J || from !== J.from) return;
    if (m.t === 'relay') { if (J.pc) closePc(J); J.lastProg = now(); if (J.path !== 'relay') { J.path = 'relay'; J.note = ''; emit(J); } }
    else if (m.t === 'cancel') finishIn(J, 'cancelled', m.why || ('Cancelled on ' + J.peer));
  }
  function cancelIn(J, why) {
    if (J.over) return;
    try { if (J.dc && J.dc.readyState === 'open') J.dc.send(JSON.stringify({ t: 'cancel' })); } catch (e) {}
    sendSig(J.rb, { t: 'cancel', x: J.x, why: why || ('Cancelled on ' + me().name) }).catch(function () {});
    finishIn(J, 'cancelled', 'Cancelled');
  }
  function failIn(J, msg) {
    if (J.over) return;
    sendSig(J.rb, { t: 'cancel', x: J.x, why: msg }).catch(function () {});
    finishIn(J, 'error', msg);
  }
  function finishIn(J, state, msg) {
    if (J.over) return;
    J.over = true; J.state = state; J.err = msg || '';
    clearInterval(J.tick); clearTimeout(J.rAckT);
    J.timers.forEach(clearTimeout);
    if (J.rref) {
      var r = J.rref;
      if (J.rfn) try { r.off('child_added', J.rfn); } catch (e) {}
      try { r.child('ack').onDisconnect().cancel(); } catch (e) {}
      r.child('ack').remove().catch(function () {});
      J.rref = null;
    }
    J.rbuf = {};
    J.files.forEach(function (F) { if (!F.ok) { F.parts = []; F.blobs = []; } });
    // let a final message on the channel go out before closing it
    if (J.dc && J.dc.readyState === 'open' && state === 'done') { var j = J; setTimeout(function () { closePc(j); }, 1200); }
    else closePc(J);
    delete inJobs[J.x];
    wake(-1);
    if (state === 'done') J.done = J.man.total;
    progress(J);
    emit(J);
    try { if (J.hooks.onEnd) J.hooks.onEnd(J); } catch (e) { console.error(e); }
  }
  // Everything off (the receiver plugin turned off, the widget closed).
  function endAll(dir, why) {
    var jobs = dir === 'in' ? inJobs : outJobs;
    Object.keys(jobs).forEach(function (x) { if (dir === 'in') cancelIn(jobs[x], why); else cancelOut(jobs[x], why); });
  }
  function active(dir) { var jobs = dir === 'in' ? inJobs : outJobs; return Object.keys(jobs).map(function (x) { return jobs[x]; }); }

  // ===== inbox (received files, this browser only) ====================================================
  var DB = 'cade-beam', STORE = 'inbox', dbP = null, mem = null, inboxFns = [], bc = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (res, rej) {
      if (typeof indexedDB === 'undefined') { rej(new Error('no IndexedDB')); return; }
      var rq;
      try { rq = indexedDB.open(DB, 1); } catch (e) { rej(e); return; }
      rq.onupgradeneeded = function () { if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE, { keyPath: 'id' }); };
      rq.onsuccess = function () { var d = rq.result; d.onversionchange = function () { d.close(); dbP = null; }; res(d); };
      rq.onerror = function () { rej(rq.error); };
      rq.onblocked = function () { rej(new Error('blocked')); };
    });
    dbP.catch(function () { dbP = null; if (!mem) mem = {}; });
    return dbP;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(STORE, mode), st = t.objectStore(STORE), out;
        out = fn(st);
        t.oncomplete = function () { res(out && 'result' in out ? out.result : undefined); };
        t.onerror = t.onabort = function () { rej(t.error || new Error('idb')); };
      });
    });
  }
  function memList() { return Object.keys(mem || {}).map(function (k) { return mem[k]; }); }
  function changed(remote) {
    inboxFns.slice().forEach(function (fn) { try { fn(); } catch (e) {} });
    if (!remote && bc) try { bc.postMessage('changed'); } catch (e) {}
  }
  var inbox = {
    // All kept files, newest first (expired ones are deleted on the way).
    list: function () {
      return tx('readonly', function (st) { return st.getAll(); }).catch(function () { return []; }).then(function (rows) {
        rows = (rows || []).concat(memList());
        var drop = K.prune(rows, now());
        if (drop.length) inbox.remove(drop, true);
        return rows.filter(function (r) { return drop.indexOf(r.id) < 0; }).sort(function (a, b) { return b.at - a.at; });
      });
    },
    get: function (id) {
      if (mem && mem[id]) return Promise.resolve(mem[id]);
      return tx('readonly', function (st) { return st.get(id); }).catch(function () { return null; });
    },
    // rec: { name, mime, size, blob, from, via } → id
    add: function (rec) {
      var r = { id: K.rid(14), name: K.safeName(rec.name), mime: K.safeMime(rec.mime), size: rec.blob ? rec.blob.size : (rec.size || 0), blob: rec.blob, from: String(rec.from || '').slice(0, 40), via: rec.via || '', at: now() };
      return tx('readwrite', function (st) { st.put(r); }).catch(function () { (mem || (mem = {}))[r.id] = r; r.mem = true; })
        .then(function () { changed(); return r.id; });
    },
    remove: function (ids, quiet) {
      ids = Array.isArray(ids) ? ids : [ids];
      ids.forEach(function (id) { if (mem) delete mem[id]; });
      return tx('readwrite', function (st) { ids.forEach(function (id) { st.delete(id); }); }).catch(function () {})
        .then(function () { if (!quiet) changed(); });
    },
    // fn() after any change (here or in another tab); returns an unsubscribe.
    onchange: function (fn) {
      inboxFns.push(fn);
      if (!bc && typeof BroadcastChannel === 'function') { try { bc = new BroadcastChannel('cade-beam-inbox'); bc.onmessage = function () { changed(true); }; } catch (e) { bc = null; } }
      return function () {
        inboxFns = inboxFns.filter(function (f) { return f !== fn; });
        if (!inboxFns.length && bc) { try { bc.close(); } catch (e) {} bc = null; }
      };
    }
  };

  window.__cadeBeamLink = {
    announce: announce, touch: touch, withdraw: withdraw, watchDevices: watchDevices,
    sendSig: sendSig, listenSig: listenSig, onSigR: onSigR, rtcOk: rtcOk,
    send: send, receive: receive, endAll: endAll, active: active, onJobs: onJobs, wake: wake, inbox: inbox
  };
  if (!window.__cadeBeamInbox) window.__cadeBeamInbox = inbox;
})();
