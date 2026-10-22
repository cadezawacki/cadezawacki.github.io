/* Folder Mirror — core (pure logic, no DOM, no file system).
 *
 * Folder Mirror keeps chosen rooms in two-way sync with a folder of plain
 * .md / .txt files on a computer (Chrome / Edge, File System Access API). The
 * browser side (mirror-engine.js) does the file and room I/O; everything it
 * DECIDES lives here so it can be tested in node:
 *
 *   - file names: a room name ↔ a file name that every OS accepts. Characters
 *     a file name can't hold (/ \ : * ? " < > | control chars, and % itself)
 *     become %XX, a leading dot / trailing dot or space and Windows device
 *     names (con, nul, com1…) are escaped the same way, so decodeName() gives
 *     the room back exactly. File names are compared case-insensitively
 *     (macOS and Windows folders are), Unicode is NFC (macOS hands back NFD).
 *   - the index (.txt-mirror.json in the folder): room → relative path, so
 *     renamed files, case changes and collision suffixes round-trip.
 *   - decide(): base (the last text both sides agreed on) vs the room now vs
 *     the file now → write the file / write the room / merge / conflict /
 *     missing file / gone room, per direction (two-way, txt → folder only,
 *     folder → txt only).
 *   - front matter (optional title + updated block), text normalising (CRLF,
 *     BOM), conflict-copy and trash names, scope, polling back-off, the log.
 *
 * UMD: window.__cadeMirrorCore in the page, module.exports in node. */
