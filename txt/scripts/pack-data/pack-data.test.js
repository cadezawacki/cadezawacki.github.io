/* Tests for the Data Pack: every script runs through the same path as the
 * palette (source registered with Cade.registerScript, main() built with
 * new Function, a ctx like executeScript's). Not loaded by the app.
 * Run: node txt/scripts/pack-data/pack-data.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path'), vm = require('vm');

var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

// ---------------------------------------------------------------- harness
var sources = [], toasts = [], prompts = [], promptLog = [];
var win = {
  Cade: { registerScript: function (s) { sources.push(s); }, showToast: function () {} },
  prompt: function (msg, def) { promptLog.push([msg, def]); return prompts.length ? prompts.shift() : null; },
};
var sandbox = { window: win };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'pack-data.js'), 'utf8'), sandbox);
var D = win.__CADE_DATA__;

var scripts = {};
sources.forEach(function (src) {
  var m = src.match(/\/\*\*\s*([\s\S]*?)\s*\*\*\//);
  var meta = JSON.parse(m[1]);
  var code = src.slice(m[0].length).trim();
  scripts[meta.name] = { meta: meta, fn: new Function('window', 'document', 'ctx', 'showToast', code + '\nmain(ctx);') };
});
function showToast(msg, type) { toasts.push([msg, type]); }

// Mirrors executeScript: an explicit selection [from, to], else the cursor's
// line (cursor = offset) when it's non-empty, else the whole note.
function run(name, doc, opts) {
  opts = opts || {};
  var s = scripts[name];
  assert.ok(s, 'no script ' + name);
  toasts = []; prompts = (opts.prompts || []).slice(); promptLog = [];
  var from, to, hasSel;
  if (opts.sel) { from = opts.sel[0]; to = opts.sel[1]; hasSel = true; }
  else if (opts.cursor != null) {
    from = doc.lastIndexOf('\n', opts.cursor - 1) + 1;
    to = doc.indexOf('\n', opts.cursor); if (to === -1) to = doc.length;
    hasSel = to > from;
  }
  if (!hasSel) { from = 0; to = doc.length; }
  var full = doc, edit = doc.slice(from, to), fullCh = false, editCh = false;
  var ctx = {
    get fullText() { return full; }, set fullText(v) { full = v; fullCh = true; },
    get selection() { return hasSel ? edit : ''; },
    set selection(v) { if (hasSel) { edit = v; editCh = true; } else { full = v; fullCh = true; } },
    get text() { return hasSel ? edit : full; },
  };
  s.fn(win, {}, ctx, showToast);
  if (editCh && hasSel) return doc.slice(0, from) + edit + doc.slice(to);
  if (fullCh) return full;
  return doc;
}
function throws(name, doc, re, opts) {
  assert.throws(function () { run(name, doc, opts); }, re);
}

// ---------------------------------------------------------------- metadata
var NEW = ['CSV → JSON', 'JSON → JSON Schema', 'JSON → Python Dataclass', 'JSON → Go Struct', 'Dedupe JSON Array by Key…',
  'Select CSV Columns…', 'Transpose Table', 'Number Stats', 'SQL Beautify', 'SQL Minify', 'Extract Phone Numbers',
  'Extract Dates', 'Extract IP Addresses', 'Extract Hashtags & Mentions', 'Extract Money Amounts', 'Extract Hex Colours'];
var OLD = ['Sum', 'JSON Format', 'JSON Minify', 'Split by Comma', 'Split by Delimiter', 'Split (Keep Delimiter)', 'Format Table',
  'Find & Replace', 'Extract Emails', 'Extract URLs', 'Extract Numbers', 'Markdown Table'];

test('registers the 12 original + 16 new scripts with complete metadata', function () {
  assert.deepStrictEqual(Object.keys(scripts), OLD.concat(NEW));
  Object.keys(scripts).forEach(function (n) {
    var m = scripts[n].meta;
    ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.ok(typeof m[k] === 'string' && m[k].length, n + ' ' + k); });
    assert.ok(/^<svg viewBox='0 0 24 24'[^"]*<\/svg>$/.test(m.icon), n + ' icon');
  });
  // where the manifest already lists a row, it must match the header
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  var list = Array.isArray(man) ? man : (man.modules || man.items || []);
  var pack = list.filter(function (e) { return e && e.id === 'pack-data'; })[0];
  assert.ok(pack, 'manifest has pack-data');
  pack.scripts.forEach(function (row) {
    var m = scripts[row.name] && scripts[row.name].meta;
    assert.ok(m, 'manifest row without a script: ' + row.name);
    assert.deepStrictEqual({ name: m.name, description: m.description, icon: m.icon, tags: m.tags }, row);
  });
});

// ---------------------------------------------------------------- existing scripts still work
test('original scripts: Sum, JSON Format, Extract Emails, Format Table', function () {
  assert.strictEqual(run('Sum', '1, 2, 3'), '1, 2, 3\n\n= 6');
  assert.strictEqual(run('JSON Format', '{"a":[1]}'), '{\n  "a": [\n    1\n  ]\n}');
  assert.strictEqual(run('Extract Emails', 'a@b.co x a@b.co'), 'a@b.co x a@b.co\n\n--- Emails Found (1) ---\na@b.co');
  assert.strictEqual(run('Format Table', '|a|b|\n|--|--|\n|1|22|'), '| a   | b   |\n| --- | --- |\n| 1   | 22  |');
});

// ---------------------------------------------------------------- CSV parsing
test('parseDelimited: RFC-4180 quotes, "" escapes, embedded newlines, CRLF, blank lines', function () {
  var rows = D.parseDelimited('a,b,c\r\n"x, y","say ""hi""","l1\nl2"\r\n\r\n 1 , "  sp  " ,\n', ',');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rows)), [['a', 'b', 'c'], ['x, y', 'say "hi"', 'l1\nl2'], ['1', '  sp  ', '']]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(D.parseDelimited('"unterminated,1', ','))), [['unterminated,1']]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(D.parseDelimited('""', ','))), [['']]);
});

test('detectDelimiter: comma, semicolon, tab, pipe; commas inside quotes ignored', function () {
  assert.strictEqual(D.detectDelimiter('a,b\n1,2'), ',');
  assert.strictEqual(D.detectDelimiter('a;b;c\n1,5;2,5;3'), ';');
  assert.strictEqual(D.detectDelimiter('a\tb\n"1,2"\t3'), '\t');
  assert.strictEqual(D.detectDelimiter('a|b\n1|2'), '|');
  assert.strictEqual(D.detectDelimiter('name;note\nBob;"x, y, z"'), ';');
  assert.strictEqual(D.detectDelimiter('single'), ',');
});

// ---------------------------------------------------------------- CSV → JSON
test('CSV → JSON: typed values, leading zeros kept, quoted fields, header-only, empty', function () {
  var csv = 'id,name,zip,active,score,note,big\n1,"Smith, J",007,true,-3.5e2,"two\nlines ""q""",12345678901234567890\n2,Bob,02134,FALSE,,null,0\n';
  var out = run('CSV → JSON', csv);
  assert.deepStrictEqual(JSON.parse(out), [
    { id: 1, name: 'Smith, J', zip: '007', active: true, score: -350, note: 'two\nlines "q"', big: '12345678901234567890' },
    { id: 2, name: 'Bob', zip: '02134', active: false, score: '', note: null, big: 0 },
  ]);
  assert.ok(/^\[\n  \{\n    "id": 1,/.test(out), 'pretty 2-space');
  assert.ok(/\n$/.test(out), 'keeps the trailing newline');
  assert.strictEqual(run('CSV → JSON', 'a,b'), '[]');
  assert.deepStrictEqual(JSON.parse(run('CSV → JSON', 'a\tb\tb\t\n1\t2\t3\t4\n')), [{ a: 1, b: 2, b_2: 3, column4: 4 }]);
  assert.deepStrictEqual(JSON.parse(run('CSV → JSON', 'x;y\n1,5;.5\n')), [{ x: '1,5', y: '.5' }]);
  throws('CSV → JSON', '   \n', /No table found/);
});

test('CSV → JSON: Markdown tables convert in place, other text untouched', function () {
  var doc = '# Data\n\n| name | v |\n| :--- | --: |\n| a \\| b | 1.5 |\n| c | |\n\nend';
  var out = run('CSV → JSON', doc);
  assert.strictEqual(out, '# Data\n\n' + JSON.stringify([{ name: 'a | b', v: 1.5 }, { name: 'c', v: '' }], null, 2) + '\n\nend');
});

test('CSV → JSON: cursor on one line of a CSV note converts the whole note', function () {
  assert.deepStrictEqual(JSON.parse(run('CSV → JSON', 'a,b\n1,2', { cursor: 5 })), [{ a: 1, b: 2 }]);
});

// ---------------------------------------------------------------- JSON → JSON Schema
test('JSON → JSON Schema: nested, required across items, nullable unions, formats', function () {
  var data = [
    { id: 1, email: 'a@b.co', at: '2024-01-05T10:00:00Z', day: '2024-01-05', site: 'https://x.dev/a', tags: ['x'], addr: { city: 'X', zip: null }, n: 1, meta: null },
    { id: 2, email: 'c@d.io', at: '2024-02-05T10:00:00+02:00', day: '2024-03-01', site: 'not a url', tags: [], addr: { city: 'Y', zip: '1' }, n: 2.5, meta: { k: true } },
  ];
  var s = JSON.parse(run('JSON → JSON Schema', JSON.stringify(data)));
  assert.strictEqual(s.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.strictEqual(s.type, 'array');
  var it = s.items;
  assert.strictEqual(it.type, 'object');
  assert.deepStrictEqual(it.required, ['id', 'email', 'at', 'day', 'site', 'tags', 'addr', 'n', 'meta']);
  assert.deepStrictEqual(it.properties.id, { type: 'integer' });
  assert.deepStrictEqual(it.properties.n, { type: 'number' });
  assert.deepStrictEqual(it.properties.email, { type: 'string', format: 'email' });
  assert.deepStrictEqual(it.properties.at, { type: 'string', format: 'date-time' });
  assert.deepStrictEqual(it.properties.day, { type: 'string', format: 'date' });
  assert.deepStrictEqual(it.properties.site, { type: 'string' });   // formats must hold for every sample
  assert.deepStrictEqual(it.properties.tags, { type: 'array', items: { type: 'string' } });
  assert.deepStrictEqual(it.properties.addr, { type: 'object', properties: { city: { type: 'string' }, zip: { type: ['string', 'null'] } }, required: ['city', 'zip'] });
  assert.deepStrictEqual(it.properties.meta, { type: ['object', 'null'], properties: { k: { type: 'boolean' } }, required: ['k'] });
});

test('JSON → JSON Schema: optional keys, mixed arrays, empty array, scalars, invalid', function () {
  var s = JSON.parse(run('JSON → JSON Schema', '{"a":[{"x":1},{"y":"u@v.com"},null],"e":[],"m":[1,"s"]}'));
  assert.deepStrictEqual(s.required, ['a', 'e', 'm']);
  assert.deepStrictEqual(s.properties.a.items, { type: ['object', 'null'], properties: { x: { type: 'integer' }, y: { type: 'string', format: 'email' } } });
  assert.deepStrictEqual(s.properties.e, { type: 'array', items: {} });
  assert.deepStrictEqual(s.properties.m.items, { type: ['string', 'integer'] });
  assert.deepStrictEqual(JSON.parse(run('JSON → JSON Schema', '"https://a.b"')), { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string', format: 'uri' });
  throws('JSON → JSON Schema', '{oops}', /Invalid JSON/);
});

// ---------------------------------------------------------------- JSON → Python / Go
var SAMPLE = JSON.stringify({
  user_id: 7, name: 'Ann', score: 1.5, active: true, nickname: null,
  address: { street: 'Main', zip: '007' },
  orders: [{ id: 1, items: [{ sku: 'a', qty: 2 }], note: 'x' }, { id: 2, items: [], coupon: { code: 'Z' } }],
  'first-name': 'A', class: 'c', tags: ['a', 'b'], empty: {}, misc: [],
});

test('JSON → Python Dataclass: nested classes, lists, Optional, imports, identifiers', function () {
  var py = run('JSON → Python Dataclass', SAMPLE);
  assert.strictEqual(py, [
    'from __future__ import annotations',
    '',
    'from dataclasses import dataclass',
    'from typing import Any, Dict, List, Optional',
    '',
    '',
    '@dataclass',
    'class Address:',
    '    street: str',
    '    zip: str',
    '',
    '',
    '@dataclass',
    'class Item:',
    '    sku: str',
    '    qty: int',
    '',
    '',
    '@dataclass',
    'class Coupon:',
    '    code: str',
    '',
    '',
    '@dataclass',
    'class Order:',
    '    id: int',
    '    items: List[Item]',
    '    note: Optional[str] = None',
    '    coupon: Optional[Coupon] = None',
    '',
    '',
    '@dataclass',
    'class Root:',
    '    user_id: int',
    '    name: str',
    '    score: float',
    '    active: bool',
    '    address: Address',
    '    orders: List[Order]',
    '    first_name: str  # "first-name"',
    '    class_: str  # "class"',
    '    tags: List[str]',
    '    empty: Dict[str, Any]',
    '    misc: List[Any]',
    '    nickname: Optional[Any] = None',
    '',
  ].join('\n'));
});

test('JSON → Python Dataclass: root array, de-duplicated class names, unions, errors', function () {
  var py = run('JSON → Python Dataclass', '[{"a":{"x":1},"b":{"a":{"y":"s"}},"v":1},{"v":"s","w":null}]');
  assert.ok(py.indexOf('class A:\n    x: int') !== -1, py);
  assert.ok(py.indexOf('class A2:\n    y: str') !== -1, py);
  assert.ok(py.indexOf('class RootItem:\n    v: Union[str, int]\n    a: Optional[A] = None\n    b: Optional[B] = None\n    w: Optional[Any] = None') !== -1, py);
  assert.ok(/\n\n\nRoot = List\[RootItem\]\n$/.test(py), py);
  assert.ok(py.indexOf('from typing import Any, List, Optional, Union') !== -1);
  throws('JSON → Python Dataclass', '[1, 2]', /object or an array of objects/);
  throws('JSON → Python Dataclass', 'nope', /Invalid JSON/);
});

test('JSON → Go Struct: structs, initialisms, pointers + omitempty, aligned tags', function () {
  var go = run('JSON → Go Struct', SAMPLE);
  assert.strictEqual(go, [
    'type Root struct {',
    '\tUserID    int            `json:"user_id"`',
    '\tName      string         `json:"name"`',
    '\tScore     float64        `json:"score"`',
    '\tActive    bool           `json:"active"`',
    '\tNickname  any            `json:"nickname,omitempty"`',
    '\tAddress   Address        `json:"address"`',
    '\tOrders    []Order        `json:"orders"`',
    '\tFirstName string         `json:"first-name"`',
    '\tClass     string         `json:"class"`',
    '\tTags      []string       `json:"tags"`',
    '\tEmpty     map[string]any `json:"empty"`',
    '\tMisc      []any          `json:"misc"`',
    '}',
    '',
    'type Address struct {',
    '\tStreet string `json:"street"`',
    '\tZip    string `json:"zip"`',
    '}',
    '',
    'type Order struct {',
    '\tID     int     `json:"id"`',
    '\tItems  []Item  `json:"items"`',
    '\tNote   *string `json:"note,omitempty"`',
    '\tCoupon *Coupon `json:"coupon,omitempty"`',
    '}',
    '',
    'type Item struct {',
    '\tSKU string `json:"sku"`',
    '\tQty int    `json:"qty"`',
    '}',
    '',
    'type Coupon struct {',
    '\tCode string `json:"code"`',
    '}',
    '',
  ].join('\n'));
});

test('JSON → Go Struct: root array, nullable items, odd keys, mixed types', function () {
  var go = run('JSON → Go Struct', '[{"api_url":"u","1st":1,"vals":[1,null],"mix":1,"Name":"a","name":"b"},{"mix":"s","api_url":"v","1st":2,"vals":[],"Name":"c","name":"d"}]');
  assert.ok(go.indexOf('type Root []RootItem\n\ntype RootItem struct {') === 0, go);
  assert.ok(/\tAPIURL +string +`json:"api_url"`/.test(go), go);
  assert.ok(/\tX1st +int +`json:"1st"`/.test(go), go);
  assert.ok(/\tVals +\[\]\*int +`json:"vals"`/.test(go), go);
  assert.ok(/\tMix +any +`json:"mix"`/.test(go), go);
  assert.ok(/\tName +string +`json:"Name"`\n\tName2 +string +`json:"name"`/.test(go), go);
  throws('JSON → Go Struct', '"str"', /object or an array of objects/);
});

// ---------------------------------------------------------------- Dedupe
test('Dedupe JSON Array by Key…: dot path, first kept, indent preserved, prompt default', function () {
  var doc = '[\n    {\n        "id": 1,\n        "u": {"e": "a@x"}\n    },\n    {\n        "id": 2,\n        "u": {"e": "a@x"}\n    },\n    {\n        "id": 3\n    }\n]\n';
  var out = run('Dedupe JSON Array by Key…', doc, { prompts: ['u.e'] });
  assert.strictEqual(out, JSON.stringify([{ id: 1, u: { e: 'a@x' } }, { id: 3 }], null, 4) + '\n');
  assert.strictEqual(promptLog[0][1], 'id');
  assert.deepStrictEqual(toasts[0], ['Removed 1 duplicate', 'success']);
  // tab indent
  assert.strictEqual(run('Dedupe JSON Array by Key…', '[\n\t{"id": 1},\n\t{"id": 1},\n\t{"id": "1"}\n]', { prompts: ['id'] }),
    '[\n\t{"id": 1},\n\t{"id": "1"}\n]');
  // minified stays minified; deep values compared structurally
  assert.strictEqual(run('Dedupe JSON Array by Key…', '[{"k":[1,2]},{"k":[1,2]},{"k":[2,1]}]', { prompts: ['k'] }), '[{"k":[1,2]},{"k":[2,1]}]');
  // a literal dotted key wins over the path
  assert.strictEqual(run('Dedupe JSON Array by Key…', '[{"a.b":1},{"a.b":1}]', { prompts: ['a.b'] }), '[{"a.b":1}]');
  // 2-space pretty
  var pretty = JSON.stringify([{ id: 1, n: 'a' }, { id: 1, n: 'b' }, { id: 2, n: 'c' }], null, 2);
  assert.strictEqual(run('Dedupe JSON Array by Key…', pretty, { prompts: ['id'] }), JSON.stringify([{ id: 1, n: 'a' }, { id: 2, n: 'c' }], null, 2));
  // nothing to remove
  assert.strictEqual(run('Dedupe JSON Array by Key…', '[{"id":1}]', { prompts: ['id'] }), '[{"id":1}]');
  assert.deepStrictEqual(toasts[0], ['No duplicates found', 'info']);
});

test('Dedupe JSON Array by Key…: cancel, missing key, not an array', function () {
  assert.strictEqual(run('Dedupe JSON Array by Key…', '[{"id":1},{"id":1}]', { prompts: [null] }), '[{"id":1},{"id":1}]');
  throws('Dedupe JSON Array by Key…', '[{"id":1},{"id":1}]', /No item has the key "nope"/, { prompts: ['nope'] });
  throws('Dedupe JSON Array by Key…', '{"id":1}', /Expected a JSON array/, { prompts: ['id'] });
  assert.strictEqual(promptLog.length, 0, 'fails before prompting');
});

// ---------------------------------------------------------------- Select columns
test('Select CSV Columns…: names, 1-based numbers, order, ranges, drops, quoted CSV', function () {
  var csv = 'name,email,age,note\nAnn,a@x,30,"hi, there"\nBo,b@x,4,"say ""yo"""\n';
  assert.strictEqual(run('Select CSV Columns…', csv, { prompts: ['age, name'] }), 'age,name\n30,Ann\n4,Bo\n');
  assert.strictEqual(promptLog[0][1], 'name, email, age, note');
  assert.strictEqual(run('Select CSV Columns…', csv, { prompts: ['4, 1'] }), 'note,name\n"hi, there",Ann\n"say ""yo""",Bo\n');
  assert.strictEqual(run('Select CSV Columns…', csv, { prompts: ['-email, -note'] }), 'name,age\nAnn,30\nBo,4\n');
  assert.strictEqual(run('Select CSV Columns…', csv, { prompts: ['2-3'] }), 'email,age\na@x,30\nb@x,4\n');
  assert.strictEqual(run('Select CSV Columns…', csv, { prompts: ['EMAIL'] }), 'email\na@x\nb@x\n');
  assert.strictEqual(run('Select CSV Columns…', 'a;b\n1,5;2\n', { prompts: ['b, a'] }), 'b;a\n2;1,5\n');
  assert.strictEqual(run('Select CSV Columns…', 'a\tb\n1\t2', { prompts: ['b'] }), 'b\n2');
  assert.strictEqual(run('Select CSV Columns…', csv, { prompts: [null] }), csv);
  throws('Select CSV Columns…', csv, /Unknown column: zzz/, { prompts: ['name, zzz'] });
  throws('Select CSV Columns…', csv, /every column/, { prompts: ['-1-4'] });
});

test('Select CSV Columns…: Markdown tables keep format and alignment', function () {
  var md = 'Intro\n| name | qty | note |\n| :-- | --: | :-: |\n| apple | 3 | a \\| b |\n| kiwi | 12 | |\nOutro';
  assert.strictEqual(run('Select CSV Columns…', md, { prompts: ['note, qty'] }),
    'Intro\n|  note  | qty |\n| :----: | --: |\n| a \\| b |   3 |\n|        |  12 |\nOutro');
});

// ---------------------------------------------------------------- Transpose
test('Transpose Table: CSV, TSV, ragged rows, quoted cells, Markdown header kept', function () {
  assert.strictEqual(run('Transpose Table', 'a,b,c\n1,2,3\n'), 'a,1\nb,2\nc,3\n');
  assert.strictEqual(run('Transpose Table', 'a\tb\n1'), 'a\t1\nb\t');
  assert.strictEqual(run('Transpose Table', 'k,"v, w"\n"x\ny",2'), 'k,"x\ny"\n"v, w",2');
  assert.strictEqual(run('Transpose Table', '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'),
    '| a   | 1   | 3   |\n| --- | --- | --- |\n| b   | 2   | 4   |');
  // twice = original data
  var back = run('Transpose Table', run('Transpose Table', 'x,y,z\n1,2,3\n4,5,6'));
  assert.strictEqual(back, 'x,y,z\n1,2,3\n4,5,6');
  throws('Transpose Table', '', /No table found/);
});

// ---------------------------------------------------------------- Number Stats
test('Number Stats: all statistics, aligned block appended like Sum', function () {
  var out = run('Number Stats', '2\n4\n4\n4\n5\n5\n7\n9');
  assert.strictEqual(out, [
    '2\n4\n4\n4\n5\n5\n7\n9',
    '',
    'count                = 8',
    'sum                  = 40',
    'mean                 = 5',
    'median               = 4.5',
    'mode                 = 4 (×3)',
    'min                  = 2',
    'max                  = 9',
    'range                = 7',
    'std dev (population) = 2',
    'std dev (sample)     = 2.13809',
    'p25                  = 4',
    'p75                  = 5.5',
    'p90                  = 7.6',
  ].join('\n'));
});

test('Number Stats: numbers in prose, thousands, negatives, decimals; selection only; none', function () {
  var doc = 'Header\nCosts: $1,200.50, -3 and .5 (item7 v1.2 ignored)\nFooter';
  var line = 'Costs: $1,200.50, -3 and .5 (item7 v1.2 ignored)';
  var out = run('Number Stats', doc, { sel: [7, 7 + line.length] });
  var block = out.split('\n\n')[1].split('\nFooter')[0];
  assert.ok(/^count += 3$/m.test(block), block);
  assert.ok(/^sum += 1,198$/m.test(block), block);
  assert.ok(/^mode += none \(all unique\)$/m.test(block), block);
  assert.ok(/^min += -3$/m.test(block), block);
  assert.ok(/^std dev \(sample\) += /m.test(block), block);
  assert.ok(out.indexOf('Header\n') === 0 && /\nFooter$/.test(out), 'only the selection grows');
  var one = run('Number Stats', '42');
  assert.ok(/^std dev \(sample\) += n\/a$/m.test(one) && /^p90 += 42$/m.test(one), one);
  assert.ok(/^mode += 1, 2 \(×2\)$/m.test(run('Number Stats', '1 1 2 2 3')));
  assert.strictEqual(run('Number Stats', 'no digits here'), 'no digits here');
  assert.deepStrictEqual(toasts[0], ['No numbers found', 'error']);
  assert.strictEqual(run('Number Stats', '1\n2\n'), '1\n2\n\ncount                = 2\nsum                  = 3\nmean                 = 1.5\nmedian               = 1.5\nmode                 = none (all unique)\nmin                  = 1\nmax                  = 2\nrange                = 1\nstd dev (population) = 0.5\nstd dev (sample)     = 0.707107\np25                  = 1.25\np75                  = 1.75\np90                  = 1.9\n');
});

// ---------------------------------------------------------------- SQL
test('SQL Beautify: clauses, select list, joins, AND/OR, BETWEEN, functions, subquery', function () {
  var sql = "select a, b as \"from\", count(*) c, case when x>1 and y<2 then 'where and' else -1 end from t1 left outer join t2 on t1.id=t2.id and t2.x between 1 and 5 " +
    "where a=1 and (b=2 or c=3) or d in (select id from z where q='select * from') group by a, b having count(*)>1 order by a desc limit 10";
  assert.strictEqual(run('SQL Beautify', sql), [
    'SELECT',
    '  a,',
    '  b AS "from",',
    '  COUNT(*) c,',
    "  CASE WHEN x > 1 AND y < 2 THEN 'where and' ELSE -1 END",
    'FROM t1',
    '  LEFT OUTER JOIN t2 ON t1.id = t2.id',
    '    AND t2.x BETWEEN 1 AND 5',
    'WHERE a = 1',
    '  AND (b = 2 OR c = 3)',
    '  OR d IN (',
    '    SELECT',
    '      id',
    '    FROM z',
    "    WHERE q = 'select * from'",
    '  )',
    'GROUP BY a, b',
    'HAVING COUNT(*) > 1',
    'ORDER BY a DESC',
    'LIMIT 10',
  ].join('\n'));
});

test('SQL Beautify: multiple statements, comments, INSERT/UPDATE, CTEs, quoted identifiers', function () {
  var sql = "-- report\nwith recent as (select id, /* pk */ name from `order` where created >= now() - interval '7 days'), x as (select 1)\n" +
    "select r.name, [Order Date], t.\"select\" from recent r join x on true; insert into t (a,b) values (1,'it''s;'),(2,null);\n" +
    "update t set a=1, b=-2 where id=$1 -- trailing\n";
  assert.strictEqual(run('SQL Beautify', sql), [
    '-- report',
    'WITH recent AS (',
    '  SELECT',
    '    id, /* pk */',
    '    name',
    '  FROM `order`',
    "  WHERE created >= NOW() - INTERVAL '7 days'",
    '),',
    'x AS (',
    '  SELECT',
    '    1',
    ')',
    'SELECT',
    '  r.name,',
    '  [Order Date],',
    '  t."select"',
    'FROM recent r',
    '  JOIN x ON TRUE;',
    '',
    'INSERT INTO t (a, b)',
    'VALUES',
    "  (1, 'it''s;'),",
    '  (2, NULL);',
    '',
    'UPDATE t',
    'SET',
    '  a = 1,',
    '  b = -2',
    'WHERE id = $1 -- trailing',
    '',
  ].join('\n'));
});

