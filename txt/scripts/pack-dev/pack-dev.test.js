/* Tests for the Dev Pack. Loads pack-dev.js with a stubbed
 * window.Cade.registerScript, builds each script's main() from its source
 * string exactly like the host does (new Function), and runs it against a
 * fake CodeMirror-ish editor. Not loaded by the app (not in the manifest).
 * Run: node txt/scripts/pack-dev/pack-dev.test.js
 *      node txt/scripts/pack-dev/pack-dev.test.js --manifest   (print manifest rows of the new scripts)
 * Cursor / selection markers in test docs: ¦ = cursor, « » = selection. */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path'), vm = require('vm');

var passed = 0, pending = [];
function test(name, fn) { pending.push([name, fn]); }

// ------------------------------------------------------------------ load the pack
var SOURCES = [];
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'pack-dev.js'), 'utf8'),
  { window: { Cade: { registerScript: function (s) { SOURCES.push(s); } } } });
var SCRIPTS = {};
SOURCES.forEach(function (src) {
  var m = /^\/\*\*([\s\S]*?)\*\*\/\n?([\s\S]*)$/.exec(src);
  var meta = JSON.parse(m[1]);
  SCRIPTS[meta.name] = { meta: meta, code: m[2] };
});

var NEW = ['Lines → Array Literal…', 'Lines → SQL IN List', 'fetch → cURL', 'Colour Convert', 'Colour Shades', 'px → rem', 'rem → px',
  'Base32 Encode', 'Base32 Decode', 'Base58 Encode', 'Base58 Decode', 'Line Endings → LF', 'Line Endings → CRLF (Copy)',
  'Show Line Endings', 'Humanize Bytes', 'Humanize Durations', 'Sum Durations'];

if (process.argv.indexOf('--manifest') >= 0) {
  console.log(JSON.stringify(NEW.map(function (n) {
    var m = SCRIPTS[n].meta;
    return { name: m.name, description: m.description, icon: m.icon, tags: m.tags };
  }), null, 2));
  process.exit(0);
}

// ------------------------------------------------------------------ fake editor
function mkState(text, anchor, head, readOnly) {
  var lines = text.split('\n'), starts = [], p = 0;
  lines.forEach(function (l) { starts.push(p); p += l.length + 1; });
  function line(n) { return { number: n, from: starts[n - 1], to: starts[n - 1] + lines[n - 1].length, text: lines[n - 1] }; }
  return {
    readOnly: !!readOnly,
    doc: {
      length: text.length, lines: lines.length,
      toString: function () { return text; },
      line: line,
      lineAt: function (pos) {
        if (pos < 0 || pos > text.length) throw new RangeError('lineAt ' + pos);
        var n = 1;
        while (n < lines.length && starts[n] <= pos) n++;
        return line(n);
      }
    },
    selection: { main: { from: Math.min(anchor, head), to: Math.max(anchor, head), anchor: anchor, head: head } },
    sliceDoc: function (a, b) { return text.slice(a, b == null ? text.length : b); }
  };
}

function mkEnv(doc, opts) {
  opts = opts || {};
  var a = doc.indexOf('«'), b = doc.indexOf('»'), c = doc.indexOf('¦'), anchor = 0, head = 0;
  if (a >= 0) { doc = doc.replace('«', ''); b = doc.indexOf('»'); doc = doc.replace('»', ''); anchor = a; head = b; }
  else if (c >= 0) { doc = doc.replace('¦', ''); anchor = head = c; }
  var env = { toasts: [], copied: [], asked: [], store: {} };
  var editor = {
    state: mkState(doc.replace(/\r\n?/g, '\n'), anchor, head, opts.readOnly),
    dispatch: function (spec) {
      var st = editor.state, text = st.doc.toString(), ch = [].concat(spec.changes || []).slice().sort(function (x, y) { return x.from - y.from; });
      var out = '', pos = 0;
      ch.forEach(function (c) {
        var to = c.to == null ? c.from : c.to;
        if (c.from < pos || to > text.length) throw new RangeError('bad change');
        out += text.slice(pos, c.from) + String(c.insert).replace(/\r\n?/g, '\n');   // CodeMirror normalises line breaks
        pos = to;
      });
      out += text.slice(pos);
      var sel = spec.selection ? spec.selection.anchor : Math.min(st.selection.main.head, out.length);
      editor.state = mkState(out, sel, sel, st.readOnly);
    }
  };
  var prompts = (opts.prompts || []).slice();
  env.window = {
    Cade: { editor: editor, store: { get: function (k) { return env.store[k]; }, set: function (k, v) { env.store[k] = v; } } },
    navigator: { clipboard: {
      writeText: function (t) { env.copied.push(t); return Promise.resolve(); },
      readText: function () { return opts.clipboard === undefined ? Promise.reject(new Error('denied')) : Promise.resolve(opts.clipboard); }
    } },
    prompt: function (msg, def) { env.asked.push({ msg: msg, def: def }); if (!prompts.length) throw new Error('unexpected prompt: ' + msg); return prompts.shift(); },
    btoa: function (s) { return Buffer.from(s, 'latin1').toString('base64'); },
    URL: URL, encodeURIComponent: encodeURIComponent, encodeURI: encodeURI, crypto: globalThis.crypto
  };
  env.editor = editor;
  env.showToast = function (msg, type) { env.toasts.push({ msg: msg, type: type || 'info' }); };
  return env;
}

