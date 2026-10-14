/* Habit Tracker for Cade.txt — daily habits with streaks, a week strip,
 * a GitHub-style heatmap and day notes, synced across the account's devices.
 *
 * Schedules: every day, specific weekdays (Mon/Wed/Fri), or N times a week.
 * A habit is a check-off or a counter (8 glasses, 30 min: + adds `step`).
 * A day counts as done when its count reaches the target.
 *
 * Days are LOCAL 'YYYY-MM-DD' strings. "Day starts at" (0–12 h) moves the
 * boundary for night owls: at 01:30 with a 4 am start it is still yesterday.
 * Day arithmetic runs on the key strings through UTC, so DST and travel never
 * shift a day; the panel refreshes itself when the day rolls over (one timeout
 * to the next boundary, only while open, visible and not minimized).
 *
 * Streaks follow the schedule: a Mon/Wed/Fri habit isn't broken on Tuesday
 * (and an off-day check-in is a bonus, not a streak day); an N-a-week habit
 * counts weeks that met N. Today never breaks a streak — it is pending.
 *
 * Storage: Cade.syncedBlob('habits') — whole-blob last-write-wins in core, so
 * this module merges: each habit carries edit times for its settings (u) and
 * its check-ins (lu), plus a per-day edit stamp (m) for days edited in the
 * last three weeks, and deletions leave a tombstone. When a newer copy arrives,
 * the local one is merged in (newest edit per part / per day) and pushed back
 * if it added anything. A local shadow copy catches edits that a remote copy
 * overwrote while this widget wasn't loaded. Check-ins are stored per month as
 * one base-36 digit per day (an array when a count tops 35); history older
 * than ~2 years is trimmed. Blob shape (v1):
 *   { v: 1, cfg: { ds, wk, u },
 *     habits: [ { id, name, icon, color, sched: 'd' | 'w:1,3,5' | 'n:3',
 *                 target, step, unit, o, arch, c: 'YYYY-MM-DD', u, lu,
 *                 log: { 'YYYY-MM': '0101…' | [0, 40, …] },
 *                 notes: { 'YYYY-MM-DD': text }, m: { 'YYYY-MM-DD': secs } } ],
 *     gone: { <id>: secs } }
 *
 * The Model below is DOM-free and unit-tested by habits.test.js.
 */
