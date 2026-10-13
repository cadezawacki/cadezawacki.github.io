/* Unobfuscate checks: node txt/scripts/pack-code/pack-code-unobf.test.js
 *
 * JS: real javascript-obfuscator 4.2.2 output for the Code Pack's own
 * low / medium / high presets is unobfuscated and must behave exactly like
 * the original (same console output), with no _0x names left. Python / HTML /
 * CSS: Obfuscate -> Unobfuscate round trips with the Code Pack's own code.
 * Plus: plain code is refused, a runaway decoder hits the loop budget.
 *
 * Needs acorn, astring and javascript-obfuscator: fetched once with curl into
 * $UNOBF_LIBS (default: <tmpdir>/cade-unobf-libs). Python checks need python3. */
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const LIBS = process.env.UNOBF_LIBS || path.join(os.tmpdir(), 'cade-unobf-libs');
const URLS = {
  'acorn.min.js': 'https://cdn.jsdelivr.net/npm/acorn@8.14.0/dist/acorn.min.js',
  'astring.min.js': 'https://cdn.jsdelivr.net/npm/astring@1.9.0/dist/astring.min.js',
  'obfuscator.js': 'https://cdn.jsdelivr.net/npm/javascript-obfuscator@4.2.2/dist/index.browser.js'
};
fs.mkdirSync(LIBS, { recursive: true });
for (const f in URLS) {
  const p = path.join(LIBS, f);
  if (!fs.existsSync(p) || fs.statSync(p).size < 1000) cp.execFileSync('curl', ['-sSfL', '-o', p, URLS[f]]);
}
const lib = f => fs.readFileSync(path.join(LIBS, f), 'utf8');
const here = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

const ctx = { console, TextEncoder, TextDecoder, atob, btoa, Response, CompressionStream, DecompressionStream, escape, unescape, setTimeout, clearTimeout };
ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
ctx.document = { currentScript: null, createElement() { return {}; }, head: { appendChild() {} } };
vm.createContext(ctx);
vm.runInContext(lib('astring.min.js') + '\n;\n' + lib('acorn.min.js') + '\n', ctx);
vm.runInContext(lib('obfuscator.js'), ctx);
vm.runInContext(here('pack-code-lib.js'), ctx);
vm.runInContext(here('pack-code-unobf.js'), ctx);
const L = ctx.__CADE_CODEPACK__, U = ctx.__CADE_UNOBF__, O = ctx.JavaScriptObfuscator;
const deps = { acorn: ctx.acorn, astring: ctx.astring };

// same presets as pack-code-lib.js obfPreset()
function preset(name) {
  if (name === 'low') return { compact: true, stringArray: true, stringArrayThreshold: 0.5, stringArrayEncoding: ['base64'] };
  if (name === 'high') return { compact: true, stringArray: true, stringArrayRotate: true, stringArrayShuffle: true, stringArrayThreshold: 1, stringArrayEncoding: ['base64', 'rc4'], deadCodeInjection: true, deadCodeInjectionThreshold: 0.4, controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.75, splitStrings: true, numbersToExpressions: true };
  return { compact: true, stringArray: true, stringArrayRotate: true, stringArrayShuffle: true, stringArrayThreshold: 0.75, stringArrayEncoding: ['base64'], controlFlowFlattening: false, deadCodeInjection: false };
}
// node stand-in for the browser's sandboxed iframe (no timeout: the loop budget must stop runaways)
function runner(code, calls) {
  try {
    const F = vm.runInNewContext('(function(){' + code + '\n})()', { parseInt, String, decodeURIComponent, encodeURIComponent, Error, Math, Array, Object });
    return Promise.resolve(calls.map(c => { try { const r = F[c[0]].apply(null, c[1]); return typeof r === 'string' ? r : null; } catch (e) { return null; } }));
  } catch (e) { return Promise.reject(new Error('Decoder failed in the sandbox: ' + e.message)); }
}
function behaviour(code) {
  const out = [], log = (...a) => out.push(a.join(' '));
  vm.runInNewContext(code, { console: { log, warn: log }, Map, Date, Math, JSON, Object, TypeError, Promise, fetch: () => Promise.reject(new Error('offline')) }, { timeout: 5000 });
  return out.join('\n');
}

