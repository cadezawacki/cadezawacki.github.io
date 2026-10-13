/* File Converter — background worker (module worker, one per engine role).
 *
 * Everything heavy happens here so the editor never stutters:
 *   - FAST path: Mediabunny (WebCodecs; hardware encode/decode). Reads the
 *     input File in slices (BlobSource) and streams the output straight to
 *     disk: an OPFS file through a sync access handle, or — on desktop
 *     Chromium — the file the user picked with showSaveFilePicker. Nothing is
 *     ever held whole in memory except tiny outputs (BufferTarget).
 *   - COMPATIBLE path: ffmpeg.wasm core (single-threaded build; the
 *     multithreaded one needs cross-origin isolation, which GitHub Pages
 *     can't provide). We drive @ffmpeg/core directly instead of going through
 *     @ffmpeg/ffmpeg: that package spawns its own module worker from a
 *     CDN-relative URL (cross-origin workers are forbidden), and its worker is
 *     a thin wrapper over exactly the calls below. The input is mounted with
 *     WORKERFS (read lazily from the File, never copied into wasm memory); the
 *     output lands in MEMFS and is moved to OPFS / the picked file right away.
 *     exec() is synchronous, so the page cancels an ffmpeg job by terminating
 *     this worker.
 *   - HEIC fallback decoder: libheif (wasm) for browsers that can't decode
 *     HEIC natively (Chrome); returns RGBA pixels to the page.
 *   - persist: writes a Blob made on the page into OPFS so the page can drop
 *     its in-memory copy and hand out a disk-backed File instead.
 *
 * Third-party code is fetched once into our own Cache Storage bucket
 * ('cade-convert-v1', shared with the page) and imported from blob: URLs, so
 * it works offline afterwards and never re-downloads.
 *
 * Protocol (page -> worker), every job carries a numeric id:
 *   {type:'media',   id, file, opts, out, assets}   Mediabunny conversion
 *   {type:'ff',      id, file, args, outName, outMime, out, dur, assets}
 *   {type:'heic',    id, file, assets}
 *   {type:'persist', id, blob, name, mime, out}
 *   {type:'cancel',  id}                            (Mediabunny jobs only)
 * worker -> page:
 *   {type:'dl', id, loaded, total, label}   converter download progress (bytes)
 *   {type:'stage', id, text}                human-readable step
 *   {type:'progress', id, p, t}             0..1 (+ processed seconds)
 *   {type:'done', id, file?, size, saved?, pixels?, width?, height?, note?}
 *   {type:'error', id, message, code}       code: 'unsupported'|'canceled'|'memory'|'failed'
 * `out` = {kind:'opfs', dir:[...path], name} | {kind:'handle', handle, name} | {kind:'memory', name}
 */
