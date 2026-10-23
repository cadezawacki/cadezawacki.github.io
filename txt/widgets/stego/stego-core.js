/* Steganography — the pure part (no DOM): the hiding format, LSB embed /
 * extract, AES-GCM sealing, a small PNG encoder/decoder, file-format walkers
 * (PNG chunks, JPEG segments + EXIF, GIF blocks, RIFF, BMP) for metadata and
 * data appended after the end marker, the generic LSB scanner and scorer,
 * bit planes / histogram, and zero-width text stego.
 * Loaded by stego.js in the browser (window.__cadeStegoCore) and by
 * stego.test.js in node (module.exports). Needs TextEncoder, crypto.subtle
 * and (for compression / PNG) CompressionStream — all in Safari 16.4+ and
 * Node 18+.
 *
 * Our image format ("CSTG"): a 14-byte header — magic "CSTG", version 1,
 * flags, payload length (u32 BE), CRC-32 of the payload (u32 BE) — then the
 * payload, written into the least significant bit of R, G and B (never A),
 * MSB first. A "slot" is one channel of one pixel: slot k = pixel ⌊k/3⌋,
 * channel k mod 3.
 *  - No password: header + payload in slots 0, 1, 2, … in reading order; the
 *    payload is the UTF-8 text, deflated when that is smaller (flag COMP).
 *  - Password: payload = salt(16) | iv(12) | AES-GCM(deflated text) with a
 *    PBKDF2-SHA-256 key (flag ENC). The header stays in slots 0–111 (so the
 *    solver knows to ask for the password) but the payload goes to slots
 *    picked by a password-keyed permutation of the rest of the image
 *    (flag SCATTER), so no region of the LSB plane looks structured.
 *  - Password + "no marker" (flag STEALTH): the header goes through the
 *    permutation too; nothing tells the image apart from noise and only the
 *    password finds it.
 * The permutation is a 4-round Feistel network over ⌈log2 n⌉ bits with cycle
 * walking: a bijection on [0, n) in O(1) memory, so a 12-megapixel cover
 * needs no 36-million-entry shuffle table. */