test('SQL Beautify: idempotent, keeps identifiers next to dots, unterminated strings safe', function () {
  var once = run('SQL Beautify', 'select o.order, sum(x) from o where o.select = 1 union all select 1, 2');
  assert.strictEqual(run('SQL Beautify', once), once);
  assert.ok(once.indexOf('o.order') !== -1 && once.indexOf('o.select') !== -1, once);
  assert.ok(/\nUNION ALL\nSELECT\n  1,\n  2$/.test(once), once);
  assert.strictEqual(run('SQL Beautify', "select 'abc from"), "SELECT\n  'abc from");
  assert.strictEqual(run('SQL Beautify', 'create table if not exists u (id serial primary key, name varchar(20) not null, check (a in (1,2)));delete from u where exists (select 1 from v where v.id=u.id)'), [
    'CREATE TABLE IF NOT EXISTS u (',
    '  id serial PRIMARY KEY,',
    '  name VARCHAR(20) NOT NULL,',
    '  CHECK (a IN (1, 2))',
    ');',
    '',
    'DELETE FROM u',
    'WHERE EXISTS (',
    '  SELECT',
    '    1',
    '  FROM v',
    '  WHERE v.id = u.id',
    ')',
  ].join('\n'));
  assert.strictEqual(run('SQL Beautify', '   '), '   ');
});

