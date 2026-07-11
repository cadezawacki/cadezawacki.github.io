/* Text Stats — live document statistics panel: words, characters, lines,
   paragraphs, unique words, estimated reading time, and the most frequent
   words. Follows the selection: when text is selected, stats cover just the
   selection. Rebuilds on a debounce via Cade.onEditorUpdate. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('stats.css');
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'stats-panel';
  var STOPWORDS = {};
  ('the,a,an,and,or,but,of,to,in,on,for,at,by,with,from,as,is,are,was,were,be,been,being,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,my,your,our,their,me,him,us,not,no,so,if,then,than,too,very,can,will,just,do,does,did,have,has,had,about,into,over,after,before,between,out,up,down,off,again,there,here,when,where,why,how,all,any,both,each,few,more,most,other,some,such,only,own,same,s,t,dont,im,ive')
    .split(',').forEach(function (w) { STOPWORDS[w] = 1; });

  function computeStats(text) {
    var s = {};
    s.chars = text.length;
    s.charsNoWs = (text.match(/\S/g) || []).length;
    s.lines = text.length ? text.split('\n').length : 0;
    s.paragraphs = text.split(/\n[ \t]*\n+/).filter(function (p) { return p.trim() !== ''; }).length;
    var words = text.toLowerCase().match(/[a-z0-9'’_-]+/gi) || [];
    s.words = words.length;
    s.sentences = (text.match(/[.!?]+(?=\s|$)/g) || []).length;
    var freq = {};
    for (var i = 0; i < words.length; i++) {
      var w = words[i].replace(/^['’-]+|['’-]+$/g, '');
      if (!w || w.length < 3 || STOPWORDS[w] || /^\d+$/.test(w)) continue;
      freq[w] = (freq[w] || 0) + 1;
    }
    s.unique = Object.keys(freq).length;
    s.top = Object.keys(freq)
      .sort(function (a, b) { return freq[b] - freq[a] || a.localeCompare(b); })
      .slice(0, 8)
      .map(function (w) { return { w: w, n: freq[w] }; });
    s.readMins = s.words / 220; // ~220 wpm silent reading
    s.avgWordLen = s.words ? (s.charsNoWs / s.words) : 0;
    return s;
  }

  function fmtReadTime(mins) {
    if (mins < 1 / 60) return '—';
    if (mins < 1) return Math.max(1, Math.round(mins * 60)) + 's';
    if (mins < 60) return Math.round(mins) + ' min';
    return (mins / 60).toFixed(1) + ' h';
  }

  function render() {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    var sel = null, scope = 'Document';
    try {
      var m = window.editor.state.selection.main;
      if (!m.empty) { sel = window.editor.state.sliceDoc(m.from, m.to); scope = 'Selection'; }
    } catch (e) {}
    var text = sel;
    if (text == null) { try { text = window.editor.state.doc.toString(); } catch (e) { text = ''; } }
    var s = computeStats(text);
    var maxN = s.top.length ? s.top[0].n : 1;
    var row = function (label, val) {
      return '<div class="stats-row"><span>' + label + '</span><b>' + val + '</b></div>';
    };
    p.querySelector('.cade-panel-body').innerHTML =
      '<div class="stats-scope">' + scope + '</div>' +
      row('Words', s.words.toLocaleString()) +
      row('Characters', s.chars.toLocaleString() + ' <i>(' + s.charsNoWs.toLocaleString() + ' no spaces)</i>') +
      row('Lines', s.lines.toLocaleString()) +
      row('Paragraphs', s.paragraphs.toLocaleString()) +
      row('Sentences', s.sentences.toLocaleString()) +
      row('Unique words', s.unique.toLocaleString()) +
      row('Avg word length', s.avgWordLen ? s.avgWordLen.toFixed(1) : '—') +
      row('Reading time', fmtReadTime(s.readMins)) +
      (s.top.length
        ? '<div class="stats-sec">Top words</div>' + s.top.map(function (t) {
            return '<div class="stats-bar"><span class="stats-bar-w">' + esc(t.w) + '</span>' +
              '<span class="stats-bar-track"><span class="stats-bar-fill" style="width:' + Math.round(100 * t.n / maxN) + '%"></span></span>' +
              '<span class="stats-bar-n">' + t.n + '</span></div>';
          }).join('')
        : '');
  }

  var _t = null;
  Cade.onEditorUpdate(function (u) {
    if (!u.docChanged && !u.selectionSet) return;
    if (!document.getElementById(PANEL_ID)) return;
    clearTimeout(_t);
    _t = setTimeout(render, 350);
  });

  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById(PANEL_ID);
    if (existing) { existing.remove(); return; }
    Cade.mkPanel(PANEL_ID, '📊 Text Stats', '');
    render();
  }

  Cade.registerWidget({
    name: 'Text Stats',
    description: 'Live word / character / reading-time stats with top words',
    icon: '📊',
    tags: 'stats,words,count,characters,reading,time,frequency,analyze',
    open: open,
  });
})();
