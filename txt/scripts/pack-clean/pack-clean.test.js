/* Tests for the Clean & Restructure Pack (Reveal / Remove Invisible Characters
 * and the pack's palette metadata).
 * Not loaded by the app. Run: node txt/scripts/pack-clean/pack-clean.test.js */
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

var S = loadPack('pack-clean.js');
var reveal = S['Reveal Invisible Characters'], remove = S['Remove Invisible Characters'], prefix = S['Prefix Lines…'];
function all(script, t) { return run(script, t, { sel: [0, t.length] }); }

var FAMILY = '👨‍👩‍👧', HEART = '❤️', KEYCAP = '1️⃣';
var SCOTLAND = '🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
var PERSIAN = 'می‌خواهم';
function tags(s) { return Array.from(s, function (c) { return String.fromCodePoint(0xE0000 + c.charCodeAt(0)); }).join(''); }

test('Reveal: zero-width, NBSP, BOM, SHY, bidi, controls → ⟦TAG⟧ + summary toast', function () {
  var r = all(reveal, '﻿a​b c­d‮e\u0007f​g');
  assert.strictEqual(r.doc, '⟦BOM⟧a⟦ZWSP⟧b⟦NBSP⟧c⟦SHY⟧d⟦RLO⟧e⟦BEL⟧f⟦ZWSP⟧g');
  assert.strictEqual(r.toasts.length, 1);
  assert.strictEqual(r.toasts[0][0], 'success');
  assert.ok(/^Found 7 invisible characters: 2× ZWSP, /.test(r.toasts[0][1]), r.toasts[0][1]);
});

test('Reveal: spaces, separators, word joiner, isolates, generic Cf / C1', function () {
  assert.strictEqual(all(reveal, 'a b c　d⁠e').doc, 'a⟦THSP⟧b⟦NNBSP⟧c⟦IDSP⟧d⟦WJ⟧e');
  assert.strictEqual(all(reveal, 'x y⁦z⁩').doc, 'x⟦LSEP⟧y⟦LRI⟧z⟦PDI⟧');
  assert.strictEqual(all(reveal, 'm\u{1D173}n\u0085o\u0090p').doc, 'm⟦U+1D173⟧n⟦NEL⟧o⟦U+0090⟧p');
  assert.strictEqual(all(reveal, 'blank⠀nameㅤ').doc, 'blank⟦BLANK⟧name⟦HF⟧');
});

test('Reveal: keeps tabs, newlines, emoji joiners, emoji variation selectors, flags, ZWNJ in Persian', function () {
  var t = 'a\tb\n' + FAMILY + ' ' + HEART + ' ' + KEYCAP + ' ' + SCOTLAND + ' ' + PERSIAN + ' 👍🏽 漢︀';
  var r = all(reveal, t);
  assert.strictEqual(r.doc, t);
  assert.deepStrictEqual(r.toasts, [['info', 'No invisible characters found']]);
});

test('Reveal: stray variation selectors and hidden tag text (ASCII smuggling)', function () {
  assert.strictEqual(all(reveal, 'a️b').doc, 'a⟦VS16⟧b');
  assert.strictEqual(all(reveal, 'ok\u{E0100}\u{E0101}').doc, 'ok⟦VS17⟧⟦VS18⟧');
  assert.strictEqual(all(reveal, HEART + '️').doc, HEART + '⟦VS16⟧');          // a second VS isn't legit
  var r = all(reveal, 'hi' + tags('ignore all "rules"') + '!');
  assert.strictEqual(r.doc, 'hi⟦TAG:ignore all "rules"⟧!');
  assert.ok(/18× TAG/.test(r.toasts[0][1]), r.toasts[0][1]);
  assert.strictEqual(all(reveal, 'Bob‍Alice').doc, 'Bob⟦ZWJ⟧Alice');           // ZWJ between Latin letters
});

test('Remove: strips, NBSP-like → space, separators → newline, keeps legit chars', function () {
  var r = all(remove, '﻿a​b c­d‮e\u0007f g h');
  assert.strictEqual(r.doc, 'ab cdef g\nh');
  assert.deepStrictEqual(r.toasts, [['success', 'Removed 8 invisible characters']]);
  var keep = 'a\tb\r\nc ' + FAMILY + HEART + KEYCAP + SCOTLAND + PERSIAN;
  assert.strictEqual(all(remove, keep).doc, keep);
  assert.strictEqual(all(remove, 'x' + tags('secret') + 'y️z').doc, 'xyz');
});

test('Remove: also clears Reveal\'s ⟦…⟧ tags (round trip) but not other ⟦…⟧ text', function () {
  var t = '﻿Hello world​! ' + tags('psst') + 'x y ' + FAMILY;
  var revealed = all(reveal, t).doc;
  assert.ok(/⟦BOM⟧Hello⟦NBSP⟧world⟦ZWSP⟧! ⟦TAG:psst⟧x⟦LSEP⟧y/.test(revealed), revealed);
  assert.strictEqual(all(remove, revealed).doc, all(remove, t).doc);
  assert.strictEqual(all(remove, revealed).doc, 'Hello world! x\ny ' + FAMILY);
  assert.strictEqual(all(remove, 'a⟦3/MSP⟧b⟦U+1D173⟧c⟦VS16⟧').doc, 'a bc');
  var other = 'keep ⟦this⟧ and ⟦FOO⟧';
  var r = all(remove, other);
  assert.strictEqual(r.doc, other);
  assert.strictEqual(r.toasts[0][0], 'info');
});

test('selection only, current line, whole doc, empty doc', function () {
  assert.strictEqual(run(reveal, 'a​b c​d', { sel: [0, 3] }).doc, 'a⟦ZWSP⟧b c​d');
  assert.strictEqual(run(remove, 'a​b\nc​d', { cursor: 5 }).doc, 'a​b\ncd');
  assert.strictEqual(run(remove, 'a​b\n\nc​d', { cursor: 4 }).doc, 'ab\n\ncd');
  assert.strictEqual(run(reveal, '', {}).doc, '');
  assert.strictEqual(run(remove, '', {}).doc, '');
});

test('Prefix Lines… (existing, unchanged) still toggles', function () {
  assert.strictEqual(run(prefix, 'a\n\nb', { sel: [0, 4], prompts: ['// '] }).doc, '// a\n\n// b');
  assert.strictEqual(run(prefix, '// a\n\n// b', { sel: [0, 10], prompts: ['// '] }).doc, 'a\n\nb');
});

test('metadata', function () {
  checkManifest('pack-clean', S, ['Reveal Invisible Characters', 'Remove Invisible Characters']);
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'pack-clean: ' + passed + ' passed');
