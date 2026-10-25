/* Checks for response links (polls, date planning, RSVP, packing lists,
 * shared checklists): reading a note into a draft, the type registry and its
 * specs, each type's tally / summary / Markdown, the packing-claim race and
 * shared ticks, one response per browser, hidden results (a respondent can't
 * read anyone else's; the owner can; reveal), closing, and burn-core's
 * handling of the 'respond' mode. Not loaded by the app.
 * Run: node txt/widgets/burn/burn-respond.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var C = require('./burn-core.js');
var RC = require('./burn-respond-core.js');
var passed = 0, pending = [];
function test(name, fn) {
  try {
    var r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(function () { passed++; }, function (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }));
    else passed++;
  } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var NOW = Date.UTC(2026, 9, 25, 12, 0, 0);    // Sun 25 Oct 2026
function rejects(p, what) { return p.then(function () { throw new Error('should have failed: ' + what); }, function () {}); }

// ---- reading the owner's note ------------------------------------------------------------------------------
test('note → checklist items, a poll, dates with times, a suggestion', function () {
  var note = [
    '# Weekend trip',
    '',
    'Where should we eat?',
    '- Pizza',
    '- Tacos',
    '- [ ] Sushi',
    '',
    'Packing:',
    '- [ ] Tent',
    '- [x] Chairs x6',
    '* [ ] Cups (20)',
    '',
    'Options: Sat 2 Nov at 7pm, or Sun 3 Nov 19:30',
    'Maybe 2026-12-05 too. Or 14th of March.'
  ].join('\n');
  var p = RC.parseNote(note, NOW);
  assert.strictEqual(p.title, 'Weekend trip');
  assert.deepStrictEqual(p.poll, { q: 'Where should we eat?', opts: ['Pizza', 'Tacos', 'Sushi'] });
  assert.deepStrictEqual(p.checklist.map(function (c) { return c.t; }), ['Sushi', 'Tent', 'Chairs x6', 'Cups (20)']);
  assert.strictEqual(p.checklist[2].done, true);
  assert.deepStrictEqual(p.dates, [
    { d: '2026-11-02', t: '19:00' }, { d: '2026-11-03', t: '19:30' }, { d: '2026-12-05', t: '' }, { d: '2027-03-14', t: '' }
  ]);
  assert.strictEqual(p.suggest, 'poll');
  assert.strictEqual(RC.parseNote('- [ ] milk\n- [ ] eggs', NOW).suggest, 'list');
  assert.strictEqual(RC.parseNote('Party on Nov 2 or Nov 9?', NOW).suggest, 'dates');
  assert.strictEqual(RC.parseNote('just some text', NOW).suggest, null);
  // a ? line followed by fewer than two bullets is no poll
  assert.strictEqual(RC.parseNote('Why?\n- one', NOW).poll, null);
  // numbered options, one blank line after the question
  assert.deepStrictEqual(RC.parseNote('**Best day?**\n\n1. Friday\n2. Saturday', NOW).poll, { q: 'Best day?', opts: ['Friday', 'Saturday'] });
});
test('dates: formats, past day → next year, impossible dates skipped, am/pm', function () {
  var d = RC.datesIn('Jan 31, Feb 30, 1 Feb 2027 at 9:15am, Oct 25 noon, Oct 24 12pm, 12am Dec 1', NOW);
  assert.deepStrictEqual(d.map(function (x) { return x.d + ' ' + x.t; }), ['2027-01-31 ', '2027-02-01 09:15', '2026-10-25 ', '2027-10-24 12:00', '2026-12-01 ']);
  assert.strictEqual(RC.fmtDate('2026-11-02', NOW), 'Mon 2 Nov');
  assert.strictEqual(RC.fmtDate('2027-03-14', NOW), 'Sun 14 Mar 2027');
  assert.strictEqual(RC.fmtTime('19:00'), '7 pm');
  assert.strictEqual(RC.fmtTime('00:30'), '12:30 am');
  assert.strictEqual(RC.fmtSlot({ d: '2026-11-07', t: '12:00' }, NOW), 'Sat 7 Nov 12 pm');
});
test('quantities and each type built from a note', function () {
  assert.deepStrictEqual(RC.qtyOf('Chairs x6'), { t: 'Chairs', n: 6 });
  assert.deepStrictEqual(RC.qtyOf('Cups (20)'), { t: 'Cups', n: 20 });
  assert.deepStrictEqual(RC.qtyOf('Box'), { t: 'Box', n: 1 });
  var p = RC.parseNote('Camping\n- [ ] Tent\n- [ ] Chairs ×4', NOW);
  var pk = RC.typeOf('packing').clean(RC.typeOf('packing').fromNote(p, NOW), true);
  assert.deepStrictEqual(pk.items.map(function (i) { return [i.t, i.n]; }), [['Tent', 1], ['Chairs', 4]]);
  assert.strictEqual(pk.q, 'Camping');
  var ls = RC.typeOf('list').clean(RC.typeOf('list').fromNote(p, NOW), true);
  assert.deepStrictEqual(ls.items.map(function (i) { return i.t; }), ['Tent', 'Chairs ×4']);
  assert.strictEqual(ls.add, true);
  var dt = RC.typeOf('dates').clean(RC.typeOf('dates').fromNote(RC.parseNote('BBQ\nNov 7 or Nov 8 at 1pm', NOW)), true);
  assert.deepStrictEqual(dt.slots.map(function (x) { return x.id + ' ' + x.d + ' ' + x.t; }), ['s0 2026-11-07 ', 's1 2026-11-08 13:00']);
});

// ---- the registry and specs ------------------------------------------------------------------------------
test('registry: the five built-in types in order; a new type plugs in', function () {
  assert.deepStrictEqual(RC.types().map(function (t) { return t.id; }), ['poll', 'dates', 'rsvp', 'packing', 'list']);
  RC.types().forEach(function (T) { ['label', 'short', 'icon', 'blurb'].forEach(function (k) { assert(T[k], T.id + ' ' + k); }); ['clean', 'fromNote', 'tally', 'summary', 'markdown'].forEach(function (k) { assert.strictEqual(typeof T[k], 'function', T.id + ' ' + k); }); });
  var T = RC.registerType({ id: 'test-x', label: 'X', short: 'X', icon: 'x', blurb: 'x', clean: function (s) { return { q: 'x' }; }, fromNote: function () { return {}; },
    answer: function (a) { return a && a.v ? { v: 1 } : null; }, tally: function (s, d) { return { n: d.answers.length }; }, summary: function (s, t) { return 'X · ' + t.n; }, markdown: function () { return 'x'; } });
  assert.strictEqual(RC.typeOf('test-x'), T);
  assert.strictEqual(RC.typeOf('nope'), null);
  assert.strictEqual(RC.typeOf('__proto__'), null);
});
test('specs: strict checks with readable messages; junk cleaned', function () {
  var P = RC.typeOf('poll');
  assert.throws(function () { P.clean({ q: '', opts: ['a', 'b'] }, true); }, /question/);
  assert.throws(function () { P.clean({ q: 'Q?', opts: ['a'] }, true); }, /two choices/);
  assert.throws(function () { P.clean({ q: 'Q?', opts: ['a', 'A'] }, true); }, /same/);
  var s = P.clean({ q: '  Lunch?\n', opts: ['Pizza', '', { t: 'Tacos', id: 'bad id!' }, null], vis: 'weird', multi: 1 }, true);
  assert.deepStrictEqual(s, { q: 'Lunch?', opts: [{ id: 'i0', t: 'Pizza' }, { id: 'i1', t: 'Tacos' }], multi: true, other: false, anon: false, vis: 'live' });
  assert.throws(function () { RC.typeOf('dates').clean({ slots: [{ d: '2026-11-02' }] }, true); }, /two dates/);
  assert.throws(function () { RC.typeOf('packing').clean({ items: [] }, true); }, /at least one/);
  assert.throws(function () { RC.typeOf('rsvp').clean({ q: '' }, true); }, /replying to/);
  assert.doesNotThrow(function () { RC.typeOf('list').clean({ items: [], add: true }, true); });
  // non-strict never throws (reading a head)
  assert.doesNotThrow(function () { RC.types().forEach(function (T) { T.clean({ q: 1, opts: 'x', items: {}, slots: 7 }, false); T.clean(null, false); }); });
  var d = RC.typeOf('dates').clean({ slots: [{ d: '2026-11-03' }, { d: '2026-11-02', t: '25:00' }, { d: '2026-11-03' }, { d: '2026-02-30' }] }, false);
  assert.deepStrictEqual(d.slots, [{ id: 's0', d: '2026-11-02', t: '' }, { id: 's1', d: '2026-11-03', t: '' }]);
});
test('makeRespond / readRespond: hidden needs a public key; a forged head with junk is refused', function () {
  assert.throws(function () { RC.makeRespond({ type: 'nope', spec: {} }); }, /Pick/);
  assert.throws(function () { RC.makeRespond({ type: 'poll', spec: { q: 'Q', opts: ['a', 'b'], vis: 'hidden' } }); }, /key/);
  var r = RC.makeRespond({ type: 'poll', spec: { q: 'Q', opts: ['a', 'b'], vis: 'live' }, pub: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } });
  assert.strictEqual(r.pub, null, 'no key kept for visible results');
  assert.strictEqual(RC.readRespond({ respond: { type: 'poll', spec: { q: 'Q', opts: ['a', 'b'], vis: 'hidden' } } }), null);
  assert.strictEqual(RC.readRespond({ respond: { type: 'x' } }), null);
  assert.strictEqual(RC.readRespond({}), null);
  assert.strictEqual(RC.readRespond({ respond: { type: 'packing', spec: { items: ['a'] } } }).hidden, false);
});

// ---- tallies -------------------------------------------------------------------------------------------------
function ans(rid, at, name, a, me) { return { rid: rid, at: at, name: name, anon: false, label: name, a: a, me: !!me }; }
test('poll tally: single / multi, other answers, leader, ties, summary, markdown', function () {
  var R = { type: 'poll', spec: RC.typeOf('poll').clean({ q: 'Food?', opts: ['Pizza', 'Tacos', 'Sushi'], other: true, multi: true }, true) };
  var T = RC.typeOf('poll');
  // answers are cleaned against the spec
  assert.deepStrictEqual(T.answer({ pick: ['i0', 'i0', 'zz', 'i2'], other: ' Thai ' }, R.spec), { pick: ['i0', 'i2'], other: 'Thai' });
  assert.strictEqual(T.answer({ pick: [] }, R.spec), null);
  var single = T.clean({ q: 'Q', opts: ['a', 'b'], other: true }, true);
  assert.deepStrictEqual(T.answer({ pick: ['i0', 'i1'], other: 'x' }, single), { pick: ['i0'], other: '' });
  var data = { answers: [ans('r1', 1, 'Ann', { pick: ['i0'], other: '' }), ans('r2', 2, 'Bob', { pick: ['i0', 'i1'], other: '' }), ans('r3', 3, 'Cy', { pick: [], other: 'Thai' })] };
  var t = RC.tally(R, data);
  assert.strictEqual(t.voters, 3);
  assert.deepStrictEqual(t.counts, { i0: 2, i1: 1, i2: 0 });
  assert.deepStrictEqual(t.leaders, ['i0']);
  assert.deepStrictEqual(t.names.i0, ['Ann', 'Bob']);
  assert.strictEqual(RC.summary(R, t), 'Poll · 3 votes · Pizza leads');
  data.answers.push(ans('r4', 4, 'Di', { pick: ['i1'], other: '' }));
  assert.strictEqual(RC.summary(R, RC.tally(R, data)), 'Poll · 4 votes · Pizza & Tacos tied');
  assert.strictEqual(RC.summary(R, RC.tally(R, { answers: [] })), 'Poll · no votes yet');
  var md = RC.markdown(R, RC.tally(R, data), { now: NOW, closed: true });
  assert(md.indexOf('**Food?** — 4 votes (closed)') === 0, md);
  assert(md.indexOf('| Pizza 🏆 | 2 | Ann, Bob |') > 0, md);
  assert(md.indexOf('| Sushi | 0 |  |') > 0, md);
  assert(md.indexOf('- Thai — Cy') > 0, md);
  assert(/_Poll results · Sun 25 Oct_\n$/.test(md), md);
  // Markdown in names / options can't break the table
  var R2 = { type: 'poll', spec: T.clean({ q: 'a|b', opts: ['x|y', '*z*'] }, true) };
  var md2 = RC.markdown(R2, RC.tally(R2, { answers: [ans('r1', 1, 'E|vil', { pick: ['i0'], other: '' })] }), {});
  assert(md2.indexOf('| x\\|y 🏆 | 1 | E\\|vil |') > 0, md2);
});
test('dates tally: yes / maybe / no per slot, best slot (maybe = half), grid markdown', function () {
  var R = { type: 'dates', spec: RC.typeOf('dates').clean({ q: 'BBQ?', slots: [{ d: '2026-10-31' }, { d: '2026-11-01', t: '13:00' }, { d: '2026-11-07' }] }, true) };
  var data = { answers: [
    ans('r1', 1, 'Ann', { s0: 'y', s1: 'y', s2: 'n' }), ans('r2', 2, 'Bob', { s0: 'm', s1: 'y' }), ans('r3', 3, 'Cy', { s0: 'y', s1: 'n', s2: 'y' })
  ] };
  var t = RC.tally(R, data);
  assert.deepStrictEqual([t.slots.s0.y, t.slots.s0.m, t.slots.s0.n], [2, 1, 0]);
  assert.deepStrictEqual(t.best, ['s0'], 'two yes + a maybe beats two yes');
  assert.strictEqual(RC.summary(R, t, { now: NOW }), 'Dates · Sat 31 Oct best (2 yes, 1 maybe)');
  var md = RC.markdown(R, t, { now: NOW });
  assert(md.indexOf('| | Sat 31 Oct ⭐ | Sun 1 Nov 1 pm | Sat 7 Nov |') > 0, md);
  assert(md.indexOf('| Ann | ✅ | ✅ | ❌ |') > 0, md);
  assert(md.indexOf('| Bob | 🤔 | ✅ |  |') > 0, md);
  assert(md.indexOf('| **Yes** | **2** +1? | **2** | **1** |') > 0, md);
  assert(md.indexOf('Best: Sat 31 Oct') > 0, md);
  // a tie keeps both, earliest first
  var t2 = RC.tally(R, { answers: [ans('r1', 1, 'A', { s1: 'y', s2: 'y' })] });
  assert.deepStrictEqual(t2.best, ['s1', 's2']);
  assert.strictEqual(RC.summary(R, t2, { now: NOW }), 'Dates · Sun 1 Nov 1 pm (tied) (1 yes)');
  assert.strictEqual(RC.typeOf('dates').answer({ s0: 'y', zz: 'y', s1: 'perhaps' }, R.spec).s0, 'y');
  assert.strictEqual(RC.typeOf('dates').answer({ zz: 'y' }, R.spec), null);
});
test('rsvp tally: heads count guests, capped by the spec', function () {
  var R = { type: 'rsvp', spec: RC.typeOf('rsvp').clean({ q: 'Dinner Sat', plus: 2 }, true) };
  var T = RC.typeOf('rsvp');
  assert.deepStrictEqual(T.answer({ r: 'y', plus: 7 }, R.spec), { r: 'y', plus: 2 });
  assert.deepStrictEqual(T.answer({ r: 'n', plus: 2 }, R.spec), { r: 'n', plus: 0 });
  var t = RC.tally(R, { answers: [ans('a1', 1, 'Ann', { r: 'y', plus: 1 }), ans('a2', 2, 'Bob', { r: 'm', plus: 0 }), ans('a3', 3, 'Cy', { r: 'y', plus: 0 })] });
  assert.strictEqual(t.heads, 3);
  assert.strictEqual(RC.summary(R, t), 'RSVP · 3 coming · 1 maybe');
  var md = RC.markdown(R, t, {});
  assert(md.indexOf('- **Coming (2):** Ann +1, Cy') > 0, md);
});

// ---- packing claims ---------------------------------------------------------------------------------------
function claim(rid, item, q, at, name, me) { return { rid: rid, item: item, v: { q: q }, at: at, label: name, name: name, me: !!me }; }
test('packing: the earliest claim wins (ties by id), quantities fill up in order, summary', function () {
  var R = { type: 'packing', spec: RC.typeOf('packing').clean({ q: 'Camp', items: [{ t: 'Tent' }, { t: 'Chairs', n: 6 }, { t: 'Stove' }] }, true) };
  // Two people claim the tent: same data in any order → the same winner everywhere.
  var a = claim('rAAAAAAAAA', 'i0', 1, 1000, 'Ann'), b = claim('rBBBBBBBBB', 'i0', 1, 999, 'Bob');
  var t1 = RC.tally(R, { items: [a, b] }), t2 = RC.tally(R, { items: [b, a] });
  assert.deepStrictEqual(t1, t2);
  var tent = t1.items[0];
  assert.deepStrictEqual(tent.claims.map(function (c) { return [c.name, c.got]; }), [['Bob', 1], ['Ann', 0]]);
  assert.strictEqual(tent.left, 0);
  // the very same server time: the smaller id wins, deterministically
  var t3 = RC.tally(R, { items: [claim('rZZZZZZZZZ', 'i0', 1, 5, 'Zed'), claim('rAAAAAAAAA', 'i0', 1, 5, 'Ann')] });
  assert.strictEqual(t3.items[0].claims[0].name, 'Ann');
  assert.strictEqual(t3.items[0].claims[1].got, 0);
  // chairs: need 6 — 4 then 4 → the second gets 2
  var t4 = RC.tally(R, { items: [claim('r1xxxxxxxx', 'i1', 4, 10, 'Ann'), claim('r2xxxxxxxx', 'i1', 4, 11, 'Bob'), claim('r3xxxxxxxx', 'zz', 1, 1, 'X'), { rid: 'r4xxxxxxxx', item: 'i2', v: { q: 0 }, at: 1, label: 'Y' }] });
  assert.deepStrictEqual(t4.items[1].claims.map(function (c) { return c.got; }), [4, 2]);
  assert.strictEqual(t4.items[1].left, 0);
  assert.strictEqual(t4.items[2].left, 1, 'q 0 is no claim');
  assert.strictEqual(RC.summary(R, t4), 'Packing · 2 of 3 unclaimed');
  assert.strictEqual(RC.summary(R, RC.tally(R, { items: [claim('r1xxxxxxxx', 'i0', 1, 1, 'A'), claim('r1xxxxxxxx', 'i1', 6, 1, 'A'), claim('r1xxxxxxxx', 'i2', 1, 1, 'A')] })), 'Packing · all 3 covered');
  var md = RC.markdown(R, t4, {});
  assert(md.indexOf('- [ ] Tent — unclaimed') > 0, md);
  assert(md.indexOf('- [x] Chairs ×6 — Ann (4), Bob (2)') > 0, md);
});
test('list: the latest tick wins, anyone can untick, added items appear after the owner\'s', function () {
  var R = { type: 'list', spec: RC.typeOf('list').clean({ q: 'Shop', items: ['Milk', 'Eggs'], add: true }, true) };
  var tk = function (rid, item, on, at, name) { return { rid: rid, item: item, v: { on: on }, at: at, label: name }; };
  var t = RC.tally(R, {
    items: [tk('r1xxxxxxxx', 'i0', true, 10, 'Ann'), tk('r2xxxxxxxx', 'i0', false, 20, 'Bob'), tk('r2xxxxxxxx', 'i1', true, 15, 'Bob'), tk('r3xxxxxxxx', 'xAAA', true, 30, 'Cy')],
    added: [{ rid: 'r3xxxxxxxx', k: 'xAAA', at: 25, v: { t: 'Bread' }, label: 'Cy' }, { rid: 'r3xxxxxxxx', k: 'i0', at: 26, v: { t: 'dup id' }, label: 'Cy' }]
  });
  assert.deepStrictEqual(t.items.map(function (x) { return [x.t, x.on, x.by || '']; }), [['Milk', false, 'Bob'], ['Eggs', true, 'Bob'], ['Bread', true, 'Cy']]);
  assert.strictEqual(t.done, 2);
  assert.strictEqual(RC.summary(R, t), 'List · 2 of 3 ticked');
  var md = RC.markdown(R, t, {});
  assert(md.indexOf('- [ ] Milk\n- [x] Eggs — Bob\n- [x] Bread — Cy (added by Cy)') > 0, md);
  // adding off → added items ignored
  var R2 = { type: 'list', spec: RC.typeOf('list').clean({ items: ['Milk'], add: false }, true) };
  assert.strictEqual(RC.tally(R2, { items: [], added: [{ rid: 'r3xxxxxxxx', k: 'xA', at: 1, v: { t: 'B' }, label: 'C' }] }).items.length, 1);
});

// ---- the wire format: sealing, one response per browser, hidden results ---------------------------------------
function setup(type, spec, hidden) {
  var id = C.newId(), key = C.newKey();
  var keysP = hidden ? RC.newOwnerKeys() : Promise.resolve(null);
  return keysP.then(function (keys) {
    var head = RC.makeRespond({ type: type, spec: spec, pub: keys && keys.pub });
    return { id: id, key: key, keys: keys, R: RC.readRespond({ respond: JSON.parse(JSON.stringify(head)) }), resp: {} };
  });
}
function write(L, rid, name, a, ts) {
  return RC.sealAnswer({ key: L.key, id: L.id, rid: rid, R: L.R, name: name, anon: false, a: a, ts: ts }).then(function (rec) { L.resp[rid] = rec; return rec; });
}
test('visible poll: sealed answers, no plaintext on the wire; one record per browser; a record moved to another id fails', function () {
  var L, r1 = RC.newRid(), r2 = RC.newRid();
  assert(RC.validRid(r1) && r1 !== r2);
  return setup('poll', { q: 'Lunch?', opts: ['Pizza', 'Tacos'] }).then(function (x) {
    L = x;
    return Promise.all([write(L, r1, 'Ann', { pick: ['i0'] }, 1), write(L, r2, 'Bob', { pick: ['i1'] }, 2)]);
  }).then(function () {
    var wire = JSON.stringify(L.resp);
    ['Ann', 'Bob', '"pick"', 'Pizza'].forEach(function (s) { assert(wire.indexOf(s) < 0, 'plaintext on the wire: ' + s); });
    // the same browser votes again: its one record is replaced, not added
    return write(L, r1, 'Ann', { pick: ['i1'] }, 3);
  }).then(function () {
    return RC.decodeAll({ key: L.key, id: L.id, R: L.R, resp: L.resp, me: r1 });
  }).then(function (d) {
    assert.strictEqual(d.answers.length, 2);
    assert.deepStrictEqual(RC.tally(L.R, d).counts, { i0: 0, i1: 2 });
    assert(d.answers.filter(function (a) { return a.me; })[0].name === 'Ann');
    // someone copies Ann's ciphertext under a new id: it doesn't open (bound to its id)
    L.resp[RC.newRid()] = L.resp[r1];
    L.resp['bad id'] = L.resp[r1];
    return RC.decodeAll({ key: L.key, id: L.id, R: L.R, resp: L.resp });
  }).then(function (d) {
    assert.strictEqual(d.answers.length, 2);
    assert.strictEqual(d.bad, 1);
  });
});
test('hidden poll: a respondent can\'t read another\'s vote (link key or any key of their own); the owner can; reveal is counts only', function () {
  var L, ann = RC.newRid(), bob = RC.newRid(), cache = {};
  return setup('poll', { q: 'Boss?', opts: ['Yes', 'No'], vis: 'hidden' }, true).then(function (x) {
    L = x;
    assert(L.R.hidden && L.R.pub && !L.R.pub.d, 'only the public key is in the head');
    return Promise.all([write(L, ann, 'Ann', { pick: ['i0'] }, 1), write(L, bob, 'Bob', { pick: ['i1'] }, 2)]);
  }).then(function () {
    assert(typeof L.resp[ann].h === 'string' && !L.resp[ann].ct, 'sealed to the owner');
    // Bob, holding the link key, tries everything he has.
    var h = L.resp[ann].h;
    return Promise.all([
      rejects(C.open(L.key, L.id, 'r/' + ann, h), 'link key on a hidden record'),
      rejects(C.open(L.key, L.id, 'h/' + ann, 'h1' === h.slice(0, 2) ? '1.' + h.slice(3) : h), 'link key on the bytes'),
      RC.newOwnerKeys().then(function (mine) { return rejects(RC.hopen(mine.priv, L.id, ann, h), 'a key of his own'); }),
      rejects(RC.hopen(Object.assign({}, L.keys.pub, { d: L.keys.pub.x }), L.id, ann, h), 'a forged private key'),
      // the owner's key with the wrong record id / link id fails too (bound by AAD and HKDF info)
      rejects(RC.hopen(L.keys.priv, L.id, bob, h), 'wrong record id'),
      rejects(RC.hopen(L.keys.priv, C.newId(), ann, h), 'wrong link'),
      RC.decodeAll({ key: L.key, id: L.id, R: L.R, resp: L.resp, me: bob }).then(function (d) {
        assert.strictEqual(d.answers.length, 0, 'a respondent decodes nothing');
        assert.strictEqual(d.hidden, 2, 'just how many answered');
      })
    ]);
  }).then(function () {
    return RC.decodeAll({ key: L.key, id: L.id, R: L.R, resp: L.resp, priv: L.keys.priv, cache: cache });
  }).then(function (d) {
    var t = RC.tally(L.R, d);
    assert.deepStrictEqual(t.counts, { i0: 1, i1: 1 });
    assert.deepStrictEqual(t.names, { i0: ['Ann'], i1: ['Bob'] });
    assert(Object.keys(cache).length === 2);
    var agg = RC.aggregate(L.R, t);
    assert.strictEqual(JSON.stringify(agg).indexOf('Ann'), -1, 'no names in the reveal');
    return RC.sealReveal(L.key, L.id, agg, 5).then(function (s) { return RC.openReveal(L.key, L.id, s); });
  }).then(function (rv) {
    var t = RC.tally(L.R, { answers: [], agg: rv.agg });
    assert.deepStrictEqual(t.counts, { i0: 1, i1: 1 });
    assert.strictEqual(t.voters, 2);
    assert.strictEqual(t.fromAgg, true);
    assert.strictEqual(RC.summary(L.R, t), 'Poll · 2 votes · Yes & No tied');
  });
});
test('hidden dates and rsvp: same path; aggregates carry counts only', function () {
  var D, V;
  return setup('dates', { slots: [{ d: '2026-11-01' }, { d: '2026-11-02' }], vis: 'hidden' }, true).then(function (x) {
    D = x;
    return write(D, RC.newRid(), 'Ann', { s0: 'y', s1: 'm' }, 1);
  }).then(function () { return RC.decodeAll({ key: D.key, id: D.id, R: D.R, resp: D.resp, priv: D.keys.priv }); }).then(function (d) {
    var agg = RC.aggregate(D.R, RC.tally(D.R, d));
    assert.deepStrictEqual(agg, { voters: 1, slots: { s0: { y: 1, m: 0, n: 0 }, s1: { y: 0, m: 1, n: 0 } } });
    assert.deepStrictEqual(RC.tally(D.R, { answers: [], agg: agg }).best, ['s0']);
    return setup('rsvp', { q: 'Party', plus: 1, vis: 'after' });
  }).then(function (x) {
    V = x;
    assert.strictEqual(V.R.hidden, false);
    assert.strictEqual(RC.canSee(V.R, false, false), false);
    assert.strictEqual(RC.canSee(V.R, true, false), true);
    assert.strictEqual(RC.canSee(V.R, false, true), true, 'after closing');
  });
});
test('lists: per-item records sealed and bound to their item; names sealed', function () {
  var L, ann = RC.newRid(), bob = RC.newRid();
  return setup('packing', { items: ['Tent', 'Stove'] }).then(function (x) {
    L = x;
    return Promise.all([RC.sealName(L.key, L.id, ann, 'Ann'), RC.sealName(L.key, L.id, bob, 'Bob'),
      RC.sealItem(L.key, L.id, ann, 'i0', { q: 1 }, 100), RC.sealItem(L.key, L.id, bob, 'i0', { q: 1 }, 99)]);
  }).then(function (s) {
    L.resp[ann] = { n: s[0], i: { i0: s[2] } };
    L.resp[bob] = { n: s[1], i: { i0: s[3], i1: s[3] } };    // Bob's tent record copied to the stove: doesn't open
    assert(JSON.stringify(L.resp).indexOf('Ann') < 0);
    return RC.decodeAll({ key: L.key, id: L.id, R: L.R, resp: L.resp, me: ann });
  }).then(function (d) {
    assert.strictEqual(d.bad, 1);
    var t = RC.tally(L.R, d);
    assert.strictEqual(t.items[0].claims[0].name, 'Bob', 'earlier server time wins');
    assert.strictEqual(t.items[0].claims[1].me, true);
    assert.strictEqual(t.items[0].claims[1].got, 0, 'Ann is told she lost');
    assert.strictEqual(t.items[1].left, 1);
  });
});
test('closing and lifetime: accepting()', function () {
  var meta = { v: 4, expiresAt: NOW + 1000, respond: true, live: true };
  assert.strictEqual(RC.accepting({ meta: meta }, NOW), true);
  assert.strictEqual(RC.accepting({ meta: meta, closed: { at: 1 } }, NOW), false);
  assert.strictEqual(RC.accepting({ meta: meta }, NOW + 1000), false);
  assert.strictEqual(RC.accepting({ meta: meta, tomb: { why: 'revoked' } }, NOW), false);
  assert.strictEqual(RC.accepting({ meta: null }, NOW), false);
  assert.strictEqual(RC.fmtAgo(30000), 'just now');
  assert.strictEqual(RC.fmtAgo(5 * 60000), '5 min ago');
  assert.strictEqual(RC.fmtAgo(3 * 3600000), '3 h ago');
});

// ---- burn-core and the 'respond' mode ------------------------------------------------------------------------
test('burn-core: respond mode — slots like live links, never burned after reading, no owner engine; v3 readers fall back', function () {
  var meta = { v: 4, created: 1, expiresAt: 0, maxOpens: 2, oneTime: false, editable: false, live: true, respond: true };
  assert.strictEqual(C.modeOf(meta), 'respond');
  assert.strictEqual(C.staysLive(meta), true);
  assert.strictEqual(C.hasEngine(meta), false);
  assert.strictEqual(C.hasEngine({ live: true }), true);
  assert.strictEqual(C.modeWord(meta), 'responses');
  assert.strictEqual(C.burnsAfterRead(meta, { a: 1, b: 2 }), false);
  assert.strictEqual(C.viewOf(meta, C.readHead({ title: 'x', respond: { type: 'poll' } })), 'respond');
  assert.strictEqual(C.viewOf(meta, C.readHead({ title: 'x' })), 'read', 'no respond part in the head → the fallback text');
  // what v3 code makes of it: 'live' (slots kept), shown as a snapshot (head.live false)
  var v3 = function (m) { return !m ? 'read' : m.editable ? 'edit' : m.live ? 'live' : 'read'; };
  assert.strictEqual(v3(meta), 'live');
  assert.deepStrictEqual(C.gate({ meta: meta, claims: { a: 1, b: 2 } }, 5, 'a'), { ok: true, needClaim: false });
  assert.deepStrictEqual(C.gate({ meta: meta, claims: { a: 1, b: 2 } }, 5, 'c'), { ok: false, why: 'claimed' });
  var e = { v: 2, id: C.newId(), key: C.newKey(), db: 'https://x.firebaseio.com', created: 1, expiresAt: 0, maxOpens: 1, respond: true, rtype: 'poll', live: true, editable: true };
  var n = C.normBlob({ shares: [e] }).shares[0];
  assert.strictEqual(n.respond, true); assert.strictEqual(n.rtype, 'poll');
  assert.strictEqual(n.editable, false); assert.strictEqual(n.live, false);
  assert.strictEqual(C.modeOf(n), 'respond');
  assert.deepStrictEqual(C.sweepAction(n, { meta: meta, claims: { a: 1 } }, 10 * 60000), { act: 'keep' }, 'a full response link isn\'t destructed');
});

// ---- files / manifest ------------------------------------------------------------------------------------------
test('files exist; the respond module is never loaded at boot (only burn.js references it)', function () {
  ['burn-respond-core.js', 'burn-respond.js', 'burn-respond.css'].forEach(function (f) { assert(fs.existsSync(path.join(__dirname, f)), f); });
  var core = fs.readFileSync(path.join(__dirname, 'burn-respond-core.js'), 'utf8');
  assert(!/prefers-reduced-motion/.test(fs.readFileSync(path.join(__dirname, 'burn-respond.css'), 'utf8')));
  assert(!/document\.|window\.Cade/.test(core.replace(/\/\*[\s\S]*?\*\//g, '')), 'the core stays DOM-free');
});

Promise.all(pending).then(function () { console.log('burn-respond: ' + passed + ' passed'); });
