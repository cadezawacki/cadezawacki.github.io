/* Response links — the UI for "What they can do → Respond": polls, picking a
 * date, RSVPs, "who brings what" packing lists and shared checklists.
 * burn-respond-core.js holds the logic and the storage layout (see its
 * header); burn.js loads both (and burn-respond.css) only when someone picks
 * Respond, opens a response link, or has one in their list — and hands this
 * module its helpers through init(host).
 *
 *  - OWNER: the composer inside the link dialog (a type picker and an editor
 *    per type, prefilled from the note); live summaries for the "Your links"
 *    rows; the results view (bars, the date grid, lists with names) with
 *    Reveal results, Close responses and Copy results into the note.
 *    Hidden results need the private key, kept in Cade.syncedBlob
 *    ('burn-respond') — encrypted with the sync key like the link list, but a
 *    blob of its own, so owner devices still running older code (which
 *    rewrite the link list without fields they don't know) can't drop it.
 *  - RESPONDENT: a friendly full-page form in burn.js's recipient view: their
 *    name once (remembered for this link in this browser), big tap targets,
 *    every tap saved at once, everyone's answers live where the owner allows. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Cade) return;
  var Cade = window.Cade, RC = window.__cadeBurnRespondCore;
  var H = null, C = null;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var CHIP = { poll: 'Poll', dates: 'Pick a date', rsvp: 'RSVP', packing: 'Who brings what', list: 'Checklist' };
  var VIS_L = [
    { v: 'live', label: 'Right away', hint: 'Everyone sees the results as answers come in.' },
    { v: 'after', label: 'After they answer', hint: 'Each person sees the results once they’ve answered.' },
    { v: 'hidden', label: 'Only me', hint: 'Answers are encrypted so that only your devices can read them. You can reveal the totals later.' }
  ];
  function warn(e) { if (typeof console !== 'undefined') console.warn('burn respond:', e); }
  function toast(m, k, ms) { Cade.showToast(m, k || 'info', ms || 2600); }
  function plural(n, w, ws) { return n + ' ' + (n === 1 ? w : ws || w + 's'); }

  // =====================================================================================================
  // The owner's synced keys + specs: { v, links: { <id>: { type, spec, pub, priv, room, at } }, gone: { <id>: at } }
  // Whole-blob last-writer-wins underneath, so every copy is merged as a union
  // (with `gone` as tombstones) before it's written — a link made on two
  // devices at once keeps both keys.
  // =====================================================================================================
  var RB = null, rdata = null, rbListeners = [];
  function rbNorm(d) {
    var o = { v: 1, links: {}, gone: {} }, k;
    if (d && typeof d === 'object') {
      var L = d.links && typeof d.links === 'object' ? d.links : {}, G = d.gone && typeof d.gone === 'object' ? d.gone : {};
      for (k in L) if (Object.prototype.hasOwnProperty.call(L, k) && C.validId(k) && L[k] && typeof L[k] === 'object' && RC.typeOf(L[k].type)) {
        var x = L[k];
        o.links[k] = { type: x.type, spec: x.spec || null, pub: RC.pickJwk(x.pub), priv: RC.pickJwk(x.priv, true), room: String(x.room || ''), at: +x.at || 0 };
      }
      for (k in G) if (Object.prototype.hasOwnProperty.call(G, k) && C.validId(k) && +G[k] > 0) o.gone[k] = +G[k];
    }
    for (k in o.gone) delete o.links[k];
    return o;
  }
  function rbMerge(a, b) {
    var o = { v: 1, links: {}, gone: {} }, k;
    [a, b].forEach(function (x) { for (k in x.gone) o.gone[k] = Math.max(o.gone[k] || 0, x.gone[k]); });
    [a, b].forEach(function (x) { for (k in x.links) if (!o.gone[k] && (!o.links[k] || (!o.links[k].priv && x.links[k].priv))) o.links[k] = x.links[k]; });
    var cut = Date.now() - 60 * 86400000;
    for (k in o.gone) if (o.gone[k] < cut) delete o.gone[k];
    return o;
  }
  function rb() {
    if (!RB) {
      RB = Cade.syncedBlob('burn-respond', { onChange: function (d) {
        var theirs = rbNorm(d), m = rbMerge(rdata || rbNorm(null), theirs);
        rdata = m;
        if (JSON.stringify(m) !== JSON.stringify(theirs)) RB.set(m);
        rbListeners.slice().forEach(function (f) { try { f(); } catch (e) { warn(e); } });
      } });
      rdata = rbNorm(RB.get());
    }
    return RB;
  }
  function rbGet(id) { rb(); return rdata.links[id] || null; }
  function rbPut(id, v) { rb(); rdata = rbMerge(rdata, rbNorm(RB.get())); rdata.links[id] = v; RB.set(rdata); }
  function rbForget(id) { rb(); rdata = rbMerge(rdata, rbNorm(RB.get())); delete rdata.links[id]; rdata.gone[id] = Date.now(); RB.set(rdata); }

  // =====================================================================================================
  // COMPOSER (in the owner's dialog)
  // =====================================================================================================
  function emptyDraft(type) {
    switch (type) {
      case 'poll': return { q: '', opts: ['', ''], multi: false, other: false, anon: false, vis: 'live' };
      case 'dates': return { q: '', slots: [{ d: '', t: '' }, { d: '', t: '' }], vis: 'live' };
      case 'rsvp': return { q: '', plus: 0, vis: 'live' };
      case 'packing': return { q: '', items: [{ t: '', n: 1 }] };
      case 'list': return { q: '', items: [''], add: true };
    }
    return { q: '' };
  }
  // A spec from the note (fromNote) → a draft the editor shows; null when the note has nothing for it.
  function draftFromNote(type, p, now) {
    var T = RC.typeOf(type), s = T.fromNote(p, now), d = emptyDraft(type);
    if (type === 'poll') { if (!s.q && s.opts.length < 2) return null; d.q = s.q; d.opts = s.opts.length ? s.opts.slice() : d.opts; while (d.opts.length < 2) d.opts.push(''); }
    else if (type === 'dates') { if (s.slots.length < 1) return null; d.q = s.q; d.slots = s.slots.map(function (x) { return { d: x.d, t: x.t }; }); while (d.slots.length < 2) d.slots.push({ d: '', t: '' }); }
    else if (type === 'rsvp') { if (!s.q) return null; d.q = s.q; }
    else if (type === 'packing') { if (!s.items.length) return null; d.q = s.q; d.items = s.items.map(function (x) { return { t: x.t, n: x.n }; }); }
    else if (type === 'list') { if (!s.items.length) return null; d.q = s.q; d.items = s.items.slice(); }
    return d;
  }
  function specOfDraft(type, d) {
    if (type === 'poll') return { q: d.q, opts: d.opts, multi: d.multi, other: d.other, anon: d.anon, vis: d.vis };
    if (type === 'dates') return { q: d.q, slots: d.slots, vis: d.vis };
    if (type === 'rsvp') return { q: d.q, plus: d.plus, vis: d.vis };
    if (type === 'packing') return { q: d.q, items: d.items };
    return { q: d.q, items: d.items, add: d.add };
  }
  function isoDay(ms) { var x = new Date(ms); return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); }

  // el: an empty container; o: { text (the note), now, onChange() } → { get() → { type, spec } (throws), title(), type(), destroy() }
  function composer(el, o) {
    var parsed = RC.parseNote(o.text || '', o.now || Date.now());
    var S = { type: parsed.suggest || 'poll', drafts: {}, fromNote: {} };
    RC.types().forEach(function (T) {
      var d = draftFromNote(T.id, parsed, o.now);
      S.fromNote[T.id] = !!d;
      S.drafts[T.id] = d || emptyDraft(T.id);
    });
    function changed() { if (o.onChange) try { o.onChange(); } catch (e) { warn(e); } }
    function rowsHtml(list, d) {
      var rows = d[list], ph = { opts: 'Choice', items: 'Item' }[list] || '';
      return '<div class="br-rows" data-rows="' + list + '">' + rows.map(function (x, i) {
        if (list === 'slots') {
          return '<div class="br-row br-row-d"><input class="form-input br-in br-date" type="date" data-list="slots" data-i="' + i + '" data-f="d" value="' + esc(x.d) + '" aria-label="Date ' + (i + 1) + '">' +
            '<input class="form-input br-in br-time" type="time" data-list="slots" data-i="' + i + '" data-f="t" value="' + esc(x.t) + '" aria-label="Time (optional)">' +
            '<button type="button" class="br-rm" data-act="br-rm" data-list="slots" data-i="' + i + '" aria-label="Remove this date">×</button></div>';
        }
        var t = typeof x === 'string' ? x : x.t;
        return '<div class="br-row"><input class="form-input br-in" type="text" data-list="' + list + '" data-i="' + i + '"' + (typeof x === 'string' ? '' : ' data-f="t"') +
          ' value="' + esc(t) + '" placeholder="' + ph + ' ' + (i + 1) + '" maxlength="' + RC.MAX_T + '" enterkeyhint="next" autocomplete="off">' +
          (S.type === 'packing' ? '<label class="br-qty" title="How many are needed"><span>×</span><input class="form-input br-in br-n" type="number" inputmode="numeric" min="1" max="' + RC.MAX_NEED + '" data-list="items" data-i="' + i + '" data-f="n" value="' + (x.n || 1) + '" aria-label="How many needed"></label>' : '') +
          '<button type="button" class="br-rm" data-act="br-rm" data-list="' + list + '" data-i="' + i + '" aria-label="Remove">×</button></div>';
      }).join('') + '</div>' +
        '<button type="button" class="btn br-add" data-act="br-add" data-list="' + list + '">+ ' + ({ opts: 'Add a choice', slots: 'Add a date', items: 'Add an item' }[list]) + '</button>';
    }
    function tog(k, label, hint, on) {
      return '<label class="burn-tog"><span class="burn-tog-t"><span class="burn-tog-l">' + esc(label) + '</span><span class="burn-tog-h">' + esc(hint) + '</span></span>' +
        '<input type="checkbox" role="switch" data-bk="' + k + '"' + (on ? ' checked' : '') + '><span class="burn-sw" aria-hidden="true"></span></label>';
    }
    function visHtml(d) {
      var cur = VIS_L.filter(function (x) { return x.v === d.vis; })[0] || VIS_L[0];
      return '<div class="br-f"><span class="burn-fl" id="br-vis-l">Who sees the results</span><div class="br-segs" role="radiogroup" aria-labelledby="br-vis-l">' +
        VIS_L.map(function (x) { return '<label class="br-seg' + (x.v === d.vis ? ' br-seg-on' : '') + '"><input type="radio" name="br-vis" value="' + x.v + '"' + (x.v === d.vis ? ' checked' : '') + '><span>' + esc(x.label) + '</span></label>'; }).join('') +
        '</div><p class="burn-hint br-vis-h">' + esc(cur.hint) + '</p></div>';
    }
    function qField(label, d, ph) {
      return '<label class="br-f"><span class="burn-fl">' + esc(label) + '</span><input class="form-input br-in br-q" type="text" data-f="q" value="' + esc(d.q) + '" placeholder="' + esc(ph) + '" maxlength="' + RC.MAX_Q + '" autocomplete="off" enterkeyhint="next"></label>';
    }
    function editorHtml() {
      var d = S.drafts[S.type];
      switch (S.type) {
        case 'poll': return qField('Question', d, 'Where should we eat?') +
          '<div class="br-f"><span class="burn-fl">Choices</span>' + rowsHtml('opts', d) + '</div>' +
          tog('multi', 'They can pick more than one', '', d.multi) + tog('other', 'Allow an “Other” answer', 'They can type their own.', d.other) +
          tog('anon', 'Allow voting anonymously', 'Otherwise everyone gives a name.', d.anon) + visHtml(d);
        case 'dates': return qField('What’s it for?', d, 'Dinner at ours — which day works?') +
          '<div class="br-f"><span class="burn-fl">Dates <span class="br-opt-l">(times optional)</span></span>' + rowsHtml('slots', d) + '</div>' + visHtml(d);
        case 'rsvp': return qField('What are they replying to?', d, 'Birthday drinks, Sat 7 pm') +
          '<label class="br-f br-inline"><span class="burn-fl">Guests each can bring</span><select class="form-input br-plus" data-bk="plus">' +
          [0, 1, 2, 3, 4, 5].map(function (n) { return '<option value="' + n + '"' + (n === d.plus ? ' selected' : '') + '>' + (n ? '+' + n : 'None') + '</option>'; }).join('') + '</select></label>' + visHtml(d);
        case 'packing': return qField('Title', d, 'Camping trip — who brings what?') +
          '<div class="br-f"><span class="burn-fl">Things to bring <span class="br-opt-l">(× how many)</span></span>' + rowsHtml('items', d) + '</div>';
        case 'list': return qField('Title', d, 'Shopping list') +
          '<div class="br-f"><span class="burn-fl">Items</span>' + rowsHtml('items', d) + '</div>' +
          tog('add', 'They can add items', 'Anyone with the link can add to the list.', d.add);
      }
      return '';
    }
    function render(focus) {
      var T = RC.typeOf(S.type);
      el.innerHTML = '<div class="br-comp">' +
        '<div class="br-types" role="radiogroup" aria-label="What should they do?">' + RC.types().filter(function (x) { return CHIP[x.id]; }).map(function (x) {
          return '<button type="button" class="br-type" role="radio" aria-checked="' + (x.id === S.type) + '" data-act="br-type" data-type="' + x.id + '"><span class="br-type-i" aria-hidden="true">' + x.icon + '</span><span>' + esc(CHIP[x.id]) + '</span></button>';
        }).join('') + '</div>' +
        '<p class="br-blurb">' + esc(T.blurb) + '</p>' +
        (S.fromNote[S.type] ? '<p class="br-from"><span>✨ Filled in from your note — change anything.</span><button type="button" class="br-link" data-act="br-clear">Start empty</button></p>'
          : draftFromNote(S.type, parsed, o.now) ? '<p class="br-from"><button type="button" class="br-link" data-act="br-fill">Fill in from this note</button></p>' : '') +
        '<div class="br-ed">' + editorHtml() + '</div></div>';
      if (focus) {
        var f = el.querySelector(focus);
        if (f) { f.focus(); try { var n = f.value.length; f.setSelectionRange(n, n); } catch (e) {} }
      }
    }
    function onInput(ev) {
      var t = ev.target, d = S.drafts[S.type], list = t.getAttribute('data-list'), f = t.getAttribute('data-f');
      if (list) {
        var i = +t.getAttribute('data-i'), row = d[list][i];
        if (row == null) return;
        if (typeof row === 'string') d[list][i] = t.value;
        else row[f] = f === 'n' ? Math.max(1, Math.min(RC.MAX_NEED, Math.floor(+t.value) || 1)) : t.value;
      } else if (f === 'q') d.q = t.value;
      else return;
      changed();
    }
    function onChange(ev) {
      var t = ev.target, d = S.drafts[S.type], k = t.getAttribute('data-bk');
      if (t.name === 'br-vis') {
        d.vis = t.value;
        Array.prototype.forEach.call(el.querySelectorAll('.br-seg'), function (s) { s.classList.toggle('br-seg-on', s.querySelector('input').checked); });
        var h = el.querySelector('.br-vis-h'); if (h) h.textContent = (VIS_L.filter(function (x) { return x.v === d.vis; })[0] || VIS_L[0]).hint;
      } else if (k === 'plus') d.plus = +t.value || 0;
      else if (k) d[k] = !!t.checked;
      else return;
      changed();
    }
    function addRow(list, at) {
      var d = S.drafts[S.type], rows = d[list], max = list === 'opts' ? RC.MAX_OPTS : list === 'slots' ? RC.MAX_SLOTS : RC.MAX_ITEMS;
      if (rows.length >= max) { toast('That’s the most there can be (' + max + ')'); return; }
      var row;
      if (list === 'slots') {
        var last = rows.filter(function (x) { return RC.validDate(x.d); }).map(function (x) { return x.d; }).sort().pop();
        var base = last ? Date.parse(last + 'T12:00:00') : Date.now();
        row = { d: isoDay(base + 86400000), t: '' };
      } else row = typeof rows[0] === 'string' || S.type !== 'packing' ? '' : { t: '', n: 1 };
      if (S.type === 'packing' && list === 'items') row = { t: '', n: 1 };
      if (at == null) at = rows.length;
      rows.splice(at, 0, row);
      render('[data-list="' + list + '"][data-i="' + at + '"]' + (list === 'slots' ? '[data-f="d"]' : ':not(.br-n)'));
      changed();
    }
    function onClick(ev) {
      var b = ev.target.closest('[data-act]');
      if (!b || !el.contains(b)) return;
      var a = b.getAttribute('data-act'), d = S.drafts[S.type];
      if (a === 'br-type') { S.type = b.getAttribute('data-type'); render(); changed(); }
      else if (a === 'br-add') addRow(b.getAttribute('data-list'));
      else if (a === 'br-rm') {
        var list = b.getAttribute('data-list'), i = +b.getAttribute('data-i');
        d[list].splice(i, 1);
        if (!d[list].length) d[list].push(emptyDraft(S.type)[list][0]);
        render(); changed();
      } else if (a === 'br-clear') { S.drafts[S.type] = emptyDraft(S.type); S.fromNote[S.type] = false; render('.br-q'); changed(); }
      else if (a === 'br-fill') { var nd = draftFromNote(S.type, parsed, o.now); if (nd) { S.drafts[S.type] = nd; S.fromNote[S.type] = true; render(); changed(); } }
    }
    function onKey(ev) {
      var t = ev.target, list = t.getAttribute && t.getAttribute('data-list');
      if (ev.key === 'Enter' && t.tagName === 'INPUT') {
        ev.preventDefault();
        if (list && list !== 'slots') { addRow(list, +t.getAttribute('data-i') + 1); return; }
        if (t.classList.contains('br-q')) { var nx = el.querySelector('.br-rows .br-in'); if (nx) nx.focus(); }
        return;
      }
      if (ev.key === 'Backspace' && list && list !== 'slots' && t.value === '' && !t.classList.contains('br-n')) {
        var rows = S.drafts[S.type][list], i = +t.getAttribute('data-i');
        if (rows.length > 1) { ev.preventDefault(); rows.splice(i, 1); render('[data-list="' + list + '"][data-i="' + Math.max(0, i - 1) + '"]:not(.br-n)'); changed(); }
      }
    }
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    render();
    return {
      type: function () { return S.type; },
      title: function () { return String(S.drafts[S.type].q || '').trim(); },
      get: function () { var T = RC.typeOf(S.type); return { type: S.type, spec: T.clean(specOfDraft(S.type, S.drafts[S.type]), true) }; },
      destroy: function () {
        el.removeEventListener('input', onInput); el.removeEventListener('change', onChange);
        el.removeEventListener('click', onClick); el.removeEventListener('keydown', onKey);
        el.innerHTML = '';
      },
      _state: S
    };
  }

  // What create() needs: the head's respond part, and the private key for hidden results.
  function prepare(o) {
    var T = RC.typeOf(o && o.type);
    if (!T) return Promise.reject(new Error('Pick what they should do'));
    var spec = T.clean(o.spec, true), hidden = !!T.vis && spec.vis === 'hidden';
    return (hidden ? RC.newOwnerKeys() : Promise.resolve(null)).then(function (keys) {
      return { head: RC.makeRespond({ type: T.id, spec: spec, pub: keys && keys.pub }), priv: keys ? keys.priv : null, pub: keys ? keys.pub : null };
    });
  }
  function remember(id, prep, room) { rbPut(id, { type: prep.head.type, spec: prep.head.spec, pub: prep.pub, priv: prep.priv, room: room || '', at: Date.now() }); }
  function forget(id) { rbForget(id); }
  // "Poll · results only you see" — for the dialog's summary line.
  function describe(head) {
    var T = RC.typeOf(head.type), v = head.spec.vis;
    return T.short + (T.vis ? (v === 'hidden' ? ' · results only you see' : v === 'after' ? ' · results after they answer' : ' · results shown live') : '');
  }

  // =====================================================================================================
  // RESULTS — shared by the respondent's page and the owner's view
  // =====================================================================================================
  function pct(n, of) { return of > 0 ? Math.round(n * 100 / of) : 0; }
  function names(list, max) {
    if (!list || !list.length) return '';
    max = max || 12;
    return esc(list.slice(0, max).join(', ')) + (list.length > max ? ' +' + (list.length - max) : '');
  }
  function pollResults(R, t, o) {
    var top = Math.max(1, t.max);
    return '<div class="br-bars">' + R.spec.opts.map(function (x) {
      var n = t.counts[x.id], lead = t.leaders.indexOf(x.id) >= 0;
      return '<div class="br-bar-r' + (lead ? ' br-lead' : '') + '"><div class="br-bar-l"><span class="br-bar-t">' + esc(x.t) + (lead ? ' <span class="br-badge">' + (t.leaders.length > 1 ? 'Tied' : 'Leads') + '</span>' : '') + '</span>' +
        '<span class="br-bar-n">' + n + (t.voters ? ' · ' + pct(n, t.voters) + '%' : '') + '</span></div>' +
        '<div class="br-bar"><i style="width:' + pct(n, top) + '%"></i></div>' +
        (o.names && t.names[x.id] && t.names[x.id].length ? '<div class="br-who-l">' + names(t.names[x.id], o.owner ? 99 : 12) + '</div>' : '') + '</div>';
    }).join('') +
      (t.otherCount ? '<div class="br-others"><b>Other answers (' + t.otherCount + ')</b>' + (o.names && t.others.length ? '<ul>' + t.others.map(function (x) { return '<li>' + esc(x.t) + ' <span>— ' + esc(x.name) + '</span></li>'; }).join('') + '</ul>' : '') + '</div>' : '') +
      '</div>';
  }
  var MARK = { y: '✓', m: '?', n: '✗' };
  function datesGrid(R, t, o) {
    var now = o.now, slots = R.spec.slots;
    var head = '<tr><th class="br-g-n" scope="col"><span class="br-vh">Name</span></th>' + slots.map(function (x) {
      var best = t.best.indexOf(x.id) >= 0;
      return '<th scope="col" class="' + (best ? 'br-g-best' : '') + '"><span class="br-g-d">' + esc(RC.fmtDate(x.d, now)) + '</span>' + (x.t ? '<span class="br-g-t">' + esc(RC.fmtTime(x.t)) + '</span>' : '') + (best ? '<span class="br-g-star" title="Best">★</span>' : '') + '</th>';
    }).join('') + '</tr>';
    var rows = o.names ? t.people.map(function (p) {
      return '<tr' + (p.me ? ' class="br-g-me"' : '') + '><th scope="row" class="br-g-n">' + esc(p.name) + (p.me ? ' <span class="br-you">you</span>' : '') + '</th>' + slots.map(function (x) {
        var v = p.a[x.id];
        return '<td class="br-c-' + (v || 'x') + (t.best.indexOf(x.id) >= 0 ? ' br-g-best' : '') + '">' + (v ? '<span aria-label="' + ({ y: 'yes', m: 'maybe', n: 'no' }[v]) + '">' + MARK[v] + '</span>' : '') + '</td>';
      }).join('') + '</tr>';
    }).join('') : '';
    var tot = '<tr class="br-g-tot"><th scope="row" class="br-g-n">Yes</th>' + slots.map(function (x) {
      var g = t.slots[x.id];
      return '<td class="' + (t.best.indexOf(x.id) >= 0 ? 'br-g-best' : '') + '"><b>' + g.y + '</b>' + (g.m ? '<small>+' + g.m + '?</small>' : '') + '</td>';
    }).join('') + '</tr>';
    return '<div class="br-grid-w" tabindex="0" role="region" aria-label="Everyone’s answers"><table class="br-grid"><thead>' + head + '</thead><tbody>' + rows + tot + '</tbody></table></div>';
  }
  function rsvpResults(R, t, o) {
    var row = function (k, label) {
      var n = t[k];
      return '<div class="br-rs br-rs-' + k + '"><div class="br-rs-h"><b>' + n + '</b> ' + label + '</div>' + (o.names && t.who[k].length ? '<div class="br-who-l">' + names(t.who[k], o.owner ? 99 : 30) + '</div>' : '') + '</div>';
    };
    return '<div class="br-rsvp-r"><div class="br-heads"><b>' + t.heads + '</b> coming' + (R.spec.plus ? ' <span>(guests included)</span>' : '') + '</div>' +
      row('y', 'yes') + row('m', 'maybe') + row('n', 'can’t come') + '</div>';
  }
  function packingResults(R, t, o) {
    return '<ul class="br-plist">' + t.items.map(function (x) {
      var got = x.claims.filter(function (c) { return c.got > 0; });
      return '<li class="' + (x.left ? 'br-open' : 'br-done') + '"><span class="br-pl-t">' + esc(x.t) + (x.need > 1 ? ' <small>×' + x.need + '</small>' : '') + '</span><span class="br-pl-s">' +
        (got.length ? esc(got.map(function (c) { return c.name + (x.need > 1 ? ' (' + c.got + ')' : ''); }).join(', ')) + (x.left ? ' · <b>' + x.left + ' still needed</b>' : '') : '<b>Unclaimed</b>') + '</span></li>';
    }).join('') + '</ul>';
  }
  function listResults(R, t, o) {
    var now = o.now || Date.now();
    return '<ul class="br-plist">' + t.items.map(function (x) {
      return '<li class="' + (x.on ? 'br-done' : '') + '"><span class="br-pl-t">' + (x.on ? '✓ ' : '') + esc(x.t) + (x.addedBy ? ' <small>added by ' + esc(x.addedBy) + '</small>' : '') + '</span><span class="br-pl-s">' +
        (x.by ? (x.on ? 'Ticked by ' : 'Unticked by ') + esc(x.by) + ' · ' + esc(RC.fmtAgo(now - x.byAt)) : '') + '</span></li>';
    }).join('') + (t.items.length ? '' : '<li class="br-empty">Nothing on the list yet.</li>') + '</ul>';
  }
  function resultsHtml(R, t, o) {
    var f = { poll: pollResults, dates: datesGrid, rsvp: rsvpResults, packing: packingResults, list: listResults }[R.type];
    return f ? f(R, t, o) : '';
  }

  // =====================================================================================================
  // RESPONDENT (inside burn.js's recipient view)
  // =====================================================================================================
  // r: burn.js's view state (node, id, key, meta, head, el…); raw: the opened head.
  // → true, or false when the head's respond part doesn't hold up (burn.js says "can't be read").
  function recipient(r, raw) {
    var R = RC.readRespond(raw);
    if (!R) return false;
    var T = RC.typeOf(R.type), spec = R.spec;
    var K = function (k) { return 'cade-burn-' + k + ':' + r.id; };
    function lsGet(k) { try { return Cade.store.get(K(k)); } catch (e) { return null; } }
    function lsSet(k, v) { try { if (v == null) Cade.store.remove(K(k)); else Cade.store.set(K(k), v); } catch (e) {} }
    var rid = lsGet('rid');
    if (!RC.validRid(rid)) { rid = RC.newRid(); lsSet('rid', rid); }
    var local = null;
    try { local = JSON.parse(lsGet('ans') || 'null'); } catch (e) {}
    var S = {
      rid: rid, name: lsGet('name') || '', anon: lsGet('anon') === '1', named: !!(lsGet('name') || lsGet('anon') === '1'),
      ans: local && local.a ? local.a : null, raw: null, data: null, t: null, closed: false, agg: null, busy: false, again: false,
      pend: {}, optim: {}, chain: Promise.resolve(), queued: false, nameSent: false, fixing: {}, saved: 0, editName: false
    };
    if (!S.ans && !T.lists) S.ans = T.id === 'poll' ? { pick: [], other: '' } : T.id === 'rsvp' ? null : {};
    // The bar at the top: the name the owner gave it, or (when that's just the question) the kind.
    var title = String(r.head.title || '').trim(), named = !!title && title !== spec.q;
    H.rvBrand(named ? title : CHIP[R.type] || T.short, r.head.icon || (named ? '' : T.icon));
    var root = document.createElement('div');
    root.className = 'br-page';
    root.setAttribute('data-type', R.type);
    var main = H.rvMain();
    main.innerHTML = '';
    main.appendChild(root);
    r.box = root;
    r.cleanup = function () { ['rid', 'name', 'anon', 'ans'].forEach(function (k) { lsSet(k, null); }); };
    function live() { return H.isCurrent(r); }
    function accepting() { return live() && !S.closed; }
    function TS() { return H.TS(); }
    function setP(path, v) { return H.withTimeout(v == null ? r.node.child(path).remove() : r.node.child(path).set(v), 12000); }
    function failed(e) { warn(e); if (live()) toast('Couldn’t save — check your connection and try again', 'error', 3200); }

    // ---- reading -----------------------------------------------------------------------------------
    function refresh() {
      if (!live()) return;
      if (S.busy) { S.again = true; return; }
      S.busy = true;
      RC.decodeAll({ key: r.key, id: r.id, R: R, resp: S.raw, me: rid, cache: S.cache || (S.cache = {}) }).then(function (d) {
        if (!live()) return;
        S.data = d;
        var input = R.hidden ? { answers: [], hidden: d.hidden, agg: S.agg } : d;
        S.t = RC.tally(R, input);
        if (!T.lists && !R.hidden && !local) {
          var mine = d.answers.filter(function (a) { return a.me; })[0];
          if (mine && !S.ansTouched) S.ans = mine.a;
        }
        settleClaims();
        render();
      }).catch(warn).then(function () { S.busy = false; if (S.again) { S.again = false; refresh(); } });
    }
    function answered() { return T.lists || !!(S.ans && T.answer(S.ans, spec)); }
    // Packing: a claim of ours that someone beat (earlier server time) is withdrawn, and we say so.
    function settleClaims() {
      if (R.type !== 'packing' || !S.t || !accepting()) return;
      S.t.items.forEach(function (x) {
        x.claims.forEach(function (c) {
          if (!c.me || c.got >= c.q || S.fixing[x.id]) return;
          S.fixing[x.id] = true;
          var winner = x.claims.filter(function (o) { return !o.me && o.got > 0; }).map(function (o) { return o.name; })[0] || 'Someone';
          var p = c.got > 0
            ? RC.sealItem(r.key, r.id, rid, x.id, { q: c.got }, c.at).then(function (rec) { return setP('resp/' + rid + '/i/' + x.id, rec); })
            : setP('resp/' + rid + '/i/' + x.id, null);
          if (live()) toast(c.got > 0 ? 'Only ' + c.got + ' more ' + x.t + ' needed — you’re down for ' + c.got : winner + ' got there first — “' + x.t + '” is taken', 'info', 3600);
          if (!c.got && Cade.haptic) Cade.haptic(30);
          p.catch(warn).then(function () { S.fixing[x.id] = false; });
        });
      });
    }

    // ---- writing -----------------------------------------------------------------------------------
    // Answer types: one record per browser, replaced on every change (in order).
    function saveAnswer() {
      if (!accepting()) return;
      S.ansTouched = true;
      local = { a: S.ans };
      lsSet('ans', JSON.stringify(local));
      if (S.queued) return;
      S.queued = true;
      S.chain = S.chain.then(function () {
        S.queued = false;
        if (!accepting()) return;
        var a = T.answer(S.ans, spec);
        if (!a) return setP('resp/' + rid, null);
        return RC.sealAnswer({ key: r.key, id: r.id, rid: rid, R: R, name: S.name, anon: S.anon, a: a, ts: TS() }).then(function (rec) { return setP('resp/' + rid, rec); })
          .then(function () { S.saved++; flash(); if (R.hidden) render(); });
      }).catch(failed);
    }
    function sendName() {
      if (S.nameSent) return Promise.resolve();
      return RC.sealName(r.key, r.id, rid, S.anon ? '' : S.name).then(function (n) { S.nameSent = true; return setP('resp/' + rid + '/n', n); });
    }
    function itemWrite(item, v, at) {
      if (!accepting()) return Promise.resolve();
      S.pend[item] = true;
      render();
      return sendName().then(function () {
        if (v == null) return setP('resp/' + rid + '/i/' + item, null);
        return RC.sealItem(r.key, r.id, rid, item, v, at || TS()).then(function (rec) { return setP('resp/' + rid + '/i/' + item, rec); });
      }).catch(failed).then(function () { delete S.pend[item]; delete S.optim[item]; render(); });
    }
    var flashT = 0;
    function flash() {
      var s = root.querySelector('.br-saved');
      if (s) { s.classList.add('br-flash'); clearTimeout(flashT); flashT = setTimeout(function () { s.classList.remove('br-flash'); }, 900); }
      if (Cade.haptic) Cade.haptic(10);
    }
    function needName(focusIt) {
      if (S.named) return false;
      var i = root.querySelector('.br-name-in');
      if (focusIt && i) { i.focus(); i.classList.add('br-shake'); setTimeout(function () { i.classList.remove('br-shake'); }, 500); }
      return true;
    }

    // ---- actions ---------------------------------------------------------------------------------------
    function act(a, b) {
      var id = b.getAttribute('data-id');
      if (a === 'name-ok' || a === 'anon') {
        var inp = root.querySelector('.br-name-in'), nm = RC.cleanPerson(inp ? inp.value : '');
        if (a === 'name-ok' && !nm) { if (inp) { inp.focus(); inp.classList.add('br-shake'); setTimeout(function () { inp.classList.remove('br-shake'); }, 500); } return; }
        var renamed = S.named && (S.anon !== (a === 'anon') || S.name !== nm);
        S.anon = a === 'anon'; S.name = S.anon ? '' : nm; S.named = true; S.editName = false;
        lsSet('name', S.name || null); lsSet('anon', S.anon ? '1' : null);
        if (S.name) try { Cade.store.set('cade-burn-lastname', S.name); } catch (e) {}
        if (renamed) {
          S.nameSent = false;
          if (T.lists) { if (S.data && (S.data.items.some(function (x) { return x.me; }) || S.data.added.some(function (x) { return x.me; }))) sendName().catch(failed); }
          else if (answered()) saveAnswer();
        }
        render();
        var first = root.querySelector('.br-body button:not([disabled]), .br-body input'); if (first && !('ontouchstart' in window)) first.focus({ preventScroll: true });
        return;
      }
      if (a === 'rename') { S.editName = true; render(); var ni = root.querySelector('.br-name-in'); if (ni) ni.focus(); return; }
      if (!accepting()) return;
      if (needName(true)) return;
      if (R.type === 'poll') {
        var cur = S.ans || { pick: [], other: '' };
        if (a === 'pick') {
          var has = cur.pick.indexOf(id) >= 0;
          if (spec.multi) cur.pick = has ? cur.pick.filter(function (x) { return x !== id; }) : cur.pick.concat([id]);
          else { cur.pick = has ? [] : [id]; if (!has) cur.other = ''; }
          S.ans = cur; render(); saveAnswer();
        } else if (a === 'other') {
          var ot = root.querySelector('.br-other-in'), tx = String(ot ? ot.value : '').trim();
          cur.other = tx;
          if (!spec.multi && tx) cur.pick = [];
          S.ans = cur; render(); saveAnswer();
        }
      } else if (R.type === 'dates' && a === 'ans') {
        var v = b.getAttribute('data-v'), d = S.ans || {};
        if (d[id] === v) delete d[id]; else d[id] = v;
        S.ans = d; render(); saveAnswer();
      } else if (R.type === 'rsvp') {
        var x = S.ans || { r: '', plus: 0 };
        if (a === 'rsvp') { x.r = b.getAttribute('data-v'); if (x.r === 'n') x.plus = 0; }
        else if (a === 'plus') x.plus = Math.max(0, Math.min(spec.plus, (x.plus | 0) + (+b.getAttribute('data-d'))));
        S.ans = x; render(); saveAnswer();
      } else if (R.type === 'packing') {
        var it = S.t && S.t.items.filter(function (z) { return z.id === id; })[0];
        if (!it || S.pend[id]) return;
        var mine = it.claims.filter(function (c) { return c.me; })[0];
        if (a === 'claim') { if (Cade.haptic) Cade.haptic(12); itemWrite(id, { q: 1 }); }
        else if (a === 'unclaim') itemWrite(id, null);
        else if (a === 'q') {
          var q = Math.max(0, Math.min(it.need, (mine ? mine.q : 0) + (+b.getAttribute('data-d'))));
          if (!mine && q > it.left) return;
          itemWrite(id, q ? { q: q } : null, mine ? mine.at : 0);
        }
      } else if (R.type === 'list') {
        if (a === 'tick') {
          var li = S.t && S.t.items.filter(function (z) { return z.id === id; })[0];
          if (!li) return;
          var on = !(id in S.optim ? S.optim[id] : li.on);
          S.optim[id] = on;
          if (Cade.haptic) Cade.haptic(8);
          itemWrite(id, { on: on });
        } else if (a === 'add') {
          var ai = root.querySelector('.br-add-in'), txt = String(ai ? ai.value : '').trim();
          if (!txt) { if (ai) ai.focus(); return; }
          var k = RC.newItemId();
          if (ai) ai.value = '';
          sendName().then(function () { return RC.sealAdded(r.key, r.id, rid, k, txt, TS()); }).then(function (rec) { return setP('resp/' + rid + '/x/' + k, rec); })
            .then(function () { var a2 = root.querySelector('.br-add-in'); if (a2 && !('ontouchstart' in window)) a2.focus(); }, failed);
        } else if (a === 'unadd') {
          Promise.all([setP('resp/' + rid + '/x/' + id, null), setP('resp/' + rid + '/i/' + id, null)]).catch(failed);
        }
      }
    }
    root.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act]');
      if (!b || !root.contains(b) || b.disabled) return;
      act(b.getAttribute('data-act'), b);
    });
    root.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      var t = ev.target;
      if (t.classList.contains('br-name-in')) { ev.preventDefault(); act('name-ok', t); }
      else if (t.classList.contains('br-other-in')) { ev.preventDefault(); act('other', t); }
      else if (t.classList.contains('br-add-in')) { ev.preventDefault(); act('add', t); }
    });

    // ---- rendering ---------------------------------------------------------------------------------------
    function hint() {
      if (R.type === 'poll') return (spec.multi ? 'Pick as many as you like' : 'Pick one') + ' · one vote per browser';
      if (R.type === 'dates') return 'Tap yes, maybe or no for each date';
      if (R.type === 'rsvp') return 'Let them know if you can make it';
      if (R.type === 'packing') return 'Tap what you’ll bring — first come, first served';
      return 'Tap to tick things off' + (spec.add ? ' — or add to the list' : '');
    }
    function nameCard() {
      var last = '';
      try { last = S.name || Cade.store.get('cade-burn-lastname') || ''; } catch (e) {}
      var who = R.hidden ? 'Only the organiser will see it.' : T.lists ? 'So everyone knows who’s on it.' : spec.vis === 'live' ? 'Others with the link see it next to your answer.' : 'Shown next to your answer.';
      return '<section class="br-card br-namecard"><label class="br-name-l" for="br-name-in">' + (S.editName ? 'Change your name' : 'First, what’s your name?') + '</label>' +
        '<input id="br-name-in" class="form-input br-name-in" type="text" maxlength="' + RC.MAX_PERSON + '" autocomplete="given-name" autocapitalize="words" enterkeyhint="go" placeholder="Your name" value="' + esc(last) + '">' +
        '<p class="br-hint">' + esc(who) + ' Remembered in this browser for this link.</p>' +
        '<div class="br-acts"><button type="button" class="btn btn-primary br-big" data-act="name-ok">Continue</button>' +
        (R.type === 'poll' && spec.anon ? '<button type="button" class="btn br-big" data-act="anon">Vote anonymously</button>' : '') + '</div></section>';
    }
    function whoLine() {
      return '<p class="br-as">' + (S.anon ? 'Voting anonymously' : 'Answering as <b>' + esc(S.name) + '</b>') + ' · <button type="button" class="br-link" data-act="rename">Change</button></p>';
    }
    function banner() {
      var b = [];
      if (S.closed) b.push('<div class="br-banner br-closed" role="status">🔒 <b>Responses are closed.</b> ' + (T.lists ? 'The list can’t be changed any more.' : 'You can still see ' + (R.hidden && !S.agg ? 'how many answered.' : 'the results.')) + '</div>');
      if (R.hidden) b.push(S.agg
        ? '<div class="br-banner br-reveal" role="status">📣 <b>The organiser shared the results</b> (totals only).</div>'
        : '<div class="br-banner br-private">🔐 <b>Private results:</b> only the organiser can see the answers' + (S.data ? ' — ' + plural(S.data.hidden, 'person has', 'people have') + ' answered so far.' : '.') + '</div>');
      return b.join('');
    }
    function body(see) {
      var dis = !accepting() || !S.named ? ' disabled' : '';
      var t = S.t;
      if (R.type === 'poll') {
        var a = S.ans || { pick: [], other: '' };
        var top = t && see ? Math.max(1, t.voters) : 0;
        return '<div class="br-opts' + (spec.multi ? ' br-multi' : '') + '" role="group" aria-label="Choices">' + spec.opts.map(function (o) {
          var on = a.pick.indexOf(o.id) >= 0, n = t && see ? t.counts[o.id] : 0;
          return '<button type="button" class="br-opt' + (on ? ' br-on' : '') + (see && t && t.leaders.indexOf(o.id) >= 0 ? ' br-lead' : '') + '" data-act="pick" data-id="' + o.id + '" aria-pressed="' + on + '"' + dis + '>' +
            (see ? '<span class="br-fill" style="width:' + pct(n, top) + '%"></span>' : '') +
            '<span class="br-mark" aria-hidden="true"></span><span class="br-opt-t">' + esc(o.t) + '</span>' +
            (see && t ? '<span class="br-opt-n">' + n + '<small>' + pct(n, t.voters) + '%</small></span>' : '') + '</button>' +
            (see && t && t.names[o.id] && t.names[o.id].length ? '<div class="br-who-l">' + names(t.names[o.id]) + '</div>' : '');
        }).join('') +
          (spec.other ? '<div class="br-other' + (a.other ? ' br-on' : '') + '"><input class="form-input br-other-in" type="text" maxlength="' + RC.MAX_OTHER + '" placeholder="Something else…" value="' + esc(a.other) + '" enterkeyhint="send"' + dis + ' aria-label="Your own answer">' +
            '<button type="button" class="btn" data-act="other"' + dis + '>' + (a.other ? 'Update' : 'Vote') + '</button></div>' : '') + '</div>' +
          (see && t && t.otherCount ? '<div class="br-others"><b>Other answers (' + t.otherCount + ')</b>' + (t.others.length ? '<ul>' + t.others.map(function (x) { return '<li>' + esc(x.t) + ' <span>— ' + esc(x.name) + '</span></li>'; }).join('') + '</ul>' : '') + '</div>' : '') +
          '<p class="br-saved" role="status" aria-live="polite">' + (answered() ? '✓ Your vote is saved' + (accepting() ? ' — tap to change it.' : '.') : see || R.hidden ? '' : 'Results appear once you’ve voted.') + '</p>';
      }
      if (R.type === 'dates') {
        var d = S.ans || {};
        return '<div class="br-slots">' + spec.slots.map(function (x) {
          var g = t && see ? t.slots[x.id] : null, best = !!(t && see && t.best.indexOf(x.id) >= 0);
          return '<div class="br-slot' + (best ? ' br-best' : '') + '"><div class="br-slot-h"><span class="br-slot-d">' + esc(RC.fmtDate(x.d, H.rvNow())) + '</span>' + (x.t ? '<span class="br-slot-t">' + esc(RC.fmtTime(x.t)) + '</span>' : '') +
            (best ? '<span class="br-badge">★ Best so far</span>' : '') + '</div>' +
            '<div class="br-yn" role="group" aria-label="' + esc(RC.fmtSlot(x, H.rvNow())) + '">' + [['y', 'Yes'], ['m', 'Maybe'], ['n', 'No']].map(function (k) {
              return '<button type="button" class="br-yn-' + k[0] + (d[x.id] === k[0] ? ' br-on' : '') + '" data-act="ans" data-id="' + x.id + '" data-v="' + k[0] + '" aria-pressed="' + (d[x.id] === k[0]) + '"' + dis + '>' + k[1] + '</button>';
            }).join('') + '</div>' +
            (g ? '<div class="br-slot-c">' + g.y + ' yes' + (g.m ? ' · ' + g.m + ' maybe' : '') + (g.n ? ' · ' + g.n + ' no' : '') + '</div>' : '') + '</div>';
        }).join('') + '</div>' +
          '<p class="br-saved" role="status" aria-live="polite">' + (answered() ? '✓ Saved — change any answer until it closes.' : see || R.hidden ? '' : 'Everyone’s answers appear once you’ve answered.') + '</p>';
      }
      if (R.type === 'rsvp') {
        var x = S.ans || { r: '', plus: 0 };
        return '<div class="br-rsvp" role="group" aria-label="Your reply">' + [['y', 'Yes, I’ll be there', '🎉'], ['m', 'Maybe', '🤔'], ['n', 'Can’t make it', '😢']].map(function (k) {
          return '<button type="button" class="br-rsvp-b br-yn-' + k[0] + (x.r === k[0] ? ' br-on' : '') + '" data-act="rsvp" data-v="' + k[0] + '" aria-pressed="' + (x.r === k[0]) + '"' + dis + '><span aria-hidden="true">' + k[2] + '</span>' + esc(k[1]) + '</button>';
        }).join('') + '</div>' +
          (spec.plus && (x.r === 'y' || x.r === 'm') ? '<div class="br-plus"><span>Bringing anyone?</span><div class="br-step"><button type="button" class="btn" data-act="plus" data-d="-1" aria-label="Fewer guests"' + dis + (x.plus ? '' : ' disabled') + '>−</button><b>+' + (x.plus | 0) + '</b>' +
            '<button type="button" class="btn" data-act="plus" data-d="1" aria-label="More guests"' + dis + ((x.plus | 0) >= spec.plus ? ' disabled' : '') + '>+</button></div></div>' : '') +
          '<p class="br-saved" role="status" aria-live="polite">' + (x.r ? '✓ Reply saved' + (accepting() ? ' — you can change it.' : '.') : '') + '</p>';
      }
      if (R.type === 'packing') {
        if (!t) return '<p class="br-wait">Loading the list…</p>';
        return '<ul class="br-items">' + t.items.map(function (x) {
          var mine = x.claims.filter(function (c) { return c.me && c.got > 0; })[0], others = x.claims.filter(function (c) { return !c.me && c.got > 0; });
          var cls = mine ? 'br-mine' : x.left ? 'br-open' : 'br-taken', pend = S.pend[x.id];
          var status = x.need > 1
            ? (x.need - x.left) + ' of ' + x.need + ' covered' + (others.length || mine ? ' — ' + esc(x.claims.filter(function (c) { return c.got > 0; }).map(function (c) { return (c.me ? 'you' : c.name) + ' ' + c.got; }).join(', ')) : '')
            : mine ? 'You’re bringing it' : others.length ? esc(others[0].name) + ' is bringing it' : 'Still needed';
          var acts;
          if (x.need > 1) {
            var q = mine ? mine.q : 0;
            acts = q ? '<div class="br-step"><button type="button" class="btn" data-act="q" data-d="-1" data-id="' + x.id + '" aria-label="Bring fewer"' + dis + '>−</button><b>' + q + '</b><button type="button" class="btn" data-act="q" data-d="1" data-id="' + x.id + '" aria-label="Bring more"' + dis + (x.left ? '' : ' disabled') + '>+</button></div>'
              : x.left ? '<button type="button" class="btn br-claim" data-act="q" data-d="1" data-id="' + x.id + '"' + dis + '>' + (pend ? '…' : 'I’ll bring some') + '</button>' : '';
          } else acts = mine ? '<button type="button" class="btn br-undo" data-act="unclaim" data-id="' + x.id + '"' + dis + '>' + (pend ? '…' : 'Undo') + '</button>'
            : x.left ? '<button type="button" class="btn br-claim" data-act="claim" data-id="' + x.id + '"' + dis + '>' + (pend ? '…' : 'I’ll bring it') + '</button>' : '';
          return '<li class="br-item ' + cls + '"><div class="br-item-m"><span class="br-item-t">' + (mine ? '✓ ' : '') + esc(x.t) + (x.need > 1 ? ' <small>×' + x.need + '</small>' : '') + '</span><span class="br-item-s">' + status + '</span></div>' + acts + '</li>';
        }).join('') + '</ul><p class="br-saved" role="status" aria-live="polite">' + (t.open ? plural(t.open, 'thing') + ' still needed.' : 'Everything’s covered 🎉') + '</p>';
      }
      if (R.type === 'list') {
        if (!t) return '<p class="br-wait">Loading the list…</p>';
        var now = H.rvNow();
        return '<ul class="br-ticks">' + t.items.map(function (x) {
          var on = x.id in S.optim ? S.optim[x.id] : x.on;
          return '<li class="br-tick-r"><button type="button" class="br-tick' + (on ? ' br-on' : '') + '" role="checkbox" aria-checked="' + on + '" data-act="tick" data-id="' + x.id + '"' + dis + '><span class="br-box" aria-hidden="true"></span>' +
            '<span class="br-tick-m"><span class="br-tick-t">' + esc(x.t) + '</span>' +
            (x.by && !(x.id in S.optim) ? '<span class="br-tick-s">' + (x.on ? '✓ ' : 'Unticked by ') + esc(x.byMe ? 'you' : x.by) + ' · ' + esc(RC.fmtAgo(now - x.byAt)) + '</span>' : x.addedBy ? '<span class="br-tick-s">Added by ' + esc(x.addedRid === rid ? 'you' : x.addedBy) + '</span>' : '') + '</span></button>' +
            (x.addedRid === rid && accepting() ? '<button type="button" class="br-rm" data-act="unadd" data-id="' + x.id + '" aria-label="Remove ' + esc(x.t) + '">×</button>' : '') + '</li>';
        }).join('') + (t.items.length ? '' : '<li class="br-empty">Nothing on the list yet.</li>') + '</ul>' +
          (spec.add && accepting() ? '<div class="br-addrow"><input class="form-input br-add-in" type="text" maxlength="' + RC.MAX_T + '" placeholder="Add an item…" enterkeyhint="done"' + (S.named ? '' : ' disabled') + ' aria-label="New item"><button type="button" class="btn" data-act="add"' + dis + '>Add</button></div>' : '') +
          '<p class="br-saved" role="status" aria-live="polite">' + t.done + ' of ' + t.items.length + ' ticked</p>';
      }
      return '';
    }
    function extra(see) {
      if (!see || !S.t) return '';
      if (R.type === 'dates') return S.t.voters ? '<section class="br-res"><h2>Everyone’s answers</h2>' + datesGrid(R, S.t, { names: !S.t.fromAgg, now: H.rvNow() }) + '</section>' : '';
      if (R.type === 'rsvp') return S.t.voters ? '<section class="br-res"><h2>Replies</h2>' + rsvpResults(R, S.t, { names: !S.t.fromAgg }) + '</section>' : '';
      return '';
    }
    function render() {
      if (!live()) return;
      // Keep whatever is being typed (and its caret) across a re-render.
      var ae = document.activeElement, keep = null;
      if (ae && root.contains(ae) && ae.tagName === 'INPUT') keep = { cls: ae.className.split(' ').filter(function (c) { return /^br-(name|other|add)-in$/.test(c); })[0], v: ae.value, s: ae.selectionStart, e: ae.selectionEnd };
      var see = R.hidden ? !!S.agg : RC.canSee(R, answered(), S.closed);
      var showName = !S.named || S.editName;
      root.innerHTML = '<div class="br-wrap">' +
        '<header class="br-hero">' + (named ? '<div class="br-kind"><span aria-hidden="true">' + T.icon + '</span> ' + esc(CHIP[R.type] || T.short) + '</div>' : '') + '<h1 class="br-q">' + esc(spec.q) + '</h1><p class="br-sub">' + esc(hint()) + '</p></header>' +
        banner() + (showName && (accepting() || S.editName) ? nameCard() : S.named ? whoLine() : '') +
        '<section class="br-body' + (showName ? ' br-dim' : '') + '">' + body(see) + '</section>' + extra(see) + '</div>';
      if (keep && keep.cls) {
        var n = root.querySelector('.' + keep.cls);
        if (n) { n.value = keep.v; n.focus({ preventScroll: true }); try { n.setSelectionRange(keep.s, keep.e); } catch (e) {} }
      }
    }
    // Footer: what's true, plainly.
    var bits = [];
    if (R.hidden) bits.push('<b>Private results:</b> answers are encrypted so only the organiser can read them.');
    else if (!T.lists) bits.push('Anyone with this link can see the answers' + (spec.vis === 'after' ? ' once they’ve answered.' : '.'));
    bits.push(T.lists ? 'Your name and ticks are shared with everyone who has the link.' : 'One response per browser — you can change yours until it closes.');
    if (r.meta.expiresAt) bits.push(r.head.timer ? 'It self-destructs in <b class="burn-left">' + esc(C.fmtLeft(C.msLeft(r.meta, H.rvNow()))) + '</b>.' : 'It self-destructs when its time is up.');
    H.rvFoot('<p>' + bits.join(' ') + '</p>');

    // ---- live --------------------------------------------------------------------------------------------
    var respRef = r.node.child('resp'), closedRef = r.node.child('closed'), revRef = r.node.child('reveal');
    var onResp = function (s) { S.raw = s.val(); refresh(); };
    var onClosed = function (s) { var c = !!s.val(); if (c !== S.closed) { S.closed = c; render(); } };
    var onRev = function (s) {
      var v = s.val();
      if (!v) { if (S.agg) { S.agg = null; refresh(); } return; }
      RC.openReveal(r.key, r.id, v).then(function (x) { if (!live()) return; S.agg = x ? x.agg : null; refresh(); }, function () {});
    };
    respRef.on('value', onResp); closedRef.on('value', onClosed);
    if (R.hidden) revRef.on('value', onRev);
    r.offs.push(function () {
      respRef.off('value', onResp); closedRef.off('value', onClosed); revRef.off('value', onRev);
      clearTimeout(flashT);
    });
    // Ticks say "2 min ago": keep that fresh while the page is open and visible.
    if (R.type === 'list') {
      var ago = setInterval(function () { if (document.visibilityState === 'visible' && !(document.activeElement && root.contains(document.activeElement) && document.activeElement.tagName === 'INPUT')) render(); }, 30000);
      r.offs.push(function () { clearInterval(ago); });
    }
    render();
    return true;
  }

  // =====================================================================================================
  // OWNER — live state of one link (summaries in the list, the results view)
  // =====================================================================================================
  // The spec: from the synced blob, else from the link's head (the server copy everyone sees).
  function linkR(e, node) {
    var L = rbGet(e.id);
    if (L && L.spec) {
      var R = RC.readRespond({ respond: { type: L.type, spec: L.spec, pub: L.pub } });
      if (R) return Promise.resolve(R);
    }
    return H.once(node.child('head'), 12000).then(function (h) {
      if (!h) throw new Error('gone');
      return C.open(e.key, e.id, 'head', h);
    }).then(function (head) { var R = RC.readRespond(head); if (!R) throw new Error('bad head'); return R; });
  }
  // cb(state): { R, t, data, closed, revealed, noKey, summary, count } on every change. → off()
  function watch(e, cb) {
    var st = { e: e, cache: {}, raw: null, closed: null, reveal: null, busy: false, again: false }, offs = [], stopped = false;
    H.ownerRoot(e.db).then(function (root) {
      if (stopped) return;
      var node = st.node = H.nodeOf(root, e.id);
      return linkR(e, node).then(function (R) {
        if (stopped) return;
        st.R = R;
        ['resp', 'closed', 'reveal'].forEach(function (k) {
          var ref = node.child(k), fn = function (s) { st[k === 'resp' ? 'raw' : k] = s.val(); st.loaded = (st.loaded || 0) | ({ resp: 1, closed: 2, reveal: 4 })[k]; if (st.loaded === 7) go(); };
          ref.on('value', fn); offs.push(function () { ref.off('value', fn); });
        });
        var rf = function () { go(); };
        rbListeners.push(rf); offs.push(function () { rbListeners = rbListeners.filter(function (f) { return f !== rf; }); });
      });
    }).catch(function (err) { if (!stopped) { st.error = err; cb(st); } });
    function go() {
      if (stopped) return;
      if (st.busy) { st.again = true; return; }
      st.busy = true;
      var L = rbGet(e.id), priv = L && L.priv, R = st.R;
      st.noKey = R.hidden && !priv;
      var revP = st.reveal ? RC.openReveal(e.key, e.id, st.reveal).catch(function () { return null; }) : Promise.resolve(null);
      Promise.all([RC.decodeAll({ key: e.key, id: e.id, R: R, resp: st.raw, priv: priv, cache: st.cache }), revP]).then(function (x) {
        if (stopped) return;
        var d = x[0], rv = x[1];
        st.data = d; st.revealed = !!rv;
        st.t = RC.tally(R, st.noKey ? { answers: [], hidden: d.hidden, agg: rv ? rv.agg : null } : d);
        st.count = st.noKey ? d.hidden : RC.typeOf(R.type).lists ? Object.keys(st.raw || {}).length : d.answers.length;
        st.summary = RC.summary(R, st.t, { now: H.now() }) + (st.noKey && !rv ? ' · ' + plural(d.hidden, 'answer') + ' (key on another device)' : '');
        // A revealed result is kept current by whichever owner device is looking.
        if (rv && !st.noKey && R.hidden) {
          var agg = RC.aggregate(R, st.t);
          if (JSON.stringify(agg) !== JSON.stringify(rv.agg)) RC.sealReveal(e.key, e.id, agg, H.now()).then(function (s) { return st.node.child('reveal').set(s); }).catch(warn);
        }
        cb(st);
      }).catch(warn).then(function () { st.busy = false; if (st.again) { st.again = false; go(); } });
    }
    return function () { stopped = true; offs.forEach(function (f) { try { f(); } catch (x) {} }); offs = []; };
  }
  // The list row's line, while the dialog is open. cb({ text, closed }) → off()
  function summarize(e, cb) {
    return watch(e, function (st) {
      if (st.error) { cb({ text: '', closed: false }); return; }
      cb({ text: st.summary + (st.closed ? ' · closed' : ''), closed: !!st.closed });
    });
  }

  // The results view, in the dialog: el (an empty section), e (the entry). → { close() }
  function results(el, e) {
    var st = null, off = null, armed = '';
    el.innerHTML = '<div class="br-rv-top"><button type="button" class="btn burn-sm br-back" data-act="br-back">‹ Back</button><div class="br-rv-h"><b>' + esc(e.title) + '</b><span class="br-rv-s">Loading…</span></div></div><div class="br-rv-b"><div class="burn-rv-wait"><span class="burn-spin" aria-hidden="true"></span><span>Loading results…</span></div></div>';
    function draw() {
      if (!st) return;
      if (st.error) { el.querySelector('.br-rv-b').innerHTML = '<p class="burn-hint">Couldn’t load the results — the link may have ended, or you’re offline.</p>'; el.querySelector('.br-rv-s').textContent = ''; return; }
      var R = st.R, T = RC.typeOf(R.type), t = st.t, ended = !!e.ended;
      el.querySelector('.br-rv-s').textContent = st.summary + (st.closed ? ' · closed' : '');
      var vis = T.lists ? 'Shared with everyone who has the link' : R.hidden ? (st.revealed ? 'Private — totals revealed to them' : 'Private — only you see the answers') : R.spec.vis === 'after' ? 'They see results after answering' : 'Everyone sees results live';
      var acts = [];
      if (!ended) {
        if (R.hidden && !st.noKey) acts.push(st.revealed ? '<button type="button" class="btn" data-act="br-hide">Hide results again</button>' : '<button type="button" class="btn btn-primary" data-act="br-reveal">Reveal results</button>');
        acts.push(st.closed ? '<button type="button" class="btn" data-act="br-open">Reopen responses</button>'
          : '<button type="button" class="btn' + (armed === 'close' ? ' burn-armed' : '') + '" data-act="br-close">' + (armed === 'close' ? 'Tap again to close' : T.lists ? 'Lock the list' : 'Close responses') + '</button>');
      }
      acts.push('<button type="button" class="btn" data-act="br-md">Copy results into the note</button>');
      if (!ended) acts.push('<button type="button" class="btn" data-act="br-link">Copy link</button>');
      var bodyHtml = st.noKey && !st.revealed
        ? '<p class="br-nokey">🔐 These answers are encrypted to a key that isn’t on this device yet — it syncs from the device that made the link. ' + plural(st.data.hidden, 'person has', 'people have') + ' answered.</p>'
        : (R.spec.q !== e.title ? '<h3 class="br-rv-q">' + esc(R.spec.q) + '</h3>' : '') + resultsHtml(R, t, { names: !t.fromAgg, owner: true, now: H.now() }) +
          (T.lists || t.voters ? '' : '<p class="burn-hint">No answers yet.</p>');
      el.querySelector('.br-rv-b').innerHTML = '<div class="br-rv-meta"><span>' + T.icon + ' ' + esc(CHIP[R.type] || T.short) + '</span><span>' + esc(vis) + '</span>' + (st.closed ? '<span class="br-closed-tag">Closed</span>' : '') + '</div>' +
        bodyHtml + '<div class="burn-acts br-rv-acts">' + acts.join('') + '</div>' +
        '<p class="burn-fine">' + (st.closed ? 'Closed: nobody can change their answer; they can still see the results until the link ends. ' : '') +
        'Results stay readable until the link ends; what you copy into the note stays there.</p>';
    }
    off = watch(e, function (s) { st = s; draw(); });
    function onClick(ev) {
      var b = ev.target.closest('[data-act]');
      if (!b || !el.contains(b) || !st || !st.node) {
        if (b && b.getAttribute('data-act') === 'br-back') H.closeResults();
        return;
      }
      var a = b.getAttribute('data-act');
      if (a === 'br-back') H.closeResults();
      else if (a === 'br-link') H.copyText(H.linkFor(e));
      else if (a === 'br-md') {
        var md = RC.markdown(st.R, st.t, { now: H.now(), closed: !!st.closed });
        H.insertIntoNote(e, md).then(function (where) { toast(where === 'end' ? 'Results added to the end of “' + e.room + '”' : 'Results copied into the note', 'success', 2400); },
          function (err) { toast((err && err.message) || 'Couldn’t add the results to the note', 'error', 3000); });
      } else if (a === 'br-close') {
        if (armed !== 'close') { armed = 'close'; draw(); setTimeout(function () { if (armed === 'close') { armed = ''; draw(); } }, 3500); return; }
        armed = '';
        H.withTimeout(st.node.child('closed').set({ at: H.TS() }), 10000).then(function () { toast('Responses closed', 'success', 1800); }, function () { toast('Couldn’t reach the server', 'error', 2600); });
      } else if (a === 'br-open') H.withTimeout(st.node.child('closed').remove(), 10000).catch(function () { toast('Couldn’t reach the server', 'error', 2600); });
      else if (a === 'br-reveal') {
        var agg = RC.aggregate(st.R, st.t);
        RC.sealReveal(e.key, e.id, agg, H.now()).then(function (s) { return H.withTimeout(st.node.child('reveal').set(s), 10000); })
          .then(function () { toast('Results revealed — they now see the totals (not who voted for what)', 'success', 3000); }, function () { toast('Couldn’t reach the server', 'error', 2600); });
      } else if (a === 'br-hide') H.withTimeout(st.node.child('reveal').remove(), 10000).catch(function () { toast('Couldn’t reach the server', 'error', 2600); });
    }
    el.addEventListener('click', onClick);
    return { close: function () { if (off) off(); off = null; el.removeEventListener('click', onClick); el.innerHTML = ''; } };
  }

  var API = {
    composer: composer, prepare: prepare, remember: remember, forget: forget, describe: describe,
    recipient: recipient, summarize: summarize, results: results, watch: watch, rbGet: rbGet,
    CHIP: CHIP
  };
  window.__cadeBurnRespond = { init: function (host) { H = host; C = host.C; RC = window.__cadeBurnRespondCore; return API; } };
})();
