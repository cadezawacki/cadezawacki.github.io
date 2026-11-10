/* Checks for Mobile keys: the Ctrl / Shift tap states (one-shot, double-tap
 * lock, off), which keys can be re-sent, how a typed edit maps back to a key,
 * the Ctrl/Meta platform split, pad clamping and the manifest entry.
 * Not loaded by the app. Run: node txt/widgets/modkeys/modkeys.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var T = require('./modkeys.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

test('tap: off → once → (double tap) lock → off', function () {
  var s = T.modTap(null, 1000);
  assert.strictEqual(s.mode, 'once');
  s = T.modTap(s, 1000 + T.CFG.dblTap);
  assert.strictEqual(s.mode, 'lock');
  s = T.modTap(s, 5000);
  assert.strictEqual(s.mode, 'off');
});
test('tap: a slow second tap turns a one-shot off instead of locking', function () {
  var s = T.modTap({ mode: 'off', at: 0 }, 1000);
  s = T.modTap(s, 1000 + T.CFG.dblTap + 1);
  assert.strictEqual(s.mode, 'off');
});
test('tap: a lock always turns off on the next tap, however quick', function () {
  var s = T.modTap(T.modTap({ mode: 'off', at: 0 }, 10), 20);
  assert.strictEqual(s.mode, 'lock');
  assert.strictEqual(T.modTap(s, 30).mode, 'off');
});
test('used: a one-shot clears after a key, a lock stays', function () {
  assert.strictEqual(T.modUsed({ mode: 'once', at: 1 }).mode, 'off');
  assert.strictEqual(T.modUsed({ mode: 'lock', at: 1 }).mode, 'lock');
  assert.strictEqual(T.modUsed({ mode: 'off', at: 1 }).mode, 'off');
});
test('usableKey: real keys yes; IME placeholders and modifier keys no', function () {
  ['a', 'Z', '1', '/', ' ', 'Enter', 'Backspace', 'Tab', 'ArrowLeft'].forEach(function (k) { assert.ok(T.usableKey(k, 65), k); });
  assert.ok(!T.usableKey('a', 229), 'keyCode 229 = composing');
  ['Unidentified', 'Process', 'Dead', 'Shift', 'Control', 'Meta', 'Alt', '', null, undefined].forEach(function (k) { assert.ok(!T.usableKey(k, 0), String(k)); });
});
test('keyFromInput: beforeinput types map to keys', function () {
  assert.strictEqual(T.keyFromInput('insertText', 'z'), 'z');
  assert.strictEqual(T.keyFromInput('insertText', 'hello'), 'o', 'the last character typed');
  assert.strictEqual(T.keyFromInput('insertCompositionText', 'hel'), 'l');
  assert.strictEqual(T.keyFromInput('insertParagraph', null), 'Enter');
  assert.strictEqual(T.keyFromInput('insertLineBreak', null), 'Enter');
  assert.strictEqual(T.keyFromInput('deleteContentBackward', null), 'Backspace');
  assert.strictEqual(T.keyFromInput('deleteContentForward', null), 'Delete');
  assert.strictEqual(T.keyFromInput('insertFromPaste', 'x'), null, 'pastes are not key presses');
  assert.strictEqual(T.keyFromInput('insertText', ''), null);
});
test('lastChar: newline / tab become Enter / Tab; emoji stay whole', function () {
  assert.strictEqual(T.lastChar('ab\n'), 'Enter');
  assert.strictEqual(T.lastChar('\t'), 'Tab');
  assert.strictEqual(T.lastChar('a😀'), '😀');
  assert.strictEqual(T.lastChar(''), null);
});
test('codeFor / keyCodeFor: letters, digits and named keys', function () {
  assert.strictEqual(T.codeFor('b'), 'KeyB');
  assert.strictEqual(T.codeFor('B'), 'KeyB');
  assert.strictEqual(T.codeFor('7'), 'Digit7');
  assert.strictEqual(T.codeFor('ArrowUp'), 'ArrowUp');
  assert.strictEqual(T.codeFor('/'), 'Slash');
  assert.strictEqual(T.codeFor('é'), '');
  assert.strictEqual(T.keyCodeFor('z'), 90);
  assert.strictEqual(T.keyCodeFor('Enter'), 13);
  assert.strictEqual(T.keyCodeFor('ArrowLeft'), 37);
  assert.strictEqual(T.keyCodeFor('é'), 0);
});
test('platformMeta: the app uses Meta only on "Mac" platforms, CodeMirror on every Apple device', function () {
  var iphone = T.platformMeta('iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148', 'Apple Computer, Inc.', 5);
  assert.deepStrictEqual(iphone, { app: false, cm: true });
  var ipadDesktop = T.platformMeta('MacIntel', 'Mozilla/5.0 (Macintosh) Safari', 'Apple Computer, Inc.', 5);
  assert.deepStrictEqual(ipadDesktop, { app: true, cm: true });
  var android = T.platformMeta('Linux armv8l', 'Mozilla/5.0 (Linux; Android 14) Mobile Safari', 'Google Inc.', 5);
  assert.deepStrictEqual(android, { app: false, cm: false });
  var win = T.platformMeta('Win32', 'Mozilla/5.0 (Windows NT 10.0)', 'Google Inc.', 0);
  assert.deepStrictEqual(win, { app: false, cm: false });
});
test('keyboardOpen: a visual viewport well under the layout height', function () {
  assert.ok(T.keyboardOpen(400, 800, 1));
  assert.ok(!T.keyboardOpen(780, 800, 1));
  assert.ok(!T.keyboardOpen(0, 800, 1));
});
test('clampPos: the pad stays fully on screen', function () {
  assert.deepStrictEqual(T.clampPos(-50, -50, 156, 156, 390, 700), { x: 4, y: 4 });
  assert.deepStrictEqual(T.clampPos(1000, 1000, 156, 156, 390, 700), { x: 230, y: 540 });
  assert.deepStrictEqual(T.clampPos(100, 200, 156, 156, 390, 700), { x: 100, y: 200 });
});
test('manifest: the plugin entry points at these files, gated by a default-on setting', function () {
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '../../manifest.json'), 'utf8'));
  var list = man.modules || man.widgets || man;
  var all = Array.isArray(list) ? list : Object.keys(man).reduce(function (a, k) { return Array.isArray(man[k]) ? a.concat(man[k]) : a; }, []);
  var m = all.filter(function (x) { return x && x.id === 'modkeys'; })[0];
  assert.ok(m, 'listed');
  assert.strictEqual(m.type, 'plugin');
  assert.strictEqual(m.entry, 'widgets/modkeys/modkeys.js');
  assert.strictEqual(m.css, 'widgets/modkeys/modkeys.css');
  assert.strictEqual(m.settingKey, 'plugins.modkeys');
  assert.strictEqual(m.default, true);
  assert.ok(fs.existsSync(path.join(__dirname, 'modkeys.css')));
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
