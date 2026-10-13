/* Word Guess — find the hidden five-letter word in six tries.
 *
 * DAILY: one puzzle per LOCAL calendar day, the same for everyone: the sorted
 * answer list is shuffled with a fixed seed and day N (days since 1 Jan 2026)
 * picks schedule[N mod length]. PRACTICE: unlimited random words.
 *
 * Green = right letter, right spot; yellow = in the word elsewhere; grey = not
 * in the word (duplicate letters are only marked as many times as the answer
 * has them). Hard mode: revealed hints must be reused. Stats (played, win %,
 * streaks, guess distribution) are kept per mode in Cade.store; a finished
 * game can be shared as an emoji grid (copy) or inserted into the document.
 *
 * Words load lazily from wordle-words.js (~64 KB, precached) on open; the
 * parsed lookup Set is dropped again on close. Keyboard input is captured on
 * document (capture phase) only while the game "has focus": from opening it
 * until the user presses somewhere outside the panel (pressing the panel
 * again re-arms it), so the editor keeps working with the panel open. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('wordle.css');
  var WORDS_URL = Cade.asset('wordle-words.js'); // resolve now, while the loader context is ours
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'wordle-panel';
  var STATE_KEY = 'cade-wordle-state';
  var STATS_KEY = 'cade-wordle-stats';
  var PREFS_KEY = 'cade-wordle-prefs';
  var LEN = 5, ROWS = 6;
  var EPOCH = Date.UTC(2026, 0, 1) / 864e5; // puzzle #1 = 1 Jan 2026
  var SEED = 0x5eed1e5;                      // daily schedule shuffle seed (never change)
  var FLIP_MS = 500, STAGGER = 300;          // reveal timing; wordle.css mirrors FLIP_MS
  var WIN_MSGS = ['Genius', 'Magnificent', 'Impressive', 'Splendid', 'Great', 'Phew'];
  var ORD = ['1st', '2nd', '3rd', '4th', '5th'];
  var KEYS = [['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['', 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ''],
    ['enter', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'back']];
  // Share squares: absent / present / correct (+ high-contrast variants).
  var SQ_DARK = '⬛', SQ_LIGHT = '⬜';
  var SQ_P = '🟨', SQ_C = '🟩', SQ_P_HC = '🟦', SQ_C_HC = '🟧';

  // ---- pure game logic (no DOM; unit-checked in node) ----------------------
  function split5(s) { var out = []; for (var i = 0; i + LEN <= s.length; i += LEN) out.push(s.substr(i, LEN)); return out; }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, seed) {
    var r = mulberry32(seed);
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1)), t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function parseWords(d) {
    var answers = split5(d.answers);
    var valid = new Set(answers);
    split5(d.guesses).forEach(function (w) { valid.add(w); });
    return { answers: answers, schedule: shuffle(answers.slice(), SEED), valid: valid };
  }
  // Local calendar day as an integer (UTC arithmetic so DST shifts can't skew it).
  function dayNumber(date) {
    date = date || new Date();
    return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 864e5) - EPOCH;
  }
  function dailyWord(day, schedule) { var n = schedule.length; return schedule[((day % n) + n) % n]; }

  // 2 = correct spot, 1 = elsewhere in the word, 0 = absent. Greens claim their
  // letters first; yellows then use up what's left, so a letter is never marked
  // more times than the answer contains it.
  function evaluate(guess, answer) {
    var res = [0, 0, 0, 0, 0], left = {}, i;
    for (i = 0; i < LEN; i++) {
      if (guess[i] === answer[i]) res[i] = 2;
      else left[answer[i]] = (left[answer[i]] || 0) + 1;
    }
    for (i = 0; i < LEN; i++) {
      if (res[i] !== 2 && left[guess[i]] > 0) { res[i] = 1; left[guess[i]]--; }
    }
    return res;
  }
  // Hard mode: greens stay put, and every revealed letter (with multiplicity) is reused.
  function hardError(guess, prev, answer) {
    var r, i, res;
    for (r = 0; r < prev.length; r++) {
      res = evaluate(prev[r], answer);
      for (i = 0; i < LEN; i++) {
        if (res[i] === 2 && guess[i] !== prev[r][i]) return ORD[i] + ' letter must be ' + prev[r][i].toUpperCase();
      }
    }
    for (r = 0; r < prev.length; r++) {
      res = evaluate(prev[r], answer);
      var need = {};
      for (i = 0; i < LEN; i++) if (res[i]) need[prev[r][i]] = (need[prev[r][i]] || 0) + 1;
      for (var ch in need) {
        var have = guess.split(ch).length - 1;
        if (have < need[ch]) return 'Guess must contain ' + ch.toUpperCase() + (need[ch] > 1 ? ' ×' + need[ch] : '');
      }
    }
    return '';
  }

  // ---- persistence -----------------------------------------------------------
  function readJSON(key, dflt) {
    try { var v = JSON.parse(Cade.store.get(key) || 'null'); return v == null ? dflt : v; } catch (e) { return dflt; }
  }
  function writeJSON(key, v) { try { Cade.store.set(key, JSON.stringify(v)); } catch (e) {} }
  function blankStats() { return { played: 0, wins: 0, streak: 0, maxStreak: 0, dist: [0, 0, 0, 0, 0, 0], lastWinDay: null }; }
  function cleanStats(s) {
    var b = blankStats();
    if (!s || typeof s !== 'object') return b;
    ['played', 'wins', 'streak', 'maxStreak'].forEach(function (k) { if (typeof s[k] === 'number') b[k] = s[k]; });
    if (Array.isArray(s.dist) && s.dist.length === 6) b.dist = s.dist.map(function (n) { return +n || 0; });
    if (typeof s.lastWinDay === 'number') b.lastWinDay = s.lastWinDay;
    return b;
  }
  function cleanGame(g) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.guesses)) return null;
    var guesses = g.guesses.filter(function (w) { return typeof w === 'string' && /^[a-z]{5}$/.test(w); }).slice(0, ROWS);
    return {
      day: typeof g.day === 'number' ? g.day : null,
      answer: typeof g.answer === 'string' && /^[a-z]{5}$/.test(g.answer) ? g.answer : null,
      guesses: guesses, status: g.status === 'won' || g.status === 'lost' ? g.status : 'play',
      hard: !!g.hard, counted: !!g.counted,
    };
  }

  var prefs = { mode: 'daily', hard: false, hc: false };
  var stats = { daily: blankStats(), practice: blankStats() };
  var games = { daily: null, practice: null };
  function loadAll() {
    var p = readJSON(PREFS_KEY, {});
    prefs.mode = p.mode === 'practice' ? 'practice' : 'daily';
    prefs.hard = !!p.hard; prefs.hc = !!p.hc;
    var s = readJSON(STATS_KEY, {});
    stats.daily = cleanStats(s.daily); stats.practice = cleanStats(s.practice);
    var g = readJSON(STATE_KEY, {});
    games.daily = cleanGame(g.daily); games.practice = cleanGame(g.practice);
  }
  function savePrefs() { writeJSON(PREFS_KEY, prefs); }
  function saveStats() { writeJSON(STATS_KEY, stats); }
  function saveGames() {
    // The daily answer is derived from the day, so only practice stores its word.
    var d = games.daily;
    writeJSON(STATE_KEY, {
      daily: d && { day: d.day, guesses: d.guesses, status: d.status, hard: d.hard, counted: d.counted },
      practice: games.practice,
    });
  }

  // ---- runtime state -----------------------------------------------------------
  var P = null;          // live panel
  var data = null;       // parsed words (null while closed)
  var loading = null;
  var cur = '';          // letters typed into the current row
  var busy = false;      // a reveal animation is running
  var active = false;    // physical keyboard routed to the game
  var sheet = '';        // '', 'help', 'stats', 'settings'
  var timers = [];
  var tick = 0;          // countdown interval
  var giveUpArmed = 0;   // two-tap "give up" for a practice game in progress
  var stickyMsg = false;

  function later(fn, ms) { var t = setTimeout(function () { timers.splice(timers.indexOf(t), 1); if (P) fn(); }, ms); timers.push(t); return t; }
  function reduced() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function isDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }

  function loadWords() {
    if (window.__cadeWordleWords) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = WORDS_URL;
      s.onload = function () { loading = null; if (window.__cadeWordleWords) resolve(); else reject(new Error('no data')); };
      s.onerror = function () { loading = null; s.remove(); reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function game() { return games[prefs.mode]; }
  function answerOf(g) { return g.answer || dailyWord(g.day, data.schedule); }
  function newDaily() { games.daily = { day: dayNumber(), answer: null, guesses: [], status: 'play', hard: prefs.hard, counted: false }; }
  function newPractice() {
    var prev = games.practice && games.practice.answer, today = dailyWord(dayNumber(), data.schedule), w;
    do { w = data.answers[(Math.random() * data.answers.length) | 0]; } while ((w === prev || w === today) && data.answers.length > 2);
    games.practice = { day: null, answer: w, guesses: [], status: 'play', hard: prefs.hard, counted: false };
  }
  function ensureGames() {
    if (!games.daily || games.daily.day !== dayNumber()) newDaily();
    if (!games.practice || !games.practice.answer || !data.valid.has(games.practice.answer)) newPractice();
    saveGames();
  }

  function record(mode, g) {
    if (g.counted) return;
    g.counted = true;
    var s = stats[mode], won = g.status === 'won';
    s.played++;
    if (won) {
      s.wins++;
      s.dist[g.guesses.length - 1]++;
      // Daily streaks need consecutive days; practice streaks consecutive wins.
      s.streak = mode === 'daily' ? (s.lastWinDay === g.day - 1 ? s.streak + 1 : 1) : s.streak + 1;
      if (mode === 'daily') s.lastWinDay = g.day;
    } else s.streak = 0;
    if (s.streak > s.maxStreak) s.maxStreak = s.streak;
    saveStats();
  }
  function currentStreak(mode) {
    var s = stats[mode];
    if (mode === 'daily' && (s.lastWinDay == null || s.lastWinDay < dayNumber() - 1)) return 0; // missed a day
    return s.streak;
  }

  function shareText(mode, g) {
    var ans = answerOf(g);
    var sq = [isDark() ? SQ_DARK : SQ_LIGHT, prefs.hc ? SQ_P_HC : SQ_P, prefs.hc ? SQ_C_HC : SQ_C];
    var head = 'Word Guess ' + (mode === 'daily' ? '#' + (g.day + 1) : '(practice)') + ' ' +
      (g.status === 'won' ? g.guesses.length : 'X') + '/' + ROWS + (g.hard ? '*' : '');
    return head + '\n\n' + g.guesses.map(function (w) {
      return evaluate(w, ans).map(function (v) { return sq[v]; }).join('');
    }).join('\n');
  }

  // ---- DOM ------------------------------------------------------------------------
  function q(sel) { return P ? P.querySelector(sel) : null; }
  function rowEl(r) { return P.querySelectorAll('.wd-row')[r]; }
  var STATE_CH = ['a', 'p', 'c'];

  function bodyHtml() {
    var rows = '';
    for (var r = 0; r < ROWS; r++) {
      rows += '<div class="wd-row">';
      for (var i = 0; i < LEN; i++) rows += '<div class="wd-tile"></div>';
      rows += '</div>';
    }
    var kb = KEYS.map(function (row) {
      return '<div class="wd-kr">' + row.map(function (k) {
        if (!k) return '<span class="wd-half"></span>';
        if (k === 'enter') return '<button class="wd-key wide" data-k="enter" aria-label="Enter">Enter</button>';
        if (k === 'back') return '<button class="wd-key wide" data-k="back" aria-label="Backspace">⌫</button>';
        return '<button class="wd-key" data-k="' + k + '">' + k + '</button>';
      }).join('') + '</div>';
    }).join('');
    var chart = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><rect x="3" y="12" width="4.5" height="9" rx="1"/><rect x="9.75" y="6" width="4.5" height="15" rx="1"/><rect x="16.5" y="3" width="4.5" height="18" rx="1"/></svg>';
    return '<div class="wd-bar">' +
        '<div class="wd-modes" role="tablist">' +
          '<button class="wd-mode" data-mode="daily" role="tab">Daily</button>' +
          '<button class="wd-mode" data-mode="practice" role="tab">Practice</button>' +
        '</div>' +
        '<button class="wd-ic wd-new" title="New practice word" aria-label="New practice word">↻</button>' +
        '<button class="wd-ic" data-sheet="help" title="How to play" aria-label="How to play">?</button>' +
        '<button class="wd-ic" data-sheet="stats" title="Statistics" aria-label="Statistics">' + chart + '</button>' +
        '<button class="wd-ic" data-sheet="settings" title="Settings" aria-label="Settings">⚙\ufe0e</button>' +
      '</div>' +
      '<div class="wd-main">' +
        '<div class="wd-board" role="group" aria-label="Guesses">' + rows + '</div>' +
        '<div class="wd-toast" role="status" aria-live="polite"></div>' +
        '<div class="wd-sheet" hidden></div>' +
        '<div class="wd-loading">Loading words…</div>' +
      '</div>' +
      '<div class="wd-kb" aria-label="Keyboard">' + kb + '</div>' +
      '<div class="wd-hint">Click the game to type · Esc closes</div>';
  }

  function setTile(t, ch, st) {
    t.textContent = ch || '';
    if (st != null) t.setAttribute('data-s', st); else t.removeAttribute('data-s');
  }

  function paintBoard() {
    var g = game(), ans = answerOf(g);
    for (var r = 0; r < ROWS; r++) {
      var tiles = rowEl(r).children;
      var w = g.guesses[r], res = w ? evaluate(w, ans) : null;
      for (var i = 0; i < LEN; i++) {
        tiles[i].className = 'wd-tile';
        if (w) setTile(tiles[i], w[i], STATE_CH[res[i]]);
        else if (r === g.guesses.length && g.status === 'play' && cur[i]) setTile(tiles[i], cur[i], 'tbd');
        else setTile(tiles[i], '', null);
      }
    }
  }

  function paintKeys() {
    var g = game(), ans = answerOf(g), best = {};
    g.guesses.forEach(function (w) {
      var res = evaluate(w, ans);
      for (var i = 0; i < LEN; i++) if (!(w[i] in best) || res[i] > best[w[i]]) best[w[i]] = res[i];
    });
    var keys = P.querySelectorAll('.wd-key[data-k]');
    for (var k = 0; k < keys.length; k++) {
      var ch = keys[k].getAttribute('data-k');
      if (ch in best) keys[k].setAttribute('data-s', STATE_CH[best[ch]]); else keys[k].removeAttribute('data-s');
    }
  }

  function paintBar() {
    var g = games.daily;
    P.querySelectorAll('.wd-mode').forEach(function (b) {
      var m = b.getAttribute('data-mode'), on = m === prefs.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      if (m === 'daily' && g) b.textContent = 'Daily #' + (g.day + 1);
    });
    q('.wd-new').hidden = prefs.mode !== 'practice';
    P.classList.toggle('wd-hc', !!prefs.hc);
  }

  function paintAll() {
    if (!P || !data) return;
    hideMsg(true);
    paintBar(); paintBoard(); paintKeys();
    var g = game();
    if (g.status === 'lost') msg(answerOf(g).toUpperCase(), 0);
  }

  var msgTimer = 0;
  function msg(text, ms) {
    var t = q('.wd-toast'); if (!t) return;
    clearTimeout(msgTimer);
    t.textContent = text; t.classList.add('on');
    stickyMsg = !ms;
    if (ms) msgTimer = setTimeout(function () { if (t.isConnected) t.classList.remove('on'); }, ms);
  }
  function hideMsg(force) {
    if (stickyMsg && !force) return;
    var t = q('.wd-toast'); if (t) t.classList.remove('on');
    stickyMsg = false;
  }

  function shake(text) {
    msg(text, 1400);
    try { Cade.haptic(30); } catch (e) {}
    var row = rowEl(game().guesses.length);
    if (!row || reduced()) return;
    row.classList.remove('wd-shake'); void row.offsetWidth; row.classList.add('wd-shake');
    later(function () { row.classList.remove('wd-shake'); }, 650);
  }

  // ---- input ------------------------------------------------------------------------
  function typeLetter(ch) {
    var g = game();
    if (!data || busy || g.status !== 'play' || cur.length >= LEN) return;
    cur += ch;
    var t = rowEl(g.guesses.length).children[cur.length - 1];
    setTile(t, ch, 'tbd');
    if (!reduced()) { t.classList.remove('wd-pop'); void t.offsetWidth; t.classList.add('wd-pop'); }
  }
  function backspace() {
    var g = game();
    if (!data || busy || g.status !== 'play' || !cur.length) return;
    cur = cur.slice(0, -1);
    var t = rowEl(g.guesses.length).children[cur.length];
    t.classList.remove('wd-pop');
    setTile(t, '', null);
  }

  function submit() {
    var g = game();
    if (!data || busy || sheet || g.status !== 'play') return;
    if (cur.length < LEN) { shake('Not enough letters'); return; }
    if (!data.valid.has(cur)) { shake('Not in word list'); return; }
    var ans = answerOf(g);
    if (!g.guesses.length) g.hard = prefs.hard; // hard mode is fixed for the round at the first guess
    if (g.hard) { var err = hardError(cur, g.guesses, ans); if (err) { shake(err); return; } }
    var row = g.guesses.length, guess = cur, res = evaluate(guess, ans), mode = prefs.mode;
    g.guesses.push(guess);
    cur = '';
    if (guess === ans) g.status = 'won';
    else if (g.guesses.length >= ROWS) g.status = 'lost';
    if (g.status !== 'play') record(mode, g);
    saveGames(); // persist before animating: closing mid-reveal must not lose the guess
    giveUpArmed = 0;
    reveal(row, res, function () {
      paintKeys();
      if (g.status === 'won') {
        msg(WIN_MSGS[row], 1800);
        bounce(row);
        later(function () { if (game() === g) openSheet('stats', true); }, reduced() ? 900 : 1700);
      } else if (g.status === 'lost') {
        msg(ans.toUpperCase(), 0);
        later(function () { if (game() === g) openSheet('stats', true); }, 1500);
      }
    });
  }

  function reveal(r, res, done) {
    var tiles = rowEl(r).children;
    if (reduced()) {
      for (var i = 0; i < LEN; i++) tiles[i].setAttribute('data-s', STATE_CH[res[i]]);
      done(); return;
    }
    busy = true;
    Array.prototype.forEach.call(tiles, function (t, i) {
      later(function () { t.classList.remove('wd-pop'); t.classList.add('wd-flip'); }, i * STAGGER);
      later(function () { t.setAttribute('data-s', STATE_CH[res[i]]); }, i * STAGGER + FLIP_MS / 2);
    });
    later(function () {
      Array.prototype.forEach.call(tiles, function (t) { t.classList.remove('wd-flip'); });
      busy = false;
      done();
    }, (LEN - 1) * STAGGER + FLIP_MS);
  }
  function bounce(r) {
    if (reduced()) return;
    Array.prototype.forEach.call(rowEl(r).children, function (t, i) {
      t.style.animationDelay = (i * 100) + 'ms';
      t.classList.add('wd-bounce');
      later(function () { t.classList.remove('wd-bounce'); t.style.animationDelay = ''; }, 1000 + i * 100 + 50);
    });
  }

  function setMode(m) {
    if (busy || m === prefs.mode) return;
    prefs.mode = m; savePrefs();
    cur = ''; giveUpArmed = 0;
    closeSheet();
    paintAll();
  }

  function newPracticeGame() {
    if (busy) return;
    var g = games.practice;
    if (g && g.status === 'play' && g.guesses.length) {
      if (!giveUpArmed) {
        giveUpArmed = 1;
        msg('Tap ↻ again to give up', 2200);
        later(function () { giveUpArmed = 0; }, 2500);
        return;
      }
      g.status = 'lost';
      record('practice', g);
      Cade.showToast('The word was ' + answerOf(g).toUpperCase(), 'info', 2500);
    }
    giveUpArmed = 0;
    newPractice(); saveGames();
    cur = ''; closeSheet(); paintAll();
  }

  // ---- sheets (help / stats / settings) ------------------------------------------------
  function closeSheet() {
    sheet = '';
    if (tick) { clearInterval(tick); tick = 0; }
    var s = q('.wd-sheet'); if (s) { s.hidden = true; s.innerHTML = ''; }
  }
  function openSheet(name, force) {
    if (!P || !data) return;
    if (sheet === name && !force) { closeSheet(); return; }
    closeSheet();
    sheet = name;
    var s = q('.wd-sheet');
    s.innerHTML = '<button class="wd-sh-x" data-act="close-sheet" aria-label="Close">×</button>' +
      (name === 'help' ? helpHtml() : name === 'stats' ? statsHtml() : settingsHtml());
    s.hidden = false;
    s.scrollTop = 0;
    if (name === 'stats' && prefs.mode === 'daily' && game().status !== 'play') {
      countdown();
      tick = setInterval(countdown, 1000);
    }
  }

  function exRow(word, idx, st) {
    return '<div class="wd-ex">' + word.split('').map(function (ch, i) {
      return '<span class="wd-tile"' + (i === idx ? ' data-s="' + st + '"' : '') + '>' + ch + '</span>';
    }).join('') + '</div>';
  }
  function helpHtml() {
    return '<div class="wd-sh-title">How to play</div>' +
      '<p>Guess the hidden word in ' + ROWS + ' tries. Each guess must be a valid five-letter word; tile colours show how close you were.</p>' +
      exRow('crane', 0, 'c') + '<p><b>C</b> is in the word, in the right spot.</p>' +
      exRow('pilot', 1, 'p') + '<p><b>I</b> is in the word, but in another spot.</p>' +
      exRow('vague', 3, 'a') + '<p><b>U</b> is not in the word anywhere.</p>' +
      '<p class="wd-sm"><b>Daily</b> is one shared puzzle per day (a new word at local midnight). <b>Practice</b> gives unlimited random words. ' +
      '<b>Hard mode</b> (⚙): revealed hints must be used in later guesses.</p>' +
      '<p class="wd-sm">Type on your keyboard or tap the keys. Enter submits, Backspace deletes, Esc closes.</p>';
  }
  function statsHtml() {
    var mode = prefs.mode, s = stats[mode], g = game();
    var winPct = s.played ? Math.round(100 * s.wins / s.played) : 0;
    var max = Math.max.apply(null, s.dist.concat([1]));
    var hiRow = g.status === 'won' ? g.guesses.length - 1 : -1;
    var html = '<div class="wd-sh-title">' + (mode === 'daily' ? 'Daily' : 'Practice') + ' statistics</div>' +
      '<div class="wd-stats">' +
        stat(s.played, 'Played') + stat(winPct, 'Win %') + stat(currentStreak(mode), 'Current streak') + stat(s.maxStreak, 'Max streak') +
      '</div>' +
      '<div class="wd-sub">Guess distribution</div><div class="wd-dist">';
    for (var i = 0; i < ROWS; i++) {
      var w = Math.max(7, Math.round(100 * s.dist[i] / max));
      html += '<div class="wd-dr"><span>' + (i + 1) + '</span><div class="wd-db' + (i === hiRow ? ' hi' : '') + '" style="width:' + w + '%">' + s.dist[i] + '</div></div>';
    }
    html += '</div>';
    if (g.status !== 'play') {
      html += (mode === 'daily' ? '<div class="wd-next">Next puzzle in <b class="wd-cd">--:--:--</b></div>' : '') +
        '<div class="wd-acts">' +
          '<button class="wd-btn primary" data-act="share">Share ⧉</button>' +
          '<button class="wd-btn" data-act="insert">Insert into document</button>' +
          (mode === 'practice' ? '<button class="wd-btn" data-act="new">New word ↻</button>' : '') +
        '</div>';
    } else if (!s.played) {
      html += '<p class="wd-sm wd-center">Finish a game to start your stats.</p>';
    }
    return html;
  }
  function stat(n, label) { return '<div class="wd-stat"><b>' + n + '</b><span>' + label + '</span></div>'; }

  function settingsHtml() {
    var g = game(), locked = g.status === 'play' && g.guesses.length > 0;
    return '<div class="wd-sh-title">Settings</div>' +
      toggleRow('hard', 'Hard mode', 'Any revealed hints must be used in subsequent guesses' + (locked ? ' — can only be changed at the start of a round' : ''), prefs.hard, locked) +
      toggleRow('hc', 'High contrast colours', 'Orange and blue instead of green and yellow (colour-blind friendly)', prefs.hc, false) +
      '<div class="wd-acts"><button class="wd-btn danger" data-act="reset">Reset ' + (prefs.mode === 'daily' ? 'daily' : 'practice') + ' statistics</button></div>';
  }
  function toggleRow(key, label, hint, on, locked) {
    return '<div class="wd-set' + (locked ? ' locked' : '') + '"><div><div class="wd-set-l">' + esc(label) + '</div><div class="wd-set-h">' + esc(hint) + '</div></div>' +
      '<button class="wd-sw' + (on ? ' on' : '') + '" data-set="' + key + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" aria-label="' + esc(label) + '"><i></i></button></div>';
  }

  function countdown() {
    var el = q('.wd-cd');
    var g = games.daily;
    if (g && g.day !== dayNumber()) {
      // Midnight passed while the stats were up: move on to the new puzzle.
      newDaily(); saveGames();
      if (prefs.mode === 'daily') { closeSheet(); cur = ''; paintAll(); msg('New puzzle!', 1800); }
      return;
    }
    if (!el) return;
    var now = new Date(), next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    var s = Math.max(0, Math.floor((next - now) / 1000));
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    el.textContent = p2(Math.floor(s / 3600)) + ':' + p2(Math.floor(s / 60) % 60) + ':' + p2(s % 60);
  }

  // ---- actions ----------------------------------------------------------------------
  function copyText(text, okMsg) {
    var done = function () { msg(okMsg || 'Copied', 1400); };
    var fail = function () { Cade.showToast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      ta.remove();
    }
  }
  function insertText(text) {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode — editing is locked', 'error', 2000); return; }
    ed.dispatch(ed.state.replaceSelection(text), { userEvent: 'input', scrollIntoView: true });
    Cade.showToast('Result inserted', 'success', 1200);
  }

  function setPref(key) {
    var g = game();
    if (key === 'hard' && g.status === 'play' && g.guesses.length) {
      msg('Hard mode can only change at the start of a round', 1800);
      return;
    }
    prefs[key] = !prefs[key];
    if (key === 'hard' && g.status === 'play' && !g.guesses.length) g.hard = prefs.hard;
    savePrefs();
    paintBar();
    openSheet(sheet, true);
  }

  function onClick(e) {
    var t = e.target.closest ? e.target : null, b;
    if (!t || !P) return;
    if ((b = t.closest('.wd-key'))) {
      var k = b.getAttribute('data-k');
      if (sheet) closeSheet();
      if (k === 'enter') submit(); else if (k === 'back') backspace(); else typeLetter(k);
      return;
    }
    if ((b = t.closest('.wd-mode'))) { setMode(b.getAttribute('data-mode')); return; }
    if (t.closest('.wd-new')) { newPracticeGame(); return; }
    if ((b = t.closest('[data-sheet]'))) { openSheet(b.getAttribute('data-sheet')); return; }
    if ((b = t.closest('[data-set]'))) { setPref(b.getAttribute('data-set')); return; }
    if ((b = t.closest('[data-act]'))) {
      var act = b.getAttribute('data-act'), g = game();
      if (act === 'close-sheet') closeSheet();
      else if (act === 'share') copyText(shareText(prefs.mode, g), 'Copied result to clipboard');
      else if (act === 'insert') insertText(shareText(prefs.mode, g) + '\n');
      else if (act === 'new') newPracticeGame();
      else if (act === 'reset') {
        if (confirm('Reset your ' + prefs.mode + ' Word Guess statistics?')) {
          stats[prefs.mode] = blankStats(); saveStats();
          msg('Statistics reset', 1400);
        }
      }
    }
  }

  function onKey(e) {
    if (!P || !P.isConnected || !active) return;
    if (Cade.isMinimized && Cade.isMinimized(P)) return; // parked in the dock: keys belong to the editor
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    var k = e.key;
    if (k === 'Escape') { if (sheet) closeSheet(); else close(); }
    else if (k === 'Enter') { if (sheet) closeSheet(); else submit(); }
    else if (k === 'Backspace') { if (sheet) closeSheet(); backspace(); }
    else if (k.length === 1 && /[a-z]/i.test(k)) { if (sheet) closeSheet(); typeLetter(k.toLowerCase()); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // A press inside the panel arms keyboard capture; a press anywhere else
  // (the editor, another panel) or focus moving elsewhere (Ctrl+K palette,
  // a dialog) hands the keyboard back.
  function setActive(on) {
    if (!P || on === active) return;
    active = on;
    P.classList.toggle('wd-idle', !active);
    if (active) blurEditor();
  }
  function onDocPointer(e) { if (P) setActive(P.contains(e.target)); }
  // Focus settling right after opening (the Ctrl+K palette closing, the editor
  // refocusing) must not hand the keyboard straight back.
  var openedAt = 0;
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
    timers.forEach(clearTimeout); timers = [];
    if (tick) { clearInterval(tick); tick = 0; }
    clearTimeout(msgTimer);
    P = null; data = null; busy = false; sheet = ''; cur = ''; active = false; stickyMsg = false;
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
    P = Cade.mkPanel(PANEL_ID, '🟩 Word Guess', bodyHtml());
    P._onClose = cleanup;
    P.classList.add('wd-loading-on');
    P.classList.toggle('wd-hc', !!prefs.hc);
    active = true; openedAt = Date.now();
    blurEditor(); // the game takes the keyboard; on phones this also drops the soft keyboard
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('focusin', onDocFocus, true);
    P.addEventListener('click', onClick);
    // Keys/buttons must not take focus or start a text selection (fast taps).
    P.addEventListener('mousedown', function (e) {
      if (!(e.target.closest && e.target.closest('.cade-panel-head'))) e.preventDefault();
    });
    var p = P;
    loadWords().then(function () {
      if (P !== p) return;
      data = parseWords(window.__cadeWordleWords);
      ensureGames();
      P.classList.remove('wd-loading-on');
      paintAll();
      if (!stats.daily.played && !stats.practice.played && !games.daily.guesses.length) openSheet('help');
    }, function () {
      if (P !== p) return;
      var l = q('.wd-loading');
      if (l) l.textContent = 'Couldn’t load the word list' + (navigator.onLine ? '' : ' — it needs one online load to cache');
    });
  }

  Cade.registerWidget({
    name: 'Word Guess',
    description: 'Guess the five-letter word in six tries — daily puzzle & practice',
    icon: '🟩',
    tags: 'game,word,wordle,word game,guess,puzzle,daily,five letters,5 letters,fun,train',
    open: open,
    // Pure logic, exposed for tests / tooling (no side effects).
    _logic: { evaluate: evaluate, hardError: hardError, dayNumber: dayNumber, dailyWord: dailyWord, parseWords: parseWords, shuffle: shuffle, EPOCH: EPOCH },
  });
})();
