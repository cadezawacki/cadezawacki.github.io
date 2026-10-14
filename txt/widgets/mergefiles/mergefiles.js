/* Merge Files — combine many text files into ONE document.
 *
 * Pick files, a folder, or drop files and folders onto the panel; picks
 * accumulate. An optional type filter ("csv, txt"; chips for the types in the
 * selection), an order (natural path sort, name, size, modified, picked, or
 * by hand), join options (nothing / new line / blank line / a header line
 * from a template / Import-style fenced blocks; trim each file's end; CRLF →
 * LF; CSV mode keeps one header row; drop duplicate lines), a preview with
 * totals, and a destination: append to the note or insert at the cursor (one
 * editor transaction = one Undo), a new note, a download, or the clipboard.
 *
 * Robustness follows the core's Import Files / Import Folder (own copies —
 * txt.html is untouched): directory entries are read in batches until empty,
 * binary files are recognised by name / type and by sniffing their first
 * bytes, text is decoded BOM → UTF-8 → Windows-1252, every file has a size
 * cap and the merge a total cap, and a FileList is copied before its input is
 * reset. Everything that is left out is counted and listed with the reason.
 *
 * Performance: nothing runs until the widget opens. Planning never reads a
 * byte. Files are read only for a preview or a merge, a few at a time, and
 * each file's text is kept while the panel is open so changing an option
 * re-joins without re-reading. Closing drops every File reference, the text,
 * the timers and the listeners (all on the panel). Prefs — never contents —
 * live in Cade.store under cade-mergefiles-.
 *
 * The DOM-free model below (filter parsing, natural sort + ordering, header
 * templates, CSV header merging, newline normalisation, duplicate removal,
 * the join, size-cap accounting, sniffing/decoding bytes, names) is exported
 * for mergefiles.test.js (node). */
