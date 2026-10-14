/* Unit tests for the Regex Tester's pure core: tokenizer / explainer, replacement
 * expansion, the worker job and its timeout runner (fake timers AND a real
 * worker_threads worker running the actual worker source), escaping helpers,
 * the Find & Replace hand-off and the pattern library.
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/regex/regex.test.js */
'use strict';
var assert = require('assert');
var C = require('./regex.js');

var passed = 0, failed = 0, queue = [];
function test(name, fn) { queue.push({ name: name, fn: fn }); }
function runAll() {
  var i = 0;
  (function next() {
    if (i >= queue.length) { console.log((failed ? 'FAILED ' + failed + ', ' : '') + passed + ' passed'); if (failed) process.exitCode = 1; return; }
    var t = queue[i++], done = false;
    function ok() { if (done) return; done = true; passed++; setImmediate(next); }
    function bad(e) { if (done) return; done = true; failed++; console.error('FAIL ' + t.name + '\n' + (e && e.stack || e)); setImmediate(next); }
    try {
      var r = t.fn();
      if (r && typeof r.then === 'function') r.then(ok, bad); else ok();
    } catch (e) { bad(e); }
  })();
}

// a seeded PRNG for reproducible fuzzing (test-only)
function prng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function compiles(p, f) { try { new RegExp(p, f); return true; } catch (e) { return false; } }

