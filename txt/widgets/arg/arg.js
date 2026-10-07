/* ARG Desk — cade.txt widget entry.

   A planning desk for alternate reality games: chapters → events → puzzles,
   with clues, characters, places, a timeline, assets, research, ideas,
   questions, tasks and notes around them; a puzzle trail with a player-view
   scrubber; a puzzle crafter (cipher bench + design checks); and LLM
   import/export of any page, sequence, event, chapter or whole game as JSON.

   The desk is a small app of its own (desk.html + shared/ + views/) that runs in
   a full-screen same-origin iframe, so its styles and scripts can never collide
   with the editor's. It reaches back into cade.txt only through public surfaces:
   Cade.syncedBlob (storage + sync), Cade.roomsApi (import a room as a note),
   the host's data-theme attribute and window.toggleTheme.

   The iframe is created on first open and kept (hidden) afterwards, so reopening
   is instant and remote changes keep merging while it's closed.
   window.__argDesk = { open(), close(), isOpen() } is the bridge the desk calls. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('arg.css');
  var BASE = Cade.baseURL(); // capture now: the module context is only valid during load

  var overlay = null, frame = null, lastFocus = null;

  function isOpen() { return !!overlay && !overlay.hidden; }
  function onKey(e) {
    // Focus can land on the host page (e.g. after a tap on the overlay edge); Esc still closes.
    if (e.key === 'Escape' && isOpen()) { e.preventDefault(); e.stopPropagation(); close(); }
  }
  function focusFrame() {
    try { frame.focus(); if (frame.contentWindow) frame.contentWindow.focus(); } catch (err) { /* ignore */ }
  }
  function open() {
    if (Cade.closeAllMenus) Cade.closeAllMenus();
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'argdesk-overlay';
      overlay.className = 'argdesk-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'ARG Desk');
      frame = document.createElement('iframe');
      frame.className = 'argdesk-frame';
      frame.title = 'ARG Desk';
      frame.setAttribute('allow', 'clipboard-read; clipboard-write');
      frame.src = BASE + 'desk.html';
      frame.addEventListener('load', focusFrame);
      overlay.appendChild(frame);
      document.body.appendChild(overlay);
    }
    lastFocus = document.activeElement;
    overlay.hidden = false;
    document.documentElement.classList.add('argdesk-open');
    document.addEventListener('keydown', onKey, true);
    setTimeout(function () {
      focusFrame();
      // a hidden iframe may have measured itself at 0×0; let its views re-measure
      try { frame.contentWindow.dispatchEvent(new Event('resize')); } catch (err) { /* not loaded yet */ }
    }, 0);
  }
  function close() {
    if (!overlay) return;
    overlay.hidden = true;
    document.documentElement.classList.remove('argdesk-open');
    document.removeEventListener('keydown', onKey, true);
    // Return focus without popping the soft keyboard on touch devices.
    var touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (!touch) {
      try { if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus(); else if (Cade.editor) Cade.editor.focus(); } catch (err) { /* ignore */ }
    }
  }

  window.__argDesk = { open: open, close: close, isOpen: isOpen };

  Cade.registerWidget({
    name: 'ARG Desk',
    description: 'Plan your alternate reality game: chapters, events, puzzles, research, crafter, LLM export',
    icon: '◈',
    tags: 'arg,game,puzzle,planning,codex,trail,chapters,events,clues,research,ideas,cipher,crafter,llm,json,export,import',
    open: open,
  });
})();
