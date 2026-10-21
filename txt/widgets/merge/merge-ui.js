/* Merge screen — the Sync Conflict resolver, GitHub-diff style.
 *
 * txt.html loads this (with merge-core.js) the first time a reconnect finds
 * offline edits that overlap changes from another device, and calls
 *   __cadeMergeUI.open({ room, res, core, mode, labels, canUndo })
 * where `res` is merge-core's merge3/merge2 result. It resolves with the
 * user's decision and leaves applying it to the core:
 *   { action: 'apply', text }       the merged document
 *   { action: 'local' | 'server' }  keep one whole version (the old options)
 *   { action: 'new' }               keep both: theirs saved as a new room
 *   { action: 'append-down' | 'append-up' }
 *   { action: 'cancel' }            closed — the core treats it like 'new'
 *   { action: 'undo' | 'close' }    review mode (after an automatic merge)
 *
 * Layout: a full-screen sheet on phones, a large dialog on desktop. Unchanged
 * runs collapse to "⋯ N unchanged lines" (tap to show). Each changed chunk is
 * a card: conflicts need a choice (Take mine / Take theirs / Both either way /
 * Pick lines with a checkbox per line / Edit by hand); auto-merged chunks are
 * pre-applied and can be switched back. Lines left out of the result are
 * dimmed, changed words are highlighted. Unified view on phones, side by side
 * from 900px (toggle). Keys (desktop): j/k next/previous conflict, 1 mine,
 * 2 theirs, 3 both (mine first), 4 both (theirs first), l lines, e edit,
 * Ctrl/⌘+Enter apply, Esc cancel.
 *
 * Nothing runs until open(); closing removes the sheet and every listener.
 * Also: toast({ text, onReview, onUndo, ms }) — an actionable toast for the
 * "merged automatically" notice. */