test('SQL Minify: comments and whitespace stripped, strings / identifiers intact, hints kept', function () {
  var sql = "SELECT  a,  -- first\n  b /* gone */ , 'x  --  y /* z */' AS \"my  col\"\nFROM t\nWHERE a - -1 > 2 AND n = N'é' AND s LIKE 'a''b';\n\nSELECT /*+ INDEX(t i) */ 1 ;";
  assert.strictEqual(run('SQL Minify', sql),
    "SELECT a,b,'x  --  y /* z */' AS \"my  col\" FROM t WHERE a- -1>2 AND n=N'é' AND s LIKE 'a''b';SELECT /*+ INDEX(t i) */ 1;");
  assert.strictEqual(run('SQL Minify', "select $$ keep   this $$, 'a' 'b', x.y from z"), "select $$ keep   this $$,'a' 'b',x.y from z");
  assert.strictEqual(run('SQL Minify', 'select 1 / *2'), 'select 1/ *2');
});

// ---------------------------------------------------------------- extraction
function extracted(name, text) {
  var out = run(name, text);
  return out === text ? null : out.slice(text.length);
}

test('Extract Phone Numbers', function () {
  var t = 'Call +1 (555) 123-4567 or 555-123-4567, 555.987.6543 / (555) 987-0000, UK +44 20 7946 0958 or 020 7946 0958, local 555-1234.\n' +
    'Not: 2024-01-05, 1234 5678, 192.168.1.1, 2024 2025 2026, 12345, v1.2.3, again 555 123 4567';
  assert.strictEqual(extracted('Extract Phone Numbers', t), '\n\n--- Phone Numbers Found (7) ---\n+1 (555) 123-4567\n555-123-4567\n555.987.6543\n(555) 987-0000\n+44 20 7946 0958\n020 7946 0958\n555-1234');
  assert.strictEqual(extracted('Extract Phone Numbers', 'nothing 2024'), null);
  assert.deepStrictEqual(toasts[0], ['No phone numbers found', 'info']);
});

