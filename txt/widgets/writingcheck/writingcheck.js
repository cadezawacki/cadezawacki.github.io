/* Writing Check — readability scores and weak-writing flags for Cade.txt.
 * Analyses the selection when there is one, else the whole note; live and
 * debounced (idle-time work, capped on very large notes).
 *  - Readability: Flesch Reading Ease, Flesch–Kincaid grade, Gunning Fog,
 *    Coleman–Liau, SMOG (30+ sentences), ARI, a plain-English verdict,
 *    words / sentences / syllables, reading + speaking time.
 *  - Flags: long and hard sentences, passive voice, adverbs, filler and
 *    hedges, clichés, repeated words, complex words with simpler options.
 *    A click selects the text in the editor. Kinds toggle on / off and can be
 *    highlighted in the editor (a CodeMirror decoration field).
 * Markdown is stripped before counting (code, URLs, markers) with an offset
 * map so every flag points at the right place in the original note.
 * Prefs: Cade.store cade-writingcheck-*. Pure part is unit-checked in node:
 * node txt/widgets/writingcheck/writingcheck.test.js */
(function () {
  'use strict';

  // ================= pure analysis (node-testable) =================
  var MAX_CHARS = 200000;          // analyse at most this much of a note
  var MAX_FLAGS_PER_KIND = 400;

  function setOf(s) { var o = Object.create(null); s.split(/[,|]/).forEach(function (w) { w = w.trim(); if (w) o[w] = 1; }); return o; }
  function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // ---------- Markdown → plain text with an offset map ----------
  // Returns { text, map } where map[i] is the index in the source of text[i]
  // (map has one extra trailing entry: the source length). Hard breaks (block
  // boundaries) are emitted as "\n\n"; soft line breaks inside a paragraph as
  // "\n". `headings` lists [start, end) ranges of headings and table cells in
  // `text` — kept for the flags, left out of the readability counts.
  var WORDCH = /[A-Za-z0-9À-ɏ]/;
  function stripMarkdown(src) {
    src = String(src == null ? '' : src);
    var out = [], map = [], headings = [];
    var n = src.length;
    function emit(ch, at) { out.push(ch); map.push(at); }
    function hardBreak(at) {
      var L = out.length;
      if (!L) return;
      if (out[L - 1] === '\n' && L > 1 && out[L - 2] === '\n') return;
      if (out[L - 1] === '\n') { emit('\n', at); return; }
      emit('\n', at); emit('\n', at);
    }
    var URL_RE = /(?:https?:\/\/|ftp:\/\/|mailto:|www\.)[^\s<>()\[\]]*(?:\([^\s()]*\)[^\s<>()\[\]]*)*/y;
    var TAG_RE = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/y;
    var AUTOLINK_RE = /<(?:https?:|mailto:|ftp:)[^<>\s]*>/y;
    // find the ] that closes a [ at i (one level of nesting), within [i, end)
    function closeBracket(i, end) {
      var depth = 0;
      for (var k = i; k < end; k++) {
        var c = src[k];
        if (c === '\\') { k++; continue; }
        if (c === '[') depth++;
        else if (c === ']') { depth--; if (!depth) return k; }
      }
      return -1;
    }
    function closeParen(i, end) {   // i at '('
      var depth = 0;
      for (var k = i; k < end; k++) {
        var c = src[k];
        if (c === '\\') { k++; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (!depth) return k; }
      }
      return -1;
    }
    function inline(i, end) {
      while (i < end) {
        var c = src[i];
        if (c === '\\' && i + 1 < end && /[!-\/:-@\[-`{-~]/.test(src[i + 1])) { emit(src[i + 1], i + 1); i += 2; continue; }
        if (c === '`') {
          var r = i; while (r < end && src[r] === '`') r++;
          var tick = src.slice(i, r), close = src.indexOf(tick, r);
          if (close !== -1 && close < end) { i = close + tick.length; continue; }
          i = r; continue;
        }
        if (c === '!' && src[i + 1] === '[') {
          var cb = closeBracket(i + 1, end);
          if (cb !== -1 && src[cb + 1] === '(') { var cp = closeParen(cb + 1, end); if (cp !== -1) { i = cp + 1; continue; } }
          if (cb !== -1 && src[cb + 1] === '[') { var cr = src.indexOf(']', cb + 2); if (cr !== -1 && cr < end) { i = cr + 1; continue; } }
          i++; continue;
        }
        if (c === '[') {
          if (src[i + 1] === '[') {          // [[wiki link|alias]]
            var ww = src.indexOf(']]', i + 2);
            if (ww !== -1 && ww < end) {
              var bar = src.indexOf('|', i + 2), s0 = (bar !== -1 && bar < ww) ? bar + 1 : i + 2;
              inline(s0, ww); i = ww + 2; continue;
            }
          }
          if (src[i + 1] === '^') {          // footnote ref
            var fe = src.indexOf(']', i);
            if (fe !== -1 && fe < end) { i = fe + 1; continue; }
          }
          var b = closeBracket(i, end);
          if (b !== -1) {
            if (src[b + 1] === '(') {
              var p = closeParen(b + 1, end);
              if (p !== -1) { inline(i + 1, b); i = p + 1; continue; }
            } else if (src[b + 1] === '[') {
              var q = src.indexOf(']', b + 2);
              if (q !== -1 && q < end) { inline(i + 1, b); i = q + 1; continue; }
            }
            // a task box "[ ]" / "[x]" mid-line, or plain brackets
            if (/^\[[ xX]\]$/.test(src.slice(i, b + 1))) { i = b + 1; continue; }
          }
          i++; continue;
        }
        if (c === ']') { i++; continue; }
        if (c === '<') {
          AUTOLINK_RE.lastIndex = i;
          var am = AUTOLINK_RE.exec(src);
          if (am && i + am[0].length <= end) { i += am[0].length; continue; }
          TAG_RE.lastIndex = i;
          var tm = TAG_RE.exec(src);
          if (tm && i + tm[0].length <= end) { i += tm[0].length; continue; }
        }
        if ((c === 'h' || c === 'f' || c === 'm' || c === 'w') && (i === 0 || !WORDCH.test(src[i - 1]))) {
          URL_RE.lastIndex = i;
          var um = URL_RE.exec(src);
          if (um && um[0].length > 4) {
            var ue = Math.min(end, i + um[0].length);
            while (ue > i && /[.,;:!?'"]/.test(src[ue - 1])) ue--;   // trailing sentence punctuation stays
            i = ue; continue;
          }
        }
        if (c === '*' || c === '~') { i++; continue; }
        if (c === '=' && src[i + 1] === '=') { i += 2; continue; }
        if (c === '_') {
          var pw = i > 0 && WORDCH.test(src[i - 1]), nw = i + 1 < end && WORDCH.test(src[i + 1]);
          if (!(pw && nw)) { i++; continue; }
        }
        if (c === '\r' || c === '\t') { emit(' ', i); i++; continue; }
        emit(c, i); i++;
      }
    }
    var pos = 0, fence = null;
    while (pos <= n) {
      var le = src.indexOf('\n', pos); if (le === -1) le = n;
      var line = src.slice(pos, le);
      if (fence) {
        var fc = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
        if (fc && fc[1][0] === fence[0] && fc[1].length >= fence.length) fence = null;
        hardBreak(le);
      } else {
        var fo = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (fo) { fence = fo[1]; hardBreak(pos); }
        else if (/^\s*$/.test(line) ||
          /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) ||           // thematic break
          /^\s{0,3}=+\s*$/.test(line) ||                           // setext underline
          /^\s{0,3}\[[^\]]+\]:\s*\S/.test(line) ||                 // reference definition
          /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) || // table separator
          /^\s{0,3}(\$\$|<!--|-->)\s*$/.test(line)) {
          hardBreak(le);
        } else {
          var i = pos, end = le, m;
          m = /^(?:\s*>)+\s?/.exec(line);
          if (m) { i += m[0].length; hardBreak(pos); }
          var rest = src.slice(i, end);
          var block = false, heading = false;
          if ((m = /^\s{0,3}(#{1,6})(\s+|$)/.exec(rest))) {
            heading = block = true; i += m[0].length;
            var tr = /\s+#+\s*$/.exec(src.slice(i, end)); if (tr) end -= tr[0].length;
          } else if ((m = /^\s*(?:[-*+•]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/.exec(rest))) {
            block = true; i += m[0].length;
          }
          var table = !heading && /\|/.test(rest) && /^\s*\|/.test(rest);
          if (block || table) hardBreak(pos);
          var hs = out.length;
          if (table) {
            var cells = src.slice(i, end).split('|'), off = i;
            cells.forEach(function (cell) {
              if (cell.trim()) { var c0 = out.length; inline(off, off + cell.length); headings.push([c0, out.length]); hardBreak(off + cell.length); }
              off += cell.length + 1;
            });
          } else {
            inline(i, end);
          }
          if (heading) { headings.push([hs, out.length]); hardBreak(le); }
          else if (table) hardBreak(le);
          else if (le < n) emit('\n', le);
        }
      }
      pos = le + 1;
      if (le >= n) break;
    }
    map.push(n);
    return { text: out.join(''), map: map, headings: headings };
  }
  // A clean-text range → [from, to) in the source.
  function mapRange(map, cs, ce) {
    if (ce <= cs) return [map[cs], map[cs]];
    return [map[cs], map[ce - 1] + 1];
  }

  // ---------- syllables ----------
  var SYL_EXC = {
    people: 2, create: 2, created: 3, creates: 2, creating: 3, creation: 3, creative: 3, idea: 3, ideas: 3, area: 3, areas: 3,
    business: 2, every: 3, science: 2, quiet: 2, poem: 2, poet: 2, being: 2, doing: 2, going: 2, seeing: 2, lion: 2,
    real: 1, really: 2, react: 2, reality: 4, theatre: 3, theater: 3, cafe: 2, recipe: 3, apostrophe: 4, simile: 3,
    hyperbole: 4, epitome: 4, coyote: 3, naive: 2, fire: 1, hour: 1, rhythm: 2, rhythms: 2, our: 1, family: 3, chocolate: 3, different: 3,
    evening: 2, interesting: 4, camera: 3, beautiful: 3, everything: 3, everyone: 3, somewhere: 2, sometimes: 2,
    something: 2, someone: 2, therefore: 2, whereas: 2, wednesday: 2, ocean: 2, ancient: 2, special: 2, social: 2,
    patient: 2, ratio: 3, video: 3, radio: 3, usual: 3, actual: 3, actually: 4, gradual: 3,
    annual: 3, quality: 4, guarantee: 3, queue: 1, fuel: 2, cruel: 2, jewel: 2, towel: 2, violence: 3, diet: 2,
    client: 2, giant: 2, via: 2, trial: 2, dial: 2, denial: 3, period: 3, serious: 3, various: 3,
    previous: 3, obvious: 3, genius: 2, prior: 2, the: 1, are: 1, were: 1, one: 1, once: 1, none: 1,
    done: 1, gone: 1, come: 1, some: 1, have: 1, give: 1, live: 1, love: 1, move: 1, lose: 1, whose: 1, there: 1,
    where: 1, here: 1, whole: 1, while: 1, smile: 1, little: 2, able: 2, table: 2, simple: 2, single: 2, middle: 2,
    eye: 1, eyes: 1, aisle: 1, isle: 1, says: 1, said: 1, does: 1, goes: 1, shoes: 1, toes: 1, users: 2, use: 1, uses: 2,
    used: 1, user: 2, useful: 2, also: 2, maybe: 2, anyone: 3, anything: 3, everybody: 4, somebody: 3, nobody: 3,
    hello: 2, okay: 2, ok: 2, naturally: 4, literally: 4, generally: 4, probably: 3, basically: 3, definitely: 4,
    utilize: 3, utilizes: 4, utilized: 3, facilitate: 4, approximately: 5, purchase: 2, purchased: 2, purchases: 3,
    sentence: 2, sentences: 3, readable: 3, readability: 5, syllable: 3, syllables: 3, minute: 2, minutes: 2,
    paragraph: 3, paragraphs: 3, note: 1, notes: 1, wrote: 1, write: 1, written: 2, writes: 1, writing: 2
  };
  function syllables(word) {
    var w = String(word).toLowerCase().replace(/[’']/g, "'").replace(/'s$/, '').replace(/[^a-z]/g, '');
    if (!w) return /\d/.test(word) ? Math.max(1, String(word).replace(/\D/g, '').length > 2 ? 2 : 1) : 0;
    if (SYL_EXC[w]) return SYL_EXC[w];
    if (w.length <= 3) return 1;
    var extra = 0, s = w;
    if (/[^aeiouy]le$/.test(s)) { extra = 1; s = s.slice(0, -2); }
    else if (/[^aeiouy]les$/.test(s)) { extra = 1; s = s.slice(0, -3); }
    else if (/[^aeiou]ed$/.test(s) && !/[td]ed$/.test(s)) s = s.slice(0, -2);
    else if (/[^aeiouszxhgc]es$/.test(s) || /[^aeioucs]hes$/.test(s)) s = s.slice(0, -2);
    else if (/[^aeioy]e$/.test(s) || /[^aeiouy]ye$/.test(s)) s = s.slice(0, -1);
    // a silent "magic e" before a suffix: careful(ly), lonely, statement, homeless
    s = s.replace(/([aeiouy][^aeiouy]{1,2})e(ful|fully|ly|ment|ments|less|ness)$/, '$1$2');
    s = s.replace(/^y/, 'x');                       // initial y is a consonant
    var groups = s.match(/[aeiouy]+/g);
    var c = groups ? groups.length : 0;
    // vowel pairs that are two syllables
    if (/[aeiou]y[aeiou]/.test(s)) c++;             // player, buying
    if (/[^ct]ia/.test(s) || /^ia/.test(s)) c++;   // piano, Indian (not social/initial)
    if (/[^tsc]io/.test(s) && !/[^tsc]ious/.test(s)) c++;   // radio, violin (not nation)
    if (/[^tc]iou/.test(s)) c++;                   // various, serious (not precious)
    if (/eo/.test(s) && !/eou/.test(s)) c++;       // video, theory
    if (/[^qg]ua/.test(s)) c++;                    // usual, actual (not quality)
    if (/[^qg]uo/.test(s)) c++;
    if (/ii/.test(s)) c++;
    if (/iet/.test(s)) c++;                         // quiet, society
    if (/[aeiouy]ing$/.test(s) && !/[aeiou]ying$/.test(s) && s.length > 4) c++; // seeing, flying (playing counted above)
    if (/tiat/.test(s)) c++;                        // initiate, negotiate
    if (/i(er|est|ers)$/.test(s) && /[^aeiou]i(er|est|ers)$/.test(s)) c++; // happier
    if (/ism$/.test(s)) c++;
    if (/^mc/.test(s)) c++;
    c += extra;
    return Math.max(1, c);
  }

  // ---------- tokenising ----------
  var WORD_RE = /[A-Za-z0-9À-ɏ]+(?:['’][A-Za-zÀ-ɏ]+)*(?:-[A-Za-z0-9À-ɏ]+)*/g;
  var ABBR = setOf('mr,mrs,ms,dr,prof,sr,jr,st,vs,etc,e.g,i.e,eg,ie,inc,ltd,co,corp,dept,est,fig,no,vol,approx,cf,al,mt,ft,jan,feb,mar,apr,jun,jul,aug,sep,sept,oct,nov,dec,ca,gen,gov,sen,rep,lt,col,capt,sgt');
  function wordInfo(t, s) {
    var parts = t.split('-'), syl = 0, letters = 0;
    for (var k = 0; k < parts.length; k++) syl += parts[k] ? syllables(parts[k]) : 0;
    for (var j = 0; j < t.length; j++) if (/[A-Za-z0-9À-ɏ]/.test(t[j])) letters++;
    return { s: s, e: s + t.length, t: t, lw: t.toLowerCase().replace(/’/g, "'"), syl: Math.max(1, syl), letters: letters };
  }
  // Split clean text into sentences: { cs, ce, words, heading }.
  function sentences(clean, headings) {
    headings = headings || [];
    var out = [], hi = 0, blockStarts = [];
    var re = /\n{2,}/g, m, last = 0;
    while ((m = re.exec(clean))) { blockStarts.push([last, m.index]); last = m.index + m[0].length; }
    blockStarts.push([last, clean.length]);
    blockStarts.forEach(function (bk) {
      var bs = bk[0], be = bk[1];
      var seg = clean.slice(bs, be);
      var words = [], wm;
      WORD_RE.lastIndex = 0;
      while ((wm = WORD_RE.exec(seg))) words.push(wordInfo(wm[0], bs + wm.index));
      if (!words.length) return;
      while (hi < headings.length && headings[hi][1] <= bs) hi++;
      var isHead = hi < headings.length && headings[hi][0] <= words[0].s && words[0].s < headings[hi][1];
      var cur = [], start = words[0].s;
      for (var k = 0; k < words.length; k++) {
        var w = words[k];
        if (!cur.length) start = w.s;
        cur.push(w);
        var gapEnd = k + 1 < words.length ? words[k + 1].s : be;
        var gap = clean.slice(w.e, gapEnd);
        var term = /^[)"'”’\]]*([.!?…]+|[.!?]['"”’)\]]*[.!?]?)/.exec(gap);
        var brk = false, tEnd = w.e;
        if (term && (k + 1 >= words.length || /\s/.test(gap.slice(term[0].length, term[0].length + 4) + (k + 1 >= words.length ? ' ' : '')))) {
          brk = true;
          var punct = term[1];
          var next = k + 1 < words.length ? words[k + 1] : null;
          if (punct === '.' && next) {
            if (ABBR[w.lw] || /^[A-Z]$/.test(w.t) || /^[a-z]$/.test(w.t) && /\./.test(clean[w.s - 1] || '')) brk = false;
            else if (/^[a-z]/.test(next.t)) brk = false;   // "etc. and" — a lowercase start continues the sentence
          }
          if (brk) {
            tEnd = w.e + term[0].length;
            var tail = /^[)"'”’\]]*/.exec(gap.slice(term[0].length)); if (tail) tEnd += tail[0].length;
          }
        }
        if (brk || k + 1 >= words.length) {
          out.push({ cs: start, ce: brk ? tEnd : w.e, words: cur, heading: isHead });
          cur = [];
        }
      }
    });
    return out;
  }

  // ---------- readability formulas ----------
  function fre(W, S, Y) { return 206.835 - 1.015 * (W / S) - 84.6 * (Y / W); }
  function fkgl(W, S, Y) { return 0.39 * (W / S) + 11.8 * (Y / W) - 15.59; }
  function fog(W, S, C) { return 0.4 * ((W / S) + 100 * (C / W)); }
  function cli(W, S, L) { return 0.0588 * (L / W * 100) - 0.296 * (S / W * 100) - 15.8; }
  function smog(S, P) { return 1.0430 * Math.sqrt(P * (30 / S)) + 3.1291; }
  function ari(W, S, Ch) { return 4.71 * (Ch / W) + 0.5 * (W / S) - 21.43; }
  var FRE_BANDS = [
    [90, 'Very easy', '11-year-olds'], [80, 'Easy', '11–12 yr olds'], [70, 'Fairly easy', '12–13 yr olds'],
    [60, 'Plain English', '13–15 yr olds'], [50, 'Fairly difficult', '15–18 yr olds'], [30, 'Difficult', 'college level'],
    [10, 'Very difficult', 'graduates'], [-Infinity, 'Extremely difficult', 'specialists']
  ];
  function freBand(score) { for (var i = 0; i < FRE_BANDS.length; i++) if (score >= FRE_BANDS[i][0]) return FRE_BANDS[i]; return FRE_BANDS[FRE_BANDS.length - 1]; }
  function verdict(m) {
    if (!m) return '';
    var b = freBand(m.fre), g = Math.round(m.grade);
    var gTxt = g <= 0 ? 'grade K' : g > 16 ? 'post-graduate' : g > 12 ? 'college (' + g + ')' : 'grade ' + g;
    return b[1] + ' · ' + gTxt + ' · ' + b[2];
  }

  // Gunning Fog "complex": 3+ syllables, not a proper noun, not hyphenated,
  // not 3 syllables only thanks to -es / -ed / -ing.
  function fogComplex(w, firstInSentence) {
    if (w.syl < 3) return false;
    if (w.t.indexOf('-') !== -1) return false;
    if (!firstInSentence && /^[A-Z]/.test(w.t)) return false;
    var m = /^(.+?)(es|ed|ing)$/.exec(w.lw);
    if (m && syllables(m[1]) < 3 && w.syl - syllables(m[1]) <= 1) return false;
    return true;
  }

  // ---------- flag dictionaries ----------
  var BE = setOf('am,is,are,was,were,be,been,being,isn\'t,aren\'t,wasn\'t,weren\'t,\'s,\'re');
  var BE_GAP = setOf('not,never,also,always,often,already,still,being,been,just,then,usually,generally,sometimes,rarely,all,both,each,now,ever,mostly,largely,widely,newly,later,soon,quickly,easily,slowly,commonly,frequently,typically');
  var IRREG = setOf('arisen,awoken,beaten,become,begun,bent,bet,bitten,bled,blown,born,borne,bought,bound,bred,broken,brought,built,burnt,burst,cast,caught,chosen,clung,come,cut,dealt,done,drawn,dreamt,driven,drunk,dug,eaten,fallen,fed,felt,fled,flown,forbidden,forecast,foreseen,forgiven,forgotten,fought,found,frozen,given,ground,grown,held,hidden,hit,hung,hurt,kept,knelt,knit,known,laid,lain,led,leant,learnt,left,lent,let,lit,lost,made,meant,met,mistaken,misunderstood,overcome,overrun,overseen,overtaken,overthrown,paid,proven,put,quit,read,rebuilt,redone,rewritten,ridden,risen,run,rung,said,sawn,seen,sent,set,sewn,shaken,shaven,shed,shone,shorn,shot,shown,shrunk,shut,slain,slept,slid,slit,smelt,sold,sought,sown,sped,spelt,spent,spilt,spit,split,spoken,spoilt,spread,sprung,spun,stolen,struck,strung,stuck,stung,stunk,stridden,striven,sung,sunk,swept,swollen,sworn,swum,swung,taken,taught,thought,thrown,thrust,told,torn,trodden,understood,undertaken,undone,upheld,upset,wept,withdrawn,withheld,woken,won,worn,wound,woven,written,wrung');
  // -ed words that are rarely passive participles
  var ED_NOT = setOf('need,needed,indeed,speed,seed,feed,breed,bleed,heed,deed,reed,weed,greed,shed,bed,red,wed,led,fed,sled,shred,hundred,sacred,naked,wicked,rugged,ragged,crooked,beloved,learned,aged,blessed,dogged,jagged,wretched,kindred,supposed,tired,bored,excited,interested,worried,pleased,surprised,scared,married,concerned,involved,determined,prepared,qualified,related,experienced,detailed,advanced,limited,skilled,talented,complicated,sophisticated,dedicated,committed,embarrassed,confused,amazed,annoyed,ashamed,relaxed,satisfied,disappointed,frightened,terrified,exhausted,delighted,thrilled,overwhelmed,motivated,inspired,impressed,convinced,unrelated,unlimited,unexpected,unprecedented,based,used');
  // ...but these are flagged anyway when "by …" follows
  var LY_EXC = setOf('only,early,family,reply,apply,supply,imply,comply,rely,ally,belly,bully,daily,weekly,monthly,yearly,hourly,quarterly,likely,unlikely,lovely,lonely,friendly,unfriendly,ugly,holy,jelly,july,italy,fly,sly,rally,silly,hilly,chilly,curly,oily,elderly,costly,deadly,lively,orderly,homely,timely,wobbly,assembly,anomaly,butterfly,firefly,dragonfly,multiply,folly,holly,lily,gully,jolly,sully,tally,emily,kelly,molly,polly,sally,billy,reilly,bodily,ally,italy,manly,womanly,cowardly,scholarly,heavenly,worldly,ghostly,kindly,surly,burly,beastly,sickly,leisurely,deathly,stately,comely,courtly,godly,ungodly,smelly,belly,anomaly,monopoly,rely,doily,trolley,fully,wholly,lily,ply,apply,supply,comply,reply,imply,underbelly,jelly,melancholy,unruly,haply,early,nearly,barely,merely,rarely');
  // filler / weasel / hedges: [phrase, hint]
  var FILLER = [
    ['very', 'cut it, or pick a stronger word'], ['really', 'cut it'], ['just', 'cut it'], ['actually', 'cut it'], ['basically', 'cut it'],
    ['quite', 'cut it'], ['somewhat', 'be specific'], ['various', 'be specific'], ['many', 'say how many'], ['a lot', 'much / many'],
    ['lots of', 'many'], ['in order to', 'to'], ['rather', 'cut it'], ['fairly', 'cut it'], ['totally', 'cut it'], ['literally', 'cut it'],
    ['simply', 'cut it'], ['definitely', 'cut it'], ['certainly', 'cut it'], ['probably', 'commit or qualify once'], ['perhaps', 'commit'],
    ['maybe', 'commit'], ['seems', 'commit'], ['seemingly', 'commit'], ['sort of', 'cut it'], ['kind of', 'cut it'], ['i think', 'cut it'],
    ['i believe', 'cut it'], ['i feel', 'cut it'], ['it seems', 'commit'], ['arguably', 'commit'], ['virtually', 'cut it'],
    ['essentially', 'cut it'], ['extremely', 'pick a stronger word'], ['honestly', 'cut it'], ['obviously', 'cut it'], ['clearly', 'cut it'],
    ['of course', 'cut it'], ['needless to say', 'cut it'], ['due to the fact that', 'because'], ['owing to the fact that', 'because'],
    ['at this point in time', 'now'], ['at the present time', 'now'], ['the fact that', 'that'], ['in terms of', 'about / for'],
    ['a number of', 'some / several'], ['a variety of', 'various → be specific'], ['relatively', 'be specific'], ['some people say', 'who says?'],
    ['it is said that', 'who says?'], ['mostly', 'be specific'], ['several', 'say how many'], ['nearly', 'be specific'],
    ['each and every', 'each / every'], ['for all intents and purposes', 'cut it'], ['in fact', 'cut it'], ['so to speak', 'cut it']
  ];
  var CLICHES = [
    'at the end of the day', 'think outside the box', 'low hanging fruit', 'in the nick of time', 'the bottom line', 'touch base', 'move the needle',
    'perfect storm', 'last but not least', 'few and far between', 'avoid it like the plague', 'like the plague', 'only time will tell',
    'better late than never', 'silver lining', 'game changer', 'par for the course', 'tip of the iceberg', 'elephant in the room',
    'it goes without saying', 'when all is said and done', 'easier said than done', 'in this day and age', 'hit the ground running',
    'back to square one', 'writing on the wall', 'read between the lines', 'blessing in disguise', 'going forward', 'circle back',
    'win win', 'best of both worlds', 'cutting edge', 'state of the art', 'paradigm shift', 'level playing field', 'on the same page',
    'all in all', 'first and foremost', 'in a nutshell', 'at the drop of a hat', 'crystal clear', 'time is of the essence',
    'the calm before the storm', 'a piece of cake', 'raining cats and dogs', 'break the ice', 'every cloud has a silver lining',
    'when push comes to shove', 'by the same token', 'the ball is in your court', 'think on your feet', 'a whole new ball game',
    'from the ground up', 'push the envelope', 'at the speed of light', 'needle in a haystack', 'the icing on the cake'
  ];
  // complex word → simpler; "~" marks a verb whose inflections match too
  var COMPLEX = [
    ['utilize~', 'use'], ['utilise~', 'use'], ['utilization', 'use'], ['commence~', 'start'], ['terminate~', 'end'], ['facilitate~', 'help'],
    ['endeavor~', 'try'], ['endeavour~', 'try'], ['approximately', 'about'], ['purchase~', 'buy'], ['assist~', 'help'], ['assistance', 'help'],
    ['demonstrate~', 'show'], ['sufficient', 'enough'], ['numerous', 'many'], ['additional', 'more / extra'], ['subsequently', 'later'],
    ['prior to', 'before'], ['in the event that', 'if'], ['regarding', 'about'], ['obtain~', 'get'], ['implement~', 'do / carry out'],
    ['initiate~', 'start'], ['modify~', 'change'], ['individuals', 'people'], ['possess~', 'have'], ['ascertain~', 'find out'],
    ['accomplish~', 'do'], ['anticipate~', 'expect'], ['constitute~', 'make up'], ['consequently', 'so'], ['nevertheless', 'still'],
    ['optimum', 'best'], ['remainder', 'rest'], ['transmit~', 'send'], ['with regard to', 'about'], ['in close proximity to', 'near'],
    ['has the ability to', 'can'], ['is able to', 'can'], ['a majority of', 'most'], ['cognizant', 'aware'], ['leverage~', 'use'],
    ['methodology', 'method'], ['functionality', 'features'], ['ameliorate~', 'improve'], ['disseminate~', 'spread'], ['expedite~', 'speed up'],
    ['in excess of', 'more than'], ['at this juncture', 'now'], ['remuneration', 'pay'], ['inquire~', 'ask'], ['enquire~', 'ask']
  ];
  function verbForms(base) {
    if (/e$/.test(base)) return [base, base + 's', base + 'd', base.slice(0, -1) + 'ing'];
    if (/[^aeiou]y$/.test(base)) return [base, base.slice(0, -1) + 'ies', base.slice(0, -1) + 'ied', base + 'ing'];
    if (/ss$/.test(base)) return [base, base + 'es', base + 'ed', base + 'ing'];
    return [base, base + 's', base + 'ed', base + 'ing'];
  }
  function phraseSrc(p) { return p.split(/\s+/).map(reEsc).join('[\\s-]+'); }
  function buildPhraseRe(list) {   // list of [phrase(s), hint] → { re, hintFor(lower) }
    var hints = Object.create(null), alts = [];
    list.forEach(function (e) {
      var forms = /~$/.test(e[0]) ? verbForms(e[0].slice(0, -1)) : [e[0]];
      forms.forEach(function (f) { hints[f] = e[1]; alts.push(f); });
    });
    alts.sort(function (a, b) { return b.length - a.length; });
    var re = new RegExp('(^|[^A-Za-z0-9\'’-])(' + alts.map(phraseSrc).join('|') + ')(?![A-Za-z0-9’-]|\'[a-z])', 'gi');
    return { re: re, hint: function (s) { return hints[s.toLowerCase().replace(/[\s-]+/g, ' ')] || ''; } };
  }
  var FILLER_RE = buildPhraseRe(FILLER);
  var CLICHE_RE = buildPhraseRe(CLICHES.map(function (c) { return [c, 'say it plainly']; }));
  var COMPLEX_RE = buildPhraseRe(COMPLEX);
  var COMPLEX_WORDS = Object.create(null);
  COMPLEX.forEach(function (e) { (/~$/.test(e[0]) ? verbForms(e[0].slice(0, -1)) : [e[0]]).forEach(function (f) { if (f.indexOf(' ') === -1) COMPLEX_WORDS[f] = 1; }); });
  var FILLER_WORDS = setOf(FILLER.filter(function (f) { return f[0].indexOf(' ') === -1; }).map(function (f) { return f[0]; }).join(','));

  var KINDS = [
    { id: 'long', label: 'Very long sentences', short: 'Long', hint: 'over 30 words — split it' },
    { id: 'hard', label: 'Hard sentences', short: 'Hard', hint: 'over 20 words and hard to read' },
    { id: 'passive', label: 'Passive voice', short: 'Passive', hint: 'who does it? use the active voice' },
    { id: 'adverb', label: 'Adverbs', short: 'Adverbs', hint: 'use a stronger verb' },
    { id: 'filler', label: 'Filler & hedges', short: 'Filler', hint: '' },
    { id: 'cliche', label: 'Clichés', short: 'Clichés', hint: 'say it plainly' },
    { id: 'repeat', label: 'Repeated words', short: 'Repeats', hint: 'remove the duplicate' },
    { id: 'complex', label: 'Simpler alternatives', short: 'Complex', hint: '' }
  ];

  function isParticiple(lw) { return !!IRREG[lw] || (lw.length > 4 && /ed$/.test(lw) && !ED_NOT[lw]); }

  // Find passive constructions in one sentence's words → [{ i, j, by }]
  // (be-verb, up to two adverbs / "not" / "being", then a past participle;
  // a following "by …" lets adjective-like participles count too).
  var BE_NOT_PART = setOf('gone,become,come,upset,born');
  function findPassive(words, clean) {
    var out = [];
    for (var i = 0; i < words.length; i++) {
      var lw = words[i].lw;
      if (!BE[lw] && !/^(they|we|you)'re$/.test(lw)) continue;
      var j = i + 1, skipped = 0;
      while (j < words.length && skipped < 2 &&
        (BE_GAP[words[j].lw] || (/ly$/.test(words[j].lw) && words[j].lw.length > 4 && !LY_EXC[words[j].lw]))) { j++; skipped++; }
      if (j >= words.length) continue;
      var w = words[j], lp = w.lw;
      if (clean && /[,;:()\u2014\u2013]/.test(clean.slice(words[i].e, w.s))) continue;   // "is, built" — not one phrase
      var by = false;
      for (var k = j + 1; k < Math.min(words.length, j + 7); k++) if (words[k].lw === 'by') { by = true; break; }
      var byNext = !!(words[j + 1] && words[j + 1].lw === 'by');
      var part;
      if (IRREG[lp]) part = !BE_NOT_PART[lp] || byNext;
      else part = lp.length > 4 && /ed$/.test(lp) && (!ED_NOT[lp] || (byNext && !/^(need|indeed|speed|hundred|supposed)$/.test(lp)));
      if (lp === 'used' && words[j + 1] && words[j + 1].lw === 'to') part = false;   // "is used to it"
      if (!part) continue;
      out.push({ i: i, j: j, by: by });
      i = j;
    }
    return out;
  }

  function analyze(src, opts) {
    opts = opts || {};
    var base = opts.base || 0;
    var truncated = false;
    src = String(src == null ? '' : src);
    var limit = opts.maxChars || MAX_CHARS;
    if (src.length > limit) { src = src.slice(0, limit); truncated = true; }
    var md = stripMarkdown(src), clean = md.text, map = md.map;
    var sents = sentences(clean, md.headings);
    var W = 0, S = 0, Y = 0, L = 0, P = 0, C = 0, Wall = 0;
    sents.forEach(function (s) {
      Wall += s.words.length;
      if (s.heading) return;
      S++;
      s.words.forEach(function (w, k) {
        W++; Y += w.syl; L += w.letters;
        if (w.syl >= 3) P++;
        if (fogComplex(w, k === 0)) C++;
      });
    });
    var metrics = null;
    if (W > 0 && S > 0) {
      metrics = {
        fre: fre(W, S, Y), fk: fkgl(W, S, Y), fog: fog(W, S, C), cli: cli(W, S, L),
        smog: S >= 30 ? smog(S, P) : null, ari: ari(W, S, L)
      };
      var gs = [metrics.fk, metrics.fog, metrics.cli, metrics.ari];
      if (metrics.smog != null) gs.push(metrics.smog);
      metrics.grade = Math.max(0, gs.reduce(function (a, b) { return a + b; }, 0) / gs.length);
    }
    var flags = [], counts = {};
    KINDS.forEach(function (k) { counts[k.id] = 0; });
    function add(kind, cs, ce, hint, extra) {
      counts[kind]++;
      if (counts[kind] > MAX_FLAGS_PER_KIND) return;
      var r = mapRange(map, cs, ce);
      var f = { kind: kind, from: r[0] + base, to: r[1] + base, cs: cs, ce: ce, text: clean.slice(cs, ce).replace(/\s+/g, ' '), hint: hint || '' };
      if (extra) for (var k in extra) f[k] = extra[k];
      flags.push(f);
    }
    sents.forEach(function (s) {
      var n = s.words.length;
      if (!s.heading && n > 30) add('long', s.cs, s.ce, n + ' words', { words: n });
      else if (!s.heading && n > 20) {
        var sy = 0; s.words.forEach(function (w) { sy += w.syl; });
        var g = fkgl(n, 1, sy);
        if (g >= 12) add('hard', s.cs, s.ce, n + ' words · grade ' + Math.round(g), { words: n, grade: g });
      }
      findPassive(s.words, clean).forEach(function (p) {
        add('passive', s.words[p.i].s, s.words[p.j].e, p.by ? 'passive with “by” — make the doer the subject' : 'who does it? try the active voice', { by: p.by });
      });
      s.words.forEach(function (w) {
        if (w.lw.length >= 5 && /ly$/.test(w.lw) && !LY_EXC[w.lw] && !FILLER_WORDS[w.lw] && !COMPLEX_WORDS[w.lw] && w.t.indexOf('-') === -1) {
          add('adverb', w.s, w.e, 'use a stronger verb, or cut it');
        }
      });
    });
    function scan(pr, kind) {
      pr.re.lastIndex = 0;
      var m;
      while ((m = pr.re.exec(clean))) {
        var cs = m.index + m[1].length, ce = cs + m[2].length;
        if (/\n\n/.test(m[2])) { pr.re.lastIndex = cs + 1; continue; }
        add(kind, cs, ce, pr.hint(m[2]));
        pr.re.lastIndex = ce;
      }
    }
    scan(FILLER_RE, 'filler');
    scan(CLICHE_RE, 'cliche');
    scan(COMPLEX_RE, 'complex');
    var rep = /(^|[^A-Za-z'’-])([A-Za-z][A-Za-z'’]*)(?:[ \t]+|[ \t]*\n(?!\n)[ \t]*)\2(?![A-Za-z'’-])/gi, rm;
    while ((rm = rep.exec(clean))) {
      var rs = rm.index + rm[1].length, re2 = rm.index + rm[0].length;
      if (rm[2].toLowerCase() === rm[0].slice(rm[1].length + rm[2].length).trim().toLowerCase())
        add('repeat', rs, re2, '“' + rm[2] + '” twice in a row');
      rep.lastIndex = re2 - rm[2].length;   // "the the the" → two flags
    }
    flags.sort(function (a, b) { return a.from - b.from || a.to - b.to; });
    var readMin = Wall / 238, speakMin = Wall / 150;
    return {
      words: W, wordsAll: Wall, sentences: S, syllables: Y, letters: L, polysyllables: P, complexWords: C,
      wps: S ? W / S : 0, spw: W ? Y / W : 0, metrics: metrics, verdict: verdict(metrics), band: metrics ? freBand(metrics.fre) : null,
      readMin: readMin, speakMin: speakMin, flags: flags, counts: counts, truncated: truncated, clean: clean
    };
  }
  // Context around a flag in the clean text: { before, match, after }
  function context(clean, cs, ce, pad) {
    pad = pad || 32;
    var a = Math.max(0, cs - pad), b = Math.min(clean.length, ce + pad);
    var before = clean.slice(a, cs), after = clean.slice(ce, b);
    var nb = before.lastIndexOf('\n\n'); if (nb !== -1) { before = before.slice(nb + 2); a = -1; }
    var na = after.indexOf('\n\n'); if (na !== -1) { after = after.slice(0, na); b = -1; }
    if (a > 0) before = '…' + before.replace(/^\S*\s/, '');
    if (b !== -1 && b < clean.length) after = after.replace(/\s\S*$/, '') + '…';
    return { before: before.replace(/\s+/g, ' '), match: clean.slice(cs, ce).replace(/\s+/g, ' '), after: after.replace(/\s+/g, ' ') };
  }
  function fmtDuration(mins) {
    if (!(mins > 0)) return '—';
    var s = Math.round(mins * 60);
    if (s < 60) return Math.max(1, s) + ' sec';
    if (mins < 60) { var m = Math.floor(s / 60), r = s % 60; return m + ' min' + (r >= 30 && m < 10 ? ' ' + r + ' s' : ''); }
    var h = Math.floor(mins / 60); return h + ' h ' + Math.round(mins - h * 60) + ' min';
  }

  var PURE = {
    stripMarkdown: stripMarkdown, mapRange: mapRange, syllables: syllables, sentences: sentences,
    fre: fre, fkgl: fkgl, fog: fog, cli: cli, smog: smog, ari: ari, freBand: freBand, verdict: verdict,
    isParticiple: isParticiple, findPassive: findPassive, analyze: analyze, context: context, fmtDuration: fmtDuration,
    KINDS: KINDS, MAX_CHARS: MAX_CHARS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = PURE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('writingcheck.css');
  var esc = Cade.escapeHtml || function (s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); };

  var PANEL_ID = 'writingcheck-panel', NAME = 'Writing Check';
  var K_OFF = 'cade-writingcheck-off', K_HL = 'cade-writingcheck-hl', K_SCOPE = 'cade-writingcheck-scope', K_OPEN = 'cade-writingcheck-open';
  var SHOW_PER_KIND = 60;

  function sget(k, d) { try { var v = Cade.store.get(k); return v == null ? d : v; } catch (e) { return d; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function jget(k, d) { try { var v = JSON.parse(sget(k, 'null')); return v == null ? d : v; } catch (e) { return d; } }

  var S = null;   // live panel state

  // ---- editor highlight field (optional; only when the CM exports allow it) ----
  var HL = null;
  function hlSupported() {
    var CM = Cade.CM;
    return !!(CM && CM.StateField && CM.StateEffect && CM.StateEffect.appendConfig && CM.Decoration && CM.EditorView && CM.EditorView.decorations);
  }
  function hlInit() {
    if (HL || !hlSupported()) return HL;
    var CM = Cade.CM;
    var setFx = CM.StateEffect.define();
    var field = CM.StateField.define({
      create: function () { return CM.Decoration.none; },
      update: function (deco, tr) {
        deco = deco.map(tr.changes);
        for (var i = 0; i < tr.effects.length; i++) if (tr.effects[i].is(setFx)) deco = tr.effects[i].value;
        return deco;
      },
      provide: function (f) { return CM.EditorView.decorations.from(f); }
    });
    HL = { setFx: setFx, field: field, marks: {} };
    return HL;
  }
  function hlMark(kind) {
    if (!HL.marks[kind]) HL.marks[kind] = Cade.CM.Decoration.mark({ class: 'wc-hl wc-hl-' + kind });
    return HL.marks[kind];
  }
  function hlApply(flags) {
    var view = Cade.editor; if (!view || !hlInit()) return;
    var CM = Cade.CM, len = view.state.doc.length;
    var ranges = [];
    if (flags) {
      flags.slice(0, 3000).forEach(function (f) {
        var a = Math.max(0, Math.min(len, f.from)), b = Math.max(0, Math.min(len, f.to));
        if (b > a) ranges.push(hlMark(f.kind).range(a, b));
      });
    }
    var effects = [];
    var has = false; try { has = view.state.field(HL.field, false) !== undefined; } catch (e) { has = false; }
    if (!has) { if (!ranges.length) return; effects.push(CM.StateEffect.appendConfig.of(HL.field)); }
    var set; try { set = CM.Decoration.set(ranges, true); } catch (e) { set = CM.Decoration.none; }
    effects.push(HL.setFx.of(set));
    try { view.dispatch({ effects: effects }); } catch (e) {}
  }

  // ---- scope + scheduling ----
  function currentScope() {
    var view = Cade.editor; if (!view) return null;
    if (S.mode === 'note') return null;
    return S.scope;
  }
  function schedule(delay) {
    if (!S) return;
    clearTimeout(S.t);
    if (S.idle && window.cancelIdleCallback) { try { window.cancelIdleCallback(S.idle); } catch (e) {} S.idle = 0; }
    S.t = setTimeout(function () {
      S && (S.t = 0);
      if (!S) return;
      if (window.requestIdleCallback) S.idle = window.requestIdleCallback(function () { if (S) { S.idle = 0; run(); } }, { timeout: 800 });
      else run();
    }, delay == null ? 400 : delay);
  }
  // Selections made by a "jump to" in this or a sibling widget (Writing
  // Check / Word Frequency) carry this userEvent and don't change the scope.
  var JUMP = 'select.cadejump';
  function isJump(u) {
    var trs = u.transactions || [];
    for (var i = 0; i < trs.length; i++) if (trs[i].selection && trs[i].isUserEvent && trs[i].isUserEvent(JUMP)) return true;
    return false;
  }
  function sameSel(a, b) { return a && b && a.anchor === b.anchor && a.head === b.head; }
  function onUpdate(u) {
    if (!S || !S.panel.isConnected) return;
    if (Cade.roomAway && Cade.roomAway(S.panel)) return;
    var st = u.state, m = st.selection.main;
    var cur = { anchor: m.anchor, head: m.head };
    if (u.docChanged && S.scope) {
      S.scope = { from: u.changes.mapPos(S.scope.from, 1), to: u.changes.mapPos(S.scope.to, -1) };
      if (S.scope.to <= S.scope.from) S.scope = null;
    }
    if (u.docChanged && S.own) S.own = { anchor: u.changes.mapPos(S.own.anchor), head: u.changes.mapPos(S.own.head) };
    var scopeChanged = false;
    if (u.selectionSet && isJump(u)) S.own = cur;
    if (u.selectionSet && !sameSel(cur, S.own)) {
      S.own = null;
      var next = m.empty ? null : { from: m.from, to: m.to };
      if (!(next === null && S.scope === null) && !(next && S.scope && next.from === S.scope.from && next.to === S.scope.to)) {
        S.scope = next; scopeChanged = true;
      }
    }
    if (u.docChanged) schedule(st.doc.length > 60000 ? 1200 : 450);
    else if (scopeChanged && S.mode !== 'note') schedule(250);
  }

  function run() {
    if (!S || !S.panel.isConnected) return;
    if (Cade.roomAway && Cade.roomAway(S.panel)) return;
    var view = Cade.editor; if (!view) return;
    var sc = currentScope(), text, base = 0;
    var len = view.state.doc.length;
    if (sc && sc.to <= len) { text = view.state.sliceDoc(sc.from, sc.to); base = sc.from; }
    else { sc = null; text = view.state.sliceDoc(0, Math.min(len, MAX_CHARS + 1)); }
    var t0 = Date.now();
    S.res = analyze(text, { base: base });
    S.res.scope = sc;
    S.res.ms = Date.now() - t0;
    S.res.docLen = len;
    S.cursor = {};
    render();
    applyHighlights();
  }

  function applyHighlights() {
    if (!S) return;
    if (!S.hl || !S.res) { if (HL) hlApply(null); return; }
    hlApply(S.res.flags.filter(function (f) { return !S.off[f.kind]; }));
  }

  // ---- rendering ----
  function fmt1(x) { return x == null || !isFinite(x) ? '—' : (Math.round(x * 10) / 10).toFixed(1); }
  function scoreTone(fre) { return fre >= 60 ? 'good' : fre >= 30 ? 'warn' : 'bad'; }
  function gradeTone(g) { return g <= 9 ? 'good' : g <= 13 ? 'warn' : 'bad'; }
  function render() {
    if (!S) return;
    var r = S.res, body = S.body;
    if (!r) { body.innerHTML = '<div class="wc-empty">Analysing…</div>'; return; }
    var scopeTxt = r.scope ? 'Selection' : 'Whole note';
    var h = '';
    h += '<div class="wc-scope"><span class="wc-scope-l">' + scopeTxt + '</span><span class="wc-scope-r">' +
      r.wordsAll.toLocaleString() + ' words' + (r.truncated ? ' · first ' + Math.round(MAX_CHARS / 1000) + 'k chars' : '') + '</span></div>';
    if (!r.metrics) {
      h += '<div class="wc-empty">Write a few sentences' + (r.scope ? ' or select more text' : '') + ' to see readability scores.</div>';
    } else {
      var m = r.metrics, tone = scoreTone(m.fre);
      h += '<div class="wc-hero wc-' + tone + '">' +
        '<div class="wc-hero-n" title="Flesch Reading Ease (0–100, higher is easier)">' + Math.round(Math.max(-99, Math.min(121, m.fre))) + '</div>' +
        '<div class="wc-hero-t"><b>' + esc(r.band[1]) + '</b><span>' + esc(r.verdict.split(' · ').slice(1).join(' · ')) + '</span></div></div>';
      var tile = function (label, val, title, t) {
        return '<div class="wc-tile' + (t ? ' wc-' + t : '') + '" title="' + esc(title) + '"><span>' + label + '</span><b>' + val + '</b></div>';
      };
      h += '<div class="wc-tiles">' +
        tile('Flesch ease', fmt1(m.fre), 'Flesch Reading Ease: 60–70 is plain English; higher is easier', tone) +
        tile('F–K grade', fmt1(m.fk), 'Flesch–Kincaid grade level (US school grade)', gradeTone(m.fk)) +
        tile('Gunning Fog', fmt1(m.fog), 'Years of schooling needed; aim for under 12', gradeTone(m.fog)) +
        tile('Coleman–Liau', fmt1(m.cli), 'Grade level from letters and sentences per 100 words', gradeTone(m.cli)) +
        (m.smog != null ? tile('SMOG', fmt1(m.smog), 'SMOG grade (needs 30+ sentences)', gradeTone(m.smog))
          : '<div class="wc-tile wc-na" title="SMOG needs at least 30 sentences"><span>SMOG</span><b>—</b><i>30+ sentences</i></div>') +
        tile('ARI', fmt1(m.ari), 'Automated Readability Index (grade level)', gradeTone(m.ari)) +
        '</div>';
      var row = function (l, v) { return '<div class="wc-row"><span>' + l + '</span><b>' + v + '</b></div>'; };
      h += '<div class="wc-rows">' +
        row('Words · sentences', r.words.toLocaleString() + ' · ' + r.sentences.toLocaleString()) +
        row('Words per sentence', fmt1(r.wps)) +
        row('Syllables per word', (Math.round(r.spw * 100) / 100).toFixed(2)) +
        row('Reading · speaking', esc(fmtDuration(r.readMin)) + ' · ' + esc(fmtDuration(r.speakMin))) +
        '</div>';
    }
    // flags
    var total = 0;
    KINDS.forEach(function (k) { if (!S.off[k.id]) total += r.counts[k.id]; });
    h += '<div class="wc-sec"><span>Flags</span><span class="wc-sec-n">' + total + '</span>' +
      (hlSupported() ? '<button type="button" class="wc-hlbtn' + (S.hl ? ' on' : '') + '" data-act="hl" aria-pressed="' + (S.hl ? 'true' : 'false') + '" title="Highlight the flags in the editor">' +
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12.5h10M4.5 10 10 4.5l1.5 1.5L6 11.5H4.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>Highlight</button>' : '') +
      '</div>';
    h += '<div class="wc-chips">' + KINDS.map(function (k) {
      var n = r.counts[k.id], on = !S.off[k.id];
      return '<button type="button" class="wc-chip wc-k-' + k.id + (on ? ' on' : '') + (n ? '' : ' zero') + '" data-kind="' + k.id + '" aria-pressed="' + on + '" title="' + esc(k.label) + (on ? ' — click to hide' : ' — click to show') + '">' +
        '<i></i>' + esc(k.short) + ' <b>' + n + '</b></button>';
    }).join('') + '</div>';
    var groups = '';
    KINDS.forEach(function (k) {
      if (S.off[k.id]) return;
      var list = r.flags.filter(function (f) { return f.kind === k.id; });
      if (!list.length) return;
      var collapsed = !!S.collapsed[k.id];
      var shown = S.more[k.id] ? list.length : Math.min(list.length, SHOW_PER_KIND);
      groups += '<div class="wc-group wc-k-' + k.id + (collapsed ? ' collapsed' : '') + '">' +
        '<button type="button" class="wc-gh" data-act="collapse" data-kind="' + k.id + '" aria-expanded="' + !collapsed + '">' +
        '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' +
        '<span>' + esc(k.label) + '</span><b>' + r.counts[k.id] + '</b>' + (k.hint ? '<i>' + esc(k.hint) + '</i>' : '') + '</button>';
      if (!collapsed) {
        groups += '<div class="wc-items">';
        for (var i = 0; i < shown; i++) {
          var f = list[i], idx = r.flags.indexOf(f), sentence = f.kind === 'long' || f.kind === 'hard';
          var c = sentence ? null : context(r.clean, f.cs, f.ce, 28);
          groups += '<button type="button" class="wc-item" data-i="' + idx + '" title="Select in the note">' +
            (sentence
              ? '<span class="wc-snip wc-sent">' + esc(f.text.length > 140 ? f.text.slice(0, 137) + '…' : f.text) + '</span>'
              : '<span class="wc-snip">' + esc(c.before) + '<mark>' + esc(c.match) + '</mark>' + esc(c.after) + '</span>') +
            (f.hint ? '<span class="wc-hint">' + (k.id === 'complex' ? '→ ' : '') + esc(f.hint) + '</span>' : '') + '</button>';
        }
        if (list.length > shown) groups += '<button type="button" class="wc-more" data-act="more" data-kind="' + k.id + '">Show ' + (list.length - shown) + ' more</button>';
        if (r.counts[k.id] > list.length) groups += '<div class="wc-cap">' + (r.counts[k.id] - list.length) + ' more not listed</div>';
        groups += '</div>';
      }
      groups += '</div>';
    });
    h += groups || '<div class="wc-none">' + (r.wordsAll ? (total === 0 && KINDS.some(function (k) { return S.off[k.id]; }) ? 'Nothing flagged in the kinds shown.' : 'Nothing flagged — nice and clear.') : '') + '</div>';
    var st = S.body.scrollTop;
    body.innerHTML = h;
    S.body.scrollTop = st;
    updateHead();
  }

  function updateHead() {
    if (!S || !S.scopeBtn) return;
    var note = S.mode === 'note';
    S.scopeBtn.classList.toggle('on', note);
    S.scopeBtn.title = note ? 'Checking the whole note — click to follow the selection' : 'Following the selection — click to always check the whole note';
    S.scopeBtn.setAttribute('aria-label', S.scopeBtn.title);
  }

  function selectFlag(f) {
    var view = Cade.editor; if (!view) return;
    var len = view.state.doc.length, a = Math.min(len, f.from), b = Math.min(len, f.to);
    S.own = { anchor: a, head: b };
    var EV = Cade.CM && Cade.CM.EditorView;
    var spec = { selection: { anchor: a, head: b }, userEvent: JUMP };
    if (EV && EV.scrollIntoView) spec.effects = EV.scrollIntoView(a, { y: 'center' });
    else spec.scrollIntoView = true;
    try { view.dispatch(spec); } catch (e) { return; }
    var coarse = false; try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch (e) {}
    if (!coarse && !(Cade.isPoppedOut && Cade.isPoppedOut(S.panel))) { try { view.focus(); } catch (e) {} }
  }

  function onClick(e) {
    var t = e.target.closest ? e.target.closest('button') : null;
    if (!t || !S) return;
    var r = S.res;
    if (t.classList.contains('wc-item')) {
      var f = r && r.flags[+t.getAttribute('data-i')];
      if (f) { selectFlag(f); var prev = S.body.querySelector('.wc-item.cur'); if (prev) prev.classList.remove('cur'); t.classList.add('cur'); }
      return;
    }
    if (t.classList.contains('wc-chip')) {
      var k = t.getAttribute('data-kind');
      if (S.off[k]) delete S.off[k]; else S.off[k] = 1;
      sset(K_OFF, JSON.stringify(Object.keys(S.off)));
      render(); applyHighlights();
      return;
    }
    var act = t.getAttribute('data-act');
    if (act === 'hl') { S.hl = !S.hl; sset(K_HL, S.hl ? '1' : '0'); render(); applyHighlights(); }
    else if (act === 'collapse') {
      var kc = t.getAttribute('data-kind');
      if (S.collapsed[kc]) delete S.collapsed[kc]; else S.collapsed[kc] = 1;
      sset(K_OPEN, JSON.stringify(Object.keys(S.collapsed)));
      render();
    } else if (act === 'more') { S.more[t.getAttribute('data-kind')] = 1; render(); }
  }

  function mkHeadBtn(panel, cls, svg, onAct) {
    var b = panel.ownerDocument.createElement('span');
    b.className = 'wc-hbtn ' + cls;
    b.setAttribute('role', 'button'); b.setAttribute('tabindex', '0');
    b.innerHTML = svg;
    b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    b.addEventListener('click', function (e) { e.stopPropagation(); onAct(); });
    b.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onAct(); } });
    var head = panel.querySelector('.cade-panel-head');
    if (head) head.insertBefore(b, panel.querySelector('.cade-panel-popbtn') || panel.querySelector('.cade-panel-minbtn') || panel.querySelector('.cade-panel-x'));
    return b;
  }
  var SVG_SCOPE = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 6h6M5 8.5h6M5 11h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  var SVG_REFRESH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v2.8h-2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function close() {
    if (!S) return;
    var s = S; S = null;
    clearTimeout(s.t);
    if (s.idle && window.cancelIdleCallback) { try { window.cancelIdleCallback(s.idle); } catch (e) {} }
    try { Cade.offEditorUpdate(onUpdate); } catch (e) {}
    if (HL) hlApply(null);
  }

  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById(PANEL_ID);
    if (existing) {
      if (Cade.isMinimized && Cade.isMinimized(existing) && Cade.restorePanel) { Cade.restorePanel(existing); return; }
      existing.remove(); if (existing._onClose) existing._onClose(); close(); return;
    }
    var p = Cade.mkPanel(PANEL_ID, '🔍 Writing Check', '<div class="wc"></div>');
    var off = {}; jget(K_OFF, []).forEach(function (k) { off[k] = 1; });
    var col = {}; jget(K_OPEN, []).forEach(function (k) { col[k] = 1; });
    var view = Cade.editor, m = view && view.state.selection.main;
    S = {
      panel: p, body: p.querySelector('.wc'), res: null, t: 0, idle: 0, own: null,
      scope: m && !m.empty ? { from: m.from, to: m.to } : null,
      mode: sget(K_SCOPE, 'auto') === 'note' ? 'note' : 'auto',
      off: off, collapsed: col, more: {}, hl: sget(K_HL, '0') === '1', cursor: {}
    };
    S.scopeBtn = mkHeadBtn(p, 'wc-scopebtn', SVG_SCOPE, function () {
      if (!S) return;
      S.mode = S.mode === 'note' ? 'auto' : 'note';
      sset(K_SCOPE, S.mode);
      updateHead(); run();
    });
    var rb = mkHeadBtn(p, 'wc-refresh', SVG_REFRESH, function () { if (S) run(); });
    rb.title = 'Check again'; rb.setAttribute('aria-label', 'Check again');
    updateHead();
    S.body.addEventListener('click', onClick);
    p._onClose = close;
    if (Cade.roomLock) {
      Cade.roomLock(p);
      p.addEventListener('cade-panel-room', function () { if (S) { S.scope = null; S.own = null; run(); } });
    }
    Cade.onEditorUpdate(onUpdate);
    render();
    schedule(0);
  }

  // keep highlights off a room the panel isn't showing
  document.addEventListener('cade-room-switched', function () {
    if (!S) return;
    S.scope = null; S.own = null;
    if (Cade.roomAway && Cade.roomAway(S.panel)) { if (HL) hlApply(null); return; }
    schedule(150);
  });

  Cade.registerWidget({
    name: NAME,
    description: 'Readability scores and grade level, long sentences, passive voice, adverbs and filler words — click to jump to each one',
    icon: '🔍',
    tags: 'writing,readability,flesch,grade,passive,adverbs,filler,weasel,style,check,prose,edit',
    open: open
  });
})();
