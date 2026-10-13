/* Decode Lab engine — decoders, classical ciphers, language scoring, text
 * analysis and the decoder-chain search.
 *
 * Pure and self-contained ON PURPOSE: the UI stringifies the whole factory
 * (Function.prototype.toString) into a Blob Web Worker, so nothing in here may
 * reference anything outside DecodeLabCore. Runs in node for the unit tests:
 *   var core = require('./decodelab-core.js')();
 *   core.setData(require('./decodelab-data.js'));
 * No network, no DOM. ES5 + typed arrays + TextDecoder (feature-detected). */
(function (root) {
  'use strict';

  function DecodeLabCore() {
    'use strict';

    // ===================================================================
    // Small utilities
    // ===================================================================
    var UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', LO = 'abcdefghijklmnopqrstuvwxyz';
    function mod(a, n) { return ((a % n) + n) % n; }
    function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = a % b; a = b; b = t; } return a; }
    function modInv(a, m) { a = mod(a, m); for (var x = 1; x < m; x++) if ((a * x) % m === 1) return x; return -1; }
    function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
    function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
    function isBytes(v) { return v instanceof Uint8Array; }
    function chars(s) { return Array.from ? Array.from(s) : s.split(''); }
    function fromCP(cp) {
      if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
      if (cp < 0x10000) return String.fromCharCode(cp);
      cp -= 0x10000;
      return String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    }
    function err(msg) { var e = new Error(msg); e.decodeLab = true; return e; }
    function letterIdx(c) { // A-Z / a-z -> 0..25, else -1
      var k = c.charCodeAt(0);
      if (k >= 65 && k <= 90) return k - 65;
      if (k >= 97 && k <= 122) return k - 97;
      return -1;
    }
    function lettersOnly(s) { return s.toUpperCase().replace(/[^A-Z]/g, ''); }

    // ===================================================================
    // Bytes <-> text
    // ===================================================================
    var TE = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    function utf8Encode(s) {
      if (TE) return TE.encode(s);
      var out = [], i = 0;
      for (; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
          var d = s.charCodeAt(i + 1);
          if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
        }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | c >> 6, 0x80 | c & 63);
        else if (c < 0x10000) out.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
        else out.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
      }
      return new Uint8Array(out);
    }
    // Strict UTF-8 -> string, or null when the bytes are not valid UTF-8.
    function utf8Strict(b) {
      var out = '', i = 0, n = b.length, chunk = [];
      while (i < n) {
        var c = b[i], cp, need;
        if (c < 0x80) { cp = c; need = 0; }
        else if (c >= 0xc2 && c <= 0xdf) { cp = c & 31; need = 1; }
        else if (c >= 0xe0 && c <= 0xef) { cp = c & 15; need = 2; }
        else if (c >= 0xf0 && c <= 0xf4) { cp = c & 7; need = 3; }
        else return null;
        for (var k = 1; k <= need; k++) {
          var d = b[i + k];
          if (d === undefined || (d & 0xc0) !== 0x80) return null;
          cp = (cp << 6) | (d & 63);
        }
        if ((need === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) || (need === 3 && (cp < 0x10000 || cp > 0x10ffff))) return null;
        i += need + 1;
        if (cp < 0x10000) chunk.push(cp);
        else { cp -= 0x10000; chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); }
        if (chunk.length >= 8192) { out += String.fromCharCode.apply(null, chunk); chunk = []; }
      }
      return out + String.fromCharCode.apply(null, chunk);
    }
    function utf8Lenient(b) {
      var s = utf8Strict(b);
      if (s !== null) return s;
      var dd = getDecoder('utf-8', false);
      return dd ? dd.decode(b) : latin1(b);
    }
    function latin1(b) {
      var out = '';
      for (var i = 0; i < b.length; i += 8192) out += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
      return out;
    }
    function latin1Bytes(s) {
      var b = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
      return b;
    }
    // Text -> bytes for byte-level ops: Latin-1 when every char fits a byte
    // (keeps "binary strings" intact), UTF-8 otherwise.
    function textToBytes(s) { return /[^\x00-\xff]/.test(s) ? utf8Encode(s) : latin1Bytes(s); }
    function toHex(b, sep) {
      var h = [];
      for (var i = 0; i < b.length; i++) h.push((b[i] < 16 ? '0' : '') + b[i].toString(16));
      return h.join(sep || '');
    }
    function concatBytes(list) {
      var n = 0, i; for (i = 0; i < list.length; i++) n += list[i].length;
      var o = new Uint8Array(n), p = 0;
      for (i = 0; i < list.length; i++) { o.set(list[i], p); p += list[i].length; }
      return o;
    }

    // Legacy charsets through TextDecoder (feature-detected: older engines
    // may lack some labels; a missing one is simply skipped).
    var CHARSETS = [
      ['utf-8', 'UTF-8'], ['utf-16le', 'UTF-16LE'], ['utf-16be', 'UTF-16BE'],
      ['windows-1252', 'Windows-1252 / Latin-1'], ['windows-1250', 'Windows-1250 (Central Europe)'],
      ['windows-1251', 'Windows-1251 (Cyrillic)'], ['koi8-r', 'KOI8-R (Cyrillic)'],
      ['iso-8859-7', 'ISO-8859-7 (Greek)'], ['windows-1253', 'Windows-1253 (Greek)'],
      ['windows-1255', 'Windows-1255 (Hebrew)'], ['windows-1256', 'Windows-1256 (Arabic)'],
      ['shift_jis', 'Shift-JIS (Japanese)'], ['euc-jp', 'EUC-JP (Japanese)'],
      ['gbk', 'GBK (Chinese)'], ['big5', 'Big5 (Chinese)'], ['euc-kr', 'EUC-KR (Korean)'],
      ['ibm866', 'CP866 (DOS Cyrillic)'], ['macintosh', 'Mac Roman'],
    ];
    var decCache = {};
    function getDecoder(label, fatal) {
      var k = label + (fatal ? '!' : '');
      if (decCache[k] !== undefined) return decCache[k];
      var d = null;
      try { if (typeof TextDecoder !== 'undefined') d = new TextDecoder(label, { fatal: !!fatal }); } catch (e) { d = null; }
      decCache[k] = d;
      return d;
    }
    function decodeCharset(b, label, fatal) {
      if (label === 'utf-8' && fatal) return utf8Strict(b);
      if (label === 'utf-16le' || label === 'utf-16be') return utf16(b, label === 'utf-16be', fatal);
      var d = getDecoder(label, fatal);
      if (!d) { if (label === 'windows-1252' || label === 'iso-8859-1') return latin1(b); return null; }
      try { return d.decode(b); } catch (e) { return null; }
    }
    function utf16(b, be, fatal) {
      if (b.length % 2) { if (fatal) return null; b = b.subarray(0, b.length - 1); }
      var start = 0;
      if (b.length >= 2 && ((be && b[0] === 0xfe && b[1] === 0xff) || (!be && b[0] === 0xff && b[1] === 0xfe))) start = 2;
      var units = [];
      for (var i = start; i < b.length; i += 2) units.push(be ? (b[i] << 8) | b[i + 1] : b[i] | (b[i + 1] << 8));
      if (fatal) {
        for (var j = 0; j < units.length; j++) {
          var u = units[j];
          if (u >= 0xd800 && u < 0xdc00) { var v = units[j + 1]; if (!(v >= 0xdc00 && v < 0xe000)) return null; j++; }
          else if (u >= 0xdc00 && u < 0xe000) return null;
        }
      }
      var out = '';
      for (var k = 0; k < units.length; k += 8192) out += String.fromCharCode.apply(null, units.slice(k, k + 8192));
      return out;
    }
    function supportedCharsets() {
      return CHARSETS.filter(function (c) { return c[0].indexOf('utf-') === 0 || !!getDecoder(c[0], false); });
    }

    // File signatures — lets byte results be named ("PNG image").
    var MAGIC = [
      [[0x89, 0x50, 0x4e, 0x47], 'PNG image', 'png'], [[0xff, 0xd8, 0xff], 'JPEG image', 'jpg'],
      [[0x47, 0x49, 0x46, 0x38], 'GIF image', 'gif'], [[0x25, 0x50, 0x44, 0x46], 'PDF document', 'pdf'],
      [[0x50, 0x4b, 0x03, 0x04], 'ZIP archive (or docx/xlsx/jar/apk)', 'zip'], [[0x1f, 0x8b], 'gzip data', 'gz'],
      [[0x42, 0x5a, 0x68], 'bzip2 data', 'bz2'], [[0x37, 0x7a, 0xbc, 0xaf], '7-Zip archive', '7z'],
      [[0x52, 0x61, 0x72, 0x21], 'RAR archive', 'rar'], [[0x7f, 0x45, 0x4c, 0x46], 'ELF executable', 'elf'],
      [[0x4d, 0x5a], 'Windows executable (MZ)', 'exe'], [[0x25, 0x21, 0x50, 0x53], 'PostScript', 'ps'],
      [[0x49, 0x44, 0x33], 'MP3 audio (ID3)', 'mp3'], [[0x4f, 0x67, 0x67, 0x53], 'Ogg media', 'ogg'],
      [[0x66, 0x4c, 0x61, 0x43], 'FLAC audio', 'flac'], [[0x53, 0x51, 0x4c, 0x69, 0x74, 0x65], 'SQLite database', 'sqlite'],
      [[0x00, 0x00, 0x01, 0x00], 'Windows icon', 'ico'], [[0x42, 0x4d], 'BMP image', 'bmp'],
      [[0x77, 0x4f, 0x46, 0x46], 'WOFF font', 'woff'], [[0x77, 0x4f, 0x46, 0x32], 'WOFF2 font', 'woff2'],
      [[0x00, 0x61, 0x73, 0x6d], 'WebAssembly module', 'wasm'], [[0xca, 0xfe, 0xba, 0xbe], 'Java class / Mach-O fat', 'class'],
      [[0x28, 0xb5, 0x2f, 0xfd], 'Zstandard data', 'zst'], [[0xfd, 0x37, 0x7a, 0x58, 0x5a], 'XZ data', 'xz'],
    ];
    function magic(b) {
      if (!b || b.length < 4) return null;
      for (var i = 0; i < MAGIC.length; i++) {
        var m = MAGIC[i][0], ok = true;
        for (var j = 0; j < m.length; j++) if (b[j] !== m[j]) { ok = false; break; }
        if (ok) {
          if (MAGIC[i][2] === 'bmp' && b.length < 26) continue;
          if (MAGIC[i][2] === 'exe' && b.length < 64) continue;
          return { name: MAGIC[i][1], ext: MAGIC[i][2] };
        }
      }
      if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) {
        var t = String.fromCharCode(b[8], b[9], b[10], b[11]);
        return { name: t === 'WEBP' ? 'WebP image' : t === 'WAVE' ? 'WAV audio' : t === 'AVI ' ? 'AVI video' : 'RIFF data', ext: t === 'WEBP' ? 'webp' : t === 'WAVE' ? 'wav' : 'riff' };
      }
      if (b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return { name: 'MP4 / MOV / HEIC media', ext: 'mp4' };
      return null;
    }

    // ===================================================================
    // DEFLATE (RFC 1951) inflater + gzip / zlib wrappers. Synchronous and
    // dependency-free, so it works everywhere (no DecompressionStream needed,
    // which older iOS lacks) and inside the search loop.
    // ===================================================================
    var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    var CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    function huff(lengths, n) {
      var counts = new Uint16Array(16), offs = new Uint16Array(16), syms = new Uint16Array(n), i;
      for (i = 0; i < n; i++) counts[lengths[i]]++;
      counts[0] = 0;
      for (i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
      for (i = 0; i < n; i++) if (lengths[i]) syms[offs[lengths[i]]++] = i;
      return { counts: counts, syms: syms };
    }
    function inflateRaw(src, maxOut) {
      maxOut = maxOut || 64 * 1024 * 1024;
      var pos = 0, bit = 0, bitCnt = 0, out = new Uint8Array(Math.max(1024, src.length * 4)), op = 0;
      function need(n) {
        while (bitCnt < n) {
          if (pos >= src.length) throw err('deflate: unexpected end');
          bit |= src[pos++] << bitCnt; bitCnt += 8;
        }
      }
      function bits(n) { need(n); var v = bit & ((1 << n) - 1); bit >>>= n; bitCnt -= n; return v; }
      function decodeSym(h) {
        var code = 0, first = 0, index = 0;
        for (var len = 1; len < 16; len++) {
          code |= bits(1);
          var count = h.counts[len];
          if (code - count < first) return h.syms[index + (code - first)];
          index += count; first += count; first <<= 1; code <<= 1;
        }
        throw err('deflate: bad code');
      }
      function grow(n) {
        if (op + n <= out.length) return;
        if (op + n > maxOut) throw err('deflate: output too large');
        var o2 = new Uint8Array(Math.max(out.length * 2, op + n));
        o2.set(out); out = o2;
      }
      var fixedL = null, fixedD = null, final = 0;
      do {
        final = bits(1);
        var type = bits(2);
        if (type === 0) {
          bit = 0; bitCnt = 0;
          if (pos + 4 > src.length) throw err('deflate: bad stored block');
          var len = src[pos] | (src[pos + 1] << 8), nlen = src[pos + 2] | (src[pos + 3] << 8);
          if ((len ^ 0xffff) !== nlen) throw err('deflate: bad stored length');
          pos += 4;
          if (pos + len > src.length) throw err('deflate: truncated');
          grow(len); out.set(src.subarray(pos, pos + len), op); op += len; pos += len;
          continue;
        }
        var lh, dh;
        if (type === 1) {
          if (!fixedL) {
            var l = new Uint8Array(288), i;
            for (i = 0; i < 144; i++) l[i] = 8;
            for (; i < 256; i++) l[i] = 9;
            for (; i < 280; i++) l[i] = 7;
            for (; i < 288; i++) l[i] = 8;
            fixedL = huff(l, 288);
            var d = new Uint8Array(30); for (i = 0; i < 30; i++) d[i] = 5;
            fixedD = huff(d, 30);
          }
          lh = fixedL; dh = fixedD;
        } else if (type === 2) {
          var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
          var cl = new Uint8Array(19);
          for (var q = 0; q < hclen; q++) cl[CL_ORDER[q]] = bits(3);
          var clh = huff(cl, 19), lens = new Uint8Array(hlit + hdist), k = 0;
          while (k < hlit + hdist) {
            var sym = decodeSym(clh);
            if (sym < 16) lens[k++] = sym;
            else {
              var rep = 0, val = 0;
              if (sym === 16) { if (!k) throw err('deflate: bad repeat'); val = lens[k - 1]; rep = 3 + bits(2); }
              else if (sym === 17) rep = 3 + bits(3);
              else rep = 11 + bits(7);
              if (k + rep > hlit + hdist) throw err('deflate: bad lengths');
              while (rep--) lens[k++] = val;
            }
          }
          lh = huff(lens.subarray(0, hlit), hlit); dh = huff(lens.subarray(hlit), hdist);
        } else throw err('deflate: bad block type');
        for (;;) {
          var s = decodeSym(lh);
          if (s < 256) { grow(1); out[op++] = s; }
          else if (s === 256) break;
          else {
            s -= 257;
            if (s >= 29) throw err('deflate: bad length');
            var ln = LEN_BASE[s] + bits(LEN_EXTRA[s]);
            var ds = decodeSym(dh);
            if (ds >= 30) throw err('deflate: bad distance');
            var dist = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
            if (dist > op) throw err('deflate: distance too far');
            grow(ln);
            for (var z = 0; z < ln; z++) { out[op] = out[op - dist]; op++; }
          }
        }
      } while (!final);
      return { data: out.subarray(0, op), used: pos };
    }
    function gunzip(b) {
      if (b.length < 18 || b[0] !== 0x1f || b[1] !== 0x8b || b[2] !== 8) throw err('not gzip');
      var flg = b[3], p = 10;
      if (flg & 4) p += 2 + (b[p] | (b[p + 1] << 8));
      if (flg & 8) { while (p < b.length && b[p]) p++; p++; }
      if (flg & 16) { while (p < b.length && b[p]) p++; p++; }
      if (flg & 2) p += 2;
      return inflateRaw(b.subarray(p)).data;
    }
    function isZlib(b) { return b.length > 2 && (b[0] & 15) === 8 && (b[0] >> 4) <= 7 && ((b[0] << 8) | b[1]) % 31 === 0; }
    function unzlib(b) {
      if (!isZlib(b)) throw err('not zlib');
      if (b[1] & 32) throw err('zlib preset dictionary');
      return inflateRaw(b.subarray(2)).data;
    }
    // Stored-block deflate (valid output for tests / encode direction).
    function deflateStored(b) {
      var parts = [], i = 0;
      do {
        var n = Math.min(65535, b.length - i), h = new Uint8Array(5);
        h[0] = i + n >= b.length ? 1 : 0; h[1] = n & 255; h[2] = n >> 8; h[3] = ~n & 255; h[4] = (~n >> 8) & 255;
        parts.push(h, b.subarray(i, i + n)); i += n;
      } while (i < b.length);
      return concatBytes(parts);
    }
    function adler32(b) { var a = 1, c = 0; for (var i = 0; i < b.length; i++) { a = (a + b[i]) % 65521; c = (c + a) % 65521; } return ((c << 16) | a) >>> 0; }

    // ===================================================================
    // Base encodings
    // ===================================================================
    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var B64R = {}; (function () { for (var i = 0; i < 64; i++) B64R[B64[i]] = i; B64R['-'] = 62; B64R._ = 63; })();
    function b64Dec(s) {
      s = s.replace(/\s+/g, '').replace(/=+$/, '');
      if (!s.length || /[^A-Za-z0-9+/_-]/.test(s) || s.length % 4 === 1) throw err('not base64');
      var out = new Uint8Array(Math.floor(s.length * 3 / 4)), o = 0, acc = 0, n = 0;
      for (var i = 0; i < s.length; i++) {
        acc = (acc << 6) | B64R[s[i]]; n += 6;
        if (n >= 8) { n -= 8; out[o++] = (acc >> n) & 255; }
      }
      return out.subarray(0, o);
    }
    function b64Enc(b, url) {
      var s = '', i;
      for (i = 0; i + 2 < b.length; i += 3) {
        var v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
        s += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
      }
      var r = b.length - i;
      if (r === 1) { var v1 = b[i] << 16; s += B64[v1 >> 18] + B64[(v1 >> 12) & 63] + '=='; }
      else if (r === 2) { var v2 = (b[i] << 16) | (b[i + 1] << 8); s += B64[v2 >> 18] + B64[(v2 >> 12) & 63] + B64[(v2 >> 6) & 63] + '='; }
      if (url) s = s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return s;
    }
    var B32A = { rfc: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', hex: '0123456789ABCDEFGHIJKLMNOPQRSTUV', crockford: '0123456789ABCDEFGHJKMNPQRSTVWXYZ', zbase: 'ybndrfg8ejkmcpqxot1uwisza345h769' };
    function b32Dec(s, v) {
      var alpha = B32A[v || 'rfc'];
      s = s.replace(/\s+/g, '').replace(/=+$/, '');
      if (v === 'zbase') s = s.toLowerCase(); else s = s.toUpperCase();
      if (v === 'crockford') s = s.replace(/-/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
      if (!s.length) throw err('empty');
      var out = new Uint8Array(Math.floor(s.length * 5 / 8)), o = 0, acc = 0, n = 0;
      for (var i = 0; i < s.length; i++) {
        var x = alpha.indexOf(s[i]);
        if (x < 0) throw err('not base32');
        acc = ((acc << 5) | x) & 0xffff; n += 5;
        if (n >= 8) { n -= 8; out[o++] = (acc >> n) & 255; }
      }
      return out.subarray(0, o);
    }
    function b32Enc(b, v, pad) {
      var alpha = B32A[v || 'rfc'], s = '', acc = 0, n = 0;
      for (var i = 0; i < b.length; i++) {
        acc = ((acc << 8) | b[i]) & 0xffff; n += 8;
        while (n >= 5) { n -= 5; s += alpha[(acc >> n) & 31]; }
      }
      if (n) s += alpha[(acc << (5 - n)) & 31];
      if (pad !== false && v !== 'crockford' && v !== 'zbase') while (s.length % 8) s += '=';
      return s;
    }
    // Arbitrary-radix big-number codecs (Base58 / Base62 / Base36 ...).
    var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    var B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    function baseNDec(s, alpha) {
      s = s.replace(/\s+/g, '');
      if (!s.length || s.length > 4000) throw err('bad length');
      var N = alpha.length, bytes = [0], zeros = 0, i, j;
      while (zeros < s.length && s[zeros] === alpha[0]) zeros++;
      for (i = 0; i < s.length; i++) {
        var carry = alpha.indexOf(s[i]);
        if (carry < 0) throw err('bad digit');
        for (j = 0; j < bytes.length; j++) { carry += bytes[j] * N; bytes[j] = carry & 255; carry >>= 8; }
        while (carry) { bytes.push(carry & 255); carry >>= 8; }
      }
      while (bytes.length > 1 && bytes[bytes.length - 1] === 0) bytes.pop();
      if (bytes.length === 1 && bytes[0] === 0) bytes = [];
      var out = new Uint8Array(zeros + bytes.length);
      for (i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
      return out;
    }
    function baseNEnc(b, alpha) {
      var N = alpha.length, digits = [0], zeros = 0, i, j;
      while (zeros < b.length && b[zeros] === 0) zeros++;
      for (i = zeros; i < b.length; i++) {
        var carry = b[i];
        for (j = 0; j < digits.length; j++) { carry += digits[j] * 256; digits[j] = carry % N; carry = (carry / N) | 0; }
        while (carry) { digits.push(carry % N); carry = (carry / N) | 0; }
      }
      var s = '';
      for (i = 0; i < zeros; i++) s += alpha[0];
      if (!(digits.length === 1 && digits[0] === 0)) for (i = digits.length - 1; i >= 0; i--) s += alpha[digits[i]];
      return s;
    }
    // Base85 family: Ascii85 (Adobe, 'z' shortcut, <~ ~>), Z85 (ZeroMQ) and
    // RFC 1924 / Python b85 share one engine with different alphabets.
    var A85 = (function () { var s = ''; for (var i = 33; i < 118; i++) s += String.fromCharCode(i); return s; })();
    var Z85 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';
    var R85 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
    function b85Dec(s, alpha, adobe) {
      s = s.replace(/\s+/g, '');
      if (adobe) { s = s.replace(/^<~/, '').replace(/~>$/, ''); }
      var map = {}, i; for (i = 0; i < 85; i++) map[alpha[i]] = i;
      var out = [], grp = [];
      for (i = 0; i < s.length; i++) {
        var c = s[i];
        if (adobe && c === 'z' && !grp.length) { out.push(0, 0, 0, 0); continue; }
        if (map[c] === undefined) throw err('bad base85 char');
        grp.push(map[c]);
        if (grp.length === 5) { push85(out, grp, 4); grp = []; }
      }
      if (grp.length === 1) throw err('bad base85 length');
      if (grp.length) { var n = grp.length; while (grp.length < 5) grp.push(84); push85(out, grp, n - 1); }
      return new Uint8Array(out);
    }
    function push85(out, g, n) {
      var v = (((g[0] * 85 + g[1]) * 85 + g[2]) * 85 + g[3]) * 85 + g[4];
      if (v > 0xffffffff) throw err('base85 overflow');
      var b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
      for (var i = 0; i < n; i++) out.push(b[i]);
    }
    function b85Enc(b, alpha, adobe) {
      var s = '';
      for (var i = 0; i < b.length; i += 4) {
        var n = Math.min(4, b.length - i), v = 0;
        for (var j = 0; j < 4; j++) v = v * 256 + (j < n ? b[i + j] : 0);
        if (adobe && n === 4 && v === 0) { s += 'z'; continue; }
        var d = [];
        for (var k = 0; k < 5; k++) { d.unshift(alpha[v % 85]); v = Math.floor(v / 85); }
        s += d.slice(0, n + 1).join('');
      }
      return adobe ? '<~' + s + '~>' : s;
    }
    var B91 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';
    function b91Dec(s) {
      var v = -1, b = 0, n = 0, out = [];
      for (var i = 0; i < s.length; i++) {
        var p = B91.indexOf(s[i]);
        if (p < 0) { if (/\s/.test(s[i])) continue; throw err('bad base91 char'); }
        if (v < 0) v = p;
        else {
          v += p * 91; b |= v << n; n += (v & 8191) > 88 ? 13 : 14;
          do { out.push(b & 255); b >>= 8; n -= 8; } while (n > 7);
          v = -1;
        }
      }
      if (v > -1) out.push((b | v << n) & 255);
      return new Uint8Array(out);
    }
    function b91Enc(bytes) {
      var b = 0, n = 0, s = '';
      for (var i = 0; i < bytes.length; i++) {
        b |= bytes[i] << n; n += 8;
        if (n > 13) {
          var v = b & 8191;
          if (v > 88) { b >>= 13; n -= 13; } else { v = b & 16383; b >>= 14; n -= 14; }
          s += B91[v % 91] + B91[(v / 91) | 0];
        }
      }
      if (n) { s += B91[b % 91]; if (n > 7 || b > 90) s += B91[(b / 91) | 0]; }
      return s;
    }

    // ===================================================================
    // Number-ish encodings
    // ===================================================================
    function hexClean(s) { return s.replace(/0x/gi, '').replace(/\\x/gi, '').replace(/[\s,:;.\-%{}\[\]'"]/g, ''); }
    function hexDec(s) {
      var h = hexClean(s);
      if (!h.length || h.length % 2 || /[^0-9a-f]/i.test(h)) throw err('not hex');
      var out = new Uint8Array(h.length / 2);
      for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
      return out;
    }
    function binDec(s, P) {
      var t = s.trim(), toks = t.split(/[\s,;|]+/).filter(Boolean), i, out = [];
      if (!toks.length || toks.some(function (x) { return /[^01]/.test(x); })) throw err('not binary');
      var w = +(P && P.width) || 0;
      if (toks.length === 1 || w) {
        var all = toks.join('');
        if (!w) w = all.length % 8 === 0 ? 8 : all.length % 7 === 0 ? 7 : 0;
        if (!w) throw err('binary length is not a multiple of 7 or 8');
        for (i = 0; i + w <= all.length; i += w) out.push(parseInt(all.substr(i, w), 2));
      } else {
        for (i = 0; i < toks.length; i++) {
          if (toks[i].length > 8) throw err('binary group too long');
          out.push(parseInt(toks[i], 2));
        }
      }
      return new Uint8Array(out);
    }
    function binEnc(b, P) {
      var w = +(P && P.width) || 8, a = [];
      for (var i = 0; i < b.length; i++) a.push(('00000000' + b[i].toString(2)).slice(-w));
      return a.join(' ');
    }
    function numList(s, re) { return s.trim().split(re || /[\s,;]+/).filter(Boolean); }
    function octDec(s) {
      var toks = s.indexOf('\\') >= 0 ? s.split('\\').filter(Boolean) : numList(s);
      if (!toks.length) throw err('empty');
      var out = new Uint8Array(toks.length);
      for (var i = 0; i < toks.length; i++) {
        if (!/^[0-7]{1,3}$/.test(toks[i].trim())) throw err('not octal');
        var v = parseInt(toks[i], 8);
        if (v > 255) throw err('octal > 377');
        out[i] = v;
      }
      return out;
    }
    function decDec(s) {
      var toks = numList(s, /[^0-9]+/);
      if (!toks.length) throw err('empty');
      var nums = toks.map(Number), max = Math.max.apply(null, nums);
      if (max <= 255) return new Uint8Array(nums);
      if (max > 0x10ffff) throw err('number too large for a code point');
      return nums.map(fromCP).join('');
    }
    function a1z26Dec(s) {
      var words = s.trim().split(/\s*[\/|]\s*|\s{2,}|\n+/), out = [];
      for (var w = 0; w < words.length; w++) {
        var nums = words[w].split(/[\s,.\-_+:;]+/).filter(Boolean), word = '';
        for (var i = 0; i < nums.length; i++) {
          if (!/^\d{1,2}$/.test(nums[i])) throw err('not A1Z26');
          var n = +nums[i];
          if (n === 0) word += ' ';
          else if (n > 26) throw err('number > 26');
          else word += LO[n - 1];
        }
        out.push(word);
      }
      return out.join(' ');
    }
    function a1z26Enc(s) {
      return s.toLowerCase().split(/\s+/).filter(Boolean).map(function (w) {
        return w.replace(/[^a-z]/g, '').split('').map(function (c) { return c.charCodeAt(0) - 96; }).join('-');
      }).filter(Boolean).join(' / ');
    }

    // ===================================================================
    // Web / mail encodings
    // ===================================================================
    function urlDec(s, P) {
      if (P && P.plus) s = s.replace(/\+/g, ' ');
      var parts = [], buf = [], i = 0;
      var flush = function () { if (buf.length) { parts.push(utf8Lenient(new Uint8Array(buf))); buf = []; } };
      while (i < s.length) {
        if (s[i] === '%' && /^[0-9a-f]{2}$/i.test(s.substr(i + 1, 2))) { buf.push(parseInt(s.substr(i + 1, 2), 16)); i += 3; }
        else if (s[i] === '%' && /^u[0-9a-f]{4}$/i.test(s.substr(i + 1, 5))) { flush(); parts.push(String.fromCharCode(parseInt(s.substr(i + 2, 4), 16))); i += 6; }
        else { flush(); parts.push(s[i]); i++; }
      }
      flush();
      return parts.join('');
    }
    function urlEnc(s, P) {
      var all = P && P.all, b = utf8Encode(s), o = '';
      for (var i = 0; i < b.length; i++) {
        var c = b[i];
        if (!all && ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 46 || c === 95 || c === 126)) o += String.fromCharCode(c);
        else o += '%' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase();
      }
      return o;
    }
    var ENT = { amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, hellip: 8230, mdash: 8212, ndash: 8211, lsquo: 8216, rsquo: 8217, ldquo: 8220, rdquo: 8221, sbquo: 8218, bdquo: 8222, bull: 8226, euro: 8364, trade: 8482, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, lArr: 8656, rArr: 8658, hArr: 8660, infin: 8734, ne: 8800, le: 8804, ge: 8805, asymp: 8776, sum: 8721, prod: 8719, radic: 8730, minus: 8722, part: 8706, nabla: 8711, isin: 8712, forall: 8704, exist: 8707, empty: 8709, and: 8743, or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756, sim: 8764, equiv: 8801, sub: 8834, sup: 8835, oplus: 8853, perp: 8869, spades: 9824, clubs: 9827, hearts: 9829, diams: 9830, loz: 9674, dagger: 8224, Dagger: 8225, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254, frasl: 8260, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, sigmaf: 962, thetasym: 977, upsih: 978, piv: 982, alefsym: 8501, image: 8465, weierp: 8472, real: 8476, crarr: 8629, lceil: 8968, rceil: 8969, lfloor: 8970, rfloor: 8971, lang: 9001, rang: 9002, nsub: 8836, sube: 8838, supe: 8839, otimes: 8855, sdot: 8901, notin: 8713, ni: 8715, lowast: 8727, prop: 8733, ang: 8736, cong: 8773 };
    (function () {
      var l1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ');
      for (var i = 0; i < l1.length; i++) ENT[l1[i]] = 160 + i;
      var gr = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho - Sigma Tau Upsilon Phi Chi Psi Omega'.split(' ');
      for (var j = 0; j < gr.length; j++) if (gr[j] !== '-') { ENT[gr[j]] = 0x391 + j; ENT[gr[j].toLowerCase()] = 0x3b1 + j; }
    })();
    var ENT_REV = null;
    function htmlDec(s) {
      return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,8});?/g, function (m, e) {
        if (e[0] === '#') {
          var cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return cp > 0 && cp <= 0x10ffff ? fromCP(cp) : m;
        }
        if (m[m.length - 1] !== ';' && !/^(amp|lt|gt|quot|nbsp|copy|reg)$/.test(e)) return m;
        return ENT[e] !== undefined ? String.fromCharCode(ENT[e]) : m;
      });
    }
    function htmlEnc(s, P) {
      if (!ENT_REV) { ENT_REV = {}; for (var k in ENT) if (ENT_REV[ENT[k]] === undefined) ENT_REV[ENT[k]] = k; }
      var mode = (P && P.mode) || 'named', out = '';
      chars(s).forEach(function (c) {
        var cp = c.codePointAt(0);
        if (mode === 'all') out += '&#' + cp + ';';
        else if (mode === 'hex') out += cp < 128 && /[A-Za-z0-9 ]/.test(c) ? c : '&#x' + cp.toString(16) + ';';
        else if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'" || cp > 126) out += ENT_REV[cp] && cp !== 39 ? '&' + ENT_REV[cp] + ';' : '&#' + cp + ';';
        else out += c;
      });
      return out;
    }
    function qpDec(s) {
      s = s.replace(/=\r?\n/g, '');
      var buf = [];
      for (var i = 0; i < s.length; i++) {
        if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { buf.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
        else { var u = utf8Encode(s[i]); for (var j = 0; j < u.length; j++) buf.push(u[j]); }
      }
      return new Uint8Array(buf);
    }
    function qpEnc(s) {
      var b = utf8Encode(s), lines = [], line = '';
      for (var i = 0; i < b.length; i++) {
        var c = b[i], t;
        if (c === 10) { lines.push(line); line = ''; continue; }
        if ((c >= 33 && c <= 126 && c !== 61) || c === 32) t = String.fromCharCode(c);
        else t = '=' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase();
        if (line.length + t.length > 75) { lines.push(line + '='); line = ''; }
        line += t;
      }
      lines.push(line);
      return lines.map(function (l) { return l.replace(/ $/, '=20'); }).join('\n');
    }
    function uuDec(s) {
      var lines = s.split(/\r?\n/), out = [], started = !/^begin\s/m.test(s);
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (!started) { if (/^begin\s/.test(l)) started = true; continue; }
        if (/^end\s*$/.test(l)) break;
        if (!l.length) continue;
        var n = (l.charCodeAt(0) - 32) & 63;
        if (!n) continue;
        var bytes = [];
        for (var j = 1; j < l.length; j += 4) {
          var c = [0, 1, 2, 3].map(function (k) { return j + k < l.length ? (l.charCodeAt(j + k) - 32) & 63 : 0; });
          bytes.push((c[0] << 2) | (c[1] >> 4), ((c[1] & 15) << 4) | (c[2] >> 2), ((c[2] & 3) << 6) | c[3]);
        }
        if (bytes.length < n) throw err('uuencode line too short');
        for (var k2 = 0; k2 < n; k2++) out.push(bytes[k2]);
      }
      if (!out.length) throw err('no uuencoded data');
      return new Uint8Array(out);
    }
    function uuEnc(b, P) {
      var ch = function (v) { return v ? String.fromCharCode(v + 32) : '`'; };
      var s = 'begin 644 ' + ((P && P.name) || 'data.txt') + '\n';
      for (var i = 0; i < b.length; i += 45) {
        var n = Math.min(45, b.length - i), line = ch(n);
        for (var j = 0; j < n; j += 3) {
          var a = b[i + j], c = j + 1 < n ? b[i + j + 1] : 0, d = j + 2 < n ? b[i + j + 2] : 0;
          line += ch(a >> 2) + ch(((a & 3) << 4) | (c >> 4)) + ch(((c & 15) << 2) | (d >> 6)) + ch(d & 63);
        }
        s += line + '\n';
      }
      return s + '`\nend\n';
    }
    // Punycode (RFC 3492) for IDN labels.
    var PB = 36, PTMIN = 1, PTMAX = 26, PSKEW = 38, PDAMP = 700;
    function pAdapt(delta, num, first) {
      delta = first ? Math.floor(delta / PDAMP) : delta >> 1;
      delta += Math.floor(delta / num);
      var k = 0;
      while (delta > ((PB - PTMIN) * PTMAX) >> 1) { delta = Math.floor(delta / (PB - PTMIN)); k += PB; }
      return k + Math.floor((PB - PTMIN + 1) * delta / (delta + PSKEW));
    }
    function punyDecodeLabel(input) {
      var out = [], i = 0, n = 128, bias = 72, b = input.lastIndexOf('-');
      if (b < 0) b = 0;
      for (var j = 0; j < b; j++) out.push(input.charCodeAt(j));
      for (var idx = b > 0 ? b + 1 : 0; idx < input.length;) {
        var oldi = i, w = 1;
        for (var k = PB; ; k += PB) {
          if (idx >= input.length) throw err('bad punycode');
          var c = input.charCodeAt(idx++), digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : PB;
          if (digit >= PB) throw err('bad punycode digit');
          i += digit * w;
          var t = k <= bias ? PTMIN : k >= bias + PTMAX ? PTMAX : k - bias;
          if (digit < t) break;
          w *= PB - t;
        }
        bias = pAdapt(i - oldi, out.length + 1, oldi === 0);
        n += Math.floor(i / (out.length + 1));
        i %= out.length + 1;
        out.splice(i++, 0, n);
      }
      return out.map(fromCP).join('');
    }
    function punyEncodeLabel(str) {
      var input = chars(str).map(function (c) { return c.codePointAt(0); }), out = '', n = 128, delta = 0, bias = 72;
      var basic = input.filter(function (c) { return c < 128; });
      out = basic.map(function (c) { return String.fromCharCode(c); }).join('');
      var h = basic.length, b = h;
      if (b) out += '-';
      var dig = function (d) { return String.fromCharCode(d + 22 + 75 * (d < 26)); };
      while (h < input.length) {
        var m = Infinity;
        input.forEach(function (c) { if (c >= n && c < m) m = c; });
        delta += (m - n) * (h + 1); n = m;
        for (var j = 0; j < input.length; j++) {
          var c = input[j];
          if (c < n) delta++;
          if (c === n) {
            var q = delta;
            for (var k = PB; ; k += PB) {
              var t = k <= bias ? PTMIN : k >= bias + PTMAX ? PTMAX : k - bias;
              if (q < t) break;
              out += dig(t + (q - t) % (PB - t)); q = Math.floor((q - t) / (PB - t));
            }
            out += dig(q); bias = pAdapt(delta, h + 1, h === b); delta = 0; h++;
          }
        }
        delta++; n++;
      }
      return out;
    }
    function punyDec(s) {
      if (!/xn--/i.test(s)) return punyDecodeLabel(s);
      return s.replace(/xn--([a-z0-9-]+)/gi, function (m, l) { try { return punyDecodeLabel(l.toLowerCase()); } catch (e) { return m; } });
    }
    function punyEnc(s) {
      return s.split(/([.\s/:@]+)/).map(function (p) { return /[^\x00-\x7f]/.test(p) ? 'xn--' + punyEncodeLabel(p.toLowerCase()) : p; }).join('');
    }
    function uescDec(s) {
      s = s.replace(/([Uu]\+[0-9a-fA-F]{4,6})[\s,]+(?=[Uu]\+)/g, '$1');
      s = s.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\x\{([0-9a-fA-F]{1,6})\}|\\U([0-9a-fA-F]{8})|[Uu]\+([0-9a-fA-F]{4,6})|%u([0-9a-fA-F]{4})|&#x([0-9a-fA-F]{1,6});/g, function (m, a, b, c, d, e, f) {
        var cp = parseInt(a || b || c || d || e || f, 16);
        return cp <= 0x10ffff ? fromCP(cp) : m;
      });
      s = s.replace(/(?:\\u[0-9a-fA-F]{4})+/g, function (m) {
        return String.fromCharCode.apply(null, m.split('\\u').slice(1).map(function (h) { return parseInt(h, 16); }));
      });
      s = s.replace(/(?:\\x[0-9a-fA-F]{2})+/g, function (m) {
        return utf8Lenient(new Uint8Array(m.split('\\x').slice(1).map(function (h) { return parseInt(h, 16); })));
      });
      s = s.replace(/(?:\\[0-3][0-7]{2})+/g, function (m) {
        return utf8Lenient(new Uint8Array(m.split('\\').slice(1).map(function (h) { return parseInt(h, 8); })));
      });
      return s;
    }
    function uescEnc(s, P) {
      var st = (P && P.style) || 'u';
      return chars(s).map(function (c) {
        var cp = c.codePointAt(0);
        if (st === 'U+') return 'U+' + ('000' + cp.toString(16).toUpperCase()).slice(-Math.max(4, cp.toString(16).length));
        if (st === 'u{') return '\\u{' + cp.toString(16) + '}';
        if (cp < 0x10000) return '\\u' + ('000' + cp.toString(16)).slice(-4);
        cp -= 0x10000;
        return '\\u' + (0xd800 + (cp >> 10)).toString(16) + '\\u' + (0xdc00 + (cp & 1023)).toString(16);
      }).join(st === 'U+' ? ' ' : '');
    }
    function dataUriDec(s) {
      var m = /^\s*data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(s);
      if (!m) throw err('not a data: URI');
      if (m[2]) return b64Dec(m[3]);
      return utf8Encode(urlDec(m[3]));
    }
    function jwtDec(s) {
      var p = s.trim().split('.');
      if (p.length < 2 || p.length > 5) throw err('not a JWT');
      var head = utf8Strict(b64Dec(p[0])), body = utf8Strict(b64Dec(p[1]));
      if (head === null || body === null) throw err('JWT segments are not text');
      var parse = function (t) { try { return JSON.parse(t); } catch (e) { return t; } };
      var o = { header: parse(head), payload: parse(body) };
      if (p[2]) o.signature = p[2].length + ' Base64url chars (' + Math.floor(p[2].length * 3 / 4) + ' bytes, not verified)';
      return JSON.stringify(o, null, 2);
    }

    // ===================================================================
    // Symbol codes: Morse, Baconian, keypad, NATO, tap code, Braille, leet,
    // upside-down, Zalgo, keyboard shift
    // ===================================================================
    var MORSE = { '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J', '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T', '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y', '--..': 'Z', '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4', '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9', '.-.-.-': '.', '--..--': ',', '..--..': '?', '.----.': "'", '-.-.--': '!', '-..-.': '/', '-.--.': '(', '-.--.-': ')', '.-...': '&', '---...': ':', '-.-.-.': ';', '-...-': '=', '.-.-.': '+', '-....-': '-', '..--.-': '_', '.-..-.': '"', '...-..-': '$', '.--.-.': '@' };
    var MORSE_REV = {}; (function () { for (var k in MORSE) MORSE_REV[MORSE[k]] = k; })();
    function morseNorm(s, v) {
      if (v === '01') s = s.replace(/0/g, '.').replace(/1/g, '-');
      else if (v === '10') s = s.replace(/1/g, '.').replace(/0/g, '-');
      if (/\b(dit|dah|di|da)\b/i.test(s)) {
        s = s.trim().split(/\s*[\/|]\s*|\s{3,}|\n+/).map(function (w) {
          return w.trim().split(/\s+/).map(function (l) {
            return l.split(/[-,]+/).map(function (y) { y = y.toLowerCase(); return y === 'dit' || y === 'di' ? '.' : y === 'dah' || y === 'da' ? '-' : y; }).join('');
          }).join(' ');
        }).join(' / ');
      }
      return s.replace(/[·•∙⋅*]/g, '.').replace(/[−–—_]/g, '-');
    }
    function morseDec(s, P) {
      s = morseNorm(s, P && P.variant);
      if (/[^.\-\s\/|\\]/.test(s)) throw err('not Morse');
      var words = s.trim().split(/\s*[\/|\\]\s*|\s{3,}|\n+/), out = [];
      for (var w = 0; w < words.length; w++) {
        var ls = words[w].trim().split(/\s+/).filter(Boolean), word = '';
        for (var i = 0; i < ls.length; i++) word += MORSE[ls[i]] || '\ufffd';
        out.push(word);
      }
      return out.join(' ');
    }
    function morseEnc(s) {
      return s.toUpperCase().split(/\s+/).filter(Boolean).map(function (w) {
        return chars(w).map(function (c) { return MORSE_REV[c] || ''; }).filter(Boolean).join(' ');
      }).join(' / ');
    }
    var BACON24 = 'ABCDEFGHIKLMNOPQRSTUWXYZ';
    function baconDec(s, P) {
      var v = (P && P.variant) || '26', sym = (P && P.symbols) || 'auto', bits = '';
      if (sym === 'case') {
        bits = s.replace(/[^A-Za-z]/g, '').replace(/[a-z]/g, '0').replace(/[A-Z]/g, '1');
      } else {
        var t = s.replace(/\s+/g, '');
        if (/^[ABab]+$/.test(t)) bits = t.replace(/[Aa]/g, '0').replace(/[Bb]/g, '1');
        else if (/^[01]+$/.test(t)) bits = t;
        else {
          var u = []; for (var i = 0; i < t.length; i++) if (u.indexOf(t[i]) < 0) u.push(t[i]);
          if (u.length !== 2) throw err('Baconian needs exactly two symbols');
          bits = t.split(u[0]).join('0').split(u[1]).join('1');
        }
        if (sym === 'swap') bits = bits.replace(/[01]/g, function (c) { return c === '0' ? '1' : '0'; });
      }
      if (bits.length < 5) throw err('too short');
      var out = '';
      for (var j = 0; j + 5 <= bits.length; j += 5) {
        var n = parseInt(bits.substr(j, 5), 2);
        out += v === '24' ? (BACON24[n] || '?') : (n < 26 ? UP[n] : '?');
      }
      return out;
    }
    function baconEnc(s, P) {
      var v = (P && P.variant) || '26';
      return lettersOnly(s).split('').map(function (c) {
        var n = v === '24' ? BACON24.indexOf(c === 'J' ? 'I' : c === 'V' ? 'U' : c) : c.charCodeAt(0) - 65;
        return ('00000' + n.toString(2)).slice(-5).replace(/0/g, 'A').replace(/1/g, 'B');
      }).join(' ');
    }
    var KEYPAD = { 2: 'abc', 3: 'def', 4: 'ghi', 5: 'jkl', 6: 'mno', 7: 'pqrs', 8: 'tuv', 9: 'wxyz', 0: ' ' };
    function t9Dec(s) {
      if (/[^0-9\s,.\/|_-]/.test(s)) throw err('not keypad');
      var toks = s.trim().split(/[\s,.\/|_-]+/).filter(Boolean), out = '';
      for (var i = 0; i < toks.length; i++) {
        var runs = toks[i].match(/(\d)\1*/g) || [];
        for (var j = 0; j < runs.length; j++) {
          var d = runs[j][0], k = KEYPAD[d];
          if (d === '1') continue;
          if (!k) throw err('bad key');
          out += k[(runs[j].length - 1) % k.length];
        }
      }
      return out;
    }
    function t9Enc(s) {
      var out = [];
      s.toLowerCase().split('').forEach(function (c) {
        if (c === ' ') { out.push('0'); return; }
        for (var d in KEYPAD) { var i = KEYPAD[d].indexOf(c); if (i >= 0 && d !== '0') { out.push(new Array(i + 2).join(d)); return; } }
      });
      return out.join(' ');
    }
    var NATO = { alfa: 'A', alpha: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E', foxtrot: 'F', golf: 'G', hotel: 'H', india: 'I', juliet: 'J', juliett: 'J', kilo: 'K', lima: 'L', mike: 'M', november: 'N', oscar: 'O', papa: 'P', quebec: 'Q', romeo: 'R', sierra: 'S', tango: 'T', uniform: 'U', victor: 'V', whiskey: 'W', whisky: 'W', xray: 'X', 'x-ray': 'X', yankee: 'Y', zulu: 'Z', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', niner: '9', tree: '3', fife: '5' };
    var NATO_W = 'Alfa Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliett Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey X-ray Yankee Zulu'.split(' ');
    var NATO_D = 'Zero One Two Three Four Five Six Seven Eight Nine'.split(' ');
    function natoDec(s) {
      var toks = s.toLowerCase().replace(/[.,;!?()]/g, ' ').split(/\s+/).filter(Boolean), out = '', hit = 0;
      for (var i = 0; i < toks.length; i++) {
        var t = toks[i];
        if (NATO[t]) { out += NATO[t]; hit++; }
        else if (t === '/' || t === '|' || t === 'space' || t === 'stop' || t === '(space)') out += ' ';
        else out += '[' + t + ']';
      }
      if (hit < toks.length * 0.6) throw err('not NATO phonetic');
      return out;
    }
    function natoEnc(s) {
      return s.toUpperCase().split(/\s+/).filter(Boolean).map(function (w) {
        return w.split('').map(function (c) {
          var i = c.charCodeAt(0) - 65; if (i >= 0 && i < 26) return NATO_W[i];
          var d = c.charCodeAt(0) - 48; if (d >= 0 && d < 10) return NATO_D[d];
          return '';
        }).filter(Boolean).join(' ');
      }).join(' / ');
    }

    // ---- Polybius-square family helpers --------------------------------
    var SQ_BASE = { ij: 'ABCDEFGHIKLMNOPQRSTUVWXYZ', ck: 'ABCDEFGHIJLMNOPQRSTUVWXYZ', noq: 'ABCDEFGHIJKLMNOPRSTUVWXYZ', 6: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' };
    function sqNorm(s, size, variant) {
      s = String(s || '').toUpperCase();
      if (size === 6) return s.replace(/[^A-Z0-9]/g, '');
      s = s.replace(/[^A-Z]/g, '');
      if (variant === 'ck') return s.replace(/K/g, 'C');
      if (variant === 'noq') return s.replace(/Q/g, '');
      return s.replace(/J/g, 'I');
    }
    function makeSquare(key, size, variant) {
      size = size === 6 || size === '6' ? 6 : 5;
      var base = size === 6 ? SQ_BASE[6] : SQ_BASE[variant || 'ij'], seq = '', all = sqNorm(key, size, variant) + base;
      for (var i = 0; i < all.length; i++) if (seq.indexOf(all[i]) < 0 && base.indexOf(all[i]) >= 0) seq += all[i];
      return { sq: seq, size: size, variant: variant || 'ij', pos: function (c) { return seq.indexOf(c); } };
    }
    function coordSyms(P, size) {
      var c = String((P && P.coords) || '').replace(/\s+/g, '');
      if (!c || c.length < size) c = size === 6 ? '123456' : '12345';
      return c.slice(0, size).toUpperCase();
    }
    function polybiusDec(s, P) {
      var S = makeSquare(P && P.key, +(P && P.size) || 5, P && P.variant), co = coordSyms(P, S.size);
      var words = s.trim().split(/\s*\/\s*|\s{2,}|\n+/), out = [];
      for (var w = 0; w < words.length; w++) {
        var sy = words[w].toUpperCase().split('').filter(function (c) { return co.indexOf(c) >= 0; });
        if (sy.length % 2) throw err('odd number of coordinates');
        var word = '';
        for (var i = 0; i < sy.length; i += 2) word += S.sq[co.indexOf(sy[i]) * S.size + co.indexOf(sy[i + 1])] || '?';
        out.push(word);
      }
      var r = out.join(' ');
      if (!r.replace(/\s/g, '')) throw err('no coordinates');
      return r;
    }
    function polybiusEnc(s, P) {
      var S = makeSquare(P && P.key, +(P && P.size) || 5, P && P.variant), co = coordSyms(P, S.size);
      return s.split(/\s+/).filter(Boolean).map(function (w) {
        return sqNorm(w, S.size, S.variant).split('').map(function (c) { var p = S.pos(c); return co[Math.floor(p / S.size)] + co[p % S.size]; }).join(' ');
      }).filter(Boolean).join(' / ');
    }
    function tapDec(s, P) {
      var S = makeSquare('', 5, 'ck'), out = '', pairs = [];
      if (/[.•*]/.test(s)) {
        var words = s.trim().split(/\s*\/\s*|\n+/);
        for (var w = 0; w < words.length; w++) {
          var g = words[w].trim().split(/\s+/).filter(Boolean);
          if (g.some(function (x) { return /[^.•*]/.test(x); })) throw err('not tap code');
          if (g.length % 2) throw err('odd tap groups');
          for (var i = 0; i < g.length; i += 2) pairs.push([g[i].length, g[i + 1].length]);
          pairs.push(null);
        }
      } else {
        var ws = s.trim().split(/\s*\/\s*|\s{2,}|\n+/);
        for (var k = 0; k < ws.length; k++) {
          var d = ws[k].replace(/[^1-5]/g, '');
          if (d.length % 2 || /[^1-5\s,]/.test(ws[k])) throw err('not tap digits');
          for (var j = 0; j < d.length; j += 2) pairs.push([+d[j], +d[j + 1]]);
          pairs.push(null);
        }
      }
      pairs.pop();
      for (var q = 0; q < pairs.length; q++) {
        if (!pairs[q]) { out += ' '; continue; }
        var r = pairs[q][0], c = pairs[q][1];
        if (r < 1 || r > 5 || c < 1 || c > 5) throw err('tap out of range');
        out += S.sq[(r - 1) * 5 + c - 1];
      }
      return out;
    }
    function tapEnc(s, P) {
      var S = makeSquare('', 5, 'ck'), dots = !P || P.style !== 'digits';
      var rep = function (n) { return dots ? new Array(n + 1).join('.') : String(n); };
      return s.split(/\s+/).filter(Boolean).map(function (w) {
        return sqNorm(w, 5, 'ck').split('').map(function (c) { var p = S.pos(c); return rep(Math.floor(p / 5) + 1) + (dots ? ' ' : '') + rep(p % 5 + 1); }).join(dots ? '  ' : ' ');
      }).join(' / ');
    }

    // Braille (Unicode U+2800 block), English Grade 1 letters/digits/punctuation.
    var BR_LET = '1 12 14 145 15 124 1245 125 24 245 13 123 134 1345 135 1234 12345 1235 234 2345 136 1236 2456 1346 13456 1356'.split(' ');
    var BR_PUN = { ',': '2', ';': '23', ':': '25', '.': '256', '!': '235', '?': '236', "'": '3', '-': '36', '"': '356', '(': '2356', ')': '2356' };
    function brCell(d) { var v = 0; for (var i = 0; i < d.length; i++) v |= 1 << (+d[i] - 1); return String.fromCharCode(0x2800 + v); }
    var BR = null;
    function brInit() {
      if (BR) return;
      BR = { l: {}, rl: {}, p: {}, rp: {} };
      for (var i = 0; i < 26; i++) { var c = brCell(BR_LET[i]); BR.l[c] = LO[i]; BR.rl[LO[i]] = c; }
      for (var k in BR_PUN) { var cc = brCell(BR_PUN[k]); if (!BR.p[cc]) BR.p[cc] = k; BR.rp[k] = cc; }
      BR.num = brCell('3456'); BR.cap = brCell('6');
    }
    function brailleDec(s) {
      brInit();
      if (!/[\u2801-\u28ff]/.test(s)) throw err('no Braille cells');
      var out = '', num = false, cap = false;
      for (var i = 0; i < s.length; i++) {
        var c = s[i];
        if (c === '\u2800' || /\s/.test(c)) { out += c === '\u2800' ? ' ' : c; num = false; continue; }
        if (c === BR.num) { num = true; continue; }
        if (c === BR.cap) { cap = true; continue; }
        var l = BR.l[c];
        if (l) {
          if (num && l <= 'j') out += l === 'j' ? '0' : String.fromCharCode(l.charCodeAt(0) - 48);
          else { out += cap ? l.toUpperCase() : l; num = false; }
          cap = false;
        } else if (BR.p[c]) { out += BR.p[c]; num = false; }
        else if (c >= '\u2800' && c <= '\u28ff') out += '\ufffd';
        else out += c;
      }
      return out;
    }
    function brailleEnc(s) {
      brInit();
      var out = '', num = false;
      for (var i = 0; i < s.length; i++) {
        var c = s[i], lc = c.toLowerCase();
        if (/[0-9]/.test(c)) { if (!num) { out += BR.num; num = true; } out += BR.rl[c === '0' ? 'j' : String.fromCharCode(c.charCodeAt(0) + 48)]; continue; }
        if (BR.rl[lc]) { if (num && lc <= 'j') out += brCell('56'); num = false; out += (c !== lc ? BR.cap : '') + BR.rl[lc]; continue; }
        num = false;
        if (c === ' ') out += '\u2800'; else if (BR.rp[c]) out += BR.rp[c]; else out += c;
      }
      return out;
    }
    var LEET_MULTI = [['|\\/|', 'm'], ['/\\/\\', 'm'], ['\\/\\/', 'w'], ['|\\|', 'n'], ['/\\/', 'n'], ['|-|', 'h'], ['}{', 'h'], ['/\\', 'a'], ['\\/', 'v'], ['|<', 'k'], ['|>', 'd'], ['|)', 'd'], ['()', 'o'], ['[]', 'o'], ['|_', 'l'], ['ph', 'f'], ['><', 'x'], ['|2', 'r'], ['|o', 'p'], ['|*', 'p']];
    var LEET = { '4': 'a', '@': 'a', '8': 'b', '(': 'c', '<': 'c', '3': 'e', '€': 'e', '6': 'g', '9': 'g', '#': 'h', '1': 'i', '!': 'i', '|': 'l', '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't', '2': 'z', '%': 'x', 'µ': 'u' };
    function leetDec(s, P) {
      var oneIsL = P && P.one === 'l';
      return s.replace(/\S+/g, function (tok) {
        if (!/[a-z]/i.test(tok) && !/^[^a-z0-9]*[0-9@$!|]+[^a-z0-9]*$/i.test(tok)) return tok;
        if (/^\d+([.,:]\d+)*$/.test(tok)) return tok;
        var t = tok;
        for (var i = 0; i < LEET_MULTI.length; i++) if (LEET_MULTI[i][0] !== 'ph') t = t.split(LEET_MULTI[i][0]).join(LEET_MULTI[i][1]);
        var trail = (/[.,;:!?]+$/.exec(t) || [''])[0];
        var body = trail ? t.slice(0, -trail.length) : t;
        return body.replace(/[0-9@$!|(<+#%€µ]/g, function (c) { return c === '1' && oneIsL ? 'l' : LEET[c] || c; }) + trail;
      });
    }
    var LEET_ENC = { a: '4', b: '8', e: '3', g: '6', i: '1', l: '|', o: '0', s: '5', t: '7', z: '2' };
    function leetEnc(s) { return s.replace(/[abegilostz]/gi, function (c) { return LEET_ENC[c.toLowerCase()]; }); }
    var FLIP_SRC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,\'"?!()[]{}<>_&;';
    var FLIP_DST = ['ɐ', 'q', 'ɔ', 'p', 'ǝ', 'ɟ', 'ƃ', 'ɥ', 'ᴉ', 'ɾ', 'ʞ', 'l', 'ɯ', 'u', 'o', 'd', 'b', 'ɹ', 's', 'ʇ', 'n', 'ʌ', 'ʍ', 'x', 'ʎ', 'z',
      '∀', 'ꓭ', 'Ɔ', 'ꓷ', 'Ǝ', 'Ⅎ', '⅁', 'H', 'I', 'ſ', 'ꓘ', '˥', 'W', 'N', 'O', 'Ԁ', 'Ό', 'ꓤ', 'S', '⊥', '∩', 'Λ', 'M', 'X', '⅄', 'Z',
      '0', 'Ɩ', 'ᄅ', 'Ɛ', 'ㄣ', 'ϛ', '9', 'ㄥ', '8', '6', '˙', "'", ',', '„', '¿', '¡', ')', '(', ']', '[', '}', '{', '>', '<', '‾', '⅋', '؛'];
    var FLIP = null, UNFLIP = null;
    function flipInit() {
      if (FLIP) return;
      FLIP = {}; UNFLIP = {};
      for (var i = 0; i < FLIP_SRC.length; i++) {
        FLIP[FLIP_SRC[i]] = FLIP_DST[i];
        if (UNFLIP[FLIP_DST[i]] === undefined || FLIP_DST[i] === FLIP_SRC[i]) UNFLIP[FLIP_DST[i]] = FLIP_SRC[i];
      }
      UNFLIP['ı'] = 'i'; UNFLIP['ɹ'] = 'r'; UNFLIP['ʇ'] = 't'; UNFLIP['ᴚ'] = 'R'; UNFLIP['Ꞁ'] = 'L'; UNFLIP['⅂'] = 'L'; UNFLIP['ᗡ'] = 'D'; UNFLIP['ᗺ'] = 'B'; UNFLIP['Ԁ'] = 'P'; UNFLIP['Ⅎ'] = 'F';
      UNFLIP['n'] = 'u'; UNFLIP['u'] = 'n'; UNFLIP['d'] = 'p'; UNFLIP['p'] = 'd'; UNFLIP['b'] = 'q'; UNFLIP['q'] = 'b'; UNFLIP['M'] = 'W'; UNFLIP['W'] = 'M';
      UNFLIP['6'] = '9'; UNFLIP['9'] = '6'; UNFLIP[','] = "'"; UNFLIP["'"] = ',';
    }
    function flipDec(s) {
      flipInit();
      return chars(s).reverse().map(function (c) { return UNFLIP[c] !== undefined ? UNFLIP[c] : c; }).join('');
    }
    function flipEnc(s) {
      flipInit();
      return chars(s).reverse().map(function (c) { return FLIP[c] !== undefined ? FLIP[c] : c; }).join('');
    }
    var COMBINING = /[\u0300-\u036f\u0483-\u0489\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;
    function zalgoDec(s) { return s.replace(COMBINING, ''); }
    var KB_ROWS = ['`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./', '~!@#$%^&*()_+', 'QWERTYUIOP{}|', 'ASDFGHJKL:"', 'ZXCVBNM<>?'];
    function kbdShift(s, dir) {
      var d = dir === 'right' ? 1 : -1;
      return s.replace(/[^\s]/g, function (c) {
        for (var r = 0; r < KB_ROWS.length; r++) {
          var i = KB_ROWS[r].indexOf(c);
          if (i >= 0) { var j = i + d; return j >= 0 && j < KB_ROWS[r].length ? KB_ROWS[r][j] : c; }
        }
        return c;
      });
    }

    // ===================================================================
    // Classical ciphers
    // ===================================================================
    var ALPHAS = {
      latin: ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'Latin A–Z (26)'],
      ru33: ['АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'Russian (33, with Ё)'],
      ru32: ['АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'Russian (32, Ё = Е)'],
      greek: ['ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ', 'Greek (24)'],
      es27: ['ABCDEFGHIJKLMNÑOPQRSTUVWXYZ', 'Spanish (27, with Ñ)'],
      de29: ['ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ', 'German (29, with Ä Ö Ü)'],
      hebrew: ['אבגדהוזחטיכלמנסעפצקרשת', 'Hebrew (22)'],
    };
    var ALPHA_OPTS = Object.keys(ALPHAS).map(function (k) { return [k, ALPHAS[k][1]]; });
    var FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
    var amCache = {};
    function alphaMap(ak, tag, f) {
      var key = ak + '|' + tag;
      if (amCache[key]) return amCache[key];
      var A = (ALPHAS[ak] || ALPHAS.latin)[0], N = A.length, L = A.toLowerCase(), m = {};
      for (var i = 0; i < N; i++) {
        var j = f(i, N);
        m[A[i]] = A[j];
        if (L[i] !== A[i]) m[L[i]] = L[j];
      }
      if (ak === 'greek') { m['ς'] = m['σ']; }
      if (ak === 'ru32') { m['Ё'] = m['Е']; m['ё'] = m['е']; }
      if (ak === 'hebrew') for (var f2 in FINALS) m[f2] = m[FINALS[f2]];
      var keys = Object.keys(amCache);
      if (keys.length > 400) amCache = {};
      return (amCache[key] = m);
    }
    function applyMap(s, m) {
      var out = '';
      for (var i = 0; i < s.length; i++) { var c = s[i], r = m[c]; out += r === undefined ? c : r; }
      return m['\u05d0'] ? hebrewFinals(out) : out;
    }
    // Hebrew: letters were shifted as base forms; restore final forms at word ends.
    var FIN_OF = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' };
    function hebrewFinals(s) {
      return s.replace(/[ךםןףץ](?=[\u05d0-\u05ea])/g, function (c) { for (var k in FIN_OF) if (FIN_OF[k] === c) return k; return c; })
        .replace(/[כמנפצ](?![\u05d0-\u05ea])/g, function (c) { return FIN_OF[c]; });
    }
    function alphaLen(ak) { return (ALPHAS[ak] || ALPHAS.latin)[0].length; }
    function caesar(s, shift, ak, enc) {
      ak = ak || 'latin';
      var N = alphaLen(ak), k = mod(enc ? shift : -shift, N);
      if (ak === 'latin') {
        var out = '';
        for (var i = 0; i < s.length; i++) {
          var c = s.charCodeAt(i);
          if (c >= 65 && c <= 90) out += String.fromCharCode(65 + (c - 65 + k) % 26);
          else if (c >= 97 && c <= 122) out += String.fromCharCode(97 + (c - 97 + k) % 26);
          else out += s[i];
        }
        return out;
      }
      return applyMap(s, alphaMap(ak, 'c' + k, function (i, n) { return (i + k) % n; }));
    }
    function atbash(s, ak) { return applyMap(s, alphaMap(ak || 'latin', 'atbash', function (i, n) { return n - 1 - i; })); }
    var AFFINE_A = [1, 3, 5, 7, 9, 11, 15, 17, 19, 21, 23, 25];
    function affine(s, a, b, enc) {
      a = mod(+a || 1, 26); b = mod(+b || 0, 26);
      if (gcd(a, 26) !== 1) throw err('a must be coprime with 26 (1,3,5,7,9,11,15,17,19,21,23,25)');
      var ai = modInv(a, 26);
      return applyMap(s, alphaMap('latin', 'aff' + a + '_' + b + (enc ? 'e' : 'd'), function (i) { return enc ? mod(a * i + b, 26) : mod(ai * (i - b), 26); }));
    }
    function rot47(s, n) {
      n = n === undefined ? 47 : mod(+n, 94);
      return s.replace(/[!-~]/g, function (c) { return String.fromCharCode(33 + (c.charCodeAt(0) - 33 + n) % 94); });
    }
    function rot5(s) { return s.replace(/[0-9]/g, function (c) { return String.fromCharCode(48 + (c.charCodeAt(0) - 48 + 5) % 10); }); }
    function setCase(src, idx) { var k = src.charCodeAt(0); return String.fromCharCode((k >= 97 ? 97 : 65) + idx); }
    function keyShifts(key, digits) {
      key = String(key || '');
      if (digits) return key.replace(/\D/g, '').split('').map(Number);
      return lettersOnly(key).split('').map(function (c) { return c.charCodeAt(0) - 65; });
    }
    // mode: vig (p = c - k) | beau (p = k - c) | varb (p = c + k)
    function polyCipher(s, shifts, mode, enc) {
      if (!shifts.length) throw err('key needs at least one letter');
      var out = '', j = 0, L = shifts.length;
      for (var i = 0; i < s.length; i++) {
        var c = s[i], x = letterIdx(c);
        if (x < 0) { out += c; continue; }
        var k = shifts[j++ % L], y;
        if (mode === 'beau') y = k - x;
        else if (mode === 'varb') y = enc ? x - k : x + k;
        else y = enc ? x + k : x - k;
        out += setCase(c, mod(y, 26));
      }
      return out;
    }
    function autokey(s, key, enc) {
      var pr = keyShifts(key);
      if (!pr.length) throw err('primer needs at least one letter');
      var out = '', stream = [], j = 0;
      for (var i = 0; i < s.length; i++) {
        var c = s[i], x = letterIdx(c);
        if (x < 0) { out += c; continue; }
        var k = j < pr.length ? pr[j] : stream[j - pr.length], p;
        if (enc) { p = x; out += setCase(c, mod(x + k, 26)); }
        else { p = mod(x - k, 26); out += setCase(c, p); }
        stream.push(p); j++;
      }
      return out;
    }
    function portaChar(x, k) { var i = k >> 1; return x < 13 ? 13 + (x + i) % 13 : mod(x - 13 - i, 13); }
    function porta(s, key) {
      var ks = keyShifts(key);
      if (!ks.length) throw err('key needs at least one letter');
      var out = '', j = 0;
      for (var i = 0; i < s.length; i++) {
        var c = s[i], x = letterIdx(c);
        if (x < 0) { out += c; continue; }
        out += setCase(c, portaChar(x, ks[j++ % ks.length]));
      }
      return out;
    }
    function progressive(s, start, step, period, enc) {
      start = +start || 0; step = step === undefined || step === '' ? 1 : +step; period = Math.max(1, +period || 1);
      var out = '', j = 0;
      for (var i = 0; i < s.length; i++) {
        var c = s[i], x = letterIdx(c);
        if (x < 0) { out += c; continue; }
        var k = start + step * Math.floor(j / period); j++;
        out += setCase(c, mod(enc ? x + k : x - k, 26));
      }
      return out;
    }
    function keywordAlphabet(kw) {
      var seq = '', all = lettersOnly(kw) + UP;
      for (var i = 0; i < all.length; i++) if (seq.indexOf(all[i]) < 0) seq += all[i];
      return seq;
    }
    // key = cipher alphabet: key[i] is the ciphertext letter for plaintext UP[i].
    function substCipher(s, key, enc) {
      key = String(key || '').toUpperCase().replace(/[^A-Z?._*]/g, '');
      if (key.length !== 26) throw err('substitution key must list 26 letters (cipher alphabet for A–Z)');
      var inv = {}, fwd = {};
      for (var i = 0; i < 26; i++) { if (/[A-Z]/.test(key[i])) { inv[key[i]] = UP[i]; fwd[UP[i]] = key[i]; } }
      var m = enc ? fwd : inv, out = '';
      for (var j = 0; j < s.length; j++) {
        var c = s[j], x = letterIdx(c);
        if (x < 0) { out += c; continue; }
        var r = m[UP[x]];
        out += r ? (c === UP[x] ? r : r.toLowerCase()) : (enc ? c : '·');
      }
      return out;
    }

    // ---- digraphic / fractionating ciphers ------------------------------
    function sqLetters(s, size, variant) { return sqNorm(s, size, variant); }
    function playfair(s, key, enc) {
      var S = makeSquare(key, 5, 'ij'), t = sqLetters(s, 5, 'ij'), pairs = [], i;
      if (enc) {
        for (i = 0; i < t.length;) {
          var a = t[i], b = t[i + 1];
          if (b === undefined || a === b) { pairs.push(a + (a === 'X' ? 'Q' : 'X')); i++; }
          else { pairs.push(a + b); i += 2; }
        }
      } else {
        if (t.length % 2) t += 'X';
        for (i = 0; i < t.length; i += 2) pairs.push(t.substr(i, 2));
      }
      var d = enc ? 1 : 4;
      return pairs.map(function (p) {
        var x = S.pos(p[0]), y = S.pos(p[1]), r1 = Math.floor(x / 5), c1 = x % 5, r2 = Math.floor(y / 5), c2 = y % 5;
        if (r1 === r2) return S.sq[r1 * 5 + (c1 + d) % 5] + S.sq[r2 * 5 + (c2 + d) % 5];
        if (c1 === c2) return S.sq[((r1 + d) % 5) * 5 + c1] + S.sq[((r2 + d) % 5) * 5 + c2];
        return S.sq[r1 * 5 + c2] + S.sq[r2 * 5 + c1];
      }).join('');
    }
    function twoSquare(s, k1, k2, horiz, enc) {
      var A = makeSquare(k1, 5, 'ij'), B = makeSquare(k2, 5, 'ij'), t = sqLetters(s, 5, 'ij'), out = '';
      if (t.length % 2) t += 'X';
      for (var i = 0; i < t.length; i += 2) {
        var x, y, r1, c1, r2, c2;
        if (!horiz) {
          x = A.pos(t[i]); y = B.pos(t[i + 1]);
          r1 = Math.floor(x / 5); c1 = x % 5; r2 = Math.floor(y / 5); c2 = y % 5;
          out += A.sq[r1 * 5 + c2] + B.sq[r2 * 5 + c1];
        } else if (enc) {
          x = A.pos(t[i]); y = B.pos(t[i + 1]);
          r1 = Math.floor(x / 5); c1 = x % 5; r2 = Math.floor(y / 5); c2 = y % 5;
          out += B.sq[r1 * 5 + c2] + A.sq[r2 * 5 + c1];
        } else {
          x = B.pos(t[i]); y = A.pos(t[i + 1]);
          r1 = Math.floor(x / 5); c1 = x % 5; r2 = Math.floor(y / 5); c2 = y % 5;
          out += A.sq[r1 * 5 + c2] + B.sq[r2 * 5 + c1];
        }
      }
      return out;
    }
    function fourSquare(s, k1, k2, enc) {
      var P = makeSquare('', 5, 'ij'), A = makeSquare(k1, 5, 'ij'), B = makeSquare(k2, 5, 'ij'), t = sqLetters(s, 5, 'ij'), out = '';
      if (t.length % 2) t += 'X';
      for (var i = 0; i < t.length; i += 2) {
        var x, y;
        if (enc) { x = P.pos(t[i]); y = P.pos(t[i + 1]); }
        else { x = A.pos(t[i]); y = B.pos(t[i + 1]); }
        var r1 = Math.floor(x / 5), c1 = x % 5, r2 = Math.floor(y / 5), c2 = y % 5;
        out += enc ? A.sq[r1 * 5 + c2] + B.sq[r2 * 5 + c1] : P.sq[r1 * 5 + c2] + P.sq[r2 * 5 + c1];
      }
      return out;
    }
    function bifid(s, key, period, enc) {
      var S = makeSquare(key, 5, 'ij'), t = sqLetters(s, 5, 'ij'), p = +period || 0, out = '';
      if (p <= 0) p = t.length || 1;
      for (var b = 0; b < t.length; b += p) {
        var blk = t.substr(b, p), n = blk.length, i, seq = [];
        if (enc) {
          var rows = [], cols = [];
          for (i = 0; i < n; i++) { var x = S.pos(blk[i]); rows.push(Math.floor(x / 5)); cols.push(x % 5); }
          seq = rows.concat(cols);
          for (i = 0; i < 2 * n; i += 2) out += S.sq[seq[i] * 5 + seq[i + 1]];
        } else {
          for (i = 0; i < n; i++) { var y = S.pos(blk[i]); seq.push(Math.floor(y / 5), y % 5); }
          for (i = 0; i < n; i++) out += S.sq[seq[i] * 5 + seq[n + i]];
        }
      }
      return out;
    }
    function trifid(s, key, period, enc) {
      var base = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ+', cube = '', all = String(key || '').toUpperCase().replace(/\./g, '+') + base;
      for (var q = 0; q < all.length; q++) if (cube.indexOf(all[q]) < 0 && base.indexOf(all[q]) >= 0) cube += all[q];
      var t = s.toUpperCase().replace(/\./g, '+').replace(/[^A-Z+]/g, ''), p = +period || 0, out = '';
      if (p <= 0) p = t.length || 1;
      for (var b = 0; b < t.length; b += p) {
        var blk = t.substr(b, p), n = blk.length, i, seq = [];
        if (enc) {
          var L = [], R = [], C = [];
          for (i = 0; i < n; i++) { var x = cube.indexOf(blk[i]); L.push(Math.floor(x / 9)); R.push(Math.floor(x % 9 / 3)); C.push(x % 3); }
          seq = L.concat(R, C);
          for (i = 0; i < 3 * n; i += 3) out += cube[seq[i] * 9 + seq[i + 1] * 3 + seq[i + 2]];
        } else {
          for (i = 0; i < n; i++) { var y = cube.indexOf(blk[i]); seq.push(Math.floor(y / 9), Math.floor(y % 9 / 3), y % 3); }
          for (i = 0; i < n; i++) out += cube[seq[i] * 9 + seq[n + i] * 3 + seq[2 * n + i]];
        }
      }
      return out;
    }
    function adfgx(s, sqKey, tKey, six, enc) {
      var co = six ? 'ADFGVX' : 'ADFGX', S = makeSquare(sqKey, six ? 6 : 5, 'ij');
      if (!String(tKey || '').replace(/\s/g, '')) throw err('transposition key is required');
      if (enc) {
        var pre = sqNorm(s, S.size, 'ij').split('').map(function (c) { var p = S.pos(c); return co[Math.floor(p / S.size)] + co[p % S.size]; }).join('');
        return colEnc(pre, tKey);
      }
      var t = s.toUpperCase().replace(new RegExp('[^' + co + ']', 'g'), '');
      if (t.length % 2) throw err('odd ADFGX length');
      var u = colDec(t, tKey), out = '';
      for (var i = 0; i < u.length; i += 2) out += S.sq[co.indexOf(u[i]) * S.size + co.indexOf(u[i + 1])];
      return out;
    }
    function nihilist(s, sqKey, key, enc) {
      var S = makeSquare(sqKey, 5, 'ij');
      var num = function (c) { var p = S.pos(c); return (Math.floor(p / 5) + 1) * 10 + p % 5 + 1; };
      var kn = sqNorm(key, 5, 'ij').split('').map(num);
      if (!kn.length) throw err('key needs letters');
      if (enc) return sqNorm(s, 5, 'ij').split('').map(function (c, i) { return num(c) + kn[i % kn.length]; }).join(' ');
      var nums = numList(s, /[^0-9]+/).map(Number), out = '';
      for (var i = 0; i < nums.length; i++) {
        var v = nums[i] - kn[i % kn.length], r = Math.floor(v / 10), c = v % 10;
        if (r < 1 || r > 5 || c < 1 || c > 5) { out += '?'; continue; }
        out += S.sq[(r - 1) * 5 + c - 1];
      }
      return out;
    }

    // ---- transpositions --------------------------------------------------
    function keyOrder(key) {
      key = String(key == null ? '' : key).trim();
      var ranks;
      if (/^\d+(?:[\s,\-]+\d+)+$/.test(key) || /^\d+$/.test(key)) {
        var nums = /[\s,\-]/.test(key) ? key.split(/[\s,\-]+/).map(Number) : key.split('').map(Number);
        var sorted = nums.slice().sort(function (a, b) { return a - b; });
        ranks = nums.map(function (v, i) { return sorted.indexOf(v) + nums.slice(0, i).filter(function (w) { return w === v; }).length; });
      } else {
        var k = key.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!k) throw err('key needed');
        var idx = k.split('').map(function (c, i) { return i; });
        idx.sort(function (a, b) { return k[a] < k[b] ? -1 : k[a] > k[b] ? 1 : a - b; });
        ranks = new Array(k.length);
        idx.forEach(function (col, r) { ranks[col] = r; });
      }
      return ranks;
    }
    function colLayout(n, ranks) {
      var k = ranks.length, rows = Math.ceil(n / k), full = n - (rows - 1) * k, len = [];
      for (var c = 0; c < k; c++) len.push(c < full ? rows : rows - 1);
      var byRank = []; for (var c2 = 0; c2 < k; c2++) byRank[ranks[c2]] = c2;
      return { k: k, rows: rows, len: len, byRank: byRank };
    }
    function colDec(s, key) {
      var ranks = Array.isArray(key) ? key : keyOrder(key), ch = chars(s), n = ch.length, L = colLayout(n, ranks), cols = [], p = 0;
      for (var r = 0; r < L.k; r++) { var c = L.byRank[r]; cols[c] = ch.slice(p, p + L.len[c]); p += L.len[c]; }
      var out = '';
      for (var row = 0; row < L.rows; row++) for (var c3 = 0; c3 < L.k; c3++) if (row < cols[c3].length) out += cols[c3][row];
      return out;
    }
    function colEnc(s, key) {
      var ranks = Array.isArray(key) ? key : keyOrder(key), ch = chars(s), n = ch.length, L = colLayout(n, ranks), out = '';
      for (var r = 0; r < L.k; r++) { var c = L.byRank[r]; for (var i = c; i < n; i += L.k) out += ch[i]; }
      return out;
    }
    function identity(k) { var a = []; for (var i = 0; i < k; i++) a.push(i); return a; }
    function scytale(s, rows, enc) {
      rows = Math.max(2, +rows || 2);
      var n = chars(s).length, w = Math.ceil(n / rows);
      return enc ? colEnc(s, identity(w)) : colDec(s, identity(w));
    }
    function railPattern(n, r, off) {
      var cyc = 2 * (r - 1), out = new Array(n);
      for (var i = 0; i < n; i++) { var p = (i + off) % cyc; out[i] = p < r ? p : cyc - p; }
      return out;
    }
    function railFence(s, rails, offset, enc) {
      var r = Math.max(2, +rails || 2), ch = chars(s), n = ch.length, pat = railPattern(n, r, mod(+offset || 0, 2 * (r - 1)));
      var order = [];
      for (var rail = 0; rail < r; rail++) for (var i = 0; i < n; i++) if (pat[i] === rail) order.push(i);
      if (enc) return order.map(function (i) { return ch[i]; }).join('');
      var out = new Array(n);
      for (var j = 0; j < n; j++) out[order[j]] = ch[j];
      return out.join('');
    }
    var ROUTES = [['snakeRows', 'Boustrophedon rows'], ['cols', 'Down columns'], ['colsUp', 'Up columns'], ['snakeCols', 'Snake columns'], ['spiral', 'Spiral clockwise'], ['spiralCCW', 'Spiral counter-clockwise'], ['spiralIn', 'Spiral from centre'], ['diag', 'Diagonals']];
    function routeOrder(rows, cols, type) {
      var o = [], r, c;
      if (type === 'cols') { for (c = 0; c < cols; c++) for (r = 0; r < rows; r++) o.push(r * cols + c); }
      else if (type === 'colsUp') { for (c = 0; c < cols; c++) for (r = rows - 1; r >= 0; r--) o.push(r * cols + c); }
      else if (type === 'snakeCols') { for (c = 0; c < cols; c++) for (r = 0; r < rows; r++) o.push((c % 2 ? rows - 1 - r : r) * cols + c); }
      else if (type === 'snakeRows') { for (r = 0; r < rows; r++) for (c = 0; c < cols; c++) o.push(r * cols + (r % 2 ? cols - 1 - c : c)); }
      else if (type === 'diag') { for (var d = 0; d < rows + cols - 1; d++) for (r = 0; r < rows; r++) { c = d - r; if (c >= 0 && c < cols) o.push(r * cols + c); } }
      else {
        var top = 0, bot = rows - 1, left = 0, right = cols - 1, ccw = type === 'spiralCCW';
        while (top <= bot && left <= right) {
          if (!ccw) {
            for (c = left; c <= right; c++) o.push(top * cols + c);
            for (r = top + 1; r <= bot; r++) o.push(r * cols + right);
            if (top < bot) for (c = right - 1; c >= left; c--) o.push(bot * cols + c);
            if (left < right) for (r = bot - 1; r > top; r--) o.push(r * cols + left);
          } else {
            for (r = top; r <= bot; r++) o.push(r * cols + left);
            for (c = left + 1; c <= right; c++) o.push(bot * cols + c);
            if (left < right) for (r = bot - 1; r >= top; r--) o.push(r * cols + right);
            if (top < bot) for (c = right - 1; c > left; c--) o.push(top * cols + c);
          }
          top++; bot--; left++; right--;
        }
        if (type === 'spiralIn') o.reverse();
      }
      return o;
    }
    function route(s, cols, type, enc) {
      cols = Math.max(2, +cols || 2);
      var ch = chars(s), n = ch.length, rows = Math.ceil(n / cols);
      var order = routeOrder(rows, cols, type || 'snakeRows').filter(function (i) { return i < n; });
      if (enc) return order.map(function (i) { return ch[i]; }).join('');
      var out = new Array(n);
      for (var j = 0; j < n; j++) out[order[j]] = ch[j];
      return out.join('');
    }
    function hillKey(key) {
      var k = String(key || '').trim(), m;
      if (/\d/.test(k)) m = k.split(/[^0-9-]+/).filter(Boolean).map(Number);
      else m = lettersOnly(k).split('').map(function (c) { return c.charCodeAt(0) - 65; });
      if (m.length !== 4) throw err('Hill 2×2 key: 4 numbers (a b c d) or a 4-letter word');
      return m.map(function (v) { return mod(v, 26); });
    }
    function hillInv(m) {
      var det = mod(m[0] * m[3] - m[1] * m[2], 26), di = modInv(det, 26);
      if (di < 0 || gcd(det, 26) !== 1) return null;
      return [mod(di * m[3], 26), mod(-di * m[1], 26), mod(-di * m[2], 26), mod(di * m[0], 26)];
    }
    function hillApply(t, m) {
      var out = '';
      for (var i = 0; i + 1 < t.length; i += 2) {
        var a = t.charCodeAt(i) - 65, b = t.charCodeAt(i + 1) - 65;
        out += UP[mod(m[0] * a + m[1] * b, 26)] + UP[mod(m[2] * a + m[3] * b, 26)];
      }
      return out;
    }
    function hill(s, key, enc) {
      var m = hillKey(key), t = lettersOnly(s);
      if (t.length % 2) t += 'X';
      if (enc) return hillApply(t, m);
      var inv = hillInv(m);
      if (!inv) throw err('key matrix is not invertible mod 26');
      return hillApply(t, inv);
    }
    function parseKeyBytes(key, type) {
      key = String(key == null ? '' : key);
      if (type === 'hex') return hexDec(key);
      if (type === 'dec') return new Uint8Array(numList(key, /[^0-9]+/).map(function (v) { return +v & 255; }));
      if (type === 'b64') return b64Dec(key);
      return utf8Encode(key);
    }
    function xorBytes(b, key) {
      if (!key.length) throw err('empty XOR key');
      var out = new Uint8Array(b.length);
      for (var i = 0; i < b.length; i++) out[i] = b[i] ^ key[i % key.length];
      return out;
    }

    // ===================================================================
    // Language data + plausibility scoring
    // ===================================================================
    var CODE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
    var LANGS = {}, LATIN = [], SCRIPTS = {}, HAVE_DATA = false;
    var GREEK_LO = 'αβγδεζηθικλμνξοπρστυφχψω';
    var COMB = /[\u0300-\u036f]/g;
    function unpackGrams(packed, n, A) {
      var size = Math.pow(A, n), tab = new Uint8Array(size), hi = packed[0], max = 0, b, i, j;
      var ci = {}; for (i = 0; i < CODE.length; i++) ci[CODE[i]] = i;
      for (b = 1; b < packed.length; b++) {
        var s = packed[b], v = hi + b - 1;
        for (i = 0; i < s.length; i += n) {
          var k = 0; for (j = 0; j < n; j++) k = k * A + ci[s[i + j]];
          tab[k] = v;
        }
        if (s.length) max = v;
      }
      var floor = Math.min(255, max + 12);
      for (i = 0; i < size; i++) if (!tab[i]) tab[i] = floor;
      return tab;
    }
    function setData(data) {
      if (!data || !data.langs) return false;
      LANGS = {}; LATIN = []; SCRIPTS = {};
      Object.keys(data.langs).forEach(function (code) {
        var L = data.langs[code], A = L.script === 'Latin' ? 26 : L.alpha.length;
        var uni = new Float64Array(A), logUni = new Float64Array(A), tot = 0, i;
        for (i = 0; i < A; i++) { uni[i] = Math.max(L.uni[i] || 0, 5) / 100000; tot += uni[i]; }
        for (i = 0; i < A; i++) { uni[i] /= tot; logUni[i] = Math.log(uni[i]); }
        var words = {}; L.words.split(' ').forEach(function (w) { if (w) words[w] = 1; });
        var acc = {}; (L.acc || '').split(',').forEach(function (p) { if (p) acc[p[0]] = +p.slice(1) / 100000; });
        var o = {
          code: code, name: L.name, script: L.script, A: A, alpha: L.script === 'Latin' ? LO : L.alpha,
          ic: L.ic, t3: unpackGrams(L.t3, 3, A), t4: L.t4 ? unpackGrams(L.t4, 4, A) : null,
          uni: uni, logUni: logUni, words: words, acc: acc, exp: L.exp,
        };
        LANGS[code] = o;
        if (L.script === 'Latin') LATIN.push(o);
      });
      var sc = data.scripts || {};
      Object.keys(sc).forEach(function (k) {
        var set = {};
        if (sc[k].words) sc[k].words.split(' ').forEach(function (w) { if (w) set[w] = 1; });
        if (sc[k].chars) chars(sc[k].chars).forEach(function (c) { set[c] = 1; });
        SCRIPTS[k] = { name: sc[k].name, set: set, words: !!sc[k].words };
      });
      HAVE_DATA = true;
      return true;
    }
    function foldLatin(s) {
      s = s.toLowerCase();
      try { s = s.normalize('NFD').replace(COMB, ''); } catch (e) {}
      return s.replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/ı/g, 'i').replace(/đ/g, 'd');
    }
    function latinIdx(f) {
      var a = new Uint8Array(f.length), n = 0;
      for (var i = 0; i < f.length; i++) { var c = f.charCodeAt(i) - 97; if (c >= 0 && c < 26) a[n++] = c; }
      return a.subarray(0, n);
    }
    function asciiIdx(s) { // ASCII letters only, no folding (what classical ciphers act on)
      var a = new Uint8Array(s.length), n = 0;
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c >= 65 && c <= 90) a[n++] = c - 65; else if (c >= 97 && c <= 122) a[n++] = c - 97;
      }
      return a.subarray(0, n);
    }
    function foldCyr(s) { return s.toLowerCase().replace(/ё/g, 'е'); }
    function cyrIdx(f) {
      var a = new Uint8Array(f.length), n = 0;
      for (var i = 0; i < f.length; i++) { var c = f.charCodeAt(i) - 0x430; if (c >= 0 && c < 32) a[n++] = c; }
      return a.subarray(0, n);
    }
    function foldGreek(s) {
      s = s.toLowerCase();
      try { s = s.normalize('NFD').replace(COMB, ''); } catch (e) {}
      return s.replace(/ς/g, 'σ');
    }
    var GREEK_MAP = (function () { var m = {}; for (var i = 0; i < GREEK_LO.length; i++) m[GREEK_LO.charCodeAt(i)] = i; return m; })();
    function greekIdx(f) {
      var a = new Uint8Array(f.length), n = 0;
      for (var i = 0; i < f.length; i++) { var v = GREEK_MAP[f.charCodeAt(i)]; if (v !== undefined) a[n++] = v; }
      return a.subarray(0, n);
    }
    function gramAvg(tab, idx, n, A) {
      var len = idx.length - n + 1;
      if (len <= 0) return 0;
      var s = 0, i;
      if (n === 3) { for (i = 0; i < len; i++) s += tab[(idx[i] * A + idx[i + 1]) * A + idx[i + 2]]; }
      else if (n === 4) { for (i = 0; i < len; i++) s += tab[((idx[i] * A + idx[i + 1]) * A + idx[i + 2]) * A + idx[i + 3]]; }
      return s / len;
    }
    function ngNorm(L, idx) {
      if (idx.length < 3) return -1;
      return clamp((L.exp.rnd - gramAvg(L.t3, idx, 3, L.A)) / (L.exp.rnd - L.exp.t3), 0, 1.15);
    }
    function wordHits(words, set) {
      var hit = 0, tot = 0;
      for (var i = 0; i < words.length; i++) {
        var w = words[i], wt = w.length > 1 ? Math.min(w.length, 6) : 0.5;
        tot += wt; if (set[w]) hit += wt;
      }
      return tot ? hit / tot : 0;
    }
    function cosine(counts, uni) {
      var dot = 0, a = 0, b = 0;
      for (var i = 0; i < uni.length; i++) { dot += counts[i] * uni[i]; a += counts[i] * counts[i]; b += uni[i] * uni[i]; }
      return a && b ? dot / Math.sqrt(a * b) : 0;
    }
    function countIdx(idx, A) { var c = new Float64Array(A); for (var i = 0; i < idx.length; i++) c[idx[i]]++; return c; }

    // Character classes by script (fast, single pass over UTF-16 units).
    function classify(s) {
      var c = { n: 0, latin: 0, cyr: 0, greek: 0, arabic: 0, hebrew: 0, han: 0, kana: 0, hangul: 0, deva: 0, thai: 0, otherL: 0, digit: 0, space: 0, punct: 0, ctrl: 0, bad: 0, upper: 0, lower: 0, comb: 0, sym: 0, ascii: 0 };
      for (var i = 0; i < s.length; i++) {
        var k = s.charCodeAt(i);
        c.n++;
        if (k < 128) {
          c.ascii++;
          if (k >= 65 && k <= 90) { c.latin++; c.upper++; }
          else if (k >= 97 && k <= 122) { c.latin++; c.lower++; }
          else if (k >= 48 && k <= 57) c.digit++;
          else if (k === 32 || k === 9 || k === 10 || k === 13) c.space++;
          else if (k < 32 || k === 127) c.ctrl++;
          else c.punct++;
        }
        else if (k < 0xa0) c.ctrl++;
        else if (k < 0x250) {
          if (k === 0xd7 || k === 0xf7 || k < 0xc0) { if (k === 0xa0) c.space++; else c.punct++; }
          else { c.latin++; if (s[i] !== s[i].toLowerCase()) c.upper++; else c.lower++; }
        }
        else if (k < 0x2b0) c.otherL++;
        else if (k >= 0x300 && k < 0x370) c.comb++;
        else if (k >= 0x370 && k < 0x400) c.greek++;
        else if (k >= 0x400 && k < 0x530) { c.cyr++; if (s[i] !== s[i].toLowerCase()) c.upper++; else c.lower++; }
        else if (k >= 0x590 && k < 0x600) { if (k >= 0x5d0) c.hebrew++; else c.comb++; }
        else if (k >= 0x600 && k < 0x700) { if ((k >= 0x621 && k <= 0x64a) || (k >= 0x671 && k <= 0x6d3)) c.arabic++; else if (k >= 0x64b && k <= 0x65f) c.comb++; else c.punct++; }
        else if (k >= 0x900 && k < 0x980) { if (k >= 0x904 && k <= 0x939) c.deva++; else c.comb++; }
        else if (k >= 0xe00 && k < 0xe80) c.thai++;
        else if ((k >= 0x1100 && k < 0x1200) || (k >= 0x3130 && k < 0x3190) || (k >= 0xac00 && k < 0xd7b0)) c.hangul++;
        else if (k >= 0x1e00 && k < 0x1f00) c.latin++;
        else if (k >= 0x1f00 && k < 0x2000) c.greek++;
        else if (k >= 0x2000 && k < 0x200b) c.space++;
        else if ((k >= 0x200b && k < 0x2010) || (k >= 0x2028 && k < 0x202f) || (k >= 0x2060 && k < 0x2070) || k === 0xfeff) c.ctrl++;
        else if (k >= 0x2010 && k < 0x2070) c.punct++;
        else if ((k >= 0x3040 && k < 0x3100) || (k >= 0x31f0 && k < 0x3200) || (k >= 0xff66 && k < 0xffa0)) c.kana++;
        else if ((k >= 0x4e00 && k < 0xa000) || (k >= 0x3400 && k < 0x4dc0) || (k >= 0xf900 && k < 0xfb00)) c.han++;
        else if ((k >= 0x3000 && k < 0x3040) || (k >= 0xff00 && k < 0xff66)) c.punct++;
        else if (k === 0xfffd || (k >= 0xe000 && k < 0xf900)) c.bad++;
        else if (k >= 0xd800 && k < 0xdc00) { c.sym++; i++; }
        else if (k >= 0xdc00 && k < 0xe000) c.bad++;
        else if (k >= 0x20d0 && k < 0x2100) c.comb++;
        else c.sym++;
      }
      return c;
    }
    var SCRIPT_KEYS = ['latin', 'cyr', 'greek', 'arabic', 'hebrew', 'cjk', 'deva', 'thai'];
    // Capitals inside a word: random-case junk (Base64 …) has them everywhere;
    // run-together words keep each capital at the start of a lowercase run
    // ("DasWetterwarschön", "iPhone"), which is not penalised.
    var CAMEL = /^[A-Za-z][a-z]*(?:[A-Z][a-z]{2,})+$/;
    function mixedCase(s) {
      var ws = s.match(/[A-Za-z]{3,}/g) || [], bad = 0;
      for (var i = 0; i < ws.length; i++) {
        var w = ws[i], r = w.slice(1);
        if (r !== r.toLowerCase() && w !== w.toUpperCase() && !CAMEL.test(w)) bad++;
      }
      return ws.length ? bad / ws.length : 0;
    }
    // Text written without spaces, one run per line (or a few runs): its
    // "words" are whole lines, so dictionary hits say nothing about it. Real
    // prose averages 4–7 letters a word even in compounding languages.
    function runOn(words, letters) {
      if (words.length < 2) return false;
      var long = 0;
      for (var i = 0; i < words.length; i++) if (words[i].length >= 13) long += words[i].length;
      return letters / words.length >= 9 || long >= letters * 0.6;
    }
    function langModel(L, idx, words, spaced, run) {
      var ng = ngNorm(L, idx), wh = words.length ? clamp(wordHits(words, L.words) / L.exp.wh, 0, 1.15) : 0, comb;
      if (ng < 0) comb = wh * 0.9;
      else if (spaced) comb = Math.max(0.55 * ng + 0.45 * wh, 0.72 * ng); // rare/technical vocabulary still reads
      else if (words.length >= 2 && words.some(function (w) { return w.length > 1; })) comb = 0.55 * ng + 0.45 * wh;
      else if (words.length && wh > 0) comb = Math.max(ng, 0.45 * ng + 0.55 * wh);
      else comb = ng;
      // run-together lines read like one unspaced run: n-grams decide (as they
      // already do when the same text is on a single line)
      if (run && ng > comb) comb = ng;
      // "a b cd e" — real prose averages 4–5 letters a word
      if (words.length >= 4) {
        var wl = 0; for (var wi = 0; wi < words.length; wi++) wl += words[wi].length;
        wl /= words.length;
        if (wl < 2.6) comb *= (wl / 2.6) * (wl / 2.6);
      }
      // n-gram fitness alone can be gamed (a hill-climbed "solution" full of
      // the/ate/ere): real text also keeps the language's letter balance.
      if (idx.length >= 30) {
        var cs = cosine(countIdx(idx, L.A), L.uni), need = 0.92 - 6 / idx.length;
        if (cs < need) comb *= clamp(1 - (need - cs) * 5, 0.3, 1);
      }
      return { ng: ng, wh: wh, comb: comb };
    }
    function latinModel(s) {
      var f = foldLatin(s), idx = latinIdx(f), words = f.match(/[a-z]+/g) || [];
      var run = runOn(words, idx.length), spaced = !run && words.length >= 3 && /\s/.test(s);
      var acc = s.toLowerCase().match(/[à-öø-ɏ]/g) || [];
      // mojibake (legacy-charset views of random bytes) is dense with accents
      var accR = idx.length ? acc.length / idx.length : 0, accF = accR > 0.15 ? clamp(1 - (accR - 0.15) * 3.5, 0.15, 1) : 1;
      var best = null, second = null, all = [];
      for (var i = 0; i < LATIN.length; i++) {
        var L = LATIN[i], m = langModel(L, idx, words, spaced, run);
        if (acc.length) {
          var a = 0;
          for (var j = 0; j < acc.length; j++) a += L.acc[acc[j]] ? 1 : -1;
          m.comb += 0.12 * a / acc.length;
        }
        m.comb *= accF;
        m.code = L.code; m.name = L.name;
        all.push(m);
        if (!best || m.comb > best.comb) { second = best; best = m; } else if (!second || m.comb > second.comb) second = m;
      }
      return { best: best, second: second, all: all, letters: idx.length };
    }
    function singleModel(code, idx, words, s) {
      var L = LANGS[code];
      if (!L) return null;
      var run = runOn(words, idx.length), m = langModel(L, idx, words, !run && words.length >= 3 && /\s/.test(s), run);
      m.code = code; m.name = L.name;
      return { best: m, second: null, letters: idx.length };
    }
    function scriptWordModel(key, s, tokens) {
      var S = SCRIPTS[key];
      if (!S) return 0.55;
      var hit = 0, tot = 0, i;
      if (S.words) {
        for (i = 0; i < tokens.length; i++) { tot++; if (S.set[tokens[i]]) hit++; }
        if (tot < 3) return 0.6;
        return 0.45 + 0.5 * clamp(hit / tot / 0.18, 0, 1);
      }
      for (i = 0; i < s.length; i++) { var ch = s[i]; if (ch.charCodeAt(0) > 0x2e80) { tot++; if (S.set[ch]) hit++; } }
      if (tot < 2) return 0.5;
      return 0.3 + 0.62 * clamp(hit / tot / 0.55, 0, 1);
    }
    var FLAG_RE = /(^|[^A-Za-z0-9_])([A-Za-z][A-Za-z0-9_\-]{1,24})\{([^{}\n]{3,160})\}/;
    var FLAG_PRE = /(flag|ctf|htb|thm|key|pico|ductf|uiuctf|csaw|hack|ecsc|cyber|secret)/i;
    function special(s) {
      var t = s.trim(), fm = t.length < 600 ? FLAG_RE.exec(t) : null;
      if (fm) {
        var inner = fm[3], good = (inner.match(/[A-Za-z0-9_]/g) || []).length / inner.length;
        var rest = (t.slice(0, fm.index + fm[1].length) + ' ' + t.slice(fm.index + fm[0].length)).trim();
        var restOk = rest.length <= 3 || /^[\w\s.,:;!?'"()-]*$/.test(rest);
        if (restOk && good >= 0.8 && (FLAG_PRE.test(fm[2]) || /_/.test(inner))) return { score: FLAG_PRE.test(fm[2]) ? 92 : 85, lang: 'flag', langName: 'CTF flag', conf: 0.9 };
      }
      if (/^[\[{][\s\S]*[\]}]$/.test(t) && t.length < 200000) {
        try { var j = JSON.parse(t); if (j && typeof j === 'object') return { score: 82, lang: 'json', langName: 'JSON', conf: 0.95 }; } catch (e) {}
      }
      if (/^(https?|ftp):\/\/[^\s"<>]{3,}$/i.test(t)) return { score: 80, lang: 'url', langName: 'URL', conf: 0.95 };
      if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(t)) return { score: 78, lang: 'email', langName: 'E-mail address', conf: 0.9 };
      if (t.length < 254 && !/(^|\.)[a-z0-9]{2}--/i.test(t) && /^(?:[a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]{0,61}[a-z0-9\u00a1-\uffff])?\.)+(com|org|net|edu|gov|io|dev|app|ai|co|uk|us|de|fr|es|it|nl|ru|jp|cn|br|pt|ch|at|be|eu|info|biz|me|tv|ca|au|se|no|dk|fi|pl|cz|gr|in|xyz|online|site|tech|onion|local|test|example)$/i.test(t) && /[a-z\u00a1-\uffff]{3}/i.test(t)) return { score: 76, lang: 'domain', langName: 'Domain name', conf: 0.85 };
      return null;
    }
    // score(text) -> { score 0..100, lang, langName, conf 0..1, script }
    function score(t) {
      var zero = { score: 0, lang: '', langName: '', conf: 0, script: '' };
      if (t == null || !t.length) return zero;
      var s = t.length > 2500 ? t.slice(0, 2500) : t;
      var c = classify(s), visible = c.n - c.space;
      if (visible <= 0) return zero;
      var sp = special(s);
      var pr = 1 - (c.ctrl + c.bad) / c.n, fP = Math.pow(Math.max(0, pr), 4);
      var cjk = c.han + c.kana + c.hangul;
      var counts = { latin: c.latin, cyr: c.cyr, greek: c.greek, arabic: c.arabic, hebrew: c.hebrew, cjk: cjk, deva: c.deva, thai: c.thai };
      var letters = c.latin + c.cyr + c.greek + c.arabic + c.hebrew + cjk + c.deva + c.thai + c.otherL;
      if (!letters || !HAVE_DATA) {
        if (sp) return sp;
        return { score: Math.round(4 * fP), lang: '', langName: '', conf: 0, script: '' };
      }
      var prim = 'latin';
      for (var k = 0; k < SCRIPT_KEYS.length; k++) if (counts[SCRIPT_KEYS[k]] > counts[prim]) prim = SCRIPT_KEYS[k];
      var purity = counts[prim] / letters, base = 0, lang = '', langName = '', conf = 0, script = prim, model = null, cap = 1;
      if (prim === 'latin') model = latinModel(s);
      else if (prim === 'cyr') { var fc = foldCyr(s); model = singleModel('ru', cyrIdx(fc), fc.match(/[а-я]+/g) || [], s); }
      else if (prim === 'greek') { var fg = foldGreek(s); model = singleModel('el', greekIdx(fg), fg.match(/[α-ω]+/g) || [], s); }
      if (model && model.best) {
        base = model.best.comb; lang = model.best.code; langName = model.best.name;
        var margin = model.second ? model.best.comb - model.second.comb : 0.25;
        conf = clamp(0.35 + margin * 3, 0, 1) * clamp(base * 1.1, 0, 1);
        if (model.letters < 25) conf *= 0.6 + 0.4 * model.letters / 25;
      } else {
        cap = 0.9;
        var toks = s.split(/[\s.,;:!?()"'،।]+/).filter(Boolean);
        if (prim === 'arabic') { base = scriptWordModel('Arabic', s, toks); lang = 'ar'; langName = 'Arabic'; }
        else if (prim === 'hebrew') { base = scriptWordModel('Hebrew', s, toks); lang = 'he'; langName = 'Hebrew'; }
        else if (prim === 'deva') { base = scriptWordModel('Devanagari', s, toks); lang = 'hi'; langName = 'Hindi'; }
        else if (prim === 'thai') { base = 0.6; lang = 'th'; langName = 'Thai'; }
        else if (prim === 'cjk') {
          if (c.hangul >= c.han + c.kana) { base = scriptWordModel('Hangul', s, toks); lang = 'ko'; langName = 'Korean'; }
          else if (c.kana > (c.han + c.kana) * 0.15) {
            var kb = scriptWordModel('Kana', s, toks), hb = scriptWordModel('Han', s, toks);
            base = Math.max(kb, (kb + hb) / 2); lang = 'ja'; langName = 'Japanese';
          } else { base = scriptWordModel('Han', s, toks); lang = 'zh'; langName = 'Chinese'; }
        }
        conf = clamp(base, 0, 1) * 0.8;
      }
      var lf = (letters + c.comb * 0) / visible, fL = lf >= 0.62 ? 1 : Math.pow(lf / 0.62, 1.6);
      var fC = prim === 'latin' ? 1 - 0.75 * mixedCase(s) : 1;
      var fS = 1;
      var nl = model ? model.letters : letters;
      var hits = model && model.best && model.best.wh >= 0.9;
      // a handful of letters proves little unless they form dictionary words
      if (nl < 16 && !hits) fS = 0.35 + 0.65 * nl / 16;
      else if (nl < 12) fS = 0.55 + 0.45 * nl / 12;
      if (hits && nl >= 3) fS = Math.max(fS, 0.92);
      if (nl >= 6 && model) {
        var dl = {}, dn = 0, ss = s.toLowerCase();
        for (var q = 0; q < ss.length; q++) { var ch = ss[q]; if (ch !== ch.toUpperCase() && !dl[ch]) { dl[ch] = 1; dn++; } }
        if (dn / nl < 0.34 && nl < 40) fS *= 0.6;
      }
      var fPur = Math.pow(purity, 2);
      var zal = c.comb > letters * 0.5 ? 0.5 : 1;
      var sc = 100 * clamp(Math.min(base, cap), 0, 1) * fP * fL * fC * fS * fPur * zal;
      var out = { score: Math.round(sc), lang: lang, langName: langName, conf: Math.round(conf * 100) / 100, script: prim, wh: model && model.best ? Math.round(model.best.wh * 100) / 100 : 0, letters: nl };
      if (sp) { sp.script = prim; sp.score = Math.max(sp.score, out.score); return sp; }
      return out;
    }
    // Score for byte values: best charset view, or a recognised file type.
    function scoreBytes(b) {
      var mg = magic(b);
      if (mg && mg.ext !== 'gz') return { score: 72, lang: 'file', langName: mg.name, conf: 0.9, script: '', ext: mg.ext };
      return { score: 0, lang: '', langName: '', conf: 0, script: '' };
    }
    // Text views of bytes that are not UTF-8: try the legacy charsets that
    // make sense for the byte pattern; keep the best-scoring readable one.
    function bytesViews(b) {
      var u = utf8Strict(b);
      if (u !== null) return [{ t: u, cs: 'utf-8' }];
      var n = Math.min(b.length, 65536), sub = b.subarray(0, n), hi = 0, zeroEven = 0, zeroOdd = 0, i;
      for (i = 0; i < n; i++) { if (sub[i] >= 0x80) hi++; if (!sub[i]) { if (i % 2) zeroOdd++; else zeroEven++; } }
      var out = [];
      var add = function (cs) { var t = decodeCharset(b, cs, true); if (t !== null && t.length) out.push({ t: t, cs: cs }); };
      if (n >= 4 && n % 2 === 0) {
        if (zeroEven > n * 0.2 || (b[0] === 0xfe && b[1] === 0xff)) add('utf-16be');
        if (zeroOdd > n * 0.2 || (b[0] === 0xff && b[1] === 0xfe)) add('utf-16le');
      }
      if (hi) {
        ['windows-1252', 'windows-1251', 'koi8-r', 'iso-8859-7', 'windows-1250'].forEach(add);
        if (hi > n * 0.25) ['shift_jis', 'euc-jp', 'gbk', 'big5', 'euc-kr'].forEach(add);
      }
      return out;
    }

    // ===================================================================
    // Analysis (charts + identifier input)
    // ===================================================================
    var ALPHA_UP = { latin: UP, cyr: 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', greek: 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ' };
    function icOf(counts, N) { if (N < 2) return 0; var s = 0; for (var i = 0; i < counts.length; i++) s += counts[i] * (counts[i] - 1); return s / (N * (N - 1)); }
    function entropyOf(counts, N, base) {
      if (!N) return 0;
      var h = 0, lb = Math.log(base || 2);
      for (var k in counts) { var p = counts[k] / N; if (p > 0) h -= p * Math.log(p) / lb; }
      return h;
    }
    function periodicIC(idx, A, maxL) {
      var res = [];
      for (var L = 1; L <= maxL; L++) {
        var sum = 0, cols = 0;
        for (var j = 0; j < L; j++) {
          var c = new Float64Array(A), n = 0;
          for (var i = j; i < idx.length; i += L) { c[idx[i]]++; n++; }
          if (n >= 2) { sum += icOf(c, n); cols++; }
        }
        res.push({ L: L, ic: cols ? sum / cols : 0 });
      }
      return res;
    }
    function kasiski(idx, A, alpha, maxL) {
      var n = Math.min(idx.length, 4000), S = '', i, len;
      for (i = 0; i < n; i++) S += alpha[idx[i]];
      var reps = [], seen = {};
      for (len = 8; len >= 3; len--) {
        var map = {};
        for (i = 0; i + len <= n; i++) { var k = S.substr(i, len); (map[k] = map[k] || []).push(i); }
        for (var key in map) {
          var pos = map[key];
          if (pos.length < 2) continue;
          // skip a repeat fully explained by a longer one already recorded
          var sig = pos.join(',');
          var covered = false;
          for (var q = 0; q < reps.length && !covered; q++) {
            if (reps[q].seq.length > len && reps[q].seq.indexOf(key) >= 0 && reps[q].pos.length === pos.length) covered = true;
          }
          if (covered || seen[sig + len]) continue;
          seen[sig + len] = 1;
          var sp = [];
          for (var p = 1; p < pos.length; p++) sp.push(pos[p] - pos[p - 1]);
          reps.push({ seq: key, pos: pos, spacings: sp });
        }
        if (reps.length > 400) break;
      }
      reps.sort(function (a, b) { return b.seq.length - a.seq.length || b.pos.length - a.pos.length; });
      var factors = [];
      for (var f = 2; f <= maxL; f++) factors.push({ f: f, count: 0 });
      reps.forEach(function (r) {
        var w = r.seq.length - 2;
        r.spacings.forEach(function (d) { factors.forEach(function (fc) { if (d % fc.f === 0) fc.count += w; }); });
      });
      return { repeats: reps.slice(0, 40), total: reps.length, factors: factors };
    }
    function scriptOf(t) {
      var c = classify(t.length > 5000 ? t.slice(0, 5000) : t);
      if (c.cyr > c.latin && c.cyr >= c.greek) return 'cyr';
      if (c.greek > c.latin) return 'greek';
      return 'latin';
    }
    function letterStream(t, script) {
      if (script === 'cyr') return cyrIdx(foldCyr(t));
      if (script === 'greek') return greekIdx(foldGreek(t));
      return latinIdx(foldLatin(t));
    }
    function langsOfScript(script) {
      var sc = script === 'cyr' ? 'Cyrillic' : script === 'greek' ? 'Greek' : 'Latin';
      return Object.keys(LANGS).map(function (k) { return LANGS[k]; }).filter(function (L) { return L.script === sc; });
    }
    function analyze(input, opt) {
      opt = opt || {};
      var isB = isBytes(input), bytes = isB ? input : null, t;
      if (isB) { t = utf8Strict(input); if (t === null) t = latin1(input); }
      else t = String(input || '');
      if (t.length > 300000) t = t.slice(0, 300000);
      var a = { isBytes: isB, len: t.length, cps: chars(t.length > 20000 ? t.slice(0, 20000) : t).length };
      if (!bytes) bytes = utf8Encode(t.length > 200000 ? t.slice(0, 200000) : t);
      a.bytes = bytes.length;
      a.lines = t ? t.split('\n').length : 0;
      a.words = (t.match(/\S+/g) || []).length;
      var c = classify(t);
      a.classes = { upper: c.upper, lower: c.lower, digit: c.digit, space: c.space, punct: c.punct, other: c.sym + c.comb + c.otherL, nonAscii: c.n - c.ascii, control: c.ctrl + c.bad, letters: c.latin + c.cyr + c.greek + c.arabic + c.hebrew + c.han + c.kana + c.hangul + c.deva + c.thai + c.otherL };
      var script = opt.script || scriptOf(t), alpha = ALPHA_UP[script], A = alpha.length;
      var idx = letterStream(t, script), N = idx.length, counts = countIdx(idx, A);
      a.script = script; a.alpha = alpha; a.N = N; a.counts = Array.prototype.slice.call(counts);
      a.ic = icOf(counts, N);
      a.icRandom = 1 / A;
      a.icRefs = langsOfScript(script).map(function (L) { return { code: L.code, name: L.name, ic: L.ic }; });
      var maxL = Math.min(20, Math.max(1, Math.floor(N / 2)));
      a.periodic = periodicIC(idx, A, maxL);
      a.kasiski = kasiski(idx, A, alpha, Math.max(2, maxL));
      var langIC = a.icRefs.length ? a.icRefs[0].ic : 0.066;
      if (opt.lang && LANGS[opt.lang]) langIC = LANGS[opt.lang].ic;
      a.friedman = N > 1 && a.ic > a.icRandom ? (langIC - a.icRandom) * N / ((N - 1) * a.ic - a.icRandom * N + langIC) : 0;
      // key-length ranking: periodic IC (normalised) + Kasiski factor support
      var maxF = 0; a.kasiski.factors.forEach(function (f) { if (f.count > maxF) maxF = f.count; });
      var maxIc = 0; a.periodic.forEach(function (p) { if (p.L > 1 && p.ic > maxIc) maxIc = p.ic; });
      a.keyLengths = a.periodic.filter(function (p) { return p.L > 1; }).map(function (p) {
        var f = a.kasiski.factors[p.L - 2], icn = clamp((p.ic - a.icRandom) / (langIC - a.icRandom), 0, 1.2);
        var kas = maxF && f ? f.count / maxF : 0;
        return { L: p.L, ic: p.ic, icNorm: icn, kasiski: kas, score: 0.65 * icn + 0.35 * kas, peak: maxIc > 0 && p.ic >= maxIc * 0.92 };
      });
      // a multiple of the true length scores as well as the length itself: prefer the smallest near-best
      var ranked = a.keyLengths.slice().sort(function (x, y) { return y.score - x.score; });
      var bestS = ranked.length ? ranked[0].score : 0;
      a.keySuggest = ranked.filter(function (k) { return k.score >= bestS * 0.85; }).sort(function (x, y) { return x.L - y.L; }).slice(0, 3)
        .concat(ranked.slice(0, 3)).filter(function (k, i, arr) { return arr.indexOf(k) === i; }).slice(0, 4);
      // bigrams / trigrams / doubled letters
      var bm = new Array(A * A); for (var i = 0; i < bm.length; i++) bm[i] = 0;
      var doubles = 0, dl = {}, tri = {};
      for (i = 0; i + 1 < N; i++) {
        bm[idx[i] * A + idx[i + 1]]++;
        if (idx[i] === idx[i + 1]) { doubles++; dl[alpha[idx[i]]] = (dl[alpha[idx[i]]] || 0) + 1; }
        if (i + 2 < N && i < 60000) { var tg = alpha[idx[i]] + alpha[idx[i + 1]] + alpha[idx[i + 2]]; tri[tg] = (tri[tg] || 0) + 1; }
      }
      var big = [];
      for (i = 0; i < bm.length; i++) if (bm[i]) big.push({ g: alpha[Math.floor(i / A)] + alpha[i % A], n: bm[i] });
      big.sort(function (x, y) { return y.n - x.n; });
      a.bigrams = { top: big.slice(0, 24), matrix: bm, max: big.length ? big[0].n : 0, total: Math.max(0, N - 1), distinct: big.length };
      a.doubles = { count: doubles, letters: Object.keys(dl).sort(function (x, y) { return dl[y] - dl[x]; }).slice(0, 8).map(function (k) { return { l: k, n: dl[k] }; }) };
      a.trigrams = Object.keys(tri).map(function (k) { return { g: k, n: tri[k] }; }).sort(function (x, y) { return y.n - x.n; }).slice(0, 15);
      // entropy family
      var cc = {}, cn = 0;
      for (i = 0; i < t.length && i < 200000; i++) { var ch = t[i]; cc[ch] = (cc[ch] || 0) + 1; cn++; }
      var bc = {}, bh = new Array(256); for (i = 0; i < 256; i++) bh[i] = 0;
      for (i = 0; i < bytes.length; i++) bh[bytes[i]]++;
      for (i = 0; i < 256; i++) if (bh[i]) bc[i] = bh[i];
      var lc = {}; for (i = 0; i < A; i++) if (counts[i]) lc[i] = counts[i];
      var S = Object.keys(lc).length, Hn = entropyOf(lc, N, Math.E);
      a.entropy = {
        perChar: entropyOf(cc, cn, 2), distinctChars: Object.keys(cc).length,
        perByte: entropyOf(bc, bytes.length, 2), letters: entropyOf(lc, N, 2), lettersMax: Math.log(A) / Math.LN2,
        shannonIndex: Hn, distinctLetters: S, evenness: S > 1 ? Hn / Math.log(S) : 0, shannonMax: Math.log(A),
      };
      a.entropyRefs = langsOfScript(script).map(function (L) {
        var h = 0; for (var q = 0; q < L.A; q++) { var p = L.uni[q]; if (p > 0) h -= p * Math.log(p); }
        return { code: L.code, name: L.name, bits: h / Math.LN2, nats: h, evenness: h / Math.log(L.A) };
      });
      a.byteHist = (isB || c.n - c.ascii > 0) ? bh : null;
      // words / lengths
      var wl = new Array(16); for (i = 0; i < 16; i++) wl[i] = 0;
      (t.match(/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]+/g) || []).forEach(function (w) { wl[Math.min(15, w.length)]++; });
      a.wordLens = wl;
      var nsLen = t.replace(/\s+/g, '').length;
      a.lengthHints = { total: t.length, noSpace: nsLen, mods: [2, 3, 4, 5, 8].map(function (m) { return { m: m, r: nsLen % m }; }), grids: [] };
      for (var r = 2; r * r <= N; r++) if (N % r === 0) a.lengthHints.grids.push([r, N / r]);
      // fit against each language of the script (chi-squared + cosine) and best Caesar shift
      a.fit = langsOfScript(script).map(function (L) {
        var chi = 0, bestShift = 0, bestChi = Infinity;
        for (var q = 0; q < A; q++) { var e = L.uni[q] * N; chi += e ? (counts[q] - e) * (counts[q] - e) / e : 0; }
        for (var sh = 0; sh < A; sh++) {
          var x2 = 0;
          for (var z = 0; z < A; z++) { var e2 = L.uni[z] * N, o = counts[(z + sh) % A]; x2 += e2 ? (o - e2) * (o - e2) / e2 : 0; }
          if (x2 < bestChi) { bestChi = x2; bestShift = sh; }
        }
        return { code: L.code, name: L.name, chi: chi, cos: cosine(counts, L.uni), shift: bestShift, shiftChi: bestChi, expected: Array.prototype.slice.call(L.uni) };
      }).sort(function (x, y) { return y.cos - x.cos; });
      a.readable = score(t);
      return a;
    }

    // ===================================================================
    // Cipher identifier — plain-language clues from shape + statistics
    // ===================================================================
    function identify(input, a) {
      var isB = isBytes(input), t = isB ? (utf8Strict(input) || '') : String(input || ''), s = t.trim(), clues = [];
      a = a || analyze(input);
      var add = function (conf, title, why, ops) { clues.push({ conf: Math.round(conf * 100) / 100, title: title, why: why, ops: ops || [] }); };
      var ns = s.replace(/\s+/g, '');
      if (isB && !utf8Strict(input)) {
        var mg = magic(input);
        if (mg) add(0.95, mg.name, 'The bytes start with the ' + mg.name + ' file signature.', mg.ext === 'gz' ? ['inflate'] : []);
        else if (isZlib(input)) add(0.8, 'zlib-compressed data', 'First two bytes form a valid zlib header (CMF/FLG check passes).', ['inflate']);
      }
      if (/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*$/.test(s)) add(0.97, 'JSON Web Token', 'Three dot-separated Base64url parts; the first two start with "eyJ" = Base64 of {"', ['jwt']);
      if (/^data:[^,]*,/i.test(s)) add(0.97, 'data: URI', 'Starts with "data:" — a media type, optional ;base64, then the payload.', ['datauri']);
      if (/^-----BEGIN [A-Z ]+-----/.test(s)) add(0.9, 'PEM block', 'BEGIN/END armour around Base64 — decode the body as Base64 (it is DER/ASN.1 binary).', ['base64']);
      if (/^<~[\s\S]*~>$/.test(s)) add(0.95, 'Ascii85 (Adobe)', 'Wrapped in <~ … ~> delimiters.', ['ascii85']);
      if (/^begin [0-7]{3} \S/m.test(s)) add(0.95, 'uuencode', '"begin <mode> <name>" header line followed by length-prefixed lines.', ['uu']);
      if (ns.length >= 8 && /^[01]+$/.test(ns)) add(0.95, 'Binary', 'Only 0 and 1' + (ns.length % 8 === 0 ? ', length a multiple of 8 → 8-bit bytes.' : ns.length % 7 === 0 ? ', length a multiple of 7 → 7-bit ASCII.' : '.') + (/^[01]{5}(\s+[01]{5})+$/.test(s) ? ' Groups of 5 could also be Baconian.' : ''), ['binary', 'bacon']);
      else if (ns.length >= 4 && /^[0-9a-fA-F]+$/.test(hexClean(s)) && hexClean(s).length % 2 === 0 && /[0-9]/.test(ns) && !/^\d+$/.test(ns) && hexClean(s).length >= 6) add(/^[0-9a-f\s]+$/.test(s) || /^[0-9A-F\s]+$/.test(s) || /0x|\\x/i.test(s) ? 0.9 : 0.7, 'Hexadecimal', 'Only 0–9 and A–F' + (/[\s:]/.test(s) ? ' in byte groups' : '') + ', even number of digits.', ['hex']);
      var b64core = ns.replace(/=+$/, '');
      if (ns.length >= 8 && /^[A-Za-z0-9+/]+={0,2}$/.test(ns) && b64core.length % 4 !== 1 && /[a-z]/.test(ns) && /[A-Z]/.test(ns)) {
        add(ns.length % 4 === 0 ? 0.85 : 0.6, 'Base64', 'A–Z, a–z, 0–9, + and /' + (/=$/.test(ns) ? ' with = padding' : '') + '; length ' + ns.length + (ns.length % 4 === 0 ? ' (multiple of 4).' : '.'), ['base64']);
      } else if (ns.length >= 8 && /^[A-Za-z0-9_-]+$/.test(ns) && /[-_]/.test(ns) && b64core.length % 4 !== 1) add(0.6, 'Base64url', 'Base64 alphabet with - and _ instead of + and /.', ['base64']);
      if (ns.length >= 8 && /^[A-Z2-7]+=*$/.test(ns) && /[2-7=]/.test(ns) && [0, 2, 4, 5, 7].indexOf(ns.replace(/=+$/, '').length % 8) >= 0) add(/=$/.test(ns) || ns.length % 8 === 0 ? 0.85 : 0.6, 'Base32', 'Only A–Z and 2–7' + (/=$/.test(ns) ? " with '=' padding" : '') + ' → RFC 4648 Base32.', ['base32']);
      if (ns.length >= 10 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(ns) && /[a-z]/.test(ns) && /[A-Z]/.test(ns) && /\d/.test(ns)) add(0.45, 'Base58', 'Alphanumeric but never 0, O, I or l — the Bitcoin Base58 alphabet.', ['base58']);
      if (/^[.\-\s\/|_·•−–—]+$/.test(s) && /[.·•]/.test(s) && /[\-_−–—]/.test(s)) add(0.95, 'Morse code', 'Only dots, dashes and separators.', ['morse']);
      else if (/\b(dit|dah)\b/i.test(s) && (s.match(/\b(dit|dah|di|da)\b/gi) || []).length > 3) add(0.9, 'Morse code (spoken)', 'dit / dah syllables.', ['morse']);
      if (/^([ABab]{5}\s*)+$/.test(s) && ns.length >= 10) add(0.9, 'Baconian cipher', 'Only A and B in groups of 5.', ['bacon']);
      var nums = s.match(/\d+/g) || [];
      if (nums.length >= 3 && /^[\d\s,.\-\/|]+$/.test(s)) {
        var mx = Math.max.apply(null, nums.map(Number)), mn = Math.min.apply(null, nums.map(Number));
        if (mx <= 26 && mn >= 0) add(0.75, 'A1Z26 (letter positions)', 'All numbers between 1 and 26.', ['a1z26']);
        if (nums.every(function (x) { return /^[1-5]{2}$/.test(x); })) add(0.8, 'Polybius square / tap code', 'Two-digit groups using only digits 1–5 (row, column).', ['polybius', 'tap']);
        else if (/^[1-5\s]+$/.test(s) && ns.length % 2 === 0 && ns.length >= 6) add(0.55, 'Polybius square / tap code', 'Digits 1–5 only, even count.', ['polybius', 'tap']);
        if (mx <= 110 && mn >= 22 && nums.every(function (x) { return x.length >= 2 && x.length <= 3; }) && nums.some(function (x) { return +x > 55 || /[6-9]$/.test(x) || /0$/.test(x); })) add(0.6, 'Nihilist cipher', 'Two/three-digit numbers between 22 and 110: Polybius coordinates plus a key — the Nihilist signature.', ['nihilist']);
        if (mn >= 32 && mx <= 126 && nums.length >= 3) add(0.75, 'Decimal ASCII codes', 'Numbers within 32–126 (printable ASCII).', ['decimal']);
        else if (mx <= 255 && nums.some(function (x) { return +x > 26; })) add(0.55, 'Decimal byte values', 'Numbers within 0–255.', ['decimal']);
        if (nums.every(function (x) { return /^[0-7]{3}$/.test(x); })) add(0.6, 'Octal bytes', 'Three-digit groups using only 0–7.', ['octal']);
        if (/^[02-9\s]+$/.test(s) && nums.every(function (x) { return /^(\d)\1{0,3}$/.test(x); })) add(0.75, 'Phone keypad (multi-tap)', 'Runs of the same digit (2–9), at most four presses.', ['t9']);
      }
      if (/^[ADFGX]+$/i.test(ns) && ns.length >= 10 && ns.length % 2 === 0) add(0.9, 'ADFGX cipher', 'Only the letters A, D, F, G, X — the ADFGX coordinate alphabet.', ['adfgx']);
      else if (/^[ADFGVX]+$/i.test(ns) && ns.length >= 10 && ns.length % 2 === 0 && /v/i.test(ns)) add(0.9, 'ADFGVX cipher', 'Only A, D, F, G, V, X — the ADFGVX alphabet.', ['adfgvx']);
      var nw = (s.toLowerCase().match(/[a-z-]+/g) || []);
      if (nw.length >= 3 && nw.filter(function (w) { return NATO[w]; }).length >= nw.length * 0.7) add(0.95, 'NATO phonetic alphabet', 'Words like Alfa, Bravo, Charlie.', ['nato']);
      if (/[\u2801-\u28ff]/.test(s)) add(0.95, 'Braille', 'Unicode Braille cells (U+2800 block).', ['braille']);
      if (/^[.\s\/•*]+$/.test(s) && /\.\.? /.test(s)) add(0.7, 'Tap code (knocks)', 'Groups of dots = row/column knocks on a 5×5 square.', ['tap']);
      if (/%[0-9a-f]{2}/i.test(s)) add(0.85, 'URL (percent) encoding', '%XX escapes.', ['url']);
      if (/&(#x?[0-9a-f]+|[a-z]{2,8});/i.test(s)) add(0.85, 'HTML entities', '&…; character references.', ['html']);
      if (/\\u[0-9a-f]{4}|\\x[0-9a-f]{2}|\\u\{|U\+[0-9a-f]{4}/i.test(s)) add(0.85, 'Unicode / byte escapes', '\\uXXXX, \\xXX or U+XXXX escapes.', ['uesc']);
      if (/=[0-9A-F]{2}/.test(s) && /=\r?\n|=[0-9A-F]{2}.*=[0-9A-F]{2}/.test(s)) add(0.7, 'Quoted-printable', '=XX escapes and soft line breaks.', ['qp']);
      if (/xn--[a-z0-9-]+/i.test(s)) add(0.95, 'Punycode', 'xn-- prefixed domain labels (internationalised domain names).', ['puny']);
      if (/[ɐɔǝɟƃɥᴉɾʞɯɹʇʌʍʎ∀Ǝ⅁˥⊥∩Λ⅄]/.test(s)) add(0.85, 'Upside-down text', 'Turned letters such as ɐ ǝ ɹ ʇ.', ['flip']);
      if ((s.match(COMBINING) || []).length > Math.max(6, s.length * 0.3)) add(0.9, 'Zalgo text', 'Piles of combining marks on each letter.', ['zalgo']);
      if (/[a-z][0-9@$|!][a-z]|[0-9@$][a-z]{2}/i.test(s) && (s.match(/[4310@$57]/g) || []).length >= 2 && /\s/.test(s)) add(0.4, 'Leetspeak', 'Digits/symbols standing in for letters (4=a, 3=e, 0=o…).', ['leet']);
      if (ns.length >= 12 && /^[!-~]+$/.test(ns) && (ns.match(/[^A-Za-z0-9]/g) || []).length > ns.length * 0.25 && !/^[A-Za-z0-9+/=]+$/.test(ns)) add(0.4, 'ROT47 / Base85 / Base91', 'Dense printable ASCII with many symbols and no spaces.', ['rot47', 'ascii85', 'base91']);
      if (a.bytes >= 64 && a.entropy.perByte > 7.2) add(0.6, 'High entropy (' + a.entropy.perByte.toFixed(2) + ' bits/byte)', 'Near-random bytes: compressed, encrypted or random data. Classical ciphers stay well below 5 bits/char.', ['inflate', 'xor']);
      // ---- letter statistics ------------------------------------------------
      var L = a.N, lettersRatio = a.classes.letters / Math.max(1, a.len - a.classes.space);
      var b64ish = /\d/.test(ns) && /[a-z]/.test(ns) && /[A-Z]/.test(ns) && !/\s/.test(s);
      var strong = clues.some(function (c) { return c.conf >= 0.9; });
      if (L >= 20 && lettersRatio >= 0.75 && !b64ish && !strong) {
        var rd = a.readable, fit = a.fit[0] || { cos: 0, name: '?' }, refIC = a.icRefs.length ? a.icRefs[0].ic : 0.066;
        var mono = a.script === 'cyr' ? 0.047 : 0.055, poly = a.script === 'cyr' ? 0.038 : 0.042;
        if (rd.score >= 70) add(0.9, 'Readable ' + (rd.langName || 'text'), 'It already reads as ' + (rd.langName || 'natural language') + ' (score ' + rd.score + ').', []);
        else if (a.ic >= mono) {
          if (fit.cos >= 0.93) add(0.75, 'Transposition cipher', 'IC ' + a.ic.toFixed(4) + ' is monoalphabetic and the letter frequencies match ' + fit.name + ' (cosine ' + fit.cos.toFixed(2) + '), yet it does not read — letters are only rearranged: rail fence, columnar, scytale or route.', ['railfence', 'columnar', 'scytale', 'route']);
          else {
            var shift = fit.shift !== undefined ? fit.shift : 0;
            add(0.75, 'Monoalphabetic substitution', 'IC ' + a.ic.toFixed(4) + ' ≈ ' + (fit.name || 'language') + ' (' + refIC.toFixed(4) + ') but frequencies are permuted: Caesar/ROT, Atbash, affine or keyword substitution.' + (a.fit[0] ? ' Best Caesar fit: shift ' + shift + ' (' + UP[shift] + ').' : ''), ['caesar', 'atbash', 'affine', 'subst']);
          }
        } else if (a.ic >= 0.0 && a.ic < mono && L >= 30) {
          var ks = a.keySuggest.map(function (k) { return k.L; }), kas = a.kasiski.factors.slice().sort(function (x, y) { return y.count - x.count; })[0];
          var top = a.keySuggest[0], periodic = top && top.ic >= mono * 0.93;
          var why = 'IC ' + a.ic.toFixed(4) + ' sits between random (' + a.icRandom.toFixed(4) + ') and ' + (a.icRefs[0] ? a.icRefs[0].name : 'language') + ' (' + refIC.toFixed(4) + ')';
          if (periodic) why += ', but taking every ' + top.L + (top.L === 2 ? 'nd' : top.L === 3 ? 'rd' : 'th') + ' letter brings the columns back to IC ' + top.ic.toFixed(4) + ' — a repeating key of length ' + top.L + ' (or a multiple): Vigenère, Beaufort, Gronsfeld or Porta.';
          else if (a.ic >= poly) why += ' → polyalphabetic (Vigenère, Beaufort, Gronsfeld, Porta, autokey).';
          else why += ' → nearly flat: a long-key or autokey polyalphabetic, a fractionating cipher (Bifid, Hill) or random.';
          if (ks.length) why += ' Ranked key lengths: ' + ks.join(', ') + (kas && kas.count && a.kasiski.total ? ' (periodic IC + Kasiski; most common spacing factor ' + kas.f + ').' : ' (periodic IC).');
          add(periodic ? 0.85 : a.ic >= poly ? 0.65 : 0.45, periodic ? 'Vigenère-type, key length ' + top.L : a.ic >= poly ? 'Polyalphabetic (Vigenère family)' : 'Flat frequencies', why, ['vigenere', 'beaufort', 'porta', 'autokey', 'gronsfeld']);
          if (a.script === 'latin' && L % 2 === 0 && !periodic) add(0.3, 'Hill 2×2 (possible)', 'Even letter count with flattened frequencies and no clear period — a 2×2 Hill cipher is brute-forceable.', ['hill']);
          if (a.script === 'latin' && a.counts[9] === 0 && L >= 40) add(0.35, 'Bifid / Playfair (5×5 square)', 'No J at all — 25-letter square ciphers merge I/J.', ['bifid', 'playfair']);
        }
      }
      if (a.script === 'latin' && L >= 30 && L % 2 === 0 && a.counts[9] === 0 && lettersRatio >= 0.75 && a.ic < 0.06 && a.readable.score < 60 && !hasDoubledPairs(s))
        add(L >= 80 ? 0.9 : L >= 50 ? 0.75 : 0.5, 'Playfair / digraphic', 'Even letter count, no J at all and never the same letter twice inside a pair — the Playfair fingerprint (Two-square / Four-square look similar).', ['playfair', 'twosquare', 'foursquare']);
      clues.sort(function (x, y) { return y.conf - x.conf; });
      return clues.slice(0, 12);
    }
    function hasDoubledPairs(s) {
      var t = lettersOnly(s);
      for (var i = 0; i + 1 < t.length; i += 2) if (t[i] === t[i + 1]) return true;
      return false;
    }

    // ===================================================================
    // Attacks: recover keys automatically (cheap statistical methods)
    // ===================================================================
    function rng(seed) { // mulberry32 — deterministic restarts (reproducible results / tests)
      var a = seed >>> 0;
      return function () {
        a = (a + 0x6d2b79f5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function attackLangs(ctx) {
      var out = [];
      if (ctx && ctx.lang && LANGS[ctx.lang] && LANGS[ctx.lang].script === 'Latin') out.push(LANGS[ctx.lang]);
      LATIN.forEach(function (L) { if (out.indexOf(L) < 0) out.push(L); });
      return out;
    }
    function fitLang(idx, ctx) { // best Latin language for a letter multiset (transposition keeps it)
      if (ctx && ctx.lang && LANGS[ctx.lang] && LANGS[ctx.lang].script === 'Latin') return LANGS[ctx.lang];
      var c = countIdx(idx, 26), best = LATIN[0], bc = -1;
      LATIN.forEach(function (L) { var v = cosine(c, L.uni); if (v > bc) { bc = v; best = L; } });
      return best;
    }
    // Languages worth scoring a transposition against: the chosen one, the
    // two whose letter frequencies fit best, and English.
    function fitLangs(idx, ctx) {
      if (ctx && ctx.lang && LANGS[ctx.lang] && LANGS[ctx.lang].script === 'Latin') return [LANGS[ctx.lang]];
      var c = countIdx(idx, 26);
      var r = LATIN.map(function (L) { return { L: L, v: cosine(c, L.uni) }; }).sort(function (a, b) { return b.v - a.v; });
      var out = [r[0].L, r[1].L];
      if (out.indexOf(LANGS.en) < 0 && LANGS.en) out.push(LANGS.en);
      return out;
    }
    function bestFitCos(idx) {
      var c = countIdx(idx, 26), bc = 0;
      LATIN.forEach(function (L) { var v = cosine(c, L.uni); if (v > bc) bc = v; });
      return bc;
    }
    function qAll(langs, idx) { var b = -1; for (var i = 0; i < langs.length; i++) { var q = ngNorm(langs[i], idx); if (q > b) b = q; } return b; }
    function topK(list, k) { list.sort(function (a, b) { return b.q - a.q; }); return list.slice(0, k); }
    function minPeriod(key) {
      for (var p = 1; p < key.length; p++) {
        if (key.length % p) continue;
        var ok = true;
        for (var i = p; i < key.length && ok; i++) if (key[i] !== key[i - p]) ok = false;
        if (ok) return key.slice(0, p);
      }
      return key;
    }
    function polyAttack(t, mode, ctx) {
      var idx = asciiIdx(t), n = idx.length;
      if (n < 24) return [];
      var maxL = Math.min(20, Math.floor(n / 9));
      if (maxL < 2) return [];
      // Long periods have few letters per column, which inflates their IC, so
      // take the SMALLEST lengths that clear a bar, plus the two best overall.
      var per = periodicIC(idx, 26, maxL), maxIc = 0;
      per.forEach(function (p) { if (p.L > 1 && p.ic > maxIc) maxIc = p.ic; });
      var bar = Math.max(0.05, maxIc * 0.8);
      var cand = per.filter(function (p) { return p.L > 1 && p.ic >= bar; }).map(function (p) { return p.L; }).slice(0, 3);
      per.slice(1).sort(function (a, b) { return b.ic - a.ic; }).slice(0, 2).forEach(function (p) { if (cand.indexOf(p.L) < 0 && p.ic >= 0.047) cand.push(p.L); });
      if (!cand.length) return [];
      var langs = attackLangs(ctx), out = [], kmax = mode === 'porta' ? 13 : 26;
      cand.forEach(function (L) {
        var best = null;
        langs.forEach(function (lang) {
          var key = [];
          for (var j = 0; j < L; j++) {
            var cnt = new Float64Array(26), i;
            for (i = j; i < n; i += L) cnt[idx[i]]++;
            var bk = 0, bll = -Infinity;
            for (var k = 0; k < kmax; k++) {
              var ll = 0;
              for (var x = 0; x < 26; x++) {
                if (!cnt[x]) continue;
                var p = mode === 'vig' ? (x - k + 26) % 26 : mode === 'beau' ? (k - x + 26) % 26 : portaChar(x, 2 * k);
                ll += cnt[x] * lang.logUni[p];
              }
              if (ll > bll) { bll = ll; bk = k; }
            }
            key.push(mode === 'porta' ? 2 * bk : bk);
          }
          key = refineKey(idx, key, mode, lang);
          var ks = minPeriod(key.map(function (k) { return UP[k]; }).join(''));
          var dec = mode === 'porta' ? porta(t, ks) : polyCipher(t, keyShifts(ks), mode, false);
          var q = ngNorm(lang, asciiIdx(dec));
          if (!best || q > best.q) best = { q: q, key: ks, v: dec };
        });
        if (best && !out.some(function (o) { return o.key === best.key; })) out.push(best);
      });
      return topK(out, 2).map(function (b) {
        var gr = mode === 'vig' && /^[A-J]+$/.test(b.key) && b.key.length > 1 ? ' (Gronsfeld ' + b.key.split('').map(function (c) { return c.charCodeAt(0) - 65; }).join('') + ')' : '';
        return { v: b.v, label: 'key ' + b.key + gr, params: { key: b.key }, q: b.q };
      });
    }
    // One pass of per-column re-selection by whole-text trigram fitness:
    // fixes columns the unigram statistic got wrong on short texts.
    function refineKey(idx, key, mode, lang) {
      var n = Math.min(idx.length, 1200), L = key.length, buf = new Uint8Array(n), tab = lang.t3, kmax = mode === 'porta' ? 13 : 26;
      var dec = function (x, k) { return mode === 'vig' ? (x - k + 26) % 26 : mode === 'beau' ? (k - x + 26) % 26 : portaChar(x, k); };
      var fill = function () { for (var i = 0; i < n; i++) buf[i] = dec(idx[i], key[i % L]); };
      var fit = function () { var s = 0; for (var i = 0; i + 2 < n; i++) s += tab[(buf[i] * 26 + buf[i + 1]) * 26 + buf[i + 2]]; return -s; };
      fill();
      for (var j = 0; j < L; j++) {
        var bestK = key[j], bestF = fit();
        for (var k = 0; k < kmax; k++) {
          var kk = mode === 'porta' ? 2 * k : k;
          if (kk === key[j]) continue;
          for (var i = j; i < n; i += L) buf[i] = dec(idx[i], kk);
          var f = fit();
          if (f > bestF) { bestF = f; bestK = kk; }
        }
        key[j] = bestK;
        for (var i2 = j; i2 < n; i2 += L) buf[i2] = dec(idx[i2], bestK);
      }
      return key;
    }
    function autokeyAttack(t, ctx) {
      var idx = asciiIdx(t), n = idx.length;
      if (n < 30) return [];
      var langs = attackLangs(ctx), out = [];
      for (var L = 1; L <= Math.min(12, Math.floor(n / 5)); L++) {
        var best = null;
        for (var li = 0; li < langs.length; li++) {
          var lang = langs[li], key = '';
          for (var j = 0; j < L; j++) {
            var bk = 0, bll = -Infinity;
            for (var k = 0; k < 26; k++) {
              var prev = (idx[j] - k + 26) % 26, ll = lang.logUni[prev];
              for (var i = j + L; i < n; i += L) { prev = (idx[i] - prev + 26) % 26; ll += lang.logUni[prev]; }
              if (ll > bll) { bll = ll; bk = k; }
            }
            key += UP[bk];
          }
          var dec = autokey(t, key, false), q = ngNorm(lang, asciiIdx(dec));
          if (!best || q > best.q) best = { q: q, key: key, v: dec };
        }
        out.push(best);
      }
      return topK(out, 2).map(function (b) { return { v: b.v, label: 'primer ' + b.key, params: { key: b.key }, q: b.q }; });
    }
    function progressiveAttack(t, ctx) {
      var idx = asciiIdx(t), n = Math.min(idx.length, 1500);
      if (n < 10) return [];
      var langs = attackLangs(ctx).slice(0, 2), buf = new Uint8Array(n), out = [];
      for (var step = 1; step < 26; step++) {
        for (var start = 0; start < 26; start++) {
          for (var i = 0; i < n; i++) buf[i] = (idx[i] - start - step * i % 26 + 52) % 26;
          var q = qAll(langs, buf);
          if (q > 0.25) out.push({ q: q, start: start, step: step });
        }
      }
      return topK(out, 2).map(function (b) { return { v: progressive(t, b.start, b.step, 1, false), label: 'start ' + b.start + ', step ' + b.step, params: { start: b.start, step: b.step, period: 1 }, q: b.q }; });
    }
    function affineAttack(t, ctx) {
      var idx = asciiIdx(t), n = Math.min(idx.length, 1500);
      if (n < 6) return [];
      var langs = attackLangs(ctx).slice(0, 3), buf = new Uint8Array(n), out = [];
      for (var ai = 1; ai < AFFINE_A.length; ai++) {
        var a = AFFINE_A[ai], inv = modInv(a, 26);
        for (var b = 0; b < 26; b++) {
          for (var i = 0; i < n; i++) buf[i] = (inv * (idx[i] - b + 26)) % 26;
          out.push({ q: qAll(langs, buf), a: a, b: b });
        }
      }
      return topK(out, 4).map(function (r) { return { v: affine(t, r.a, r.b, false), label: 'a=' + r.a + ', b=' + r.b, params: { a: r.a, b: r.b }, q: r.q }; });
    }
    function hillAttack(t, ctx) {
      var idx = asciiIdx(t), n = idx.length - idx.length % 2;
      if (n < 20) return [];
      var langs = attackLangs(ctx).slice(0, 2), best = [];
      var letters = lettersOnly(t);
      langs.forEach(function (lang) {
        var rows = [];
        for (var e = 0; e < 26; e++) for (var f = 0; f < 26; f++) {
          var ll = 0;
          for (var i = 0; i < n; i += 2) ll += lang.logUni[(e * idx[i] + f * idx[i + 1]) % 26];
          rows.push({ e: e, f: f, ll: ll });
        }
        rows.sort(function (a, b) { return b.ll - a.ll; });
        var top = rows.slice(0, 12);
        for (var x = 0; x < top.length; x++) for (var y = 0; y < top.length; y++) {
          if (x === y) continue;
          var M = [top[x].e, top[x].f, top[y].e, top[y].f], K = hillInv(M);
          if (!K) continue;
          var dec = hillApply(letters.length % 2 ? letters + 'X' : letters, M);
          best.push({ q: ngNorm(lang, asciiIdx(dec)), v: dec, key: K.join(' ') });
        }
      });
      return topK(best, 2).map(function (b) { return { v: b.v, label: 'key ' + b.key, params: { key: b.key }, q: b.q }; });
    }
    function transCands(t, ctx, gen) {
      var idx = asciiIdx(t), Ls = fitLangs(idx, ctx), out = [];
      gen(function (v, label, params) { out.push({ v: v, label: label, params: params, q: qAll(Ls, asciiIdx(v)) }); });
      return out;
    }
    function railAttack(t, ctx) {
      var n = chars(t).length;
      if (n < 8 || n > 6000) return [];
      return topK(transCands(t, ctx, function (push) {
        for (var r = 2; r <= Math.min(12, n - 1); r++) for (var off = 0; off < 2 * (r - 1); off++) push(railFence(t, r, off, false), r + ' rails' + (off ? ', offset ' + off : ''), { rails: r, offset: off });
      }), 3);
    }
    function scytaleAttack(t, ctx) {
      var n = chars(t).length;
      if (n < 8 || n > 6000) return [];
      return topK(transCands(t, ctx, function (push) {
        for (var r = 2; r <= Math.min(40, Math.floor(n / 2)); r++) push(scytale(t, r, false), r + ' rows', { rows: r });
      }), 2);
    }
    function routeAttack(t, ctx) {
      var n = chars(t).length;
      if (n < 8 || n > 4000) return [];
      return topK(transCands(t, ctx, function (push) {
        for (var c = 2; c <= Math.min(25, Math.floor(n / 2)); c++) ROUTES.forEach(function (r) { push(route(t, c, r[0], false), c + ' columns, ' + r[1].toLowerCase(), { cols: c, route: r[0] }); });
      }), 2);
    }
    function permutations(k, cb) { // Heap's algorithm
      var a = identity(k), c = new Array(k).fill ? new Array(k).fill(0) : identity(k).map(function () { return 0; }), i = 0;
      if (cb(a) === false) return;
      while (i < k) {
        if (c[i] < i) {
          var j = i % 2 ? c[i] : 0, tmp = a[j]; a[j] = a[i]; a[i] = tmp;
          if (cb(a) === false) return;
          c[i]++; i = 0;
        } else { c[i] = 0; i++; }
      }
    }
    function columnarAttack(t, ctx) {
      var ch = chars(t), n = ch.length;
      if (n < 10 || n > 3000) return [];
      var idx = asciiIdx(t), Ls = fitLangs(idx, ctx), out = [], deadline = ctx && ctx.deadline ? ctx.deadline : Infinity, cnt = 0;
      var maxK = n <= 700 ? 7 : 6;
      for (var k = 2; k <= maxK; k++) {
        var stop = false;
        permutations(k, function (ranks) {
          if ((++cnt & 127) === 0 && now() > deadline) { stop = true; return false; }
          var v = colDec(t, ranks);
          out.push({ q: qAll(Ls, asciiIdx(v)), v: v, ranks: ranks.slice() });
          if (out.length > 64) { out = topK(out, 8); }
        });
        if (stop) break;
      }
      return topK(out, 3).map(function (b) {
        var key = b.ranks.map(function (r) { return r + 1; }).join(' ');
        return { v: b.v, label: 'key order ' + key, params: { key: key }, q: b.q };
      });
    }
    function bifidAttack(t, ctx) {
      var s = sqNorm(t, 5, 'ij');
      if (s.length < 20) return [];
      var Ls = fitLangs(asciiIdx(t), ctx), out = [];
      [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].forEach(function (p) {
        var v = bifid(s, '', p, false);
        out.push({ q: qAll(Ls, asciiIdx(v)), v: v, label: 'unkeyed, period ' + (p || 'none'), params: { key: '', period: p } });
      });
      return topK(out, 2);
    }
    // Simple substitution: hill-climbing on n-gram fitness (quadgrams for
    // English, trigrams elsewhere) with deterministic random restarts.
    function substSolve(t, lang, ctx) {
      var all = asciiIdx(t);
      if (all.length < 40 || !lang) return null;
      var c = all.length > 600 ? all.subarray(0, 600) : all, n = c.length;
      var quad = !!lang.t4, tab = quad ? lang.t4 : lang.t3, N = quad ? 4 : 3;
      var deadline = ctx && ctx.deadline ? ctx.deadline : now() + 1500;
      var p = new Uint8Array(n);
      function fit(key) {
        for (var i = 0; i < n; i++) p[i] = key[c[i]];
        var s = 0, j;
        if (quad) for (j = 0; j + 3 < n; j++) s += tab[((p[j] * 26 + p[j + 1]) * 26 + p[j + 2]) * 26 + p[j + 3]];
        else for (j = 0; j + 2 < n; j++) s += tab[(p[j] * 26 + p[j + 1]) * 26 + p[j + 2]];
        return -s;
      }
      var cnt = countIdx(c, 26), cOrd = identity(26).sort(function (a, b) { return cnt[b] - cnt[a]; });
      var pOrd = identity(26).sort(function (a, b) { return lang.uni[b] - lang.uni[a]; });
      var init = new Uint8Array(26); for (var i = 0; i < 26; i++) init[cOrd[i]] = pOrd[i];
      var R = rng(n * 31 + 7), best = init.slice(), bestF = fit(best), restarts = (ctx && ctx.restarts) || 8;
      for (var r = 0; r < restarts && now() < deadline; r++) {
        var key = r === 0 ? init.slice() : best.slice();
        if (r) for (var q = 0; q < 2 + (r % 4) * 2; q++) { var x1 = (R() * 26) | 0, y1 = (R() * 26) | 0, tt = key[x1]; key[x1] = key[y1]; key[y1] = tt; }
        var f = fit(key), stale = 0, it = 0;
        while (stale < 1500 && it < 12000) {
          it++;
          var a = (R() * 26) | 0, b = (R() * 26) | 0;
          if (a === b) continue;
          var tmp = key[a]; key[a] = key[b]; key[b] = tmp;
          var f2 = fit(key);
          if (f2 > f) { f = f2; stale = 0; } else { key[b] = key[a]; key[a] = tmp; stale++; }
          if ((it & 511) === 0 && now() > deadline) break;
        }
        if (f > bestF) { bestF = f; best = key.slice(); }
      }
      // best[cipher] = plain -> cipher alphabet keyStr[plain] = cipher
      var keyArr = new Array(26), used = {};
      for (var ci = 0; ci < 26; ci++) if (cnt[ci]) { keyArr[best[ci]] = UP[ci]; used[ci] = 1; }
      var spare = identity(26).filter(function (x) { return !used[x]; }).map(function (x) { return UP[x]; });
      for (var pi = 0; pi < 26; pi++) if (!keyArr[pi]) keyArr[pi] = spare.shift();
      var keyStr = keyArr.join('');
      return { key: keyStr, v: substCipher(t, keyStr, false) };
    }
    function substAttack(t, ctx) {
      var langs = [LANGS.en];
      if (ctx && ctx.lang && LANGS[ctx.lang] && LANGS[ctx.lang].script === 'Latin' && ctx.lang !== 'en') langs.unshift(LANGS[ctx.lang]);
      var out = [];
      langs.forEach(function (L) {
        if (!L) return;
        var r = substSolve(t, L, ctx);
        if (r) out.push({ v: r.v, label: 'key ' + r.key, params: { key: r.key }, q: ngNorm(L, asciiIdx(r.v)) });
      });
      return topK(out, 2);
    }
    // XOR: printable-English character weights for ranking keys.
    var XW = (function () {
      var w = new Float64Array(256), i, f = ' etaoinshrdlucmfwypvbgkjqxz';
      for (i = 0; i < 256; i++) w[i] = i >= 0x80 ? -1 : -8;
      for (i = 33; i < 127; i++) w[i] = 0.3;
      w[9] = w[10] = w[13] = 0.5;
      for (i = 48; i < 58; i++) w[i] = 0.6;
      for (i = 0; i < f.length; i++) { var v = 3.2 - i * 0.09; w[f.charCodeAt(i)] = v; if (i) w[f.charCodeAt(i) - 32] = v * 0.7; }
      return w;
    })();
    function xorScore(b, k, start, step, max) {
      var s = 0, n = 0;
      for (var i = start; i < b.length && n < max; i += step, n++) s += XW[b[i] ^ k];
      return n ? s / n : -99;
    }
    function xor1Attack(b) {
      if (!b || b.length < 4) return [];
      var out = [];
      for (var k = 1; k < 256; k++) out.push({ q: xorScore(b, k, 0, 1, 2048), k: k });
      return topK(out, 4).filter(function (r) { return r.q > 0.2; }).map(function (r) {
        var ch = r.k >= 33 && r.k < 127 ? " '" + String.fromCharCode(r.k) + "'" : '';
        return { v: xorBytes(b, new Uint8Array([r.k])), label: 'key 0x' + (r.k < 16 ? '0' : '') + r.k.toString(16) + ch, params: { key: r.k }, q: r.q };
      });
    }
    function hamming(a, b) { var d = 0; for (var i = 0; i < a.length; i++) { var x = a[i] ^ b[i]; while (x) { d += x & 1; x >>= 1; } } return d; }
    function xorNAttack(b) {
      if (!b || b.length < 16) return [];
      var lens = [];
      for (var L = 2; L <= Math.min(40, Math.floor(b.length / 3)); L++) {
        var d = 0, cnt = 0;
        for (var i = 0; i + 2 * L <= b.length && cnt < 12; i += L, cnt++) d += hamming(b.subarray(i, i + L), b.subarray(i + L, i + 2 * L)) / L;
        if (cnt) lens.push({ L: L, d: d / cnt });
      }
      lens.sort(function (x, y) { return x.d - y.d; });
      var out = [];
      lens.slice(0, 4).forEach(function (e) {
        var key = new Uint8Array(e.L), tot = 0;
        for (var j = 0; j < e.L; j++) {
          var bk = 0, bq = -Infinity;
          for (var k = 0; k < 256; k++) { var q = xorScore(b, k, j, e.L, 4096); if (q > bq) { bq = q; bk = k; } }
          key[j] = bk; tot += bq;
        }
        var mk = minPeriodBytes(key);
        var printable = latin1(mk);
        out.push({ v: xorBytes(b, mk), q: tot / e.L, label: 'key ' + (/^[ -~]+$/.test(printable) ? '"' + printable + '"' : '0x' + toHex(mk)), params: /^[ -~]+$/.test(printable) ? { key: printable, keyType: 'text' } : { key: toHex(mk), keyType: 'hex' } });
      });
      return topK(out, 2).filter(function (r) { return r.q > 0.5; });
    }
    function minPeriodBytes(k) {
      for (var p = 1; p < k.length; p++) {
        if (k.length % p) continue;
        var ok = true;
        for (var i = p; i < k.length && ok; i++) if (k[i] !== k[i - p]) ok = false;
        if (ok) return k.subarray(0, p);
      }
      return k;
    }

    // ===================================================================
    // Operation registry
    // ===================================================================
    var OPS = [], OPS_BY_ID = {};
    function op(d) {
      d.params = d.params || [];
      d.inp = d.inp || 'text';
      d.encInp = d.encInp || d.inp;
      OPS.push(d); OPS_BY_ID[d.id] = d;
      return d;
    }
    function P0(o, P) { // params with defaults
      var r = {};
      (o.params || []).forEach(function (p) { r[p.k] = p.def; });
      if (P) for (var k in P) if (P[k] !== undefined && P[k] !== null && P[k] !== '') r[k] = P[k];
      return r;
    }
    var SEL = function (k, label, options, def, extra) { var o = { k: k, label: label, type: 'select', options: options, def: def }; for (var e in extra || {}) o[e] = extra[e]; return o; };
    var TXT = function (k, label, def, ph) { return { k: k, label: label, type: 'text', def: def === undefined ? '' : def, ph: ph || '' }; };
    var INT = function (k, label, def, min, max) { return { k: k, label: label, type: 'int', def: def, min: min, max: max }; };
    var BOOL = function (k, label, def) { return { k: k, label: label, type: 'bool', def: !!def }; };

    // ---- cheap applicability tests (node stats) --------------------------
    function stats(node) {
      if (node.st) return node.st;
      var t = node.t, st = { t: t || '', has: t !== null && t !== undefined };
      if (st.has) {
        var sm = t.length > 4000 ? t.slice(0, 4000) : t, c = classify(sm);
        st.c = c; st.n = t.length; st.ns = sm.replace(/\s+/g, '');
        st.idx = asciiIdx(sm); st.al = st.idx.length;
        st.letters = c.latin + c.cyr + c.greek + c.hebrew + c.arabic;
        st.lr = st.letters / Math.max(1, c.n - c.space);
        st.ic = icOf(countIdx(st.idx, 26), st.al);
        st.b64ish = /\d/.test(st.ns) && /[a-z]/.test(st.ns) && /[A-Z]/.test(st.ns) && !/\s/.test(sm.trim());
        st.cipherish = st.al >= 10 && st.lr >= 0.75 && !st.b64ish && c.ctrl === 0;
      }
      node.st = st;
      return st;
    }
    function readable(node) { return node.sc ? node.sc.score : 0; }
    function fitCos(st) { if (st.cos === undefined) st.cos = bestFitCos(st.idx); return st.cos; }
    function tB64(st) {
      var s = st.t.trim();
      if (s.length < 4 || /[^A-Za-z0-9+/=_\-\s]/.test(s)) return 0;
      var parts = s.split(/\s+/);
      if (parts.length > 1 && parts.slice(0, -1).some(function (p) { return p.length < 16; })) return 0;
      var c = parts.join(''), core = c.replace(/=+$/, '');
      if (/=/.test(core) || c.length - core.length > 2 || core.length % 4 === 1) return 0;
      if (!/^[A-Za-z0-9+/]+$/.test(core) && !/^[A-Za-z0-9_-]+$/.test(core)) return 0;
      var v = 0.45;
      if (c.length % 4 === 0) v += 0.2;
      if (c.length > core.length) v += 0.2;
      if (/\d/.test(core) && /[a-z]/.test(core) && /[A-Z]/.test(core)) v += 0.15;
      if (/^[a-z]+$/i.test(core) && core.length < 12) v -= 0.3;
      return clamp(v, 0.05, 1);
    }
    function tB32(st) {
      var s = st.ns;
      if (s.length < 8) return 0;
      var u = s.toUpperCase();
      if (s !== u && s !== s.toLowerCase()) return 0;
      var core = u.replace(/=+$/, '');
      if (!/^[A-Z2-7]+$/.test(core) || [0, 2, 4, 5, 7].indexOf(core.length % 8) < 0) return 0;
      if (!/[2-7=]/.test(u)) return 0.2;
      return /=$/.test(u) || u.length % 8 === 0 ? 0.85 : 0.5;
    }
    function tHex(st) {
      var h = hexClean(st.t);
      if (h.length < 4 || h.length % 2 || /[^0-9a-f]/i.test(h)) return 0;
      if (/[^0-9a-fA-Fx\\\s,:;.\-%{}\[\]'"]/.test(st.t)) return 0;
      var v = 0.55;
      if (/\d/.test(h) && /[a-f]/i.test(h)) v += 0.3;
      if (/^\d+$/.test(h)) v -= 0.25;
      if (/^[a-f]+$/i.test(h)) v -= 0.35;
      return clamp(v, 0.05, 0.95);
    }
    function tBin(st) { return /^[01\s,;|]+$/.test(st.t) && st.ns.length >= 7 && /0/.test(st.ns) && /1/.test(st.ns) ? 0.97 : 0; }
    function tNums(st) {
      if (!/^[\d\s,;.\-\/|]+$/.test(st.t) || !/\d\D+\d/.test(st.t.trim())) return null;
      return (st.t.match(/\d+/g) || []).map(Number);
    }
    function tDec(st) { var n = tNums(st); if (!n || n.length < 2) return 0; var mx = Math.max.apply(null, n); if (mx > 0x10ffff) return 0; return n.every(function (x) { return x >= 32 && x <= 126 || x === 10; }) ? 0.85 : 0.5; }
    function tOct(st) { return (/^\s*([0-7]{3}[\s,]+)+[0-7]{3}\s*$/.test(st.t) || /^(\\[0-3][0-7]{2})+$/.test(st.ns)) ? 0.7 : 0; }
    function tA1Z26(st) { var n = tNums(st); return n && n.length >= 3 && n.every(function (x) { return x >= 0 && x <= 26; }) ? 0.8 : 0; }
    function tMorse(st) {
      var s = morseNorm(st.t);
      return /^[.\-\s\/|\\]+$/.test(s) && /\./.test(s) && /-/.test(s) && st.ns.length >= 3 ? 0.97 : 0;
    }

    // ---- encodings ---------------------------------------------------------
    var ENCOD = 'Encoding';
    op({ id: 'base64', name: 'Base64', cat: ENCOD, desc: 'Standard and URL-safe alphabets, padding optional', out: 'bytes', repeatOk: true, sniff: true,
      dec: function (s) { return b64Dec(s); }, encInp: 'bytes', enc: function (b, P) { return b64Enc(b, P.variant === 'url'); },
      params: [SEL('variant', 'Encode alphabet', [['std', 'Standard (+/)'], ['url', 'URL-safe (-_)']], 'std', { enc: true })],
      auto: { cost: 1, test: tB64 } });
    op({ id: 'base32', name: 'Base32', cat: ENCOD, desc: 'RFC 4648, base32hex, Crockford, z-base-32', out: 'bytes', repeatOk: true, sniff: true,
      dec: function (s, P) { return b32Dec(s, P.alphabet); }, encInp: 'bytes', enc: function (b, P) { return b32Enc(b, P.alphabet); },
      params: [SEL('alphabet', 'Alphabet', [['rfc', 'RFC 4648 (A–Z 2–7)'], ['hex', 'base32hex (0–9 A–V)'], ['crockford', 'Crockford'], ['zbase', 'z-base-32']], 'rfc')],
      auto: { cost: 1, test: tB32 } });
    op({ id: 'base58', name: 'Base58', cat: ENCOD, desc: 'Bitcoin alphabet (no 0 O I l)', out: 'bytes', repeatOk: true,
      dec: function (s) { return baseNDec(s, B58); }, encInp: 'bytes', enc: function (b) { return baseNEnc(b, B58); },
      auto: { cost: 1, test: function (st) { var s = st.ns; return s.length >= 6 && s.length <= 2000 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s) && /\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) && !/\s/.test(st.t.trim()) ? 0.35 : 0; } } });
    op({ id: 'base62', name: 'Base62', cat: ENCOD, desc: '0–9 A–Z a–z big-number encoding', out: 'bytes', repeatOk: true,
      dec: function (s) { return baseNDec(s, B62); }, encInp: 'bytes', enc: function (b) { return baseNEnc(b, B62); },
      auto: { cost: 1, test: function (st) { var s = st.ns; return s.length >= 8 && s.length <= 1500 && /^[0-9A-Za-z]+$/.test(s) && /[0OIl]/.test(s) && /\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) && !/\s/.test(st.t.trim()) ? 0.2 : 0; } } });
    op({ id: 'base36', name: 'Base36', cat: ENCOD, desc: '0–9 a–z big-number encoding', out: 'bytes',
      dec: function (s) { return baseNDec(s.toLowerCase(), '0123456789abcdefghijklmnopqrstuvwxyz'); }, encInp: 'bytes', enc: function (b) { return baseNEnc(b, '0123456789abcdefghijklmnopqrstuvwxyz'); } });
    op({ id: 'ascii85', name: 'Base85 / Ascii85', cat: ENCOD, desc: 'Adobe Ascii85 (<~ ~>), ZeroMQ Z85, RFC 1924', out: 'bytes', repeatOk: true, sniff: true,
      dec: function (s, P) { return P.variant === 'z85' ? b85Dec(s, Z85) : P.variant === 'rfc1924' ? b85Dec(s, R85) : b85Dec(s, A85, true); },
      encInp: 'bytes', enc: function (b, P) { return P.variant === 'z85' ? b85Enc(b, Z85) : P.variant === 'rfc1924' ? b85Enc(b, R85) : b85Enc(b, A85, true); },
      params: [SEL('variant', 'Variant', [['adobe', 'Ascii85 (Adobe)'], ['z85', 'Z85 (ZeroMQ)'], ['rfc1924', 'RFC 1924 / Python b85']], 'adobe')],
      auto: { cost: 1, test: function (st) {
        var s = st.ns; if (/^<~[\s\S]*~>$/.test(s)) return 0.97;
        return s.length >= 10 && /^[!-u]+$/.test(s) && (s.match(/[^A-Za-z0-9]/g) || []).length > s.length * 0.1 && !/\s/.test(st.t.trim()) ? 0.35 : 0;
      }, run: function (node) {
        var s = node.t, out = [];
        [['adobe', A85, true], ['z85', Z85], ['rfc1924', R85]].forEach(function (v) { try { out.push({ v: b85Dec(s, v[1], v[2]), label: v[0] === 'adobe' ? '' : v[0], params: { variant: v[0] } }); } catch (e) {} });
        return out;
      } } });
    op({ id: 'base91', name: 'Base91', cat: ENCOD, desc: 'basE91 (Joachim Henke)', out: 'bytes', repeatOk: true,
      dec: function (s) { return b91Dec(s); }, encInp: 'bytes', enc: function (b) { return b91Enc(b); },
      auto: { cost: 1, test: function (st) { var s = st.ns; return s.length >= 10 && /^[A-Za-z0-9!#$%&()*+,./:;<=>?@\[\]^_`{|}~"]+$/.test(s) && /[!#$%&()*,.\/:;<=>?@\[\]^_`{|}~"]/.test(s) && !/\s/.test(st.t.trim()) ? 0.3 : 0; } } });
    op({ id: 'hex', name: 'Hex', cat: ENCOD, desc: 'Hex bytes — spaces, colons, 0x and \\x prefixes allowed', out: 'bytes', repeatOk: true, sniff: true,
      dec: function (s) { return hexDec(s); }, encInp: 'bytes',
      enc: function (b, P) { var sep = P.sep === 'space' ? ' ' : P.sep === 'colon' ? ':' : ''; var h = toHex(b, sep); if (P.sep === 'x') h = toHex(b).replace(/(..)/g, '\\x$1'); if (P.sep === '0x') h = toHex(b, ' ').replace(/(\w\w)/g, '0x$1'); return h; },
      params: [SEL('sep', 'Encode separator', [['none', 'none'], ['space', 'space'], ['colon', 'colon'], ['x', '\\x'], ['0x', '0x']], 'space', { enc: true })],
      auto: { cost: 1, test: tHex } });
    op({ id: 'binary', name: 'Binary', cat: ENCOD, desc: '8-bit (or 7-bit) groups of 0/1', out: 'bytes', repeatOk: true, sniff: true,
      dec: function (s, P) { return binDec(s, { width: P.width === 'auto' ? 0 : +P.width }); }, encInp: 'bytes', enc: function (b, P) { return binEnc(b, { width: P.width === '7' ? 7 : 8 }); },
      params: [SEL('width', 'Bits per char', [['auto', 'auto'], ['8', '8'], ['7', '7']], 'auto')],
      auto: { cost: 1, test: tBin } });
    op({ id: 'octal', name: 'Octal', cat: ENCOD, desc: 'Octal byte values (101 102) or \\101 escapes', out: 'bytes', repeatOk: true, sniff: true,
      dec: function (s) { return octDec(s); }, encInp: 'bytes', enc: function (b) { return Array.prototype.map.call(b, function (x) { return ('00' + x.toString(8)).slice(-3); }).join(' '); },
      auto: { cost: 1, test: tOct } });
    op({ id: 'decimal', name: 'Decimal codes', cat: ENCOD, desc: 'Byte values or Unicode code points as numbers', out: 'bytes', repeatOk: true, sniff: true,
      dec: function (s) { return decDec(s); }, enc: function (s, P) { return P.bytes ? Array.prototype.join.call(utf8Encode(s), ' ') : chars(s).map(function (c) { return c.codePointAt(0); }).join(' '); },
      params: [BOOL('bytes', 'Encode as UTF-8 bytes', false)],
      auto: { cost: 1, test: tDec } });
    op({ id: 'url', name: 'URL / percent', cat: ENCOD, desc: '%XX escapes (UTF-8), optional + as space', repeatOk: true, sniff: true,
      dec: function (s, P) { return urlDec(s, P); }, enc: function (s, P) { return urlEnc(s, P); },
      params: [BOOL('plus', 'Decode + as space', false), BOOL('all', 'Encode every byte', false)],
      auto: { cost: 1, test: function (st) { var m = st.t.match(/%[0-9a-f]{2}|%u[0-9a-f]{4}/gi); return m ? clamp(0.5 + m.length * 3 / st.t.length, 0, 0.95) : 0; },
        run: function (node) { return [{ v: urlDec(node.t, { plus: !/\s/.test(node.t) && /\+/.test(node.t) }), params: { plus: !/\s/.test(node.t) && /\+/.test(node.t) } }]; } } });
    op({ id: 'html', name: 'HTML entities', cat: ENCOD, desc: '&amp; &#65; &#x41; …', repeatOk: true, sniff: true,
      dec: function (s) { return htmlDec(s); }, enc: function (s, P) { return htmlEnc(s, P); },
      params: [SEL('mode', 'Encode', [['named', 'special chars (named)'], ['all', 'every char (&#n;)'], ['hex', 'non-alphanumerics (&#xh;)']], 'named', { enc: true })],
      auto: { cost: 1, test: function (st) { var m = st.t.match(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,8});/gi); return m ? clamp(0.55 + m.length * 4 / st.t.length, 0, 0.95) : 0; } } });
    op({ id: 'uesc', name: 'Unicode escapes', cat: ENCOD, desc: '\\uXXXX, \\u{…}, \\xXX, U+XXXX, %uXXXX, \\NNN', repeatOk: true, sniff: true,
      dec: function (s) { return uescDec(s); }, enc: function (s, P) { return uescEnc(s, P); },
      params: [SEL('style', 'Encode style', [['u', '\\uXXXX'], ['u{', '\\u{…}'], ['U+', 'U+XXXX']], 'u', { enc: true })],
      auto: { cost: 1, test: function (st) { return /\\u[0-9a-f]{4}|\\u\{[0-9a-f]+\}|\\x[0-9a-f]{2}|U\+[0-9a-f]{4}|%u[0-9a-f]{4}|\\[0-3][0-7]{2}/i.test(st.t) ? 0.9 : 0; } } });
    op({ id: 'qp', name: 'Quoted-printable', cat: ENCOD, desc: 'MIME =XX escapes with soft line breaks', out: 'bytes', repeatOk: true,
      dec: function (s) { return qpDec(s); }, enc: function (s) { return qpEnc(s); },
      auto: { cost: 1, test: function (st) { var m = st.t.match(/=[0-9A-F]{2}/g); return m && m.length >= 2 && !/%[0-9A-F]{2}/.test(st.t) ? 0.6 : 0; } } });
    op({ id: 'uu', name: 'uuencode', cat: ENCOD, desc: 'begin 644 … / length-prefixed lines', out: 'bytes',
      dec: function (s) { return uuDec(s); }, encInp: 'bytes', enc: function (b, P) { return uuEnc(b, P); },
      params: [TXT('name', 'File name (encode)', 'data.txt')],
      auto: { cost: 1, test: function (st) { return /^begin [0-7]{3} /m.test(st.t) || /^M[!-`]{60}$/m.test(st.t) ? 0.95 : 0; } } });
    op({ id: 'puny', name: 'Punycode / IDN', cat: ENCOD, desc: 'xn-- labels of internationalised domains',
      dec: function (s) { return punyDec(s); }, enc: function (s) { return punyEnc(s); },
      auto: { cost: 1, test: function (st) { return /xn--[a-z0-9-]{2,}/i.test(st.t) ? 0.95 : 0; } } });
    op({ id: 'jwt', name: 'JWT decode', cat: ENCOD, desc: 'Header + payload of a JSON Web Token (signature not checked)',
      dec: function (s) { return jwtDec(s); },
      auto: { cost: 1, test: function (st) { return /^eyJ[\w-]+\.[\w-]+(\.[\w-]*)?$/.test(st.t.trim()) ? 0.98 : 0; } } });
    op({ id: 'datauri', name: 'data: URI', cat: ENCOD, desc: 'data:[type][;base64],payload', out: 'bytes',
      dec: function (s) { return dataUriDec(s); }, encInp: 'bytes', enc: function (b, P) { return 'data:' + (P.mime || 'text/plain') + ';base64,' + b64Enc(b); },
      params: [TXT('mime', 'MIME type (encode)', 'text/plain')],
      auto: { cost: 1, test: function (st) { return /^\s*data:[^,]*,/i.test(st.t) ? 0.98 : 0; } } });
    op({ id: 'inflate', name: 'Gunzip / inflate', cat: 'Compression', desc: 'gzip, zlib or raw DEFLATE bytes', inp: 'bytes', out: 'bytes', repeatOk: true, sniff: true,
      dec: function (b, P) {
        var f = P.format;
        if (f === 'gzip' || (f === 'auto' && b[0] === 0x1f && b[1] === 0x8b)) return gunzip(b);
        if (f === 'zlib' || (f === 'auto' && isZlib(b))) return unzlib(b);
        return inflateRaw(b).data;
      },
      encInp: 'bytes', enc: function (b) { var d = deflateStored(b), a = adler32(b); return concatBytes([new Uint8Array([0x78, 0x01]), d, new Uint8Array([a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255])]); },
      params: [SEL('format', 'Format', [['auto', 'auto'], ['gzip', 'gzip'], ['zlib', 'zlib'], ['raw', 'raw DEFLATE']], 'auto')],
      auto: { cost: 1, test: function (st, node) { var b = node.b; if (!b || b.length < 6) return 0; if ((b[0] === 0x1f && b[1] === 0x8b) || isZlib(b)) return 0.99; return node.t === null && b.length >= 8 ? 0.15 : 0; } } });
    op({ id: 'charset', name: 'Decode bytes as charset', cat: 'Compression', desc: 'UTF-16, Windows-125x, KOI8-R, Shift-JIS, GBK, Big5…', inp: 'bytes', encInp: 'text',
      dec: function (b, P) { var t = decodeCharset(b, P.charset, false); if (t === null) throw err('charset not supported here'); return t; },
      enc: function (s, P) { if (P.charset === 'utf-16le' || P.charset === 'utf-16be') { var u = new Uint8Array(s.length * 2); for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (P.charset === 'utf-16le') { u[2 * i] = c & 255; u[2 * i + 1] = c >> 8; } else { u[2 * i] = c >> 8; u[2 * i + 1] = c & 255; } } return u; } if (P.charset === 'windows-1252' && !/[^\x00-\xff]/.test(s)) return latin1Bytes(s); return utf8Encode(s); },
      params: [SEL('charset', 'Charset', CHARSETS.map(function (c) { return [c[0], c[1]]; }), 'utf-16le')] });

    // ---- codes ---------------------------------------------------------------
    var CODES = 'Codes';
    op({ id: 'morse', name: 'Morse code', cat: CODES, desc: '. - with / between words; also 0/1 and dit/dah', sniff: true,
      dec: function (s, P) { return morseDec(s, P); }, enc: function (s) { return morseEnc(s); },
      params: [SEL('variant', 'Symbols', [['std', '. and -'], ['01', '0 = dot, 1 = dash'], ['10', '1 = dot, 0 = dash']], 'std')],
      auto: { bits: 1, cost: 1, test: function (st) {
        if (tMorse(st)) return 0.97;
        return /^[01\s\/|]+$/.test(st.t) && /\s/.test(st.t.trim()) && st.t.trim().split(/[\s\/|]+/).every(function (g) { return g.length <= 6; }) ? 0.6 : 0;
      }, run: function (node) {
        var s = node.t, out = [];
        if (/^[01\s\/|]+$/.test(s)) { [['01', '0=dot'], ['10', '1=dot']].forEach(function (v) { try { out.push({ v: morseDec(s, { variant: v[0] }), label: v[1], params: { variant: v[0] } }); } catch (e) {} }); }
        else out.push({ v: morseDec(s, {}) });
        return out;
      } } });
    op({ id: 'bacon', name: 'Baconian', cat: CODES, desc: 'A/B (or 0/1, two symbols, letter case) in groups of 5',
      dec: function (s, P) { return baconDec(s, P); }, enc: function (s, P) { return baconEnc(s, P); },
      params: [SEL('variant', 'Alphabet', [['26', '26 letters (I≠J, U≠V)'], ['24', '24 letters (I=J, U=V)']], '26'), SEL('symbols', 'Symbols', [['auto', 'A/B, 0/1 or any two'], ['swap', 'swapped'], ['case', 'letter case (lower=A)']], 'auto')],
      auto: { bits: 2, cost: 1, test: function (st) { var s = st.ns; if (s.length < 10 || s.length % 5) return 0; var u = {}; for (var i = 0; i < s.length && i < 400; i++) u[s[i]] = 1; return Object.keys(u).length === 2 ? (/^[ABab01]+$/.test(s) ? 0.9 : 0.5) : 0; },
        run: function (node) {
          var out = [];
          ['26', '24'].forEach(function (v) { ['auto', 'swap'].forEach(function (sy) { try { out.push({ v: baconDec(node.t, { variant: v, symbols: sy }), label: v + ' letters' + (sy === 'swap' ? ', swapped' : ''), params: { variant: v, symbols: sy } }); } catch (e) {} }); });
          return out;
        }, keep: 2 } });
    op({ id: 'a1z26', name: 'A1Z26', cat: CODES, desc: 'Letters as numbers 1–26 (- or space; / between words)', sniff: true,
      dec: function (s) { return a1z26Dec(s); }, enc: function (s) { return a1z26Enc(s); },
      auto: { cost: 1, test: tA1Z26 } });
    op({ id: 't9', name: 'Phone keypad (multi-tap)', cat: CODES, desc: '44 33 555 555 666 → hello',
      dec: function (s) { return t9Dec(s); }, enc: function (s) { return t9Enc(s); },
      auto: { cost: 1, test: function (st) { var n = tNums(st) || (/^\d+$/.test(st.ns) ? [st.ns] : null); if (!n) return 0; var toks = st.t.trim().split(/[\s,.\/|_-]+/); return /^[02-9\s,.\/|_-]+$/.test(st.t) && toks.length >= 2 && toks.every(function (x) { return /^(\d)\1{0,3}$/.test(x); }) ? 0.8 : 0; } } });
    op({ id: 'nato', name: 'NATO phonetic', cat: CODES, desc: 'Alfa Bravo Charlie …',
      dec: function (s) { return natoDec(s); }, enc: function (s) { return natoEnc(s); },
      auto: { cost: 1, test: function (st) { var w = st.t.toLowerCase().match(/[a-z-]+/g) || []; return w.length >= 2 && w.filter(function (x) { return NATO[x]; }).length >= w.length * 0.7 ? 0.95 : 0; } } });
    op({ id: 'tap', name: 'Tap code', cat: CODES, desc: '5×5 square (C = K): dot groups or digit pairs',
      dec: function (s) { return tapDec(s); }, enc: function (s, P) { return tapEnc(s, P); },
      params: [SEL('style', 'Encode as', [['dots', 'dots'], ['digits', 'digits']], 'dots', { enc: true })],
      auto: { cost: 1, test: function (st) { return (/^[.\s\/•*]+$/.test(st.t) && /\. ?\./.test(st.t)) || (/^[1-5\s\/]+$/.test(st.t) && st.ns.length >= 4 && st.ns.length % 2 === 0) ? 0.75 : 0; } } });
    op({ id: 'braille', name: 'Braille', cat: CODES, desc: 'Unicode Braille cells ⠓⠑⠇⠇⠕ (Grade 1)',
      dec: function (s) { return brailleDec(s); }, enc: function (s) { return brailleEnc(s); },
      auto: { cost: 1, test: function (st) { var m = st.t.match(/[\u2801-\u28ff]/g); return m && m.length >= 2 ? 0.97 : 0; } } });
    op({ id: 'leet', name: 'Leetspeak', cat: CODES, desc: '1337 → leet (4=a 3=e 0=o 5=s 7=t …)', grp: 'leet',
      dec: function (s, P) { return leetDec(s, P); }, enc: function (s) { return leetEnc(s); },
      params: [SEL('one', '1 means', [['i', 'i'], ['l', 'l']], 'i')],
      auto: { bits: 1, cost: 1, test: function (st) { if (st.b64ish) return 0; var toks = st.t.match(/\S+/g) || []; var mixed = toks.filter(function (x) { return /[a-z]/i.test(x) && /[0-9@$!|]/.test(x); }).length; return mixed >= 1 && mixed >= toks.length * 0.2 && st.c && st.c.latin >= 3 ? 0.5 : 0; },
        run: function (node) { return [{ v: leetDec(node.t, {}) }, { v: leetDec(node.t, { one: 'l' }), label: '1 = l', params: { one: 'l' } }]; }, keep: 1 } });
    op({ id: 'flip', name: 'Upside-down text', cat: CODES, desc: 'ʇxǝʇ uʍop-ǝpᴉsdn → upside-down text', grp: 'flip',
      dec: function (s) { return flipDec(s); }, enc: function (s) { return flipEnc(s); },
      auto: { cost: 1, test: function (st) { return /[ɐɔǝɟƃɥᴉɾʞɯɹʇʌʍʎ∀Ǝ⅁˥⊥∩Λ⅄¿¡]/.test(st.t) ? 0.95 : 0; } } });
    op({ id: 'reverse', name: 'Reverse', cat: CODES, desc: 'Reverse the characters', grp: 'rev',
      dec: function (s) { return chars(s).reverse().join(''); }, enc: function (s) { return chars(s).reverse().join(''); },
      auto: { cost: 1, test: function (st) { return st.n >= 4 && st.n <= 200000 ? 0.3 : 0; } } });
    op({ id: 'zalgo', name: 'Strip Zalgo / diacritics', cat: CODES, desc: 'Remove stacked combining marks',
      dec: function (s) { return zalgoDec(s); },
      auto: { cost: 1, test: function (st) { return st.c && st.c.comb > Math.max(3, st.c.n * 0.2) ? 0.95 : 0; } } });
    op({ id: 'kbd', name: 'Keyboard shift (QWERTY)', cat: CODES, desc: 'Each key replaced by its left/right neighbour', grp: 'kbd',
      dec: function (s, P) { return kbdShift(s, P.dir); }, enc: function (s, P) { return kbdShift(s, P.dir === 'right' ? 'left' : 'right'); },
      params: [SEL('dir', 'Decode by moving', [['left', 'one key left'], ['right', 'one key right']], 'left')],
      auto: { bits: 1, cost: 1, test: function (st) { return st.al >= 4 && st.lr >= 0.6 && !st.b64ish ? 0.3 : 0; },
        run: function (node) { return [{ v: kbdShift(node.t, 'left'), label: 'left', params: { dir: 'left' } }, { v: kbdShift(node.t, 'right'), label: 'right', params: { dir: 'right' } }]; }, keep: 1 } });

    // ---- substitution ciphers -------------------------------------------------
    var SUBS = 'Substitution';
    op({ id: 'caesar', name: 'Caesar / ROT-N', cat: SUBS, desc: 'Shift every letter; Latin, Russian, Greek, Spanish, German, Hebrew alphabets', grp: 'mono',
      dec: function (s, P) { return caesar(s, +P.shift || 0, P.alphabet, false); }, enc: function (s, P) { return caesar(s, +P.shift || 0, P.alphabet, true); },
      params: [INT('shift', 'Shift', 3, 0, 32), SEL('alphabet', 'Alphabet', ALPHA_OPTS, 'latin')],
      auto: { bits: 4.7, cost: 1, keep: 3, test: function (st) { return st.al >= 3 || (st.c && (st.c.cyr >= 3 || st.c.greek >= 3 || st.c.hebrew >= 3)) ? 0.7 : 0; },
        run: function (node) {
          var st = stats(node), s = node.t, out = [], alphas = [];
          if (st.al >= 3) alphas.push('latin');
          if (st.c.cyr >= 3 && st.c.cyr >= st.c.latin) alphas.push('ru33', 'ru32');
          if (st.c.greek >= 3 && st.c.greek >= st.c.latin) alphas.push('greek');
          if (st.c.hebrew >= 3 && st.c.hebrew >= st.c.latin) alphas.push('hebrew');
          if (/[ñÑ]/.test(s)) alphas.push('es27');
          if (/[äöüÄÖÜ]/.test(s)) alphas.push('de29');
          alphas.forEach(function (ak) {
            for (var k = 1; k < alphaLen(ak); k++) out.push({ v: caesar(s, k, ak, false), label: (ak === 'latin' && k === 13 ? 'ROT13' : 'shift ' + k) + (ak !== 'latin' ? ' · ' + ALPHAS[ak][1] : ''), params: { shift: k, alphabet: ak } });
          });
          return out;
        } } });
    op({ id: 'rot13', name: 'ROT13', cat: SUBS, desc: 'Caesar shift 13 (its own inverse)', grp: 'mono',
      dec: function (s) { return caesar(s, 13); }, enc: function (s) { return caesar(s, 13); } });
    op({ id: 'rot47', name: 'ROT47', cat: SUBS, desc: 'Rotate all printable ASCII (! to ~)', grp: 'rot47',
      dec: function (s, P) { return rot47(s, 94 - mod(+P.n, 94)); }, enc: function (s, P) { return rot47(s, +P.n); },
      params: [INT('n', 'Rotation', 47, 1, 93)],
      auto: { cost: 1, test: function (st) { var s = st.ns; if (s.length < 4 || /[^!-~]/.test(s)) return 0; var sym = (s.match(/[^A-Za-z0-9]/g) || []).length; return sym >= 2 && sym > s.length * 0.08 ? 0.6 : 0; },
        run: function (node) { return [{ v: rot47(node.t, 47) }]; } } });
    op({ id: 'rot5', name: 'ROT5 / ROT18', cat: SUBS, desc: 'Rotate digits by 5 (ROT18 = ROT13 + ROT5)', grp: 'rot5',
      dec: function (s, P) { return P.mode === 'rot18' ? rot5(caesar(s, 13)) : rot5(s); }, enc: function (s, P) { return P.mode === 'rot18' ? rot5(caesar(s, 13)) : rot5(s); },
      params: [SEL('mode', 'Mode', [['rot5', 'ROT5 (digits)'], ['rot18', 'ROT18 (letters + digits)']], 'rot5')],
      auto: { bits: 1, cost: 1, test: function (st) { return st.c && st.c.digit >= 4 && st.c.digit >= (st.c.digit + st.c.latin) * 0.3 ? 0.25 : 0; },
        run: function (node) { return [{ v: rot5(node.t), label: 'ROT5', params: { mode: 'rot5' } }, { v: rot5(caesar(node.t, 13)), label: 'ROT18', params: { mode: 'rot18' } }]; }, keep: 1 } });
    op({ id: 'atbash', name: 'Atbash', cat: SUBS, desc: 'Mirror the alphabet (A↔Z); Latin, Hebrew, Greek, Russian', grp: 'mono',
      dec: function (s, P) { return atbash(s, P.alphabet); }, enc: function (s, P) { return atbash(s, P.alphabet); },
      params: [SEL('alphabet', 'Alphabet', ALPHA_OPTS, 'latin')],
      auto: { bits: 1, cost: 1, test: function (st) { return st.al >= 3 || (st.c && (st.c.cyr >= 3 || st.c.greek >= 3 || st.c.hebrew >= 3)) ? 0.5 : 0; },
        run: function (node) {
          var st = stats(node), out = [];
          if (st.al >= 3) out.push({ v: atbash(node.t, 'latin') });
          if (st.c.cyr >= 3 && st.c.cyr >= st.c.latin) { out.push({ v: atbash(node.t, 'ru33'), label: 'Russian 33', params: { alphabet: 'ru33' } }); out.push({ v: atbash(node.t, 'ru32'), label: 'Russian 32', params: { alphabet: 'ru32' } }); }
          if (st.c.greek >= 3 && st.c.greek >= st.c.latin) out.push({ v: atbash(node.t, 'greek'), label: 'Greek', params: { alphabet: 'greek' } });
          if (st.c.hebrew >= 3 && st.c.hebrew >= st.c.latin) out.push({ v: atbash(node.t, 'hebrew'), label: 'Hebrew', params: { alphabet: 'hebrew' } });
          return out;
        } } });
    op({ id: 'affine', name: 'Affine', cat: SUBS, desc: 'E(x) = a·x + b mod 26', grp: 'mono',
      dec: function (s, P) { return affine(s, P.a, P.b, false); }, enc: function (s, P) { return affine(s, P.a, P.b, true); },
      params: [INT('a', 'a (coprime with 26)', 5, 1, 25), INT('b', 'b', 8, 0, 25)],
      auto: { bits: 8.2, cost: 2, keep: 2, test: function (st, node) { return st.al >= 16 && st.lr >= 0.5 && readable(node) < 60 ? 0.5 : 0; }, run: function (node, ctx) { return affineAttack(node.t, ctx); } } });
    op({ id: 'keyword', name: 'Keyword substitution', cat: SUBS, desc: 'Cipher alphabet = keyword + remaining letters', grp: 'mono',
      dec: function (s, P) { return substCipher(s, keywordAlphabet(P.keyword), false); }, enc: function (s, P) { return substCipher(s, keywordAlphabet(P.keyword), true); },
      params: [TXT('keyword', 'Keyword', 'ZEBRAS')] });
    op({ id: 'subst', name: 'Simple substitution', cat: SUBS, desc: 'Any 26-letter cipher alphabet; Solve = hill-climbing on n-grams', grp: 'mono', solveLabel: 'Solve (hill-climb)',
      dec: function (s, P) { return substCipher(s, P.key, false); }, enc: function (s, P) { return substCipher(s, P.key, true); },
      params: [TXT('key', 'Cipher alphabet for A–Z', 'QWERTYUIOPASDFGHJKLZXCVBNM', '26 letters')],
      auto: { bits: 60, cost: 3, keep: 1, test: function (st, node) { return st.al >= 50 && st.cipherish && st.ic >= 0.05 && readable(node) < 45 ? 0.6 : 0; }, run: function (node, ctx) { return substAttack(node.t, ctx); } } });

    // ---- polyalphabetic ----------------------------------------------------------
    var POLY = 'Polyalphabetic';
    var polyTest = function (st, node) { return st.al >= 24 && st.cipherish && st.ic < 0.058 && readable(node) < 62 ? 0.6 : 0; };
    op({ id: 'vigenere', name: 'Vigenère', cat: POLY, desc: 'Repeating-key shifts; Solve = Kasiski/IC + frequency attack', grp: 'poly', solveLabel: 'Find key',
      dec: function (s, P) { return polyCipher(s, keyShifts(P.key), 'vig', false); }, enc: function (s, P) { return polyCipher(s, keyShifts(P.key), 'vig', true); },
      params: [TXT('key', 'Key', 'LEMON')],
      auto: { bits: function (p) { return 4.7 * String(p && p.key || 'AAAA').length; }, cost: 2, keep: 2, test: polyTest, run: function (node, ctx) { return polyAttack(node.t, 'vig', ctx); } } });
    op({ id: 'beaufort', name: 'Beaufort', cat: POLY, desc: 'C = K − P (reciprocal)', grp: 'poly', solveLabel: 'Find key',
      dec: function (s, P) { return polyCipher(s, keyShifts(P.key), 'beau', false); }, enc: function (s, P) { return polyCipher(s, keyShifts(P.key), 'beau', true); },
      params: [TXT('key', 'Key', 'FORTIFICATION')],
      auto: { bits: function (p) { return 4.7 * String(p && p.key || 'AAAA').length; }, cost: 2, keep: 1, test: polyTest, run: function (node, ctx) { return polyAttack(node.t, 'beau', ctx); } } });
    op({ id: 'varbeaufort', name: 'Variant Beaufort', cat: POLY, desc: 'C = P − K (Vigenère run backwards)', grp: 'poly',
      dec: function (s, P) { return polyCipher(s, keyShifts(P.key), 'varb', false); }, enc: function (s, P) { return polyCipher(s, keyShifts(P.key), 'varb', true); },
      params: [TXT('key', 'Key', 'KEY')] });
    op({ id: 'gronsfeld', name: 'Gronsfeld', cat: POLY, desc: 'Vigenère with a numeric key (shifts 0–9)', grp: 'poly',
      dec: function (s, P) { return polyCipher(s, keyShifts(P.key, true), 'vig', false); }, enc: function (s, P) { return polyCipher(s, keyShifts(P.key, true), 'vig', true); },
      params: [TXT('key', 'Digits', '31415')] });
    op({ id: 'autokey', name: 'Autokey (Vigenère)', cat: POLY, desc: 'Primer, then the plaintext itself as key', grp: 'poly', solveLabel: 'Find primer',
      dec: function (s, P) { return autokey(s, P.key, false); }, enc: function (s, P) { return autokey(s, P.key, true); },
      params: [TXT('key', 'Primer', 'QUEEN')],
      auto: { bits: function (p) { return 4.7 * String(p && p.key || 'AAAA').length; }, cost: 2, keep: 1, test: function (st, node) { return st.al >= 30 && st.cipherish && st.ic < 0.06 && readable(node) < 50 ? 0.45 : 0; }, run: function (node, ctx) { return autokeyAttack(node.t, ctx); } } });
    op({ id: 'porta', name: 'Porta', cat: POLY, desc: '13 reciprocal alphabets chosen by key-letter pairs', grp: 'poly', solveLabel: 'Find key',
      dec: function (s, P) { return porta(s, P.key); }, enc: function (s, P) { return porta(s, P.key); },
      params: [TXT('key', 'Key', 'PORTA')],
      auto: { bits: function (p) { return 3.7 * String(p && p.key || 'AAAA').length; }, cost: 2, keep: 1, test: polyTest, run: function (node, ctx) { return polyAttack(node.t, 'porta', ctx); } } });
    op({ id: 'trithemius', name: 'Trithemius / progressive', cat: POLY, desc: 'Shift grows each letter (Alberti-style progression)', grp: 'poly', solveLabel: 'Find start/step',
      dec: function (s, P) { return progressive(s, P.start, P.step, P.period, false); }, enc: function (s, P) { return progressive(s, P.start, P.step, P.period, true); },
      params: [INT('start', 'Start shift', 0, 0, 25), INT('step', 'Step', 1, -25, 25), INT('period', 'Letters per step', 1, 1, 50)],
      auto: { bits: 9.3, cost: 2, keep: 1, test: function (st, node) { return st.al >= 24 && st.cipherish && readable(node) < 50 ? 0.4 : 0; }, run: function (node, ctx) { return progressiveAttack(node.t, ctx); } } });
    op({ id: 'hill', name: 'Hill 2×2', cat: POLY, desc: 'Matrix cipher on letter pairs; Solve brute-forces all invertible 2×2 keys', grp: 'poly', solveLabel: 'Brute-force key',
      dec: function (s, P) { return hill(s, P.key, false); }, enc: function (s, P) { return hill(s, P.key, true); },
      params: [TXT('key', 'Key (a b c d or 4 letters)', '3 3 2 5')],
      auto: { bits: 17, cost: 2, keep: 1, test: function (st, node) { return st.al >= 20 && st.cipherish && st.ic < 0.058 && readable(node) < 50 ? 0.35 : 0; }, run: function (node, ctx) { return hillAttack(node.t, ctx); } } });

    // ---- Polybius & fractionating ------------------------------------------------
    var SQUARE = 'Polybius & fractionating';
    op({ id: 'polybius', name: 'Polybius square', cat: SQUARE, desc: 'Row/column coordinates; keyed squares, 5×5 or 6×6, custom symbols',
      dec: function (s, P) { return polybiusDec(s, P); }, enc: function (s, P) { return polybiusEnc(s, P); },
      params: [TXT('key', 'Square keyword', ''), SEL('size', 'Size', [['5', '5×5'], ['6', '6×6 (A–Z 0–9)']], '5'), SEL('variant', '5×5 merge', [['ij', 'I = J'], ['ck', 'C = K'], ['noq', 'drop Q']], 'ij'), TXT('coords', 'Coordinate symbols', '12345')],
      auto: { bits: 1, cost: 1, test: function (st) { return /^[1-5\s\/]+$/.test(st.t) && st.ns.length >= 4 && st.ns.length % 2 === 0 ? 0.75 : (/^[1-6\s\/]+$/.test(st.t) && /6/.test(st.t) && st.ns.length % 2 === 0 ? 0.6 : 0); },
        run: function (node) { var out = []; [[5, 'ij'], [6, 'ij']].forEach(function (v) { try { out.push({ v: polybiusDec(node.t, { size: v[0], variant: v[1] }), label: v[0] + '×' + v[0], params: { size: String(v[0]) } }); } catch (e) {} }); return out; } } });
    op({ id: 'nihilist', name: 'Nihilist', cat: SQUARE, desc: 'Polybius numbers plus repeating key numbers',
      dec: function (s, P) { return nihilist(s, P.squareKey, P.key, false); }, enc: function (s, P) { return nihilist(s, P.squareKey, P.key, true); },
      params: [TXT('squareKey', 'Square keyword', 'ZEBRAS'), TXT('key', 'Key', 'RUSSIAN')] });
    op({ id: 'bifid', name: 'Bifid', cat: SQUARE, desc: 'Delastelle: coordinates split and re-paired (period optional)', grp: 'frac',
      dec: function (s, P) { return bifid(s, P.key, P.period, false); }, enc: function (s, P) { return bifid(s, P.key, P.period, true); },
      params: [TXT('key', 'Square keyword', ''), INT('period', 'Period (0 = whole)', 0, 0, 100)],
      auto: { bits: 3.6, cost: 2, keep: 1, test: function (st, node) { return st.al >= 20 && st.cipherish && !/[jJ]/.test(st.t) && readable(node) < 45 ? 0.2 : 0; }, run: function (node, ctx) { return bifidAttack(node.t, ctx); } } });
    op({ id: 'trifid', name: 'Trifid', cat: SQUARE, desc: '3×3×3 cube (A–Z and +), period optional',
      dec: function (s, P) { return trifid(s, P.key, P.period, false); }, enc: function (s, P) { return trifid(s, P.key, P.period, true); },
      params: [TXT('key', 'Cube keyword', ''), INT('period', 'Period (0 = whole)', 5, 0, 100)] });
    op({ id: 'playfair', name: 'Playfair', cat: SQUARE, desc: 'Digraphs on a keyed 5×5 square (I = J)',
      dec: function (s, P) { return playfair(s, P.key, false); }, enc: function (s, P) { return playfair(s, P.key, true); },
      params: [TXT('key', 'Keyword', 'PLAYFAIR EXAMPLE')] });
    op({ id: 'twosquare', name: 'Two-square', cat: SQUARE, desc: 'Two keyed squares, vertical or horizontal',
      dec: function (s, P) { return twoSquare(s, P.key1, P.key2, P.layout === 'h', false); }, enc: function (s, P) { return twoSquare(s, P.key1, P.key2, P.layout === 'h', true); },
      params: [TXT('key1', 'Key 1', 'EXAMPLE'), TXT('key2', 'Key 2', 'KEYWORD'), SEL('layout', 'Layout', [['v', 'vertical'], ['h', 'horizontal']], 'v')] });
    op({ id: 'foursquare', name: 'Four-square', cat: SQUARE, desc: 'Two plain + two keyed 5×5 squares',
      dec: function (s, P) { return fourSquare(s, P.key1, P.key2, false); }, enc: function (s, P) { return fourSquare(s, P.key1, P.key2, true); },
      params: [TXT('key1', 'Key 1', 'EXAMPLE'), TXT('key2', 'Key 2', 'KEYWORD')] });
    op({ id: 'adfgx', name: 'ADFGX', cat: SQUARE, desc: '5×5 square to A D F G X pairs, then columnar transposition',
      dec: function (s, P) { return adfgx(s, P.squareKey, P.transKey, false, false); }, enc: function (s, P) { return adfgx(s, P.squareKey, P.transKey, false, true); },
      params: [TXT('squareKey', 'Square keyword', 'BTALPDHOZKQFVSNGICUXMREWY'), TXT('transKey', 'Transposition key', 'CARGO')] });
    op({ id: 'adfgvx', name: 'ADFGVX', cat: SQUARE, desc: '6×6 square (A–Z 0–9) then columnar transposition',
      dec: function (s, P) { return adfgx(s, P.squareKey, P.transKey, true, false); }, enc: function (s, P) { return adfgx(s, P.squareKey, P.transKey, true, true); },
      params: [TXT('squareKey', 'Square keyword', 'NA1C3H8TB2OME5WRPD4F6G7I9J0KLQSUVXYZ'), TXT('transKey', 'Transposition key', 'PRIVACY')] });

    // ---- transposition --------------------------------------------------------------
    var TRANS = 'Transposition';
    var transTest = function (min) { return function (st, node) { return st.al >= min && st.lr >= 0.7 && !st.b64ish && readable(node) < 62 && fitCos(st) >= 0.88 ? 0.55 : 0; }; };
    op({ id: 'railfence', name: 'Rail fence', cat: TRANS, desc: 'Zigzag over N rails, optional offset', grp: 'trans', solveLabel: 'Find rails',
      dec: function (s, P) { return railFence(s, P.rails, P.offset, false); }, enc: function (s, P) { return railFence(s, P.rails, P.offset, true); },
      params: [INT('rails', 'Rails', 3, 2, 50), INT('offset', 'Offset', 0, 0, 98)],
      auto: { bits: 6.5, cost: 2, keep: 2, test: transTest(12), run: function (node, ctx) { return railAttack(node.t, ctx); } } });
    op({ id: 'scytale', name: 'Scytale', cat: TRANS, desc: 'Strip around a rod: rows × columns read down', grp: 'trans', solveLabel: 'Find rows',
      dec: function (s, P) { return scytale(s, P.rows, false); }, enc: function (s, P) { return scytale(s, P.rows, true); },
      params: [INT('rows', 'Rows (letters around)', 4, 2, 100)],
      auto: { bits: 5, cost: 2, keep: 1, test: transTest(12), run: function (node, ctx) { return scytaleAttack(node.t, ctx); } } });
    op({ id: 'columnar', name: 'Columnar transposition', cat: TRANS, desc: 'Columns read in keyword order; Solve tries every key up to 7', grp: 'trans', solveLabel: 'Brute-force key',
      dec: function (s, P) { return colDec(s, P.key); }, enc: function (s, P) { return colEnc(s, P.key); },
      params: [TXT('key', 'Key (word or 3 1 2)', 'ZEBRAS')],
      auto: { bits: 12, cost: 3, keep: 2, test: transTest(16), run: function (node, ctx) { return columnarAttack(node.t, ctx); } } });
    op({ id: 'dcolumnar', name: 'Double columnar', cat: TRANS, desc: 'Columnar transposition applied twice', grp: 'trans',
      dec: function (s, P) { return colDec(colDec(s, P.key2), P.key1); }, enc: function (s, P) { return colEnc(colEnc(s, P.key1), P.key2); },
      params: [TXT('key1', 'First key', 'ZEBRAS'), TXT('key2', 'Second key', 'STRIPE')] });
    op({ id: 'route', name: 'Route transposition', cat: TRANS, desc: 'Grid read along a route: spiral, snake, columns, diagonals', grp: 'trans', solveLabel: 'Find route',
      dec: function (s, P) { return route(s, P.cols, P.route, false); }, enc: function (s, P) { return route(s, P.cols, P.route, true); },
      params: [INT('cols', 'Columns', 5, 2, 100), SEL('route', 'Route', ROUTES, 'spiral')],
      auto: { bits: 7.5, cost: 2, keep: 1, test: transTest(16), run: function (node, ctx) { return routeAttack(node.t, ctx); } } });

    // ---- binary ------------------------------------------------------------------------
    var BIN = 'Binary';
    op({ id: 'xor1', name: 'XOR (single byte)', cat: BIN, desc: 'XOR every byte with one key; Solve tries all 256', inp: 'bytes', out: 'bytes', grp: 'xor', solveLabel: 'Brute-force key',
      dec: function (b, P) { return xorBytes(b, new Uint8Array([+P.key & 255])); }, enc: function (b, P) { return xorBytes(b, new Uint8Array([+P.key & 255])); },
      params: [INT('key', 'Key byte (0–255)', 42, 0, 255)],
      auto: { bits: 8, cost: 2, keep: 2, test: function (st, node) { return node.b && (node.t === null || readable(node) < 50) ? 0.6 : 0; }, run: function (node) { return xor1Attack(node.b); } } });
    op({ id: 'xor', name: 'XOR (repeating key)', cat: BIN, desc: 'XOR with a text / hex key; Solve = Hamming key length + per-byte attack', inp: 'bytes', out: 'bytes', grp: 'xor', solveLabel: 'Find key',
      dec: function (b, P) { return xorBytes(b, parseKeyBytes(P.key, P.keyType)); }, enc: function (b, P) { return xorBytes(b, parseKeyBytes(P.key, P.keyType)); },
      params: [TXT('key', 'Key', 'ICE'), SEL('keyType', 'Key is', [['text', 'text (UTF-8)'], ['hex', 'hex'], ['dec', 'decimal bytes'], ['b64', 'Base64']], 'text')],
      auto: { bits: function (p) { return 8 * Math.max(2, String(p && p.key || 'AA').length / (p && p.keyType === 'hex' ? 2 : 1)); }, cost: 3, keep: 1, test: function (st, node) { return node.b && node.b.length >= 16 && (node.t === null || readable(node) < 50) ? 0.5 : 0; }, run: function (node) { return xorNAttack(node.b); } } });

    var AUTO = OPS.filter(function (o) { return o.auto && o.auto.test; });
    var SNIFF = OPS.filter(function (o) { return o.sniff && o.auto && o.auto.test; });

    // ===================================================================
    // Values + manual recipes
    // ===================================================================
    function asText(v) { if (!isBytes(v)) return String(v); var u = utf8Strict(v); return u !== null ? u : latin1(v); }
    function asBytes(v) { return isBytes(v) ? v : textToBytes(String(v)); }
    function apply(id, input, P, dir) {
      var o = OPS_BY_ID[id];
      if (!o) throw err('unknown operation ' + id);
      var params = P0(o, P), enc = dir === 'enc';
      if (enc && !o.enc) throw err(o.name + ' has no encoder');
      var want = enc ? o.encInp : o.inp;
      return enc ? o.enc(want === 'bytes' ? asBytes(input) : asText(input), params) : o.dec(want === 'bytes' ? asBytes(input) : asText(input), params);
    }
    function describe(v) {
      if (!isBytes(v)) return { text: v, isBytes: false, len: v.length };
      var u = utf8Strict(v);
      if (u !== null && !/[\x00-\x08\x0e-\x1f]/.test(u.slice(0, 4000))) return { text: u, isBytes: false, fromBytes: true, len: u.length, bytes: v.length };
      var mg = magic(v);
      return { text: null, isBytes: true, hex: toHex(v.subarray(0, 65536), ' '), latin1: latin1(v.subarray(0, 4096)), len: v.length, magic: mg ? mg.name : '', ext: mg ? mg.ext : '' };
    }
    function runRecipe(input, steps) {
      var v = input, out = [];
      for (var i = 0; i < steps.length; i++) {
        var st = steps[i];
        if (st.off) { out.push({ ok: true, skipped: true }); continue; }
        try { v = apply(st.op, v, st.params, st.dir); var d = describe(v); d.ok = true; out.push(d); }
        catch (e) {
          out.push({ ok: false, error: String(e && e.message || e) });
          return { steps: out, value: null, at: i, error: (OPS_BY_ID[st.op] ? OPS_BY_ID[st.op].name : st.op) + ': ' + (e && e.message || e) };
        }
      }
      return { steps: out, value: v };
    }
    function scoreView(b) {
      var views = bytesViews(b), best = null;
      for (var i = 0; i < views.length; i++) {
        var sc = score(views[i].t);
        if (views[i].cs !== 'utf-8') sc.score = Math.round(sc.score * 0.95);
        if (!best || sc.score > best.sc.score) best = { t: views[i].t, cs: views[i].cs, sc: sc };
      }
      var bs = scoreBytes(b);
      if (!best || bs.score > best.sc.score) return { t: best && best.cs === 'utf-8' ? best.t : null, cs: best && best.cs === 'utf-8' ? 'utf-8' : '', sc: bs };
      if (best.cs !== 'utf-8' && best.sc.score < 45) return { t: null, cs: '', sc: bs };
      return best;
    }
    var nodeId = 0;
    function mkRoot(input) {
      var n = { id: ++nodeId, parent: null, op: null, depth: 0, prio: 50 };
      if (isBytes(input)) { n.b = input; var sv = scoreView(input); n.t = sv.t; n.cs = sv.cs; n.sc = sv.sc; }
      else { n.b = null; n.t = String(input); n.sc = score(n.t); }
      return n;
    }
    function solve(id, input, opts) {
      var o = OPS_BY_ID[id];
      if (!o || !o.auto || !o.auto.run) return null;
      var node = mkRoot(input);
      if (o.inp === 'bytes' && !node.b) node.b = textToBytes(node.t);
      var ctx = { lang: opts && opts.lang, deadline: now() + ((opts && opts.ms) || 2500), restarts: 12 };
      var outs = [];
      try { outs = o.auto.run(node, ctx) || []; } catch (e) { return null; }
      var best = null;
      outs.forEach(function (c) {
        if (c.v == null) return;
        var s = isBytes(c.v) ? scoreView(c.v).sc.score : score(c.v).score;
        if (!best || s > best.s) best = { s: s, c: c };
      });
      return best ? { params: best.c.params || {}, label: best.c.label || '', score: best.s } : null;
    }

    // ===================================================================
    // Chain search: breadth-first beam over decoder chains. Each level runs
    // the cheap decoders first, the brute-force attacks last; children are
    // ranked by readability or by a one-step lookahead through the encoding
    // they most look like (so "ROT13 of Base64" ranks the right shift high).
    // ===================================================================
    var NO_REPEAT_GRP = { mono: 1, poly: 1, trans: 1, rev: 1, xor: 1, flip: 1, kbd: 1, rot47: 1, rot5: 1, leet: 1, frac: 1 };
    // Text-scrambling ciphers. Two in a row (even with a Reverse between) are
    // almost never how puzzles are built, and the solvers would happily
    // "undo" each other into pseudo-English — so the search never stacks them.
    var CIPHER_GRP = { mono: 1, poly: 1, trans: 1, xor: 1, flip: 1, kbd: 1, rot47: 1, rot5: 1, leet: 1, frac: 1 };
    function chainAllowed(node, o) {
      if (!node.op) return true;
      var p = OPS_BY_ID[node.op];
      if (p.id === o.id && !o.repeatOk) return false;
      if (p.grp && o.grp && p.grp === o.grp && NO_REPEAT_GRP[o.grp]) return false;
      if (o.grp === 'rev' || (o.grp === 'trans' && p.grp === 'rev')) {
        for (var r = node; r && r.op; r = r.parent) { var rg = OPS_BY_ID[r.op].grp; if (rg === 'rev' || (o.grp === 'rev' && rg === 'trans')) return false; }
      }
      if (CIPHER_GRP[o.grp]) {
        for (var a = node; a && a.op; a = a.parent) {
          var g = OPS_BY_ID[a.op].grp;
          if (CIPHER_GRP[g]) return false;
          if (g !== 'rev') break;
        }
      }
      return true;
    }
    function keyOf(n) {
      return n.t !== null && n.t !== undefined ? 't' + n.t.length + ':' + n.t.slice(0, 2048) : 'b' + n.b.length + ':' + latin1(n.b.subarray(0, 1024));
    }
    var HAS_RAW = /[\x00-\x08\x0e-\x1f\x7f-\xff]/;
    function Search(input, opts) {
      opts = opts || {};
      this.o = {
        depth: clamp(+opts.depth || 3, 1, 5), beam: clamp(+opts.beam || 40, 4, 200), budget: clamp(+opts.budget || 8000, 100, 120000),
        lang: opts.lang || 'auto', clear: +opts.clear || 70, keepLooking: opts.keepLooking === undefined ? 900 : +opts.keepLooking,
      };
      this.t0 = now(); this.deadline = this.t0 + this.o.budget;
      this.seen = {}; this.all = []; this.tried = 0; this.ops = 0;
      this.root = mkRoot(input);
      this.seen[keyOf(this.root)] = 1;
      this.level = [this.root]; this.depth = 0; this.items = null; this.ii = 0; this.next = [];
      this.found = 0; this.done = false; this.stopped = false; this.timedOut = false;
      this.ctx = { lang: this.o.lang === 'auto' ? '' : this.o.lang };
    }
    Search.prototype._prep = function () {
      var items = [], self = this;
      this.level.forEach(function (node) {
        if (node !== self.root && node.sc.score >= self.o.clear) return;
        var st = stats(node);
        AUTO.forEach(function (o) {
          if (!chainAllowed(node, o)) return;
          if (o.inp === 'bytes') {
            if (!node.b) { if (st.has && HAS_RAW.test(st.t.slice(0, 2000))) node.b = textToBytes(node.t); else return; }
          } else if (!st.has) return;
          var c = 0;
          try { c = o.auto.test(st, node) || 0; } catch (e) { c = 0; }
          if (c <= 0) return;
          items.push({ node: node, op: o, cost: o.auto.cost || 1, pr: (node.prio || 0) * (0.6 + 0.4 * c) + c * 10 });
        });
      });
      items.sort(function (a, b) { return a.cost - b.cost || b.pr - a.pr; });
      this.items = items; this.ii = 0; this.next = [];
    };
    Search.prototype._prio = function (n) {
      var r = n.sc.score, la = 0, sn = 0;
      if (n.depth < this.o.depth) {
        var st = stats(n), best = null;
        for (var i = 0; i < SNIFF.length; i++) {
          var o = SNIFF[i];
          if (!chainAllowed(n, o)) continue;
          if (o.inp === 'bytes' ? !n.b : !st.has) continue;
          var c = 0;
          try { c = o.auto.test(st, n) || 0; } catch (e) { c = 0; }
          if (c > sn) { sn = c; best = o; }
        }
        if (best && sn >= 0.5) {
          try {
            var v = best.dec(best.inp === 'bytes' ? n.b : n.t, P0(best));
            la = isBytes(v) ? scoreView(v).sc.score : score(v).score;
          } catch (e) { la = 0; }
        }
      }
      n.la = la;
      return Math.max(r, la * 0.97, sn * 45) - n.depth * 1.5;
    };
    Search.prototype._child = function (parent, o, out, local) {
      var v = out.v;
      if (v == null || !v.length) return null;
      var n = { parent: parent, op: o.id, name: o.name, label: out.label || '', params: out.params || null, depth: parent.depth + 1, b: null };
      if (isBytes(v)) { n.b = v; var sv = scoreView(v); n.t = sv.t; n.cs = sv.cs; n.sc = sv.sc; }
      else { n.t = v; n.sc = score(v); }
      if (n.t !== null && n.t !== undefined && n.t === parent.t) return null;
      // Look-elsewhere penalty: a brute force over many keys always finds
      // something n-gram-plausible in a short text. Charge the key bits per
      // letter unless dictionary words back the reading up.
      var bits = o.auto && o.auto.bits;
      if (typeof bits === 'function') bits = bits(n.params);
      if (bits && n.sc.score > 0 && (n.sc.wh || 0) < 0.8 && !/^(flag|json|url|email|file|domain)$/.test(n.sc.lang)) {
        var nl = Math.max(1, n.sc.letters || (n.t ? n.t.length : 1));
        var pen = Math.min(45, 30 * bits / nl);
        if (pen >= 1) { n.sc = { score: Math.max(0, Math.round(n.sc.score - pen)), lang: n.sc.lang, langName: n.sc.langName, conf: n.sc.conf, script: n.sc.script, wh: n.sc.wh, letters: n.sc.letters }; }
      }
      n.key = keyOf(n);
      if (this.seen[n.key] || local[n.key]) return null;
      local[n.key] = 1;
      this.tried++;
      n.prio = this._prio(n);
      n.id = ++nodeId;
      return n;
    };
    Search.prototype._run = function (it) {
      var node = it.node, o = it.op, outs = [], keep = o.auto.keep || 3;
      this.ctx.deadline = Math.min(this.deadline, now() + (o.auto.cost >= 3 ? 1600 : 700));
      try {
        if (o.auto.run && o.inp !== 'bytes' && node.t && node.t.length > 40000) {
          // Huge text: find the keys on a 20 KB sample, then decode the
          // whole text only for the best few (keeps each step bounded).
          var sample = { t: node.t.slice(0, 20000), b: null, sc: node.sc, depth: node.depth, op: node.op, parent: node.parent };
          var cands = (o.auto.run(sample, this.ctx) || []).map(function (c) { return { c: c, s: isBytes(c.v) ? 0 : score(c.v).score }; });
          cands.sort(function (a, b) { return b.s - a.s; });
          outs = cands.slice(0, keep).map(function (x) { return { v: o.dec(node.t, P0(o, x.c.params)), label: x.c.label, params: x.c.params }; });
        } else if (o.auto.run) outs = o.auto.run(node, this.ctx) || [];
        else outs = [{ v: o.dec(o.inp === 'bytes' ? node.b : node.t, P0(o)) }];
      } catch (e) { outs = []; }
      this.ops++;
      var kids = [], local = {};
      for (var i = 0; i < outs.length; i++) { var c = this._child(node, o, outs[i], local); if (c) kids.push(c); }
      if (kids.length > keep) { kids.sort(function (a, b) { return b.prio - a.prio; }); kids = kids.slice(0, keep); }
      for (var k = 0; k < kids.length; k++) {
        var kid = kids[k];
        this.seen[kid.key] = 1;
        this.all.push(kid); this.next.push(kid);
        if (kid.sc.score >= this.o.clear && !this.found) this.found = now();
      }
      if (this.all.length > 3000) { this.all.sort(function (a, b) { return b.sc.score - a.sc.score; }); this.all.length = 1500; }
    };
    Search.prototype.step = function (ms) {
      if (this.done) return true;
      var end = Math.min(now() + (ms || 50), this.deadline), self = this;
      while (!this.done) {
        if (this.stopped) { this.done = true; break; }
        if (!this.items) {
          if (this.depth >= this.o.depth || !this.level.length) { this.done = true; break; }
          this._prep();
        }
        if (this.ii >= this.items.length) {
          this.depth++;
          var nx = this.next.filter(function (n) { return n.sc.score < self.o.clear; });
          nx.sort(function (a, b) { return b.prio - a.prio; });
          this.level = nx.slice(0, this.o.beam);
          this.items = null;
          if (this.found && now() > this.found + this.o.keepLooking) { this.done = true; break; }
          if (now() >= end) break;
          continue;
        }
        this._run(this.items[this.ii++]);
        var t = now();
        if (t >= this.deadline) { this.done = true; this.timedOut = true; break; }
        if (this.found && t > this.found + this.o.keepLooking) { this.done = true; break; }
        if (t >= end) break;
      }
      return this.done;
    };
    Search.prototype.stop = function () { this.stopped = true; this.done = true; };
    Search.prototype.runSync = function () { while (!this.step(1000)) { /* loop */ } return this; };
    function chainOf(n) {
      var c = [];
      while (n && n.op) { c.unshift({ id: n.op, name: n.name, label: n.label, params: n.params, charset: n.cs && n.cs !== 'utf-8' ? n.cs : '' }); n = n.parent; }
      return c;
    }
    function nodeOut(n, full) {
      var r = { id: n.id, chain: chainOf(n), depth: n.depth, score: n.sc.score, lang: n.sc.lang, langName: n.sc.langName, conf: n.sc.conf, script: n.sc.script || '' };
      var cap = full ? 500000 : 1500;
      if (n.t !== null && n.t !== undefined) {
        r.text = n.t.length > cap ? n.t.slice(0, cap) : n.t; r.truncated = n.t.length > cap; r.len = n.t.length;
        if (n.cs && n.cs !== 'utf-8') r.charset = n.cs;
      } else {
        r.isBytes = true; r.len = n.b.length; r.hex = toHex(n.b.subarray(0, full ? 16384 : 96), ' ');
        var mg = magic(n.b); r.magic = mg ? mg.name : ''; r.ext = mg ? mg.ext : '';
        if (full) r.bytes = n.b.length > 8 * 1024 * 1024 ? n.b.slice(0, 8 * 1024 * 1024) : n.b.slice();
      }
      return r;
    }
    Search.prototype.top = function (n, full) {
      var arr = this.all.slice().sort(function (a, b) { return b.sc.score - a.sc.score || a.depth - b.depth || b.prio - a.prio || a.id - b.id; });
      var out = [];
      for (var i = 0; i < arr.length && out.length < n; i++) {
        if (arr[i].sc.score < 8 && out.length >= 6) break;
        out.push(nodeOut(arr[i], full));
      }
      return out;
    };
    Search.prototype.progress = function () {
      var best = 0; this.all.forEach(function (x) { if (x.sc.score > best) best = x.sc.score; });
      return { tried: this.tried, ops: this.ops, depth: Math.min(this.depth + 1, this.o.depth), maxDepth: this.o.depth, elapsed: Math.round(now() - this.t0), done: this.done, best: best, timedOut: this.timedOut, input: { score: this.root.sc.score, lang: this.root.sc.lang, langName: this.root.sc.langName } };
    };

    return {
      version: 1,
      setData: setData,
      hasData: function () { return HAVE_DATA; },
      ops: function () {
        return OPS.map(function (o) {
          return { id: o.id, name: o.name, cat: o.cat, desc: o.desc || '', params: o.params, hasEnc: !!o.enc, canSolve: !!(o.auto && o.auto.run), solveLabel: o.solveLabel || '', inp: o.inp, auto: !!(o.auto && o.auto.test) };
        });
      },
      apply: apply, solve: solve, runRecipe: runRecipe, describe: describe,
      score: score,
      scoreView: function (b) { var s = scoreView(b); return { text: s.t, charset: s.cs, score: s.sc }; },
      analyze: analyze, identify: identify,
      createSearch: function (input, opts) { return new Search(input, opts); },
      langs: function () {
        return Object.keys(LANGS).map(function (k) {
          var L = LANGS[k];
          return { code: k, name: L.name, script: L.script, ic: L.ic, alpha: (L.script === 'Latin' ? LO : L.alpha).toUpperCase(), uni: Array.prototype.slice.call(L.uni) };
        });
      },
      charsets: supportedCharsets,
      util: {
        utf8Encode: utf8Encode, utf8Decode: utf8Strict, latin1: latin1, latin1Bytes: latin1Bytes, toHex: toHex, hexDec: hexDec,
        textToBytes: textToBytes, magic: magic, b64Enc: b64Enc, b64Dec: b64Dec, inflateRaw: inflateRaw, gunzip: gunzip, unzlib: unzlib,
        deflateStored: deflateStored, bytesViews: bytesViews, decodeCharset: decodeCharset, chars: chars, isBytes: isBytes,
      },
      internal: {
        polyAttack: polyAttack, autokeyAttack: autokeyAttack, hillAttack: hillAttack, substSolve: substSolve, xor1Attack: xor1Attack,
        xorNAttack: xorNAttack, railAttack: railAttack, columnarAttack: columnarAttack, progressiveAttack: progressiveAttack,
        affineAttack: affineAttack, periodicIC: periodicIC, kasiski: kasiski, lang: function (c) { return LANGS[c]; },
        keywordAlphabet: keywordAlphabet, classify: classify,
      },
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = DecodeLabCore;
  else root.__DecodeLabCore = DecodeLabCore;
})(typeof self !== 'undefined' ? self : this);
