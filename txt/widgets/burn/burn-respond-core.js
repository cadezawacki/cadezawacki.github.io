/* Response links ("What they can do → Respond") — the DOM-free logic.
 * burn-respond.js is the UI; burn-core.js the link itself (see its header).
 * UMD: window.__cadeBurnRespondCore in the page, module.exports in node
 * (burn-respond.test.js). Loaded only when someone creates or opens a
 * response link, or the owner's list has one.
 *
 * A response link is an ordinary burn link (same id, key, expiry, slots,
 * tombstone) whose plain meta says `respond: true` and whose sealed head
 * carries { respond: { type, spec, pub } }. Extra nodes under the link:
 *   resp/<rid>     one browser's response — written ONLY by that browser
 *                  (<rid> is a random per-browser id kept in its storage)
 *     answer types (poll, dates, rsvp):
 *       { at: server time, ct: seal(link key, 'r/<rid>', { name, anon, a }) }   visible results
 *       { at: server time, h: hseal(owner public key, { name, anon, a }) }      hidden results
 *     list types (packing, list):
 *       n:          seal('r/<rid>/n', { name })
 *       i/<item>:   { at, ct: seal('r/<rid>/i/<item>', { q } | { on }) }        a claim / a tick
 *       x/<k>:      { at, ct: seal('r/<rid>/x/<k>', { t }) }                     an item they added
 *   closed         { at }  the owner stopped new responses (results stay readable)
 *   reveal         seal('reveal', { at, agg })  hidden results the owner revealed (counts, no names)
 * Hidden results: the owner's device makes an ECDH P-256 key pair when the
 * link is made. The public key travels in the sealed head; the private key
 * stays in the owner's synced storage. Each hidden response is sealed to it
 * with a fresh ephemeral key (ECDH → HKDF-SHA-256 → AES-GCM), so another
 * respondent — who has the link key — still can't read it.
 * Nothing is enforced by a server (there's no server code): one response per
 * browser, closing, and "only your own record" are what honest clients do. */
