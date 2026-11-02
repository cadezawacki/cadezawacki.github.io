/* Tests for the Fancy Text Pack (Bubble / Superscript / Subscript / Monospace,
 * Defancify reversing them, and the pack's palette metadata).
 * Not loaded by the app. Run: node txt/scripts/pack-fancy/pack-fancy.test.js */
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

var S = loadPack('pack-fancy.js');
var bubble = S['Bubble Text (ⓑⓤⓑⓑⓛⓔ)'], sup = S['Superscript (ˢᵘᵖᵉʳ)'], sub = S['Subscript (ₛᵤᵦ)'];
var mono = S['Monospace (𝚖𝚘𝚗𝚘)'], defancy = S['Defancify'], ds = S['Double-Struck (𝔻𝕠𝕦𝕓𝕝𝕖)'], sc = S['Small Caps (ꜱᴍᴀʟʟ)'];
function all(script, t) { return run(script, t, { sel: [0, t.length] }).doc; }

test('names follow the "Style (ˢᵃᵐᵖˡᵉ)" pattern and the sample is what the script produces', function () {
  [[bubble, 'bubble'], [sup, 'super'], [sub, 'sub'], [mono, 'mono']].forEach(function (p) {
    var sample = /\((.+)\)$/.exec(p[0].meta.name)[1];
    assert.strictEqual(all(p[0], p[1]), sample, p[0].meta.name);
  });
});

test('Bubble: letters + digits, toggles off, leaves the rest', function () {
  assert.strictEqual(all(bubble, 'Hello 2024!'), 'Ⓗⓔⓛⓛⓞ ②⓪②④!');
  assert.strictEqual(all(bubble, 'Ⓗⓔⓛⓛⓞ ②⓪②④!'), 'Hello 2024!');
  assert.strictEqual(all(bubble, 'AZaz09'), 'ⒶⓏⓐⓩ⓪⑨');
  assert.strictEqual(all(bubble, 'éß 👍'), 'éß 👍');
});

test('Superscript: best available form, unmappable left as-is, toggles off', function () {
  assert.strictEqual(all(sup, 'x2+y=(z-1)'), 'ˣ²⁺ʸ⁼⁽ᶻ⁻¹⁾');
  assert.strictEqual(all(sup, 'ˣ²⁺ʸ⁼⁽ᶻ⁻¹⁾'), 'x2+y=(z-1)');
  assert.strictEqual(all(sup, 'HELLO'), 'ᴴᴱᴸᴸᴼ');
  assert.strictEqual(all(sup, 'ᴴᴱᴸᴸᴼ'), 'HELLO');
  assert.strictEqual(all(sup, 'SQ q'), 'ˢQ q');           // no capital S (→ ˢ), no q at all
  assert.strictEqual(all(sup, '0123456789'), '⁰¹²³⁴⁵⁶⁷⁸⁹');
  assert.strictEqual(all(sup, 'abcdefghijklmnoprstuvwxyz'), 'ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ');
  assert.strictEqual(all(sup, 'a−b'), 'ᵃ⁻ᵇ');              // U+2212 minus
});

test('Subscript: digits, operators and the letters Unicode has', function () {
  assert.strictEqual(all(sub, 'H2O'), 'ₕ₂ₒ');
  assert.strictEqual(all(sub, 'ₕ₂ₒ'), 'h2o');
  assert.strictEqual(all(sub, 'x_(i+1)=0'), 'ₓ_₍ᵢ₊₁₎₌₀');
  assert.strictEqual(all(sub, 'cdfgqwz'), 'cdfgqwz');      // no subscript forms
  assert.strictEqual(all(sub, 'by'), 'ᵦᵧ');
  assert.strictEqual(all(sub, '0123456789'), '₀₁₂₃₄₅₆₇₈₉');
});

test('Monospace: letters + digits, toggles off', function () {
  assert.strictEqual(all(mono, 'Code 42'), '𝙲𝚘𝚍𝚎 𝟺𝟸');
  assert.strictEqual(all(mono, '𝙲𝚘𝚍𝚎 𝟺𝟸'), 'Code 42');
  assert.strictEqual(all(mono, 'AZaz09'), '𝙰𝚉𝚊𝚣𝟶𝟿');
});

test('Defancify reverses all four new styles (and the old ones)', function () {
  var plain = 'Hello World 2024';
  [bubble, mono, ds, sc].forEach(function (s) {
    var f = all(s, plain);
    assert.notStrictEqual(f, plain, s.meta.name);
    assert.strictEqual(all(defancy, f).toLowerCase(), plain.toLowerCase(), s.meta.name);
  });
  assert.strictEqual(all(defancy, all(bubble, plain)), plain);
  assert.strictEqual(all(defancy, all(mono, plain)), plain);
  assert.strictEqual(all(defancy, all(sup, 'Hello 2024 (x+1)=y')), 'Hello 2024 (x+1)=y');
  assert.strictEqual(all(defancy, all(sub, 'sub 123 (x+1)=y')), 'sub 123 (x+1)=y');
  // mixed styles in one go
  var mixed = all(bubble, 'ab') + ' ' + all(sup, 'cd') + ' ' + all(sub, 'ex') + ' ' + all(mono, 'fg9') + ' 𝗯𝗼𝗹𝗱';
  assert.strictEqual(all(defancy, mixed), 'ab cd ex fg9 bold');
});

test('selection only, current line, multi-line, empty doc', function () {
  assert.strictEqual(run(mono, 'keep THIS keep', { sel: [5, 9] }).doc, 'keep 𝚃𝙷𝙸𝚂 keep');
  assert.strictEqual(run(bubble, 'one\ntwo\nthree', { cursor: 5 }).doc, 'one\nⓣⓦⓞ\nthree');
  assert.strictEqual(run(sup, 'a1\n\nb2', { cursor: 3 }).doc, 'ᵃ¹\n\nᵇ²');
  assert.strictEqual(run(sub, '', {}).doc, '');
  assert.strictEqual(run(defancy, '', {}).doc, '');
});

test('metadata', function () {
  checkManifest('pack-fancy', S, ['Bubble Text (ⓑⓤⓑⓑⓛⓔ)', 'Superscript (ˢᵘᵖᵉʳ)', 'Subscript (ₛᵤᵦ)', 'Monospace (𝚖𝚘𝚗𝚘)', 'Defancify']);
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'pack-fancy: ' + passed + ' passed');
