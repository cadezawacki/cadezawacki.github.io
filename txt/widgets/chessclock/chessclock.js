/* Chess Clock — a two-player game clock for the table (or the desk).
 *
 * Two big halves, one per player. Tap your own half when you have moved: your
 * clock stops and your opponent's starts. Only the running side reacts; before
 * the game the first tap (Black's) starts the other clock (White's), like a
 * real clock. When the panel is taller than wide (a phone in portrait) the
 * halves stack and the top one is turned around, so two players facing each
 * other across a table can both read it. "Full screen" makes the panel cover
 * the viewport — the default on phones.
 *
 * Time controls: presets (bullet → classical) or custom — a base time plus a
 * Fischer increment, a Bronstein delay or a simple (US) delay, optionally a
 * different time for each side (handicap). The setting and the options are
 * remembered in Cade.store ('cade-chessclock-prefs'). A game in progress
 * survives a reload — it comes back paused ('cade-chessclock-game'); closing
 * the clock ends it.
 *
 * Accuracy: time is performance.now() deltas, never counted ticks. The clock
 * state machine (Core, DOM-free, exported for node: chessclock.test.js) takes
 * the current time as an argument everywhere, so it is exact and testable.
 *
 * Cost: nothing runs until the panel opens. While a game runs, the digits are
 * painted by requestAnimationFrame only while the page is visible and the
 * panel is not minimized (the DOM is written only when a digit changes), plus
 * one timeout set for the moment the running side would flag (so the flag
 * sounds even while minimized). The screen wake lock is held only while the
 * clock runs on screen. Every listener, frame, timer, the wake lock and the
 * AudioContext go when the panel closes. Self-contained IIFE, ES5.
 */
