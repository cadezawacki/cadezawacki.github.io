/* Digest & Todo — core model. Pure string-in / string-out: no DOM, no Cade.
 * window.__cadeDigestCore in the browser, module.exports in node
 * (digest.test.js). digest.js does everything that touches the editor, the
 * rooms and the screen.
 *
 * ---- What goes in: the digest format -------------------------------------
 * Text typed in the digest room, or in any room under an "@digest" line.
 * Groups are case-insensitive (trimmed, whitespace collapsed, written upper
 * case); anything without one lands in [ UNCATEGORIZED ].
 *
 *   group headers   group:   group -   [group]   [ group ]   # group
 *                   **group**   == group ==   -- group   >> group
 *                   GROUP (all caps)   group + "====" underline
 *                   a bare "group" line followed by entries — see below
 *   entries         - entry   * entry   + entry   • entry   1. entry
 *                   [ ] entry   [x] done   - [ ] entry   ☐ entry   ✓ done
 *                   a bare line
 *   tags            ¥tag  #tag  (#tag is rewritten with the tag sentinel)
 *
 * THE KEY RULE: a group title is a line followed — on the very next line — by
 * entries. A bare line is a title when an entry with a list marker follows it
 * ("groceries" / "- milk"), when the next line is indented under it, or when
 * it opens a paragraph of bare lines ("GROUP" / "entry 1" / "entry 2"). A
 * bare line on its own is an entry. A header covers its paragraph — down to
 * the next blank line — and a header standing alone covers the paragraph
 * after it ("[ WORK ]", a blank line, the list); past that, an entry with no
 * header of its own is UNCATEGORIZED (a blank line starts a new thought). An
 * ALL-CAPS line nothing follows was an entry after all ("CALL IRS").
 * Indented entries nest (up to 3 deep).
 *
 * @digest blocks: the directive line (optionally with content after it,
 * "@digest groceries:"), then every line down to the end of the document, a
 * second blank line in a row, a ``` fence, the next @digest, an "@end" line,
 * or — after a blank line — anything but a marked entry or a [group] /
 * group: / group - header (so the prose, or the # heading, that follows a
 * list stays put).
 *
 * ---- What comes out: the todo room ---------------------------------------
 *   [ GROCERIES ]
 *   [ ] milk ¥errand (2026-11-04 14:32 · Home › digest)
 *       [ ] oat if they have it (2026-11-04 14:32 · Home › digest)
 *   [x] eggs (2026-11-04 14:32 · Home › digest · ✓ 2026-11-05 09:12)
 *
 * The suffix records when an entry was digested, from which workspace › room,
 * and when it was checked off. It starts with a full "YYYY-MM-DD HH:MM" (or
 * "✓ YYYY-MM-DD HH:MM"), so a parenthesised aside in the text — "(bring the
 * receipt)", "(2026-11-04)" — is never mistaken for it. Markdown headings and
 * "- [ ]" lines in a todo room someone already had are read too; new entries
 * copy the style of the section they join.
 */