// Run a script by name on `doc`; returns { doc, toasts, copied, asked, sel }.
async function run(name, doc, opts) {
  var s = SCRIPTS[name];
  assert.ok(s, 'no script ' + name);
  var env = mkEnv(doc, opts);
  var ctx = { get selection() { return ''; }, get fullText() { return env.editor.state.doc.toString(); } };
  var main = new Function('window', 'document', 'ctx', 'showToast', s.code + '\nreturn main;')(env.window, {}, ctx, env.showToast);
  await main(ctx);
  await new Promise(function (r) { setTimeout(r, 0); });
  return { doc: env.editor.state.doc.toString(), toasts: env.toasts, copied: env.copied, asked: env.asked, sel: env.editor.state.selection.main };
}
async function out(name, doc, opts) { return (await run(name, doc, opts)).doc; }
function errors(r) { return r.toasts.filter(function (t) { return t.type === 'error'; }).map(function (t) { return t.msg; }); }

// Pure helpers pulled out of a script's source (a helper is any top-level function).
function helpers(name) {
  var s = SCRIPTS[name], names = [], re = /^(?:async )?function (\w+)/gm, m;
  while ((m = re.exec(s.code))) if (m[1] !== 'main') names.push(m[1]);
  var win = { btoa: function (x) { return Buffer.from(x, 'latin1').toString('base64'); }, URL: URL, encodeURIComponent: encodeURIComponent };
  return new Function('window', 'showToast', s.code + '\nreturn {' + names.map(function (n) { return n + ': ' + n; }).join(', ') + '};')(win, function () {});
}

// ================================================================== metadata
test('metadata: 31 unique scripts, the new ones present, every source compiles', function () {
  assert.strictEqual(SOURCES.length, 31);
  assert.strictEqual(Object.keys(SCRIPTS).length, 31);
  NEW.forEach(function (n) {
    var m = SCRIPTS[n] && SCRIPTS[n].meta;
    assert.ok(m, 'missing ' + n);
    assert.ok(m.description && m.tags && /^<svg viewBox='0 0 24 24'/.test(m.icon), n);
    assert.ok(/(^|,)dev$/.test(m.tags), n + ' tags end in dev');
  });
  Object.keys(SCRIPTS).forEach(function (n) { new Function('window', 'document', 'ctx', 'showToast', SCRIPTS[n].code + '\nreturn main;'); });
});

test('metadata: existing pack-dev rows still match txt/manifest.json', function () {
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  var mod = (man.modules || man).filter ? (man.modules || man).filter(function (x) { return x.id === 'pack-dev'; })[0] : null;
  assert.ok(mod, 'pack-dev in manifest');
  mod.scripts.forEach(function (row) {
    var m = SCRIPTS[row.name] && SCRIPTS[row.name].meta;
    assert.ok(m, 'manifest row ' + row.name + ' is registered');
    ['description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(m[k], row[k], row.name + ' ' + k); });
  });
});

// ================================================================== existing scripts (no regressions)
test('existing: To Hex / Number Base Convert / cURL → fetch still work', async function () {
  assert.strictEqual(await out('To Hex', 'x = 255¦'), 'x = 0xFF');
  assert.strictEqual(await out('Number Base Convert', '255¦'), '255 = 0xFF = 0b11111111 = 0o377');
  var r = await out('cURL → fetch', "curl -H 'A: b' https://x.io/¦");
  assert.ok(/await fetch\('https:\/\/x\.io\/'/.test(r) && /'A': 'b'/.test(r), r);
});

// ================================================================== Lines → Array Literal…
test('array: JS / JSON / Python / Go with escaping, preview prompt, remembered choice', async function () {
  var doc = "«it's\nsay \"hi\"\nback\\slash»";
  assert.strictEqual(await out('Lines → Array Literal…', doc, { prompts: ['js'] }), "['it\\'s', 'say \"hi\"', 'back\\\\slash']");
  assert.strictEqual(await out('Lines → Array Literal…', doc, { prompts: ['2'] }), '["it\'s", "say \\"hi\\"", "back\\\\slash"]');
  assert.strictEqual(await out('Lines → Array Literal…', doc, { prompts: ['python'] }), "['it\\'s', 'say \"hi\"', 'back\\\\slash']");
  assert.strictEqual(await out('Lines → Array Literal…', doc, { prompts: ['golang'] }), '[]string{"it\'s", "say \\"hi\\"", "back\\\\slash"}');
  var r = await run('Lines → Array Literal…', '«a\nb\nc»', { prompts: ['json'] });
  assert.ok(/1  JavaScript {2}\['a', 'b', …\]/.test(r.asked[0].msg), r.asked[0].msg);
  assert.ok(/4  Go {10}\[\]string\{"a", "b", …\}/.test(r.asked[0].msg), r.asked[0].msg);
  assert.strictEqual(r.asked[0].def, '1');
});

test('array: numbers bare only when every line is a number; big ints / leading zeros stay strings', async function () {
  assert.strictEqual(await out('Lines → Array Literal…', '«1\n-2.5\n3e4»', { prompts: ['js'] }), '[1, -2.5, 3e4]');
  assert.strictEqual(await out('Lines → Array Literal…', '«1\n2\nx»', { prompts: ['js'] }), "['1', '2', 'x']");
  assert.strictEqual(await out('Lines → Array Literal…', '«007\n12»', { prompts: ['json'] }), '["007", "12"]');
  assert.strictEqual(await out('Lines → Array Literal…', '«1\n2»', { prompts: ['go'] }), '[]int{1, 2}');
  assert.strictEqual(await out('Lines → Array Literal…', '«1\n2.5»', { prompts: ['go'] }), '[]float64{1, 2.5}');
  assert.strictEqual(await out('Lines → Array Literal…', '«12345678901234567890\n1»', { prompts: ['js'] }), "['12345678901234567890', '1']");
  assert.strictEqual(await out('Lines → Array Literal…', '«12345678901234567890\n1»', { prompts: ['py'] }), '[12345678901234567890, 1]');
});

test('array: > 80 chars goes one per line with the right trailing comma; blanks skipped; paragraph at cursor', async function () {
  var items = []; for (var i = 0; i < 12; i++) items.push('item number ' + i);
  var doc = '«' + items.join('\n') + '\n\n»';
  var js = await out('Lines → Array Literal…', doc, { prompts: ['js'] });
  assert.strictEqual(js.split('\n')[0], '[');
  assert.strictEqual(js.split('\n')[1], "  'item number 0',");
  assert.ok(/'item number 11',\n\]$/.test(js), js);
  var json = await out('Lines → Array Literal…', doc, { prompts: ['json'] });
  assert.ok(/"item number 11"\n\]$/.test(json), json);
  JSON.parse(json);
  var go = await out('Lines → Array Literal…', doc, { prompts: ['go'] });
  assert.ok(/^\[\]string\{\n\t"item number 0",\n/.test(go) && /"item number 11",\n\}$/.test(go), go);
  // cursor in a paragraph: only that paragraph converts
  assert.strictEqual(await out('Lines → Array Literal…', 'head\n\na\nb¦\nc\n\ntail', { prompts: ['js'] }), "head\n\n['a', 'b', 'c']\n\ntail");
});

