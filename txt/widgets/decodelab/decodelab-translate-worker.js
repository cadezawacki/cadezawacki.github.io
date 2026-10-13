/* Decode Lab — on-device translation worker: the Bergamot engine (the one
 * Firefox Translations runs; MPL-2.0) compiled to WebAssembly, translating
 * into English with Mozilla's int8 models.
 *
 * Classic worker (importScripts-era emscripten glue). Every byte it needs is
 * fetched only when the user taps Download, verified against the SHA-256 that
 * Mozilla publishes for that file, and kept in OUR Cache Storage bucket
 * (CACHE below) — not the service worker's versioned cache, which is wiped on
 * each app release. Requests use cache:'no-store' so the SW leaves them alone
 * (it would otherwise store a second copy). Once cached, translation works
 * offline.
 *
 * Requirements: WebAssembly SIMD (Safari / iOS 16.4+, Chrome 91+, Firefox 89+).
 * Single-threaded build — no SharedArrayBuffer / cross-origin isolation needed.
 *
 * Protocol (page <-> worker), every request carries an id:
 *   -> {type:'download', id, files:[{u, s, h}]}            fetch + verify + store
 *   -> {type:'translate', id, engine:{glue, wasm}, lang, files:{model, lex, vocab|srcvocab+trgvocab}, texts:[...]}
 *   -> {type:'free', id}                                     drop the loaded model
 *   <- {type:'progress', id, loaded, total, stage}           stage: download | verify | engine | model
 *   <- {type:'done', id, texts?}  |  {type:'error', id, message}
 */
'use strict';
var CACHE = 'cade-translate-v1';
var Module = {}; // global: the emscripten glue picks it up

var engineP = null;   // Promise<Module>
var service = null;   // BlockingService
var loaded = null;    // { lang, model }

var GEMM = {
  int8_prepare_a: 'int8PrepareAFallback',
  int8_prepare_b: 'int8PrepareBFallback',
  int8_prepare_b_from_transposed: 'int8PrepareBFromTransposedFallback',
  int8_prepare_b_from_quantized_transposed: 'int8PrepareBFromQuantizedTransposedFallback',
  int8_prepare_bias: 'int8PrepareBiasFallback',
  int8_multiply_and_add_bias: 'int8MultiplyAndAddBiasFallback',
  int8_select_columns_of_b: 'int8SelectColumnsOfBFallback',
};

function post(m) { self.postMessage(m); }
function errMsg(e) { return (e && (e.message || String(e))) || 'unknown error'; }

async function openCache() {
  try { return self.caches ? await self.caches.open(CACHE) : null; } catch (e) { return null; }
}
function hex(buf) {
  var b = new Uint8Array(buf), s = '';
  for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}
async function sha256(buf) {
  if (!self.crypto || !self.crypto.subtle) return null; // insecure context: cannot verify
  return hex(await self.crypto.subtle.digest('SHA-256', buf));
}

// Download one file with live progress into a single pre-sized buffer
// (sizes are known up front, so no chunk list + copy doubling the peak).
async function fetchBytes(f, onBytes) {
  var res = await fetch(f.u, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + f.u.split('/').pop());
  if (!res.body || !res.body.getReader) { var whole = await res.arrayBuffer(); onBytes(whole.byteLength); return whole; }
  var reader = res.body.getReader(), got = 0, u8 = new Uint8Array(Math.max(f.s || 0, 65536));
  for (;;) {
    var r = await reader.read();
    if (r.done) break;
    var c = r.value;
    if (got + c.length > u8.length) { var bigger = new Uint8Array(Math.max(u8.length * 2, got + c.length)); bigger.set(u8.subarray(0, got)); u8 = bigger; }
    u8.set(c, got); got += c.length;
    onBytes(got);
  }
  return got === u8.length ? u8.buffer : u8.slice(0, got).buffer;
}

// Ensure every file is in the cache (downloading + verifying what is missing).
async function ensureFiles(id, files) {
  var cache = await openCache();
  if (!cache) throw new Error('Storage is unavailable (private browsing?) — cannot keep models offline');
  var total = 0, base = 0, last = 0;
  files.forEach(function (f) { total += f.s || 0; });
  for (var i = 0; i < files.length; i++) {
    var f = files[i], hit = null;
    try { hit = await cache.match(f.u); } catch (e) { hit = null; }
    if (hit) { base += f.s || 0; continue; }
    var buf = await fetchBytes(f, function (n) {
      var now = Date.now();
      if (now - last > 120) { last = now; post({ type: 'progress', id: id, stage: 'download', loaded: base + Math.min(n, f.s || n), total: total }); }
    });
    post({ type: 'progress', id: id, stage: 'verify', loaded: base + (f.s || buf.byteLength), total: total });
    var h = await sha256(buf);
    if (h && f.h && h !== f.h) throw new Error('Checksum mismatch for ' + f.u.split('/').pop() + ' — download refused');
    if (f.s && buf.byteLength !== f.s) throw new Error('Unexpected size for ' + f.u.split('/').pop());
    await cache.put(f.u, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.byteLength) } }));
    buf = null;
    base += f.s || 0;
  }
  post({ type: 'progress', id: id, stage: 'download', loaded: total, total: total });
}
async function cachedBytes(f) {
  var cache = await openCache(), hit = cache ? await cache.match(f.u) : null;
  if (!hit) throw new Error('Model file missing — download the language again');
  return hit.arrayBuffer();
}

