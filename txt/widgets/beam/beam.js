/* Beam — send files straight between your own devices.
 *
 * Send: every open, on-screen copy of the app on your account with "Receive
 * files from my other devices" on (beam-recv.js) shows up. Pick one or more,
 * pick files (Choose files, This note, drag-and-drop, paste an image) and
 * Send: each device gets its own transfer with progress, speed, how it travels
 * ("direct · Wi-Fi" over WebRTC, else "via cloud · slower") and Cancel. No size
 * limit on the direct path, nothing kept in the cloud, nothing added to a note
 * (that's what Upload File is for). See beam-link.js for the protocol.
 *
 * QR stream: hands the file to beam-qr.js (loaded only when the tab opens),
 * which streams it as animated QR codes to a camera — no network or Sync.
 *
 * Inbox: what this browser received (beam-recv.js keeps it 7 days).
 *
 * File pills: "📡 Beam to another device" / "▦ Send as a QR stream" in a pill's
 * menu run this widget with the file handed over (Cade.files.take).
 *
 * Everything the panel starts — the device watch, listeners, object URLs, the
 * QR stream (camera), outgoing transfers — stops when it closes. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Cade) return;
  var Cade = window.Cade;
  var BASE = Cade.baseURL();
  Cade.loadCSS('beam.css');
  var PANEL_ID = 'beam-panel', PREFS_KEY = 'cade-beam-prefs';
  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };

  var loads = {};
  function load(url) {
    if (loads[url]) return loads[url];
    return (loads[url] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = function () { res(); };
      s.onerror = function () { delete loads[url]; rej(new Error('Beam failed to load (offline?)')); };
      document.head.appendChild(s);
    }));
  }
  function loadLink() {
    if (window.__cadeBeamLink) return Promise.resolve(window.__cadeBeamLink);
    return (window.__cadeBeamCore ? Promise.resolve() : load(BASE + 'beam-core.js')).then(function () { return load(BASE + 'beam-link.js'); })
      .then(function () { if (!window.__cadeBeamLink) throw new Error('Beam failed to start'); return window.__cadeBeamLink; });
  }

  var prefs = { tab: 'send', qr: 'send', lastDid: '' };
  function loadPrefs() { try { var p = JSON.parse(Cade.store.get(PREFS_KEY) || 'null'); if (p) for (var k in prefs) if (k in p) prefs[k] = p[k]; } catch (e) {} }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }

  var P = null, L = null, K = null, el = {};
  var devices = null, devErr = false, selected = {}, stopDevs = null;
  var picked = [];          // [{ id, blob, name, mime }]
  var jobs = [];            // [{ J, dev, files, el }]
  var qr = { h: null, hFile: null, file: null, loading: false, gen: 0 };
  var inboxRows = [], inboxUrls = [], stopInbox = null, stopJobs = null, liveRows = {}, clearArm = 0;
  var seq = 0, pendingHandoff = null;

  // ---- markup -----------------------------------------------------------------------------------------
  function bodyHtml() {
    return '<div class="beam" tabindex="-1">' +
      '<div class="beam-tabs" role="tablist">' +
        '<button type="button" role="tab" data-tab="send">Send</button>' +
        '<button type="button" role="tab" data-tab="qr">QR stream</button>' +
        '<button type="button" role="tab" data-tab="inbox">Inbox<span class="beam-badge" hidden></span></button>' +
      '</div>' +
      '<div class="beam-pane" data-pane="send">' +
        '<div class="beam-nosync" hidden>' +
          '<p class="beam-note"><b>Beam finds your other devices through Sync.</b> Set up Sync (the same database and key) on each device, then open the app there — files then go straight across, nothing stored in the cloud.</p>' +
          '<p class="beam-note">No account? The <b>QR stream</b> sends a file from screen to camera with no network at all.</p>' +
          '<button type="button" class="beam-btn" data-act="to-qr">▦ Open the QR stream</button>' +
        '</div>' +
        '<div class="beam-sync">' +
          '<div class="beam-h">To</div>' +
          '<div class="beam-devs"><p class="beam-note">Looking for your devices…</p></div>' +
          '<div class="beam-me"><label>This device <input type="text" class="beam-name" maxlength="40" aria-label="This device’s name" enterkeyhint="done"></label><small class="beam-me-st"></small></div>' +
          '<div class="beam-h">Files</div>' +
          '<div class="beam-drop" tabindex="0" aria-label="Files to send — drop or paste here">' +
            '<div class="beam-pick">' +
              '<button type="button" class="beam-btn" data-act="choose">📎 Choose files</button>' +
              '<button type="button" class="beam-btn" data-act="note">📝 This note</button>' +
              '<button type="button" class="beam-btn" data-act="paste">📋 Paste</button>' +
            '</div>' +
            '<div class="beam-hint">or drop files here · paste an image</div>' +
            '<ul class="beam-picked"></ul>' +
          '</div>' +
          '<input type="file" class="beam-file" multiple tabindex="-1" aria-hidden="true">' +
          '<button type="button" class="beam-go" data-act="send" disabled>Send</button>' +
          '<div class="beam-jobs"></div>' +
        '</div>' +
      '</div>' +
      '<div class="beam-pane" data-pane="qr">' +
        '<div class="beam-seg" role="group" aria-label="QR stream direction"><button type="button" data-qr="send">Send</button><button type="button" data-qr="receive">Receive</button></div>' +
        '<div class="beam-qr-file">' +
          '<span class="beam-qr-fn">No file chosen</span>' +
          '<button type="button" class="beam-btn" data-act="qr-choose">📎 Choose</button>' +
          '<button type="button" class="beam-btn" data-act="qr-note">📝 This note</button>' +
          '<input type="file" class="beam-qr-input" tabindex="-1" aria-hidden="true">' +
        '</div>' +
        '<div class="beam-qr-host"></div>' +
      '</div>' +
      '<div class="beam-pane" data-pane="inbox">' +
        '<div class="beam-in-live"></div>' +
        '<div class="beam-in-head"><span class="beam-in-sum">…</span><button type="button" class="beam-btn beam-sm" data-act="clear" hidden>Clear all</button></div>' +
        '<ul class="beam-in-list"></ul>' +
      '</div>' +
    '</div>';
  }
  function q(s) { return P.querySelector(s); }

  // ---- tabs --------------------------------------------------------------------------------------------------
  function setTab(t) {
    if (['send', 'qr', 'inbox'].indexOf(t) < 0) t = 'send';
    var was = P.getAttribute('data-tab');
    prefs.tab = t; savePrefs();
    P.setAttribute('data-tab', t);
    P.querySelectorAll('[data-tab]').forEach(function (b) { var on = b.getAttribute('data-tab') === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    // the QR stream stays mounted (its progress survives a look at the Inbox), just paused
    if (t === 'qr') { if (qr.h) { if (was !== 'qr') resumeQr(); } else mountQr(); }
    else if (was === 'qr') pauseQr();
    if (t === 'inbox') renderInbox();
  }

  // ---- Send: devices -------------------------------------------------------------------------------------------
  function paintSync() {
    var on = Cade.cloud.configured();
    el.nosync.hidden = on;
    el.sync.hidden = !on;
    el.name.value = Cade.cloud.device.name;
    var rs = window.__cadeBeamRecv ? window.__cadeBeamRecv.status() : null;
    el.meSt.textContent = !rs ? 'Can’t receive here — turn on “Receive files from my other devices” in Settings.'
      : !rs.enabled ? 'Can’t receive here — turn on “Receive files from my other devices” in Settings.'
      : rs.online ? 'Ready to receive from your other devices.' : rs.configured ? 'Going online…' : 'Needs Sync to receive.';
  }
  function onDevices(list) {
    devErr = list === null;              // no cloud ref: Sync set up but unreachable
    devices = list || [];
    if (!P) return;
    var others = (list || []).filter(function (d) { return !d.self; });
    // keep the selection to devices that are still here; first time: the one used last, or the only one
    var still = {};
    others.forEach(function (d) { if (selected[d.inst]) still[d.inst] = 1; });
    selected = still;
    if (!Object.keys(selected).length && !P.__autoSel && others.length) {
      var last = others.filter(function (d) { return d.did === prefs.lastDid && !d.sameDevice; })[0] || (others.length === 1 ? others[0] : null);
      if (last) { selected[last.inst] = 1; P.__autoSel = true; }
    }
    renderDevices();
    paintGo();
  }
  function renderDevices() {
    var box = el.devs;
    if (devices === null) { box.innerHTML = '<p class="beam-note">Looking for your devices…</p>'; return; }
    var others = devices.filter(function (d) { return !d.self; });
    if (devErr) { box.innerHTML = '<p class="beam-note">Couldn’t reach your Sync database — check Sync in Settings, or use the QR stream.</p>'; return; }
    if (!others.length) {
      box.innerHTML = '<p class="beam-note">No other device is ready. Open the app on the device you want to send to (on screen), with “Receive files from my other devices” on in Settings.</p>';
      return;
    }
    var names = {};
    others.forEach(function (d) { names[d.name] = (names[d.name] || 0) + 1; });
    box.innerHTML = others.map(function (d) {
      var on = !!selected[d.inst];
      return '<button type="button" class="beam-dev' + (on ? ' on' : '') + '" data-inst="' + esc(d.inst) + '" aria-pressed="' + on + '">' +
        '<span class="beam-dev-ic" aria-hidden="true">' + K.kindIcon(d.kind) + '</span>' +
        '<span class="beam-dev-n">' + esc(d.name) + (names[d.name] > 1 ? ' <small>tab ' + esc(d.inst.split('-')[1] || '') + '</small>' : '') +
          (d.sameDevice ? ' <small>this device, another tab</small>' : '') + '</span>' +
        '<span class="beam-check" aria-hidden="true">' + (on ? '✓' : '') + '</span></button>';
    }).join('');
  }
  function watch() {
    if (stopDevs || !L || !Cade.cloud.configured()) return;
    stopDevs = L.watchDevices(onDevices);
  }
  function unwatch() { if (stopDevs) { stopDevs(); stopDevs = null; } }

  // ---- Send: files ---------------------------------------------------------------------------------------------
  function addFiles(list, quiet) {
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!f) continue;
      var name = K.safeName(f.name || ('pasted-' + stamp() + '.' + (K.extOf('x.' + ((f.type || '').split('/')[1] || 'bin')) || 'bin')));
      picked.push({ id: ++seq, blob: f, name: name, mime: f.type || '' });
      n++;
    }
    if (n && !quiet) { try { Cade.haptic(8); } catch (e) {} }
    renderPicked();
    return n;
  }
  function stamp() { var d = new Date(); return d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '-' + ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2) + ('0' + d.getSeconds()).slice(-2); }
  function noteFile() {
    var ed = Cade.editor, text = ed ? ed.state.doc.toString() : '';
    var room = (Cade.roomsApi && Cade.roomsApi.activeRoom && Cade.roomsApi.activeRoom()) || 'note';
    var name = K.safeName(String(room).replace(/\.txt$/i, '') + '.txt');
    return { blob: new Blob([text], { type: 'text/plain' }), name: name, mime: 'text/plain' };
  }
  function renderPicked() {
    if (!P) return;
    el.picked.innerHTML = picked.map(function (f) {
      return '<li class="beam-pf" data-id="' + f.id + '"><span class="beam-ic" aria-hidden="true">' + (K.isImage(f.mime, f.name) ? '🖼' : f.mime === 'text/plain' ? '📝' : '📄') + '</span>' +
        '<span class="beam-pf-n"><b>' + esc(f.name) + '</b><small>' + K.fmtBytes(f.blob.size) + '</small></span>' +
        '<button type="button" class="beam-x" data-act="unpick" aria-label="Remove ' + esc(f.name) + '">×</button></li>';
    }).join('');
    el.drop.classList.toggle('has', picked.length > 0);
    paintGo();
  }
  function paintGo() {
    if (!P) return;
    var devs = targets(), total = picked.reduce(function (a, f) { return a + f.blob.size; }, 0);
    var b = el.go;
    b.disabled = !devs.length || !picked.length;
    b.textContent = !devs.length ? (picked.length ? 'Pick a device above' : 'Pick a device and files')
      : !picked.length ? 'Add files to send'
      : 'Send ' + (picked.length === 1 ? picked[0].name : picked.length + ' files') + ' · ' + K.fmtBytes(total) + ' → ' + (devs.length === 1 ? devs[0].name : devs.length + ' devices');
  }
  function targets() { return (devices || []).filter(function (d) { return !d.self && selected[d.inst]; }); }
  function paste(ev) {
    var dt = ev.clipboardData, files = [];
    if (!dt) return;
    if (dt.files && dt.files.length) files = Array.prototype.slice.call(dt.files);
    else if (dt.items) for (var i = 0; i < dt.items.length; i++) if (dt.items[i].kind === 'file') { var f = dt.items[i].getAsFile(); if (f) files.push(f); }
    if (!files.length) return;
    ev.preventDefault();
    take(files);
  }
  // Files dropped / pasted: the QR tab in send mode takes one; else they join the Send list.
  function take(files) {
    if (prefs.tab === 'qr' && prefs.qr === 'send') { setQrFile({ blob: files[0], name: K.safeName(files[0].name || 'pasted-' + stamp()), mime: files[0].type || '' }); return; }
    if (prefs.tab !== 'send') setTab('send');
    addFiles(files);
  }
  function pasteButton() {
    var cb = navigator.clipboard;
    if (!cb || !cb.read) { Cade.showToast('Press ' + (/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘V' : 'Ctrl+V') + ' here to paste an image', 'info', 2500); return; }
    cb.read().then(function (items) {
      var got = [];
      return Promise.all(items.map(function (it) {
        var t = (it.types || []).filter(function (x) { return /^image\//.test(x); })[0] || ((it.types || []).indexOf('text/plain') >= 0 ? 'text/plain' : '');
        if (!t) return null;
        return it.getType(t).then(function (b) {
          var ext = t === 'text/plain' ? 'txt' : (t.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*/, '');
          var f;
          try { f = new File([b], 'pasted-' + stamp() + '.' + ext, { type: t }); } catch (e) { f = b; f.name = 'pasted-' + stamp() + '.' + ext; }
          got.push(f);
        });
      })).then(function () {
        if (got.length) take(got);
        else Cade.showToast('Nothing to paste — copy an image first', 'info', 2200);
      });
    }).catch(function () { Cade.showToast('Couldn’t read the clipboard — try ⌘V / Ctrl+V here', 'error', 2600); });
  }

  // ---- Send: transfers -----------------------------------------------------------------------------------------
  function sendNow() {
    var devs = targets();
    if (!devs.length || !picked.length || !L) return;
    var files = picked.map(function (f) { return { blob: f.blob, name: f.name, mime: f.mime }; });
    prefs.lastDid = devs[0].did; savePrefs();
    devs.forEach(function (d) { start(d, files); });
    picked = [];
    renderPicked();
  }
  function start(dev, files) {
    var w = { dev: dev, files: files, el: null, J: null };
    jobs.unshift(w);
    w.J = L.send(dev, files, { onUpdate: function () { paintJob(w); } });
    paintJob(w);
  }
  function paintJob(w) {
    if (!P) return;
    var J = w.J;
    if (!J) return;
    if (!w.el) {
      w.el = document.createElement('div');
      w.el.className = 'beam-job';
      w.el.innerHTML = '<div class="beam-job-h"><span class="beam-job-to"></span><span class="beam-job-p"></span><button type="button" class="beam-btn beam-sm" data-act="job"></button></div>' +
        '<div class="beam-bar"><i></i></div><div class="beam-job-s"></div><ul class="beam-job-files"></ul>';
      w.el.__w = w;
      el.jobs.insertBefore(w.el, el.jobs.firstChild);
      w.files.forEach(function (f, i) {
        var li = document.createElement('li');
        li.innerHTML = '<span class="beam-jf-n">' + esc(J.man.files[i].n) + '</span><span class="beam-jf-p"></span><span class="beam-mini"><i></i></span>';
        w.el.querySelector('.beam-job-files').appendChild(li);
      });
    }
    var p = J.prog || { pct: 0, bps: 0, eta: null }, live = !J.over;
    w.el.className = 'beam-job ' + J.state;
    w.el.querySelector('.beam-job-to').textContent = (J.state === 'done' ? '✓ ' : J.state === 'error' ? '⚠ ' : '') + K.kindIcon(w.dev.kind) + ' ' + w.dev.name;
    w.el.querySelector('.beam-job-p').textContent = live || J.state === 'done' ? J.label() : '';
    var b = w.el.querySelector('[data-act="job"]');
    b.textContent = live ? 'Cancel' : J.state === 'done' ? 'Done' : 'Retry';
    b.setAttribute('data-do', live ? 'cancel' : J.state === 'done' ? 'dismiss' : 'retry');
    w.el.querySelector('.beam-bar i').style.width = (J.state === 'done' ? 100 : p.pct) + '%';
    w.el.querySelector('.beam-bar').hidden = !live;
    w.el.querySelector('.beam-job-s').textContent = live
      ? (J.state === 'connecting' ? 'Connecting to ' + w.dev.name + '…' : J.state === 'verifying' ? 'Checking on ' + w.dev.name + '…' :
        K.fmtPct(p.pct) + ' · ' + K.fmtBytes(J.done) + ' of ' + K.fmtBytes(J.man.total) + (p.bps ? ' · ' + K.fmtRate(p.bps) : '') + (p.eta != null ? ' · ' + K.fmtEta(p.eta) : ''))
      : J.state === 'done' ? 'Sent ' + (J.man.files.length === 1 ? '' : J.man.files.length + ' files · ') + K.fmtBytes(J.man.total) + ' · checked on arrival'
      : J.err || (J.state === 'cancelled' ? 'Cancelled' : 'Failed');
    var lis = w.el.querySelectorAll('.beam-job-files li');
    var off = 0;
    for (var i = 0; i < lis.length; i++) {
      var s = J.man.files[i].s, d = J.state === 'done' ? s : Math.max(0, Math.min(s, J.done - off));
      off += s;
      var pct = s ? d * 100 / s : (J.done >= off ? 100 : 0);
      lis[i].querySelector('.beam-jf-p').textContent = J.state === 'done' ? K.fmtBytes(s) + ' ✓' : K.fmtBytes(s) + (live && pct > 0 ? ' · ' + K.fmtPct(pct) : '');
      lis[i].querySelector('.beam-mini i').style.width = pct + '%';
    }
  }
  function onJobAction(btn) {
    var jobEl = btn.closest('.beam-job'), w = jobEl && jobEl.__w;
    if (!w) return;
    var d = btn.getAttribute('data-do');
    if (d === 'cancel') w.J.cancel();
    else if (d === 'dismiss') { jobEl.remove(); jobs = jobs.filter(function (x) { return x !== w; }); }
    else if (d === 'retry') {
      jobEl.remove(); jobs = jobs.filter(function (x) { return x !== w; });
      var dev = (devices || []).filter(function (x) { return x.did === w.dev.did && !x.self; })[0] || w.dev;
      start(dev, w.files);
    }
  }

  // ---- QR stream ----------------------------------------------------------------------------------------------------
  function paintQrSeg() {
    P.setAttribute('data-qr', prefs.qr);
    P.querySelectorAll('[data-qr]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-qr') === prefs.qr); });
  }
  // Send ↔ Receive is a new stream: the mount is made for one direction.
  function setQrMode(m) {
    m = m === 'receive' ? 'receive' : 'send';
    var changed = m !== prefs.qr;
    prefs.qr = m; savePrefs();
    paintQrSeg();
    if (changed && (qr.h || qr.loading)) unmountQr();
    if (prefs.tab === 'qr') mountQr();
  }
  function setQrFile(f) {
    qr.file = f;
    el.qrFn.textContent = f ? f.name + ' · ' + K.fmtBytes(f.blob.size) : 'No file chosen';
    if (prefs.qr !== 'send') setQrMode('send');
    if (prefs.tab !== 'qr') setTab('qr');            // mounts with qr.file, or resumes a paused stream
    if (qr.h && qr.hFile !== f && qr.h.send) { qr.hFile = f; try { qr.h.send(f); } catch (e) { console.error(e); } }
  }
  // The QR mount pauses itself on the panel's minimize / restore events; a tab
  // of this panel being hidden gets the same signal (not bubbling, marked as ours).
  function qrSignal(type) { if (qr.h && P) P.dispatchEvent(new CustomEvent(type, { detail: { beamQr: true } })); }
  function pauseQr() { qrSignal('cade-panel-minimize'); }
  function resumeQr() { qrSignal('cade-panel-restore'); }
  function mountQr() {
    if (!P || qr.h || qr.loading) return;
    var host = el.qrHost, g = ++qr.gen;
    if (window.__cadeBeamQR) { doMount(); return; }
    host.innerHTML = '<p class="beam-note beam-center">Loading QR stream…</p>';
    qr.loading = true;
    load(BASE + 'beam-qr.js').then(function () {
      qr.loading = false;
      if (!P || g !== qr.gen || prefs.tab !== 'qr') return;
      if (!window.__cadeBeamQR) throw new Error('missing');
      doMount();
    }).catch(function () {
      qr.loading = false;
      if (!P || g !== qr.gen) return;
      host.innerHTML = '<p class="beam-note beam-center">The QR stream isn’t available on this copy of the app yet' + (navigator.onLine === false ? ' (offline?)' : '') + '.</p>' +
        '<p class="beam-note beam-center">' + (Cade.cloud.configured() ? 'Use <b>Send</b> to beam to your other devices instead.' : '') + '</p>';
    });
    function doMount() {
      host.innerHTML = '';
      try {
        // our own Send / Receive switch and file buttons sit above it
        qr.hFile = prefs.qr === 'send' ? qr.file : null;
        qr.h = window.__cadeBeamQR.mount(host, { mode: prefs.qr, file: qr.hFile, onReceived: onQrReceived, controls: false });
      } catch (e) {
        console.error(e);
        qr.h = null;
        host.innerHTML = '<p class="beam-note beam-center">The QR stream couldn’t start: ' + esc(e && e.message || e) + '</p>';
      }
    }
  }
  function unmountQr() {
    qr.gen++;
    qr.loading = false;
    if (qr.h) { try { qr.h.destroy(); } catch (e) { console.error(e); } qr.h = null; }
    qr.hFile = null;
    if (el.qrHost) el.qrHost.innerHTML = '';
  }
  function onQrReceived(file) {
    if (!file || !file.blob) return;
    var name = K.safeName(file.name || 'received');
    var inbox = window.__cadeBeamInbox;
    if (!inbox) { Cade.files.save(file.blob, name); return; }
    inbox.add({ name: name, mime: file.mime || file.blob.type, blob: file.blob, from: 'QR stream', via: 'qr' }).then(function () {
      Cade.showToast('Received ' + name + ' (' + K.fmtBytes(file.blob.size) + ') — it’s in the Inbox', 'success', 3000);
      try { Cade.haptic(20); } catch (e) {}
    });
  }

  // ---- Inbox ----------------------------------------------------------------------------------------------------------
  function freeInboxUrls() { inboxUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} }); inboxUrls = []; }
  function renderInbox() {
    var inbox = window.__cadeBeamInbox;
    if (!P || !inbox) return;
    var p = P;
    inbox.list().then(function (rows) {
      if (P !== p) return;
      inboxRows = rows;
      paintBadge();
      if (prefs.tab !== 'inbox') return;
      freeInboxUrls();
      var total = rows.reduce(function (a, r) { return a + (r.size || 0); }, 0), t = Date.now();
      el.inSum.textContent = rows.length ? rows.length + (rows.length === 1 ? ' file' : ' files') + ' · ' + K.fmtBytes(total) + ' · kept 7 days' : '';
      el.clear.hidden = !rows.length;
      if (!rows.length) { el.inList.innerHTML = '<li class="beam-note beam-empty">Nothing received yet. Files beamed to this device — or caught from a QR stream — land here for 7 days.</li>'; return; }
      el.inList.innerHTML = rows.map(function (r) {
        var th = '';
        if (r.blob && K.isImage(r.mime, r.name)) { var u = URL.createObjectURL(r.blob); inboxUrls.push(u); th = '<img class="beam-th" alt="" src="' + esc(u) + '">'; }
        var open = K.openKind(r.mime, r.name);
        return '<li class="beam-ir" data-id="' + esc(r.id) + '">' + (th || '<span class="beam-ic" aria-hidden="true">📄</span>') +
          '<span class="beam-cf-n"><b>' + esc(r.name) + '</b><small>' + K.fmtBytes(r.size) + (r.from ? ' · from ' + esc(r.from) : '') + ' · ' + K.ago(t - r.at) + (r.mem ? ' · until reload' : '') + '</small></span>' +
          '<span class="beam-acts"><button type="button" data-act="in-save">Save</button><button type="button" data-act="in-attach"' + (r.size > Cade.files.MAX_BYTES ? ' class="dim" title="Over 25 MB — too big to attach to a note"' : '') + '>Attach</button>' +
          (open ? '<button type="button" data-act="in-open">Open</button>' : '') +
          '<button type="button" class="beam-x" data-act="in-del" title="Delete" aria-label="Delete ' + esc(r.name) + '">🗑</button></span></li>';
      }).join('');
      el.inList.querySelectorAll('img').forEach(function (img) { img.onerror = function () { img.replaceWith(Object.assign(document.createElement('span'), { className: 'beam-ic', textContent: '🖼' })); }; });
    });
  }
  // Transfers arriving right now, above the Inbox (the receive card hides behind a full-screen panel).
  function paintIncoming(J) {
    var box = el.inLive, r = liveRows[J.x];
    if (!box || J.dir !== 'in') return;
    if (J.over) { if (r) { r.remove(); delete liveRows[J.x]; } return; }
    if (!r) {
      r = liveRows[J.x] = document.createElement('div');
      r.className = 'beam-job sending';
      r.innerHTML = '<div class="beam-job-h"><span class="beam-job-to"></span><span class="beam-job-p"></span><button type="button" class="beam-btn beam-sm" data-act="in-cancel" data-x="' + esc(J.x) + '">Cancel</button></div>' +
        '<div class="beam-bar"><i></i></div><div class="beam-job-s"></div>';
      box.insertBefore(r, box.firstChild);
    }
    var p = J.prog || { pct: 0, bps: 0, eta: null };
    r.querySelector('.beam-job-to').textContent = '📡 ' + (J.files.length === 1 ? J.files[0].n : J.files.length + ' files');
    r.querySelector('.beam-job-p').textContent = '';
    r.querySelector('.beam-bar i').style.width = p.pct + '%';
    r.querySelector('.beam-job-s').textContent = 'from ' + J.peer + ' · ' + J.label() + ' · ' + K.fmtPct(p.pct) + ' · ' + K.fmtBytes(J.done) + ' / ' + K.fmtBytes(J.man.total) +
      (p.bps ? ' · ' + K.fmtRate(p.bps) : '') + (p.eta != null ? ' · ' + K.fmtEta(p.eta) : '');
  }
  function paintBadge() {
    if (!P) return;
    var b = q('.beam-badge');
    b.hidden = !inboxRows.length;
    b.textContent = inboxRows.length > 99 ? '99+' : String(inboxRows.length);
  }
  function inboxRec(btn) {
    var li = btn.closest('.beam-ir'), id = li && li.getAttribute('data-id');
    return inboxRows.filter(function (r) { return r.id === id; })[0] || null;
  }
  function attachBlob(blob, name, mime) {
    if (blob.size > Cade.files.MAX_BYTES) { Cade.showToast(name + ' is ' + K.fmtBytes(blob.size) + ' — notes take files up to 25 MB. Use Save instead.', 'error', 4000); return; }
    var f;
    try { f = new File([blob], name, { type: mime || blob.type || '' }); } catch (e) { f = blob; f.name = name; }
    Cade.files.attach(f);
  }
  var openUrls = [];
  function openBlob(blob, name, mime) {
    var kind = K.openKind(mime || blob.type, name);
    if (!kind) { Cade.files.save(blob, name); return; }
    var u = URL.createObjectURL(new Blob([blob], { type: K.openType(kind, mime || blob.type, name) }));
    if (!window.open(u, '_blank')) Cade.showToast('Pop-up blocked — use Save instead', 'error', 2500);
    openUrls.push(u);   // revoked when the panel closes (the new tab has loaded it by then)
  }

  // ---- file-pill handoff -------------------------------------------------------------------------------------------
  function takeHandoff() {
    var f = Cade.files && Cade.files.take;
    if (!f) return null;
    var h = Cade.files.take('beam');
    if (h) { h.kind = 'beam'; return h; }
    h = Cade.files.take('beam-qr');
    if (h) { h.kind = 'beam-qr'; return h; }
    return null;
  }
  function useHandoff(h) {
    var p = P;
    Cade.files.get(h.hash).then(function (f) {
      if (P !== p) return;
      if (!f) { Cade.showToast(h.name + ' is still syncing to this device — try again in a moment', 'error', 3500); return; }
      var file = { blob: f.blob, name: K.safeName(f.name || h.name), mime: f.mime || f.blob.type || '' };
      if (h.kind === 'beam-qr') { if (Cade.isMinimized(P)) Cade.restorePanel(P); setQrFile(file); return; }
      if (Cade.isMinimized(P)) Cade.restorePanel(P);
      setTab('send');
      picked.push({ id: ++seq, blob: file.blob, name: file.name, mime: file.mime });
      renderPicked();
      if (!Cade.cloud.configured()) Cade.showToast('Beam needs Sync to reach your other devices — or use the QR stream', 'info', 3500);
    }, function (e) {
      Cade.showToast((e && e.message === 'checksum') ? 'That file’s data is damaged on this device' : 'Couldn’t read ' + h.name, 'error', 3500);
    });
  }

  // ---- panel lifecycle ---------------------------------------------------------------------------------------------------
  function onClick(e) {
    var t = e.target.closest ? e.target.closest('[data-act],[data-tab],[data-inst],[data-qr]') : null;
    if (!t || !P.contains(t)) return;
    if (t.hasAttribute('data-tab')) { setTab(t.getAttribute('data-tab')); return; }
    if (t.hasAttribute('data-qr')) { setQrMode(t.getAttribute('data-qr')); return; }
    if (t.hasAttribute('data-inst')) {
      var inst = t.getAttribute('data-inst');
      if (selected[inst]) delete selected[inst]; else selected[inst] = 1;
      renderDevices(); paintGo();
      return;
    }
    var a = t.getAttribute('data-act'), r;
    if (a === 'choose') { el.file.value = ''; el.file.click(); }
    else if (a === 'note') { var n = noteFile(); picked.push({ id: ++seq, blob: n.blob, name: n.name, mime: n.mime }); renderPicked(); }
    else if (a === 'paste') pasteButton();
    else if (a === 'unpick') { var id = +t.closest('.beam-pf').getAttribute('data-id'); picked = picked.filter(function (f) { return f.id !== id; }); renderPicked(); }
    else if (a === 'send') sendNow();
    else if (a === 'job') onJobAction(t);
    else if (a === 'to-qr') setTab('qr');
    else if (a === 'qr-choose') { el.qrInput.value = ''; el.qrInput.click(); }
    else if (a === 'qr-note') setQrFile(noteFile());
    else if (a === 'in-save') { r = inboxRec(t); if (r && r.blob) Cade.files.save(r.blob, r.name); }
    else if (a === 'in-attach') { r = inboxRec(t); if (r && r.blob) attachBlob(r.blob, r.name, r.mime); }
    else if (a === 'in-open') { r = inboxRec(t); if (r && r.blob) openBlob(r.blob, r.name, r.mime); }
    else if (a === 'in-cancel') { var J = L.active('in').filter(function (j) { return j.x === t.getAttribute('data-x'); })[0]; if (J) J.cancel(); }
    else if (a === 'in-del') { r = inboxRec(t); if (r) window.__cadeBeamInbox.remove(r.id); }
    else if (a === 'clear') {
      if (!clearArm) { clearArm = setTimeout(function () { clearArm = 0; if (el.clear) el.clear.textContent = 'Clear all'; }, 3000); t.textContent = 'Tap again to clear'; return; }
      clearTimeout(clearArm); clearArm = 0; t.textContent = 'Clear all';
      window.__cadeBeamInbox.remove(inboxRows.map(function (x) { return x.id; }));
    }
  }
  function onName(e) {
    if (!e.target.classList.contains('beam-name')) return;
    e.target.value = Cade.cloud.setDeviceName(e.target.value);
    if (window.__cadeBeamRecv) window.__cadeBeamRecv.refresh();
    if (window.__cadeRemoteRecv) window.__cadeRemoteRecv.refresh();
    setTimeout(paintSync, 600);
  }
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
  // Drops on the panel are Beam's: kept away from the window-level import.
  function onDrag(e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.type === 'dragover') { try { e.dataTransfer.dropEffect = 'copy'; } catch (x) {} }
    if (e.type === 'dragenter' || e.type === 'dragover') P.classList.add('beam-over');
    else if (e.type === 'dragleave') { if (!e.relatedTarget || !P.contains(e.relatedTarget)) P.classList.remove('beam-over'); }
    else if (e.type === 'drop') {
      P.classList.remove('beam-over');
      var files = Array.prototype.slice.call(e.dataTransfer.files || []);
      if (files.length) take(files);
    }
  }
  function onVis() {
    if (!P) return;
    if (document.visibilityState === 'visible') { watch(); paintSync(); if (prefs.tab !== 'qr') setTimeout(pauseQr, 60); }
    else unwatch();
  }
  function cleanup() {
    var p = P;
    if (!p) return;
    var live = jobs.filter(function (w) { return w.J && !w.J.over; });
    live.forEach(function (w) { w.J.cancel(); });
    if (live.length) { try { Cade.showToast('Beam cancelled — closing Beam stops sending', 'info', 2500); } catch (e) {} }
    unmountQr();
    unwatch();
    if (stopInbox) { stopInbox(); stopInbox = null; }
    if (stopJobs) { stopJobs(); stopJobs = null; }
    liveRows = {};
    clearTimeout(clearArm); clearArm = 0;
    freeInboxUrls();
    openUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} }); openUrls = [];
    document.removeEventListener('visibilitychange', onVis);
    P = null; el = {}; jobs = []; picked = []; devices = null; selected = {}; inboxRows = []; qr.file = null; pendingHandoff = null;
  }
  function close() { var p = P; cleanup(); if (p) p.remove(); }
  function open() {
    var h = takeHandoff();
    if (P && P.isConnected) {
      // a file pill's "Beam" while open: take the file instead of toggling closed
      if (h) { if (K) useHandoff(h); else pendingHandoff = h; return; }
      close(); return;
    }
    if (P) cleanup();
    Cade.closeAllMenus();
    loadPrefs();
    P = Cade.mkPanel(PANEL_ID, '📡 Beam', bodyHtml());
    P._onClose = cleanup;
    el = {
      nosync: q('.beam-nosync'), sync: q('.beam-sync'), devs: q('.beam-devs'), name: q('.beam-name'), meSt: q('.beam-me-st'), drop: q('.beam-drop'), picked: q('.beam-picked'),
      file: q('.beam-file'), go: q('.beam-go'), jobs: q('.beam-jobs'), qrHost: q('.beam-qr-host'), qrFn: q('.beam-qr-fn'), qrInput: q('.beam-qr-input'),
      inSum: q('.beam-in-sum'), inList: q('.beam-in-list'), clear: q('[data-act="clear"]'), inLive: q('.beam-in-live')
    };
    var root = q('.beam');
    root.addEventListener('click', onClick);
    root.addEventListener('change', onName);
    root.addEventListener('paste', paste);
    el.file.addEventListener('change', function () { if (el.file.files && el.file.files.length) addFiles(Array.prototype.slice.call(el.file.files)); });
    el.qrInput.addEventListener('change', function () { var f = el.qrInput.files && el.qrInput.files[0]; if (f) setQrFile({ blob: f, name: K.safeName(f.name), mime: f.type || '' }); });
    el.name.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.target.blur(); });
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (t) { P.addEventListener(t, onDrag); });
    // Minimize / restore: the QR stream pauses and resumes itself. Running Beam
    // while its panel is minimized restores it without calling open() — so a
    // file pill's handoff is picked up here too.
    P.addEventListener('cade-panel-restore', function (e) {
      if (e.detail && e.detail.beamQr) return;
      if (prefs.tab !== 'qr') setTimeout(pauseQr, 60);   // it resumed on restore, but its tab is hidden
      var hh = K && takeHandoff();
      if (hh) useHandoff(hh);
    });
    document.addEventListener('visibilitychange', onVis);
    P.setAttribute('data-qr', prefs.qr);
    P.querySelectorAll('[data-qr]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-qr') === prefs.qr); });
    var p = P;
    loadLink().then(function (link) {
      if (P !== p) return;
      L = link; K = window.__cadeBeamCore;
      paintSync();
      renderPicked();
      setTab(prefs.tab);
      if (Cade.cloud.configured()) watch();
      stopInbox = window.__cadeBeamInbox.onchange(function () { renderInbox(); });
      stopJobs = L.onJobs(paintIncoming);
      L.active('in').forEach(paintIncoming);
      renderInbox();
      try { root.focus({ preventScroll: true }); } catch (e) {}
      h = h || pendingHandoff; pendingHandoff = null;
      if (h) useHandoff(h);
    }, function (e) {
      if (P !== p) return;
      q('.beam-pane[data-pane="send"]').innerHTML = '<p class="beam-note">' + esc(e.message) + '</p>';
      P.setAttribute('data-tab', 'send');
    });
  }

  Cade.registerWidget({
    name: 'Beam',
    description: 'Send files straight to your other devices — direct over Wi-Fi, nothing stored in the cloud, no size limit — or as a QR stream with no network at all',
    icon: '📡',
    tags: 'beam,send,share,transfer,airdrop,nearby,files,file,photo,devices,phone,laptop,ipad,wifi,p2p,peer,qr,qr stream,inbox,multi-device',
    open: open,
    close: close
  });
})();