(function (root) {
  'use strict';

  var EXTS = ['.md', '.txt', '.markdown'];
  var INDEX_NAME = '.txt-mirror.json';
  var TRASH_DIR = '.trash';
  var MAX_FILE_BYTES = 5 * 1024 * 1024;     // bigger files aren't notes; skipped
  var MAX_NAME_BYTES = 180;                 // leaves room for " (conflict …).md" under 255
  var MAX_ROOM = 100;                       // the app's room-name limit
  var BAD_CHARS = '<>:"/\\|?*%';
  var RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
  var CONFLICT_RE = / \(conflict \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)$/;

  function nfc(s) { s = String(s == null ? '' : s); return s.normalize ? s.normalize('NFC') : s; }
  function hex(c) { var h = c.toString(16).toUpperCase(); return '%' + (h.length < 2 ? '0' + h : h); }
  function utf8Len(s) { var n = 0; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xD800 && c <= 0xDBFF) ? (i++, 4) : 3; } return n; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // ---- names -----------------------------------------------------------------------
  // A room (or workspace) name → a file-name stem every OS accepts.
  function encodeName(name) {
    var s = nfc(name), out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i), c = s.charCodeAt(i);
      out += (c < 32 || c === 127 || BAD_CHARS.indexOf(ch) >= 0) ? hex(c) : ch;
    }
    if (!out) return '%00';
    if (out.charAt(0) === '.' || out.charAt(0) === ' ') out = hex(out.charCodeAt(0)) + out.slice(1);
    var last = out.charAt(out.length - 1);
    if (last === '.' || last === ' ') out = out.slice(0, -1) + hex(last.charCodeAt(0));
    // Device names are reserved on Windows even with an extension (con.txt).
    var dot = out.indexOf('.'), stem = dot < 0 ? out : out.slice(0, dot);
    if (RESERVED.test(stem)) out = stem.slice(0, -1) + hex(stem.charCodeAt(stem.length - 1)) + out.slice(stem.length);
    if (utf8Len(out) > MAX_NAME_BYTES) {
      // Too long for a file name: cut and tag with a hash. Not reversible by
      // decoding, but the index keeps the mapping.
      var cut = out;
      while (utf8Len(cut) > MAX_NAME_BYTES - 9) cut = cut.slice(0, -1);
      if (/%[0-9A-F]?$/.test(cut)) cut = cut.replace(/%[0-9A-F]?$/, '');
      var lc = cut.charCodeAt(cut.length - 1);
      if (lc >= 0xD800 && lc <= 0xDBFF) cut = cut.slice(0, -1);
      out = cut + '~' + hash(s).slice(0, 8);
    }
    return out;
  }
  // %XX of the characters encodeName escapes (ASCII only) → the characters.
  function decodeRaw(stem) {
    return String(stem).replace(/%([0-9A-Fa-f]{2})/g, function (m, h) {
      var c = parseInt(h, 16);
      return c > 0 && c < 128 ? String.fromCharCode(c) : m;
    });
  }
  // A file-name stem → a room name (the app's room names are trimmed + lower case).
  function decodeName(stem) { return nfc(decodeRaw(stem)).trim().toLowerCase(); }
  function validRoom(n) { return !!n && n.length <= MAX_ROOM && n.indexOf('__') !== 0; }
  // A room name the app will accept, from whatever a file was called.
  function fixRoom(n) {
    n = String(n || '').trim().toLowerCase();
    while (n.indexOf('__') === 0) n = n.slice(1);
    if (n.length > MAX_ROOM) n = n.slice(0, MAX_ROOM).trim();
    return n || null;
  }

  function splitExt(name) {
    var i = String(name).lastIndexOf('.');
    if (i <= 0) return null;
    var ext = name.slice(i).toLowerCase();
    return EXTS.indexOf(ext) >= 0 ? { stem: name.slice(0, i), ext: name.slice(i) } : null;
  }
  function isConflictStem(stem) { return CONFLICT_RE.test(stem); }
  // A file in the folder that may belong to a room: { stem, ext, room } —
  // null for hidden files, the index, other extensions and conflict copies.
  function parseFileName(name) {
    name = nfc(name);
    if (!name || name.charAt(0) === '.' || name === INDEX_NAME) return null;
    var se = splitExt(name);
    if (!se || isConflictStem(se.stem)) return null;
    var room = fixRoom(decodeName(se.stem));
    return room ? { stem: se.stem, ext: se.ext, room: room } : null;
  }

  function stamp(d) {
    d = d instanceof Date ? d : new Date(d == null ? Date.now() : d);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + pad(d.getMinutes());
  }
  // "<stem> (conflict YYYY-MM-DD HHMM).md" next to the file; " 2", " 3"… if taken.
  function conflictPath(path, date, taken) {
    var p = splitPath(path), se = splitExt(p.name) || { stem: p.name, ext: '.md' };
    var s = stamp(date), name, n = 1;
    do { name = se.stem + ' (conflict ' + s + (n > 1 ? ' ' + n : '') + ')' + se.ext; n++; }
    while (taken && taken(joinPath(p.dir.concat([name])).toLowerCase()) && n < 500);
    return joinPath(p.dir.concat([name]));
  }
  // Where a file goes in .trash/: its name, or "<stem> (deleted …).md" if that's taken.
  function trashPath(path, date, taken) {
    var p = splitPath(path), first = joinPath([TRASH_DIR, p.name]);
    if (!taken || !taken(first.toLowerCase())) return first;
    var se = splitExt(p.name) || { stem: p.name, ext: '' }, s = stamp(date), name, n = 1;
    do { name = se.stem + ' (deleted ' + s + (n > 1 ? ' ' + n : '') + ')' + se.ext; n++; }
    while (taken(joinPath([TRASH_DIR, name]).toLowerCase()) && n < 500);
    return joinPath([TRASH_DIR, name]);
  }

  // ---- paths -----------------------------------------------------------------------
  function splitPath(path) {
    var segs = String(path || '').split('/').filter(function (s) { return s.length; });
    return { dir: segs.slice(0, -1), name: segs.length ? segs[segs.length - 1] : '' };
  }
  function joinPath(segs) { return segs.filter(function (s) { return s && s.length; }).join('/'); }
  // A relative path we're willing to touch: no .., no absolute, no backslash.
  function safePath(path) {
    if (typeof path !== 'string' || !path || path.length > 1024) return false;
    if (path.charAt(0) === '/' || path.indexOf('\\') >= 0) return false;
    var segs = path.split('/');
    for (var i = 0; i < segs.length; i++) if (!segs[i] || segs[i] === '.' || segs[i] === '..') return false;
    return true;
  }
  // A workspace's folder: its ancestors' names, outermost first, each encoded.
  function wsFolder(wsId, byId) {
    var out = [], cur = wsId ? byId(wsId) : null, guard = 0;
    while (cur && guard++ < 20) { out.unshift(encodeName(cur.name || cur.id)); cur = cur.parentId ? byId(cur.parentId) : null; }
    return out;
  }
  // The workspace whose folder is `dirSegs` (case-insensitive), or null.
  function folderToWs(dirSegs, list, byId) {
    if (!dirSegs || !dirSegs.length) return null;
    var want = dirSegs.map(function (s) { return nfc(s).toLowerCase(); }).join('/');
    for (var i = 0; i < list.length; i++) {
      var f = wsFolder(list[i].id, byId).map(function (s) { return s.toLowerCase(); }).join('/');
      if (f === want) return list[i].id;
    }
    return null;
  }
  // Where a room's file should be. A room already in the index keeps its file
  // name (its case, extension, collision suffix); only its folder follows the
  // layout. New rooms get encodeName(room) + ext; a name another room (or a
  // file we don't own) already uses gets " (2)", " (3)"… taken(lowerPath, room)
  // says whether a path is in use by something else.
  function planPath(room, opts, ctx) {
    opts = opts || {}; ctx = ctx || {};
    var dir = opts.sub ? (ctx.wsPath || []) : [];
    var name = ctx.current ? splitPath(ctx.current).name : encodeName(room) + (opts.ext === '.txt' ? '.txt' : '.md');
    var se = splitExt(name) || { stem: name, ext: '' };
    var path = joinPath(dir.concat([name])), n = 2;
    while (ctx.taken && ctx.taken(path.toLowerCase(), room) && n < 1000) {
      path = joinPath(dir.concat([se.stem + ' (' + n + ')' + se.ext])); n++;
    }
    return path;
  }

  // ---- the index (.txt-mirror.json) ------------------------------------------------
  function emptyIndex() { return { app: 'Cade.txt Folder Mirror', v: 1, rooms: {} }; }
  function parseIndex(text) {
    var idx = emptyIndex();
    var o;
    try { o = JSON.parse(String(text || '')); } catch (e) { return idx; }
    if (!o || typeof o !== 'object' || !o.rooms || typeof o.rooms !== 'object') return idx;
    var seen = {};
    Object.keys(o.rooms).forEach(function (r) {
      var p = o.rooms[r], room = fixRoom(nfc(r));
      if (!room || !validRoom(room) || !safePath(p)) return;
      var low = nfc(p).toLowerCase();
      if (seen[low]) return;                          // two rooms can't share a file
      seen[low] = 1;
      idx.rooms[room] = nfc(p);
    });
    return idx;
  }
  function serializeIndex(idx) {
    var rooms = {};
    Object.keys(idx.rooms || {}).sort().forEach(function (r) { rooms[r] = idx.rooms[r]; });
    return JSON.stringify({
      app: 'Cade.txt Folder Mirror', v: 1,
      note: 'Which file holds which Cade.txt room. Kept up to date by Folder Mirror; if it goes missing, file names are decoded instead.',
      rooms: rooms,
    }, null, 2) + '\n';
  }

  // ---- text ------------------------------------------------------------------------
  // What a file says, the way a room holds text: \n line ends, no BOM.
  function normalizeText(s) {
    s = String(s == null ? '' : s);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return s.indexOf('\r') >= 0 ? s.replace(/\r\n?/g, '\n') : s;
  }
  var FM_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;
  var FM_OURS = /^(?:title: .*|updated: \d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?)$/;
  // Our own front matter (title + updated, nothing else) comes off; anything a
  // person wrote stays part of the text. `loose` (the option is on) also takes
  // a block with only one of the two keys.
  function stripFrontMatter(text, loose) {
    var m = FM_RE.exec(text);
    if (!m) return text;
    var lines = m[1].split('\n'), keys = {};
    for (var i = 0; i < lines.length; i++) {
      if (!FM_OURS.test(lines[i])) return text;
      keys[lines[i].slice(0, lines[i].indexOf(':'))] = 1;
    }
    if (!loose && !(keys.title && keys.updated)) return text;
    return text.slice(m[0].length);
  }
  function isoMinute(d) {
    d = d instanceof Date ? d : new Date(d == null ? Date.now() : d);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  // A room's text as its file holds it.
  function fileTextFor(roomText, room, opts, date) {
    if (opts && opts.front === 'title') return '---\ntitle: ' + JSON.stringify(String(room)) + '\nupdated: ' + isoMinute(date) + '\n---\n' + roomText;
    return roomText;
  }
  // A file's contents as the room would hold them.
  function textFromFile(raw, opts) { return stripFrontMatter(normalizeText(raw), !!(opts && opts.front === 'title')); }

  // Cheap signature for "is this still the text we saw" (length + FNV-1a).
  function hash(s) {
    s = String(s == null ? '' : s);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul ? Math.imul(h, 16777619) : (h * 16777619) | 0; }
    return (h >>> 0).toString(16) + s.length.toString(36);
  }
  function statChanged(rec, st) {
    if (!st) return !!(rec && !rec.missing);
    return !rec || rec.mtime !== st.mtime || rec.size !== st.size;
  }

  // ---- decisions -------------------------------------------------------------------
  // base: the last text both sides agreed on (null = they've never met);
  // room / file: the text now (null = the room is gone / the file is missing);
  // direction: 'both' | 'out' (txt → folder only) | 'in' (folder → txt only);
  // merge(base, room, file) → merged text or null (a real conflict).
  // Returns { action, text?, other?, keep?, skipped? }:
  //   none · agree (same text both sides — just record it) · write-file ·
  //   write-room · merge (text goes to both) · conflict (keep: 'room' → text
  //   to the file, `other` (the file's version) saved as a conflict copy;
  //   keep: 'file' → text to the room, `other` (the room's) saved as the copy)
  //   · file-missing · room-gone.
  function decide(o) {
    var base = o.base == null ? null : o.base, room = o.room, file = o.file, dir = o.direction || 'both';
    if (room == null) return { action: file == null ? 'none' : 'room-gone' };
    if (file == null) {
      if (base == null) return dir === 'in' ? { action: 'none' } : { action: 'write-file', text: room };
      return { action: 'file-missing' };
    }
    if (room === file) return base === room ? { action: 'none' } : { action: 'agree', text: room };
    var keepFile = dir === 'in';
    var conflict = function () {
      return keepFile ? { action: 'conflict', keep: 'file', text: file, other: room } : { action: 'conflict', keep: 'room', text: room, other: file };
    };
    if (base == null) return conflict();               // first meeting: never overwrite silently
    var rc = room !== base, fc = file !== base;
    if (rc && !fc) return dir === 'in' ? { action: 'none', skipped: 'room' } : { action: 'write-file', text: room };
    if (fc && !rc) return dir === 'out' ? { action: 'none', skipped: 'file' } : { action: 'write-room', text: file };
    if (dir !== 'both') return conflict();
    var merged = typeof o.merge === 'function' ? o.merge(base, room, file) : null;
    if (merged === room) return { action: 'write-file', text: room, merged: true };
    if (merged === file) return { action: 'write-room', text: file, merged: true };
    if (merged != null) return { action: 'merge', text: merged };
    return conflict();
  }

  // What the first sync will do, for the preview: rooms → files.
  // rooms: [{ room, text, path, fileText (null = no file) }]
  function previewRows(rows, direction) {
    var out = { create: [], same: [], conflict: [], skip: [] };
    rows.forEach(function (r) {
      if (r.fileText == null) (direction === 'in' ? out.skip : out.create).push(r);
      else if (r.fileText === r.text) out.same.push(r);
      else out.conflict.push(r);
    });
    return out;
  }

  // ---- scope ---------------------------------------------------------------------------
  // scope: { mode: 'all' | 'ws' | 'rooms', ws: [ids], rooms: [names] }
  // info: { archived, wsChain: every workspace the room is in, plus their ancestors }
  function inScope(room, scope, includeArchived, info) {
    info = info || {};
    if (info.archived && !includeArchived) return false;
    scope = scope || { mode: 'all' };
    if (scope.mode === 'rooms') return (scope.rooms || []).indexOf(room) >= 0;
    if (scope.mode === 'ws') {
      var want = scope.ws || [], chain = info.wsChain || [];
      if (!chain.length) return want.indexOf('__unlabeled__') >= 0;
      for (var i = 0; i < chain.length; i++) if (want.indexOf(chain[i]) >= 0) return true;
      return false;
    }
    return true;
  }

  // ---- polling -------------------------------------------------------------------------
  // Seconds until the next look at the folder: the base interval while things
  // change, doubling every 5 quiet checks (to 30 s, or 8× the base); with a
  // FileSystemObserver telling us about changes it's only a safety net.
  function nextDelay(baseSec, idleTicks, observing) {
    var b = Math.max(1, Math.min(60, +baseSec || 3));
    if (observing) return Math.max(30, b * 10) * 1000;
    var cap = Math.max(30, b * 8);
    return Math.min(cap, b * Math.pow(2, Math.floor(Math.max(0, idleTicks) / 5))) * 1000;
  }

  // ---- log -----------------------------------------------------------------------------
  function pushLog(log, entry, max) {
    log = (log || []).slice();
    log.push(entry);
    max = max || 50;
    if (log.length > max) log = log.slice(log.length - max);
    return log;
  }

  // ---- preferences (the manifest's "prefs" for the mirror widget — keep equal) --------
  var PREF_FIELDS = [
    { key: 'ext', type: 'radio', label: 'File type for new files', default: '.md',
      options: [{ value: '.md', label: '.md (Markdown)' }, { value: '.txt', label: '.txt (plain text)' }],
      hint: 'Files already in the folder keep their extension' },
    { key: 'sub', type: 'toggle', label: 'A subfolder per workspace', default: false,
      hint: 'A room in a workspace goes into a folder named after it (nested workspaces nest); the rest stay at the top. Turning this on or off moves the files' },
    { key: 'poll', type: 'slider', label: 'Look for changed files every', default: 3, min: 1, max: 30, step: 1, unit: 's',
      hint: 'Only while the page is visible, and less often when nothing changes. Chrome 129+ is told about changes right away and only checks now and then' },
    { key: 'newFiles', type: 'radio', label: 'New files in the folder', default: 'ask',
      options: [{ value: 'ask', label: 'Ask me — one tap in the panel' }, { value: 'auto', label: 'Import them as rooms automatically' }, { value: 'ignore', label: 'Ignore them' }] },
    { key: 'onDelete', type: 'radio', label: 'When a mirrored room is deleted', default: 'trash',
      options: [{ value: 'trash', label: 'Move its file to .trash in the folder' }, { value: 'leave', label: 'Leave the file where it is' }],
      hint: 'A deleted file never deletes a room' },
    { key: 'archived', type: 'toggle', label: 'Include archived rooms', default: false },
    { key: 'front', type: 'radio', label: 'Front matter in files', default: 'none',
      options: [{ value: 'none', label: 'None — files stay plain' }, { value: 'title', label: 'Title and updated date' }],
      hint: 'A small --- block at the top of each file for Obsidian and static-site tools. It never ends up in the room' },
  ];

  var api = {
    PREF_FIELDS: PREF_FIELDS,
    EXTS: EXTS, INDEX_NAME: INDEX_NAME, TRASH_DIR: TRASH_DIR, MAX_FILE_BYTES: MAX_FILE_BYTES,
    encodeName: encodeName, decodeName: decodeName, validRoom: validRoom, fixRoom: fixRoom,
    splitExt: splitExt, parseFileName: parseFileName, isConflictStem: isConflictStem,
    conflictPath: conflictPath, trashPath: trashPath, stamp: stamp,
    splitPath: splitPath, joinPath: joinPath, safePath: safePath, wsFolder: wsFolder, folderToWs: folderToWs, planPath: planPath,
    emptyIndex: emptyIndex, parseIndex: parseIndex, serializeIndex: serializeIndex,
    normalizeText: normalizeText, stripFrontMatter: stripFrontMatter, fileTextFor: fileTextFor, textFromFile: textFromFile,
    hash: hash, statChanged: statChanged, decide: decide, previewRows: previewRows, inScope: inScope,
    nextDelay: nextDelay, pushLog: pushLog, nfc: nfc,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.__cadeMirrorCore = api;
})(typeof window !== 'undefined' ? window : null);