function loadEngine(id, eng) {
  if (engineP) return engineP;
  engineP = (async function () {
    if (typeof WebAssembly !== 'object') throw new Error('WebAssembly is not available');
    await ensureFiles(id, [eng.glue, eng.wasm]);
    post({ type: 'progress', id: id, stage: 'engine', loaded: 0, total: 1 });
    var wasm = await cachedBytes(eng.wasm), glue = new TextDecoder().decode(await cachedBytes(eng.glue));
    if (!WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]))) {
      throw new Error('This browser lacks WebAssembly SIMD (needs iOS/Safari 16.4+ or a recent Chrome/Firefox)');
    }
    var M = await new Promise(function (resolve, reject) {
      Module = self.Module = {
        instantiateWasm: function (info, accept) {
          var gemm = {};
          Object.keys(GEMM).forEach(function (k) { gemm[k] = function () { return Module.asm[GEMM[k]].apply(null, arguments); }; });
          var imports = Object.assign({}, info, { wasm_gemm: gemm });
          WebAssembly.instantiate(wasm, imports).then(function (r) { wasm = null; accept(r.instance); }, reject);
          return {};
        },
        onRuntimeInitialized: function () { resolve(Module); },
        onAbort: function (w) { reject(new Error('engine aborted: ' + w)); },
        print: function () {},
        printErr: function () {},
      };
      // Classic emscripten glue: evaluate in the worker's global scope.
      (0, eval)(glue);
    });
    service = new M.BlockingService({ cacheSize: 0 });
    return M;
  })();
  engineP.catch(function () { engineP = null; });
  return engineP;
}

function aligned(M, buf, align) {
  var bytes = new Int8Array(buf), mem = new M.AlignedMemory(bytes.byteLength, align);
  mem.getByteArrayView().set(bytes);
  return mem;
}
function freeModel() {
  if (loaded) { try { loaded.model.delete(); } catch (e) {} loaded = null; }
}
// One model in memory at a time: phones have little to spare.
async function loadModel(id, M, lang, files) {
  if (loaded && loaded.lang === lang) return loaded.model;
  freeModel();
  var list = [files.model, files.lex].concat(files.vocab ? [files.vocab] : [files.srcvocab, files.trgvocab]);
  await ensureFiles(id, list);
  post({ type: 'progress', id: id, stage: 'model', loaded: 0, total: 1 });
  var model = aligned(M, await cachedBytes(files.model), 256);
  var lex = aligned(M, await cachedBytes(files.lex), 64);
  var vocabs = new M.AlignedMemoryList();
  if (files.vocab) vocabs.push_back(aligned(M, await cachedBytes(files.vocab), 64));
  else { vocabs.push_back(aligned(M, await cachedBytes(files.srcvocab), 64)); vocabs.push_back(aligned(M, await cachedBytes(files.trgvocab), 64)); }
  var cfg = [
    'beam-size: 1', 'normalize: 1.0', 'word-penalty: 0', 'cpu-threads: 0',
    'gemm-precision: ' + (/intgemm8\.bin$/.test(files.model.u) ? 'int8shiftAll' : 'int8shiftAlphaAll'),
    'skip-cost: true', 'alignment: soft', 'quiet: true', 'quiet-translation: true',
    'max-length-break: 128', 'mini-batch-words: 1024', 'workspace: 128', 'max-length-factor: 2.0',
  ].join('\n') + '\n';
  var tm = new M.TranslationModel(cfg, model, lex, vocabs, null);
  loaded = { lang: lang, model: tm };
  return tm;
}
function translate(M, model, texts) {
  var input = new M.VectorString(), opts = new M.VectorResponseOptions();
  texts.forEach(function (t) { input.push_back(t); opts.push_back({ alignment: false, html: false, qualityScores: false }); });
  var res = service.translate(model, input, opts), out = [];
  for (var i = 0; i < texts.length; i++) out.push(res.get(i).getTranslatedText());
  res.delete(); input.delete(); opts.delete();
  return out;
}

self.onmessage = function (e) {
  var m = e.data || {};
  (async function () {
    if (m.type === 'download') { await ensureFiles(m.id, m.files); post({ type: 'done', id: m.id }); }
    else if (m.type === 'translate') {
      var M = await loadEngine(m.id, m.engine);
      var model = await loadModel(m.id, M, m.lang, m.files);
      post({ type: 'done', id: m.id, texts: translate(M, model, m.texts) });
    } else if (m.type === 'free') { freeModel(); post({ type: 'done', id: m.id }); }
  })().catch(function (err) { post({ type: 'error', id: m.id, message: errMsg(err) }); });
};
