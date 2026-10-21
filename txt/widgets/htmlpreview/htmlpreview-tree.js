/* Live Preview — tree views for XML, SOAP and JSON (lazy: loaded with the
 * Markdown renderer). Exposes window.__cadeTreeView (module.exports in node):
 *
 *   build(core, lang, text, o) -> { h, tk, data }   (app side)
 *     lang 'xml' | 'soap' | 'json'; core = markup-core.js; o = { line: editor line of the
 *     text's first line, off: content offset from the block's line (1 for a fenced
 *     block), parsed: a parseXML result to reuse, highlight(code, lang), hash(s) }.
 *     h is the block's HTML: a head (kind, counts, SOAP / Tree / Source, expand /
 *     collapse all), a well-formedness error with line / column and a "Go to line",
 *     the SOAP view (Header entries, the Body operation + namespace, parameters as
 *     nested key / value tables, a Fault up front) and a placeholder for the tree;
 *     data is the tree (sent to the frame separately, keyed by tk).
 *   ext() -> { css, js }    for the preview's shell document: js mounts trees in
 *     the sandboxed frame (window.__cadeTV), building rows only when a node opens,
 *     children in chunks of 250; tap a row to open / close it and see its XPath
 *     (JSONPath for JSON) with Copy buttons; double-click an element to jump to it.
 *   staticize(html, trees) -> html with every tree drawn as nested <details>
 *     (Copy / Open in a new tab: no scripts there).
 * ES5. */