(function () {
  'use strict';

  // =========================================================================
  // Pure model (no DOM)
  // =========================================================================
  var MB = 1048576;
  var CAPS = { perFile: 5 * MB, total: 20 * MB };
  var SNIFF_BYTES = 8192;
  // Same lists as the core's Import (txt.html). A known text extension is read
  // without a sniff; a known binary container is never read at all.
  var TEXT_EXT_RE = /\.(txt|md|markdown|json|csv|tsv|log|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|hpp|cs|css|scss|less|html?|xml|yml|yaml|toml|ini|cfg|conf|sh|bat|ps1|sql)$/i;
  var BINARY_EXT_RE = /\.(png|jpe?g|gif|bmp|webp|avif|ico|tiff?|heic|heif|mp3|wav|flac|ogg|oga|m4a|aac|opus|mid|midi|mp4|m4v|mov|avi|mkv|webm|wmv|mpe?g|pdf|docx?|xlsx?|pptx?|odt|ods|odp|pages|numbers|zip|gz|bz2|xz|zst|7z|rar|tar|tgz|jar|war|apk|ipa|dmg|iso|deb|rpm|exe|dll|so|dylib|bin|class|pyc|pyo|wasm|db|sqlite\d?|mdb|accdb|psd|indd|sketch|blend|ttf|otf|woff2?|eot)$/i;
  var SEPS = ['none', 'newline', 'blank', 'header', 'fence'];
  var ORDERS = ['path', 'name', 'size', 'mtime', 'picked', 'custom'];
  var TOKENS_RE = /\{(name|path|ext|stem|index|total|size)\}/g;

  function str(v) { return v == null ? '' : String(v); }
  function baseName(p) { p = str(p); var i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
  function dirName(p) { p = str(p); var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }
  // Like node's path.extname: ".gitignore" has none, "a.tar.gz" is "gz".
  function extOf(name) {
    var b = baseName(name), dot = b.lastIndexOf('.');
    return dot <= 0 || dot === b.length - 1 ? '' : b.slice(dot + 1).toLowerCase();
  }
  function stemOf(name) { var b = baseName(name), x = extOf(b); return x ? b.slice(0, b.length - x.length - 1) : b; }
  function capLabel(n) { return n % MB === 0 ? n / MB + ' MB' : fmtBytes(n); }
  function fmtBytes(n) {
    if (!(n >= 0)) return '';
    if (n < 1024) return n + ' B';
    if (n < MB) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / MB).toFixed(1) + ' MB';
  }
  function normPath(p) { return str(p).replace(/\\/g, '/').replace(/^(\.\/|\/)+/, ''); }

  // ---- binary / text recognition (ports of the core's sniffer) ---------------
  // A known text extension wins over the MIME type: Windows reports .csv as
  // application/vnd.ms-excel wherever Excel is installed.
  function isKnownBinary(name, type) {
    if (TEXT_EXT_RE.test(str(name))) return false;
    var t = str(type);
    if (/^(image|audio|video)\//.test(t) && t.indexOf('svg') < 0) return true;
    if (/(pdf|zip|gzip|x-tar|x-7z|x-rar|msword|ms-excel|ms-powerpoint|officedocument|^font\/|x-font)/.test(t)) return true;
    return BINARY_EXT_RE.test(str(name));
  }
  function isTextName(name, type) { return TEXT_EXT_RE.test(str(name)) || /^text\//.test(str(type)); }
  function bomKind(b) {
    if (b.length >= 4) {
      if (b[0] === 0xFF && b[1] === 0xFE && b[2] === 0 && b[3] === 0) return 'utf-32le';
      if (b[0] === 0 && b[1] === 0 && b[2] === 0xFE && b[3] === 0xFF) return 'utf-32be';
    }
    if (b.length >= 2) {
      if (b[0] === 0xFF && b[1] === 0xFE) return 'utf-16le';
      if (b[0] === 0xFE && b[1] === 0xFF) return 'utf-16be';
    }
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return 'utf-8';
    return '';
  }
  // Drop a trailing UTF-8 sequence the sample window cut in half (and only that).
  function trimPartialUtf8(b) {
    for (var i = b.length - 1; i >= 0 && i > b.length - 5; i--) {
      var c = b[i], need = 0;
      if ((c & 0xC0) === 0x80) continue;
      if ((c & 0x80) === 0) need = 1;
      else if ((c & 0xE0) === 0xC0) need = 2;
      else if ((c & 0xF0) === 0xE0) need = 3;
      else if ((c & 0xF8) === 0xF0) need = 4;
      else return b;
      return need > b.length - i ? b.subarray(0, i) : b;
    }
    return b;
  }
  // Do the first bytes of a file (head of a `fileSize`-byte file) look like text?
  function sniffText(head, fileSize) {
    var n = head.length;
    if (!n) return true;
    var bom = bomKind(head);
    if (bom === 'utf-16le' || bom === 'utf-16be') return true;
    if (bom === 'utf-32le' || bom === 'utf-32be') return false;
    var ctrl = 0, high = 0, dead = 0;
    for (var i = 0; i < n; i++) {
      var c = head[i];
      if (c === 0) return false;
      if (c < 9 || (c > 13 && c < 32) || c === 127) ctrl++;
      else if (c > 127) {
        high++;
        if (c === 0x81 || c === 0x8D || c === 0x8F || c === 0x90 || c === 0x9D) dead++;
      }
    }
    if (ctrl / n > 0.02) return false;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(n < (fileSize == null ? n : fileSize) ? trimPartialUtf8(head) : head);
      return true;
    } catch (e) {
      return dead === 0 && high / n < 0.4;   // legacy single-byte text (Windows-1252)
    }
  }
  // A known text extension skips the sniff (as in the core) but a NUL byte or a
  // UTF-32 mark in its head still means it isn't text we can paste.
  function plainlyBinary(bytes) {
    var bom = bomKind(bytes);
    if (bom === 'utf-16le' || bom === 'utf-16be') return false;
    if (bom === 'utf-32le' || bom === 'utf-32be') return true;
    for (var i = 0, n = Math.min(bytes.length, SNIFF_BYTES); i < n; i++) if (bytes[i] === 0) return true;
    return false;
  }
  function decodeBytes(bytes) {
    var bom = bomKind(bytes);
    if (bom === 'utf-16le' || bom === 'utf-16be') return new TextDecoder(bom).decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) { return new TextDecoder('windows-1252').decode(bytes); }
  }

  // ---- type filter --------------------------------------------------------------
  // "csv, .TXT; *.md !log (none)" → { inc: ['csv','txt','md','(none)'→''], exc: ['log'] }
  function parseFilter(s) {
    var inc = [], exc = [];
    str(s).split(/[\s,;|]+/).forEach(function (tok) {
      if (!tok) return;
      var neg = tok.charAt(0) === '!' || tok.charAt(0) === '-';
      if (neg) tok = tok.slice(1);
      tok = tok.toLowerCase();
      var x;
      if (tok === '(none)' || tok === '(noext)') x = '';
      else {
        x = tok.replace(/^\*+/, '').replace(/^\.+/, '').replace(/\.+$/, '');
        if (!x || /[\/\\*?"<>]/.test(x)) return;
      }
      var list = neg ? exc : inc;
      if (list.indexOf(x) < 0) list.push(x);
    });
    return { inc: inc, exc: exc };
  }
  function extLabel(x) { return x === '' ? '(none)' : x; }
  function formatFilter(f) {
    return f.inc.map(extLabel).concat(f.exc.map(function (x) { return '!' + extLabel(x); })).join(', ');
  }
  function hasExt(name, x) {
    var b = baseName(name).toLowerCase();
    if (x === '') return extOf(b) === '';
    return b.length > x.length + 1 && b.slice(b.length - x.length - 1) === '.' + x;
  }
  function passesFilter(name, f) {
    if (!f) return true;
    var i;
    for (i = 0; i < f.exc.length; i++) if (hasExt(name, f.exc[i])) return false;
    if (!f.inc.length) return true;
    for (i = 0; i < f.inc.length; i++) if (hasExt(name, f.inc[i])) return true;
    return false;
  }
  // A chip tap: add the type to the "only these" list, or take it out.
  function toggleFilterExt(s, x) {
    var f = parseFilter(s), at = f.inc.indexOf(x);
    if (at >= 0) f.inc.splice(at, 1);
    else {
      f.inc.push(x);
      var ex = f.exc.indexOf(x);
      if (ex >= 0) f.exc.splice(ex, 1);
    }
    return formatFilter(f);
  }
  // [{ext, n}] for the chips, most common first. `skip(e)` leaves files out.
  function extCounts(entries, skip) {
    var m = {}, out = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (skip && skip(e)) continue;
      var x = extOf(e.name || e.path);
      m['.' + x] = (m['.' + x] || 0) + 1;
    }
    for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) out.push({ ext: k.slice(1), n: m[k] });
    out.sort(function (a, b) { return b.n - a.n || (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0); });
    return out;
  }

  // ---- natural order -------------------------------------------------------------
  // Digit runs compare as numbers (file2 < file10, any length), letters without
  // case, and "/" sorts before every other character so a folder's files stay
  // together ("dir/x" < "dir-2/x"). Ties: fewer leading zeros, then raw case.
  function natCmpLower(a, b) {
    var i = 0, j = 0, la = a.length, lb = b.length, tie = 0;
    while (i < la && j < lb) {
      var ca = a.charCodeAt(i), cb = b.charCodeAt(j);
      var da = ca >= 48 && ca <= 57, db = cb >= 48 && cb <= 57;
      if (da && db) {
        var ei = i, ej = j;
        while (ei < la && (a.charCodeAt(ei) >= 48 && a.charCodeAt(ei) <= 57)) ei++;
        while (ej < lb && (b.charCodeAt(ej) >= 48 && b.charCodeAt(ej) <= 57)) ej++;
        var zi = i, zj = j;
        while (zi < ei - 1 && a.charCodeAt(zi) === 48) zi++;
        while (zj < ej - 1 && b.charCodeAt(zj) === 48) zj++;
        if (ei - zi !== ej - zj) return (ei - zi) - (ej - zj);
        for (var k = 0; k < ei - zi; k++) {
          var d = a.charCodeAt(zi + k) - b.charCodeAt(zj + k);
          if (d) return d;
        }
        if (!tie) tie = (ei - i) - (ej - j);
        i = ei; j = ej;
        continue;
      }
      if (ca === 47) ca = 0;
      if (cb === 47) cb = 0;
      if (ca !== cb) return ca - cb;
      i++; j++;
    }
    return (la - i) - (lb - j) || tie;
  }
  function rawCmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  // The same order as a plain string key, so a big list sorts with native
  // string compares: lower case, "/" → U+0000, and every digit run → "0" + a
  // length mark + the digits without leading zeros ("0" sits where digits do,
  // so a run still compares against other characters as a digit would).
  function natKey(s) {
    return str(s).toLowerCase().replace(/\//g, '\u0000').replace(/\d+/g, function (d) {
      var t = d.replace(/^0+(?=\d)/, '');
      return '0' + String.fromCharCode(0x41 + Math.min(t.length, 0xF000)) + t;
    });
  }
  function naturalCompare(a, b) {
    a = str(a); b = str(b);
    return natCmpLower(a.toLowerCase(), b.toLowerCase()) || rawCmp(a, b);
  }
  // Entries: {id, path, name, size, mtime, seq}. `custom` = ids in hand order
  // (others follow in picked order). `desc` flips the chosen key only; ties
  // always fall back to ascending path, then picked order.
  function orderEntries(list, by, desc, custom) {
    var arr = list.slice(), pos = null;
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (e._kp == null) { e._kp = natKey(e.path); e._kn = natKey(e.name || baseName(e.path)); }
    }
    if (by === 'custom') {
      pos = {};
      (custom || []).forEach(function (id, n) { pos[id] = n; });
    }
    function byKey(ka, kb, x, y) { return ka < kb ? -1 : ka > kb ? 1 : naturalCompare(x, y); }
    function byPath(a, b) { return byKey(a._kp, b._kp, a.path, b.path); }
    function cpos(e) { return pos && Object.prototype.hasOwnProperty.call(pos, e.id) ? pos[e.id] : 1e12 + (e.seq || 0); }
    arr.sort(function (a, b) {
      var r;
      if (by === 'custom') return (cpos(a) - cpos(b)) || ((a.seq || 0) - (b.seq || 0));
      if (by === 'name') r = byKey(a._kn, b._kn, a.name, b.name);
      else if (by === 'size') r = (a.size || 0) - (b.size || 0);
      else if (by === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
      else if (by === 'picked') r = (a.seq || 0) - (b.seq || 0);
      else r = byPath(a, b);
      if (r) return desc ? -r : r;
      return byPath(a, b) || ((a.seq || 0) - (b.seq || 0));
    });
    return arr;
  }

  // True when any FOLDER in the path starts with "." (.git, .venv) — the file
  // name itself is not judged, so .eslintrc in a picked project still counts.
  function hasDotDir(p) {
    p = str(p);
    for (var from = 0; ;) {
      var slash = p.indexOf('/', from);
      if (slash < 0) return false;
      if (p.charCodeAt(from) === 46) return true;
      from = slash + 1;
    }
  }

  // ---- the plan (no reading) ------------------------------------------------------
  // What a merge would take, in order, and why everything else stays out.
  // o: { filter (parsed), skipDot, by, desc, custom, perFile, total,
  //      kinds: {id: 'binary'|'error'} learnt while reading }
  // The total cap keeps a prefix of the ordered list: once a file doesn't fit,
  // it and everything after it are left out (no holes in the middle).
  function planMerge(entries, o) {
    o = o || {};
    var f = o.filter || { inc: [], exc: [] }, kinds = o.kinds || {};
    var perFile = o.perFile || CAPS.perFile, total = o.total || CAPS.total;
    var sk = { dot: 0, filtered: 0, binary: [], large: [], over: [], error: [] }, cand = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i], k = kinds[e.id];
      if (o.skipDot && hasDotDir(e.path)) { sk.dot++; continue; }
      if (!passesFilter(e.name || e.path, f)) { sk.filtered++; continue; }
      if (k === 'binary' || isKnownBinary(e.name || e.path, e.type)) { sk.binary.push(e); continue; }
      if (k === 'error') { sk.error.push(e); continue; }
      if ((e.size || 0) > perFile) { sk.large.push(e); continue; }
      cand.push(e);
    }
    var ordered = orderEntries(cand, o.by, !!o.desc, o.custom), files = [], bytes = 0;
    for (var j = 0; j < ordered.length; j++) {
      var x = ordered[j];
      if (sk.over.length || bytes + (x.size || 0) > total) sk.over.push(x);
      else { files.push(x); bytes += x.size || 0; }
    }
    return {
      files: files, bytes: bytes, skipped: sk,
      nSkipped: sk.binary.length + sk.large.length + sk.over.length + sk.error.length,
    };
  }

  // ---- text helpers -----------------------------------------------------------------
  function normalizeNewlines(s) { return s.indexOf('\r') < 0 ? s : s.replace(/\r\n?/g, '\n'); }
  function isWs(c) { return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0xFEFF || c === 0x2028 || c === 0x2029 || c === 0x3000; }
  function trimEndWs(s) { var i = s.length; while (i > 0 && isWs(s.charCodeAt(i - 1))) i--; return i === s.length ? s : s.slice(0, i); }
  function stripLeadingBreaks(s) { var i = 0; while (i < s.length && (s.charCodeAt(i) === 10 || s.charCodeAt(i) === 13)) i++; return i ? s.slice(i) : s; }
  function countLines(s) {
    if (!s) return 0;
    var n = 0, i = -1;
    while ((i = s.indexOf('\n', i + 1)) >= 0) n++;
    return s.charCodeAt(s.length - 1) === 10 ? n : n + 1;
  }
  // A file's own ``` would close its fence early: the core's reversible escape.
  function escapeFences(s) { return s.replace(/(\\*)```/g, '\\$1```'); }
  function renderHeader(tpl, info, eol) {
    var s = str(tpl).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(TOKENS_RE, function (m, k) {
      if (k === 'name') return str(info.name);
      if (k === 'path') return str(info.path);
      if (k === 'ext') return str(info.ext);
      if (k === 'stem') return str(info.stem);
      if (k === 'index') return String(info.index);
      if (k === 'total') return String(info.total);
      return fmtBytes(info.size);
    });
    return eol && eol !== '\n' ? s.replace(/\n/g, eol) : s;
  }
  function mkSet() {
    if (typeof Set === 'function') return new Set();
    var o = Object.create(null);
    return { has: function (k) { return o[k] === 1; }, add: function (k) { o[k] = 1; } };
  }
  // Drop lines already seen (in any file); blank lines always stay, so the
  // separators and paragraph breaks survive. A trailing \r is not part of a line's identity.
  function dedupeLines(t, seen, st) {
    if (!t) return t;
    var lines = t.split('\n'), out = [];
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i], key = L.charCodeAt(L.length - 1) === 13 ? L.slice(0, -1) : L;
      if (!/\S/.test(key)) { out.push(L); continue; }
      if (seen.has(key)) { st.dupes++; continue; }
      seen.add(key); out.push(L);
    }
    return out.join('\n');
  }

  // ---- CSV ---------------------------------------------------------------------------
  // 'csv' | 'tsv' | 'mixed' when every part is .csv/.tsv, else ''.
  function csvKind(parts) {
    if (!parts.length) return '';
    var c = 0, t = 0;
    for (var i = 0; i < parts.length; i++) {
      var x = extOf(parts[i].name || parts[i].path);
      if (x === 'csv') c++; else if (x === 'tsv') t++; else return '';
    }
    return !t ? 'csv' : !c ? 'tsv' : 'mixed';
  }
  // End of the first record (a quoted cell may hold line breaks): index of its
  // "\n", or -1 when the whole text is one record.
  function firstRecordEnd(s) {
    var q = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 34) q = !q;
      else if (c === 10 && !q) return i;
    }
    return -1;
  }
  // Header cells, unquoted and trimmed, so `"a", b` and `a,b` are the same header.
  function csvHeaderKey(line, delim) {
    var cells = [], cur = '', q = false;
    line = str(line).replace(/\r$/, '');
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (q) {
        if (ch === '"') { if (line.charAt(i + 1) === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    return cells.join('\u0000');
  }
  // Records split outside quotes (each keeps any \r), for duplicate removal.
  function dedupeRecords(t, seen, st) {
    var out = [], start = 0, q = false;
    function take(rec) {
      var key = rec.charCodeAt(rec.length - 1) === 13 ? rec.slice(0, -1) : rec;
      if (!/\S/.test(key)) { out.push(rec); return; }
      if (seen.has(key)) { st.dupes++; return; }
      seen.add(key); out.push(rec);
    }
    for (var i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i);
      if (c === 34) q = !q;
      else if (c === 10 && !q) { take(t.slice(start, i)); start = i + 1; }
    }
    take(t.slice(start));
    return out.join('\n');
  }

  // ---- the join --------------------------------------------------------------------------
  // parts: [{name, path, size, text}] in merge order.
  // o: { sep, template, trimEnd, normalizeEol, csv, dedupe }
  // → { text, stats: { files, lines, chars, eol, csv, csvKind, csvMismatch[],
  //                    csvHeadersDropped, csvEmpty, dupes } }
  function mergeTexts(parts, o) {
    o = o || {};
    var sep = SEPS.indexOf(o.sep) >= 0 ? o.sep : 'newline';
    var norm = o.normalizeEol !== false, texts = [], crlf = 0, i, t;
    for (i = 0; i < parts.length; i++) {
      t = str(parts[i].text);
      if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
      if (norm) t = normalizeNewlines(t);
      else if (t.indexOf('\r\n') >= 0) crlf++;
      texts.push(t);
    }
    // Kept CRLF files: separators follow what most of them use.
    var eol = !norm && crlf * 2 > parts.length ? '\r\n' : '\n';
    var st = { files: parts.length, lines: 0, chars: 0, eol: eol, csv: false, csvKind: '', csvMismatch: [], csvHeadersDropped: 0, csvEmpty: 0, dupes: 0 };
    var seen = o.dedupe ? mkSet() : null, out = '';
    var kind = o.csv ? csvKind(parts) : '';

    if (kind) {
      // CSV: one row per line, the first file's header once. A file whose
      // header differs keeps it (and is reported) so the change stays visible.
      st.csv = true; st.csvKind = kind;
      var pieces = [], firstKey = null;
      for (i = 0; i < texts.length; i++) {
        t = trimEndWs(stripLeadingBreaks(texts[i]));
        if (!t) { st.csvEmpty++; continue; }
        var delim = extOf(parts[i].name || parts[i].path) === 'tsv' ? '\t' : ',';
        var end = firstRecordEnd(t), head = end < 0 ? t : t.slice(0, end);
        var key = delim + csvHeaderKey(head, delim), body = t;
        if (firstKey === null) {
          firstKey = key;
          if (seen) seen.add(head.replace(/\r$/, ''));
          if (seen && end >= 0) body = head + '\n' + dedupeRecords(t.slice(end + 1), seen, st);
        } else if (key === firstKey) {
          st.csvHeadersDropped++;
          body = end < 0 ? '' : t.slice(end + 1);
          if (seen && body) body = dedupeRecords(body, seen, st);
        } else {
          st.csvMismatch.push(parts[i].path || parts[i].name);
          if (seen) body = dedupeRecords(t, seen, st);
        }
        body = trimEndWs(body);
        if (body) pieces.push(body);
      }
      out = pieces.length ? pieces.join(eol) + eol : '';
    } else {
      var buf = [], tail = '', any = false, n = parts.length;
      var push = function (s) {
        if (!s) return;
        buf.push(s); any = true;
        tail = s.length >= 4 ? s.slice(-4) : (tail + s).slice(-4);
      };
      var endsNl = function () { return tail.charCodeAt(tail.length - 1) === 10; };
      var ensureBlank = function () {
        if (!endsNl()) push(eol + eol);
        else if (!/\n\r?\n$/.test(tail)) push(eol);
      };
      for (i = 0; i < n; i++) {
        var p = parts[i];
        t = texts[i];
        if (o.trimEnd) t = trimEndWs(t);
        if (seen) t = dedupeLines(t, seen, st);
        if (sep === 'fence') {
          push(str(p.path || p.name) + eol + '```' + eol + escapeFences(t) + eol + '```' + eol + eol);
          continue;
        }
        if (sep === 'header') {
          if (any) ensureBlank();
          var nm = str(p.name || baseName(p.path));
          push(renderHeader(o.template, { name: nm, path: str(p.path || nm), ext: extOf(nm), stem: stemOf(nm), index: i + 1, total: n, size: p.size || 0 }, eol) + eol);
          push(t);
          continue;
        }
        if (any && t) {
          if (sep === 'newline') { if (!endsNl()) push(eol); }
          else if (sep === 'blank') ensureBlank();
        }
        push(t);
      }
      if (any && sep !== 'none' && sep !== 'fence' && !endsNl()) push(eol);
      out = buf.join('');
    }
    st.lines = countLines(out);
    st.chars = out.length;
    return { text: out, stats: st };
  }

  // ---- names ---------------------------------------------------------------------------------
  // A note name the room system (and its Firebase paths) accept: lower case,
  // no . # $ [ ] / \ or control characters, ≤ 100 chars, not starting "__".
  function toRoomName(s) {
    var n = str(s).toLowerCase().replace(/[.#$\[\]\/\\\u0000-\u001f\u007f]+/g, '-')
      .replace(/\s+/g, ' ').replace(/-{2,}/g, '-').replace(/^[\s\-_]+|[\s\-]+$/g, '');
    return n.slice(0, 100).replace(/[\s\-]+$/, '');
  }
  function uniqueName(base, taken) {
    var have = {};
    (taken || []).forEach(function (x) { have[x] = 1; });
    if (!have[base]) return base;
    for (var i = 2; i < 1000; i++) {
      var suf = ' ' + i, c = base.slice(0, 100 - suf.length) + suf;
      if (!have[c]) return c;
    }
    return base + ' ' + Date.now();
  }
  function safeFileName(name, ext, fallback) {
    var b = str(name).replace(/[\/\\:*?"<>|\u0000-\u001f\u007f]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
    var x = str(ext).toLowerCase().replace(/^\.+/, '').replace(/[^a-z0-9_\-]+/g, '');
    if (x && b.toLowerCase().slice(-(x.length + 1)) === '.' + x) b = b.slice(0, -(x.length + 1));
    b = (b || str(fallback) || 'merged').slice(0, 120);
    return x ? b + '.' + x : b;
  }
  // The extension a download gets unless one is typed.
  function suggestExt(parts, o) {
    o = o || {};
    var k = o.csv ? csvKind(parts) : '';
    if (k === 'csv' || k === 'tsv') return k;
    if (o.sep === 'fence') return 'md';
    var x = null;
    for (var i = 0; i < parts.length; i++) {
      var e = extOf(parts[i].name || parts[i].path);
      if (x === null) x = e; else if (x !== e) return 'txt';
    }
    return x && /^[a-z0-9]{1,8}$/.test(x) ? x : 'txt';
  }
  function mimeFor(ext) {
    var m = { csv: 'text/csv', tsv: 'text/tab-separated-values', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json', html: 'text/html', htm: 'text/html', xml: 'application/xml' };
    return (m[str(ext).toLowerCase()] || 'text/plain') + ';charset=utf-8';
  }
  // Cut for a preview without splitting a surrogate pair.
  function clip(s, n) {
    if (s.length <= n) return s;
    var c = s.charCodeAt(n - 1);
    return s.slice(0, c >= 0xD800 && c <= 0xDBFF ? n - 1 : n);
  }

  var Model = {
    CAPS: CAPS, SEPS: SEPS, ORDERS: ORDERS, TEXT_EXT_RE: TEXT_EXT_RE,
    baseName: baseName, dirName: dirName, extOf: extOf, stemOf: stemOf, fmtBytes: fmtBytes, capLabel: capLabel, normPath: normPath,
    isKnownBinary: isKnownBinary, isTextName: isTextName, bomKind: bomKind, sniffText: sniffText,
    plainlyBinary: plainlyBinary, decodeBytes: decodeBytes,
    parseFilter: parseFilter, formatFilter: formatFilter, passesFilter: passesFilter, toggleFilterExt: toggleFilterExt,
    extCounts: extCounts, naturalCompare: naturalCompare, natKey: natKey, orderEntries: orderEntries, hasDotDir: hasDotDir,
    planMerge: planMerge, normalizeNewlines: normalizeNewlines, trimEndWs: trimEndWs, countLines: countLines,
    escapeFences: escapeFences, renderHeader: renderHeader, dedupeLines: dedupeLines, csvKind: csvKind,
    csvHeaderKey: csvHeaderKey, mergeTexts: mergeTexts, toRoomName: toRoomName, uniqueName: uniqueName,
    safeFileName: safeFileName, suggestExt: suggestExt, mimeFor: mimeFor, clip: clip,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Model;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // =========================================================================
  // Panel
  // =========================================================================
  var Cade = window.Cade;
  Cade.loadCSS('mergefiles.css');

  var PANEL_ID = 'mergefiles-panel';
  var PREFS_KEY = 'cade-mergefiles-prefs';
  var CONCURRENCY = 6;         // parallel reads (the core's import uses 8)
  var PREVIEW_CHARS = 2000;
  var LIST_STEP = 100;         // rows shown, then "show more"
  var MANUAL_MAX = 50;         // ↑ ↓ buttons only on lists this small
  var CHIPS_MAX = 12;
  var READY_MS = 900;          // a download later than this after the tap waits for a second tap (iOS)

  var DEF = { filter: '', by: 'path', desc: false, sep: 'newline', tpl: '--- {name} ---', trim: true, eol: true, csv: true, dedupe: false, dot: true, dest: 'append', ext: '' };
  var DESTS = ['append', 'cursor', 'room', 'file'];
  var prefs = {};
  var S = null;                // panel state; null while closed

  function loadPrefs() {
    var p = {};
    try { p = JSON.parse(Cade.store.get(PREFS_KEY) || 'null') || {}; } catch (e) { p = {}; }
    for (var k in DEF) prefs[k] = p[k] !== undefined && typeof p[k] === typeof DEF[k] ? p[k] : DEF[k];
    if (ORDERS.indexOf(prefs.by) < 0 || prefs.by === 'custom') prefs.by = DEF.by;
    if (SEPS.indexOf(prefs.sep) < 0) prefs.sep = DEF.sep;
    if (DESTS.indexOf(prefs.dest) < 0) prefs.dest = DEF.dest;
  }
  function savePrefs() {
    var p = {};
    for (var k in DEF) p[k] = prefs[k];
    if (p.by === 'custom') p.by = S && S.prevBy ? S.prevBy : DEF.by; // a hand order belongs to one selection
    try { Cade.store.set(PREFS_KEY, JSON.stringify(p)); } catch (e) {}
  }

  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2200); } catch (e) {} }
  function esc(s) { return Cade.escapeHtml(str(s)); }
  function q(sel) { return S ? S.el.querySelector(sel) : null; }
  function plural(n, w, ws) { return n.toLocaleString() + ' ' + (n === 1 ? w : (ws || w + 's')); }
  function stopErr() { var e = new Error('Stopped'); e.stopped = true; return e; }
  function coarse() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }

  // ---- selection ----------------------------------------------------------------------
  function addFiles(list) {
    if (!S || !list.length) return;
    var added = 0, dup = 0;
    for (var i = 0; i < list.length; i++) {
      var f = list[i].file, path = normPath(list[i].path || f.name);
      if (!path) continue;
      var key = path + '\u0000' + f.size + '\u0000' + (f.lastModified || 0);
      if (S.keys[key]) { dup++; continue; }
      var e = { id: ++S.nextId, file: f, path: path, name: baseName(path), type: f.type || '', size: f.size || 0, mtime: f.lastModified || 0, seq: ++S.seq, key: key };
      S.keys[key] = e;
      S.entries.push(e);
      added++;
    }
    if (added) S.ver++;
    if (added) { S.ready = null; changed(true); }
    if (dup) toast(plural(dup, 'file') + ' already in the list — skipped', 'info', 1800);
  }
  function dropEntry(e) {
    delete S.keys[e.key];
    S.texts.delete(e.id);
    delete S.kinds[e.id];
    e.file = null;
  }
  function removeEntry(id) {
    var keep = [];
    for (var i = 0; i < S.entries.length; i++) {
      var e = S.entries[i];
      if (e.id === id) dropEntry(e); else keep.push(e);
    }
    S.entries = keep;
    if (S.custom) S.custom = S.custom.filter(function (x) { return x !== id; });
    S.ver++;
    changed(true);
  }
  function clearAll() {
    S.entries.forEach(dropEntry);
    S.entries = []; S.keys = {}; S.texts.clear(); S.kinds = {}; S.custom = null; S.built = null; S.showN = LIST_STEP; S.ver++;
    if (prefs.by === 'custom') prefs.by = S.prevBy || DEF.by;
    changed(true);
  }
  function rootsOf() {
    var r = {}, n = 0, name = '';
    for (var i = 0; i < S.entries.length; i++) {
      var p = S.entries[i].path, s = p.indexOf('/');
      var top = s > 0 ? p.slice(0, s) : '';
      if (!Object.prototype.hasOwnProperty.call(r, top)) { r[top] = 1; n++; name = top; }
    }
    return n === 1 ? name : '';
  }

  // ---- picking --------------------------------------------------------------------------
  function pick(sel) {
    var inp = q(sel);
    if (!inp || S.scanning) return;
    inp.value = '';
    inp.click();
  }
  function onPicked(e) {
    var inp = e.target;
    // Copy BEFORE resetting: input.files is live, clearing the value empties it.
    var files = Array.prototype.slice.call(inp.files || []);
    inp.value = '';
    addFiles(files.map(function (f) { return { file: f, path: f.webkitRelativePath || f.name }; }));
  }
  // readEntries() returns ~100 entries per call: keep asking until it's empty.
  function walk(entry, prefix, out, st) {
    return new Promise(function (resolve) {
      if (!entry || S !== st) { resolve(); return; }
      if (entry.isFile) {
        entry.file(function (f) {
          out.push({ file: f, path: prefix + entry.name });
          if (S === st && (out.length & 255) === 0) { st.scanFound = out.length; renderSum(); }
          resolve();
        }, function () { resolve(); });
        return;
      }
      if (!entry.isDirectory) { resolve(); return; }
      var dir = prefix + entry.name + '/', reader = entry.createReader();
      (function batch() {
        reader.readEntries(function (list) {
          if (!list || !list.length || S !== st) { resolve(); return; }
          var p = Promise.resolve();
          Array.prototype.forEach.call(list, function (en) { p = p.then(function () { return walk(en, dir, out, st); }); });
          p.then(batch, batch);
        }, function () { resolve(); });
      })();
    });
  }
  function acceptDrop(dt) {
    if (!S || !dt) return;
    // Entries and files must be taken now: the DataTransfer dies with the event.
    var entries = [], files = Array.prototype.slice.call(dt.files || []), items = dt.items || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.kind !== 'file') continue;
      var en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
      if (en) entries.push(en);
    }
    if (!entries.length) {
      addFiles(files.map(function (f) { return { file: f, path: f.webkitRelativePath || f.name }; }));
      return;
    }
    var st = S, out = [];
    st.scanning++; st.scanFound = 0;
    renderSum();
    var p = Promise.resolve();
    entries.forEach(function (en) { p = p.then(function () { return walk(en, '', out, st); }); });
    p.then(function () {
      if (S !== st) return;
      st.scanning--;
      if (out.length) addFiles(out);
      else { renderSum(); toast('Nothing to add — the drop held no files', 'info'); }
    });
  }
  function hasFiles(e) {
    var t = e.dataTransfer && e.dataTransfer.types;
    if (!t) return false;
    for (var i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
    return false;
  }

  // ---- plan + build ---------------------------------------------------------------------------
  function optSig() { return [prefs.sep, prefs.tpl, prefs.trim, prefs.eol, prefs.csv, prefs.dedupe].join('\u0001'); }
  function mergeOpts() {
    return { sep: prefs.sep, template: prefs.tpl, trimEnd: prefs.trim, normalizeEol: prefs.eol, csv: prefs.csv, dedupe: prefs.dedupe };
  }
  // The plan depends on the selection (S.ver), the filter, dot-folders and the
  // order — not on the join options, which only re-join.
  function planKey() { return [S.ver, prefs.filter, prefs.dot, prefs.by, prefs.desc].join('\u0001'); }
  function replan() {
    var k = planKey();
    if (S.plan && S.planKey === k) return;
    S.planKey = k;
    S.plan = planMerge(S.entries, {
      filter: parseFilter(prefs.filter), skipDot: prefs.dot, by: prefs.by, desc: prefs.desc,
      custom: S.custom, kinds: S.kinds,
    });
    S.planSig = S.plan.files.map(function (e) { return e.id; }).join(',');
  }
  function sig() { return S.planSig + '\u0002' + optSig(); }
  function fresh() { return S && S.built && S.built.sig === sig() ? S.built : null; }

  function blobBytes(b) {
    if (b.arrayBuffer) return b.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(new Uint8Array(r.result)); };
      r.onerror = function () { rej(r.error || new Error('read failed')); };
      r.readAsArrayBuffer(b);
    });
  }
  // → {kind:'text', text} | {kind:'binary'} | {kind:'error'}
  function readOne(e) {
    var f = e.file, known = isTextName(e.name, e.type);
    if (!f) return Promise.resolve({ kind: 'error' });
    var gate = known ? Promise.resolve(true) : blobBytes(f.slice(0, Math.min(f.size, SNIFF_BYTES))).then(function (h) { return sniffText(h, f.size); });
    return gate.then(function (ok) {
      if (!ok) return { kind: 'binary' };
      return blobBytes(f).then(function (bytes) {
        if (known && plainlyBinary(bytes)) return { kind: 'binary' };
        return { kind: 'text', text: decodeBytes(bytes) };
      });
    }).then(null, function () { return { kind: 'error' }; });
  }
  // Read whatever the CURRENT plan still lacks — re-planning after each pass,
  // since a file found to be binary frees room under the total cap — until
  // every planned file is in the cache. One loop at a time; callers share it.
  function ensureRead() {
    if (S.reading) return S.reading;
    var st = S;
    st.stopReq = false;
    var loop = function () {
      if (S !== st) return Promise.reject(stopErr());
      if (st.stopReq) return Promise.reject(stopErr());
      replan();
      var need = st.plan.files.filter(function (e) { return !st.texts.has(e.id); });
      if (!need.length) return Promise.resolve();
      return readMany(st, need).then(loop);
    };
    // Started on a microtask so S.reading is set before the first progress paint.
    st.reading = Promise.resolve().then(loop).then(function () {
      if (S === st) { st.reading = null; progress(null); }
    }, function (err) {
      if (S === st) { st.reading = null; progress(null); }
      throw err;
    });
    return st.reading;
  }
  function readMany(st, list) {
    var total = list.length, next = 0, done = 0, active = 0, binHit = false, painted = Date.now();
    st.readDone = 0; st.readTotal = total;
    progress(0);
    return new Promise(function (resolve, reject) {
      var pump = function () {
        if (S !== st || st.stopReq) { if (!active) reject(stopErr()); return; }
        while (active < CONCURRENCY && next < total) {
          var e = list[next++];
          active++;
          readOne(e).then(function (r) {
            active--; done++;
            if (S !== st) { pump(); return; }
            if (r.kind === 'text') { if (this.file) st.texts.set(this.id, r.text); }
            else { st.kinds[this.id] = r.kind; st.ver++; binHit = true; }
            st.readDone = done;
            if (done === total || Date.now() - painted > 100) { painted = Date.now(); progress(done / total); }
            if (done === total) { if (binHit) changed(false); resolve(); } else pump();
          }.bind(e));
        }
      };
      pump();
    });
  }
  // Join the cached texts for the current plan (reading only what's missing).
  function runBuild() {
    var st = S;
    if (fresh()) return Promise.resolve(S.built);
    return ensureRead().then(function () {
      if (S !== st) throw stopErr();
      var s = sig();
      if (st.built && st.built.sig === s) return st.built;
      var parts = st.plan.files.map(function (e) { return { name: e.name, path: e.path, size: e.size, text: st.texts.get(e.id) || '' }; });
      var r = mergeTexts(parts, mergeOpts());
      st.built = { sig: s, text: r.text, stats: r.stats, files: parts.length, skipped: st.plan.nSkipped, ext: suggestExt(parts, mergeOpts()) };
      prune();
      renderAfterBuild();
      return st.built;
    });
  }
  // Keep the text cache near what the plan needs: texts of files the filter
  // now hides go once the cache passes twice the total cap.
  function prune() {
    var sum = 0, inPlan = {};
    S.plan.files.forEach(function (e) { inPlan[e.id] = 1; });
    S.texts.forEach(function (t) { sum += t.length; });
    if (sum <= 2 * CAPS.total) return;
    S.texts.forEach(function (t, id) { if (!inPlan[id]) S.texts.delete(id); });
  }
  function stop() {
    if (!S || !S.reading) return;
    S.stopReq = true;
    S.previewOpen = false;          // or the next option change would start reading again
    clearTimeout(S.tPrev);
    toast('Stopping…', 'info', 1000);
  }

  // ---- rendering -----------------------------------------------------------------------------
  function changed(selection) {
    if (!S) return;
    if (selection) S.ready = null;
    replan();
    // A stale result can be up to the total cap in size; the per-file texts
    // re-join it in milliseconds, so don't keep both.
    if (S.built && !fresh()) S.built = null;
    if (!fresh()) S.ready = null;
    renderAll();
    schedulePreview();
  }
  function renderAll() {
    renderSum(); renderChips(); renderList(); renderSkips(); renderJoin(); renderPreview(); renderDest();
  }
  function renderSum() {
    if (!S) return;
    var n = S.entries.length, el = q('.mf-sum'), bytes = 0;
    for (var i = 0; i < n; i++) bytes += S.entries[i].size || 0;
    S.el.classList.toggle('mf-has', n > 0);
    q('.mf-clear').hidden = !n;
    if (S.scanning) el.innerHTML = '<span class="mf-spin" aria-hidden="true"></span>Scanning dropped folders… ' + (S.scanFound ? plural(S.scanFound, 'file') : '');
    else if (!n) el.innerHTML = '<span class="mf-muted">Nothing picked yet. Files are read only for a preview or the merge — never uploaded.</span>';
    else el.innerHTML = '<b>' + plural(n, 'file') + '</b> picked <span class="mf-muted">· ' + fmtBytes(bytes) + '</span>';
  }
  function renderChips() {
    var box = q('.mf-chips');
    if (!S.entries.length) { box.innerHTML = ''; return; }
    var f = parseFilter(prefs.filter);
    var list = extCounts(S.entries, function (e) { return (prefs.dot && hasDotDir(e.path)) || isKnownBinary(e.name, e.type) || S.kinds[e.id] === 'binary'; });
    var h = list.slice(0, CHIPS_MAX).map(function (c) {
      var on = f.inc.indexOf(c.ext) >= 0;
      return '<button type="button" class="mf-chip' + (on ? ' on' : '') + '" data-act="chip" data-ext="' + esc(c.ext) + '" aria-pressed="' + on + '" title="' + (on ? 'Stop limiting to ' : 'Only merge ') + esc(c.ext ? '.' + c.ext : 'files without an extension') + '">' +
        esc(c.ext ? '.' + c.ext : '(none)') + ' <span>' + c.n.toLocaleString() + '</span></button>';
    }).join('');
    if (list.length > CHIPS_MAX) h += '<span class="mf-muted mf-chipmore">+' + (list.length - CHIPS_MAX) + ' more types</span>';
    box.innerHTML = h;
  }
  function rowHtml(e, i, manual, n) {
    var d = dirName(e.path);
    return '<div class="mf-row" role="listitem" data-id="' + e.id + '">' +
      '<span class="mf-n">' + (i + 1) + '</span>' +
      '<span class="mf-p" title="' + esc(e.path) + '">' + (d ? '<span class="mf-pd">' + esc(d) + '</span>' : '') + '<span class="mf-pn">' + esc(e.name) + '</span></span>' +
      '<span class="mf-sz">' + fmtBytes(e.size) + '</span><span class="mf-btns">' +
      (manual ? '<button type="button" class="mf-ib" data-act="up" aria-label="Move ' + esc(e.name) + ' up"' + (i ? '' : ' disabled') + '>↑</button>' +
        '<button type="button" class="mf-ib" data-act="down" aria-label="Move ' + esc(e.name) + ' down"' + (i < n - 1 ? '' : ' disabled') + '>↓</button>' : '') +
      '<button type="button" class="mf-ib mf-rm" data-act="rm" aria-label="Remove ' + esc(e.name) + '" title="Remove from the list">×</button>' +
    '</span></div>';
  }
  function renderList() {
    var files = S.plan.files, n = files.length, box = q('.mf-list'), head = q('.mf-listh');
    if (!S.entries.length) { box.innerHTML = ''; head.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false;
    var manual = n > 1 && n <= MANUAL_MAX, shown = Math.min(n, S.showN), h = '';
    for (var i = 0; i < shown; i++) h += rowHtml(files[i], i, manual, n);
    if (!n) h = '<div class="mf-empty">No file to merge — see what was left out below' + (prefs.filter ? ', or change the type filter' : '') + '.</div>';
    else if (shown < n) h += '<div class="mf-more"><span class="mf-muted">Showing ' + shown.toLocaleString() + ' of ' + n.toLocaleString() + '</span> <button type="button" class="mf-link" data-act="more">Show ' + Math.min(LIST_STEP * 2, n - shown).toLocaleString() + ' more</button></div>';
    box.innerHTML = h;
    head.innerHTML = '<b>' + plural(n, 'file') + '</b> to merge <span class="mf-muted">· ' + fmtBytes(S.plan.bytes) + (manual ? ' · ↑↓ to reorder' : '') + '</span>';
  }
  function reasonList(sk) {
    var r = [];
    sk.binary.forEach(function (e) { r.push([e, 'binary']); });
    sk.large.forEach(function (e) { r.push([e, 'over ' + capLabel(CAPS.perFile)]); });
    sk.error.forEach(function (e) { r.push([e, 'unreadable']); });
    sk.over.forEach(function (e) { r.push([e, 'past the ' + capLabel(CAPS.total) + ' total']); });
    return r;
  }
  function renderSkips() {
    var box = q('.mf-skips'), sk = S.plan.skipped, bits = [], quiet = [];
    if (!S.entries.length) { box.innerHTML = ''; return; }
    if (sk.binary.length) bits.push(sk.binary.length.toLocaleString() + ' binary');
    if (sk.large.length) bits.push(sk.large.length.toLocaleString() + ' over ' + capLabel(CAPS.perFile) + ' each');
    if (sk.error.length) bits.push(sk.error.length.toLocaleString() + ' unreadable');
    if (sk.over.length) bits.push(sk.over.length.toLocaleString() + ' past the ' + capLabel(CAPS.total) + ' total');
    if (sk.filtered) quiet.push(plural(sk.filtered, 'file') + ' not matching “' + esc(formatFilter(parseFilter(prefs.filter))) + '”');
    if (sk.dot) quiet.push(plural(sk.dot, 'file') + ' in dot-folders');
    var h = '';
    if (bits.length) {
      var rows = reasonList(sk), MAX = 150;
      h += '<details class="mf-skipd"' + (S.skipOpen ? ' open' : '') + '><summary><b>' + plural(S.plan.nSkipped, 'file') + ' skipped</b> — ' + bits.join(' · ') + '</summary><div class="mf-skiplist">' +
        rows.slice(0, MAX).map(function (r) {
          return '<div class="mf-skrow"><span class="mf-p" title="' + esc(r[0].path) + '"><span class="mf-pn">' + esc(r[0].path) + '</span></span><span class="mf-why">' + esc(r[1]) + ' · ' + fmtBytes(r[0].size) + '</span></div>';
        }).join('') +
        (rows.length > MAX ? '<div class="mf-muted mf-skrow">… and ' + (rows.length - MAX).toLocaleString() + ' more</div>' : '') +
        (sk.binary.length ? '<div class="mf-muted mf-skrow">Binary files (images, archives, PDFs, Office files…) never merge as text.</div>' : '') +
        '</div></details>';
    }
    if (quiet.length) h += '<div class="mf-muted mf-quiet">Left out by choice: ' + quiet.join(' · ') + '</div>';
    box.innerHTML = h;
  }
  function csvActive() { return prefs.csv && !!csvKind(S.plan.files); }
  function renderJoin() {
    var act = csvActive();
    var sep = q('.mf-sep'), tpl = q('.mf-tpl');
    sep.disabled = act; tpl.disabled = act;
    Array.prototype.forEach.call(S.el.querySelectorAll('.mf-tplrow'), function (r) { r.hidden = prefs.sep !== 'header'; });
    var hint = q('.mf-sephint'), hs = '';
    if (act) hs = 'CSV mode decides: one row per line.';
    else if (prefs.sep === 'none' && prefs.trim) hs = 'With “Trim each file’s end”, a file’s last line runs into the next file’s first line.';
    else if (prefs.sep === 'none') hs = 'Exactly like <code>cat</code>: files are joined as they are.';
    else if (prefs.sep === 'fence') hs = 'Each file as its path plus a fenced block — the same format Import uses.';
    hint.innerHTML = hs; hint.hidden = !hs;
    var note = q('.mf-csvnote'), h = '', bad = false;
    note.classList.toggle('mf-idle', prefs.csv && !act);
    if (prefs.csv && S.plan.files.length) {
      var b = fresh();
      if (!act) h = 'CSV mode is idle — not every file is .csv/.tsv.';
      else if (b && b.stats.csv) {
        var s = b.stats;
        if (s.csvMismatch.length) {
          bad = true;
          var one = s.csvMismatch.length === 1;
          h = '⚠ ' + plural(s.csvMismatch.length, 'file has', 'files have') + ' a different header than ' + esc(baseName(S.plan.files[0].path)) + ' — ' + (one ? 'its header row was' : 'their header rows were') + ' kept: ' +
            s.csvMismatch.slice(0, 6).map(function (p) { return '<code>' + esc(p) + '</code>'; }).join(', ') + (s.csvMismatch.length > 6 ? ' …' : '');
        } else h = '✓ Headers match — kept once' + (s.csvHeadersDropped ? ' (' + plural(s.csvHeadersDropped, 'repeat') + ' dropped)' : '') + '.';
        if (s.csvEmpty) h += ' ' + plural(s.csvEmpty, 'empty file') + ' added nothing.';
      } else h = 'CSV mode: rows joined line by line; the header row is kept once when every file has the same one (checked in the preview).';
    }
    note.innerHTML = h; note.hidden = !h;
    note.classList.toggle('mf-bad', bad);
  }
  function statsText() {
    var b = fresh(), p = S.plan;
    if (S.reading) return 'Reading ' + (S.readDone || 0).toLocaleString() + ' / ' + (S.readTotal || 0).toLocaleString() + '…';
    if (!S.entries.length) return '';
    if (!p.files.length) return 'Nothing to merge';
    if (b) {
      var s = b.stats;
      return plural(b.files, 'file') + ' · ' + plural(s.lines, 'line') + ' · ' + plural(s.chars, 'char') + (b.skipped ? ' · ' + b.skipped.toLocaleString() + ' skipped' : '') + (s.dupes ? ' · ' + plural(s.dupes, 'duplicate') + ' dropped' : '');
    }
    return plural(p.files.length, 'file') + ' · ' + fmtBytes(p.bytes) + ' to read' + (p.nSkipped ? ' · ' + p.nSkipped.toLocaleString() + ' skipped' : '');
  }
  function renderPreview() {
    var stats = q('.mf-stats'), pre = q('.mf-prev'), more = q('.mf-prevmore'), b = fresh();
    stats.textContent = statsText();
    q('.mf-stop').hidden = !S.reading;
    q('.mf-pv').textContent = S.previewOpen ? 'Hide preview' : 'Preview';
    q('.mf-pv').disabled = !S.plan.files.length && !S.previewOpen;
    var show = S.previewOpen && S.entries.length > 0;
    pre.hidden = !show; more.hidden = true;
    if (!show) return;
    if (b) {
      pre.classList.remove('stale');
      pre.textContent = b.text ? clip(b.text, PREVIEW_CHARS) : '';
      pre.classList.toggle('empty', !b.text);
      if (b.text.length > PREVIEW_CHARS) { more.hidden = false; more.textContent = '… ' + plural(b.text.length - clip(b.text, PREVIEW_CHARS).length, 'more character'); }
    } else {
      pre.classList.add('stale');
      if (!S.plan.files.length) { pre.textContent = ''; pre.classList.add('empty'); }
    }
  }
  function progress(f) {
    var bar = q('.mf-prog');
    if (!bar) return;
    bar.hidden = f == null;
    if (f != null) bar.firstChild.style.width = Math.round(Math.max(0.03, Math.min(1, f)) * 100) + '%';
    q('.mf-stats').textContent = statsText();
    q('.mf-stop').hidden = !S.reading && f == null;
  }
  function renderAfterBuild() { renderJoin(); renderPreview(); renderDest(); renderChips(); }

  function noteName() { var ra = Cade.roomsApi; return ra && ra.activeRoom ? ra.activeRoom() : ''; }
  function roomTaken() { var ra = Cade.roomsApi; return ra && ra.list ? ra.list() : []; }
  function defaultRoom() { return uniqueName(toRoomName(rootsOf() || 'merged files') || 'merged files', roomTaken()); }
  function curExt() {
    var b = fresh();
    return str(prefs.ext).replace(/^\.+/, '') || (b ? b.ext : suggestExt(S.plan.files, mergeOpts()));
  }
  function curFileName() { return safeFileName(q('.mf-fname').value || rootsOf() || 'merged', curExt(), 'merged'); }
  function renderDest() {
    var d = prefs.dest, n = S.plan.files.length;
    Array.prototype.forEach.call(S.el.querySelectorAll('[data-dest]'), function (b) {
      var on = b.getAttribute('data-dest') === d;
      b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    q('.mf-d-room').hidden = d !== 'room';
    q('.mf-d-file').hidden = d !== 'file';
    var info = q('.mf-destinfo'), go = q('.mf-go'), room = noteName(), msg = '', bad = false;
    q('.mf-room').placeholder = defaultRoom();
    q('.mf-fname').placeholder = rootsOf() || 'merged';
    q('.mf-fext').placeholder = (fresh() ? fresh().ext : suggestExt(S.plan.files, mergeOpts()));
    var label;
    if (d === 'append') { label = 'Append'; msg = 'Adds the merged text to the end of ' + (room ? '“' + esc(room) + '”' : 'this note') + ' — one Undo takes it back.'; }
    else if (d === 'cursor') { label = 'Insert'; msg = 'Inserts it at the cursor' + (room ? ' in “' + esc(room) + '”' : '') + ', replacing any selection — one Undo takes it back.'; }
    else if (d === 'room') {
      label = 'Create note';
      var typed = q('.mf-room').value, nm = typed.trim() ? toRoomName(typed) : defaultRoom();
      if (!nm) { msg = 'Type a name for the new note.'; bad = true; }
      else if (roomTaken().indexOf(nm) >= 0) { msg = 'A note called “' + esc(nm) + '” already exists — pick another name.'; bad = true; }
      else msg = 'Creates the note “' + esc(nm) + '” with the merged text and opens it.';
    } else {
      label = S.ready ? 'Save ' + S.ready.name : 'Download';
      msg = S.ready ? 'Ready — tap Save to keep ' + esc(S.ready.name) + '.' : 'Saves one file: ' + esc(curFileName()) + '.';
    }
    info.innerHTML = msg;
    info.classList.toggle('mf-bad', bad);
    go.textContent = label;
    go.disabled = !n || bad || !!S.busy;
    q('.mf-copy').disabled = !n || !!S.busy;
    go.classList.toggle('ready', !!S.ready);
  }

  // ---- preview scheduling ----------------------------------------------------------------------
  function schedulePreview() {
    if (!S) return;
    clearTimeout(S.tPrev);
    if (!S.previewOpen || !S.plan.files.length || fresh()) return;
    var st = S;
    st.tPrev = setTimeout(function () {
      if (S !== st || Cade.isMinimized && Cade.isMinimized(st.el)) return;
      runBuild().then(null, function (e) { if (S === st && !e.stopped) toast('Preview failed: ' + e.message, 'error'); if (S === st) renderPreview(); });
    }, 350);
  }
  // A Types / Header edit still in its debounce counts before anything runs.
  function flushInput() {
    if (S && S.pendingInput) { clearTimeout(S.tInput); S.pendingInput(); }
  }
  function togglePreview() {
    flushInput();
    S.previewOpen = !S.previewOpen;
    renderPreview();
    if (!S.previewOpen) { clearTimeout(S.tPrev); return; }
    var st = S;
    runBuild().then(null, function (e) { if (S === st) { renderPreview(); if (!e.stopped) toast('Preview failed: ' + e.message, 'error'); } });
  }

  // ---- outputs -------------------------------------------------------------------------------------
  function editorOk() {
    var ed = Cade.editor;
    if (!ed) { toast('The editor isn’t ready', 'error'); return null; }
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2400); return null; }
    return ed;
  }
  // The core's appendTextToDocEnd: on a fresh line, a blank line after existing text.
  function appendToNote(ed, text) {
    var doc = ed.state.doc, len = doc.length, prefix = '';
    if (len) {
      var tail = doc.sliceString(Math.max(0, len - 2), len);
      prefix = /\n\n$/.test(tail) ? '' : /\n$/.test(tail) ? '\n' : '\n\n';
    }
    var ins = normalizeNewlines(prefix + text); // CM stores \n; measure what lands
    ed.dispatch({ changes: { from: len, insert: ins }, selection: { anchor: len + ins.length }, scrollIntoView: true, userEvent: 'input.paste' });
  }
  function insertAtCursor(ed, text) {
    var sel = ed.state.selection.main, ins = normalizeNewlines(text);
    ed.dispatch({ changes: { from: sel.from, to: sel.to, insert: ins }, selection: { anchor: sel.from + ins.length }, scrollIntoView: true, userEvent: 'input.paste' });
  }
  function summary(b) {
    var s = 'Merged ' + plural(b.files, 'file');
    if (b.skipped) s += ' · ' + b.skipped.toLocaleString() + ' skipped';
    if (b.stats.csvMismatch.length) s += ' · ⚠ ' + plural(b.stats.csvMismatch.length, 'CSV header') + ' differed (kept)';
    return s;
  }
  function saveFile(name, text, ext) {
    var url = URL.createObjectURL(new Blob([text], { type: mimeFor(ext) }));
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000); // let the save finish reading it
  }
  function writeClip(text, done) {
    var ok = function () { toast('Copied ' + plural(text.length, 'character'), 'success', 1500); if (done) done(); };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var good = false;
      try { good = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      if (good) ok(); else toast('Copy failed — try again', 'error', 2400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  }
  function setBusy(b) { if (!S) return; S.busy = b; S.el.classList.toggle('mf-busy', !!b); renderDest(); }
  function failed(st, e) {
    if (S === st) { setBusy(false); renderPreview(); }
    if (e && e.stopped) toast('Stopped', 'info', 1200);
    else toast('Merge failed: ' + (e && e.message || e), 'error', 3200);
  }
  function go() {
    if (!S || S.busy) return;
    flushInput();
    var d = prefs.dest, st = S;
    if (d === 'file' && S.ready) { var r = S.ready; S.ready = null; saveFile(r.name, r.text, r.ext); toast('Saved ' + r.name, 'success', 1600); renderDest(); return; }
    if (!S.plan.files.length) { toast('Nothing to merge', 'info'); return; }
    if ((d === 'append' || d === 'cursor') && !editorOk()) return;
    var roomName = '';
    if (d === 'room') {
      var ra = Cade.roomsApi;
      if (!ra || typeof ra.ensureRoom !== 'function' || typeof ra.switchRoom !== 'function') { toast('Notes can’t be created from here', 'error'); return; }
      roomName = q('.mf-room').value.trim() ? toRoomName(q('.mf-room').value) : defaultRoom();
      if (!roomName || roomTaken().indexOf(roomName) >= 0) { renderDest(); q('.mf-room').focus(); return; }
    }
    var t0 = Date.now();
    setBusy(true);
    runBuild().then(function (b) {
      if (S !== st) return;
      if (!b.text) { setBusy(false); toast('The merge came out empty — nothing to add', 'info', 2400); return; }
      if (d === 'file') {
        var name = curFileName(), ext = curExt();
        setBusy(false);
        if (Date.now() - t0 <= READY_MS) { saveFile(name, b.text, ext); toast(summary(b) + ' → ' + name, 'success', 2400); }
        else { st.ready = { name: name, text: b.text, ext: ext }; renderDest(); toast('Merged — tap Save to keep ' + name, 'info', 2600); }
        return;
      }
      if (d === 'append' || d === 'cursor') {
        var ed = editorOk();
        if (!ed) { setBusy(false); return; }
        if (d === 'append') appendToNote(ed, b.text); else insertAtCursor(ed, b.text);
        toast(summary(b) + (d === 'append' ? ' — appended' : ' — inserted'), b.stats.csvMismatch.length ? 'info' : 'success', 3000);
        close();
        if (!coarse()) { try { ed.focus(); } catch (x) {} } // no keyboard pop-up on phones
        return;
      }
      // New note: register it, switch (async — it may wait on sync), and only
      // then write into the editor, which by now holds the new room's state.
      var ra2 = Cade.roomsApi, text = b.text, sum = summary(b);
      ra2.ensureRoom(roomName);
      if (ra2.list().indexOf(roomName) < 0) { setBusy(false); toast('Couldn’t create “' + roomName + '”', 'error', 3000); return; }
      if (S === st) q('.mf-destinfo').textContent = 'Opening “' + roomName + '”…';
      return Promise.resolve(ra2.switchRoom(roomName)).then(function () {
        if (ra2.activeRoom() !== roomName) throw new Error('“' + roomName + '” didn’t open — the note exists now, try Append there');
        var ed2 = editorOk();
        if (!ed2) throw new Error('the new note is read-only');
        appendToNote(ed2, text);
        toast(sum + ' → “' + roomName + '”', 'success', 3000);
        if (S === st) close();
      });
    }).then(null, function (e) { failed(st, e); });
  }
  function copy() {
    if (!S || S.busy) return;
    flushInput();
    var b = fresh(), st = S;
    if (b) { if (b.text) writeClip(b.text); else toast('The merge came out empty', 'info'); return; }
    if (!S.plan.files.length) { toast('Nothing to merge', 'info'); return; }
    setBusy(true);
    var p = runBuild();
    var done = function () { if (S === st) setBusy(false); };
    p.then(done, function (e) { failed(st, e); });
    // Safari only writes the clipboard inside the tap: hand it a promise now.
    var CI = window.ClipboardItem, cb = navigator.clipboard, item = null;
    if (CI && cb && cb.write) {
      try { item = new CI({ 'text/plain': p.then(function (r) { return new Blob([r.text], { type: 'text/plain' }); }) }); } catch (e) { item = null; }
    }
    if (item) {
      cb.write([item]).then(function () {
        p.then(function (r) { toast('Copied ' + plural(r.text.length, 'character'), 'success', 1500); });
      }, function () { p.then(function (r) { if (r.text) writeClip(r.text); }, function () {}); });
    } else p.then(function (r) { if (r.text) writeClip(r.text); else toast('The merge came out empty', 'info'); }, function () {});
  }

  // ---- events ---------------------------------------------------------------------------------------------
  function move(id, delta) {
    var ids = S.plan.files.map(function (e) { return e.id; }), i = ids.indexOf(id), j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    if (prefs.by !== 'custom') S.prevBy = prefs.by;
    S.custom = ids; S.ver++; prefs.by = 'custom';
    q('.mf-by').value = 'custom';
    syncDir();
    changed(false);
    var btn = S.el.querySelector('.mf-row[data-id="' + id + '"] [data-act="' + (delta < 0 ? 'up' : 'down') + '"]');
    if (btn && !btn.disabled) btn.focus();
  }
  var DIR_LABEL = { path: ['A → Z', 'Z → A'], name: ['A → Z', 'Z → A'], size: ['Small first', 'Large first'], mtime: ['Oldest first', 'Newest first'], picked: ['As picked', 'Reversed'], custom: ['By hand', 'By hand'] };
  function syncDir() {
    var b = q('.mf-dir'), L = DIR_LABEL[prefs.by] || DIR_LABEL.path;
    b.textContent = (prefs.desc ? '↓ ' : '↑ ') + L[prefs.desc ? 1 : 0];
    b.disabled = prefs.by === 'custom';
    b.setAttribute('aria-pressed', prefs.desc ? 'true' : 'false');
  }
  function onClick(e) {
    var t = e.target, b = t && t.closest ? t.closest('[data-act],[data-dest]') : null;
    if (!b || !S || b.disabled) return;
    var act = b.getAttribute('data-act'), row = b.closest('.mf-row'), id = row ? +row.getAttribute('data-id') : 0;
    if (b.hasAttribute('data-dest')) { prefs.dest = b.getAttribute('data-dest'); S.ready = null; savePrefs(); renderDest(); return; }
    if (act === 'files') pick('.mf-f-files');
    else if (act === 'folder') pick('.mf-f-dir');
    else if (act === 'clear') clearAll();
    else if (act === 'chip') { prefs.filter = toggleFilterExt(prefs.filter, b.getAttribute('data-ext')); q('.mf-filter').value = prefs.filter; savePrefs(); changed(false); }
    else if (act === 'rm') removeEntry(id);
    else if (act === 'up') move(id, -1);
    else if (act === 'down') move(id, 1);
    else if (act === 'more') { S.showN += LIST_STEP * 2; renderList(); }
    else if (act === 'dir') { prefs.desc = !prefs.desc; syncDir(); savePrefs(); changed(false); }
    else if (act === 'preview') togglePreview();
    else if (act === 'stop') stop();
    else if (act === 'go') go();
    else if (act === 'copy') copy();
  }
  function onChange(e) {
    var t = e.target;
    if (!S || !t || !t.classList) return;
    if (t.classList.contains('mf-f-files') || t.classList.contains('mf-f-dir')) { onPicked(e); return; }
    if (t.classList.contains('mf-by')) {
      if (t.value === 'custom' && !S.custom) { S.custom = S.plan.files.map(function (x) { return x.id; }); S.ver++; }
      if (t.value !== 'custom') { S.prevBy = t.value; }
      prefs.by = t.value; syncDir();
    } else if (t.classList.contains('mf-sep')) prefs.sep = t.value;
    else if (t.classList.contains('mf-o-trim')) prefs.trim = t.checked;
    else if (t.classList.contains('mf-o-eol')) prefs.eol = t.checked;
    else if (t.classList.contains('mf-o-csv')) prefs.csv = t.checked;
    else if (t.classList.contains('mf-o-dedupe')) prefs.dedupe = t.checked;
    else if (t.classList.contains('mf-o-dot')) prefs.dot = t.checked;
    else if (t.classList.contains('mf-filter') || t.classList.contains('mf-tpl')) { onInput(e, true); return; }
    else if (t.classList.contains('mf-fext')) { prefs.ext = t.value.replace(/^\.+/, '').trim(); savePrefs(); S.ready = null; renderDest(); return; }
    else return;
    savePrefs();
    changed(false);
  }
  function onInput(e, now) {
    var t = e.target;
    if (!S || !t || !t.classList) return;
    if (t.classList.contains('mf-filter') || t.classList.contains('mf-tpl')) {
      if (t.classList.contains('mf-filter')) prefs.filter = t.value; else prefs.tpl = t.value;
      clearTimeout(S.tInput);
      var st = S;
      var apply = function () { if (S === st) { st.pendingInput = null; savePrefs(); changed(false); } };
      if (now) apply(); else { st.pendingInput = apply; st.tInput = setTimeout(apply, 220); }
    } else if (t.classList.contains('mf-room') || t.classList.contains('mf-fname')) { S.ready = null; renderDest(); }
    else if (t.classList.contains('mf-fext')) { prefs.ext = t.value.replace(/^\.+/, '').trim(); savePrefs(); S.ready = null; renderDest(); }
  }
  function onKey(e) {
    if (!S || (Cade.isMinimized && Cade.isMinimized(S.el))) return;
    if (e.key === 'Escape') {
      var t = e.target, typing = t && (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'file' || t.tagName === 'TEXTAREA');
      e.stopPropagation();
      if (S.reading) { e.preventDefault(); stop(); }
      else if (typing) t.blur();
      else if (!S.busy) { e.preventDefault(); close(); }
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.repeat) {
      e.preventDefault(); go();
    } else if (e.key === 'Enter' && e.target && e.target.classList && (e.target.classList.contains('mf-room') || e.target.classList.contains('mf-fname') || e.target.classList.contains('mf-fext'))) {
      e.preventDefault(); go();
    }
  }
  // Drops stop here: the window-level importer must not also take them.
  function onDragOver(e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    try { e.dataTransfer.dropEffect = 'copy'; } catch (x) {}
    if (S) S.el.classList.add('mf-over');
  }
  function onDragLeave(e) {
    if (!hasFiles(e)) return;
    e.stopPropagation();
    if (S && (!e.relatedTarget || !S.el.contains(e.relatedTarget))) S.el.classList.remove('mf-over');
  }
  function onDrop(e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    if (!S) return;
    S.el.classList.remove('mf-over');
    if (S.busy) { toast('Wait for the merge to finish', 'info'); return; }
    acceptDrop(e.dataTransfer);
  }

  // ---- open / close ------------------------------------------------------------------------------------------
  function close() {
    var el = document.getElementById(PANEL_ID);
    if (el) { el.remove(); if (el._onClose) el._onClose(); }
  }
  function teardown(st) {
    if (S !== st) return;
    clearTimeout(st.tPrev); clearTimeout(st.tInput);
    st.pendingInput = null; st.stopReq = true;
    Array.prototype.forEach.call(st.el.querySelectorAll('input[type="file"]'), function (i) { try { i.value = ''; } catch (e) {} });
    st.entries.forEach(function (e) { e.file = null; });
    st.entries = []; st.keys = {}; st.texts.clear(); st.kinds = {}; st.built = null; st.ready = null; st.plan = null; st.custom = null;
    S = null;
  }
  var SEP_OPTS = [['none', 'Nothing — raw concatenation'], ['newline', 'A new line'], ['blank', 'A blank line'], ['header', 'A header line…'], ['fence', 'Fenced blocks (like Import)']];
  var BY_OPTS = [['path', 'Path (natural)'], ['name', 'Name'], ['size', 'Size'], ['mtime', 'Modified'], ['picked', 'Order picked'], ['custom', 'By hand']];
  function opts(list) { return list.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join(''); }
  function chk(cls, label, title) { return '<label class="mf-chk" title="' + title + '"><input type="checkbox" class="' + cls + '"><span>' + label + '</span></label>'; }

  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById(PANEL_ID);
    if (existing) {
      // Holding a selection, a second run focuses instead of throwing it away.
      if (S && S.el === existing && S.entries.length) { var f = existing.querySelector('.mf-go'); if (f && !coarse()) f.focus(); return; }
      close();
      return;
    }
    loadPrefs();
    var folderOk = 'webkitdirectory' in document.createElement('input');
    var el = Cade.mkPanel(PANEL_ID, '📑 Merge Files',
      '<section class="mf-sec mf-pickbox">' +
        '<div class="mf-pick">' +
          '<button type="button" class="mf-btn" data-act="files">+ Files</button>' +
          (folderOk ? '<button type="button" class="mf-btn" data-act="folder">+ Folder</button>' : '') +
          '<span class="mf-drophint">or drop files' + (folderOk ? ' &amp; folders' : '') + ' here</span>' +
        '</div>' +
        '<div class="mf-sumrow"><div class="mf-sum" aria-live="polite"></div>' +
          '<button type="button" class="mf-link mf-clear" data-act="clear" hidden title="Remove every file from the list">Clear</button></div>' +
      '</section>' +
      '<section class="mf-sec mf-sel">' +
        '<div class="mf-field"><label class="mf-lbl" for="mf-filter">Types</label>' +
          '<input id="mf-filter" class="mf-in mf-filter" type="text" placeholder="empty = all · e.g. csv, txt" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" title="Only merge these extensions (comma or space separated). !log leaves a type out; (none) means files without an extension. Empty = every text file."></div>' +
        '<div class="mf-chips" role="group" aria-label="File types in the selection"></div>' +
        '<div class="mf-field"><label class="mf-lbl" for="mf-by">Order</label>' +
          '<select id="mf-by" class="mf-in mf-by">' + opts(BY_OPTS) + '</select>' +
          '<button type="button" class="mf-btn mf-dir" data-act="dir" title="Direction"></button></div>' +
        '<div class="mf-listh"></div>' +
        '<div class="mf-list" role="list" aria-label="Files to merge, in order"></div>' +
        '<div class="mf-skips"></div>' +
      '</section>' +
      '<section class="mf-sec mf-join"><h3 class="mf-h">Join</h3>' +
        '<div class="mf-field"><label class="mf-lbl" for="mf-sep">Between</label><select id="mf-sep" class="mf-in mf-sep">' + opts(SEP_OPTS) + '</select></div>' +
        '<div class="mf-field mf-tplrow"><label class="mf-lbl" for="mf-tpl">Header</label>' +
          '<input id="mf-tpl" class="mf-in mf-tpl" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" title="A line written above each file. \\n starts a new line."></div>' +
        '<div class="mf-hint mf-tplhint mf-tplrow">Tokens: <code>{name}</code> <code>{path}</code> <code>{ext}</code> <code>{stem}</code> <code>{index}</code> <code>{total}</code> <code>{size}</code></div>' +
        '<div class="mf-hint mf-sephint"></div>' +
        '<div class="mf-checks">' +
          chk('mf-o-trim', 'Trim each file’s end', 'Remove trailing spaces and blank lines at the end of every file') +
          chk('mf-o-eol', 'CRLF → LF', 'Windows line endings become \\n (a note always stores \\n; this matters for Download and Copy)') +
          chk('mf-o-csv', 'CSV: one header row', 'When every file is .csv/.tsv: rows are joined line by line and the first file’s header row is kept once (repeats of it are dropped)') +
          chk('mf-o-dedupe', 'Drop duplicate lines', 'Keep only the first copy of every identical line across all files (blank lines stay)') +
          chk('mf-o-dot', 'Skip dot-folders', 'Leave out everything inside folders whose name starts with a dot (.git, .venv…)') +
        '</div>' +
        '<div class="mf-note mf-csvnote" hidden></div>' +
      '</section>' +
      '<section class="mf-sec mf-prevsec">' +
        '<div class="mf-prevbar"><button type="button" class="mf-btn mf-pv" data-act="preview">Preview</button>' +
          '<span class="mf-stats" aria-live="polite"></span>' +
          '<button type="button" class="mf-btn mf-stop" data-act="stop" hidden>■ Stop</button></div>' +
        '<div class="mf-prog" hidden><i></i></div>' +
        '<pre class="mf-prev" hidden tabindex="0" aria-label="Preview of the merged text"></pre>' +
        '<div class="mf-hint mf-prevmore" hidden></div>' +
      '</section>' +
      '<section class="mf-sec mf-dest"><h3 class="mf-h">Output</h3>' +
        '<div class="mf-seg" role="radiogroup" aria-label="Where the merged text goes">' +
          '<button type="button" role="radio" data-dest="append">Append</button>' +
          '<button type="button" role="radio" data-dest="cursor">At cursor</button>' +
          '<button type="button" role="radio" data-dest="room">New note</button>' +
          '<button type="button" role="radio" data-dest="file">Download</button>' +
        '</div>' +
        '<div class="mf-field mf-d-room" hidden><label class="mf-lbl" for="mf-room">Name</label>' +
          '<input id="mf-room" class="mf-in mf-room" type="text" maxlength="100" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></div>' +
        '<div class="mf-field mf-d-file" hidden><label class="mf-lbl" for="mf-fname">File</label>' +
          '<input id="mf-fname" class="mf-in mf-fname" type="text" maxlength="120" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">' +
          '<span class="mf-dot">.</span><input class="mf-in mf-fext" type="text" maxlength="10" aria-label="Extension" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></div>' +
        '<div class="mf-hint mf-destinfo" aria-live="polite"></div>' +
        '<div class="mf-acts"><button type="button" class="mf-btn primary mf-go" data-act="go" title="Merge (Ctrl/⌘+Enter)">Append</button>' +
          '<button type="button" class="mf-btn mf-copy" data-act="copy" title="Copy the merged text">Copy</button></div>' +
      '</section>' +
      '<input type="file" class="mf-f-files" multiple hidden>' +
      '<input type="file" class="mf-f-dir" webkitdirectory directory multiple hidden>');

    S = {
      el: el, entries: [], keys: {}, seq: 0, nextId: 0, ver: 0, planKey: '', texts: new Map(), kinds: {}, custom: null, prevBy: prefs.by,
      plan: null, planSig: '', built: null, reading: null, stopReq: false, readDone: 0, readTotal: 0,
      previewOpen: false, showN: LIST_STEP, scanning: 0, scanFound: 0, busy: false, ready: null, tPrev: 0, tInput: 0, pendingInput: null, skipOpen: false,
    };
    var st = S;
    q('.mf-filter').value = prefs.filter;
    q('.mf-by').value = prefs.by;
    q('.mf-sep').value = prefs.sep;
    q('.mf-tpl').value = prefs.tpl;
    q('.mf-o-trim').checked = prefs.trim;
    q('.mf-o-eol').checked = prefs.eol;
    q('.mf-o-csv').checked = prefs.csv;
    q('.mf-o-dedupe').checked = prefs.dedupe;
    q('.mf-o-dot').checked = prefs.dot;
    q('.mf-fext').value = prefs.ext;
    syncDir();

    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', function (e) { onInput(e, false); });
    el.addEventListener('keydown', onKey);
    el.addEventListener('toggle', function (e) { if (S && e.target && e.target.classList && e.target.classList.contains('mf-skipd')) S.skipOpen = e.target.open; }, true);
    el.addEventListener('dragenter', onDragOver);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);
    el.addEventListener('cade-panel-minimize', function () { if (S === st) clearTimeout(st.tPrev); });
    el.addEventListener('cade-panel-restore', function () { if (S === st) schedulePreview(); });
    el._onClose = function () { teardown(st); };

    replan();
    renderAll();
  }

  Cade.registerWidget({
    name: 'Merge Files',
    description: 'Combine many files — or a whole folder — into one document: filter by type, order, join with headers, one CSV header; to the note, a new note or a download',
    icon: '📑',
    tags: 'merge,merge files,combine,combine files,concatenate,concat,cat,join files,files,folder,csv,append,import,bundle,one file,stitch',
    open: open,
    close: close,
  });
})();
