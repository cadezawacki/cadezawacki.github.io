/* Read Aloud — "HD voice" worker: Piper (VITS) neural TTS fully in the browser.
 *
 *   text --phonemizer (eSpeak-NG -> IPA)--> phoneme ids --onnxruntime-web (wasm)--> PCM
 *
 * Runs as a module worker so inference never blocks the editor. Everything it
 * needs is pinned and fetched only after the user asks for HD voice:
 *   - onnxruntime-web: ort.wasm.min.mjs + its emscripten glue .mjs (~70 KB)
 *     and the .wasm binary (~11 MB, ~2.4 MB brotli on the wire)
 *   - phonemizer.js (xenova, eSpeak-NG English, ~1.3 MB)
 *   - the Piper voice (.onnx ~63 MB + .onnx.json)
 * ALL of them live in our own Cache Storage bucket (CACHE below), not the
 * service worker's versioned cache — that one is wiped on every app release
 * (HD voice would silently stop working offline), and its stale-while-
 * revalidate would re-download them in the background every session. Once
 * cached nothing is fetched again: the JS modules are imported from blob: URLs
 * built from the cached bytes and the wasm is handed to ORT as wasmBinary.
 *
 * Protocol (page <-> worker):
 *   -> {type:'init', files:{ort,glue,wasm,phon,model,config}, sizes:{same keys}}
 *   <- {type:'progress', loaded, total}   (bytes; only while downloading)
 *   <- {type:'ready', sampleRate} | {type:'error', message}
 *   -> {type:'synth', id, text, lengthScale}
 *   <- {type:'audio', id, pcm:Float32Array (transferred), sampleRate} | {type:'synth-error', id, message}
 *   -> {type:'cancel'}  drop queued (not yet started) synth requests
 */
