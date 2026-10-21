/* Beautify / Format Code Blocks checks: node txt/scripts/pack-code/pack-code-format.test.js
 *
 * Part 1 (always, offline): the lossless JSON printer, language detection,
 * fence scanning, options parsing, the js-beautify fallback when Prettier
 * can't load, and the palette metadata.
 * Part 2 (Prettier): needs prettier@3.9.9 standalone + plugins and
 * js-beautify 1.15.4, fetched once with curl into $PRETTIER_LIBS (default:
 * <tmpdir>/cade-prettier-3.9.9). Skipped with a note when they can't be
 * fetched (offline) or CADE_OFFLINE=1. Never vendored into the repo.
 * JS / TS / GraphQL output must parse to the same AST as the input, and every
 * language must be idempotent (formatting the output changes nothing). */
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const assert = require('assert');
const plain = x => JSON.parse(JSON.stringify(x));   // vm-realm arrays/objects -> this realm
const here = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
async function runQueue() {
  while (queue.length) {
    const [name, fn] = queue.shift();
    try { await fn(); passed++; }
    catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
  }
}

// --- page stand-in ---
const mem = {};
const toasts = [];
const ctx = { console, TextEncoder, TextDecoder, atob, btoa, Response, CompressionStream, DecompressionStream, escape, unescape, setTimeout, clearTimeout, performance };
ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
ctx.document = { currentScript: null, createElement() { return {}; }, head: { appendChild() {} } };
ctx.Cade = {
  store: { get: k => (k in mem ? mem[k] : null), set: (k, v) => { mem[k] = String(v); }, remove: k => { delete mem[k]; } },
  showToast: (m, t) => toasts.push([t, m])
};
vm.createContext(ctx);
vm.runInContext(here('pack-code-lib.js'), ctx);
vm.runInContext(here('pack-code-format.js'), ctx);
const L = ctx.__CADE_CODEPACK__, F = ctx.__CADE_CODEFMT__;
const J = L._formatJSON;
const noLoad = () => Promise.reject(new Error('offline'));
const envBase = { formatJSON: J, beautifyXML: L._beautifyXML, detectLang: L._detectLang };