test('array: control chars, unicode, a single comma line, pasted list with commas and quotes, bad answer, cancel', async function () {
  assert.strictEqual(await out('Lines → Array Literal…', '«a\tb\u2028c\nü😀»', { prompts: ['js'] }), "['a\\tb\\u2028c', 'ü😀']");
  assert.strictEqual(await out('Lines → Array Literal…', 'x, y, z¦', { prompts: ['py'] }), "['x', 'y', 'z']");
  assert.strictEqual(await out('Lines → Array Literal…', "«'a',\n'b',\n'c'»", { prompts: ['js'] }), "['a', 'b', 'c']");
  var r = await run('Lines → Array Literal…', '«a\nb»', { prompts: ['cobol'] });
  assert.strictEqual(r.doc, 'a\nb');
  assert.ok(/Unknown language/.test(errors(r)[0]));
  assert.strictEqual(await out('Lines → Array Literal…', '«a\nb»', { prompts: [null] }), 'a\nb');
  r = await run('Lines → Array Literal…', '«\n  \n»', { prompts: [] });
  assert.ok(/No lines/.test(errors(r)[0]));
});

// ================================================================== Lines → SQL IN List
test('sql in: quoting, numbers, dedupe, blanks, wrapping', async function () {
  assert.strictEqual(await out('Lines → SQL IN List', "«O'Brien\nsmith\n\nsmith\nx»"), "IN ('O''Brien', 'smith', 'x')");
  assert.strictEqual(await out('Lines → SQL IN List', '«3\n1\n3\n2.50\n2.5»'), 'IN (3, 1, 2.50)');
  assert.strictEqual(await out('Lines → SQL IN List', '«3\nabc\n4»'), "IN ('3', 'abc', '4')");
  assert.strictEqual(await out('Lines → SQL IN List', '«00123\n45»'), "IN ('00123', '45')");
  var ids = []; for (var i = 0; i < 20; i++) ids.push('customer-' + i);
  var w = await out('Lines → SQL IN List', '«' + ids.join('\n') + '»');
  assert.ok(/^IN \(\n  'customer-0',\n/.test(w) && /'customer-19'\n\)$/.test(w), w);
  var r = await run('Lines → SQL IN List', '«a\na\nb»');
  assert.ok(/1 duplicate removed/.test(r.toasts[0].msg));
  assert.strictEqual(await out('Lines → SQL IN List', 'a, b,c¦'), "IN ('a', 'b', 'c')");
});