const SAMPLES = {
 "inventory": "// A small inventory app used as a deobfuscation fixture.\nconst TAX_RATE = 0.0825;\nclass Inventory {\n  constructor(name) {\n    this.name = name;\n    this.items = new Map();\n  }\n  add(sku, title, price, qty = 1) {\n    if (!sku || typeof sku !== 'string') throw new TypeError('sku must be a non-empty string');\n    const existing = this.items.get(sku);\n    if (existing) existing.qty += qty;\n    else this.items.set(sku, { sku, title, price, qty });\n    return this;\n  }\n  total() {\n    let sum = 0;\n    for (const [, item] of this.items) sum += item.price * item.qty;\n    return Math.round(sum * (1 + TAX_RATE) * 100) / 100;\n  }\n  report() {\n    const lines = [];\n    for (const item of this.items.values()) {\n      lines.push(`${item.title.padEnd(12)} x${item.qty}  $${(item.price * item.qty).toFixed(2)}`);\n    }\n    lines.push('Total (incl. tax): $' + this.total().toFixed(2));\n    return lines.join('\\n');\n  }\n}\nfunction greet(user) {\n  const hour = new Date().getHours();\n  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';\n  return 'Good ' + part + ', ' + user.name + '!';\n}\nasync function loadPrices(url) {\n  try {\n    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });\n    if (!res.ok) return null;\n    return await res.json();\n  } catch (err) {\n    console.warn('price feed unavailable', err.message);\n    return null;\n  }\n}\nconst inv = new Inventory('Corner shop');\ninv.add('A-1', 'Apples', 0.5, 6).add('B-2', 'Bread', 2.25).add('A-1', 'Apples', 0.5, 2);\nconsole.log(greet({ name: 'Ada' }));\nconsole.log(inv.report());\nconst isValid = /^[A-Z]-\\d+$/.test('A-1') && inv.items.size === 2;\nconsole.log('valid:', isValid, 'count:', inv.items.size);\n",
 "shop": "var Shop = (function () {\n  var registry = {};\n  var counter = 0;\n  function makeId(prefix) {\n    counter = counter + 1;\n    var pad = '000' + counter;\n    var id = prefix + '-' + pad.slice(-3);\n    registry[id] = true;\n    return id;\n  }\n  function price(base, qty, discount) {\n    var gross = base * qty;\n    var cut = gross * (discount || 0);\n    var net = gross - cut;\n    var tax = net * 0.08;\n    var total = Math.round((net + tax) * 100) / 100;\n    return total;\n  }\n  function describe(item) {\n    var parts = [];\n    parts.push(item.name);\n    parts.push('x' + item.qty);\n    parts.push('@' + item.base.toFixed(2));\n    if (item.discount) parts.push('-' + item.discount * 100 + '%');\n    parts.push('= ' + price(item.base, item.qty, item.discount).toFixed(2));\n    return parts.join(' ');\n  }\n  function Cart(owner) {\n    this.owner = owner;\n    this.items = [];\n    this.id = makeId('cart');\n    this.created = 'today';\n    this.notes = [];\n  }\n  Cart.prototype.add = function (name, base, qty, discount) {\n    var item = { name: name, base: base, qty: qty || 1, discount: discount };\n    item.id = makeId('item');\n    this.items.push(item);\n    this.notes.push('added ' + name);\n    return this;\n  };\n  Cart.prototype.total = function () {\n    var sum = 0;\n    var i = 0;\n    var n = this.items.length;\n    for (i = 0; i < n; i++) sum += price(this.items[i].base, this.items[i].qty, this.items[i].discount);\n    return Math.round(sum * 100) / 100;\n  };\n  Cart.prototype.receipt = function () {\n    var self = this;\n    var lines = ['Receipt for ' + self.owner + ' (' + self.id + ')'];\n    self.items.forEach(function (it) { lines.push('  ' + describe(it)); });\n    lines.push('Total: ' + self.total().toFixed(2));\n    lines.push('Notes: ' + self.notes.join('; '));\n    return lines.join('\\n');\n  };\n  return { Cart: Cart, ids: function () { return Object.keys(registry); } };\n})();\nvar cart = new Shop.Cart('Grace');\ncart.add('tea', 4.5, 2).add('cake', 3.25, 1, 0.1).add('jam', 2, 3, 0.25);\nconsole.log(cart.receipt());\nconsole.log(Shop.ids().join(','));\n"
};
const PY = "\"\"\"Module docstring that the minifier drops.\"\"\"\nimport json\n\nGREETING = '''Hello,\n    indented line inside a string\n  and another'''\n\ndef stats(nums):\n    \"\"\"Return mean and spread.\"\"\"\n    # a comment\n    if not nums:\n        return None\n    total = sum(nums)\n    mean = total / len(nums)\n    spread = (max(nums) -\n              min(nums))\n    return {'mean': round(mean, 2), 'spread': spread}\n\nclass Greeter:\n    def __init__(self, name):\n        self.name = name\n\n    def hello(self, loud=False):\n        msg = f\"Hi {self.name}! It's \\\"great\\\"\"\n        if loud:\n            for _ in range(2):\n                msg = msg.upper()\n        else:\n            msg = msg + ' :)'\n        return msg\n\nprint(GREETING)\nprint(json.dumps(stats([3, 1, 4, 1, 5, 9, 2, 6])))\nprint(Greeter('Ada').hello(), Greeter('Bob').hello(True))\n";
const HTML = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Café ☕ — test</title>\n<style>.a{color:red}</style></head>\n<body><h1 class=\"title\">Hello “world” 👋</h1><script>console.log('x</'+'script>');</script></body></html>\n";
const CSS = "/* header comment */\n.card, #main .title > a:hover { color: #ff0000; background: url(\"img/bg.png\") no-repeat; }\n.btn-primary::after { content: \"→ next\"; margin: 0px 0.50em; }\n.\\31 0col { width: 10%; }\n.md\\:flex { display: flex; }\n@media (max-width: 600px) { .card { padding: 4px; } }\n";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
(async () => {
  for (const name in SAMPLES) {
    const src = SAMPLES[name], want = behaviour(src);
    for (const p of ['low', 'medium', 'high']) {
      for (let seed = 1; seed <= 2; seed++) {
        const obf = O.obfuscate(src, Object.assign({ seed: seed * 7919 }, preset(p))).getObfuscatedCode();
        ok(U.detect(obf).lang === 'js', name + '/' + p + ': detected as JS');
        try {
          const r = await U._deobfuscateJS(obf, deps, runner);
          ok(behaviour(r.code) === want, name + '/' + p + '/' + seed + ': same behaviour');
          ok(!/_0x[0-9a-f]{3,}/.test(r.code), name + '/' + p + '/' + seed + ': no _0x names left');
          ok(r.stats.strings > 0, name + '/' + p + '/' + seed + ': strings decoded');
          if (p === 'high' && name === 'shop') ok(r.stats.flattened > 0, name + '/high: flattened blocks restored');
        } catch (e) { ok(false, name + '/' + p + '/' + seed + ': ' + e.stack); }
      }
    }
  }
  // plain code is refused, untouched
  try { await U._deobfuscateJS(SAMPLES.inventory, deps, runner); ok(false, 'plain JS should be refused'); }
  catch (e) { ok(/No obfuscation found/.test(e.message), 'plain JS refused'); }
  // a decoder that never returns is stopped by the loop budget; its calls stay as they were
  const evil = "function _0xa1b2(){var a=['aGk='];_0xa1b2=function(){return a;};return _0xa1b2();}function _0xc3d4(i){var t=_0xa1b2();while(true){}return t[i];}console.log(_0xc3d4(0));";
  const r0 = await U._deobfuscateJS(evil, deps, runner);
  ok(r0.stats.strings === 0 && /while/.test(r0.code), 'runaway decoder stopped by the loop budget');

  // Python: runs the same; 4-space indents; two layers
  const pyObf = await L._obfuscatePython(PY), pr = await U._unobfuscatePython(pyObf);
  ok(U.detect(pyObf).lang === 'python', 'python detected');
  ok(/\n    def hello/.test(pr.code) && /\n        if loud:/.test(pr.code), 'python re-indented');
  ok((await U._unobfuscatePython(await L._obfuscatePython(pyObf))).code === pr.code, 'python two layers');
  let havePy = true; try { cp.execFileSync('python3', ['-c', 'pass']); } catch (e) { havePy = false; }
  if (havePy) {
    const run = code => cp.execFileSync('python3', ['-'], { input: code }).toString();
    ok(run(pr.code) === run(PY), 'python behaves the same');
  }
  // HTML: exact
  ok(U._unobfuscateHTML(L._obfuscateHTML(HTML)).code === HTML, 'html exact round trip');
  ok(U._unobfuscateHTML(L._obfuscateHTML(L._obfuscateHTML(HTML))).code === HTML, 'html two layers');
  // CSS: back to the minified original (author's own escapes kept)
  const co = L._obfuscateCSS(CSS);
  ok(U.detect(co).lang === 'css', 'css detected');
  ok(U._unescapeCSS(co.replace(/\/\*![\s\S]*?\*\//, '')).css === L._minifyCSS(CSS), 'css round trip');
  ok(!/[\x01\x02]/.test(L._minifyCSS(CSS)) && /url\("img\/bg\.png"\)/.test(L._minifyCSS(CSS)), 'minify keeps quoted url()');

  console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
