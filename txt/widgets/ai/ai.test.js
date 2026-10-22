/* Checks for AI: server adapters, stream parsers (pieces split anywhere),
 * error classification + fix texts, the engine against a fake model server
 * (Ollama NDJSON and OpenAI SSE), context budgeting, the relay protocol
 * end-to-end over an in-memory cloud (sealing stub that reorders, queue,
 * cancel, timeouts, clean-up), the Markdown renderer, the prefs schema and
 * the widget / plugin registration.
 * Not loaded by the app. Run: node txt/widgets/ai/ai.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path'), http = require('http');
var C = require('./ai-core.js');

// The manifest entries this module needs (until they are in txt/manifest.json,
// where they're read from once present).
var PROPOSED = {
  ai: {
    id: 'ai', type: 'widget', name: 'AI',
    description: 'Your own AI model — Ollama, LM Studio or any OpenAI-compatible server on your computer — with your note as context: summarise, rewrite, continue, explain code, checklists, translate. Use it from your phone too, end-to-end encrypted through Sync; no cloud AI service',
    icon: '✨',
    tags: 'ai,assistant,chat,llm,local llm,local ai,private ai,ollama,lm studio,llama,llama.cpp,mistral,gemma,qwen,deepseek,phi,openai compatible,gpt,chatgpt,summarise,summarize,rewrite,continue writing,explain code,checklist,translate,ask,prompt,model',
    entry: 'widgets/ai/ai.js', css: 'widgets/ai/ai.css',
    precache: ['widgets/ai/ai-core.js', 'widgets/ai/ai-service.js'],
    prefs: { title: 'AI', fields: C.PREFS }
  },
  'ai-host': {
    id: 'ai-host', type: 'plugin', name: 'Share my AI model with my other devices',
    description: 'This computer answers the AI widget on your other devices (same Sync) with its own model (Ollama, LM Studio…) — end-to-end encrypted, deleted once delivered. Works while a txt tab stays open here (Chrome, Edge or Firefox). Set it up in the AI widget',
    entry: 'widgets/ai/ai-host.js',
    precache: ['widgets/ai/ai-core.js', 'widgets/ai/ai-service.js', 'widgets/ai/ai.css'],
    settingKey: 'plugins.ai-host', section: 'Devices', default: false
  }
};
function manifestEntry(id) {
  try {
    var man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules;
    var m = man.filter(function (x) { return x.id === id; })[0];
    if (m) return m;
  } catch (e) {}
  return PROPOSED[id];
}

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
  var done = false, timer = setTimeout(function () { if (!done) { done = true; console.error('FAIL ' + t[0] + '\n  (timed out)'); process.exitCode = 1; run(); } }, 8000);
  Promise.resolve().then(t[1]).then(function () { if (done) return; done = true; clearTimeout(timer); passed++; run(); },
    function (e) { if (done) return; done = true; clearTimeout(timer); console.error('FAIL ' + t[0] + '\n' + (e && e.stack || e)); process.exitCode = 1; run(); });
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function rejects(p, code) {
  return p.then(function () { throw new Error('expected a rejection with ' + code); }, function (e) { assert.strictEqual(e.code, code, 'code ' + e.code + ' (' + e.message + ')'); return e; });
}

// ---- adapters ----------------------------------------------------------------------------------------
test('addresses: typed bases are normalised per API', function () {
  assert.strictEqual(C.normBase('ollama', 'localhost:11434/'), 'http://localhost:11434');
  assert.strictEqual(C.normBase('ollama', 'http://127.0.0.1:11434/api/tags'), 'http://127.0.0.1:11434');
  assert.strictEqual(C.normBase('ollama', 'http://box:11434/v1'), 'http://box:11434');
  assert.strictEqual(C.normBase('openai', 'http://127.0.0.1:1234'), 'http://127.0.0.1:1234/v1');
  assert.strictEqual(C.normBase('openai', 'http://127.0.0.1:1234/v1/chat/completions'), 'http://127.0.0.1:1234/v1');
  assert.strictEqual(C.normBase('openai', 'https://api.example.com/openai/v1/models'), 'https://api.example.com/openai/v1');
  assert.strictEqual(C.normBase('openai', ''), '');
  assert.strictEqual(C.addressSpace('http://localhost:11434'), 'loopback');
  assert.strictEqual(C.addressSpace('http://127.0.0.1:1234/v1'), 'loopback');
  assert.strictEqual(C.addressSpace('http://[::1]:8080'), 'loopback');
  assert.strictEqual(C.addressSpace('http://192.168.1.20:11434'), 'local');
  assert.strictEqual(C.addressSpace('http://10.0.0.5'), 'local');
  assert.strictEqual(C.addressSpace('http://gpu.local:8080'), 'local');
  assert.strictEqual(C.addressSpace('http://172.32.0.1'), 'public');
  assert.strictEqual(C.addressSpace('https://example.com'), 'public');
});
test('requests: Ollama native vs OpenAI-compatible bodies', function () {
  var msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }];
  var o = C.buildChat({ kind: 'ollama', base: 'http://h:1', model: 'llama3.2', messages: msgs, temperature: 0.2, maxTokens: 300, numCtx: 8192 });
  assert.strictEqual(o.url, 'http://h:1/api/chat');
  var b = JSON.parse(o.init.body);
  assert.deepStrictEqual(b, { model: 'llama3.2', messages: msgs, stream: true, options: { temperature: 0.2, num_predict: 300, num_ctx: 8192 } });
  assert.strictEqual(o.init.headers.Authorization, undefined);
  var p = C.buildChat({ kind: 'openai', base: 'http://h:2/v1', apiKey: 'sk-1', model: 'm', messages: msgs, temperature: 0, maxTokens: 50, numCtx: 4096 });
  assert.strictEqual(p.url, 'http://h:2/v1/chat/completions');
  assert.deepStrictEqual(JSON.parse(p.init.body), { model: 'm', messages: msgs, stream: true, temperature: 0, max_tokens: 50 });
  assert.strictEqual(p.init.headers.Authorization, 'Bearer sk-1');
  assert.strictEqual(JSON.parse(C.buildChat({ kind: 'ollama', base: 'x', model: 'm', messages: msgs }).init.body).options.num_ctx, undefined, 'no num_ctx when 0/unset');
  assert.strictEqual(C.modelsUrl('ollama', 'http://h'), 'http://h/api/tags');
  assert.strictEqual(C.modelsUrl('openai', 'http://h/v1'), 'http://h/v1/models');
});
test('model lists: Ollama tags and OpenAI /models, embeddings last, picking', function () {
  var l = C.parseModels('ollama', { models: [
    { name: 'nomic-embed-text:latest', size: 274e6, details: { family: 'nomic-bert' } },
    { name: 'llama3.2:latest', model: 'llama3.2:latest', size: 2019393189, details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' } },
    { name: 'qwen2.5:7b', size: 4.7e9, details: {} }
  ] });
  assert.deepStrictEqual(l.map(function (m) { return m.name; }), ['llama3.2:latest', 'qwen2.5:7b', 'nomic-embed-text:latest']);
  assert.strictEqual(l[0].params, '3.2B'); assert.strictEqual(l[2].embed, true);
  var o = C.parseModels('openai', { object: 'list', data: [{ id: 'text-embedding-nomic-embed-text-v1.5' }, { id: 'google/gemma-3-4b' }, { id: 'google/gemma-3-4b' }] });
  assert.deepStrictEqual(o.map(function (m) { return m.name; }), ['google/gemma-3-4b', 'text-embedding-nomic-embed-text-v1.5']);
  assert.strictEqual(C.pickModel('qwen2.5:7b', l), 'qwen2.5:7b');
  assert.strictEqual(C.pickModel('llama3.2', l), 'llama3.2:latest', ':latest is implied');
  assert.strictEqual(C.pickModel('gone', l), 'llama3.2:latest', 'a missing model falls back to the first chat model');
  assert.strictEqual(C.pickModel('', l), 'llama3.2:latest');
  assert.strictEqual(C.pickModel('mine', null), 'mine', 'unknown list: trust the name');
  assert.strictEqual(C.pickModel('', [{ name: 'e', embed: true }]), '');
});
test('stream chunks: content, thinking, done reasons, usage, errors', function () {
  var a = C.readChunk('ollama', { message: { role: 'assistant', content: 'Hi', thinking: '' }, done: false });
  assert.strictEqual(a.text, 'Hi'); assert.strictEqual(a.done, false);
  var z = C.readChunk('ollama', { message: { content: '' }, done: true, done_reason: 'length', prompt_eval_count: 12, eval_count: 30 });
  assert.deepStrictEqual([z.done, z.reason, z.usage.prompt, z.usage.output], [true, 'length', 12, 30]);
  assert.strictEqual(C.readChunk('ollama', { message: { content: '', thinking: 'hmm' } }).thinking, 'hmm');
  assert.strictEqual(C.readChunk('ollama', { error: 'boom' }).error, 'boom');
  var b = C.readChunk('openai', { choices: [{ index: 0, delta: { content: 'Yo' }, finish_reason: null }] });
  assert.strictEqual(b.text, 'Yo'); assert.strictEqual(b.done, false);
  var c = C.readChunk('openai', { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
  assert.deepStrictEqual([c.done, c.reason, c.usage.output], [true, 'stop', 7]);
  assert.strictEqual(C.readChunk('openai', { choices: [{ delta: { reasoning_content: 'r' } }] }).thinking, 'r');
  assert.strictEqual(C.readChunk('openai', { error: { message: 'Model unloaded', type: 'x' } }).error, 'Model unloaded');
});

// ---- stream parsers --------------------------------------------------------------------------------------
function pieces(s, sizes) {
  var out = [], i = 0, k = 0;
  while (i < s.length) { var n = sizes[k++ % sizes.length]; out.push(s.slice(i, i + n)); i += n; }
  return out;
}
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
test('SSE: data across pieces, \\r\\n split in two, multi-line data, comments, [DONE]', function () {
  var src = ': keep-alive\r\n\r\ndata: {"x":1}\r\n\r\nevent: note\ndata: line1\ndata: line2\n\ndata:{"y":"a b"}\r\rdata: [DONE]\n\n';
  [[1], [2], [3, 1], [6], [500]].forEach(function (sz) {
    var got = [];
    var p = C.sseParser(function (e) { got.push(e); });
    pieces(src, sz).forEach(p.push); p.end();
    assert.deepStrictEqual(got.map(function (e) { return e.event + '|' + e.data; }), ['message|{"x":1}', 'note|line1\nline2', 'message|{"y":"a b"}', 'message|[DONE]'], 'sizes ' + sz);
  });
  var g2 = [], p2 = C.sseParser(function (e) { g2.push(e.data); });
  p2.push('data: tail-without-blank-line'); p2.end();
  assert.deepStrictEqual(g2, ['tail-without-blank-line']);
});

// ---- errors ----------------------------------------------------------------------------------------------
test('HTTP errors are classified from the server’s own words', function () {
  assert.strictEqual(C.classifyHttp(404, '{"error":"model \\"llama9\\" not found, try pulling it first"}').code, 'model');
  assert.strictEqual(C.classifyHttp(404, '{"error":{"message":"No models loaded. Please load a model in the developer page or use the `lms load` command."}}').code, 'model');
  assert.strictEqual(C.classifyHttp(400, '{"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error"}}').code, 'context');
  assert.strictEqual(C.classifyHttp(400, '{"object":"error","message":"This model\'s maximum context length is 4096 tokens. However, you requested 5000 tokens","code":400}').code, 'context');
  assert.strictEqual(C.classifyHttp(401, '{"error":"Invalid API Key"}').code, 'auth');
  assert.strictEqual(C.classifyHttp(404, '404 page not found').code, 'notfound');
  assert.strictEqual(C.classifyHttp(429, '').code, 'busy');
  var s = C.classifyHttp(500, '<html><body>Internal <b>Server</b> Error</body></html>');
  assert.strictEqual(s.code, 'server'); assert.strictEqual(s.detail, 'Internal Server Error');
  assert.strictEqual(C.errorMessage('{"detail":[{"msg":"field required"}]}'), 'field required');
});
test('network failures: probe + environment → cors / unreachable / mixed / lna', function () {
  assert.strictEqual(C.refineNetwork('blocked', {}), 'cors');
  assert.strictEqual(C.refineNetwork('down', {}), 'unreachable');
  assert.strictEqual(C.refineNetwork('down', { mixedBlocked: true }), 'mixed');
  assert.strictEqual(C.refineNetwork('blocked', { lna: 'denied' }), 'lna');
  assert.strictEqual(C.refineNetwork('down', { lna: 'granted' }), 'unreachable');
});
test('fix texts: the exact OLLAMA_ORIGINS steps for each OS, with this page’s origin', function () {
  var o = C.explain('cors', { provider: 'ollama', origin: 'https://cadezawacki.github.io', os: 'win' });
  assert.strictEqual(o.osPick, 'win');
  var cmds = function (l) { return l.filter(function (s) { return s.cmd; }).map(function (s) { return s.cmd; }); };
  assert.ok(cmds(o.os.mac).indexOf('launchctl setenv OLLAMA_ORIGINS "https://cadezawacki.github.io"') >= 0);
  assert.ok(/LaunchAgents\/txt\.ollama-origins\.plist/.test(cmds(o.os.mac)[1]), 'persistent macOS variant');
  assert.ok(cmds(o.os.win)[0] === '[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "https://cadezawacki.github.io", "User")');
  assert.ok(/systemctl daemon-reload && sudo systemctl restart ollama$/.test(cmds(o.os.linux)[0]));
  assert.ok(/Environment="OLLAMA_ORIGINS=https:\/\/cadezawacki\.github\.io"/.test(cmds(o.os.linux)[0]));
  assert.strictEqual(cmds(o.os.linux)[1], 'OLLAMA_ORIGINS=https://cadezawacki.github.io ollama serve');
  assert.strictEqual(C.explain('cors', { os: 'linux' }).osPick, 'linux');
  assert.strictEqual(C.explain('cors', { os: 'ios' }).osPick, 'mac');
  var lm = C.explain('cors', { provider: 'lmstudio' });
  assert.ok(lm.steps.some(function (s) { return s.cmd === 'lms server start --cors'; }));
  assert.ok(/Enable CORS/.test(lm.steps[0].t));
  assert.ok(/Safari/.test(C.explain('mixed', {}).title));
  assert.ok(C.explain('model', { provider: 'ollama', model: 'qwen2.5' }).steps.some(function (s) { return s.cmd === 'ollama pull qwen2.5'; }));
  var u = C.explain('unreachable', { provider: 'openai', base: 'http://example.com/v1', origin: 'https://cadezawacki.github.io' });
  assert.ok(u.steps.some(function (s) { return /https:\/\//.test(s.t || ''); }), 'warns about http on the internet');
  ['cors', 'unreachable', 'mixed', 'lna', 'model', 'context', 'auth', 'notfound', 'busy', 'timeout', 'host-offline', 'host-silent', 'host-unready', 'host-stopped',
    'denied', 'nosync', 'not-setup', 'version', 'too-big', 'aborted', 'server', 'weird'].forEach(function (code) {
    var x = C.explain(code, { host: 'MacBook', detail: 'd' });
    assert.ok(x.title, 'title for ' + code);
  });
  assert.ok(/MacBook/.test(C.explain('host-silent', { host: 'MacBook' }).title));
});

// ---- engine against a fake server -------------------------------------------------------------------
var hits = [];
var server = http.createServer(function (req, res) {
  var body = '';
  req.on('data', function (d) { body += d; });
  req.on('end', function () {
    hits.push(req.method + ' ' + req.url + ' ' + (req.headers.authorization || ''));
    var j = {}; try { j = JSON.parse(body || '{}'); } catch (e) {}
    function chunks(list, ct, gap) {
      res.writeHead(200, { 'Content-Type': ct });
      var i = 0;
      (function next() { if (i >= list.length) { res.end(); return; } res.write(list[i++]); setTimeout(next, gap || 2); })();
    }
    if (req.url === '/api/tags') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest', size: 2e9, details: { parameter_size: '3.2B' } }] })); return; }
    if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'gemma' }] })); return; }
    if (req.url === '/api/chat') {
      if (j.model === 'missing') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"model \\"missing\\" not found, try pulling it first"}'); return; }
      if (j.model === 'midfail') { chunks(['{"message":{"content":"par"},"done":false}\n', '{"error":"an error was encountered while running the model"}\n'], 'application/x-ndjson'); return; }
      if (j.model === 'slow') { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.write('{"message":{"content":"a"},"done":false}\n'); setTimeout(function () { try { res.end(); } catch (e) {} }, 3000); return; }
      // the answer, deliberately cut mid-line and mid-character (é is two bytes)
      var nd = '{"message":{"role":"assistant","content":"Hel"},"done":false}\n{"message":{"role":"assistant","content":"lo, café"},"done":false}\n{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":9,"eval_count":3}\n';
      var buf = Buffer.from(nd, 'utf8'), parts = [], k = 0;
      [7, 33, 61, 64, 65, 66, 90, 120].forEach(function (cut) { if (cut > k && cut < buf.length) { parts.push(buf.slice(k, cut)); k = cut; } });
      parts.push(buf.slice(k));
      chunks(parts, 'application/x-ndjson');
      return;
    }
    if (req.url === '/v1/chat/completions') {
      if (j.model === 'json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'whole' }, finish_reason: 'stop' }] })); return; }
      if (j.model === 'long') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"This model\'s maximum context length is 4096 tokens"}}'); return; }
      var sse = 'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"Bon"},"finish_reason":null}]}\r\n\r\n' +
        ': ping\n\n' +
        'data: {"choices":[{"delta":{"content":"jour"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
        'data: [DONE]\n\n';
      chunks(pieces(sse, [5, 11, 3]), 'text/event-stream');
      return;
    }
    res.writeHead(404); res.end('404 page not found');
  });
});
var PORT = 0, BASE = '';
test('(fake model server starts)', function () {
  return new Promise(function (r) { server.listen(0, '127.0.0.1', function () { PORT = server.address().port; BASE = 'http://127.0.0.1:' + PORT; r(); }); });
});
test('engine: Ollama NDJSON streamed in odd pieces → whole text, deltas, usage', function () {
  var deltas = [];
  return C.chatStream(fetch, { kind: 'ollama', base: BASE, model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }], onDelta: function (d, full) { deltas.push([d, full]); } }).then(function (r) {
    assert.strictEqual(r.text, 'Hello, café');
    assert.strictEqual(r.reason, 'stop');
    assert.deepStrictEqual(r.usage, { prompt: 9, output: 3 });
    assert.deepStrictEqual(deltas, [['Hel', 'Hel'], ['lo, café', 'Hello, café']]);
    assert.ok(r.firstMs >= 0 && r.ms >= r.firstMs);
  });
});
test('engine: OpenAI SSE in pieces, finish_reason length, API key header', function () {
  hits = [];
  return C.chatStream(fetch, { kind: 'openai', base: BASE + '/v1', apiKey: 'k1', model: 'gemma', messages: [{ role: 'user', content: 'x' }] }).then(function (r) {
    assert.strictEqual(r.text, 'Bonjour');
    assert.strictEqual(r.reason, 'length');
    assert.ok(hits.some(function (h) { return h === 'POST /v1/chat/completions Bearer k1'; }), hits.join(','));
  });
});
test('engine: a server that ignores stream:true (plain JSON) still works', function () {
  return C.chatStream(fetch, { kind: 'openai', base: BASE + '/v1', model: 'json', messages: [{ role: 'user', content: 'x' }] }).then(function (r) { assert.strictEqual(r.text, 'whole'); });
});
test('engine: missing model (404), context too long (400), error mid-stream keeps the partial', function () {
  return rejects(C.chatStream(fetch, { kind: 'ollama', base: BASE, model: 'missing', messages: [{ role: 'user', content: 'x' }] }), 'model').then(function () {
    return rejects(C.chatStream(fetch, { kind: 'openai', base: BASE + '/v1', model: 'long', messages: [{ role: 'user', content: 'x' }] }), 'context');
  }).then(function () {
    return rejects(C.chatStream(fetch, { kind: 'ollama', base: BASE, model: 'midfail', messages: [{ role: 'user', content: 'x' }] }), 'server');
  }).then(function (e) { assert.strictEqual(e.partial, 'par'); });
});
test('engine: Stop aborts (partial kept), silence times out, nothing listening is a network error', function () {
  var ac = new AbortController();
  var p = rejects(C.chatStream(fetch, { kind: 'ollama', base: BASE, model: 'slow', messages: [{ role: 'user', content: 'x' }], signal: ac.signal,
    onDelta: function () { setTimeout(function () { ac.abort(); }, 20); } }), 'aborted').then(function (e) { assert.strictEqual(e.partial, 'a'); });
  return p.then(function () {
    return rejects(C.chatStream(fetch, { kind: 'ollama', base: BASE, model: 'slow', messages: [{ role: 'user', content: 'x' }], timeoutMs: 200 }), 'timeout');
  }).then(function () {
    return rejects(C.chatStream(fetch, { kind: 'ollama', base: 'http://127.0.0.1:9', model: 'm', messages: [{ role: 'user', content: 'x' }] }), 'network');
  });
});
test('models + probe: lists, wrong API, a closed port, and the no-cors “blocked” case', function () {
  return C.listModels(fetch, { kind: 'ollama', base: BASE }).then(function (r) {
    assert.strictEqual(r.models[0].name, 'llama3.2:latest');
    return C.listModels(fetch, { kind: 'openai', base: BASE + '/v1' });
  }).then(function (r) {
    assert.strictEqual(r.models[0].name, 'gemma');
    return rejects(C.listModels(fetch, { kind: 'openai', base: BASE + '/nope/v1' }), 'notfound');
  }).then(function () {
    return C.probe(fetch, BASE + '/api/tags');
  }).then(function (p) {
    assert.strictEqual(p.state, 'ok'); assert.strictEqual(p.status, 200);
    return C.probe(fetch, 'http://127.0.0.1:9/api/tags', { timeoutMs: 1000 });
  }).then(function (p) {
    assert.strictEqual(p.state, 'down');
    // what a browser does when CORS blocks: the cors request throws, the no-cors one resolves (opaque)
    var stub = function (u, init) { return init.mode === 'no-cors' ? Promise.resolve({ type: 'opaque', status: 0 }) : Promise.reject(new TypeError('Failed to fetch')); };
    return C.probe(stub, 'http://127.0.0.1:11434/api/tags');
  }).then(function (p) {
    assert.strictEqual(p.state, 'blocked');
    var seen = null, stub2 = function (u, init) { seen = init; return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve('{"models":[]}'); } }); };
    return C.listModels(stub2, { kind: 'ollama', base: 'http://192.168.1.9:11434', Request: function () {} }).then(function () {
      assert.strictEqual(seen.targetAddressSpace, 'local', 'LAN address: Chromium needs targetAddressSpace');
      return C.listModels(stub2, { kind: 'ollama', base: 'http://192.168.1.9:11434', Request: function () { throw new TypeError('bad enum'); } });
    }).then(function () {
      assert.strictEqual(seen.targetAddressSpace, undefined, 'left out where the browser rejects it');
      return C.listModels(stub2, { kind: 'ollama', base: 'http://127.0.0.1:11434', Request: function () {} });
    }).then(function () { assert.strictEqual(seen.targetAddressSpace, undefined, 'never for loopback'); });
  });
});

// ---- context ---------------------------------------------------------------------------------------------
test('tokens and budget', function () {
  assert.strictEqual(C.estTokens(''), 0);
  assert.strictEqual(C.estTokens('abcd'), 1);
  assert.strictEqual(C.estTokens('abcdefgh'), 2);
  assert.strictEqual(C.estTokens('日本語'), 3, 'CJK ≈ a token a character');
  assert.ok(C.estTokens('😀😀') >= 2);
  assert.strictEqual(C.budget({ contextWindow: 0, maxTokens: 1024 }), 4096 - 1024 - 48);
  assert.strictEqual(C.budget({ contextWindow: 2048, maxTokens: 4000 }), 2048 - 1024 - 48, 'the answer gets at most half');
  assert.strictEqual(C.budget({ contextWindow: 300, maxTokens: 64 }), 256, 'never below 256');
});
test('fitText keeps the start and the end and says what was left out', function () {
  var long = '';
  for (var i = 0; i < 2000; i++) long += 'Line ' + i + ' of the note.\n';
  var f = C.fitText(long, 500);
  assert.ok(f.trimmed);
  assert.ok(C.estTokens(f.text) <= 520, 'fits: ' + C.estTokens(f.text));
  assert.ok(f.text.indexOf('Line 0 of the note.') === 0);
  assert.ok(/Line 1999 of the note\.\n$/.test(f.text));
  assert.ok(/\[… \d+ characters left out to fit the model …\]/.test(f.text));
  assert.strictEqual(C.fitText('short', 100).trimmed, false);
});
test('assemble: system + history that fits + the question with its context', function () {
  var hist = [];
  for (var i = 0; i < 30; i++) hist.push({ role: i % 2 ? 'assistant' : 'user', content: 'turn ' + i + ' ' + new Array(200).join('x') });
  var a = C.assemble({ system: 'Be brief.', history: hist, instruction: 'Summarise this.', ctx: { label: 'Selected text', text: 'The cat sat.' }, budget: 600 });
  assert.strictEqual(a.messages[0].role, 'system');
  assert.strictEqual(a.messages[1].role, 'user', 'history starts on a question');
  var last = a.messages[a.messages.length - 1];
  assert.strictEqual(last.role, 'user');
  assert.strictEqual(last.content, 'Summarise this.\n\n--- Selected text ---\nThe cat sat.\n--- end ---');
  assert.ok(a.dropped > 0 && a.messages.length < 32);
  assert.ok(a.messages.slice(1, -1).every(function (m, k, arr) { return k === 0 || arr[k - 1].role !== m.role; }), 'alternating');
  assert.ok(a.tokens <= 600, 'within budget: ' + a.tokens);
  var big = C.assemble({ system: 's', history: [], instruction: 'Explain', ctx: { label: 'Note', text: new Array(20000).join('word ') }, budget: 1000 });
  assert.ok(big.trimmed && C.estTokens(big.messages[1].content) < 1000);
  assert.strictEqual(C.assemble({ system: '', history: [], instruction: 'hi', ctx: null }).messages.length, 1);
  assert.ok(/into Spanish/.test(C.actionPrompt('translate', 'Spanish')));
  assert.strictEqual(C.ACTIONS.length, 6);
});

// ---- relay pieces ---------------------------------------------------------------------------------------
test('batcher: first piece at once, then gathered per interval, split at the size cap', function () {
  var now = 0, timers = [], out = [];
  var b = C.createBatcher({ interval: 150, max: 10, emit: function (x) { out.push([now, x]); }, now: function () { return now; },
    set: function (f, ms) { timers.push({ at: now + ms, f: f }); return timers.length; }, clear: function (id) { if (timers[id - 1]) timers[id - 1].f = null; } });
  function tick(ms) { now += ms; timers.forEach(function (t) { if (t.f && t.at <= now) { var f = t.f; t.f = null; f(); } }); }
  b.add('A'); assert.deepStrictEqual(out, [[0, 'A']]);
  tick(20); b.add('b'); tick(20); b.add('c'); assert.strictEqual(out.length, 1, 'gathered');
  tick(110); assert.deepStrictEqual(out[1], [150, 'bc'], 'flushed by the timer after the interval');
  tick(10); b.add('0123456789abcdef'); assert.deepStrictEqual(out.slice(2).map(function (x) { return x[1]; }), ['0123456789', 'abcdef'], 'over the cap goes now, in pieces');
  b.add('z'); b.drain(); assert.strictEqual(out[out.length - 1][1], 'z');
  b.add('q'); b.cancel(); tick(500); assert.notStrictEqual(out[out.length - 1][1], 'q');
  assert.deepStrictEqual(C.splitSafe('ab😀cd', 3), ['ab', '😀c', 'd'], 'never splits a surrogate pair');
});
test('reassembler: in order, early pieces held, duplicates dropped', function () {
  var got = [];
  var r = C.createReassembler(function (m) { got.push(m.q); });
  [3, 1, 1, 2, 5, 4, 2, 6].forEach(function (q) { r.add({ q: q }); });
  assert.deepStrictEqual(got, [1, 2, 3, 4, 5, 6]);
  assert.strictEqual(r.add({ q: 'x' }), false);
});
test('requests are validated and clamped', function () {
  var ok = C.validateRequest(C.makeRequest({ id: 'abc123def456', from: 'dev1-tab', name: 'iPhone', kind: 'phone', did: 'dev1', model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 9, maxTokens: 999999 }));
  assert.ok(ok.ok);
  assert.strictEqual(ok.req.temperature, 2); assert.strictEqual(ok.req.maxTokens, C.RELAY.MAX_TOKENS);
  assert.strictEqual(ok.req.name, 'iPhone');
  function bad(o, code) { var v = C.validateRequest(o); assert.ok(!v.ok); assert.strictEqual(v.code, code); }
  var base = { v: 1, id: 'abc123def456', f: 'a-b', messages: [{ role: 'user', content: 'x' }] };
  bad(Object.assign({}, base, { v: 2 }), 'version');
  bad(Object.assign({}, base, { id: '../x' }), 'bad');
  bad(Object.assign({}, base, { f: 'a/b' }), 'bad');
  bad(Object.assign({}, base, { messages: [] }), 'bad');
  bad(Object.assign({}, base, { messages: [{ role: 'tool', content: 'x' }] }), 'bad');
  bad(Object.assign({}, base, { messages: [{ role: 'user', content: new Array(C.RELAY.REQ_MAX + 2).join('a') }] }), 'too-big');
  assert.ok(/^m\d{6}$/.test(C.seqKey(7)) && C.seqKey(7) < C.seqKey(10) && C.seqKey(99) < C.seqKey(100));
});
test('presence: stale entries dropped, this device skipped, one per device, newest first', function () {
  var now = 1e9;
  var list = C.parsePresence([
    { inst: 'a-1', at: now - 1000, o: { n: 'MacBook', d: 'a', m: ['llama3.2'], dm: 'llama3.2', ok: true } },
    { inst: 'a-2', at: now - 500, o: { n: 'MacBook', d: 'a', m: ['llama3.2', 'qwen'], dm: 'qwen', busy: true } },
    { inst: 'b-1', at: now - 100000, o: { n: 'Old PC', d: 'b' } },
    { inst: 'c-1', at: now - 2000, o: { n: 'Me', d: 'me' } },
    { inst: 'd-1', at: now - 3000, o: { n: 'Linux box', d: 'd', ok: false, pol: 'ask' } }
  ], now, 'me');
  assert.deepStrictEqual(list.map(function (h) { return h.inst; }), ['a-2', 'd-1']);
  assert.strictEqual(list[0].busy, true); assert.strictEqual(list[0].model, 'qwen');
  assert.strictEqual(list[1].ok, false); assert.strictEqual(list[1].policy, 'ask');
  assert.strictEqual(C.pickHost(list, '').inst, 'a-2');
  assert.strictEqual(C.pickHost(list, 'd').inst, 'd-1', 'the preferred device');
  assert.strictEqual(C.pickHost([list[1]], '').inst, 'd-1', 'an unready host still beats none');
  assert.strictEqual(C.pickHost([], ''), null);
});

// ---- relay end-to-end over an in-memory cloud ----------------------------------------------------------------
function fakeCloud() {
  var tree = {}, ls = [], writes = 0;
  function parts(p) { return p.split('/').filter(Boolean); }
  function get(p) { var n = tree, a = parts(p); for (var i = 0; i < a.length; i++) { if (!n || typeof n !== 'object') return null; n = n[a[i]]; } return n == null ? null : n; }
  function clone(v) { return v == null ? null : JSON.parse(JSON.stringify(v)); }
  function put(p, v) {
    var before = ls.map(function (l) { return JSON.stringify(get(l.path)); });
    var a = parts(p), n = tree;
    for (var i = 0; i < a.length - 1; i++) { if (!n[a[i]] || typeof n[a[i]] !== 'object') n[a[i]] = {}; n = n[a[i]]; }
    if (v == null) delete n[a[a.length - 1]]; else n[a[a.length - 1]] = clone(v);
    // prune empty parents (like Firebase)
    (function prune(node, ks) { if (!ks.length) return; var k = ks[0], c = node[k]; if (c && typeof c === 'object') { prune(c, ks.slice(1)); if (!Object.keys(c).length) delete node[k]; } })(tree, a.slice(0, -1));
    writes++;
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
  var sealed = 0;
  var cloud = {
    // async unsealing with random delays: pieces resolve out of order like real WebCrypto may
    ref: function (sub) { return Promise.resolve(ref('rooms/__cade_ai_fp/' + sub)); },
    seal: function (o) { sealed++; return Promise.resolve('S:' + JSON.stringify(o)); },
    unseal: function (s) { return new Promise(function (r) { setTimeout(function () { r(s.indexOf('S:') === 0 ? JSON.parse(s.slice(2)) : null); }, Math.floor(Math.random() * 6)); }); },
    ts: function () { return Date.now(); },
    now: function () { return Date.now(); }
  };
  return { cloud: cloud, tree: function () { return tree; }, get: get, put: put, listeners: function () { return ls.length; }, disc: function () { return disc; }, sealed: function () { return sealed; } };
}
var FAST = { BATCH_MS: 15, ACK_MS: 400, ASK_MS: 300, KEEPALIVE_MS: 50, FIRST_MIN_MS: 600, BEAT_MS: 1000 };
function mkHost(fc, o) {
  o = o || {};
  var runs = [];
  var h = C.createRelayHost({
    cloud: fc.cloud, limits: Object.assign({}, FAST, o.limits || {}),
    device: function () { return { inst: 'mac1-t1', name: 'MacBook', kind: 'desktop', id: 'mac1' }; },
    info: function () { return { models: ['llama3.2'], model: 'llama3.2', ok: true, provider: 'ollama' }; },
    policy: function () { return o.policy || 'auto'; },
    ask: o.ask,
    run: o.run || function (job, hh) {
      runs.push(job);
      hh.model('llama3.2');
      return new Promise(function (resolve, reject) {
        var words = (o.answer || 'The quick brown fox jumps over the lazy dog').split(/(?= )/), i = 0;
        var t = setInterval(function () {
          if (hh.signal && hh.signal.aborted) { clearInterval(t); var e = new Error('aborted'); e.name = 'AbortError'; reject(e); return; }
          if (i >= words.length) { clearInterval(t); resolve({ reason: 'stop', usage: { prompt: 3, output: words.length }, model: 'llama3.2' }); return; }
          hh.onDelta(words[i++]);
        }, o.gap || 5);
      });
    }
  });
  h.runs = runs;
  return h;
}
function mkClient(fc, inst, limits) {
  return C.createRelayClient({ cloud: fc.cloud, limits: Object.assign({}, FAST, limits || {}),
    device: function () { return { inst: inst, name: 'iPhone', kind: 'phone', id: inst.split('-')[0] }; } });
}
test('relay: the phone asks, the host streams, the answer arrives whole and in order; nothing is left behind', function () {
  var fc = fakeCloud(), host = mkHost(fc), cl = mkClient(fc, 'ph1-x');
  var deltas = [], events = [];
  return host.start().then(function (ok) {
    assert.ok(ok);
    return cl.listHosts();
  }).then(function (hosts) {
    assert.strictEqual(hosts.length, 1);
    assert.strictEqual(hosts[0].name, 'MacBook');
    assert.deepStrictEqual(hosts[0].models, ['llama3.2']);
    return cl.request(hosts[0], { model: '', messages: [{ role: 'user', content: 'Say the fox line' }], temperature: 0.5, maxTokens: 100 },
      { onDelta: function (d, full) { deltas.push(full); }, onEvent: function (m) { events.push(m.t); }, timeoutMs: 2000 });
  }).then(function (r) {
    assert.strictEqual(r.text, 'The quick brown fox jumps over the lazy dog');
    assert.strictEqual(r.reason, 'stop');
    assert.strictEqual(r.model, 'llama3.2');
    assert.strictEqual(deltas[deltas.length - 1], r.text);
    deltas.forEach(function (d, i) { if (i) assert.ok(d.indexOf(deltas[i - 1]) === 0, 'grows in order'); });
    assert.ok(events.indexOf('a') >= 0 && events.indexOf('s') >= 0 && events.indexOf('z') >= 0, events.join(','));
    assert.ok(deltas.length < 9, 'batched (' + deltas.length + ' writes for 9 words)');
    assert.strictEqual(host.runs[0].req.temperature, 0.5);
    assert.strictEqual(host.runs[0].req.name, 'iPhone');
    return wait(60);
  }).then(function () {
    var t = fc.tree().rooms.__cade_ai_fp;
    assert.ok(!t.req, 'request removed: ' + JSON.stringify(t.req));
    assert.ok(!t.res, 'answer removed: ' + JSON.stringify(t.res));
    assert.ok(t.hosts && t.hosts['mac1-t1'], 'presence stays while sharing');
    assert.strictEqual(host.status().served, 1);
    return host.stop();
  }).then(function () {
    assert.ok(!fc.get('rooms/__cade_ai_fp/hosts/mac1-t1'), 'presence withdrawn');
    assert.strictEqual(fc.listeners(), 0, 'no listeners left');
  });
});
test('relay: a second question waits in line (told its place) and is answered after the first', function () {
  var fc = fakeCloud(), host = mkHost(fc, { gap: 8 }), a = mkClient(fc, 'ph1-a'), b = mkClient(fc, 'ph2-b'), evB = [];
  var h = { inst: 'mac1-t1', name: 'MacBook' };
  return host.start().then(function () {
    var q = { messages: [{ role: 'user', content: 'x' }] };
    var pa = a.request(h, q, { timeoutMs: 3000 });
    return wait(15).then(function () {
      var pb = b.request(h, q, { timeoutMs: 3000, onEvent: function (m) { evB.push(m.t + (m.pos != null ? m.pos : '')); } });
      return Promise.all([pa, pb]);
    });
  }).then(function (rs) {
    assert.strictEqual(rs[0].text, rs[1].text);
    assert.ok(evB.indexOf('a1') >= 0, 'told: 1 ahead (' + evB.join(',') + ')');
    assert.ok(evB.lastIndexOf('s') > evB.indexOf('a1'), 'then: started (' + evB.join(',') + ')');
    return host.stop();
  });
});
test('relay: a full queue says busy; Ask-me-each-time can decline', function () {
  var fc = fakeCloud(), host = mkHost(fc, { gap: 30, limits: { QUEUE_MAX: 1 } }), h = { inst: 'mac1-t1', name: 'MacBook' };
  var q = { messages: [{ role: 'user', content: 'x' }] };
  return host.start().then(function () {
    var c1 = mkClient(fc, 'p1-a').request(h, q, { timeoutMs: 3000 }).catch(function () {});
    return wait(20).then(function () {
      var c2 = mkClient(fc, 'p2-a').request(h, q, { timeoutMs: 3000 }).catch(function () {});
      return wait(20).then(function () { return rejects(mkClient(fc, 'p3-a').request(h, q, { timeoutMs: 3000 }), 'busy'); }).then(function () { return Promise.all([c1, c2]); });
    });
  }).then(function () { return host.stop(); }).then(function () {
    var fc2 = fakeCloud(), asked = [];
    var host2 = mkHost(fc2, { policy: 'ask', ask: function (job) { asked.push(job.req.name); return Promise.resolve(false); } });
    return host2.start().then(function () {
      var ev = [];
      return rejects(mkClient(fc2, 'p1-z').request(h, q, { timeoutMs: 3000, onEvent: function (m) { ev.push(m.t); } }), 'denied').then(function () {
        assert.deepStrictEqual(asked, ['iPhone']);
        assert.ok(ev.indexOf('w') >= 0, 'told it waits for a yes');
        return host2.stop();
      });
    });
  }).then(function () {
    var fc3 = fakeCloud();
    var host3 = mkHost(fc3, { policy: 'ask', ask: function () { return Promise.resolve(true); } });
    return host3.start().then(function () { return mkClient(fc3, 'p1-y').request(h, q, { timeoutMs: 3000 }); }).then(function (r) { assert.ok(r.text); return host3.stop(); });
  });
});
test('relay: Stop on the phone cancels the run on the host; the partial text is kept', function () {
  var fc = fakeCloud(), host = mkHost(fc, { gap: 25, answer: 'one two three four five six seven eight nine ten eleven twelve' }), cl = mkClient(fc, 'ph1-c');
  var ac = new AbortController(), got = '';
  return host.start().then(function () {
    return rejects(cl.request({ inst: 'mac1-t1', name: 'MacBook' }, { messages: [{ role: 'user', content: 'count' }] },
      { signal: ac.signal, timeoutMs: 3000, onDelta: function (d, full) { got = full; if (full.split(' ').length >= 3) ac.abort(); } }), 'aborted');
  }).then(function (e) {
    assert.ok(e.partial && e.partial === got, 'partial kept: ' + e.partial);
    return wait(150);
  }).then(function () {
    var job = host.runs[0];
    assert.ok(job.cancelled, 'host saw the cancel');
    assert.ok(job.ctl.signal.aborted, 'the local run was aborted');
    var t = fc.tree().rooms.__cade_ai_fp;
    assert.ok(!t.ctl, 'cancel note removed');
    assert.ok(!t.res, 'answer removed');
    assert.strictEqual(host.status().busy, false);
    return host.stop();
  });
});
test('relay: nobody home → host-silent; a host that goes quiet → timeout; a stopped host tells the asker', function () {
  var fc = fakeCloud(), cl = mkClient(fc, 'ph1-d');
  var t0 = Date.now();
  return rejects(cl.request({ inst: 'ghost-1', name: 'Ghost' }, { messages: [{ role: 'user', content: 'x' }] }, { timeoutMs: 5000 }), 'host-silent').then(function () {
    assert.ok(Date.now() - t0 < 1500);
    var t = fc.tree().rooms;
    assert.ok(!t || !t.__cade_ai_fp || !t.__cade_ai_fp.req, 'unanswered request withdrawn');
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
test('relay: the heartbeat brings presence back after the server dropped it (laptop slept)', function () {
  var fc = fakeCloud(), host = mkHost(fc, { limits: { BEAT_MS: 60 } });
  return host.start().then(function () {
    fc.put('rooms/__cade_ai_fp/hosts/mac1-t1', null);   // what onDisconnect does when the connection drops
    return wait(150);
  }).then(function () {
    var e = fc.get('rooms/__cade_ai_fp/hosts/mac1-t1');
    assert.ok(e && typeof e.s === 'string' && e.at, 'the whole entry is back: ' + JSON.stringify(e));
    return host.stop();
  });
});
test('relay: a timer that fires very late (page suspended) waits another round instead of failing', function () {
  var fc = fakeCloud(), realNow = Date.now, skew = 0, lateOnce = true, rounds = 0;
  Date.now = function () { return realNow() + skew; };
  var cl = C.createRelayClient({ cloud: fc.cloud, limits: Object.assign({}, FAST, { ACK_MS: 100 }),
    device: function () { return { inst: 'ph9-s', name: 'iPhone', kind: 'phone', id: 'ph9' }; },
    timers: {
      setTimeout: function (f, ms) { return setTimeout(function () { if (ms === 100) { rounds++; if (lateOnce) { lateOnce = false; skew += 20000; } } f(); }, ms); },
      clearTimeout: function (t) { clearTimeout(t); }
    } });
  return rejects(cl.request({ inst: 'ghost-2', name: 'Ghost' }, { messages: [{ role: 'user', content: 'x' }] }, { timeoutMs: 60000 }), 'host-silent')
    .then(function () { Date.now = realNow; assert.strictEqual(rounds, 2, 'one extra round after the late timer'); },
      function (e) { Date.now = realNow; throw e; });
});
test('probe: no no-cors fallback when not wanted', function () {
  var calls = [];
  var stub = function (u, init) { calls.push(init.mode || 'cors'); return Promise.reject(new TypeError('Failed to fetch')); };
  return C.probe(stub, 'http://127.0.0.1:8080/v1/models', { noCors: false }).then(function (p) {
    assert.strictEqual(p.state, 'down'); assert.deepStrictEqual(calls, ['cors']);
  });
});
test('relay: watching hosts sees one appear and leave', function () {
  var fc = fakeCloud(), cl = mkClient(fc, 'ph1-w'), host = mkHost(fc), seen = [];
  var off = cl.watchHosts(function (l) { seen.push(l ? l.map(function (h) { return h.name; }).join(',') : 'null'); });
  return wait(20).then(function () { return host.start(); }).then(function () { return wait(40); }).then(function () { return host.stop(); }).then(function () { return wait(40); }).then(function () {
    off();
    assert.deepStrictEqual(seen.filter(function (s, i) { return i === 0 || s !== seen[i - 1]; }), ['', 'MacBook', '']);
    assert.strictEqual(fc.listeners(), 0);
  });
});
test('relay: a garbled or foreign request is ignored, an old one dropped unread', function () {
  var fc = fakeCloud(), host = mkHost(fc);
  return host.start().then(function () {
    fc.put('rooms/__cade_ai_fp/req/mac1-t1/aaaaaaaaaaaa', { f: 'x-1', s: 'not sealed', at: Date.now() });
    fc.put('rooms/__cade_ai_fp/req/mac1-t1/bbbbbbbbbbbb', { f: 'x-1', s: 'S:' + JSON.stringify(C.makeRequest({ id: 'bbbbbbbbbbbb', from: 'x-1', messages: [{ role: 'user', content: 'old' }] })), at: Date.now() - 10 * 60000 });
    return wait(60);
  }).then(function () {
    assert.strictEqual(host.runs.length, 0);
    assert.ok(!fc.get('rooms/__cade_ai_fp/req'), 'both removed');
    assert.ok(!fc.get('rooms/__cade_ai_fp/res'), 'no answer written');
    return host.stop();
  });
});

// ---- markdown --------------------------------------------------------------------------------------------
test('markdown: formatting, code, lists, tables — and no HTML or unsafe links get through', function () {
  var h = C.mdToHtml('# Title\n\nSome **bold**, *it*, `x<y`, ~~old~~ and [a link](https://ex.com).\n\n- [ ] todo\n- [x] done\n  - nested\n\n1. one\n2. two\n\n```js\nif (a < b) alert(1)\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote');
  assert.ok(h.indexOf('<h3>Title</h3>') >= 0, h);
  assert.ok(h.indexOf('<strong>bold</strong>') >= 0 && h.indexOf('<em>it</em>') >= 0 && h.indexOf('<del>old</del>') >= 0);
  assert.ok(h.indexOf('<code>x&lt;y</code>') >= 0);
  assert.ok(h.indexOf('<a href="https://ex.com" target="_blank" rel="noopener noreferrer">a link</a>') >= 0);
  assert.ok(h.indexOf('<li class="task">') >= 0 && h.indexOf('class="task done"') >= 0 && h.indexOf('class="ind1"') >= 0);
  assert.ok(h.indexOf('<ol><li>one</li><li>two</li></ol>') >= 0);
  assert.ok(h.indexOf('<pre><code class="language-js">if (a &lt; b) alert(1)</code></pre>') >= 0);
  assert.ok(h.indexOf('<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>') >= 0);
  assert.ok(h.indexOf('<blockquote><p>quote</p></blockquote>') >= 0);
  var x = C.mdToHtml('<img src=x onerror=alert(1)> [click](javascript:alert(1)) <script>bad()</script> snake_case_name');
  assert.ok(x.indexOf('<img') < 0 && x.indexOf('<script') < 0 && x.indexOf('href') < 0, x);
  assert.ok(x.indexOf('&lt;img') >= 0 && x.indexOf('snake_case_name') >= 0);
  assert.strictEqual(C.safeUrl('javascript:x'), '');
  assert.strictEqual(C.safeUrl('mailto:a@b.c'), 'mailto:a@b.c');
});
test('note names from an answer; device sniffing', function () {
  assert.strictEqual(C.roomNameFrom('## Shopping list for Saturday\n- eggs', []), 'shopping list for saturday');
  assert.strictEqual(C.roomNameFrom('**Plan**', ['plan']), 'plan 2');
  assert.strictEqual(C.roomNameFrom('a/b.c#d$[e]', []), 'a b c d e');
  assert.strictEqual(C.roomNameFrom('', []), 'ai answer');
  var long = C.roomNameFrom('The quarterly planning session for next year and everything after it', []);
  assert.ok(long.length <= 40 && !/ $/.test(long), long);
  var mac = C.sniff('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', 0);
  assert.deepStrictEqual([mac.os, mac.browser], ['mac', 'safari']);
  var ipad = C.sniff('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', 5);
  assert.deepStrictEqual([ipad.os, ipad.browser, ipad.ios], ['ios', 'safari', true]);
  assert.deepStrictEqual([C.sniff('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0').browser], ['edge']);
  assert.deepStrictEqual([C.sniff('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0').os], ['linux']);
  assert.deepStrictEqual([C.sniff('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130 Mobile/15E148 Safari/604.1').browser], ['chrome']);
  assert.strictEqual(C.fmtMs(850), '850 ms'); assert.strictEqual(C.fmtMs(1500), '1.5 s'); assert.strictEqual(C.fmtBytes(2019393189), '2.0 GB');
});

// ---- prefs + registration ------------------------------------------------------------------------------------
test('prefs: the module schema is the manifest one, and it is sound', function () {
  var m = manifestEntry('ai');
  assert.ok(m && m.prefs, 'manifest entry with prefs');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m.prefs.fields)), JSON.parse(JSON.stringify(C.PREFS)));
  var keys = {}, TYPES = ['text', 'textarea', 'number', 'slider', 'toggle', 'checkbox', 'radio', 'select', 'date', 'time', 'color', 'heading'];
  C.PREFS.forEach(function (f) {
    assert.ok(TYPES.indexOf(f.type) >= 0, f.type);
    if (f.type === 'heading') return;
    assert.ok(f.key && !keys[f.key], 'unique key ' + f.key);
    keys[f.key] = f;
    if (f.type === 'number' || f.type === 'slider') { assert.ok(f.default >= f.min && f.default <= f.max, f.key); assert.ok(Math.abs(Math.round((f.default - f.min) / f.step) * f.step + f.min - f.default) < 1e-9, f.key + ' on a step'); }
    if (f.options) assert.ok(f.options.some(function (o) { return o.value === f.default; }), f.key + ' default is an option');
    if (f.showIf) assert.strictEqual(keys[f.showIf.replace(/^!/, '')].type, 'toggle');
  });
  ['provider', 'endpoint', 'model', 'temperature', 'maxTokens', 'contextWindow', 'system', 'share', 'policy', 'timeout', 'history'].forEach(function (k) { assert.ok(keys[k], 'has ' + k); });
  assert.strictEqual(keys.share.default, false, 'sharing is opt-in');
  assert.ok(!keys.apiKey && !keys.key, 'an API key never goes in prefs (they may sync)');
  assert.deepStrictEqual(Object.keys(C.PRESETS), keys.provider.options.map(function (o) { return o.value; }));
});
test('widget and plugin register as the manifest says; nothing runs at load', function () {
  var w = manifestEntry('ai'), p = manifestEntry('ai-host');
  assert.strictEqual(w.type, 'widget'); assert.strictEqual(w.entry, 'widgets/ai/ai.js');
  assert.strictEqual(p.type, 'plugin'); assert.strictEqual(p.settingKey, 'plugins.ai-host'); assert.strictEqual(p.section, 'Devices'); assert.strictEqual(p.default, false);
  var reg = null, plug = null, css = [], timers = 0, listens = 0;
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
  assert.ok(fake.Cade.ai && typeof fake.Cade.ai.chat === 'function' && typeof fake.Cade.ai.status === 'function' && typeof fake.Cade.ai.models === 'function', 'Cade.ai registered (lazy)');
  new Function('window', 'module', 'document', 'setTimeout', 'setInterval', fs.readFileSync(path.join(__dirname, 'ai-host.js'), 'utf8'))(fake, undefined, fake.document, st, st);
  assert.strictEqual(plug.id, 'ai-host');
  assert.ok(plug.ext && plug.ext.__vp, 'lifetime tied to an editor ViewPlugin');
  assert.strictEqual(timers + listens, 0, 'no timers or listeners until opened / enabled');
  var icons = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id !== 'ai'; }).map(function (m) { return m.icon; });
  assert.ok(icons.indexOf(w.icon) < 0, 'icon not taken');
});

run();