// =====================================================================
// Part 1: offline
// =====================================================================
test('JSON pretty == JSON.stringify layout for canonical input', () => {
  const samples = [
    { a: 1, b: [1, 2, { c: null, d: [] }], e: {}, f: 'x"y\\z\n', g: true, h: -0.5, i: 1e21 },
    [], {}, [[[]]], 'str', 42, null, [{ a: [{}] }]
  ];
  for (const v of samples) {
    const min = JSON.stringify(v);
    assert.strictEqual(J(min, '  '), JSON.stringify(v, null, 2));
    assert.strictEqual(J(JSON.stringify(v, null, 4), ''), min);
    assert.strictEqual(J(min, '\t'), JSON.stringify(v, null, '\t'));
  }
});
test('JSON keeps numbers, escapes and duplicate keys verbatim', () => {
  const src = '{"id":12345678901234567890,"exp":1e400,"p":1.10,"s":"Caf\\u00e9 \\/","dup":1,"dup":2}';
  const out = J(src, '  ');
  for (const bit of ['12345678901234567890', '1e400', '1.10', '"Caf\\u00e9 \\/"', '"dup": 1', '"dup": 2']) assert.ok(out.includes(bit), bit + ' in ' + out);
  assert.strictEqual(J(out, ''), src);
  assert.strictEqual(L._minifyJSON(out), src);
});
test('JSON comments kept (pretty), dropped (minify); trailing commas dropped', () => {
  const src = '// settings\n{"a":1, // one\n /* lead */ "b":[1,2,],\n "c":{},\n // tail\n}';
  assert.strictEqual(J(src, '  '), '// settings\n{\n  "a": 1, // one\n  /* lead */\n  "b": [\n    1,\n    2\n  ],\n  "c": {}\n  // tail\n}');
  assert.strictEqual(J(src, ''), '{"a":1,"b":[1,2],"c":{}}');
  assert.strictEqual(L._detectLang(src).lang, 'json');
});
test('JSON errors carry line / col', () => {
  const cases = [['{"a":1,\n "b":[1,2,}', /line 2, col 11/], ['{"a" 1}', /expected :/], ['[1 2]', /expected , or \]/],
    ['{"a":01}', /expected , or \}/], ['"\u0001"', /control character/], ['', /empty input/], ['{"a":1}x', /unexpected "x"/],
    ['{"a":"x', /unterminated string/], ['[NaN]', /unexpected "N"/], ['{a:1}', /expected a "key"/]];
  for (const [src, re] of cases) assert.throws(() => J(src, '  '), re, src);
});
test('detect: language per snippet', () => {
  const D = s => F.detect(s, envBase);
  const cases = [
    ['const a = 1;\nfunction f(x) { return x * 2; }', 'js', true],
    ['interface User { id: number; name: string }\nconst u: User = { id: 1, name: "a" };', 'ts', true],
    ['.a { color: red; }\n.b { margin: 0 }', 'css', true],
    ['$primary: #333;\n.nav { &__item { color: $primary; } @include m; }', 'scss'],
    ['@primary: #428bca;\n.box { .bordered(4px); color: @primary; }', 'less'],
    ['<!doctype html><html><body><p>x</p></body></html>', 'html', true],
    ['<template>\n  <div>{{ msg }}</div>\n</template>\n<script>\nexport default {}\n</script>', 'vue', true],
    ['const App = () => <div className="a">{x}</div>', 'js', true],
    ['<ul>{items.map(i => <li key={i}>{i}</li>)}</ul>', 'js', true],
    ['<ul class="a"><li>x</li></ul>', 'html', true],
    ['const a = {b: "c"};\nfoo();', 'js', true],
    ['{"a": [1, 2]}', 'json', true],
    ['// c\n{"a": 1,}', 'json', true],
    ['# Title\n\nSome **bold** text.\n\n- one\n- two', 'markdown', false],
    ['version: 2.1\njobs:\n  build:\n    steps:\n      - checkout', 'yaml', true],
    ['query Q($id: ID!) { user(id: $id) { name } }', 'graphql', true],
    ['type User {\n  id: ID!\n  posts: [Post!]!\n}', 'graphql', true],
    ['<?xml version="1.0"?><a><b>x</b></a>', 'xml', true],
    ['def f(x):\n    return x\n', 'python', true]
  ];
  for (const [src, lang, sure] of cases) {
    const d = D(src);
    assert.strictEqual(d.lang, lang, src.slice(0, 40) + ' -> ' + d.lang);
    if (sure !== undefined) assert.strictEqual(d.sure, sure, src.slice(0, 40) + ' sure');
  }
});
test('fence info -> language; unsupported fences are named', () => {
  const m = { js: 'js', JSX: 'js', 'ts title="x"': 'ts', tsx: 'ts', '{.scss}': 'scss', yml: 'yaml', gql: 'graphql', md: 'markdown', jsonc: 'json', json5: 'json5', vue: 'vue', svg: 'xml', 'html,demo': 'html' };
  for (const k in m) assert.strictEqual(F.fromInfo(k), m[k], k);
  for (const k of ['python', 'sql', 'rust', 'text', '', 'sass']) assert.strictEqual(F.fromInfo(k), null, k);
  assert.strictEqual(F.unsupported('sql'), 'sql');
  assert.strictEqual(F.unsupported('py {linenos}'), 'py');
  assert.strictEqual(F.unsupported('js'), null);
});
test('options: parse, clamp, round trip, store', () => {
  const P = s => F.parseOptions(s, F.getOptions());
  assert.strictEqual(F.optionsString(F.getOptions()), 'width=80 indent=2 semi=yes quotes=double trailing=all');
  let r = P('width=100 indent=tab semi=no quotes=single trailing=es5');
  assert.deepStrictEqual(plain(r.errors), []);
  assert.strictEqual(F.optionsString(r.opts), 'width=100 indent=tab semi=no quotes=single trailing=es5');
  assert.strictEqual(F.optionsString(P(F.optionsString(r.opts)).opts), F.optionsString(r.opts));
  r = P('4 120 nosemi single');
  assert.deepStrictEqual([r.opts.indent, r.opts.width, r.opts.semi, r.opts.quotes], [4, 120, false, 'single']);
  r = P('w:60, tabs');
  assert.deepStrictEqual([r.opts.width, r.opts.tabs], [60, true]);
  assert.strictEqual(P('width=5 bogus quotes=fancy').errors.length, 3);
  assert.strictEqual(F.optionsString(P('').opts), 'width=80 indent=2 semi=yes quotes=double trailing=all');
  F.setOptions(P('indent=4 semi=no').opts);
  assert.ok(/"indent":4/.test(mem['codepack.format']));
  assert.strictEqual(F.getOptions().semi, false);
  mem['codepack.format'] = '{"width":9999,"indent":"x","quotes":"weird"}';   // junk in storage -> defaults
  assert.strictEqual(F.optionsString(F.getOptions()), 'width=80 indent=2 semi=yes quotes=double trailing=all');
  delete mem['codepack.format'];
});
test('findFences: positions, ~~~, longer closers, unclosed ignored', () => {
  const doc = 'intro\n```js\na=1\n```\n~~~~css\n.a{}\n```\nb{}\n~~~~\n```\n\n```\n```py\nopen to eof';
  const f = F._findFences(doc);
  assert.strictEqual(f.length, 3);
  assert.strictEqual(doc.slice(f[0].contentFrom, f[0].contentTo), 'a=1');
  assert.strictEqual(f[0].info, 'js');
  assert.strictEqual(doc.slice(f[1].contentFrom, f[1].contentTo), '.a{}\n```\nb{}');
  assert.strictEqual(f[2].info, '');
  assert.strictEqual(f[0].line, 2);
  assert.strictEqual(F._findFences('``` not `a fence` ```\nx').length, 0);
});
test('indented block is formatted flush-left and re-indented; trailing newline kept', async () => {
  const r = await F.format('json', '   {"a":1,"b":[2]}\n', null, envBase);
  assert.strictEqual(r.code, '   {\n     "a": 1,\n     "b": [\n       2\n     ]\n   }\n');
  assert.strictEqual(r.engine, 'built-in');
  F.setOptions({ indent: 4 });
  assert.strictEqual((await F.format('json', '{"a":1}', null, envBase)).code, '{\n    "a": 1\n}');
  F.setOptions({ tabs: true });
  assert.strictEqual((await F.format('xml', '<a><b>x</b></a>', null, envBase)).code, '<a>\n\t<b>\n\t\tx\n\t</b>\n</a>');
  delete mem['codepack.format'];
});
test('CSS URL( lower-cased outside strings', () => {
  assert.strictEqual(F._lowerUrlCalls('a{b:URL(data:image/svg+xml;x);content:"URL(";c:url(x)}'), 'a{b:url(data:image/svg+xml;x);content:"URL(";c:url(x)}');
  const s = 'a{b:url(x)}';
  assert.strictEqual(F._lowerUrlCalls(s), s);
});
test('Prettier error text -> "line L, col C: message"', () => {
  assert.strictEqual(F._errText(new Error('Unexpected token, expected "," (2:10)\n  1 | x\n> 2 | y')), 'line 2, col 10: Unexpected token, expected ","');
  assert.strictEqual(F._errText(new Error('CssSyntaxError: Unexpected } (2:16)')), 'line 2, col 16: Unexpected }');
});
test('HTML loads embedded-code plugins only when needed', () => {
  assert.deepStrictEqual(plain(F._pluginsFor('html', '<p>x</p>')), ['html']);
  assert.deepStrictEqual(plain(F._pluginsFor('html', '<p onclick="x()">x</p><style>a{}</style>')), ['html', 'babel', 'estree', 'postcss']);
  assert.deepStrictEqual(plain(F._pluginsFor('ts', '')), ['babel', 'estree']);
});
test('Prettier unreachable: JS / CSS / HTML fall back to js-beautify, others report', async () => {
  const calls = [];
  const stubB = { js: (s, o) => { calls.push(['js', o.e4x]); return 'JS<' + s + '>'; }, css: s => 'CSS<' + s + '>', html: s => 'HTML<' + s + '>' };
  const env = Object.assign({}, envBase, { loadScript: noLoad, ensureBeautify: () => Promise.resolve(stubB) });
  let r = await F.format('js', 'a=1', null, env);
  assert.strictEqual(r.code, 'JS<a=1>'); assert.strictEqual(r.engine, 'js-beautify'); assert.ok(/offline/.test(r.note));
  assert.strictEqual((await F.format('scss', '.a{}', null, env)).code, 'CSS<.a{}>');
  assert.strictEqual((await F.format('vue', '<template></template>', null, env)).code, 'HTML<<template></template>>');
  assert.strictEqual((await F.format('svelte', '<p>x</p>', null, env)).engine, 'js-beautify');
  await F.format('js', 'return <div>x</div>', null, env);
  assert.strictEqual(calls[calls.length - 1][1], true, 'JSX gets e4x');
  for (const lang of ['ts', 'markdown', 'yaml', 'graphql', 'json5']) {
    await assert.rejects(F.format(lang, 'x', null, env), /needs Prettier/, lang);
  }
  await assert.rejects(F.format('python', 'x=1', null, env), /No Python formatter/);
  // a failed load is retried, not cached
  let n = 0;
  const env2 = Object.assign({}, env, { loadScript: () => { n++; return Promise.reject(new Error('net')); } });
  await F.format('yaml', 'a: 1', null, env2).catch(() => {});
  await F.format('yaml', 'a: 1', null, env2).catch(() => {});
  assert.strictEqual(n, 4);   // standalone + yaml plugin, twice
});
test('formatBlocks without Prettier: JSON block formatted, others skipped / failed', async () => {
  const env = Object.assign({}, envBase, { loadScript: noLoad });
  const doc = '# Note\n```json\n{"a":1}\n```\n```\nplain\n```\n```python\nx=1\n```\n```yaml\na: 1\n```\n';
  const r = await F.formatBlocks(doc, 0, 0, null, env);
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.formatted, 1);
  assert.deepStrictEqual(plain(r.skipped), ['no language', 'python']);
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.failed[0].line, 11);
  assert.deepStrictEqual(plain(r.changes), [{ from: 15, to: 22, insert: '{\n  "a": 1\n}' }]);
  const sel = await F.formatBlocks(doc, 25, 26, null, env);   // selection touching only the plain block
  assert.strictEqual(sel.total, 1);
});

