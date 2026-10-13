#!/usr/bin/env node
/* Builds wordle-words.js for the Word Guess widget.  Usage:
 *   node build-words.js [cache-dir]
 * Downloads its (pinned, openly licensed) sources into cache-dir on first run
 * and writes wordle-words.js next to this script.
 *
 * ANSWERS = common five-letter words: SCOWL size <= 40 (english + american
 * spellings, via npm wordlist-english@1.2.1), minus inflections (plurals,
 * -ed forms whose base is a word), minus a curated drop list (offensive,
 * crude, sensitive, slangy or odd comparatives), plus a hand-picked set of
 * well-known size-50 words. ~2,300 words.
 * GUESSES = every five-letter word in npm word-list@4.1.0 (MIT, the Letterpress
 * list with common bad words already removed) + all answers + a few modern
 * words from SCOWL size <= 70. ~12,700 words.
 *
 * The daily puzzle is a seeded shuffle of the SORTED answer list (see
 * wordle.js), so editing the answer list reshuffles the daily schedule —
 * do it rarely, and never mid-day if you can help it. */
'use strict';
var fs = require('fs');
var path = require('path');
var os = require('os');

var HERE = __dirname;
var CACHE = process.argv[2] || path.join(os.tmpdir(), 'cade-wordle-cache');
var SCOWL = 'https://cdn.jsdelivr.net/npm/wordlist-english@1.2.1/';
var WORDLIST = 'https://cdn.jsdelivr.net/npm/word-list@4.1.0/words.txt';
var SIZES = [10, 20, 35, 40, 50, 55, 60, 70];
var ANSWER_MAX_SIZE = 40;

// Dropped from ANSWERS (still valid guesses where the guess list has them).
// ROT13 so the source stays readable for everyone: offensive / crude / sensitive.
var DROP_ROT13 = 'ovgpu obbol obfbz puvax rarzn rerpg sntbg snaal tebcr ubeal xvaxl yhfgl ylapu ahqre cnafl ' +
  'cevpx chovp chffl dhrre frzra fvffl fynir fcrez fchax juber ovzob tlcfl cltzl jryfu obbgl fcnax onjql srpny ' +
  'srprf hevar hgrev objry vqvbg zbeba ybbal borfr yrcre srghf';
// Plain drops: contractions, fragments, proper-noun lookalikes, odd comparatives.
var DROP_PLAIN = 'dunno gimme gonna gotta kinda lemme sorta wanna multi dimer halon haler weest rifer coyer ' +
  'apter abler direr huger laxer lamer liker muter rawer sager shyer slier wryer icier viler sorer fiver maria ' +
  'roman bible mecca peter fiche unsay unman genii edger sizer awing cuing infix tonne';
// Well-known words from SCOWL size 50 promoted to answers.
var ADD = 'abuzz achoo adieu agate alder amigo amino anime anode aphid argon assay aster atoll avian balsa ' +
  'batik bling bobby bogey borax boron cabal cairn canto chomp cilia codex combo conch conga conic copse coupe ' +
  'coven cubit cumin cupid curie cushy deuce dingo diode divan divot divvy dowel druid dryad duchy dweeb egret ' +
  'emoji epoxy ennui faker femur feral fixer flume flyby folio fryer fugue futon gecko geode glyph grail grout ' +
  'guava haiku harpy helix henna hydra idyll inbox ingot inset islet joist joule joust kazoo kebab knave latte ' +
  'lemur lipid login macaw magma mambo manga manna medic mocha mogul nacho nadir nexus ninja octet offal opine ' +
  'orate oxbow parry pilaf pinto piper quasi rebus refit rover rumba rupee sable salvo samba scone scuba sedge ' +
  'segue sepia sitar skiff sloop sonar spiky spiny squab steed stein tapir taupe teary titan tithe toner torte ' +
  'triad trope truss tryst tuber tulle whelp whiny xenon yucca zilch zippy';
// Modern / common words SCOWL has but word-list lacks; accepted as guesses.
var EXTRA_GUESSES = 'emoji regex popup nimby outta muzak versa vaped vapes pwned reorg phish anons bueno ciaos vedic';

function rot13(s) { return s.replace(/[a-z]/g, function (c) { return String.fromCharCode((c.charCodeAt(0) - 84) % 26 + 97); }); }
function list(s) { return s.split(/\s+/).filter(Boolean); }

async function get(url) {
  var file = path.join(CACHE, url.replace(/[^a-z0-9.]+/gi, '_'));
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  var res = await fetch(url);
  if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
  var text = await res.text();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  return text;
}

async function main() {
  var tier = {}; // word -> smallest SCOWL size containing it
  for (var i = 0; i < SIZES.length; i++) {
    var n = SIZES[i];
    for (var v of ['english', 'american']) {
      JSON.parse(await get(SCOWL + v + '-words-' + n + '.json')).forEach(function (w) {
        if (/^[a-z]+$/.test(w) && !(w in tier)) tier[w] = n;
      });
    }
  }
  var wl = (await get(WORDLIST)).split('\n').filter(function (w) { return /^[a-z]+$/.test(w); });
  var wlSet = new Set(wl);
  var known = function (w) { return w in tier || wlSet.has(w); };

  // Plurals / third-person / past tense of a word we know are not answers.
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
  var answers = new Set();
  Object.keys(tier).forEach(function (w) {
    if (w.length === 5 && tier[w] <= ANSWER_MAX_SIZE && !inflected(w) && !drop.has(w)) answers.add(w);
  });
  list(ADD).forEach(function (w) {
    if (w.length !== 5 || !(w in tier)) throw new Error('ADD word not in SCOWL: ' + w);
    if (drop.has(w)) throw new Error('ADD word is dropped: ' + w);
    answers.add(w);
  });
  var ans = Array.from(answers).sort();

  var guessSet = new Set(wl.filter(function (w) { return w.length === 5; }));
  list(EXTRA_GUESSES).forEach(function (w) { if (w.length === 5) guessSet.add(w); });
  ans.forEach(function (w) { guessSet.delete(w); }); // stored once, in answers
  var guesses = Array.from(guessSet).sort();

  var out = '/* Generated by build-words.js — do not edit by hand.\n' +
    '   Word lists for the Word Guess widget: answers (' + ans.length + ') and extra valid guesses (' + guesses.length + '),\n' +
    '   each a run of concatenated, sorted five-letter words.\n' +
    '   Answers derive from SCOWL (wordlist-english@1.2.1). Guesses add word-list@4.1.0 (MIT, Sindre Sorhus;\n' +
    '   from the atebits/Words list).\n\n' +
    '   SCOWL: Copyright 2000-2016 by Kevin Atkinson\n' +
    '   Permission to use, copy, modify, distribute and sell these word lists, the associated scripts, the\n' +
    '   output created from the scripts, and its documentation for any purpose is hereby granted without fee,\n' +
    '   provided that the above copyright notice appears in all copies and that both that copyright notice\n' +
    '   and this permission notice appear in supporting documentation. Kevin Atkinson makes no representations\n' +
    '   about the suitability of this array for any purpose. It is provided "as is" without express or implied\n' +
    '   warranty. */\n' +
    'window.__cadeWordleWords = {\n' +
    'answers: "' + ans.join('') + '",\n' +
    'guesses: "' + guesses.join('') + '"\n' +
    '};\n';
  fs.writeFileSync(path.join(HERE, 'wordle-words.js'), out);
  console.log('answers', ans.length, 'guesses', guesses.length, 'total', ans.length + guesses.length, 'bytes', out.length);
}

main().catch(function (e) { console.error(e); process.exit(1); });
