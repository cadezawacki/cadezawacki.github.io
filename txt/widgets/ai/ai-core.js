/* AI — the pure part: everything that doesn't touch the page, so node can
 * test it (node txt/widgets/ai/ai.test.js). UMD: module.exports in node,
 * window.__cadeAiCore in the browser.
 *
 *   PREFS      the Widget preferences schema (same as the manifest "prefs").
 *   servers    presets (Ollama native API, LM Studio and other OpenAI-
 *              compatible servers), address normalising, auto-detect ports.
 *   adapters   request building, model lists, one streamed chunk → {text,
 *              thinking, done, reason, usage, error} for both APIs.
 *   streams    NDJSON (Ollama) and SSE (OpenAI) parsers that take text in
 *              arbitrary pieces — a line or event split across network chunks
 *              is reassembled.
 *   engine     listModels / chatStream / probe over an injected fetch, with
 *              an inactivity timeout and abort; errors are AiError {code}.
 *   errors     classify an HTTP status + body or a network failure into a
 *              code (unreachable, cors, mixed, lna, model, context, auth, …)
 *              and explain(code, env) → a title and fix steps for THIS
 *              OS / browser (with commands to copy).
 *   context    token-ish estimates, trimming a long note to the model's
 *              window, assembling system + history + the new question.
 *   relay      the protocol between a device that runs the model (the host)
 *              and the account's other devices, over Cade.cloud (sealed with
 *              the Sync key). createRelayHost / createRelayClient take the
 *              cloud as an injected interface, so the whole exchange runs in
 *              node against an in-memory fake.
 *   markdown   a small, safe Markdown → HTML for answers when the app's
 *              marked isn't loaded (the widget sanitises either way).
 *
 * Relay layout (Cade.cloud kind "ai", i.e. rooms/__cade_ai_<keyFp>/…):
 *   hosts/<inst>               {s: sealed presence, at}   a device sharing its model
 *   req/<hostInst>/<id>        {f, s: sealed request, at} a question; the host removes it on pickup
 *   res/<clientInst>/<id>/<m…> {s: sealed message, at}   the answer in pieces; the asker removes it when done
 *   ctl/<hostInst>/<id>        {f, s: sealed {t:'x'}}     cancel; the host removes it
 * Host → client messages (sealed): {v, id, q (1, 2, 3… in order), t, …}
 *   a accepted {pos: 0 = running now, n = waiting}   w waiting for the host's OK
 *   s started {model}   k thinking   h still working   d text {x}
 *   z done {reason, usage, ms}   e error {code, msg}
 * The asker reorders by q (unsealing is async, so pieces can resolve out of
 * order) and ignores duplicates. */
