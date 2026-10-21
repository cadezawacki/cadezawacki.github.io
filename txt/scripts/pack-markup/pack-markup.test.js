/* Tests for the Markup Pack: the pure engine (markup-core.js — XML / SOAP /
 * JSON / HTML / Markdown parsing and conversion) and the pack's script
 * metadata. Not loaded by the app. Run: node txt/scripts/pack-markup/pack-markup.test.js
 * Markdown input is parsed with marked; set MARKED=<path to marked.umd.js> (18.0.11)
 * to run those tests too (skipped otherwise). */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path'), vm = require('vm');
var C = require('./markup-core.js');

var passed = 0, skipped = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
function err(xml) { var r = C.parseXML(xml); assert.ok(r.error, 'expected an error for ' + JSON.stringify(xml)); return r.error; }
function ok(xml) { var r = C.parseXML(xml); assert.ok(!r.error, 'unexpected error ' + JSON.stringify(r.error) + ' for ' + JSON.stringify(xml)); return r.doc; }

// The manifest entry this pack needs (until txt/manifest.json lists it).
var MANIFEST_ENTRY = {
  "id": "pack-markup",
  "type": "script-pack",
  "name": "Markup Pack",
  "description": "XML, SOAP, JSON, HTML and Markdown: convert between them (XML ↔ JSON, SOAP ↔ JSON, XML / SOAP / JSON → Markdown or HTML, HTML / Markdown → a JSON or XML document tree) and validate XML — on the selection, the ``` block at the cursor or the note",
  "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='8 6 3 12 8 18'/><polyline points='16 6 21 12 16 18'/><line x1='14' y1='4' x2='10' y2='20'/></svg>",
  "tags": "xml,soap,json,html,markdown,md,convert,converter,xml to json,json to xml,soap to json,json to soap,html to markdown,markdown to html,html to json,markdown to json,validate,well-formed,envelope,namespaces,document tree,wsdl",
  "entry": "scripts/pack-markup/pack-markup.js",
  "precache": [
    "scripts/pack-markup/markup-core.js"
  ],
  "scripts": [
    {
      "name": "Convert to JSON",
      "description": "XML (namespaces kept as prefixed keys, \"@attr\", \"#text\", repeats → arrays), a SOAP envelope (Body payload, or {fault}) or HTML / Markdown (a document tree of sections, paragraphs, lists, tables, code, links) → JSON — the selection, the ``` block at the cursor or the note",
      "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1'/><path d='M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1'/></svg>",
      "tags": "convert,json,xml to json,soap to json,html to json,markdown to json,md to json,xml,soap,html,markdown,md,document tree,parse,envelope,namespaces"
    },
    {
      "name": "XML → JSON (strip namespaces)",
      "description": "XML or SOAP → JSON with the namespace prefixes and xmlns declarations dropped (\"soap:Body\" → \"Body\")",
      "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1'/><path d='M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1'/></svg>",
      "tags": "xml,json,xml to json,convert,strip,namespaces,prefixes,xmlns,soap,local name"
    },
    {
      "name": "Convert to XML",
      "description": "JSON (a single top-level key is the root; arrays → repeated elements; \"@attr\" / \"#text\" honoured; invalid names escaped as _xHHHH_) or HTML / Markdown (the document tree) → XML",
      "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='8 6 3 12 8 18'/><polyline points='16 6 21 12 16 18'/><line x1='14' y1='4' x2='10' y2='20'/></svg>",
      "tags": "convert,xml,json to xml,html to xml,markdown to xml,md to xml,json,html,markdown,md,document tree,elements"
    },
    {
      "name": "JSON → XML…",
      "description": "JSON → XML with the root element name you choose",
      "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='8 6 3 12 8 18'/><polyline points='16 6 21 12 16 18'/><line x1='14' y1='4' x2='10' y2='20'/></svg>",
      "tags": "json,xml,json to xml,convert,root,element,name,prompt"
    },
    {
      "name": "JSON → SOAP Envelope…",
      "description": "Wrap JSON parameters in a SOAP 1.1 / 1.2 envelope — asks for the operation name, its namespace and the version ({\"fault\": {…}} becomes a Fault)",
      "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='5' width='18' height='14' rx='2'/><polyline points='3 7 12 13 21 7'/></svg>",
      "tags": "soap,envelope,json to soap,wsdl,web service,request,operation,namespace,fault,xml,convert,1.1,1.2"
    },
    {
      "name": "Convert to Markdown",
      "description": "XML, a SOAP envelope, JSON (headings for top-level keys, tables for lists of records, nested lists) or HTML → readable Markdown",
      "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='2' y='5' width='20' height='14' rx='2'/><path d='M6 15V9l2.5 3L11 9v6'/><path d='M17 9v6M15 13l2 2 2-2'/></svg>",
      "tags": "convert,markdown,md,xml to markdown,json to markdown,soap to markdown,html to markdown,html to md,readable,table,list"
    },
    {
      "name": "Convert to HTML",
      "description": "XML, a SOAP envelope, JSON (headings, definition lists, tables — escaped) or Markdown → a clean HTML fragment",
      "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 3h16l-1.5 16L12 21l-6.5-2L4 3z'/><path d='M15.5 8H8.5l.3 3.5h6.4l-.4 3.5-2.8 1-2.8-1'/></svg>",
      "tags": "convert,html,markdown to html,md to html,xml to html,json to html,soap to html,render,table,definition list"
    },
    {
      "name": "Validate XML",
      "description": "Check that the selection, the ``` block at the cursor or the note is well-formed XML (with namespaces) — the first error with its line and column, the cursor moved there; SOAP envelopes are recognised",
      "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'/><polyline points='9 12 11 14 15 10'/></svg>",
      "tags": "validate,xml,well-formed,wellformed,check,lint,parse,error,soap,namespaces,xsd,wsdl"
    }
  ]
};

