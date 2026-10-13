/* Network Info — connection status, public IP & ISP, Cloudflare edge,
 * latency, a rough download/upload speed test and a DNS lookup tool.
 *
 * PRIVACY: nothing leaves the device when the panel opens. "Check" looks up
 * your public IP (ipify v4 + v6, ipwho.is → ipinfo.io fallback for ISP /
 * approximate location, Cloudflare's /cdn-cgi/trace for edge, HTTP & TLS);
 * a checkbox can make that automatic on open. Ping, speed and DNS run only
 * when asked.
 *
 * ENDPOINTS (all free, no key, CORS-enabled — verified with curl):
 *   api.ipify.org / api6.ipify.org, ipwho.is, ipinfo.io/json,
 *   speed.cloudflare.com (/cdn-cgi/trace, /__down?bytes=N, POST /__up),
 *   cloudflare-dns.com/dns-query (application/dns-json), dns.google/resolve.
 *
 * SERVICE WORKER: the app's SW answers GETs stale-while-revalidate and keeps
 * them. Live lookups therefore carry a unique cache-busting parameter and ask
 * for no-store, latency/upload use POST (never intercepted), and our entries
 * are swept from the SW cache after each run so a speed test can't leave
 * megabytes behind.
 *
 * navigator.connection (effectiveType / downlink / rtt / saveData) is shown
 * where the browser exposes it — Safari/iOS and Firefox don't. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('netinfo.css');
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'netinfo-panel';
  var PREFS_KEY = 'cade-netinfo-prefs';
  var IPV4 = 'https://api.ipify.org/?format=json';
  var IPV6 = 'https://api6.ipify.org/?format=json';
  var GEO1 = 'https://ipwho.is/';
  var GEO2 = 'https://ipinfo.io/json';
  var TRACE = 'https://speed.cloudflare.com/cdn-cgi/trace';
  var DOWN = 'https://speed.cloudflare.com/__down';
  var UP = 'https://speed.cloudflare.com/__up';
  var RESOLVERS = {
    cf: { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query', headers: { accept: 'application/dns-json' } },
    g: { name: 'Google', url: 'https://dns.google/resolve', headers: null },
  };
  var SWEEP = ['https://api.ipify.org/', 'https://api6.ipify.org/', 'https://ipwho.is/', 'https://ipinfo.io/json', TRACE, DOWN,
    RESOLVERS.cf.url, RESOLVERS.g.url];
  var DNS_TYPES = { 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 46: 'RRSIG', 64: 'SVCB', 65: 'HTTPS', 257: 'CAA' };
  var DNS_STATUS = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' };
  var ALL_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];

  // ---- helpers -------------------------------------------------------------------
  function readJSON(k, d) { try { var v = JSON.parse(Cade.store.get(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function writeJSON(k, v) { try { Cade.store.set(k, JSON.stringify(v)); } catch (e) {} }
  function now() { return window.performance && performance.now ? performance.now() : Date.now(); }
  function rnd() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function bust(u) { return u + (u.indexOf('?') < 0 ? '?' : '&') + '_=' + rnd(); }
  function sweep() {
    try {
      if (!window.caches || !caches.keys) return;
      caches.keys().then(function (names) {
        names.forEach(function (n) {
          if (!/^cade-v\d+$/.test(n)) return;
          caches.open(n).then(function (c) {
            SWEEP.forEach(function (b) { c.delete(b, { ignoreSearch: true, ignoreVary: true }).catch(function () {}); });
          }).catch(function () {});
        });
      }).catch(function () {});
    } catch (e) {}
  }
  // fetch with a timeout and an optional outer AbortSignal.
  function req(url, opts, ms, outer) {
    opts = opts || {};
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl && ms ? setTimeout(function () { ctrl.abort(); }, ms) : 0;
    var relay = function () { if (ctrl) ctrl.abort(); };
    if (outer) { if (outer.aborted) relay(); else outer.addEventListener('abort', relay); }
    var o = { cache: 'no-store', credentials: 'omit', method: opts.method || 'GET' };
    if (opts.body !== undefined) o.body = opts.body;
    if (opts.headers) o.headers = opts.headers;
    if (ctrl) o.signal = ctrl.signal;
    return fetch(url, o).then(function (r) {
      return { r: r, done: function () { clearTimeout(timer); if (outer) outer.removeEventListener('abort', relay); } };
    }, function (e) { clearTimeout(timer); if (outer) outer.removeEventListener('abort', relay); throw e; });
  }
  function getJSON(url, ms, headers) {
    return req(url, { headers: headers }, ms || 8000).then(function (x) {
      return x.r.json().then(function (j) { x.done(); if (!x.r.ok) throw new Error('HTTP ' + x.r.status); return j; },
        function (e) { x.done(); throw e; });
    });
  }
  function getText(url, ms) {
    return req(url, {}, ms || 8000).then(function (x) {
      return x.r.text().then(function (t) { x.done(); if (!x.r.ok) throw new Error('HTTP ' + x.r.status); return t; });
    });
  }
  function flag(cc) {
    if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return '';
    cc = cc.toUpperCase();
    return String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65, 0x1F1E6 + cc.charCodeAt(1) - 65);
  }
  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function pct(a, p) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; }
  function ms1(v) { return v < 10 ? v.toFixed(1) : Math.round(v); }
  function mbps(bits, s) { return bits / s / 1e6; }
  function fmtMbps(v) { return v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2); }
  function bytesStr(n) { return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' MB' : Math.round(n / 1e3) + ' kB'; }

  function copyText(text, what) {
    var done = function () { Cade.showToast('Copied ' + (what || ''), 'success', 1400); };
    var fail = function () { Cade.showToast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      ta.remove();
    }
  }

  // ---- state -----------------------------------------------------------------------
  var S = null;
  function panel() { return document.getElementById(PANEL_ID); }
  function conn() { return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null; }

  // ---- status card -------------------------------------------------------------------
  function renderStatus() {
    var st = S; if (!st) return;
    var on = navigator.onLine !== false, c = conn();
    var rows = '';
    if (c) {
      if (c.type) rows += kv('Link', c.type);
      if (c.effectiveType) rows += kv('Effective type', String(c.effectiveType).toUpperCase(), 'Browser\u2019s estimate of the network class');
      if (c.downlink != null) rows += kv('Downlink est.', c.downlink + ' Mbps', 'Browser estimate (capped at 10 Mbps in Chrome)');
      if (c.rtt != null) rows += kv('RTT est.', c.rtt + ' ms', 'Browser estimate, rounded to 25 ms');
      if (c.saveData != null) rows += kv('Data saver', c.saveData ? 'On' : 'Off');
    }
    st.p.querySelector('.ni-status').innerHTML =
      '<div class="ni-online ' + (on ? 'on' : 'off') + '"><span class="ni-dot"></span>' + (on ? 'Online' : 'Offline') + '</div>' +
      (rows ? '<div class="ni-kvs">' + rows + '</div>'
        : '<div class="ni-note">Connection details aren\u2019t exposed by this browser (Safari / iOS and Firefox don\u2019t implement the Network Information API). Run a ping or speed test below for real numbers.</div>');
  }
  function kv(k, v, title, copy) {
    return '<div class="ni-kv"' + (title ? ' title="' + esc(title) + '"' : '') + '><span class="ni-k">' + esc(k) + '</span><span class="ni-v">' +
      (copy ? '<button type="button" class="ni-copyv" data-copy="' + esc(copy) + '" title="Copy">' + esc(v) + '</button>' : esc(v)) + '</span></div>';
  }

  // ---- public IP ---------------------------------------------------------------------
  function parseTrace(t) {
    var o = {};
    String(t || '').split('\n').forEach(function (l) { var i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1).trim(); });
    return o;
  }
  function checkIP() {
    var st = S; if (!st || st.ipBusy) return;
    st.ipBusy = true; st.ip = st.ip || null;
    renderIP();
    var seq = ++st.ipSeq;
    var v4 = getJSON(bust(IPV4), 7000).then(function (j) { return j.ip; }, function () { return null; });
    var v6 = getJSON(bust(IPV6), 6000).then(function (j) { return j.ip && j.ip.indexOf(':') !== -1 ? j.ip : null; }, function () { return null; });
    var trace = getText(bust(TRACE), 7000).then(parseTrace, function () { return null; });
    var geo = getJSON(bust(GEO1), 8000).then(function (j) {
      if (!j || j.success === false) throw new Error((j && j.message) || 'ipwho.is failed');
      return {
        ip: j.ip, city: j.city, region: j.region, country: j.country, cc: j.country_code,
        isp: j.connection && (j.connection.isp || j.connection.org), org: j.connection && j.connection.org,
        asn: j.connection && j.connection.asn, tz: j.timezone && j.timezone.id, lat: j.latitude, lon: j.longitude, src: 'ipwho.is',
      };
    }).catch(function () {
      return getJSON(bust(GEO2), 8000).then(function (j) {
        var m = /^AS(\d+)\s+(.*)$/.exec(j.org || '');
        return { ip: j.ip, city: j.city, region: j.region, country: j.country, cc: j.country, isp: m ? m[2] : j.org, asn: m ? +m[1] : null, tz: j.timezone, src: 'ipinfo.io' };
      });
    }).catch(function () { return null; });
    Promise.all([v4, v6, trace, geo]).then(function (r) {
      if (!S || S !== st || seq !== st.ipSeq) return;
      st.ipBusy = false;
      st.ip = { v4: r[0], v6: r[1], trace: r[2], geo: r[3], at: Date.now() };
      // One of the v4/v6 lookups may fail on a single-stack network; the trace / geo replies still carry the address.
      if (!st.ip.v4) {
        var alt = (r[2] && r[2].ip) || (r[3] && r[3].ip);
        if (alt && alt.indexOf(':') === -1) st.ip.v4 = alt;
      }
      if (!st.ip.v6 && r[2] && r[2].ip && r[2].ip.indexOf(':') !== -1) st.ip.v6 = r[2].ip;
      if (!st.ip.v4 && !st.ip.v6 && !st.ip.trace && !st.ip.geo) st.ip.err = navigator.onLine === false ? 'You\u2019re offline.' : 'All lookups failed \u2014 a content blocker may be stopping them.';
      renderIP();
      sweep();
    });
  }
  function renderIP() {
    var st = S; if (!st) return;
    var box = st.p.querySelector('.ni-ip'), ip = st.ip;
    var head = '<div class="ni-auto"><label><input type="checkbox" class="ni-autochk"' + (st.prefs.auto ? ' checked' : '') + '> Check automatically when opened</label></div>';
    if (!ip && !st.ipBusy) {
      box.innerHTML = '<div class="ni-note">Looks up your public IP address, provider and approximate location using ipify, ipwho.is and Cloudflare. Nothing is sent until you press Check.</div>' + head;
      return;
    }
    if (st.ipBusy && !ip) { box.innerHTML = '<div class="ni-loading"><span class="ni-spin"></span>Looking up\u2026</div>' + head; return; }
    if (ip.err) { box.innerHTML = '<div class="ni-err">' + esc(ip.err) + '</div>' + head; return; }
    var g = ip.geo || {}, t = ip.trace || {}, rows = '';
    rows += kv('IPv4', ip.v4 || 'Not detected', ip.v4 ? 'Click to copy' : '', ip.v4 || '');
    rows += kv('IPv6', ip.v6 || 'Not detected', ip.v6 ? 'Click to copy' : 'No IPv6 connectivity from this network', ip.v6 || '');
    if (g.isp || g.org) rows += kv('Provider', (g.isp || g.org) + (g.asn ? ' \u00b7 AS' + g.asn : ''));
    if (g.city || g.country) {
      rows += kv('Location', (flag(g.cc) ? flag(g.cc) + ' ' : '') + [g.city, g.region, g.country].filter(Boolean).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', '),
        'Approximate, from your IP (' + g.src + '). VPNs and iCloud Private Relay show the relay\u2019s location.');
    }
    if (g.tz) rows += kv('Time zone', g.tz);
    if (t.colo) rows += kv('Cloudflare edge', t.colo + (t.loc ? ' \u00b7 ' + t.loc : ''), 'Nearest Cloudflare data centre (IATA airport code)');
    if (t.http || t.tls) rows += kv('Protocol', [t.http && t.http.toUpperCase().replace('HTTP/', 'HTTP/'), t.tls].filter(Boolean).join(' \u00b7 '));
    if (t.warp && t.warp !== 'off') rows += kv('WARP', t.warp);
    if (t.gateway && t.gateway !== 'off') rows += kv('Gateway', t.gateway);
    box.innerHTML = '<div class="ni-kvs">' + rows + '</div>' +
      '<div class="ni-sub">' + (st.ipBusy ? 'Refreshing\u2026' : 'Checked ' + new Date(ip.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + '</div>' + head;
  }

  // ---- latency -------------------------------------------------------------------------
  function serverMs(r) {
    // Server-Timing durations from the edge (exposed): subtract the largest.
    try {
      var h = r.headers.get('server-timing') || '', m, mx = 0, re = /dur=([\d.]+)/g;
      while ((m = re.exec(h))) mx = Math.max(mx, parseFloat(m[1]));
      var rtt = /rtt=(\d+)/.exec(h);
      return { dur: mx, tcp: rtt ? parseInt(rtt[1], 10) / 1000 : null };
    } catch (e) { return { dur: 0, tcp: null }; }
  }
  function onePing(signal) {
    var url = UP + '?r=' + rnd(), t0 = now();
    return req(url, { method: 'POST', body: '' }, 6000, signal).then(function (x) {
      var t1 = now(), sv = serverMs(x.r);
      return x.r.text().then(function () {
        x.done();
        var wall = t1 - t0, net = null;
        try {
          var e = performance.getEntriesByName(url);
          e = e && e[e.length - 1];
          if (e && e.responseStart > 0 && e.requestStart > 0) net = e.responseStart - e.requestStart;
        } catch (er) {}
        var v = (net != null ? net : wall) - sv.dur;
        return { ms: Math.max(0.1, v), tcp: sv.tcp };
      });
    });
  }
  function runPing() {
    var st = S; if (!st || st.pingBusy || st.speedBusy) return;
    st.pingBusy = true; st.ping = { samples: [], tcp: null };
    var ctrl = st.pingCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    renderPing();
    var N = 12, i = 0;
    var next = function () {
      if (!S || S !== st || (ctrl && ctrl.signal.aborted)) return finish();
      if (i >= N + 1) return finish();
      onePing(ctrl && ctrl.signal).then(function (r) {
        if (i > 0) { st.ping.samples.push(r.ms); if (r.tcp != null) st.ping.tcp = r.tcp; } // first = warm-up (DNS + TLS)
        i++; renderPing(); next();
      }, function (e) { st.ping.err = e && e.name === 'AbortError' ? '' : 'Ping failed' + (navigator.onLine === false ? ' (offline)' : ''); finish(); });
    };
    var finish = function () { if (S !== st) return; st.pingBusy = false; st.pingCtrl = null; renderPing(); };
    next();
  }
  function pingStats(a) {
    if (!a.length) return null;
    var j = 0;
    for (var i = 1; i < a.length; i++) j += Math.abs(a[i] - a[i - 1]);
    return { med: median(a), min: Math.min.apply(null, a), max: Math.max.apply(null, a), jit: a.length > 1 ? j / (a.length - 1) : 0, n: a.length };
  }
  function renderPing() {
    var st = S; if (!st) return;
    var box = st.p.querySelector('.ni-ping'), pg = st.ping;
    st.p.querySelector('.ni-pingbtn').textContent = st.pingBusy ? '\u25a0 Stop' : pg ? '\u21bb Again' : '\u25b6 Ping';
    if (!pg) { box.innerHTML = '<div class="ni-note">12 tiny round-trips to Cloudflare\u2019s nearest edge (after one warm-up); shows the median, best and jitter.</div>'; return; }
    var s = pingStats(pg.samples);
    var mx = 1;
    pg.samples.forEach(function (v) { mx = Math.max(mx, v); });
    var bars = pg.samples.map(function (v) { return '<span class="ni-pbar" style="height:' + Math.max(6, v / mx * 100).toFixed(0) + '%" title="' + ms1(v) + ' ms"></span>'; }).join('');
    box.innerHTML = (s ? '<div class="ni-big"><b>' + ms1(s.med) + '</b><small> ms median</small></div>' +
      '<div class="ni-mini">best ' + ms1(s.min) + ' \u00b7 worst ' + ms1(s.max) + ' \u00b7 jitter ' + ms1(s.jit) + ' ms' + (pg.tcp ? ' \u00b7 TCP RTT ' + ms1(pg.tcp) + ' ms' : '') + '</div>' : '') +
      '<div class="ni-pbars">' + bars + (st.pingBusy ? '<span class="ni-pbar pending"></span>' : '') + '</div>' +
      (pg.err ? '<div class="ni-err">' + esc(pg.err) + '</div>' : '');
  }

  // ---- speed test ------------------------------------------------------------------------
  var DOWN_SIZES = [1e5, 1e6, 5e6, 1e7, 2.5e7, 5e7];
  var UP_SIZES = [1e5, 5e5, 2e6, 5e6];
  function downloadOnce(n, signal, onProgress) {
    var url = DOWN + '?bytes=' + n + '&r=' + rnd();
    var t0 = now();
    return req(url, {}, 30000, signal).then(function (x) {
      if (!x.r.ok) { x.done(); throw new Error('HTTP ' + x.r.status); }
      var tH = now(), got = 0;
      var fin = function () { x.done(); var dt = (now() - tH) / 1000; return { bytes: got, secs: Math.max(dt, 0.001), ttfb: tH - t0 }; };
      if (!x.r.body || !x.r.body.getReader) {
        return x.r.arrayBuffer().then(function (b) { got = b.byteLength; return fin(); });
      }
      var rd = x.r.body.getReader();
      var pump = function () {
        return rd.read().then(function (c) {
          if (c.done) return fin();
          got += c.value.length;
          onProgress(got, (now() - tH) / 1000);
          return pump();
        });
      };
      return pump();
    });
  }
  function uploadOnce(n, signal) {
    var body = new Uint8Array(n);
    var t0 = now();
    return req(UP + '?r=' + rnd(), { method: 'POST', body: body }, 30000, signal).then(function (x) {
      var sv = serverMs(x.r);
      return x.r.text().then(function () { x.done(); return { bytes: n, secs: Math.max(0.001, (now() - t0 - sv.dur) / 1000) }; });
    });
  }
  function runSpeed() {
    var st = S; if (!st || st.speedBusy || st.pingBusy) return;
    var c = conn();
    if (c && (c.saveData || c.type === 'cellular') && !window.confirm('This test downloads up to ~90 MB and uploads ~8 MB. Continue on this connection?')) return;
    st.speedBusy = true;
    var ctrl = st.speedCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var sig = ctrl && ctrl.signal;
    var sp = st.speed = { down: [], up: [], live: 0, phase: 'Download', total: 0, startedAt: now() };
    renderSpeed();
    var BUDGET_D = 9000, BUDGET_U = 6000;
    var dStart = now();
    var i = 0;
    var raf = 0, lastPaint = 0;
    var stepDown = function () {
      if (sig && sig.aborted) return Promise.reject(abortErr());
      if (i >= DOWN_SIZES.length || now() - dStart > BUDGET_D) return Promise.resolve();
      var n = DOWN_SIZES[i];
      sp.label = 'Downloading ' + bytesStr(n);
      return downloadOnce(n, sig, function (got, secs) {
        if (secs > 0.05) sp.live = mbps(got * 8, secs);
        // Repaint the live figure a few times a second, not per chunk.
        if (!raf && now() - lastPaint > 200) raf = requestAnimationFrame(function () { raf = 0; lastPaint = now(); renderSpeed(); });
      }).then(function (r) {
        sp.total += r.bytes;
        if (r.secs >= 0.08 || n >= 1e6) sp.down.push(mbps(r.bytes * 8, r.secs));
        i++;
        // Stop growing once a transfer takes over 1.5 s — it's long enough to be representative.
        if (r.secs > 1.5) i = DOWN_SIZES.length;
        return stepDown();
      });
    };
    var j = 0, uStart = 0;
    var stepUp = function () {
      if (sig && sig.aborted) return Promise.reject(abortErr());
      if (j >= UP_SIZES.length || now() - uStart > BUDGET_U) return Promise.resolve();
      var n = UP_SIZES[j];
      sp.label = 'Uploading ' + bytesStr(n);
      renderSpeed();
      return uploadOnce(n, sig).then(function (r) {
        sp.up.push(mbps(r.bytes * 8, r.secs));
        sp.live = sp.up[sp.up.length - 1];
        j++;
        if (r.secs > 1.5) j = UP_SIZES.length;
        renderSpeed();
        return stepUp();
      });
    };
    stepDown().then(function () {
      sp.phase = 'Upload'; sp.live = 0; uStart = now();
      return stepUp();
    }).then(function () {
      sp.done = true;
    }, function (e) {
      if (e && e.name === 'AbortError') sp.cancelled = true;
      else sp.err = (navigator.onLine === false ? 'Offline \u2014 ' : '') + 'Speed test failed' + (e && e.message ? ' (' + e.message + ')' : '');
    }).then(function () {
      if (raf) cancelAnimationFrame(raf);
      if (S !== st) return;
      st.speedBusy = false; st.speedCtrl = null; sp.label = '';
      renderSpeed();
      sweep(); setTimeout(sweep, 4000); setTimeout(sweep, 20000);
    });
  }
  function abortErr() { var e = new Error('aborted'); e.name = 'AbortError'; return e; }
  function speedResult(a) {
    if (!a.length) return null;
    // Later, larger transfers are the most representative; take the 90th percentile.
    return pct(a, 0.9);
  }
  function renderSpeed() {
    var st = S; if (!st) return;
    var box = st.p.querySelector('.ni-speed'), sp = st.speed;
    st.p.querySelector('.ni-speedbtn').textContent = st.speedBusy ? '\u25a0 Cancel' : sp ? '\u21bb Again' : '\u25b6 Run test';
    if (!sp) {
      box.innerHTML = '<div class="ni-note">Downloads growing chunks (100 kB \u2192 up to 50 MB, about 9 s) then uploads a few MB to Cloudflare\u2019s speed-test servers. A rough figure \u2014 Wi-Fi, other tabs and the server all matter.</div>';
      return;
    }
    var d = speedResult(sp.down), u = speedResult(sp.up);
    var live = st.speedBusy ? '<div class="ni-live"><span class="ni-spin"></span>' + esc(sp.label || sp.phase) + (sp.live ? ' \u00b7 <b>' + fmtMbps(sp.live) + '</b> Mbps' : '') + '</div>' : '';
    box.innerHTML = '<div class="ni-speeds">' +
      '<div class="ni-sp"><span class="ni-sp-l">\u2193 Download</span><span class="ni-sp-v">' + (d != null ? fmtMbps(d) : st.speedBusy && sp.phase === 'Download' && sp.live ? fmtMbps(sp.live) : '\u2013') + '</span><span class="ni-sp-u">Mbps</span></div>' +
      '<div class="ni-sp"><span class="ni-sp-l">\u2191 Upload</span><span class="ni-sp-v">' + (u != null ? fmtMbps(u) : st.speedBusy && sp.phase === 'Upload' && sp.live ? fmtMbps(sp.live) : '\u2013') + '</span><span class="ni-sp-u">Mbps</span></div>' +
      '</div>' + live +
      (sp.cancelled ? '<div class="ni-sub">Cancelled.</div>' : '') +
      (sp.err ? '<div class="ni-err">' + esc(sp.err) + '</div>' : '') +
      (sp.done ? '<div class="ni-sub">' + bytesStr(sp.total) + ' downloaded \u00b7 ' + sp.down.length + ' + ' + sp.up.length + ' transfers</div>' : '');
  }

  // ---- DNS --------------------------------------------------------------------------------
  function cleanHost(v) {
    v = String(v || '').trim();
    if (!v) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'http://' + v;
    try { return new URL(v).hostname.replace(/\.$/, ''); } catch (e) { return ''; }
  }
  function dnsQuery(name, type, rk) {
    var R = RESOLVERS[rk];
    var url = R.url + '?name=' + encodeURIComponent(name) + '&type=' + type + (rk === 'g' ? '&random_padding=' : '&_=') + rnd();
    var t0 = now();
    return getJSON(url, 8000, R.headers).then(function (j) { j._ms = now() - t0; j._type = type; return j; });
  }
  function runDNS() {
    var st = S; if (!st) return;
    var p = st.p, name = cleanHost(p.querySelector('.ni-dq').value), type = p.querySelector('.ni-dtype').value, rk = st.prefs.resolver;
    if (!name) { Cade.showToast('Enter a domain name, e.g. example.com', 'error', 1800); return; }
    p.querySelector('.ni-dq').value = name;
    var types = type === 'ALL' ? ALL_TYPES : [type];
    var seq = ++st.dnsSeq;
    st.dns = { name: name, type: type, rk: rk, busy: true, res: [] };
    renderDNS();
    Promise.all(types.map(function (t) {
      return dnsQuery(name, t, rk).then(null, function (e) { return { _type: t, _err: e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || 'failed' }; });
    })).then(function (res) {
      if (!S || S !== st || seq !== st.dnsSeq) return;
      st.dns.busy = false; st.dns.res = res;
      renderDNS(); sweep();
    });
  }
  function txt(d) { d = String(d); return /^".*"$/.test(d) && d.split('"').length === 3 ? d.slice(1, -1) : d; }
  function renderDNS() {
    var st = S; if (!st) return;
    var box = st.p.querySelector('.ni-dres'), dn = st.dns;
    st.p.querySelectorAll('.ni-res').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-r') === st.prefs.resolver); });
    if (!dn) { box.innerHTML = ''; return; }
    if (dn.busy) { box.innerHTML = '<div class="ni-loading"><span class="ni-spin"></span>Asking ' + esc(RESOLVERS[dn.rk].name) + '\u2026</div>'; return; }
    var html = '', any = false, status = '', seen = {};
    dn.res.forEach(function (r) {
      if (r._err) { html += '<div class="ni-drow err"><span class="ni-dt">' + r._type + '</span><span class="ni-dd">' + esc(r._err) + '</span><span></span></div>'; return; }
      if (r.Status !== 0) status = DNS_STATUS[r.Status] || ('status ' + r.Status);
      (r.Answer || []).forEach(function (a) {
        var tn = DNS_TYPES[a.type] || String(a.type);
        if (dn.type === 'ALL' && tn !== r._type && tn !== 'CNAME') return;
        var data = tn === 'TXT' ? txt(a.data) : a.data;
        if (seen[tn + ' ' + a.name + ' ' + data]) return; // a CNAME shows up in every type's answer
        seen[tn + ' ' + a.name + ' ' + data] = 1;
        any = true;
        html += '<div class="ni-drow"><span class="ni-dt">' + esc(tn) + '</span><button type="button" class="ni-dd ni-copyv" data-copy="' + esc(data) + '" title="Copy">' + esc(data) + '</button><span class="ni-dttl">' + (a.TTL != null ? a.TTL + 's' : '') + '</span></div>';
      });
    });
    var first = dn.res[0] || {};
    var meta = esc(dn.name) + ' \u00b7 ' + esc(RESOLVERS[dn.rk].name) + (first._ms ? ' \u00b7 ' + Math.round(first._ms) + ' ms' : '') + (first.AD ? ' \u00b7 DNSSEC \u2713' : '');
    if (!any) html += '<div class="ni-note">' + (status === 'NXDOMAIN' ? 'NXDOMAIN \u2014 this name doesn\u2019t exist.' : status ? status : 'No ' + (dn.type === 'ALL' ? '' : dn.type + ' ') + 'records.') + '</div>';
    box.innerHTML = '<div class="ni-sub">' + meta + (status && any ? ' \u00b7 ' + status : '') + '</div><div class="ni-drows">' + html + '</div>';
  }

  // ---- report -------------------------------------------------------------------------------
  function report() {
    var st = S; if (!st) return '';
    var L = [], c = conn();
    L.push('Network report \u2014 ' + new Date().toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }));
    var line = 'Status: ' + (navigator.onLine === false ? 'offline' : 'online');
    if (c) {
      if (c.type) line += ' \u00b7 ' + c.type;
      if (c.effectiveType) line += ' \u00b7 ' + c.effectiveType;
      if (c.downlink != null) line += ' \u00b7 ~' + c.downlink + ' Mbps';
      if (c.rtt != null) line += ' \u00b7 RTT ~' + c.rtt + ' ms';
      if (c.saveData) line += ' \u00b7 data saver';
    }
    L.push(line);
    var ip = st.ip;
    if (ip && !ip.err) {
      L.push('Public IPv4: ' + (ip.v4 || '\u2014'));
      L.push('Public IPv6: ' + (ip.v6 || '\u2014'));
      var g = ip.geo || {};
      if (g.isp || g.org) L.push('Provider: ' + (g.isp || g.org) + (g.asn ? ' (AS' + g.asn + ')' : ''));
      if (g.city || g.country) L.push('Location: ' + [g.city, g.region, g.country].filter(Boolean).join(', ') + ' (approx.)');
      var t = ip.trace || {};
      if (t.colo) L.push('Cloudflare: ' + t.colo + (t.http ? ' \u00b7 ' + t.http.toUpperCase() : '') + (t.tls ? ' \u00b7 ' + t.tls : ''));
    }
    var ps = st.ping && pingStats(st.ping.samples);
    if (ps) L.push('Latency: ' + ms1(ps.med) + ' ms median (best ' + ms1(ps.min) + ', jitter ' + ms1(ps.jit) + ') over ' + ps.n + ' pings');
    var sp = st.speed;
    if (sp && (sp.down.length || sp.up.length)) {
      var d = speedResult(sp.down), u = speedResult(sp.up);
      L.push('Speed: \u2193 ' + (d != null ? fmtMbps(d) + ' Mbps' : '\u2014') + ' \u00b7 \u2191 ' + (u != null ? fmtMbps(u) + ' Mbps' : '\u2014'));
    }
    var dn = st.dns;
    if (dn && !dn.busy && dn.res.length) {
      var recs = [];
      dn.res.forEach(function (r) {
        (r.Answer || []).forEach(function (a) {
          var x = (DNS_TYPES[a.type] || a.type) + ' ' + (DNS_TYPES[a.type] === 'TXT' ? txt(a.data) : a.data);
          if (recs.indexOf(x) === -1) recs.push(x);
        });
      });
      L.push('DNS ' + dn.name + ' ' + dn.type + ' (' + RESOLVERS[dn.rk].name + '): ' + (recs.length ? recs.slice(0, 12).join(' | ') : 'no records'));
    }
    return L.join('\n');
  }

  // ---- open / close -------------------------------------------------------------------------
  function close() {
    var p = panel();
    if (p) { p.remove(); if (p._onClose) p._onClose(); }
  }
  function card(cls, title, btn) {
    return '<section class="ni-card"><div class="ni-h"><span>' + title + '</span>' + (btn || '') + '</div><div class="' + cls + '"></div></section>';
  }

  function open() {
    Cade.closeAllMenus();
    if (panel()) { close(); return; }
    var prefs = readJSON(PREFS_KEY, {}) || {};
    prefs = { auto: !!prefs.auto, resolver: prefs.resolver === 'g' ? 'g' : 'cf' };
    var p = Cade.mkPanel(PANEL_ID, '\u21c5 Network Info',
      '<div class="ni-scroll">' +
        card('ni-status', 'Connection') +
        card('ni-ip', 'Public IP', '<button type="button" class="ni-hbtn primary ni-ipbtn">Check</button>') +
        card('ni-ping', 'Latency', '<button type="button" class="ni-hbtn ni-pingbtn">\u25b6 Ping</button>') +
        card('ni-speed', 'Speed test', '<button type="button" class="ni-hbtn ni-speedbtn">\u25b6 Run test</button>') +
        '<section class="ni-card"><div class="ni-h"><span>DNS lookup</span><span class="ni-resolvers" role="group" aria-label="Resolver">' +
          '<button type="button" class="ni-res" data-r="cf">Cloudflare</button><button type="button" class="ni-res" data-r="g">Google</button></span></div>' +
          '<form class="ni-dform" autocomplete="off"><input class="ni-dq" type="text" inputmode="url" placeholder="example.com" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="Domain name">' +
          '<select class="ni-dtype" aria-label="Record type">' + ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA', 'HTTPS', 'ALL'].map(function (t) { return '<option' + (t === 'A' ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select>' +
          '<button type="submit" class="ni-hbtn primary">Look up</button></form>' +
          '<div class="ni-dres"></div></section>' +
      '</div>' +
      '<div class="ni-foot"><button type="button" class="ni-btn primary ni-insert">\u21b5 Insert report</button><button type="button" class="ni-btn ni-copy">\u29c9 Copy report</button></div>');
    var st = S = { p: p, prefs: prefs, ip: null, ipBusy: false, ipSeq: 0, ping: null, pingBusy: false, speed: null, speedBusy: false, dns: null, dnsSeq: 0 };
    function save() { writeJSON(PREFS_KEY, st.prefs); }

    p.addEventListener('click', function (e) {
      var t = e.target; if (!t.closest) return;
      var b;
      if (t.closest('.ni-ipbtn')) checkIP();
      else if (t.closest('.ni-pingbtn')) { if (st.pingBusy) { if (st.pingCtrl) st.pingCtrl.abort(); } else runPing(); }
      else if (t.closest('.ni-speedbtn')) { if (st.speedBusy) { if (st.speedCtrl) st.speedCtrl.abort(); } else runSpeed(); }
      else if ((b = t.closest('.ni-res'))) { st.prefs.resolver = b.getAttribute('data-r'); save(); renderDNS(); }
      else if ((b = t.closest('.ni-copyv'))) { var v = b.getAttribute('data-copy'); if (v) copyText(v, v.length > 40 ? 'record' : v); }
      else if (t.closest('.ni-copy')) copyText(report(), 'network report');
      else if (t.closest('.ni-insert')) {
        var ed = Cade.editor; if (!ed) return;
        if (ed.state.readOnly) { Cade.showToast('Read-only mode \u2014 editing is locked', 'error', 2000); return; }
        ed.dispatch(ed.state.replaceSelection(report()), { userEvent: 'input', scrollIntoView: true });
        Cade.showToast('Inserted network report', 'success', 1200);
      }
    });
    p.addEventListener('change', function (e) {
      if (e.target.classList && e.target.classList.contains('ni-autochk')) { st.prefs.auto = e.target.checked; save(); }
    });
    p.querySelector('.ni-dform').addEventListener('submit', function (e) { e.preventDefault(); runDNS(); });
    p.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    });
    var onNet = function () { renderStatus(); };
    window.addEventListener('online', onNet);
    window.addEventListener('offline', onNet);
    var c = conn();
    if (c && c.addEventListener) c.addEventListener('change', onNet);
    p._onClose = function () {
      window.removeEventListener('online', onNet);
      window.removeEventListener('offline', onNet);
      if (c && c.removeEventListener) c.removeEventListener('change', onNet);
      if (st.pingCtrl) st.pingCtrl.abort();
      if (st.speedCtrl) st.speedCtrl.abort();
      st.dnsSeq++; st.ipSeq++;
      if (S === st) S = null;
    };
    renderStatus(); renderIP(); renderPing(); renderSpeed(); renderDNS();
    if (st.prefs.auto && navigator.onLine !== false) checkIP();
  }

  Cade.registerWidget({
    name: 'Network Info',
    description: 'Public IP & ISP, connection, latency, speed test and DNS lookup',
    icon: '\u21c5',
    tags: 'network,ip,ip address,ipv4,ipv6,isp,asn,ping,latency,speed test,bandwidth,dns,lookup,dig,mx,txt,connection,wifi,online',
    open: open,
    _test: { parseTrace: parseTrace, pingStats: pingStats, cleanHost: cleanHost, txt: txt, speedResult: speedResult, report: report,
      setState: function (s) { S = s; } },
  });
})();