(function (root) {
  'use strict';

  // ---- preferences (Widget preferences page "AI"; identical to the manifest) -------------------
  var PREFS = [
    { type: 'heading', label: 'Model server' },
    { key: 'provider', type: 'select', label: 'Server type', default: 'ollama',
      hint: 'Used on a device you set up with “This computer”. Your other devices reach it through Sync',
      options: [{ value: 'ollama', label: 'Ollama' }, { value: 'lmstudio', label: 'LM Studio' }, { value: 'openai', label: 'Other (OpenAI-compatible)' }] },
    { key: 'endpoint', type: 'text', label: 'Server address', default: '', maxLength: 300, placeholder: 'Automatic',
      hint: 'Empty = the usual address (Ollama http://127.0.0.1:11434, LM Studio http://127.0.0.1:1234/v1)' },
    { key: 'model', type: 'text', label: 'Default model', default: '', maxLength: 200, placeholder: 'First available',
      hint: 'A model name such as llama3.2 or qwen2.5:7b — the AI panel lists what is installed' },
    { type: 'heading', label: 'Answers' },
    { key: 'temperature', type: 'slider', label: 'Creativity (temperature)', default: 0.7, min: 0, max: 2, step: 0.1,
      hint: 'Lower is focused and repeatable, higher is more varied' },
    { key: 'maxTokens', type: 'number', label: 'Longest answer', default: 1024, min: 32, max: 16384, step: 32, unit: 'tokens' },
    { key: 'contextWindow', type: 'number', label: 'Context window', default: 0, min: 0, max: 262144, step: 1024, unit: 'tokens',
      hint: 'How much text the model reads at once. 0 = the server’s own setting (counted as 4096 when fitting a note in). Bigger needs more memory' },
    { key: 'system', type: 'textarea', label: 'System prompt', maxLength: 4000,
      default: 'You are a helpful writing assistant inside a notes app. Be concise and clear. Use Markdown when it helps.' },
    { key: 'history', type: 'toggle', label: 'Keep the conversation for each note', default: true,
      hint: 'Saved on this device only; Clear in the panel removes it' },
    { key: 'timeout', type: 'number', label: 'Give up after', default: 120, min: 15, max: 900, step: 5, unit: 's',
      hint: 'With no answer coming in. The first answer can take a while as the model loads' },
    { type: 'heading', label: 'Sharing' },
    { key: 'share', type: 'toggle', label: 'Share with my other devices', default: false,
      hint: 'This device answers the AI on your other devices, end-to-end encrypted with your Sync key. Same switch as Preferences → Devices → “Share my AI model with my other devices”' },
    { key: 'policy', type: 'radio', label: 'When another device asks', default: 'auto', showIf: 'share',
      options: [{ value: 'auto', label: 'Answer automatically' }, { value: 'ask', label: 'Ask me each time' }] }
  ];
  var PREF_DEFAULTS = {};
  PREFS.forEach(function (f) { if (f.key) PREF_DEFAULTS[f.key] = f.default; });

  // ---- servers ---------------------------------------------------------------------------------
  // kind = the API spoken: 'ollama' (native /api/*) or 'openai' (/v1/*).
  var PRESETS = {
    ollama: { id: 'ollama', label: 'Ollama', kind: 'ollama', url: 'http://127.0.0.1:11434' },
    lmstudio: { id: 'lmstudio', label: 'LM Studio', kind: 'openai', url: 'http://127.0.0.1:1234/v1' },
    openai: { id: 'openai', label: 'Other (OpenAI-compatible)', kind: 'openai', url: 'http://127.0.0.1:8080/v1' }
  };
  // Where "Find it automatically" looks (all on this computer).
  var DETECT = [
    { provider: 'ollama', name: 'Ollama', base: 'http://127.0.0.1:11434' },
    { provider: 'lmstudio', name: 'LM Studio', base: 'http://127.0.0.1:1234/v1' },
    { provider: 'openai', name: 'llama.cpp / LocalAI', base: 'http://127.0.0.1:8080/v1' },
    { provider: 'openai', name: 'Jan', base: 'http://127.0.0.1:1337/v1' },
    { provider: 'openai', name: 'vLLM', base: 'http://127.0.0.1:8000/v1' },
    { provider: 'openai', name: 'KoboldCpp', base: 'http://127.0.0.1:5001/v1' }
  ];
  function presetOf(p) { return PRESETS[p] || PRESETS.ollama; }
  function kindOf(p) { return presetOf(p).kind; }

  // The API base for a typed address: scheme added, trailing slashes and API
  // paths dropped; OpenAI-compatible bases end in /v1 (added to a bare host).
  function normBase(kind, url) {
    var s = String(url == null ? '' : url).trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
    var m = /^([a-z][a-z0-9+.-]*:\/\/[^\/?#]+)([^?#]*)/i.exec(s);
    if (!m) return s;
    var origin = m[1], path = m[2].replace(/\/+$/, '');
    if (kind === 'ollama') {
      path = path.replace(/\/(api|v1)(\/.*)?$/, '');
      return origin + path;
    }
    path = path.replace(/\/(chat\/completions|completions|models|responses|embeddings)$/, '');
    if (!path) path = '/v1';
    return origin + path;
  }
  function hostOf(url) {
    var m = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^\/:?#]+)/i.exec(String(url || ''));
    return m ? m[1].toLowerCase() : '';
  }
  // 'loopback' (this computer), 'local' (a private LAN address) or 'public'.
  function addressSpace(url) {
    var h = hostOf(url).replace(/^\[|\]$/g, '');
    if (!h) return 'public';
    if (h === 'localhost' || /\.localhost$/.test(h) || /^127\./.test(h) || h === '::1' || h === '0.0.0.0') return 'loopback';
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) ||
      /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) || /\.local$/.test(h)) return 'local';
    return 'public';
  }
  function isHttp(url) { return /^http:\/\//i.test(String(url || '')); }

  // ---- adapters --------------------------------------------------------------------------------
  function headers(o, json) {
    var h = {};
    if (json) h['Content-Type'] = 'application/json';
    if (o && o.apiKey) h.Authorization = 'Bearer ' + o.apiKey;
    return h;
  }
  function modelsUrl(kind, base) { return base + (kind === 'ollama' ? '/api/tags' : '/models'); }
  // A streamed chat request → { url, init }.
  // o: { kind, base, apiKey, model, messages, temperature, maxTokens, numCtx, stream }
  function buildChat(o) {
    var stream = o.stream !== false, body;
    var msgs = (o.messages || []).map(function (m) { return { role: m.role, content: String(m.content == null ? '' : m.content) }; });
    if (o.kind === 'ollama') {
      var opt = {};
      if (isFinite(o.temperature)) opt.temperature = +o.temperature;
      if (o.maxTokens > 0) opt.num_predict = Math.floor(o.maxTokens);
      if (o.numCtx > 0) opt.num_ctx = Math.floor(o.numCtx);
      body = { model: o.model, messages: msgs, stream: stream, options: opt };
      return { url: o.base + '/api/chat', init: { method: 'POST', headers: headers(o, true), body: JSON.stringify(body) } };
    }
    body = { model: o.model, messages: msgs, stream: stream };
    if (isFinite(o.temperature)) body.temperature = +o.temperature;
    if (o.maxTokens > 0) body.max_tokens = Math.floor(o.maxTokens);
    return { url: o.base + '/chat/completions', init: { method: 'POST', headers: headers(o, true), body: JSON.stringify(body) } };
  }
  var EMBED_RE = /embed|bge-|e5-|minilm|rerank/i;
  // Server model list JSON → [{ name, size, family, params, quant, embed }], chat models first.
  function parseModels(kind, j) {
    var out = [];
    if (kind === 'ollama') {
      (j && Array.isArray(j.models) ? j.models : []).forEach(function (m) {
        if (!m) return;
        var name = String(m.name || m.model || '');
        if (!name) return;
        var d = m.details || {};
        var fam = String(d.family || '');
        out.push({ name: name, size: +m.size || 0, family: fam, params: String(d.parameter_size || ''), quant: String(d.quantization_level || ''),
          embed: EMBED_RE.test(name) || /bert/i.test(fam) });
      });
    } else {
      (j && Array.isArray(j.data) ? j.data : (j && Array.isArray(j.models) ? j.models : [])).forEach(function (m) {
        var name = m && String(m.id || m.name || '');
        if (!name) return;
        out.push({ name: name, size: 0, family: '', params: '', quant: '', embed: EMBED_RE.test(name) || m.type === 'embeddings' });
      });
    }
    var seen = {};
    out = out.filter(function (m) { if (seen[m.name]) return false; seen[m.name] = 1; return true; });
    out.sort(function (a, b) { return (a.embed ? 1 : 0) - (b.embed ? 1 : 0); });
    return out;
  }
  function chatModels(list) { return (list || []).filter(function (m) { return !m.embed; }); }
  // The model to use: the wanted one when the server has it (or the list is
  // unknown), else the first chat model.
  function pickModel(want, list) {
    var names = chatModels(list).map(function (m) { return m.name; });
    want = String(want || '').trim();
    if (want && (!list || !list.length)) return want;
    if (want) {
      if (names.indexOf(want) >= 0) return want;
      if (names.indexOf(want + ':latest') >= 0) return want + ':latest';
    }
    return names[0] || want || '';
  }
  // One parsed stream object → what it carries.
  function readChunk(kind, o) {
    var r = { text: '', thinking: '', done: false, reason: '', usage: null, error: '' };
    if (!o || typeof o !== 'object') return r;
    if (o.error) { r.error = typeof o.error === 'string' ? o.error : String(o.error.message || o.error.type || JSON.stringify(o.error)); return r; }
    if (kind === 'ollama') {
      if (o.message) { r.text = String(o.message.content || ''); r.thinking = String(o.message.thinking || ''); }
      else if (typeof o.response === 'string') r.text = o.response;   // /api/generate
      if (o.done) {
        r.done = true;
        r.reason = String(o.done_reason || 'stop');
        if (o.eval_count != null || o.prompt_eval_count != null) r.usage = { prompt: +o.prompt_eval_count || 0, output: +o.eval_count || 0 };
      }
      return r;
    }
    var c = o.choices && o.choices[0];
    if (c) {
      var d = c.delta || c.message || {};
      r.text = String(d.content || (typeof c.text === 'string' ? c.text : '') || '');
      r.thinking = String(d.reasoning_content || d.reasoning || '');
      if (c.finish_reason) { r.done = true; r.reason = String(c.finish_reason); }
    }
    if (o.usage) r.usage = { prompt: +o.usage.prompt_tokens || 0, output: +o.usage.completion_tokens || 0 };
    return r;
  }

  // ---- stream parsers (pieces in, whole lines / events out) ------------------------------------
  function ndjsonParser(onObj, onBad) {
    var buf = '';
    function line(l) {
      l = l.trim();
      if (!l) return;
      var o;
      try { o = JSON.parse(l); } catch (e) { if (onBad) onBad(l); return; }
      onObj(o);
    }
    return {
      push: function (s) {
        buf += s;
        var start = 0, i;
        while ((i = buf.indexOf('\n', start)) >= 0) { line(buf.slice(start, i)); start = i + 1; }
        buf = buf.slice(start);
      },
      end: function () { var l = buf; buf = ''; line(l); }
    };
  }
  // Server-sent events: data lines (joined by \n) up to a blank line; ':'
  // comments ignored; \n, \r\n or \r line ends, even split across pieces.
  function sseParser(onEvent) {
    var buf = '', data = [], ev = '';
    function dispatch() {
      if (data.length) onEvent({ event: ev || 'message', data: data.join('\n') });
      data = []; ev = '';
    }
    function line(l) {
      if (l === '') { dispatch(); return; }
      if (l.charAt(0) === ':') return;
      var i = l.indexOf(':'), f = i < 0 ? l : l.slice(0, i), v = i < 0 ? '' : l.slice(i + 1);
      if (v.charAt(0) === ' ') v = v.slice(1);
      if (f === 'data') data.push(v);
      else if (f === 'event') ev = v;
    }
    return {
      push: function (s) {
        buf += s;
        var start = 0, n = buf.length;
        for (var i = 0; i < n; i++) {
          var c = buf.charCodeAt(i);
          if (c !== 10 && c !== 13) continue;
          if (c === 13 && i === n - 1) break;        // maybe the \r of a \r\n split in two
          line(buf.slice(start, i));
          if (c === 13 && buf.charCodeAt(i + 1) === 10) i++;
          start = i + 1;
        }
        buf = buf.slice(start);
      },
      end: function () { if (buf) { line(buf.replace(/\r$/, '')); buf = ''; } dispatch(); }
    };
  }

  // ---- errors ----------------------------------------------------------------------------------
  function AiError(code, message, extra) {
    var e = new Error(message || code);
    e.name = 'AiError';
    e.code = code;
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }
  // The server's own words for an error body.
  function errorMessage(body) {
    var s = String(body == null ? '' : body).trim();
    if (!s) return '';
    try {
      var j = JSON.parse(s);
      if (j && typeof j === 'object') {
        if (Array.isArray(j.detail) && j.detail[0]) return String(j.detail[0].msg || JSON.stringify(j.detail[0]));
        var e = j.error != null ? j.error : (j.detail != null ? j.detail : j.message);
        if (typeof e === 'string') return e;
        if (e && typeof e === 'object') return String(e.message || e.msg || e.type || JSON.stringify(e));
      }
    } catch (x) {}
    return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  var CONTEXT_RE = /context (length|window|size)|too many tokens|exceeds? (the )?(available |maximum )?(context|token)|maximum context|n_ctx|prompt is too long|input (is )?too long|input length/i;
  var MODEL_RE = /model\b[^.]*\b(not found|does ?n[o']t exist|not (be )?loaded|unloaded|unknown|missing|try pulling|not available)|no models? (is |are )?loaded|unknown model|pull (it|the model)|model_not_found|failed to load model/i;
  function classifyHttp(status, body) {
    var msg = errorMessage(body);
    if (CONTEXT_RE.test(msg)) return { code: 'context', detail: msg };
    if (status === 401 || status === 403) return { code: 'auth', detail: msg };
    if (MODEL_RE.test(msg)) return { code: 'model', detail: msg };
    if (status === 404) return { code: 'notfound', detail: msg };
    if (status === 429 || (status === 503 && /busy|overload|queue/i.test(msg))) return { code: 'busy', detail: msg };
    if (status === 400 && /\bmodel\b/i.test(msg)) return { code: 'model', detail: msg };
    return { code: 'server', detail: msg || ('HTTP ' + status) };
  }
  // A fetch that failed before any answer (TypeError) → what most likely happened.
  // probe: 'blocked' (a no-cors request got through: the server is there but
  // its CORS doesn't allow this page) or 'down'. env: { mixedBlocked, lna }.
  function refineNetwork(probe, env) {
    env = env || {};
    if (env.mixedBlocked) return 'mixed';
    if (env.lna === 'denied') return 'lna';
    if (probe === 'blocked') return 'cors';
    return 'unreachable';
  }
  function isAbort(e) { return !!e && (e.name === 'AbortError' || e.code === 20 || e.code === 'aborted'); }

  // ---- fix texts ---------------------------------------------------------------------------------
  // env: { provider, origin, os ('mac'|'win'|'linux'|'ios'|'android'|'other'),
  // browser ('safari'|'chrome'|'edge'|'firefox'|'other'), base, model, host, timeoutS, detail }
  // → { code, title, text, steps: [{t} | {cmd, label}], os: {mac,win,linux}: steps, osPick }
  function T(t) { return { t: t }; }
  function CMD(c, label) { return { cmd: c, label: label || '' }; }
  function ollamaCors(origin) {
    var plist = "mkdir -p ~/Library/LaunchAgents && printf '<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n<plist version=\"1.0\"><dict>" +
      "<key>Label</key><string>txt.ollama-origins</string><key>ProgramArguments</key><array><string>/bin/launchctl</string>" +
      "<string>setenv</string><string>OLLAMA_ORIGINS</string><string>" + origin + "</string></array>" +
      "<key>RunAtLoad</key><true/></dict></plist>\\n' > ~/Library/LaunchAgents/txt.ollama-origins.plist";
    return {
      mac: [T('In Terminal, run:'), CMD('launchctl setenv OLLAMA_ORIGINS "' + origin + '"'),
        T('Quit Ollama (menu bar llama icon → Quit Ollama) and open it again, then Test again.'),
        T('That lasts until the Mac restarts. To keep it, also run:'), CMD(plist, 'Keep after restarts')],
      win: [T('Quit Ollama: right-click the llama icon by the clock → Quit Ollama.'),
        T('In PowerShell, run:'), CMD('[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "' + origin + '", "User")'),
        T('Start Ollama again from the Start menu, then Test again.')],
      linux: [T('Run (systemd install):'),
        CMD("sudo mkdir -p /etc/systemd/system/ollama.service.d && printf '[Service]\\nEnvironment=\"OLLAMA_ORIGINS=" + origin + "\"\\n' | sudo tee /etc/systemd/system/ollama.service.d/txt-origins.conf && sudo systemctl daemon-reload && sudo systemctl restart ollama"),
        T('Started it yourself with ollama serve? Use this instead:'), CMD('OLLAMA_ORIGINS=' + origin + ' ollama serve')]
    };
  }
  function osPick(os) { return os === 'win' ? 'win' : os === 'linux' ? 'linux' : 'mac'; }
  function explain(code, env) {
    env = env || {};
    var p = env.provider || 'ollama', origin = env.origin || 'https://cadezawacki.github.io';
    var where = env.host ? env.host : 'this computer', model = env.model || 'the model';
    var o = { code: code, title: '', text: '', steps: [] };
    switch (code) {
      case 'cors':
        o.title = (p === 'ollama' ? 'Ollama' : p === 'lmstudio' ? 'LM Studio' : 'The server') + ' is running, but it doesn’t let this page in yet';
        o.text = 'Model servers only answer web pages they’ve been told to trust (CORS). Allow ' + origin + ' once:';
        if (p === 'ollama') { o.os = ollamaCors(origin); o.osPick = osPick(env.os); o.steps = [T('Already set for something else? Separate several origins with commas.')]; }
        else if (p === 'lmstudio') o.steps = [T('In LM Studio open the Developer tab → Server settings → turn on “Enable CORS”. Keep the server Running, then Test again.'), T('Or start it from a terminal:'), CMD('lms server start --cors')];
        else o.steps = [T('Allow the origin ' + origin + ' in your server’s CORS settings, then Test again.'),
          T('llama.cpp (llama-server) and Jan allow every origin by default; vLLM: --allowed-origins \'["' + origin + '"]\'; LocalAI: set CORS=true.')];
        break;
      case 'unreachable':
        o.title = 'Nothing is answering at ' + (env.base || 'that address');
        if (p === 'ollama') o.steps = [T('Is Ollama running? Open the Ollama app, or run:'), CMD('ollama serve'), T('Not installed yet? Get it from ollama.com, then download a model:'), CMD('ollama pull llama3.2')];
        else if (p === 'lmstudio') o.steps = [T('Open LM Studio → Developer tab → switch the server on (Status: Running). It listens on port 1234 unless you changed it; load a model too.')];
        else o.steps = [T('Start your server and check the address and port — OpenAI-compatible servers usually end in /v1 (e.g. http://127.0.0.1:8080/v1).')];
        if (env.base && addressSpace(env.base) === 'public' && isHttp(env.base) && /^https:/.test(origin)) o.steps.push(T('Browsers block plain http:// addresses on the internet from this secure page — use https://, or run the server on this computer.'));
        if (env.browser === 'chrome' || env.browser === 'edge') o.steps.push(T('If the browser asked to let this site reach “apps on this device” or your “local network”, allow it (site settings, left of the address bar).'));
        break;
      case 'mixed':
        o.title = 'Safari can’t reach a model on this computer';
        o.text = 'Safari blocks secure pages from talking to http://localhost (WebKit bug 171934), so it can’t run the model connection here.';
        o.steps = [T('Open txt in Chrome, Edge or Firefox on this computer and set AI up there with “This computer” and “Share with my other devices”.'),
          T('Then choose “Another of my devices” here — Safari on this Mac and on your iPhone use the model through Sync.')];
        break;
      case 'lna':
        o.title = 'Your browser is blocking this page from apps on this computer';
        o.steps = [T(env.browser === 'firefox' ? 'Click the permissions icon in the address bar and allow access to apps on this device.' :
          'Click the site settings icon left of the address bar → allow “Apps on device” (or “Local network access”) for this site.'), T('Then Test again.')];
        break;
      case 'model':
        o.title = 'The model ' + (env.model ? '“' + env.model + '” ' : '') + 'isn’t available on ' + where;
        o.steps = [T('Pick another model, or install this one:')];
        if (p === 'ollama') o.steps.push(CMD('ollama pull ' + (env.model || 'llama3.2')));
        else if (p === 'lmstudio') o.steps.push(T('Load it in LM Studio (or turn on “Just-in-time model loading” in the Developer settings).'));
        else o.steps.push(T('Load it in your server.'));
        break;
      case 'context':
        o.title = 'That’s more text than the model can read at once';
        o.steps = [T('Use a smaller context (a Selection instead of the whole note), or Clear the conversation.'),
          T('Or raise “Context window” in AI preferences — bigger windows need more memory.')];
        break;
      case 'auth':
        o.title = 'The server wants an API key';
        o.steps = [T('Add it in Setup → Connect → Advanced. It stays on this device only.')];
        break;
      case 'notfound':
        o.title = 'The server answered, but not where expected';
        o.steps = [T('Check “Server type” (Ollama or OpenAI-compatible) and the address — OpenAI-compatible addresses usually end in /v1.')];
        break;
      case 'busy':
        o.title = (env.host ? env.host : 'The model') + ' is busy';
        o.steps = [T('Try again in a moment.')];
        break;
      case 'timeout':
        o.title = 'No answer for ' + (env.timeoutS || 120) + ' s';
        o.steps = [T('The model may still be loading (the first answer can take a minute), or ' + where + ' is busy or asleep. Try again, or raise “Give up after” in AI preferences.')];
        break;
      case 'host-offline':
        o.title = 'None of your devices is sharing a model right now';
        o.steps = [T('On the computer with the model: open txt in Chrome, Edge or Firefox → AI → This computer → turn on “Share with my other devices”.'),
          T('Leave that txt tab open (it can be in the background) and keep the computer awake.')];
        break;
      case 'host-silent':
        o.title = where + ' didn’t pick up the question';
        o.steps = [T('Its txt tab may be closed or the computer asleep. Open txt there (and keep the tab open), then try again.')];
        break;
      case 'host-unready':
        o.title = where + ' is sharing, but its model server isn’t answering';
        o.steps = [T('On ' + where + ': is Ollama / LM Studio running? Open AI there to check the connection.')];
        break;
      case 'host-stopped':
        o.title = where + ' stopped sharing';
        o.steps = [T('Sharing was turned off or its txt tab closed.')];
        break;
      case 'denied':
        o.title = where + ' said no';
        o.steps = [T('The question was declined on ' + where + '. Its owner (you) can switch it to “Answer automatically” in AI preferences there.')];
        break;
      case 'nosync':
        o.title = 'Using another device’s model needs Sync';
        o.steps = [T('Set up Sync (the dot in the menu bar) on both devices — questions and answers are end-to-end encrypted with your Sync key.')];
        break;
      case 'not-setup':
        o.title = 'AI isn’t set up on this device';
        o.steps = [T('Open the AI widget to choose where your model runs.')];
        break;
      case 'version':
        o.title = where + ' runs a different version of txt';
        o.steps = [T('Reload txt on both devices.')];
        break;
      case 'too-big':
        o.title = 'That question is too big to send';
        o.steps = [T('Use a smaller context (a Selection instead of the whole note).')];
        break;
      case 'aborted':
        o.title = 'Stopped';
        break;
      default:
        o.title = 'The model server reported a problem';
        o.steps = [T(env.detail ? String(env.detail).slice(0, 300) : 'Try again.')];
    }
    if (!o.text && env.detail && code !== 'server' && code !== 'aborted' && code !== 'timeout') o.text = String(env.detail).slice(0, 240);
    return o;
  }

  // ---- engine ----------------------------------------------------------------------------------
  // fetch with abort + inactivity timeout. Returns { signal, kick(), done(),
  // why() } — why() is 'user' | 'timeout' | '' after an abort.
  function watchdog(userSignal, ms, firstMs) {
    var Ctl = typeof AbortController !== 'undefined' ? AbortController : null;
    var ctl = Ctl ? new Ctl() : null, why = '', t = null, started = false, onAbort;
    function arm(d) { clearTimeout(t); if (d > 0) t = setTimeout(function () { why = 'timeout'; if (ctl) ctl.abort(); }, d); }
    if (userSignal) {
      if (userSignal.aborted) { why = 'user'; if (ctl) ctl.abort(); }
      else userSignal.addEventListener('abort', onAbort = function () { if (!why) why = 'user'; clearTimeout(t); if (ctl) ctl.abort(); });
    }
    arm(firstMs || ms);
    return {
      signal: ctl ? ctl.signal : userSignal,
      kick: function () { started = true; if (!why) arm(ms); },
      done: function () { clearTimeout(t); if (userSignal && onAbort) userSignal.removeEventListener('abort', onAbort); },
      why: function () { return why; },
      started: function () { return started; }
    };
  }
  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function failFrom(e, w, partial) {
    if (e && e.name === 'AiError') return e;
    if (w && w.why() === 'timeout') return AiError('timeout', 'No answer in time', { partial: partial });
    if (isAbort(e) || (w && w.why() === 'user')) return AiError('aborted', 'Stopped', { partial: partial });
    if (e && (e.name === 'TypeError' || /fetch|network|load failed/i.test(String(e.message)))) return AiError('network', String(e.message || 'Network error'), { partial: partial });
    return AiError('server', String((e && e.message) || e), { partial: partial });
  }
  // A request's extra fetch options: LAN addresses need targetAddressSpace in
  // Chromium to pass mixed-content checks (it then asks the user once).
  function netInit(url, init, makeRequest) {
    if (addressSpace(url) === 'local' && makeRequest) {
      try { makeRequest(url, { targetAddressSpace: 'local' }); init.targetAddressSpace = 'local'; } catch (e) {}
    }
    return init;
  }
  // o: { kind, base, apiKey, signal, timeoutMs, Request } → Promise<{ models, ms }>
  function listModels(fetchImpl, o) {
    var w = watchdog(o.signal, o.timeoutMs || 8000), t0 = nowMs(), url = modelsUrl(o.kind, o.base);
    return fetchImpl(url, netInit(url, { method: 'GET', headers: headers(o, false), signal: w.signal }, o.Request)).then(function (res) {
      return res.text().then(function (body) {
        if (!res.ok) { var c = classifyHttp(res.status, body); throw AiError(c.code, c.detail, { status: res.status, detail: c.detail }); }
        var j;
        try { j = JSON.parse(body); } catch (e) { throw AiError('notfound', 'Not a model list', { status: res.status }); }
        if (o.kind === 'ollama' ? !Array.isArray(j && j.models) : !(j && (Array.isArray(j.data) || Array.isArray(j.models)))) throw AiError('notfound', 'Not a model list', { status: res.status });
        return { models: parseModels(o.kind, j), ms: Math.round(nowMs() - t0) };
      });
    }).then(function (r) { w.done(); return r; }, function (e) { w.done(); throw failFrom(e, w); });
  }
  // Streams one chat answer.
  // o: { kind, base, apiKey, model, messages, temperature, maxTokens, numCtx, signal,
  //      timeoutMs (no data for this long → timeout), firstTimeoutMs (before the first
  //      data: model load), onDelta(text, full), onThinking(text), Request }
  // → Promise<{ text, thinking, reason, usage, model, ms, firstMs }>; rejects AiError
  // (err.partial = the text so far).
  function chatStream(fetchImpl, o) {
    var w = watchdog(o.signal, o.timeoutMs || 120000, o.firstTimeoutMs || o.timeoutMs || 120000);
    var rq = buildChat(o), t0 = nowMs(), text = '', thinking = '', reason = '', usage = null, firstMs = 0, err = null, done = false;
    function take(obj) {
      if (done) return;
      var c = readChunk(o.kind, obj);
      if (c.error) { var k = classifyHttp(200, JSON.stringify({ error: c.error })); err = AiError(k.code, c.error, { detail: c.error }); return; }
      if (c.thinking) { thinking += c.thinking; if (o.onThinking) o.onThinking(c.thinking); }
      if (c.text) {
        if (!firstMs) firstMs = Math.round(nowMs() - t0);
        text += c.text;
        if (o.onDelta) o.onDelta(c.text, text);
      }
      if (c.usage) usage = c.usage;
      if (c.done) { reason = c.reason || 'stop'; if (o.kind === 'ollama') done = true; }
    }
    var parser = null;
    function parserFor(ct) {
      if (o.kind === 'ollama') return ndjsonParser(take);
      if (/json/i.test(ct) && !/event-stream/i.test(ct)) return null;   // a server that ignored stream:true
      return sseParser(function (ev) {
        var d = ev.data.trim();
        if (d === '[DONE]') { done = true; return; }
        var j;
        try { j = JSON.parse(d); } catch (e) { return; }
        take(j);
      });
    }
    return fetchImpl(rq.url, netInit(rq.url, Object.assign({ signal: w.signal }, rq.init), o.Request)).then(function (res) {
      if (!res.ok) return res.text().then(function (body) { var c = classifyHttp(res.status, body); throw AiError(c.code, c.detail, { status: res.status, detail: c.detail }); });
      var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      parser = parserFor(ct);
      if (!parser || !res.body || !res.body.getReader) {
        return res.text().then(function (body) {
          w.kick();
          if (parser) { parser.push(body); parser.end(); return; }
          var j;
          try { j = JSON.parse(body); } catch (e) { throw AiError('bad', 'Unreadable answer'); }
          take(j);
          if (!reason) reason = 'stop';
        });
      }
      var reader = res.body.getReader(), dec = new TextDecoder();
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { parser.push(dec.decode()); parser.end(); return; }
          w.kick();
          parser.push(dec.decode(r.value, { stream: true }));
          if (err) { try { reader.cancel(); } catch (e) {} return; }
          return pump();
        });
      }
      return pump();
    }).then(function () {
      w.done();
      if (err) { err.partial = text; throw err; }
      return { text: text, thinking: thinking, reason: reason || 'stop', usage: usage, model: o.model, ms: Math.round(nowMs() - t0), firstMs: firstMs };
    }, function (e) { w.done(); throw failFrom(e, w, text); });
  }
  // Is anything at url? cors fetch first; when that fails, a no-cors one tells
  // "there but not letting this page in" (opaque answer) from "nothing there".
  // → Promise<{ state: 'ok' | 'blocked' | 'down', status, ms, body }>
  function probe(fetchImpl, url, o) {
    o = o || {};
    var ms = o.timeoutMs || 2500, t0 = nowMs();
    function timed(init) {
      var w = watchdog(null, ms);
      return fetchImpl(url, netInit(url, Object.assign({ method: 'GET', headers: headers(o, false), signal: w.signal }, init), o.Request))
        .then(function (r) { w.done(); return r; }, function (e) { w.done(); throw e; });
    }
    return timed({}).then(function (res) {
      return res.text().then(function (body) { return { state: 'ok', status: res.status, ms: Math.round(nowMs() - t0), body: body }; });
    }, function () {
      if (o.noCors === false) return { state: 'down', status: 0, ms: Math.round(nowMs() - t0), body: '' };
      return timed({ mode: 'no-cors', headers: {} }).then(function () { return { state: 'blocked', status: 0, ms: Math.round(nowMs() - t0), body: '' }; },
        function () { return { state: 'down', status: 0, ms: Math.round(nowMs() - t0), body: '' }; });
    });
  }

  // ---- context assembly ---------------------------------------------------------------------------
  // Token-ish: ~4 ASCII chars per token, CJK ~1 char, other scripts ~2.
  function estTokens(s) {
    s = String(s == null ? '' : s);
    var a = 0, w = 0, c = 0;
    for (var i = 0; i < s.length; i++) {
      var x = s.charCodeAt(i);
      if (x < 128) a++;
      else if (x >= 0x2e80 && x <= 0xffef) c++;
      else if (x >= 0xd800 && x <= 0xdbff) { c++; i++; }
      else w++;
    }
    return Math.ceil(a / 4 + w / 2 + c);
  }
  // Tokens available for system + history + question, given the prefs.
  function budget(p) {
    var ctx = p && p.contextWindow > 0 ? p.contextWindow : 4096;
    var answer = Math.min(Math.max(64, (p && p.maxTokens) || 1024), Math.floor(ctx / 2));
    return Math.max(256, ctx - answer - 48);
  }
  // Fit text into ~maxTok tokens: keep the start and the end, say what's left out.
  function fitText(text, maxTok) {
    text = String(text || '');
    var est = estTokens(text);
    if (est <= maxTok) return { text: text, trimmed: false, dropped: 0 };
    var keep = Math.max(0, Math.floor(text.length * (maxTok / est) * 0.95) - 60);
    var head = Math.floor(keep * 0.7), tail = keep - head;
    var a = text.slice(0, head), b = tail > 0 ? text.slice(text.length - tail) : '';
    var nl = a.lastIndexOf('\n'); if (nl > head * 0.6) a = a.slice(0, nl);
    nl = b.indexOf('\n'); if (nl >= 0 && nl < tail * 0.4) b = b.slice(nl + 1);
    var dropped = text.length - a.length - b.length;
    return { text: a + '\n\n[… ' + dropped + ' characters left out to fit the model …]\n\n' + b, trimmed: true, dropped: dropped };
  }
  function composeUser(instruction, ctx) {
    instruction = String(instruction || '').trim();
    if (!ctx || !ctx.text) return instruction;
    return (instruction || 'Here is some text.') + '\n\n--- ' + (ctx.label || 'Text') + ' ---\n' + ctx.text + '\n--- end ---';
  }
  // { system, history: [{role, content}], instruction, ctx: {label, text}, budget }
  // → { messages, trimmed, dropped (history messages left out), tokens }
  function assemble(o) {
    var B = o.budget || 3000, sys = String(o.system || '').trim();
    var used = estTokens(sys) + 8;
    var ctx = o.ctx && o.ctx.text ? { label: o.ctx.label, text: String(o.ctx.text) } : null, trimmed = false;
    var user = composeUser(o.instruction, ctx);
    if (ctx && used + estTokens(user) > B) {
      var room = B - used - estTokens(composeUser(o.instruction, { label: ctx.label, text: ' ' })) - 16;
      var f = fitText(ctx.text, Math.max(64, room));
      ctx.text = f.text; trimmed = f.trimmed;
      user = composeUser(o.instruction, ctx);
    }
    used += estTokens(user) + 4;
    var hist = (o.history || []).filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && m.content; });
    var kept = [];
    for (var i = hist.length - 1; i >= 0; i--) {
      var t = estTokens(hist[i].content) + 4;
      if (used + t > B) break;
      used += t;
      kept.unshift({ role: hist[i].role, content: String(hist[i].content) });
    }
    while (kept.length && kept[0].role !== 'user') kept.shift();   // start on a question
    var msgs = [];
    if (sys) msgs.push({ role: 'system', content: sys });
    msgs = msgs.concat(kept);
    msgs.push({ role: 'user', content: user });
    return { messages: msgs, trimmed: trimmed, dropped: hist.length - kept.length, tokens: used, user: user };
  }
  var ACTIONS = [
    { id: 'summarise', label: 'Summarise', prompt: 'Summarise this in a few short bullet points.' },
    { id: 'rewrite', label: 'Rewrite clearer', prompt: 'Rewrite this so it is clearer and more concise. Keep the meaning, tone and language. Reply with only the rewritten text.', use: 'replace' },
    { id: 'continue', label: 'Continue writing', prompt: 'Continue writing from where this text ends, in the same style, voice and language. Reply with only the continuation.', use: 'insert' },
    { id: 'explain', label: 'Explain this code', prompt: 'Explain what this code does, step by step, and point out any bugs or risks.' },
    { id: 'checklist', label: 'Make a checklist', prompt: 'Turn this into a Markdown checklist ("- [ ] " items), one action per line. Reply with only the checklist.' },
    { id: 'translate', label: 'Translate to…', prompt: 'Translate this into {lang}. Keep the formatting. Reply with only the translation.', use: 'replace' }
  ];
  var LANGS = ['English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Polish', 'Swedish', 'Turkish', 'Russian', 'Ukrainian',
    'Arabic', 'Hindi', 'Chinese (Simplified)', 'Japanese', 'Korean', 'Vietnamese', 'Indonesian', 'Greek'];
  function actionPrompt(id, lang) {
    for (var i = 0; i < ACTIONS.length; i++) if (ACTIONS[i].id === id) return ACTIONS[i].prompt.replace('{lang}', lang || 'English');
    return '';
  }

  // ---- relay protocol ------------------------------------------------------------------------------
  var RELAY = {
    V: 1, KIND: 'ai',
    BATCH_MS: 150,            // the host gathers answer text this long per write
    CHUNK_MAX: 6000,          // characters per written piece
    REQ_MAX: 240000,          // characters of messages a host accepts
    RESP_MAX: 120000,         // characters of answer a host sends at most
    QUEUE_MAX: 3,             // questions waiting behind the running one
    MAX_TOKENS: 16384,
    BEAT_MS: 30000,           // presence heartbeat…
    STALE_MS: 90000,          // …and when a silent host counts as gone
    ACK_MS: 20000,            // no word from the host by then → it isn't there
    ASK_MS: 60000,            // "Ask me each time": no decision by then → no
    REQ_MAX_AGE: 120000,      // a question older than this is dropped unread
    KEEPALIVE_MS: 10000,      // "still working" while the model loads / thinks
    FIRST_MIN_MS: 90000,      // the asker waits at least this for the first text (background tabs throttle timers)
    GC_AGE: 15 * 60000,       // leftovers older than this are swept
    GC_EVERY: 10 * 60000
  };
  function rid(n) {
    var s = '', a = '0123456789abcdefghijklmnopqrstuvwxyz', k = n || 12;
    var r = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(k)) : null;
    for (var i = 0; i < k; i++) s += a.charAt(r ? r[i] % 36 : Math.floor(Math.random() * 36));
    return s;
  }
  function seqKey(n) { var s = String(n); while (s.length < 6) s = '0' + s; return 'm' + s; }
  function clampNum(v, lo, hi, d) { v = +v; if (!isFinite(v)) return d; return Math.max(lo, Math.min(hi, v)); }
  // A question as the asker sends it.
  function makeRequest(o) {
    return {
      v: RELAY.V, id: o.id, f: o.from, n: String(o.name || '').slice(0, 60), k: o.kind || '', d: o.did || '',
      model: String(o.model || '').slice(0, 200),
      messages: (o.messages || []).map(function (m) { return { role: m.role, content: String(m.content == null ? '' : m.content) }; }),
      opt: { temperature: o.temperature, maxTokens: o.maxTokens }
    };
  }
  // A received question, checked and clamped → { ok, req } | { ok: false, code, msg }.
  function validateRequest(o) {
    if (!o || typeof o !== 'object') return { ok: false, code: 'bad', msg: 'Not a request' };
    if (+o.v > RELAY.V) return { ok: false, code: 'version', msg: 'Newer protocol' };
    if (typeof o.id !== 'string' || !/^[a-z0-9]{6,32}$/.test(o.id)) return { ok: false, code: 'bad', msg: 'Bad id' };
    if (typeof o.f !== 'string' || !o.f || o.f.length > 80 || /[.#$\[\]\/]/.test(o.f)) return { ok: false, code: 'bad', msg: 'Bad sender' };
    if (!Array.isArray(o.messages) || !o.messages.length || o.messages.length > 400) return { ok: false, code: 'bad', msg: 'No messages' };
    var total = 0, msgs = [];
    for (var i = 0; i < o.messages.length; i++) {
      var m = o.messages[i];
      if (!m || ['system', 'user', 'assistant'].indexOf(m.role) < 0 || typeof m.content !== 'string') return { ok: false, code: 'bad', msg: 'Bad message' };
      total += m.content.length;
      msgs.push({ role: m.role, content: m.content });
    }
    if (total > RELAY.REQ_MAX) return { ok: false, code: 'too-big', msg: 'Too big' };
    var opt = o.opt || {};
    return { ok: true, req: {
      id: o.id, from: o.f, name: String(o.n || 'Device').slice(0, 60), kind: String(o.k || ''), did: String(o.d || ''),
      model: typeof o.model === 'string' ? o.model.slice(0, 200) : '',
      messages: msgs,
      temperature: clampNum(opt.temperature, 0, 2, 0.7),
      maxTokens: Math.round(clampNum(opt.maxTokens, 1, RELAY.MAX_TOKENS, 1024))
    } };
  }
  // Split without breaking a surrogate pair.
  function splitSafe(s, max) {
    var out = [];
    while (s.length > max) {
      var cut = max, c = s.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut--;
      out.push(s.slice(0, cut)); s = s.slice(cut);
    }
    if (s) out.push(s);
    return out;
  }
  // Gathers text for o.interval ms (the first piece goes at once), then emits
  // it in pieces of at most o.max. o: { interval, max, emit(text), now(), set(fn, ms), clear(t) }
  function createBatcher(o) {
    var buf = '', last = -Infinity, t = null;
    var now = o.now || Date.now, set = o.set || setTimeout, clear = o.clear || clearTimeout;
    function out() {
      if (t != null) { clear(t); t = null; }
      if (!buf) return;
      var s = buf; buf = ''; last = now();
      splitSafe(s, o.max || RELAY.CHUNK_MAX).forEach(function (p) { o.emit(p); });
    }
    return {
      add: function (s) {
        if (!s) return;
        buf += s;
        var since = now() - last, iv = o.interval || RELAY.BATCH_MS;
        if (buf.length >= (o.max || RELAY.CHUNK_MAX) || since >= iv) out();
        else if (t == null) t = set(out, iv - since);
      },
      drain: out,
      pending: function () { return buf.length; },
      cancel: function () { if (t != null) clear(t); t = null; buf = ''; }
    };
  }
  // Delivers messages in q order (1, 2, 3…), holding early ones; drops duplicates.
  function createReassembler(deliver) {
    var next = 1, held = {};
    return {
      add: function (m) {
        if (!m || typeof m.q !== 'number' || m.q < next || held[m.q]) return false;
        held[m.q] = m;
        while (held[next]) { var x = held[next]; delete held[next]; next++; deliver(x); }
        return true;
      },
      next: function () { return next; },
      waiting: function () { return Object.keys(held).length; }
    };
  }
  // Presence entries {inst: {s, at}} already unsealed → online hosts, newest first,
  // one per device. decoded: [{ inst, at, o }]
  function parsePresence(decoded, now, myDid, staleMs) {
    var by = {};
    (decoded || []).forEach(function (e) {
      var o = e && e.o;
      if (!o || typeof o !== 'object') return;
      var at = +e.at || 0;
      if (!at || now - at > (staleMs || RELAY.STALE_MS)) return;
      var did = String(o.d || e.inst);
      if (myDid && did === myDid) return;
      var h = {
        inst: e.inst, did: did, name: String(o.n || 'Device').slice(0, 60), kind: String(o.k || 'desktop'),
        models: Array.isArray(o.m) ? o.m.filter(function (x) { return typeof x === 'string'; }).slice(0, 60) : [],
        model: String(o.dm || ''), busy: !!o.busy, queue: +o.q || 0, policy: o.pol === 'ask' ? 'ask' : 'auto',
        ok: o.ok !== false, provider: String(o.pv || ''), v: +o.v || 1, at: at, age: Math.max(0, now - at)
      };
      if (!by[did] || by[did].at < at) by[did] = h;
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.at - a.at; });
  }
  function pickHost(hosts, want) {
    if (!hosts || !hosts.length) return null;
    if (want) for (var i = 0; i < hosts.length; i++) if (hosts[i].did === want || hosts[i].inst === want) return hosts[i];
    var ok = hosts.filter(function (h) { return h.ok; });
    return (ok.length ? ok : hosts)[0];
  }

  // The device that runs the model. d: {
  //   cloud: { ref(sub) → Promise<ref|null>, seal(o) → Promise<str>, unseal(s) → Promise<o|null>, ts() (server timestamp), now() },
  //   device() → { inst, name, kind, id }, info() → { models: [names], model, ok, provider },
  //   policy() → 'auto' | 'ask', ask(job) → Promise<bool>,
  //   run(job, { signal, onDelta(text), onThinking() }) → Promise<{ reason, usage, model }>,
  //   onChange(status), timers: { setTimeout, clearTimeout, setInterval, clearInterval }, limits: {…RELAY overrides} }
  function createRelayHost(d) {
    var L = Object.assign({}, RELAY, d.limits || {}), tm = d.timers || { setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval };
    var C = d.cloud;
    var on = false, gen = 0, presRef = null, lastPres = '', beat = null, offs = [], jobs = {}, queue = [], running = null, served = 0, lastGc = 0;
    function me() { return d.device(); }
    function status() {
      return { online: on && !!presRef, busy: !!running, queued: queue.length, served: served,
        current: running ? { name: running.req.name, model: running.model || running.req.model, since: running.started } : null };
    }
    function changed() { if (d.onChange) try { d.onChange(status()); } catch (e) {} }
    function presence() {
      var i = d.info ? d.info() : {}, m = me();
      return { v: L.V, n: m.name, k: m.kind, d: m.id, m: (i.models || []).slice(0, 40), dm: i.model || '', busy: !!running, q: queue.length,
        pol: d.policy ? d.policy() : 'auto', ok: i.ok !== false, pv: i.provider || '' };
    }
    function announce(force) {
      if (!on) return Promise.resolve(false);
      var p = presence(), key = JSON.stringify(p), g = gen;
      if (!force && key === lastPres && presRef) return Promise.resolve(true);
      lastPres = key;
      return (presRef ? Promise.resolve(presRef) : C.ref('hosts/' + me().inst)).then(function (r) {
        if (!r || !on || g !== gen) return false;
        presRef = r;
        return C.seal(p).then(function (s) {
          if (!on || g !== gen) return false;
          try { r.onDisconnect().remove(); } catch (e) {}
          return Promise.resolve(r.set({ s: s, at: C.ts() })).then(function () { return true; });
        });
      }).catch(function () { return false; });
    }
    function reply(job, msg) {
      // the asker cancelled: it has removed its answer box, so write nothing more
      // (stop()'s farewell error is the one exception)
      if (job.cancelled && msg.t !== 'e') return Promise.resolve();
      msg.v = L.V; msg.id = job.id; msg.q = ++job.seq;
      var g = gen;
      return job.res.then(function (r) {
        if (!r) return;
        return C.seal(msg).then(function (s) { if (g === gen || msg.t === 'e') return r.child(seqKey(msg.q)).set({ s: s, at: C.ts() }); });
      }).catch(function () {});
    }
    function fail(job, code, msg) { return reply(job, { t: 'e', code: code, msg: String(msg || '').slice(0, 400) }); }
    function positions() { queue.forEach(function (j, i) { reply(j, { t: 'a', pos: i + 1 }); }); }
    function onReq(snap) {
      var v = snap.val();
      try { snap.ref.remove(); } catch (e) {}
      if (!on || !v || typeof v.s !== 'string') return;
      if (v.at && C.now() - v.at > L.REQ_MAX_AGE) return;
      C.unseal(v.s).then(function (o) {
        if (!on || !o) return;
        var chk = validateRequest(o);
        var id = o && typeof o.id === 'string' && /^[a-z0-9]{6,32}$/.test(o.id) ? o.id : '';
        var from = o && typeof o.f === 'string' && o.f.length <= 80 && !/[.#$\[\]\/]/.test(o.f) ? o.f : '';
        if (!id || !from || jobs[id]) return;
        var job = { id: id, from: from, seq: 0, req: chk.req, state: 'new', cancelled: false, ctl: null, model: '', started: 0 };
        job.res = C.ref('res/' + from + '/' + id);
        jobs[id] = job;
        if (!chk.ok) { delete jobs[id]; fail(job, chk.code, chk.msg); return; }
        if ((running ? 1 : 0) + queue.length >= 1 + L.QUEUE_MAX) { delete jobs[id]; fail(job, 'busy', 'Too many questions waiting'); return; }
        if (d.policy && d.policy() === 'ask' && d.ask) {
          job.state = 'asking';
          reply(job, { t: 'w' });
          var decided = false, t = tm.setTimeout(function () { decide(false); }, L.ASK_MS);
          var decide = function (yes) {
            if (decided) return;
            decided = true; tm.clearTimeout(t);
            if (job.cancelled || !on) { delete jobs[id]; return; }
            if (!yes) { delete jobs[id]; fail(job, 'denied', 'Declined'); return; }
            enqueue(job);
          };
          Promise.resolve(d.ask(job)).then(decide, function () { decide(false); });
          job.decide = decide;
          return;
        }
        enqueue(job);
      });
    }
    function enqueue(job) {
      job.state = 'queued';
      queue.push(job);
      reply(job, { t: 'a', pos: running ? queue.length : 0 });
      changed();
      pump();
    }
    function pump() {
      if (!on || running || !queue.length) return;
      var job = queue.shift();
      running = job;
      job.state = 'running'; job.started = Date.now();
      positions();
      announce();
      changed();
      var Ctl = typeof AbortController !== 'undefined' ? AbortController : null;
      job.ctl = Ctl ? new Ctl() : null;
      var total = 0, gotText = false, sentK = false, over = false;
      var batch = createBatcher({ interval: L.BATCH_MS, max: L.CHUNK_MAX, emit: function (x) { reply(job, { t: 'd', x: x }); },
        set: tm.setTimeout, clear: tm.clearTimeout });
      var keep = job.keep = tm.setInterval(function () { if (!gotText) reply(job, { t: 'h' }); }, L.KEEPALIVE_MS);
      var t0 = Date.now();
      Promise.resolve().then(function () {
        return d.run(job, {
          signal: job.ctl ? job.ctl.signal : null,
          model: function (m) { job.model = m; reply(job, { t: 's', model: m }); },
          onThinking: function () { if (!sentK && !gotText) { sentK = true; reply(job, { t: 'k' }); } },
          onDelta: function (x) {
            if (over || job.cancelled) return;
            gotText = true;
            if (total + x.length > L.RESP_MAX) { x = x.slice(0, Math.max(0, L.RESP_MAX - total)); over = true; }
            total += x.length;
            batch.add(x);
            if (over && job.ctl) job.ctl.abort();
          }
        });
      }).then(function (r) {
        batch.drain();
        if (!job.cancelled) reply(job, { t: 'z', reason: (r && r.reason) || 'stop', usage: (r && r.usage) || null, ms: Date.now() - t0, model: (r && r.model) || job.model });
      }, function (e) {
        if (job.cancelled) { batch.cancel(); return; }
        batch.drain();
        if (over) reply(job, { t: 'z', reason: 'length', usage: null, ms: Date.now() - t0, model: job.model });
        else fail(job, (e && e.code) || 'server', (e && (e.detail || e.message)) || 'Failed');
      }).then(function () {
        tm.clearInterval(keep);
        delete jobs[job.id];
        if (running === job) running = null;
        served++;
        announce();
        changed();
        gc();
        pump();
      });
    }
    function onCtl(snap) {
      var v = snap.val();
      try { snap.ref.remove(); } catch (e) {}
      if (!v || typeof v.s !== 'string') return;
      C.unseal(v.s).then(function (o) {
        if (!o || o.t !== 'x') return;
        var job = jobs[o.id];
        if (!job || job.from !== o.f) return;
        job.cancelled = true;
        if (job.state === 'running') { if (job.ctl) job.ctl.abort(); }
        else {
          var i = queue.indexOf(job);
          if (i >= 0) { queue.splice(i, 1); positions(); }
          if (job.decide) job.decide(false);
          delete jobs[job.id];
          changed();
        }
      });
    }
    function listen(sub, fn) {
      var g = gen;
      return C.ref(sub).then(function (r) {
        if (!r || !on || g !== gen) return;
        var h = r.on('child_added', fn);
        offs.push(function () { try { r.off('child_added', h); } catch (e) {} });
      });
    }
    // Sweep answers nobody collected and hosts that vanished without onDisconnect.
    function gc(force) {
      var now = C.now();
      if (!force && now - lastGc < L.GC_EVERY) return;
      lastGc = now;
      C.ref('res').then(function (r) {
        if (!r) return;
        return r.once('value').then(function (snap) {
          var v = snap.val() || {};
          Object.keys(v).forEach(function (cl) {
            Object.keys(v[cl] || {}).forEach(function (id) {
              var newest = 0, ch = v[cl][id] || {};
              Object.keys(ch).forEach(function (k) { newest = Math.max(newest, +(ch[k] && ch[k].at) || 0); });
              if (newest && now - newest > L.GC_AGE && !jobs[id]) r.child(cl + '/' + id).remove();
            });
          });
        });
      }).catch(function () {});
      C.ref('hosts').then(function (r) {
        if (!r) return;
        return r.once('value').then(function (snap) {
          var v = snap.val() || {};
          Object.keys(v).forEach(function (inst) { if (inst !== me().inst && v[inst] && +v[inst].at && now - v[inst].at > L.GC_AGE) r.child(inst).remove(); });
        });
      }).catch(function () {});
    }
    function start() {
      if (on) return Promise.resolve(true);
      on = true; gen++; lastPres = '';
      var m = me();
      return announce(true).then(function (ok) {
        if (!ok || !on) { if (on) { on = false; presRef = null; } return false; }
        // the whole entry each time, re-arming onDisconnect: after a dropped connection
        // (laptop asleep) the server has removed it, and a bare "at" wouldn't bring it back
        beat = tm.setInterval(function () { announce(true); }, L.BEAT_MS);
        return Promise.all([listen('req/' + m.inst, onReq), listen('ctl/' + m.inst, onCtl)]).then(function () { changed(); gc(true); return true; });
      });
    }
    function stop(code) {
      if (!on) return Promise.resolve();
      gen++;
      offs.forEach(function (f) { f(); }); offs = [];
      tm.clearInterval(beat); beat = null;
      Object.keys(jobs).forEach(function (id) {
        var j = jobs[id];
        if (j.cancelled) return;
        j.cancelled = true;
        if (j.keep) tm.clearInterval(j.keep);
        if (j.ctl) try { j.ctl.abort(); } catch (e) {}
        if (j.decide) j.decide(false);
        // a last word for the asker (written although stopping: the gen check is skipped for errors)
        fail(j, code || 'host-stopped', 'Sharing stopped');
      });
      on = false;
      jobs = {}; queue = []; running = null;
      var r = presRef; presRef = null; lastPres = '';
      changed();
      if (!r) return Promise.resolve();
      try { r.onDisconnect().cancel(); } catch (e) {}
      return Promise.resolve(r.remove()).catch(function () {});
    }
    return { start: start, stop: stop, refresh: function () { return announce(); }, status: status, _gc: gc };
  }

  // The asking side. d: { cloud (as above), device(), limits, timers }
  function createRelayClient(d) {
    var L = Object.assign({}, RELAY, d.limits || {}), C = d.cloud, tm = d.timers || { setTimeout: setTimeout, clearTimeout: clearTimeout };
    var active = [];
    function me() { return d.device(); }
    function decode(v) {
      var keys = Object.keys(v || {});
      return Promise.all(keys.map(function (inst) {
        var e = v[inst];
        if (!e || typeof e.s !== 'string') return null;
        return C.unseal(e.s).then(function (o) { return o ? { inst: inst, at: +e.at || 0, o: o } : null; }, function () { return null; });
      })).then(function (l) { return l.filter(Boolean); });
    }
    // cb(hosts) now and on every change (and as entries go stale); returns off().
    function watchHosts(cb) {
      var r = null, fn = null, stop = false, last = [], g = 0, tick = null;
      function emit() { if (!stop) cb(parsePresence(last, C.now(), me().id, L.STALE_MS)); }
      C.ref('hosts').then(function (rr) {
        if (stop) return;
        if (!rr) { cb(null); return; }
        r = rr;
        fn = r.on('value', function (snap) {
          var my = ++g;
          decode(snap.val()).then(function (l) { if (my !== g || stop) return; last = l; emit(); });
        });
        tick = (tm.setInterval || setInterval)(emit, 15000);
      });
      return function () { stop = true; if (tick) (tm.clearInterval || clearInterval)(tick); if (r && fn) try { r.off('value', fn); } catch (e) {} };
    }
    function listHosts() {
      return C.ref('hosts').then(function (r) {
        if (!r) return null;
        return r.once('value').then(function (snap) { return decode(snap.val()); }).then(function (l) { return parsePresence(l, C.now(), me().id, L.STALE_MS); });
      });
    }
    // Ask host a question. q: { model, messages, temperature, maxTokens };
    // h: { signal, onDelta(x, full), onEvent(msg), timeoutMs }
    // → Promise<{ text, reason, usage, model, ms }>; rejects AiError (err.partial).
    function request(host, q, h) {
      h = h || {};
      var m = me(), id = rid(14), text = '', done = false, firstText = false, waitingOk = false;
      var timeoutMs = h.timeoutMs || 120000;
      var resRef = null, reqRef = null, fn = null, tAck = null, tIdle = null, offAbort = null;
      var payload = makeRequest({ id: id, from: m.inst, name: m.name, kind: m.kind, did: m.id, model: q.model, messages: q.messages, temperature: q.temperature, maxTokens: q.maxTokens });
      var size = 0;
      payload.messages.forEach(function (x) { size += x.content.length; });
      if (size > L.REQ_MAX) return Promise.reject(AiError('too-big', 'Too big'));
      var entry;
      return new Promise(function (resolve, reject) {
        // A timer that fires far too late means the page was suspended (phone
        // locked): the answer may be waiting in the cloud, so wait another round.
        function late(due) { return Date.now() - due > 5000; }
        function idleArm() {
          tm.clearTimeout(tIdle);
          var ms = waitingOk ? L.ASK_MS + timeoutMs : (firstText ? timeoutMs : Math.max(timeoutMs, L.FIRST_MIN_MS)), due = Date.now() + ms;
          tIdle = tm.setTimeout(function () {
            if (late(due)) { idleArm(); return; }
            end(AiError('timeout', 'No answer in time', { partial: text })); sendCancel();
          }, ms);
        }
        function ackArm() {
          tm.clearTimeout(tAck);
          var due = Date.now() + L.ACK_MS;
          tAck = tm.setTimeout(function () {
            if (late(due)) { ackArm(); return; }
            end(AiError('host-silent', 'No answer from the host', { partial: text }));
          }, L.ACK_MS);
        }
        function end(err, res) {
          if (done) return;
          done = true;
          tm.clearTimeout(tAck); tm.clearTimeout(tIdle);
          if (offAbort) offAbort();
          var i = active.indexOf(entry); if (i >= 0) active.splice(i, 1);
          if (resRef && fn) { try { resRef.off('child_added', fn); } catch (e) {} }
          if (resRef) Promise.resolve(resRef.remove()).catch(function () {});
          if (reqRef) { try { reqRef.onDisconnect().cancel(); } catch (e) {} Promise.resolve(reqRef.remove()).catch(function () {}); }
          if (err) reject(err); else resolve(res);
        }
        function sendCancel() {
          C.ref('ctl/' + host.inst + '/' + id).then(function (r) {
            if (!r) return;
            return C.seal({ t: 'x', id: id, f: m.inst }).then(function (s) { return r.set({ f: m.inst, s: s, at: C.ts() }); });
          }).catch(function () {});
        }
        var asm = createReassembler(function (msg) {
          if (done) return;
          tm.clearTimeout(tAck);
          if (msg.t === 'w') waitingOk = true;
          else if (msg.t !== 'h' && msg.t !== 'a') waitingOk = false;
          if (msg.t === 'd') {
            firstText = true;
            text += String(msg.x || '');
            if (h.onDelta) h.onDelta(String(msg.x || ''), text);
          } else if (h.onEvent) { try { h.onEvent(msg); } catch (e) {} }
          if (msg.t === 'z') { end(null, { text: text, reason: msg.reason || 'stop', usage: msg.usage || null, model: msg.model || '', ms: msg.ms || 0, host: host }); return; }
          if (msg.t === 'e') { end(AiError(msg.code || 'server', msg.msg || 'Failed', { partial: text, detail: msg.msg || '' })); return; }
          idleArm();
        });
        entry = { resume: function () { if (!done) { idleArm(); if (asm.next() === 1) ackArm(); } } };
        active.push(entry);
        if (h.signal) {
          if (h.signal.aborted) { end(AiError('aborted', 'Stopped', { partial: '' })); return; }
          var ab = function () { if (done) return; sendCancel(); end(AiError('aborted', 'Stopped', { partial: text })); };
          h.signal.addEventListener('abort', ab);
          offAbort = function () { h.signal.removeEventListener('abort', ab); };
        }
        C.ref('res/' + m.inst + '/' + id).then(function (r) {
          if (done) return;
          if (!r) { end(AiError('nosync', 'Sync is not set up')); return; }
          resRef = r;
          fn = r.on('child_added', function (snap) {
            var v = snap.val();
            if (!v || typeof v.s !== 'string') return;
            C.unseal(v.s).then(function (msg) { if (msg && msg.id === id) asm.add(msg); });
          });
          return C.ref('req/' + host.inst + '/' + id);
        }).then(function (r) {
          if (done || !r) return;
          reqRef = r;
          return C.seal(payload).then(function (s) {
            if (done) return;
            try { r.onDisconnect().remove(); } catch (e) {}
            ackArm();
            idleArm();
            return r.set({ f: m.inst, s: s, at: C.ts() });
          });
        }).catch(function (e) { end(AiError('nosync', String((e && e.message) || e))); });
      });
    }
    // After the page was suspended (phone locked): give pending questions a fresh window.
    function resume() { active.slice().forEach(function (a) { a.resume(); }); }
    return { watchHosts: watchHosts, listHosts: listHosts, request: request, resume: resume, pending: function () { return active.length; } };
  }

  // ---- markdown (safe: everything is escaped first) ----------------------------------------------
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function safeUrl(u) {
    u = String(u || '').trim();
    return /^(https?:\/\/|mailto:)/i.test(u) ? u : '';
  }
  function inline(s) {
    // s is raw text; code spans are cut out first so nothing inside them is formatted
    var codes = [];
    s = String(s).replace(/`([^`\n]+)`/g, function (m, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    var links = [];
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (m, t, u) { links.push([t, u]); return '\u0001' + (links.length - 1) + '\u0001'; });
    s = esc(s)
      .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    s = s.replace(/\u0001(\d+)\u0001/g, function (m, i) {
      var l = links[+i], u = safeUrl(l[1]);
      return u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(l[0]) + '</a>' : esc(l[0]);
    });
    return s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return '<code>' + esc(codes[+i]) + '</code>'; });
  }
  function mdToHtml(src) {
    var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    var out = [], i = 0, para = [];
    function flush() { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } }
    while (i < lines.length) {
      var l = lines[i], m;
      if ((m = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(l))) {
        flush();
        var fence = m[1], lang = m[2], code = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(fence) !== 0) code.push(lines[i++]);
        i++;
        out.push('<pre><code' + (lang ? ' class="language-' + esc(lang) + '"' : '') + '>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      if (!l.trim()) { flush(); i++; continue; }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { flush(); var lv = Math.min(6, m[1].length + 2); out.push('<h' + lv + '>' + inline(m[2].replace(/\s+#+\s*$/, '')) + '</h' + lv + '>'); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(l)) {
        flush();
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push('<blockquote>' + mdToHtml(q.join('\n')) + '</blockquote>');
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush();
        var cells = function (r) { return r.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return inline(c.trim()); }); };
        var hd = cells(l), rows = [];
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push('<table><thead><tr>' + hd.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>');
        continue;
      }
      if ((m = /^(\s*)([-*+]|\d{1,3}[.)])\s+/.exec(l))) {
        flush();
        var ordered = /\d/.test(m[2]), items = [];
        while (i < lines.length && (m = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(lines[i]))) {
          var body = m[3], cls = '';
          var tm = /^\[([ xX])\]\s+(.*)$/.exec(body);
          if (tm) { body = tm[2]; cls = tm[1] === ' ' ? ' class="task"' : ' class="task done"'; }
          var ind = m[1].length;
          if (ind >= 2) cls = cls ? cls.replace('"task', '"ind' + Math.min(4, Math.floor(ind / 2)) + ' task') : ' class="ind' + Math.min(4, Math.floor(ind / 2)) + '"';
          items.push('<li' + cls + '>' + (tm ? '<span class="box">' + (tm[1] === ' ' ? '☐' : '☑') + '</span> ' : '') + inline(body) + '</li>');
          i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d{1,3}[.)])\s+/.test(lines[i])) { items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, '<br>' + inline(lines[i].trim()) + '</li>'); i++; }
        }
        out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      para.push(l);
      i++;
    }
    flush();
    return out.join('');
  }

  // A note name from an answer's first line (Firebase keys can't hold . # $ [ ] /).
  function roomNameFrom(text, taken) {
    var first = String(text || '').split('\n').map(function (l) { return l.replace(/^[\s#>*\-+\d.)\[\]xX`|]+/, '').replace(/[*_`~|]/g, '').trim(); }).filter(Boolean)[0] || '';
    var b = first.toLowerCase().replace(/[.#$\[\]\/\\\u0000-\u001f\u007f]+/g, ' ').replace(/[^\w\sÀ-￿-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (b.length > 40) { b = b.slice(0, 41); b = b.lastIndexOf(' ') > 15 ? b.slice(0, b.lastIndexOf(' ')) : b.slice(0, 40); }
    b = b.trim() || 'ai answer';
    var n = b, k = 2;
    while ((taken || []).indexOf(n) !== -1 && k < 1000) n = b + ' ' + (k++);
    return n;
  }
  function fmtBytes(n) {
    n = +n || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
    if (n >= 1e6) return Math.round(n / 1e6) + ' MB';
    if (n >= 1e3) return Math.round(n / 1e3) + ' KB';
    return n + ' B';
  }
  function fmtMs(ms) { ms = +ms || 0; return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s'; }
  // Where am I: { os, browser } from a user agent (+ maxTouchPoints for iPadOS).
  function sniff(ua, touch) {
    ua = String(ua || '');
    var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1);
    var os = ios ? 'ios' : /Android/.test(ua) ? 'android' : /Windows/.test(ua) ? 'win' : /Mac OS X|Macintosh/.test(ua) ? 'mac' : /CrOS/.test(ua) ? 'chromeos' : /Linux|X11/.test(ua) ? 'linux' : 'other';
    var br = /Edg\//.test(ua) ? 'edge' : /Firefox\/|FxiOS/.test(ua) ? 'firefox' : /Chrome\/|CriOS|Chromium/.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other';
    if (ios && br !== 'firefox' && br !== 'edge' && br !== 'chrome') br = 'safari';
    return { os: os, browser: br, ios: ios };
  }

  var api = {
    PREFS: PREFS, PREF_DEFAULTS: PREF_DEFAULTS, PRESETS: PRESETS, DETECT: DETECT, RELAY: RELAY, ACTIONS: ACTIONS, LANGS: LANGS,
    presetOf: presetOf, kindOf: kindOf, normBase: normBase, hostOf: hostOf, addressSpace: addressSpace, isHttp: isHttp,
    modelsUrl: modelsUrl, buildChat: buildChat, parseModels: parseModels, chatModels: chatModels, pickModel: pickModel, readChunk: readChunk,
    ndjsonParser: ndjsonParser, sseParser: sseParser,
    AiError: AiError, errorMessage: errorMessage, classifyHttp: classifyHttp, refineNetwork: refineNetwork, isAbort: isAbort, explain: explain,
    listModels: listModels, chatStream: chatStream, probe: probe,
    estTokens: estTokens, budget: budget, fitText: fitText, composeUser: composeUser, assemble: assemble, actionPrompt: actionPrompt,
    rid: rid, seqKey: seqKey, makeRequest: makeRequest, validateRequest: validateRequest, splitSafe: splitSafe,
    createBatcher: createBatcher, createReassembler: createReassembler, parsePresence: parsePresence, pickHost: pickHost,
    createRelayHost: createRelayHost, createRelayClient: createRelayClient,
    esc: esc, safeUrl: safeUrl, mdToHtml: mdToHtml, roomNameFrom: roomNameFrom, fmtBytes: fmtBytes, fmtMs: fmtMs, sniff: sniff
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object' && typeof window !== 'undefined' && root === window) root.__cadeAiCore = api;
})(typeof self !== 'undefined' ? self : this);
