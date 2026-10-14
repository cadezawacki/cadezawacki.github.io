/* Unit tests for the Code comments plugin's pure core (language lookup, guessing,
 * line / block toggling). Not loaded by the app. Run: node txt/plugins/code-comment/code-comment.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var C = require('./code-comment.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
// Apply changes (non-overlapping, any order) to a text whose lines start at `starts`.
function apply(text, changes) {
  changes.slice().sort(function (a, b) { return b.from - a.from; }).forEach(function (c) { text = text.slice(0, c.from) + c.insert + text.slice(c.to); });
  return text;
}
function run(text, syn) {
  var lines = text.split('\n'), starts = [], p = 0;
  lines.forEach(function (l) { starts.push(p); p += l.length + 1; });
  return apply(text, C.toggle(lines, starts, syn));
}

test('fence info → language', function () {
  assert.strictEqual(C.fenceLang('```python'), 'python');
  assert.strictEqual(C.fenceLang('  ```Py title="x.py"'), 'py');
  assert.strictEqual(C.fenceLang('~~~ js'), 'js');
  assert.strictEqual(C.fenceLang('```{.bash}'), 'bash');
  assert.strictEqual(C.fenceLang('```language-rust'), 'rust');
  assert.strictEqual(C.fenceLang('```'), '');
});

test('known languages map to the right comment syntax', function () {
  var want = { js: '//', ts: '//', go: '//', rust: '//', java: '//', c: '//', cpp: '//', swift: '//', kotlin: '//', scss: '//',
    python: '#', py: '#', bash: '#', sh: '#', yaml: '#', toml: '#', ruby: '#', r: '#', dockerfile: '#', powershell: '#', perl: '#',
    sql: '--', lua: '--', haskell: '--', lisp: ';', clojure: ';', ini: ';', latex: '%', matlab: '%', erlang: '%', vb: "'", bat: 'REM', vim: '"', fortran: '!' };
  Object.keys(want).forEach(function (l) { assert.strictEqual(C.syntaxFor(l, []).line, want[l], l); });
  assert.deepStrictEqual(C.syntaxFor('html', []).block, ['<!--', '-->']);
  assert.deepStrictEqual(C.syntaxFor('xml', []).block, ['<!--', '-->']);
  assert.deepStrictEqual(C.syntaxFor('css', []).block, ['/*', '*/']);
  assert.deepStrictEqual(C.syntaxFor('ocaml', []).block, ['(*', '*)']);
});

test('unknown or missing languages are guessed from the code', function () {
  assert.strictEqual(C.guess(['def f(x):', '    return x * 2']).line, '#');
  assert.strictEqual(C.guess(['#!/bin/bash', 'echo hi', 'cd /tmp']).line, '#');
  assert.strictEqual(C.guess(['name: app', 'port: 8080']).line, '#');
  assert.strictEqual(C.guess(['const a = 1;', 'function f() { return a; }']).line, '//');
  assert.strictEqual(C.guess(['SELECT id, name', 'FROM users', 'WHERE id = 1']).line, '--');
  assert.deepStrictEqual(C.guess(['<div class="x">', '  <p>hi</p>', '</div>']).block, ['<!--', '-->']);
  assert.deepStrictEqual(C.guess(['.btn {', '  color: red;', '}']).block, ['/*', '*/']);
  assert.strictEqual(C.syntaxFor('mystery', ['import os', 'print(os.name)']).line, '#');
  assert.ok(C.guess([]).line, 'empty: still a syntax');
});

test('line comments: comment all at the shallowest indent, skip blanks, uncomment when all are', function () {
  var py = { line: '#' };
  assert.strictEqual(run('a = 1\n  b = 2', py), '# a = 1\n#   b = 2');
  assert.strictEqual(run('  if x:\n    y()\n\n  z()', py), '  # if x:\n  #   y()\n\n  # z()');
  assert.strictEqual(run('  # if x:\n  #   y()\n\n  # z()', py), '  if x:\n    y()\n\n  z()', 'round trip');
  assert.strictEqual(run('#no space\n# spaced', py), 'no space\nspaced');
  // mixed: some commented, some not → comment all
  assert.strictEqual(run('# a\nb', py), '# # a\n# b');
  assert.strictEqual(run('   \n', py), '   \n', 'only blanks: no change');
  var js = { line: '//' };
  assert.strictEqual(run('\tif (a) {\n\t\tb();\n\t}', js), '\t// if (a) {\n\t// \tb();\n\t// }');
  assert.strictEqual(run(run('x();\n  y();', js), js), 'x();\n  y();', 'js round trip');
  assert.strictEqual(run('SELECT 1', { line: '--' }), '-- SELECT 1');
  assert.strictEqual(run('echo off', { line: 'REM' }), 'REM echo off');
  assert.strictEqual(run('REM echo off', { line: 'REM' }), 'echo off');
});

test('block comments wrap the run of lines and unwrap it again', function () {
  var html = { block: ['<!--', '-->'] }, css = { block: ['/*', '*/'] };
  assert.strictEqual(run('  <p>hi</p>', html), '  <!-- <p>hi</p> -->');
  assert.strictEqual(run('  <!-- <p>hi</p> -->', html), '  <p>hi</p>');
  assert.strictEqual(run('<div>\n  <p>x</p>\n</div>', html), '<!-- <div>\n  <p>x</p>\n</div> -->');
  assert.strictEqual(run('<!-- <div>\n  <p>x</p>\n</div> -->', html), '<div>\n  <p>x</p>\n</div>');
  assert.strictEqual(run('.a { color: red; }  ', css), '/* .a { color: red; } */  ');
  assert.strictEqual(run('/* .a { color: red; } */  ', css), '.a { color: red; }  ');
  assert.strictEqual(run('\n.a {}\n', css), '\n/* .a {} */\n', 'blank edges stay outside');
  assert.strictEqual(run('<!---->', html), '', 'an empty comment unwraps to nothing');
});

test('manifest entry: a default-on Editor plugin', function () {
  var m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  var e = m.modules.filter(function (x) { return x.id === 'code-comment'; })[0];
  assert.ok(e, 'in the manifest');
  assert.strictEqual(e.type, 'plugin'); assert.strictEqual(e.entry, 'plugins/code-comment/code-comment.js');
  assert.strictEqual(e.settingKey, 'plugins.code-comment'); assert.strictEqual(e.default, true); assert.strictEqual(e.section, 'Editor');
});

console.log((process.exitCode ? 'FAILED' : 'ok') + ' — ' + passed + ' passed');
