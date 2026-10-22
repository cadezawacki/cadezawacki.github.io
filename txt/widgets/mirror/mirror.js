/* Folder Mirror — widget: set up and watch the mirror between rooms and a
 * folder of .md / .txt files on this computer.
 *
 * Opt-in: nothing happens until the five-step setup is finished —
 *   1 choose a folder (showDirectoryPicker, read + write),
 *   2 what to mirror (all rooms / some workspaces / hand-picked rooms, archived or not),
 *   3 files (.md or .txt, a subfolder per workspace; how odd names are written),
 *   4 direction (two-way / txt → folder only / folder → txt only),
 *   5 review — a preview of the first sync: files to create, ones that already
 *     match, ones that differ (keep both · use the room · use the file — never
 *     overwritten silently) and files in the folder that could become rooms.
 * Starting turns on the "mirror-run" plugin, which keeps the engine
 * (mirror-engine.js) running with the widget closed; Stop mirroring turns it
 * off again and forgets the folder (the files stay).
 *
 * The status page shows the folder, the state (Mirroring · Paused · Needs
 * permission — Reconnect, which must be a click · In another tab · Off),
 * counts, what needs attention (new files to import, conflicts — Resolve opens
 * the merge screen —, missing files — restore or stop mirroring that room)
 * and the last 50 actions. ⚙ opens View → Widget preferences.
 *
 * On iPhone / iPad / Safari / Firefox the File System Access API doesn't exist:
 * the panel explains that mirroring runs on a computer with Chrome or Edge and
 * the phone gets the changes through Sync. Nothing else loads there. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var BASE = Cade.baseURL();
  Cade.loadCSS('mirror.css');
  var CORE_URL = BASE + 'mirror-core.js', ENGINE_URL = BASE + 'mirror-engine.js';
  var ID = 'mirror', PANEL_ID = 'mirror-panel', SETTING = 'plugins.mirror-run';

  var META = {
    name: 'Folder Mirror',
    description: 'Keep rooms in two-way sync with a folder of .md files on your computer — for Obsidian, VS Code, Hazel and scripts (desktop Chrome / Edge; phones get the changes through Sync)',
    icon: '🗂',
    tags: 'folder,mirror,sync,files,markdown,md,txt,obsidian,vs code,hazel,scripts,export,backup,local files,file system,hub,two-way,desktop'
  };

  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2400); } catch (e) {} }
  function plural(n, w, ws) { return n + ' ' + (n === 1 ? w : (ws || w + 's')); }
  function supportedHere() {
    if (typeof window.showDirectoryPicker !== 'function' || window.isSecureContext === false) return false;
    var ua = (navigator.userAgent || '') + ' ' + (navigator.platform || '');
    if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return false;
    try { var d = Cade.cloud && Cade.cloud.device; if (d && d.kind && d.kind !== 'desktop') return false; } catch (e) {}
    return true;
  }
  function deviceWord() {
    var ua = navigator.userAgent || '';
    return /iPad/.test(ua) ? 'iPad' : /iPhone|Android|Mobile/.test(ua) ? 'phone' : 'browser';
  }

  var loads = {};
  function load(url, glob) {
    if (window[glob]) return Promise.resolve(window[glob]);
    if (!loads[url]) {
      loads[url] = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = url; s.async = true;
        s.onload = function () { window[glob] ? res(window[glob]) : rej(new Error('missing')); };
        s.onerror = function () { delete loads[url]; rej(new Error('Folder Mirror failed to load (offline?)')); };
        document.head.appendChild(s);
      });
    }
    return loads[url];
  }
  function loadEngine() {
    return load(CORE_URL, '__cadeMirrorCore').then(function () { return load(ENGINE_URL, '__cadeMirrorEngine'); });
  }

  function settingState() {
    var S = Cade.Settings;
    try { var v = S && S.get ? S.get(SETTING) : undefined; return v === undefined ? null : !!v; } catch (e) { return null; }
  }
  // Mirroring runs in the plugin; without the plugin in this build, the widget runs it while open.
  function turnOn(M) {
    var on = settingState();
    if (on === null) { M.start('widget'); return; }
    if (on) M.start('plugin');
    else Cade.Settings.set(SETTING, true);
  }
  function turnOff() { if (settingState() !== null) Cade.Settings.set(SETTING, false); }

  // ---- state ---------------------------------------------------------------------------
  var S = null;   // { panel, root, M, C, st, wiz, offSub, tickT, confirmStop, busy }

  var ICON = {
    gear: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
  };
  var LOG_ICON = { wrote: '↗', read: '↙', merged: '⇄', conflict: '⚠', error: '✕', info: '·', import: '＋', move: '→', trash: '🗑', missing: '?', wait: '…' };
  var LOG_TITLE = { wrote: 'Wrote a file', read: 'Updated a room from its file', merged: 'Merged', conflict: 'Conflict', error: 'Error', info: '', import: 'Imported', move: 'Moved', trash: 'Moved to .trash', missing: 'Missing file', wait: 'Waiting' };
  var DIR_LABEL = { both: 'two-way', out: 'txt → folder only', in: 'folder → txt only' };

  // ---- rendering ------------------------------------------------------------------------
  function render() {
    if (!S) return;
    var html;
    if (!supportedHere()) html = unsupportedHtml();
    else if (!S.M || !S.st) html = '<div class="mir-load">Loading…</div>';
    else if (S.wiz) html = wizardHtml();
    else if (!S.st.configured) { startWizard(); html = wizardHtml(); }
    else html = statusHtml();
    if (html === S.html) return;
    // Keep keyboard focus on the same control across a re-render.
    var a = document.activeElement, key = null;
    if (a && S.root.contains(a) && a.getAttribute('data-act')) key = '[data-act="' + a.getAttribute('data-act') + '"]' + (a.getAttribute('data-room') ? '[data-room="' + cssEsc(a.getAttribute('data-room')) + '"]' : '');
    S.html = html;
    S.root.innerHTML = html;
    if (key) { var b = S.root.querySelector(key); if (b) try { b.focus({ preventScroll: true }); } catch (e) {} }
    var q = S.root.querySelector('.mir-q');
    if (q && S.wiz && S.wiz.focusQ) { S.wiz.focusQ = false; q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch (e) {} }
  }

  function unsupportedHtml() {
    return '<div class="mir-unsup">' +
      '<div class="mir-big" aria-hidden="true">🗂</div>' +
      '<h3>Folder Mirror runs on a computer</h3>' +
      '<p>It keeps your rooms as plain <b>.md</b> files in a folder on a Mac or PC, so Obsidian, VS Code, Hazel or your own scripts can read and change them.</p>' +
      '<p>Writing to a folder needs <b>Chrome or Edge on a computer</b> — Safari, Firefox and phones can’t do it.</p>' +
      '<ul class="mir-steps">' +
        '<li>Open Cade.txt in Chrome or Edge on your computer and set up Folder Mirror there (Ctrl+K → Folder Mirror).</li>' +
        '<li>Edits made in the files reach this ' + esc(deviceWord()) + ' through <b>Sync</b>, like any other edit.</li>' +
        '<li>What you write here lands in the files the next time that computer has Cade.txt open.</li>' +
      '</ul>' +
    '</div>';
  }

  // -- wizard --
  var STEP_TITLES = ['Choose a folder', 'What to mirror', 'Files', 'Direction', 'Review and start'];
  function startWizard(from) {
    var M = S.M, cfg = from || null;
    S.wiz = {
      step: 1, handle: null, folder: null, picking: false,
      scope: cfg && cfg.scope ? JSON.parse(JSON.stringify(cfg.scope)) : { mode: 'all', ws: [], rooms: [] },
      archived: !!M.pv('archived'), ext: M.pv('ext'), sub: !!M.pv('sub'),
      direction: cfg && cfg.direction ? cfg.direction : 'both',
      q: '', plan: null, planErr: '', conflicts: {}, imports: {}, busy: false,
    };
    S.wiz.scope.ws = S.wiz.scope.ws || [];
    S.wiz.scope.rooms = S.wiz.scope.rooms || [];
  }
  function wizardHtml() {
    var w = S.wiz, h = [];
    h.push('<div class="mir-wiz">');
    h.push('<div class="mir-stepbar" aria-label="Step ' + w.step + ' of 5">');
    for (var i = 1; i <= 5; i++) h.push('<span class="mir-dot' + (i < w.step ? ' done' : i === w.step ? ' cur' : '') + '"></span>');
    h.push('<span class="mir-stepn">Step ' + w.step + ' of 5</span></div>');
    h.push('<h3 class="mir-h">' + esc(STEP_TITLES[w.step - 1]) + '</h3>');
    h.push(['', step1, step2, step3, step4, step5][w.step]());
    h.push('</div>');
    // footer
    var nextOk = w.step === 1 ? !!w.handle : w.step === 2 ? scopeCount() > 0 : w.step === 5 ? !!w.plan && !w.busy : true;
    h.push('<div class="mir-nav">');
    if (w.step > 1) h.push('<button type="button" class="mir-btn" data-act="back"' + (w.busy ? ' disabled' : '') + '>Back</button>');
    else if (S.st.configured) h.push('<button type="button" class="mir-btn" data-act="cancel-wiz">Cancel</button>');
    h.push('<span class="mir-sp"></span>');
    if (w.step < 5) h.push('<button type="button" class="mir-btn primary" data-act="next"' + (nextOk ? '' : ' disabled') + '>Next</button>');
    else h.push('<button type="button" class="mir-btn primary" data-act="start"' + (nextOk ? '' : ' disabled') + '>' + (w.busy ? 'Starting…' : 'Start mirroring') + '</button>');
    h.push('</div>');
    return h.join('');
  }
  function step1() {
    var w = S.wiz, h = [];
    if (!S.st.configured) h.push('<p class="mir-lead">Keep your rooms as plain files in a folder on this computer — Obsidian, VS Code, Hazel or scripts can read and edit them, and their edits come back here and to your other devices through Sync.</p>');
    h.push('<p>Pick a folder for them. <b>A dedicated folder is best</b> — an empty one, or a new folder inside your notes app’s vault — since Folder Mirror reads every .md and .txt file in it.</p>');
    h.push('<button type="button" class="mir-btn primary mir-pick" data-act="pick"' + (w.picking ? ' disabled' : '') + '>📁 ' + (w.handle ? 'Choose a different folder…' : 'Choose folder…') + '</button>');
    if (w.folder) {
      h.push('<div class="mir-folder"><span aria-hidden="true">📁</span> <b>' + esc(w.folder.name) + '</b>' +
        '<span class="mir-muted"> · ' + (w.folder.notes ? plural(w.folder.notes, 'note file') + ' inside' : 'no notes inside yet') + (w.folder.mirrored ? ' · mirrored before' : '') + '</span></div>');
    }
    h.push('<p class="mir-hint">Chrome asks to let this site view and edit the files in that folder. You can stop any time; the files stay.</p>');
    return h.join('');
  }
  function allRooms() { try { return Cade.roomsApi.list(); } catch (e) { return []; } }
  function isArchived(n) { try { return !!Cade.roomsApi.isArchived(n); } catch (e) { return false; } }
  function scopeCount() {
    var w = S.wiz, C = S.C, n = 0;
    allRooms().forEach(function (r) {
      var info = { archived: isArchived(r), wsChain: wsChain(r) };
      if (C.inScope(r, w.scope, w.archived, info)) n++;
    });
    return n;
  }
  function wsChain(r) {
    var A = Cade.roomsApi, ids = [], chain = [];
    try { ids = A.workspaceIds(r) || []; } catch (e) {}
    ids.forEach(function (id) { var x = A.workspaceById(id), g = 0; while (x && g++ < 20) { if (chain.indexOf(x.id) < 0) chain.push(x.id); x = x.parentId ? A.workspaceById(x.parentId) : null; } });
    return chain;
  }
  function wsRows() {
    var A = Cade.roomsApi, list = [];
    try { list = (A.workspaces() || []).map(function (w) { return A.workspaceById(w.id) || w; }); } catch (e) {}
    var kids = {};
    list.forEach(function (w) { var p = w.parentId || ''; (kids[p] = kids[p] || []).push(w); });
    var out = [];
    (function walk(pid, depth) {
      (kids[pid] || []).sort(function (a, b) { return (a.order || 0) - (b.order || 0); }).forEach(function (w) { out.push({ w: w, depth: depth }); if (depth < 8) walk(w.id, depth + 1); });
    })('', 0);
    // orphans whose parent is gone
    list.forEach(function (w) { if (!out.some(function (o) { return o.w.id === w.id; })) out.push({ w: w, depth: 0 }); });
    return out;
  }
  function step2() {
    var w = S.wiz, sc = w.scope, h = [], rooms = allRooms();
    var nArch = rooms.filter(isArchived).length, nLive = rooms.length - nArch;
    var radio = function (v, label, sub) {
      return '<label class="mir-radio"><input type="radio" name="mir-scope" value="' + v + '"' + (sc.mode === v ? ' checked' : '') + '><span><b>' + label + '</b>' + (sub ? '<span class="mir-muted"> ' + sub + '</span>' : '') + '</span></label>';
    };
    h.push(radio('all', 'All rooms', '(' + (w.archived ? rooms.length : nLive) + ')'));
    h.push(radio('ws', 'Some workspaces'));
    if (sc.mode === 'ws') {
      var rows = wsRows();
      h.push('<div class="mir-list mir-indent">');
      if (!rows.length) h.push('<div class="mir-muted mir-empty">No workspaces yet.</div>');
      rows.forEach(function (o) {
        h.push('<label class="mir-check" style="padding-left:' + (8 + o.depth * 16) + 'px"><input type="checkbox" data-ws="' + esc(o.w.id) + '"' + (sc.ws.indexOf(o.w.id) >= 0 ? ' checked' : '') + '><span>' + esc(o.w.name) + '</span></label>');
      });
      h.push('<label class="mir-check"><input type="checkbox" data-ws="__unlabeled__"' + (sc.ws.indexOf('__unlabeled__') >= 0 ? ' checked' : '') + '><span class="mir-muted">Rooms in no workspace</span></label>');
      h.push('</div><div class="mir-hint mir-indent">A workspace includes the workspaces inside it.</div>');
    }
    h.push(radio('rooms', 'Hand-picked rooms', sc.mode === 'rooms' ? '(' + sc.rooms.filter(function (r) { return rooms.indexOf(r) >= 0; }).length + ' picked)' : ''));
    if (sc.mode === 'rooms') {
      var q = w.q.trim().toLowerCase();
      var shown = rooms.slice().sort().filter(function (r) { return !q || r.indexOf(q) >= 0; });
      h.push('<div class="mir-indent"><div class="mir-qrow"><input type="search" class="mir-q" placeholder="Search rooms" value="' + esc(w.q) + '" aria-label="Search rooms" autocomplete="off" spellcheck="false">' +
        '<button type="button" class="mir-link" data-act="pick-all">All</button><button type="button" class="mir-link" data-act="pick-none">None</button></div>');
      h.push('<div class="mir-list">');
      if (!shown.length) h.push('<div class="mir-muted mir-empty">No rooms match.</div>');
      shown.slice(0, 400).forEach(function (r) {
        h.push('<label class="mir-check"><input type="checkbox" data-room="' + esc(r) + '"' + (sc.rooms.indexOf(r) >= 0 ? ' checked' : '') + '><span>' + esc(r) + (isArchived(r) ? ' <span class="mir-tag">archived</span>' : '') + '</span></label>');
      });
      h.push('</div></div>');
    }
    h.push('<label class="mir-check mir-arch"><input type="checkbox" data-act="archived"' + (w.archived ? ' checked' : '') + '><span>Include archived rooms' + (nArch ? ' <span class="mir-muted">(' + nArch + ')</span>' : '') + '</span></label>');
    var n = scopeCount();
    h.push('<div class="mir-count">' + (n ? plural(n, 'room') + ' will be mirrored' : 'Nothing picked yet') + '</div>');
    return h.join('');
  }
  function step3() {
    var w = S.wiz, C = S.C, h = [];
    h.push('<div class="mir-field"><div class="mir-label">File type</div>' +
      '<label class="mir-radio inline"><input type="radio" name="mir-ext" value=".md"' + (w.ext !== '.txt' ? ' checked' : '') + '><span><b>.md</b> <span class="mir-muted">Markdown</span></span></label>' +
      '<label class="mir-radio inline"><input type="radio" name="mir-ext" value=".txt"' + (w.ext === '.txt' ? ' checked' : '') + '><span><b>.txt</b> <span class="mir-muted">plain text</span></span></label></div>');
    h.push('<label class="mir-check"><input type="checkbox" data-act="sub"' + (w.sub ? ' checked' : '') + '><span><b>A subfolder per workspace</b><br><span class="mir-muted">Rooms in a workspace go into a folder named after it; the rest stay at the top.</span></span></label>');
    // examples: a couple of the user's rooms, and one with characters that need escaping
    var ex = allRooms().slice(0, 2);
    var odd = allRooms().filter(function (r) { return /[\/\\:*?"<>|%]/.test(r); })[0] || 'work/plan: q3?';
    if (ex.indexOf(odd) < 0) ex.push(odd);
    h.push('<div class="mir-label">Like this</div><div class="mir-ex">');
    ex.forEach(function (r) {
      var A = Cade.roomsApi, ids = []; try { ids = A.workspaceIds(r) || []; } catch (e) {}
      var dir = w.sub && ids.length ? C.wsFolder(ids[0], function (id) { return A.workspaceById(id); }) : [];
      h.push('<div class="mir-exrow"><span class="mir-exr">' + esc(r) + '</span><span class="mir-arrow" aria-hidden="true">→</span><code>' + esc(C.joinPath(dir.concat([C.encodeName(r) + (w.ext === '.txt' ? '.txt' : '.md')]))) + '</code></div>');
    });
    h.push('</div>');
    h.push('<p class="mir-hint">Characters a file name can’t hold (/ \\ : * ? " &lt; &gt; |) are written as %2F, %3A… and come back exactly. Which file is which room is kept in <code>.txt-mirror.json</code> in the folder, so renaming a file there keeps it linked.</p>');
    h.push('<p class="mir-hint">Pictures and attached files stay in the text as their <code>![…]</code> tokens — the files themselves aren’t copied into the folder.</p>');
    return h.join('');
  }
  function step4() {
    var w = S.wiz, h = [];
    var radio = function (v, label, sub) {
      return '<label class="mir-radio"><input type="radio" name="mir-dir" value="' + v + '"' + (w.direction === v ? ' checked' : '') + '><span><b>' + label + '</b><br><span class="mir-muted">' + sub + '</span></span></label>';
    };
    h.push(radio('both', 'Two-way (recommended)', 'Edit on either side: a change in a room is written to its file, a change to a file updates its room. Both changed? Merged when they don’t overlap, else both versions are kept.'));
    h.push(radio('out', 'txt → folder only', 'The folder is a copy of your rooms — a backup, or for tools that only read. Edits made to the files are left alone (kept as a conflict copy if the room changes too).'));
    h.push(radio('in', 'folder → txt only', 'The files feed the rooms. Edits made in Cade.txt don’t touch the files.'));
    return h.join('');
  }
  function step5() {
    var w = S.wiz, h = [];
    if (w.planErr) return '<div class="mir-err">' + esc(w.planErr) + '</div><button type="button" class="mir-btn" data-act="replan">Try again</button>';
    if (!w.plan) return '<div class="mir-load">Looking at the folder and your rooms…</div>';
    var p = w.plan, c = p.counts;
    h.push('<div class="mir-folder"><span aria-hidden="true">📁</span> <b>' + esc(w.handle.name) + '</b><span class="mir-muted"> · ' + esc(DIR_LABEL[w.direction]) + ' · ' + plural(p.rows.length, 'room') + '</span></div>');
    h.push('<div class="mir-chips">' +
      (c.create ? '<span class="mir-chip">' + plural(c.create, 'new file') + '</span>' : '') +
      (c.same ? '<span class="mir-chip ok">' + c.same + ' already the same</span>' : '') +
      (c.conflict ? '<span class="mir-chip warn">' + c.conflict + ' differ</span>' : '') +
      (p.imports.length ? '<span class="mir-chip">' + plural(p.imports.length, 'file') + ' to import</span>' : '') +
      (c.skip ? '<span class="mir-chip">' + plural(c.skip, 'room') + ' without a file</span>' : '') +
      (c.unreadable ? '<span class="mir-chip warn">' + c.unreadable + ' unreadable</span>' : '') + '</div>');
    var conf = p.rows.filter(function (r) { return r.kind === 'conflict'; });
    if (conf.length) {
      h.push('<div class="mir-sec">Already in the folder, with different text</div><div class="mir-hint">Nothing is overwritten without a copy. “Keep both” puts the room’s text in the file and saves the file’s text next to it as a conflict copy.</div><div class="mir-rows">');
      conf.forEach(function (r) {
        var v = w.conflicts[r.room] || 'both';
        h.push('<div class="mir-row"><div class="mir-rowt"><b>' + esc(r.room) + '</b><span class="mir-muted"> ↔ ' + esc(r.path) + '</span></div>' +
          '<select class="mir-sel" data-conf="' + esc(r.room) + '" aria-label="What to do with ' + esc(r.room) + '">' +
          '<option value="both"' + (v === 'both' ? ' selected' : '') + '>Keep both</option>' +
          '<option value="txt"' + (v === 'txt' ? ' selected' : '') + '>Use the room’s text</option>' +
          '<option value="file"' + (v === 'file' ? ' selected' : '') + '>Use the file’s text</option></select></div>');
      });
      h.push('</div>');
    }
    if (p.imports.length) {
      h.push('<div class="mir-sec">Files in the folder without a room</div><div class="mir-rows">');
      p.imports.forEach(function (it) {
        var on = w.imports[it.path] !== false;
        h.push('<label class="mir-check"><input type="checkbox" data-imp="' + esc(it.path) + '"' + (on ? ' checked' : '') + '><span>' + esc(it.path) + ' <span class="mir-muted">→ new room “' + esc(it.room) + (it.exists ? ' 2' : '') + '”</span></span></label>');
      });
      h.push('</div><div class="mir-hint">Unticked files are left alone and not offered again.</div>');
    }
    var create = p.rows.filter(function (r) { return r.kind === 'create'; });
    if (create.length) {
      h.push('<details class="mir-det"><summary>' + plural(create.length, 'file') + ' will be created</summary><div class="mir-rows">');
      create.slice(0, 300).forEach(function (r) { h.push('<div class="mir-small"><b>' + esc(r.room) + '</b> <span class="mir-muted">→ ' + esc(r.path) + '</span></div>'); });
      if (create.length > 300) h.push('<div class="mir-small mir-muted">…and ' + (create.length - 300) + ' more</div>');
      h.push('</div></details>');
    }
    if (!p.rows.length && !p.imports.length) h.push('<div class="mir-muted">Nothing to mirror yet — new rooms and files will be picked up as they appear.</div>');
    return h.join('');
  }

  // -- status --
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  // Coarse on purpose: the page only re-renders when this text changes.
  function ago(t) {
    if (!t) return '';
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    return 'at ' + new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function pill(st) {
    var map = {
      running: ['ok', 'Mirroring'], paused: ['', 'Paused'], permission: ['warn', 'Needs permission'],
      waiting: ['', 'In another tab'], starting: ['', 'Starting…'], error: ['bad', 'Problem'], off: ['', 'Off'], setup: ['', 'Not set up'],
    };
    var m = map[st.state] || ['', st.state];
    return '<span class="mir-pill ' + m[0] + '">' + esc(m[1]) + '</span>';
  }
  function statusHtml() {
    var st = S.st, h = [];
    h.push('<div class="mir-status">');
    h.push('<div class="mir-top"><div class="mir-fold"><span aria-hidden="true">📁</span> <b>' + esc(st.folder) + '</b></div>' + pill(st) + '</div>');
    var sub = plural(st.rooms, 'room') + ' ↔ files · ' + esc(DIR_LABEL[st.direction] || st.direction);
    if (st.state === 'running' && st.lastTick) sub += ' · checked ' + ago(st.lastTick);
    h.push('<div class="mir-sub">' + sub + '</div>');
    if (st.note) h.push('<div class="mir-note">' + esc(st.note) + '</div>');
    if (st.state === 'permission') h.push('<div class="mir-note">Chrome needs your OK again before Folder Mirror may use this folder.</div>');
    if (st.state === 'off') h.push('<div class="mir-note">Mirroring is switched off (Preferences → Devices → “Keep Folder Mirror running”).</div>');
    h.push('<div class="mir-acts">');
    if (st.state === 'permission' || st.state === 'error') h.push('<button type="button" class="mir-btn primary" data-act="reconnect">Reconnect</button>');
    if (st.state === 'error') h.push('<button type="button" class="mir-btn" data-act="resetup">Choose the folder again</button>');
    if (st.state === 'off') h.push('<button type="button" class="mir-btn primary" data-act="turn-on">Turn on</button>');
    if (st.state === 'running') h.push('<button type="button" class="mir-btn" data-act="pause">⏸ Pause</button><button type="button" class="mir-btn" data-act="sync">↻ Sync now</button>');
    if (st.state === 'paused') h.push('<button type="button" class="mir-btn primary" data-act="resume">▶ Resume</button>');
    h.push('</div>');

    // attention
    var att = [];
    if (st.newFiles.length) {
      var names = st.newFiles.slice(0, 4).map(function (x) { return esc(x.path); }).join(', ') + (st.newFiles.length > 4 ? ', …' : '');
      att.push('<div class="mir-card"><div class="mir-cardt">＋ ' + plural(st.newFiles.length, 'new file') + ' in the folder</div><div class="mir-small mir-muted">' + names + '</div>' +
        '<div class="mir-cardb"><button type="button" class="mir-btn primary" data-act="import">Import ' + plural(st.newFiles.length, 'new file') + '</button><button type="button" class="mir-btn" data-act="ignore">Ignore</button></div></div>');
    }
    st.conflicts.forEach(function (c) {
      att.push('<div class="mir-card warn"><div class="mir-cardt">⚠ ' + (c.first ? 'Two versions of “' : 'Conflict in “') + esc(c.room) + '”</div><div class="mir-small">' +
        (c.first ? 'The folder already had a different ' + esc(c.file) + ' when mirroring started. ' : 'Both sides changed the same lines. ') +
        (c.keep === 'file' ? 'The file’s text went into the room; the room’s text is in ' : 'The room’s text is in ' + esc(c.file) + '; the file’s text is in ') +
        '<code>' + esc(c.path) + '</code>.</div><div class="mir-cardb"><button type="button" class="mir-btn primary" data-act="resolve" data-room="' + esc(c.room) + '">Resolve…</button><button type="button" class="mir-btn" data-act="dismiss" data-room="' + esc(c.room) + '">Keep both</button></div></div>');
    });
    st.missing.forEach(function (m) {
      att.push('<div class="mir-card warn"><div class="mir-cardt">? Missing file for “' + esc(m.room) + '”</div><div class="mir-small"><code>' + esc(m.path) + '</code> is gone from the folder. The room is untouched.</div>' +
        '<div class="mir-cardb"><button type="button" class="mir-btn primary" data-act="restore" data-room="' + esc(m.room) + '">Restore the file</button><button type="button" class="mir-btn" data-act="unmirror" data-room="' + esc(m.room) + '">Stop mirroring this room</button></div></div>');
    });
    if (att.length) h.push('<div class="mir-att">' + att.join('') + '</div>');

    // log
    h.push('<div class="mir-sec">Activity</div>');
    if (!st.log.length) h.push('<div class="mir-muted mir-small">Nothing yet.</div>');
    else {
      h.push('<ol class="mir-log">');
      st.log.slice().reverse().forEach(function (e) {
        var t = new Date(e.t);
        h.push('<li class="k-' + esc(e.k) + '"><span class="mir-lt">' + esc(t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + '</span>' +
          '<span class="mir-li" title="' + esc(LOG_TITLE[e.k] || '') + '" aria-hidden="true">' + (LOG_ICON[e.k] || '·') + '</span>' +
          '<span class="mir-lm">' + (e.r ? '<b>' + esc(e.r) + '</b> ' : '') + esc(e.m) + '</span></li>');
      });
      h.push('</ol>');
    }
    h.push('<div class="mir-foot"><div class="mir-hint">Pictures and attachments stay as their <code>![…]</code> tokens in the files.</div>');
    if (S.confirmStop) {
      h.push('<div class="mir-confirm"><span>Stop mirroring “' + esc(st.folder) + '”? The files stay in the folder.</span><button type="button" class="mir-btn danger" data-act="stop-yes">Stop mirroring</button><button type="button" class="mir-btn" data-act="stop-no">Cancel</button></div>');
    } else h.push('<button type="button" class="mir-link danger" data-act="stop">Stop mirroring…</button>');
    h.push('</div></div>');
    return h.join('');
  }

  // ---- actions ---------------------------------------------------------------------------
  // Run a panel action; a failure becomes a toast.
  function run(p) {
    return Promise.resolve(p).then(function (r) { return r; }, function (e) { toast(e && e.message || String(e), 'error', 3600); });
  }
  function pick() {
    var w = S.wiz, M = S.M;
    if (w.picking) return;
    w.picking = true;
    var p;
    // The picker must be the first thing this click awaits.
    try { p = M.pickFolder(); } catch (e) { p = Promise.reject(e); }
    p.then(function (handle) {
      return M.describeFolder(handle).then(function (info) {
        if (!S || S.wiz !== w) return;
        w.handle = handle; w.folder = info; w.plan = null;
      });
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return;
      toast(e && e.message || 'Couldn’t open that folder', 'error', 3600);
    }).then(function () { if (S && S.wiz === w) { w.picking = false; render(); } });
  }
  function draft() { var w = S.wiz; return { handle: w.handle, scope: w.scope, direction: w.direction }; }
  function replan() {
    var w = S.wiz, M = S.M;
    w.plan = null; w.planErr = '';
    M.pset('archived', w.archived); M.pset('ext', w.ext); M.pset('sub', w.sub);
    render();
    M.preview(draft()).then(function (plan) {
      if (!S || S.wiz !== w) return;
      w.plan = plan;
      var auto = M.pv('newFiles') !== 'ignore';
      plan.imports.forEach(function (it) { if (!(it.path in w.imports)) w.imports[it.path] = auto; });
      render();
    }, function (e) { if (S && S.wiz === w) { w.planErr = e && e.message || 'Couldn’t read the folder'; render(); } });
  }
  function startMirror() {
    var w = S.wiz, M = S.M;
    if (!w.plan || w.busy) return;
    w.busy = true; render();
    var imp = {};
    Object.keys(w.imports).forEach(function (k) { if (w.imports[k]) imp[k] = true; });
    M.setup(draft(), w.plan, { conflicts: w.conflicts, imports: imp }).then(function () {
      if (!S) return;
      S.wiz = null;
      turnOn(M);
      toast('Folder Mirror is on', 'success', 2000);
      render();
    }, function (e) {
      if (S && S.wiz === w) { w.busy = false; render(); }
      toast(e && e.message || 'Couldn’t start', 'error', 3600);
    });
  }

  function act(a, el) {
    var w = S.wiz, M = S.M;
    switch (a) {
      case 'prefs': if (Cade.prefs && Cade.prefs.open) Cade.prefs.open(ID); else toast('Widget preferences come with the next app update', 'info', 2600); return;
      case 'pick': pick(); return;
      case 'next':
        if (!w) return;
        if (w.step === 1 && !w.handle) return;
        if (w.step === 2 && !scopeCount()) return;
        w.step++;
        if (w.step === 5) replan(); else render();
        return;
      case 'back': if (w && w.step > 1 && !w.busy) { w.step--; render(); } return;
      case 'cancel-wiz': S.wiz = null; render(); return;
      case 'replan': replan(); return;
      case 'start': startMirror(); return;
      case 'pick-all': if (w) { w.scope.rooms = allRooms().filter(function (r) { var q = w.q.trim().toLowerCase(); return !q || r.indexOf(q) >= 0 || w.scope.rooms.indexOf(r) >= 0; }); render(); } return;
      case 'pick-none': if (w) { var q2 = w.q.trim().toLowerCase(); w.scope.rooms = q2 ? w.scope.rooms.filter(function (r) { return r.indexOf(q2) < 0; }) : []; render(); } return;
      case 'reconnect':
        // requestPermission needs this click.
        M.reconnect().then(function (ok) { if (!ok) toast('Folder Mirror stays paused until the folder is allowed', 'info', 3000); });
        return;
      case 'resetup': startWizard(M._E.cfg); render(); return;
      case 'turn-on': turnOn(M); return;
      case 'pause': M.pause(true); return;
      case 'resume': M.pause(false); return;
      case 'sync': if (M.syncNow()) toast('Syncing…', 'info', 1200); return;
      case 'import': run(M.importNew()).then(function (n) { if (n) toast('Imported ' + plural(n, 'file'), 'success', 2000); }); return;
      case 'ignore': run(M.ignoreNew()); return;
      case 'resolve': run(M.resolveConflict(el.getAttribute('data-room'))); return;
      case 'dismiss': run(M.dismissConflict(el.getAttribute('data-room'))); return;
      case 'restore': run(M.restore(el.getAttribute('data-room'))); return;
      case 'unmirror': run(M.unmirror(el.getAttribute('data-room'))); return;
      case 'stop': S.confirmStop = true; render(); return;
      case 'stop-no': S.confirmStop = false; render(); return;
      case 'stop-yes':
        S.confirmStop = false;
        turnOff();
        M.forget().then(function () { toast('Stopped mirroring — the files stay in the folder', 'success', 2600); render(); });
        return;
    }
  }

  function onClick(e) {
    if (!S) return;
    var b = e.target.closest && e.target.closest('[data-act]');
    if (!b || !S.panel.contains(b) || b.disabled) return;
    if (b.tagName === 'INPUT') return;          // checkboxes act on change
    act(b.getAttribute('data-act'), b);
  }
  function onChange(e) {
    if (!S || !S.wiz) return;
    var t = e.target, w = S.wiz;
    if (t.name === 'mir-scope') { w.scope.mode = t.value; render(); return; }
    if (t.name === 'mir-ext') { w.ext = t.value; render(); return; }
    if (t.name === 'mir-dir') { w.direction = t.value; return; }
    if (t.hasAttribute('data-ws')) { toggleIn(w.scope.ws, t.getAttribute('data-ws'), t.checked); render(); return; }
    if (t.hasAttribute('data-room')) { toggleIn(w.scope.rooms, t.getAttribute('data-room'), t.checked); render(); return; }
    if (t.getAttribute('data-act') === 'archived') { w.archived = t.checked; render(); return; }
    if (t.getAttribute('data-act') === 'sub') { w.sub = t.checked; render(); return; }
    if (t.hasAttribute('data-conf')) { w.conflicts[t.getAttribute('data-conf')] = t.value; return; }
    if (t.hasAttribute('data-imp')) { w.imports[t.getAttribute('data-imp')] = t.checked; return; }
  }
  function onInput(e) {
    if (!S || !S.wiz) return;
    if (e.target.classList.contains('mir-q')) { S.wiz.q = e.target.value; S.wiz.focusQ = true; render(); }
  }
  function toggleIn(list, v, on) { var i = list.indexOf(v); if (on && i < 0) list.push(v); if (!on && i >= 0) list.splice(i, 1); }

  // ---- open / close --------------------------------------------------------------------
  function onStatus(st) {
    if (!S) return;
    S.st = st;
    // Don't re-render under a focused text field or an open select.
    var a = document.activeElement;
    if (a && S.panel.contains(a) && (a.tagName === 'SELECT' || (a.tagName === 'INPUT' && a.type === 'search'))) return;
    if (!S.wiz || !st.configured) render();
  }
  function cleanup() {
    var s = S;
    if (!s) return;
    S = null;
    if (s.offSub) { try { s.offSub(); } catch (e) {} }
    clearInterval(s.tickT);
    // Without the plugin in this build, mirroring only ran while the widget was open.
    if (s.M && settingState() === null) { try { s.M.stop('widget'); } catch (e) {} }
  }
  function close() {
    var p = S && S.panel;
    cleanup();
    if (p) p.remove();
  }
  function open() {
    try { Cade.closeAllMenus(); } catch (e) {}
    var existing = document.getElementById(PANEL_ID);
    if (existing) {
      if (Cade.isMinimized(existing)) { Cade.restorePanel(existing); return; }
      close();
      if (existing.isConnected) existing.remove();
      return;
    }
    var panel = Cade.mkPanel(PANEL_ID, '🗂 Folder Mirror', '<div class="mir"></div>');
    var head = panel.querySelector('.cade-panel-head');
    var gear = document.createElement('span');
    gear.className = 'mir-gear';
    gear.setAttribute('role', 'button'); gear.setAttribute('tabindex', '0');
    gear.setAttribute('data-act', 'prefs');
    gear.title = 'Preferences'; gear.setAttribute('aria-label', 'Folder Mirror preferences');
    gear.innerHTML = ICON.gear;
    gear.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    gear.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act('prefs'); } });
    head.insertBefore(gear, panel.querySelector('.cade-panel-popbtn') || panel.querySelector('.cade-panel-minbtn'));
    S = { panel: panel, root: panel.querySelector('.mir'), M: null, C: null, st: null, wiz: null, offSub: null, tickT: 0, confirmStop: false };
    panel._onClose = cleanup;
    panel.addEventListener('click', onClick);
    panel.addEventListener('change', onChange);
    panel.addEventListener('input', onInput);
    render();
    if (!supportedHere()) return;
    var s = S;
    loadEngine().then(function (M) {
      if (S !== s) return;
      s.M = M; s.C = window.__cadeMirrorCore;
      s.offSub = M.subscribe(onStatus);
      return M.load().then(function () {
        if (S !== s) return;
        var st = s.st = M.status();   // now, not as it was when the engine first loaded
        render();
        // Mirroring set up but nothing running it (no plugin in this build): run while open.
        if (st.configured && settingState() === null) M.start('widget');
        s.tickT = setInterval(function () { if (S === s && !s.wiz && document.visibilityState === 'visible' && s.st && s.st.state === 'running') render(); }, 10000);
      });
    }).catch(function (e) { if (S === s) { s.root.innerHTML = '<div class="mir-err">' + esc(e && e.message || 'Folder Mirror failed to load') + '</div>'; } });
  }

  var W = {
    name: META.name, description: META.description, icon: META.icon, tags: META.tags,
    open: open, close: close,
    _state: function () { return S; },
  };
  Cade.registerWidget(W);
})();
