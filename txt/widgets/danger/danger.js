/* Dangerous Mode — keep writing or lose it.
 *
 * A first-draft mode: pick a goal (words or minutes) and a grace (3 / 5 / 8 s).
 * Stop typing for longer than the grace and what you wrote this session fades,
 * then its words are removed one at a time from the end, faster and faster
 * (the next one is marked red first); typing again stops it and keeps the
 * rest. Lose every word and it's over ("Gone"); reach the goal and it's kept.
 * Normal mode: each removal is its own undo step (Ctrl+Z / ⌘Z, or "Bring it
 * back", restores them) and leaving the app pauses the clock. Hardcore:
 * removals skip the undo history and keep going while you're away.
 *
 * While armed it is impossible to miss: a red banner under the menu bar (in
 * the page flow, so it never covers the text — also with the phone keyboard
 * pinning the body) with the progress and a drain bar; a red frame round the
 * editor that glows harder as the clock runs down; the session's text fading
 * out; "☠ " in the tab title; a "☠ ARMED" chip in the footer.
 *
 * The editor side is one extension, added with Cade.registerPlugin('danger-
 * mode') for the session and removed after: a StateField holds the session
 * area, its word count and the pieces you typed in it (danger-core.js decides
 * how they follow each edit; only the pieces are ever removed), a ViewPlugin
 * feeds edits to the session clock, and decorations / editor attributes
 * paint the fade and frame. The fading itself is CSS
 * (keyframes restarted per edit by flipping an a/b class), not per-frame JS.
 * The clock is one timer rescheduled on each edit and each removal
 * (danger-core nextAt()).
 * Nothing runs until Start; every listener, observer and timer goes at the
 * end. A room switch, the note being replaced from elsewhere or read-only
 * mode ends the session and keeps the text. The logic is pure and tested:
 * node txt/widgets/danger/danger.test.js */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var BASE = Cade.baseURL();
  Cade.loadCSS('danger.css');

  var META = {
    name: 'Dangerous Mode',
    description: 'Keep writing or lose it — set a word or time goal; stop typing for a few seconds and this session’s words start being removed from the end until you type again. Reach the goal to keep them',
    icon: '☠',
    tags: 'dangerous,danger,dangerous mode,writing,write,first draft,draft,sprint,word goal,word count,focus,flow,timer,deadline,hardcore,most dangerous writing app,productivity'
  };
  var PANEL_ID = 'danger-panel', PLUGIN_ID = 'danger-mode', PREFS_KEY = 'cade-danger-prefs';
  var SKULL = '☠ ';
  var GESTURE_MS = 600;     // a label-less edit this soon after a key / tap is the user's
  var FLIP_MS = 40;         // at most one animation restart per this long (see flip())
  var KEPT_MS = 3000, ENDED_MS = 2600, GONE_MS = 12000;

  var D = window.__cadeDanger || null;      // danger-core.js
  var S = null;                             // the live session
  var P = null, el = {};                    // the setup panel
  var prefs = null, focusBefore = null;
  var linger = null;                        // the banner after a session, briefly
  var gone = null;                          // the "Gone" card
  var seq = 0, Tr = null;

  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2200); } catch (e) {} }
  function esc(s) { return Cade.escapeHtml(String(s == null ? '' : s)); }
  function isPhone() { try { return window.matchMedia('(max-width: 600px)').matches; } catch (e) { return false; } }
  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function later(fn) { Promise.resolve().then(fn).catch(function (e) { console.error(e); }); }
  // The Transaction class isn't in Cade.CM; any state hands one out.
  function TrClass() { if (!Tr) Tr = Cade.editor.state.update({}).constructor; return Tr; }
  // A sync / other-device write: the core raises syncState.suppressUpdate
  // around those dispatches (a global binding of the main script), and a
  // remote-annotated transaction says so itself.
  function remoteNow(tr) {
    try { if (tr.annotation(TrClass().remote)) return true; } catch (e) {}
    try { return typeof syncState === 'object' && syncState !== null && !!syncState.suppressUpdate; } catch (e) { return false; }
  }

  function loadCore() {
    if (D) return Promise.resolve(D);
    if (window.__cadeDanger) { D = window.__cadeDanger; return Promise.resolve(D); }
    if (!window.__cadeDangerP) {
      window.__cadeDangerP = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = BASE + 'danger-core.js';
        s.onload = function () { if (window.__cadeDanger) { D = window.__cadeDanger; res(D); } else { window.__cadeDangerP = null; rej(new Error('missing')); } };
        s.onerror = function () { window.__cadeDangerP = null; rej(new Error('Dangerous Mode failed to load (offline?)')); };
        document.head.appendChild(s);
      });
    }
    return window.__cadeDangerP;
  }

  // ================= the editor extension (one per session) =================
  function countRange(doc, from, to) {
    var st = { n: 0, inWord: false }, it = doc.iterRange(from, to);
    while (!it.next().done) D.countWords(it.value, st);
    return st.n;
  }
  function makeExt(s0) {
    var CM = Cade.CM, Decoration = CM.Decoration, EditorView = CM.EditorView;
    var mark = Decoration.mark({ class: 'dz-text' }), doomMark = Decoration.mark({ class: 'dz-doomed' });
    // the fade over your pieces, and the word that goes next in red (kept out
    // of the faded spans so it shows at full strength)
    function deco(pieces, doom) {
      var r = (doom ? D.cutPieces(pieces, doom) : pieces).map(function (p) { return mark.range(p[0], p[1]); });
      if (doom) doom.forEach(function (p) { if (p[1] > p[0]) r.push(doomMark.range(p[0], p[1])); });
      return r.length ? Decoration.set(r, true) : Decoration.none;
    }
    function dead(v) { return !v || v.dead || s0.ended || s0.ending; }
    function mapRanges(list, m) {
      if (!list) return null;
      var out = list.map(function (p) { return [m.mapPos(p[0], 1), m.mapPos(p[1], -1)]; }).filter(function (p) { return p[1] > p[0]; });
      return out.length ? out : null;
    }
    // "this is the next word to go" (null clears it)
    var setDoom = s0.setDoom = CM.StateEffect.define({ map: function (val, m) { return mapRanges(val, m); } });

    var field = CM.StateField.define({
      // Live only in the state it was added to; a room's state rebuilt or
      // restored later gets an inert copy.
      create: function (state) {
        if (s0.created || state.doc !== s0.doc0) return { dead: true };
        s0.created = true;
        return { from: s0.anchor, to: s0.anchor, pieces: [], words: 0, seq: 0, conflict: false, doom: null, kind: null, deco: Decoration.none };
      },
      update: function (v, tr) {
        if (dead(v)) return v;
        var doom = tr.docChanged ? mapRanges(v.doom, tr.changes) : v.doom, setD = false, i;
        for (i = 0; i < tr.effects.length; i++) if (tr.effects[i].is(setDoom)) { doom = tr.effects[i].value; setD = true; }
        if (!tr.docChanged) {
          if (!setD) return v;
          return { from: v.from, to: v.to, pieces: v.pieces, words: v.words, seq: v.seq, conflict: v.conflict, doom: doom, kind: null, deco: deco(v.pieces, doom) };
        }
        var ue = tr.annotation(TrClass().userEvent);
        var kind = D.classify(ue, remoteNow(tr), Date.now() - s0.lastGesture < GESTURE_MS);
        var changes = [];
        tr.changes.iterChanges(function (fromA, toA, fromB, toB) { changes.push({ fromA: fromA, toA: toA, fromB: fromB, toB: toB }); });
        var od = tr.startState.doc, nd = tr.newDoc, mapPos = function (p, a) { return tr.changes.mapPos(p, a); };
        var r = D.mapRegion(v, changes, mapPos, kind);
        var pieces = D.mapPieces(v.pieces, changes, mapPos, kind, r);
        var words = r.moved ? countRange(nd, r.from, r.to) : D.recount({
          words: v.words, oldR: v, newR: r, changes: changes,
          oldSlice: function (f, t) { return od.sliceString(f, t); },
          newSlice: function (f, t) { return nd.sliceString(f, t); },
          count: function (f, t) { return countRange(nd, f, t); }
        });
        var yours = kind === 'typing' || kind === 'history';
        if (yours) doom = null;                          // you're back: nothing is marked to go
        return {
          from: r.from, to: r.to, pieces: pieces, words: words,
          seq: yours ? v.seq + 1 : v.seq,                // an edit by you: resets the clock (a removal doesn't)
          conflict: v.conflict || r.conflict, doom: doom, kind: kind,
          deco: deco(pieces, doom)
        };
      }
    });

    var plugin = CM.ViewPlugin.define(function (view) {
      var v = view.state.field(field, false);
      var live = !s0.bound && !dead(v);
      if (live) { s0.bound = true; s0.field = field; }
      return {
        update: function (u) { if (live) onUpdate(s0, u, field); },
        destroy: function () {
          if (!live) return;
          live = false; s0.bound = false;
          // Not us taking it out: the editor got another state (room switch,
          // the note reloaded) — end safely, keep everything.
          if (!s0.ending && !s0.ended) later(function () { endSession(s0, 'ended', 'replaced'); });
        }
      };
    });

    return [
      field, plugin,
      EditorView.decorations.of(function (view) { var v = view.state.field(field, false); return dead(v) ? Decoration.none : v.deco; }),
      EditorView.editorAttributes.of(function (view) {
        var v = view.state.field(field, false);
        if (!v || v.dead || s0.ended) return null;
        return { class: 'dz-on' + (D.running(s0.core) ? ' dz-run' : '') + (s0.core.phase === 'removing' ? ' dz-removing' : '') + (s0.parity ? ' dz-b' : ' dz-a') + (s0.settings.hardcore ? ' dz-hc' : '') };
      })
    ];
  }

  function onUpdate(s0, u, field) {
    var a = u.startState.field(field, false), b = u.state.field(field, false);
    if (!a || !b || b.dead || s0.ending || s0.removingNow) return;
    if (u.state.readOnly && !u.startState.readOnly) { later(function () { endSession(s0, 'ended', 'readonly'); }); return; }
    if (b.conflict && !a.conflict) { later(function () { endSession(s0, 'ended', 'replaced'); }); return; }
    if (b.seq !== a.seq) {
      flip(s0);
      step(s0, { type: 'input', now: Date.now(), words: b.words }, true);
    } else if (b.words !== a.words) step(s0, { type: 'words', now: Date.now(), words: b.words }, true);
  }
  // Restart the CSS fade / glow / drain: swapping between two identical sets
  // of keyframes restarts them without a forced reflow. Two edits in one task
  // (list Enter + renumbering) would swap back unseen, hence the guard.
  function flip(s0) {
    var now = Date.now();
    if (now - s0.flipAt < FLIP_MS) return;
    s0.parity ^= 1; s0.flipAt = now;
  }

  // ================= the clock =================
  // inUpdate: called from inside an editor update, where nothing may dispatch.
  function step(s0, ev, inUpdate) {
    if (s0 !== S || s0.ending) return;
    var before = s0.core;
    s0.core = D.reduce(s0.core, ev);
    var ph = s0.core.phase;
    if (ph === 'wiped' || ph === 'kept' || ph === 'stopped') {
      clearTimeout(s0.timer); s0.timer = 0;
      var kind = ph === 'wiped' ? 'wiped' : ph === 'kept' ? 'kept' : 'stopped';
      if (inUpdate) later(function () { endSession(s0, kind, s0.core.reason); });
      else endSession(s0, kind, s0.core.reason);
      return;
    }
    if (before.lastAt == null && s0.core.lastAt != null) announce(s0, 'Clock started. Keep typing.');
    if (before.phase !== 'fading' && ph === 'fading') announce(s0, 'Keep typing — it’s fading.');
    if (before.phase !== 'removing' && ph === 'removing') announce(s0, 'It’s removing your words — type to stop it.');
    if (before.phase === 'removing' && ph !== 'removing') {
      // rescued (or paused): what's left stays; Bring it back only covers the last run
      s0.run = { steps: 0, words: 0, chars: 0 };
      if (ph === 'typing') announce(s0, 'Stopped — the rest is kept.');
    }
    schedule(s0);
    render(s0);
    if (ph === 'removing' && ev.type !== 'removed') { if (inUpdate) later(function () { pump(s0); }); else pump(s0); }
  }
  // Removing: take every word that is due (one, unless a timer came late),
  // then make sure the next one is marked.
  function pump(s0) {
    var n = 0;
    while (S === s0 && !s0.ending && s0.core.phase === 'removing' && s0.core.removeAt <= Date.now() && n++ < 100000) removeOne(s0);
    if (S === s0 && !s0.ending && s0.core.phase === 'removing') markNext(s0);
  }
  function liveField(s0) {
    try { var v = s0.bound ? Cade.editor.state.field(s0.field, false) : null; return v && !v.dead ? v : null; } catch (e) { return null; }
  }
  function slicer() { var st = Cade.editor.state; return function (f, t) { return st.sliceDoc(f, t); }; }
  function sameRanges(a, b) { return JSON.stringify(a || null) === JSON.stringify(b || null); }
  function markNext(s0) {
    var v = liveField(s0);
    if (!v) return;
    var r = D.removeRange(v.pieces, slicer()), want = r ? r.ranges : null;
    if (!sameRanges(want, v.doom)) { try { Cade.editor.dispatch({ effects: s0.setDoom.of(want) }); } catch (e) { console.error(e); } }
  }
  function removeOne(s0) {
    var ed = Cade.editor, v = liveField(s0);
    var r = v ? D.removeRange(v.pieces, slicer()) : null;
    if (!r) { step(s0, { type: 'removed', now: Date.now(), words: s0.core.words, left: false }, false); return; }
    var slice = slicer(), next = r.last ? null : D.removeRange(D.cutPieces(v.pieces, r.ranges), slice);
    var sel = ed.state.selection.main, end = r.ranges[r.ranges.length - 1][1], words = 0, chars = 0;
    r.ranges.forEach(function (p) { words += countRange(ed.state.doc, p[0], p[1]); chars += p[1] - p[0]; });
    var spec = {
      changes: r.ranges.map(function (p) { return { from: p[0], to: p[1], insert: '' }; }),
      effects: s0.setDoom.of(next ? next.ranges : null),
      userEvent: D.REMOVE_EVENT,
      scrollIntoView: sel.empty && sel.head === end      // the caret rides the end down
    };
    if (s0.settings.hardcore) spec.annotations = TrClass().addToHistory.of(false);
    s0.removingNow = true;
    try { ed.dispatch(spec); } catch (e) { console.error(e); s0.removingNow = false; endSession(s0, 'ended', 'replaced'); return; }
    s0.removingNow = false;
    if (!s0.settings.hardcore) s0.run.steps++;
    s0.run.words += words; s0.run.chars += chars;
    s0.docAfter = ed.state.doc;
    var v2 = liveField(s0);
    step(s0, { type: 'removed', now: Date.now(), words: v2 ? v2.words : s0.core.words, left: !r.last }, false);
  }
  function schedule(s0) {
    clearTimeout(s0.timer); s0.timer = 0;
    var now = Date.now(), at = D.nextAt(s0.core, now, !document.hidden);
    if (at != null) s0.timer = setTimeout(function () { s0.timer = 0; step(s0, { type: 'tick', now: Date.now() }, false); }, Math.max(0, at - now) + 4);
  }
  function onVisibility() {
    var s0 = S;
    if (!s0 || s0.ending) return;
    if (document.hidden) {
      var was = D.running(s0.core);
      step(s0, { type: 'hide', now: Date.now() }, false);
      // normal mode: paused — stop the editor's animations and unmark the next word too
      if (S === s0 && was && !D.running(s0.core)) { try { Cade.editor.dispatch({ effects: s0.setDoom.of(null) }); } catch (e) {} }
    } else step(s0, { type: 'show', now: Date.now() }, false);
  }
  function onGesture() { if (S) S.lastGesture = Date.now(); }
  function onRoomSwitched() { if (S) endSession(S, 'ended', 'room'); }

  // ================= start / end =================
  function blockedReason() {
    var ed = Cade.editor;
    if (!ed || !Cade.CM) return 'The editor isn’t ready yet.';
    if (document.body.classList.contains('readonly') || ed.state.readOnly) return 'Read-only mode is on — turn it off to write dangerously.';
    if (!ed.dom.isConnected || !ed.dom.getClientRects().length) return 'The editor isn’t on screen — close what’s covering it first.';
    var ibx = document.getElementById('inbox-view');
    if (ibx && !ibx.hidden && ibx.getClientRects().length) return 'This room is showing its link list — switch it to Text first.';
    // Origami: the real editor must be in the live pane, and you must have
    // been writing there (not in a mirror or the compare pane).
    if (document.querySelector('.ori-pane')) {
      var live = document.querySelector('.ori-pane.live');
      if (!live || !live.contains(ed.dom)) return 'Origami: tap the pane you want to write in first.';
    }
    var fb = focusBefore;
    if (fb && fb.isConnected && fb.closest && fb.closest('.cm-editor') && !ed.dom.contains(fb)) return 'That pane is read-only — tap into the live editor first, then start.';
    return '';
  }

  function start(raw) {
    if (!D) { toast('Dangerous Mode is still loading…', 'info', 1500); return false; }
    if (S) { toast('Dangerous mode is already on', 'info', 1500); return false; }
    var settings = D.validate(raw);
    var why = blockedReason();
    if (why) { showErr(why); toast(why, 'error', 3200); return false; }
    clearLinger(); closeGone();
    var ed = Cade.editor, st = ed.state, sel = st.selection.main, line = st.doc.lineAt(sel.head);
    // The session starts on a fresh blank line (that newline isn't the session's).
    try {
      if (/\S/.test(line.text)) ed.dispatch({ changes: { from: line.to, insert: '\n' }, selection: { anchor: line.to + 1 }, scrollIntoView: true });
      else ed.dispatch({ selection: { anchor: sel.head }, scrollIntoView: true });
    } catch (e) { console.error(e); }

    var s0 = {
      id: ++seq, settings: settings, core: D.create(settings, Date.now()),
      anchor: ed.state.selection.main.head, doc0: ed.state.doc,
      timer: 0, parity: 0, flipAt: 0, lastGesture: Date.now(),
      created: false, bound: false, ending: false, ended: false, ui: {}, field: null,
      run: { steps: 0, words: 0, chars: 0 }, docAfter: null, removingNow: false
    };
    S = s0;
    showIndicators(s0);                    // the banner shifts the layout before the editor measures
    try { Cade.unregisterPlugin(PLUGIN_ID); } catch (e) {}
    try { Cade.registerPlugin({ id: PLUGIN_ID, ext: makeExt(s0) }); } catch (e) { console.error(e); }
    if (!s0.bound) {
      endSession(s0, 'ended', 'failed');
      toast('Couldn’t arm dangerous mode in this editor', 'error', 3000);
      return false;
    }
    listen(s0, true);
    setPrefs(settings); savePrefs();
    render(s0);
    if (P) {
      if (isPhone()) { paintPanel(); try { Cade.minimizePanel(P); } catch (e) {} }
      else closePanel();
    }
    try { ed.focus(); } catch (e) {}
    announce(s0, 'Dangerous mode on. ' + D.summary(settings));
    return true;
  }

  function listen(s0, on) {
    var f = on ? 'addEventListener' : 'removeEventListener';
    document[f]('visibilitychange', onVisibility);
    document[f]('cade-room-switched', onRoomSwitched);
    ['keydown', 'pointerdown', 'beforeinput', 'compositionend'].forEach(function (t) { document[f](t, onGesture, true); });
  }

  // kind: 'wiped' | 'kept' | 'stopped' (Stop) | 'ended' (switched room, note
  // replaced, read-only…: always keeps the text)
  function endSession(s0, kind, reason) {
    if (!s0 || s0.ending || s0.ended) return;
    s0.ending = true;
    clearTimeout(s0.timer); s0.timer = 0;
    s0.ended = true;
    listen(s0, false);
    try { Cade.unregisterPlugin(PLUGIN_ID); } catch (e) {}
    if (S === s0) S = null;
    hideIndicators(s0, kind, reason);
    // a panel tucked in the dock would read as "still on": it goes
    if (P && Cade.isMinimized(P)) closePanel();
    else if (P) paintPanel();
    var st = s0.core;
    if (kind === 'wiped') {
      try { Cade.haptic(60); } catch (e) {}
      showGone(s0);
    } else if (kind === 'kept') toast('Kept — ' + D.wordsText(st.words) + '. Nice work!', 'success', 3000);
    else if (kind === 'stopped') toast('Dangerous mode off — your text is kept', 'info', 2200);
    else if (reason !== 'failed') toast(endedText(reason) + ' — dangerous mode ended, your text is kept', 'info', 3200);
  }
  function endedText(reason) {
    return reason === 'room' ? 'Switched rooms' : reason === 'readonly' ? 'Read-only mode switched on' : 'The note changed from elsewhere';
  }

  // ================= the indicators =================
  function showIndicators(s0) {
    var g = s0.settings.grace * 1000, root = document.documentElement.style, ui = s0.ui;
    root.setProperty('--dz-g', g + 'ms');
    root.setProperty('--dz-fs', Math.round(g * D.FADE_START) + 'ms');
    root.setProperty('--dz-fd', Math.round(g * (1 - D.FADE_START)) + 'ms');
    root.setProperty('--dz-pulse', Math.round(g * D.PULSE_AT) + 'ms');
    document.body.classList.add('dz-on');

    var b = ui.banner = document.createElement('div');
    b.className = 'dz-banner dz-a' + (s0.settings.hardcore ? ' dz-hc' : '');
    b.setAttribute('role', 'region');
    b.setAttribute('aria-label', 'Dangerous mode');
    b.innerHTML =
      '<div class="dz-b-txt">' +
        '<span class="dz-b-l1"><span class="dz-b-skull" aria-hidden="true">☠</span><b class="dz-b-title">DANGEROUS MODE</b>' +
        (s0.settings.hardcore ? '<span class="dz-b-hc">HARDCORE</span>' : '') +
        '<span class="dz-b-dot" aria-hidden="true">·</span><span class="dz-b-prog"></span></span>' +
        '<span class="dz-b-dot dz-b-dot2" aria-hidden="true">·</span><span class="dz-b-hint"></span>' +
        '<span class="dz-b-msg"></span>' +
      '</div>' +
      '<button type="button" class="dz-b-stop" title="Stop dangerous mode — keeps your text" aria-label="Stop dangerous mode and keep your text">Stop</button>' +
      '<div class="dz-drain" aria-hidden="true"><i></i></div>' +
      '<span class="dz-sr" aria-live="polite"></span>';
    ui.prog = b.querySelector('.dz-b-prog'); ui.hint = b.querySelector('.dz-b-hint'); ui.msg = b.querySelector('.dz-b-msg'); ui.sr = b.querySelector('.dz-sr');
    // buttons on the banner never take the caret (or the phone keyboard) away
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.querySelector('.dz-b-stop').addEventListener('click', function () { if (S === s0) step(s0, { type: 'stop', now: Date.now(), reason: 'user' }, false); });
    var mb = document.querySelector('body > .menubar');
    document.body.insertBefore(b, mb ? mb.nextSibling : document.body.firstChild);

    var foot = document.querySelector('.footer');
    if (foot) {
      var c = ui.chip = document.createElement('span');
      c.className = 'dz-chip';
      c.textContent = '☠ ARMED';
      c.title = 'Dangerous mode is on — stop typing for ' + D.fmtSecs(s0.settings.grace) + ' and this session’s words start being removed';
      foot.insertBefore(c, foot.querySelector('.footer-spacer'));
    }

    prefixTitle();
    var t = document.querySelector('title');
    if (t && window.MutationObserver) {
      ui.titleObs = new MutationObserver(prefixTitle);   // something else retitling the tab keeps the skull
      ui.titleObs.observe(t, { childList: true, characterData: true, subtree: true });
    }
  }
  function prefixTitle() { if (document.title.indexOf(SKULL) !== 0) document.title = SKULL + document.title; }

  function hideIndicators(s0, kind, reason) {
    var ui = s0.ui;
    if (ui.titleObs) { ui.titleObs.disconnect(); ui.titleObs = null; }
    if (document.title.indexOf(SKULL) === 0) document.title = document.title.slice(SKULL.length);
    if (ui.chip) { ui.chip.remove(); ui.chip = null; }
    var b = ui.banner;
    ui.banner = null;
    if (!b || kind === 'wiped' || reason === 'failed') { if (b) b.remove(); layoutOff(); return; }
    // The banner stays a moment to say how it ended, then goes too (body.dz-on
    // still sizes it meanwhile; the frame and fade left with the extension).
    b.classList.remove('dz-run', 'dz-a', 'dz-b', 'dz-fading', 'dz-waiting', 'dz-removing');
    b.classList.add(kind === 'kept' ? 'dz-kept' : 'dz-ended');
    var stop = b.querySelector('.dz-b-stop');
    if (stop) stop.remove();
    var msg = kind === 'kept' ? D.keptText(s0.core)
      : kind === 'stopped' ? 'Stopped — text kept · ' + D.wordsText(s0.core.words)
      : endedText(reason) + ' — dangerous mode ended · text kept';
    ui.msg.textContent = msg;
    ui.sr.textContent = msg;
    clearLinger();
    linger = { el: b, timer: setTimeout(clearLinger, kind === 'kept' ? KEPT_MS : ENDED_MS) };
  }
  function layoutOff() {
    if (S) return;
    document.body.classList.remove('dz-on');
    var root = document.documentElement.style;
    ['--dz-g', '--dz-fs', '--dz-fd', '--dz-pulse'].forEach(function (k) { root.removeProperty(k); });
  }
  function clearLinger() {
    if (!linger) return;
    clearTimeout(linger.timer);
    linger.el.remove();
    linger = null;
    layoutOff();
  }

  function render(s0) {
    var ui = s0.ui, b = ui.banner, st = s0.core, now = Date.now();
    if (!b) return;
    var prog = D.progressText(st, now), hint = D.hintText(st);
    if (ui.lastProg !== prog) { ui.prog.textContent = prog; ui.lastProg = prog; }
    if (ui.lastHint !== hint) { ui.hint.textContent = hint; ui.lastHint = hint; }
    var run = D.running(st);
    b.classList.toggle('dz-run', run);
    b.classList.toggle('dz-a', !s0.parity);
    b.classList.toggle('dz-b', !!s0.parity);
    b.classList.toggle('dz-fading', st.phase === 'fading');
    b.classList.toggle('dz-removing', st.phase === 'removing');
    b.classList.toggle('dz-waiting', !run);
    if (P && el.runProg) el.runProg.textContent = prog;
  }
  function announce(s0, msg) { if (s0.ui.sr) s0.ui.sr.textContent = msg; }

  // ================= "Gone" =================
  function showGone(s0) {
    closeGone();
    var hc = s0.settings.hardcore, run = s0.run, docAfter = s0.docAfter, canUndo = !hc && run.steps > 0;
    var o = document.createElement('div');
    o.className = 'dz-gone';
    o.innerHTML = '<div class="dz-gone-card" role="alertdialog" aria-labelledby="dz-gone-t" aria-describedby="dz-gone-s">' +
      '<div class="dz-gone-skull" aria-hidden="true">💀</div>' +
      '<div class="dz-gone-t" id="dz-gone-t">' + esc(D.goneText(s0.core)) + '</div>' +
      '<div class="dz-gone-s" id="dz-gone-s">' + (run.chars ? (hc ? 'Hardcore — no undo. ' + esc(D.wordsText(run.words)) + ' removed for good.' : esc(D.wordsText(run.words)) + ' removed. Bring it back, or Ctrl+Z / ⌘Z one word at a time.') : 'Nothing was written, so nothing was lost.') + '</div>' +
      '<div class="dz-gone-row">' +
        '<button type="button" class="dz-btn dz-btn-red" data-act="again">Try again</button>' +
        (canUndo ? '<button type="button" class="dz-btn" data-act="undo">↶ Bring it back</button>' : '') +
        '<button type="button" class="dz-btn" data-act="close">Close</button>' +
      '</div></div>';
    o.addEventListener('mousedown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
    o.addEventListener('click', function (e) {
      var bt = e.target.closest && e.target.closest('button[data-act]');
      if (!bt) return;
      var a = bt.getAttribute('data-act'), settings = s0.settings;
      closeGone();
      if (a === 'again') openSetup(settings);
      else if (a === 'undo') {
        var ed = Cade.editor;
        // each removal is its own undo step; only while nothing changed since
        if (ed.state.doc === docAfter) {
          try { for (var i = 0; i < run.steps; i++) Cade.CM.undo(ed); ed.focus(); } catch (x) {}
          toast('Brought back', 'success', 1400);
        } else toast('You’ve typed since — use Undo (Ctrl+Z / ⌘Z) to step back to it', 'info', 3000);
      }
    });
    document.body.appendChild(o);
    var onKey = function (e) { if (e.key === 'Escape') closeGone(); };
    document.addEventListener('keydown', onKey, true);
    gone = { el: o, onKey: onKey, timer: setTimeout(closeGone, GONE_MS) };
  }
  function closeGone() {
    if (!gone) return;
    clearTimeout(gone.timer);
    document.removeEventListener('keydown', gone.onKey, true);
    gone.el.remove();
    gone = null;
  }

  // ================= the setup panel =================
  function copySettings(s) { return { kind: s.kind, words: s.words, minutes: s.minutes, grace: s.grace, hardcore: !!s.hardcore }; }
  function setPrefs(s) { prefs = copySettings(s); prefs.custom = ''; }
  function loadPrefs() {
    var p = null;
    try { p = JSON.parse(sget(PREFS_KEY) || 'null'); } catch (e) { p = null; }
    setPrefs(D ? D.validate(p) : { kind: 'words', words: 250, minutes: 5, grace: 5, hardcore: false });
  }
  function savePrefs() { if (prefs) sset(PREFS_KEY, JSON.stringify(copySettings(prefs))); }

  function chipsHtml(attr, list, unit, label) {
    return '<div class="dz-chips" role="radiogroup" aria-label="' + label + '">' + list.map(function (n) {
      return '<button type="button" class="dz-opt" role="radio" data-' + attr + '="' + n + '">' + n + (unit ? ' ' + unit : '') + '</button>';
    }).join('');
  }
  function bodyHtml() {
    var W = D ? D.WORD_CHOICES : [100, 250, 500], T = D ? D.TIME_CHOICES : [3, 5, 10], G = D ? D.GRACE_CHOICES : [3, 5, 8];
    return '<div class="dz">' +
      '<div class="dz-setup">' +
        '<div class="dz-row"><span class="dz-lbl" id="dz-goal-l">Goal</span>' +
          '<div class="dz-seg" role="radiogroup" aria-labelledby="dz-goal-l">' +
            '<button type="button" class="dz-opt" role="radio" data-kind="words">Words</button>' +
            '<button type="button" class="dz-opt" role="radio" data-kind="time">Time</button></div></div>' +
        '<div class="dz-goal" data-show="words">' + chipsHtml('words', W, '', 'Word goal') +
          '<label class="dz-cust"><input class="dz-in" data-custom="words" type="number" inputmode="numeric" min="10" max="10000" step="1" placeholder="custom" aria-label="Custom word goal"><span>words</span></label></div></div>' +
        '<div class="dz-goal" data-show="time">' + chipsHtml('minutes', T, 'min', 'Time goal') +
          '<label class="dz-cust"><input class="dz-in" data-custom="time" type="number" inputmode="numeric" min="1" max="180" step="1" placeholder="custom" aria-label="Custom time goal in minutes"><span>min</span></label></div></div>' +
        '<div class="dz-cerr" aria-live="polite"></div>' +
        '<div class="dz-row"><span class="dz-lbl" id="dz-grace-l">Grace</span>' + chipsHtml('grace', G, 's', 'Grace — how long you may pause') + '</div></div>' +
        '<div class="dz-sub">How long you may pause before it’s gone.</div>' +
        '<label class="dz-hard"><input type="checkbox" class="dz-hc-in"><span class="dz-sw" aria-hidden="true"></span>' +
          '<span class="dz-hard-t"><b>Hardcore</b><small>The wipe can’t be undone with Ctrl+Z / ⌘Z, and there’s no pause when you leave the app.</small></span></label>' +
        '<p class="dz-sum"></p><p class="dz-mode"></p>' +
        '<div class="dz-err" role="alert"></div>' +
        '<button type="button" class="dz-start" data-act="start">☠ Start dangerous mode</button>' +
      '</div>' +
      '<div class="dz-running" hidden>' +
        '<div class="dz-run-t">☠ Dangerous mode is <b>ON</b></div>' +
        '<div class="dz-run-p"></div>' +
        '<button type="button" class="dz-btn dz-run-stop" data-act="stop">Stop — keep my text</button>' +
      '</div>' +
    '</div>';
  }
  function q(s) { return P ? P.querySelector(s) : null; }
  function qa(s) { return P ? Array.prototype.slice.call(P.querySelectorAll(s)) : []; }

  // What the panel currently describes (a custom goal being typed included).
  function panelSettings() {
    var s = copySettings(prefs);
    if (prefs.custom !== '') { if (s.kind === 'time') s.minutes = Number(prefs.custom); else s.words = Number(prefs.custom); }
    return s;
  }
  function customError() { return prefs.custom === '' || !D ? '' : D.checkCustom(prefs.kind, prefs.custom); }

  function paintPanel() {
    if (!P) return;
    var running = !!S;
    el.setup.hidden = running;
    el.running.hidden = !running;
    if (running) { el.runProg.textContent = D ? D.progressText(S.core, Date.now()) + ' · grace ' + D.fmtSecs(S.settings.grace) + (S.settings.hardcore ? ' · hardcore' : '') : ''; return; }
    var s = prefs;
    qa('[data-kind]').forEach(function (b) { var on = b.getAttribute('data-kind') === s.kind; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
    qa('.dz-goal').forEach(function (g) { g.hidden = g.getAttribute('data-show') !== s.kind; });
    qa('[data-words]').forEach(function (b) { var on = s.kind === 'words' && prefs.custom === '' && +b.getAttribute('data-words') === s.words; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
    qa('[data-minutes]').forEach(function (b) { var on = s.kind === 'time' && prefs.custom === '' && +b.getAttribute('data-minutes') === s.minutes; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
    qa('[data-grace]').forEach(function (b) { var on = +b.getAttribute('data-grace') === s.grace; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
    // a remembered goal that isn't one of the chips shows in the custom box
    var cw = q('[data-custom="words"]'), ct = q('[data-custom="time"]');
    if (document.activeElement !== cw) cw.value = s.kind === 'words' && prefs.custom !== '' ? prefs.custom : (D && D.WORD_CHOICES.indexOf(s.words) < 0 ? String(s.words) : '');
    if (document.activeElement !== ct) ct.value = s.kind === 'time' && prefs.custom !== '' ? prefs.custom : (D && D.TIME_CHOICES.indexOf(s.minutes) < 0 ? String(s.minutes) : '');
    el.hc.checked = !!s.hardcore;
    P.classList.toggle('dz-p-hc', !!s.hardcore);
    var err = customError();
    el.cerr.textContent = err;
    var ok = !!D && !err;
    el.start.disabled = !ok;
    if (D) {
      var v = D.validate(panelSettings());
      el.sum.textContent = err ? '' : D.summary(v);
      el.mode.textContent = err ? '' : D.modeNote(v);
    } else { el.sum.textContent = 'Loading…'; el.mode.textContent = ''; }
  }
  function showErr(msg) { if (el.err) el.err.textContent = msg || ''; }

  function onPanelClick(e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !P || !P.contains(b)) return;
    showErr('');
    if (b.hasAttribute('data-kind')) { prefs.kind = b.getAttribute('data-kind'); prefs.custom = ''; }
    else if (b.hasAttribute('data-words')) { prefs.words = +b.getAttribute('data-words'); prefs.custom = ''; }
    else if (b.hasAttribute('data-minutes')) { prefs.minutes = +b.getAttribute('data-minutes'); prefs.custom = ''; }
    else if (b.hasAttribute('data-grace')) prefs.grace = +b.getAttribute('data-grace');
    else if (b.getAttribute('data-act') === 'start') { startFromPanel(); return; }
    else if (b.getAttribute('data-act') === 'stop') { if (S) step(S, { type: 'stop', now: Date.now(), reason: 'user' }, false); return; }
    else return;
    savePrefs();
    paintPanel();
  }
  function onPanelInput(e) {
    var t = e.target;
    if (t.hasAttribute && t.hasAttribute('data-custom')) {
      prefs.custom = t.value.trim();
      if (prefs.custom !== '' && D && !D.checkCustom(prefs.kind, prefs.custom)) {
        var v = D.validate(panelSettings());
        if (prefs.kind === 'time') prefs.minutes = v.minutes; else prefs.words = v.words;
        savePrefs();
      }
      paintPanel();
    } else if (t === el.hc) { prefs.hardcore = !!t.checked; savePrefs(); paintPanel(); }
  }
  function onPanelKey(e) {
    if (e.key === 'Enter' && e.target.hasAttribute && e.target.hasAttribute('data-custom')) { e.preventDefault(); startFromPanel(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePanel(); try { Cade.editor.focus(); } catch (x) {} }
  }
  function startFromPanel() {
    if (customError()) { paintPanel(); return; }
    var s = D ? D.validate(panelSettings()) : null;
    if (!s) return;
    prefs.custom = '';
    if (s.kind === 'time') prefs.minutes = s.minutes; else prefs.words = s.words;
    start(s);
  }

  // Which editor you were writing in: a mirror / compare pane can't host a session.
  function onFocusIn(e) { var t = e.target; if (t && t.closest && t.closest('.cm-editor')) focusBefore = t; }
  function cleanupPanel() { document.removeEventListener('focusin', onFocusIn, true); P = null; el = {}; }
  function closePanel() { var p = P; cleanupPanel(); if (p) p.remove(); }
  function open() {
    try { Cade.closeAllMenus(); } catch (e) {}
    var ex = document.getElementById(PANEL_ID);
    if (ex && P === ex) {
      if (Cade.isMinimized(ex)) { Cade.restorePanel(ex); paintPanel(); return; }
      closePanel();
      return;
    }
    if (ex) ex.remove();
    focusBefore = document.activeElement;
    loadPrefs();
    P = Cade.mkPanel(PANEL_ID, '☠ Dangerous Mode', bodyHtml());
    P._onClose = cleanupPanel;
    el = {
      setup: q('.dz-setup'), running: q('.dz-running'), runProg: q('.dz-run-p'), hc: q('.dz-hc-in'),
      sum: q('.dz-sum'), mode: q('.dz-mode'), err: q('.dz-err'), cerr: q('.dz-cerr'), start: q('.dz-start')
    };
    P.addEventListener('click', onPanelClick);
    P.addEventListener('input', onPanelInput);
    P.addEventListener('change', onPanelInput);
    P.addEventListener('keydown', onPanelKey);
    document.addEventListener('focusin', onFocusIn, true);
    paintPanel();
    if (!D) loadCore().then(function () { if (!P) return; loadPrefs(); paintPanel(); }, function (e) { showErr(e && e.message || 'Dangerous Mode failed to load'); });
    if (S) return;
    if (!isPhone()) { try { el.start.focus({ preventScroll: true }); } catch (e) {} }
  }
  // "Try again": the setup again, with the settings just used.
  function openSetup(settings) {
    if (settings) { setPrefs(settings); savePrefs(); }
    if (P) { if (Cade.isMinimized(P)) Cade.restorePanel(P); paintPanel(); return; }
    var fb = focusBefore;
    open();
    focusBefore = fb && fb.isConnected ? fb : null;
  }

  var W = {
    name: META.name, description: META.description, icon: META.icon, tags: META.tags,
    open: open,
    close: function () { closePanel(); },
    // for tests: start without the panel, peek at the session
    _debug: {
      ready: loadCore,
      start: function (raw) { return loadCore().then(function () { return start(raw); }); },
      stop: function () { if (S) step(S, { type: 'stop', now: Date.now(), reason: 'user' }, false); },
      state: function () {
        if (!S) return null;
        var v = null;
        try { v = S.field ? Cade.editor.state.field(S.field, false) : null; } catch (e) {}
        return {
          phase: S.core.phase, words: S.core.words, running: D.running(S.core), paused: S.core.paused, hardcore: S.settings.hardcore,
          from: v ? v.from : null, to: v ? v.to : null, pieces: v ? v.pieces.slice() : null,
          doom: v ? v.doom : null, removeAt: S.core.removeAt, removed: S.core.removed
        };
      }
    }
  };
  Cade.registerWidget(W);
})();
