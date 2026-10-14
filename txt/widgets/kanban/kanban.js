/* Kanban board for Cade.txt — the CURRENT DOCUMENT is the board.
 *
 * Columns are sibling markdown headings (## Todo / ## Doing / ## Done — any
 * names, level 1-4); cards are the top-level list items under each heading
 * ("- x", "* x", "- [ ] x", "1. x", a bare "[ ] x"), each carrying its indented
 * continuation / sub-item lines. Any other text under a heading stays where it
 * is and shows as the column's note. A document with an "@kanban" directive line
 * (or "@type: kanban") uses every "##" heading as a column.
 *
 * There is no separate board state: every action computes the smallest text
 * edits and dispatches ONE editor transaction (userEvent "input.kanban"), so the
 * board syncs, versions and undoes (Ctrl+Z) exactly like typing. The panel
 * re-parses (debounced) when the document changes and notices room switches
 * (editor.setState bypasses update listeners) with a cheap doc-identity poll
 * that only runs while the panel is open.
 *
 * The parser + edit builders (Model) are pure string-in / changes-out functions,
 * unit-tested in node by kanban.test.js (which requires this file directly).
 */
(function () {
  'use strict';

  // =========================================================================
  // Pure model — no DOM, no Cade. Line indices are 0-based.
  // =========================================================================
  var Model = (function () {
    var HEAD_RE = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
    var ITEM_RE = /^([ \t]*)([-*+\u2022]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
    var BARE_RE = /^([ \t]*)\[[ xX]\](?:[ \t]|$)/;   // core treats "[ ] x" as a todo line too
    var CHECK_RE = /^\[([ xX])\](?:[ \t]+|$)/;
    var FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
    var NUM_RE = /^\d+[.)]$/;
    var BLANK_RE = /^[ \t]*$/;
    var STRIKE_G = /\u0336/g;
    var HAS_STRIKE = /\u0336/;
    var DONE_RE = /\b(?:done|complete|completed|finished|closed|shipped|resolved|archived?)\b|[\u2705\u2713\u2714]/i;
    var WIP_RE = /\s*[(\[]\s*(?:wip|max|limit)?\s*[:=]?\s*(\d{1,3})\s*[)\]]\s*$/i;

    function isBlank(s) { return BLANK_RE.test(s); }
    function spaces(n) { return new Array(n + 1).join(' '); }
    function hashes(n) { return new Array(n + 1).join('#'); }
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

    // A list item line → { indent, marker ('' for a bare checkbox), check
    // (null | ' ' | 'x' | 'X'), pre (length of everything before the text), text }.
    function matchItem(t) {
      var m = ITEM_RE.exec(t), indent, marker, pre;
      if (m) { indent = m[1]; marker = m[2]; pre = m[3] == null ? t.length : t.length - m[3].length; }
      else if ((m = BARE_RE.exec(t))) { indent = m[1]; marker = ''; pre = indent.length; }
      else return null;
      var check = null, c = CHECK_RE.exec(t.slice(pre));
      if (c) { check = c[1]; pre += c[0].length; }
      return { indent: indent, marker: marker, check: check, pre: pre, text: t.slice(pre) };
    }

    // "@kanban" on a directive line (same shape core's "@todo" / "@journal"
    // lines use), or "@type: kanban".
    function isDirective(t) {
      var s = t.trim();
      if (s.charAt(0) !== '@') return false;
      if (/^@type\s*:\s*kanban\b/i.test(s)) return true;
      var parts = s.split(/[,;]/);
      for (var i = 0; i < parts.length; i++) if (/^@kanban(?![\w:])/i.test(parts[i].trim())) return true;
      return false;
    }

    // ---- parse ------------------------------------------------------------
    function parse(text) {
      text = String(text);
      var lines = text.split('\n'), n = lines.length, starts = new Array(n), pos = 0, i, k;
      for (i = 0; i < n; i++) { starts[i] = pos; pos += lines[i].length + 1; }
      // Fences first: a "## x" inside ``` is code, not a column.
      var fenceEnd = {}, heads = [], marked = false, open = -1, fch = '', flen = 0, f;
      for (i = 0; i < n; i++) {
        var t = lines[i];
        if (open >= 0) {
          f = FENCE_RE.exec(t);
          if (f && f[1].charAt(0) === fch && f[1].length >= flen) { fenceEnd[open] = i; open = -1; }
          continue;
        }
        var c0 = t.charCodeAt(0);
        if ((c0 === 96 || c0 === 126 || c0 === 32 || c0 === 9) && (f = FENCE_RE.exec(t))) {
          open = i; fch = f[1].charAt(0); flen = f[1].length; continue;
        }
        if (c0 === 35) {
          var h = HEAD_RE.exec(t);
          if (h) heads.push({ line: i, level: h[1].length, raw: (h[2] || '').replace(/[ \t]+#+$/, '').replace(/^#+$/, '') });
        } else if (!marked && t.indexOf('@') !== -1 && isDirective(t)) marked = true;
      }
      if (open >= 0) fenceEnd[open] = n - 1;

      // parent (nearest shallower heading above), direct-body end (next heading
      // of ANY level) and section end (next heading of the same or shallower level)
      var stack = [];
      for (k = 0; k < heads.length; k++) {
        var hd = heads[k];
        while (stack.length && heads[stack[stack.length - 1]].level >= hd.level) stack.pop();
        hd.parent = stack.length ? stack[stack.length - 1] : -1;
        stack.push(k);
        hd.bodyEnd = k + 1 < heads.length ? heads[k + 1].line : n;
      }
      stack = [];
      for (k = heads.length - 1; k >= 0; k--) {
        while (stack.length && heads[stack[stack.length - 1]].level > heads[k].level) stack.pop();
        heads[k].sectionEnd = stack.length ? heads[stack[stack.length - 1]].line : n;
        stack.push(k);
      }

      // Candidate boards: >= 2 sibling headings (same parent, same level <= 4).
      var gmap = {}, all = [];
      for (k = 0; k < heads.length; k++) {
        var hk = heads[k];
        if (hk.level > 4) continue;
        var gk = hk.parent + ':' + hk.level;
        if (!gmap[gk]) { gmap[gk] = { level: hk.level, parent: hk.parent, heads: [] }; all.push(gmap[gk]); }
        gmap[gk].heads.push(k);
      }
      var groups = [], occ = {}, l2 = [];
      if (marked) {
        for (k = 0; k < heads.length; k++) if (heads[k].level === 2) l2.push(k);
        if (l2.length) groups.push({ key: '@kanban', level: 2, parent: -1, heads: l2, marked: true });
      }
      all.forEach(function (g) {
        if (g.heads.length < 2) return;
        if (l2.length && g.level === 2 && g.heads.join() === l2.join()) return; // same as the @kanban board
        var base = g.level + '|' + (g.parent >= 0 ? heads[g.parent].raw : '');
        occ[base] = (occ[base] || 0) + 1;
        g.key = base + '|' + occ[base];
        groups.push(g);
      });
      groups.forEach(function (g) {
        g.from = heads[g.heads[0]].line;
        g.to = heads[g.heads[g.heads.length - 1]].sectionEnd;
      });
      return { text: text, lines: lines, starts: starts, heads: heads, groups: groups, fenceEnd: fenceEnd, marked: marked };
    }

    // Cards of one column: list items in the heading's DIRECT body (sub-headings
    // end it). A card runs on through lines indented deeper than its marker,
    // including blank lines between them; its trailing blank lines are not part
    // of it. Everything else is note text that never moves.
    function column(P, k) {
      var hd = P.heads[k], a = hd.line + 1, b = hd.bodyEnd, lines = P.lines;
      var cards = [], notes = [], cur = null;
      for (var i = a; i < b; i++) {
        var t = lines[i];
        if (isBlank(t)) continue;
        var ind = indentWidth(t), fe = P.fenceEnd[i];
        if (fe !== undefined) {
          if (fe >= b) fe = b - 1;
          if (cur && ind > cur.indentW) cur.end = fe + 1;
          else { cur = null; for (var j = i; j <= fe; j++) notes.push(j); }
          i = fe;
          continue;
        }
        var m = matchItem(t);
        if (m && ind <= 3 && (!cur || ind <= cur.indentW)) {
          cur = { start: i, end: i + 1, indent: m.indent, indentW: ind, marker: m.marker, check: m.check, pre: m.pre, text: m.text };
          cards.push(cur);
          continue;
        }
        if (cur && ind > cur.indentW) { cur.end = i + 1; continue; }
        cur = null;
        notes.push(i);
      }
      var raw = hd.raw, w = WIP_RE.exec(raw);
      return {
        head: k, line: hd.line, level: hd.level, raw: raw,
        name: (w ? raw.slice(0, w.index) : raw).trim(), wip: w ? +w[1] : 0,
        bodyStart: a, bodyEnd: b, sectionEnd: hd.sectionEnd,
        cards: cards, notes: notes, done: DONE_RE.test(raw),
      };
    }

    function board(P, g) {
      return { key: g.key, level: g.level, marked: !!g.marked, columns: g.heads.map(function (k) { return column(P, k); }) };
    }

    function countItems(P, g) {
      var c = 0;
      g.heads.forEach(function (k) {
        var hd = P.heads[k];
        for (var i = hd.line + 1; i < hd.bodyEnd; i++) if (matchItem(P.lines[i])) c++;
      });
      return c;
    }

    // Which board to show: the one just created (pickLine) > the one shown
    // before (key, then column names) > @kanban > the innermost board around the
    // cursor > the board with the most list items.
    function pickBoard(P, prevKey, prevNames, cursorLine, pickLine) {
      var gs = P.groups, i, best = -1;
      if (!gs.length) return -1;
      if (pickLine != null) {
        for (i = 0; i < gs.length; i++) {
          for (var j = 0; j < gs[i].heads.length; j++) if (P.heads[gs[i].heads[j]].line === pickLine) return i;
        }
      }
      if (prevKey) for (i = 0; i < gs.length; i++) if (gs[i].key === prevKey) return i;
      if (prevNames && prevNames.length) {
        var bestN = 0;
        for (i = 0; i < gs.length; i++) {
          var hit = 0;
          for (var h = 0; h < gs[i].heads.length; h++) if (prevNames.indexOf(P.heads[gs[i].heads[h]].raw) !== -1) hit++;
          if (hit > bestN) { bestN = hit; best = i; }
        }
        if (best >= 0 && bestN * 2 >= prevNames.length) return best;
        best = -1;
      }
      if (gs[0].marked) return 0;
      if (cursorLine != null) {
        for (i = 0; i < gs.length; i++) {
          var g = gs[i];
          if (cursorLine >= g.from && cursorLine < g.to && (best < 0 || g.level > gs[best].level)) best = i;
        }
        if (best >= 0) return best;
      }
      var most = -1;
      for (i = 0; i < gs.length; i++) {
        var c = countItems(P, gs[i]);
        if (c > most) { most = c; best = i; }
      }
      return best;
    }

    // ---- text edit helpers ---------------------------------------------------
    // Shrink a replacement to the span that really differs (never splitting a
    // surrogate pair), so a move touches only the moved lines.
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
    // Replace lines [a, b) with nl (a === b inserts before line a).
    function replaceLines(P, a, b, nl) {
      if (!nl.length) return removeLines(P, a, b);
      if (a < b) return minimize(P.text, P.starts[a], P.starts[b - 1] + P.lines[b - 1].length, nl.join('\n'));
      if (a < P.lines.length) return minimize(P.text, P.starts[a], P.starts[a], nl.join('\n') + '\n');
      return minimize(P.text, P.text.length, P.text.length, '\n' + nl.join('\n'));
    }
    // Delete lines [a, b) together with one line break.
    function removeLines(P, a, b) {
      if (a >= b) return null;
      if (b < P.lines.length) return minimize(P.text, P.starts[a], P.starts[b], '');
      if (a > 0) return minimize(P.text, P.starts[a] - 1, P.text.length, '');
      return minimize(P.text, 0, P.text.length, '');
    }
    function lastNonBlank(P, a, b) {
      for (var i = b - 1; i >= a; i--) if (!isBlank(P.lines[i])) return i;
      return a;
    }

    // A column body as a sequence of {card, lines} and {line} entries.
    function entries(P, col) {
      var out = [], i = col.bodyStart, ci = 0;
      while (i < col.bodyEnd) {
        var c = col.cards[ci];
        if (c && c.start === i) { out.push({ card: c, lines: P.lines.slice(c.start, c.end) }); i = c.end; ci++; }
        else { out.push({ line: P.lines[i] }); i++; }
      }
      return out;
    }
    function flat(ents) {
      var out = [];
      ents.forEach(function (e) { if (e.card) out.push.apply(out, e.lines); else out.push(e.line); });
      return out;
    }
    function isBlankEnt(e) { return !!e && !e.card && isBlank(e.line); }
    function cardCount(ents) { var n = 0; ents.forEach(function (e) { if (e.card) n++; }); return n; }
    function cardEntryIndex(ents, ci) {
      for (var p = 0, n = -1; p < ents.length; p++) if (ents[p].card && ++n === ci) return p;
      return -1;
    }
    function firstCardLine(ents) { for (var p = 0; p < ents.length; p++) if (ents[p].card) return ents[p].lines[0]; return null; }
    function lastCardLine(ents) { for (var p = ents.length - 1; p >= 0; p--) if (ents[p].card) return ents[p].lines[0]; return null; }
    // Remove a card; drop one neighbouring blank too when it would otherwise
    // leave a double gap (loose lists) or a leading gap under the heading.
    function removeCard(ents, p) {
      var prevBlank = p === 0 || isBlankEnt(ents[p - 1]);
      var nextBlank = isBlankEnt(ents[p + 1]);
      ents.splice(p, prevBlank && nextBlank ? 2 : 1);
    }
    // "Loose" list = cards separated by blank lines; new cards follow suit.
    function isLoose(ents) {
      var seen = false, blanks = 0, other = false;
      for (var p = 0; p < ents.length; p++) {
        var e = ents[p];
        if (e.card) { if (seen && blanks && !other) return true; seen = true; blanks = 0; other = false; }
        else if (isBlank(e.line)) blanks++;
        else other = true;
      }
      return false;
    }
    function insertCard(ents, lines, before, loose) {
      var ent = { card: true, lines: lines }, pos = [], p;
      for (p = 0; p < ents.length; p++) if (ents[p].card) pos.push(p);
      if (pos.length) {
        if (before < pos.length) ents.splice.apply(ents, [pos[before], 0].concat(loose ? [ent, { line: '' }] : [ent]));
        else ents.splice.apply(ents, [pos[pos.length - 1] + 1, 0].concat(loose ? [{ line: '' }, ent] : [ent]));
        return;
      }
      // empty column: after its note text (separated by a blank line), else at the top
      for (p = ents.length - 1; p >= 0; p--) if (!isBlankEnt(ents[p])) break;
      if (p < 0) ents.splice(0, 0, ent);
      else ents.splice(p + 1, 0, { line: '' }, ent);
    }
    // First number when every card is numbered ("1." / "3)"), else -1.
    function numberedStart(ents) {
      var first = -1;
      for (var p = 0; p < ents.length; p++) {
        if (!ents[p].card) continue;
        var m = matchItem(ents[p].lines[0]);
        if (!m || !NUM_RE.test(m.marker)) return -1;
        if (first < 0) first = parseInt(m.marker, 10);
      }
      return first;
    }
    function renumber(ents, start) {
      var n = start;
      ents.forEach(function (e) {
        if (!e.card) return;
        var m = matchItem(e.lines[0]);
        if (m && NUM_RE.test(m.marker)) e.lines[0] = setMarker(e.lines[0], (n++) + m.marker.slice(-1));
      });
    }
    function setMarker(line, mk) {
      var m = matchItem(line);
      if (!m || m.marker === mk) return line;
      if (!m.marker) return m.indent + mk + ' ' + line.slice(m.indent.length);
      return m.indent + mk + line.slice(m.indent.length + m.marker.length);
    }
    // Core's checkbox toggle strikes the text with U+0336 when ticking and strips
    // it when unticking; do the same so either path leaves the same text.
    function strike(s) {
      return s.replace(STRIKE_G, '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\n\r]/g, function (ch) { return ch + '\u0336'; });
    }
    function setCheck(line, on) {
      var m = matchItem(line);
      if (!m) return line;
      var head = line.slice(0, m.pre), text = line.slice(m.pre).replace(STRIKE_G, '');
      if (m.check !== null) {
        var bi = head.lastIndexOf('[');
        head = head.slice(0, bi + 1) + (on ? 'x' : ' ') + head.slice(bi + 2);
      } else {
        if (head && !/[ \t]$/.test(head)) head += ' ';
        head += on ? '[x] ' : '[ ] ';
      }
      return head + (on && text ? strike(text) : text);
    }
    // A card moving between columns takes the destination's indent and marker
    // style (so "1." cards don't land in a "-" list and vice versa).
    function adoptStyle(lines, refLine) {
      var m = matchItem(lines[0]), r = matchItem(refLine);
      if (!m || !r) return lines;
      var out = lines.slice();
      if (m.indent !== r.indent) {
        out = out.map(function (l, k) {
          if (k > 0 && isBlank(l)) return l;
          return l.indexOf(m.indent) === 0 ? r.indent + l.slice(m.indent.length) : l;
        });
      }
      if (r.marker) {
        var m2 = matchItem(out[0]), rn = NUM_RE.test(r.marker), cn = NUM_RE.test(m2.marker);
        if (rn && !cn) out[0] = setMarker(out[0], '1' + r.marker.slice(-1));
        else if (!rn && m2.marker !== r.marker) out[0] = setMarker(out[0], r.marker);
      }
      return out;
    }
    function bodyChange(P, col, ents) {
      var nl = flat(ents);
      if (col.bodyEnd > col.bodyStart) { if (!nl.length) nl = ['']; }       // keep one blank under the heading
      else if (nl.length && col.bodyEnd < P.lines.length) nl.push('');     // breathing room before the next heading
      return nl.length ? replaceLines(P, col.bodyStart, col.bodyEnd, nl) : null;
    }
    function result(changes, focus, extra) {
      var r = { changes: changes.filter(Boolean).sort(function (a, b) { return a.from - b.from; }), focus: focus || null };
      if (extra) for (var k in extra) r[k] = extra[k];
      return r;
    }
    function cleanName(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

    // ---- board actions (each returns {changes, focus} or null) ---------------
    // Move card fi of column fc to sit before card `before` of column tc
    // (indices in the CURRENT board; before = length → append).
    function moveCard(P, b, fc, fi, tc, before, opts) {
      opts = opts || {};
      var src = b.columns[fc], dst = b.columns[tc];
      if (!src || !dst || !(fi >= 0 && fi < src.cards.length)) return null;
      var dn = dst.cards.length;
      if (before == null || before < 0 || before > dn) before = dn;
      var same = fc === tc;
      if (same && (before === fi || before === fi + 1)) return null;
      var sEnts = entries(P, src), sNum = numberedStart(sEnts);
      var p = cardEntryIndex(sEnts, fi);
      var lines = sEnts[p].lines.slice();
      removeCard(sEnts, p);
      var dEnts = same ? sEnts : entries(P, dst);
      var dNum = same ? sNum : numberedStart(dEnts);
      var at = same && before > fi ? before - 1 : before;
      if (!same) {
        var ref = firstCardLine(dEnts);
        if (ref != null) lines = adoptStyle(lines, ref);
        if (opts.doneMarks && dst.done !== src.done) {
          var m = matchItem(lines[0]), on = m.check !== null && m.check !== ' ';
          if (dst.done && !on) lines[0] = setCheck(lines[0], true);
          else if (!dst.done && on) lines[0] = setCheck(lines[0], false);
        }
      }
      insertCard(dEnts, lines, at, isLoose(dEnts));
      if (!same && sNum >= 0 && numberedStart(sEnts) >= 0) renumber(sEnts, sNum);
      if (numberedStart(dEnts) >= 0) renumber(dEnts, dNum >= 0 ? dNum : 1);
      return result(same ? [bodyChange(P, src, sEnts)] : [bodyChange(P, src, sEnts), bodyChange(P, dst, dEnts)], { col: tc, ci: at });
    }

    function deleteCard(P, b, c, i) {
      var col = b.columns[c];
      if (!col || !col.cards[i]) return null;
      var ents = entries(P, col), num = numberedStart(ents);
      removeCard(ents, cardEntryIndex(ents, i));
      if (num >= 0 && numberedStart(ents) >= 0) renumber(ents, num);
      var left = col.cards.length - 1;
      return result([bodyChange(P, col, ents)], left > 0 ? { col: c, ci: Math.min(i, left - 1) } : null);
    }

    // New cards copy the style of the column's last card (else the board's first).
    function addCards(P, b, c, texts, opts) {
      opts = opts || {};
      var col = b.columns[c];
      if (!col) return null;
      texts = (texts || []).map(function (t) { return String(t).trim(); }).filter(Boolean);
      if (!texts.length) return null;
      var ents = entries(P, col), ref = lastCardLine(ents), k;
      for (k = 0; ref == null && k < b.columns.length; k++) if (b.columns[k].cards.length) ref = P.lines[b.columns[k].cards[0].start];
      var r = ref != null ? matchItem(ref) : null;
      var indent = r ? r.indent : '', marker = r ? r.marker : '-', check = !!(r && r.check !== null);
      if (NUM_RE.test(marker)) marker = '1' + marker.slice(-1);
      if (!marker && !check) marker = '-';
      var on = check && !!opts.doneMarks && col.done, num = numberedStart(ents), loose = isLoose(ents);
      texts.forEach(function (t) {
        var line = indent + (marker ? marker + ' ' : '') + (check ? (on ? '[x] ' : '[ ] ') : '') + (on ? strike(t) : t);
        insertCard(ents, [line], cardCount(ents), loose);
      });
      if (numberedStart(ents) >= 0) renumber(ents, num >= 0 ? num : 1);
      return result([bodyChange(P, col, ents)], { col: c, ci: col.cards.length + texts.length - 1 });
    }

    // Continuation lines are edited without their shared indent.
    function contPrefix(cont) {
      var p = null;
      cont.forEach(function (l) {
        if (isBlank(l)) return;
        var ws = /^[ \t]*/.exec(l)[0];
        if (p === null) { p = ws; return; }
        var k = 0;
        while (k < p.length && k < ws.length && p.charAt(k) === ws.charAt(k)) k++;
        p = p.slice(0, k);
      });
      return p || '';
    }
    function prefixFor(card, cont) {
      var p = contPrefix(cont);
      return indentWidth(p) > card.indentW ? p : card.indent + (NUM_RE.test(card.marker) ? spaces(card.marker.length + 1) : '  ');
    }
    function cardEditText(P, card) {
      var cont = P.lines.slice(card.start + 1, card.end), pre = prefixFor(card, cont);
      return [card.text.replace(STRIKE_G, '')].concat(cont.map(function (l) {
        if (isBlank(l)) return '';
        return l.indexOf(pre) === 0 ? l.slice(pre.length) : l.replace(/^[ \t]+/, '');
      })).join('\n');
    }
    function editCard(P, b, c, i, value) {
      var col = b.columns[c], card = col && col.cards[i];
      if (!card) return null;
      var vl = String(value).replace(/\r\n?/g, '\n').split('\n');
      while (vl.length > 1 && isBlank(vl[vl.length - 1])) vl.pop();
      var t0 = vl[0].trim(), head = P.lines[card.start].slice(0, card.pre);
      var struck = card.check !== null && card.check !== ' ' && HAS_STRIKE.test(card.text);
      if (t0 && head && !/[ \t]$/.test(head)) head += ' ';
      var pre = prefixFor(card, P.lines.slice(card.start + 1, card.end));
      var nl = [head + (struck ? strike(t0) : t0)];
      for (var k = 1; k < vl.length; k++) nl.push(isBlank(vl[k]) ? '' : pre + vl[k].replace(/[ \t]+$/, ''));
      return result([replaceLines(P, card.start, card.end, nl)], { col: c, ci: i });
    }

    function toggleCheck(P, b, c, i) {
      var col = b.columns[c], card = col && col.cards[i];
      if (!card || card.check === null) return null;
      return result([replaceLines(P, card.start, card.start + 1, [setCheck(P.lines[card.start], card.check === ' ')])], { col: c, ci: i });
    }
    function toggleSubCheck(P, b, c, i, off) {
      var col = b.columns[c], card = col && col.cards[i];
      if (!card || !(off >= 1) || card.start + off >= card.end) return null;
      var at = card.start + off, m = matchItem(P.lines[at]);
      if (!m || m.check === null) return null;
      return result([replaceLines(P, at, at + 1, [setCheck(P.lines[at], m.check === ' ')])], { col: c, ci: i });
    }

    function renameColumn(P, b, c, name) {
      var col = b.columns[c];
      name = cleanName(name);
      if (!col || !name) return null;
      return result([replaceLines(P, col.line, col.line + 1, [hashes(col.level) + ' ' + name])], null);
    }

    // New heading (same level) after the last column's section.
    function addColumn(P, b, name) {
      name = cleanName(name);
      if (!name || !b.columns.length) return null;
      var last = b.columns[b.columns.length - 1], q = lastNonBlank(P, last.line, last.sectionEnd);
      var nl = ['', hashes(last.level) + ' ' + name];
      if (q + 1 < P.lines.length && !isBlank(P.lines[q + 1])) nl.push('');
      return result([replaceLines(P, q + 1, q + 1, nl)], null, { col: b.columns.length });
    }

    function deleteColumn(P, b, c, force) {
      var col = b.columns[c];
      if (!col) return null;
      if (col.cards.length) return { error: 'Move or delete its cards first' };
      if (col.sectionEnd > col.bodyEnd) return { error: 'It has sub-headings \u2014 remove them in the editor first' };
      if (b.columns.length <= 2 && !b.marked) return { error: 'A board needs at least two columns' };
      if (col.notes.length && !force) return { confirm: true };
      var a = col.line, e = lastNonBlank(P, a, col.sectionEnd) + 1;
      if ((a === 0 || isBlank(P.lines[a - 1])) && e < P.lines.length && isBlank(P.lines[e])) e++;
      return result([removeLines(P, a, e)], null);
    }

    // The empty-state template, inserted at the cursor line (or the end when the
    // cursor sits in a code fence). Headings go one level below the section the
    // cursor is in so they don't join that section's siblings.
    function createBoard(P, cursorLine, level) {
      var n = P.lines.length, L = Math.max(0, Math.min(cursorLine == null ? n - 1 : cursorLine, n - 1)), k;
      for (var o in P.fenceEnd) if (+o <= L && L <= P.fenceEnd[o]) { L = n - 1; break; }
      if (level == null) {
        level = 2;
        if (!P.marked) {
          for (k = P.heads.length - 1; k >= 0; k--) if (P.heads[k].line <= L) { level = Math.min(Math.max(P.heads[k].level + 1, 2), 4); break; }
        }
      }
      var H = hashes(level), tpl = [H + ' Todo', '- ', '', H + ' Doing', '', H + ' Done'], at, nl;
      if (isBlank(P.lines[L])) {
        at = L;
        nl = (L > 0 && !isBlank(P.lines[L - 1]) ? [''] : []).concat(tpl);
      } else {
        at = L + 1;
        nl = [''].concat(tpl);
        if (at < n && !isBlank(P.lines[at])) nl.push('');
        if (at >= n) nl.push('');
      }
      var first = at + nl.indexOf(tpl[0]);
      return result([replaceLines(P, at, at, nl)], null, { pickLine: first });
    }

    function applyChanges(text, changes) {
      var cs = changes.slice().sort(function (a, b) { return b.from - a.from; });
      cs.forEach(function (c) { text = text.slice(0, c.from) + c.insert + text.slice(c.to); });
      return text;
    }

    return {
      parse: parse, board: board, column: column, pickBoard: pickBoard, matchItem: matchItem,
      indentWidth: indentWidth, isDirective: isDirective, strike: strike,
      moveCard: moveCard, deleteCard: deleteCard, addCards: addCards, editCard: editCard,
      cardEditText: cardEditText, toggleCheck: toggleCheck, toggleSubCheck: toggleSubCheck,
      renameColumn: renameColumn, addColumn: addColumn, deleteColumn: deleteColumn,
      createBoard: createBoard, applyChanges: applyChanges, WIP_RE: WIP_RE,
    };
  })();

  if (typeof window === 'undefined') {           // node: expose the model to kanban.test.js
    if (typeof module === 'object' && module && module.exports) module.exports = Model;
    return;
  }
  if (typeof window.Cade === 'undefined') return;

  // =========================================================================
  // Panel UI
  // =========================================================================
  var Cade = window.Cade;
  Cade.loadCSS('kanban.css');

  var PANEL_ID = 'kanban-panel';
  var PREFS_KEY = 'cade-kanban-prefs';
  var STRIKE_G = /\u0336/g;
  var INLINE_SRC = [
    '`([^`\\n]+)`',                                        // 1 code
    '\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)',     // 2,3 link
    '\\*\\*(?=\\S)([^*\\n]+?)\\*\\*',                      // 4 bold
    '__(?=\\S)([^_\\n]+?)__',                              // 5 bold
    '~~(?=\\S)([^~\\n]+?)~~',                              // 6 strike
    '\\*(?=[^\\s*])([^*\\n]+?)\\*',                        // 7 italic
    '\\b_(?=[^\\s_])([^_\\n]+?)_\\b',                      // 8 italic
    '(https?:\\/\\/[^\\s<>"]*[^\\s<>".,;:!?)\\]\'])',      // 9 bare URL
    '(^|[\\s(\\[])([@#]\\w[\\w-]*)',                       // 10,11 @tag / #tag
    '\\b(\\d{4}-\\d{2}-\\d{2})\\b',                        // 12 date
  ].join('|');

  var prefs = { doneMarks: false };
  var panelEl = null, refreshTimer = 0, pollTimer = 0, filterTimer = 0;
  var S = freshState();
  var TODAY = '';

  function freshState() {
    return {
      doc: null, ro: false, room: undefined, P: null, gi: -1, board: null, key: null, names: null, sig: '',
      html: '', filter: '', expanded: {}, addCol: -1, addDraft: '', focusAdd: false, newCol: false, newColDraft: '',
      editing: null, menu: null, press: null, drag: null, pending: false, justDragged: 0,
    };
  }

  // ---- small utils -----------------------------------------------------------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function toast(msg, type, ms) { try { Cade.showToast(msg, type || 'info', ms || 1800); } catch (e) {} }
  function activeRoom() { try { return Cade.roomsApi ? Cade.roomsApi.activeRoom() : null; } catch (e) { return null; } }
  function loadPrefs() {
    try { var p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}'); if (p && typeof p.doneMarks === 'boolean') prefs.doneMarks = p.doneMarks; } catch (e) {}
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }
  function ymd(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function isCoarse() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
  function intAttr(el, name) { var v = el && el.getAttribute(name); return v == null ? -1 : parseInt(v, 10); }
  function cardRef(el) { var c = el && el.closest('.kb-card'); return c ? { col: intAttr(c, 'data-col'), ci: intAttr(c, 'data-ci') } : null; }
  function colOf(el) { var c = el && el.closest('[data-col]'); return intAttr(c, 'data-col'); }

  // Inline markdown → safe HTML (everything escaped; only http(s) links).
  function inline(s, checked) {
    s = String(s).replace(STRIKE_G, '');
    if (s.length > 600) s = s.slice(0, 600) + '\u2026';
    var re = new RegExp(INLINE_SRC, 'g'), out = '', last = 0, m;
    while ((m = re.exec(s))) {
      out += esc(s.slice(last, m.index));
      if (m[1] != null) out += '<code>' + esc(m[1]) + '</code>';
      else if (m[2] != null) out += '<a href="' + esc(m[3]) + '" target="_blank" rel="noopener noreferrer">' + esc(m[2]) + '</a>';
      else if (m[4] != null || m[5] != null) out += '<strong>' + inline(m[4] != null ? m[4] : m[5], checked) + '</strong>';
      else if (m[6] != null) out += '<s>' + inline(m[6], checked) + '</s>';
      else if (m[7] != null || m[8] != null) out += '<em>' + inline(m[7] != null ? m[7] : m[8], checked) + '</em>';
      else if (m[9] != null) out += '<a href="' + esc(m[9]) + '" target="_blank" rel="noopener noreferrer">' + esc(m[9].length > 48 ? m[9].slice(0, 46) + '\u2026' : m[9]) + '</a>';
      else if (m[11] != null) out += esc(m[10]) + '<span class="kb-chip ' + (m[11].charAt(0) === '@' ? 'kb-at' : 'kb-hash') + '">' + esc(m[11]) + '</span>';
      else if (m[12] != null) {
        var cls = 'kb-chip kb-date' + (m[12] === TODAY ? ' kb-today' : m[12] < TODAY && !checked ? ' kb-overdue' : '');
        out += '<span class="' + cls + '">' + esc(m[12]) + '</span>';
      }
      last = re.lastIndex;
    }
    return out + esc(s.slice(last));
  }

  // ---- parse / sync ------------------------------------------------------------
  function sigOf(P, b) {
    if (!b) return '';
    return b.key + '\u0001' + b.columns.map(function (c) {
      return c.raw + '\u0002' + c.cards.map(function (k) { return P.lines[k.start]; }).join('\u0002');
    }).join('\u0001');
  }

  function reparse(pickLine) {
    var ed = Cade.editor, doc = ed.state.doc;
    var P = Model.parse(doc.toString()), cursor = null;
    if (!S.key) { try { cursor = doc.lineAt(ed.state.selection.main.head).number - 1; } catch (e) {} }
    var gi = Model.pickBoard(P, S.key, S.names, cursor, pickLine);
    S.doc = doc; S.P = P; S.gi = gi;
    S.board = gi >= 0 ? Model.board(P, P.groups[gi]) : null;
    if (S.board) { S.key = P.groups[gi].key; S.names = S.board.columns.map(function (c) { return c.raw; }); }
    S.sig = sigOf(P, S.board);
  }

  function refresh(opts) {
    opts = opts || {};
    if (!panelEl || !panelEl.isConnected) return;
    if (Cade.roomAway && Cade.roomAway(panelEl)) return;   // locked to a room that isn't open: keep showing it
    var ed = Cade.editor;
    if (!ed) return;
    var room = activeRoom();
    if (room !== S.room) {
      // A different room's text: forget the board choice and any open input.
      if (S.room !== undefined) { S.key = null; S.names = null; S.expanded = {}; S.addCol = -1; S.newCol = false; S.editing = null; }
      S.room = room;
      opts.reparse = true;
    }
    if (!opts.force && (S.editing || S.drag || (S.press && S.press.started))) { S.pending = true; return; }
    if (opts.reparse || ed.state.doc !== S.doc) reparse(opts.pickLine);
    S.ro = !!ed.state.readOnly;
    S.pending = false;
    render(opts.focus);
  }

  function scheduleRefresh(ms) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { refresh(); }, ms);
  }

  // Map card refs drawn from the rendered board onto the CURRENT document (it
  // may have changed within the debounce window, or remotely while an edit box
  // was open). Cards are re-found by their first line; null = can't be sure.
  function syncRefs(refs) {
    var ed = Cade.editor;
    if (!ed || activeRoom() !== S.room) return null;
    if (ed.state.doc === S.doc) return refs;
    var oldB = S.board, oldP = S.P;
    var ids = refs.map(function (r) {
      var c = oldB && oldB.columns[r.col], k = c && c.cards[r.ci];
      return { colName: c ? c.raw : null, col: r.col, line: k ? oldP.lines[k.start] : null, ci: r.ci };
    });
    reparse();
    S.html = ''; // force a redraw after the action
    var b = S.board;
    if (!b && refs.length) return null;
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], ci = -1, j;
      if (b.columns[id.col] && b.columns[id.col].raw === id.colName) ci = id.col;
      else for (j = 0; j < b.columns.length; j++) if (b.columns[j].raw === id.colName) { ci = j; break; }
      if (ci < 0) return null;
      var col = b.columns[ci];
      if (id.line == null) { out.push({ col: ci, ci: id.ci >= 0 ? col.cards.length : id.ci }); continue; }
      var k = -1;
      if (col.cards[id.ci] && S.P.lines[col.cards[id.ci].start] === id.line) k = id.ci;
      else for (j = 0; j < col.cards.length; j++) if (S.P.lines[col.cards[j].start] === id.line) { k = j; break; }
      if (k < 0) return null;
      out.push({ col: ci, ci: k });
    }
    return out;
  }

  // Run a board action: re-validate refs, build changes, ONE transaction.
  function mutate(refs, build, opts) {
    opts = opts || {};
    var ed = Cade.editor;
    if (!ed || !panelEl) return false;
    if (ed.state.readOnly) {
      toast('Read-only mode \u2014 editing is locked', 'error', 2000);
      S.html = ''; refresh({ force: true });
      return false;
    }
    var r = syncRefs(refs || []);
    if (!r) {
      toast('The board changed \u2014 try again');
      S.html = ''; refresh({ force: true });
      return false;
    }
    var res = build(S.P, S.board, r);
    if (res && res.confirm && opts.confirm) {
      if (!window.confirm(opts.confirm)) { S.html = ''; refresh({ force: true }); return false; }
      res = build(S.P, S.board, r, true);
    }
    if (!res || res.error || !res.changes || !res.changes.length) {
      if (res && res.error) toast(res.error, 'info', 2200);
      S.html = ''; refresh({ force: true });
      return false;
    }
    var hadFocus = panelEl.contains(document.activeElement);
    ed.dispatch({ changes: res.changes, userEvent: 'input.kanban' });
    if (opts.haptic) Cade.haptic(8);
    if (opts.toast) toast(opts.toast, 'success', 1600);
    // Keep keyboard users on the card they acted on; never pull focus from the editor.
    var wantFocus = opts.focus === false ? false : hadFocus || opts.focus;
    refresh({ force: true, reparse: res.pickLine != null, pickLine: res.pickLine, focus: wantFocus && res.focus ? res.focus : null });
    return res;
  }

  // ---- rendering -----------------------------------------------------------------
  function groupLabel(g) {
    var P = S.P, names = g.heads.map(function (k) { return P.heads[k].raw.replace(Model.WIP_RE, '') || '(untitled)'; });
    var parent = g.marked ? '@kanban' : g.parent >= 0 ? P.heads[g.parent].raw : '';
    var s = (parent ? parent + ': ' : '') + names.join(' \u00b7 ');
    return s.length > 64 ? s.slice(0, 63) + '\u2026' : s;
  }

  function cardInfo(P, card) {
    var subs = P.lines.slice(card.start + 1, card.end), items = 0, checks = 0, done = 0, extra = 0;
    subs.forEach(function (l) {
      if (!l.trim()) return;
      extra++;
      var m = Model.matchItem(l);
      if (m) { items++; if (m.check !== null) { checks++; if (m.check !== ' ') done++; } }
    });
    var text = card.text.replace(STRIKE_G, '');
    return {
      text: text, checked: card.check !== null && card.check !== ' ', hasCheck: card.check !== null,
      subs: subs, items: items, checks: checks, done: done, extra: extra,
      search: (text + '\n' + subs.join('\n')).replace(STRIKE_G, '').toLowerCase(),
    };
  }
  function expandKey(col, P, card) { return col.raw + '\u0001' + P.lines[card.start]; }

  function subsHtml(P, card, info) {
    var base = Infinity, h = '', shown = 0;
    info.subs.forEach(function (l) { if (l.trim()) base = Math.min(base, Model.indentWidth(l)); });
    info.subs.forEach(function (l, k) {
      if (!l.trim() || shown >= 40) return;
      shown++;
      var m = Model.matchItem(l), depth = Math.min(6, Math.round((Model.indentWidth(l) - base) / 2));
      h += '<div class="kb-sub" style="padding-left:' + (depth * 12) + 'px">';
      if (m && m.check !== null) {
        h += '<input type="checkbox" class="kb-subcheck" tabindex="-1" data-off="' + (k + 1) + '"' + (m.check !== ' ' ? ' checked' : '') + (S.ro ? ' disabled' : '') + ' aria-label="Sub-task done">';
      } else if (m) h += '<span class="kb-bullet" aria-hidden="true">\u2022</span>';
      var done = m && m.check !== null && m.check !== ' ';
      h += '<span class="kb-subtext' + (done ? ' kb-subdone' : '') + '">' + inline(m ? m.text : l.trim(), done) + '</span></div>';
    });
    return '<div class="kb-sublist">' + h + '</div>';
  }

  function cardHtml(col, i, j, card, info) {
    var P = S.P, ro = S.ro, open = !!S.expanded[expandKey(col, P, card)];
    var label = info.text.replace(/[*_`~]/g, '').trim() || 'Empty card';
    var h = '<div class="kb-card' + (info.checked ? ' kb-done' : '') + '" tabindex="0" role="listitem" data-col="' + i +
      '" data-ci="' + j + '" aria-label="' + esc(label.slice(0, 120)) + '">';
    if (!ro) h += '<span class="kb-grip" aria-hidden="true" title="Drag to move">\u283f</span>';
    if (info.hasCheck) {
      h += '<input type="checkbox" class="kb-check" tabindex="-1"' + (info.checked ? ' checked' : '') + (ro ? ' disabled' : '') + ' aria-label="Done">';
    }
    h += '<div class="kb-body"><div class="kb-text">' +
      (info.text.trim() ? inline(info.text, info.checked) : '<span class="kb-placeholder">(empty)</span>') + '</div>';
    if (info.extra) {
      var lbl = info.items ? '\u2630 ' + info.items : '\u00b6 ' + info.extra;
      if (info.checks) lbl += ' \u00b7 \u2611 ' + info.done + '/' + info.checks;
      h += '<div class="kb-meta"><button type="button" class="kb-subs' + (open ? ' on' : '') + '" tabindex="-1" aria-expanded="' + open +
        '" title="' + (open ? 'Hide' : 'Show') + ' sub-items">' + lbl + (open ? ' \u25b4' : ' \u25be') + '</button></div>';
      if (open) h += subsHtml(P, card, info);
    }
    h += '</div><div class="kb-acts">' +
      '<button type="button" class="kb-icon kb-goto" tabindex="-1" title="Show in editor" aria-label="Show in editor">\u2197</button>' +
      (ro ? '' : '<button type="button" class="kb-icon kb-edit" tabindex="-1" title="Edit (Enter / double-click)" aria-label="Edit card">\u270e</button>' +
        '<button type="button" class="kb-icon kb-del" tabindex="-1" title="Delete (Del)" aria-label="Delete card">\u00d7</button>') +
      '</div></div>';
    return h;
  }

  function noteHtml(P, col) {
    var lines = col.notes.map(function (i) { return P.lines[i]; }).filter(function (l) { return l.trim() && !/^[ \t]*(```|~~~)/.test(l); });
    if (!lines.length) return '';
    var full = lines.join('\n');
    return '<div class="kb-note" title="' + esc(full.length > 600 ? full.slice(0, 600) + '\u2026' : full) + '">' +
      lines.slice(0, 4).map(function (l) { return inline(l.trim(), false); }).join('<br>') + (lines.length > 4 ? ' \u2026' : '') + '</div>';
  }

  function boardHtml() {
    var b = S.board, P = S.P, ro = S.ro;
    var toks = S.filter.toLowerCase().split(/\s+/).filter(Boolean);
    var h = '<div class="kb-cols">';
    b.columns.forEach(function (col, i) {
      var n = col.cards.length, shown = 0, cards = '';
      col.cards.forEach(function (card, j) {
        var info = cardInfo(P, card);
        for (var t = 0; t < toks.length; t++) if (info.search.indexOf(toks[t]) === -1) return;
        shown++;
        cards += cardHtml(col, i, j, card, info);
      });
      var over = col.wip && n > col.wip;
      var count = toks.length ? shown + ' of ' + n : String(n) + (col.wip ? '/' + col.wip : '');
      var countTitle = toks.length ? shown + ' of ' + n + ' cards match' : n + ' card' + (n === 1 ? '' : 's') + (col.wip ? ' (WIP limit ' + col.wip + ')' : '');
      h += '<section class="kb-col' + (col.done ? ' kb-col-done' : '') + (over ? ' kb-over' : '') + '" data-col="' + i + '" aria-label="' + esc(col.name || 'Untitled') + '">' +
        '<header class="kb-col-head">' +
          '<span class="kb-col-name" title="' + esc(col.raw || '(untitled)') + (ro ? '' : ' \u2014 double-click to rename') + '">' + esc(col.name || '(untitled)') + '</span>' +
          '<span class="kb-count" title="' + esc(countTitle) + '">' + esc(count) + '</span>' +
          '<button type="button" class="kb-icon kb-col-menu" title="Column actions" aria-haspopup="menu" aria-label="Column actions">\u22ef</button>' +
        '</header>' + noteHtml(P, col) +
        '<div class="kb-list" role="list" data-col="' + i + '">' + cards +
          (shown ? '' : '<div class="kb-empty">' + (toks.length && n ? 'No matches' : 'No cards') + '</div>') +
        '</div>';
      if (!ro) {
        h += S.addCol === i
          ? '<div class="kb-add-wrap kb-adding"><textarea class="kb-input kb-add-input" rows="2" placeholder="Card text \u2014 Enter to add, Shift+Enter for a new line (one card per line)" aria-label="New card"></textarea>' +
            '<div class="kb-row"><button type="button" class="kb-btn primary kb-add-ok">Add card</button><button type="button" class="kb-btn kb-add-cancel">Cancel</button></div></div>'
          : '<div class="kb-add-wrap"><button type="button" class="kb-add">+ Add card</button></div>';
      }
      h += '</section>';
    });
    if (!ro) {
      h += S.newCol
        ? '<div class="kb-newcol kb-adding"><input class="kb-input kb-newcol-input" type="text" placeholder="Column name" aria-label="New column name">' +
          '<div class="kb-row"><button type="button" class="kb-btn primary kb-newcol-ok">Add column</button><button type="button" class="kb-btn kb-newcol-cancel">Cancel</button></div></div>'
        : '<div class="kb-newcol"><button type="button" class="kb-add kb-add-col">+ Add column</button></div>';
    }
    return h + '</div>';
  }

  function emptyHtml() {
    return '<div class="kb-es"><div class="kb-es-icon" aria-hidden="true">\ud83d\udccb</div>' +
      '<p class="kb-es-title">No board in this document yet</p>' +
      '<p class="kb-es-hint">A board is two or more headings at the same level \u2014 <code>## Todo</code>, <code>## Doing</code>, <code>## Done</code> \u2014 ' +
      'with list items under them as cards. A line with <code>@kanban</code> makes every <code>##</code> heading a column.</p>' +
      (S.ro ? '<p class="kb-es-hint">Read-only mode is on.</p>' : '<button type="button" class="kb-btn primary kb-create">Create board here</button>') +
      '</div>';
  }

  function renderBar() {
    var p = panelEl, P = S.P, gs = P ? P.groups : [];
    var sel = p.querySelector('.kb-board');
    var opts = gs.map(function (g, i) { return '<option value="' + i + '">' + esc(groupLabel(g)) + '</option>'; }).join('') +
      (S.ro || !gs.length ? '' : '<option value="new">\uff0b New board at cursor\u2026</option>');
    if (sel._kbHtml !== opts) { sel.innerHTML = opts; sel._kbHtml = opts; }
    sel.hidden = !gs.length;
    if (S.gi >= 0) sel.value = String(S.gi);
    var sum = '';
    if (S.board) {
      var total = 0, done = 0;
      S.board.columns.forEach(function (c) {
        total += c.cards.length;
        c.cards.forEach(function (k) { if (k.check !== null && k.check !== ' ') done++; });
      });
      sum = total + ' card' + (total === 1 ? '' : 's') + (done ? ' \u00b7 ' + done + ' done' : '');
    }
    p.querySelector('.kb-sum').textContent = sum;
    p.querySelector('.kb-ro').hidden = !S.ro;
    var tog = p.querySelector('.kb-done-tog');
    tog.hidden = S.ro || !S.board;
    tog.classList.toggle('on', prefs.doneMarks);
    tog.setAttribute('aria-pressed', prefs.doneMarks ? 'true' : 'false');
    p.querySelector('.kb-filter').hidden = !S.board;
  }

  function render(focusReq) {
    var p = panelEl;
    if (!p) return;
    TODAY = ymd(new Date());
    renderBar();
    var main = p.querySelector('.kb-main');
    var html = S.board ? boardHtml() : emptyHtml();
    if (html !== S.html) {
      closeMenu();
      var cols = main.querySelector('.kb-cols'), sl = cols ? cols.scrollLeft : 0, tops = [];
      if (cols) [].forEach.call(cols.querySelectorAll('.kb-list'), function (l) { tops.push(l.scrollTop); });
      var ae = document.activeElement, keep = null;
      if (ae && main.contains(ae)) {
        var c = ae.closest('.kb-card');
        if (c) keep = { col: intAttr(c, 'data-col'), ci: intAttr(c, 'data-ci') };
        else if (ae.classList.contains('kb-add-input')) S.focusAdd = true;
        else if (ae.classList.contains('kb-newcol-input')) keep = { newCol: true };
      }
      main.innerHTML = html;
      S.html = html;
      cols = main.querySelector('.kb-cols');
      if (cols) {
        cols.scrollLeft = sl;
        [].forEach.call(cols.querySelectorAll('.kb-list'), function (l, i) { if (tops[i]) l.scrollTop = tops[i]; });
      }
      if (!focusReq && keep && keep.col != null) focusReq = keep;
      var ta = main.querySelector('.kb-add-input');
      if (ta) {
        ta.value = S.addDraft;
        autosize(ta);
        if (S.focusAdd) {
          S.focusAdd = false;
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
          var list = ta.closest('.kb-col').querySelector('.kb-list');
          if (list) list.scrollTop = list.scrollHeight;
          ta.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
      var ni = main.querySelector('.kb-newcol-input');
      if (ni) {
        ni.value = S.newColDraft;
        if (keep && keep.newCol || S.focusNewCol) { S.focusNewCol = false; ni.focus(); ni.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
      }
    }
    if (focusReq) focusCard(focusReq.col, focusReq.ci);
  }

  function cardEl(col, ci) { return panelEl ? panelEl.querySelector('.kb-card[data-col="' + col + '"][data-ci="' + ci + '"]') : null; }
  function focusCard(col, ci) {
    if (!panelEl) return;
    var el = cardEl(col, ci);
    if (!el) {
      var cards = panelEl.querySelectorAll('.kb-col[data-col="' + col + '"] .kb-card');
      el = cards[Math.min(Math.max(ci, 0), cards.length - 1)];
    }
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 220) + 'px'; }

  // ---- actions ----------------------------------------------------------------------
  function toggleCheckAt(ref) {
    mutate([ref], function (P, b, r) { return Model.toggleCheck(P, b, r[0].col, r[0].ci); });
  }
  function toggleSubAt(ref, off) {
    mutate([ref], function (P, b, r) { return Model.toggleSubCheck(P, b, r[0].col, r[0].ci, off); });
  }
  function deleteCardAt(ref) {
    mutate([ref], function (P, b, r) { return Model.deleteCard(P, b, r[0].col, r[0].ci); }, { toast: 'Card deleted \u2014 Ctrl+Z to undo' });
  }
  function moveRef(ref, tc, before, focus) {
    var col = S.board.columns[tc];
    var dest = { col: tc, ci: Math.min(before, col.cards.length) };
    // A destination of "end of column" is re-found by column, not by card.
    if (dest.ci >= col.cards.length) dest.ci = Infinity;
    mutate([ref, dest], function (P, b, r) {
      var to = r[1].ci === Infinity ? b.columns[r[1].col].cards.length : r[1].ci;
      return Model.moveCard(P, b, r[0].col, r[0].ci, r[1].col, to, { doneMarks: prefs.doneMarks });
    }, { haptic: true, focus: focus });
  }
  function keyMove(ref, dir) {
    var b = S.board, col = b && b.columns[ref.col];
    if (!col) return;
    if (dir === 'up') { if (ref.ci > 0) moveRef(ref, ref.col, ref.ci - 1, true); }
    else if (dir === 'down') { if (ref.ci < col.cards.length - 1) moveRef(ref, ref.col, ref.ci + 2, true); }
    else {
      var tc = ref.col + (dir === 'left' ? -1 : 1);
      if (tc >= 0 && tc < b.columns.length) moveRef(ref, tc, Math.min(ref.ci, b.columns[tc].cards.length), true);
    }
  }

  function jumpToLine(line) {
    var ed = Cade.editor, doc = ed.state.doc;
    if (line < 0 || line >= doc.lines) return;
    var l = doc.line(line + 1), EV = Cade.CM && Cade.CM.EditorView;
    var spec = { selection: { anchor: l.from } };
    if (EV && EV.scrollIntoView) spec.effects = EV.scrollIntoView(l.from, { y: 'center' });
    ed.dispatch(spec);
    ed.focus();
  }
  function gotoCard(ref) {
    var r = syncRefs([ref]);
    if (!r) { toast('The board changed \u2014 try again'); refresh({ force: true }); return; }
    var card = S.board.columns[r[0].col].cards[r[0].ci];
    if (card) jumpToLine(card.start);
  }

  // -- card edit (in place) --
  function startEdit(ref) {
    if (S.ro || S.editing || !ref || !S.board) return;
    var col = S.board.columns[ref.col], card = col && col.cards[ref.ci], el = cardEl(ref.col, ref.ci);
    if (!card || !el) return;
    closeMenu();
    var val = Model.cardEditText(S.P, card);
    var body = el.querySelector('.kb-body');
    body.innerHTML = '<textarea class="kb-input kb-edit-input" rows="1" aria-label="Card text"></textarea>' +
      '<div class="kb-edit-hint">Enter saves \u00b7 Shift+Enter new line \u00b7 Esc cancels</div>';
    el.classList.add('kb-editing');
    S.html = ''; // the DOM no longer matches the cached render
    var ta = body.querySelector('textarea');
    ta.value = val;
    S.editing = { kind: 'card', col: ref.col, ci: ref.ci, orig: val, el: ta };
    autosize(ta);
    ta.focus();
    var e1 = val.indexOf('\n');
    ta.setSelectionRange(e1 < 0 ? val.length : e1, e1 < 0 ? val.length : e1);
    ta.addEventListener('input', function () { autosize(ta); });
    ta.addEventListener('blur', function () { if (S.editing && S.editing.el === ta) commitEdit(false); });
  }
  function commitEdit(cancel) {
    var E = S.editing;
    if (!E) return;
    S.editing = null;
    var v = E.el.value;
    if (E.kind === 'card') {
      if (cancel || v === E.orig || !v.trim()) { S.html = ''; refresh({ force: true, focus: cancel ? { col: E.col, ci: E.ci } : null }); return; }
      mutate([{ col: E.col, ci: E.ci }], function (P, b, r) { return Model.editCard(P, b, r[0].col, r[0].ci, v); });
    } else {
      v = v.trim();
      if (cancel || !v || v === E.orig) { S.html = ''; refresh({ force: true }); return; }
      mutate([{ col: E.col, ci: Infinity }], function (P, b, r) { return Model.renameColumn(P, b, r[0].col, v); });
    }
  }

  // -- column rename (in place) --
  function startRename(i) {
    if (S.ro || S.editing || !S.board || !S.board.columns[i]) return;
    var nameEl = panelEl.querySelector('.kb-col[data-col="' + i + '"] .kb-col-name');
    if (!nameEl) return;
    closeMenu();
    var raw = S.board.columns[i].raw;
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'kb-input kb-rename-input';
    inp.setAttribute('aria-label', 'Column name');
    inp.value = raw;
    nameEl.parentNode.replaceChild(inp, nameEl);
    S.html = '';
    S.editing = { kind: 'rename', col: i, orig: raw, el: inp };
    inp.focus();
    inp.select();
    inp.addEventListener('blur', function () { if (S.editing && S.editing.el === inp) commitEdit(false); });
  }

  // -- add card / column --
  function openAdd(i) {
    if (S.ro) return;
    if (S.addCol !== i) S.addDraft = '';
    S.addCol = i; S.focusAdd = true; S.html = '';
    render();
  }
  function closeAdd() { S.addCol = -1; S.addDraft = ''; S.html = ''; render(); }
  function splitCards(v) {
    // Pasted lists arrive with their bullets/checkboxes; the card style comes from the column.
    return String(v).split(/\r?\n/).map(function (l) {
      return l.replace(/^\s*(?:[-*+\u2022]|\d{1,9}[.)])\s+/, '').replace(/^\[[ xX]\]\s*/, '').trim();
    }).filter(Boolean);
  }
  function commitAdd() {
    var ta = panelEl.querySelector('.kb-add-input');
    var texts = splitCards(ta ? ta.value : S.addDraft);
    if (!texts.length) { if (ta) ta.focus(); return; }
    var col = S.addCol;
    S.addDraft = ''; S.focusAdd = true;
    mutate([{ col: col, ci: Infinity }], function (P, b, r) {
      S.addCol = r[0].col;
      return Model.addCards(P, b, r[0].col, texts, { doneMarks: prefs.doneMarks });
    }, { focus: false });
  }
  function openNewCol() { if (S.ro) return; S.newCol = true; S.newColDraft = ''; S.focusNewCol = true; S.html = ''; render(); }
  function closeNewCol() { S.newCol = false; S.newColDraft = ''; S.html = ''; render(); }
  function commitNewCol() {
    var inp = panelEl.querySelector('.kb-newcol-input'), v = (inp ? inp.value : S.newColDraft).trim();
    if (!v) { closeNewCol(); return; }
    S.newCol = false; S.newColDraft = '';
    var ok = mutate([], function (P, b) { return Model.addColumn(P, b, v); });
    if (ok) {
      setTimeout(function () {
        var cols = panelEl && panelEl.querySelector('.kb-cols');
        if (cols) cols.scrollLeft = cols.scrollWidth;
      }, 0);
    }
  }

  function deleteColumnAt(i) {
    var col = S.board && S.board.columns[i];
    if (!col) return;
    mutate([{ col: i, ci: Infinity }], function (P, b, r, force) { return Model.deleteColumn(P, b, r[0].col, force); },
      { confirm: 'Delete column "' + (col.name || 'untitled') + '" and its note text?', toast: 'Column deleted \u2014 Ctrl+Z to undo' });
  }

  function createBoardAtCursor() {
    var ed = Cade.editor;
    if (!ed) return;
    S.key = null; S.names = null;
    mutate([], function (P) {
      var line = 0;
      try { line = ed.state.doc.lineAt(ed.state.selection.main.head).number - 1; } catch (e) {}
      return Model.createBoard(P, line, null);
    }, { toast: 'Board created \u2014 Ctrl+Z to undo' });
  }

  // -- column menu --
  function closeMenu() {
    if (S.menu) { S.menu.el.remove(); S.menu = null; }
  }
  function toggleMenu(btn) {
    var i = colOf(btn), same = S.menu && S.menu.btn === btn;
    closeMenu();
    if (same || !S.board || !S.board.columns[i]) return;
    var col = S.board.columns[i], ro = S.ro;
    var canDel = !col.cards.length && col.sectionEnd <= col.bodyEnd && (S.board.columns.length > 2 || S.board.marked);
    var m = document.createElement('div');
    m.className = 'kb-menu';
    m.setAttribute('role', 'menu');
    m.innerHTML =
      (ro ? '' : '<button type="button" role="menuitem" class="kb-menu-item" data-act="add">+ Add card</button>' +
        '<button type="button" role="menuitem" class="kb-menu-item" data-act="rename">\u270e Rename</button>') +
      '<button type="button" role="menuitem" class="kb-menu-item" data-act="jump">\u2197 Show heading in editor</button>' +
      (ro ? '' : '<button type="button" role="menuitem" class="kb-menu-item kb-danger" data-act="del"' + (canDel ? '' : ' disabled title="Only an empty column can be deleted"') + '>\u00d7 Delete column</button>');
    panelEl.appendChild(m);
    var pr = panelEl.getBoundingClientRect(), br = btn.getBoundingClientRect();
    var left = Math.min(br.right - pr.left - m.offsetWidth, pr.width - m.offsetWidth - 6);
    m.style.left = Math.max(6, left) + 'px';
    m.style.top = (br.bottom - pr.top + 2) + 'px';
    S.menu = { el: m, btn: btn, col: i };
    var first = m.querySelector('button:not([disabled])');
    if (first && panelEl.contains(document.activeElement)) first.focus();
  }
  function menuAction(act) {
    var i = S.menu ? S.menu.col : -1;
    closeMenu();
    if (i < 0 || !S.board || !S.board.columns[i]) return;
    if (act === 'add') openAdd(i);
    else if (act === 'rename') startRename(i);
    else if (act === 'jump') {
      var r = syncRefs([{ col: i, ci: Infinity }]);
      if (r) jumpToLine(S.board.columns[r[0].col].line);
    } else if (act === 'del') deleteColumnAt(i);
  }

  // ---- drag & drop (pointer events: mouse, pen, touch) ------------------------------
  // Mouse/pen: drag after a 5px move. Touch: long-press (300ms) anywhere on the
  // card, or drag the grip right away — so a plain swipe still scrolls.
  function onPointerDown(e) {
    if (S.ro || S.drag || S.press || e.button > 0) return;
    var t = e.target;
    var card = t.closest && t.closest('.kb-card');
    if (!card || !panelEl.contains(card) || card.classList.contains('kb-editing')) return;
    var grip = !!t.closest('.kb-grip');
    if (!grip && t.closest('input, textarea, button, a, select, .kb-sublist')) return;
    S.press = {
      id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, el: card,
      col: intAttr(card, 'data-col'), ci: intAttr(card, 'data-ci'),
      touch: e.pointerType === 'touch', grip: grip, timer: 0, started: false,
    };
    if (S.press.touch && !grip) S.press.timer = setTimeout(function () { if (S.press && !S.drag) startDrag(); }, 300);
    if (grip) e.preventDefault();
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
      if (pr.touch && !pr.grip) { if (d > 10) endPress(); return; } // a scroll, not a drag
      if (d < 6) return;
      startDrag();
    }
    e.preventDefault();
    moveGhost();
    updateTarget();
  }
  function onPointerUp(e) {
    if (!S.press || e.pointerId !== S.press.id) return;
    var dragging = !!S.drag;
    if (dragging) drop();
    endPress();
  }
  function onPointerCancel() { if (S.drag) cancelDrag(); endPress(); }
  function endPress() {
    if (S.press) clearTimeout(S.press.timer);
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
    pr.started = true;
    var el = pr.el, r = el.getBoundingClientRect();
    var ghost = el.cloneNode(true);
    ghost.classList.add('kb-ghost');
    ghost.removeAttribute('tabindex');
    ghost.style.width = r.width + 'px';
    document.body.appendChild(ghost);
    var ph = document.createElement('div');
    ph.className = 'kb-ph';
    ph.style.height = r.height + 'px';
    el.parentNode.insertBefore(ph, el);
    el.classList.add('kb-dragging');
    panelEl.classList.add('kb-is-dragging');
    document.documentElement.classList.add('kb-noselect');
    window.addEventListener('keydown', onDragKey, true); // the hidden card may have lost focus
    S.drag = { el: el, ghost: ghost, ph: ph, offX: pr.x - r.left, offY: pr.y - r.top, col: pr.col, ci: pr.ci, target: { col: pr.col, before: pr.ci + 1 }, raf: 0, colEl: null };
    moveGhost();
    Cade.haptic(10);
    S.drag.raf = requestAnimationFrame(autoScroll);
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
    var colEl = hit && hit.closest ? hit.closest('.kb-col') : null;
    if (!colEl || !panelEl.contains(colEl)) return; // keep the last valid target
    var col = intAttr(colEl, 'data-col'), list = colEl.querySelector('.kb-list');
    if (!list || !S.board.columns[col]) return;
    var cards = list.querySelectorAll('.kb-card:not(.kb-dragging)'), before = null;
    for (var i = 0; i < cards.length; i++) {
      var r = cards[i].getBoundingClientRect();
      if (pr.ly < r.top + r.height / 2) { before = cards[i]; break; }
    }
    if (before) { if (d.ph.nextSibling !== before) list.insertBefore(d.ph, before); }
    else {
      var lastCard = cards[cards.length - 1];
      var ref = lastCard ? lastCard.nextSibling : list.firstChild;
      if (d.ph !== ref && d.ph.nextSibling !== ref) list.insertBefore(d.ph, ref);
    }
    d.target = { col: col, before: before ? intAttr(before, 'data-ci') : S.board.columns[col].cards.length };
    if (d.colEl !== colEl) {
      if (d.colEl) d.colEl.classList.remove('kb-drop');
      colEl.classList.add('kb-drop');
      d.colEl = colEl;
    }
  }
  // Edge auto-scroll: sideways across columns, vertically within a column.
  function autoScroll() {
    var d = S.drag, pr = S.press;
    if (!d || !pr || !panelEl) return;
    var cols = panelEl.querySelector('.kb-cols'), moved = false;
    if (cols) {
      var r = cols.getBoundingClientRect(), edge = 44, dx = 0;
      if (pr.lx < r.left + edge) dx = -Math.min(18, Math.ceil((r.left + edge - pr.lx) / 3));
      else if (pr.lx > r.right - edge) dx = Math.min(18, Math.ceil((pr.lx - r.right + edge) / 3));
      if (dx) { var b0 = cols.scrollLeft; cols.scrollLeft += dx; moved = cols.scrollLeft !== b0; }
    }
    var list = d.colEl && d.colEl.querySelector('.kb-list');
    if (list) {
      var lr = list.getBoundingClientRect(), dy = 0;
      if (pr.ly < lr.top + 30) dy = -Math.min(14, Math.ceil((lr.top + 30 - pr.ly) / 3));
      else if (pr.ly > lr.bottom - 30) dy = Math.min(14, Math.ceil((pr.ly - lr.bottom + 30) / 3));
      if (dy) { var t0 = list.scrollTop; list.scrollTop += dy; moved = moved || list.scrollTop !== t0; }
    }
    if (moved) updateTarget();
    d.raf = requestAnimationFrame(autoScroll);
  }
  function teardownDrag() {
    var d = S.drag;
    if (!d) return;
    cancelAnimationFrame(d.raf);
    d.ghost.remove();
    d.ph.remove();
    d.el.classList.remove('kb-dragging');
    if (d.colEl) d.colEl.classList.remove('kb-drop');
    if (panelEl) panelEl.classList.remove('kb-is-dragging');
    document.documentElement.classList.remove('kb-noselect');
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
    var d = S.drag, t = d.target;
    teardownDrag();
    S.justDragged = Date.now();
    if (t && !(t.col === d.col && (t.before === d.ci || t.before === d.ci + 1))) moveRef({ col: d.col, ci: d.ci }, t.col, t.before, false);
    else { S.html = ''; refresh({ force: true }); }
  }
  function cancelDrag() { teardownDrag(); S.html = ''; refresh({ force: true }); }

  // ---- events ------------------------------------------------------------------------
  function onClick(e) {
    var t = e.target, b;
    if (!t.closest) return;
    if (Date.now() - S.justDragged < 350) { e.preventDefault(); return; }
    if (S.menu && !t.closest('.kb-menu') && !t.closest('.kb-col-menu')) closeMenu();
    if ((b = t.closest('.kb-menu-item'))) { if (!b.disabled) menuAction(b.getAttribute('data-act')); return; }
    if ((b = t.closest('.kb-col-menu'))) { toggleMenu(b); return; }
    if ((b = t.closest('.kb-goto'))) { gotoCard(cardRef(b)); return; }
    if ((b = t.closest('.kb-edit'))) { startEdit(cardRef(b)); return; }
    if ((b = t.closest('.kb-del'))) { deleteCardAt(cardRef(b)); return; }
    if ((b = t.closest('.kb-subs'))) {
      var ref = cardRef(b), col = S.board.columns[ref.col], card = col && col.cards[ref.ci];
      if (card) {
        var k = expandKey(col, S.P, card);
        if (S.expanded[k]) delete S.expanded[k]; else S.expanded[k] = 1;
        S.html = ''; render();
      }
      return;
    }
    if (t.closest('.kb-add-ok')) { commitAdd(); return; }
    if (t.closest('.kb-add-cancel')) { closeAdd(); return; }
    if (t.closest('.kb-add-col')) { openNewCol(); return; }
    if (t.closest('.kb-newcol-ok')) { commitNewCol(); return; }
    if (t.closest('.kb-newcol-cancel')) { closeNewCol(); return; }
    if ((b = t.closest('.kb-add'))) { openAdd(colOf(b)); return; }
    if (t.closest('.kb-create')) { createBoardAtCursor(); return; }
    if (t.closest('.kb-done-tog')) {
      prefs.doneMarks = !prefs.doneMarks;
      savePrefs();
      renderBar();
      toast(prefs.doneMarks ? 'Cards moved into a Done column get checked off' : 'Moving cards no longer changes their checkboxes');
    }
  }
  function onDblClick(e) {
    var t = e.target;
    if (!t.closest || S.ro) return;
    var n = t.closest('.kb-col-name');
    if (n) { startRename(colOf(n)); return; }
    if (t.closest('input, textarea, button, a, .kb-sublist')) return;
    var c = t.closest('.kb-card');
    if (c) { e.preventDefault(); startEdit(cardRef(c)); }
  }
  function onChange(e) {
    var t = e.target;
    if (t.classList.contains('kb-check')) toggleCheckAt(cardRef(t));
    else if (t.classList.contains('kb-subcheck')) toggleSubAt(cardRef(t), intAttr(t, 'data-off'));
    else if (t.classList.contains('kb-board')) {
      var v = t.value;
      if (v === 'new') { t.value = String(S.gi); createBoardAtCursor(); return; }
      var g = S.P && S.P.groups[+v];
      if (!g) return;
      S.key = g.key; S.names = null; S.addCol = -1; S.newCol = false;
      refresh({ force: true, reparse: true });
    }
  }
  function onInput(e) {
    var t = e.target;
    if (t.classList.contains('kb-filter')) {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(function () { S.filter = t.value.trim(); render(); }, 80);
    } else if (t.classList.contains('kb-add-input')) { S.addDraft = t.value; autosize(t); }
    else if (t.classList.contains('kb-newcol-input')) S.newColDraft = t.value;
  }
  function onFocusOut(e) {
    // An empty "add" box closes when focus leaves it; a draft stays open.
    var t = e.target;
    if (t.classList && t.classList.contains('kb-add-input') && !t.value.trim()) {
      setTimeout(function () {
        var ae = document.activeElement;
        if (S.addCol >= 0 && !S.addDraft.trim() && !(ae && ae.closest && ae.closest('.kb-adding'))) closeAdd();
      }, 0);
    } else if (t.classList && t.classList.contains('kb-newcol-input') && !t.value.trim()) {
      setTimeout(function () { if (S.newCol && !S.newColDraft.trim() && !(document.activeElement && document.activeElement.closest && document.activeElement.closest('.kb-adding'))) closeNewCol(); }, 0);
    }
  }

  function navFocus(cardElm, dir) {
    var list = cardElm.parentNode, cards = [].slice.call(list.querySelectorAll('.kb-card')), i = cards.indexOf(cardElm), next = null;
    if (dir === 'up') next = cards[i - 1];
    else if (dir === 'down') next = cards[i + 1];
    else {
      var cols = [].slice.call(panelEl.querySelectorAll('.kb-col')), c = cols.indexOf(cardElm.closest('.kb-col')), step = dir === 'left' ? -1 : 1;
      for (var k = c + step; k >= 0 && k < cols.length && !next; k += step) {
        var cc = cols[k].querySelectorAll('.kb-card');
        if (cc.length) next = cc[Math.min(i, cc.length - 1)];
      }
    }
    if (next) { try { next.focus({ preventScroll: true }); } catch (e) { next.focus(); } next.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }

  function onKey(e) {
    var t = e.target, k = e.key, mod = e.ctrlKey || e.metaKey;
    var field = t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'checkbox');
    if (field) {
      e.stopPropagation(); // typing here must not trigger editor / global shortcuts
      var cl = t.classList;
      if (cl.contains('kb-edit-input') || cl.contains('kb-rename-input')) {
        if (k === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); commitEdit(false); }
        else if (k === 'Escape') { e.preventDefault(); commitEdit(true); }
      } else if (cl.contains('kb-add-input')) {
        if (k === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); commitAdd(); }
        else if (k === 'Escape') { e.preventDefault(); closeAdd(); }
      } else if (cl.contains('kb-newcol-input')) {
        if (k === 'Enter' && !e.isComposing) { e.preventDefault(); commitNewCol(); }
        else if (k === 'Escape') { e.preventDefault(); closeNewCol(); }
      } else if (cl.contains('kb-filter')) {
        if (k === 'Escape') {
          e.preventDefault();
          if (t.value) { t.value = ''; S.filter = ''; render(); } else close(true);
        } else if (k === 'ArrowDown' || k === 'Enter') {
          var first = panelEl.querySelector('.kb-card');
          if (first) { e.preventDefault(); first.focus(); }
        }
      }
      return;
    }
    var handled = true;
    var card = t.closest && t.closest('.kb-card');
    var ref = card ? cardRef(card) : null;
    if (k === 'Escape') {
      if (S.drag) { cancelDrag(); endPress(); }
      else if (S.menu) { var mb = S.menu.btn; closeMenu(); if (mb && mb.isConnected) mb.focus(); }
      else close(true);
    } else if (mod && !e.altKey && (k === 'z' || k === 'Z' || k === 'y' || k === 'Y')) {
      // Undo/redo the document from inside the panel (focus is not in the editor).
      var redo = k === 'y' || k === 'Y' || e.shiftKey, ed = Cade.editor;
      if (ed && Cade.CM && (redo ? Cade.CM.redo : Cade.CM.undo)) {
        (redo ? Cade.CM.redo : Cade.CM.undo)(ed);
        refresh({ focus: ref });
      }
    } else if (ref && e.altKey && !mod && /^Arrow/.test(k)) {
      if (!S.ro) keyMove(ref, k.slice(5).toLowerCase());
    } else if (card && !e.altKey && !mod && /^Arrow/.test(k)) {
      navFocus(card, k.slice(5).toLowerCase());
    } else if (ref && !mod && (k === 'Enter' || k === 'F2')) {
      startEdit(ref);
    } else if (ref && !mod && (k === ' ' || k === 'x')) {
      var col = S.board && S.board.columns[ref.col], c = col && col.cards[ref.ci];
      if (c && c.check !== null && !S.ro) toggleCheckAt(ref);
    } else if (ref && !mod && (k === 'Delete' || k === 'Backspace')) {
      if (!S.ro) deleteCardAt(ref);
    } else if (k === '/' && !mod) {
      var f = panelEl.querySelector('.kb-filter');
      if (f && !f.hidden) f.focus();
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  function onWheel(e) {
    // A vertical wheel over the board's background / headers scrolls columns sideways.
    var cols = panelEl && panelEl.querySelector('.kb-cols');
    if (!cols || !cols.contains(e.target) || Math.abs(e.deltaY) <= Math.abs(e.deltaX) || e.shiftKey) return;
    var list = e.target.closest('.kb-list, .kb-sublist, textarea');
    if (list && list.scrollHeight > list.clientHeight + 1) return;
    if (cols.scrollWidth <= cols.clientWidth) return;
    cols.scrollLeft += e.deltaY;
    e.preventDefault();
  }
  // Once a touch drag has started, stop the browser from also scrolling.
  function onTouchMove(e) { if (S.drag) e.preventDefault(); }
  function onContextMenu(e) { if (S.press || S.drag) e.preventDefault(); }
  function onMouseDown(e) {
    // Keep focus in the add/rename box when its buttons are clicked.
    if (e.target.closest && e.target.closest('.kb-add-ok, .kb-add-cancel, .kb-newcol-ok, .kb-newcol-cancel')) e.preventDefault();
  }
  function onResize() {
    if (!panelEl) return;
    var r = panelEl.getBoundingClientRect();
    if (r.right > window.innerWidth) panelEl.style.left = Math.max(0, window.innerWidth - r.width - 8) + 'px';
    if (r.top > window.innerHeight - 60) panelEl.style.top = Math.max(0, window.innerHeight - 120) + 'px';
  }

  function poll() {
    if (!panelEl || !panelEl.isConnected) { cleanup(); return; }
    if (document.hidden) return;
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.doc !== S.doc || !!ed.state.readOnly !== S.ro || activeRoom() !== S.room) refresh();
  }

  // Update hook: cheap no-op while the panel is closed or nothing changed.
  Cade.onEditorUpdate(function (u) {
    if (!panelEl || !u.docChanged) return;
    scheduleRefresh(150);
  });

  // ---- open / close ---------------------------------------------------------------------
  function cleanup() {
    clearTimeout(refreshTimer); clearTimeout(filterTimer); clearInterval(pollTimer);
    refreshTimer = filterTimer = pollTimer = 0;
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
    var p = Cade.mkPanel(PANEL_ID, '\ud83d\udccb Kanban',
      '<div class="kb-bar">' +
        '<select class="kb-board" aria-label="Board" hidden></select>' +
        '<input class="kb-filter" type="search" placeholder="Filter cards\u2026" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Filter cards">' +
        '<span class="kb-sum" aria-live="polite"></span>' +
        '<button type="button" class="kb-tog kb-done-tog" aria-pressed="false" title="When on, moving a card into a Done column checks it off (and moving it out unchecks it)">\u2611 Auto-check in Done</button>' +
        '<span class="kb-ro" hidden title="Read-only mode is on \u2014 the board is view-only">\ud83d\udd12 Read-only</span>' +
      '</div>' +
      '<div class="kb-main"></div>' +
      '<div class="kb-hint"><span class="kb-hint-fine">Drag cards \u00b7 double-click to edit \u00b7 focus a card: Alt+\u2190/\u2192 change column, Alt+\u2191/\u2193 reorder, Space ticks \u00b7 Ctrl+Z undoes</span>' +
      '<span class="kb-hint-coarse">Long-press a card (or drag \u283f) to move it \u00b7 swipe for more columns \u00b7 \u270e edits</span></div>');
    panelEl = p;
    // Wide and centred; mkPanel's header drag takes over from these inline values.
    var w = Math.min(960, window.innerWidth - 24);
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
    p.addEventListener('wheel', onWheel, { passive: false });
    p.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('resize', onResize);
    pollTimer = setInterval(poll, 800);
    // Lock to a room (Origami, Ctrl+P…): refresh whenever its room is the open one again.
    if (Cade.roomLock) { Cade.roomLock(p); p.addEventListener('cade-panel-room', function () { refresh(); }); }
    p.classList.toggle('kb-coarse', isCoarse());
    refresh({ force: true });
  }

  Cade.registerWidget({
    name: 'Kanban Board',
    description: 'Turn the document\u2019s headings into columns and list items into drag-and-drop cards',
    icon: '\ud83d\udccb',
    tags: 'kanban,board,todo,tasks,columns,trello,project,cards,drag,planning',
    open: open,
  });
})();
