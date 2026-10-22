/* Checks for Folder Mirror's pure logic: file-name escaping round trips,
 * the index, text / front matter, three-way decisions per direction,
 * conflict and trash names, scope, polling back-off, and that the widget,
 * the plugin and the preferences register as the manifest says.
 * Not loaded by the app. Run: node txt/widgets/mirror/mirror.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var C = require('./mirror-core.js');
var MC = require('../merge/merge-core.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
function merge(base, a, b) { var r = MC.merge3(base, a, b); return r.conflicts ? null : r.merged; }

// The entries proposed for txt/manifest.json (used until the manifest has them).
var PROPOSED = {
  mirror: {
    id: 'mirror', type: 'widget', name: 'Folder Mirror',
    description: 'Keep rooms in two-way sync with a folder of .md files on your computer — for Obsidian, VS Code, Hazel and scripts (desktop Chrome / Edge; phones get the changes through Sync)',
    icon: '🗂',
    tags: 'folder,mirror,sync,files,markdown,md,txt,obsidian,vs code,hazel,scripts,export,backup,local files,file system,hub,two-way,desktop',
    entry: 'widgets/mirror/mirror.js', css: 'widgets/mirror/mirror.css',
    precache: ['widgets/mirror/mirror-core.js', 'widgets/mirror/mirror-engine.js', 'widgets/merge/merge-core.js', 'widgets/merge/merge-ui.js'],
    prefs: { title: 'Folder Mirror', fields: C.PREF_FIELDS },
  },
  'mirror-run': {
    id: 'mirror-run', type: 'plugin', name: 'Keep Folder Mirror running',
    description: 'Turned on by Folder Mirror’s setup (and off by Stop mirroring): keeps the chosen rooms and the folder on this computer in step while the widget is closed — desktop Chrome / Edge only, only while the page is visible. Does nothing on phones',
    entry: 'widgets/mirror/mirror-run.js',
    precache: ['widgets/mirror/mirror-core.js', 'widgets/mirror/mirror-engine.js', 'widgets/mirror/mirror.css', 'widgets/merge/merge-core.js'],
    settingKey: 'plugins.mirror-run', section: 'Devices', default: false,
  },
};
function manifestEntry(id) {
  var man = [];
  try { man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules; } catch (e) {}
  return man.filter(function (m) { return m.id === id; })[0] || PROPOSED[id];
}

// ---- names ----------------------------------------------------------------------------
test('room names round-trip through file names', function () {
  var names = [
    'shopping list', 'todo', 'work/plan', 'a\\b', 'q3: plan?', 'say "hi"', '<tag>', 'pipe | here', 'star*', '100% done', '%2f literal',
    'café', 'naïve résumé', '日本語のメモ', 'заметки', 'emoji 🎉 notes', '.hidden', 'trailing.', 'ends with dot...', 'tab\there',
    'con', 'nul', 'com1', 'lpt9', 'aux.notes', 'con.txt', 'prn ', 'x', '-', '.', '..',
  ];
  names.forEach(function (n) {
    var room = n.trim().toLowerCase().normalize('NFC');
    if (!room) return;
    var stem = C.encodeName(room);
    assert.strictEqual(C.decodeName(stem), room, JSON.stringify(n) + ' → ' + stem);
    assert.ok(!/[<>:"/\\|?*\u0000-\u001f]/.test(stem), 'no forbidden characters in ' + stem);
    assert.ok(stem.charAt(0) !== '.' && !/[. ]$/.test(stem), 'no leading dot / trailing dot or space: ' + stem);
    assert.ok(!/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(stem), 'no device name: ' + stem);
    var pf = C.parseFileName(stem + '.md');
    assert.ok(pf && pf.room === room, 'parseFileName gives the room back for ' + stem);
  });
});
test('escapes are exactly the characters a file name cannot hold', function () {
  assert.strictEqual(C.encodeName('work/plan'), 'work%2Fplan');
  assert.strictEqual(C.encodeName('q3: plan?'), 'q3%3A plan%3F');
  assert.strictEqual(C.encodeName('100% done'), '100%25 done');
  assert.strictEqual(C.encodeName('.hidden'), '%2Ehidden');
  assert.strictEqual(C.encodeName('trailing.'), 'trailing%2E');
  assert.strictEqual(C.encodeName('con'), 'co%6E');
  assert.strictEqual(C.encodeName('con.txt'), 'co%6E.txt');
  assert.strictEqual(C.encodeName('café 日本'), 'café 日本', 'Unicode is kept as it is');
});
test('file names people make map to sensible rooms', function () {
  assert.strictEqual(C.parseFileName('Shopping List.md').room, 'shopping list');
  assert.strictEqual(C.parseFileName('Notes.TXT').room, 'notes');
  assert.strictEqual(C.parseFileName('ideas.markdown').room, 'ideas');
  assert.strictEqual(C.parseFileName('100% done.md').room, '100% done', 'a % that is no escape stays');
  assert.strictEqual(C.parseFileName('__init.md').room, '_init', 'the app reserves names starting with __');
  // macOS hands back decomposed (NFD) names
  assert.strictEqual(C.parseFileName('café.md').room, 'café');
  [ '.hidden.md', '.txt-mirror.json', 'photo.png', 'README', 'notes (conflict 2026-10-22 1530).md', 'notes (conflict 2026-10-22 1530 2).md', '  .md' ]
    .forEach(function (n) { assert.strictEqual(C.parseFileName(n), null, n); });
  var long = C.parseFileName(new Array(120).join('a') + '.md');
  assert.strictEqual(long.room.length, 100, 'over-long names are cut to the room limit');
});
test('very long names are cut with a hash (the index keeps the mapping)', function () {
  var room = new Array(100).join('é');   // 99 chars, 198 bytes
  var stem = C.encodeName(room);
  assert.ok(Buffer.byteLength(stem, 'utf8') <= 180, 'fits a file name');
  assert.ok(/~[0-9a-f]{8}$/.test(stem));
  assert.notStrictEqual(C.encodeName(room + 'x'), stem, 'different rooms, different names');
});

// ---- paths and collisions ----------------------------------------------------------------
test('planPath: new names, kept names, workspace folders, case collisions', function () {
  var taken = {};
  var t = function (low, room) { return taken[low] != null && taken[low] !== room; };
  assert.strictEqual(C.planPath('notes', { ext: '.md' }, { taken: t }), 'notes.md');
  assert.strictEqual(C.planPath('notes', { ext: '.txt' }, { taken: t }), 'notes.txt');
  assert.strictEqual(C.planPath('notes', { ext: '.md', sub: true }, { wsPath: ['Work', 'Q3'], taken: t }), 'Work/Q3/notes.md');
  assert.strictEqual(C.planPath('notes', { ext: '.md', sub: false }, { wsPath: ['Work'], taken: t }), 'notes.md', 'no subfolders unless asked');
  // a file someone else owns, in another case (macOS / Windows folders ignore case)
  taken['notes.md'] = '\u0000file';
  assert.strictEqual(C.planPath('notes', { ext: '.md' }, { taken: t }), 'notes (2).md');
  taken['notes (2).md'] = 'other';
  assert.strictEqual(C.planPath('notes', { ext: '.md' }, { taken: t }), 'notes (3).md');
  // a room keeps the name its file already has, but follows the layout
  taken = {};
  assert.strictEqual(C.planPath('notes', { sub: true }, { current: 'Notes.MD', wsPath: ['Work'], taken: t }), 'Work/Notes.MD');
  assert.strictEqual(C.planPath('notes', { sub: false }, { current: 'Work/Notes.MD', taken: t }), 'Notes.MD');
  taken['notes.md'] = 'notes';
  assert.strictEqual(C.planPath('notes', {}, { current: 'notes.md', taken: t }), 'notes.md', 'its own path is not a collision');
});
test('workspace folders follow nesting and map back', function () {
  var ws = { a: { id: 'a', name: 'Work' }, b: { id: 'b', name: 'Q3/Q4', parentId: 'a' }, c: { id: 'c', name: 'Home' } };
  var byId = function (id) { return ws[id] || null; };
  assert.deepStrictEqual(C.wsFolder('b', byId), ['Work', 'Q3%2FQ4']);
  assert.deepStrictEqual(C.wsFolder('c', byId), ['Home']);
  var list = [ws.a, ws.b, ws.c];
  assert.strictEqual(C.folderToWs(['work', 'q3%2fq4'], list, byId), 'b', 'case-insensitive');
  assert.strictEqual(C.folderToWs(['Home'], list, byId), 'c');
  assert.strictEqual(C.folderToWs(['Elsewhere'], list, byId), null);
  assert.strictEqual(C.folderToWs([], list, byId), null);
});
test('only safe relative paths', function () {
  ['a.md', 'Work/a.md', 'a b/c d.md'].forEach(function (p) { assert.ok(C.safePath(p), p); });
  ['', '/etc/passwd', '../x.md', 'a/../b.md', 'a\\b.md', 'a//b.md', './a.md', 5, null].forEach(function (p) { assert.ok(!C.safePath(p), String(p)); });
});

// ---- index ---------------------------------------------------------------------------------
test('index round trip; bad entries dropped', function () {
  var idx = C.emptyIndex();
  idx.rooms['work/plan'] = 'Work/work%2Fplan.md';
  idx.rooms['shopping list'] = 'Shopping List.md';
  var back = C.parseIndex(C.serializeIndex(idx));
  assert.deepStrictEqual(back.rooms, idx.rooms);
  var bad = C.parseIndex(JSON.stringify({ rooms: { ok: 'ok.md', up: '../up.md', abs: '/x.md', dup: 'OK.md', Upper: 'u.md', __sys: 's.md', '': 'e.md' } }));
  assert.deepStrictEqual(Object.keys(bad.rooms).sort(), ['_sys', 'ok', 'upper'], 'names made valid the way file names are');
  assert.deepStrictEqual(C.parseIndex('not json').rooms, {});
  assert.deepStrictEqual(C.parseIndex('{"rooms":[1,2]}').rooms, {});
  assert.ok(/\n$/.test(C.serializeIndex(idx)), 'ends with a newline');
});

// ---- text --------------------------------------------------------------------------------------
test('file text: CRLF, BOM, our front matter in and out', function () {
  assert.strictEqual(C.normalizeText('﻿a\r\nb\rc\n'), 'a\nb\nc\n');
  var d = new Date(2026, 9, 22, 15, 30);
  var withFm = C.fileTextFor('# hi\nthere', 'work/plan', { front: 'title' }, d);
  assert.strictEqual(withFm, '---\ntitle: "work/plan"\nupdated: 2026-10-22T15:30\n---\n# hi\nthere');
  assert.strictEqual(C.fileTextFor('x', 'r', { front: 'none' }), 'x');
  assert.strictEqual(C.textFromFile(withFm, { front: 'title' }), '# hi\nthere');
  assert.strictEqual(C.textFromFile(withFm.replace(/\n/g, '\r\n'), { front: 'none' }), '# hi\nthere', 'ours comes off even with the option off');
  var mine = '---\ntitle: Trip\ntags: [a]\n---\nbody';
  assert.strictEqual(C.textFromFile(mine, { front: 'title' }), mine, 'front matter a person wrote stays');
  assert.strictEqual(C.textFromFile('---\ntitle: x\n---\nbody', { front: 'none' }), '---\ntitle: x\n---\nbody', 'half a block is not ours unless the option is on');
  assert.strictEqual(C.textFromFile('---\ntitle: x\n---\nbody', { front: 'title' }), 'body');
  assert.strictEqual(C.textFromFile('---\nno end', { front: 'title' }), '---\nno end');
});
test('hash and stat changes', function () {
  assert.strictEqual(C.hash('abc'), C.hash('abc'));
  assert.notStrictEqual(C.hash('abc'), C.hash('abd'));
  assert.ok(C.statChanged(null, { mtime: 1, size: 2 }));
  assert.ok(!C.statChanged({ mtime: 1, size: 2 }, { mtime: 1, size: 2 }));
  assert.ok(C.statChanged({ mtime: 1, size: 2 }, { mtime: 3, size: 2 }));
  assert.ok(C.statChanged({ mtime: 1, size: 2 }, null), 'a file that vanished is a change');
  assert.ok(!C.statChanged({ mtime: 1, size: 2, missing: true }, null), '…once');
});

// ---- decisions ---------------------------------------------------------------------------------
var BASE = 'a\nb\nc\nd\ne';
test('two-way: only txt changed / only the file changed / neither', function () {
  assert.deepStrictEqual(C.decide({ base: BASE, room: BASE, file: BASE }), { action: 'none' });
  var r = C.decide({ base: BASE, room: BASE + '\nf', file: BASE });
  assert.strictEqual(r.action, 'write-file'); assert.strictEqual(r.text, BASE + '\nf');
  r = C.decide({ base: BASE, room: BASE, file: 'z\n' + BASE });
  assert.strictEqual(r.action, 'write-room'); assert.strictEqual(r.text, 'z\n' + BASE);
  r = C.decide({ base: BASE, room: 'same', file: 'same' });
  assert.deepStrictEqual(r, { action: 'agree', text: 'same' }, 'both made the same change');
});
test('two-way: both changed → merge, or conflict', function () {
  var room = BASE.replace('a', 'A'), file = BASE.replace('e', 'E');
  var r = C.decide({ base: BASE, room: room, file: file, merge: merge });
  assert.strictEqual(r.action, 'merge'); assert.strictEqual(r.text, 'A\nb\nc\nd\nE');
  r = C.decide({ base: BASE, room: BASE.replace('c', 'C1'), file: BASE.replace('c', 'C2'), merge: merge });
  assert.strictEqual(r.action, 'conflict'); assert.strictEqual(r.keep, 'room');
  assert.strictEqual(r.text, BASE.replace('c', 'C1')); assert.strictEqual(r.other, BASE.replace('c', 'C2'));
  r = C.decide({ base: BASE, room: room, file: file });
  assert.strictEqual(r.action, 'conflict', 'no merge function → keep both');
  // a merge that equals one side is that side's write
  r = C.decide({ base: BASE, room: BASE + '\nx\ny', file: BASE + '\nx', merge: function () { return BASE + '\nx\ny'; } });
  assert.strictEqual(r.action, 'write-file');
  r = C.decide({ base: BASE, room: BASE + '\nx', file: BASE + '\nx\ny', merge: function () { return BASE + '\nx\ny'; } });
  assert.strictEqual(r.action, 'write-room');
});
test('first meeting: create, adopt, or keep both — never overwrite', function () {
  assert.deepStrictEqual(C.decide({ base: null, room: 'hi', file: null }), { action: 'write-file', text: 'hi' });
  assert.deepStrictEqual(C.decide({ base: null, room: 'hi', file: 'hi' }), { action: 'agree', text: 'hi' });
  var r = C.decide({ base: null, room: 'mine', file: 'theirs', merge: merge });
  assert.strictEqual(r.action, 'conflict'); assert.strictEqual(r.text, 'mine'); assert.strictEqual(r.other, 'theirs');
});
test('missing file and gone room', function () {
  assert.deepStrictEqual(C.decide({ base: BASE, room: BASE, file: null }), { action: 'file-missing' });
  assert.deepStrictEqual(C.decide({ base: BASE, room: BASE + 'x', file: null }), { action: 'file-missing' }, 'a deleted file is never recreated behind your back');
  assert.deepStrictEqual(C.decide({ base: BASE, room: null, file: BASE }), { action: 'room-gone' });
  assert.deepStrictEqual(C.decide({ base: BASE, room: null, file: null }), { action: 'none' });
});
test('txt → folder only', function () {
  var o = { direction: 'out', merge: merge };
  var r = C.decide(Object.assign({ base: BASE, room: BASE + '\nf', file: BASE }, o));
  assert.strictEqual(r.action, 'write-file');
  r = C.decide(Object.assign({ base: BASE, room: BASE, file: BASE + '\nedited' }, o));
  assert.deepStrictEqual(r, { action: 'none', skipped: 'file' }, 'file edits are left alone');
  r = C.decide(Object.assign({ base: BASE, room: BASE.replace('a', 'A'), file: BASE.replace('e', 'E') }, o));
  assert.strictEqual(r.action, 'conflict'); assert.strictEqual(r.keep, 'room', 'the file edit is kept as a copy, not merged in');
  r = C.decide(Object.assign({ base: null, room: 'mine', file: 'theirs' }, o));
  assert.strictEqual(r.keep, 'room');
  assert.strictEqual(C.decide(Object.assign({ base: null, room: 'x', file: null }, o)).action, 'write-file');
});
test('folder → txt only', function () {
  var o = { direction: 'in', merge: merge };
  var r = C.decide(Object.assign({ base: BASE, room: BASE, file: BASE + '\nf' }, o));
  assert.strictEqual(r.action, 'write-room');
  r = C.decide(Object.assign({ base: BASE, room: BASE + '\nroom edit', file: BASE }, o));
  assert.deepStrictEqual(r, { action: 'none', skipped: 'room' }, 'room edits don’t touch the file');
  r = C.decide(Object.assign({ base: BASE, room: BASE.replace('a', 'A'), file: BASE.replace('e', 'E') }, o));
  assert.strictEqual(r.action, 'conflict'); assert.strictEqual(r.keep, 'file');
  assert.strictEqual(r.text, BASE.replace('e', 'E')); assert.strictEqual(r.other, BASE.replace('a', 'A'));
  assert.deepStrictEqual(C.decide(Object.assign({ base: null, room: 'x', file: null }, o)), { action: 'none' }, 'rooms don’t make files');
  r = C.decide(Object.assign({ base: null, room: 'mine', file: 'theirs' }, o));
  assert.strictEqual(r.keep, 'file');
});
test('preview rows', function () {
  var rows = [{ room: 'a', text: 'x', fileText: null }, { room: 'b', text: 'x', fileText: 'x' }, { room: 'c', text: 'x', fileText: 'y' }];
  var p = C.previewRows(rows, 'both');
  assert.deepStrictEqual([p.create.length, p.same.length, p.conflict.length, p.skip.length], [1, 1, 1, 0]);
  p = C.previewRows(rows, 'in');
  assert.deepStrictEqual([p.create.length, p.skip.length], [0, 1]);
});

// ---- names for copies --------------------------------------------------------------------------
test('conflict copies and trash names', function () {
  var d = new Date(2026, 9, 22, 9, 5);
  assert.strictEqual(C.stamp(d), '2026-10-22 0905');
  var taken = {};
  var t = function (low) { return !!taken[low]; };
  var p = C.conflictPath('Work/notes.md', d, t);
  assert.strictEqual(p, 'Work/notes (conflict 2026-10-22 0905).md');
  assert.strictEqual(C.parseFileName(C.splitPath(p).name), null, 'a conflict copy is never imported as a room');
  taken[p.toLowerCase()] = 1;
  assert.strictEqual(C.conflictPath('Work/notes.md', d, t), 'Work/notes (conflict 2026-10-22 0905 2).md');
  assert.strictEqual(C.trashPath('Work/notes.md', d, t), '.trash/notes.md');
  taken['.trash/notes.md'] = 1;
  assert.strictEqual(C.trashPath('Work/notes.md', d, t), '.trash/notes (deleted 2026-10-22 0905).md');
});

// ---- scope -------------------------------------------------------------------------------------
test('scope: all, workspaces (with nesting and unlabeled), hand-picked, archived', function () {
  var info = function (archived, chain) { return { archived: !!archived, wsChain: chain || [] }; };
  assert.ok(C.inScope('a', { mode: 'all' }, false, info()));
  assert.ok(!C.inScope('a', { mode: 'all' }, false, info(true)), 'archived rooms only when asked');
  assert.ok(C.inScope('a', { mode: 'all' }, true, info(true)));
  var ws = { mode: 'ws', ws: ['work'] };
  assert.ok(C.inScope('a', ws, false, info(false, ['q3', 'work'])), 'a child workspace of a picked one');
  assert.ok(!C.inScope('a', ws, false, info(false, ['home'])));
  assert.ok(!C.inScope('a', ws, false, info(false, [])));
  assert.ok(C.inScope('a', { mode: 'ws', ws: ['__unlabeled__'] }, false, info(false, [])));
  var picked = { mode: 'rooms', rooms: ['a', 'b'] };
  assert.ok(C.inScope('a', picked, false, info()));
  assert.ok(!C.inScope('c', picked, false, info()));
  assert.ok(!C.inScope('a', picked, false, info(true)), 'archived still needs the option');
});

// ---- polling / log ----------------------------------------------------------------------------
test('polling backs off while quiet; the observer makes it a safety net', function () {
  assert.strictEqual(C.nextDelay(3, 0, false), 3000);
  assert.strictEqual(C.nextDelay(3, 4, false), 3000);
  assert.strictEqual(C.nextDelay(3, 5, false), 6000);
  assert.strictEqual(C.nextDelay(3, 10, false), 12000);
  assert.strictEqual(C.nextDelay(3, 100, false), 30000, 'capped');
  assert.strictEqual(C.nextDelay(10, 100, false), 80000, '8× a slow base');
  assert.strictEqual(C.nextDelay(3, 0, true), 30000);
  assert.strictEqual(C.nextDelay('x', 0, false), 3000, 'bad input → default');
});
test('the log keeps the last 50', function () {
  var log = [];
  for (var i = 0; i < 60; i++) log = C.pushLog(log, { t: i });
  assert.strictEqual(log.length, 50);
  assert.strictEqual(log[0].t, 10);
  assert.strictEqual(log[49].t, 59);
});

// ---- registration ------------------------------------------------------------------------------
test('preferences schema is valid and matches the manifest', function () {
  var w = manifestEntry('mirror');
  assert.ok(w.prefs && Array.isArray(w.prefs.fields));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(w.prefs.fields)), JSON.parse(JSON.stringify(C.PREF_FIELDS)));
  var keys = {};
  C.PREF_FIELDS.forEach(function (f) {
    assert.ok(f.key && f.label && f.type, 'field basics');
    assert.ok(!keys[f.key], 'unique key ' + f.key); keys[f.key] = 1;
    if (f.options) assert.ok(f.options.some(function (o) { return o.value === f.default; }), f.key + ' default is an option');
    if (f.type === 'slider') assert.ok(f.default >= f.min && f.default <= f.max, f.key + ' default in range');
  });
  assert.deepStrictEqual(Object.keys(keys).sort(), ['archived', 'ext', 'front', 'newFiles', 'onDelete', 'poll', 'sub']);
  assert.strictEqual(keys && C.PREF_FIELDS.filter(function (f) { return f.key === 'front'; })[0].default, 'none', 'files stay plain by default');
});
test('widget and plugin register as the manifest says; the plugin is opt-in', function () {
  var w = manifestEntry('mirror'), p = manifestEntry('mirror-run');
  assert.strictEqual(w.type, 'widget');
  assert.strictEqual(p.type, 'plugin'); assert.strictEqual(p.settingKey, 'plugins.mirror-run'); assert.strictEqual(p.default, false); assert.strictEqual(p.section, 'Devices');
  [w.entry, w.css, p.entry].concat(w.precache, p.precache).forEach(function (f) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', f)), 'exists: ' + f);
  });
  var reg = null, plug = null, css = [];
  var fake = {
    Cade: {
      loadCSS: function (c) { css.push(c); }, asset: function (r) { return r; }, baseURL: function () { return './'; },
      registerWidget: function (o) { reg = o; }, registerPlugin: function (o) { plug = o; },
      CM: { ViewPlugin: { define: function (f) { return { __vp: f }; } } }, escapeHtml: String,
    },
    document: { addEventListener: function () {}, removeEventListener: function () {} },
  };
  new Function('window', 'module', 'document', fs.readFileSync(path.join(__dirname, 'mirror.js'), 'utf8'))(fake, undefined, fake.document);
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(reg[k], w[k], k); });
  assert.deepStrictEqual(css, ['mirror.css']);
  assert.strictEqual(typeof reg.open, 'function');
  new Function('window', 'module', 'document', fs.readFileSync(path.join(__dirname, 'mirror-run.js'), 'utf8'))(fake, undefined, fake.document);
  assert.strictEqual(plug.id, 'mirror-run');
  assert.ok(plug.ext && plug.ext.__vp, 'lifetime tied to an editor ViewPlugin');
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'mirror: ' + passed + ' passed');
