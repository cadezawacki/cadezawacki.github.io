/* Checks for the File Converter's pandoc layer: format detection, the
 * reader/writer option mapping, output names, the Markdown AST clean-up,
 * note image handling, and how convert.js wires pandoc targets in.
 * Not loaded by the app. Run: node txt/widgets/convert/convert-pandoc.test.js
 * (pandoc.wasm itself is exercised by the browser checks, not here). */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var P = require('./convert-pandoc.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

// The registration this widget proposes for txt/manifest.json (switch to the
// manifest once it carries the new description / tags).
var MANIFEST = {
  name: 'File Converter',
  description: 'Convert video, audio, photos (HEIC), PDF, Word, spreadsheets & documents (pandoc: ODT, EPUB, LaTeX, Jupyter…) on this device — files never leave it',
  icon: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 8h13l-3.5-3.5'/><path d='M20 16H7l3.5 3.5'/></svg>",
  tags: 'convert,converter,file converter,transcode,compress,video,audio,image,photo,heic,heif,jpeg,jpg,png,webp,gif,ico,favicon,svg,mp4,mov,webm,mkv,avi,mp3,m4a,aac,wav,flac,ogg,opus,extract audio,pdf,pdf to text,pdf to png,images to pdf,docx,word,markdown,html,xlsx,excel,csv,tsv,json,ods,ffmpeg,offline,private,pandoc,document converter,odt,opendocument,epub,ebook,rtf,latex,tex,rst,restructuredtext,org,org mode,mediawiki,wiki,textile,asciidoc,typst,ipynb,jupyter,notebook,pptx,powerpoint,docbook,export note,note to word,import document',
  precache: ['widgets/convert/convert-worker.js', 'widgets/convert/convert-docs.js', 'widgets/convert/convert-pandoc.js', 'widgets/convert/convert-pandoc-worker.js'],
};

// ---- detection -----------------------------------------------------------------
test('detect: by extension, MIME, then content', function () {
  assert.strictEqual(P.detect('txt', 'notes.rst', '', ''), 'rst');
  assert.strictEqual(P.detect('txt', 'a.ORG', '', ''), 'org');
  assert.strictEqual(P.detect('txt', 'page.wiki', '', ''), 'mediawiki');
  assert.strictEqual(P.detect('txt', 'x.adoc', '', ''), 'asciidoc');
  assert.strictEqual(P.detect('txt', 'x.textile', '', ''), 'textile');
  assert.strictEqual(P.detect('latex', 'paper.tex', '', ''), 'latex');
  assert.strictEqual(P.detect('ipynb', 'nb.ipynb', '', ''), 'ipynb');
  assert.strictEqual(P.detect('txt', 'x.typ', '', ''), 'typst');
  assert.strictEqual(P.detect('txt', 'download', 'text/x-rst', ''), 'rst', 'MIME when the name says nothing');
  assert.strictEqual(P.detect('json', 'download', 'application/x-ipynb+json', ''), 'ipynb');
  assert.strictEqual(P.detect('txt', 'paper.txt', 'text/plain', '% draft\n\\documentclass{article}\n'), 'latex', 'sniffed');
  assert.strictEqual(P.detect('json', 'export.json', '', '{\n "cells": [],\n "metadata": {}'), 'ipynb');
  assert.strictEqual(P.detect('txt', 'todo.txt', '', '#+TITLE: Plan\n* heading'), 'org');
  assert.strictEqual(P.detect('xml', 'a.xml', '', '<?xml version="1.0"?>\n<opml version="2.0">'), 'opml');
  assert.strictEqual(P.detect('txt', 'plain.txt', '', 'just words'), '', 'plain text is not guessed');
  assert.strictEqual(P.detect('json', 'data.json', '', '[1,2]'), '');
});
test('detect: containers convert.js identified win; media never maps', function () {
  assert.strictEqual(P.detect('docx', 'x.docx', '', ''), 'docx');
  assert.strictEqual(P.detect('odt', 'x.zip', '', ''), 'odt');
  assert.strictEqual(P.detect('epub', 'book', '', ''), 'epub');
  assert.strictEqual(P.detect('pptx', 'deck.pptx', '', ''), 'pptx');
  assert.strictEqual(P.detect('rtf', 'x.rtf', '', ''), 'rtf');
  assert.strictEqual(P.detect('md', 'readme.md', '', '# hi'), 'md');
  assert.strictEqual(P.detect('html', 'x.html', '', '<html>'), 'html');
  assert.strictEqual(P.detect('csv', 'x.csv', '', ''), 'csv');
  assert.strictEqual(P.detect('tsv', 'x.tsv', '', ''), 'tsv');
  assert.strictEqual(P.detect('png', 'x.tex', '', ''), '', 'a PNG named .tex is still a PNG');
  assert.strictEqual(P.detect('pdf', 'x.pdf', '', ''), '');
  assert.strictEqual(P.detect('xlsx', 'x.xlsx', '', ''), '', 'spreadsheets stay with SheetJS');
});

// ---- writers / plans -----------------------------------------------------------
test('writers offered never include the input format', function () {
  assert.ok(P.writersFor('md').indexOf('md') === -1);
  assert.ok(P.writersFor('note').indexOf('md') === -1);
  ['docx', 'html', 'odt', 'epub', 'rtf', 'latex', 'typst', 'rst', 'org', 'asciidoc', 'ipynb', 'pptx', 'txt'].forEach(function (w) {
    assert.ok(P.writersFor('md').indexOf(w) !== -1, 'md -> ' + w);
  });
  assert.ok(P.writersFor('docx').indexOf('docx') === -1 && P.writersFor('docx')[0] === 'md', 'Markdown first for documents');
  assert.ok(P.writersFor('latex').indexOf('latex') === -1 && P.writersFor('ipynb').indexOf('ipynb') === -1);
  assert.ok(P.writersFor('csv').indexOf('md') !== -1, 'CSV -> Markdown table');
  assert.deepStrictEqual(P.writersFor('nope'), []);
  P.WRITERS.forEach(function (w) { assert.ok(w.ext && w.mime && w.label && w.w, w.key); });
});
test('plan: binary writers write a file, text writers use stdout', function () {
  var p = P.plan({ reader: 'md', writer: 'docx', title: 'Report' });
  assert.strictEqual(p.passes.length, 1);
  assert.strictEqual(p.passes[0].from, 'gfm');
  assert.strictEqual(p.passes[0].to, 'docx');
  assert.strictEqual(p.passes[0]['output-file'], 'output.docx');
  assert.strictEqual(p.outFile, 'output.docx');
  assert.strictEqual(p.input, '', 'text comes in on stdin');
  assert.strictEqual(p.retryFrom, 'gfm-yaml_metadata_block');
  var e = P.plan({ reader: 'md', writer: 'epub', title: 'Book' });
  assert.strictEqual(e.passes[0].to, 'epub3');
  assert.deepStrictEqual(e.passes[0].metadata, { title: 'Book' }, 'EPUB needs a title');
  var l = P.plan({ reader: 'md', writer: 'latex' });
  assert.strictEqual(l.passes[0].standalone, true, 'a .tex that compiles');
  assert.strictEqual(l.outFile, undefined);
  assert.strictEqual(P.plan({ reader: 'md', writer: 'rtf' }).passes[0].standalone, true, 'RTF is only valid standalone');
  assert.strictEqual(P.plan({ reader: 'html', writer: 'org' }).passes[0].wrap, 'none');
});
test('plan: HTML output is one self-contained page', function () {
  var h = P.plan({ reader: 'md', writer: 'html', title: 'Notes' }).passes[0];
  assert.strictEqual(h.to, 'html5');
  assert.strictEqual(h.standalone, true);
  assert.strictEqual(h['embed-resources'], true);
  assert.strictEqual(h.variables.pagetitle, 'Notes');
});
test('plan: binary readers read a named file; Markdown output goes through the AST', function () {
  var p = P.plan({ reader: 'docx', writer: 'md' });
  assert.strictEqual(p.input, 'input.docx');
  assert.strictEqual(p.binIn, true);
  assert.strictEqual(p.md, true);
  assert.strictEqual(p.passes.length, 2);
  assert.deepStrictEqual(p.passes[0]['input-files'], ['input.docx']);
  assert.strictEqual(p.passes[0].to, 'json');
  assert.strictEqual(p.passes[0]['extract-media'], 'media', 'images come out for import');
  assert.deepStrictEqual(p.passes[1], { from: 'json', to: 'gfm-tex_math_gfm', wrap: 'none' });
  assert.strictEqual(p.retryFrom, undefined);
  assert.strictEqual(P.plan({ reader: 'epub', writer: 'md' }).input, 'input.epub');
  assert.strictEqual(P.plan({ reader: 'ipynb', writer: 'md' }).passes[0]['extract-media'], 'media', 'notebook output images');
  assert.strictEqual(P.plan({ reader: 'rst', writer: 'md' }).passes[0]['extract-media'], undefined);
  var n = P.plan({ reader: 'note', writer: 'docx' });
  assert.strictEqual(n.passes[0].from, 'gfm+hard_line_breaks', 'a note keeps its line breaks');
  assert.strictEqual(n.retryFrom, 'gfm+hard_line_breaks-yaml_metadata_block');
  assert.throws(function () { P.plan({ reader: 'md', writer: 'pdf' }); });
});
test('output names', function () {
  assert.strictEqual(P.outName('Report', 'docx'), 'Report.docx');
  assert.strictEqual(P.outName('Paper', 'latex'), 'Paper.tex');
  assert.strictEqual(P.outName('x', 'typst'), 'x.typ');
  assert.strictEqual(P.outName('x', 'asciidoc'), 'x.adoc');
  assert.strictEqual(P.outName('x', 'mediawiki'), 'x.wiki');
  assert.strictEqual(P.outName('x', 'ipynb'), 'x.ipynb');
  assert.strictEqual(P.outName('x', 'txt'), 'x.txt');
  assert.strictEqual(P.baseName('My: file?.docx'), 'My file');
});

// ---- AST clean-up --------------------------------------------------------------
function S(s) { return { t: 'Str', c: s }; }
var NA = ['', [], []];
test('cleanAst unwraps divs/spans, figures and attributes; images become placeholders', function () {
  var ast = {
    'pandoc-api-version': [1, 23, 1], meta: { title: { t: 'MetaInlines', c: [S('Book')] } },
    blocks: [
      { t: 'Div', c: [['ch1', ['section'], []], [
        { t: 'Header', c: [2, ['h', ['x'], [['k', 'v']]], [{ t: 'Span', c: [['anchor', [], []], []] }, S('Intro')]] },
        { t: 'Para', c: [S('See'), { t: 'Space' }, { t: 'Link', c: [NA, [S('ch2')], ['#ch2', '']] }, { t: 'Space' }, { t: 'Link', c: [['', [], [['target', '_blank']]], [S('web')], ['https://x.y', '']] }] },
        { t: 'Figure', c: [NA, [null, [{ t: 'Plain', c: [S('cat')] }]], [{ t: 'Plain', c: [{ t: 'Image', c: [['', [], [['width', '10pt']]], [S('cat')], ['media/media/image1.png', '']] }] }]] },
        { t: 'Para', c: [{ t: 'Image', c: [NA, [S('remote')], ['https://x.y/a.png', '']] }, { t: 'Image', c: [NA, [S('d')], ['data:image/png;base64,AAAA', '']] }] },
        { t: 'CodeBlock', c: [['', ['sourceCode', 'python'], []], 'print(1)'] },
      ]] },
    ],
  };
  var r = P.cleanAst(ast, { 'media/media/image1.png': true });
  var b = r.ast.blocks;
  assert.strictEqual(b[0].t, 'Header', 'title heading added');
  assert.strictEqual(P.inlinesText(b[0].c[2]), 'Book');
  assert.strictEqual(b[1].t, 'Header');
  assert.deepStrictEqual(b[1].c[1], NA, 'no heading attributes');
  assert.strictEqual(P.inlinesText(b[1].c[2]), 'Intro');
  assert.ok(!JSON.stringify(r.ast).match(/"Div"|"Span"|"Figure"/), 'no wrappers left');
  assert.deepStrictEqual(b[2].c[2], S('ch2'), 'in-document link -> its text');
  assert.deepStrictEqual(b[2].c[4].c[0], NA, 'link attributes dropped');
  assert.deepStrictEqual(b[3], { t: 'Plain', c: [S('⟦img 1⟧')] }, 'figure -> image placeholder, caption = alt dropped');
  assert.strictEqual(b[4].c[0].t, 'Image', 'remote image kept as a link');
  assert.deepStrictEqual(b[4].c[1], S('⟦img 2⟧'), 'data: image is ours');
  assert.deepStrictEqual(b[5].c[0], ['', ['python'], []], 'code language kept, pandoc classes gone');
  assert.deepStrictEqual(r.images, [{ n: 1, target: 'media/media/image1.png', alt: 'cat' }, { n: 2, target: 'data:image/png;base64,AAAA', alt: 'd' }]);
});
test('cleanAst keeps a caption that says more than the alt text; no duplicate title', function () {
  var ast = { 'pandoc-api-version': [1, 23], meta: { title: { t: 'MetaString', c: 'Doc' } }, blocks: [
    { t: 'Header', c: [1, NA, [S('Doc')]] },
    { t: 'Figure', c: [NA, [null, [{ t: 'Plain', c: [S('Figure'), { t: 'Space' }, S('one')] }]], [{ t: 'Plain', c: [{ t: 'Image', c: [NA, [], ['a.png', '']] }] }]] },
  ] };
  var r = P.cleanAst(ast, {});
  assert.strictEqual(r.ast.blocks.length, 3);
  assert.strictEqual(r.ast.blocks[1].c[0].t, 'Image', 'unknown file stays an image link');
  assert.strictEqual(r.ast.blocks[2].t, 'Para');
  assert.strictEqual(P.inlinesText(r.ast.blocks[2].c), 'Figure one');
});
test('cleanAst walks tables, lists, quotes and notes', function () {
  var cell = function (bs) { return [NA, { t: 'AlignDefault' }, 1, 1, bs]; };
  var ast = { 'pandoc-api-version': [1, 23], meta: {}, blocks: [
    { t: 'Table', c: [['t', [], []], [null, []], [], [NA, [[NA, [cell([{ t: 'Plain', c: [{ t: 'Span', c: [NA, [S('H')]] }] }])]]]],
      [[NA, 0, [], [[NA, [cell([{ t: 'Div', c: [NA, [{ t: 'Plain', c: [S('v')] }]] }])]]]]], [NA, []]] },
    { t: 'BulletList', c: [[{ t: 'Div', c: [NA, [{ t: 'Plain', c: [S('li')] }]] }]] },
    { t: 'BlockQuote', c: [{ t: 'Para', c: [{ t: 'Note', c: [{ t: 'Div', c: [NA, [{ t: 'Para', c: [S('fn')] }]] }] }] }] },
  ] };
  var j = JSON.stringify(P.cleanAst(ast, {}).ast);
  assert.ok(!/"Div"|"Span"/.test(j), j);
  assert.ok(/"H"/.test(j) && /"v"/.test(j) && /"li"/.test(j) && /"fn"/.test(j));
});

// ---- image placement -------------------------------------------------------------
test('placeImages: alt markers for files, own lines for import', function () {
  var imgs = [{ n: 1, alt: 'a *cat*' }, { n: 2, alt: '' }, { n: 3, alt: 'x', keep: false }];
  var md = '# T\n\n⟦img 1⟧\n\nText ⟦img 2⟧ more\n\n| a | ⟦img 1⟧ |\n\n- ⟦img 2⟧\n\n⟦img 3⟧\n\n    code ⟦img\n';
  var a = P.placeImages(md, imgs, 'alt');
  assert.ok(a.text.indexOf('*[image: a \\*cat\\*]*') !== -1, a.text);
  assert.ok(a.text.indexOf('Text *[image]* more') !== -1);
  assert.ok(a.text.indexOf('⟦img') === a.text.indexOf('⟦img\n'), 'only the unrelated text stays');
  var l = P.placeImages(md, imgs, 'lines');
  assert.ok(/^⟦img 1⟧$/m.test(l.text), 'alone on its line');
  assert.ok(l.text.indexOf('Text\n⟦img 2⟧\nmore') !== -1, l.text);
  assert.ok(l.text.indexOf('| a | *[image: a \\*cat\\*]* |') !== -1, 'tables keep their shape');
  assert.ok(l.text.indexOf('- *[image]*') !== -1, 'list items too');
  assert.ok(l.text.indexOf('*[image: x]*') !== -1, 'keep:false always alt');
  assert.deepStrictEqual(l.kept, [1, 2]);
  assert.deepStrictEqual(l.dropped.sort(), [1, 2, 3]);
  assert.ok(l.text.indexOf('    code ⟦img') !== -1, 'code untouched');
});

// ---- notes ----------------------------------------------------------------------
test('noteInput: app image tokens -> files for embedding writers, markers otherwise', function () {
  var note = 'Hi\n![img:j#abcDEF123=]\n![img:w#xyz|w320] and ![img:a:QUJD]\n![file:report.pdf#h4sh|s1234]\n';
  var e = P.noteInput(note, true);
  assert.strictEqual(e.images.length, 3);
  assert.deepStrictEqual(e.images[0], { path: 'note-img/abcDEF123.jpg', code: 'j', hash: 'abcDEF123=', b64: '' });
  assert.strictEqual(e.images[1].path, 'note-img/xyz.webp');
  assert.deepStrictEqual(e.images[2], { path: 'note-img/inline3.avif', code: 'a', hash: '', b64: 'QUJD' });
  assert.ok(e.text.indexOf('![](note-img/abcDEF123.jpg)') !== -1);
  assert.ok(e.text.indexOf('[file: report.pdf]') !== -1);
  var t = P.noteInput(note, false);
  assert.strictEqual(t.images.length, 0);
  assert.strictEqual(t.text, 'Hi\n*[image]*\n*[image]* and *[image]*\n[file: report.pdf]\n');
});
test('messages: warnings filtered, errors readable', function () {
  assert.deepStrictEqual(P.warningsOf([
    { verbosity: 'INFO', pretty: 'Loaded x' },
    { verbosity: 'WARNING', pretty: 'Could not fetch resource a.png\nmore' },
    { verbosity: 'WARNING', pretty: 'Could not fetch resource a.png\nmore' },
  ]), ['Could not fetch resource a.png']);
  assert.strictEqual(P.errorText('ERROR: Unknown input format foo'), 'This pandoc build can’t do that format');
  assert.ok(/damaged/.test(P.errorText('ERROR: Failed to unpack PPTX archive: not enough bytes')));
  assert.strictEqual(P.errorText(''), 'pandoc couldn’t convert this file');
});

// ---- convert.js wiring -----------------------------------------------------------
var reg = null, css = [];
var fakeWin = {
  Cade: { loadCSS: function (c) { css.push(c); }, asset: function (r) { return r; }, registerWidget: function (o) { reg = o; }, escapeHtml: String },
  __cadeConvertPandoc: P,
};
new Function('window', fs.readFileSync(path.join(__dirname, 'convert.js'), 'utf8'))(fakeWin);
var C = reg._test;
C.addPandocTargets(P);
test('registration matches the proposed manifest entry', function () {
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(reg[k], MANIFEST[k], k); });
  assert.deepStrictEqual(css, ['convert.css']);
  var src = fs.readFileSync(path.join(__dirname, 'convert.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'convert-pandoc-worker.js'), 'utf8');
  MANIFEST.precache.forEach(function (f) {
    var base = f.split('/').pop();
    assert.ok(fs.existsSync(path.join(__dirname, base)), f + ' exists');
    if (base !== 'convert-pandoc-worker.js') assert.ok(src.indexOf("'" + base + "'") !== -1, base + ' is loaded by name');
  });
  assert.ok(src.indexOf("'convert-pandoc-worker.js'") !== -1);
});
test('sniffing: pandoc-only documents get the pdoc category', function () {
  var enc = function (s) { return new Uint8Array(Buffer.from(s)); };
  var sn = C.sniffBytes(enc('Title\n=====\n\n.. note:: hi\n'), 'a.rst', '');
  assert.strictEqual(sn.fmt, 'rst'); assert.strictEqual(sn.cat, 'pdoc');
  assert.strictEqual(C.sniffBytes(enc('\\documentclass{article}'), 'p.tex', '').fmt, 'latex');
  assert.strictEqual(C.sniffBytes(enc('{"cells": []}'), 'n.ipynb', '').fmt, 'ipynb');
  assert.strictEqual(C.sniffBytes(enc('{"a": 1}'), 'n.json', '').cat, 'sheet', 'plain JSON stays a sheet');
  var rtf = C.sniffBytes(enc('{\\rtf1\\ansi hi}'), 'x.rtf', '');
  assert.strictEqual(rtf.fmt, 'rtf'); assert.strictEqual(rtf.cat, 'pdoc');
  assert.strictEqual(C.sniffBytes(enc('# Hi'), 'x.md', '').cat, 'md', 'Markdown unchanged');
});
test('refinePandoc + targets: pandoc writers join the built-in ones', function () {
  var enc = function (s) { return new Uint8Array(Buffer.from(s)); };
  var head = enc('% x\n\\documentclass{article}\n');
  var sn = C.refinePandoc(C.sniffBytes(head, 'paper.txt', 'text/plain'), P, { name: 'paper.txt', type: 'text/plain' }, head);
  assert.strictEqual(sn.fmt, 'latex'); assert.strictEqual(sn.cat, 'pdoc'); assert.strictEqual(sn.reader, 'latex');
  var t = C.targetsFor(sn);
  assert.strictEqual(t[0], 'pd:md');
  assert.ok(t.every(function (x) { return /^pd:/.test(x); }));
  assert.strictEqual(C.defaultTarget(sn, {}, null), 'pd:md');
  var mdh = enc('# Hi\n');
  var md = C.refinePandoc(C.sniffBytes(mdh, 'a.md', ''), P, { name: 'a.md', type: '' }, mdh);
  var mt = C.targetsFor(md);
  assert.deepStrictEqual(mt.slice(0, 3), ['docx', 'html', 'txt'], 'existing conversions first, unchanged');
  assert.ok(mt.indexOf('pd:docx') !== -1 && mt.indexOf('pd:epub') !== -1 && mt.indexOf('pd:md') === -1);
  assert.strictEqual(C.defaultTarget(md, {}, null), 'docx', 'existing default kept');
  assert.deepStrictEqual(C.planFor({ sn: md, target: 'pd:epub', opts: {} }, {}), { engine: 'pandoc', label: 'pandoc', assets: ['pandoc', 'wasishim'] });
  assert.strictEqual(C.planFor({ sn: md, target: 'docx', opts: {} }, {}).engine, 'doc', 'built-in path untouched');
  assert.strictEqual(C.outName('Note', 'pd:latex', ''), 'Note.tex');
  var png = C.refinePandoc({ fmt: 'png', cat: 'image', label: 'PNG' }, P, { name: 'x.png' }, new Uint8Array(0));
  assert.strictEqual(png.reader, undefined);
  var pd = C.refinePandoc({ fmt: 'odt', cat: 'pdoc', label: 'ODT' }, null, { name: 'x.odt' }, new Uint8Array(0));
  assert.strictEqual(pd.cat, 'none', 'no pandoc table (offline): not offered');
  var opts = C.targetOptions({ target: 'docx' }, mt);
  assert.ok(/<optgroup label="More formats · pandoc">/.test(opts) && opts.indexOf('value="docx" selected') !== -1);
});
test('pandoc asset URLs are pinned', function () {
  assert.strictEqual(C.ASSETS.pandoc.url, 'https://unpkg.com/pandoc-wasm@1.1.0/src/pandoc.wasm');
  assert.ok(/browser_wasi_shim@0\.4\.2\//.test(C.ASSETS.wasishim.url));
  assert.ok(C.ASSETS.pandoc.size > 50e6 && C.ASSETS.pandoc.wire < C.ASSETS.pandoc.size);
});
test('new-note names are valid, unused room names', function () {
  assert.strictEqual(C.roomNameFor('Q3 Report.final', []), 'q3 report-final');
  assert.strictEqual(C.roomNameFor('a/b#c$[d]', []), 'a-b-c-d');
  assert.strictEqual(C.roomNameFor('__secret', []), 'secret');
  assert.strictEqual(C.roomNameFor('', []), 'imported');
  assert.strictEqual(C.roomNameFor('Notes', ['notes', 'notes 2']), 'notes 3');
  assert.ok(C.roomNameFor(new Array(300).join('x'), []).length <= 80);
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'convert-pandoc: ' + passed + ' passed');