var SOAP11 = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
  '  <soap:Header>',
  '    <auth:Token xmlns:auth="urn:example:auth" soap:mustUnderstand="1">abc123</auth:Token>',
  '  </soap:Header>',
  '  <soap:Body>',
  '    <m:GetPriceResponse xmlns:m="https://www.example.org/prices">',
  '      <m:Item>Apple</m:Item>',
  '      <m:Price currency="USD">1.90</m:Price>',
  '      <m:Tags><m:Tag>fruit</m:Tag><m:Tag>red</m:Tag></m:Tags>',
  '      <m:Note xsi:nil="true"/>',
  '    </m:GetPriceResponse>',
  '  </soap:Body>',
  '</soap:Envelope>'].join('\n');
var FAULT11 = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Server</faultcode><faultstring xml:lang="en">Server was unable to process request.</faultstring><faultactor>http://example.org/svc</faultactor><detail><e:Err xmlns:e="urn:err"><e:Code>500</e:Code><e:Msg>Boom &amp; bust</e:Msg></e:Err></detail></s:Fault></s:Body></s:Envelope>';
var FAULT12 = [
  '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:m="urn:orders">',
  ' <env:Body><env:Fault>',
  '  <env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>m:InvalidOrder</env:Value><env:Subcode><env:Value>m:Missing</env:Value></env:Subcode></env:Subcode></env:Code>',
  '  <env:Reason><env:Text xml:lang="en">Order 42 does not exist</env:Text><env:Text xml:lang="fr">La commande 42 n’existe pas</env:Text></env:Reason>',
  '  <env:Node>http://example.org/node</env:Node><env:Role>http://www.w3.org/2003/05/soap-envelope/role/ultimateReceiver</env:Role>',
  '  <env:Detail><m:OrderId>42</m:OrderId></env:Detail>',
  ' </env:Fault></env:Body>',
  '</env:Envelope>'].join('\n');