// ---- explainer -----------------------------------------------------------------------------
var PATTERNS = [
  '', 'abc', 'a.c', '^\\d{3}-\\d{4}$', '\\bword\\b', '[A-Za-z0-9_]+', '[^\\s,]+', '(\\w+)@(\\w+)\\.com', '(?<year>\\d{4})-(?<m>\\d\\d)',
  '(?:ab)+?', 'colou?r', 'a{2,}', 'a{2,5}?', 'x*y+z?', '(?=foo)bar', '(?!foo)\\w+', '(?<=\\$)\\d+(?:\\.\\d\\d)?', '(?<!un)happy',
  '(a)\\1', '(?<q>[\'"]).*?\\k<q>', 'cat|dog|bird', '\\p{L}+', '\\u{1F600}', '\\x41\\u0042\\cJ\\0', '[\\d\\-.]', '[a-z&&[^aeiou]]',
  '[\\p{L}--[a-z]]', '[\\q{abc|def}x]', '(?i:hello) world', '(?-i:A)a', '\\/path\\/to', 'a\\.b\\*c', '[]', '[^]', '\\8\\9', '\\10',
  '(a+)+$', '(\\w+\\s?)*$', '((ab)*c)+', '.*.*=.*', '^(?:[a-z0-9!#$%&\'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&\'*+/=?^_`{|}~-]+)*)@', '\\t\\n\\r\\v\\f',
  // broken ones
  '(abc', 'abc)', '[abc', 'a**', '*a', 'x{3,1}', '\\', '(?<1bad>x)', '(?P<n>x)', '[z-a]', '+', '(?<=a)+', '\\k<nope>(?<x>a)', '\\u{110000}',
];
test('explain: 50+ patterns (valid and broken) never throw and always describe something', function () {
  var flagSets = ['', 'g', 'gi', 'gmsu', 'gv', 'y', 'dg'];
  assert.ok(PATTERNS.length >= 50);
  PATTERNS.forEach(function (p) {
    flagSets.forEach(function (f) {
      var ex = C.explain(p, f);
      assert.ok(ex && Array.isArray(ex.rows) && Array.isArray(ex.warnings), p);
      if (p) assert.ok(ex.rows.length > 0, 'rows for ' + p);
      ex.rows.forEach(function (r) { assert.ok(typeof r.d === 'string' && r.d.length > 2 && typeof r.raw === 'string', p + ' row'); });
    });
  });
});
function rowsOf(p, f) { return C.explain(p, f || '').rows; }
function find(rows, re) { return rows.filter(function (r) { return re.test(r.d); }); }
test('explain: descriptions of the common token kinds', function () {
  var r = rowsOf('^\\d{3}-(?<code>[A-Z]+)\\b(?=x)|(?<!y)\\1\\k<code>', '');
  assert.ok(find(r, /^Start of the text/).length);
  assert.ok(find(r, /^Matches a digit/).length);
  assert.ok(find(r, /^Exactly 3 times/).length);
  assert.ok(find(r, /Named capturing group #1 “code”/).length);
  assert.ok(find(r, /^Any one of: A–Z/).length);
  assert.ok(find(r, /One or more times — greedy/).length);
  assert.ok(find(r, /^Word boundary/).length);
  assert.ok(find(r, /^Lookahead/).length);
  assert.ok(find(r, /^OR/).length);
  assert.ok(find(r, /^Negative lookbehind/).length);
  assert.ok(find(r, /group #1 “code” matched/).length >= 2);
  assert.ok(find(rowsOf('^a$', 'm'), /Start of a line/).length);
  assert.ok(find(rowsOf('.', 's'), /line breaks included/).length);
  assert.ok(find(rowsOf('a+?'), /lazy/).length);
  assert.ok(find(rowsOf('[^abc]'), /EXCEPT/).length);
  assert.ok(find(rowsOf('[^]'), /Any character at all/).length);
  assert.ok(find(rowsOf('[]'), /Matches nothing/).length);
  assert.ok(find(rowsOf('\\p{L}', 'u'), /Unicode property L \(any letter\)/).length);
  assert.ok(find(rowsOf('\\p{L}', ''), /needs the u or v flag/).length);
  // literal runs merge, but a quantified last character stands alone
  var lr = rowsOf('hello+');
  assert.strictEqual(lr[0].d, 'Literal text “hell”');
  assert.ok(/^Literal “o”/.test(lr[1].d));
  assert.ok(/applied to “o” \(just that one character\)/.test(lr[2].d));
  assert.ok(/any case/.test(rowsOf('abc', 'i')[0].d));
  // nesting depth
  var nr = rowsOf('(a(b))');
  assert.deepStrictEqual(nr.map(function (x) { return x.depth; }), [0, 1, 1, 2, 1, 0]);
});
test('explain: syntax errors are reported as rows, not exceptions', function () {
  [['(abc', /Unclosed group #1/], ['abc)', /Unmatched “\)”/], ['[abc', /Unterminated character class/], ['a**', /Nothing to repeat/],
    ['*a', /Nothing to repeat/], ['x{3,1}', /out of order/], ['\\', /Trailing backslash/], ['[z-a]', /Range out of order/],
    ['(?<=a)+', /Nothing to repeat/], ['\\k<nope>(?<x>a)', /No group named/], ['(?P<n>x)', /Invalid group syntax/]].forEach(function (c) {
    var ex = C.explain(c[0], '');
    assert.ok(ex.errors > 0, c[0]);
    assert.ok(find(ex.rows, c[1]).length, c[0] + ' -> ' + JSON.stringify(ex.rows.map(function (x) { return x.d; })));
  });
  assert.ok(C.explain('a{', 'u').errors > 0);
  assert.strictEqual(C.explain('a{', '').errors, 0); // Annex B: a literal "{"
});
test('explain: nested-quantifier warning (catastrophic backtracking risk)', function () {
  ['(a+)+$', '(\\w+\\s?)*$', '(a*)*b', '(\\w+a)+$', '(\\d+|x)+y', '(.*,)+$'].forEach(function (p) { assert.ok(C.explain(p, '').warnings.length, p); });
  assert.ok(C.explain('(?:a+A)+$', 'i').warnings.length, 'with i, “A” is matched by a+ — no separator');
  assert.strictEqual(C.explain('(?:a+A)+$', '').warnings.length, 0, 'without i, “A” separates the repetitions');
  ['(ab)+', 'a+b+', '(a|b)*c', '(\\d{3})+', 'a{2,}', '((ab)*c)+', '(?:x+y)*z', '(?:[a-z]+\\.)+[a-z]{2,}', '(\\d+,)+\\d+'].forEach(function (p) { assert.strictEqual(C.explain(p, '').warnings.length, 0, p); });
  // the real thing: what the tester flags as risky does blow up in a worker run
  var slow = C.runJob({ id: 1, kind: 'match', pattern: '(\\w+a)+$', flags: '', text: 'a'.repeat(30) + '!' });
  assert.ok(slow.ms > 15, 'the flagged pattern really is slow (' + slow.ms + ' ms)');
});
test('explain: fuzz — never throws; valid patterns produce no error rows; group counts agree', function () {
  var rnd = prng(12345), alpha = ['a', 'b', '\\', '(', ')', '[', ']', '{', '}', '|', '*', '+', '?', '.', '^', '$', '-', '?:', '?=', '?!', '?<=', '?<!', '?<n>', '\\d', '\\w', '\\b', '\\1', '\\k<n>', '2', ',', 'u', 'p', '{2}', '{1,3}', 'é', '😀'];
  var flags = ['', 'u', 'v', 'i', 'm', 's'], checked = 0;
  for (var t = 0; t < 6000; t++) {
    var len = 1 + Math.floor(rnd() * 10), p = '';
    for (var i = 0; i < len; i++) p += alpha[Math.floor(rnd() * alpha.length)];
    var f = flags[Math.floor(rnd() * flags.length)];
    if (f === 'v' && !compiles('', 'v')) continue;
    var ex = C.explain(p, f);
    assert.ok(ex && ex.rows, p);
    if (compiles(p, f)) {
      checked++;
      assert.strictEqual(ex.errors, 0, 'valid /' + p + '/' + f + ' got errors: ' + JSON.stringify(ex.rows.filter(function (r) { return r.k === 'err'; })));
      var native = new RegExp('|' + p, f).exec('').length - 1;
      assert.strictEqual(C.scanGroups(p, f === 'v').length, native, 'group count /' + p + '/' + f);
    }
  }
  assert.ok(checked > 500, 'only ' + checked + ' valid fuzz patterns');
});

// ---- replacement ------------------------------------------------------------------------------
var REP_PATTERNS = [['(\\w)(\\d)?', 'g'], ['(?<w>\\w+)', 'g'], ['', 'g'], ['x*', 'g'], ['a', ''], ['(a)|(b)', 'g'], ['^', 'gm'], ['$', 'gm'],
  ['(?<first>\\w)(?<rest>\\w*)', 'gi'], ['\\b', 'g'], ['.', 'gu'], ['', 'gu'], ['(((((((((((a)))))))))))', 'g'], ['o', 'y'], ['o', 'gy'], ['(?:)', 'g']];
var TEMPLATES = ['', '$$', '$&', '[$&]', '$`', "$'", '$1', '$2', '$01', '$10', '$11', '$00', '$0', '$9', '$<w>', '$<first>-$<rest>', '$<nope>', '$<unclosed',
  '$', 'x$', '$$1', '$&$&', '\\$1', '$1$2$3', '$99', '$<>', '<$`|$\'>'];
var TEXTS = ['', 'a', 'abc a1 b2', 'line one\nline two\n', 'oooh foo', 'é😀x', 'aaaaaaaaaaa', 'The quick brown fox'];
test('replace: our expansion equals String.prototype.replace (all templates × patterns × texts)', function () {
  var n = 0;
  REP_PATTERNS.forEach(function (pf) {
    TEXTS.forEach(function (text) {
      TEMPLATES.forEach(function (tpl) {
        var got = C.replaceAllLike(text, new RegExp(pf[0], pf[1]), tpl), want = text.replace(new RegExp(pf[0], pf[1]), tpl);
        assert.strictEqual(got, want, '/' + pf[0] + '/' + pf[1] + ' on ' + JSON.stringify(text) + ' with ' + JSON.stringify(tpl));
        var job = C.runJob({ id: 1, kind: 'match', pattern: pf[0], flags: pf[1], text: text, tpl: tpl });
        assert.strictEqual(job.preview.text, want, 'runJob preview');
        n++;
      });
    });
  });
  assert.ok(n > 3000);
});
test('replace: fuzz against String.prototype.replace', function () {
  var rnd = prng(777), pats = ['(a)', '(b)?', 'a*', '(?<n>a|b)', '\\w', '', '(a)(b)?(c)?', 'b+'], tparts = ['$', '1', '2', '0', '&', '`', "'", '<n>', '<', '>', 'x', '$$'];
  for (var t = 0; t < 3000; t++) {
    var p = pats[Math.floor(rnd() * pats.length)] + pats[Math.floor(rnd() * pats.length)], tpl = '', text = '';
    for (var i = 0; i < 5; i++) tpl += tparts[Math.floor(rnd() * tparts.length)];
    for (var j = 0; j < 8; j++) text += 'abcx'.charAt(Math.floor(rnd() * 4));
    var f = rnd() < 0.7 ? 'g' : '';
    if (!compiles(p, f)) { t--; continue; }
    assert.strictEqual(C.replaceAllLike(text, new RegExp(p, f), tpl), text.replace(new RegExp(p, f), tpl), p + ' ' + tpl + ' ' + text);
  }
});
test('replace: escapes and the Find & Replace field format', function () {
  assert.strictEqual(C.expandEscapes('a\\nb\\tc\\\\d\\x'), 'a\nb\tc\\d\\x');
  // the app's Replace field expands \n \t \w \s \\ — our hand-off must survive that
  function coreExpand(r) { return String(r).replace(/\\([ntws\\])/g, function (m, c) { return c === 'n' ? '\n' : c === 't' ? '\t' : c === '\\' ? '\\' : ' '; }); }
  ['plain', 'a\nb', 'tab\there', 'back\\slash', '\\n literally', 'C:\\new\\temp', '$1\\$2', '\\\\', 'x\r\ny'].forEach(function (r) {
    var want = r.replace(/\r\n/g, '\n');
    assert.strictEqual(coreExpand(C.toFindReplacement(r)), want, JSON.stringify(r));
    assert.ok(!/[\n\t]/.test(C.toFindReplacement(r)), 'single line for an <input>');
  });
});

// ---- the worker job ----------------------------------------------------------------------------
test('runJob: matches, groups, named groups, indices, caps, errors', function () {
  var r = C.runJob({ id: 7, kind: 'match', pattern: '(?<y>\\d{4})-(\\d\\d)?', flags: 'gd', text: '2024-03 1999- x', maxShow: 10, cap: 200 });
  assert.strictEqual(r.id, 7); assert.ok(r.ok);
  assert.strictEqual(r.total, 2); assert.strictEqual(r.groupCount, 2);
  assert.deepStrictEqual(r.matches[0], { i: 0, l: 7, v: '2024-03', g: ['2024', '03'], n: { y: '2024' }, x: [[0, 4], [5, 7]] });
  assert.deepStrictEqual(r.matches[1].g, ['1999', null]);
  assert.strictEqual(r.matches[1].x[1], null);
  var many = C.runJob({ id: 1, kind: 'match', pattern: '', flags: 'g', text: 'abcdefghij'.repeat(300), maxShow: 1000 });
  assert.strictEqual(many.total, 3001); assert.strictEqual(many.matches.length, 1000);
  var u = C.runJob({ id: 1, kind: 'match', pattern: '', flags: 'gu', text: '😀😀' });
  assert.strictEqual(u.total, 3); // empty matches step over whole code points with u
  assert.strictEqual(C.runJob({ id: 1, kind: 'match', pattern: '', flags: 'g', text: '😀😀' }).total, 5);
  var one = C.runJob({ id: 1, kind: 'match', pattern: 'a', flags: '', text: 'aaa' });
  assert.strictEqual(one.total, 1);
  var sticky = C.runJob({ id: 1, kind: 'match', pattern: 'a', flags: 'gy', text: 'aab' });
  assert.strictEqual(sticky.total, 2);
  var long = C.runJob({ id: 1, kind: 'match', pattern: '.+', flags: 'g', text: 'x'.repeat(5000), cap: 200 });
  assert.strictEqual(long.matches[0].v.length, 200); assert.strictEqual(long.matches[0].l, 5000);
  var bad = C.runJob({ id: 3, kind: 'match', pattern: '(', flags: 'g', text: 'x' });
  assert.strictEqual(bad.ok, false); assert.ok(/Invalid regular expression|Unterminated/.test(bad.error)); assert.strictEqual(bad.id, 3);
});
test('runJob apply: changes rebuild exactly what String.replace gives, unchanged spans skipped', function () {
  var cases = [['(\\w+)@(\\w+)', 'g', 'a@b c@d e', '$2@$1'], ['\\s+$', 'gm', 'x  \ny\t\nz', ''], ['o', '', 'foo', '0'], ['(a)|b', 'g', 'abab', '[$1]'], ['', 'g', 'xyz', '-'], ['a', 'g', 'aaa', 'a']];
  cases.forEach(function (c) {
    var r = C.runJob({ id: 1, kind: 'apply', pattern: c[0], flags: c[1], text: c[2], tpl: c[3] });
    var out = '', pos = 0;
    for (var k = 0; k < r.changes.length; k += 3) { assert.ok(r.changes[k] >= pos); out += c[2].slice(pos, r.changes[k]) + r.changes[k + 2]; pos = r.changes[k + 1]; }
    out += c[2].slice(pos);
    assert.strictEqual(out, c[2].replace(new RegExp(c[0], c[1]), c[3]), JSON.stringify(c));
  });
  assert.strictEqual(C.runJob({ id: 1, kind: 'apply', pattern: 'a', flags: 'g', text: 'aaa', tpl: 'a' }).changes.length, 0);
});

// ---- the timeout runner -------------------------------------------------------------------------
function fakeEnv() {
  var timers = [], workers = [];
  return {
    timers: timers, workers: workers,
    setTimeout: function (f, ms) { var t = { f: f, ms: ms, live: true }; timers.push(t); return t; },
    clearTimeout: function (t) { if (t) t.live = false; },
    fire: function () { timers.filter(function (t) { return t.live; }).forEach(function (t) { t.live = false; t.f(); }); },
    spawn: function () {
      var w = { posted: [], terminated: false, onmessage: null, onerror: null };
      w.postMessage = function (m) { w.posted.push(m); };
      w.terminate = function () { w.terminated = true; };
      w.reply = function (data) { if (w.onmessage) w.onmessage({ data: data }); };
      workers.push(w);
      return w;
    },
  };
}
test('runner: reply, timeout → terminate + fresh worker, superseding, stale replies, dispose', function () {
  var env = fakeEnv(), got = [];
  var R = C.createRunner({ spawn: env.spawn, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout });
  R.run({ id: 1 }, 500, function (r) { got.push(r); });
  assert.strictEqual(env.workers.length, 1);
  env.workers[0].reply({ id: 1, ok: true, total: 3 });
  assert.deepStrictEqual(got[0], { id: 1, ok: true, total: 3 });
  assert.ok(!env.timers.some(function (t) { return t.live; }), 'timer cleared after a reply');
  // a job that never answers
  R.run({ id: 2 }, 500, function (r) { got.push(r); });
  R.run({ id: 3 }, 500, function (r) { got.push(r); }); // queued
  R.run({ id: 4 }, 500, function (r) { got.push(r); }); // replaces 3
  assert.deepStrictEqual(got[1], { id: 3, superseded: true });
  env.fire(); // job 2 overruns
  assert.strictEqual(env.workers[0].terminated, true);
  assert.strictEqual(got[2].timeout, true); assert.strictEqual(got[2].id, 2); assert.strictEqual(got[2].ms, 500);
  assert.strictEqual(env.workers.length, 2, 'a fresh worker took the next job');
  assert.deepStrictEqual(env.workers[1].posted, [{ id: 4 }]);
  env.workers[0].reply({ id: 2, ok: true }); // a late reply from the dead worker is ignored
  assert.strictEqual(got.length, 3);
  env.workers[1].reply({ id: 99, ok: true }); // a reply for another job is ignored
  assert.strictEqual(got.length, 3);
  env.workers[1].reply({ id: 4, ok: true });
  assert.strictEqual(got[3].id, 4);
  // crash
  R.run({ id: 5 }, 500, function (r) { got.push(r); });
  env.workers[1].onerror({ message: 'boom', preventDefault: function () {} });
  assert.strictEqual(got[4].ok, false); assert.ok(/crashed/.test(got[4].error));
  assert.strictEqual(env.workers[1].terminated, true);
  // dispose cancels running and queued jobs and frees the worker
  R.run({ id: 6 }, 500, function (r) { got.push(r); });
  R.run({ id: 7 }, 500, function (r) { got.push(r); });
  R.dispose();
  assert.deepStrictEqual(got.slice(5).map(function (r) { return r.cancelled && r.id; }), [6, 7]);
  assert.strictEqual(env.workers[2].terminated, true);
  assert.ok(!env.timers.some(function (t) { return t.live; }));
  assert.strictEqual(R.alive(), false);
  // idleKill only when idle
  R.run({ id: 8 }, 500, function () {});
  R.idleKill(); assert.strictEqual(R.alive(), true);
  env.workers[3].reply({ id: 8, ok: true });
  R.idleKill(); assert.strictEqual(R.alive(), false);
});
test('runner + real worker thread: catastrophic backtracking is stopped, the next job works', function () {
  var WT = require('worker_threads');
  var shim = 'const { parentPort } = require("worker_threads"); var self = { postMessage: function (m) { parentPort.postMessage(m); } };\n' +
    'parentPort.on("message", function (d) { self.onmessage({ data: d }); });\n';
  var src = shim + C.workerSource();
  function spawn() {
    var t = new WT.Worker(src, { eval: true }), o = { onmessage: null, onerror: null };
    o.postMessage = function (m) { t.postMessage(m); };
    o.terminate = function () { t.terminate(); };
    t.on('message', function (d) { if (o.onmessage) o.onmessage({ data: d }); });
    t.on('error', function (e) { if (o.onerror) o.onerror(e); });
    return o;
  }
  var R = C.createRunner({ spawn: spawn, setTimeout: setTimeout, clearTimeout: clearTimeout });
  return new Promise(function (resolve, reject) {
    var t0 = Date.now();
    R.run({ id: 1, kind: 'match', pattern: '(a+)+$', flags: 'g', text: 'a'.repeat(34) + 'b' }, 300, function (r) {
      try {
        var dt = Date.now() - t0;
        assert.strictEqual(r.timeout, true, JSON.stringify(r));
        assert.ok(dt < 2000, 'timed out after ' + dt + ' ms');
        assert.strictEqual(R.alive(), false);
      } catch (e) { reject(e); return; }
      R.run({ id: 2, kind: 'match', pattern: '(\\w+)@(\\w+)', flags: 'g', text: 'a@b c@d', tpl: '$2@$1' }, 2000, function (r2) {
        try {
          assert.ok(r2.ok, JSON.stringify(r2));
          assert.strictEqual(r2.total, 2);
          assert.strictEqual(r2.preview.text, 'b@a d@c');
          assert.strictEqual(R.spawned(), 2);
          R.dispose();
          resolve();
        } catch (e) { R.dispose(); reject(e); }
      });
    });
  });
});

// ---- escaping ----------------------------------------------------------------------------------
var ESC_PATTERNS = ['a/b', '[/]', '\\/', 'x\ny', 'tab\there', '\\\n', 'quote"s', "single'", 'back\\\\slash', '\u2028', '', '(?<n>\\d+)\\/\\k<n>', 'é😀'];
test('escaping: JS literal and new RegExp(…) compile to the same regex', function () {
  ESC_PATTERNS.forEach(function (p) {
    ['', 'gi', 'gmsu'].forEach(function (f) {
      if (!compiles(p, f)) return;
      var want = new RegExp(p, f);
      var lit = eval(C.toJsLiteral(p, f)); // eslint-disable-line no-eval
      assert.strictEqual(lit.source, want.source, C.toJsLiteral(p, f));
      assert.strictEqual(lit.flags, want.flags);
      var ctor = eval(C.toNewRegExp(p, f)); // eslint-disable-line no-eval
      assert.strictEqual(ctor.source, want.source);
      assert.strictEqual(ctor.flags, want.flags);
    });
  });
  assert.strictEqual(C.toJsLiteral('a/b', 'g'), '/a\\/b/g');
  assert.strictEqual(C.toJsLiteral('', ''), '/(?:)/');
});
test('escaping: string literal round-trips through JSON and JS', function () {
  ESC_PATTERNS.concat(['\u0000\u001f\u007f', '"\\"', '\r\n']).forEach(function (s) {
    var lit = C.toStringLiteral(s);
    assert.strictEqual(JSON.parse(lit), s);
    assert.strictEqual(eval(lit), s); // eslint-disable-line no-eval
    assert.ok(!/[\n\r\u2028\u2029]/.test(lit));
  });
  assert.strictEqual(C.toStringLiteral('\\d+"x"'), '"\\\\d+\\"x\\""');
});

// ---- Find & Replace hand-off -----------------------------------------------------------------------
function positions(re, text) { var out = [], m; re.lastIndex = 0; while ((m = re.exec(text))) { out.push(m.index + ':' + m[0]); if (m[0] === '') re.lastIndex++; } return out.join(','); }
test('find panel: m and s are rewritten so g / gi matching is identical', function () {
  var texts = ['one\ntwo\r\nthree\n\nfour', 'a.b\nc.d', '\n\n', 'x', 'line\u2028sep'];
  var cases = [['^\\w+', 'gm'], ['\\w+$', 'gm'], ['^$', 'gm'], ['a.b', 's'], ['^.+$', 'gms'], ['[.^$]', 'gm'], ['\\^\\$\\.', 'gms'], ['(?<n>^\\w)\\k<n>?', 'gm'],
    ['^t', 'gim'], ['.', 'gs'], ['^', 'm'], ['(?<=^)o', 'gm']];
  cases.forEach(function (c) {
    var spec = C.forFindPanel(c[0], c[1]);
    assert.strictEqual(spec.error, '', c[0]);
    var mine = new RegExp(spec.pattern, spec.caseSensitive ? 'g' : 'gi');
    var orig = new RegExp(c[0], c[1].indexOf('g') < 0 ? c[1] + 'g' : c[1]);
    texts.forEach(function (t) { assert.strictEqual(positions(mine, t), positions(orig, t), '/' + c[0] + '/' + c[1] + ' on ' + JSON.stringify(t) + ' → ' + spec.pattern); });
  });
  assert.strictEqual(C.forFindPanel('abc', 'gi').caseSensitive, false);
  assert.strictEqual(C.forFindPanel('abc', 'g').caseSensitive, true);
  assert.ok(C.forFindPanel('\\p{L}+', 'gu').error);
  assert.ok(C.forFindPanel('\\u{1F600}', 'u').error);
  assert.strictEqual(C.forFindPanel('\\w+', 'gu').error, '');
  assert.ok(C.forFindPanel('\\w+', 'gu').notes.length);
  assert.strictEqual(C.forFindPanel('a$b', 'g').pattern, 'a$b');
});

// ---- library -----------------------------------------------------------------------------------------
test('library: ~20+ patterns compile and find the expected matches in their samples', function () {
  assert.ok(C.LIBRARY.length >= 20);
  var names = {};
  C.LIBRARY.forEach(function (L) {
    assert.ok(!names[L.name], 'duplicate ' + L.name); names[L.name] = 1;
    assert.ok(compiles(L.p, L.f), L.name);
    var r = C.runJob({ id: 1, kind: 'match', pattern: L.p, flags: L.f, text: L.sample, tpl: L.r != null ? (L.esc ? C.expandEscapes(L.r) : L.r) : undefined });
    assert.ok(r.ok, L.name);
    assert.strictEqual(r.total, L.expect, L.name + ': ' + JSON.stringify(r.matches.map(function (m) { return m.v; })));
    var ex = C.explain(L.p, L.f);
    assert.strictEqual(ex.errors, 0, L.name + ' explains cleanly');
  });
  var iso = C.LIBRARY.filter(function (L) { return /YYYY-MM-DD/.test(L.name); })[0];
  assert.strictEqual(C.runJob({ id: 1, kind: 'match', pattern: iso.p, flags: iso.f, text: '2024-03-15', tpl: iso.r }).preview.text, '15/03/2024');
  var dup = C.LIBRARY.filter(function (L) { return L.name === 'Duplicate words'; })[0];
  assert.strictEqual('the the cat'.replace(new RegExp(dup.p, dup.f), dup.r), 'the cat');
  var ip6 = C.LIBRARY.filter(function (L) { return L.name === 'IPv6 address'; })[0];
  var got = C.runJob({ id: 1, kind: 'match', pattern: ip6.p, flags: ip6.f, text: ip6.sample }).matches.map(function (m) { return m.v; });
  assert.deepStrictEqual(got, ['2001:db8::1', 'fe80::1ff:fe23:4567:890a', '::1', '2001:0db8:85a3:0000:0000:8a2e:0370:7334']);
  C.CHEAT.forEach(function (sec) { assert.ok(sec[1].length); });
});

runAll();