(function () {
  'use strict';

  // ======================================================================
  // Pure clock logic (no DOM)
  // ======================================================================
  var Core = (function () {
    var MODES = ['inc', 'bronstein', 'delay'];   // inc = Fischer increment
    var MIN_BASE = 1000, MAX_BASE = 10 * 3600000, MAX_INC = 600000;
    var PRESET_GROUPS = [
      { name: 'Bullet', list: ['1+0', '2+1'] },
      { name: 'Blitz', list: ['3+0', '3+2', '5+0', '5+3'] },
      { name: 'Rapid', list: ['10+0', '10+5', '15+10'] },
      { name: 'Classical', list: ['30+0', '30+20', '90+30'] },
    ];
    var DEFAULT_PRESET = '5+3';

    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function int(x, lo, hi, d) {
      x = typeof x === 'string' && x.trim() !== '' ? +x : x;
      if (typeof x !== 'number' || !isFinite(x)) return d;
      return Math.max(lo, Math.min(hi, Math.round(x)));
    }
    function side(base, inc) { return { base: base, inc: inc }; }

    function isPreset(id) {
      for (var g = 0; g < PRESET_GROUPS.length; g++) if (PRESET_GROUPS[g].list.indexOf(id) >= 0) return true;
      return false;
    }
    function presetCfg(id) {
      if (!isPreset(id)) return null;
      var m = /^(\d+)\+(\d+)$/.exec(id), b = +m[1] * 60000, i = +m[2] * 1000;
      return { mode: 'inc', sides: [side(b, i), side(b, i)] };
    }
    function normSide(s, d) {
      s = s && typeof s === 'object' ? s : {};
      return side(int(s.base, MIN_BASE, MAX_BASE, d.base), int(s.inc, 0, MAX_INC, d.inc));
    }
    // Any stored / typed value → a valid config { mode, sides: [{base, inc} ×2] } (ms).
    function normCfg(raw) {
      var d = presetCfg(DEFAULT_PRESET);
      if (!raw || typeof raw !== 'object') return d;
      var sides = Array.isArray(raw.sides) ? raw.sides : [];
      var a = normSide(sides[0], d.sides[0]);
      var b = sides[1] && typeof sides[1] === 'object' ? normSide(sides[1], a) : side(a.base, a.inc);
      return { mode: MODES.indexOf(raw.mode) >= 0 ? raw.mode : 'inc', sides: [a, b] };
    }
    function handicap(cfg) { return cfg.sides[0].base !== cfg.sides[1].base || cfg.sides[0].inc !== cfg.sides[1].inc; }
    // The preset this config is ('' when custom). With no bonus the mode doesn't matter.
    function presetOf(cfg) {
      if (handicap(cfg)) return '';
      var s = cfg.sides[0];
      if (s.base % 60000 || s.inc % 1000 || (s.inc && cfg.mode !== 'inc')) return '';
      var id = s.base / 60000 + '+' + s.inc / 1000;
      return isPreset(id) ? id : '';
    }
    function baseText(ms) {
      var s = Math.round(ms / 1000);
      return s % 60 ? Math.floor(s / 60) + ':' + pad2(s % 60) : String(s / 60);
    }
    // "5+3" (increment), "5 d3" (simple delay), "5 b3" (Bronstein), "5+0".
    function sideShort(cfg, i) {
      var s = cfg.sides[i], b = baseText(s.base), inc = String(Math.round(s.inc / 100) / 10);
      if (!s.inc || cfg.mode === 'inc') return b + '+' + inc;
      return b + (cfg.mode === 'delay' ? ' d' : ' b') + inc;
    }
    function shortLabel(cfg) {
      var a = sideShort(cfg, 0), b = sideShort(cfg, 1);
      return a === b ? a : a + ' / ' + b;
    }

    // ---- the clock -----------------------------------------------------------------
    // rem[i]: side i's time at the start of its current turn (or its standing time).
    // used: time already spent in the current turn before t0 (it survives a pause).
    function create(cfg) {
      cfg = normCfg(cfg);
      return { cfg: cfg, rem: [cfg.sides[0].base, cfg.sides[1].base], turn: -1, running: false, t0: 0, used: 0, moves: [0, 0], flag: -1, first: -1 };
    }
    function usedNow(st, now) { return st.used + (st.running ? Math.max(0, now - st.t0) : 0); }
    // Side i's time as the clock shows it now (may be ≤ 0 before tick() notices).
    function rawLeft(st, i, now) {
      if (i !== st.turn || st.flag >= 0) return st.rem[i];
      var u = usedNow(st, now), d = st.cfg.sides[i].inc;
      return st.cfg.mode === 'delay' ? st.rem[i] - Math.max(0, u - d) : st.rem[i] - u;
    }
    function left(st, i, now) { return Math.max(0, rawLeft(st, i, now)); }
    // Simple delay: what is left of this turn's delay (the main time waits for it).
    function delayLeft(st, now) {
      if (st.cfg.mode !== 'delay' || st.turn < 0 || st.flag >= 0) return 0;
      return Math.max(0, st.cfg.sides[st.turn].inc - usedNow(st, now));
    }
    // ms until the side to move flags (Infinity while not running).
    function toFlag(st, now) {
      if (!st.running) return Infinity;
      var i = st.turn, u = usedNow(st, now);
      return st.cfg.mode === 'delay' ? st.rem[i] + st.cfg.sides[i].inc - u : st.rem[i] - u;
    }
    // Flag the side to move when its time is up (at exactly 0, too). → true when it just flagged.
    function tick(st, now) {
      if (!st.running || rawLeft(st, st.turn, now) > 0) return false;
      st.rem[st.turn] = 0;
      st.used = 0;
      st.running = false;
      st.flag = st.turn;
      return true;
    }
    // Side i presses its button (= "I have moved"). → 'start' | 'press' | 'flag' | 'ignored'
    function press(st, i, now) {
      if (st.flag >= 0 || (i !== 0 && i !== 1)) return 'ignored';
      if (st.turn < 0) {                       // the first press starts the other clock; no bonus
        st.turn = 1 - i; st.first = st.turn; st.running = true; st.t0 = now; st.used = 0;
        return 'start';
      }
      if (i !== st.turn || !st.running) return 'ignored';
      if (tick(st, now)) return 'flag';
      var u = usedNow(st, now), d = st.cfg.sides[i].inc, r = st.rem[i];
      if (st.cfg.mode === 'inc') r = r - u + d;                       // Fischer: the bonus after every move
      else if (st.cfg.mode === 'bronstein') r = r - u + Math.min(u, d); // back what was used, up to the delay
      else r = r - Math.max(0, u - d);                                // simple delay: the first d ms are free
      st.rem[i] = r;
      st.moves[i]++;
      st.turn = 1 - i; st.t0 = now; st.used = 0;
      return 'press';
    }
    function pause(st, now) {
      if (!st.running) return 'ignored';
      if (tick(st, now)) return 'flag';
      st.used = usedNow(st, now);
      st.running = false;
      return 'paused';
    }
    function resume(st, now) {
      if (st.running || st.turn < 0 || st.flag >= 0) return 'ignored';
      st.t0 = now; st.running = true;
      return 'resumed';
    }
    function paused(st) { return st.turn >= 0 && !st.running && st.flag < 0; }
    function inProgress(st) { return st.turn >= 0 && st.flag < 0; }
    // Swap the players' places (their times, moves and settings) — not while running.
    function swap(st) {
      if (st.running) return false;
      st.cfg = { mode: st.cfg.mode, sides: [st.cfg.sides[1], st.cfg.sides[0]] };
      st.rem = [st.rem[1], st.rem[0]];
      st.moves = [st.moves[1], st.moves[0]];
      if (st.turn >= 0) st.turn = 1 - st.turn;
      if (st.first >= 0) st.first = 1 - st.first;
      if (st.flag >= 0) st.flag = 1 - st.flag;
      return true;
    }
    // Low-time warning: 10 % of the base time, between 10 s and 60 s.
    function lowAt(cfg, i) { return Math.max(10000, Math.min(60000, cfg.sides[i].base / 10)); }
    // m:ss (h:mm:ss from an hour), tenths under 20 s; rounded up, so 0:00.0 only at the flag.
    function fmt(ms) {
      ms = ms > 0 ? ms : 0;
      var t = Math.ceil(ms / 100 - 1e-9);
      if (t < 200) return '0:' + pad2(Math.floor(t / 10)) + '.' + (t % 10);
      var s = Math.ceil(ms / 1000 - 1e-9), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
      return h ? h + ':' + pad2(m) + ':' + pad2(x) : m + ':' + pad2(x);
    }
    // A game in progress as plain JSON (wall = Date.now()), and back — restored paused.
    function snapshot(st, now, wall) {
      return { v: 1, cfg: st.cfg, rem: st.rem.slice(), turn: st.turn, used: usedNow(st, now), moves: st.moves.slice(), flag: st.flag, first: st.first, at: wall };
    }
    function restore(raw, wall, maxAge) {
      if (!raw || typeof raw !== 'object' || raw.v !== 1 || (raw.turn !== 0 && raw.turn !== 1) || raw.flag !== -1) return null;
      var at = +raw.at;
      if (!isFinite(at) || wall - at > maxAge || at - wall > 60000) return null;
      var st = create(raw.cfg), rem = Array.isArray(raw.rem) ? raw.rem : [], mv = Array.isArray(raw.moves) ? raw.moves : [];
      for (var i = 0; i < 2; i++) {
        var r = +rem[i];
        if (!isFinite(r) || r <= 0 || r > 4 * MAX_BASE) return null;
        st.rem[i] = r;
        st.moves[i] = int(mv[i], 0, 100000, 0);
      }
      var u = +raw.used;
      st.turn = raw.turn;
      st.used = isFinite(u) && u > 0 ? u : 0;
      st.first = raw.first === 0 || raw.first === 1 ? raw.first : st.turn;
      return rawLeft(st, st.turn, 0) > 0 ? st : null;
    }

    return {
      MODES: MODES, MIN_BASE: MIN_BASE, MAX_BASE: MAX_BASE, MAX_INC: MAX_INC, PRESET_GROUPS: PRESET_GROUPS, DEFAULT_PRESET: DEFAULT_PRESET,
      presetCfg: presetCfg, presetOf: presetOf, normCfg: normCfg, handicap: handicap, sideShort: sideShort, shortLabel: shortLabel,
      create: create, usedNow: usedNow, rawLeft: rawLeft, left: left, delayLeft: delayLeft, toFlag: toFlag, tick: tick,
      press: press, pause: pause, resume: resume, paused: paused, inProgress: inProgress, swap: swap, lowAt: lowAt, fmt: fmt,
      snapshot: snapshot, restore: restore,
    };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ======================================================================
  // Panel
  // ======================================================================
  var Cade = window.Cade;
  Cade.loadCSS('chessclock.css');

  var PANEL_ID = 'chessclock-panel';
  var PREFS_KEY = 'cade-chessclock-prefs';
  var GAME_KEY = 'cade-chessclock-game';
  var GAME_MAX_AGE = 24 * 3600000;
  var ARM_MS = 3000;          // "tap again to confirm" window
  var MODE_LABEL = { inc: 'Increment', bronstein: 'Bronstein', delay: 'Delay' };
  var MODE_NOTE = {
    inc: 'Increment (Fischer): the bonus is added to your clock after each move.',
    bronstein: 'Bronstein delay: after each move you get back the time you used, up to the bonus.',
    delay: 'Delay (US): each turn your clock waits for the bonus before it starts counting down.',
  };

  var I = function (d, fill) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  };
  var ICON = {
    pause: I('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>', true),
    play: I('<path d="M8 5.5v13l10.5-6.5z"/>', true),
    reset: I('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5v4.5h4.5"/>'),
    swap: I('<path d="M4 8h15l-3.5-3.5M20 16H5l3.5 3.5"/>'),
    sound: I('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/>'),
    mute: I('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M16 10l4.5 4.5M20.5 10L16 14.5"/>'),
    fs: I('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    fsExit: I('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  };

  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 1800); } catch (e) {} }
  function coarse() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }

  // ---- prefs ----
  var P = null;
  function loadPrefs() {
    var raw = null;
    try { raw = JSON.parse(Cade.store.get(PREFS_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object') raw = {};
    P = {
      cfg: Core.normCfg(raw.cfg),
      sound: raw.sound !== false, beeps: raw.beeps !== false, haptics: raw.haptics !== false, flip: raw.flip !== false,
      fs: typeof raw.fs === 'boolean' ? raw.fs : null,
    };
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(P)); } catch (e) {} }

  // ---- panel state ----
  // { panel, root, grid, sides: [{el, who, mv, time, sub}], btn: {...}, sheet, st, raf, flagT, wake, wakeP, ac,
  //   armed, sheetOpen, fs, last: {t, s, len}, beepSec }
  var ui = null;

  // ======================================================================
  // HTML
  // ======================================================================
  function sideHtml(i) {
    return '<div class="ccl-side" data-side="' + i + '" role="button">' +
      '<div class="ccl-face">' +
        '<div class="ccl-meta"><span class="ccl-who"></span><span class="ccl-mv"></span></div>' +
        '<div class="ccl-time" aria-live="off"></div>' +
        '<div class="ccl-sub"></div>' +
      '</div></div>';
  }
  function numIn(f, label) {
    return '<input class="ccl-num" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" spellcheck="false" data-f="' +
      f + '" aria-label="' + label + '">';
  }
  function rowHtml(i) {
    return '<div class="ccl-row" data-row="' + i + '"' + (i ? ' hidden' : '') + '>' +
      '<span class="ccl-rl"></span>' +
      '<span class="ccl-fld">' + numIn('m' + i, 'Minutes') + '<span class="ccl-u">min</span></span>' +
      '<span class="ccl-fld">' + numIn('s' + i, 'Seconds') + '<span class="ccl-u">s</span></span>' +
      '<span class="ccl-fld"><span class="ccl-u ccl-bl">+</span>' + numIn('i' + i, 'Bonus seconds') + '<span class="ccl-u">s</span></span>' +
    '</div>';
  }
  function ck(o, label) { return '<label class="ccl-ck"><input type="checkbox" data-o="' + o + '"> <span>' + label + '</span></label>'; }
  function sheetHtml() {
    var groups = Core.PRESET_GROUPS.map(function (g) {
      return '<div class="ccl-pg"><span class="ccl-pgl">' + g.name + '</span><div class="ccl-chips">' +
        g.list.map(function (id) { return '<button type="button" class="ccl-chip" data-preset="' + id + '">' + id + '</button>'; }).join('') +
        '</div></div>';
    }).join('');
    return '<div class="ccl-sh">' +
      '<div class="ccl-sh-head"><b>Time control</b><span class="ccl-sp"></span>' +
        '<button type="button" class="ccl-btn" data-act="sheet-close">Done</button></div>' +
      '<div class="ccl-presets">' + groups + '</div>' +
      '<div class="ccl-sec"><b class="ccl-h">Custom</b>' +
        '<div class="ccl-seg" role="group" aria-label="Bonus type">' + Core.MODES.map(function (m) {
          return '<button type="button" data-mode="' + m + '">' + MODE_LABEL[m] + '</button>';
        }).join('') + '</div>' +
        rowHtml(0) +
        '<label class="ccl-ck"><input type="checkbox" data-f="hc"> <span>Different time for each side</span></label>' +
        rowHtml(1) +
        '<p class="ccl-note"></p>' +
        '<div><button type="button" class="ccl-btn primary" data-act="apply">Set clock</button></div>' +
      '</div>' +
      '<div class="ccl-sec"><b class="ccl-h">Options</b>' +
        ck('sound', 'Sound — a click on each press') +
        ck('beeps', 'Beep each second in the last 10 s') +
        ck('haptics', 'Vibrate (where the device can)') +
        ck('flip', 'Turn the top clock around when the halves stack') +
      '</div>' +
      '<p class="ccl-keys"><kbd>Space</kbd> press for the side to move · <kbd>A</kbd> / <kbd>L</kbd> left / right player · <kbd>P</kbd> pause · <kbd>R</kbd> reset</p>' +
    '</div>';
  }
  function bodyHtml() {
    return '<div class="ccl" tabindex="-1">' +
      '<div class="ccl-grid">' + sideHtml(0) +
        '<div class="ccl-bar" role="toolbar" aria-label="Clock controls">' +
          '<button type="button" class="ccl-b ccl-tc" data-act="sheet" title="Time control & options"></button>' +
          '<button type="button" class="ccl-b" data-act="pause" title="Pause (P)" aria-label="Pause"></button>' +
          '<button type="button" class="ccl-b" data-act="reset" title="Reset (R) — tap twice" aria-label="Reset">' + ICON.reset + '</button>' +
          '<button type="button" class="ccl-b" data-act="swap" title="Swap sides" aria-label="Swap sides">' + ICON.swap + '</button>' +
          '<button type="button" class="ccl-b" data-act="sound" title="Sound" aria-label="Sound"></button>' +
        '</div>' +
        sideHtml(1) + '</div>' +
      '<div class="ccl-sheet" hidden>' + sheetHtml() + '</div>' +
    '</div>';
  }

  // ======================================================================
  // Open / close
  // ======================================================================
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    loadPrefs();
    var st = null;
    try { st = Core.restore(JSON.parse(Cade.store.get(GAME_KEY) || 'null'), Date.now(), GAME_MAX_AGE); } catch (e) { st = null; }
    var restored = !!st;
    if (!st) { st = Core.create(P.cfg); try { Cade.store.remove(GAME_KEY); } catch (e) {} }

    var p = Cade.mkPanel(PANEL_ID, '♟ Chess Clock', bodyHtml());
    var q = function (s) { return p.querySelector(s); };
    var hb = document.createElement('button');
    hb.type = 'button';
    hb.className = 'ccl-hbtn';
    hb.setAttribute('data-act', 'fs');
    var head = q('.cade-panel-head');
    if (head) head.insertBefore(hb, q('.cade-panel-minbtn') || q('.cade-panel-x'));
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); }); // a control, not a drag handle

    ui = {
      panel: p, root: q('.ccl'), sheet: q('.ccl-sheet'), st: st, raf: 0, flagT: 0, wake: null, wakeP: false, ac: null,
      armed: null, sheetOpen: false, fs: false, last: { t: ['', ''], s: ['', ''], len: ['', ''] }, beepSec: Infinity,
      sides: [0, 1].map(function (i) {
        var el = q('.ccl-side[data-side="' + i + '"]');
        return { el: el, who: el.querySelector('.ccl-who'), mv: el.querySelector('.ccl-mv'), time: el.querySelector('.ccl-time'), sub: el.querySelector('.ccl-sub') };
      }),
      btn: { tc: q('[data-act="sheet"]'), pause: q('[data-act="pause"]'), reset: q('[data-act="reset"]'), swap: q('[data-act="swap"]'), sound: q('[data-act="sound"]'), fs: hb },
    };
    ui.sides.forEach(function (s, i) { s.el.addEventListener('pointerdown', function (e) { onSideDown(e, i); }); });
    p.addEventListener('pointerdown', onPanelDown, true);
    p.addEventListener('pointerup', onPanelUp);
    p.addEventListener('click', onClick);
    p.addEventListener('change', onChange);
    p.addEventListener('contextmenu', onContext);
    p.addEventListener('cade-panel-minimize', onMin);
    p.addEventListener('cade-panel-restore', onShow);
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onPageHide);
    p._onClose = teardown;

    setFs(P.fs == null ? window.innerWidth < 600 && coarse() : P.fs);
    render();
    if (restored) toast('Game restored — paused. Tap ▶ to resume.', 'info', 2600);
    if (!coarse()) setTimeout(function () { if (ui && ui.panel === p) focusRoot(); }, 0);
  }
  function teardown() {
    if (!ui) return;
    var u = ui;
    ui = null;
    if (u.raf) cancelAnimationFrame(u.raf);
    clearTimeout(u.flagT);
    if (u.armed) clearTimeout(u.armed.t);
    wakeRelease(u);
    if (u.ac) { try { var r = u.ac.close(); if (r && r.catch) r.catch(function () {}); } catch (e) {} u.ac = null; }
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pagehide', onPageHide);
    try { Cade.store.remove(GAME_KEY); } catch (e) {} // closing the clock ends the game
  }
  function close() {
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    teardown();
  }
  function alive() {
    if (!ui) return false;
    if (!ui.panel.isConnected) { teardown(); return false; } // removed without the × (room switch …)
    return true;
  }
  function minimized() { return !!(Cade.isMinimized && Cade.isMinimized(ui.panel)); }
  function onScreen() { return !document.hidden && !minimized(); }
  function focusRoot() { try { if (document.activeElement !== ui.root) ui.root.focus({ preventScroll: true }); } catch (e) {} }

  function setFs(on) {
    ui.fs = !!on;
    ui.panel.classList.toggle('ccl-fs', ui.fs);
    var b = ui.btn.fs, t = ui.fs ? 'Exit full screen' : 'Full screen';
    b.innerHTML = ui.fs ? ICON.fsExit : ICON.fs;
    b.title = t; b.setAttribute('aria-label', t);
  }

  // ======================================================================
  // Clock actions
  // ======================================================================
  function press(i) {
    if (!alive() || ui.sheetOpen) return;
    var st = ui.st, now = performance.now(), r = Core.press(st, i, now);
    if (r === 'ignored') return;
    if (r === 'flag') { flagged(); return; }
    disarm();
    if (P.sound) { ensureAudio(); sClick(); }
    if (P.haptics) { try { Cade.haptic(12); } catch (e) {} }
    ui.beepSec = Math.ceil(Core.left(st, st.turn, now) / 1000);
    saveGame(now);
    syncRun();
    render();
  }
  function togglePause() {
    if (!alive()) return;
    var st = ui.st, now = performance.now();
    if (st.running) { if (Core.pause(st, now) === 'flag') { flagged(); return; } }
    else if (Core.resume(st, now) === 'resumed') { ui.beepSec = Math.ceil(Core.left(st, st.turn, now) / 1000); if (P.sound) ensureAudio(); }
    else return;
    disarm();
    saveGame(now);
    syncRun();
    render();
  }
  function resetTap() {
    if (!alive()) return;
    var st = ui.st;
    if (st.turn < 0) return; // nothing to reset
    arm('reset', ui.btn.reset, 'Reset?', function () {
      ui.st = Core.create(st.cfg);
      saveGame(performance.now());
      syncRun();
      render();
    });
  }
  function swapSides() {
    if (!alive() || !Core.swap(ui.st)) return;
    disarm();
    P.cfg = ui.st.cfg; // a handicap stays with its player
    savePrefs();
    saveGame(performance.now());
    render();
  }
  function applyCfg(cfg) {
    P.cfg = Core.normCfg(cfg);
    savePrefs();
    ui.st = Core.create(P.cfg);
    saveGame(performance.now());
    syncRun();
    closeSheet();
    render();
  }
  // The running state changed: frames, the flag timeout, the wake lock and the audio follow it.
  function syncRun() {
    var st = ui.st;
    clearTimeout(ui.flagT); ui.flagT = 0;
    if (st.running) {
      var ms = Core.toFlag(st, performance.now());
      ui.flagT = setTimeout(onFlagTimer, Math.max(0, Math.ceil(ms)) + 4);
      if (onScreen()) { wakeAcquire(); kick(); }
    } else {
      stopLoop();
      wakeRelease(ui);
      if (st.flag < 0) suspendAudio();
    }
  }
  function onFlagTimer() {
    if (!alive()) return;
    ui.flagT = 0;
    if (Core.tick(ui.st, performance.now())) flagged();
    else syncRun(); // fired a hair early: aim again
  }
  function flagged() {
    clearTimeout(ui.flagT); ui.flagT = 0;
    stopLoop();
    wakeRelease(ui);
    disarm();
    saveGame(performance.now());
    if (P.sound) { ensureAudio(); sFlag(); }
    if (P.haptics) { try { Cade.haptic(400); } catch (e) {} }
    render();
  }
  function saveGame(now) {
    var st = ui.st;
    try {
      if (Core.inProgress(st)) Cade.store.set(GAME_KEY, JSON.stringify(Core.snapshot(st, now, Date.now())));
      else Cade.store.remove(GAME_KEY);
    } catch (e) {}
  }

  // "Tap again to confirm" on a button (reset, a new time control mid-game).
  function arm(key, btn, label, fn) {
    var a = ui.armed;
    if (a && a.key === key && a.btn === btn) { disarm(); fn(); return; }
    disarm();
    ui.armed = { key: key, btn: btn, html: btn.innerHTML, t: setTimeout(disarm, ARM_MS) };
    btn.classList.add('armed');
    btn.textContent = label;
  }
  function disarm() {
    var a = ui && ui.armed;
    if (!a) return;
    clearTimeout(a.t);
    ui.armed = null;
    a.btn.classList.remove('armed');
    a.btn.innerHTML = a.html;
  }

  // ======================================================================
  // Rendering
  // ======================================================================
  function render() {
    if (!ui) return;
    var st = ui.st, root = ui.root, started = st.turn >= 0, over = st.flag >= 0, hc = Core.handicap(st.cfg);
    root.classList.toggle('started', started);
    root.classList.toggle('paused', Core.paused(st));
    root.classList.toggle('over', over);
    root.classList.toggle('ccl-flip', !!P.flip);
    for (var i = 0; i < 2; i++) {
      var s = ui.sides[i], el = s.el;
      el.classList.toggle('active', started && !over && st.turn === i);
      el.classList.toggle('waiting', started && !over && st.turn !== i);
      el.classList.toggle('flag', st.flag === i);
      el.classList.toggle('win', over && st.flag !== i);
      s.who.textContent = started ? (st.first === i ? 'White' : 'Black') : (hc ? Core.sideShort(st.cfg, i) : '');
      s.mv.textContent = started ? st.moves[i] + (st.moves[i] === 1 ? ' move' : ' moves') : '';
      el.setAttribute('aria-label', (i ? 'Right / bottom' : 'Left / top') + ' player — tap when you have moved');
    }
    paint(performance.now(), true);
    var b = ui.btn, pausedNow = Core.paused(st);
    b.tc.textContent = Core.shortLabel(st.cfg);
    if (!(ui.armed && ui.armed.btn === b.pause)) {
      b.pause.innerHTML = pausedNow ? ICON.play : ICON.pause;
      b.pause.title = pausedNow ? 'Resume (P)' : 'Pause (P)';
      b.pause.setAttribute('aria-label', pausedNow ? 'Resume' : 'Pause');
    }
    b.pause.disabled = !Core.inProgress(st);
    b.pause.classList.toggle('on', pausedNow);
    b.reset.disabled = !started;
    b.swap.disabled = st.running;
    b.sound.innerHTML = P.sound ? ICON.sound : ICON.mute;
    b.sound.title = P.sound ? 'Sound on' : 'Sound off';
    b.sound.classList.toggle('off', !P.sound);
  }
  // The digits and the line under them; the DOM is touched only when they change.
  function paint(now, force) {
    var st = ui.st, started = st.turn >= 0, L = ui.last;
    for (var i = 0; i < 2; i++) {
      var s = ui.sides[i], ms = Core.left(st, i, now), t = Core.fmt(ms);
      if (force || t !== L.t[i]) {
        s.time.textContent = t;
        L.t[i] = t;
        var len = t.length <= 5 ? '5' : String(Math.min(7, t.length));
        if (len !== L.len[i]) { s.time.setAttribute('data-len', len); L.len[i] = len; }
        s.el.classList.toggle('low', started && st.flag < 0 && ms <= Core.lowAt(st.cfg, i));
      }
      var sub = '';
      if (st.flag === i) sub = 'Time’s up';
      else if (st.flag >= 0) sub = 'Wins on time';
      else if (!started) sub = 'Black taps to start';
      else if (st.turn === i) {
        if (!st.running) sub = 'Paused';
        else if (st.cfg.mode === 'delay') { var d = Core.delayLeft(st, now); if (d > 0) sub = 'delay ' + (Math.ceil(d / 100 - 1e-9) / 10).toFixed(1) + ' s'; }
      }
      if (force || sub !== L.s[i]) { s.sub.textContent = sub; L.s[i] = sub; }
    }
  }
  function kick() { if (ui && !ui.raf && ui.st.running && onScreen()) ui.raf = requestAnimationFrame(frame); }
  function stopLoop() { if (ui && ui.raf) { cancelAnimationFrame(ui.raf); ui.raf = 0; } }
  function frame() {
    if (!ui) return;
    ui.raf = 0;
    if (!alive()) return;
    var st = ui.st, now = performance.now();
    if (!st.running || !onScreen()) return;
    if (Core.tick(st, now)) { flagged(); return; }
    paint(now, false);
    if (P.sound && P.beeps) {
      var sec = Math.ceil(Core.left(st, st.turn, now) / 1000);
      if (sec < ui.beepSec && sec >= 1 && sec <= 10) sBeep();
      ui.beepSec = sec;
    }
    ui.raf = requestAnimationFrame(frame);
  }

  // ======================================================================
  // Events
  // ======================================================================
  function onSideDown(e, i) {
    if (e.button > 0 || !alive()) return;
    e.preventDefault(); // react on the way down; no focus change, no emulated mouse events
    focusRoot();
    press(i);
  }
  function onPanelDown(e) {
    if (!alive()) return;
    var t = e.target;
    // Full screen: the header is not a drag handle.
    if (ui.fs && t.closest && t.closest('.cade-panel-head') && !t.closest('.ccl-hbtn')) {
      if (!(t.classList && (t.classList.contains('cade-panel-x') || t.classList.contains('cade-panel-minbtn')))) e.stopPropagation();
    }
    if (t.closest && t.closest('.ccl-bar')) focusRoot();
  }
  // iOS unlocks audio on a touch's pointerup (not its pointerdown).
  function onPanelUp() { if (alive() && P.sound && (ui.st.running || ui.st.flag >= 0)) ensureAudio(); }
  function onContext(e) { if (e.target.closest && e.target.closest('.ccl-side')) e.preventDefault(); }
  function onClick(e) {
    if (!alive()) return;
    var t = e.target, b = t.closest ? t.closest('[data-act],[data-preset],[data-mode]') : null;
    if (!b || !ui.panel.contains(b)) return;
    var act = b.getAttribute('data-act');
    if (b.hasAttribute('data-preset')) { presetTap(b); return; }
    if (b.hasAttribute('data-mode')) { ui.formMode = b.getAttribute('data-mode'); syncForm(); return; }
    if (act === 'pause') togglePause();
    else if (act === 'reset') resetTap();
    else if (act === 'swap') swapSides();
    else if (act === 'sound') {
      P.sound = !P.sound; savePrefs();
      if (P.sound) { ensureAudio(); sClick(); } else suspendAudio();
      render();
    }
    else if (act === 'fs') { setFs(!ui.fs); P.fs = ui.fs; savePrefs(); }
    else if (act === 'sheet') openSheet();
    else if (act === 'sheet-close') closeSheet();
    else if (act === 'apply') applyCustom(b);
  }
  function onChange(e) {
    if (!alive()) return;
    var t = e.target, o = t.getAttribute('data-o');
    if (o) {
      P[o] = !!t.checked; savePrefs();
      if (o === 'sound') { if (P.sound) ensureAudio(); else suspendAudio(); }
      render();
    } else if (t.getAttribute('data-f') === 'hc') syncForm();
  }
  function focusOk() {
    var ae = document.activeElement;
    if (!ae || ae === document.body || ae === document.documentElement) return true;
    if (!ui.panel.contains(ae)) return false;             // the editor or another panel has the keyboard
    return !(ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName));
  }
  function onKey(e) {
    if (!alive() || minimized()) return;                 // parked in the dock: keys belong to the editor
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    var k = e.key;
    if (ui.sheetOpen) {                                  // the settings form has the keys; Esc closes it
      if (k === 'Escape' && (focusOk() || ui.sheet.contains(document.activeElement))) { e.preventDefault(); closeSheet(); }
      return;
    }
    if (!focusOk()) return;
    if (k === ' ' || k === 'Spacebar') { if (!e.repeat) press(ui.st.turn >= 0 ? ui.st.turn : 1); }
    else if (k === 'a' || k === 'A') { if (!e.repeat) press(0); }
    else if (k === 'l' || k === 'L') { if (!e.repeat) press(1); }
    else if (k === 'p' || k === 'P') { if (!e.repeat) togglePause(); }
    else if (k === 'r' || k === 'R') { if (!e.repeat) resetTap(); }
    else return;
    e.preventDefault();
    e.stopPropagation();
    focusRoot(); // off any focused button, so its keyup can't "click" it
  }
  function onVis() {
    if (!alive()) return;
    var now = performance.now();
    if (document.hidden) { stopLoop(); if (Core.inProgress(ui.st)) saveGame(now); return; } // the browser drops the wake lock
    onShow();
  }
  function onShow() {
    if (!alive() || !onScreen()) return;
    var st = ui.st, now = performance.now();
    if (st.running && Core.tick(st, now)) { flagged(); return; }
    if (st.running) ui.beepSec = Math.ceil(Core.left(st, st.turn, now) / 1000);
    render();
    if (st.running) { wakeAcquire(); kick(); }
  }
  function onMin() { if (!alive()) return; stopLoop(); wakeRelease(ui); }
  function onPageHide() { if (alive() && Core.inProgress(ui.st)) saveGame(performance.now()); }

  // ======================================================================
  // Settings sheet
  // ======================================================================
  function openSheet() {
    if (!alive()) return;
    if (ui.st.running) togglePause();
    disarm();
    var cfg = ui.st.cfg, f = ui.sheet;
    ui.formMode = cfg.mode;
    for (var i = 0; i < 2; i++) {
      var s = cfg.sides[i], sec = Math.round(s.base / 1000);
      f.querySelector('[data-f="m' + i + '"]').value = String(Math.floor(sec / 60));
      f.querySelector('[data-f="s' + i + '"]').value = String(sec % 60);
      f.querySelector('[data-f="i' + i + '"]').value = String(Math.round(s.inc / 1000));
    }
    f.querySelector('[data-f="hc"]').checked = Core.handicap(cfg);
    ['sound', 'beeps', 'haptics', 'flip'].forEach(function (o) { f.querySelector('[data-o="' + o + '"]').checked = !!P[o]; });
    var pid = Core.presetOf(cfg);
    f.querySelectorAll('[data-preset]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-preset') === pid); });
    syncForm();
    f.hidden = false;
    f.scrollTop = 0;
    ui.sheetOpen = true;
  }
  function closeSheet() {
    if (!ui || !ui.sheetOpen) return;
    disarm();
    ui.sheet.hidden = true;
    ui.sheetOpen = false;
    focusRoot();
  }
  function syncForm() {
    var f = ui.sheet, hc = f.querySelector('[data-f="hc"]').checked, m = ui.formMode;
    f.querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === m); });
    f.querySelector('[data-row="1"]').hidden = !hc;
    f.querySelector('[data-row="0"] .ccl-rl').textContent = hc ? 'Left / top' : 'Time';
    f.querySelector('[data-row="1"] .ccl-rl').textContent = 'Right / bottom';
    f.querySelectorAll('.ccl-bl').forEach(function (el) { el.textContent = m === 'inc' ? '+' : 'delay'; });
    f.querySelector('.ccl-note').textContent = MODE_NOTE[m];
  }
  function presetTap(b) {
    var id = b.getAttribute('data-preset'), cfg = Core.presetCfg(id);
    if (!cfg) return;
    if (Core.inProgress(ui.st)) arm('preset', b, 'New game?', function () { applyCfg(cfg); });
    else applyCfg(cfg);
  }
  function applyCustom(b) {
    var f = ui.sheet, hc = f.querySelector('[data-f="hc"]').checked, sides = [];
    for (var i = 0; i < (hc ? 2 : 1); i++) {
      var v = function (k) { var n = parseInt(f.querySelector('[data-f="' + k + i + '"]').value, 10); return isFinite(n) && n > 0 ? n : 0; };
      var base = (v('m') * 60 + v('s')) * 1000;
      if (base < Core.MIN_BASE) { toast('Give ' + (hc ? (i ? 'the right / bottom player' : 'the left / top player') : 'each side') + ' at least a second', 'error', 2400); return; }
      sides.push({ base: Math.min(base, Core.MAX_BASE), inc: Math.min(v('i') * 1000, Core.MAX_INC) });
    }
    var cfg = Core.normCfg({ mode: ui.formMode || 'inc', sides: sides });
    if (Core.inProgress(ui.st)) arm('apply', b, 'Tap again — ends this game', function () { applyCfg(cfg); });
    else applyCfg(cfg);
  }

  // ======================================================================
  // Platform: wake lock, sound
  // ======================================================================
  function wakeAcquire() {
    if (!ui || ui.wake || ui.wakeP || !navigator.wakeLock || !navigator.wakeLock.request || document.visibilityState !== 'visible') return;
    var u = ui;
    u.wakeP = true;
    try {
      navigator.wakeLock.request('screen').then(function (lock) {
        u.wakeP = false;
        if (ui !== u || !u.st.running || !onScreen()) { try { lock.release(); } catch (e) {} return; }
        u.wake = lock;
        lock.addEventListener('release', function () { if (u.wake === lock) u.wake = null; });
      }, function () { u.wakeP = false; /* denied (battery saver …): the screen may dim */ });
    } catch (e) { u.wakeP = false; }
  }
  function wakeRelease(u) {
    if (u && u.wake) { var l = u.wake; u.wake = null; try { var r = l.release(); if (r && r.catch) r.catch(function () {}); } catch (e) {} }
  }
  function ensureAudio() {
    if (!ui || !P.sound) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      if (!ui.ac) ui.ac = new AC();
      if (ui.ac.state !== 'running') { var r = ui.ac.resume(); if (r && r.catch) r.catch(function () {}); }
    } catch (e) {}
  }
  function suspendAudio() {
    if (ui && ui.ac && ui.ac.state === 'running') { try { var r = ui.ac.suspend(); if (r && r.catch) r.catch(function () {}); } catch (e) {} }
  }
  // Scheduled on a context that is still resuming (the first press), it plays as soon as it runs.
  function tone(freq, dur, type, vol, at) {
    var ac = ui && ui.ac;
    if (!ac || ac.state === 'closed') return null;
    try {
      var t = ac.currentTime + (at || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.02);
      return o;
    } catch (e) { return null; }
  }
  function sClick() { tone(2200, 0.03, 'square', 0.05); tone(1100, 0.05, 'sine', 0.12); }
  function sBeep() { tone(880, 0.09, 'sine', 0.16); }
  function sFlag() {
    tone(784, 0.2, 'triangle', 0.22);
    tone(587, 0.2, 'triangle', 0.22, 0.22);
    var o = tone(392, 0.5, 'triangle', 0.22, 0.44);
    if (o) o.onended = function () { if (ui && !ui.st.running) suspendAudio(); };
  }

  Cade.registerWidget({
    name: 'Chess Clock',
    description: 'Two-player game clock — tap your side after you move; increment, Bronstein or delay, handicap, full screen for the table',
    icon: '♟️',
    tags: 'chess,chess clock,clock,game clock,timer,blitz,bullet,rapid,classical,increment,fischer,bronstein,delay,handicap,two player,board game,go,shogi,scrabble,turn timer',
    open: open,
    close: close,
  });
})();
