/* Code Runner — Python worker source (no DOM).
 *
 * Runs Pyodide (CPython compiled to WebAssembly). This file is never started
 * on the app's origin: the engine fetches it as TEXT and hands it to a
 * sandboxed, opaque-origin iframe (sandbox="allow-scripts", no
 * allow-same-origin), which starts it as a Worker from a blob:/data: URL — or,
 * where a browser refuses workers there, runs it in that iframe's own page
 * with a stand-in `self`. Either way user code has an opaque origin:
 * IndexedDB / Cache Storage / localStorage throw and requests carry
 * Origin: null.
 *
 * Pyodide's files are fetched THROUGH the app ({type:'fetch'} -> relay ->
 * engine), which only serves URLs under the pinned jsDelivr prefix, counts the
 * bytes for the progress readout and goes through the service worker, so the
 * runtime is cached for offline use. (A retry without the proxy loads straight
 * from jsDelivr, relying on the browser's HTTP cache.)
 *
 * Protocol (postMessage, relayed by the iframe):
 *   out: {type:'alive'} first, then {type:'progress', phase, text}
 *        {type:'ready', version}  {type:'initError', message}
 *        {type:'started', id}  {type:'out', id, chunks:[['o'|'e', text]], dropped}
 *        {type:'done', id, ms, result|null, error|null}  {type:'fetch', rid, url, integrity}
 *   in : {type:'init', indexURL, proxy}  {type:'run', id, code, ns, requires}
 *        {type:'reset', ns}  {type:'fetched', rid, ok, status, ct, buf, error}
 *
 * Each room gets its own namespace dict. Interrupts would need
 * SharedArrayBuffer (cross-origin isolation, impossible on static hosting), so
 * the app stops a run by destroying the iframe. As defence in depth, storage
 * and messaging globals are also deleted before user code runs. */
'use strict';
var py = null, runFn = null, nsFn = null, spaces = {};
var INDEX = '', proxyOn = false, rid = 0, waiting = {};
var outQ = [], outT = 0, outSize = 0, outDropped = 0, lastFlush = 0, curId = 0;
var MAX_OUT = 400000;
var HELPER = [
  'import sys',
  'from pyodide.code import eval_code_async',
  'async def _cade_run(src, ns):',
  '    try:',
  "        r = await eval_code_async(src, ns, filename='block.py')",
  '    finally:',
  '        try:',
  '            sys.stdout.flush()',
  '            sys.stderr.flush()',
  '        except Exception:',
  '            pass',
  '    if r is None:',
  '        return None',
  '    try:',
  '        return repr(r)',
  '    except BaseException as e:',
  "        return '<repr failed: %r>' % (e,)",
  'def _cade_ns():',
  "    return {'__name__': '__main__'}"
].join('\n');

function post(m) { self.postMessage(m); }
function msg(e) { return String((e && (e.message || e)) || 'error'); }
function now() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }

// ---- files through the app (cached by its service worker) ----
function viaApp(url, integrity) {
  return new Promise(function (resolve, reject) {
    var id = ++rid;
    waiting[id] = { resolve: resolve, reject: reject };
    post({ type: 'fetch', rid: id, url: url, integrity: integrity || '' });
  }).then(function (m) {
    if (!m.ok || !m.buf) throw new Error(m.error || ('HTTP ' + m.status + ' for ' + url));
    return new Response(m.buf, { status: 200, headers: { 'Content-Type': m.ct || 'application/octet-stream' } });
  });
}
function urlOf(input) {
  if (typeof input === 'string') return input;
  return input ? String(input.href || input.url || input) : '';
}
function installProxy() {
  var orig = self.fetch;
  self.fetch = function (input, init) {
    var url = urlOf(input);
    if (proxyOn && url.indexOf(INDEX) === 0) return viaApp(url, init && init.integrity);
    return orig.apply(typeof globalThis !== 'undefined' ? globalThis : self, arguments);
  };
}
// Load a classic script into this global scope.
function loadScript(url) {
  if (proxyOn) return viaApp(url).then(function (r) { return r.text(); }).then(function (src) { (0, eval)(src); });
  if (typeof self.__cadeLoadScript === 'function') return self.__cadeLoadScript(url);
  return new Promise(function (res, rej) { try { importScripts(url); res(); } catch (e) { rej(e); } });
}

