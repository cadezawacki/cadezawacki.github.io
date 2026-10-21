/* File Converter — pandoc worker (module worker, spawned only for a document
 * conversion that needs pandoc; terminated when idle / on panel close).
 *
 * Runs the official pandoc.wasm (pandoc 3.10, from the `pandoc-wasm` npm
 * package, GPL-2.0-or-later — fetched at runtime, never part of this repo) on
 * a WASI shim (@bjorn3/browser_wasi_shim, MIT/Apache-2.0). Both are fetched
 * once into the converter's Cache Storage bucket ('cade-convert-v1', shared
 * with convert.js and convert-worker.js) and used from there, offline too.
 *
 * pandoc.wasm is a WASI "reactor": after hs_init it exports
 * convert(ptr, len) / query(ptr, len), which take pandoc options as JSON (the
 * defaults-file format) and work on an in-memory file system: files "stdin",
 * "stdout", "stderr" and "warnings" at the root, plus any input / output /
 * extracted-media files. That glue is ours; it follows the package's API.
 *
 * Memory: the module is ~58 MB; compiling it streams straight from the cache
 * (no 58 MB copy in JS). The GHC heap is capped with RTS -M (set by the page:
 * smaller on iPhone), so a too-big document fails with a catchable "out of
 * memory" exit instead of the OS killing the tab. After any trap / exit the
 * instance is discarded (its state is undefined) and rebuilt on the next job.
 *
 * Protocol (page -> worker):
 *   {type:'pandoc', id, assets:{pandoc, wasishim}, rts:[...], plan, input, files, title}
 *     plan  = convert-pandoc.js plan(); input = string | Uint8Array (binary
 *     readers); files = {path: Uint8Array} extra resources (note images).
 * worker -> page: 'dl' / 'stage' / 'phase' ('init' | 'convert') /
 *   {type:'done', id, text?, bytes?, images?:[{n, path, alt, mime, bytes}], warnings, mem}
 *   {type:'error', id, message, code}   code: 'memory' | 'failed' | 'offline' | 'crash'
 */
import './convert-pandoc.js';

var P = self.__cadeConvertPandoc;
var CACHE = 'cade-convert-v1';
var shim = null, shimP = null, modP = null, eng = null;

function post(m, transfer) { self.postMessage(m, transfer || []); }
function coded(message, code) { var e = new Error(message); e.code = code; return e; }
function errMsg(e) { return (e && (e.message || (typeof e === 'string' ? e : String(e)))) || 'unknown error'; }
async function openCache() {
  try { return self.caches ? await self.caches.open(CACHE) : null; } catch (e) { return null; }
}
function offline(asset) {
  return coded('Offline — the ' + asset.label + ' needs one online download first', 'offline');
}
// Network response -> counted stream. fetch() hands over decompressed bytes;
// progress is reported scaled to the transfer size (asset.wire), which is
// what the panel announced ("First use downloads 15 MB").
function counted(res, asset, id) {
  var got = 0, last = 0, size = asset.size || 0, wire = asset.wire || size;
  var k = size ? wire / size : 1;
  return res.body.pipeThrough(new TransformStream({
    transform: function (chunk, ctl) {
      got += chunk.length;
      var now = Date.now();
      if (now - last > 150) { last = now; post({ type: 'dl', id: id, loaded: Math.round(got * k), total: Math.round(Math.max(size, got) * k), label: asset.label }); }
      ctl.enqueue(chunk);
    },
    flush: function () { post({ type: 'dl', id: id, loaded: Math.round(got * k), total: Math.round(got * k), label: asset.label }); },
  }));
}
async function fetchAsset(asset) {
  if (self.navigator && self.navigator.onLine === false) throw offline(asset);
  // cache:'no-store' keeps the app's service worker (and the HTTP cache) out:
  // our bucket is the only copy.
  var res;
  try { res = await fetch(asset.url, { mode: 'cors', credentials: 'omit', cache: 'no-store' }); }
  catch (e) { throw coded('Couldn’t download the ' + asset.label + ' (' + errMsg(e) + ')', 'failed'); }
  if (!res.ok) throw coded('HTTP ' + res.status + ' downloading the ' + asset.label, 'failed');
  return res;
}

