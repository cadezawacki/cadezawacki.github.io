/* Snippet abbreviations — type a snippet's abbreviation in a note and it
 * expands into the snippet (placeholders and all; {{input:…}} fields open the
 * small fill-in form first). The library is the Snippets widget's
 * (Cade.syncedBlob('snippets')); this file only watches for the trigger keys.
 *
 * The rule (robust and unsurprising):
 *   - the word right before the caret must be <trigger><letters…> — trigger is
 *     ";" by default (Snippets → ⋯ → Options) — with nothing but a space, the
 *     line start or an opening bracket / quote / * _ before the trigger, so
 *     "a;b", "x=1;y", URLs and paths never fire, and ";;sig" stays text;
 *   - Tab expands an exact abbreviation, or the only one starting with what
 *     was typed (";mt" → ";mtg");
 *   - Space / Enter expand an EXACT abbreviation (Options can turn this off).
 *     A one-line expansion keeps the Space; on Enter it goes in and the line
 *     break follows normally (lists continue).
 *   - never inside ``` code fences (unless enabled in Options) or `inline
 *     code`, in read-only mode, with a selection / several carets, or during
 *     IME composition. One Undo restores the abbreviation.
 *
 * Cost on normal typing: Space goes through a CM inputHandler that returns at
 * the first check for every other character; Tab / Enter are seen by one
 * capture keydown listener that returns unless the key is Tab or Enter. The
 * snippet data is touched only when the word before the caret starts with the
 * trigger, and the shared core (widgets/snippets/snippets-core.js) is loaded
 * only on the first real match — that first expansion completes a moment later
 * (positions are mapped through any typing meanwhile). */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var CM = Cade.CM;
  if (!CM || !CM.ViewPlugin || !CM.EditorView) return;

  var ViewPlugin = CM.ViewPlugin, EditorView = CM.EditorView;
  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
  var CORE_URL = abs(Cade.asset('../../widgets/snippets/snippets-core.js'));
  var ANDROID = /Android\b/.test(navigator.userAgent || '');
  // Starter abbreviations: until the library is first saved the starters are
  // virtual, so the plugin knows them without loading the core. 1 = uses the
  // clipboard. MUST match STARTERS in snippets-core.js (snippets.test.js checks).
  var STARTERS = { ';mtg': 0, ';jrnl': 0, ';week': 0, ';bug': 0, ';ty': 0, ';fu': 0, ';no': 0, ';sig': 0, ';ts': 0, ';today': 0, ';link': 1 };
  var CLIP_RE = /\{\{\s*clipboard\s*\}\}/i;
  var BEFORE_OK = /[\s([{<"'“‘*_~>]/; // may precede the trigger
  var MAXW = 40;                                // longest word looked at

  // The trigger char lives in the synced options; a per-device copy (written by
  // the core) lets us reject ordinary words without touching the library.
  var trig = ';';
  try { var t0 = Cade.store.get('cade-snippets-trigger'); if (t0 && t0.length === 1 && !/[\sA-Za-z0-9{}\\]/.test(t0)) trig = t0; } catch (e) {}

  function core() { return window.__cadeSnippets || null; }
  function loadCore() {
    if (core()) return Promise.resolve(core());
    if (window.__cadeSnippetsLoading) return window.__cadeSnippetsLoading;
    var p = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = CORE_URL;
      s.async = true;
      s.onload = function () { if (core()) res(core()); else rej(new Error('Snippets did not load')); };
      s.onerror = function () { rej(new Error('Could not load Snippets')); };
      document.head.appendChild(s);
    });
    window.__cadeSnippetsLoading = p;
    p.catch(function () { if (window.__cadeSnippetsLoading === p) window.__cadeSnippetsLoading = null; });
    return p;
  }

  // ---- library, without the core: abbreviation → {clip} + options ------------
  var blob = null, liteRaw, liteIdx = null, liteOpts = null;
  function lite() {
    if (!blob) { try { blob = Cade.syncedBlob('snippets'); } catch (e) { blob = { get: function () { return null; } }; } }
    var d = blob.get();
    if (liteIdx && d === liteRaw) return liteIdx;
    liteRaw = d; liteIdx = {}; liteOpts = { trigger: ';', space: true, fences: false };
    var list = d && typeof d === 'object' && Array.isArray(d.snippets) ? d.snippets : null, k;
    if (!list) { for (k in STARTERS) liteIdx[k] = { clip: !!STARTERS[k] }; }
    else {
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (s && typeof s.abbr === 'string' && s.abbr && !/\s/.test(s.abbr)) {
          k = s.abbr.toLowerCase();
          if (!liteIdx[k]) liteIdx[k] = { clip: typeof s.body === 'string' && CLIP_RE.test(s.body) };
        }
      }
    }
    var o = d && d.opts;
    if (o && typeof o === 'object') {
      if (typeof o.trigger === 'string' && o.trigger.length === 1 && !/[\sA-Za-z0-9{}\\]/.test(o.trigger)) liteOpts.trigger = o.trigger;
      if (o.space === false) liteOpts.space = false;
      if (o.fences === true) liteOpts.fences = true;
    }
    if (liteOpts.trigger !== trig) { trig = liteOpts.trigger; try { Cade.store.set('cade-snippets-trigger', trig); } catch (e) {} }
    return liteIdx;
  }
  function liteFind(word, prefix) {
    var idx = lite(), k = word.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(idx, k)) return idx[k];
    if (!prefix || k.length < 2) return null;
    var hit = null;
    for (var a in idx) if (Object.prototype.hasOwnProperty.call(idx, a) && a.indexOf(k) === 0) { if (hit) return null; hit = idx[a]; }
    return hit;
  }

  // ---- the word before the caret ------------------------------------------------
  function inFence(pos) { try { return !!(Cade.inCodeFence && Cade.inCodeFence(pos)); } catch (e) { return false; } }
  function composing(view) { return ANDROID ? view.composing : view.compositionStarted; }
  // {from, to, word} when the text right before `head` is trigger + word.
  function tokenAt(state, head, t) {
    var line = state.doc.lineAt(head);
    if (head === line.from || line.length > 2000) return null;
    var a = Math.max(line.from, head - MAXW), s = state.doc.sliceString(a, head);
    var i = s.lastIndexOf(t);
    if (i < 0 || i === s.length - 1) return null;
    var word = s.slice(i);
    if (/[\s{}]/.test(word)) return null;
    var from = a + i;
    if (from > line.from && !BEFORE_OK.test(state.doc.sliceString(from - 1, from))) return null;
    // not inside `inline code`
    var before = state.doc.sliceString(line.from, from), ticks = 0;
    for (var j = 0; j < before.length; j++) if (before.charCodeAt(j) === 96) ticks++;
    if (ticks & 1) return null;
    return { from: from, to: head, word: word };
  }

  // kind: 'tab' | 'space' | 'enter'. Returns true when the key was handled
  // (consumed), 'pass' when the snippet went in and the key should proceed.
  function attempt(view, kind) {
    var st = view.state;
    if (st.readOnly || st.selection.ranges.length !== 1 || !st.selection.main.empty || composing(view)) return false;
    var head = st.selection.main.head;
    var C = core();
    if (C) trig = C.opts().trigger; // live (and cached) once the core is here
    var tok = tokenAt(st, head, trig);
    if (!tok) return false;
    var opts = C ? C.opts() : (lite(), liteOpts);
    if (opts.trigger !== trig) { trig = opts.trigger; tok = tokenAt(st, head, trig); if (!tok) return false; }
    if (kind !== 'tab' && !opts.space) return false;
    if (!opts.fences && inFence(tok.from)) return false;
    var prefix = kind === 'tab';
    if (C) {
      var s = C.lookup(tok.word, prefix);
      if (!s) return false;
      var plan = C.plan(s);
      var simple = !plan.needsInput && plan.oneLine && !plan.cursor;
      if (kind === 'enter' && simple) {
        C.insert(view, s, { from: tok.from, to: tok.to, source: 'abbr' });
        return 'pass'; // the Enter itself goes on: newline / list continuation
      }
      C.insert(view, s, {
        from: tok.from, to: tok.to, source: 'abbr', delim: kind === 'space' ? ' ' : '',
        clip: plan.clipboard ? C.readClipboard() : null,
      });
      return true;
    }
    var hit = liteFind(tok.word, prefix);
    if (!hit) return false;
    // First use this session: the core loads, then the snippet goes in.
    var P = view.plugin(plugin);
    if (!P) return false;
    var clip = null;
    if (hit.clip) { try { clip = navigator.clipboard && navigator.clipboard.readText ? navigator.clipboard.readText().then(null, function () { return null; }) : null; } catch (e) { clip = null; } }
    P.later({ from: tok.from, to: tok.to, word: tok.word, kind: kind, clip: clip });
    return true;
  }

  // ---- view plugin: Tab / Enter listener + the pending first expansion --------------
  function Expander(view) {
    this.view = view;
    this.pend = null;
    var self = this;
    // Document-level capture: ahead of the core's own capture handlers on the
    // editor (Enter list continuation, @-injection) and of every keymap.
    this.onKey = function (e) {
      var k = e.key;
      if (k !== 'Tab' && k !== 'Enter') return;
      if (e.defaultPrevented || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.keyCode === 229) return;
      if (!self.view.contentDOM.contains(e.target)) return;
      var r = attempt(self.view, k === 'Tab' ? 'tab' : 'enter');
      if (r === true) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
    };
    document.addEventListener('keydown', this.onKey, true);
  }
  Expander.prototype.update = function (u) {
    var p = this.pend;
    if (!p || !u.docChanged) return;
    p.from = u.changes.mapPos(p.from, 1);
    p.to = u.changes.mapPos(p.to, -1);
  };
  Expander.prototype.destroy = function () {
    document.removeEventListener('keydown', this.onKey, true);
    if (this.pend) this.pend.dead = true;
    this.pend = null;
  };
  Expander.prototype.later = function (p) {
    if (this.pend) this.pend.dead = true;
    this.pend = p;
    var self = this, view = this.view;
    // A swallowed Space / Enter comes back if the snippet can't go in after all.
    var giveBack = function () {
      if (p.kind === 'tab' || p.to > view.state.doc.length || view.state.readOnly) return;
      view.dispatch({ changes: { from: p.to, insert: p.kind === 'space' ? ' ' : '\n' }, userEvent: 'input.type' });
    };
    loadCore().then(function (C) {
      if (p.dead || self.pend !== p) return;
      self.pend = null;
      var doc = view.state.doc;
      if (p.to > doc.length || p.to <= p.from || doc.sliceString(p.from, p.to).toLowerCase() !== p.word.toLowerCase()) { giveBack(); return; }
      var s = C.lookup(p.word, p.kind === 'tab');
      if (!s) { giveBack(); return; }
      C.insert(view, s, { from: p.from, to: p.to, source: 'abbr', delim: p.kind === 'space' ? ' ' : p.kind === 'enter' ? '\n' : '', clip: p.clip });
    }, function (e) {
      if (p.dead || self.pend !== p) return;
      self.pend = null;
      giveBack();
      try { Cade.showToast(e.message || 'Snippets failed to load', 'error', 3000); } catch (x) {}
    });
  };

  var plugin = ViewPlugin.fromClass(Expander);

  // Space: an input handler (soft keyboards don't always send a key event).
  // Every other character returns at the first comparison.
  var input = EditorView.inputHandler.of(function (view, from, to, text) {
    if (text !== ' ' && text !== '\u00a0') return false;
    var sel = view.state.selection.main;
    if (from !== to || from !== sel.head) return false;
    return attempt(view, 'space') === true;
  });

  // id MUST equal the manifest id (the Settings toggle re-activates it by id).
  Cade.registerPlugin({ id: 'snippet-expand', ext: [plugin, input] });
})();
