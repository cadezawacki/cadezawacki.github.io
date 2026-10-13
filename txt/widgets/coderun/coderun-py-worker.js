/* Code Runner — Python worker (dedicated Web Worker, no DOM).
 *
 * Runs Pyodide (CPython compiled to WebAssembly), lazily downloaded from a
 * pinned jsDelivr URL the first time Python runs; the service worker caches
 * those files stale-while-revalidate so later starts work offline.
 *
 * Protocol (postMessage):
 *   in : {type:'init', indexURL, count}  {type:'run', id, code, ns, requires}
 *        {type:'reset', ns}
 *   out: {type:'progress', phase, loaded, text}  {type:'ready', version}
 *        {type:'initError', message}  {type:'started', id}
 *        {type:'out', id, chunks:[[ 'o'|'e', text ]], dropped}
 *        {type:'done', id, ms, result|null, error|null}
 *
 * Each room gets its own namespace dict (variables persist between blocks of
 * the same room until reset). Interrupts need SharedArrayBuffer (cross-origin
 * isolation, which static hosting can't provide), so the page stops a run by
 * terminating this worker.
 *
 * This worker shares the app's origin, so before any user code runs it drops
 * the storage/messaging APIs a script could use to reach app data (IndexedDB,
 * Cache Storage, BroadcastChannel, nested workers, navigator.storage/locks). */
'use strict';
var py = null, runFn = null, nsFn = null, spaces = {};
var counting = false, got = 0, lastTick = 0;
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
function now() { return (self.performance && performance.now) ? performance.now() : Date.now(); }

function tick(force) {
  var t = now();
  if (!force && t - lastTick < 150) return;
  lastTick = t;
  post({ type: 'progress', phase: 'download', loaded: got });
}

// Count downloaded bytes for the progress bar by re-wrapping response bodies.
// Only active while counting; any failure falls back to the plain response.
function installCounter() {
  if (typeof self.fetch !== 'function' || typeof ReadableStream !== 'function' || typeof Response !== 'function') return;
  var orig = self.fetch;
  self.fetch = function (input, init) {
    return orig.call(self, input, init).then(function (res) {
      if (!counting || !res || !res.ok || !res.body || typeof res.body.getReader !== 'function') return res;
      var reader;
      try { reader = res.body.getReader(); } catch (e) { return res; }
      var stream = new ReadableStream({
        pull: function (ctrl) {
          return reader.read().then(function (r) {
            if (r.done) { ctrl.close(); tick(true); return; }
            got += r.value.byteLength; tick(false);
            ctrl.enqueue(r.value);
          });
        },
        cancel: function (why) { try { return reader.cancel(why); } catch (e) {} }
      });
      return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
    });
  };
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
function harden() {
  strip(self, ['indexedDB', 'webkitIndexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'cookieStore']);
  try { strip(self.navigator, ['storage', 'serviceWorker', 'locks']); } catch (e) {}
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
  if (m.count !== false) installCounter();
  counting = true;
  try { importScripts(m.indexURL + 'pyodide.js'); }
  catch (e) { post({ type: 'initError', message: 'Could not download Python (' + msg(e) + ')' }); return; }
  tick(true);
  self.loadPyodide({ indexURL: m.indexURL, stdout: function () {}, stderr: function () {} }).then(function (p) {
    counting = false;
    py = p;
    setup();
    harden();
    post({ type: 'ready', version: p.version });
  }, function (e) {
    counting = false;
    post({ type: 'initError', message: msg(e) });
  });
}

function pkgMsg(t) { post({ type: 'progress', phase: 'packages', text: String(t || '').slice(0, 200), loaded: got }); }

function prepare(m) {
  counting = true; got = 0;
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
  return p.then(function (v) { counting = false; return v; }, function (e) { counting = false; throw e; });
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
  if (m.type === 'init') init(m);
  else if (m.type === 'run') run(m);
  else if (m.type === 'reset') {
    var d = spaces[m.ns];
    if (d) { try { d.destroy(); } catch (x) {} delete spaces[m.ns]; }
  }
};
