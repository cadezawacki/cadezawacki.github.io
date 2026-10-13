/* Archive Utility — engine worker (classic worker; one per panel session).
 *
 * Everything heavy happens here so the editor never stalls, and because the
 * Origin Private File System's synchronous access handles (the only OPFS
 * write API Safari had before v26) exist only inside dedicated workers.
 *
 * Engines (fetched on first use, kept in our own Cache Storage bucket
 * CACHE below, loaded from blob: URLs with importScripts):
 *   - zip.js (BSD-3-Clause) — ZIP read/write, ZIP64, AES-256 / ZipCrypto.
 *   - 7z-wasm (7-Zip 24.09, GNU LGPL + unRAR restriction) — 7z create/extract
 *     with AES-256, and extraction of RAR, XZ, BZIP2, ZSTD, LZMA, CAB, ISO …
 *     NOTE (unRAR licence): the RAR decompression code inside 7zz.wasm may not
 *     be used to develop a RAR (WinRAR) compatible archiver.
 *   - TAR (ustar + PAX) and GZIP (native Compression Streams) are our own.
 *
 * Output never sits in memory when avoidable: it is written to a "spool" —
 * one OPFS temp file per job, written through a sync access handle — and
 * handed back as disk-backed File slices. Without OPFS (old Safari, some
 * private modes) the spool falls back to an in-memory buffer.
 *
 * Protocol: page -> {id, op, ...}; worker -> {id, type:'done'|'error'|
 * 'progress'|'engine'|'stage', ...}. One job at a time (the page queues).
 * Cancelling = the page terminates this worker.
 */