// ---- WASI shim (29 KB ES module) ------------------------------------------------
async function loadShim(m) {
  if (shim) return shim;
  if (!shimP) {
    shimP = (async function () {
      var a = m.assets.wasishim, cache = await openCache(), hit = null;
      if (cache) { try { hit = await cache.match(a.url); } catch (e) {} }
      var buf;
      if (hit) buf = await hit.arrayBuffer();
      else {
        buf = await (await fetchAsset(a)).arrayBuffer();
        if (cache) { try { await cache.put(a.url, new Response(buf.slice(0), { headers: { 'Content-Type': 'text/javascript', 'X-Cade-Size': String(buf.byteLength) } })); } catch (e) {} }
      }
      var url = URL.createObjectURL(new Blob([buf], { type: 'text/javascript' }));
      try { shim = await import(url); } finally { URL.revokeObjectURL(url); }
      if (!shim || !shim.WASI) throw coded('The WASI shim failed to load', 'failed');
      return shim;
    })();
    shimP.catch(function () { shimP = null; });
  }
  return shimP;
}

// ---- pandoc.wasm: cached once, compiled by streaming from the cache ----------------
async function compileFrom(res) {
  if (WebAssembly.compileStreaming) {
    try { return await WebAssembly.compileStreaming(res.clone ? res.clone() : res); } catch (e) {
      if (!/mime|content-type|Response/i.test(errMsg(e))) throw e;
    }
  }
  return WebAssembly.compile(await res.arrayBuffer());
}
async function loadModule(m) {
  if (!modP) {
    modP = (async function () {
      var a = m.assets.pandoc, cache = await openCache(), hit = null;
      if (cache) { try { hit = await cache.match(a.url); } catch (e) {} }
      if (!hit) {
        var res = await fetchAsset(a);
        var wasmHeaders = { 'Content-Type': 'application/wasm', 'X-Cade-Size': String(a.size || 0) };
        if (cache && res.body && typeof TransformStream === 'function') {
          // Stream network -> cache (no whole-file copy in memory), then compile from the cache.
          try {
            await cache.put(a.url, new Response(counted(res, a, m.id), { headers: wasmHeaders }));
            hit = await cache.match(a.url);
          } catch (e) {
            try { await cache['delete'](a.url); } catch (x) {}
            if (e && e.name === 'QuotaExceededError') post({ type: 'stage', id: m.id, text: 'Not enough storage to keep pandoc for offline use' });
            hit = null;
            res = await fetchAsset(a); // the first body was consumed
          }
        }
        if (!hit) {
          post({ type: 'phase', id: m.id, phase: 'init' });
          post({ type: 'stage', id: m.id, text: 'Starting pandoc…' });
          var body = res.body && typeof TransformStream === 'function' ? new Response(counted(res, a, m.id), { headers: wasmHeaders }) : res;
          return compileFrom(body);
        }
      }
      post({ type: 'phase', id: m.id, phase: 'init' });
      post({ type: 'stage', id: m.id, text: 'Starting pandoc…' });
      try { return await compileFrom(hit); } catch (e) {
        // A truncated / corrupt cached copy: drop it so the next try downloads again.
        if (cache) { try { await cache['delete'](a.url); } catch (x) {} }
        throw e;
      }
    })();
    modP.catch(function () { modP = null; });
  }
  return modP;
}

