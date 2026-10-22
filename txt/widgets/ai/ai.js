/* AI — your own model (Ollama, LM Studio or any OpenAI-compatible server on
 * your computer) with the note as context, usable from every device.
 *
 * SETUP (first open, and ⚙ later): three steps.
 *   ① Where does your model run? — "This computer" or "Another of my devices"
 *     (lists the account's devices that share a model right now).
 *   ② Connect — finds servers on the usual ports by itself; Test connection
 *     shows the models, the latency and a one-word answer. When the browser
 *     is blocked (CORS, Safari's localhost block, "apps on this device"
 *     permission) it shows the exact fix for THIS OS / browser, with Copy
 *     buttons, and Test again. For another device: pick it (or "whichever is
 *     sharing") and test the round trip.
 *   ③ Pick a model; on a model computer, "Share with my other devices" (turns
 *     on the ai-host plugin) and Answer automatically / Ask me each time.
 * Nothing loads or announces before that. A status line always says what will
 * answer ("● Using llama3.2 on MacBook (via Sync)"); tapping it fixes or
 * refreshes.
 *
 * CHAT: what the model reads (Selection / This note / Another note… /
 * Nothing), quick actions (Summarise, Rewrite clearer, Continue writing,
 * Explain this code, Make a checklist, Translate to…), a streamed answer with
 * Stop, then Insert (after the cursor) / Replace selection / Copy / New note.
 * Long notes are trimmed to the model's window (start and end kept). The
 * conversation is kept per note in IndexedDB on this device (a pref; Clear).
 * Answers render as Markdown — the app's marked when loaded, else a small
 * built-in renderer — and are sanitised either way (no HTML, no images, only
 * http(s)/mailto links).
 *
 * Code: ai-core.js (pure, tested), ai-service.js (routing, local server,
 * relay, hosting, Cade.ai), ai-host.js (the sharing plugin). Cade.ai is
 * registered as soon as this file loads (lazy until the service is in).
 * Close removes every listener, timer and request. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var BASE = Cade.baseURL();
  Cade.loadCSS('ai.css');
  var CORE_URL = BASE + 'ai-core.js', SVC_URL = BASE + 'ai-service.js';
  var ID = 'ai', PANEL_ID = 'ai-panel', CHAT_KEY = 'ai-chat:';
  var MAX_SAVED = 60, MAX_SAVED_CHARS = 400000;

  var META = {
    name: 'AI',
    description: 'Your own AI model — Ollama, LM Studio or any OpenAI-compatible server on your computer — with your note as context: summarise, rewrite, continue, explain code, checklists, translate. Use it from your phone too, end-to-end encrypted through Sync; no cloud AI service',
    icon: '✨',
    tags: 'ai,assistant,chat,llm,local llm,local ai,private ai,ollama,lm studio,llama,llama.cpp,mistral,gemma,qwen,deepseek,phi,openai compatible,gpt,chatgpt,summarise,summarize,rewrite,continue writing,explain code,checklist,translate,ask,prompt,model'
  };

  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2200); } catch (e) {} }
  function coarse() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }
  function phoneish() { var k = ''; try { k = Cade.cloud.device.kind; } catch (e) {} return k === 'phone' || k === 'tablet'; }

  var loads = {};
  function load(url) {
    if (loads[url]) return loads[url];
    return (loads[url] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = function () { res(); };
      s.onerror = function () { delete loads[url]; rej(new Error('AI failed to load (offline?)')); };
      document.head.appendChild(s);
    }));
  }
  function loadSvc() {
    if (window.__cadeAi) return Promise.resolve(window.__cadeAi);
    return (window.__cadeAiCore ? Promise.resolve() : load(CORE_URL)).then(function () { return load(SVC_URL); }).then(function () {
      if (!window.__cadeAi) throw new Error('AI did not start');
      return window.__cadeAi;
    });
  }
  // Cade.ai before the service is in: same calls, loading it on first use.
  function lazy(name) { return function () { var a = arguments; return loadSvc().then(function (s) { return s.api[name].apply(null, a); }); }; }
  if (!Cade.ai) Cade.ai = { version: 1, status: lazy('status'), chat: lazy('chat'), models: lazy('models'), open: function () { open(); } };

  var I = {
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    insert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    replace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h13l-3.5-3.5"/><path d="M20 16H7l3.5 3.5"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/><path d="M12 12v6M9 15h6"/></svg>',
    retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/></svg>'
  };

  var S = null;   // the open panel's state

  // ---- helpers -------------------------------------------------------------------------------------
  function currentRoom() { try { return (Cade.roomsApi && Cade.roomsApi.activeRoom()) || ''; } catch (e) { return ''; } }
  function selection() {
    var ed = Cade.editor;
    if (!ed) return null;
    var r = ed.state.selection.main;
    if (r.empty) return null;
    return { from: r.from, to: r.to, text: ed.state.sliceDoc(r.from, r.to), room: currentRoom() };
  }
  function words(t) { var m = String(t || '').match(/\S+/g); return m ? m.length : 0; }
  function kTok(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n); }
  function stripThink(t) { return String(t || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, ''); }
  function copyText(t) {
    var ok = function () { toast('Copied', 'success', 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).then(ok, function () { legacy(); });
    }
    legacy();
    function legacy() {
      var ta = document.createElement('textarea');
      ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { toast('Copy failed', 'error'); }
      ta.remove();
    }
  }

  // ---- markdown, sanitised -----------------------------------------------------------------------
  var MD = null;
  var ALLOW = { P: 1, BR: 1, STRONG: 1, B: 1, EM: 1, I: 1, DEL: 1, S: 1, CODE: 1, PRE: 1, BLOCKQUOTE: 1, UL: 1, OL: 1, LI: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    A: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TH: 1, TD: 1, HR: 1, SPAN: 1, INPUT: 1 };
  var DROP = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, TEMPLATE: 1, SVG: 1, MATH: 1, LINK: 1, META: 1, FORM: 1, TEXTAREA: 1, SELECT: 1, BUTTON: 1, NOSCRIPT: 1, IMG: 1, VIDEO: 1, AUDIO: 1, SOURCE: 1, BASE: 1 };
  function clean(node) {
    Array.prototype.slice.call(node.childNodes).forEach(function (n) {
      if (n.nodeType === 3) return;
      if (n.nodeType !== 1) { n.parentNode.removeChild(n); return; }
      var tag = n.tagName.toUpperCase();
      if (DROP[tag]) { n.parentNode.removeChild(n); return; }
      clean(n);
      if (!ALLOW[tag]) { while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n); n.parentNode.removeChild(n); return; }
      Array.prototype.slice.call(n.attributes).forEach(function (a) {
        var k = a.name.toLowerCase(), keep = false;
        if (k === 'href' && tag === 'A') keep = !!S.C.safeUrl(a.value);
        else if (k === 'class') keep = /^[\w -]{0,60}$/.test(a.value);
        else if (tag === 'INPUT') keep = (k === 'type' && a.value === 'checkbox') || k === 'checked';
        else if (k === 'align' && (tag === 'TD' || tag === 'TH')) keep = /^(left|right|center)$/.test(a.value);
        if (!keep) n.removeAttribute(a.name);
      });
      if (tag === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
      if (tag === 'INPUT') { if (n.getAttribute('type') !== 'checkbox') n.parentNode.removeChild(n); else n.setAttribute('disabled', ''); }
    });
  }
  var CARET = '<span class="ai-caret" aria-hidden="true"></span>';
  // The streaming caret goes right after the last character, not on a line of its own.
  function withCaret(html) {
    return /(<\/(p|li|ul|ol|h\d|blockquote|code|pre|td|tr|tbody|table|strong|em|del|a)>)+$/.test(html)
      ? html.replace(/((<\/(p|li|ul|ol|h\d|blockquote|code|pre|td|tr|tbody|table|strong|em|del|a)>)+)$/, CARET + '$1') : html + CARET;
  }
  function md(t) {
    t = stripThink(t);
    var html = null;
    try {
      if (window.marked && window.marked.Marked) {
        if (!MD) MD = new window.marked.Marked({ gfm: true, breaks: true });
        html = MD.parse(t);
      }
    } catch (e) { html = null; }
    if (typeof html !== 'string') html = S.C.mdToHtml(t);
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    clean(tpl.content);
    return tpl.innerHTML;
  }

  // ---- open / close ------------------------------------------------------------------------------
  function open() {
    try { Cade.closeAllMenus(); } catch (e) {}
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized(ex)) { Cade.restorePanel(ex); return; }
      close();
      if (ex.isConnected) ex.remove();
      return;
    }
    loadSvc().then(function (svc) {
      if (document.getElementById(PANEL_ID)) return;
      build(svc);
    }, function (e) { toast((e && e.message) || 'AI failed to load', 'error', 3000); });
  }
  function close() {
    var p = S && S.panel;
    cleanup();
    if (p && p.isConnected) p.remove();
  }
  function cleanup() {
    var s = S;
    if (!s) return;
    S = null;
    if (s.busy) { try { s.busy.ctl.abort(); } catch (e) {} }
    if (s.wiz && s.wiz.abort) { try { s.wiz.abort.abort(); } catch (e) {} }
    s.offs.forEach(function (f) { try { f(); } catch (e) {} });
    s.offs = [];
    if (s.offHosts) { s.offHosts(); s.offHosts = null; }
    clearTimeout(s.saveT); clearTimeout(s.ctxT); cancelAnimationFrame(s.raf);
    try { Cade.offEditorUpdate(onEd); } catch (e) {}
    document.removeEventListener('visibilitychange', onVis);
    if (s.unuse) s.unuse();
  }

  function bodyHtml(C) {
    var acts = C.ACTIONS.filter(function (a) { return a.id !== 'translate'; }).map(function (a) {
      return '<button type="button" class="ai-act" data-action="' + a.id + '">' + esc(a.label) + '</button>';
    }).join('');
    var langs = '<option value="" selected disabled>Translate to…</option>' + C.LANGS.map(function (l) { return '<option value="' + esc(l) + '">' + esc(l) + '</option>'; }).join('') + '<option value="?">Other…</option>';
    return '<div class="ai-root" data-view="chat">' +
      '<button type="button" class="ai-status" data-act="status"><span class="ai-dot" aria-hidden="true"></span><span class="ai-status-t" role="status">Checking…</span><span class="ai-status-a"></span></button>' +
      '<div class="ai-chat">' +
        '<div class="ai-log" tabindex="-1" aria-live="polite"></div>' +
        '<div class="ai-dock">' +
          '<div class="ai-row ai-ctx" role="group" aria-label="What the AI reads">' +
            '<span class="ai-row-l">Reads</span>' +
            '<button type="button" class="ai-chip" data-ctx="sel">Selection</button>' +
            '<button type="button" class="ai-chip" data-ctx="note">This note</button>' +
            '<label class="ai-chip ai-pick" data-ctx="room"><span class="ai-pick-t">Another note…</span><select class="ai-room-sel" aria-label="Another note"></select></label>' +
            '<button type="button" class="ai-chip" data-ctx="none">Nothing</button>' +
          '</div>' +
          '<div class="ai-row ai-acts" role="group" aria-label="Quick actions">' + acts +
            '<label class="ai-act ai-pick"><span class="ai-pick-t">Translate to…</span><select class="ai-lang" aria-label="Translate to">' + langs + '</select></label>' +
          '</div>' +
          '<div class="ai-compose">' +
            '<textarea class="ai-in" rows="1" placeholder="Ask about this note, or anything…" aria-label="Message"></textarea>' +
            '<button type="button" class="ai-send" data-act="send" aria-label="Send">' + I.send + '</button>' +
          '</div>' +
          '<div class="ai-foot"><span class="ai-ctxinfo"></span><button type="button" class="ai-link" data-act="clear">Clear</button></div>' +
        '</div>' +
      '</div>' +
      '<div class="ai-setup" hidden></div>' +
    '</div>';
  }

  function build(svc) {
    var C = svc.core;
    var panel = Cade.mkPanel(PANEL_ID, '✨ AI', bodyHtml(C));
    panel.dataset.prefs = ID;
    var q = function (sel) { return panel.querySelector(sel); };
    var head = q('.cade-panel-head');
    var gear = document.createElement('span');
    gear.className = 'ai-gear';
    gear.setAttribute('role', 'button'); gear.setAttribute('tabindex', '0');
    gear.title = 'Setup and preferences'; gear.setAttribute('aria-label', 'AI setup and preferences');
    gear.innerHTML = I.gear;
    gear.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    gear.addEventListener('click', function (e) { e.stopPropagation(); if (S) toggleSetup(); });
    gear.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (S) toggleSetup(); } });
    head.insertBefore(gear, q('.cade-panel-popbtn') || q('.cade-panel-minbtn'));

    S = {
      panel: panel, q: q, svc: svc, C: C, root: q('.ai-root'), log: q('.ai-log'), input: q('.ai-in'), setupEl: q('.ai-setup'),
      view: 'chat', wiz: null, msgs: [], room: currentRoom(), ctx: 'auto', ctxRoom: '', busy: null, route: null, routeGen: 0, histGen: 0,
      offs: [], offHosts: null, unuse: svc.use(), raf: 0, saveT: 0, ctxT: 0, copies: [], fixOs: null, hosts: null
    };
    panel._onClose = cleanup;
    panel.addEventListener('click', onClick);
    panel.addEventListener('change', onChange);
    panel.addEventListener('input', onInput);
    panel.addEventListener('keydown', onKey);
    panel.addEventListener('pointerdown', onPickOpen);
    panel.addEventListener('focusin', onPickOpen);
    S.offs.push(svc.on('host', function () { if (S) { paintStatus(); if (S.view === 'setup' && S.wiz && S.wiz.step === 3) renderSetup(); } }));
    S.offs.push(svc.on('prefs', function (k) {
      if (!S) return;
      if (k === 'provider' || k === 'endpoint' || k === 'model') refreshRoute();
      if (k === 'history') loadHistory();
      paintCtx();
    }));
    Cade.onEditorUpdate(onEd);
    document.addEventListener('visibilitychange', onVis);
    if (!svc.local().role) showSetup(1, true);
    else showChat();
    loadHistory();
  }

  // ---- status ----------------------------------------------------------------------------------------
  function hostSuffix() {
    var h = S.svc.host.status();
    if (!h.enabled || S.svc.local().role !== 'local') return '';
    if (h.phase === 'live') return h.busy ? ' · answering ' + ((h.current && h.current.name) || 'a device') : ' · sharing' + (h.served ? ' (' + h.served + ' answered)' : '');
    if (h.phase === 'standby') return ' · another tab is sharing';
    if (h.phase === 'nosync') return ' · sharing needs Sync';
    if (h.phase === 'starting' || h.phase === 'retry') return ' · starting to share…';
    return '';
  }
  function paintStatus() {
    if (!S) return;
    var r = S.route, el = S.q('.ai-status'), cls = 'wait', t = 'Checking…', a = '';
    if (r) {
      if (r.available && r.via === 'local') { cls = 'ok'; t = 'Using ' + r.model + ' on this device (' + r.server.label + ')' + hostSuffix(); }
      else if (r.available && r.via === 'host') {
        var busy = r.host.busy && !S.busy;   // busy with our own question isn't news
        cls = busy ? 'busy' : 'ok'; t = 'Using ' + r.model + ' on ' + r.host.name + ' (via Sync)' + (busy ? ' · busy' : '');
      }
      else { cls = 'off'; t = (r.error && r.error.info && r.error.info.title) || 'Not available'; a = 'Fix'; }
    }
    el.className = 'ai-status ai-s-' + cls;
    el.querySelector('.ai-status-t').textContent = t;
    el.querySelector('.ai-status-a').textContent = a;
    el.title = a ? 'Show how to fix this' : 'Check again';
  }
  function refreshRoute() {
    if (!S) return;
    var g = ++S.routeGen;
    if (!S.route) paintStatus();
    S.svc.route().then(function (r) {
      if (!S || g !== S.routeGen) return;
      S.route = r;
      paintStatus();
      if (S.view === 'chat' && !S.msgs.length) renderLog();
    });
  }
  function watchHosts(on) {
    if (on && !S.offHosts) S.offHosts = S.svc.watchHosts(function (list) {
      if (!S) return;
      S.hosts = list;
      if (S.view === 'setup') { if (S.wiz && (S.wiz.step === 1 || (S.wiz.step === 2 && S.wiz.where === 'remote') || (S.wiz.step === 3 && S.wiz.where === 'remote'))) renderSetup(); }
      else refreshRoute();
    });
    if (!on && S.offHosts) { S.offHosts(); S.offHosts = null; }
  }

  // ---- views -----------------------------------------------------------------------------------------
  function showChat() {
    S.view = 'chat'; S.wiz = null;
    S.root.dataset.view = 'chat';
    S.setupEl.hidden = true;
    S.q('.ai-chat').hidden = false;
    watchHosts(S.svc.local().role !== 'local');
    refreshRoute();
    paintCtx();
    renderLog();
  }
  function toggleSetup() {
    if (S.view === 'setup' && S.svc.local().role) { if (S.wiz && S.wiz.abort) S.wiz.abort.abort(); showChat(); }
    else showSetup(1, false);
  }

  // ---- conversation ----------------------------------------------------------------------------------
  function loadHistory() {
    if (!S) return;
    var room = S.room, g = ++S.histGen;
    if (S.busy && S.busy.room === room) return;
    S.msgs = [];
    if (!S.svc.pref('history') || !Cade.idbStore) { renderLog(); return; }
    Cade.idbStore.get(CHAT_KEY + room).then(function (v) {
      if (!S || g !== S.histGen) return;
      S.msgs = v && Array.isArray(v.msgs) ? v.msgs.filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; }) : [];
      S.msgs.forEach(function (m) { m.pending = false; });
      renderLog();
    }, function () { if (S) renderLog(); });
  }
  function save(room, msgs) {
    if (!S || !S.svc.pref('history') || !Cade.idbStore) return;
    var keep = msgs.filter(function (m) { return !m.pending && (m.content || m.err); }).map(function (m) {
      var o = { role: m.role, content: m.content, at: m.at };
      ['show', 'ctxLabel', 'action', 'model', 'host', 'via', 'ms', 'stopped', 'reason'].forEach(function (k) { if (m[k]) o[k] = m[k]; });
      if (m.sel) o.sel = m.sel;
      if (m.err) o.err = { code: m.err.code, title: m.err.title };
      return o;
    });
    var size = function () { return keep.reduce(function (n, m) { return n + m.content.length + (m.sel ? m.sel.text.length : 0); }, 0); };
    while (keep.length > MAX_SAVED || (keep.length > 2 && size() > MAX_SAVED_CHARS)) keep.splice(0, 2);
    var key = CHAT_KEY + room;
    (keep.length ? Cade.idbStore.set(key, { v: 1, msgs: keep, at: Date.now() }) : Cade.idbStore.remove(key)).catch(function () {});
  }
  function emptyHtml() {
    var r = S.route, lines = '';
    if (r && !r.available && r.error && r.error.info) lines = fixHtml(r.error.info, { setup: true });
    return '<div class="ai-empty"><div class="ai-empty-ic" aria-hidden="true">✨</div>' +
      '<p><b>Ask your own model about this note.</b></p>' +
      '<p>Choose what it reads below, then tap an action or type a question. Answers stay on your devices.</p>' + lines + '</div>';
  }
  function metaHtml(m) {
    if (m.role === 'user') return m.ctxLabel ? '<div class="ai-meta">' + esc(m.ctxLabel) + '</div>' : '';
    var bits = [];
    if (m.model) bits.push(esc(m.model));
    if (m.via === 'host' && m.host) bits.push('on ' + esc(m.host));
    if (m.ms) bits.push(esc(S.C.fmtMs(m.ms)));
    if (m.reason === 'length') bits.push('cut off at the length limit');
    if (m.stopped) bits.push('stopped');
    if (m.pending && m.note) bits.push('<span class="ai-note">' + esc(m.note) + '</span>');
    return bits.length ? '<div class="ai-meta">' + bits.join(' · ') + '</div>' : '';
  }
  function toolsHtml(m, i) {
    if (m.pending || !stripThink(m.content).trim()) return '';
    var u = S.msgs[i - 1];
    var sel = u && u.role === 'user' && u.sel;
    return '<div class="ai-tools">' +
      '<button type="button" class="ai-tool" data-act="insert" data-i="' + i + '">' + I.insert + '<span>Insert</span></button>' +
      (sel ? '<button type="button" class="ai-tool" data-act="replace" data-i="' + i + '">' + I.replace + '<span>Replace selection</span></button>' : '') +
      '<button type="button" class="ai-tool" data-act="copy" data-i="' + i + '">' + I.copy + '<span>Copy</span></button>' +
      '<button type="button" class="ai-tool" data-act="newnote" data-i="' + i + '">' + I.note + '<span>New note</span></button>' +
      '</div>';
  }
  function msgHtml(m, i) {
    if (m.role === 'user') return '<div class="ai-msg ai-u" data-i="' + i + '"><div class="ai-bub">' + esc(m.show || m.content) + '</div>' + metaHtml(m) + '</div>';
    var body = m.content ? md(m.content) : '';
    if (m.pending) body = withCaret(body);
    var err = '';
    if (m.err) {
      var info = m.err.info || { title: m.err.title || 'Something went wrong', steps: [] };
      err = fixHtml(info, { retry: i, setup: /^(unreachable|cors|mixed|lna|auth|notfound|nosync|not-setup|host-offline)$/.test(m.err.code) });
    }
    return '<div class="ai-msg ai-a' + (m.pending ? ' ai-live' : '') + '" data-i="' + i + '"><div class="ai-md">' + body + '</div>' + err + metaHtml(m) + toolsHtml(m, i) + '</div>';
  }
  function nearBottom() { var l = S.log; return l.scrollHeight - l.scrollTop - l.clientHeight < 80; }
  function renderLog() {
    if (!S || S.view !== 'chat') return;
    S.copies = [];
    S.log.innerHTML = S.msgs.length ? S.msgs.map(msgHtml).join('') : emptyHtml();
    S.log.scrollTop = S.log.scrollHeight;
    S.q('[data-act="clear"]').hidden = !S.msgs.length;
  }
  // While streaming: only the live answer is redrawn (once a frame at most).
  function scheduleLive() {
    if (!S || S.raf) return;
    S.raf = requestAnimationFrame(function () {
      if (!S) return;
      S.raf = 0;
      var b = S.busy;
      if (!b || b.room !== S.room || S.view !== 'chat') return;
      var el = S.log.querySelector('.ai-msg[data-i="' + S.msgs.indexOf(b.bm) + '"]');
      if (!el) return;
      var stick = nearBottom();
      el.querySelector('.ai-md').innerHTML = withCaret(b.bm.content ? md(b.bm.content) : '');
      var old = el.querySelector('.ai-meta'), html = metaHtml(b.bm);
      if (old) old.outerHTML = html || '<span hidden></span>';
      else if (html) el.insertAdjacentHTML('beforeend', html);
      if (stick) S.log.scrollTop = S.log.scrollHeight;
    });
  }
  function paintBusy() {
    var b = S.q('.ai-send'), busy = !!S.busy;
    b.innerHTML = busy ? I.stop : I.send;
    b.dataset.act = busy ? 'stop' : 'send';
    b.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    b.classList.toggle('ai-stop', busy);
    S.root.classList.toggle('ai-busy', busy);
  }

  // ---- context --------------------------------------------------------------------------------------
  function ctxMode() { return S.ctx !== 'auto' ? S.ctx : (selection() ? 'sel' : 'none'); }
  function paintCtx() {
    if (!S || S.view !== 'chat') return;
    var mode = ctxMode(), sel = selection();
    Array.prototype.forEach.call(S.panel.querySelectorAll('.ai-chip'), function (c) {
      var on = c.dataset.ctx === mode;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var sc = S.q('.ai-chip[data-ctx="sel"]');
    sc.textContent = sel ? 'Selection · ' + words(sel.text) + (words(sel.text) === 1 ? ' word' : ' words') : 'Selection';
    sc.classList.toggle('ai-dim', !sel);
    S.q('.ai-chip[data-ctx="room"] .ai-pick-t').textContent = mode === 'room' && S.ctxRoom ? '📄 ' + S.ctxRoom : 'Another note…';
    var info = '', B = S.C.budget({ contextWindow: S.svc.pref('contextWindow'), maxTokens: S.svc.pref('maxTokens') });
    if (mode === 'sel' && sel) info = 'Reads your selection (~' + kTok(S.C.estTokens(sel.text)) + ' tokens)';
    else if (mode === 'note') {
      var t = 0;
      try { t = S.C.estTokens(Cade.editor.state.doc.toString()); } catch (e) {}
      info = 'Reads this note (~' + kTok(t) + ' tokens' + (t > B ? ', trimmed to fit ~' + kTok(B) : '') + ')';
    } else if (mode === 'room' && S.ctxRoom) info = 'Reads “' + S.ctxRoom + '”';
    else if (mode === 'sel') info = 'Select some text first';
    else info = 'Reads only the conversation';
    S.q('.ai-ctxinfo').textContent = info;
  }
  function fillRooms() {
    var sel = S.q('.ai-room-sel'), ra = Cade.roomsApi, list = [];
    try { list = (ra && ra.list ? ra.list() : []).filter(function (n) { return n && n !== currentRoom() && n.indexOf('__') !== 0; }); } catch (e) {}
    try { if (ra.orderRooms) list = ra.orderRooms(list); } catch (e) {}
    sel.innerHTML = '<option value="" disabled' + (S.ctxRoom ? '' : ' selected') + '>Another note…</option>' +
      list.slice(0, 300).map(function (n) { return '<option value="' + esc(n) + '"' + (n === S.ctxRoom ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('');
  }
  // → Promise<null | { label (for the model), short (for the chat), text, sel }>
  function getCtx(forAction) {
    var mode = ctxMode();
    if (forAction && mode === 'none') mode = selection() ? 'sel' : 'note';
    var room = currentRoom();
    if (mode === 'sel') {
      var s = selection();
      if (s) return Promise.resolve({ label: 'Selected text from the note “' + room + '”', short: 'Selection (' + words(s.text) + (words(s.text) === 1 ? ' word)' : ' words)'), text: s.text, sel: s });
      mode = 'note';
    }
    if (mode === 'note') {
      var t = '';
      try { t = Cade.editor.state.doc.toString(); } catch (e) {}
      if (!t.trim()) return Promise.resolve(null);
      return Promise.resolve({ label: 'The note “' + room + '”', short: 'This note', text: t });
    }
    if (mode === 'room' && S.ctxRoom) {
      var name = S.ctxRoom;
      return Promise.resolve(Cade.roomText ? Cade.roomText(name) : '').then(function (txt) {
        txt = typeof txt === 'string' ? txt : (txt && txt.text) || '';
        if (!txt.trim()) { toast('“' + name + '” is empty or not on this device yet', 'info', 2600); return null; }
        return { label: 'The note “' + name + '”', short: '“' + name + '”', text: txt };
      }, function () { toast('Couldn’t read “' + name + '”', 'error'); return null; });
    }
    return Promise.resolve(null);
  }

  // ---- asking --------------------------------------------------------------------------------------
  function send(text, o) {
    o = o || {};
    if (!S || S.busy) return;
    text = String(text || '').trim();
    if (!text) return;
    var svc = S.svc, C = S.C, room = S.room, msgs = S.msgs;
    getCtx(!!o.action).then(function (ctx) {
      if (!S || S.busy || S.room !== room) return;
      if (o.action && !ctx) { toast('Write or select some text first', 'info'); return; }
      var hist = msgs.filter(function (m) { return !m.err && !m.pending && m.content; }).map(function (m) { return { role: m.role, content: m.content }; });
      var a = C.assemble({ system: svc.pref('system'), history: hist, instruction: text, ctx: ctx, budget: C.budget({ contextWindow: svc.pref('contextWindow'), maxTokens: svc.pref('maxTokens') }) });
      var um = { role: 'user', content: a.user, show: o.show || text, ctxLabel: ctx ? 'Read: ' + ctx.short + (a.trimmed ? ' — trimmed to fit' : '') : '', action: o.action || '', at: Date.now() };
      if (ctx && ctx.sel) um.sel = ctx.sel;
      if (!o.keepInput) { S.input.value = ''; grow(); }
      msgs.push(um);
      run(um, a.messages, room, msgs);
    });
  }
  function run(um, messages, room, msgs) {
    var bm = { role: 'assistant', content: '', pending: true, at: Date.now(), model: '', host: '', via: '', note: 'Connecting…' };
    msgs.push(bm);
    var ctl = new AbortController();
    S.busy = { ctl: ctl, bm: bm, room: room, msgs: msgs };
    paintBusy();
    renderLog();
    S.svc.chat(messages, {
      signal: ctl.signal,
      onStart: function (i) { bm.model = i.model; bm.host = i.host || ''; bm.via = i.via; bm.note = i.via === 'host' ? 'Sending to ' + i.host + '…' : 'Waiting for the model… (the first answer loads it)'; scheduleLive(); },
      onToken: function (d, full) { bm.content = full; bm.note = ''; scheduleLive(); },
      onThinking: function () { if (!bm.content) { bm.note = 'Thinking…'; scheduleLive(); } },
      onEvent: function (m) {
        if (bm.content) return;
        if (m.t === 'a') bm.note = m.pos > 0 ? 'Waiting in line (' + m.pos + ' ahead)…' : 'Working on it…';
        else if (m.t === 'w') bm.note = 'Waiting for ' + (bm.host || 'the other device') + ' to say yes…';
        else if (m.t === 's') { bm.model = m.model || bm.model; bm.note = 'Waiting for the model… (the first answer loads it)'; }
        else if (m.t === 'k') bm.note = 'Thinking…';
        scheduleLive();
      }
    }).then(function (r) {
      bm.content = r.text; bm.ms = r.ms; bm.reason = r.reason; bm.model = r.model || bm.model;
    }, function (e) {
      bm.content = (e && e.partial) || bm.content;
      if (e && e.code === 'aborted') bm.stopped = true;
      else bm.err = { code: (e && e.code) || 'server', info: (e && e.info) || null, title: (e && e.info && e.info.title) || (e && e.message) || 'Failed' };
    }).then(function () {
      bm.pending = false; bm.note = '';
      if (!S) { return; }
      if (S.busy && S.busy.bm === bm) S.busy = null;
      paintBusy();
      if (S.room === room) renderLog();
      save(room, msgs);
      if (bm.err && /^(unreachable|cors|mixed|lna|model|host-offline|host-silent|host-unready|nosync)$/.test(bm.err.code)) refreshRoute();
      else if (bm.model && S.route && S.route.available && S.route.model !== bm.model) refreshRoute();
    });
  }
  function retry(i) {
    var bm = S.msgs[i], um = S.msgs[i - 1];
    if (!bm || !um || um.role !== 'user' || S.busy) return;
    S.msgs.splice(i, 1);
    var svc = S.svc;
    var hist = S.msgs.slice(0, i - 1).filter(function (m) { return !m.err && m.content; }).map(function (m) { return { role: m.role, content: m.content }; });
    // the stored question already holds its context; keep the history that fits
    var a = S.C.assemble({ system: svc.pref('system'), history: hist, instruction: um.content, ctx: null, budget: S.C.budget({ contextWindow: svc.pref('contextWindow'), maxTokens: svc.pref('maxTokens') }) });
    run(um, a.messages, S.room, S.msgs);
  }
  function action(id, lang) {
    var a = null;
    S.C.ACTIONS.forEach(function (x) { if (x.id === id) a = x; });
    if (!a) return;
    var label = id === 'translate' ? 'Translate to ' + lang : a.label;
    send(S.C.actionPrompt(id, lang), { action: id, show: label, keepInput: true });
  }

  // ---- using an answer ------------------------------------------------------------------------------
  function answerText(i) { var m = S.msgs[i]; return m ? stripThink(m.content).replace(/\s+$/, '') : ''; }
  function editable() {
    var ed = Cade.editor;
    if (!ed || ed.state.readOnly) { toast('This note can’t be edited right now', 'error'); return null; }
    return ed;
  }
  function insertAnswer(i) {
    var t = answerText(i), ed = editable();
    if (!t || !ed) return;
    var r = ed.state.selection.main, at = r.to, doc = ed.state.doc;
    var line = doc.lineAt(at), ins = t;
    if (/\n/.test(t)) {
      // a multi-line answer becomes its own block: blank line before (unless at the
      // top or after one) and a line break after when text follows on this line
      if (at > line.from) ins = '\n\n' + ins;
      else if (line.number > 1 && doc.line(line.number - 1).text.trim()) ins = '\n' + ins;
      if (at < line.to) ins += '\n\n';
    }
    ed.dispatch({ changes: { from: at, insert: ins }, selection: { anchor: at + ins.length }, scrollIntoView: true, userEvent: 'input.ai' });
    toast('Inserted', 'success', 1200);
  }
  function replaceAnswer(i) {
    var t = answerText(i), u = S.msgs[i - 1], ed = editable();
    if (!t || !ed || !u || !u.sel) return;
    var sel = u.sel;
    if (currentRoom() !== sel.room) { toast('That selection is in “' + sel.room + '” — open it first', 'info', 2600); return; }
    var from = sel.from, to = sel.to, doc = ed.state.doc;
    if (to > doc.length || ed.state.sliceDoc(from, to) !== sel.text) {
      var all = doc.toString(), idx = all.indexOf(sel.text);
      if (idx < 0 || all.indexOf(sel.text, idx + 1) >= 0) { toast('The selected text has changed — select it again, or use Insert', 'info', 3000); return; }
      from = idx; to = idx + sel.text.length;
    }
    ed.dispatch({ changes: { from: from, to: to, insert: t }, selection: { anchor: from, head: from + t.length }, scrollIntoView: true, userEvent: 'input.ai' });
    sel.from = from; sel.to = from + t.length; sel.text = t;
    save(S.room, S.msgs);
    toast('Replaced', 'success', 1200);
  }
  function newNote(i) {
    var t = answerText(i), ra = Cade.roomsApi;
    if (!t) return;
    if (!ra || typeof ra.ensureRoom !== 'function' || typeof ra.switchRoom !== 'function') { toast('Notes can’t be created from here', 'error'); return; }
    var name = S.C.roomNameFrom(t, ra.list());
    ra.ensureRoom(name);
    if (ra.list().indexOf(name) < 0) { toast('Couldn’t create “' + name + '”', 'error'); return; }
    Promise.resolve(ra.switchRoom(name)).then(function () {
      if (ra.activeRoom() !== name) throw new Error('“' + name + '” didn’t open');
      var ed = Cade.editor;
      if (!ed || ed.state.readOnly) throw new Error('the new note is read-only');
      ed.dispatch({ changes: { from: 0, to: ed.state.doc.length, insert: t }, selection: { anchor: t.length }, userEvent: 'input.ai' });
      toast('New note “' + name + '”', 'success', 2000);
    }).catch(function (e) { toast('New note failed: ' + ((e && e.message) || e), 'error', 3000); });
  }

  // ---- fix boxes --------------------------------------------------------------------------------------
  function stepsHtml(steps) {
    return (steps || []).map(function (s) {
      if (s.cmd) {
        var k = S.copies.push(s.cmd) - 1;
        return '<div class="ai-cmd">' + (s.label ? '<span class="ai-cmd-l">' + esc(s.label) + '</span>' : '') + '<code>' + esc(s.cmd) + '</code>' +
          '<button type="button" class="ai-copy" data-copy="' + k + '">' + I.copy + '<span>Copy</span></button></div>';
      }
      return '<p>' + esc(s.t) + '</p>';
    }).join('');
  }
  // info: C.explain(...) result. o: { retry: msg index, setup: bool, again: bool }
  function fixHtml(info, o) {
    o = o || {};
    var h = '<div class="ai-fix" role="alert"><div class="ai-fix-t">' + esc(info.title) + '</div>' + (info.text ? '<p>' + esc(info.text) + '</p>' : '');
    if (info.os) {
      var os = S.fixOs || info.osPick || 'mac';
      h += '<div class="ai-seg ai-os" role="tablist">' + [['mac', 'macOS'], ['win', 'Windows'], ['linux', 'Linux']].map(function (x) {
        return '<button type="button" role="tab" data-os="' + x[0] + '" aria-selected="' + (x[0] === os ? 'true' : 'false') + '" class="' + (x[0] === os ? 'on' : '') + '">' + x[1] + '</button>';
      }).join('') + '</div>' + stepsHtml(info.os[os]);
    }
    h += stepsHtml(info.steps);
    var btns = '';
    if (o.again) btns += '<button type="button" class="ai-btn ai-pri" data-act="w-test">Test again</button>';
    if (o.retry != null) btns += '<button type="button" class="ai-btn" data-act="retry" data-i="' + o.retry + '">' + I.retry + '<span>Try again</span></button>';
    if (o.setup) btns += '<button type="button" class="ai-btn" data-act="setup2">Open setup</button>';
    return h + (btns ? '<div class="ai-btns">' + btns + '</div>' : '') + '</div>';
  }

  // ---- setup wizard ------------------------------------------------------------------------------------
  function showSetup(step, first) {
    var svc = S.svc, lc = svc.local(), s = svc.server();
    if (S.wiz && S.wiz.abort) S.wiz.abort.abort();
    S.wiz = {
      step: step || 1, first: !!first, where: lc.role || (phoneish() ? 'remote' : 'local'),
      provider: s.provider, url: String(svc.pref('endpoint') || ''), key: lc.key || '',
      phase: '', det: null, test: null, err: null, model: String(svc.pref('model') || ''), models: [],
      share: lc.role === 'local' && !!svc.pref('share'), policy: svc.pref('policy') || 'auto', host: lc.host || '', htest: null, gen: 0, abort: null
    };
    S.view = 'setup';
    S.root.dataset.view = 'setup';
    S.q('.ai-chat').hidden = true;
    S.setupEl.hidden = false;
    watchHosts(true);
    renderSetup();
  }
  function stepsBar(W) {
    var names = ['Where', 'Connect', 'Model'];
    return '<ol class="ai-steps-bar">' + names.map(function (n, i) {
      return '<li class="' + (i + 1 === W.step ? 'on' : i + 1 < W.step ? 'done' : '') + '"><span>' + (i + 1) + '</span>' + n + '</li>';
    }).join('') + '</ol>';
  }
  function navHtml(back, next, nextLabel, nextOff) {
    return '<div class="ai-nav">' + (back ? '<button type="button" class="ai-btn" data-act="' + back + '">Back</button>' : '<span></span>') +
      (next ? '<button type="button" class="ai-btn ai-pri" data-act="' + next + '"' + (nextOff ? ' disabled' : '') + '>' + esc(nextLabel || 'Next') + '</button>' : '') + '</div>';
  }
  function hostLine(h) {
    var bits = [h.models.length + (h.models.length === 1 ? ' model' : ' models')];
    if (h.model) bits.push(h.model);
    if (!h.ok) bits.push('its model server isn’t answering');
    else if (h.busy) bits.push('busy');
    if (h.policy === 'ask') bits.push('asks first');
    return bits.join(' · ');
  }
  function renderSetup() {
    if (!S || S.view !== 'setup') return;
    var W = S.wiz, svc = S.svc, C = S.C, e = svc.env(), h = '';
    S.copies = [];
    var hosts = S.hosts || [];
    h += '<div class="ai-wiz">' + stepsBar(W);
    if (W.step === 1) {
      var local = '<button type="button" class="ai-card' + (W.where === 'local' ? ' on' : '') + '" data-where="local"><span class="ai-card-ic" aria-hidden="true">💻</span><span class="ai-card-b"><b>This computer</b>' +
        '<span>Ollama, LM Studio or another model server runs here</span>' +
        (e.secure && e.browser === 'safari' && !e.ios ? '<span class="ai-warn">Safari can’t connect to it — use Chrome, Edge or Firefox for this part</span>' : '') +
        (e.ios || e.os === 'android' ? '<span class="ai-faint">Phones usually use another device’s model</span>' : '') + '</span></button>';
      var hl = hosts.length ? '<span class="ai-ok">● ' + esc(hosts.map(function (x) { return x.name; }).slice(0, 2).join(', ')) + (hosts.length > 1 ? ' are' : ' is') + ' sharing now</span>'
        : (svc.synced() ? '<span class="ai-faint">None of your devices is sharing yet</span>' : '<span class="ai-faint">Needs Sync on both devices</span>');
      var remote = '<button type="button" class="ai-card' + (W.where === 'remote' ? ' on' : '') + '" data-where="remote"><span class="ai-card-ic" aria-hidden="true">📱</span><span class="ai-card-b"><b>Another of my devices</b>' +
        '<span>Use the model on your computer from here, end-to-end encrypted through Sync</span>' + hl + '</span></button>';
      h += '<h3 class="ai-h">Where does your model run?</h3><p class="ai-sub">Your own AI: questions go to your model, never to a cloud AI service.</p>' +
        '<div class="ai-cards">' + (phoneish() ? remote + local : local + remote) + '</div>';
      h += '<div class="ai-wiz-foot">' + (!W.first ? '<button type="button" class="ai-link" data-act="w-cancel">Cancel</button>' : '<span></span>') +
        '<button type="button" class="ai-link" data-act="prefs">All preferences…</button>' +
        (svc.local().role ? '<button type="button" class="ai-link ai-danger" data-act="w-off">Turn AI off on this device</button>' : '') + '</div>';
    } else if (W.step === 2 && W.where === 'local') {
      var pre = C.presetOf(W.provider);
      h += '<h3 class="ai-h">Connect to your model server</h3>' +
        '<div class="ai-seg" role="radiogroup" aria-label="Server type">' + ['ollama', 'lmstudio', 'openai'].map(function (p) {
          var on = W.provider === p;
          return '<button type="button" role="radio" aria-checked="' + on + '" class="' + (on ? 'on' : '') + '" data-prov="' + p + '">' + (p === 'openai' ? 'Other' : esc(C.PRESETS[p].label)) + '</button>';
        }).join('') + '</div>' +
        '<label class="ai-field"><span>Server address</span><input class="ai-url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="' + esc(pre.url) + '" value="' + esc(W.url) + '"></label>' +
        '<div class="ai-btns"><button type="button" class="ai-btn" data-act="w-detect"' + (W.phase === 'detect' ? ' disabled' : '') + '>Find it automatically</button>' +
        '<button type="button" class="ai-btn ai-pri" data-act="w-test"' + (W.phase === 'test' ? ' disabled' : '') + '>Test connection</button></div>' +
        '<div class="ai-result">' + resultHtml(W) + '</div>' +
        '<details class="ai-adv"' + (W.key || (W.err && W.err.code === 'auth') ? ' open' : '') + '><summary>Advanced</summary>' +
        '<label class="ai-field"><span>API key <small>optional — kept on this device only, never synced</small></span><input class="ai-key" type="password" autocomplete="off" spellcheck="false" value="' + esc(W.key) + '"></label></details>' +
        navHtml('w-back', 'w-next', 'Next', !(W.test && W.test.ok));
    } else if (W.step === 2) {
      h += '<h3 class="ai-h">Use a model on another device</h3>';
      if (!svc.synced()) h += fixHtml(C.explain('nosync', e), {});
      else {
        h += '<div class="ai-opts" role="radiogroup" aria-label="Which device">' +
          '<label class="ai-opt"><input type="radio" name="ai-host" value=""' + (!W.host ? ' checked' : '') + '><span><b>Whichever of my devices is sharing</b><small>Recommended</small></span></label>' +
          hosts.map(function (x) {
            return '<label class="ai-opt"><input type="radio" name="ai-host" value="' + esc(x.did) + '"' + (W.host === x.did ? ' checked' : '') + '><span><b>' + esc(x.name) + '</b><small><span class="ai-ok">●</span> online · ' + esc(hostLine(x)) + '</small></span></label>';
          }).join('') +
          (W.host && !hosts.some(function (x) { return x.did === W.host; }) ? '<label class="ai-opt"><input type="radio" name="ai-host" value="' + esc(W.host) + '" checked><span><b>The device chosen before</b><small>offline right now</small></span></label>' : '') +
          '</div>';
        if (!hosts.length) h += fixHtml(C.explain('host-offline', e), {}) + '<p class="ai-faint ai-c">This list updates by itself.</p>';
        else {
          var th = C.pickHost(hosts, W.host);
          h += '<div class="ai-btns"><button type="button" class="ai-btn ai-pri" data-act="w-htest"' + (W.phase === 'htest' || !th ? ' disabled' : '') + '>Test with ' + esc(th ? th.name : 'it') + '</button></div>' +
            '<div class="ai-result">' + hostTestHtml(W) + '</div>';
        }
      }
      h += navHtml('w-back', 'w-next', 'Next', !svc.synced());
    } else {
      h += '<h3 class="ai-h">Pick a model</h3>';
      var list = W.where === 'local' ? C.chatModels(W.models) : modelsOfHost(W);
      if (!list.length) h += '<p class="ai-sub">' + (W.where === 'local' ? 'No models are installed yet — the setup will use whichever you add later.' : 'The model is chosen by the sharing device.') + '</p>';
      else {
        var cur = W.model && list.some(function (m) { return m.name === W.model; }) ? W.model : '';
        h += '<div class="ai-opts ai-models" role="radiogroup" aria-label="Model">' +
          '<label class="ai-opt"><input type="radio" name="ai-model" value=""' + (!cur ? ' checked' : '') + '><span><b>' + (W.where === 'local' ? 'Automatic' : 'The other device’s default') + '</b><small>' + esc(W.where === 'local' ? 'The first installed model (' + list[0].name + ')' : (list[0].name || '')) + '</small></span></label>' +
          list.slice(0, 50).map(function (m) {
            var sub = [m.size ? C.fmtBytes(m.size) : '', m.params, m.quant].filter(Boolean).join(' · ');
            return '<label class="ai-opt"><input type="radio" name="ai-model" value="' + esc(m.name) + '"' + (cur === m.name ? ' checked' : '') + '><span><b>' + esc(m.name) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span></label>';
          }).join('') + '</div>';
      }
      if (W.where === 'local') {
        var sync = svc.synced();
        h += '<div class="ai-share">' +
          '<label class="ai-switch"><input type="checkbox" class="ai-share-cb"' + (W.share && sync ? ' checked' : '') + (sync ? '' : ' disabled') + '><span class="ai-switch-ui" aria-hidden="true"></span>' +
          '<span><b>Share with my other devices</b><small>' + (sync ? 'Your phone and other devices with the same Sync can use this model.' : 'Needs Sync — set it up first (the dot in the menu bar).') + '</small></span></label>' +
          '<p class="ai-privacy">🔒 Questions and answers are end-to-end encrypted with your Sync key and deleted once delivered — only your own devices can use it.</p>';
        if (W.share && sync) {
          h += '<div class="ai-seg ai-pol" role="radiogroup" aria-label="When another device asks">' + [['auto', 'Answer automatically'], ['ask', 'Ask me each time']].map(function (x) {
            return '<button type="button" role="radio" aria-checked="' + (W.policy === x[0]) + '" class="' + (W.policy === x[0] ? 'on' : '') + '" data-pol="' + x[0] + '">' + x[1] + '</button>';
          }).join('') + '</div>' +
          '<p class="ai-tip">Keep a txt tab open on this computer (in the background is fine) and the computer awake. ' +
          (e.browser === 'chrome' || e.browser === 'edge' ? 'Tip: add this site to Settings → Performance → “Always keep these sites active”.' : '') + '</p>';
        }
        h += '</div>';
      }
      h += navHtml('w-back', 'w-done', 'Start chatting', false);
    }
    h += '</div>';
    var y = S.setupEl.scrollTop, focus = document.activeElement && S.setupEl.contains(document.activeElement) ? document.activeElement.className : '';
    S.setupEl.innerHTML = h;
    S.setupEl.scrollTop = y;
    if (focus && /ai-url|ai-key/.test(focus)) { var f = S.setupEl.querySelector('.' + focus.split(' ')[0]); if (f) { f.focus(); try { f.setSelectionRange(f.value.length, f.value.length); } catch (x) {} } }
  }
  function modelsOfHost(W) {
    var h = S.C.pickHost(S.hosts || [], W.host);
    return h ? h.models.map(function (n) { return { name: n }; }) : [];
  }
  function resultHtml(W) {
    var C = S.C, h = '';
    if (W.phase === 'detect') return '<div class="ai-busyline"><span class="ai-spin"></span>Looking for Ollama, LM Studio and other servers on this computer…</div>' + lnaHint();
    if (W.det && !W.test && !W.err) {
      if (W.det.mixed) return fixHtml(C.explain('mixed', S.svc.env()), {});
      if (!W.det.list.length) h += '<p class="ai-faint">Nothing found on the usual ports.</p>' + fixHtml(C.explain(W.det.lna === 'denied' ? 'lna' : 'unreachable', S.svc.env({ provider: W.provider, base: S.svc.server({ provider: W.provider, url: W.url }).base })), { again: true });
      else h += '<div class="ai-found">' + W.det.list.map(function (r, i) {
        var n = C.chatModels(r.models).length;
        var txt = r.state === 'ok' ? n + (n === 1 ? ' model' : ' models') + ' · ' + r.ms + ' ms' : r.state === 'auth' ? 'needs an API key' : 'running, but blocks this page';
        return '<div class="ai-found-r"><span class="' + (r.state === 'ok' ? 'ai-ok' : 'ai-warnc') + '">' + (r.state === 'ok' ? '✓' : '⚠') + '</span><span><b>' + esc(r.name) + '</b> <small>' + esc(r.base) + '</small><br><small>' + esc(txt) + '</small></span>' +
          '<button type="button" class="ai-btn" data-act="w-use" data-i="' + i + '">Use</button></div>';
      }).join('') + '</div>';
      return h;
    }
    if (W.phase === 'test') return '<div class="ai-busyline"><span class="ai-spin"></span>Connecting…</div>' + lnaHint();
    if (W.err) return fixHtml(W.err.info, { again: true });
    if (W.test && W.test.ok) {
      var t = W.test;
      h += '<p class="ai-good">✓ Connected to ' + esc(C.presetOf(W.provider).label) + ' in ' + esc(C.fmtMs(t.ms)) + ' — ' + C.chatModels(t.models).length + (C.chatModels(t.models).length === 1 ? ' model' : ' models') + '</p>';
      if (!t.model) h += '<p class="ai-faint">No models installed yet.' + (W.provider === 'ollama' ? ' Download one:' : '') + '</p>' + (W.provider === 'ollama' ? stepsHtml([{ cmd: 'ollama pull llama3.2' }]) : '');
      else if (W.phase === 'gen') h += '<div class="ai-busyline"><span class="ai-spin"></span>Asking ' + esc(t.model) + ' for a one-word reply… (the first answer loads the model — up to a minute)</div>';
      else if (t.genError) h += fixHtml(t.genError.info, { again: true });
      else if (t.reply) h += '<p class="ai-good">✓ ' + esc(t.model) + ' answered “' + esc(t.reply) + '” in ' + esc(C.fmtMs(t.genMs)) + '</p>';
    }
    return h;
  }
  function lnaHint() {
    var e = S.svc.env();
    return (e.browser === 'chrome' || e.browser === 'edge' || e.browser === 'firefox') && e.secure ? '<p class="ai-faint">If the browser asks to let this site use apps on this device, choose Allow.</p>' : '';
  }
  function hostTestHtml(W) {
    var C = S.C;
    if (W.phase === 'htest') return '<div class="ai-busyline"><span class="ai-spin"></span>Sending a test question through Sync…</div>';
    if (!W.htest) return '';
    if (W.htest.ok) return '<p class="ai-good">✓ ' + esc(W.htest.host) + ' answered “' + esc(W.htest.reply) + '” with ' + esc(W.htest.model || 'its model') + ' in ' + esc(C.fmtMs(W.htest.ms)) + '</p>';
    return fixHtml(W.htest.error.info || C.explain('server', {}), {});
  }
  function wizSet(patch) { for (var k in patch) S.wiz[k] = patch[k]; renderSetup(); }
  function readWizFields() {
    var W = S.wiz, u = S.setupEl.querySelector('.ai-url'), k = S.setupEl.querySelector('.ai-key');
    if (u) W.url = u.value.trim();
    if (k) W.key = k.value.trim();
  }
  function wizDetect() {
    var W = S.wiz, g = ++W.gen;
    wizSet({ phase: 'detect', det: null, test: null, err: null });
    S.svc.detect().then(function (d) {
      if (!S || !S.wiz || S.wiz.gen !== g) return;
      W.phase = '';
      W.det = d;
      var ok = d.list.filter(function (r) { return r.state === 'ok'; });
      var pick = ok.filter(function (r) { return r.provider === W.provider; })[0] || ok[0];
      if (pick && ok.length === 1) { useFound(pick); return; }
      var blocked = d.list.filter(function (r) { return r.state === 'blocked'; })[0];
      if (!ok.length && blocked) {
        W.provider = blocked.provider; W.url = '';
        W.err = S.svc.decorate(S.C.AiError('cors', 'blocked'), { base: blocked.base, provider: blocked.provider });
      }
      renderSetup();
    });
  }
  function useFound(r) {
    var W = S.wiz, pre = S.C.presetOf(r.provider);
    W.provider = r.provider;
    W.url = S.C.normBase(pre.kind, r.base) === S.C.normBase(pre.kind, pre.url) ? '' : r.base;
    if (r.state === 'auth') { W.err = S.svc.decorate(S.C.AiError('auth', 'key'), {}); W.det = null; renderSetup(); return; }
    if (r.state === 'blocked') { W.err = S.svc.decorate(S.C.AiError('cors', 'blocked'), { base: r.base, provider: r.provider }); W.det = null; renderSetup(); return; }
    wizTest();
  }
  function wizAbort() {
    var W = S.wiz;
    if (W.abort) { try { W.abort.abort(); } catch (e) {} }
    W.abort = new AbortController();
    return W.abort.signal;
  }
  function wizTest() {
    readWizFields();
    var W = S.wiz, g = ++W.gen, signal = wizAbort();
    wizSet({ phase: 'test', det: null, test: null, err: null });
    S.svc.testLocal({ provider: W.provider, url: W.url, key: W.key, model: W.model, signal: signal }, function (stage, res) {
      if (!S || !S.wiz || S.wiz.gen !== g) return;
      if (stage === 'models') { W.test = res; W.models = res.models; W.phase = res.model ? 'gen' : ''; renderSetup(); }
    }).then(function (res) {
      if (!S || !S.wiz || S.wiz.gen !== g) return;
      W.test = res; W.models = res.models; W.phase = '';
      renderSetup();
    }, function (e) {
      if (!S || !S.wiz || S.wiz.gen !== g) return;
      W.phase = ''; W.test = null; W.err = e;
      renderSetup();
    });
  }
  function wizHostTest() {
    var W = S.wiz, h = S.C.pickHost(S.hosts || [], W.host), g = ++W.gen;
    if (!h) return;
    var signal = wizAbort();
    wizSet({ phase: 'htest', htest: null });
    S.svc.testHost(h, signal).then(function (r) {
      if (!S || !S.wiz || S.wiz.gen !== g) return;
      r.host = h.name;
      W.phase = ''; W.htest = r;
      renderSetup();
    });
  }
  function wizGo(step) {
    var W = S.wiz;
    readWizFields();
    if (W.phase === 'gen' || W.phase === 'test' || W.phase === 'htest') wizAbort();
    W.step = step;
    W.gen++;
    W.phase = '';
    renderSetup();
    S.setupEl.scrollTop = 0;
    if (step === 2 && W.where === 'local' && !W.test && !W.err) {
      if (S.svc.local().role === 'local' || W.url) wizTest(); else wizDetect();
    }
  }
  function wizFinish() {
    var W = S.wiz, svc = S.svc, C = S.C, P = svc.P;
    readWizFields();
    var sel = S.setupEl.querySelector('input[name="ai-model"]:checked');
    if (sel) W.model = sel.value;
    var wasLocal = svc.local().role === 'local';
    if (W.where === 'local') {
      var pre = C.presetOf(W.provider), norm = W.url ? C.normBase(pre.kind, W.url) : '';
      P.set('provider', W.provider);
      P.set('endpoint', norm && norm !== C.normBase(pre.kind, pre.url) ? norm : '');
      P.set('model', W.model || '');
      P.set('policy', W.policy === 'ask' ? 'ask' : 'auto');
      svc.setLocal({ role: 'local', key: W.key || null, host: null, setupAt: Date.now() });
      svc.setShare(!!(W.share && svc.synced()));
    } else {
      if (wasLocal) svc.setShare(false);
      svc.setLocal({ role: 'remote', host: W.host || null, setupAt: Date.now() });
      if (sel) P.set('model', W.model || '');
    }
    toast(W.where === 'local' ? (W.share && svc.synced() ? 'AI is ready — and shared with your devices' : 'AI is ready') : 'AI is ready', 'success', 2200);
    S.route = null;
    showChat();
  }
  function turnOff() {
    var svc = S.svc;
    if (svc.local().role === 'local') svc.setShare(false);
    svc.setLocal({ role: null, host: null, key: null, shareSeen: null });
    S.route = null;
    showSetup(1, true);
    toast('AI is off on this device', 'info', 1800);
  }

  // ---- events ---------------------------------------------------------------------------------------
  function onClick(e) {
    if (!S) return;
    var t = e.target.closest('[data-act],[data-ctx],[data-action],[data-where],[data-prov],[data-pol],[data-os],[data-copy]');
    if (!t || !S.panel.contains(t)) return;
    var W = S.wiz, a = t.dataset.act;
    if (t.dataset.copy != null) { copyText(S.copies[+t.dataset.copy] || ''); return; }
    if (t.dataset.os) { S.fixOs = t.dataset.os; if (S.view === 'setup') renderSetup(); else renderLog(); return; }
    if (t.dataset.ctx && t.tagName !== 'LABEL') {
      var c = t.dataset.ctx;
      if (c === 'sel' && !selection()) { toast('Select some text in the note first', 'info', 1800); return; }
      S.ctx = c; paintCtx(); return;
    }
    if (t.dataset.action) { action(t.dataset.action); return; }
    if (t.dataset.where) { W.where = t.dataset.where; W.test = null; W.err = null; W.det = null; W.htest = null; wizGo(2); return; }
    if (t.dataset.prov) { readWizFields(); W.provider = t.dataset.prov; W.url = ''; W.test = null; W.err = null; W.det = null; wizTest(); return; }
    if (t.dataset.pol) { W.policy = t.dataset.pol; renderSetup(); return; }
    switch (a) {
      case 'send': send(S.input.value); break;
      case 'stop': if (S.busy) S.busy.ctl.abort(); break;
      case 'clear':
        if (S.busy) return;
        S.msgs = []; renderLog();
        if (Cade.idbStore) Cade.idbStore.remove(CHAT_KEY + S.room).catch(function () {});
        break;
      case 'status':
        if (S.view === 'setup') return;
        if (S.route && !S.route.available) showSetup(2, false);
        else { S.route = null; paintStatus(); refreshRoute(); }
        break;
      case 'insert': insertAnswer(+t.dataset.i); break;
      case 'replace': replaceAnswer(+t.dataset.i); break;
      case 'copy': copyText(answerText(+t.dataset.i)); break;
      case 'newnote': newNote(+t.dataset.i); break;
      case 'retry': retry(+t.dataset.i); break;
      case 'setup2': showSetup(S.svc.local().role ? 2 : 1, !S.svc.local().role); break;
      case 'prefs': if (Cade.prefs && Cade.prefs.open) { try { Cade.prefs.open(ID); } catch (x) {} } break;
      case 'w-cancel': showChat(); break;
      case 'w-off': turnOff(); break;
      case 'w-back': wizGo(W.step - 1); break;
      case 'w-next': if (!t.disabled) wizGo(W.step + 1); break;
      case 'w-detect': wizDetect(); break;
      case 'w-test': if (S.view === 'setup') wizTest(); break;
      case 'w-use': if (W.det && W.det.list[+t.dataset.i]) useFound(W.det.list[+t.dataset.i]); break;
      case 'w-htest': wizHostTest(); break;
      case 'w-done': wizFinish(); break;
    }
  }
  function onChange(e) {
    if (!S) return;
    var t = e.target;
    if (t.classList.contains('ai-room-sel')) { S.ctxRoom = t.value; S.ctx = t.value ? 'room' : 'auto'; paintCtx(); return; }
    if (t.classList.contains('ai-lang')) {
      var lang = t.value;
      t.selectedIndex = 0;
      if (lang === '?') { lang = (window.prompt('Translate into which language?') || '').trim().slice(0, 40); if (!lang) return; }
      if (lang) action('translate', lang);
      return;
    }
    if (t.classList.contains('ai-share-cb')) { S.wiz.share = t.checked; renderSetup(); return; }
    if (t.name === 'ai-host') { S.wiz.host = t.value; S.wiz.htest = null; renderSetup(); return; }
    if (t.name === 'ai-model') { S.wiz.model = t.value; return; }
    if (t.classList.contains('ai-url') || t.classList.contains('ai-key')) { readWizFields(); }
  }
  function onInput(e) {
    if (!S) return;
    if (e.target === S.input) grow();
    else if (S.wiz && (e.target.classList.contains('ai-url') || e.target.classList.contains('ai-key'))) {
      readWizFields();
      if (S.wiz.test || S.wiz.err) { S.wiz.test = null; S.wiz.err = null; var nx = S.setupEl.querySelector('[data-act="w-next"]'); if (nx) nx.disabled = true; var r = S.setupEl.querySelector('.ai-result'); if (r) r.innerHTML = ''; }
    }
  }
  function onKey(e) {
    if (!S) return;
    if (e.key === 'Escape' && S.busy) { e.preventDefault(); e.stopPropagation(); S.busy.ctl.abort(); return; }
    if (e.target === S.input && e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse()) { e.preventDefault(); send(S.input.value); return; }
    if (S.wiz && e.key === 'Enter' && e.target.classList && e.target.classList.contains('ai-url')) { e.preventDefault(); wizTest(); }
  }
  function grow() {
    var ta = S.input;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
  }
  function onEd(u) {
    if (!S) return;
    var room = currentRoom();
    if (room !== S.room) {
      S.room = room; S.ctx = 'auto';
      if (S.ctxRoom === room) S.ctxRoom = '';
      loadHistory();
    }
    if (u && (u.selectionSet || u.docChanged) && S.view === 'chat' && !S.ctxT) {
      S.ctxT = setTimeout(function () { if (S) { S.ctxT = 0; paintCtx(); } }, 150);
    }
  }
  function onVis() {
    if (!S || document.visibilityState !== 'visible') return;
    if (S.view === 'chat' && !S.busy) refreshRoute();
  }

  // The room picker is filled when it's about to open (rooms change).
  function onPickOpen(e) { if (S && e.target && e.target.classList && e.target.classList.contains('ai-room-sel')) fillRooms(); }

  var W = {
    name: META.name, description: META.description, icon: META.icon, tags: META.tags,
    open: open, close: close,
    _state: function () { return S; }
  };
  Cade.registerWidget(W);
})();
