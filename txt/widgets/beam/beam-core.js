/* Beam — the pure part: everything about a transfer that doesn't touch the
 * network or the page, so node can test it (node txt/widgets/beam/beam.test.js).
 *
 *   manifest   what a sender offers: { v, x (transfer id), files: [{ n name,
 *              s size, t mime }], total }. Names are sanitised and made unique
 *              on both ends; a receiver drops anything malformed.
 *   frames     a direct-channel chunk is one binary message: a 16-byte header
 *              (magic "BM", version, file index, byte offset) + the bytes. The
 *              cloud relay carries the same (f, o, bytes) as base64 in a
 *              sealed object. Every chunk says where it belongs, so a transfer
 *              that falls back from direct to the relay half-way can resume
 *              from the last acknowledged spot and the receiver just drops the
 *              overlap (overlap()).
 *   cursor     the sender's walk through the files: chunk, chunk, …, fin (the
 *              file's CRC follows its bytes), next file, …, end.
 *   crc32      incremental (crc32(b, crc32(a)) === crc32(a ++ b)); checked per
 *              file together with the size when its fin arrives.
 *   meter      smoothed speed (EWMA) and an ETA that counts down steadily
 *              instead of jumping with every sample.
 *   inbox      received files are kept 7 days (and within a size budget).
 * UMD: module.exports in node, window.__cadeBeamCore in the browser. */
