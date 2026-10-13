/* File Converter — convert video, audio, images and documents ENTIRELY on
 * this device. Files are never uploaded, synced or stored in rooms/Firebase/
 * Cade.store: they go from the file picker to a converter running in this tab
 * and back out as a download / share-sheet file.
 *
 * ENGINES (chosen per file, all lazy — nothing loads until a conversion needs it)
 *   Fast · WebCodecs   Mediabunny in a worker (hardware encode/decode). MOV->MP4
 *                      remuxes instantly when the codecs fit; streams in & out.
 *   Compatible · ffmpeg  ffmpeg.wasm single-threaded core in a worker, for what
 *                      WebCodecs can't do (AVI/WMV/FLV, GIF in/out, odd codecs)
 *                      and as the automatic fallback when the fast path fails.
 *   Native             canvas for images (HEIC too where Safari decodes it;
 *                      libheif wasm otherwise), pdf.js / mammoth / docx /
 *                      SheetJS / pdf-lib / marked / turndown for documents.
 *   See convert-worker.js (media + HEIC + OPFS writes) and convert-docs.js.
 *
 * STORAGE: big outputs are written by the worker straight into the Origin
 * Private File System (sync access handle) — or, on desktop Chromium, into the
 * file the user picked with showSaveFilePicker — and handed back as a
 * disk-backed File (download link + Web Share sheet). Temp files live under
 * OPFS 'cade-convert-tmp/<session>/' and are deleted when the panel closes
 * (after a grace period so a download in flight can finish) or, if the tab
 * died, swept on the next open. Converter code is cached once in our own
 * Cache Storage bucket 'cade-convert-v1' ("Remove downloaded converters").
 *
 * Self-contained IIFE; panel listeners are scoped to the panel element. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('convert.css');
  // Resolved now, while the loader's module context is ours. No ?v= tag: the
  // manifest precaches these exact URLs (offline from cold), and a release
  // re-precaches them together with this file, so they can't drift apart.
  var WORKER_URL = Cade.asset('convert-worker.js');
  var DOCS_URL = Cade.asset('convert-docs.js');
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'convert-panel';
  var PREFS_KEY = 'cade-convert-prefs';
  var CACHE = 'cade-convert-v1';        // must match convert-worker.js
  var TMP_DIR = 'cade-convert-tmp';     // OPFS folder for temp outputs
  var STALE_MS = 60 * 60 * 1000;        // other sessions' temp dirs older than this are swept
  var GRACE_MS = 60 * 1000;             // keep files/URLs this long after close (downloads in flight)
  var TEXT_INLINE_MAX = 2 * 1024 * 1024;  // text results kept as strings for Copy/Insert
  var MEMORY_OK = 48 * 1024 * 1024;     // inputs below this may convert into RAM when OPFS is missing

  // ---- third-party converters (pinned; fetched once into CACHE) ---------------
  // size = bytes stored (uncompressed), wire = what the CDN sends (brotli).
  var JSD = 'https://cdn.jsdelivr.net/npm/';
  var PDFJS = JSD + 'pdfjs-dist@5.4.624/';
  var ASSETS = {
    mediabunny: { url: JSD + 'mediabunny@1.61.3/dist/bundles/mediabunny.min.mjs', size: 691220, wire: 175214, label: 'fast engine' },
    mp3enc: { url: JSD + '@mediabunny/mp3-encoder@1.61.3/dist/bundles/mediabunny-mp3-encoder.min.mjs', size: 311561, wire: 128302, label: 'MP3 encoder' },
    aacenc: { url: JSD + '@mediabunny/aac-encoder@1.61.3/dist/bundles/mediabunny-aac-encoder.min.mjs', size: 992505, wire: 258794, label: 'AAC encoder' },
    flacenc: { url: JSD + '@mediabunny/flac-encoder@1.61.3/dist/bundles/mediabunny-flac-encoder.min.mjs', size: 323011, wire: 83565, label: 'FLAC encoder' },
    ffjs: { url: JSD + '@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js', size: 111804, wire: 30847, label: 'compatible engine' },
    ffwasm: { url: JSD + '@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm', size: 32232419, wire: 9289992, label: 'compatible engine' },
    libheif: { url: JSD + 'libheif-js@1.19.8/libheif-wasm/libheif-bundle.mjs', size: 1461926, wire: 473823, label: 'HEIC decoder' },
    mammoth: { url: JSD + 'mammoth@1.12.0/mammoth.browser.min.js', size: 635882, wire: 140755, label: 'Word reader', global: 'mammoth' },
    docx: { url: JSD + 'docx@9.6.1/dist/index.iife.js', size: 857630, wire: 168493, label: 'Word writer', global: 'docx' },
    marked: { url: JSD + 'marked@18.0.11/lib/marked.umd.js', size: 44679, wire: 14145, label: 'Markdown', global: 'marked' },
    turndown: { url: JSD + 'turndown@7.2.2/dist/turndown.js', size: 26787, wire: 7727, label: 'HTML to Markdown', global: 'TurndownService' },
    pdflib: { url: JSD + 'pdf-lib@1.17.1/dist/pdf-lib.min.js', size: 525099, wire: 184931, label: 'PDF writer', global: 'PDFLib' },
    pdfjs: { url: PDFJS + 'legacy/build/pdf.min.mjs', size: 481423, wire: 140346, label: 'PDF reader' },
    pdfjsw: { url: PDFJS + 'legacy/build/pdf.worker.min.mjs', size: 1128591, wire: 315147, label: 'PDF reader' },
    xlsx: { url: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js', size: 951904, wire: 294275, label: 'spreadsheet engine', global: 'XLSX' },
  };
  var WORKER_ASSETS = ['mediabunny', 'mp3enc', 'aacenc', 'flacenc', 'ffjs', 'ffwasm', 'libheif'];

  // ============================================================================
  // Pure helpers (exported on the widget as _test for node checks)
  // ============================================================================
  function fmtBytes(n) {
    if (!(n >= 0)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    return (n / 1073741824).toFixed(n < 10737418240 ? 2 : 1) + ' GB';
  }
  function fmtClock(s) {
    if (!(s >= 0) || !isFinite(s)) return '';
    s = Math.round(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var ss = (sec < 10 ? '0' : '') + sec;
    return h ? h + ':' + (m < 10 ? '0' : '') + m + ':' + ss : m + ':' + ss;
  }
  function fmtLeft(s) {
    if (s < 1) return 'almost done';
    if (s < 60) return Math.ceil(s) + ' s left';
    if (s < 3600) { var m = Math.floor(s / 60), r = Math.round(s % 60); return m + ' min' + (m < 10 && r ? ' ' + r + ' s' : '') + ' left'; }
    return Math.floor(s / 3600) + ' h ' + Math.round((s % 3600) / 60) + ' min left';
  }
  // "1:23.5" / "83.5" / "1:02:03" -> seconds; '' -> 0; junk -> NaN.
  function parseTime(v) {
    v = String(v == null ? '' : v).trim();
    if (!v) return 0;
    if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(v)) return NaN;
    var parts = v.split(':'), s = 0;
    for (var i = 0; i < parts.length; i++) s = s * 60 + parseFloat(parts[i]);
    return s;
  }
  function etaText(elapsedMs, p) {
    if (!(p > 0.02) || p >= 1 || elapsedMs < 1500) return '';
    return fmtLeft(elapsedMs * (1 - p) / p / 1000);
  }
  function extOf(name) {
    var m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }
  function baseOf(name) {
    var b = String(name || 'file').replace(/\.[a-z0-9]{1,8}$/i, '');
    return b.replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || 'file';
  }

  // ---- format sniffing (magic bytes first, extension only as a hint) ----------
  var FMT = {
    png: ['image', 'PNG image'], jpeg: ['image', 'JPEG image'], gif: ['image', 'GIF image'], webp: ['image', 'WebP image'],
    bmp: ['image', 'BMP image'], ico: ['image', 'ICO icon'], tiff: ['image', 'TIFF image'], svg: ['image', 'SVG image'],
    avif: ['image', 'AVIF image'], heic: ['image', 'HEIC photo'], jxl: ['image', 'JPEG XL image'], jp2: ['image', 'JPEG 2000 image'],
    psd: ['image', 'Photoshop image'],
    mp4: ['video', 'MP4 video'], mov: ['video', 'QuickTime video'], '3gp': ['video', '3GP video'], webm: ['video', 'WebM video'],
    mkv: ['video', 'Matroska video'], avi: ['video', 'AVI video'], flv: ['video', 'Flash video'], wmv: ['video', 'Windows Media video'],
    ts: ['video', 'MPEG-TS video'], mpg: ['video', 'MPEG video'], ogv: ['video', 'Ogg video'],
    m4a: ['audio', 'M4A audio'], mp3: ['audio', 'MP3 audio'], aac: ['audio', 'AAC audio'], wav: ['audio', 'WAV audio'],
    aiff: ['audio', 'AIFF audio'], flac: ['audio', 'FLAC audio'], ogg: ['audio', 'Ogg Vorbis audio'], opus: ['audio', 'Opus audio'],
    wma: ['audio', 'Windows Media audio'], amr: ['audio', 'AMR audio'], caf: ['audio', 'Core Audio file'], au: ['audio', 'AU audio'],
    pdf: ['pdf', 'PDF document'], docx: ['docx', 'Word document'],
    xlsx: ['sheet', 'Excel workbook'], xls: ['sheet', 'Excel 97\u20132003 workbook'], ods: ['sheet', 'OpenDocument spreadsheet'],
    csv: ['sheet', 'CSV table'], tsv: ['sheet', 'TSV table'], json: ['sheet', 'JSON data'],
    md: ['md', 'Markdown'], html: ['html', 'HTML page'], txt: ['text', 'Plain text'], xml: ['text', 'XML'],
    pptx: ['none', 'PowerPoint deck'], odt: ['none', 'OpenDocument text'], odp: ['none', 'OpenDocument slides'],
    doc: ['none', 'Word 97\u20132003 (.doc)'], ppt: ['none', 'PowerPoint 97\u20132003'], epub: ['none', 'EPUB book'],
    zip: ['none', 'ZIP archive'], rtf: ['none', 'Rich Text (RTF)'], midi: ['none', 'MIDI'], gz: ['none', 'gzip archive'],
    '7z': ['none', '7-Zip archive'], rar: ['none', 'RAR archive'], ole: ['none', 'Office 97\u20132003 file'], bin: ['none', 'Unknown file'],
  };
  // extension -> fmt (for hints and "named .jpg" mismatch notes)
  var EXT_FMT = {
    jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', jfif: 'jpeg', png: 'png', apng: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp', dib: 'bmp',
    ico: 'ico', cur: 'ico', tif: 'tiff', tiff: 'tiff', svg: 'svg', avif: 'avif', heic: 'heic', heif: 'heic', hif: 'heic',
    jxl: 'jxl', jp2: 'jp2', j2k: 'jp2', psd: 'psd',
    mp4: 'mp4', m4v: 'mp4', mov: 'mov', qt: 'mov', '3gp': '3gp', '3g2': '3gp', webm: 'webm', mkv: 'mkv', avi: 'avi', flv: 'flv',
    wmv: 'wmv', asf: 'wmv', ts: 'ts', mts: 'ts', m2ts: 'ts', mpg: 'mpg', mpeg: 'mpg', vob: 'mpg', ogv: 'ogv',
    m4a: 'm4a', m4b: 'm4a', mp3: 'mp3', aac: 'aac', wav: 'wav', aif: 'aiff', aiff: 'aiff', aifc: 'aiff', flac: 'flac',
    ogg: 'ogg', oga: 'ogg', opus: 'opus', wma: 'wma', amr: 'amr', caf: 'caf', au: 'au', snd: 'au',
    pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', xlsm: 'xlsx', xls: 'xls', ods: 'ods', csv: 'csv', tsv: 'tsv', tab: 'tsv', json: 'json',
    md: 'md', markdown: 'md', mdown: 'md', mkd: 'md', html: 'html', htm: 'html', xhtml: 'html', txt: 'txt', text: 'txt', log: 'txt',
    xml: 'xml', pptx: 'pptx', odt: 'odt', odp: 'odp', doc: 'doc', ppt: 'ppt', epub: 'epub', zip: 'zip', rtf: 'rtf', mid: 'midi', midi: 'midi',
  };
  function ascii(b, o, n) {
    var s = '';
    for (var i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]);
    return s;
  }
  function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
  function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u32be(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
  function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; }
  function startsWith(b, arr, off) {
    off = off || 0;
    if (b.length < off + arr.length) return false;
    for (var i = 0; i < arr.length; i++) if (b[off + i] !== arr[i]) return false;
    return true;
  }
  function findAscii(b, s, from, to) {
    to = Math.min(b.length - s.length, to == null ? b.length : to);
    outer: for (var i = from || 0; i <= to; i++) {
      for (var j = 0; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
      return i;
    }
    return -1;
  }
  // ISO-BMFF (MP4/MOV/HEIC/AVIF/3GP) by ftyp brands.
  function isoKind(b) {
    var type = ascii(b, 4, 4);
    if (type !== 'ftyp') {
      return /^(moov|mdat|wide|free|skip|pnot)$/.test(type) ? 'mov' : '';
    }
    var size = Math.min(u32be(b, 0), b.length, 256);
    var brands = [ascii(b, 8, 4)];
    for (var o = 16; o + 4 <= size; o += 4) brands.push(ascii(b, o, 4));
    var has = function (re) { return brands.some(function (x) { return re.test(x); }); };
    if (has(/^avi[fs]$/)) return 'avif';
    if (has(/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs)$/) || /^(mif1|msf1)$/.test(brands[0])) return 'heic';
    if (/^(M4A |M4B |M4P |F4A |F4B )$/.test(brands[0])) return 'm4a';
    if (brands[0] === 'qt  ') return 'mov';
    if (/^3g/.test(brands[0])) return '3gp';
    if (brands[0] === 'crx ') return 'bin';
    return 'mp4';
  }
  function isText(b) {
    if (!b.length) return true;
    if (startsWith(b, [0xEF, 0xBB, 0xBF]) || startsWith(b, [0xFF, 0xFE]) || startsWith(b, [0xFE, 0xFF])) return true;
    for (var i = 0; i < b.length; i++) if (b[i] === 0) return false;
    if (typeof TextDecoder === 'undefined') return true;
    // Trim a possibly cut multi-byte sequence at the end before strict decoding.
    for (var cut = 0; cut < 4; cut++) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, b.length - cut)); return true; } catch (e) {}
    }
    return false;
  }
  function textKind(b, ext) {
    var s = '';
    try { s = new TextDecoder('utf-8').decode(b.subarray(0, Math.min(b.length, 2048))); } catch (e) { s = ascii(b, 0, 2048); }
    s = s.replace(/^\ufeff/, '');
    var t = s.replace(/^\s+/, '');
    if (/^\{\\rtf/.test(t)) return 'rtf';
    if (/^<svg[\s>]/i.test(t) || (/^<\?xml/i.test(t) && /<svg[\s>]/i.test(s))) return 'svg';
    if (/^(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(t)) return 'html';
    var hint = EXT_FMT[ext];
    if (hint === 'html' || hint === 'md' || hint === 'csv' || hint === 'tsv' || hint === 'json' || hint === 'xml' || hint === 'svg') return hint;
    if (/^<\?xml/i.test(t)) return 'xml';
    if (/^[\[{]/.test(t) && !hint) return 'json';
    return 'txt';
  }
  // b: first bytes of the file (4 KB is plenty). -> {fmt, cat, label, ext, mismatch}
  function sniffBytes(b, name, mime) {
    var ext = extOf(name), fmt = '';
    if (startsWith(b, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) fmt = 'png';
    else if (startsWith(b, [0xFF, 0xD8, 0xFF])) fmt = 'jpeg';
    else if (ascii(b, 0, 4) === 'GIF8') fmt = 'gif';
    else if (ascii(b, 0, 4) === 'RIFF') {
      var rt = ascii(b, 8, 4);
      fmt = rt === 'WEBP' ? 'webp' : rt === 'WAVE' ? 'wav' : rt === 'AVI ' ? 'avi' : rt === 'RMID' ? 'midi' : '';
    } else if (ascii(b, 0, 4) === 'RF64') fmt = 'wav';
    else if (ascii(b, 0, 2) === 'BM' && b.length > 18 && [12, 40, 52, 56, 64, 108, 124].indexOf(u32le(b, 14)) !== -1) fmt = 'bmp';
    else if (startsWith(b, [0, 0, 1, 0]) && b.length > 6 && u16le(b, 4) > 0 && u16le(b, 4) < 256 && !ascii(b, 4, 8).match(/ftyp/)) fmt = 'ico';
    else if (startsWith(b, [0, 0, 2, 0]) && b.length > 6 && u16le(b, 4) > 0 && u16le(b, 4) < 256) fmt = 'ico';
    else if (ascii(b, 0, 4) === 'II*\u0000' || ascii(b, 0, 4) === 'MM\u0000*') fmt = 'tiff';
    else if (ascii(b, 0, 4) === '8BPS') fmt = 'psd';
    else if (startsWith(b, [0xFF, 0x0A]) || (startsWith(b, [0, 0, 0, 0x0C]) && ascii(b, 4, 4) === 'JXL ')) fmt = 'jxl';
    else if (startsWith(b, [0, 0, 0, 0x0C]) && ascii(b, 4, 4) === 'jP  ') fmt = 'jp2';
    else if (ascii(b, 4, 4) === 'ftyp' || /^(moov|mdat|wide|pnot)$/.test(ascii(b, 4, 4))) fmt = isoKind(b);
    else if (startsWith(b, [0x1A, 0x45, 0xDF, 0xA3])) fmt = findAscii(b, 'webm', 0, 80) !== -1 ? 'webm' : 'mkv';
    else if (ascii(b, 0, 4) === 'OggS') {
      fmt = findAscii(b, 'OpusHead', 0, 120) !== -1 ? 'opus' : findAscii(b, 'theora', 0, 120) !== -1 ? 'ogv' : 'ogg';
    } else if (ascii(b, 0, 4) === 'fLaC') fmt = 'flac';
    else if (ascii(b, 0, 4) === 'FORM' && /^AIF[FC]$/.test(ascii(b, 8, 4))) fmt = 'aiff';
    else if (ascii(b, 0, 4) === 'caff') fmt = 'caf';
    else if (ascii(b, 0, 5) === '#!AMR') fmt = 'amr';
    else if (ascii(b, 0, 4) === '.snd') fmt = 'au';
    else if (ascii(b, 0, 4) === 'MThd') fmt = 'midi';
    else if (ascii(b, 0, 3) === 'FLV') fmt = 'flv';
    else if (startsWith(b, [0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11])) fmt = ext === 'wma' ? 'wma' : 'wmv';
    else if (ascii(b, 0, 3) === 'ID3') fmt = 'mp3';
    else if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0 && b.length > 2) {
      var layer = (b[1] >> 1) & 3;
      fmt = layer === 0 ? ((b[1] & 0xF6) === 0xF0 ? 'aac' : '') : 'mp3';
    } else if (b[0] === 0x47 && b.length > 376 && b[188] === 0x47 && b[376] === 0x47) fmt = 'ts';
    else if (b.length > 196 && b[4] === 0x47 && b[196] === 0x47) fmt = 'ts';
    else if (startsWith(b, [0, 0, 1, 0xBA])) fmt = 'mpg';
    else if (findAscii(b, '%PDF-', 0, 1024) !== -1) fmt = 'pdf';
    else if (ascii(b, 0, 4) === 'PK\u0003\u0004' || ascii(b, 0, 4) === 'PK\u0005\u0006') fmt = 'zip';
    else if (startsWith(b, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])) fmt = ext === 'xls' ? 'xls' : ext === 'doc' ? 'doc' : ext === 'ppt' ? 'ppt' : 'ole';
    else if (startsWith(b, [0x1F, 0x8B])) fmt = 'gz';
    else if (ascii(b, 0, 6) === '7z\u00bc\u00af\u0027\u001c') fmt = '7z';
    else if (ascii(b, 0, 4) === 'Rar!') fmt = 'rar';
    else if (isText(b)) fmt = textKind(b, ext);
    else fmt = EXT_FMT[ext] && FMT[EXT_FMT[ext]] && FMT[EXT_FMT[ext]][0] !== 'image' ? EXT_FMT[ext] : 'bin';
    if (fmt === 'zip') fmt = zipKindFromHead(b) || 'zip';
    // MPEG-4 audio named .m4a/.aac etc. but branded generically.
    if (fmt === 'mp4' && (ext === 'm4a' || ext === 'm4b' || ext === 'aac')) fmt = 'm4a';
    var info = FMT[fmt] || FMT.bin;
    var hinted = EXT_FMT[ext];
    var mismatch = !!(ext && hinted && hinted !== fmt && FMT[fmt] && info[0] !== 'text' && fmt !== 'bin' &&
      !(hinted === 'mp4' && /^(m4a|mov|3gp)$/.test(fmt)) && !(hinted === 'mov' && fmt === 'mp4') &&
      !(hinted === 'xlsx' && fmt === 'zip') && !(hinted === 'ogg' && /^(opus|ogv)$/.test(fmt)) &&
      !(hinted === 'txt' && /^(md|csv|tsv|json|xml)$/.test(fmt)) && !(hinted === 'm4a' && fmt === 'mp4') &&
      !(hinted === 'heic' && fmt === 'avif') && !(hinted === 'tiff' && fmt === 'tiff'));
    return { fmt: fmt, cat: info[0], label: info[1], ext: ext, mismatch: mismatch };
  }
  // OpenDocument zips start with an uncompressed "mimetype" entry.
  function zipKindFromHead(b) {
    if (ascii(b, 30, 8) === 'mimetype') {
      var off = 30 + u16le(b, 26) + u16le(b, 28);
      var mt = ascii(b, off, 60);
      if (mt.indexOf('opendocument.spreadsheet') !== -1) return 'ods';
      if (mt.indexOf('opendocument.text') !== -1) return 'odt';
      if (mt.indexOf('opendocument.presentation') !== -1) return 'odp';
      if (mt.indexOf('application/epub') === 0) return 'epub';
    }
    return '';
  }
  // Names in a zip's central directory (tail = last <=64 KB of the file).
  function zipNames(tail) {
    var names = [];
    for (var i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4B && tail[i + 2] === 5 && tail[i + 3] === 6) {
        var cdSize = u32le(tail, i + 12), count = u16le(tail, i + 10);
        var p = i - cdSize;
        if (p < 0) return names; // directory larger than our tail window
        for (var n = 0; n < count && p + 46 <= i && names.length < 5000; n++) {
          if (u32le(tail, p) !== 0x02014b50) break;
          var nl = u16le(tail, p + 28), xl = u16le(tail, p + 30), cl = u16le(tail, p + 32);
          names.push(ascii(tail, p + 46, nl));
          p += 46 + nl + xl + cl;
        }
        return names;
      }
    }
    return names;
  }
  function zipKindFromNames(names) {
    var has = function (n) { return names.indexOf(n) !== -1; };
    if (has('word/document.xml')) return 'docx';
    if (has('xl/workbook.xml') || has('xl/workbook.bin')) return 'xlsx';
    if (has('ppt/presentation.xml')) return 'pptx';
    if (has('META-INF/container.xml') && has('mimetype')) return 'epub';
    return '';
  }

  // ---- cheap image dimensions from header bytes ---------------------------------
  function exifOrientation(b, start, end) {
    // APP1 "Exif\0\0" + TIFF header; returns 1..8
    if (ascii(b, start, 6) !== 'Exif\u0000\u0000') return 1;
    var t = start + 6, le = ascii(b, t, 2) === 'II';
    var r16 = function (o) { return le ? u16le(b, o) : u16be(b, o); };
    var r32 = function (o) { return le ? u32le(b, o) : u32be(b, o); };
    var ifd = t + r32(t + 4), n = r16(ifd);
    for (var i = 0; i < n; i++) {
      var e = ifd + 2 + i * 12;
      if (e + 12 > end) break;
      if (r16(e) === 0x0112) return r16(e + 8) || 1;
    }
    return 1;
  }
  function imageDims(b, fmt) {
    try {
      if (fmt === 'png' && ascii(b, 12, 4) === 'IHDR') return { w: u32be(b, 16), h: u32be(b, 20) };
      if (fmt === 'gif') return { w: u16le(b, 6), h: u16le(b, 8) };
      if (fmt === 'bmp') { var hs = u32le(b, 14); return hs === 12 ? { w: u16le(b, 18), h: u16le(b, 20) } : { w: Math.abs(u32le(b, 18) | 0), h: Math.abs(u32le(b, 22) | 0) }; }
      if (fmt === 'ico') return { w: b[6] || 256, h: b[7] || 256 };
      if (fmt === 'webp') {
        var ch = ascii(b, 12, 4);
        if (ch === 'VP8 ') return { w: u16le(b, 26) & 0x3FFF, h: u16le(b, 28) & 0x3FFF };
        if (ch === 'VP8L') return { w: 1 + (((b[22] & 0x3F) << 8) | b[21]), h: 1 + (((b[24] & 0x0F) << 10) | (b[23] << 2) | ((b[22] & 0xC0) >> 6)) };
        if (ch === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      }
      if (fmt === 'jpeg') {
        var i = 2, orient = 1;
        while (i + 9 < b.length) {
          if (b[i] !== 0xFF) return null;
          var mk = b[i + 1];
          if (mk === 0xFF) { i++; continue; }
          var len = u16be(b, i + 2);
          if (mk === 0xE1) orient = exifOrientation(b, i + 4, Math.min(b.length, i + 2 + len));
          if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) {
            var h = u16be(b, i + 5), w = u16be(b, i + 7);
            return orient >= 5 ? { w: h, h: w } : { w: w, h: h };
          }
          i += 2 + len;
        }
        return null;
      }
      if (fmt === 'heic' || fmt === 'avif') {
        // Largest 'ispe' (image spatial extent) is the main image; 'irot' 90/270 swaps.
        var best = null, p = 0;
        while ((p = findAscii(b, 'ispe', p + 1)) !== -1) {
          var ww = u32be(b, p + 8), hh = u32be(b, p + 12);
          if (ww && hh && (!best || ww * hh > best.w * best.h)) best = { w: ww, h: hh };
        }
        var r = findAscii(b, 'irot', 0);
        if (best && r !== -1 && (b[r + 4] & 1)) best = { w: best.h, h: best.w };
        return best;
      }
    } catch (e) {}
    return null;
  }

  // ---- targets, presets, defaults ---------------------------------------------------
  var T = {
    mp4: { label: 'MP4', ext: 'mp4', mime: 'video/mp4', kind: 'video' },
    webm: { label: 'WebM', ext: 'webm', mime: 'video/webm', kind: 'video' },
    mov: { label: 'MOV', ext: 'mov', mime: 'video/quicktime', kind: 'video' },
    mkv: { label: 'MKV', ext: 'mkv', mime: 'video/x-matroska', kind: 'video' },
    gif: { label: 'GIF (animated)', ext: 'gif', mime: 'image/gif', kind: 'gif' },
    m4a: { label: 'M4A (AAC)', ext: 'm4a', mime: 'audio/mp4', kind: 'audio' },
    mp3: { label: 'MP3', ext: 'mp3', mime: 'audio/mpeg', kind: 'audio' },
    wav: { label: 'WAV', ext: 'wav', mime: 'audio/wav', kind: 'audio' },
    flac: { label: 'FLAC', ext: 'flac', mime: 'audio/flac', kind: 'audio' },
    ogg: { label: 'OGG (Opus)', ext: 'ogg', mime: 'audio/ogg', kind: 'audio' },
    jpeg: { label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', kind: 'image' },
    png: { label: 'PNG', ext: 'png', mime: 'image/png', kind: 'image' },
    webp: { label: 'WebP', ext: 'webp', mime: 'image/webp', kind: 'image' },
    ico: { label: 'ICO (favicon)', ext: 'ico', mime: 'image/x-icon', kind: 'image' },
    pdf: { label: 'PDF', ext: 'pdf', mime: 'application/pdf', kind: 'doc' },
    pngpages: { label: 'PNG (each page)', ext: 'png', mime: 'image/png', kind: 'pages' },
    jpgpages: { label: 'JPEG (each page)', ext: 'jpg', mime: 'image/jpeg', kind: 'pages' },
    txt: { label: 'Plain text', ext: 'txt', mime: 'text/plain', kind: 'doc', text: true },
    md: { label: 'Markdown', ext: 'md', mime: 'text/markdown', kind: 'doc', text: true },
    html: { label: 'HTML', ext: 'html', mime: 'text/html', kind: 'doc', text: true },
    docx: { label: 'Word (DOCX)', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'doc' },
    xlsx: { label: 'Excel (XLSX)', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'doc' },
    ods: { label: 'OpenDocument (ODS)', ext: 'ods', mime: 'application/vnd.oasis.opendocument.spreadsheet', kind: 'doc' },
    csv: { label: 'CSV', ext: 'csv', mime: 'text/csv', kind: 'doc', text: true },
    tsv: { label: 'TSV', ext: 'tsv', mime: 'text/tab-separated-values', kind: 'doc', text: true },
    json: { label: 'JSON', ext: 'json', mime: 'application/json', kind: 'doc', text: true },
  };
  var TARGETS_BY_CAT = {
    video: ['mp4', 'webm', 'mov', 'mkv', 'gif', 'm4a', 'mp3', 'wav', 'flac', 'ogg'],
    audio: ['m4a', 'mp3', 'wav', 'flac', 'ogg'],
    image: ['jpeg', 'png', 'webp', 'pdf', 'ico'],
    pdf: ['txt', 'pngpages', 'jpgpages'],
    docx: ['md', 'html', 'txt'],
    sheet: ['xlsx', 'csv', 'tsv', 'json', 'md', 'html', 'ods'],
    md: ['docx', 'html', 'txt'],
    html: ['md', 'docx', 'txt'],
    text: ['docx', 'html'],
  };
  var PRESETS = {
    video: [['original', 'Original'], ['smaller', 'Smaller file'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']],
    gif: [['g320', '320 px \u00b7 10 fps'], ['g480', '480 px \u00b7 12 fps'], ['g720', '720 px \u00b7 15 fps']],
    audio: [['original', 'Best'], ['medium', 'Medium'], ['small', 'Small']],
    image: [['orig', 'Original size'], ['2048', 'Max 2048 px'], ['1280', 'Max 1280 px'], ['640', 'Max 640 px']],
    pages: [['1x', '72 dpi'], ['2x', '144 dpi'], ['3x', '216 dpi']],
  };
  function targetsFor(sn) {
    var list = (TARGETS_BY_CAT[sn.cat] || []).slice();
    if (sn.fmt === 'gif') list = list.concat(['mp4', 'webm']);
    if (sn.cat === 'sheet') list = list.filter(function (t) { return t !== sn.fmt; });
    return list;
  }
  function presetKind(target) {
    var k = T[target] ? T[target].kind : '';
    if (k === 'video' || k === 'gif' || k === 'audio' || k === 'pages') return k;
    if (target === 'jpeg' || target === 'png' || target === 'webp' || target === 'pdf') return 'image';
    return '';
  }
  function defaultTarget(sn, caps, remembered) {
    var list = targetsFor(sn);
    if (remembered && list.indexOf(remembered) !== -1) return remembered;
    var f = sn.fmt, d;
    if (sn.cat === 'image') {
      d = { heic: 'jpeg', avif: 'jpeg', png: 'jpeg', jpeg: caps && caps.webpEncode ? 'webp' : 'png', webp: 'jpeg', gif: 'mp4' }[f] || 'png';
    } else if (sn.cat === 'video') d = 'mp4';
    else if (sn.cat === 'audio') d = { wav: 'm4a', aiff: 'm4a', flac: 'm4a', caf: 'm4a', au: 'm4a', mp3: 'm4a' }[f] || 'mp3';
    else d = { pdf: 'txt', docx: 'md', xlsx: 'csv', xls: 'csv', ods: 'csv', csv: 'xlsx', tsv: 'xlsx', json: 'csv', md: 'docx', html: 'md', txt: 'docx', xml: 'docx' }[f];
    return list.indexOf(d) !== -1 ? d : list[0] || '';
  }
  function defaultPreset(sn, target) {
    var k = presetKind(target);
    if (k === 'video') return T[target] && (target === sn.fmt || (target === 'mp4' && sn.fmt === 'm4v')) ? 'smaller' : 'original';
    if (k === 'gif') return 'g480';
    if (k === 'audio') return 'original';
    if (k === 'image') return 'orig';
    if (k === 'pages') return '2x';
    return '';
  }
  // Mediabunny can read these containers and write these targets.
  var FAST_IN = { mp4: 1, mov: 1, m4a: 1, '3gp': 1, webm: 1, mkv: 1, ogg: 1, opus: 1, wav: 1, mp3: 1, aac: 1, flac: 1, ts: 1 };
  var FAST_OUT = { mp4: 1, webm: 1, mov: 1, mkv: 1, m4a: 1, mp3: 1, wav: 1, flac: 1, ogg: 1 };
  // -> {engine, label, assets}
  function planFor(it, caps) {
    var sn = it.sn, t = it.target, o = it.opts || {};
    var media = sn.cat === 'video' || sn.cat === 'audio';
    if (sn.cat === 'image') {
      if (t === 'mp4' || t === 'webm') return { engine: 'ffmpeg', label: 'Compatible \u00b7 ffmpeg', assets: ['ffjs', 'ffwasm'] };
      var a = [];
      if (t === 'pdf') a.push('pdflib');
      if (sn.fmt === 'heic' && !caps.heicNative) a.push('libheif');
      if (t === 'webp' && !caps.webpEncode) return { engine: 'image', label: 'Native + ffmpeg (WebP)', assets: a.concat(['ffjs', 'ffwasm']) };
      return { engine: 'image', label: sn.fmt === 'heic' ? (caps.heicNative ? 'Native' : 'HEIC decoder') : 'Native', assets: a };
    }
    if (media) {
      var forced = o.engine === 'ffmpeg' || !!(o.ffArgs && o.ffArgs.trim());
      var fastOk = !forced && o.engine !== 'never-fast' && t !== 'gif' && FAST_IN[sn.fmt] && FAST_OUT[t] &&
        (caps.webcodecs || o.preset === 'original') && caps.worker;
      if (fastOk) {
        var fa = ['mediabunny'];
        if (t === 'mp3') fa.push('mp3enc');
        if (t === 'flac') fa.push('flacenc');
        return { engine: 'fast', label: 'Fast \u00b7 WebCodecs', assets: fa };
      }
      return { engine: 'ffmpeg', label: 'Compatible \u00b7 ffmpeg', assets: ['ffjs', 'ffwasm'] };
    }
    if (sn.cat === 'pdf') return { engine: 'pdf', label: 'pdf.js', assets: ['pdfjs', 'pdfjsw'] };
    if (sn.cat === 'sheet') return { engine: 'sheet', label: 'SheetJS', assets: ['xlsx'] };
    if (sn.cat === 'docx') return { engine: 'doc', label: 'mammoth', assets: t === 'md' ? ['mammoth', 'turndown'] : ['mammoth'] };
    if (sn.cat === 'md') return { engine: 'doc', label: t === 'docx' ? 'marked + docx' : 'marked', assets: t === 'docx' ? ['marked', 'docx'] : ['marked'] };
    if (sn.cat === 'html') return { engine: 'doc', label: t === 'docx' ? 'turndown + docx' : t === 'md' ? 'turndown' : 'Native', assets: t === 'docx' ? ['turndown', 'marked', 'docx'] : t === 'md' ? ['turndown'] : [] };
    if (sn.cat === 'text') return { engine: 'doc', label: t === 'docx' ? 'docx' : 'Native', assets: t === 'docx' ? ['docx'] : [] };
    return { engine: '', label: '', assets: [] };
  }

  // ---- ffmpeg argument building -------------------------------------------------
  var VIDEO_T = { mp4: 1, webm: 1, mov: 1, mkv: 1 };
  var AUDIO_T = { m4a: 1, mp3: 1, wav: 1, flac: 1, ogg: 1 };
  // Cap the SHORT side (portrait phone video stays portrait), never upscale, even dims.
  function capScale(cap) {
    return "scale=w='if(gte(iw,ih),-2,trunc(min(" + cap + ",iw)/2)*2)':h='if(gte(iw,ih),trunc(min(" + cap + ",ih)/2)*2,-2)'";
  }
  function gifScale(cap) {
    return "scale=w='if(gte(iw,ih),min(" + cap + ",iw),-1)':h='if(gte(iw,ih),-1,min(" + cap + ",ih))':flags=lanczos";
  }
  // Options only (no input / trim / output) — what "Custom ffmpeg options" shows.
  function ffOptions(o) {
    var a = [], t = o.target, p = o.preset;
    if (t === 'gif') {
      var g = { g320: [320, 10], g480: [480, 12], g720: [720, 15] }[p] || [480, 12];
      a.push('-vf', 'fps=' + g[1] + ',' + gifScale(g[0]) + ',split[s0][s1];[s0]palettegen=stats_mode=diff[pal];[s1][pal]paletteuse=dither=bayer:bayer_scale=5', '-loop', '0', '-an');
    } else if (VIDEO_T[t]) {
      var cap = { '1080': 1080, '720': 720, '480': 480, smaller: 1080 }[p];
      // VP8, not VP9: libvpx-vp9 crashes ("memory access out of bounds") in
      // the single-threaded @ffmpeg/core 0.12.10 build. (The fast path uses
      // the browser's own VP9 encoder.) VP8 needs -b:v as the cap for -crf.
      if (t === 'webm') a.push('-c:v', 'libvpx', '-crf', { original: '8', '1080': '12', '720': '14', '480': '18', smaller: '28' }[p] || '14',
        '-b:v', { original: '8M', '1080': '4M', '720': '2500k', '480': '1200k', smaller: '1M' }[p] || '2500k', '-deadline', 'realtime', '-cpu-used', '8');
      else a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', p === 'smaller' ? '28' : p === 'original' ? '20' : '23', '-pix_fmt', 'yuv420p');
      a.push('-vf', cap ? capScale(cap) : 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
      if (o.noAudio) a.push('-an');
      else {
        if (t === 'webm') a.push('-c:a', 'libopus', '-b:a', p === 'smaller' ? '96k' : '128k');
        else a.push('-c:a', 'aac', '-b:a', p === 'smaller' ? '96k' : '160k');
        if (o.mono) a.push('-ac', '1');
      }
      if ((t === 'mp4' || t === 'mov') && !o.big) a.push('-movflags', '+faststart');
    } else if (AUDIO_T[t]) {
      var kb = { original: 192, medium: 128, small: 64 }[p] || 192;
      if (o.mono) kb = Math.round(kb * 0.6);
      a.push('-vn');
      if (t === 'm4a') a.push('-c:a', 'aac', '-b:a', kb + 'k');
      else if (t === 'mp3') a.push('-c:a', 'libmp3lame', '-q:a', { original: '2', medium: '4', small: '7' }[p] || '2');
      else if (t === 'wav') a.push('-c:a', 'pcm_s16le');
      else if (t === 'flac') a.push('-c:a', 'flac');
      else if (t === 'ogg') a.push('-c:a', 'libopus', '-b:a', kb + 'k');
      if (o.mono) a.push('-ac', '1');
    } else if (t === 'webp') {
      a.push('-c:v', 'libwebp', '-quality', String(Math.round((o.quality || 0.86) * 100)), '-compression_level', '4');
    } else if (t === 'png') {
      a.push('-frames:v', '1');
    }
    return a;
  }
  // Full argv with {in}/{out} placeholders (the worker substitutes paths).
  function buildFfArgs(o) {
    var a = [];
    if (o.trimStart > 0) a.push('-ss', String(o.trimStart));
    a.push('-i', '{in}');
    if (o.trimEnd > 0) a.push('-t', String(Math.max(0.05, o.trimEnd - (o.trimStart || 0))));
    var opts = o.custom != null ? o.custom : ffOptions(o);
    return a.concat(opts, ['{out}']);
  }
  // Shell-like split (quotes + backslash escapes) for the custom options field.
  function splitArgs(s) {
    var out = [], cur = '', q = '', has = false;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (q) {
        if (c === q) { q = ''; continue; }
        if (c === '\\' && q === '"' && i + 1 < s.length && /["\\]/.test(s.charAt(i + 1))) { cur += s.charAt(++i); continue; }
        cur += c;
      } else if (c === '"' || c === '\'') { q = c; has = true; }
      else if (c === '\\' && i + 1 < s.length) { cur += s.charAt(++i); has = true; }
      else if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; }
      else { cur += c; has = true; }
    }
    if (cur || has) out.push(cur);
    return out;
  }
  function joinArgs(a) {
    return a.map(function (x) {
      return x === '' || /[\s"'\\]/.test(x) ? '"' + x.replace(/(["\\])/g, '\\$1') + '"' : x;
    }).join(' ');
  }

  // ---- ICO writer (PNG-compressed entries; Windows Vista+ / every browser) --------
  function buildIco(entries) {
    var n = entries.length, off = 6 + 16 * n, total = off;
    entries.forEach(function (e) { total += e.bytes.length; });
    var out = new Uint8Array(total), dv = new DataView(out.buffer);
    dv.setUint16(0, 0, true); dv.setUint16(2, 1, true); dv.setUint16(4, n, true);
    entries.forEach(function (e, i) {
      var p = 6 + i * 16;
      out[p] = e.size >= 256 ? 0 : e.size;
      out[p + 1] = e.size >= 256 ? 0 : e.size;
      dv.setUint16(p + 4, 1, true); dv.setUint16(p + 6, 32, true);
      dv.setUint32(p + 8, e.bytes.length, true); dv.setUint32(p + 12, off, true);
      out.set(e.bytes, off);
      off += e.bytes.length;
    });
    return out;
  }
  function outName(base, target, suffix) {
    return base + (suffix ? ' (' + suffix + ')' : '') + '.' + T[target].ext;
  }

  // ============================================================================
  // Environment
  // ============================================================================
  var S = {
    items: [], seq: 0, jobSeq: 0, running: null, session: '', caps: null, prefs: null,
    workers: {}, pending: {}, cached: {}, free: null, idleTimer: 0, libs: {}, libP: {}, docsP: null,
    urls: [],
  };
  function detectCaps() {
    var ua = navigator.userAgent || '';
    var ios = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    var safari = ios || (/AppleWebKit/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(ua));
    var webp = false;
    try { var c = document.createElement('canvas'); c.width = c.height = 1; webp = c.toDataURL('image/webp').indexOf('data:image/webp') === 0; } catch (e) {}
    return {
      ios: ios, safari: safari,
      webcodecs: typeof window.VideoEncoder === 'function' && typeof window.VideoDecoder === 'function',
      worker: typeof window.Worker === 'function' && typeof window.WebAssembly === 'object',
      opfs: !!(navigator.storage && navigator.storage.getDirectory),
      savePicker: typeof window.showSaveFilePicker === 'function',
      dirPicker: typeof window.showDirectoryPicker === 'function',
      share: !!(navigator.share && navigator.canShare),
      caches: !!window.caches,
      webpEncode: webp,
      // Safari 17+ decodes HEIC natively (it's what iPhone photos are).
      heicNative: safari,
      // WebKit refuses canvases above ~16.7 MP (and iOS caps total canvas memory).
      maxArea: safari ? 16777216 : 120000000,
      coarse: !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches),
    };
  }
  function loadPrefs() {
    var p = {};
    try { p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {}; } catch (e) { p = {}; }
    S.prefs = {
      saveToDisk: p.saveToDisk !== false,
      autoFallback: p.autoFallback !== false,
      targets: p.targets && typeof p.targets === 'object' ? p.targets : {},
      quality: p.quality > 0.3 && p.quality <= 1 ? p.quality : 0.86,
    };
  }
  function savePrefs() {
    var t = S.prefs.targets, keys = Object.keys(t);
    if (keys.length > 40) keys.slice(0, keys.length - 40).forEach(function (k) { delete t[k]; });
    try { Cade.store.set(PREFS_KEY, JSON.stringify(S.prefs)); } catch (e) {}
  }
  function toast(m, type, ms) { Cade.showToast(m, type || 'info', ms || 2400); }
  function noop() {}
  function panel() { return document.getElementById(PANEL_ID); }
  function itemById(id) { for (var i = 0; i < S.items.length; i++) if (S.items[i].id === id) return S.items[i]; return null; }
  function codedError(message, code) { var e = new Error(message || 'failed'); e.code = code || 'failed'; return e; }

  // ============================================================================
  // Converter assets on the page (document libraries); the worker has its own
  // loader for the media/HEIC ones, sharing the same Cache Storage bucket.
  // ============================================================================
  function refreshCached() {
    S.cached = {};
    if (!window.caches) return Promise.resolve();
    return window.caches.has(CACHE).then(function (has) {
      if (!has) return [];
      return window.caches.open(CACHE).then(function (c) { return c.keys(); });
    }).then(function (reqs) {
      (reqs || []).forEach(function (r) { S.cached[r.url] = true; });
      renderFoot();
    }, noop);
  }
  function cachedBytes() {
    var n = 0;
    Object.keys(ASSETS).forEach(function (k) { if (S.cached[ASSETS[k].url]) n += ASSETS[k].size; });
    return n;
  }
  function missingWire(keys) {
    var n = 0;
    (keys || []).forEach(function (k) { if (ASSETS[k] && !S.cached[ASSETS[k].url]) n += ASSETS[k].wire; });
    return n;
  }
  // Bytes of an asset: our cache, else a streamed download (progress -> onDl).
  function assetBytes(key, onDl) {
    var a = ASSETS[key];
    var fromNet = function () {
      if (navigator.onLine === false) throw codedError('Offline \u2014 the ' + a.label + ' needs one online download first', 'offline');
      return fetch(a.url, { mode: 'cors', credentials: 'omit', cache: 'no-store' }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching the ' + a.label);
        if (!res.body || !res.body.getReader) return res.arrayBuffer();
        var reader = res.body.getReader(), parts = [], got = 0, last = 0;
        var pump = function () {
          return reader.read().then(function (r) {
            if (r.done) return;
            parts.push(r.value); got += r.value.length;
            var now = Date.now();
            if (onDl && now - last > 150) { last = now; onDl(got, Math.max(a.size, got), a.label); }
            return pump();
          });
        };
        return pump().then(function () {
          var u8 = new Uint8Array(got), o = 0;
          parts.forEach(function (p) { u8.set(p, o); o += p.length; });
          return u8.buffer;
        });
      }).then(function (buf) {
        if (onDl) onDl(buf.byteLength, buf.byteLength, a.label);
        if (window.caches) {
          window.caches.open(CACHE).then(function (c) {
            return c.put(a.url, new Response(buf.slice(0), { headers: { 'Content-Type': 'text/javascript', 'X-Cade-Size': String(buf.byteLength) } }));
          }).then(function () { S.cached[a.url] = true; renderFoot(); }, noop);
        }
        return buf;
      });
    };
    if (!window.caches) return fromNet();
    return window.caches.open(CACHE).then(function (c) { return c.match(a.url); }).then(function (hit) {
      return hit ? hit.arrayBuffer() : fromNet();
    }, fromNet);
  }
  // Classic UMD/IIFE library -> window global, via a blob: <script>.
  function loadGlobal(key, onDl) {
    var g = ASSETS[key].global;
    if (window[g]) return Promise.resolve(window[g]);
    if (S.libP[key]) return S.libP[key];
    S.libP[key] = assetBytes(key, onDl).then(function (buf) {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(new Blob([buf], { type: 'text/javascript' }));
        var s = document.createElement('script');
        s.src = url;
        s.onload = function () { URL.revokeObjectURL(url); s.remove(); window[g] ? resolve(window[g]) : reject(new Error(ASSETS[key].label + ' failed to load')); };
        s.onerror = function () { URL.revokeObjectURL(url); s.remove(); reject(new Error(ASSETS[key].label + ' failed to load')); };
        document.head.appendChild(s);
      });
    });
    S.libP[key].catch(function () { delete S.libP[key]; });
    return S.libP[key];
  }
  function loadPdfjs(onDl) {
    if (S.libs.pdfjs) return Promise.resolve(S.libs.pdfjs);
    if (S.libP.pdfjs) return S.libP.pdfjs;
    S.libP.pdfjs = Promise.all([assetBytes('pdfjs', onDl), assetBytes('pdfjsw', onDl)]).then(function (bufs) {
      var lib = URL.createObjectURL(new Blob([bufs[0]], { type: 'text/javascript' }));
      // The worker URL must outlive this call (pdf.js spawns a worker per
      // document); it is ~1 MB and kept with the loaded library.
      var wrk = URL.createObjectURL(new Blob([bufs[1]], { type: 'text/javascript' }));
      return import(lib).then(function (ns) {
        URL.revokeObjectURL(lib);
        if (!ns || !ns.getDocument) throw new Error('PDF reader failed to load');
        // A blob: URL is same-origin, so pdf.js runs it as its module worker
        // (and falls back to an in-page "fake worker" importing it if not).
        ns.GlobalWorkerOptions.workerSrc = wrk;
        S.libs.pdfjs = ns;
        return ns;
      });
    });
    S.libP.pdfjs.catch(function () { delete S.libP.pdfjs; });
    return S.libP.pdfjs;
  }
  function loadDocs() {
    if (window.__cadeConvertDocs) return Promise.resolve(window.__cadeConvertDocs);
    if (S.docsP) return S.docsP;
    S.docsP = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = DOCS_URL;
      s.onload = function () { window.__cadeConvertDocs ? resolve(window.__cadeConvertDocs) : reject(new Error('converter failed to load')); };
      s.onerror = function () { S.docsP = null; reject(new Error('converter failed to load' + (navigator.onLine === false ? ' (offline)' : ''))); };
      document.head.appendChild(s);
    });
    return S.docsP;
  }

  // ============================================================================
  // OPFS temp files
  // ============================================================================
  // A fresh folder per run, so deleting a previous run's files (async) can
  // never race with the new run writing its output.
  function tmpPath(it) {
    if (!it.outPath) it.outPath = [TMP_DIR, S.session, 'j' + it.id + '-' + (it.run || 0)];
    return it.outPath;
  }
  function opfsTmpDir() {
    return navigator.storage.getDirectory().then(function (root) { return root.getDirectoryHandle(TMP_DIR, { create: true }); });
  }
  function dirNames(dir) {
    var names = [];
    if (!dir || typeof dir.keys !== 'function') return Promise.resolve(names);
    var iter = dir.keys();
    var step = function () {
      return iter.next().then(function (r) { if (r.done) return names; names.push(r.value); return step(); });
    };
    return step();
  }
  // Remove temp dirs of sessions that died (closed tab / crash) — never ours,
  // never a recent one (another tab may still be converting).
  function sweepTmp() {
    if (!S.caps.opfs) return;
    opfsTmpDir().then(function (dir) {
      return dirNames(dir).then(function (names) {
        var now = Date.now();
        return Promise.all(names.map(function (n) {
          var ts = parseInt(String(n).slice(1).split('-')[0], 36);
          if (n === S.session || (ts > 0 && now - ts < STALE_MS)) return null;
          return dir.removeEntry(n, { recursive: true }).catch(noop);
        }));
      });
    }).then(function () { refreshSpace(); }, noop);
  }
  function removeTmp(path) {
    if (!S.caps || !S.caps.opfs) return;
    navigator.storage.getDirectory().then(function (d) {
      var i = 0;
      var walk = function (dir) {
        if (i === path.length - 1) return dir.removeEntry(path[i], { recursive: true });
        return dir.getDirectoryHandle(path[i++]).then(walk);
      };
      return walk(d);
    }).catch(noop);
  }
  function refreshSpace() {
    if (!navigator.storage || !navigator.storage.estimate) { S.free = null; return Promise.resolve(); }
    return navigator.storage.estimate().then(function (e) {
      S.free = e && e.quota ? Math.max(0, e.quota - (e.usage || 0)) : null;
      renderFoot();
    }, noop);
  }

  // ============================================================================
  // Workers
  // ============================================================================
  function getWorker(role) {
    var w = S.workers[role];
    if (w) return w;
    w = new Worker(WORKER_URL, { type: 'module' });
    w.onmessage = function (e) { onWorkerMsg(e.data || {}); };
    w.onerror = function (e) {
      try { e.preventDefault(); } catch (x) {}
      failRole(role, (e && e.message) || 'the converter worker failed to start', 'failed');
    };
    S.workers[role] = w;
    return w;
  }
  function killRole(role) {
    var w = S.workers[role];
    if (w) { try { w.terminate(); } catch (e) {} }
    delete S.workers[role];
  }
  function failRole(role, msg, code) {
    killRole(role);
    Object.keys(S.pending).forEach(function (id) {
      var p = S.pending[id];
      if (p.role === role) { delete S.pending[id]; p.reject(codedError(msg, code)); }
    });
  }
  function assetTable() {
    var o = {};
    WORKER_ASSETS.forEach(function (k) { o[k] = { url: ASSETS[k].url, size: ASSETS[k].size, label: ASSETS[k].label }; });
    return o;
  }
  function workerJob(role, msg, it, transfer) {
    return new Promise(function (resolve, reject) {
      var id = ++S.jobSeq;
      S.pending[id] = { role: role, it: it, resolve: resolve, reject: reject };
      msg.id = id;
      msg.assets = assetTable();
      if (it) it.job = { role: role, id: id };
      try { getWorker(role).postMessage(msg, transfer || []); } catch (e) { delete S.pending[id]; reject(e); }
    });
  }
  function onWorkerMsg(m) {
    var p = S.pending[m.id];
    if (!p) return;
    var it = p.it;
    if (m.type === 'dl') { if (it) setDl(it, m.loaded, m.total, m.label); }
    else if (m.type === 'stage') { if (it) setStage(it, m.text); }
    else if (m.type === 'progress') { if (it) setProgress(it, m.p, m.t); }
    else if (m.type === 'done') { delete S.pending[m.id]; p.resolve(m); }
    else if (m.type === 'error') { delete S.pending[m.id]; p.reject(codedError(m.message, m.code)); }
  }
  // Workers hold ffmpeg's ~100+ MB heap and decoders; drop them when idle.
  function scheduleIdle() {
    clearTimeout(S.idleTimer);
    S.idleTimer = setTimeout(function () {
      if (S.running || Object.keys(S.pending).length) return;
      killRole('main'); killRole('ff');
    }, 20000);
  }

  // ============================================================================
  // Items
  // ============================================================================
  function newItem(file) {
    var it = {
      id: ++S.seq, file: file, name: file.name || 'file', size: file.size || 0,
      sn: null, meta: {}, target: '', preset: '',
      opts: { quality: S.prefs.quality, trimStart: '', trimEnd: '', mono: false, ffArgs: '', engine: 'auto', open: false },
      state: 'sniff', p: 0, stage: '', t0: 0, dl: null, note: '', error: '', errCode: '', outputs: [], touched: false,
    };
    return it;
  }
  function addFiles(list) {
    var files = Array.prototype.slice.call(list || []).filter(function (f) { return f && typeof f.size === 'number'; });
    if (!files.length) return;
    files.forEach(function (f) {
      var it = newItem(f);
      S.items.push(it);
      renderList();
      sniffItem(it);
    });
  }
  function sniffItem(it) {
    var f = it.file;
    f.slice(0, 4096).arrayBuffer().then(function (buf) {
      var head = new Uint8Array(buf);
      var sn = sniffBytes(head, f.name, f.type);
      var more = Promise.resolve(sn);
      if (sn.fmt === 'zip' || sn.fmt === 'xlsx') {
        var start = Math.max(0, f.size - 66000);
        more = f.slice(start).arrayBuffer().then(function (tb) {
          var k = zipKindFromNames(zipNames(new Uint8Array(tb)));
          if (k) { sn.fmt = k; sn.cat = FMT[k][0]; sn.label = FMT[k][1]; sn.mismatch = false; }
          return sn;
        }, function () { return sn; });
      }
      return more.then(function (sn2) {
        var dimsP = Promise.resolve(null);
        if (sn2.cat === 'image') {
          dimsP = (sn2.fmt === 'jpeg' || sn2.fmt === 'heic' || sn2.fmt === 'avif'
            ? f.slice(0, 262144).arrayBuffer().then(function (b) { return imageDims(new Uint8Array(b), sn2.fmt); })
            : Promise.resolve(imageDims(head, sn2.fmt)));
        }
        return dimsP.then(function (d) {
          if (d && d.w > 0 && d.h > 0) { it.meta.w = d.w; it.meta.h = d.h; }
          applySniff(it, sn2);
        });
      });
    }).catch(function (e) {
      applySniff(it, { fmt: 'bin', cat: 'none', label: 'Unreadable file (' + ((e && e.message) || 'error') + ')', ext: extOf(f.name), mismatch: false });
    });
  }
  function applySniff(it, sn) {
    if (!itemById(it.id)) return;
    it.sn = sn;
    it.state = sn.cat === 'none' ? 'unsupported' : 'ready';
    pickDefaults(it);
    renderCard(it);
    renderFoot();
    if (sn.cat === 'video' || sn.cat === 'audio') probeMedia(it);
  }
  function pickDefaults(it) {
    it.target = defaultTarget(it.sn, S.caps, S.prefs.targets[it.sn.fmt]);
    it.preset = defaultPreset(it.sn, it.target);
  }
  // Duration / size from a media element: free, no library. Formats the
  // browser can't play just stay unknown (the converters work regardless).
  function probeMedia(it) {
    var el = document.createElement(it.sn.cat === 'audio' ? 'audio' : 'video');
    var url = URL.createObjectURL(it.file), done = false;
    var fin = function (ok) {
      if (done) return;
      done = true;
      clearTimeout(tm);
      if (ok) {
        if (isFinite(el.duration) && el.duration > 0) it.meta.dur = el.duration;
        if (el.videoWidth) { it.meta.w = el.videoWidth; it.meta.h = el.videoHeight; }
        // A "video" container with no picture is audio (e.g. WebM/MP4 voice memos).
        if (it.sn.cat === 'video' && ok && !el.videoWidth && it.meta.dur && el.tagName === 'VIDEO') {
          it.sn.cat = 'audio';
          it.sn.label = it.sn.label.replace(/video$/, 'audio');
          if (!it.touched) pickDefaults(it);
        }
      }
      try { el.removeAttribute('src'); el.load(); } catch (e) {}
      URL.revokeObjectURL(url);
      if (itemById(it.id) && it.state !== 'running') renderCard(it);
    };
    var tm = setTimeout(function () { fin(false); }, 6000);
    el.preload = 'metadata';
    el.muted = true;
    el.setAttribute('playsinline', '');
    el.onloadedmetadata = function () { fin(true); };
    el.onerror = function () { fin(false); };
    el.src = url;
  }

  // ============================================================================
  // Queue
  // ============================================================================
  function isMediaJob(it) {
    if (!it.sn) return false;
    var pl = planFor(it, S.caps);
    return (it.sn.cat === 'video' || it.sn.cat === 'audio' || pl.engine === 'ffmpeg') && pl.engine !== '';
  }
  function trimVals(it) {
    var a = parseTime(it.opts.trimStart), b = parseTime(it.opts.trimEnd);
    return { start: a, end: b };
  }
  function validate(it) {
    if (!it.sn || it.sn.cat === 'none' || !it.target) return 'This file type isn\u2019t supported';
    var tv = trimVals(it);
    if (isNaN(tv.start) || isNaN(tv.end)) return 'Trim times look wrong \u2014 use seconds or m:ss';
    if (tv.end && tv.end <= tv.start) return 'Trim end must be after the start';
    if (it.meta.dur && tv.start >= it.meta.dur) return 'Trim start is past the end of the file';
    return '';
  }
  // Called straight from a click: the save pickers need the user gesture.
  function startItems(list) {
    list = list.filter(function (it) {
      if (it.state === 'queued' || it.state === 'running' || it.state === 'sniff' || it.state === 'unsupported') return false;
      var bad = validate(it);
      if (bad) { it.state = 'error'; it.error = bad; renderCard(it); return false; }
      return true;
    });
    if (!list.length) return;
    var media = list.filter(function (it) { return isMediaJob(it) && !it.combine; });
    var pick = Promise.resolve();
    if (media.length && S.caps.savePicker && S.prefs.saveToDisk) {
      if (media.length === 1 || !S.caps.dirPicker) {
        var it0 = media[0], t0 = T[it0.target];
        var acc = {}; acc[t0.mime] = ['.' + t0.ext];
        pick = window.showSaveFilePicker({ suggestedName: outName(baseOf(it0.name), it0.target, sameSuffix(it0)), types: [{ description: t0.label, accept: acc }] })
          .then(function (h) { it0.dest = { kind: 'handle', handle: h }; });
      } else {
        pick = window.showDirectoryPicker({ id: 'cade-convert', mode: 'readwrite' })
          .then(function (d) { media.forEach(function (it) { it.dest = { kind: 'dir', dir: d }; }); });
      }
      pick = pick.catch(function (e) {
        if (e && e.name === 'AbortError') {
          media.forEach(function (it) { list.splice(list.indexOf(it), 1); });
          toast('Not saved \u2014 cancelled', 'info', 1600);
          return;
        }
        // Picker blocked (iframe / policy): fall back to temp storage + download.
        media.forEach(function (it) { it.dest = null; });
      });
    }
    pick.then(function () {
      list.forEach(function (it) {
        releaseOutputs(it);
        it.state = 'queued'; it.error = ''; it.errCode = ''; it.note = ''; it.p = 0; it.stage = ''; it.dl = null;
        it.cancelled = false;
        it.run = (it.run || 0) + 1;
        it.outPath = null;
        renderCard(it);
      });
      renderFoot();
      pump();
    });
  }
  function pump() {
    if (S.running) return;
    var next = null;
    for (var i = 0; i < S.items.length; i++) if (S.items[i].state === 'queued') { next = S.items[i]; break; }
    if (!next) { renderFoot(); scheduleIdle(); return; }
    clearTimeout(S.idleTimer);
    S.running = next;
    next.state = 'running';
    next.t0 = Date.now();
    next.p = 0;
    renderCard(next);
    renderFoot();
    var fin = function () {
      S.running = null;
      refreshSpace();
      refreshCached();
      pump();
    };
    runItem(next).then(function (outputs) {
      if (next.cancelled) return;
      next.outputs = outputs || [];
      next.state = 'done';
      next.p = 1;
      if (itemById(next.id)) renderCard(next);
      Cade.haptic && Cade.haptic(12);
    }, function (e) {
      if (next.cancelled || (e && e.code === 'canceled')) { next.state = 'canceled'; next.error = ''; }
      else { next.state = 'error'; next.error = (e && e.message) || String(e); next.errCode = (e && e.code) || ''; }
      next.outputs = [];
      if (next.dest && next.dest.kind === 'handle' && !next.retainDest) next.dest = null;
      if (itemById(next.id)) renderCard(next);
    }).then(fin, fin);
  }
  function cancelItem(it) {
    if (it.state === 'queued') { it.state = 'canceled'; renderCard(it); renderFoot(); return; }
    if (it.state !== 'running') return;
    it.cancelled = true;
    if (it.job) {
      if (it.job.role === 'ff') failRole('ff', 'Cancelled', 'canceled');
      else if (S.workers[it.job.role]) S.workers[it.job.role].postMessage({ type: 'cancel', id: it.job.id });
    }
    if (it.abort) { try { it.abort(); } catch (e) {} }
    it.state = 'canceled';
    renderCard(it);
  }

  function sameSuffix(it) {
    var t = it.target, k = presetKind(t);
    var same = EXT_FMT[T[t].ext] === it.sn.fmt || (t === 'jpeg' && it.sn.fmt === 'jpeg');
    if (!same) return '';
    if (k === 'video' || k === 'audio') return { original: 'converted', smaller: 'smaller', medium: 'medium', small: 'small' }[it.preset] || (it.preset + 'p');
    if (k === 'image') return it.preset === 'orig' ? 'converted' : it.preset + 'px';
    return 'converted';
  }
  // Where a worker should put the output.
  function destFor(it, name) {
    var d = it.dest;
    if (d && d.kind === 'handle') return Promise.resolve({ kind: 'handle', handle: d.handle, name: name });
    if (d && d.kind === 'dir') {
      return uniqueIn(d.dir, name).then(function (n) {
        return d.dir.getFileHandle(n, { create: true }).then(function (h) {
          // The empty file exists now; remove it again if the job fails.
          return { kind: 'handle', handle: h, name: n, drop: function () { return d.dir.removeEntry(n).catch(noop); } };
        });
      });
    }
    if (S.caps.opfs) return Promise.resolve({ kind: 'opfs', dir: tmpPath(it), name: name });
    return Promise.resolve({ kind: 'memory', name: name });
  }
  function uniqueIn(dir, name) {
    var base = name.replace(/(\.[^.]+)$/, ''), ext = (/(\.[^.]+)$/.exec(name) || ['', ''])[1], n = 1;
    var tryName = function (cand) {
      return dir.getFileHandle(cand).then(function () { n++; return tryName(base + ' (' + n + ')' + ext); }, function () { return cand; });
    };
    return tryName(name);
  }
  function checkSpace(it, estimate) {
    if (S.free == null || !estimate || (it.dest && it.dest.kind !== 'opfs')) return true;
    if (estimate < S.free * 0.9) return true;
    return window.confirm('This may need about ' + fmtBytes(estimate) + ' of temporary space, but only ~' + fmtBytes(S.free) +
      ' looks free on this device. Try anyway?');
  }

  // ============================================================================
  // Runners
  // ============================================================================
  function runItem(it) {
    if (it.combine) return runCombine(it);
    var pl = planFor(it, S.caps);
    it.engine = pl.engine;
    if (pl.engine === 'fast') return runFast(it);
    if (pl.engine === 'ffmpeg' && it.sn.cat !== 'image') return runFfMedia(it, '');
    if (pl.engine === 'ffmpeg' || pl.engine === 'image') return runImage(it);
    if (pl.engine === 'pdf') return runPdf(it);
    if (pl.engine === 'sheet') return runSheet(it);
    if (pl.engine === 'doc') return runDoc(it);
    return Promise.reject(codedError('This file type isn\u2019t supported'));
  }
  function mediaOpts(it) {
    var tv = trimVals(it);
    return { target: it.target, preset: it.preset, mono: !!it.opts.mono, trimStart: tv.start || 0, trimEnd: tv.end || 0 };
  }
  function expectDur(it) {
    var tv = trimVals(it), d = it.meta.dur || 0;
    var end = tv.end > 0 ? (d ? Math.min(tv.end, d) : tv.end) : d;
    return end > 0 ? Math.max(0, end - (tv.start || 0)) : 0;
  }
  function runFast(it) {
    var name = outName(baseOf(it.name), it.target, sameSuffix(it));
    if (!checkSpace(it, it.size * (it.preset === 'original' ? 1.05 : 0.8))) return Promise.reject(codedError('Not enough space', 'quota'));
    var dest = null;
    return destFor(it, name).then(function (out) {
      dest = out;
      if (out.kind === 'memory' && it.size > MEMORY_OK) throw codedError('This browser can\u2019t write temporary files, and the file is too big to convert in memory', 'nostore');
      setStage(it, 'Starting\u2026');
      return workerJob('main', { type: 'media', file: it.file, opts: mediaOpts(it), out: out, outMime: T[it.target].mime }, it).then(function (m) {
        it.note = m.note || '';
        return [{ name: out.name, size: m.size, mime: T[it.target].mime, file: m.file, saved: m.saved }];
      });
    }).catch(function (e) {
      // A file created in a picked folder is removed first, so the ffmpeg
      // retry can reuse its name.
      return Promise.resolve(dest && dest.drop ? dest.drop() : null).then(function () {
        if (it.cancelled || e.code === 'canceled' || e.code === 'quota' || e.code === 'nostore' || e.code === 'offline') throw e;
        // Fast path can't do this file/target here: fall back to ffmpeg.
        if (S.prefs.autoFallback && (e.code === 'unsupported' || e.code === 'failed')) {
          if (missingWire(['ffjs', 'ffwasm']) && navigator.onLine === false) throw e;
          return runFfMedia(it, e.message);
        }
        throw e;
      });
    });
  }
  function runFfMedia(it, why) {
    var name = outName(baseOf(it.name), it.target, sameSuffix(it));
    it.engine = 'ffmpeg';
    if (why) it.note = 'Fast engine couldn\u2019t (' + why.replace(/^Fast engine can\u2019t do this \(|\)$/g, '') + ') \u2014 used ffmpeg';
    var tv = trimVals(it);
    var o = mediaOpts(it);
    o.noAudio = it.sn.fmt === 'gif';
    o.big = it.size > 200 * 1024 * 1024;
    o.quality = it.opts.quality;
    if (it.opts.ffArgs && it.opts.ffArgs.trim()) o.custom = splitArgs(it.opts.ffArgs);
    var args = buildFfArgs(o);
    var input = new File([it.file], 'input.' + (inputExt(it)), { type: it.file.type || '' });
    return destFor(it, name).then(function (out) {
      setStage(it, 'Starting compatible engine\u2026');
      renderCard(it);
      return workerJob('ff', { type: 'ff', file: input, args: args, outFile: 'out.' + T[it.target].ext, outMime: T[it.target].mime, out: out, dur: expectDur(it) || (tv.end > 0 ? tv.end - (tv.start || 0) : 0) }, it)
        .then(function (m) { return [{ name: out.name, size: m.size, mime: T[it.target].mime, file: m.file, saved: m.saved }]; }, function (e) {
          killRole('ff'); // a failed core may be wedged (abort / OOM): start fresh next time
          if (out.drop) out.drop();
          if (e.code === 'memory') e.message = 'Ran out of memory in the compatible engine \u2014 try a smaller preset, trim it, or use a desktop browser';
          else if (e.code === 'crash') e.message = 'The compatible engine crashed on this file (' + e.message + ') \u2014 try another target format';
          throw e;
        });
    });
  }
  function inputExt(it) {
    var m = { jpeg: 'jpg', heic: 'heic', mpg: 'mpg', wmv: 'wmv', wma: 'wma', aiff: 'aiff', ogv: 'ogv', bin: 'bin' };
    return m[it.sn.fmt] || it.sn.fmt || it.sn.ext || 'bin';
  }

  // ---- images ----------------------------------------------------------------
  function loadImgEl(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.decoding = 'async';
      img.onload = function () {
        var go = function () { resolve({ src: img, w: img.naturalWidth, h: img.naturalHeight, free: function () { URL.revokeObjectURL(url); img.src = ''; } }); };
        if (img.decode) img.decode().then(go, go); else go();
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }
  // SVGs without width/height rasterize at 300x150 — give them a real size.
  function svgBlob(file) {
    return file.text().then(function (txt) {
      var m = /<svg\b[^>]*>/i.exec(txt);
      if (!m) throw new Error('not an SVG');
      var tag = m[0], w = /\swidth\s*=\s*["']?([\d.]+)(px)?["'\s>]/i.exec(tag), h = /\sheight\s*=\s*["']?([\d.]+)(px)?["'\s>]/i.exec(tag);
      var vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
      if (w && h) return { blob: new Blob([txt], { type: 'image/svg+xml' }), w: +w[1], h: +h[1] };
      var vw = vb ? +vb[1] : 1024, vh = vb ? +vb[2] : 1024;
      var k = 1024 / Math.max(vw, vh);
      var W = Math.round(vw * k), H = Math.round(vh * k);
      var fixed = txt.replace(tag, tag.replace(/<svg\b/i, '<svg width="' + W + '" height="' + H + '"'));
      return { blob: new Blob([fixed], { type: 'image/svg+xml' }), w: W, h: H };
    });
  }
  // -> {src: CanvasImageSource, w, h, free()}
  function decodeImage(it) {
    var f = it.file, fmt = it.sn.fmt;
    if (fmt === 'svg') {
      return svgBlob(f).then(function (s) {
        return loadImgEl(s.blob).then(function (d) { d.w = s.w; d.h = s.h; return d; });
      });
    }
    var viaHeif = function () {
      setStage(it, 'Decoding HEIC\u2026');
      return workerJob('main', { type: 'heic', file: f }, it).then(function (m) {
        var data = new ImageData(new Uint8ClampedArray(m.pixels), m.width, m.height);
        var c = document.createElement('canvas');
        c.width = m.width; c.height = m.height;
        c.getContext('2d').putImageData(data, 0, 0);
        return { src: c, w: m.width, h: m.height, free: function () { c.width = c.height = 0; } };
      });
    };
    // Anything the browser can't decode but ffmpeg can (TIFF/PSD/JPEG 2000 on
    // Chrome, BMP variants...): ffmpeg -> PNG in memory, then decode that.
    var viaFf = function () {
      setStage(it, 'Decoding with ffmpeg\u2026');
      var input = new File([f], 'input.' + inputExt(it));
      return workerJob('ff', { type: 'ff', file: input, args: ['-i', '{in}', '-frames:v', '1', '{out}'], outFile: 'out.png', outMime: 'image/png', out: { kind: 'memory', name: 'decoded.png' }, dur: 0 }, it)
        .then(function (m) { return loadImgEl(m.file); }, function (e) { killRole('ff'); throw e; });
    };
    if (fmt === 'heic' && !S.caps.heicNative) return viaHeif();
    return loadImgEl(f).catch(function () {
      if (fmt === 'heic' || fmt === 'avif') return viaHeif();
      if (typeof window.createImageBitmap === 'function') {
        return window.createImageBitmap(f).then(function (bm) {
          return { src: bm, w: bm.width, h: bm.height, free: function () { try { bm.close(); } catch (e) {} } };
        });
      }
      throw new Error('decode failed');
    }).catch(function (e) {
      if (it.cancelled) throw e;
      if (fmt === 'heic') throw codedError('Couldn\u2019t decode this HEIC photo');
      return viaFf();
    });
  }
  function fitSize(w, h, maxSide, maxArea) {
    var k = 1;
    if (maxSide && Math.max(w, h) > maxSide) k = maxSide / Math.max(w, h);
    if (w * h * k * k > maxArea) k = Math.sqrt(maxArea / (w * h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: k < 1 };
  }
  function drawTo(src, w, h, bg) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable (too large for this device?)');
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src.src, 0, 0, w, h);
    return c;
  }
  function canvasBlob(c, mime, q) {
    return new Promise(function (resolve, reject) {
      try {
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('Couldn\u2019t encode the image (too large?)')); }, mime, q);
      } catch (e) { reject(e); }
    });
  }
  function freeCanvas(c) { if (c) { c.width = 0; c.height = 0; } }
  function fileOut(blobOrText, name, mime, text) {
    var file = new File([blobOrText], name, { type: mime });
    var o = { name: name, size: file.size, mime: mime, file: file };
    if (text != null && text.length <= TEXT_INLINE_MAX) o.text = text;
    return o;
  }
  // Big page-made outputs are moved to OPFS so the RAM copy can go.
  function persist(it, out) {
    if (!S.caps.opfs || out.size < 24 * 1024 * 1024 || !S.caps.worker) return Promise.resolve(out);
    return workerJob('main', { type: 'persist', blob: out.file, name: out.name, mime: out.mime, out: { kind: 'opfs', dir: tmpPath(it), name: out.name } }, it)
      .then(function (m) { out.file = m.file; return out; }, function () { return out; });
  }
  function runImage(it) {
    var t = it.target;
    if (t === 'mp4' || t === 'webm') return runFfMedia(it, '');
    var maxSide = { orig: 0, '2048': 2048, '1280': 1280, '640': 640 }[it.preset] || 0;
    var q = it.opts.quality || 0.86;
    var base = baseOf(it.name);
    setStage(it, 'Decoding\u2026');
    return decodeImage(it).then(function (src) {
      if (it.cancelled) { src.free(); throw codedError('Cancelled', 'canceled'); }
      setProgress(it, 0.4);
      var done = function (r) { src.free(); return r; };
      var fail = function (e) { src.free(); throw e; };
      if (t === 'ico') return icoFrom(src, base).then(done, fail);
      var sz = fitSize(src.w, src.h, maxSide, S.caps.maxArea);
      if (sz.scaled && !maxSide) it.note = 'Scaled to ' + sz.w + '\u00d7' + sz.h + ' (this device\u2019s canvas limit)';
      if (t === 'pdf') {
        src.alpha = /^(png|gif|webp|svg|ico|bmp)$/.test(it.sn.fmt);
        return encodeForPdf(src, q, maxSide).then(function (img) { src.free(); return pdfFromImages([img], base, it); }, fail)
          .then(function (o) { return persist(it, o); });
      }
      var c = drawTo(src, sz.w, sz.h, t === 'jpeg' ? '#ffffff' : '');
      src.free();
      setStage(it, 'Encoding\u2026');
      var mime = T[t].mime;
      return canvasBlob(c, mime, t === 'png' ? undefined : q).then(function (b) {
        if (b.type === mime || (t === 'jpeg' && /jpe?g/.test(b.type))) {
          freeCanvas(c);
          return persist(it, fileOut(b, outName(base, t, sameSuffix(it)), mime));
        }
        // The browser silently fell back to PNG (Safari has no WebP encoder):
        // hand the PNG to ffmpeg's libwebp.
        if (t !== 'webp') { freeCanvas(c); throw codedError('This browser can\u2019t encode ' + T[t].label); }
        return canvasBlob(c, 'image/png').then(function (png) {
          freeCanvas(c);
          setStage(it, 'Encoding WebP (ffmpeg)\u2026');
          return destFor(it, outName(base, 'webp', sameSuffix(it))).then(function (out) {
            if (out.kind === 'handle') out = { kind: S.caps.opfs ? 'opfs' : 'memory', dir: tmpPath(it), name: out.name };
            var o = { target: 'webp', quality: q };
            return workerJob('ff', { type: 'ff', file: new File([png], 'input.png', { type: 'image/png' }), args: buildFfArgs(o), outFile: 'out.webp', outMime: 'image/webp', out: out, dur: 0 }, it)
              .then(function (m) { it.note = 'WebP via ffmpeg (no native encoder here)'; return { name: out.name, size: m.size, mime: 'image/webp', file: m.file }; },
                function (e) { killRole('ff'); throw e; });
          });
        });
      }, function (e) { freeCanvas(c); throw e; });
    }).then(function (o) { return [o]; });
  }
  function icoFrom(src, base) {
    var sizes = [16, 32, 48, 64, 128, 256];
    var entries = [];
    var chain = Promise.resolve();
    sizes.forEach(function (s) {
      chain = chain.then(function () {
        var c = document.createElement('canvas');
        c.width = c.height = s;
        var ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        var k = Math.min(s / src.w, s / src.h), w = src.w * k, h = src.h * k;
        ctx.drawImage(src.src, (s - w) / 2, (s - h) / 2, w, h);
        return canvasBlob(c, 'image/png').then(function (b) { freeCanvas(c); return b.arrayBuffer(); })
          .then(function (ab) { entries.push({ size: s, bytes: new Uint8Array(ab) }); });
      });
    });
    return chain.then(function () {
      var name = base + '.ico';
      return fileOut(new Blob([buildIco(entries)], { type: 'image/x-icon' }), name, 'image/x-icon');
    });
  }
  // A decoded image -> compressed bytes for a PDF page (then the pixels can
  // go — iOS caps total canvas memory, so never hold many at once).
  // Images that may be transparent stay PNG; photos become JPEG.
  function encodeForPdf(src, q, maxSide) {
    var sz = fitSize(src.w, src.h, maxSide || 0, Math.min(S.caps.maxArea, 40000000));
    var png = !!src.alpha;
    var c = drawTo(src, sz.w, sz.h, png ? '' : '#ffffff');
    return canvasBlob(c, png ? 'image/png' : 'image/jpeg', png ? undefined : Math.max(q, 0.8)).then(function (b) {
      freeCanvas(c);
      return b.arrayBuffer();
    }, function (e) { freeCanvas(c); throw e; }).then(function (ab) {
      return { bytes: new Uint8Array(ab), type: png ? 'png' : 'jpeg', width: sz.w, height: sz.h };
    });
  }
  function pdfFromImages(imgs, base, it) {
    return Promise.all([loadGlobal('pdflib', dlCb(it)), loadDocs()]).then(function (r) {
      return r[1].imagesToPdf(r[0], imgs, base);
    }).then(function (u8) { return fileOut(new Blob([u8], { type: 'application/pdf' }), base + '.pdf', 'application/pdf'); });
  }
  // "Combine into PDF": a synthetic item over several image items, in list
  // order. Each photo is decoded, capped at 3000 px and compressed before the
  // next one is touched.
  function runCombine(it) {
    var srcItems = it.combine.map(itemById).filter(Boolean);
    if (!srcItems.length) return Promise.reject(codedError('The images were removed'));
    var imgs = [], i = 0, q = it.opts.quality || 0.86;
    var next = function () {
      if (it.cancelled) return Promise.reject(codedError('Cancelled', 'canceled'));
      if (i >= srcItems.length) return Promise.resolve();
      var s = srcItems[i++];
      setStage(it, 'Reading image ' + i + ' of ' + srcItems.length + '\u2026');
      setProgress(it, (i - 1) / (srcItems.length + 1));
      return decodeImage(s).then(function (d) {
        d.alpha = /^(png|gif|webp|svg|ico|bmp)$/.test(s.sn.fmt);
        return encodeForPdf(d, q, 3000).then(function (img) { d.free(); imgs.push(img); return next(); }, function (e) { d.free(); throw e; });
      });
    };
    return next().then(function () {
      setStage(it, 'Building PDF\u2026');
      return pdfFromImages(imgs, it.base, it);
    }).then(function (o) { return persist(it, o).then(function (x) { return [x]; }); });
  }

  // ---- PDF (pdf.js) ------------------------------------------------------------
  function dlCb(it) {
    return function (loaded, total, label) { setDl(it, loaded, total, label); };
  }
  function runPdf(it) {
    var base = baseOf(it.name), t = it.target;
    setStage(it, 'Loading PDF reader\u2026');
    return loadPdfjs(dlCb(it)).then(function (pdfjs) {
      setStage(it, 'Opening PDF\u2026');
      return it.file.arrayBuffer().then(function (ab) {
        var task = pdfjs.getDocument({
          data: new Uint8Array(ab), isEvalSupported: false,
          cMapUrl: PDFJS + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS + 'standard_fonts/', wasmUrl: PDFJS + 'wasm/',
        });
        it.abort = function () { try { task.destroy(); } catch (e) {} };
        return task.promise;
      });
    }).then(function (doc) {
      var n = doc.numPages, outs = [], texts = [], i = 0;
      var maxPages = t === 'txt' ? 5000 : 300;
      if (n > maxPages) it.note = 'Only the first ' + maxPages + ' of ' + n + ' pages';
      var scale = { '1x': 1, '2x': 2, '3x': 3 }[it.preset] || 2;
      var step = function () {
        if (it.cancelled) throw codedError('Cancelled', 'canceled');
        if (i >= Math.min(n, maxPages)) return;
        i++;
        setStage(it, (t === 'txt' ? 'Reading' : 'Rendering') + ' page ' + i + ' of ' + n + '\u2026');
        setProgress(it, (i - 1) / Math.min(n, maxPages));
        return doc.getPage(i).then(function (page) {
          if (t === 'txt') {
            return page.getTextContent().then(function (tc) {
              var s = '';
              tc.items.forEach(function (x) { if (x.str != null) s += x.str + (x.hasEOL ? '\n' : ''); });
              texts.push(s.replace(/[ \t]+\n/g, '\n').trim());
              page.cleanup();
            });
          }
          var vp0 = page.getViewport({ scale: 1 });
          var sz = fitSize(vp0.width * scale, vp0.height * scale, 0, S.caps.maxArea);
          var vp = page.getViewport({ scale: sz.w / vp0.width });
          var c = document.createElement('canvas');
          c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
          var ctx = c.getContext('2d');
          if (t === 'jpgpages') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); }
          return page.render({ canvas: c, viewport: vp, background: t === 'jpgpages' ? 'rgb(255,255,255)' : undefined }).promise.then(function () {
            page.cleanup();
            return canvasBlob(c, T[t].mime, t === 'jpgpages' ? (it.opts.quality || 0.86) : undefined);
          }).then(function (b) {
            freeCanvas(c);
            var pad = String(Math.min(n, maxPages)).length;
            var num = ('000000' + i).slice(-pad);
            outs.push(fileOut(b, base + '-p' + num + '.' + T[t].ext, T[t].mime));
          }, function (e) { freeCanvas(c); throw e; });
        }).then(step);
      };
      return step().then(function () {
        try { doc.destroy(); } catch (e) {}
        if (t === 'txt') {
          var text = texts.join('\n\n').replace(/\n{4,}/g, '\n\n\n') + '\n';
          if (!text.trim()) it.note = 'No text layer found \u2014 this PDF may be scanned images';
          return [fileOut(text, base + '.txt', 'text/plain', text)];
        }
        return outs;
      }, function (e) { try { doc.destroy(); } catch (x) {} throw e; });
    }).catch(function (e) {
      if (e && e.name === 'PasswordException') throw codedError('This PDF is password-protected');
      throw e;
    });
  }

  // ---- documents ---------------------------------------------------------------
  function runDoc(it) {
    var src = it.sn.cat, t = it.target, base = baseOf(it.name), dl = dlCb(it);
    var need = planFor(it, S.caps).assets;
    setStage(it, need.length && missingWire(need) ? 'Downloading converter\u2026' : 'Converting\u2026');
    return loadDocs().then(function (D) {
      return Promise.all(need.map(function (k) { return loadGlobal(k, dl); })).then(function () {
        var lib = { mammoth: window.mammoth, docx: window.docx, marked: window.marked, TurndownService: window.TurndownService };
        setStage(it, 'Converting\u2026');
        var textOut = function (s) { return [fileOut(s, base + '.' + T[t].ext, T[t].mime + ';charset=utf-8', s)]; };
        var docxOut = function (doc) {
          return window.docx.Packer.toBlob(doc).then(function (b) { return [fileOut(b, base + '.docx', T.docx.mime)]; });
        };
        if (src === 'docx') {
          return it.file.arrayBuffer().then(function (ab) {
            var p = t === 'html' ? D.docxToHtml(lib, ab, base) : t === 'md' ? D.docxToMarkdown(lib, ab) : D.docxToText(lib, ab);
            return p.then(function (r) {
              if (r.warnings) it.note = r.warnings + ' formatting note' + (r.warnings === 1 ? '' : 's') + ' (unsupported Word features were simplified)';
              return textOut(r.text);
            });
          });
        }
        return it.file.text().then(function (s) {
          s = s.replace(/^\ufeff/, '');
          var parse = function (html) { return new DOMParser().parseFromString(html, 'text/html'); };
          if (src === 'md') {
            if (t === 'html') return textOut(D.mdToHtml(lib, s, base));
            if (t === 'txt') return textOut(D.htmlToText(parse(lib.marked.parse(s, { gfm: true, async: false }))));
            return docxOut(D.mdToDocx(lib, s, base));
          }
          if (src === 'html') {
            if (t === 'txt') return textOut(D.htmlToText(parse(s)));
            var md = D.htmlToMarkdown(lib, s);
            if (t === 'md') return textOut(md);
            return docxOut(D.mdToDocx(lib, md, base));
          }
          if (t === 'html') return textOut(D.textToHtml(s, base));
          return docxOut(D.textToDocx(lib, s, base));
        });
      });
    });
  }
  function runSheet(it) {
    var base = baseOf(it.name), t = it.target, fmt = it.sn.fmt;
    setStage(it, missingWire(['xlsx']) ? 'Downloading spreadsheet engine\u2026' : 'Reading\u2026');
    return Promise.all([loadDocs(), loadGlobal('xlsx', dlCb(it))]).then(function (r) {
      var D = r[0], XLSX = r[1];
      var textIn = fmt === 'csv' || fmt === 'tsv' || fmt === 'json';
      return (textIn ? it.file.text() : it.file.arrayBuffer()).then(function (data) {
        setStage(it, 'Converting\u2026');
        var wb;
        try { wb = D.sheetRead(XLSX, textIn ? { fmt: fmt, text: data } : { fmt: fmt, bytes: data }); }
        catch (e) { throw codedError(fmt === 'json' ? 'Not valid JSON: ' + e.message : (e.message || 'Couldn\u2019t read the spreadsheet')); }
        var outs = D.sheetWrite(XLSX, wb, t, base);
        return outs.map(function (o) {
          return fileOut(o.data, o.name, o.mime + (o.text ? ';charset=utf-8' : ''), o.text ? o.data : null);
        });
      });
    });
  }

  // ============================================================================
  // Rendering
  // ============================================================================
  var ICONS = {
    video: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="14" height="14" rx="2"/><path d="M16.5 10l5-3v10l-5-3"/></svg>',
    audio: '<svg viewBox="0 0 24 24"><path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
    pdf: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 15h1.5a1.5 1.5 0 0 0 0-3H8v5M13 12v5h1a2 2 0 0 0 2-2v-1a2 2 0 0 0-2-2z"/></svg>',
    doc: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8M8 9h2"/></svg>',
    sheet: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>',
    none: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    combine: '<svg viewBox="0 0 24 24"><rect x="7" y="3" width="14" height="14" rx="2"/><path d="M3 7v12a2 2 0 0 0 2 2h12"/></svg>',
  };
  var UPLOAD_SVG = '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>';
  var LOCK_SVG = '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  function iconFor(it) {
    if (it.combine) return ICONS.combine;
    var c = it.sn ? it.sn.cat : 'none';
    if (c === 'docx' || c === 'md' || c === 'html' || c === 'text') return ICONS.doc;
    return ICONS[c] || ICONS.none;
  }
  function metaLine(it) {
    var parts = [];
    if (it.combine) parts.push(it.combine.length + ' images');
    else if (!it.sn) parts.push('Detecting\u2026');
    else parts.push(it.sn.mismatch ? it.sn.label + ' (named .' + it.sn.ext + ')' : it.sn.label);
    if (!it.combine) parts.push(fmtBytes(it.size));
    if (it.meta.w && it.meta.h) parts.push(it.meta.w + '\u00d7' + it.meta.h);
    if (it.meta.dur) parts.push(fmtClock(it.meta.dur));
    return parts.join(' \u00b7 ');
  }
  function warnings(it, pl) {
    var w = [];
    if (!it.sn || it.state === 'unsupported') return w;
    if (pl.engine === 'ffmpeg' && (it.sn.cat === 'video' || it.sn.cat === 'image')) {
      var video = T[it.target] && (T[it.target].kind === 'video' || T[it.target].kind === 'gif');
      if (video) w.push('Compatible engine is single-threaded \u2014 video re-encoding can take a while.');
      if (it.size > (S.caps.ios ? 250 : 1500) * 1024 * 1024) w.push('Big file for the compatible engine: it works in memory and may run out on this device. Trim it or pick a smaller preset.');
    }
    var miss = missingWire(pl.assets);
    if (miss) w.push('First use downloads ' + fmtBytes(miss) + ' (kept for offline use).');
    if (it.sn.fmt === 'heic' && pl.engine === 'image' && !S.caps.heicNative) w.push('HEIC is decoded with a wasm decoder here.');
    return w;
  }
  function optionsHtml(it, pl) {
    var t = it.target, k = presetKind(t), h = '';
    if (t === 'jpeg' || t === 'webp' || t === 'pdf' || t === 'jpgpages') {
      var q = Math.round((it.opts.quality || 0.86) * 100);
      h += '<label class="cv-opt cv-q"><span>Quality</span><input type="range" min="40" max="100" step="1" value="' + q + '" data-f="quality" aria-label="Quality"><b>' + q + '</b></label>';
    }
    if (k === 'video' || k === 'audio' || k === 'gif') {
      h += '<div class="cv-opt cv-trim"><span>Trim</span>' +
        '<input type="text" inputmode="decimal" placeholder="start 0:00" value="' + esc(it.opts.trimStart) + '" data-f="trimStart" aria-label="Trim start">' +
        '<span class="cv-dash">\u2013</span>' +
        '<input type="text" inputmode="decimal" placeholder="end ' + (it.meta.dur ? fmtClock(it.meta.dur) : 'm:ss') + '" value="' + esc(it.opts.trimEnd) + '" data-f="trimEnd" aria-label="Trim end"></div>';
      if (k !== 'gif') h += '<label class="cv-opt cv-chk"><input type="checkbox" data-f="mono"' + (it.opts.mono ? ' checked' : '') + '> Mono audio</label>';
      if (it.sn.cat === 'video' || it.sn.cat === 'audio') {
        h += '<label class="cv-opt"><span>Engine</span><select data-f="engine">' +
          '<option value="auto"' + (it.opts.engine === 'auto' ? ' selected' : '') + '>Auto (fast, ffmpeg fallback)</option>' +
          '<option value="ffmpeg"' + (it.opts.engine === 'ffmpeg' ? ' selected' : '') + '>Compatible \u00b7 ffmpeg</option></select></label>';
      }
      var gen = ffOptions({ target: t, preset: it.preset, mono: it.opts.mono, noAudio: it.sn.fmt === 'gif', big: it.size > 200 * 1024 * 1024, quality: it.opts.quality });
      h += '<label class="cv-opt cv-ff"><span>Custom ffmpeg options <i>(replace the generated ones; input, trim and output are added for you)</i></span>' +
        '<textarea rows="2" spellcheck="false" autocapitalize="off" autocorrect="off" data-f="ffArgs" placeholder="' + esc(joinArgs(gen)) + '">' + esc(it.opts.ffArgs) + '</textarea>' +
        (it.opts.ffArgs ? '<button class="cv-link" data-act="ffreset">Use generated options</button>' : '<button class="cv-link" data-act="ffcopy">Start from generated options</button>') +
        '</label>';
    }
    return h;
  }
  function presetsHtml(it) {
    var k = presetKind(it.target), list = PRESETS[k];
    if (!list) return '';
    return '<div class="cv-chips" role="group" aria-label="Preset">' + list.map(function (p) {
      return '<button class="cv-chip' + (p[0] === it.preset ? ' on' : '') + '" data-preset="' + p[0] + '">' + esc(p[1]) + '</button>';
    }).join('') + '</div>';
  }
  function outputsHtml(it) {
    if (!it.outputs.length) return '';
    var many = it.outputs.length > 1;
    var shareAll = many && S.caps.share && canShareFiles(it.outputs.map(function (o) { return o.file; }));
    var rows = it.outputs.map(function (o, i) {
      var isImg = /^image\/(png|jpeg|webp|gif)/.test(o.mime);
      var canInsert = (o.text != null && o.text.length <= 1024 * 1024) || (isImg && typeof window.insertImageFile === 'function');
      var share = S.caps.share && canShareFiles([o.file]);
      return '<div class="cv-out">' +
        '<div class="cv-out-name"><span title="' + esc(o.name) + '">' + esc(o.name) + '</span><small>' + fmtBytes(o.size) + (o.saved ? ' \u00b7 saved to disk' : '') + '</small></div>' +
        '<div class="cv-out-acts">' +
          (share ? '<button class="cv-btn' + (S.caps.coarse ? ' primary' : '') + '" data-act="share" data-i="' + i + '">Share</button>' : '') +
          (o.saved ? '' : '<button class="cv-btn' + (S.caps.coarse && share ? '' : ' primary') + '" data-act="download" data-i="' + i + '">Download</button>') +
          (canInsert ? '<button class="cv-btn" data-act="insert" data-i="' + i + '" title="Insert into the document at the cursor">Insert</button>' : '') +
          (o.text != null ? '<button class="cv-btn" data-act="copy" data-i="' + i + '">Copy</button>' : '') +
        '</div></div>';
    }).join('');
    return '<div class="cv-outs' + (many ? ' many' : '') + '">' +
      (many ? '<div class="cv-outs-head"><span>' + it.outputs.length + ' files</span>' + (shareAll ? '<button class="cv-btn" data-act="shareall">Share all</button>' : '') + '</div>' : '') +
      rows + '</div>';
  }
  function canShareFiles(files) {
    try { return !!navigator.canShare && navigator.canShare({ files: files }); } catch (e) { return false; }
  }
  function cardHtml(it) {
    var pl = it.sn ? planFor(it, S.caps) : { engine: '', label: '', assets: [] };
    if (it.combine) pl = { engine: 'image', label: 'pdf-lib', assets: ['pdflib'] };
    var st = it.state, busy = st === 'queued' || st === 'running';
    var h = '<div class="cv-head">' +
      '<div class="cv-ico" data-cat="' + esc(it.combine ? 'combine' : (it.sn ? it.sn.cat : 'none')) + '">' + iconFor(it) + '</div>' +
      '<div class="cv-info"><div class="cv-name" title="' + esc(it.name) + '">' + esc(it.name) + '</div>' +
      '<div class="cv-sub">' + esc(metaLine(it)) + '</div></div>' +
      '<button class="cv-x" data-act="remove" title="Remove" aria-label="Remove">\u00d7</button></div>';
    if (st === 'unsupported') {
      h += '<div class="cv-msg">Can\u2019t convert this type yet.</div>';
      return h;
    }
    if (st === 'sniff') return h + '<div class="cv-msg">Detecting type\u2026</div>';
    if (!it.combine) {
      var targets = targetsFor(it.sn);
      h += '<div class="cv-cfg"><label class="cv-to"><span>to</span><select data-f="target"' + (busy ? ' disabled' : '') + ' aria-label="Convert to">' +
        targets.map(function (t) { return '<option value="' + t + '"' + (t === it.target ? ' selected' : '') + '>' + esc(T[t].label) + '</option>'; }).join('') +
        '</select></label>' +
        (pl.label ? '<span class="cv-eng" data-eng="' + pl.engine + '" title="Converter">' + esc(pl.label) + '</span>' : '') +
        (optionsHtml(it, pl) ? '<button class="cv-more' + (it.opts.open ? ' on' : '') + '" data-act="opts" aria-expanded="' + (it.opts.open ? 'true' : 'false') + '">Options</button>' : '') +
        '</div>';
      if (!busy) {
        h += presetsHtml(it);
        if (it.opts.open) h += '<div class="cv-opts">' + optionsHtml(it, pl) + '</div>';
      }
      var sameCat = S.items.filter(function (x) { return x !== it && x.sn && x.sn.cat === it.sn.cat && !x.combine && (x.state === 'ready' || x.state === 'error' || x.state === 'canceled') && x.target !== it.target; });
      if (it.touched && sameCat.length && !busy) h += '<button class="cv-link cv-apply" data-act="applyall">Use ' + esc(T[it.target].label) + ' for ' + sameCat.length + ' more</button>';
      if (!busy && st !== 'done') warnings(it, pl).forEach(function (w) { h += '<div class="cv-warn">' + esc(w) + '</div>'; });
    }
    if (busy || st === 'done') {
      var pct = st === 'done' ? 100 : Math.max(0, Math.round((it.p || 0) * 100));
      h += '<div class="cv-prog' + (st === 'done' ? ' done' : '') + (it.p < 0 ? ' indet' : '') + '"><div class="cv-bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="cv-ptxt">' + esc(progressText(it)) + '</div></div>';
    }
    if (it.note && (st === 'done' || busy)) h += '<div class="cv-note">' + esc(it.note) + '</div>';
    if (st === 'error') h += '<div class="cv-err">' + esc(it.error || 'Failed') + '</div>';
    if (st === 'canceled') h += '<div class="cv-note">Cancelled</div>';
    h += outputsHtml(it);
    h += '<div class="cv-btns">';
    if (busy) h += '<button class="cv-btn" data-act="cancel">Cancel</button>';
    else if (st === 'ready') h += '<button class="cv-btn primary" data-act="convert">Convert</button>';
    else h += '<button class="cv-btn' + (st === 'done' ? '' : ' primary') + '" data-act="convert">' + (st === 'done' ? 'Convert again' : 'Retry') + '</button>';
    if (st === 'error' && it.engine === 'fast' && !S.prefs.autoFallback) h += '<button class="cv-btn" data-act="useff">Try ffmpeg</button>';
    h += '</div>';
    return h;
  }
  function progressText(it) {
    if (it.state === 'done') {
      var tot = 0;
      it.outputs.forEach(function (o) { tot += o.size || 0; });
      var secs = it.t0 ? (Date.now() - it.t0) / 1000 : 0;
      return 'Done' + (tot ? ' \u00b7 ' + fmtBytes(tot) : '') + (it.size && tot && !it.combine ? ' (' + Math.round(tot / it.size * 100) + '% of original)' : '') + (secs >= 1 ? ' \u00b7 ' + fmtClock(secs) : '');
    }
    if (it.state === 'queued') return 'Waiting\u2026';
    if (it.dl && it.dl.loaded < it.dl.total) {
      return 'Downloading ' + (it.dl.label || 'converter') + ' \u00b7 ' + fmtBytes(it.dl.loaded) + ' / ' + fmtBytes(it.dl.total);
    }
    var parts = [];
    if (it.stage) parts.push(it.stage);
    if (it.p > 0) {
      parts.push(Math.round(it.p * 100) + '%');
      var e = etaText(Date.now() - (it.pt0 || it.t0), it.p);
      if (e) parts.push(e);
    } else if (it.p < 0 && it.ptime) {
      parts.push(fmtClock(it.ptime) + ' processed');
    }
    return parts.join(' \u00b7 ') || 'Working\u2026';
  }
  function cardEl(it) { var p = panel(); return p ? p.querySelector('.cv-card[data-id="' + it.id + '"]') : null; }
  function renderCard(it) {
    var el = cardEl(it);
    if (!el) { renderList(); return; }
    el.setAttribute('data-state', it.state);
    // Keep focus inside an option field that triggered the re-render.
    var ae = document.activeElement, f = ae && el.contains(ae) ? ae.getAttribute('data-f') : null;
    el.innerHTML = cardHtml(it);
    if (f) { var again = el.querySelector('[data-f="' + f + '"]'); if (again) { again.focus(); } }
  }
  function renderList() {
    var p = panel();
    if (!p) return;
    var list = p.querySelector('.cv-list');
    if (!S.items.length) { list.innerHTML = ''; p.classList.add('cv-empty'); renderFoot(); return; }
    p.classList.remove('cv-empty');
    var have = {};
    Array.prototype.forEach.call(list.children, function (c) { have[c.getAttribute('data-id')] = c; });
    S.items.forEach(function (it) {
      var el = have[it.id];
      if (!el) {
        el = document.createElement('div');
        el.className = 'cv-card';
        el.setAttribute('data-id', it.id);
        el.setAttribute('data-state', it.state);
        el.innerHTML = cardHtml(it);
      }
      list.appendChild(el); // (re)orders
      delete have[it.id];
    });
    Object.keys(have).forEach(function (k) { have[k].remove(); });
    renderFoot();
  }
  // Progress updates touch only the bar + label (no innerHTML churn).
  var progRaf = 0;
  function paintProgress(it) {
    var el = cardEl(it);
    if (!el) return;
    var prog = el.querySelector('.cv-prog');
    if (!prog) { renderCard(it); return; }
    var downloading = !!(it.dl && it.dl.loaded < it.dl.total);
    prog.classList.toggle('indet', it.p < 0 && !downloading);
    var bar = prog.querySelector('.cv-bar i'), txt = prog.querySelector('.cv-ptxt');
    var frac = downloading ? it.dl.loaded / it.dl.total : it.p;
    if (bar) bar.style.width = Math.max(0, Math.round((frac > 0 ? frac : 0) * 100)) + '%';
    if (txt) txt.textContent = progressText(it);
  }
  function schedulePaint(it) {
    it.dirty = true;
    if (progRaf) return;
    var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 50); };
    progRaf = raf(function () {
      progRaf = 0;
      S.items.forEach(function (x) { if (x.dirty) { x.dirty = false; paintProgress(x); } });
    });
  }
  function setStage(it, text) { it.stage = text || ''; schedulePaint(it); }
  function setProgress(it, p, t) {
    if (p > 0 && !(it.p > 0)) it.pt0 = Date.now() - 1; // ETA from when real progress starts (not download)
    it.p = p;
    if (t != null) it.ptime = t;
    schedulePaint(it);
  }
  function setDl(it, loaded, total, label) {
    it.dl = { loaded: loaded, total: total, label: label };
    if (loaded >= total) setTimeout(function () { refreshCached(); }, 300);
    schedulePaint(it);
  }
  function renderFoot() {
    var p = panel();
    if (!p) return;
    var ready = S.items.filter(function (it) { return it.state === 'ready' || it.state === 'error' || it.state === 'canceled'; }).length;
    var busy = S.items.some(function (it) { return it.state === 'queued' || it.state === 'running'; });
    var imgs = S.items.filter(function (it) { return it.sn && it.sn.cat === 'image' && !it.combine; }).length;
    var all = p.querySelector('.cv-all');
    all.textContent = ready > 1 ? 'Convert all (' + ready + ')' : 'Convert';
    all.disabled = !ready;
    var comb = p.querySelector('.cv-combine');
    comb.hidden = imgs < 2;
    p.querySelector('.cv-clear').hidden = !S.items.length || busy;
    var space = p.querySelector('.cv-space');
    space.textContent = S.free != null ? '~' + fmtBytes(S.free) + ' free for temp files' : '';
    var conv = p.querySelector('.cv-convs');
    var n = cachedBytes();
    conv.innerHTML = n ? 'Converters on device: ' + esc(fmtBytes(n)) + ' \u00b7 <button class="cv-link" data-act="rmcache">Remove</button>' : 'Converters download on first use';
  }

  // ============================================================================
  // Actions
  // ============================================================================
  function copyText(text) {
    var done = function () { toast('Copied', 'success', 1200); };
    var fail = function () { toast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      ta.remove();
    }
  }
  function blobUrl(o) {
    if (!o.url) { o.url = URL.createObjectURL(o.file); S.urls.push(o.url); }
    return o.url;
  }
  function download(o) {
    var a = document.createElement('a');
    a.href = blobUrl(o);
    a.download = o.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    o.touched = Date.now();
  }
  function shareFiles(files, title) {
    navigator.share({ files: files, title: title }).catch(function (e) {
      if (e && e.name !== 'AbortError') toast('Share failed: ' + (e.message || e.name), 'error', 2600);
    });
  }
  function insertOut(o) {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode \u2014 editing is locked', 'error', 2000); return; }
    if (o.text != null) {
      ed.dispatch(ed.state.replaceSelection(o.text), { userEvent: 'input', scrollIntoView: true });
      toast('Inserted ' + o.name, 'success', 1400);
      return;
    }
    if (typeof window.insertImageFile !== 'function') { toast('Image pipeline unavailable', 'error', 2200); return; }
    // insertImageFile replaces the selection — park the cursor at the end of
    // the line so it doesn't split a word (same as the QR widget).
    var sel = ed.state.selection.main, line = ed.state.doc.lineAt(sel.to);
    if (!sel.empty || (sel.head > line.from && sel.head < line.to)) ed.dispatch({ selection: { anchor: line.to } });
    Promise.resolve(window.insertImageFile(new File([o.file], o.name, { type: o.mime }))).catch(function (e) {
      toast('Insert failed: ' + ((e && e.message) || e), 'error', 2600);
    });
  }
  // Drop a run's results: blob URLs + its OPFS folder. `later` waits out a
  // download / share that may still be reading them.
  function releaseOutputs(it, later) {
    var urls = [], path = it.outPath;
    it.outputs.forEach(function (o) { if (o.url) urls.push(o.url); o.url = null; });
    it.outputs = [];
    it.outPath = null;
    var fn = function () {
      urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
      if (path) removeTmp(path);
    };
    if (later) setTimeout(fn, GRACE_MS); else fn();
  }
  function removeItem(it) {
    if (it.state === 'running' || it.state === 'queued') cancelItem(it);
    var i = S.items.indexOf(it);
    if (i !== -1) S.items.splice(i, 1);
    releaseOutputs(it, true);
    renderList();
  }
  function combineImages() {
    var imgs = S.items.filter(function (it) { return it.sn && it.sn.cat === 'image' && !it.combine; });
    if (imgs.length < 2) return;
    var it = newItem(new File([], 'Images.pdf'));
    it.name = imgs.length + ' images \u2192 PDF';
    it.base = baseOf(imgs[0].name) + ' + ' + (imgs.length - 1) + ' more';
    it.combine = imgs.map(function (x) { return x.id; });
    it.sn = { fmt: 'pdf', cat: 'image', label: 'Combined PDF', ext: 'pdf' };
    it.target = 'pdf';
    it.state = 'ready';
    S.items.push(it);
    renderList();
    startItems([it]);
  }
  function pasteFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.read) { toast('Paste with Ctrl/Cmd+V here, or use Choose files', 'info', 2600); return; }
    navigator.clipboard.read().then(function (items) {
      var jobs = [];
      items.forEach(function (ci, n) {
        var types = ci.types || [];
        var img = types.filter(function (t) { return /^(image|video|audio)\//.test(t); })[0];
        var pick = img || (types.indexOf('text/html') !== -1 ? 'text/html' : types.indexOf('text/plain') !== -1 ? 'text/plain' : '');
        if (!pick) return;
        jobs.push(ci.getType(pick).then(function (b) {
          var ext = pick === 'text/html' ? 'html' : pick === 'text/plain' ? 'txt' : (pick.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '');
          return new File([b], 'Pasted' + (n ? ' ' + (n + 1) : '') + '.' + ext, { type: pick });
        }));
      });
      return Promise.all(jobs).then(function (files) {
        if (!files.length) { toast('Nothing to convert on the clipboard', 'info', 1800); return; }
        addFiles(files);
      });
    }).catch(function (e) {
      toast(e && e.name === 'NotAllowedError' ? 'Clipboard access was blocked' : 'Couldn\u2019t read the clipboard', 'error', 2200);
    });
  }
  function removeConverters() {
    var n = cachedBytes();
    if (!window.confirm('Remove the downloaded converters (' + fmtBytes(n) + ') from this device? They download again on next use.')) return;
    if (S.running) { toast('Wait for the current conversion to finish', 'info', 2000); return; }
    killRole('main'); killRole('ff');
    window.caches['delete'](CACHE).then(function () {
      S.cached = {};
      renderFoot();
      S.items.forEach(function (it) { if (it.state !== 'running') renderCard(it); });
      toast('Converters removed', 'success', 1600);
    }, function () { toast('Couldn\u2019t remove them', 'error', 2000); });
  }

  // ============================================================================
  // Panel
  // ============================================================================
  function onClick(e) {
    var t = e.target;
    if (!t.closest) return;
    var p = panel();
    if (t.closest('.cv-drop')) { p.querySelector('.cv-file').click(); return; }
    var b = t.closest('[data-act], [data-preset]');
    if (!b) return;
    var card = b.closest('.cv-card');
    var it = card ? itemById(+card.getAttribute('data-id')) : null;
    var act = b.getAttribute('data-act');
    var pre = b.getAttribute('data-preset');
    if (pre && it) { it.preset = pre; it.touched = true; renderCard(it); return; }
    var oi = +b.getAttribute('data-i');
    var o = it && it.outputs[oi];
    switch (act) {
      case 'paste': pasteFromClipboard(); break;
      case 'all':
        startItems(S.items.filter(function (x) { return x.state === 'ready' || x.state === 'error' || x.state === 'canceled'; }));
        break;
      case 'combine': combineImages(); break;
      case 'clear':
        S.items.slice().forEach(function (x) { if (x.state !== 'running' && x.state !== 'queued') removeItem(x); });
        break;
      case 'rmcache': removeConverters(); break;
      case 'remove': if (it) removeItem(it); break;
      case 'convert': if (it) startItems([it]); break;
      case 'useff': if (it) { it.opts.engine = 'ffmpeg'; startItems([it]); } break;
      case 'cancel': if (it) cancelItem(it); break;
      case 'opts': if (it) { it.opts.open = !it.opts.open; renderCard(it); } break;
      case 'ffcopy':
        if (it) {
          it.opts.ffArgs = joinArgs(ffOptions({ target: it.target, preset: it.preset, mono: it.opts.mono, noAudio: it.sn.fmt === 'gif', big: it.size > 200 * 1024 * 1024, quality: it.opts.quality }));
          renderCard(it);
        }
        break;
      case 'ffreset': if (it) { it.opts.ffArgs = ''; renderCard(it); } break;
      case 'applyall':
        if (it) {
          S.items.forEach(function (x) {
            if (x !== it && x.sn && x.sn.cat === it.sn.cat && !x.combine && x.state !== 'running' && x.state !== 'queued' && targetsFor(x.sn).indexOf(it.target) !== -1) {
              x.target = it.target; x.preset = it.preset; x.opts.quality = it.opts.quality; x.touched = true; renderCard(x);
            }
          });
          it.touched = false;
          renderCard(it);
        }
        break;
      case 'download': if (o) download(o); break;
      case 'share': if (o) { o.touched = Date.now(); shareFiles([new File([o.file], o.name, { type: o.mime.split(';')[0] })], o.name); } break;
      case 'shareall':
        if (it) shareFiles(it.outputs.map(function (x) { return new File([x.file], x.name, { type: x.mime.split(';')[0] }); }), baseOf(it.name));
        break;
      case 'insert': if (o) insertOut(o); break;
      case 'copy': if (o && o.text != null) copyText(o.text); break;
      default: break;
    }
  }
  function onChange(e) {
    var el = e.target, f = el.getAttribute && el.getAttribute('data-f');
    if (f === 'saveToDisk' || f === 'autoFallback') { S.prefs[f] = !!el.checked; savePrefs(); return; }
    var card = el.closest && el.closest('.cv-card');
    var it = card ? itemById(+card.getAttribute('data-id')) : null;
    if (!it || !f) return;
    if (f === 'target') {
      it.target = el.value;
      it.preset = defaultPreset(it.sn, it.target);
      it.touched = true;
      S.prefs.targets[it.sn.fmt] = it.target;
      savePrefs();
      if (it.state === 'done' || it.state === 'error' || it.state === 'canceled') { releaseOutputs(it, true); it.state = 'ready'; it.error = ''; it.note = ''; }
      renderCard(it);
      // Other cards' "apply to all" hints depend on this choice.
      S.items.forEach(function (x) { if (x !== it && x.sn && x.sn.cat === it.sn.cat && x.state !== 'running') renderCard(x); });
    } else if (f === 'mono') { it.opts.mono = !!el.checked; }
    else if (f === 'engine') { it.opts.engine = el.value; renderCard(it); }
    else if (f === 'quality') { it.opts.quality = (+el.value) / 100; S.prefs.quality = it.opts.quality; savePrefs(); }
  }
  function onInput(e) {
    var el = e.target, f = el.getAttribute && el.getAttribute('data-f');
    var card = el.closest && el.closest('.cv-card');
    var it = card ? itemById(+card.getAttribute('data-id')) : null;
    if (!it || !f) return;
    if (f === 'quality') {
      it.opts.quality = (+el.value) / 100;
      var b = el.parentNode.querySelector('b');
      if (b) b.textContent = el.value;
    } else if (f === 'trimStart' || f === 'trimEnd' || f === 'ffArgs') {
      it.opts[f] = el.value;
      el.classList.toggle('bad', f !== 'ffArgs' && isNaN(parseTime(el.value)));
    }
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      var tag = e.target && e.target.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') { e.target.blur(); e.stopPropagation(); return; }
      e.preventDefault();
      e.stopPropagation();
      closePanel();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('cv-drop')) {
      e.preventDefault();
      panel().querySelector('.cv-file').click();
    }
    e.stopPropagation(); // keep editor shortcuts out of the panel's inputs
  }
  function hasFiles(e) {
    var dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types) for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
    return false;
  }
  function onDrag(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    var p = panel();
    if (e.type === 'dragenter' || e.type === 'dragover') { p.classList.add('cv-drag'); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }
    else if (e.type === 'dragleave') { if (!p.contains(e.relatedTarget)) p.classList.remove('cv-drag'); }
    else if (e.type === 'drop') { p.classList.remove('cv-drag'); addFiles(e.dataTransfer.files); }
  }
  function onPaste(e) {
    var cd = e.clipboardData;
    if (!cd || !cd.files || !cd.files.length) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    e.preventDefault();
    e.stopPropagation();
    addFiles(cd.files);
  }

  function closePanel() {
    var p = panel();
    if (!p) return;
    p.remove();
    cleanup();
  }
  function cleanup() {
    killRole('main'); killRole('ff');
    Object.keys(S.pending).forEach(function (id) { var x = S.pending[id]; delete S.pending[id]; try { x.reject(codedError('Closed', 'canceled')); } catch (e) {} });
    clearTimeout(S.idleTimer);
    if (progRaf) { (window.cancelAnimationFrame || clearTimeout)(progRaf); progRaf = 0; }
    S.items.forEach(function (it) { it.cancelled = true; if (it.abort) { try { it.abort(); } catch (e) {} } });
    // Downloads / shares may still be reading the files: release after a grace period.
    var urls = S.urls.slice(), session = S.session, opfs = S.caps && S.caps.opfs;
    setTimeout(function () {
      urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
      if (opfs && session) removeTmp([TMP_DIR, session]);
    }, GRACE_MS);
    S.urls = [];
    S.items = []; S.running = null; S.session = '';
  }

  function open() {
    Cade.closeAllMenus();
    var existing = panel();
    if (existing) {
      existing.classList.remove('cv-flash'); void existing.offsetWidth; existing.classList.add('cv-flash');
      return;
    }
    loadPrefs();
    S.caps = detectCaps();
    S.session = 's' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    var p = Cade.mkPanel(PANEL_ID, '\u21c4 File Converter',
      '<div class="cv-top">' +
        '<div class="cv-drop" role="button" tabindex="0" aria-label="Choose files to convert">' +
          '<span class="cv-drop-ico">' + UPLOAD_SVG + '</span>' +
          '<span class="cv-drop-main"><b>Choose files</b><span class="cv-drop-or"> or drop them here</span></span>' +
          '<span class="cv-drop-sub">Video \u00b7 audio \u00b7 photos (HEIC too) \u00b7 PDF \u00b7 Word \u00b7 spreadsheets \u00b7 Markdown</span>' +
        '</div>' +
        '<div class="cv-row">' +
          '<span class="cv-privacy">' + LOCK_SVG + 'Files never leave this device</span>' +
          '<button class="cv-btn cv-paste" data-act="paste" title="Paste files, images or text from the clipboard">Paste</button>' +
        '</div>' +
        '<input class="cv-file" type="file" multiple hidden>' +
      '</div>' +
      '<div class="cv-list" aria-live="polite"></div>' +
      '<div class="cv-foot">' +
        '<div class="cv-acts">' +
          '<button class="cv-btn solid cv-all" data-act="all" disabled>Convert</button>' +
          '<button class="cv-btn cv-combine" data-act="combine" hidden title="Put all images into one PDF, in this order">Combine into PDF</button>' +
          '<button class="cv-btn cv-clear" data-act="clear" hidden>Clear</button>' +
        '</div>' +
        (S.caps.savePicker ? '<label class="cv-pref"><input type="checkbox" data-f="saveToDisk"' + (S.prefs.saveToDisk ? ' checked' : '') + '> Save video &amp; audio straight to disk (asks where)</label>' : '') +
        '<label class="cv-pref"><input type="checkbox" data-f="autoFallback"' + (S.prefs.autoFallback ? ' checked' : '') + '> Use ffmpeg automatically when the fast engine can\u2019t</label>' +
        '<div class="cv-meta"><span class="cv-space"></span><span class="cv-convs"></span></div>' +
      '</div>');
    p.classList.add('cv-empty');
    var input = p.querySelector('.cv-file');
    input.addEventListener('change', function () { addFiles(input.files); input.value = ''; });
    p.addEventListener('click', onClick);
    p.addEventListener('change', onChange);
    p.addEventListener('input', onInput);
    p.addEventListener('keydown', onKey);
    p.addEventListener('paste', onPaste);
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (t) { p.addEventListener(t, onDrag); });
    p._onClose = cleanup;
    renderList();
    refreshCached();
    refreshSpace();
    setTimeout(sweepTmp, 1500); // off the open path
  }

  Cade.registerWidget({
    name: 'File Converter',
    description: 'Convert video, audio, photos (HEIC), PDF, Word & spreadsheets on this device \u2014 files never leave it',
    icon: '<svg viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'><path d=\'M4 8h13l-3.5-3.5\'/><path d=\'M20 16H7l3.5 3.5\'/></svg>',
    tags: 'convert,converter,file converter,transcode,compress,video,audio,image,photo,heic,heif,jpeg,jpg,png,webp,gif,ico,favicon,svg,mp4,mov,webm,mkv,avi,mp3,m4a,aac,wav,flac,ogg,opus,extract audio,pdf,pdf to text,pdf to png,images to pdf,docx,word,markdown,html,xlsx,excel,csv,tsv,json,ods,ffmpeg,offline,private',
    open: open,
    // Pure helpers for node checks (unused at runtime).
    _test: {
      sniffBytes: sniffBytes, zipNames: zipNames, zipKindFromNames: zipKindFromNames, imageDims: imageDims, parseTime: parseTime,
      fmtBytes: fmtBytes, fmtClock: fmtClock, etaText: etaText, buildFfArgs: buildFfArgs, ffOptions: ffOptions, splitArgs: splitArgs,
      joinArgs: joinArgs, buildIco: buildIco, targetsFor: targetsFor, defaultTarget: defaultTarget, defaultPreset: defaultPreset,
      planFor: planFor, fitSize: fitSize, baseOf: baseOf, outName: outName, ASSETS: ASSETS, T: T,
    },
  });
})();