(function () {
  'use strict';
  var CACHE = 'cade-archive-v1';
  var TMP = 'cade-archive-tmp';
  var CH = 1 << 20; // read chunk for our own streaming (1 MiB)

  // Safari can't async-iterate a ReadableStream; libraries may. Fill the gap
  // before any engine loads. (Our own code never uses for-await on streams.)
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

  var ENG = null;          // engine URLs + sizes, from the 'init' message
  var sess = null;         // the open archive
  var curId = 0;           // id of the running request

  function post(m) { self.postMessage(m); }
  function noop() {}
  function errMsg(e) { return (e && (e.message || String(e))) || 'unknown error'; }
  function Fail(code, msg, extra) {
    var e = new Error(msg); e.code = code;
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }
  function toU8(c) {
    if (c instanceof Uint8Array) return c;
    if (ArrayBuffer.isView(c)) return new Uint8Array(c.buffer, c.byteOffset, c.byteLength);
    return new Uint8Array(c);
  }
  function basename(p) { p = String(p).replace(/\/+$/, ''); var i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
  // Archive paths are untrusted: no absolute paths, no "..", no empty parts.
  function safeParts(p) {
    return String(p).replace(/\\/g, '/').split('/').filter(function (s) { return s && s !== '.' && s !== '..'; });
  }
  function safePath(p) { return safeParts(p).join('/'); }
  var MIME = {
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    bmp: 'image/bmp', ico: 'image/x-icon', heic: 'image/heic', pdf: 'application/pdf', mp3: 'audio/mpeg',
    m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    zip: 'application/zip', '7z': 'application/x-7z-compressed', gz: 'application/gzip', tgz: 'application/gzip',
    tar: 'application/x-tar', rar: 'application/vnd.rar', xz: 'application/x-xz', bz2: 'application/x-bzip2',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  function mimeOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name);
    var t = m && MIME[m[1].toLowerCase()];
    if (!t && /\.\d{3}$/.test(name)) t = 'application/octet-stream';
    return t || 'application/octet-stream';
  }
  function mkFile(blob, name, mtime) {
    return new File([blob], name, { type: mimeOf(name), lastModified: mtime > 0 ? mtime : Date.now() });
  }
  var UTF8 = new TextDecoder('utf-8');
  var UTF8F = null;
  try { UTF8F = new TextDecoder('utf-8', { fatal: true }); } catch (e) {}
  var LATIN = null;
  try { LATIN = new TextDecoder('windows-1252'); } catch (e) {}
  // Names in old archives may be in a legacy code page; UTF-8 when valid.
  function decName(u8) {
    if (UTF8F) { try { return UTF8F.decode(u8); } catch (e) { if (LATIN) return LATIN.decode(u8); } }
    return UTF8.decode(u8);
  }
  function ascii(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; }
  var TE = new TextEncoder();

  // ---- progress -------------------------------------------------------------
  function Prog(total, label) { this.total = total || 0; this.done = 0; this.label = label || ''; this.t = 0; }
  Prog.prototype.add = function (n, label) { this.done += n; if (label != null) this.label = label; this.tick(); };
  Prog.prototype.set = function (n, label) { this.done = n; if (label != null) this.label = label; this.tick(); };
  Prog.prototype.tick = function (force) {
    var now = Date.now();
    if (!force && now - this.t < 120) return;
    this.t = now;
    post({ id: curId, type: 'progress', done: this.done, total: this.total, label: this.label });
  };
  function stage(text) { post({ id: curId, type: 'stage', text: text }); }

  // ---- engines (own Cache Storage bucket) -------------------------------------
  async function openCache() {
    try { return self.caches ? await self.caches.open(CACHE) : null; } catch (e) { return null; }
  }
  // Bytes for `url`, from our bucket or downloaded with progress and stored.
  async function getBytes(cache, url, size, name) {
    if (cache) {
      var hit = null;
      try { hit = await cache.match(url); } catch (e) {}
      if (hit) return await hit.arrayBuffer();
    }
    if (self.navigator && navigator.onLine === false) throw Fail('offline', 'You’re offline — the ' + name + ' engine downloads once, then works offline.');
    var res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' downloading the ' + name + ' engine');
    var buf;
    if (res.body && res.body.getReader) {
      var reader = res.body.getReader(), got = 0, last = 0;
      var u8 = new Uint8Array(Math.max(size || 0, 65536));
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        var c = r.value;
        if (got + c.length > u8.length) {
          var bigger = new Uint8Array(Math.max(u8.length * 2, got + c.length));
          bigger.set(u8.subarray(0, got)); u8 = bigger;
        }
        u8.set(c, got); got += c.length;
        var now = Date.now();
        if (now - last > 120) { last = now; post({ id: curId, type: 'engine', name: name, loaded: got, total: size || got }); }
      }
      buf = got === u8.length ? u8.buffer : u8.slice(0, got).buffer;
    } else {
      buf = await res.arrayBuffer();
    }
    post({ id: curId, type: 'engine', name: name, loaded: buf.byteLength, total: buf.byteLength });
    if (cache) {
      // Quota / private mode: still works now, just not offline later.
      try { await cache.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } })); } catch (e) {}
    }
    return buf;
  }
  // Classic-script engines run from a blob: URL (no network, no SW). If the
  // browser refuses importScripts on blob: URLs, fall back to indirect eval.
  function runScript(buf) {
    var url = URL.createObjectURL(new Blob([buf], { type: 'text/javascript' }));
    try {
      self.importScripts(url);
    } catch (e) {
      if (e && e.name === 'NetworkError' || /load|import|fetch/i.test(errMsg(e))) (0, eval)(new TextDecoder().decode(buf));
      else throw e;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  var zipP = null;
  function ensureZip() {
    if (!zipP) {
      zipP = (async function () {
        if (!self.zip || !self.zip.ZipReader) {
          var cache = await openCache();
          runScript(await getBytes(cache, ENG.zip.url, ENG.zip.size, 'ZIP'));
        }
        var Z = self.zip;
        if (!Z || !Z.ZipReader) throw new Error('ZIP engine failed to load');
        // We ARE the worker: no nested workers (Safari < 15.5 lacks them).
        Z.configure({ useWebWorkers: false });
        return Z;
      })();
      zipP.catch(function () { zipP = null; });
    }
    return zipP;
  }
  var szP = null, szModule = null;
  function ensure7z() {
    if (!szP) {
      szP = (async function () {
        if (typeof WebAssembly !== 'object') throw Fail('nowasm', 'This browser can’t run the 7-Zip engine (no WebAssembly).');
        var cache = await openCache();
        var parts = await Promise.all([
          self.SevenZip ? null : getBytes(cache, ENG.sz.js, ENG.sz.jsSize, '7-Zip'),
          getBytes(cache, ENG.sz.wasm, ENG.sz.wasmSize, '7-Zip'),
        ]);
        if (parts[0]) runScript(parts[0]);
        if (typeof self.SevenZip !== 'function') throw new Error('7-Zip engine failed to load');
        szModule = await WebAssembly.compile(parts[1]);
        return self.SevenZip;
      })();
      szP.catch(function () { szP = null; });
    }
    return szP;
  }

  // ---- spool: OPFS temp file through a sync access handle (or memory) --------
  var useOpfs = !!(self.navigator && navigator.storage && typeof navigator.storage.getDirectory === 'function' &&
    typeof self.FileSystemFileHandle === 'function' && 'createSyncAccessHandle' in self.FileSystemFileHandle.prototype);
  var seq = 0, memWarned = false;
  async function tmpDir() {
    var root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(TMP, { create: true });
  }
  async function newSpool(tag) {
    var sp = { end: 0, h: null, fh: null, mem: null, name: '' };
    if (useOpfs) {
      try {
        var dir = await tmpDir();
        sp.name = tag + '-' + Date.now().toString(36) + '-' + (seq++) + '.tmp';
        sp.fh = await dir.getFileHandle(sp.name, { create: true });
        sp.h = await sp.fh.createSyncAccessHandle();
        return sp;
      } catch (e) {
        useOpfs = false; // private mode / unsupported: memory from now on
      }
    }
    if (!memWarned) { memWarned = true; post({ id: curId, type: 'warn', message: 'No on-device temp storage here — output is kept in memory, so very large files may fail.' }); }
    sp.mem = new Uint8Array(1 << 20);
    sp.name = '';
    return sp;
  }
  function isQuota(e) { return e && (e.name === 'QuotaExceededError' || /quota|space/i.test(errMsg(e))); }
  function spWrite(sp, u8, at) {
    if (!u8.length) return;
    if (sp.h) {
      var n;
      try { n = sp.h.write(u8, { at: at }); }
      catch (e) { if (isQuota(e)) throw Fail('space', 'Not enough storage space on this device.'); throw e; }
      if (typeof n === 'number' && n < u8.length) throw Fail('space', 'Not enough storage space on this device.');
    } else {
      var need = at + u8.length;
      if (need > sp.mem.length) {
        var cap = sp.mem.length;
        while (cap < need) cap = cap < 268435456 ? cap * 2 : cap + 268435456;
        var b;
        try { b = new Uint8Array(cap); } catch (e) { throw Fail('memory', 'Out of memory — the output is too large for this device without temp storage.'); }
        b.set(sp.mem.subarray(0, sp.end)); sp.mem = b;
      }
      sp.mem.set(u8, at);
    }
    if (at + u8.length > sp.end) sp.end = at + u8.length;
  }
  function spRead(sp, u8, at) {
    if (sp.h) return sp.h.read(u8, { at: at });
    var n = Math.max(0, Math.min(u8.length, sp.end - at));
    u8.set(sp.mem.subarray(at, at + n));
    return n;
  }
  // Close the handle (async in Safari < 17, sync later: await covers both)
  // and return the finished bytes as a disk-backed File (or a memory Blob).
  async function spFinish(sp) {
    if (sp.h) {
      var h = sp.h; sp.h = null;
      await h.flush(); await h.close();
      return await sp.fh.getFile();
    }
    if (!sp.mem) return new Blob([]);
    var out = new Blob([sp.mem.subarray(0, sp.end)]);
    sp.mem = null;
    return out;
  }
  async function spAbort(sp) {
    if (sp.h) { var h = sp.h; sp.h = null; try { await h.close(); } catch (e) {} }
    sp.mem = null;
    if (sp.name) { try { var d = await tmpDir(); await d.removeEntry(sp.name); } catch (e) {} }
  }
  // Appending WritableStream over a spool (zip.js / our tar writer write here).
  function spAppender(sp) {
    return new WritableStream({ write: function (c) { spWrite(sp, toU8(c), sp.end); } });
  }
  async function cleanupTmp() {
    if (!useOpfs) return;
    try { var root = await navigator.storage.getDirectory(); await root.removeEntry(TMP, { recursive: true }); } catch (e) {}
  }

  // ---- output sinks ------------------------------------------------------------
  // Extracted files go to a sink: spool regions (returned as File slices), a
  // user-picked directory (Chromium), or one user-picked file (Chromium).
  function spoolSink(sp) {
    var regions = [];
    return {
      regions: regions,
      openFile: function (path, mtime) {
        var off = sp.end, size = 0;
        return Promise.resolve(new WritableStream({
          write: function (c) { var u = toU8(c); spWrite(sp, u, off + size); size += u.length; },
          close: function () { regions.push({ p: path, off: off, size: size, t: mtime }); },
        }));
      },
      dir: function (path, mtime) { regions.push({ p: path, d: 1, t: mtime }); return Promise.resolve(); },
      finish: async function () {
        var f = await spFinish(sp);
        return { files: regionFiles(f, regions), tmp: sp.name };
      },
      abort: function () { return spAbort(sp); },
    };
  }
  function regionFiles(f, regions) {
    var out = [];
    for (var i = 0; i < regions.length; i++) {
      var r = regions[i];
      if (r.d) { out.push({ p: r.p, d: 1 }); continue; }
      out.push({ p: r.p, s: r.size, f: mkFile(f.slice(r.off, r.off + r.size), basename(r.p) || 'file', r.t) });
    }
    return out;
  }
  // Names the user's OS will accept (Chromium also rejects / \ . ..).
  function fsName(s) {
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[\u0000-\u001f<>:"|?*\\]/g, '_').replace(/[. ]+$/, '');
    return s || '_';
  }
  function dirSink(root) {
    var dirs = {}, count = 0;
    function getDir(parts) {
      var key = parts.join('/');
      if (!key) return Promise.resolve(root);
      if (!dirs[key]) {
        dirs[key] = getDir(parts.slice(0, -1)).then(function (d) {
          return d.getDirectoryHandle(fsName(parts[parts.length - 1]), { create: true });
        });
        dirs[key].catch(function () { delete dirs[key]; });
      }
      return dirs[key];
    }
    return {
      openFile: async function (path) {
        var parts = safeParts(path);
        if (!parts.length) parts = ['file'];
        var name = fsName(parts.pop());
        var d = await getDir(parts);
        var fh = await d.getFileHandle(name, { create: true });
        count++;
        return await fh.createWritable();
      },
      dir: function (path) { return getDir(safeParts(path)); },
      finish: function () { return Promise.resolve({ saved: count, dir: root.name || '' }); },
      abort: function () { return Promise.resolve(); },
    };
  }
  function fileSink(handle) {
    var used = false;
    return {
      openFile: async function () {
        if (used) throw new Error('Only one file can be saved here');
        used = true;
        return await handle.createWritable();
      },
      dir: function () { return Promise.resolve(); },
      finish: function () { return Promise.resolve({ saved: used ? 1 : 0, name: handle.name || '' }); },
      abort: function () { return Promise.resolve(); },
    };
  }
  function makeSink(m, tag) {
    if (m.dirHandle) return Promise.resolve(dirSink(m.dirHandle));
    if (m.fileHandle) return Promise.resolve(fileSink(m.fileHandle));
    return newSpool(tag).then(spoolSink);
  }
  // Pump a Blob range into a WritableStream (closing it), with progress.
  async function pumpBlob(blob, ws, prog) {
    var w = ws.getWriter();
    try {
      for (var off = 0; off < blob.size; off += CH) {
        var ab = await blob.slice(off, Math.min(blob.size, off + CH)).arrayBuffer();
        await w.write(new Uint8Array(ab));
        if (prog) prog.add(ab.byteLength);
      }
      await w.close();
    } catch (e) {
      try { await w.abort(e); } catch (x) {}
      throw e;
    }
  }
  async function pumpStream(rs, ws, onChunk) {
    var r = rs.getReader(), w = ws.getWriter();
    try {
      for (;;) {
        var x = await r.read();
        if (x.done) break;
        if (onChunk) onChunk(x.value);
        await w.write(x.value);
      }
      await w.close();
    } catch (e) {
      try { r.cancel(e).catch(noop); } catch (x) {}
      try { await w.abort(e); } catch (x) {}
      throw e;
    }
  }
  // Counts the compressed bytes flowing into a decompressor (for progress).
  function counter(prog) {
    return new TransformStream({ transform: function (c, ctl) { prog.add(c.byteLength); ctl.enqueue(c); } });
  }

  // ---- format sniffing -----------------------------------------------------------
  function at(h, o, sig) {
    if (o + sig.length > h.length) return false;
    for (var i = 0; i < sig.length; i++) if (h[o + i] !== sig[i]) return false;
    return true;
  }
  function sniff(h, name) {
    var n = String(name || '').toLowerCase();
    if (at(h, 0, [0x50, 0x4b, 0x03, 0x04]) || at(h, 0, [0x50, 0x4b, 0x05, 0x06]) || at(h, 0, [0x50, 0x4b, 0x07, 0x08])) return 'zip';
    if (at(h, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
    if (at(h, 0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar';
    if (at(h, 0, [0x1f, 0x8b])) return 'gz';
    if (at(h, 0, [0x42, 0x5a, 0x68])) return 'bz2';
    if (at(h, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz';
    if (at(h, 0, [0x28, 0xb5, 0x2f, 0xfd])) return 'zst';
    if (at(h, 0, [0x4d, 0x53, 0x43, 0x46])) return 'cab';
    if (at(h, 0, [0x1f, 0x9d])) return 'Z';
    if (at(h, 0, [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e])) return 'ar';
    if (at(h, 0, [0xed, 0xab, 0xee, 0xdb])) return 'rpm';
    if (at(h, 0, [0x60, 0xea])) return 'arj';
    if (at(h, 0, [0x30, 0x37, 0x30, 0x37, 0x30])) return 'cpio';
    if (at(h, 32769, [0x43, 0x44, 0x30, 0x30, 0x31])) return 'iso';
    if (h.length >= 512 && isTarHeader(h)) return 'tar';
    if (at(h, 0, [0x4d, 0x5a])) return 'exe';
    if (at(h, 0, [0x5d, 0x00, 0x00]) && /\.(lzma|tlz)$/.test(n)) return 'lzma';
    if (/\.(dmg|wim|vhdx?|vmdk|qcow2?|squashfs|chm|msi|nsis|hfs|udf|img|lzh|lha|xar|pkg)$/.test(n)) return 'other';
    return 'unknown';
  }
  var LABEL = { zip: 'ZIP', '7z': '7z', rar: 'RAR', gz: 'GZIP', bz2: 'BZIP2', xz: 'XZ', zst: 'ZSTD', cab: 'CAB', Z: 'Z',
    ar: 'AR', rpm: 'RPM', arj: 'ARJ', cpio: 'CPIO', iso: 'ISO', tar: 'TAR', exe: 'EXE', lzma: 'LZMA', other: '', unknown: '' };

  // ---- TAR -------------------------------------------------------------------------
  function tarNum(b, off, len) {
    if (b[off] & 0x80) { // GNU base-256 (big sizes / negative times)
      var neg = b[off] === 0xff, v = 0;
      for (var i = off; i < off + len; i++) v = v * 256 + (i === off ? (b[i] & 0x7f) : b[i]);
      return neg ? 0 : v;
    }
    var s = '';
    for (var j = off; j < off + len; j++) {
      var c = b[j];
      if (c === 0 || c === 32) { if (s) break; continue; }
      if (c < 48 || c > 55) break;
      s += String.fromCharCode(c);
    }
    return s ? parseInt(s, 8) : 0;
  }
  function isTarHeader(b) {
    if (b.length < 512) return false;
    var u = 0, sg = 0, any = false;
    for (var i = 0; i < 512; i++) {
      var c = (i >= 148 && i < 156) ? 32 : b[i];
      if (b[i]) any = true;
      u += c; sg += c > 127 ? c - 256 : c;
    }
    if (!any) return false;
    var stored = tarNum(b, 148, 8);
    return stored === u || stored === sg;
  }
  function cstr(b, off, len) {
    var e = off;
    while (e < off + len && b[e]) e++;
    return decName(b.subarray(off, e));
  }
  function parsePax(u8) {
    var out = {}, p = 0;
    while (p < u8.length) {
      var sp = u8.indexOf(0x20, p);
      if (sp < 0) break;
      var len = parseInt(ascii(u8.subarray(p, sp)), 10);
      if (!(len > 0) || p + len > u8.length) break;
      var rec = u8.subarray(sp + 1, p + len - 1);
      var eq = rec.indexOf(0x3d);
      if (eq > 0) out[UTF8.decode(rec.subarray(0, eq))] = UTF8.decode(rec.subarray(eq + 1));
      p += len;
    }
    return out;
  }
  function allZero(b) { for (var i = 0; i < b.length; i++) if (b[i]) return false; return true; }
  // Headers are read through a 1 MiB window so archives of many small files
  // don't cost one async read per 512-byte block.
  function blockReader(blob) {
    var win = null, wOff = 0;
    return async function (off, len) {
      if (!win || off < wOff || off + len > wOff + win.length) {
        wOff = off;
        win = new Uint8Array(await blob.slice(off, Math.min(blob.size, off + Math.max(len, CH))).arrayBuffer());
      }
      return win.subarray(off - wOff, off - wOff + len);
    };
  }
  async function tarList(blob, prog) {
    var read = blockReader(blob), size = blob.size;
    var ents = [], off = 0, pax = null, longName = null, longLink = null, notes = [];
    while (off + 512 <= size) {
      var h = await read(off, 512);
      if (allZero(h)) break; // end-of-archive marker
      if (!isTarHeader(h)) {
        if (!ents.length) throw Fail('format', 'Not a TAR archive (bad header checksum).');
        notes.push('The archive is damaged after ' + ents.length + ' entries.');
        break;
      }
      var type = h[156] ? String.fromCharCode(h[156]) : '0';
      var sz = tarNum(h, 124, 12);
      var dataOff = off + 512;
      if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
        if (sz > 16777216) throw Fail('format', 'TAR extended header is too large.');
        var data = new Uint8Array(await blob.slice(dataOff, dataOff + sz).arrayBuffer());
        if (type === 'x') pax = parsePax(data);
        else if (type === 'L') longName = cstr(data, 0, data.length);
        else if (type === 'K') longLink = cstr(data, 0, data.length);
        off = dataOff + Math.ceil(sz / 512) * 512;
        continue;
      }
      var name = cstr(h, 0, 100);
      var magic = ascii(h.subarray(257, 263));
      if (magic === 'ustar\u0000') { var pre = cstr(h, 345, 155); if (pre) name = pre + '/' + name; }
      if (longName) name = longName;
      if (pax && pax.path) name = pax.path;
      if (pax && pax.size && /^\d+$/.test(pax.size)) sz = +pax.size;
      var mtime = tarNum(h, 136, 12) * 1000;
      if (pax && pax.mtime && isFinite(+pax.mtime)) mtime = Math.round(+pax.mtime * 1000);
      var link = longLink || (pax && pax.linkpath) || cstr(h, 157, 100);
      var isDir = type === '5' || (/\/$/.test(name) && (type === '0' || type === '7') && !sz);
      var path = name.replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
      var kind = isDir ? 'd' : (type === '0' || type === '7' || type === 'S') ? 'f' : (type === '1' || type === '2') ? 'l' : 'x';
      if (type === 'S' && !notes.some(function (s) { return /sparse/.test(s); })) notes.push('Sparse files are extracted as stored (holes not restored).');
      if (path && kind !== 'x') {
        ents.push({ p: path, d: isDir ? 1 : 0, s: kind === 'f' ? sz : 0, c: -1, t: mtime, k: kind === 'l' ? 'l' : '', link: kind === 'l' ? link : '', hard: type === '1' ? 1 : 0, off: dataOff });
      }
      pax = null; longName = longLink = null;
      // Whatever the type, the declared size of data follows the header.
      off = dataOff + Math.ceil(sz / 512) * 512;
      if (prog) prog.set(off);
    }
    return { entries: ents, notes: notes };
  }
  // -- writer (ustar; PAX records for long / non-ASCII names and >= 8 GiB sizes)
  var MAX_OCTAL_SIZE = 8589934592; // 8 GiB: 11 octal digits
  function putStr(h, off, len, bytes) { h.set(bytes.subarray(0, len), off); }
  function putOct(h, off, len, n) {
    var s = Math.max(0, Math.floor(n)).toString(8);
    while (s.length < len - 1) s = '0' + s;
    putStr(h, off, len, TE.encode(s.slice(-(len - 1))));
  }
  function putB256(h, off, len, n) {
    for (var i = off + len - 1; i > off; i--) { h[i] = n % 256; n = Math.floor(n / 256); }
    h[off] = 0x80;
  }
  function utf8Cut(bytes, max) {
    if (bytes.length <= max) return bytes;
    var e = max;
    while (e > 0 && (bytes[e] & 0xc0) === 0x80) e--; // don't split a character
    return bytes.subarray(0, e);
  }
  function tarHeader(o) {
    var h = new Uint8Array(512);
    putStr(h, 0, 100, o.name);
    putOct(h, 100, 8, o.mode);
    putOct(h, 108, 8, 0); putOct(h, 116, 8, 0);
    if (o.size >= MAX_OCTAL_SIZE) putB256(h, 124, 12, o.size); else putOct(h, 124, 12, o.size);
    putOct(h, 136, 12, o.mtime);
    h.fill(32, 148, 156);
    h[156] = o.type.charCodeAt(0);
    if (o.link) putStr(h, 157, 100, o.link);
    putStr(h, 257, 6, TE.encode('ustar\u0000'));
    putStr(h, 263, 2, TE.encode('00'));
    if (o.prefix) putStr(h, 345, 155, o.prefix);
    var sum = 0;
    for (var i = 0; i < 512; i++) sum += h[i];
    var s = sum.toString(8);
    while (s.length < 6) s = '0' + s;
    putStr(h, 148, 6, TE.encode(s)); h[154] = 0; h[155] = 32;
    return h;
  }
  function paxData(map) {
    var parts = [];
    for (var k in map) {
      var body = TE.encode(' ' + k + '=' + map[k] + '\n');
      var d = String(body.length).length;
      while (String(body.length + d).length !== d) d++;
      parts.push(TE.encode(String(body.length + d)), body);
    }
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), p = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], p); p += parts[i].length; }
    return out;
  }
  // Split a long name into ustar prefix (<=155) + name (<=100) at a '/'.
  function ustarSplit(b) {
    if (b.length > 256) return null;
    for (var i = Math.min(b.length - 2, 155); i > 0; i--) {
      if (b[i] === 0x2f && b.length - i - 1 <= 100 && b.length - i - 1 > 0) return { prefix: b.subarray(0, i), name: b.subarray(i + 1) };
    }
    return null;
  }
  function tarEntryHeaders(ent) {
    var full = ent.p + (ent.d ? '/' : '');
    var nb = TE.encode(full);
    var pax = {}, nameB = nb, prefixB = null;
    var nonAscii = /[^ -~]/.test(full);
    if (nb.length > 100 || nonAscii) {
      var sp = nonAscii ? null : ustarSplit(nb);
      if (sp) { prefixB = sp.prefix; nameB = sp.name; } else { pax.path = full; nameB = utf8Cut(nb, 100); }
    }
    var size = ent.d ? 0 : ent.s;
    if (size >= MAX_OCTAL_SIZE) pax.size = String(size);
    var mtime = Math.floor((ent.t || Date.now()) / 1000);
    var out = [];
    if (Object.keys(pax).length) {
      var data = paxData(pax);
      var pn = TE.encode('PaxHeader/' + basename(full).replace(/[^ -~]/g, '_'));
      out.push(tarHeader({ name: pn.subarray(0, 100), mode: 420, size: data.length, mtime: mtime, type: 'x' }));
      out.push(padTo512(data));
    }
    out.push(tarHeader({ name: nameB, prefix: prefixB, mode: ent.d ? 493 : 420, size: size, mtime: mtime, type: ent.d ? '5' : '0' }));
    return out;
  }
  function padTo512(u8) {
    var n = Math.ceil(u8.length / 512) * 512;
    if (n === u8.length) return u8;
    var o = new Uint8Array(n); o.set(u8); return o;
  }
  // Write items [{p, d, f: File, s, t}] as a tar stream into writer `w`.
  async function tarWrite(w, items, prog) {
    var total = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (prog) prog.label = it.p;
      var hs = tarEntryHeaders(it);
      for (var j = 0; j < hs.length; j++) { await w.write(hs[j]); total += hs[j].length; }
      if (it.d) continue;
      var f = it.f, done = 0;
      for (var off = 0; off < f.size; off += CH) {
        var ab = await f.slice(off, Math.min(f.size, off + CH)).arrayBuffer();
        if (!ab.byteLength) break;
        await w.write(new Uint8Array(ab));
        done += ab.byteLength;
        if (prog) prog.add(ab.byteLength, it.p);
      }
      if (done !== it.s) throw new Error('“' + it.p + '” changed while it was being read');
      total += done;
      var pad = (512 - (done % 512)) % 512;
      if (pad) { await w.write(new Uint8Array(pad)); total += pad; }
    }
    // End marker: two zero blocks, padded to the classic 10 KiB record.
    total += 1024;
    var rec = (10240 - (total % 10240)) % 10240;
    await w.write(new Uint8Array(1024 + rec));
  }

  // ---- GZIP -------------------------------------------------------------------------
  var hasDS = typeof self.DecompressionStream === 'function';
  var hasCS = typeof self.CompressionStream === 'function';
  function gzInnerName(h, outer) {
    var flg = h[3], p = 10;
    if (flg & 4) p += 2 + (h[10] | (h[11] << 8));
    if (flg & 8) {
      var e = p;
      while (e < h.length && h[e]) e++;
      var nm = safeParts(LATIN ? LATIN.decode(h.subarray(p, e)) : ascii(h.subarray(p, e))).pop();
      if (nm) return nm;
    }
    var base = basename(outer).replace(/\.(gz|gzip|z)$/i, '');
    return /\.tgz$/i.test(outer) ? base.replace(/\.tgz$/i, '.tar') : (base && base !== basename(outer) ? base : base + '.out');
  }
  async function gunzipPeek(blob, n) {
    var r = blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    var parts = [], got = 0;
    try {
      while (got < n) {
        var x = await r.read();
        if (x.done) break;
        parts.push(x.value); got += x.value.length;
      }
    } catch (e) {
      if (!got) throw e;
    } finally {
      r.cancel().catch(noop);
    }
    var out = new Uint8Array(got), p = 0;
    for (var i = 0; i < parts.length; i++) { out.set(parts[i], p); p += parts[i].length; }
    return out.subarray(0, n);
  }
  function gunzipStream(blob, prog) {
    var src = blob.stream();
    if (prog) src = src.pipeThrough(counter(prog));
    return src.pipeThrough(new DecompressionStream('gzip'));
  }
  async function isizeOf(blob) {
    if (blob.size < 18) return -1;
    var t = new Uint8Array(await blob.slice(blob.size - 4).arrayBuffer());
    return (t[0] | (t[1] << 8) | (t[2] << 16)) + t[3] * 16777216;
  }

  // ---- ZIP (zip.js) ---------------------------------------------------------------------
  function isPwErr(e) { var m = errMsg(e); return m === 'Invalid password' || m === 'File contains encrypted entry'; }
  async function zipOpen(Z, blob) {
    var zr = new Z.ZipReader(new Z.BlobReader(blob), { useWebWorkers: false });
    var zents = await zr.getEntries();
    var comment = '';
    try { if (zr.comment && zr.comment.length) comment = UTF8.decode(zr.comment); } catch (e) {}
    var ents = zents.map(function (e) {
      var p = String(e.filename).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
      return {
        p: p, d: e.directory ? 1 : 0, s: e.uncompressedSize || 0, c: e.compressedSize || 0,
        t: e.lastModDate ? +e.lastModDate : 0, e: e.encrypted ? 1 : 0, z: e.zipCrypto ? 1 : 0,
      };
    });
    return { zr: zr, zents: zents, entries: ents, comment: comment };
  }
  // Pick the password for an encrypted entry from the candidates (cheap check
  // first; ZipCrypto's 1-byte check can pass a wrong one — CRC catches that).
  async function zipPassword(ze, pws) {
    for (var i = 0; i < pws.length; i++) {
      try {
        await ze.getData(new WritableStream(), { password: pws[i], checkPasswordOnly: true, useWebWorkers: false });
        return pws[i];
      } catch (e) {
        if (!isPwErr(e)) throw e;
      }
    }
    return null;
  }
  async function zipReadEntry(ze, ent, pws, ws, prog) {
    var opts = { useWebWorkers: false, checkCrc32: true };
    if (ent.e) {
      var pw = await zipPassword(ze, pws);
      if (pw == null) throw Fail('password', 'Password required', { path: ent.p, wrong: pws.length > 0 });
      opts.password = pw;
    }
    if (prog) {
      var last = 0;
      opts.onprogress = function (n) { prog.add(n - last); last = n; };
    }
    try {
      await ze.getData(ws, opts);
    } catch (e) {
      // A ZipCrypto false positive surfaces as a CRC / data error.
      if (ent.e && ent.z && /crc|signature|compressed data|uncompressed size/i.test(errMsg(e))) throw Fail('password', 'Wrong password', { path: ent.p, wrong: true });
      throw e;
    }
  }

  // ---- 7-Zip (7z-wasm) ---------------------------------------------------------------
  // One fresh emscripten instance per job (cheap: the module is compiled
  // once): a failed or aborted run can't poison the next, and its memory
  // goes away with it.
  function SzOut() { this.o = []; this.e = []; this.ob = new Uint8Array(4096); this.on = 0; this.pct = -1; this.tail = ''; }
  SzOut.prototype.out = function (c) {
    if (this.on === this.ob.length) { var b = new Uint8Array(this.ob.length * 2); b.set(this.ob); this.ob = b; }
    this.ob[this.on++] = c;
    // Progress: "  42% 7 - name" redrawn with backspaces; watch for "NN%".
    if (c === 37) {
      var s = '', i = this.on - 2;
      while (i >= 0 && this.ob[i] >= 48 && this.ob[i] <= 57 && s.length < 3) { s = String.fromCharCode(this.ob[i]) + s; i--; }
      if (s && this.onPct) this.onPct(+s);
    }
  };
  SzOut.prototype.err = function (c) { this.e.push(c); };
  SzOut.prototype.stdout = function () { return UTF8.decode(this.ob.subarray(0, this.on)); };
  SzOut.prototype.stderr = function () { return UTF8.decode(new Uint8Array(this.e)); };
  async function new7z(out) {
    var factory = await ensure7z();
    return factory({
      noInitialRun: true,
      stdin: function () { return null; },
      stdout: function (c) { out.out(c); },
      stderr: function (c) { out.err(c); },
      print: noop, printErr: noop,
      locateFile: function (p) { return p; },
      instantiateWasm: function (imports, done) {
        WebAssembly.instantiate(szModule, imports).then(function (inst) { done(inst, szModule); });
        return {};
      },
    });
  }
  function szRun(M, out, args) {
    var rc;
    try { rc = M.callMain(args); } catch (e) {
      if (e && e.code) throw e; // our own (disk full …) from inside a sink write
      var msg = errMsg(e);
      if (/memory|OOM|Aborted/i.test(msg)) throw Fail('memory', 'Out of memory — this archive needs more memory than the browser allows here.');
      throw Fail('engine', '7-Zip stopped unexpectedly (' + msg + ')');
    }
    var err = out.stderr();
    if (/Wrong password|encrypted archive/i.test(err)) throw Fail('password', 'Wrong password', { wrong: true });
    if (rc === 8) throw Fail('memory', 'Out of memory — 7-Zip needs more memory than this device allows.');
    if (rc >= 2) {
      var line = (err.split('\n').filter(function (l) { return /\S/.test(l); }).slice(-2).join(' ') || ('7-Zip exited with code ' + rc)).replace(/^ERROR:\s*/, '');
      if (/Can ?not open the file as archive|Unsupported/i.test(line)) throw Fail('format', 'Not a supported archive (or it is damaged).');
      if (/Data Error|CRC Failed|Unexpected end|Headers Error/i.test(line)) throw Fail('damaged', 'The archive is damaged: ' + line);
      throw Fail('engine', line);
    }
    return { rc: rc, warn: rc === 1 ? (err.trim().split('\n').pop() || 'completed with warnings') : '' };
  }
  function pwArg(pw) { return '-p' + (pw || ''); } // never let 7-Zip prompt on stdin
  // Mount input Files read-only without copying (WORKERFS reads slices with
  // FileReaderSync on demand).
  function szMountInputs(M, files) {
    M.FS.mkdir('/in');
    var blobs = files.map(function (f) { return { name: safeParts(f.name).pop() || 'archive', data: f }; });
    M.FS.mount(M.WORKERFS, { blobs: blobs }, '/in');
    return blobs.map(function (b) { return '/in/' + b.name; });
  }
  // Route files 7-Zip writes under `root` straight into the spool instead of
  // the in-memory MEMFS, so big outputs never sit in RAM. Each output file
  // becomes a region; a second file opened while another is still open stays
  // in memory and is appended at the end.
  function szSink(M, root, sp) {
    var FS = M.FS, memS = null, memN = null, ops = null, nops = null;
    var openSinks = 0, lastSink = null;
    function u8v(buffer, offset, length) { return new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length); }
    function demote(n) {
      var data = new Uint8Array(n.usedBytes);
      if (n.usedBytes) spRead(sp, data, n.sink.base);
      if (n.sink.open) openSinks -= n.sink.open;
      n.sink = null; n.contents = data;
      n.stream_ops = memS; n.node_ops = memN;
    }
    function mk(node) {
      memS = node.stream_ops; memN = node.node_ops;
      ops = {
        llseek: memS.llseek,
        read: function (st, buffer, offset, length, position) {
          var n = st.node;
          if (!n.sink) return memS.read.apply(this, arguments);
          if (position >= n.usedBytes) return 0;
          var size = Math.min(n.usedBytes - position, length);
          return spRead(sp, u8v(buffer, offset, size), n.sink.base + position);
        },
        write: function (st, buffer, offset, length, position, canOwn) {
          var n = st.node;
          if (!length) return 0;
          if (n.sink && n.sink.limit != null && n.sink.base + position + length > n.sink.limit) demote(n);
          if (!n.sink) return memS.write.call(this, st, buffer, offset, length, position, canOwn);
          spWrite(sp, u8v(buffer, offset, length), n.sink.base + position);
          if (position + length > n.usedBytes) n.usedBytes = position + length;
          n.mtime = n.ctime = Date.now();
          return length;
        },
        close: function (st) {
          var n = st.node;
          if (n.sink && n.sink.open > 0) { n.sink.open--; openSinks--; }
        },
        mmap: function () { throw new FS.ErrnoError(43); },
        msync: function () { return 0; },
      };
      nops = {
        getattr: memN.getattr,
        setattr: function (n, attr) {
          if (n.sink && attr.size !== undefined) {
            var sz = attr.size;
            if (sz > n.usedBytes && n.sink.limit != null && n.sink.base + sz > n.sink.limit) { demote(n); return memN.setattr(n, attr); }
            n.usedBytes = sz;
            if (n.sink.base + sz > sp.end) sp.end = n.sink.base + sz;
            var a = {};
            for (var k in attr) if (k !== 'size') a[k] = attr[k];
            return memN.setattr(n, a);
          }
          return memN.setattr(n, attr);
        },
      };
    }
    var origOpen = FS.open;
    FS.open = function (path) {
      var st = origOpen.apply(FS, arguments);
      var n = st && st.node;
      if (n && FS.isFile(n.mode) && (st.flags & 3) && st.path && st.path.indexOf(root + '/') === 0) {
        if (!n.sink && n.usedBytes === 0 && !n.contents && openSinks === 0) {
          if (!ops) mk(n);
          if (lastSink && lastSink.sink) lastSink.sink.limit = sp.end;
          n.sink = { base: sp.end, open: 0, limit: null };
          n.stream_ops = ops; n.node_ops = nops; st.stream_ops = ops;
          lastSink = n;
        }
        if (n.sink) { n.sink.open++; openSinks++; }
      }
      return st;
    };
    // After the run: every file under root becomes a spool region.
    return function collect() {
      var regions = [];
      (function walk(dir, rel) {
        var names = FS.readdir(dir).filter(function (x) { return x !== '.' && x !== '..'; });
        names.sort();
        for (var i = 0; i < names.length; i++) {
          var p = dir + '/' + names[i], r = rel ? rel + '/' + names[i] : names[i];
          var node = FS.lookupPath(p, { follow: false }).node;
          if (FS.isDir(node.mode)) { regions.push({ p: r, d: 1, t: node.mtime }); walk(p, r); }
          else if (FS.isFile(node.mode)) {
            if (node.sink) regions.push({ p: r, off: node.sink.base, size: node.usedBytes, t: node.mtime });
            else {
              var data = node.contents ? node.contents.subarray(0, node.usedBytes) : new Uint8Array(0);
              var off = sp.end;
              spWrite(sp, data, off);
              node.contents = null;
              regions.push({ p: r, off: off, size: data.length, t: node.mtime });
            }
          }
        }
      })(root, '');
      return regions;
    };
  }
  function parse7zDate(s) {
    var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s || '');
    return m ? +new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
  }
  // Single-stream formats (xz, bzip2, zstd …) store no name: 7-Zip derives it
  // from the archive name when extracting; do the same for the listing.
  function streamName(name) {
    var n = basename(name || 'archive');
    var m = /^(.*)\.t(?:gz|az|xz|bz2?|zst|lz|lzma)$/i.exec(n);
    if (m) return m[1] + '.tar';
    m = /^(.*)\.(?:gz|xz|bz2|bz|zst|lzma|lz|z)$/i.exec(n);
    return m && m[1] ? m[1] : n + '.out';
  }
  function parse7zList(text, arcName) {
    var i = text.indexOf('\n----------\n');
    var head = i >= 0 ? text.slice(0, i) : text;
    // Nested containers (split volumes -> 7z) list one "Type =" each: the
    // innermost (last) is the archive itself.
    var type = '', tm, tre = /\nType = (.*)/g;
    while ((tm = tre.exec(head))) type = tm[1];
    var ents = [];
    if (i < 0) return { type: type, entries: ents, headEnc: false };
    var blocks = text.slice(i + 12).split(/\n\s*\n/);
    for (var b = 0; b < blocks.length; b++) {
      var f = {}, lines = blocks[b].split('\n');
      for (var l = 0; l < lines.length; l++) {
        var eq = lines[l].indexOf(' = ');
        if (eq > 0) f[lines[l].slice(0, eq)] = lines[l].slice(eq + 3);
      }
      if (f.Path == null) { if (f.Size == null) continue; f.Path = streamName(arcName); }
      var dir = f.Folder === '+' || /^D/.test(f.Attributes || '');
      var p = f.Path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
      if (!p) continue;
      ents.push({
        p: p, d: dir ? 1 : 0, s: dir ? 0 : (+f.Size || 0), c: f['Packed Size'] === '' || f['Packed Size'] == null ? -1 : (+f['Packed Size'] || 0),
        t: parse7zDate(f.Modified), e: f.Encrypted === '+' ? 1 : 0, k: f['Symbolic Link'] ? 'l' : '',
      });
    }
    return { type: type, entries: ents };
  }
  async function szList(files, pw) {
    var out = new SzOut(), M = await new7z(out);
    var paths = szMountInputs(M, files);
    szRun(M, out, ['l', '-slt', '-sccUTF-8', pwArg(pw), paths[0]]);
    return parse7zList(out.stdout(), files[0].name);
  }
  // Extract `sel` (archive paths; null = everything) into a spool.
  async function szExtract(files, pw, sel, prog, total) {
    var out = new SzOut(), M = await new7z(out);
    var paths = szMountInputs(M, files);
    var sp = await newSpool('x');
    try {
      M.FS.mkdir('/out');
      var collect = szSink(M, '/out', sp);
      var args = ['x', paths[0], '-o/out', '-y', '-bsp1', '-sccUTF-8', '-scsUTF-8', '-spd', pwArg(pw)];
      if (sel) {
        M.FS.writeFile('/list.txt', sel.join('\n'));
        args.push('-i@/list.txt'); // a list file: no stack limit on long selections
      }
      if (prog) out.onPct = function (p) { prog.set(Math.round(total * p / 100)); };
      var r = szRun(M, out, args);
      var regions = collect();
      M = null;
      var f = await spFinish(sp);
      return { regions: regions, file: f, tmp: sp.name, warn: r.warn };
    } catch (e) {
      await spAbort(sp);
      throw e;
    }
  }
  // Copy spool regions to a picked directory / file (Chromium) or hand back
  // File slices.
  async function deliverRegions(m, ex, prog) {
    if (m.dirHandle || m.fileHandle) {
      var sink = m.dirHandle ? dirSink(m.dirHandle) : fileSink(m.fileHandle);
      for (var i = 0; i < ex.regions.length; i++) {
        var r = ex.regions[i];
        if (r.d) { await sink.dir(r.p); continue; }
        if (prog) prog.label = r.p;
        await pumpBlob(ex.file.slice(r.off, r.off + r.size), await sink.openFile(r.p, r.t), prog);
      }
      var res = await sink.finish();
      await cleanupOne(ex.tmp);
      return res;
    }
    return { files: regionFiles(ex.file, ex.regions), tmp: ex.tmp };
  }
  async function cleanupOne(name) {
    if (!name || !useOpfs) return;
    try { var d = await tmpDir(); await d.removeEntry(name); } catch (e) {}
  }

  // ---- open ------------------------------------------------------------------------
  function volumeOrder(files) {
    // First volume first: .001 / .part1.rar / .zip before .z01 / .7z.001 …
    return files.slice().sort(function (a, b) {
      function key(n) {
        n = n.toLowerCase();
        var m = /\.part0*(\d+)\.rar$/.exec(n) || /\.(\d{3})$/.exec(n) || /\.[rz](\d\d)$/.exec(n);
        if (m) return (/\.[rz]\d\d$/.test(n) ? 1 : 0) + +m[1] * 2;
        return 0;
      }
      return key(a.name) - key(b.name);
    });
  }
  async function opOpen(m) {
    var files = volumeOrder(m.files || []);
    if (!files.length) throw Fail('format', 'No file');
    var main = files[0], name = main.name || 'archive';
    var h = new Uint8Array(await main.slice(0, 36864).arrayBuffer());
    var fmt = files.length > 1 ? 'multi' : sniff(h, name);
    var pw = m.password || '';
    var prog = new Prog(main.size, name);
    sess = { files: files, main: main, fmt: fmt, engine: '', pw: pw };
    var res = { fmt: fmt, label: LABEL[fmt] || '', comment: '', notes: [] };
    var lower = name.toLowerCase();

    if (fmt === 'zip' || fmt === 'exe') {
      try {
        var Z = await ensureZip();
        stage('Reading ' + name + '…');
        var zo = await zipOpen(Z, main);
        sess.engine = 'zip'; sess.zr = zo.zr; sess.zents = zo.zents; sess.entries = zo.entries;
        res.entries = zo.entries; res.comment = zo.comment; res.label = 'ZIP';
        return res;
      } catch (e) {
        if (e && e.code === 'offline') throw e;
        // not a ZIP after all (SFX, unusual layout): let 7-Zip try
      }
    }
    if (fmt === 'tar') {
      stage('Reading ' + name + '…');
      var tl = await tarList(main, prog);
      sess.engine = 'tar'; sess.tar = main; sess.entries = tl.entries;
      res.entries = tl.entries; res.notes = tl.notes; res.label = 'TAR';
      return res;
    }
    if (fmt === 'gz' && hasDS) {
      var peek = await gunzipPeek(main, 512);
      if ((peek.length === 512 && isTarHeader(peek)) || /\.(tgz|taz|tar\.gz)$/.test(lower)) {
        return await openInnerTar(res, 'TAR.GZ', function (sp) {
          stage('Decompressing ' + name + '…');
          return pumpStream(gunzipStream(main, prog), spAppender(sp));
        });
      }
      var inner = gzInnerName(h, name), isz = await isizeOf(main);
      sess.engine = 'gz';
      sess.entries = [{ p: inner, d: 0, s: isz >= 0 && main.size < 4294967296 ? isz : -1, c: main.size, t: main.lastModified || 0 }];
      res.entries = sess.entries; res.label = 'GZIP';
      return res;
    }
    // Everything else: 7-Zip.
    stage('Starting 7-Zip…');
    var li = await szList(files, pw);
    if (!li.entries.length && !li.type) throw Fail('format', 'Not a supported archive (or it is damaged).');
    var t = (li.type || '').toLowerCase();
    res.label = { '7z': '7z', rar: 'RAR', rar5: 'RAR', xz: 'XZ', bzip2: 'BZIP2', zstd: 'ZSTD', gzip: 'GZIP', lzma: 'LZMA', z: 'Z', cab: 'CAB', iso: 'ISO', tar: 'TAR', zip: 'ZIP', split: 'Split' }[t] || li.type || res.label;
    // Compressed tarball (tar.xz / tar.bz2 / tar.zst …): decompress the outer
    // layer to temp storage once, then browse the tar with random access.
    if (/^(xz|bzip2|zstd|gzip|lzma|z)$/.test(t) && li.entries.length === 1 &&
      (/\.tar$/i.test(li.entries[0].p) || /\.(tbz2?|tbz|txz|tzst|tlz|tlzma|taz)$/.test(lower))) {
      return await openInnerTar(res, 'TAR.' + res.label, null);
    }
    sess.engine = '7z'; sess.entries = li.entries; sess.type = t;
    res.entries = li.entries;
    if (t === 'rar' || t === 'rar5') res.notes.push('RAR archives can be extracted but not created (RAR is proprietary).');
    return res;

    async function openInnerTar(res2, label, fill) {
      var sp, f, tmp;
      if (fill) {
        sp = await newSpool('t');
        try { await fill(sp); f = await spFinish(sp); tmp = sp.name; } catch (e) { await spAbort(sp); throw e; }
      } else {
        stage('Decompressing ' + name + '…');
        var ex = await szExtract(files, pw, null, prog, main.size);
        var reg = ex.regions.filter(function (r) { return !r.d; })[0];
        if (!reg) throw Fail('format', 'Empty archive');
        f = ex.file.slice(reg.off, reg.off + reg.size); tmp = ex.tmp;
      }
      stage('Reading ' + name + '…');
      var tl2 = await tarList(f, new Prog(f.size, name));
      sess.engine = 'tar'; sess.tar = f; sess.entries = tl2.entries;
      res2.entries = tl2.entries; res2.notes = tl2.notes; res2.label = label;
      var tn = name.replace(/\.(gz|tgz|taz|xz|txz|bz2|tbz2?|zst|tzst|lzma|tlz|z)$/i, '');
      if (!/\.tar$/i.test(tn)) tn += '.tar';
      res2.innerTar = { file: mkFile(f, tn, main.lastModified), tmp: tmp };
      return res2;
    }
  }

  // ---- extract / read / test ------------------------------------------------------------
  function selected(sel) {
    var ents = sess.entries;
    if (!sel) return ents.map(function (e, i) { return i; });
    return sel.filter(function (i) { return i >= 0 && i < ents.length; });
  }
  function selTotal(idx) {
    var t = 0;
    for (var i = 0; i < idx.length; i++) { var e = sess.entries[idx[i]]; if (!e.d && e.s > 0) t += e.s; }
    return t;
  }
  async function opExtract(m) {
    if (!sess) throw Fail('state', 'No archive is open');
    var idx = selected(m.sel), ents = sess.entries, pws = m.passwords || [];
    var prog = new Prog(selTotal(idx), '');
    var notes = [];
    if (sess.engine === '7z') {
      var paths = m.sel ? idx.filter(function (i) { return !ents[i].d; }).map(function (i) { return ents[i].p; }) : null;
      var ex = await szExtract(sess.files, pws[pws.length - 1] || sess.pw, paths, prog, prog.total);
      var r = await deliverRegions(m, ex, prog);
      if (ex.warn) r.warn = ex.warn;
      return r;
    }
    var sink = await makeSink(m, 'x');
    try {
      for (var k = 0; k < idx.length; k++) {
        var i = idx[k], e = ents[i];
        prog.label = e.p;
        if (e.d) { await sink.dir(e.p, e.t); continue; }
        if (e.k === 'l') {
          // Symlinks can't be created here; hard links get the target's data.
          var tgt = e.hard ? findTarTarget(e.link) : null;
          if (!tgt) { notes.push('Skipped link ' + e.p + ' → ' + e.link); continue; }
          await pumpBlob(sess.tar.slice(tgt.off, tgt.off + tgt.s), await sink.openFile(e.p, e.t), prog);
          continue;
        }
        var ws = await sink.openFile(e.p, e.t);
        if (sess.engine === 'zip') await zipReadEntry(sess.zents[i], e, pws, ws, prog);
        else if (sess.engine === 'tar') await pumpBlob(sess.tar.slice(e.off, e.off + e.s), ws, prog);
        else if (sess.engine === 'gz') await pumpStream(gunzipStream(sess.main), ws, function (c) { prog.add(c.length); });
      }
      prog.tick(true);
      var res = await sink.finish();
      if (notes.length) res.warn = notes.slice(0, 3).join('; ') + (notes.length > 3 ? ' (+' + (notes.length - 3) + ' more)' : '');
      return res;
    } catch (err) {
      await sink.abort();
      throw err;
    }
  }
  function findTarTarget(link) {
    var p = String(link || '').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    for (var i = 0; i < sess.entries.length; i++) if (sess.entries[i].p === p && !sess.entries[i].k && !sess.entries[i].d) return sess.entries[i];
    return null;
  }
  // Small entry into memory (preview / insert into the document).
  async function opRead(m) {
    if (!sess) throw Fail('state', 'No archive is open');
    var e = sess.entries[m.i], max = m.max || 4194304, pws = m.passwords || [];
    if (!e || e.d) throw Fail('state', 'Not a file');
    var chunks = [], got = 0, truncated = false;
    var ws = new WritableStream({
      write: function (c) {
        var u = toU8(c);
        if (got >= max) { truncated = true; return; }
        if (got + u.length > max) { u = u.subarray(0, max - got); truncated = true; }
        chunks.push(u.slice()); got += u.length;
      },
    });
    if (sess.engine === 'zip') {
      await zipReadEntry(sess.zents[m.i], e, pws, ws, null);
    } else if (sess.engine === 'tar') {
      await pumpBlob(sess.tar.slice(e.off, e.off + Math.min(e.s, max)), ws, null);
      truncated = e.s > max;
    } else if (sess.engine === 'gz') {
      var r = gunzipStream(sess.main).getReader(), w = ws.getWriter();
      try {
        while (got < max) { var x = await r.read(); if (x.done) break; await w.write(x.value); }
        if (got >= max) truncated = true;
      } finally { r.cancel().catch(noop); }
    } else {
      if (e.s > max) truncated = true;
      if (e.s > 64 * 1048576) throw Fail('size', 'Too large to preview — extract it instead.');
      var ex = await szExtract(sess.files, pws[pws.length - 1] || sess.pw, [e.p], null, 0);
      var reg = ex.regions.filter(function (q) { return !q.d; })[0];
      if (reg) {
        var ab = await ex.file.slice(reg.off, reg.off + Math.min(reg.size, max)).arrayBuffer();
        chunks.push(new Uint8Array(ab)); got = ab.byteLength;
      }
      await cleanupOne(ex.tmp);
    }
    var out = new Uint8Array(got), p = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], p); p += chunks[i].length; }
    return { bytes: out, truncated: truncated };
  }
  async function opTest(m) {
    if (!sess) throw Fail('state', 'No archive is open');
    var ents = sess.entries, pws = m.passwords || [], errors = [], checked = 0;
    var prog = new Prog(selTotal(selected(null)), '');
    if (sess.engine === '7z') {
      var out = new SzOut(), M = await new7z(out);
      var paths = szMountInputs(M, sess.files);
      out.onPct = function (p) { prog.set(Math.round(prog.total * p / 100)); };
      try { szRun(M, out, ['t', paths[0], '-bsp1', '-sccUTF-8', pwArg(pws[pws.length - 1] || sess.pw)]); }
      catch (e) { if (e.code === 'password') throw e; errors.push({ p: '', m: errMsg(e) }); }
      return { ok: !errors.length, checked: ents.filter(function (e) { return !e.d; }).length, errors: errors };
    }
    var nul = function () { return new WritableStream(); };
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e.d || e.k === 'l') continue;
      prog.label = e.p;
      try {
        if (sess.engine === 'zip') await zipReadEntry(sess.zents[i], e, pws, nul(), prog);
        else if (sess.engine === 'tar') { if (e.off + e.s > sess.tar.size) throw new Error('truncated (data missing)'); prog.add(e.s); }
        else if (sess.engine === 'gz') await pumpStream(gunzipStream(sess.main), nul(), function (c) { prog.add(c.length); });
        checked++;
      } catch (err) {
        if (err && err.code === 'password') throw err;
        errors.push({ p: e.p, m: errMsg(err) });
        if (errors.length >= 200) break;
      }
    }
    return { ok: !errors.length, checked: checked, errors: errors };
  }

  // ---- create ------------------------------------------------------------------------------
  // Output for a created archive: the picked file (Chromium) or a spool.
  async function createOut(m, tag) {
    if (m.fileHandle) {
      var w = await m.fileHandle.createWritable();
      return { ws: w, finish: function () { return Promise.resolve({ saved: 1, name: m.fileHandle.name || m.name }); }, abort: function () { return w.abort().catch(noop); } };
    }
    var sp = await newSpool(tag);
    return {
      ws: spAppender(sp),
      finish: async function () {
        var f = await spFinish(sp);
        return { files: [{ p: m.name, s: f.size, f: mkFile(f, m.name, Date.now()) }], tmp: sp.name };
      },
      abort: function () { return spAbort(sp); },
    };
  }
  function itemTotal(items) { var t = 0; for (var i = 0; i < items.length; i++) if (!items[i].d) t += items[i].s; return t; }
  async function opCreate(m) {
    var items = (m.items || []).map(function (it) {
      return { p: safePath(it.p), d: it.d ? 1 : 0, f: it.f || null, s: it.f ? it.f.size : 0, t: it.t || (it.f && it.f.lastModified) || Date.now() };
    }).filter(function (it) { return it.p; });
    if (!items.length) throw Fail('state', 'Nothing to add');
    var prog = new Prog(itemTotal(items), '');
    var fmt = m.fmt;
    if (fmt === '7z') return await create7z(m, items, prog);
    var out = await createOut(m, 'c');
    try {
      if (fmt === 'zip') {
        var Z = await ensureZip();
        var zw = new Z.ZipWriter(out.ws, { useWebWorkers: false, keepOrder: true });
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          prog.label = it.p;
          var o = { lastModDate: new Date(it.t), useWebWorkers: false };
          if (it.d) { await zw.add(it.p + '/', null, Object.assign(o, { directory: true })); continue; }
          o.level = m.level;
          if (m.password) { o.password = m.password; if (m.zipCrypto) o.zipCrypto = true; else o.encryptionStrength = 3; }
          var last = 0;
          o.onprogress = function (n) { prog.add(n - last); last = n; };
          await zw.add(it.p, new Z.BlobReader(it.f), o);
          if (last < it.s) prog.add(it.s - last);
        }
        await zw.close();
      } else if (fmt === 'tar' || fmt === 'tgz') {
        var dest = out.ws, piped = null;
        if (fmt === 'tgz') {
          if (!hasCS) throw Fail('support', 'This browser can’t gzip (needs iOS / Safari 16.4 or newer).');
          var cs = new CompressionStream('gzip');
          piped = cs.readable.pipeTo(out.ws);
          piped.catch(noop);
          dest = cs.writable;
        }
        var w = dest.getWriter();
        try { await tarWrite(w, items, prog); await w.close(); }
        catch (e) { try { await w.abort(e); } catch (x) {} throw e; }
        if (piped) await piped;
      } else if (fmt === 'gz') {
        var f = items.filter(function (x) { return !x.d; })[0];
        if (!f) throw Fail('state', 'Pick one file to gzip');
        if (!hasCS) throw Fail('support', 'This browser can’t gzip (needs iOS / Safari 16.4 or newer).');
        prog.label = f.p;
        await pumpStream(f.f.stream().pipeThrough(counter(prog)).pipeThrough(new CompressionStream('gzip')), out.ws);
      } else {
        throw Fail('state', 'Unknown format');
      }
      prog.tick(true);
      return await out.finish();
    } catch (err) {
      await out.abort();
      throw err;
    }
  }
  async function create7z(m, items, prog) {
    var out = new SzOut(), M = await new7z(out), FS = M.FS;
    // Inputs mounted in place (no copy); folders, empty ones included, and
    // modification times recreated on the read-only WORKERFS tree.
    FS.mkdir('/in');
    var files = items.filter(function (x) { return !x.d; });
    FS.mount(M.WORKERFS, { blobs: files.map(function (x) { return { name: x.p, data: x.f }; }) }, '/in');
    items.forEach(function (x) {
      var parts = x.p.split('/'), cur = '/in';
      var upto = x.d ? parts.length : parts.length - 1;
      for (var i = 0; i < upto; i++) {
        var next = cur + '/' + parts[i];
        try { FS.lookupPath(next); } catch (e) { M.WORKERFS.createNode(FS.lookupPath(cur).node, parts[i], M.WORKERFS.DIR_MODE, 0); }
        cur = next;
      }
      try { var n = FS.lookupPath('/in/' + x.p).node; n.mtime = n.atime = n.ctime = x.t; } catch (e) {}
    });
    var top = [];
    items.forEach(function (x) { var t0 = x.p.split('/')[0]; if (top.indexOf(t0) < 0) top.push(t0); });
    var sp = await newSpool('c');
    try {
      FS.mkdir('/out');
      var collect = szSink(M, '/out', sp);
      FS.writeFile('/list.txt', top.join('\n'));
      FS.chdir('/in');
      var args = ['a', '-t7z', '-mx=' + (m.level == null ? 5 : m.level), '-bsp1', '-sccUTF-8', '-scsUTF-8', '-spd', '-y', '-mtm=on'];
      if (m.password) { args.push('-p' + m.password, '-mhe=' + (m.encNames ? 'on' : 'off')); }
      if (m.vol) args.push('-v' + m.vol);
      args.push('/out/' + safeParts(m.name).pop(), '@/list.txt');
      out.onPct = function (p) { prog.set(Math.round(prog.total * p / 100)); };
      var r = szRun(M, out, args);
      var regions = collect().filter(function (q) { return !q.d; });
      M = null;
      var f = await spFinish(sp);
      var res = await deliverRegions(m.fileHandle && regions.length === 1 ? m : {}, { regions: regions, file: f, tmp: sp.name }, null);
      if (r.warn) res.warn = r.warn;
      return res;
    } catch (e) {
      await spAbort(sp);
      throw e;
    }
  }
  // Bundle already-extracted Files into one stored (uncompressed) ZIP — for
  // phones, where a folder can't be written but Files can unzip a .zip.
  async function opBundle(m) {
    var Z = await ensureZip();
    var list = m.files || [];
    var total = 0;
    list.forEach(function (x) { if (x.f) total += x.f.size; });
    var prog = new Prog(total, '');
    var out = await createOut({ name: m.name, fileHandle: m.fileHandle }, 'b');
    try {
      var zw = new Z.ZipWriter(out.ws, { useWebWorkers: false, keepOrder: true });
      for (var i = 0; i < list.length; i++) {
        var x = list[i], p = safePath(x.p);
        if (!p) continue;
        prog.label = p;
        if (x.d) { await zw.add(p + '/', null, { directory: true }); continue; }
        var last = 0;
        await zw.add(p, new Z.BlobReader(x.f), { level: 0, lastModDate: new Date(x.f.lastModified || Date.now()), onprogress: function (n) { prog.add(n - last); last = n; } });
      }
      await zw.close();
      return await out.finish();
    } catch (e) {
      await out.abort();
      throw e;
    }
  }
  // Quick action: gunzip one file (no archive session needed).
  async function opGunzip(m) {
    var f = m.file;
    if (!hasDS) throw Fail('support', 'This browser can’t gunzip (needs iOS / Safari 16.4 or newer).');
    var h = new Uint8Array(await f.slice(0, 4096).arrayBuffer());
    if (h[0] !== 0x1f || h[1] !== 0x8b) throw Fail('format', 'Not a gzip file.');
    var name = gzInnerName(h, f.name);
    var prog = new Prog(f.size, name);
    var out = await createOut({ name: name, fileHandle: m.fileHandle }, 'g');
    try {
      await pumpStream(gunzipStream(f, prog), out.ws);
      return await out.finish();
    } catch (e) { await out.abort(); throw e; }
  }

  // ---- dispatch -------------------------------------------------------------------------
  var OPS = {
    init: async function (m) { ENG = m.engines; return { opfs: useOpfs, cs: hasCS, ds: hasDS, wasm: typeof WebAssembly === 'object' }; },
    open: opOpen,
    extract: opExtract,
    read: opRead,
    test: opTest,
    create: opCreate,
    bundle: opBundle,
    gunzip: opGunzip,
    cleanup: async function () { await cleanupTmp(); return {}; },
    close: async function () {
      if (sess && sess.zr) { try { await sess.zr.close(); } catch (e) {} }
      sess = null; return {};
    },
  };
  var queue = Promise.resolve();
  self.onmessage = function (ev) {
    var m = ev.data || {};
    queue = queue.then(function () {
      curId = m.id;
      var fn = OPS[m.op];
      if (!fn) return post({ id: m.id, type: 'error', code: 'state', message: 'Unknown operation' });
      return Promise.resolve().then(function () { return fn(m); }).then(function (res) {
        post(Object.assign({ id: m.id, type: 'done' }, res || {}));
      }, function (e) {
        post({ id: m.id, type: 'error', code: (e && e.code) || '', message: errMsg(e), path: e && e.path, wrong: !!(e && e.wrong) });
      });
    });
  };
  // Anything thrown outside a request's promise chain still ends the request.
  self.addEventListener('unhandledrejection', function (e) {
    try { e.preventDefault(); } catch (x) {}
  });

  // Exposed for the node unit tests only (harmless in the browser).
  self.__archiveTest = {
    sniff: sniff, tarList: tarList, tarWrite: tarWrite, tarEntryHeaders: tarEntryHeaders, isTarHeader: isTarHeader,
    parsePax: parsePax, paxData: paxData, tarNum: tarNum, parse7zList: parse7zList, gzInnerName: gzInnerName,
    safeParts: safeParts, streamName: streamName, OPS: OPS, setEngines: function (e) { ENG = e; },
  };
})();
