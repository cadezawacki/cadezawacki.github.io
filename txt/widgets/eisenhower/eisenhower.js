/* Eisenhower Matrix for Cade.txt — the CURRENT DOCUMENT's todos, sorted into
 * Do first / Schedule / Delegate / Eliminate.
 *
 * Every checkbox line ("- [ ] x", "* [x] x", "1. [ ] x", a bare "[ ] x"; any
 * indentation, so nested sub-tasks count too) is a card. Its quadrant lives IN
 * the line as in-document tags, written with the user's tag sentinel
 * (Settings → Editor → Tag sentinel, default ¥) so the core draws them as tag
 * badges and Ctrl+P finds them:
 *     ¥urgent ¥important  → Do first        ¥important → Schedule
 *     ¥urgent             → Delegate        ¥someday   → Eliminate
 *     none of these       → Unsorted (the tray)
 * "Eliminate" needs its own explicit tag: if "no tags" meant Eliminate, every
 * untouched todo in the document would land in the bin. Tags typed with any of
 * the core's sentinels (¥ € § @ #) are recognised, and rewritten with the
 * current one whenever the card moves.
 *
 * There is no separate state: moving a card rewrites only that line's tags,
 * ticking flips its checkbox (striking the text the way the core's own toggle
 * does), and every action is ONE editor transaction (userEvent
 * "input.eisenhower") — so it syncs, versions and undoes (Ctrl+Z) like typing.
 * The panel re-parses (debounced) on document changes and notices room switches
 * (editor.setState bypasses update listeners) with a cheap doc-identity poll
 * that runs only while it is open.
 *
 * The parser + edit builders (Model) are pure string-in / changes-out
 * functions, unit-tested in node by eisenhower.test.js.
 */
