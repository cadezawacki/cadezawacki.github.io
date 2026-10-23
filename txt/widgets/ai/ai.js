/* AI — your own models (Ollama, LM Studio, any OpenAI-compatible server) and
 * cloud APIs with your own keys (OpenAI, Anthropic, Gemini, OpenRouter, Groq,
 * Mistral, DeepSeek, xAI, Together), with the note as context — usable from
 * every device: a phone asks the computer that holds the models and keys,
 * end-to-end encrypted through Sync, and never contacts a model service.
 *
 * SETUP (first open, and ⚙ later): three steps.
 *   ① Where do your models run? — "This device" or "Another of my devices"
 *     (lists the account's devices that share models right now).
 *   ② This device: its services, one card each — local servers are found by
 *     themselves; a cloud service takes an API key (a "Get a key" link; the
 *     key stays on this device). Test connection lists the models, the
 *     latency and a one-word answer, or shows the exact fix (CORS for THIS
 *     OS, Safari's localhost block, a wrong key…). Another device: pick it,
 *     test the round trip.
 *   ③ The default model, and on a computer: "Share with my other devices"
 *     (turns on the ai-host plugin), "Share cloud services too" (off by
 *     default: they spend your money), which models each service shares.
 *
 * CHAT: the status line is the model switcher ("● Claude Opus 5.5 ·
 * Anthropic on MacBook ▾"): every model of this device and of the online
 * hosts, grouped by service, searchable, recently used first, with badges —
 * local / cloud, price per 1M tokens, context window, size, LMArena score
 * (sources in the tooltips and the legend). The choice is kept per note; a
 * switch keeps the conversation. Context chips, quick actions, streamed
 * answers with Stop, Insert / Replace selection / Copy / New note, the
 * conversation kept per note in IndexedDB (a pref). Answers render as
 * sanitised Markdown.
 *
 * Code: ai-core.js (pure, tested), ai-service.js (routing, services, relay,
 * hosting, Cade.ai), ai-host.js (the sharing plugin), ai-scores.js (dated
 * score snapshot). Cade.ai is registered as soon as this file loads.
 * Close removes every listener, timer and request. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var BASE = Cade.baseURL();
  Cade.loadCSS('ai.css');
  var CORE_URL = BASE + 'ai-core.js', SVC_URL = BASE + 'ai-service.js';
  var ID = 'ai', PANEL_ID = 'ai-panel', CHAT_KEY = 'ai-chat:';
  var MAX_SAVED = 60, MAX_SAVED_CHARS = 400000, PICKER_ROWS = 250;

  var META = {
    name: 'AI',
    description: 'Your own AI — local models (Ollama, LM Studio, Unsloth Studio…) or cloud APIs with your keys (OpenAI, Anthropic, Gemini, OpenRouter…) — with your note as context: summarise, rewrite, continue, explain code, checklists, translate. Use it from your phone too: it asks your computer, end-to-end encrypted through Sync',
    icon: '✨',
    tags: 'ai,assistant,chat,llm,local llm,local ai,private ai,ollama,lm studio,unsloth,unsloth studio,llama,llama.cpp,mistral,gemma,qwen,deepseek,phi,openai,openai compatible,gpt,chatgpt,anthropic,claude,gemini,openrouter,groq,grok,together,summarise,summarize,rewrite,continue writing,explain code,checklist,translate,ask,prompt,model'
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
  if (!Cade.ai) Cade.ai = { version: 2, status: lazy('status'), chat: lazy('chat'), models: lazy('models'), open: function () { open(); } };

  var I = {
    chats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.7A8 8 0 1 1 21 12z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    insert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    replace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h13l-3.5-3.5"/><path d="M20 16H7l3.5 3.5"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/><path d="M12 12v6M9 15h6"/></svg>',
    retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
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
    return /(<\/(p|li|ul|ol|h\d|blockquote|code|pre|div|td|tr|tbody|table|strong|em|del|a)>)+$/.test(html)
      ? html.replace(/((<\/(p|li|ul|ol|h\d|blockquote|code|pre|div|td|tr|tbody|table|strong|em|del|a)>)+)$/, CARET + '$1') : html + CARET;
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
    Array.prototype.forEach.call(tpl.content.querySelectorAll('pre'), function (pre) {
      var code = pre.querySelector('code'), lang = code && /(?:^|\s)language-([\w+#.-]{1,24})/.exec(code.className || '');
      var box = document.createElement('div');
      box.className = 'ai-code';
      box.innerHTML = '<div class="ai-code-bar"><span class="ai-code-lang">' + (lang ? esc(lang[1]) : '') + '</span>' +
        '<button type="button" class="ai-code-copy" data-act="codecopy" aria-label="Copy code">' + I.copy + '<span>Copy</span></button></div>';
      pre.parentNode.insertBefore(box, pre);
      box.appendChild(pre);
    });
    return tpl.innerHTML;
  }

  // "anthropic:claude-opus-5-5" → "claude-opus-5-5 · Anthropic"
  function prettyPref(v) {
    var d = S.C.parsePrefModel(v);
    if (!d.model) return 'Automatic';
    return d.model + (d.ep ? ' · ' + S.C.providerOf(d.ep).label + (/\d$/.test(d.ep) ? ' ' + d.ep.replace(/^\D+/, '') : '') : '');
  }

  // ---- badges -------------------------------------------------------------------------------------
  function badgesHtml(m, o) {
    return '<span class="ai-badges">' + S.C.badges(m, o).map(function (b) {
      return '<span class="ai-bdg ai-b-' + b.k + '" title="' + esc(b.title) + '">' + esc(b.t) + '</span>';
    }).join('') + '</span>';
  }
  function legendHtml(dates) {
    dates = dates || {};
    return '<details class="ai-legend"' + (coarse() ? '' : ' open') + '><summary>What the badges mean</summary><span class="ai-bdg ai-b-local">Local</span> runs on your hardware, free · <span class="ai-bdg ai-b-cloud">Cloud</span> billed to an API key · ' +
      '<span class="ai-bdg ai-b-price">$in · $out</span> price per million tokens (OpenRouter’s public list' + (dates.catalog ? ', ' + esc(dates.catalog) : '') + ') · ' +
      '<span class="ai-bdg ai-b-ctx">200K</span> context window · <span class="ai-bdg ai-b-score">★1450</span> LMArena text score, higher is better' +
      ' · Filters: cost tiers by output price per million tokens — $ up to $3, $$ up to $15, $$$ above; quality Top = within 30 points of the best score, Strong = within 80' +
      (dates.scores ? ' (as of ' + esc(dates.scores) + ')' : '') + ' — lmarena.ai, CC BY 4.0. No badge = no reliable data.</details>';
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
    clearTimeout(s.ctxT); clearTimeout(s.pkT); cancelAnimationFrame(s.raf); cancelAnimationFrame(s.jumpRaf || 0);
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
      '<button type="button" class="ai-status" data-act="picker" aria-haspopup="dialog"><span class="ai-dot" aria-hidden="true"></span>' +
        '<span class="ai-status-t" role="status">Checking…</span><span class="ai-status-a"></span><span class="ai-status-dn">' + I.down + '</span></button>' +
      '<div class="ai-chat">' +
        '<div class="ai-logwrap"><div class="ai-log" tabindex="-1" aria-live="polite"></div>' +
          '<button type="button" class="ai-jump" data-act="jump" hidden aria-label="Jump to the latest message" title="Jump to the latest">' + I.down + '</button></div>' +
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
          '<div class="ai-foot"><span class="ai-ctxinfo"></span><span class="ai-foot-a">' +
            '<button type="button" class="ai-link ai-hubbtn" data-act="hub" title="Every note with a conversation on this device">' + I.chats + '<span>All chats</span></button>' +
            '<button type="button" class="ai-link ai-clear" data-act="clear">Clear</button></span></div>' +
        '</div>' +
      '</div>' +
      '<div class="ai-setup" hidden></div>' +
      '<div class="ai-picker" hidden role="dialog" aria-label="Choose a model"></div>' +
      '<div class="ai-hub" hidden role="dialog" aria-label="All chats" tabindex="-1"></div>' +
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
      panel: panel, q: q, svc: svc, C: C, root: q('.ai-root'), log: q('.ai-log'), input: q('.ai-in'), setupEl: q('.ai-setup'), pkEl: q('.ai-picker'), hubEl: q('.ai-hub'), jump: q('.ai-jump'), hub: null,
      view: 'chat', wiz: null, msgs: [], room: currentRoom(), ctx: 'auto', ctxRoom: '', busy: null, route: null, routeGen: 0, histGen: 0,
      pick: svc.notePick(currentRoom()), pk: null, pkT: 0,
      offs: [], offHosts: null, unuse: svc.use(), raf: 0, ctxT: 0, copies: [], fixOs: null, hosts: null
    };
    panel._onClose = cleanup;
    panel.addEventListener('click', onClick);
    panel.addEventListener('change', onChange);
    panel.addEventListener('input', onInput);
    panel.addEventListener('keydown', onKey);
    panel.addEventListener('pointerdown', onPickOpen);
    panel.addEventListener('focusin', onPickOpen);
    S.log.addEventListener('scroll', onLogScroll, { passive: true });
    S.offs.push(svc.on('host', function () { if (S) { paintStatus(); if (S.view === 'setup' && S.wiz && S.wiz.step === 3) renderSetup(); } }));
    S.offs.push(svc.on('badges', function () { if (!S) return; if (S.pk) loadPicker(); if (S.view === 'chat') refreshRoute(); }));
    S.offs.push(svc.on('prefs', function (k) {
      if (!S) return;
      if (k === 'model') refreshRoute();
      if (k === 'history') loadHistory();
      paintCtx();
    }));
    Cade.onEditorUpdate(onEd);
    document.addEventListener('visibilitychange', onVis);
    if (!svc.local().role) showSetup(1, true);
    else showChat();
    loadHistory();
  }

  // ---- status line = the model switcher ---------------------------------------------------------------
  function hostSuffix() {
    var h = S.svc.host.status();
    if (!h.enabled || S.svc.local().role !== 'local') return '';
    if (h.phase === 'live') return h.busy ? ' · answering ' + ((h.current && h.current.name) || 'a device') : ' · sharing' + (h.served ? ' (' + h.served + ' answered)' : '');
    if (h.phase === 'standby') return ' · another tab is sharing';
    if (h.phase === 'nosync') return ' · sharing needs Sync';
    if (h.phase === 'starting' || h.phase === 'retry') return ' · starting to share…';
    return '';
  }
  function remoteLine(hostName) {
    return 'This device never contacts the model service — questions go end-to-end encrypted through Sync to ' + (hostName || 'your computer') + ', which makes the call.';
  }
  function paintStatus() {
    if (!S) return;
    var r = S.route, el = S.q('.ai-status'), cls = 'wait', html = 'Checking…', a = '', title = 'Choose the model';
    if (r) {
      if (r.available) {
        var busy = r.via === 'host' && r.host && r.host.busy && !S.busy;
        cls = busy ? 'busy' : 'ok';
        html = '<b class="ai-mname">' + esc(r.model.name || r.model.id) + '</b><span class="ai-msub"> · ' + esc(r.group.label) +
          (r.via === 'host' ? ' on ' + esc(r.host.name) + (busy ? ' · busy' : '') : ' · this device' + esc(hostSuffix())) + '</span>';
        if (r.via === 'host') title = remoteLine(r.host.name) + ' Tap to choose another model.';
      } else { cls = 'off'; html = esc((r.error && r.error.info && r.error.info.title) || 'Not available'); a = /^(not-shared|model)$/.test(r.reason) ? 'Choose' : 'Fix'; }
    }
    el.className = 'ai-status ai-s-' + cls;
    el.querySelector('.ai-status-t').innerHTML = html;
    el.querySelector('.ai-status-a').textContent = a;
    el.title = title;
  }
  function refreshRoute(force) {
    if (!S) return;
    var g = ++S.routeGen;
    if (!S.route) paintStatus();
    S.svc.route(S.pick || null, force).then(function (r) {
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
      if (S.view === 'setup') { if (S.wiz && (S.wiz.step === 1 || (S.wiz.step === 2 && S.wiz.where === 'remote'))) renderSetup(); }
      else refreshRoute();
      if (S.pk && S.pk.mode !== 'allow') loadPicker();
    });
    if (!on && S.offHosts) { S.offHosts(); S.offHosts = null; }
  }

  // ---- the model picker (chat: per note · default: setup · allow: what a service shares) ----------------
  // Picker filters, remembered on this device.
  var PK_FILTER_KEY = 'cade-ai-picker-filters';
  function loadPkFilters() { try { return S.C.normFilters(JSON.parse(localStorage.getItem(PK_FILTER_KEY) || '{}')); } catch (e) { return S.C.normFilters({}); } }
  function savePkFilters(f) { try { localStorage.setItem(PK_FILTER_KEY, JSON.stringify(f)); } catch (e) {} }
  var PK_FILTER_KEYS = ['where', 'ctx', 'cost', 'quality', 'sort'];
  function pkFilterBar(f, order) {
    var sel = function (key, label, opts) {
      var on = !!f[key];
      return '<label class="ai-pk-fc' + (on ? ' on' : '') + '"><span class="ai-sr">' + label + '</span><select class="ai-pk-f" data-f="' + key + '" aria-label="' + label + '">' +
        opts.map(function (o) { return '<option value="' + o[0] + '"' + (String(f[key]) === String(o[0]) || (!f[key] && !o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>';
    };
    var html = {
      where: sel('where', 'Where it runs', [['', 'Local + cloud'], ['local', 'Local'], ['cloud', 'Cloud']]),
      ctx: sel('ctx', 'Context window', [['0', 'Any context'], ['32000', '32K+'], ['128000', '128K+'], ['1000000', '1M+']]),
      cost: sel('cost', 'Cost', [['', 'Any cost'], ['free', 'Free'], ['$', 'Up to $'], ['$$', 'Up to $$']]),
      quality: sel('quality', 'Quality', [['', 'Any quality'], ['strong', 'Strong+'], ['top', 'Top']]),
      sort: sel('sort', 'Sort', [['', 'By service'], ['quality', 'Best first'], ['price', 'Cheapest first'], ['ctx', 'Longest context'], ['name', 'A–Z']])
    };
    return '<div class="ai-pk-filters" role="group" aria-label="Filter models">' + (order || PK_FILTER_KEYS).map(function (k) { return html[k]; }).join('') +
      (S.C.filtersActive(f) || f.sort ? '<button type="button" class="ai-link ai-pk-freset" data-act="pk-freset">Reset</button>' : '') + '</div>';
  }
  function openPicker(mode, opts) {
    S.pk = { mode: mode, opts: opts || {}, q: '', groups: null, loading: true, sel: null, f: mode === 'allow' ? S.C.normFilters({}) : loadPkFilters() };
    // filters already in use go first, so on a phone they're in view without swiping
    S.pk.fOrder = PK_FILTER_KEYS.filter(function (k) { return S.pk.f[k]; }).concat(PK_FILTER_KEYS.filter(function (k) { return !S.pk.f[k]; }));
    if (mode === 'allow') {
      var ep = S.svc.endpoint(opts.ep);
      S.pk.sel = ep && ep.allow.length ? ep.allow.slice() : null;
    }
    S.pkEl.hidden = false;
    S.root.classList.add('ai-pk-open');
    renderPicker();
    loadPicker();
    var qi = S.pkEl.querySelector('.ai-pk-q');
    if (qi && !coarse()) qi.focus();
  }
  function closePicker() {
    if (!S || !S.pk) return;
    S.pk = null;
    S.pkEl.hidden = true;
    S.pkEl.innerHTML = '';
    S.root.classList.remove('ai-pk-open');
  }
  function loadPicker() {
    var pk = S.pk, svc = S.svc;
    if (!pk) return;
    var p;
    if (pk.mode === 'allow') p = svc.localGroups(false, true).then(function (g) { return g.filter(function (x) { return x.ep === pk.opts.ep; }); });
    else if (pk.mode === 'default' && S.wiz && S.wiz.where === 'local') p = svc.localGroups(false, true);
    else if (pk.mode === 'default') p = Promise.resolve(svc.hostGroups(S.hosts || []));
    else p = svc.available(false).then(function (av) { return av.groups; });
    p.then(function (groups) {
      if (!S || S.pk !== pk) return;
      pk.groups = groups; pk.loading = false;
      renderPicker();
    });
  }
  function curRef() {
    var pk = S.pk;
    if (pk.mode === 'default') return S.wiz ? S.wiz.model : '';
    var r = S.route;
    return r && r.available ? S.C.refKey(r.group.src, r.group.ep, r.model.id) : '';
  }
  function pkRow(g, m, cur, mode) {
    var ref = S.C.refKey(g.src, g.ep, m.id), on, extra = '';
    if (mode === 'allow') {
      on = !S.pk.sel || S.pk.sel.indexOf(m.id) >= 0;
      extra = '<span class="ai-pk-ck" aria-hidden="true">' + (on ? '☑' : '☐') + '</span>';
    } else on = mode === 'default' ? cur === g.ep + ':' + m.id : cur === ref;
    return '<button type="button" class="ai-pk-row' + (on ? ' on' : '') + '" role="option" aria-selected="' + on + '" data-pk="' + esc(ref) + '">' + extra +
      '<span class="ai-pk-main"><span class="ai-pk-n">' + esc(m.name || m.id) + '</span>' + (m.name && m.name !== m.id ? '<span class="ai-pk-id">' + esc(m.id) + '</span>' : '') + '</span>' +
      badgesHtml(m, { catalogDate: g.catalogDate || S.svc.catalogDate() }) + '</button>';
  }
  function renderPicker() {
    var pk = S.pk, C = S.C;
    if (!pk) return;
    var role = S.svc.local().role, head, body = '', foot = '', q = pk.q.trim().toLowerCase(), cur = curRef(), shown = 0, total = 0, scoresDate = '', catDate = S.svc.catalogDate();
    var title = pk.mode === 'allow' ? 'Models ' + esc((S.svc.endpoint(pk.opts.ep) || {}).label || '') + ' shares' : pk.mode === 'default' ? 'Default model' : 'Choose a model';
    head = '<div class="ai-pk-head"><span class="ai-pk-title">' + title + '</span><button type="button" class="ai-pk-x" data-act="pk-close" aria-label="Close">×</button></div>' +
      '<input class="ai-pk-q" type="search" placeholder="Search models, services, devices" aria-label="Search models" value="' + esc(pk.q) + '" autocomplete="off" spellcheck="false">' +
      (pk.mode === 'allow' ? '' : pkFilterBar(pk.f, pk.fOrder));
    var hidden = 0, best = 0;
    if (pk.loading && !pk.groups) body = '<div class="ai-busyline"><span class="ai-spin"></span>Loading models…</div>';
    else {
      var groups = pk.groups || [], fOn = pk.mode !== 'allow' && C.filtersActive(pk.f);
      best = C.bestScore(S.svc.badges().scores);
      groups.forEach(function (g) { g.models.forEach(function (m) { if (m.score && m.score.r > best) best = m.score.r; }); });
      var textMatch = function (g, m) {
        if (!q) return true;
        return (m.name + ' ' + m.id + ' ' + g.label + ' ' + g.srcName + ' ' + (m.where || '')).toLowerCase().indexOf(q) >= 0;
      };
      var match = function (g, m) { return textMatch(g, m) && (!fOn || C.passes(m, pk.f, best)); };
      if (pk.mode === 'allow') {
        var g0 = groups[0];
        body += '<label class="ai-switch ai-pk-all"><input type="checkbox" class="ai-pk-allcb"' + (!pk.sel ? ' checked' : '') + '><span class="ai-switch-ui" aria-hidden="true"></span><span><b>Share every model</b><small>Or pick the ones your other devices may use</small></span></label>';
        if (g0) g0.models.forEach(function (m) { total++; if (match(g0, m) && shown < PICKER_ROWS) { shown++; body += pkRow(g0, m, '', 'allow'); } });
      } else {
        if (pk.mode === 'default') body += '<button type="button" class="ai-pk-row' + (!cur ? ' on' : '') + '" data-pk=""><span class="ai-pk-main"><span class="ai-pk-n">Automatic</span><span class="ai-pk-id">' +
          (pk.opts.where === 'remote' ? 'what the sharing device picks' : 'the first available model') + '</span></span></button>';
        // recently used, then each service
        var rec = pk.mode === 'chat' ? S.svc.recent() : [], recRows = '';
        rec.forEach(function (ref) {
          var r = C.parseRef(ref);
          if (!r) return;
          groups.some(function (g) {
            if (g.src !== r.src || g.ep !== r.ep || !g.ok) return false;
            var m = g.models.filter(function (x) { return x.id === r.model; })[0];
            if (m && match(g, m)) recRows += pkRow(g, m, cur, pk.mode).replace('<span class="ai-pk-main">', '<span class="ai-pk-main"><span class="ai-pk-via">' + esc(g.label + (g.src === 'local' ? '' : ' · ' + g.srcName)) + '</span>');
            return !!m;
          });
        });
        if (recRows && !q) body += '<div class="ai-pk-g">Recently used</div>' + recRows;
        groups.forEach(function (g) {
          if (g.scoresDate) scoresDate = g.scoresDate;
          if (g.catalogDate) catDate = g.catalogDate;
          var rows = '';
          C.sortModels(g.models, pk.f).forEach(function (m) {
            total++;
            if (!g.ok) return;
            if (!match(g, m)) { if (fOn && textMatch(g, m)) hidden++; return; }
            if (shown < PICKER_ROWS) { shown++; rows += pkRow(g, m, cur, pk.mode); }
          });
          var gh = '<div class="ai-pk-g"><span>' + esc(g.label) + '</span><span class="ai-pk-gs">' + (g.src === 'local' ? 'this device' : 'on ' + esc(g.srcName)) + ' · ' + (g.where === 'cloud' ? 'cloud' : 'local') + '</span></div>';
          if (!g.ok) { if (!q && !fOn) body += gh + '<div class="ai-pk-err">' + esc((g.error && g.error.info && g.error.info.title) || 'Not answering') + ' — <button type="button" class="ai-link" data-act="setup2">Fix</button></div>'; return; }
          if (rows) body += gh + rows + (g.more && !q ? '<div class="ai-pk-more">+' + g.more + ' more not shared — choose them on ' + esc(g.srcName) + '</div>' : '');
        });
        if (!groups.length) body += '<div class="ai-pk-empty">' + (role === 'local' ? 'No services set up yet.' : 'None of your devices is sharing a model right now.') +
          ' <button type="button" class="ai-link" data-act="setup2">Open setup</button></div>';
      }
      if (hidden) body = '<div class="ai-pk-hidden" title="Models without the data a filter needs (no price, score or context listed) count as not matching">' +
        hidden + ' hidden by filters · <button type="button" class="ai-link" data-act="pk-freset">Show all</button></div>' + body;
      if (q && !shown) body += '<div class="ai-pk-empty">No model matches “' + esc(pk.q) + '”' + (hidden ? ' with these filters' : '') + '.</div>';
      else if (!shown && hidden) body += '<div class="ai-pk-empty">No model matches these filters.</div>';
      if (shown >= PICKER_ROWS && total > shown) body += '<div class="ai-pk-more">Showing ' + shown + ' of ' + total + ' — type to narrow it down.</div>';
      var sc = S.svc.badges().scores;
      if (!scoresDate && sc) scoresDate = sc.date;
    }
    if (pk.mode === 'allow') foot = '<div class="ai-pk-btns"><button type="button" class="ai-btn" data-act="pk-close">Cancel</button><button type="button" class="ai-btn ai-pri" data-act="pk-save">Save</button></div>';
    else {
      var r = S.route;
      if (pk.mode === 'chat' && role !== 'local') foot += '<div class="ai-guard">' + I.lock + '<span>' + esc(remoteLine(r && r.host ? r.host.name : '')) + '</span></div>';
      if (pk.mode === 'chat') {
        var d = S.svc.pref('model');
        foot += '<div class="ai-pk-def">Default for new notes: <b>' + esc(prettyPref(d)) + '</b>' +
          (r && r.available && d !== r.group.ep + ':' + r.model.id ? ' · <button type="button" class="ai-link" data-act="pk-default">Make this one the default</button>' : '') +
          ' · <button type="button" class="ai-link" data-act="setup2">Services…</button></div>';
      }
      foot += legendHtml({ scores: scoresDate, catalog: catDate });
    }
    var y = 0, list = S.pkEl.querySelector('.ai-pk-list');
    if (list) y = list.scrollTop;
    var hadFocus = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('ai-pk-q');
    var fFocus = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('ai-pk-f') ? document.activeElement.dataset.f : '';
    S.pkEl.innerHTML = head + '<div class="ai-pk-list" role="listbox">' + body + '</div><div class="ai-pk-foot">' + foot + '</div>';
    list = S.pkEl.querySelector('.ai-pk-list');
    if (list) list.scrollTop = y;
    if (hadFocus) { var qi = S.pkEl.querySelector('.ai-pk-q'); qi.focus(); try { qi.setSelectionRange(qi.value.length, qi.value.length); } catch (e) {} }
    else if (fFocus) { var fs = S.pkEl.querySelector('.ai-pk-f[data-f="' + fFocus + '"]'); if (fs) fs.focus(); }
  }
  function pickerChoose(ref) {
    var pk = S.pk, C = S.C;
    if (pk.mode === 'allow') {
      var r = C.parseRef(ref), all = ((pk.groups || [])[0] || { models: [] }).models.map(function (m) { return m.id; });
      if (!pk.sel) pk.sel = all.slice();
      var i = pk.sel.indexOf(r.model);
      if (i >= 0) pk.sel.splice(i, 1); else pk.sel.push(r.model);
      if (pk.sel.length === all.length) pk.sel = null;
      renderPicker();
      return;
    }
    if (pk.mode === 'default') {
      var d = ref ? C.parseRef(ref) : null;
      S.wiz.model = d ? d.ep + ':' + d.model : '';
      closePicker();
      renderSetup();
      return;
    }
    S.pick = ref;
    S.svc.setNotePick(S.room, ref);
    closePicker();
    S.route = null;
    refreshRoute();
  }

  // ---- views -----------------------------------------------------------------------------------------
  function showChat() {
    closePicker();
    S.view = 'chat'; S.wiz = null;
    S.root.dataset.view = 'chat';
    S.setupEl.hidden = true;
    S.q('.ai-chat').hidden = false;
    watchHosts(S.svc.synced());
    refreshRoute();
    paintCtx();
    renderLog();
  }
  function toggleSetup() {
    if (S.view === 'setup' && S.svc.local().role) { if (S.wiz && S.wiz.abort) S.wiz.abort.abort(); showChat(); }
    else showSetup(1, false);
  }

  // ---- all chats: every note with a saved conversation on this device ------------------------------------
  function ago(ts) {
    var s = Math.max(0, (Date.now() - (+ts || 0)) / 1000);
    if (!ts) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 86400 * 7) { var d = Math.floor(s / 86400); return d === 1 ? 'yesterday' : d + ' days ago'; }
    return new Date(+ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(+ts).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  function roomList() { try { var ra = Cade.roomsApi; return (ra && ra.list ? ra.list() : []) || []; } catch (e) { return []; } }
  function openHub() {
    if (!S || S.view !== 'chat') return;
    closePicker();
    S.hub = { q: '', items: null };
    S.hubEl.hidden = false;
    S.root.classList.add('ai-pk-open');
    renderHub();
    loadHub();
    var qi = S.hubEl.querySelector('.ai-pk-q');
    if (qi && !coarse()) qi.focus(); else S.hubEl.focus({ preventScroll: true });
  }
  function closeHub() {
    if (!S || !S.hub) return;
    S.hub = null;
    S.hubEl.hidden = true;
    S.hubEl.innerHTML = '';
    S.root.classList.remove('ai-pk-open');
  }
  function loadHub() {
    var h = S.hub, st = Cade.idbStore;
    if (!st || !st.keys) { h.items = []; renderHub(); return; }
    st.keys().then(function (keys) {
      keys = (keys || []).filter(function (k) { return typeof k === 'string' && k.indexOf(CHAT_KEY) === 0; });
      return Promise.all(keys.map(function (k) {
        return st.get(k).then(function (v) { return { room: k.slice(CHAT_KEY.length), v: v }; }, function () { return null; });
      }));
    }).then(function (rows) {
      if (!S || S.hub !== h) return;
      // the list holds names lower-cased while the open note keeps its typed casing; "" is the
      // note you have before Sync / rooms are set up, which always exists
      var exists = { '': 1 };
      roomList().forEach(function (n) { exists[String(n).toLowerCase()] = 1; });
      h.items = (rows || []).filter(function (r) { return r && r.v && Array.isArray(r.v.msgs) && r.v.msgs.length; }).map(function (r) {
        var msgs = r.v.msgs, qs = msgs.filter(function (m) { return m.role === 'user'; }), lastQ = qs[qs.length - 1];
        var lastA = msgs.filter(function (m) { return m.role === 'assistant' && m.model; }).pop();
        var at = r.v.at || msgs.reduce(function (n, m) { return Math.max(n, +m.at || 0); }, 0);
        return { room: r.room, at: at, n: qs.length, missing: !exists[r.room.toLowerCase()],
          q: lastQ ? String(lastQ.show || lastQ.content || '').replace(/\s+/g, ' ').trim() : '',
          model: lastA ? (lastA.modelName || lastA.model) : '',
          text: (r.room + ' ' + msgs.map(function (m) { return m.show || m.content || ''; }).join(' ')).toLowerCase() };
      }).sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
      renderHub();
    }, function () { if (S && S.hub === h) { h.items = []; renderHub(); } });
  }
  function renderHub() {
    var h = S.hub;
    if (!h) return;
    var y = 0, list = S.hubEl.querySelector('.ai-pk-list'), qi = S.hubEl.querySelector('.ai-pk-q'), hadFocus = qi && document.activeElement === qi,
      inside = S.hubEl.contains(document.activeElement);
    if (list) y = list.scrollTop;
    var q = h.q.trim().toLowerCase(), body = '';
    if (!h.items) body = '<div class="ai-busyline"><span class="ai-spin"></span>Looking for chats…</div>';
    else {
      var items = q ? h.items.filter(function (it) { return it.text.indexOf(q) >= 0; }) : h.items;
      if (!S.svc.pref('history')) body += '<p class="ai-pk-empty">Conversations aren’t being kept — turn on “Keep the conversation for each note” in AI preferences.</p>';
      if (!h.items.length) body += '<p class="ai-pk-empty">No chats yet. Every note you ask the AI about shows up here, newest first.</p>';
      else if (!items.length) body += '<p class="ai-pk-empty">No chat matches “' + esc(h.q.trim()) + '”.</p>';
      body += items.map(function (it) {
        var cur = it.room === S.room, live = S.busy && S.busy.room === it.room;
        var tags = (cur ? '<span class="ai-hub-tag">this note</span>' : '') + (live ? '<span class="ai-hub-tag ai-hub-live">answering…</span>' : '') +
          (it.missing ? '<span class="ai-hub-tag ai-hub-gone">note not found</span>' : '');
        var sub = [it.n + (it.n === 1 ? ' question' : ' questions'), ago(it.at), it.model].filter(Boolean).map(esc).join(' · ');
        return '<div class="ai-hub-row' + (cur ? ' on' : '') + '">' +
          '<button type="button" class="ai-hub-main" data-act="hub-open" data-room="' + esc(it.room) + '"' + (it.missing ? ' disabled' : '') + '>' +
            '<span class="ai-hub-n">' + esc(it.room || 'Your note (no room)') + tags + '</span>' +
            (it.q ? '<span class="ai-hub-q">' + esc(it.q.length > 140 ? it.q.slice(0, 140) + '…' : it.q) + '</span>' : '') +
            '<span class="ai-hub-sub">' + sub + '</span></button>' +
          '<button type="button" class="ai-hub-del" data-act="hub-del" data-room="' + esc(it.room) + '" aria-label="Delete the chat for ' + esc(it.room) + '" title="Delete this chat">×</button></div>';
      }).join('');
    }
    S.hubEl.innerHTML = '<div class="ai-pk-head"><span class="ai-pk-title">All chats' + (h.items && h.items.length ? ' <small>' + h.items.length + '</small>' : '') + '</span>' +
        '<button type="button" class="ai-pk-x" data-act="hub-close" aria-label="Close">×</button></div>' +
      '<input class="ai-pk-q ai-hub-q" type="search" placeholder="Search notes and conversations" aria-label="Search chats" value="' + esc(h.q) + '" autocomplete="off" spellcheck="false">' +
      '<div class="ai-pk-list">' + body + '</div>' +
      '<div class="ai-hub-foot">Chats are kept on this device only.</div>';
    list = S.hubEl.querySelector('.ai-pk-list');
    if (list) list.scrollTop = y;
    if (hadFocus) { qi = S.hubEl.querySelector('.ai-pk-q'); qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
    else if (inside && !S.hubEl.contains(document.activeElement)) S.hubEl.focus({ preventScroll: true });   // Escape keeps working
  }
  function hubOpen(room) {
    var ra = Cade.roomsApi;
    closeHub();
    if (room === S.room) return;
    if (!room) { toast('That chat belongs to your note from before rooms were set up', 'info', 2600); return; }
    if (!ra || typeof ra.switchRoom !== 'function') { toast('Can’t open notes from here', 'error'); return; }
    Promise.resolve(ra.switchRoom(room)).then(function () { if (S) onEd(null); }, function () { toast('Couldn’t open “' + room + '”', 'error'); });
  }
  // Two taps: the first arms the button ("Delete?"), the second deletes.
  function hubDelete(btn) {
    var room = btn.dataset.room;
    if (!btn.classList.contains('ai-armed')) {
      btn.classList.add('ai-armed'); btn.textContent = 'Delete?';
      setTimeout(function () { if (btn.isConnected) { btn.classList.remove('ai-armed'); btn.textContent = '×'; } }, 2500);
      return;
    }
    if (S.busy && S.busy.room === room) { toast('Wait for the answer to finish', 'info', 1800); return; }
    Promise.resolve(Cade.idbStore && Cade.idbStore.remove(CHAT_KEY + room)).catch(function () {}).then(function () {
      if (!S) return;
      if (room === S.room) { S.msgs = []; renderLog(); }
      if (S.hub) { S.hub.items = (S.hub.items || []).filter(function (it) { return it.room !== room; }); renderHub(); }
    });
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
      ['show', 'ctxLabel', 'action', 'model', 'modelName', 'epLabel', 'host', 'via', 'ms', 'stopped', 'reason'].forEach(function (k) { if (m[k]) o[k] = m[k]; });
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
    else if (r && r.available && r.via === 'host') lines = '<div class="ai-guard">' + I.lock + '<span>' + esc(remoteLine(r.host.name)) + '</span></div>';
    return '<div class="ai-empty"><div class="ai-empty-ic" aria-hidden="true">✨</div>' +
      '<p><b>Ask your AI about this note.</b></p>' +
      '<p>Choose what it reads below, then tap an action or type a question. The ▾ above switches the model.</p>' + lines + '</div>';
  }
  function metaHtml(m) {
    if (m.role === 'user') return m.ctxLabel ? '<div class="ai-meta">' + esc(m.ctxLabel) + '</div>' : '';
    var bits = [];
    if (m.model) bits.push(esc(m.modelName || m.model) + (m.epLabel ? ' · ' + esc(m.epLabel) : ''));
    if (m.via === 'host' && m.host) bits.push('on ' + esc(m.host));
    if (m.ms) bits.push(esc(S.C.fmtMs(m.ms)));
    if (m.reason === 'length') bits.push('cut off at the length limit');
    if (m.reason === 'refusal') bits.push('the model declined');
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
      err = fixHtml(info, { retry: i, pick: /^(not-shared|model|host-unready|refusal)$/.test(m.err.code),
        setup: /^(unreachable|cors|mixed|lna|auth|key-missing|billing|notfound|nosync|not-setup|host-offline)$/.test(m.err.code) });
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
    paintJump();
  }
  // "Jump to the latest": shown once the newest message is out of view; a dot while an
  // answer is still coming in below.
  function onLogScroll() { if (S && !S.jumpRaf) S.jumpRaf = requestAnimationFrame(function () { if (S) { S.jumpRaf = 0; paintJump(); } }); }
  function paintJump() {
    if (!S || !S.jump) return;
    var l = S.log, away = S.view === 'chat' && S.msgs.length > 0 && l.scrollHeight - l.scrollTop - l.clientHeight > 160;
    S.jump.hidden = !away;
    S.jump.classList.toggle('ai-jump-new', away && !!(S.busy && S.busy.room === S.room));
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
      paintJump();
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
  function budgetNow() {
    var r = S.route;
    return S.C.budget({ contextWindow: r && r.available && r.group.provider === 'ollama' ? S.svc.pref('contextWindow') : 0, maxTokens: S.svc.pref('maxTokens'),
      modelCtx: r && r.available ? r.model.ctx : 0 });
  }
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
    var info = '', B = budgetNow();
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
      var a = C.assemble({ system: svc.pref('system'), history: hist, instruction: text, ctx: ctx, budget: budgetNow() });
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
      model: S.pick || null,
      signal: ctl.signal,
      onStart: function (i) {
        bm.model = i.model; bm.modelName = i.modelName; bm.epLabel = i.epLabel; bm.host = i.host || ''; bm.via = i.via;
        bm.note = i.via === 'host' ? 'Sending to ' + i.host + '…' : (i.provider === 'ollama' || i.provider === 'lmstudio' || i.provider === 'unsloth' ? 'Waiting for the model… (the first answer loads it)' : 'Waiting for ' + i.epLabel + '…');
        scheduleLive();
      },
      onToken: function (d, full) { bm.content = full; bm.note = ''; scheduleLive(); },
      onThinking: function () { if (!bm.content) { bm.note = 'Thinking…'; scheduleLive(); } },
      onEvent: function (m) {
        if (bm.content) return;
        if (m.t === 'a') bm.note = m.pos > 0 ? 'Waiting in line (' + m.pos + ' ahead)…' : 'Working on it…';
        else if (m.t === 'w') bm.note = 'Waiting for ' + (bm.host || 'the other device') + ' to say yes…';
        else if (m.t === 's') { bm.model = m.model || bm.model; bm.note = 'Waiting for the model…'; }
        else if (m.t === 'k') bm.note = 'Thinking…';
        scheduleLive();
      }
    }).then(function (r) {
      bm.content = r.text; bm.ms = r.ms; bm.reason = r.reason; bm.model = r.model || bm.model;
      if (r.reason === 'refusal' && !stripThink(r.text).trim()) bm.err = { code: 'refusal', info: S && S.svc.decorate(S.C.AiError('refusal', 'declined')).info, title: 'The model declined this request' };
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
      if (bm.err && /^(unreachable|cors|mixed|lna|model|auth|key-missing|host-offline|host-silent|host-unready|not-shared|nosync)$/.test(bm.err.code)) refreshRoute(true);
    });
  }
  function retry(i) {
    var bm = S.msgs[i], um = S.msgs[i - 1];
    if (!bm || !um || um.role !== 'user' || S.busy) return;
    S.msgs.splice(i, 1);
    var svc = S.svc;
    var hist = S.msgs.slice(0, i - 1).filter(function (m) { return !m.err && m.content; }).map(function (m) { return { role: m.role, content: m.content }; });
    // the stored question already holds its context; keep the history that fits
    var a = S.C.assemble({ system: svc.pref('system'), history: hist, instruction: um.content, ctx: null, budget: budgetNow() });
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
      if (s.link) return '<p><a class="ai-ext" href="' + esc(S.C.safeUrl(s.link)) + '" target="_blank" rel="noopener noreferrer">' + esc(s.label || s.link) + ' ↗</a></p>';
      return '<p>' + esc(s.t) + '</p>';
    }).join('');
  }
  // info: C.explain(...) result. o: { retry: msg index, setup: bool, again: ep id }
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
    if (o.again) btns += '<button type="button" class="ai-btn ai-pri" data-act="ep-test" data-ep="' + esc(o.again) + '">Test again</button>';
    if (o.retry != null) btns += '<button type="button" class="ai-btn" data-act="retry" data-i="' + o.retry + '">' + I.retry + '<span>Try again</span></button>';
    if (o.pick) btns += '<button type="button" class="ai-btn" data-act="picker">' + I.down + '<span>Choose another model</span></button>';
    if (o.setup) btns += '<button type="button" class="ai-btn" data-act="setup2">Open setup</button>';
    return h + (btns ? '<div class="ai-btns">' + btns + '</div>' : '') + '</div>';
  }

  // ---- setup wizard ------------------------------------------------------------------------------------
  function showSetup(step, first) {
    var svc = S.svc, lc = svc.local();
    closePicker();
    if (S.wiz && S.wiz.abort) S.wiz.abort.abort();
    S.wiz = {
      step: step || 1, first: !!first, where: lc.role || (phoneish() ? 'remote' : 'local'),
      open: '', tests: {}, det: null, detecting: false, model: String(svc.pref('model') || ''),
      share: lc.role === 'local' && !!svc.pref('share'), shareCloud: !!svc.pref('shareCloud'), policy: svc.pref('policy') || 'auto',
      host: lc.host || '', htest: null, phase: '', gen: 0, abort: null
    };
    S.view = 'setup';
    S.root.dataset.view = 'setup';
    S.q('.ai-chat').hidden = true;
    S.setupEl.hidden = false;
    watchHosts(true);
    renderSetup();
    if (S.wiz.step === 2) enterStep2();
  }
  function stepsBar(W) {
    var names = ['Where', W.where === 'remote' ? 'Device' : 'Services', 'Model'];
    return '<ol class="ai-steps-bar">' + names.map(function (n, i) {
      return '<li class="' + (i + 1 === W.step ? 'on' : i + 1 < W.step ? 'done' : '') + '"><span>' + (i + 1) + '</span>' + n + '</li>';
    }).join('') + '</ol>';
  }
  function navHtml(back, next, nextLabel, nextOff) {
    return '<div class="ai-nav">' + (back ? '<button type="button" class="ai-btn" data-act="' + back + '">Back</button>' : '<span></span>') +
      (next ? '<button type="button" class="ai-btn ai-pri" data-act="' + next + '"' + (nextOff ? ' disabled' : '') + '>' + esc(nextLabel || 'Next') + '</button>' : '') + '</div>';
  }
  function hostLine(h) {
    var n = 0, cloud = 0;
    h.providers.forEach(function (p) { n += p.models.length; if (p.where === 'cloud') cloud++; });
    var bits = [n + (n === 1 ? ' model' : ' models') + ' · ' + h.providers.map(function (p) { return p.label; }).join(', ')];
    if (!h.ok) bits.push('its model services aren’t answering');
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
      var local = '<button type="button" class="ai-card' + (W.where === 'local' ? ' on' : '') + '" data-where="local"><span class="ai-card-ic" aria-hidden="true">💻</span><span class="ai-card-b"><b>This device</b>' +
        '<span>Ollama or LM Studio on this computer, and/or cloud services with your API key (OpenAI, Anthropic, Gemini, OpenRouter…)</span>' +
        (e.secure && e.browser === 'safari' && !e.ios ? '<span class="ai-warn">Safari can’t reach models on this Mac (cloud services work) — Chrome, Edge or Firefox can</span>' : '') +
        (e.ios || e.os === 'android' ? '<span class="ai-faint">On a phone, usually only cloud services — or use your computer’s</span>' : '') + '</span></button>';
      var hl = hosts.length ? '<span class="ai-ok">● ' + esc(hosts.map(function (x) { return x.name; }).slice(0, 2).join(', ')) + (hosts.length > 1 ? ' are' : ' is') + ' sharing now</span>'
        : (svc.synced() ? '<span class="ai-faint">None of your devices is sharing yet</span>' : '<span class="ai-faint">Needs Sync on both devices</span>');
      var remote = '<button type="button" class="ai-card' + (W.where === 'remote' ? ' on' : '') + '" data-where="remote"><span class="ai-card-ic" aria-hidden="true">📱</span><span class="ai-card-b"><b>Another of my devices</b>' +
        '<span>Ask your computer’s models from here — end-to-end encrypted through Sync; this device never contacts a model service</span>' + hl + '</span></button>';
      h += '<h3 class="ai-h">Where do your models run?</h3><p class="ai-sub">Your own AI: your models and your keys.</p>' +
        '<div class="ai-cards">' + (phoneish() ? remote + local : local + remote) + '</div>';
      h += '<div class="ai-wiz-foot">' + (!W.first ? '<button type="button" class="ai-link" data-act="w-cancel">Cancel</button>' : '<span></span>') +
        '<button type="button" class="ai-link" data-act="prefs">All preferences…</button>' +
        (svc.local().role ? '<button type="button" class="ai-link ai-danger" data-act="w-off">Turn AI off on this device</button>' : '') + '</div>';
    } else if (W.step === 2 && W.where === 'local') {
      var eps = svc.endpoints(true), anyOk = eps.some(function (x) { var t = W.tests[x.id]; return x.on && t && t.res; });
      h += '<h3 class="ai-h">Connect your model services</h3><p class="ai-sub">Use one or several. Addresses and API keys stay on this device — never synced, never sent to your other devices.</p>';
      if (W.detecting) h += '<div class="ai-busyline"><span class="ai-spin"></span>Looking for Ollama, LM Studio, Unsloth Studio and other servers on this computer…</div>' + lnaHint();
      if (W.det && W.det.mixed && !eps.some(function (x) { return x.where === 'cloud'; })) h += fixHtml(C.explain('mixed', e), {});
      h += '<div class="ai-eps">' + eps.map(epCardHtml).join('') + '</div>';
      if (!eps.length && !W.detecting) h += '<p class="ai-faint ai-c">Nothing set up yet — add a service below.</p>';
      h += '<div class="ai-add"><div class="ai-add-h">On this computer <button type="button" class="ai-link" data-act="w-detect"' + (W.detecting ? ' disabled' : '') + '>Find automatically</button></div><div class="ai-add-row">' +
        ['ollama', 'lmstudio', 'unsloth', 'custom'].map(addBtn).join('') + '</div>' +
        '<div class="ai-add-h">Cloud — with your API key</div><div class="ai-add-row">' +
        C.PROVIDER_ORDER.filter(function (p) { return C.PROVIDERS[p].where === 'cloud'; }).map(addBtn).join('') + '</div></div>';
      h += navHtml('w-back', 'w-next', 'Next', !anyOk);
    } else if (W.step === 2) {
      h += '<h3 class="ai-h">Use models on another device</h3>';
      if (!svc.synced()) h += fixHtml(C.explain('nosync', e), {});
      else {
        h += '<div class="ai-guard">' + I.lock + '<span>' + esc(remoteLine(hosts.length === 1 ? hosts[0].name : '')) + ' Its API keys stay there.</span></div>';
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
      h += '<h3 class="ai-h">' + (W.where === 'local' ? 'Model and sharing' : 'Pick a model') + '</h3>';
      h += '<div class="ai-field"><span>Default model <small>new notes start with it; ▾ in the chat switches per note</small></span>' +
        '<button type="button" class="ai-defbtn" data-act="w-model"><span>' + esc(prettyPref(W.model)) + '</span>' + I.down + '</button></div>';
      if (W.where === 'local') {
        var sync = svc.synced(), cloudEps = svc.endpoints(false).filter(function (x) { return x.where === 'cloud'; });
        h += '<div class="ai-share">' +
          '<label class="ai-switch"><input type="checkbox" class="ai-share-cb"' + (W.share && sync ? ' checked' : '') + (sync ? '' : ' disabled') + '><span class="ai-switch-ui" aria-hidden="true"></span>' +
          '<span><b>Share with my other devices</b><small>' + (sync ? 'Your phone and other devices with the same Sync can use the models here.' : 'Needs Sync — set it up first (the dot in the menu bar).') + '</small></span></label>' +
          '<p class="ai-privacy">🔒 Questions and answers are end-to-end encrypted with your Sync key and deleted once delivered. Your other devices never see your API keys or contact a model service — this device makes the calls.</p>';
        if (W.share && sync) {
          h += '<div class="ai-seg ai-pol" role="radiogroup" aria-label="When another device asks">' + [['auto', 'Answer automatically'], ['ask', 'Ask me each time']].map(function (x) {
            return '<button type="button" role="radio" aria-checked="' + (W.policy === x[0]) + '" class="' + (W.policy === x[0] ? 'on' : '') + '" data-pol="' + x[0] + '">' + x[1] + '</button>';
          }).join('') + '</div>';
          if (cloudEps.length) h += '<label class="ai-switch ai-sub2"><input type="checkbox" class="ai-sharecloud-cb"' + (W.shareCloud ? ' checked' : '') + '><span class="ai-switch-ui" aria-hidden="true"></span>' +
            '<span><b>Share cloud services too</b><small>' + esc(cloudEps.map(function (x) { return x.label; }).join(', ')) + ' — your other devices would spend this device’s API keys (' + (+svc.pref('cloudMaxTokens') > 0 ? 'up to ' + svc.pref('cloudMaxTokens') + ' tokens an answer' : 'no answer-length limit') + '; AI preferences). Off: only local models are shared.</small></span></label>';
          h += '<div class="ai-shared"><div class="ai-add-h">Shared models</div>' + svc.endpoints(false).map(function (x) {
            var off = x.where === 'cloud' && !W.shareCloud;
            return '<div class="ai-shared-r' + (off ? ' off' : '') + '"><span><b>' + esc(x.label) + '</b> <small>' + (off ? 'not shared (cloud)' : x.allow.length ? x.allow.length + ' chosen' : 'all models') + '</small></span>' +
              (off ? '' : '<button type="button" class="ai-link" data-act="w-allow" data-ep="' + esc(x.id) + '">Choose…</button>') + '</div>';
          }).join('') + '</div>';
          h += '<p class="ai-tip">Keep a txt tab open on this computer (in the background is fine) and the computer awake. ' +
            (e.browser === 'chrome' || e.browser === 'edge' ? 'Tip: add this site to Settings → Performance → “Always keep these sites active”.' : '') + '</p>';
        }
        h += '</div>';
      } else h += '<div class="ai-guard">' + I.lock + '<span>' + esc(remoteLine('')) + '</span></div>';
      h += navHtml('w-back', 'w-done', 'Start chatting', false);
    }
    h += '</div>';
    var y = S.setupEl.scrollTop, ae = document.activeElement, focusKey = ae && S.setupEl.contains(ae) && ae.dataset ? (ae.dataset.f || '') : '';
    var caret = focusKey && ae.selectionStart != null ? ae.selectionStart : null;
    S.setupEl.innerHTML = h;
    S.setupEl.scrollTop = y;
    if (focusKey) { var f = S.setupEl.querySelector('[data-f="' + focusKey + '"]'); if (f) { f.focus(); try { if (caret != null) f.setSelectionRange(caret, caret); } catch (x) {} } }
  }
  function addBtn(pid) {
    var P = S.C.PROVIDERS[pid], have = S.svc.endpoint(pid);
    return '<button type="button" class="ai-addbtn' + (have && pid !== 'custom' ? ' have' : '') + '" data-add="' + pid + '"' + (have && pid !== 'custom' ? ' disabled' : '') + ' title="' + esc(P.sub) + '">' +
      (P.where === 'cloud' ? '☁ ' : '') + esc(P.label) + (have && pid !== 'custom' ? ' ✓' : '') + '</button>';
  }
  function epCardHtml(x) {
    var W = S.wiz, C = S.C, P = C.providerOf(x.provider), t = W.tests[x.id] || {}, open = W.open === x.id, st;
    if (t.phase === 'test') st = '<span class="ai-busytxt"><span class="ai-spin"></span>Connecting…</span>';
    else if (t.err) st = '<span class="ai-warnc">⚠ ' + esc(t.err.info ? t.err.info.title : t.err.message) + '</span>';
    else if (t.res) st = '<span class="ai-ok">✓</span> ' + t.res.models.length + (t.res.models.length === 1 ? ' model' : ' models') + ' · ' + esc(C.fmtMs(t.res.ms));
    else if (P.key === 'required' && !x.apiKey) st = '<span class="ai-faint">Needs an API key</span>';
    else st = '<span class="ai-faint">Not tested yet</span>';
    var h = '<div class="ai-ep' + (open ? ' open' : '') + (x.on ? '' : ' off') + '" data-ep="' + esc(x.id) + '">' +
      '<div class="ai-ep-h"><button type="button" class="ai-ep-t" data-act="ep-open" data-ep="' + esc(x.id) + '" aria-expanded="' + open + '">' +
      '<span class="ai-ep-ic" aria-hidden="true">' + (x.where === 'cloud' ? '☁' : '💻') + '</span><span class="ai-ep-tt"><b>' + esc(x.label) + '</b><small>' + st + '</small></span></button>' +
      '<label class="ai-mini" title="' + (x.on ? 'In use — switch off to keep it but not use it' : 'Not in use') + '"><input type="checkbox" class="ai-ep-on" data-ep="' + esc(x.id) + '"' + (x.on ? ' checked' : '') + ' aria-label="Use ' + esc(x.label) + '"><span class="ai-switch-ui" aria-hidden="true"></span></label></div>';
    if (open) {
      h += '<div class="ai-ep-b">' +
        '<label class="ai-field"><span>Address</span><input class="ai-ep-url" data-f="url-' + esc(x.id) + '" data-ep="' + esc(x.id) + '" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="' + esc(P.url) + '" value="' + esc(x.url || P.url) + '"></label>';
      if (P.key !== 'none') h += '<label class="ai-field"><span>API key' + (P.key === 'optional' ? ' <small>if the server wants one</small>' : '') + '</span><input class="ai-ep-key" data-f="key-' + esc(x.id) + '" data-ep="' + esc(x.id) + '" type="password" autocomplete="off" spellcheck="false" value="' + esc(x.apiKey) + '" placeholder="' + esc(P.keyHint || (P.key === 'required' ? 'Paste your key' : 'Optional')) + '"></label>' +
        '<p class="ai-keynote">' + I.lock + ' Stays on this device only — never synced, never sent to your other devices.' + (P.keyUrl ? ' <a class="ai-ext" href="' + esc(P.keyUrl) + '" target="_blank" rel="noopener noreferrer">Get a key at ' + esc(C.hostOf(P.keyUrl)) + ' ↗</a>' : '') + '</p>';
      h += '<div class="ai-btns"><button type="button" class="ai-btn ai-pri" data-act="ep-test" data-ep="' + esc(x.id) + '"' + (t.phase === 'test' ? ' disabled' : '') + '>Test connection</button>' +
        '<button type="button" class="ai-btn" data-act="ep-remove" data-ep="' + esc(x.id) + '">Remove</button></div>' +
        '<div class="ai-result">' + epResultHtml(x, t) + '</div></div>';
    }
    return h + '</div>';
  }
  function epResultHtml(x, t) {
    var C = S.C, h = '';
    if (t.phase === 'test') return '<div class="ai-busyline"><span class="ai-spin"></span>Connecting…</div>' + (x.where === 'local' ? lnaHint() : '');
    if (t.err) return fixHtml(t.err.info || C.explain('server', {}), { again: x.id });
    if (t.res) {
      var r = t.res, n = r.models.length;
      h += '<p class="ai-good">✓ Connected to ' + esc(x.label) + ' in ' + esc(C.fmtMs(r.ms)) + ' — ' + n + (n === 1 ? ' model' : ' models') + '</p>';
      if (!r.model) h += '<p class="ai-faint">No models yet.' + (x.provider === 'ollama' ? ' Download one:' : '') + '</p>' + (x.provider === 'ollama' ? stepsHtml([{ cmd: 'ollama pull llama3.2' }]) : '');
      else if (t.phase === 'gen') h += '<div class="ai-busyline"><span class="ai-spin"></span>Asking ' + esc(r.model) + ' for a one-word reply…' + (x.where === 'local' ? ' (the first answer loads the model — up to a minute)' : '') + '</div>';
      else if (r.genError) h += fixHtml(r.genError.info, { again: x.id });
      else if (r.reply) h += '<p class="ai-good">✓ ' + esc(r.model) + ' answered “' + esc(r.reply) + '” in ' + esc(C.fmtMs(r.genMs)) + '</p>';
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
    if (W.htest.ok) return '<p class="ai-good">✓ ' + esc(W.htest.host) + ' answered “' + esc(W.htest.reply) + '” with ' + esc(W.htest.model || 'its model') + (W.htest.provider ? ' (' + esc(W.htest.provider) + ')' : '') + ' in ' + esc(C.fmtMs(W.htest.ms)) + '</p>';
    return fixHtml(W.htest.error.info || C.explain('server', {}), {});
  }
  function wizAbort() {
    var W = S.wiz;
    if (W.abort) { try { W.abort.abort(); } catch (e) {} }
    W.abort = new AbortController();
    return W.abort.signal;
  }
  // Test one endpoint (models, and unless quick a one-word answer).
  function epTest(id, quick) {
    var W = S.wiz, x = S.svc.endpoint(id);
    if (!x) return;
    var gen = ++W.gen, t = W.tests[id] = { phase: 'test' }, raw = (S.svc.local().endpoints || []).filter(function (e) { return e.id === id; })[0];
    renderSetup();
    S.svc.testEndpoint(raw, function (stage, res) {
      if (!S || !S.wiz || W.tests[id] !== t) return;
      if (stage === 'models') { t.res = res; t.phase = res.model && !quick ? 'gen' : ''; renderSetup(); }
    }, quick ? null : wizAbort(), quick).then(function (res) {
      if (!S || !S.wiz || W.tests[id] !== t) return;
      t.res = res; t.phase = ''; t.err = null;
      renderSetup();
    }, function (e) {
      if (!S || !S.wiz || W.tests[id] !== t) return;
      t.phase = ''; t.res = null; t.err = e;
      renderSetup();
    });
    return gen;
  }
  function readEpFields(id) {
    var u = S.setupEl.querySelector('.ai-ep-url[data-ep="' + id + '"]'), k = S.setupEl.querySelector('.ai-ep-key[data-ep="' + id + '"]');
    var x = S.svc.endpoint(id);
    if (!x) return;
    var P = S.C.providerOf(x.provider), patch = { id: id };
    if (u) { var v = u.value.trim(); patch.url = v && S.C.normBase(P.kind, v) !== S.C.normBase(P.kind, P.url) ? v : ''; }
    if (k) patch.key = k.value.trim();
    if ((u && patch.url !== x.url) || (k && patch.key !== x.apiKey)) { S.svc.saveEndpoint(patch); delete S.wiz.tests[id]; }
  }
  function addEndpoint(pid, base) {
    var svc = S.svc, C = S.C, id = svc.newEndpointId(pid), P = C.providerOf(pid);
    var url = base && C.normBase(P.kind, base) !== C.normBase(P.kind, P.url) ? base : '';
    svc.saveEndpoint({ id: id, p: pid, url: url, on: true });
    S.wiz.open = id;
    if (P.key !== 'required') epTest(id); else renderSetup();
    setTimeout(function () { if (!S) return; var k = S.setupEl.querySelector('.ai-ep-key[data-ep="' + id + '"]'); if (k && !coarse()) k.focus(); var c = S.setupEl.querySelector('.ai-ep[data-ep="' + id + '"]'); if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest' }); }, 30);
  }
  function wizDetect() {
    var W = S.wiz, svc = S.svc;
    W.detecting = true;
    renderSetup();
    svc.detect().then(function (d) {
      if (!S || S.wiz !== W) return;
      W.detecting = false; W.det = d;
      var have = svc.endpoints(true);
      d.list.forEach(function (r) {
        var P = S.C.providerOf(r.provider);
        var dup = have.some(function (x) { return x.provider === r.provider && x.base === S.C.normBase(P.kind, r.base); });
        if (dup) return;
        var id = svc.newEndpointId(r.provider);
        if (r.provider !== 'custom' && svc.endpoint(id)) return;
        svc.saveEndpoint({ id: id, p: r.provider, url: S.C.normBase(P.kind, r.base) !== S.C.normBase(P.kind, P.url) ? r.base : '', on: true });
        if (r.state === 'blocked') W.tests[id] = { err: svc.decorate(S.C.AiError('cors', 'blocked'), { base: r.base, provider: r.provider }) };
        else if (r.state === 'auth') W.tests[id] = { err: svc.decorate(S.C.AiError('auth', 'key'), { provider: r.provider }) };
        if (!W.open) W.open = id;
      });
      svc.endpoints(true).forEach(function (x) { if (!W.tests[x.id]) epTest(x.id, true); });
      renderSetup();
    });
  }
  function enterStep2() {
    var W = S.wiz, eps = S.svc.endpoints(true);
    if (W.where !== 'local') return;
    if (!eps.length) wizDetect();
    else eps.forEach(function (x) { if (x.on && !W.tests[x.id] && !(S.C.providerOf(x.provider).key === 'required' && !x.apiKey)) epTest(x.id, true); });
  }
  function wizHostTest() {
    var W = S.wiz, h = S.C.pickHost(S.hosts || [], W.host), g = ++W.gen;
    if (!h) return;
    var signal = wizAbort();
    W.phase = 'htest'; W.htest = null;
    renderSetup();
    S.svc.testHost(h, signal).then(function (r) {
      if (!S || !S.wiz || S.wiz.gen !== g) return;
      r.host = h.name;
      W.phase = ''; W.htest = r;
      renderSetup();
    });
  }
  function wizGo(step) {
    var W = S.wiz;
    if (W.phase === 'htest') wizAbort();
    W.step = step;
    W.gen++;
    W.phase = '';
    renderSetup();
    S.setupEl.scrollTop = 0;
    if (step === 2) enterStep2();
  }
  function wizFinish() {
    var W = S.wiz, svc = S.svc, P = svc.P;
    var wasLocal = svc.local().role === 'local';
    P.set('model', W.model || '');
    if (W.where === 'local') {
      P.set('policy', W.policy === 'ask' ? 'ask' : 'auto');
      P.set('shareCloud', !!W.shareCloud);
      svc.setLocal({ role: 'local', host: null, setupAt: Date.now() });
      svc.setShare(!!(W.share && svc.synced()));
    } else {
      if (wasLocal) svc.setShare(false);
      svc.setLocal({ role: 'remote', host: W.host || null, setupAt: Date.now() });
    }
    toast(W.where === 'local' && W.share && svc.synced() ? 'AI is ready — and shared with your devices' : 'AI is ready', 'success', 2200);
    S.route = null;
    showChat();
  }
  function turnOff() {
    var svc = S.svc;
    if (svc.local().role === 'local') svc.setShare(false);
    svc.setLocal({ role: null, host: null, endpoints: null, shareSeen: null });
    S.route = null;
    showSetup(1, true);
    toast('AI is off on this device — its services and keys are removed', 'info', 2400);
  }

  // ---- events ---------------------------------------------------------------------------------------
  function onClick(e) {
    if (!S) return;
    var t = e.target.closest('[data-act],[data-ctx],[data-action],[data-where],[data-pol],[data-os],[data-copy],[data-add],[data-pk]');
    if (!t || !S.panel.contains(t)) return;
    var W = S.wiz, a = t.dataset.act;
    if (t.dataset.copy != null) { copyText(S.copies[+t.dataset.copy] || ''); return; }
    if (t.dataset.pk != null && S.pk) { pickerChoose(t.dataset.pk); return; }
    if (t.dataset.os) { S.fixOs = t.dataset.os; if (S.view === 'setup') renderSetup(); else renderLog(); return; }
    if (t.dataset.ctx && t.tagName !== 'LABEL') {
      var c = t.dataset.ctx;
      if (c === 'sel' && !selection()) { toast('Select some text in the note first', 'info', 1800); return; }
      S.ctx = c; paintCtx(); return;
    }
    if (t.dataset.action) { action(t.dataset.action); return; }
    if (t.dataset.where) { W.where = t.dataset.where; W.htest = null; wizGo(2); return; }
    if (t.dataset.add) { addEndpoint(t.dataset.add); return; }
    if (t.dataset.pol) { W.policy = t.dataset.pol; renderSetup(); return; }
    switch (a) {
      case 'send': send(S.input.value); break;
      case 'stop': if (S.busy) S.busy.ctl.abort(); break;
      case 'clear':
        if (S.busy) return;
        S.msgs = []; renderLog();
        if (Cade.idbStore) Cade.idbStore.remove(CHAT_KEY + S.room).catch(function () {});
        break;
      case 'picker':
        if (S.view === 'setup') return;
        if (S.route && !S.route.available && !S.svc.local().role) showSetup(1, true);
        else openPicker('chat');
        break;
      case 'pk-close': closePicker(); break;
      case 'pk-freset': if (S.pk) { S.pk.f = S.C.normFilters({}); savePkFilters(S.pk.f); renderPicker(); } break;
      case 'codecopy': {
        var pre = t.closest('.ai-code') && t.closest('.ai-code').querySelector('pre'), lbl = t.querySelector('span');
        if (!pre) break;
        copyText(pre.textContent.replace(/\n$/, ''));
        if (lbl) { lbl.textContent = 'Copied'; t.classList.add('ai-done'); setTimeout(function () { if (lbl.isConnected) { lbl.textContent = 'Copy'; t.classList.remove('ai-done'); } }, 1400); }
        break;
      }
      case 'jump': S.log.scrollTo({ top: S.log.scrollHeight, behavior: 'smooth' }); break;
      case 'hub': openHub(); break;
      case 'hub-close': closeHub(); break;
      case 'hub-open': hubOpen(t.dataset.room); break;
      case 'hub-del': hubDelete(t); break;
      case 'pk-save': {
        var pk = S.pk;
        S.svc.saveEndpoint({ id: pk.opts.ep, allow: pk.sel ? pk.sel.slice() : [] });
        closePicker();
        renderSetup();
        break;
      }
      case 'pk-default': {
        var r = S.route;
        if (r && r.available) { S.svc.P.set('model', r.group.ep + ':' + r.model.id); toast('New notes start with ' + (r.model.name || r.model.id), 'success', 1800); renderPicker(); }
        break;
      }
      case 'insert': insertAnswer(+t.dataset.i); break;
      case 'replace': replaceAnswer(+t.dataset.i); break;
      case 'copy': copyText(answerText(+t.dataset.i)); break;
      case 'newnote': newNote(+t.dataset.i); break;
      case 'retry': retry(+t.dataset.i); break;
      case 'setup2': closePicker(); showSetup(S.svc.local().role ? 2 : 1, !S.svc.local().role); break;
      case 'prefs': if (Cade.prefs && Cade.prefs.open) { try { Cade.prefs.open(ID); } catch (x) {} } break;
      case 'w-cancel': showChat(); break;
      case 'w-off': turnOff(); break;
      case 'w-back': wizGo(W.step - 1); break;
      case 'w-next': if (!t.disabled) wizGo(W.step + 1); break;
      case 'w-detect': wizDetect(); break;
      case 'w-htest': wizHostTest(); break;
      case 'w-done': wizFinish(); break;
      case 'w-model': openPicker('default', { where: W.where }); break;
      case 'w-allow': openPicker('allow', { ep: t.dataset.ep }); break;
      case 'ep-open': W.open = W.open === t.dataset.ep ? '' : t.dataset.ep; renderSetup(); break;
      case 'ep-test': if (S.view === 'setup') { readEpFields(t.dataset.ep); epTest(t.dataset.ep); } break;
      case 'ep-remove': S.svc.removeEndpoint(t.dataset.ep); delete W.tests[t.dataset.ep]; if (W.open === t.dataset.ep) W.open = ''; renderSetup(); break;
    }
  }
  function onChange(e) {
    if (!S) return;
    var t = e.target;
    if (t.classList.contains('ai-pk-f') && S.pk) {
      var nf = Object.assign({}, S.pk.f); nf[t.dataset.f] = t.value;
      S.pk.f = S.C.normFilters(nf); savePkFilters(S.pk.f); renderPicker(); return;
    }
    if (t.classList.contains('ai-room-sel')) { S.ctxRoom = t.value; S.ctx = t.value ? 'room' : 'auto'; paintCtx(); return; }
    if (t.classList.contains('ai-lang')) {
      var lang = t.value;
      t.selectedIndex = 0;
      if (lang === '?') { lang = (window.prompt('Translate into which language?') || '').trim().slice(0, 40); if (!lang) return; }
      if (lang) action('translate', lang);
      return;
    }
    if (t.classList.contains('ai-pk-allcb')) { S.pk.sel = t.checked ? null : []; renderPicker(); return; }
    if (t.classList.contains('ai-share-cb')) { S.wiz.share = t.checked; renderSetup(); return; }
    if (t.classList.contains('ai-sharecloud-cb')) { S.wiz.shareCloud = t.checked; renderSetup(); return; }
    if (t.classList.contains('ai-ep-on')) { S.svc.saveEndpoint({ id: t.dataset.ep, on: t.checked }); if (t.checked) epTest(t.dataset.ep, true); else renderSetup(); return; }
    if (t.name === 'ai-host') { S.wiz.host = t.value; S.wiz.htest = null; renderSetup(); return; }
    if (t.classList.contains('ai-ep-url') || t.classList.contains('ai-ep-key')) { readEpFields(t.dataset.ep); }
  }
  function onInput(e) {
    if (!S) return;
    var t = e.target;
    if (t === S.input) grow();
    else if (t.classList.contains('ai-pk-q') && S.pk) {
      S.pk.q = t.value;
      clearTimeout(S.pkT);
      S.pkT = setTimeout(function () { if (S && S.pk) renderPicker(); }, 120);
    } else if (t.classList.contains('ai-hub-q') && S.hub) {
      S.hub.q = t.value;
      clearTimeout(S.pkT);
      S.pkT = setTimeout(function () { if (S && S.hub) renderHub(); }, 120);
    }
  }
  function onKey(e) {
    if (!S) return;
    if (e.key === 'Escape' && S.pk) { e.preventDefault(); e.stopPropagation(); closePicker(); return; }
    if (e.key === 'Escape' && S.hub) { e.preventDefault(); e.stopPropagation(); closeHub(); return; }
    if (e.key === 'Escape' && S.busy) { e.preventDefault(); e.stopPropagation(); S.busy.ctl.abort(); return; }
    if (e.target === S.input && e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse()) { e.preventDefault(); send(S.input.value); return; }
    if (S.wiz && e.key === 'Enter' && e.target.classList && (e.target.classList.contains('ai-ep-url') || e.target.classList.contains('ai-ep-key'))) {
      e.preventDefault(); readEpFields(e.target.dataset.ep); epTest(e.target.dataset.ep);
    }
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
      var p = S.svc.notePick(room);
      if (p !== S.pick) { S.pick = p; S.route = null; refreshRoute(); }
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
