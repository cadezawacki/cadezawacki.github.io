/* Dangerous Mode — core: settings, the session state machine, word counting,
 * the fade curve and how the session region follows edits. Pure ES5, no DOM:
 * window.__cadeDanger in the browser, module.exports in node
 * (txt/widgets/danger/danger.test.js).
 *
 * ---- The session ----
 *   armed ──first edit──▶ typing ──idle ≥ FADE_START·grace──▶ fading
 *     ▲                     ▲  └────────────── next edit ◀──────┘
 *     └── page hidden ──────┘   (normal mode only: the clock pauses and
 *                                waits for the next edit; hardcore keeps it)
 *   typing / fading ──idle ≥ grace──▶ wiped
 *   any live phase ──goal reached──▶ kept     ──Stop / room switch…──▶ stopped
 * Time is passed in (ev.now, ms), so every transition is testable. nextAt()
 * is the one moment the UI must wake up for (fade start, wipe, time goal, or
 * the next countdown second), so it needs a single timer, no polling.
 *
 * ---- Words ----
 * Same rule as the app's footer: runs of anything but space, \n, \t, \r, \f.
 * recount() redoes only the words a change touched (the change widened to
 * the whitespace around it) and falls back to a full count of the region.
 *
 * ---- The region ----
 * Two layers, both mapped through every change. The session AREA is one range
 * [from, to]: it starts at the caret, grows with your typing (and undo/redo)
 * at its edges, and is what the word count and "is this typing part of the
 * session" go by — typing elsewhere doesn't count. The PIECES are the parts of
 * it your own typing inserted; only they fade and only they are deleted, so a
 * wipe can never take text that wasn't typed in this session (text an undo
 * brings back, or sync writes, is never a piece). A change from elsewhere that
 * edits the inside of the area is a conflict: the UI ends the session and
 * keeps everything. */
