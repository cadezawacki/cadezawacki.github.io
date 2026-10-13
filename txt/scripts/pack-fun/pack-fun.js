/* Fun & Cipher Pack — Pig Latin, leetspeak, Morse, NATO phonetic, classic
   ciphers (Caesar, Vigenère, Atbash) and upside-down / mirrored text.
   Script-pack module: one file registering 11 palette scripts.

   Each script is written as real functions and serialised with Function#toString
   (see pack-text.js): the core evaluates every script in isolation, so reg()
   concatenates the helpers a script needs into that script's own source. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;

  function reg(meta, main, helpers) {
    var src = '/**\n' + JSON.stringify(meta, null, 2) + '\n**/\n' + String(main);
    for (var i = 0; helpers && i < helpers.length; i++) src += '\n\n' + String(helpers[i]);
    window.Cade.registerScript(src);
  }

  // ===================================================================
  // Pig Latin
  // ===================================================================
  var pigMain = function main(ctx) {
    var t = ctx.selection || ctx.fullText;
    var out = pigLatin(t);
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // Only whole words are rewritten, so punctuation/spacing stay put.
  // Apostrophes travel with the word: "don't" → "on'tday".
  function pigLatin(t) {
    return t.replace(/[A-Za-z]+(?:['’][A-Za-z]+)*/g, pigWord);
  }

  function pigWord(w) {
    var lo = w.toLowerCase(), i = 0;
    // Leading consonant cluster: "qu" sticks together, "y" counts as a vowel
    // once it isn't the first letter ("rhythm" → "ythmrhay").
    while (i < lo.length) {
      var c = lo.charAt(i);
      if ('aeiou'.indexOf(c) >= 0) { if (c === 'u' && i > 0 && lo.charAt(i - 1) === 'q') { i++; continue; } break; }
      if ((c === 'y' && i > 0) || c === "'" || c === '’') break;
      i++;
    }
    var out = i === 0 ? lo + 'way' : lo.slice(i) + lo.slice(0, i) + 'ay';
    if (w.length > 1 && w === w.toUpperCase()) return out.toUpperCase();          // HELLO → ELLOHAY
    if (w.charAt(0) !== lo.charAt(0)) return out.charAt(0).toUpperCase() + out.slice(1); // Hello → Ellohay
    return out;
  }

  reg({
    name: 'Pig Latin',
    description: 'Hello world → Ellohay orldway (keeps capitalization and punctuation)',
    author: 'Cade',
    icon: '🐷',
    tags: 'pig latin,piglatin,igpay,atinlay,language game,fun,kids,silly,encode,word game'
  }, pigMain, [pigLatin, pigWord]);

  // ===================================================================
  // Leetspeak
  // ===================================================================
  var leetMain = function main(ctx) {
    var t = ctx.selection || ctx.fullText;
    var out = leet(t);
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // Moderate substitution — stays readable (no |-|3|_|_0 ASCII art).
  function leet(t) {
    var M = { a: '4', b: '8', e: '3', g: '6', i: '1', l: '1', o: '0', s: '5', t: '7', z: '2' };
    return t.replace(/[abegilostz]/gi, function (c) { return M[c.toLowerCase()]; });
  }

  reg({
    name: 'Leetspeak',
    description: 'Leet speak → 1337 5p34k (a→4 e→3 i→1 o→0 s→5 t→7 …)',
    author: 'Cade',
    icon: '👾',
    tags: 'leet,leetspeak,1337,l33t,elite,hacker,gamer,numbers,fun,encode,internet'
  }, leetMain, [leet]);

  // ===================================================================
  // Morse Code
  // ===================================================================
  var morseMain = function main(ctx) {
    var t = ctx.selection || ctx.fullText;
    var stats = { skipped: 0 }, out;
    if (morseIsCode(t)) out = morseDecode(t);
    else {
      out = morseEncode(t, stats);
      if (stats.skipped) showToast(stats.skipped + ' character' + (stats.skipped === 1 ? '' : 's') + ' have no Morse code (skipped)', 'info', 3000);
    }
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  function morseTable() {
    return {
      A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..',
      J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
      S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
      '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
      '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
      '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.',
      '(': '-.--.', ')': '-.--.-', '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-',
      '+': '.-.-.', '-': '-....-', '_': '..--.-', '"': '.-..-.', '$': '...-..-', '@': '.--.-.'
    };
  }

  // Decode when the input is nothing but dots, dashes, slashes and whitespace
  // (· • and − – — accepted too, as pasted from web pages).
  function morseIsCode(t) {
    return /[.\-·•−–—]/.test(t) && /^[\s.\-\/·•−–—]+$/.test(t);
  }

  // Letters are separated by a space, words by " / "; lines stay lines.
  function morseEncode(t, stats) {
    var tbl = morseTable();
    return t.split('\n').map(function (line) {
      return line.split(/\s+/).filter(Boolean).map(function (word) {
        var plain = word.normalize('NFD').replace(/[\u0300-\u036F]/g, '')
          .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toUpperCase();
        return Array.from(plain).map(function (ch) {
          if (tbl[ch]) return tbl[ch];
          if (stats) stats.skipped++;
          return '';
        }).filter(Boolean).join(' ');
      }).filter(Boolean).join(' / ');
    }).join('\n');
  }

  function morseDecode(t) {
    var tbl = morseTable(), rev = {};
    Object.keys(tbl).forEach(function (k) { rev[tbl[k]] = k; });
    return t.split('\n').map(function (line) {
      line = line.replace(/[·•]/g, '.').replace(/[−–—]/g, '-').trim();
      if (!line) return '';
      // " / " is the usual word gap; 3+ spaces is the other common convention.
      return line.split(/\s*\/\s*|\s{3,}/).map(function (word) {
        return word.split(/\s+/).filter(Boolean).map(function (code) { return rev[code] || '?'; }).join('');
      }).join(' ');
    }).join('\n');
  }

  reg({
    name: 'Morse Code',
    description: 'Text → .- / -... Morse, or Morse → text (auto-detects which way)',
    author: 'Cade',
    icon: '📡',
    tags: 'morse,morse code,telegraph,dots,dashes,sos,radio,ham,encode,decode,translate,cw'
  }, morseMain, [morseTable, morseIsCode, morseEncode, morseDecode]);

  // ===================================================================
  // NATO Phonetic
  // ===================================================================
  var natoMain = function main(ctx) {
    var t = ctx.selection || ctx.fullText;
    var stats = { skipped: 0 };
    var out = natoIsCode(t) ? natoDecode(t) : natoEncode(t, stats);
    if (stats.skipped) showToast(stats.skipped + ' character' + (stats.skipped === 1 ? '' : 's') + ' skipped (no phonetic word)', 'info', 3000);
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // Official ICAO spellings (Alfa, Juliett, X-ray) for letters, plain number
  // words for digits; "Slash" stands in for "/" because " / " separates words.
  function natoWords() {
    var letters = ['Alfa', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India',
      'Juliett', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra',
      'Tango', 'Uniform', 'Victor', 'Whiskey', 'X-ray', 'Yankee', 'Zulu'];
    var digits = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    var enc = { '/': 'Slash' }, dec = { slash: '/' };
    letters.forEach(function (w, i) { var ch = String.fromCharCode(65 + i); enc[ch] = w; dec[w.toLowerCase()] = ch; });
    digits.forEach(function (w, i) { enc[String(i)] = w; dec[w.toLowerCase()] = String(i); });
    // Common variants when decoding (radio "niner", "tree", "fife", …).
    var alt = { alpha: 'A', juliet: 'J', xray: 'X', whisky: 'W', niner: '9', tree: '3', fower: '4', fife: '5', ait: '8', nought: '0' };
    Object.keys(alt).forEach(function (k) { dec[k] = alt[k]; });
    return { enc: enc, dec: dec };
  }

  // NATO when every token is a code word (or a lone punctuation mark that the
  // encoder passed through) and at least one is a real code word.
  function natoIsCode(t) {
    var dec = natoWords().dec, toks = t.split(/[\s\/]+/).filter(Boolean), words = 0;
    for (var i = 0; i < toks.length; i++) {
      if (dec[toks[i].toLowerCase()]) words++;
      else if (!/^[^A-Za-z0-9\s]$/.test(toks[i])) return false;
    }
    return words > 0;
  }

  // "Cade 42" → "Charlie Alfa Delta Echo / Four Two"; punctuation stays as-is.
  function natoEncode(t, stats) {
    var enc = natoWords().enc;
    return t.split('\n').map(function (line) {
      return line.split(/\s+/).filter(Boolean).map(function (word) {
        var plain = word.normalize('NFD').replace(/[\u0300-\u036F]/g, '').toUpperCase();
        return Array.from(plain).map(function (ch) {
          if (enc[ch]) return enc[ch];
          if (/^[!-~]$/.test(ch)) return ch;            // printable ASCII punctuation
          if (stats) stats.skipped++;
          return '';
        }).filter(Boolean).join(' ');
      }).filter(Boolean).join(' / ');
    }).join('\n');
  }

  function natoDecode(t) {
    var dec = natoWords().dec;
    return t.split('\n').map(function (line) {
      return line.split('/').map(function (word) {
        return word.split(/\s+/).filter(Boolean).map(function (tok) {
          var v = dec[tok.toLowerCase()];
          return v === undefined ? tok : v;
        }).join('');
      }).filter(Boolean).join(' ');
    }).join('\n');
  }

  reg({
    name: 'NATO Phonetic',
    description: 'Spell out text as Alfa Bravo Charlie…, or turn NATO words back into text (auto-detects)',
    author: 'Cade',
    icon: '📻',
    tags: 'nato,phonetic,alphabet,icao,spelling,alfa bravo,radio,military,pilot,spell out,call sign,encode,decode'
  }, natoMain, [natoWords, natoIsCode, natoEncode, natoDecode]);

  // ===================================================================
  // Caesar Cipher…
  // ===================================================================
  var caesarMain = function main(ctx) {
    var ans = prompt('Caesar shift (negative to decode):', '3');
    if (ans === null) return;
    var k = parseInt(ans, 10);
    if (isNaN(k)) { showToast('Enter a whole number shift, e.g. 3 or -3', 'error', 2500); return; }
    var t = ctx.selection || ctx.fullText;
    var out = caesar(t, k);
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  function caesar(t, k) {
    k = ((k % 26) + 26) % 26;
    return t.replace(/[A-Za-z]/g, function (c) {
      var b = c <= 'Z' ? 65 : 97;
      return String.fromCharCode((c.charCodeAt(0) - b + k) % 26 + b);
    });
  }

  reg({
    name: 'Caesar Cipher…',
    description: 'Shift letters by N (default 3, negative to decode) — keeps case, digits and punctuation',
    author: 'Cade',
    icon: '🏛\uFE0F',
    tags: 'caesar,cipher,shift,rot,rotate,encrypt,decrypt,encode,decode,secret,classic,crypto'
  }, caesarMain, [caesar]);

  // ===================================================================
  // Vigenère Encrypt… / Decrypt…
  // ===================================================================
  var vigEncMain = function main(ctx) {
    var key = prompt('Vigenère key (letters):', '');
    if (key === null) return;
    var t = ctx.selection || ctx.fullText;
    var out = vigenere(t, key, 1);
    if (out === null) { showToast('The key needs at least one letter A–Z', 'error', 2500); return; }
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  var vigDecMain = function main(ctx) {
    var key = prompt('Vigenère key (letters):', '');
    if (key === null) return;
    var t = ctx.selection || ctx.fullText;
    var out = vigenere(t, key, -1);
    if (out === null) { showToast('The key needs at least one letter A–Z', 'error', 2500); return; }
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // dir = 1 encrypts, -1 decrypts. Only letters consume key letters, so
  // spaces/punctuation don't throw the key out of step; case is preserved.
  function vigenere(t, key, dir) {
    var ks = String(key).toUpperCase().replace(/[^A-Z]/g, '');
    if (!ks) return null;
    var j = 0;
    return t.replace(/[A-Za-z]/g, function (c) {
      var b = c <= 'Z' ? 65 : 97, s = ks.charCodeAt(j++ % ks.length) - 65;
      return String.fromCharCode((c.charCodeAt(0) - b + dir * s + 26) % 26 + b);
    });
  }

  reg({
    name: 'Vigenère Encrypt…',
    description: 'Encrypt letters with a keyword (Vigenère cipher) — keeps case and punctuation',
    author: 'Cade',
    icon: '🔐',
    tags: 'vigenere,vigenère,cipher,encrypt,encode,key,keyword,polyalphabetic,secret,classic,crypto'
  }, vigEncMain, [vigenere]);

  reg({
    name: 'Vigenère Decrypt…',
    description: 'Decrypt Vigenère-ciphered text with its keyword',
    author: 'Cade',
    icon: '🔓',
    tags: 'vigenere,vigenère,cipher,decrypt,decode,key,keyword,polyalphabetic,secret,classic,crypto'
  }, vigDecMain, [vigenere]);

  // ===================================================================
  // Atbash
  // ===================================================================
  var atbashMain = function main(ctx) {
    var t = ctx.selection || ctx.fullText;
    var out = atbash(t);
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  function atbash(t) {
    return t.replace(/[A-Za-z]/g, function (c) {
      var b = c <= 'Z' ? 65 : 97;
      return String.fromCharCode(b + 25 - (c.charCodeAt(0) - b));
    });
  }

  reg({
    name: 'Atbash',
    description: 'Reverse the alphabet A↔Z, B↔Y… (run again to decode)',
    author: 'Cade',
    icon: '🔃',
    tags: 'atbash,cipher,reverse alphabet,hebrew,substitution,encrypt,decrypt,encode,decode,secret,classic'
  }, atbashMain, [atbash]);

  // ===================================================================
  // Upside Down Text
  // ===================================================================
  var flipMain = function main(ctx) {
    var t = ctx.selection || ctx.fullText;
    var out = flipText(t);
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // A 180° turn: map each glyph to its rotated look-alike and reverse the whole
  // string (line order too). The map is symmetric, so running it again restores.
  function flipText(t) {
    var M = flipMap(), chars = Array.from(t).reverse();
    for (var i = 0; i < chars.length; i++) if (M[chars[i]] !== undefined) chars[i] = M[chars[i]];
    return chars.join('');
  }

  function flipMap() {
    var pairs = [
      ['a', 'ɐ'], ['b', 'q'], ['c', 'ɔ'], ['d', 'p'], ['e', 'ǝ'], ['f', 'ɟ'], ['g', 'ƃ'], ['h', 'ɥ'],
      ['i', 'ᴉ'], ['j', 'ɾ'], ['k', 'ʞ'], ['l', 'ʃ'], ['m', 'ɯ'], ['n', 'u'], ['r', 'ɹ'], ['t', 'ʇ'],
      ['v', 'ʌ'], ['w', 'ʍ'], ['y', 'ʎ'],
      ['A', '∀'], ['B', 'ꓭ'], ['C', 'Ɔ'], ['D', 'ꓷ'], ['E', 'Ǝ'], ['F', 'Ⅎ'], ['G', '⅁'], ['J', 'ſ'],
      ['K', 'ꓘ'], ['L', '⅂'], ['M', 'W'], ['P', 'Ԁ'], ['Q', 'Ό'], ['R', 'ᴚ'], ['T', '⊥'], ['U', '∩'],
      ['V', 'Λ'], ['Y', '⅄'],
      ['1', 'Ɩ'], ['2', 'ᄅ'], ['3', 'Ɛ'], ['4', 'ㄣ'], ['5', 'ϛ'], ['6', '9'], ['7', 'ㄥ'],
      ['.', '˙'], [',', "'"], ['"', '„'], ['?', '¿'], ['!', '¡'], ['(', ')'], ['[', ']'], ['{', '}'],
      ['<', '>'], ['_', '‾'], ['&', '⅋'], [';', '؛'], ['‿', '⁀']
    ];
    var M = {};
    pairs.forEach(function (p) { M[p[0]] = p[1]; M[p[1]] = p[0]; });
    return M;
  }

  reg({
    name: 'Upside Down Text',
    description: 'Hello → oʃʃǝH — flip text 180° (run again to turn it back)',
    author: 'Cade',
    icon: '🙃',
    tags: 'upside down,flip,rotate,180,turn,australia,fun,silly,unicode,fancy,reverse,text art'
  }, flipMain, [flipText, flipMap]);

  // ===================================================================
  // Mirror Text
  // ===================================================================
  var mirrorMain = function main(ctx) {
    var t = ctx.selection || ctx.fullText;
    var out = mirrorText(t);
    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  };

  // Horizontal mirror: reverse each line (line order kept) and swap glyphs for
  // their reversed look-alikes where Unicode has one. Symmetric → self-inverse.
  function mirrorText(t) {
    var M = mirrorMap();
    return t.split('\n').map(function (line) {
      var chars = Array.from(line).reverse();
      for (var i = 0; i < chars.length; i++) if (M[chars[i]] !== undefined) chars[i] = M[chars[i]];
      return chars.join('');
    }).join('\n');
  }

  function mirrorMap() {
    var pairs = [
      ['(', ')'], ['[', ']'], ['{', '}'], ['<', '>'], ['/', '\\'], ['«', '»'], ['‹', '›'],
      ['?', '⸮'], [';', '⁏'],
      ['b', 'd'], ['p', 'q'], ['a', 'ɒ'], ['c', 'ɔ'], ['e', 'ɘ'], ['r', 'ɿ'], ['s', 'ƨ'], ['t', 'ƚ'],
      ['C', 'Ɔ'], ['D', 'ᗡ'], ['E', 'Ǝ'], ['F', 'ꟻ'], ['K', 'ꓘ'], ['L', '⅃'], ['N', 'И'], ['P', 'ꟼ'],
      ['R', 'Я'], ['S', 'Ƨ'], ['3', 'Ɛ']
    ];
    var M = {};
    pairs.forEach(function (p) { M[p[0]] = p[1]; M[p[1]] = p[0]; });
    return M;
  }

  reg({
    name: 'Mirror Text',
    description: 'Reverse each line with mirrored look-alike letters (ƚxɘT ɿoɿɿiM) — run again to undo',
    author: 'Cade',
    icon: '🪞',
    tags: 'mirror,reverse,backwards,flip,horizontal,da vinci,mirror writing,fun,unicode,fancy,text art'
  }, mirrorMain, [mirrorText, mirrorMap]);
})();