(function () {
  'use strict';

  var YEN = '\u00a5';
  var SENTINELS = ['\u00a5', '\u20ac', '\u00a7', '@', '#'];   // the core's TAG_SENTINELS
  var UNCAT = 'UNCATEGORIZED';
  var DOT = ' \u00b7 ';            // " · "  between metadata fields
  var ARROW = ' \u203a ';          // " › "  workspace › room
  var CHECK = '\u2713';            // ✓
  var UNIT = '    ';               // the core's indent unit
  var MAX_DEPTH = 3;

  var STRIKE_G = /\u0336/g;        // the core's done-toggle strikes text through with U+0336
  var STRIKE_1 = /\u0336/;
  var BLANK_RE = /^[ \t]*$/;
  var FENCE_RE = /^[ \t]*(?:`{3,}|~{3,})/;
  // A line with no letter, digit or script character (only "#", "*", "✓"…) carries nothing.
  var CONTENT_RE = /[A-Za-z0-9\u00c0-\u1fff\u2c00-\uffff]/;
  var URL_ONLY_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*$/i;

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---- small utils ------------------------------------------------------------
  function str(s) { return s == null ? '' : String(s); }
  function isBlank(s) { return BLANK_RE.test(s); }
  function unstrike(s) { return str(s).replace(STRIKE_G, ''); }
  function splitLines(text) { return str(text).replace(/\r\n?/g, '\n').split('\n'); }
  function repeat(s, n) { var out = ''; for (var i = 0; i < n; i++) out += s; return out; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function clone(o) { return o ? JSON.parse(JSON.stringify(o)) : o; }
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
  function validSentinel(s) { return SENTINELS.indexOf(s) >= 0 ? s : YEN; }

  // ---- time ----------------------------------------------------------------------
  var DT_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/;
  function stamp(d) {
    d = d instanceof Date ? d : new Date(d == null ? Date.now() : d);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  // "2026-11-04 9:05" → "2026-11-04 09:05" so stamps sort as strings; '' if it isn't one.
  function normStamp(s) {
    var m = DT_RE.exec(str(s).trim());
    return m ? m[1] + '-' + m[2] + '-' + m[3] + ' ' + pad2(+m[4]) + ':' + m[5] : '';
  }
  function parseStamp(s) {
    var m = DT_RE.exec(str(s).trim());
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    return isNaN(d.getTime()) ? null : d;
  }
  // A short label ("now", "5m", "3h", "yesterday", "Mon", "Nov 4", "2025-11-04")
  // and a bucket for the "Added" filter.
  function when(at, now) {
    var d = parseStamp(at);
    if (!d) return { label: '', bucket: '', days: -1 };
    now = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    var day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var dd = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var days = Math.round((day0 - dd) / 86400000);
    var mins = Math.round((now.getTime() - d.getTime()) / 60000);
    if (days <= 0) {
      return { label: mins < 1 ? 'now' : mins < 60 ? mins + 'm' : Math.floor(mins / 60) + 'h', bucket: 'today', days: 0 };
    }
    if (days === 1) return { label: 'yesterday', bucket: 'yesterday', days: 1 };
    if (days < 7) return { label: DAYS[d.getDay()], bucket: 'week', days: days };
    var label = d.getFullYear() === now.getFullYear() ? MONTHS[d.getMonth()] + ' ' + d.getDate() : stamp(d).slice(0, 10);
    return { label: label, bucket: days <= 30 ? 'month' : 'older', days: days };
  }

  // ---- tags ------------------------------------------------------------------------
  // (boundary)(sigil)(name) — the core's grammar: the name starts alphanumeric,
  // may nest with '/' or '-', and a trailing '/' or '-' isn't part of it. ¥ and
  // # are tags here (the two the digest format names) plus the user's own
  // sentinel. '#' needs a LETTER first, so "#123" (an issue number) and "C#"
  // stay text. Tags inside URLs and `code` don't count.
  var URL_G = /(?:https?:\/\/|www\.)[^\s<>()\[\]]+/g;
  var CODE_G = /`[^`\n]*`/g;
  var _tagReCache = {};
  function tagRe(sentinel) {
    var s = validSentinel(sentinel);
    if (!_tagReCache[s]) {
      var sig = [YEN, '#'];
      if (sig.indexOf(s) < 0) sig.push(s);
      _tagReCache[s] = new RegExp('(^|[^A-Za-z0-9_&/:' + escRe(SENTINELS.join('')) + '])(' + sig.map(escRe).join('|') + ')([A-Za-z0-9_][A-Za-z0-9_/-]{0,63})', 'g');
    }
    var re = _tagReCache[s];
    re.lastIndex = 0;
    return re;
  }
  function skipRanges(t) {
    var out = [], m;
    URL_G.lastIndex = 0;
    while ((m = URL_G.exec(t)) !== null) out.push([m.index, m.index + m[0].length]);
    CODE_G.lastIndex = 0;
    while ((m = CODE_G.exec(t)) !== null) out.push([m.index, m.index + m[0].length]);
    return out;
  }
  function inRanges(rs, i) {
    for (var k = 0; k < rs.length; k++) if (i >= rs[k][0] && i < rs[k][1]) return true;
    return false;
  }
  function findTags(text, sentinel) {
    var t = str(text), out = [];
    if (!t || t.length > 4000) return out;
    var re = tagRe(sentinel), skip = null, m;
    while ((m = re.exec(t)) !== null) {
      var start = m.index + m[1].length, sig = m[2], name = m[3].replace(/[\/-]+$/, '');
      if (!name || (sig === '#' && !/^[A-Za-z]/.test(name))) continue;
      if (!skip) skip = skipRanges(t);
      if (inRanges(skip, start)) continue;
      out.push({ start: start, end: start + sig.length + name.length, sigil: sig, name: name });
    }
    return out;
  }
  function tagNames(text, sentinel) {
    var seen = {}, out = [];
    findTags(text, sentinel).forEach(function (g) {
      var k = g.name.toLowerCase();
      if (!seen[k]) { seen[k] = 1; out.push(k); }
    });
    return out;
  }
  // Every ¥ / # tag rewritten with the user's sentinel, so a digested "#errand"
  // lands as "¥errand" — a real in-document tag the core badges and Ctrl+P finds.
  function normalizeTags(text, sentinel) {
    var s = validSentinel(sentinel), t = str(text), tags = findTags(t, s);
    for (var i = tags.length - 1; i >= 0; i--) {
      var g = tags[i];
      if (g.sigil !== s) t = t.slice(0, g.start) + s + t.slice(g.start + g.sigil.length);
    }
    return t;
  }

  // ---- names ---------------------------------------------------------------------------
  function normGroup(s) {
    var t = unstrike(s).replace(/\s+/g, ' ').trim();
    return t ? t.toUpperCase().slice(0, 80) : '';
  }
  function headName(s) {
    var t = unstrike(s).replace(/^[\s:\-\u2013\u2014*_=>\u00bb]+/, '').replace(/[\s:\-\u2013\u2014*_=]+$/, '');
    return normGroup(t) || null;
  }
  // Two entries are "the same" when their text matches ignoring case, spacing,
  // strike-through and which tag sigil was used.
  function itemKey(text, sentinel) {
    return normalizeTags(unstrike(text), sentinel).toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function cleanField(s) {
    return str(s).replace(/[\r\n]+/g, ' ').replace(/\u00b7/g, '-').replace(/\u203a/g, '>').replace(/\s+/g, ' ').trim();
  }

  // ---- the digest format: one line ---------------------------------------------------
  var DIRECTIVE_RE = /^[ \t]*@digest(?=$|[ \t]|:(?:$|[ \t]))[ \t]*:?[ \t]*(.*)$/i;
  var END_RE = /^[ \t]*@(?:end|enddigest|end-digest|\/digest)[ \t]*$/i;
  var RULE_RE = /^[ \t]*([-=_*~])(?:[ \t]*\1){2,}[ \t]*$/;
  var BOX_RE = /^([ \t]*)(?:(?:[-*+\u2022\u00b7\u2023\u25e6\u25aa>]|\d{1,3}[.)])[ \t]+)?\[([ xX\u2713\u2714])\][ \t]*(.*)$/;
  var GLYPH_RE = /^([ \t]*)([\u2610\u2611\u2612\u2713\u2714\u2705\u25a1\u25a2\u25cb])[ \t]*(.*)$/;
  var DONE_GLYPHS = '\u2611\u2612\u2713\u2714\u2705';
  var BULLET_RE = /^([ \t]*)([-*+\u2022\u00b7\u2023\u25e6\u25aa\u25b8\u25ba\u2192\u27a4\u2013\u2014]|\d{1,3}[.)])[ \t]+(.*)$/;
  var BRACKET_HEAD_RE = /^[ \t]*[\[\u3010]([^\[\]\u3010\u3011]*)[\]\u3011][ \t]*:?[ \t]*$/;
  var MD_HEAD_RE = /^[ \t]*#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/;
  var WRAP_HEAD_RE = /^[ \t]*(\*{2,}|_{2,}|={2,}|-{2,})[ \t]*(.+?)[ \t]*\1[ \t]*:?[ \t]*$/;
  var LEAD_HEAD_RE = /^[ \t]*(?:={2,}|-{2,}|>{2,}|\u00bb)[ \t]*(.+?)[ \t]*$/;
  var COLON_HEAD_RE = /^[ \t]*(?:(?:[-*+\u2022]|\d{1,3}[.)])[ \t]+)?(.+?)[ \t]*:[ \t]*$/;
  var DASH_HEAD_RE = /^[ \t]*(.+?)(?:[ \t]+-+|[ \t]*[\u2013\u2014]+)[ \t]*$/;

  // \u2192 { name, style } | null. style: bracket | md | wrap | lead | colon | dash
  function strongHead(line) {
    var m, n;
    function hit(name, style) { return name ? { name: name, style: style } : null; }
    if ((m = BRACKET_HEAD_RE.exec(line))) {
      if (/^[ xX\u2713\u2714]?$/.test(m[1])) return null;     // "[ ]" / "[x]": an empty checkbox
      return hit(headName(m[1]), 'bracket');
    }
    if ((m = MD_HEAD_RE.exec(line))) return hit(headName(m[1]), 'md');
    var bullet = BULLET_RE.test(line);
    if (!bullet && (m = WRAP_HEAD_RE.exec(line)) && (n = headName(m[2]))) return hit(n, 'wrap');
    if (!bullet && (m = LEAD_HEAD_RE.exec(line)) && (n = headName(m[1]))) return hit(n, 'lead');
    if ((m = COLON_HEAD_RE.exec(line)) && (n = headName(m[1]))) return hit(n, 'colon');
    if (!bullet && (m = DASH_HEAD_RE.exec(line)) && (n = headName(m[1]))) return hit(n, 'dash');
    return null;
  }
  function isCaps(t) {
    if (t.length > 60 || /:\/\//.test(t)) return false;
    var letters = t.replace(/[^A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff]/g, '');
    return letters.length >= 2 && t === t.toUpperCase() && t !== t.toLowerCase();
  }

  // kind: blank | rule | directive | end | head (strong / weak) | entry (marked) | plain
  function classify(raw) {
    var line = unstrike(raw), m;
    if (isBlank(line)) return { kind: 'blank' };
    var ind = indentWidth(line);
    if ((m = DIRECTIVE_RE.exec(line))) return { kind: 'directive', indent: ind, inline: m[1] };
    if (END_RE.test(line)) return { kind: 'end' };
    if (RULE_RE.test(line)) return { kind: 'rule', underline: /^[ \t]*[=-]/.test(line) };
    if (!CONTENT_RE.test(line)) return { kind: 'rule', underline: false };
    if ((m = BOX_RE.exec(line))) return { kind: 'entry', indent: ind, text: m[3], done: m[2] !== ' ', marked: true };
    if ((m = GLYPH_RE.exec(line)) && CONTENT_RE.test(m[3])) return { kind: 'entry', indent: ind, text: m[3], done: DONE_GLYPHS.indexOf(m[2]) >= 0, marked: true };
    var h = strongHead(line);
    if (h) return { kind: 'head', strong: true, name: h.name, style: h.style, indent: ind };
    if ((m = BULLET_RE.exec(line))) return { kind: 'entry', indent: ind, text: m[3], done: false, marked: true };
    var t = line.trim();
    if (isCaps(t)) return { kind: 'head', strong: false, name: normGroup(t), text: t, style: 'caps', indent: ind };
    return { kind: 'plain', indent: ind, text: t };
  }
  // After a blank line an @digest block goes on only for a marked entry or a
  // digest-style header ([group], group:, group -). A Markdown heading or an
  // ALL-CAPS line there is far more likely the document's own next section.
  var CONTINUE_STYLES = { bracket: 1, colon: 1, dash: 1 };
  function continuesBlock(raw) {
    var c = classify(raw);
    return c.kind === 'entry' || (c.kind === 'head' && !!CONTINUE_STYLES[c.style]);
  }

  // ---- the digest format: a run of lines -------------------------------------------
  // → { entries: [{group, depth, done, text, src}], groups: [names, in order],
  //     marks: [{i, kind: 'head' | 'entry', group, implicit?, depth?}] }   (i / src: index into L)
  function parseLines(L) {
    var C = L.map(classify), R = new Array(C.length);
    var sticky = '', stickyCount = 0;           // a marked header carries on past blank lines
    var weak = -1, weakPrev = '', weakPrevCount = 0;
    var i = 0, j, k;

    // An ALL-CAPS header that nothing followed was an entry ("CALL IRS").
    function settleWeak() {
      if (weak < 0) return;
      if (stickyCount === 0) {
        R[weak] = { role: 'entry', group: weakPrev || UNCAT, text: C[weak].text, indent: C[weak].indent, done: false };
        sticky = weakPrev;
        stickyCount = weakPrevCount + 1;
      }
      weak = -1;
    }

    while (i < C.length) {
      var c = C[i];
      if (c.kind !== 'head' && c.kind !== 'entry' && c.kind !== 'plain') { R[i] = { role: 'skip' }; i++; continue; }
      for (j = i; j < C.length && (C[j].kind === 'head' || C[j].kind === 'entry' || C[j].kind === 'plain');) j++;
      // "Groceries" over a "=====" / "-----" underline is a header.
      if (j < C.length && C[j].kind === 'rule' && C[j].underline) {
        var u = C[j - 1];
        if (u.kind === 'plain' || (u.kind === 'head' && !u.strong)) {
          var nm = normGroup(u.text);
          if (nm) C[j - 1] = { kind: 'head', strong: true, name: nm, style: 'setext', indent: u.indent };
        }
      }
      var paraGroup = '';
      var waiting = !!sticky && stickyCount === 0;          // a header above is still waiting for entries
      for (k = i; k < j; k++) {
        var x = C[k];
        if (x.kind === 'head') {
          settleWeak();
          paraGroup = '';
          if (!x.strong) { weak = k; weakPrev = sticky; weakPrevCount = stickyCount; }
          sticky = x.name;
          stickyCount = 0;
          R[k] = { role: 'head', group: x.name, strong: !!x.strong };
          continue;
        }
        if (x.kind === 'plain') {
          var nx = k + 1 < j ? C[k + 1] : null;
          var title = !!nx && !URL_ONLY_RE.test(x.text) && (
            nx.kind === 'entry' ||
            (nx.kind !== 'head' && nx.indent > x.indent) ||
            (k === i && nx.kind === 'plain' && !waiting));
          if (title) {
            var tn = normGroup(x.text);
            if (tn) {
              settleWeak();
              paraGroup = tn;
              R[k] = { role: 'head', group: tn, implicit: true };
              continue;
            }
          }
        }
        R[k] = { role: 'entry', group: paraGroup || sticky || UNCAT, text: x.text, indent: x.indent, done: !!x.done };
        if (!paraGroup) {
          if (sticky) stickyCount++;
          weak = -1;                                  // the weak header got its entry: a real header
        }
      }
      // A blank line ends a header's reach — unless nothing came under it yet
      // ("[ WORK ]", a blank line, then the list).
      if (sticky && stickyCount > 0) { sticky = ''; stickyCount = 0; }
      i = j;
    }
    settleWeak();

    var entries = [], marks = [], groups = [], seen = {}, stack = [], lastGroup = null;
    for (var n = 0; n < R.length; n++) {
      var r = R[n];
      if (!r || r.role === 'skip') continue;
      if (!seen[r.group]) { seen[r.group] = 1; groups.push(r.group); }
      if (r.role === 'head') {
        marks.push({ i: n, kind: 'head', group: r.group, implicit: !!r.implicit, strong: !!r.strong });
        stack = [];
        lastGroup = r.group;
        continue;
      }
      if (r.group !== lastGroup) { stack = []; lastGroup = r.group; }
      while (stack.length && stack[stack.length - 1] >= r.indent) stack.pop();
      var depth = Math.min(stack.length, MAX_DEPTH);
      stack.push(r.indent);
      var text = str(r.text).trim();
      if (!text) continue;
      entries.push({ group: r.group, depth: depth, done: !!r.done, text: text, src: n });
      marks.push({ i: n, kind: 'entry', group: r.group, depth: depth });
    }
    return { entries: entries, groups: groups, marks: marks };
  }

  // ---- @digest blocks ----------------------------------------------------------------
  // → [{ start, last (last content line), end (last line taken, @end included), endMarker, inline }]
  function findBlocks(L) {
    var out = [], inFence = false;
    for (var i = 0; i < L.length; i++) {
      var t = L[i];
      if (FENCE_RE.test(t)) { inFence = !inFence; continue; }
      if (inFence) continue;
      var d = DIRECTIVE_RE.exec(unstrike(t));
      if (!d) continue;
      var b = { start: i, last: i, end: i, endMarker: -1, inline: d[1].trim() };
      var blanks = 0;
      for (var j = i + 1; j < L.length; j++) {
        var u = L[j];
        if (FENCE_RE.test(u) || DIRECTIVE_RE.test(unstrike(u))) break;
        if (END_RE.test(u)) { b.endMarker = j; break; }
        if (isBlank(u)) { if (++blanks >= 2) break; continue; }
        if (blanks && !continuesBlock(u)) break;
        blanks = 0;
        b.last = j;
      }
      b.end = b.endMarker >= 0 ? b.endMarker : b.last;
      out.push(b);
      i = b.end;
    }
    return out;
  }
  function hasDirective(text) { return /@digest/i.test(str(text)) && findBlocks(splitLines(text)).length > 0; }

  // Drop the removed lines (null) without leaving two blank lines — or a
  // leading / trailing blank — where they were.
  function joinKept(keep) {
    var out = [], seam = false;
    for (var i = 0; i < keep.length; i++) {
      var t = keep[i];
      if (t === null) { seam = true; continue; }
      if (seam) {
        seam = false;
        if (isBlank(t) && (!out.length || isBlank(out[out.length - 1]))) continue;
      }
      out.push(t);
    }
    if (seam) while (out.length && isBlank(out[out.length - 1])) out.pop();
    if (out.length === 1 && out[0] === '') return '';
    return out.join('\n');
  }

  // A pasted todo line can carry its own "(date · source)" — keep it.
  var META_RE = /^(?:(.*)[ \t]+)?\(((?:\u2713 ?)?\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?: \u00b7 .*)?)\)[ \t]*$/;
  var DONE_FIELD_RE = /^\u2713 ?(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2})$/;
  function emptyMeta() { return { at: '', ws: '', room: '', done: '', extra: [] }; }
  function parseMetaInner(inner) {
    var f = inner.split(DOT), meta = emptyMeta(), m;
    for (var i = 0; i < f.length; i++) {
      var x = f[i].trim();
      if (!x) continue;
      if (i === 0 && DT_RE.test(x)) { meta.at = normStamp(x); continue; }
      if ((m = DONE_FIELD_RE.exec(x))) { meta.done = normStamp(m[1]); continue; }
      if (i === 0) return null;
      if (i === 1 && meta.at) {
        var p = x.split(ARROW);
        if (p.length >= 2) { meta.ws = p[0].trim(); meta.room = p.slice(1).join(ARROW).trim(); }
        else meta.room = x;
        continue;
      }
      meta.extra.push(x);
    }
    return meta.at || meta.done ? meta : null;
  }
  // "text (meta)" → { text, meta | null }
  function splitMeta(body) {
    var clean = unstrike(body), m = META_RE.exec(clean);
    if (m) {
      var meta = parseMetaInner(m[2]);
      if (meta) return { text: str(m[1]).replace(/[ \t]+$/, ''), meta: meta };
    }
    return { text: clean.replace(/[ \t]+$/, ''), meta: null };
  }
  function fmtMeta(m) {
    if (!m) return '';
    var at = normStamp(m.at), done = normStamp(m.done), f = [];
    if (at) {
      f.push(at);
      var room = cleanField(m.room), ws = cleanField(m.ws);
      if (room) f.push(ws ? ws + ARROW + room : room);
    }
    if (done) f.push(CHECK + ' ' + done);
    if (!at && !done) return '';
    (m.extra || []).forEach(function (x) { x = cleanField(x); if (x) f.push(x); });
    return ' (' + f.join(DOT) + ')';
  }

  // The digest input of a text.
  //   mode 'room':   all of it (the digest room). ``` fenced code stays behind.
  //   mode 'blocks': only its @digest blocks; the rest stays.
  // → { mode, entries: [{group, depth, done, text, meta, line}], groups, marks: [{line, kind, group}],
  //     blocks, remainder, removed (the text taken out) }
  function extract(text, opts) {
    opts = opts || {};
    var s = validSentinel(opts.sentinel), mode = opts.mode === 'room' ? 'room' : 'blocks';
    var L = splitLines(text), keep = L.slice(), runs = [], blocks = [];
    if (mode === 'room') {
      var run = { lines: [], map: [] }, inFence = false;
      for (var i = 0; i < L.length; i++) {
        var t = L[i];
        if (FENCE_RE.test(t)) { inFence = !inFence; continue; }
        if (inFence) continue;
        keep[i] = null;
        var d = DIRECTIVE_RE.exec(unstrike(t));
        if (d) { if (d[1].trim()) { run.lines.push(d[1]); run.map.push(i); } continue; }
        if (END_RE.test(t)) continue;
        run.lines.push(t);
        run.map.push(i);
      }
      runs.push(run);
    } else {
      blocks = findBlocks(L);
      blocks.forEach(function (b) {
        var r = { lines: [], map: [] };
        if (b.inline) { r.lines.push(b.inline); r.map.push(b.start); }
        for (var k = b.start + 1; k <= b.last; k++) { r.lines.push(L[k]); r.map.push(k); }
        for (var q = b.start; q <= b.end; q++) keep[q] = null;
        runs.push(r);
      });
    }
    var entries = [], groups = [], marks = [], seenG = {};
    runs.forEach(function (r) {
      var p = parseLines(r.lines);
      p.groups.forEach(function (g) { if (!seenG[g]) { seenG[g] = 1; groups.push(g); } });
      p.marks.forEach(function (mk) { marks.push({ line: r.map[mk.i], kind: mk.kind, group: mk.group, implicit: mk.implicit, depth: mk.depth }); });
      p.entries.forEach(function (e) {
        var sm = splitMeta(normalizeTags(e.text, s));
        if (!sm.text.trim()) return;
        entries.push({ group: e.group, depth: e.depth, done: e.done, text: sm.text.trim(), meta: sm.meta, line: r.map[e.src] });
      });
    });
    var removed = [];
    for (var z = 0; z < L.length; z++) if (keep[z] === null) removed.push(L[z]);
    return {
      mode: mode, entries: entries, groups: groups, marks: marks, blocks: blocks,
      remainder: joinKept(keep), removed: removed.join('\n').replace(/^\s+|\s+$/g, ''),
    };
  }

  // ---- the todo room -------------------------------------------------------------------
  var TODO_RE = /^([ \t]*)((?:[-*+\u2022]|\d{1,9}[.)])[ \t]+)?\[([ xX])\](?:[ \t]|$)(.*)$/;
  var SEC_RE = /^[ \t]*\[[ \t]*([^\[\]]*[^\[\]\s])[ \t]*\][ \t]*$/;
  var BOXONLY_RE = /^[ \t]*\[[ xX]\][ \t]*$/;
  var MDSEC_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

  function parseTodoLine(raw) {
    var m = TODO_RE.exec(raw);
    if (!m) return null;
    var sm = splitMeta(m[4]);
    return {
      lead: m[1], marker: m[2] || '', done: m[3] !== ' ', text: sm.text, meta: sm.meta,
      struck: STRIKE_1.test(m[4]),
    };
  }
  function sectionHead(raw) {
    var m;
    if (!BOXONLY_RE.test(raw) && (m = SEC_RE.exec(raw)) && normGroup(m[1])) return { name: m[1].trim(), style: 'bracket' };
    if ((m = MDSEC_RE.exec(raw)) && normGroup(m[2])) return { name: m[2].trim(), style: 'md' };
    return null;
  }

  // → { lines, sections: [{name, key, line, style, items: [index], lastLine, marker, lead}],
  //     items: [{kind: 'todo' | 'note', line, raw, sec, depth, lead, marker, done, text, meta,
  //              hasMeta, struck, tags, key}] }
  // Section 0 is what sits above the first heading (line -1).
  function parseTodo(text, opts) {
    var s = validSentinel(opts && opts.sentinel);
    var L = splitLines(text);
    var cur = { name: '', key: '', line: -1, style: '', items: [], lastLine: -1, marker: '', lead: '' };
    var sections = [cur], items = [], stack = [], inFence = false;
    function note(i, t, code) {
      var it = { kind: 'note', line: i, raw: t, sec: sections.length - 1, depth: 0, text: code ? t : t.trim(), code: !!code, tags: code ? [] : tagNames(t, s), key: '' };
      cur.items.push(items.length);
      items.push(it);
      cur.lastLine = i;
    }
    for (var i = 0; i < L.length; i++) {
      var t = L[i];
      if (FENCE_RE.test(t)) { inFence = !inFence; note(i, t, true); continue; }
      if (inFence) { note(i, t, true); continue; }
      if (isBlank(t)) continue;
      var td = parseTodoLine(t);
      if (td) {
        var w = indentWidth(td.lead);
        while (stack.length && stack[stack.length - 1] >= w) stack.pop();
        var depth = Math.min(stack.length, 6);
        stack.push(w);
        var meta = td.meta || emptyMeta();
        var it = {
          kind: 'todo', line: i, raw: t, sec: sections.length - 1, depth: depth, lead: td.lead, marker: td.marker,
          done: td.done, text: td.text, meta: meta, hasMeta: !!td.meta, struck: td.struck,
          tags: tagNames(td.text, s), key: itemKey(td.text, s),
        };
        cur.items.push(items.length);
        items.push(it);
        cur.lastLine = i;
        if (depth === 0) { cur.marker = td.marker; cur.lead = td.lead; }
        continue;
      }
      var h = sectionHead(t);
      if (h) {
        cur = { name: h.name, key: normGroup(h.name), line: i, style: h.style, items: [], lastLine: i, marker: '', lead: '' };
        sections.push(cur);
        stack = [];
        continue;
      }
      note(i, t, false);
    }
    // Where a new item joins a section: under the paragraph of its last todo
    // (a note written right under that todo stays with it; notes further down,
    // after a blank line, stay below the list), else after its last line.
    sections.forEach(function (sec) {
      sec.insertAfter = sec.lastLine;
      for (var n = sec.items.length - 1; n >= 0; n--) {
        var it = items[sec.items[n]];
        if (it.kind !== 'todo') continue;
        var e = it.line;
        while (e + 1 <= sec.lastLine && !isBlank(L[e + 1])) e++;
        sec.insertAfter = e;
        break;
      }
    });
    return { lines: L, sections: sections, items: items };
  }

  function renderEntry(e, o) {
    o = o || {};
    var meta = e.meta ? clone(e.meta) : null;
    if (e.done && meta && !meta.done) meta.done = meta.at;
    var lead = str(o.lead) + repeat(UNIT, Math.max(0, Math.min(e.depth || 0, 6)));
    return lead + str(o.marker) + '[' + (e.done ? 'x' : ' ') + '] ' + str(e.text).trim() + fmtMeta(meta);
  }
  function lastNonBlankBefore(L, end) {
    for (var i = Math.min(end, L.length) - 1; i >= 0; i--) if (!isBlank(L[i])) return i;
    return -1;
  }

  // Place ready-made lines into groups. adds: [{group, lines: [...]}] in order.
  // Existing sections (any heading style, matched case-insensitively) get them
  // after their last line; new [ GROUP ] sections go in above UNCATEGORIZED —
  // which stays the catch-all at the bottom — or at the end.
  function place(text, adds, P) {
    P = P || parseTodo(text);
    var L = P.lines, secByKey = {};
    P.sections.forEach(function (sec) { if (sec.line >= 0 && sec.key && !secByKey[sec.key]) secByKey[sec.key] = sec; });
    var ops = [], fresh = [], freshBy = {}, created = [];
    adds.forEach(function (a) {
      var g = normGroup(a.group) || UNCAT, sec = secByKey[g];
      if (sec) {
        if (a.lines.length) ops.push({ after: sec.insertAfter, lines: a.lines.slice(), fresh: false });
      } else if (freshBy[g]) {
        freshBy[g].push.apply(freshBy[g], a.lines);
      } else {
        freshBy[g] = a.lines.slice();
        fresh.push(g);
      }
    });
    if (fresh.length) {
      fresh.sort(function (a, b) { return (a === UNCAT ? 1 : 0) - (b === UNCAT ? 1 : 0); });
      var uncat = secByKey[UNCAT], block = [];
      fresh.forEach(function (g) {
        block.push('', '[ ' + g + ' ]');
        block.push.apply(block, freshBy[g]);
        created.push(g);
      });
      if (lastNonBlankBefore(L, L.length) < 0) return { text: block.slice(1).join('\n'), created: created };
      var after, tail = false;
      if (uncat) {
        after = lastNonBlankBefore(L, uncat.line);
        tail = after + 1 === uncat.line;
      } else {
        after = lastNonBlankBefore(L, L.length);
      }
      if (after < 0) { block.shift(); tail = true; }
      if (tail) block.push('');
      ops.push({ after: after, lines: block, fresh: true });
    }
    // Bottom up; at one spot the new sections go first so a section's own
    // lines end up directly under it, above them.
    ops.sort(function (a, b) { return b.after - a.after || (b.fresh ? 1 : 0) - (a.fresh ? 1 : 0); });
    var out = L.slice();
    ops.forEach(function (op) { out.splice.apply(out, [op.after + 1, 0].concat(op.lines)); });
    return { text: out.join('\n'), created: created };
  }

  // File digested entries into the todo text.
  // opts: { sentinel, dedupe (default true), groups (named in the digest — empty
  // ones get a section too) }  → { text, added: [{group, line}], skipped, created }
  //
  // Dedupe: an entry already OPEN in the same group isn't added twice (only
  // plain top-level entries — a parent or a child keeps its family together),
  // and the very same capture (same text, minute and room — a replay after a
  // crash) never is.
  function insertEntries(text, entries, opts) {
    opts = opts || {};
    var s = validSentinel(opts.sentinel), dedupe = opts.dedupe !== false;
    var P = parseTodo(text, { sentinel: s });
    var openBy = {}, ident = {}, secByKey = {};
    P.sections.forEach(function (sec) { if (sec.line >= 0 && sec.key && !secByKey[sec.key]) secByKey[sec.key] = sec; });
    P.items.forEach(function (it) {
      if (it.kind !== 'todo') return;
      var sk = P.sections[it.sec].key || '';
      if (!it.done) (openBy[sk] || (openBy[sk] = {}))[it.key] = 1;
      if (it.meta.at) ident[sk + '|' + it.key + '|' + it.meta.at + '|' + (it.meta.room || '')] = 1;
    });
    var list = entries || [], order = [], by = {}, added = [], skipped = 0;
    for (var i = 0; i < list.length; i++) {
      var e = list[i], g = normGroup(e.group) || UNCAT, key = itemKey(e.text, s);
      if (!key) continue;
      var text1 = normalizeTags(str(e.text).replace(/[\r\n]+/g, ' ').trim(), s);
      if (e.meta && e.meta.at && ident[g + '|' + key + '|' + normStamp(e.meta.at) + '|' + (e.meta.room || '')]) { skipped++; continue; }
      var kids = i + 1 < list.length && (list[i + 1].depth || 0) > (e.depth || 0);
      if (dedupe && !(e.depth > 0) && !kids && !e.done && openBy[g] && openBy[g][key]) { skipped++; continue; }
      if (!e.done) (openBy[g] || (openBy[g] = {}))[key] = 1;
      if (!by[g]) { by[g] = []; order.push(g); }
      by[g].push({ depth: e.depth || 0, done: !!e.done, text: text1, meta: e.meta || null });
    }
    if (!order.length) return { text: str(text), added: [], skipped: skipped, created: [] };
    (opts.groups || []).forEach(function (g) {
      g = normGroup(g);
      if (g && !by[g] && !secByKey[g]) { by[g] = []; order.push(g); }
    });
    var adds = order.map(function (g) {
      var sec = secByKey[g], o = sec ? { marker: sec.marker, lead: sec.lead } : {};
      var lines = by[g].map(function (e) { var ln = renderEntry(e, o); added.push({ group: g, line: ln }); return ln; });
      return { group: g, lines: lines };
    });
    var r = place(text, adds, P);
    return { text: r.text, added: added, skipped: skipped, created: r.created };
  }

  // ---- edits on the todo text (null = the line isn't there any more) ---------------
  // Where an item is now: its line if unchanged, else its exact text on a line
  // of its own — but only when that's unambiguous.
  function locate(L, line, raw) {
    if (line >= 0 && line < L.length && L[line] === raw) return line;
    var found = -1;
    for (var i = 0; i < L.length; i++) {
      if (L[i] !== raw) continue;
      if (found >= 0) return -1;
      found = i;
    }
    return found;
  }
  // The item and the more-indented lines straight under it (its sub-items).
  function subtreeEnd(L, i) {
    var base = indentWidth(L[i]), end = i;
    for (var j = i + 1; j < L.length; j++) {
      var t = L[j];
      if (isBlank(t) || sectionHead(t) || indentWidth(t) <= base) break;
      end = j;
    }
    return end;
  }
  function toggleLine(raw, opts) {
    var td = parseTodoLine(raw);
    if (!td) return null;
    var done = !td.done, meta = td.meta ? clone(td.meta) : emptyMeta();
    if (done) { if (opts && opts.stamp) meta.done = normStamp(opts.now) || stamp(); }
    else meta.done = '';
    return td.lead + td.marker + '[' + (done ? 'x' : ' ') + '] ' + td.text + fmtMeta(meta);
  }
  function toggleAt(text, line, raw, opts) {
    var L = splitLines(text), i = locate(L, line, raw);
    if (i < 0) return null;
    var nl = toggleLine(L[i], opts);
    if (nl == null) return null;
    L[i] = nl;
    return L.join('\n');
  }
  function setTextAt(text, line, raw, newText, opts) {
    var L = splitLines(text), i = locate(L, line, raw);
    if (i < 0) return null;
    var td = parseTodoLine(L[i]), t = normalizeTags(str(newText).replace(/[\r\n]+/g, ' ').trim(), opts && opts.sentinel);
    if (td) L[i] = td.lead + td.marker + '[' + (td.done ? 'x' : ' ') + '] ' + t + fmtMeta(td.meta);
    else L[i] = L[i].match(/^[ \t]*/)[0] + t;
    return L.join('\n');
  }
  // A note line ("- milk", "milk") as an open todo, keeping its indentation.
  function makeTodoAt(text, line, raw) {
    var L = splitLines(text), i = locate(L, line, raw);
    if (i < 0 || parseTodoLine(L[i])) return null;
    var lead = L[i].match(/^[ \t]*/)[0], body = L[i].slice(lead.length);
    var m = BULLET_RE.exec(body);
    if (m) body = m[3];
    var gm = GLYPH_RE.exec(body);
    var done = !!(gm && DONE_GLYPHS.indexOf(gm[2]) >= 0);
    if (gm) body = gm[3];
    L[i] = lead + '[' + (done ? 'x' : ' ') + '] ' + body.trim();
    return L.join('\n');
  }
  // A [ GROUP ] section an edit just emptied goes with it. (Only the digest's
  // own bracket sections: a "## Heading" is the user's document structure, and
  // a section that was already empty was left that way on purpose.)
  function dropEmptied(P, keep) {
    var L = P.lines;
    P.sections.forEach(function (sec, si) {
      if (sec.line < 0 || sec.style !== 'bracket' || !sec.items.length || keep[sec.line] === null) return;
      var next = si + 1 < P.sections.length ? P.sections[si + 1].line : L.length;
      for (var k = sec.line + 1; k < next; k++) if (keep[k] !== null && !isBlank(keep[k])) return;
      keep[sec.line] = null;
    });
  }
  function deleteAt(text, line, raw) {
    var P = parseTodo(text), L = P.lines, i = locate(L, line, raw);
    if (i < 0) return null;
    var end = subtreeEnd(L, i), keep = L.slice();
    for (var k = i; k <= end; k++) keep[k] = null;
    dropEmptied(P, keep);
    return { text: joinKept(keep), count: end - i + 1 };
  }
  function moveAt(text, line, raw, group, opts) {
    var P0 = parseTodo(text, opts), L = P0.lines, i = locate(L, line, raw);
    if (i < 0) return null;
    var g = normGroup(group) || UNCAT, end = subtreeEnd(L, i);
    for (var si = P0.sections.length - 1; si >= 0; si--) {
      if (P0.sections[si].line < i) { if (P0.sections[si].key === g) return str(text); break; }   // already there
    }
    var base = L[i].match(/^[ \t]*/)[0].length;
    var moved = L.slice(i, end + 1).map(function (t) {
      var lead = t.match(/^[ \t]*/)[0];
      return t.slice(Math.min(base, lead.length));
    });
    var keep = L.slice();
    for (var k = i; k <= end; k++) keep[k] = null;
    dropEmptied(P0, keep);
    var rest = joinKept(keep);
    var P = parseTodo(rest, opts);
    var sec = null;
    P.sections.forEach(function (x) { if (!sec && x.line >= 0 && x.key === g) sec = x; });
    var lead0 = sec ? sec.lead : '';
    // "- [ ] x" moved into a section of bare "[ ] x" lines (or back) takes its style.
    var marker = sec ? sec.marker : '';
    var lines = moved.map(function (t, n) {
      var td = n === 0 ? parseTodoLine(t) : null;
      if (td && !td.lead) t = marker + t.slice(td.marker.length);
      return lead0 + t;
    });
    return place(rest, [{ group: g, lines: lines }], P).text;
  }
  // Remove checked items (a checked parent stays while it still has open
  // sub-items); a section that only held those goes too.
  function clearDone(text, opts) {
    var P = parseTodo(text, opts), L = P.lines, keep = L.slice(), removed = 0;
    for (var n = P.items.length - 1; n >= 0; n--) {
      var it = P.items[n];
      if (it.kind !== 'todo' || !it.done || keep[it.line] === null) continue;
      var end = subtreeEnd(L, it.line), open = false;
      for (var k = it.line + 1; k <= end; k++) {
        var td = parseTodoLine(L[k]);
        if (td && !td.done && keep[k] !== null) { open = true; break; }
      }
      if (open) continue;
      for (var q = it.line; q <= end; q++) if (keep[q] !== null) { keep[q] = null; if (parseTodoLine(L[q])) removed++; }
    }
    if (!removed) return { text: str(text), removed: 0 };
    dropEmptied(P, keep);
    return { text: joinKept(keep), removed: removed };
  }
  // Take the given lines back out (an undone digest): each once, from the bottom;
  // sections it created go too when nothing else is in them.
  function removeLines(text, lineTexts, createdGroups) {
    var L = splitLines(text), keep = L.slice(), want = {}, left = 0;
    (lineTexts || []).forEach(function (t) { want[t] = (want[t] || 0) + 1; left++; });
    for (var i = L.length - 1; i >= 0 && left; i--) {
      if (want[L[i]]) { want[L[i]]--; left--; keep[i] = null; }
    }
    var gone = {};
    (createdGroups || []).forEach(function (g) { gone[normGroup(g)] = 1; });
    var P = parseTodo(text);
    P.sections.forEach(function (sec, si) {
      if (sec.line < 0 || !gone[sec.key]) return;
      var next = si + 1 < P.sections.length ? P.sections[si + 1].line : L.length;
      for (var k = sec.line + 1; k < next; k++) if (keep[k] !== null && !isBlank(keep[k])) return;
      keep[sec.line] = null;
    });
    return joinKept(keep);
  }

  // ---- numbers ---------------------------------------------------------------------------
  function stats(items, now) {
    var today = stamp(now instanceof Date ? now : new Date(now == null ? Date.now() : now)).slice(0, 10);
    var s = { total: 0, done: 0, open: 0, addedToday: 0, doneToday: 0, oldest: '' };
    (items || []).forEach(function (it) {
      if (it.kind !== 'todo') return;
      s.total++;
      if (it.done) { s.done++; if (it.meta.done && it.meta.done.slice(0, 10) === today) s.doneToday++; }
      else { s.open++; if (it.meta.at && (!s.oldest || it.meta.at < s.oldest)) s.oldest = it.meta.at; }
      if (it.meta.at && it.meta.at.slice(0, 10) === today) s.addedToday++;
    });
    s.pct = s.total ? Math.round(s.done / s.total * 100) : 0;
    return s;
  }

  // ---- typing ------------------------------------------------------------------------------
  // "yy" just typed at the start of a word (line start, or after a space or an
  // opening bracket) — the shorthand for ¥.
  var YY_RE = /(?:^|[\s(\[{])yy$/;
  function yyTrigger(before) { return YY_RE.test(str(before)); }

  var api = {
    UNCAT: UNCAT, YEN: YEN, SENTINELS: SENTINELS, DOT: DOT, ARROW: ARROW, CHECK: CHECK,
    validSentinel: validSentinel, stamp: stamp, normStamp: normStamp, parseStamp: parseStamp, when: when,
    findTags: findTags, tagNames: tagNames, normalizeTags: normalizeTags, normGroup: normGroup, itemKey: itemKey,
    classify: classify, parseLines: parseLines, findBlocks: findBlocks, hasDirective: hasDirective, extract: extract,
    splitMeta: splitMeta, fmtMeta: fmtMeta, parseTodoLine: parseTodoLine, sectionHead: sectionHead, parseTodo: parseTodo,
    renderEntry: renderEntry, insertEntries: insertEntries, place: place,
    locate: locate, subtreeEnd: subtreeEnd, toggleLine: toggleLine, toggleAt: toggleAt, setTextAt: setTextAt,
    makeTodoAt: makeTodoAt, deleteAt: deleteAt, moveAt: moveAt, clearDone: clearDone, removeLines: removeLines,
    stats: stats, yyTrigger: yyTrigger, joinKept: joinKept, splitLines: splitLines, DIRECTIVE_RE: DIRECTIVE_RE,
  };
  if (typeof window !== 'undefined') window.__cadeDigestCore = api;
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
})();
