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
test('CSV / TSV: a whole note or a ```csv block becomes a table; prose and Markdown do not', function () {
  var b = R.render('name,qty,price\nApple,3,"1,20"\n"Pear ""green""",10,0.5\n', cb);
  assert.strictEqual(b.length, 1);
  assert.ok(/<table class="md-csv">/.test(b[0].h) && /<th>qty<\/th>/.test(b[0].h) && /<td>1,20<\/td>/.test(b[0].h) && /Pear &quot;green&quot;/.test(b[0].h), b[0].h);
  assert.ok(/<td>y<\/td>/.test(html('a\tb\tc\nx\ty\tz\n1\t2\t3\na\tb\tc')));
  assert.ok(/md-csv/.test(html('Intro\n\n```csv\na,b\n1,2\n```')));
  assert.ok(!/md-csv/.test(html('Hello, world.\nI went home, then slept, again.\nOk.')), 'uneven commas: prose');
  assert.ok(!/md-csv/.test(html('# a,b\nc,d\ne,f')), 'markdown stays markdown');
  assert.ok(!/md-csv/.test(html('| a | b |\n|---|---|\n| 1 | 2 |')), 'a markdown table is not csv');
  assert.deepStrictEqual(R.parseDelim('a,"b\nc",d\n1,2,3', ','), [['a', 'b\nc', 'd'], ['1', '2', '3']]);
});
test('```postcard blocks render as coloured text (runs share a span); mono / broken colour data as one colour', function () {
  // a 4×2 card: palette [red, blue], cells r r b b / r · b b ("·" = blank: joins the run)
  var zlib = require('zlib');
  var body = [2, 255, 0, 0, 0, 0, 255, 0, 0, 1, 1, 0, 0, 1, 1];
  function line(bytes, deflate) {
    var b = Buffer.from(bytes), d = deflate ? zlib.deflateRawSync(b) : b;
    return '~ ' + Buffer.concat([Buffer.from([1, deflate ? 1 : 0]), d]).toString('base64');
  }
  var art = '#@<&\n# %@';
  [false, true].forEach(function (deflate) {
    var h = html('```postcard 4x2 classic color dark "Lisbon, 21 Oct"\n' + art + '\n' + line(body, deflate) + '\n```');
    assert.ok(/<figure class="md-pcw"><pre class="md-pc md-pc-dark" style="--pc-cols:4;--k0:#ff0000;--k1:#0000ff"/.test(h), h);
    assert.ok(h.indexOf('<i class=k0>#@</i><i class=k1>&lt;&amp;\n</i><i class=k0># </i><i class=k1>%@</i></pre>') > 0, h);
    assert.ok(/<figcaption>Lisbon, 21 Oct<\/figcaption>/.test(h) && !/~ /.test(h), 'caption shown, colour line hidden');
  });
  // corrupt / mismatched colour data: plain art in one colour, the data line never shows
  [line([2, 255, 0, 0, 0, 0, 255, 0, 0, 1, 1], false), line(body.slice(0, 14).concat([7]), false), '~ AAAA!!', line(body, true).slice(0, 20)].forEach(function (cl, k) {
    var h = html('```postcard 4x2 classic color\n' + art + '\n' + cl + '\n```');
    assert.ok(/class="md-pc md-pc-mono"/.test(h) && !/<i class/.test(h) && />#@&lt;&amp;\n# %@<\/pre>/.test(h), k + ': ' + h);
  });
  // a header that says another size: the colours can't line up → one colour
  assert.ok(!/<i class/.test(html('```postcard 5x2 classic color\n' + art + '\n' + line(body, true) + '\n```')));
  // green / sepia / tint: one ink on their paper; mono uses the theme
  assert.ok(/md-pc-paper" style="--pc-cols:3;color:#6b4423"/.test(html('```postcard 3x1 classic sepia paper\n.:#\n```')));
  assert.ok(/style="--pc-cols:3;color:#3dff7a"/.test(html('```postcard 3x1 classic green\n.:#\n```')));
  assert.ok(/style="--pc-cols:3;color:#aabbcc"/.test(html('```postcard 3x1 classic tint:#abc light\n.:#\n```')));
  assert.ok(/md-pc md-pc-mono/.test(html('```postcard 3x1 classic mono\n.:#\n```')));
  // not a postcard → ordinary code
  assert.ok(/md-code/.test(html('```postcards\nx\n```')));
  assert.ok(/\.md-pc \.k63\{color:var\(--k63\)\}/.test(require('./htmlpreview-md.js').CSS) && /print-color-adjust:exact/.test(require('./htmlpreview-md.js').CSS));
});
test('```postcard: a card made by the widget renders cell for cell', function () {
  var PC = require('../postcard/postcard-core.js'), zlib = require('zlib');
  var img = PC.demoImage(240, 160), c = PC.convert(img.data, img.width, img.height, { cols: 40, style: 'dense', mode: 'color', colors: 16, caption: 'Sunset' });
  var h = html(PC.toText(c, PC.encodeColorsSync(c, zlib.deflateRawSync)));
  var pre = /<pre[^>]*>([\s\S]*)<\/pre>/.exec(h)[1];
  var text = pre.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.strictEqual(text, c.lines.join('\n'));
  // every visible character sits in a span of its own palette colour
  var re = /<i class=k(\d+)>([^<]*)/g, m, pos = 0, flat = c.lines.join('\n'), cells = 0;
  var unesc = function (s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'); };
  var before = pre.slice(0, pre.indexOf('<i'));
  pos = unesc(before).length;
  while ((m = re.exec(pre))) {
    var s = unesc(m[2]);
    for (var i = 0; i < s.length; i++, pos++) {
      var ch = s.charAt(i);
      if (ch === '\n' || ch === ' ') continue;
      var row = flat.slice(0, pos).split('\n').length - 1, col = pos - flat.lastIndexOf('\n', pos - 1) - 1;
      assert.strictEqual(+m[1], c.idx[row * c.cols + col], 'cell ' + row + ',' + col);
      cells++;
    }
    var close = pre.indexOf('<', re.lastIndex), gap = pre.slice(re.lastIndex, close);
    pos += unesc(gap).length;
  }
  assert.ok(cells > 100);
});
console.log((process.exitCode ? 'FAILED, ' : '') + 'passed ' + passed);