// ================================================================== fetch → cURL
test('fetch → cURL: JSON body, headers object, method, inserted below the fence', async function () {
  var doc = [
    '```js',
    "const res = await fetch('https://api.example.com/users', {",
    "  method: 'POST',",
    "  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer abc' },",
    "  body: JSON.stringify({ name: 'Ann', age: 3, tags: ['a'], skip: undefined }),",
    '});¦',
    '```',
    'after'].join('\n');
  var r = await out('fetch → cURL', doc);
  var want = ['```bash',
    "curl 'https://api.example.com/users' \\",
    "  -H 'Content-Type: application/json' \\",
    "  -H 'Authorization: Bearer abc' \\",
    '  --data-raw \'{"name":"Ann","age":3,"tags":["a"]}\'',
    '```'].join('\n');
  assert.strictEqual(r, doc.replace('¦', '').replace('```\nafter', '```\n\n' + want + '\nafter'));
  // running again does not stack a second block
  var again = await run('fetch → cURL', r.replace("'https://api", "'https://ap¦i"));
  assert.strictEqual(again.doc, r);
  assert.ok(/Already converted/.test(again.toasts[0].msg));
});

test('fetch → cURL: shell quoting of quotes, newlines, control chars; methods', async function () {
  var r = await out('fetch → cURL', "fetch('https://x.io/a?b=1&c=2', { method: 'put', body: \"it's \\n ok\" })¦");
  assert.ok(r.indexOf("curl 'https://x.io/a?b=1&c=2' \\\n  -X PUT \\\n  -H 'Content-Type: text/plain;charset=UTF-8' \\\n  --data-raw 'it'\\''s \n ok'") >= 0, r);
  r = await out('fetch → cURL', "fetch('https://x.io', { method: 'DELETE', headers: { 'X-A': 'tab\\there\\r' } })¦");
  assert.ok(r.indexOf("-X DELETE") >= 0 && r.indexOf("-H $'X-A: tab\\there\\r'") >= 0, r);
  r = await out('fetch → cURL', "fetch('https://x.io', { method: 'patch' })¦");
  assert.ok(/-X patch/.test(r), r);                    // fetch only upper-cases the standard six
  r = await out('fetch → cURL', "fetch('https://x.io', { method: 'HEAD' })¦");
  assert.ok(/curl 'https:\/\/x\.io' \\\n  --head/.test(r), r);
  r = await out('fetch → cURL', "fetch('https://x.io')¦");
  assert.ok(/```bash\ncurl 'https:\/\/x\.io'\n```/.test(r), r);
});

