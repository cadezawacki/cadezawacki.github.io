/* Checks for AI: providers and adapters (Ollama, OpenAI-compatible, OpenAI,
 * Anthropic Messages, Gemini, OpenRouter…), stream parsers (pieces split
 * anywhere), error classification + fix texts, the engine against fake model
 * servers (Ollama NDJSON, OpenAI SSE, Anthropic SSE events), badges (prices,
 * context, LMArena scores — name matching), context budgeting, the relay
 * protocol (presence v2, what a host shares, end-to-end over an in-memory
 * cloud), the service on two devices (a phone that NEVER calls a model API,
 * API keys that never leave the host), Markdown, the prefs schema and the
 * widget / plugin registration.
 * Not loaded by the app. Run: node txt/widgets/ai/ai.test.js
 * (AI_MANIFEST=<path> checks another manifest.json than txt/manifest.json.) */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path'), http = require('http');
var C = require('./ai-core.js');
var SCORES = require('./ai-scores.js');

// The manifest entries this module needs (txt/manifest.json must match them).
var PROPOSED = {
  ai: {
    id: 'ai', type: 'widget', name: 'AI',
    description: 'Your own AI — local models (Ollama, LM Studio, Unsloth Studio…) or cloud APIs with your keys (OpenAI, Anthropic, Gemini, OpenRouter…) — with your note as context: summarise, rewrite, continue, explain code, checklists, translate. Use it from your phone too: it asks your computer, end-to-end encrypted through Sync',
    icon: '✨',
    tags: 'ai,assistant,chat,llm,local llm,local ai,private ai,ollama,lm studio,unsloth,unsloth studio,llama,llama.cpp,mistral,gemma,qwen,deepseek,phi,openai,openai compatible,gpt,chatgpt,anthropic,claude,gemini,openrouter,groq,grok,together,summarise,summarize,rewrite,continue writing,explain code,checklist,translate,ask,prompt,model',
    entry: 'widgets/ai/ai.js', css: 'widgets/ai/ai.css',
    precache: ['widgets/ai/ai-core.js', 'widgets/ai/ai-service.js', 'widgets/ai/ai-scores.js'],
    prefs: { title: 'AI', fields: JSON.parse(JSON.stringify(C.PREFS)) }
  },
  'ai-host': {
    id: 'ai-host', type: 'plugin', name: 'Share my AI models with my other devices',
    description: 'This computer answers the AI widget on your other devices (same Sync) with its models — Ollama, LM Studio, and cloud APIs only if you allow it — end-to-end encrypted, deleted once delivered; your API keys never leave this computer. Works while a txt tab stays open here. Set it up in the AI widget',
    entry: 'widgets/ai/ai-host.js',
    precache: ['widgets/ai/ai-core.js', 'widgets/ai/ai-service.js', 'widgets/ai/ai-scores.js', 'widgets/ai/ai.css'],
    settingKey: 'plugins.ai-host', section: 'Devices', default: false
  }
};
var MANIFEST = process.env.AI_MANIFEST || path.join(__dirname, '..', '..', 'manifest.json');
function manifestModules() { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).modules; }
function manifestEntry(id) { return manifestModules().filter(function (x) { return x.id === id; })[0] || null; }

var passed = 0, queue = [];
function test(name, fn) { queue.push([name, fn]); }
function run() {
  var t = queue.shift();
  if (!t) {
    console.log((process.exitCode ? 'FAILED, ' : '') + 'ai: ' + passed + ' passed');
    try { server.closeAllConnections(); } catch (e) {}
    server.close();
    return;
  }
  var done = false, timer = setTimeout(function () { if (!done) { done = true; console.error('FAIL ' + t[0] + '\n  (timed out)'); process.exitCode = 1; run(); } }, 15000);
  Promise.resolve().then(t[1]).then(function () { if (done) return; done = true; clearTimeout(timer); passed++; run(); },
    function (e) { if (done) return; done = true; clearTimeout(timer); console.error('FAIL ' + t[0] + '\n' + (e && e.stack || e)); process.exitCode = 1; run(); });
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function until(fn, ms, what) {
  var t0 = Date.now();
  return new Promise(function (res, rej) {
    (function poll() {
      var v; try { v = fn(); } catch (e) { v = null; }
      if (v) { res(v); return; }
      if (Date.now() - t0 > (ms || 4000)) { rej(new Error('timed out waiting for ' + (what || 'a condition'))); return; }
      setTimeout(poll, 10);
    })();
  });
}
// polls an async check until it gives something truthy
function untilP(fn, ms, what) {
  var t0 = Date.now();
  return (function poll() {
    return Promise.resolve().then(fn).then(function (v) {
      if (v) return v;
      if (Date.now() - t0 > (ms || 4000)) throw new Error('timed out waiting for ' + (what || 'a condition'));
      return wait(15).then(poll);
    });
  })();
}
function rejects(p, code) {
  return p.then(function () { throw new Error('expected a rejection with ' + code); }, function (e) { assert.strictEqual(e.code, code, 'code ' + e.code + ' (' + e.message + ')'); return e; });
}
function pieces(s, sizes) {
  var out = [], i = 0, k = 0;
  while (i < s.length) { var n = sizes[k++ % sizes.length]; out.push(s.slice(i, i + n)); i += n; }
  return out;
}
var MSGS = [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }];

