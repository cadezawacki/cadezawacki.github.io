#!/usr/bin/env node
/* Builds wordladder-words.js for the Word Ladder widget.  Usage:
 *   node build-words.js [cache-dir]
 * Downloads its (pinned, openly licensed) sources into cache-dir on first run
 * (Node's fetch, falling back to curl, which honours HTTPS_PROXY) and writes
 * wordladder-words.js next to this script.
 *
 * For each length (3, 4, 5) three disjoint tiers, each a run of sorted words:
 *   core   — puzzle endpoints: SCOWL size <= 35 (english + american, via npm
 *            wordlist-english@1.2.1), also in word-list@4.1.0, not an
 *            inflection (plural / -ed of a known word), not on the drop list.
 *   common — the solver's graph adds these: SCOWL size <= 50 words (incl.
 *            inflections) that word-list also has. Par, hints and solutions
 *            only ever use core + common words.
 *   extra  — every other word in word-list@4.1.0 (MIT, the Letterpress list
 *            with common bad words removed): accepted as a rung, never shown.
 * Offensive / crude words are dropped from every tier.
 *
 * The daily puzzle is seeded from the date and picks from the SORTED core
 * list (see wordladder.js), so editing the lists reshuffles future dailies. */
'use strict';
var fs = require('fs');
var path = require('path');
var os = require('os');
var cp = require('child_process');

var HERE = __dirname;
var CACHE = process.argv[2] || path.join(os.tmpdir(), 'cade-wordladder-cache');
var SCOWL = 'https://cdn.jsdelivr.net/npm/wordlist-english@1.2.1/';
var WORDLIST = 'https://cdn.jsdelivr.net/npm/word-list@4.1.0/words.txt';
var SIZES = [10, 20, 35, 40, 50];
var CORE_MAX = 35, COMMON_MAX = 50;

// ROT13 so the source stays readable for everyone: offensive / crude / sensitive.
var DROP_ROT13 = 'nff phz sht tnl wrj gvg frk cbea cbeab nany nahf obbo obbof ohgg ohggf penc pbpx pbpxf phag phagf phzf ' +
  'qnza qvpx qvpxf qlxr qlxrf snt sntf shpx shpxf ubzb ubzbf wvfz wvmm xvxr xvxrf cvff encr encrq encrf frkl fuvg fuvgf ' +
  'fyhg fyhgf fcvp fcvpf gvgf gjng gjngf jnax jnaxf juber anmv anmvf ovgpu obbgl qvyqb ubeal cravf chffl fcrez frzra ' +
  'dhrre ovzob fchax chovp chorf ahqr ahqrf arteb tbbx tbbxf pbba pbbaf fcnm puvax jbc jbcf ubbxre fyhgf yhfg fynir ' +
  'ubeal grng grngf ovgpul arteb enpvfg';
// Plain drops: abbreviations, fragments and oddities that slip through.
var DROP_PLAIN = 'hes mys ifs ins mes dos ups ads yea tis etc ave cos nos ole ope sec';

function rot13(s) { return s.replace(/[a-z]/g, function (c) { return String.fromCharCode((c.charCodeAt(0) - 84) % 26 + 97); }); }
function list(s) { return s.split(/\s+/).filter(Boolean); }

async function get(url) {
  var file = path.join(CACHE, url.replace(/[^a-z0-9.]+/gi, '_'));
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  var text;
  try {
    var res = await fetch(url);
    if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
    text = await res.text();
  } catch (e) {
    text = cp.execFileSync('curl', ['-sSfL', url], { encoding: 'utf8', maxBuffer: 1 << 28 });
  }
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  return text;
}

async function main() {
  var tier = {}; // word -> smallest SCOWL size containing it
  for (var i = 0; i < SIZES.length; i++) {
    for (var v of ['english', 'american']) {
      JSON.parse(await get(SCOWL + v + '-words-' + SIZES[i] + '.json')).forEach(function (w) {
        if (/^[a-z]+$/.test(w) && !(w in tier)) tier[w] = SIZES[i];
      });
    }
  }
  var wl = (await get(WORDLIST)).split('\n').filter(function (w) { return /^[a-z]+$/.test(w); });
  var wlSet = new Set(wl);
  var known = function (w) { return w in tier || wlSet.has(w); };
  function inflected(w) {
    if (/ss$/.test(w)) return false;
    if (/s$/.test(w)) {
      if (known(w.slice(0, -1))) return true;
      if (/es$/.test(w) && known(w.slice(0, -2))) return true;
      if (/ies$/.test(w) && known(w.slice(0, -3) + 'y')) return true;
    }
    if (/ed$/.test(w)) {
      if (known(w.slice(0, -2)) || known(w.slice(0, -1))) return true;
      if (/ied$/.test(w) && known(w.slice(0, -3) + 'y')) return true;
      if (/(.)\1ed$/.test(w) && known(w.slice(0, -3))) return true;
    }
    return false;
  }
  var drop = new Set(list(rot13(DROP_ROT13)).concat(list(DROP_PLAIN)));
  var out = {}, total = 0, lines = [];
  for (var L = 3; L <= 5; L++) {
    var core = [], common = [], extra = [];
    var all = new Set(wl.filter(function (w) { return w.length === L; }));
    Array.from(all).sort().forEach(function (w) {
      if (drop.has(w)) return;
      var t = tier[w];
      if (t && t <= CORE_MAX && !inflected(w)) core.push(w);
      else if (t && t <= COMMON_MAX) common.push(w);
      else extra.push(w);
    });
    out[L] = { core: core.join(''), common: common.join(''), extra: extra.join('') };
    total += core.length + common.length + extra.length;
    lines.push('   ' + L + ' letters: core ' + core.length + ', common ' + common.length + ', extra ' + extra.length);
    console.log(L, 'core', core.length, 'common', common.length, 'extra', extra.length);
  }
  var js = '/* Generated by build-words.js — do not edit by hand.\n' +
    '   Word lists for the Word Ladder widget, per length: core (puzzle ends), common (the\n' +
    '   solver adds these) and extra (accepted rungs), each a run of concatenated sorted words.\n' +
    lines.join('\n') + '\n' +
    '   Tiers derive from SCOWL (wordlist-english@1.2.1); the valid set is word-list@4.1.0\n' +
    '   (MIT, Sindre Sorhus; from the atebits/Words list).\n\n' +
    '   SCOWL: Copyright 2000-2016 by Kevin Atkinson\n' +
    '   Permission to use, copy, modify, distribute and sell these word lists, the associated scripts, the\n' +
    '   output created from the scripts, and its documentation for any purpose is hereby granted without fee,\n' +
    '   provided that the above copyright notice appears in all copies and that both that copyright notice\n' +
    '   and this permission notice appear in supporting documentation. Kevin Atkinson makes no representations\n' +
    '   about the suitability of this array for any purpose. It is provided "as is" without express or implied\n' +
    '   warranty. */\n' +
    '(function (D) {\n' +
    '  if (typeof window !== \'undefined\') window.__cadeWordLadderWords = D;\n' +
    '  if (typeof module !== \'undefined\' && module.exports) module.exports = D;\n' +
    '})({\n' +
    [3, 4, 5].map(function (n) {
      return n + ': {\n core: "' + out[n].core + '",\n common: "' + out[n].common + '",\n extra: "' + out[n].extra + '"\n}';
    }).join(',\n') + '\n});\n';
  fs.writeFileSync(path.join(HERE, 'wordladder-words.js'), js);
  console.log('total', total, 'bytes', js.length);
}

main().catch(function (e) { console.error(e); process.exit(1); });