// palette metadata: new / changed scripts vs this constant, the rest vs the manifest
const EXPECTED = {
  'Beautify Code': { description: 'Pretty-print the selection, the ``` block at the cursor or the note with Prettier: JS, TS, JSX, CSS, SCSS, Less, HTML, Vue, Markdown, YAML, GraphQL; plus JSON and XML', tags: 'beautify,prettify,prettier,format,pretty,indent,code,js,javascript,ts,typescript,jsx,tsx,css,scss,less,html,vue,markdown,md,yaml,yml,graphql,json,xml,auto' },
  'Format Code Blocks': { description: 'Prettier-format every ``` code block in the note (or the selection) by its fence language; unlabelled and unsupported blocks are left alone', tags: 'format,beautify,prettier,prettify,code,blocks,fences,fenced,markdown,all,js,ts,css,html,json,yaml,graphql' },
  'Beautify Options…': { description: 'Set print width, indent (spaces or tabs), semicolons, quotes and trailing commas for Beautify Code and Format Code Blocks', tags: 'beautify,prettier,format,options,settings,width,indent,tabs,spaces,semicolons,quotes,trailing,commas' }
};
test('palette metadata matches (manifest for unchanged scripts, EXPECTED for new ones)', () => {
  const metas = [];
  const c2 = { console };
  c2.window = c2;
  c2.Cade = { asset: f => './' + f, registerScript: src => metas.push(JSON.parse(src.match(/\/\*\*\s*([\s\S]*?)\s*\*\*\//)[1])) };
  vm.createContext(c2);
  vm.runInContext(here('pack-code.js'), c2);
  assert.strictEqual(metas.length, 14);
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  const pack = (man.modules || man.widgets || man).find ? (man.modules || man.widgets || man).find(m => m.id === 'pack-code') : null;
  const manScripts = {};
  ((pack && pack.scripts) || []).forEach(s => { manScripts[s.name] = s; });
  const beauty = metas.find(m => m.name === 'Beautify Code').icon;
  for (const m of metas) {
    if (EXPECTED[m.name]) {
      assert.strictEqual(m.description, EXPECTED[m.name].description, m.name);
      assert.strictEqual(m.tags, EXPECTED[m.name].tags, m.name);
      assert.strictEqual(m.icon, beauty, m.name + ' icon');
      const ms = manScripts[m.name];
      if (ms && (ms.description !== m.description || ms.tags !== m.tags)) console.log('  note: manifest entry for "' + m.name + '" not updated yet');
    } else if (pack) {
      const ms = manScripts[m.name];
      assert.ok(ms, m.name + ' in manifest');
      assert.deepStrictEqual([ms.description, ms.icon, ms.tags], [m.description, m.icon, m.tags], m.name);
    }
  }
});

// =====================================================================
// Part 2: Prettier (fetched into a temp folder, skipped offline)
// =====================================================================
const LIBS = process.env.PRETTIER_LIBS || path.join(os.tmpdir(), 'cade-prettier-3.9.9');
const FILES = ['standalone', 'plugins/babel', 'plugins/estree', 'plugins/postcss', 'plugins/html', 'plugins/markdown', 'plugins/yaml', 'plugins/graphql'];
function fetchLibs() {
  if (process.env.CADE_OFFLINE === '1') return 'CADE_OFFLINE=1';
  const want = FILES.map(f => [f + '.js', F.PRETTIER + f + '.js']).concat([['js-beautify.js', 'https://cdn.jsdelivr.net/npm/js-beautify@1.15.4/js/lib/beautifier.min.js']]);
  try {
    for (const [f, url] of want) {
      const p = path.join(LIBS, f);
      if (fs.existsSync(p) && fs.statSync(p).size > 1000) continue;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      cp.execFileSync('curl', ['-sSfL', '--max-time', '60', '-o', p + '.part', url], { stdio: 'pipe' });
      fs.renameSync(p + '.part', p);
    }
    return null;
  } catch (e) { return 'fetch failed (' + String(e.message).split('\n')[0] + ')'; }
}

const SAMPLES = {
  js: 'import {a,b as c} from "./x.js"\nexport default class S extends B{#m=new Map();static{S.n++}\nasync *entries(){for await(const [k,v] of this.#m)yield [k,v]}\nadd(k,v){if(!k)throw new TypeError(`bad ${k}`);return this?.x?.[0]??null}}\nconst re=/[/\\]]+/gu,half=x=>x/2/1\nlet t=`a ${`b ${c}`} d`\nlbl:for(let i=0;i<3;i++){if(i)continue lbl}\nconst o={"q-k":1,[c+1]:2,get g(){return 2},...rest}\nx??=5;const big=1_000n\nlet n=1\nn\n++n\n;[1,2].forEach(f)\n',
  jsx: 'export function L({items}){return <ul className="l">{items.map(i=><li key={i.id} onClick={()=>go(i)}>{i.text} {i.done&&<b>✓</b>}</li>)}<></></ul>}',
  ts: 'enum S{A="a",B=2}\ninterface U<T extends object={}>{readonly id:number;meta?:T;[k:string]:unknown}\ntype D<T>={[K in keyof T]?:T[K] extends object?D<T[K]>:T[K]}\nabstract class R<T extends {id:number}>{constructor(private readonly n:string,public l=1){}\nabstract ok(x:T):x is T&{v:true}\nadd(x:T):this;add(x:T[]):this;add(x:T|T[]):this{return this}}\nconst cfg={p:1} as const satisfies Record<string,number>\nlet el=document.getElementById("x")!;const g=<T,>(x:T)=>x\n',
  css: ':root{--brand:#FF6600}\nhtml,body{margin:0;font:16px/1.5 -apple-system,"Segoe UI",sans-serif}\n.b:hover{background:URL(data:image/svg+xml;base64,PHN2Zz4=) no-repeat;transition:all .3s}\n@media (min-width:768px){.g{grid-template-areas:"a b" "c d"}}\n.card{&:hover{color:red}}\n',
  scss: '$bp:(s:576px,m:768px);\n@mixin r($b){@if map-has-key($bp,$b){@media (min-width:map-get($bp,$b)){@content}}@else{@warn "no #{$b}"}}\n.nav{font:{family:$f;size:12px}&__i{@extend %p;&:hover{color:darken($c,10%)}}@each $n,$c in (a:#111,b:#999){.t-#{$n}{color:$c}}}\n// comment\n',
  less: '@p:#428bca;\n.bordered(@w:2px;@s:solid){border:@w @s black}\n.m(@a) when (lightness(@a)>=50%){color:black}\n#h{color:darken(@p,10%);.nav{.bordered(4px;dashed);}&:extend(.b all);width:~"calc(100% - @{g})"}\n',
  html: '<!DOCTYPE html><html><head><title>T</title><style>body{margin:0}</style><script>if(a<b){go("x")}</script></head><body><nav><ul><li><a href="/">Home</a></li></ul></nav><p>Some <b>bold</b> text.<br>Next</p><pre>\n  keep   me\n</pre><textarea>  raw </textarea><img src="a.png" alt="A"></body></html>',
  vue: '<template><div :class="{a:b}" @click="go(1)">{{ msg }}</div></template>\n<script>export default {data(){return {msg:"hi"}}}</script>\n<style scoped>.a{color:red}</style>\n',
  markdown: 'Title\n=====\n* one\n* two\n    * nested\n\n|Name|Value|\n|-|:-:|\n|a|1|\n|longer|22|\n\n```js\nconst x={a:1}\n```\n',
  yaml: 'version:   2.1\ndefaults: &d\n  docker:\n    - image:    node:14\njobs:\n  build:\n    <<: *d\n    steps:\n      - run: {name: I, command: npm ci}\n      - run: |\n          npm test\nlist: [a,   b]\n---\nsecond: doc\n',
  graphql: 'query G($id:ID!,$p:Boolean=false)@cached(ttl:60){user(id:$id){id,...F posts(first:10)@include(if:$p){edges{node{id}}}}}\nfragment F on User{email}\ntype User implements Node&E{id:ID! name:String @deprecated(reason:"x")}\n',
  json5: "{a:1,'b':[0x1F,+2,.5,],// c\n}"
};
const LANG_OF = { jsx: 'js' };

async function prettierPart() {
  const why = fetchLibs();
  if (why) { console.log('pack-code-format: Prettier checks skipped: ' + why); return; }
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(LIBS, f + '.js'), 'utf8'), ctx, { filename: f });
  vm.runInContext(fs.readFileSync(path.join(LIBS, 'js-beautify.js'), 'utf8'), ctx);
  const PP = ctx.prettierPlugins;
  const env = Object.assign({}, envBase, { loadScript: () => Promise.reject(new Error('should not load')), ensureBeautify: () => Promise.resolve(ctx.beautifier) });
  const STRIP = new Set(['start', 'end', 'loc', 'range', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'raw', 'tokens', 'errors', '__contentEnd']);
  function jsxClean(v) {
    const lines = v.split(/\r\n|\n|\r/); let out = '';
    lines.forEach((l, i) => { let t = l.replace(/\t/g, ' '); if (i > 0) t = t.replace(/^ +/, ''); if (i < lines.length - 1) t = t.replace(/ +$/, ''); if (t) { if (out) out += ' '; out += t; } });
    return lines.length === 1 ? v : out;
  }
  function jsxKids(arr) {   // JSX whitespace rules, so re-wrapped text compares equal
    const r = [];
    for (const c of arr) {
      let s = null;
      if (c.type === 'JSXText') s = jsxClean(c.value);
      else if (c.type === 'JSXExpressionContainer' && c.expression && c.expression.type === 'StringLiteral') s = c.expression.value;
      if (s !== null) { if (!s) continue; if (r.length && typeof r[r.length - 1] === 'string') r[r.length - 1] += s; else r.push(s); } else r.push(c);
    }
    return r;
  }
  function norm(n) {
    if (Array.isArray(n)) return n.map(norm);
    if (n && typeof n === 'object') {
      if (Array.isArray(n.children) && /^JSX/.test(n.type || '')) n = Object.assign({}, n, { children: jsxKids(n.children) });
      const o = {};
      for (const k of Object.keys(n).sort()) if (!STRIP.has(k)) o[k] = norm(n[k]);
      return o;
    }
    return typeof n === 'bigint' ? String(n) : n;
  }
  const ast = (plugin, parser, code) => JSON.stringify(norm(PP[plugin].parsers[parser].parse(code, {})));

  test('Prettier: every language formats, is idempotent; JS/TS/GraphQL keep their AST', async () => {
    for (const k in SAMPLES) {
      const lang = LANG_OF[k] || k, src = SAMPLES[k];
      const t0 = performance.now();
      const r = await F.format(lang, src, null, env);
      const ms = performance.now() - t0;
      assert.strictEqual(r.engine, 'Prettier', k + ': ' + r.note);
      assert.notStrictEqual(r.code, src, k + ' changed');
      const again = await F.format(lang, r.code, null, env);
      assert.strictEqual(again.code, r.code, k + ' idempotent');
      if (lang === 'js') assert.strictEqual(ast('babel', 'babel', r.code), ast('babel', 'babel', src), k + ' AST');
      if (lang === 'ts') assert.strictEqual(ast('babel', 'babel-ts', r.code), ast('babel', 'babel-ts', src), k + ' AST');
      if (lang === 'graphql') assert.strictEqual(ast('graphql', 'graphql', r.code), ast('graphql', 'graphql', src), k + ' AST');
      if (process.env.VERBOSE) console.log('  ' + k + ': ' + ms.toFixed(0) + ' ms');
    }
  });
  test('Prettier: output details per language', async () => {
    const fmt = async (lang, s) => (await F.format(lang, s, null, env)).code;
    const css = await fmt('css', SAMPLES.css);
    assert.ok(css.includes('url(data:image/svg+xml;base64,PHN2Zz4=)'), 'data URI intact');
    assert.ok(css.includes('transition: all 0.3s;'));
    assert.ok((await fmt('scss', SAMPLES.scss)).includes('} @else {'));
    const html = await fmt('html', SAMPLES.html);
    assert.ok(html.includes('<pre>\n  keep   me\n</pre>'), 'pre kept');
    assert.ok(/<textarea>\s*raw <\/textarea>|<textarea>  raw <\/textarea>/.test(html), 'textarea kept');
    assert.ok(html.includes('if (a < b) {'), 'inline script formatted');
    const md = await fmt('markdown', SAMPLES.markdown);
    assert.ok(md.includes('| Name   | Value |'), 'table aligned');
    assert.ok(md.includes('const x={a:1}'), 'fenced code left alone');
    assert.ok((await fmt('yaml', SAMPLES.yaml)).includes('<<: *d'));
    const jsx = await fmt('js', SAMPLES.jsx);
    assert.ok(jsx.includes('<li key={i.id} onClick={() => go(i)}>'));
    const t = await F.format('js', 'const c = {a: 1} as const', null, env);
    assert.strictEqual(t.label, 'TS', 'babel-ts used for TS-only syntax');
  });
  test('Prettier: options reach the output', async () => {
    F.setOptions(F.parseOptions('semi=no quotes=single indent=tab width=40 trailing=none').opts);
    const r = await F.format('js', 'const a = {x: "y", list: [111111111, 222222222, 333333333]};\nfoo()', null, env);
    assert.strictEqual(r.code, "const a = {\n\tx: 'y',\n\tlist: [\n\t\t111111111, 222222222, 333333333\n\t]\n}\nfoo()");
    assert.strictEqual((await F.format('json', '{"a":[1]}', null, env)).code, '{\n\t"a": [\n\t\t1\n\t]\n}');
    delete mem['codepack.format'];
  });
  test('Prettier: syntax errors - JS/CSS fall back to js-beautify with a note, TS/YAML/GraphQL report line:col', async () => {
    let r = await F.format('js', '  foo(){ return 1 }', null, env);
    assert.strictEqual(r.engine, 'js-beautify');
    assert.ok(/^Prettier: line 1, col \d+: Missing semicolon, so js-beautify/.test(r.note), r.note);
    r = await F.format('css', '.a{color:red\n.b{color:blue}}}', null, env);
    assert.strictEqual(r.engine, 'js-beautify');
    await assert.rejects(F.format('ts', 'interface X { a: number; b: }', null, env), /^Error: TS syntax error, line 1, col 29: Unexpected token/);
    await assert.rejects(F.format('yaml', 'a: [1, 2\nb: : c', null, env), /YAML syntax error, line 2, col 1/);
    await assert.rejects(F.format('graphql', 'query { user(id: ) { name } ', null, env), /GraphQL syntax error, line 1, col 18/);
    await assert.rejects(F.format('json', '{"a":1,"b":[1,2,}', null, env), /Invalid JSON \(line 1, col 17\)/);
  });
  test('Prettier: formatBlocks formats each fence by language, second run is a no-op', async () => {
    const doc = '# Notes\n\n```js\nconst a={b:1}\n```\n\n- item\n  ```ts\n  let x:number=1\n  ```\n\n```css\n.a{color:red}\n```\n\n```sql\nselect 1\n```\n\n```ts\nlet = ;\n```\n';
    const r = await F.formatBlocks(doc, 0, 0, null, env);
    assert.strictEqual(r.formatted, 3);
    assert.deepStrictEqual(plain(r.skipped), ['sql']);
    assert.strictEqual(r.failed.length, 1);
    assert.strictEqual(r.failed[0].line, 20);
    let out = doc;
    r.changes.slice().reverse().forEach(c => { out = out.slice(0, c.from) + c.insert + out.slice(c.to); });
    assert.ok(out.includes('```js\nconst a = { b: 1 };\n```'));
    assert.ok(out.includes('  ```ts\n  let x: number = 1;\n  ```'), 'indented fence re-indented');
    assert.ok(out.includes('```css\n.a {\n  color: red;\n}\n```'));
    const r2 = await F.formatBlocks(out, 0, 0, null, env);
    assert.strictEqual(r2.changes.length, 0);
  });
}

(async () => {
  await runQueue();
  await prettierPart();
  await runQueue();
  console.log('pack-code-format: ' + passed + ' passed' + (failed ? ', ' + failed + ' FAILED' : ''));
  if (failed) process.exitCode = 1;
})();
