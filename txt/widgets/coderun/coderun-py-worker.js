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
 * Pyodide's files — and micropip's PyPI requests (pypi.org index JSON,
 * files.pythonhosted.org wheels) — are fetched THROUGH the app ({type:'fetch'}
 * -> relay -> engine), which only serves an allowlist of those URLs (GET, no
 * credentials), counts the bytes for the progress readout and keeps them in
 * its own Cache Storage bucket ('cade-py-<version>'), so the runtime and
 * every package work offline and survive app updates. (A retry without the
 * proxy loads straight from the network, relying on the browser's HTTP cache.)
 *
 * Protocol (postMessage, relayed by the iframe):
 *   out: {type:'alive'} first, then {type:'progress', phase, text}
 *        {type:'ready', version}  {type:'initError', message}
 *        {type:'started', id}  {type:'out', id, chunks:[['o'|'e', text]], dropped}
 *        {type:'done', id, ms, result|null, error|null}  {type:'fetch', rid, url, integrity}
 *        {type:'preloaded', errors:[…]}  {type:'pkgsDone', id, ok, info|error}
 *   in : {type:'init', indexURL, proxy, preload:{lock, pypi, imports}}
 *        {type:'run', id, code, ns, requires, auto:[{name, imports}]}
 *        {type:'pkgs', id, names}  (install PyPI packages = download them into the app's cache)
 *        {type:'reset', ns}  {type:'fetched', rid, ok, status, ct, buf, error}
 *
 * Each room gets its own namespace dict. Interrupts would need
 * SharedArrayBuffer (cross-origin isolation, impossible on static hosting), so
 * the app stops a run by destroying the iframe. As defence in depth, storage
 * and messaging globals are also deleted before user code runs. */
'use strict';
var py = null, runFn = null, nsFn = null, infoFn = null, importFn = null, forgetFn = null, spaces = {};
var INDEX = '', proxyOn = false, rid = 0, waiting = {};
var PYPI_RE = /^https:\/\/(pypi\.org|files\.pythonhosted\.org)\//;
// One thing at a time: start-up preloads, runs and package downloads queue up
// here (they all use loadPackage / micropip, which aren't re-entrant).
var chain = Promise.resolve(), installed = {};
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
  "    return {'__name__': '__main__'}",
  // After micropip.install(names): each one's version, top-level import names
  // and installed dependency closure (only dists that really got installed, so
  // markers that didn't apply drop out on their own).
  'def _cade_info(names):',
  '    import json, re',
  '    import importlib.metadata as md',
  "    canon = lambda s: re.sub(r'[-_.]+', '-', s).lower()",
  '    try:',
  '        tops = md.packages_distributions()',
  '    except Exception:',
  '        tops = {}',
  '    out = {}',
  '    for name in names:',
  '        root = canon(name)',
  '        seen, stack = [], [root]',
  '        while stack:',
  '            n = stack.pop()',
  '            if n in seen:',
  '                continue',
  '            try:',
  '                dist = md.distribution(n)',
  '            except Exception:',
  '                continue',
  '            seen.append(n)',
  '            for r in (dist.requires or []):',
  "                if 'extra' in r.partition(';')[2]:",
  '                    continue',
  "                m = re.match(r'\\s*([A-Za-z0-9][A-Za-z0-9._-]*)', r)",
  '                if m:',
  '                    stack.append(canon(m.group(1)))',
  "        mods = sorted(k for k, v in tops.items() if not k.startswith('_') and any(canon(d) == root for d in v))",
  '        try:',
  '            ver = md.version(root)',
  '        except Exception:',
  "            ver = ''",
  "        out[name] = {'version': ver, 'imports': mods[:12], 'deps': [d for d in seen if d != root][:60]}",
  '    return json.dumps(out)',
  // Uninstall micropip-installed dists so the next install fetches (and so
  // re-caches) them — for after the app's Python cache was cleared.
  'def _cade_forget(names):',
  '    import importlib.metadata as md',
  '    gone = []',
  '    for n in names:',
  '        try:',
  "            src = md.distribution(n).read_text('PYODIDE_SOURCE') or ''",
  '        except Exception:',
  '            continue',
  "        if src == 'pypi' or src.startswith('http'):",
  '            gone.append(n)',
  '    if gone:',
  '        import micropip',
  '        micropip.uninstall(gone)',
  '    return len(gone)',
  'def _cade_import(mods):',
  '    import importlib',
  '    bad = []',
  '    for m in mods:',
  '        try:',
  '            importlib.import_module(m)',
  '        except BaseException as e:',
  "            bad.append('%s (%s)' % (m, type(e).__name__))",
  '    return bad'
].join('\n');

function post(m) { self.postMessage(m); }
function task(fn) { var p = chain.then(fn); chain = p.then(null, function () {}); return p; }
function msg(e) { return String((e && (e.message || e)) || 'error'); }
function now() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }

