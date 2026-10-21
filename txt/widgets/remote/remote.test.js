/* Checks for Remote: the state protocol (button diffs, release), the key
 * table, the receiver's target profiles and the widget / plugin registration.
 * Not loaded by the app. Run: node txt/widgets/remote/remote.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var L = require('./remote-link.js');
var H = require('./remote-host.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

function st(h, n, y) { var s = L.blankState(); if (h) h.forEach(function (b) { s.h = L.setHeld(s.h, b, true); }); for (var k in n || {}) s.n[L.BI[k]] = n[k]; s.y = y || 0; return s; }
function names(ev) { return ev.map(function (e) { return e[0] + ':' + e[1]; }).join(' '); }

test('a press that stays held is one keydown; letting go is one keyup', function () {
  var a = st(), b = st(['left'], { left: 1 }), c = st([], { left: 1 });
  assert.strictEqual(names(L.diffButtons(a, b)), 'left:down');
  assert.strictEqual(names(L.diffButtons(b, b)), '', 'a heartbeat changes nothing');
  assert.strictEqual(names(L.diffButtons(b, c)), 'left:up');
});
test('taps that fell between packets are still delivered, in order', function () {
  var a = st(), b = st([], { a: 3 });
  assert.strictEqual(names(L.diffButtons(a, b)), 'a:down a:up a:down a:up a:down a:up');
  // two quick taps then a press that is still held
  var c = st(['a'], { a: 6 });
  assert.strictEqual(names(L.diffButtons(b, c)), 'a:down a:up a:down a:up a:down');
  // held, then released and pressed again before the next packet: the old hold ends first
  var d = st(['a'], { a: 7 });
  assert.strictEqual(names(L.diffButtons(c, d)), 'a:up a:down');
});
test('several buttons at once; counters never go backwards', function () {
  var a = st(['up'], { up: 1 }), b = st(['up', 'b'], { up: 1, b: 1 });
  assert.strictEqual(names(L.diffButtons(a, b)), 'b:down');
  var reset = st();
  assert.strictEqual(names(L.diffButtons(b, reset)), 'up:up b:up', 'a lower counter is no press');
  assert.strictEqual(names(L.releaseAll(b)), 'up:up b:up');
  assert.strictEqual(L.BTN.length <= 31, true, 'fits a 32-bit mask');
});
test('held / setHeld round trip over every button', function () {
  var h = 0;
  L.BTN.forEach(function (b, i) { if (i % 2) h = L.setHeld(h, b, true); });
  L.BTN.forEach(function (b, i) { assert.strictEqual(L.held(h, b), i % 2 === 1, b); });
});
test('key table: key, code and keyCode for what the profiles send', function () {
  assert.deepStrictEqual(L.keyDef(' '), [' ', 'Space', 32]);
  assert.deepStrictEqual(L.keyDef('ArrowLeft'), ['ArrowLeft', 'ArrowLeft', 37]);
  assert.deepStrictEqual(L.keyDef('p'), ['p', 'KeyP', 80]);
  assert.deepStrictEqual(L.keyDef('7'), ['7', 'Digit7', 55]);
  var used = {};
  H.PROFILES.concat([H.EDITOR]).forEach(function (p) { for (var b in p.keys) { var k = p.keys[b]; if (k && k.charAt(0) !== '@') used[k] = 1; } });
  Object.keys(used).forEach(function (k) { var d = L.keyDef(k); assert.ok(d[1] && d[2] > 0, 'no code for ' + k); });
});
test('profiles: buttons are real, labels belong to mapped buttons, repeats are sane', function () {
  H.PROFILES.concat([H.EDITOR]).forEach(function (p) {
    assert.ok(p.name && (p.id || p.sel), 'id or selector');
    for (var b in p.keys) assert.ok(L.BI[b] != null, p.name + ': unknown button ' + b);
    for (var b2 in p.labels || {}) assert.ok(p.keys[b2], p.name + ': label for unmapped ' + b2);
    for (var b3 in p.rep || {}) { assert.ok(p.keys[b3], p.name + ': repeat on unmapped ' + b3); assert.ok(p.rep[b3][1] >= 20, p.name + ' repeat too fast'); }
    if (p.tilt) p.tilt.forEach(function (t) { assert.ok(p.keys[t], p.name + ': tilt to unmapped ' + t); });
  });
  var ids = H.PROFILES.filter(function (p) { return p.id; }).map(function (p) { return p.id; });
  assert.strictEqual(new Set(ids).size, ids.length, 'one profile per panel');
});
test('profile panels exist in the widgets (ids match the code)', function () {
  var dir = path.join(__dirname, '..');
  var src = fs.readdirSync(dir).map(function (d) {
    try { return fs.readdirSync(path.join(dir, d)).filter(function (f) { return /\.js$/.test(f) && !/test/.test(f); }).map(function (f) { return fs.readFileSync(path.join(dir, d, f), 'utf8'); }).join('\n'); } catch (e) { return ''; }
  }).join('\n');
  H.PROFILES.forEach(function (p) {
    if (p.id) assert.ok(src.indexOf("'" + p.id + "'") >= 0, 'no widget makes a panel with id ' + p.id);
    else assert.ok(src.indexOf("'" + p.sel.slice(1) + "'") >= 0, 'no widget makes ' + p.sel);
  });
});
test('ctx: what the controller is told; pick: overlays over panels, then z-index, then latest', function () {
  var c = H.ctxOf(H.PROFILES[0]);
  assert.strictEqual(c.kind, 'game');
  assert.ok(c.btns.indexOf('a') >= 0 && c.btns.indexOf('prev') < 0);
  assert.strictEqual(H.ctxOf(H.EDITOR).kind, 'present');
  assert.ok(H.ctxOf(H.EDITOR).scroll);
  var best = H.pick([{ id: 'a', z: 5, order: 1 }, { id: 'b', z: 9, order: 0 }, { id: 'c', z: 9, order: 2 }]);
  assert.strictEqual(best.id, 'c');
  assert.strictEqual(H.pick([{ id: 'a', z: 99, order: 3 }, { id: 'ov', ov: true, z: 1, order: 0 }]).id, 'ov');
  assert.strictEqual(H.pick([]), null);
});
test('widget and receiver plugin register as the manifest says', function () {
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules;
  var w = man.filter(function (m) { return m.id === 'remote'; })[0], p = man.filter(function (m) { return m.id === 'remote-recv'; })[0];
  assert.ok(w && p);
  assert.strictEqual(p.type, 'plugin'); assert.strictEqual(p.settingKey, 'plugins.remote-recv'); assert.strictEqual(p.default, true);
  var reg = null, plug = null, css = [];
  var fake = {
    Cade: {
      loadCSS: function (c) { css.push(c); }, asset: function (r) { return r; }, registerWidget: function (o) { reg = o; },
      registerPlugin: function (o) { plug = o; }, CM: { ViewPlugin: { define: function (f) { return { __vp: f }; } } }, escapeHtml: String
    },
    document: { addEventListener: function () {}, removeEventListener: function () {} }
  };
  new Function('window', 'module', 'document', fs.readFileSync(path.join(__dirname, 'remote.js'), 'utf8'))(fake, undefined, fake.document);
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(reg[k], w[k], k); });
  assert.deepStrictEqual(css, ['remote.css']);
  new Function('window', 'module', 'document', fs.readFileSync(path.join(__dirname, 'remote-recv.js'), 'utf8'))(fake, undefined, fake.document);
  assert.strictEqual(plug.id, 'remote-recv');
  assert.ok(plug.ext && plug.ext.__vp, 'lifetime tied to an editor ViewPlugin');
});
console.log((process.exitCode ? 'FAILED, ' : '') + 'remote: ' + passed + ' passed');
