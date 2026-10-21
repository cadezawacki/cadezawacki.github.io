/* Tests for Live Preview's XML / SOAP / JSON tree views (htmlpreview-tree.js)
 * and the widget's registration metadata. Not loaded by the app.
 * Run: node txt/widgets/htmlpreview/htmlpreview-tree.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var TV = require('./htmlpreview-tree.js');
var C = require('../../scripts/pack-markup/markup-core.js');

var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
var hash = function (s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(36); };
function build(lang, text, o) { o = o || {}; o.hash = hash; return TV.build(C, lang, text, o); }

// The Live Preview manifest entry (txt/manifest.json "htmlpreview") as it should read with these changes.
var MANIFEST_ENTRY = {
  id: 'htmlpreview',
  type: 'widget',
  name: 'Live Preview',
  description: 'See the note rendered as you type — Markdown in full (sortable, filterable tables and CSV, tasks, callouts, images…), ```html blocks as live pages (+ nearby css / js), XML / SOAP / JSON as collapsible trees (SOAP envelopes and Faults at a glance) — or select any snippet (HTML, XML, JSON, Markdown…) and preview just that; devices, console, print, full screen',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 8h20"/><polyline points="9 12 7 14 9 16"/><polyline points="15 12 17 14 15 16"/></svg>',
  tags: 'markdown,md,preview,live preview,live html preview,render,rendered,reading view,read mode,html,css,js,javascript,live,web,page,browser,sandbox,iframe,frontend,codepen,playground,xml,soap,json,tree,viewer,xpath,jsonpath,envelope,fault,wsdl,selection,snippet',
  entry: 'widgets/htmlpreview/htmlpreview.js',
  css: 'widgets/htmlpreview/htmlpreview.css',
  precache: [
    'widgets/coderun/coderun-kit.js',
    'widgets/htmlpreview/htmlpreview-md.js',
    'widgets/htmlpreview/htmlpreview-tree.js',
    'scripts/pack-markup/markup-core.js'
  ]
};

var SOAP = '<?xml version="1.0"?>\n<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n<soap:Header><t:Tok xmlns:t="urn:t">abc</t:Tok></soap:Header>\n<soap:Body><m:GetPrice xmlns:m="urn:shop"><m:Item>Apple</m:Item><m:Box><m:W>2</m:W></m:Box></m:GetPrice></soap:Body>\n</soap:Envelope>';
var FAULT = '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"><e:Body><e:Fault><e:Code><e:Value>e:Sender</e:Value></e:Code><e:Reason><e:Text xml:lang="en">Bad &lt;order&gt;</e:Text></e:Reason><e:Detail><Id>42</Id></e:Detail></e:Fault></e:Body></e:Envelope>';

test('the widget registers what the manifest entry says (name / description / icon / tags)', function () {
  var src = fs.readFileSync(path.join(__dirname, 'htmlpreview.js'), 'utf8');
  var m = /Cade\.registerWidget\(\{\s*name: '([^']*)',\s*description: '([^']*)',\s*icon: '([^']*)',\s*tags: '([^']*)'/.exec(src);
  assert.ok(m, 'registerWidget call not found');
  assert.deepStrictEqual([m[1], m[2], m[3], m[4]], [MANIFEST_ENTRY.name, MANIFEST_ENTRY.description, MANIFEST_ENTRY.icon, MANIFEST_ENTRY.tags]);
  MANIFEST_ENTRY.precache.concat([MANIFEST_ENTRY.entry, MANIFEST_ENTRY.css]).forEach(function (p) { assert.ok(fs.existsSync(path.join(__dirname, '..', '..', p)), p); });
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  var cur = man.modules.filter(function (x) { return x.id === 'htmlpreview'; })[0];
  assert.ok(cur);
  // once the manifest is updated it must match (until then only the unchanged fields do)
  if (cur.precache.indexOf('widgets/htmlpreview/htmlpreview-tree.js') >= 0) assert.deepStrictEqual(cur, MANIFEST_ENTRY);
  else ['id', 'type', 'name', 'icon', 'entry', 'css'].forEach(function (k) { assert.strictEqual(cur[k], MANIFEST_ENTRY[k], k); });
});

test('XML block: head with counts, Tree / Source panes, compact tree data with lines', function () {
  var x = '<catalog xmlns:b="urn:b">\n  <!-- c -->\n  <b:book id="1"><title>Dune</title></b:book>\n  <x><![CDATA[<raw>]]></x>\n</catalog>';
  var r = build('xml', x, { off: 1, line: 10, highlight: function (s) { return '<HL>' + s.length + '</HL>'; } });
  assert.ok(/^<div class="tv-blk" data-kind="xml" data-view="tree">/.test(r.h), r.h);
  assert.ok(/<span class="tv-kind">XML<\/span><span class="tv-sum">4 elements · depth 3<\/span>/.test(r.h), r.h);
  assert.ok(/data-tvv="tree"/.test(r.h) && /data-tvv="src"/.test(r.h) && /data-tva="expand"/.test(r.h) && !/data-tvv="soap"/.test(r.h));
  assert.ok(r.h.indexOf('<div class="tv" data-tv="' + r.tk + '"></div>') > 0 && /<HL>\d+<\/HL>/.test(r.h));
  assert.ok(!/line 10/.test(r.h), 'a good tree has no line numbers in its HTML (moving the block does not re-render it)');
  assert.strictEqual(r.data.kind, 'xml'); assert.strictEqual(r.data.off, 1); assert.strictEqual(r.data.ns, true);
  var root = r.data.root[0];
  assert.deepStrictEqual([root.t, root.n, root.l, root.a], ['e', 'catalog', 1, [['xmlns:b', 'urn:b']]]);
  assert.deepStrictEqual(root.c.filter(function (c) { return c.t !== '#'; }).map(function (c) { return c.t + (c.n || ''); }), ['!', 'eb:book', 'ex']);
  assert.strictEqual(root.c[3].l, 3);
  assert.deepStrictEqual(root.c[5].c, [{ t: 'c', v: '<raw>' }]);
  assert.strictEqual(build('xml', x, { off: 1 }).tk, r.tk, 'keyed by content');
});
test('SOAP: the SOAP view first (header entries, operation + namespace, nested parameter tables), tree hidden', function () {
  var r = build('xml', SOAP, {});
  assert.ok(/data-view="soap"/.test(r.h) && /<span class="tv-kind">SOAP 1.1<\/span><span class="tv-sum">GetPrice · /.test(r.h), r.h.slice(0, 400));
  assert.ok(/<div class="tv-pane" data-pane="soap">/.test(r.h) && /<div class="tv-pane" data-pane="tree" hidden>/.test(r.h));
  assert.ok(/Header <span class="sv-n">1 entry<\/span>/.test(r.h) && /<span class="sv-px">t:<\/span><b>Tok<\/b> <code class="sv-ns">urn:t<\/code>/.test(r.h), r.h);
  assert.ok(/<span class="sv-lbl">Operation<\/span> <span class="sv-px">m:<\/span><b>GetPrice<\/b>/.test(r.h) && /<span class="sv-lbl">Namespace<\/span> <code class="sv-ns">urn:shop<\/code>/.test(r.h));
  assert.ok(/<th scope="row" title="urn:shop"><span class="sv-px">m:<\/span><b>Item<\/b><\/th><td><span class="sv-v">Apple<\/span><\/td>/.test(r.h));
  assert.ok(/<b>Box<\/b><\/th><td><table class="sv-t"><tbody><tr><th scope="row" title="urn:shop"><span class="sv-px">m:<\/span><b>W<\/b><\/th><td><span class="sv-v">2<\/span>/.test(r.h), 'nested -> nested table');
  assert.ok(!/sv-fault/.test(r.h));
});
test('SOAP Fault: shown up front and prominently, escaped', function () {
  var r = build('soap', FAULT, {});
  assert.ok(/^<div class="tv-blk tv-fault"/.test(r.h) && /<span class="tv-bad">Fault<\/span>/.test(r.h));
  var i = r.h.indexOf('class="sv-fault" role="alert"'), j = r.h.indexOf('<div class="sv-h">Body</div>');
  assert.ok(i > 0 && i < j, 'the fault comes before the body');
  assert.ok(/<div class="sv-reason">Bad &lt;order&gt;<\/div>/.test(r.h) && /<dt>Code<\/dt><dd><code>e:Sender<\/code><\/dd>/.test(r.h) && /<div class="sv-dh">Detail<\/div><table class="sv-t">/.test(r.h), r.h);
});
test('errors: line / column in editor terms, an excerpt with a caret, Go to line; no tree', function () {
  var r = build('xml', '<a>\n  <b>\n</a>', { line: 21, off: 1 });
  assert.strictEqual(r.tk, ''); assert.strictEqual(r.data, null);
  assert.ok(/<b>Not well-formed XML<\/b> · line 23, column 1/.test(r.h), r.h);
  assert.ok(/does not match &lt;b&gt; \(opened at line 22\)/.test(r.h), 'the open tag line is an editor line too');
  assert.ok(/data-goto="23">Go to line 23</.test(r.h) && /<pre class="tv-ex">/.test(r.h) && /\^/.test(r.h) && /data-view="src"/.test(r.h));
  var j = build('json', '{\n  "a": 1,\n}', { line: 5 });
  assert.ok(/<b>Invalid JSON<\/b> · line 7, column 1/.test(j.h) && /Trailing comma/.test(j.h) && j.tk === '', j.h);
});
test('JSON block: counts and the value as tree data; primitives wrapped', function () {
  var r = build('json', '{"a": [1, 2, {"b": null}], "c": "x"}', { off: 1 });
  assert.ok(/<span class="tv-kind">JSON<\/span><span class="tv-sum">2 keys · 7 values · depth 3<\/span>/.test(r.h), r.h);
  assert.deepStrictEqual(r.data, { kind: 'json', root: { a: [1, 2, { b: null }], c: 'x' }, off: 1 });
  assert.deepStrictEqual(build('json', '42', {}).data.root, [42]);
});
test('rows: syntax classes, counts, leaves on one line, everything escaped', function () {
  var R = TV._rows;
  var e = { t: 'e', n: 'p:x', a: [['xmlns:p', 'urn:p'], ['q', '"><img src=x onerror=alert(1)>']], c: [{ t: 'e', n: 'y', c: [{ t: '#', v: '<b>' }] }, { t: '#', v: '  ' }, { t: '!', v: ' -- ' }] };
  var row = R.xmlRow(e);
  assert.ok(row.open && row.cnt === '2 children', JSON.stringify(row));
  assert.ok(/<span class="tv-px">p:<\/span><span class="tv-nm">x<\/span>/.test(row.h) && /tv-at tv-xmlns/.test(row.h));
  assert.ok(row.h.indexOf('<img') < 0 && /&quot;&gt;&lt;img src=x/.test(row.h), row.h);
  var leaf = R.xmlRow(e.c[0]);
  assert.ok(!leaf.open && /&lt;b&gt;<\/span><span class="tv-p">&lt;\/<\/span><span class="tv-nm">y<\/span>/.test(leaf.h), leaf.h);
  assert.ok(/tv-cm/.test(R.xmlRow({ t: '!', v: 'c' }).h) && /CDATA/.test(R.xmlRow({ t: 'c', v: 'x' }).h) && /&lt;\?pi/.test(R.xmlRow({ t: '?', n: 'pi', v: 'd' }).h));
  assert.deepStrictEqual(R.kids('xml', e).map(function (k) { return k[0]; }), [0, 2], 'whitespace-only text is skipped, indices kept');
  var j = R.jsonRow('k"<', '</script>', false);
  assert.ok(/<span class="tv-k">&quot;k\\&quot;&lt;&quot;<\/span>/.test(j.h) && /<span class="tv-s">&quot;&lt;\/script&gt;&quot;<\/span>/.test(j.h), j.h);
  assert.strictEqual(R.jsonRow('a', [1, 2], false).cnt, '2 items');
  assert.strictEqual(R.jsonRow('a', { x: 1 }, false).cnt, '1 key');
  assert.ok(!R.jsonRow('a', {}, false).open && /tv-kw">null/.test(R.jsonRow(0, null, true).h) && /tv-i">0</.test(R.jsonRow(0, 1, true).h));
  var long = R.xmlRow({ t: '#', v: new Array(5000).join('x') });
  assert.ok(/… 2000 more characters/.test(long.h) || /more characters/.test(long.h));
});
test('staticize: trees drawn as nested <details>, buttons and path bars dropped, no scripts', function () {
  var r = build('xml', '<a><b>1</b><c><d/></c></a>', { off: 1 }), trees = {};
  trees[r.tk] = r.data;
  var s = TV.staticize(r.h, trees);
  assert.ok(/<div class="tv tv-static"><details class="tv-d" open><summary class="tv-r">/.test(s), s);
  assert.ok(!/data-tvv|data-tva|tv-path|<script/.test(s) && /<span class="tv-nm">d<\/span>/.test(s));
  var big = { kind: 'json', root: { a: Array.apply(null, Array(7000)).map(function (x, i) { return i; }) } };
  assert.ok(/… more \(open the note/.test(TV.staticTree(big)));
});
test('ext(): CSS for the shell and frame code that compiles (ES5, no </script>)', function () {
  var x = TV.ext();
  assert.ok(/\.tv-blk\{/.test(x.css) && /\.sv-fault\{/.test(x.css) && /@media \(pointer:coarse\)\{\.tv-btn\{min-height:40px/.test(x.css));
  assert.ok(x.js.indexOf('</script') < 0);
  new Function(x.js); // eslint-disable-line no-new-func
  assert.ok(!/=>|`|\blet\b|\bconst\b/.test(x.js), 'ES5 only in the frame');
});
console.log((process.exitCode ? 'FAILED, ' : '') + 'htmlpreview-tree: ' + passed + ' passed');
