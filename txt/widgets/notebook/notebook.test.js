/* Checks for the Notebook (linked, reactive code blocks): JS / Python name
 * analysis (destructuring, functions, classes, imports, shadowing…), the run
 * transform (a shared scope across re-runs, the last value, imports), the
 * dependency planner (stale propagation, order, cycles), the Code Runner's
 * routing (linked on → notebook, off → isolated run), output helpers and the
 * widget / script / prefs metadata against the proposed manifest entries.
 * Not loaded by the app. Run: node txt/widgets/notebook/notebook.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path'), vm = require('vm');
var NC = require('./notebook-core.js');
var K = require('../coderun/coderun-kit.js');
var ROOT = path.join(__dirname, '..', '..', '..');
var passed = 0, queue = [];
function test(name, fn) { queue.push([name, fn]); } // run in order at the end (some return promises)
function sorted(a) { return a.slice().sort(); }
function js(code, o) { var a = NC.analyzeJS(code, o); return { d: sorted(a.defines), u: sorted(a.uses), l: sorted(a.lateUses) }; }
function py(code) { var a = NC.analyzePython(code); return { d: sorted(a.defines), u: sorted(a.uses), l: sorted(a.lateUses) }; }

// ---- the manifest entries this module proposes (the test switches to txt/manifest.json once they're in) ----
var ENTRY = {
  id: 'notebook',
  type: 'widget',
  name: 'Notebook',
  description: 'Linked, reactive code blocks: js & python blocks in a note share variables, dependents re-run, rich output, variables',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="15" height="18" rx="2"/><path d="M8 3v18"/><path d="M11.5 8.5l3 2.5-3 2.5"/><path d="M11.5 16.5h4"/></svg>',
  tags: 'notebook,jupyter,observable,reactive,linked,cells,kernel,restart,run all,variables,inspector,display,chart,table,javascript,js,typescript,python,py,code',
  entry: 'widgets/notebook/notebook.js',
  precache: ['widgets/notebook/notebook-core.js', 'widgets/notebook/notebook-engine.js', 'widgets/notebook/notebook.css'],
  prefs: {
    title: 'Notebook',
    fields: [
      { key: 'autoRun', type: 'toggle', label: 'Re-run dependent blocks automatically', default: true,
        hint: 'After you run a block, the blocks that use its variables run again (in order). Off: they are only marked stale.' },
      { key: 'timings', type: 'toggle', label: 'Show run times', default: true },
      { key: 'maxHeight', type: 'slider', label: 'Output height limit', default: 320, min: 120, max: 800, step: 20, unit: 'px' },
      { key: 'saveOutputs', type: 'toggle', label: 'Also save text output in the note', default: false,
        hint: 'Writes an ```output block under each block, like Code Runner. Blocks that already have one are always kept up to date. Tables, charts and images stay view-only.' },
      { type: 'heading', label: 'Time limits' },
      { key: 'jsTimeout', type: 'number', label: 'JavaScript time limit', default: 5, min: 1, max: 120, step: 1, unit: 's' },
      { key: 'pyTimeout', type: 'number', label: 'Python time limit', default: 30, min: 1, max: 600, step: 1, unit: 's' }
    ]
  }
};
var NEW_SCRIPTS = [
  { name: 'Run Code Blocks Above', description: 'Run every runnable code block above the cursor, in order' },
  { name: 'Restart Code Runtime', description: "Clear this note's variables (linked JS & Python blocks) — blocks that ran are marked stale" },
  { name: 'Run All Code Blocks', description: 'Run every runnable code block in order (linked blocks share variables)' }
];
function manifestEntry(id) {
  try {
    var man = JSON.parse(fs.readFileSync(path.join(ROOT, 'txt', 'manifest.json'), 'utf8'));
    for (var i = 0; i < man.modules.length; i++) if (man.modules[i].id === id) return man.modules[i];
  } catch (e) {}
  return null;
}

// ==== JavaScript names ==============================================================================
test('js: the notebook basics', function () {
  assert.deepStrictEqual(js('a = 1'), { d: ['a'], u: [], l: [] });
  assert.deepStrictEqual(js('const b = a * 2'), { d: ['b'], u: ['a'], l: [] });
  assert.deepStrictEqual(js("console.log('b is', b)"), { d: [], u: ['b'], l: [] }, 'globals like console are not dependencies');
  assert.deepStrictEqual(js('x = x + 1; y++; z += 2'), { d: ['x', 'y', 'z'], u: ['x', 'y', 'z'], l: [] }, 'read-then-write is a use and a define');
});
test('js: destructuring declarations and assignments', function () {
  var r = js('const {x, y: [z, w = q], ...rest} = obj; let [p1, , p2 = def] = arr');
  assert.deepStrictEqual(r.d, ['p1', 'p2', 'rest', 'w', 'x', 'z']);
  assert.deepStrictEqual(r.u, ['arr', 'def', 'obj', 'q'], 'keys (y) are not names; defaults are read');
  assert.deepStrictEqual(js('[m, n] = [n, m]').d, ['m', 'n']);
  assert.deepStrictEqual(js('({ k1, k2: k3 } = src)'), { d: ['k1', 'k3'], u: ['src'], l: [] });
});
test('js: functions — params shadow, bodies are late uses, hoisting', function () {
  var r = js('function f(a, {b}, ...c) { const loc = 1; return a + b + c.length + loc + g }\nconst h = (u, v = dflt) => u + v + k\nf()');
  assert.deepStrictEqual(r.d, ['f', 'h']);
  assert.deepStrictEqual(r.u, [], 'f is defined here (hoisted), not a use');
  assert.deepStrictEqual(r.l, ['dflt', 'g', 'k'], 'free names inside functions are late uses');
  assert.deepStrictEqual(js('async function load() { return await fetch(u) }\nconst data = await load()'), { d: ['data', 'load'], u: [], l: ['u'] });
});
test('js: classes, methods, fields, object literals', function () {
  var r = js('class K extends Base { static s = init; m(x) { return x + this.y + helper } get g() { return 1 } }');
  assert.deepStrictEqual(r, { d: ['K'], u: ['Base'], l: ['helper', 'init'] });
  var o = js('const o = { a, b: c, m(d) { return d + e }, [k]: v, get g() { return h }, "s": t }');
  assert.deepStrictEqual(o, { d: ['o'], u: ['a', 'c', 'k', 't', 'v'], l: ['e', 'h'] });
});
test('js: imports bind names', function () {
  assert.deepStrictEqual(js('import d, {a as b, c} from "https://x"; import * as ns from "y"; import "side"').d, ['b', 'c', 'd', 'ns']);
});
test('js: shadowing — what a block declares itself is not a use', function () {
  assert.deepStrictEqual(js('const a = 5; console.log(a)'), { d: ['a'], u: [], l: [] });
  assert.deepStrictEqual(js('{ let a = 1; use1(a) }'), { d: [], u: ['use1'], l: [] }, 'block-scoped let stays local');
  assert.deepStrictEqual(js('if (c) { var a = 1 }').d, ['a'], 'var in a block is still global');
  assert.deepStrictEqual(js('for (let i = 0; i < n; i++) s += i').u, ['n', 's']);
  assert.deepStrictEqual(js('try { risky() } catch ({ message }) { log(message) } finally { done = 1 }'), { d: ['done'], u: ['log', 'risky'], l: [] });
});
test('js: strings, templates, regexes, comments and labels are not names', function () {
  assert.deepStrictEqual(js('const t = `a${foo}b ${bar + 1} c`; const r = /ab+c/g.test(s) ? m : n // x y\n/* z */'),
    { d: ['r', 't'], u: ['bar', 'foo', 'm', 'n', 's'], l: [] });
  assert.deepStrictEqual(js("const s1 = 'a + b', s2 = \"c\"; outer: for (;;) { break outer }"), { d: ['s1', 's2'], u: [], l: [] });
  assert.deepStrictEqual(js('const q = a / b / c').u, ['a', 'b', 'c'], 'division is not a regex');
});
test('js: TypeScript annotations are skipped', function () {
  var r = js('let n: number = 5\nfunction add(a: number, b?: string): Promise<void> { return a + zz }\nconst x = y as Foo', { ts: true });
  assert.deepStrictEqual(r.d, ['add', 'n', 'x']);
  assert.deepStrictEqual(r.u, ['y']);
  assert.deepStrictEqual(r.l, ['zz']);
});

