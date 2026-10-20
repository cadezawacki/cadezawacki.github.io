/* Typing Test — how fast and how accurately can you type?
 *
 * Modes: TIME (15 / 30 / 60 / 120 s of endless common words), WORDS (10 / 25 /
 * 50 / 100 words), PASSAGE (a short paragraph) and NOTE (a stretch of the note
 * you have open — practise on your own words). Punctuation and numbers can be
 * mixed into the word modes.
 *
 * Type the highlighted text; space moves to the next word (a word left wrong
 * stays marked, and Backspace on an empty word steps back into it). The clock
 * starts on the first key. WPM counts the characters of correctly typed words
 * (plus their spaces) / 5 per minute; raw WPM counts everything typed;
 * accuracy is right key presses / all key presses. The result shows a WPM-
 * per-second graph in block characters, the character breakdown and whether
 * it's a personal best for that exact setup; history keeps the last 100 runs.
 *
 * Input goes through one real (invisible) text field, so the phone keyboard
 * works, autocorrect is off and predictive text that drops in a whole word is
 * judged like typing it. Tab restarts; Esc closes. A 100 ms ticker runs only
 * during a test, and stops on finish, restart, minimize and close.
 * The engine below is pure and unit-tested: node txt/widgets/typing/typing.test.js */
(function () {
  'use strict';

  // ================= engine (pure) =================
  var COMMON = ('the be of and a to in he have it that for they with as not on she at by this we you do but from or which one would all will there say who make when can more if no man out other so what time up go about than into could state only new year some take come these know see use get like then first any work now may such give over think most even find day also after way many must look before great back through long where much should well people down own just because good each those feel seem how high too place little world very still nation hand old life tell write become here show house both between need mean call develop under last right move thing general school never same another begin while number part turn real leave might want point form off child few small since against ask late home interest large person end open public follow during present without again hold govern around possible head consider word program problem however lead system set order eye plan run keep face fact group play stand increase early course change help line city put close case force meet once water upon war build hear light unite live every country bring center let side try provide continue name certain power pay result question study woman member until far night always service away report something company week church toward start social room figure nature though young less enough almost read include president nothing yet better big boy cost business value second why clear expect family complete act sense mind experience art next near direct car law industry important girl god several matter usual rather per often kind among white reason action return foot care simple within love human along appear doctor believe speak active student month drive concern best door hope example inform body ever least probable understand reach effect different idea whole control condition field pass fall note special talk particular today measure walk teach low hour type carry rate remain full street easy although record sit determine level local sure receive thus moment spirit train college religion perhaps music grow free cause serve age book board recent sound office cut step class true history position above strong friend necessary add court deal tax support party whether either land material happen education death agree arm mother across quite anything town past view society manage answer break organize half fire lose money stop actual already effort wait department able political learn voice air together shall cover common subject draw short wife treat limit road letter color behind produce send term total university rise century success minute remember purpose test fight watch situation south ago difference stage father table rest bear entire market prepare explain offer plant charge community').split(' ');
  var PASSAGES = [
    'The best way to get better at typing is to type a little every day. Speed comes on its own once your fingers stop looking for the keys.',
    'A plain text file is the most patient thing on a computer. It does not care what app opened it, and it will still be readable long after the app is gone.',
    'Rain had been falling since breakfast, so the market moved under the bridge. Somebody sold coffee from a bicycle, and the line for it reached the river.',
    'Good notes are written for the person you will be next month. That person is tired, in a hurry, and has forgotten almost everything you know right now.',
    'The train left four minutes early, which in that town was considered a small scandal. By noon everyone had an opinion, and nobody had missed it.',
    'She kept a list of questions she could not answer yet. Every few weeks one of them would quietly turn into something she knew.',
    'Measure twice and cut once is good advice for wood. For writing it is the other way around: cut freely, then measure what is left.',
    'The lighthouse keeper wrote the weather in the log at six, at noon and at six again. On calm days the entries were one word long.',
    'Most bugs are not clever. They are small, ordinary mistakes standing in a place where nobody thought to look.',
    'At the top of the hill the wind was strong enough to lean on. Below, the whole valley was green, and the road looked like a thread.',
    'A good recipe tells you what to do when things go wrong: if the dough is sticky, add flour a spoon at a time, and stop when it stops clinging.',
    'He practised the same four bars for an hour, slowly at first, then a little faster, until his hands knew the way without him.',
    'The library was quiet except for the radiator, which knocked twice every few minutes as if it wanted to be let out.',
    'Never trust a map that has no scale. It may be beautiful, but it cannot tell you whether the next town is an hour away or a week.',
    'The cat sat in the exact centre of the newspaper, which is where cats believe the important news is printed.',
    'Every big project is a lot of small days. Most of them feel like nothing is happening, and then one morning it is finished.',
    'The kettle clicked off, the toast jumped up, and for one perfect second everything in the kitchen was ready at the same time.',
    'If you can explain an idea to a curious twelve year old, you understand it. If you cannot, you have found the part you still need to learn.',
    'They walked along the beach looking for flat stones, and argued for a mile about whether seven skips was a record or just luck.',
    'Snow turned the city soft and slow. Buses crawled, voices dropped, and the streets sounded like a room full of carpet.',
    'Write the first draft quickly and badly. A page that exists can be fixed; a perfect page that only exists in your head cannot.',
    'Twelve chairs, three tables, one piano with a sticky C, and a sign on the door that said the band would start whenever the drummer arrived.',
    'The old bridge has been repaired so many times that hardly a single original stone remains, yet everyone still calls it the old bridge.',
    'Clear instructions are a kindness. They save someone you will never meet from an afternoon of guessing.'
  ];
  var TIMES = [15, 30, 60, 120], COUNTS = [10, 25, 50, 100];

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // n random common words; punct: capitals after full stops + , . ? ! ; :
  // and the odd "quote"; nums: about one word in eight becomes a number.
  function genWords(n, opts, r) {
    opts = opts || {}; r = r || Math.random;
    var out = [], cap = true, last = '';
    for (var i = 0; i < n; i++) {
      var w;
      if (opts.nums && r() < 0.12) w = String(Math.floor(r() * (r() < 0.5 ? 100 : 10000)));
      else {
        do { w = COMMON[Math.floor(r() * COMMON.length)]; } while (w === last && COMMON.length > 1);
      }
      last = w;
      if (opts.punct) {
        if (cap && /^[a-z]/.test(w)) w = w.charAt(0).toUpperCase() + w.slice(1);
        cap = false;
        var p = r();
        if (i === n - 1 || p < 0.09) { w += '.'; cap = true; }
        else if (p < 0.17) w += ',';
        else if (p < 0.19) { w += '?'; cap = true; }
        else if (p < 0.2) { w += '!'; cap = true; }
        else if (p < 0.215) w += ';';
        else if (p < 0.225) w += ':';
        else if (p < 0.24) w = '"' + w + '"';
      }
      out.push(w);
    }
    return out;
  }
  // Up to max words of a note, Markdown and app syntax stripped, starting near
  // `at` (0..1 through the text). Returns [] when the note has too little prose.
  function noteWords(text, max, at) {
    var t = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[(?:img|file):[^\]]*\]/g, ' ')
      .replace(/%%[^|%]*\|([^%]*)%%/g, '$1')
      .replace(/\|\|([^|]*)\|\|/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(?:(?:#{1,6}|>|[-*+•]|\d+[.)]|\[[ xX]\]|\[\d+\])\s+)+/gm, '')
      .replace(/[*_`~#>|\\]/g, ' ')
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
      .replace(/[^\x20-\x7E\n]/g, ' ');
    var words = t.split(/\s+/).filter(function (w) { return w && w.length <= 24; });
    if (words.length < 8) return [];
    max = max || 60;
    var start = Math.max(0, Math.min(words.length - max, Math.floor((at || 0) * words.length)));
    // begin on a sentence start when one is close by
    for (var k = start; k > Math.max(0, start - 25); k--) if (k === 0 || /[.!?]$/.test(words[k - 1])) { start = k; break; }
    return words.slice(start, start + max);
  }
  function passageWords(i) { return PASSAGES[((i % PASSAGES.length) + PASSAGES.length) % PASSAGES.length].split(' '); }

  // Score a run. words: targets; typed: what was typed per word (up to cur);
  // cur: index of the word being typed; done: the run ended (count the word in
  // progress); keys: {ok, bad} key presses; ms: elapsed time.
  function score(words, typed, cur, done, keys, ms) {
    var c = { correct: 0, incorrect: 0, extra: 0, missed: 0 }, good = 0, all = 0, i, j;
    var last = done ? Math.min(cur, words.length - 1) : cur - 1;
    for (i = 0; i <= last; i++) {
      var w = words[i], t = typed[i] || '', committed = i < cur;
      if (!committed && !t) continue;
      for (j = 0; j < Math.max(w.length, t.length); j++) {
        if (j >= t.length) { if (committed) c.missed++; }
        else if (j >= w.length) c.extra++;
        else if (t.charAt(j) === w.charAt(j)) c.correct++;
        else c.incorrect++;
      }
      all += t.length + (committed ? 1 : 0);
      if (t === w) good += w.length + (committed ? 1 : 0);
      else if (!committed) { for (j = 0; j < t.length && t.charAt(j) === w.charAt(j); j++); if (j === t.length) good += j; }
    }
    var min = Math.max(ms, 1) / 60000, kk = (keys.ok || 0) + (keys.bad || 0);
    return {
      wpm: good / 5 / min, raw: all / 5 / min, acc: kk ? keys.ok / kk * 100 : 100,
      chars: c, good: good, words: cur + (done && typed[cur] === words[cur] ? 1 : 0)
    };
  }
  // Judge one change of the field's text against the target word: new chars
  // past the common prefix are key presses, right or wrong where they landed.
  function judge(prev, next, target, keys) {
    var p = 0;
    while (p < prev.length && p < next.length && prev.charAt(p) === next.charAt(p)) p++;
    for (var i = p; i < next.length; i++) { if (next.charAt(i) === target.charAt(i)) keys.ok++; else keys.bad++; }
    return keys;
  }
  var BARS = ' ▁▂▃▄▅▆▇█';
  // A row of block characters for a series (bucketed down to width columns).
  function spark(vals, width, top) {
    if (!vals.length) return '';
    width = Math.max(1, Math.min(width || vals.length, vals.length));
    var cols = [], i;
    for (i = 0; i < width; i++) {
      var a = Math.floor(i * vals.length / width), b = Math.max(a + 1, Math.floor((i + 1) * vals.length / width)), s = 0;
      for (var k = a; k < b; k++) s += vals[k];
      cols.push(s / (b - a));
    }
    var hi = top || Math.max.apply(null, cols) || 1;
    return cols.map(function (v) { return BARS.charAt(Math.max(v > 0 ? 1 : 0, Math.min(8, Math.round(v / hi * 8)))); }).join('');
  }
  function configKey(o) {
    var k = o.mode === 'time' ? 'time ' + o.time : o.mode === 'words' ? 'words ' + o.count : o.mode;
    if ((o.mode === 'time' || o.mode === 'words') && (o.punct || o.nums)) k += (o.punct ? ' +punct' : '') + (o.nums ? ' +num' : '');
    return k;
  }

  var Engine = { COMMON: COMMON, PASSAGES: PASSAGES, rng: rng, genWords: genWords, noteWords: noteWords, passageWords: passageWords, score: score, judge: judge, spark: spark, configKey: configKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ================= widget =================
  var Cade = window.Cade;
  Cade.loadCSS('typing.css');
  var PANEL_ID = 'typing-panel', PREFS_KEY = 'cade-typing-prefs', HIST_KEY = 'cade-typing-history';
  var esc = function (s) { return Cade.escapeHtml(String(s)); };
  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function now() { return window.performance && performance.now ? performance.now() : Date.now(); }

  var prefs = { mode: 'time', time: 30, count: 25, punct: false, nums: false, live: true, passage: 0 };
  var hist = [];
  function loadAll() {
    try { var p = JSON.parse(sget(PREFS_KEY) || 'null'); if (p && typeof p === 'object') for (var k in prefs) if (k in p) prefs[k] = p[k]; } catch (e) {}
    if (TIMES.indexOf(prefs.time) < 0) prefs.time = 30;
    if (COUNTS.indexOf(prefs.count) < 0) prefs.count = 25;
    if (['time', 'words', 'passage', 'note'].indexOf(prefs.mode) < 0) prefs.mode = 'time';
    try { var h = JSON.parse(sget(HIST_KEY) || '[]'); hist = Array.isArray(h) ? h : []; } catch (e) { hist = []; }
  }
  function savePrefs() { sset(PREFS_KEY, JSON.stringify(prefs)); }
  function saveHist() { sset(HIST_KEY, JSON.stringify(hist.slice(-100))); }

  var P = null, el = {}, T = null, tick = 0, lastSec = 0;

  function bodyHtml() {
    function seg(name, items) {
      return '<div class="ty-seg" data-seg="' + name + '">' + items.map(function (it) {
        return '<button type="button" class="ty-sb" data-' + name + '="' + it[0] + '">' + it[1] + '</button>';
      }).join('') + '</div>';
    }
    return '<div class="ty">' +
      '<div class="ty-bar">' +
        seg('mode', [['time', 'time'], ['words', 'words'], ['passage', 'passage'], ['note', 'my note']]) +
        '<button type="button" class="ty-ib" data-act="hist" title="History and bests" aria-label="History">≡</button>' +
      '</div>' +
      '<div class="ty-bar ty-sub">' +
        '<span class="ty-opt ty-opt-time">' + seg('time', TIMES.map(function (t) { return [t, t + 's']; })) + '</span>' +
        '<span class="ty-opt ty-opt-words">' + seg('count', COUNTS.map(function (n) { return [n, String(n)]; })) + '</span>' +
        '<span class="ty-opt ty-opt-mix"><button type="button" class="ty-tg" data-tog="punct" title="Punctuation and capitals">@ punct</button>' +
        '<button type="button" class="ty-tg" data-tog="nums" title="Numbers">#&nbsp;num</button></span>' +
        '<span class="ty-opt ty-opt-text"><span class="ty-src"></span></span>' +
      '</div>' +
      '<div class="ty-live" aria-live="off"><span class="ty-clock"></span><span class="ty-lw"></span><span class="ty-sp"></span><span class="ty-hint">tab = restart</span></div>' +
      '<div class="ty-box" data-act="focus">' +
        '<div class="ty-words" aria-hidden="true"></div>' +
        '<div class="ty-cover"><span>tap here and start typing</span></div>' +
        '<input class="ty-in" type="text" aria-label="Type the text shown" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="next">' +
      '</div>' +
      '<div class="ty-res" hidden></div>' +
      '<div class="ty-hist" hidden></div>' +
      '<div class="ty-foot">' +
        '<button type="button" class="ty-btn" data-act="restart" title="Same text again (Tab)">↻ restart</button>' +
        '<button type="button" class="ty-btn" data-act="next" title="New text">→ new text</button>' +
      '</div>' +
    '</div>';
  }
  function q(s) { return P.querySelector(s); }

  function paintBar() {
    var segs = P.querySelectorAll('[data-mode],[data-time],[data-count]');
    for (var i = 0; i < segs.length; i++) {
      var b = segs[i], on = b.hasAttribute('data-mode') ? b.getAttribute('data-mode') === prefs.mode
        : b.hasAttribute('data-time') ? +b.getAttribute('data-time') === prefs.time : +b.getAttribute('data-count') === prefs.count;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    P.querySelector('[data-tog="punct"]').classList.toggle('on', !!prefs.punct);
    P.querySelector('[data-tog="nums"]').classList.toggle('on', !!prefs.nums);
    P.setAttribute('data-mode', prefs.mode);
  }

  // ---- a test ----
  function newText(same) {
    var words;
    if (same && T && T.mode === prefs.mode) words = T.words.slice();
    else if (prefs.mode === 'time') words = genWords(120, prefs);
    else if (prefs.mode === 'words') words = genWords(prefs.count, prefs);
    else if (prefs.mode === 'passage') { if (!same) prefs.passage = (prefs.passage + 1 + Math.floor(Math.random() * (PASSAGES.length - 1))) % PASSAGES.length; words = passageWords(prefs.passage); }
    else {
      var ed = Cade.editor, txt = ed ? ed.state.doc.toString() : '';
      var at = ed && txt.length ? ed.state.selection.main.head / txt.length : 0;
      if (!same && T && T.mode === 'note') at = Math.random();
      words = noteWords(txt, 50, at);
      if (!words.length) { words = passageWords(prefs.passage); T0src = 'this note has too little text — using a passage'; }
    }
    return words;
  }
  var T0src = '';
  function start(same) {
    stopTick();
    T0src = '';
    var words = newText(same);
    T = { mode: prefs.mode, words: words, typed: [''], cur: 0, keys: { ok: 0, bad: 0 }, t0: 0, end: 0, samples: [], errs: [], done: false,
      key: configKey(prefs), limit: prefs.mode === 'time' ? prefs.time * 1000 : 0 };
    savePrefs();
    el.src.textContent = T0src || (prefs.mode === 'passage' ? 'passage ' + (prefs.passage + 1) + ' of ' + PASSAGES.length : prefs.mode === 'note' ? 'from the note you have open' : '');
    el.res.hidden = true; el.hist.hidden = true; el.box.hidden = false; el.live.hidden = false;
    P.classList.remove('ty-run');
    el.inp.value = '';
    renderAll();
    paintLive();
    focusIn();
  }
  function renderAll() {
    var h = '';
    for (var i = 0; i < T.words.length; i++) h += '<span class="ty-w" data-i="' + i + '">' + wordInner(i) + '</span> ';
    el.words.innerHTML = h;
    el.words.scrollTop = 0;
    placeLines();
  }
  function wordInner(i) {
    var w = T.words[i], t = T.typed[i] || '', s = '', n = Math.max(w.length, t.length);
    for (var j = 0; j < n; j++) {
      var cls = j >= t.length ? '' : j >= w.length ? 'x' : t.charAt(j) === w.charAt(j) ? 'k' : 'b';
      if (i === T.cur && j === t.length) cls += ' c';
      s += '<i' + (cls ? ' class="' + cls.trim() + '"' : '') + '>' + esc(j < w.length ? w.charAt(j) : t.charAt(j)) + '</i>';
    }
    return s;
  }
  function paintWord(i) {
    var we = el.words.children[i];
    if (!we) return;
    we.innerHTML = wordInner(i);
    var t = T.typed[i] || '';
    we.classList.toggle('ty-cw', i === T.cur);
    we.classList.toggle('ty-end', i === T.cur && t.length >= T.words[i].length);
    we.classList.toggle('ty-err', i < T.cur && t !== T.words[i]);
  }
  // Keep the current word on the box's first or second line (3 lines show).
  function placeLines() {
    var we = el.words.children[T.cur];
    if (!we) return;
    var lh = parseFloat(getComputedStyle(el.words).lineHeight) || 30;
    var top = we.offsetTop;
    var want = Math.max(0, top - lh);
    if (Math.abs(el.words.scrollTop - want) > 2) el.words.scrollTop = want;
  }

  function onInput() {
    if (!T || T.done) return;
    var v = el.inp.value;
    if (!T.t0 && v) beginRun();
    var sp = v.indexOf(' ');
    if (sp >= 0) {
      var head = v.slice(0, sp), rest = v.slice(sp + 1).replace(/^ +/, '');
      setTyped(head);
      if (head.length) commit();
      el.inp.value = rest;
      if (rest) setTyped(rest);
    } else setTyped(v);
    if (!T.done && T.mode !== 'time' && T.cur === T.words.length - 1 && T.typed[T.cur] === T.words[T.cur]) finish();
  }
  function setTyped(v) {
    var prev = T.typed[T.cur] || '';
    if (v === prev) return;
    judge(prev, v, T.words[T.cur], T.keys);
    T.typed[T.cur] = v;
    paintWord(T.cur);
  }
  function commit() {
    var i = T.cur;
    if (T.typed[i] !== T.words[i]) T.keys.bad++; else T.keys.ok++;  // the space itself
    if (i >= T.words.length - 1) { T.cur = i + 1; finish(); return; }
    T.cur = i + 1;
    T.typed[T.cur] = '';
    paintWord(i);
    paintWord(T.cur);
    if (T.mode === 'time' && T.words.length - T.cur < 40) extendWords();
    placeLines();
  }
  function extendWords() {
    var more = genWords(60, prefs), h = '';
    for (var k = 0; k < more.length; k++) { T.words.push(more[k]); h += '<span class="ty-w" data-i="' + (T.words.length - 1) + '">' + wordInner(T.words.length - 1) + '</span> '; }
    el.words.insertAdjacentHTML('beforeend', h);
  }
  function onKeyDown(e) {
    if (e.key === 'Tab') { e.preventDefault(); start(true); return; }
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (T && !T.done && el.inp.value) { el.inp.value += ' '; onInput(); } return; }
    // Backspace on an empty word steps back into the previous one if it was left wrong.
    if (e.key === 'Backspace' && T && !T.done && !el.inp.value && T.cur > 0 && T.typed[T.cur - 1] !== T.words[T.cur - 1]) {
      e.preventDefault();
      var i = T.cur;
      T.typed[i] = '';
      T.cur = i - 1;
      paintWord(i); paintWord(T.cur);
      el.inp.value = T.typed[T.cur];
      placeLines();
    }
  }

  function beginRun() {
    T.t0 = now(); lastSec = 0;
    P.classList.add('ty-run');
    tick = setInterval(onTick, 100);
  }
  function stopTick() { if (tick) { clearInterval(tick); tick = 0; } }
  function elapsed() { return T && T.t0 ? (T.end || now()) - T.t0 : 0; }
  function onTick() {
    if (!P || !T || T.done) { stopTick(); return; }
    if (Cade.isMinimized && Cade.isMinimized(P)) { start(true); return; }  // parked: this run doesn't count
    var ms = elapsed(), sec = Math.floor(ms / 1000);
    while (lastSec < sec) {                       // one sample per whole second
      lastSec++;
      var s = score(T.words, T.typed, T.cur, true, T.keys, lastSec * 1000);
      var prevGood = T.samples.goodAt || 0;
      T.samples.push(Math.max(0, (s.good - prevGood) / 5 * 60));   // this second's pace
      T.samples.goodAt = s.good;
      var bad = s.chars.incorrect + s.chars.extra;
      T.errs.push(bad - (T.errs.badAt || 0)); T.errs.badAt = bad;
    }
    if (T.limit && ms >= T.limit) { finish(); return; }
    paintLive();
  }
  function paintLive() {
    if (!T) return;
    var ms = elapsed();
    if (T.mode === 'time') el.clock.textContent = Math.max(0, Math.ceil(((T.limit || 0) - ms) / 1000)) + 's';
    else el.clock.textContent = Math.min(T.cur, T.words.length) + ' / ' + T.words.length;
    if (prefs.live && T.t0 && ms > 1500) el.lw.textContent = Math.round(score(T.words, T.typed, T.cur, false, T.keys, ms).wpm) + ' wpm';
    else el.lw.textContent = '';
  }

  function finish() {
    if (!T || T.done) return;
    T.end = now();
    var ms = T.limit ? Math.min(elapsed(), T.limit) : elapsed();
    T.done = true;
    stopTick();
    P.classList.remove('ty-run');
    // every word committed (the last one with a space) vs. stopped mid-word / on the last word
    var s = T.cur >= T.words.length ? score(T.words, T.typed, T.words.length, false, T.keys, ms) : score(T.words, T.typed, T.cur, true, T.keys, ms);
    // a trailing partial second still counts on the graph
    var tail = ms / 1000 - T.samples.length;
    if (tail > 0.25) T.samples.push(Math.max(0, (s.good - (T.samples.goodAt || 0)) / 5 * 60 / tail));
    var tooShort = ms < 3000 || s.chars.correct < 5;
    var best = bestFor(T.key), isBest = !tooShort && (!best || s.wpm > best.wpm);
    var rec = { t: Date.now(), k: T.key, wpm: Math.round(s.wpm * 10) / 10, raw: Math.round(s.raw * 10) / 10, acc: Math.round(s.acc * 10) / 10, s: Math.round(ms / 100) / 10, c: s.chars };
    if (!tooShort) { hist.push(rec); saveHist(); }
    showResult(s, ms, rec, isBest, best, tooShort);
  }
  function bestFor(k) { var b = null; hist.forEach(function (h) { if (h.k === k && (!b || h.wpm > b.wpm)) b = h; }); return b; }

  function showResult(s, ms, rec, isBest, prevBest, tooShort) {
    var c = s.chars, w = window.matchMedia && window.matchMedia('(max-width: 560px)').matches ? 30 : 48;
    var graph = T.samples.length >= 3 ? spark(T.samples, w) : '';
    var errLine = '';
    if (graph) {
      var e = T.errs.slice(0, T.samples.length), cols = Math.min(w, T.samples.length), em = '';
      for (var i = 0; i < cols; i++) {
        var a = Math.floor(i * T.samples.length / cols), b = Math.max(a + 1, Math.floor((i + 1) * T.samples.length / cols)), n = 0;
        for (var k = a; k < b; k++) n += e[k] || 0;
        em += n ? '×' : ' ';
      }
      errLine = em;
    }
    var peak = T.samples.length ? Math.round(Math.max.apply(null, T.samples)) : 0;
    var html = '<div class="ty-big"><div><b>' + Math.round(s.wpm) + '</b><small>wpm</small></div><div><b>' + Math.round(s.acc) + '%</b><small>accuracy</small></div></div>' +
      (tooShort ? '<div class="ty-note">too short to count — keep going a little longer</div>'
        : isBest ? '<div class="ty-pb">★ new personal best for ' + esc(rec.k) + (prevBest ? ' (was ' + Math.round(prevBest.wpm) + ')' : '') + '</div>'
        : prevBest ? '<div class="ty-note">best for ' + esc(rec.k) + ': ' + Math.round(prevBest.wpm) + ' wpm</div>' : '') +
      (graph ? '<pre class="ty-graph" aria-label="Words per minute over the test">' + esc(graph) + '\n<span class="ty-gx">' + esc(errLine) + '</span></pre>' +
        '<div class="ty-gl"><span>wpm each second · peak ' + peak + '</span><span>× = errors</span></div>' : '') +
      '<dl class="ty-facts">' +
        '<div><dt>raw</dt><dd>' + Math.round(s.raw) + '</dd></div>' +
        '<div><dt>time</dt><dd>' + (Math.round(ms / 100) / 10) + 's</dd></div>' +
        '<div><dt>chars</dt><dd title="correct / incorrect / extra / missed"><span class="k">' + c.correct + '</span>/<span class="b">' + c.incorrect + '</span>/<span class="x">' + c.extra + '</span>/' + c.missed + '</dd></div>' +
        '<div><dt>test</dt><dd>' + esc(rec.k) + '</dd></div>' +
      '</dl>' +
      '<div class="ty-row"><button type="button" class="ty-btn ty-go" data-act="restart">↻ again</button><button type="button" class="ty-btn" data-act="next">→ new text</button>' +
      '<button type="button" class="ty-btn" data-act="insert" title="Insert this result at the cursor">↧ note</button></div>';
    el.res.innerHTML = html;
    el.res.hidden = false;
    el.box.hidden = true;
    el.live.hidden = true;
    T.rec = rec;
    try { el.inp.blur(); } catch (x) {}
    var go = el.res.querySelector('.ty-go');
    if (go) try { go.focus({ preventScroll: true }); } catch (x) {}
  }

  function showHist() {
    stopTick();
    if (T && T.t0 && !T.done) T = null;
    var bests = {}, keys = [];
    hist.forEach(function (h) { if (!bests[h.k]) keys.push(h.k); if (!bests[h.k] || h.wpm > bests[h.k].wpm) bests[h.k] = h; });
    var recent = hist.slice(-40).map(function (h) { return h.wpm; });
    var avg = function (a) { return a.length ? Math.round(a.reduce(function (x, y) { return x + y; }, 0) / a.length) : 0; };
    var last10 = hist.slice(-10).map(function (h) { return h.wpm; });
    var html = '<div class="ty-h">history</div>';
    if (!hist.length) html += '<div class="ty-note">no tests yet — finish one and it shows up here</div>';
    else {
      html += '<div class="ty-big ty-big-s"><div><b>' + avg(last10) + '</b><small>avg of last ' + last10.length + '</small></div><div><b>' + hist.length + '</b><small>tests</small></div></div>';
      if (recent.length >= 2) html += '<pre class="ty-graph">' + esc(spark(recent, 40)) + '</pre><div class="ty-gl"><span>last ' + recent.length + ' tests (wpm)</span></div>';
      html += '<div class="ty-h">personal bests</div><table class="ty-tbl"><tbody>' + keys.sort().map(function (k) {
        var b = bests[k];
        return '<tr><td>' + esc(k) + '</td><td class="n">' + Math.round(b.wpm) + '</td><td class="n">' + Math.round(b.acc) + '%</td><td class="d">' + new Date(b.t).toLocaleDateString() + '</td></tr>';
      }).join('') + '</tbody></table>';
    }
    html += '<div class="ty-row"><button type="button" class="ty-btn ty-go" data-act="restart">← back to typing</button>' +
      (hist.length ? '<button type="button" class="ty-btn" data-act="clear">clear history</button>' : '') + '</div>';
    el.hist.innerHTML = html;
    el.hist.hidden = false; el.res.hidden = true; el.box.hidden = true; el.live.hidden = true;
    P.classList.remove('ty-run');
  }

  function insertResult() {
    var r = T && T.rec, ed = Cade.editor;
    if (!r || !ed) return;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode — editing is locked', 'error', 2000); return; }
    var line = '⌨ ' + Math.round(r.wpm) + ' wpm · ' + Math.round(r.acc) + '% acc · ' + r.k + ' · ' + new Date(r.t).toLocaleDateString() + '\n';
    ed.dispatch(ed.state.replaceSelection(line), { userEvent: 'input', scrollIntoView: true });
    Cade.showToast('Result inserted', 'success', 1200);
  }

  function focusIn() {
    if (!P || el.box.hidden) return;
    try { el.inp.focus({ preventScroll: true }); } catch (e) { try { el.inp.focus(); } catch (x) {} }
  }
  function onFocusChange() { if (P) P.classList.toggle('ty-blur', document.activeElement !== el.inp); }

  function onClick(e) {
    var b = e.target.closest ? e.target.closest('button,[data-act]') : null;
    if (!b || !P.contains(b)) return;
    var a = b.getAttribute('data-act');
    if (b.hasAttribute('data-mode')) { prefs.mode = b.getAttribute('data-mode'); paintBar(); start(false); }
    else if (b.hasAttribute('data-time')) { prefs.time = +b.getAttribute('data-time'); paintBar(); start(false); }
    else if (b.hasAttribute('data-count')) { prefs.count = +b.getAttribute('data-count'); paintBar(); start(false); }
    else if (b.hasAttribute('data-tog')) { var k = b.getAttribute('data-tog'); prefs[k] = !prefs[k]; paintBar(); start(false); }
    else if (a === 'restart') start(true);
    else if (a === 'next') start(false);
    else if (a === 'focus') focusIn();
    else if (a === 'hist') { if (el.hist.hidden) showHist(); else start(true); }
    else if (a === 'insert') insertResult();
    else if (a === 'clear') { if (confirm('Clear your typing history and personal bests?')) { hist = []; saveHist(); showHist(); } }
  }
  function onPanelKey(e) {
    // Tab / Enter on the result or history screen: go again
    if (e.target === el.inp) return;
    if (e.key === 'Tab' && T && (T.done || !el.hist.hidden)) { e.preventDefault(); start(true); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  function cleanup() {
    stopTick();
    document.removeEventListener('focusin', onFocusChange, true);
    document.removeEventListener('focusout', onFocusChange, true);
    P = null; T = null; el = {};
  }
  function close() {
    var p = P;
    cleanup();
    if (p) p.remove();
    try { Cade.editor.focus(); } catch (e) {}
  }
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    loadAll();
    P = Cade.mkPanel(PANEL_ID, '⌨ Typing Test', bodyHtml());
    P._onClose = cleanup;
    el = {
      words: q('.ty-words'), inp: q('.ty-in'), box: q('.ty-box'), res: q('.ty-res'), hist: q('.ty-hist'), live: q('.ty-live'),
      clock: q('.ty-clock'), lw: q('.ty-lw'), src: q('.ty-src')
    };
    P.addEventListener('click', onClick);
    P.addEventListener('keydown', onPanelKey);
    el.inp.addEventListener('input', onInput);
    el.inp.addEventListener('keydown', onKeyDown);
    // the field must not lose the caret to taps on the text, and paste is not typing
    el.box.addEventListener('mousedown', function (e) { if (e.target !== el.inp) { e.preventDefault(); focusIn(); } });
    // buttons never take the keyboard from the text field (a space would press them)
    P.addEventListener('mousedown', function (e) { var bt = e.target.closest && e.target.closest('.ty button'); if (bt && !el.box.hidden) e.preventDefault(); });
    el.inp.addEventListener('paste', function (e) { e.preventDefault(); });
    el.inp.addEventListener('drop', function (e) { e.preventDefault(); });
    P.addEventListener('cade-panel-minimize', function () { if (T && T.t0 && !T.done) start(true); });
    document.addEventListener('focusin', onFocusChange, true);
    document.addEventListener('focusout', onFocusChange, true);
    paintBar();
    start(false);
    onFocusChange();
  }

  Cade.registerWidget({
    name: 'Typing Test',
    description: 'How fast do you type? Timed and word-count tests, passages or your own note — live WPM, accuracy, a speed graph, personal bests and history',
    icon: '⌨',
    tags: 'typing,typing test,speed,speed test,wpm,words per minute,keyboard,practice,touch typing,accuracy,monkeytype,game,train',
    open: open,
    close: close,
    _engine: Engine
  });
})();