(function () {
  'use strict';
  var CACHE = 'cade-tts-hd-v1';

  var ort = null, phonemize = null, session = null, cfg = null, idMap = null;
  var initP = null;
  var queue = [], busy = false;

  function post(m, transfer) { self.postMessage(m, transfer || []); }
  function errMsg(e) { return (e && (e.message || String(e))) || 'unknown error'; }

  // ---- downloads (Cache Storage backed, with byte progress) -----------------
  var progress = { loaded: {}, sizes: {}, last: 0, any: false };
  function report(key, n) {
    progress.loaded[key] = n;
    progress.any = true;
    var now = Date.now();
    if (now - progress.last < 120) return; // ~8 updates/s is plenty
    progress.last = now;
    flushProgress();
  }
  function flushProgress() {
    var loaded = 0, total = 0;
    for (var k in progress.sizes) {
      total += progress.sizes[k];
      loaded += Math.min(progress.loaded[k] || 0, progress.sizes[k]);
    }
    post({ type: 'progress', loaded: loaded, total: total });
  }

  async function openCache() {
    try { return self.caches ? await self.caches.open(CACHE) : null; } catch (e) { return null; }
  }

  // Bytes for `url`: from our cache when present, else downloaded (streamed,
  // so progress is live) and stored. Content-Length is the COMPRESSED size for
  // brotli'd CDN files, so progress uses the known uncompressed sizes instead.
  async function getBytes(cache, key, url) {
    if (cache) {
      var hit = null;
      try { hit = await cache.match(url); } catch (e) {}
      if (hit) {
        var b = await hit.arrayBuffer();
        progress.loaded[key] = progress.sizes[key] || b.byteLength;
        return b;
      }
    }
    var res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + url.split('/').pop());
    var buf;
    if (res.body && res.body.getReader) {
      var reader = res.body.getReader(), chunks = [], got = 0;
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
        got += r.value.length;
        report(key, got);
      }
      var u8 = new Uint8Array(got), off = 0;
      for (var i = 0; i < chunks.length; i++) { u8.set(chunks[i], off); off += chunks[i].length; }
      chunks = null;
      buf = u8.buffer;
    } else {
      buf = await res.arrayBuffer();
    }
    progress.sizes[key] = buf.byteLength; // exact once known
    report(key, buf.byteLength);
    if (cache) {
      try {
        await cache.put(url, new Response(buf, { headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } }));
      } catch (e) {
        // Quota or private mode: it still works now, just not offline later.
        post({ type: 'warn', message: 'Could not store HD voice for offline use (' + errMsg(e) + ')' });
      }
    }
    return buf;
  }

  function blobUrl(buf) { return URL.createObjectURL(new Blob([buf], { type: 'text/javascript' })); }
  // ORT's emscripten glue works out its .wasm address with
  // new URL('ort-wasm-simd-threaded.wasm', import.meta.url) even when the
  // bytes are handed over as wasmBinary. Imported from a blob: URL that is not
  // a valid base, so it throws — outside any promise we can catch, which used
  // to leave HD voice hanging at 100%. The address is never fetched (we supply
  // the bytes), so swap the lookup for a plain object before importing.
  function patchGlue(buf) {
    var src = new TextDecoder().decode(buf);
    var out = src.replace(/new URL\(("[^"]+\.wasm"),\s*import\.meta\.url\)/g, '({href:$1})');
    return out === src ? buf : new TextEncoder().encode(out).buffer;
  }
  async function importFromBytes(buf) {
    var url = blobUrl(buf);
    try { return await import(url); } finally { URL.revokeObjectURL(url); }
  }

  var KEYS = ['ort', 'glue', 'wasm', 'phon', 'config', 'model'];
  async function init(m) {
    if (typeof WebAssembly !== 'object') throw new Error('WebAssembly is not available');
    var f = m.files, s = m.sizes || {};
    progress.sizes = {};
    KEYS.forEach(function (k) { progress.sizes[k] = s[k] || 1; });
    var cache = await openCache();
    var tick = setInterval(function () { if (progress.any) flushProgress(); }, 400);
    var b = {};
    try {
      var bufs = await Promise.all(KEYS.map(function (k) { return getBytes(cache, k, f[k]); }));
      KEYS.forEach(function (k, i) { b[k] = bufs[i]; });
    } finally {
      clearInterval(tick);
    }
    if (progress.any) flushProgress();
    var ns = await importFromBytes(b.ort);
    ort = ns && ns.InferenceSession ? ns : ns.default;
    ort.env.logLevel = 'error';
    ort.env.wasm.numThreads = 1;      // no SharedArrayBuffer without cross-origin isolation
    ort.env.wasm.proxy = false;       // we ARE the worker
    ort.env.wasm.wasmBinary = b.wasm; // wins over any path lookup
    var glueUrl = blobUrl(patchGlue(b.glue)); // ORT imports its emscripten glue from here
    ort.env.wasm.wasmPaths = { mjs: glueUrl };
    phonemize = (await importFromBytes(b.phon)).phonemize;
    if (typeof phonemize !== 'function') throw new Error('phonemizer failed to load');
    cfg = JSON.parse(new TextDecoder().decode(b.config));
    idMap = cfg.phoneme_id_map;
    if (!idMap || !idMap._ || !idMap['^'] || !idMap.$) throw new Error('unexpected voice config');
    try {
      session = await ort.InferenceSession.create(new Uint8Array(b.model), {
        executionProviders: ['wasm'], graphOptimizationLevel: 'all',
      });
    } finally {
      URL.revokeObjectURL(glueUrl);
    }
    b = null;
    return { sampleRate: (cfg.audio && cfg.audio.sample_rate) || 22050 };
  }

  // ---- text -> phoneme ids --------------------------------------------------
  var PUNCT_RE = /(\s*[;:,.!?\u00a1\u00bf\u2014\u2026"\u00ab\u00bb\u201c\u201d(){}[\]]+\s*)+/g;

  // Punctuation is split off before phonemizing (see textToPhonemes), so
  // anything where "." or "," / ":" is NOT a clause break must be rewritten
  // first: titles, initialisms, money, decimals, thousands, clock times.
  var ABBR = { Dr: 'Doctor', Mr: 'Mister', Mrs: 'Missus', Ms: 'Miz', Prof: 'Professor', Jr: 'Junior', Sr: 'Senior', Mt: 'Mount', Gen: 'General', Capt: 'Captain', Lt: 'Lieutenant', Sgt: 'Sergeant' };
  var LATIN = { 'e.g': 'for example', 'i.e': 'that is', 'etc': 'et cetera', 'vs': 'versus', 'approx': 'approximately', 'cf': 'compare' };
  function digitsSpaced(d) { return d.split('').join(' '); }
  function normalizeText(t) {
    return String(t)
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/[\u201c\u201d\u00ab\u00bb]/g, '"')
      .replace(/\s*[\u2013\u2014]\s*/g, ', ')
      .replace(/\u2026/g, '...')
      .replace(/&/g, ' and ')
      .replace(/\b(Dr|Mr|Mrs|Ms|Prof|Jr|Sr|Mt|Gen|Capt|Lt|Sgt)\.(?=\s|$)/g, function (m, a) { return ABBR[a]; })
      .replace(/\bSt\.(?=\s+[A-Z])/g, 'Saint').replace(/\bSt\.(?=\s|$)/g, 'Street')
      .replace(/(^|[^\w.])(e\.g|i\.e|etc|vs|approx|cf)\.(?=[\s,;:)]|$)/gi, function (m, pre, a) { return pre + LATIN[a.toLowerCase()]; })
      .replace(/\bNo\.(?=\s*\d)/g, 'number')
      .replace(/\b([ap])\.m\.(?=[\s,;:)]|$)/gi, function (m, a) { return a.toUpperCase() + ' M'; })
      // "U.S.A." -> "USA": eSpeak spells all-caps initialisms letter by letter
      .replace(/\b((?:[A-Za-z]\.){2,})(?=[\s,;:)]|$)/g, function (m) { return m.replace(/\./g, '').toUpperCase(); })
      .replace(/\$(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d\d?))?\b/g, function (m, d, c) {
        d = d.replace(/,/g, '');
        var s = d + (d === '1' ? ' dollar' : ' dollars');
        if (c && +c) s += ' and ' + (+(c.length === 1 ? c + '0' : c)) + (+c === 1 && c.length === 2 ? ' cent' : ' cents');
        return s;
      })
      .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
      .replace(/(\d)\.(\d+)/g, function (m, a, b) { return a + ' point ' + digitsSpaced(b); })
      .replace(/\b(\d{1,2}):(\d\d)\b(?!:)/g, function (m, h, mi) {
        return mi === '00' ? h + " o'clock" : mi.charAt(0) === '0' ? h + ' oh ' + mi.charAt(1) : h + ' ' + mi;
      })
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Keep only punctuation the voice has symbols for (Piper keeps clause
  // punctuation in the phoneme stream — it drives pauses and intonation).
  function cleanPunct(p) {
    var out = '';
    for (var i = 0; i < p.length; i++) {
      var c = p[i];
      if (c === '\u2026') c = '.';
      else if (c === '"' || c === '\u201c' || c === '\u201d' || c === '\u00ab' || c === '\u00bb' ||
        c === '(' || c === ')' || c === '[' || c === ']' || c === '{' || c === '}') c = ' ';
      else if (/\s/.test(c)) c = ' ';
      if (c === ' ' ? out.slice(-1) !== ' ' : idMap[c]) out += c;
    }
    return out;
  }

  async function textToPhonemes(text, lang) {
    var t = normalizeText(text);
    var out = '', last = 0, m;
    PUNCT_RE.lastIndex = 0;
    var pieces = [];
    while ((m = PUNCT_RE.exec(t)) !== null) {
      if (m.index > last) pieces.push({ p: false, s: t.slice(last, m.index) });
      if (m[0].length) pieces.push({ p: true, s: m[0] });
      last = m.index + m[0].length;
      if (!m[0].length) PUNCT_RE.lastIndex++;
    }
    if (last < t.length) pieces.push({ p: false, s: t.slice(last) });
    for (var i = 0; i < pieces.length; i++) {
      var pc = pieces[i];
      if (pc.p) { out += cleanPunct(pc.s); continue; }
      if (!/[A-Za-z0-9\u00c0-\u024f]/.test(pc.s)) { out += ' '; continue; }
      var lines = await phonemize(pc.s, lang);
      out += lines.join(' ');
    }
    // eSpeak marks language switches like "(fr)" — not speakable phonemes.
    return out.replace(/\([a-z]{2,3}(?:-[a-z0-9]+)*\)/g, '').replace(/\s+/g, ' ').trim();
  }

  // Same layout as piper-phonemize: ^ _ (phoneme _)* $
  function phonemesToIds(ph) {
    var pad = idMap._, ids = idMap['^'].concat(pad);
    var chars = Array.from(ph.normalize('NFD'));
    for (var i = 0; i < chars.length; i++) {
      var v = idMap[chars[i]];
      if (!v) continue;
      for (var k = 0; k < v.length; k++) ids.push(v[k]);
      for (var k2 = 0; k2 < pad.length; k2++) ids.push(pad[k2]);
    }
    return ids.concat(idMap.$);
  }

  function espeakLang() {
    var v = (cfg.espeak && cfg.espeak.voice) || 'en-us';
    // The bundled phonemizer only ships English voices.
    return /^en/i.test(v) ? v.toLowerCase() : 'en-us';
  }

  async function synth(m) {
    var ph = await textToPhonemes(m.text, espeakLang());
    var ids = phonemesToIds(ph);
    if (ids.length <= 4) return new Float32Array(0);
    var inf = cfg.inference || {};
    var ls = (inf.length_scale || 1) * (m.lengthScale > 0 ? m.lengthScale : 1);
    var feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', Float32Array.from([
        inf.noise_scale != null ? inf.noise_scale : 0.667, ls, inf.noise_w != null ? inf.noise_w : 0.8,
      ]), [3]),
    };
    if ((cfg.num_speakers || 1) > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
    var res = await session.run(feeds);
    var outName = session.outputNames ? session.outputNames[0] : 'output';
    var t = res[outName] || res.output;
    var pcm = new Float32Array(t.data); // own copy -> transferable
    if (t.dispose) try { t.dispose(); } catch (e) {}
    return pcm;
  }

  // One inference at a time: an ORT session can't run concurrently.
  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        var m = queue.shift();
        try {
          var pcm = await synth(m);
          post({ type: 'audio', id: m.id, pcm: pcm, sampleRate: (cfg.audio && cfg.audio.sample_rate) || 22050 }, [pcm.buffer]);
        } catch (e) {
          post({ type: 'synth-error', id: m.id, message: errMsg(e) });
        }
      }
    } finally {
      busy = false;
    }
  }

  // Anything thrown outside init's promise chain (inside the libraries'
  // own callbacks) must still end the load — report it instead of hanging.
  function initCrashed(msg) {
    if (!initP || session) return;
    initP = null;
    post({ type: 'error', message: msg || 'HD voice failed to start' });
  }
  self.addEventListener('error', function (e) { initCrashed(e && e.message); });
  self.addEventListener('unhandledrejection', function (e) { initCrashed(errMsg(e && e.reason)); });

  self.onmessage = function (e) {
    var m = e.data || {};
    if (m.type === 'init') {
      if (!initP) {
        initP = init(m).then(function (info) {
          post({ type: 'ready', sampleRate: info.sampleRate });
        }, function (err) {
          initP = null;
          post({ type: 'error', message: errMsg(err) });
        });
      }
    } else if (m.type === 'synth') {
      queue.push(m);
      if (session) pump();
      else if (initP) initP.then(function () { if (session) pump(); });
    } else if (m.type === 'cancel') {
      queue.length = 0;
    }
  };

  // Exposed for the node smoke test only (harmless in the browser).
  self.__ttsTest = { normalizeText: normalizeText, textToPhonemes: textToPhonemes, phonemesToIds: phonemesToIds };
})();