test('fetch → cURL: variables, template literals, new Headers, URLSearchParams, FormData, timeout', async function () {
  var doc = [
    "const base = 'https://api.example.com';",
    "const token = getToken();",
    "const headers = new Headers({ Accept: 'application/json' });",
    "headers.append('Authorization', `Bearer ${token}`);",
    "const form = new FormData();",
    "form.append('name', 'Ann O\\'Neil');",
    "form.append('avatar', fileInput.files[0], 'me.png');",
    "await fetch(`${base}/upload`, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(5000), credentials: 'include' });¦"
  ].join('\n');
  var r = await out('fetch → cURL', doc);
  assert.ok(r.indexOf("curl 'https://api.example.com/upload' \\") >= 0, r);
  assert.ok(r.indexOf("-H 'Accept: application/json' \\") >= 0, r);
  assert.ok(r.indexOf("-H 'Authorization: Bearer '\"$token\" \\") >= 0, r);
  assert.ok(r.indexOf("--form-string 'name=Ann O'\\''Neil' \\") >= 0, r);
  assert.ok(r.indexOf("-F 'avatar=@me.png' \\") >= 0, r);
  assert.ok(r.indexOf('--max-time 5') >= 0, r);
  assert.ok(/# set these shell variables first[^\n]*\$token/.test(r), r);
  assert.ok(/# credentials: 'include'/.test(r), r);
  assert.ok(!/-X POST/.test(r), 'POST implied by the body');

  r = await out('fetch → cURL', "fetch('/api/login', { method: 'POST', body: new URLSearchParams({ user: 'a b', pass: \"p&ss!\" }) })¦");
  assert.ok(r.indexOf("--data-raw 'user=a+b&pass=p%26ss%21'") >= 0, r);
  assert.ok(!/Content-Type/.test(r), 'URLSearchParams: curl -d already sends form-urlencoded');
  assert.ok(/# relative URL/.test(r), r);

  r = await out('fetch → cURL', "fetch(process.env.API_URL + '/x', { headers: [['X-Key', process.env.KEY]], body: JSON.stringify({ id: user.id }, null, 2) })¦");
  assert.ok(r.indexOf("curl \"$API_URL\"'/x'") >= 0, r);
  assert.ok(r.indexOf("-H 'X-Key: '\"$KEY\"") >= 0, r);
  assert.ok(r.indexOf("--data-raw '{\n  \"id\": \"${user.id}\"\n}'") >= 0, r);
  assert.ok(/# fill in by hand: \$\{user\.id\}/.test(r), r);
  assert.ok(/text\/plain/.test(r) && /# no Content-Type was set/.test(r), r);
});

test('fetch → cURL: selection with two calls, self-referencing variable, no call found', async function () {
  var r = await out('fetch → cURL', "«fetch('https://a.io');\nfetch('https://b.io', { method: 'PUT', body: 'x' });»\nend");
  assert.ok(/curl 'https:\/\/a\.io'\n\ncurl 'https:\/\/b\.io' \\\n  -X PUT/.test(r), r);
  r = await out('fetch → cURL', "let url = 'https://a.io';\nurl = url + '/x';\nlet u2 = u2 + 1;\nfetch(u2)¦");
  assert.ok(/curl/.test(r), r);
  var rr = await run('fetch → cURL', 'nothing here¦');
  assert.ok(/No fetch/.test(errors(rr)[0]));
});

test('fetch → cURL: parser reads nested JS', function () {
  var H = helpers('fetch → cURL');
  var calls = H.fcFind("x.fetch('no'); window.fetch('https://y', { body: `a${1 + 2}b`, mode: cond ? 'a' : 'b', f: () => { return 1 }, g(x) { } })");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].args[0].v, 'https://y');
  var o = calls[0].args[1];
  assert.deepStrictEqual(o.props.map(function (p) { return p.key; }), ['body', 'mode', 'f', 'g']);
  assert.strictEqual(o.props[1].value.t, 'raw');
  assert.strictEqual(H.fcShell("a'b"), "'a'\\''b'");
  assert.strictEqual(H.fcShell(''), "''");
  assert.strictEqual(H.fcShell('TOKEN'), '"$TOKEN"');
  assert.strictEqual(H.fcShell('a\x00b'), "$'a\\x00b'");
});

// ================================================================== Colours
test('colour parsing: every format, alpha, units, invalid', function () {
  var H = helpers('Colour Convert'), N = H.colNames();
  var p = function (s) { var c = H.colParse(s, N); return c && [Math.round(c.r), Math.round(c.g), Math.round(c.b), Math.round(c.a * 1000) / 1000, c.fmt]; };
  assert.strictEqual(Object.keys(N.byName).length, 148);
  assert.deepStrictEqual(p('#0f9598'), [15, 149, 152, 1, 'hex']);
  assert.deepStrictEqual(p('#F00'), [255, 0, 0, 1, 'hex']);
  assert.deepStrictEqual(p('#f008'), [255, 0, 0, 0.533, 'hex']);
  assert.deepStrictEqual(p('#ff000080'), [255, 0, 0, 0.502, 'hex']);
  assert.deepStrictEqual(p('rgb(15, 149, 152)'), [15, 149, 152, 1, 'rgb']);
  assert.deepStrictEqual(p('rgba(15,149,152,.5)'), [15, 149, 152, 0.5, 'rgb']);
  assert.deepStrictEqual(p('rgb(15 149 152 / 50%)'), [15, 149, 152, 0.5, 'rgb']);
  assert.deepStrictEqual(p('rgb(100% 0% 50%)'), [255, 0, 128, 1, 'rgb']);
  assert.deepStrictEqual(p('hsl(0 100% 50%)'), [255, 0, 0, 1, 'hsl']);
  assert.deepStrictEqual(p('hsla(120, 100%, 25%, 0.3)'), [0, 128, 0, 0.3, 'hsl']);
  assert.deepStrictEqual(p('hsl(0.5turn 100% 50%)'), [0, 255, 255, 1, 'hsl']);
  assert.deepStrictEqual(p('hsl(240deg 100 50)'), [0, 0, 255, 1, 'hsl']);
  assert.deepStrictEqual(p('oklch(62.8% 0.2577 29.23)'), [255, 0, 0, 1, 'oklch']);
  assert.deepStrictEqual(p('oklch(0.628 0.2577 29.23 / 0.4)'), [255, 0, 0, 0.4, 'oklch']);
  assert.deepStrictEqual(p('oklch(100% 0 none)'), [255, 255, 255, 1, 'oklch']);
  assert.deepStrictEqual(p('RebeccaPurple'), [102, 51, 153, 1, 'name']);
  ['#12345', 'rgb(1 2)', 'rgb(1, 2 3)', 'hsl(10% 5% 5%)', 'oklch(1 2)', 'notacolour', 'rgb(a b c)'].forEach(function (s) { assert.strictEqual(H.colParse(s, N), null, s); });
  var o = H.colParse('oklch(70% 0.4 150)', N);                      // way outside sRGB
  assert.ok(o.mapped && [o.r, o.g, o.b].every(function (v) { return v >= 0 && v <= 255; }));
});

test('Colour Convert: annotates each format, skips prose and already-annotated colours', async function () {
  assert.strictEqual(await out('Colour Convert', '#0f9598¦'), '#0f9598 → rgb(15 149 152) · hsl(181 82% 33%) · oklch(60.9% 0.101 197.4)');
  assert.strictEqual(await out('Colour Convert', 'rgb(255 0 0)¦'), 'rgb(255 0 0) → #ff0000 · hsl(0 100% 50%) · oklch(62.8% 0.258 29.2) · red');
  assert.strictEqual(await out('Colour Convert', 'color: hsla(0, 0%, 100%, .5);¦'), 'color: hsla(0, 0%, 100%, .5) → #ffffff80 · rgb(255 255 255 / 0.5) · oklch(100% 0 0 / 0.5);');
  assert.strictEqual(await out('Colour Convert', 'c: navy;¦'), 'c: navy → #000080 · rgb(0 0 128) · hsl(240 100% 25%) · oklch(27.1% 0.188 264.1);');
  assert.strictEqual(await out('Colour Convert', 'x = oklch(70% 0.4 150)¦'), 'x = oklch(70% 0.4 150) → ≈ #00be58 · rgb(0 190 88) · hsl(148 100% 37%) (mapped into sRGB)');
  // prose: "red car" is not a colour; "issue #123" is not a colour
  assert.strictEqual(await out('Colour Convert', 'the red car, issue #123, #abc¦'), 'the red car, issue #123, #abc → rgb(170 187 204) · hsl(210 25% 73%) · oklch(78.4% 0.031 248.2)');
  var once = await out('Colour Convert', 'a: #fff; b: rgb(0 0 0);¦');
  assert.strictEqual((await out('Colour Convert', once + '¦')), once);
  var r = await run('Colour Convert', once + '¦');
  assert.ok(/Already annotated/.test(r.toasts[0].msg));
  r = await run('Colour Convert', 'no colours here¦');
  assert.ok(/No colours found/.test(errors(r)[0]));
});

test('colour round trips: hex -> oklch -> hex for many colours', function () {
  var H = helpers('Colour Convert');
  for (var i = 0; i < 4096; i += 7) {
    var c = { r: (i * 37) % 256, g: (i * 91) % 256, b: (i * 13) % 256 }, ok = H.colToOklch(c), back = H.colFromOklch(ok.l, ok.c, ok.h);
    ['r', 'g', 'b'].forEach(function (k) { assert.ok(Math.abs(back[k] - c[k]) < 0.01, JSON.stringify(c)); });
    var hsl = H.colHsl(c), b2 = H.colFromHsl(hsl.h, hsl.s, hsl.l);
    ['r', 'g', 'b'].forEach(function (k) { assert.ok(Math.abs(b2[k] - c[k]) < 0.01, 'hsl ' + JSON.stringify(c)); });
  }
});

test('Colour Shades: 11 steps 50…950, base kept, lightness monotonic, CSS var names', async function () {
  var r = await out('Colour Shades', '--brand: #0f9598;¦\nnext');
  var lines = r.split('\n');
  assert.strictEqual(lines[0], '--brand: #0f9598;');
  assert.strictEqual(lines.length, 13);
  assert.strictEqual(lines[12], 'next');
  var steps = lines.slice(1, 12);
  assert.deepStrictEqual(steps.map(function (l) { return /^--brand-(\d+):/.exec(l)[1]; }), ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']);
  assert.ok(steps.some(function (l) { return /#0f9598; \/\* base \*\/$/.test(l); }), r);
  var H = helpers('Colour Shades'), N = H.colNames(), Ls = steps.map(function (l) { return H.colToOklch(H.colParse(/#[0-9a-f]{6}/.exec(l)[0], N)).l; });
  for (var i = 1; i < Ls.length; i++) assert.ok(Ls[i] < Ls[i - 1], 'lightness falls: ' + r);
  var plain = await out('Colour Shades', 'blue¦');
  assert.ok(/^blue\n50 {3}#[0-9a-f]{6}\n100 {2}#/.test(plain), plain);
  assert.ok(/  \(base\)/.test(plain), plain);
  var white = await out('Colour Shades', '#ffffff¦');
  assert.ok(/50 {3}#ffffff {2}\(base\)/.test(white), white);
  var again = await run('Colour Shades', r.replace(';\n', ';¦\n'));
  assert.strictEqual(again.doc, r);
  var none = await run('Colour Shades', 'nope¦');
  assert.ok(/No colour found/.test(errors(none)[0]));
});

// ================================================================== px / rem
test('px → rem and rem → px', async function () {
  assert.strictEqual(await out('px → rem', 'margin: 0 16px -8px 1px; border: 0px; width: calc(100% - 24px)¦'),
    'margin: 0 1rem -0.5rem 0.0625rem; border: 0px; width: calc(100% - 1.5rem)');
  assert.strictEqual(await out('px → rem', '«font-size: 13px; line-height: 10.5px; x: .5px\nicon-16px.svg 2PX»'),
    'font-size: 0.8125rem; line-height: 0.6563rem; x: 0.0313rem\nicon-16px.svg 0.125rem');
  assert.strictEqual(await out('rem → px', 'a: 1.5rem; b: -.25rem; c: 0rem; d: 2em; e: 0.0625rem¦'), 'a: 24px; b: -4px; c: 0rem; d: 2em; e: 1px');
  var r = await run('px → rem', 'nothing¦');
  assert.ok(/No non-zero px/.test(r.toasts[0].msg));
});

// ================================================================== Base32 / Base58
test('Base32: RFC 4648 vectors, unicode + empty round trips, errors', async function () {
  var H = helpers('Base32 Encode');
  var V = [['', ''], ['f', 'MY======'], ['fo', 'MZXQ===='], ['foo', 'MZXW6==='], ['foob', 'MZXW6YQ='], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI======']];
  V.forEach(function (v) { assert.strictEqual(H.bxB32Enc(v[0]), v[1]); assert.strictEqual(H.bxB32Dec(v[1]).text, v[0]); });
  ['héllo wörld', '日本語 😀', '\u0000\u0001', 'a'.repeat(1000)].forEach(function (s) { assert.strictEqual(H.bxB32Dec(H.bxB32Enc(s)).text, s); });
  assert.strictEqual(H.bxB32Dec('mzxw6ytboi').text, 'foobar');
  assert.strictEqual(H.bxB32Enc('héllo 😀'), 'NDB2S3DMN4QPBH4YQA======');          // python3 base64.b32encode
  assert.strictEqual(H.bxB32Dec('MZXW 6YTB\nOI======').text, 'foobar');
  assert.ok(/unexpected "1" at position 3/.test(H.bxB32Dec('MZ1W').error));
  assert.ok(/not a possible length/.test(H.bxB32Dec('MZXW6YTBO').error));
  assert.ok(/padding/.test(H.bxB32Dec('MZXW6YQ==').error));
  assert.ok(/not UTF-8/.test(H.bxB32Dec('74======').error));       // 0xFF
  assert.strictEqual(await out('Base32 Encode', 'foo¦'), 'MZXW6===');
  assert.strictEqual(await out('Base32 Decode', 'say «MZXW6===» ok'), 'say foo ok');
  var r = await run('Base32 Decode', '  M0XW6===¦');
  assert.strictEqual(r.doc, '  M0XW6===');
  assert.ok(/^Not valid Base32: unexpected "0"/.test(errors(r)[0]), errors(r)[0]);
  r = await run('Base32 Encode', '¦');
  assert.ok(/Nothing to encode/.test(errors(r)[0]));
});

test('Base58: Bitcoin vectors, leading zeros, unicode + empty round trips, errors', async function () {
  var H = helpers('Base58 Encode');
  assert.strictEqual(H.bxB58Enc('Hello World!'), '2NEpo7TZRRrLZSi2U');
  assert.strictEqual(H.bxB58Enc('The quick brown fox jumps over the lazy dog.'), 'USm3fpXnKG5EUBx2ndxBDMPVciP5hGey2Jh4NDv6gmeo1LkMeiKrLJUUBk6Z');
  assert.strictEqual(H.bxB58Enc('\u0000\u0000a'), '112g');
  assert.strictEqual(H.bxB58Enc(''), '');
  assert.strictEqual(H.bxB58Dec('').text, '');
  assert.strictEqual(H.bxB58Dec('112g').text, '\u0000\u0000a');
  ['héllo wörld', '日本語 😀', '\u0000', 'z'.repeat(300)].forEach(function (s) { assert.strictEqual(H.bxB58Dec(H.bxB58Enc(s)).text, s); });
  assert.ok(/unexpected "0" at position 2 \(0, O, I and l/.test(H.bxB58Dec('20').error));
  assert.ok(/unexpected "\+"/.test(H.bxB58Dec('ab+c').error));
  assert.ok(/not UTF-8/.test(H.bxB58Dec('5Q').error));              // 0xFF…
  assert.strictEqual(await out('Base58 Encode', 'Hello World!¦'), '2NEpo7TZRRrLZSi2U');
  assert.strictEqual(await out('Base58 Decode', '2NEpo7TZRRrLZSi2U¦'), 'Hello World!');
  var r = await run('Base58 Decode', 'I0O¦');
  assert.ok(/^Not valid Base58/.test(errors(r)[0]));
});

// ================================================================== Line endings
test('line endings: CRLF cannot reach the doc; LF cleans U+2028/2029/NEL; CRLF copy; Show', async function () {
  var r = await run('Line Endings → LF', 'a\r\nb\rc¦');
  assert.strictEqual(r.doc, 'a\nb\nc');                               // normalised on the way in
  assert.ok(/Already LF — 3 lines/.test(r.toasts[0].msg), r.toasts[0].msg);
  r = await run('Line Endings → LF', 'a\u2028b\u2029c\u0085d\ne¦');
  assert.strictEqual(r.doc, 'a\nb\nc\nd\ne');
  assert.ok(/1 U\+2028 · 1 U\+2029 · 1 NEL/.test(r.toasts[0].msg), r.toasts[0].msg);
  r = await run('Line Endings → LF', 'x\u2028«y\u2028z»');
  assert.strictEqual(r.doc, 'x\u2028y\nz');
  r = await run('Line Endings → CRLF (Copy)', 'a\nb\n¦');
  assert.strictEqual(r.copied[0], 'a\r\nb\r\n');
  assert.strictEqual(r.doc, 'a\nb\n');
  assert.ok(/2 line breaks/.test(r.toasts[0].msg));
  r = await run('Show Line Endings', 'a\nb¦', { clipboard: 'x\r\ny\r\nz\n' });
  assert.ok(/Note: LF \(Unix \/ macOS\) — 1 LF/.test(r.toasts[0].msg) && /Clipboard: mixed — 2 CRLF · 1 LF/.test(r.toasts[0].msg), r.toasts[0].msg);
  r = await run('Show Line Endings', 'a¦', {});
  assert.ok(/Note: no line breaks/.test(r.toasts[0].msg) && /Clipboard: clipboard access was blocked/.test(r.toasts[0].msg), r.toasts[0].msg);
  var H = helpers('Show Line Endings');
  assert.deepStrictEqual(H.leCount('a\r\nb\nc\rd'), { crlf: 1, lf: 1, cr: 1, ls: 0, ps: 0, nel: 0 });
  assert.strictEqual(H.leDescribe(H.leCount('a\r\nb\r\n')), 'CRLF (Windows) — 2 CRLF');
});

// ================================================================== Humanize
test('Humanize Bytes', async function () {
  assert.strictEqual(await out('Humanize Bytes', '1048576¦'), '1048576 → 1 MiB (1.05 MB)');
  assert.strictEqual(await out('Humanize Bytes', 'heap 1000000 of 1_073_741_824 bytes, port 8080, v1.2.3, 512 B¦'),
    'heap 1000000 → 976.56 KiB (1 MB) of 1_073_741_824 bytes → 1 GiB (1.07 GB), port 8080 → 7.89 KiB (8.08 kB), v1.2.3, 512 B');
  assert.strictEqual(await out('Humanize Bytes', '512¦'), '512 → 512 B (512 B)');
  var once = await out('Humanize Bytes', 'size 5000000¦');
  assert.strictEqual(await out('Humanize Bytes', once + '¦'), once);
  var r = await run('Humanize Bytes', 'none here¦');
  assert.ok(/No byte counts/.test(errors(r)[0]));
});

test('Humanize Durations', async function () {
  assert.strictEqual(await out('Humanize Durations', '3600¦'), '3600 → 1h');
  assert.strictEqual(await out('Humanize Durations', '90061¦'), '90061 → 1d 1h 1m 1s');
  assert.strictEqual(await out('Humanize Durations', 'took 1500ms, ttl 86400s, 90.5 sec, 45s, in 2024, 250ms¦'),
    'took 1500ms → 1.5s, ttl 86400s → 1d, 90.5 sec → 1m 30.5s, 45s, in 2024, 250ms');
  assert.strictEqual(await out('Humanize Durations', '250ms¦'), '250ms → 250ms');
  assert.strictEqual(await out('Humanize Durations', '45¦'), '45 → 45s');
  var once = await out('Humanize Durations', 'a 7200 b¦');
  assert.strictEqual(once, 'a 7200 → 2h b');
  assert.strictEqual(await out('Humanize Durations', once + '¦'), once);
});

// ================================================================== Sum Durations
test('Sum Durations: every format, skipped lines, earlier totals ignored', async function () {
  var H = helpers('Sum Durations');
  var s = function (l) { return H.sdLine(l); };
  assert.strictEqual(s('1h20m'), 4800);
  assert.strictEqual(s('45m'), 2700);
  assert.strictEqual(s('1:30:00'), 5400);
  assert.strictEqual(s('1:30'), 5400);
  assert.strictEqual(s('90s'), 90);
  assert.strictEqual(s('2.5h'), 9000);
  assert.strictEqual(s('1 hr 5 min'), 3900);
  assert.strictEqual(s('Fix bug — 2 hours and 15 minutes'), 8100);
  assert.strictEqual(s('PT1H30M'), 5400);
  assert.strictEqual(s('P1DT2H'), 93600);
  assert.strictEqual(s('500ms'), 0.5);
  assert.strictEqual(s('1d 2h'), 93600);
  assert.strictEqual(s('3 months'), null);
  assert.strictEqual(s('played mp3s'), null);
  assert.strictEqual(s('nothing'), null);
  var doc = '«design 1h20m\nreview 45m\ncall 1:30:00\nbreak 90s\nlunch\n»';
  var r = await run('Sum Durations', doc);
  assert.strictEqual(r.doc, 'design 1h20m\nreview 45m\ncall 1:30:00\nbreak 90s\nlunch\n\n= 3h 36m 30s (3.61 h)');
  assert.ok(/4 lines · 1 without a duration skipped/.test(r.toasts[0].msg));
  // cursor in the paragraph; a previous total line is not counted again
  assert.strictEqual(await out('Sum Durations', 'a 30m\nb 45m¦\n\n= 1h 15m (1.25 h)'), 'a 30m\nb 45m\n\n= 1h 15m (1.25 h)\n\n= 1h 15m (1.25 h)');
  assert.strictEqual(await out('Sum Durations', '«26h\n5m»'), '26h\n5m\n\n= 26h 5m (26.08 h)');
  assert.strictEqual(await out('Sum Durations', '«10m\n20m»'), '10m\n20m\n\n= 30m');
  r = await run('Sum Durations', '«abc\ndef»');
  assert.ok(/No durations found/.test(errors(r)[0]));
});

// ================================================================== read-only mode
test('read-only: results are copied, the note is untouched', async function () {
  var r = await run('Base32 Encode', 'foo¦', { readOnly: true });
  assert.strictEqual(r.doc, 'foo');
  assert.strictEqual(r.copied[0], 'MZXW6===');
  r = await run('Lines → SQL IN List', '«a\nb»', { readOnly: true });
  assert.strictEqual(r.copied[0], "IN ('a', 'b')");
});

// ------------------------------------------------------------------ run
(async function () {
  for (var i = 0; i < pending.length; i++) {
    try { await pending[i][1](); passed++; }
    catch (e) { console.error('FAIL ' + pending[i][0] + '\n' + (e.stack || e)); process.exitCode = 1; }
  }
  console.log(passed + ' passed' + (process.exitCode ? ', ' + (pending.length - passed) + ' failed' : ''));
})();
