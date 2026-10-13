/* 15-Puzzle — the sliding-tile classic, 3×3 up to 6×6, with numbers or a
 * picture (a generated pattern or an emoji of your choice).
 *
 * ENGINE: FifteenCore() is pure. Shuffles are uniformly random permutations
 * made solvable by the parity rule (odd width: the inversion count must be
 * even; even width: inversions + the blank's row counted from the bottom
 * must be odd) — a wrong-parity shuffle gets two tiles swapped, which flips
 * the parity. So every shuffle is solvable and none is a trivial one.
 *
 * PLAY: tap any tile in the gap's row or column to slide it (and everything
 * between) into the gap; swipe on the board, or use the arrow keys / WASD
 * (the arrow says which way a tile moves into the gap). Moves = tiles moved.
 * The clock starts with the first move. H toggles hints (numbers on the
 * picture + tiles already home), I toggles the picture, N reshuffles,
 * 3-6 pick the size, Esc closes. Each size keeps its own game and bests.
 *
 * Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('fifteen.css');

  // ---- pure engine ---------------------------------------------------------
  function FifteenCore() {
    function goal(n) { var a = []; for (var i = 1; i < n * n; i++) a.push(i); a.push(0); return a; }
    function inversions(t) {
      var inv = 0;
      for (var i = 0; i < t.length; i++) {
        if (!t[i]) continue;
        for (var j = i + 1; j < t.length; j++) if (t[j] && t[i] > t[j]) inv++;
      }
      return inv;
    }
    function solvable(t, n) {
      var inv = inversions(t);
      if (n % 2) return inv % 2 === 0;
      var fromBottom = n - Math.floor(t.indexOf(0) / n);      // 1-based
      return (inv + fromBottom) % 2 === 1;
    }
    function isSolved(t) {
      for (var i = 0; i < t.length - 1; i++) if (t[i] !== i + 1) return false;
      return t[t.length - 1] === 0;
    }
    function misplaced(t) { var k = 0; for (var i = 0; i < t.length; i++) if (t[i] && t[i] !== i + 1) k++; return k; }
    function shuffle(n, rnd) {
      rnd = rnd || Math.random;
      for (;;) {
        var t = goal(n), i;
        for (i = t.length - 1; i > 0; i--) { var j = (rnd() * (i + 1)) | 0, x = t[i]; t[i] = t[j]; t[j] = x; }
        if (!solvable(t, n)) {
          // Swapping two numbered tiles flips the parity (the blank stays put).
          var a = -1, b = -1;
          for (i = 0; i < t.length && b < 0; i++) if (t[i]) { if (a < 0) a = i; else b = i; }
          x = t[a]; t[a] = t[b]; t[b] = x;
        }
        if (misplaced(t) >= Math.min(n * n - 1, n + 2)) return t;
      }
    }
    // Slide the tile at idx (and any between it and the gap) into the gap.
    // Returns the number of tiles moved (0 if idx isn't in the gap's row/column).
    function slide(t, n, idx) {
      var b = t.indexOf(0), br = (b / n) | 0, bc = b % n, r = (idx / n) | 0, c = idx % n, k, step;
      if (idx === b || idx < 0 || idx >= t.length) return 0;
      if (r === br) {
        step = c < bc ? -1 : 1;
        for (k = bc; k !== c; k += step) t[r * n + k] = t[r * n + k + step];
        t[idx] = 0;
        return Math.abs(c - bc);
      }
      if (c === bc) {
        step = r < br ? -1 : 1;
        for (k = br; k !== r; k += step) t[k * n + c] = t[(k + step) * n + c];
        t[idx] = 0;
        return Math.abs(r - br);
      }
      return 0;
    }
    // Which tile moves for a direction ('up' = the tile below the gap moves up).
    function tileFor(t, n, dir) {
      var b = t.indexOf(0), r = (b / n) | 0, c = b % n;
      if (dir === 'up') return r < n - 1 ? b + n : -1;
      if (dir === 'down') return r > 0 ? b - n : -1;
      if (dir === 'left') return c < n - 1 ? b + 1 : -1;
      if (dir === 'right') return c > 0 ? b - 1 : -1;
      return -1;
    }
    return { goal: goal, inversions: inversions, solvable: solvable, isSolved: isSolved, shuffle: shuffle, slide: slide, tileFor: tileFor };
  }

  // ---- widget state ---------------------------------------------------------
  var PANEL_ID = 'fifteen-panel';
  var FIFTEEN_ICON = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2.5'/><rect x='5.5' y='5.5' width='5.5' height='5.5' rx='1'/><rect x='13' y='5.5' width='5.5' height='5.5' rx='1'/><rect x='5.5' y='13' width='5.5' height='5.5' rx='1'/><path d='M13.5 15.75h4.5m-1.6-1.6 1.6 1.6-1.6 1.6' stroke-linecap='round'/></svg>";
  var SAVE_KEY = 'cade-fifteen-save', STATS_KEY = 'cade-fifteen-stats', PREFS_KEY = 'cade-fifteen-prefs';
  var SIZES = [3, 4, 5, 6];
  var EMOJI = ['🐱', '🦊', '🐼', '🐸', '🦄', '🐙', '🌻', '🍉', '🍕', '🚀', '🌈', '⭐', '⚽', '🎸'];
  var IMG_PX = 480;                // generated picture size (sliced across the tiles)

  var core = null;
  var save = { n: 4, slots: {} };  // slots[n] = { tiles[], mv, t, started }
  var game = null;                 // save.slots[save.n]
  var stats = {}, prefs = { img: false, emoji: '', hints: false, hue: 200 };
  var ui = null, runSince = 0, tickIv = 0, imgCache = { key: '', url: '' };

  // ---- small helpers ----------------------------------------------------------
  function readJSON(k, d) { try { var v = JSON.parse(Cade.store.get(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function writeJSON(k, v) { try { Cade.store.set(k, JSON.stringify(v)); } catch (e) {} }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(ms) {
    var s = Math.floor((ms || 0) / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    s %= 60;
    return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s);
  }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function reduced() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function toast(msg, type) { try { Cade.showToast(msg, type || 'info', 2200); } catch (e) {} }
  function haptic(ms) { try { Cade.haptic(ms); } catch (e) {} }
  function esc(s) { return Cade.escapeHtml(String(s)); }
  function firstGrapheme(s) {
    s = String(s || '').trim();
    if (!s) return '';
    try { if (window.Intl && Intl.Segmenter) { var it = new Intl.Segmenter().segment(s)[Symbol.iterator]().next(); if (!it.done) return it.value.segment; } } catch (e) {}
    return Array.from(s).slice(0, 4).join('');
  }

  // ---- persistence ------------------------------------------------------------
  function validTiles(a, n) {
    if (!Array.isArray(a) || a.length !== n * n) return false;
    var seen = {};
    for (var i = 0; i < a.length; i++) { var v = a[i]; if (!(v >= 0 && v < n * n) || seen[v]) return false; seen[v] = 1; }
    return core.solvable(a, n);
  }
  function loadState() {
    var p = readJSON(PREFS_KEY, {});
    if (p && typeof p === 'object') {
      prefs.img = !!p.img; prefs.hints = !!p.hints;
      prefs.emoji = typeof p.emoji === 'string' ? firstGrapheme(p.emoji) : '';
      if (p.hue >= 0 && p.hue < 360) prefs.hue = p.hue;
    }
    stats = readJSON(STATS_KEY, {});
    if (!stats || typeof stats !== 'object') stats = {};
    var s = readJSON(SAVE_KEY, null);
    save = { n: 4, slots: {} };
    if (s && typeof s === 'object') {
      if (SIZES.indexOf(s.n) !== -1) save.n = s.n;
      if (s.slots && typeof s.slots === 'object') {
        SIZES.forEach(function (n) {
          var g = s.slots[n];
          if (!g || typeof g !== 'object') return;
          var tiles = String(g.tiles || '').split(',').map(Number);
          if (!validTiles(tiles, n) || core.isSolved(tiles)) return;
          save.slots[n] = { tiles: tiles, mv: +g.mv || 0, t: +g.t || 0, started: g.started ? 1 : 0 };
        });
      }
    }
    game = save.slots[save.n] || null;
  }
  function persist() {
    foldClock();
    var out = { n: save.n, slots: {} };
    for (var n in save.slots) {
      var g = save.slots[n];
      out.slots[n] = { tiles: g.tiles.join(','), mv: g.mv, t: Math.round(g.t), started: g.started };
    }
    writeJSON(SAVE_KEY, out);
  }
  function savePrefs() { writeJSON(PREFS_KEY, prefs); }

  // ---- clock ----------------------------------------------------------------------
  function elapsed() { return game ? game.t + (runSince ? now() - runSince : 0) : 0; }
  function foldClock() { if (runSince && game) { var n = now(); game.t += n - runSince; runSince = n; } }
  function stopClock() { foldClock(); runSince = 0; }
  function canRun() { return !!(ui && game && game.started && !ui.won && !ui.ovKind && !document.hidden); }
  function syncClock() { if (canRun()) { if (!runSince) runSince = now(); } else stopClock(); paintHud(); }

  // ---- game flow ----------------------------------------------------------------------
  function newGame(n) {
    stopClock();
    n = n || save.n;
    save.n = n;
    game = save.slots[n] = { tiles: core.shuffle(n), mv: 0, t: 0, started: 0 };
    persist();
    if (!ui) return;
    ui.won = false;
    hideOverlay();
    build();
    syncClock();
  }
  function switchSize(n) {
    if (n === save.n && game && !ui.won) return;
    stopClock();
    save.n = n;
    game = save.slots[n];
    if (!game) { newGame(n); return; }
    ui.won = false;
    persist();
    hideOverlay();
    build();
    syncClock();
  }
  function playable() { return !!(ui && game && !ui.won && !ui.ovKind); }
  function tryMove(idx) {
    if (!playable()) return false;
    var k = core.slide(game.tiles, save.n, idx);
    if (!k) { bump(idx); return false; }
    if (!game.started) { game.started = 1; stats[save.n] = stats[save.n] || {}; stats[save.n].p = (stats[save.n].p || 0) + 1; writeJSON(STATS_KEY, stats); }
    game.mv += k;
    haptic(6);
    paint();
    syncClock();
    if (core.isSolved(game.tiles)) win();
    else persist();
    return true;
  }
  function moveDir(dir) {
    if (!playable()) return;
    var idx = core.tileFor(game.tiles, save.n, dir);
    if (idx >= 0) tryMove(idx); else bumpBoard();
  }

  function win() {
    stopClock();
    ui.won = true;
    var n = save.n, g = game, st = stats[n] = stats[n] || {}, newT = false, newM = false;
    st.w = (st.w || 0) + 1;
    if (!st.bt || g.t < st.bt) { newT = !!st.bt || st.w === 1; st.bt = g.t; }
    if (!st.bm || g.mv < st.bm) { newM = !!st.bm || st.w === 1; st.bm = g.mv; }
    writeJSON(STATS_KEY, stats);
    delete save.slots[n];                     // solved: the next visit to this size reshuffles
    persist();
    paint();
    paintHud();
    haptic(30);
    ui.board.classList.add('won');
    var first = st.w === 1;
    var html = '<div class="fp-card"><div class="fp-big">🎉</div><b class="fp-title">Solved!</b>' +
      '<div class="fp-sub">' + n + '×' + n + '</div>' +
      '<div class="fp-winrow"><div><b>' + fmtTime(g.t) + '</b><span>time</span></div><div><b>' + g.mv + '</b><span>moves</span></div></div>' +
      '<div class="fp-sub">' + (first ? 'First solve at this size!' : newT && newM ? 'New best time and moves!' : newT ? 'New best time!' : newM ? 'Fewest moves yet!' :
        'Best ' + fmtTime(st.bt) + ' · ' + st.bm + ' moves') + '</div>' +
      '<div class="fp-acts"><button class="fp-primary" data-act="again">Play again</button><button data-act="stats">Best</button><button data-act="hide">View</button></div></div>';
    clearTimeout(ui.winTimer);
    ui.winTimer = setTimeout(function () { if (ui && ui.won) showOverlay('win', html); }, reduced() ? 200 : 1200);
  }

  // ---- picture (generated once per settings, then sliced by CSS) ---------------------
  function pictureURL() {
    var key = (prefs.emoji || 'pattern') + '|' + prefs.hue;
    if (imgCache.key === key) return imgCache.url;
    var c = document.createElement('canvas');
    c.width = c.height = IMG_PX;
    var g = c.getContext('2d');
    if (!g) return '';
    var S = IMG_PX, h = prefs.hue, i;
    function hsl(hh, s, l, a) { return 'hsla(' + (((hh % 360) + 360) % 360) + ',' + s + '%,' + l + '%,' + (a == null ? 1 : a) + ')'; }
    var bg = g.createLinearGradient(0, 0, S, S);
    bg.addColorStop(0, hsl(h, 75, 62)); bg.addColorStop(0.5, hsl(h + 60, 70, 52)); bg.addColorStop(1, hsl(h + 150, 65, 40));
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    if (!prefs.emoji) {
      // Distinct shapes everywhere, so every tile has something to recognise.
      for (i = 9; i > 0; i--) {
        g.beginPath(); g.arc(S * 0.32, S * 0.62, S * 0.075 * i, 0, Math.PI * 2);
        g.fillStyle = hsl(h + i * 24, 85, i % 2 ? 70 : 45, 0.28); g.fill();
      }
      g.save(); g.globalAlpha = 0.22; g.fillStyle = '#fff';
      for (i = -S; i < S * 2; i += S / 7) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + S * 0.05, 0); g.lineTo(i - S + S * 0.05, S); g.lineTo(i - S, S); g.closePath(); g.fill(); }
      g.restore();
      g.beginPath(); g.arc(S * 0.76, S * 0.24, S * 0.15, 0, Math.PI * 2);
      g.fillStyle = hsl(h + 200, 95, 78); g.fill();
      g.lineWidth = S * 0.02; g.strokeStyle = hsl(h + 220, 80, 40, 0.6); g.stroke();
      for (i = 0; i < 4; i++) {
        g.beginPath();
        for (var x = 0; x <= S; x += 8) { var y = S * (0.78 + i * 0.06) + Math.sin(x / S * Math.PI * (3 + i) + i) * S * 0.03; if (x) g.lineTo(x, y); else g.moveTo(x, y); }
        g.lineWidth = S * 0.018; g.strokeStyle = hsl(h + 90 + i * 40, 90, 85 - i * 10, 0.75); g.stroke();
      }
      for (var r = 0; r < 6; r++) for (var q = 0; q < 6; q++) {
        g.beginPath(); g.arc(S * (q + 0.5) / 6, S * (r + 0.5) / 6, S * (0.008 + 0.004 * ((q + r) % 4)), 0, Math.PI * 2);
        g.fillStyle = 'rgba(255,255,255,0.55)'; g.fill();
      }
    } else {
      var rg = g.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S * 0.7);
      rg.addColorStop(0, 'rgba(255,255,255,0.55)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.fillRect(0, 0, S, S);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = Math.round(S * 0.74) + 'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      g.fillText(prefs.emoji, S / 2, S * 0.54);
    }
    var url = '';
    try { url = c.toDataURL('image/jpeg', 0.9); } catch (e) { url = ''; }
    imgCache = { key: key, url: url };
    return url;
  }

  // ---- rendering ----------------------------------------------------------------------
  function build() {
    if (!ui) return;
    var n = save.n, html = '';
    ui.board.style.setProperty('--n', n);
    ui.board.className = 'fp-board fp-n' + n;
    for (var v = 1; v < n * n; v++) {
      var hr = ((v - 1) / n) | 0, hc = (v - 1) % n;
      html += '<div class="fp-t" data-v="' + v + '"><div class="fp-ti" style="background-position:' +
        (n > 1 ? hc * 100 / (n - 1) : 0) + '% ' + (n > 1 ? hr * 100 / (n - 1) : 0) + '%"><span class="fp-num">' + v + '</span></div></div>';
    }
    // The missing last tile only appears to complete a solved picture.
    html += '<div class="fp-t fp-last" style="transform:translate(' + (n - 1) * 100 + '%,' + (n - 1) * 100 + '%);--d:' + (2 * n - 2) + '"><div class="fp-ti" style="background-position:100% 100%"><span class="fp-num">✓</span></div></div>';
    ui.board.innerHTML = html;
    ui.tiles = [];
    ui.board.querySelectorAll('.fp-t[data-v]').forEach(function (el) { ui.tiles[+el.getAttribute('data-v')] = el; });
    ui.board.classList.add('fp-noanim');
    paint();
    void ui.board.offsetWidth;
    ui.board.classList.remove('fp-noanim');
    paintHud();
  }
  function paint() {
    if (!ui || !game) return;
    var n = save.n, t = game.tiles;
    var url = prefs.img ? pictureURL() : '';
    ui.board.style.setProperty('--fp-img', url ? 'url("' + url + '")' : 'none');
    ui.board.classList.toggle('fp-img', !!url);
    ui.board.classList.toggle('fp-hints', prefs.hints);
    for (var i = 0; i < t.length; i++) {
      var v = t[i];
      if (!v) continue;
      var el = ui.tiles[v], r = (i / n) | 0, c = i % n;
      var tr = 'translate(' + c * 100 + '%,' + r * 100 + '%)';
      if (el.style.transform !== tr) el.style.transform = tr;
      var home = v === i + 1;
      if (el.classList.contains('home') !== home) el.classList.toggle('home', home);
      el.style.setProperty('--d', r + c);
    }
  }
  function paintHud() {
    if (!ui) return;
    var set = function (el, v) { v = String(v); if (el.textContent !== v) el.textContent = v; };
    set(ui.moves, game ? game.mv : 0);
    set(ui.time, fmtTime(elapsed()));
    ui.root.querySelectorAll('[data-size]').forEach(function (b) { b.classList.toggle('on', +b.getAttribute('data-size') === save.n); });
    ui.imgBtn.classList.toggle('on', prefs.img);
    ui.hintBtn.classList.toggle('on', prefs.hints);
    var st = stats[save.n] || {};
    set(ui.best, st.bt ? 'Best ' + fmtTime(st.bt) + ' · ' + st.bm : '');
  }
  function bump(idx) {
    if (!ui || !game) return;
    var v = game.tiles[idx], el = v ? ui.tiles[v] : null;
    if (!el) return;
    var inner = el.firstChild;
    inner.classList.remove('fp-bump'); void inner.offsetWidth; inner.classList.add('fp-bump');
  }
  function bumpBoard() {
    if (!ui) return;
    ui.wrap.classList.remove('fp-bump'); void ui.wrap.offsetWidth; ui.wrap.classList.add('fp-bump');
  }

  // ---- overlays -------------------------------------------------------------------------
  function showOverlay(kind, html) {
    if (!ui) return;
    ui.ovKind = kind;
    ui.ov.className = 'fp-ov show';
    ui.ov.innerHTML = html;
    syncClock();
  }
  function hideOverlay() {
    if (!ui) return;
    ui.ovKind = '';
    ui.ov.className = 'fp-ov';
    ui.ov.innerHTML = '';
    syncClock();
  }
  function picMenu() {
    var grid = '<button class="fp-pic' + (!prefs.emoji ? ' on' : '') + '" data-act="pic" data-e="">🎨<span>Pattern</span></button>';
    EMOJI.forEach(function (e) { grid += '<button class="fp-pic' + (prefs.emoji === e ? ' on' : '') + '" data-act="pic" data-e="' + esc(e) + '">' + e + '</button>'; });
    var custom = prefs.emoji && EMOJI.indexOf(prefs.emoji) === -1;
    grid += '<button class="fp-pic' + (custom ? ' on' : '') + '" data-act="custom">' + (custom ? esc(prefs.emoji) : '\u270F\uFE0F') + '<span>Custom</span></button>';
    showOverlay('menu', '<div class="fp-card"><b class="fp-title">Picture</b><div class="fp-pics">' + grid + '</div>' +
      '<div class="fp-acts"><button data-act="hue">🎲 New colours</button><button class="fp-primary" data-act="hide">Done</button></div></div>');
  }
  function statsMenu() {
    var rows = '';
    SIZES.forEach(function (n) {
      var s = stats[n] || {};
      rows += '<tr><td>' + n + '×' + n + '</td><td>' + (s.w || 0) + (s.p ? '/' + s.p : '') + '</td><td>' + (s.bt ? fmtTime(s.bt) : '—') + '</td><td>' + (s.bm || '—') + '</td></tr>';
    });
    showOverlay('stats', '<div class="fp-card"><b class="fp-title">Best results</b>' +
      '<table class="fp-stats"><thead><tr><th></th><th>Solved</th><th>Best time</th><th>Fewest moves</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="fp-hint">Tap a tile in the gap’s row or column · swipe · arrows/WASD · H hints · I picture · N shuffle · 3–6 size · Esc close</div>' +
      '<div class="fp-acts"><button data-act="resetstats">Reset</button><button class="fp-primary" data-act="hide">Close</button></div></div>');
  }
  function onOverlayClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'hide') hideOverlay();
    else if (act === 'again') newGame(save.n);
    else if (act === 'stats') statsMenu();
    else if (act === 'pic') { prefs.emoji = b.getAttribute('data-e') || ''; prefs.img = true; savePrefs(); paint(); paintHud(); picMenu(); }
    else if (act === 'custom') {
      var v = window.prompt('Picture emoji (or any character):', prefs.emoji || '');
      if (v == null) return;
      v = firstGrapheme(v);
      if (!v) return;
      prefs.emoji = v; prefs.img = true; savePrefs(); paint(); paintHud(); picMenu();
    }
    else if (act === 'hue') { prefs.hue = Math.floor(Math.random() * 360); prefs.img = true; savePrefs(); paint(); paintHud(); }
    else if (act === 'resetstats') { if (window.confirm('Reset all 15-Puzzle bests?')) { stats = {}; writeJSON(STATS_KEY, stats); statsMenu(); paintHud(); } }
  }

  // ---- panel ----------------------------------------------------------------------------
  function buildHtml() {
    var sizes = '';
    SIZES.forEach(function (n) { sizes += '<button data-size="' + n + '">' + n + '×' + n + '</button>'; });
    function tool(act, icon, label, title) {
      return '<button class="fp-tool" data-tool="' + act + '" title="' + title + '"><span class="fp-ic">' + icon + '</span><span class="fp-tl">' + label + '</span></button>';
    }
    return '<div class="fp" tabindex="-1">' +
      '<div class="fp-top"><div class="fp-seg">' + sizes + '</div></div>' +
      '<div class="fp-hud"><span>Moves <b class="fp-moves">0</b></span><span class="fp-best"></span><span class="fp-time">0:00</span></div>' +
      '<div class="fp-wrap"><div class="fp-board"></div><div class="fp-ov"></div></div>' +
      '<div class="fp-tools">' +
        tool('new', '↻', 'Shuffle', 'New shuffle (N)') + tool('img', '🖼', 'Picture', 'Numbers / picture (I)') +
        tool('pic', '🎨', 'Choose', 'Choose the picture') + tool('hints', '🔢', 'Hints', 'Show numbers & tiles already home (H)') +
        tool('stats', '🏆', 'Best', 'Best results') +
      '</div></div>';
  }

  function close() {
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    teardown();
    try { Cade.editor.focus(); } catch (e) {}
  }
  function teardown() {
    if (!ui) return;
    stopClock();
    persist();
    clearInterval(tickIv); tickIv = 0;
    clearTimeout(ui.winTimer);
    document.removeEventListener('keydown', ui.onKey, true);
    document.removeEventListener('visibilitychange', ui.onVis);
    window.removeEventListener('pagehide', ui.onHide);
    ui = null;
  }

  function cellAt(clientX, clientY) {
    var r = ui.board.getBoundingClientRect(), n = save.n;
    if (!r.width) return -1;
    var c = Math.floor((clientX - r.left) / (r.width / n)), w = Math.floor((clientY - r.top) / (r.height / n));
    if (c < 0 || c >= n || w < 0 || w >= n) return -1;
    return w * n + c;
  }

  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    core = core || FifteenCore();
    loadState();
    var p = Cade.mkPanel(PANEL_ID, '▦ 15-Puzzle', buildHtml());
    try { Cade.markGamePanel(p); } catch (e) {}
    var root = p.querySelector('.fp');
    ui = {
      panel: p, root: root, board: root.querySelector('.fp-board'), wrap: root.querySelector('.fp-wrap'), ov: root.querySelector('.fp-ov'),
      moves: root.querySelector('.fp-moves'), time: root.querySelector('.fp-time'), best: root.querySelector('.fp-best'),
      imgBtn: root.querySelector('[data-tool="img"]'), hintBtn: root.querySelector('[data-tool="hints"]'),
      tiles: [], ovKind: '', won: false, press: null
    };
    p._onClose = teardown;

    ui.onKey = onKey;
    ui.onVis = function () { if (!ui) return; if (document.hidden) persist(); syncClock(); };
    ui.onHide = function () { persist(); };
    document.addEventListener('keydown', ui.onKey, true);
    document.addEventListener('visibilitychange', ui.onVis);
    window.addEventListener('pagehide', ui.onHide);

    // Tap = slide the tapped tile's row/column run; swipe = move the tile next
    // to the gap in the swipe direction.
    var wrap = ui.wrap;
    wrap.addEventListener('pointerdown', function (e) {
      if (e.button > 0 || ui.ovKind) return;
      e.preventDefault();
      try { root.focus({ preventScroll: true }); } catch (x) {}
      try { wrap.setPointerCapture(e.pointerId); } catch (x) {}
      ui.press = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    function release(e, cancel) {
      var pr = ui && ui.press;
      if (!pr || pr.id !== e.pointerId) return;
      ui.press = null;
      if (cancel) return;
      var dx = e.clientX - pr.x, dy = e.clientY - pr.y, ax = Math.abs(dx), ay = Math.abs(dy);
      if (ax < 14 && ay < 14) { var idx = cellAt(pr.x, pr.y); if (idx >= 0) tryMove(idx); return; }
      if (ax > ay) moveDir(dx > 0 ? 'right' : 'left'); else moveDir(dy > 0 ? 'down' : 'up');
    }
    wrap.addEventListener('pointerup', function (e) { release(e, false); });
    wrap.addEventListener('pointercancel', function (e) { release(e, true); });

    root.addEventListener('click', function (e) {
      var t = e.target;
      if (ui.ov.contains(t)) { onOverlayClick(e); return; }
      var sz = t.closest ? t.closest('[data-size]') : null;
      if (sz) { switchSize(+sz.getAttribute('data-size')); return; }
      var tl = t.closest ? t.closest('[data-tool]') : null;
      if (!tl) return;
      var a = tl.getAttribute('data-tool');
      if (a === 'new') reshuffle();
      else if (a === 'img') { prefs.img = !prefs.img; savePrefs(); paint(); paintHud(); }
      else if (a === 'pic') picMenu();
      else if (a === 'hints') { prefs.hints = !prefs.hints; savePrefs(); paint(); paintHud(); }
      else if (a === 'stats') statsMenu();
    });

    try { root.focus({ preventScroll: true }); } catch (e) {}
    tickIv = setInterval(function () { if (ui && runSince) paintHud(); }, 500);
    if (!game) newGame(save.n);
    else { build(); syncClock(); }
  }
  function reshuffle() {
    if (game && game.started && !ui.won && game.mv > 0 && !window.confirm('Shuffle and start over?')) return;
    newGame(save.n);
  }

  function onKey(e) {
    if (!ui) return;
    var ae = document.activeElement;
    if (ae && ae !== document.body && !ui.panel.contains(ae) && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) return;
    var k = e.key, handled = true;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right' }[k];
    if (k === 'Escape') { if (ui.ovKind) hideOverlay(); else close(); }
    else if (ui.ovKind) { if (k === 'Enter' || k === ' ') { if (ui.ovKind === 'win') newGame(save.n); else hideOverlay(); } else handled = false; }
    else if (dir) moveDir(dir);
    else if (/^[3-6]$/.test(k)) switchSize(+k);
    else if (k === 'n' || k === 'N' || k === 'r' || k === 'R') reshuffle();
    else if (k === 'h' || k === 'H') { prefs.hints = !prefs.hints; savePrefs(); paint(); paintHud(); }
    else if (k === 'i' || k === 'I') { prefs.img = !prefs.img; savePrefs(); paint(); paintHud(); }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  Cade.registerWidget({
    name: '15-Puzzle',
    description: 'Slide the tiles back in order — 3×3 to 6×6, numbers or a picture',
    icon: FIFTEEN_ICON,
    tags: 'game,15 puzzle,fifteen,sliding puzzle,slide,tiles,puzzle,numbers,picture,brain,fun,train',
    open: open,
    _core: function () { return FifteenCore(); }     // exposed for headless tests
  });
})();
