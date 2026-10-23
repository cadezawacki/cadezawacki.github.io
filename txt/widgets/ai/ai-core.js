/* AI — the pure part: everything that doesn't touch the page, so node can
 * test it (node txt/widgets/ai/ai.test.js). UMD: module.exports in node,
 * window.__cadeAiCore in the browser.
 *
 *   PREFS      the Widget preferences schema (same as the manifest "prefs").
 *   providers  local servers (Ollama, LM Studio, any OpenAI-compatible one)
 *              and cloud APIs (OpenAI, Anthropic, Gemini, OpenRouter, Groq,
 *              Mistral, DeepSeek, xAI, Together) — every one checked to
 *              answer browser (CORS) requests. A device keeps a list of
 *              "endpoints" (one per provider, each with its own key) in its
 *              own storage; nothing here stores anything.
 *   adapters   request building (Ollama native, OpenAI chat completions,
 *              Anthropic Messages), model lists per provider (with context
 *              window / price where the provider says), one streamed chunk →
 *              {text, thinking, done, reason, usage, error}.
 *   streams    NDJSON (Ollama) and SSE (OpenAI, Anthropic) parsers that take
 *              text in arbitrary pieces.
 *   engine     listModels / chatStream / probe over an injected fetch, with
 *              an inactivity timeout and abort; errors are AiError {code}.
 *   errors     classify an HTTP status + body or a network failure into a
 *              code and explain(code, env) → a title and fix steps for THIS
 *              OS / browser / provider (with commands to copy).
 *   badges     price per 1M tokens (OpenRouter's public catalog), context
 *              window, local size, and an LMArena text score (CC BY 4.0) —
 *              matched to a model by a normalised name, never guessed.
 *   context    token-ish estimates, trimming a note to the model's window,
 *              assembling system + history + the new question.
 *   relay      the protocol between a device that runs the models (the host)
 *              and the account's other devices, over Cade.cloud (sealed with
 *              the Sync key). The asking device never talks to a model API:
 *              it only writes sealed questions and reads sealed answers.
 *              createRelayHost / createRelayClient take the cloud as an
 *              injected interface, so the exchange runs in node too.
 *   markdown   a small, safe Markdown → HTML for answers.
 *
 * Relay layout (Cade.cloud kind "ai", i.e. rooms/__cade_ai_<keyFp>/…):
 *   hosts/<inst>               {s: sealed presence, b: sealed {busy, q}, at}
 *                              presence = names and metadata of the shared
 *                              providers and models only — never a key or URL
 *   req/<hostInst>/<id>        {f, s: sealed request, at} — {provider, model,
 *                              messages, opt}; the host checks it against what
 *                              it shares and removes it on pickup
 *   res/<clientInst>/<id>/<m…> {s: sealed message, at}   the asker removes it
 *   ctl/<hostInst>/<id>        {f, s: sealed {t:'x'}}     cancel
 * Host → client messages (sealed): {v, id, q (1, 2, 3… in order), t, …}
 *   a accepted {pos}   w waiting for the host's OK   s started {model}
 *   k thinking   h still working   d text {x}   z done {reason, usage, ms}
 *   e error {code, msg} */