// =========================================================================== XML parser
test('parseXML: elements, attributes, text, CDATA, comments, PIs, doctype, positions', function () {
  var d = ok('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE note [<!ENTITY who "World">]>\n<!-- c -->\n<note a="1" b=\'two &amp; &lt;3\'>\n  Hello &who; &#x263A; &#65;<![CDATA[<raw> & ]]><?pi data?><e/></note>\n');
  assert.deepStrictEqual(d.decl, { version: '1.0', encoding: 'UTF-8' });
  var r = C.rootEl(d);
  assert.strictEqual(r.name, 'note');
  assert.strictEqual(r.line, 4);
  assert.deepStrictEqual(r.attrs, [['a', '1'], ['b', 'two & <3']]);
  assert.deepStrictEqual(r.children.map(function (c) { return c.type; }), ['text', 'cdata', 'pi', 'element']);
  assert.strictEqual(r.children[0].value, '\n  Hello World ☺ A');
  assert.strictEqual(r.children[1].value, '<raw> & ');
  assert.strictEqual(d.elements, 2);
  assert.strictEqual(d.depth, 2);
  assert.deepStrictEqual(d.children.map(function (c) { return c.type; }), ['pi', 'doctype', 'comment', 'element']);
});
test('parseXML: whitespace / BOM before the declaration and newlines in attributes', function () {
  ok('﻿<?xml version="1.0"?><a/>');
  ok('\n\n  <?xml version="1.0"?>\n<a/>');
  assert.strictEqual(C.rootEl(ok('<a t="x\ny\tz&#10;"/>')).attrs[0][1], 'x y z\n');
});
test('parseXML: namespaces resolve (prefixed, default, inherited, xml:)', function () {
  var d = ok('<r xmlns="urn:d" xmlns:p="urn:p"><p:a p:x="1" xml:lang="en"><b/></p:a><c xmlns=""/></r>');
  var r = C.rootEl(d), a = C.elementsOf(r)[0], b = C.elementsOf(a)[0], c = C.elementsOf(r)[1];
  assert.strictEqual(r.ns, 'urn:d'); assert.strictEqual(a.ns, 'urn:p'); assert.strictEqual(a.local, 'a'); assert.strictEqual(a.prefix, 'p');
  assert.strictEqual(b.ns, 'urn:d'); assert.strictEqual(c.ns, null);
});
test('parseXML: well-formedness errors carry line and column', function () {
  var cases = [
    ['<a><b></a>', 1, 7, /Closing tag <\/a> does not match <b> \(opened at line 1\)/],
    ['<a>\n  <b>\n</a>', 3, 1, /does not match <b> \(opened at line 2\)/],
    ['<a>\n<b>x</b>', 1, 1, /<a> is never closed/],
    ['<a/><b/>', 1, 5, /Only one root element/],
    ['<a/>\ntext', 2, 1, /Text after the root element/],
    ['text<a/>', 1, 1, /Text before the root element/],
    ['', 1, 1, /empty/],
    ['<!-- only -->', 1, 14, /No root element/],
    ['<a x=1/>', 1, 6, /must be quoted/],
    ['<a x="1" x="2"/>', 1, 10, /Duplicate attribute x/],
    ['<a x/>', 1, 4, /needs a value/],
    ['<a x="<"/>', 1, 7, /"<" is not allowed in an attribute value/],
    ['<a>&nbsp;</a>', 1, 4, /Undefined entity &nbsp; \(an HTML entity/],
    ['<a>AT&T</a>', 1, 6, /bare "&"/],
    ['<a>&#0;</a>', 1, 4, /not a legal XML character/],
    ['<a>\u0001</a>', 1, 4, /U\+0001 is not allowed/],
    ['<p:a/>', 1, 2, /Namespace prefix "p" is not declared/],
    ['<a q:x="1"/>', 1, 2, /prefix "q" is not declared \(on attribute q:x\)/],
    ['<a><!-- x -- y --></a>', 1, 11, /"--" is not allowed inside a comment/],
    ['<a><![CDATA[x</a>', 1, 4, /Unclosed CDATA/],
    ['<a>]]></a>', 1, 4, /"]]>" is not allowed in text/],
    ['<a><?xml version="1.0"?></a>', 1, 4, /only allowed at the very start/],
    ['<1a/>', 1, 2, /Expected an element name/],
    ['<a></b c>', 1, 8, /Expected ">" to close <\/b>/],
    ['<a>x</a></a>', 1, 9, /Unexpected closing tag <\/a> after the root element/],
    ['<a b="1"c="2"/>', 1, 9, /Expected whitespace or ">"/],
    ['<a:b:c xmlns:a="u"/>', 1, 2, /Invalid qualified name/],
    ['<a xmlns:p=""/>', 1, 4, /cannot be bound to an empty namespace/],
    ['<a', 1, 1, /Unclosed tag <a>/],
  ];
  cases.forEach(function (c) {
    var e = err(c[0]);
    assert.ok(c[3].test(e.message), JSON.stringify(c[0]) + ' -> ' + e.message);
    assert.deepStrictEqual([e.line, e.col], [c[1], c[2]], JSON.stringify(c[0]) + ' -> ' + e.message + ' @' + e.line + ':' + e.col);
  });
  // a DOCTYPE with an external DTD may define entities we can't see: kept as text, not an error
  assert.strictEqual(C.textOf(C.rootEl(ok('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "x.dtd"><a>&nbsp;</a>'))), '&nbsp;');
});
test('parseXML: malformed input never throws, always reports', function () {
  ['<', '<<', '<a', '<a b', '<a b=', '<a b="', '</', '<!', '<!-', '<![CDATA[', '<?', '<?x', '<!DOCTYPE', '&', '<a>&', '<a>&#x;</a>', '<a>&#xZZ;</a>', '\u0000'].forEach(function (s) {
    var r = C.parseXML(s);
    assert.ok(r.error && r.error.line >= 1 && r.error.col >= 1 && typeof r.error.message === 'string', JSON.stringify(s));
  });
});

// =========================================================================== XML <-> JSON
test('xmlToJson: "@attr", "#text", repeats -> arrays, prefixes kept, empty -> null', function () {
  var j = C.xmlToJson(SOAP11);
  var op = j['soap:Envelope']['soap:Body']['m:GetPriceResponse'];
  assert.strictEqual(j['soap:Envelope']['@xmlns:soap'], 'http://schemas.xmlsoap.org/soap/envelope/');
  assert.strictEqual(op['@xmlns:m'], 'https://www.example.org/prices');
  assert.strictEqual(op['m:Item'], 'Apple');
  assert.deepStrictEqual(op['m:Price'], { '@currency': 'USD', '#text': '1.90' });
  assert.deepStrictEqual(op['m:Tags'], { 'm:Tag': ['fruit', 'red'] });
  assert.deepStrictEqual(op['m:Note'], { '@xsi:nil': 'true' });
  assert.deepStrictEqual(C.xmlToJson('<a><b/><c></c><d> x </d></a>'), { a: { b: null, c: null, d: ' x ' } });
  assert.deepStrictEqual(C.xmlToJson('<p>Hello <b>big</b> world</p>'), { p: { b: 'big', '#text': 'Hello world' } }, 'mixed content: the text joined');
  assert.deepStrictEqual(C.xmlToJson('<a><![CDATA[<x>]]></a>'), { a: '<x>' });
});
test('xmlToJson stripNs: no prefixes, no xmlns attributes', function () {
  var j = C.xmlToJson(SOAP11, { stripNs: true });
  assert.deepStrictEqual(Object.keys(j.Envelope), ['Header', 'Body']);
  assert.deepStrictEqual(j.Envelope.Header.Token, { '@mustUnderstand': '1', '#text': 'abc123' });
  assert.deepStrictEqual(j.Envelope.Body.GetPriceResponse.Price, { '@currency': 'USD', '#text': '1.90' });
  assert.deepStrictEqual(j.Envelope.Body.GetPriceResponse.Note, { '@nil': 'true' });
});
test('xmlToJson: element names like __proto__ / constructor stay plain keys', function () {
  var j = C.xmlToJson('<r><__proto__>x</__proto__><constructor>1</constructor><constructor>2</constructor></r>');
  assert.ok(Object.prototype.hasOwnProperty.call(j.r, '__proto__'));
  assert.strictEqual(JSON.stringify(j), '{"r":{"__proto__":"x","constructor":["1","2"]}}');
  assert.strictEqual(Object.getPrototypeOf(j.r), Object.prototype);
});
test('jsonToXml: root, arrays -> repeated elements, @attr / #text, escaping', function () {
  assert.strictEqual(C.jsonToXml({ order: { '@id': 7, item: ['Pen', 'Ink & <Co>'], note: null, ok: true, n: 1.5 } }),
    '<?xml version="1.0" encoding="UTF-8"?>\n<order id="7">\n  <item>Pen</item>\n  <item>Ink &amp; &lt;Co&gt;</item>\n  <note/>\n  <ok>true</ok>\n  <n>1.5</n>\n</order>\n');
  assert.strictEqual(C.jsonToXml({ a: 1, b: 2 }, { decl: false }), '<root>\n  <a>1</a>\n  <b>2</b>\n</root>\n', 'several keys -> a "root"');
  assert.strictEqual(C.jsonToXml([1, [2, 3]], { decl: false }), '<root>\n  <item>1</item>\n  <item>\n    <item>2</item>\n    <item>3</item>\n  </item>\n</root>\n');
  assert.strictEqual(C.jsonToXml({ x: 1 }, { root: 'doc', decl: false }), '<doc>\n  <x>1</x>\n</doc>\n', 'a different root wraps');
  assert.strictEqual(C.jsonToXml({ x: { y: 1 } }, { root: 'x', decl: false }), '<x>\n  <y>1</y>\n</x>\n', 'the same root does not');
  assert.strictEqual(C.jsonToXml({ p: { '@q': 'a"b<c\n', '#text': 'hi' } }, { decl: false }), '<p q="a&quot;b&lt;c&#10;">hi</p>\n');
  assert.strictEqual(C.jsonToXml({ s: 'bad\u0001char' }, { decl: false }), '<s>bad�char</s>\n', 'illegal XML characters become U+FFFD');
  assert.strictEqual(C.jsonToXml({ c: { '#cdata': 'a]]>b' } }, { decl: false }), '<c><![CDATA[a]]]]><![CDATA[>b]]></c>\n');
});
test('jsonToXml: invalid names escaped as _xHHHH_ and decoded back', function () {
  var x = C.jsonToXml({ r: { 'first name': 'a', '1st': 'b', '': 'c', 'a/b': 'd', 'ünï': 'e', 'x_x0020_y': 'f', 'no:prefix': 'g' } }, { decl: false });
  assert.ok(/<first_x0020_name>a</.test(x) && /<_x0031_st>b</.test(x) && /<_>c</.test(x) && /<a_x002F_b>d</.test(x) && /<ünï>e</.test(x) && /<no_x003A_prefix>g</.test(x), x);
  ok(x);
  assert.deepStrictEqual(C.xmlToJson(x).r, { 'first name': 'a', '1st': 'b', '_': 'c', 'a/b': 'd', 'ünï': 'e', 'x_x0020_y': 'f', 'no:prefix': 'g' });
});
test('round trips: JSON -> XML -> JSON (string values, arrays of 2+)', function () {
  [
    { a: 'x' },
    { catalog: { '@xmlns:b': 'urn:b', 'b:book': [{ '@id': '1', title: 'Dune', 'b:price': '9.99' }, { '@id': '2', title: 'Emma <1815>', 'b:price': '7' }] } },
    { 'soap:Envelope': { '@xmlns:soap': 'http://schemas.xmlsoap.org/soap/envelope/', 'soap:Body': { Op: { '@xmlns': 'urn:x', v: ['a & b', '"q"'] } } } },
    { unicode: { 'ключ': 'значение', emoji: '😀 ok', ws: '  spaced  ' } },
  ].forEach(function (v) { assert.deepStrictEqual(C.xmlToJson(C.jsonToXml(v)), v, JSON.stringify(v)); });
});
test('JSON -> XML -> JSON: what does not survive (documented limits)', function () {
  // nested arrays come back as <item> lists, one-element arrays as single values, numbers / booleans as strings
  assert.deepStrictEqual(C.xmlToJson(C.jsonToXml({ r: { list: [['1', '2'], ['3', '4']] } })), { r: { list: [{ item: ['1', '2'] }, { item: ['3', '4'] }] } });
  assert.deepStrictEqual(C.xmlToJson(C.jsonToXml({ r: { one: ['x'], n: 1, b: false } })), { r: { one: 'x', n: '1', b: 'false' } });
});
test('round trips: XML -> JSON -> XML -> JSON is stable (namespaces kept)', function () {
  [SOAP11, FAULT11, FAULT12, '<a xmlns="urn:d"><b x="1">t</b><b>u</b><c/></a>'].forEach(function (x) {
    var j = C.xmlToJson(x), x2 = C.jsonToXml(j);
    ok(x2);
    assert.deepStrictEqual(C.xmlToJson(x2), j);
  });
  var j2 = C.xmlToJson(SOAP11, { stripNs: true });
  assert.deepStrictEqual(C.xmlToJson(C.jsonToXml(j2), { stripNs: true }), j2);
});

// =========================================================================== SOAP
test('soapOf: SOAP 1.1 request with header, operation, namespace', function () {
  var s = C.soapOf(SOAP11);
  assert.strictEqual(s.version, '1.1');
  assert.strictEqual(s.headers.length, 1);
  assert.strictEqual(s.headers[0].local, 'Token');
  assert.strictEqual(s.operation.local, 'GetPriceResponse');
  assert.strictEqual(s.operation.ns, 'https://www.example.org/prices');
  assert.strictEqual(s.fault, null);
  assert.strictEqual(C.soapOf('<Envelope><Body/></Envelope>'), null, 'no SOAP namespace: plain XML');
  assert.strictEqual(C.soapOf('<x:Envelope xmlns:x="urn:other"/>'), null);
  assert.strictEqual(C.soapOf('<a><b></a>'), null, 'malformed: not SOAP');
  assert.strictEqual(C.soapOf('<E:Envelope xmlns:E="http://www.w3.org/2003/05/soap-envelope"><E:Body/></E:Envelope>').version, '1.2', 'any prefix');
  assert.strictEqual(C.soapOf('<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/"><Body><Ping xmlns="urn:p"/></Body></Envelope>').operation.local, 'Ping', 'default namespace');
});
test('soapOf: SOAP 1.1 and 1.2 Faults', function () {
  var f = C.soapOf(FAULT11).fault;
  assert.strictEqual(f.code, 's:Server'); assert.strictEqual(f.reason, 'Server was unable to process request.'); assert.strictEqual(f.actor, 'http://example.org/svc');
  assert.strictEqual(f.detailEl.local, 'detail');
  var g = C.soapOf(FAULT12).fault;
  assert.strictEqual(g.code, 'env:Sender'); assert.deepStrictEqual(g.subcodes, ['m:InvalidOrder', 'm:Missing']);
  assert.strictEqual(g.reason, 'Order 42 does not exist');
  assert.deepStrictEqual(g.reasons, [{ lang: 'en', text: 'Order 42 does not exist' }, { lang: 'fr', text: 'La commande 42 n’existe pas' }]);
  assert.strictEqual(g.node, 'http://example.org/node'); assert.ok(/ultimateReceiver$/.test(g.role));
});
test('soapToJson: Body payload only (namespaces stripped), Fault -> {fault}', function () {
  assert.deepStrictEqual(C.soapToJson(SOAP11), { GetPriceResponse: { Item: 'Apple', Price: { '@currency': 'USD', '#text': '1.90' }, Tags: { Tag: ['fruit', 'red'] }, Note: { '@nil': 'true' } } });
  assert.deepStrictEqual(C.soapToJson(FAULT11), { fault: { code: 's:Server', reason: 'Server was unable to process request.', actor: 'http://example.org/svc', detail: { Err: { Code: '500', Msg: 'Boom & bust' } } } });
  var g = C.soapToJson(FAULT12).fault;
  assert.deepStrictEqual([g.code, g.subcodes, g.reason, g.detail], ['env:Sender', ['m:InvalidOrder', 'm:Missing'], 'Order 42 does not exist', { OrderId: '42' }]);
  assert.deepStrictEqual(C.soapToJson(SOAP11, { stripNs: false })['m:GetPriceResponse']['m:Item'], 'Apple');
  assert.throws(function () { C.soapToJson('<a/>'); }, /Not a SOAP envelope/);
  assert.throws(function () { C.soapToJson('<a>'); }, /XML error at line 1, column 1: <a> is never closed/);
});
test('jsonToSoap: 1.1 / 1.2 envelopes, operation + namespace, headers, round trips', function () {
  var x = C.jsonToSoap({ GetPrice: { Item: 'Apple', Qty: 3 } }, { ns: 'urn:shop' });
  assert.strictEqual(x, '<?xml version="1.0" encoding="UTF-8"?>\n<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n  <soap:Body>\n    <GetPrice xmlns="urn:shop">\n      <Item>Apple</Item>\n      <Qty>3</Qty>\n    </GetPrice>\n  </soap:Body>\n</soap:Envelope>\n');
  var s = C.soapOf(x);
  assert.strictEqual(s.operation.ns, 'urn:shop'); assert.strictEqual(C.elementsOf(s.operation)[0].ns, 'urn:shop', 'parameters inherit the namespace');
  var y = C.jsonToSoap({ Item: 'Pear' }, { operation: 'Get Price', version: '1.2' });
  assert.strictEqual(C.soapOf(y).version, '1.2');
  assert.strictEqual(C.soapOf(y).operation.name, 'Get_x0020_Price');
  assert.deepStrictEqual(C.soapToJson(y), { 'Get Price': { Item: 'Pear' } });
  var h = C.jsonToSoap({ Header: { Token: 'abc' }, Body: { Ping: null } }, {});
  assert.strictEqual(C.soapOf(h).headers[0].local, 'Token'); assert.strictEqual(C.soapOf(h).operation.local, 'Ping');
  // round trips through the envelope
  [{ GetPriceResponse: { Item: 'Apple', Tags: { Tag: ['a', 'b'] } } }, { Echo: 'hi' }].forEach(function (v) {
    ['1.1', '1.2'].forEach(function (ver) { assert.deepStrictEqual(C.soapToJson(C.jsonToSoap(v, { version: ver, ns: 'urn:t' })), v); });
  });
  // Faults both ways, both versions
  var f11 = { fault: { code: 'soap:Client', reason: 'Bad input', actor: 'urn:a', detail: { Field: 'qty' } } };
  assert.deepStrictEqual(C.soapToJson(C.jsonToSoap(f11, {})), f11);
  var f12 = { fault: { code: 'soap:Sender', subcodes: ['m:One', 'm:Two'], reason: 'Nope', node: 'urn:n', role: 'urn:r', detail: { Why: 'x' } } };
  assert.deepStrictEqual(C.soapToJson(C.jsonToSoap(f12, { version: '1.2' })), f12);
});

// =========================================================================== JSON
test('parseJSON: values, and errors with line / column (Safari-proof)', function () {
  assert.deepStrictEqual(C.parseJSON('{"a":[1,2]}').value, { a: [1, 2] });
  [['{"a": 1,}', 1, 9, /Trailing comma before "}"/], ['{\n "a": 1,\n "b": [1,2,]\n}', 3, 12, /Trailing comma before "]"/], ["{'a': 1}", 1, 2, /"quoted" key/],
    ['{"a" 1}', 1, 6, /Expected ":"/], ['[1 2]', 1, 4, /Expected "," or "]"/], ['{"a": tru}', 1, 7, /Expected a value/], ['"abc', 1, 5, /Unterminated string/],
    ['{"a": "x\ny"}', 1, 9, /line break inside a string/], ['{} x', 1, 4, /Unexpected text after/], ['', 1, 1, /Expected a value/], ['{"a": 01}', 1, 8, /Expected "," or "}"/]].forEach(function (c) {
    var e = C.parseJSON(c[0]).error;
    assert.ok(e && c[3].test(e.message), JSON.stringify(c[0]) + ' -> ' + (e && e.message));
    assert.deepStrictEqual([e.line, e.col], [c[1], c[2]], JSON.stringify(c[0]) + ' @' + e.line + ':' + e.col);
  });
  assert.throws(function () { C.jsonValue('[1,]'); }, /JSON error at line 1, column 4: Trailing comma/);
});

// =========================================================================== HTML
test('parseHTML: void / raw-text elements, implied end tags, entities, junk tolerated', function () {
  var d = C.parseHTML('<p>One<p>Two &amp; &nbsp;&copy; &bogus; &#x41;<br>x<ul><li>a<li>b</ul><script>if (a<b) {}</script><table><tr><td>1<td>2<tr><td>3</table></b></i><');
  var names = d.children.map(function (c) { return c.name || c.type; });
  assert.deepStrictEqual(names, ['p', 'p', 'ul', 'script', 'table', 'text']);
  assert.strictEqual(d.children[1].children[0].value, 'Two &  © &bogus; A');
  assert.strictEqual(d.children[2].children.length, 2);
  assert.strictEqual(d.children[3].children[0].value, 'if (a<b) {}');
  var trs = d.children[4].children;
  assert.strictEqual(trs.length, 2); assert.strictEqual(trs[0].children.length, 2);
});
var PAGE = '<!doctype html><html><head><title>My Page</title><style>p{}</style></head><body>' +
  '<p>Intro with <a href="https://a.b">a link</a>.</p>' +
  '<div><h1 id="top">Top</h1><p>Para<br>two</p>' +
  '<ul><li><input type="checkbox" checked> done</li><li>todo<ul><li>nested</li></ul></li></ul>' +
  '<h2>Sub</h2><ol start="3"><li>three</li></ol>' +
  '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>' +
  '<pre><code class="language-js">let x = 1;\n</code></pre>' +
  '<blockquote><p>Quoted</p></blockquote><figure><img src="i.png" alt="pic"><figcaption>Cap</figcaption></figure><hr>' +
  '<dl><dt>T</dt><dd>D</dd></dl>' +
  '<h2>Second</h2><p>x</p><h1>Next</h1><p>y</p></div><script>alert(1)</script></body></html>';
test('htmlToDoc: headings -> nested sections; paragraphs, lists, tasks, tables, code, quotes, images, definitions, links', function () {
  var d = C.htmlToDoc(PAGE);
  assert.strictEqual(d.type, 'document'); assert.strictEqual(d.title, 'My Page');
  assert.deepStrictEqual(d.content, [{ type: 'paragraph', text: 'Intro with a link.', links: [{ text: 'a link', href: 'https://a.b' }] }]);
  assert.deepStrictEqual(d.sections.map(function (s) { return [s.heading, s.level]; }), [['Top', 1], ['Next', 1]]);
  var top = d.sections[0];
  assert.strictEqual(top.id, 'top');
  assert.deepStrictEqual(top.content[0], { type: 'paragraph', text: 'Para\ntwo' });
  assert.deepStrictEqual(top.content[1], { type: 'list', ordered: false, items: [{ text: 'done', checked: true }, { text: 'todo', children: [{ type: 'list', ordered: false, items: [{ text: 'nested' }] }] }] });
  assert.deepStrictEqual(top.sections.map(function (s) { return s.heading; }), ['Sub', 'Second']);
  var sub = top.sections[0].content;
  assert.deepStrictEqual(sub.map(function (b) { return b.type; }), ['list', 'table', 'code', 'quote', 'image', 'rule', 'definitions']);
  assert.deepStrictEqual(sub[0], { type: 'list', ordered: true, start: 3, items: [{ text: 'three' }] });
  assert.deepStrictEqual(sub[1], { type: 'table', headers: ['a', 'b'], rows: [['1', '2']] });
  assert.deepStrictEqual(sub[2], { type: 'code', language: 'js', text: 'let x = 1;' });
  assert.deepStrictEqual(sub[3], { type: 'quote', content: [{ type: 'paragraph', text: 'Quoted' }] });
  assert.deepStrictEqual(sub[4], { type: 'image', src: 'i.png', alt: 'pic', caption: 'Cap' });
  assert.deepStrictEqual(sub[6], { type: 'definitions', items: [{ term: 'T', description: 'D' }] });
  assert.ok(JSON.stringify(d).indexOf('alert') < 0 && JSON.stringify(d).indexOf('p{}') < 0, 'scripts / styles dropped');
  assert.deepStrictEqual(C.htmlToDoc('just <b>text</b>'), { type: 'document', content: [{ type: 'paragraph', text: 'just text' }], sections: [] });
});
test('docToXml: the same tree as well-formed XML', function () {
  var x = C.docToXml(C.htmlToDoc(PAGE)), d = ok(x), r = C.rootEl(d);
  assert.strictEqual(r.name, 'document'); assert.strictEqual(C.attrOf(r, 'title'), 'My Page');
  assert.deepStrictEqual(C.elementsOf(r).map(function (e) { return e.name; }), ['paragraph', 'section', 'section']);
  assert.ok(/<paragraph>\n\s*<text>Intro with a link.<\/text>\n\s*<link href="https:\/\/a.b">a link<\/link>/.test(x), x);
  assert.ok(/<section level="1" id="top">\n\s*<heading>Top<\/heading>/.test(x));
  assert.ok(/<item checked="true">done<\/item>/.test(x) && /<code language="js">let x = 1;<\/code>/.test(x) && /<header>\n\s*<cell>a<\/cell>/.test(x));
  assert.ok(/<image src="i.png" alt="pic" caption="Cap"\/>/.test(x) && /<rule\/>/.test(x) && /<definition>\n\s*<term>T<\/term>/.test(x));
});
test('htmlToMarkdown: headings, emphasis, links, lists, tasks, code, quotes, tables, escaping', function () {
  assert.strictEqual(C.htmlToMarkdown(PAGE), [
    'Intro with [a link](https://a.b).', '', '# Top', '', 'Para\ntwo', '', '- [x] done\n- todo\n  - nested', '', '## Sub', '', '3. three', '',
    '| a | b |\n| --- | --- |\n| 1 | 2 |', '', '```js\nlet x = 1;\n```', '', '> Quoted', '', '![pic](i.png)', '', 'Cap', '', '---', '', '- **T**\n  D', '',
    '## Second', '', 'x', '', '# Next', '', 'y', ''].join('\n'));
  assert.deepStrictEqual(C.htmlToDoc('<p><a href="/big.png"><img src="s.png" alt="A"></a></p><p>see <img src="i.png" alt="pic"> here</p>').content,
    [{ type: 'image', src: 's.png', alt: 'A' }, { type: 'paragraph', text: 'see pic here' }]);
  assert.strictEqual(C.htmlToMarkdown('<p><strong>b</strong> <em>i</em> <del>s</del> <code>a`b</code> <mark>m</mark> <img src="data:image/png;base64,AAA" alt="x"></p>'), '**b** *i* ~~s~~ ``a`b`` %%yellow|m%% [image: x]\n');
  assert.strictEqual(C.htmlToMarkdown('<p>*not* _em_ [x] 1. # a</p><p># head</p><p>1. one</p>'), '\\*not\\* \\_em\\_ \\[x\\] 1. # a\n\n\\# head\n\n1\\. one\n');
  assert.strictEqual(C.htmlToMarkdown('<table><tr><td>a|b</td></tr></table>'), '| a\\|b |\n| --- |\n');
  assert.strictEqual(C.htmlToMarkdown('<pre>has ```fence``` in it</pre>'), '````\nhas ```fence``` in it\n````\n');
  assert.strictEqual(C.htmlToMarkdown('<a href="/x y" title="T">go</a>'), '[go](/x%20y "T")\n');
});

// =========================================================================== -> Markdown / HTML
var CATALOG = '<catalog><book id="1"><title>Dune</title><price currency="USD">9.99</price></book><book id="2"><title>Emma | 1815</title><price>7</price></book><owner><name>Ada</name><city>London</city></owner></catalog>';
test('valueToMarkdown: headings for top-level keys, tables for record lists, nested lists', function () {
  assert.strictEqual(C.xmlToMarkdown(CATALOG), '# catalog\n\n## book\n\n| id | title | price |\n| --- | --- | --- |\n| 1 | Dune | 9.99 (currency=USD) |\n| 2 | Emma \\| 1815 | 7 |\n\n## owner\n\n- **name:** Ada\n- **city:** London\n');
  assert.strictEqual(C.valueToMarkdown({ name: 'x', list: [1, 2], deep: { a: { b: { c: { d: 1 } } } }, empty: [] }),
    '- **name:** x\n\n## list\n\n- 1\n- 2\n\n## deep\n\n### a\n\n- **b**\n  - **c**\n    - **d:** 1\n\n## empty\n\n- *(empty list)*\n');
  assert.strictEqual(C.valueToMarkdown([{ a: 1, b: { c: 2 } }, 'x']), '## 1\n\n- **a:** 1\n\n### b\n\n- **c:** 2\n\n## 2\n\nx\n');
  assert.strictEqual(C.valueToMarkdown('*hi*'), '\\*hi\\*\n');
});
test('valueToHtml: escaped headings, definition lists, tables', function () {
  var h = C.xmlToHtml(CATALOG);
  assert.ok(h.indexOf('<h1>catalog</h1>\n<h2>book</h2>\n<table>\n<thead><tr><th>id</th><th>title</th><th>price</th></tr></thead>') === 0, h);
  assert.ok(/<td>9.99 \(currency=USD\)<\/td>/.test(h) && /<h2>owner<\/h2>\n<dl>\n<dt>name<\/dt><dd>Ada<\/dd>/.test(h));
  var x = C.valueToHtml({ '<script>': '<img src=x onerror=alert(1)>', list: [{ a: '"q"' }] });
  assert.ok(x.indexOf('<script>') < 0 && x.indexOf('<img') < 0 && /&lt;script&gt;/.test(x) && /&quot;q&quot;/.test(x), x);
});
test('SOAP -> Markdown / HTML: operation title, namespace, header section, Fault fields', function () {
  var m = C.soapToMarkdown(SOAP11);
  assert.ok(m.indexOf('# GetPriceResponse\n\n*SOAP 1.1 · namespace `https://www.example.org/prices`*\n\n## Header\n\n- **Token:** abc123 (mustUnderstand=1)\n\n## Body\n\n- **Item:** Apple\n- **Price:** 1.90 (currency=USD)') === 0, m);
  var f = C.soapToMarkdown(FAULT11);
  assert.ok(f.indexOf('# SOAP Fault\n\n*SOAP 1.1*\n\n- **code:** s:Server\n- **reason:** Server was unable to process request.\n- **actor:** http://example.org/svc\n\n## detail') === 0, f);
  var h = C.soapToHtml(FAULT12);
  assert.ok(/<h1>SOAP Fault<\/h1>/.test(h) && /<dt>reason<\/dt><dd>Order 42 does not exist<\/dd>/.test(h) && /<em>SOAP 1.2<\/em>/.test(h), h);
});

// =========================================================================== sniffing
test('sniff: JSON, XML, SOAP, HTML, Markdown', function () {
  [['{"a":1}', 'json'], ['  [1, 2]\n', 'json'], ['[{"broken": }]', 'json'], ['[link](x) and [y]', 'markdown'], ['[x]', 'markdown'],
    ['<note><to>x</to></note>', 'xml'], ['<?xml version="1.0"?><html/>', 'xml'], [SOAP11, 'soap'], [FAULT12, 'soap'],
    ['<div class="x">hi</div>', 'html'], ['<p>a</p><p>b</p>', 'html'], ['<!DOCTYPE html><title>x</title>', 'html'], ['<br>', 'html'],
    ['<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>', 'html'], ['<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>', 'html'],
    ['<a:b>', 'xml'], ['<order><item>broken</order>', 'xml'], ['# Title\n\ntext', 'markdown'], ['plain words', 'markdown'], ['   ', 'text']].forEach(function (c) {
    assert.strictEqual(C.sniff(c[0]).type, c[1], JSON.stringify(c[0].slice(0, 40)));
  });
  assert.strictEqual(C.sniff('\n\n<order>\n<item></order>').xml.error.line, 4, 'positions count the leading lines');
});

// =========================================================================== speed
test('large input: 2 MB of XML parses, converts and round-trips quickly', function () {
  var parts = ['<?xml version="1.0"?>\n<rows xmlns:x="urn:x">'];
  var N = 16000;
  for (var i = 0; i < N; i++) parts.push('<x:row id="' + i + '" kind="k&amp;' + (i % 7) + '"><name>Item ' + i + '</name><v>' + (i * 3) + '</v><!-- c --><note><![CDATA[a<b]]></note></x:row>');
  parts.push('</rows>');
  var xml = parts.join('\n');
  assert.ok(xml.length > 1.5e6);
  var t0 = Date.now(), r = C.parseXML(xml), t1 = Date.now();
  assert.ok(!r.error && r.doc.elements === 1 + N * 4, JSON.stringify(r.error));
  var j = C.xmlToJson(r.doc), t2 = Date.now();
  assert.strictEqual(j.rows['x:row'].length, N);
  var back = C.jsonToXml(j), t3 = Date.now();
  assert.ok(!C.parseXML(back).error);
  var bad = xml.slice(0, xml.length - 3), t4 = Date.now(), e = C.parseXML(bad).error, t5 = Date.now();
  assert.ok(e && e.line > N, JSON.stringify(e));
  var big = JSON.stringify(j), t6 = Date.now(), pj = C.parseJSON(big.slice(0, -2)), t7 = Date.now();
  assert.ok(pj.error);
  [['parse', t1 - t0, 1500], ['toJson', t2 - t1, 1000], ['toXml', t3 - t2, 1500], ['error', t5 - t4, 1500], ['json error scan', t7 - t6, 1500]].forEach(function (x) { assert.ok(x[1] < x[2], x[0] + ' took ' + x[1] + ' ms'); });
});

// =========================================================================== Markdown (marked)
(function () {
  if (!process.env.MARKED) { skipped++; return; }
  var M = new (require(process.env.MARKED).Marked)({ gfm: true, breaks: true, async: false });
  test('Markdown -> JSON / XML document tree (via marked, as the pack does)', function () {
    var md = '# Plan\n\nIntro with [a link](https://x.y).\n\n## Tasks\n\n- [x] Milk\n- [ ] Bread\n  - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```py\nprint(1)\n```\n\n> quote\n\n## Next\n\nEnd';
    var d = C.htmlToDoc(M.parse(md));
    assert.strictEqual(d.title, 'Plan');
    var plan = d.sections[0];
    assert.deepStrictEqual(plan.content, [{ type: 'paragraph', text: 'Intro with a link.', links: [{ text: 'a link', href: 'https://x.y' }] }]);
    assert.deepStrictEqual(plan.sections.map(function (s) { return s.heading; }), ['Tasks', 'Next']);
    var t = plan.sections[0].content;
    assert.deepStrictEqual(t[0].items[0], { text: 'Milk', checked: true });
    assert.deepStrictEqual(t[0].items[1], { text: 'Bread', checked: false, children: [{ type: 'list', ordered: false, items: [{ text: 'nested' }] }] });
    assert.deepStrictEqual(t[1], { type: 'table', headers: ['a', 'b'], rows: [['1', '2']] });
    assert.deepStrictEqual(t[2], { type: 'code', language: 'py', text: 'print(1)' });
    assert.deepStrictEqual(t[3], { type: 'quote', content: [{ type: 'paragraph', text: 'quote' }] });
    ok(C.docToXml(d));
    // HTML -> Markdown -> HTML keeps the structure
    var back = C.htmlToDoc(M.parse(C.htmlToMarkdown(M.parse(md))));
    assert.deepStrictEqual(back, d);
  });
})();

// =========================================================================== the pack's scripts
test('pack-markup.js registers the scripts the manifest entry lists (name / description / icon / tags)', function () {
  var reg = [], win = { Cade: { asset: function (x) { return x; }, registerScript: function (s) { reg.push(s); }, showToast: function () {} } };
  var ctx = { window: win };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'pack-markup.js'), 'utf8'), ctx);
  var metas = reg.map(function (src) {
    var m = JSON.parse(/\/\*\*\s*([\s\S]*?)\s*\*\*\//.exec(src)[1]);
    assert.ok(/async function main\(ctx\) \{\n  await window\.__CADE_MARKUP__\.(run\(ctx, "[\w-]+"\)|validate\(\));\n\}$/.test(src), src.slice(-120));
    return { name: m.name, description: m.description, icon: m.icon, tags: m.tags };
  });
  assert.deepStrictEqual(metas, MANIFEST_ENTRY.scripts);
  assert.strictEqual(MANIFEST_ENTRY.entry, 'scripts/pack-markup/pack-markup.js');
  assert.deepStrictEqual(MANIFEST_ENTRY.precache, ['scripts/pack-markup/markup-core.js']);
  MANIFEST_ENTRY.precache.concat([MANIFEST_ENTRY.entry]).forEach(function (p) { assert.ok(fs.existsSync(path.join(__dirname, '..', '..', p)), p); });
  // once the manifest lists the pack it must match this entry
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  var list = man.modules || man.items || man;
  var found = (Array.isArray(list) ? list : []).filter(function (m) { return m && m.id === 'pack-markup'; })[0];
  if (found) assert.deepStrictEqual(found, MANIFEST_ENTRY);
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'pack-markup: ' + passed + ' passed' + (skipped ? ' (Markdown tests skipped: set MARKED=<path to marked.umd.js>)' : ''));
