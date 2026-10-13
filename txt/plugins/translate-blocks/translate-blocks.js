/* Translate chips — a small "Translate" chip at the end of the opening line of
 * every ``` block whose info string names a language the on-device translator
 * knows: English or native names in any case (```Spanish, ```español,
 * ```Deutsch) and language tags (```es, ```es-ES, ```zh-Hant). Programming
 * languages never get one, and a bare code that is also a code-fence language
 * (pl, cs, el, ml, sv) only counts with a region (```pl-PL).
 * A pair names the direction: ```English to Spanish, ```en>es,
 * ```Spanish → French, ```to Japanese (source detected).
 *
 * Pressing it translates the block — into English, or into the pair's target —
 * and writes a ```English (```Spanish …) block directly below (pressing again
 * replaces that block). The work is done by
 * widgets/decodelab/decodelab-inline.js — Decode Lab's translator: Chrome's
 * built-in Translator where it has the language, otherwise Firefox
 * Translations (Bergamot) with a one-time model download whose size the chip
 * shows first; the download starts only on a second tap.
 *
 * Cheap: viewport-only widget decorations, rebuilt on doc / viewport /
 * read-only changes or when the translator's state changes; fence state comes
 * from a cached list of ``` line positions (core's rule: a ``` line toggles a
 * block), mapped through edits and rescanned only when an edit touches a
 * backtick or a fence line. Nothing is loaded until a chip is pressed. Hidden
 * in read-only mode. Self-contained IIFE; the language table is also exported
 * for node tests (module.exports = { langOfInfo, pairOfInfo, NAMES }). */
