/* Arcade — every game in Cade.txt in one place.
 * A launcher hub: an ASCII marquee (chaser lights, a scrolling ticker), a
 * search box, category chips, favourites (star), recently played, a random
 * game roulette, and a grid / compact list view. The game list is discovered
 * at runtime from Cade.commands() (widget rows), so games added to the
 * manifest later show up here without a code change: a small override map
 * by manifest id / name places the games we know about in a category, and
 * tag heuristics place the rest. Non-game helpers (Score Keeper, Chess Clock,
 * Remote, ARG Desk, Random Picker) are listed under "Game tools".
 * Launching uses Cade.runCommand(name) — the palette's own semantics, so lazy
 * modules load on first launch. A game whose panel is already open is brought
 * back (restored if minimized) instead of being toggled closed. After a launch
 * the Arcade stays open, minimizes (default) or closes — a setting.
 * Not a game panel: typing in the search box works like any input.
 * State persists in Cade.store (cade-arcade-state). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var SELF = 'Arcade';
  var MAX_RECENT = 12, MAX_FAVS = 300, MAX_PLAYS = 1e7;

  // Categories, in display order. glyph: the ASCII mark on the section header.
  var CATS = [
    { id: 'action', label: 'Arcade & Action', chip: 'Arcade', glyph: '>>' },
    { id: 'puzzle', label: 'Puzzle', chip: 'Puzzle', glyph: '[?]' },
    { id: 'word', label: 'Word', chip: 'Word', glyph: 'Aa' },
    { id: 'board', label: 'Board & Cards', chip: 'Board & Cards', glyph: '[#]' },
    { id: 'sports', label: 'Sports & Physics', chip: 'Sports', glyph: 'o/' },
    { id: 'sims', label: 'Sims & Idle', chip: 'Sims', glyph: '$$' },
    { id: 'story', label: 'Story', chip: 'Story', glyph: '{~}' },
    { id: 'party', label: 'Party', chip: 'Party', glyph: '\\o/' },
    { id: 'learn', label: 'Learning', chip: 'Learning', glyph: '+1' },
    { id: 'toys', label: 'Toys', chip: 'Toys', glyph: '~*' },
    { id: 'tools', label: 'Game tools', chip: 'Tools', glyph: '%' }
  ];
  var CAT = {};
  for (var ci = 0; ci < CATS.length; ci++) CAT[CATS[ci].id] = CATS[ci];

  // Known games by manifest id (and a few by name) → category. 'tools' entries
  // are listed even without a game tag. Unknown games fall back to the tag heuristics.
  var OVERRIDE = {
    // arcade & action
    snake: 'action', breakout: 'action', tetris: 'action', pong: 'action', flappy: 'action', asteroids: 'action',
    invaders: 'action', learntofly: 'action', uphill: 'action', duskdash: 'action', lander: 'action', roadhopper: 'action',
    mazemuncher: 'action', pinball: 'action', bugswarm: 'action', caveflyer: 'action', stacktower: 'action',
    slingshot: 'action', crawler: 'action', towerdefense: 'action', towerdefense2: 'action',
    // puzzle
    g2048: 'puzzle', sudoku: 'puzzle', fifteen: 'puzzle', flowlines: 'puzzle', chesspuzzles: 'puzzle',
    bridge: 'puzzle', factory: 'puzzle', inkdrop: 'puzzle',
    // word
    crossword: 'word', wordle: 'word', cryptogram: 'word', wordladder: 'word', wordsearch: 'word', lettertiles: 'word',
    // board & cards
    spider: 'board', connect4: 'board', chess: 'board', checkers: 'board', seabattle: 'board', mancala: 'board',
    dotsboxes: 'board', blackjack: 'board', holdem: 'board', farkle: 'board', hearts: 'board', deckbuilder: 'board',
    // sports & physics
    minigolf: 'sports', pool: 'sports', bowling: 'sports', darts: 'sports', curling: 'sports', papertoss: 'sports',
    // sims & idle
    lemonade: 'sims', tinyfarm: 'sims', spacetrader: 'sims',
    // story
    adventure: 'story', escaperoom: 'story',
    // party
    partygames: 'party', autocomplete: 'party', trivia: 'party', plates: 'party',
    // learning
    geoquiz: 'learn', morse: 'learn', typing: 'learn',
    // toys
    fallingsand: 'toys', marblerun: 'toys',
    // game tools
    scorekeeper: 'tools', chessclock: 'tools', remote: 'tools', arg: 'tools', picker: 'tools',
    'score keeper': 'tools', 'chess clock': 'tools', 'arg desk': 'tools', 'random picker': 'tools'
  };

  // Tag heuristics for games the override map doesn't know. Whole tag tokens
  // (comma separated, trimmed, lower case) → category weight.
  var HINTS = {
    action: ['arcade', 'action', 'shooter', 'platformer', 'endless', 'one button', 'retro', 'runner', 'racing', 'roguelike', 'tower defense', 'reflex', 'space'],
    puzzle: ['puzzle', 'logic', 'brain', 'sliding puzzle', 'match 3', 'match-3', 'nonogram', 'picross', 'minesweeper', 'riddle', 'maze'],
    word: ['word', 'words', 'word game', 'letters', 'anagram', 'crossword', 'spelling', 'scrabble', 'vocabulary', 'hangman', 'boggle'],
    board: ['board', 'board game', 'cards', 'card game', 'chess', 'checkers', 'dice', 'casino', 'poker', 'solitaire', 'tiles', 'dominoes', 'mahjong', 'backgammon', 'go', 'tricks', 'deck'],
    sports: ['sport', 'sports', 'golf', 'bowling', 'pool', 'billiards', 'darts', 'soccer', 'football', 'basketball', 'tennis', 'baseball', 'hockey', 'physics', 'ball', 'skate', 'ski'],
    sims: ['sim', 'simulation', 'idle', 'incremental', 'clicker', 'tycoon', 'economy', 'business', 'farm', 'trading', 'management', 'city', 'pet'],
    story: ['story', 'text adventure', 'interactive fiction', 'adventure', 'visual novel', 'mystery', 'escape room', 'narrative'],
    party: ['party', 'group', 'charades', 'trivia', 'road trip', 'icebreaker', 'drinking', 'pass and play', 'family'],
    learn: ['learning', 'learn', 'education', 'educational', 'training', 'quiz', 'geography', 'math', 'flashcards', 'typing', 'language'],
    toys: ['toy', 'sandbox', 'relax', 'zen', 'fidget', 'music', 'drawing', 'kaleidoscope'],
    tools: ['score keeper', 'scorekeeper', 'scoreboard', 'tally', 'chess clock', 'game clock', 'game controller', 'dice roller']
  };
  // Broad tags count half: "game,puzzle,word" is a word game, "arcade,physics,golf" sport.
  var WEAK = { puzzle: 1, arcade: 1, physics: 1, retro: 1, endless: 1, space: 1, ball: 1, logic: 1 };
  // Tags that make a widget a game at all (or an override entry does).
  var GAME_TOKENS = ['game', 'games', 'toy', 'minigame', 'mini game'];
  var CPU_TOKENS = ['cpu', 'vs cpu', 'ai', 'computer', 'bot', 'bots', 'single player'];
  var DUO_TOKENS = ['2 player', '2 players', 'two player', 'two players', '2p', 'multiplayer', 'pass and play', 'hot seat', 'versus'];

  function tokens(tags) {
    var out = [], parts = String(tags || '').toLowerCase().split(',');
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].replace(/\s+/g, ' ').trim();
      if (t && out.indexOf(t) === -1) out.push(t);
    }
    return out;
  }
  function hasAny(toks, list) {
    for (var i = 0; i < list.length; i++) if (toks.indexOf(list[i]) !== -1) return true;
    return false;
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

  // The category of a widget row (and whether it belongs in the Arcade at all).
  // → { cat, game } ; cat is null when the row isn't a game or game tool.
  function classify(row, id) {
    var toks = tokens(row && row.tags), nm = norm(row && row.name);
    var ov = (id && OVERRIDE.hasOwnProperty(id) ? OVERRIDE[id] : null) || (OVERRIDE.hasOwnProperty(nm) ? OVERRIDE[nm] : null);
    if (ov) return { cat: ov, game: ov !== 'tools' };
    var isGame = hasAny(toks, GAME_TOKENS);
    if (hasAny(toks, HINTS.tools) && !hasAny(toks, ['puzzle', 'arcade'])) return isGame || hasAny(toks, ['score', 'scores', 'board game', 'card game']) ? { cat: 'tools', game: false } : { cat: null, game: false };
    if (!isGame) return { cat: null, game: false };
    var best = null, bestW = 0;
    for (var c = 0; c < CATS.length; c++) {
      var id2 = CATS[c].id;
      if (id2 === 'tools') continue;
      var w = 0, list = HINTS[id2];
      for (var k = 0; k < list.length; k++) if (toks.indexOf(list[k]) !== -1) w += WEAK[list[k]] ? 0.5 : 1;
      // a category word in the name counts too ("Word Rush", "Puzzle Box")
      if (id2 === 'word' && /\bwords?\b/.test(nm)) w += 1;
      if (id2 === 'puzzle' && /\bpuzzles?\b/.test(nm)) w += 1;
      if (w > bestW) { bestW = w; best = id2; }
    }
    if (!best) best = toks.indexOf('toy') !== -1 && toks.indexOf('game') === -1 ? 'toys' : 'action';
    return { cat: best, game: true };
  }

  function badgesOf(toks) {
    var b = [];
    if (hasAny(toks, CPU_TOKENS)) b.push('cpu');
    if (hasAny(toks, DUO_TOKENS)) b.push('2p');
    if (toks.indexOf('daily') !== -1) b.push('daily');
    return b;
  }

  // Commands() rows (+ an optional name → manifest id map) → the catalogue:
  // [{ name, desc, icon, tags, toks, id, cat, game, badges }] sorted by name.
  function buildCatalog(rows, idByName, selfName) {
    var out = [], seen = {}, self = norm(selfName || SELF);
    rows = Array.isArray(rows) ? rows : [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || typeof r.name !== 'string' || !r.name.trim()) continue;
      if (r.kind && r.kind !== 'widget') continue;
      var k = norm(r.name);
      if (k === self || seen[k]) continue;
      var id = idByName && idByName[k] ? String(idByName[k]) : '';
      var cl = classify(r, id);
      if (!cl.cat) continue;
      seen[k] = 1;
      var toks = tokens(r.tags);
      out.push({
        name: r.name, desc: String(r.description || ''), icon: String(r.icon || ''), tags: String(r.tags || ''),
        toks: toks, id: id, cat: cl.cat, game: cl.game, badges: badgesOf(toks)
      });
    }
    out.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0; });
    return out;
  }
  // manifest.json → { lower-case name: id } for widgets.
  function idMapFromManifest(m) {
    var map = {};
    var mods = m && Array.isArray(m.modules) ? m.modules : [];
    for (var i = 0; i < mods.length; i++) {
      var x = mods[i];
      if (x && x.type === 'widget' && typeof x.name === 'string' && typeof x.id === 'string') map[norm(x.name)] = x.id;
    }
    return map;
  }

  function counts(cat, st) {
    var c = { all: 0, fav: 0, recent: 0, duo: 0 };
    for (var i = 0; i < CATS.length; i++) c[CATS[i].id] = 0;
    for (var j = 0; j < cat.length; j++) {
      var e = cat[j];
      c[e.cat]++;
      if (e.game) c.all++;
      if (st && st.favs.indexOf(e.name) !== -1) c.fav++;
      if (e.badges.indexOf('2p') !== -1) c.duo++;
    }
    c.recent = st ? recentList(cat, st).length : 0;
    return c;
  }

  // Search: every query word must hit the name, tags, description or category.
  // Ranked: name exact > prefix > word start > inside > tag > category > description.
  function scoreEntry(e, words) {
    var nm = e.name.toLowerCase(), desc = e.desc.toLowerCase(), cl = (CAT[e.cat] || {}).label || '';
    cl = cl.toLowerCase();
    var total = 0;
    for (var i = 0; i < words.length; i++) {
      var w = words[i], s = 0;
      if (nm === w) s = 100;
      else if (nm.indexOf(w) === 0) s = 60;
      else if (new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(nm)) s = 42;
      else if (nm.indexOf(w) !== -1) s = 30;
      else if (e.toks.indexOf(w) !== -1) s = 22;
      else {
        for (var t = 0; t < e.toks.length && !s; t++) if (e.toks[t].indexOf(w) !== -1) s = 12;
        if (!s && cl.indexOf(w) !== -1) s = 10;
        if (!s && (w === '2p' || w === 'cpu' || w === 'daily') && e.badges.indexOf(w) !== -1) s = 14;
        if (!s && desc.indexOf(w) !== -1) s = 6;
      }
      if (!s) return 0;
      total += s;
    }
    return total;
  }
  function subseq(q, s) {
    var j = 0;
    for (var i = 0; i < s.length && j < q.length; i++) if (s.charAt(i) === q.charAt(j)) j++;
    return j === q.length;
  }
  function search(cat, query, st) {
    var q = norm(query);
    if (!q) return cat.slice();
    var words = q.split(' '), hits = [];
    for (var i = 0; i < cat.length; i++) {
      var s = scoreEntry(cat[i], words);
      if (s) hits.push({ e: cat[i], s: s + (st && st.favs.indexOf(cat[i].name) !== -1 ? 1 : 0) });
    }
    if (!hits.length) {
      // typo-tolerant fallback: the letters in order in the name ("pnbl" → Pinball)
      var qq = q.replace(/ /g, '');
      for (var j = 0; j < cat.length; j++) if (qq.length >= 2 && subseq(qq, cat[j].name.toLowerCase().replace(/[^a-z0-9]/g, ''))) hits.push({ e: cat[j], s: 1 });
    }
    hits.sort(function (a, b) { return b.s - a.s || (a.e.name < b.e.name ? -1 : 1); });
    return hits.map(function (h) { return h.e; });
  }

  // Recently played entries still in the catalogue, newest first.
  function recentList(cat, st) {
    var by = {}, out = [];
    for (var i = 0; i < cat.length; i++) by[cat[i].name] = cat[i];
    for (var j = 0; j < st.recent.length; j++) if (by[st.recent[j].n]) out.push(by[st.recent[j].n]);
    return out;
  }
  // What the grid shows for a filter: 'all' | 'fav' | 'recent' | 'duo' | a category id.
  function filterList(cat, filter, st) {
    if (filter === 'recent') return recentList(cat, st);
    var out = [];
    for (var i = 0; i < cat.length; i++) {
      var e = cat[i];
      if (filter === 'all' ? e.game
        : filter === 'fav' ? st.favs.indexOf(e.name) !== -1
          : filter === 'duo' ? e.badges.indexOf('2p') !== -1
            : e.cat === filter) out.push(e);
    }
    return out;
  }
  // The "All" view: sections in display order (favourites first, tools last).
  function sections(cat, st) {
    var out = [], favs = filterList(cat, 'fav', st);
    if (favs.length) out.push({ id: 'fav', label: 'Favourites', glyph: '*', items: favs });
    for (var i = 0; i < CATS.length; i++) {
      var items = filterList(cat, CATS[i].id, st);
      if (items.length) out.push({ id: CATS[i].id, label: CATS[i].label, glyph: CATS[i].glyph, items: items });
    }
    return out;
  }

  // ---- state ----
  function newState() {
    return { favs: [], recent: [], plays: {}, view: 'grid', after: 'minimize', filter: 'all', sound: false, launches: 0 };
  }
  function normState(raw) {
    var s = newState();
    if (!raw || typeof raw !== 'object') return s;
    if (Array.isArray(raw.favs)) {
      for (var i = 0; i < raw.favs.length && s.favs.length < MAX_FAVS; i++) {
        var f = raw.favs[i];
        if (typeof f === 'string' && f.trim() && s.favs.indexOf(f) === -1) s.favs.push(f);
      }
    }
    if (Array.isArray(raw.recent)) {
      var seen = {};
      for (var j = 0; j < raw.recent.length && s.recent.length < MAX_RECENT; j++) {
        var r = raw.recent[j];
        if (!r || typeof r.n !== 'string' || !r.n.trim() || seen[r.n]) continue;
        var t = +r.t;
        seen[r.n] = 1;
        s.recent.push({ n: r.n, t: isFinite(t) && t > 0 ? Math.floor(t) : 0 });
      }
    }
    if (raw.plays && typeof raw.plays === 'object' && !Array.isArray(raw.plays)) {
      var ks = Object.keys(raw.plays), n = 0;
      for (var k = 0; k < ks.length && n < 2000; k++) {
        var v = Math.floor(+raw.plays[ks[k]]);
        if (ks[k] && isFinite(v) && v > 0) { s.plays[ks[k]] = Math.min(MAX_PLAYS, v); n++; }
      }
    }
    if (raw.view === 'list') s.view = 'list';
    if (raw.after === 'keep' || raw.after === 'close') s.after = raw.after;
    if (typeof raw.filter === 'string' && (raw.filter === 'all' || raw.filter === 'fav' || raw.filter === 'recent' || raw.filter === 'duo' || CAT[raw.filter])) s.filter = raw.filter;
    s.sound = raw.sound === true;
    var l = Math.floor(+raw.launches);
    s.launches = isFinite(l) && l > 0 ? Math.min(MAX_PLAYS, l) : 0;
    return s;
  }
  function toggleFav(st, name) {
    var i = st.favs.indexOf(name);
    if (i === -1) { if (st.favs.length < MAX_FAVS) st.favs.push(name); return true; }
    st.favs.splice(i, 1);
    return false;
  }
  function recordLaunch(st, name, now) {
    for (var i = st.recent.length - 1; i >= 0; i--) if (st.recent[i].n === name) st.recent.splice(i, 1);
    st.recent.unshift({ n: name, t: Math.floor(now || 0) });
    if (st.recent.length > MAX_RECENT) st.recent.length = MAX_RECENT;
    st.plays[name] = Math.min(MAX_PLAYS, (st.plays[name] || 0) + 1);
    st.launches = Math.min(MAX_PLAYS, st.launches + 1);
    return st.plays[name];
  }
  function mostPlayed(cat, st) {
    var best = null, n = 0;
    for (var i = 0; i < cat.length; i++) {
      var p = st.plays[cat[i].name] || 0;
      if (p > n) { n = p; best = cat[i]; }
    }
    return best ? { e: best, n: n } : null;
  }

  // Random pick from a list: prefers games not played lately; never the same
  // as `avoid` when there is another choice. rnd() → [0,1).
  function pickRandom(list, st, rnd, avoid) {
    if (!list || !list.length) return null;
    rnd = rnd || Math.random;
    var pool = list.filter(function (e) { return e.name !== avoid; });
    if (!pool.length) pool = list.slice();
    var recentNames = {};
    if (st) for (var i = 0; i < Math.min(3, st.recent.length); i++) recentNames[st.recent[i].n] = 1;
    var fresh = pool.filter(function (e) { return !recentNames[e.name]; });
    if (fresh.length) pool = fresh;
    return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))];
  }
  // The roulette's path: `steps` indexes into a list of n, ending on `target`.
  // Consecutive stops always differ when n > 1. Delays slow down towards the end.
  function roulettePath(n, target, steps, rnd) {
    rnd = rnd || Math.random;
    if (n <= 0 || steps <= 0) return [];
    var path = new Array(steps);
    path[steps - 1] = target;
    // built backwards from the target, so no two neighbouring stops are the same card
    for (var i = steps - 2; i >= 0; i--) {
      var k = Math.floor(rnd() * n) % n;
      if (n > 1 && k === path[i + 1]) k = (k + 1 + Math.floor(rnd() * (n - 1))) % n;
      path[i] = k;
    }
    return path;
  }
  function rouletteDelay(i, steps) { var p = steps > 1 ? i / (steps - 1) : 1; return Math.round(55 + 260 * p * p); }

  // Keyboard navigation in a grid of n items with `cols` columns.
  function gridMove(i, key, cols, n) {
    if (n <= 0) return -1;
    cols = Math.max(1, cols | 0);
    if (i < 0 || i >= n) return 0;
    switch (key) {
      case 'ArrowRight': return Math.min(n - 1, i + 1);
      case 'ArrowLeft': return Math.max(0, i - 1);
      case 'ArrowDown': return i + cols < n ? i + cols : (Math.floor(i / cols) < Math.floor((n - 1) / cols) ? n - 1 : i);
      case 'ArrowUp': return i - cols >= 0 ? i - cols : -1;   // -1: off the top (back to the search box)
      case 'Home': return 0;
      case 'End': return n - 1;
      case 'PageDown': return Math.min(n - 1, i + cols * 3);
      case 'PageUp': return Math.max(0, i - cols * 3);
    }
    return i;
  }

  // "3m", "2h", "5d", "3w" — compact time since a launch.
  function ago(t, now) {
    if (!t) return '';
    var s = Math.max(0, (now - t) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 86400 * 14) return Math.floor(s / 86400) + 'd';
    if (s < 86400 * 7 * 52) return Math.floor(s / (86400 * 7)) + 'w';
    return Math.floor(s / (86400 * 365)) + 'y';
  }

  // ---- the marquee ----
  var BANNER = [
    '    _     ____    ____     _     ____   _____ ',
    '   / \\   |  _ \\  / ___|   / \\   |  _ \\ | ____|',
    '  / _ \\  | |_) || |      / _ \\  | | | ||  _|  ',
    ' / ___ \\ |  _ < | |___  / ___ \\ | |_| || |___ ',
    '/_/   \\_\\|_| \\_\\ \\____|/_/   \\_\\|____/ |_____|'
  ];
  function pad3(n) { n = Math.max(0, Math.floor(n)); return n > 999 ? String(n) : ('00' + n).slice(-3); }
  // The ticker's message (one loop).
  function tickerText(cat, st, now) {
    var games = 0;
    for (var i = 0; i < cat.length; i++) if (cat[i].game) games++;
    var parts = ['INSERT COIN', games + ' GAMES ON THIS CABINET'];
    var rec = st.recent.length ? st.recent[0] : null;
    if (rec) {
      var a = rec.t && now ? ago(rec.t, now) : '';
      parts.push('LAST PLAYED: ' + rec.n.toUpperCase() + (a ? (a === 'now' ? ' (JUST NOW)' : ' (' + a.toUpperCase() + ' AGO)') : ''));
    }
    var mp = mostPlayed(cat, st);
    if (mp && mp.n > 1) parts.push('HI-SCORE: ' + mp.e.name.toUpperCase() + ' x' + mp.n);
    var unplayed = cat.filter(function (e) { return e.game && !st.plays[e.name]; });
    if (unplayed.length && cat.length) {
      var day = Math.floor((now || 0) / 864e5);
      parts.push('NEVER PLAYED: ' + unplayed[day % unplayed.length].name.toUpperCase() + '?');
      parts.push(unplayed.length + ' LEFT TO DISCOVER');
    } else if (games) parts.push('YOU HAVE PLAYED THEM ALL!');
    parts.push('PRESS ? FOR HELP');
    return parts.join('  *  ') + '  *  ';
  }
  // A width-wide window into an endlessly repeating text, `off` characters in.
  function tickerSlice(text, off, width) {
    if (!text) return new Array(width + 1).join(' ');
    var L = text.length, o = ((Math.floor(off) % L) + L) % L, out = '';
    while (out.length < width + o) out += text;
    return out.slice(o, o + width);
  }
  // Chaser lights: a lit bulb every `gap` cells, moving one cell per phase.
  function lightsRow(width, phase, gap) {
    gap = gap || 3;
    var s = [];
    for (var i = 0; i < width; i++) s.push(((i + phase) % gap + gap) % gap === 0 ? 'o' : '.');
    return s.join('');
  }

  var ENGINE = {
    SELF: SELF, CATS: CATS, CAT: CAT, OVERRIDE: OVERRIDE, HINTS: HINTS, BANNER: BANNER, MAX_RECENT: MAX_RECENT,
    tokens: tokens, classify: classify, badgesOf: badgesOf, buildCatalog: buildCatalog, idMapFromManifest: idMapFromManifest,
    counts: counts, search: search, scoreEntry: scoreEntry, filterList: filterList, sections: sections, recentList: recentList,
    newState: newState, normState: normState, toggleFav: toggleFav, recordLaunch: recordLaunch, mostPlayed: mostPlayed,
    pickRandom: pickRandom, roulettePath: roulettePath, rouletteDelay: rouletteDelay, gridMove: gridMove, ago: ago,
    tickerText: tickerText, tickerSlice: tickerSlice, lightsRow: lightsRow, pad3: pad3
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('arcade.css');

  var PANEL_ID = 'arcade-panel';
  var STATE_KEY = 'cade-arcade-state';
  var TICK_W = 44, LIGHT_W = 46;
  var S = null;   // the live session (one panel at a time)
  var manifestIds = null, manifestReq = null;   // name → id, fetched once per page

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function loadState() {
    var raw = null;
    try { raw = JSON.parse(sget(STATE_KEY) || 'null'); } catch (e) { raw = null; }
    return normState(raw);
  }
  function persist() { if (S) sset(STATE_KEY, JSON.stringify(S.st)); }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function attr(s) { return esc(s).replace(/"/g, '&quot;'); }

  // ---- sound: a tiny WebAudio voice, created on a user gesture (iOS), closed with the panel ----
  function Snd(on) { this.on = !!on; this.ac = null; }
  Snd.prototype.ensure = function () {
    if (!this.on) return;
    if (!this.ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ac = new AC(); } catch (e) { this.ac = null; return; }
    }
    if (this.ac.state === 'suspended') { try { this.ac.resume(); } catch (e) {} }
  };
  Snd.prototype.tone = function (f, dur, type, vol, slide, delay) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      var t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.coin = function () { this.tone(988, 0.07, 'square', 0.03); this.tone(1319, 0.22, 'square', 0.03, 0, 0.07); };
  Snd.prototype.tick = function (i) { this.tone(520 + (i % 5) * 60, 0.03, 'square', 0.018); };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6"/><path d="M12 17h.01"/>');
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/>');
  var IC_GEAR = svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>');
  var IC_GRID = svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>');
  var IC_LIST = svg('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="3"/>');
  var IC_DICE = svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 8.5h.01M15.5 15.5h.01M12 12h.01M15.5 8.5h.01M8.5 15.5h.01" stroke-width="3"/>');
  var IC_SEARCH = svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>');

  function iconHtml(icon) {
    var s = String(icon || '').trim();
    if (!s) return '<span class="ac-ico-txt">#</span>';
    if (/^<svg[\s>]/i.test(s)) return s;   // the palette renders these inline too (trusted module metadata)
    return '<span class="ac-ico-txt">' + esc(s) + '</span>';
  }

  // ---- discovery ----
  function rows() {
    try { return (Cade.commands && Cade.commands()) || []; } catch (e) { return []; }
  }
  function loadManifestIds() {
    if (manifestIds || manifestReq || typeof fetch !== 'function') return;
    manifestReq = fetch('txt/manifest.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
      manifestIds = idMapFromManifest(m);
      if (S) { rebuild(); render(); }
    }, function () { manifestIds = {}; });
  }
  function rebuild() {
    if (!S) return;
    S.cat = buildCatalog(rows(), manifestIds || {}, SELF);
    S.byName = {};
    for (var i = 0; i < S.cat.length; i++) S.byName[S.cat[i].name] = S.cat[i];
    S.ticker = tickerText(S.cat, S.st, Date.now());
  }

  // ---- rendering ----
  function badgeHtml(e) {
    var h = '';
    for (var i = 0; i < e.badges.length; i++) {
      var b = e.badges[i];
      h += '<span class="ac-bdg ac-bdg-' + b + '" title="' + (b === 'cpu' ? 'Play against the computer' : b === '2p' ? 'Two players on one device' : 'A new puzzle every day') + '">' +
        (b === 'cpu' ? 'CPU' : b === '2p' ? '2P' : 'DAILY') + '</span>';
    }
    return h;
  }
  function cardHtml(e, idx) {
    var fav = S.st.favs.indexOf(e.name) !== -1, n = S.st.plays[e.name] || 0;
    var c = CAT[e.cat] || CAT.action;
    var meta = '';
    if (S.st.view === 'list') meta = '<span class="ac-cat">' + esc(c.chip) + '</span>';
    var plays = n ? '<span class="ac-plays" title="Launched ' + n + ' time' + (n === 1 ? '' : 's') + ' from the Arcade">x' + n + '</span>' : '<span class="ac-new" title="Not played from the Arcade yet">NEW</span>';
    return '<div class="ac-card' + (fav ? ' fav' : '') + (e.cat === 'tools' ? ' tool' : '') + '" role="listitem" data-i="' + idx + '">' +
      '<button type="button" class="ac-play" data-name="' + attr(e.name) + '" tabindex="-1" title="' + attr(e.name + (e.desc ? ' — ' + e.desc : '')) + '">' +
      '<span class="ac-ico" aria-hidden="true">' + iconHtml(e.icon) + '</span>' +
      '<span class="ac-txt"><span class="ac-name">' + esc(e.name) + '</span>' +
      '<span class="ac-desc">' + esc(e.desc || c.label) + '</span></span>' +
      '<span class="ac-meta">' + meta + badgeHtml(e) + plays + '</span>' +
      '</button>' +
      '<button type="button" class="ac-star' + (fav ? ' on' : '') + '" data-fav="' + attr(e.name) + '" tabindex="-1" aria-pressed="' + fav + '" title="' + (fav ? 'Remove from favourites' : 'Add to favourites') + '" aria-label="' + attr((fav ? 'Unfavourite ' : 'Favourite ') + e.name) + '">' + (fav ? '*' : '+') + '</button>' +
      '</div>';
  }
  function secHtml(id, glyph, label, items, start) {
    var h = '<section class="ac-sec" data-sec="' + id + '"><div class="ac-h"><span class="ac-hg">' + esc(glyph) + '</span> ' + esc(label.toUpperCase()) +
      ' <span class="ac-hn">' + items.length + '</span><span class="ac-rule" aria-hidden="true"></span></div><div class="ac-grid" role="list">';
    for (var i = 0; i < items.length; i++) h += cardHtml(items[i], start + i);
    return h + '</div></section>';
  }
  function recentStrip() {
    var list = recentList(S.cat, S.st).slice(0, 8);
    if (!list.length) return '';
    var now = Date.now(), h = '<div class="ac-recent"><span class="ac-rl">RECENT</span>';
    for (var i = 0; i < list.length; i++) {
      var r = S.st.recent.filter(function (x) { return x.n === list[i].name; })[0];
      h += '<button type="button" class="ac-rc" data-name="' + attr(list[i].name) + '" title="Play ' + attr(list[i].name) + '"><span class="ac-ico" aria-hidden="true">' +
        iconHtml(list[i].icon) + '</span><span class="ac-rn">' + esc(list[i].name) + '</span><i>' + esc(ago(r && r.t, now)) + '</i></button>';
    }
    return h + '</div>';
  }
  function chipsHtml() {
    var c = counts(S.cat, S.st), f = S.st.filter;
    var list = [{ id: 'all', label: 'All', n: c.all }, { id: 'fav', label: '* Favs', n: c.fav }, { id: 'recent', label: 'Recent', n: c.recent }];
    for (var i = 0; i < CATS.length; i++) if (c[CATS[i].id]) list.push({ id: CATS[i].id, label: CATS[i].chip, n: c[CATS[i].id] });
    if (c.duo) list.push({ id: 'duo', label: '2 players', n: c.duo });
    var h = '';
    for (var j = 0; j < list.length; j++) {
      var x = list[j];
      h += '<button type="button" class="ac-chip' + (f === x.id ? ' on' : '') + '" data-f="' + x.id + '" aria-pressed="' + (f === x.id) + '">' + esc(x.label) + ' <i>' + x.n + '</i></button>';
    }
    return h;
  }
  // Rebuilds the list area for the current filter / search. Keeps the focused card.
  function render(keepFocusName) {
    if (!S) return;
    var q = S.search.value, st = S.st, h = '', list = [];
    S.chips.innerHTML = chipsHtml();
    S.root.classList.toggle('list', st.view === 'list');
    if (q.trim()) {
      list = search(S.cat, q, st);
      if (st.filter !== 'all') {
        var allowed = filterList(S.cat, st.filter, st), ok = {};
        for (var a = 0; a < allowed.length; a++) ok[allowed[a].name] = 1;
        list = list.filter(function (e) { return ok[e.name]; });
      }
      h = list.length ? secHtml('search', '?', 'Results for "' + q.trim() + '"', list, 0) : '';
    } else if (st.filter === 'all') {
      h = recentStrip();
      var secs = sections(S.cat, st), i0 = 0;
      for (var s = 0; s < secs.length; s++) { h += secHtml(secs[s].id, secs[s].glyph, secs[s].label, secs[s].items, i0); i0 += secs[s].items.length; list = list.concat(secs[s].items); }
    } else {
      list = filterList(S.cat, st.filter, st);
      var lab = st.filter === 'fav' ? ['*', 'Favourites'] : st.filter === 'recent' ? ['<<', 'Recently played'] : st.filter === 'duo' ? ['1v1', 'Two players'] : [CAT[st.filter].glyph, CAT[st.filter].label];
      h = list.length ? secHtml(st.filter, lab[0], lab[1], list, 0) : '';
    }
    if (!list.length) h += emptyHtml(q);
    S.list.innerHTML = h;
    S.shown = list;
    S.cards = Array.prototype.slice.call(S.list.querySelectorAll('.ac-card'));
    var fi = 0;
    if (keepFocusName) for (var k = 0; k < list.length; k++) if (list[k].name === keepFocusName) { fi = k; break; }
    setRoving(fi, false);
    var games = 0;
    for (var g = 0; g < S.cat.length; g++) if (S.cat[g].game) games++;
    S.stat.textContent = (q.trim() ? list.length + ' match' + (list.length === 1 ? '' : 'es') + ' · ' : '') + games + ' games · ' + st.favs.length + ' fav' + (st.favs.length === 1 ? '' : 's') + ' · ' + st.launches + ' launch' + (st.launches === 1 ? '' : 'es');
    S.rand.disabled = !list.length;
    syncHead();
  }
  function emptyHtml(q) {
    var f = S.st.filter, msg;
    if (q.trim()) msg = '<p>No game matches <b>"' + esc(q.trim()) + '"</b>' + (f !== 'all' ? ' in this tab' : '') + '.</p>' + (f !== 'all' ? '<button type="button" class="ac-go alt" data-act="all">Search all games</button>' : '<button type="button" class="ac-go alt" data-act="clear">Clear search</button>');
    else if (f === 'fav') msg = '<p>No favourites yet.</p><p class="ac-note">Tap the <b>+</b> on any game card to star it.</p>';
    else if (f === 'recent') msg = '<p>Nothing played yet.</p><p class="ac-note">Games you launch from the Arcade show up here.</p>';
    else msg = '<p>No games found.</p>';
    return '<div class="ac-empty"><pre class="ac-art" aria-hidden="true"> .-------.\n | GAME  |\n |  OVER |\n \'-------\'</pre>' + msg + '</div>';
  }
  function setRoving(i, focus) {
    if (!S || !S.cards.length) { if (S) S.focusI = -1; return; }
    i = Math.max(0, Math.min(S.cards.length - 1, i));
    for (var k = 0; k < S.cards.length; k++) {
      var b = S.cards[k].querySelector('.ac-play');
      b.tabIndex = k === i ? 0 : -1;
    }
    S.focusI = i;
    if (focus) {
      var pb = S.cards[i].querySelector('.ac-play');
      try { pb.focus({ preventScroll: true }); } catch (e) { pb.focus(); }
      scrollCard(S.cards[i]);
    }
  }
  function scrollCard(card) {
    if (!card || !S) return;
    var sc = S.list, r = card.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    if (r.top < sr.top + 4) sc.scrollTop -= sr.top + 4 - r.top + 22;
    else if (r.bottom > sr.bottom - 4) sc.scrollTop += r.bottom - sr.bottom + 8;
  }
  function columns() {
    if (!S || S.cards.length < 2) return 1;
    var i = Math.max(0, S.focusI), grid = S.cards[i].parentNode, cols = 0;
    var kids = grid.children;
    for (var k = 0; k < kids.length; k++) if (kids[k].offsetTop === kids[0].offsetTop) cols++;
    return Math.max(1, cols || 1);
  }
  function syncHead() {
    if (!S) return;
    var sb = S.head.querySelector('[data-h="sound"]');
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.classList.toggle('on', S.snd.on);
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', String(S.snd.on));
    S.viewBtn.innerHTML = S.st.view === 'list' ? IC_GRID : IC_LIST;
    S.viewBtn.title = S.st.view === 'list' ? 'Grid view (V)' : 'Compact list (V)';
    S.viewBtn.setAttribute('aria-label', S.viewBtn.title);
  }

  // ---- the marquee (lights + ticker), ticking only while visible ----
  function drawMarquee() {
    if (!S) return;
    var lit = lightsRow(LIGHT_W, S.phase, 3).replace(/o/g, '<b>o</b>');
    S.lt1.innerHTML = lit;
    S.lt2.innerHTML = lightsRow(LIGHT_W, -S.phase, 3).replace(/o/g, '<b>o</b>');
    S.tick.textContent = tickerSlice(S.ticker, S.tOff, TICK_W);
  }
  function startMarquee() {
    if (!S || S.mqT || S.rm) return;
    S.mqT = setInterval(function () {
      if (!S) return;
      if (document.hidden || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
      S.tOff++;
      if (S.tOff % 3 === 0) S.phase++;
      drawMarquee();
    }, 140);
  }
  function stopMarquee() { if (S && S.mqT) { clearInterval(S.mqT); S.mqT = 0; } }

  // ---- overlay cards: help / settings ----
  function showCard(kind) {
    if (!S) return;
    S.cardKind = kind;
    if (!kind) { S.ovl.style.display = 'none'; S.ovl.innerHTML = ''; S.root.classList.remove('dim'); return; }
    var h = '';
    if (kind === 'help') {
      h = '<div class="ac-card-o" role="dialog" aria-label="How the Arcade works"><div class="ac-title">HOW IT WORKS</div>' +
        '<p>Every game in Cade.txt, in one cabinet. Tap a card to play — new games show up here on their own.</p>' +
        '<div class="ac-keys"><span><b>Tap / Enter</b> launch a game</span><span><b>+ / *</b> star a favourite (or press <b>F</b>)</span>' +
        '<span><b>Type</b> or <b>/</b> to search — try <i>cards</i>, <i>2p</i>, <i>cpu</i>, <i>daily</i></span>' +
        '<span><b>Arrows</b> move between cards · <b>Esc</b> clears the search</span>' +
        '<span><b>R</b> or the dice: a random game from what is shown</span><span><b>V</b> grid / compact list</span></div>' +
        '<p class="ac-note"><b>CPU</b> = play the computer · <b>2P</b> = pass-and-play on one device · <b>NEW</b> = not launched from here yet.</p>' +
        '<button type="button" class="ac-go" data-act="close">Back to the games</button></div>';
    } else if (kind === 'settings') {
      var a = S.st.after;
      h = '<div class="ac-card-o" role="dialog" aria-label="Arcade settings"><div class="ac-title">SETTINGS</div>' +
        '<div class="ac-h2">After launching a game</div><div class="ac-seg" role="radiogroup">' +
        ['keep:Keep open', 'minimize:Minimize', 'close:Close'].map(function (x) {
          var p = x.split(':');
          return '<button type="button" role="radio" data-after="' + p[0] + '" aria-checked="' + (a === p[0]) + '" class="' + (a === p[0] ? 'on' : '') + '">' + p[1] + '</button>';
        }).join('') + '</div>' +
        '<p class="ac-note">Minimize tucks the Arcade into the dock — tap its chip to come back.</p>' +
        '<div class="ac-h2">Records</div>' +
        '<pre class="ac-tab">' + recordsTable() + '</pre>' +
        (S.resetArm ? '<div class="ac-confirm">Clear recents, play counts and favourites? <button type="button" class="ac-lnk danger" data-act="reset-yes">Yes, clear</button> <button type="button" class="ac-lnk" data-act="reset-no">No</button></div>'
          : '<div class="ac-foot"><button type="button" class="ac-lnk" data-act="clear-recent">Clear recently played</button><button type="button" class="ac-lnk" data-act="reset">Reset everything…</button></div>') +
        '<button type="button" class="ac-go" data-act="close">Done</button></div>';
    }
    S.ovl.innerHTML = h;
    S.ovl.style.display = '';
    S.root.classList.add('dim');
    var first = S.ovl.querySelector('.ac-go');
    if (first) { try { first.focus({ preventScroll: true }); } catch (e) {} }
  }
  function recordsTable() {
    var mp = mostPlayed(S.cat, S.st), games = 0, played = 0;
    for (var i = 0; i < S.cat.length; i++) if (S.cat[i].game) { games++; if (S.st.plays[S.cat[i].name]) played++; }
    var top = S.cat.filter(function (e) { return S.st.plays[e.name]; }).sort(function (a, b) { return S.st.plays[b.name] - S.st.plays[a.name]; }).slice(0, 3);
    var out = 'launches     <b>' + pad3(S.st.launches) + '</b>\n' +
      'discovered   <b>' + played + '</b><i>/' + games + '</i>\n' +
      'favourites   <b>' + S.st.favs.length + '</b>';
    if (mp) {
      out += '\n\n<i>-- most played --</i>';
      for (var t = 0; t < top.length; t++) {
        var nm = top[t].name.length > 18 ? top[t].name.slice(0, 17) + '…' : top[t].name;
        out += '\n' + (t + 1) + '. ' + esc(nm) + new Array(Math.max(1, 21 - nm.length)).join(' ') + '<b>x' + S.st.plays[top[t].name] + '</b>';
      }
    }
    return out;
  }

  // ---- launching ----
  function panelOf(name) {
    var list = document.querySelectorAll('.cade-panel');
    for (var i = 0; i < list.length; i++) if (list[i].__cadeWidget === name && list[i].id !== PANEL_ID) return list[i];
    return null;
  }
  function launch(name) {
    if (!S || !name) return;
    var e = S.byName[name];
    S.snd.ensure(); S.snd.coin();
    if (Cade.haptic) Cade.haptic(8);
    // Solo page (txt.html?widget=arcade): the core hides every other panel, so a
    // game opened here would be invisible — open the game's own solo page instead.
    if (isSolo()) { soloLaunch(name, e); return; }
    var ex = panelOf(name), ok = true;
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) Cade.restorePanel(ex);
      ex.classList.remove('arcade-ping');
      void ex.offsetWidth;
      ex.classList.add('arcade-ping');
      setTimeout(function () { ex.classList.remove('arcade-ping'); }, 900);
    } else {
      try { ok = Cade.runCommand(name) !== false; } catch (er) { ok = false; }
    }
    if (!ok) { Cade.showToast && Cade.showToast('Could not start ' + name, 'error', 2200); return; }
    if (e && e.cat !== 'tools') recordLaunch(S.st, name, Date.now());
    else if (e) { for (var i = S.st.recent.length - 1; i >= 0; i--) if (S.st.recent[i].n === name) S.st.recent.splice(i, 1); }
    persist();
    S.ticker = tickerText(S.cat, S.st, Date.now());
    var after = S.st.after, p = S.panel;
    if (after === 'keep') { render(name); return; }
    render(name);
    // let the game's panel appear first (lazy modules load asynchronously)
    setTimeout(function () {
      if (!S || S.panel !== p || !p.isConnected) return;
      if (after === 'close') closePanel(true);
      else if (Cade.minimizePanel) Cade.minimizePanel(p);
    }, 60);
  }
  function isSolo() {
    try { return document.documentElement.classList.contains('cade-solo'); } catch (er) { return false; }
  }
  function soloLaunch(name, e) {
    function go() {
      if (!S) return;
      var id = (e && e.id) || (manifestIds && manifestIds[norm(name)]) || '';
      if (!id) { Cade.showToast && Cade.showToast('Could not start ' + name, 'error', 2200); return; }
      if (e && e.cat !== 'tools') recordLaunch(S.st, name, Date.now());
      persist();
      var u = new URL(location.href);
      u.searchParams.set('widget', id);
      location.assign(u.toString());
    }
    if (manifestIds || !manifestReq) go();
    else manifestReq.then(go, go);
  }
  function randomGame() {
    if (!S || S.roul) return;
    var list = S.shown.filter(function (e) { return e.cat !== 'tools'; });
    if (!list.length) list = S.shown.slice();
    if (!list.length) return;
    S.snd.ensure();
    var last = S.st.recent.length ? S.st.recent[0].n : '';
    var pick = pickRandom(list, S.st, Math.random, last);
    // the roulette runs over the cards on screen (the pick's index among them)
    var idxs = [], target = 0;
    for (var i = 0; i < S.shown.length; i++) {
      if (list.indexOf(S.shown[i]) !== -1) { if (S.shown[i] === pick) target = idxs.length; idxs.push(i); }
    }
    if (S.rm || idxs.length < 2) { finishRoulette(idxs[target], pick); return; }
    var steps = Math.min(14, 6 + idxs.length), path = roulettePath(idxs.length, target, steps, Math.random), k = 0;
    S.roul = { t: 0 };
    S.root.classList.add('rolling');
    (function step() {
      if (!S || !S.roul) return;
      var ci = idxs[path[k]];
      hiCard(ci);
      S.snd.tick(k);
      if (++k >= path.length) { S.roul.t = setTimeout(function () { finishRoulette(ci, pick); }, 260); return; }
      S.roul.t = setTimeout(step, rouletteDelay(k, steps));
    })();
  }
  function hiCard(i) {
    if (!S) return;
    for (var k = 0; k < S.cards.length; k++) S.cards[k].classList.toggle('hi', k === i);
    if (S.cards[i]) scrollCard(S.cards[i]);
  }
  function cancelRoulette() {
    if (!S || !S.roul) return;
    clearTimeout(S.roul.t); S.roul = null;
    S.root.classList.remove('rolling');
    hiCard(-1);
  }
  function finishRoulette(i, pick) {
    if (!S) return;
    hiCard(i);
    if (S.cards[i]) S.cards[i].classList.add('win');
    S.live.textContent = 'Random game: ' + pick.name;
    S.roul = { t: setTimeout(function () {
      if (!S) return;
      S.roul = null; S.root.classList.remove('rolling');
      launch(pick.name);
    }, S.rm ? 150 : 420) };
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    cancelRoulette();
    stopMarquee();
    document.removeEventListener('visibilitychange', S.onVis);
    S.snd.close();
    S = null;
  }
  function closePanel(fromLaunch) {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    if (!fromLaunch) { try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {} }
  }

  function open() {
    if (Cade.closeAllMenus) Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var mq = '<div class="ac-mq" aria-hidden="true"><div class="ac-lt"></div><pre class="ac-ban">' + esc(BANNER.join('\n')) + '</pre>' +
      '<div class="ac-tick"></div><div class="ac-lt"></div></div>';
    var body = '<div class="ac">' + mq +
      '<div class="ac-bar"><label class="ac-sw">' + IC_SEARCH + '<input type="search" class="ac-q" placeholder="Search games…" aria-label="Search games" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"></label>' +
      '<button type="button" class="ac-tb ac-rand" title="Random game (R)" aria-label="Random game">' + IC_DICE + '<span>Random</span></button>' +
      '<button type="button" class="ac-tb ac-view"></button></div>' +
      '<div class="ac-chips" role="toolbar" aria-label="Categories"></div>' +
      '<div class="ac-list"></div>' +
      '<div class="ac-stat"></div>' +
      '<div class="ac-ovl" style="display:none"></div><div class="ac-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🕹️ Arcade', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'ac-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How it works" aria-label="How it works">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="settings" title="Settings &amp; records" aria-label="Settings and records">' + IC_GEAR + '</button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var st = loadState(), mm = window.matchMedia;
    var lts = p.querySelectorAll('.ac-lt');
    S = {
      panel: p, head: hb, root: p.querySelector('.ac'), search: p.querySelector('.ac-q'), chips: p.querySelector('.ac-chips'),
      list: p.querySelector('.ac-list'), stat: p.querySelector('.ac-stat'), ovl: p.querySelector('.ac-ovl'), live: p.querySelector('.ac-live'),
      rand: p.querySelector('.ac-rand'), viewBtn: p.querySelector('.ac-view'), tick: p.querySelector('.ac-tick'), lt1: lts[0], lt2: lts[1],
      st: st, snd: new Snd(st.sound), rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches),
      cat: [], byName: {}, shown: [], cards: [], focusI: -1, ticker: '', tOff: 0, phase: 0, mqT: 0, roul: null, cardKind: null, resetArm: false
    };
    p._onClose = teardown;
    rebuild();
    loadManifestIds();
    render();
    drawMarquee();
    startMarquee();

    S.onVis = function () { if (S && !document.hidden) drawMarquee(); };
    document.addEventListener('visibilitychange', S.onVis);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) cancelRoulette(); });
    // coming back: games may have registered since — rediscover
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      var cur = S.cards[S.focusI] && S.cards[S.focusI].querySelector('.ac-play');
      rebuild(); render(cur && cur.getAttribute('data-name')); drawMarquee();
    });

    // Rapid tapping must never zoom, select, magnify or open a callout (CSS does
    // most of it); the panel swallows iOS gesture / dblclick events. Typing in
    // the search box is untouched.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    S.rand.addEventListener('touchend', function (e) { if (e.cancelable) { e.preventDefault(); randomGame(); } }, { passive: false });

    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on; S.st.sound = S.snd.on; persist();
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        syncHead();
      } else if (h === 'help' || h === 'settings') {
        cancelRoulette();
        S.resetArm = false;
        showCard(S.cardKind === h ? null : h);
      }
      try { b.blur(); } catch (er) {}
    });

    S.search.addEventListener('input', function () { if (!S) return; cancelRoulette(); render(); S.list.scrollTop = 0; });
    S.search.addEventListener('keydown', function (e) {
      if (!S) return;
      if (e.key === 'Escape') {
        if (S.search.value) { S.search.value = ''; render(); e.preventDefault(); e.stopPropagation(); }
        else S.search.blur();
      } else if (e.key === 'ArrowDown' && S.cards.length) { e.preventDefault(); setRoving(0, true); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (S.shown.length && S.search.value.trim()) launch(S.shown[0].name);
      }
    });
    S.rand.addEventListener('click', randomGame);
    S.viewBtn.addEventListener('click', function () {
      if (!S) return;
      var cur = S.cards[S.focusI] && S.cards[S.focusI].querySelector('.ac-play');
      S.st.view = S.st.view === 'list' ? 'grid' : 'list'; persist(); render(cur && cur.getAttribute('data-name'));
      S.snd.ensure(); S.snd.tone(660, 0.04, 'square', 0.02);
    });
    S.chips.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-f]') : null;
      if (!b || !S) return;
      cancelRoulette();
      var f = b.getAttribute('data-f');
      S.st.filter = f; persist(); render(); S.list.scrollTop = 0;
      var nb = S.chips.querySelector('[data-f="' + f + '"]');
      if (nb) { if (e.detail === 0) { try { nb.focus({ preventScroll: true }); } catch (er) {} } chipIntoView(nb); }
      S.snd.ensure(); S.snd.tone(740, 0.035, 'square', 0.018);
    });
    S.list.addEventListener('click', function (e) {
      if (!S) return;
      var t = e.target.closest ? e.target : null;
      if (!t) return;
      if (S.roul) { cancelRoulette(); return; }
      var fb = t.closest('[data-fav]');
      if (fb) {
        var nm = fb.getAttribute('data-fav'), on = toggleFav(S.st, nm);
        persist();
        S.snd.ensure(); on ? (S.snd.tone(1047, 0.06, 'square', 0.025), S.snd.tone(1568, 0.1, 'square', 0.02, 0, 0.06)) : S.snd.tone(440, 0.06, 'square', 0.02);
        if (Cade.haptic) Cade.haptic(6);
        var top = S.list.scrollTop;
        render(nm);
        S.list.scrollTop = top;
        var nb = S.list.querySelector('.ac-card [data-fav="' + cssEsc(nm) + '"]');
        if (nb) { nb.classList.add('pop'); if (e.detail === 0) { try { nb.focus({ preventScroll: true }); } catch (er) {} } }
        S.live.textContent = (on ? 'Added ' : 'Removed ') + nm + (on ? ' to' : ' from') + ' favourites';
        return;
      }
      var pb = t.closest('[data-name]');
      if (pb) launch(pb.getAttribute('data-name'));
      var act = t.closest('[data-act]');
      if (act) {
        var a = act.getAttribute('data-act');
        if (a === 'clear') { S.search.value = ''; render(); }
        else if (a === 'all') { S.st.filter = 'all'; persist(); render(); }
      }
    });
    S.list.addEventListener('focusin', function (e) {
      var c = e.target.closest ? e.target.closest('.ac-card') : null;
      if (c && S) { var i = S.cards.indexOf(c); if (i !== -1 && i !== S.focusI) setRoving(i, false); }
    });
    S.ovl.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var af = b.getAttribute('data-after'), a = b.getAttribute('data-act');
      if (af) { S.st.after = af; persist(); showCard('settings'); var nb = S.ovl.querySelector('[data-after="' + af + '"]'); if (nb && e.detail === 0) nb.focus(); }
      else if (a === 'close') showCard(null);
      else if (a === 'reset') { S.resetArm = true; showCard('settings'); }
      else if (a === 'reset-no') { S.resetArm = false; showCard('settings'); }
      else if (a === 'reset-yes') {
        var keep = S.st;
        S.st = newState(); S.st.sound = keep.sound; S.st.view = keep.view; S.st.after = keep.after;
        S.resetArm = false; persist(); rebuild(); render(); showCard('settings');
        Cade.showToast && Cade.showToast('Arcade records cleared', 'info', 1800);
      } else if (a === 'clear-recent') {
        S.st.recent = []; persist(); rebuild(); render(); showCard('settings');
        Cade.showToast && Cade.showToast('Recently played cleared', 'info', 1600);
      }
    });
    S.ovl.addEventListener('pointerdown', function (e) { if (e.target === S.ovl) showCard(null); });

    // keys while focus is inside the panel (never document-wide: the editor keeps its keys)
    p.addEventListener('keydown', function (e) {
      if (!S || (Cade.isMinimized && Cade.isMinimized(p))) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var inSearch = e.target === S.search;
      if (S.cardKind) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); showCard(null); } return; }
      if (S.roul && e.key === 'Escape') { e.preventDefault(); cancelRoulette(); return; }
      if (inSearch) return;
      var card = e.target.closest ? e.target.closest('.ac-card') : null;
      var k = e.key;
      if (card && /^(Arrow(Up|Down|Left|Right)|Home|End|Page(Up|Down))$/.test(k)) {
        e.preventDefault();
        var i = S.cards.indexOf(card), n;
        if (S.st.view === 'list') n = k === 'ArrowDown' || k === 'ArrowRight' ? Math.min(S.cards.length - 1, i + 1) : k === 'ArrowUp' || k === 'ArrowLeft' ? i - 1 : gridMove(i, k, 1, S.cards.length);
        else n = gridMove(i, k, columns(), S.cards.length);
        if (n < 0) { S.search.focus(); return; }
        setRoving(n, true);
        return;
      }
      if (k === '/' || (k.length === 1 && /[a-z0-9]/i.test(k) && !card && e.target.tagName !== 'BUTTON')) {
        e.preventDefault(); S.search.focus();
        if (k !== '/') S.search.value += k, render();
        return;
      }
      if (k === 'r' || k === 'R') { e.preventDefault(); randomGame(); }
      else if ((k === 'v' || k === 'V')) { e.preventDefault(); S.viewBtn.click(); }
      else if ((k === 'f' || k === 'F' || k === '*') && card) {
        e.preventDefault();
        var onPlay = e.target.classList && e.target.classList.contains('ac-play');
        card.querySelector('.ac-star').click();
        // F from a card keeps focus on the card (Enter then launches, not un-stars)
        if (onPlay && S && S.focusI >= 0) setRoving(S.focusI, true);
      }
      else if (k === '?') { e.preventDefault(); showCard('help'); }
      else if (k === 'Escape' && S.search.value) { e.preventDefault(); S.search.value = ''; render(); S.search.focus(); }
    });

    // first visit: the search box on desktop (typing finds a game straight away)
    if (!(mm && mm('(pointer: coarse)').matches)) setTimeout(function () { if (S && S.panel === p) { try { S.search.focus({ preventScroll: true }); } catch (e) {} } }, 30);
  }
  function chipIntoView(b) {
    var row = S && S.chips;
    if (!row || !b) return;
    var l = b.offsetLeft - row.offsetLeft, r = l + b.offsetWidth;
    if (l < row.scrollLeft) row.scrollLeft = l - 8;
    else if (r > row.scrollLeft + row.clientWidth) row.scrollLeft = r - row.clientWidth + 8;
  }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

  Cade.registerWidget({
    name: SELF,
    description: 'Every game in one place — browse, search and launch',
    icon: '🕹️',
    tags: 'game,arcade,games,launcher,hub,play',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
