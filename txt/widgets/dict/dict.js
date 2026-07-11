/* Dictionary — definitions, synonyms & antonyms lookup panel.

   Opens on the current selection (or the word at the caret) and looks it up
   against the free dictionaryapi.dev API. Every meaning shows its part of
   speech, up to 4 definitions (with example), and synonym/antonym chips —
   clicking a chip looks that word up; the ↩ button next to a synonym replaces
   the current editor selection with it.

   OFFLINE: each successful lookup is slimmed to just what we render and cached
   in Cade.idbStore under `dict:<word>`; lookups check the cache first, so any
   word looked up once keeps working offline. A `dict:__index` array tracks
   cached words and is pruned to the most recent 500 (evicted entries are
   deleted — memory care). */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('dict.css');
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'dict-panel';
  var API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
  var IDX_KEY = 'dict:__index';
  var MAX_WORDS = 500;   // cache cap (see prune in cachePut)
  var MAX_MEANINGS = 8;  // across all API entries for a word

  var panel = null;      // live panel element (null when closed)
  var seq = 0;           // lookup sequence guard (ignore stale async results)

  // ---- editor helpers ----------------------------------------------------

  // Non-empty live selection range, or null.
  function editorSel() {
    try {
      var m = window.editor.state.selection.main;
      if (!m.empty) return { from: m.from, to: m.to };
    } catch (e) {}
    return null;
  }

  // The selected word, or the word at the caret. Null if neither.
  function currentWord() {
    try {
      var st = window.editor.state;
      var m = st.selection.main;
      if (!m.empty) {
        var s = st.sliceDoc(m.from, m.to);
        return (String(s).match(/[A-Za-z'’-]+/) || [null])[0];
      }
      var line = st.doc.lineAt(m.head);
      var text = line.text, i = m.head - line.from;
      var isW = function (ch) { return /[A-Za-z'’-]/.test(ch); };
      var a = i, b = i;
      while (a > 0 && isW(text[a - 1])) a--;
      while (b < text.length && isW(text[b])) b++;
      var w = text.slice(a, b).replace(/^['’-]+|['’-]+$/g, '');
      return w || null;
    } catch (e) {}
    return null;
  }

  // ---- slimming + offline cache ------------------------------------------

  function strList(arr) {
    var out = [], seen = {};
    if (!Array.isArray(arr)) return out;
    for (var i = 0; i < arr.length; i++) {
      var s = String(arr[i] == null ? '' : arr[i]).trim();
      var k = s.toLowerCase();
      if (!s || seen[k]) continue;
      seen[k] = 1;
      out.push(s);
    }
    return out;
  }

  // Keep ONLY what we render (the raw API payload carries audio URLs, license
  // blocks, source lists… — dead weight in IndexedDB).
  function slim(entries) {
    var first = entries[0] || {};
    var out = { word: String(first.word || ''), phonetic: '', meanings: [] };
    for (var e = 0; e < entries.length; e++) {
      var entry = entries[e] || {};
      if (!out.phonetic) {
        out.phonetic = String(entry.phonetic ||
          (Array.isArray(entry.phonetics)
            ? (entry.phonetics.map(function (p) { return p && p.text; }).filter(Boolean)[0] || '')
            : ''));
      }
      var ms = Array.isArray(entry.meanings) ? entry.meanings : [];
      for (var i = 0; i < ms.length && out.meanings.length < MAX_MEANINGS; i++) {
        var m = ms[i] || {};
        out.meanings.push({
          partOfSpeech: String(m.partOfSpeech || ''),
          definitions: (Array.isArray(m.definitions) ? m.definitions : []).slice(0, 4).map(function (d) {
            d = d || {};
            return { definition: String(d.definition || ''), example: String(d.example || '') };
          }),
          synonyms: strList(m.synonyms).slice(0, 12),
          antonyms: strList(m.antonyms).slice(0, 8),
        });
      }
    }
    return out;
  }

  // Store the slimmed result and maintain the recency index (prune to the
  // most recent MAX_WORDS; delete evicted dict:<w> entries).
  function cachePut(key, data) {
    return Cade.idbStore.set('dict:' + key, data)
      .then(function () { return Cade.idbStore.get(IDX_KEY); })
      .then(function (idx) {
        idx = Array.isArray(idx) ? idx : [];
        var i = idx.indexOf(key);
        if (i !== -1) idx.splice(i, 1);
        idx.push(key); // most recent last
        var evicted = [];
        while (idx.length > MAX_WORDS) evicted.push(idx.shift());
        return Cade.idbStore.set(IDX_KEY, idx).then(function () {
          return Promise.all(evicted.map(function (w) {
            return Cade.idbStore.remove('dict:' + w);
          }));
        });
      })
      .catch(function () { /* cache is best-effort */ });
  }

  // ---- rendering -----------------------------------------------------------

  function panelEl() { return panel || document.getElementById(PANEL_ID); }

  function setResults(html) {
    var p = panelEl();
    var el = p && p.querySelector && p.querySelector('.dict-results');
    if (el) el.innerHTML = html;
  }

  function setInput(word) {
    try {
      var p = panelEl();
      var input = p && p.querySelector && p.querySelector('.dict-input');
      if (input) input.value = word;
    } catch (e) {}
  }

  function status(html) { return '<div class="dict-status">' + html + '</div>'; }

  // Escape a word for use inside onclick="…('WORD')" (quote/backslash, then HTML).
  function attr(w) {
    return esc(String(w).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
  }

  function chip(w, withInsert) {
    var a = attr(w);
    return '<span class="dict-chipwrap">' +
      '<button class="dict-chip" onclick="window.__dictLookup(\'' + a + '\')">' + esc(w) + '</button>' +
      (withInsert
        ? '<button class="dict-ins" title="Replace selection with ‘' + esc(w) + '’" ' +
          'onclick="window.__dictInsert(\'' + a + '\')">↩</button>'
        : '') +
      '</span>';
  }

  function renderResult(data, fromCache) {
    var showIns = !!editorSel(); // Insert only makes sense with a selection
    var html = '<div class="dict-word">' + esc(data.word) +
      (data.phonetic ? ' <span class="dict-phon">' + esc(data.phonetic) + '</span>' : '') +
      (fromCache ? ' <span class="dict-cached" title="Served from offline cache">cached</span>' : '') +
      '</div>';
    (data.meanings || []).forEach(function (m) {
      html += '<div class="dict-pos">' + esc(m.partOfSpeech) + '</div>';
      html += '<ol class="dict-defs">' + (m.definitions || []).map(function (d) {
        return '<li>' + esc(d.definition) +
          (d.example ? '<div class="dict-ex">“' + esc(d.example) + '”</div>' : '') +
          '</li>';
      }).join('') + '</ol>';
      if (m.synonyms && m.synonyms.length) {
        html += '<div class="dict-lbl">Synonyms</div><div class="dict-chips">' +
          m.synonyms.map(function (w) { return chip(w, showIns); }).join('') + '</div>';
      }
      if (m.antonyms && m.antonyms.length) {
        html += '<div class="dict-lbl">Antonyms</div><div class="dict-chips">' +
          m.antonyms.map(function (w) { return chip(w, false); }).join('') + '</div>';
      }
    });
    setResults(html);
  }

  // ---- lookup --------------------------------------------------------------

  function lookup(raw) {
    var word = String(raw == null ? '' : raw).trim().split(/\s+/)[0] || '';
    word = word.replace(/^[^A-Za-z'’-]+|[^A-Za-z'’-]+$/g, '');
    if (!word) return;
    var key = word.toLowerCase();
    var my = ++seq;
    setInput(word);
    setResults(status('Looking up “' + esc(word) + '”…'));
    // Cache first (this is the offline story), then network.
    Cade.idbStore.get('dict:' + key).then(function (cached) {
      if (my !== seq) return;
      if (cached && cached.word && Array.isArray(cached.meanings)) {
        renderResult(cached, true);
        return;
      }
      fetchWord(word, key, my);
    }).catch(function () {
      if (my === seq) fetchWord(word, key, my);
    });
  }

  function fetchWord(word, key, my) {
    fetch(API + encodeURIComponent(key)).then(function (res) {
      if (my !== seq) return;
      if (res.status === 404) {         // word not in the dictionary
        setResults(status('No definition found for “' + esc(word) + '”.'));
        return;
      }
      if (!res.ok) {
        setResults(status('Lookup failed (HTTP ' + esc(String(res.status)) + '). Try again.'));
        return;
      }
      return res.json().then(function (json) {
        if (my !== seq) return;
        if (!Array.isArray(json) || !json.length) {
          setResults(status('No definition found for “' + esc(word) + '”.'));
          return;
        }
        var data = slim(json);
        renderResult(data, false);
        cachePut(key, data);            // best-effort offline cache
      });
    }).catch(function () {              // network failure (offline / blocked)
      if (my !== seq) return;
      setResults(status('Can’t reach the dictionary service. Needs one online lookup to cache “' + esc(word) + '”.'));
    });
  }

  // ---- inline onclick handlers (window.* required for innerHTML buttons) ---

  window.__dictLookup = function (w) { lookup(w); };

  window.__dictInsert = function (w) {
    try {
      var m = window.editor.state.selection.main;
      if (m.empty) { Cade.showToast('Select text in the editor first', 'info', 2200); return; }
      window.editor.dispatch({
        changes: { from: m.from, to: m.to, insert: w },
        selection: { anchor: m.from, head: m.from + String(w).length },
      });
      Cade.showToast('Replaced selection with “' + w + '”', 'success', 1600);
    } catch (e) {
      Cade.showToast('Couldn’t insert', 'error', 2000);
    }
  };

  // ---- panel ---------------------------------------------------------------

  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById(PANEL_ID);
    if (existing) { existing.remove(); panel = null; return; } // toggle
    var word = currentWord();
    panel = Cade.mkPanel(PANEL_ID, '📖 Dictionary',
      '<div class="dict-search">' +
        '<input class="dict-input" type="text" placeholder="Type a word, press Enter" ' +
          'spellcheck="false" autocomplete="off" autocapitalize="off">' +
      '</div>' +
      '<div class="dict-results">' + status('Type a word and press Enter.') + '</div>' +
      '<div class="dict-footer">Powered by dictionaryapi.dev · looked-up words work offline</div>');
    panel._onClose = function () { panel = null; seq++; };
    var input = panel.querySelector ? panel.querySelector('.dict-input') : null;
    if (input && input.addEventListener) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') lookup(input.value);
      });
    }
    if (word) {
      lookup(word);
    } else if (input && input.focus) {
      setTimeout(function () { try { input.focus(); } catch (e) {} }, 0);
    }
  }

  Cade.registerWidget({
    name: 'Dictionary',
    description: 'Definitions, synonyms & antonyms (caches words for offline)',
    icon: '📖',
    tags: 'dictionary,thesaurus,define,definition,synonym,antonym,word,lookup',
    open: open,
  });
})();