(function (root) {
  'use strict';

  // ---- preferences (Widget preferences page "AI"; identical to the manifest) -------------------
  var PREFS = [
    { type: 'heading', label: 'Model' },
    { key: 'model', type: 'text', label: 'Default model', default: '', maxLength: 240, placeholder: 'Automatic',
      hint: 'What a note starts with — the ▾ next to the model in the AI panel switches it per note. Written as service:model, e.g. ollama:llama3.2 or anthropic:claude-opus-5-5. Services and API keys are set up in the panel (⚙) and stay on the device' },
    { type: 'heading', label: 'Answers' },
    { key: 'temperature', type: 'slider', label: 'Creativity (temperature)', default: 0.7, min: 0, max: 2, step: 0.1,
      hint: 'Lower is focused and repeatable, higher is more varied. Not sent where the model only takes its default (Anthropic, OpenAI reasoning models)' },
    { key: 'maxTokens', type: 'number', label: 'Longest answer', default: 4096, min: 32, max: 32768, step: 32, unit: 'tokens',
      hint: 'Thinking models count their thinking in this too' },
    { key: 'contextWindow', type: 'number', label: 'Context window (local models)', default: 0, min: 0, max: 262144, step: 1024, unit: 'tokens',
      hint: 'How much text an Ollama model reads at once. 0 = the server’s own setting (counted as 4096 when fitting a note in; cloud models use their own window). Bigger needs more memory' },
    { key: 'system', type: 'textarea', label: 'System prompt', maxLength: 4000,
      default: 'You are a helpful writing assistant inside a notes app. Be concise and clear. Use Markdown when it helps.' },
    { key: 'history', type: 'toggle', label: 'Keep the conversation for each note', default: true,
      hint: 'Saved on this device only; Clear in the panel removes it' },
    { key: 'timeout', type: 'number', label: 'Give up after', default: 120, min: 15, max: 900, step: 5, unit: 's',
      hint: 'With no answer coming in. The first answer can take a while as a local model loads' },
    { type: 'heading', label: 'Sharing' },
    { key: 'share', type: 'toggle', label: 'Share with my other devices', default: false,
      hint: 'This device answers the AI on your other devices, end-to-end encrypted with your Sync key; they never contact a model service themselves. Same switch as Preferences → Devices → “Share my AI models with my other devices”' },
    { key: 'policy', type: 'radio', label: 'When another device asks', default: 'auto', showIf: 'share',
      options: [{ value: 'auto', label: 'Answer automatically' }, { value: 'ask', label: 'Ask me each time' }] },
    { key: 'shareCloud', type: 'toggle', label: 'Share cloud services too', default: false, showIf: 'share',
      hint: 'Lets your other devices use this device’s API keys (OpenAI, Anthropic, …) — that can cost money. Local models are shared whenever sharing is on' },
    { key: 'cloudMaxTokens', type: 'number', label: 'Longest cloud answer for another device', default: 2048, min: 64, max: 16384, step: 64, unit: 'tokens', showIf: 'shareCloud',
      hint: 'A cap on what one question from another device may spend' }
  ];
  var PREF_DEFAULTS = {};
  PREFS.forEach(function (f) { if (f.key) PREF_DEFAULTS[f.key] = f.default; });

  // ---- providers -------------------------------------------------------------------------------
  // kind = the API spoken: 'ollama' (native /api/*), 'openai' (/v1/chat/completions) or
  // 'anthropic' (/v1/messages). where = 'local' (runs on your hardware, free) or 'cloud'
  // (a paid API with your key). Every cloud base below answered a CORS preflight from
  // https://cadezawacki.github.io with Access-Control-Allow-Origin (checked 2026-10-22).
  var PROVIDERS = {
    ollama: { id: 'ollama', label: 'Ollama', sub: 'Runs models on this computer', kind: 'ollama', where: 'local', url: 'http://127.0.0.1:11434', key: 'none' },
    lmstudio: { id: 'lmstudio', label: 'LM Studio', sub: 'Runs models on this computer', kind: 'openai', where: 'local', url: 'http://127.0.0.1:1234/v1', key: 'none' },
    // Unsloth Studio: /v1 is OpenAI-compatible on its UI port (8888 by default, -p to change), keys
    // are sk-unsloth-… unless keyless access is on in its settings. `unsloth studio` answers any
    // origin; the desktop app only trusts origins listed in UNSLOTH_CORS_ORIGINS.
    unsloth: { id: 'unsloth', label: 'Unsloth Studio', sub: 'Runs and fine-tunes models on this computer', kind: 'openai', where: 'local', url: 'http://127.0.0.1:8888/v1', key: 'optional',
      keyHint: 'sk-unsloth-…' },
    custom: { id: 'custom', label: 'Other server', sub: 'Any OpenAI-compatible one: llama.cpp, Jan, vLLM, LocalAI…', kind: 'openai', where: 'local', url: 'http://127.0.0.1:8080/v1', key: 'optional' },
    openai: { id: 'openai', label: 'OpenAI', sub: 'ChatGPT models (GPT-5…)', kind: 'openai', where: 'cloud', url: 'https://api.openai.com/v1', key: 'required',
      keyUrl: 'https://platform.openai.com/api-keys', vendor: 'openai', tokensParam: 'max_completion_tokens', fixedTemp: /^(o\d|gpt-[5-9]|chatgpt-[5-9])/ },
    anthropic: { id: 'anthropic', label: 'Anthropic', sub: 'Claude models', kind: 'anthropic', where: 'cloud', url: 'https://api.anthropic.com/v1', key: 'required',
      keyUrl: 'https://platform.claude.com/settings/keys', vendor: 'anthropic', prefer: 'claude-opus-5-5' },
    gemini: { id: 'gemini', label: 'Google Gemini', sub: 'Gemini models', kind: 'openai', where: 'cloud', url: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'required',
      keyUrl: 'https://aistudio.google.com/apikey', vendor: 'google', list: 'gemini' },
    openrouter: { id: 'openrouter', label: 'OpenRouter', sub: 'Hundreds of models with one key', kind: 'openai', where: 'cloud', url: 'https://openrouter.ai/api/v1', key: 'required',
      keyUrl: 'https://openrouter.ai/keys', attribution: true },
    groq: { id: 'groq', label: 'Groq', sub: 'Fast open models', kind: 'openai', where: 'cloud', url: 'https://api.groq.com/openai/v1', key: 'required', keyUrl: 'https://console.groq.com/keys' },
    mistral: { id: 'mistral', label: 'Mistral', sub: 'Mistral models', kind: 'openai', where: 'cloud', url: 'https://api.mistral.ai/v1', key: 'required',
      keyUrl: 'https://console.mistral.ai/api-keys', vendor: 'mistralai', tempMax: 1.5 },
    deepseek: { id: 'deepseek', label: 'DeepSeek', sub: 'DeepSeek models', kind: 'openai', where: 'cloud', url: 'https://api.deepseek.com/v1', key: 'required',
      keyUrl: 'https://platform.deepseek.com/api_keys', vendor: 'deepseek' },
    xai: { id: 'xai', label: 'xAI', sub: 'Grok models', kind: 'openai', where: 'cloud', url: 'https://api.x.ai/v1', key: 'required', keyUrl: 'https://console.x.ai/', vendor: 'x-ai' },
    together: { id: 'together', label: 'Together AI', sub: 'Open models in the cloud', kind: 'openai', where: 'cloud', url: 'https://api.together.xyz/v1', key: 'required',
      keyUrl: 'https://api.together.ai/settings/api-keys' }
  };
  var PROVIDER_ORDER = ['ollama', 'lmstudio', 'unsloth', 'custom', 'openai', 'anthropic', 'gemini', 'openrouter', 'groq', 'mistral', 'deepseek', 'xai', 'together'];
  var PRESETS = PROVIDERS;   // the round-1 name
  // Where "Find local servers" looks (all on this computer).
  var DETECT = [
    { provider: 'ollama', name: 'Ollama', base: 'http://127.0.0.1:11434' },
    { provider: 'lmstudio', name: 'LM Studio', base: 'http://127.0.0.1:1234/v1' },
    { provider: 'unsloth', name: 'Unsloth Studio', base: 'http://127.0.0.1:8888/v1' },
    { provider: 'custom', name: 'llama.cpp / LocalAI', base: 'http://127.0.0.1:8080/v1' },
    { provider: 'custom', name: 'Jan', base: 'http://127.0.0.1:1337/v1' },
    { provider: 'custom', name: 'vLLM', base: 'http://127.0.0.1:8000/v1' },
    { provider: 'custom', name: 'KoboldCpp', base: 'http://127.0.0.1:5001/v1' }
  ];
  function providerOf(p) { return PROVIDERS[p] || PROVIDERS[String(p || '').replace(/\d+$/, '')] || PROVIDERS.custom; }
  function presetOf(p) { return providerOf(p); }
  function kindOf(p) { return providerOf(p).kind; }
  // An endpoint id is its provider's id, or "custom2", "custom3"… for more custom servers.
  function endpointProvider(id) { return PROVIDERS[id] ? id : (/^custom\d+$/.test(id) ? 'custom' : ''); }

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
    path = path.replace(/\/(chat\/completions|completions|messages|models|responses|embeddings|chat)$/, '');
    // LM Studio's own API (/api/v1/chat, /api/v0/models…) is not the OpenAI-compatible one, which
    // lives at /v1 on the same port. Only on this computer / the LAN: OpenRouter's base is /api/v1.
    if (/^\/api\/v\d+(\/|$)/.test(path) && addressSpace(origin) !== 'public') path = '/v1';
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

  // ---- model references ------------------------------------------------------------------------
  // In the picker and per note: "<src>|<endpoint>|<model>" (src 'local' or a host's device id).
  // In prefs (readable): "<endpoint>:<model>" — the model id may itself hold ':' or '/'.
  function refKey(src, ep, model) { return String(src || 'local') + '|' + String(ep || '') + '|' + String(model || ''); }
  function parseRef(s) {
    s = String(s || '');
    var a = s.indexOf('|'), b = a < 0 ? -1 : s.indexOf('|', a + 1);
    if (a > 0 && b > a) return { src: s.slice(0, a), ep: s.slice(a + 1, b), model: s.slice(b + 1) };
    return null;
  }
  // "anthropic:claude-opus-5-5" → {ep, model}; a bare name → {ep: '', model}.
  function parsePrefModel(s) {
    s = String(s || '').trim();
    if (!s) return { ep: '', model: '' };
    var i = s.indexOf(':'), head = i > 0 ? s.slice(0, i) : '';
    if (head && endpointProvider(head)) return { ep: head, model: s.slice(i + 1) };
    return { ep: '', model: s };
  }

  // ---- adapters --------------------------------------------------------------------------------
  var ANTHROPIC_VERSION = '2026-10-21';
  // Models where Anthropic recommends server-side refusal fallbacks (fallbacks: "default").
  var ANTHROPIC_FALLBACK = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
  // o: { kind, apiKey, headers (extra), fallbackBeta }
  function headersFor(o, json) {
    var h = {};
    if (json) h['Content-Type'] = 'application/json';
    if (o && o.kind === 'anthropic') {
      if (o.apiKey) h['x-api-key'] = o.apiKey;
      h['anthropic-version'] = ANTHROPIC_VERSION;
      h['anthropic-dangerous-direct-browser-access'] = 'true';   // Anthropic's opt-in for CORS
      if (o.fallbackBeta) h['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    } else if (o && o.apiKey) h.Authorization = 'Bearer ' + o.apiKey;
    var x = (o && o.headers) || {};
    for (var k in x) if (x[k]) h[k] = x[k];
    return h;
  }
  // A provider's extra request headers (OpenRouter's app attribution).
  function providerHeaders(pid, origin) {
    return providerOf(pid).attribution ? { 'HTTP-Referer': origin || 'https://cadezawacki.github.io', 'X-Title': 'Cade.txt' } : {};
  }
  // o: { kind, base, apiKey, provider } → { url, headers }
  function modelsRequest(o) {
    var p = providerOf(o.provider);
    if (o.kind === 'ollama') return { url: o.base + '/api/tags', headers: headersFor(o, false) };
    if (o.kind === 'anthropic') return { url: o.base + '/models?limit=1000', headers: headersFor(o, false) };
    if (p.list === 'gemini') {
      // Gemini's own list says each model's context window; the OpenAI-compatible one doesn't
      var h = {};
      if (o.apiKey) h['x-goog-api-key'] = o.apiKey;
      return { url: o.base.replace(/\/openai$/, '') + '/models?pageSize=1000', headers: h };
    }
    return { url: o.base + '/models', headers: headersFor(o, false) };
  }
  function modelsUrl(kind, base) { return modelsRequest({ kind: kind, base: base }).url; }
  // Anthropic wants alternating user/assistant turns and no empty ones; the system prompt goes on top.
  function anthropicMessages(msgs) {
    var sys = [], out = [];
    msgs.forEach(function (m) {
      if (m.role === 'system') { if (m.content) sys.push(m.content); return; }
      if (!m.content) return;
      var last = out[out.length - 1];
      if (last && last.role === m.role) last.content += '\n\n' + m.content;
      else out.push({ role: m.role, content: m.content });
    });
    while (out.length && out[0].role !== 'user') out.shift();
    return { system: sys.join('\n\n'), messages: out };
  }
  // A streamed chat request → { url, init }.
  // o: { kind, provider, base, apiKey, headers, model, messages, temperature, maxTokens, numCtx, stream, fallbacks }
  function buildChat(o) {
    var stream = o.stream !== false, body, p = providerOf(o.provider);
    var msgs = (o.messages || []).map(function (m) { return { role: m.role, content: String(m.content == null ? '' : m.content) }; });
    if (o.kind === 'ollama') {
      var opt = {};
      if (isFinite(o.temperature)) opt.temperature = +o.temperature;
      if (o.maxTokens > 0) opt.num_predict = Math.floor(o.maxTokens);
      if (o.numCtx > 0) opt.num_ctx = Math.floor(o.numCtx);
      body = { model: o.model, messages: msgs, stream: stream, options: opt };
      return { url: o.base + '/api/chat', init: { method: 'POST', headers: headersFor(o, true), body: JSON.stringify(body) } };
    }
    if (o.kind === 'anthropic') {
      // API version 2026-10-21: max_tokens is required; temperature / top_p / top_k are gone (a 400).
      var am = anthropicMessages(msgs), fb = o.fallbacks !== false && ANTHROPIC_FALLBACK.indexOf(o.model) >= 0;
      body = { model: o.model, max_tokens: Math.floor(o.maxTokens > 0 ? o.maxTokens : 4096), messages: am.messages, stream: stream };
      if (am.system) body.system = am.system;
      if (fb) body.fallbacks = 'default';
      return { url: o.base + '/messages', fallbacks: fb,
        init: { method: 'POST', headers: headersFor({ kind: 'anthropic', apiKey: o.apiKey, headers: o.headers, fallbackBeta: fb }, true), body: JSON.stringify(body) } };
    }
    body = { model: o.model, messages: msgs, stream: stream };
    var fixed = p.fixedTemp && p.fixedTemp.test(String(o.model || ''));
    if (isFinite(o.temperature) && !fixed) body.temperature = p.tempMax ? Math.min(+o.temperature, p.tempMax) : +o.temperature;
    if (o.maxTokens > 0) body[p.tokensParam || 'max_tokens'] = Math.floor(o.maxTokens);
    if (stream && o.provider && o.provider !== 'custom' && o.provider !== 'lmstudio' && o.provider !== 'unsloth') body.stream_options = { include_usage: true };
    return { url: o.base + '/chat/completions', init: { method: 'POST', headers: headersFor(o, true), body: JSON.stringify(body) } };
  }
  var EMBED_RE = /embed|bge-|e5-|minilm|rerank/i;
  var NONCHAT_RE = /whisper|tts|dall-e|davinci|babbage|moderation|transcribe|realtime|audio|imagen|veo|aqa|sora|guard|-image|image-|:batch$|computer-use|search-preview|lyria/i;
  function num(v) { v = +v; return isFinite(v) && v > 0 ? v : 0; }
  // Server model list JSON → [{ id, name, ctx, out, price: {in, out} per 1M | null, params, quant, size, family, embed }],
  // chat models first. o: { kind, provider }
  function parseModels(o, j) {
    if (typeof o === 'string') o = { kind: o };
    var p = providerOf(o.provider), out = [];
    if (o.kind === 'ollama') {
      (j && Array.isArray(j.models) ? j.models : []).forEach(function (m) {
        if (!m) return;
        var id = String(m.name || m.model || '');
        if (!id) return;
        var d = m.details || {}, fam = String(d.family || '');
        out.push({ id: id, name: id, ctx: 0, out: 0, price: null, size: +m.size || 0, family: fam, params: String(d.parameter_size || ''), quant: String(d.quantization_level || ''),
          embed: EMBED_RE.test(id) || /bert/i.test(fam) });
      });
    } else if (p.list === 'gemini' && j && Array.isArray(j.models)) {
      j.models.forEach(function (m) {
        if (!m || !m.name) return;
        var id = String(m.name).replace(/^models\//, ''), meth = m.supportedGenerationMethods || [];
        out.push({ id: id, name: String(m.displayName || id), ctx: num(m.inputTokenLimit), out: num(m.outputTokenLimit), price: null, size: 0, family: '', params: '', quant: '',
          embed: EMBED_RE.test(id) || NONCHAT_RE.test(id) || (meth.length && meth.indexOf('generateContent') < 0) });
      });
    } else {
      var items = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : (j && Array.isArray(j.models) ? j.models : []));
      items.forEach(function (m) {
        var id = m && String(m.id || m.name || '').replace(/^models\//, '');
        if (!id) return;
        var price = null, pr = m.pricing;
        if (pr && pr.prompt != null) price = { in: (+pr.prompt || 0) * 1e6, out: (+pr.completion || 0) * 1e6 };       // OpenRouter: USD per token
        else if (pr && pr.input != null) price = { in: +pr.input || 0, out: +pr.output || 0 };                       // Together: USD per 1M
        if (price && (price.in < 0 || price.out < 0)) price = null;   // "-1" = variable price
        var ctx = num(m.context_length) || num(m.context_window) || num(m.max_context_length) || num(m.max_input_tokens) || (m.top_provider && num(m.top_provider.context_length)) || 0;
        var type = String(m.type || ''), arch = m.architecture || {}, outs = arch.output_modalities;
        var nonchat = NONCHAT_RE.test(id) || (type && type !== 'model' && ['chat', 'language', 'code'].indexOf(type) < 0) ||
          (m.capabilities && m.capabilities.completion_chat === false) || (Array.isArray(outs) && outs.indexOf('text') < 0);
        if (p.id === 'openai' && !/^(gpt-|o\d|chatgpt-)/.test(id)) nonchat = true;
        out.push({ id: id, name: String(m.display_name || (p.id === 'openrouter' ? m.name : '') || id), ctx: ctx, out: num(m.max_tokens) || (m.top_provider && num(m.top_provider.max_completion_tokens)) || 0,
          price: price, size: 0, family: '', params: '', quant: '', embed: EMBED_RE.test(id) || !!nonchat, idle: m.loaded === false });
      });
    }
    var seen = {};
    out = out.filter(function (m) { if (seen[m.id]) return false; seen[m.id] = 1; return true; });
    // Chat models first; among them, ones the server has in memory (Unsloth's `loaded`) first.
    out.sort(function (a, b) { return ((a.embed ? 2 : 0) + (a.idle ? 1 : 0)) - ((b.embed ? 2 : 0) + (b.idle ? 1 : 0)); });
    return out;
  }
  function chatModels(list) { return (list || []).filter(function (m) { return !m.embed; }); }
  // The model to use: the wanted one when the server has it (or the list is
  // unknown), else the provider's preferred one, else the first chat model.
  function pickModel(want, list, prefer) {
    var names = chatModels(list).map(function (m) { return m.id || m.name; });
    want = String(want || '').trim();
    if (want && (!list || !list.length)) return want;
    if (want) {
      if (names.indexOf(want) >= 0) return want;
      if (names.indexOf(want + ':latest') >= 0) return want + ':latest';
    }
    if (prefer && names.indexOf(prefer) >= 0) return prefer;
    return names[0] || want || '';
  }
  var STOP = { end_turn: 'stop', stop_sequence: 'stop', pause_turn: 'stop', tool_use: 'stop', max_tokens: 'length', refusal: 'refusal', length: 'length', stop: 'stop' };
  // One parsed stream object → what it carries.
  function readChunk(kind, o) {
    var r = { text: '', thinking: '', think: false, done: false, end: false, reason: '', usage: null, error: '', errorType: '', model: '' };
    if (!o || typeof o !== 'object') return r;
    if (kind === 'anthropic') {
      switch (o.type) {
        case 'error':
          r.error = String((o.error && o.error.message) || 'error'); r.errorType = String((o.error && o.error.type) || ''); break;
        case 'message_start':
          if (o.message) { r.model = String(o.message.model || ''); if (o.message.usage) r.usage = { prompt: +o.message.usage.input_tokens || 0, output: 0 }; }
          break;
        case 'content_block_start':
          var b = o.content_block || {};
          if (b.type === 'thinking' || b.type === 'redacted_thinking') { r.think = true; r.thinking = String(b.thinking || ''); }
          else if (b.type === 'text' && b.text) r.text = String(b.text);
          break;
        case 'content_block_delta':
          var d = o.delta || {};
          if (d.type === 'text_delta') r.text = String(d.text || '');
          else if (d.type === 'thinking_delta') { r.think = true; r.thinking = String(d.thinking || ''); }
          break;
        case 'message_delta':
          if (o.delta && o.delta.stop_reason) { r.done = true; r.reason = STOP[o.delta.stop_reason] || 'stop'; }
          if (o.usage) r.usage = { prompt: +o.usage.input_tokens || 0, output: +o.usage.output_tokens || 0 };
          break;
        case 'message_stop':
          r.end = true; break;
      }
      return r;
    }
    if (o.error) {
      r.error = typeof o.error === 'string' ? o.error : String(o.error.message || o.error.type || JSON.stringify(o.error));
      r.errorType = o.error && typeof o.error === 'object' ? String(o.error.type || o.error.code || '') : '';
      return r;
    }
    if (kind === 'ollama') {
      if (o.message) { r.text = String(o.message.content || ''); r.thinking = String(o.message.thinking || ''); r.think = !!r.thinking; }
      else if (typeof o.response === 'string') r.text = o.response;   // /api/generate
      if (o.done) {
        r.done = true; r.end = true;
        r.reason = STOP[o.done_reason] || 'stop';
        if (o.eval_count != null || o.prompt_eval_count != null) r.usage = { prompt: +o.prompt_eval_count || 0, output: +o.eval_count || 0 };
      }
      return r;
    }
    var c = o.choices && o.choices[0];
    if (c) {
      var dd = c.delta || c.message || {};
      r.text = String(dd.content || (typeof c.text === 'string' ? c.text : '') || '');
      r.thinking = String(dd.reasoning_content || dd.reasoning || '');
      r.think = !!r.thinking;
      if (c.finish_reason) { r.done = true; r.reason = STOP[c.finish_reason] || 'stop'; }
    }
    if (o.model) r.model = String(o.model);
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
      if (Array.isArray(j) && j[0]) j = j[0];   // Gemini wraps errors in a list
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
  var MODEL_RE = /model\b[^.]*\b(not found|does ?n[o']t exist|not (be )?loaded|unloaded|unknown|missing|try pulling|not available)|no models? (is |are )?loaded|unknown model|pull (it|the model)|model_not_found|failed to load model|not_found_error|^model: \S+$/i;
  var AUTH_RE = /api[ _-]?key|unauthori[sz]ed|authentication|no credentials|invalid (bearer|token)|permission[_ ]denied|unauthenticated/i;
  function classifyHttp(status, body) {
    var msg = errorMessage(body);
    if (CONTEXT_RE.test(msg)) return { code: 'context', detail: msg };
    if (status === 401 || status === 403 || (status === 400 && AUTH_RE.test(msg))) return { code: 'auth', detail: msg };
    if (status === 402 || /billing|credit balance|insufficient (credits|quota|balance)|payment/i.test(msg)) return { code: 'billing', detail: msg };
    if (MODEL_RE.test(msg)) return { code: 'model', detail: msg };
    if (status === 404) return { code: 'notfound', detail: msg };
    if (status === 413) return { code: 'too-big', detail: msg };
    if (status === 429 || status === 529 || (status === 503 && /busy|overload|queue/i.test(msg)) || /overloaded/i.test(msg)) return { code: 'busy', detail: msg };
    if (status === 400 && /\bmodel\b/i.test(msg)) return { code: 'model', detail: msg };
    return { code: 'server', detail: msg || ('HTTP ' + status) };
  }
  // A fetch that failed before any answer (TypeError) → what most likely happened.
  function refineNetwork(probe, env) {
    env = env || {};
    if (env.mixedBlocked) return 'mixed';
    if (env.lna === 'denied') return 'lna';
    if (probe === 'blocked') return 'cors';
    return 'unreachable';
  }
  function isAbort(e) { return !!e && (e.name === 'AbortError' || e.code === 20 || e.code === 'aborted'); }

  // ---- fix texts ---------------------------------------------------------------------------------
  // env: { provider, origin, os, browser, base, model, host, timeoutS, detail }
  // → { code, title, text, steps: [{t} | {cmd, label} | {link, label}], os: {mac,win,linux}: steps, osPick }
  function T(t) { return { t: t }; }
  function CMD(c, label) { return { cmd: c, label: label || '' }; }
  function LINK(u, label) { return { link: u, label: label }; }
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
    var p = env.provider || 'ollama', P = providerOf(p), origin = env.origin || 'https://cadezawacki.github.io';
    var where = env.host ? env.host : 'this computer', cloud = P.where === 'cloud';
    var o = { code: code, title: '', text: '', steps: [] };
    switch (code) {
      case 'cors':
        o.title = cloud ? P.label + ' didn’t let this page in (blocked by the browser)' : (p === 'ollama' ? 'Ollama' : p === 'lmstudio' ? 'LM Studio' : p === 'unsloth' ? 'Unsloth Studio' : 'The server') + ' is running, but it doesn’t let this page in yet';
        o.text = 'Model servers only answer web pages they’ve been told to trust (CORS). Allow ' + origin + ' once:';
        if (p === 'ollama') { o.os = ollamaCors(origin); o.osPick = osPick(env.os); o.steps = [T('Already set for something else? Separate several origins with commas.')]; }
        else if (p === 'lmstudio') o.steps = [T('In LM Studio open the Developer tab → Server settings → turn on “Enable CORS”. Keep the server Running, then Test again.'), T('Or start it from a terminal:'), CMD('lms server start --cors')];
        else if (p === 'unsloth') o.steps = [T('Started with “unsloth studio” in a terminal it lets every page in — the desktop app only trusts origins you list. Quit the app and run:'),
          CMD('unsloth studio'), T('Or keep the desktop app and allow this page before launching it:'), CMD('UNSLOTH_CORS_ORIGINS=' + origin)];
        else if (cloud) { o.text = ''; o.steps = [T(P.label + ' normally answers browsers — a privacy extension or a company proxy may be blocking it. Try again, or from another browser.')]; }
        else o.steps = [T('Allow the origin ' + origin + ' in your server’s CORS settings, then Test again.'),
          T('llama.cpp (llama-server) and Jan allow every origin by default; vLLM: --allowed-origins \'["' + origin + '"]\'; LocalAI: set CORS=true.')];
        break;
      case 'unreachable':
        o.title = cloud ? P.label + ' can’t be reached' : 'Nothing is answering at ' + (env.base || 'that address');
        if (cloud) o.steps = [T('Check the internet connection. If the address was changed, set it back to ' + P.url + '.')];
        else if (p === 'ollama') o.steps = [T('Is Ollama running? Open the Ollama app, or run:'), CMD('ollama serve'), T('Not installed yet? Get it from ollama.com, then download a model:'), CMD('ollama pull llama3.2')];
        else if (p === 'lmstudio') o.steps = [T('Open LM Studio → Developer tab → switch the server on (Status: Running). It listens on port 1234 unless you changed it; load a model too.')];
        else if (p === 'unsloth') o.steps = [T('Start Unsloth Studio — it listens on port 8888 (pick another with -p 9000, then change the address here to match):'), CMD('unsloth studio'),
          T('Then load a model from “Select model” on its Chat page.')];
        else o.steps = [T('Start your server and check the address and port — OpenAI-compatible servers usually end in /v1 (e.g. http://127.0.0.1:8080/v1).')];
        if (env.base && addressSpace(env.base) === 'public' && isHttp(env.base) && /^https:/.test(origin)) o.steps.push(T('Browsers block plain http:// addresses on the internet from this secure page — use https://, or run the server on this computer.'));
        if (!cloud && (env.browser === 'chrome' || env.browser === 'edge')) o.steps.push(T('If the browser asked to let this site reach “apps on this device” or your “local network”, allow it (site settings, left of the address bar).'));
        break;
      case 'mixed':
        o.title = 'Safari can’t reach a model on this computer';
        o.text = 'Safari blocks secure pages from talking to http://localhost (WebKit bug 171934), so it can’t run the model connection here.';
        o.steps = [T('Open txt in Chrome, Edge or Firefox on this computer and set AI up there with “This device” and “Share with my other devices”.'),
          T('Then choose “Another of my devices” here — Safari on this Mac and on your iPhone use the model through Sync.'),
          T('Cloud services (OpenAI, Anthropic, …) work in Safari too.')];
        break;
      case 'lna':
        o.title = 'Your browser is blocking this page from apps on this computer';
        o.steps = [T(env.browser === 'firefox' ? 'Click the permissions icon in the address bar and allow access to apps on this device.' :
          'Click the site settings icon left of the address bar → allow “Apps on device” (or “Local network access”) for this site.'), T('Then Test again.')];
        break;
      case 'model':
        o.title = 'The model ' + (env.model ? '“' + env.model + '” ' : '') + 'isn’t available ' + (cloud ? 'from ' + P.label : 'on ' + where);
        o.steps = [T('Pick another model' + (p === 'ollama' ? ', or install this one:' : '.'))];
        if (p === 'ollama') o.steps.push(CMD('ollama pull ' + (env.model || 'llama3.2')));
        else if (p === 'lmstudio') o.steps.push(T('Load it in LM Studio (or turn on “Just-in-time model loading” in the Developer settings).'));
        else if (p === 'unsloth') o.steps.push(T('Load it in Unsloth Studio from “Select model” on the Chat page — only loaded models answer.'));
        break;
      case 'context':
        o.title = 'That’s more text than the model can read at once';
        o.steps = [T('Use a smaller context (a Selection instead of the whole note), or Clear the conversation.'),
          T('Or raise “Context window” in AI preferences — bigger windows need more memory.')];
        break;
      case 'auth':
        o.title = cloud ? P.label + ' didn’t accept the API key' : 'The server wants an API key';
        o.steps = [T('Check the key in Setup → ' + P.label + '. It stays on this device only, never synced.')];
        if (p === 'unsloth') o.steps.push(T('Use the sk-unsloth-… key Unsloth Studio printed when it started (or make one in its Settings → API keys). Or turn on keyless API access for inference in its Settings.'));
        if (P.keyUrl) o.steps.push(LINK(P.keyUrl, 'Get a key at ' + hostOf(P.keyUrl)));
        break;
      case 'key-missing':
        o.title = P.label + ' needs an API key';
        o.steps = [T('Paste your key in Setup → ' + P.label + '. It stays on this device only, never synced.')];
        if (P.keyUrl) o.steps.push(LINK(P.keyUrl, 'Get a key at ' + hostOf(P.keyUrl)));
        break;
      case 'billing':
        o.title = P.label + ' says there’s a billing problem with the account';
        o.steps = [T('Check the account’s credits or payment method' + (P.keyUrl ? ' at ' + hostOf(P.keyUrl) : '') + '.')];
        break;
      case 'notfound':
        o.title = 'The server answered, but not where expected';
        o.steps = [T('Check the service type and the address — OpenAI-compatible addresses usually end in /v1.')];
        break;
      case 'busy':
        o.title = (env.host ? env.host : cloud ? P.label : 'The model') + ' is busy or rate-limited';
        o.steps = [T('Try again in a moment.')];
        break;
      case 'refusal':
        o.title = 'The model declined this request';
        o.steps = [T('Try rewording it, or switch to another model with ▾.')];
        break;
      case 'timeout':
        o.title = 'No answer for ' + (env.timeoutS || 120) + ' s';
        o.steps = [T('The model may still be loading (the first answer can take a minute), or ' + where + ' is busy or asleep. Try again, or raise “Give up after” in AI preferences.')];
        break;
      case 'host-offline':
        o.title = 'None of your devices is sharing a model right now';
        o.steps = [T('On the computer with the models: open txt in Chrome, Edge or Firefox → AI → This device → turn on “Share with my other devices”.'),
          T('Leave that txt tab open (it can be in the background) and keep the computer awake.')];
        break;
      case 'host-silent':
        o.title = where + ' didn’t pick up the question';
        o.steps = [T('Its txt tab may be closed or the computer asleep. Open txt there (and keep the tab open), then try again.')];
        break;
      case 'host-unready':
        o.title = where + ' is sharing, but its model service isn’t answering';
        o.steps = [T('On ' + where + ': is Ollama / LM Studio running, is the API key right? Open AI there to check the connection.')];
        break;
      case 'host-stopped':
        o.title = where + ' stopped sharing';
        o.steps = [T('Sharing was turned off or its txt tab closed.')];
        break;
      case 'not-shared':
        o.title = where + ' doesn’t share ' + (env.model ? '“' + env.model + '”' : 'that model');
        o.steps = [T('Pick one of the models listed under ' + where + ' with ▾. Cloud services are shared only when “Share cloud services too” is on there.')];
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
        o.title = (cloud ? P.label : 'The model server') + ' reported a problem';
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
  // LAN addresses need targetAddressSpace in Chromium to pass mixed-content checks.
  function netInit(url, init, makeRequest) {
    if (addressSpace(url) === 'local' && makeRequest) {
      try { makeRequest(url, { targetAddressSpace: 'local' }); init.targetAddressSpace = 'local'; } catch (e) {}
    }
    return init;
  }
  function needsKey(o) { var p = providerOf(o.provider); return p.key === 'required' && !o.apiKey; }
  // o: { kind, provider, base, apiKey, signal, timeoutMs, Request } → Promise<{ models, ms }>
  function listModels(fetchImpl, o) {
    if (needsKey(o) && o.provider !== 'openrouter') return Promise.reject(AiError('key-missing', 'No API key'));
    var w = watchdog(o.signal, o.timeoutMs || 8000), t0 = nowMs(), rq = modelsRequest(o);
    return fetchImpl(rq.url, netInit(rq.url, { method: 'GET', headers: rq.headers, signal: w.signal, cache: 'no-store' }, o.Request)).then(function (res) {
      return res.text().then(function (body) {
        if (!res.ok) { var c = classifyHttp(res.status, body); throw AiError(c.code, c.detail, { status: res.status, detail: c.detail }); }
        var j;
        try { j = JSON.parse(body); } catch (e) { throw AiError('notfound', 'Not a model list', { status: res.status }); }
        var okShape = o.kind === 'ollama' ? Array.isArray(j && j.models) : (Array.isArray(j) || (j && (Array.isArray(j.data) || Array.isArray(j.models))));
        if (!okShape) throw AiError('notfound', 'Not a model list', { status: res.status });
        return { models: parseModels(o, j), ms: Math.round(nowMs() - t0) };
      });
    }).then(function (r) { w.done(); return r; }, function (e) { w.done(); throw failFrom(e, w); });
  }
  // Streams one chat answer.
  // o: { kind, provider, base, apiKey, headers, model, messages, temperature, maxTokens, numCtx, signal,
  //      timeoutMs, firstTimeoutMs, onDelta(text, full), onThinking(text), Request, fallbacks }
  // → Promise<{ text, thinking, reason, usage, model, ms, firstMs }>; rejects AiError (err.partial).
  function chatStream(fetchImpl, o) {
    if (needsKey(o)) return Promise.reject(AiError('key-missing', 'No API key'));
    return chatOnce(fetchImpl, o).catch(function (e) {
      // an account without the fallback beta: the same question once more without it
      if (e && e.noFallback) return chatOnce(fetchImpl, Object.assign({}, o, { fallbacks: false }));
      throw e;
    });
  }
  function chatOnce(fetchImpl, o) {
    var w = watchdog(o.signal, o.timeoutMs || 120000, o.firstTimeoutMs || o.timeoutMs || 120000);
    var rq = buildChat(o), t0 = nowMs(), text = '', thinking = '', reason = '', usage = null, firstMs = 0, err = null, done = false, model = '';
    function take(obj) {
      if (done) return;
      var c = readChunk(o.kind, obj);
      if (c.error) {
        var k = /overloaded|rate_limit/.test(c.errorType) ? { code: 'busy' } : classifyHttp(200, JSON.stringify({ error: c.error }));
        err = AiError(k.code, c.error, { detail: c.error });
        return;
      }
      if (c.model && !model) model = c.model;
      if (c.think || c.thinking) { thinking += c.thinking; if (o.onThinking) o.onThinking(c.thinking); }
      if (c.text) {
        if (!firstMs) firstMs = Math.round(nowMs() - t0);
        text += c.text;
        if (o.onDelta) o.onDelta(c.text, text);
      }
      if (c.usage) usage = c.usage;
      if (c.done) reason = c.reason || 'stop';
      if (c.end) done = true;
    }
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
      if (!res.ok) return res.text().then(function (body) {
        var c = classifyHttp(res.status, body);
        throw AiError(c.code, c.detail, { status: res.status, detail: c.detail, noFallback: !!(rq.fallbacks && res.status === 400 && /anthropic-beta|fallback/i.test(body)) });
      });
      var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      var parser = parserFor(ct);
      if (!parser || !res.body || !res.body.getReader) {
        return res.text().then(function (body) {
          w.kick();
          if (parser) { parser.push(body); parser.end(); return; }
          var j;
          try { j = JSON.parse(body); } catch (e) { throw AiError('bad', 'Unreadable answer'); }
          if (o.kind === 'anthropic' && Array.isArray(j.content)) {
            j.content.forEach(function (b) { if (b && b.type === 'text') take({ type: 'content_block_delta', delta: { type: 'text_delta', text: b.text } }); });
            take({ type: 'message_delta', delta: { stop_reason: j.stop_reason }, usage: j.usage });
          } else take(j);
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
      return { text: text, thinking: thinking, reason: reason || 'stop', usage: usage, model: model || o.model, ms: Math.round(nowMs() - t0), firstMs: firstMs };
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
      return fetchImpl(url, netInit(url, Object.assign({ method: 'GET', headers: o.headers || {}, signal: w.signal, cache: 'no-store' }, init), o.Request))
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

  // ---- badges ------------------------------------------------------------------------------------
  // Sources (all keyless, CORS-open, checked 2026-10-22):
  //   prices + context: OpenRouter's public model list (https://openrouter.ai/api/v1/models), USD per token
  //   score: LMArena's text leaderboard, "overall" category — the CC BY 4.0 dataset
  //          lmarena-ai/leaderboard-dataset (config "text", split "latest") read through the
  //          Hugging Face datasets server; ai-scores.js holds a dated snapshot for offline use.
  var SOURCES = {
    catalog: 'https://openrouter.ai/api/v1/models',
    scores: 'https://datasets-server.huggingface.co/filter?dataset=lmarena-ai/leaderboard-dataset&config=text&split=latest&where=%22category%22%3D%27overall%27&length=100&offset=',
    scoresPage: 'https://lmarena.ai/leaderboard/text',
    scoresLicence: 'CC BY 4.0'
  };
  // One spelling for a model name across sources: "anthropic/claude-opus-5.5", "claude-opus-5-5",
  // "Claude Opus 5.5 (High)" and "claude-opus-4-5-20251101" vs "Claude Opus 4.5 (20251101)" all meet.
  function normName(s) {
    s = String(s || '').toLowerCase().trim();
    s = s.replace(/^.*\//, '')
      .replace(/:(free|latest|beta|extended|nitro|floor|thinking|online|batch|exacto)$/, '')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[-_ ]+(\d{8}|\d{4}-\d{2}-\d{2})(?=$|[-_ :])/g, '')
      .replace(/[-_ ](instruct|it)(?=$|[-_ :])/g, '')
      .replace(/[-_ ]q\d[\w]*$/, '')
      .replace(/([a-z])(\d)/g, '$1-$2')
      .replace(/(\d)([a-z])/g, '$1-$2')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s;
  }
  function variantOf(name) { var m = /\(([^)]*)\)/.exec(String(name || '')); return m ? m[1] : ''; }
  // LMArena rows ([{model_name, rating, ...}] or snapshot [[name, rating], …]) → { date, byKey: {key: {r, n}} }.
  // Several entries can share a base name ("Claude Opus 5 (Max)", "(High)"): the plain one wins,
  // else the best — the tooltip always names the entry that was used.
  function scoreIndex(rows, date) {
    var byKey = {};
    (rows || []).forEach(function (x) {
      var name = Array.isArray(x) ? x[0] : x && x.model_name, rating = Array.isArray(x) ? x[1] : x && x.rating;
      if (!name || !isFinite(+rating)) return;
      var k = normName(name), plain = !variantOf(name), cur = byKey[k];
      var e = { r: Math.round(+rating), n: String(name), plain: plain };
      if (!cur || (plain && !cur.plain) || (plain === cur.plain && e.r > cur.r)) byKey[k] = e;
      if (!date && x && x.leaderboard_publish_date) date = x.leaderboard_publish_date;
    });
    return { date: date || '', byKey: byKey, count: Object.keys(byKey).length };
  }
  // OpenRouter's list → { at, byKey: {"vendor/key": {id, name, ctx, in, out}} } (prices per 1M tokens).
  function catalogIndex(j, at) {
    var byKey = {};
    parseModels({ kind: 'openai', provider: 'openrouter' }, j).forEach(function (m) {
      if (!m.price || /:/.test(m.id)) return;   // ":free" / ":batch" variants don't price the vendor's API
      var vendor = m.id.split('/')[0];
      byKey[vendor + '/' + normName(m.id)] = { id: m.id, name: m.name, ctx: m.ctx, in: m.price.in, out: m.price.out };
    });
    return { at: at || 0, byKey: byKey, count: Object.keys(byKey).length };
  }
  // Fill in where / price / context / score on a provider's model list. ctx: { catalog, scores }
  function enrich(list, pid, ctx) {
    ctx = ctx || {};
    var P = providerOf(pid), cat = ctx.catalog, sc = ctx.scores;
    return (list || []).map(function (m0) {
      var m = {};
      for (var k in m0) m[k] = m0[k];
      m.where = P.where;
      if (P.where === 'local') { m.price = { in: 0, out: 0 }; m.priceSrc = 'local'; }
      else if (m.price) m.priceSrc = P.id;
      else if (P.vendor && cat && cat.byKey) {
        var c = cat.byKey[P.vendor + '/' + normName(m.id)];
        if (c) { m.price = { in: c.in, out: c.out }; m.priceSrc = 'openrouter'; if (!m.ctx) m.ctx = c.ctx; }
      }
      if (sc && sc.byKey) {
        var key = normName(m.id), s;
        // an Ollama name without a size tag ("deepseek-r1", ":latest") is some small default
        // build, not the model the leaderboard scored — match it only with its size
        if (P.kind === 'ollama' && !/:(?!latest$)[^:]+$/.test(m.id)) {
          var b = /^([\d.]+)\s*B$/i.exec(m.params || '');
          s = b ? sc.byKey[normName(m.id.replace(/:latest$/, '')) + '-' + Math.floor(+b[1]) + '-b'] : null;
        } else s = sc.byKey[key] || (m.name && m.name !== m.id ? sc.byKey[normName(m.name.replace(/^[^:]*:\s*/, ''))] : null);
        if (s) m.score = { r: s.r, n: s.n, date: sc.date };
      }
      return m;
    });
  }
  function fmtNum(n) {
    if (n >= 100) return String(Math.round(n));
    if (n >= 1) return String(Math.round(n * 100) / 100);
    if (n >= 0.01) return String(Math.round(n * 1000) / 1000);
    return String(+n.toPrecision(2));
  }
  function fmtPrice(p) { if (!p) return ''; return (p.in === 0 && p.out === 0) ? 'Free' : '$' + fmtNum(p.in) + ' · $' + fmtNum(p.out); }
  function fmtCtx(n) {
    n = +n || 0;
    if (!n) return '';
    if (n >= 1e6 - 1e5) return (Math.round(n / 1e5) / 10).toString().replace(/\.0$/, '') + 'M';
    return Math.round(n / 1000) + 'K';
  }
  // The badges a model shows: [{ k, t (text), title (tooltip) }].
  function badges(m, o) {
    o = o || {};
    var out = [];
    if (m.where) out.push({ k: m.where, t: m.where === 'local' ? 'Local' : 'Cloud',
      title: m.where === 'local' ? 'Runs on your own hardware — free, nothing leaves it' : 'A cloud API — billed to the API key on the device that runs it' });
    if (m.where === 'local' && (m.params || m.quant || m.size)) out.push({ k: 'size', t: [m.params, m.quant ? m.quant.replace(/_K.*$/, '') : ''].filter(Boolean).join(' ') || fmtBytesShort(m.size),
      title: [m.params ? m.params + ' parameters' : '', m.quant ? 'quantised ' + m.quant : '', m.size ? fmtBytesShort(m.size) + ' on disk' : ''].filter(Boolean).join(', ') });
    if (m.price && m.where === 'cloud') out.push({ k: 'price', t: fmtPrice(m.price),
      title: (m.price.in === 0 && m.price.out === 0 ? 'Free to use' : 'Price per million tokens: $' + fmtNum(m.price.in) + ' in, $' + fmtNum(m.price.out) + ' out') +
        (m.priceSrc === 'openrouter' ? ' — OpenRouter’s public model list' + (o.catalogDate ? ', ' + o.catalogDate : '') + ' (the vendor’s own API price)' : ' — from ' + providerOf(m.priceSrc).label) });
    if (m.idle) out.push({ k: 'idle', t: 'Not loaded', title: 'Available on the server but not in memory — load it there first (Unsloth Studio: “Select model” on the Chat page)' });
    if (m.ctx) out.push({ k: 'ctx', t: fmtCtx(m.ctx), title: 'Context window: ' + Number(m.ctx).toLocaleString('en-US') + ' tokens it can read at once' });
    if (m.score) out.push({ k: 'score', t: '★' + m.score.r,
      title: 'LMArena text score ' + m.score.r + ' (“' + m.score.n + '”), higher is better' + (m.score.date ? ' — as of ' + m.score.date : '') + '. lmarena.ai, ' + SOURCES.scoresLicence });
    return out;
  }
  function fmtBytesShort(n) { n = +n || 0; return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? Math.round(n / 1e6) + ' MB' : ''; }

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
  // Tokens available for system + history + question. p: { contextWindow, maxTokens, modelCtx }
  function budget(p) {
    var ctx = p && p.contextWindow > 0 ? p.contextWindow : (p && p.modelCtx > 0 ? Math.min(p.modelCtx, 200000) : 4096);
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
    V: 2, KIND: 'ai',
    BATCH_MS: 150,            // the host gathers answer text this long per write
    CHUNK_MAX: 6000,          // characters per written piece
    REQ_MAX: 240000,          // characters of messages a host accepts
    RESP_MAX: 120000,         // characters of answer a host sends at most
    QUEUE_MAX: 3,             // questions waiting behind the running one
    MAX_TOKENS: 32768,
    PRESENCE_MODELS: 150,     // models listed per shared provider (an allow-list picks which)
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
  // A question as the asker sends it — no key, no address: just which shared model and the text.
  function makeRequest(o) {
    return {
      v: RELAY.V, id: o.id, f: o.from, n: String(o.name || '').slice(0, 60), k: o.kind || '', d: o.did || '',
      p: String(o.provider || '').slice(0, 40), model: String(o.model || '').slice(0, 240),
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
      provider: typeof o.p === 'string' && /^[a-z0-9-]{1,40}$/.test(o.p) ? o.p : '',
      model: typeof o.model === 'string' ? o.model.slice(0, 240) : '',
      messages: msgs,
      temperature: clampNum(opt.temperature, 0, 2, 0.7),
      maxTokens: Math.round(clampNum(opt.maxTokens, 1, RELAY.MAX_TOKENS, 1024))
    } };
  }
  // ---- what a host shares ----
  // cfg: { endpoints: [{ id, provider, label, where, ok, on, models: [enriched], allow: [ids] | null }],
  //        shareCloud, defaultModel: {ep, model} | null }
  function sharedEndpoints(cfg) {
    return (cfg.endpoints || []).filter(function (e) { return e && e.on !== false && (e.where !== 'cloud' || cfg.shareCloud); });
  }
  function sharedModels(e) {
    var list = chatModels(e.models || []);
    if (e.allow && e.allow.length) list = list.filter(function (m) { return e.allow.indexOf(m.id) >= 0; });
    return list;
  }
  // The presence payload body: names and metadata only.
  function buildPresence(cfg) {
    var prov = sharedEndpoints(cfg).map(function (e) {
      var list = sharedModels(e), cap = RELAY.PRESENCE_MODELS;
      return {
        id: e.id, l: String(e.label || providerOf(e.provider).label), w: e.where === 'cloud' ? 'cloud' : 'local', ok: e.ok !== false,
        m: list.slice(0, cap).map(function (m) {
          var x = { i: m.id };
          if (m.name && m.name !== m.id) x.n = m.name;
          if (m.ctx) x.c = m.ctx;
          if (m.price) x.p = [m.price.in, m.price.out];
          if (m.priceSrc === 'openrouter') x.ps = 1;
          if (m.score) x.s = [m.score.r, m.score.n];
          if (m.params) x.z = m.params;
          if (m.quant) x.qt = m.quant;
          if (m.size) x.b = m.size;
          if (m.idle) x.u = 1;
          return x;
        }),
        more: Math.max(0, list.length - cap)
      };
    });
    var dm = cfg.defaultModel && cfg.defaultModel.ep ? cfg.defaultModel.ep + ':' + cfg.defaultModel.model : '';
    return { prov: prov, dm: dm, sd: (cfg.scoresDate || ''), cd: (cfg.catalogDate || '') };
  }
  // Does this host share provider pid / model? → { ok, ep, model } | { ok: false, code, msg }
  function resolveShared(cfg, pid, model) {
    var eps = sharedEndpoints(cfg), ep = null;
    if (pid) ep = eps.filter(function (e) { return e.id === pid; })[0] || null;
    else if (model) ep = eps.filter(function (e) { return sharedModels(e).some(function (m) { return m.id === model; }); })[0] || null;
    else ep = eps[0] || null;
    if (!ep) return { ok: false, code: 'not-shared', msg: (pid || 'That service') + ' is not shared' };
    var list = sharedModels(ep), ids = list.map(function (m) { return m.id; });
    if (!model) model = (cfg.defaultModel && cfg.defaultModel.ep === ep.id && ids.indexOf(cfg.defaultModel.model) >= 0) ? cfg.defaultModel.model : pickModel('', list, providerOf(ep.provider).prefer);
    if (!model) return { ok: false, code: 'model', msg: 'No model' };
    if (ep.allow && ep.allow.length && ep.allow.indexOf(model) < 0) return { ok: false, code: 'not-shared', msg: model + ' is not shared' };
    if ((ep.models || []).length && ids.indexOf(model) < 0) return { ok: false, code: 'model', msg: model + ' is not available' };
    return { ok: true, ep: ep, model: model };
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
  // Presence entries already unsealed → online hosts, newest first, one per device.
  // decoded: [{ inst, at, o, b }]
  function parsePresence(decoded, now, myDid, staleMs) {
    var by = {};
    (decoded || []).forEach(function (e) {
      var o = e && e.o;
      if (!o || typeof o !== 'object') return;
      var at = +e.at || 0;
      if (!at || now - at > (staleMs || RELAY.STALE_MS)) return;
      var did = String(o.d || e.inst);
      if (myDid && did === myDid) return;
      var b = e.b && typeof e.b === 'object' ? e.b : {};
      var providers = (Array.isArray(o.prov) ? o.prov : []).filter(function (p) { return p && typeof p.id === 'string'; }).map(function (p) {
        return {
          id: p.id, label: String(p.l || p.id), where: p.w === 'cloud' ? 'cloud' : 'local', ok: p.ok !== false, more: +p.more || 0,
          models: (Array.isArray(p.m) ? p.m : []).filter(function (m) { return m && typeof m.i === 'string'; }).map(function (m) {
            return { id: m.i, name: String(m.n || m.i), ctx: +m.c || 0, price: Array.isArray(m.p) ? { in: +m.p[0] || 0, out: +m.p[1] || 0 } : null,
              priceSrc: m.ps ? 'openrouter' : (p.w === 'cloud' ? p.id : 'local'), score: Array.isArray(m.s) ? { r: +m.s[0], n: String(m.s[1] || ''), date: String(o.sd || '') } : null,
              params: String(m.z || ''), quant: String(m.qt || ''), size: +m.b || 0, where: p.w === 'cloud' ? 'cloud' : 'local', embed: false, idle: m.u === 1 };
          })
        };
      });
      if (!o.prov && Array.isArray(o.m)) providers = [{ id: o.pv || 'ollama', label: 'Models', where: 'local', ok: o.ok !== false, more: 0,   // round-1 hosts
        models: o.m.filter(function (x) { return typeof x === 'string'; }).map(function (x) { return { id: x, name: x, ctx: 0, price: null, score: null, params: '', quant: '', size: 0, where: 'local', embed: false }; }) }];
      var h = {
        inst: e.inst, did: did, name: String(o.n || 'Device').slice(0, 60), kind: String(o.k || 'desktop'),
        providers: providers, dm: String(o.dm || ''), scoresDate: String(o.sd || ''), catalogDate: String(o.cd || ''),
        busy: !!(b.busy || o.busy), queue: +(b.q || o.q) || 0, policy: o.pol === 'ask' ? 'ask' : 'auto',
        ok: o.ok !== false && providers.some(function (p) { return p.ok && p.models.length; }), v: +o.v || 1, at: at, age: Math.max(0, now - at)
      };
      h.models = [];
      providers.forEach(function (p) { p.models.forEach(function (m) { h.models.push(m.id); }); });
      if (!by[did] || by[did].at < at) by[did] = h;
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.at - a.at; });
  }
  // A host for a device id (or any), and one that offers ep / model when given.
  function pickHost(hosts, want, ep, model) {
    if (!hosts || !hosts.length) return null;
    function offers(h) {
      if (!ep && !model) return true;
      return h.providers.some(function (p) { return (!ep || p.id === ep) && (!model || p.models.some(function (m) { return m.id === model; })); });
    }
    if (want) for (var i = 0; i < hosts.length; i++) if ((hosts[i].did === want || hosts[i].inst === want) && offers(hosts[i])) return hosts[i];
    var cand = hosts.filter(offers), ok = cand.filter(function (h) { return h.ok; });
    return (ok.length ? ok : cand)[0] || (ep || model ? null : hosts[0]);
  }
  // The model a host answers with when the asker names none: its default, else its first shared one.
  function hostDefault(h) {
    if (!h) return null;
    var d = parsePrefModel(h.dm);
    if (d.ep) for (var i = 0; i < h.providers.length; i++) {
      var p = h.providers[i];
      if (p.id === d.ep && p.models.some(function (m) { return m.id === d.model; })) return { ep: p.id, model: d.model };
    }
    for (var j = 0; j < h.providers.length; j++) if (h.providers[j].ok && h.providers[j].models.length) return { ep: h.providers[j].id, model: pickModel('', h.providers[j].models, providerOf(h.providers[j].id).prefer) };
    return null;
  }

  // The device that runs the models. d: {
  //   cloud: { ref(sub) → Promise<ref|null>, seal(o) → Promise<str>, unseal(s) → Promise<o|null>, ts() (server timestamp), now() },
  //   device() → { inst, name, kind, id }, info() → presence body (buildPresence) + { ok },
  //   resolve(req) → { ok, ep, model, maxTokens } | { ok: false, code, msg },
  //   policy() → 'auto' | 'ask', ask(job) → Promise<bool>,
  //   run(job, { signal, model(name), onDelta(text), onThinking() }) → Promise<{ reason, usage, model }>,
  //   onChange(status), timers, limits }
  function createRelayHost(d) {
    var L = Object.assign({}, RELAY, d.limits || {}), tm = d.timers || { setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval };
    var C = d.cloud;
    var on = false, gen = 0, presRef = null, lastPres = '', lastBusy = '', beat = null, offs = [], jobs = {}, queue = [], running = null, served = 0, lastGc = 0;
    function me() { return d.device(); }
    function status() {
      return { online: on && !!presRef, busy: !!running, queued: queue.length, served: served,
        current: running ? { name: running.req.name, model: running.model || running.req.model, provider: running.target ? running.target.ep.id : '', since: running.started } : null };
    }
    function changed() { if (d.onChange) try { d.onChange(status()); } catch (e) {} }
    function presence() {
      var i = d.info ? d.info() : {}, m = me(), p = { v: L.V, n: m.name, k: m.kind, d: m.id, pol: d.policy ? d.policy() : 'auto', ok: i.ok !== false };
      for (var k in i) if (k !== 'ok') p[k] = i[k];
      return p;
    }
    function announce(force) {
      if (!on) return Promise.resolve(false);
      var p = presence(), key = JSON.stringify(p), g = gen;
      if (!force && key === lastPres && presRef) return Promise.resolve(true);
      lastPres = key; lastBusy = '';
      return (presRef ? Promise.resolve(presRef) : C.ref('hosts/' + me().inst)).then(function (r) {
        if (!r || !on || g !== gen) return false;
        presRef = r;
        return C.seal(p).then(function (s) {
          if (!on || g !== gen) return false;
          try { r.onDisconnect().remove(); } catch (e) {}
          return Promise.resolve(r.set({ s: s, at: C.ts() })).then(function () { return busyNote(); }).then(function () { return true; });
        });
      }).catch(function () { return false; });
    }
    // busy / queue in a node of their own, so a question doesn't rewrite the (big) presence
    function busyNote() {
      var b = { busy: !!running, q: queue.length }, key = JSON.stringify(b), r = presRef, g = gen;
      if (!r || key === lastBusy) return Promise.resolve();
      lastBusy = key;
      return C.seal(b).then(function (s) { if (on && g === gen) return r.child('b').set(s); }).catch(function () {});
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
        var job = { id: id, from: from, seq: 0, req: chk.req, state: 'new', cancelled: false, ctl: null, model: '', started: 0, target: null };
        job.res = C.ref('res/' + from + '/' + id);
        jobs[id] = job;
        if (!chk.ok) { delete jobs[id]; fail(job, chk.code, chk.msg); return; }
        // only what this host shares, checked against its own configuration
        var t = d.resolve ? d.resolve(chk.req) : { ok: true };
        if (!t || !t.ok) { delete jobs[id]; fail(job, (t && t.code) || 'not-shared', (t && t.msg) || 'Not shared'); return; }
        job.target = t;
        if ((running ? 1 : 0) + queue.length >= 1 + L.QUEUE_MAX) { delete jobs[id]; fail(job, 'busy', 'Too many questions waiting'); return; }
        if (d.policy && d.policy() === 'ask' && d.ask) {
          job.state = 'asking';
          reply(job, { t: 'w' });
          var decided = false, tt = tm.setTimeout(function () { decide(false); }, L.ASK_MS);
          var decide = function (yes) {
            if (decided) return;
            decided = true; tm.clearTimeout(tt);
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
      busyNote();
      changed();
      pump();
    }
    function pump() {
      if (!on || running || !queue.length) return;
      var job = queue.shift();
      running = job;
      job.state = 'running'; job.started = Date.now();
      positions();
      busyNote();
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
          model: function (m) { job.model = m; reply(job, { t: 's', model: m, p: job.target && job.target.ep ? job.target.ep.id : '' }); },
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
        busyNote();
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
          busyNote();
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
    // The server removes the entry when the connection drops (laptop asleep): put it back.
    function watchSelf() {
      var r = presRef, g = gen;
      if (!r) return;
      var h = r.on('value', function (snap) {
        if (!on || g !== gen) return;
        var v = snap.val();
        if (!v || typeof v.s !== 'string') announce(true);
      });
      offs.push(function () { try { r.off('value', h); } catch (e) {} });
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
      on = true; gen++; lastPres = ''; lastBusy = '';
      var m = me();
      return announce(true).then(function (ok) {
        if (!ok || !on) { if (on) { on = false; presRef = null; } return false; }
        beat = tm.setInterval(function () { if (presRef) Promise.resolve(presRef.child('at').set(C.ts())).catch(function () {}); }, L.BEAT_MS);
        watchSelf();
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
      var r = presRef; presRef = null; lastPres = ''; lastBusy = '';
      changed();
      if (!r) return Promise.resolve();
      try { r.onDisconnect().cancel(); } catch (e) {}
      return Promise.resolve(r.remove()).catch(function () {});
    }
    return { start: start, stop: stop, refresh: function () { return announce(); }, status: status, _gc: gc };
  }

  // The asking side. d: { cloud (as above), device(), limits, timers }. It only ever
  // touches the cloud channel — there is no fetch here.
  function createRelayClient(d) {
    var L = Object.assign({}, RELAY, d.limits || {}), C = d.cloud, tm = d.timers || { setTimeout: setTimeout, clearTimeout: clearTimeout };
    var active = [];
    function me() { return d.device(); }
    function decode(v) {
      var keys = Object.keys(v || {});
      return Promise.all(keys.map(function (inst) {
        var e = v[inst];
        if (!e || typeof e.s !== 'string') return null;
        return Promise.all([C.unseal(e.s), typeof e.b === 'string' ? C.unseal(e.b) : null]).then(function (x) {
          return x[0] ? { inst: inst, at: +e.at || 0, o: x[0], b: x[1] } : null;
        }, function () { return null; });
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
    // Ask host a question. q: { provider, model, messages, temperature, maxTokens };
    // h: { signal, onDelta(x, full), onEvent(msg), timeoutMs }
    // → Promise<{ text, reason, usage, model, ms }>; rejects AiError (err.partial).
    function request(host, q, h) {
      h = h || {};
      var m = me(), id = rid(14), text = '', done = false, firstText = false, waitingOk = false;
      var timeoutMs = h.timeoutMs || 120000;
      var resRef = null, reqRef = null, fn = null, tAck = null, tIdle = null, offAbort = null;
      var payload = makeRequest({ id: id, from: m.inst, name: m.name, kind: m.kind, did: m.id, provider: q.provider, model: q.model, messages: q.messages, temperature: q.temperature, maxTokens: q.maxTokens });
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
          var tk = /^\[([ xX])\]\s+(.*)$/.exec(body);
          if (tk) { body = tk[2]; cls = tk[1] === ' ' ? ' class="task"' : ' class="task done"'; }
          var ind = m[1].length;
          if (ind >= 2) cls = cls ? cls.replace('"task', '"ind' + Math.min(4, Math.floor(ind / 2)) + ' task') : ' class="ind' + Math.min(4, Math.floor(ind / 2)) + '"';
          items.push('<li' + cls + '>' + (tk ? '<span class="box">' + (tk[1] === ' ' ? '☐' : '☑') + '</span> ' : '') + inline(body) + '</li>');
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
    PREFS: PREFS, PREF_DEFAULTS: PREF_DEFAULTS, PROVIDERS: PROVIDERS, PROVIDER_ORDER: PROVIDER_ORDER, PRESETS: PRESETS, DETECT: DETECT, RELAY: RELAY,
    ACTIONS: ACTIONS, LANGS: LANGS, SOURCES: SOURCES, ANTHROPIC_VERSION: ANTHROPIC_VERSION, ANTHROPIC_FALLBACK: ANTHROPIC_FALLBACK,
    providerOf: providerOf, presetOf: presetOf, kindOf: kindOf, endpointProvider: endpointProvider, normBase: normBase, hostOf: hostOf, addressSpace: addressSpace, isHttp: isHttp,
    refKey: refKey, parseRef: parseRef, parsePrefModel: parsePrefModel,
    headersFor: headersFor, providerHeaders: providerHeaders, modelsRequest: modelsRequest, modelsUrl: modelsUrl, anthropicMessages: anthropicMessages,
    buildChat: buildChat, parseModels: parseModels, chatModels: chatModels, pickModel: pickModel, readChunk: readChunk,
    ndjsonParser: ndjsonParser, sseParser: sseParser,
    AiError: AiError, errorMessage: errorMessage, classifyHttp: classifyHttp, refineNetwork: refineNetwork, isAbort: isAbort, explain: explain,
    listModels: listModels, chatStream: chatStream, probe: probe,
    normName: normName, scoreIndex: scoreIndex, catalogIndex: catalogIndex, enrich: enrich, badges: badges, fmtPrice: fmtPrice, fmtCtx: fmtCtx,
    estTokens: estTokens, budget: budget, fitText: fitText, composeUser: composeUser, assemble: assemble, actionPrompt: actionPrompt,
    rid: rid, seqKey: seqKey, makeRequest: makeRequest, validateRequest: validateRequest, splitSafe: splitSafe,
    sharedEndpoints: sharedEndpoints, sharedModels: sharedModels, buildPresence: buildPresence, resolveShared: resolveShared,
    createBatcher: createBatcher, createReassembler: createReassembler, parsePresence: parsePresence, pickHost: pickHost, hostDefault: hostDefault,
    createRelayHost: createRelayHost, createRelayClient: createRelayClient,
    esc: esc, safeUrl: safeUrl, mdToHtml: mdToHtml, roomNameFrom: roomNameFrom, fmtBytes: fmtBytes, fmtMs: fmtMs, sniff: sniff
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object' && typeof window !== 'undefined' && root === window) root.__cadeAiCore = api;
})(typeof self !== 'undefined' ? self : this);