// ---- files through the app (kept in its 'cade-py-<version>' cache) ----
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
// Pyodide fetches its files with fetch(URL, {integrity}); micropip (via
// pyodide.http.pyfetch, which binds this fetch when it's first imported)
// fetches pypi.org / files.pythonhosted.org with a Request. GETs to those go
// to the app; anything else is left to the real fetch (opaque origin, no
// credentials to leak).
function installProxy() {
  var orig = self.fetch;
  self.fetch = function (input, init) {
    var url = urlOf(input);
    var method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if (proxyOn && method === 'GET' && (url.indexOf(INDEX) === 0 || PYPI_RE.test(url))) return viaApp(url, init && init.integrity);
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
  infoFn = g.get('_cade_info');
  importFn = g.get('_cade_import');
  forgetFn = g.get('_cade_forget');
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
    if (m.preload) task(function () { return preload(m.preload); });
  }, function (e) {
    post({ type: 'initError', message: 'Could not start Python (' + msg(e) + ')' });
  });
}

function pkgMsg(t) { post({ type: 'progress', phase: 'packages', text: String(t || '').slice(0, 200) }); }
var PKG_CB = { messageCallback: pkgMsg, errorCallback: pkgMsg };
function strs(a, max) { return (Array.isArray(a) ? a : []).map(String).filter(function (s) { return /^[A-Za-z0-9][A-Za-z0-9_.\-\[\]=<>!~]*$/.test(s); }).slice(0, max || 60); }

// micropip.install(names); remembers what this session already installed so
// a "# requires:" line doesn't ask the index again on every run.
function pipInstall(names) {
  names = names.filter(function (n) { return !installed[n]; });
  if (!names.length) return Promise.resolve();
  return py.loadPackage('micropip', PKG_CB).then(function () {
    pkgMsg('Installing ' + names.join(', ') + '…');
    var mp = py.pyimport('micropip'), list = py.toPy(names);
    return Promise.resolve(mp.install(list)).then(function () {
      names.forEach(function (n) { installed[n] = 1; });
    }).finally(function () { try { list.destroy(); mp.destroy(); } catch (e) {} });
  });
}

// "Load at start": Pyodide builds + PyPI packages, then import them once so a
// later `import pandas` is instant. Failures don't stop Python — the app shows them.
function preload(p) {
  var errors = [], lock = strs(p.lock), pypi = strs(p.pypi), mods = strs(p.imports);
  var cb = { messageCallback: pkgMsg, errorCallback: function (t) { pkgMsg(t); errors.push(String(t)); } };
  var s = Promise.resolve();
  if (lock.length) s = s.then(function () { return py.loadPackage(lock, cb); }).then(null, function (e) { errors.push(lock.join(', ') + ': ' + msg(e)); });
  if (pypi.length) s = s.then(function () { return pipInstall(pypi); }).then(null, function (e) { errors.push(pypi.join(', ') + ': ' + msg(e)); });
  if (mods.length) {
    s = s.then(function () {
      pkgMsg('Importing ' + mods.join(', ') + '…');
      var list = py.toPy(mods), bad = importFn(list);
      try { list.destroy(); } catch (e) {}
      var arr = bad && bad.toJs ? bad.toJs() : [];
      try { bad.destroy(); } catch (e) {}
      if (arr.length) errors.push('import ' + arr.join(', '));
    });
  }
  return s.then(null, function (e) { errors.push(msg(e)); }).then(function () {
    try { py.runPython('import sys; sys.stdout.flush(); sys.stderr.flush()'); } catch (e) {}
    outQ = []; outSize = 0; outDropped = 0; // nothing from the preload leaks into the first run's output
    post({ type: 'preloaded', errors: errors });
  });
}