(function () {
  'use strict';
  var CACHE = 'cade-convert-v1';

  // Safari can't async-iterate a ReadableStream; libraries that do
  // `for await (chunk of stream)` would throw there. Fill the gap first.
  if (typeof ReadableStream !== 'undefined' && !ReadableStream.prototype[Symbol.asyncIterator]) {
    ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
      var reader = this.getReader();
      try {
        for (;;) {
          var r = await reader.read();
          if (r.done) return;
          yield r.value;
        }
      } finally {
        reader.releaseLock();
      }
    };
  }

  function post(m, transfer) { self.postMessage(m, transfer || []); }
  function errMsg(e) { return (e && (e.message || (typeof e === 'string' ? e : String(e)))) || 'unknown error'; }
  function CodedError(message, code) { var e = new Error(message); e.code = code; return e; }

  // ---- converter downloads (Cache Storage backed, with byte progress) ------
  async function openCache() {
    try { return self.caches ? await self.caches.open(CACHE) : null; } catch (e) { return null; }
  }

  // Bytes for an asset {url, size, label}: from our cache when present, else
  // downloaded (streamed, so progress is live) and stored. Progress uses the
  // known uncompressed size: jsDelivr's Content-Length is the brotli size.
  async function getBytes(asset, id) {
    var cache = await openCache();
    if (cache) {
      var hit = null;
      try { hit = await cache.match(asset.url); } catch (e) {}
      if (hit) return hit.arrayBuffer();
    }
    if (self.navigator && self.navigator.onLine === false) {
      throw CodedError('Offline — the ' + (asset.label || 'converter') + ' needs one online download first', 'offline');
    }
    // cache:'no-store' keeps a second copy out of the HTTP cache (and lets the
    // app's service worker skip it); our bucket is the only copy.
    var res = await fetch(asset.url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + asset.url.split('/').pop());
    var total = asset.size || 0, buf, last = 0;
    if (res.body && res.body.getReader) {
      // One buffer sized from the known size, grown only if it's off — no
      // chunk list + final copy (the ffmpeg core is 32 MB; iOS kills greedy workers).
      var reader = res.body.getReader(), got = 0;
      var u8 = new Uint8Array(Math.max(total, 65536));
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        var c = r.value;
        if (got + c.length > u8.length) {
          var bigger = new Uint8Array(Math.max(u8.length * 2, got + c.length));
          bigger.set(u8.subarray(0, got)); u8 = bigger;
        }
        u8.set(c, got);
        got += c.length;
        var now = Date.now();
        if (now - last > 150) { last = now; post({ type: 'dl', id: id, loaded: got, total: Math.max(total, got), label: asset.label }); }
      }
      buf = got === u8.length ? u8.buffer : u8.slice(0, got).buffer;
      u8 = null;
    } else {
      buf = await res.arrayBuffer();
    }
    post({ type: 'dl', id: id, loaded: buf.byteLength, total: buf.byteLength, label: asset.label });
    if (cache) {
      try {
        await cache.put(asset.url, new Response(buf, { headers: {
          'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
          'X-Cade-Size': String(buf.byteLength),
        } }));
      } catch (e) {
        // Quota or private mode: it still works now, just not offline later.
        post({ type: 'stage', id: id, text: 'Couldn’t keep the converter for offline use (' + errMsg(e) + ')' });
      }
    }
    return buf;
  }

  function blobUrl(buf, type) { return URL.createObjectURL(new Blob([buf], { type: type || 'text/javascript' })); }
  function textOf(buf) { return new TextDecoder().decode(buf); }

  // ---- Mediabunny (+ optional audio encoder extensions) ---------------------
  var MB = null, mbUrl = '', mbP = null;
  var extDone = {};
  function loadMB(m) {
    if (MB) return Promise.resolve(MB);
    if (!mbP) {
      mbP = (async function () {
        post({ type: 'stage', id: m.id, text: 'Loading fast engine…' });
        var buf = await getBytes(m.assets.mediabunny, m.id);
        // Kept alive for the worker's lifetime: the encoder extensions import
        // this exact URL so they share Mediabunny's encoder registry.
        mbUrl = blobUrl(buf);
        MB = await import(mbUrl);
        if (!MB || !MB.Conversion) throw new Error('fast engine failed to load');
        return MB;
      })();
      mbP.catch(function () { mbP = null; });
    }
    return mbP;
  }
  // Browsers rarely encode MP3 (and some lack AAC / FLAC) natively; Mediabunny
  // ships LAME / libavcodec / libFLAC wasm encoders as separate extensions.
  // They import the bare specifier "mediabunny", which can't resolve from a
  // blob: URL — point it at our Mediabunny blob instead.
  var EXT = {
    mp3: { asset: 'mp3enc', fn: 'registerMp3Encoder' },
    aac: { asset: 'aacenc', fn: 'registerAacEncoder' },
    flac: { asset: 'flacenc', fn: 'registerFlacEncoder' },
  };
  async function ensureAudioEncoder(codec, m, opts) {
    var ex = EXT[codec];
    if (!ex || extDone[codec]) return;
    var ok = false;
    try { ok = await MB.canEncodeAudio(codec, opts || {}); } catch (e) { ok = false; }
    if (ok) { extDone[codec] = 'native'; return; }
    post({ type: 'stage', id: m.id, text: 'Loading ' + codec.toUpperCase() + ' encoder…' });
    var src = textOf(await getBytes(m.assets[ex.asset], m.id));
    var patched = src.replace(/from\s*["']mediabunny["']/g, 'from"' + mbUrl + '"');
    var url = blobUrl(patched);
    var mod;
    try { mod = await import(url); } finally { URL.revokeObjectURL(url); }
    if (!mod || typeof mod[ex.fn] !== 'function') throw new Error(codec + ' encoder failed to load');
    mod[ex.fn]();
    extDone[codec] = 'wasm';
  }

  // ---- outputs ---------------------------------------------------------------
  async function opfsDir(path) {
    var dir = await navigator.storage.getDirectory();
    for (var i = 0; i < path.length; i++) dir = await dir.getDirectoryHandle(path[i], { create: true });
    return dir;
  }
  // A WritableStream of Mediabunny/File System Access style chunks
  // ({type:'write', data, position}) backed by an OPFS file, plus a finish()
  // that commits it and returns the disk-backed File.
  async function openSink(out, job) {
    if (out.kind === 'handle') {
      // Desktop Chromium: the file the user picked. Writes go to a swap file
      // that only replaces the target on close(); abort() discards it, so a
      // cancelled job leaves the picked file untouched.
      var fsw = await out.handle.createWritable();
      var fw = fsw.getWriter();
      var ws = new WritableStream({
        write: function (chunk) { return fw.write(chunk); },
        close: function () { return job.cancelled ? fw.abort() : fw.close(); },
        abort: function (r) { return fw.abort(r); },
      });
      return {
        writable: ws,
        finish: async function () { var f = await out.handle.getFile(); return { file: f, size: f.size, saved: true }; },
        discard: async function () { try { await fw.abort(); } catch (e) {} },
      };
    }
    if (out.kind === 'opfs') {
      var dir = await opfsDir(out.dir);
      var fh = await dir.getFileHandle(out.name, { create: true });
      var removeIt = async function () { try { await dir.removeEntry(out.name); } catch (e) {} };
      if (typeof fh.createSyncAccessHandle === 'function') {
        // Safari 15.2+ / Chromium: fastest, positional writes, worker-only.
        // (Older engines returned promises from flush/close/getSize — await all.)
        var ah = await fh.createSyncAccessHandle();
        var closed = false;
        var closeAh = async function () { if (closed) return; closed = true; try { await ah.flush(); } catch (e) {} await ah.close(); };
        var ws2 = new WritableStream({
          write: function (chunk) {
            var data = chunk.data, at = chunk.position, off = 0;
            while (off < data.byteLength) {
              var n = ah.write(off ? data.subarray(off) : data, { at: at + off });
              if (!(n > 0)) throw CodedError('Out of storage space', 'quota');
              off += n;
            }
          },
          close: closeAh,
          abort: closeAh,
        });
        return {
          writable: ws2,
          finish: async function () { await closeAh(); var f = await fh.getFile(); return { file: f, size: f.size }; },
          discard: async function () { try { await closeAh(); } catch (e) {} await removeIt(); },
        };
      }
      if (typeof fh.createWritable === 'function') {
        var w = await fh.createWritable();
        var wr = w.getWriter();
        var ws3 = new WritableStream({
          write: function (chunk) { return wr.write(chunk); },
          close: function () { return job.cancelled ? wr.abort() : wr.close(); },
          abort: function (r) { return wr.abort(r); },
        });
        return {
          writable: ws3,
          finish: async function () { var f = await fh.getFile(); return { file: f, size: f.size }; },
          discard: async function () { try { await wr.abort(); } catch (e) {} await removeIt(); },
        };
      }
      await removeIt();
      throw CodedError('This browser can’t write temporary files', 'nostore');
    }
    return null; // memory: caller uses a BufferTarget
  }

  // Write a finished byte array (ffmpeg output) or Blob (page output) to `out`.
  async function writeWhole(out, data, mime) {
    var isBlob = typeof Blob !== 'undefined' && data instanceof Blob;
    var size = isBlob ? data.size : data.byteLength;
    var CH = 8 * 1024 * 1024;
    var piece = async function (off) {
      var end = Math.min(size, off + CH);
      return isBlob ? new Uint8Array(await data.slice(off, end).arrayBuffer()) : data.subarray(off, end);
    };
    if (out.kind === 'memory') {
      var f0 = isBlob ? data : new Blob([data], { type: mime });
      return { file: new File([f0], out.name, { type: mime }), size: size };
    }
    if (out.kind === 'handle') {
      var w = await out.handle.createWritable();
      try {
        for (var o = 0; o < size; o += CH) await w.write({ type: 'write', position: o, data: await piece(o) });
        await w.close();
      } catch (e) { try { await w.abort(); } catch (x) {} throw e; }
      var hf = await out.handle.getFile();
      return { file: hf, size: hf.size, saved: true };
    }
    var dir = await opfsDir(out.dir);
    var fh = await dir.getFileHandle(out.name, { create: true });
    try {
      if (typeof fh.createSyncAccessHandle === 'function') {
        var ah = await fh.createSyncAccessHandle();
        try {
          await ah.truncate(0);
          for (var o2 = 0; o2 < size; o2 += CH) {
            var p = await piece(o2), done = 0;
            while (done < p.byteLength) {
              var n = ah.write(done ? p.subarray(done) : p, { at: o2 + done });
              if (!(n > 0)) throw CodedError('Out of storage space', 'quota');
              done += n;
            }
          }
          await ah.flush();
        } finally { await ah.close(); }
      } else if (typeof fh.createWritable === 'function') {
        var w2 = await fh.createWritable();
        try {
          for (var o3 = 0; o3 < size; o3 += CH) await w2.write({ type: 'write', position: o3, data: await piece(o3) });
          await w2.close();
        } catch (e2) { try { await w2.abort(); } catch (x2) {} throw e2; }
      } else {
        throw CodedError('This browser can’t write temporary files', 'nostore');
      }
    } catch (e3) {
      try { await dir.removeEntry(out.name); } catch (x3) {}
      throw e3;
    }
    var f = await fh.getFile();
    return { file: f, size: f.size };
  }

  // ---- FAST path: Mediabunny conversion --------------------------------------
  var jobs = {};
  var OUT_FORMATS = {
    mp4: function () { return new MB.Mp4OutputFormat(); },
    m4a: function () { return new MB.Mp4OutputFormat(); },
    mov: function () { return new MB.MovOutputFormat(); },
    webm: function () { return new MB.WebMOutputFormat(); },
    mkv: function () { return new MB.MkvOutputFormat(); },
    mp3: function () { return new MB.Mp3OutputFormat(); },
    wav: function () { return new MB.WavOutputFormat(); },
    flac: function () { return new MB.FlacOutputFormat(); },
    ogg: function () { return new MB.OggOutputFormat(); },
  };
  // Preferred codec order per target (first one the browser can encode wins).
  var VIDEO_PREF = { mp4: ['avc', 'hevc', 'vp9', 'av1'], mov: ['avc', 'hevc'], mkv: ['avc', 'hevc', 'vp9', 'av1'], webm: ['vp9', 'vp8', 'av1'] };
  var AUDIO_PREF = { mp4: ['aac', 'opus'], mov: ['aac'], mkv: ['aac', 'opus'], webm: ['opus', 'vorbis'], m4a: ['aac'], mp3: ['mp3'], wav: ['pcm-s16'], flac: ['flac'], ogg: ['opus', 'vorbis'] };
  var VIDEO_TARGETS = { mp4: 1, mov: 1, mkv: 1, webm: 1 };
  var AUDIO_KBPS = { original: 192, high: 192, medium: 128, small: 64 };
  function even(n) { n = Math.round(n); return n - (n % 2); }

  async function runMedia(m) {
    var job = { cancelled: false, conv: null };
    jobs[m.id] = job;
    var o = m.opts, sink = null, input = null;
    try {
      await loadMB(m);
      if (job.cancelled) throw CodedError('Cancelled', 'canceled');
      post({ type: 'stage', id: m.id, text: 'Reading…' });
      input = new MB.Input({ source: new MB.BlobSource(m.file), formats: MB.ALL_FORMATS });
      var canRead = false;
      try { canRead = await input.canRead(); } catch (e) { canRead = false; }
      if (!canRead) throw CodedError('The fast engine can’t read this file', 'unsupported');
      var vtrack = await input.getPrimaryVideoTrack();
      var atrack = await input.getPrimaryAudioTrack();
      var t = o.target, wantVideo = !!VIDEO_TARGETS[t];
      if (wantVideo && !vtrack) throw CodedError('No video track in this file', 'novideo');
      if (!wantVideo && !atrack) throw CodedError('No audio track in this file', 'noaudio');

      // Audio: copy the packets when the container can hold the source codec
      // and nothing asks for a re-encode (instant, lossless); otherwise pick
      // the first codec this browser — or a wasm extension — can encode.
      var aPref = (AUDIO_PREF[t] || []).slice();
      var aOpts = null;
      if (atrack && !o.dropAudio) {
        var srcA = await atrack.getCodec();
        var ch = o.mono ? 1 : Math.min(2, (await atrack.getNumberOfChannels()) || 2);
        var sr = await atrack.getSampleRate();
        var forceA = (!wantVideo && o.preset !== 'original') || !!o.mono;
        aOpts = {};
        if (!forceA && srcA && aPref.indexOf(srcA) !== -1) {
          aOpts.codec = srcA;
        } else {
          aOpts.numberOfChannels = ch;
          if (t === 'mp3' && [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].indexOf(sr) === -1) aOpts.sampleRate = 44100;
          var encOpts = { numberOfChannels: ch, sampleRate: aOpts.sampleRate || sr };
          var need = aPref[0];
          // Apple players want AAC in MP4/MOV/M4A, so try the wasm AAC encoder
          // before settling for Opus.
          if (need === 'mp3' || need === 'flac' || need === 'aac') {
            try { await ensureAudioEncoder(need, m, encOpts); } catch (e) { if (aPref.length === 1) throw e; }
          }
          var aCodec = null;
          try { aCodec = await MB.getFirstEncodableAudioCodec(aPref, encOpts); } catch (e) {}
          if (!aCodec) throw CodedError('This browser can’t encode ' + aPref.join('/').toUpperCase() + ' audio', 'unsupported');
          aOpts.codec = aCodec;
          aOpts.forceTranscode = true;
          if (aCodec.indexOf('pcm') !== 0 && aCodec !== 'flac') {
            var kbps = wantVideo ? (o.preset === 'smaller' ? 96 : 160) : (AUDIO_KBPS[o.preset] || 160);
            aOpts.quality = new MB.Quality({ bitrate: Math.round(kbps * 1000 * (ch === 1 ? 0.6 : 1)) });
          }
        }
      }

      var vOpts = null;
      if (wantVideo) {
        var vPref = VIDEO_PREF[t];
        var dw = await vtrack.getDisplayWidth(), dh = await vtrack.getDisplayHeight();
        vOpts = {};
        var cap = { '1080': 1080, '720': 720, '480': 480, smaller: 1080 }[o.preset] || 0;
        if (cap) {
          // "720p" caps the SHORT side, so portrait phone video stays portrait.
          var shortSide = Math.min(dw, dh);
          if (shortSide > cap) {
            var k = cap / shortSide;
            vOpts.width = even(dw * k); vOpts.height = even(dh * k); vOpts.fit = 'contain';
          }
        }
        var outW = vOpts.width || dw, outH = vOpts.height || dh;
        var vCodec = null;
        try { vCodec = await MB.getFirstEncodableVideoCodec(vPref, { width: even(outW), height: even(outH) }); } catch (e) {}
        var srcCodec = await vtrack.getCodec();
        var canCopy = o.preset === 'original' && srcCodec && vPref.indexOf(srcCodec) !== -1;
        if (!vCodec && !canCopy) throw CodedError('This browser can’t encode ' + vPref.join('/').toUpperCase() + ' video', 'unsupported');
        if (o.preset !== 'original') {
          vOpts.forceTranscode = true;
          vOpts.codec = vCodec;
          vOpts.quality = new MB.Quality(o.preset === 'smaller' ? 'low' : 'medium');
          if (!vOpts.width && (dw % 2 || dh % 2)) { vOpts.width = even(dw); vOpts.height = even(dh); vOpts.fit = 'fill'; }
        } else if (!canCopy) {
          vOpts.codec = vCodec;
          vOpts.quality = new MB.Quality('high');
        }
      }

      var fmt = OUT_FORMATS[t]();
      sink = await openSink(m.out, job);
      var target = sink ? new MB.StreamTarget(sink.writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }) : new MB.BufferTarget();
      var output = new MB.Output({ format: fmt, target: target });
      var trim = null;
      if (o.trimStart > 0 || o.trimEnd > 0) {
        trim = {};
        if (o.trimStart > 0) trim.start = o.trimStart;
        if (o.trimEnd > 0) trim.end = o.trimEnd;
      }
      var conv = await MB.Conversion.init({
        input: input, output: output, tracks: 'primary', showWarnings: false,
        video: wantVideo ? vOpts : { discard: true },
        audio: aOpts ? aOpts : { discard: true },
        trim: trim || undefined,
      });
      job.conv = conv;
      // A track we wanted but can't decode/encode would silently vanish from
      // the output — treat it as "fast path can't do this" so the page can
      // fall back to ffmpeg instead of handing over a silent video.
      var lost = (conv.discardedTracks || []).filter(function (d) {
        return d.reason !== 'discarded_by_user' && d.reason !== 'max_track_count_reached' && d.reason !== 'max_track_count_of_type_reached';
      });
      if (!conv.isValid || lost.length) {
        var why = lost.length ? lost.map(function (d) { return d.track.type + ': ' + d.reason.replace(/_/g, ' '); }).join(', ') : 'nothing to convert';
        throw CodedError('Fast engine can’t do this (' + why + ')', 'unsupported');
      }
      var copying = conv.utilizedTracks && wantVideo && o.preset === 'original' && canCopy;
      post({ type: 'stage', id: m.id, text: copying ? 'Remuxing (no re-encode)…' : 'Converting…' });
      var lastP = 0;
      conv.onProgress = function (p, tsec) {
        var now = Date.now();
        if (now - lastP < 200 && p < 1) return;
        lastP = now;
        post({ type: 'progress', id: m.id, p: p, t: tsec });
      };
      await conv.execute();
      if (job.cancelled) throw CodedError('Cancelled', 'canceled');
      var res;
      if (sink) {
        res = await sink.finish();
      } else {
        var buf = target.buffer;
        res = { file: new File([buf], m.out.name, { type: m.outMime }), size: buf.byteLength };
      }
      var note = [];
      if (aOpts && extDone[aOpts.codec] === 'wasm') note.push(aOpts.codec.toUpperCase() + ' via wasm encoder');
      if (copying) note.push('no re-encode');
      post({ type: 'done', id: m.id, file: res.file, size: res.size, saved: !!res.saved, note: note.join(' · ') });
    } catch (e) {
      var cancelled = job.cancelled || (e && e.name === 'ConversionCanceledError');
      if (sink) { try { await sink.discard(); } catch (x) {} }
      post({ type: 'error', id: m.id, message: cancelled ? 'Cancelled' : errMsg(e), code: cancelled ? 'canceled' : (e && e.code) || 'failed' });
    } finally {
      if (input) { try { input.dispose(); } catch (x) {} }
      delete jobs[m.id];
    }
  }

  // ---- COMPATIBLE path: ffmpeg.wasm ------------------------------------------
  var ff = null, ffP = null, ffState = null;
  function hms(s) {
    var m = /(-?)(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
    if (!m) return NaN;
    var v = (+m[2]) * 3600 + (+m[3]) * 60 + parseFloat(m[4]);
    return m[1] ? -v : v;
  }
  // ffmpeg logs "Duration: 00:01:02.50" once per input and
  // "... time=00:00:12.34 ..." every ~0.5 s while encoding.
  function parseFfLine(line, st) {
    var m;
    if (st.dur == null && (m = /Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(line))) st.dur = hms(m[1]);
    if ((m = /time=\s*(-?\d+:\d+:\d+(?:\.\d+)?)/.exec(line))) {
      var t = hms(m[1]);
      if (t >= 0) st.time = t;
    }
    if ((m = /speed=\s*([\d.]+)x/.exec(line))) st.speed = parseFloat(m[1]);
    return st;
  }
  // The most useful error line(s) from the tail of the log.
  function ffError(lines) {
    lines = lines.filter(function (l) { return !/^\s*Aborted\(\)\s*$/.test(l); });
    var bad = lines.filter(function (l) {
      return /error|invalid|unknown|not found|unsupported|failed|could not|cannot|no such|not implemented|does not|out of memory|abort/i.test(l) &&
        !/^\s*(built with|configuration:|lib\w+\s+\d)/.test(l);
    });
    var pick = (bad.length ? bad.slice(-2) : lines.slice(-2)).join(' — ').trim();
    return pick.length > 300 ? pick.slice(0, 300) + '…' : pick;
  }

  // 'memory' = the wasm heap couldn't grow (big input / output on a phone);
  // 'crash' = the core trapped (an encoder bug) — either way the page throws
  // this ffmpeg instance away.
  function memCode(msg) {
    if (/out of memory|Cannot enlarge memory|allocation failed|RangeError|Maximum call stack/i.test(msg)) return 'memory';
    if (/memory access out of bounds|unreachable|RuntimeError/i.test(msg)) return 'crash';
    return 'failed';
  }

  function loadFf(m) {
    if (ff) return Promise.resolve(ff);
    if (!ffP) {
      ffP = (async function () {
        post({ type: 'stage', id: m.id, text: 'Loading compatible engine…' });
        var js = await getBytes(m.assets.ffjs, m.id);
        var wasm = await getBytes(m.assets.ffwasm, m.id);
        post({ type: 'stage', id: m.id, text: 'Starting compatible engine…' });
        // The core always installs its own locateFile, so the
        // `new URL('ffmpeg-core.wasm', import.meta.url)` branch is dead code —
        // but a blob: URL is no valid base, so neutralise it anyway.
        var src = textOf(js).replace(/new URL\(("[^"]+\.wasm"),\s*import\.meta\.url\)\.href/g, '$1');
        var url = blobUrl(src);
        var mod;
        try { mod = await import(url); } finally { URL.revokeObjectURL(url); }
        var create = mod && (mod.default || mod.createFFmpegCore);
        if (typeof create !== 'function') throw new Error('compatible engine failed to load');
        // wasmBinary: no fetch, no locateFile lookup.
        var core = await create({ wasmBinary: wasm });
        wasm = null;
        core.setLogger(function (d) {
          if (!ffState) return;
          var line = String(d && d.message || '');
          ffState.lines.push(line);
          if (ffState.lines.length > 60) ffState.lines.shift();
          parseFfLine(line, ffState);
          var now = Date.now();
          if (ffState.time != null && now - ffState.last > 250) {
            ffState.last = now;
            var dur = ffState.expect > 0 ? ffState.expect : (ffState.dur > 0 ? ffState.dur : 0);
            post({ type: 'progress', id: ffState.id, p: dur ? Math.min(0.995, ffState.time / dur) : -1, t: ffState.time });
          }
        });
        core.setProgress(function () {});
        ff = core;
        return ff;
      })();
      ffP.catch(function () { ffP = null; });
    }
    return ffP;
  }

  async function runFf(m) {
    var core, mounted = false, outPath = '/' + m.outFile;
    try {
      core = await loadFf(m);
      var FS = core.FS;
      try { FS.mkdir('/in'); } catch (e) {}
      FS.mount(FS.filesystems.WORKERFS, { files: [m.file] }, '/in');
      mounted = true;
      var args = m.args.map(function (a) { return a === '{in}' ? '/in/' + m.file.name : a === '{out}' ? outPath : a; });
      ffState = { id: m.id, lines: [], dur: null, time: null, last: 0, expect: m.dur || 0 };
      post({ type: 'stage', id: m.id, text: 'Converting (compatible engine)…' });
      post({ type: 'progress', id: m.id, p: 0, t: 0 });
      core.setTimeout(-1);
      var ret;
      try { ret = core.exec.apply(core, args); } finally { try { core.reset(); } catch (e) {} }
      var lines = ffState.lines;
      ffState = null;
      var size = 0;
      try { size = FS.stat(outPath).size; } catch (e) { size = 0; }
      if (ret !== 0 || !size) {
        var msg = ffError(lines) || ('ffmpeg exited with code ' + ret);
        throw CodedError(msg, memCode(msg));
      }
      // Hand MEMFS's own buffer over without a copy when we can see it.
      var data = null;
      try {
        var node = FS.lookupPath(outPath).node;
        if (node && node.contents && node.contents.subarray) data = node.contents.subarray(0, node.usedBytes);
      } catch (e) {}
      if (!data) data = FS.readFile(outPath);
      post({ type: 'stage', id: m.id, text: 'Saving…' });
      var res = await writeWhole(m.out, data, m.outMime);
      data = null;
      try { FS.unlink(outPath); } catch (e) {}
      post({ type: 'done', id: m.id, file: res.file, size: res.size, saved: !!res.saved });
    } catch (e) {
      ffState = null;
      if (core) { try { core.FS.unlink(outPath); } catch (x) {} }
      post({ type: 'error', id: m.id, message: errMsg(e), code: (e && e.code) || memCode(errMsg(e)) });
    } finally {
      if (mounted) { try { core.FS.unmount('/in'); } catch (x) {} }
    }
  }

  // ---- HEIC fallback decoder (libheif) ---------------------------------------
  var heif = null, heifP = null;
  function loadHeif(m) {
    if (heif) return Promise.resolve(heif);
    if (!heifP) {
      heifP = (async function () {
        post({ type: 'stage', id: m.id, text: 'Loading HEIC decoder…' });
        var url = blobUrl(await getBytes(m.assets.libheif, m.id));
        var mod;
        try { mod = await import(url); } finally { URL.revokeObjectURL(url); }
        var lib = mod.default();
        if (lib && !lib.HeifDecoder && typeof lib.then === 'function') lib = await lib;
        if (!lib || !lib.HeifDecoder) throw new Error('HEIC decoder failed to load');
        heif = lib;
        return lib;
      })();
      heifP.catch(function () { heifP = null; });
    }
    return heifP;
  }
  async function runHeic(m) {
    var imgs = [], dec = null;
    try {
      var lib = await loadHeif(m);
      post({ type: 'stage', id: m.id, text: 'Decoding HEIC…' });
      var bytes = new Uint8Array(await m.file.arrayBuffer());
      dec = new lib.HeifDecoder();
      imgs = dec.decode(bytes) || [];
      bytes = null;
      if (!imgs.length) throw CodedError('Couldn’t decode this HEIC/HEIF image', 'failed');
      // The biggest top-level image is the photo (others are thumbnails/depth).
      var img = imgs[0], best = 0;
      imgs.forEach(function (im) { var a = im.get_width() * im.get_height(); if (a > best) { best = a; img = im; } });
      var w = img.get_width(), h = img.get_height();
      var px = new Uint8ClampedArray(w * h * 4);
      await new Promise(function (resolve, reject) {
        img.display({ data: px, width: w, height: h }, function (d) { if (d) resolve(); else reject(new Error('HEIC decode failed')); });
      });
      post({ type: 'done', id: m.id, width: w, height: h, pixels: px.buffer }, [px.buffer]);
    } catch (e) {
      post({ type: 'error', id: m.id, message: errMsg(e), code: (e && e.code) || 'failed' });
    } finally {
      imgs.forEach(function (im) { try { im.free(); } catch (x) {} });
      if (dec && dec.decoder && heif && heif.heif_context_free) { try { heif.heif_context_free(dec.decoder); } catch (x) {} }
    }
  }

  async function runPersist(m) {
    try {
      var res = await writeWhole(m.out, m.blob, m.mime);
      post({ type: 'done', id: m.id, file: res.file, size: res.size, saved: !!res.saved });
    } catch (e) {
      post({ type: 'error', id: m.id, message: errMsg(e), code: (e && e.code) || 'failed' });
    }
  }

  self.addEventListener('unhandledrejection', function (e) {
    // Library internals (e.g. a stream reader) failing outside our awaits.
    try { e.preventDefault(); } catch (x) {}
  });

  self.onmessage = function (e) {
    var m = e.data || {};
    if (m.type === 'media') runMedia(m);
    else if (m.type === 'ff') runFf(m);
    else if (m.type === 'heic') runHeic(m);
    else if (m.type === 'persist') runPersist(m);
    else if (m.type === 'cancel') {
      var j = jobs[m.id];
      if (j) {
        j.cancelled = true;
        if (j.conv) { try { j.conv.cancel(); } catch (x) {} }
      }
    }
  };

  // Exposed for the node smoke test only (harmless in the browser).
  self.__convertWorkerTest = { parseFfLine: parseFfLine, ffError: ffError, hms: hms, even: even, memCode: memCode };
})();