(function (root) {
  'use strict';

  var MAGIC = [0x43, 0x53, 0x54, 0x47];          // "CSTG"
  var VERSION = 1, HEADER_BYTES = 14, HEADER_BITS = 112;
  var F_ENC = 1, F_COMP = 2, F_SCATTER = 4, F_STEALTH = 8;
  var PBKDF2_ITER = 210000, SALT = 16, IV = 12, TAG = 16;
  var ENC_OVERHEAD = SALT + IV + TAG;

  function subtle() {
    var c = (typeof crypto !== 'undefined' && crypto) || (root && root.crypto);
    if (!c || !c.subtle) throw new Error('This browser has no Web Crypto (needs a secure https page)');
    return c.subtle;
  }
  function randomBytes(n) {
    var a = new Uint8Array(n);
    (typeof crypto !== 'undefined' ? crypto : root.crypto).getRandomValues(a);
    return a;
  }

  // ---- bytes & text ----
  var enc = new TextEncoder();
  function utf8(s) { return enc.encode(String(s == null ? '' : s)); }
  function fromUtf8(b) { return new TextDecoder('utf-8').decode(b); }
  function concat() {
    var n = 0, i;
    for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; }
    return out;
  }
  function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function put32(b, o, v) { b[o] = v >>> 24 & 255; b[o + 1] = v >>> 16 & 255; b[o + 2] = v >>> 8 & 255; b[o + 3] = v & 255; }
  function hex(bytes, max) {
    var n = Math.min(bytes.length, max == null ? bytes.length : max), s = '';
    for (var i = 0; i < n; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }
  // classic hexdump: offset, 16 bytes, ASCII
  function hexdump(bytes, max, base) {
    var n = Math.min(bytes.length, max || 4096), lines = [];
    for (var o = 0; o < n; o += 16) {
      var h = '', a = '';
      for (var i = 0; i < 16; i++) {
        if (o + i < n) { var c = bytes[o + i]; h += (c < 16 ? '0' : '') + c.toString(16) + ' '; a += c >= 32 && c < 127 ? String.fromCharCode(c) : '.'; }
        else h += '   ';
        if (i === 7) h += ' ';
      }
      var off = ((base || 0) + o).toString(16);
      lines.push('00000000'.slice(off.length) + off + '  ' + h + ' ' + a);
    }
    return lines.join('\n');
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // ---- CRC-32 (PNG / zlib polynomial) ----
  var CRC_T = new Uint32Array(256);
  for (var ci = 0; ci < 256; ci++) { var cc = ci; for (var k = 0; k < 8; k++) cc = cc & 1 ? 0xEDB88320 ^ (cc >>> 1) : cc >>> 1; CRC_T[ci] = cc >>> 0; }
  function crc32(bytes, start, end, seed) {
    var c = seed == null ? 0xFFFFFFFF : seed;
    for (var i = start || 0, e = end == null ? bytes.length : end; i < e; i++) c = CRC_T[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---- deflate via (De)CompressionStream ('deflate' = zlib-wrapped) ----
  function canDeflate() { return typeof CompressionStream === 'function' && typeof Response === 'function' && typeof Blob === 'function'; }
  function pipe(bytes, ts) { return new Response(new Blob([bytes]).stream().pipeThrough(ts)).arrayBuffer().then(function (b) { return new Uint8Array(b); }); }
  function deflate(bytes) { return canDeflate() ? pipe(bytes, new CompressionStream('deflate')) : Promise.reject(new Error('no CompressionStream')); }
  function inflate(bytes, raw) {
    if (typeof DecompressionStream !== 'function') return Promise.reject(new Error('This browser can’t decompress (no DecompressionStream)'));
    return pipe(bytes, new DecompressionStream(raw ? 'deflate-raw' : 'deflate'));
  }

  // ---- AES-GCM with a PBKDF2-SHA-256 key ----
  function deriveKey(password, salt, iter) {
    var s = subtle();
    return s.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return s.deriveKey({ name: 'PBKDF2', salt: salt, iterations: iter || PBKDF2_ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }
  // → salt | iv | ciphertext+tag
  function seal(bytes, password, iter) {
    var salt = randomBytes(SALT), iv = randomBytes(IV);
    return deriveKey(password, salt, iter).then(function (key) {
      return subtle().encrypt({ name: 'AES-GCM', iv: iv }, key, bytes);
    }).then(function (ct) { return concat(salt, iv, new Uint8Array(ct)); });
  }
  // rejects with code 'wrong-password' when the tag doesn't verify
  function unseal(bytes, password, iter) {
    if (bytes.length < ENC_OVERHEAD) return Promise.reject(Object.assign(new Error('Too short to be encrypted data'), { code: 'damaged' }));
    var salt = bytes.subarray(0, SALT), iv = bytes.subarray(SALT, SALT + IV), ct = bytes.subarray(SALT + IV);
    return deriveKey(password, salt, iter).then(function (key) {
      return subtle().decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
    }).then(function (pt) { return new Uint8Array(pt); }, function (e) {
      if (e && e.code) throw e;
      throw Object.assign(new Error('Wrong password (or the image was changed)'), { code: 'wrong-password' });
    });
  }

  // ---- header ----
  function encodeHeader(flags, length, crc) {
    var h = new Uint8Array(HEADER_BYTES);
    h.set(MAGIC, 0); h[4] = VERSION; h[5] = flags & 255;
    put32(h, 6, length); put32(h, 10, crc >>> 0);
    return h;
  }
  function decodeHeader(h) {
    if (!h || h.length < HEADER_BYTES) return null;
    for (var i = 0; i < 4; i++) if (h[i] !== MAGIC[i]) return null;
    return { version: h[4], flags: h[5], length: u32(h, 6), crc: u32(h, 10), encrypted: !!(h[5] & F_ENC), compressed: !!(h[5] & F_COMP), scattered: !!(h[5] & F_SCATTER), stealth: !!(h[5] & F_STEALTH) };
  }

  // ---- capacity ----
  function slotCount(w, h) { return w * h * 3; }
  // payload bytes that fit after the header
  function capacity(w, h) { return Math.max(0, Math.floor((slotCount(w, h) - HEADER_BITS) / 8)); }
  // payload bytes needed for `innerLen` bytes of (possibly compressed) text
  function payloadSize(innerLen, encrypted) { return innerLen + (encrypted ? ENC_OVERHEAD : 0); }
  // the smallest w×h of the given aspect (w/h) that holds `bytes` of payload
  function minSizeFor(bytes, aspect) {
    var px = Math.ceil(((bytes * 8) + HEADER_BITS) / 3), a = aspect > 0 ? aspect : 1;
    var h = Math.ceil(Math.sqrt(px / a)), w = Math.ceil(h * a);
    while (w * h < px) h++;
    return { w: w, h: h };
  }


  // ---- keyed permutation of [0, n): a small bijection, O(1) memory ----
  // A 4-round Feistel network over the smallest even bit-width that covers n,
  // with cycle walking so the result stays inside [0, n). Deterministic from
  // the (seed, n) pair, so embed and extract agree.
  function mix32(h) {
    h = (h ^ (h >>> 16)) >>> 0; h = Math.imul(h, 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0; h = Math.imul(h, 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }
  function makePerm(n, seedBytes) {
    if (n <= 1) return { map: function (i) { return i; }, n: n };
    var bits = 0, m = n - 1; while (m > 0) { bits++; m >>>= 1; }
    if (bits & 1) bits++;                       // even number of bits → equal halves
    var half = bits >> 1, mask = (1 << half) - 1, size = 1 << bits;
    // four round keys from the seed bytes
    var ks = [0x9e3779b9, 0x7f4a7c15, 0x2545f491, 0x85ebca6b];
    var sb = seedBytes || [];
    for (var i = 0; i < sb.length; i++) ks[i & 3] = (Math.imul(ks[i & 3], 0x01000193) ^ sb[i]) >>> 0;
    for (var r = 0; r < 4; r++) ks[r] = mix32(ks[r]) >>> 0;
    function feistel(x) {
      var L = (x >>> half) & mask, R = x & mask;
      for (var rr = 0; rr < 4; rr++) {
        var f = mix32((R ^ ks[rr]) >>> 0) & mask;
        var nL = R, nR = (L ^ f) & mask;
        L = nL; R = nR;
      }
      return ((L << half) | R) >>> 0;
    }
    return {
      n: n,
      map: function (i) { var x = feistel(i); while (x >= n) x = feistel(x); return x; }  // cycle walking
    };
  }

  // ---- LSB read / write over a slot order ----
  // pixels: Uint8ClampedArray RGBA. slot k → byte index (channel R/G/B of pixel ⌊k/3⌋)
  function slotByte(k) { var p = (k / 3) | 0, ch = k - p * 3; return p * 4 + ch; }
  function writeBits(px, bytes, order, startSlot) {
    var bitPos = 0, total = bytes.length * 8, s = startSlot || 0;
    for (var b = 0; b < bytes.length; b++) {
      var v = bytes[b];
      for (var bit = 7; bit >= 0; bit--) {
        var slot = order ? order(s + bitPos) : (s + bitPos);
        var bi = slotByte(slot);
        px[bi] = (px[bi] & 0xFE) | ((v >>> bit) & 1);
        bitPos++;
      }
    }
    return total;
  }
  function readBits(px, byteLen, order, startSlot) {
    var out = new Uint8Array(byteLen), s = startSlot || 0;
    for (var b = 0; b < byteLen; b++) {
      var v = 0;
      for (var bit = 0; bit < 8; bit++) {
        var slot = order ? order(s + b * 8 + bit) : (s + b * 8 + bit);
        v = (v << 1) | (px[slotByte(slot)] & 1);
      }
      out[b] = v;
    }
    return out;
  }

  // ---- embed: build the payload, then write header + payload into pixels ----
  // text → { inner, flags } (compress and/or encrypt). Returns a Promise.
  function buildPayload(text, password, opts) {
    opts = opts || {};
    var raw = utf8(text), flags = 0;
    var step = (canDeflate() && raw.length >= 32 && opts.compress !== false)
      ? deflate(raw).then(function (d) { if (d.length < raw.length) { flags |= F_COMP; return d; } return raw; }).catch(function () { return raw; })
      : Promise.resolve(raw);
    return step.then(function (inner) {
      if (!password) return { inner: inner, flags: flags };
      return seal(inner, password, opts.iter).then(function (ct) { return { inner: ct, flags: flags | F_ENC | F_SCATTER | (opts.stealth ? F_STEALTH : 0) }; });
    });
  }
  // Write into an RGBA buffer in place. Returns { flags, payloadLen, crc, slotsUsed }.
  // seedBytes drives the scatter permutation (derive from the password outside).
  function embed(px, w, h, payload, flags, seedBytes) {
    var cap = capacity(w, h);
    if (payload.length > cap) { var e = new Error('The message needs ' + fmtBytes(payload.length) + ' but this image only holds ' + fmtBytes(cap) + '. Use a bigger image or a shorter message.'); e.code = 'too-big'; e.need = payload.length; e.cap = cap; throw e; }
    var crc = crc32(payload), header = encodeHeader(flags, payload.length, crc);
    var n = slotCount(w, h);
    if (flags & F_SCATTER) {
      // header in the first HEADER_BITS slots (unless stealth), payload scattered through the rest
      if (flags & F_STEALTH) {
        var perm = makePerm(n, seedBytes), all = concat(header, payload);
        writeBits(px, all, function (i) { return perm.map(i); }, 0);
      } else {
        writeBits(px, header, null, 0);
        var rest = n - HEADER_BITS, permP = makePerm(rest, seedBytes);
        writeBits(px, payload, function (i) { return HEADER_BITS + permP.map(i - HEADER_BITS); }, HEADER_BITS);
      }
    } else {
      writeBits(px, concat(header, payload), null, 0);
    }
    return { flags: flags, payloadLen: payload.length, crc: crc, slotsUsed: (header.length + payload.length) * 8 };
  }

  // Read our header from the start (sequential / scatter-with-header forms).
  function readHeaderSequential(px) { return decodeHeader(readBits(px, HEADER_BYTES, null, 0)); }
  // Read header assuming STEALTH (header itself permuted). seedBytes required.
  function readHeaderStealth(px, w, h, seedBytes) {
    var perm = makePerm(slotCount(w, h), seedBytes);
    return decodeHeader(readBits(px, HEADER_BYTES, function (i) { return perm.map(i); }, 0));
  }
  // Given a decoded header, pull the raw payload bytes out.
  function extractPayload(px, w, h, hdr, seedBytes) {
    var n = slotCount(w, h);
    if (hdr.stealth) {
      var perm = makePerm(n, seedBytes);
      return readBits(px, HEADER_BYTES + hdr.length, function (i) { return perm.map(i); }, 0).subarray(HEADER_BYTES);
    }
    if (hdr.scattered) {
      var rest = n - HEADER_BITS, permP = makePerm(rest, seedBytes);
      return readBits(px, hdr.length, function (i) { return HEADER_BITS + permP.map(i - HEADER_BITS); }, HEADER_BITS);
    }
    return readBits(px, hdr.length, null, HEADER_BITS);
  }

  // seed bytes for the permutation: SHA-256(password) truncated (sync-free via a cheap hash when no subtle)
  function seedFromPassword(password) {
    return subtle().digest('SHA-256', utf8(password)).then(function (d) { return new Uint8Array(d).subarray(0, 16); });
  }

  // payload bytes → text (inflate / decrypt as the flags say). Promise<string>.
  function decodePayload(payload, hdr, password) {
    var step;
    if (hdr.encrypted) {
      if (!password) { var e = new Error('This message is password-protected'); e.code = 'need-password'; return Promise.reject(e); }
      step = unseal(payload, password, undefined);
    } else step = Promise.resolve(payload);
    return step.then(function (inner) {
      if (hdr.compressed) return inflate(inner).then(fromUtf8, function () { return inflate(inner, true).then(fromUtf8); });
      return fromUtf8(inner);
    });
  }

  // Verify a payload against the header's CRC (plain payloads only — encrypted
  // ones are verified by the GCM tag instead).
  function crcOk(payload, hdr) { return hdr.encrypted || crc32(payload) === hdr.crc; }

  // ---- a minimal PNG encoder: RGBA, 8-bit, one IDAT, zlib(deflate) ----
  // Lossless, so the LSBs survive a round trip. Needs CompressionStream.
  function encodePNG(px, w, h) {
    // filter type 0 per scanline
    var stride = w * 4, raw = new Uint8Array((stride + 1) * h);
    for (var y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; raw.set(px.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1); }
    return deflate(raw).then(function (idat) {
      function chunk(type, data) {
        var t = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
        var body = new Uint8Array(4 + data.length); body.set(t, 0); body.set(data, 4);
        var out = new Uint8Array(12 + data.length);
        put32(out, 0, data.length); out.set(body, 4); put32(out, 8 + data.length, crc32(body));
        return out;
      }
      var sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      var ihdr = new Uint8Array(13);
      put32(ihdr, 0, w); put32(ihdr, 4, h); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;  // 8-bit RGBA
      return concat(sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
    });
  }

  // ---- PNG chunk walk (metadata + where IEND ends) ----
  function isPNG(b) { return b.length > 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71; }
  function latin1(b, s, e) { var o = ''; for (var i = s; i < e; i++) o += String.fromCharCode(b[i]); return o; }
  function parsePNGChunks(b) {
    var out = { chunks: [], text: [], iendEnd: -1 }, o = 8;
    while (o + 8 <= b.length) {
      var len = u32(b, o), type = latin1(b, o + 4, o + 8), ds = o + 8, de = ds + len;
      if (len < 0 || de + 4 > b.length) break;
      out.chunks.push({ type: type, length: len, offset: o });
      if (type === 'tEXt') {
        var z = ds; while (z < de && b[z] !== 0) z++;
        out.text.push({ kind: 'tEXt', keyword: latin1(b, ds, z), value: latin1(b, z + 1, de) });
      } else if (type === 'iTXt') {
        var p = ds; while (p < de && b[p] !== 0) p++;
        var key = latin1(b, ds, p), comp = b[p + 1]; p += 3;              // skip null, compressionFlag, compressionMethod
        var ls = p; while (p < de && b[p] !== 0) p++; p++;                 // language tag
        var ts = p; while (p < de && b[p] !== 0) p++; p++;                 // translated keyword
        out.text.push({ kind: 'iTXt', keyword: key, value: comp ? '(compressed)' : fromUtf8(b.subarray(p, de)) });
      } else if (type === 'zTXt') {
        var zz = ds; while (zz < de && b[zz] !== 0) zz++;
        out.text.push({ kind: 'zTXt', keyword: latin1(b, ds, zz), value: '(deflate-compressed)', raw: b.subarray(zz + 2, de) });
      }
      o = de + 4;                                                          // skip CRC
      if (type === 'IEND') { out.iendEnd = o; break; }
    }
    return out;
  }

  // ---- JPEG segment walk: EXIF, comments, and end (FFD9) ----
  function isJPEG(b) { return b.length > 3 && b[0] === 0xFF && b[1] === 0xD8; }
  function parseJPEG(b) {
    var out = { segments: [], text: [], endOffset: -1 }, o = 2;
    while (o + 1 < b.length) {
      if (b[o] !== 0xFF) { o++; continue; }
      var marker = b[o + 1];
      if (marker === 0xD9) { out.endOffset = o + 2; break; }                 // EOI
      if (marker === 0xDA) {                                                  // SOS → scan data to EOI
        var s = o + 2; while (s + 1 < b.length && !(b[s] === 0xFF && b[s + 1] === 0xD9)) s++;
        out.endOffset = s + 1 < b.length ? s + 2 : b.length; break;
      }
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { o += 2; continue; }
      var len = (b[o + 2] << 8) | b[o + 3], ds = o + 4, de = o + 2 + len;
      out.segments.push({ marker: marker, length: len, offset: o });
      if (marker === 0xFE) out.text.push({ kind: 'COM', value: fromUtf8(b.subarray(ds, de)) });
      else if (marker === 0xE1 && latin1(b, ds, ds + 4) === 'Exif') out.text = out.text.concat(parseExif(b.subarray(ds + 6, de)));
      o = de;
    }
    return out;
  }
  // TIFF/EXIF IFD0: pull ASCII string tags (sufficient for CTF "strings in EXIF")
  function parseExif(t) {
    var out = [];
    try {
      if (t.length < 8) return out;
      var le = t[0] === 0x49;
      var rd16 = function (o) { return le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]; };
      var rd32 = function (o) { return (le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3])) >>> 0; };
      var ifd = rd32(4);
      var TAGS = { 0x010E: 'ImageDescription', 0x010F: 'Make', 0x0110: 'Model', 0x0131: 'Software', 0x013B: 'Artist', 0x8298: 'Copyright', 0x9286: 'UserComment' };
      for (var pass = 0; pass < 2 && ifd && ifd + 2 <= t.length; pass++) {
        var count = rd16(ifd), next = ifd + 2;
        for (var i = 0; i < count; i++) {
          var e = next + i * 12, tag = rd16(e), typ = rd16(e + 2), num = rd32(e + 4);
          if (typ === 2 && TAGS[tag]) {                                      // ASCII
            var vo = num <= 4 ? e + 8 : rd32(e + 8), str = latin1(t, vo, Math.min(t.length, vo + num)).replace(/\0+$/, '');
            if (str.trim()) out.push({ kind: 'EXIF:' + TAGS[tag], value: str });
          }
        }
        ifd = rd32(next + count * 12);                                        // IFD1 (thumbnail) link
      }
    } catch (e) {}
    return out;
  }

  // ---- other containers' end markers, for appended data ----
  function isGIF(b) { return b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46; }
  function gifEnd(b) { for (var i = b.length - 1; i >= 0; i--) if (b[i] === 0x3B) return i + 1; return -1; }
  function isBMP(b) { return b.length > 6 && b[0] === 0x42 && b[1] === 0x4D; }
  function bmpEnd(b) { return u32LE(b, 2); }
  function u32LE(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  // Data after the logical end of the file (a common CTF trick).
  function appendedData(b) {
    var end = -1, kind = '';
    if (isPNG(b)) { end = parsePNGChunks(b).iendEnd; kind = 'PNG'; }
    else if (isJPEG(b)) { end = parseJPEG(b).endOffset; kind = 'JPEG'; }
    else if (isGIF(b)) { end = gifEnd(b); kind = 'GIF'; }
    else if (isBMP(b)) { var sz = bmpEnd(b); end = (sz > 0 && sz <= b.length) ? sz : -1; kind = 'BMP'; }
    if (end < 0 || end >= b.length) return null;
    return { kind: kind, offset: end, length: b.length - end, bytes: b.subarray(end) };
  }

  // ---- "strings": runs of printable bytes ≥ min ----
  function strings(b, min, max) {
    min = min || 4; var out = [], cur = '', off = 0;
    for (var i = 0; i < b.length; i++) {
      var c = b[i];
      if (c >= 32 && c < 127) { if (!cur) off = i; cur += String.fromCharCode(c); }
      else { if (cur.length >= min) { out.push({ offset: off, text: cur }); if (max && out.length >= max) return out; } cur = ''; }
    }
    if (cur.length >= min) out.push({ offset: off, text: cur });
    return out;
  }

  // ---- printable "looks like text" score ----
  // Fraction printable, nudged up for spaces/common letters, down for control
  // noise. 0..1; ~0.95+ for real English, ~0.4 for random bytes.
  function textScore(bytes) {
    if (!bytes.length) return 0;
    var printable = 0, letters = 0, spaces = 0, control = 0, n = bytes.length;
    for (var i = 0; i < n; i++) {
      var c = bytes[i];
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters++;
      else if (c === 32) spaces++;
      else if (c < 9 || (c > 13 && c < 32)) control++;
    }
    var score = printable / n;
    score += Math.min(0.15, (letters + spaces) / n * 0.2);
    score -= Math.min(0.5, control / n * 2);
    return Math.max(0, Math.min(1, score));
  }

  // Generic LSB extractor over configurable channels / order / bit / plane.
  // channels: array of 0..3 (R,G,B,A). order: 'row' | 'col'. bit: 0..7.
  // maxBytes caps work. Returns Uint8Array of packed bits (MSB first).
  function lsbExtract(px, w, h, opts) {
    opts = opts || {};
    var channels = opts.channels || [0, 1, 2], bit = opts.bit == null ? 0 : opts.bit;
    var order = opts.order || 'row', msbFirst = opts.msbFirst !== false;
    var maxBytes = opts.maxBytes || 4096, maxBits = maxBytes * 8;
    var out = [], acc = 0, nb = 0, cnt = 0;
    function take(v) {
      if (msbFirst) acc = (acc << 1) | v; else acc |= v << nb;
      nb++; if (nb === 8) { out.push(acc & 255); acc = 0; nb = 0; } cnt++;
    }
    if (order === 'col') {
      for (var x = 0; x < w && cnt < maxBits; x++)
        for (var y = 0; y < h && cnt < maxBits; y++) { var p = (y * w + x) * 4; for (var c = 0; c < channels.length; c++) take((px[p + channels[c]] >>> bit) & 1); }
    } else {
      for (var yy = 0; yy < h && cnt < maxBits; yy++)
        for (var xx = 0; xx < w && cnt < maxBits; xx++) { var pp = (yy * w + xx) * 4; for (var cc = 0; cc < channels.length; cc++) take((px[pp + channels[cc]] >>> bit) & 1); }
    }
    if (nb) out.push((acc << (8 - nb)) & 255);
    return new Uint8Array(out);
  }

  // Auto-try common LSB combinations, ranked by printable score.
  function lsbAutoTry(px, w, h, maxBytes) {
    var combos = [], CH = [[0, 1, 2], [0], [1], [2], [3], [0, 1, 2, 3]], names = { '0': 'R', '1': 'G', '2': 'B', '3': 'A' };
    ['row', 'col'].forEach(function (order) {
      CH.forEach(function (channels) {
        [0, 1].forEach(function (bit) {
          var bytes = lsbExtract(px, w, h, { channels: channels, order: order, bit: bit, maxBytes: maxBytes || 1024 });
          combos.push({ channels: channels, order: order, bit: bit, score: textScore(bytes), label: channels.map(function (c) { return names[c]; }).join('') + ' · ' + order + ' · bit ' + bit, sample: previewText(bytes, 160) });
        });
      });
    });
    combos.sort(function (a, b) { return b.score - a.score; });
    return combos;
  }
  function previewText(bytes, max) {
    var s = '', n = Math.min(bytes.length, max || 240);
    for (var i = 0; i < n; i++) { var c = bytes[i]; s += (c === 10 || c === 9 || (c >= 32 && c < 127)) ? String.fromCharCode(c) : '·'; }
    return s;
  }

  // One bit-plane as a 1-bit-per-pixel grayscale (returns RGBA for a canvas).
  function bitPlane(px, w, h, channel, bit) {
    var out = new Uint8ClampedArray(w * h * 4);
    for (var i = 0, p = 0; i < w * h; i++, p += 4) {
      var v = ((px[p + channel] >>> bit) & 1) ? 255 : 0;
      out[p] = out[p + 1] = out[p + 2] = v; out[p + 3] = 255;
    }
    return out;
  }

  // Histogram of one channel (256 buckets) and a pixel read-out.
  function histogram(px, w, h, channel) {
    var hist = new Uint32Array(256);
    for (var p = channel; p < px.length; p += 4) hist[px[p]]++;
    return hist;
  }
  function pixelAt(px, w, x, y) { var p = (y * w + x) * 4; return { r: px[p], g: px[p + 1], b: px[p + 2], a: px[p + 3] }; }

  // Amplified difference between two RGBA buffers (for the invisible-diff view).
  function diffAmplified(a, b, gain) {
    gain = gain || 32; var out = new Uint8ClampedArray(a.length);
    for (var i = 0; i < a.length; i += 4) {
      for (var c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.abs(a[i + c] - b[i + c]) * gain);
      out[i + 3] = 255;
    }
    return out;
  }

  // ---- zero-width text stego ----
  // Encodes the hidden message's UTF-8 bytes as bits, each bit a zero-width
  // char (ZWSP=0, ZWNJ=1), bracketed by a ZWJ sentinel so reveal can find it.
  // The carrier text is untouched; the hidden run is appended (or inserted).
  var ZW0 = '​', ZW1 = '‌', ZWMARK = '⁠';   // ZWSP, ZWNJ, WORD JOINER sentinel
  function zwEncode(carrier, secret) {
    var bytes = utf8(secret), bits = '';
    for (var i = 0; i < bytes.length; i++) for (var b = 7; b >= 0; b--) bits += (bytes[i] >>> b) & 1;
    var hidden = ZWMARK; for (var j = 0; j < bits.length; j++) hidden += bits[j] === '1' ? ZW1 : ZW0; hidden += ZWMARK;
    return (carrier == null ? '' : carrier) + hidden;
  }
  function zwHas(text) { return typeof text === 'string' && text.indexOf(ZWMARK) >= 0; }
  function zwDecode(text) {
    if (!text) return null;
    var s = text.indexOf(ZWMARK); if (s < 0) return null;
    var e = text.indexOf(ZWMARK, s + 1); if (e < 0) e = text.length;
    var bits = '';
    for (var i = s + 1; i < e; i++) { var ch = text[i]; if (ch === ZW0) bits += '0'; else if (ch === ZW1) bits += '1'; }
    if (bits.length < 8) return null;
    var nbytes = bits.length >> 3, out = new Uint8Array(nbytes);
    for (var k = 0; k < nbytes; k++) out[k] = parseInt(bits.substr(k * 8, 8), 2);
    try { return fromUtf8(out); } catch (x) { return null; }
  }
  function zwStrip(text) { return text == null ? '' : text.replace(/[​‌⁠]/g, ''); }

  // ---- generated covers (so it works with no photo) ----
  function makeCover(w, h, kind, seed) {
    var px = new Uint8ClampedArray(w * h * 4), s = seed >>> 0 || 1;
    function rnd() { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }
    var c1 = [40 + (rnd() * 120 | 0), 40 + (rnd() * 120 | 0), 80 + (rnd() * 120 | 0)];
    var c2 = [120 + (rnd() * 120 | 0), 60 + (rnd() * 120 | 0), 120 + (rnd() * 120 | 0)];
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var p = (y * w + x) * 4, t;
      if (kind === 'radial') { var dx = x / w - 0.5, dy = y / h - 0.5; t = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.8); }
      else if (kind === 'diagonal') t = (x + y) / (w + h);
      else t = y / h;                                                        // linear vertical
      // a touch of ordered noise so flat gradients still carry bits well
      var nz = ((x * 13 + y * 7) & 3) - 1.5;
      px[p] = Math.max(0, Math.min(255, c1[0] + (c2[0] - c1[0]) * t + nz));
      px[p + 1] = Math.max(0, Math.min(255, c1[1] + (c2[1] - c1[1]) * t + nz));
      px[p + 2] = Math.max(0, Math.min(255, c1[2] + (c2[2] - c1[2]) * t + nz));
      px[p + 3] = 255;
    }
    return px;
  }

  // ---- high-level: hide text into an RGBA buffer (in place) ----
  // Returns Promise<{ flags, payloadLen, cap, used }>. Throws 'too-big' (via
  // embed) when it won't fit. Derives the scatter seed from the password.
  function hide(px, w, h, text, password, opts) {
    opts = opts || {};
    return buildPayload(text, password, opts).then(function (built) {
      var seedStep = password ? seedFromPassword(password) : Promise.resolve(null);
      return seedStep.then(function (seed) {
        var info = embed(px, w, h, built.inner, built.flags, seed);
        return { flags: info.flags, payloadLen: info.payloadLen, cap: capacity(w, h), used: info.slotsUsed };
      });
    });
  }
  // ---- high-level: reveal our format from an RGBA buffer ----
  // Returns Promise<{ ok, header, text }>. Rejects with code 'none' (no CSTG
  // header found without a password), 'need-password', 'wrong-password',
  // 'damaged'. With a password it also tries the stealth (header-permuted) form.
  function reveal(px, w, h, password) {
    var hdr = readHeaderSequential(px);
    function finish(hdr, seed) {
      var payload = extractPayload(px, w, h, hdr, seed);
      if (!crcOk(payload, hdr)) { var e = new Error('Checksum failed — the hidden data looks damaged (was the image recompressed?)'); e.code = 'damaged'; throw e; }
      return decodePayload(payload, hdr, password).then(function (text) { return { ok: true, header: hdr, text: text }; });
    }
    if (hdr) {
      if (hdr.encrypted && !password) { var e = new Error('This message is password-protected'); e.code = 'need-password'; return Promise.reject(e); }
      var seedStep = hdr.scattered && password ? seedFromPassword(password) : Promise.resolve(null);
      return seedStep.then(function (seed) { return finish(hdr, seed); });
    }
    // no plain header — if a password is given, try the stealth form
    if (password) return seedFromPassword(password).then(function (seed) {
      var sh = readHeaderStealth(px, w, h, seed);
      if (!sh) { var e = new Error('No hidden message in our format found (wrong password, or none here)'); e.code = 'wrong-password'; throw e; }
      return finish(sh, seed);
    });
    var e2 = new Error('No hidden message in our format found'); e2.code = 'none'; return Promise.reject(e2);
  }

  var api = {
    hide: hide, reveal: reveal,
    MAGIC: MAGIC, VERSION: VERSION, HEADER_BYTES: HEADER_BYTES, HEADER_BITS: HEADER_BITS,
    F_ENC: F_ENC, F_COMP: F_COMP, F_SCATTER: F_SCATTER, F_STEALTH: F_STEALTH,
    // bytes / text
    utf8: utf8, fromUtf8: fromUtf8, concat: concat, hex: hex, hexdump: hexdump, fmtBytes: fmtBytes,
    crc32: crc32,
    // compression / crypto
    canDeflate: canDeflate, deflate: deflate, inflate: inflate, seal: seal, unseal: unseal, deriveKey: deriveKey, seedFromPassword: seedFromPassword,
    // our format
    encodeHeader: encodeHeader, decodeHeader: decodeHeader,
    capacity: capacity, slotCount: slotCount, payloadSize: payloadSize, minSizeFor: minSizeFor,
    makePerm: makePerm, writeBits: writeBits, readBits: readBits, slotByte: slotByte,
    buildPayload: buildPayload, embed: embed, decodePayload: decodePayload, crcOk: crcOk,
    readHeaderSequential: readHeaderSequential, readHeaderStealth: readHeaderStealth, extractPayload: extractPayload,
    // PNG
    encodePNG: encodePNG, isPNG: isPNG, parsePNGChunks: parsePNGChunks,
    // other formats
    isJPEG: isJPEG, parseJPEG: parseJPEG, parseExif: parseExif, isGIF: isGIF, isBMP: isBMP, appendedData: appendedData, strings: strings,
    // generic analysis
    textScore: textScore, lsbExtract: lsbExtract, lsbAutoTry: lsbAutoTry, previewText: previewText,
    bitPlane: bitPlane, histogram: histogram, pixelAt: pixelAt, diffAmplified: diffAmplified,
    // zero-width
    zwEncode: zwEncode, zwDecode: zwDecode, zwHas: zwHas, zwStrip: zwStrip,
    // covers
    makeCover: makeCover
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__cadeStegoCore = api;
})(typeof window !== 'undefined' ? window : this);
