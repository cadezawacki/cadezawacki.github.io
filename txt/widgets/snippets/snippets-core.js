/* Snippets — shared core, loaded on demand by BOTH the Snippets widget
 * (widgets/snippets/snippets.js) and the "Snippet abbreviations" editor plugin
 * (plugins/snippet-expand/). Nothing here runs until one of them needs it.
 *
 *  1. Pure model (DOM-free, unit-tested by snippets.test.js): normalising the
 *     synced blob, placeholder parsing + expansion, date formats, fuzzy
 *     search / list order, usage stats, import / export (JSON + markdown).
 *  2. Runtime (browser only, exposed as window.__cadeSnippets): the synced
 *     store, per-device usage + remembered field values, inserting a snippet
 *     into the editor as ONE transaction, and the small fill-in form for
 *     {{input:…}} fields.
 *
 * Storage: Cade.syncedBlob('snippets') holds { v, snippets:[{id, name, abbr,
 * body, folder, fav, created, updated}], opts:{trigger, space, fences} } —
 * whole-blob last-write-wins across devices, so it is normalised defensively
 * on every read and capped well under the core's 256 KB limit. Usage stats
 * (use count + last use) and the last value typed into each fill-in field stay
 * on this device (Cade.store), so expanding a snippet never rewrites or pushes
 * the synced library. Until the library is first edited the starter snippets
 * are virtual (nothing is written), so a fresh device can never overwrite the
 * account's synced snippets with a default set. */
