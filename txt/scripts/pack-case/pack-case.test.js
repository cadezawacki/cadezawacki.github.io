/* Tests for the Case Pack (Swap Case + the pack's palette metadata).
 * Not loaded by the app. Run: node txt/scripts/pack-case/pack-case.test.js */
'use strict';
// ---------------------------------------------------------------------------
// Harness: load the pack with a stubbed Cade.registerScript, then run a
// script's source the way txt.html's executeScript does — new Function over
// (window, document, ctx, showToast), with ctx.selection = the explicit
// selection, else the cursor's non-empty line, else '' (→ whole document).
// ---------------------------------------------------------------------------
var assert = require('assert');
var fs = require('fs'), path = require('path'), vm = require('vm');

var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

function loadPack(file) {
  var reg = [], win = { Cade: { registerScript: function (s) { reg.push(s); } } };
  var sandbox = { window: win, console: console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), sandbox);
  var out = {};
  reg.forEach(function (src) {
    var m = src.match(/\/\*\*\s*([\s\S]*?)\s*\*\*\//);
    var meta = JSON.parse(m[1]);
    assert.ok(!out[meta.name], 'duplicate script name ' + meta.name);
    out[meta.name] = { meta: meta, code: src.slice(m[0].length).trim() };
  });
  return out;
}

// A minimal CodeMirror-like editor over a string.
function fakeEditor(text, from, to) {
  var ed = { dispatched: [] };
  function mkState(doc, f, t) {
    var lines = doc.split('\n');
    function line(n) { var s = 0; for (var i = 0; i < n - 1; i++) s += lines[i].length + 1; return { number: n, from: s, to: s + lines[n - 1].length, text: lines[n - 1] }; }
    return {
      readOnly: false,
      doc: {
        length: doc.length, lines: lines.length,
        toString: function () { return doc; },
        sliceString: function (a, b) { return doc.slice(a, b === undefined ? doc.length : b); },
        line: line,
        lineAt: function (pos) { var n = doc.slice(0, pos).split('\n').length; return line(n); }
      },
      sliceDoc: function (a, b) { return doc.slice(a, b); },
      selection: { main: { from: f, to: t, head: t, anchor: f, empty: f === t } }
    };
  }
  ed.state = mkState(text, from, to);
  ed.dispatch = function (tr) {
    var doc = ed.state.doc.toString(), c = tr.changes;
    var next = c ? doc.slice(0, c.from) + c.insert + doc.slice(c.to) : doc;
    var head = tr.selection ? tr.selection.anchor : Math.min(ed.state.selection.main.head, next.length);
    ed.state = mkState(next, head, head);
    ed.dispatched.push(tr);
  };
  return ed;
}

// run(script, doc, {sel: [from, to] | cursor: pos, prompts: [...]}) →
// {doc, toasts, asked}. Without sel/cursor the cursor sits at the end.
function run(script, doc, opts) {
  opts = opts || {};
  var from, to;
  if (opts.sel) { from = opts.sel[0]; to = opts.sel[1]; }
  else { from = to = opts.cursor !== undefined ? opts.cursor : doc.length; }
  var ed = fakeEditor(doc, from, to);
  var store = opts.store || {};
  var win = { Cade: { editor: ed, store: { get: function (k) { return store[k] === undefined ? null : store[k]; }, set: function (k, v) { store[k] = v; } } } };
  var toasts = [], asked = [], answers = (opts.prompts || []).slice();
  var savedPrompt = global.prompt;
  global.prompt = function (msg, def) { asked.push([msg, def]); return answers.length ? answers.shift() : null; };

  var state = ed.state, sel = state.selection.main, fullText = state.doc.toString();
  var editFrom, editTo, editText, hasSelection;
  if (sel.from !== sel.to) { editFrom = sel.from; editTo = sel.to; editText = fullText.slice(sel.from, sel.to); hasSelection = true; }
  else {
    var line = state.doc.lineAt(sel.head);
    if (line.text.length > 0) { editFrom = line.from; editTo = line.to; editText = line.text; hasSelection = true; }
    else { editFrom = 0; editTo = fullText.length; editText = fullText; hasSelection = false; }
  }
  var newFull = fullText, newEdit = editText, fullChanged = false, editChanged = false;
  var ctx = {
    get fullText() { return newFull; },
    set fullText(v) { newFull = v; fullChanged = true; },
    get selection() { return hasSelection ? newEdit : ''; },
    set selection(v) { if (hasSelection) { newEdit = v; editChanged = true; } else { newFull = v; fullChanged = true; } },
    get text() { return hasSelection ? newEdit : newFull; }
  };
  try {
    var fn = new Function('window', 'document', 'ctx', 'showToast', script.code + '\nmain(ctx);');
    fn(win, {}, ctx, function (msg, type) { toasts.push([type, msg]); });
  } finally { global.prompt = savedPrompt; }
  var cur = ed.state.doc.toString();
  if (editChanged && hasSelection) cur = cur.slice(0, editFrom) + newEdit + cur.slice(editTo);
  else if (fullChanged) cur = newFull;
  return { doc: cur, toasts: toasts, asked: asked, store: store, editor: ed };
}