(function (root) {
  'use strict';

  var WORD_CHOICES = [100, 250, 500], TIME_CHOICES = [3, 5, 10], GRACE_CHOICES = [3, 5, 8];
  var DEFAULTS = { kind: 'words', words: 250, minutes: 5, grace: 5, hardcore: false };
  var LIMITS = { words: [10, 10000], minutes: [1, 180], grace: [1, 60] };
  // Text stays crisp for the first 40% of the grace, then fades to 0.15; the
  // banner's drain bar pulses through the last quarter. The CSS uses the same
  // fractions (danger.js hands them over as custom properties).
  var FADE_START = 0.4, MIN_OPACITY = 0.15, PULSE_AT = 0.75;
  var WINDOW = 256;   // recount(): how far to look for the whitespace around a change

  function num(v) { var n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && isFinite(n) ? n : NaN; }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  // ================= settings =================
  // Anything in → a usable settings object (bad values fall back / clamp).
  function validate(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var w = num(raw.words), m = num(raw.minutes), g = num(raw.grace);
    return {
      kind: raw.kind === 'time' ? 'time' : 'words',
      words: isNaN(w) ? DEFAULTS.words : Math.round(clamp(w, LIMITS.words[0], LIMITS.words[1])),
      minutes: isNaN(m) ? DEFAULTS.minutes : Math.round(clamp(m, LIMITS.minutes[0], LIMITS.minutes[1])),
      grace: isNaN(g) ? DEFAULTS.grace : Math.round(clamp(g, LIMITS.grace[0], LIMITS.grace[1]) * 10) / 10,
      hardcore: raw.hardcore === true
    };
  }
  // A custom goal typed by hand: '' when fine, else what's wrong (for the panel).
  function checkCustom(kind, v) {
    var n = num(v), lim = LIMITS[kind === 'time' ? 'minutes' : 'words'], unit = kind === 'time' ? 'minutes' : 'words';
    if (isNaN(n)) return 'Enter a number of ' + unit;
    if (n < lim[0]) return 'At least ' + lim[0] + ' ' + (lim[0] === 1 ? unit.replace(/s$/, '') : unit);
    if (n > lim[1]) return 'At most ' + lim[1].toLocaleString('en-US') + ' ' + unit;
    return '';
  }
  function goalOf(s) {
    return s.kind === 'time' ? { kind: 'time', target: s.minutes * 60000 } : { kind: 'words', target: s.words };
  }
  function fmtSecs(sec) { return (Math.round(sec * 10) / 10) + ' s'; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function goalText(s) { return s.kind === 'time' ? plural(s.minutes, 'minute', 'minutes') : plural(s.words, 'word', 'words'); }
  // The plain-language promise shown above Start.
  function summary(s) {
    return 'Stop typing for ' + fmtSecs(s.grace) + ' and everything you write this session is deleted. ' +
      (s.kind === 'time' ? 'Keep going for ' + goalText(s) + ' to keep it.' : 'Reach ' + goalText(s) + ' to keep it.');
  }
  function modeNote(s) {
    return s.hardcore
      ? 'Hardcore: no undo after a wipe, and the clock keeps running if you leave the app.'
      : 'If it happens, Ctrl+Z / ⌘Z brings it back. Leaving the app pauses the clock.';
  }

  // ================= words =================
  function isWs(c) { return c === 32 || c === 10 || c === 9 || c === 13 || c === 12; }
  // st (optional) carries { n, inWord } across chunks, so a document can be
  // counted piece by piece without building one big string.
  function countWords(s, st) {
    var n = st ? st.n : 0, inWord = st ? st.inWord : false;
    for (var i = 0; i < s.length; i++) {
      if (isWs(s.charCodeAt(i))) inWord = false;
      else if (!inWord) { n++; inWord = true; }
    }
    if (st) { st.n = n; st.inWord = inWord; }
    return n;
  }
  function envelope(changes) {
    var e = { a0: Infinity, a1: -1, b0: Infinity, b1: -1 };
    for (var i = 0; i < changes.length; i++) {
      var c = changes[i];
      if (c.fromA < e.a0) e.a0 = c.fromA;
      if (c.toA > e.a1) e.a1 = c.toA;
      if (c.fromB < e.b0) e.b0 = c.fromB;
      if (c.toB > e.b1) e.b1 = c.toB;
    }
    return e;
  }
  // Words in the region after a change.
  //   o.words: before; o.oldR / o.newR: the region before / after; o.changes:
  //   [{ fromA, toA, fromB, toB }]; o.oldSlice / o.newSlice(from, to): text of
  //   the old / new document; o.count(from, to): full count in the new one.
  function recount(o) {
    var ch = o.changes, oR = o.oldR, nR = o.newR;
    if (!ch.length) return o.words;
    var e = envelope(ch);
    // Entirely before or after the region (not touching it): nothing to do.
    if ((e.a1 < oR.from || e.a0 > oR.to) && (e.b1 < nR.from || e.b0 > nR.to) &&
        nR.to - nR.from === oR.to - oR.from) return o.words;
    // Local recount only when the change sits inside the region and the text
    // on both sides of it is untouched.
    if (!(oR.from <= e.a0 && e.a1 <= oR.to && nR.from === oR.from && nR.from <= e.b0 &&
          e.b1 <= nR.to && oR.to - e.a1 === nR.to - e.b1)) return o.count(nR.from, nR.to);
    var lf = Math.max(oR.from, e.a0 - WINDOW), left = o.oldSlice(lf, e.a0), L = e.a0;
    while (L > lf && !isWs(left.charCodeAt(L - 1 - lf))) L--;
    if (L === lf && lf > oR.from) return o.count(nR.from, nR.to);     // one very long word
    var rt = Math.min(oR.to, e.a1 + WINDOW), right = o.oldSlice(e.a1, rt), R = e.a1;
    while (R < rt && !isWs(right.charCodeAt(R - e.a1))) R++;
    if (R === rt && rt < oR.to) return o.count(nR.from, nR.to);
    return o.words - countWords(o.oldSlice(L, R)) + countWords(o.newSlice(L, e.b1 + (R - e.a1)));
  }

  // ================= the region =================
  // Who made a change:
  //   'typing'  — input.* / delete.* (and, when a key or tap just happened, a
  //               change with no label: list Enter, renumbering, toolbar)
  //   'history' — your edits that put existing text back or move it: undo,
  //               redo, drag-and-drop (move.*)
  //   'foreign' — sync / another device, anything else
  function classify(userEvent, remote, recentGesture) {
    if (remote) return 'foreign';
    var u = typeof userEvent === 'string' ? userEvent : '';
    if (/^(input|delete)(\.|$)/.test(u)) return 'typing';
    if (u === 'undo' || u === 'redo' || /^move(\.|$)/.test(u)) return 'history';
    return recentGesture ? 'typing' : 'foreign';
  }
  // The session area r { from, to } through one transaction. changes as in
  // recount(); mapPos(pos, assoc) is the change set's own.
  // → { from, to, conflict, hit, moved }
  //   hit: the change touched the area   moved: it was re-anchored
  // Your typing and undo / redo grow it at the edges (so the caret stays in it
  // after an undo at the end); changes from elsewhere don't, and editing its
  // inside from elsewhere is a conflict. Boundaries are handled explicitly:
  // CodeMirror maps a position at the edge of a replaced range past the new
  // text whatever its assoc.
  function mapRegion(r, changes, mapPos, kind) {
    var incl = kind !== 'foreign', i, c;
    var f = mapPos(r.from, incl ? -1 : 1), t = mapPos(r.to, incl ? 1 : -1);
    for (i = 0; i < changes.length; i++) {
      c = changes[i];
      var atFrom = c.fromA <= r.from && r.from <= c.toA, atTo = c.fromA <= r.to && r.to <= c.toA;
      if (incl) { if (atFrom) f = Math.min(f, c.fromB); if (atTo) t = Math.max(t, c.toB); }
      else if (c.toB > c.fromB) { if (atFrom) f = Math.max(f, c.toB); if (atTo) t = Math.min(t, c.fromB); }
    }
    if (f > t) f = t;
    var out = { from: f, to: t, conflict: false, hit: false, moved: false };
    if (kind === 'typing' && f === t) {
      // Nothing written (yet): the session starts wherever typing happens.
      for (i = 0; i < changes.length; i++) {
        c = changes[i];
        if (c.toB > c.fromB) { out.from = c.fromB; out.to = c.toB; out.moved = out.hit = true; break; }
      }
    }
    for (i = 0; i < changes.length; i++) {
      c = changes[i];
      if (c.toB >= out.from && c.fromB <= out.to && (c.toB > c.fromB || (c.toA > c.fromA && c.toA >= r.from && c.fromA <= r.to))) out.hit = true;
      if (kind === 'foreign' && r.to > r.from) {
        // Edits the inside: deletes some of it, or inserts strictly within it.
        if (Math.max(c.fromA, r.from) < Math.min(c.toA, r.to)) out.conflict = true;
        else if (c.toB > c.fromB && c.fromA > r.from && c.fromA < r.to) out.conflict = true;
      }
    }
    return out;
  }

  // The pieces you typed in the area — the only text a wipe may delete.
  // pieces: [[from, to], …] sorted, apart; area: the area after the change
  // (mapRegion's result). Pieces never grow over existing text: they map
  // inwards at their edges, an undo / redo / sync insertion inside one is cut
  // out, and only text your own typing inserted within the area is added.
  // (Text an undo brings back still counts in the area; it just isn't wiped.)
  function addPiece(list, a, b) {
    var out = [], i = 0;
    while (i < list.length && list[i][1] < a) out.push(list[i++]);
    while (i < list.length && list[i][0] <= b) { a = Math.min(a, list[i][0]); b = Math.max(b, list[i][1]); i++; }
    out.push([a, b]);
    while (i < list.length) out.push(list[i++]);
    return out;
  }
  function cutPiece(list, a, b) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p[1] <= a || p[0] >= b) { out.push(p); continue; }
      if (p[0] < a) out.push([p[0], a]);
      if (p[1] > b) out.push([b, p[1]]);
    }
    return out;
  }
  function mapPieces(pieces, changes, mapPos, kind, area) {
    var out = [], i, c;
    for (i = 0; i < pieces.length; i++) {
      var a = mapPos(pieces[i][0], 1), b = mapPos(pieces[i][1], -1);
      if (a < b) out.push([a, b]);
    }
    for (i = 0; i < changes.length; i++) {
      c = changes[i];
      if (c.toB <= c.fromB) continue;
      if (kind !== 'typing') out = cutPiece(out, c.fromB, c.toB);
      else if (c.fromB >= area.from && c.toB <= area.to) out = addPiece(out, c.fromB, c.toB);
    }
    return out;
  }

  // ================= the session =================
  var LIVE = { armed: 1, typing: 1, fading: 1 };
  function create(settings, now) {
    var s = validate(settings);
    return {
      phase: 'armed', settings: s, goal: goalOf(s), words: 0,
      startedAt: now == null ? null : now,   // when Start was pressed
      firstAt: null,      // first edit
      lastAt: null,       // last edit while the clock runs (null: not running)
      runFrom: null,      // start of the current counting stretch (time goals)
      activeMs: 0,        // counted time before that stretch
      paused: false,      // waiting after the page was hidden (normal mode)
      endedAt: null, reason: null
    };
  }
  function copy(st) { var o = {}; for (var k in st) if (Object.prototype.hasOwnProperty.call(st, k)) o[k] = st[k]; return o; }
  function isLive(st) { return !!LIVE[st.phase]; }
  function graceMs(st) { return st.settings.grace * 1000; }
  function running(st) { return isLive(st) && st.lastAt != null; }
  function idleMs(st, now) { return running(st) ? Math.max(0, now - st.lastAt) : 0; }
  function elapsedMs(st, now) {
    var end = isLive(st) ? now : st.endedAt;
    return st.activeMs + (st.runFrom != null && end != null ? Math.max(0, end - st.runFrom) : 0);
  }
  function wipeAt(st) { return running(st) ? st.lastAt + graceMs(st) : null; }
  function fadeAt(st) { return running(st) ? st.lastAt + graceMs(st) * FADE_START : null; }
  function goalAt(st) { return st.goal.kind === 'time' && running(st) && st.runFrom != null ? st.runFrom + (st.goal.target - st.activeMs) : null; }

  function end(t, phase, at, reason) {
    if (t.runFrom != null) { t.activeMs += Math.max(0, at - t.runFrom); t.runFrom = null; }
    t.phase = phase; t.endedAt = at; t.reason = reason; t.lastAt = null;
    return t;
  }
  // Apply whatever deadline has passed by `now` (earliest first; a tie keeps).
  function settle(t, now) {
    if (!running(t)) return t;
    var w = wipeAt(t), g = goalAt(t);
    if (g != null && g <= now && g <= w) { end(t, 'kept', g, 'goal'); t.activeMs = t.goal.target; return t; }
    if (w <= now) return end(t, 'wiped', w, 'idle');
    t.phase = now >= fadeAt(t) ? 'fading' : 'typing';
    return t;
  }
  function checkGoal(t, now) {
    if (!isLive(t)) return t;
    if (t.goal.kind === 'words' ? t.words >= t.goal.target : (t.firstAt != null && elapsedMs(t, now) >= t.goal.target)) end(t, 'kept', now, 'goal');
    return t;
  }
  // ev: { type: 'input' | 'words' | 'tick' | 'hide' | 'show' | 'stop', now, words?, reason? }
  function reduce(st, ev) {
    if (!isLive(st)) return st;
    var t = copy(st), now = ev.now;
    switch (ev.type) {
      case 'input':
        settle(t, now);                 // an edit after the deadline is too late
        if (!isLive(t)) return t;
        if (t.lastAt == null) { if (t.firstAt == null) t.firstAt = now; t.runFrom = now; t.paused = false; }
        t.lastAt = now; t.phase = 'typing';
        if (ev.words != null) t.words = ev.words;
        return checkGoal(t, now);
      case 'words':
        if (ev.words != null) t.words = ev.words;
        return checkGoal(t, now);
      case 'tick':
      case 'show':
        return settle(t, now);
      case 'hide':
        settle(t, now);
        if (!isLive(t) || t.settings.hardcore || t.lastAt == null) return t;
        t.activeMs += Math.max(0, now - t.runFrom); t.runFrom = null; t.lastAt = null;
        t.paused = true; t.phase = 'armed';
        return t;
      case 'stop':
        settle(t, now);
        return isLive(t) ? end(t, 'stopped', now, ev.reason || 'user') : t;
    }
    return t;
  }
  // The next moment anything changes, or null while nothing is pending.
  // display: also wake for each new second of a time goal's countdown.
  function nextAt(st, now, display) {
    if (!running(st)) return null;
    var c = [wipeAt(st)], g = goalAt(st);
    if (st.phase === 'typing') c.push(fadeAt(st));
    if (g != null) {
      c.push(g);
      if (display) { var rem = g - now; c.push(now + (rem % 1000 || 1000)); }
    }
    var best = null;
    for (var i = 0; i < c.length; i++) if (c[i] != null && (best == null || c[i] < best)) best = c[i];
    return best == null ? null : Math.max(now, best);
  }

  // Opacity of the session text after `idle` ms (what the CSS animates).
  function fadeLevel(idle, grace) {
    var g = grace * 1000, a = g * FADE_START;
    if (!(idle > a)) return 1;
    if (idle >= g) return MIN_OPACITY;
    return 1 - (1 - MIN_OPACITY) * (idle - a) / (g - a);
  }
  // 0 calm … 1 about to go (the frame's glow, the drain bar).
  function danger(idle, grace) { return clamp((idle || 0) / (grace * 1000), 0, 1); }

  // ================= text for the banner =================
  function fmtClock(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000)), m = Math.floor(s / 60);
    s -= m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtN(n) { return n.toLocaleString('en-US'); }
  function wordsText(n) { return fmtN(n) + (n === 1 ? ' word' : ' words'); }
  function progressText(st, now) {
    if (st.goal.kind === 'words') return fmtN(st.words) + ' / ' + fmtN(st.goal.target) + ' words';
    return fmtClock(st.goal.target - elapsedMs(st, now)) + ' left · ' + wordsText(st.words);
  }
  function hintText(st) {
    if (st.phase === 'armed') return st.paused ? 'Paused while you were away — the clock restarts when you type' : 'Start typing — the clock starts with your first word';
    if (st.phase === 'fading') return 'keep typing — it’s fading!';
    return 'stop for ' + fmtSecs(st.settings.grace) + ' and it’s gone';
  }
  function keptText(st) {
    return '✓ Kept — ' + (st.goal.kind === 'time' ? goalText(st.settings) + ' · ' : '') + wordsText(st.words);
  }
  function goneText(st) { return 'Gone — you paused for ' + fmtSecs(st.settings.grace); }

  var api = {
    WORD_CHOICES: WORD_CHOICES, TIME_CHOICES: TIME_CHOICES, GRACE_CHOICES: GRACE_CHOICES,
    DEFAULTS: DEFAULTS, LIMITS: LIMITS, FADE_START: FADE_START, MIN_OPACITY: MIN_OPACITY, PULSE_AT: PULSE_AT,
    validate: validate, checkCustom: checkCustom, goalOf: goalOf, summary: summary, modeNote: modeNote, fmtSecs: fmtSecs,
    isWs: isWs, countWords: countWords, recount: recount,
    classify: classify, mapRegion: mapRegion, mapPieces: mapPieces,
    create: create, reduce: reduce, nextAt: nextAt, isLive: isLive, running: running,
    idleMs: idleMs, elapsedMs: elapsedMs, wipeAt: wipeAt, fadeAt: fadeAt, goalAt: goalAt,
    fadeLevel: fadeLevel, danger: danger,
    fmtClock: fmtClock, wordsText: wordsText, progressText: progressText, hintText: hintText, keptText: keptText, goneText: goneText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__cadeDanger = api;
})(typeof self !== 'undefined' ? self : this);