(function () {
  'use strict';

  var CTX = 3;            // context lines around a change
  var ROW_CAP = 300;      // rows shown per card before "show all"
  var EXPAND_STEP = 400;  // unchanged lines revealed per tap

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }

  var CSS = [
    '.mg-ov{position:fixed;inset:0;z-index:6400;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;padding:24px;}',
    '.mg-dlg{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-lg,10px);box-shadow:var(--shadow-lg);width:min(1240px,100%);height:min(92vh,100%);display:flex;flex-direction:column;overflow:hidden;font-family:var(--font-body,inherit);}',
    '.mg-head{padding:14px 16px 10px;border-bottom:1px solid var(--border);flex:none;}',
    '.mg-title-row{display:flex;align-items:flex-start;gap:8px;}',
    '.mg-title{font-weight:600;font-size:1.05rem;flex:1;min-width:0;overflow-wrap:anywhere;}',
    '.mg-sub{font-size:var(--text-sm,.8125rem);color:var(--text-muted);margin-top:2px;}',
    '.mg-x{flex:none;width:40px;height:40px;margin:-8px -8px 0 0;border:0;background:none;color:var(--text-muted);font-size:22px;border-radius:8px;cursor:pointer;}',
    '.mg-x:hover{background:var(--surface-2);color:var(--text);}',
    '.mg-legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px;font-size:var(--text-xs,.75rem);color:var(--text-muted);}',
    '.mg-legend span{display:inline-flex;align-items:center;gap:6px;}',
    '.mg-sw{width:12px;height:12px;border-radius:3px;flex:none;}',
    '.mg-sw.m,.mg-r.m,.mg-c.m{background:rgba(15,149,152,.14);background:color-mix(in srgb,var(--accent) 15%,transparent);}',
    '.mg-sw.t,.mg-r.t,.mg-c.t{background:rgba(217,119,6,.15);background:color-mix(in srgb,var(--warning,#d97706) 17%,transparent);}',
    '.mg-sw.m{border:1px solid var(--accent);} .mg-sw.t{border:1px solid var(--warning,#d97706);}',
    '.mg-tools{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;}',
    '.mg-seg{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden;}',
    '.mg-seg button{border:0;border-radius:0;}',
    '.mg-seg button+button{border-left:1px solid var(--border);}',
    '.mg-b{min-height:34px;padding:6px 11px;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:8px;font:inherit;font-size:var(--text-sm,.8125rem);cursor:pointer;line-height:1.2;}',
    '.mg-b:hover{border-color:var(--accent);}',
    '.mg-b[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff;}',
    '.mg-b.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;}',
    '.mg-b.primary:disabled{opacity:.45;cursor:not-allowed;}',
    '.mg-b.quiet{border-color:transparent;background:none;color:var(--text-muted);}',
    '.mg-b.quiet:hover{color:var(--text);background:var(--surface-2);}',
    '.mg-spacer{flex:1;}',
    '.mg-body{flex:1;overflow:auto;overscroll-behavior:contain;padding:12px 16px 24px;background:var(--bg,var(--surface-2));-webkit-overflow-scrolling:touch;}',
    '.mg-body:focus{outline:none;}',
    '.mg-intro{padding:0 4px 10px;font-family:var(--font-body,inherit);}',
    // Toasts would sit on the footer (Apply); move them to the top meanwhile.
    'body.mg-open .toast-container{bottom:auto;top:calc(12px + env(safe-area-inset-top,0px));}',
    '.mg-intro .mg-sub{font-size:var(--text-xs,.75rem);}',
    '.mg-intro .mg-tools{margin-top:8px;}',
    '.mg-intro .mg-spacer{display:none;}',
    '.mg-code{font-family:var(--font-mono);font-size:12.5px;line-height:1.55;}',
    '.mg-same{border:1px solid var(--border);border-radius:8px;background:var(--surface);margin:0 0 10px;overflow:hidden;}',
    '.mg-gap{display:block;width:100%;min-height:36px;border:0;background:var(--surface-2);color:var(--text-muted);font:inherit;font-size:var(--text-xs,.75rem);cursor:pointer;text-align:center;}',
    '.mg-gap:hover{color:var(--accent);}',
    '.mg-card{border:1px solid var(--border);border-radius:8px;background:var(--surface);margin:0 0 10px;overflow:hidden;scroll-margin:12px;}',
    '.mg-card.conflict{border-color:var(--warning,#d97706);}',
    '.mg-card.conflict.done{border-color:var(--success);}',
    '.mg-card.cur{box-shadow:0 0 0 2px var(--accent);}',
    '.mg-ch{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 10px;border-bottom:1px solid var(--border);font-size:var(--text-sm,.8125rem);}',
    '.mg-badge{font-weight:600;}',
    '.mg-card.conflict .mg-badge{color:var(--warning,#d97706);}',
    '.mg-card.conflict.done .mg-badge,.mg-card.auto .mg-badge{color:var(--success);}',
    '.mg-where{color:var(--text-muted);font-size:var(--text-xs,.75rem);}',
    '.mg-state{margin-left:auto;color:var(--text-muted);font-size:var(--text-xs,.75rem);}',
    '.mg-fold{cursor:pointer;}',
    '.mg-rows{overflow-x:auto;}',
    '.mg-r{display:flex;align-items:stretch;min-height:21px;}',
    '.mg-r.m{box-shadow:inset 3px 0 var(--accent);}',
    '.mg-r.t{box-shadow:inset 3px 0 var(--warning,#d97706);}',
    '.mg-ln{flex:none;width:3.6em;padding:0 6px;text-align:right;color:var(--text-faint);user-select:none;-webkit-user-select:none;}',
    '.mg-sg{flex:none;width:1.4em;text-align:center;color:var(--text-muted);user-select:none;-webkit-user-select:none;}',
    '.mg-tx{flex:1;min-width:0;padding:0 8px 0 2px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;}',
    '.mg-tx:empty::after{content:"\\00a0";}',
    '.mg-r.out .mg-tx,.mg-c.out .mg-tx{opacity:.42;text-decoration:line-through;text-decoration-color:var(--text-faint);}',
    '.mg-tx mark{background:rgba(15,149,152,.32);color:inherit;border-radius:2px;}',
    '.mg-r.m .mg-tx mark,.mg-c.m .mg-tx mark{background:color-mix(in srgb,var(--accent) 38%,transparent);}',
    '.mg-r.t .mg-tx mark,.mg-c.t .mg-tx mark{background:rgba(217,119,6,.35);background:color-mix(in srgb,var(--warning,#d97706) 40%,transparent);}',
    '.mg-ck{flex:none;display:flex;align-items:center;justify-content:center;width:32px;cursor:pointer;}',
    '.mg-ck input{width:17px;height:17px;margin:0;accent-color:var(--accent);cursor:pointer;}',
    '.lines-mode .mg-r,.lines-mode .mg-c{cursor:pointer;}',
    '.mg-split{display:grid;grid-template-columns:1fr 1fr;}',
    '.mg-split .mg-c{display:flex;align-items:stretch;min-width:0;min-height:21px;}',
    '.mg-split .mg-c+.mg-c{border-left:1px solid var(--border);}',
    '.mg-split .mg-c.m{box-shadow:inset 3px 0 var(--accent);}',
    '.mg-split .mg-c.t{box-shadow:inset 3px 0 var(--warning,#d97706);}',
    '.mg-split .mg-c.fill{background:repeating-linear-gradient(135deg,transparent 0 6px,var(--surface-2) 6px 8px);}',
    '.mg-split-h{display:grid;grid-template-columns:1fr 1fr;font-size:var(--text-xs,.75rem);color:var(--text-muted);border-bottom:1px solid var(--border);}',
    '.mg-split-h div{padding:3px 10px;}',
    '.mg-split-h div+div{border-left:1px solid var(--border);}',
    '.mg-more-rows{display:block;width:100%;min-height:36px;border:0;border-top:1px solid var(--border);background:var(--surface-2);color:var(--accent);font:inherit;font-size:var(--text-xs,.75rem);cursor:pointer;}',
    '.mg-acts{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-top:1px solid var(--border);}',
    '.mg-edit{padding:8px 10px;border-top:1px solid var(--border);}',
    '.mg-edit textarea{display:block;width:100%;box-sizing:border-box;min-height:120px;resize:vertical;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg,var(--surface));color:var(--text);font-family:var(--font-mono);font-size:13px;line-height:1.5;}',
    '.mg-edit textarea:focus{outline:2px solid var(--accent);outline-offset:-1px;}',
    '.mg-edit-hint{font-size:var(--text-xs,.75rem);color:var(--text-muted);margin-top:4px;}',
    '.mg-base{padding:6px 10px;border-top:1px dashed var(--border);font-size:var(--text-xs,.75rem);color:var(--text-muted);}',
    '.mg-base summary{cursor:pointer;padding:5px 0;}',
    '.mg-base pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);font-size:12px;color:var(--text-muted);}',
    '.mg-foot{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--border);background:var(--surface);}',
    '.mg-prog{font-size:var(--text-sm,.8125rem);color:var(--text-muted);min-height:34px;display:inline-flex;align-items:center;gap:8px;}',
    '.mg-prog b{color:var(--text);}',
    '.mg-prog.ok b{color:var(--success);}',
    '.mg-note{font-size:var(--text-xs,.75rem);color:var(--warning,#d97706);width:100%;}',
    '.mg-note:empty{display:none;}',
    '.mg-menu{position:relative;}',
    '.mg-pop{position:absolute;bottom:calc(100% + 6px);right:0;z-index:2;min-width:250px;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow-lg);padding:4px;display:none;}',
    '.mg-pop.open{display:block;}',
    '.mg-pop button{display:block;width:100%;text-align:left;min-height:40px;padding:8px 10px;border:0;background:none;color:var(--text);font:inherit;font-size:var(--text-sm,.8125rem);border-radius:6px;cursor:pointer;}',
    '.mg-pop button:hover{background:var(--surface-2);}',
    '.mg-pop small{display:block;color:var(--text-muted);font-size:var(--text-xs,.75rem);}',
    '.mg-preview{margin:0;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);white-space:pre-wrap;word-break:break-word;}',
    '.mg-preview .mk{color:var(--warning,#d97706);font-weight:600;}',
    '.mg-empty{padding:24px;text-align:center;color:var(--text-muted);}',
    '@media (max-width:899px){.mg-ov{padding:0;}.mg-pop{left:0;right:auto;}.mg-dlg{width:100%;height:100%;max-height:none;border-radius:0;border:0;}',
    '  .mg-head{padding:calc(10px + env(safe-area-inset-top,0px)) 12px 8px;}.mg-body{padding:10px 8px 20px;}.mg-foot{padding-left:12px;padding-right:12px;}}',
    '@media (max-width:640px){.mg-b{min-height:40px;}.mg-acts{display:grid;grid-template-columns:1fr 1fr;}',
    '  .mg-acts .mg-b{width:100%;}.mg-edit textarea{font-size:16px;}.mg-ln{width:2.6em;padding:0 3px;}',
    '  .lines-mode .mg-r{min-height:40px;align-items:center;}.mg-ck{width:40px;}.mg-ck input{width:20px;height:20px;}',
    '  .mg-foot .mg-prog{width:100%;}.mg-foot .mg-b{flex:1 1 auto;}.mg-viewseg{display:none;}}',
  ].join('\n');

  function ensureCSS() {
    if (document.getElementById('mg-css')) return;
    var s = document.createElement('style');
    s.id = 'mg-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ---- open ------------------------------------------------------------------
  var openNow = null;

  function open(o) {
    if (openNow) openNow.finish({ action: 'cancel' });
    ensureCSS();
    return new Promise(function (resolve) { openNow = build(o, resolve); });
  }

  function build(o, resolve) {
    var core = o.core, res = o.res, L = o.labels || {};
    var mineName = L.mine || 'This device (offline edits)', theirsName = L.theirs || 'Other device / server';
    var st = {
      mode: o.mode === 'review' ? 'review' : 'resolve',
      choices: {},             // explicit per-chunk choices (defaults come from core)
      ui: {},                  // per-chunk: { lines: bool, edit: bool, open: bool, all: bool }
      expanded: {},            // same-chunk id → lines revealed { top, bottom }
      view: lsGet('cade-merge-view') || (window.innerWidth >= 900 ? 'split' : 'unified'),
      preview: false,
      cur: -1,
      escArmed: 0,
    };
    if (window.innerWidth < 640) st.view = 'unified';
    var conflictIds = [], changeIds = [];
    res.chunks.forEach(function (c) {
      if (c.type === 'conflict') conflictIds.push(c.id);
      if (c.type !== 'same') changeIds.push(c.id);
    });
    // Auto-merged cards start folded while there are conflicts to look at
    // (or when there are lots of them); conflicts always start open.
    res.chunks.forEach(function (c) {
      if (c.type === 'same') return;
      st.ui[c.id] = { open: c.type === 'conflict' || (!conflictIds.length && changeIds.length <= 30) };
    });

    var ov = document.createElement('div');
    ov.className = 'mg-ov';
    ov.id = 'merge-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'mg-title');
    ov.innerHTML =
      '<div class="mg-dlg">' +
        '<div class="mg-head">' +
          '<div class="mg-title-row"><div style="flex:1;min-width:0"><div class="mg-title" id="mg-title"></div><div class="mg-sub"></div></div>' +
          '<button class="mg-x" data-act="cancel" aria-label="Close" title="Close">×</button></div>' +
          '<div class="mg-legend">' +
            '<span><i class="mg-sw m"></i><b>' + esc(mineName) + '</b>' + (L.mineTime ? ' · ' + esc(L.mineTime) : '') + '</span>' +
            '<span><i class="mg-sw t"></i><b>' + esc(theirsName) + '</b>' + (L.theirsTime ? ' · ' + esc(L.theirsTime) : '') + '</span>' +
          '</div>' +
          '<div class="mg-tools">' +
            '<span class="mg-seg mg-viewseg" role="group" aria-label="Diff layout"><button class="mg-b" data-view="unified">Unified</button><button class="mg-b" data-view="split">Side by side</button></span>' +
            '<button class="mg-b" data-act="preview" aria-pressed="false">Preview result</button>' +
            '<span class="mg-spacer"></span>' +
            '<span class="mg-bulk"><button class="mg-b quiet" data-act="all-mine" title="Resolve every remaining conflict with this device\'s lines">Remaining → mine</button>' +
            '<button class="mg-b quiet" data-act="all-theirs" title="Resolve every remaining conflict with the other device\'s lines">Remaining → theirs</button></span>' +
          '</div>' +
        '</div>' +
        '<div class="mg-body mg-code" tabindex="-1"></div>' +
        '<div class="mg-foot"></div>' +
      '</div>';
    document.body.appendChild(ov);
    document.body.classList.add('mg-open');
    var body = ov.querySelector('.mg-body'), foot = ov.querySelector('.mg-foot');
    var list = document.createElement('div');
    body.appendChild(list);
    // Phones: only the title row stays pinned; the explanation, legend and
    // tools scroll away with the diff so the cards get the screen.
    if (window.innerWidth < 640) {
      var intro = document.createElement('div');
      intro.className = 'mg-intro';
      ['.mg-sub', '.mg-legend', '.mg-tools'].forEach(function (sel) { intro.appendChild(ov.querySelector(sel)); });
      body.insertBefore(intro, list);
    }
    var finished = false;

    function title() {
      var t = ov.querySelector('.mg-title'), s = ov.querySelector('.mg-sub');
      if (st.mode === 'review') {
        t.textContent = 'Merged “' + o.room + '” automatically';
        s.textContent = 'Your offline edits and the other device\'s changes touched different lines, so both were kept (' + plural(changeIds.length, 'change') + '). ' + (o.canUndo === false ? 'You\'ve edited since — use Undo in the editor to step back.' : 'Undo puts your offline version back.');
      } else {
        t.textContent = 'Merge “' + o.room + '”';
        var auto = changeIds.length - conflictIds.length;
        s.textContent = (res.twoWay
          ? 'There\'s no common version to compare against, so every difference is shown. '
          : (conflictIds.length ? 'Both devices changed the same lines in ' + plural(conflictIds.length, 'place') + '. ' : '')) +
          (auto ? plural(auto, 'other change') + ' merged on their own. ' : '') +
          'Closing keeps both copies (the server version is saved as a new room).';
      }
    }

    // ---- choices -------------------------------------------------------------
    function chunk(id) { return res.chunks[id]; }
    function choiceOf(c) { return Object.prototype.hasOwnProperty.call(st.choices, c.id) ? st.choices[c.id] : core.defaultChoice(c); }
    function setChoice(c, ch) { st.choices[c.id] = ch; renderCard(c.id); progress(); if (st.preview) renderPreview(); }
    function pick(c, p) {
      var u = st.ui[c.id];
      if (p === 'lines') {
        var cur = choiceOf(c), base = cur && cur.pick === 'lines' ? cur : null;
        var sel = base ? { m: base.m.slice(), t: base.t.slice() } : core.selectionFor(c, cur && (cur.pick === 'theirs') ? 'theirs' : cur && /first$/.test(cur.pick) ? 'all' : 'mine');
        u.edit = false; u.lines = true;
        setChoice(c, { pick: 'lines', m: sel.m, t: sel.t, order: cur && cur.pick === 'theirs-first' ? 'theirs' : (base && base.order) || 'mine' });
        return;
      }
      if (p === 'custom') {
        var lines = core.resolveChunk(c, choiceOf(c));
        u.edit = true; u.lines = false;
        setChoice(c, { pick: 'custom', text: (lines || c.mine).join('\n') });
        var ta = cardEl(c.id) && cardEl(c.id).querySelector('textarea');
        if (ta) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {} }
        return;
      }
      u.edit = false; u.lines = false;
      setChoice(c, { pick: p });
    }
    function resolved(c) { var ch = choiceOf(c); return !!ch && core.resolveChunk(c, ch) != null; }
    function included(c, ch) {
      // Which rows of the card end up in the result: { m: bool[], t: bool[] }
      // (null → nothing dimmed: unresolved, hand-edited or the base).
      if (!ch || ch.pick === 'custom' || ch.pick === 'base') return null;
      if (ch.pick === 'lines') return { m: ch.m, t: ch.t };
      if (/first$/.test(ch.pick)) return core.selectionFor(c, 'all');
      return core.selectionFor(c, ch.pick);
    }

    // ---- rendering -------------------------------------------------------------
    function cardEl(id) { return body.querySelector('[data-cid="' + id + '"]'); }

    function textHtml(s, ranges) {
      if (!ranges || !ranges.length) return esc(s);
      var out = '', p = 0;
      for (var i = 0; i < ranges.length; i++) {
        out += esc(s.slice(p, ranges[i][0])) + '<mark>' + esc(s.slice(ranges[i][0], ranges[i][1])) + '</mark>';
        p = ranges[i][1];
      }
      return out + esc(s.slice(p));
    }
    // Word ranges for a '~' segment: pair mine[k] with theirs[k] when they
    // look like edits of one another.
    function wordMarks(c, seg) {
      var wm = {}, wt = {}, n = Math.min(seg.mine.length, seg.theirs.length);
      if (n > 200) return { m: wm, t: wt };
      for (var k = 0; k < n; k++) {
        var a = c.mine[seg.mine[k]], b = c.theirs[seg.theirs[k]];
        if (core.similarity(a, b) < 0.34) continue;
        var w = core.wordDiff(a, b);
        wm[seg.mine[k]] = w.a; wt[seg.theirs[k]] = w.b;
      }
      return { m: wm, t: wt };
    }
    function ck(on, side, idx, label) {
      return '<label class="mg-ck" title="' + esc(label) + '"><input type="checkbox" data-side="' + side + '" data-i="' + idx + '"' + (on ? ' checked' : '') + ' aria-label="' + esc(label) + '"></label>';
    }

    function renderRows(c, ch, u) {
      var inc = included(c, ch), segs = core.alignChunk(c), linesMode = !!u.lines && st.mode === 'resolve';
      var html = [], count = 0, cap = u.all ? Infinity : ROW_CAP, more = 0;
      var cls = function (side, i) { return inc && !inc[side][i] ? ' out' : ''; };
      if (st.view === 'split') {
        html.push('<div class="mg-split-h"><div>' + esc(mineName) + '</div><div>' + esc(theirsName) + '</div></div><div class="mg-split">');
        segs.forEach(function (s) {
          var marks = s.t === '~' ? wordMarks(c, s) : null;
          var n = Math.max(s.mine.length, s.theirs.length);
          for (var k = 0; k < n; k++) {
            if (count++ >= cap) { more++; continue; }
            var mi = s.mine[k], ti = s.theirs[k];
            var cell = function (side, idx, txt, ln, wr) {
              if (idx == null) return '<div class="mg-c fill"></div>';
              var tag = s.t === '=' ? '' : side;
              return '<div class="mg-c ' + tag + cls(side === 't' && s.t === '=' ? 'm' : side, side === 't' && s.t === '=' ? mi : idx) + '" data-row="' + (s.t === '=' ? 'e' : side) + ':' + (s.t === '=' ? mi : idx) + '">' +
                (linesMode ? ck(inc ? (s.t === '=' ? inc.m[mi] : inc[side][idx]) : true, s.t === '=' ? 'e' : side, s.t === '=' ? mi : idx, 'Keep this line') : '') +
                '<span class="mg-ln">' + ln + '</span><span class="mg-tx">' + textHtml(txt, wr) + '</span></div>';
            };
            html.push(cell('m', mi, mi != null ? c.mine[mi] : '', mi != null ? c.m0 + mi + 1 : '', marks && mi != null ? marks.m[mi] : null));
            html.push(cell('t', ti, ti != null ? c.theirs[ti] : '', ti != null ? c.t0 + ti + 1 : '', marks && ti != null ? marks.t[ti] : null));
          }
        });
        html.push('</div>');
      } else {
        segs.forEach(function (s) {
          var k;
          if (s.t === '=') {
            for (k = 0; k < s.mine.length; k++) {
              if (count++ >= cap) { more++; continue; }
              var mi = s.mine[k], ti = s.theirs[k];
              html.push('<div class="mg-r' + cls('m', mi) + '" data-row="e:' + mi + '">' + (linesMode ? ck(inc ? inc.m[mi] : true, 'e', mi, 'Keep this line (both have it)') : '') +
                '<span class="mg-ln">' + (c.m0 + mi + 1) + '</span><span class="mg-ln">' + (c.t0 + ti + 1) + '</span><span class="mg-sg"> </span><span class="mg-tx">' + esc(c.mine[mi]) + '</span></div>');
            }
            return;
          }
          var marks = wordMarks(c, s);
          var order = ch && (ch.pick === 'theirs-first' || (ch.pick === 'lines' && ch.order === 'theirs')) ? ['t', 'm'] : ['m', 't'];
          order.forEach(function (side) {
            var list = side === 'm' ? s.mine : s.theirs, src = side === 'm' ? c.mine : c.theirs, base0 = side === 'm' ? c.m0 : c.t0;
            for (var j = 0; j < list.length; j++) {
              if (count++ >= cap) { more++; continue; }
              var i = list[j];
              html.push('<div class="mg-r ' + side + cls(side, i) + '" data-row="' + side + ':' + i + '">' + (linesMode ? ck(inc ? inc[side][i] : false, side, i, side === 'm' ? 'Keep this line from ' + mineName : 'Keep this line from ' + theirsName) : '') +
                (side === 'm' ? '<span class="mg-ln">' + (base0 + i + 1) + '</span><span class="mg-ln"></span>' : '<span class="mg-ln"></span><span class="mg-ln">' + (base0 + i + 1) + '</span>') +
                '<span class="mg-sg" aria-hidden="true">' + (side === 'm' ? '◂' : '▸') + '</span><span class="mg-tx">' + textHtml(src[i], (side === 'm' ? marks.m : marks.t)[i]) + '</span></div>');
            }
          });
        });
        if (!count) html.push('<div class="mg-r"><span class="mg-tx" style="color:var(--text-muted);font-family:var(--font-body,inherit);padding:4px 10px">(both sides removed these lines)</span></div>');
      }
      if (more) html.push('<button class="mg-more-rows" data-act="rows-all">Show ' + plural(more, 'more line') + '</button>');
      return html.join('');
    }

    var KIND_TEXT = {
      mine: 'only this device changed this',
      theirs: 'only the other device changed this',
      both: 'both made the same change',
      union: 'both added lines here — kept both',
    };
    function stateText(c, ch) {
      if (!ch || core.resolveChunk(c, ch) == null) return 'Needs a choice';
      return {
        mine: 'Using mine', theirs: 'Using theirs', base: 'Using the original', 'mine-first': 'Both · mine first',
        'theirs-first': 'Both · theirs first', custom: 'Edited by hand', lines: 'Picked line by line',
      }[ch.pick] || '';
    }

    function renderCard(id) {
      var c = chunk(id), el = cardEl(id);
      if (!el) return;
      var ch = choiceOf(c), u = st.ui[id], isC = c.type === 'conflict', done = isC && resolved(c);
      var n = conflictIds.indexOf(id);
      el.className = 'mg-card ' + (isC ? 'conflict' : 'auto') + (done ? ' done' : '') + (st.cur === id ? ' cur' : '') + (u.lines ? ' lines-mode' : '');
      var where = 'line ' + (c.m0 + 1) + (c.t0 !== c.m0 ? ' (theirs ' + (c.t0 + 1) + ')' : '');
      var head = '<div class="mg-ch' + (isC ? '' : ' mg-fold') + '"' + (isC ? '' : ' data-act="fold" role="button" tabindex="0" aria-expanded="' + !!u.open + '"') + '>' +
        '<span class="mg-badge">' + (isC ? (done ? '✓ ' : '') + 'Conflict ' + (n + 1) + ' of ' + conflictIds.length : (u.open ? '▾ ' : '▸ ') + 'Auto-merged') + '</span>' +
        '<span class="mg-where">' + esc(where) + (isC ? '' : ' · ' + esc(KIND_TEXT[c.kind] || '')) + '</span>' +
        '<span class="mg-state">' + esc(stateText(c, ch)) + '</span></div>';
      if (!u.open) { el.innerHTML = head; return; }
      var parts = [head];
      if (!(u.edit && st.mode === 'resolve')) parts.push('<div class="mg-rows">' + renderRows(c, ch, u) + '</div>');
      if (u.edit && st.mode === 'resolve') {
        parts.push('<div class="mg-edit"><textarea spellcheck="false" aria-label="Edit the merged lines">' + esc(ch && ch.pick === 'custom' ? ch.text : '') + '</textarea>' +
          '<div class="mg-edit-hint">This text replaces the conflict. <button class="mg-b quiet" data-act="edit-done">Done</button> <button class="mg-b quiet" data-act="edit-reset">Start from mine</button> <button class="mg-b quiet" data-act="edit-reset-t">Start from theirs</button></div></div>');
      }
      if (c.base && c.base.length && isC) {
        parts.push('<details class="mg-base"><summary>Original before either change (' + plural(c.base.length, 'line') + ')</summary><pre>' + esc(c.base.slice(0, 200).join('\n')) + (c.base.length > 200 ? '\n…' : '') + '</pre></details>');
      }
      if (st.mode === 'resolve') {
        var b = function (p, label, key) {
          var on = ch && ch.pick === p && !(p === 'custom' && !u.edit && false);
          return '<button class="mg-b" data-pick="' + p + '" aria-pressed="' + !!on + '"' + (key ? ' title="Key ' + key + '"' : '') + '>' + label + '</button>';
        };
        parts.push('<div class="mg-acts">' + b('mine', 'Take mine', '1') + b('theirs', 'Take theirs', '2') +
          b('mine-first', 'Both · mine first', '3') + b('theirs-first', 'Both · theirs first', '4') +
          b('lines', 'Pick lines', 'L') + b('custom', 'Edit', 'E') + '</div>');
      }
      el.innerHTML = parts.join('');
    }

    function sameHtml(c, i) {
      var first = i === 0, last = i === res.chunks.length - 1, n = c.lines.length;
      var ex = st.expanded[c.id] || { top: 0, bottom: 0 };
      var top = first ? 0 : CTX, bottom = last ? 0 : CTX;
      top += ex.top; bottom += ex.bottom;
      if (top + bottom >= n) { top = n; bottom = 0; }
      var hidden = n - top - bottom;
      var row = function (k) {
        var mL = c.m0 + k + 1, tL = c.t0 + k + 1, txt = esc(c.lines[k]);
        if (st.view === 'split') return '<div class="mg-split"><div class="mg-c"><span class="mg-ln">' + mL + '</span><span class="mg-tx">' + txt + '</span></div><div class="mg-c"><span class="mg-ln">' + tL + '</span><span class="mg-tx">' + txt + '</span></div></div>';
        return '<div class="mg-r"><span class="mg-ln">' + mL + '</span><span class="mg-ln">' + tL + '</span><span class="mg-sg"> </span><span class="mg-tx">' + txt + '</span></div>';
      };
      var h = [];
      for (var k = 0; k < top; k++) h.push(row(k));
      if (hidden > 0) h.push('<button class="mg-gap" data-act="expand" data-sid="' + c.id + '" data-dir="' + (first ? 'bottom' : 'top') + '">⋯ ' + plural(hidden, 'unchanged line') + '</button>');
      for (var q = n - bottom; q < n; q++) h.push(row(q));
      return '<div class="mg-same" data-sid="' + c.id + '">' + h.join('') + '</div>';
    }

    function renderAll() {
      title();
      ov.querySelectorAll('[data-view]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === st.view)); });
      ov.querySelector('[data-act="preview"]').setAttribute('aria-pressed', String(st.preview));
      ov.querySelector('.mg-bulk').style.display = st.mode === 'resolve' && conflictIds.length ? '' : 'none';
      if (st.preview) { renderPreview(); renderFoot(); return; }
      var html = [];
      res.chunks.forEach(function (c, i) {
        if (c.type === 'same') html.push(sameHtml(c, i));
        else html.push('<section class="mg-card" data-cid="' + c.id + '"></section>');
      });
      if (!changeIds.length) html.push('<div class="mg-empty">The two versions are identical.</div>');
      list.innerHTML = html.join('');
      changeIds.forEach(renderCard);
      renderFoot();
    }

    function renderPreview() {
      var txt = core.applyChoices(res, st.choices, { mineLabel: mineName, theirsLabel: theirsName });
      var big = txt.length > 400000;
      if (big) txt = txt.slice(0, 400000);
      var html = esc(txt).replace(/^(&lt;){7} .*$|^={7}$|^(&gt;){7} .*$/gm, function (m) { return '<span class="mk">' + m + '</span>'; });
      list.innerHTML = '<pre class="mg-preview">' + html + (big ? '\n… (preview truncated)' : '') + '</pre>';
    }

    function renderFoot() {
      var s = core.stats(res, st.choices), h = [];
      if (st.mode === 'review') {
        h.push('<span class="mg-prog ok"><b>✓ Merged</b> ' + plural(changeIds.length, 'change') + ' applied</span><span class="mg-spacer"></span>');
        if (o.canUndo !== false) {
          h.push('<button class="mg-b" data-act="undo">Undo merge</button>');
          h.push('<button class="mg-b" data-act="edit-choices">Change choices</button>');
        }
        h.push('<button class="mg-b primary" data-act="close">Done</button>');
      } else {
        var ok = s.remaining === 0;
        h.push('<span class="mg-prog' + (ok ? ' ok' : '') + '" aria-live="polite">' + (s.total
          ? '<b>' + s.resolved + ' of ' + plural(s.total, 'conflict') + '</b> resolved' + (ok ? '' : ' <button class="mg-b quiet" data-act="next">Next ↓</button>')
          : '<b>No conflicts</b>') + '</span>');
        h.push('<span class="mg-spacer"></span>');
        // Wide screens show the whole-version choices as buttons; phones keep
        // them in the menu so the footer stays one row of big targets.
        var wide = window.innerWidth >= 900;
        if (wide) {
          h.push('<button class="mg-b" data-act="local" title="This device\'s version only — replaces the server copy">Keep all mine</button>');
          h.push('<button class="mg-b" data-act="server" title="The other device\'s version only — replaces this one">Keep all theirs</button>');
          h.push('<button class="mg-b" data-act="new" title="Mine stays here; theirs is saved as a new room">Keep both as new room</button>');
        }
        h.push('<span class="mg-menu"><button class="mg-b" data-act="menu" aria-haspopup="true" aria-expanded="false"' + (wide ? ' aria-label="More options">⋯' : '>More…') + '</button><div class="mg-pop" role="menu">' +
          (wide ? '' :
          '<button data-act="local" role="menuitem">Keep all mine<small>This device\'s version only — replaces the server copy</small></button>' +
          '<button data-act="server" role="menuitem">Keep all theirs<small>The other device\'s version only — replaces this one</small></button>' +
          '<button data-act="new" role="menuitem">Keep both as a new room<small>Mine stays here; theirs is saved as a new room</small></button>') +
          '<button data-act="append-down" role="menuitem">Append theirs below mine</button>' +
          '<button data-act="append-up" role="menuitem">Append theirs above mine</button>' +
          '</div></span>');
        h.push('<button class="mg-b" data-act="cancel" title="Keeps both copies — the server version is saved as a new room">Cancel</button>');
        h.push('<button class="mg-b primary" data-act="apply"' + (ok ? '' : ' disabled') + ' title="' + (ok ? 'Write the merged text (Ctrl/⌘+Enter)' : 'Resolve every conflict first') + '">Apply merge</button>');
      }
      h.push('<div class="mg-note"></div>');
      foot.innerHTML = h.join('');
    }

    function progress() {
      // Footer progress + Apply, without rebuilding the open menu.
      var menuOpen = foot.querySelector('.mg-pop.open');
      if (menuOpen) return;
      renderFoot();
    }
    function note(msg) { var n = foot.querySelector('.mg-note'); if (n) n.textContent = msg || ''; }

    // ---- navigation -------------------------------------------------------------
    function focusChunk(id, scroll) {
      var prev = st.cur;
      st.cur = id;
      if (prev >= 0 && prev !== id) renderCard(prev);
      if (id >= 0) {
        if (!st.ui[id].open) st.ui[id].open = true;
        renderCard(id);
        var el = cardEl(id);
        if (el && scroll !== false) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    }
    function stepConflict(dir, unresolvedOnly) {
      if (!conflictIds.length) return;
      if (st.preview) { st.preview = false; renderAll(); }
      var i = conflictIds.indexOf(st.cur), n = conflictIds.length;
      for (var k = 1; k <= n; k++) {
        var j = ((i < 0 ? (dir > 0 ? -1 : 0) : i) + dir * k + n * 2) % n;
        var id = conflictIds[j];
        if (!unresolvedOnly || !resolved(chunk(id))) { focusChunk(id); return; }
      }
    }

    // ---- events -------------------------------------------------------------------
    function finish(d) {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKey, true);
      ov.removeEventListener('click', onClick);
      ov.removeEventListener('input', onInput);
      ov.removeEventListener('change', onChange);
      ov.remove();
      document.body.classList.remove('mg-open');
      if (openNow && openNow.finish === finish) openNow = null;
      resolve(d);
    }
    function apply() {
      var s = core.stats(res, st.choices);
      if (s.remaining) { note('Resolve ' + plural(s.remaining, 'more conflict') + ' first.'); stepConflict(1, true); return; }
      finish({ action: 'apply', text: core.applyChoices(res, st.choices), choices: st.choices });
    }
    function cancel() {
      if (st.mode === 'review') { finish({ action: 'close' }); return; }
      finish({ action: 'cancel' });
    }
    function bulk(side) {
      conflictIds.forEach(function (id) {
        var c = chunk(id);
        if (!resolved(c)) { st.choices[id] = { pick: side }; st.ui[id].lines = false; st.ui[id].edit = false; renderCard(id); }
      });
      progress();
      if (st.preview) renderPreview();
    }

    function onClick(e) {
      var t = e.target;
      if (t === ov) { cancel(); return; }
      var menu = foot.querySelector('.mg-pop');
      if (menu && menu.classList.contains('open') && !t.closest('.mg-menu')) { menu.classList.remove('open'); }
      var cardNode = t.closest('[data-cid]'), c = cardNode ? chunk(+cardNode.getAttribute('data-cid')) : null;
      var pk = t.closest('[data-pick]');
      if (pk && c) { st.cur = c.id; pick(c, pk.getAttribute('data-pick')); return; }
      var v = t.closest('[data-view]');
      if (v) { st.view = v.getAttribute('data-view'); lsSet('cade-merge-view', st.view); st.preview = false; renderAll(); return; }
      var a = t.closest('[data-act]');
      // A row tap in lines mode toggles its checkbox (the box itself handles its own click).
      if (!a && c && st.ui[c.id].lines && st.mode === 'resolve' && !t.closest('.mg-ck')) {
        var row = t.closest('[data-row]');
        if (row) { var box = row.querySelector('input[type=checkbox]'); if (box) { box.checked = !box.checked; toggleLine(c, box); } }
        return;
      }
      if (!a) return;
      var act = a.getAttribute('data-act');
      switch (act) {
        case 'cancel': cancel(); break;
        case 'close': finish({ action: 'close' }); break;
        case 'undo': finish({ action: 'undo' }); break;
        case 'edit-choices':
          st.mode = 'resolve';
          changeIds.forEach(function (id) { st.ui[id].open = true; });
          renderAll(); break;
        case 'apply': apply(); break;
        case 'next': stepConflict(1, true); break;
        case 'preview': st.preview = !st.preview; renderAll(); break;
        case 'all-mine': bulk('mine'); break;
        case 'all-theirs': bulk('theirs'); break;
        case 'menu': {
          var pop = foot.querySelector('.mg-pop');
          var openP = !pop.classList.contains('open');
          pop.classList.toggle('open', openP);
          a.setAttribute('aria-expanded', String(openP));
          break;
        }
        case 'local': case 'server': case 'new': case 'append-down': case 'append-up':
          finish({ action: act }); break;
        case 'fold':
          if (c) { st.ui[c.id].open = !st.ui[c.id].open; renderCard(c.id); }
          break;
        case 'rows-all':
          if (c) { st.ui[c.id].all = true; renderCard(c.id); }
          break;
        case 'edit-done':
          if (c) { st.ui[c.id].edit = false; renderCard(c.id); }
          break;
        case 'edit-reset': case 'edit-reset-t':
          if (c) {
            var src = act === 'edit-reset' ? c.mine : c.theirs;
            st.choices[c.id] = { pick: 'custom', text: src.join('\n') };
            renderCard(c.id); progress();
            var ta = cardEl(c.id).querySelector('textarea'); if (ta) ta.focus();
          }
          break;
        case 'expand': {
          var sid = +a.getAttribute('data-sid'), dir = a.getAttribute('data-dir');
          var ex = st.expanded[sid] || (st.expanded[sid] = { top: 0, bottom: 0 });
          ex[dir] += EXPAND_STEP;
          var holder = body.querySelector('.mg-same[data-sid="' + sid + '"]');
          var idx = -1;
          for (var i = 0; i < res.chunks.length; i++) if (res.chunks[i].id === sid) { idx = i; break; }
          if (holder && idx >= 0) holder.outerHTML = sameHtml(res.chunks[idx], idx);
          break;
        }
      }
    }
    function toggleLine(c, box) {
      var ch = choiceOf(c);
      if (!ch || ch.pick !== 'lines') return;
      var side = box.getAttribute('data-side'), i = +box.getAttribute('data-i');
      var m = ch.m.slice(), t = ch.t.slice();
      if (side === 'e') {
        // A line both sides have: one flag (mine's), mirrored onto theirs' copy.
        m[i] = box.checked;
        core.alignChunk(c).forEach(function (s) { if (s.t === '=') { var k = s.mine.indexOf(i); if (k >= 0) t[s.theirs[k]] = box.checked; } });
      } else if (side === 'm') m[i] = box.checked;
      else t[i] = box.checked;
      var y = body.scrollTop;
      setChoice(c, { pick: 'lines', m: m, t: t, order: ch.order });
      body.scrollTop = y;
    }
    function onChange(e) {
      var box = e.target;
      if (!box.matches || !box.matches('input[type=checkbox][data-side]')) return;
      var cardNode = box.closest('[data-cid]');
      if (cardNode) toggleLine(chunk(+cardNode.getAttribute('data-cid')), box);
    }
    function onInput(e) {
      var ta = e.target;
      if (ta.tagName !== 'TEXTAREA') return;
      var cardNode = ta.closest('[data-cid]');
      if (!cardNode) return;
      var c = chunk(+cardNode.getAttribute('data-cid'));
      st.choices[c.id] = { pick: 'custom', text: ta.value };
      var stEl = cardNode.querySelector('.mg-state');
      if (stEl) stEl.textContent = stateText(c, st.choices[c.id]);
      cardNode.classList.add('done');
      progress();
    }
    function onKey(e) {
      if (finished) return;
      var inField = e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' && e.target.type !== 'checkbox');
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        var pop = foot.querySelector('.mg-pop.open');
        if (pop) { pop.classList.remove('open'); return; }
        if (inField) { e.target.blur(); return; }
        // A merge with choices made isn't thrown away by one stray Esc.
        if (st.mode === 'resolve' && Object.keys(st.choices).length && Date.now() - st.escArmed > 2500) {
          st.escArmed = Date.now();
          note('Press Esc again to close — both copies are kept (the server version becomes a new room).');
          return;
        }
        cancel();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (st.mode === 'resolve') apply(); else finish({ action: 'close' }); return; }
      if (inField || e.ctrlKey || e.metaKey || e.altKey) { e.stopPropagation(); return; }
      var k = e.key, c = st.cur >= 0 ? chunk(st.cur) : null, handled = true;
      if (k === 'j' || k === 'n') stepConflict(1);
      else if (k === 'k' || k === 'p') stepConflict(-1);
      else if (st.mode === 'resolve' && c && /^[1-4]$/.test(k)) {
        pick(c, ['mine', 'theirs', 'mine-first', 'theirs-first'][+k - 1]);
        if (c.type === 'conflict') { var nx = conflictIds.filter(function (id) { return !resolved(chunk(id)); }); if (nx.length) setTimeout(function () { stepConflict(1, true); }, 0); }
      } else if (st.mode === 'resolve' && c && (k === 'l' || k === 'L')) pick(c, 'lines');
      else if (st.mode === 'resolve' && c && (k === 'e' || k === 'E')) { e.preventDefault(); pick(c, 'custom'); }
      else handled = false;
      // Keys never reach the editor underneath while the sheet is open.
      e.stopPropagation();
      if (handled) e.preventDefault();
    }

    ov.addEventListener('click', onClick);
    ov.addEventListener('input', onInput);
    ov.addEventListener('change', onChange);
    document.addEventListener('keydown', onKey, true);
    renderAll();
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
    body.focus({ preventScroll: true });
    if (conflictIds.length && st.mode === 'resolve') focusChunk(conflictIds[0], false);
    if (conflictIds.length && st.mode === 'resolve') {
      var first = cardEl(conflictIds[0]);
      var y = first ? first.offsetTop - body.offsetTop : 0;
      if (y > body.clientHeight * 0.55) body.scrollTop = Math.max(0, y - 60);
    }
    return { finish: finish, el: ov, state: st };
  }

  // ---- actionable toast --------------------------------------------------------
  function toast(o) {
    ensureCSS();
    var box = document.getElementById('toast-container') || document.body;
    var t = document.createElement('div');
    t.className = 'toast success mg-toast';
    t.setAttribute('role', 'status');
    t.style.cursor = 'pointer';
    t.style.flexWrap = 'wrap';
    t.innerHTML = '<span style="flex:1;min-width:180px">' + esc(o.text) + '</span>' +
      (o.onReview ? '<button class="mg-b quiet" data-t="review" style="min-height:36px">Review</button>' : '') +
      (o.onUndo ? '<button class="mg-b quiet" data-t="undo" style="min-height:36px">Undo</button>' : '');
    var gone = false, timer;
    var close = function () {
      if (gone) return;
      gone = true; clearTimeout(timer);
      t.style.animation = 'toastOut 200ms ease forwards';
      setTimeout(function () { t.remove(); }, 200);
    };
    t.addEventListener('click', function (e) {
      var b = e.target.closest('[data-t]');
      close();
      if (b && b.getAttribute('data-t') === 'undo') { if (o.onUndo) o.onUndo(); }
      else if (o.onReview) o.onReview();
    });
    box.appendChild(t);
    timer = setTimeout(close, o.ms || 9000);
    return { close: close, el: t };
  }

  window.__cadeMergeUI = { open: open, toast: toast, isOpen: function () { return !!openNow; } };
})();