(function () {
  'use strict';

  // =========================================================================
  // Pure model — no DOM, no Cade. Line indices are 0-based.
  // =========================================================================
  var Model = (function () {
    var SENTINELS = ['\u00a5', '\u20ac', '\u00a7', '@', '#'];   // core's TAG_SENTINELS
    var DEFAULT_SENTINEL = '\u00a5';
    var WORD = { u: 'urgent', i: 'important', s: 'someday' };
    var KIND = { urgent: 'u', important: 'i', someday: 's' };
    var WANT = [[], ['u', 'i'], ['i'], ['u'], ['s']];               // tags per quadrant 0..4
    var TASK_RE = /^([ \t]*)(?:([-*+\u2022]|\d{1,9}[.)])[ \t]+)?\[([ xX])\](?=[ \t]|$)[ \t]*/;
    var FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
    var HEAD_RE = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
    var TASKS_NAME_RE = /^(?:tasks?|to-?dos?|to do|task list|todo list|to-?do list)$/i;
    var NUM_RE = /^\d+[.)]$/;
    var STRIKE_G = /\u0336/g;
    var HAS_STRIKE = /\u0336/;
    var BLANK_RE = /^[ \t]*$/;
    // (boundary)(sentinel)(word) — the core's tag grammar: a tag starts after a
    // non-word, non-sentinel character, and "¥urgent/x" or "¥urgent-ly" are
    // different tags, so the word must end there (a trailing "-" or "/" alone
    // is trimmed by the core, so "¥urgent-" still counts).
    var TAG_SRC = '(^|[^A-Za-z0-9_\u00a5\u20ac\u00a7@#])([\u00a5\u20ac\u00a7@#])(urgent|important|someday)(?![A-Za-z0-9_]|[\\/-]+[A-Za-z0-9_])';

    function isBlank(s) { return BLANK_RE.test(s); }
    function isWs(c) { return c === ' ' || c === '\t'; }
    function indentWidth(s) {
      var w = 0;
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c === 32) w++;
        else if (c === 9) w += 4 - (w % 4);
        else break;
      }
      return w;
    }
    function strike(s) {
      return s.replace(STRIKE_G, '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\n\r]/g, function (ch) { return ch + '\u0336'; });
    }
    function validSentinel(s) { return SENTINELS.indexOf(s) !== -1 ? s : DEFAULT_SENTINEL; }

    // Inline code and URLs are not tags (the core's badge renderer skips them
    // too) — blank them out without moving any offsets.
    function mask(s) {
      var blank = function (m) { return new Array(m.length + 1).join(' '); };
      return s.replace(/`[^`\n]*`/g, blank).replace(/https?:\/\/\S+/g, blank);
    }

    // Quadrant tags in a (strike-free) task text → [{from, to, kind, text}].
    function findTags(s) {
      var out = [], re = new RegExp(TAG_SRC, 'gi'), scan = mask(s), m;
      while ((m = re.exec(scan)) !== null) {
        var from = m.index + m[1].length, to = from + 1 + m[3].length;
        out.push({ from: from, to: to, kind: KIND[m[3].toLowerCase()], text: s.slice(from, to) });
        re.lastIndex = to;
      }
      return out;
    }
    function quadrantOf(tags) {
      var u = false, i = false, sd = false;
      for (var k = 0; k < tags.length; k++) {
        if (tags[k].kind === 'u') u = true;
        else if (tags[k].kind === 'i') i = true;
        else sd = true;
      }
      // urgency/importance win over "someday" when someone tagged both
      return u && i ? 1 : i ? 2 : u ? 3 : sd ? 4 : 0;
    }

    // Rewrite the quadrant tags of `s` so it lands in quadrant q: keeps one
    // tag of each wanted kind where it already is (normalised to the current
    // sentinel), drops the rest with one adjacent space, appends what's missing.
    function retag(s, q, sentinel) {
      sentinel = validSentinel(sentinel);
      var tags = findTags(s), want = WANT[q] || [], keep = {}, del = [], rep = {}, k;
      tags.forEach(function (tg) {
        if (want.indexOf(tg.kind) !== -1 && !keep[tg.kind]) {
          keep[tg.kind] = true;
          var canon = sentinel + WORD[tg.kind];
          if (tg.text !== canon) rep[tg.from] = { to: tg.to, ins: canon };
        } else del.push(tg);
      });
      var gone = {};
      del.forEach(function (tg) {
        for (var j = tg.from; j < tg.to; j++) gone[j] = true;
        if (tg.from > 0 && isWs(s.charAt(tg.from - 1)) && !gone[tg.from - 1]) gone[tg.from - 1] = true;
        else if (tg.to < s.length && isWs(s.charAt(tg.to))) gone[tg.to] = true;
      });
      var out = '';
      for (k = 0; k < s.length;) {
        var r = rep[k];
        if (r) { out += r.ins; k = r.to; continue; }
        if (!gone[k]) out += s.charAt(k);
        k++;
      }
      var add = want.filter(function (w) { return !keep[w]; }).map(function (w) { return sentinel + WORD[w]; });
      if (add.length) {
        out = out.replace(/[ \t]+$/, '');
        out += (out ? ' ' : '') + add.join(' ');
      }
      return out;
    }
    // What a card shows: the text without its quadrant tags (the position says it).
    function displayText(s) { return retag(s, 0, DEFAULT_SENTINEL).trim(); }

    // ---- parse ------------------------------------------------------------
    function parse(text) {
      text = String(text);
      var lines = text.split('\n'), n = lines.length, starts = new Array(n), pos = 0, i;
      for (i = 0; i < n; i++) { starts[i] = pos; pos += lines[i].length + 1; }
      var tasks = [], heads = [], fences = [], byLine = {}, open = -1, fch = '', flen = 0, f;
      for (i = 0; i < n; i++) {
        var t = lines[i];
        if (open >= 0) {
          f = FENCE_RE.exec(t);
          if (f && f[1].charAt(0) === fch && f[1].length >= flen) { fences.push([open, i]); open = -1; }
          continue;
        }
        var c0 = t.charCodeAt(0);
        if ((c0 === 96 || c0 === 126 || c0 === 32 || c0 === 9) && (f = FENCE_RE.exec(t))) {
          open = i; fch = f[1].charAt(0); flen = f[1].length; continue;
        }
        if (c0 === 35) {
          var h = HEAD_RE.exec(t);
          if (h) { heads.push({ line: i, level: h[1].length, raw: (h[2] || '').replace(/[ \t]+#+$/, '').replace(/^#+$/, '') }); continue; }
        }
        if (t.length > 2000) continue;                 // data / image lines aren't todos
        var m = TASK_RE.exec(t);
        if (!m) continue;
        var pre = m[0].length, raw = t.slice(pre), clean = raw.replace(STRIKE_G, ''), tags = findTags(clean);
        byLine[i] = tasks.length;
        tasks.push({
          line: i, indent: m[1], marker: m[2] || '', check: m[3], done: m[3] !== ' ', pre: pre,
          raw: raw, clean: clean, struck: HAS_STRIKE.test(raw), q: quadrantOf(tags), depth: indentWidth(m[1]),
        });
      }
      if (open >= 0) fences.push([open, n - 1]);
      return { text: text, lines: lines, starts: starts, tasks: tasks, heads: heads, fences: fences, byLine: byLine };
    }
    function taskAt(P, line) { var k = P.byLine[line]; return k == null ? null : P.tasks[k]; }
    function inFence(P, line) {
      for (var k = 0; k < P.fences.length; k++) if (line >= P.fences[k][0] && line <= P.fences[k][1]) return true;
      return false;
    }

    // ---- text edit helpers ---------------------------------------------------
    // Shrink a replacement to the span that really differs (never splitting a
    // surrogate pair) so undo/sync/cursor mapping see a minimal edit.
    function minimize(text, from, to, ins) {
      var old = text.slice(from, to), max = Math.min(old.length, ins.length), p = 0, s = 0;
      while (p < max && old.charCodeAt(p) === ins.charCodeAt(p)) p++;
      if (p > 0 && p < old.length && /[\uD800-\uDBFF]/.test(old.charAt(p - 1))) p--;
      max -= p;
      while (s < max && old.charCodeAt(old.length - 1 - s) === ins.charCodeAt(ins.length - 1 - s)) s++;
      if (s > 0 && s < old.length && /[\uDC00-\uDFFF]/.test(old.charAt(old.length - s))) s--;
      if (p + s >= old.length && p + s >= ins.length) return null;
      return { from: from + p, to: to - s, insert: ins.slice(p, ins.length - s) };
    }
    function replaceLine(P, i, nl) { return minimize(P.text, P.starts[i], P.starts[i] + P.lines[i].length, nl); }
    // Insert whole lines before line `at` (at === lines.length appends).
    function insertLines(P, at, nl) {
      if (!P.text) return { from: 0, to: 0, insert: nl.join('\n') };
      if (at < P.lines.length) return { from: P.starts[at], to: P.starts[at], insert: nl.join('\n') + '\n' };
      return { from: P.text.length, to: P.text.length, insert: '\n' + nl.join('\n') };
    }
    function result(changes, extra) {
      var r = { changes: changes.filter(Boolean) };
      if (extra) for (var k in extra) r[k] = extra[k];
      return r.changes.length ? r : null;
    }
    function lineWith(P, task, body) {
      var head = P.lines[task.line].slice(0, task.pre);
      if (body && head && !/[ \t]$/.test(head)) head += ' ';
      return head + body;
    }

    // ---- actions (each returns {changes, …} or null for "nothing to do") -----
    function setQuadrant(P, task, q, sentinel) {
      if (!task || task.q === q) return null;
      var body = retag(task.clean, q, sentinel);
      if (task.struck) body = strike(body);
      return result([replaceLine(P, task.line, lineWith(P, task, body))]);
    }

    // Same text effect as the core's toggleTodoAtCursor: tick + strike / untick + unstrike.
    function toggleDone(P, task) {
      if (!task) return null;
      var line = P.lines[task.line], head = line.slice(0, task.pre), bi = head.lastIndexOf('['), on = !task.done;
      head = head.slice(0, bi + 1) + (on ? 'x' : ' ') + head.slice(bi + 2);
      var body = task.raw.replace(STRIKE_G, '');
      if (on && body) body = strike(body);
      return result([replaceLine(P, task.line, head + body)], { done: on });
    }

    // The edit box shows the whole (unstruck) text, tags included — what you
    // see is what the line says, so typing or deleting a tag moves the card.
    function editText(task) { return task.clean; }
    function editTask(P, task, value) {
      if (!task) return null;
      var v = String(value).replace(/[\r\n]+/g, ' ').replace(/[ \t]+$/, '').replace(/^[ \t]+/, '');
      if (!v) return null;
      if (task.struck) v = strike(v);
      return result([replaceLine(P, task.line, lineWith(P, task, v))]);
    }

    function headName(raw) { return String(raw).replace(/[^A-Za-z -]/g, '').replace(/\s+/g, ' ').trim(); }
    function findTasksHeading(P) {
      for (var k = 0; k < P.heads.length; k++) if (TASKS_NAME_RE.test(headName(P.heads[k].raw))) return k;
      return -1;
    }
    function lastNonBlank(P, a, b) {
      for (var i = b - 1; i >= a; i--) if (!isBlank(P.lines[i])) return i;
      return -1;
    }
    // Pasted lists arrive with bullets / checkboxes; the style comes from the doc.
    function cleanInput(texts) {
      return (texts || []).map(function (t) {
        return String(t).replace(/^\s*(?:[-*+\u2022]|\d{1,9}[.)])\s+/, '').replace(/^\s*\[[ xX]\]\s*/, '').replace(/\s+$/, '').replace(/^\s+/, '');
      }).filter(Boolean);
    }

    // New tasks go at the end of the first "## Tasks" / "## Todo" section (any
    // heading level), copying its list style; without one, a "## Tasks"
    // section is created at the end of the document.
    function addTasks(P, q, texts, sentinel) {
      texts = cleanInput(texts);
      if (!texts.length) return null;
      var hk = findTasksHeading(P), n = P.lines.length, nl, at, first;
      var bodies = texts.map(function (t) { return retag(t, q, sentinel); });
      if (hk >= 0) {
        var hd = P.heads[hk], a = hd.line + 1, b = hk + 1 < P.heads.length ? P.heads[hk + 1].line : n;
        var ref = null, minD = Infinity;
        P.tasks.forEach(function (t) { if (t.line >= a && t.line < b && t.depth <= minD) { minD = t.depth; ref = t; } });
        var indent = ref ? ref.indent : '', marker = ref ? ref.marker : '-', num = 0;
        if (NUM_RE.test(marker)) num = parseInt(marker, 10);
        nl = bodies.map(function (body) {
          var mk = num ? (++num) + marker.slice(-1) : marker;
          return indent + (mk ? mk + ' ' : '') + '[ ] ' + body;
        });
        var last = lastNonBlank(P, a, b);
        at = (last < 0 ? hd.line : last) + 1;
        first = at;
        if (last >= 0 && !TASK_RE.test(P.lines[last]) && indentWidth(P.lines[last]) === 0 && !/^[ \t]*(?:[-*+\u2022]|\d{1,9}[.)])[ \t]/.test(P.lines[last])) {
          nl.unshift(''); first++;                    // a paragraph / code fence ends there: start a fresh list
        }
        if (at < n && !isBlank(P.lines[at])) nl.push(''); // keep the next heading separated
      } else {
        var lastAll = lastNonBlank(P, 0, n);
        nl = ['## Tasks'].concat(bodies.map(function (body) { return '- [ ] ' + body; }));
        if (lastAll < 0) { at = 0; first = 1; }
        else { nl.unshift(''); at = lastAll + 1; first = at + 2; }
      }
      return result([insertLines(P, at, nl)], { firstLine: first, count: texts.length });
    }

    // ---- markdown summary ------------------------------------------------------
    var QNAMES = ['Unsorted', 'Do first', 'Schedule', 'Delegate', 'Eliminate'];
    var QSUBS = ['no quadrant yet', 'urgent & important', 'important, not urgent', 'urgent, not important', 'neither'];
    function summary(P, opts) {
      opts = opts || {};
      var groups = [[], [], [], [], []];
      P.tasks.forEach(function (t) { if (!(opts.hideDone && t.done)) groups[t.q].push(t); });
      var out = ['**Eisenhower Matrix**' + (opts.date ? ' \u2014 ' + opts.date : '')];
      [1, 2, 3, 4, 0].forEach(function (q) {
        var g = groups[q];
        if (q === 0 && !g.length) return;
        out.push('');
        out.push('**' + QNAMES[q] + '** (' + QSUBS[q] + ')' + (g.length ? ' \u00b7 ' + g.length : ''));
        if (!g.length) { out.push('- \u2014'); return; }
        g.forEach(function (t) {
          var s = displayText(t.clean) || '(empty)';
          out.push('- ' + (t.done ? '~~' + s + '~~' : s));
        });
      });
      return out.join('\n');
    }
    // A block of lines at the cursor line (or at the end when the cursor sits
    // in a code fence), separated from neighbouring text by blank lines.
    function insertBlock(P, cursorLine, block) {
      var n = P.lines.length, L = Math.max(0, Math.min(cursorLine == null ? n - 1 : cursorLine, n - 1)), at, nl;
      if (inFence(P, L)) L = n - 1;
      if (isBlank(P.lines[L])) {
        at = L;
        nl = (L > 0 && !isBlank(P.lines[L - 1]) ? [''] : []).concat(block);   // the blank line L follows it
      } else {
        at = L + 1;
        nl = [''].concat(block);
        if (at < n && !isBlank(P.lines[at])) nl.push('');
      }
      return result([insertLines(P, at, nl)]);
    }

    function applyChanges(text, changes) {
      var cs = changes.slice().sort(function (a, b) { return b.from - a.from; });
      cs.forEach(function (c) { text = text.slice(0, c.from) + c.insert + text.slice(c.to); });
      return text;
    }

    return {
      SENTINELS: SENTINELS, DEFAULT_SENTINEL: DEFAULT_SENTINEL, QNAMES: QNAMES, QSUBS: QSUBS, WORD: WORD,
      parse: parse, taskAt: taskAt, findTags: findTags, quadrantOf: quadrantOf, retag: retag, displayText: displayText,
      setQuadrant: setQuadrant, toggleDone: toggleDone, editText: editText, editTask: editTask, addTasks: addTasks,
      summary: summary, insertBlock: insertBlock, applyChanges: applyChanges, strike: strike, validSentinel: validSentinel,
      findTasksHeading: findTasksHeading,
    };
  })();

  if (typeof window === 'undefined') {           // node: expose the model to eisenhower.test.js
    if (typeof module === 'object' && module && module.exports) module.exports = Model;
    return;
  }
  if (typeof window.Cade === 'undefined') return;

  // =========================================================================
  // Panel UI
  // =========================================================================
  var Cade = window.Cade;
  Cade.loadCSS('eisenhower.css');

  var PANEL_ID = 'eisenhower-panel';
  var PREFS_KEY = 'cade-eisenhower-prefs';
  var STRIKE_G = /\u0336/g;
  var LIST_CAP = 300;                              // cards drawn per list (the rest summarised)
  var QUADS = [
    { n: 0, name: 'Unsorted', sub: 'No quadrant yet', icon: '' },
    { n: 1, name: 'Do first', sub: 'Urgent \u00b7 important', icon: '\ud83d\udd25' },
    { n: 2, name: 'Schedule', sub: 'Important \u00b7 not urgent', icon: '\ud83d\udcc5' },
    { n: 3, name: 'Delegate', sub: 'Urgent \u00b7 not important', icon: '\ud83d\udc65' },
    { n: 4, name: 'Eliminate', sub: 'Neither \u2014 drop it?', icon: '\ud83d\uddd1\ufe0f' },
  ];
  var INLINE_SRC = [
    '`([^`\\n]+)`',                                        // 1 code
    '\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)',     // 2,3 link
    '\\*\\*(?=\\S)([^*\\n]+?)\\*\\*',                      // 4 bold
    '~~(?=\\S)([^~\\n]+?)~~',                              // 5 strike
    '\\*(?=[^\\s*])([^*\\n]+?)\\*',                        // 6 italic
    '(https?:\\/\\/[^\\s<>"]*[^\\s<>".,;:!?)\\]\'])',      // 7 bare URL
    '(^|[\\s(\\[])([@#\\u00a5\\u20ac\\u00a7][A-Za-z0-9_][\\w/-]*)', // 8,9 tag
    '\\b(\\d{4}-\\d{2}-\\d{2})\\b',                        // 10 date
  ].join('|');

  var prefs = { hideDone: false, trayOpen: true };
  var panelEl = null, refreshTimer = 0, pollTimer = 0;
  var S = freshState();
  var TODAY = '';

  function freshState() {
    return {
      doc: null, ro: false, room: undefined, P: null, sentinel: Model.DEFAULT_SENTINEL, html: '',
      editing: null, addQ: -1, addDraft: '', focusAdd: false, press: null, drag: null, pending: false,
      menu: null, justDragged: 0, suppressClick: 0, clickTimer: 0, pointerType: '', flash: null,
    };
  }

  // ---- small utils -----------------------------------------------------------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function toast(msg, type, ms) { try { Cade.showToast(msg, type || 'info', ms || 1800); } catch (e) {} }
  function activeRoom() { try { return Cade.roomsApi ? Cade.roomsApi.activeRoom() : null; } catch (e) { return null; } }
  function loadPrefs() {
    try {
      var p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {};
      if (typeof p.hideDone === 'boolean') prefs.hideDone = p.hideDone;
      if (typeof p.trayOpen === 'boolean') prefs.trayOpen = p.trayOpen;
    } catch (e) {}
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }
  function ymd(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function isCoarse() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
  function intAttr(el, name) { var v = el && el.getAttribute(name); return v == null ? -1 : parseInt(v, 10); }
  function sentinelNow() {
    var s = null;
    try { s = Cade.Settings && Cade.Settings.get('editor.tagSentinel'); } catch (e) {}
    return Model.validSentinel(s);
  }
  function cardRef(el) {
    var c = el && el.closest && el.closest('.em-card');
    if (!c || !S.P) return null;
    var line = intAttr(c, 'data-line');
    return line >= 0 && line < S.P.lines.length ? { line: line, raw: S.P.lines[line] } : null;
  }
  function zoneOf(el) { var z = el && el.closest && el.closest('[data-q]'); return z && panelEl && panelEl.contains(z) ? intAttr(z, 'data-q') : -1; }
  function copyText(text, label) {
    var done = function () { toast('Copied ' + label, 'success', 1400); };
    var fail = function () { toast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      ta.remove();
    }
  }

  // Inline markdown → safe HTML (everything escaped; only http(s) links).
  function inline(s, checked) {
    s = String(s).replace(STRIKE_G, '');
    if (s.length > 400) s = s.slice(0, 400) + '\u2026';
    var re = new RegExp(INLINE_SRC, 'g'), out = '', last = 0, m;
    while ((m = re.exec(s))) {
      out += esc(s.slice(last, m.index));
      if (m[1] != null) out += '<code>' + esc(m[1]) + '</code>';
      else if (m[2] != null) out += '<a href="' + esc(m[3]) + '" target="_blank" rel="noopener noreferrer">' + esc(m[2]) + '</a>';
      else if (m[4] != null) out += '<strong>' + inline(m[4], checked) + '</strong>';
      else if (m[5] != null) out += '<s>' + inline(m[5], checked) + '</s>';
      else if (m[6] != null) out += '<em>' + inline(m[6], checked) + '</em>';
      else if (m[7] != null) out += '<a href="' + esc(m[7]) + '" target="_blank" rel="noopener noreferrer">' + esc(m[7].length > 40 ? m[7].slice(0, 38) + '\u2026' : m[7]) + '</a>';
      else if (m[9] != null) out += esc(m[8]) + '<span class="em-chip' + (m[9].charAt(0) === '@' ? ' em-at' : '') + '">' + esc(m[9]) + '</span>';
      else if (m[10] != null) {
        var cls = 'em-chip em-date' + (m[10] === TODAY ? ' em-today' : m[10] < TODAY && !checked ? ' em-overdue' : '');
        out += '<span class="' + cls + '">' + esc(m[10]) + '</span>';
      }
      if (re.lastIndex === m.index) re.lastIndex++;
      last = re.lastIndex;
    }
    return out + esc(s.slice(last));
  }

  // ---- parse / sync ------------------------------------------------------------
  function reparse() {
    var ed = Cade.editor;
    S.doc = ed.state.doc;
    S.P = Model.parse(S.doc.toString());
  }

  function refresh(opts) {
    opts = opts || {};
    if (!panelEl || !panelEl.isConnected) return;
    var ed = Cade.editor;
    if (!ed) return;
    var room = activeRoom();
    if (room !== S.room) {
      if (S.room !== undefined) { S.addQ = -1; S.addDraft = ''; S.editing = null; }
      S.room = room;
      opts.reparse = true;
    }
    if (!opts.force && (S.editing || S.drag || (S.press && S.press.lifted))) { S.pending = true; return; }
    if (opts.reparse || ed.state.doc !== S.doc || !S.P) reparse();
    S.ro = !!ed.state.readOnly;
    S.sentinel = sentinelNow();
    S.pending = false;
    render(opts.focus);
  }
  function scheduleRefresh(ms) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { refresh(); }, ms);
  }

  // Re-find a card drawn from an older parse in the CURRENT document (it may
  // have changed within the debounce window, or remotely). Matched by its
  // exact line text, nearest to where it was; null = can't be sure.
  function syncRef(ref) {
    var ed = Cade.editor;
    if (!ref || !ed || activeRoom() !== S.room) return null;
    if (ed.state.doc !== S.doc) { reparse(); S.html = ''; }
    var P = S.P, t = Model.taskAt(P, ref.line);
    if (t && P.lines[ref.line] === ref.raw) return t;
    var best = null;
    P.tasks.forEach(function (k) {
      if (P.lines[k.line] === ref.raw && (!best || Math.abs(k.line - ref.line) < Math.abs(best.line - ref.line))) best = k;
    });
    return best;
  }

  // Run an action: re-validate, build changes, ONE transaction.
  function mutate(ref, build, opts) {
    opts = opts || {};
    var ed = Cade.editor;
    if (!ed || !panelEl) return null;
    if (ed.state.readOnly) {
      toast('Read-only mode \u2014 editing is locked', 'error', 2000);
      S.html = ''; refresh({ force: true });
      return null;
    }
    var task = null;
    if (ref) {
      task = syncRef(ref);
      if (!task) { toast('The list changed \u2014 try again'); S.html = ''; refresh({ force: true }); return null; }
    } else if (ed.state.doc !== S.doc || activeRoom() !== S.room) { reparse(); S.room = activeRoom(); }
    var res = build(S.P, task);
    if (!res || !res.changes || !res.changes.length) { S.html = ''; refresh({ force: true }); return null; }
    var hadFocus = panelEl.contains(document.activeElement);
    ed.dispatch({ changes: res.changes, userEvent: 'input.eisenhower' });
    if (opts.haptic) Cade.haptic(8);
    if (opts.toast) toast(opts.toast, 'success', 1600);
    var focus = null;
    if (opts.focusLine != null) focus = opts.focusLine(res, task);
    else if (task && hadFocus && opts.focus !== false) focus = task.line;
    refresh({ force: true, reparse: true, focus: focus });
    return res;
  }

  // ---- rendering -----------------------------------------------------------------
  function cardHtml(t) {
    var text = Model.displayText(t.clean), ro = S.ro, flash = S.flash && S.flash[t.line] ? ' em-flash' : '';
    var label = text.replace(/[*_`~]/g, '').trim() || 'Empty task';
    return '<div class="em-card' + (t.done ? ' em-done' : '') + (t.depth ? ' em-nested' : '') + flash + '" tabindex="0" role="listitem" data-line="' + t.line +
      '" aria-label="' + esc((t.done ? 'Done: ' : '') + label.slice(0, 120)) + '">' +
      '<input type="checkbox" class="em-cb" tabindex="-1"' + (t.done ? ' checked' : '') + (ro ? ' disabled' : '') + ' aria-label="Done">' +
      '<div class="em-body"><div class="em-text">' + (t.depth ? '<span class="em-sub-mark" aria-hidden="true" title="Sub-task">\u21b3</span>' : '') +
        (text ? inline(text, t.done) : '<span class="em-placeholder">(empty)</span>') + '</div></div>' +
      '<div class="em-acts">' +
        (ro ? '' : '<button type="button" class="em-icon em-edit" tabindex="-1" title="Edit (Enter / double-click)" aria-label="Edit task">\u270e</button>') +
        '<button type="button" class="em-icon em-goto" tabindex="-1" title="Show in editor" aria-label="Show in editor">\u2197</button>' +
      '</div></div>';
  }

  function listHtml(q, tasks) {
    var h = '', shown = 0;
    for (var k = 0; k < tasks.length && shown < LIST_CAP; k++) { h += cardHtml(tasks[k]); shown++; }
    if (tasks.length > shown) h += '<div class="em-more">+' + (tasks.length - shown) + ' more \u2014 tick or move some to see them</div>';
    if (!tasks.length) h += '<div class="em-empty">' + (q === 0 ? 'Nothing unsorted' : S.ro ? 'Empty' : 'Drop tasks here') + '</div>';
    return h;
  }

  function addHtml(q) {
    if (S.ro) return '';
    if (S.addQ !== q) return '';
    return '<div class="em-adding"><textarea class="em-input em-add-input" rows="1" enterkeyhint="done" placeholder="New task \u2014 Enter adds (one per line)" aria-label="New task"></textarea>' +
      '<div class="em-row"><button type="button" class="em-btn primary em-add-ok">Add</button><button type="button" class="em-btn em-add-cancel">Cancel</button>' +
      '<span class="em-add-where">\u2192 under \u201c## Tasks\u201d</span></div></div>';
  }

  function countHtml(open, done) {
    var title = open + ' open' + (done ? ', ' + done + ' done' : '');
    return '<span class="em-count" title="' + esc(title) + '">' + open + (done && !prefs.hideDone ? '<span class="em-count-done">+' + done + '\u2713</span>' : '') + '</span>';
  }

  function mainHtml() {
    var P = S.P, groups = [[], [], [], [], []], open = [0, 0, 0, 0, 0], done = [0, 0, 0, 0, 0];
    P.tasks.forEach(function (t) {
      if (t.done) done[t.q]++; else open[t.q]++;
      if (!(prefs.hideDone && t.done)) groups[t.q].push(t);
    });
    var addBtn = function (q) {
      return S.ro ? '' : '<button type="button" class="em-icon em-add" title="Add a task here" aria-label="Add a task to ' + esc(QUADS[q].name) + '">+</button>';
    };
    var trayOpen = prefs.trayOpen;
    var h = '<div class="em-tray' + (trayOpen ? '' : ' em-closed') + '" data-q="0" aria-label="Unsorted tasks">' +
      '<div class="em-tray-head">' +
        '<button type="button" class="em-tray-tog" aria-expanded="' + trayOpen + '"><span class="em-caret" aria-hidden="true">' + (trayOpen ? '\u25be' : '\u25b8') + '</span> Unsorted ' + countHtml(open[0], done[0]) + '</button>' +
        addBtn(0) +
      '</div>' +
      (trayOpen ? '<div class="em-list em-tray-list" role="list">' + listHtml(0, groups[0]) + '</div>' + addHtml(0) : '') +
    '</div>';
    if (!P.tasks.length) {
      h += '<div class="em-es" role="note">No todos in this document yet. Tap <b>+</b> on a quadrant to add one (it goes under a <code>## Tasks</code> heading), ' +
        'or write <code>- [ ] task</code> lines anywhere \u2014 they show up in Unsorted.</div>';
    }
    h += '<div class="em-grid">' +
      '<div class="em-corner" aria-hidden="true"></div>' +
      '<div class="em-axis em-axis-x" aria-hidden="true">Urgent</div><div class="em-axis em-axis-x" aria-hidden="true">Not urgent</div>';
    [1, 2, 3, 4].forEach(function (q) {
      if (q === 1) h += '<div class="em-axis em-axis-y" aria-hidden="true"><span>Important</span></div>';
      if (q === 3) h += '<div class="em-axis em-axis-y" aria-hidden="true"><span>Not important</span></div>';
      var Q = QUADS[q];
      h += '<section class="em-q em-q' + q + '" data-q="' + q + '" aria-label="' + esc(Q.name + ' \u2014 ' + Q.sub) + '">' +
        '<header class="em-q-head"><span class="em-q-icon" aria-hidden="true">' + Q.icon + '</span><span class="em-q-name">' + esc(Q.name) + '</span>' +
          countHtml(open[q], done[q]) + addBtn(q) + '</header>' +
        '<div class="em-q-sub">' + esc(Q.sub) + '</div>' +
        '<div class="em-list" role="list">' + listHtml(q, groups[q]) + '</div>' + addHtml(q) +
      '</section>';
    });
    return h + '</div>';
  }

  function renderBar() {
    var p = panelEl, P = S.P;
    var total = P ? P.tasks.length : 0, done = 0;
    if (P) P.tasks.forEach(function (t) { if (t.done) done++; });
    p.querySelector('.em-sum').textContent = total ? total + ' task' + (total === 1 ? '' : 's') + (done ? ' \u00b7 ' + done + ' done' : '') : '';
    p.querySelector('.em-ro').hidden = !S.ro;
    var tog = p.querySelector('.em-hide-tog');
    tog.classList.toggle('on', prefs.hideDone);
    tog.setAttribute('aria-pressed', prefs.hideDone ? 'true' : 'false');
    var s = S.sentinel, hint = p.querySelector('.em-tags');
    var tags = s + 'urgent ' + s + 'important \u2192 Do first \u00b7 ' + s + 'important \u2192 Schedule \u00b7 ' + s + 'urgent \u2192 Delegate \u00b7 ' + s + 'someday \u2192 Eliminate \u00b7 none \u2192 Unsorted';
    if (hint.textContent !== tags) hint.textContent = tags;
  }

  function render(focusLine) {
    var p = panelEl;
    if (!p || !S.P) return;
    TODAY = ymd(new Date());
    renderBar();
    var main = p.querySelector('.em-main');
    var html = mainHtml();
    if (html !== S.html) {
      closeMenu();
      var tops = {}, ae = document.activeElement, keep = null;
      [].forEach.call(main.querySelectorAll('[data-q] .em-list'), function (l) { tops[zoneOf(l)] = l.scrollTop; });
      if (ae && main.contains(ae)) {
        var c = ae.closest('.em-card');
        if (c) keep = intAttr(c, 'data-line');
        else if (ae.classList.contains('em-add-input')) S.focusAdd = true;
      }
      var mainTop = main.scrollTop;
      main.innerHTML = html;
      S.html = html;
      main.scrollTop = mainTop;
      [].forEach.call(main.querySelectorAll('[data-q] .em-list'), function (l) { var t = tops[zoneOf(l)]; if (t) l.scrollTop = t; });
      if (focusLine == null && keep != null && keep >= 0) focusLine = keep;
      var ta = main.querySelector('.em-add-input');
      if (ta) {
        ta.value = S.addDraft;
        autosize(ta);
        if (S.focusAdd) {
          S.focusAdd = false;
          ta.focus();
          try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
          ta.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
    }
    if (focusLine != null && focusLine >= 0) focusCard(focusLine);
  }

  function cardEl(line) { return panelEl ? panelEl.querySelector('.em-card[data-line="' + line + '"]') : null; }
  function focusCard(line) {
    var el = cardEl(line);
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 160) + 'px'; }
  function flashLines(lines) {
    S.flash = {};
    lines.forEach(function (l) { S.flash[l] = 1; });
    setTimeout(function () { S.flash = null; if (panelEl) { S.html = ''; render(); } }, 1200);
  }

  // ---- actions ----------------------------------------------------------------------
  function toggleAt(ref) {
    mutate(ref, function (P, t) { return Model.toggleDone(P, t); }, { haptic: true });
  }
  function moveTo(ref, q, focus) {
    mutate(ref, function (P, t) { return Model.setQuadrant(P, t, q, S.sentinel); }, {
      haptic: true, focus: focus,
      focusLine: focus ? function (res, t) { return t.line; } : null,
      // the card visibly lands — only say where it went when that's out of sight
      toast: q === 0 && !prefs.trayOpen ? 'Moved to Unsorted' : null,
    });
  }
  function jumpToLine(line) {
    var ed = Cade.editor, doc = ed.state.doc;
    if (line < 0 || line >= doc.lines) return;
    var l = doc.line(line + 1), EV = Cade.CM && Cade.CM.EditorView;
    var spec = { selection: { anchor: l.to } };
    if (EV && EV.scrollIntoView) spec.effects = EV.scrollIntoView(l.from, { y: 'center' });
    ed.dispatch(spec);
    ed.focus();
  }
  function gotoAt(ref) {
    var t = syncRef(ref);
    if (!t) { toast('The list changed \u2014 try again'); refresh({ force: true }); return; }
    jumpToLine(t.line);
  }

  // -- edit in place --
  function startEdit(ref) {
    if (S.ro || S.editing || !ref) return;
    var t = Model.taskAt(S.P, ref.line), el = cardEl(ref.line);
    if (!t || !el) return;
    closeMenu();
    var val = Model.editText(t);
    var body = el.querySelector('.em-body');
    body.innerHTML = '<textarea class="em-input em-edit-input" rows="1" enterkeyhint="done" aria-label="Task text"></textarea>' +
      '<div class="em-edit-hint"><span>Enter saves \u00b7 Esc cancels \u00b7 tags move it</span>' +
      '<button type="button" class="em-btn em-edit-goto" title="Save and show the line in the editor">\u2197 In editor</button></div>';
    el.classList.add('em-editing');
    S.html = '';
    var ta = body.querySelector('textarea');
    ta.value = val;
    S.editing = { ref: ref, orig: val, el: ta };
    autosize(ta);
    ta.focus();
    try { ta.setSelectionRange(val.length, val.length); } catch (e) {}
    ta.addEventListener('input', function () { autosize(ta); });
    ta.addEventListener('blur', function () { if (S.editing && S.editing.el === ta) commitEdit(false); });
  }
  function commitEdit(cancel) {
    var E = S.editing;
    if (!E) return;
    S.editing = null;
    var v = E.el.value;
    if (cancel || v === E.orig || !v.trim()) { S.html = ''; refresh({ force: true, focus: cancel ? E.ref.line : null }); return; }
    mutate(E.ref, function (P, t) { return Model.editTask(P, t, v); }, { focusLine: function (res, t) { return t.line; } });
  }

  // -- add --
  function openAdd(q) {
    if (S.ro) return;
    if (S.addQ !== q) S.addDraft = '';
    S.addQ = q; S.focusAdd = true; S.html = '';
    if (q === 0 && !prefs.trayOpen) { prefs.trayOpen = true; savePrefs(); }
    render();
  }
  function closeAdd() { S.addQ = -1; S.addDraft = ''; S.html = ''; render(); }
  function commitAdd() {
    var ta = panelEl.querySelector('.em-add-input');
    var v = ta ? ta.value : S.addDraft, q = S.addQ;
    var texts = String(v).split(/\r?\n/);
    if (!texts.join('').trim()) { if (ta) ta.focus(); return; }
    S.addDraft = ''; S.focusAdd = true;
    var res = mutate(null, function (P) { return Model.addTasks(P, q, texts, S.sentinel); }, { focus: false });
    if (res) {
      var lines = [];
      for (var k = 0; k < res.count; k++) lines.push(res.firstLine + k);
      flashLines(lines);
      S.html = ''; render();
      toast(res.count === 1 ? 'Task added to ' + QUADS[q].name : res.count + ' tasks added to ' + QUADS[q].name, 'success', 1500);
    }
  }

  // -- summary --
  function summaryText() {
    return Model.summary(S.P, { hideDone: prefs.hideDone, date: ymd(new Date()) });
  }
  function insertSummary() {
    var ed = Cade.editor;
    if (!ed || !S.P) return;
    mutate(null, function (P) {
      var line = 0;
      try { line = ed.state.doc.lineAt(ed.state.selection.main.head).number - 1; } catch (e) {}
      return Model.insertBlock(P, line, Model.summary(P, { hideDone: prefs.hideDone, date: ymd(new Date()) }).split('\n'));
    }, { toast: 'Summary inserted \u2014 Ctrl+Z to undo', focus: false });
  }

  // -- menu --
  function closeMenu() { if (S.menu) { S.menu.remove(); S.menu = null; } }
  function toggleMenu(btn) {
    if (S.menu) { closeMenu(); return; }
    var m = document.createElement('div');
    m.className = 'em-menu';
    m.setAttribute('role', 'menu');
    m.innerHTML =
      (S.ro ? '' : '<button type="button" role="menuitem" class="em-menu-item" data-act="insert">\u2913 Insert summary at cursor</button>') +
      '<button type="button" role="menuitem" class="em-menu-item" data-act="copy">\u29c9 Copy summary as markdown</button>' +
      '<button type="button" role="menuitem" class="em-menu-item" data-act="tasks">\u2197 Show \u201c## Tasks\u201d in editor</button>';
    panelEl.appendChild(m);
    var pr = panelEl.getBoundingClientRect(), br = btn.getBoundingClientRect();
    m.style.left = Math.max(6, Math.min(br.right - pr.left - m.offsetWidth, pr.width - m.offsetWidth - 6)) + 'px';
    m.style.top = (br.bottom - pr.top + 2) + 'px';
    S.menu = m;
    var first = m.querySelector('button');
    if (first && panelEl.contains(document.activeElement)) first.focus();
  }
  function menuAction(act) {
    closeMenu();
    if (act === 'insert') insertSummary();
    else if (act === 'copy') copyText(summaryText(), 'summary');
    else if (act === 'tasks') {
      if (Cade.editor && Cade.editor.state.doc !== S.doc) reparse();
      var hk = Model.findTasksHeading(S.P);
      if (hk >= 0) jumpToLine(S.P.heads[hk].line);
      else toast('No \u201c## Tasks\u201d heading yet \u2014 adding a task creates one');
    }
  }

  // ---- pointer: tap ticks, drag moves, long-press / double-click edits ---------------
  // Mouse/pen: drag after a 6px move; click ticks (deferred a beat so a double
  // click can edit instead). Touch: tap ticks; long-press (350ms) lifts the
  // card — move it to drag, or let go to edit. A plain swipe still scrolls.
  function onPointerDown(e) {
    S.pointerType = e.pointerType || 'mouse';
    if (S.ro || S.drag || S.press || e.button > 0) return;
    var t = e.target, card = t.closest && t.closest('.em-card');
    if (!card || !panelEl.contains(card) || card.classList.contains('em-editing')) return;
    if (t.closest('input, textarea, button, a, select')) return;
    S.press = {
      id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, el: card,
      ref: cardRef(card), q: zoneOf(card), touch: e.pointerType === 'touch', timer: 0, lifted: false,
    };
    if (S.press.touch) {
      S.press.timer = setTimeout(function () {
        if (!S.press || S.drag) return;
        S.press.lifted = true;
        S.press.el.classList.add('em-lifted');
        Cade.haptic(10);
      }, 350);
    }
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
  }
  function onPointerMove(e) {
    var pr = S.press;
    if (!pr || e.pointerId !== pr.id) return;
    pr.lx = e.clientX; pr.ly = e.clientY;
    if (!S.drag) {
      var d = Math.abs(e.clientX - pr.x) + Math.abs(e.clientY - pr.y);
      if (pr.touch && !pr.lifted) { if (d > 10) endPress(); return; }   // a scroll, not a drag
      if (d < (pr.touch ? 8 : 6)) return;
      startDrag();
    }
    e.preventDefault();
    moveGhost();
    updateTarget();
  }
  function onPointerUp(e) {
    var pr = S.press;
    if (!pr || e.pointerId !== pr.id) return;
    if (S.drag) { drop(); endPress(); return; }
    var lifted = pr.lifted, ref = pr.ref;
    endPress();
    if (lifted) { S.suppressClick = Date.now(); startEdit(ref); }   // long-press without moving = edit
  }
  function onPointerCancel() { if (S.drag) cancelDrag(); endPress(); }
  function endPress() {
    if (S.press) { clearTimeout(S.press.timer); if (S.press.el) S.press.el.classList.remove('em-lifted'); }
    S.press = null;
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerCancel, true);
    if (S.pending && !S.drag && !S.editing) refresh();
  }
  function startDrag() {
    var pr = S.press;
    if (!pr || !pr.el.isConnected) return;
    clearTimeout(pr.timer);
    closeMenu();
    clearTimeout(S.clickTimer);
    var el = pr.el, r = el.getBoundingClientRect();
    var ghost = el.cloneNode(true);
    ghost.classList.add('em-ghost');
    ghost.classList.remove('em-lifted');
    ghost.removeAttribute('tabindex');
    ghost.style.width = r.width + 'px';
    document.body.appendChild(ghost);
    el.classList.add('em-dragging');
    panelEl.classList.add('em-is-dragging');
    document.documentElement.classList.add('em-noselect');
    window.addEventListener('keydown', onDragKey, true);
    S.drag = { el: el, ghost: ghost, offX: pr.x - r.left, offY: pr.y - r.top, from: pr.q, target: pr.q, zoneEl: null };
    moveGhost();
    if (!pr.touch) Cade.haptic(10);
  }
  function moveGhost() {
    var d = S.drag, pr = S.press;
    if (!d || !pr) return;
    d.ghost.style.left = (pr.lx - d.offX) + 'px';
    d.ghost.style.top = (pr.ly - d.offY) + 'px';
  }
  function updateTarget() {
    var d = S.drag, pr = S.press;
    if (!d || !pr) return;
    var hit = document.elementFromPoint(pr.lx, pr.ly);
    var zone = hit && hit.closest ? hit.closest('[data-q]') : null;
    if (!zone || !panelEl.contains(zone)) return;   // keep the last valid target
    d.target = intAttr(zone, 'data-q');
    if (d.zoneEl !== zone) {
      if (d.zoneEl) d.zoneEl.classList.remove('em-drop');
      zone.classList.add('em-drop');
      d.zoneEl = zone;
    }
  }
  function teardownDrag() {
    var d = S.drag;
    if (!d) return;
    d.ghost.remove();
    d.el.classList.remove('em-dragging');
    if (d.zoneEl) d.zoneEl.classList.remove('em-drop');
    if (panelEl) panelEl.classList.remove('em-is-dragging');
    document.documentElement.classList.remove('em-noselect');
    window.removeEventListener('keydown', onDragKey, true);
    S.drag = null;
  }
  function onDragKey(e) {
    if (e.key !== 'Escape' || !S.drag) return;
    if (Cade.isMinimized && Cade.isMinimized(panelEl)) return; // parked in the dock: keys belong to the editor
    e.preventDefault(); e.stopPropagation();
    cancelDrag();
    endPress();
  }
  function drop() {
    var d = S.drag, ref = S.press && S.press.ref;
    teardownDrag();
    S.justDragged = Date.now();
    if (ref && d.target >= 0 && d.target !== d.from) moveTo(ref, d.target, false);
    else { S.html = ''; refresh({ force: true }); }
  }
  function cancelDrag() { teardownDrag(); S.html = ''; refresh({ force: true }); }

  // ---- events ------------------------------------------------------------------------
  function onClick(e) {
    var t = e.target, b;
    if (!t.closest) return;
    if (Date.now() - S.justDragged < 350) { e.preventDefault(); return; }
    // The click a touch long-press (→ edit) leaves behind must not tick the card.
    if (Date.now() - S.suppressClick < 600 && t.closest('.em-card')) { e.preventDefault(); return; }
    if (S.menu && !t.closest('.em-menu') && !t.closest('.em-menu-btn')) closeMenu();
    if ((b = t.closest('.em-menu-item'))) { menuAction(b.getAttribute('data-act')); return; }
    if (t.closest('.em-menu-btn')) { toggleMenu(t.closest('.em-menu-btn')); return; }
    if (t.closest('.em-hide-tog')) {
      prefs.hideDone = !prefs.hideDone; savePrefs();
      S.html = ''; refresh({ force: true });
      return;
    }
    if (t.closest('.em-tray-tog')) { prefs.trayOpen = !prefs.trayOpen; savePrefs(); S.html = ''; render(); return; }
    if ((b = t.closest('.em-add'))) { openAdd(zoneOf(b)); return; }
    if (t.closest('.em-add-ok')) { commitAdd(); return; }
    if (t.closest('.em-add-cancel')) { closeAdd(); return; }
    if ((b = t.closest('.em-goto'))) { gotoAt(cardRef(b)); return; }
    if (t.closest('.em-edit-goto')) {
      var line = S.editing ? S.editing.ref.line : -1;
      commitEdit(false);
      if (line >= 0) jumpToLine(line);
      return;
    }
    if ((b = t.closest('.em-edit'))) { startEdit(cardRef(b)); return; }
    if (t.closest('.em-cb, a, textarea, input')) return;
    var card = t.closest('.em-card');
    if (!card || card.classList.contains('em-editing') || S.ro) return;
    var ref = cardRef(card);
    clearTimeout(S.clickTimer);
    if (S.pointerType === 'touch' || S.pointerType === 'pen') { toggleAt(ref); return; }
    if (e.detail >= 2) return;                                     // the dblclick handler edits
    // A mouse click ticks after a beat, so a double-click can edit instead.
    S.clickTimer = setTimeout(function () { toggleAt(ref); }, e.detail === 0 ? 0 : 240);
  }
  function onDblClick(e) {
    var t = e.target;
    if (!t.closest || S.ro) return;
    if (t.closest('input, textarea, button, a')) return;
    var c = t.closest('.em-card');
    if (c && !c.classList.contains('em-editing')) { clearTimeout(S.clickTimer); e.preventDefault(); startEdit(cardRef(c)); }
  }
  function onChange(e) {
    var t = e.target;
    if (t.classList.contains('em-cb')) toggleAt(cardRef(t));
  }
  function onInput(e) {
    var t = e.target;
    if (t.classList.contains('em-add-input')) { S.addDraft = t.value; autosize(t); }
  }
  function onFocusOut(e) {
    // An empty "add" box closes when focus leaves it; a draft stays open.
    var t = e.target;
    if (t.classList && t.classList.contains('em-add-input') && !t.value.trim()) {
      setTimeout(function () {
        var ae = document.activeElement;
        if (S.addQ >= 0 && !S.addDraft.trim() && !(ae && ae.closest && ae.closest('.em-adding'))) closeAdd();
      }, 0);
    }
  }

  function navFocus(cardElm, dir) {
    var zone = cardElm.closest('[data-q]'), q = intAttr(zone, 'data-q');
    var cards = [].slice.call(zone.querySelectorAll('.em-card')), i = cards.indexOf(cardElm), next = null;
    if (dir === 'up') next = cards[i - 1];
    else if (dir === 'down') next = cards[i + 1];
    else {
      var to = { 1: 2, 2: 1, 3: 4, 4: 3, 0: 1 }[q];
      if (dir === 'left' && (q === 1 || q === 3)) to = null;
      if (dir === 'right' && (q === 2 || q === 4)) to = null;
      if (to != null) {
        var cc = panelEl.querySelectorAll('[data-q="' + to + '"] .em-card');
        if (cc.length) next = cc[Math.min(i, cc.length - 1)];
      }
    }
    if (next) { try { next.focus({ preventScroll: true }); } catch (e) { next.focus(); } next.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }

  function onKey(e) {
    var t = e.target, k = e.key, mod = e.ctrlKey || e.metaKey;
    var field = t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'checkbox');
    if (field) {
      e.stopPropagation();                       // typing here must not trigger editor / global shortcuts
      var cl = t.classList;
      if (cl.contains('em-edit-input')) {
        if (k === 'Enter' && !e.isComposing) { e.preventDefault(); commitEdit(false); }
        else if (k === 'Escape') { e.preventDefault(); commitEdit(true); }
      } else if (cl.contains('em-add-input')) {
        if (k === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); commitAdd(); }
        else if (k === 'Escape') { e.preventDefault(); closeAdd(); }
      }
      return;
    }
    var handled = true, card = t.closest && t.closest('.em-card'), ref = card ? cardRef(card) : null;
    if (k === 'Escape') {
      if (S.drag) { cancelDrag(); endPress(); }
      else if (S.menu) closeMenu();
      else close(true);
    } else if (mod && !e.altKey && (k === 'z' || k === 'Z' || k === 'y' || k === 'Y')) {
      // Undo/redo the document from inside the panel (focus is not in the editor).
      var redo = k === 'y' || k === 'Y' || e.shiftKey, ed = Cade.editor, fn = Cade.CM && (redo ? Cade.CM.redo : Cade.CM.undo);
      if (ed && fn) { fn(ed); refresh({ force: true, reparse: true }); }
    } else if (ref && !mod && !e.altKey && /^[0-4]$/.test(k)) {
      if (!S.ro) moveTo(ref, +k, true);
    } else if (ref && !mod && (k === 'u' || k === 'U')) {
      if (!S.ro) moveTo(ref, 0, true);
    } else if (card && !mod && /^Arrow/.test(k)) {
      navFocus(card, k.slice(5).toLowerCase());
    } else if (ref && !mod && (k === 'Enter' || k === 'F2')) {
      startEdit(ref);
    } else if (ref && !mod && (k === ' ' || k === 'x')) {
      if (!S.ro) toggleAt(ref);
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }
  // Once a touch drag has started, stop the browser from also scrolling.
  function onTouchMove(e) { if (S.drag || (S.press && S.press.lifted)) e.preventDefault(); }
  function onContextMenu(e) { if (S.press || S.drag) e.preventDefault(); }
  function onMouseDown(e) {
    // Keep focus in the add box when its buttons are clicked.
    if (e.target.closest && e.target.closest('.em-add-ok, .em-add-cancel, .em-edit-goto')) e.preventDefault();
  }
  function onResize() {
    if (!panelEl) return;
    var r = panelEl.getBoundingClientRect();
    if (r.right > window.innerWidth) panelEl.style.left = Math.max(0, window.innerWidth - r.width - 8) + 'px';
    if (r.top > window.innerHeight - 60) panelEl.style.top = Math.max(0, window.innerHeight - 120) + 'px';
    panelEl.classList.toggle('em-coarse', isCoarse());
  }

  function poll() {
    if (!panelEl || !panelEl.isConnected) { cleanup(); return; }
    if (document.hidden) return;
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.doc !== S.doc || !!ed.state.readOnly !== S.ro || activeRoom() !== S.room || sentinelNow() !== S.sentinel) refresh();
  }

  // Update hook: a cheap no-op while the panel is closed or nothing changed.
  Cade.onEditorUpdate(function (u) {
    if (!panelEl || !u.docChanged) return;
    scheduleRefresh(150);
  });

  // ---- open / close ---------------------------------------------------------------------
  function cleanup() {
    clearTimeout(refreshTimer); clearInterval(pollTimer); clearTimeout(S.clickTimer);
    refreshTimer = pollTimer = 0;
    if (S.drag) teardownDrag();
    endPress();
    closeMenu();
    window.removeEventListener('resize', onResize);
    panelEl = null;
    S = freshState();
  }
  function close(focusEditor) {
    var p = panelEl;
    if (p) { p.remove(); cleanup(); }
    if (focusEditor && Cade.editor) { try { Cade.editor.focus(); } catch (e) {} }
  }

  function open() {
    Cade.closeAllMenus();
    if (panelEl && panelEl.isConnected) { close(false); return; }
    loadPrefs();
    S = freshState();
    var p = Cade.mkPanel(PANEL_ID, '\ud83c\udfaf Eisenhower Matrix',
      '<div class="em-bar">' +
        '<button type="button" class="em-tog em-hide-tog" aria-pressed="false" title="Hide ticked-off tasks">\u2713 Hide done</button>' +
        '<span class="em-sum" aria-live="polite"></span>' +
        '<span class="em-ro" hidden title="Read-only mode is on \u2014 the matrix is view-only">\ud83d\udd12 Read-only</span>' +
        '<button type="button" class="em-icon em-menu-btn" title="Summary\u2026" aria-haspopup="menu" aria-label="More actions">\u22ef</button>' +
      '</div>' +
      '<div class="em-main"></div>' +
      '<div class="em-hint"><div class="em-tags"></div>' +
        '<div class="em-hint-fine">Drag to move (rewrites the tags) \u00b7 click to tick \u00b7 double-click to edit \u00b7 focused card: 1\u20134 / 0 move, Space ticks, Ctrl+Z undoes</div>' +
        '<div class="em-hint-coarse">Long-press &amp; drag to move \u00b7 tap to tick \u00b7 long-press to edit \u00b7 + adds</div>' +
      '</div>');
    panelEl = p;
    var w = Math.min(760, window.innerWidth - 24);
    p.style.left = Math.max(12, Math.round((window.innerWidth - w) / 2)) + 'px';
    p._onClose = cleanup;
    p.addEventListener('click', onClick);
    p.addEventListener('dblclick', onDblClick);
    p.addEventListener('change', onChange);
    p.addEventListener('input', onInput);
    p.addEventListener('focusout', onFocusOut);
    p.addEventListener('keydown', onKey);
    p.addEventListener('pointerdown', onPointerDown);
    p.addEventListener('mousedown', onMouseDown);
    p.addEventListener('contextmenu', onContextMenu);
    p.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('resize', onResize);
    pollTimer = setInterval(poll, 800);
    p.classList.toggle('em-coarse', isCoarse());
    refresh({ force: true });
  }

  Cade.registerWidget({
    name: 'Eisenhower Matrix',
    description: 'Sort the document\u2019s todos into Do first / Schedule / Delegate / Eliminate by urgency & importance',
    icon: '\ud83c\udfaf',
    tags: 'eisenhower,matrix,priority,prioritize,urgent,important,todo,tasks,quadrant,triage,checklist,planning',
    open: open,
  });
})();