test('Extract Dates', function () {
  var t = 'Due 2024-01-05 (2024-01-05T10:30:00Z), then 1/5/2024, 13/02/24, 2024/3/7 and January 5th, 2024 or 5 Mar 2023 — Dec 2022, May 7.\n' +
    'Not: 32/1/2024, 2024-13-01, v1.2.3, 1.5.24, 10:30, 3/4 cup';
  assert.strictEqual(extracted('Extract Dates', t), '\n\n--- Dates Found (9) ---\n2024-01-05\n2024-01-05T10:30:00Z\n1/5/2024\n13/02/24\n2024/3/7\nJanuary 5th, 2024\n5 Mar 2023\nDec 2022\nMay 7');
  assert.strictEqual(extracted('Extract Dates', 'no dates, may be later'), null);
});

test('Extract IP Addresses (v4 + v6)', function () {
  var t = 'hosts 10.0.0.1, 192.168.1.0/24 and 10.0.0.1 again; v6 2001:db8::1, 2001:DB8::1, fe80::1%eth0, ::ffff:192.0.2.1, ::1, ' +
    '2001:0db8:85a3:0000:0000:8a2e:0370:7334.\nNot: 256.1.1.1, 1.2.3, 1.2.3.4.5, 12:30:45, 00:1A:2B:3C:4D:5E, std::vector, 1:2:3:4:5:6:7:8:9';
  assert.strictEqual(extracted('Extract IP Addresses', t), '\n\n--- IP Addresses Found (7) ---\n10.0.0.1\n192.168.1.0/24\n2001:db8::1\nfe80::1%eth0\n::ffff:192.0.2.1\n::1\n2001:0db8:85a3:0000:0000:8a2e:0370:7334');
  assert.ok(D.isIPv6('::') === false && D.isIPv6('1::2::3') === false && D.isIPv6('1:2:3:4:5:6:7::') === true);
});