// ---- providers -----------------------------------------------------------------------------------------
test('providers: every preset is complete; cloud ones are https with a key and a "get a key" page', function () {
  assert.deepStrictEqual(C.PROVIDER_ORDER.slice().sort(), Object.keys(C.PROVIDERS).sort());
  C.PROVIDER_ORDER.forEach(function (id) {
    var p = C.PROVIDERS[id];
    assert.strictEqual(p.id, id);
    assert.ok(p.label && p.sub && /^(ollama|openai|anthropic)$/.test(p.kind) && /^(local|cloud)$/.test(p.where), id);
    if (p.where === 'cloud') {
      assert.ok(/^https:\/\//.test(p.url) && /^https:\/\//.test(p.keyUrl) && p.key === 'required', id);
      assert.strictEqual(C.normBase(p.kind, p.url), p.url, id + ': the preset is already a normal base');
    } else assert.strictEqual(C.addressSpace(p.url), 'loopback', id);
  });
  assert.strictEqual(C.PROVIDERS.anthropic.url, 'https://api.anthropic.com/v1');
  assert.strictEqual(C.PROVIDERS.gemini.url, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.strictEqual(C.PROVIDERS.openrouter.url, 'https://openrouter.ai/api/v1');
  assert.strictEqual(C.PROVIDERS.openai.url, 'https://api.openai.com/v1');
  assert.strictEqual(C.endpointProvider('custom3'), 'custom');
  assert.strictEqual(C.endpointProvider('anthropic'), 'anthropic');
  assert.strictEqual(C.endpointProvider('nope'), '');
  assert.strictEqual(C.providerOf('custom2').id, 'custom');
});
test('addresses: typed bases are normalised per API', function () {
  assert.strictEqual(C.normBase('ollama', 'localhost:11434/'), 'http://localhost:11434');
  assert.strictEqual(C.normBase('ollama', 'http://127.0.0.1:11434/api/tags'), 'http://127.0.0.1:11434');
  assert.strictEqual(C.normBase('ollama', 'http://box:11434/v1'), 'http://box:11434');
  assert.strictEqual(C.normBase('openai', 'http://127.0.0.1:1234'), 'http://127.0.0.1:1234/v1');
  assert.strictEqual(C.normBase('openai', 'http://127.0.0.1:1234/v1/chat/completions'), 'http://127.0.0.1:1234/v1');
  assert.strictEqual(C.normBase('openai', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'), 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.strictEqual(C.normBase('anthropic', 'https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1');
  assert.strictEqual(C.normBase('openai', ''), '');
  assert.strictEqual(C.addressSpace('http://localhost:11434'), 'loopback');
  assert.strictEqual(C.addressSpace('http://[::1]:8080'), 'loopback');
  assert.strictEqual(C.addressSpace('http://192.168.1.20:11434'), 'local');
  assert.strictEqual(C.addressSpace('http://gpu.local:8080'), 'local');
  assert.strictEqual(C.addressSpace('http://172.32.0.1'), 'public');
  assert.strictEqual(C.addressSpace('https://api.anthropic.com/v1'), 'public');
});
test('model references: picker refs and readable prefs values', function () {
  var r = C.refKey('mac1', 'openrouter', 'anthropic/claude-opus-5.5');
  assert.deepStrictEqual(C.parseRef(r), { src: 'mac1', ep: 'openrouter', model: 'anthropic/claude-opus-5.5' });
  assert.deepStrictEqual(C.parseRef(C.refKey('local', 'ollama', 'llama3.2:latest')), { src: 'local', ep: 'ollama', model: 'llama3.2:latest' });
  assert.strictEqual(C.parseRef('nope'), null);
  assert.deepStrictEqual(C.parsePrefModel('anthropic:claude-opus-5-5'), { ep: 'anthropic', model: 'claude-opus-5-5' });
  assert.deepStrictEqual(C.parsePrefModel('ollama:qwen2.5:7b'), { ep: 'ollama', model: 'qwen2.5:7b' });
  assert.deepStrictEqual(C.parsePrefModel('custom2:gemma'), { ep: 'custom2', model: 'gemma' });
  assert.deepStrictEqual(C.parsePrefModel('llama3.2:latest'), { ep: '', model: 'llama3.2:latest' }, 'a bare model name with a tag');
  assert.deepStrictEqual(C.parsePrefModel(''), { ep: '', model: '' });
});

// ---- requests ------------------------------------------------------------------------------------------
test('requests: Ollama native and an OpenAI-compatible local server', function () {
  var o = C.buildChat({ kind: 'ollama', base: 'http://h:1', model: 'llama3.2', messages: MSGS, temperature: 0.2, maxTokens: 300, numCtx: 8192 });
  assert.strictEqual(o.url, 'http://h:1/api/chat');
  assert.deepStrictEqual(JSON.parse(o.init.body), { model: 'llama3.2', messages: MSGS, stream: true, options: { temperature: 0.2, num_predict: 300, num_ctx: 8192 } });
  assert.strictEqual(o.init.headers.Authorization, undefined);
  var p = C.buildChat({ kind: 'openai', provider: 'custom', base: 'http://h:2/v1', apiKey: 'sk-1', model: 'm', messages: MSGS, temperature: 0, maxTokens: 50, numCtx: 4096 });
  assert.strictEqual(p.url, 'http://h:2/v1/chat/completions');
  assert.deepStrictEqual(JSON.parse(p.init.body), { model: 'm', messages: MSGS, stream: true, temperature: 0, max_tokens: 50 }, 'no stream_options for servers that may not know it');
  assert.strictEqual(p.init.headers.Authorization, 'Bearer sk-1');
  assert.strictEqual(JSON.parse(C.buildChat({ kind: 'ollama', base: 'x', model: 'm', messages: MSGS }).init.body).options.num_ctx, undefined, 'no num_ctx when 0/unset');
});
test('requests: OpenAI (max_completion_tokens; no temperature for GPT-5 / o-series), Mistral’s range, usage asked for', function () {
  var g5 = JSON.parse(C.buildChat({ kind: 'openai', provider: 'openai', base: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-5.5', messages: MSGS, temperature: 0.7, maxTokens: 900 }).init.body);
  assert.deepStrictEqual(g5, { model: 'gpt-5.5', messages: MSGS, stream: true, max_completion_tokens: 900, stream_options: { include_usage: true } });
  var o4 = JSON.parse(C.buildChat({ kind: 'openai', provider: 'openai', base: 'x', apiKey: 'k', model: 'o4-mini', messages: MSGS, temperature: 0.7, maxTokens: 9 }).init.body);
  assert.strictEqual(o4.temperature, undefined);
  var g41 = JSON.parse(C.buildChat({ kind: 'openai', provider: 'openai', base: 'x', apiKey: 'k', model: 'gpt-4.1', messages: MSGS, temperature: 0.7, maxTokens: 9 }).init.body);
  assert.strictEqual(g41.temperature, 0.7); assert.strictEqual(g41.max_completion_tokens, 9); assert.strictEqual(g41.max_tokens, undefined);
  var mi = JSON.parse(C.buildChat({ kind: 'openai', provider: 'mistral', base: 'x', apiKey: 'k', model: 'mistral-large-latest', messages: MSGS, temperature: 2, maxTokens: 9 }).init.body);
  assert.strictEqual(mi.temperature, 1.5, 'Mistral takes 0–1.5'); assert.strictEqual(mi.max_tokens, 9);
  var gm = JSON.parse(C.buildChat({ kind: 'openai', provider: 'gemini', base: 'x', apiKey: 'k', model: 'gemini-3-pro', messages: MSGS, temperature: 1, maxTokens: 9 }).init.body);
  assert.deepStrictEqual(gm.stream_options, { include_usage: true }); assert.strictEqual(gm.temperature, 1);
});
test('requests: OpenRouter attribution headers; the key is a Bearer token everywhere but Anthropic', function () {
  var h = C.providerHeaders('openrouter', 'https://cadezawacki.github.io');
  assert.deepStrictEqual(h, { 'HTTP-Referer': 'https://cadezawacki.github.io', 'X-Title': 'Cade.txt' });
  assert.deepStrictEqual(C.providerHeaders('groq'), {});
  var r = C.buildChat({ kind: 'openai', provider: 'openrouter', base: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-1', headers: h, model: 'anthropic/claude-opus-5.5', messages: MSGS });
  assert.strictEqual(r.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.strictEqual(r.init.headers.Authorization, 'Bearer sk-or-1');
  assert.strictEqual(r.init.headers['X-Title'], 'Cade.txt');
});
test('requests: Anthropic Messages — headers, no temperature (API 2026-10-21), system on top, alternating turns, fallbacks', function () {
  var msgs = [{ role: 'system', content: 'Be brief.' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b' },
    { role: 'assistant', content: '' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'c' }];
  var r = C.buildChat({ kind: 'anthropic', provider: 'anthropic', base: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-1', model: 'claude-opus-5-5', messages: msgs, temperature: 0.7, maxTokens: 1000 });
  assert.strictEqual(r.url, 'https://api.anthropic.com/v1/messages');
  var h = r.init.headers;
  assert.strictEqual(h['x-api-key'], 'sk-ant-1');
  assert.strictEqual(h['anthropic-version'], '2026-10-21');
  assert.strictEqual(h['anthropic-dangerous-direct-browser-access'], 'true', 'Anthropic’s CORS opt-in');
  assert.strictEqual(h['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.strictEqual(h.Authorization, undefined, 'no Bearer header');
  var b = JSON.parse(r.init.body);
  assert.deepStrictEqual(b, { model: 'claude-opus-5-5', max_tokens: 1000, stream: true, system: 'Be brief.', fallbacks: 'default',
    messages: [{ role: 'user', content: 'a\n\nb' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'c' }] });
  assert.ok(!('temperature' in b) && !('top_p' in b) && !('top_k' in b));
  var nf = C.buildChat({ kind: 'anthropic', provider: 'anthropic', base: 'b', apiKey: 'k', model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'q' }] });
  assert.strictEqual(nf.init.headers['anthropic-beta'], undefined, 'fallbacks only where Anthropic recommends them');
  assert.deepStrictEqual(JSON.parse(nf.init.body), { model: 'claude-haiku-4-5', max_tokens: 64000, stream: true, messages: [{ role: 'user', content: 'q' }] },
    'no limit set → the model’s own output maximum (Anthropic requires a number)');
  var off = C.buildChat({ kind: 'anthropic', provider: 'anthropic', base: 'b', apiKey: 'k', model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'q' }], fallbacks: false });
  assert.strictEqual(off.init.headers['anthropic-beta'], undefined);
  assert.strictEqual(JSON.parse(off.init.body).fallbacks, undefined);
});
test('model lists: where each provider’s list lives and how the key goes', function () {
  assert.strictEqual(C.modelsUrl('ollama', 'http://h'), 'http://h/api/tags');
  assert.strictEqual(C.modelsUrl('openai', 'http://h/v1'), 'http://h/v1/models');
  var a = C.modelsRequest({ kind: 'anthropic', provider: 'anthropic', base: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-1' });
  assert.strictEqual(a.url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.strictEqual(a.headers['x-api-key'], 'sk-ant-1'); assert.strictEqual(a.headers['anthropic-dangerous-direct-browser-access'], 'true');
  var g = C.modelsRequest({ kind: 'openai', provider: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'AIza1' });
  assert.strictEqual(g.url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', 'Gemini’s own list (it has the context windows)');
  assert.deepStrictEqual(g.headers, { 'x-goog-api-key': 'AIza1' });
  var o = C.modelsRequest({ kind: 'openai', provider: 'groq', base: 'https://api.groq.com/openai/v1', apiKey: 'gsk' });
  assert.strictEqual(o.headers.Authorization, 'Bearer gsk');
});
test('model lists: each provider’s answer → chat models first, with context and price where given', function () {
  var ol = C.parseModels('ollama', { models: [
    { name: 'nomic-embed-text:latest', size: 274e6, details: { family: 'nomic-bert' } },
    { name: 'llama3.2:latest', model: 'llama3.2:latest', size: 2019393189, details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' } },
    { name: 'qwen2.5:7b', size: 4.7e9, details: {} }] });
  assert.deepStrictEqual(ol.map(function (m) { return m.id; }), ['llama3.2:latest', 'qwen2.5:7b', 'nomic-embed-text:latest']);
  assert.deepStrictEqual([ol[0].params, ol[0].quant, ol[0].size, ol[2].embed], ['3.2B', 'Q4_K_M', 2019393189, true]);
  var an = C.parseModels({ kind: 'anthropic', provider: 'anthropic' }, { data: [
    { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000 },
    { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' }], has_more: false });
  assert.deepStrictEqual(an.map(function (m) { return [m.id, m.name, m.ctx, m.out]; }), [['claude-opus-5-5', 'Claude Opus 5.5', 1000000, 128000], ['claude-haiku-4-5', 'Claude Haiku 4.5', 0, 0]]);
  var gm = C.parseModels({ kind: 'openai', provider: 'gemini' }, { models: [
    { name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/text-embedding-004', displayName: 'Text Embedding 004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/imagen-4', supportedGenerationMethods: ['predict'] }] });
  assert.deepStrictEqual(C.chatModels(gm).map(function (m) { return [m.id, m.name, m.ctx]; }), [['gemini-3-pro', 'Gemini 3 Pro', 1048576]]);
  var or = C.parseModels({ kind: 'openai', provider: 'openrouter' }, { data: [
    { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', context_length: 1000000, pricing: { prompt: '0.000004', completion: '0.00002' }, architecture: { output_modalities: ['text'] } },
    { id: 'openai/gpt-image-2', name: 'OpenAI: GPT Image 2', pricing: { prompt: '0.00001', completion: '0.00004' }, architecture: { output_modalities: ['image'] } },
    { id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: '-1', completion: '-1' } }] });
  assert.deepStrictEqual(C.chatModels(or).map(function (m) { return m.id; }), ['anthropic/claude-opus-5.5', 'openrouter/auto']);
  assert.deepStrictEqual(or[0].price, { in: 4, out: 20 }, 'USD per token → per 1M');
  assert.strictEqual(or[0].ctx, 1000000);
  assert.strictEqual(or.filter(function (m) { return m.id === 'openrouter/auto'; })[0].price, null, 'variable price → none');
  var tg = C.parseModels({ kind: 'openai', provider: 'together' }, [
    { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', type: 'chat', context_length: 131072, pricing: { input: 0.88, output: 0.88 } },
    { id: 'BAAI/bge-large-en-v1.5', type: 'embedding', pricing: { input: 0.02, output: 0 } }]);
  assert.deepStrictEqual(C.chatModels(tg).map(function (m) { return [m.id, m.ctx, m.price.in]; }), [['meta-llama/Llama-3.3-70B-Instruct-Turbo', 131072, 0.88]]);
  var oa = C.parseModels({ kind: 'openai', provider: 'openai' }, { data: [{ id: 'gpt-5.5' }, { id: 'dall-e-3' }, { id: 'text-embedding-3-large' }, { id: 'whisper-1' }, { id: 'babbage-002' }, { id: 'o4-mini' }, { id: 'gpt-realtime' }] });
  assert.deepStrictEqual(C.chatModels(oa).map(function (m) { return m.id; }), ['gpt-5.5', 'o4-mini']);
  var mi = C.parseModels({ kind: 'openai', provider: 'mistral' }, { data: [{ id: 'mistral-large-latest', max_context_length: 131072, capabilities: { completion_chat: true } }, { id: 'mistral-embed', capabilities: { completion_chat: false } }] });
  assert.deepStrictEqual(C.chatModels(mi).map(function (m) { return [m.id, m.ctx]; }), [['mistral-large-latest', 131072]]);
  var gq = C.parseModels({ kind: 'openai', provider: 'groq' }, { data: [{ id: 'llama-3.3-70b-versatile', context_window: 131072 }, { id: 'whisper-large-v3' }] });
  assert.deepStrictEqual(C.chatModels(gq).map(function (m) { return [m.id, m.ctx]; }), [['llama-3.3-70b-versatile', 131072]]);
  assert.strictEqual(C.pickModel('', an, 'claude-opus-5-5'), 'claude-opus-5-5', 'a provider’s preferred model first');
  assert.strictEqual(C.pickModel('llama3.2', ol), 'llama3.2:latest', ':latest is implied');
  assert.strictEqual(C.pickModel('gone', ol), 'llama3.2:latest');
  assert.strictEqual(C.pickModel('mine', null), 'mine', 'unknown list: trust the name');
});
test('stream chunks: Ollama, OpenAI and every Anthropic event', function () {
  var a = C.readChunk('ollama', { message: { role: 'assistant', content: 'Hi', thinking: '' }, done: false });
  assert.strictEqual(a.text, 'Hi'); assert.strictEqual(a.done, false);
  var z = C.readChunk('ollama', { message: { content: '' }, done: true, done_reason: 'length', prompt_eval_count: 12, eval_count: 30 });
  assert.deepStrictEqual([z.done, z.reason, z.usage.prompt, z.usage.output], [true, 'length', 12, 30]);
  var c = C.readChunk('openai', { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
  assert.deepStrictEqual([c.done, c.reason, c.usage.output], [true, 'stop', 7]);
  assert.strictEqual(C.readChunk('openai', { choices: [{ delta: { reasoning_content: 'r' } }] }).thinking, 'r');
  assert.strictEqual(C.readChunk('openai', { error: { message: 'Model unloaded', type: 'x' } }).error, 'Model unloaded');
  var A = function (o) { return C.readChunk('anthropic', o); };
  var ms = A({ type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 25, output_tokens: 1 } } });
  assert.deepStrictEqual([ms.model, ms.usage.prompt], ['claude-opus-5-5', 25]);
  assert.strictEqual(A({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }).think, true);
  assert.strictEqual(A({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }).thinking, 'hmm');
  assert.strictEqual(A({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } }).text, '');
  assert.strictEqual(A({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } }).text, 'Hello');
  var md = A({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { input_tokens: 25, output_tokens: 99 } });
  assert.deepStrictEqual([md.done, md.reason, md.usage.output], [true, 'length', 99]);
  assert.strictEqual(A({ type: 'message_delta', delta: { stop_reason: 'refusal' } }).reason, 'refusal');
  assert.strictEqual(A({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }).reason, 'stop');
  assert.strictEqual(A({ type: 'message_stop' }).end, true);
  var er = A({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  assert.deepStrictEqual([er.error, er.errorType], ['Overloaded', 'overloaded_error']);
  assert.strictEqual(A({ type: 'ping' }).text, '');
});

// ---- stream parsers --------------------------------------------------------------------------------------
test('NDJSON: lines split anywhere, blank lines, bad lines, no final newline', function () {
  var src = '{"a":1}\n\n{"b":"x\\ny"}\nnot json\n{"c":[1,2]}';
  [[1], [2, 3], [5], [7, 1, 13], [1000]].forEach(function (sz) {
    var got = [], bad = [];
    var p = C.ndjsonParser(function (o) { got.push(o); }, function (l) { bad.push(l); });
    pieces(src, sz).forEach(p.push); p.end();
    assert.deepStrictEqual(got, [{ a: 1 }, { b: 'x\ny' }, { c: [1, 2] }], 'sizes ' + sz);
    assert.deepStrictEqual(bad, ['not json']);
  });
});
test('SSE: data across pieces, \\r\\n split in two, event names, multi-line data, comments, [DONE]', function () {
  var src = ': keep-alive\r\n\r\ndata: {"x":1}\r\n\r\nevent: note\ndata: line1\ndata: line2\n\ndata:{"y":"a b"}\r\rdata: [DONE]\n\n';
  [[1], [2], [3, 1], [6], [500]].forEach(function (sz) {
    var got = [];
    var p = C.sseParser(function (e) { got.push(e); });
    pieces(src, sz).forEach(p.push); p.end();
    assert.deepStrictEqual(got.map(function (e) { return e.event + '|' + e.data; }), ['message|{"x":1}', 'note|line1\nline2', 'message|{"y":"a b"}', 'message|[DONE]'], 'sizes ' + sz);
  });
});

// ---- errors ----------------------------------------------------------------------------------------------
test('HTTP errors are classified from each provider’s own words', function () {
  assert.strictEqual(C.classifyHttp(404, '{"error":"model \\"llama9\\" not found, try pulling it first"}').code, 'model');
  assert.strictEqual(C.classifyHttp(400, '{"object":"error","message":"This model\'s maximum context length is 4096 tokens. However, you requested 5000 tokens","code":400}').code, 'context');
  assert.strictEqual(C.classifyHttp(401, '{"error":"Invalid API Key"}').code, 'auth');
  assert.strictEqual(C.classifyHttp(401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}').code, 'auth');
  assert.strictEqual(C.classifyHttp(400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}').code, 'billing');
  assert.strictEqual(C.classifyHttp(529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}').code, 'busy');
  assert.strictEqual(C.classifyHttp(404, '{"type":"error","error":{"type":"not_found_error","message":"model: claude-nope"}}').code, 'model');
  assert.strictEqual(C.classifyHttp(400, '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1200000 tokens > 1000000 maximum"}}').code, 'context');
  assert.strictEqual(C.classifyHttp(429, '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}').code, 'billing');
  assert.strictEqual(C.classifyHttp(429, '{"error":{"message":"Rate limit reached","type":"requests"}}').code, 'busy');
  assert.strictEqual(C.classifyHttp(400, '[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}]').code, 'auth', 'Gemini wraps errors in a list');
  assert.strictEqual(C.classifyHttp(402, '{"error":{"message":"Insufficient credits","code":402}}').code, 'billing', 'OpenRouter');
  assert.strictEqual(C.classifyHttp(404, '404 page not found').code, 'notfound');
  var s = C.classifyHttp(500, '<html><body>Internal <b>Server</b> Error</body></html>');
  assert.strictEqual(s.code, 'server'); assert.strictEqual(s.detail, 'Internal Server Error');
  assert.strictEqual(C.errorMessage('{"detail":[{"msg":"field required"}]}'), 'field required');
});
test('network failures: probe + environment → cors / unreachable / mixed / lna', function () {
  assert.strictEqual(C.refineNetwork('blocked', {}), 'cors');
  assert.strictEqual(C.refineNetwork('down', {}), 'unreachable');
  assert.strictEqual(C.refineNetwork('down', { mixedBlocked: true }), 'mixed');
  assert.strictEqual(C.refineNetwork('blocked', { lna: 'denied' }), 'lna');
});
test('answer length: 0 = no limit everywhere — nothing sent to local/OpenAI-style servers, the model maximum to Claude, kept 0 over the relay', function () {
  var P = {}; C.PREFS.forEach(function (f) { if (f.key) P[f.key] = f; });
  assert.strictEqual(P.maxTokens.default, 0); assert.strictEqual(P.maxTokens.min, 0);
  assert.strictEqual(P.cloudMaxTokens.default, 0); assert.strictEqual(P.cloudMaxTokens.min, 0);
  var ol = JSON.parse(C.buildChat({ kind: 'ollama', base: 'http://h:1', model: 'llama3.2', messages: MSGS, maxTokens: 0 }).init.body);
  assert.ok(!('num_predict' in ol.options), 'Ollama: no num_predict');
  ['lmstudio', 'unsloth', 'custom', 'openai', 'openrouter'].forEach(function (pv) {
    var b = JSON.parse(C.buildChat({ kind: 'openai', provider: pv, base: 'http://h/v1', apiKey: 'k', model: 'm', messages: MSGS, maxTokens: 0 }).init.body);
    assert.ok(!('max_tokens' in b) && !('max_completion_tokens' in b), pv + ': no length field');
  });
  var an = function (m, n) { return JSON.parse(C.buildChat({ kind: 'anthropic', provider: 'anthropic', base: 'b', apiKey: 'k', model: m, messages: MSGS, maxTokens: n }).init.body).max_tokens; };
  assert.deepStrictEqual([an('claude-opus-5-5', 0), an('claude-fable-5-1', 0), an('claude-sonnet-4-6', 0), an('claude-haiku-4-5', 0), an('claude-3-7-sonnet', 0)], [128000, 128000, 128000, 64000, 32000]);
  assert.strictEqual(an('claude-opus-5-5', 2000), 2000, 'a set number still applies');
  assert.strictEqual(an('claude-haiku-4-5', 100000), 64000, 'never above the model maximum');
  assert.deepStrictEqual([C.tokenLimit(0, 0), C.tokenLimit(9000, 0), C.tokenLimit(0, 2048), C.tokenLimit(9000, 2048), C.tokenLimit(undefined, NaN)], [0, 9000, 2048, 2048, 0]);
  var rq = C.validateRequest(C.makeRequest({ id: 'abc123def456', from: 'dev1-tab', name: 'iPhone', kind: 'phone', did: 'dev1', provider: 'ollama', model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0.5, maxTokens: 0 }));
  assert.ok(rq.ok); assert.strictEqual(rq.req.maxTokens, 0, 'no limit survives the relay (was clamped to 1)');
});
test('picker filters: cost/quality tiers, context, where, sorting; unknown data fails a filter that needs it', function () {
  var M = [
    { id: 'opus', where: 'cloud', price: { in: 4, out: 20 }, ctx: 1000000, score: { r: 1516 } },
    { id: 'sonnet', where: 'cloud', price: { in: 2, out: 10 }, ctx: 1000000, score: { r: 1473 } },
    { id: 'haiku', where: 'cloud', price: { in: 0.1, out: 0.5 }, ctx: 200000, score: { r: 1397 } },
    { id: 'freebie', where: 'cloud', price: { in: 0, out: 0 }, ctx: 32768 },
    { id: 'mystery', where: 'cloud' },
    { id: 'llama', where: 'local', ctx: 131072 },
    { id: 'tiny', where: 'local' }];
  var ids = function (l) { return l.map(function (m) { return m.id; }); };
  var pass = function (f) { return ids(M.filter(function (m) { return C.passes(m, f, 1516); })); };
  assert.deepStrictEqual(M.map(C.costTier), ['$$$', '$$', '$', 'free', '', 'free', 'free']);
  assert.deepStrictEqual(M.map(function (m) { return C.qualityTier(m, 1516); }), ['top', 'strong', 'ok', '', '', '', '']);
  assert.deepStrictEqual(pass({}), ids(M));
  assert.deepStrictEqual(pass({ where: 'local' }), ['llama', 'tiny']);
  assert.deepStrictEqual(pass({ where: 'cloud' }), ['opus', 'sonnet', 'haiku', 'freebie', 'mystery']);
  assert.deepStrictEqual(pass({ ctx: 128000 }), ['opus', 'sonnet', 'haiku', 'llama'], '131072 counts as 128K; unknown context fails');
  assert.deepStrictEqual(pass({ ctx: 1000000 }), ['opus', 'sonnet']);
  assert.deepStrictEqual(pass({ cost: 'free' }), ['freebie', 'llama', 'tiny']);
  assert.deepStrictEqual(pass({ cost: '$' }), ['haiku', 'freebie', 'llama', 'tiny'], '"up to $" includes free; unknown price fails');
  assert.deepStrictEqual(pass({ cost: '$$' }), ['sonnet', 'haiku', 'freebie', 'llama', 'tiny']);
  assert.deepStrictEqual(pass({ quality: 'top' }), ['opus']);
  assert.deepStrictEqual(pass({ quality: 'strong' }), ['opus', 'sonnet']);
  assert.deepStrictEqual(pass({ where: 'cloud', cost: '$$', quality: 'strong', ctx: 1000000 }), ['sonnet'], 'filters combine');
  assert.deepStrictEqual(ids(C.sortModels(M, { sort: 'quality' })), ['opus', 'sonnet', 'haiku', 'freebie', 'mystery', 'llama', 'tiny']);
  assert.deepStrictEqual(ids(C.sortModels(M, { sort: 'price' })), ['freebie', 'llama', 'tiny', 'haiku', 'sonnet', 'opus', 'mystery']);
  assert.deepStrictEqual(ids(C.sortModels(M, { sort: 'ctx' })), ['opus', 'sonnet', 'haiku', 'llama', 'freebie', 'mystery', 'tiny']);
  assert.deepStrictEqual(ids(C.sortModels(M, { sort: '' })), ids(M), 'no sort keeps the service order');
  assert.deepStrictEqual(C.normFilters({ where: 'mars', ctx: '128000', cost: '$$$', quality: 'meh', sort: 'x' }), { where: '', ctx: 128000, cost: '', quality: '', sort: '' });
  assert.ok(!C.filtersActive({ sort: 'price' }) && C.filtersActive({ ctx: 32000 }));
  assert.strictEqual(C.bestScore({ byKey: { a: { r: 1400 }, b: { r: 1520 } } }), 1520);
});
test('addresses: LM Studio’s own /api/v1 paths and a pasted /chat go to the OpenAI-compatible /v1 — locally only', function () {
  assert.strictEqual(C.normBase('openai', 'http://localhost:1234/api/v1/chat'), 'http://localhost:1234/v1');
  assert.strictEqual(C.normBase('openai', 'http://localhost:1234/api/v0/models'), 'http://localhost:1234/v1');
  assert.strictEqual(C.normBase('openai', 'http://192.168.1.5:1234/v1/chat'), 'http://192.168.1.5:1234/v1');
  assert.strictEqual(C.normBase('openai', 'https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1', 'OpenRouter’s real base is untouched');
  assert.strictEqual(C.normBase('openai', 'https://openrouter.ai/api/v1/chat/completions'), 'https://openrouter.ai/api/v1');
});
test('model lists and probes bypass every cache (an old service worker answered them with a fake 504)', function () {
  var seen = [];
  var f = function (u, i) { seen.push(i && i.cache); return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve('{"data":[{"id":"m"}]}'); } }); };
  return C.listModels(f, { kind: 'openai', provider: 'lmstudio', base: 'http://127.0.0.1:1234/v1' }).then(function () {
    return C.probe(f, 'http://127.0.0.1:1234/v1/models', {});
  }).then(function () { assert.deepStrictEqual(seen, ['no-store', 'no-store']); });
});
test('Unsloth Studio: local OpenAI-compatible preset on 8888, Bearer key, loaded models first, own fix texts', function () {
  var P = C.PROVIDERS.unsloth;
  assert.strictEqual(P.kind, 'openai'); assert.strictEqual(P.where, 'local'); assert.strictEqual(P.key, 'optional');
  assert.strictEqual(P.url, 'http://127.0.0.1:8888/v1');
  assert.ok(C.PROVIDER_ORDER.indexOf('unsloth') > C.PROVIDER_ORDER.indexOf('lmstudio') && C.PROVIDER_ORDER.indexOf('unsloth') < C.PROVIDER_ORDER.indexOf('custom'));
  assert.ok(C.DETECT.some(function (d) { return d.provider === 'unsloth' && d.base === P.url; }));
  var b = C.buildChat({ kind: 'openai', provider: 'unsloth', base: P.url, apiKey: 'sk-unsloth-abc', model: 'unsloth/gemma', messages: MSGS, temperature: 0.4, maxTokens: 64 });
  assert.strictEqual(b.url, 'http://127.0.0.1:8888/v1/chat/completions');
  assert.strictEqual(b.init.headers.Authorization, 'Bearer sk-unsloth-abc');
  var body = JSON.parse(b.init.body);
  assert.strictEqual(body.temperature, 0.4); assert.strictEqual(body.max_tokens, 64); assert.ok(!('stream_options' in body));
  var l = C.parseModels({ kind: 'openai', provider: 'unsloth' }, { object: 'list', data: [
    { id: 'unsloth/Qwen3-8B-GGUF', loaded: false }, { id: 'unsloth/gemma-4-26B-A4B-it-GGUF', loaded: true }, { id: 'local/my-finetune' }] });
  assert.deepStrictEqual(l.map(function (m) { return m.id; }), ['unsloth/gemma-4-26B-A4B-it-GGUF', 'local/my-finetune', 'unsloth/Qwen3-8B-GGUF']);
  assert.strictEqual(C.pickModel('', l), 'unsloth/gemma-4-26B-A4B-it-GGUF', 'automatic pick is a loaded model');
  var idle = l[2];
  assert.ok(C.badges(Object.assign({ where: 'local' }, idle)).some(function (x) { return x.k === 'idle' && x.t === 'Not loaded'; }));
  assert.ok(!C.badges(Object.assign({ where: 'local' }, l[0])).some(function (x) { return x.k === 'idle'; }));
  var cmds = function (o) { return o.steps.filter(function (s) { return s.cmd; }).map(function (s) { return s.cmd; }); };
  var co = C.explain('cors', { provider: 'unsloth', origin: 'https://cadezawacki.github.io' });
  assert.ok(/Unsloth Studio/.test(co.title));
  assert.deepStrictEqual(cmds(co), ['unsloth studio', 'UNSLOTH_CORS_ORIGINS=https://cadezawacki.github.io']);
  assert.ok(cmds(C.explain('unreachable', { provider: 'unsloth', base: P.url })).indexOf('unsloth studio') >= 0);
  assert.ok(/sk-unsloth-/.test(JSON.stringify(C.explain('auth', { provider: 'unsloth' }).steps)));
  assert.ok(/Select model/.test(JSON.stringify(C.explain('model', { provider: 'unsloth', model: 'x' }).steps)));
});
test('fix texts: OLLAMA_ORIGINS per OS; cloud ones name the provider and link to its key page', function () {
  var o = C.explain('cors', { provider: 'ollama', origin: 'https://cadezawacki.github.io', os: 'win' });
  assert.strictEqual(o.osPick, 'win');
  var cmds = function (l) { return l.filter(function (s) { return s.cmd; }).map(function (s) { return s.cmd; }); };
  assert.ok(cmds(o.os.mac).indexOf('launchctl setenv OLLAMA_ORIGINS "https://cadezawacki.github.io"') >= 0);
  assert.ok(cmds(o.os.win)[0] === '[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "https://cadezawacki.github.io", "User")');
  assert.strictEqual(cmds(o.os.linux)[1], 'OLLAMA_ORIGINS=https://cadezawacki.github.io ollama serve');
  assert.ok(C.explain('cors', { provider: 'lmstudio' }).steps.some(function (s) { return s.cmd === 'lms server start --cors'; }));
  var ak = C.explain('key-missing', { provider: 'anthropic' });
  assert.ok(/Anthropic/.test(ak.title) && ak.steps.some(function (s) { return s.link === 'https://platform.claude.com/settings/keys'; }));
  assert.ok(/stays on this device/i.test(JSON.stringify(ak.steps)));
  assert.ok(/OpenRouter/.test(C.explain('auth', { provider: 'openrouter' }).title));
  assert.ok(/billing/.test(C.explain('billing', { provider: 'openai' }).title));
  assert.ok(/Groq/.test(C.explain('cors', { provider: 'groq' }).title), 'a cloud CORS failure names the provider');
  assert.ok(/MacBook doesn’t share/.test(C.explain('not-shared', { host: 'MacBook', model: 'claude-opus-5-5' }).title));
  ['cors', 'unreachable', 'mixed', 'lna', 'model', 'context', 'auth', 'key-missing', 'billing', 'notfound', 'busy', 'refusal', 'timeout', 'host-offline', 'host-silent',
    'host-unready', 'host-stopped', 'not-shared', 'denied', 'nosync', 'not-setup', 'version', 'too-big', 'aborted', 'server', 'weird'].forEach(function (code) {
    ['ollama', 'anthropic', 'gemini'].forEach(function (p) { assert.ok(C.explain(code, { provider: p, host: 'MacBook', detail: 'd' }).title, 'title for ' + code + '/' + p); });
  });
});

// ---- engine against fake servers ---------------------------------------------------------------------------
// One server: Ollama (/api/*), OpenAI-compatible (/v1/*), Anthropic Messages (/anthropic/v1/*).
var hits = [];
function anthropicSse(events) { return events.map(function (e) { return 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n'; }).join(''); }
function anthropicAnswer(text, stop, model) {
  var ev = [{ type: 'message_start', message: { id: 'msg_01', type: 'message', role: 'assistant', model: model, content: [], stop_reason: null, usage: { input_tokens: 21, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'ping' }];
  text.split(/(?<= )/).forEach(function (w) { ev.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }); });
  ev.push({ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: stop || 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } }, { type: 'message_stop' });
  return anthropicSse(ev);
}
var server = http.createServer(function (req, res) {
  var body = '';
  req.on('data', function (d) { body += d; });
  req.on('end', function () {
    var j = {}; try { j = JSON.parse(body || '{}'); } catch (e) {}
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: j });
    function chunks(list, ct, gap) {
      res.writeHead(200, { 'Content-Type': ct });
      var i = 0;
      (function next() { if (res.destroyed) return; if (i >= list.length) { res.end(); return; } res.write(list[i++]); setTimeout(next, gap || 2); })();
    }
    function json(st, o) { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); }
    if (req.url === '/api/tags') return json(200, { models: [{ name: 'llama3.2:latest', size: 2019393189, details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' } },
      { name: 'gemma4:31b', size: 19e9, details: { family: 'gemma4', parameter_size: '31B', quantization_level: 'Q4_K_M' } }] });
    if (req.url === '/v1/models') return json(200, { data: [{ id: 'gemma' }] });
    if (req.url === '/api/chat') {
      if (j.model === 'missing') return json(404, '{"error":"model \\"missing\\" not found, try pulling it first"}');
      if (j.model === 'midfail') return chunks(['{"message":{"content":"par"},"done":false}\n', '{"error":"an error was encountered while running the model"}\n'], 'application/x-ndjson');
      if (j.model === 'slow') { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.write('{"message":{"content":"a"},"done":false}\n'); setTimeout(function () { try { res.end(); } catch (e) {} }, 3000); return; }
      var last = (j.messages || []).slice(-1)[0] || {};
      var answer = /Reply with just the word/.test(last.content) ? 'OK' : 'Hello, café';
      var nd = '{"message":{"role":"assistant","content":"' + answer.slice(0, 3) + '"},"done":false}\n{"message":{"role":"assistant","content":"' + answer.slice(3) + '"},"done":false}\n{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":9,"eval_count":3}\n';
      var buf = Buffer.from(nd, 'utf8'), parts = [], k = 0;
      [7, 33, 61, 64, 65, 66, 90, 120].forEach(function (cut) { if (cut > k && cut < buf.length) { parts.push(buf.slice(k, cut)); k = cut; } });
      parts.push(buf.slice(k));
      return chunks(parts, 'application/x-ndjson');
    }
    if (req.url === '/v1/chat/completions') {
      if (j.model === 'json') return json(200, { choices: [{ message: { role: 'assistant', content: 'whole' }, finish_reason: 'stop' }] });
      if (j.model === 'long') return json(400, '{"error":{"message":"This model\'s maximum context length is 4096 tokens"}}');
      var sse = 'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"Bon"},"finish_reason":null}]}\r\n\r\n: ping\n\n' +
        'data: {"choices":[{"delta":{"content":"jour"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
      return chunks(pieces(sse, [5, 11, 3]), 'text/event-stream');
    }
    // ---- Anthropic ----
    if (req.url.indexOf('/anthropic/v1/') === 0) {
      var key = req.headers['x-api-key'];
      if (!key || key === 'bad') return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' }, request_id: 'req_1' });
      if (req.headers['anthropic-version'] !== '2026-10-21') return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad version' } });
      if (req.url === '/anthropic/v1/models?limit=1000') return json(200, { data: [
        { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000 },
        { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z', max_input_tokens: 200000, max_tokens: 64000 }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-haiku-4-5' });
      if (req.url !== '/anthropic/v1/messages') return json(404, { type: 'error', error: { type: 'not_found_error', message: 'Not found' } });
      if ('temperature' in j) return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'temperature: Extra inputs are not permitted' } });
      if (!(j.max_tokens > 0)) return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: Field required' } });
      if (key === 'nobeta' && req.headers['anthropic-beta']) return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.' } });
      var lastU = (j.messages || []).slice(-1)[0] || {}, q = String(lastU.content || '');
      if (/overload me/.test(q)) return chunks(pieces(anthropicSse([{ type: 'message_start', message: { model: j.model, usage: { input_tokens: 3 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Part' } },
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]), [7, 2, 13]), 'text/event-stream');
      if (/refuse me/.test(q)) return chunks(pieces(anthropicSse([{ type: 'message_start', message: { model: j.model, usage: { input_tokens: 3 } } },
        { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 0 } }, { type: 'message_stop' }]), [9]), 'text/event-stream');
      if (/think first/.test(q)) return chunks(pieces(anthropicSse([{ type: 'message_start', message: { model: j.model, usage: { input_tokens: 3 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me see…' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQ…' } }, { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '42' } },
        { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } }, { type: 'message_stop' }]), [11]), 'text/event-stream');
      var text = /Reply with just the word/.test(q) ? 'OK' : 'Claude says: the answer is “déjà vu” — 😀 done.';
      // split into odd pieces — mid-event, mid-line and in the middle of multi-byte characters
      var sseb = Buffer.from(anthropicAnswer(text, /cut me/.test(q) ? 'max_tokens' : 'end_turn', j.model), 'utf8'), cuts = [], kk = 0, step = 1;
      while (kk < sseb.length) { cuts.push(sseb.slice(kk, kk + step)); kk += step; step = step % 17 + 3; }
      return chunks(cuts, 'text/event-stream; charset=utf-8', 1);
    }
    res.writeHead(404); res.end('404 page not found');
  });
});
var PORT = 0, BASE = '', ANT = '';
test('(fake model servers start)', function () {
  return new Promise(function (r) { server.listen(0, '127.0.0.1', function () { PORT = server.address().port; BASE = 'http://127.0.0.1:' + PORT; ANT = BASE + '/anthropic/v1'; r(); }); });
});
test('engine: Ollama NDJSON streamed in odd pieces → whole text, deltas, usage', function () {
  var deltas = [];
  return C.chatStream(fetch, { kind: 'ollama', base: BASE, model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }], onDelta: function (d, full) { deltas.push([d, full]); } }).then(function (r) {
    assert.strictEqual(r.text, 'Hello, café');
    assert.strictEqual(r.reason, 'stop');
    assert.deepStrictEqual(r.usage, { prompt: 9, output: 3 });
    assert.deepStrictEqual(deltas, [['Hel', 'Hel'], ['lo, café', 'Hello, café']]);
  });
});
test('engine: OpenAI SSE in pieces, finish_reason length, usage chunk, API key header', function () {
  hits = [];
  return C.chatStream(fetch, { kind: 'openai', provider: 'custom', base: BASE + '/v1', apiKey: 'k1', model: 'gemma', messages: [{ role: 'user', content: 'x' }] }).then(function (r) {
    assert.strictEqual(r.text, 'Bonjour');
    assert.strictEqual(r.reason, 'length');
    assert.deepStrictEqual(r.usage, { prompt: 4, output: 2 });
    assert.strictEqual(hits[0].headers.authorization, 'Bearer k1');
  });
});
test('engine: Anthropic SSE split mid-event and mid-character → the exact text, model, usage', function () {
  hits = [];
  var deltas = [];
  return C.chatStream(fetch, { kind: 'anthropic', provider: 'anthropic', base: ANT, apiKey: 'sk-ant-T', model: 'claude-opus-5-5',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Hi' }], temperature: 0.7, maxTokens: 500, onDelta: function (d, full) { deltas.push(full); } }).then(function (r) {
    assert.strictEqual(r.text, 'Claude says: the answer is “déjà vu” — 😀 done.');
    assert.strictEqual(r.reason, 'stop');
    assert.strictEqual(r.model, 'claude-opus-5-5');
    assert.deepStrictEqual(r.usage, { prompt: 0, output: 9 });
    assert.ok(deltas.length > 3 && deltas[deltas.length - 1] === r.text);
    var h = hits[0];
    assert.strictEqual(h.url, '/anthropic/v1/messages');
    assert.strictEqual(h.headers['x-api-key'], 'sk-ant-T');
    assert.strictEqual(h.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.strictEqual(h.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.strictEqual(h.body.system, 'sys'); assert.strictEqual(h.body.max_tokens, 500); assert.strictEqual(h.body.fallbacks, 'default');
  });
});
test('engine: Anthropic max_tokens → length, refusal, thinking blocks, an error event mid-stream keeps the partial', function () {
  var q = function (t) { return [{ role: 'user', content: t }]; }, o = { kind: 'anthropic', provider: 'anthropic', base: ANT, apiKey: 'sk-ant-T', model: 'claude-haiku-4-5' };
  return C.chatStream(fetch, Object.assign({}, o, { messages: q('cut me') })).then(function (r) {
    assert.strictEqual(r.reason, 'length');
    return C.chatStream(fetch, Object.assign({}, o, { messages: q('refuse me') }));
  }).then(function (r) {
    assert.deepStrictEqual([r.text, r.reason], ['', 'refusal']);
    var th = [];
    return C.chatStream(fetch, Object.assign({}, o, { messages: q('think first'), onThinking: function (t) { th.push(t); } })).then(function (r2) {
      assert.strictEqual(r2.text, '42'); assert.strictEqual(r2.thinking, 'Let me see…'); assert.ok(th.length >= 1);
    });
  }).then(function () {
    return rejects(C.chatStream(fetch, Object.assign({}, o, { messages: q('overload me') })), 'busy');
  }).then(function (e) { assert.strictEqual(e.partial, 'Part'); });
});
test('engine: Anthropic without the fallback beta → asked once more without it; a bad key is "auth"; no key is "key-missing"', function () {
  hits = [];
  return C.chatStream(fetch, { kind: 'anthropic', provider: 'anthropic', base: ANT, apiKey: 'nobeta', model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'Hi' }] }).then(function (r) {
    assert.ok(/déjà vu/.test(r.text));
    assert.strictEqual(hits.length, 2);
    assert.ok(hits[0].headers['anthropic-beta'] && !hits[1].headers['anthropic-beta'] && !('fallbacks' in hits[1].body));
    return rejects(C.chatStream(fetch, { kind: 'anthropic', provider: 'anthropic', base: ANT, apiKey: 'bad', model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'Hi' }] }), 'auth');
  }).then(function () {
    var n = hits.length;
    return rejects(C.chatStream(fetch, { kind: 'anthropic', provider: 'anthropic', base: ANT, apiKey: '', model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'Hi' }] }), 'key-missing')
      .then(function () { assert.strictEqual(hits.length, n, 'nothing sent without a key'); });
  });
});
test('engine: Anthropic model list over the wire', function () {
  return C.listModels(fetch, { kind: 'anthropic', provider: 'anthropic', base: ANT, apiKey: 'sk-ant-T' }).then(function (r) {
    assert.deepStrictEqual(r.models.map(function (m) { return [m.id, m.ctx]; }), [['claude-opus-5-5', 1000000], ['claude-haiku-4-5', 200000]]);
    return rejects(C.listModels(fetch, { kind: 'anthropic', provider: 'anthropic', base: ANT, apiKey: 'bad' }), 'auth');
  });
});
test('engine: plain JSON answers, missing model, context too long, error mid-stream', function () {
  return C.chatStream(fetch, { kind: 'openai', base: BASE + '/v1', model: 'json', messages: [{ role: 'user', content: 'x' }] }).then(function (r) {
    assert.strictEqual(r.text, 'whole');
    return rejects(C.chatStream(fetch, { kind: 'ollama', base: BASE, model: 'missing', messages: [{ role: 'user', content: 'x' }] }), 'model');
  }).then(function () {
    return rejects(C.chatStream(fetch, { kind: 'openai', base: BASE + '/v1', model: 'long', messages: [{ role: 'user', content: 'x' }] }), 'context');
  }).then(function () {
    return rejects(C.chatStream(fetch, { kind: 'ollama', base: BASE, model: 'midfail', messages: [{ role: 'user', content: 'x' }] }), 'server');
  }).then(function (e) { assert.strictEqual(e.partial, 'par'); });
});
test('engine: Stop aborts (partial kept), silence times out, nothing listening is a network error', function () {
  var ac = new AbortController();
  return rejects(C.chatStream(fetch, { kind: 'ollama', base: BASE, model: 'slow', messages: [{ role: 'user', content: 'x' }], signal: ac.signal,
    onDelta: function () { setTimeout(function () { ac.abort(); }, 20); } }), 'aborted').then(function (e) {
    assert.strictEqual(e.partial, 'a');
    return rejects(C.chatStream(fetch, { kind: 'ollama', base: BASE, model: 'slow', messages: [{ role: 'user', content: 'x' }], timeoutMs: 200 }), 'timeout');
  }).then(function () {
    return rejects(C.chatStream(fetch, { kind: 'ollama', base: 'http://127.0.0.1:9', model: 'm', messages: [{ role: 'user', content: 'x' }] }), 'network');
  });
});
test('probe: ok, down, the no-cors “blocked” case; LAN addresses get targetAddressSpace', function () {
  return C.probe(fetch, BASE + '/api/tags').then(function (p) {
    assert.strictEqual(p.state, 'ok');
    return C.probe(fetch, 'http://127.0.0.1:9/api/tags', { timeoutMs: 1000 });
  }).then(function (p) {
    assert.strictEqual(p.state, 'down');
    var stub = function (u, init) { return init.mode === 'no-cors' ? Promise.resolve({ type: 'opaque', status: 0 }) : Promise.reject(new TypeError('Failed to fetch')); };
    return C.probe(stub, 'http://127.0.0.1:11434/api/tags');
  }).then(function (p) {
    assert.strictEqual(p.state, 'blocked');
    var seen = null, stub2 = function (u, init) { seen = init; return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve('{"models":[]}'); } }); };
    return C.listModels(stub2, { kind: 'ollama', base: 'http://192.168.1.9:11434', Request: function () {} }).then(function () {
      assert.strictEqual(seen.targetAddressSpace, 'local');
      return C.listModels(stub2, { kind: 'ollama', base: 'http://127.0.0.1:11434', Request: function () {} });
    }).then(function () { assert.strictEqual(seen.targetAddressSpace, undefined, 'never for loopback'); });
  });
});

// ---- badges --------------------------------------------------------------------------------------------
test('badges: one spelling for a model name across providers, OpenRouter and LMArena', function () {
  var same = [
    ['anthropic/claude-opus-5.5', 'claude-opus-5-5', 'Claude Opus 5.5 (High)'],
    ['claude-opus-4-5-20251101', 'Claude Opus 4.5 (20251101)'],
    ['gpt-5.5', 'openai/gpt-5.5', 'GPT-5.5'],
    ['llama3.3:70b', 'Llama 3.3 70B Instruct', 'meta-llama/llama-3.3-70b-instruct:free'],
    ['gemma4:31b', 'Gemma 4 31B', 'google/gemma-4-31b-it'],
    ['qwen2.5:7b-instruct-q4_K_M', 'Qwen2.5-7B-Instruct'],
    ['models/gemini-3-pro', 'Gemini 3 Pro']
  ];
  same.forEach(function (g) { g.forEach(function (n) { assert.strictEqual(C.normName(n), C.normName(g[0]), n + ' ~ ' + g[0]); }); });
  assert.notStrictEqual(C.normName('claude-opus-5'), C.normName('claude-opus-5-5'));
  assert.notStrictEqual(C.normName('gemini-3-pro-preview'), C.normName('Gemini 3.1 Pro Preview'));
  assert.notStrictEqual(C.normName('gpt-5.5-mini'), C.normName('gpt-5.5'));
});
test('badges: score index — a plain entry beats its variants, else the best variant; dated', function () {
  var sc = C.scoreIndex([['Claude Opus 4.6 (High)', 1501], ['Claude Opus 4.6', 1497], ['Claude Opus 5.5 (High)', 1516], ['Claude Opus 5.5 (Low)', 1490],
    { model_name: 'GPT-5.5', rating: 1467.4, leaderboard_publish_date: '2026-10-20' }, ['broken', 'x']]);
  assert.strictEqual(sc.date, '2026-10-20');
  assert.deepStrictEqual(sc.byKey['claude-opus-4-6'], { r: 1497, n: 'Claude Opus 4.6', plain: true });
  assert.deepStrictEqual(sc.byKey['claude-opus-5-5'], { r: 1516, n: 'Claude Opus 5.5 (High)', plain: false });
  assert.strictEqual(sc.byKey['gpt-5-5'].r, 1467);
  assert.strictEqual(sc.count, 3);
});
test('badges: the dated snapshot (ai-scores.js) is sound and cites its source', function () {
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(SCORES.date));
  assert.ok(/LMArena/.test(SCORES.source) && /CC BY 4\.0/.test(SCORES.source));
  assert.ok(SCORES.rows.length >= 300, SCORES.rows.length + ' rows');
  SCORES.rows.forEach(function (r) { assert.ok(typeof r[0] === 'string' && r[0] && isFinite(r[1]) && r[1] > 800 && r[1] < 2000, JSON.stringify(r)); });
  var src = fs.readFileSync(path.join(__dirname, 'ai-scores.js'), 'utf8');
  assert.ok(/lmarena-ai\/leaderboard-dataset/.test(src) && /CC BY 4\.0/.test(src) && /fetched \d{4}-\d{2}-\d{2}/.test(src), 'the file says where and when');
  var sc = C.scoreIndex(SCORES.rows, SCORES.date);
  assert.ok(sc.byKey[C.normName('claude-opus-5-5')] && sc.byKey[C.normName('gpt-5.5')] && sc.byKey[C.normName('gemma4:31b')]);
});
test('badges: catalog index (OpenRouter) skips :free / variable prices; enrich fills price, context, score — never guessed', function () {
  var cat = C.catalogIndex({ data: [
    { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', context_length: 1000000, pricing: { prompt: '0.000004', completion: '0.00002' } },
    { id: 'openai/gpt-5.5', name: 'OpenAI: GPT-5.5', context_length: 1050000, pricing: { prompt: '0.000005', completion: '0.00003' } },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'x', pricing: { prompt: '0', completion: '0' } },
    { id: 'openrouter/auto', name: 'Auto', pricing: { prompt: '-1', completion: '-1' } }] }, 1761100000000);
  assert.deepStrictEqual(Object.keys(cat.byKey).sort(), ['anthropic/claude-opus-5-5', 'openai/gpt-5-5']);
  var sc = C.scoreIndex([['Claude Opus 5.5 (High)', 1516], ['GPT-5.5', 1467], ['Gemma 4 31B', 1443], ['Llama 3.2 3B Instruct', 1110], ['DeepSeek-R1', 1373], ['Llama 3.3 70B Instruct', 1274]], '2026-10-20');
  var ctx = { catalog: cat, scores: sc };
  var an = C.enrich([{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', ctx: 0 }, { id: 'claude-nova-9', name: 'Claude Nova 9' }], 'anthropic', ctx);
  assert.deepStrictEqual([an[0].where, an[0].price, an[0].priceSrc, an[0].ctx, an[0].score], ['cloud', { in: 4, out: 20 }, 'openrouter', 1000000, { r: 1516, n: 'Claude Opus 5.5 (High)', date: '2026-10-20' }]);
  assert.deepStrictEqual([an[1].price, an[1].score], [undefined, undefined], 'unknown model → no price, no score');
  var oa = C.enrich([{ id: 'gpt-5.5', ctx: 0 }], 'openai', ctx)[0];
  assert.deepStrictEqual([oa.price.in, oa.ctx, oa.score.r], [5, 1050000, 1467]);
  var gq = C.enrich([{ id: 'llama-3.3-70b-versatile' }], 'groq', ctx)[0];
  assert.strictEqual(gq.price, undefined, 'Groq’s own price isn’t OpenRouter’s Meta price: none shown');
  var tg = C.enrich([{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', price: { in: 0.88, out: 0.88 } }], 'together', ctx)[0];
  assert.deepStrictEqual([tg.price.in, tg.priceSrc], [0.88, 'together'], 'a provider’s own price wins');
  var ol = C.enrich([{ id: 'gemma4:31b', params: '31B' }, { id: 'llama3.2:latest', params: '3.2B' }, { id: 'deepseek-r1:latest', params: '8.2B' }, { id: 'deepseek-r1', params: '' }, { id: 'llama3.3:70b', params: '70.6B' }], 'ollama', ctx);
  assert.deepStrictEqual(ol.map(function (m) { return m.score ? m.score.r : 0; }), [1443, 1110, 0, 0, 1274],
    'a size-tagged Ollama model matches by name; an untagged one only with its size (deepseek-r1:latest is the 8B distill, not DeepSeek-R1)');
  assert.deepStrictEqual([ol[0].where, ol[0].price, ol[0].priceSrc], ['local', { in: 0, out: 0 }, 'local']);
  var orr = C.enrich([{ id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', price: { in: 4, out: 20 } }], 'openrouter', ctx)[0];
  assert.strictEqual(orr.score.r, 1516);
});
test('badges: what a model shows, with tooltips naming the sources', function () {
  var b = C.badges({ where: 'cloud', price: { in: 4, out: 20 }, priceSrc: 'openrouter', ctx: 1000000, score: { r: 1516, n: 'Claude Opus 5.5 (High)', date: '2026-10-20' } }, { catalogDate: '2026-10-22' });
  assert.deepStrictEqual(b.map(function (x) { return x.k + ':' + x.t; }), ['cloud:Cloud', 'price:$4 · $20', 'ctx:1M', 'score:★1516']);
  assert.ok(/OpenRouter’s public model list, 2026-10-22/.test(b[1].title));
  assert.ok(/LMArena text score 1516/.test(b[3].title) && /as of 2026-10-20/.test(b[3].title) && /CC BY 4\.0/.test(b[3].title) && /Claude Opus 5\.5 \(High\)/.test(b[3].title));
  var l = C.badges({ where: 'local', params: '3.2B', quant: 'Q4_K_M', size: 2019393189, price: { in: 0, out: 0 } });
  assert.deepStrictEqual(l.map(function (x) { return x.k + ':' + x.t; }), ['local:Local', 'size:3.2B Q4']);
  assert.deepStrictEqual(C.badges({ where: 'cloud' }).map(function (x) { return x.k; }), ['cloud'], 'nothing known → nothing shown');
  assert.strictEqual(C.fmtPrice({ in: 0.1, out: 0.32 }), '$0.1 · $0.32');
  assert.strictEqual(C.fmtPrice({ in: 0, out: 0 }), 'Free');
  assert.strictEqual(C.fmtCtx(131072), '131K'); assert.strictEqual(C.fmtCtx(1048576), '1M'); assert.strictEqual(C.fmtCtx(0), '');
});

// ---- context ---------------------------------------------------------------------------------------------
test('tokens and budget (a cloud model’s own window counts, up to 200K)', function () {
  assert.strictEqual(C.estTokens(''), 0);
  assert.strictEqual(C.estTokens('abcdefgh'), 2);
  assert.strictEqual(C.estTokens('日本語'), 3);
  assert.strictEqual(C.budget({ contextWindow: 0, maxTokens: 1024 }), 4096 - 1024 - 48);
  assert.strictEqual(C.budget({ contextWindow: 2048, maxTokens: 4000 }), 2048 - 1024 - 48, 'the answer gets at most half');
  assert.strictEqual(C.budget({ contextWindow: 300, maxTokens: 64 }), 256, 'never below 256');
  assert.strictEqual(C.budget({ contextWindow: 0, maxTokens: 4096, modelCtx: 1000000 }), 200000 - 4096 - 48);
  assert.strictEqual(C.budget({ contextWindow: 8192, maxTokens: 1024, modelCtx: 1000000 }), 8192 - 1024 - 48, 'the Ollama setting wins');
});
test('fitText keeps the start and the end; assemble fits history and context', function () {
  var long = '';
  for (var i = 0; i < 2000; i++) long += 'Line ' + i + ' of the note.\n';
  var f = C.fitText(long, 500);
  assert.ok(f.trimmed && C.estTokens(f.text) <= 520 && f.text.indexOf('Line 0 of the note.') === 0 && /Line 1999 of the note\.\n$/.test(f.text));
  var hist = [];
  for (var j = 0; j < 30; j++) hist.push({ role: j % 2 ? 'assistant' : 'user', content: 'turn ' + j + ' ' + new Array(200).join('x') });
  var a = C.assemble({ system: 'Be brief.', history: hist, instruction: 'Summarise this.', ctx: { label: 'Selected text', text: 'The cat sat.' }, budget: 600 });
  assert.strictEqual(a.messages[0].role, 'system');
  assert.strictEqual(a.messages[1].role, 'user');
  assert.strictEqual(a.messages[a.messages.length - 1].content, 'Summarise this.\n\n--- Selected text ---\nThe cat sat.\n--- end ---');
  assert.ok(a.dropped > 0 && a.tokens <= 600);
  assert.strictEqual(C.ACTIONS.length, 6);
});

// ---- relay pieces ---------------------------------------------------------------------------------------
test('batcher and reassembler', function () {
  var now = 0, timers = [], out = [];
  var b = C.createBatcher({ interval: 150, max: 10, emit: function (x) { out.push([now, x]); }, now: function () { return now; },
    set: function (f, ms) { timers.push({ at: now + ms, f: f }); return timers.length; }, clear: function (id) { if (timers[id - 1]) timers[id - 1].f = null; } });
  function tick(ms) { now += ms; timers.forEach(function (t) { if (t.f && t.at <= now) { var f = t.f; t.f = null; f(); } }); }
  b.add('A'); tick(20); b.add('b'); tick(20); b.add('c'); tick(110);
  assert.deepStrictEqual(out, [[0, 'A'], [150, 'bc']]);
  tick(10); b.add('0123456789abcdef');
  assert.deepStrictEqual(out.slice(2).map(function (x) { return x[1]; }), ['0123456789', 'abcdef']);
  assert.deepStrictEqual(C.splitSafe('ab😀cd', 3), ['ab', '😀c', 'd']);
  var got = [], r = C.createReassembler(function (m) { got.push(m.q); });
  [3, 1, 1, 2, 5, 4, 2, 6].forEach(function (q) { r.add({ q: q }); });
  assert.deepStrictEqual(got, [1, 2, 3, 4, 5, 6]);
});
test('requests: which shared model and the text — never a key or an address; validated and clamped', function () {
  var q = C.makeRequest({ id: 'abc123def456', from: 'dev1-tab', name: 'iPhone', kind: 'phone', did: 'dev1', provider: 'anthropic', model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'hi' }], temperature: 9, maxTokens: 999999, apiKey: 'sk-ant-LEAK', base: 'https://api.anthropic.com/v1' });
  var s = JSON.stringify(q);
  assert.ok(s.indexOf('LEAK') < 0 && s.indexOf('api.anthropic.com') < 0, s);
  assert.deepStrictEqual(Object.keys(q).sort(), ['d', 'f', 'id', 'k', 'messages', 'model', 'n', 'opt', 'p', 'v']);
  var ok = C.validateRequest(q);
  assert.ok(ok.ok);
  assert.deepStrictEqual([ok.req.provider, ok.req.model, ok.req.temperature, ok.req.maxTokens], ['anthropic', 'claude-opus-5-5', 2, C.RELAY.MAX_TOKENS]);
  assert.strictEqual(C.validateRequest(Object.assign({}, q, { p: '../x' })).req.provider, '', 'a strange provider id is dropped');
  function bad(o, code) { var v = C.validateRequest(o); assert.ok(!v.ok); assert.strictEqual(v.code, code); }
  var base = { v: 2, id: 'abc123def456', f: 'a-b', messages: [{ role: 'user', content: 'x' }] };
  bad(Object.assign({}, base, { v: 3 }), 'version');
  bad(Object.assign({}, base, { id: '../x' }), 'bad');
  bad(Object.assign({}, base, { messages: [{ role: 'tool', content: 'x' }] }), 'bad');
  bad(Object.assign({}, base, { messages: [{ role: 'user', content: new Array(C.RELAY.REQ_MAX + 2).join('a') }] }), 'too-big');
  assert.ok(C.validateRequest(Object.assign({}, base, { v: 1 })).ok, 'a round-1 phone is still answered');
});
// A host's configuration as the service builds it.
function hostCfg(o) {
  o = o || {};
  var sc = C.scoreIndex([['Claude Opus 5.5 (High)', 1516], ['Llama 3.2 3B Instruct', 1110]], '2026-10-20');
  return {
    endpoints: [
      { id: 'ollama', provider: 'ollama', label: 'Ollama', where: 'local', ok: true, on: true, allow: o.allow || null,
        models: C.enrich([{ id: 'llama3.2:latest', name: 'llama3.2:latest', params: '3.2B', quant: 'Q4_K_M', size: 2019393189 }, { id: 'qwen2.5:7b', name: 'qwen2.5:7b' }, { id: 'nomic-embed-text', name: 'nomic-embed-text', embed: true }], 'ollama', { scores: sc }) },
      { id: 'anthropic', provider: 'anthropic', label: 'Anthropic', where: 'cloud', ok: true, on: true, allow: null,
        models: C.enrich([{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', ctx: 1000000, price: { in: 4, out: 20 } }, { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', ctx: 200000 }], 'anthropic', { scores: sc }) }
    ],
    shareCloud: !!o.shareCloud, defaultModel: o.dm || null, scoresDate: '2026-10-20', catalogDate: '2026-10-22'
  };
}
test('presence: only what is shared — cloud services only with "share cloud", allow-lists, names and badges, never a key or URL', function () {
  var p = C.buildPresence(hostCfg());
  assert.deepStrictEqual(p.prov.map(function (x) { return x.id; }), ['ollama'], 'cloud off by default');
  assert.deepStrictEqual(p.prov[0].m.map(function (m) { return m.i; }), ['llama3.2:latest', 'qwen2.5:7b'], 'no embedding models');
  assert.deepStrictEqual(p.prov[0].m[0], { i: 'llama3.2:latest', p: [0, 0], s: [1110, 'Llama 3.2 3B Instruct'], z: '3.2B', qt: 'Q4_K_M', b: 2019393189 });
  var c = C.buildPresence(hostCfg({ shareCloud: true, allow: ['qwen2.5:7b'], dm: { ep: 'anthropic', model: 'claude-opus-5-5' } }));
  assert.deepStrictEqual(c.prov.map(function (x) { return x.id + ':' + x.w; }), ['ollama:local', 'anthropic:cloud']);
  assert.deepStrictEqual(c.prov[0].m.map(function (m) { return m.i; }), ['qwen2.5:7b'], 'the allow-list');
  assert.deepStrictEqual(c.prov[1].m[0], { i: 'claude-opus-5-5', n: 'Claude Opus 5.5', c: 1000000, p: [4, 20], s: [1516, 'Claude Opus 5.5 (High)'] });
  assert.strictEqual(c.dm, 'anthropic:claude-opus-5-5');
  var cfg = hostCfg({ shareCloud: true });
  cfg.endpoints[1].apiKey = 'sk-ant-SECRET'; cfg.endpoints[1].base = 'https://api.anthropic.com/v1'; cfg.endpoints[0].base = 'http://127.0.0.1:11434';
  var js = JSON.stringify(C.buildPresence(cfg));
  assert.ok(js.indexOf('SECRET') < 0 && js.indexOf('api.anthropic.com') < 0 && js.indexOf('11434') < 0, 'no key, no address: ' + js);
  var keep = C.RELAY.PRESENCE_MODELS;
  C.RELAY.PRESENCE_MODELS = 1;
  try { var capped = C.buildPresence(hostCfg()); assert.deepStrictEqual([capped.prov[0].m.length, capped.prov[0].more], [1, 1]); } finally { C.RELAY.PRESENCE_MODELS = keep; }
});
test('presence: parsed back with providers, badges and busy; round-1 hosts still listed; stale and own entries dropped', function () {
  var now = 1e12, body = C.buildPresence(hostCfg({ shareCloud: true }));
  var o = Object.assign({ v: 2, n: 'MacBook', k: 'desktop', d: 'mac1', pol: 'ask', ok: true }, body);
  var list = C.parsePresence([
    { inst: 'mac1-a', at: now - 500, o: o, b: { busy: true, q: 2 } },
    { inst: 'old1-a', at: now - 1000, o: { n: 'Old PC', d: 'old1', m: ['llama3.2'], dm: 'llama3.2', ok: true } },
    { inst: 'gone-1', at: now - 100000, o: { n: 'Gone', d: 'gone' } },
    { inst: 'me-1', at: now - 10, o: { n: 'Me', d: 'me', prov: [] } }
  ], now, 'me');
  assert.deepStrictEqual(list.map(function (h) { return h.name; }), ['MacBook', 'Old PC']);
  var h = list[0];
  assert.deepStrictEqual([h.busy, h.queue, h.policy, h.ok, h.dm], [true, 2, 'ask', true, '']);
  assert.deepStrictEqual(h.providers.map(function (p) { return p.id + ':' + p.where + ':' + p.models.length; }), ['ollama:local:2', 'anthropic:cloud:2']);
  var opus = h.providers[1].models[0];
  assert.deepStrictEqual([opus.name, opus.ctx, opus.price, opus.score.r, opus.score.date, opus.where], ['Claude Opus 5.5', 1000000, { in: 4, out: 20 }, 1516, '2026-10-20', 'cloud']);
  assert.deepStrictEqual(h.models, ['llama3.2:latest', 'qwen2.5:7b', 'claude-opus-5-5', 'claude-haiku-4-5']);
  assert.deepStrictEqual(list[1].providers.map(function (p) { return p.id + ':' + p.models.map(function (m) { return m.id; }); }), ['ollama:llama3.2']);
  assert.strictEqual(C.pickHost(list, '', 'anthropic').name, 'MacBook');
  assert.strictEqual(C.pickHost(list, 'old1', 'anthropic').name, 'MacBook', 'the preferred device doesn’t offer it → one that does');
  assert.strictEqual(C.pickHost(list, 'old1').name, 'Old PC');
  assert.strictEqual(C.pickHost(list, '', 'openai'), null);
  assert.deepStrictEqual(C.hostDefault(h), { ep: 'ollama', model: 'llama3.2:latest' });
  h.dm = 'anthropic:claude-haiku-4-5';
  assert.deepStrictEqual(C.hostDefault(h), { ep: 'anthropic', model: 'claude-haiku-4-5' });
});
test('a host answers only what it shares, checked against its own configuration', function () {
  var off = hostCfg();
  assert.deepStrictEqual(C.resolveShared(off, 'anthropic', 'claude-opus-5-5').code, 'not-shared', 'cloud not shared');
  assert.deepStrictEqual(C.resolveShared(off, '', 'claude-opus-5-5').code, 'not-shared');
  var r = C.resolveShared(off, 'ollama', 'llama3.2:latest');
  assert.ok(r.ok && r.ep.id === 'ollama' && r.model === 'llama3.2:latest');
  assert.strictEqual(C.resolveShared(off, '', '').model, 'llama3.2:latest', 'nothing named → its first shared model');
  assert.strictEqual(C.resolveShared(off, 'ollama', 'nomic-embed-text').code, 'model');
  assert.strictEqual(C.resolveShared(off, 'ollama', 'gone:1b').code, 'model');
  var al = hostCfg({ allow: ['qwen2.5:7b'] });
  assert.strictEqual(C.resolveShared(al, 'ollama', 'llama3.2:latest').code, 'not-shared', 'not on the allow-list');
  assert.strictEqual(C.resolveShared(al, 'ollama', '').model, 'qwen2.5:7b');
  var on = hostCfg({ shareCloud: true, dm: { ep: 'anthropic', model: 'claude-haiku-4-5' } });
  assert.strictEqual(C.resolveShared(on, 'anthropic', 'claude-opus-5-5').model, 'claude-opus-5-5');
  assert.strictEqual(C.resolveShared(on, 'anthropic', '').model, 'claude-haiku-4-5', 'the host’s default');
  on.endpoints[1].on = false;
  assert.strictEqual(C.resolveShared(on, 'anthropic', 'claude-opus-5-5').code, 'not-shared', 'a switched-off service');
});

// ---- relay end-to-end over an in-memory cloud ----------------------------------------------------------------
function fakeCloud() {
  var tree = {}, ls = [], writes = [], sealedLog = [];
  function parts(p) { return p.split('/').filter(Boolean); }
  function get(p) { var n = tree, a = parts(p); for (var i = 0; i < a.length; i++) { if (!n || typeof n !== 'object') return null; n = n[a[i]]; } return n == null ? null : n; }
  function clone(v) { return v == null ? null : JSON.parse(JSON.stringify(v)); }
  function put(p, v) {
    var before = ls.map(function (l) { return JSON.stringify(get(l.path)); });
    var a = parts(p), n = tree;
    for (var i = 0; i < a.length - 1; i++) { if (!n[a[i]] || typeof n[a[i]] !== 'object') n[a[i]] = {}; n = n[a[i]]; }
    if (v == null) delete n[a[a.length - 1]]; else n[a[a.length - 1]] = clone(v);
    (function prune(node, ks) { if (!ks.length) return; var k = ks[0], c = node[k]; if (c && typeof c === 'object') { prune(c, ks.slice(1)); if (!Object.keys(c).length) delete node[k]; } })(tree, a.slice(0, -1));
    writes.push(JSON.stringify([p, v]));
    ls.slice().forEach(function (l, i) {
      var now = get(l.path), was = before[i] == null || before[i] === 'null' ? null : JSON.parse(before[i]);
      if (JSON.stringify(now) === before[i]) return;
      setTimeout(function () {
        if (ls.indexOf(l) < 0) return;
        if (l.ev === 'value') l.fn(snap(l.path, now));
        else if (l.ev === 'child_added') {
          var w = was && typeof was === 'object' ? was : {}, nw = now && typeof now === 'object' ? now : {};
          Object.keys(nw).forEach(function (k) { if (!(k in w)) l.fn(snap(l.path + '/' + k, nw[k])); });
        }
      }, 1 + Math.floor(Math.random() * 3));
    });
    return Promise.resolve();
  }
  function snap(p, v) { var a = parts(p); return { key: a[a.length - 1], val: function () { return clone(v); }, ref: ref(p) }; }
  var disc = [];
  function ref(p) {
    return {
      path: p,
      child: function (c) { return ref(p + '/' + c); },
      set: function (v) { return put(p, v); },
      remove: function () { return put(p, null); },
      once: function () { return Promise.resolve(snap(p, get(p))); },
      on: function (ev, fn) {
        var l = { path: p, ev: ev, fn: fn }; ls.push(l);
        var cur = get(p);
        setTimeout(function () {
          if (ls.indexOf(l) < 0) return;
          if (ev === 'value') fn(snap(p, cur));
          else if (ev === 'child_added' && cur && typeof cur === 'object') Object.keys(cur).forEach(function (k) { fn(snap(p + '/' + k, cur[k])); });
        }, 0);
        return fn;
      },
      off: function (ev, fn) { ls = ls.filter(function (l) { return !(l.path === p && l.ev === ev && l.fn === fn); }); },
      onDisconnect: function () { return { remove: function () { disc.push(p); }, cancel: function () { disc = disc.filter(function (x) { return x !== p; }); } }; }
    };
  }
  var cloud = {
    ref: function (sub) { return Promise.resolve(ref('rooms/__cade_ai_fp/' + sub)); },
    // what goes out sealed is logged in the clear: the key-leak checks read it
    seal: function (o) { var s = JSON.stringify(o); sealedLog.push(s); return Promise.resolve('S:' + s); },
    unseal: function (s) { return new Promise(function (r) { setTimeout(function () { r(typeof s === 'string' && s.indexOf('S:') === 0 ? JSON.parse(s.slice(2)) : null); }, Math.floor(Math.random() * 6)); }); },
    ts: function () { return Date.now(); },
    now: function () { return Date.now(); }
  };
  return { cloud: cloud, tree: function () { return tree; }, get: get, put: put, listeners: function () { return ls.length; }, sealed: function () { return sealedLog; }, writes: function () { return writes; } };
}
var FAST = { BATCH_MS: 15, ACK_MS: 400, ASK_MS: 300, KEEPALIVE_MS: 50, FIRST_MIN_MS: 600, BEAT_MS: 1000 };
function mkHost(fc, o) {
  o = o || {};
  var runs = [], cfg = o.cfg || hostCfg();
  var h = C.createRelayHost({
    cloud: fc.cloud, limits: Object.assign({}, FAST, o.limits || {}),
    device: function () { return { inst: 'mac1-t1', name: 'MacBook', kind: 'desktop', id: 'mac1' }; },
    info: function () { var p = C.buildPresence(cfg); p.ok = true; return p; },
    resolve: function (req) { return C.resolveShared(cfg, req.provider, req.model); },
    policy: function () { return o.policy || 'auto'; },
    ask: o.ask,
    run: o.run || function (job, hh) {
      runs.push(job);
      hh.model(job.target.model);
      return new Promise(function (resolve, reject) {
        var words = (o.answer || 'The quick brown fox jumps over the lazy dog').split(/(?= )/), i = 0;
        var t = setInterval(function () {
          if (hh.signal && hh.signal.aborted) { clearInterval(t); var e = new Error('aborted'); e.name = 'AbortError'; reject(e); return; }
          if (i >= words.length) { clearInterval(t); resolve({ reason: 'stop', usage: { prompt: 3, output: words.length }, model: job.target.model }); return; }
          hh.onDelta(words[i++]);
        }, o.gap || 5);
      });
    }
  });
  h.runs = runs; h.cfg = cfg;
  return h;
}
function mkClient(fc, inst, limits) {
  return C.createRelayClient({ cloud: fc.cloud, limits: Object.assign({}, FAST, limits || {}),
    device: function () { return { inst: inst, name: 'iPhone', kind: 'phone', id: inst.split('-')[0] }; } });
}
test('relay: the phone picks a shared model, the host streams, the answer arrives whole and in order; nothing left behind', function () {
  var fc = fakeCloud(), host = mkHost(fc), cl = mkClient(fc, 'ph1-x');
  var deltas = [], events = [];
  return host.start().then(function (ok) {
    assert.ok(ok);
    return cl.listHosts();
  }).then(function (hosts) {
    assert.strictEqual(hosts.length, 1);
    assert.deepStrictEqual(hosts[0].providers.map(function (p) { return p.id; }), ['ollama']);
    return cl.request(hosts[0], { provider: 'ollama', model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'Say the fox line' }], temperature: 0.5, maxTokens: 100 },
      { onDelta: function (d, full) { deltas.push(full); }, onEvent: function (m) { events.push(m); }, timeoutMs: 2000 });
  }).then(function (r) {
    assert.strictEqual(r.text, 'The quick brown fox jumps over the lazy dog');
    assert.strictEqual(r.model, 'qwen2.5:7b');
    deltas.forEach(function (d, i) { if (i) assert.ok(d.indexOf(deltas[i - 1]) === 0, 'grows in order'); });
    var s = events.filter(function (m) { return m.t === 's'; })[0];
    assert.deepStrictEqual([s.model, s.p], ['qwen2.5:7b', 'ollama'], 'started: which model, which service');
    assert.strictEqual(host.runs[0].req.provider, 'ollama');
    return wait(60);
  }).then(function () {
    var t = fc.tree().rooms.__cade_ai_fp;
    assert.ok(!t.req && !t.res, 'request and answer removed');
    assert.ok(t.hosts && t.hosts['mac1-t1'] && typeof t.hosts['mac1-t1'].b === 'string', 'presence (with its busy note) stays while sharing');
    return host.stop();
  }).then(function () {
    assert.ok(!fc.get('rooms/__cade_ai_fp/hosts/mac1-t1'), 'presence withdrawn');
    assert.strictEqual(fc.listeners(), 0, 'no listeners left');
  });
});
test('relay: a cloud model the host doesn’t share is refused by the host (even if the phone asks for it)', function () {
  var fc = fakeCloud(), host = mkHost(fc), cl = mkClient(fc, 'ph1-n'), h = { inst: 'mac1-t1', name: 'MacBook' };
  return host.start().then(function () {
    return rejects(cl.request(h, { provider: 'anthropic', model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] }, { timeoutMs: 2000 }), 'not-shared');
  }).then(function () {
    assert.strictEqual(host.runs.length, 0, 'nothing ran');
    host.cfg.shareCloud = true;
    return cl.request(h, { provider: 'anthropic', model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] }, { timeoutMs: 2000 });
  }).then(function (r) {
    assert.strictEqual(r.model, 'claude-opus-5-5');
    return host.stop();
  });
});
test('relay: a second question waits in line (told its place); a full queue says busy; Ask-me-each-time can decline', function () {
  var fc = fakeCloud(), host = mkHost(fc, { gap: 8 }), a = mkClient(fc, 'ph1-a'), b = mkClient(fc, 'ph2-b'), evB = [];
  var h = { inst: 'mac1-t1', name: 'MacBook' }, q = { messages: [{ role: 'user', content: 'x' }] };
  return host.start().then(function () {
    var pa = a.request(h, q, { timeoutMs: 3000 });
    return wait(15).then(function () { return Promise.all([pa, b.request(h, q, { timeoutMs: 3000, onEvent: function (m) { evB.push(m.t + (m.pos != null ? m.pos : '')); } })]); });
  }).then(function (rs) {
    assert.strictEqual(rs[0].text, rs[1].text);
    assert.ok(evB.indexOf('a1') >= 0, 'told: 1 ahead (' + evB.join(',') + ')');
    return host.stop();
  }).then(function () {
    var fc2 = fakeCloud(), full = mkHost(fc2, { gap: 30, limits: { QUEUE_MAX: 1 } });
    return full.start().then(function () {
      var c1 = mkClient(fc2, 'p1-a').request(h, q, { timeoutMs: 3000 }).catch(function () {});
      return wait(20).then(function () {
        var c2 = mkClient(fc2, 'p2-a').request(h, q, { timeoutMs: 3000 }).catch(function () {});
        return wait(20).then(function () { return rejects(mkClient(fc2, 'p3-a').request(h, q, { timeoutMs: 3000 }), 'busy'); }).then(function () { return Promise.all([c1, c2]); });
      });
    }).then(function () { return full.stop(); });
  }).then(function () {
    var fc3 = fakeCloud(), asked = [];
    var host3 = mkHost(fc3, { policy: 'ask', ask: function (job) { asked.push(job.req.name + ' → ' + job.target.ep.id + ':' + job.target.model); return Promise.resolve(false); } });
    return host3.start().then(function () {
      return rejects(mkClient(fc3, 'p1-z').request(h, q, { timeoutMs: 3000 }), 'denied');
    }).then(function () {
      assert.deepStrictEqual(asked, ['iPhone → ollama:llama3.2:latest'], 'the card can say which model');
      return host3.stop();
    });
  });
});
test('relay: Stop on the phone cancels the run on the host; the partial text is kept', function () {
  var fc = fakeCloud(), host = mkHost(fc, { gap: 25, answer: 'one two three four five six seven eight nine ten eleven twelve' }), cl = mkClient(fc, 'ph1-c');
  var ac = new AbortController(), got = '';
  return host.start().then(function () {
    return rejects(cl.request({ inst: 'mac1-t1', name: 'MacBook' }, { messages: [{ role: 'user', content: 'count' }] },
      { signal: ac.signal, timeoutMs: 3000, onDelta: function (d, full) { got = full; if (full.split(' ').length >= 3) ac.abort(); } }), 'aborted');
  }).then(function (e) {
    assert.ok(e.partial && e.partial === got);
    return wait(150);
  }).then(function () {
    var job = host.runs[0];
    assert.ok(job.cancelled && job.ctl.signal.aborted);
    var t = fc.tree().rooms.__cade_ai_fp;
    assert.ok(!t.ctl && !t.res);
    assert.strictEqual(host.status().busy, false);
    return host.stop();
  });
});
test('relay: nobody home → host-silent; a quiet host → timeout; a stopped host tells the asker', function () {
  var fc = fakeCloud(), cl = mkClient(fc, 'ph1-d');
  return rejects(cl.request({ inst: 'ghost-1', name: 'Ghost' }, { messages: [{ role: 'user', content: 'x' }] }, { timeoutMs: 5000 }), 'host-silent').then(function () {
    var hang = mkHost(fc, { run: function (job, hh) { hh.model('m'); return new Promise(function () {}); }, limits: { KEEPALIVE_MS: 100000 } });
    return hang.start().then(function () {
      return rejects(mkClient(fc, 'ph1-e', { FIRST_MIN_MS: 200 }).request({ inst: 'mac1-t1', name: 'MacBook' }, { messages: [{ role: 'user', content: 'x' }] }, { timeoutMs: 200 }), 'timeout');
    }).then(function () { return hang.stop(); });
  }).then(function () {
    var fc2 = fakeCloud(), slow = mkHost(fc2, { gap: 40 }), c2 = mkClient(fc2, 'ph1-f');
    return slow.start().then(function () {
      var p = rejects(c2.request({ inst: 'mac1-t1', name: 'MacBook' }, { messages: [{ role: 'user', content: 'x' }] }, { timeoutMs: 3000 }), 'host-stopped');
      return wait(60).then(function () { slow.stop(); return p; });
    });
  });
});
test('relay: presence comes back after the server dropped it; a busy note doesn’t rewrite it', function () {
  var fc = fakeCloud(), host = mkHost(fc, { limits: { BEAT_MS: 60 }, gap: 10 });
  var cl = mkClient(fc, 'ph1-h');
  return host.start().then(function () {
    var s0 = fc.get('rooms/__cade_ai_fp/hosts/mac1-t1').s;
    return cl.request({ inst: 'mac1-t1', name: 'MacBook' }, { messages: [{ role: 'user', content: 'x' }] }, { timeoutMs: 3000 }).then(function () {
      assert.strictEqual(fc.get('rooms/__cade_ai_fp/hosts/mac1-t1').s, s0, 'the presence body was not rewritten for busy / free');
      assert.ok(fc.writes().some(function (w) { return /hosts\/mac1-t1\/b"/.test(w); }), 'busy went to its own node');
    });
  }).then(function () {
    fc.put('rooms/__cade_ai_fp/hosts/mac1-t1', null);
    return wait(150);
  }).then(function () {
    var e = fc.get('rooms/__cade_ai_fp/hosts/mac1-t1');
    assert.ok(e && typeof e.s === 'string' && e.at, 'the whole entry is back');
    return host.stop();
  });
});
test('relay: watching hosts sees one appear and leave; garbled requests are ignored', function () {
  var fc = fakeCloud(), cl = mkClient(fc, 'ph1-w'), host = mkHost(fc), seen = [];
  var off = cl.watchHosts(function (l) { seen.push(l ? l.map(function (h) { return h.name; }).join(',') : 'null'); });
  return wait(20).then(function () { return host.start(); }).then(function () {
    fc.put('rooms/__cade_ai_fp/req/mac1-t1/aaaaaaaaaaaa', { f: 'x-1', s: 'not sealed', at: Date.now() });
    return wait(60);
  }).then(function () {
    assert.strictEqual(host.runs.length, 0);
    assert.ok(!fc.get('rooms/__cade_ai_fp/req'));
    return host.stop();
  }).then(function () { return wait(40); }).then(function () {
    off();
    assert.deepStrictEqual(seen.filter(function (s, i) { return i === 0 || s !== seen[i - 1]; }), ['', 'MacBook', '']);
    assert.strictEqual(fc.listeners(), 0);
  });
});

// ---- the service on two devices: the routing guarantee, keys that stay home ------------------------------------------
var SVC_SRC = fs.readFileSync(path.join(__dirname, 'ai-service.js'), 'utf8');
var KEY = 'sk-ant-api03-SECRET-KEY-0123456789';
var HF_ROWS = SCORES.rows.slice(0, 40).concat([['Claude Opus 5.5 (High)', 1516], ['Llama 3.2 3B Instruct', 1110], ['Gemma 4 31B', 1443]]).map(function (r) {
  return { row: { model_name: r[0], rating: r[1] + 0.25, leaderboard_publish_date: '2026-10-20', category: 'overall' } };
});
var OR_LIST = { data: [
  { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', context_length: 1000000, pricing: { prompt: '0.000004', completion: '0.00002' } },
  { id: 'anthropic/claude-haiku-4.5', name: 'Anthropic: Claude Haiku 4.5', context_length: 200000, pricing: { prompt: '0.000001', completion: '0.000005' } }] };
function jsonResponse(o) { return Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } })); }
// A device running ai-service.js: its own Cade (store, prefs, Settings, IndexedDB, cloud), a shared fake cloud.
function mkDevice(o) {
  var store = new Map(), storeWrites = [], prefWrites = [], settings = {}, idb = new Map(), calls = [];
  if (o.local) store.set('cade-ai-local:' + o.id, JSON.stringify(o.local));
  var vals = Object.assign({}, C.PREF_DEFAULTS, o.prefs || {}), pls = [];
  var P = {
    get: function (k) { return vals[k]; }, all: function () { return Object.assign({}, vals); },
    set: function (k, v) { prefWrites.push([k, v]); if (vals[k] === v) return true; vals[k] = v; pls.slice().forEach(function (fn) { fn(k, v, P.all()); }); return true; },
    on: function (fn) { pls.push(fn); return function () { var i = pls.indexOf(fn); if (i >= 0) pls.splice(i, 1); }; }
  };
  var tab = Math.random().toString(36).slice(2, 7);
  var Cade = {
    baseURL: function () { return './'; }, prefs: function () { return P; },
    store: { get: function (k) { return store.has(k) ? store.get(k) : null; }, set: function (k, v) { storeWrites.push([k, String(v)]); store.set(k, String(v)); }, remove: function (k) { store.delete(k); } },
    idbStore: { get: function (k) { return Promise.resolve(idb.has(k) ? JSON.parse(idb.get(k)) : undefined); }, set: function (k, v) { idb.set(k, JSON.stringify(v)); return Promise.resolve(); }, remove: function (k) { idb.delete(k); return Promise.resolve(); } },
    Settings: { get: function (k) { return settings[k]; }, set: function (k, v) { settings[k] = v; } },
    cloud: {
      configured: function () { return true; }, device: { id: o.id, tab: tab, inst: o.id + '-' + tab, name: o.name, kind: o.kind },
      ref: function (kind, sub) { assert.strictEqual(kind, 'ai'); return o.fc.cloud.ref(sub); }, seal: o.fc.cloud.seal, unseal: o.fc.cloud.unseal,
      get TIMESTAMP() { return Date.now(); }, serverNow: function () { return Date.now(); }
    },
    runCommand: function () {}, unregisterPlugin: function () {}
  };
  var win = { Cade: Cade, __cadeAiCore: C, fetch: function (u, init) { calls.push(String(u)); return o.fetch(u, init); } };
  var doc = { currentScript: null, visibilityState: 'visible', addEventListener: function () {}, removeEventListener: function () {},
    createElement: function () { throw new Error('no script loading in this test'); }, head: { appendChild: function () {} } };
  var nav = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', maxTouchPoints: 0 };
  var loc = { origin: 'https://cadezawacki.github.io', protocol: 'https:' };
  new Function('window', 'document', 'navigator', 'location', 'Request', SVC_SRC)(win, doc, nav, loc, Request);
  return { svc: win.__cadeAi, api: Cade.ai, Cade: Cade, P: P, store: store, storeWrites: storeWrites, prefWrites: prefWrites, settings: settings, idb: idb, calls: calls };
}
var DEV = {};
test('service: the host shares local models only, until "Share cloud services too" — with badges from cited sources', function () {
  var fc = DEV.fc = fakeCloud(), outside = DEV.outside = [];
  DEV.mac = mkDevice({ id: 'mac00001', name: 'MacBook', kind: 'desktop', fc: fc, prefs: { share: true },
    local: { role: 'local', endpoints: [{ id: 'ollama', p: 'ollama', url: BASE, on: true }, { id: 'anthropic', p: 'anthropic', url: ANT, key: KEY, on: true }] },
    fetch: function (u, init) {
      if (u.indexOf(C.SOURCES.scores) === 0) { outside.push(u); return jsonResponse({ rows: HF_ROWS }); }
      if (u === C.SOURCES.catalog) { outside.push(u); return jsonResponse(OR_LIST); }
      if (u.indexOf(BASE) !== 0) return Promise.reject(new TypeError('Failed to fetch (no network in tests): ' + u));
      return fetch(u, init);
    } });
  var mac = DEV.mac.svc;
  DEV.unuse = mac.use();
  mac.host.enable(null);
  return until(function () { return mac.host.status().phase === 'live'; }, 4000, 'the host to go live').then(function () {
    return until(function () { var s = mac.host.shared(); return s.prov[0] && s.prov[0].m[0] && s.prov[0].m[0].s; }, 4000, 'scores in the shared list');
  }).then(function () {
    var sh = mac.host.shared();
    assert.deepStrictEqual(sh.prov.map(function (p) { return p.id; }), ['ollama'], 'cloud off by default');
    assert.deepStrictEqual(sh.prov[0].m.map(function (m) { return m.i + ' ★' + (m.s ? m.s[0] : '-'); }), ['llama3.2:latest ★1110', 'gemma4:31b ★1443']);
    assert.strictEqual(sh.sd, '2026-10-20', 'the score date travels with them');
    assert.deepStrictEqual(outside.map(function (u) { return u.split('?')[0]; }).sort(), [C.SOURCES.catalog, 'https://datasets-server.huggingface.co/filter'].sort(),
      'the only outside calls: the two public badge sources');
    assert.ok(DEV.mac.idb.has('ai-badge-scores') && DEV.mac.idb.has('ai-badge-catalog'), 'both cached for a day');
  });
});
test('service: the phone lists the host’s models with badges — and never contacts a model service', function () {
  var phoneFetch = DEV.phoneFetch = [];
  DEV.phone = mkDevice({ id: 'iph00001', name: 'iPhone', kind: 'phone', fc: DEV.fc,
    // leftovers from an earlier "This device" setup must not matter
    local: { role: 'remote', endpoints: [{ id: 'ollama', p: 'ollama', url: BASE, on: true }, { id: 'openai', p: 'openai', key: 'sk-phone-OLD', on: true }] },
    fetch: function (u) { phoneFetch.push(String(u)); return Promise.reject(new Error('the phone must not fetch: ' + u)); } });
  var ph = DEV.phone.svc;
  DEV.offWatch = ph.watchHosts(function () {});
  return untilP(function () { return ph.available(false).then(function (av) { return av.hosts.length && av; }); }, 3000, 'the phone to see the host').then(function (av) {
    assert.strictEqual(av.role, 'remote');
    assert.deepStrictEqual(av.groups.map(function (g) { return g.src + '/' + g.ep + '/' + g.srcName; }), ['mac00001/ollama/MacBook'], 'only the host’s shared local service');
    var m = av.groups[0].models.filter(function (x) { return x.id === 'gemma4:31b'; })[0];
    assert.deepStrictEqual(C.badges(m).map(function (b) { return b.t; }), ['Local', '31B Q4', '★1443']);
    return DEV.phone.api.models();
  }).then(function (list) {
    assert.deepStrictEqual(list.map(function (m) { return m.id + '@' + m.host; }), ['ollama:llama3.2:latest@MacBook', 'ollama:gemma4:31b@MacBook']);
    return DEV.phone.api.status();
  }).then(function (st) {
    assert.deepStrictEqual([st.available, st.via, st.host, st.provider, st.model], [true, 'host', 'MacBook', 'ollama', 'llama3.2:latest']);
    assert.deepStrictEqual(phoneFetch, [], 'no fetch at all on the phone');
  });
});
test('service: the phone asks a local model on the host; the host makes the call', function () {
  var hitsBefore = hits.length, toks = [];
  return DEV.phone.api.chat('Hi there', { model: 'ollama:gemma4:31b', onToken: function (d, full) { toks.push(full); } }).then(function (text) {
    assert.strictEqual(text, 'Hello, café');
    assert.ok(toks.length >= 1);
    var h = hits.slice(hitsBefore).filter(function (x) { return x.url === '/api/chat'; });
    assert.strictEqual(h.length, 1, 'the host called Ollama once');
    assert.strictEqual(h[0].body.model, 'gemma4:31b');
    assert.strictEqual(h[0].body.messages[0].role, 'system', 'the phone’s system prompt went along');
    assert.deepStrictEqual(DEV.phoneFetch, []);
  });
});
test('service: cloud sharing switched on at the host → the phone sees Anthropic, switches model mid-conversation; the key stays home, the cap applies', function () {
  var mac = DEV.mac, ph = DEV.phone.svc;
  mac.P.set('shareCloud', true);
  return until(function () { return mac.svc.host.shared().prov.length === 2; }, 3000, 'cloud shared').then(function () {
    return untilP(function () { return ph.available(false).then(function (av) { return av.groups.length === 2 && av; }); }, 3000, 'the phone to see two services');
  }).then(function (av) {
    var an = av.groups.filter(function (g) { return g.ep === 'anthropic'; })[0];
    assert.ok(an && an.where === 'cloud' && an.srcName === 'MacBook');
    var opus = an.models.filter(function (m) { return m.id === 'claude-opus-5-5'; })[0];
    assert.deepStrictEqual(C.badges(opus).map(function (b) { return b.t; }), ['Cloud', '$4 · $20', '1M', '★1516']);
    // a conversation that started on Ollama continues on Claude
    var ref = C.refKey('mac00001', 'anthropic', 'claude-opus-5-5'), n0 = hits.length;
    mac.P.set('cloudMaxTokens', 2048);
    var history = [{ role: 'user', content: 'Hi there' }, { role: 'assistant', content: 'Hello, café' }, { role: 'user', content: 'And now?' }];
    return ph.chat(history, { model: ref, maxTokens: 9000 }).then(function (r) {
      assert.ok(/déjà vu/.test(r.text));
      assert.deepStrictEqual([r.via, r.host, r.ep], ['host', 'MacBook', 'anthropic']);
      var h = hits.slice(n0).filter(function (x) { return x.url === '/anthropic/v1/messages'; })[0];
      assert.ok(h, 'the host called Anthropic');
      assert.strictEqual(h.headers['x-api-key'], KEY, 'with ITS key');
      assert.strictEqual(h.body.max_tokens, 2048, 'capped by "Longest cloud answer for another device"');
      mac.P.set('cloudMaxTokens', 0);
      assert.strictEqual(h.body.messages.length, 3, 'the whole conversation');
      assert.ok(!('temperature' in h.body));
      assert.deepStrictEqual(DEV.phoneFetch, [], 'still no fetch on the phone');
    });
  });
});
test('service: API keys never leave the host — not in the cloud, presence, prefs or the phone’s storage', function () {
  var everything = [].concat(DEV.fc.sealed(), DEV.fc.writes(), [JSON.stringify(DEV.fc.tree())],
    DEV.mac.prefWrites.map(JSON.stringify), DEV.phone.prefWrites.map(JSON.stringify), DEV.phone.storeWrites.map(JSON.stringify), [JSON.stringify(DEV.mac.svc.host.shared())],
    Array.from(DEV.phone.idb.values()), Array.from(DEV.mac.idb.values()));
  assert.ok(DEV.fc.sealed().length > 10, 'the log saw the traffic');
  everything.forEach(function (s) {
    assert.ok(s.indexOf('SECRET-KEY') < 0, 'key found in: ' + s.slice(0, 200));
    assert.ok(s.indexOf('sk-phone-OLD') < 0, 'the phone’s leftover key went out: ' + s.slice(0, 200));
    assert.ok(s.indexOf('127.0.0.1:' + PORT) < 0, 'a service address went out: ' + s.slice(0, 200));
  });
  // where it IS: this device's own storage, under its device id
  assert.ok(DEV.mac.store.get('cade-ai-local:mac00001').indexOf(KEY) >= 0);
  assert.ok(!DEV.mac.prefWrites.some(function (w) { return /key/i.test(w[0]); }));
  assert.ok(!C.PREFS.some(function (f) { return /key|endpoint|url/i.test(f.key || ''); }), 'no prefs field can hold a key or an address');
});
test('service: the host refuses what it no longer shares; switching cloud off hides it again', function () {
  var mac = DEV.mac, ph = DEV.phone.svc, cl = C.createRelayClient({ cloud: DEV.fc.cloud, device: function () { return { inst: 'iph00001-zz', name: 'iPhone', kind: 'phone', id: 'iph00001' }; } });
  mac.P.set('shareCloud', false);
  return until(function () { return mac.svc.host.shared().prov.length === 1; }, 3000).then(function () {
    return cl.listHosts();
  }).then(function (hosts) {
    var n0 = hits.length;
    return rejects(cl.request(hosts[0], { provider: 'anthropic', model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] }, { timeoutMs: 3000 }), 'not-shared').then(function () {
      assert.ok(!hits.slice(n0).some(function (x) { return /anthropic/.test(x.url); }), 'Anthropic was not called');
    });
  }).then(function () {
    return untilP(function () { return ph.available(false).then(function (av) { return av.groups.length === 1; }); }, 3000, 'the phone to drop Anthropic');
  });
});
test('service: a phone with no host online says so — still without fetching', function () {
  DEV.mac.svc.host.disable();
  return until(function () { return DEV.mac.svc.host.status().phase === 'off'; }, 3000).then(function () {
    return untilP(function () { return DEV.phone.svc.available(false).then(function (av) { return !av.hosts.length; }); }, 3000, 'the host to be gone');
  }).then(function () {
    return DEV.phone.api.status();
  }).then(function (st) {
    assert.deepStrictEqual([st.available, st.reason], [false, 'host-offline']);
    return rejects(DEV.phone.api.chat('anyone?'), 'host-offline');
  }).then(function () {
    assert.deepStrictEqual(DEV.phoneFetch, [], 'the phone never called fetch in this whole run');
    DEV.offWatch(); DEV.unuse();
    return wait(30);
  }).then(function () {
    assert.strictEqual(DEV.fc.listeners(), 0, 'no cloud listeners left');
    assert.ok(!DEV.fc.get('rooms/__cade_ai_fp/hosts'), 'presence withdrawn');
  });
});
test('service: a device set to "This device" calls its own services; per-note picks and recently used', function () {
  var d = mkDevice({ id: 'lap00002', name: 'Laptop', kind: 'desktop', fc: fakeCloud(),
    local: { role: 'local', endpoints: [{ id: 'ollama', p: 'ollama', url: BASE, on: true }, { id: 'anthropic', p: 'anthropic', url: ANT, key: 'sk-ant-T', on: true }] },
    fetch: function (u, init) { if (u.indexOf(BASE) !== 0) return Promise.reject(new TypeError('offline')); return fetch(u, init); } });
  var svc = d.svc;
  return svc.available(true).then(function (av) {
    assert.deepStrictEqual(av.groups.filter(function (g) { return g.src === 'local'; }).map(function (g) { return g.ep + ':' + g.models.length; }), ['ollama:2', 'anthropic:2']);
    svc.setNotePick('plans', C.refKey('local', 'anthropic', 'claude-haiku-4-5'));
    svc.setNotePick('groceries', C.refKey('local', 'ollama', 'llama3.2:latest'));
    assert.strictEqual(svc.notePick('plans'), 'local|anthropic|claude-haiku-4-5');
    assert.deepStrictEqual(svc.recent(), ['local|ollama|llama3.2:latest', 'local|anthropic|claude-haiku-4-5'], 'most recent first');
    return svc.route(svc.notePick('plans'));
  }).then(function (r) {
    assert.deepStrictEqual([r.available, r.via, r.group.ep, r.model.id], [true, 'local', 'anthropic', 'claude-haiku-4-5']);
    d.P.set('model', 'ollama:gemma4:31b');
    return svc.route(null);
  }).then(function (r) {
    assert.deepStrictEqual([r.group.ep, r.model.id], ['ollama', 'gemma4:31b'], 'a note without a pick uses the default');
    return d.api.chat([{ role: 'user', content: 'hey' }], { model: 'anthropic:claude-haiku-4-5' });
  }).then(function (t) {
    assert.ok(/déjà vu/.test(t));
    svc.saveEndpoint({ id: 'anthropic', key: '' });
    var n0 = hits.length;
    return rejects(d.api.chat('hey', { model: 'anthropic:claude-haiku-4-5' }), 'key-missing').then(function (e) {
      assert.ok(/Anthropic needs an API key/.test(e.info.title), 'the fix: ' + e.info.title);
      assert.ok(!hits.slice(n0).some(function (x) { return /\/(api\/chat|messages)$/.test(x.url); }), 'a chosen model is never swapped for another one (the default is Ollama here)');
      return rejects(d.api.chat('hey', { model: 'ollama:nope:1b' }), 'model');
    });
  });
});

// ---- markdown + misc --------------------------------------------------------------------------------------------
test('markdown: formatting, code, lists, tables — and no HTML or unsafe links get through', function () {
  var h = C.mdToHtml('# Title\n\nSome **bold**, *it*, `x<y`, ~~old~~ and [a link](https://ex.com).\n\n- [ ] todo\n- [x] done\n  - nested\n\n1. one\n2. two\n\n```js\nif (a < b) alert(1)\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote');
  assert.ok(h.indexOf('<h3>Title</h3>') >= 0, h);
  assert.ok(h.indexOf('<strong>bold</strong>') >= 0 && h.indexOf('<em>it</em>') >= 0 && h.indexOf('<del>old</del>') >= 0);
  assert.ok(h.indexOf('<a href="https://ex.com" target="_blank" rel="noopener noreferrer">a link</a>') >= 0);
  assert.ok(h.indexOf('<pre><code class="language-js">if (a &lt; b) alert(1)</code></pre>') >= 0);
  assert.ok(h.indexOf('<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>') >= 0);
  var x = C.mdToHtml('<img src=x onerror=alert(1)> [click](javascript:alert(1)) <script>bad()</script> snake_case_name');
  assert.ok(x.indexOf('<img') < 0 && x.indexOf('<script') < 0 && x.indexOf('href') < 0, x);
  assert.strictEqual(C.safeUrl('javascript:x'), '');
});
test('note names from an answer; device sniffing', function () {
  assert.strictEqual(C.roomNameFrom('## Shopping list for Saturday\n- eggs', []), 'shopping list for saturday');
  assert.strictEqual(C.roomNameFrom('**Plan**', ['plan']), 'plan 2');
  assert.strictEqual(C.roomNameFrom('', []), 'ai answer');
  var mac = C.sniff('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', 0);
  assert.deepStrictEqual([mac.os, mac.browser], ['mac', 'safari']);
  var ipad = C.sniff('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', 5);
  assert.deepStrictEqual([ipad.os, ipad.ios], ['ios', true]);
  assert.strictEqual(C.fmtMs(850), '850 ms'); assert.strictEqual(C.fmtMs(1500), '1.5 s');
});

// ---- prefs + registration ------------------------------------------------------------------------------------
test('prefs: the schema is sound — sharing (and cloud sharing) opt-in, no place for a key', function () {
  var keys = {}, TYPES = ['text', 'textarea', 'number', 'slider', 'toggle', 'checkbox', 'radio', 'select', 'date', 'time', 'color', 'heading'];
  C.PREFS.forEach(function (f) {
    assert.ok(TYPES.indexOf(f.type) >= 0, f.type);
    if (f.type === 'heading') return;
    assert.ok(f.key && !keys[f.key], 'unique key ' + f.key);
    keys[f.key] = f;
    if (f.type === 'number' || f.type === 'slider') { assert.ok(f.default >= f.min && f.default <= f.max, f.key); assert.ok(Math.abs(Math.round((f.default - f.min) / f.step) * f.step + f.min - f.default) < 1e-9, f.key + ' on a step'); }
    if (f.options) assert.ok(f.options.some(function (o) { return o.value === f.default; }), f.key + ' default is an option');
    if (f.showIf) assert.strictEqual(keys[f.showIf.replace(/^!/, '')].type, 'toggle', f.key + ' shows after its toggle');
  });
  ['model', 'temperature', 'maxTokens', 'contextWindow', 'system', 'history', 'timeout', 'share', 'policy', 'shareCloud', 'cloudMaxTokens'].forEach(function (k) { assert.ok(keys[k], 'has ' + k); });
  assert.strictEqual(keys.share.default, false, 'sharing is opt-in');
  assert.strictEqual(keys.shareCloud.default, false, 'sharing cloud services is a second opt-in');
  assert.ok(keys.cloudMaxTokens.default <= keys.maxTokens.default);
  assert.ok(!keys.apiKey && !keys.key && !keys.endpoint && !keys.provider, 'services and keys live on the device, not in prefs (prefs may sync)');
});
test('manifest: txt/manifest.json carries the entries this version needs (see PROPOSED)', function () {
  ['ai', 'ai-host'].forEach(function (id) {
    var m = manifestEntry(id), want = PROPOSED[id];
    assert.ok(m, id + ' is in ' + MANIFEST);
    Object.keys(want).forEach(function (k) {
      assert.deepStrictEqual(JSON.parse(JSON.stringify(m[k])), want[k], MANIFEST + ': "' + id + '".' + k + ' is out of date — use PROPOSED["' + id + '"].' + k + ' from ai.test.js');
    });
  });
  (PROPOSED.ai.precache.concat(PROPOSED['ai-host'].precache, [PROPOSED.ai.entry, PROPOSED.ai.css, PROPOSED['ai-host'].entry])).forEach(function (f) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', f)), f + ' exists');
  });
});
test('widget and plugin register as the manifest says; nothing runs at load', function () {
  var w = PROPOSED.ai, reg = null, plug = null, css = [], timers = 0, listens = 0;
  var fake = {
    Cade: {
      loadCSS: function (c) { css.push(c); }, asset: function (r) { return r; }, baseURL: function () { return './txt/widgets/ai/'; },
      registerWidget: function (o) { reg = o; }, registerPlugin: function (o) { plug = o; },
      CM: { ViewPlugin: { define: function (f) { return { __vp: f }; } } }, escapeHtml: String
    },
    document: { addEventListener: function () { listens++; }, removeEventListener: function () {} }
  };
  var st = function () { timers++; };
  new Function('window', 'module', 'document', 'setTimeout', 'setInterval', fs.readFileSync(path.join(__dirname, 'ai.js'), 'utf8'))(fake, undefined, fake.document, st, st);
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(reg[k], w[k], k); });
  assert.deepStrictEqual(css, ['ai.css']);
  assert.ok(fake.Cade.ai && fake.Cade.ai.version === 2 && typeof fake.Cade.ai.chat === 'function' && typeof fake.Cade.ai.models === 'function', 'Cade.ai registered (lazy)');
  new Function('window', 'module', 'document', 'setTimeout', 'setInterval', fs.readFileSync(path.join(__dirname, 'ai-host.js'), 'utf8'))(fake, undefined, fake.document, st, st);
  assert.strictEqual(plug.id, 'ai-host');
  assert.ok(plug.ext && plug.ext.__vp, 'lifetime tied to an editor ViewPlugin');
  assert.strictEqual(timers + listens, 0, 'no timers or listeners until opened / enabled');
  var icons = manifestModules().filter(function (m) { return m.id !== 'ai'; }).map(function (m) { return m.icon; });
  assert.ok(icons.indexOf(w.icon) < 0, 'icon not taken');
});

run();
