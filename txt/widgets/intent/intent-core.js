/* Intent matching for the Ctrl+K palette — "say what you want in plain words".
 *
 * Pure and deterministic (no AI, no network). The palette's own name matching
 * stays in charge of queries that hit a command name; this file ranks the rest
 * so phrasings like "sort these by length", "get rid of blank lines" or "start
 * a 10 minute timer" put the right command on top.
 *
 * Pipeline (the same for the query and for every command's text, so both
 * sides always meet in the same vocabulary):
 *   normalise  lowercase, NFKD (fancy Unicode letters → ASCII), → / ↔ → "to",
 *              camelCase split, apostrophes dropped, punctuation → spaces;
 *   phrases    multi-word idioms rewritten to one concept ("get rid of" →
 *              remove, "how many" → count, "a to z" → sort alpha, "10 minutes"
 *              → countdown …);
 *   tokens     split, stop words dropped (a few — open/start/play — only hint
 *              that a widget is wanted), simple stemming (-s/-es/-ies/-ing/
 *              -ed/-ly, -ise → -ize, final -e) and a concept table that folds
 *              synonyms together (remove ≈ delete ≈ strip, unique → remove +
 *              duplicate, caps → upper …). A few concepts are "related" and
 *              match each other at half strength (blank ~ whitespace,
 *              line ~ list).
 * Scoring: each query concept is weighted by its rarity in the catalogue
 * (IDF) and matched against the command's name (1.0), tags (0.7) or
 * description (0.45); a 4+ letter stem that prefixes another counts 0.75.
 *   score = 0.62·(weighted share of the query matched)
 *         + 0.38·(weighted share of the command NAME covered by the query)
 * plus: the whole name inside the query, direction for "X → Y" names (csv
 * into a table ≠ table into csv), a widget nudge for "open / start / play …",
 * a small script nudge while text is selected, and what the owner picked for
 * the same phrase before (learn(): phrase → command, at most 200 phrases).
 *
 * blend() is the palette's ranking: rows whose NAME the old matcher hits
 * (exact / prefix / substring) keep today's order on top; the rest are ordered
 * by intent score and get a "matches: …" hint.
 *
 * UMD: window.__cadeIntentCore in the page, module.exports under Node.
 */