(function () {
  'use strict';

  // =========================================================================
  // Pure model — no DOM, no Cade.
  // =========================================================================
  var Model = (function () {
    var DAY = 864e5;
    var KEEP_DAYS = 731;              // check-ins / notes kept (~2 years)
    var STAMP_KEEP = 21 * 86400;      // per-day edit stamps kept (seconds)
    var GONE_KEEP = 400 * 86400;      // tombstones kept (seconds)
    var MAX_HABITS = 100, MAX_COUNT = 99999, MAX_TARGET = 9999, NOTE_MAX = 500, MAX_NOTES = 400;
    var PALETTE = ['teal', 'blue', 'green', 'amber', 'orange', 'red', 'pink', 'purple', 'gray'];
    var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var DOW1 = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
    var MONTH_RE = /^(\d{4})-(\d{2})$/;
    var ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
    var hasOwn = Object.prototype.hasOwnProperty;

    function own(o, k) { return hasOwn.call(o, k); }
    function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    function pad4(n) { return n >= 1000 ? String(n) : ('000' + n).slice(-4); }

    // ---- day keys ------------------------------------------------------------
    // A key's UTC midnight in ms (NaN when it isn't a real date).
    function toMs(k) {
      var m = typeof k === 'string' ? KEY_RE.exec(k) : null;
      if (!m) return NaN;
      var y = +m[1], mo = +m[2], d = +m[3];
      if (y < 1970 || mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
      var t = Date.UTC(y, mo - 1, d);
      return new Date(t).getUTCDate() === d ? t : NaN;
    }
    function fromMs(t) {
      var d = new Date(t);
      return pad4(d.getUTCFullYear()) + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
    }
    function isKey(k) { return !isNaN(toMs(k)); }
    function addDays(k, n) { return fromMs(toMs(k) + n * DAY); }
    function diffDays(a, b) { return Math.round((toMs(a) - toMs(b)) / DAY); }
    function dowMs(t) { return ((Math.floor(t / DAY) + 4) % 7 + 7) % 7; } // 1970-01-01 was a Thursday
    function dow(k) { return dowMs(toMs(k)); }
    function weekStart(k, wk) { return addDays(k, -((dow(k) - (wk || 0) + 7) % 7)); }
    function localKey(d) { return pad4(d.getFullYear()) + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }

    // The habit-day of a moment: its local date, or the day before while the
    // wall clock is still before the day-start hour.
    function dayKey(date, ds) {
      var d = date == null ? new Date() : new Date(+date);
      var k = localKey(d);
      return d.getHours() < (ds || 0) ? addDays(k, -1) : k;
    }
    // The next moment the habit-day changes (a non-existent local hour on a
    // DST day resolves forward, which is still the right boundary).
    function nextBoundary(date, ds) {
      var d = date == null ? new Date() : new Date(+date), h = ds || 0;
      var b = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (d.getHours() < h ? 0 : 1), h, 0, 0, 0);
      if (b.getTime() <= d.getTime()) b = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, 0, 0, 0);
      return b;
    }

    function fmtDay(k, year) {
      var t = toMs(k);
      if (isNaN(t)) return '';
      var d = new Date(t);
      return DOW[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + (year ? ' ' + d.getUTCFullYear() : '');
    }
    function fmtDM(k, year) {
      var t = toMs(k);
      if (isNaN(t)) return '';
      var d = new Date(t);
      return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + (year ? ' ' + d.getUTCFullYear() : '');
    }
    function hourLabel(h) { return h === 0 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? h + ' am' : (h - 12) + ' pm'; }

    // ---- small sanitizers ------------------------------------------------------
    function cut(s, max) {
      if (s.length <= max) return s;
      s = s.slice(0, max);
      return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
    }
    function cleanText(v, max) {
      if (v == null || typeof v === 'object') return '';
      return cut(String(v).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim(), max);
    }
    function cleanNote(v) {
      if (v == null || typeof v === 'object') return '';
      var s = String(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      return cut(s, NOTE_MAX);
    }
    function cnt(v) {
      if (typeof v !== 'number' && typeof v !== 'string') return 0;
      v = Math.floor(+v);
      return v > 0 && isFinite(v) ? Math.min(v, MAX_COUNT) : 0;
    }
    function ts(v) {
      if (typeof v !== 'number' && typeof v !== 'string') return 0;
      v = Math.floor(+v);
      return v > 0 && isFinite(v) ? v : 0;
    }
    function clampInt(v, lo, hi, def) {
      if (typeof v !== 'number' && typeof v !== 'string') return def;
      v = Math.floor(+v);
      return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
    }
    function hash(s) {
      var h = 5381;
      for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
      return h.toString(36);
    }
    function sortObj(o) {
      var out = {}, ks = Object.keys(o).sort();
      for (var i = 0; i < ks.length; i++) out[ks[i]] = o[ks[i]];
      return out;
    }

    // ---- schedules ---------------------------------------------------------------
    // { t: 'd' } every day · { t: 'w', days: [0..6] } those weekdays (0 = Sun)
    // · { t: 'n', n: 1..6 } N times a week (7 a week is simply daily).
    function parseSched(s) {
      var t, days, n, m;
      if (isObj(s)) { t = s.t; days = s.days; n = s.n; }
      else if (typeof s === 'string') {
        if ((m = /^w:([0-6](?:,[0-6])*)$/.exec(s))) { t = 'w'; days = m[1].split(','); }
        else if ((m = /^n:(\d{1,2})$/.exec(s))) { t = 'n'; n = m[1]; }
      }
      if (t === 'w') {
        var seen = {}, out = [];
        if (Array.isArray(days)) {
          for (var i = 0; i < days.length; i++) {
            var d = days[i];
            if (typeof d !== 'number' && typeof d !== 'string') continue;
            d = +d;
            if (d >= 0 && d <= 6 && d === Math.floor(d) && !seen[d]) { seen[d] = 1; out.push(d); }
          }
        }
        out.sort(function (a, b) { return a - b; });
        return out.length && out.length < 7 ? { t: 'w', days: out } : { t: 'd' };
      }
      if (t === 'n') {
        n = clampInt(n, 1, 7, 3);
        return n >= 7 ? { t: 'd' } : { t: 'n', n: n };
      }
      return { t: 'd' };
    }
    function schedStr(s) { return s.t === 'w' ? 'w:' + s.days.join(',') : s.t === 'n' ? 'n:' + s.n : 'd'; }
    function schedLabel(s, wk) {
      if (s.t === 'n') return s.n + '× a week';
      if (s.t !== 'w') return 'Every day';
      var str = s.days.join(',');
      if (str === '1,2,3,4,5') return 'Weekdays';
      if (str === '0,6') return 'Weekends';
      var ds = s.days.slice().sort(function (a, b) { return ((a - wk + 7) % 7) - ((b - wk + 7) % 7); });
      return ds.map(function (d) { return DOW[d]; }).join(' · ');
    }

    // ---- check-in log: per month, one base-36 digit per day -----------------------
    function encodeLog(log) {
      var months = {}, keys = Object.keys(log).sort(), out = {}, i;
      for (i = 0; i < keys.length; i++) {
        var v = log[keys[i]];
        if (!(v > 0)) continue;
        var mk = keys[i].slice(0, 7);
        (months[mk] || (months[mk] = []))[+keys[i].slice(8, 10) - 1] = v;
      }
      Object.keys(months).sort().forEach(function (mk) {
        var arr = months[mk], big = false;
        for (var j = 0; j < arr.length; j++) { if (arr[j] == null) arr[j] = 0; else if (arr[j] > 35) big = true; }
        out[mk] = big ? arr : arr.map(function (x) { return x.toString(36); }).join('');
      });
      return out;
    }
    // Accepts the month form and, defensively, a plain { 'YYYY-MM-DD': n } map.
    function decodeLog(src, into) {
      if (!isObj(src)) return into;
      for (var k in src) {
        if (!own(src, k)) continue;
        var v = src[k];
        if (MONTH_RE.test(k)) {
          var y = +k.slice(0, 4), mo = +k.slice(5, 7);
          if (y < 1970 || mo < 1 || mo > 12) continue;
          var dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
          var vals = typeof v === 'string' ? v.slice(0, 31).split('').map(function (c) { return parseInt(c, 36); }) : Array.isArray(v) ? v : null;
          if (!vals) continue;
          for (var i = 0; i < vals.length && i < dim; i++) {
            var n = cnt(vals[i]);
            if (n) into[k + '-' + p2(i + 1)] = n;
          }
        } else if (isKey(k)) {
          var n2 = cnt(v);
          if (n2) into[k] = n2;
        }
      }
      return into;
    }

    // ---- normalize: never trust the blob's shape -------------------------------------
    function emptyState() { return { cfg: { ds: 0, wk: 1, u: 0 }, habits: [], gone: {} }; }
    function newest(o) { var best = ''; for (var k in o) if (own(o, k) && k > best) best = k; return best; }

    function normHabit(r, i, today, nowS) {
      if (!isObj(r)) return null;
      var name = cleanText(r.name, 60) || 'Habit';
      var target = clampInt(r.target, 1, MAX_TARGET, 1);
      var h = {
        id: typeof r.id === 'string' && ID_RE.test(r.id) ? r.id : 'h' + hash(name + '|' + i),
        name: name,
        icon: cleanText(r.icon, 16),
        color: PALETTE.indexOf(r.color) !== -1 ? r.color : 'teal',
        sched: parseSched(r.sched),
        target: target,
        step: clampInt(r.step, 1, target, 1),
        unit: cleanText(r.unit, 16),
        o: typeof r.o === 'number' && isFinite(r.o) ? r.o : i,
        arch: r.arch === true || r.arch === 1,
        c: isKey(r.c) ? r.c : '',
        u: ts(r.u), lu: ts(r.lu),
        log: decodeLog(r.log, {}), notes: {}, m: {},
      };
      var k, last = newest(h.log);
      // Trim old history relative to the newest check-in too, so a device whose
      // clock is far ahead can't wipe real data.
      var cutoff = addDays(last && last < today ? last : today, -KEEP_DAYS);
      for (k in h.log) if (own(h.log, k) && k < cutoff) delete h.log[k];
      if (isObj(r.notes)) {
        var nk = Object.keys(r.notes).filter(function (x) { return isKey(x) && x >= cutoff; }).sort().reverse();
        for (var j = 0; j < nk.length && j < MAX_NOTES; j++) {
          var s = cleanNote(r.notes[nk[j]]);
          if (s) h.notes[nk[j]] = s;
        }
      }
      if (isObj(r.m)) {
        for (k in r.m) {
          if (!own(r.m, k) || !isKey(k) || k < cutoff) continue;
          var t = ts(r.m[k]);
          if (t && t >= nowS - STAMP_KEEP) h.m[k] = t;
        }
      }
      if (!h.c) h.c = startKey(h) || today;
      return h;
    }

    function byOrder(a, b) { return a.o - b.o || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

    function normalize(raw, today, nowS) {
      var out = emptyState(), k;
      if (!isObj(raw)) return out;
      var c = raw.cfg;
      if (isObj(c)) {
        out.cfg.ds = clampInt(c.ds, 0, 12, 0);
        out.cfg.wk = c.wk === 0 || c.wk === '0' ? 0 : 1;
        out.cfg.u = ts(c.u);
      }
      if (isObj(raw.gone)) {
        for (k in raw.gone) {
          if (!own(raw.gone, k) || !ID_RE.test(k)) continue;
          var g = ts(raw.gone[k]);
          if (g && g >= nowS - GONE_KEEP) out.gone[k] = g;
        }
      }
      var list = Array.isArray(raw.habits) ? raw.habits : [], seen = {};
      for (var i = 0; i < list.length && i < 1000; i++) {
        var h = normHabit(list[i], i, today, nowS);
        if (!h) continue;
        if (own(out.gone, h.id) && out.gone[h.id] >= h.u) continue;
        if (own(seen, h.id)) {
          var at = seen[h.id];
          if (h.u > out.habits[at].u) out.habits[at] = h;
          continue;
        }
        seen[h.id] = out.habits.length;
        out.habits.push(h);
      }
      out.habits.sort(byOrder);
      if (out.habits.length > MAX_HABITS) out.habits.length = MAX_HABITS;
      return out;
    }

    function serialize(st) {
      return {
        v: 1,
        cfg: { ds: st.cfg.ds, wk: st.cfg.wk, u: st.cfg.u },
        habits: st.habits.map(function (h) {
          return {
            id: h.id, name: h.name, icon: h.icon, color: h.color, sched: schedStr(h.sched),
            target: h.target, step: h.step, unit: h.unit, o: h.o, arch: h.arch ? 1 : 0, c: h.c, u: h.u, lu: h.lu,
            log: encodeLog(h.log), notes: sortObj(h.notes), m: sortObj(h.m),
          };
        }),
        gone: sortObj(st.gone),
      };
    }
    function same(a, b) { return JSON.stringify(serialize(a)) === JSON.stringify(serialize(b)); }

    // ---- merge: newest edit wins per part / per day; ties go to `remote` ----------------
    function copyMap(o) { var r = {}; for (var k in o) if (own(o, k)) r[k] = o[k]; return r; }
    function cloneHabit(h) {
      var c = {};
      for (var k in h) if (own(h, k)) c[k] = h[k];
      c.sched = h.sched.t === 'w' ? { t: 'w', days: h.sched.days.slice() } : h.sched.t === 'n' ? { t: 'n', n: h.sched.n } : { t: 'd' };
      c.log = copyMap(h.log); c.notes = copyMap(h.notes); c.m = copyMap(h.m);
      return c;
    }
    function mergeHabit(a, b) {
      var h = cloneHabit(a.u > b.u ? a : b);
      h.c = a.c < b.c ? a.c : b.c;
      h.log = {}; h.notes = {}; h.m = {};
      var newer = a.lu > b.lu ? a : b, keys = {}, k;
      [a.log, b.log, a.notes, b.notes, a.m, b.m].forEach(function (o) { for (var x in o) if (own(o, x)) keys[x] = 1; });
      for (k in keys) {
        var ta = a.m[k] || 0, tb = b.m[k] || 0;
        var src = ta || tb ? (ta > tb ? a : b) : newer;
        if (src.log[k]) h.log[k] = src.log[k];
        if (src.notes[k]) h.notes[k] = src.notes[k];
        if (ta || tb) h.m[k] = Math.max(ta, tb);
      }
      h.lu = Math.max(a.lu, b.lu);
      return h;
    }
    function merge(local, remote) {
      var out = emptyState(), k;
      var cf = local.cfg.u > remote.cfg.u ? local.cfg : remote.cfg;
      out.cfg = { ds: cf.ds, wk: cf.wk, u: cf.u };
      [local.gone, remote.gone].forEach(function (g) { for (var x in g) if (own(g, x) && !(out.gone[x] >= g[x])) out.gone[x] = g[x]; });
      var L = {}, R = {}, ids = [];
      local.habits.forEach(function (h) { L[h.id] = h; ids.push(h.id); });
      remote.habits.forEach(function (h) { R[h.id] = h; if (!own(L, h.id)) ids.push(h.id); });
      for (var i = 0; i < ids.length; i++) {
        k = ids[i];
        var a = own(L, k) ? L[k] : null, b = own(R, k) ? R[k] : null;
        var h = a && b ? mergeHabit(a, b) : cloneHabit(a || b);
        if (own(out.gone, k) && out.gone[k] >= h.u) continue;
        out.habits.push(h);
      }
      out.habits.sort(byOrder);
      if (out.habits.length > MAX_HABITS) out.habits.length = MAX_HABITS;
      return out;
    }

    // ---- edits (mutate the habit / state; stamp edit times in seconds) ---------------------
    function count(h, k) { return h.log[k] || 0; }
    function isDone(h, k) { return (h.log[k] || 0) >= h.target; }
    function stamp(h, k, nowS) { h.m[k] = nowS; h.lu = Math.max(h.lu, nowS); }
    function setCount(h, k, v, nowS) {
      v = cnt(v);
      if (v) h.log[k] = v; else delete h.log[k];
      stamp(h, k, nowS);
    }
    function toggleDay(h, k, nowS) { setCount(h, k, isDone(h, k) ? 0 : h.target, nowS); return isDone(h, k); }
    function bump(h, k, dir, nowS) { setCount(h, k, Math.max(0, count(h, k) + (dir < 0 ? -h.step : h.step)), nowS); }
    function setNote(h, k, text, nowS) {
      var s = cleanNote(text);
      if ((h.notes[k] || '') === s) return false;
      if (s) h.notes[k] = s; else delete h.notes[k];
      stamp(h, k, nowS);
      return true;
    }
    function applyFields(h, f) {
      if (f.name != null) h.name = cleanText(f.name, 60) || h.name || 'Habit';
      if (f.icon != null) h.icon = cleanText(f.icon, 16);
      if (f.color != null && PALETTE.indexOf(f.color) !== -1) h.color = f.color;
      if (f.sched != null) h.sched = parseSched(f.sched);
      if (f.target != null) h.target = clampInt(f.target, 1, MAX_TARGET, h.target || 1);
      if (f.step != null || f.target != null) h.step = clampInt(f.step != null ? f.step : h.step, 1, h.target, 1);
      if (f.unit != null) h.unit = cleanText(f.unit, 16);
    }
    function makeHabit(f, id, today, nowS, o) {
      var h = { id: id, name: 'Habit', icon: '', color: 'teal', sched: { t: 'd' }, target: 1, step: 1, unit: '',
        o: o || 0, arch: false, c: today, u: nowS, lu: 0, log: {}, notes: {}, m: {} };
      applyFields(h, f || {});
      return h;
    }
    function updateHabit(h, f, nowS) { applyFields(h, f); h.u = nowS; }
    function setArchived(h, on, nowS) { h.arch = !!on; h.u = nowS; }
    function findHabit(st, id) { for (var i = 0; i < st.habits.length; i++) if (st.habits[i].id === id) return st.habits[i]; return null; }
    function removeHabit(st, id, nowS) {
      st.habits = st.habits.filter(function (h) { return h.id !== id; });
      st.gone[id] = nowS;
    }
    // New order for the listed ids (0, 1, 2, …); only habits whose place changed get a new edit time.
    function setOrder(st, ids, nowS) {
      ids.forEach(function (id, i) {
        var h = findHabit(st, id);
        if (h && h.o !== i) { h.o = i; h.u = nowS; }
      });
      st.habits.sort(byOrder);
    }
    function setCfg(st, patch, nowS) {
      if (patch.ds != null) st.cfg.ds = clampInt(patch.ds, 0, 12, st.cfg.ds);
      if (patch.wk != null) st.cfg.wk = patch.wk === 0 ? 0 : 1;
      st.cfg.u = nowS;
    }

    // ---- stats ----------------------------------------------------------------------------
    function startKey(h) {
      var s = isKey(h.c) ? h.c : '';
      for (var k in h.log) if (own(h.log, k) && (!s || k < s)) s = k;
      return s;
    }
    function schedMs(h, t) { return h.sched.t !== 'w' || h.sched.days.indexOf(dowMs(t)) !== -1; }
    function scheduledOn(h, k) { return schedMs(h, toMs(k)); }
    function doneMs(h, t) { return (h.log[fromMs(t)] || 0) >= h.target; }

    // Current and best streak. Days for daily / weekday habits (only scheduled
    // days count; today is pending until done), weeks for N-a-week habits (the
    // current week is pending until it reaches N).
    function streaks(h, today, wk) {
      var s = startKey(h) || today, t0 = toMs(s), t1 = toMs(today), run = 0, best = 0, t;
      var weekly = h.sched.t === 'n';
      if (!(t0 <= t1)) return { cur: 0, best: 0, unit: weekly ? 'w' : 'd' };
      if (weekly) {
        var n = h.sched.n, w0 = toMs(weekStart(s, wk)), wc = toMs(weekStart(today, wk));
        for (var w = w0; w <= wc; w += 7 * DAY) {
          var c = 0;
          for (t = w; t < w + 7 * DAY && t <= t1; t += DAY) if (doneMs(h, t)) c++;
          if (c >= n) { if (++run > best) best = run; }
          else if (w !== wc) run = 0;
        }
        return { cur: run, best: best, unit: 'w' };
      }
      for (t = t0; t <= t1; t += DAY) {
        if (!schedMs(h, t)) continue;
        if (doneMs(h, t)) { if (++run > best) best = run; }
        else if (t !== t1) run = 0;
      }
      return { cur: run, best: best, unit: 'd' };
    }

    // Completion over the last `days` days (from the habit's start at the
    // earliest). Today counts only once done. N-a-week: each week's check-ins
    // are capped at N and measured against N per 7 days. null = nothing due yet.
    function rate(h, today, days, wk) {
      var s = startKey(h) || today, from = addDays(today, -(days - 1));
      if (from < s) from = s;
      var t0 = toMs(from), t1 = toMs(today), t, due = 0, dn = 0;
      if (!(t0 <= t1)) return null;
      if (h.sched.t === 'n') {
        var perWeek = {}, eff = 0;
        for (t = t0; t <= t1; t += DAY) {
          var d = doneMs(h, t);
          if (t === t1 && !d) continue;
          eff++;
          if (d) { var wkey = weekStart(fromMs(t), wk); perWeek[wkey] = (perWeek[wkey] || 0) + 1; }
        }
        for (var w in perWeek) if (own(perWeek, w)) dn += Math.min(perWeek[w], h.sched.n);
        due = h.sched.n * eff / 7;
        return due > 0 ? { done: dn, due: due, pct: Math.min(1, dn / due) } : null;
      }
      for (t = t0; t <= t1; t += DAY) {
        if (!schedMs(h, t)) continue;
        var dd = doneMs(h, t);
        if (t === t1 && !dd) continue;
        due++;
        if (dd) dn++;
      }
      return due ? { done: dn, due: due, pct: dn / due } : null;
    }

    function weekDone(h, today, wk, skipToday) {
      var c = 0, t1 = toMs(today);
      for (var t = toMs(weekStart(today, wk)); t <= t1; t += DAY) {
        if (skipToday && t === t1) break;
        if (doneMs(h, t)) c++;
      }
      return c;
    }
    // Today's state. `due`: on the schedule today — for N-a-week, while the week
    // still needs check-ins (today's own check-in doesn't move it out).
    function info(h, today, wk) {
      var c = count(h, today), r = { count: c, done: c >= h.target, due: true, week: 0 };
      if (h.sched.t === 'n') { r.week = weekDone(h, today, wk, false); r.due = weekDone(h, today, wk, true) < h.sched.n; }
      else r.due = scheduledOn(h, today);
      return r;
    }
    function active(st) { return st.habits.filter(function (h) { return !h.arch; }); }
    function progress(st, today) {
      var done = 0, total = 0;
      active(st).forEach(function (h) {
        var f = info(h, today, st.cfg.wk);
        if (!f.due) return;
        total++;
        if (f.done) done++;
      });
      return { done: done, total: total };
    }
    function totalDone(h) { var n = 0; for (var k in h.log) if (own(h.log, k) && h.log[k] >= h.target) n++; return n; }

    // One day's look: d done · p partial · m missed · t today, pending · o off
    // (not scheduled / optional for N-a-week) · b before the habit · f future.
    function cellState(h, k, today, start) {
      if (k > today) return 'f';
      var c = h.log[k] || 0;
      if (c >= h.target) return 'd';
      if (k < (start || startKey(h))) return 'b';
      if (c > 0) return 'p';
      if (h.sched.t === 'n' || !scheduledOn(h, k)) return 'o';
      return k === today ? 't' : 'm';
    }
    // Heatmap: `weeks` columns ending with the current week, rows = weekdays from
    // the week start. Month labels sit where a column's first day enters a new month.
    function heat(h, today, weeks, wk) {
      var first = addDays(weekStart(today, wk), -7 * (weeks - 1)), start = startKey(h) || today;
      var cells = [], months = [], t = toMs(first), prevMon = -1;
      for (var i = 0; i < weeks * 7; i++, t += DAY) {
        var k = fromMs(t);
        if (i % 7 === 0) {
          var mon = new Date(t).getUTCMonth();
          if (mon !== prevMon) months.push({ col: i / 7, label: MON[mon] });
          prevMon = mon;
        }
        cells.push({ k: k, s: cellState(h, k, today, start), c: h.log[k] || 0 });
      }
      if (months.length > 1 && months[1].col < 3) months.shift(); // a sliver of a month at the left edge
      return { first: first, cells: cells, months: months };
    }

    // ---- markdown summaries ----------------------------------------------------------------
    function mdCell(s) { return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|'); }
    function label(h) { return (h.icon ? h.icon + ' ' : '') + h.name; }
    function streakTxt(s) { return s.cur + (s.unit === 'w' ? 'w' : 'd'); }

    function summaryToday(st, today) {
      var wk = st.cfg.wk, due = [], extra = [];
      active(st).forEach(function (h) {
        var f = info(h, today, wk);
        if (f.due) due.push({ h: h, f: f });
        else if (f.count > 0) extra.push({ h: h, f: f });
      });
      if (!due.length && !extra.length) return '';
      var done = due.filter(function (x) { return x.f.done; }).length;
      var out = ['**Habits · ' + fmtDay(today, true) + '**' + (due.length ? ' — ' + done + '/' + due.length + ' done' : ''), ''];
      due.concat(extra).forEach(function (x) {
        var h = x.h, f = x.f, bits = [], s = streaks(h, today, wk);
        if (h.target > 1) bits.push(f.count + '/' + h.target + (h.unit ? ' ' + h.unit : ''));
        if (h.sched.t === 'n') bits.push(f.week + '/' + h.sched.n + ' this week');
        if (s.cur >= 2) bits.push('🔥 ' + s.cur + (s.unit === 'w' ? ' wk' : ''));
        if (!f.due) bits.push('bonus');
        out.push('- [' + (f.done ? 'x' : ' ') + '] ' + label(h) + (bits.length ? ' · ' + bits.join(' · ') : ''));
      });
      return out.join('\n');
    }

    function summaryWeek(st, today, wkArg) {
      var wk = wkArg != null ? wkArg : st.cfg.wk, hs = active(st);
      if (!hs.length) return '';
      var ws = weekStart(today, wk), days = [], i;
      for (i = 0; i < 7; i++) days.push(addDays(ws, i));
      var out = ['**Habits · week of ' + fmtDay(ws, true) + '**', ''];
      out.push('| Habit | ' + days.map(function (k) { return DOW[dow(k)]; }).join(' | ') + ' | Week | Streak |');
      out.push('|:--|' + days.map(function () { return ':-:'; }).join('|') + '|:-:|--:|');
      hs.forEach(function (h) {
        var start = startKey(h) || today, dn = 0, due = 0;
        var cells = days.map(function (k) {
          if (k > today) return ' ';
          var c = h.log[k] || 0, done = c >= h.target, sch = h.sched.t === 'n' || scheduledOn(h, k);
          // scheduled days so far, today included, for the Week column
          if (h.sched.t !== 'n' && sch && k >= start) { due++; if (done) dn++; }
          if (done) return '✓';
          if (k < start) return ' ';
          if (c > 0) return String(c);
          if (!sch) return '–';
          return k === today ? '○' : '·';
        });
        var name = label(h) + (h.target > 1 ? ' (' + h.target + (h.unit ? ' ' + h.unit : '') + ')' : '') + (h.sched.t === 'n' ? ' · ' + h.sched.n + '×/wk' : '');
        var weekCol = h.sched.t === 'n' ? weekDone(h, today, wk, false) + '/' + h.sched.n : due ? dn + '/' + due : '–';
        out.push('| ' + mdCell(name) + ' | ' + cells.join(' | ') + ' | ' + weekCol + ' | ' + streakTxt(streaks(h, today, wk)) + ' |');
      });
      return out.join('\n');
    }

    // Where a block lands in the note: on the cursor's line when it is blank,
    // else after it, with a blank line on either side. → { from, to, insert, cursor }
    // (`cursor` = offset of the block's end inside `insert`).
    function insertPlan(lineText, lineFrom, lineTo, prevText, nextText, block) {
      var blank = function (s) { return s != null && !/\S/.test(s); };
      if (blank(lineText)) {
        var pre = prevText != null && !blank(prevText) ? '\n' : '';
        var post = nextText != null && !blank(nextText) ? '\n' : '';
        return { from: lineFrom, to: lineTo, insert: pre + block + post, cursor: pre.length + block.length };
      }
      var tail = nextText != null && !blank(nextText) ? '\n' : '';
      return { from: lineTo, to: lineTo, insert: '\n\n' + block + tail, cursor: 2 + block.length };
    }

    return {
      PALETTE: PALETTE, DOW: DOW, DOW1: DOW1, MON: MON, KEEP_DAYS: KEEP_DAYS, MAX_HABITS: MAX_HABITS, MAX_TARGET: MAX_TARGET, NOTE_MAX: NOTE_MAX,
      toMs: toMs, fromMs: fromMs, isKey: isKey, addDays: addDays, diffDays: diffDays, dow: dow, weekStart: weekStart,
      dayKey: dayKey, nextBoundary: nextBoundary, fmtDay: fmtDay, fmtDM: fmtDM, hourLabel: hourLabel,
      cleanText: cleanText, cleanNote: cleanNote, parseSched: parseSched, schedStr: schedStr, schedLabel: schedLabel,
      encodeLog: encodeLog, decodeLog: decodeLog, emptyState: emptyState, normalize: normalize, serialize: serialize, same: same, merge: merge,
      count: count, isDone: isDone, setCount: setCount, toggleDay: toggleDay, bump: bump, setNote: setNote,
      makeHabit: makeHabit, updateHabit: updateHabit, setArchived: setArchived, findHabit: findHabit, removeHabit: removeHabit,
      setOrder: setOrder, setCfg: setCfg,
      startKey: startKey, scheduledOn: scheduledOn, streaks: streaks, rate: rate, weekDone: weekDone, info: info, active: active,
      progress: progress, totalDone: totalDone, cellState: cellState, heat: heat,
      summaryToday: summaryToday, summaryWeek: summaryWeek, insertPlan: insertPlan,
    };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = Model;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // =========================================================================
  // Panel UI
  // =========================================================================
  var Cade = window.Cade;
  Cade.loadCSS('habits.css');

  var PANEL_ID = 'habits-panel';
  var TITLE = '🔥 Habit Tracker';
  var PREFS_KEY = 'cade-habits-prefs';
  var SHADOW_KEY = 'cade-habits-shadow';
  var HM_CELL = 11, HM_GAP = 3, HM_LABEL = 14;     // heatmap geometry, px (matches habits.css)
  var ICONS = ['✓', '💧', '🏃', '📖', '🧘', '💪', '🥗', '💤', '🦷', '💊', '✍️', '🎸', '🧹', '🌿', '📵', '☀️', '🚶', '🧠', '💰', '🙏', '🌙'];
  var COLOR_NAMES = { teal: 'Teal', blue: 'Blue', green: 'Green', amber: 'Amber', orange: 'Orange', red: 'Red', pink: 'Pink', purple: 'Purple', gray: 'Gray' };
  var DAY2 = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  var PRESETS = [
    { name: 'Drink water', icon: '💧', color: 'blue', sched: { t: 'd' }, target: 8, step: 1, unit: 'glasses' },
    { name: 'Exercise', icon: '🏃', color: 'orange', sched: { t: 'n', n: 3 } },
    { name: 'Read', icon: '📖', color: 'purple', sched: { t: 'd' }, target: 20, step: 5, unit: 'min' },
    { name: 'Meditate', icon: '🧘', color: 'teal', sched: { t: 'd' } },
    { name: 'Floss', icon: '🦷', color: 'pink', sched: { t: 'd' } },
    { name: 'Lights out by 11', icon: '🌙', color: 'amber', sched: { t: 'w', days: [0, 1, 2, 3, 4] } },
  ];
  var ARCHIVE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 4.5h17v4h-17zM5 8.5V18a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V8.5M10 12h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var blob = null, state = null, P = null;
  var prefs = { rest: false };

  // ---- small utils ----------------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function nowS() { return Math.floor(Date.now() / 1000); }
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 1800); } catch (e) {} }
  function haptic(ms) { try { if (Cade.haptic) Cade.haptic(ms); } catch (e) {} }
  function today() { return Model.dayKey(new Date(), state.cfg.ds); }
  function wk() { return state.cfg.wk; }
  function find(id) { return id ? Model.findHabit(state, id) : null; }
  function isMin() { return !!(P && Cade.isMinimized && Cade.isMinimized(P.el)); }
  function repeat(s, n) { var r = ''; while (n-- > 0) r += s; return r; }
  function newId() { return 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function loadPrefs() {
    try { var p = JSON.parse(Cade.store.get(PREFS_KEY) || 'null'); if (p && typeof p.rest === 'boolean') prefs.rest = p.rest; } catch (e) {}
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }
  function noteFocused() { var a = document.activeElement; return !!(P && a && a.classList && a.classList.contains('hb-note') && P.el.contains(a)); }

  // ---- data: synced blob + local shadow ---------------------------------------------------
  function load() {
    var t0 = Model.dayKey(new Date(), 0), ns = nowS(), shadow = null;
    blob = Cade.syncedBlob('habits', { onChange: onRemote });
    var cur = Model.normalize(blob.get(), t0, ns);
    try { shadow = JSON.parse(Cade.store.get(SHADOW_KEY) || 'null'); } catch (e) {}
    state = shadow ? Model.merge(Model.normalize(shadow, t0, ns), cur) : cur;
    // A remote copy replaced this device's data while the widget wasn't loaded: put the local edits back.
    if (shadow && !Model.same(state, cur)) persist();
  }
  function saveShadow(ser) { try { Cade.store.set(SHADOW_KEY, JSON.stringify(ser)); } catch (e) {} }
  function persist() {
    var ser = Model.serialize(state);
    try { blob.set(ser); } catch (e) {}
    saveShadow(ser);
  }
  // A newer copy from another device: merge ours in (newest edit wins per part /
  // per day) and push back only if that added something.
  function onRemote(data) {
    var t0 = Model.dayKey(new Date(), 0), ns = nowS();
    var remote = Model.normalize(data, t0, ns);
    if (!state) state = Model.emptyState();
    state = Model.merge(state, remote);
    if (!Model.same(state, remote)) persist();
    else saveShadow(Model.serialize(state));
    refreshSoon();
  }
  function refreshSoon() {
    if (!P) return;
    if (P.view === 'edit' && P.form && P.form.id && !find(P.form.id)) {
      P.form = null; P.view = 'today';
      toast('That habit was deleted on another device');
    }
    if (P.view === 'detail' && !find(P.detail)) P.view = 'today';
    if (isMin() || document.hidden || P.drag || P.view === 'edit' || noteFocused()) { P.dirty = true; return; }
    render();
  }

  // ---- rendering ---------------------------------------------------------------------------
  function chip(h) {
    return '<span class="hb-chip" aria-hidden="true">' + esc(h.icon || (h.name.charAt(0) || '•').toUpperCase()) + '</span>';
  }
  function streakHtml(s) {
    var u = s.unit === 'w' ? ' wk' : '';
    return '<span class="hb-streak' + (s.cur ? '' : ' zero') + '" title="Current streak: ' + plural(s.cur, s.unit === 'w' ? 'week' : 'day') + '">' +
      '<span class="hb-fl" aria-hidden="true">🔥</span>' + s.cur + u + '</span>';
  }
  function shortDays(sc) {
    var str = sc.days.join(',');
    if (str === '1,2,3,4,5') return 'weekdays';
    if (str === '0,6') return 'weekends';
    var w = wk();
    return sc.days.slice().sort(function (a, b) { return ((a - w + 7) % 7) - ((b - w + 7) % 7); }).map(function (d) { return DAY2[d]; }).join(' ');
  }
  function dayWord(h, k, st, c) {
    var s = Model.fmtDay(k) + ' — ';
    if (h.target > 1 && c > 0) return s + c + '/' + h.target + (h.unit ? ' ' + h.unit : '') + (st === 'd' ? ' ✓' : '');
    return s + ({ d: 'done', p: 'partly', m: 'missed', t: 'not yet', o: h.sched.t === 'n' ? 'open' : 'not scheduled', b: 'before this habit', f: 'upcoming' }[st] || '');
  }

  function topHtml(done, total) {
    var ds = state.cfg.ds, late = ds > 0 && new Date().getHours() < ds, all = total > 0 && done === total;
    var segs = Math.min(total, 10), on = total ? Math.round(done / total * segs) : 0;
    if (done > 0 && !on) on = 1;
    if (done < total && on === segs) on = segs - 1;
    var cheer = all ? '<div class="hb-cheer' + (P.cheer ? ' fresh' : '') + '" role="status">✦ all done for today ✦</div>' : '';
    P.cheer = false;
    return '<div class="hb-top">' +
      '<div class="hb-date">' + esc(Model.fmtDay(P.day)) + (late ? '<small> · until ' + Model.hourLabel(ds) + '</small>' : '') + '</div>' +
      (total ? '<div class="hb-prog' + (all ? ' all' : '') + '" role="img" aria-label="' + done + ' of ' + total + ' done today">' +
        '<span class="hb-bar" aria-hidden="true"><i>' + repeat('▰', on) + '</i>' + repeat('▱', segs - on) + '</span><b>' + done + '/' + total + '</b></div>' : '') +
      '</div>' + cheer;
  }

  function cardHtml(x, dim) {
    var h = x.h, f = x.f, t = P.day, s = Model.streaks(h, t, wk()), counter = h.target > 1, i;
    var meta = [streakHtml(s)];
    if (s.best > s.cur) meta.push('best ' + s.best);
    if (counter) meta.push('<span class="hb-num">' + f.count + '/' + h.target + '</span>' + (h.unit ? ' ' + esc(h.unit) : ''));
    if (h.sched.t === 'n') meta.push('<span class="hb-num">' + f.week + '/' + h.sched.n + '</span> this week');
    else if (h.sched.t === 'w') meta.push(esc(shortDays(h.sched)));
    var start = Model.startKey(h) || t, strip = '';
    for (i = 6; i >= 0; i--) {
      var k = Model.addDays(t, -i), st = Model.cellState(h, k, t, start), c = Model.count(h, k), word = esc(dayWord(h, k, st, c));
      var fill = st === 'p' ? Math.max(12, Math.round(Math.min(1, c / h.target) * 100)) : 0;
      strip += '<button type="button" class="hb-d s-' + st + (i ? '' : ' td') + '" data-act="day" data-id="' + h.id + '" data-k="' + k + '"' +
        (fill ? ' style="--f:' + fill + '%"' : '') + ' aria-pressed="' + (st === 'd') + '" title="' + word + '" aria-label="' + word + '">' +
        '<span class="hb-dl" aria-hidden="true">' + Model.DOW1[Model.dow(k)] + '</span><span class="hb-sq" aria-hidden="true"></span></button>';
    }
    var pct = Math.min(1, f.count / h.target);
    var bigLabel = counter ? h.name + ': ' + f.count + ' of ' + h.target + (h.unit ? ' ' + h.unit : '') + ' — add ' + h.step : h.name + (f.done ? ' — done (tap to undo)' : ' — mark done');
    var big = '<button type="button" class="hb-big' + (f.done ? ' done' : '') + (counter ? ' ctr' : '') + '" data-act="check" data-id="' + h.id + '" style="--p:' + pct.toFixed(3) + '"' +
      ' aria-pressed="' + f.done + '" aria-label="' + esc(bigLabel) + '" title="' + esc(counter ? '+' + h.step + (h.unit ? ' ' + h.unit : '') : f.done ? 'Done — tap to undo' : 'Mark done') + '">' +
      '<span>' + (counter ? f.count : '✓') + '</span></button>';
    var dec = counter ? '<button type="button" class="hb-dec" data-act="dec" data-id="' + h.id + '" aria-label="' + esc(h.name) + ': minus ' + h.step + '" title="−' + h.step + '"' + (f.count ? '' : ' disabled') + '>−</button>' : '';
    return '<div class="hb-card hb-c-' + h.color + (f.done ? ' is-done' : '') + (dim ? ' dim' : '') + '" data-id="' + h.id + '">' +
      '<button type="button" class="hb-info" data-act="open" data-id="' + h.id + '" title="Details, history & notes">' + chip(h) +
        '<span class="hb-tx"><span class="hb-name">' + esc(h.name) + '</span><span class="hb-meta">' + meta.join('<i> · </i>') + '</span></span></button>' +
      '<div class="hb-act">' + dec + big + '</div>' +
      '<div class="hb-week" role="group" aria-label="' + esc(h.name) + ', last 7 days">' + strip + '</div>' +
    '</div>';
  }

  function insHtml() {
    if (P.ins) {
      return '<div class="hb-ins open"><span class="hb-ins-l">Insert at the cursor:</span>' +
        '<button type="button" class="hb-btn" data-act="ins" data-v="today" title="A checklist of today">☑ Today</button>' +
        '<button type="button" class="hb-btn" data-act="ins" data-v="week" title="A table of this week">▦ This week</button>' +
        '<button type="button" class="hb-ib" data-act="ins-x" aria-label="Cancel" title="Cancel">×</button></div>';
    }
    return '<div class="hb-ins"><button type="button" class="hb-link" data-act="ins-open">⤓ Insert summary into the note</button></div>';
  }

  function presetSub(p) {
    return (p.target > 1 ? p.target + ' ' + p.unit + ' · ' : '') + Model.schedLabel(Model.parseSched(p.sched), wk()).toLowerCase();
  }
  function emptyHtml() {
    var arch = state.habits.length;
    return '<div class="hb-empty">' +
      '<div class="hb-art" aria-hidden="true">· ▢ ▣ ■ ■ ■ ■</div>' +
      '<p class="hb-lead">Small things, every day.</p>' +
      '<p class="hb-sub">Add a habit, tap it when it’s done and let the streak build. Start from one of these or make your own:</p>' +
      '<div class="hb-presets">' + PRESETS.map(function (p, i) {
        return '<button type="button" class="hb-pre hb-c-' + p.color + '" data-act="preset" data-v="' + i + '">' + chip(p) +
          '<span class="hb-tx"><span class="hb-name">' + esc(p.name) + '</span><span class="hb-meta">' + esc(presetSub(p)) + '</span></span></button>';
      }).join('') + '</div>' +
      '<button type="button" class="hb-btn primary wide" data-act="add">＋ New habit</button>' +
      (arch ? '<p class="hb-sub center">' + plural(arch, 'archived habit') + ' — find ' + (arch === 1 ? 'it' : 'them') + ' under ⚙.</p>' : '') +
    '</div>';
  }

  function todayHtml() {
    var t = P.day, w = wk(), hs = Model.active(state), due = [], rest = [], done = 0;
    if (!hs.length) return emptyHtml();
    hs.forEach(function (h) { var f = Model.info(h, t, w); (f.due ? due : rest).push({ h: h, f: f }); });
    due.forEach(function (x) { if (x.f.done) done++; });
    var html = topHtml(done, due.length);
    html += due.length ? '<div class="hb-list">' + due.map(function (x) { return cardHtml(x, false); }).join('') + '</div>'
      : '<div class="hb-none">Nothing due today — a rest day.</div>';
    if (rest.length) {
      html += '<button type="button" class="hb-rest-tog" data-act="rest" aria-expanded="' + prefs.rest + '"><span class="hb-caret" aria-hidden="true">' + (prefs.rest ? '▾' : '▸') + '</span>Not due today · ' + rest.length + '</button>';
      if (prefs.rest) html += '<div class="hb-list hb-rest">' + rest.map(function (x) { return cardHtml(x, true); }).join('') + '</div>';
    }
    return html + insHtml();
  }

  // ---- detail ----
  function fitWeeks() {
    var m = P.main, w = (m && m.clientWidth) || 380, pad = 24;
    try { var cs = getComputedStyle(m); pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0); } catch (e) {}
    var avail = w - pad - HM_LABEL - 4;
    return Math.max(12, Math.min(26, Math.floor((avail + HM_GAP) / (HM_CELL + HM_GAP))));
  }
  function clampSel() {
    var t = P.day;
    if (!Model.isKey(P.sel) || P.sel > t) P.sel = t;
    if (P.hmFirst && P.sel < P.hmFirst) P.sel = P.hmFirst;
  }
  function pctTxt(r) { return r ? Math.round(r.pct * 100) + '%' : '—'; }
  function statusWord(h, k, st, c) {
    if (h.target > 1) return c + ' / ' + h.target + (h.unit ? ' ' + h.unit : '') + (st === 'd' ? ' · done' : '');
    return { d: 'done', m: 'missed', t: 'not yet', o: h.sched.t === 'n' ? 'not checked in' : 'not scheduled', b: 'before this habit started', p: 'partly' }[st] || '';
  }
  function detailHtml() {
    var h = find(P.detail);
    if (!h) { P.view = 'today'; return todayHtml(); }
    var t = P.day, w = wk(), s = Model.streaks(h, t, w), weeks = fitWeeks(), unit = s.unit === 'w' ? ' wk' : '';
    var hm = Model.heat(h, t, weeks, w), pitch = HM_CELL + HM_GAP, i;
    P.weeks = weeks; P.hmFirst = hm.first;
    clampSel();
    var since = Model.startKey(h) || t, sub = [esc(Model.schedLabel(h.sched, w))];
    if (h.target > 1) sub.push(h.target + (h.unit ? ' ' + esc(h.unit) : '') + ' a day');
    sub.push('since ' + Model.fmtDM(since, since.slice(0, 4) !== t.slice(0, 4)));
    sub.push(plural(Model.totalDone(h), 'check-in'));
    if (h.arch) sub.push('archived');
    var html = '<div class="hb-vhead hb-c-' + h.color + '">' +
      '<button type="button" class="hb-back" data-act="back" aria-label="Back to today" title="Back">‹</button>' + chip(h) +
      '<div class="hb-tx"><span class="hb-name big">' + esc(h.name) + '</span><span class="hb-meta">' + sub.join(' · ') + '</span></div>' +
      '<button type="button" class="hb-ib" data-act="edit" data-id="' + h.id + '" aria-label="Edit habit" title="Edit">✎</button></div>';
    html += '<div class="hb-stats">' +
      '<div class="hb-stat"><b>' + streakHtml(s) + '</b><span>streak</span></div>' +
      '<div class="hb-stat"><b>' + s.best + unit + '</b><span>best</span></div>' +
      '<div class="hb-stat"><b>' + pctTxt(Model.rate(h, t, 7, w)) + '</b><span>7 days</span></div>' +
      '<div class="hb-stat"><b>' + pctTxt(Model.rate(h, t, 30, w)) + '</b><span>30 days</span></div>' +
      '<div class="hb-stat"><b>' + pctTxt(Model.rate(h, t, 90, w)) + '</b><span>90 days</span></div></div>';
    // heatmap
    var mon = hm.months.map(function (m) { return '<span style="left:' + (m.col * pitch) + 'px">' + m.label + '</span>'; }).join('');
    var lab = '';
    for (i = 0; i < 7; i++) { var dd = (w + i) % 7; lab += '<span>' + (dd === 1 || dd === 3 || dd === 5 ? Model.DOW1[dd] : '') + '</span>'; }
    var cells = hm.cells.map(function (c) {
      var fill = c.s === 'p' ? Math.max(15, Math.round(Math.min(1, c.c / h.target) * 100)) : 0;
      return '<i class="s-' + c.s + (c.k === P.sel ? ' sel' : '') + (c.k === t ? ' td' : '') + (h.notes[c.k] ? ' nt' : '') + '"' +
        (fill ? ' style="--f:' + fill + '%"' : '') + (c.s === 'f' ? '' : ' title="' + esc(dayWord(h, c.k, c.s, c.c)) + '"') + '></i>';
    }).join('');
    html += '<div class="hb-hm hb-c-' + h.color + '" style="--weeks:' + weeks + '">' +
      '<div class="hb-hm-mon" aria-hidden="true">' + mon + '</div>' +
      '<div class="hb-hm-body"><div class="hb-hm-lab" aria-hidden="true">' + lab + '</div>' +
      '<div class="hb-hm-grid" data-act="hm" tabindex="0" role="img" aria-label="' + esc(h.name) + ', last ' + weeks + ' weeks. Tap a day to see or fix it; arrow keys move.">' + cells + '</div></div>' +
      '<div class="hb-legend" aria-hidden="true">' +
        (h.sched.t === 'n' ? '<span><i class="s-o"></i>open</span>' : (h.sched.t === 'w' ? '<span><i class="s-o"></i>off</span>' : '') + '<span><i class="s-m"></i>missed</span>') +
        (h.target > 1 ? '<span><i class="s-p" style="--f:50%"></i>part</span>' : '') + '<span><i class="s-d"></i>done</span><span><i class="s-d nt"></i>note</span></div></div>';
    // the selected day
    var k = P.sel, c = Model.count(h, k), st = Model.cellState(h, k, t, since), dn = c >= h.target, note = h.notes[k] || '';
    var ctrl = h.target > 1
      ? '<div class="hb-ctr"><button type="button" class="hb-rbtn" data-act="d-dec" aria-label="Minus ' + h.step + '"' + (c ? '' : ' disabled') + '>−</button>' +
        '<input class="hb-in hb-cin" type="number" inputmode="numeric" min="0" max="99999" step="1" value="' + c + '" aria-label="Count for ' + esc(Model.fmtDay(k)) + '">' +
        '<button type="button" class="hb-rbtn" data-act="d-inc" aria-label="Plus ' + h.step + '">+</button>' +
        '<span class="hb-ctr-of">/ ' + h.target + (h.unit ? ' ' + esc(h.unit) : '') + '</span></div>'
      : '<button type="button" class="hb-tog' + (dn ? ' on' : '') + '" data-act="d-tog" aria-pressed="' + dn + '">' + (dn ? '✓ Done' : 'Mark as done') + '</button>';
    html += '<div class="hb-dayed hb-c-' + h.color + '">' +
      '<div class="hb-dayhd"><button type="button" class="hb-rbtn" data-act="sel" data-v="-1" aria-label="Previous day"' + (k <= hm.first ? ' disabled' : '') + '>‹</button>' +
        '<div class="hb-dayt"><b>' + esc(Model.fmtDay(k, k.slice(0, 4) !== t.slice(0, 4))) + (k === t ? ' · today' : '') + '</b><small>' + esc(statusWord(h, k, st, c)) + '</small></div>' +
        '<button type="button" class="hb-rbtn" data-act="sel" data-v="1" aria-label="Next day"' + (k >= t ? ' disabled' : '') + '>›</button></div>' +
      ctrl +
      '<textarea class="hb-in hb-note" data-k="' + k + '" rows="2" maxlength="' + Model.NOTE_MAX + '" placeholder="Note for ' + esc(Model.fmtDM(k)) + ' (optional)" aria-label="Note for ' + esc(Model.fmtDay(k)) + '">' + esc(note) + '</textarea></div>';
    var nk = Object.keys(h.notes).sort().reverse().slice(0, 6);
    if (nk.length) {
      html += '<div class="hb-sec">Notes</div><div class="hb-notes">' + nk.map(function (d) {
        var txt = h.notes[d].replace(/\s+/g, ' ');
        return '<button type="button" class="hb-nrow' + (d === k ? ' on' : '') + '" data-act="pick" data-k="' + d + '"><span class="hb-nd">' + esc(Model.fmtDM(d)) + '</span><span class="hb-nt">' + esc(txt.length > 140 ? txt.slice(0, 139) + '…' : txt) + '</span></button>';
      }).join('') + '</div>';
    }
    return html;
  }

  // ---- add / edit form ----
  function nextColor() {
    var used = {};
    state.habits.forEach(function (h) { used[h.color] = (used[h.color] || 0) + 1; });
    var best = Model.PALETTE[0];
    Model.PALETTE.forEach(function (c) { if ((used[c] || 0) < (used[best] || 0)) best = c; });
    return best;
  }
  function formFrom(h, preset) {
    var src = h || preset || {}, sc = Model.parseSched(src.sched || 'd'), target = src.target || 1;
    return {
      id: h ? h.id : null, name: src.name || '', icon: src.icon || '', color: src.color || nextColor(),
      sched: sc, days: sc.t === 'w' ? sc.days.slice() : [1, 3, 5], n: sc.t === 'n' ? sc.n : 3,
      goal: target > 1 ? 'count' : 'check', target: target > 1 ? target : 10, step: src.step || 1, unit: src.unit || '', del: false,
    };
  }
  function seg(act, opts, cur) {
    return '<div class="hb-seg" role="group">' + opts.map(function (o) {
      var on = String(o[0]) === String(cur);
      return '<button type="button" class="' + (on ? 'on' : '') + '" data-act="' + act + '" data-v="' + o[0] + '" aria-pressed="' + on + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function editHtml() {
    var f = P.form, h = f.id ? find(f.id) : null, w = wk(), i;
    var html = '<div class="hb-vhead"><button type="button" class="hb-back" data-act="back" aria-label="Back" title="Back">‹</button>' +
      '<div class="hb-tx"><span class="hb-name big">' + (h ? 'Edit habit' : 'New habit') + '</span></div></div>';
    html += '<div class="hb-form hb-c-' + f.color + '">' +
      '<label class="hb-lbl" for="hb-f-name">Name</label>' +
      '<input id="hb-f-name" class="hb-in" data-f="name" maxlength="60" autocomplete="off" enterkeyhint="done" placeholder="e.g. Drink water" value="' + esc(f.name) + '">' +
      '<div class="hb-lbl">Icon</div><div class="hb-icons">' +
        '<input class="hb-in hb-icon-in" data-f="icon" maxlength="16" autocomplete="off" aria-label="Icon — any emoji or character" title="Type any emoji" placeholder="🙂" value="' + esc(f.icon) + '">' +
        ICONS.map(function (ic) { return '<button type="button" class="hb-ic' + (ic === f.icon ? ' on' : '') + '" data-act="f-icon" data-v="' + esc(ic) + '" aria-label="Icon ' + esc(ic) + '">' + esc(ic) + '</button>'; }).join('') +
      '</div>' +
      '<div class="hb-lbl">Colour</div><div class="hb-sw">' + Model.PALETTE.map(function (c) {
        return '<button type="button" class="hb-swb hb-c-' + c + (c === f.color ? ' on' : '') + '" data-act="f-color" data-v="' + c + '" aria-pressed="' + (c === f.color) + '" aria-label="' + COLOR_NAMES[c] + '" title="' + COLOR_NAMES[c] + '"><span></span></button>';
      }).join('') + '</div>' +
      '<div class="hb-lbl">Schedule</div>' + seg('f-sched', [['d', 'Every day'], ['w', 'Some days'], ['n', 'Times a week']], f.sched.t);
    if (f.sched.t === 'w') {
      html += '<div class="hb-days" role="group" aria-label="Days">';
      for (i = 0; i < 7; i++) {
        var d = (w + i) % 7, on = f.days.indexOf(d) !== -1;
        html += '<button type="button" class="' + (on ? 'on' : '') + '" data-act="f-day" data-v="' + d + '" aria-pressed="' + on + '" aria-label="' + Model.DOW[d] + '">' + DAY2[d] + '</button>';
      }
      html += '</div>';
    } else if (f.sched.t === 'n') {
      html += '<div class="hb-stepper"><button type="button" class="hb-rbtn" data-act="f-n" data-v="-1" aria-label="Fewer"' + (f.n <= 1 ? ' disabled' : '') + '>−</button>' +
        '<b>' + f.n + '</b><button type="button" class="hb-rbtn" data-act="f-n" data-v="1" aria-label="More"' + (f.n >= 6 ? ' disabled' : '') + '>+</button>' +
        '<span>time' + (f.n === 1 ? '' : 's') + ' a week, any days</span></div>';
    }
    html += '<div class="hb-lbl">Goal</div>' + seg('f-goal', [['check', 'Check off'], ['count', 'Count up to…']], f.goal);
    if (f.goal === 'count') {
      html += '<div class="hb-goal">' +
        '<label><span>Target</span><input class="hb-in" data-f="target" type="number" inputmode="numeric" min="1" max="' + Model.MAX_TARGET + '" value="' + esc(f.target) + '"></label>' +
        '<label><span>Unit</span><input class="hb-in" data-f="unit" maxlength="16" autocomplete="off" placeholder="glasses, min…" value="' + esc(f.unit) + '"></label>' +
        '<label><span>Per tap</span><input class="hb-in" data-f="step" type="number" inputmode="numeric" min="1" max="' + Model.MAX_TARGET + '" value="' + esc(f.step) + '"></label></div>' +
        '<p class="hb-help">A day counts as done once it reaches the target.' + (h ? ' Changing the target re-scores past days.' : '') + '</p>';
    }
    html += '<div class="hb-fact">' +
      (h ? '<button type="button" class="hb-btn" data-act="f-arch">' + (h.arch ? '↺ Unarchive' : ARCHIVE_SVG + ' Archive') + '</button>' +
        '<button type="button" class="hb-btn danger" data-act="f-del">Delete</button>' : '') +
      '<span class="hb-sp"></span><button type="button" class="hb-btn" data-act="back">Cancel</button>' +
      '<button type="button" class="hb-btn primary" data-act="f-save">' + (h ? 'Save' : 'Add habit') + '</button></div>';
    if (h && f.del) {
      var n = Model.totalDone(h);
      html += '<div class="hb-confirm" role="alert"><p>Delete “' + esc(h.name) + '”' + (n ? ' and its ' + plural(n, 'check-in') : '') + '? This can’t be undone — archiving keeps the history.</p>' +
        '<div class="hb-fact"><span class="hb-sp"></span><button type="button" class="hb-btn" data-act="f-del-no">Keep it</button>' +
        '<button type="button" class="hb-btn danger solid" data-act="f-del-yes">Delete</button></div></div>';
    }
    return html + '</div>';
  }

  // ---- manage + settings ----
  function manageHtml() {
    var act = Model.active(state), arch = state.habits.filter(function (h) { return h.arch; }), w = wk(), ds = state.cfg.ds, i;
    var html = '<div class="hb-vhead"><button type="button" class="hb-back" data-act="back" aria-label="Back to today" title="Back">‹</button>' +
      '<div class="hb-tx"><span class="hb-name big">Habits &amp; settings</span></div></div>';
    if (act.length) {
      html += '<div class="hb-sec">Order <small>drag ⠿ or use the arrows</small></div><div class="hb-mlist">' + act.map(function (h, j) {
        return '<div class="hb-mrow hb-c-' + h.color + '" data-id="' + h.id + '">' +
          '<span class="hb-grip" data-drag="' + h.id + '" title="Drag to reorder" aria-hidden="true">⠿</span>' +
          '<button type="button" class="hb-mname" data-act="edit" data-id="' + h.id + '" title="Edit">' + chip(h) +
            '<span class="hb-tx"><span class="hb-name">' + esc(h.name) + '</span><span class="hb-meta">' + esc(Model.schedLabel(h.sched, w)) + (h.target > 1 ? ' · ' + h.target + (h.unit ? ' ' + esc(h.unit) : '') : '') + '</span></span></button>' +
          '<button type="button" class="hb-ib" data-act="m-up" data-id="' + h.id + '" aria-label="Move ' + esc(h.name) + ' up" title="Move up"' + (j ? '' : ' disabled') + '>↑</button>' +
          '<button type="button" class="hb-ib" data-act="m-down" data-id="' + h.id + '" aria-label="Move ' + esc(h.name) + ' down" title="Move down"' + (j < act.length - 1 ? '' : ' disabled') + '>↓</button>' +
          '<button type="button" class="hb-ib" data-act="m-arch" data-id="' + h.id + '" aria-label="Archive ' + esc(h.name) + '" title="Archive (keeps the history)">' + ARCHIVE_SVG + '</button></div>';
      }).join('') + '</div>';
    } else html += '<div class="hb-none">No active habits.</div>';
    html += '<button type="button" class="hb-btn wide" data-act="add">＋ New habit</button>';
    if (arch.length) {
      html += '<div class="hb-sec">Archived · ' + arch.length + '</div><div class="hb-mlist">' + arch.map(function (h) {
        return '<div class="hb-mrow dim hb-c-' + h.color + '" data-id="' + h.id + '">' +
          '<button type="button" class="hb-mname" data-act="edit" data-id="' + h.id + '" title="Edit or delete">' + chip(h) +
            '<span class="hb-tx"><span class="hb-name">' + esc(h.name) + '</span><span class="hb-meta">' + plural(Model.totalDone(h), 'check-in') + '</span></span></button>' +
          '<button type="button" class="hb-btn" data-act="m-unarch" data-id="' + h.id + '">↺ Restore</button></div>';
      }).join('') + '</div>';
    }
    var opts = '';
    for (i = 0; i <= 12; i++) opts += '<option value="' + i + '"' + (i === ds ? ' selected' : '') + '>' + (i === 0 ? 'Midnight' : i === 12 ? 'Noon' : i + ':00 am') + '</option>';
    var size = JSON.stringify(Model.serialize(state)).length;
    html += '<div class="hb-sec">Settings</div>' +
      '<div class="hb-set"><label for="hb-ds">Day starts at</label><select id="hb-ds" class="hb-in hb-sel" data-cfg="ds">' + opts + '</select></div>' +
      '<p class="hb-help">Check-ins before then count for the day before — handy for night owls.</p>' +
      '<div class="hb-set"><span>Week starts on</span>' + seg('cfg-wk', [['1', 'Monday'], ['0', 'Sunday']], w) + '</div>' +
      '<p class="hb-help">Weeks group “times a week” habits and this week’s summary.</p>' +
      '<p class="hb-help foot">Saved on this device and synced to your other devices when sync is on. History older than two years is trimmed. ' +
        plural(state.habits.length, 'habit') + ' · ' + (size < 1024 ? size + ' B' : (size / 1024).toFixed(1) + ' KB') + '.</p>';
    return html;
  }

  function render() {
    if (!P) return;
    P.dirty = false;
    var t = today();
    if (t !== P.day) { if (P.sel === P.day) P.sel = t; P.day = t; }
    if (P.view === 'edit' && !P.form) P.view = 'today';
    var ae = document.activeElement, fk = ae && ae !== P.main && P.main.contains(ae) ? focusKey(ae) : null;
    var html = P.view === 'detail' ? detailHtml() : P.view === 'edit' ? editHtml() : P.view === 'manage' ? manageHtml() : todayHtml();
    var keep = P.shown === P.view ? P.main.scrollTop : 0;
    P.main.innerHTML = html;
    P.main.scrollTop = keep;
    P.shown = P.view;
    var mg = P.el.querySelector('.hb-hbtn[data-act="manage"]');
    if (mg) mg.classList.toggle('on', P.view === 'manage');
    if (fk) {
      var els = P.main.querySelectorAll('[data-act]');
      for (var i = 0; i < els.length; i++) if (focusKey(els[i]) === fk) { try { els[i].focus({ preventScroll: true }); } catch (e) {} break; }
    }
    var a = P.anim;
    P.anim = null;
    if (a) {
      var el = a.sel ? P.main.querySelector(a.sel) : null;
      if (el && a.cls) el.classList.add(a.cls);
      var sk = a.streak ? P.main.querySelector('.hb-card[data-id="' + a.streak + '"] .hb-streak') : null;
      if (sk) sk.classList.add('bump');
    }
  }
  function focusKey(el) {
    if (!el.getAttribute) return null;
    var act = el.getAttribute('data-act');
    return act ? act + '|' + (el.getAttribute('data-id') || '') + '|' + (el.getAttribute('data-k') || '') + '|' + (el.getAttribute('data-v') || '') : null;
  }
  function go(view) {
    if (!P) return;
    flushNote();
    if (view !== 'edit') P.form = null;
    P.view = view;
    P.ins = false;
    render();
  }

  // ---- actions ------------------------------------------------------------------------------
  // The day rolled over since the list was drawn: redraw instead of acting on a stale "today".
  function staleDay() {
    var t = today();
    if (t === P.day) return false;
    P.day = t;
    render();
    scheduleTick();
    toast('A new day — refreshed', 'info', 1600);
    return true;
  }
  function check(id) {
    var h = find(id);
    if (!h || staleDay()) return;
    var t = P.day, was = Model.isDone(h, t), before = Model.progress(state, t), ns = nowS();
    if (h.target > 1) Model.bump(h, t, 1, ns); else Model.toggleDay(h, t, ns);
    persist();
    var is = Model.isDone(h, t), after = Model.progress(state, t);
    P.anim = { sel: '.hb-card[data-id="' + id + '"] .hb-big', cls: is && !was ? 'pop' : h.target > 1 ? 'tick' : '' };
    if (is && !was) { P.anim.streak = id; haptic(12); } else haptic(6);
    if (after.total && after.done === after.total && before.done < before.total) P.cheer = true;
    render();
  }
  function dec(id) {
    var h = find(id);
    if (!h || staleDay() || !Model.count(h, P.day)) return;
    Model.bump(h, P.day, -1, nowS());
    persist();
    P.anim = { sel: '.hb-card[data-id="' + id + '"] .hb-big', cls: 'tick' };
    haptic(4);
    render();
  }
  function tapDay(id, k) {
    var h = find(id), t = today();
    if (!h || !Model.isKey(k) || k > t) return;
    var on = Model.toggleDay(h, k, nowS());
    persist();
    if (t !== P.day) { P.day = t; scheduleTick(); }
    P.anim = { sel: '.hb-card[data-id="' + id + '"] .hb-d[data-k="' + k + '"]', cls: on ? 'pop' : '' };
    haptic(on ? 10 : 5);
    render();
  }
  function openDetail(id) {
    if (!find(id)) return;
    flushNote();
    P.detail = id; P.sel = P.day = today(); P.hmFirst = null;
    P.view = 'detail'; P.ins = false;
    render();
  }
  function onSel(fn, anim) {
    var h = find(P.detail), k = P.sel;
    if (!h || !Model.isKey(k) || k > today()) return;
    fn(h, k, nowS());
    persist();
    if (anim) P.anim = { sel: anim, cls: 'pop' };
    render();
  }
  function moveSel(d) {
    var k = Model.addDays(P.sel, d);
    if (k > P.day) k = P.day;
    if (P.hmFirst && k < P.hmFirst) k = P.hmFirst;
    if (k === P.sel) return;
    flushNote();
    P.sel = k;
    render();
  }
  function pickHeat(e, grid) {
    var cells = grid.children;
    if (cells.length < 8 || e.detail === 0) return;
    var c0 = cells[0].getBoundingClientRect(), px = cells[7].getBoundingClientRect().left - c0.left, py = cells[1].getBoundingClientRect().top - c0.top;
    if (!(px > 0) || !(py > 0)) return;
    var col = Math.round((e.clientX - c0.left - c0.width / 2) / px), row = Math.round((e.clientY - c0.top - c0.height / 2) / py);
    col = Math.max(0, Math.min(Math.floor(cells.length / 7) - 1, col));
    row = Math.max(0, Math.min(6, row));
    var k = Model.addDays(P.hmFirst, col * 7 + row);
    if (k > P.day) k = P.day;
    if (k === P.sel) return;
    flushNote();
    P.sel = k;
    haptic(4);
    render();
  }
  function openForm(h, preset) {
    flushNote();
    if (!h && state.habits.length >= Model.MAX_HABITS) { toast('That’s ' + Model.MAX_HABITS + ' habits — archive or delete some first', 'error', 2600); return; }
    P.back = P.view === 'detail' || P.view === 'manage' ? P.view : 'today';
    P.form = formFrom(h, preset);
    P.view = 'edit'; P.ins = false;
    render();
    P.main.scrollTop = 0;
    if (!h && !preset && !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) {
      var inp = P.main.querySelector('[data-f="name"]');
      if (inp) inp.focus();
    }
  }
  function formBack() {
    var b = P.back || 'today';
    if (b === 'detail' && !find(P.detail)) b = 'today';
    go(b);
  }
  function saveForm() {
    var f = P.form;
    if (!f) return;
    var name = Model.cleanText(f.name, 60);
    if (!name) {
      toast('Give the habit a name', 'error', 1800);
      var inp = P.main.querySelector('[data-f="name"]');
      if (inp) inp.focus();
      return;
    }
    var count = f.goal === 'count', target = count ? Math.floor(+f.target) : 1, step = count ? Math.floor(+f.step) : 1;
    if (count && !(target >= 1 && target <= Model.MAX_TARGET)) { toast('Set a target between 1 and ' + Model.MAX_TARGET, 'error', 2000); return; }
    if (!(step >= 1)) step = 1;
    if (step > target) step = target;
    var sched = f.sched.t === 'w' ? { t: 'w', days: f.days } : f.sched.t === 'n' ? { t: 'n', n: f.n } : { t: 'd' };
    var fields = { name: name, icon: f.icon, color: f.color, sched: sched, target: target, step: step, unit: count ? f.unit : '' };
    var ns = nowS(), h = f.id ? find(f.id) : null;
    if (f.id && !h) { toast('That habit no longer exists', 'error'); go('today'); return; }
    if (h) {
      Model.updateHabit(h, fields, ns);
      toast('Saved', 'success', 1200);
    } else {
      var top = -1;
      state.habits.forEach(function (x) { if (x.o > top) top = x.o; });
      h = Model.makeHabit(fields, newId(), today(), ns, Math.floor(top) + 1);
      state.habits.push(h);
      toast('Added “' + h.name + '”', 'success', 1400);
    }
    persist();
    if (!f.id) P.back = P.back === 'manage' ? 'manage' : 'today';
    formBack();
  }
  function archive(h, on) {
    Model.setArchived(h, on, nowS());
    persist();
    toast(on ? 'Archived “' + h.name + '” — restore it under ⚙' : 'Restored “' + h.name + '”', 'success', 2000);
  }
  function deleteHabit(h) {
    Model.removeHabit(state, h.id, nowS());
    persist();
    toast('Deleted “' + h.name + '”', 'info', 1800);
    P.back = P.back === 'manage' ? 'manage' : 'today';
    formBack();
  }
  function orderIds(ids) {
    state.habits.forEach(function (h) { if (h.arch) ids.push(h.id); });
    return ids;
  }
  function moveHabit(id, d) {
    var ids = Model.active(state).map(function (h) { return h.id; }), i = ids.indexOf(id), j = i + d;
    if (i < 0 || j < 0 || j >= ids.length) return;
    ids[i] = ids[j]; ids[j] = id;
    Model.setOrder(state, orderIds(ids), nowS());
    persist();
    render();
  }
  function insertSummary(kind) {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
    var t = today(), text = kind === 'week' ? Model.summaryWeek(state, t) : Model.summaryToday(state, t);
    if (!text) { toast(kind === 'week' ? 'No active habits to summarize' : 'Nothing due today to summarize'); return; }
    var doc = ed.state.doc, line = doc.lineAt(ed.state.selection.main.head);
    var prev = line.number > 1 ? doc.line(line.number - 1).text : null, next = line.number < doc.lines ? doc.line(line.number + 1).text : null;
    var plan = Model.insertPlan(line.text, line.from, line.to, prev, next, text);
    ed.dispatch({ changes: { from: plan.from, to: plan.to, insert: plan.insert }, selection: { anchor: plan.from + plan.cursor }, scrollIntoView: true, userEvent: 'input.habits' });
    P.ins = false;
    render();
    toast('Summary inserted — Ctrl+Z to undo', 'success', 1800);
  }

  // ---- notes (saved as you type, debounced) ----
  function flushNote() {
    if (!P) return;
    clearTimeout(P.noteT); P.noteT = 0;
    var d = P.noteDraft;
    P.noteDraft = null;
    var h = d && find(d.id);
    if (h && Model.setNote(h, d.k, d.v, nowS())) persist();
  }
  // After a note loses focus, catch up on a redraw that waited for it — but
  // never between a press and its click (the button would be replaced).
  function deferRender(tries) {
    clearTimeout(P.deferT);
    P.deferT = setTimeout(function () {
      if (!P || !P.dirty || noteFocused() || isMin() || P.view === 'edit') return;
      if (P.ptr && (tries || 0) < 10) { deferRender((tries || 0) + 1); return; }
      render();
    }, 300);
  }

  // ---- events --------------------------------------------------------------------------------
  function onClick(e) {
    if (!P) return;
    var b = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b || !P.el.contains(b) || b.disabled) return;
    var act = b.getAttribute('data-act'), id = b.getAttribute('data-id'), v = b.getAttribute('data-v'), f = P.form, h;
    switch (act) {
      case 'check': check(id); break;
      case 'dec': dec(id); break;
      case 'day': tapDay(id, b.getAttribute('data-k')); break;
      case 'open': openDetail(id); break;
      case 'back': if (P.view === 'edit') formBack(); else go('today'); break;
      case 'add': openForm(null); break;
      case 'manage': go(P.view === 'manage' ? 'today' : 'manage'); break;
      case 'edit': if ((h = find(id))) openForm(h); break;
      case 'preset': openForm(null, PRESETS[+v]); break;
      case 'rest': prefs.rest = !prefs.rest; savePrefs(); render(); break;
      case 'ins-open': P.ins = true; render(); break;
      case 'ins-x': P.ins = false; render(); break;
      case 'ins': insertSummary(v); break;
      // detail
      case 'hm': pickHeat(e, b); break;
      case 'sel': moveSel(+v); break;
      case 'pick': flushNote(); P.sel = b.getAttribute('data-k'); render(); break;
      case 'd-tog': onSel(function (hh, k, ns) { Model.toggleDay(hh, k, ns); }, Model.isDone(find(P.detail) || { log: {}, target: 1 }, P.sel) ? null : '.hb-tog'); haptic(8); break;
      case 'd-dec': onSel(function (hh, k, ns) { Model.bump(hh, k, -1, ns); }); break;
      case 'd-inc': onSel(function (hh, k, ns) { Model.bump(hh, k, 1, ns); }); haptic(6); break;
      // form
      case 'f-icon': if (f) { f.icon = v; render(); } break;
      case 'f-color': if (f) { f.color = v; render(); } break;
      case 'f-sched': if (f) { f.sched = { t: v }; render(); } break;
      case 'f-day':
        if (f) {
          var d = +v, at = f.days.indexOf(d);
          if (at === -1) f.days.push(d); else if (f.days.length > 1) f.days.splice(at, 1);
          else { toast('Pick at least one day'); break; }
          f.days.sort(function (x, y) { return x - y; });
          render();
        }
        break;
      case 'f-n': if (f) { f.n = Math.max(1, Math.min(6, f.n + (+v))); render(); } break;
      case 'f-goal': if (f) { f.goal = v; render(); } break;
      case 'f-save': saveForm(); break;
      case 'f-arch': if (f && (h = find(f.id))) { archive(h, !h.arch); formBack(); } break;
      case 'f-del': if (f) { f.del = true; render(); var cf = P.main.querySelector('.hb-confirm'); if (cf && cf.scrollIntoView) cf.scrollIntoView({ block: 'nearest' }); } break;
      case 'f-del-no': if (f) { f.del = false; render(); } break;
      case 'f-del-yes': if (f && (h = find(f.id))) deleteHabit(h); break;
      // manage
      case 'm-up': moveHabit(id, -1); break;
      case 'm-down': moveHabit(id, 1); break;
      case 'm-arch': if ((h = find(id))) { archive(h, true); render(); } break;
      case 'm-unarch': if ((h = find(id))) { archive(h, false); render(); } break;
      case 'cfg-wk': Model.setCfg(state, { wk: +v }, nowS()); persist(); render(); break;
    }
  }
  function onInput(e) {
    var t = e.target, f = P && P.form, k;
    if (!P) return;
    if (f && (k = t.getAttribute('data-f'))) {
      f[k] = t.value;
      if (k === 'icon') {
        var ics = P.main.querySelectorAll('.hb-ic');
        for (var i = 0; i < ics.length; i++) ics[i].classList.toggle('on', ics[i].getAttribute('data-v') === t.value.trim());
      }
    } else if (t.classList.contains('hb-note')) {
      P.noteDraft = { id: P.detail, k: t.getAttribute('data-k'), v: t.value };
      clearTimeout(P.noteT);
      P.noteT = setTimeout(flushNote, 700);
    }
  }
  function onChange(e) {
    var t = e.target;
    if (!P) return;
    if (t.classList.contains('hb-cin')) {
      var v = Math.max(0, Math.floor(+t.value) || 0);
      onSel(function (hh, k, ns) { Model.setCount(hh, k, v, ns); });
    } else if (t.getAttribute('data-cfg') === 'ds') {
      Model.setCfg(state, { ds: +t.value }, nowS());
      persist();
      P.day = today();
      scheduleTick();
      render();
    }
  }
  function onFocusOut(e) {
    if (P && e.target.classList && e.target.classList.contains('hb-note')) {
      flushNote();
      if (P.dirty) deferRender(0);
    }
  }
  function onKey(e) {
    if (!P || isMin()) return; // parked in the dock: keys belong to the editor
    var t = e.target, tag = t.tagName, k = e.key;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      e.stopPropagation(); // typing here must not reach the editor's shortcuts
      if (k === 'Enter' && tag === 'INPUT' && !e.isComposing) {
        e.preventDefault();
        if (t.classList.contains('hb-cin')) t.blur();
        else if (P.view === 'edit') saveForm();
      } else if (k === 'Escape') { e.preventDefault(); t.blur(); }
      return;
    }
    if (t.classList && t.classList.contains('hb-hm-grid')) {
      var mv = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[k];
      if (mv) { e.preventDefault(); e.stopPropagation(); moveSel(mv); return; }
      if (k === 'Enter' || k === ' ') {
        e.preventDefault(); e.stopPropagation();
        var hh = find(P.detail);
        if (hh) onSel(function (x, d, ns) { if (x.target > 1) Model.bump(x, d, 1, ns); else Model.toggleDay(x, d, ns); });
        return;
      }
    }
    if (k === 'Escape' && P.view !== 'today') {
      e.preventDefault(); e.stopPropagation();
      if (P.view === 'edit') formBack(); else go('today');
    }
  }

  // ---- drag to reorder (manage view): the grip captures the pointer ----
  function onPointerDown(e) {
    if (!P) return;
    P.ptr = true;
    var g = e.target && e.target.closest ? e.target.closest('[data-drag]') : null;
    if (!g || P.view !== 'manage' || P.drag || (e.button && e.button !== 0)) return;
    var row = g.closest('.hb-mrow'), list = row && row.parentNode;
    if (!list) return;
    e.preventDefault();
    var rows = [].slice.call(list.querySelectorAll('.hb-mrow')), from = rows.indexOf(row);
    var pitch = rows.length > 1 ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top : row.offsetHeight;
    P.drag = { g: g, row: row, rows: rows, from: from, to: from, y0: e.clientY, s0: P.main.scrollTop, pitch: pitch || 48, pid: e.pointerId };
    try { g.setPointerCapture(e.pointerId); } catch (x) {}
    row.classList.add('lift');
    P.el.classList.add('hb-dragging');
    g.addEventListener('pointermove', onDragMove);
    g.addEventListener('pointerup', onDragEnd);
    g.addEventListener('pointercancel', onDragEnd);
    haptic(8);
  }
  function onPointerUp() { if (P) P.ptr = false; }
  function onDragMove(e) {
    var d = P && P.drag;
    if (!d || e.pointerId !== d.pid) return;
    e.preventDefault();
    var mr = P.main.getBoundingClientRect();
    if (e.clientY < mr.top + 28) P.main.scrollTop -= 8;
    else if (e.clientY > mr.bottom - 28) P.main.scrollTop += 8;
    var dy = e.clientY - d.y0 + (P.main.scrollTop - d.s0);
    var to = Math.max(0, Math.min(d.rows.length - 1, d.from + Math.round(dy / d.pitch)));
    d.row.style.transform = 'translateY(' + dy + 'px)';
    if (to === d.to) return;
    d.to = to;
    d.rows.forEach(function (r, i) {
      if (r === d.row) return;
      var s = d.from < to && i > d.from && i <= to ? -d.pitch : to < d.from && i >= to && i < d.from ? d.pitch : 0;
      r.style.transform = s ? 'translateY(' + s + 'px)' : '';
    });
    haptic(4);
  }
  function endDrag() {
    var d = P && P.drag;
    if (!d) return null;
    P.drag = null;
    d.g.removeEventListener('pointermove', onDragMove);
    d.g.removeEventListener('pointerup', onDragEnd);
    d.g.removeEventListener('pointercancel', onDragEnd);
    try { d.g.releasePointerCapture(d.pid); } catch (x) {}
    P.el.classList.remove('hb-dragging');
    return d;
  }
  function onDragEnd(e) {
    var d = endDrag();
    if (!d) return;
    P.ptr = false;
    if (e.type === 'pointerup' && d.to !== d.from) {
      var ids = d.rows.map(function (r) { return r.getAttribute('data-id'); });
      ids.splice(d.to, 0, ids.splice(d.from, 1)[0]);
      Model.setOrder(state, orderIds(ids), nowS());
      persist();
    }
    render();
  }

  // ---- day rollover, visibility, minimize ------------------------------------------------------
  // One timeout to the next day boundary, only while the panel is open, shown and the page visible.
  function scheduleTick() {
    if (!P) return;
    clearTimeout(P.tick); P.tick = 0;
    if (document.hidden || isMin()) return;
    var ms = Model.nextBoundary(new Date(), state.cfg.ds).getTime() - Date.now() + 1000;
    P.tick = setTimeout(onTick, Math.max(1000, Math.min(ms, 6 * 3600e3))); // re-checks every 6 h at most (clock / zone changes)
  }
  function onTick() {
    if (!P) return;
    P.tick = 0;
    wake();
  }
  function wake() {
    if (!P || document.hidden || isMin()) return;
    var t = today();
    if (t !== P.day) {
      if (P.view === 'detail' && P.sel === P.day) P.sel = t;
      P.day = t;
      P.dirty = true;
    }
    if (P.dirty && !(P.view === 'edit' || noteFocused() || P.drag)) render();
    scheduleTick();
  }
  function onVis() {
    if (!P) return;
    if (document.hidden) { clearTimeout(P.tick); P.tick = 0; flushNote(); }
    else wake();
  }
  function onMinimize() {
    if (!P) return;
    clearTimeout(P.tick); P.tick = 0;
    flushNote();
    if (P.drag) { endDrag(); P.dirty = true; }
    if (P.ins) { P.ins = false; P.dirty = true; }
  }
  function onRestore() { wake(); }
  function onResize() {
    if (!P || isMin() || P.view !== 'detail') return;
    clearTimeout(P.resizeT);
    P.resizeT = setTimeout(function () {
      if (P && P.view === 'detail' && !noteFocused() && fitWeeks() !== P.weeks) render();
    }, 200);
  }

  // ---- open / close ------------------------------------------------------------------------------
  function cleanup() {
    if (!P) return;
    flushNote();
    endDrag();
    clearTimeout(P.tick); clearTimeout(P.noteT); clearTimeout(P.resizeT); clearTimeout(P.deferT);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('resize', onResize);
    P = null;
  }
  function close() {
    var el = document.getElementById(PANEL_ID);
    if (el) el.remove();
    cleanup();
  }
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    if (!state) load();
    loadPrefs();
    var el = Cade.mkPanel(PANEL_ID, TITLE, '<div class="hb-main"></div>');
    var tools = document.createElement('div');
    tools.className = 'hb-tools';
    tools.innerHTML = '<button type="button" class="hb-hbtn" data-act="add" title="New habit" aria-label="New habit">＋</button>' +
      '<button type="button" class="hb-hbtn" data-act="manage" title="Manage habits &amp; settings" aria-label="Manage habits and settings">⚙</button>';
    var head = el.querySelector('.cade-panel-head');
    if (head) head.insertBefore(tools, el.querySelector('.cade-panel-minbtn') || el.querySelector('.cade-panel-x'));
    // The header drags the panel; these are controls, not a handle.
    tools.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    P = {
      el: el, main: el.querySelector('.hb-main'), view: 'today', shown: '', day: today(), sel: '', detail: null, form: null, back: 'today',
      weeks: 0, hmFirst: null, ins: false, anim: null, cheer: false, dirty: false, drag: null, ptr: false,
      tick: 0, noteT: 0, noteDraft: null, resizeT: 0, deferT: 0,
    };
    el._onClose = cleanup;
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('focusout', onFocusOut);
    el.addEventListener('keydown', onKey);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('cade-panel-minimize', onMinimize);
    el.addEventListener('cade-panel-restore', onRestore);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('resize', onResize);
    render();
    scheduleTick();
  }

  Cade.registerWidget({
    name: 'Habit Tracker',
    description: 'Daily habits with streaks, a week strip and a heatmap — check-offs or counters, any schedule; synced across your devices',
    icon: '🔥',
    tags: 'habit,habits,habit tracker,tracker,streak,streaks,daily,routine,goals,check in,checklist,heatmap,water,exercise,meditate,read,self improvement,consistency',
    open: open,
    close: close,
  });
})();
