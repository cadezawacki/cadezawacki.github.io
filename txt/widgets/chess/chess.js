/* Chess — for Cade.txt. Full rules (castling, en passant, promotion with a
 * choice, check / mate / stalemate, threefold, 50 moves, dead positions), a SAN
 * move list you can step back through, undo, flip, hints, clocks with
 * increment, PGN copy / insert, and a saved game that resumes where you left it.
 * Play the computer (six levels, from a loose Novice to a 3-second Master) or a
 * friend on the same device (pass and play, the board can turn each move).
 * The engine (chess-engine.js) is shared with Chess Puzzles: it runs in a Web
 * Worker so the board never freezes while the computer thinks (it falls back to
 * short searches on the page if Workers are unavailable). The board view
 * (chess-board.js / .css) is shared too: tap-tap or drag, legal-move dots.
 * Keys: type a move (e4, Nf3, O-O, e7e8q) + Enter · U undo · ? hint · V flip ·
 * M new game · ← → step through moves · P pause (clocks) · Esc close.
 * Saves in Cade.store (cade-chess-*). Offline; no network. */
(function () {
  'use strict';

  // ================= pure helpers (no DOM — unit-checked in node) =================
  var TIME_CONTROLS = [
    { id: 'none', label: 'No clock', base: 0, inc: 0 },
    { id: '1+0', label: '1+0', base: 60, inc: 0 },
    { id: '3+2', label: '3+2', base: 180, inc: 2 },
    { id: '5+0', label: '5+0', base: 300, inc: 0 },
    { id: '10+5', label: '10+5', base: 600, inc: 5 },
    { id: '15+10', label: '15+10', base: 900, inc: 10 },
    { id: '30+0', label: '30+0', base: 1800, inc: 0 }
  ];
  function tcById(id) { for (var i = 0; i < TIME_CONTROLS.length; i++) if (TIME_CONTROLS[i].id === id) return TIME_CONTROLS[i]; return TIME_CONTROLS[0]; }

  function newGame(o) {
    o = o || {};
    var tc = tcById(o.tc);
    return {
      v: 1, mode: o.mode === '2p' ? '2p' : 'cpu', level: clampInt(o.level, 1, 6, 3), human: o.human === 1 ? 1 : 0, autoFlip: o.autoFlip !== false,
      tc: tc.id, clocks: [tc.base * 1000, tc.base * 1000], clockHist: [], startFen: o.startFen || '', moves: [], result: null,
      hints: 0, undos: 0, counted: false, started: o.now || 0, id: o.id || 0
    };
  }
  function clampInt(v, a, b, d) { v = parseInt(v, 10); return isNaN(v) ? d : Math.max(a, Math.min(b, v)); }
  // Defensive load of a saved game (another version may have written it). E = the engine.
  function normGame(o, E) {
    if (!o || typeof o !== 'object') return null;
    var g = newGame({ mode: o.mode, level: o.level, human: o.human, autoFlip: o.autoFlip, tc: o.tc, startFen: '', id: +o.id || 0, now: +o.started || 0 });
    if (typeof o.startFen === 'string' && o.startFen) { try { E.fromFEN(o.startFen); g.startFen = o.startFen; } catch (e) { return null; } }
    var moves = Array.isArray(o.moves) ? o.moves.filter(function (m) { return typeof m === 'string' && /^[a-h][1-8][a-h][1-8][nbrq]?$/.test(m); }) : [];
    // keep the legal prefix
    var lo = 0, hi = moves.length;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (E.replay(g.startFen || E.START_FEN, moves.slice(0, mid))) lo = mid; else hi = mid - 1; }
    g.moves = moves.slice(0, lo);
    if (Array.isArray(o.clocks) && o.clocks.length === 2) g.clocks = [Math.max(0, +o.clocks[0] || 0), Math.max(0, +o.clocks[1] || 0)];
    if (Array.isArray(o.clockHist)) g.clockHist = o.clockHist.filter(function (c) { return Array.isArray(c) && c.length === 2; }).slice(0, g.moves.length + 1)
      .map(function (c) { return [Math.max(0, +c[0] || 0), Math.max(0, +c[1] || 0)]; });
    if (o.result && typeof o.result === 'object' && /^(1-0|0-1|1\/2-1\/2)$/.test(o.result.result)) g.result = { result: o.result.result, reason: String(o.result.reason || '').slice(0, 40) };
    g.hints = clampInt(o.hints, 0, 9999, 0); g.undos = clampInt(o.undos, 0, 9999, 0);
    g.counted = !!(o.counted || g.result);
    return g;
  }
  function newStats() {
    var s = { levels: {}, p2: { w: 0, b: 0, d: 0 }, recent: [] };
    for (var i = 1; i <= 6; i++) s.levels[i] = { w: 0, d: 0, l: 0 };
    return s;
  }
  function normStats(o) {
    var s = newStats();
    if (!o || typeof o !== 'object') return s;
    for (var i = 1; i <= 6; i++) {
      var L = o.levels && o.levels[i];
      if (L) { s.levels[i].w = clampInt(L.w, 0, 1e6, 0); s.levels[i].d = clampInt(L.d, 0, 1e6, 0); s.levels[i].l = clampInt(L.l, 0, 1e6, 0); }
    }
    if (o.p2) { s.p2.w = clampInt(o.p2.w, 0, 1e6, 0); s.p2.b = clampInt(o.p2.b, 0, 1e6, 0); s.p2.d = clampInt(o.p2.d, 0, 1e6, 0); }
    if (Array.isArray(o.recent)) s.recent = o.recent.filter(function (r) { return r && typeof r === 'object' && typeof r.r === 'string'; }).slice(0, 20)
      .map(function (r) { return { r: String(r.r).slice(0, 8), mode: r.mode === '2p' ? '2p' : 'cpu', lv: clampInt(r.lv, 1, 6, 3), out: /^[wdl]$/.test(r.out) ? r.out : 'd', why: String(r.why || '').slice(0, 40), n: clampInt(r.n, 0, 9999, 0), t: +r.t || 0 }; });
    return s;
  }
  function normPrefs(o) {
    var p = { style: 'glyph', coords: true, lastMode: 'cpu', lastLevel: 3, lastColor: 'w', lastTc: 'none', autoFlip: true };
    if (!o || typeof o !== 'object') return p;
    if (o.style === 'letter') p.style = 'letter';
    if (o.coords === false) p.coords = false;
    if (o.lastMode === '2p') p.lastMode = '2p';
    p.lastLevel = clampInt(o.lastLevel, 1, 6, 3);
    if (o.lastColor === 'b' || o.lastColor === 'r') p.lastColor = o.lastColor;
    p.lastTc = tcById(o.lastTc).id;
    if (o.autoFlip === false) p.autoFlip = false;
    return p;
  }
  // The outcome for the player in front of the screen (vs CPU), or for White (2p): 'w' | 'd' | 'l'.
  function outcomeFor(game, result) {
    if (result === '1/2-1/2') return 'd';
    var whiteWon = result === '1-0';
    if (game.mode === '2p') return whiteWon ? 'w' : 'l';
    return (whiteWon ? 0 : 1) === game.human ? 'w' : 'l';
  }
  function recordResult(stats, game, res, now) {
    var out = outcomeFor(game, res.result);
    if (game.mode === 'cpu') stats.levels[game.level][out]++;
    else if (res.result === '1-0') stats.p2.w++; else if (res.result === '0-1') stats.p2.b++; else stats.p2.d++;
    stats.recent.unshift({ r: res.result, mode: game.mode, lv: game.level, out: out, why: res.reason, n: game.moves.length, t: now || 0 });
    if (stats.recent.length > 20) stats.recent.length = 20;
    return out;
  }
  // What a flag fall means: the other side wins unless it has nothing to mate with.
  function flagResult(pos, flagged, E) {
    var b = pos.b, other = flagged ^ 1, minors = 0, heavy = false;
    for (var s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      var pc = b[s];
      if (!pc || (pc >> 3) !== other) continue;
      var t = pc & 7;
      if (t === E.P || t === E.R || t === E.Q) heavy = true;
      else if (t === E.N || t === E.B) minors++;
    }
    if (!heavy && minors === 0) return { result: '1/2-1/2', reason: 'timeout vs insufficient material' };
    return { result: other === 0 ? '1-0' : '0-1', reason: 'time' };
  }
  // How long the computer may think with a clock: a slice of what's left plus most of the increment.
  function cpuTimeCap(clockMs, incMs) {
    if (!clockMs) return 0;
    return Math.max(60, Math.min(clockMs * 0.5, clockMs / 28 + incMs * 0.75));
  }
  // The computer takes a draw when it's worse, or when it's level deep into the game.
  function acceptsDraw(cpuEval, plies) { return cpuEval <= -80 || (plies >= 60 && Math.abs(cpuEval) <= 25); }
  function fmtClock(ms) {
    ms = Math.max(0, ms);
    if (ms < 10000) return (Math.floor(ms / 100) / 10).toFixed(1);
    var s = Math.ceil(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    s %= 60;
    if (h) return h + ':' + (m % 60 < 10 ? '0' : '') + (m % 60) + ':' + (s < 10 ? '0' : '') + s;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  var HELPERS = {
    TIME_CONTROLS: TIME_CONTROLS, tcById: tcById, newGame: newGame, normGame: normGame, newStats: newStats, normStats: normStats,
    normPrefs: normPrefs, outcomeFor: outcomeFor, recordResult: recordResult, flagResult: flagResult, cpuTimeCap: cpuTimeCap,
    acceptsDraw: acceptsDraw, fmtClock: fmtClock
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = HELPERS;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('chess-board.css');
  Cade.loadCSS('chess.css');
  var ENGINE_URL = Cade.asset('chess-engine.js'), BOARD_URL = Cade.asset('chess-board.js');

  var PANEL_ID = 'chess-panel', NAME = 'Chess';
  var KEY = 'cade-chess-', GAME_KEY = KEY + 'game', STATS_KEY = KEY + 'stats', PREFS_KEY = KEY + 'prefs', SOUND_KEY = KEY + 'sound';
  var E = null, BV = null, loading = null;
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.chess = { live: function () { return S; } };

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
    if (E && BV) return Promise.resolve();
    if (!loading) {
      loading = Promise.all([
        loadScript(ENGINE_URL, function () { return !!window.__cadeChessEngine; }),
        loadScript(BOARD_URL, function () { return !!window.__cadeChessBoard; })
      ]).then(function () { E = window.__cadeChessEngine; BV = window.__cadeChessBoard; }, function (e) { loading = null; throw e; });
    }
    return loading;
  }

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sjson(k) { var r = sget(k); if (!r) return null; try { return JSON.parse(r); } catch (e) { return null; } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function toast(msg, type, ms) { if (Cade.showToast) Cade.showToast(msg, type || 'info', ms || 1800); }

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
    if (kind === 'move') { s.tone(520, 0.05, 'triangle', 0.05, 380); }
    else if (kind === 'cap') { s.tone(300, 0.08, 'square', 0.035, 160); s.tone(900, 0.03, 'triangle', 0.02); }
    else if (kind === 'check') { s.tone(740, 0.07, 'triangle', 0.05); s.tone(988, 0.1, 'triangle', 0.045, 0, 0.07); }
    else if (kind === 'castle') { s.tone(440, 0.05, 'triangle', 0.045, 330); s.tone(560, 0.05, 'triangle', 0.04, 420, 0.07); }
    else if (kind === 'promo') { [660, 880, 1175].forEach(function (f, i) { s.tone(f, 0.08, 'triangle', 0.04, 0, i * 0.05); }); }
    else if (kind === 'bad') { s.tone(170, 0.12, 'sawtooth', 0.03, 120); }
    else if (kind === 'win') { [523, 659, 784, 1047, 1319].forEach(function (f, i) { s.tone(f, 0.14, 'triangle', 0.04, 0, i * 0.09); }); }
    else if (kind === 'lose') { [494, 440, 392, 330].forEach(function (f, i) { s.tone(f, 0.18, 'sine', 0.04, 0, i * 0.12); }); }
    else if (kind === 'draw') { [523, 523, 494].forEach(function (f, i) { s.tone(f, 0.12, 'sine', 0.035, 0, i * 0.11); }); }
    else if (kind === 'tick') { s.tone(1400, 0.025, 'square', 0.02); }
    else if (kind === 'hint') { s.tone(1046, 0.06, 'sine', 0.035); s.tone(1568, 0.1, 'sine', 0.03, 0, 0.06); }
    else if (kind === 'click') { s.tone(880, 0.04, 'sine', 0.03); }
  }

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_MENU = svg('<path d="M4 7h16M4 12h16M4 17h16"/>');
  var IC_UNDO = svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>');
  var IC_HINT = svg('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>');
  var IC_FLIP = svg('<path d="M7 4v16M7 4 3 8M7 4l4 4M17 20V4M17 20l-4-4M17 20l4-4"/>');
  var IC_FLAG = svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>');
  var IC_COPY = svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>');
  var IC_FIRST = svg('<path d="M6 5v14M18 6l-7 6 7 6"/>'), IC_PREV = svg('<path d="m15 6-6 6 6 6"/>'), IC_NEXT = svg('<path d="m9 6 6 6-6 6"/>'), IC_LAST = svg('<path d="M18 5v14M6 6l7 6-7 6"/>');

  // ---- the game on screen ----
  function startFen() { return S.game.startFen || E.START_FEN; }
  function rebuild() {
    var r = E.replay(startFen(), S.game.moves);
    if (!r) { S.game.moves = []; r = E.replay(startFen(), []); }
    S.pos = r.pos; S.sans = r.sans; S.mvs = r.moves;
    S.basePos = E.fromFEN(startFen());
  }
  function persist() { if (S && S.game) sset(GAME_KEY, JSON.stringify(S.game)); }
  function persistStats() { if (S) sset(STATS_KEY, JSON.stringify(S.stats)); }
  function persistPrefs() { if (S) sset(PREFS_KEY, JSON.stringify(S.prefs)); }
  function live() { return S.view == null || S.view >= S.game.moves.length; }
  function sideName(side) {
    var g = S.game;
    if (g.mode === '2p') return side ? 'Black' : 'White';
    return side === g.human ? 'You' : 'Computer · ' + E.LEVELS[g.level - 1].name;
  }
  function humanTurn() {
    var g = S.game;
    if (!g || g.result || S.paused) return false;
    return g.mode === '2p' || S.pos.side === g.human;
  }
  // Who sits at the bottom: you vs the computer; in 2 players (auto-turn) the side to move,
  // after a short beat so the move is seen first.
  function boardFlip() {
    var g = S.game, f;
    if (g.mode === '2p') {
      if (S.holdFlip) return S.lastFlip;
      f = g.autoFlip ? S.pos.side === 1 : false;
    } else f = g.human === 1;
    return S.flipManual ? !f : f;
  }

  // Board state for the view, at the live position or the reviewed ply.
  function viewState() {
    var g = S.game, pos = S.pos, lastM = S.mvs[S.mvs.length - 1], reviewing = !live();
    if (reviewing) {
      var r = E.replay(startFen(), g.moves.slice(0, S.view));
      pos = r.pos; lastM = r.moves[r.moves.length - 1];
    }
    var chk = pos.inCheck() ? pos.kings[pos.side] : -1;
    var canAct = !reviewing && humanTurn() && !S.promo && !S.card;
    var legal = canAct ? pos.legalMoves() : [];
    var byFrom = {};
    legal.forEach(function (m) { var f = E.mFrom(m); (byFrom[f] || (byFrom[f] = [])).push(E.mTo(m)); });
    var flip = boardFlip();
    S.lastFlip = flip;
    var st = {
      b: pos.b, flip: flip, style: S.prefs.style, coords: S.prefs.coords, check: chk,
      last: lastM ? [E.mFrom(lastM), E.mTo(lastM)] : null, epSq: pos.ep,
      movable: function (sq) { return !!byFrom[sq]; },
      targetsOf: function (sq) { return (byFrom[sq] || []).filter(function (t, i, a) { return a.indexOf(t) === i; }); },
      hint: null, arrows: []
    };
    if (S.hint && S.hint.ply === g.moves.length && !reviewing) { st.hint = [S.hint.from, S.hint.to]; st.arrows = [[S.hint.from, S.hint.to]]; }
    return st;
  }
  function renderBoard(anim) { if (S && S.bv) S.bv.render(viewState(), anim); }

  function pieceGlyph(t, white) {
    if (S.prefs.style === 'letter') return white ? ' PNBRQK'.charAt(t) : ' pnbrqk'.charAt(t);
    return BV.SOLID[t] + BV.VS;
  }
  function renderBars() {
    var g = S.game, flip = S.lastFlip, top = flip ? 0 : 1, bot = top ^ 1, mat = E.material(S.pos, S.basePos);
    [[S.barTop, top], [S.barBot, bot]].forEach(function (pair) {
      var el = pair[0], side = pair[1], cap = mat.captured[side ^ 1], adv = side === 0 ? mat.diff : -mat.diff;
      var thinking = S.thinking && g.mode === 'cpu' && side !== g.human && !g.result;
      var toMove = !g.result && S.pos.side === side;
      var html = '<span class="chs-who ' + (side ? 'b' : 'w') + (toMove ? ' on' : '') + '"><i class="chs-dot"></i>' + esc(sideName(side)) +
        (thinking ? '<em class="chs-think">thinking<b>.</b><b>.</b><b>.</b></em>' : '') + '</span>' +
        '<span class="chs-caps' + (S.prefs.style === 'letter' ? ' let' : '') + '">' + cap.map(function (t) { return '<i>' + pieceGlyph(t, side === 1) + '</i>'; }).join('') +
        (adv > 0 ? '<b>+' + adv + '</b>' : '') + '</span>';
      if (g.tc !== 'none') {
        var ms = clockNow(side), low = ms < 20000;
        html += '<span class="chs-clock' + (toMove && clockRunning() ? ' run' : '') + (low ? ' low' : '') + '" data-side="' + side + '">' + fmtClock(ms) + '</span>';
      }
      el.innerHTML = html;
    });
  }
  function renderMoves() {
    var sans = S.sans, h = '', start = E.fromFEN(startFen()), num = start.full, side = start.side, cur = S.view == null ? sans.length : S.view;
    for (var i = 0; i < sans.length; i++) {
      if (side === 0 || i === 0) h += '<span class="chs-num">' + num + '.</span>' + (side === 1 ? '<span class="chs-ph">…</span>' : '');
      h += '<button type="button" class="chs-mv' + (i === cur - 1 ? ' on' : '') + '" data-ply="' + (i + 1) + '">' + esc(sans[i]) + '</button>';
      if (side === 1) num++;
      side ^= 1;
    }
    if (S.game.result) h += '<span class="chs-res">' + esc(S.game.result.result) + '</span>';
    if (!sans.length) h = '<span class="chs-empty">' + (S.game.result ? '' : 'Moves appear here') + '</span>';
    S.movesEl.innerHTML = h;
    var on = S.movesEl.querySelector('.chs-mv.on');
    if (on) {
      var box = S.movesEl;
      if (S.phone) box.scrollLeft = Math.max(0, on.offsetLeft - box.clientWidth + on.offsetWidth + 24);
      else box.scrollTop = Math.max(0, on.offsetTop - box.clientHeight + on.offsetHeight + 8);
    } else if (cur === 0) { S.movesEl.scrollTop = 0; S.movesEl.scrollLeft = 0; }
    var n = sans.length;
    S.nav.querySelector('[data-nav="first"]').disabled = cur === 0;
    S.nav.querySelector('[data-nav="prev"]').disabled = cur === 0;
    S.nav.querySelector('[data-nav="next"]').disabled = cur >= n;
    S.nav.querySelector('[data-nav="last"]').disabled = cur >= n;
  }
  function statusText() {
    var g = S.game;
    if (S.typed) return 'Move: <b>' + esc(S.typed) + '</b><i class="chs-caret">_</i> <span class="chs-dim">Enter to play</span>';
    if (!live()) return 'Reviewing move ' + S.view + ' of ' + g.moves.length + ' <span class="chs-dim">· → or End to return</span>';
    if (g.result) {
      var r = g.result, w = r.result === '1-0' ? 'White wins' : r.result === '0-1' ? 'Black wins' : 'Draw';
      return '<b>' + w + '</b> · ' + esc(r.reason);
    }
    if (S.paused) return 'Paused';
    var chk = S.pos.inCheck() ? ' <b class="chs-chk">Check!</b>' : '';
    if (g.mode === 'cpu') return (S.pos.side === g.human ? 'Your move' : 'Computer to move') + chk;
    return (S.pos.side ? 'Black' : 'White') + ' to move' + chk;
  }
  function renderStatus() {
    S.status.innerHTML = statusText();
  }
  // A game settled off the board (resignation, agreed draw, flag fall) can't be taken back.
  function settledOffBoard(g) { return !!(g && g.result && !/^(checkmate|stalemate|insufficient material|fifty-move rule|threefold repetition)$/.test(g.result.reason)); }
  function renderPad() {
    var g = S.game, canUndo = g && g.moves.length > 0 && (g.mode === '2p' || g.moves.length > (g.human === 1 ? 1 : 0)) && !S.paused && !settledOffBoard(g);
    S.pad.querySelector('[data-act="undo"]').disabled = !canUndo;
    S.pad.querySelector('[data-act="hint"]').disabled = !(g && live() && humanTurn() && !S.hintBusy);
    S.pad.querySelector('[data-act="resign"]').disabled = !(g && !g.result && g.moves.length > 0);
    S.pad.querySelector('[data-act="pgn"]').disabled = !(g && g.moves.length);
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    var clocked = S.game && S.game.tc !== 'none' && !S.game.result && S.game.moves.length > 0;
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = !clocked;
    pb.title = S.paused ? 'Resume (P)' : clocked ? 'Pause the clocks (P)' : 'Pause (with a clock)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }
  function renderAll(anim) {
    if (!S || !S.game) return;
    renderBoard(anim); renderBars(); renderMoves(); renderStatus(); renderPad(); syncHead();
  }

  // ---- clocks ----
  function clockRunning() { var g = S.game; return g && g.tc !== 'none' && !g.result && g.moves.length > 0 && !S.paused && live(); }
  function clockNow(side) {
    var g = S.game, ms = g.clocks[side];
    if (clockRunning() && S.pos.side === side && S.turnT) ms -= (now() - S.turnT);
    return Math.max(0, ms);
  }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function chargeClock() {
    // fold the running turn's time into the clock of the side to move
    var g = S.game;
    if (g.tc === 'none' || !S.turnT) { S.turnT = 0; return; }
    if (clockRunning()) g.clocks[S.pos.side] = clockNow(S.pos.side);
    S.turnT = 0;
  }
  function startTurnClock() { S.turnT = clockRunning() ? now() : 0; }
  function tickClock() {
    if (!S || !S.game || !clockRunning()) return;
    var side = S.pos.side, ms = clockNow(side);
    var el = S.panel.querySelector('.chs-clock[data-side="' + side + '"]');
    if (el) { el.textContent = fmtClock(ms); el.classList.toggle('low', ms < 20000); }
    if (ms < 10000 && humanTurn()) { var sec = Math.ceil(ms / 1000); if (sec !== S.lastTick) { S.lastTick = sec; sfx('tick'); } }
    if (ms <= 0) {
      S.game.clocks[side] = 0; S.turnT = 0;
      cancelThink();
      finish(flagResult(S.pos, side, E));
    }
  }

  // ---- making moves ----
  function anims(m, pos) {
    var a = [[E.mFrom(m), E.mTo(m)]];
    if (E.mFlags(m) & E.F_CASTLE) { var f = E.mFrom(m), t = E.mTo(m); a.push(t > f ? [f + 3, f + 1] : [f - 4, f - 1]); }
    return a;
  }
  function play(m, who) {
    var g = S.game;
    if (!g || g.result) return;
    if (S.view != null) S.view = null;
    chargeClock();
    var pos = S.pos, side = pos.side, fl = E.mFlags(m);
    var san = E.toSAN(pos, m);
    if (g.tc !== 'none') {
      g.clockHist.push([g.clocks[0], g.clocks[1]]);
      g.clocks[side] += TC_INC();
    }
    pos.make(m);
    g.moves.push(E.toUCI(m)); S.sans.push(san); S.mvs.push(m);
    S.hint = null; S.typed = ''; S.bv.clearSel();
    var st = E.status(pos);
    if (st.over) finish(st, true);
    else {
      sfx(st.check ? 'check' : E.mPromo(m) ? 'promo' : fl & E.F_CASTLE ? 'castle' : fl & E.F_CAP ? 'cap' : 'move');
      if (Cade.haptic && who !== 'cpu') Cade.haptic(6);
    }
    persist();
    startTurnClock();
    if (g.mode === '2p' && g.autoFlip && !st.over) {
      clearTimeout(S.flipT);
      S.holdFlip = true;
      S.flipT = setTimeout(function () { if (S && S.game === g) { S.holdFlip = false; renderAll(); } }, 520);
    }
    renderAll(anims(m));
    if (S.liveEl) S.liveEl.textContent = (side ? 'Black' : 'White') + ' ' + san + (st.over ? '. ' + st.reason : '');
    if (!g.result) maybeThink();
  }
  function TC_INC() { return tcById(S.game.tc).inc * 1000; }
  // A move from the board (from, to): promotions ask first.
  function onBoardMove(from, to) {
    if (!humanTurn() || !live()) return;
    var legal = S.pos.legalMoves().filter(function (m) { return E.mFrom(m) === from && E.mTo(m) === to; });
    if (!legal.length) { sfx('bad'); renderBoard(); return; }
    if (legal.length > 1) { askPromo(legal, from, to); return; }
    S.snd.ensure();
    play(legal[0], 'human');
  }
  function askPromo(legal, from, to) {
    S.promo = { legal: legal, from: from, to: to };
    var white = S.pos.side === 0;
    var h = '<div class="chs-promo" role="dialog" aria-label="Promote to"><div class="chs-promo-t">Promote to</div><div class="chs-promo-row">' +
      [5, 4, 3, 2].map(function (t) { return '<button type="button" class="chs-pp ' + (white ? 'w' : 'b') + (S.prefs.style === 'letter' ? ' let' : ' gl') + '" data-pt="' + t + '" aria-label="' + BV.NAMES[t] + '"' + (S.prefs.style === 'letter' ? '' : ' data-s="' + BV.SOLID[t] + BV.VS + '"') + '>' +
        (S.prefs.style === 'letter' ? (white ? 'PNBRQK' : 'pnbrqk').charAt(t - 1) : BV.HOLLOW[t] + BV.VS) + '</button>'; }).join('') +
      '</div><button type="button" class="chs-lnk" data-pt="0">cancel</button></div>';
    S.promoEl.innerHTML = h; S.promoEl.style.display = '';
    renderBoard();
  }
  function choosePromo(t) {
    var pr = S.promo;
    S.promo = null; S.promoEl.style.display = 'none'; S.promoEl.innerHTML = '';
    if (!pr || !t) { renderBoard(); return; }
    for (var i = 0; i < pr.legal.length; i++) if (E.mPromo(pr.legal[i]) === t) { play(pr.legal[i], 'human'); return; }
  }

  function finish(st, byMove) {
    var g = S.game;
    if (g.result) return;
    chargeClock();
    g.result = { result: st.result, reason: st.reason };
    cancelThink();
    // a game counts once in the stats, even if a move is taken back and it ends again
    var out = g.counted ? outcomeFor(g, g.result.result) : recordResult(S.stats, g, g.result, Date.now());
    g.counted = true;
    persistStats(); persist();
    var mine = g.mode === 'cpu' ? out : g.result.result === '1/2-1/2' ? 'd' : 'w';
    setTimeout(function () { if (S && S.game === g) sfx(mine === 'w' ? 'win' : mine === 'l' ? 'lose' : 'draw'); }, byMove ? 160 : 0);
    if (mine === 'w' && g.mode === 'cpu' || (g.mode === '2p' && g.result.result !== '1/2-1/2')) burst();
    renderAll();
    setTimeout(function () { if (S && S.game === g && g.result) showCard('result'); }, byMove ? 650 : 120);
  }

  // ---- the computer ----
  function makeWorker() {
    if (S.worker || S.noWorker) return S.worker;
    try {
      S.worker = new Worker(ENGINE_URL);
      S.worker.onmessage = function (e) { onEngine(e.data || {}); };
      S.worker.onerror = function () { killWorker(); S.noWorker = true; var p = S.pending; S.pending = {}; for (var k in p) runLocal(p[k]); };
    } catch (e) { S.worker = null; S.noWorker = true; }
    return S.worker;
  }
  function killWorker() { if (S && S.worker) { try { S.worker.terminate(); } catch (e) {} S.worker = null; } }
  function ask(kind, opts, cb) {
    var id = ++S.reqId, msg = { id: id, fen: startFen(), moves: S.game.moves.slice(), opts: opts };
    S.pending[id] = { msg: msg, cb: cb, kind: kind, gameId: S.game.id, ply: S.game.moves.length };
    var w = makeWorker();
    if (w) { try { w.postMessage(msg); return id; } catch (e) { S.noWorker = true; } }
    runLocal(S.pending[id]);
    return id;
  }
  function runLocal(p) {
    // no Worker: a short search on the page, after the board has painted
    setTimeout(function () {
      if (!S || !S.pending[p.msg.id]) return;
      var o = p.msg.opts;
      o.timeCap = Math.min(o.timeCap || 600, 600);
      if (o.time) o.time = Math.min(o.time, 600);
      var r;
      try { r = E.handle(p.msg); } catch (e) { r = { id: p.msg.id, error: String(e) }; }
      onEngine(r);
    }, 30);
  }
  function onEngine(r) {
    if (!S) return;
    var p = S.pending[r.id];
    if (!p) return;
    delete S.pending[r.id];
    if (!S.game || p.gameId !== S.game.id || p.ply !== S.game.moves.length) {   // stale
      if (p.kind === 'hint') { S.hintBusy = false; if (S.game) { renderPad(); renderStatus(); } }
      return;
    }
    p.cb(r);
  }
  function cancelThink() {
    if (!S) return;
    var busy = false;
    for (var k in S.pending) { busy = true; break; }
    S.pending = {};
    if (busy) killWorker();         // a search can't be interrupted: drop the worker and start a fresh one next time
    S.thinking = false; S.hintBusy = false;
    clearTimeout(S.cpuT);
  }
  function maybeThink() {
    var g = S.game;
    if (!g || g.result || g.mode !== 'cpu' || S.pos.side === g.human || S.thinking) return;
    S.thinking = true;
    var t0 = now(), cap = g.tc !== 'none' ? cpuTimeCap(g.clocks[S.pos.side], TC_INC()) : 0;
    renderBars(); renderStatus(); renderPad();
    ask('move', { level: g.level, timeCap: cap }, function (r) {
      var wait = Math.max(0, (g.level <= 2 ? 450 : 250) - (now() - t0));
      S.cpuT = setTimeout(function () {
        if (!S || S.game !== g) return;
        if (S.paused) { S.heldReply = r; return; }
        applyCpu(r);
      }, wait);
    });
  }
  function applyCpu(r) {
    S.thinking = false;
    if (r.error || !r.uci) { renderAll(); return; }
    S.cpuEval = r.score || 0;
    var m = E.fromUCI(S.pos, r.uci);
    if (!m) { renderAll(); return; }
    play(m, 'cpu');
  }
  function hint() {
    if (!S.game || !humanTurn() || !live() || S.hintBusy) return;
    var ply = S.game.moves.length;
    if (S.hint && S.hint.ply === ply) { renderBoard(); return; }
    S.hintBusy = true; renderPad();
    S.status.innerHTML = 'Thinking about a hint<span class="chs-think"><b>.</b><b>.</b><b>.</b></span>';
    ask('hint', { time: 900, depth: 64 }, function (r) {
      S.hintBusy = false;
      if (!r.uci) { renderAll(); return; }
      var m = E.fromUCI(S.pos, r.uci);
      if (!m) { renderAll(); return; }
      S.hint = { ply: ply, from: E.mFrom(m), to: E.mTo(m), san: E.toSAN(S.pos, m) };
      S.game.hints++; persist();
      sfx('hint');
      renderAll();
      S.status.innerHTML = 'Hint: <b>' + esc(S.hint.san) + '</b>' + (r.mate > 0 ? ' <span class="chs-dim">· mate in ' + r.mate + '</span>' : '');
    });
  }

  // ---- commands ----
  function undo() {
    var g = S.game;
    if (!g || !g.moves.length || S.paused || settledOffBoard(g)) return;
    var n = 1;
    if (g.mode === 'cpu') {
      if (S.thinking) { cancelThink(); n = 1; }
      else n = S.pos.side === g.human ? 2 : 1;       // your move: take back the computer's reply and yours
      if (g.human === 1 && g.moves.length - n < 1) n = g.moves.length - 1;   // keep the computer's first move
      if (n <= 0) return;
    }
    n = Math.min(n, g.moves.length);
    chargeClock();
    var k = g.moves.length - n;
    if (g.tc !== 'none' && g.clockHist.length >= g.moves.length) { g.clocks = g.clockHist[k].slice(); g.clockHist.length = k; }
    g.moves.length = k;
    g.result = null; g.undos++;
    S.view = null; S.hint = null; S.typed = '';
    rebuild(); persist();
    startTurnClock();
    sfx('click');
    renderAll();
    if (S.card === 'result') showCard(null);
    maybeThink();
  }
  function flip() { S.flipManual = !S.flipManual; S.bv.clearSel(); renderAll(); }
  function navTo(ply) {
    var n = S.game.moves.length;
    ply = Math.max(0, Math.min(n, ply));
    var wasLive = live();
    S.view = ply >= n ? null : ply;
    if (wasLive && S.view != null) chargeClock();
    if (!wasLive && S.view == null) startTurnClock();
    S.bv.clearSel(); renderAll();
  }
  function curPly() { return S.view == null ? S.game.moves.length : S.view; }
  function copyText(text) {
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        toast('PGN copied', 'success');
      } catch (e) { toast('Copy failed', 'error'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('PGN copied', 'success'); }, fallback);
    else fallback();
  }
  function pgnText() {
    var g = S.game, d = new Date(g.started || Date.now()), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return E.pgn({
      event: g.mode === 'cpu' ? 'Casual game vs computer (' + E.LEVELS[g.level - 1].name + ')' : 'Casual game',
      date: d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate()),
      white: g.mode === 'cpu' ? (g.human === 0 ? 'Player' : 'Cade CPU ' + E.LEVELS[g.level - 1].name) : 'White',
      black: g.mode === 'cpu' ? (g.human === 1 ? 'Player' : 'Cade CPU ' + E.LEVELS[g.level - 1].name) : 'Black',
      result: g.result ? g.result.result : '*', termination: g.result ? g.result.reason : '', fen: g.startFen || '', sans: S.sans
    });
  }
  function insertPgn() {
    try {
      var ed = Cade.editor, pos = ed.state.selection.main.head, txt = '\n```pgn\n' + pgnText() + '```\n';
      ed.dispatch({ changes: { from: pos, insert: txt }, selection: { anchor: pos + txt.length } });
      toast('PGN inserted into the note', 'success');
    } catch (e) { copyText(pgnText()); }
  }
  function startGame(opts) {
    cancelThink();
    var p = S.prefs, human = opts.color === 'b' ? 1 : opts.color === 'r' ? (Math.random() < 0.5 ? 0 : 1) : 0;
    S.game = newGame({ mode: opts.mode, level: opts.level, human: human, autoFlip: opts.autoFlip, tc: opts.tc, now: Date.now(), id: (Date.now() % 1e9) + Math.floor(Math.random() * 1000) });
    p.lastMode = opts.mode; p.lastLevel = opts.level; p.lastColor = opts.color; p.lastTc = opts.tc; p.autoFlip = opts.autoFlip;
    persistPrefs();
    S.view = null; S.hint = null; S.typed = ''; S.flipManual = false; S.paused = false; S.heldReply = null; S.cpuEval = 0;
    rebuild(); persist();
    showCard(null);
    S.snd.ensure(); sfx('castle');
    startTurnClock();
    renderAll();
    maybeThink();
  }
  function rematch() {
    var g = S.game;
    startGame({ mode: g.mode, level: g.level, color: g.mode === 'cpu' ? (g.human ? 'w' : 'b') : 'w', tc: g.tc, autoFlip: g.autoFlip });
  }
  function resign() {
    var g = S.game;
    if (!g || g.result) return;
    var loser = g.mode === 'cpu' ? g.human : S.pos.side;
    showCard(null);
    finish({ result: loser === 0 ? '0-1' : '1-0', reason: (loser ? 'Black' : 'White') + ' resigned' });
  }
  function offerDraw() {
    var g = S.game;
    if (!g || g.result) return;
    showCard(null);
    if (g.mode === '2p') { finish({ result: '1/2-1/2', reason: 'agreed draw' }); return; }
    if (S.thinking) { toast('Wait for the computer to move', 'info'); return; }
    if (acceptsDraw(S.cpuEval || 0, g.moves.length)) finish({ result: '1/2-1/2', reason: 'draw agreed' });
    else { toast('The computer declines the draw', 'info'); sfx('bad'); }
  }
  function pause() {
    if (!S || S.paused || !S.game || S.game.result || S.game.tc === 'none' || !S.game.moves.length) return;
    chargeClock();
    S.paused = true;
    persist();
    showCard('pause'); renderAll();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null);
    startTurnClock(); renderAll();
    if (S.heldReply) { var r = S.heldReply; S.heldReply = null; applyCpu(r); }
  }

  // ---- typed moves ----
  function typeKey(e) {
    var k = e.key;
    if (k === 'Backspace') { if (S.typed) { S.typed = S.typed.slice(0, -1); renderStatus(); return true; } return false; }
    if (k === 'Enter' || k === 'NumpadEnter') {
      if (!S.typed) return false;
      var t = S.typed; S.typed = '';
      if (!humanTurn() || !live()) { renderStatus(); return true; }
      var m = E.fromSAN(S.pos, t.replace(/^([nrqk])/, function (c) { return c.toUpperCase(); }));
      if (!m) { sfx('bad'); toast('"' + t + '" isn\'t a legal move here', 'info'); S.status.classList.remove('shake'); void S.status.offsetWidth; S.status.classList.add('shake'); renderStatus(); return true; }
      S.snd.ensure();
      play(m, 'human');
      return true;
    }
    if (k.length !== 1) return false;
    if (S.typed.length >= 7) return true;
    var ok = /[a-hxO0-8=+#\-NBRQK]/.test(k) || (!S.typed && /[nrqk]/.test(k)) || (S.typed && /[nbrq]/i.test(k) && /[a-h][18]=?$|[a-h][1-8][a-h][1-8]$/.test(S.typed));
    if (!ok) return false;
    S.typed += k;
    renderStatus();
    return true;
  }

  // ---- cards over the board ----
  function cardWrap(title, inner, cls) { return '<div class="chs-card' + (cls ? ' ' + cls : '') + '"><div class="chs-title">' + title + '</div>' + inner + '</div>'; }
  function chip(attr, val, label, on, extra) { return '<button type="button" class="chs-chip' + (on ? ' on' : '') + '" data-' + attr + '="' + val + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + label + (extra || '') + '</button>'; }
  function menuHtml() {
    var m = S.menu, h = '';
    h += '<div class="chs-sec"><div class="chs-h">Opponent</div><div class="chs-chips">' + chip('mode', 'cpu', 'Computer', m.mode === 'cpu') + chip('mode', '2p', '2 players · one device', m.mode === '2p') + '</div></div>';
    if (m.mode === 'cpu') {
      h += '<div class="chs-sec"><div class="chs-h">Level</div><div class="chs-chips">' + E.LEVELS.map(function (L) {
        var st = S.stats.levels[L.id], rec = st.w + st.d + st.l ? ' <i>' + st.w + '-' + st.d + '-' + st.l + '</i>' : '';
        return chip('level', L.id, L.id + ' ' + L.name, m.level === L.id, rec);
      }).join('') + '</div></div>';
      h += '<div class="chs-sec"><div class="chs-h">Play as</div><div class="chs-chips">' + chip('color', 'w', '<span class="chs-sw w"></span>White', m.color === 'w') + chip('color', 'b', '<span class="chs-sw b"></span>Black', m.color === 'b') + chip('color', 'r', 'Random', m.color === 'r') + '</div></div>';
    } else {
      h += '<div class="chs-sec"><div class="chs-h">Board</div><div class="chs-chips">' + chip('af', '1', 'Turn to the player to move', m.autoFlip) + chip('af', '0', 'Keep White at the bottom', !m.autoFlip) + '</div></div>';
    }
    h += '<div class="chs-sec"><div class="chs-h">Clock</div><div class="chs-chips">' + TIME_CONTROLS.map(function (t) { return chip('tc', t.id, t.label, m.tc === t.id); }).join('') + '</div></div>';
    var g = S.game, going = g && !g.result && g.moves.length;
    h += '<div class="chs-btns"><button type="button" class="chs-go" data-act="start">' + (going ? 'Start a new game' : 'Play') + '</button>' +
      (g && S.cardBack ? '<button type="button" class="chs-go alt" data-act="close">' + (going ? 'Back to game' : 'Back') + '</button>' : '') + '</div>';
    h += '<div class="chs-foot"><span>Pieces: ' + '<button type="button" class="chs-lnk' + (S.prefs.style === 'glyph' ? ' on' : '') + '" data-style="glyph"><span class="chs-sym">' + BV.SOLID[3] + BV.VS + '</span> glyphs</button> <button type="button" class="chs-lnk' + (S.prefs.style === 'letter' ? ' on' : '') + '" data-style="letter">B letters</button></span>' +
      '<button type="button" class="chs-lnk" data-act="stats">Stats</button></div>';
    if (going) h += '<div class="chs-note">A new game ends the one in progress (it isn\'t counted).</div>';
    return cardWrap('NEW GAME', h, 'chs-menu');
  }
  function resultHtml() {
    var g = S.game, r = g.result, out = outcomeFor(g, r.result), big, art;
    if (g.mode === 'cpu') { big = out === 'w' ? 'You win!' : out === 'l' ? 'You lost' : 'Draw'; }
    else big = r.result === '1-0' ? 'White wins' : r.result === '0-1' ? 'Black wins' : 'Draw';
    art = r.result === '1/2-1/2' ? '  _____\n =|  =  |=\n  \\___/' : (out === 'w' || g.mode === '2p') ? '  \\o/  * \n   |  *  \n  / \\ ' : '   .--.\n  ( x_x)\n   `--\'';
    if (r.reason === 'checkmate') art = r.result === '1/2-1/2' ? art : '  + # +\n   \\|/\n  -(K)-';
    var st = g.mode === 'cpu' ? S.stats.levels[g.level] : null;
    var h = '<pre class="chs-art" aria-hidden="true">' + esc(art) + '</pre><div class="chs-big">' + esc(big) + '</div>' +
      '<div class="chs-sub">' + esc(r.reason) + ' · ' + esc(r.result) + ' · ' + Math.ceil(g.moves.length / 2) + ' moves</div>' +
      (st ? '<div class="chs-note">vs ' + esc(E.LEVELS[g.level - 1].name) + ': ' + st.w + ' won · ' + st.d + ' drawn · ' + st.l + ' lost' + (g.hints ? ' · hints used ' + g.hints : '') + '</div>' : '') +
      '<div class="chs-btns"><button type="button" class="chs-go" data-act="rematch">Rematch</button><button type="button" class="chs-go alt" data-act="review">Review</button></div>' +
      '<div class="chs-foot"><button type="button" class="chs-lnk" data-act="menu">New game…</button><span><button type="button" class="chs-lnk" data-act="copy">Copy PGN</button> <button type="button" class="chs-lnk" data-act="insert">Insert in note</button></span></div>';
    var title = r.reason === 'checkmate' ? 'CHECKMATE' : r.result === '1/2-1/2' ? 'DRAW' : r.reason === 'time' ? 'TIME' : 'GAME OVER';
    return cardWrap(title, h, 'chs-res');
  }
  function statsHtml() {
    var s = S.stats, rows = E.LEVELS.map(function (L) {
      var t = s.levels[L.id], n = t.w + t.d + t.l, pct = n ? Math.round((t.w + t.d / 2) / n * 100) + '%' : '-';
      return pad(L.id + ' ' + L.name, 11) + pad(String(t.w), 4, 1) + pad(String(t.d), 4, 1) + pad(String(t.l), 4, 1) + pad(pct, 6, 1);
    });
    var h = '<pre class="chs-tab">' + '<i>' + pad('vs CPU', 11) + pad('W', 4, 1) + pad('D', 4, 1) + pad('L', 4, 1) + pad('score', 6, 1) + '</i>\n' + rows.map(function (r) { return '<b>' + esc(r) + '</b>'; }).join('\n') +
      '\n<i>' + pad('2 players', 11) + '</i>\n' + esc(pad('White wins', 18) + pad(String(s.p2.w), 11, 1)) + '\n' + esc(pad('Black wins', 18) + pad(String(s.p2.b), 11, 1)) + '\n' + esc(pad('Draws', 18) + pad(String(s.p2.d), 11, 1)) + '</pre>';
    if (s.recent.length) {
      h += '<div class="chs-h">Recent</div><pre class="chs-tab chs-recent">' + s.recent.slice(0, 8).map(function (r) {
        var who = r.mode === 'cpu' ? 'vs ' + E.LEVELS[r.lv - 1].name : '2 players';
        return '<span class="o-' + r.out + '">' + esc(pad(r.r, 8) + pad(who, 13) + r.why) + '</span>';
      }).join('\n') + '</pre>';
    }
    h += '<div class="chs-foot">' + (S.resetArm ? '<span class="chs-confirm">Erase all stats?</span><span><button type="button" class="chs-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="chs-lnk" data-act="reset-no">Keep</button></span>'
      : '<button type="button" class="chs-lnk" data-act="back">Back</button><button type="button" class="chs-lnk" data-act="reset">Reset stats</button>') + '</div>';
    return cardWrap('STATS', h);
  }
  function pad(s, n, right) { s = String(s); while (s.length < n) s = right ? ' ' + s : s + ' '; return s; }
  function helpHtml() {
    var keys = S.coarse ?
      '<div><b>tap</b> a piece, then a square &nbsp;(or drag it)</div><div><b>&lsaquo; &rsaquo;</b> step through the moves</div>' :
      '<div><b>click / drag</b> &nbsp;move a piece</div><div><b>type</b> e4, Nf3, O-O, e7e8q + <b>Enter</b></div><div><b>U</b> undo &nbsp;<b>?</b> hint &nbsp;<b>V</b> flip &nbsp;<b>M</b> new game</div><div><b>&larr; &rarr;</b> / Home / End &nbsp;step through moves</div><div><b>P</b> pause the clocks &nbsp;<b>Esc</b> close</div>';
    return cardWrap('CHESS', '<pre class="chs-art" aria-hidden="true">  _   ()   _\n | |_/  \\_| |\n |__________|</pre>' +
      '<p>Play the computer on six levels, from <b>Novice</b> (it blunders) to <b>Master</b> (3 seconds a move), or pass the device for <b>2 players</b>.</p>' +
      '<div class="chs-keys">' + keys + '</div>' +
      '<p class="chs-tip">All the rules: castling, <b>en passant</b>, promotion (you choose the piece), and draws by stalemate, threefold repetition, the 50-move rule and insufficient material.</p>' +
      '<p class="chs-tip"><b>Hint</b> shows the computer\'s best move as an arrow. <b>Undo</b> takes back your last move. With a clock, time runs from the first move and the increment is added after each move; a closed or hidden panel pauses it.</p>' +
      '<p class="chs-tip">Your game is saved as you play. Copy it as <b>PGN</b> for any chess site.</p>' +
      '<div class="chs-btns"><button type="button" class="chs-go" data-act="close">Got it</button></div>', 'chs-help');
  }
  function confirmHtml() {
    var g = S.game;
    return cardWrap('RESIGN?', '<p class="chs-sub">' + (g.mode === 'cpu' ? 'Give up this game, or offer the computer a draw?' : (S.pos.side ? 'Black' : 'White') + ' resigns, or both agree a draw?') + '</p>' +
      '<div class="chs-btns"><button type="button" class="chs-go" data-act="resign-yes">Resign</button><button type="button" class="chs-go alt" data-act="draw">' + (g.mode === 'cpu' ? 'Offer draw' : 'Agree draw') + '</button></div>' +
      '<div class="chs-foot"><span></span><button type="button" class="chs-lnk" data-act="close">Keep playing</button></div>');
  }
  function pauseHtml() {
    return cardWrap('PAUSED', '<div class="chs-sub">The clocks are stopped.</div><div class="chs-btns"><button type="button" class="chs-go" data-act="resume">Resume</button></div>' +
      '<div class="chs-note">' + (S.coarse ? 'Tap Resume to carry on' : 'P or Space to resume') + '</div>');
  }
  function showCard(kind, back) {
    S.card = kind;
    if (kind === 'menu') { S.cardBack = back !== false; S.menu = S.menu || { mode: S.prefs.lastMode, level: S.prefs.lastLevel, color: S.prefs.lastColor, tc: S.prefs.lastTc, autoFlip: S.prefs.autoFlip }; }
    var h = kind === 'menu' ? menuHtml() : kind === 'result' ? resultHtml() : kind === 'stats' ? statsHtml() : kind === 'help' ? helpHtml() : kind === 'confirm' ? confirmHtml() : kind === 'pause' ? pauseHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.root.classList.toggle('dim', !!kind);
    if (kind) S.bv.clearSel();
    if (S.game) renderBoard();
  }
  function closeCard() {
    if (!S.card) return;
    if (S.card === 'pause') { resume(); return; }
    if (S.card === 'stats' && S.statsFrom) { var f = S.statsFrom; S.statsFrom = null; showCard(f); return; }
    if (S.card === 'menu' && !S.cardBack) return;
    showCard(null);
  }
  function burst() {
    if (!S || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    var host = S.stage, wrap = document.createElement('div'), ch = '*+.o*x+', h = '';
    wrap.className = 'chs-burst';
    for (var i = 0; i < 28; i++) {
      var a = Math.random() * Math.PI * 2, d = host.offsetWidth * (0.22 + Math.random() * 0.3);
      h += '<i style="--dx:' + (Math.cos(a) * d).toFixed(1) + 'px;--dy:' + (Math.sin(a) * d).toFixed(1) + 'px;animation-delay:' + (Math.random() * 0.15).toFixed(2) + 's" class="c' + (i % 4) + '">' + ch.charAt(i % ch.length) + '</i>';
    }
    wrap.innerHTML = h;
    host.appendChild(wrap);
    setTimeout(function () { wrap.remove(); }, 1500);
  }

  // ---- keys ----
  function onKey(e) {
    if (!S) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (t && t.isContentEditable && !S.panel.contains(t)) return;
    if (!S.game) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (!S.card) undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key, code = e.code;
    if (k === 'Escape') {
      e.preventDefault();
      if (S.typed) { S.typed = ''; renderStatus(); }
      else if (S.promo) choosePromo(0);
      else if (S.card && (S.card !== 'menu' || S.cardBack)) closeCard();
      else if (!live()) navTo(S.game.moves.length);
      else closePanel();
      return;
    }
    if (S.promo) {
      var pm = { q: 5, r: 4, b: 3, n: 2 }[k.toLowerCase()];
      if (pm) { e.preventDefault(); choosePromo(pm); }
      return;
    }
    if (S.card) {
      if (S.card === 'pause' && (k === ' ' || k === 'p' || k === 'P')) { e.preventDefault(); resume(); }
      else if ((k === 'Enter' || k === ' ') && S.card === 'menu' && !(t && t.tagName === 'BUTTON' && S.panel.contains(t))) { e.preventDefault(); startFromMenu(); }
      return;
    }
    if (typeKey(e)) { e.preventDefault(); return; }
    var handled = true;
    if (k === 'ArrowLeft') navTo(curPly() - 1);
    else if (k === 'ArrowRight') navTo(curPly() + 1);
    else if (k === 'Home' || k === 'ArrowUp') navTo(0);
    else if (k === 'End' || k === 'ArrowDown') navTo(S.game.moves.length);
    else if (k === 'u' || k === 'U') undo();
    else if (k === '?' || k === 'i' || k === 'I') hint();
    else if (k === 'v' || k === 'V') flip();
    else if (k === 'm' || k === 'M') showCard('menu');
    else if (k === 'p' || k === 'P') { if (S.paused) resume(); else pause(); }
    else handled = false;
    if (handled) e.preventDefault();
    void code;
  }
  function startFromMenu() {
    var m = S.menu;
    startGame({ mode: m.mode, level: m.level, color: m.color, tc: m.tc, autoFlip: m.autoFlip });
  }

  // ---- layout ----
  function layout() {
    if (!S) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 640, solo = S.panel.classList.contains('cade-solo-panel');
    S.phone = phone;
    S.root.classList.toggle('phone', phone);
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    var r = S.panel.getBoundingClientRect(), top = Math.min(Math.max(0, r.top || 50), 120);
    var sz;
    if (phone) {
      var chrome = 40 + 2 * 30 + 40 + 58 + 40;     // head, bars, status/moves strip, pad, padding
      sz = Math.min(vw - 34, vh - top - chrome);
    } else {
      var chrome2 = 40 + 2 * 34 + 58 + 36;
      sz = Math.min(solo ? 640 : 520, vh - top - chrome2, vw - 300);
    }
    sz = Math.max(232, Math.floor(sz / 8) * 8);
    S.root.style.setProperty('--chb-sz', sz + 'px');
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S;
    if (s.game && !s.game.result) { try { chargeClock(); persist(); } catch (e) {} }
    S = null;
    clearInterval(s.clockT); clearTimeout(s.cpuT); clearTimeout(s.flipT); clearTimeout(s.resizeT);
    if (s.worker) { try { s.worker.terminate(); } catch (e) {} }
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('pagehide', s.onHide);
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
    var p = Cade.mkPanel(PANEL_ID, '♞ Chess', '<div class="chs chs-loading">Setting up the board…</div>');
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    ensureLibs().then(function () { if (p.isConnected) build(p); }, function () {
      var b = p.querySelector('.chs');
      if (b) b.textContent = 'Couldn\'t load the chess engine. Check your connection and try again.';
    });
  }
  function build(p) {
    var body = '<div class="chs-main"><div class="chs-bar top"></div><div class="chs-stage"><div class="chs-promo-wrap" style="display:none"></div></div><div class="chs-bar bot"></div></div>' +
      '<div class="chs-side"><div class="chs-status" aria-live="polite"></div><div class="chs-moves" role="list" aria-label="Moves"></div>' +
      '<div class="chs-nav"><button type="button" data-nav="first" title="First move (Home)" aria-label="First move">' + IC_FIRST + '</button><button type="button" data-nav="prev" title="Previous move (←)" aria-label="Previous move">' + IC_PREV + '</button>' +
      '<button type="button" data-nav="next" title="Next move (→)" aria-label="Next move">' + IC_NEXT + '</button><button type="button" data-nav="last" title="Latest move (End)" aria-label="Latest move">' + IC_LAST + '</button></div></div>' +
      '<div class="chs-pad">' +
      '<button type="button" data-act="undo" title="Undo (U)">' + IC_UNDO + '<span>Undo</span></button>' +
      '<button type="button" data-act="hint" title="Hint (?)">' + IC_HINT + '<span>Hint</span></button>' +
      '<button type="button" data-act="flip" title="Flip board (V)">' + IC_FLIP + '<span>Flip</span></button>' +
      '<button type="button" data-act="resign" title="Resign or offer a draw">' + IC_FLAG + '<span>Resign</span></button>' +
      '<button type="button" data-act="pgn" title="Copy the game as PGN">' + IC_COPY + '<span>PGN</span></button></div>' +
      '<div class="chs-live" aria-live="polite"></div><div class="chs-ovl" style="display:none"></div>';
    var root = p.querySelector('.chs');
    root.className = 'chs';
    root.innerHTML = body;
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'chs-hb';
    hb.innerHTML = '<button type="button" data-h="menu" title="New game (M)" aria-label="New game">' + IC_MENU + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia;
    S = {
      panel: p, root: root, head: hb, stage: root.querySelector('.chs-stage'), ovl: root.querySelector('.chs-ovl'), promoEl: root.querySelector('.chs-promo-wrap'),
      barTop: root.querySelector('.chs-bar.top'), barBot: root.querySelector('.chs-bar.bot'), status: root.querySelector('.chs-status'),
      movesEl: root.querySelector('.chs-moves'), nav: root.querySelector('.chs-nav'), pad: root.querySelector('.chs-pad'), liveEl: root.querySelector('.chs-live'),
      snd: new Snd(sget(SOUND_KEY) === '1'), prefs: normPrefs(sjson(PREFS_KEY)), stats: normStats(sjson(STATS_KEY)),
      coarse: !!(mm && mm('(pointer: coarse)').matches), phone: false,
      game: null, pos: null, sans: [], mvs: [], view: null, hint: null, typed: '', flipManual: false, lastFlip: false,
      thinking: false, hintBusy: false, worker: null, noWorker: false, pending: {}, reqId: 0, cpuT: 0, cpuEval: 0,
      paused: false, heldReply: null, turnT: 0, lastTick: 0, card: null, cardBack: true, menu: null, promo: null, resetArm: false
    };
    S.bv = BV.create(S.stage, { onMove: onBoardMove, onPress: function () { if (S) S.snd.ensure(); } });
    S.stage.insertBefore(S.bv.el, S.promoEl);
    p._onClose = teardown;
    layout();

    var saved = normGame(sjson(GAME_KEY), E);
    if (saved) { S.game = saved; rebuild(); }
    else { S.game = newGame({ mode: S.prefs.lastMode, level: S.prefs.lastLevel, tc: 'none', now: Date.now(), id: 1 }); rebuild(); }

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { pause(); };
    window.addEventListener('blur', S.onBlur);
    // leaving the page: bank the running clock so a reload can't refund the time
    S.onHide = function () { if (S && S.game && !S.game.result) { chargeClock(); persist(); startTurnClock(); } };
    window.addEventListener('pagehide', S.onHide);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) pause(); });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () { if (S && S.panel === p) { if (S.themeDirty) { S.themeDirty = false; S.bv.applyTheme(); } layout(); renderAll(); } });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); renderAll(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        S.bv.applyTheme();
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}
    S.clockT = setInterval(tickClock, 100);

    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on; sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); sfx('click'); syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') { if (S.card === 'help') closeCard(); else if (!S.paused) { S.helpFrom = S.card; showCard('help'); } }
      else if (h === 'menu') { if (S.card === 'menu' && S.cardBack) closeCard(); else if (!S.paused) showCard('menu'); }
      try { b.blur(); } catch (er) {}
    });
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S || b.disabled) return;
      S.snd.ensure();
      var a = b.getAttribute('data-act');
      if (S.card && S.card !== 'result') { if (S.card === 'menu' && !S.cardBack) return; closeCard(); }
      if (a === 'undo') undo();
      else if (a === 'hint') hint();
      else if (a === 'flip') flip();
      else if (a === 'resign') showCard('confirm');
      else if (a === 'pgn') copyText(pgnText());
    });
    S.nav.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var n = b.getAttribute('data-nav');
      if (S.card === 'result') showCard(null);
      navTo(n === 'first' ? 0 : n === 'prev' ? curPly() - 1 : n === 'next' ? curPly() + 1 : S.game.moves.length);
    });
    S.movesEl.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-ply]') : null;
      if (!b || !S) return;
      if (S.card === 'result') showCard(null);
      navTo(+b.getAttribute('data-ply'));
    });
    S.promoEl.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-pt]') : null;
      if (b && S) choosePromo(+b.getAttribute('data-pt'));
    });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var m = S.menu, a = b.getAttribute('data-act');
      if (b.hasAttribute('data-mode')) { m.mode = b.getAttribute('data-mode'); showCard('menu', S.cardBack); }
      else if (b.hasAttribute('data-level')) { m.level = +b.getAttribute('data-level'); showCard('menu', S.cardBack); }
      else if (b.hasAttribute('data-color')) { m.color = b.getAttribute('data-color'); showCard('menu', S.cardBack); }
      else if (b.hasAttribute('data-tc')) { m.tc = b.getAttribute('data-tc'); showCard('menu', S.cardBack); }
      else if (b.hasAttribute('data-af')) { m.autoFlip = b.getAttribute('data-af') === '1'; showCard('menu', S.cardBack); }
      else if (b.hasAttribute('data-style')) { S.prefs.style = b.getAttribute('data-style'); persistPrefs(); showCard('menu', S.cardBack); renderAll(); }
      else if (a === 'start') startFromMenu();
      else if (a === 'close') { if (S.card === 'help' && S.helpFrom) { var f = S.helpFrom; S.helpFrom = null; showCard(f, S.cardBack); } else showCard(null); }
      else if (a === 'stats') { S.statsFrom = S.card; S.resetArm = false; showCard('stats'); }
      else if (a === 'back') closeCard();
      else if (a === 'reset') { S.resetArm = true; showCard('stats'); }
      else if (a === 'reset-no') { S.resetArm = false; showCard('stats'); }
      else if (a === 'reset-yes') { S.stats = newStats(); persistStats(); S.resetArm = false; toast('Stats reset'); showCard('stats'); }
      else if (a === 'rematch') rematch();
      else if (a === 'review') { showCard(null); navTo(0); }
      else if (a === 'menu') showCard('menu');
      else if (a === 'copy') copyText(pgnText());
      else if (a === 'insert') insertPgn();
      else if (a === 'resign-yes') resign();
      else if (a === 'draw') offerDraw();
      else if (a === 'resume') resume();
      if (b.isConnected) return;
      // keep keyboard focus on the replacement button
      var sel = ['data-mode', 'data-level', 'data-color', 'data-tc', 'data-af', 'data-style'].filter(function (x) { return b.hasAttribute(x); })[0];
      if (sel && e.detail === 0) { var nb = S.ovl.querySelector('[' + sel + '="' + b.getAttribute(sel) + '"]'); if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} } }
    });

    if (saved && !saved.result) {
      startTurnClock();
      if (S.game.tc !== 'none' && S.game.moves.length) { S.paused = true; showCard('pause'); }
      renderAll();
      maybeThink();
    } else {
      renderAll();
      if (saved) showCard('result');
      else if (!sget(PREFS_KEY) && !sget(STATS_KEY)) { S.cardBack = false; S.helpFrom = 'menu'; showCard('help'); }
      else showCard('menu', false);
    }
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); renderAll(); } });
    // spin the engine worker up early so the first computer move has no start-up hitch
    setTimeout(function () { if (S && S.panel === p && S.game && S.game.mode === 'cpu') makeWorker(); }, 400);
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Classic chess — vs the computer (levels) or pass-and-play, undo, hints, clocks',
    icon: '♞',
    tags: 'game,board,chess,strategy,2 player,cpu,pgn,clock,hint',
    open: open,
    _helpers: HELPERS
  });
})();