(function (root) {
  'use strict';

  // ---- vocabulary ------------------------------------------------------------
  var STOP = ('a an the this that these those it its them they their there here my me mine i im ive id we our us you your ' +
    'please pls plz can could would will should shall want wanna need needs like just do does did doing done is are was were be been being am ' +
    'to into onto in inside on of for from with within by at as and or nor so then than also too some any all every each ' +
    'everything whole entire full note notes doc document text texts selection selected highlighted stuff thing things ' +
    'make made makes turn get got give put let lets set up out off over again instead way using use via more most much ' +
    'what whats how which where when who why something anything one per first last very really quick quickly same other others ' +
    'not no dont without widget widgets tool tools script scripts command thanks thank hey ok okay now? ').split(/\s+/);
  var STOP_SET = {};
  STOP.forEach(function (w) { if (w && w.slice(-1) !== '?') STOP_SET[w] = 1; });
  // Words that say "a widget, please" — dropped as tokens, kept as a hint.
  var WIDGET_HINT = { open: 1, launch: 1, start: 1, show: 1, bring: 1, play: 1, begin: 1, display: 1, view: 1, see: 1, go: 1 };

  // canonical concept: surface words (each also matched after stemming)
  var CONCEPTS = {
    remove: 'remove delete strip drop erase eliminate purge clear discard omit wipe',
    duplicate: 'duplicate dupe dup dups dupes duplicated repeated repeat repeating repeats',
    sort: 'sort order arrange organize organise sorted ordering',
    alpha: 'alpha',
    asc: 'ascending asc increasing oldest smallest',
    desc: 'descending desc decreasing newest latest largest biggest highest',
    length: 'length shortest longest len',
    reverse: 'reverse flip invert backwards backward reversed inverse',
    upper: 'upper caps capital capitals shout shouting allcaps',
    lower: 'lower',
    title: 'title headline',
    capitalize: 'capitalize capitalise',
    'case': 'case casing',
    shuffle: 'shuffle randomize randomise scramble jumble mix randomly',
    random: 'random rand',
    whitespace: 'whitespace space spaces spacing',
    blank: 'blank empty',
    line: 'line lines row rows',
    list: 'list lists item items',
    count: 'count counter tally',
    word: 'word words',
    character: 'character characters char chars letter letters',
    markdown: 'markdown md',
    table: 'table tables',
    url: 'url urls link links hyperlink hyperlinks uri href',
    email: 'email emails',
    convert: 'convert conversion converter transform change switch',
    extract: 'extract pull grab harvest scrape',
    sum: 'sum total totals',
    calculator: 'calculator calc calculate compute arithmetic math maths',
    timer: 'timer countdown stopwatch pomodoro',
    clock: 'clock clocks',
    color: 'color colour colors colours',
    code: 'code codes source',
    comment: 'comment comments',
    quote: 'quote quotes quotation quoted quoting',
    curly: 'curly smart typographic',
    clean: 'clean cleanup tidy neaten',
    indent: 'indent indentation dedent outdent unindent',
    bullet: 'bullet bullets bulleted',
    todo: 'todo todos checklist checkbox checkboxes task tasks',
    number: 'number numbers numeral numeric digit digits enumerate numbered',
    join: 'join merge combine concatenate concat glue',
    split: 'split separate explode divide',
    collapse: 'collapse squeeze condense',
    minify: 'minify minified compress compact uglify shrink',
    beautify: 'beautify prettify pretty format formatting formatted reformat',
    encode: 'encode encoding encoded',
    decode: 'decode decoding decoded',
    encrypt: 'encrypt encryption encrypted',
    decrypt: 'decrypt decryption decrypted',
    hash: 'hash hashes checksum digest',
    password: 'password passwords passphrase passcode',
    generate: 'generate generator create creator maker',
    weather: 'weather forecast',
    define: 'dictionary define definition meaning mean thesaurus synonym synonyms lookup',
    aloud: 'aloud speak narrate tts',
    draw: 'draw drawing sketch doodle whiteboard paint',
    game: 'game games',
    picker: 'picker pick choose chooser',
    dice: 'dice die roll',
    translate: 'translate translation translator',
    tab: 'tab tabs',
    sentence: 'sentence sentences',
    paragraph: 'paragraph paragraphs para',
    accent: 'accent accents diacritic diacritics',
    redact: 'redact censor blackout',
    box: 'box frame border',
    column: 'column columns col cols',
    recipe: 'recipe recipes',
    serving: 'serving servings portion portions',
    shop: 'shopping shop grocery groceries',
    insert: 'insert add',
    prefix: 'prefix prepend',
    suffix: 'suffix append',
    file: 'file files',
    image: 'image images picture pictures photo photos pic pics',
    send: 'send share transfer beam airdrop',
    phone: 'phone iphone laptop device devices computer',
    record: 'record recording recorder',
    breathe: 'breathe breathing breath',
    find: 'find search locate',
    replace: 'replace substitute',
    run: 'run execute exec',
    stop: 'stop cancel abort halt',
    copy: 'copy',
    heading: 'heading headings header headers',
    regex: 'regex regexp',
    statistic: 'stats statistic statistics',
    zone: 'zone zones timezone timezones',
    time: 'time times',
    date: 'date dates',
    timestamp: 'timestamp timestamps epoch',
    flatten: 'flatten',
    wrap: 'wrap wrapped wrapping',
    unwrap: 'unwrap unwrapped unfill',
    plain: 'plain plaintext',
    trim: 'trim trimmed',
    trailing: 'trailing',
    fancy: 'fancy',
    music: 'music song songs',
  };
  // One surface word that means several concepts at once.
  var MULTI = {
    unique: ['remove', 'duplicate'], uniq: ['remove', 'duplicate'], distinct: ['remove', 'duplicate'],
    dedupe: ['remove', 'duplicate'], dedup: ['remove', 'duplicate'], deduplicate: ['remove', 'duplicate'], deduped: ['remove', 'duplicate'],
    alphabetize: ['sort', 'alpha'], alphabetise: ['sort', 'alpha'], alphabetical: ['sort', 'alpha'],
    alphabetically: ['sort', 'alpha'], alphabet: ['sort', 'alpha'], abc: ['sort', 'alpha'],
    uppercase: ['upper', 'case'], uppercased: ['upper', 'case'], lowercase: ['lower', 'case'], lowercased: ['lower', 'case'],
    titlecase: ['title', 'case'], qrcode: ['qr'], wordcount: ['count', 'word'],
    unbullet: ['bullet'], untab: ['tab'], renumber: ['renumber', 'number'], slug: ['slug', 'kebab'],
  };
  // Concepts that half-match each other.
  var RELATED = {
    blank: ['whitespace'], whitespace: ['blank'], line: ['list'], list: ['line'],
    sum: ['calculator'], timer: ['clock', 'time'], clock: ['timer', 'time'], time: ['clock', 'timer', 'date'],
    date: ['time', 'timestamp'], timestamp: ['date', 'time'], trim: ['clean', 'whitespace'], clean: ['trim'],
    collapse: ['flatten'], flatten: ['collapse', 'join'], join: ['flatten'], beautify: ['indent'],
    encrypt: ['encode'], decrypt: ['decode'], picker: ['random'], random: ['picker', 'shuffle'], shuffle: ['random'],
    curly: ['quote'], word: ['character'], character: ['word'], game: ['fun'], plain: ['clean'],
  };
  // Words that refine a verb ("sort … descending") rather than pick a command:
  // capped low so they break ties between sorts instead of choosing a niche one.
  var MODIFIER = { asc: 1, desc: 1, alpha: 1 };
  // When a NAME word isn't in the query these hardly count against it — a
  // "list" or a "line" is what every note is anyway.
  var IMPLIED = { line: 0.3, list: 0.3, text: 0.3, item: 0.3, convert: 0.5, insert: 0.6, 'case': 0.8 };

  // Idioms → concept words. Run on the padded, punctuation-free text.
  var PHRASES = [
    [/\bget rid of\b/g, ' remove '], [/\btake out\b/g, ' remove '], [/\bthrow away\b/g, ' remove '],
    [/\bclean up\b/g, ' clean '], [/\btidy up\b/g, ' clean '],
    [/\bhow many\b/g, ' count '], [/\bnumber of\b/g, ' count '], [/\bword count\b/g, ' count word '],
    [/\bcharacter count\b/g, ' count character '],
    [/\b(add|total|sum) up\b/g, ' sum '], [/\badd (these |those |the |all |all the |my )?(numbers|values|figures|amounts|prices)\b/g, ' sum number '],
    [/\b(from )?a (to )?z\b/g, ' sort alpha '], [/\b(from )?z (to )?a\b/g, ' sort desc '],
    [/\breverse (alphabetical|order)\b/g, ' desc '],
    [/\ball caps\b/g, ' upper '], [/\bcapital letters\b/g, ' upper '], [/\bblock capitals\b/g, ' upper '],
    [/\bsmall letters\b/g, ' lower '],
    [/\b(capitali[sz]e|capital) (the )?(first letter (of )?)?(each|every|all)( the)? words?\b/g, ' title case '],
    [/\b(on|onto|into|to)( a| one)? (single|one) line\b/g, ' flatten '], [/\bsingle line\b/g, ' flatten '],
    [/\bpull out\b/g, ' extract '], [/\b(find|get|grab|list|show) (me )?all( the| of the)?\b/g, ' extract '],
    [/\bpretty ?print\b/g, ' beautify '],
    [/\bread (it |this )?(aloud|out loud|to me|out)\b/g, ' read aloud '], [/\bout loud\b/g, ' aloud '],
    [/\btext to speech\b/g, ' aloud speech '],
    [/\btable of contents\b/g, ' toc '], [/\blook up\b/g, ' lookup '], [/\bregular expressions?\b/g, ' regex '],
    [/\bto ?do\b/g, ' todo '], [/\bcheck ?list\b/g, ' todo '], [/\bcheck ?box(es)?\b/g, ' todo '],
    [/\bqr ?codes?\b/g, ' qr '], [/\be mail\b/g, ' email '], [/\bsmart quotes\b/g, ' curly quote '],
    [/\bsha (1|256|384|512)\b/g, ' sha$1 '], [/\bbase 64\b/g, ' base64 '],
    [/\btime ?zones?\b/g, ' zone '], [/\bbullet points?\b/g, ' bullet '], [/\bline numbers\b/g, ' number line '],
    [/\b(\d+) ?(min|mins|minute|minutes|sec|secs|second|seconds|hr|hrs|hour|hours)\b/g, ' $1 countdown '],
    [/\bmark ?down\b/g, ' markdown '], [/\bwhite ?space\b/g, ' whitespace '],
    [/\b(flip|toss)( a| the)? coins?\b/g, ' coin '], [/\bcoin (flip|toss)\b/g, ' coin '], [/\broll( a| the| some)? (dice|die)\b/g, ' dice '],
    [/\bdark mode\b/g, ' dark '], [/\bfocus mode\b/g, ' zen focus '], [/\bdistraction free\b/g, ' zen distraction '],
  ];

  // ---- normalise / stem / tokenise ----------------------------------------
  function deaccent(s) {
    try { return s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (e) { return s; }
  }
  function normalize(s) {
    s = String(s == null ? '' : s);
    s = s.replace(/\b([a-z]+)((?:[A-Z][a-z]{2,})+)\b/g, function (m, a, b) { return a + b.replace(/([A-Z])/g, ' $1'); });
    s = deaccent(s).toLowerCase();
    s = s.replace(/[↔⇄]|<->/g, ' and ').replace(/[→⇒⟶]|->|=>/g, ' to ');
    s = s.replace(/['’](s|re|ll|ve|d|t)\b/g, '$1').replace(/['’]/g, '');
    s = s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ');
    s = ' ' + s + ' ';
    for (var i = 0; i < PHRASES.length; i++) s = s.replace(PHRASES[i][0], PHRASES[i][1]);
    return s.replace(/\s+/g, ' ').trim();
  }
  function stem(w) {
    if (w.length <= 3 || /^\d+$/.test(w)) return w;
    if (w.length >= 8) w = w.replace(/is(e|es|ed|ing|ation|ations)$/, 'iz$1');
    if (/ies$/.test(w) && w.length > 4) w = w.slice(0, -3) + 'y';
    else if (/sses$/.test(w)) w = w.slice(0, -2);
    else if (/(x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
    else if (/[^su]s$/.test(w)) w = w.slice(0, -1);
    if (/ing$/.test(w) && w.length >= 6) w = w.slice(0, -3);
    else if (/ed$/.test(w) && w.length >= 5) w = w.slice(0, -2);
    else if (/ly$/.test(w) && w.length >= 6) w = w.slice(0, -2);
    if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) w = w.slice(0, -1);
    if (/e$/.test(w) && w.length > 4) w = w.slice(0, -1);
    return w;
  }
  var LOOKUP = {};
  (function () {
    function put(word, cs) { LOOKUP[word] = cs; var st = stem(word); if (!LOOKUP[st]) LOOKUP[st] = cs; }
    Object.keys(CONCEPTS).forEach(function (c) { CONCEPTS[c].split(/\s+/).forEach(function (w) { if (w) put(w, [c]); }); });
    Object.keys(MULTI).forEach(function (w) { put(w, MULTI[w]); });
  })();
  function conceptsOf(word) {
    if (LOOKUP[word]) return LOOKUP[word];
    var st = stem(word);
    return LOOKUP[st] || [st];
  }
  // → { toks: [{ w: surface, c: concept, pos }], numbers: [], widget: bool }
  function analyze(text) {
    var norm = normalize(text), words = norm ? norm.split(' ') : [];
    var toks = [], numbers = [], widget = false, pos = 0;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      if (/^\d+$/.test(w)) { numbers.push(+w); toks.push({ w: w, c: w, pos: pos++, num: true }); continue; }
      if (WIDGET_HINT[w]) { widget = true; if (w === 'play') toks.push({ w: w, c: 'game', pos: pos++, soft: true }); continue; }
      if (w.length < 2 || STOP_SET[w]) continue;
      var cs = conceptsOf(w);
      for (var j = 0; j < cs.length; j++) toks.push({ w: w, c: cs[j], pos: pos });
      pos++;
    }
    return { norm: norm, toks: toks, numbers: numbers, widget: widget };
  }
  function uniqConcepts(toks) {
    var seen = {}, out = [];
    toks.forEach(function (t) { if (!seen[t.c]) { seen[t.c] = 1; out.push(t.c); } });
    return out;
  }

  // ---- catalogue index ----------------------------------------------------
  // commands: [{ name, description, tags, kind }] (Cade.commands() rows or the
  // palette's own rows — kind falls back to __widget).
  function buildIndex(commands) {
    var items = [], df = {}, vocab = {};
    (commands || []).forEach(function (c) {
      if (!c || !c.name) return;
      var nameA = analyze(String(c.name).replace(/\([^)]*[^\x00-\x7f][^)]*\)/g, ' '));
      var name = {}, tags = {}, desc = {};
      nameA.toks.forEach(function (t) { name[t.c] = 1; });
      var tagPhrases = [];
      String(c.tags || '').split(',').forEach(function (tg) {
        var a = analyze(tg);
        a.toks.forEach(function (t) { tags[t.c] = 1; });
        if (a.norm.indexOf(' ') > 0) tagPhrases.push(a.norm);
      });
      analyze(c.description || '').toks.forEach(function (t) { desc[t.c] = 1; });
      var all = {};
      [name, tags, desc].forEach(function (f) { for (var k in f) all[k] = 1; });
      for (var k in all) { df[k] = (df[k] || 0) + 1; vocab[k] = 1; }
      // "X → Y" / "X to Y" names: which concepts sit on which side.
      var dir = null, raw = deaccent(String(c.name)).toLowerCase();
      var m = raw.split(/\s*(?:→|->|\bto\b)\s*/);
      if (m.length === 2 && m[0].trim() && m[1].trim()) {
        dir = { src: uniqConcepts(analyze(m[0]).toks), dst: uniqConcepts(analyze(m[1]).toks) };
        if (!dir.src.length || !dir.dst.length) dir = null;
      }
      items.push({
        cmd: c, name: c.name, key: String(c.name).toLowerCase(),
        kind: c.kind || (c.__widget ? 'widget' : 'script'),
        nameList: uniqConcepts(nameA.toks), nameNorm: nameA.norm, words: nameA.norm.split(' ').length,
        tagPhrases: tagPhrases, fields: [name, tags, desc], dir: dir,
      });
    });
    var n = items.length || 1, idf = {}, sum = 0, cnt = 0;
    for (var k2 in df) { idf[k2] = Math.log(1 + n / df[k2]); sum += idf[k2]; cnt++; }
    return { items: items, idf: idf, vocab: Object.keys(vocab), n: n, avgIdf: cnt ? sum / cnt : 1, maxIdf: Math.log(1 + n) };
  }

  // ---- learning -------------------------------------------------------------
  var MAX_PHRASES = 200;
  function memoryKey(query) { return uniqConcepts(analyze(query).toks).sort().join(' '); }
  function learn(memory, query, name, now) {
    memory = memory && typeof memory === 'object' && memory.p ? memory : { v: 1, p: {} };
    var key = memoryKey(query);
    if (!key || !name) return memory;
    var e = memory.p[key] || (memory.p[key] = { n: {}, t: 0 });
    e.n[name] = (e.n[name] || 0) + 1;
    e.t = now || Date.now();
    var keys = Object.keys(memory.p);
    if (keys.length > MAX_PHRASES) {
      keys.sort(function (a, b) { return memory.p[a].t - memory.p[b].t; });
      for (var i = 0; i < keys.length - MAX_PHRASES; i++) delete memory.p[keys[i]];
    }
    return memory;
  }
  function jaccard(a, b) {
    var sa = {}, inter = 0, uni = 0;
    a.forEach(function (x) { sa[x] = 1; });
    b.forEach(function (x) { if (sa[x]) inter++; });
    uni = a.length + b.length - inter;
    return uni ? inter / uni : 0;
  }
  // name(lowercase) → boost from earlier picks of this (or a very similar) phrase.
  function learnedBoosts(memory, key) {
    var out = {};
    if (!memory || !memory.p || !key) return out;
    var qa = key.split(' ');
    for (var k in memory.p) {
      var sim = k === key ? 1 : jaccard(qa, k.split(' '));
      if (sim < 0.6) continue;
      var e = memory.p[k], f = sim === 1 ? 0.45 : 0.18 * sim;
      for (var nm in e.n) {
        var c = e.n[nm], b = f * Math.min(1, (c + 1) / 3);
        var lk = nm.toLowerCase();
        if (!out[lk] || out[lk] < b) out[lk] = b;
      }
    }
    return out;
  }

  // ---- ranking --------------------------------------------------------------
  var FIELD_W = [1, 0.7, 0.45];
  // query → [{ name, kind, cmd, score, confidence, confident, matched: [query words], terms: [concepts] }]
  function rank(query, index, opts) {
    opts = opts || {};
    if (!index || !index.items) return [];
    var q = analyze(query);
    var qc = uniqConcepts(q.toks);
    var limit = opts.limit || 6, minScore = opts.minScore == null ? 0.2 : opts.minScore;
    var learned = learnedBoosts(opts.memory, qc.slice().sort().join(' '));
    if (!qc.length && !Object.keys(learned).length) return [];
    // Weights: rarity of the concept; unknown words count a little (they make
    // every match less certain) and unknown numbers not at all.
    var surface = {}, isNum = {}, firstPos = {};
    q.toks.forEach(function (t) {
      (surface[t.c] || (surface[t.c] = [])).indexOf(t.w) < 0 && surface[t.c].push(t.w);
      if (t.num) isNum[t.c] = 1;
      if (firstPos[t.c] == null) firstPos[t.c] = t.pos;
    });
    var onlyMods = qc.every(function (c) { return MODIFIER[c]; }), modHit;
    var w = {}, wsum = 0;
    qc.forEach(function (c) {
      var x = index.idf[c];
      if (x == null) x = isNum[c] ? 0 : index.avgIdf * 0.6;
      else if (isNum[c]) x *= 0.3;
      // A modifier next to a real word only breaks ties (bonus below).
      if (MODIFIER[c] && !onlyMods) x = 0;
      w[c] = x; wsum += x;
    });
    // Fuzzy partners per query concept: related concepts (0.5) and 4+ letter
    // stems where one prefixes the other (0.75, or 0.35 for a known word).
    var partners = {};
    qc.forEach(function (c) {
      var p = {};
      (RELATED[c] || []).forEach(function (r) { p[r] = 0.5; });
      if (c.length >= 4 && !isNum[c]) {
        // A word the catalogue itself uses ("wordle") prefers its exact
        // home over a looser prefix ("word").
        var pf = index.idf[c] != null ? 0.35 : 0.75;
        for (var i = 0; i < index.vocab.length; i++) {
          var v = index.vocab[i];
          if (v !== c && v.length >= 4 && (v.indexOf(c) === 0 || c.indexOf(v) === 0)) p[v] = Math.max(p[v] || 0, pf);
        }
      }
      partners[c] = p;
    });
    var out = [];
    for (var ii = 0; ii < index.items.length; ii++) {
      var it = index.items[ii], F = it.fields, got = 0, gotAny = 0, matched = [], terms = [];
      modHit = false;
      var covered = {};
      for (var a = 0; a < qc.length; a++) {
        var c = qc[a], best = 0, hitName = null;
        for (var f = 0; f < (isNum[c] ? 2 : 3); f++) {   // numbers: name / tags only
          if (F[f][c]) { if (FIELD_W[f] > best) { best = FIELD_W[f]; if (f === 0) hitName = c; } continue; }
          var p = partners[c];
          for (var pc in p) if (F[f][pc]) { var s = FIELD_W[f] * p[pc]; if (s > best) { best = s; hitName = f === 0 ? pc : hitName; } }
        }
        if (best > 0) {
          if (MODIFIER[c]) modHit = true;
          got += w[c] * best; gotAny += w[c];
          terms.push(c);
          surface[c].forEach(function (sw) { if (matched.indexOf(sw) < 0) matched.push(sw); });
          if (F[0][c]) covered[c] = 1;
          else for (var pc2 in partners[c]) if (F[0][pc2]) covered[pc2] = Math.max(covered[pc2] || 0, partners[c][pc2]);
        }
      }
      var boost = learned[it.key] || 0;
      if (!got && !boost) continue;
      var sq = wsum ? got / wsum : 0;
      var nw = 0, ncov = 0;
      it.nameList.forEach(function (nc) {
        var x = index.idf[nc] || 0;
        if (MODIFIER[nc]) x = Math.min(x, index.avgIdf * 0.5);
        if (IMPLIED[nc] != null && !covered[nc]) x *= IMPLIED[nc];
        nw += x; ncov += x * (covered[nc] || 0);
      });
      var cn = nw ? ncov / nw : 0;
      var score = 0.62 * sq + 0.38 * cn;
      if (wsum && gotAny >= wsum - 1e-9) score += 0.08;   // explains every word of the query
      if (modHit && !onlyMods) score += 0.06;
      var qn = ' ' + q.norm + ' ';
      // The whole name (or a multi-word tag such as "tip calculator") said in the query.
      if (it.nameNorm.length >= 4 && qn.indexOf(' ' + it.nameNorm + ' ') >= 0) score += it.nameList.length > 1 ? 0.12 : 0.05;
      for (var tp = 0; tp < it.tagPhrases.length; tp++) if (qn.indexOf(' ' + it.tagPhrases[tp] + ' ') >= 0) { score += 0.2; break; }
      score -= 0.003 * it.words;   // ties go to the simpler command
      if (it.dir) {
        var sp = minPos(it.dir.src, firstPos), dp = minPos(it.dir.dst, firstPos);
        if (sp != null && dp != null) score += sp < dp ? 0.1 : -0.15;
      }
      if (q.widget && it.kind === 'widget') score += 0.06;
      if (opts.hasSelection && it.kind === 'script') score += 0.02;
      score += boost;
      if (score < minScore) continue;
      out.push({ name: it.name, kind: it.kind, cmd: it.cmd, score: score, sq: sq, matched: matched, terms: terms, learned: boost > 0 });
    }
    out.sort(function (x, y) { return y.score - x.score || (x.name < y.name ? -1 : 1); });
    out = out.slice(0, limit);
    out.forEach(function (r, i) {
      var next = out[i + 1] ? out[i + 1].score : 0;
      r.confidence = Math.max(0, Math.min(1, r.score));
      r.confident = r.score >= 0.5 && r.sq >= 0.5 && (i > 0 || r.score - next >= 0.02 || r.learned);
    });
    return out;
  }
  function minPos(list, firstPos) {
    var m = null;
    list.forEach(function (c) { if (firstPos[c] != null && (m == null || firstPos[c] < m)) m = firstPos[c]; });
    return m;
  }

  // ---- palette ranking ------------------------------------------------------
  // rows: the palette's source rows; oldScore(q, row): its existing scorer
  // (name exact 1000 / prefix 900 / substring 800 / tags / description / fuzzy).
  // → [{ row, hint }] best first. Name hits keep today's order on top (and a
  // one-word query's exact tag hits stay next); every other row is ordered by
  // intent score, then by the old score.
  function blend(query, rows, oldScore, opts) {
    opts = opts || {};
    var q = String(query || '').trim();
    var scored = rows.map(function (row, i) { return { row: row, old: oldScore(q, row), i: i, key: 0, hint: '' }; });
    var res = q.length >= 3 && opts.index ? rank(q, opts.index, { memory: opts.memory, hasSelection: opts.hasSelection, limit: 40, minScore: 0.2 }) : [];
    var byName = {};
    res.forEach(function (r) { byName[String(r.name).toLowerCase()] = r; });
    var oneWord = !/\s/.test(q);
    scored.forEach(function (s) {
      if (s.old >= 800) { s.key = 2000 + s.old; return; }
      var r = byName[String(s.row.name || '').toLowerCase()];
      // One word that is exactly a tag (old 700) keeps that tier, in today's order.
      if (oneWord && s.old === 700) { s.key = 1800; return; }
      if (r) { s.key = 1000 + r.score * 500 + s.old / 1000; s.hint = r.matched.join(', '); s.intent = r; }
      else s.key = s.old;
    });
    var list = scored.filter(function (s) { return s.key > 0; })
      .sort(function (a, b) { return b.key - a.key || a.i - b.i; });
    // Intent near-ties (within 0.015) fall back to today's order — old score,
    // then palette position — so equal matches don't shuffle familiar rows.
    for (var g = 0; g < list.length;) {
      var e = g + 1;
      if (list[g].intent) while (e < list.length && list[e].intent && list[g].intent.score - list[e].intent.score < 0.015) e++;
      if (e - g > 1) {
        var grp = list.slice(g, e).sort(function (a, b) { return b.old - a.old || a.i - b.i; });
        for (var k = 0; k < grp.length; k++) list[g + k] = grp[k];
      }
      g = e;
    }
    return list.map(function (s) { return { row: s.row, hint: s.hint, intent: s.intent || null }; });
  }

  var api = {
    normalize: normalize, stem: stem, analyze: analyze, conceptsOf: conceptsOf,
    buildIndex: buildIndex, rank: rank, blend: blend,
    learn: learn, memoryKey: memoryKey, MAX_PHRASES: MAX_PHRASES,
    CONCEPTS: CONCEPTS, STOP: STOP_SET,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.__cadeIntentCore = api;
})(typeof window !== 'undefined' ? window : null);