(function () {
  'use strict';

  // ===========================================================================
  // 1. Pure model — no DOM, no Cade.
  // ===========================================================================
  var P = (function () {
    var MAX_SNIPPETS = 500, MAX_BODY = 20000, MAX_NAME = 120, MAX_ABBR = 32, MAX_FOLDER = 40;
    var MAX_JSON = 180000; // raw JSON budget: the encrypted copy must stay below the core's 256 KB cap
    var MAX_USAGE = 300;
    var DEFAULT_OPTS = { trigger: ';', space: true, fences: false };
    var CUR = '\ue000', NBR = '\ue001'; // private-use markers: caret, "don't indent this newline"

    var STARTERS = [
      { id: 'starter-mtg', name: 'Meeting notes', abbr: ';mtg', folder: 'Templates', body:
        '## {{input:Meeting}} — {{date:ddd, MMM D, YYYY}}\n\n**Attendees:** {{cursor}}\n\n**Agenda**\n- \n\n**Notes**\n- \n\n**Decisions**\n- \n\n**Action items**\n- [ ] ' },
      { id: 'starter-jrnl', name: 'Daily journal', abbr: ';jrnl', folder: 'Templates', body:
        '# {{date:dddd, MMMM D, YYYY}}\n\n**Grateful for**\n1. {{cursor}}\n2. \n3. \n\n**Top 3 today**\n- [ ] \n- [ ] \n- [ ] \n\n**Notes**\n\n\n**Wins & lessons**\n- ' },
      { id: 'starter-week', name: 'Weekly review', abbr: ';week', folder: 'Templates', body:
        '## Week {{date:W}} review — {{date:MMM D, YYYY}}\n\n**Done**\n- {{cursor}}\n\n**Still open**\n- [ ] \n\n**Next week’s focus**\n1. \n2. \n3. \n\n**What got in the way**\n- ' },
      { id: 'starter-bug', name: 'Bug report', abbr: ';bug', folder: 'Templates', body:
        '### Bug: {{input:Summary}}\n\n**Severity:** {{input:Severity=Medium|High|Critical|Low}}\n**Found:** {{date}} {{time}}\n**Where:** {{input:Device / browser}}\n\n**Steps to reproduce**\n1. {{cursor}}\n2. \n3. \n\n**Expected**\n\n\n**Actual**\n\n\n**Notes / logs**\n' },
      { id: 'starter-ty', name: 'Email — thank you', abbr: ';ty', folder: 'Email', body:
        'Hi {{input:Name}},\n\nThank you for {{cursor}}. I really appreciate it.\n\nBest,\n{{input:Your name}}' },
      { id: 'starter-fu', name: 'Email — follow-up', abbr: ';fu', folder: 'Email', body:
        'Hi {{input:Name}},\n\nI wanted to follow up on {{input:Topic}}. {{cursor}}\n\nCould you let me know where things stand when you get a chance?\n\nThanks,\n{{input:Your name}}' },
      { id: 'starter-no', name: 'Email — polite decline', abbr: ';no', folder: 'Email', body:
        'Hi {{input:Name}},\n\nThank you for thinking of me. Unfortunately I won’t be able to {{input:Request}} right now{{cursor}}.\n\nI hope it goes well — please keep me in mind for the future.\n\nBest,\n{{input:Your name}}' },
      { id: 'starter-sig', name: 'Signature', abbr: ';sig', folder: 'Email', body:
        'Best regards,\n{{input:Your name}}' },
      { id: 'starter-ts', name: 'Timestamp', abbr: ';ts', folder: 'Quick', body: '{{date}} {{time}}' },
      { id: 'starter-today', name: 'Today (long date)', abbr: ';today', folder: 'Quick', body: '{{date:dddd, MMMM D, YYYY}}' },
      { id: 'starter-link', name: 'Link from clipboard', abbr: ';link', folder: 'Quick', body: '[{{selection}}{{cursor}}]({{clipboard}})' },
    ];

    function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
    function clone(v) { return JSON.parse(JSON.stringify(v)); }
    function str(v, max) {
      if (v == null) return '';
      if (typeof v !== 'string') v = typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
      v = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim();
      return v.length > max ? v.slice(0, max).trim() : v;
    }
    function num(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0; }
    function firstLine(body) {
      var lines = String(body || '').split('\n');
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i].replace(/^[\s#>*\-+]+|\{\{[^}]*\}\}/g, '').replace(/[*_`~]/g, '').trim();
        if (t) return t.length > 60 ? t.slice(0, 57).trim() + '…' : t;
      }
      return '';
    }
    // A trigger is one visible non-alphanumeric character that can't start a placeholder.
    function validTrigger(t) {
      return typeof t === 'string' && t.length === 1 && !/[\sA-Za-z0-9{}\\\u0080-\uffff]/.test(t);
    }
    function normOpts(o) {
      var out = { trigger: DEFAULT_OPTS.trigger, space: DEFAULT_OPTS.space, fences: DEFAULT_OPTS.fences };
      if (isObj(o)) {
        if (validTrigger(o.trigger)) out.trigger = o.trigger;
        if (typeof o.space === 'boolean') out.space = o.space;
        if (typeof o.fences === 'boolean') out.fences = o.fences;
      }
      return out;
    }
    // Stored abbreviations: no whitespace, capped. (The trigger prefix is enforced
    // when saving from the editor — another device may use another trigger.)
    function storedAbbr(a) {
      if (typeof a !== 'string') return '';
      a = a.replace(/\s+/g, '');
      return a.length > MAX_ABBR ? '' : a;
    }
    var idSeq = 0;
    function newId(taken) {
      var id;
      do { id = 's' + Date.now().toString(36) + (idSeq++).toString(36) + Math.floor(Math.random() * 1296).toString(36); }
      while (taken && taken[id]);
      return id;
    }
    var KNOWN = { id: 1, name: 1, abbr: 1, body: 1, folder: 1, fav: 1, created: 1, updated: 1 };
    // Unknown small fields written by a newer version survive a round trip here.
    function keepExtra(src, dst, known) {
      for (var k in src) {
        if (!Object.prototype.hasOwnProperty.call(src, k) || known[k] || dst[k] !== undefined) continue;
        var v = src[k];
        if (typeof v === 'boolean' || (typeof v === 'number' && isFinite(v)) || (typeof v === 'string' && v.length <= 2000)) dst[k] = v;
      }
    }

    // Defensive normalisation of whatever the blob holds (null, partial, from
    // older/newer code). Returns null when there is no library yet.
    function normalize(raw) {
      if (!isObj(raw) || !Array.isArray(raw.snippets)) return null;
      var out = { v: 1, snippets: [], opts: normOpts(raw.opts) };
      keepExtra(raw, out, { v: 1, snippets: 1, opts: 1, virtual: 1 });
      var ids = {}, abbrs = {};
      for (var i = 0; i < raw.snippets.length && out.snippets.length < MAX_SNIPPETS; i++) {
        var s = raw.snippets[i];
        if (!isObj(s)) continue;
        var body = typeof s.body === 'string' ? s.body : (typeof s.body === 'number' ? String(s.body) : '');
        body = body.replace(/\r\n?/g, '\n');
        if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);
        var name = str(s.name, MAX_NAME) || firstLine(body) || 'Untitled';
        if (!body && !str(s.name, MAX_NAME)) continue; // nothing at all
        var abbr = storedAbbr(s.abbr);
        if (abbr) { var k = abbr.toLowerCase(); if (abbrs[k]) abbr = ''; else abbrs[k] = 1; }
        var id = typeof s.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s.id) && !ids[s.id] ? s.id : newId(ids);
        ids[id] = 1;
        var o = { id: id, name: name, abbr: abbr, body: body, folder: str(s.folder, MAX_FOLDER), fav: s.fav === true, created: num(s.created), updated: num(s.updated) };
        keepExtra(s, o, KNOWN);
        out.snippets.push(o);
      }
      return out;
    }
    // The library before it is first saved: the starters, nothing stored.
    function virtualState() {
      return { v: 1, snippets: clone(STARTERS).map(function (s) { s.fav = false; s.created = 0; s.updated = 0; return s; }), opts: normOpts(null), virtual: true };
    }
    function toStored(st) {
      var o = clone(st);
      delete o.virtual;
      o.v = 1;
      return o;
    }
    // UTF-8 bytes of the stored JSON (accents, emoji, CJK take 2-4 bytes each)
    function utf8Len(str) {
      if (typeof TextEncoder === 'function') return new TextEncoder().encode(str).length;
      var n = 0;
      for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c < 0xdc00) ? (i++, 4) : 3; }
      return n;
    }
    function storedSize(st) { return utf8Len(JSON.stringify(toStored(st))); }
    function tooBig(st) { return storedSize(st) > MAX_JSON; }

    // ---- abbreviations -----------------------------------------------------
    // Editor input → stored form: whitespace removed, the trigger added when the
    // user typed a bare word ("sig" → ";sig").
    function cleanAbbr(a, trigger) {
      a = String(a || '').replace(/\s+/g, '');
      if (!a) return '';
      if (/^[A-Za-z0-9À-\uffff]/.test(a)) a = trigger + a;
      return a;
    }
    // '' when fine, else a message for the editor.
    function abbrError(a, trigger, list, selfId) {
      if (!a) return '';
      if (a.charAt(0) !== trigger) return 'Abbreviations start with “' + trigger + '” (the trigger character)';
      if (a.length < 2) return 'Add a word after “' + trigger + '”';
      if (a.length > MAX_ABBR) return 'Keep abbreviations under ' + MAX_ABBR + ' characters';
      if (a.indexOf(trigger, 1) >= 0) return 'Use “' + trigger + '” only at the start';
      if (/[{}]/.test(a)) return 'Braces can’t be used in abbreviations';
      var lo = a.toLowerCase();
      for (var i = 0; i < (list || []).length; i++) {
        var s = list[i];
        if (s.id !== selfId && s.abbr && s.abbr.toLowerCase() === lo) return '“' + s.abbr + '” is already used by “' + s.name + '”';
      }
      return '';
    }
    // abbr (lowercase) → snippet
    function abbrIndex(st) {
      var idx = {};
      for (var i = 0; i < st.snippets.length; i++) { var s = st.snippets[i]; if (s.abbr) idx[s.abbr.toLowerCase()] = s; }
      return idx;
    }
    // Exact abbreviation, else (allowPrefix) the ONE abbreviation it is a prefix of.
    function findAbbr(idx, word, allowPrefix) {
      var k = String(word || '').toLowerCase();
      if (!k) return null;
      if (Object.prototype.hasOwnProperty.call(idx, k)) return idx[k];
      if (!allowPrefix || k.length < 2) return null;
      var hit = null;
      for (var a in idx) {
        if (Object.prototype.hasOwnProperty.call(idx, a) && a.indexOf(k) === 0) { if (hit) return null; hit = idx[a]; }
      }
      return hit;
    }

    // ---- dates -------------------------------------------------------------
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
    function ordinal(n) {
      var t = n % 100;
      if (t >= 11 && t <= 13) return n + 'th';
      return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
    }
    function isoWeek(d) {
      var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7)); // the week's Thursday
      var jan4 = new Date(t.getFullYear(), 0, 4);
      return 1 + Math.round(((t - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
    }
    var FMT_RE = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A|a|Q|WW|W/g;
    function formatDate(d, fmt) {
      return String(fmt).replace(FMT_RE, function (tok, lit) {
        if (lit !== undefined) return lit;
        var h = d.getHours();
        switch (tok) {
          case 'YYYY': return String(d.getFullYear());
          case 'YY': return pad(d.getFullYear() % 100);
          case 'MMMM': return MONTHS[d.getMonth()];
          case 'MMM': return MONTHS[d.getMonth()].slice(0, 3);
          case 'MM': return pad(d.getMonth() + 1);
          case 'M': return String(d.getMonth() + 1);
          case 'Do': return ordinal(d.getDate());
          case 'DD': return pad(d.getDate());
          case 'D': return String(d.getDate());
          case 'dddd': return DAYS[d.getDay()];
          case 'ddd': return DAYS[d.getDay()].slice(0, 3);
          case 'HH': return pad(h);
          case 'H': return String(h);
          case 'hh': return pad(h % 12 || 12);
          case 'h': return String(h % 12 || 12);
          case 'mm': return pad(d.getMinutes());
          case 'ss': return pad(d.getSeconds());
          case 'A': return h < 12 ? 'AM' : 'PM';
          case 'a': return h < 12 ? 'am' : 'pm';
          case 'Q': return String(Math.floor(d.getMonth() / 3) + 1);
          case 'WW': return pad(isoWeek(d));
          case 'W': return String(isoWeek(d));
        }
        return tok;
      });
    }
    function addMonths(d, n) {
      var r = new Date(d.getTime()), day = r.getDate();
      r.setDate(1);
      r.setMonth(r.getMonth() + n);
      var last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
      r.setDate(Math.min(day, last));
      return r;
    }
    function shiftDate(d, n, unit) {
      if (!n) return d;
      var r = new Date(d.getTime());
      if (unit === 'h') { r.setHours(r.getHours() + n); return r; }
      if (unit === 'w') { r.setDate(r.getDate() + 7 * n); return r; }
      if (unit === 'm') return addMonths(r, n);
      if (unit === 'y') return addMonths(r, 12 * n);
      r.setDate(r.getDate() + n);
      return r;
    }

    // ---- placeholders --------------------------------------------------------
    var DATE_NAMES = { date: 'date', today: 'date', tomorrow: 'date', yesterday: 'date', time: 'time', now: 'now', weekday: 'weekday', day: 'weekday' };
    // Inner text of {{…}} → descriptor, or null (= leave it as literal text, so
    // e.g. Handlebars / Vue templates inside a code snippet stay untouched).
    function parsePh(inner) {
      var m = /^\s*([A-Za-z]+)\s*(?:([+-])\s*(\d{1,4})\s*([dwmyh])?)?\s*(?::([\s\S]*))?$/.exec(inner);
      if (!m) return null;
      var name = m[1].toLowerCase(), arg = m[5];
      if (name === 'input' || name === 'field' || name === 'ask') {
        if (m[2] || arg == null) return null;
        var eq = arg.indexOf('=');
        var label = (eq >= 0 ? arg.slice(0, eq) : arg).replace(/\s+/g, ' ').trim();
        if (!label || label.length > 60) return null;
        var def = eq >= 0 ? arg.slice(eq + 1).trim() : '';
        var choices = null;
        if (def.indexOf('|') >= 0) {
          choices = def.split('|').map(function (c) { return c.trim(); }).filter(Boolean);
          if (choices.length < 2) choices = null;
          def = choices ? choices[0] : def.replace(/\|/g, '').trim();
        }
        return { type: 'input', key: label.toLowerCase(), label: label, def: def, choices: choices };
      }
      if (name === 'clipboard' || name === 'selection' || name === 'cursor') {
        if (m[2] || arg != null) return null;
        return { type: name };
      }
      var kind = DATE_NAMES[name];
      if (!kind) return null;
      var n = m[2] ? parseInt(m[3], 10) * (m[2] === '-' ? -1 : 1) : 0;
      var unit = m[4] || (kind === 'time' && m[2] ? 'h' : 'd');
      if (name === 'tomorrow' || name === 'yesterday') { // tomorrow+2 = date+3
        if (unit !== 'd') return null;
        n += name === 'tomorrow' ? 1 : -1;
      }
      var fmt = arg != null ? arg : null;
      if (fmt !== null && !fmt.trim()) fmt = null;
      return { type: 'date', kind: kind, n: n, unit: unit, fmt: fmt };
    }
    // Body → [{t:'text', v} | {t:'ph', ph, raw}]. "\{{" writes a literal "{{".
    function tokenize(body) {
      var out = [], s = String(body || ''), i = 0, buf = '';
      while (i < s.length) {
        var o = s.indexOf('{{', i);
        if (o < 0) { buf += s.slice(i); break; }
        if (o > 0 && s.charAt(o - 1) === '\\') { buf += s.slice(i, o - 1) + '{{'; i = o + 2; continue; }
        var c = s.indexOf('}}', o + 2);
        var inner = c >= 0 ? s.slice(o + 2, c) : '';
        var ph = c >= 0 && c - o <= 200 && inner.indexOf('\n') < 0 && inner.indexOf('{{') < 0 ? parsePh(inner) : null;
        if (!ph) { buf += s.slice(i, o + 2); i = o + 2; continue; }
        buf += s.slice(i, o);
        if (buf) { out.push({ t: 'text', v: buf }); buf = ''; }
        out.push({ t: 'ph', ph: ph, raw: s.slice(o, c + 2) });
        i = c + 2;
      }
      if (buf) out.push({ t: 'text', v: buf });
      return out;
    }
    // What a body needs before it can be inserted.
    function scan(body) {
      var toks = tokenize(body), fields = [], seen = {}, info = { fields: fields, clipboard: false, selection: false, cursor: false, oneLine: true };
      for (var i = 0; i < toks.length; i++) {
        var t = toks[i];
        if (t.t === 'text') { if (t.v.indexOf('\n') >= 0) info.oneLine = false; continue; }
        var ph = t.ph;
        if (ph.type === 'input') {
          if (!seen[ph.key]) { seen[ph.key] = { key: ph.key, label: ph.label, def: ph.def, choices: ph.choices }; fields.push(seen[ph.key]); }
          else { var f = seen[ph.key]; if (!f.def && ph.def) f.def = ph.def; if (!f.choices && ph.choices) f.choices = ph.choices; }
        } else if (ph.type === 'clipboard') info.clipboard = true;
        else if (ph.type === 'selection') info.selection = true;
        else if (ph.type === 'cursor') info.cursor = true;
      }
      return info;
    }
    function clean(v) { return String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\ue000\ue001]/g, ''); }
    // Expand a body. env: { now: Date, hour12: bool, clipboard: string|null,
    // selection: string, values: {fieldKey: value}, indent: string }.
    // → { text, cursor } (cursor = offset of {{cursor}}, or -1).
    // Every line after the first gets `indent` (the insertion line's own
    // indentation) unless it is empty; text that came from the selection keeps
    // its own layout.
    function expand(body, env) {
      env = env || {};
      var now = env.now instanceof Date ? env.now : new Date();
      var values = env.values || {}, toks = tokenize(body), out = '', placed = false;
      var tfmt = env.hour12 === false ? 'HH:mm' : 'h:mm A';
      for (var i = 0; i < toks.length; i++) {
        var t = toks[i];
        if (t.t === 'text') { out += clean(t.v); continue; }
        var ph = t.ph;
        if (ph.type === 'date') {
          var d = shiftDate(now, ph.n, ph.unit);
          var fmt = ph.fmt || (ph.kind === 'time' ? tfmt : ph.kind === 'now' ? 'YYYY-MM-DD ' + tfmt : ph.kind === 'weekday' ? 'dddd' : 'YYYY-MM-DD');
          out += clean(formatDate(d, fmt));
        } else if (ph.type === 'clipboard') out += clean(env.clipboard);
        else if (ph.type === 'selection') out += clean(env.selection).replace(/\n/g, NBR);
        else if (ph.type === 'cursor') { if (!placed) { out += CUR; placed = true; } }
        else if (ph.type === 'input') {
          var v = Object.prototype.hasOwnProperty.call(values, ph.key) ? values[ph.key] : ph.def;
          out += clean(v);
        }
      }
      var indent = env.indent || '';
      if (indent && out.indexOf('\n') >= 0) {
        var lines = out.split('\n');
        for (var j = 1; j < lines.length; j++) if (lines[j]) lines[j] = indent + lines[j];
        out = lines.join('\n');
      }
      out = out.split(NBR).join('\n');
      var c = out.indexOf(CUR);
      if (c >= 0) out = out.slice(0, c) + out.slice(c + 1);
      return { text: out, cursor: c };
    }
    // Indentation that carries onto the inserted lines: the line's leading
    // whitespace, but no more than the insertion column.
    function indentAt(lineText, col) {
      var ind = /^[ \t]*/.exec(lineText)[0];
      return col < ind.length ? ind.slice(0, col) : ind;
    }
    // Strip the common leading indentation of a captured selection.
    function dedent(text) {
      var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n'), min = null;
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        var w = /^[ \t]*/.exec(lines[i])[0].length;
        if (min === null || w < min) min = w;
      }
      if (!min) return lines.join('\n');
      return lines.map(function (l) { return l.trim() ? l.slice(min) : l.replace(/^[ \t]+/, ''); }).join('\n');
    }

    // ---- usage (per device) -------------------------------------------------
    // { id: [count, lastUseSeconds] }, capped.
    function normUsage(u) {
      var out = {};
      if (!isObj(u)) return out;
      for (var k in u) {
        if (!Object.prototype.hasOwnProperty.call(u, k) || !/^[A-Za-z0-9_-]{1,40}$/.test(k)) continue;
        var v = u[k];
        if (Array.isArray(v) && v.length >= 2) out[k] = [num(v[0]), num(v[1])];
      }
      return out;
    }
    function bumpUsage(u, id, nowMs) {
      var out = normUsage(u), cur = out[id] || [0, 0];
      out[id] = [Math.min(cur[0] + 1, 999999), Math.floor((nowMs || Date.now()) / 1000)];
      var keys = Object.keys(out);
      if (keys.length > MAX_USAGE) {
        keys.sort(function (a, b) { return out[a][1] - out[b][1]; });
        for (var i = 0; i < keys.length - MAX_USAGE; i++) delete out[keys[i]];
      }
      return out;
    }
    function lastUse(u, id) { return u && u[id] ? u[id][1] : 0; }
    function useCount(u, id) { return u && u[id] ? u[id][0] : 0; }

    // ---- search + ordering ---------------------------------------------------
    function lc(s) { return String(s || '').toLowerCase(); }
    function byName(a, b) {
      var x = lc(a.name), y = lc(b.name);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    function subseq(q, s) {
      var qi = 0;
      for (var i = 0; i < s.length && qi < q.length; i++) if (s.charCodeAt(i) === q.charCodeAt(qi)) qi++;
      return qi === q.length;
    }
    function wordStart(s, q) {
      var re = /[^a-z0-9À-\uffff]+/g, m;
      while ((m = re.exec(s))) if (s.indexOf(q, m.index + m[0].length) === m.index + m[0].length) return true;
      return false;
    }
    function tokScore(s, t) {
      var name = lc(s.name), abbr = lc(s.abbr), bare = abbr.replace(/^[^a-z0-9À-\uffff]/, '');
      if (abbr && (abbr === t || bare === t)) return 1000;
      if (name === t) return 900;
      if (name.indexOf(t) === 0) return 700;
      if (abbr && (abbr.indexOf(t) === 0 || (bare && bare.indexOf(t) === 0))) return 650;
      if (wordStart(name, t)) return 600;
      if (name.indexOf(t) > 0) return 450;
      if (s.folder && lc(s.folder).indexOf(t) >= 0) return 350;
      if (lc(s.body).indexOf(t) >= 0) return 250;
      if (t.length >= 2 && subseq(t, name)) return 150;
      return 0;
    }
    // Fuzzy search over name / abbreviation / folder / body. Every word of the
    // query must match somewhere; favourites and often-used snippets break ties.
    function search(list, query, usage) {
      var q = lc(query).trim();
      if (!q) return list.slice();
      var toks = q.split(/\s+/), out = [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i], total = 0;
        for (var j = 0; j < toks.length; j++) {
          var sc = tokScore(s, toks[j]);
          if (!sc) { total = 0; break; }
          total += sc;
        }
        if (total) out.push({ s: s, sc: total + (s.fav ? 40 : 0) + Math.min(30, useCount(usage, s.id) * 3) });
      }
      out.sort(function (a, b) { return b.sc - a.sc || lastUse(usage, b.s.id) - lastUse(usage, a.s.id) || byName(a.s, b.s); });
      return out.map(function (r) { return r.s; });
    }
    // No query: favourites (most recently used first), then up to `recentMax`
    // recently used, then everything else A–Z.
    function ordered(list, usage, recentMax) {
      var favs = [], recent = [], rest = [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (s.fav) favs.push(s);
        else if (lastUse(usage, s.id)) recent.push(s);
        else rest.push(s);
      }
      var byRecent = function (a, b) { return lastUse(usage, b.id) - lastUse(usage, a.id) || byName(a, b); };
      favs.sort(byRecent);
      recent.sort(byRecent);
      var max = recentMax == null ? 5 : recentMax;
      if (recent.length > max) rest = rest.concat(recent.splice(max));
      rest.sort(byName);
      return { favs: favs, recent: recent, rest: rest };
    }
    function folders(list) {
      var seen = {}, out = [];
      for (var i = 0; i < list.length; i++) {
        var f = list[i].folder;
        if (f && !seen[f.toLowerCase()]) { seen[f.toLowerCase()] = 1; out.push(f); }
      }
      return out.sort(function (a, b) { return lc(a) < lc(b) ? -1 : lc(a) > lc(b) ? 1 : 0; });
    }

    // ---- import / export -------------------------------------------------------
    function exportable(s) {
      var o = { name: s.name, body: s.body };
      if (s.abbr) o.abbr = s.abbr;
      if (s.folder) o.folder = s.folder;
      if (s.fav) o.fav = true;
      return o;
    }
    function exportJSON(st) {
      return JSON.stringify({ type: 'cade-snippets', version: 1, snippets: st.snippets.map(exportable) }, null, 2);
    }
    function fenceFor(body) {
      var max = 2, re = /`{3,}/g, m;
      while ((m = re.exec(body))) if (m[0].length > max) max = m[0].length;
      return new Array(max + 2).join('`');
    }
    // A markdown list: "- **Name** `;abbr` — Folder ★" with the body in an
    // indented code fence under it (round-trips through parseMarkdown).
    function exportMarkdown(st) {
      var out = [];
      for (var i = 0; i < st.snippets.length; i++) {
        var s = st.snippets[i], f = fenceFor(s.body);
        var head = '- **' + s.name.replace(/([\\*`])/g, '\\$1') + '**' + (s.abbr ? ' `' + s.abbr + '`' : '') + (s.folder ? ' — ' + s.folder : '') + (s.fav ? ' ★' : '');
        out.push(head, '    ' + f);
        var lines = s.body.split('\n');
        for (var j = 0; j < lines.length; j++) out.push(lines[j] ? '    ' + lines[j] : '');
        out.push('    ' + f);
      }
      return out.join('\n') + '\n';
    }
    function parseHead(h) {
      var o = { name: '', abbr: '', folder: '', fav: false, rest: '' };
      h = h.trim();
      if (/\s*★$/.test(h)) { o.fav = true; h = h.replace(/\s*★$/, ''); }
      var m = /^\*\*((?:\\[\s\S]|[^\\*])+)\*\*\s*(.*)$/.exec(h);
      var name = m ? m[1].replace(/\\([\s\S])/g, '$1') : '', tail = m ? m[2] : h;
      var am = /`([^`\s]+)`/.exec(tail);
      if (am) { o.abbr = am[1]; tail = tail.slice(0, am.index) + tail.slice(am.index + am[0].length); }
      var fm = /^\s*—\s+(.+)$/.exec(tail);
      if (fm && m) { o.folder = fm[1].trim(); tail = ''; }
      tail = tail.trim();
      if (!m) {
        var c = tail.indexOf(': ');
        if (c > 0) { name = tail.slice(0, c).trim(); o.rest = tail.slice(c + 2).trim(); }
        else { o.rest = tail; }
      } else if (tail) {
        o.rest = tail.replace(/^:\s*/, '');
      }
      o.name = (m ? name : name.replace(/\*\*/g, '')).trim();
      return o;
    }
    function parseMarkdown(text) {
      var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n'), out = [], i = 0;
      while (i < lines.length) {
        var m = /^[-*+][ \t]+(.+)$/.exec(lines[i]);
        if (!m) { i++; continue; }
        var h = parseHead(m[1]), body = null;
        i++;
        var j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        var fm = j < lines.length ? /^([ \t]+)(`{3,}|~{3,})[^`]*$/.exec(lines[j]) : null;
        if (fm) {
          var ind = fm[1], fence = fm[2], buf = [], k = j + 1, closed = false;
          for (; k < lines.length; k++) {
            var l = lines[k];
            if (l.slice(0, ind.length) === ind && l.slice(ind.length).replace(/\s+$/, '') === fence) { closed = true; break; }
            buf.push(l.slice(0, ind.length) === ind ? l.slice(ind.length) : l.replace(/^[ \t]+/, ''));
          }
          if (closed) { body = buf.join('\n'); i = k + 1; }
        }
        if (body === null) body = h.rest || (h.abbr ? '' : h.name);
        if (!body && !h.name) continue;
        out.push({ name: h.name || firstLine(body), abbr: h.abbr, folder: h.folder, fav: h.fav, body: body });
      }
      return out;
    }
    // JSON (this export, a bare array, {snippets:[…]}, or an {abbr: text} map)
    // or a markdown list → [{name, abbr, folder, fav, body}].
    function parseImport(text) {
      var t = String(text || '').trim();
      if (!t) return { format: '', snippets: [] };
      if (/^[[{]/.test(t)) {
        var j;
        try { j = JSON.parse(t); } catch (e) { return { format: 'json', snippets: [], error: 'That isn’t valid JSON (' + e.message.replace(/^JSON\.parse: /, '') + ')' }; }
        var arr = Array.isArray(j) ? j : isObj(j) && Array.isArray(j.snippets) ? j.snippets : null;
        if (!arr && isObj(j)) {
          arr = [];
          for (var k in j) if (Object.prototype.hasOwnProperty.call(j, k) && typeof j[k] === 'string') arr.push({ abbr: /^\S{1,32}$/.test(k) && !/^[A-Za-z0-9]/.test(k) ? k : '', name: k, body: j[k] });
        }
        if (!arr) return { format: 'json', snippets: [], error: 'No snippets found in that JSON' };
        var norm = normalize({ snippets: arr.map(function (s) { return isObj(s) ? { name: s.name || s.title, abbr: s.abbr || s.abbreviation || s.trigger, body: s.body != null ? s.body : (s.text != null ? s.text : s.content), folder: s.folder || s.tag || s.group, fav: s.fav === true || s.favorite === true || s.favourite === true } : null; }) });
        return { format: 'json', snippets: norm ? norm.snippets.map(exportable) : [] };
      }
      return { format: 'markdown', snippets: parseMarkdown(t) };
    }
    // Merge imported snippets into a library: identical (name + body) ones are
    // skipped, an abbreviation already in use is dropped from the newcomer.
    function mergeImport(st, incoming, nowMs) {
      var next = clone(st), added = 0, skipped = 0, conflicts = 0;
      delete next.virtual;
      var ids = {}, abbrs = {}, sig = {};
      next.snippets.forEach(function (s) { ids[s.id] = 1; if (s.abbr) abbrs[s.abbr.toLowerCase()] = 1; sig[lc(s.name) + '\u0000' + s.body] = 1; });
      for (var i = 0; i < incoming.length; i++) {
        var n = normalize({ snippets: [incoming[i]] });
        if (!n || !n.snippets.length) continue;
        var s = n.snippets[0], key = lc(s.name) + '\u0000' + s.body;
        if (sig[key]) { skipped++; continue; }
        if (next.snippets.length >= MAX_SNIPPETS) { skipped++; continue; }
        if (s.abbr && abbrs[s.abbr.toLowerCase()]) { s.abbr = ''; conflicts++; }
        s.id = newId(ids); ids[s.id] = 1;
        s.created = s.updated = nowMs || Date.now();
        if (s.abbr) abbrs[s.abbr.toLowerCase()] = 1;
        sig[key] = 1;
        next.snippets.push(s);
        added++;
      }
      return { state: next, added: added, skipped: skipped, conflicts: conflicts };
    }
    // Put back starters the user deleted (abbreviations already taken are dropped).
    function restoreStarters(st, nowMs) {
      var next = clone(st), have = {}, abbrs = {}, n = 0;
      delete next.virtual;
      next.snippets.forEach(function (s) { have[s.id] = 1; if (s.abbr) abbrs[s.abbr.toLowerCase()] = 1; });
      STARTERS.forEach(function (s) {
        if (have[s.id]) return;
        var c = clone(s);
        c.fav = false; c.created = c.updated = nowMs || Date.now();
        if (abbrs[c.abbr.toLowerCase()]) c.abbr = '';
        next.snippets.push(c);
        n++;
      });
      return { state: next, added: n };
    }
    // Switch every abbreviation from one trigger to another (;sig → !sig).
    function retrigger(st, from, to) {
      var next = clone(st);
      next.snippets.forEach(function (s) { if (s.abbr && s.abbr.charAt(0) === from && s.abbr.indexOf(to) < 0) s.abbr = to + s.abbr.slice(1); });
      next.opts.trigger = to;
      return normalize(toStored(next));
    }

    return {
      MAX_SNIPPETS: MAX_SNIPPETS, MAX_BODY: MAX_BODY, MAX_JSON: MAX_JSON, MAX_ABBR: MAX_ABBR, DEFAULT_OPTS: DEFAULT_OPTS, STARTERS: STARTERS,
      clone: clone, newId: newId, firstLine: firstLine, validTrigger: validTrigger, normOpts: normOpts,
      normalize: normalize, virtualState: virtualState, toStored: toStored, storedSize: storedSize, tooBig: tooBig,
      cleanAbbr: cleanAbbr, abbrError: abbrError, abbrIndex: abbrIndex, findAbbr: findAbbr,
      formatDate: formatDate, shiftDate: shiftDate, isoWeek: isoWeek, parsePh: parsePh, tokenize: tokenize, scan: scan,
      expand: expand, indentAt: indentAt, dedent: dedent,
      normUsage: normUsage, bumpUsage: bumpUsage, lastUse: lastUse, useCount: useCount,
      search: search, ordered: ordered, folders: folders,
      exportJSON: exportJSON, exportMarkdown: exportMarkdown, parseMarkdown: parseMarkdown, parseImport: parseImport,
      mergeImport: mergeImport, restoreStarters: restoreStarters, retrigger: retrigger,
    };
  })();

  if (typeof window === 'undefined') { // node: expose the model to snippets.test.js
    if (typeof module === 'object' && module && module.exports) module.exports = P;
    return;
  }
  if (typeof window.Cade === 'undefined' || window.__cadeSnippets) return; // loaded once

  // ===========================================================================
  // 2. Runtime — store, insertion, fill-in form.
  // ===========================================================================
  var Cade = window.Cade;
  Cade.loadCSS('snippets.css'); // the fill-in form is styled here too (the plugin may load this file alone)
  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  var USAGE_KEY = 'cade-snippets-usage', FIELDS_KEY = 'cade-snippets-fields', TRIG_KEY = 'cade-snippets-trigger';
  var FILL_ID = 'snippets-fill-panel';
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2200); } catch (e) {} }

  var HOUR12 = true;
  try {
    var ro = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions();
    HOUR12 = ro.hourCycle ? !/h2[34]/.test(ro.hourCycle) : ro.hour12 !== false;
  } catch (e) {}

  // ---- synced store ------------------------------------------------------------
  var listeners = [];
  var handle = null, rawSeen, cur = null, idx = null;
  function blob() {
    if (handle) return handle;
    var onChange = function () { rawSeen = undefined; notify('remote'); };
    try { handle = Cade.syncedBlob('snippets', { onChange: onChange }); }
    catch (e) { handle = null; }
    if (!handle) { // very old core without synced blobs: keep it on this device
      handle = {
        get: function () { try { return JSON.parse(Cade.store.get('cade-snippets-local') || 'null'); } catch (e) { return null; } },
        set: function (d) { try { Cade.store.set('cade-snippets-local', JSON.stringify(d)); } catch (e) {} },
      };
    }
    return handle;
  }
  function state() {
    var raw = blob().get();
    if (!cur || raw !== rawSeen) {
      rawSeen = raw;
      cur = P.normalize(raw) || P.virtualState();
      idx = null;
      try { if (Cade.store.get(TRIG_KEY) !== cur.opts.trigger) Cade.store.set(TRIG_KEY, cur.opts.trigger); } catch (e) {}
    }
    return cur;
  }
  function notify(why) { listeners.slice().forEach(function (fn) { try { fn(why); } catch (e) { console.warn(e); } }); }
  function subscribe(fn) {
    listeners.push(fn);
    return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }
  // Persist a new library state (normalised). Returns false (with a toast) when
  // it would no longer fit the synced blob.
  function save(next) {
    // UTF-8 bytes; the core compresses + encrypts + base64s the blob, so the
    // 180 KB budget stays under its 256 KB cap even for incompressible text.
    var stored = P.toStored(next), size = P.storedSize(stored);
    if (size > P.MAX_JSON) {
      toast('The snippet library is full (' + Math.round(size / 1024) + ' KB of ' + Math.round(P.MAX_JSON / 1024) + ' KB) — delete or shorten some snippets', 'error', 4500);
      return false;
    }
    blob().set(stored);
    rawSeen = stored;
    cur = P.normalize(stored);
    idx = null;
    try { Cade.store.set(TRIG_KEY, cur.opts.trigger); } catch (e) {}
    notify('local');
    return true;
  }
  function lookup(word, allowPrefix) {
    var st = state();
    if (!idx) idx = P.abbrIndex(st);
    return P.findAbbr(idx, word, allowPrefix);
  }
  function opts() { return state().opts; }

  // ---- per-device usage + remembered field values ----------------------------
  var usageCache = null;
  function usage() {
    if (!usageCache) { try { usageCache = P.normUsage(JSON.parse(Cade.store.get(USAGE_KEY) || '{}')); } catch (e) { usageCache = {}; } }
    return usageCache;
  }
  function recordUse(id) {
    usageCache = P.bumpUsage(usage(), id, Date.now());
    try { Cade.store.set(USAGE_KEY, JSON.stringify(usageCache)); } catch (e) {}
  }
  // The last value typed into each fill-in field ({label: value}), offered —
  // pre-selected, so typing replaces it — the next time. Newest last, max 100.
  function fieldMemory() {
    try { var m = JSON.parse(Cade.store.get(FIELDS_KEY) || '[]'); return Array.isArray(m) ? m.filter(function (x) { return Array.isArray(x) && x.length === 2; }) : []; } catch (e) { return []; }
  }
  function recalled(mem, key) { for (var i = mem.length - 1; i >= 0; i--) if (mem[i][0] === key) return mem[i][1]; return null; }
  function rememberFields(values) {
    var m = fieldMemory(), changed = false;
    for (var k in values) if (Object.prototype.hasOwnProperty.call(values, k)) {
      var v = String(values[k] || '');
      if (!v || v.length > 500) continue;
      m = m.filter(function (x) { return x[0] !== k; });
      m.push([k, v]);
      changed = true;
    }
    if (!changed) return;
    if (m.length > 100) m = m.slice(m.length - 100);
    try { Cade.store.set(FIELDS_KEY, JSON.stringify(m)); } catch (e) {}
  }

  // ---- clipboard ------------------------------------------------------------------
  // Must be CALLED inside the user's gesture (tap / key) — browsers only allow a
  // read then. Resolves to the text, or null when it isn't allowed / available.
  function readClipboard() {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        return navigator.clipboard.readText().then(function (t) { return typeof t === 'string' ? t : null; }, function () { return null; });
      }
    } catch (e) {}
    return Promise.resolve(null);
  }

  // ---- insertion ---------------------------------------------------------------------
  function plan(snip) {
    var i = P.scan(snip.body);
    i.needsInput = i.fields.length > 0 || i.clipboard;
    return i;
  }
  // Insert `snip` into `view` replacing [from, to] (default: the selection).
  // o: { from, to, source: 'widget'|'abbr', delim: ' '|'\n'|'', clip: Promise,
  //      done: fn(inserted) }. Returns true when the text went in synchronously,
  // 'pending' when it waits for the clipboard or the fill-in form.
  function insert(view, snip, o) {
    o = o || {};
    view = view || Cade.editor;
    if (!view || !snip) return false;
    if (view.state.readOnly) { toast('Read-only mode — editing is locked', 'error'); return false; }
    var st = view.state, sel = st.selection.main;
    var from = o.from != null ? o.from : sel.from, to = o.to != null ? o.to : sel.to;
    var info = P.scan(snip.body);
    var job = {
      view: view, snip: snip, from: from, to: to, doc: st.doc, expect: st.doc.sliceString(from, to),
      source: o.source || 'widget', delim: o.delim || '', done: o.done || null, clip: null,
      selection: o.source === 'abbr' ? '' : st.doc.sliceString(from, to),
    };
    var go = function (clipText) {
      job.clip = clipText;
      var needClip = info.clipboard && clipText == null;
      if (info.fields.length || needClip) { openFill(job, info, needClip); return 'pending'; }
      return finish(job, {});
    };
    if (info.clipboard) {
      (o.clip || readClipboard()).then(function (t) { go(typeof t === 'string' ? t : null); }, function () { go(null); });
      return 'pending';
    }
    return go(null);
  }
  // Where did the target range go if the document changed meanwhile?
  function relocate(doc, job) {
    if (job.to <= doc.length && doc.sliceString(job.from, job.to) === job.expect) return { from: job.from, to: job.to };
    if (!job.expect) return null;
    var a = Math.max(0, job.from - 4000), b = Math.min(doc.length, job.to + 4000), hay = doc.sliceString(a, b);
    var best = -1, i = hay.indexOf(job.expect);
    while (i >= 0) {
      if (best < 0 || Math.abs(a + i - job.from) < Math.abs(a + best - job.from)) best = i;
      i = hay.indexOf(job.expect, i + 1);
    }
    return best < 0 ? null : { from: a + best, to: a + best + job.expect.length };
  }
  function finish(job, values) {
    var view = job.view, st = view.state, doc = st.doc, from = job.from, to = job.to;
    if (st.readOnly) { toast('Read-only mode — editing is locked', 'error'); if (job.done) job.done(false); return false; }
    if (doc !== job.doc) {
      var r = relocate(doc, job);
      if (r) { from = r.from; to = r.to; }
      else if (job.source === 'widget') { from = st.selection.main.from; to = st.selection.main.to; }
      else { toast('The text changed — snippet not inserted', 'info'); if (job.done) job.done(false); return false; }
    }
    var line = doc.lineAt(from);
    var res = P.expand(job.snip.body, {
      now: new Date(), hour12: HOUR12, clipboard: job.clip, selection: job.selection, values: values,
      indent: P.indentAt(line.text, from - line.from),
    });
    var text = res.text, caret = res.cursor >= 0 ? res.cursor : text.length;
    if (job.delim && res.cursor < 0 && text.indexOf('\n') < 0) { text += job.delim; caret = text.length; }
    view.dispatch({ changes: { from: from, to: to, insert: text }, selection: { anchor: from + caret }, userEvent: 'input.snippet', scrollIntoView: true });
    // A selection-only step closes this undo event, so the next keystrokes
    // don't get merged into it: one Undo always restores what was replaced.
    try { view.dispatch({ selection: view.state.selection, userEvent: 'select.snippet' }); } catch (e) {}
    recordUse(job.snip.id);
    rememberFields(values);
    if (job.source !== 'abbr' || job.formShown) { try { view.focus(); } catch (e) {} }
    if (job.done) job.done(true);
    return true;
  }

  // ---- fill-in form ---------------------------------------------------------------
  var fill = null; // { job, panel }
  function closeFill(submitted) {
    var f = fill;
    if (!f) return;
    fill = null;
    if (f.panel.isConnected) f.panel.remove();
    if (!submitted) {
      if (f.job.done) f.job.done(false);
      try { f.job.view.focus(); } catch (e) {}
    }
  }
  function openFill(job, info, needClip) {
    if (fill) closeFill(false);
    var mem = fieldMemory();
    var html = '<form class="snx-fill" autocomplete="off">' +
      '<div class="snx-fill-name">' + esc(job.snip.name) + '</div>';
    info.fields.forEach(function (f, i) {
      var val = recalled(mem, f.key);
      if (val === null) val = f.def;
      html += '<label class="snx-f"><span>' + esc(f.label) + '</span>';
      if (f.choices) {
        if (f.choices.indexOf(val) < 0) val = f.def;
        html += '<select class="snx-in" data-k="' + i + '">' + f.choices.map(function (c) {
          return '<option' + (c === val ? ' selected' : '') + '>' + esc(c) + '</option>';
        }).join('') + '</select>';
      } else {
        html += '<input class="snx-in" data-k="' + i + '" value="' + esc(val || '') + '" autocapitalize="sentences" spellcheck="false" enterkeyhint="' + (i === info.fields.length - 1 && !needClip ? 'done' : 'next') + '">';
      }
      html += '</label>';
    });
    if (needClip) {
      html += '<label class="snx-f"><span>Clipboard <small>— paste here (it couldn’t be read automatically)</small></span>' +
        '<textarea class="snx-in snx-clip" rows="3" spellcheck="false"></textarea></label>';
    }
    html += '<div class="snx-prevlabel">Preview</div><div class="snx-prev snx-fill-prev"></div>' +
      '<div class="snx-actions"><span class="snx-sp"></span><button type="button" class="snx-btn" data-act="cancel">Cancel</button>' +
      '<button type="submit" class="snx-btn primary">Insert</button></div></form>';
    var panel = Cade.mkPanel(FILL_ID, '✂\ufe0f Fill in', html);
    // Desktop: beside the Snippets library rather than on top of it.
    var lib = document.getElementById('snippets-panel');
    if (lib && window.innerWidth >= 800 && !(Cade.isMinimized && Cade.isMinimized(lib))) {
      var r = lib.getBoundingClientRect(), w = panel.offsetWidth || 360;
      if (r.left - w - 12 >= 8) { panel.style.right = 'auto'; panel.style.left = Math.round(r.left - w - 12) + 'px'; panel.style.top = Math.round(r.top) + 'px'; }
    }
    fill = { job: job, panel: panel };
    job.formShown = true;
    var form = panel.querySelector('form');
    var inputs = panel.querySelectorAll('[data-k]'), clipEl = panel.querySelector('.snx-clip');
    var values = function () {
      var v = {};
      for (var i = 0; i < inputs.length; i++) v[info.fields[+inputs[i].getAttribute('data-k')].key] = inputs[i].value;
      return v;
    };
    var prev = panel.querySelector('.snx-fill-prev');
    var renderPrev = function () {
      var clipText = clipEl ? clipEl.value : job.clip;
      prev.innerHTML = previewHtml(job.snip.body, { values: values(), clipboard: clipText, selection: job.selection }, true);
    };
    renderPrev();
    form.addEventListener('input', renderPrev);
    form.addEventListener('change', renderPrev);
    form.addEventListener('focusin', function (e) { // a recalled value is selected: type to replace it
      var t = e.target;
      if (t && t.tagName === 'INPUT' && t.value) setTimeout(function () { try { if (document.activeElement === t) t.select(); } catch (x) {} }, 0);
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (fill && fill.panel === panel) {
        if (clipEl) job.clip = clipEl.value;
        var v = values();
        closeFill(true);
        finish(job, v);
      }
    });
    form.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFill(false); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true })); }
      else if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
        // Enter moves to the next field; on the last one it inserts.
        var all = Array.prototype.slice.call(form.querySelectorAll('.snx-in')), i = all.indexOf(e.target);
        if (i >= 0 && i < all.length - 1) { e.preventDefault(); all[i + 1].focus(); }
      }
    });
    panel.querySelector('[data-act="cancel"]').addEventListener('click', function () { closeFill(false); });
    panel._onClose = function () { if (fill && fill.panel === panel) { fill = null; if (job.done) job.done(false); try { job.view.focus(); } catch (e) {} } };
    var first = panel.querySelector('.snx-in');
    if (first) {
      try { first.focus(); if (first.select && first.value) first.select(); } catch (e) {}
    }
  }

  // Expansion rendered as HTML with the variable parts highlighted. Editor
  // preview (live = false): fields show their default or label, clipboard /
  // selection show their names. Fill-in form (live = true): the real values,
  // an empty field still shows where its label goes.
  function previewHtml(body, o, live) {
    o = o || {};
    var M0 = '\ue010', M1 = '\ue011', info = P.scan(body), values = {};
    var mark = function (v) { return M0 + v + M1; };
    info.fields.forEach(function (f) {
      var v = o.values && Object.prototype.hasOwnProperty.call(o.values, f.key) ? o.values[f.key] : '';
      values[f.key] = mark(v || (live ? f.label : (f.def || f.label)));
    });
    var r = P.expand(body, {
      now: new Date(), hour12: HOUR12, values: values,
      clipboard: live ? (o.clipboard ? mark(o.clipboard) : mark('clipboard')) : mark('clipboard'),
      selection: live ? (o.selection ? mark(o.selection) : '') : mark('selection'),
    });
    var t = r.text, CARET = '\ue012';
    if (r.cursor >= 0) t = t.slice(0, r.cursor) + CARET + t.slice(r.cursor);
    var h = esc(t);
    h = h.split(M0).join('<mark class="snx-ph">').split(M1).join('</mark>').split(CARET).join('<span class="snx-caret" title="Cursor ends here"></span>');
    return h || '<span class="snx-muted">(empty)</span>';
  }

  window.__cadeSnippets = {
    P: P, state: state, save: save, subscribe: subscribe, lookup: lookup, opts: opts,
    usage: usage, recordUse: recordUse, plan: plan, insert: insert, readClipboard: readClipboard,
    previewHtml: previewHtml, closeFill: closeFill, hour12: HOUR12,
  };
})();
