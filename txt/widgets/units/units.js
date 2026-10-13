/* Unit Converter — category tabs (length, mass, volume, cooking, temperature,
 * area, speed, time, data, pressure, energy, power, angle, fuel …), a value
 * box (accepts maths like "3/4" or a whole quantity like "5 ft"), from/to unit
 * pickers with a swap button, a live result, and an "all units" list showing
 * the value in every unit of the category (click to copy, ↵ to insert).
 * Remembers the last category and units; prefills from a selected "5 km".
 *
 * Uses the shared calc engine (txt/widgets/calc/calc-engine.js) for the unit
 * table and conversions — affine temperatures and reciprocal fuel units
 * (mpg ↔ L/100km) included. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('units.css');
  // The engine lives in the calculator's folder; derive its URL from ours so
  // sub-path hosting works, with a fixed relative fallback.
  var BASE = Cade.baseURL();
  var ENGINE_URL = /widgets\/units\/$/.test(BASE) ? BASE.replace(/widgets\/units\/$/, 'widgets/calc/calc-engine.js') : './txt/widgets/calc/calc-engine.js';
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'units-panel';
  var PREFS_KEY = 'cade-units-prefs';
  var DEFAULTS = {
    length: ['km', 'mi'], mass: ['kg', 'lb'], volume: ['l', 'gal'], cooking: ['cup', 'ml'], temperature: ['degC', 'degF'],
    area: ['m2', 'ft2'], speed: ['kmh', 'mph'], time: ['h', 'min'], data: ['GB', 'GiB'], datarate: ['Mbps', 'MBps'],
    pressure: ['bar', 'psi'], energy: ['kcal', 'kJ'], power: ['kW', 'hp'], force: ['N', 'lbf'], angle: ['deg', 'rad'],
    frequency: ['MHz', 'GHz'], fuel: ['mpg', 'l100km']
  };

  var engine = null;
  var prefs = { cat: 'length', value: '1', from: {}, to: {} };
  var state = { x: NaN, err: '' };

  function loadEngine() {
    if (window.__cadeCalcEngine) return Promise.resolve(window.__cadeCalcEngine);
    if (window.__cadeCalcEngineLoading) return window.__cadeCalcEngineLoading;
    var p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = ENGINE_URL; s.async = true;
      s.onload = function () { if (window.__cadeCalcEngine) resolve(window.__cadeCalcEngine); else reject(new Error('no engine')); };
      s.onerror = function () { reject(new Error('engine load failed')); };
      document.head.appendChild(s);
    });
    window.__cadeCalcEngineLoading = p;
    p.then(null, function () { window.__cadeCalcEngineLoading = null; });
    return p;
  }

  // ---- persistence ------------------------------------------------------------
  function loadPrefs() {
    try {
      var p = JSON.parse(Cade.store.get(PREFS_KEY) || 'null');
      if (p && typeof p === 'object') {
        if (typeof p.cat === 'string') prefs.cat = p.cat;
        if (typeof p.value === 'string') prefs.value = p.value;
        if (p.from && typeof p.from === 'object') prefs.from = p.from;
        if (p.to && typeof p.to === 'object') prefs.to = p.to;
      }
    } catch (e) {}
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }

  // ---- helpers ------------------------------------------------------------------
  function cat(id) {
    var cs = engine.categories;
    for (var i = 0; i < cs.length; i++) if (cs[i].id === id) return cs[i];
    return cs[0];
  }
  function inCat(c, id) { return c.units.some(function (u) { return u.id === id; }); }
  function fromUnit() {
    var c = cat(prefs.cat), id = prefs.from[c.id];
    if (!id || !inCat(c, id)) id = (DEFAULTS[c.id] || [])[0] || c.units[0].id;
    return engine.unitById(id) || c.units[0];
  }
  function toUnit() {
    var c = cat(prefs.cat), id = prefs.to[c.id];
    if (!id || !inCat(c, id)) id = (DEFAULTS[c.id] || [])[1] || c.units[1].id;
    return engine.unitById(id) || c.units[1] || c.units[0];
  }
  function fmt(x) { return engine.formatNumber(x, { thousands: true, precision: 10 }); }
  function symFor(u, x) { return u.plural && Math.abs(x) !== 1 ? u.plural : u.sym; }
  function withUnit(x, u) {
    var n = fmt(x), s = symFor(u, parseFloat(engine.formatNumber(x)));
    return n + (s === '°' ? '' : ' ') + s;
  }

  // The value box takes a number, any maths ("3/4", "2^10"), or a quantity
  // ("5 ft" → switches the From unit).
  function readValue() {
    var p = panel(); if (!p) return;
    var raw = p.querySelector('.un-val').value.trim();
    state.err = '';
    if (!raw) { state.x = NaN; return; }
    var q = engine.parseQuantity(raw);
    if (q) {
      adoptUnit(q.unit, false);
      state.x = q.value;
      return;
    }
    var r = engine.evaluate(raw, { setAns: false });
    if (r.ok && r.dims.every(function (d) { return !d; }) && !r.unit) state.x = r.value;
    else { state.x = NaN; state.err = r.ok ? 'Enter a plain number' : r.error; }
  }

  // Make `u` the From unit, switching category when it lives elsewhere.
  function adoptUnit(u, keepCat) {
    var c = cat(prefs.cat);
    if (!inCat(c, u.id)) {
      if (keepCat) return;
      var found = engine.categories.filter(function (k) { return inCat(k, u.id); })[0];
      if (!found) return;
      prefs.cat = found.id; c = found;
    }
    if (prefs.from[c.id] !== u.id) {
      if (toUnit().id === u.id) prefs.to[c.id] = fromUnit().id; // don't convert a unit to itself
      prefs.from[c.id] = u.id;
      renderSelects();
      renderTabs();
    }
  }

  // ---- rendering ------------------------------------------------------------------
  function panel() { return document.getElementById(PANEL_ID); }

  function renderTabs() {
    var p = panel(); if (!p) return;
    var tabs = p.querySelector('.un-tabs');
    tabs.innerHTML = engine.categories.map(function (c) {
      return '<button class="un-tab' + (c.id === prefs.cat ? ' on' : '') + '" data-cat="' + c.id + '" role="tab" aria-selected="' + (c.id === prefs.cat) + '">' +
        '<span class="un-ti">' + c.icon + '</span>' + esc(c.name) + '</button>';
    }).join('');
    var on = tabs.querySelector('.un-tab.on');
    if (on) {
      var l = on.offsetLeft - tabs.offsetLeft;
      if (l < tabs.scrollLeft || l + on.offsetWidth > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = l - tabs.clientWidth / 2;
    }
  }

  function renderSelects() {
    var p = panel(); if (!p) return;
    var c = cat(prefs.cat), f = fromUnit(), t = toUnit();
    var opts = function (sel) {
      return c.units.map(function (u) {
        return '<option value="' + esc(u.id) + '"' + (u.id === sel ? ' selected' : '') + '>' + esc(u.label + ' (' + u.sym + ')') + '</option>';
      }).join('');
    };
    p.querySelector('.un-from').innerHTML = opts(f.id);
    p.querySelector('.un-to').innerHTML = opts(t.id);
  }

  function renderResult() {
    var p = panel(); if (!p) return;
    var out = p.querySelector('.un-out'), all = p.querySelector('.un-all');
    var f = fromUnit(), t = toUnit(), c = cat(prefs.cat);
    if (isNaN(state.x)) {
      out.innerHTML = '<span class="un-dim">' + esc(state.err || 'Type a value') + '</span>';
      all.innerHTML = '';
      return;
    }
    var y = engine.convertValue(state.x, f, t);
    out.innerHTML = isFinite(y)
      ? '<span class="un-big" title="Click to copy">' + esc(withUnit(y, t)) + '</span>'
      : '<span class="un-dim">No result</span>';
    var html = '';
    c.units.forEach(function (u) {
      var v = engine.convertValue(state.x, f, u);
      if (!isFinite(v)) return;
      html += '<div class="un-r' + (u.id === t.id ? ' on' : '') + (u.id === f.id ? ' src' : '') + '" data-id="' + esc(u.id) + '" title="Click to copy">' +
        '<span class="un-n">' + esc(fmt(v)) + '</span><span class="un-u">' + esc(symFor(u, v)) + '</span>' +
        '<span class="un-l">' + esc(u.label) + '</span>' +
        '<button class="un-ib" data-act="row-ins" title="Insert at cursor" aria-label="Insert">↵</button></div>';
    });
    all.innerHTML = html;
  }

  function renderAll() { renderTabs(); renderSelects(); readValue(); renderResult(); }

  // ---- actions --------------------------------------------------------------------
  function copyText(text) {
    var done = function () { Cade.showToast('Copied ' + text, 'success', 1400); };
    var fail = function () { Cade.showToast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      ta.remove();
    }
  }
  function insertText(text) {
    var ed = Cade.editor;
    if (!ed || !text) return;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode — editing is locked', 'error', 2000); return; }
    ed.dispatch(ed.state.replaceSelection(text), { userEvent: 'input', scrollIntoView: true });
    Cade.showToast('Inserted ' + text, 'success', 1200);
  }
  function resultText(u) {
    if (isNaN(state.x)) return '';
    var y = engine.convertValue(state.x, fromUnit(), u || toUnit());
    return isFinite(y) ? withUnit(y, u || toUnit()) : '';
  }
  function bothText() {
    var r = resultText();
    return r ? withUnit(state.x, fromUnit()) + ' = ' + r : '';
  }
  function act(kind, u) {
    var text = kind === 'both' ? bothText() : resultText(u);
    if (!text) { Cade.showToast('Nothing to convert yet', 'info', 1400); return; }
    if (kind === 'copy') copyText(text); else insertText(text);
  }

  function close() {
    var p = panel();
    if (!p) return;
    p.remove();
    if (p._onClose) p._onClose();
  }

  // "5 km" / "100°F" / "3.5" in the selection seeds the converter.
  function seedFromSelection() {
    try {
      var ed = Cade.editor, sel = ed.state.selection.main;
      if (sel.empty || sel.to - sel.from > 60) return false;
      var s = ed.state.sliceDoc(sel.from, sel.to).trim();
      if (!s || s.indexOf('\n') !== -1) return false;
      var q = engine.parseQuantity(s);
      if (q) {
        if (!inCat(cat(prefs.cat), q.unit.id)) {
          var found = engine.categories.filter(function (k) { return inCat(k, q.unit.id); })[0];
          if (!found) return false;
          prefs.cat = found.id;
        }
        var cid = prefs.cat, prevFrom = fromUnit().id;
        prefs.from[cid] = q.unit.id;
        if (toUnit().id === q.unit.id) {
          // never convert a unit to itself: fall back to the old From or the category default
          var d = DEFAULTS[cid] || [], alt = prevFrom !== q.unit.id ? prevFrom : (d[0] !== q.unit.id ? d[0] : d[1]);
          prefs.to[cid] = alt || cat(cid).units.filter(function (u) { return u.id !== q.unit.id; })[0].id;
        }
        prefs.value = String(q.value);
        return true;
      }
      var r = engine.evaluate(s, { setAns: false });
      if (r.ok && !r.unit && r.dims.every(function (d) { return !d; })) { prefs.value = s.replace(/\s*=\s*$/, ''); return true; }
    } catch (e) {}
    return false;
  }

  // A typed "5 km" pins the From unit; once the user picks units by hand,
  // reduce the box to its number so it stops overriding them.
  function stripUnit() {
    var p = panel(); if (!p) return;
    var val = p.querySelector('.un-val'), q = engine.parseQuantity(val.value);
    if (q) { val.value = String(q.value); prefs.value = val.value; }
  }

  function onKey(e) {
    var p = panel(); if (!p) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); try { Cade.editor.focus(); } catch (x) {} }
    else if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('un-val')) {
      e.preventDefault();
      act(e.shiftKey ? 'copy' : 'insert');
    }
    e.stopPropagation(); // keep editor/global shortcuts out of the panel
  }

  function open() {
    Cade.closeAllMenus();
    var existing = panel();
    if (existing) {
      if (engine && seedFromSelection()) { existing.querySelector('.un-val').value = prefs.value; renderAll(); }
      existing.querySelector('.un-val').focus();
      return;
    }
    loadPrefs();
    var p = Cade.mkPanel(PANEL_ID, '📐 Unit Converter',
      '<div class="un-tabs" role="tablist" aria-label="Category"></div>' +
      '<div class="un-grid">' +
        '<input class="un-val" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="Value" placeholder="Value">' +
        '<select class="un-from" aria-label="From unit"></select>' +
        '<button class="un-swap" data-act="swap" title="Swap units" aria-label="Swap units">⇅</button>' +
        '<div class="un-out" aria-live="polite"></div>' +
        '<select class="un-to" aria-label="To unit"></select>' +
      '</div>' +
      '<div class="un-acts">' +
        '<button class="un-btn primary" data-act="insert" title="Insert the result at the cursor (Enter)">↵ Insert</button>' +
        '<button class="un-btn" data-act="both" title="Insert “value = result”">= Insert both</button>' +
        '<button class="un-btn" data-act="copy" title="Copy the result (Shift+Enter)">⧉ Copy</button>' +
      '</div>' +
      '<div class="un-all"><div class="un-dim">Loading units…</div></div>');

    var val = p.querySelector('.un-val');
    p.addEventListener('keydown', onKey);
    val.addEventListener('input', function () {
      if (!engine) return;
      prefs.value = val.value; savePrefs();
      readValue(); renderResult();
    });
    p.querySelector('.un-from').addEventListener('change', function (e) {
      prefs.from[prefs.cat] = e.target.value;
      stripUnit();
      savePrefs(); readValue(); renderResult();
    });
    p.querySelector('.un-to').addEventListener('change', function (e) {
      prefs.to[prefs.cat] = e.target.value; savePrefs(); renderResult();
    });
    p.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest || !engine) return;
      var b;
      if ((b = t.closest('.un-tab'))) {
        prefs.cat = b.getAttribute('data-cat');
        stripUnit(); // keep only the number when switching category
        savePrefs(); renderAll();
      } else if ((b = t.closest('[data-act="swap"]'))) {
        var f = fromUnit().id, to = toUnit().id;
        prefs.from[prefs.cat] = to; prefs.to[prefs.cat] = f;
        stripUnit();
        savePrefs(); renderSelects(); readValue(); renderResult();
      } else if ((b = t.closest('[data-act="row-ins"]'))) {
        act('insert', engine.unitById(b.closest('.un-r').getAttribute('data-id')));
      } else if ((b = t.closest('.un-r'))) {
        act('copy', engine.unitById(b.getAttribute('data-id')));
      } else if (t.closest('.un-big')) act('copy');
      else if ((b = t.closest('[data-act]'))) act(b.getAttribute('data-act'));
    });
    p.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('.un-tab, .un-ib, .un-swap')) e.preventDefault();
    });
    [p.querySelector('.un-tabs')].forEach(function (el) {
      el.addEventListener('wheel', function (e) {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) { el.scrollLeft += e.deltaY; e.preventDefault(); }
      }, { passive: false });
    });

    loadEngine().then(function (E) {
      engine = E;
      if (!panel()) return;
      seedFromSelection();
      val.value = prefs.value;
      renderAll();
      savePrefs();
      if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) { val.focus(); val.select(); }
    }, function () {
      var q = panel();
      if (q) q.querySelector('.un-all').innerHTML = '<div class="un-dim">Couldn’t load the unit table' + (navigator.onLine ? '' : ' — it needs one online load to cache') + '</div>';
    });
  }

  Cade.registerWidget({
    name: 'Unit Converter',
    description: 'Convert length, weight, volume, cooking, temperature, speed, data, fuel & more',
    icon: '📐',
    tags: 'unit,units,convert,converter,conversion,metric,imperial,length,weight,mass,volume,cooking,cups,temperature,celsius,fahrenheit,speed,data,bytes,pressure,energy,power,angle,fuel,mpg',
    open: open,
  });
})();
