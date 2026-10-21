/* Checks for the Widget preferences core (PrefsCore in txt.html, lifted out
 * between the `// <prefs-core>` markers so this tests the live code): field
 * normalisation, coercion / validation of every field type, defaults, the
 * stored diff, showIf, the dropdown order, the initial page, the sync merge
 * (per-page last-writer-wins + the account-wide sync flag) and every manifest
 * "prefs" block. Run: node txt/widgets/prefs/prefs.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..', '..', '..');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

var html = fs.readFileSync(path.join(ROOT, 'txt.html'), 'utf8');
var a = html.indexOf('// <prefs-core>'), b = html.indexOf('// </prefs-core>');
assert.ok(a > 0 && b > a, 'prefs-core markers in txt.html');
var C = new Function(html.slice(a, b) + '\nreturn PrefsCore;')();

var ALL = C.normSpec('demo', {
  title: 'Demo', icon: '★',
  fields: [
    { type: 'heading', label: 'Basics' },
    { key: 'name', type: 'text', label: 'Name', default: 'Ann', maxLength: 5 },
    { key: 'notes', type: 'textarea', label: 'Notes', default: '' },
    { key: 'n', type: 'number', label: 'N', default: 2, min: 1, max: 5, step: 1 },
    { key: 'wpm', type: 'slider', label: 'Speed', default: 350, min: 100, max: 1000, step: 25, unit: 'wpm' },
    { key: 'f', type: 'slider', label: 'Fine', default: 0.3, min: 0, max: 1, step: 0.1 },
    { key: 'ctx', type: 'toggle', label: 'Ctx', default: true },
    { key: 'dim', type: 'slider', label: 'Dim', default: 25, min: 0, max: 100, step: 5, unit: '%', showIf: 'ctx' },
    { key: 'alt', type: 'text', label: 'Alt', default: '', showIf: '!ctx' },
    { key: 'look', type: 'radio', label: 'Look', default: 'focus', options: [{ value: 'focus', label: 'Focus' }, { value: 'page', label: 'Page' }] },
    { key: 'pick', type: 'select', label: 'Pick', default: 2, options: [{ value: 1, label: 'One' }, { value: 2, label: 'Two' }] },
    { key: 'langs', type: 'checkbox', label: 'Langs', default: ['js'], options: [{ value: 'py', label: 'Python' }, { value: 'js', label: 'JS' }, { value: 'sh', label: 'Shell' }] },
    { key: 'when', type: 'date', label: 'When', default: '' },
    { key: 'at', type: 'time', label: 'At', default: '09:00' },
    { key: 'tint', type: 'color', label: 'Tint', default: '#2A9D8F' },
    { key: 'bad', type: 'wat', label: 'Unknown type' },
    { type: 'text', label: 'No key' },
    { key: 'n', type: 'text', label: 'Duplicate key' },
    { key: 'noopts', type: 'radio', label: 'No options' },
  ],
});
var F = ALL.keys;

test('normSpec keeps valid fields, drops bad ones, fills title/icon', function () {
  assert.strictEqual(ALL.title, 'Demo');
  assert.strictEqual(ALL.icon, '★');
  assert.deepStrictEqual(ALL.fields.map(function (f) { return f.key || '#' + f.type; }),
    ['#heading', 'name', 'notes', 'n', 'wpm', 'f', 'ctx', 'dim', 'alt', 'look', 'pick', 'langs', 'when', 'at', 'tint']);
  assert.strictEqual(F.n.type, 'number', 'first of a duplicate key wins');
  var s = C.normSpec('x', { fields: [] }, { name: 'From manifest', icon: '⚙' });
  assert.strictEqual(s.title, 'From manifest');
  assert.strictEqual(s.icon, '⚙');
  assert.strictEqual(C.normSpec('y', null).title, 'y');
  assert.strictEqual(F.tint.default, '#2a9d8f', 'defaults are coerced too');
});

test('coercion: text / textarea', function () {
  assert.strictEqual(C.coerce(F.name, 'Barbara'), 'Barba', 'maxLength');
  assert.strictEqual(C.coerce(F.name, 'a\nb'), 'a b', 'single line');
  assert.strictEqual(C.coerce(F.notes, 'a\nb'), 'a\nb');
  assert.strictEqual(C.coerce(F.name, 42), '42');
  assert.strictEqual(C.coerce(F.name, {}), undefined);
  assert.strictEqual(C.coerce(F.name, null), undefined);
});

test('coercion: number / slider clamp + step', function () {
  assert.strictEqual(C.coerce(F.n, 9), 5);
  assert.strictEqual(C.coerce(F.n, -3), 1);
  assert.strictEqual(C.coerce(F.n, '3'), 3);
  assert.strictEqual(C.coerce(F.n, 2.6), 3);
  assert.strictEqual(C.coerce(F.n, 'x'), undefined);
  assert.strictEqual(C.coerce(F.n, ''), undefined);
  assert.strictEqual(C.coerce(F.n, true), undefined);
  assert.strictEqual(C.coerce(F.n, Infinity), undefined);
  assert.strictEqual(C.coerce(F.wpm, 362), 350);
  assert.strictEqual(C.coerce(F.wpm, 363), 375);
  assert.strictEqual(C.coerce(F.wpm, 5000), 1000);
  assert.strictEqual(C.coerce(F.f, 0.35), 0.4, 'float step without drift');
  assert.strictEqual(C.coerce(F.f, 0.7000000001), 0.7);
  var odd = C.normField({ key: 'o', type: 'number', min: 0, max: 10, step: 4 });
  assert.strictEqual(C.coerce(odd, 10), 8, 'stepping never passes max');
  var free = C.normField({ key: 'o', type: 'number' });
  assert.strictEqual(C.coerce(free, 3.14159), 3.14159, 'no step: any value');
  assert.strictEqual(free.default, 0);
  var sl = C.normField({ key: 's', type: 'slider' });
  assert.deepStrictEqual([sl.min, sl.max, sl.step, sl.default], [0, 100, 1, 0], 'slider defaults');
  var swapped = C.normField({ key: 's', type: 'number', min: 10, max: 1 });
  assert.deepStrictEqual([swapped.min, swapped.max], [1, 10]);
});

test('coercion: toggle / radio / select / checkbox', function () {
  assert.strictEqual(C.coerce(F.ctx, 'false'), false);
  assert.strictEqual(C.coerce(F.ctx, 1), true);
  assert.strictEqual(C.coerce(F.ctx, 'yes'), undefined);
  assert.strictEqual(C.coerce(F.look, 'page'), 'page');
  assert.strictEqual(C.coerce(F.look, 'nope'), undefined);
  assert.strictEqual(C.coerce(F.pick, '1'), 1, 'option value keeps its own type');
  assert.strictEqual(C.coerce(F.pick, 3), undefined);
  assert.deepStrictEqual(C.coerce(F.langs, ['sh', 'py', 'zz', 'py']), ['py', 'sh'], 'members only, deduped, option order');
  assert.deepStrictEqual(C.coerce(F.langs, []), []);
  assert.strictEqual(C.coerce(F.langs, 'js'), undefined);
  var sel = C.normField({ key: 'q', type: 'select', options: ['a', 'b'] });
  assert.deepStrictEqual(sel.options, [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }], 'plain option values');
  assert.strictEqual(sel.default, 'a', 'no default: first option');
});

test('coercion: date / time / color formats', function () {
  assert.strictEqual(C.coerce(F.when, '2026-02-28'), '2026-02-28');
  assert.strictEqual(C.coerce(F.when, '2026-02-30'), undefined);
  assert.strictEqual(C.coerce(F.when, '2026-2-3'), undefined);
  assert.strictEqual(C.coerce(F.when, ''), '');
  assert.strictEqual(C.coerce(F.at, '9:05'), '09:05');
  assert.strictEqual(C.coerce(F.at, '23:59:30'), '23:59');
  assert.strictEqual(C.coerce(F.at, '24:00'), undefined);
  assert.strictEqual(C.coerce(F.at, 'noon'), undefined);
  assert.strictEqual(C.coerce(F.tint, '#ABC'), '#aabbcc');
  assert.strictEqual(C.coerce(F.tint, 'ff0000'), '#ff0000');
  assert.strictEqual(C.coerce(F.tint, 'red'), undefined);
});

test('valuesOf fills defaults, ignores invalid stored values; diffOf keeps only changes', function () {
  var v = C.valuesOf(ALL, { n: 4, wpm: 'fast', langs: ['py'], tint: '#2A9D8F', stray: 1 });
  assert.strictEqual(v.n, 4);
  assert.strictEqual(v.wpm, 350, 'invalid stored value → default');
  assert.deepStrictEqual(v.langs, ['py']);
  assert.strictEqual(v.name, 'Ann');
  assert.ok(!('stray' in v));
  assert.deepStrictEqual(Object.keys(v).length, 14);
  assert.deepStrictEqual(C.diffOf(ALL, v), { n: 4, langs: ['py'] });
  assert.deepStrictEqual(C.diffOf(ALL, C.valuesOf(ALL, {})), {});
  v.langs.push('sh');
  assert.deepStrictEqual(F.langs.default, ['js'], 'defaults are copied, not shared');
  assert.deepStrictEqual(C.changedKeys({ a: 1, b: [1] }, { a: 1, b: [1, 2], c: 0 }), ['b', 'c']);
});

test('showIf on / off', function () {
  assert.strictEqual(C.visible(F.dim, { ctx: true }), true);
  assert.strictEqual(C.visible(F.dim, { ctx: false }), false);
  assert.strictEqual(C.visible(F.alt, { ctx: false }), true);
  assert.strictEqual(C.visible(F.alt, { ctx: true }), false);
  assert.strictEqual(C.visible(F.n, {}), true);
  assert.strictEqual(C.visible({ showIf: 'missing' }, { ctx: true }), true, 'unknown key: shown');
});

test('dropdown order: open first (most recent first), then alphabetical', function () {
  var pages = [{ id: 'sr', title: 'Speed Reader' }, { id: 'codeblocks', title: 'Code blocks' }, { id: 'tw', title: 'typewriter sounds' }, { id: 'ab', title: 'Alpha' }];
  var l = C.orderPages(pages, ['tw', 'nope', 'sr', 'tw']);
  assert.deepStrictEqual(l.map(function (p) { return p.id + (p.open ? '*' : ''); }), ['tw*', 'sr*', 'ab', 'codeblocks']);
  assert.deepStrictEqual(C.orderPages(pages, []).map(function (p) { return p.id; }), ['ab', 'codeblocks', 'sr', 'tw'], 'case-insensitive');
});

test('initial page: asked > focused > open > last viewed > first', function () {
  var l = C.orderPages([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }], ['c', 'b']);
  assert.strictEqual(C.pickInitial(l, { want: 'a', focused: 'b' }), 'a');
  assert.strictEqual(C.pickInitial(l, { want: 'zz', focused: 'b' }), 'b');
  assert.strictEqual(C.pickInitial(l, { last: 'a' }), 'c', 'topmost open widget');
  var closed = C.orderPages([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], []);
  assert.strictEqual(C.pickInitial(closed, { last: 'b' }), 'b');
  assert.strictEqual(C.pickInitial(closed, { last: 'gone' }), 'a');
  assert.strictEqual(C.pickInitial([], {}), null);
});

test('sync merge: flag spreads, newer values win per page, newer local is re-published', function () {
  // Another device turned sync on for "a" with its values.
  var r = C.syncMerge({}, { a: { on: true, fat: 10, at: 10, values: { n: 3 } } });
  assert.deepStrictEqual(r.meta.a, { on: true, fat: 10, at: 10 });
  assert.deepStrictEqual(r.adopt, { a: { n: 3 } });
  assert.strictEqual(r.push, false);
  // Older remote values don't overwrite newer local ones — and we re-publish.
  r = C.syncMerge({ a: { on: true, fat: 10, at: 20 } }, { a: { on: true, fat: 10, at: 15, values: { n: 1 } } });
  assert.deepStrictEqual(r.adopt, {});
  assert.strictEqual(r.push, true);
  // Turned off elsewhere (newer flag): off here too, values kept.
  r = C.syncMerge({ a: { on: true, fat: 10, at: 20 } }, { a: { on: false, fat: 30, at: 20, values: { n: 9 } } });
  assert.strictEqual(r.meta.a.on, false);
  assert.deepStrictEqual(r.adopt, {});
  // A page only this device synced (lost in a concurrent whole-blob write) is re-published.
  r = C.syncMerge({ b: { on: true, fat: 5, at: 5 } }, { a: { on: true, fat: 10, at: 10, values: {} } });
  assert.strictEqual(r.push, true);
  // Never-synced local pages stay out of it; junk is ignored.
  r = C.syncMerge({ c: { on: false, fat: 0, at: 0 } }, { x: 'junk', y: null });
  assert.strictEqual(r.push, false);
  assert.deepStrictEqual(C.syncMerge(null, null), { meta: {}, adopt: {}, push: false });
});

test('buildBlob writes only what this device holds newer', function () {
  var remote = { a: { on: true, fat: 10, at: 10, values: { n: 3 } }, z: { on: true, fat: 1, at: 1, values: { k: 1 } } };
  var meta = { a: { on: true, fat: 10, at: 20 }, b: { on: true, fat: 15, at: 15 }, c: { on: false, fat: 0, at: 0 }, d: { on: false, fat: 1, at: 0 } };
  var out = C.buildBlob(remote, meta, { a: { n: 4 }, b: { m: 1 }, c: { x: 1 }, d: {} });
  assert.deepStrictEqual(out.a, { on: true, fat: 10, at: 20, values: { n: 4 } });
  assert.deepStrictEqual(out.b, { on: true, fat: 15, at: 15, values: { m: 1 } });
  assert.ok(!('c' in out), 'never synced');
  assert.deepStrictEqual(out.d, { on: false, fat: 1, at: 0, values: {} }, 'an "off" spreads too');
  assert.deepStrictEqual(out.z, remote.z, "other devices' pages kept");
  assert.deepStrictEqual(C.buildBlob(out, meta, { a: { n: 4 }, b: { m: 1 }, d: {} }), out, 'stable: publishing again changes nothing');
  // Round trip: a device merging what we published adopts our values and has nothing to push.
  var r = C.syncMerge({}, out);
  assert.deepStrictEqual(r.adopt.a, { n: 4 });
  assert.strictEqual(r.push, false);
});

test('every manifest "prefs" block is valid', function () {
  var man = JSON.parse(fs.readFileSync(path.join(ROOT, 'txt', 'manifest.json'), 'utf8'));
  var n = 0;
  man.modules.forEach(function (m) {
    if (!m.prefs) return;
    n++;
    assert.ok(Array.isArray(m.prefs.fields) && m.prefs.fields.length, m.id + ': fields');
    var s = C.normSpec(m.id, m.prefs, m);
    assert.strictEqual(s.fields.length, m.prefs.fields.length, m.id + ': every field usable (type, key, options, unique keys)');
    m.prefs.fields.forEach(function (f) {
      if (!f.key) return;
      assert.ok(C.coerce(s.keys[f.key], f.default) !== undefined, m.id + '.' + f.key + ': default is valid');
      if (f.showIf) {
        var k = f.showIf.replace(/^!/, '');
        assert.ok(s.keys[k] && s.keys[k].type === 'toggle', m.id + '.' + f.key + ': showIf names a toggle');
      }
    });
  });
  assert.ok(n >= 1, 'at least typewriter has prefs');
});

test('the core page and API are wired in txt.html', function () {
  assert.ok(/define\('codeblocks', \{[\s\S]{0,200}title: 'Code blocks'/.test(html), 'Code blocks page');
  assert.ok(html.indexOf("key: 'linked', type: 'toggle'") > 0);
  assert.ok(/onclick="openWidgetPrefs\(\)"[^>]*>\s*<span>Widget preferences…<\/span>/.test(html), 'View menu item');
  assert.ok(/<span>Import Text…<\/span>/.test(html) && html.indexOf('<span>Import Files…</span>') < 0, 'Import Text label');
  assert.ok(html.indexOf("'importFiles': 'Import Text'") > 0, 'hotkey label (same id)');
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'prefs: ' + passed + ' passed');