(function (root) {
  'use strict';
  var BC = (root && root.__cadeBurnCore) || (typeof require === 'function' ? require('./burn-core.js') : null);

  var MAX_Q = 300, MAX_T = 140, MAX_OTHER = 200, MAX_PERSON = 40;
  var MAX_OPTS = 20, MAX_ITEMS = 100, MAX_SLOTS = 40, MAX_ADDED = 60, MAX_NEED = 99, MAX_PLUS = 9;
  var DAY = 86400000;

  function str(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
  function cleanPerson(s) { return str(s, MAX_PERSON); }
  function intIn(n, lo, hi, dflt) { n = Math.floor(Number(n)); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function validRid(r) { return typeof r === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(r); }
  function validItemId(r) { return typeof r === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(r); }
  function newRid() { return BC.b64u(rand(12)); }
  function newItemId() { return 'x' + BC.b64u(rand(6)); }
  function rand(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
  function utf8(s) { return new TextEncoder().encode(s); }
  function unutf8(b) { return new TextDecoder().decode(b); }
  function byAt(a, b) { return (a.at - b.at) || (a.rid < b.rid ? -1 : a.rid > b.rid ? 1 : 0); }

  // ---- results visibility --------------------------------------------------------------------------
  // live: everyone sees results as they come in; after: once they've answered
  // (the data is sealed with the link key — the page just doesn't show it
  // before); hidden: sealed to the owner's key — only the owner can read them.
  var VIS = ['live', 'after', 'hidden'];
  function cleanVis(v) { return VIS.indexOf(v) >= 0 ? v : 'live'; }

  // ---- dates -----------------------------------------------------------------------------------------
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function validDate(d) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    var x = new Date(d + 'T00:00:00Z');
    return !isNaN(x) && x.toISOString().slice(0, 10) === d;
  }
  function validTime(t) { return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t); }
  // "Sat 2 Nov" (+ " 2027" when it isn't this year) — fixed English, so tests and exports don't depend on the device.
  function fmtDate(d, now) {
    if (!validDate(d)) return String(d || '');
    var x = new Date(d + 'T00:00:00Z'), y = x.getUTCFullYear();
    var thisYear = new Date(now || Date.now()).getFullYear();
    return WD[x.getUTCDay()] + ' ' + x.getUTCDate() + ' ' + MO[x.getUTCMonth()] + (y !== thisYear ? ' ' + y : '');
  }
  // "19:30" → "7:30 pm"; "19:00" → "7 pm"
  function fmtTime(t) {
    if (!validTime(t)) return '';
    var h = +t.slice(0, 2), m = t.slice(3), ap = h < 12 ? 'am' : 'pm', h12 = h % 12 || 12;
    return h12 + (m !== '00' ? ':' + m : '') + ' ' + ap;
  }
  function fmtSlot(s, now) { return fmtDate(s.d, now) + (s.t ? ' ' + fmtTime(s.t) : ''); }

  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  var ORD = '(?:st|nd|rd|th)?';
  var DATE_RES = [
    { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, f: function (m) { return { y: +m[1], mo: +m[2] - 1, d: +m[3] }; } },
    { re: new RegExp('\\b(\\d{1,2})' + ORD + '\\s+(?:of\\s+)?' + MON_RE + '\\.?(?:,?\\s+(\\d{4}))?\\b', 'gi'), f: function (m) { return { y: m[3] ? +m[3] : 0, mo: MONTHS[m[2].slice(0, 3).toLowerCase()], d: +m[1] }; } },
    { re: new RegExp('\\b' + MON_RE + '\\.?\\s+(\\d{1,2})' + ORD + '(?:,?\\s+(\\d{4}))?\\b', 'gi'), f: function (m) { return { y: m[3] ? +m[3] : 0, mo: MONTHS[m[1].slice(0, 3).toLowerCase()], d: +m[2] }; } }
  ];
  var TIME_RE = /\b(?:at\s+)?(?:(\d{1,2})(?::([0-5]\d))?\s*(am|pm|a\.m\.|p\.m\.)|([01]?\d|2[0-3]):([0-5]\d))(?![\d:])/i;
  // Dates (and a time after each) in one line of text → [{ d: 'YYYY-MM-DD', t: 'HH:MM' | '' , at: index }].
  // A date without a year is the next one on or after today.
  function datesIn(line, now) {
    var found = [], t0 = new Date(now || Date.now()), today = Date.UTC(t0.getFullYear(), t0.getMonth(), t0.getDate());
    DATE_RES.forEach(function (R) {
      R.re.lastIndex = 0;
      var m;
      while ((m = R.re.exec(line))) {
        var p = R.f(m), y = p.y;
        if (p.mo == null || !(p.d >= 1 && p.d <= 31)) continue;
        if (!y) { y = t0.getFullYear(); if (Date.UTC(y, p.mo, p.d) < today) y++; }
        var d = y + '-' + pad(p.mo + 1) + '-' + pad(p.d);
        if (!validDate(d)) continue;
        if (found.some(function (f) { return m.index < f.end && f.at < m.index + m[0].length; })) continue;
        found.push({ d: d, t: '', at: m.index, end: m.index + m[0].length });
      }
    });
    found.sort(function (a, b) { return a.at - b.at; });
    found.forEach(function (f, i) {
      var stop = i + 1 < found.length ? found[i + 1].at : line.length;
      var tm = TIME_RE.exec(line.slice(f.end, stop));
      if (!tm) return;
      var h, mi;
      if (tm[3]) { h = +tm[1]; mi = tm[2] ? +tm[2] : 0; if (h < 1 || h > 12) return; var pm = /^p/i.test(tm[3]); h = (h % 12) + (pm ? 12 : 0); }
      else { h = +tm[4]; mi = +tm[5]; }
      f.t = pad(h) + ':' + pad(mi);
    });
    return found.map(function (f) { return { d: f.d, t: f.t, at: f.at }; });
  }

  // ---- reading a note into a draft ------------------------------------------------------------------------
  var CHECK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.+?)\s*$/;
  var BULLET_RE = /^\s*(?:[-*+•]|\d+[.)])\s+(.+?)\s*$/;
  function plainLine(s) { return String(s).replace(/^#{1,6}\s+/, '').replace(/\*\*|__/g, '').replace(/^[*_]|[*_]$/g, '').trim(); }
  // "Chairs x6", "Chairs ×6", "Chairs (6)" → { t: 'Chairs', n: 6 }
  function qtyOf(t) {
    var m = String(t).match(/^(.*?)\s*(?:[x×]\s*(\d{1,3})|\((\d{1,3})\))$/i);
    if (m && m[1].trim()) return { t: m[1].trim(), n: intIn(m[2] || m[3], 1, MAX_NEED, 1) };
    return { t: String(t).trim(), n: 1 };
  }
  // The owner's note → what the composer can start from:
  //   { title, checklist: [{ t, done }], bullets: [t], poll: { q, opts: [t] } | null, dates: [{ d, t }], suggest }
  function parseNote(text, now) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var out = { title: '', checklist: [], bullets: [], poll: null, dates: [], suggest: null }, seen = {};
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i], m;
      if (!out.title && L.trim()) { var pl = plainLine(L); if (pl.length <= 80 && !CHECK_RE.test(L)) out.title = str(pl, 80); }
      if ((m = L.match(CHECK_RE))) out.checklist.push({ t: str(m[2], MAX_T), done: m[1] !== ' ' });
      else if ((m = L.match(BULLET_RE))) out.bullets.push(str(m[1], MAX_T));
      if (!out.poll) {
        var q = plainLine(L);
        if (/\?$/.test(q) && !BULLET_RE.test(L) || /\?$/.test(q) && /^\s*#/.test(L)) {
          var opts = [], j = i + 1;
          while (j < lines.length && !lines[j].trim() && j === i + 1) j++;   // one blank line allowed
          for (; j < lines.length; j++) {
            var c = lines[j].match(CHECK_RE), b = !c && lines[j].match(BULLET_RE);
            if (!c && !b) break;
            opts.push(str(c ? c[2] : b[1], MAX_T));
          }
          if (opts.length >= 2) out.poll = { q: str(q, MAX_Q), opts: opts.slice(0, MAX_OPTS) };
        }
      }
      datesIn(L, now).forEach(function (d) { var k = d.d + ' ' + d.t; if (!seen[k]) { seen[k] = 1; out.dates.push({ d: d.d, t: d.t }); } });
    }
    out.dates.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : a.t < b.t ? -1 : a.t > b.t ? 1 : 0; });
    out.dates = out.dates.slice(0, MAX_SLOTS);
    out.suggest = out.poll ? 'poll' : out.dates.length >= 2 ? 'dates' : out.checklist.length ? 'list' : out.bullets.length >= 2 ? 'list' : null;
    return out;
  }
  // Items for a list type: the checklist, else the bullets.
  function itemsFromNote(p) { return (p.checklist.length ? p.checklist.map(function (c) { return c.t; }) : p.bullets).slice(0, MAX_ITEMS); }

  // ---- the type registry ----------------------------------------------------------------------------------
  // A type: { id, label, short, icon, blurb, lists (item records rather than one answer), vis (offers results
  //   visibility), clean(spec, strict) → spec (strict: throws a user-facing message), fromNote(parsed, now) → spec,
  //   answer(a, spec) → a | null, tally(spec, data) → t, summary(spec, t, ctx) → text, agg(spec, t) → counts only,
  //   markdown(spec, t, ctx) → text }
  var TYPES = {}, ORDER = [];
  function registerType(def) { if (!def || !def.id) throw new Error('bad type'); TYPES[def.id] = def; if (ORDER.indexOf(def.id) < 0) ORDER.push(def.id); return def; }
  function typeOf(id) { return own(TYPES, id) ? TYPES[id] : null; }
  function types() { return ORDER.map(function (id) { return TYPES[id]; }); }

  // Options / items with stable ids. list: strings or { id, t, n }.
  function cleanList(list, max, withN) {
    var out = [], ids = {};
    (Array.isArray(list) ? list : []).forEach(function (x, i) {
      var o = typeof x === 'string' ? { t: x } : x && typeof x === 'object' ? x : null;
      if (!o) return;
      var t = str(o.t, MAX_T);
      if (!t || out.length >= max) return;
      var id = validItemId(o.id) && !ids[o.id] ? o.id : null;
      if (!id) { var k = out.length; do { id = 'i' + k.toString(36); k++; } while (ids[id]); }
      ids[id] = 1;
      var it = { id: id, t: t };
      if (withN) it.n = intIn(o.n, 1, MAX_NEED, 1);
      out.push(it);
    });
    return out;
  }
  function need(strict, ok, msg) { if (strict && !ok) throw new Error(msg); }

  function dupes(list) { var s = {}, d = false; list.forEach(function (o) { var k = o.t.toLowerCase(); if (s[k]) d = true; s[k] = 1; }); return d; }

  registerType({
    id: 'poll', label: 'Poll / vote', short: 'Poll', icon: '🗳️', blurb: 'One question, a few choices — they tap to vote.', vis: true,
    clean: function (s, strict) {
      s = s || {};
      var q = str(s.q, MAX_Q), opts = cleanList(s.opts, MAX_OPTS);
      need(strict, q, 'Type the question');
      need(strict, opts.length >= 2, 'Add at least two choices');
      need(strict, !dupes(opts), 'Two choices are the same');
      return { q: q, opts: opts, multi: !!s.multi, other: !!s.other, anon: !!s.anon, vis: cleanVis(s.vis) };
    },
    fromNote: function (p) { return p.poll ? { q: p.poll.q, opts: p.poll.opts } : { q: '', opts: p.bullets.length >= 2 ? p.bullets.slice(0, MAX_OPTS) : [] }; },
    answer: function (a, s) {
      if (!a || typeof a !== 'object') return null;
      var ids = {}, pick = [];
      s.opts.forEach(function (o) { ids[o.id] = 1; });
      (Array.isArray(a.pick) ? a.pick : []).forEach(function (id) { if (ids[id] && pick.indexOf(id) < 0) pick.push(id); });
      var other = s.other ? str(a.other, MAX_OTHER) : '';
      if (!s.multi) { if (pick.length > 1) pick = pick.slice(0, 1); if (pick.length) other = ''; }
      if (!pick.length && !other) return null;
      return { pick: pick, other: other };
    },
    tally: function (s, data) {
      var t = { voters: 0, counts: {}, names: {}, others: [], max: 0, leaders: [], hidden: data.hidden || 0 };
      s.opts.forEach(function (o) { t.counts[o.id] = 0; t.names[o.id] = []; });
      data.answers.forEach(function (r) {
        t.voters++;
        r.a.pick.forEach(function (id) { t.counts[id]++; t.names[id].push(r.label); });
        if (r.a.other) t.others.push({ name: r.label, t: r.a.other });
      });
      if (data.agg) { t.voters = data.agg.voters | 0; s.opts.forEach(function (o) { t.counts[o.id] = intIn(data.agg.counts && data.agg.counts[o.id], 0, 1e6, 0); }); t.otherCount = data.agg.others | 0; t.fromAgg = true; }
      else t.otherCount = t.others.length;
      s.opts.forEach(function (o) { if (t.counts[o.id] > t.max) t.max = t.counts[o.id]; });
      if (t.max) s.opts.forEach(function (o) { if (t.counts[o.id] === t.max) t.leaders.push(o.id); });
      return t;
    },
    summary: function (s, t) {
      var n = t.voters + ' vote' + (t.voters === 1 ? '' : 's');
      if (!t.voters) return 'Poll · no votes yet';
      var lab = function (id) { for (var i = 0; i < s.opts.length; i++) if (s.opts[i].id === id) return s.opts[i].t; return ''; };
      var lead = t.leaders.length === 1 ? lab(t.leaders[0]) + ' leads' : t.leaders.length === 2 ? lab(t.leaders[0]) + ' & ' + lab(t.leaders[1]) + ' tied' : t.leaders.length ? t.leaders.length + '-way tie' : 'only other answers';
      return 'Poll · ' + n + ' · ' + lead;
    },
    agg: function (s, t) { return { voters: t.voters, counts: t.counts, others: t.otherCount }; },
    markdown: function (s, t, ctx) {
      var lines = ['**' + mdCell(s.q) + '** — ' + t.voters + ' vote' + (t.voters === 1 ? '' : 's') + (ctx && ctx.closed ? ' (closed)' : ''), '',
        '| Choice | Votes | Who |', '| --- | ---: | --- |'];
      s.opts.forEach(function (o) {
        var lead = t.leaders.indexOf(o.id) >= 0 ? ' 🏆' : '';
        lines.push('| ' + mdCell(o.t) + lead + ' | ' + t.counts[o.id] + ' | ' + mdCell((t.names[o.id] || []).join(', ')) + ' |');
      });
      if (t.others.length) { lines.push(''); lines.push('Other answers:'); t.others.forEach(function (x) { lines.push('- ' + mdText(x.t) + ' — ' + mdText(x.name)); }); }
      return lines.join('\n');
    }
  });

  registerType({
    id: 'dates', label: 'Pick a date', short: 'Dates', icon: '📅', blurb: 'A few dates (and times) — everyone says yes, maybe or no.', vis: true,
    clean: function (s, strict) {
      s = s || {};
      var seen = {}, slots = [];
      (Array.isArray(s.slots) ? s.slots : []).forEach(function (x) {
        if (!x || !validDate(x.d) || slots.length >= MAX_SLOTS) return;
        var t = validTime(x.t) ? x.t : '', k = x.d + ' ' + t;
        if (seen[k]) return;
        seen[k] = 1;
        slots.push({ id: validItemId(x.id) ? x.id : '', d: x.d, t: t });
      });
      slots.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : a.t < b.t ? -1 : a.t > b.t ? 1 : 0; });
      var ids = {};
      slots.forEach(function (x, i) { if (!x.id || ids[x.id]) { var k = i; do { x.id = 's' + k.toString(36); k++; } while (ids[x.id]); } ids[x.id] = 1; });
      var q = str(s.q, MAX_Q);
      need(strict, slots.length >= 2, 'Add at least two dates');
      return { q: q || 'When works for you?', slots: slots, vis: cleanVis(s.vis) };
    },
    fromNote: function (p) { return { q: p.title || '', slots: p.dates }; },
    answer: function (a, s) {
      if (!a || typeof a !== 'object') return null;
      var out = {}, any = false;
      s.slots.forEach(function (x) { var v = a[x.id]; if (v === 'y' || v === 'm' || v === 'n') { out[x.id] = v; any = true; } });
      return any ? out : null;
    },
    tally: function (s, data) {
      var t = { voters: 0, slots: {}, best: [], people: [], hidden: data.hidden || 0 };
      s.slots.forEach(function (x) { t.slots[x.id] = { y: 0, m: 0, n: 0, who: { y: [], m: [], n: [] } }; });
      data.answers.forEach(function (r) {
        t.voters++;
        t.people.push({ name: r.label, a: r.a, me: !!r.me });
        s.slots.forEach(function (x) { var v = r.a[x.id]; if (v) { t.slots[x.id][v]++; t.slots[x.id].who[v].push(r.label); } });
      });
      if (data.agg) {
        t.voters = data.agg.voters | 0; t.fromAgg = true;
        s.slots.forEach(function (x) { var g = (data.agg.slots || {})[x.id] || {}; t.slots[x.id].y = g.y | 0; t.slots[x.id].m = g.m | 0; t.slots[x.id].n = g.n | 0; });
      }
      // Best: the most yeses; a maybe counts half; ties → all of them (earliest first).
      var top = 0;
      s.slots.forEach(function (x) { var g = t.slots[x.id], sc = g.y * 2 + g.m; g.score = sc; if (sc > top) top = sc; });
      if (top) s.slots.forEach(function (x) { if (t.slots[x.id].score === top) t.best.push(x.id); });
      return t;
    },
    summary: function (s, t, ctx) {
      if (!t.voters) return 'Dates · no answers yet';
      if (!t.best.length) return 'Dates · ' + t.voters + ' answered · nothing works yet';
      var b = slotById(s, t.best[0]), g = t.slots[b.id];
      return 'Dates · ' + fmtSlot(b, ctx && ctx.now) + (t.best.length > 1 ? ' (tied)' : ' best') + ' (' + g.y + ' yes' + (g.m ? ', ' + g.m + ' maybe' : '') + ')';
    },
    agg: function (s, t) { var o = {}; s.slots.forEach(function (x) { var g = t.slots[x.id]; o[x.id] = { y: g.y, m: g.m, n: g.n }; }); return { voters: t.voters, slots: o }; },
    markdown: function (s, t, ctx) {
      var now = ctx && ctx.now, MARK = { y: '✅', m: '🤔', n: '❌' };
      var head = '| | ' + s.slots.map(function (x) { return mdCell(fmtSlot(x, now)) + (t.best.indexOf(x.id) >= 0 ? ' ⭐' : ''); }).join(' | ') + ' |';
      var lines = ['**' + mdCell(s.q) + '** — ' + t.voters + ' answered' + (ctx && ctx.closed ? ' (closed)' : ''), '', head,
        '| --- | ' + s.slots.map(function () { return ':---:'; }).join(' | ') + ' |'];
      t.people.forEach(function (p) { lines.push('| ' + mdCell(p.name) + ' | ' + s.slots.map(function (x) { return MARK[p.a[x.id]] || ''; }).join(' | ') + ' |'); });
      lines.push('| **Yes** | ' + s.slots.map(function (x) { var g = t.slots[x.id]; return '**' + g.y + '**' + (g.m ? ' +' + g.m + '?' : ''); }).join(' | ') + ' |');
      if (t.best.length) lines.push('', 'Best: ' + t.best.map(function (id) { return fmtSlot(slotById(s, id), now); }).join(', '));
      return lines.join('\n');
    }
  });

  registerType({
    id: 'rsvp', label: 'RSVP', short: 'RSVP', icon: '💌', blurb: 'Are you coming? Yes, maybe or no — with guests if you like.', vis: true,
    clean: function (s, strict) {
      s = s || {};
      var q = str(s.q, MAX_Q);
      need(strict, q, 'Say what they’re replying to (e.g. “Dinner on Saturday”)');
      return { q: q, plus: intIn(s.plus, 0, MAX_PLUS, 0), vis: cleanVis(s.vis) };
    },
    fromNote: function (p) { return { q: p.title || '' }; },
    answer: function (a, s) {
      if (!a || (a.r !== 'y' && a.r !== 'm' && a.r !== 'n')) return null;
      return { r: a.r, plus: a.r === 'n' ? 0 : intIn(a.plus, 0, s.plus, 0) };
    },
    tally: function (s, data) {
      var t = { voters: 0, y: 0, m: 0, n: 0, heads: 0, who: { y: [], m: [], n: [] }, hidden: data.hidden || 0 };
      data.answers.forEach(function (r) {
        t.voters++; t[r.a.r]++;
        if (r.a.r === 'y') t.heads += 1 + r.a.plus;
        t.who[r.a.r].push(r.label + (r.a.plus ? ' +' + r.a.plus : ''));
      });
      if (data.agg) { var g = data.agg; t.voters = g.voters | 0; t.y = g.y | 0; t.m = g.m | 0; t.n = g.n | 0; t.heads = g.heads | 0; t.fromAgg = true; }
      return t;
    },
    summary: function (s, t) {
      if (!t.voters) return 'RSVP · no replies yet';
      return 'RSVP · ' + t.heads + ' coming' + (t.m ? ' · ' + t.m + ' maybe' : '') + (t.n ? ' · ' + t.n + ' can’t' : '');
    },
    agg: function (s, t) { return { voters: t.voters, y: t.y, m: t.m, n: t.n, heads: t.heads }; },
    markdown: function (s, t, ctx) {
      var L = ['**' + mdCell(s.q) + '** — ' + t.heads + ' coming' + (ctx && ctx.closed ? ' (closed)' : ''), ''];
      [['y', 'Coming'], ['m', 'Maybe'], ['n', 'Can’t come']].forEach(function (k) { if (t.who[k[0]].length) L.push('- **' + k[1] + ' (' + t.who[k[0]].length + '):** ' + t.who[k[0]].map(mdText).join(', ')); });
      if (L.length === 2) L.push('- No replies yet');
      return L.join('\n');
    }
  });

  registerType({
    id: 'packing', label: 'Who brings what', short: 'Packing', icon: '🎒', blurb: 'A packing list — each person claims what they’ll bring.', lists: true,
    clean: function (s, strict) {
      s = s || {};
      var items = cleanList(s.items, MAX_ITEMS, true);
      need(strict, items.length >= 1, 'Add at least one thing to bring');
      need(strict, !dupes(items), 'Two items are the same');
      return { q: str(s.q, MAX_Q) || 'Who brings what?', items: items };
    },
    fromNote: function (p) { return { q: p.title || '', items: itemsFromNote(p).map(function (t) { return qtyOf(t); }) }; },
    tally: function (s, data) { return resolveClaims(s, data); },
    summary: function (s, t) {
      var open = t.items.filter(function (x) { return x.left > 0; }).length;
      return 'Packing · ' + (open ? open + ' of ' + t.items.length + ' unclaimed' : 'all ' + t.items.length + ' covered');
    },
    markdown: function (s, t, ctx) {
      var L = ['**' + mdCell(s.q) + '**' + (ctx && ctx.closed ? ' (closed)' : ''), ''];
      t.items.forEach(function (x) {
        var who = x.claims.filter(function (c) { return c.got > 0; }).map(function (c) { return mdText(c.name) + (x.need > 1 ? ' (' + c.got + ')' : ''); });
        L.push('- [' + (x.left ? ' ' : 'x') + '] ' + mdText(x.t) + (x.need > 1 ? ' ×' + x.need : '') + ' — ' + (who.length ? who.join(', ') + (x.left ? ' · ' + x.left + ' still needed' : '') : 'unclaimed'));
      });
      return L.join('\n');
    }
  });

  registerType({
    id: 'list', label: 'Shopping list / checklist', short: 'List', icon: '🛒', blurb: 'A shared checklist — anyone can tick things off.', lists: true,
    clean: function (s, strict) {
      s = s || {};
      var items = cleanList(s.items, MAX_ITEMS);
      need(strict, items.length >= 1 || !!s.add, 'Add at least one item (or let them add items)');
      return { q: str(s.q, MAX_Q) || 'Shopping list', items: items, add: !!s.add };
    },
    fromNote: function (p) { return { q: p.title || '', items: itemsFromNote(p), add: true }; },
    tally: function (s, data) { return resolveTicks(s, data); },
    summary: function (s, t) { return 'List · ' + t.done + ' of ' + t.items.length + ' ticked'; },
    markdown: function (s, t, ctx) {
      var L = ['**' + mdCell(s.q) + '**' + (ctx && ctx.closed ? ' (closed)' : ''), ''];
      t.items.forEach(function (x) { L.push('- [' + (x.on ? 'x' : ' ') + '] ' + mdText(x.t) + (x.on ? ' — ' + mdText(x.by) : '') + (x.addedBy ? ' (added by ' + mdText(x.addedBy) + ')' : '')); });
      if (!t.items.length) L.push('- (empty)');
      return L.join('\n');
    }
  });

  function slotById(s, id) { for (var i = 0; i < s.slots.length; i++) if (s.slots[i].id === id) return s.slots[i]; return null; }
  function mdText(s) { return String(s == null ? '' : s).replace(/([\\`*_[\]<>|#])/g, '\\$1'); }
  function mdCell(s) { return mdText(s).replace(/\n/g, ' '); }

  // ---- claims and ticks -----------------------------------------------------------------------------------
  // Packing: each claim is { rid, item, q, at (server time), name }. Per item,
  // claims are served earliest first (ties: by rid) until the need is met —
  // so of two people claiming the last one at once, everyone computes the
  // same winner. A claim that got less than it asked for "lost" that part.
  function resolveClaims(s, data) {
    var by = {};
    s.items.forEach(function (x) { by[x.id] = []; });
    (data.items || []).forEach(function (c) { if (by[c.item] && c.v && c.v.q > 0) by[c.item].push({ rid: c.rid, name: c.label, q: intIn(c.v.q, 1, MAX_NEED, 1), at: c.at, me: !!c.me }); });
    var out = { items: [], open: 0, people: {} };
    s.items.forEach(function (x) {
      var list = by[x.id].sort(byAt), left = x.n || 1;
      list.forEach(function (c) { c.got = Math.min(c.q, left); left -= c.got; if (c.got) out.people[c.rid] = c.name; });
      if (left > 0) out.open++;
      out.items.push({ id: x.id, t: x.t, need: x.n || 1, left: left, claims: list });
    });
    return out;
  }
  // List: each tick is { rid, item, on, at, name }; an item shows the latest
  // one (anyone can tick or untick anything). Items people added come after
  // the owner's, oldest first.
  function resolveTicks(s, data) {
    var items = s.items.map(function (x) { return { id: x.id, t: x.t }; }), known = {};
    items.forEach(function (x) { known[x.id] = x; });
    if (s.add) (data.added || []).slice().sort(byAt).forEach(function (a) {
      if (known[a.k] || items.length >= s.items.length + MAX_ADDED || !a.v || !str(a.v.t, MAX_T)) return;
      var it = { id: a.k, t: str(a.v.t, MAX_T), addedBy: a.label, addedRid: a.rid, at: a.at };
      known[a.k] = it; items.push(it);
    });
    var latest = {};
    (data.items || []).forEach(function (c) {
      if (!known[c.item] || !c.v || typeof c.v.on !== 'boolean') return;
      var L = latest[c.item];
      if (!L || byAt(c, L) > 0) latest[c.item] = c;
    });
    var done = 0;
    items.forEach(function (x) { var L = latest[x.id]; x.on = !!(L && L.v.on); if (L) { x.by = L.label; x.byAt = L.at; x.byMe = !!L.me; } if (x.on) done++; });
    return { items: items, done: done };
  }

  // ---- hybrid encryption for hidden results ---------------------------------------------------------------
  var EC = { name: 'ECDH', namedCurve: 'P-256' };
  function pickJwk(j, priv) {
    if (!j || j.kty !== 'EC' || j.crv !== 'P-256' || typeof j.x !== 'string' || typeof j.y !== 'string') return null;
    var o = { kty: 'EC', crv: 'P-256', x: j.x, y: j.y };
    if (priv) { if (typeof j.d !== 'string') return null; o.d = j.d; }
    return o;
  }
  // → { pub, priv } as JWKs (priv stays on the owner's devices).
  function newOwnerKeys() {
    return crypto.subtle.generateKey(EC, true, ['deriveBits']).then(function (kp) {
      return Promise.all([crypto.subtle.exportKey('jwk', kp.publicKey), crypto.subtle.exportKey('jwk', kp.privateKey)]);
    }).then(function (j) { return { pub: pickJwk(j[0]), priv: pickJwk(j[1], true) }; });
  }
  function hkdf(bits, salt, id, rid, usage) {
    return crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']).then(function (k) {
      return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: utf8('cade-burn-hidden/' + id + '/' + rid) }, k, { name: 'AES-GCM', length: 256 }, false, [usage]);
    });
  }
  function hAad(id, rid) { return utf8('cade-burn/' + id + '/h/' + rid); }
  // Seals obj so that only the holder of pubJwk's private key can open it. → "h1.<b64u(eph pub 65 | iv 12 | ct)>"
  function hseal(pubJwk, id, rid, obj) {
    var pub = pickJwk(pubJwk);
    if (!pub) return Promise.reject(new Error('bad public key'));
    var eph, ephRaw, iv = rand(12);
    return Promise.all([crypto.subtle.generateKey(EC, true, ['deriveBits']), crypto.subtle.importKey('jwk', pub, EC, false, [])]).then(function (r) {
      eph = r[0];
      return Promise.all([crypto.subtle.deriveBits({ name: 'ECDH', public: r[1] }, eph.privateKey, 256), crypto.subtle.exportKey('raw', eph.publicKey)]);
    }).then(function (r) {
      ephRaw = new Uint8Array(r[1]);
      return hkdf(r[0], ephRaw, id, rid, 'encrypt');
    }).then(function (k) {
      return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: hAad(id, rid) }, k, utf8(JSON.stringify(obj)));
    }).then(function (ct) {
      var c = new Uint8Array(ct), out = new Uint8Array(65 + 12 + c.length);
      out.set(ephRaw, 0); out.set(iv, 65); out.set(c, 77);
      return 'h1.' + BC.b64u(out);
    });
  }
  // Rejects unless privJwk is the owner's key and id / rid match.
  function hopen(privJwk, id, rid, s) {
    return Promise.resolve().then(function () {
      var priv = pickJwk(privJwk, true);
      if (!priv || typeof s !== 'string' || s.slice(0, 3) !== 'h1.') throw new Error('bad hidden record');
      var b = BC.unb64u(s.slice(3));
      if (b.length < 65 + 12 + 17) throw new Error('bad hidden record');
      var ephRaw = b.subarray(0, 65), iv = b.subarray(65, 77), ct = b.subarray(77);
      return Promise.all([crypto.subtle.importKey('jwk', priv, EC, false, ['deriveBits']), crypto.subtle.importKey('raw', ephRaw, EC, false, [])]).then(function (k) {
        return crypto.subtle.deriveBits({ name: 'ECDH', public: k[1] }, k[0], 256);
      }).then(function (bits) { return hkdf(bits, ephRaw, id, rid, 'decrypt'); })
        .then(function (k) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv, additionalData: hAad(id, rid) }, k, ct); });
    }).then(function (pt) { return JSON.parse(unutf8(new Uint8Array(pt))); });
  }

  // ---- the sealed head's "respond" part -------------------------------------------------------------------
  // o: { type, spec, pub } → what goes into the head (throws a user-facing message)
  function makeRespond(o) {
    var T = typeOf(o && o.type);
    if (!T) throw new Error('Pick what they should do');
    var spec = T.clean(o.spec, true);
    var hidden = !!T.vis && spec.vis === 'hidden';
    if (hidden && !pickJwk(o.pub)) throw new Error('No key for hidden results');
    return { type: T.id, spec: spec, pub: hidden ? pickJwk(o.pub) : null };
  }
  // A head's "respond" part as read (anyone with the key could have written it, in principle) → or null
  function readRespond(h) {
    var r = h && h.respond;
    if (!r || typeof r !== 'object') return null;
    var T = typeOf(r.type);
    if (!T) return null;
    var spec;
    try { spec = T.clean(r.spec, false); } catch (e) { return null; }
    var hidden = !!T.vis && spec.vis === 'hidden';
    var pub = hidden ? pickJwk(r.pub) : null;
    if (hidden && !pub) return null;
    return { type: T.id, spec: spec, pub: pub, hidden: hidden };
  }
  function isHidden(R) { return !!(R && R.hidden); }

  // ---- writing a response ---------------------------------------------------------------------------------
  // What one browser writes for an answer type. → Promise<{ at: ts, ct } | { at: ts, h }>
  function sealAnswer(o) {   // o: { key, id, rid, R, name, anon, a, ts }
    var T = typeOf(o.R.type), a = T.answer(o.a, o.R.spec);
    if (!a) return Promise.reject(new Error('Nothing chosen'));
    var body = { name: o.anon ? '' : cleanPerson(o.name), anon: !!o.anon, a: a };
    if (o.R.hidden) return hseal(o.R.pub, o.id, o.rid, body).then(function (h) { return { at: o.ts, h: h }; });
    return BC.seal(o.key, o.id, 'r/' + o.rid, body).then(function (ct) { return { at: o.ts, ct: ct }; });
  }
  function sealName(key, id, rid, name) { return BC.seal(key, id, 'r/' + rid + '/n', { name: cleanPerson(name) }); }
  function sealItem(key, id, rid, item, v, ts) { return BC.seal(key, id, 'r/' + rid + '/i/' + item, v).then(function (ct) { return { at: ts, ct: ct }; }); }
  function sealAdded(key, id, rid, k, t, ts) { return BC.seal(key, id, 'r/' + rid + '/x/' + k, { t: str(t, MAX_T) }).then(function (ct) { return { at: ts, ct: ct }; }); }

  // ---- reading everyone's responses -----------------------------------------------------------------------
  // o: { key, id, R, resp (the resp node's value), priv (the owner's JWK, for hidden), me (this browser's rid),
  //      cache (an object kept between calls: ciphertext → plaintext) }
  // → Promise<{ answers: [{ rid, at, name, anon, label, a, me }], items: [...], added: [...], hidden (records
  //   nobody here can read), bad (records that didn't open), respondents }>
  function decodeAll(o) {
    var T = typeOf(o.R.type), spec = o.R.spec, cache = o.cache || {}, resp = o.resp && typeof o.resp === 'object' ? o.resp : {};
    var out = { answers: [], items: [], added: [], hidden: 0, bad: 0, respondents: 0 }, jobs = [];
    function dec(slot, s, fn) {
      var ck = slot + '|' + s;
      if (own(cache, ck)) return Promise.resolve(cache[ck]);
      return fn().then(function (v) { cache[ck] = v; return v; }, function () { cache[ck] = null; return null; });
    }
    function label(name, anon) { return anon ? 'Anonymous' : name || 'Someone'; }
    Object.keys(resp).sort().forEach(function (rid) {
      var r = resp[rid];
      if (!validRid(rid) || !r || typeof r !== 'object') return;
      out.respondents++;
      var at = +r.at || 0, me = rid === o.me;
      if (!T.lists) {
        if (typeof r.h === 'string') {
          if (!o.priv) { out.hidden++; return; }
          jobs.push(dec('h/' + rid, r.h, function () { return hopen(o.priv, o.id, rid, r.h); }).then(function (v) { push(v); }));
        } else if (typeof r.ct === 'string' && !o.R.hidden) {
          jobs.push(dec('r/' + rid, r.ct, function () { return BC.open(o.key, o.id, 'r/' + rid, r.ct); }).then(function (v) { push(v); }));
        } else out.bad++;
        return;
      }
      function push(v) {
        var a = v && T.answer(v.a, spec);
        if (!a) { out.bad++; return; }
        var name = cleanPerson(v.name), anon = !!v.anon;
        out.answers.push({ rid: rid, at: at, name: name, anon: anon, label: label(name, anon), a: a, me: me });
      }
      var nameP = typeof r.n === 'string' ? dec('r/' + rid + '/n', r.n, function () { return BC.open(o.key, o.id, 'r/' + rid + '/n', r.n); }) : Promise.resolve(null);
      jobs.push(nameP.then(function (nv) {
        var name = cleanPerson(nv && nv.name), lab = label(name, false), sub = [];
        var its = r.i && typeof r.i === 'object' ? r.i : {}, xs = r.x && typeof r.x === 'object' ? r.x : {};
        Object.keys(its).forEach(function (item) {
          var c = its[item];
          if (!validItemId(item) || !c || typeof c.ct !== 'string') return;
          sub.push(dec('r/' + rid + '/i/' + item, c.ct, function () { return BC.open(o.key, o.id, 'r/' + rid + '/i/' + item, c.ct); }).then(function (v) {
            if (v && typeof v === 'object') out.items.push({ rid: rid, item: item, at: +c.at || 0, v: v, name: name, label: lab, me: me });
            else out.bad++;
          }));
        });
        Object.keys(xs).forEach(function (k) {
          var c = xs[k];
          if (!validItemId(k) || !c || typeof c.ct !== 'string') return;
          sub.push(dec('r/' + rid + '/x/' + k, c.ct, function () { return BC.open(o.key, o.id, 'r/' + rid + '/x/' + k, c.ct); }).then(function (v) {
            if (v && typeof v === 'object') out.added.push({ rid: rid, k: k, at: +c.at || 0, v: v, name: name, label: lab, me: me });
            else out.bad++;
          }));
        });
        return Promise.all(sub);
      }));
    });
    return Promise.all(jobs).then(function () {
      out.answers.sort(byAt); out.items.sort(byAt); out.added.sort(byAt);
      return out;
    });
  }
  // The tally for this link. data: decodeAll's result (+ agg: a revealed aggregate, for hidden results).
  function tally(R, data) { return typeOf(R.type).tally(R.spec, data); }
  function summary(R, t, ctx) { return typeOf(R.type).summary(R.spec, t, ctx || {}); }
  // The owner's "reveal": counts only, no names.
  function aggregate(R, t) { var T = typeOf(R.type); return T.agg ? T.agg(R.spec, t) : null; }
  function sealReveal(key, id, agg, at) { return BC.seal(key, id, 'reveal', { at: at, agg: agg }); }
  function openReveal(key, id, s) { return BC.open(key, id, 'reveal', s).then(function (v) { return v && v.agg && typeof v.agg === 'object' ? v : null; }); }
  // A tidy Markdown block for the owner's note.
  function markdown(R, t, ctx) {
    var T = typeOf(R.type);
    var when = ctx && ctx.now ? ' · ' + fmtDate(new Date(ctx.now).toISOString().slice(0, 10), ctx.now) : '';
    return T.markdown(R.spec, t, ctx || {}) + '\n\n_' + T.short + ' results' + when + '_\n';
  }
  // Whether this browser may show results: live always; after: once it has
  // answered (or the owner closed it); hidden: only what the owner revealed.
  function canSee(R, answered, closed) {
    if (typeOf(R.type).lists) return true;
    var v = R.spec.vis;
    return v === 'live' || (v === 'after' && (answered || closed));
  }

  // Whether a response may still be sent (client-enforced): the link is
  // alive and the owner hasn't closed it. plain: { meta, tomb, closed }
  function accepting(plain, now) {
    return !!(plain && plain.meta && !plain.tomb && !BC.isExpired(plain.meta, now) && !plain.closed);
  }

  // "just now", "4 min ago", "2 h ago", "3 d ago"
  function fmtAgo(ms) {
    if (!(ms >= 0)) ms = 0;
    var m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.floor(h / 24) + ' d ago';
  }

  var api = {
    VIS: VIS, MAX_PERSON: MAX_PERSON, MAX_OPTS: MAX_OPTS, MAX_ITEMS: MAX_ITEMS, MAX_SLOTS: MAX_SLOTS, MAX_NEED: MAX_NEED, MAX_PLUS: MAX_PLUS, MAX_T: MAX_T, MAX_Q: MAX_Q, MAX_OTHER: MAX_OTHER,
    registerType: registerType, typeOf: typeOf, types: types,
    cleanPerson: cleanPerson, validRid: validRid, validItemId: validItemId, newRid: newRid, newItemId: newItemId,
    validDate: validDate, validTime: validTime, fmtDate: fmtDate, fmtTime: fmtTime, fmtSlot: fmtSlot, datesIn: datesIn, qtyOf: qtyOf,
    parseNote: parseNote, itemsFromNote: itemsFromNote,
    newOwnerKeys: newOwnerKeys, hseal: hseal, hopen: hopen, pickJwk: pickJwk,
    makeRespond: makeRespond, readRespond: readRespond, isHidden: isHidden,
    sealAnswer: sealAnswer, sealName: sealName, sealItem: sealItem, sealAdded: sealAdded,
    decodeAll: decodeAll, tally: tally, summary: summary, aggregate: aggregate, sealReveal: sealReveal, openReveal: openReveal,
    markdown: markdown, canSee: canSee, accepting: accepting, resolveClaims: resolveClaims, resolveTicks: resolveTicks, fmtAgo: fmtAgo, mdText: mdText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.__cadeBurnRespondCore = api;
})(typeof window !== 'undefined' ? window : null);