function strip(obj, names) {
  if (!obj) return;
  names.forEach(function (n) {
    for (var o = obj; o; o = Object.getPrototypeOf(o)) {
      try { if (Object.prototype.hasOwnProperty.call(o, n)) delete o[n]; } catch (e) {}
    }
    try { if (n in obj) Object.defineProperty(obj, n, { value: undefined, writable: false, configurable: false }); } catch (e) {}
  });
}
// Defence in depth on top of the opaque origin.
function harden() {
  var g = typeof globalThis !== 'undefined' ? globalThis : self;
  [self, g].forEach(function (o, i) {
    if (i && o === self) return;
    strip(o, ['indexedDB', 'webkitIndexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'cookieStore', 'localStorage', 'sessionStorage']);
    try { strip(o.navigator, ['storage', 'serviceWorker', 'locks']); } catch (e) {}
  });
}

function out(kind, s) {
  if (!s) return;
  if (outSize > MAX_OUT) { outDropped += s.length; return; }
  outSize += s.length;
  var last = outQ[outQ.length - 1];
  if (last && last[0] === kind) last[1] += s; else outQ.push([kind, s]);
  // CPU-bound code never yields to a timer, so flush on the write itself too
  if (now() - lastFlush > 120) flushOut();
  else if (!outT) outT = setTimeout(flushOut, 120);
}
function flushOut() {
  if (outT) { clearTimeout(outT); outT = 0; }
  lastFlush = now();
  if (!outQ.length && !outDropped) return;
  post({ type: 'out', id: curId, chunks: outQ, dropped: outDropped });
  outQ = []; outDropped = 0;
}

function setup() {
  var decO = new TextDecoder(), decE = new TextDecoder();
  py.setStdout({ write: function (b) { out('o', decO.decode(b, { stream: true })); return b.length; }, isatty: false });
  py.setStderr({ write: function (b) { out('e', decE.decode(b, { stream: true })); return b.length; }, isatty: false });
  py.setStdin({ stdin: function () { return null; } }); // EOF: input() raises EOFError
  var g = py.globals.get('dict')();
  py.runPython(HELPER, { globals: g, filename: '<cade>' });
  runFn = g.get('_cade_run');
  nsFn = g.get('_cade_ns');
}

function init(m) {
  if (py) { post({ type: 'ready', version: py.version }); return; }
  INDEX = String(m.indexURL || '');
  proxyOn = !!m.proxy;
  if (proxyOn) installProxy();
  post({ type: 'progress', phase: 'download', text: '' });
  var p = loadScript(INDEX + 'pyodide.js');
  // Pre-load the runtime script the same way: pyodide.js skips its own
  // loader when _createPyodideModule already exists.
  if (proxyOn) p = p.then(function () { return loadScript(INDEX + 'pyodide.asm.js'); });
  p.then(function () {
    if (typeof self.loadPyodide !== 'function') throw new Error('Pyodide did not load');
    return self.loadPyodide({ indexURL: INDEX, stdout: function () {}, stderr: function () {} });
  }).then(function (pyo) {
    py = pyo;
    setup();
    harden();
    post({ type: 'ready', version: pyo.version });
  }, function (e) {
    post({ type: 'initError', message: 'Could not start Python (' + msg(e) + ')' });
  });
}

function pkgMsg(t) { post({ type: 'progress', phase: 'packages', text: String(t || '').slice(0, 200) }); }

function prepare(m) {
  var p = py.loadPackagesFromImports(m.code, { messageCallback: pkgMsg, errorCallback: pkgMsg });
  if (m.requires && m.requires.length) {
    p = p.then(function () { return py.loadPackage('micropip', { messageCallback: pkgMsg, errorCallback: pkgMsg }); })
      .then(function () {
        pkgMsg('Installing ' + m.requires.join(', ') + '…');
        var mp = py.pyimport('micropip'), list = py.toPy(m.requires);
        return Promise.resolve(mp.install(list)).then(function () {
          try { list.destroy(); mp.destroy(); } catch (e) {}
        });
      });
  }
  return p;
}

function run(m) {
  if (!py || !runFn) { post({ type: 'done', id: m.id, ms: 0, result: null, error: 'Python is not loaded' }); return; }
  curId = m.id; outQ = []; outSize = 0; outDropped = 0; lastFlush = now();
  var ns = spaces[m.ns] || (spaces[m.ns] = nsFn());
  var t0 = 0;
  prepare(m).then(function () {
    post({ type: 'started', id: m.id });
    t0 = now();
    return runFn(m.code, ns);
  }, function (e) {
    throw { pkg: true, e: e };
  }).then(function (r) {
    flushOut();
    post({ type: 'done', id: m.id, ms: Math.round(now() - t0), result: r == null ? null : String(r), error: null });
  }, function (e) {
    flushOut();
    if (e && e.pkg) post({ type: 'done', id: m.id, ms: 0, result: null, error: 'Could not load packages: ' + msg(e.e), stage: 'packages' });
    else post({ type: 'done', id: m.id, ms: t0 ? Math.round(now() - t0) : 0, result: null, error: msg(e), python: !!(e && e.type) });
  });
}

self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type === 'fetched') {
    var w = waiting[m.rid];
    if (w) { delete waiting[m.rid]; w.resolve(m); }
  } else if (m.type === 'init') init(m);
  else if (m.type === 'run') run(m);
  else if (m.type === 'reset') {
    var d = spaces[m.ns];
    if (d) { try { d.destroy(); } catch (x) {} delete spaces[m.ns]; }
  }
};
post({ type: 'alive' });