// ==== Python names ==================================================================================
test('py: the notebook basics', function () {
  assert.deepStrictEqual(py('a = 1'), { d: ['a'], u: [], l: [] });
  assert.deepStrictEqual(py('b = a * 2'), { d: ['b'], u: ['a'], l: [] });
  assert.deepStrictEqual(py('print(b)'), { d: [], u: ['b'], l: [] }, 'builtins are not dependencies');
});
test('py: imports', function () {
  assert.deepStrictEqual(py('import numpy as np, os.path\nfrom math import pi, sqrt as sq\nfrom x import (y,\n  z)').d, ['np', 'os', 'pi', 'sq', 'y', 'z']);
});
test('py: def / class — params shadow, bodies are late uses', function () {
  var r = py('def f(x, y=default, *args, k: int = 3, **kw) -> Ret:\n    t = x + y\n    return t + g\n\nclass C(Base, metaclass=Meta):\n    attr = 1\n    def m(self):\n        return self.attr + helper');
  assert.deepStrictEqual(r, { d: ['C', 'f'], u: ['Base', 'Meta', 'Ret', 'default'], l: ['g', 'helper'] });
  var n = py('def outer():\n    global G\n    G = 1\n    def inner():\n        return cv\n    cv = 2\n    return inner');
  assert.deepStrictEqual(n, { d: ['G', 'outer'], u: [], l: [] }, 'global declares a module name; closures resolve to the enclosing function');
});
test('py: assignments — tuples, starred, annotated, augmented, attributes, subscripts', function () {
  var r = py('x = x + 1\ny += 2\nz: int = w\na, (b, *c) = pair\nobj.attr = val\nd[i] = v');
  assert.deepStrictEqual(r.d, ['a', 'b', 'c', 'x', 'y', 'z']);
  assert.deepStrictEqual(r.u, ['d', 'i', 'obj', 'pair', 'v', 'val', 'w', 'x', 'y']);
});
test('py: comprehensions, lambdas, f-strings, walrus, keyword arguments, for / with / except', function () {
  assert.deepStrictEqual(py('sq = [n * n for n in nums if n > lim]\nfn = lambda q, r=dflt: q + r + free'), { d: ['fn', 'sq'], u: ['dflt', 'free', 'lim', 'nums'], l: [] });
  assert.deepStrictEqual(py('s = f"{name!r} is {age:>3} {fmt(x)}"\nt = """{not_used}"""'), { d: ['s', 't'], u: ['age', 'fmt', 'name', 'x'], l: [] });
  assert.deepStrictEqual(py('if (n := compute()) > 0: res = n\nprint(f(key=val), res)'), { d: ['n', 'res'], u: ['compute', 'f', 'val'], l: [] });
  var r = py('for i, v in enumerate(items):\n    total = total + v\nwith open(path) as fh:\n    data = fh.read()\ntry:\n    risky()\nexcept ValueError as err:\n    msg = str(err)');
  assert.deepStrictEqual(r.d, ['data', 'err', 'fh', 'i', 'msg', 'total', 'v']);
  assert.deepStrictEqual(r.u, ['items', 'path', 'risky', 'total']);
});
test('py: shadowing — a name assigned before it is read is local to the block', function () {
  assert.deepStrictEqual(py('a = 5\nprint(a)'), { d: ['a'], u: [], l: [] });
  assert.deepStrictEqual(py('print(a)\na = 5'), { d: ['a'], u: ['a'], l: [] }, 'read before the assignment comes from upstream');
  assert.deepStrictEqual(py('def g():\n    return later\nlater = 1').l, [], 'a late use defined by the same block is local');
});