// One live instance: memory, exports and its in-memory file system.
async function engine(m) {
  if (eng) return eng;
  var W = await loadShim(m);
  var mod = await loadModule(m);
  var args = ['pandoc.wasm', '+RTS'].concat(m.rts || ['-H64m'], ['-RTS']);
  var root = new Map(), log = [];
  var line = function (s) { log.push(String(s)); if (log.length > 50) log.shift(); };
  var fds = [
    new W.OpenFile(new W.File(new Uint8Array(), { readonly: true })),
    W.ConsoleStdout.lineBuffered(line),
    W.ConsoleStdout.lineBuffered(line),
    new W.PreopenDirectory('/', root),
  ];
  var wasi = new W.WASI(args, [], fds, { debug: false });
  var inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport });
  var ex = inst.exports;
  wasi.initialize(inst);
  ex.__wasm_call_ctors();
  var enc = new TextEncoder();
  var put = function (bytes, nul) {
    var p = ex.malloc(bytes.length + (nul ? 1 : 0));
    var u8 = new Uint8Array(ex.memory.buffer);
    u8.set(bytes, p);
    if (nul) u8[p + bytes.length] = 0;
    return p;
  };
  var argc = ex.malloc(4), argv = ex.malloc(4 * (args.length + 1)), argvp = ex.malloc(4);
  var dv = new DataView(ex.memory.buffer);
  dv.setUint32(argc, args.length, true);
  args.forEach(function (s, i) { var p = put(enc.encode(s), true); new DataView(ex.memory.buffer).setUint32(argv + 4 * i, p, true); });
  dv = new DataView(ex.memory.buffer);
  dv.setUint32(argv + 4 * args.length, 0, true);
  dv.setUint32(argvp, argv, true);
  ex.hs_init_with_rtsopts(argc, argvp);
  eng = { W: W, ex: ex, root: root, log: log, put: put, enc: enc };
  return eng;
}

function file(W, data, ro) { return new W.File(data || new Uint8Array(), { readonly: !!ro }); }
function setPath(W, root, path, data) {
  var parts = path.split('/'), dir = root;
  for (var i = 0; i < parts.length - 1; i++) {
    var d = dir.get(parts[i]);
    if (!d) { d = new W.Directory(new Map()); dir.set(parts[i], d); }
    dir = d.contents;
  }
  dir.set(parts[parts.length - 1], file(W, data, true));
}
var SYS = { stdin: 1, stdout: 1, stderr: 1, warnings: 1 };
// One pandoc run. -> {stdout, stderr, warnings, files:{path: Uint8Array}}
function run(E, options, stdin, inputs) {
  var W = E.W, root = E.root;
  root.clear();
  E.log.length = 0;
  var out = file(W, null, false), err = file(W, null, false), warn = file(W, null, false);
  root.set('stdin', file(W, stdin == null ? null : typeof stdin === 'string' ? E.enc.encode(stdin) : stdin, true));
  root.set('stdout', out); root.set('stderr', err); root.set('warnings', warn);
  var known = {};
  Object.keys(inputs || {}).forEach(function (k) {
    var v = inputs[k];
    setPath(W, root, k, typeof v === 'string' ? E.enc.encode(v) : v);
    known[k] = 1;
  });
  if (options['output-file']) root.set(options['output-file'], file(W, null, false));
  var json = E.enc.encode(JSON.stringify(options));
  E.ex.convert(E.put(json, false), json.length);
  var dec = new TextDecoder('utf-8');
  var res = { stdout: dec.decode(out.data), stderr: dec.decode(err.data), warnings: [], files: {} };
  if (warn.data.length) { try { res.warnings = JSON.parse(dec.decode(warn.data)); } catch (e) {} }
  (function walk(map, pre) {
    map.forEach(function (entry, name) {
      var path = pre ? pre + '/' + name : name;
      if (entry instanceof W.Directory) walk(entry.contents, path);
      else if (!SYS[path] && !known[path] && entry.data && entry.data.length) res.files[path] = entry.data;
    });
  })(root, '');
  root.clear(); // let the inputs / outputs go
  return res;
}
function runChecked(E, options, stdin, inputs, plan) {
  var r = run(E, options, stdin, inputs);
  var failed = !r.stdout && !Object.keys(r.files).length && /\S/.test(r.stderr);
  if (failed && plan.retryFrom && options.from !== plan.retryFrom && /YAML/i.test(r.stderr)) {
    var o2 = Object.assign({}, options, { from: plan.retryFrom });
    r = run(E, o2, stdin, inputs);
    failed = !r.stdout && !Object.keys(r.files).length && /\S/.test(r.stderr);
  }
  if (failed) throw coded(P.errorText(r.stderr), 'failed');
  return r;
}