(function (root) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  var SRC_MAX = 300000;      // characters of source shown highlighted in the Source pane
  var TABLE_ROWS = 1000;     // rows per SOAP parameter table
  var STATIC_MAX = 5000;     // nodes drawn by staticize()

  // ---- row HTML, shared by the frame (shipped via toString) and staticize() -------------------------
  function TV_ROWS() {
    var TEXT_MAX = 3000;
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function cut(s) { s = String(s); return s.length > TEXT_MAX ? esc(s.slice(0, TEXT_MAX)) + '<span class="tv-more-t">… ' + (s.length - TEXT_MAX) + ' more characters</span>' : esc(s); }
    function qn(n) { var c = n.indexOf(':'); return c > 0 ? '<span class="tv-px">' + esc(n.slice(0, c + 1)) + '</span><span class="tv-nm">' + esc(n.slice(c + 1)) + '</span>' : '<span class="tv-nm">' + esc(n) + '</span>'; }
    function attrs(e) {
      var s = '', a = e.a || [];
      for (var i = 0; i < a.length; i++) {
        var x = a[i][0] === 'xmlns' || a[i][0].lastIndexOf('xmlns:', 0) === 0;
        s += ' <span class="tv-at' + (x ? ' tv-xmlns' : '') + '" data-a="' + i + '"><span class="tv-an">' + esc(a[i][0]) + '</span>=<span class="tv-av">"' + cut(a[i][1]) + '"</span></span>';
      }
      return s;
    }
    function visible(c) { return c.t !== '#' || /\S/.test(c.v); }
    // an element shown on one line: no element children, at most one short single-line text
    function leaf(e) {
      var c = e.c || [];
      if (!c.length) return true;
      if (c.length > 1) return false;
      return (c[0].t === '#' || c[0].t === 'c') && c[0].v.length <= 120 && c[0].v.indexOf('\n') < 0;
    }
    function count(e) { var n = 0, c = e.c || []; for (var i = 0; i < c.length; i++) if (visible(c[i])) n++; return n; }
    function xmlRow(e) {
      if (e.t === '#') return { h: '<span class="tv-tx">' + cut(e.v.trim()) + '</span>', open: false };
      if (e.t === 'c') return { h: '<span class="tv-p">&lt;![CDATA[</span><span class="tv-tx tv-cdata">' + cut(e.v) + '</span><span class="tv-p">]]&gt;</span>', open: false };
      if (e.t === '!') return { h: '<span class="tv-cm">&lt;!--' + cut(e.v) + '--&gt;</span>', open: false };
      if (e.t === '?') return { h: '<span class="tv-pi">&lt;?' + esc(e.n) + (e.v ? ' ' + cut(e.v) : '') + '?&gt;</span>', open: false };
      if (e.t === 'd') return { h: '<span class="tv-pi">&lt;!DOCTYPE ' + cut(e.v) + '&gt;</span>', open: false };
      var head = '<span class="tv-p">&lt;</span>' + qn(e.n) + attrs(e);
      if (!(e.c || []).length) return { h: head + '<span class="tv-p">/&gt;</span>', open: false };
      if (leaf(e)) {
        var t = e.c[0];
        return { h: head + '<span class="tv-p">&gt;</span><span class="tv-tx' + (t.t === 'c' ? ' tv-cdata' : '') + '">' + esc(t.v) + '</span><span class="tv-p">&lt;/</span>' + qn(e.n) + '<span class="tv-p">&gt;</span>', open: false };
      }
      var n = count(e);
      return { h: head + '<span class="tv-p">&gt;</span>', tail: '<span class="tv-ell">…</span><span class="tv-p">&lt;/</span>' + qn(e.n) + '<span class="tv-p">&gt;</span>', cnt: n + (n === 1 ? ' child' : ' children'), close: '<span class="tv-p">&lt;/</span>' + qn(e.n) + '<span class="tv-p">&gt;</span>', open: true };
    }
    function jkey(k, idx) { return idx ? '<span class="tv-i">' + esc(k) + '</span><span class="tv-p">: </span>' : k == null ? '' : '<span class="tv-k">' + esc(JSON.stringify(String(k))) + '</span><span class="tv-p">: </span>'; }
    function jsonRow(k, v, idx) {
      var head = jkey(k, idx);
      if (v === null) return { h: head + '<span class="tv-kw">null</span>', open: false };
      if (typeof v === 'string') return { h: head + '<span class="tv-s">' + cut(JSON.stringify(v)) + '</span>', open: false };
      if (typeof v === 'number') return { h: head + '<span class="tv-num">' + esc(String(v)) + '</span>', open: false };
      if (typeof v === 'boolean') return { h: head + '<span class="tv-kw">' + v + '</span>', open: false };
      var arr = Object.prototype.toString.call(v) === '[object Array]', n = arr ? v.length : Object.keys(v).length;
      var o = arr ? '[' : '{', c = arr ? ']' : '}';
      if (!n) return { h: head + '<span class="tv-p">' + o + c + '</span>', open: false };
      return { h: head + '<span class="tv-p">' + o + '</span>', tail: '<span class="tv-ell">…</span><span class="tv-p">' + c + '</span>', cnt: n + (arr ? (n === 1 ? ' item' : ' items') : (n === 1 ? ' key' : ' keys')), close: '<span class="tv-p">' + c + '</span>', open: true };
    }
    // children of a node: XML -> [node…] (whitespace-only text skipped); JSON -> [[key, value, isIndex]…]
    function kids(kind, v) {
      var out = [], i;
      if (kind === 'xml') { var c = v.c || []; for (i = 0; i < c.length; i++) if (visible(c[i])) out.push([i, c[i]]); return out; }
      if (Object.prototype.toString.call(v) === '[object Array]') { for (i = 0; i < v.length; i++) out.push([i, v[i], i, true]); return out; }
      var ks = Object.keys(v);
      for (i = 0; i < ks.length; i++) out.push([i, v[ks[i]], ks[i], false]);
      return out;
    }
    function row(kind, k) { return kind === 'xml' ? xmlRow(k[1]) : jsonRow(k[2], k[1], k[3]); }
    return { esc: esc, row: row, kids: kids, xmlRow: xmlRow, jsonRow: jsonRow };
  }

  // ---- the frame side (shipped via toString; ES5) -----------------------------------------------------------
  function TV_SHELL(W, ROWS) {
    var D = W.document, R = ROWS(), up = function () {}, states = {};
    var CHUNK = 250, EXPAND_MAX = 4000, AUTO_ROWS = 120;
    function closest(el, sel) { return el && el.closest ? el.closest(sel) : null; }
    function blockLine(el) { var b = closest(el, '[data-l]'); return b ? +b.getAttribute('data-l') || 0 : 0; }
    function nodeAt(tv, path) {
      var v = tv.rootNode, parts = path === '' ? [] : path.split('.');
      for (var i = 0; i < parts.length; i++) {
        var k = R.kids(tv.kind, v), j = +parts[i], hit = null;
        for (var q = 0; q < k.length; q++) if (k[q][0] === j) { hit = k[q]; break; }
        if (!hit) return null;
        v = hit[1];
        if (i === parts.length - 1) return hit;
      }
      return null;
    }
    function rowEl(tv, k, path) {
      var r = R.row(tv.kind, k), n = D.createElement('div');
      n.className = 'tv-n' + (r.open ? ' tv-x' : '');
      n.setAttribute('data-p', path);
      n.setAttribute('role', 'treeitem');
      if (r.open) n.setAttribute('aria-expanded', 'false');
      n.innerHTML = '<div class="tv-r"><span class="tv-tw" aria-hidden="true"></span><span class="tv-h">' + r.h + '</span>' +
        (r.open ? '<span class="tv-tail">' + r.tail + '</span><span class="tv-cnt">' + r.cnt + '</span>' : '') + '</div>';
      if (r.open) n.__close = r.close;
      return n;
    }
    function fillKids(tv, n, path, from) {
      var v = path === '' ? tv.rootNode : nodeAt(tv, path)[1], ks = R.kids(tv.kind, v), box = n.__box;
      var more = box.querySelector(':scope > .tv-more');
      if (more) more.remove();
      var end = Math.min(ks.length, from + CHUNK), frag = D.createDocumentFragment();
      for (var i = from; i < end; i++) { frag.appendChild(rowEl(tv, ks[i], (path === '' ? '' : path + '.') + ks[i][0])); tv.rows++; }
      if (end < ks.length) {
        var m = D.createElement('button');
        m.type = 'button'; m.className = 'tv-more'; m.setAttribute('data-more', String(end));
        m.textContent = 'Show ' + Math.min(CHUNK, ks.length - end) + ' more (' + (ks.length - end) + ' left)';
        frag.appendChild(m);
      }
      var cl = box.querySelector(':scope > .tv-close');
      box.insertBefore(frag, cl);
    }
    function setOpen(tv, n, on) {
      if (!n.classList.contains('tv-x')) return;
      var path = n.getAttribute('data-p');
      if (on && !n.__box) {
        var box = D.createElement('div');
        box.className = 'tv-c'; box.setAttribute('role', 'group');
        n.appendChild(box); n.__box = box;
        if (n.__close) { var cl = D.createElement('div'); cl.className = 'tv-r tv-close'; cl.innerHTML = '<span class="tv-tw"></span><span class="tv-h">' + n.__close + '</span>'; box.appendChild(cl); }
        fillKids(tv, n, path, 0);
      }
      n.classList.toggle('open', on);
      n.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) tv.st.open[path] = 1; else delete tv.st.open[path];
    }
    function build(tv) {
      if (tv.built) return;
      tv.built = true;
      var box = tv.ph, ks = R.kids(tv.kind, tv.rootNode);
      box.__box = box;
      box.setAttribute('role', 'tree');
      box.tabIndex = 0;
      fillKids(tv, box, '', 0);
      var saved = Object.keys(tv.st.open);
      if (saved.length) {
        saved.sort(function (a, b) { return a.split('.').length - b.split('.').length; });
        tv.st.open = {};
        saved.forEach(function (p) { var n = box.querySelector('.tv-n[data-p="' + p + '"]'); if (n) setOpen(tv, n, true); });
      } else {
        // open the first levels while the tree stays small
        var queue = Array.prototype.slice.call(box.querySelectorAll(':scope > .tv-n.tv-x'));
        if (!ks.length) box.innerHTML = '<div class="tv-empty">(empty)</div>';
        while (queue.length && tv.rows < AUTO_ROWS) {
          var n = queue.shift();
          if (n.getAttribute('data-p').split('.').length > 4) break;
          setOpen(tv, n, true);
          queue = queue.concat(Array.prototype.slice.call(n.__box.querySelectorAll(':scope > .tv-n.tv-x')));
        }
      }
      if (tv.st.sel) { var s = box.querySelector('.tv-n[data-p="' + tv.st.sel + '"]'); if (s) select(tv, s, tv.st.selA); }
    }
    function blkOf(el) { return closest(el, '.tv-blk'); }
    function tvOf(blk) { var ph = blk && blk.querySelector('.tv[data-tv]'); return ph && ph.__tv; }
    function showPane(blk, v) {
      var panes = blk.querySelectorAll('.tv-pane'), btns = blk.querySelectorAll('[data-tvv]'), i;
      for (i = 0; i < panes.length; i++) panes[i].hidden = panes[i].getAttribute('data-pane') !== v;
      for (i = 0; i < btns.length; i++) { var on = btns[i].getAttribute('data-tvv') === v; btns[i].classList.toggle('on', on); btns[i].setAttribute('aria-pressed', on ? 'true' : 'false'); }
      var tv = tvOf(blk);
      if (tv) { tv.st.view = v; if (v === 'tree') build(tv); }
    }
    // ---- paths ----
    function xpath(tv, path, attrIdx, local) {
      var parts = path.split('.'), list = tv.rootNode.c, out = '', node = null;
      for (var i = 0; i < parts.length; i++) {
        var j = +parts[i], k, same = 0, idx = 0;
        node = list[j];
        if (node.t === 'e') {
          var ln = node.n.slice(node.n.indexOf(':') + 1);
          for (k = 0; k < list.length; k++) if (list[k].t === 'e' && (local ? list[k].n.slice(list[k].n.indexOf(':') + 1) === ln : list[k].n === node.n)) { same++; if (k <= j) idx = same; }
          out += '/' + (local ? "*[local-name()='" + ln + "']" : node.n) + (same > 1 ? '[' + idx + ']' : '');
          list = node.c || [];
        } else {
          var fn = node.t === '!' ? 'comment()' : node.t === '?' ? 'processing-instruction()' : 'text()';
          for (k = 0; k < list.length; k++) {
            var lk = list[k], m = node.t === '!' ? lk.t === '!' : node.t === '?' ? lk.t === '?' : (lk.t === '#' || lk.t === 'c');
            if (m) { same++; if (k <= j) idx = same; }
          }
          out += '/' + fn + (same > 1 ? '[' + idx + ']' : '');
        }
      }
      if (attrIdx != null && node && node.a && node.a[attrIdx]) {
        var an = node.a[attrIdx][0];
        out += local && an.indexOf(':') > 0 ? "/@*[local-name()='" + an.slice(an.indexOf(':') + 1) + "']" : '/@' + an;
      }
      return out;
    }
    function jsonPath(tv, path) {
      var v = tv.rootNode, out = '$', parts = path.split('.');
      for (var i = 0; i < parts.length; i++) {
        var j = +parts[i];
        if (Object.prototype.toString.call(v) === '[object Array]') { out += '[' + j + ']'; v = v[j]; }
        else { var k = Object.keys(v)[j]; out += /^[A-Za-z_$][\w$]*$/.test(k) ? '.' + k : "['" + k.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']"; v = v[k]; }
      }
      return out;
    }
    function select(tv, n, attrIdx) {
      var old = tv.ph.querySelectorAll('.tv-sel'), i;
      for (i = 0; i < old.length; i++) old[i].classList.remove('tv-sel');
      n.firstChild.classList.add('tv-sel');
      if (attrIdx != null) { var at = n.firstChild.querySelector('[data-a="' + attrIdx + '"]'); if (at) at.classList.add('tv-sel'); }
      var p = n.getAttribute('data-p'), bar = closest(tv.ph, '.tv-pane').querySelector('.tv-path');
      tv.st.sel = p; tv.st.selA = attrIdx;
      if (!bar) return;
      var a = tv.kind === 'xml' ? xpath(tv, p, attrIdx, false) : jsonPath(tv, p);
      var b = tv.kind === 'xml' && tv.ns ? xpath(tv, p, attrIdx, true) : '';
      bar.querySelector('.tv-pathv').textContent = a;
      bar.__a = a; bar.__b = b;
      bar.classList.add('has');
      var b2 = bar.querySelector('[data-tvc="2"]');
      if (b2) b2.hidden = !b || b === a;
    }
    function copy(text, what) {
      var ok = false;
      try {
        var ta = D.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.top = '0';
        D.body.appendChild(ta); ta.select(); ok = D.execCommand('copy'); ta.remove();
      } catch (e) { ok = false; }
      up({ type: 'copy', text: text, ok: !!ok, what: what });
    }
    function expandAll(tv) {
      build(tv);
      var budget = EXPAND_MAX, queue = Array.prototype.slice.call(tv.ph.querySelectorAll('.tv-n.tv-x'));
      while (queue.length && budget > 0) {
        var n = queue.shift();
        if (!n.classList.contains('open')) { var before = tv.rows; setOpen(tv, n, true); budget -= tv.rows - before + 1; }
        queue = queue.concat(Array.prototype.slice.call(n.__box.querySelectorAll(':scope > .tv-n.tv-x:not(.open)')));
      }
      var note = closest(tv.ph, '.tv-pane').querySelector('.tv-note');
      if (note) { note.hidden = !queue.length; note.textContent = queue.length ? 'Opened ' + EXPAND_MAX + '+ nodes; open the rest by hand.' : ''; }
    }
    function collapseAll(tv) {
      var o = tv.ph.querySelectorAll('.tv-n.open');
      for (var i = 0; i < o.length; i++) setOpen(tv, o[i], false);
      var note = closest(tv.ph, '.tv-pane').querySelector('.tv-note');
      if (note) note.hidden = true;
    }
    function visibleRows(tv) {
      var all = tv.ph.querySelectorAll('.tv-n'), out = [];
      for (var i = 0; i < all.length; i++) if (all[i].offsetParent !== null) out.push(all[i]);
      return out;
    }
    D.addEventListener('click', function (e) {
      var t = e.target;
      var v = closest(t, '[data-tvv]');
      if (v) { showPane(blkOf(v), v.getAttribute('data-tvv')); e.stopPropagation(); return; }
      var a = closest(t, '[data-tva]');
      if (a) {
        var blk = blkOf(a), tv = tvOf(blk);
        if (tv) { showPane(blk, 'tree'); if (a.getAttribute('data-tva') === 'expand') expandAll(tv); else collapseAll(tv); }
        return;
      }
      var c = closest(t, '[data-tvc]');
      if (c) { var bar = closest(c, '.tv-path'); var txt = c.getAttribute('data-tvc') === '2' ? bar.__b : bar.__a; if (txt) copy(txt, closest(c, '.tv-blk').getAttribute('data-kind') === 'json' ? 'JSONPath' : 'XPath'); return; }
      var m = closest(t, '.tv-more');
      if (m) { var p = m.parentNode.parentNode, tv2 = closest(m, '.tv').__tv; fillKids(tv2, p.classList.contains('tv-n') ? p : tv2.ph, p.classList.contains('tv-n') ? p.getAttribute('data-p') : '', +m.getAttribute('data-more')); return; }
      var r = closest(t, '.tv-r');
      if (!r || r.classList.contains('tv-close')) return;
      var n = r.parentNode, tv3 = closest(n, '.tv').__tv;
      if (!tv3) return;
      var at = closest(t, '[data-a]');
      if (at) { select(tv3, n, +at.getAttribute('data-a')); return; }
      if (n.classList.contains('tv-x')) setOpen(tv3, n, !n.classList.contains('open'));
      select(tv3, n, null);
    });
    // double-click an XML element: jump to its line in the note
    D.addEventListener('dblclick', function (e) {
      var r = closest(e.target, '.tv-r');
      if (!r) return;
      e.stopImmediatePropagation();
      var n = r.classList.contains('tv-close') ? r.parentNode.parentNode : r.parentNode, ph = closest(n, '.tv'), tv = ph && ph.__tv;
      if (!tv || tv.kind !== 'xml') return;
      var hit = nodeAt(tv, n.getAttribute('data-p'));
      if (hit && hit[1].l) up({ type: 'goto', line: blockLine(ph) + tv.off + hit[1].l - 1 });
    }, true);
    D.addEventListener('keydown', function (e) {
      var ph = closest(e.target, '.tv'), tv = ph && ph.__tv;
      if (!tv) return;
      var cur = ph.querySelector('.tv-r.tv-sel'), n = cur && cur.parentNode, rows, i;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        rows = visibleRows(tv); i = rows.indexOf(n);
        var nx = rows[e.key === 'ArrowDown' ? i + 1 : Math.max(0, i - 1)] || rows[0];
        if (nx) { select(tv, nx, null); nx.firstChild.scrollIntoView({ block: 'nearest' }); }
        e.preventDefault();
      } else if (n && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Enter' || e.key === ' ')) {
        if (n.classList.contains('tv-x')) setOpen(tv, n, e.key === 'ArrowRight' ? true : e.key === 'ArrowLeft' ? false : !n.classList.contains('open'));
        e.preventDefault();
      }
    });
    W.__cadeTV = {
      init: function (fn) { up = fn; },
      // data: { kind: 'xml' | 'json', root, off, ns, view }
      mount: function (ph, data) {
        if (ph.__tv) return;
        var key = blockLine(ph) + ':' + data.kind;
        var st = states[key] || (states[key] = { open: {}, view: '', sel: null, selA: null });
        var tv = ph.__tv = { ph: ph, kind: data.kind, rootNode: data.kind === 'xml' ? { c: data.root } : data.root, off: data.off || 0, ns: !!data.ns, st: st, rows: 0, built: false };
        var blk = blkOf(ph);
        if (st.view && blk && blk.querySelector('[data-pane="' + st.view + '"]')) showPane(blk, st.view);
        else if (blk) showPane(blk, blk.getAttribute('data-view') || 'tree');
      }
    };
  }

  // ---- app side ---------------------------------------------------------------------------------------------
  // The parse tree, compacted for the frame: e = element { t:'e', n, a?, c?, l }, '#' text, 'c' CDATA, '!' comment, '?' PI, 'd' doctype.
  function compact(nodes, stats) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var c = nodes[i];
      if (c.type === 'element') {
        var e = { t: 'e', n: c.name, l: c.line };
        if (c.attrs.length) e.a = c.attrs;
        if (c.children.length) e.c = compact(c.children, stats);
        if (c.ns && !c.prefix) stats.ns = true;
        if (c.prefix) stats.ns = true;
        out.push(e);
      } else if (c.type === 'text') out.push({ t: '#', v: c.value });
      else if (c.type === 'cdata') out.push({ t: 'c', v: c.value });
      else if (c.type === 'comment') out.push({ t: '!', v: c.value });
      else if (c.type === 'pi') out.push({ t: '?', n: c.name, v: c.value });
      else if (c.type === 'doctype') out.push({ t: 'd', v: c.value });
    }
    return out;
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function jsonStats(v) {
    var n = 0, depth = 0;
    (function walk(x, d) {
      n++; if (d > depth) depth = d;
      if (x && typeof x === 'object') for (var k in x) if (Object.prototype.hasOwnProperty.call(x, k)) walk(x[k], d + 1);
    })(v, 0);
    return { nodes: n, depth: depth };
  }
  function errorHtml(kind, err, o) {
    var abs = (o.line || 1) + err.line - 1, lines = String(o.text).split('\n'), ex = '', w = String(err.line + 1).length;
    for (var i = Math.max(1, err.line - 2); i <= Math.min(lines.length, err.line + 1); i++) {
      var t = lines[i - 1].replace(/\t/g, '  ');
      if (t.length > 160) t = t.slice(0, 160) + '…';
      ex += (i === err.line ? '<b>' : '') + esc((new Array(w + 1).join(' ') + i).slice(-w) + ' │ ' + t) + (i === err.line ? '</b>' : '') + '\n';
      if (i === err.line) ex += esc(new Array(w + 4 + Math.min(err.col, 161)).join(' ') + '^') + '\n';
    }
    return '<div class="tv-err" role="alert"><div class="tv-err-t"><b>' + (kind === 'json' ? 'Invalid JSON' : 'Not well-formed XML') + '</b> · line ' + abs + ', column ' + err.col + '</div>' +
      '<div class="tv-err-m">' + esc(err.message.replace(/\(opened at line (\d+)\)/, function (m, n) { return '(opened at line ' + ((o.line || 1) + +n - 1) + ')'; })) + '</div><pre class="tv-ex">' + ex + '</pre>' +
      '<button type="button" class="tv-btn" data-goto="' + abs + '">Go to line ' + abs + '</button></div>';
  }
  function head(kind, sum, views, tree) {
    var b = '';
    if (views.length > 1) {
      b += '<span class="tv-seg" role="group" aria-label="View">';
      views.forEach(function (v) { b += '<button type="button" class="tv-btn" data-tvv="' + v[0] + '" aria-pressed="false">' + v[1] + '</button>'; });
      b += '</span>';
    }
    if (tree) {
      b += '<button type="button" class="tv-btn tv-ico" data-tva="expand" title="Expand all" aria-label="Expand all"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4-4 4 4M4 10l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
        '<button type="button" class="tv-btn tv-ico" data-tva="collapse" title="Collapse all" aria-label="Collapse all"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2l4 4 4-4M4 14l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
    }
    return '<div class="tv-head"><span class="tv-kind">' + kind + '</span><span class="tv-sum">' + sum + '</span>' + (b ? '<span class="tv-btns">' + b + '</span>' : '') + '</div>';
  }
  function treePane(tk, hidden) {
    return '<div class="tv-pane" data-pane="tree"' + (hidden ? ' hidden' : '') + '><div class="tv-path"><code class="tv-pathv">Tap a node to see its path</code>' +
      '<button type="button" class="tv-btn" data-tvc="1">Copy</button><button type="button" class="tv-btn" data-tvc="2" hidden title="Namespace-agnostic XPath">local-name()</button></div>' +
      '<div class="tv-note" hidden></div><div class="tv" data-tv="' + tk + '"></div></div>';
  }
  function srcPane(text, lang, hl, hidden) {
    var body = text.length > SRC_MAX ? '<p class="tv-big">The source is ' + Math.round(text.length / 1024) + ' KB — too large to show here; it is in the note.</p>'
      : '<pre class="tv-src"><code>' + (hl ? hl(text, lang) : esc(text)) + '</code></pre>';
    return '<div class="tv-pane" data-pane="src"' + (hidden ? ' hidden' : '') + '>' + body + '</div>';
  }

  // ---- SOAP view (static HTML) ----
  function qname(el) { return (el.prefix ? '<span class="sv-px">' + esc(el.prefix) + ':</span>' : '') + '<b>' + esc(el.local) + '</b>'; }
  function chips(el, core) {
    var s = '';
    el.attrs.forEach(function (a) {
      if (a[0] === 'xmlns' || a[0].lastIndexOf('xmlns:', 0) === 0) return;
      s += ' <span class="sv-chip">@' + esc(a[0]) + '=' + esc(a[1]) + '</span>';
    });
    return s;
  }
  function isNil(el) { for (var i = 0; i < el.attrs.length; i++) if (/(^|:)nil$/.test(el.attrs[i][0]) && el.attrs[i][1] === 'true') return true; return false; }
  function valueHtml(core, el, depth) {
    var k = core.elementsOf(el);
    if (k.length) return paramsTable(core, el, depth + 1);
    if (isNil(el)) return '<i class="sv-nil">nil</i>';
    var t = core.textOf(el);
    return t.trim() === '' ? '<i class="sv-nil">empty</i>' : '<span class="sv-v">' + esc(t.trim()) + '</span>';
  }
  function paramsTable(core, el, depth) {
    var k = core.elementsOf(el);
    if (!k.length) return '<div class="sv-val">' + valueHtml(core, el, depth) + '</div>';
    if (depth > 16) return '<div class="sv-val">…</div>';
    var rows = '';
    for (var i = 0; i < k.length && i < TABLE_ROWS; i++) rows += '<tr><th scope="row" title="' + esc(k[i].ns || '') + '">' + qname(k[i]) + chips(k[i], core) + '</th><td>' + valueHtml(core, k[i], depth) + '</td></tr>';
    if (k.length > TABLE_ROWS) rows += '<tr><td colspan="2" class="sv-nil">… ' + (k.length - TABLE_ROWS) + ' more</td></tr>';
    return '<table class="sv-t"><tbody>' + rows + '</tbody></table>';
  }
  function soapView(core, s) {
    var h = '<div class="sv">', f = s.fault;
    if (f) {
      h += '<div class="sv-fault" role="alert"><div class="sv-ft"><span aria-hidden="true">⚠</span> SOAP Fault</div>' +
        (f.reason ? '<div class="sv-reason">' + esc(f.reason) + '</div>' : '') + '<dl class="sv-kv">' +
        '<dt>Code</dt><dd><code>' + esc(f.code || '—') + '</code>' + (f.subcodes ? ' › <code>' + f.subcodes.map(esc).join('</code> › <code>') + '</code>' : '') + '</dd>' +
        (f.actor ? '<dt>Actor</dt><dd>' + esc(f.actor) + '</dd>' : '') + (f.node ? '<dt>Node</dt><dd>' + esc(f.node) + '</dd>' : '') + (f.role ? '<dt>Role</dt><dd>' + esc(f.role) + '</dd>' : '') +
        (f.reasons ? '<dt>Reasons</dt><dd>' + f.reasons.map(function (r) { return (r.lang ? '<span class="sv-chip">' + esc(r.lang) + '</span> ' : '') + esc(r.text); }).join('<br>') + '</dd>' : '') +
        '</dl>' + (f.detailEl ? '<div class="sv-dh">Detail</div>' + paramsTable(core, f.detailEl, 0) : '') + '</div>';
    }
    if (s.headers.length) {
      h += '<section class="sv-sec"><div class="sv-h">Header <span class="sv-n">' + plural(s.headers.length, 'entry').replace('entrys', 'entries') + '</span></div>';
      s.headers.forEach(function (e) {
        h += '<div class="sv-op"><div class="sv-opn">' + qname(e) + (e.ns ? ' <code class="sv-ns">' + esc(e.ns) + '</code>' : '') + chips(e, core) + '</div>' + paramsTable(core, e, 0) + '</div>';
      });
      h += '</section>';
    }
    h += '<section class="sv-sec"><div class="sv-h">Body</div>';
    if (!s.payload.length && !f) h += '<p class="sv-nil">Empty body</p>';
    s.payload.forEach(function (op) {
      h += '<div class="sv-op"><div class="sv-opn"><span class="sv-lbl">Operation</span> ' + qname(op) + chips(op, core) + '</div>' +
        (op.ns ? '<div class="sv-nsl"><span class="sv-lbl">Namespace</span> <code class="sv-ns">' + esc(op.ns) + '</code></div>' : '') + paramsTable(core, op, 0) + '</div>';
    });
    if (f && !s.payload.length) h += '<p class="sv-nil">Fault only (shown above)</p>';
    return h + '</section></div>';
  }

  function build(core, lang, text, o) {
    o = o || {};
    text = String(text);
    var hash = o.hash || function (s) { return String(s.length); }, eo = { line: o.line || 1, text: text };
    if (lang === 'json') {
      var r = core.parseJSON(text);
      if (r.error) return { h: '<div class="tv-blk" data-kind="json" data-view="src">' + head('JSON', 'invalid', [], false) + errorHtml('json', r.error, eo) + srcPane(text, 'json', o.highlight, false) + '</div>\n', tk: '', data: null };
      var v = r.value, js = jsonStats(v), arr = Object.prototype.toString.call(v) === '[object Array]';
      var sum = v !== null && typeof v === 'object' ? (arr ? plural(v.length, 'item') : plural(Object.keys(v).length, 'key')) + ' · ' + plural(js.nodes, 'value') + ' · depth ' + js.depth : typeof v;
      var tk = 'j' + hash('json\u0000' + text);
      return { h: '<div class="tv-blk" data-kind="json" data-view="tree">' + head('JSON', sum, [['tree', 'Tree'], ['src', 'Source']], true) + treePane(tk, false) + srcPane(text, 'json', o.highlight, true) + '</div>\n',
        tk: tk, data: { kind: 'json', root: v !== null && typeof v === 'object' ? v : [v], off: o.off || 0 } };
    }
    var x = o.parsed && o.parsed.text === text ? o.parsed.result : core.parseXML(text);
    if (x.error) return { h: '<div class="tv-blk" data-kind="xml" data-view="src">' + head(lang === 'soap' ? 'SOAP' : 'XML', 'not well-formed', [], false) + errorHtml('xml', x.error, eo) + srcPane(text, 'xml', o.highlight, false) + '</div>\n', tk: '', data: null };
    var doc = x.doc, s = core.soapOf(doc), stats = { ns: false }, data = compact(doc.children, stats);
    var tk2 = 'x' + hash('xml\u0000' + text);
    var kind = s ? 'SOAP ' + s.version : 'XML';
    var sum2 = plural(doc.elements, 'element') + ' · depth ' + doc.depth + (doc.decl && doc.decl.encoding ? ' · ' + esc(doc.decl.encoding) : '');
    if (s) sum2 = (s.fault ? '<span class="tv-bad">Fault</span> · ' : s.operation ? esc(s.operation.local) + ' · ' : '') + sum2;
    var views = s ? [['soap', 'SOAP'], ['tree', 'XML tree'], ['src', 'Source']] : [['tree', 'Tree'], ['src', 'Source']];
    var h = '<div class="tv-blk' + (s && s.fault ? ' tv-fault' : '') + '" data-kind="xml" data-view="' + (s ? 'soap' : 'tree') + '">' + head(kind, sum2, views, true) +
      (s ? '<div class="tv-pane" data-pane="soap">' + soapView(core, s) + '</div>' : '') + treePane(tk2, !!s) + srcPane(text, 'xml', o.highlight, true) + '</div>\n';
    return { h: h, tk: tk2, data: { kind: 'xml', root: data, off: o.off || 0, ns: stats.ns } };
  }

  // ---- static trees (Copy / Open in a new tab) ----
  var ROWS = TV_ROWS();
  function staticTree(data) {
    var budget = STATIC_MAX, root = data.kind === 'xml' ? { c: data.root } : data.root;
    function walk(v, depth) {
      var ks = ROWS.kids(data.kind, v), s = '';
      for (var i = 0; i < ks.length; i++) {
        if (--budget < 0) { s += '<div class="tv-r tv-more-t">… more (open the note to see the rest)</div>'; break; }
        var r = ROWS.row(data.kind, ks[i]);
        if (!r.open) { s += '<div class="tv-r"><span class="tv-tw"></span><span class="tv-h">' + r.h + '</span></div>'; continue; }
        s += '<details class="tv-d"' + (depth < 2 ? ' open' : '') + '><summary class="tv-r"><span class="tv-h">' + r.h + '</span><span class="tv-cnt">' + r.cnt + '</span></summary><div class="tv-c">' +
          walk(ks[i][1], depth + 1) + '<div class="tv-r"><span class="tv-tw"></span><span class="tv-h">' + r.close + '</span></div></div></details>';
      }
      return s;
    }
    return '<div class="tv tv-static">' + walk(root, 0) + '</div>';
  }
  function staticize(html, trees) {
    return html.replace(/<div class="tv" data-tv="([^"]*)"><\/div>/g, function (m, k) { return trees[k] ? staticTree(trees[k]) : ''; })
      .replace(/<span class="tv-btns">[\s\S]*?<\/span><\/div>/g, '</div>')
      .replace(/<div class="tv-path">[\s\S]*?<\/div>/g, '')
      .replace(/<button type="button" class="tv-btn" data-goto="[^"]*">[^<]*<\/button>/g, '')
      .replace(/<div class="tv-pane" data-pane="(tree|src)" hidden>/g, '<div class="tv-pane" data-pane="$1" style="display:none">');
  }

  var CSS = [
    '.tv-blk{margin:0 0 1em;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);overflow:hidden}',
    '.tv-blk.tv-fault{border-color:color-mix(in srgb,var(--error,#dc2626) 55%,var(--border))}',
    '.tv-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:6px 8px 6px 12px;border-bottom:1px solid var(--border);font:12px var(--font-body)}',
    '.tv-kind{font-weight:700;letter-spacing:.02em;color:var(--accent)}.tv-sum{color:var(--text-muted);flex:1 1 auto;min-width:0}',
    '.tv-bad{color:var(--error,#dc2626);font-weight:700}',
    '.tv-btns{display:flex;flex-wrap:wrap;gap:4px;align-items:center}',
    '.tv-seg{display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden}.tv-seg .tv-btn{border:0;border-radius:0}.tv-seg .tv-btn+.tv-btn{border-left:1px solid var(--border)}',
    '.tv-btn{font:12px var(--font-body);color:var(--text-muted);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:3px 9px;cursor:pointer;min-height:26px}',
    '.tv-ico{padding:3px 6px;display:inline-flex;align-items:center;justify-content:center}.tv-ico svg{width:14px;height:14px;display:block}',
    '.tv-btn:hover{color:var(--text)}.tv-btn.on{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--surface))}',
    '.tv-pane[hidden]{display:none}',
    '.tv-path{display:flex;align-items:center;gap:6px;padding:5px 8px 5px 12px;border-bottom:1px solid var(--border);font:12px var(--font-body);color:var(--text-faint);min-height:24px}',
    '.tv-pathv{flex:1 1 auto;min-width:0;overflow-x:auto;white-space:nowrap;background:none;border:0;padding:0;font:12px var(--font-mono);color:var(--text-faint);scrollbar-width:none}',
    '.tv-path.has .tv-pathv{color:var(--text)}.tv-path:not(.has) .tv-btn{display:none}',
    '.tv-note{padding:4px 12px;font:12px var(--font-body);color:var(--text-muted)}.tv-note[hidden]{display:none}',
    '.tv{font:12.5px/1.55 var(--font-mono);padding:4px 0 6px;overflow-x:auto;outline:none}',
    '.tv-c{padding-left:16px}',
    '.tv-r{display:flex;align-items:flex-start;gap:2px;padding:1px 10px 1px 2px;cursor:default;border-radius:4px;min-width:max-content}',
    '.tv-x>.tv-r{cursor:pointer}.tv-r:hover{background:color-mix(in srgb,var(--text) 5%,transparent)}',
    '.tv-r.tv-sel{background:color-mix(in srgb,var(--accent) 16%,transparent)}.tv-at.tv-sel{outline:1px solid var(--accent);border-radius:3px}',
    '.tv-tw{flex:0 0 14px;width:14px;text-align:center;color:var(--text-faint);user-select:none;-webkit-user-select:none}',
    '.tv-x>.tv-r>.tv-tw::before{content:"\\25B8"}.tv-x.open>.tv-r>.tv-tw::before{content:"\\25BE"}',
    '.tv-h{white-space:pre-wrap;word-break:break-word;max-width:min(78ch,calc(100vw - 60px))}',
    '.tv-tail,.tv-cnt{white-space:nowrap}.tv-x.open>.tv-r>.tv-tail,.tv-x.open>.tv-r>.tv-cnt{display:none}.tv-x:not(.open)>.tv-c{display:none}',
    '.tv-cnt{margin-left:8px;font:11px var(--font-body);color:var(--text-faint);align-self:center}',
    '.tv-p{color:var(--text-faint)}.tv-nm{color:var(--accent);font-weight:600}.tv-px{color:var(--text-muted)}',
    '.tv-an{color:var(--tk-n)}.tv-av{color:var(--tk-s)}.tv-xmlns .tv-an,.tv-xmlns .tv-av{color:var(--text-muted)}.tv-at{cursor:pointer}',
    '.tv-tx{color:var(--text)}.tv-cdata{background:color-mix(in srgb,var(--tk-s) 10%,transparent)}.tv-cm{color:var(--text-faint);font-style:italic}.tv-pi{color:var(--text-muted)}',
    '.tv-k{color:var(--tk-n)}.tv-i{color:var(--text-faint)}.tv-s{color:var(--tk-s)}.tv-num{color:var(--accent)}.tv-kw{color:var(--accent);font-weight:600}.tv-ell{color:var(--text-faint);padding:0 2px}',
    '.tv-more{display:block;margin:2px 0 2px 16px;font:12px var(--font-body);color:var(--accent);background:none;border:1px dashed var(--border);border-radius:6px;padding:4px 10px;cursor:pointer}',
    '.tv-more-t{color:var(--text-faint);font-style:italic}.tv-empty,.tv-big{color:var(--text-faint);padding:6px 12px;margin:0}',
    '.tv-src{margin:0;border:0;border-radius:0;background:none;max-height:520px}',
    '.tv-err{margin:8px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--error,#dc2626) 45%,var(--border));border-left:3px solid var(--error,#dc2626);border-radius:6px;background:color-mix(in srgb,var(--error,#dc2626) 7%,var(--surface));font:13px var(--font-body)}',
    '.tv-err-t{color:var(--error,#dc2626)}.tv-err-m{margin:2px 0 6px;color:var(--text)}',
    '.tv-ex{margin:0 0 6px;padding:6px 8px;font:12px/1.45 var(--font-mono);background:var(--surface);color:var(--text-muted);max-height:none}.tv-ex b{color:var(--text);font-weight:600}',
    // SOAP view
    '.sv{padding:10px 12px;font:14px/1.5 var(--font-body)}',
    '.sv-fault{margin:0 0 12px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--error,#dc2626) 50%,var(--border));border-left:4px solid var(--error,#dc2626);border-radius:8px;background:color-mix(in srgb,var(--error,#dc2626) 9%,var(--surface))}',
    '.sv-ft{font-weight:700;color:var(--error,#dc2626);text-transform:uppercase;font-size:12px;letter-spacing:.06em}',
    '.sv-reason{font-size:1.12em;font-weight:650;margin:3px 0 6px;color:var(--text)}',
    '.sv-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:0 0 6px}.sv-kv dt{color:var(--text-muted)}.sv-kv dd{margin:0;overflow-wrap:anywhere}',
    '.sv-dh{font-size:12px;color:var(--text-muted);margin:6px 0 4px;text-transform:uppercase;letter-spacing:.05em}',
    '.sv-sec{margin:0 0 10px}.sv-sec:last-child{margin-bottom:0}',
    '.sv-h{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin:0 0 6px}.sv-n{font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-faint)}',
    '.sv-op{margin:0 0 8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}',
    '.sv-opn{font-size:1.05em;margin:0 0 4px;overflow-wrap:anywhere}.sv-opn b{color:var(--accent)}.sv-px{color:var(--text-faint)}',
    '.sv-lbl{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-faint);margin-right:4px}',
    '.sv-nsl{margin:0 0 6px;overflow-wrap:anywhere}.sv-ns{font:12px var(--font-mono);color:var(--text-muted);background:none;border:0;padding:0}',
    '.sv-chip{display:inline-block;font:11px var(--font-mono);color:var(--text-muted);background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:0 4px;margin:0 2px;font-weight:400}',
    'table.sv-t{display:table;width:100%;border-collapse:collapse;margin:0;font-size:13.5px}',
    '.sv-t th,.sv-t td{border:1px solid var(--border);padding:4px 8px;vertical-align:top;text-align:left}',
    '.sv-t th{background:var(--surface-2);font-weight:500;width:1%;white-space:nowrap}.sv-t th b{font-weight:600;color:var(--text)}',
    '.sv-t td{overflow-wrap:anywhere}.sv-t .sv-t{font-size:13px}.sv-v{white-space:pre-wrap}.sv-nil{color:var(--text-faint);font-style:italic}',
    // narrow frames: each parameter stacks its name over its value (nested tables indent)
    '@media (max-width:520px){.sv{padding:8px}.sv-op{padding:8px}table.sv-t,.sv-t tbody,.sv-t tr,.sv-t th,.sv-t td{display:block;width:auto}' +
      '.sv-t tr{border:1px solid var(--border);border-radius:6px;margin:0 0 4px;overflow:hidden}.sv-t th,.sv-t td{border:0;white-space:normal}' +
      '.sv-t th{padding:3px 8px;border-bottom:1px solid var(--border)}.sv-t td{padding:4px 8px}.sv-t td>.sv-t{margin:2px 0}}',
    '@media (pointer:coarse){.tv-btn{min-height:40px;min-width:40px;padding:4px 12px;font-size:13px}.tv-r{min-height:40px;align-items:center}.tv-more{min-height:40px}.tv-at{padding:6px 0}}',
    '@media print{.tv-btns,.tv-path,.tv-note{display:none!important}.tv-pane[hidden]{display:none}.tv-blk,.sv-fault{break-inside:avoid}}'
  ].join('\n');

  function ext() { return { css: CSS, js: '(' + TV_SHELL.toString() + ')(window, ' + TV_ROWS.toString() + ');' }; }

  var api = { build: build, ext: ext, staticize: staticize, staticTree: staticTree, soapView: soapView, CSS: CSS, _rows: ROWS, _shell: TV_SHELL, _ROWS: TV_ROWS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__cadeTreeView = api;
})(typeof self !== 'undefined' ? self : this);
