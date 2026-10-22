/* AI — the service behind the AI widget (ai.js) and the sharing plugin
 * (ai-host.js); it also provides Cade.ai for other modules. Needs ai-core.js
 * (window.__cadeAiCore) loaded first — it loads it itself when missing.
 *
 * Settings live in two places:
 *   - Widget preferences "AI" (Cade.prefs('ai')): server type, address,
 *     default model, temperature, lengths, system prompt, sharing… These may
 *     be synced between devices (an opt-in of the prefs page), so they never
 *     decide on their own what a device does:
 *   - this device only (Cade.store "cade-ai-local:<device id>"): its ROLE —
 *     'local' (the model runs here) or 'remote' (use another device through
 *     Sync) — the preferred host and the API key. An API key is never synced.
 *
 * Routing (Cade.ai.chat, the widget): role 'local' → the server on this
 * computer, straight from the page; otherwise the newest online host of this
 * account (or the preferred one) through the encrypted relay (ai-core.js).
 *
 * Hosting: the plugin calls host.enable(ask); while enabled AND this device's
 * role is 'local' AND Sync is set up, one tab per browser (a Web Lock) holds
 * the presence entry and answers questions. Pages in the background keep
 * hosting (that is the point: the phone asks while the laptop's txt tab sits
 * behind other windows); timers there are throttled, so the heartbeat is 30 s
 * and a host counts as gone after 90 s of silence.
 *
 * The "Share with my other devices" pref and the plugin's Settings toggle
 * (plugins.ai-host) mirror each other on a 'local' device: a change of either
 * applies to the other while the service is in use (widget open or plugin on);
 * reconcile() catches up on what changed in between. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Cade || window.__cadeAi) return;
  var Cade = window.Cade;
  var BASE = (function () {
    try { var cs = document.currentScript; if (cs && cs.src) return cs.src.slice(0, cs.src.lastIndexOf('/') + 1); } catch (e) {}
    return Cade.baseURL();
  })();
  if (!window.__cadeAiCore) {
    var s0 = document.createElement('script');
    s0.src = BASE + 'ai-core.js';
    s0.onload = function () { boot(); };
    document.head.appendChild(s0);
    return;
  }
  boot();

  function boot() {
    if (window.__cadeAi || !window.__cadeAiCore) return;
    var C = window.__cadeAiCore;
    var ID = 'ai', PLUGIN_ID = 'ai-host', SETTING = 'plugins.ai-host', LOCK = 'cade-ai-host';

    // ---- prefs ---------------------------------------------------------------------------------
    var fallback = null;
    function prefsOf() {
      if (Cade.prefs) { try { return Cade.prefs(ID); } catch (e) {} }
      if (fallback) return fallback;
      var d = {}, ls = [];
      C.PREFS.forEach(function (f) { if (f.key) d[f.key] = f.default; });
      function all() { var o = {}; for (var k in d) o[k] = d[k]; return o; }
      fallback = {
        get: function (k) { return d[k]; }, all: all,
        set: function (k, v) { if (d[k] === v) return true; d[k] = v; ls.slice().forEach(function (fn) { try { fn(k, v, all()); } catch (e) {} }); return true; },
        on: function (fn) { ls.push(fn); return function () { var i = ls.indexOf(fn); if (i >= 0) ls.splice(i, 1); }; }
      };
      return fallback;
    }
    var P = prefsOf();
    function pref(k) {
      var v;
      try { v = P.get(k); } catch (e) {}
      return v === undefined || v === null ? C.PREF_DEFAULTS[k] : v;
    }

    // ---- this device -------------------------------------------------------------------------------
    var listeners = {};
    function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return function () { var l = listeners[ev] || [], i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }; }
    function emit(ev, a) { (listeners[ev] || []).slice().forEach(function (fn) { try { fn(a); } catch (e) { console.error('ai ' + ev, e); } }); }
    function dev() {
      try { return Cade.cloud.device; } catch (e) { return { id: 'local', tab: '0', inst: 'local-0', name: 'This device', kind: 'desktop' }; }
    }
    function localKey() { return 'cade-ai-local:' + dev().id; }
    function local() {
      try { var o = JSON.parse(Cade.store.get(localKey()) || 'null'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; }
    }
    function setLocal(patch) {
      var o = local(), was = o.role;
      for (var k in patch) { if (patch[k] === undefined || patch[k] === null || patch[k] === '') delete o[k]; else o[k] = patch[k]; }
      try { if (Object.keys(o).length) Cade.store.set(localKey(), JSON.stringify(o)); else Cade.store.remove(localKey()); } catch (e) {}
      if ('key' in patch || 'role' in patch) modelCache = null;
      emit('config', o);
      if (o.role !== was) syncHost();
      return o;
    }
    function env(extra) {
      var s = C.sniff(navigator.userAgent, navigator.maxTouchPoints || 0);
      var o = { os: s.os, browser: s.browser, ios: s.ios, origin: location.origin, secure: location.protocol === 'https:', provider: pref('provider'), timeoutS: pref('timeout') };
      for (var k in extra || {}) if (extra[k] != null) o[k] = extra[k];
      return o;
    }
    // Attach a user-facing explanation (title + fix steps for this OS/browser).
    function decorate(e, extra) {
      if (!e || typeof e !== 'object') e = C.AiError('server', String(e));
      if (!e.code) e.code = C.isAbort(e) ? 'aborted' : 'server';
      e.info = C.explain(e.code, env(Object.assign({ detail: e.detail || (e.code === 'server' ? e.message : '') }, extra || {})));
      return e;
    }

    // ---- the server on this computer ------------------------------------------------------------
    function server(over) {
      over = over || {};
      var pv = over.provider || pref('provider'), pre = C.presetOf(pv);
      var raw = String(over.url != null ? over.url : (pref('endpoint') || '')).trim();
      return { provider: pre.id, kind: pre.kind, base: C.normBase(pre.kind, raw || pre.url), apiKey: over.key != null ? over.key : (local().key || ''), label: pre.label, preset: pre.url };
    }
    var fetchImpl = function (u, i) { return window.fetch(u, i); };
    var mkReq = function (u, i) { return new Request(u, i); };
    function mixedBlocked(url) { var e = env(); return e.secure && e.browser === 'safari' && C.isHttp(url); }
    function lnaState() {
      var pm = navigator.permissions;
      if (!pm || !pm.query) return Promise.resolve('');
      return pm.query({ name: 'loopback-network' }).catch(function () { return pm.query({ name: 'local-network-access' }); })
        .then(function (r) { return (r && r.state) || ''; }, function () { return ''; });
    }
    // A failed fetch → which of unreachable / cors / mixed / lna it was.
    function refine(e, url) {
      if (!e || e.code !== 'network') return Promise.resolve(e);
      if (mixedBlocked(url)) { e.code = 'mixed'; return Promise.resolve(e); }
      return Promise.all([C.probe(fetchImpl, url, { timeoutMs: 2500, Request: mkReq }), lnaState()]).then(function (r) {
        e.code = C.refineNetwork(r[0].state, { lna: r[1] });
        return e;
      }, function () { e.code = 'unreachable'; return e; });
    }
    var modelCache = null;
    function localModels(force, over) {
      var s = server(over), key = s.kind + ' ' + s.base + ' ' + (s.apiKey ? 'k' : '');
      if (!force && !over && modelCache && modelCache.key === key && Date.now() - modelCache.at < 30000) return Promise.resolve(modelCache);
      return C.listModels(fetchImpl, { kind: s.kind, base: s.base, apiKey: s.apiKey, timeoutMs: 6000, Request: mkReq }).then(function (r) {
        var mc = { key: key, at: Date.now(), list: r.models, ms: r.ms, server: s };
        if (!over) modelCache = mc;
        return mc;
      }, function (e) {
        if (!over) modelCache = null;
        return refine(e, C.modelsUrl(s.kind, s.base)).then(function (e2) { throw decorate(e2, { base: s.base, provider: s.provider }); });
      });
    }
    // Look for servers on the usual ports → [{ provider, name, base, state: ok|blocked|auth, ms, models }]
    function detect() {
      if (mixedBlocked('http://127.0.0.1')) return Promise.resolve({ list: [], mixed: true });
      return Promise.all(C.DETECT.map(function (d) {
        var kind = C.kindOf(d.provider), url = C.modelsUrl(kind, d.base);
        // "running but blocking" only matters for the two well-known servers
        return C.probe(fetchImpl, url, { timeoutMs: 3000, Request: mkReq, noCors: d.provider !== 'openai' }).then(function (p) {
          var r = { provider: d.provider, name: d.name, base: d.base, state: p.state, ms: p.ms, models: [] };
          if (p.state === 'ok') {
            if (p.status >= 200 && p.status < 300) {
              try {
                var j = JSON.parse(p.body);
                if (kind === 'ollama' ? !Array.isArray(j && j.models) : !(j && Array.isArray(j.data))) r.state = 'other';
                else r.models = C.parseModels(kind, j);
              } catch (e) { r.state = 'other'; }
            } else r.state = (p.status === 401 || p.status === 403) ? 'auth' : 'other';
          }
          // an unknown service on a generic port isn't worth mentioning
          if (r.state === 'blocked' && d.provider === 'openai') r.state = 'other';
          return r;
        });
      })).then(function (l) {
        return lnaState().then(function (lna) { return { list: l.filter(function (r) { return r.state === 'ok' || r.state === 'blocked' || r.state === 'auth'; }), lna: lna }; });
      });
    }
    function stripThink(t) { return String(t || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim(); }
    // Setup's "Test connection": models + latency, then a one-word answer.
    // over: { provider, url, key, model }; onStage(stage, result) as it goes.
    function testLocal(over, onStage) {
      over = over || {};
      return localModels(true, over).then(function (mc) {
        var res = { ok: true, ms: mc.ms, models: mc.list, server: mc.server, model: '', reply: '', genMs: 0, genError: null };
        var m = C.pickModel(over.model || pref('model'), mc.list);
        res.model = m;
        if (onStage) onStage('models', res);
        if (!m) return res;
        var s = mc.server;
        return C.chatStream(fetchImpl, { kind: s.kind, base: s.base, apiKey: s.apiKey, model: m, messages: [{ role: 'user', content: 'Reply with just the word: OK' }],
          temperature: 0, maxTokens: 32, timeoutMs: 60000, firstTimeoutMs: 180000, signal: over.signal, Request: mkReq })
          .then(function (r) { res.reply = stripThink(r.text).slice(0, 80) || '…'; res.genMs = r.ms; res.firstMs = r.firstMs; return res; },
            function (e) { return refine(e, s.base).then(function (e2) { res.genError = decorate(e2, { base: s.base, model: m, provider: s.provider }); return res; }); });
      });
    }
    function chatLocal(messages, o) {
      var s = server();
      return localModels(false).catch(function (e) { if (e && e.code !== 'notfound' && e.code !== 'auth') throw e; return null; }).then(function (mc) {
        var model = o.model || C.pickModel(pref('model'), mc ? mc.list : null);
        if (!model) throw decorate(C.AiError('model', 'No model installed'), { base: s.base });
        if (o.onStart) o.onStart({ via: 'local', model: model, host: null });
        var tmo = pref('timeout') * 1000;
        return C.chatStream(fetchImpl, {
          kind: s.kind, base: s.base, apiKey: s.apiKey, model: model, messages: messages,
          temperature: o.temperature != null ? o.temperature : pref('temperature'), maxTokens: o.maxTokens || pref('maxTokens'), numCtx: pref('contextWindow'),
          signal: o.signal, timeoutMs: tmo, firstTimeoutMs: Math.max(tmo, 60000), onDelta: o.onToken, onThinking: o.onThinking, Request: mkReq
        }).then(function (r) { r.via = 'local'; r.host = null; return r; }, function (e) {
          if (e && e.code === 'model') modelCache = null;
          return refine(e, s.base).then(function (e2) { throw decorate(e2, { base: s.base, model: model, provider: s.provider }); });
        });
      });
    }

    // ---- other devices (relay) ---------------------------------------------------------------------
    var cloud = {
      ref: function (sub) { return Cade.cloud.ref('ai', sub); },
      seal: function (o) { return Cade.cloud.seal(o); },
      unseal: function (s) { return Cade.cloud.unseal(s); },
      ts: function () { return Cade.cloud.TIMESTAMP; },
      now: function () { return Cade.cloud.serverNow(); }
    };
    var timers = {
      setTimeout: function (f, ms) { return setTimeout(f, ms); }, clearTimeout: function (t) { clearTimeout(t); },
      setInterval: function (f, ms) { return setInterval(f, ms); }, clearInterval: function (t) { clearInterval(t); }
    };
    var client = null;
    function relay() { return client || (client = C.createRelayClient({ cloud: cloud, device: dev, timers: timers })); }
    function synced() { try { return !!Cade.cloud.configured(); } catch (e) { return false; } }
    var hostsCache = null, hostsAt = 0, watchers = [], stopWatch = null;
    function publishHosts(list) { hostsCache = list || []; hostsAt = Date.now(); watchers.slice().forEach(function (f) { try { f(hostsCache); } catch (e) {} }); }
    // cb(hosts) now and on changes while watched; returns off().
    function watchHosts(cb) {
      watchers.push(cb);
      if (!synced()) { setTimeout(function () { if (watchers.indexOf(cb) >= 0) cb([]); }, 0); }
      else {
        if (hostsCache && stopWatch) setTimeout(function () { if (watchers.indexOf(cb) >= 0) cb(hostsCache); }, 0);
        if (!stopWatch) stopWatch = relay().watchHosts(publishHosts);
      }
      return function () {
        var i = watchers.indexOf(cb);
        if (i >= 0) watchers.splice(i, 1);
        if (!watchers.length && stopWatch) { stopWatch(); stopWatch = null; }
      };
    }
    function listHosts() {
      if (!synced()) return Promise.resolve([]);
      if (hostsCache && (stopWatch || Date.now() - hostsAt < 10000)) return Promise.resolve(hostsCache);
      return relay().listHosts().then(function (l) { hostsCache = l || []; hostsAt = Date.now(); return hostsCache; }, function () { return []; });
    }
    function hostModel(h, want) {
      want = want || pref('model');
      if (want && h.models.indexOf(want) >= 0) return want;
      return h.model || h.models[0] || '';
    }
    var visHooked = false;
    function onVis() {
      if (document.visibilityState !== 'visible' || !client) return;
      client.resume();
      if (!client.pending()) { document.removeEventListener('visibilitychange', onVis); visHooked = false; }
    }
    function chatHost(h, messages, o) {
      var model = o.model || hostModel(h);
      if (o.onStart) o.onStart({ via: 'host', model: model, host: h.name });
      if (!visHooked) { visHooked = true; document.addEventListener('visibilitychange', onVis); }
      return relay().request(h, {
        model: model, messages: messages,
        temperature: o.temperature != null ? o.temperature : pref('temperature'), maxTokens: o.maxTokens || pref('maxTokens')
      }, { signal: o.signal, timeoutMs: pref('timeout') * 1000, onDelta: o.onToken, onEvent: o.onEvent }).then(function (r) {
        r.via = 'host'; r.host = h.name; r.model = r.model || model;
        return r;
      }, function (e) { throw decorate(e, { host: h.name, model: model, provider: h.provider }); });
    }
    function testHost(h, signal) {
      var t0 = Date.now();
      return chatHost(h, [{ role: 'user', content: 'Reply with just the word: OK' }], { maxTokens: 32, temperature: 0, signal: signal })
        .then(function (r) { return { ok: true, reply: stripThink(r.text).slice(0, 80) || '…', ms: Date.now() - t0, model: r.model }; },
          function (e) { return { ok: false, error: e, ms: Date.now() - t0 }; });
    }

    // ---- routing ----------------------------------------------------------------------------------
    // → { available, via: 'local'|'host'|null, host (presence) | null, model, models, reason, error }
    function route() {
      var lc = local(), role = lc.role || '';
      if (role === 'local') {
        var s = server();
        return localModels(false).then(function (mc) {
          var m = C.pickModel(pref('model'), mc.list);
          if (!m) return { available: false, via: 'local', host: null, model: '', models: [], server: s, reason: 'model', error: decorate(C.AiError('model', 'No model installed'), { base: s.base }) };
          return { available: true, via: 'local', host: null, model: m, models: C.chatModels(mc.list).map(function (x) { return x.name; }), server: s, ms: mc.ms };
        }, function (e) { return { available: false, via: 'local', host: null, model: pref('model') || '', models: [], server: s, reason: e.code, error: e }; });
      }
      if (!synced()) {
        var code = role === 'remote' ? 'nosync' : 'not-setup';
        return Promise.resolve({ available: false, via: null, host: null, model: '', models: [], reason: code, error: decorate(C.AiError(code, code)) });
      }
      return listHosts().then(function (hosts) {
        var h = C.pickHost(hosts, lc.host);
        if (!h) {
          var c2 = role ? 'host-offline' : 'not-setup';
          return { available: false, via: role ? 'host' : null, host: null, hosts: hosts, model: '', models: [], reason: c2, error: decorate(C.AiError(c2, c2)) };
        }
        if (!h.ok) return { available: false, via: 'host', host: h, hosts: hosts, model: hostModel(h), models: h.models, reason: 'host-unready', error: decorate(C.AiError('host-unready', 'unready'), { host: h.name }) };
        return { available: true, via: 'host', host: h, hosts: hosts, model: hostModel(h), models: h.models };
      });
    }
    // o: { model, temperature, maxTokens, signal, onToken(delta, full), onStart({via, model, host}), onEvent(msg), onThinking }
    function chat(messages, o) {
      o = o || {};
      return route().then(function (r) {
        if (r.via === 'local') return chatLocal(messages, o);
        if (!r.available) throw r.error;
        return chatHost(r.host, messages, o);
      });
    }

    // ---- hosting --------------------------------------------------------------------------------------
    var H = { enabled: false, ask: null, phase: 'off', relay: null, lockAbort: null, lockRelease: null, retryT: 0, modelsT: 0, ok: true, last: null };
    function hostStatus() {
      var r = H.relay ? H.relay.status() : {};
      return { enabled: H.enabled, phase: H.phase, online: !!r.online, busy: !!r.busy, queued: r.queued || 0, served: r.served || 0, current: r.current || null, ok: H.ok };
    }
    function hostChanged() { emit('host', hostStatus()); }
    function hostWanted() { return H.enabled && local().role === 'local'; }
    function syncHost() {
      if (hostWanted()) { if (H.phase === 'off' || H.phase === 'not-local') startHost(); }
      else if (H.phase !== 'off') stopHost(H.enabled ? 'not-local' : 'off');
    }
    function startHost() {
      clearTimeout(H.retryT); H.retryT = 0;
      if (!synced()) { H.phase = 'nosync'; hostChanged(); H.retryT = setTimeout(syncHostRetry, 30000); return; }
      H.phase = 'standby'; hostChanged();
      var go = function () {
        H.phase = 'starting'; hostChanged();
        return localModels(true).then(function () { H.ok = true; }, function () { H.ok = false; }).then(function () {
          if (!hostWanted() || H.phase !== 'starting') return;
          H.relay = C.createRelayHost({
            cloud: cloud, device: dev, timers: timers,
            info: function () {
              var l = modelCache ? C.chatModels(modelCache.list) : [];
              return { models: l.map(function (m) { return m.name; }), model: C.pickModel(pref('model'), modelCache ? modelCache.list : []), ok: H.ok, provider: pref('provider') };
            },
            policy: function () { return pref('policy') === 'ask' ? 'ask' : 'auto'; },
            ask: function (job) { return H.ask ? H.ask(job) : Promise.resolve(true); },
            run: hostRun,
            onChange: hostChanged
          });
          return H.relay.start().then(function (ok) {
            if (!hostWanted()) { if (H.relay) H.relay.stop(); return; }
            if (!ok) { H.phase = 'retry'; H.relay = null; hostChanged(); H.retryT = setTimeout(syncHostRetry, 30000); return; }
            H.phase = 'live'; hostChanged();
            var ticks = 0;
            H.modelsT = setInterval(function () { if (!H.ok || ++ticks % 10 === 0) refreshHostModels(); }, 60000);
          });
        });
      };
      if (navigator.locks && navigator.locks.request && typeof AbortController !== 'undefined') {
        var ac = new AbortController();
        H.lockAbort = ac;
        navigator.locks.request(LOCK, { signal: ac.signal }, function () {
          H.lockAbort = null;
          if (!hostWanted()) return;
          return new Promise(function (release) { H.lockRelease = release; go(); });
        }).catch(function () {});
      } else go();
    }
    function syncHostRetry() { H.retryT = 0; if (hostWanted()) { H.phase = 'off'; syncHost(); } }
    function refreshHostModels() {
      return localModels(true).then(function () { H.ok = true; }, function () { H.ok = false; }).then(function () { if (H.relay) H.relay.refresh(); });
    }
    function stopHost(phase) {
      clearTimeout(H.retryT); H.retryT = 0;
      clearInterval(H.modelsT); H.modelsT = 0;
      if (H.lockAbort) { try { H.lockAbort.abort(); } catch (e) {} H.lockAbort = null; }
      var r = H.relay; H.relay = null;
      var rel = H.lockRelease; H.lockRelease = null;
      H.phase = phase || 'off';
      var p = r ? r.stop() : Promise.resolve();
      Promise.resolve(p).then(function () { if (rel) rel(); });
      hostChanged();
    }
    function hostRun(job, h) {
      var s = server();
      return localModels(false).catch(function () { return null; }).then(function (mc) {
        var list = mc ? mc.list : null, names = C.chatModels(list).map(function (m) { return m.name; });
        var m = job.req.model && (!list || names.indexOf(job.req.model) >= 0) ? job.req.model : C.pickModel(pref('model'), list);
        if (!m) throw C.AiError('model', 'No model installed here');
        h.model(m);
        var tmo = pref('timeout') * 1000;
        return C.chatStream(fetchImpl, {
          kind: s.kind, base: s.base, apiKey: s.apiKey, model: m, messages: job.req.messages,
          temperature: job.req.temperature, maxTokens: Math.min(job.req.maxTokens, C.RELAY.MAX_TOKENS), numCtx: pref('contextWindow'),
          signal: h.signal, timeoutMs: tmo, firstTimeoutMs: Math.max(tmo, 60000), onDelta: h.onDelta, onThinking: h.onThinking, Request: mkReq
        }).then(function (r) { H.ok = true; return { reason: r.reason, usage: r.usage, model: m }; }, function (e) {
          return refine(e, s.base).then(function (e2) {
            if (e2.code === 'unreachable' || e2.code === 'cors' || e2.code === 'model') { H.ok = e2.code === 'model'; refreshHostModels(); }
            if (e2.code === 'unreachable' || e2.code === 'cors') e2.code = 'host-unready';
            throw e2;
          });
        });
      });
    }

    // ---- the share switch ↔ the plugin toggle ------------------------------------------------------
    function pluginSetting() {
      try { var S = Cade.Settings; return S ? S.get(SETTING) : undefined; } catch (e) { return undefined; }
    }
    function loadScript(src) {
      return new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = src; s.async = true; s.onload = function () { res(); }; s.onerror = function () { rej(new Error('load ' + src)); };
        document.head.appendChild(s);
      });
    }
    function setPlugin(want) {
      want = !!want;
      var cur = pluginSetting();
      if (cur !== undefined) { if (!!cur !== want) Cade.Settings.set(SETTING, want); return; }
      // No manifest entry for the plugin (development): add / remove it by hand.
      if (want) {
        if (window.__pluginLoaded && window.__pluginLoaded(PLUGIN_ID)) { if (window.__enablePlugin) window.__enablePlugin(PLUGIN_ID); }
        else loadScript(BASE + 'ai-host.js').catch(function () {});
      } else Cade.unregisterPlugin(PLUGIN_ID);
    }
    function pluginIsOn() {
      var cur = pluginSetting();
      return cur !== undefined ? !!cur : H.enabled;
    }
    function setShare(want) {
      want = !!want;
      setLocal({ shareSeen: want });
      try { P.set('share', want); } catch (e) {}
      if (local().role === 'local' || !want) setPlugin(want);
    }
    function onPref(k, v) {
      if (k === 'share') {
        setLocal({ shareSeen: !!v });
        if (local().role === 'local' || !v) setPlugin(!!v);
      } else if (k === 'policy') { if (H.relay) H.relay.refresh(); }
      else if (k === 'provider' || k === 'endpoint') { modelCache = null; if (H.relay) refreshHostModels(); }
      else if (k === 'model') { if (H.relay) H.relay.refresh(); }
      emit('prefs', k);
    }
    // Catch up on changes made while nothing of AI was loaded.
    function reconcile() {
      var lc = local();
      if (lc.role !== 'local') return;
      var pv = !!pref('share'), sv = pluginIsOn();
      if (lc.shareSeen !== undefined && pv !== !!lc.shareSeen) { setLocal({ shareSeen: pv }); if (pv !== sv) setPlugin(pv); return; }
      if (pv !== sv) { try { P.set('share', sv); } catch (e) {} }
      if (lc.shareSeen !== sv) setLocal({ shareSeen: sv });
    }
    var users = 0, offPrefs = null;
    // The widget (while open) and the plugin (while on) hold the service.
    function use() {
      if (++users === 1) { try { offPrefs = P.on(onPref); } catch (e) {} }
      reconcile();
      var done = false;
      return function () {
        if (done) return;
        done = true;
        if (--users <= 0) { users = 0; if (offPrefs) { offPrefs(); offPrefs = null; } }
      };
    }

    // ---- Cade.ai ------------------------------------------------------------------------------------
    function normMessages(m) {
      if (typeof m === 'string') m = [{ role: 'user', content: m }];
      m = (Array.isArray(m) ? m : []).filter(function (x) { return x && typeof x.content === 'string' && ['system', 'user', 'assistant'].indexOf(x.role) >= 0; })
        .map(function (x) { return { role: x.role, content: x.content }; });
      if (!m.some(function (x) { return x.role === 'system'; })) {
        var sys = String(pref('system') || '').trim();
        if (sys) m.unshift({ role: 'system', content: sys });
      }
      return m;
    }
    var api = {
      version: 1,
      // → Promise<{ available, via: 'local'|'host'|null, host: name|null, model, reason, message, setup }>
      status: function () {
        return route().then(function (r) {
          return { available: !!r.available, via: r.available ? r.via : null, host: r.host ? r.host.name : null, model: r.model || null,
            reason: r.available ? null : (r.reason || null), message: r.available ? '' : (r.error && r.error.info ? r.error.info.title : ''), setup: !!local().role };
        });
      },
      // messages: a string or [{role, content}] (the system prompt from AI preferences is
      // added when none is given) → Promise<full text>. Rejects an Error with .code,
      // .info { title, steps } and .partial (text so far).
      chat: function (messages, o) {
        o = o || {};
        return chat(normMessages(messages), { model: o.model, temperature: o.temperature, maxTokens: o.maxTokens, signal: o.signal,
          onToken: typeof o.onToken === 'function' ? o.onToken : null }).then(function (r) { return r.text; });
      },
      // → Promise<[model names]> of whatever would answer.
      models: function () { return route().then(function (r) { return r.models || []; }); },
      // Open the AI panel.
      open: function () { return Cade.runCommand('AI'); }
    };
    Cade.ai = api;

    window.__cadeAi = {
      core: C, P: P, pref: pref, local: local, setLocal: setLocal, server: server, env: env, decorate: decorate, on: on, use: use,
      detect: detect, testLocal: testLocal, localModels: localModels, route: route, chat: chat, chatLocal: chatLocal,
      watchHosts: watchHosts, listHosts: listHosts, testHost: testHost, hostModel: hostModel, synced: synced, device: dev,
      setShare: setShare, setPlugin: setPlugin, pluginIsOn: pluginIsOn, reconcile: reconcile, api: api,
      host: {
        enable: function (ask) { H.enabled = true; H.ask = ask || null; syncHost(); },
        disable: function () { H.enabled = false; H.ask = null; syncHost(); },
        status: hostStatus, refresh: refreshHostModels
      }
    };
  }
})();
