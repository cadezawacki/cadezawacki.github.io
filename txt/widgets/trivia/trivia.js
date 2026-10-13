/* Trivia Quiz — rounds of 10 multiple-choice / true-false questions from Open
 * Trivia DB (opentdb.com, CC BY-SA 4.0), with categories, difficulty, an
 * optional per-question timer, streaks, a speed bonus, an end-of-round review
 * and per-category statistics.
 *
 * ONLINE: questions come from opentdb.com with a session token (so rounds don't
 * repeat questions), URL-encoded (RFC 3986) and decoded here; the old HTML-entity
 * encoding is decoded too, as a fallback. The API allows one request per IP
 * every 5 s, so requests are spaced through one gate, and the next round is
 * prefetched in the background once that gap has passed. Requests are POSTs: the
 * app's service worker caches every GET (stale-while-revalidate), which would
 * replay old question batches and tokens; Open Trivia DB answers POST the same
 * way, and a body-less POST is a "simple" CORS request (no preflight).
 *
 * OFFLINE: fetched questions are kept (up to 400, IndexedDB) and a bundled set
 * of 370 questions in 13 categories (trivia-data.js, precached, loaded on first
 * open) fills in whenever the network or the API fails, or when "Offline
 * questions only" is on. Questions already played are skipped until the pool
 * runs dry.
 *
 * Keyboard: 1–4 / A–D (T / F) answer, Enter / Space next, Esc closes — taken on
 * document (capture) only while the quiz "has focus": from opening it until a
 * press outside the panel. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('trivia.css');
  var DATA_URL = Cade.asset('trivia-data.js'); // resolve now, while the loader context is ours
  var esc = Cade.escapeHtml;

  var API = 'https://opentdb.com/';
  var PANEL_ID = 'trivia-panel';
  var PREFS_KEY = 'cade-trivia-prefs';
  var STATS_KEY = 'cade-trivia-stats';
  var TOKEN_KEY = 'cade-trivia-token';
  var SEEN_KEY = 'cade-trivia-seen';
  var CACHE_KEY = 'cade-trivia-cache';
  var ROUND = 10;
  var GAP = 5200;                 // ms between api.php calls (limit: 1 per 5 s per IP)
  var TOKEN_IDLE = 6 * 3600e3;    // the API forgets tokens after 6 h unused
  var CACHE_MAX = 400, CACHE_MAX_LS = 100, SEEN_MAX = 600;
  var BASE = { easy: 100, medium: 150, hard: 200 };
  var SPEED_REF = 20;             // seconds: speed-bonus scale when the timer is off
  var TIMERS = [0, 10, 15, 20, 30];

  // Open Trivia DB categories (ids are the API's; stable for years).
  var CATS = [
    [9, 'General Knowledge'], [10, 'Entertainment: Books'], [11, 'Entertainment: Film'], [12, 'Entertainment: Music'],
    [13, 'Entertainment: Musicals & Theatres'], [14, 'Entertainment: Television'], [15, 'Entertainment: Video Games'],
    [16, 'Entertainment: Board Games'], [17, 'Science & Nature'], [18, 'Science: Computers'], [19, 'Science: Mathematics'],
    [20, 'Mythology'], [21, 'Sports'], [22, 'Geography'], [23, 'History'], [24, 'Politics'], [25, 'Art'],
    [26, 'Celebrities'], [27, 'Animals'], [28, 'Vehicles'], [29, 'Entertainment: Comics'], [30, 'Science: Gadgets'],
    [31, 'Entertainment: Japanese Anime & Manga'], [32, 'Entertainment: Cartoon & Animations'],
  ];
  var CAT_NAME = {}, CAT_ID = {};
  CATS.forEach(function (c) { CAT_NAME[c[0]] = c[1]; CAT_ID[c[1]] = c[0]; });
  function shortCat(name) { return String(name || '').replace(/^(Entertainment|Science): /, ''); }

  // ---- decoding (pure; unit-checked in node) ---------------------------------
  // Named HTML entities: the common ones, plus accented Latin letters built
  // from base letter + combining mark (eacute, ouml, ntilde, ccedil, aring…).
  var ENT = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00a0', shy: '\u00ad',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
    laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', hellip: '…', ndash: '–', mdash: '—',
    bull: '•', middot: '·', prime: '′', Prime: '″', deg: '°', times: '×', divide: '÷',
    plusmn: '±', minus: '−', sup1: '¹', sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾',
    micro: 'µ', infin: '∞', le: '≤', ge: '≥', ne: '≠', asymp: '≈', larr: '←', rarr: '→',
    uarr: '↑', darr: '↓', harr: '↔', hearts: '♥', spades: '♠', clubs: '♣', diams: '♦',
    iexcl: '¡', iquest: '¿', trade: '™', reg: '®', copy: '©', euro: '€', pound: '£',
    yen: '¥', cent: '¢', curren: '¤', sect: '§', para: '¶', ordm: 'º', ordf: 'ª',
    macr: '¯', acute: '´', uml: '¨', cedil: '¸', brvbar: '¦', not: '¬', dagger: '†', Dagger: '‡',
    szlig: 'ß', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', eth: 'ð', ETH: 'Ð',
    thorn: 'þ', THORN: 'Þ', oelig: 'œ', OElig: 'Œ', scaron: 'š', Scaron: 'Š', yuml: 'ÿ', Yuml: 'Ÿ',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ',
    mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Omega: 'Ω',
  };
  (function () {
    var marks = { acute: '\u0301', grave: '\u0300', circ: '\u0302', uml: '\u0308', tilde: '\u0303', ring: '\u030a', cedil: '\u0327' };
    'aeiouycnAEIOUYCN'.split('').forEach(function (l) {
      for (var m in marks) {
        var ch = (l + marks[m]).normalize ? (l + marks[m]).normalize('NFC') : '';
        if (ch && ch.length === 1 && !ENT[l + m]) ENT[l + m] = ch;
      }
    });
  })();
  var entityBox = null;
  function decodeEntities(s) {
    return String(s == null ? '' : s).replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, function (m, e) {
      if (e.charAt(0) === '#') {
        var cp = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : m;
      }
      if (Object.prototype.hasOwnProperty.call(ENT, e)) return ENT[e];
      // Anything rarer: let the browser decode it (a <textarea> never runs markup).
      if (typeof document === 'undefined' || !document.createElement) return m;
      try { (entityBox || (entityBox = document.createElement('textarea'))).innerHTML = m; return entityBox.value; } catch (x) { return m; }
    });
  }
  // RFC 3986 percent-encoding (encode=url3986); falls back to the raw text if
  // a stray "%" makes it malformed.
  function decodeUrl(s) {
    try { return decodeURIComponent(String(s == null ? '' : s)); } catch (e) { return String(s); }
  }
  function fromApi(r, enc) {
    var d = enc === 'url3986' ? decodeUrl : decodeEntities;
    var cat = d(r.category), diff = d(r.difficulty), type = d(r.type);
    return {
      cat: cat, cid: CAT_ID[cat] || 0,
      d: BASE[diff] ? diff : 'medium', t: type === 'boolean' ? 'boolean' : 'multiple',
      q: d(r.question).trim(), a: d(r.correct_answer).trim(),
      w: (r.incorrect_answers || []).map(function (x) { return d(x).trim(); }),
      src: 'otdb',
    };
  }
  var DIFF = { e: 'easy', m: 'medium', h: 'hard' };
  function parseLocal(lines) {
    var out = [];
    (lines || []).forEach(function (line) {
      var f = String(line).split('|');
      if (f.length !== 4 && f.length !== 7) return;
      var cid = +f[0];
      out.push({
        cat: CAT_NAME[cid] || 'General Knowledge', cid: cid, d: DIFF[f[1]] || 'medium',
        t: f.length === 4 ? 'boolean' : 'multiple', q: f[2], a: f[3],
        w: f.length === 4 ? [f[3] === 'True' ? 'False' : 'True'] : f.slice(4), src: 'local',
      });
    });
    return out;
  }
  function validQ(x) {
    return x && typeof x.q === 'string' && x.q && typeof x.a === 'string' && x.a && Array.isArray(x.w) &&
      x.w.length >= 1 && x.w.every(function (w) { return typeof w === 'string' && w && w !== x.a; });
  }
  // Short stable id for "already played" bookkeeping.
  function qid(x) {
    var s = x.q + '\u0001' + x.a, h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function shuffle(a, rnd) {
    rnd = rnd || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function optionsFor(x, rnd) {
    if (x.t === 'boolean') return ['True', 'False'];
    return shuffle([x.a].concat(x.w), rnd);
  }
  // Points for a right answer: by difficulty, + up to 50% for speed, + streak.
  function scoreFor(diff, secs, limit, streak) {
    var base = BASE[diff] || BASE.medium;
    var lim = limit || SPEED_REF;
    var speed = Math.round(base * 0.5 * Math.max(0, 1 - secs / lim));
    var bonus = streak >= 2 ? Math.min(5, streak - 1) * 10 : 0;
    return { base: base, speed: speed, streak: bonus, total: base + speed + bonus };
  }
  function matches(x, f) {
    if (f.cat && x.cid !== f.cat) return false;
    if (f.diff && x.d !== f.diff) return false;
    if (f.type && x.t !== f.type) return false;
    return true;
  }
  // Pick n questions from a pool: unplayed first; filters are relaxed in turn
  // (difficulty, then type, then category) when there aren't enough.
  function pickLocal(pool, f, n, seen, rnd) {
    var tries = [f, { cat: f.cat, type: f.type }, { cat: f.cat }, {}];
    var used = {}, out = [], relaxed = 0, uniq = {};
    pool = pool.filter(function (x) { var k = qid(x); if (uniq[k]) return false; uniq[k] = 1; return true; });
    for (var t = 0; t < tries.length && out.length < n; t++) {
      var fit = pool.filter(function (x) { return !used[qid(x)] && matches(x, tries[t]); });
      var fresh = shuffle(fit.filter(function (x) { return !seen[qid(x)]; }), rnd);
      var old = shuffle(fit.filter(function (x) { return seen[qid(x)]; }), rnd);
      var list = fresh.concat(old);
      for (var i = 0; i < list.length && out.length < n; i++) {
        used[qid(list[i])] = 1;
        out.push(list[i]);
        if (t > 0) relaxed = Math.max(relaxed, t);
      }
    }
    return { qs: out, relaxed: relaxed };
  }

  // ---- persistence ---------------------------------------------------------------
  function readJSON(key, dflt) {
    try { var v = JSON.parse(Cade.store.get(key) || 'null'); return v == null ? dflt : v; } catch (e) { return dflt; }
  }
  function writeJSON(key, v) { try { Cade.store.set(key, JSON.stringify(v)); } catch (e) {} }

  var prefs = { cat: 0, diff: '', type: '', timer: 0, offline: false };
  var stats = null;
  function blankStats() { return { rounds: 0, qs: 0, correct: 0, best: 0, bestStreak: 0, points: 0, cats: {} }; }
  function loadPrefs() {
    var p = readJSON(PREFS_KEY, {}) || {};
    prefs.cat = CAT_NAME[p.cat] ? +p.cat : 0;
    prefs.diff = BASE[p.diff] ? p.diff : '';
    prefs.type = p.type === 'multiple' || p.type === 'boolean' ? p.type : '';
    prefs.timer = TIMERS.indexOf(+p.timer) !== -1 ? +p.timer : 0;
    prefs.offline = !!p.offline;
    var s = readJSON(STATS_KEY, null);
    stats = blankStats();
    if (s && typeof s === 'object') {
      ['rounds', 'qs', 'correct', 'best', 'bestStreak', 'points'].forEach(function (k) { if (typeof s[k] === 'number') stats[k] = s[k]; });
      if (s.cats && typeof s.cats === 'object') {
        for (var k in s.cats) if (Array.isArray(s.cats[k]) && s.cats[k].length === 2) stats.cats[k] = [+s.cats[k][0] || 0, +s.cats[k][1] || 0];
      }
    }
  }
  function savePrefs() { writeJSON(PREFS_KEY, prefs); }
  function saveStats() { writeJSON(STATS_KEY, stats); }

  var seen = null; // qid -> 1, insertion-ordered list kept in Cade.store
  function loadSeen() {
    var a = readJSON(SEEN_KEY, []);
    seen = { list: Array.isArray(a) ? a.slice(-SEEN_MAX) : [], map: {} };
    seen.list.forEach(function (k) { seen.map[k] = 1; });
  }
  function markSeen(x) {
    var k = qid(x);
    if (seen.map[k]) return;
    seen.map[k] = 1;
    seen.list.push(k);
    if (seen.list.length > SEEN_MAX) delete seen.map[seen.list.shift()];
    writeJSON(SEEN_KEY, seen.list);
  }

  // Fetched questions, kept for offline rounds (IndexedDB when available).
  var cache = [], cacheLoaded = null, cacheTimer = 0;
  var idb = function () { return Cade.idbStore && typeof Cade.idbStore.get === 'function' ? Cade.idbStore : null; };
  function loadCache() {
    if (cacheLoaded) return cacheLoaded;
    var st = idb();
    cacheLoaded = (st ? Promise.resolve().then(function () { return st.get(CACHE_KEY); }).then(null, function () { return null; })
      : Promise.resolve(readJSON(CACHE_KEY, null))).then(function (v) {
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
      cache = Array.isArray(v) ? v.filter(validQ) : [];
    });
    return cacheLoaded;
  }
  function cacheAdd(qs) {
    var have = {};
    cache.forEach(function (x) { have[qid(x)] = 1; });
    qs.forEach(function (x) { if (!have[qid(x)]) { have[qid(x)] = 1; cache.push({ cat: x.cat, cid: x.cid, d: x.d, t: x.t, q: x.q, a: x.a, w: x.w, src: 'otdb' }); } });
    var max = idb() ? CACHE_MAX : CACHE_MAX_LS;
    if (cache.length > max) cache = cache.slice(cache.length - max);
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(function () {
      var st = idb();
      try {
        if (st) { var pr = st.set(CACHE_KEY, JSON.stringify(cache)); if (pr && pr.then) pr.then(null, function () {}); }
        else writeJSON(CACHE_KEY, cache);
      } catch (e) {}
    }, 400);
  }

  // ---- Open Trivia DB ----------------------------------------------------------------
  var nextApiAt = 0;      // module-wide, so reopening the panel still respects the gap
  var prefetched = null;  // { key, qs } — the next round, fetched in the background
  var prefetching = null;
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function post(path) {
    return fetch(API + path, { method: 'POST', credentials: 'omit', cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function gatedPost(path, onWait) {
    var wait = Math.max(0, nextApiAt - Date.now());
    nextApiAt = Date.now() + wait + GAP;
    if (wait > 300 && onWait) onWait(wait);
    return delay(wait).then(function () { return post(path); });
  }
  function getToken(fresh) {
    var t = readJSON(TOKEN_KEY, null);
    if (!fresh && t && typeof t.v === 'string' && /^[0-9a-f]{16,128}$/.test(t.v) && Date.now() - t.at < TOKEN_IDLE - 600e3) return Promise.resolve(t.v);
    return post('api_token.php?command=request').then(function (j) {
      if (j && j.response_code === 0 && j.token) { writeJSON(TOKEN_KEY, { v: j.token, at: Date.now() }); return j.token; }
      return '';
    }, function () { return ''; });
  }
  function touchToken(tok) { if (tok) writeJSON(TOKEN_KEY, { v: tok, at: Date.now() }); }
  function optsKey(f) { return [f.cat || 0, f.diff || '', f.type || ''].join('/'); }

  // Resolves to an array of questions, or rejects with {code} / Error.
  function fetchQuestions(f, amount, onWait, attempt) {
    attempt = attempt || 0;
    return getToken(false).then(function (tok) {
      var path = 'api.php?amount=' + amount + '&encode=url3986' + (f.cat ? '&category=' + f.cat : '') +
        (f.diff ? '&difficulty=' + f.diff : '') + (f.type ? '&type=' + f.type : '') + (tok ? '&token=' + tok : '');
      return gatedPost(path, onWait).then(function (j) {
        var code = j ? j.response_code : -1;
        if (code === 0 && Array.isArray(j.results)) {
          touchToken(tok);
          return j.results.map(function (r) { return fromApi(r, 'url3986'); }).filter(validQ);
        }
        if (attempt >= 2) throw { code: code };
        if (code === 3) { writeJSON(TOKEN_KEY, null); return fetchQuestions(f, amount, onWait, attempt + 1); }   // token unknown/expired
        if (code === 4 && tok) {                                                                                 // every question seen: start over
          return post('api_token.php?command=reset&token=' + tok).then(function () {
            return fetchQuestions(f, amount, onWait, attempt + 1);
          });
        }
        if (code === 5) return fetchQuestions(f, amount, onWait, attempt + 1);                                    // rate limited: the gate waits
        throw { code: code };                                                                                    // 1 = not enough questions, 2 = bad parameter
      });
    });
  }

  var prefetchKey = '';
  function prefetchNext(f) {
    var key = optsKey(f);
    if (prefetching || (prefetched && prefetched.key === key)) return;
    prefetchKey = key;
    prefetching = fetchQuestions(f, ROUND).then(function (qs) {
      prefetching = null;
      if (qs.length >= ROUND / 2) { prefetched = { key: key, qs: qs }; cacheAdd(qs); }
    }, function () { prefetching = null; });
  }
  // The prefetched round for these settings, waiting for one still in flight.
  function takePrefetched(key) {
    var wait = prefetching && prefetchKey === key ? prefetching : Promise.resolve();
    return wait.then(function () {
      if (prefetched && prefetched.key === key) { var qs = prefetched.qs; prefetched = null; return qs; }
      return null;
    });
  }

  // ---- local data ------------------------------------------------------------------------
  var bundled = null, bundledLoading = null;
  function loadBundled() {
    if (bundled) return Promise.resolve();
    if (window.__cadeTriviaData) { bundled = parseLocal(window.__cadeTriviaData.q); return Promise.resolve(); }
    if (bundledLoading) return bundledLoading;
    bundledLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = DATA_URL;
      s.onload = function () {
        if (window.__cadeTriviaData) { bundled = parseLocal(window.__cadeTriviaData.q); resolve(); }
        else { bundledLoading = null; reject(new Error('no data')); }
      };
      s.onerror = function () { bundledLoading = null; reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
    return bundledLoading;
  }

  // ---- round ------------------------------------------------------------------------------
  var P = null, game = null, sheet = '', active = false, openedAt = 0;
  var status = '';         // loading message
  var tickTimer = 0, timers = [];
  var resetArmed = 0;
  var roundSeq = 0;

  function q(sel) { return P && P.querySelector(sel); }
  function later(fn, ms) { var t = setTimeout(fn, ms); timers.push(t); return t; }
  function filt() { return { cat: prefs.cat, diff: prefs.diff, type: prefs.type }; }
  function now() { return window.performance && performance.now ? performance.now() : Date.now(); }

  function localRound(f, why) {
    var pool = cache.concat(bundled || []);
    var r = pickLocal(pool, f, ROUND, seen.map);
    return { qs: r.qs, src: 'local', why: why, relaxed: r.relaxed };
  }

  function startRound() {
    if (status) return;
    stopTick();
    var f = filt(), key = optsKey(f), my = ++roundSeq;
    var offline = prefs.offline || navigator.onLine === false;
    var p;
    if (offline) p = Promise.resolve(localRound(f, prefs.offline ? 'pref' : 'offline'));
    else {
      status = 'Fetching questions…';
      paint();
      p = takePrefetched(key).then(function (ready) {
        if (ready) return ready;
        return fetchQuestions(f, ROUND, function () {
          if (my !== roundSeq || !P) return;
          status = 'Waiting for Open Trivia DB (one request per 5 s)…';
          paint();
        });
      }).then(function (qs) {
        cacheAdd(qs);
        if (qs.length >= ROUND) return { qs: qs, src: 'otdb' };
        // A thin category / difficulty mix: top up from the local pool.
        var extra = pickLocal(cache.concat(bundled || []).filter(function (x) {
          return !qs.some(function (y) { return qid(y) === qid(x); });
        }), f, ROUND - qs.length, seen.map);
        return { qs: qs.concat(extra.qs), src: 'mixed', relaxed: extra.relaxed };
      }, function (err) {
        return localRound(f, err && err.code === 1 ? 'few' : 'error');
      });
    }
    p.then(function (r) {
      if (my !== roundSeq || !P) return;
      status = '';
      if (!r.qs.length) { Cade.showToast('No questions available', 'error', 2000); paint(); return; }
      if (r.why === 'error') Cade.showToast('Open Trivia DB unreachable — using offline questions', 'info', 2600);
      else if (r.why === 'few') Cade.showToast('Not enough online questions for that mix — using offline ones', 'info', 2600);
      else if (r.why === 'offline') Cade.showToast('Offline — using saved questions', 'info', 2000);
      if (r.relaxed && (r.src === 'local' || r.src === 'mixed')) Cade.showToast('Few offline questions match — mixed in others', 'info', 2400);
      game = {
        id: my, qs: r.qs.map(function (x) { return { x: x, opts: optionsFor(x), pick: -1, done: false, ok: false, secs: 0, pts: null }; }),
        i: 0, score: 0, correct: 0, streak: 0, best: 0, src: r.src, over: false,
      };
      if (r.src !== 'local' && !prefs.offline) later(function () { if (P) prefetchNext(f); }, 600);
      sheet = '';
      beginQuestion();
    });
  }

  function current() { return game && !game.over ? game.qs[game.i] : null; }

  // Per-question clock: pauses while the page is hidden (or the panel minimized).
  var clock = { start: 0, used: 0, running: false };
  function beginQuestion() {
    clock = { start: now(), used: 0, running: !document.hidden && !(Cade.isMinimized && Cade.isMinimized(P)) };
    paint();
    startTick();
  }
  function elapsed() { return (clock.used + (clock.running ? now() - clock.start : 0)) / 1000; }
  function startTick() {
    stopTick();
    if (!prefs.timer) return;
    tickTimer = setInterval(tick, 100);
  }
  function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; } }
  function tick() {
    var qn = current();
    if (!qn || qn.done || !P) { stopTick(); return; }
    var left = Math.max(0, prefs.timer - elapsed());
    var bar = q('.tv-timebar i');
    if (bar) bar.style.width = (left / prefs.timer * 100).toFixed(1) + '%';
    var tx = q('.tv-timeleft');
    if (tx) tx.textContent = Math.ceil(left) + 's';
    if (bar) bar.parentNode.classList.toggle('low', left <= 3);
    if (left <= 0) answer(-1);
  }
  function onVisibility() {
    if (!clock) return;
    var away = document.hidden || (Cade.isMinimized && Cade.isMinimized(P));
    if (away && clock.running) { clock.used += now() - clock.start; clock.running = false; }
    else if (!away && !clock.running) { clock.start = now(); clock.running = true; }
  }

  function answer(idx) {
    var qn = current();
    if (!qn || qn.done) return;
    if (idx >= qn.opts.length) return;
    stopTick();
    qn.secs = Math.min(elapsed(), prefs.timer || 999);
    qn.done = true;
    qn.pick = idx;
    qn.ok = idx >= 0 && qn.opts[idx] === qn.x.a;
    var c = qn.x.cat || 'Other', cs = stats.cats[c] || (stats.cats[c] = [0, 0]);
    cs[0]++;
    stats.qs++;
    if (qn.ok) {
      game.correct++; game.streak++;
      if (game.streak > game.best) game.best = game.streak;
      qn.pts = scoreFor(qn.x.d, qn.secs, prefs.timer, game.streak);
      game.score += qn.pts.total;
      cs[1]++; stats.correct++;
    } else {
      game.streak = 0;
    }
    if (game.best > stats.bestStreak) stats.bestStreak = game.best;
    saveStats();
    markSeen(qn.x);
    try { Cade.haptic && Cade.haptic(qn.ok ? 8 : 30); } catch (e) {}
    paint();
  }

  function next() {
    var qn = current();
    if (!qn || !qn.done) return;
    game.i++;
    if (game.i >= game.qs.length) finish();
    else beginQuestion();
  }

  function finish() {
    stopTick();
    game.over = true;
    stats.rounds++;
    stats.points += game.score;
    game.newBest = game.score > stats.best && stats.rounds > 1;
    if (game.score > stats.best) stats.best = game.score;
    saveStats();
    paint();
  }

  function quit() {
    if (!game || game.over) return;
    stopTick();
    var played = game.qs.filter(function (x) { return x.done; });
    if (!played.length) { game = null; paint(); return; }
    game.qs = played;
    game.i = played.length - 1;
    finish();
  }

  // ---- editor: insert the round review ---------------------------------------------------
  function insertReview() {
    if (!game || !game.over) return;
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode — editing is locked', 'error', 2000); return; }
    var lines = ['Trivia round — ' + game.correct + '/' + game.qs.length + ' correct, ' + game.score + ' points', ''];
    game.qs.forEach(function (qn, i) {
      lines.push((i + 1) + '. ' + qn.x.q);
      lines.push('   ' + (qn.ok ? '✓ ' : '✗ ') + qn.x.a + (!qn.ok && qn.pick >= 0 ? ' (you: ' + qn.opts[qn.pick] + ')' : !qn.ok ? ' (no answer)' : ''));
    });
    if (game.qs.some(function (x) { return x.x.src === 'otdb'; })) lines.push('', 'Questions: Open Trivia DB (opentdb.com), CC BY-SA 4.0');
    ed.dispatch(ed.state.replaceSelection(lines.join('\n') + '\n'), { userEvent: 'input', scrollIntoView: true });
    Cade.showToast('Review inserted', 'success', 1200);
  }

  // ---- rendering --------------------------------------------------------------------------
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function diffLabel(d) { return d ? d.charAt(0).toUpperCase() + d.slice(1) : 'Any'; }

  function settingsHtml() {
    var html = '<div class="tv-settings"><select class="tv-sel tv-cat" data-pref="cat" aria-label="Category"><option value="0">Any category</option>' +
      CATS.map(function (c) { return '<option value="' + c[0] + '"' + (prefs.cat === c[0] ? ' selected' : '') + '>' + esc(c[1]) + '</option>'; }).join('') + '</select>';
    html += '<div class="tv-row"><div class="tv-seg" role="group" aria-label="Difficulty">' + ['', 'easy', 'medium', 'hard'].map(function (d) {
      return '<button class="tv-segb' + (prefs.diff === d ? ' on' : '') + '" data-diff="' + d + '">' + diffLabel(d) + '</button>';
    }).join('') + '</div>';
    html += '<div class="tv-seg" role="group" aria-label="Question type">' + [['', 'Any'], ['multiple', 'A–D'], ['boolean', 'T/F']].map(function (t) {
      return '<button class="tv-segb' + (prefs.type === t[0] ? ' on' : '') + '" data-type="' + t[0] + '">' + t[1] + '</button>';
    }).join('') + '</div>';
    html += '<select class="tv-sel" data-pref="timer" aria-label="Timer per question">' + TIMERS.map(function (t) {
      return '<option value="' + t + '"' + (prefs.timer === t ? ' selected' : '') + '>' + (t ? '⏱ ' + t + ' s' : '⏱ No timer') + '</option>';
    }).join('') + '</select></div></div>';
    return html;
  }

  function startHtml() {
    var src = prefs.offline ? 'Offline questions' : navigator.onLine === false ? 'Offline — saved questions' : 'Open Trivia DB';
    var html = settingsHtml() + '<div class="tv-start">';
    if (status) return html + '<div class="tv-status"><span class="tv-spin" aria-hidden="true"></span>' + esc(status) + '</div></div>';
    html += '<div class="tv-muted tv-small">' + ROUND + ' questions · ' + esc(src) + (prefs.timer ? ' · ' + prefs.timer + ' s each' : '') + '</div>' +
      '<div class="tv-acts"><button class="tv-btn primary tv-go" data-act="start">Start round <span class="tv-kbd">↵</span></button></div>';
    if (stats.qs) {
      html += '<div class="tv-mini"><span><b>' + stats.rounds + '</b> rounds</span><span><b>' + Math.round(stats.correct / stats.qs * 100) + '%</b> correct</span>' +
        '<span><b>' + fmt(stats.best) + '</b> best</span><span><b>' + stats.bestStreak + '</b> best streak</span></div>';
    }
    return html + '</div>';
  }

  function questionHtml() {
    var qn = current(), x = qn.x;
    var html = '<div class="tv-hud"><span>' + (game.i + 1) + ' / ' + game.qs.length + '</span><span class="tv-score">' + fmt(game.score) + ' pts</span>' +
      '<span class="tv-streak' + (game.streak >= 3 ? ' hot' : '') + '" title="Streak">🔥 ' + game.streak + '</span><span class="tv-sp"></span>' +
      (prefs.timer && !qn.done ? '<span class="tv-timeleft">' + prefs.timer + 's</span>' : '') +
      '<button class="tv-link" data-act="quit" title="End this round">End</button></div>';
    if (prefs.timer) html += '<div class="tv-timebar' + (qn.done ? ' off' : '') + '"><i style="width:' + (qn.done ? 0 : 100) + '%"></i></div>';
    html += '<div class="tv-chips"><span class="tv-chip">' + esc(shortCat(x.cat)) + '</span><span class="tv-chip tv-d-' + x.d + '">' + diffLabel(x.d) + '</span></div>';
    html += '<div class="tv-q">' + esc(x.q) + '</div>';
    html += '<div class="tv-opts' + (x.t === 'boolean' ? ' tv-tf' : '') + '">';
    qn.opts.forEach(function (o, i) {
      var cls = 'tv-opt';
      if (qn.done) cls += o === x.a ? ' ok' : i === qn.pick ? ' bad' : ' dim';
      var keyLabel = x.t === 'boolean' ? (i === 0 ? 'T' : 'F') : 'ABCD'.charAt(i);
      html += '<button class="' + cls + '" data-opt="' + i + '"' + (qn.done ? ' tabindex="-1"' : '') + '><span class="tv-key">' + keyLabel + '</span><span class="tv-ol">' + esc(o) + '</span></button>';
    });
    html += '</div><div class="tv-fbrow"><div class="tv-fb">';
    if (qn.done) {
      if (qn.ok) {
        html += '<span class="tv-good">✓ Correct +' + qn.pts.total + '</span> <span class="tv-muted tv-small">(' + qn.pts.base +
          (qn.pts.speed ? ' + ' + qn.pts.speed + ' speed' : '') + (qn.pts.streak ? ' + ' + qn.pts.streak + ' streak' : '') + ')</span>';
      } else {
        html += '<span class="tv-bad">' + (qn.pick < 0 ? '⏱ Time’s up' : '✗ Wrong') + '</span> <span class="tv-muted">— ' + esc(x.a) + '</span>';
      }
    }
    html += '</div>' + (qn.done ? '<button class="tv-btn primary" data-act="next">' + (game.i + 1 >= game.qs.length ? 'Results' : 'Next') + ' <span class="tv-kbd">↵</span></button>' : '') + '</div>';
    return html;
  }

  function reviewHtml() {
    var n = game.qs.length;
    var html = '<div class="tv-result"><div class="tv-result-big">' + fmt(game.score) + ' <small>pts</small></div><div class="tv-muted">' +
      game.correct + ' / ' + n + ' correct · best streak ' + game.best + (game.newBest ? ' · <b>new best!</b>' : '') + '</div></div><div class="tv-review">';
    game.qs.forEach(function (qn, i) {
      html += '<div class="tv-rv ' + (qn.ok ? 'ok' : 'bad') + '"><span class="tv-rv-n">' + (i + 1) + '</span><div class="tv-rv-t"><div>' + esc(qn.x.q) + '</div>' +
        '<div class="tv-rv-a"><b>' + esc(qn.x.a) + '</b>' + (!qn.ok ? ' <span class="tv-muted">(' + (qn.pick >= 0 ? 'you: ' + esc(qn.opts[qn.pick]) : 'no answer') + ')</span>' : '') +
        (qn.ok && qn.pts ? ' <span class="tv-muted">+' + qn.pts.total + '</span>' : '') + '</div></div><span class="tv-rv-m">' + (qn.ok ? '✓' : '✗') + '</span></div>';
    });
    html += '</div><div class="tv-acts"><button class="tv-btn primary" data-act="start">Play again <span class="tv-kbd">↵</span></button>' +
      '<button class="tv-btn" data-act="insert" title="Insert the questions and answers into the note">Insert review</button>' +
      '<button class="tv-btn" data-act="home">Settings</button></div>';
    return html;
  }

  function statsHtml() {
    var html = '<div class="tv-sheet-title">Statistics</div>';
    if (stats.qs) {
      html += '<div class="tv-mini"><span><b>' + stats.rounds + '</b> rounds</span><span><b>' + stats.qs + '</b> questions</span><span><b>' +
        Math.round(stats.correct / stats.qs * 100) + '%</b> correct</span><span><b>' + fmt(stats.best) + '</b> best round</span><span><b>' + stats.bestStreak + '</b> best streak</span></div>';
      var rows = Object.keys(stats.cats).map(function (k) { return [k, stats.cats[k][0], stats.cats[k][1]]; })
        .sort(function (a, b) { return b[1] - a[1]; });
      html += '<table class="tv-table"><tr><th>Category</th><th>Answered</th><th>Correct</th></tr>' + rows.map(function (r) {
        var pct = r[1] ? Math.round(r[2] / r[1] * 100) : 0;
        return '<tr><td>' + esc(shortCat(r[0])) + '</td><td>' + r[1] + '</td><td><span class="tv-pbar"><i style="width:' + pct + '%"></i></span>' + pct + '%</td></tr>';
      }).join('') + '</table>';
    } else html += '<div class="tv-muted tv-center tv-pad">No questions answered yet.</div>';
    html += '<div class="tv-set"><div><div class="tv-set-l">Offline questions only</div><div class="tv-muted tv-small">Use saved and built-in questions (' +
      ((bundled ? bundled.length : 0) + cache.length) + ') instead of Open Trivia DB</div></div>' +
      '<button class="tv-sw' + (prefs.offline ? ' on' : '') + '" data-act="offline" role="switch" aria-checked="' + (prefs.offline ? 'true' : 'false') + '" aria-label="Offline questions only"><i></i></button></div>' +
      '<div class="tv-acts"><button class="tv-btn danger" data-act="reset">' + (resetArmed ? 'Tap again to reset' : 'Reset statistics') + '</button></div>';
    return html;
  }

  function paint() {
    if (!P) return;
    var stage = q('.tv-stage'), html;
    q('.tv-statsbtn').classList.toggle('on', sheet === 'stats');
    if (!bundled && !status) html = '<div class="tv-center tv-muted tv-pad">Loading…</div>';
    else if (sheet === 'stats') html = '<div class="tv-sheet">' + statsHtml() + '</div>';
    else if (game && !game.over) html = questionHtml();
    else if (game && game.over) html = reviewHtml();
    else html = startHtml();
    stage.innerHTML = html;
    var used = game ? game.qs.some(function (x) { return x.x.src === 'local'; }) : prefs.offline;
    q('.tv-foot').innerHTML = 'Questions: <a href="https://opentdb.com/" target="_blank" rel="noopener">Open Trivia DB</a>, ' +
      '<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a>' + (used ? ' · offline set by Cade.txt' : '');
    if (game && !game.over && prefs.timer) tick();
  }

  // ---- events --------------------------------------------------------------------------------
  function onClick(e) {
    var t = e.target, b;
    if (!t || !t.closest) return;
    if ((b = t.closest('[data-opt]'))) { answer(+b.getAttribute('data-opt')); return; }
    if ((b = t.closest('[data-diff]'))) { prefs.diff = b.getAttribute('data-diff'); savePrefs(); prefetched = null; paint(); return; }
    if ((b = t.closest('[data-type]'))) { prefs.type = b.getAttribute('data-type'); savePrefs(); prefetched = null; paint(); return; }
    if (!(b = t.closest('[data-act]'))) return;
    var act = b.getAttribute('data-act');
    if (act === 'start') { if (bundled) startRound(); }
    else if (act === 'next') next();
    else if (act === 'quit') quit();
    else if (act === 'home') { game = null; paint(); }
    else if (act === 'insert') insertReview();
    else if (act === 'stats') { sheet = sheet === 'stats' ? '' : 'stats'; resetArmed = 0; paint(); }
    else if (act === 'offline') { prefs.offline = !prefs.offline; savePrefs(); paint(); }
    else if (act === 'reset') {
      if (!resetArmed) { resetArmed = 1; paint(); later(function () { resetArmed = 0; if (sheet === 'stats') paint(); }, 3000); return; }
      stats = blankStats(); saveStats(); resetArmed = 0;
      Cade.showToast('Statistics reset', 'success', 1500);
      paint();
    }
  }
  function onChange(e) {
    var t = e.target, k = t && t.getAttribute && t.getAttribute('data-pref');
    if (!k) return;
    if (k === 'cat') prefs.cat = +t.value || 0;
    else if (k === 'timer') prefs.timer = +t.value || 0;
    savePrefs();
    if (k === 'cat') prefetched = null;
    paint();
  }

  function onKey(e) {
    if (!P || !P.isConnected || !active) return;
    if (Cade.isMinimized && Cade.isMinimized(P)) return; // parked in the dock: keys belong to the editor
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    var k = e.key, kl = k.length === 1 ? k.toLowerCase() : k;
    var qn = current();
    if (k === 'Escape') {
      if (sheet) { sheet = ''; paint(); } else close();
    } else if (sheet) {
      return;
    } else if (qn && !qn.done) {
      var idx = -1;
      if (/^[1-4]$/.test(kl)) idx = +kl - 1;
      else if (/^[a-d]$/.test(kl)) idx = kl.charCodeAt(0) - 97;
      if (qn.x.t === 'boolean') { if (kl === 't') idx = 0; else if (kl === 'f') idx = 1; }
      if (idx < 0 || idx >= qn.opts.length) return;
      answer(idx);
    } else if (k === 'Enter' || k === ' ' || k === 'ArrowRight') {
      if (qn && qn.done) next();
      else if (!game || game.over) { if (k === 'Enter' && bundled) startRound(); else return; }
      else return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // A press inside the panel arms keyboard capture; a press anywhere else or
  // focus moving elsewhere hands the keyboard back to the editor.
  function setActive(on) {
    if (!P || on === active) return;
    active = on;
    P.classList.toggle('tv-idle', !active);
    if (active) blurEditor();
  }
  function onDocPointer(e) { if (P) setActive(P.contains(e.target)); }
  function onDocFocus(e) {
    if (!P || P.contains(e.target)) return;
    if (Date.now() - openedAt < 600) { blurEditor(); return; }
    setActive(false);
  }
  function blurEditor() {
    try { if (Cade.editor && Cade.editor.hasFocus) Cade.editor.contentDOM.blur(); } catch (e) {}
  }

  function cleanup() {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('focusin', onDocFocus, true);
    document.removeEventListener('visibilitychange', onVisibility);
    stopTick();
    timers.forEach(clearTimeout); timers = [];
    roundSeq++; // drop any answer still in flight
    P = null; game = null; sheet = ''; status = ''; active = false; resetArmed = 0;
  }
  function close() {
    var p = P;
    cleanup();
    if (p) p.remove();
  }

  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    loadPrefs();
    loadSeen();
    P = Cade.mkPanel(PANEL_ID, '❓ Trivia Quiz',
      '<div class="tv-top"><span class="tv-title-sm">10-question rounds</span><span class="tv-sp"></span>' +
      '<button class="tv-ic tv-statsbtn" data-act="stats" title="Statistics & settings" aria-label="Statistics and settings">📊</button></div>' +
      '<div class="tv-stage" aria-live="polite"></div><div class="tv-foot"></div>');
    P._onClose = cleanup;
    active = true; openedAt = Date.now();
    blurEditor();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('focusin', onDocFocus, true);
    document.addEventListener('visibilitychange', onVisibility);
    // Minimized to the dock counts as hidden for the question clock.
    P.addEventListener('cade-panel-minimize', onVisibility);
    P.addEventListener('cade-panel-restore', onVisibility);
    P.addEventListener('click', onClick);
    P.addEventListener('change', onChange);
    P.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('button')) e.preventDefault(); // no focus ring / selection on fast taps
    });
    paint();
    var p = P;
    Promise.all([loadBundled(), loadCache()]).then(function () {
      if (P === p) paint();
    }, function () {
      bundled = bundled || [];
      if (P === p) paint();
    });
  }

  Cade.registerWidget({
    name: 'Trivia Quiz',
    description: 'Trivia rounds from Open Trivia DB — categories, timer, streaks, offline set',
    icon: '❓',
    tags: 'game,quiz,trivia,questions,general knowledge,pub quiz,opentdb,multiple choice,true false,fun',
    open: open,
    // Pure logic, exposed for tests / tooling (no side effects).
    _logic: {
      decodeEntities: decodeEntities, decodeUrl: decodeUrl, fromApi: fromApi, parseLocal: parseLocal, validQ: validQ,
      qid: qid, optionsFor: optionsFor, scoreFor: scoreFor, pickLocal: pickLocal, shortCat: shortCat, CATS: CATS,
    },
  });
})();