(function () {
  'use strict';

  // ---- language names (a copy of decodelab-translate.js's table: chips must
  // not need the translator; the tests check that the two agree) ----
  var NAMES = {
    es: 'Spanish|Español|castellano|castilian',
    fr: 'French|Français',
    de: 'German|Deutsch',
    it: 'Italian|Italiano',
    pt: 'Portuguese|Português|brazilian portuguese|brazilian|portugues do brasil',
    nl: 'Dutch|Nederlands|flemish|vlaams',
    ru: 'Russian|Русский',
    uk: 'Ukrainian|Українська',
    pl: 'Polish|Polski',
    tr: 'Turkish|Türkçe',
    'zh-Hans': 'Chinese (Simplified)|简体中文|chinese|simplified chinese|chinese simplified|mandarin|中文|汉语|普通话|简体',
    'zh-Hant': 'Chinese (Traditional)|繁體中文|traditional chinese|chinese traditional|繁體|繁体中文|正體中文',
    ja: 'Japanese|日本語|nihongo',
    ko: 'Korean|한국어',
    ar: 'Arabic|العربية',
    bg: 'Bulgarian|Български',
    bn: 'Bengali|বাংলা|bangla',
    bs: 'Bosnian|Bosanski',
    ca: 'Catalan|Català|valencian',
    cs: 'Czech|Čeština|cesky',
    da: 'Danish|Dansk',
    el: 'Greek|Ελληνικά|modern greek',
    et: 'Estonian|Eesti',
    fa: 'Persian|فارسی|farsi|dari',
    fi: 'Finnish|Suomi',
    gu: 'Gujarati|ગુજરાતી',
    he: 'Hebrew|עברית|ivrit',
    hi: 'Hindi|हिन्दी|हिंदी',
    hr: 'Croatian|Hrvatski',
    hu: 'Hungarian|Magyar',
    id: 'Indonesian|Bahasa Indonesia|indonesia',
    is: 'Icelandic|Íslenska',
    kn: 'Kannada|ಕನ್ನಡ',
    lt: 'Lithuanian|Lietuvių',
    lv: 'Latvian|Latviešu',
    ml: 'Malayalam|മലയാളം',
    ms: 'Malay|Bahasa Melayu|melayu|bahasa malaysia',
    ro: 'Romanian|Română|moldovan',
    sk: 'Slovak|Slovenčina',
    sl: 'Slovenian|Slovenščina|slovene',
    sq: 'Albanian|Shqip',
    sr: 'Serbian|Српски',
    sv: 'Swedish|Svenska',
    te: 'Telugu|తెలుగు',
    th: 'Thai|ไทย|ภาษาไทย',
    vi: 'Vietnamese|Tiếng Việt',
  };
  var AMBIG = { pl: 1, cs: 1, el: 1, ml: 1, sv: 1 };
  function normName(s) {
    s = String(s).toLowerCase();
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    return s.replace(/[\s_()\[\]{}.,:;'"`\/|*!?=+]+/g, ' ').trim();
  }
  var BY_NAME = {}, LABEL = {};
  Object.keys(NAMES).forEach(function (c) {
    var names = NAMES[c].split('|');
    LABEL[c] = names[0];
    names.forEach(function (n) { BY_NAME[normName(n)] = c; });
  });
  // fence info string -> translatable language code, or '' (English, code, anything else)
  function langOfInfo(info) {
    var raw = String(info || '').trim().replace(/^[{.]+|\}+$/g, '');
    if (!raw || raw.length > 48) return '';
    var n = normName(raw);
    if (!n) return '';
    if (BY_NAME[n]) return BY_NAME[n];
    var parts = raw.split(/[-_]/);
    if (/^[a-z]{2}$/i.test(parts[0]) && parts.every(function (p) { return /^[a-z0-9]{2,8}$/i.test(p); })) {
      var base = parts[0].toLowerCase(), rest = parts.slice(1).join('-').toLowerCase();
      if (base === 'zh') return /(^|-)(hant|tw|hk|mo)(-|$)/.test(rest) ? 'zh-Hant' : 'zh-Hans';
      if (base === 'iw') return 'he';
      return NAMES[base] && (rest || !AMBIG[base]) ? base : '';
    }
    var w = normName(raw.split(/[\s,;:(\[{]/)[0]); // "Spanish (Mexico)", "Español text"
    return w && w !== n && BY_NAME[w] ? BY_NAME[w] : '';
  }

  // English, for pairs only (an ```English block alone gets no chip)
  function isEnglish(t) {
    t = String(t).trim();
    return normName(t) === 'english' || /^en(?:[-_][a-z0-9]{2,8})*$/i.test(t);
  }
  function pairPart(t) {
    if (isEnglish(t)) return 'en';
    var c = langOfInfo(t);
    if (c) return c;
    t = String(t).trim().toLowerCase();
    return NAMES[t] && /^[a-z]{2}$/.test(t) ? t : '';
  }
  // fence info -> {from, to} ('' from = detect) or null — see decodelab-translate.js pairFromInfo
  function pairOfInfo(info) {
    var raw = String(info || '').trim().replace(/^[{.]+|\}+$/g, '');
    if (!raw || raw.length > 64) return null;
    var m = /^(.*?)\s*(?:->|=>|\u2192|>)\s*(.+)$/.exec(raw) || /^(?:(.*?)\s+)?(?:to|into)\s+(.+)$/i.exec(raw);
    if (!m) { var c = langOfInfo(raw); return c ? { from: c, to: 'en' } : null; }
    var from = m[1] ? pairPart(m[1]) : '', to = pairPart(m[2]);
    if ((m[1] && !from) || !to || from === to) return null;
    return { from: from, to: to };
  }

  if (typeof module !== 'undefined' && module.exports) { module.exports = { langOfInfo: langOfInfo, pairOfInfo: pairOfInfo, NAMES: NAMES }; return; }
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var CM = Cade.CM;
  if (!CM || !CM.ViewPlugin || !CM.Decoration || !CM.WidgetType) return;
  Cade.loadCSS('translate-blocks.css');

  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
  var BASE = Cade.baseURL();
  var DL = /plugins\/translate-blocks\/$/.test(BASE) ? BASE.replace(/plugins\/translate-blocks\/$/, 'widgets/decodelab/') : './txt/widgets/decodelab/';
  var RUNTIME = abs(DL + 'decodelab-inline.js');

  var ViewPlugin = CM.ViewPlugin, Decoration = CM.Decoration, WidgetType = CM.WidgetType;
  var MAX_LINE = 120;

  // ---- the translator runtime (shared with the "Translate to English" script) ----
  var loadP = null;
  function ensure() {
    if (window.__cadeTrInline) return Promise.resolve(window.__cadeTrInline);
    if (!loadP) {
      loadP = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = RUNTIME; s.async = false;
        s.onload = function () { if (window.__cadeTrInline) res(window.__cadeTrInline); else rej(new Error('The translator failed to start')); };
        s.onerror = function () { rej(new Error('The translator failed to load (offline?)')); };
        document.head.appendChild(s);
      });
      loadP.catch(function () { loadP = null; });
    }
    return loadP;
  }
  function withRuntime(fn, onFail) {
    ensure().then(fn, function (e) { if (onFail) onFail(); try { Cade.showToast(e.message, 'error', 4000); } catch (x) {} });
  }

  // ---- fence positions, scanned lazily from the top and mapped through edits ----
  var fence = { doc: null, pos: [], to: -1 };
  function startsFence(t) { return t.charCodeAt(0) === 96 && t.lastIndexOf('```', 0) === 0; }
  function ensureScan(doc, line) {
    if (fence.doc !== doc) fence = { doc: doc, pos: [], to: -1 };
    if (fence.to >= line.to) return;
    var start = fence.to < 0 ? 1 : doc.lineAt(fence.to).number + 1;
    for (var i = start; i <= line.number; i++) {
      var l = doc.line(i);
      if (startsFence(l.text)) fence.pos.push(l.from);
    }
    fence.to = line.to;
  }
  function lowerBound(from) {
    var lo = 0, hi = fence.pos.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (fence.pos[mid] < from) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function isOpening(doc, line) {
    ensureScan(doc, line);
    var i = lowerBound(line.from);
    return fence.pos[i] === line.from && i % 2 === 0;
  }
  function mapFences(u) {
    if (fence.doc !== u.startState.doc) return;
    var may = false, a = u.startState.doc, b = u.state.doc;
    u.changes.iterChanges(function (fromA, toA, fromB, toB, ins) {
      if (may) return;
      if (ins.length && ins.toString().indexOf('`') !== -1) may = true;
      else if (toA > fromA && a.sliceString(fromA, toA).indexOf('`') !== -1) may = true;
      else if (startsFence(a.lineAt(fromA).text) || startsFence(a.lineAt(toA).text) ||
               startsFence(b.lineAt(fromB).text) || startsFence(b.lineAt(toB).text)) may = true;
    });
    if (may) { fence = { doc: b, pos: [], to: -1 }; return; }
    var ch = u.changes;
    fence.pos = fence.pos.map(function (p) { return ch.mapPos(p, 1); });
    fence.to = fence.to < 0 ? -1 : ch.mapPos(fence.to, -1);
    fence.doc = b;
  }

  // ---- chip widget ----
  var ICON_TR = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h6M5.5 2v1.5M7.2 3.5c-.5 2.6-2.2 4.6-4.4 5.6M4.2 5.6c.8 1.4 2 2.5 3.4 3.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 14l2.6-6.5L13.7 14M9.4 12h3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_DL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.5M4.8 7l3.2 3.2L11.2 7M3 13.2h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_X = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  function Chip(pair, st) {
    this.pair = pair;
    this.st = st;
    this.key = pair.from + '>' + pair.to + '|' + (st ? st.state + '|' + st.text : '');
  }
  function label(c) { return c === 'en' ? 'English' : LABEL[c] || c; }
  Chip.prototype = Object.create(WidgetType.prototype);
  Chip.prototype.constructor = Chip;
  Chip.prototype.eq = function (o) { return o.key === this.key; };
  Chip.prototype.toDOM = function (view) {
    var wrap = document.createElement('span');
    wrap.className = 'cm-trb';
    wrap.setAttribute('contenteditable', 'false');
    var st = this.st, pr = this.pair;
    var what = (pr.from ? 'this ' + label(pr.from) + ' block' : 'this block') + ' into ' + label(pr.to);
    function button(cls, act, html, title) {
      var b = document.createElement('span');
      b.className = 'cm-trb-btn ' + cls;
      b.setAttribute('role', 'button');
      b.setAttribute('data-act', act);
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = html;
      wrap.appendChild(b);
      return b;
    }
    if (!st) {
      button('cm-trb-go', 'tr', ICON_TR + '<span>Translate</span>', 'Translate ' + what + ' (on this device) — written in a ```' + label(pr.to) + ' block below');
    } else if (st.state === 'consent') {
      button('cm-trb-dl', 'dl', ICON_DL + '<span></span>', st.title || 'Download and translate');
      wrap.lastChild.lastChild.textContent = st.text;
      button('cm-trb-x', 'x', ICON_X, 'Not now');
    } else {
      var pill = document.createElement('span');
      pill.className = 'cm-trb-state' + (st.state === 'queued' ? ' queued' : '');
      pill.innerHTML = (st.state === 'queued' ? '' : '<span class="cm-trb-spin" aria-hidden="true"></span>') + '<span></span>';
      pill.lastChild.textContent = st.text || 'Translating…';
      wrap.appendChild(pill);
      button('cm-trb-x', 'x', ICON_X, st.state === 'queued' ? 'Remove from the queue' : 'Stop');
    }
    function swallow(e) { e.preventDefault(); e.stopPropagation(); } // keep the caret & focus where they are
    wrap.addEventListener('mousedown', swallow);
    wrap.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    wrap.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      swallow(e);
      if (!t) return;
      var from;
      try { from = view.state.doc.lineAt(view.posAtDOM(wrap)).from; } catch (x) { return; }
      var act = t.getAttribute('data-act');
      if (act === 'tr') {
        if (view.state.readOnly) return;
        wrap.classList.add('pressed');
        withRuntime(function (R) { R.pressAt(from); }, function () { wrap.classList.remove('pressed'); });
      } else if (act === 'dl') withRuntime(function (R) { R.consentAt(from); });
      else if (act === 'x') withRuntime(function (R) { R.cancelAt(from); });
    });
    return wrap;
  };
  Chip.prototype.ignoreEvent = function () { return true; };

  // ---- the view plugin ----
  function build(view) {
    if (view.state.readOnly) return Decoration.none;
    var doc = view.state.doc, out = [], R = window.__cadeTrInline || null;
    var ranges = view.visibleRanges;
    for (var r = 0; r < ranges.length; r++) {
      var a = doc.lineAt(ranges[r].from).number, b = doc.lineAt(ranges[r].to).number;
      for (var i = a; i <= b; i++) {
        var line = doc.line(i), t = line.text;
        if (t.length > MAX_LINE || !startsFence(t)) continue;
        var info = t.slice(3).trim();
        if (!info) continue;                               // closing fence / untagged block
        var pair = pairOfInfo(info);
        if (!pair || !isOpening(doc, line)) continue;
        var st = R ? R.statusAt(line.from) : null;
        out.push(Decoration.widget({ widget: new Chip(pair, st), side: 1 }).range(line.to));
      }
    }
    return out.length ? Decoration.set(out, true) : Decoration.none;
  }
  function runtimeVersion() { var R = window.__cadeTrInline; return R ? R.version : 0; }
  function TranslateChips(view) { this.v = runtimeVersion(); this.decorations = build(view); }
  TranslateChips.prototype.update = function (u) {
    if (u.docChanged) mapFences(u);
    var v = runtimeVersion();
    if (u.docChanged || u.viewportChanged || v !== this.v || u.state.readOnly !== u.startState.readOnly) {
      this.v = v;
      this.decorations = build(u.view);
    }
  };
  var plugin = ViewPlugin.fromClass(TranslateChips, { decorations: function (p) { return p.decorations; } });

  Cade.registerPlugin({ id: 'translate-blocks', ext: plugin });
})();
