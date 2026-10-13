/* Tests for the Live Preview's Markdown renderer (htmlpreview-md.js). Not loaded
 * by the app. Needs marked 18.0.11 (the version the widget pins):
 *   MARKED=/path/to/marked.umd.js node txt/widgets/htmlpreview/htmlpreview-md.test.js
 * (https://cdn.jsdelivr.net/npm/marked@18.0.11/lib/marked.umd.js) */
'use strict';
var assert = require('assert');
if (!process.env.MARKED) { console.log('skipped: set MARKED=<path to marked.umd.js>'); process.exit(0); }
var R = require('./htmlpreview-md.js').create(require(process.env.MARKED));
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
var cb = { embed: function (l) { return 'E' + l; }, image: function (c, ref, d) { return (ref ? 'r' : 'i') + d.slice(0, 4); } };
function html(src) { return R.render(src, cb).map(function (b) { return b.h; }).join(''); }

test('blocks carry their first editor line', function () {
  var b = R.render('# A\n\npara one\nline two\n\n- x\n- y\n\n```js\nlet a\n```', cb);
  assert.deepStrictEqual(b.map(function (x) { return x.l; }), [1, 3, 6, 9]);
  assert.ok(/<br>/.test(b[1].h), 'line breaks kept as typed');
});
test('task boxes know their line; nested too', function () {
  var h = html('- [ ] a\n- [x] b\n  - [ ] c');
  assert.ok(/data-tl="1"/.test(h) && /checked data-tl="2"/.test(h) && /data-tl="3"/.test(h), h);
});
test('keys: same content, same key; duplicates get an occurrence', function () {
  var a = R.render('one\n\n---\n\ntwo\n\n---', cb), b = R.render('one changed\n\n---\n\ntwo\n\n---', cb);
  assert.strictEqual(a[1].k.split('.')[1], '1');
  assert.strictEqual(a[3].k.split('.')[1], '2');
  assert.notStrictEqual(a[0].k, b[0].k);
  assert.strictEqual(a[2].k, b[2].k);
});
test('app syntax: highlights, spoilers, images, files, footnotes', function () {
  var h = html('%%yellow|hi%% %%/red|r%% ==green|g== %%nope|x%% ||secret|| ![img:j#abcdef0123456789abcdef] ![file:a.pdf#0123456789abcdef|s10]\n\nref[^n]\n\n[^n]: note');
  assert.ok(/<mark class="md-hl" style="background:rgba\(250,204,21/.test(h));
  assert.ok(/color:#dc2626/.test(h) && /rgba\(34,197,94/.test(h));
  assert.ok(/%%nope\|x%%/.test(h), 'an unknown colour is not a highlight');
  assert.ok(/class="md-spoiler"[^>]*>secret</.test(h));
  assert.ok(/data-cimg="rabcd"/.test(h) && /md-file/.test(h) && /a\.pdf/.test(h));
  assert.ok(/href="#fn-n"/.test(h) && /id="fn-n"/.test(h));
});
test('callouts, folds, plain quotes', function () {
  assert.ok(/md-co md-co-tip/.test(html('> [!tip] Title\n> body')) && />Title</.test(html('> [!tip] Title\n> body')));
  assert.ok(/<details class="md-co md-co-warning"[^>]*><summary/.test(html('> [!caution]- Closed\n> x')));
  assert.ok(/<details[^>]* open>/.test(html('> [!note]+ Open\n> x')));
  assert.ok(/<blockquote>/.test(html('> just a quote')));
});
test('html blocks become embeds; other code is highlighted and escaped', function () {
  assert.ok(/md-embed" data-ek="E1"/.test(html('```html\n<b>x</b>\n```')));
  var h = html('```js\nconst a = "<b>"; // c\n```');
  assert.ok(/tk-k">const</.test(h) && /tk-s">&quot;&lt;b&gt;&quot;</.test(h) && /tk-c">\/\/ c</.test(h));
  assert.ok(/md-output/.test(html('```output\n42\n```')));
});
test('headings get unique anchors; tables render', function () {
  var h = html('# Intro\n\n## Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(/id="intro"/.test(h) && /id="intro-1"/.test(h) && /<table>/.test(h));
});
test('shell and static documents', function () {
  var s = R.shellDoc('tok', ':root{--bg:#fff}');
  assert.ok(/<article id="md"/.test(s) && /"tok"/.test(s) && /<\/script><\/body>/.test(s));
  var b = R.render('```html\n<i>x</i>\n```\n\n![img:j#abcdef0123456789abcdef]', cb);
  var d = R.staticDoc(b, ':root{}', { rabcd: 'data:image/jpeg;base64,AAAA' }, { E1: '<i>x</i>' });
  assert.ok(/srcdoc="&lt;i&gt;x&lt;\/i&gt;"/.test(d) && /src="data:image\/jpeg;base64,AAAA"/.test(d) && !/<script/.test(d));
});
console.log((process.exitCode ? 'FAILED, ' : '') + 'passed ' + passed);