// "Download for offline" of PyPI packages: installing them through the app's
// proxy is what stores the index JSON, metadata and wheels (and any Pyodide
// builds they depend on) in the app's cache. Reports what got installed.
function pkgs(m) {
  var names = strs(m.names, 20), forget = strs(m.forget, 60);
  var p = Promise.resolve();
  // installed earlier in this session but no longer in the app's cache: fetch again
  if (forget.length) {
    p = py.loadPackage('micropip', PKG_CB).then(function () {
      var l = py.toPy(forget);
      try { forgetFn(l); } finally { try { l.destroy(); } catch (e) {} }
      forget.forEach(function (n) { delete installed[n]; });
    });
  }
  return p.then(function () { return pipInstall(names); }).then(function () {
    var list = py.toPy(names), s = infoFn(list);
    try { list.destroy(); } catch (e) {}
    post({ type: 'pkgsDone', id: m.id, ok: true, info: JSON.parse(String(s)) });
  }).then(null, function (e) {
    post({ type: 'pkgsDone', id: m.id, ok: false, error: msg(e) });
  });
}

// Top-level modules a block imports (Pyodide's own parser; [] on a syntax error).
function importsOf(code) {
  try {
    var r = py.pyodide_py.code.find_imports(code), a = r.toJs();
    try { r.destroy(); } catch (e) {}
    return a;
  } catch (e) { return []; }
}

// loadPackage reports a failed download through errorCallback and carries on;
// the errors ride along with 'done' so a ModuleNotFoundError can say why.
function prepare(m, loadErrs) {
  var p = py.loadPackagesFromImports(m.code, { messageCallback: pkgMsg, errorCallback: function (t) { pkgMsg(t); if (loadErrs.length < 5) loadErrs.push(String(t).slice(0, 300)); } });
  var reqs = strs(m.requires, 30);
  // listed PyPI packages install themselves when a block imports them
  var auto = Array.isArray(m.auto) ? m.auto : [];
  if (auto.length) {
    var mods = importsOf(m.code);
    auto.forEach(function (a) {
      var name = String((a && a.name) || ''), imps = (a && Array.isArray(a.imports)) ? a.imports : [];
      if (name && reqs.indexOf(name) === -1 && imps.some(function (i) { return mods.indexOf(String(i)) !== -1; })) reqs.push(name);
    });
    reqs = strs(reqs, 30);
  }
  if (reqs.length) p = p.then(function () { return pipInstall(reqs); });
  return p;
}

function run(m) {
  if (!py || !runFn) { post({ type: 'done', id: m.id, ms: 0, result: null, error: 'Python is not loaded' }); return; }
  return task(function () { return runNow(m); });
}
function runNow(m) {
  curId = m.id; outQ = []; outSize = 0; outDropped = 0; lastFlush = now();
  var ns = spaces[m.ns] || (spaces[m.ns] = nsFn());
  var t0 = 0, loadErrs = [];
  return prepare(m, loadErrs).then(function () {
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
    else post({ type: 'done', id: m.id, ms: t0 ? Math.round(now() - t0) : 0, result: null, error: msg(e), python: !!(e && e.type), loadErrors: loadErrs });
  });
}

self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type === 'fetched') {
    var w = waiting[m.rid];
    if (w) { delete waiting[m.rid]; w.resolve(m); }
  } else if (m.type === 'init') init(m);
  else if (m.type === 'run') run(m);
  else if (m.type === 'preload') { if (py) task(function () { return preload(m.preload || {}); }); }
  else if (m.type === 'pkgs') {
    if (!py || !infoFn) post({ type: 'pkgsDone', id: m.id, ok: false, error: 'Python is not loaded' });
    else task(function () { return pkgs(m); });
  }
  else if (m.type === 'reset') {
    var d = spaces[m.ns];
    if (d) { try { d.destroy(); } catch (x) {} delete spaces[m.ns]; }
  }
};
post({ type: 'alive' });