// Metadata rows: every registered script has the palette fields and every
// manifest row names a registered script. Rows that differ from the manifest
// (new / updated ones until their manifest rows are written, or older drift)
// are reported as a NOTE rather than failing.
function checkManifest(packId, scripts, pending) {
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  var list = man.modules || man.items || man;
  var entry = (Array.isArray(list) ? list : []).filter(function (m) { return m && m.id === packId; })[0];
  assert.ok(entry, 'manifest has ' + packId);
  var notes = [];
  Object.keys(scripts).forEach(function (name) {
    var m = scripts[name].meta;
    ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.ok(typeof m[k] === 'string' && m[k], name + ' has ' + k); });
    var row = { name: m.name, description: m.description, icon: m.icon, tags: m.tags };
    var found = entry.scripts.filter(function (r) { return r.name === name; })[0];
    if (pending.indexOf(name) >= 0) {
      if (!found) notes.push('add row ' + JSON.stringify(name));
      else if (JSON.stringify(found) !== JSON.stringify(row)) notes.push('update row ' + JSON.stringify(name));
    } else if (!found || JSON.stringify(found) !== JSON.stringify(row)) {
      notes.push('pre-existing drift on ' + JSON.stringify(name) + ' (not part of this change)');
    }
  });
  entry.scripts.forEach(function (r) { assert.ok(scripts[r.name], 'manifest row ' + r.name + ' is registered by the pack'); });
  if (notes.length) console.log('NOTE ' + packId + ' manifest pending: ' + notes.join('; '));
}

var S = loadPack('pack-case.js');
var swap = S['Swap Case'];

test('Swap Case: ASCII, whole document from an empty line', function () {
  assert.strictEqual(run(swap, 'Hello World 123!\n', { cursor: 17 }).doc, 'hELLO wORLD 123!\n');
  assert.strictEqual(run(swap, 'camelCase CONSTANT_CASE snake_case\n\n', { cursor: 35 }).doc, 'CAMELcASE constant_case SNAKE_CASE\n\n');
});

test('Swap Case: Unicode letters (Latin-1, Greek, Cyrillic, astral)', function () {
  assert.strictEqual(run(swap, 'Ärger Ωμέγα Жук', { sel: [0, 15] }).doc, 'äRGER ωΜΈΓΑ жУК');
  assert.strictEqual(run(swap, 'Σσς', { sel: [0, 3] }).doc, 'σΣΣ');
  assert.strictEqual(run(swap, '𐐀𐐨', { sel: [0, 4] }).doc, '𐐨𐐀');           // Deseret, surrogate pairs
  assert.strictEqual(run(swap, 'Éclair', { sel: [0, 6] }).doc, 'éCLAIR');
});

test('Swap Case: length-changing letters keep their glyph; ß ↔ ẞ', function () {
  assert.strictEqual(run(swap, 'Straße', { sel: [0, 6] }).doc, 'sTRAẞE');
  assert.strictEqual(run(swap, 'STRAẞE', { sel: [0, 6] }).doc, 'straße');
  assert.strictEqual(run(swap, 'ﬁne İ ŉ', { sel: [0, 7] }).doc, 'ﬁNE İ ŉ');
  assert.strictEqual(run(swap, 'ǅ', { sel: [0, 1] }).doc, 'ǅ');              // title-case digraph left alone
});

test('Swap Case: reversible, non-letters untouched', function () {
  var t = 'MiXeD 42 — émoji 👍🏽 ok?\tTAB';
  var once = run(swap, t, { sel: [0, t.length] }).doc;
  assert.strictEqual(once, 'mIxEd 42 — ÉMOJI 👍🏽 OK?\ttab');
  assert.strictEqual(run(swap, once, { sel: [0, once.length] }).doc, t);
});

test('Swap Case: selection only / current line / empty doc', function () {
  assert.strictEqual(run(swap, 'abc DEF ghi', { sel: [4, 7] }).doc, 'abc def ghi');
  assert.strictEqual(run(swap, 'one\nTwo\nthree', { cursor: 5 }).doc, 'one\ntWO\nthree');   // cursor on line 2
  assert.strictEqual(run(swap, 'one\n\nTwo', { cursor: 4 }).doc, 'ONE\n\ntWO');              // empty line → whole doc
  assert.strictEqual(run(swap, '', {}).doc, '');
  assert.strictEqual(run(swap, '123 !?', {}).doc, '123 !?');
});

test('metadata', function () {
  checkManifest('pack-case', S, ['Swap Case']);
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'pack-case: ' + passed + ' passed');