var MIMES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff', emf: 'image/emf', wmf: 'image/wmf' };
function dataUri(s) {
  var m = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(s);
  if (!m) return null;
  try {
    if (m[2]) {
      var bin = atob(m[3].replace(/\s+/g, '')), u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return { mime: m[1].toLowerCase(), bytes: u8 };
    }
    return { mime: m[1].toLowerCase(), bytes: new TextEncoder().encode(decodeURIComponent(m[3])) };
  } catch (e) { return null; }
}

async function runPandoc(m) {
  var phase = 'load';
  try {
    var E = await engine(m);
    phase = 'convert';
    post({ type: 'phase', id: m.id, phase: 'convert' });
    post({ type: 'stage', id: m.id, text: 'Converting with pandoc…' });
    var plan = m.plan, inputs = Object.assign({}, m.files || {}), stdin = null;
    if (plan.input) inputs[plan.input] = m.input;
    else stdin = m.input;
    var warnings = [];
    var p0 = plan.passes[0];
    var r = runChecked(E, p0, stdin, inputs, plan);
    warnings = warnings.concat(r.warnings);
    var done = { type: 'done', id: m.id, warnings: [], mem: E.ex.memory.buffer.byteLength };
    var transfer = [];
    if (plan.md) {
      var media = {};
      Object.keys(r.files).forEach(function (k) { media[k] = true; });
      var ast = JSON.parse(r.stdout);
      var c = P.cleanAst(ast, media);
      var r2 = runChecked(E, plan.passes[1], JSON.stringify(c.ast), {}, {});
      warnings = warnings.concat(r2.warnings);
      done.text = r2.stdout;
      done.images = c.images.map(function (im) {
        var bytes = null, mime = '';
        if (/^data:/i.test(im.target)) { var d = dataUri(im.target); if (d) { bytes = d.bytes; mime = d.mime; } }
        else if (r.files[im.target]) {
          bytes = r.files[im.target];
          mime = MIMES[(/\.([a-z0-9]+)$/i.exec(im.target) || ['', ''])[1].toLowerCase()] || 'application/octet-stream';
        }
        var name = /^data:/i.test(im.target) ? 'image-' + im.n + '.' + (mime.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg') : im.target.split('/').pop();
        if (bytes) transfer.push(bytes.buffer);
        return { n: im.n, alt: im.alt, name: name, mime: mime, bytes: bytes };
      });
    } else if (plan.outFile) {
      var b = r.files[plan.outFile];
      if (!b || !b.length) throw coded(P.errorText(r.stderr), 'failed');
      done.bytes = b;
      transfer.push(b.buffer);
    } else {
      done.text = r.stdout;
    }
    done.warnings = P.warningsOf(warnings);
    done.mem = E.ex.memory.buffer.byteLength;
    post(done, transfer);
  } catch (e) {
    var msg = errMsg(e), code = e && typeof e.code === 'string' ? e.code : '';
    var log = eng ? eng.log.join('\n') : '';
    var exited = shim && e instanceof shim.WASIProcExit;
    var trapped = e instanceof WebAssembly.RuntimeError || e instanceof RangeError || exited;
    if (trapped || phase === 'convert' && !code) eng = null; // undefined state: rebuild next time
    if (/out of memory|heap overflow/i.test(log) || (e instanceof RangeError) || /out of memory|Maximum memory|allocation failed|could not allocate/i.test(msg)) {
      post({ type: 'error', id: m.id, code: 'memory', message: phase === 'load' ? 'Not enough memory to start pandoc on this device' : 'Pandoc ran out of memory on this document' });
      return;
    }
    if (exited) msg = (log.replace(/^pandoc(\.wasm)?:\s*/gm, '').trim().split('\n').pop() || 'pandoc stopped') ;
    if (e instanceof WebAssembly.CompileError) msg = 'pandoc couldn’t start here (' + msg + ')';
    post({ type: 'error', id: m.id, code: code || (trapped ? 'crash' : 'failed'), message: msg });
  }
}

self.addEventListener('unhandledrejection', function (e) { try { e.preventDefault(); } catch (x) {} });
self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type === 'pandoc') runPandoc(m);
};
