/* Unit tests for the Snippets pure model (snippets-core.js, shared by the
 * Snippets widget and the snippet-expand plugin).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/snippets/snippets.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var P = require('./snippets-core.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var WED = new Date(2026, 9, 14, 9, 5, 7);   // Wednesday 14 Oct 2026, 09:05:07
var EVE = new Date(2026, 9, 14, 21, 30, 0); // 9:30 PM
function ex(body, env) {
  env = env || {};
  if (!env.now) env.now = WED;
  return P.expand(body, env);
}

// ---------------------------------------------------------------- normalize
test('normalize: no library / garbage → null', function () {
  assert.strictEqual(P.normalize(null), null);
  assert.strictEqual(P.normalize(undefined), null);
  assert.strictEqual(P.normalize('x'), null);
  assert.strictEqual(P.normalize([]), null);
  assert.strictEqual(P.normalize({}), null);
  assert.strictEqual(P.normalize({ snippets: 'nope' }), null);
});

test('normalize: empty library stays empty (no starters re-seeded)', function () {
  var n = P.normalize({ snippets: [] });
  assert.deepStrictEqual(n.snippets, []);
  assert.deepStrictEqual(n.opts, { trigger: ';', space: true, fences: false });
});

test('normalize: coerces, trims, caps, dedupes ids and abbreviations', function () {
  var long = new Array(30002).join('x');
  var n = P.normalize({
    snippets: [
      { id: 'a', name: '  Sig  ', abbr: ' ;sig ', body: 'Best,\r\nCade', folder: ' Email ', fav: true, created: 5, updated: 'x' },
      { id: 'a', name: 'Dup id', abbr: ';SIG', body: 'other' },
      null, 'str', 42,
      { name: '', body: '' },
      { body: long },
      { body: '  # Heading here\nmore', abbr: 'way-too-long-abbreviation-over-the-cap' },
      { name: 7, body: 12, fav: 'yes' },
    ],
    opts: { trigger: 'ab', space: 'no', fences: true },
  });
  assert.strictEqual(n.snippets.length, 5);
  var a = n.snippets[0];
  assert.deepStrictEqual([a.id, a.name, a.abbr, a.body, a.folder, a.fav, a.created, a.updated], ['a', 'Sig', ';sig', 'Best,\nCade', 'Email', true, 5, 0]);
  assert.notStrictEqual(n.snippets[1].id, 'a');            // duplicate id re-minted
  assert.strictEqual(n.snippets[1].abbr, '');               // ;SIG clashes with ;sig (case-insensitive)
  assert.strictEqual(n.snippets[2].body.length, P.MAX_BODY);
  assert.strictEqual(n.snippets[2].name.length <= 61, true);
  assert.strictEqual(n.snippets[3].name, 'Heading here');   // name from the first line
  assert.strictEqual(n.snippets[3].abbr, '');               // over the 32-char cap
  assert.strictEqual(n.snippets[4].name, '7');
  assert.strictEqual(n.snippets[4].body, '12');
  assert.strictEqual(n.snippets[4].fav, false);
  assert.deepStrictEqual(n.opts, { trigger: ';', space: true, fences: true });
});

test('normalize: keeps small unknown fields from newer versions', function () {
  var n = P.normalize({ v: 2, extra: 'keep', huge: { x: 1 }, snippets: [{ id: 'x1', name: 'A', body: 'b', color: 'red', n: 3, obj: { no: 1 } }] });
  assert.strictEqual(n.extra, 'keep');
  assert.strictEqual(n.huge, undefined);
  assert.strictEqual(n.snippets[0].color, 'red');
  assert.strictEqual(n.snippets[0].n, 3);
  assert.strictEqual(n.snippets[0].obj, undefined);
  assert.strictEqual(n.v, 1);
});

test('normalize: caps the number of snippets', function () {
  var arr = [];
  for (var i = 0; i < 600; i++) arr.push({ name: 'n' + i, body: 'b' + i });
  assert.strictEqual(P.normalize({ snippets: arr }).snippets.length, P.MAX_SNIPPETS);
});

test('virtual starters: useful, valid, unique, and not stored', function () {
  var v = P.virtualState();
  assert.strictEqual(v.virtual, true);
  assert.ok(v.snippets.length >= 8);
  var abbrs = {};
  v.snippets.forEach(function (s) {
    assert.ok(s.name && s.body && s.abbr, s.id);
    assert.strictEqual(P.abbrError(s.abbr, ';', v.snippets, s.id), '', s.abbr);
    assert.ok(!abbrs[s.abbr]); abbrs[s.abbr] = 1;
    var r = P.expand(s.body, { now: WED, values: {}, clipboard: 'https://x.y', selection: '' });
    assert.ok(r.text.indexOf('{{') < 0, s.name + ' left a placeholder: ' + r.text);
  });
  assert.strictEqual(P.toStored(v).virtual, undefined);
  // normalising the stored copy keeps them all
  assert.strictEqual(P.normalize(P.toStored(v)).snippets.length, v.snippets.length);
});

test('plugin STARTERS table matches the core starters (abbr + clipboard use)', function () {
  var src = fs.readFileSync(path.join(__dirname, '../../plugins/snippet-expand/snippet-expand.js'), 'utf8');
  var m = /var STARTERS = (\{[^}]*\});/.exec(src);
  assert.ok(m, 'STARTERS literal not found in the plugin');
  var table = JSON.parse(m[1].replace(/'/g, '"'));
  var want = {};
  P.STARTERS.forEach(function (s) { want[s.abbr] = /\{\{\s*clipboard\s*\}\}/i.test(s.body) ? 1 : 0; });
  assert.deepStrictEqual(table, want);
});

// ---------------------------------------------------------------- abbreviations
test('cleanAbbr adds the trigger to a bare word, strips spaces', function () {
  assert.strictEqual(P.cleanAbbr('sig', ';'), ';sig');
  assert.strictEqual(P.cleanAbbr(' ;s ig ', ';'), ';sig');
  assert.strictEqual(P.cleanAbbr('', ';'), '');
  assert.strictEqual(P.cleanAbbr('!x', ';'), '!x');      // error reported by abbrError
  assert.strictEqual(P.cleanAbbr('éte', '!'), '!éte');
});

test('abbrError: trigger, length, inner trigger, braces, uniqueness', function () {
  var list = [{ id: '1', name: 'Sig', abbr: ';sig' }];
  assert.strictEqual(P.abbrError('', ';', list), '');
  assert.strictEqual(P.abbrError(';addr', ';', list), '');
  assert.ok(/start with/.test(P.abbrError('!addr', ';', list)));
  assert.ok(/Add a word/.test(P.abbrError(';', ';', list)));
  assert.ok(/only at the start/.test(P.abbrError(';a;b', ';', list)));
  assert.ok(/Braces/.test(P.abbrError(';a{b', ';', list)));
  assert.ok(/already used by “Sig”/.test(P.abbrError(';SIG', ';', list, '2')));
  assert.strictEqual(P.abbrError(';sig', ';', list, '1'), '');   // itself
  assert.ok(/under 32/.test(P.abbrError(';' + new Array(40).join('a'), ';', list)));
});

test('findAbbr: exact (case-insensitive), unique prefix only when allowed', function () {
  var idx = P.abbrIndex({ snippets: [{ abbr: ';mtg' }, { abbr: ';sig' }, { abbr: ';sig2' }, { abbr: ';addr' }, { abbr: '' }] });
  assert.strictEqual(P.findAbbr(idx, ';MTG').abbr, ';mtg');
  assert.strictEqual(P.findAbbr(idx, ';mt'), null);
  assert.strictEqual(P.findAbbr(idx, ';mt', true).abbr, ';mtg');
  assert.strictEqual(P.findAbbr(idx, ';sig', true).abbr, ';sig');  // exact beats prefix
  assert.strictEqual(P.findAbbr(idx, ';si', true), null);          // ambiguous
  assert.strictEqual(P.findAbbr(idx, ';', true), null);
  assert.strictEqual(P.findAbbr(idx, ';zzz', true), null);
  assert.strictEqual(P.findAbbr(idx, 'constructor'), null);       // no prototype leaks
});

// ---------------------------------------------------------------- dates
test('formatDate: tokens and literals', function () {
  assert.strictEqual(P.formatDate(WED, 'YYYY-MM-DD'), '2026-10-14');
  assert.strictEqual(P.formatDate(WED, 'ddd, MMM D, YYYY'), 'Wed, Oct 14, 2026');
  assert.strictEqual(P.formatDate(WED, 'dddd, MMMM Do'), 'Wednesday, October 14th');
  assert.strictEqual(P.formatDate(WED, 'D/M/YY'), '14/10/26');
  assert.strictEqual(P.formatDate(WED, 'h:mm A'), '9:05 AM');
  assert.strictEqual(P.formatDate(EVE, 'hh:mm a'), '09:30 pm');
  assert.strictEqual(P.formatDate(EVE, 'HH:mm:ss'), '21:30:00');
  assert.strictEqual(P.formatDate(WED, '[Week] W, [Q]Q'), 'Week 42, Q4');
  assert.strictEqual(P.formatDate(new Date(2026, 0, 1), 'Do'), '1st');
  assert.strictEqual(P.formatDate(new Date(2026, 0, 2), 'Do'), '2nd');
  assert.strictEqual(P.formatDate(new Date(2026, 0, 3), 'Do'), '3rd');
  assert.strictEqual(P.formatDate(new Date(2026, 0, 11), 'Do'), '11th');
  assert.strictEqual(P.formatDate(new Date(2026, 0, 12), 'Do'), '12th');
  assert.strictEqual(P.formatDate(new Date(2026, 0, 13), 'Do'), '13th');
  assert.strictEqual(P.formatDate(new Date(2026, 0, 22), 'Do'), '22nd');
  assert.strictEqual(P.formatDate(new Date(2026, 0, 1, 0, 0), 'h A'), '12 AM');
  assert.strictEqual(P.formatDate(new Date(2026, 0, 1, 12, 0), 'h A'), '12 PM');
});

test('ISO week numbers across year boundaries', function () {
  assert.strictEqual(P.isoWeek(new Date(2021, 0, 3)), 53);   // Sun 3 Jan 2021 → 2020-W53
  assert.strictEqual(P.isoWeek(new Date(2021, 0, 4)), 1);
  assert.strictEqual(P.isoWeek(new Date(2020, 11, 31)), 53);
  assert.strictEqual(P.isoWeek(new Date(2024, 11, 30)), 1);  // Mon 30 Dec 2024 → 2025-W01
  assert.strictEqual(P.isoWeek(new Date(2026, 0, 1)), 1);
  assert.strictEqual(P.isoWeek(WED), 42);
});

test('shiftDate: days, weeks, months (clamped), years, hours', function () {
  var f = function (d) { return P.formatDate(d, 'YYYY-MM-DD HH:mm'); };
  assert.strictEqual(f(P.shiftDate(WED, 3, 'd')), '2026-10-17 09:05');
  assert.strictEqual(f(P.shiftDate(WED, -2, 'w')), '2026-09-30 09:05');
  assert.strictEqual(f(P.shiftDate(new Date(2026, 0, 31), 1, 'm')), '2026-02-28 00:00');
  assert.strictEqual(f(P.shiftDate(new Date(2024, 1, 29), 1, 'y')), '2025-02-28 00:00');
  assert.strictEqual(f(P.shiftDate(new Date(2026, 11, 31), 1, 'd')), '2027-01-01 00:00');
  assert.strictEqual(f(P.shiftDate(WED, 20, 'h')), '2026-10-15 05:05');
});

// ---------------------------------------------------------------- placeholders
test('parsePh: recognised forms and literal fallbacks', function () {
  assert.deepStrictEqual(P.parsePh('date'), { type: 'date', kind: 'date', n: 0, unit: 'd', fmt: null });
  assert.deepStrictEqual(P.parsePh(' date : MMM D '), { type: 'date', kind: 'date', n: 0, unit: 'd', fmt: ' MMM D ' });
  assert.deepStrictEqual(P.parsePh('date+3w:YYYY'), { type: 'date', kind: 'date', n: 3, unit: 'w', fmt: 'YYYY' });
  assert.deepStrictEqual(P.parsePh('tomorrow'), { type: 'date', kind: 'date', n: 1, unit: 'd', fmt: null });
  assert.strictEqual(P.parsePh('yesterday').n, -1);
  assert.strictEqual(P.parsePh('tomorrow+2').n, 3);
  assert.strictEqual(P.parsePh('tomorrow+1w'), null);
  assert.deepStrictEqual(P.parsePh('time+2'), { type: 'date', kind: 'time', n: 2, unit: 'h', fmt: null });
  assert.deepStrictEqual(P.parsePh('input:Client name'), { type: 'input', key: 'client name', label: 'Client name', def: '', choices: null });
  assert.deepStrictEqual(P.parsePh('input: Size = M '), { type: 'input', key: 'size', label: 'Size', def: 'M', choices: null });
  assert.deepStrictEqual(P.parsePh('input:Pri=High| Low |'), { type: 'input', key: 'pri', label: 'Pri', def: 'High', choices: ['High', 'Low'] });
  assert.deepStrictEqual(P.parsePh('CLIPBOARD'), { type: 'clipboard' });
  assert.strictEqual(P.parsePh('input'), null);
  assert.strictEqual(P.parsePh('input:'), null);
  assert.strictEqual(P.parsePh('name'), null);          // Handlebars etc. stay literal
  assert.strictEqual(P.parsePh('user.name'), null);
  assert.strictEqual(P.parsePh('cursor:x'), null);
});

test('tokenize: escapes, unknown and unterminated braces stay literal', function () {
  var t = P.tokenize('a \\{{date}} {{ name }} {{date}} {{x');
  assert.deepStrictEqual(t.map(function (x) { return x.t === 'text' ? x.v : '<' + x.ph.type + '>'; }), ['a {{date}} {{ name }} ', '<date>', ' {{x']);
});

test('scan: fields deduped by name (case-insensitive), flags, one-line', function () {
  var i = P.scan('Hi {{input:Name}}, {{input:name}} {{input:Size=M}} {{input:Size}} {{input:Pri=A|B}} {{clipboard}} {{cursor}}');
  assert.deepStrictEqual(i.fields.map(function (f) { return [f.key, f.label, f.def, f.choices]; }),
    [['name', 'Name', '', null], ['size', 'Size', 'M', null], ['pri', 'Pri', 'A', ['A', 'B']]]);
  assert.strictEqual(i.clipboard, true);
  assert.strictEqual(i.cursor, true);
  assert.strictEqual(i.selection, false);
  assert.strictEqual(i.oneLine, true);
  assert.strictEqual(P.scan('a\nb').oneLine, false);
  assert.strictEqual(P.scan('{{date}}').fields.length, 0);
});

test('expand: dates, times (12h / 24h), weekday, offsets', function () {
  assert.strictEqual(ex('{{date}}').text, '2026-10-14');
  assert.strictEqual(ex('{{today:dddd}}').text, 'Wednesday');
  assert.strictEqual(ex('{{date:YYYY-MM-DD}}').text, '2026-10-14');
  assert.strictEqual(ex('{{tomorrow}} / {{yesterday:ddd}}').text, '2026-10-15 / Tue');
  assert.strictEqual(ex('{{date+7:MMM D}} {{date-1m:MMM D}} {{date+1y:YYYY}}').text, 'Oct 21 Sep 14 2027');
  assert.strictEqual(ex('{{weekday}} {{weekday+2}}').text, 'Wednesday Friday');
  assert.strictEqual(ex('{{time}}').text, '9:05 AM');
  assert.strictEqual(ex('{{time}}', { now: EVE, hour12: false }).text, '21:30');
  assert.strictEqual(ex('{{time+1}}', { now: EVE }).text, '10:30 PM');
  assert.strictEqual(ex('{{now}}').text, '2026-10-14 9:05 AM');
  assert.strictEqual(ex('{{time:HH:mm:ss}}').text, '09:05:07');
});

test('expand: fields (same name → same value), defaults, choices', function () {
  var b = 'Dear {{input:Client name}}, re {{input:Topic=your order}}. Bye {{input:client NAME}} ({{input:Pri=High|Low}})';
  assert.strictEqual(ex(b, { values: { 'client name': 'Acme', topic: 'invoice 42', pri: 'Low' } }).text, 'Dear Acme, re invoice 42. Bye Acme (Low)');
  assert.strictEqual(ex(b, { values: { 'client name': 'Acme' } }).text, 'Dear Acme, re your order. Bye Acme (High)');
  assert.strictEqual(ex('{{input:X}}|').text, '|');   // nothing typed → empty
});

test('expand: clipboard, selection, cursor (first one wins)', function () {
  var r = ex('[{{selection}}{{cursor}}]({{clipboard}}){{cursor}}', { selection: 'Cade', clipboard: 'https://cade.dev' });
  assert.strictEqual(r.text, '[Cade](https://cade.dev)');
  assert.strictEqual(r.cursor, 5);
  r = ex('[{{selection}}{{cursor}}]({{clipboard}})', { selection: '', clipboard: null });
  assert.strictEqual(r.text, '[]()');
  assert.strictEqual(r.cursor, 1);
  assert.strictEqual(ex('no caret').cursor, -1);
  assert.strictEqual(ex('x\ue000y\ue001z').text, 'xyz'); // stray marker characters can't leak
});

test('expand: indentation of the insertion line carries to every non-empty line', function () {
  var body = 'Agenda\n- {{cursor}}\n\n  - nested\nEnd';
  var r = ex(body, { indent: '    ' });
  assert.strictEqual(r.text, 'Agenda\n    - \n\n      - nested\n    End');
  assert.strictEqual(r.cursor, 'Agenda\n    - '.length);
  // a line holding only the caret is indented too, so typing starts in place
  r = ex('a\n{{cursor}}\nb', { indent: '\t' });
  assert.strictEqual(r.text, 'a\n\t\n\tb');
  assert.strictEqual(r.cursor, 3);
  // multi-line clipboard follows the indentation; the selection keeps its own layout
  assert.strictEqual(ex('> {{clipboard}}', { indent: '  ', clipboard: 'one\ntwo' }).text, '> one\n  two');
  assert.strictEqual(ex('```\n{{selection}}\n```', { indent: '  ', selection: 'if (x) {\n    y();\n}' }).text, '```\n  if (x) {\n    y();\n}\n  ```');
  assert.strictEqual(ex('a\r\nb', { indent: ' ' }).text, 'a\n b');
});

test('indentAt / dedent', function () {
  assert.strictEqual(P.indentAt('    - item', 6), '    ');
  assert.strictEqual(P.indentAt('    - item', 2), '  ');       // inserting inside the indentation
  assert.strictEqual(P.indentAt('\titem', 1), '\t');
  assert.strictEqual(P.indentAt('item', 2), '');
  assert.strictEqual(P.dedent('    a\n      b\n\n    c'), 'a\n  b\n\nc');
  assert.strictEqual(P.dedent('a\n  b'), 'a\n  b');
});

// ---------------------------------------------------------------- usage + ordering
test('usage: bump, normalise garbage, cap at 300 keeping the newest', function () {
  var u = P.bumpUsage(null, 'a', 1000000);
  u = P.bumpUsage(u, 'a', 2000000);
  assert.deepStrictEqual(u.a, [2, 2000]);
  assert.deepStrictEqual(P.normUsage({ 'bad id!': [1, 2], ok: [3, 4], x: 'no', y: [1] }), { ok: [3, 4] });
  var big = {};
  for (var i = 0; i < 320; i++) big['k' + i] = [1, i + 1];
  var c = P.bumpUsage(big, 'new', 999999000);
  assert.strictEqual(Object.keys(c).length, 300);
  assert.ok(c['new'] && c.k319 && !c.k0);
});

var LIB = P.normalize({ snippets: [
  { id: 'sig', name: 'Signature', abbr: ';sig', body: 'Best,\nCade', folder: 'Email' },
  { id: 'mtg', name: 'Meeting notes', abbr: ';mtg', body: '## Meeting\nAttendees', folder: 'Templates', fav: true },
  { id: 'addr', name: 'Home address', abbr: ';addr', body: '12 Elm Street\nSpringfield' },
  { id: 'bug', name: 'Bug report', abbr: ';bug', body: 'Steps to reproduce', folder: 'Templates' },
  { id: 'ty', name: 'Thanks email', abbr: ';ty', body: 'Thank you for the meeting', folder: 'Email' },
  { id: 'zip', name: 'Zip code', body: '90210' },
] }).snippets;
function names(list) { return list.map(function (s) { return s.id; }); }

test('search: abbreviation, name prefix / words, folder, body, fuzzy; all words must match', function () {
  assert.deepStrictEqual(names(P.search(LIB, ';sig', {})).slice(0, 1), ['sig']);
  assert.deepStrictEqual(names(P.search(LIB, 'sig', {})).slice(0, 1), ['sig']);       // abbr without the trigger
  assert.deepStrictEqual(names(P.search(LIB, 'meet', {})), ['mtg', 'ty']);              // name beats body
  assert.deepStrictEqual(names(P.search(LIB, 'notes', {})), ['mtg']);                  // later word of the name
  assert.deepStrictEqual(names(P.search(LIB, 'email', {})), ['ty', 'sig']);            // name word beats folder
  assert.deepStrictEqual(names(P.search(LIB, 'springfield', {})), ['addr']);           // body
  assert.deepStrictEqual(names(P.search(LIB, 'hmadr', {})), ['addr']);                 // subsequence of the name
  assert.deepStrictEqual(names(P.search(LIB, 'email thank', {})), ['ty']);             // AND
  assert.deepStrictEqual(names(P.search(LIB, 'zzzz', {})), []);
  assert.strictEqual(P.search(LIB, '  ', {}).length, LIB.length);
});

test('search: favourites and frequent use break ties', function () {
  var two = P.normalize({ snippets: [{ id: 'a', name: 'Reply A', body: 'x' }, { id: 'b', name: 'Reply B', body: 'x', fav: true }] }).snippets;
  assert.deepStrictEqual(names(P.search(two, 'reply', {})), ['b', 'a']);
  two[1].fav = false;
  assert.deepStrictEqual(names(P.search(two, 'reply', { a: [5, 10] })), ['a', 'b']);
});

test('ordered: favourites, then recently used (max N), then A–Z', function () {
  var u = { sig: [3, 300], addr: [1, 500], zip: [1, 100], bug: [2, 400] };
  var o = P.ordered(LIB, u, 2);
  assert.deepStrictEqual(names(o.favs), ['mtg']);
  assert.deepStrictEqual(names(o.recent), ['addr', 'bug']);
  assert.deepStrictEqual(names(o.rest), ['sig', 'ty', 'zip']);
  assert.deepStrictEqual(P.folders(LIB), ['Email', 'Templates']);
});

// ---------------------------------------------------------------- import / export
test('export → import round trip (JSON)', function () {
  var st = { snippets: LIB };
  var back = P.parseImport(P.exportJSON(st));
  assert.strictEqual(back.format, 'json');
  assert.deepStrictEqual(back.snippets.map(function (s) { return [s.name, s.abbr || '', s.body, s.folder || '', !!s.fav]; }),
    LIB.map(function (s) { return [s.name, s.abbr, s.body, s.folder, s.fav]; }));
});

test('export → import round trip (markdown list, bodies with fences and blank lines)', function () {
  var tricky = P.normalize({ snippets: [
    { name: 'Code **block**', abbr: ';code', body: '```js\nconsole.log(1)\n```\n\n  indented', folder: 'Dev', fav: true },
    { name: 'Plain', body: 'one line' },
    { name: 'Blank lines', abbr: ';bl', body: 'a\n\n\nb\n' },
  ] }).snippets;
  var md = P.exportMarkdown({ snippets: tricky });
  assert.ok(/^- \*\*Plain\*\*\n {4}```\n {4}one line\n {4}```$/m.test(md), md);
  assert.ok(md.indexOf('    ````') >= 0, 'a longer fence wraps a body containing ```');
  var back = P.parseImport(md);
  assert.strictEqual(back.format, 'markdown');
  assert.deepStrictEqual(back.snippets.map(function (s) { return [s.name, s.abbr, s.body, s.folder, s.fav]; }),
    tricky.map(function (s) { return [s.name, s.abbr, s.body, s.folder, s.fav]; }));
});

test('import: hand-written markdown list forms', function () {
  var r = P.parseImport([
    '# My snippets',
    '- `;e` me@example.com',
    '- Address: 12 Elm Street, Springfield',
    '- **Standup** `;su` — Work',
    '  ```',
    '  Yesterday:',
    '  Today:',
    '  ```',
    'not a list line',
    '* Phone: +1 555 0100',
  ].join('\n'));
  assert.deepStrictEqual(r.snippets.map(function (s) { return [s.name, s.abbr, s.body, s.folder]; }), [
    ['me@example.com', ';e', 'me@example.com', ''],
    ['Address', '', '12 Elm Street, Springfield', ''],
    ['Standup', ';su', 'Yesterday:\nToday:', 'Work'],
    ['Phone', '', '+1 555 0100', ''],
  ]);
});

test('import: JSON variants and errors', function () {
  var r = P.parseImport('[{"title":"T","text":"hello","abbreviation":";h","tag":"misc","favorite":true}]');
  assert.deepStrictEqual(r.snippets, [{ name: 'T', abbr: ';h', body: 'hello', folder: 'misc', fav: true }]);
  r = P.parseImport('{";sig": "Best,\\nCade", "Address": "12 Elm"}');
  assert.deepStrictEqual(r.snippets.map(function (s) { return [s.name, s.abbr || '', s.body]; }), [[';sig', ';sig', 'Best,\nCade'], ['Address', '', '12 Elm']]);
  assert.ok(P.parseImport('{"snippets": [}').error);
  assert.ok(P.parseImport('{"a": 1}').snippets.length === 0);
  assert.deepStrictEqual(P.parseImport('   ').snippets, []);
});

test('mergeImport: skips identical, drops taken abbreviations, fresh ids', function () {
  var st = P.normalize({ snippets: [{ id: 'a', name: 'Sig', abbr: ';sig', body: 'Best' }] });
  var m = P.mergeImport(st, [
    { name: 'Sig', abbr: ';sig', body: 'Best' },         // identical → skipped
    { name: 'Sig 2', abbr: ';SIG', body: 'Cheers' },     // abbreviation taken → blank
    { name: 'Addr', abbr: ';addr', body: '12 Elm' },
    { name: 'Addr again', abbr: ';addr', body: 'other' } // taken by the previous import
  ], 123);
  assert.deepStrictEqual([m.added, m.skipped, m.conflicts], [3, 1, 2]);
  assert.deepStrictEqual(m.state.snippets.map(function (s) { return s.abbr; }), [';sig', '', ';addr', '']);
  assert.ok(m.state.snippets.slice(1).every(function (s) { return s.id !== 'a' && s.created === 123; }));
  assert.strictEqual(st.snippets.length, 1); // input untouched
});

test('restoreStarters and retrigger', function () {
  var st = P.normalize({ snippets: [{ id: 'mine', name: 'Mine', abbr: ';sig', body: 'x' }, P.STARTERS[0]] });
  var r = P.restoreStarters(st, 1);
  assert.strictEqual(r.added, P.STARTERS.length - 1);
  var sig = r.state.snippets.filter(function (s) { return s.id === 'starter-sig'; })[0];
  assert.strictEqual(sig.abbr, '');                      // ;sig is taken by "Mine"
  assert.strictEqual(P.restoreStarters(r.state, 1).added, 0);
  var t = P.retrigger(st, ';', '!');
  assert.deepStrictEqual(t.snippets.map(function (s) { return s.abbr; }), ['!sig', '!mtg']);
  assert.strictEqual(t.opts.trigger, '!');
});

test('size budget and trigger validation', function () {
  var big = { snippets: [] };
  for (var i = 0; i < 12; i++) big.snippets.push({ id: 'b' + i, name: 'n', abbr: '', body: new Array(19000).join('x'), folder: '', fav: false });
  assert.strictEqual(P.tooBig(big), true);
  assert.strictEqual(P.tooBig(P.virtualState()), false);
  // the budget counts UTF-8 bytes, not characters
  var one = { snippets: [{ id: 'a', name: 'n', abbr: '', body: 'x', folder: '', fav: false }] };
  var emoji = { snippets: [{ id: 'a', name: 'n', abbr: '', body: '😀', folder: '', fav: false }] };
  assert.strictEqual(P.storedSize(emoji) - P.storedSize(one), 3);
  var cjk = { snippets: [{ id: 'c', name: 'n', abbr: '', body: new Array(70001).join('漢'), folder: '', fav: false }] };
  assert.strictEqual(P.tooBig(cjk), true); // 70k characters but 210 KB
  [';', '!', '/', '\\x', '`', '~', ',', '#'].forEach(function (c) { if (c.length === 1) assert.ok(P.validTrigger(c), c); });
  ['a', '1', ' ', '', ';;', '{', '}', '\\', 'é', null].forEach(function (c) { assert.ok(!P.validTrigger(c), String(c)); });
});

console.log(passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