// ==== the run transform (in a vm standing in for the sandbox) =====================================
function sandbox() {
  var ctx = vm.createContext({ console: console });
  vm.runInContext('var __nbG = this; function __nbRun(fn) { return fn(); } function __cadeLP() { return true; }', ctx);
  var n = 0;
  return function run(code) {
    var v = NC.buildJSVariants(code, K, 'nb-' + (++n) + '.js').variants;
    var src = null;
    for (var i = 0; i < v.length; i++) { try { new vm.Script('(function(){' + v[i] + '\n})'); src = v[i]; break; } catch (e) {} }
    assert.ok(src, 'a variant compiles: ' + code);
    return vm.runInContext(src, ctx);
  };
}
test('transform: re-running const / let / class blocks works and other blocks see the names', function () {
  var run = sandbox();
  return Promise.resolve().then(function () { return run('const a = 1'); })
    .then(function () { return run('const b = a * 2'); })
    .then(function () { return run('b + 1'); }).then(function (v) { assert.strictEqual(v, 3); })
    .then(function () { return run('const a = 5'); })
    .then(function () { return run('const b = a * 2'); })
    .then(function () { return run('b + 1'); }).then(function (v) { assert.strictEqual(v, 11); })
    .then(function () { return run('class P { constructor(x) { this.x = x } }\nfunction mk(v) { return new P(v) }\nlet { k, j = 2 } = { k: 1 }\nlet u'); })
    .then(function () { return run('[mk(3).x, k, j, typeof u]'); }).then(function (v) { assert.deepStrictEqual(Array.from(v), [3, 1, 2, 'undefined']); })
    .then(function () { return run('class P { get y() { return 9 } }'); })
    .then(function () { return run('new P().y'); }).then(function (v) { assert.strictEqual(v, 9, 'a class redefined on re-run'); })
    .then(function () { return run('let total = 0\nfor (const x of [1, 2, 3]) total += x\nawait Promise.resolve(total)'); }).then(function (v) { assert.strictEqual(v, 6, 'top-level await, last value'); });
});
test('transform: no line breaks added, imports become dynamic, exports drop', function () {
  var src = 'import {a as b, default as c} from "https://e.sh/x"\nimport * as ns from "y"\nexport const q = 1\nb + q';
  var t = NC.transformJS(src);
  assert.strictEqual(t.body.split('\n').length, src.split('\n').length);
  assert.ok(/\(\{a: b, default: c\} = await import\("https:\/\/e\.sh\/x"\)\)/.test(t.body), t.body);
  assert.ok(/\(ns = await import\("y"\)\)/.test(t.body));
  assert.ok(!/export/.test(t.body));
  assert.ok(/return \(b \+ q\)/.test(t.bodyRet));
  assert.deepStrictEqual(sorted(t.vars), ['b', 'c', 'ns', 'q']);
  var v = NC.buildJSVariants('while (true) {}', K, 'nb-1.js').variants;
  assert.ok(v[0].indexOf('__cadeLP(') !== -1 && v[v.length - 1].indexOf('__cadeLP(') === -1, 'loop-checked first, plain last');
  assert.ok(/\/\/# sourceURL=nb-1\.js$/.test(v[0]));
  assert.strictEqual(NC.transformJS('if (x) { 1 }').bodyRet, null, 'no return for statements');
});

// ==== dependencies, stale propagation, order, cycles ================================================
function cell(id, defines, uses, late, rt) { return { id: id, rt: rt || 'js', defines: defines, uses: uses || [], lateUses: late || [] }; }
test('deps: nearest block above, else below; late uses only above', function () {
  var cs = [cell(1, ['a']), cell(2, ['a']), cell(3, ['b'], ['a']), cell(4, [], ['z']), cell(5, ['z']), cell(6, [], [], ['w']), cell(7, ['w'])];
  var d = NC.deps(cs);
  assert.deepStrictEqual(d[3], [2], 'the nearest definer above wins');
  assert.deepStrictEqual(d[4], [5], 'falls back to a definer below');
  assert.deepStrictEqual(d[6], [], 'late uses never link downwards');
  assert.deepStrictEqual(NC.deps([cell(1, ['x'], ['x']), cell(2, ['x'], ['x'])])[2], [1], 'x = x + 1 reads the previous block');
  assert.deepStrictEqual(NC.deps([cell(1, ['a'], [], [], 'py'), cell(2, [], ['a'], [], 'js')])[2], [], 'languages do not mix');
});
test('plan: a → b → console re-runs in order; unrelated blocks untouched', function () {
  var cs = [cell(1, ['a']), cell(2, ['b'], ['a']), cell(3, [], ['b']), cell(4, ['q'])];
  var pl = NC.plan(cs, 1, []);
  assert.deepStrictEqual(pl.order, [2, 3]);
  assert.deepStrictEqual(pl.dependents, [2, 3]);
  assert.deepStrictEqual(pl.cyclic, []);
  assert.deepStrictEqual(NC.plan(cs, 3, []).order, [], 'nothing reads a leaf');
});
test('plan: dependency order beats document order; ties go to the document', function () {
  // block 2 reads c, defined below it by block 4; block 3 reads a only
  var cs = [cell(1, ['a']), cell(2, ['d'], ['c']), cell(3, ['e'], ['a']), cell(4, ['c'], ['a'])];
  var pl = NC.plan(cs, 1, []);
  assert.deepStrictEqual(pl.order, [3, 4, 2]);
});
test('plan: names a block stopped defining still affect their readers', function () {
  var cs = [cell(1, []), cell(2, [], ['gone'])];
  assert.deepStrictEqual(NC.plan(cs, 1, ['gone']).order, [2]);
});
test('plan: cycles are reported, not run, and block what depends on them', function () {
  var cs = [cell(1, ['a'], ['b']), cell(2, ['b'], ['a']), cell(3, [], ['b']), cell(4, ['z'], ['a'])];
  var pl = NC.plan(cs, 1, []);
  assert.deepStrictEqual(pl.cyclic, [1, 2]);
  assert.deepStrictEqual(pl.blocked, [3], 'reads b from the cycle');
  assert.deepStrictEqual(pl.order, [4], 'block 4 reads only a: still runs');
  var three = [cell(1, ['x']), cell(2, ['y'], ['x', 'w']), cell(3, ['w'], ['y'])];
  var p3 = NC.plan(three, 1, []);
  assert.deepStrictEqual(p3.order, [], 'a cycle downstream of the root');
  assert.deepStrictEqual(p3.cyclic, [2, 3]);
});
test('plan: works from analysis output (the a / b / console notebook)', function () {
  var codes = ['a = 1', 'const b = a * 2', "console.log('b is', b)"];
  var cs = codes.map(function (c, i) { var a = NC.analyze('js', c); return { id: i + 1, rt: 'js', defines: a.defines, uses: a.uses, lateUses: a.lateUses }; });
  assert.deepStrictEqual(NC.plan(cs, 1, []).order, [2, 3]);
  var pcs = ['x = 2', 'y = x * 3', 'print(y)'].map(function (c, i) { var a = NC.analyze('py', c); return { id: i + 1, rt: 'py', defines: a.defines, uses: a.uses, lateUses: a.lateUses }; });
  assert.deepStrictEqual(NC.plan(pcs, 1, []).order, [2, 3]);
});

// ==== linked on → notebook; off → Code Runner's isolated run =======================================
function fakeDoc(text) {
  var lines = text.split('\n'), starts = [], p = 0;
  lines.forEach(function (l) { starts.push(p); p += l.length + 1; });
  var doc = {
    lines: lines.length, length: text.length,
    line: function (n) { return { number: n, from: starts[n - 1], to: starts[n - 1] + lines[n - 1].length, text: lines[n - 1] }; },
    lineAt: function (pos) { var n = 1; while (n < lines.length && starts[n] <= pos) n++; return doc.line(n); },
    sliceString: function (a, b) { return text.slice(a, b); }
  };
  return doc;
}
function loadEngine(linked) {
  var made = [], toasts = [], calls = [];
  var doc = fakeDoc('```js\nconst b = a * 2\n```\n');
  var prefsStore = { codeblocks: { linked: linked } };
  var Cade = {
    asset: function (r) { return 'http://x/txt/widgets/coderun/' + r; },
    loadCSS: function () {}, onEditorUpdate: function () {}, showToast: function (m) { toasts.push(m); },
    escapeHtml: String, store: { get: function () { return null; }, set: function () {} },
    roomsApi: { activeRoom: function () { return 'r'; } },
    editor: { state: { doc: doc, readOnly: false, selection: { main: { head: 6 } } }, dispatch: function () {} },
    prefs: function (id) { return { get: function (k) { return (prefsStore[id] || {})[k]; }, set: function () {}, on: function () { return function () {}; } }; }
  };
  var win = {
    Cade: Cade, __cadeCodeRunKit: K, location: { href: 'http://x/txt.html' },
    addEventListener: function () {}, removeEventListener: function () {},
    __cadeNotebook: { runCell: function (from, lang) { calls.push([from, lang]); return Promise.resolve('ok'); }, statusAt: function () { return null; }, stop: function () { return false; }, busy: function () { return false; } }
  };
  var document = {
    createElement: function (tag) { var e = { tag: tag, attrs: {}, setAttribute: function (k, v) { this.attrs[k] = v; }, remove: function () {} }; made.push(e); return e; },
    body: { appendChild: function () {} }, head: { appendChild: function () {} }, documentElement: { appendChild: function () {} }
  };
  var src = fs.readFileSync(path.join(__dirname, '..', 'coderun', 'coderun-engine.js'), 'utf8');
  var ctx = vm.createContext({ window: win, document: document, navigator: { onLine: true }, location: win.location, URL: URL, setTimeout: setTimeout, clearTimeout: clearTimeout, console: console, Promise: Promise });
  vm.runInContext(src, ctx);
  return { E: win.__cadeCodeRun, made: made, calls: calls, toasts: toasts };
}
test('routing: linked blocks on → the notebook runs the block', function () {
  var t = loadEngine(true);
  assert.ok(t.E && t.E.runBlockAt, 'engine loaded');
  return t.E.runBlockAt(0).then(function (r) {
    assert.strictEqual(r, 'ok');
    assert.deepStrictEqual(t.calls, [[0, 'js']]);
    assert.ok(!t.made.some(function (e) { return e.tag === 'iframe'; }), 'no one-off sandbox');
  });
});
test('routing: linked blocks off → isolated, as before (one-off sandbox, ```output)', function () {
  var t = loadEngine(false);
  t.E.runBlockAt(0);
  return new Promise(function (res) { setTimeout(res, 20); }).then(function () {
    assert.deepStrictEqual(t.calls, [], 'the notebook is not asked');
    var f = t.made.filter(function (e) { return e.tag === 'iframe'; });
    assert.strictEqual(f.length, 1, 'a fresh sandbox for this run');
    assert.strictEqual(f[0].attrs.sandbox, 'allow-scripts');
    t.E.stop();
  });
});
test('prefs fallback: shared between modules, live listeners, defaults', function () {
  var saved = global.window;
  var P1 = NC.prefsOf(null, 'nbtest', [{ key: 'linked', type: 'toggle', default: true }]);
  var P2 = NC.prefsOf(null, 'nbtest', []);
  assert.strictEqual(P1, P2, 'one fallback object per id');
  assert.strictEqual(P1.get('linked'), true);
  var seen = [];
  var off = P1.on(function (k, v) { seen.push(k + '=' + v); });
  P2.set('linked', false);
  off();
  P2.set('linked', true);
  assert.deepStrictEqual(seen, ['linked=false']);
  var real = { prefs: function () { return { get: function () { return 'real'; } }; } };
  assert.strictEqual(NC.prefsOf(real, 'x', []).get('k'), 'real', 'Cade.prefs wins when present');
  global.window = saved;
});

// ==== output helpers =================================================================================
test('outputText: console, value, error; streamed chunks keep their own breaks', function () {
  var t = NC.outputText({ items: [{ k: 'log', raw: true, text: 'y = 6\n' }, { k: 'log', level: 'warn', text: 'careful' }, { k: 'log', level: 'error', text: 'bad' },
    { k: 'table', text: 'T' }, { k: 'image', src: 'x' }], result: { k: 'text', text: '3' }, error: { text: 'TypeError: x', line: 2 } });
  assert.strictEqual(t, 'y = 6\n⚠ careful\n✖ bad\nT\n[image]\n→ 3\n✖ TypeError: x (line 2)');
});
test('chartSVG: numbers only, labels escaped, bars / lines', function () {
  var svg = NC.chartSVG({ type: 'bar', title: '<b>t</b>', labels: ['<script>x</script>', 'b'], series: [{ name: 'n', pts: [[0, 3], [1, '5'], [2, 'NaN']] }] });
  assert.ok(/^<svg class="nb-chart"/.test(svg));
  assert.strictEqual((svg.match(/<rect class="nb-s0" x=/g) || []).length, 2 + 1, 'two bars + the legend swatch');
  assert.ok(svg.indexOf('<script') === -1 && svg.indexOf('&lt;script&gt;') !== -1 && svg.indexOf('&lt;b&gt;') !== -1);
  assert.ok(/<polyline/.test(NC.chartSVG({ series: [{ pts: [[0, 1], [1, 2]] }] })));
  assert.strictEqual(NC.chartSVG({ series: [{ pts: [['a', 'b']] }] }), '', 'nothing plottable');
});
test('image sources: only base64 raster data URLs', function () {
  assert.ok(NC.isImageSrc('data:image/png;base64,iVBORw0KGgo='));
  assert.ok(!NC.isImageSrc('data:image/svg+xml;base64,PHN2Zz4='));
  assert.ok(!NC.isImageSrc('javascript:alert(1)'));
  assert.ok(!NC.isImageSrc('https://example.com/a.png'));
});
test('sandbox harness: safe to inline in a script element', function () {
  var src = NC.NB_LIB.toString();
  assert.ok(src.indexOf('</script') === -1 && src.indexOf('<!--') === -1);
  var doc = NC.sandboxDoc('tok"</script>', 'var lib = 1;');
  assert.ok(doc.indexOf('tok"</script>') === -1, 'the token is escaped');
  assert.ok(/^<!doctype html>/.test(doc));
});

// ==== metadata vs the proposed manifest entries =======================================================
test('widget registration matches the manifest entry', function () {
  var reg = null;
  var Cade = { baseURL: function () { return 'http://x/txt/widgets/notebook/'; }, registerWidget: function (o) { reg = o; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'notebook.js'), 'utf8'), { window: { Cade: Cade }, location: { href: 'http://x/' }, URL: URL });
  var m = manifestEntry('notebook') || ENTRY;
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(reg[k], m[k], k); });
  assert.strictEqual(m.entry, 'widgets/notebook/notebook.js');
  m.precache.concat([m.entry]).forEach(function (f) { assert.ok(fs.existsSync(path.join(ROOT, 'txt', f)), f); });
});
test('prefs schema: the module constant equals the manifest "prefs"', function () {
  var m = manifestEntry('notebook') || ENTRY;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(NC.PREFS)), m.prefs);
  var keys = NC.PREFS.fields.filter(function (f) { return f.key; }).map(function (f) { return f.key; });
  assert.deepStrictEqual(keys, ['autoRun', 'timings', 'maxHeight', 'saveOutputs', 'jsTimeout', 'pyTimeout']);
  assert.deepStrictEqual(NC.CODEBLOCK_FIELDS, [{ key: 'linked', type: 'toggle', label: 'Linked blocks', default: true }], 'the core page the notebook reads');
});
test('prefs schema: valid for the core prefs (PrefsCore in txt.html, when present)', function () {
  var html = fs.readFileSync(path.join(ROOT, 'txt.html'), 'utf8');
  var a = html.indexOf('// <prefs-core>'), b = html.indexOf('// </prefs-core>');
  if (a < 0 || b < a) return; // core not there yet
  var C = new Function(html.slice(a, b) + '\nreturn PrefsCore;')();
  var s = C.normSpec('notebook', NC.PREFS, ENTRY);
  assert.strictEqual(s.fields.length, NC.PREFS.fields.length, 'every field usable');
  NC.PREFS.fields.forEach(function (f) { if (f.key) assert.ok(C.coerce(s.keys[f.key], f.default) !== undefined, f.key + ' default'); });
  assert.ok(html.indexOf("key: 'linked', type: 'toggle'") > 0, 'the core defines Code blocks / linked');
});
test('palette scripts registered by coderun-scripts.js match the proposed entry', function () {
  var metas = [];
  var Cade = { asset: function (r) { return 'http://x/txt/widgets/coderun/' + r; }, registerScript: function (src) { metas.push(JSON.parse(/\/\*\*\n([\s\S]*?)\n\*\*\//.exec(src)[1])); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'coderun', 'coderun-scripts.js'), 'utf8'), { window: { Cade: Cade }, location: { href: 'http://x/' }, URL: URL });
  var m = manifestEntry('coderun-scripts');
  if (m && !m.scripts.some(function (x) { return x.name === 'Run Code Blocks Above'; })) m = null; // manifest not updated yet
  NEW_SCRIPTS.forEach(function (s) {
    var got = metas.filter(function (x) { return x.name === s.name; })[0];
    assert.ok(got, s.name);
    assert.strictEqual(got.description, s.description);
    if (m) {
      var e = m.scripts.filter(function (x) { return x.name === s.name; })[0];
      if (e) ['description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(e[k], got[k], s.name + ' ' + k); });
    }
  });
});

(function next(i) {
  if (i >= queue.length) { console.log((process.exitCode ? 'FAILED, ' : '') + 'notebook: ' + passed + ' passed'); return; }
  var t = queue[i];
  Promise.resolve().then(t[1]).then(function () { passed++; }, function (e) { console.error('FAIL ' + t[0] + '\n' + (e.stack || e)); process.exitCode = 1; })
    .then(function () { next(i + 1); });
})(0);