(function (root) {
  'use strict';

  var KB = 1024, MB = 1024 * 1024;
  var C = {
    V: 1,
    HDR: 16,                    // frame header bytes
    DC_MSG: 64 * KB,            // largest direct-channel message (capped by the peer's sctp.maxMessageSize)
    READ_BLOCK: MB,             // sender reads the file this much at a time
    DC_HIGH: MB,                // pause sending above this much buffered in the channel…
    DC_LOW: 256 * KB,           // …and resume below this (bufferedAmountLowThreshold)
    ACK_EVERY: 512 * KB,        // receiver confirms progress this often (resume point for a fallback)
    RELAY_CHUNK: 128 * KB,      // bytes per cloud node
    RELAY_WINDOW: 2 * MB,       // un-acknowledged bytes the sender keeps in the cloud at most
    RELAY_MAX: 100 * MB,        // the cloud path refuses more than this
    DIRECT_WAIT: 8000,          // no direct channel by then → cloud relay
    DIRECT_STALL: 10000,        // a direct channel that stops moving for this long → cloud relay
    ANSWER_WAIT: 20000,         // no answer at all by then → give up
    STALL: 45000,               // no progress for this long → connection lost
    SIG_STALE: 60000,           // signalling older than this is ignored
    ONLINE_FOR: 3 * 60 * 1000,  // presence older than this is a device that went away
    TOUCH_EVERY: 60000,         // presence refresh
    INBOX_TTL: 7 * 24 * 3600 * 1000,
    INBOX_BUDGET: 1024 * MB,    // older received files beyond this total are dropped
    MAX_FILES: 1000,
    MAX_SIZE: 9007199254740991  // Number.MAX_SAFE_INTEGER: no real cap
  };

  // ---- ids, CRC32 ---------------------------------------------------------------------------
  function rid(n) {
    var s = '', a = '0123456789abcdefghijklmnopqrstuvwxyz', k = n || 12;
    var r = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(k)) : null;
    for (var i = 0; i < k; i++) s += a.charAt(r ? r[i] % 36 : Math.floor(Math.random() * 36));
    return s;
  }
  var CRC_T = null;
  function crcTable() {
    if (CRC_T) return CRC_T;
    CRC_T = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_T[n] = c;
    }
    return CRC_T;
  }
  // CRC-32 (IEEE, as zip/png) of `bytes`, continuing from `prev` (0 to start).
  function crc32(bytes, prev) {
    var t = crcTable(), c = ~(prev >>> 0), n = bytes.length;
    for (var i = 0; i < n; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return ~c >>> 0;
  }
  function crcHex(c) { return ('0000000' + (c >>> 0).toString(16)).slice(-8); }

  // ---- names, mime types --------------------------------------------------------------------
  // A received name becomes a plain file name: no folders, control or
  // bidi/zero-width characters (the "txt.exe"-reversed trick), nothing
  // Windows or iOS refuses, at most 120 characters (keeping the extension).
  function safeName(name) {
    var n = String(name == null ? '' : name).split(/[\\/]/).pop();
    n = n.replace(/[​-‏‪-‮⁠-⁩﻿]/g, '');
    n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim();
    n = n.replace(/[. ]+$/, '');
    if (!n) return 'file';
    if (n.charAt(0) === '.') n = '_' + n;
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
    if (n.length > 120) {
      var dot = n.lastIndexOf('.'), ext = (dot > 0 && n.length - dot <= 12) ? n.slice(dot) : '';
      n = n.slice(0, 120 - ext.length).replace(/[. ]+$/, '') + ext;
    }
    return n;
  }
  // Same name twice in one beam → "a.txt", "a (2).txt" (case-insensitive).
  function uniqueNames(names) {
    var seen = {}, out = [];
    names.forEach(function (n) {
      var name = n, k = 1, dot = n.lastIndexOf('.'), base = dot > 0 ? n.slice(0, dot) : n, ext = dot > 0 ? n.slice(dot) : '';
      while (seen[name.toLowerCase()]) name = base + ' (' + (++k) + ')' + ext;
      seen[name.toLowerCase()] = 1;
      out.push(name);
    });
    return out;
  }
  function safeMime(t) {
    t = String(t || '').split(';')[0].trim().toLowerCase();
    return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,99}$/.test(t) ? t : '';
  }
  function extOf(name) { var m = /\.([a-z0-9]{1,10})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
  var IMG_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif' };
  var TEXT_EXT = 'txt,md,markdown,csv,tsv,json,log,xml,yaml,yml,toml,ini,cfg,conf,js,mjs,ts,tsx,jsx,css,scss,html,htm,py,rb,go,rs,java,kt,swift,c,h,cpp,hpp,cs,php,sh,bash,zsh,sql,svg,srt,vtt,tex,rst,diff,patch'.split(',');
  // What "Open" can show in a browser tab: 'image' | 'pdf' | 'text' | null. HTML
  // and SVG open as plain text — a blob URL runs in the app's own origin.
  function openKind(mime, name) {
    var t = safeMime(mime), e = extOf(name);
    if (/^image\/(png|jpeg|gif|webp|avif|bmp|heic|heif)$/.test(t) || (!t && IMG_EXT[e]) || (t === 'application/octet-stream' && IMG_EXT[e])) return 'image';
    if (t === 'application/pdf' || e === 'pdf') return 'pdf';
    if (/^text\//.test(t) || /^application\/(json|xml|javascript|x-javascript|x-yaml|yaml|x-sh|sql|toml|ld\+json)$/.test(t) || t === 'image/svg+xml' || TEXT_EXT.indexOf(e) >= 0) return 'text';
    return null;
  }
  // Worth a thumbnail (an <img> never runs an SVG's scripts).
  function isImage(mime, name) { return openKind(mime, name) === 'image' || safeMime(mime) === 'image/svg+xml' || extOf(name) === 'svg'; }
  function openType(kind, mime, name) {
    if (kind === 'text') return 'text/plain;charset=utf-8';
    if (kind === 'pdf') return 'application/pdf';
    var t = safeMime(mime);
    return /^image\//.test(t) ? t : (IMG_EXT[extOf(name)] || 'application/octet-stream');
  }

  // ---- manifest -----------------------------------------------------------------------------
  function makeManifest(x, files) {
    var names = uniqueNames(files.map(function (f) { return safeName(f.name); })), total = 0;
    var list = files.map(function (f, i) { total += f.size; return { n: names[i], s: f.size, t: safeMime(f.type || f.mime) }; });
    return { v: C.V, x: x, files: list, total: total };
  }
  // A manifest from the network, normalised — or null when anything is off.
  function validManifest(m) {
    if (!m || typeof m !== 'object' || m.v !== C.V) return null;
    if (typeof m.x !== 'string' || !/^[a-z0-9]{6,32}$/.test(m.x)) return null;
    if (!Array.isArray(m.files) || !m.files.length || m.files.length > C.MAX_FILES) return null;
    var out = [], total = 0;
    for (var i = 0; i < m.files.length; i++) {
      var f = m.files[i];
      if (!f || typeof f !== 'object' || typeof f.s !== 'number' || !(f.s >= 0) || f.s % 1 !== 0 || f.s > C.MAX_SIZE) return null;
      out.push({ n: safeName(f.n), s: f.s, t: safeMime(f.t) });
      total += f.s;
    }
    if (m.total != null && m.total !== total) return null;
    var names = uniqueNames(out.map(function (f) { return f.n; }));
    out.forEach(function (f, j) { f.n = names[j]; });
    return { v: C.V, x: m.x, files: out, total: total };
  }

  // ---- frames, offsets, the sender's cursor -------------------------------------------------
  // Bytes per direct-channel message, given the peer's sctp.maxMessageSize.
  function msgSize(max) {
    var m = +max;
    if (!(m > 0)) m = C.DC_MSG;
    return Math.max(C.HDR + 512, Math.min(C.DC_MSG, Math.floor(m)));
  }
  function encodeFrame(f, o, data) {
    var out = new Uint8Array(C.HDR + data.length), dv = new DataView(out.buffer);
    out[0] = 0xBE; out[1] = 0x4D; out[2] = C.V; out[3] = 0;
    dv.setUint32(4, f >>> 0, true);
    dv.setUint32(8, o % 4294967296, true);
    dv.setUint32(12, Math.floor(o / 4294967296), true);
    out.set(data, C.HDR);
    return out;
  }
  function decodeFrame(buf) {
    var u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u.length < C.HDR || u[0] !== 0xBE || u[1] !== 0x4D || u[2] !== C.V) return null;
    var dv = new DataView(u.buffer, u.byteOffset, C.HDR);
    return { f: dv.getUint32(4, true), o: dv.getUint32(8, true) + dv.getUint32(12, true) * 4294967296, data: u.subarray(C.HDR) };
  }
  // Global byte position of (file f, offset o), and back.
  function offsetOf(sizes, f, o) { var n = 0; for (var i = 0; i < f && i < sizes.length; i++) n += sizes[i]; return n + (o || 0); }
  function posOf(sizes, n) {
    for (var f = 0; f < sizes.length; f++) { if (n < sizes[f]) return { f: f, o: n }; n -= sizes[f]; }
    return { f: sizes.length, o: 0 };
  }
  // Walk the files from (f, o): next(n) → {k:'chunk', f, o, len} (at most n bytes),
  // {k:'fin', f} after a file's last byte (empty files get just their fin), {k:'end'}.
  function cursor(sizes, f, o) {
    f = f || 0; o = o || 0;
    return {
      next: function (n) {
        if (f >= sizes.length) return { k: 'end' };
        if (o < sizes[f]) { var st = { k: 'chunk', f: f, o: o, len: Math.min(n, sizes[f] - o) }; o += st.len; return st; }
        var fin = { k: 'fin', f: f }; f++; o = 0; return fin;
      },
      pos: function () { return { f: f, o: o }; }
    };
  }
  // The receiver holds `got` contiguous bytes of a file; a chunk brings [o, o + len).
  // take: where in the chunk the new bytes start (-1 = nothing new); gap: it skipped ahead.
  function overlap(got, o, len) {
    if (o > got) return { take: -1, gap: true };
    if (o + len <= got) return { take: -1, gap: false };
    return { take: got - o, gap: false };
  }
  // Running CRC over a stream that may re-send bytes it already counted (after a
  // fallback the sender re-reads from the last acknowledged spot).
  function crcAdvance(state, o, bytes) {
    var ov = overlap(state.pos, o, bytes.length);
    if (ov.take < 0) return !ov.gap;
    state.crc = crc32(ov.take ? bytes.subarray(ov.take) : bytes, state.crc);
    state.pos = o + bytes.length;
    return true;
  }

  // ---- progress -----------------------------------------------------------------------------
  // meter(total).update(doneBytes, nowMs) → { done, total, pct, bps, eta (s | null) }.
  function meter(total) {
    var t0 = -1, lastT = 0, lastD = 0, bps = 0, eta = null, n = 0;
    return {
      update: function (done, now) {
        if (t0 < 0) { t0 = now; lastT = now; lastD = done; }
        var dt = now - lastT;
        if (dt >= 250) {
          var inst = Math.max(0, done - lastD) * 1000 / dt;
          bps = n ? bps + 0.3 * (inst - bps) : inst;
          n++; lastT = now; lastD = done;
          var raw = bps > 0 ? Math.max(0, total - done) / bps : null;
          if (raw == null) eta = null;
          else if (eta == null || n < 3) eta = raw;
          else { var pred = Math.max(0, eta - dt / 1000); eta = pred + 0.25 * (raw - pred); }
        }
        if (done >= total) eta = 0;
        return { done: done, total: total, pct: total > 0 ? Math.min(100, done * 100 / total) : (done >= total ? 100 : 0), bps: bps, eta: n >= 2 || done >= total ? eta : null };
      }
    };
  }
  function fmtBytes(n) {
    if (!(n >= 0)) return '';
    if (n < KB) return n + ' B';
    if (n < MB) return (n / KB).toFixed(n < 10 * KB ? 1 : 0) + ' KB';
    if (n < 1024 * MB) return (n / MB).toFixed(1) + ' MB';
    return (n / (1024 * MB)).toFixed(2) + ' GB';
  }
  function fmtRate(bps) { return bps >= 1 ? fmtBytes(Math.round(bps)) + '/s' : ''; }
  function fmtEta(s) {
    if (s == null || !isFinite(s)) return '';
    if (s < 1) return 'almost done';
    if (s < 60) return Math.ceil(s) + ' s left';
    if (s < 3600) return Math.ceil(s / 60) + ' min left';
    var h = Math.floor(s / 3600);
    return h + ' h ' + Math.ceil((s - h * 3600) / 60) + ' min left';
  }
  function fmtPct(p) { return p >= 100 ? '100%' : (p < 10 ? p.toFixed(1) : Math.floor(p)) + '%'; }
  // How a transfer is travelling, for the UI.
  function pathLabel(path, note) {
    if (path === 'direct') return 'direct · ' + (note === 'lan' ? 'Wi-Fi' : note === 'internet' ? 'internet' : 'peer-to-peer');
    if (path === 'relay') return 'via cloud · slower';
    if (path === 'qr') return 'QR stream';
    return 'connecting…';
  }
  // Two host candidates = the same local network.
  function pathNote(localType, remoteType) { return localType === 'host' && (!remoteType || remoteType === 'host') ? 'lan' : 'internet'; }

  // ---- base64 -------------------------------------------------------------------------------
  function b64enc(bytes) {
    if (typeof btoa === 'function') {
      var s = '';
      for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('base64');
  }
  function b64dec(str) {
    if (typeof atob === 'function') {
      var bin = atob(str), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(str, 'base64'));
  }

  // ---- inbox rules --------------------------------------------------------------------------
  function expired(rec, now) { return !rec || !(rec.at > 0) || now - rec.at > C.INBOX_TTL; }
  // Ids to delete: everything expired, then — newest first — whatever no longer
  // fits the size budget (the newest file is always kept).
  function prune(list, now, budget) {
    var drop = [], keep = [], sum = 0;
    budget = budget == null ? C.INBOX_BUDGET : budget;
    list.forEach(function (r) { if (expired(r, now)) drop.push(r.id); else keep.push(r); });
    keep.sort(function (a, b) { return b.at - a.at; });
    keep.forEach(function (r, i) { sum += r.size || 0; if (i > 0 && sum > budget) drop.push(r.id); });
    return drop;
  }
  function ago(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }
  function kindIcon(k) { return k === 'phone' ? '📱' : k === 'tablet' ? '📲' : '💻'; }

  var api = {
    C: C, rid: rid, crc32: crc32, crcHex: crcHex, safeName: safeName, uniqueNames: uniqueNames, safeMime: safeMime, extOf: extOf,
    openKind: openKind, isImage: isImage, openType: openType, makeManifest: makeManifest, validManifest: validManifest,
    msgSize: msgSize, encodeFrame: encodeFrame, decodeFrame: decodeFrame, offsetOf: offsetOf, posOf: posOf, cursor: cursor,
    overlap: overlap, crcAdvance: crcAdvance, meter: meter, fmtBytes: fmtBytes, fmtRate: fmtRate, fmtEta: fmtEta, fmtPct: fmtPct,
    pathLabel: pathLabel, pathNote: pathNote, b64enc: b64enc, b64dec: b64dec, expired: expired, prune: prune, ago: ago, kindIcon: kindIcon
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined' && !window.__cadeBeamCore) window.__cadeBeamCore = api;
})(typeof self !== 'undefined' ? self : this);
