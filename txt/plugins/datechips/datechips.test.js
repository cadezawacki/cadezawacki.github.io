/* Checks for the Natural date chips parser (window.__cadeDateParse in
 * datechips.js): the phrasings it reads, and ordinary sentences that must get
 * no chip. Also records why the compromise-dates library is NOT used here
 * (see the comparison in the header of datechips.js). Not loaded by the app.
 * Run: node txt/plugins/datechips/datechips.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

var win = { Cade: {} };   // no Cade.CM: the file stops after exposing the parser
new Function('window', 'navigator', fs.readFileSync(path.join(__dirname, 'datechips.js'), 'utf8'))(win, { language: 'en-US', languages: ['en-US'] });
var parse = win.__cadeDateParse;
var NOW = new Date(2026, 9, 21, 10, 0);            // Wednesday 21 Oct 2026, 10:00
function chips(s) {
  return parse(s, NOW).map(function (c) {
    return s.slice(c.from, c.to) + ' = ' + c.y + '-' + (c.mo < 9 ? '0' : '') + (c.mo + 1) + '-' + (c.d < 10 ? '0' : '') + c.d +
      (c.time ? ' ' + (c.time.h < 10 ? '0' : '') + c.time.h + ':' + (c.time.mi < 10 ? '0' : '') + c.time.mi : '');
  });
}

var READS = [
  ['next Tuesday at 5', 'next Tuesday at 5 = 2026-10-27 17:00'],
  ['in 3 weeks', 'in 3 weeks = 2026-11-11'],
  ['the 2nd of March', 'the 2nd of March = 2027-03-02'],
  ['tomorrow at 3pm', 'tomorrow at 3pm = 2026-10-22 15:00'],
  ['tomorrow morning', 'tomorrow morning = 2026-10-22 09:00'],
  ['5pm on Thursday', '5pm on Thursday = 2026-10-22 17:00'],
  ['Friday at noon', 'Friday at noon = 2026-10-23 12:00'],
  ['end of next week', 'end of next week = 2026-10-30'],
  ['three days from now', 'three days from now = 2026-10-24'],
  ['a year ago', 'a year ago = 2025-10-21'],
  ['Oct 20', 'Oct 20 = 2026-10-20'],
  ['2026-10-20 14:30', '2026-10-20 14:30 = 2026-10-20 14:30'],
  ['Mark worked on Monday.', 'Monday = 2026-10-26'],
  ['See you next Fri. then', 'next Fri. = 2026-10-30']
];
READS.forEach(function (c) {
  test('reads "' + c[0] + '"', function () { assert.deepStrictEqual(chips(c[0]), [c[1]]); });
});
// Sentences that compromise-dates turns into dates (measured on 14.18 / 3.9: "a minute",
// "The fall", "Spring", "Christmas", "A day", "Every day", "a few days", "in May.") — no chip here.
var PLAIN = ['I may go if you march with me.', 'Wait a minute.', 'The fall was steep.', 'I need a few days off.', 'Spring water is nice.',
  'He is a Christmas tree farmer.', 'A day in the life.', 'She was born in May.', 'Every day I walk.', 'Give me a second.',
  'The sun is out.', 'She will sue them.', 'We met at 5 or so.', 'At last we won.', 'Room 101 is closed.', 'Score was 3-1.',
  'Mix 1/2 cup of flour.', 'Open 24/7.', 'Version 2.10/20 is out.'];
PLAIN.forEach(function (s) {
  test('no chip: "' + s + '"', function () { assert.deepStrictEqual(chips(s), []); });
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'datechips: ' + passed + ' passed');
