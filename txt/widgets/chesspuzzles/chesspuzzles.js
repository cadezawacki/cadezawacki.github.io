/* Chess Puzzles — mate in one, two and three, for Cade.txt.
 * 172 original puzzles (chesspuzzles-data.js), each proven by the engine's
 * exact mate solver: a forced mate in exactly n with only one first move.
 * Three ways to play:
 *   Daily    — the same puzzle for everyone today; a streak of days solved.
 *   Rated    — a puzzle rating that moves with every result (Elo-style); puzzles
 *              are picked near your rating; a run of solves is your streak.
 *   Practice — work through mate-in-1 / 2 / 3, retry freely.
 * The computer plays the defence (the most stubborn reply). Any move that still
 * forces mate in time is accepted after the first. Hint (piece, then arrow),
 * retry, and the solution played out. The chess engine and board view are
 * shared with the Chess widget (loaded from ../chess/). Keys: H hint, R retry,
 * S solution, N / Enter next, Esc close. Saves in Cade.store (cade-chesspuzzles-*).
 * Offline; no network. */
(function () {
  'use strict';

  // ================= pure helpers (no DOM — unit-checked in node) =================
  function parsePuzzles(data) {
    var out = [];
    ((data && data.p) || []).forEach(function (s, i) {
      var f = String(s).split('|');
      if (f.length < 4) return;
      out.push({ id: i + 1, fen: f[0], n: +f[1] || 1, rating: +f[2] || 1000, line: f[3].split(' ').filter(Boolean) });
    });
    return out;
  }
  function ymd(d) { return d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1) + '-' + (d.getDate() < 10 ? '0' : '') + d.getDate(); }
  function dayNum(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) : 0; }
  function dailyIndex(dateStr, epoch, count) {
    if (!count) return 0;
    var d = dayNum(dateStr) - dayNum(epoch || '2026-11-01');
    return ((d % count) + count) % count;
  }
  function expected(r, pr) { return 1 / (1 + Math.pow(10, (pr - r) / 400)); }
  function rateAfter(r, pr, solved, played) {
    var K = played < 15 ? 48 : 28, d = K * ((solved ? 1 : 0) - expected(r, pr));
    if (solved && d < 2) d = 2;                // a solve always counts for something
    if (!solved && d > -2) d = -2;
    return Math.max(100, Math.min(3000, Math.round(r + d)));
  }
  // A rated puzzle near `rating`, not seen lately; widens the window until there's a choice.
  function pickRated(list, rating, recent, rand) {
    rand = rand || Math.random;
    var seen = {};
    (recent || []).forEach(function (id) { seen[id] = 1; });
    for (var w = 120; w < 4000; w *= 1.6) {
      var c = list.filter(function (p) { return !seen[p.id] && Math.abs(p.rating - rating) <= w; });
      if (c.length >= 3 || w * 1.6 >= 4000) { if (c.length) return c[Math.floor(rand() * c.length)]; break; }
    }
    var rest = list.filter(function (p) { return !seen[p.id]; });
    if (!rest.length) rest = list;
    rest.sort(function (a, b) { return Math.abs(a.rating - rating) - Math.abs(b.rating - rating); });
    return rest[0] || null;
  }
  // Practice: the next unsolved puzzle of the filter (n = 0 → any) after `afterId`, wrapping; solved ones last.
  function nextPractice(list, n, solved, afterId) {
    var pool = list.filter(function (p) { return !n || p.n === n; });
    if (!pool.length) return null;
    var start = 0;
    for (var i = 0; i < pool.length; i++) if (pool[i].id === afterId) { start = i + 1; break; }
    for (i = 0; i < pool.length; i++) { var p = pool[(start + i) % pool.length]; if (!solved[p.id]) return p; }
    return pool[start % pool.length];
  }
  // Practice on open / tab switch: the puzzle you were on, unless you'd already solved it (then the next one).
  function resumePractice(list, n, solved, pid) {
    var p = pid ? list[pid - 1] : null;
    if (p && (!n || p.n === n) && !solved[p.id]) return p;
    return nextPractice(list, n, solved, p ? p.id : 0);
  }
  function newSave() {
    return { v: 1, rating: 800, peak: 800, played: 0, streak: 0, bestStreak: 0, solved: {}, failed: {}, recent: [], cur: 0,
      daily: {}, dailyStreak: 0, bestDaily: 0, lastDaily: '', mode: 'daily', filter: 0, practiceId: 0 };
  }
  function normSave(o, count) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    function num(v, a, b, d) { v = +v; return isFinite(v) ? Math.max(a, Math.min(b, Math.round(v))) : d; }
    s.rating = num(o.rating, 100, 3000, 800); s.peak = Math.max(s.rating, num(o.peak, 100, 3000, 800));
    s.played = num(o.played, 0, 1e6, 0); s.streak = num(o.streak, 0, 1e6, 0); s.bestStreak = Math.max(s.streak, num(o.bestStreak, 0, 1e6, 0));
    ['solved', 'failed'].forEach(function (k) {
      if (o[k] && typeof o[k] === 'object') for (var id in o[k]) { var i = +id; if (i >= 1 && i <= (count || 1e6) && (o[k][id] === 1 || o[k][id] === 2)) s[k][i] = o[k][id]; }
    });
    if (Array.isArray(o.recent)) s.recent = o.recent.map(Number).filter(function (i) { return i >= 1 && i <= (count || 1e6); }).slice(-40);
    s.cur = num(o.cur, 0, count || 1e6, 0);
    if (o.daily && typeof o.daily === 'object') for (var d in o.daily) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (o.daily[d] === 'clean' || o.daily[d] === 'solved' || o.daily[d] === 'failed')) s.daily[d] = o.daily[d];
    s.dailyStreak = num(o.dailyStreak, 0, 1e5, 0); s.bestDaily = Math.max(s.dailyStreak, num(o.bestDaily, 0, 1e5, 0));
    s.lastDaily = /^\d{4}-\d{2}-\d{2}$/.test(o.lastDaily || '') ? o.lastDaily : '';
    s.mode = o.mode === 'rated' || o.mode === 'practice' ? o.mode : 'daily';
    s.filter = [0, 1, 2, 3].indexOf(+o.filter) >= 0 ? +o.filter : 0;
    s.practiceId = num(o.practiceId, 0, count || 1e6, 0);
    return s;
  }
  // Record a finished puzzle. kind: 'rated' | 'practice' | 'daily'; clean = no mistakes, hints or solution.
  function settle(save, p, kind, solved, clean, today) {
    var res = { delta: 0, streak: save.streak, newBest: false };
    if (solved) save.solved[p.id] = clean ? 1 : (save.solved[p.id] === 1 ? 1 : 2);
    else save.failed[p.id] = 1;
    if (kind === 'rated') {
      var before = save.rating, ok = solved && clean;
      save.rating = rateAfter(save.rating, p.rating, ok, save.played);
      save.played++;
      res.delta = save.rating - before;
      if (ok) { save.streak++; if (save.streak > save.bestStreak) { save.bestStreak = save.streak; res.newBest = true; } }
      else save.streak = 0;
      res.streak = save.streak;
      if (save.rating > save.peak) save.peak = save.rating;
      save.recent.push(p.id);
      if (save.recent.length > 40) save.recent.splice(0, save.recent.length - 40);
    } else if (kind === 'daily' && today && !save.daily[today]) {
      save.daily[today] = solved ? (clean ? 'clean' : 'solved') : 'failed';
      if (solved) {
        save.dailyStreak = save.lastDaily && dayNum(today) - dayNum(save.lastDaily) === 1 ? save.dailyStreak + 1 : 1;
        save.lastDaily = today;
        if (save.dailyStreak > save.bestDaily) save.bestDaily = save.dailyStreak;
      } else save.dailyStreak = 0;
      res.streak = save.dailyStreak;
    }
    return res;
  }
  // Is `m` (just played by the solver from pos) good, with `left` solver moves to mate (this one included)?
  // 'mate' (it mates now) | 'ok' (still forced mate in time) | 'wrong'.
  function judge(E, pos, m, left, memo) {
    pos.make(m);
    var r;
    if (pos.inCheck() && !pos.hasLegal()) r = 'mate';
    else r = left > 1 && E.mateDefend(pos, left, memo) ? 'ok' : 'wrong';
    pos.unmake();
    return r;
  }

  var HELPERS = { parsePuzzles: parsePuzzles, ymd: ymd, dayNum: dayNum, dailyIndex: dailyIndex, expected: expected, rateAfter: rateAfter,
    pickRated: pickRated, nextPractice: nextPractice, resumePractice: resumePractice, newSave: newSave, normSave: normSave, settle: settle, judge: judge };
  if (typeof module !== 'undefined' && module.exports) module.exports = HELPERS;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('chesspuzzles.css');
  var BASE = Cade.baseURL(), DATA_URL = Cade.asset('chesspuzzles-data.js');
  var CHESS = BASE.replace(/chesspuzzles\/$/, 'chess/');
  var ENGINE_URL = CHESS + 'chess-engine.js', BOARD_URL = CHESS + 'chess-board.js', BOARD_CSS = CHESS + 'chess-board.css';

  var PANEL_ID = 'chesspuzzles-panel', NAME = 'Chess Puzzles';
  var KEY = 'cade-chesspuzzles-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound', STYLE_KEY = KEY + 'style';
  var E = null, BV = null, PZ = null, EPOCH = '2026-11-01', loading = null;
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.chesspuzzles = { live: function () { return S; } };

  function loadScript(url, test) {
    return new Promise(function (res, rej) {
      if (test()) { res(); return; }
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = function () { test() ? res() : rej(new Error('load ' + url)); };
      s.onerror = function () { rej(new Error('load ' + url)); };
      document.head.appendChild(s);
    });
  }
  function ensureLibs() {
    if (E && BV && PZ) return Promise.resolve();
    if (!loading) {
      try {
        var href = new URL(BOARD_CSS, location.href).href;
        var have = Array.prototype.some.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) { return l.href === href; });
        if (!have) { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); }
      } catch (e) {}
      loading = Promise.all([
        loadScript(ENGINE_URL, function () { return !!window.__cadeChessEngine; }),
        loadScript(BOARD_URL, function () { return !!window.__cadeChessBoard; }),
        loadScript(DATA_URL, function () { return !!window.__cadeChessPuzzles; })
      ]).then(function () {
        E = window.__cadeChessEngine; BV = window.__cadeChessBoard;
        PZ = parsePuzzles(window.__cadeChessPuzzles); EPOCH = window.__cadeChessPuzzles.epoch || EPOCH;
      }, function (e) { loading = null; throw e; });
    }
    return loading;
  }

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function toast(msg, type, ms) { if (Cade.showToast) Cade.showToast(msg, type || 'info', ms || 1800); }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function today() { return ymd(new Date()); }

  // ---- sound ----
  function Snd(on) { this.on = !!on; this.ac = null; }
  Snd.prototype.ensure = function () {
    if (!this.on) return;
    if (!this.ac) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; try { this.ac = new AC(); } catch (e) { this.ac = null; return; } }
    if (this.ac.state === 'suspended') { try { this.ac.resume(); } catch (e) {} }
  };
  Snd.prototype.tone = function (f, dur, type, vol, slide, delay) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      var t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };
  function sfx(kind) {
    if (!S) return;
    var s = S.snd;
    if (kind === 'move') s.tone(520, 0.05, 'triangle', 0.05, 380);
    else if (kind === 'cap') { s.tone(300, 0.08, 'square', 0.035, 160); s.tone(900, 0.03, 'triangle', 0.02); }
    else if (kind === 'good') { s.tone(784, 0.07, 'triangle', 0.045); s.tone(1046, 0.1, 'triangle', 0.04, 0, 0.06); }
    else if (kind === 'bad') { s.tone(196, 0.16, 'sawtooth', 0.03, 140); }
    else if (kind === 'win') [523, 659, 784, 1047, 1319].forEach(function (f, i) { s.tone(f, 0.14, 'triangle', 0.04, 0, i * 0.08); });
    else if (kind === 'hint') { s.tone(1046, 0.06, 'sine', 0.035); }
    else if (kind === 'click') s.tone(880, 0.04, 'sine', 0.03);
  }
  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_STATS = svg('<path d="M5 20V10M12 20V4M19 20v-7"/>');
  var IC_HINT = svg('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>');
  var IC_RETRY = svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>');
  var IC_EYE = svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>');
  var IC_NEXT = svg('<path d="M5 12h14M13 6l6 6-6 6"/>');

  // ---- a puzzle on the board ----
  // T: { p, pos, step (plies played), left (solver moves to go), state: 'play'|'wait'|'solved'|'failed'|'show', clean, mistakes, hint }
  function loadPuzzle(p, kind, fresh) {
    clearTimeout(S.replyT); clearTimeout(S.showT); clearTimeout(S.undoT);
    S.T = { p: p, kind: kind, pos: E.fromFEN(p.fen), step: 0, left: p.n, state: 'play', clean: true, mistakes: 0, hint: 0, memo: new Map(), last: null, wrong: -1, good: -1, settled: false, played: [] };
    S.T.solver = S.T.pos.side;
    if (kind === 'rated') { S.save.cur = p.id; persist(); }
    if (kind === 'practice') { S.save.practiceId = p.id; persist(); }
    if (kind === 'daily' && !fresh && S.save.daily[today()]) {
      // already done today: show the finished position
      S.T.state = S.save.daily[today()] === 'failed' ? 'failed' : 'solved'; S.T.settled = true;
      var r = E.replay(p.fen, p.line);
      if (r) { S.T.pos = r.pos; S.T.step = p.line.length; S.T.left = 0; var lm = r.moves[r.moves.length - 1]; S.T.last = [E.mFrom(lm), E.mTo(lm)]; }
    }
    S.bv.clearSel();
    render();
  }
  function viewState() {
    var T = S.T, pos = T.pos, canAct = T.state === 'play' && pos.side === T.solver && !S.card;
    var legal = canAct ? pos.legalMoves() : [], byFrom = {};
    legal.forEach(function (m) { var f = E.mFrom(m); (byFrom[f] || (byFrom[f] = [])).push(E.mTo(m)); });
    var st = {
      b: pos.b, flip: T.solver === 1, style: S.style, coords: true, check: pos.inCheck() ? pos.kings[pos.side] : -1, last: T.last, epSq: pos.ep,
      movable: function (sq) { return !!byFrom[sq]; },
      targetsOf: function (sq) { return (byFrom[sq] || []).filter(function (t, i, a) { return a.indexOf(t) === i; }); },
      hint: null, arrows: [], good: T.good, wrong: T.wrong
    };
    if (T.hint && T.state === 'play' && pos.side === T.solver) {
      var hm = hintMove();
      if (hm) { st.hint = [E.mFrom(hm), T.hint > 1 ? E.mTo(hm) : E.mFrom(hm)]; if (T.hint > 1) st.arrows = [[E.mFrom(hm), E.mTo(hm)]]; }
    }
    return st;
  }
  function hintMove() {
    var T = S.T;
    if (T.hintM && T.hintM.step === T.step) return T.hintM.m;
    var m = 0;
    if (T.onLine && T.step < T.p.line.length) m = E.fromUCI(T.pos, T.p.line[T.step]);
    if (!m) { var a = E.bestAttack(T.pos, T.left, T.memo); m = a ? a.move : 0; }
    T.hintM = { step: T.step, m: m };
    return m;
  }
  function anims(m) {
    var a = [[E.mFrom(m), E.mTo(m)]];
    if (E.mFlags(m) & E.F_CASTLE) { var f = E.mFrom(m), t = E.mTo(m); a.push(t > f ? [f + 3, f + 1] : [f - 4, f - 1]); }
    return a;
  }
  function render(anim) {
    if (!S || !S.T) return;
    S.bv.render(viewState(), anim);
    renderInfo(); renderPad();
  }
  function sideWord(s) { return s ? 'Black' : 'White'; }
  function renderInfo() {
    var T = S.T, p = T.p, sv = S.save, mode = S.mode, h = '';
    S.tabs.querySelectorAll('[data-mode]').forEach(function (b) { var on = b.getAttribute('data-mode') === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    var tag = mode === 'daily' ? 'Daily · ' + today() : 'Puzzle #' + p.id;
    h += '<div class="cpz-meta"><span>' + esc(tag) + '</span><span class="cpz-n">mate in ' + p.n + '</span><span class="cpz-r">' + p.rating + '</span></div>';
    var msg, cls = '';
    if (T.state === 'play') {
      if (T.flash) { msg = T.flash; cls = T.flashCls || ''; }
      else msg = '<b>' + sideWord(T.solver) + ' to play</b> · mate in ' + T.left + (T.left !== p.n ? ' more' : '');
    } else if (T.state === 'wait') msg = 'Good. <span class="cpz-dim">The defence replies…</span>', cls = 'good';
    else if (T.solText) { msg = '<b>Solution:</b> ' + esc(T.solText); cls = T.state === 'solved' ? 'good' : ''; }
    else if (T.state === 'solved') { msg = '<b>Solved!</b> ' + (T.clean ? 'Clean.' : 'With help.') + (mode === 'daily' ? ' <span class="cpz-dim">New puzzle tomorrow.</span>' : ''); cls = 'good'; }
    else if (T.state === 'failed') { msg = mode === 'daily' && T.settled && !T.mistakes ? '<b>Done for today.</b> <span class="cpz-dim">See the solution or practise.</span>' : '<b>Missed it.</b> <span class="cpz-dim">Retry, or see the solution.</span>'; cls = 'bad'; }
    else if (T.state === 'show') msg = 'The solution…';
    else if (T.state === 'oops') { msg = '<b>Not that one.</b>'; cls = 'bad'; }
    h += '<div class="cpz-msg ' + cls + '">' + msg + '</div>';
    // mode line
    if (mode === 'rated') {
      var d = S.lastDelta;
      h += '<div class="cpz-line"><span>Rating <b>' + sv.rating + '</b>' + (d ? ' <em class="' + (d > 0 ? 'up' : 'dn') + '">' + (d > 0 ? '+' : '') + d + '</em>' : '') + '</span><span>Streak <b>' + sv.streak + '</b> · best ' + sv.bestStreak + '</span></div>';
    } else if (mode === 'daily') {
      h += '<div class="cpz-line"><span>Daily streak <b>' + sv.dailyStreak + '</b></span><span>best ' + sv.bestDaily + '</span></div>';
    } else {
      var cnt = [0, 0, 0, 0], tot = [0, 0, 0, 0];
      PZ.forEach(function (q) { tot[q.n]++; tot[0]++; if (sv.solved[q.id]) { cnt[q.n]++; cnt[0]++; } });
      h += '<div class="cpz-filter">' + [0, 1, 2, 3].map(function (n) {
        return '<button type="button" class="cpz-chip' + (sv.filter === n ? ' on' : '') + '" data-filter="' + n + '" aria-pressed="' + (sv.filter === n ? 'true' : 'false') + '">' + (n ? 'Mate in ' + n : 'All') + ' <i>' + cnt[n] + '/' + tot[n] + '</i></button>';
      }).join('') + '</div>';
    }
    S.info.innerHTML = h;
  }
  function renderPad() {
    var T = S.T, play = T.state === 'play' && T.pos.side === T.solver;
    var b = function (a) { return S.pad.querySelector('[data-act="' + a + '"]'); };
    b('hint').disabled = !play;
    b('hint').disabled = !play || T.hint >= 2;
    b('hint').querySelector('span').textContent = T.hint ? 'Move' : 'Hint';
    var busy = T.state === 'wait' || T.state === 'show' || T.state === 'oops';
    b('retry').disabled = busy || (T.state === 'play' && T.step === 0 && !T.mistakes);
    b('solution').disabled = busy;
    var nx = b('next');
    nx.disabled = S.mode === 'daily';
    nx.classList.toggle('go', T.state === 'solved' || T.state === 'failed');
    nx.querySelector('span').textContent = S.mode === 'rated' && !T.settled ? 'Skip' : 'Next';
  }

  // ---- playing ----
  function onBoardMove(from, to) {
    var T = S.T;
    if (T.state !== 'play' || T.pos.side !== T.solver) return;
    var legal = T.pos.legalMoves().filter(function (m) { return E.mFrom(m) === from && E.mTo(m) === to; });
    if (!legal.length) return;
    if (legal.length > 1) { askPromo(legal); return; }
    S.snd.ensure();
    tryMove(legal[0]);
  }
  function askPromo(legal) {
    S.promo = legal;
    var white = S.T.solver === 0, letter = S.style === 'letter';
    S.promoEl.innerHTML = '<div class="cpz-promo"><div class="cpz-promo-t">Promote to</div><div class="cpz-promo-row">' + [5, 4, 3, 2].map(function (t) {
      return '<button type="button" class="cpz-pp ' + (white ? 'w' : 'b') + (letter ? ' let' : ' gl') + '" data-pt="' + t + '" aria-label="' + BV.NAMES[t] + '"' + (letter ? '' : ' data-s="' + BV.SOLID[t] + BV.VS + '"') + '>' +
        (letter ? (white ? 'PNBRQK' : 'pnbrqk').charAt(t - 1) : BV.HOLLOW[t] + BV.VS) + '</button>';
    }).join('') + '</div><button type="button" class="cpz-lnk" data-pt="0">cancel</button></div>';
    S.promoEl.style.display = '';
  }
  function choosePromo(t) {
    var L = S.promo;
    S.promo = null; S.promoEl.style.display = 'none'; S.promoEl.innerHTML = '';
    if (!L || !t) { render(); return; }
    for (var i = 0; i < L.length; i++) if (E.mPromo(L[i]) === t) { tryMove(L[i]); return; }
  }
  function tryMove(m) {
    var T = S.T, uci = E.toUCI(m), r;
    // the first move is proven unique: compare; later moves go to the solver (duals are fine)
    if (T.step === 0) r = uci === T.p.line[0] ? (T.p.n === 1 ? 'mate' : 'ok') : 'wrong';
    else r = judge(E, T.pos, m, T.left, T.memo);
    T.flash = null; T.hintM = null;
    if (r === 'wrong') { wrongMove(m); return; }
    T.onLine = T.step === 0 || (T.onLine && uci === T.p.line[T.step]);
    var fl = E.mFlags(m);
    T.pos.make(m); T.played.push(uci);
    T.step++; T.left--; T.last = [E.mFrom(m), E.mTo(m)]; T.hint = 0; T.good = E.mTo(m); T.wrong = -1;
    sfx(fl & E.F_CAP ? 'cap' : 'move');
    if (r === 'mate') { solved(anims(m)); return; }
    sfx('good');
    if (Cade.haptic) Cade.haptic(6);
    T.state = 'wait';
    render(anims(m));
    S.replyT = setTimeout(defend, 520);
  }
  function defend() {
    var T = S && S.T;
    if (!T || T.state !== 'wait') return;
    var m = 0;
    if (T.onLine && T.step < T.p.line.length) m = E.fromUCI(T.pos, T.p.line[T.step]);
    if (!m) { var d = E.bestDefence(T.pos, T.left, T.memo); m = d ? d.move : 0; T.onLine = false; }
    if (!m) { solved(); return; }
    var fl = E.mFlags(m);
    T.pos.make(m); T.played.push(E.toUCI(m)); T.step++;
    T.last = [E.mFrom(m), E.mTo(m)]; T.good = -1;
    T.state = 'play';
    sfx(fl & E.F_CAP ? 'cap' : 'move');
    render(anims(m));
  }
  function wrongMove(m) {
    var T = S.T;
    T.mistakes++;
    sfx('bad');
    if (Cade.haptic) Cade.haptic(25);
    // show the move, then take it back
    T.pos.make(m);
    T.wrong = E.mTo(m); T.good = -1;
    var prevLast = T.last;
    T.last = [E.mFrom(m), E.mTo(m)];
    T.state = 'oops';
    render(anims(m));
    S.undoT = setTimeout(function () {
      if (!S || S.T !== T) return;
      T.pos.unmake(); T.last = prevLast; T.wrong = -1;
      if (S.mode === 'rated' || S.mode === 'daily') {
        T.state = 'failed'; T.clean = false;
        finishFail();
      } else {
        T.state = 'play'; T.clean = false;
        T.flash = '<b>Not that one.</b> <span class="cpz-dim">Try again.</span>'; T.flashCls = 'bad';
        if (!T.settled) { T.settled = true; settle(S.save, T.p, 'practice', false, false); persist(); }
        render();
      }
    }, 750);
  }
  function finishFail() {
    var T = S.T;
    if (!T.settled) {
      T.settled = true;
      var res = settle(S.save, T.p, S.mode, false, false, today());
      S.lastDelta = res.delta;
      persist();
    }
    render();
  }
  function solved(anim) {
    var T = S.T;
    T.state = 'solved'; T.good = -1;
    var res = { delta: 0 };
    if (!T.settled || S.mode === 'practice') {
      var first = !T.settled;
      T.settled = true;
      if (first || S.mode === 'practice') res = settle(S.save, T.p, first ? S.mode : 'practice', true, T.clean, today());
      persist();
    }
    S.lastDelta = S.mode === 'rated' ? res.delta : 0;
    setTimeout(function () { if (S && S.T === T) sfx('win'); }, 120);
    burst();
    render(anim);
    if (S.liveEl) S.liveEl.textContent = 'Solved' + (S.mode === 'rated' ? ', rating ' + S.save.rating : '');
    if (S.mode === 'rated' && res.newBest && S.save.bestStreak > 2) toast('New best streak: ' + S.save.bestStreak, 'success');
  }
  function hint() {
    var T = S.T;
    if (T.state !== 'play' || T.pos.side !== T.solver) return;
    if (T.hint >= 2) return;
    T.hint++; T.clean = false; T.flash = null;
    if (S.mode === 'rated' && !T.settled) { T.settled = true; var res = settle(S.save, T.p, 'rated', false, false); S.lastDelta = res.delta; persist(); toast('A hint ends the streak — this one counts as missed', 'info', 2200); }
    sfx('hint');
    render();
  }
  function retry() {
    var T = S.T;
    if (!T || T.state === 'wait' || T.state === 'show' || T.state === 'oops') return;
    var settled = T.settled, mistakes = T.mistakes;
    loadPuzzle(T.p, S.mode, true);
    S.T.settled = settled || S.mode === 'daily' && !!S.save.daily[today()]; S.T.clean = false; S.T.mistakes = mistakes;
    sfx('click');
    render();
  }
  function showSolution() {
    var T = S.T;
    if (!T || T.state === 'wait' || T.state === 'show' || T.state === 'oops') return;
    if (!T.settled) { T.settled = true; var res = settle(S.save, T.p, S.mode, false, false, today()); S.lastDelta = res.delta; persist(); }
    T.clean = false;
    var was = T.state, pos = E.fromFEN(T.p.fen), line = T.p.line, i = 0;
    T.pos = pos; T.step = 0; T.state = 'show'; T.last = null; T.good = -1; T.wrong = -1; T.hint = 0;
    render();
    function stepIt() {
      if (!S || S.T !== T) return;
      if (i >= line.length) { T.state = was === 'solved' ? 'solved' : 'failed'; T.left = 0; T.step = line.length; T.solText = solutionSan(); render(); return; }
      var m = E.fromUCI(pos, line[i]);
      pos.make(m); T.last = [E.mFrom(m), E.mTo(m)]; i++;
      sfx(E.mFlags(m) & E.F_CAP ? 'cap' : 'move');
      render(anims(m));
      S.showT = setTimeout(stepIt, 800);
    }
    S.showT = setTimeout(stepIt, 350);
  }
  function solutionSan() {
    var T = S.T, pos = E.fromFEN(T.p.fen), out = [], num = pos.full, first = true;
    T.p.line.forEach(function (u) {
      var m = E.fromUCI(pos, u);
      if (pos.side === 0) out.push(num + '.'); else if (first) out.push(num + '…');
      out.push(E.toSAN(pos, m));
      if (pos.side === 1) num++;
      pos.make(m); first = false;
    });
    return out.join(' ');
  }
  function next() {
    S.lastDelta = 0;
    if (S.mode === 'rated') {
      var T = S.T;
      if (T && !T.settled && T.state !== 'solved') { T.settled = true; var res = settle(S.save, T.p, 'rated', false, false); S.lastDelta = res.delta; persist(); }
      loadPuzzle(pickRated(PZ, S.save.rating, S.save.recent.concat(T ? [T.p.id] : [])), 'rated');
    } else if (S.mode === 'practice') {
      loadPuzzle(nextPractice(PZ, S.save.filter, S.save.solved, S.T ? S.T.p.id : 0), 'practice');
    }
    sfx('click');
  }
  function setMode(mode) {
    S.mode = mode; S.save.mode = mode; S.lastDelta = 0; persist();
    clearTimeout(S.replyT); clearTimeout(S.showT); clearTimeout(S.undoT);
    if (mode === 'daily') loadPuzzle(PZ[dailyIndex(today(), EPOCH, PZ.length)], 'daily');
    else if (mode === 'rated') {
      var cur = S.save.cur && PZ[S.save.cur - 1];
      loadPuzzle(cur && S.save.recent.indexOf(cur.id) < 0 ? cur : pickRated(PZ, S.save.rating, S.save.recent), 'rated');
    } else {
      loadPuzzle(resumePractice(PZ, S.save.filter, S.save.solved, S.save.practiceId), 'practice');
    }
  }

  // ---- cards ----
  function cardWrap(title, inner) { return '<div class="cpz-card"><div class="cpz-title">' + title + '</div>' + inner + '</div>'; }
  function helpHtml() {
    return cardWrap('CHESS PUZZLES', '<pre class="cpz-art" aria-hidden="true">  +---+\n  | # |  mate in\n  +---+  1 · 2 · 3</pre>' +
      '<p>Find the forced checkmate. Every puzzle has <b>exactly one</b> first move that works; the computer then plays the <b>most stubborn defence</b>. After the first move, any move that still mates in time is accepted.</p>' +
      '<div class="cpz-keys"><div><b>Daily</b> &nbsp;one puzzle a day &mdash; keep the streak</div><div><b>Rated</b> &nbsp;your puzzle rating rises and falls; solves in a row make your streak</div><div><b>Practice</b> &nbsp;mate in 1, 2 or 3 &mdash; retry as much as you like</div></div>' +
      '<p class="cpz-tip"><b>Hint</b> shows the piece to move, then the move. In Rated a hint, a wrong move or the solution counts as a miss.</p>' +
      (S.coarse ? '' : '<p class="cpz-tip">Keys: <b>arrows</b> + <b>Enter</b> move a piece · <b>H</b> hint · <b>R</b> retry · <b>S</b> solution · <b>N</b> / <b>Enter</b> next · <b>Esc</b> close.</p>') +
      '<div class="cpz-btns"><button type="button" class="cpz-go" data-act="close">Got it</button></div>');
  }
  function statsHtml() {
    var sv = S.save, solved = [0, 0, 0, 0], clean = 0, tot = [0, 0, 0, 0];
    PZ.forEach(function (q) { tot[q.n]++; if (sv.solved[q.id]) solved[q.n]++; if (sv.solved[q.id] === 1) clean++; });
    var days = Object.keys(sv.daily).filter(function (d) { return sv.daily[d] !== 'failed'; }).length;
    function line(a, b) { return esc(a) + new Array(Math.max(1, 26 - a.length - String(b).length) + 1).join(' ') + '<b>' + esc(String(b)) + '</b>'; }
    var rows = [line('Puzzle rating', sv.rating), line('Peak rating', sv.peak), line('Rated puzzles', sv.played), line('Best streak', sv.bestStreak),
      '<i>' + new Array(27).join('-') + '</i>', line('Mate in 1 solved', solved[1] + '/' + tot[1]), line('Mate in 2 solved', solved[2] + '/' + tot[2]), line('Mate in 3 solved', solved[3] + '/' + tot[3]),
      line('Solved clean', clean), '<i>' + new Array(27).join('-') + '</i>', line('Daily puzzles solved', days), line('Daily streak', sv.dailyStreak), line('Best daily streak', sv.bestDaily)];
    return cardWrap('STATS', '<pre class="cpz-tab">' + rows.join('\n') + '</pre>' +
      '<div class="cpz-foot">' + (S.resetArm ? '<span class="cpz-confirm">Erase rating and progress?</span><span><button type="button" class="cpz-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="cpz-lnk" data-act="reset-no">Keep</button></span>'
        : '<button type="button" class="cpz-lnk" data-act="reset">Reset progress</button><span>Pieces: <button type="button" class="cpz-lnk' + (S.style === 'glyph' ? ' on' : '') + '" data-style="glyph">glyphs</button> <button type="button" class="cpz-lnk' + (S.style === 'letter' ? ' on' : '') + '" data-style="letter">letters</button></span>') + '</div>' +
      '<div class="cpz-btns"><button type="button" class="cpz-go" data-act="close">Back</button></div>');
  }
  function showCard(kind) {
    S.card = kind;
    S.ovl.innerHTML = kind === 'help' ? helpHtml() : kind === 'stats' ? statsHtml() : '';
    S.ovl.style.display = kind ? '' : 'none';
    S.root.classList.toggle('dim', !!kind);
    if (S.T) render();
  }
  function burst() {
    if (!S || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    var host = S.stage, wrap = document.createElement('div'), ch = '#+*.#x+', h = '';
    wrap.className = 'cpz-burst';
    for (var i = 0; i < 24; i++) {
      var a = Math.random() * Math.PI * 2, d = host.offsetWidth * (0.2 + Math.random() * 0.3);
      h += '<i style="--dx:' + (Math.cos(a) * d).toFixed(1) + 'px;--dy:' + (Math.sin(a) * d).toFixed(1) + 'px;animation-delay:' + (Math.random() * 0.15).toFixed(2) + 's" class="c' + (i % 4) + '">' + ch.charAt(i % ch.length) + '</i>';
    }
    wrap.innerHTML = h;
    host.appendChild(wrap);
    setTimeout(function () { wrap.remove(); }, 1500);
  }

  // ---- keys ----
  function onKey(e) {
    if (!S || !S.T) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (t && t.isContentEditable && !S.panel.contains(t)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    if (k === 'Escape') { e.preventDefault(); if (S.promo) choosePromo(0); else if (S.card) showCard(null); else closePanel(); return; }
    if (S.promo) { var pm = { q: 5, r: 4, b: 3, n: 2 }[k.toLowerCase()]; if (pm) { e.preventDefault(); choosePromo(pm); } return; }
    if (S.card) return;
    // the board's keyboard cursor: arrows move it, Enter / Space picks up and puts down
    if (/^Arrow/.test(k) || ((k === 'Enter' || k === ' ') && S.T.state === 'play' && !(t && t.tagName === 'BUTTON' && S.panel.contains(t)))) {
      if (S.bv.key(k === ' ' ? 'Space' : k)) { e.preventDefault(); return; }
    }
    var lk = k.toLowerCase(), done = true;
    if (lk === 'h' || k === '?') hint();
    else if (lk === 'r') retry();
    else if (lk === 's') showSolution();
    else if (lk === 'n' || ((k === 'Enter' || k === ' ') && (S.T.state === 'solved' || S.T.state === 'failed') && !(t && t.tagName === 'BUTTON' && S.panel.contains(t)))) { if (S.mode !== 'daily') next(); }
    else if (k === '1' || k === '2' || k === '3') setMode(['daily', 'rated', 'practice'][+k - 1]);
    else done = false;
    if (done) e.preventDefault();
  }

  // ---- layout ----
  function layout() {
    if (!S) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 640, solo = S.panel.classList.contains('cade-solo-panel');
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    S.root.classList.toggle('phone', phone);
    var r = S.panel.getBoundingClientRect(), top = Math.min(Math.max(0, r.top || 50), 120), sz;
    if (phone) sz = Math.min(vw - 34, vh - top - (40 + 44 + 120 + 58 + 40));
    else sz = Math.min(solo ? 600 : 480, vh - top - (40 + 40 + 30), vw - 300);
    sz = Math.max(232, Math.floor(sz / 8) * 8);
    S.root.style.setProperty('--chb-sz', sz + 'px');
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    clearTimeout(s.replyT); clearTimeout(s.showT); clearTimeout(s.undoT); clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }
  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var p = Cade.mkPanel(PANEL_ID, '♟️ Chess Puzzles', '<div class="cpz cpz-loading">Setting up the puzzles…</div>');
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    ensureLibs().then(function () { if (p.isConnected) build(p); }, function () {
      var b = p.querySelector('.cpz');
      if (b) b.textContent = 'Couldn\'t load the puzzles. Check your connection and try again.';
    });
  }
  function build(p) {
    var root = p.querySelector('.cpz');
    root.className = 'cpz';
    root.innerHTML = '<div class="cpz-main"><div class="cpz-stage"><div class="cpz-promo-wrap" style="display:none"></div></div></div>' +
      '<div class="cpz-side"><div class="cpz-tabs" role="group" aria-label="Mode"><button type="button" data-mode="daily">Daily</button><button type="button" data-mode="rated">Rated</button><button type="button" data-mode="practice">Practice</button></div>' +
      '<div class="cpz-info" aria-live="polite"></div></div>' +
      '<div class="cpz-pad"><button type="button" data-act="hint" title="Hint (H)">' + IC_HINT + '<span>Hint</span></button>' +
      '<button type="button" data-act="retry" title="Retry (R)">' + IC_RETRY + '<span>Retry</span></button>' +
      '<button type="button" data-act="solution" title="Show the solution (S)">' + IC_EYE + '<span>Solution</span></button>' +
      '<button type="button" data-act="next" title="Next puzzle (N)">' + IC_NEXT + '<span>Next</span></button></div>' +
      '<div class="cpz-live" aria-live="polite"></div><div class="cpz-ovl" style="display:none"></div>';
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'cpz-hb';
    hb.innerHTML = '<button type="button" data-h="stats" title="Stats" aria-label="Stats">' + IC_STATS + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button><button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    S = {
      panel: p, root: root, head: hb, stage: root.querySelector('.cpz-stage'), promoEl: root.querySelector('.cpz-promo-wrap'), tabs: root.querySelector('.cpz-tabs'),
      info: root.querySelector('.cpz-info'), pad: root.querySelector('.cpz-pad'), ovl: root.querySelector('.cpz-ovl'), liveEl: root.querySelector('.cpz-live'),
      save: normSave(o, PZ.length), snd: new Snd(sget(SOUND_KEY) === '1'), style: sget(STYLE_KEY) === 'letter' ? 'letter' : 'glyph',
      coarse: false, card: null, promo: null, T: null, mode: 'daily', lastDelta: 0, resetArm: false
    };
    S.mode = S.save.mode;
    S.bv = BV.create(S.stage, { onMove: onBoardMove, onPress: function () { if (S) S.snd.ensure(); } });
    S.stage.insertBefore(S.bv.el, S.promoEl);
    p._onClose = teardown;
    layout();
    syncHead();

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); render(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () { if (S && S.panel === p) { if (S.themeDirty) { S.themeDirty = false; S.bv.applyTheme(); } layout(); render(); } });
    });
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        S.bv.applyTheme();
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') { S.snd.on = !S.snd.on; sset(SOUND_KEY, S.snd.on ? '1' : '0'); S.snd.ensure(); sfx('click'); syncHead(); }
      else if (h === 'help') showCard(S.card === 'help' ? null : 'help');
      else if (h === 'stats') { S.resetArm = false; showCard(S.card === 'stats' ? null : 'stats'); }
      try { b.blur(); } catch (er) {}
    });
    S.tabs.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-mode]') : null;
      if (b && S) { S.snd.ensure(); setMode(b.getAttribute('data-mode')); }
    });
    S.info.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-filter]') : null;
      if (!b || !S) return;
      S.save.filter = +b.getAttribute('data-filter'); persist();
      var cur = S.T && S.T.p;
      if (!cur || (S.save.filter && cur.n !== S.save.filter) || S.T.state === 'solved') loadPuzzle(nextPractice(PZ, S.save.filter, S.save.solved, cur ? cur.id : 0), 'practice');
      else render();
    });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S || b.disabled) return;
      S.snd.ensure();
      if (S.card) showCard(null);
      var a = b.getAttribute('data-act');
      if (a === 'hint') hint(); else if (a === 'retry') retry(); else if (a === 'solution') showSolution(); else if (a === 'next') next();
    });
    S.promoEl.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-pt]') : null;
      if (b && S) choosePromo(+b.getAttribute('data-pt'));
    });
    S.ovl.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var a = b.getAttribute('data-act');
      if (b.hasAttribute('data-style')) { S.style = b.getAttribute('data-style'); sset(STYLE_KEY, S.style); showCard('stats'); }
      else if (a === 'close') showCard(null);
      else if (a === 'reset') { S.resetArm = true; showCard('stats'); }
      else if (a === 'reset-no') { S.resetArm = false; showCard('stats'); }
      else if (a === 'reset-yes') { S.save = newSave(); S.resetArm = false; persist(); toast('Progress reset'); showCard(null); setMode('daily'); }
    });
    setMode(S.mode);
    if (!raw) showCard('help');
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); render(); } });
  }
  function syncHead() {
    var sb = S.head.querySelector('[data-h="sound"]');
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Mate-in-one, two and three puzzles — streaks, hints, a daily puzzle',
    icon: '♟️',
    tags: 'game,puzzle,chess,tactics,mate,daily,rated,streak',
    open: open,
    _helpers: HELPERS
  });
})();