test('Extract Hashtags & Mentions', function () {
  var t = 'Love #JavaScript and #js, #AI #ai! cc @bob, @alice_w. and @Bob — mail bob@x.com, color #fff, #a1b2c3, issue #123, ' +
    'http://x.com/#frag, &#123; #café #2024goals\n# Heading';
  assert.strictEqual(extracted('Extract Hashtags & Mentions', t),
    '\n\n--- Hashtags Found (5) ---\n#JavaScript\n#js\n#AI\n#café\n#2024goals\n\n--- Mentions Found (2) ---\n@bob\n@alice_w');
  assert.strictEqual(extracted('Extract Hashtags & Mentions', 'only @x'), '\n\n--- Mentions Found (1) ---\n@x');
  assert.strictEqual(extracted('Extract Hashtags & Mentions', 'a@b.co # none'), null);
});

test('Extract Money Amounts', function () {
  var t = 'Paid $1,234.56 and €5, 100€, 1.234,56 € and 20 EUR, USD 30, £3.5M, US$7, -$4, 12 dollars, ¥1000, $5k, $1,234.56 again.\n' +
    'Not: the $ sign, 3.50, 20 europeans? EURO, $var';
  assert.strictEqual(extracted('Extract Money Amounts', t),
    '\n\n--- Money Amounts Found (12) ---\n$1,234.56\n€5\n100€\n1.234,56 €\n20 EUR\nUSD 30\n£3.5M\nUS$7\n-$4\n12 dollars\n¥1000\n$5k');
  assert.strictEqual(extracted('Extract Money Amounts', 'costs 5'), null);
});

test('Extract Hex Colours', function () {
  var t = 'a { color: #fff; background: #FFF; border: 1px solid #A1b2C3 } #a1b2c3ff #abcd; not #12345, #abcdefg, &#123;, #zzz, x#fff, #fff-ish';
  assert.strictEqual(extracted('Extract Hex Colours', t), '\n\n--- Hex Colours Found (4) ---\n#fff\n#A1b2C3\n#a1b2c3ff\n#abcd');
  assert.strictEqual(extracted('Extract Hex Colours', ''), null);
});

test('Extract scripts read the selection but append to the end of the note', function () {
  var doc = 'top #abc\nmid #def\nend';
  assert.strictEqual(run('Extract Hex Colours', doc, { sel: [9, 17] }), doc + '\n\n--- Hex Colours Found (1) ---\n#def');
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'pack-data: ' + passed + ' passed');
