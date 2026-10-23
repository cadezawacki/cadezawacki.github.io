/* AI — the service behind the AI widget (ai.js) and the sharing plugin
 * (ai-host.js); it also provides Cade.ai for other modules. Needs ai-core.js
 * (window.__cadeAiCore) loaded first — it loads it itself when missing.
 *
 * Settings live in two places:
 *   - Widget preferences "AI" (Cade.prefs('ai')): default model, answer
 *     length, temperature, system prompt, sharing switches… These may be
 *     synced between devices (an opt-in of the prefs page), so they never
 *     decide on their own what a device does.
 *   - this device only (Cade.store "cade-ai-local:<device id>"): its ROLE —
 *     'local' (it talks to model services itself) or 'remote' (it only asks
 *     another device through Sync) —, the preferred host and its ENDPOINTS:
 *     [{ id, p (provider), url, key, on, allow }]. API keys exist only here:
 *     never in prefs, presence or relay messages.
 *
 * Routing: a model is picked per note (or the prefs default): "this device's
 * <service>" calls that service straight from the page; "<service> on
 * MacBook" goes through the encrypted relay (ai-core.js). A 'remote' device
 * has no endpoints and so never calls a model API — not even to list models
 * or prices: everything it shows comes from the hosts' presence.
 *
 * Badges (price, context, score) are prepared on devices that call services
 * themselves: OpenRouter's public model list and LMArena's text leaderboard,
 * each cached a day in IndexedDB; ai-scores.js is the offline fallback.
 *
 * Hosting: the plugin calls host.enable(ask); while enabled AND this device's
 * role is 'local' AND Sync is set up, one tab per browser (a Web Lock) holds
 * the presence entry and answers questions — local services always, cloud
 * ones only with "Share cloud services too", and only the models each
 * endpoint's allow-list names. Pages in the background keep hosting.
 *
 * The "Share with my other devices" pref and the plugin's Settings toggle
 * (plugins.ai-host) mirror each other on a 'local' device while the service
 * is in use; reconcile() catches up on what changed in between. */
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
    var ID = 'ai', PLUGIN_ID = 'ai-host', SETTING = 'plugins.ai-host', LOCK = 'cade-ai-host', DAY = 24 * 3600e3;

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
    function readLocal() {
      try { var o = JSON.parse(Cade.store.get(localKey()) || 'null'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; }
    }
    function writeLocal(o) {
      try { if (Object.keys(o).length) Cade.store.set(localKey(), JSON.stringify(o)); else Cade.store.remove(localKey()); } catch (e) {}
    }
    // Round-1 setups kept one server in prefs (provider / endpoint) and its key here.
    function migrate(o) {
      if (o.role !== 'local' || Array.isArray(o.endpoints)) return o;
      var raw = {};
      try { raw = JSON.parse(Cade.store.get('cade-prefs:ai') || '{}') || {}; } catch (e) {}
      var pv = raw.provider === 'openai' ? 'custom' : (C.PROVIDERS[raw.provider] ? raw.provider : 'ollama');
      o.endpoints = [{ id: pv, p: pv, url: raw.endpoint || '', key: o.key || '', on: true }];
      delete o.key;
      writeLocal(o);
      return o;
    }
    function local() { return migrate(readLocal()); }
    function setLocal(patch) {
      var o = local(), was = o.role;
      for (var k in patch) { if (patch[k] === undefined || patch[k] === null || patch[k] === '') delete o[k]; else o[k] = patch[k]; }
      writeLocal(o);
      if ('endpoints' in patch || 'role' in patch) { modelCache = {}; }
      emit('config', o);
      if (o.role !== was) syncHost(); else if ('endpoints' in patch && H.relay) refreshHostModels();
      return o;
    }
    function env(extra) {
      var s = C.sniff(navigator.userAgent, navigator.maxTouchPoints || 0);
      var o = { os: s.os, browser: s.browser, ios: s.ios, origin: location.origin, secure: location.protocol === 'https:', timeoutS: pref('timeout') };
      for (var k in extra || {}) if (extra[k] != null) o[k] = extra[k];
      return o;
    }
    // Attach a user-facing explanation (title + fix steps for this OS/browser/provider).
    function decorate(e, extra) {
      if (!e || typeof e !== 'object') e = C.AiError('server', String(e));
      if (!e.code) e.code = C.isAbort(e) ? 'aborted' : 'server';
      e.info = C.explain(e.code, env(Object.assign({ detail: e.detail || (e.code === 'server' ? e.message : '') }, extra || {})));
      return e;
    }

    // ---- endpoints (the services this device calls itself) -------------------------------------------
    function resolveEp(e) {
      var pid = C.PROVIDERS[e.p] ? e.p : C.endpointProvider(e.id) || 'custom', Pv = C.providerOf(pid);
      var url = String(e.url || '').trim();
      return {
        id: e.id, provider: pid, label: Pv.label + (e.id !== pid ? ' ' + e.id.replace(/^\D+/, '') : ''), sub: Pv.sub, kind: Pv.kind, where: Pv.where,
        base: C.normBase(Pv.kind, url || Pv.url), url: url, apiKey: e.key || '', on: e.on !== false, allow: Array.isArray(e.allow) ? e.allow.slice() : [],
        headers: C.providerHeaders(pid, location.origin)
      };
    }
    // The configured endpoints (whatever the role — callers that route check it).
    function endpoints(all) {
      return (local().endpoints || []).map(resolveEp).filter(function (e) { return all || e.on; });
    }
    function endpoint(id) { return endpoints(true).filter(function (e) { return e.id === id; })[0] || null; }
    // Add or change one endpoint: { id, p, url, key, on, allow } (missing fields kept).
    function saveEndpoint(patch) {
      var lc = local(), list = (lc.endpoints || []).slice(), i = -1;
      list.forEach(function (e, j) { if (e.id === patch.id) i = j; });
      var cur = i >= 0 ? list[i] : { id: patch.id, p: patch.p || C.endpointProvider(patch.id) || 'custom', url: '', key: '', on: true };
      var next = {};
      for (var k in cur) next[k] = cur[k];
      for (var k2 in patch) if (patch[k2] !== undefined) next[k2] = patch[k2];
      if (!next.key) delete next.key;
      if (!next.url) delete next.url;
      if (!next.allow || !next.allow.length) delete next.allow;
      if (i >= 0) list[i] = next; else list.push(next);
      delete modelCache[patch.id];
      setLocal({ endpoints: list });
      return resolveEp(next);
    }
    function removeEndpoint(id) {
      var lc = local();
      delete modelCache[id];
      setLocal({ endpoints: (lc.endpoints || []).filter(function (e) { return e.id !== id; }) });
    }
    function newEndpointId(pid) {
      if (pid !== 'custom') return pid;
      var ids = (local().endpoints || []).map(function (e) { return e.id; }), n = 1, id = 'custom';
      while (ids.indexOf(id) >= 0) id = 'custom' + (++n);
      return id;
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
    function refine(e, url, where) {
      if (!e || e.code !== 'network') return Promise.resolve(e);
      if (mixedBlocked(url)) { e.code = 'mixed'; return Promise.resolve(e); }
      return Promise.all([C.probe(fetchImpl, url, { timeoutMs: 2500, Request: mkReq }), where === 'cloud' ? '' : lnaState()]).then(function (r) {
        e.code = C.refineNetwork(r[0].state, { lna: r[1] });
        return e;
      }, function () { e.code = 'unreachable'; return e; });
    }
    var modelCache = {};   // endpoint id → { key, at, list, ms }
    // ep: a resolved endpoint (or an unsaved draft) → Promise<{ list, ms }>
    function epModels(ep, force) {
      var key = ep.kind + ' ' + ep.base + ' ' + (ep.apiKey ? ep.apiKey.slice(-6) : ''), c = modelCache[ep.id];
      if (!force && c && c.key === key && Date.now() - c.at < 60000) return Promise.resolve(c);
      return C.listModels(fetchImpl, { kind: ep.kind, provider: ep.provider, base: ep.base, apiKey: ep.apiKey, timeoutMs: 8000, Request: mkReq }).then(function (r) {
        var mc = { key: key, at: Date.now(), list: r.models, ms: r.ms };
        if (!ep.draft) modelCache[ep.id] = mc;
        return mc;
      }, function (e) {
        if (!ep.draft) delete modelCache[ep.id];
        var rq = C.modelsRequest(ep);
        return refine(e, rq.url, ep.where).then(function (e2) { throw decorate(e2, { base: ep.base, provider: ep.provider }); });
      });
    }

    // ---- badges: prices (OpenRouter), scores (LMArena) -----------------------------------------------
    var B = { catalog: null, scores: null, loading: null, scoresTried: 0, catalogTried: 0 };
    function idbGet(k) { try { return Cade.idbStore ? Cade.idbStore.get(k).catch(function () { return null; }) : Promise.resolve(null); } catch (e) { return Promise.resolve(null); } }
    function idbSet(k, v) { try { if (Cade.idbStore) Cade.idbStore.set(k, v).catch(function () {}); } catch (e) {} }
    function loadScript(src) {
      return new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = src; s.async = true; s.onload = function () { res(); }; s.onerror = function () { rej(new Error('load ' + src)); };
        document.head.appendChild(s);
      });
    }
    function timedFetch(url, ms) {
      var ac = typeof AbortController !== 'undefined' ? new AbortController() : null, t = setTimeout(function () { if (ac) ac.abort(); }, ms);
      return fetchImpl(url, ac ? { signal: ac.signal } : {}).then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); },
        function (e) { clearTimeout(t); throw e; });
    }
    function snapshotScores() {
      var go = function () { var S = window.__cadeAiScores; if (S && !B.scores) { B.scores = C.scoreIndex(S.rows, S.date); B.scores.src = 'snapshot'; } };
      if (window.__cadeAiScores) { go(); return Promise.resolve(); }
      return loadScript(BASE + 'ai-scores.js').then(go, function () {});
    }
    function fetchScores() {
      var rows = [], date = '';
      function page(off) {
        return timedFetch(C.SOURCES.scores + off, 20000).then(function (j) {
          var got = (j && j.rows) || [];
          got.forEach(function (r) { if (r && r.row) { rows.push(r.row); date = date || r.row.leaderboard_publish_date; } });
          if (got.length >= 100 && off < 900) return page(off + 100);
        });
      }
      return page(0).then(function () {
        if (rows.length < 20) throw new Error('short');
        var compact = rows.map(function (r) { return [r.model_name, Math.round(r.rating)]; });
        idbSet('ai-badge-scores', { at: Date.now(), date: date, rows: compact });
        B.scores = C.scoreIndex(compact, date); B.scores.src = 'live';
      });
    }
    function fetchCatalog() {
      return timedFetch(C.SOURCES.catalog, 20000).then(function (j) {
        var idx = C.catalogIndex(j, Date.now());
        if (!idx.count) throw new Error('empty');
        idbSet('ai-badge-catalog', { at: idx.at, byKey: idx.byKey });
        B.catalog = idx;
      });
    }
    // Ready-now data, refreshed in the background (at most once an hour per kind); emits 'badges'.
    function badges(needCatalog) {
      if (local().role !== 'local') return Promise.resolve(B);   // another device's presence carries them
      if (B.loading) return B.loading;
      var work = [];
      if (!B.scores) work.push(idbGet('ai-badge-scores').then(function (c) { if (c && c.rows) { B.scores = C.scoreIndex(c.rows, c.date); B.scores.src = 'cache'; B.scores.at = c.at; } }));
      if (needCatalog && !B.catalog) work.push(idbGet('ai-badge-catalog').then(function (c) { if (c && c.byKey) B.catalog = { at: c.at, byKey: c.byKey, count: Object.keys(c.byKey).length }; }));
      B.loading = Promise.all(work).then(function () {
        B.loading = null;
        var now = Date.now(), bg = [];
        if ((!B.scores || B.scores.src === 'snapshot' || now - (B.scores.at || 0) > DAY) && now - B.scoresTried > 3600e3) {
          B.scoresTried = now;
          bg.push(fetchScores().catch(function () { return snapshotScores(); }));
        }
        if (needCatalog && (!B.catalog || now - B.catalog.at > DAY) && now - B.catalogTried > 3600e3) { B.catalogTried = now; bg.push(fetchCatalog().catch(function () {})); }
        if (!B.scores) bg.push(snapshotScores());
        if (bg.length) Promise.all(bg).then(function () {
          emit('badges', B);
          // the shared list carries the badges too: re-enrich it (model lists come from the cache)
          if (H.relay) localGroups(false).then(function (g) { if (!H.relay) return; H.groups = g; H.relay.refresh(); hostChanged(); });
        });
        return B;
      });
      return B.loading;
    }
    function dateOf(ms) { if (!ms) return ''; var d = new Date(ms); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
    function badgeCtx() { return { catalog: B.catalog, scores: B.scores }; }
    function catalogDate() { return B.catalog ? dateOf(B.catalog.at) : ''; }

    // ---- what this device can use -------------------------------------------------------------------
    function cleanName(m, ep) { return ep.provider === 'openrouter' ? String(m.name || m.id).replace(/^[^:]{1,40}:\s+/, '') : (m.name || m.id); }
    // This device's endpoints with their (enriched) models → groups.
    function localGroups(force, anyRole) {
      if (!anyRole && local().role !== 'local') return Promise.resolve([]);   // a 'remote' device calls no service
      var eps = endpoints(false);
      if (!eps.length) return Promise.resolve([]);
      var anyCloud = eps.some(function (e) { return e.where === 'cloud'; });
      return badges(anyCloud).then(function () {
        return Promise.all(eps.map(function (ep) {
          return epModels(ep, force).then(function (mc) {
            var list = C.enrich(C.chatModels(mc.list), ep.provider, badgeCtx()).map(function (m) { m.name = cleanName(m, ep); return m; });
            return { src: 'local', srcName: 'This device', ep: ep.id, provider: ep.provider, label: ep.label, where: ep.where, ok: true, models: list, ms: mc.ms, allow: ep.allow };
          }, function (e) {
            return { src: 'local', srcName: 'This device', ep: ep.id, provider: ep.provider, label: ep.label, where: ep.where, ok: false, error: e, models: [], allow: ep.allow };
          });
        }));
      });
    }
    function hostGroups(hosts) {
      var out = [];
      (hosts || []).forEach(function (h) {
        h.providers.forEach(function (p) {
          out.push({ src: h.did, srcName: h.name, host: h, ep: p.id, provider: C.endpointProvider(p.id) || 'custom', label: p.label, where: p.where, ok: p.ok && h.ok !== false,
            models: p.models.map(function (m) { var x = {}; for (var k in m) x[k] = m[k]; return x; }), more: p.more, scoresDate: h.scoresDate, catalogDate: h.catalogDate });
        });
      });
      return out;
    }
    // → Promise<{ groups, hosts, role }>
    function available(force) {
      var role = local().role || '';
      return Promise.all([role === 'local' ? localGroups(force) : Promise.resolve([]), listHosts()]).then(function (r) {
        return { groups: r[0].concat(hostGroups(r[1])), hosts: r[1], role: role };
      });
    }
    function findIn(groups, src, ep, model) {
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        if ((src && g.src !== src) || (ep && g.ep !== ep) || !g.ok) continue;
        for (var j = 0; j < g.models.length; j++) if (g.models[j].id === model || g.models[j].id === model + ':latest') return { group: g, model: g.models[j] };
      }
      return null;
    }
    // The model a question goes to. pick: a ref string ("src|ep|model"), "ep:model", or null
    // → { available, via: 'local'|'host', group, model (object), host, error, reason }
    function resolve(pick, av) {
      var groups = av.groups, lc = local(), hit = null;
      var want = typeof pick === 'string' ? (C.parseRef(pick) || C.parsePrefModel(pick)) : pick;
      if (want && want.model) {
        if (want.src && want.src !== 'local') hit = findIn(groups, want.src, want.ep, want.model) || findIn(groups, null, want.ep, want.model);
        else hit = findIn(groups, want.src === 'local' ? 'local' : null, want.ep, want.model) || (want.src === 'local' ? null : findIn(groups, null, want.ep, want.model));
        // a model chosen by name is never swapped for another one (that could be a paid one)
        if (!hit) return missing(av, want);
      }
      if (!hit) {
        var d = C.parsePrefModel(pref('model'));
        if (d.model) hit = findIn(groups, av.role === 'local' ? 'local' : null, d.ep, d.model) || findIn(groups, null, d.ep, d.model);
      }
      if (!hit && av.role === 'local') {
        // free (local) services before cloud ones
        var lg = groups.filter(function (g) { return g.src === 'local' && g.ok && g.models.length; })
          .sort(function (a, b) { return (a.where === 'cloud' ? 1 : 0) - (b.where === 'cloud' ? 1 : 0); })[0];
        if (lg) hit = { group: lg, model: lg.models.filter(function (m) { return m.id === C.pickModel('', lg.models, C.providerOf(lg.provider).prefer); })[0] || lg.models[0] };
      }
      if (!hit) {
        var h = C.pickHost(av.hosts, lc.host), hd = C.hostDefault(h);
        if (hd) hit = findIn(groups, h.did, hd.ep, hd.model);
      }
      if (hit) return { available: true, via: hit.group.src === 'local' ? 'local' : 'host', group: hit.group, model: hit.model, host: hit.group.host || null };
      // why not
      var code;
      if (av.role === 'local') {
        var bad = groups.filter(function (g) { return g.src === 'local' && !g.ok; })[0];
        if (bad && bad.error) return { available: false, via: 'local', group: bad, model: null, host: null, error: bad.error, reason: bad.error.code };
        code = endpoints(false).length ? 'model' : 'not-setup';
      } else if (!synced()) code = av.role === 'remote' ? 'nosync' : 'not-setup';
      else if (!av.hosts.length) code = av.role ? 'host-offline' : 'not-setup';
      else code = av.hosts.some(function (x) { return x.ok; }) ? 'not-shared' : 'host-unready';
      var h2 = C.pickHost(av.hosts, lc.host);
      return { available: false, via: av.role === 'local' ? 'local' : (av.role ? 'host' : null), group: null, model: null, host: h2, reason: code,
        error: decorate(C.AiError(code, code), { host: h2 ? h2.name : null, model: want && want.model }) };
    }
    // Why a chosen model can't be used right now.
    function missing(av, want) {
      var lc = local(), code, g = null, h = null;
      if (!want.src || want.src === 'local') g = av.groups.filter(function (x) { return x.src === 'local' && x.ep === want.ep; })[0] || null;
      if (g && !g.ok && g.error) return { available: false, via: 'local', group: g, model: null, host: null, error: g.error, reason: g.error.code };
      if (g || (av.role === 'local' && (!want.src || want.src === 'local'))) code = g ? 'model' : 'not-setup';
      else {
        h = want.src ? av.hosts.filter(function (x) { return x.did === want.src; })[0] || null : C.pickHost(av.hosts, lc.host, want.ep);
        code = !synced() ? 'nosync' : !h ? 'host-offline' : (h.ok ? 'not-shared' : 'host-unready');
      }
      var hn = h ? h.name : (C.pickHost(av.hosts, lc.host) || {}).name;
      return { available: false, via: g ? 'local' : 'host', group: g, model: null, host: h, reason: code,
        error: decorate(C.AiError(code, code), { host: hn || null, model: want.model, provider: (g && g.provider) || C.endpointProvider(want.ep) || null }) };
    }
    function route(pick, force) { return available(force).then(function (av) { var r = resolve(pick, av); r.groups = av.groups; r.hosts = av.hosts; return r; }); }

    function chatLocal(group, model, messages, o) {
      var ep = endpoint(group.ep);
      if (!ep) return Promise.reject(decorate(C.AiError('not-setup', 'gone')));
      if (o.onStart) o.onStart({ via: 'local', model: model.id, modelName: model.name, provider: ep.provider, ep: ep.id, epLabel: ep.label, host: null });
      var tmo = pref('timeout') * 1000;
      return C.chatStream(fetchImpl, {
        kind: ep.kind, provider: ep.provider, base: ep.base, apiKey: ep.apiKey, headers: ep.headers, model: model.id, messages: messages,
        temperature: o.temperature != null ? o.temperature : pref('temperature'), maxTokens: o.maxTokens || pref('maxTokens'),
        numCtx: ep.kind === 'ollama' ? pref('contextWindow') : 0,
        signal: o.signal, timeoutMs: tmo, firstTimeoutMs: Math.max(tmo, 60000), onDelta: o.onToken, onThinking: o.onThinking, Request: mkReq
      }).then(function (r) { r.via = 'local'; r.host = null; r.ep = ep.id; r.epLabel = ep.label; return r; }, function (e) {
        if (e && e.code === 'model') delete modelCache[ep.id];
        return refine(e, ep.base, ep.where).then(function (e2) { throw decorate(e2, { base: ep.base, model: model.id, provider: ep.provider }); });
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
    var visHooked = false;
    function onVis() {
      if (document.visibilityState !== 'visible' || !client) return;
      client.resume();
      if (!client.pending()) { document.removeEventListener('visibilitychange', onVis); visHooked = false; }
    }
    function chatHost(group, model, messages, o) {
      var h = group.host;
      if (o.onStart) o.onStart({ via: 'host', model: model.id, modelName: model.name, provider: group.provider, ep: group.ep, epLabel: group.label, host: h.name });
      if (!visHooked) { visHooked = true; document.addEventListener('visibilitychange', onVis); }
      return relay().request(h, {
        provider: group.ep, model: model.id, messages: messages,
        temperature: o.temperature != null ? o.temperature : pref('temperature'), maxTokens: o.maxTokens || pref('maxTokens')
      }, { signal: o.signal, timeoutMs: pref('timeout') * 1000, onDelta: o.onToken, onEvent: o.onEvent }).then(function (r) {
        r.via = 'host'; r.host = h.name; r.model = r.model || model.id; r.ep = group.ep; r.epLabel = group.label;
        return r;
      }, function (e) { throw decorate(e, { host: h.name, model: model.id, provider: group.provider }); });
    }
    function stripThink(t) { return String(t || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim(); }
    // Setup's "Test" for a host: a one-word question through Sync.
    function testHost(h, signal) {
      var t0 = Date.now(), hd = C.hostDefault(h);
      if (!hd) return Promise.resolve({ ok: false, error: decorate(C.AiError('host-unready', 'none'), { host: h.name }), ms: 0 });
      var group = hostGroups([h]).filter(function (g) { return g.ep === hd.ep; })[0];
      var model = group && group.models.filter(function (m) { return m.id === hd.model; })[0];
      if (!model) return Promise.resolve({ ok: false, error: decorate(C.AiError('host-unready', 'none'), { host: h.name }), ms: 0 });
      return chatHost(group, model, [{ role: 'user', content: 'Reply with just the word: OK' }], { maxTokens: 64, temperature: 0, signal: signal })
        .then(function (r) { return { ok: true, reply: stripThink(r.text).slice(0, 80) || '…', ms: Date.now() - t0, model: model.name || r.model, provider: group.label }; },
          function (e) { return { ok: false, error: e, ms: Date.now() - t0 }; });
    }
    // Setup's "Test connection" for an endpoint (saved or a draft): models + latency, then a one-word answer.
    function testEndpoint(draft, onStage, signal, noGen) {
      var ep = resolveEp(draft);
      ep.draft = true;
      return epModels(ep, true).then(function (mc) {
        var list = C.chatModels(mc.list);
        var res = { ok: true, ms: mc.ms, models: list, model: '', reply: '', genMs: 0, genError: null };
        var m = C.pickModel(draft.model || '', list, C.providerOf(ep.provider).prefer);
        res.model = m;
        if (onStage) onStage('models', res);
        if (!m || noGen) return res;
        return C.chatStream(fetchImpl, { kind: ep.kind, provider: ep.provider, base: ep.base, apiKey: ep.apiKey, headers: ep.headers, model: m,
          messages: [{ role: 'user', content: 'Reply with just the word: OK' }], temperature: 0, maxTokens: ep.kind === 'anthropic' ? 256 : 32,
          timeoutMs: 60000, firstTimeoutMs: 180000, signal: signal, Request: mkReq })
          .then(function (r) { res.reply = stripThink(r.text).slice(0, 80) || '…'; res.genMs = r.ms; res.firstMs = r.firstMs; return res; },
            function (e) { return refine(e, ep.base, ep.where).then(function (e2) { res.genError = decorate(e2, { base: ep.base, model: m, provider: ep.provider }); return res; }); });
      });
    }
    // Look for servers on the usual local ports → { list: [{ provider, name, base, state, ms, models }], lna, mixed }
    function detect() {
      if (mixedBlocked('http://127.0.0.1')) return Promise.resolve({ list: [], mixed: true });
      return Promise.all(C.DETECT.map(function (d) {
        var kind = C.kindOf(d.provider), url = C.modelsUrl(kind, d.base);
        // "running but blocking" only matters for the two well-known servers
        return C.probe(fetchImpl, url, { timeoutMs: 3000, Request: mkReq, noCors: d.provider !== 'custom' }).then(function (p) {
          var r = { provider: d.provider, name: d.name, base: d.base, state: p.state, ms: p.ms, models: [] };
          if (p.state === 'ok') {
            if (p.status >= 200 && p.status < 300) {
              try {
                var j = JSON.parse(p.body);
                if (kind === 'ollama' ? !Array.isArray(j && j.models) : !(j && Array.isArray(j.data))) r.state = 'other';
                else r.models = C.parseModels({ kind: kind, provider: d.provider }, j);
              } catch (e) { r.state = 'other'; }
            } else r.state = (p.status === 401 || p.status === 403) ? 'auth' : 'other';
          }
          if (r.state === 'blocked' && d.provider === 'custom') r.state = 'other';
          return r;
        });
      })).then(function (l) {
        return lnaState().then(function (lna) { return { list: l.filter(function (r) { return r.state === 'ok' || r.state === 'blocked' || r.state === 'auth'; }), lna: lna }; });
      });
    }

    // o: { model (ref or "ep:model"), temperature, maxTokens, signal, onToken(delta, full), onStart(info), onEvent(msg), onThinking }
    function chat(messages, o) {
      o = o || {};
      return route(o.model || o.pick || null).then(function (r) {
        if (!r.available) throw r.error;
        return r.via === 'local' ? chatLocal(r.group, r.model, messages, o) : chatHost(r.group, r.model, messages, o);
      });
    }

    // ---- hosting --------------------------------------------------------------------------------------
    var H = { enabled: false, ask: null, phase: 'off', relay: null, lockAbort: null, lockRelease: null, retryT: 0, modelsT: 0, groups: [] };
    function hostStatus() {
      var r = H.relay ? H.relay.status() : {};
      return { enabled: H.enabled, phase: H.phase, online: !!r.online, busy: !!r.busy, queued: r.queued || 0, served: r.served || 0, current: r.current || null,
        ok: H.groups.some(function (g) { return g.ok; }) };
    }
    function hostChanged() { emit('host', hostStatus()); }
    function hostWanted() { return H.enabled && local().role === 'local'; }
    function syncHost() {
      if (hostWanted()) { if (H.phase === 'off' || H.phase === 'not-local') startHost(); }
      else if (H.phase !== 'off') stopHost(H.enabled ? 'not-local' : 'off');
    }
    // What this host shares, from its own config (cloud services only with shareCloud).
    function shareCfg() {
      var d = C.parsePrefModel(pref('model'));
      return {
        endpoints: H.groups.map(function (g) { return { id: g.ep, provider: g.provider, label: g.label, where: g.where, ok: g.ok, on: true, models: g.models, allow: g.allow }; }),
        shareCloud: !!pref('shareCloud'), defaultModel: d.ep ? d : null,
        scoresDate: B.scores ? B.scores.date : '', catalogDate: catalogDate()
      };
    }
    function startHost() {
      clearTimeout(H.retryT); H.retryT = 0;
      if (!synced()) { H.phase = 'nosync'; hostChanged(); H.retryT = setTimeout(syncHostRetry, 30000); return; }
      H.phase = 'standby'; hostChanged();
      var go = function () {
        H.phase = 'starting'; hostChanged();
        return localGroups(true).then(function (g) { H.groups = g; }, function () { H.groups = []; }).then(function () {
          if (!hostWanted() || H.phase !== 'starting') return;
          H.relay = C.createRelayHost({
            cloud: cloud, device: dev, timers: timers,
            info: function () { var p = C.buildPresence(shareCfg()); p.ok = H.groups.some(function (g) { return g.ok; }); return p; },
            resolve: hostResolve,
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
            H.modelsT = setInterval(function () { if (!H.groups.every(function (g) { return g.ok; }) || ++ticks % 10 === 0) refreshHostModels(); }, 60000);
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
      return localGroups(true).then(function (g) { H.groups = g; }, function () {}).then(function () { if (H.relay) H.relay.refresh(); hostChanged(); });
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
    // A question from another device: only what is shared, with the cloud cap applied.
    function hostResolve(req) {
      var t = C.resolveShared(shareCfg(), req.provider, req.model);
      if (!t.ok) return t;
      t.maxTokens = t.ep.where === 'cloud' ? C.tokenLimit(req.maxTokens, pref('cloudMaxTokens')) : C.tokenLimit(req.maxTokens, 0);
      return t;
    }
    function hostRun(job, h) {
      var t = job.target, ep = endpoint(t.ep.id);
      if (!ep || !ep.on) return Promise.reject(C.AiError('not-shared', 'gone'));
      h.model(t.model);
      var tmo = pref('timeout') * 1000;
      return C.chatStream(fetchImpl, {
        kind: ep.kind, provider: ep.provider, base: ep.base, apiKey: ep.apiKey, headers: ep.headers, model: t.model, messages: job.req.messages,
        temperature: job.req.temperature, maxTokens: t.maxTokens, numCtx: ep.kind === 'ollama' ? pref('contextWindow') : 0,
        signal: h.signal, timeoutMs: tmo, firstTimeoutMs: Math.max(tmo, 60000), onDelta: h.onDelta, onThinking: h.onThinking, Request: mkReq
      }).then(function (r) { return { reason: r.reason, usage: r.usage, model: t.model }; }, function (e) {
        return refine(e, ep.base, ep.where).then(function (e2) {
          if (/^(unreachable|cors|model|auth|key-missing)$/.test(e2.code)) refreshHostModels();
          if (/^(unreachable|cors|auth|key-missing|mixed|lna)$/.test(e2.code)) e2.code = 'host-unready';
          throw e2;
        });
      });
    }

    // ---- the share switch ↔ the plugin toggle ------------------------------------------------------
    function pluginSetting() {
      try { var S = Cade.Settings; return S ? S.get(SETTING) : undefined; } catch (e) { return undefined; }
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
      } else if (k === 'policy' || k === 'shareCloud' || k === 'model') { if (H.relay) H.relay.refresh(); }
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

    // ---- per-note model picks, recently used -----------------------------------------------------------
    function readJson(k, d) { try { var v = JSON.parse(Cade.store.get(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
    function notePick(room) { var m = readJson('cade-ai-picks', {}); return m && typeof m === 'object' ? m[room || ''] || '' : ''; }
    function setNotePick(room, ref) {
      var m = readJson('cade-ai-picks', {}), keys;
      if (!m || typeof m !== 'object' || Array.isArray(m)) m = {};
      delete m[room || ''];
      if (ref) m[room || ''] = ref;
      keys = Object.keys(m);
      if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(function (k) { delete m[k]; });
      try { Cade.store.set('cade-ai-picks', JSON.stringify(m)); } catch (e) {}
      if (ref) {
        var r = readJson('cade-ai-recent', []);
        if (!Array.isArray(r)) r = [];
        r = [ref].concat(r.filter(function (x) { return x !== ref; })).slice(0, 6);
        try { Cade.store.set('cade-ai-recent', JSON.stringify(r)); } catch (e) {}
      }
    }
    function recent() { var r = readJson('cade-ai-recent', []); return Array.isArray(r) ? r : []; }

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
    function flat(groups) {
      var out = [];
      groups.forEach(function (g) {
        if (!g.ok) return;
        g.models.forEach(function (m) {
          out.push({ ref: C.refKey(g.src, g.ep, m.id), id: g.ep + ':' + m.id, provider: g.ep, model: m.id, name: m.name, via: g.src === 'local' ? 'local' : 'host',
            host: g.src === 'local' ? null : g.srcName, where: m.where, price: m.price || null, ctx: m.ctx || 0, score: m.score || null });
        });
      });
      return out;
    }
    var api = {
      version: 2,
      // → Promise<{ available, via: 'local'|'host'|null, host, provider, model, reason, message, setup }>
      status: function (o) {
        return route(o && o.model || null).then(function (r) {
          return { available: !!r.available, via: r.available ? r.via : null, host: r.available && r.host ? r.host.name : null,
            provider: r.available ? r.group.ep : null, model: r.available ? r.model.id : null,
            reason: r.available ? null : (r.reason || null), message: r.available ? '' : (r.error && r.error.info ? r.error.info.title : ''), setup: !!local().role };
        });
      },
      // messages: a string or [{role, content}] (the system prompt from AI preferences is added
      // when none is given); o.model: "provider:model" (e.g. "anthropic:claude-opus-5-5") or a
      // picker ref → Promise<full text>. Rejects an Error with .code, .info { title, steps }, .partial.
      chat: function (messages, o) {
        o = o || {};
        return chat(normMessages(messages), { model: o.model, temperature: o.temperature, maxTokens: o.maxTokens, signal: o.signal,
          onToken: typeof o.onToken === 'function' ? o.onToken : null }).then(function (r) { return r.text; });
      },
      // → Promise<[{ id: "provider:model", provider, model, name, via, host, where, price, ctx, score }]>
      models: function () { return available(false).then(function (av) { return flat(av.groups); }); },
      // Open the AI panel.
      open: function () { return Cade.runCommand('AI'); }
    };
    Cade.ai = api;

    window.__cadeAi = {
      core: C, P: P, pref: pref, local: local, setLocal: setLocal, env: env, decorate: decorate, on: on, use: use,
      endpoints: endpoints, endpoint: endpoint, saveEndpoint: saveEndpoint, removeEndpoint: removeEndpoint, newEndpointId: newEndpointId, resolveEp: resolveEp,
      detect: detect, testEndpoint: testEndpoint, epModels: epModels, localGroups: localGroups, available: available, route: route, chat: chat,
      watchHosts: watchHosts, listHosts: listHosts, hostGroups: hostGroups, testHost: testHost, synced: synced, device: dev,
      badges: function () { return B; }, catalogDate: catalogDate,
      notePick: notePick, setNotePick: setNotePick, recent: recent,
      setShare: setShare, setPlugin: setPlugin, pluginIsOn: pluginIsOn, reconcile: reconcile, api: api,
      host: {
        enable: function (ask) { H.enabled = true; H.ask = ask || null; syncHost(); },
        disable: function () { H.enabled = false; H.ask = null; syncHost(); },
        status: hostStatus, refresh: refreshHostModels, shared: function () { return C.buildPresence(shareCfg()); }
      }
    };
  }
})();
