/* Party Games — a pass-the-phone party pack for Cade.txt.
 * Charades: a big word card, 14 categories x 3 difficulties, a turn timer,
 *   Got it / Skip by button, key or tilt (phone on the forehead: tilt down =
 *   got it, up = pass), any number of teams, rounds, a turn review where a
 *   last-second guess can be fixed up, and a scoreboard.
 * Fishbowl: every player writes slips in secret (a privacy screen between
 *   players) or the deck fills the bowl; three rounds with the same slips —
 *   Describe, One Word, Act It Out; team turns rotate describers, and when the
 *   bowl empties mid-turn the leftover time carries into the next round.
 * Hot Seat: the player in the seat answers a question in secret; everybody
 *   else guesses out loud, then the answer is revealed and right guessers score.
 * Quick decks: Would You Rather (hand tally), Never Have I Ever, Most Likely To.
 * The engine (rules, scoring, decks, tilt detector, save + game normalisation)
 * is a pure section exported for node; the UI is plain DOM in the house's
 * monospace look. A game in progress survives closing the panel. No
 * markGamePanel: setup screens take real typing. Store keys: cade-partygames-*. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var TEAM_NAMES = ['Red', 'Blue', 'Green', 'Gold', 'Purple', 'Orange'];
  var MAX_TEAMS = 6, MAX_PLAYERS = 16, HS_MIN = 3, HS_MAX = 12;
  var DIFFS = ['easy', 'medium', 'hard', 'mixed'];
  var CH_SECS = [30, 45, 60, 90, 120], FB_SECS = [30, 45, 60, 90], FB_SKIPS = [0, 1, 2, -1];
  var HS_DECKS = ['light', 'silly', 'deep'];
  var FB_ROUNDS = [
    { name: 'Describe', short: 'any words but the slip\'s', rule: 'Say anything you like — except the words on the slip.' },
    { name: 'One Word', short: 'one word only', rule: 'Just ONE word per slip. Choose it well!' },
    { name: 'Act It Out', short: 'no words, no sounds', rule: 'No words, no sounds — act it out, charades style.' }
  ];
  var CARRY_MIN = 3;          // seconds: less than this left when the bowl empties is not carried over
  var NAME_MAX = 16, SLIP_MAX = 40, ANSWER_MAX = 60, USED_MAX = 900;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function int(v, d) { v = Math.round(Number(v)); return isFinite(v) ? v : d; }
  function cleanText(s, max) {
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max).trim() : s;
  }
  function wordKey(s) { return cleanText(s, 80).toLowerCase(); }

  // A serialisable seeded PRNG (mulberry32 with its state on the object), so a
  // saved game carries on with the same shuffle stream after a reload.
  function rnd(o) {
    o.rs = (o.rs + 0x6D2B79F5) | 0;
    var t = Math.imul(o.rs ^ (o.rs >>> 15), 1 | o.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function shuffle(a, o) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd(o) * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // ---- decks ----
  function splitList(s) { return typeof s === 'string' ? s.split('|').map(function (x) { return cleanText(x, 80); }).filter(Boolean) : []; }
  function parseCharades(data) {
    var src = data && Array.isArray(data.charades) ? data.charades : [];
    return src.map(function (c) {
      var words = [];
      [['e', 1], ['m', 2], ['h', 3]].forEach(function (p) { splitList(c[p[0]]).forEach(function (w) { words.push({ w: w, d: p[1] }); }); });
      return { id: String(c.id), name: String(c.name || c.id), icon: String(c.icon || ''), words: words };
    }).filter(function (c) { return c.words.length; });
  }
  // The word pool for a game: chosen categories (all when none), the difficulty
  // (mixed = all), deduped, words this device hasn't seen lately first.
  function buildPool(cats, sel, diff, used, o) {
    var want = {}, any = !sel || !sel.length, seen = {}, fresh = [], old = [], usedSet = {};
    (sel || []).forEach(function (id) { want[id] = 1; });
    (used || []).forEach(function (k) { usedSet[k] = 1; });
    var dn = diff === 'easy' ? 1 : diff === 'medium' ? 2 : diff === 'hard' ? 3 : 0;
    cats.forEach(function (c) {
      if (!any && !want[c.id]) return;
      c.words.forEach(function (x) {
        if (dn && x.d !== dn) return;
        var k = wordKey(x.w);
        if (seen[k]) return;
        seen[k] = 1;
        (usedSet[k] ? old : fresh).push({ w: x.w, c: c.name, i: c.icon, d: x.d });
      });
    });
    return shuffle(fresh, o).concat(shuffle(old, o));
  }
  function hotseatPool(data, decks, o) {
    var hs = data && data.hotseat || {}, out = [], seen = {};
    (decks && decks.length ? decks : HS_DECKS).forEach(function (d) {
      (Array.isArray(hs[d]) ? hs[d] : []).forEach(function (q) { q = cleanText(q, 140); if (q && !seen[q]) { seen[q] = 1; out.push(q); } });
    });
    return shuffle(out, o);
  }
  function parseWyr(s) {
    var p = String(s || '').split('|');
    return { a: cleanText(p[0], 120), b: cleanText(p[1], 120) };
  }
  function deckOrder(n, seed) { var o = { rs: seed | 0 }, a = []; for (var i = 0; i < n; i++) a.push(i); return shuffle(a, o); }

  // ---- configs (defensive: they come from storage) ----
  function teamList(a, min, max) {
    var out = Array.isArray(a) ? a.slice(0, max).map(function (n, i) { return cleanText(n, NAME_MAX) || TEAM_NAMES[i % TEAM_NAMES.length]; }) : [];
    while (out.length < min) out.push(TEAM_NAMES[out.length % TEAM_NAMES.length]);
    return out;
  }
  function pick(list, v, d) { return list.indexOf(v) >= 0 ? v : d; }
  function normChCfg(c) {
    c = c && typeof c === 'object' ? c : {};
    return {
      teams: teamList(c.teams, 2, MAX_TEAMS),
      cats: Array.isArray(c.cats) ? c.cats.filter(function (x) { return typeof x === 'string'; }).slice(0, 40) : [],
      diff: pick(DIFFS, c.diff, 'mixed'),
      secs: pick(CH_SECS, int(c.secs, 60), 60),
      rounds: clamp(int(c.rounds, 2), 1, 10),
      penalty: !!c.penalty,
      tilt: !!c.tilt
    };
  }
  function normFbCfg(c) {
    c = c && typeof c === 'object' ? c : {};
    return {
      teams: teamList(c.teams, 2, 4),
      players: clamp(int(c.players, 6), 4, MAX_PLAYERS),
      slips: clamp(int(c.slips, 3), 2, 5),
      secs: pick(FB_SECS, int(c.secs, 60), 60),
      skips: pick(FB_SKIPS, int(c.skips, 1), 1),
      deck: !!c.deck
    };
  }
  function normHsCfg(c) {
    c = c && typeof c === 'object' ? c : {};
    var pl = Array.isArray(c.players) ? c.players.slice(0, HS_MAX).map(function (n) { return cleanText(n, NAME_MAX); }) : ['', '', '', ''];
    while (pl.length < HS_MIN) pl.push('');
    var decks = Array.isArray(c.decks) ? c.decks.filter(function (d) { return HS_DECKS.indexOf(d) >= 0; }) : [];
    return { players: pl, laps: clamp(int(c.laps, 1), 1, 3), decks: decks.length ? decks : HS_DECKS.slice(), secret: c.secret !== false };
  }
  function playerNames(list) {
    var out = [];
    list.forEach(function (n) { n = cleanText(n, NAME_MAX); out.push(n || 'Player ' + (out.length + 1)); });
    return out;
  }

  // ---- standings: sorted copy with shared ranks for ties ----
  function standings(list) {
    var s = list.map(function (t, i) { return { i: i, name: t.name, score: t.score }; });
    s.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    s.forEach(function (x, k) { x.rank = k && s[k - 1].score === x.score ? s[k - 1].rank : k + 1; });
    return s;
  }

  // ================= Charades =================
  function newCharades(cfg, pool, seed) {
    cfg = normChCfg(cfg);
    return {
      kind: 'charades', cfg: cfg, rs: seed | 0,
      teams: cfg.teams.map(function (n) { return { name: n, score: 0, got: 0, skip: 0, turns: 0 }; }),
      pool: pool.slice(), pi: 0, round: 1, ti: 0, turn: null, over: false, best: null, log: []
    };
  }
  function chNext(g) {
    if (!g.pool.length) return null;
    if (g.pi >= g.pool.length) { shuffle(g.pool, g); g.pi = 0; }
    return g.pool[g.pi++];
  }
  function chStart(g) {
    if (g.over) return null;
    g.turn = { team: g.ti, left: g.cfg.secs, items: [], cur: chNext(g), done: false };
    return g.turn;
  }
  function chMark(g, res) {
    var t = g.turn;
    if (!t || t.done || !t.cur || (res !== 'got' && res !== 'skip')) return null;
    var it = { w: t.cur.w, c: t.cur.c, r: res };
    t.items.push(it);
    t.cur = chNext(g);
    return it;
  }
  function chTick(g, dt) {
    var t = g.turn;
    if (!t || t.done) return false;
    t.left -= dt;
    if (t.left > 0) return false;
    t.left = 0; t.done = true;
    if (t.cur) t.items.push({ w: t.cur.w, c: t.cur.c, r: 'time' });
    t.cur = null;
    return true;
  }
  function chEndEarly(g) { var t = g.turn; if (!t || t.done) return false; t.left = Math.min(t.left, 0.0001); return chTick(g, 1); }
  // got: +1; skip: -1 with the penalty on; 'time' (the card on screen at the buzzer): 0.
  function chTurnScore(t, cfg) {
    var s = 0;
    (t ? t.items : []).forEach(function (x) { if (x.r === 'got') s++; else if (x.r === 'skip' && cfg.penalty) s--; });
    return s;
  }
  function chToggle(t, i) {
    var x = t && t.items[i];
    if (!x) return null;
    x.r = x.r === 'got' ? (x.t ? 'time' : 'skip') : (x.r === 'time' && (x.t = 1), 'got');
    return x.r;
  }
  function chCommit(g) {
    var t = g.turn;
    if (!t || !t.done) return null;
    var tm = g.teams[t.team], sc = chTurnScore(t, g.cfg), got = 0, skip = 0;
    t.items.forEach(function (x) { if (x.r === 'got') got++; else if (x.r === 'skip') skip++; });
    tm.score += sc; tm.got += got; tm.skip += skip; tm.turns++;
    var e = { team: t.team, round: g.round, score: sc, got: got, skip: skip };
    g.log.push(e);
    if (!g.best || got > g.best.got) g.best = { got: got, team: t.team };
    g.turn = null;
    g.ti++;
    if (g.ti >= g.teams.length) { g.ti = 0; g.round++; }
    if (g.round > g.cfg.rounds) g.over = true;
    return e;
  }

  // ================= Fishbowl =================
  // Players are dealt to teams in turn (player i → team i mod T); each team's
  // describers rotate. Slips are added during the entry phase.
  function newFishbowl(cfg, seed) {
    cfg = normFbCfg(cfg);
    var T = cfg.teams.length;
    return {
      kind: 'fishbowl', cfg: cfg, rs: seed | 0, phase: 'entry', entry: 0,
      teams: cfg.teams.map(function (n) { return { name: n, score: 0, rs: [0, 0, 0] }; }),
      players: [], slips: [], bowl: [], round: 0, ti: 0, pn: cfg.teams.map(function () { return 0; }),
      carry: 0, carryP: -1, turn: null, roundOver: false, over: false, best: null, T: T
    };
  }
  function fbTeamOf(i, T) { return i % T; }
  function fbHas(g, w) { var k = wordKey(w); return g.slips.some(function (s) { return wordKey(s.w) === k; }); }
  // Adds a player and their slips. Returns { ok, err?, dup? (index) }.
  function fbAddPlayer(g, name, team, words) {
    if (g.phase !== 'entry') return { ok: false, err: 'started' };
    var clean = [], seen = {};
    for (var i = 0; i < words.length; i++) {
      var w = cleanText(words[i], SLIP_MAX);
      if (!w) return { ok: false, err: 'empty', at: i };
      var k = wordKey(w);
      if (seen[k] || fbHas(g, w)) return { ok: false, err: 'dup', at: i };
      seen[k] = 1; clean.push(w);
    }
    if (clean.length !== g.cfg.slips) return { ok: false, err: 'count' };
    var pi = g.players.length;
    team = team >= 0 && team < g.T ? team : fbTeamOf(pi, g.T);
    g.players.push({ name: cleanText(name, NAME_MAX) || 'Player ' + (pi + 1), team: team });
    clean.forEach(function (w) { g.slips.push({ w: w, by: pi }); });
    g.entry++;
    return { ok: true };
  }
  // Quick play: the deck writes the slips; players get team-numbered names.
  function fbFillFromDeck(g, words) {
    var need = g.cfg.players * g.cfg.slips, src = words.slice();
    shuffle(src, g);
    g.players = []; g.slips = [];
    for (var p = 0; p < g.cfg.players; p++) {
      var t = fbTeamOf(p, g.T), n = Math.floor(p / g.T) + 1;
      g.players.push({ name: g.teams[t].name + ' ' + n, team: t });
    }
    for (var i = 0, k = 0; i < src.length && g.slips.length < need; i++) {
      var w = cleanText(src[i], SLIP_MAX);
      if (w && !fbHas(g, w)) { g.slips.push({ w: w, by: Math.floor(k / g.cfg.slips) % g.cfg.players }); k++; }
    }
    g.entry = g.players.length;
    return g.slips.length;
  }
  function fbBegin(g) {
    if (g.phase !== 'entry' || g.slips.length < 2) return false;
    // every team needs at least one describer
    for (var t = 0; t < g.T; t++) if (!g.players.some(function (p) { return p.team === t; })) return false;
    g.phase = 'play'; g.round = 0; g.ti = 0;
    g.bowl = g.slips.map(function (s, i) { return i; });
    return true;
  }
  function fbDescribers(g, t) { var a = []; g.players.forEach(function (p, i) { if (p.team === t) a.push(i); }); return a; }
  function fbDraw(g, not) {
    var b = g.bowl;
    if (!b.length) return -1;
    if (b.length === 1) return b[0];
    var j;
    do { j = b[Math.floor(rnd(g) * b.length)]; } while (j === not);
    return j;
  }
  function fbStart(g) {
    if (g.phase !== 'play' || g.over) return null;
    var ds = fbDescribers(g, g.ti), p = g.carryP >= 0 ? g.carryP : ds[g.pn[g.ti] % ds.length];
    g.turn = { team: g.ti, player: p, left: g.carry > 0 ? g.carry : g.cfg.secs, carried: g.carry > 0, got: [], skips: 0, cur: fbDraw(g, -1), done: false, end: '' };
    g.carry = 0; g.carryP = -1;
    return g.turn;
  }
  function fbCanSkip(g) {
    var t = g.turn;
    return !!t && !t.done && g.bowl.length > 1 && (g.cfg.skips < 0 || t.skips < g.cfg.skips);
  }
  function fbGot(g) {
    var t = g.turn;
    if (!t || t.done || t.cur < 0) return null;
    var w = g.slips[t.cur].w;
    g.bowl.splice(g.bowl.indexOf(t.cur), 1);
    t.got.push(w);
    g.teams[t.team].score++; g.teams[t.team].rs[g.round]++;
    if (!g.bowl.length) {
      t.done = true; t.end = 'bowl'; t.cur = -1; g.roundOver = true;
      if (g.round < 2 && t.left >= CARRY_MIN) { g.carry = Math.round(t.left); g.carryP = t.player; }
    } else t.cur = fbDraw(g, t.cur);
    return w;
  }
  function fbSkip(g) {
    if (!fbCanSkip(g)) return false;
    var t = g.turn;
    t.skips++;
    t.cur = fbDraw(g, t.cur);
    return true;
  }
  function fbTick(g, dt) {
    var t = g.turn;
    if (!t || t.done) return false;
    t.left -= dt;
    if (t.left > 0) return false;
    t.left = 0; t.done = true; t.end = 'time'; t.cur = -1;
    return true;
  }
  function fbEndEarly(g) { var t = g.turn; if (!t || t.done) return false; t.left = 0.0001; return fbTick(g, 1); }
  function fbCommit(g) {
    var t = g.turn;
    if (!t || !t.done) return null;
    var e = { team: t.team, player: t.player, got: t.got.length, end: t.end, round: g.round, roundOver: g.roundOver, carry: g.carry };
    if (!g.best || e.got > g.best.got) g.best = { got: e.got, team: t.team, player: t.player };
    g.turn = null;
    if (!(g.carry > 0)) { g.pn[t.team]++; g.ti = (t.team + 1) % g.T; }
    if (g.roundOver) {
      g.roundOver = false;
      g.round++;
      if (g.round >= 3) { g.over = true; g.carry = 0; g.carryP = -1; }
      else g.bowl = g.slips.map(function (s, i) { return i; });
    }
    return e;
  }

  // ================= Hot Seat =================
  function newHotSeat(cfg, questions, seed) {
    cfg = normHsCfg(cfg);
    var names = playerNames(cfg.players);   // every row is a seat; a blank one is 'Player N'
    var order = [];
    for (var l = 0; l < cfg.laps; l++) for (var i = 0; i < names.length; i++) order.push(i);
    return {
      kind: 'hotseat', cfg: cfg, rs: seed | 0,
      players: names.map(function (n) { return { name: n, score: 0 }; }),
      order: order, oi: 0, qs: questions.slice(), qi: 0, q: '', answer: '', over: false
    };
  }
  function hsSeat(g) { return g.order[g.oi]; }
  function hsQuestion(g) {
    if (!g.qs.length) return '';
    if (g.qi >= g.qs.length) { shuffle(g.qs, g); g.qi = 0; }
    g.q = g.qs[g.qi++]; g.answer = '';
    return g.q;
  }
  function hsSetAnswer(g, a) { g.answer = cleanText(a, ANSWER_MAX); return g.answer; }
  // Right guessers score 1 each; the seat scores 1 when anybody knew them.
  function hsAward(g, who) {
    if (g.over) return null;
    var seat = hsSeat(g), ok = [];
    (who || []).forEach(function (i) { i = int(i, -1); if (i >= 0 && i < g.players.length && i !== seat && ok.indexOf(i) < 0) ok.push(i); });
    ok.forEach(function (i) { g.players[i].score++; });
    if (ok.length) g.players[seat].score++;
    g.oi++; g.q = ''; g.answer = '';
    if (g.oi >= g.order.length) g.over = true;
    return { seat: seat, ok: ok };
  }

  // ================= tilt (phone held on the forehead) =================
  // gz = how much the screen faces the sky, from the standard orientation
  // angles (no axis flips at vertical, same on every platform): upright ≈ 0,
  // screen to the floor (head nods down) < 0 → got it, to the ceiling > 0 →
  // pass. It must come back near upright before it fires again.
  var TILT_ON = 0.55, TILT_REARM = 0.3;
  function tiltNew() { return { armed: false, n: 0 }; }
  function tiltStep(st, beta, gamma) {
    if (typeof beta !== 'number' || typeof gamma !== 'number' || !isFinite(beta) || !isFinite(gamma)) return null;
    var r = Math.PI / 180, gz = Math.cos(beta * r) * Math.cos(gamma * r);
    st.gz = gz;
    if (!st.armed) { if (Math.abs(gz) < TILT_REARM) st.armed = true; return null; }
    if (gz <= -TILT_ON || gz >= TILT_ON) { st.armed = false; st.n++; return gz < 0 ? 'got' : 'skip'; }
    return null;
  }

  // ================= save + saved game =================
  function newSave() {
    return {
      v: 1, cfg: { ch: normChCfg(null), fb: normFbCfg(null), hs: normHsCfg(null) },
      rec: { played: { ch: 0, fb: 0, hs: 0 }, chTurn: null, fbTurn: null, hsTop: null, chGame: null },
      used: []
    };
  }
  function normRec(r, keyName) {
    if (!r || typeof r !== 'object') return null;
    var n = int(r.n, -1);
    if (n < 0) return null;
    var o = { n: n }; o[keyName] = cleanText(r[keyName], NAME_MAX * 2);
    return o;
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    var c = o.cfg || {};
    s.cfg = { ch: normChCfg(c.ch), fb: normFbCfg(c.fb), hs: normHsCfg(c.hs) };
    var r = o.rec || {}, pl = r.played || {};
    ['ch', 'fb', 'hs'].forEach(function (k) { s.rec.played[k] = Math.max(0, int(pl[k], 0)); });
    s.rec.chTurn = normRec(r.chTurn, 'by');
    s.rec.fbTurn = normRec(r.fbTurn, 'by');
    s.rec.hsTop = normRec(r.hsTop, 'by');
    s.rec.chGame = normRec(r.chGame, 'by');
    if (Array.isArray(o.used)) s.used = o.used.filter(function (k) { return typeof k === 'string' && k.length < 90; }).slice(-USED_MAX);
    return s;
  }
  function noteUsed(save, words) {
    var have = {};
    save.used.forEach(function (k) { have[k] = 1; });
    words.forEach(function (w) { var k = wordKey(w); if (k && !have[k]) { have[k] = 1; save.used.push(k); } });
    if (save.used.length > USED_MAX) save.used = save.used.slice(-USED_MAX);
  }
  // Records at the end of a game (or turn). Returns the labels of records broken.
  function better(rec, n) { return n > 0 && (!rec || n > rec.n); }
  function recordTurn(save, kind, n, by) {
    var key = kind === 'ch' ? 'chTurn' : 'fbTurn';
    if (better(save.rec[key], n)) { save.rec[key] = { n: n, by: cleanText(by, NAME_MAX * 2) }; return true; }
    return false;
  }
  function recordGame(save, g) {
    var out = [];
    if (g.kind === 'charades') {
      save.rec.played.ch++;
      var top = standings(g.teams)[0];
      if (better(save.rec.chGame, top.score)) { save.rec.chGame = { n: top.score, by: top.name }; out.push('top charades score'); }
    } else if (g.kind === 'fishbowl') save.rec.played.fb++;
    else if (g.kind === 'hotseat') {
      save.rec.played.hs++;
      var hp = standings(g.players)[0];
      if (better(save.rec.hsTop, hp.score)) { save.rec.hsTop = { n: hp.score, by: hp.name }; out.push('top hot seat score'); }
    }
    return out;
  }

  // A saved game comes back from storage: check every field, or drop it.
  function isArr(a, max) { return Array.isArray(a) && a.length <= max; }
  function normGame(o) {
    try {
      if (!o || typeof o !== 'object') return null;
      var g;
      if (o.kind === 'charades') {
        if (!isArr(o.pool, 5000) || !o.pool.length || !isArr(o.teams, MAX_TEAMS) || o.teams.length < 1) return null;
        g = newCharades(o.cfg, [], int(o.rs, 1));
        if (g.teams.length !== o.teams.length) g.teams.length = Math.min(g.teams.length, o.teams.length);
        g.pool = o.pool.filter(function (x) { return x && typeof x.w === 'string'; }).map(function (x) { return { w: cleanText(x.w, 80), c: cleanText(x.c, 40), i: cleanText(x.i, 8), d: clamp(int(x.d, 1), 1, 3) }; });
        if (!g.pool.length) return null;
        g.teams = o.teams.slice(0, g.cfg.teams.length).map(function (t, i) {
          return { name: g.cfg.teams[i], score: int(t && t.score, 0), got: Math.max(0, int(t && t.got, 0)), skip: Math.max(0, int(t && t.skip, 0)), turns: Math.max(0, int(t && t.turns, 0)) };
        });
        g.pi = clamp(int(o.pi, 0), 0, g.pool.length);
        g.round = clamp(int(o.round, 1), 1, g.cfg.rounds + 1);
        g.ti = clamp(int(o.ti, 0), 0, g.teams.length - 1);
        g.over = !!o.over || g.round > g.cfg.rounds;
        g.best = o.best && typeof o.best === 'object' ? { got: Math.max(0, int(o.best.got, 0)), team: clamp(int(o.best.team, 0), 0, g.teams.length - 1) } : null;
        g.log = isArr(o.log, 500) ? o.log.filter(function (e) { return e && typeof e === 'object'; }).map(function (e) {
          return { team: clamp(int(e.team, 0), 0, g.teams.length - 1), round: Math.max(1, int(e.round, 1)), score: int(e.score, 0), got: Math.max(0, int(e.got, 0)), skip: Math.max(0, int(e.skip, 0)) };
        }) : [];
        return g;
      }
      if (o.kind === 'fishbowl') {
        g = newFishbowl(o.cfg, int(o.rs, 1));
        if (!isArr(o.players, MAX_PLAYERS) || !isArr(o.slips, MAX_PLAYERS * 5)) return null;
        g.players = o.players.filter(function (p) { return p && typeof p === 'object'; }).map(function (p, i) {
          var t = int(p.team, -1);
          return { name: cleanText(p.name, NAME_MAX) || 'Player ' + (i + 1), team: t >= 0 && t < g.T ? t : fbTeamOf(i, g.T) };
        });
        var seen = {};
        g.slips = o.slips.filter(function (s) {
          if (!s || typeof s.w !== 'string') return false;
          var k = wordKey(s.w); if (!k || seen[k]) return false; seen[k] = 1; return true;
        }).map(function (s) { return { w: cleanText(s.w, SLIP_MAX), by: clamp(int(s.by, 0), 0, Math.max(0, g.players.length - 1)) }; });
        g.entry = g.players.length;
        g.teams.forEach(function (t, i) {
          var src = isArr(o.teams, 4) && o.teams[i] || {};
          t.score = Math.max(0, int(src.score, 0));
          t.rs = [0, 1, 2].map(function (k) { return Math.max(0, int(src.rs && src.rs[k], 0)); });
        });
        g.pn = g.teams.map(function (t, i) { return Math.max(0, int(o.pn && o.pn[i], 0)); });
        g.best = o.best && typeof o.best === 'object' ? { got: Math.max(0, int(o.best.got, 0)), team: clamp(int(o.best.team, 0), 0, g.T - 1), player: clamp(int(o.best.player, 0), 0, Math.max(0, g.players.length - 1)) } : null;
        if (o.phase === 'play') {
          if (!g.slips.length) return null;
          g.phase = 'play';
          g.round = clamp(int(o.round, 0), 0, 3);
          g.over = !!o.over || g.round >= 3;
          g.ti = clamp(int(o.ti, 0), 0, g.T - 1);
          g.bowl = isArr(o.bowl, g.slips.length) ? o.bowl.map(function (i) { return int(i, -1); }).filter(function (i, k, a) { return i >= 0 && i < g.slips.length && a.indexOf(i) === k; }) : [];
          if (!g.bowl.length && !g.over) g.bowl = g.slips.map(function (s, i) { return i; });
          g.carry = clamp(int(o.carry, 0), 0, 120);
          g.carryP = g.carry > 0 ? clamp(int(o.carryP, -1), -1, g.players.length - 1) : -1;
          if (g.carryP < 0) g.carry = 0;
          for (var t = 0; t < g.T; t++) if (!fbDescribers(g, t).length) return null;
        }
        return g;
      }
      if (o.kind === 'hotseat') {
        if (!isArr(o.players, HS_MAX) || o.players.length < HS_MIN || !isArr(o.qs, 2000)) return null;
        g = newHotSeat(o.cfg, [], int(o.rs, 1));
        g.players = o.players.map(function (p, i) { return { name: cleanText(p && p.name, NAME_MAX) || 'Player ' + (i + 1), score: Math.max(0, int(p && p.score, 0)) }; });
        g.order = [];
        for (var l = 0; l < g.cfg.laps; l++) for (var i = 0; i < g.players.length; i++) g.order.push(i);
        g.qs = o.qs.filter(function (q) { return typeof q === 'string' && q; }).map(function (q) { return cleanText(q, 140); });
        if (!g.qs.length) return null;
        g.qi = clamp(int(o.qi, 0), 0, g.qs.length);
        g.oi = clamp(int(o.oi, 0), 0, g.order.length);
        g.over = !!o.over || g.oi >= g.order.length;
        g.q = ''; g.answer = '';
        return g;
      }
    } catch (e) { return null; }
    return null;
  }

  var ENGINE = {
    TEAM_NAMES: TEAM_NAMES, DIFFS: DIFFS, CH_SECS: CH_SECS, FB_SECS: FB_SECS, FB_SKIPS: FB_SKIPS, FB_ROUNDS: FB_ROUNDS, HS_DECKS: HS_DECKS,
    CARRY_MIN: CARRY_MIN, MAX_TEAMS: MAX_TEAMS, HS_MIN: HS_MIN, HS_MAX: HS_MAX, USED_MAX: USED_MAX, SLIP_MAX: SLIP_MAX,
    rnd: rnd, shuffle: shuffle, cleanText: cleanText, wordKey: wordKey, standings: standings,
    parseCharades: parseCharades, buildPool: buildPool, hotseatPool: hotseatPool, parseWyr: parseWyr, deckOrder: deckOrder,
    normChCfg: normChCfg, normFbCfg: normFbCfg, normHsCfg: normHsCfg, playerNames: playerNames,
    newCharades: newCharades, chStart: chStart, chMark: chMark, chTick: chTick, chEndEarly: chEndEarly, chTurnScore: chTurnScore, chToggle: chToggle, chCommit: chCommit,
    newFishbowl: newFishbowl, fbTeamOf: fbTeamOf, fbAddPlayer: fbAddPlayer, fbFillFromDeck: fbFillFromDeck, fbBegin: fbBegin, fbStart: fbStart,
    fbCanSkip: fbCanSkip, fbGot: fbGot, fbSkip: fbSkip, fbTick: fbTick, fbEndEarly: fbEndEarly, fbCommit: fbCommit, fbDescribers: fbDescribers,
    newHotSeat: newHotSeat, hsSeat: hsSeat, hsQuestion: hsQuestion, hsSetAnswer: hsSetAnswer, hsAward: hsAward,
    tiltNew: tiltNew, tiltStep: tiltStep,
    newSave: newSave, normSave: normSave, noteUsed: noteUsed, recordTurn: recordTurn, recordGame: recordGame, normGame: normGame
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('partygames.css');
  var DATA_URL = Cade.asset('partygames-data.js');   // resolve now, while currentScript is us

  var PANEL_ID = 'partygames-panel', NAME = 'Party Games';
  var KEY = 'cade-partygames-', SAVE_KEY = KEY + 'save', GAME_KEY = KEY + 'game', SOUND_KEY = KEY + 'sound';
  var S = null;           // the live session (one panel at a time)
  var DATA = null, loading = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.partygames = { live: function () { return S; } };

  function loadData() {
    if (DATA) return Promise.resolve(DATA);
    if (window.__cadePartyData) { DATA = window.__cadePartyData; return Promise.resolve(DATA); }
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = DATA_URL; s.async = true;
      s.onload = function () {
        if (window.__cadePartyData && window.__cadePartyData.charades) { DATA = window.__cadePartyData; resolve(DATA); }
        else { loading = null; reject(new Error('no data')); }
      };
      s.onerror = function () { loading = null; s.remove(); reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { Cade.store.remove(k); } catch (e) {} }
  function loadJSON(k) { var raw = sget(k); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function saveGame() {
    if (!S) return;
    if (!S.g || S.g.over) { sdel(GAME_KEY); return; }
    var g = S.g, keep = g.turn;
    g.turn = null;                       // a turn in flight is replayed from its ready screen
    try { sset(GAME_KEY, JSON.stringify(g)); } catch (e) {}
    g.turn = keep;
  }
  function seed() { return (Math.random() * 4294967295) | 0; }

  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function toast(m, t) { try { Cade.showToast(m, t || 'info', 2000); } catch (e) {} }
  function buzz(ms) { try { if (Cade.haptic) Cade.haptic(ms); } catch (e) {} }
  function now() { return window.performance && performance.now ? performance.now() : Date.now(); }
  function fmtClock(s) { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }
  function plural(n, w, p) { return n + ' ' + (n === 1 ? w : (p || w + 's')); }

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
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };
  var SFX = {
    tap: function (s) { s.tone(880, 0.05, 'sine', 0.03); },
    tick: function (s) { s.tone(1046, 0.05, 'square', 0.025); },
    count: function (s) { s.tone(587, 0.09, 'triangle', 0.04); },
    go: function (s) { s.tone(784, 0.08, 'triangle', 0.045); s.tone(1175, 0.16, 'triangle', 0.045, 0, 0.08); },
    got: function (s) { s.tone(659, 0.07, 'triangle', 0.045); s.tone(988, 0.12, 'triangle', 0.045, 0, 0.06); },
    skip: function (s) { s.tone(260, 0.14, 'sawtooth', 0.025, 160); },
    buzz: function (s) { s.tone(150, 0.55, 'sawtooth', 0.05, 110); s.tone(155, 0.55, 'square', 0.025, 112); },
    win: function (s) { [523, 659, 784, 1047, 1319].forEach(function (f, j) { s.tone(f, 0.16, 'triangle', 0.04, 0, j * 0.1); }); },
    reveal: function (s) { s.tone(392, 0.1, 'triangle', 0.04); s.tone(523, 0.1, 'triangle', 0.04, 0, 0.08); s.tone(784, 0.2, 'triangle', 0.04, 0, 0.16); }
  };
  function sfx(n) { if (S && S.snd.on) { S.snd.ensure(); SFX[n](S.snd); } }

  function svg(path) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_HELP = svg('<circle cx="12" cy="12" r="9.5"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 4"/><path d="M12 17.4h.01"/>');
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5v14l11-7z"/>');
  var IC_HOME = svg('<path d="M4 11 12 4l8 7"/><path d="M6 10v9h12v-9"/>');

  // ---- small HTML builders ----
  function title(t) { return '<div class="pg-title">' + esc(t) + '</div>'; }
  function btn(act, label, cls, extra) { return '<button type="button" class="pg-go' + (cls ? ' ' + cls : '') + '" data-act="' + act + '"' + (extra || '') + '>' + label + '</button>'; }
  function chip(act, val, label, on, extra) {
    return '<button type="button" class="pg-chip' + (on ? ' on' : '') + '" data-act="' + act + '" data-v="' + esc(val) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' + (extra || '') + '>' + label + '</button>';
  }
  function sec(h, body, cls) { return '<div class="pg-sec' + (cls ? ' ' + cls : '') + '"><div class="pg-h">' + h + '</div>' + body + '</div>'; }
  function teamTag(i, name) { return '<span class="pg-tm pg-c' + (i % 6) + '">' + esc(name) + '</span>'; }
  function scoreTable(list, isTeams, hi) {
    var st = standings(list), max = Math.max(1, st[0] ? st[0].score : 1);
    return '<div class="pg-board">' + st.map(function (x) {
      var w = Math.max(0, Math.round(12 * x.score / max));
      return '<div class="pg-row' + (x.i === hi ? ' hi' : '') + '"><span class="pg-rk">' + x.rank + '.</span>' +
        (isTeams ? teamTag(x.i, x.name) : '<span class="pg-pn">' + esc(x.name) + '</span>') +
        '<span class="pg-bar' + (isTeams ? ' pg-c' + (x.i % 6) : '') + '">' + new Array(w + 1).join('#') + '<i>' + new Array(13 - w).join('.') + '</i></span>' +
        '<b class="pg-sc">' + x.score + '</b></div>';
    }).join('') + '</div>';
  }
  function banner() {
    return '<pre class="pg-art" aria-hidden="true">' +
      ' ___  _   ___ _______   __\n| _ \\/_\\ | _ \\_   _\\ \\ / /\n|  _/ _ \\|   / | |  \\ V / \n|_|/_/ \\_\\_|_\\ |_|   |_|  </pre>' +
      '<div class="pg-sub">g &nbsp;a &nbsp;m &nbsp;e &nbsp;s &nbsp;·&nbsp; pass the phone</div>';
  }

  var MODES = [
    { id: 'ch', name: 'Charades', art: '\\o/', blurb: 'Act it out or hold it to your forehead — teams race the clock.' },
    { id: 'fb', name: 'Fishbowl', art: '(~)', blurb: 'Everyone writes slips. Three rounds: describe, one word, act.' },
    { id: 'hs', name: 'Hot Seat', art: '[?]', blurb: 'One player answers in secret — who knows them best?' },
    { id: 'wyr', name: 'Would You Rather', art: 'A|B', blurb: 'Pick a side and count the hands.' },
    { id: 'nhie', name: 'Never Have I Ever', art: '0/0', blurb: 'Family-friendly confessions.' },
    { id: 'mlt', name: 'Most Likely To', art: '-->', blurb: 'Count down, then everybody points.' }
  ];

  // ================= screens =================
  function render() {
    if (!S) return;
    var body = S.panel.querySelector('.cade-panel-body'), top = body ? body.scrollTop : 0, same = S.lastScr === S.scr;
    var h = SCREENS[S.scr] ? SCREENS[S.scr]() : '';
    S.main.innerHTML = h;
    S.main.setAttribute('data-scr', S.scr);
    if (body) body.scrollTop = same ? top : 0;
    S.lastScr = S.scr;
    syncHead();
    if (S.scr === 'ch-turn' || S.scr === 'fb-turn') paintTurn();
  }
  function go(scr) {
    if (!/-over$/.test(scr) && S.fx.firstChild) { clearTimeout(S.confT); S.fx.innerHTML = ''; }   // confetti stays on the results screen
    S.scr = scr; render(); var f = S.main.querySelector('[data-focus]'); if (f && !S.coarse) { try { f.focus({ preventScroll: true }); } catch (e) {} } }

  function homeHtml() {
    var r = S.save.rec, resume = S.saved ? '<div class="pg-resume"><span>Game in progress: <b>' + esc(modeName(S.saved.kind)) + '</b></span>' +
      btn('resume-game', 'Resume', 'sm') + '<button type="button" class="pg-lnk" data-act="drop-game">discard</button></div>' : '';
    var recs = [];
    if (r.chTurn) recs.push(['Best charades turn', plural(r.chTurn.n, 'word') + ' · ' + r.chTurn.by]);
    if (r.chGame) recs.push(['Top charades score', r.chGame.n + ' · ' + r.chGame.by]);
    if (r.fbTurn) recs.push(['Best fishbowl turn', plural(r.fbTurn.n, 'slip') + ' · ' + r.fbTurn.by]);
    if (r.hsTop) recs.push(['Top hot seat score', r.hsTop.n + ' · ' + r.hsTop.by]);
    var played = r.played.ch + r.played.fb + r.played.hs;
    return '<div class="pg-home">' + banner() + resume +
      '<div class="pg-modes">' + MODES.map(function (m) {
        return '<button type="button" class="pg-mode" data-act="mode" data-v="' + m.id + '"><span class="pg-ma" aria-hidden="true">' + esc(m.art) + '</span>' +
          '<span class="pg-mt"><b>' + esc(m.name) + '</b><small>' + esc(m.blurb) + '</small></span></button>';
      }).join('') + '</div>' +
      (recs.length || played ? '<div class="pg-recs">' + recs.map(function (q) { return '<div><span>' + esc(q[0]) + '</span><b>' + esc(q[1]) + '</b></div>'; }).join('') +
        '<div class="pg-note">' + plural(played, 'game') + ' played · ' + r.played.ch + ' charades · ' + r.played.fb + ' fishbowl · ' + r.played.hs + ' hot seat</div></div>' : '') +
      '</div>';
  }
  function modeName(k) { return k === 'charades' ? 'Charades' : k === 'fishbowl' ? 'Fishbowl' : k === 'hotseat' ? 'Hot Seat' : ''; }

  var HELP = {
    ch: ['CHARADES', '<p>Split into teams. On your team\'s turn one player takes the phone and acts out (or describes, if you agree) the word on the card; the team guesses before the clock runs out.</p>' +
      '<p><b>Got it</b> scores a point, <b>Skip</b> moves on (or costs a point with the penalty on). After the buzzer, tap any word to fix it — say, a guess that landed on the last second.</p>' +
      '<p><b>Forehead mode</b> (phones): hold the phone on your forehead, screen out; your team describes. Nod <b>down</b> for got it, tip <b>up</b> to pass.</p>',
      ['→ / Enter / Space', 'got it'], ['← / S', 'skip'], ['P', 'pause']],
    fb: ['FISHBOWL', '<p>Everybody secretly writes a few slips — people, things, places, anything — and drops them in the bowl (or let the deck fill it). The <b>same slips</b> are used for all three rounds:</p>' +
      '<p><b>1 Describe</b> — any words except the slip\'s. <b>2 One Word</b> — a single word per slip. <b>3 Act It Out</b> — silent charades.</p>' +
      '<p>Teams take turns; describers rotate. Each slip guessed is a point. Empty the bowl mid-turn and you keep your leftover time for the next round.</p>',
      ['→ / Enter / Space', 'got it'], ['← / S', 'skip (limited)'], ['P', 'pause']],
    hs: ['HOT SEAT', '<p>Take turns in the hot seat. Only the player in the seat looks: they read a question and type their <b>secret answer</b>.</p>' +
      '<p>Then the phone goes back to the group, who guess out loud. Reveal the answer and tap everyone who got it — <b>+1 each</b>, and the hot-seat player gets <b>+1</b> when anybody knew them.</p>' +
      '<p>Questions come in Light, Silly and Deep decks — all family friendly.</p>'],
    wyr: ['WOULD YOU RATHER', '<p>Read the card out. Everybody picks a side; tap a side once per hand to count it. Arguments encouraged.</p>', ['→ / Space', 'next card'], ['←', 'previous']],
    nhie: ['NEVER HAVE I EVER', '<p>Read the card. Anybody who <b>has</b> done it raises a hand (or folds a finger, if you play with ten). Tap to count them.</p>', ['→ / Space', 'next card'], ['←', 'previous']],
    mlt: ['MOST LIKELY TO', '<p>Read the card, hit the countdown, and on <b>POINT!</b> everybody points at the person most likely to do it. Most fingers takes a bow.</p>', ['→ / Space', 'next card'], ['←', 'previous']],
    home: ['PARTY GAMES', '<p>Party games for one phone (or laptop) passed around a group. Pick a game, set up your teams or players, and hand it over.</p>' +
      '<p>Screens marked <b>pass</b> hide what is coming until the right person taps. A game in progress is kept if you close the panel.</p>' +
      '<p>Sound is off by default — the speaker button turns it on.</p>']
  };
  function helpHtml() {
    var k = S.helpFor, h = HELP[k] || HELP.home, keys = h.slice(2);
    return '<div class="pg-card">' + title(h[0]) + h[1] +
      (keys.length && !S.coarse ? '<div class="pg-keys">' + keys.map(function (q) { return '<div><b>' + esc(q[0]) + '</b> &nbsp;' + esc(q[1]) + '</div>'; }).join('') + '</div>' : '') +
      btn('help-close', 'Got it', '', ' data-focus') + '</div>';
  }

  // ---------- Charades setup ----------
  function teamsEditor(teams, min, max, field) {
    return '<div class="pg-teams">' + teams.map(function (n, i) {
      return '<div class="pg-team"><span class="pg-dot pg-c' + (i % 6) + '" aria-hidden="true">#</span>' +
        '<input class="pg-in" type="text" maxlength="' + NAME_MAX + '" data-f="' + field + '" data-i="' + i + '" value="' + esc(n) + '" aria-label="Team ' + (i + 1) + ' name" autocomplete="off" enterkeyhint="done">' +
        (teams.length > min ? '<button type="button" class="pg-x" data-act="' + field + '-del" data-i="' + i + '" aria-label="Remove ' + esc(n) + '">×</button>' : '') + '</div>';
    }).join('') + (teams.length < max ? '<button type="button" class="pg-lnk add" data-act="' + field + '-add">+ add team</button>' : '') + '</div>';
  }
  function chSetupHtml() {
    var c = S.save.cfg.ch, cats = S.cats;
    var all = !c.cats.length;
    var n = buildCount(c);
    return '<div class="pg-card wide">' + title('CHARADES') +
      sec('Teams', teamsEditor(c.teams, 2, MAX_TEAMS, 'ch-team')) +
      sec('Categories <i>' + (all ? 'all' : c.cats.length + ' of ' + cats.length) + ' · ' + plural(n, 'word') + '</i>',
        '<div class="pg-chips">' + chip('ch-cat-all', '', 'Everything', all) + cats.map(function (k) { return chip('ch-cat', k.id, '<span aria-hidden="true">' + esc(k.icon) + '</span> ' + esc(k.name), !all && c.cats.indexOf(k.id) >= 0); }).join('') + '</div>') +
      sec('Difficulty', '<div class="pg-seg">' + DIFFS.map(function (d) { return chip('ch-diff', d, d.charAt(0).toUpperCase() + d.slice(1), c.diff === d); }).join('') + '</div>') +
      '<div class="pg-two">' +
      sec('Turn timer', '<div class="pg-seg">' + CH_SECS.map(function (s) { return chip('ch-secs', s, s % 60 ? (s > 60 ? Math.floor(s / 60) + ':' + (s % 60) : s + 's') : (s / 60) + 'm', c.secs === s); }).join('') + '</div>') +
      sec('Rounds', '<div class="pg-seg">' + [1, 2, 3, 5].map(function (r) { return chip('ch-rounds', r, String(r), c.rounds === r); }).join('') + '</div>') +
      '</div>' +
      sec('Rules', '<div class="pg-chips">' + chip('ch-penalty', '', 'Skip costs a point', c.penalty) +
        (S.canTilt ? chip('ch-tilt', '', '📱 Forehead mode (tilt)', c.tilt) : '') + '</div>') +
      '<div class="pg-btns">' + btn('home', 'Back', 'alt') + btn('ch-start', 'Start ▸', '', ' data-focus') + '</div></div>';
  }
  function buildCount(c) { return buildPool(S.cats, c.cats, c.diff, [], { rs: 1 }).length; }

  function chReadyHtml() {
    var g = S.g, t = g.teams[g.ti], first = !g.log.length;
    return '<div class="pg-card pass">' + title('PASS') +
      '<div class="pg-sub">Round ' + g.round + ' of ' + g.cfg.rounds + '</div>' +
      '<div class="pg-pass-team">' + teamTag(g.ti, t.name) + '</div>' +
      '<p class="pg-c">Pick an actor and hand them the phone.<br>Everyone else on ' + esc(t.name) + ': <b>no peeking!</b></p>' +
      (g.cfg.tilt ? '<p class="pg-c pg-tip">📱 Forehead mode: phone on your forehead, screen out.<br>Nod <b>down</b> = got it · tip <b>up</b> = pass</p>' : '') +
      btn('ch-go', 'Tap when ready', 'big', ' data-focus') +
      (first ? '' : scoreTable(g.teams, true, g.ti)) +
      '<div class="pg-foot"><button type="button" class="pg-lnk" data-act="quit">quit game</button><span>' + g.cfg.secs + 's turns · ' + esc(g.cfg.diff) + '</span></div></div>';
  }
  function turnHtml(kind) {
    var g = S.g, t = g.turn, team = g.teams[t.team];
    var who = kind === 'fb' ? esc(g.players[t.player].name) + ' · ' : '';
    var meta = kind === 'fb' ? 'Round ' + (g.round + 1) + ': ' + FB_ROUNDS[g.round].name : 'Round ' + g.round + '/' + g.cfg.rounds;
    return '<div class="pg-turn">' +
      '<div class="pg-thead">' + teamTag(t.team, team.name) + '<span class="pg-who">' + who + esc(meta) + '</span><span class="pg-clock" aria-hidden="true"></span></div>' +
      '<div class="pg-tbar" aria-hidden="true"></div>' +
      '<div class="pg-wcard" aria-live="assertive"></div>' +
      '<div class="pg-tstat"></div>' +
      '<div class="pg-pad">' +
      '<button type="button" class="pg-act skip" data-k="skip">Skip<small>' + (S.coarse ? '' : '← / S') + '</small></button>' +
      '<button type="button" class="pg-act got" data-k="got">Got it!<small>' + (S.coarse ? '' : '→ / Space') + '</small></button>' +
      '</div>' +
      '<div class="pg-foot"><button type="button" class="pg-lnk" data-act="end-turn">end turn</button><span class="pg-tiltst"></span></div>' +
      '<div class="pg-pausecard" hidden><div class="pg-card">' + title('PAUSED') + '<p class="pg-c">The card is hidden. Timer stopped.</p>' +
      '<div class="pg-btns">' + btn('quit', 'Quit game', 'alt') + btn('resume', 'Resume ▸') + '</div></div></div>' +
      '</div>';
  }
  function wordSize(w) { var n = w.length; return n > 28 ? 'xl' : n > 16 ? 'l' : n > 10 ? 'm' : ''; }
  // Paint the parts of the turn screen that change (clock, bar, card, stats).
  function paintTurn() {
    if (!S || !S.g || !S.g.turn) return;
    var g = S.g, t = g.turn, m = S.main, fb = g.kind === 'fishbowl';
    var tot = S.turnTotal || g.cfg.secs;
    var cl = m.querySelector('.pg-clock'), bar = m.querySelector('.pg-tbar'), card = m.querySelector('.pg-wcard'), st = m.querySelector('.pg-tstat');
    if (!cl) return;
    var left = t.left, low = left <= 10;
    cl.textContent = fmtClock(left);
    cl.classList.toggle('low', low && S.cd <= 0);
    var cols = S.barCols || 30, fill = Math.max(0, Math.min(cols, Math.round(cols * left / Math.max(1, tot))));
    bar.innerHTML = '[' + '<b class="' + (low ? 'low' : '') + '">' + new Array(fill + 1).join('=') + '</b>' + '<i>' + new Array(cols - fill + 1).join('-') + '</i>]';
    var key;
    if (S.cd > 0) key = 'cd' + Math.ceil(S.cd);
    else if (fb) key = 'w' + t.cur;
    else key = 'w' + (t.cur ? t.cur.w : '');
    if (card.getAttribute('data-k') !== key) {
      card.setAttribute('data-k', key);
      if (S.cd > 0) card.innerHTML = '<div class="pg-cd">' + Math.ceil(S.cd) + '</div><div class="pg-cat">get ready</div>';
      else if (fb) {
        var w = t.cur >= 0 ? g.slips[t.cur].w : '';
        card.innerHTML = '<div class="pg-cat">' + esc(FB_ROUNDS[g.round].name) + ' · ' + esc(FB_ROUNDS[g.round].short) + '</div><div class="pg-word ' + wordSize(w) + '">' + esc(w) + '</div>';
      } else {
        var c = t.cur;
        card.innerHTML = c ? '<div class="pg-cat"><span aria-hidden="true">' + esc(c.i) + '</span> ' + esc(c.c) + ' · ' + ['', 'easy', 'medium', 'hard'][c.d] + '</div><div class="pg-word ' + wordSize(c.w) + '">' + esc(c.w) + '</div>' : '<div class="pg-word">—</div>';
      }
      if (S.cd <= 0) { card.classList.remove('in'); void card.offsetWidth; card.classList.add('in'); }
    }
    var got, skips;
    if (fb) {
      got = t.got.length; skips = t.skips;
      st.innerHTML = '<span><b>' + got + '</b> got</span><span>bowl <b>' + g.bowl.length + '</b>/' + g.slips.length + '</span><span>' +
        (g.cfg.skips < 0 ? 'skips ∞' : 'skips <b>' + Math.max(0, g.cfg.skips - skips) + '</b> left') + '</span>';
      var sb = m.querySelector('[data-k="skip"]');
      if (sb) sb.disabled = S.cd <= 0 && !fbCanSkip(g);
    } else {
      got = 0; skips = 0;
      t.items.forEach(function (x) { if (x.r === 'got') got++; else if (x.r === 'skip') skips++; });
      st.innerHTML = '<span><b>' + got + '</b> got</span><span><b>' + skips + '</b> skipped</span><span>score <b>' + chTurnScore(t, g.cfg) + '</b></span>';
    }
    var pc = m.querySelector('.pg-pausecard'), tr = m.querySelector('.pg-turn');
    if (pc) pc.hidden = !S.paused;
    if (tr) tr.classList.toggle('paused', !!S.paused);
    var ts = m.querySelector('.pg-tiltst');
    if (ts) ts.textContent = S.tilt ? (S.tilt.live ? '📱 tilt on' : '📱 waiting for tilt…') : '';
  }

  function chReviewHtml() {
    var g = S.g, t = g.turn, sc = chTurnScore(t, g.cfg), team = g.teams[t.team];
    var last = g.ti === g.teams.length - 1 && g.round === g.cfg.rounds;
    var next = last ? 'See results ▸' : 'Next: ' + esc(g.teams[(g.ti + 1) % g.teams.length].name) + ' ▸';
    return '<div class="pg-card">' + title('TIME!') +
      '<div class="pg-pass-team">' + teamTag(t.team, team.name) + '</div>' +
      '<div class="pg-big">' + (sc > 0 ? '+' : '') + sc + '</div><div class="pg-sub">' + (sc === 1 ? 'point' : 'points') + ' this turn</div>' +
      (t.items.length ? '<div class="pg-note">tap a word to fix it</div><div class="pg-words">' + t.items.map(function (x, i) {
        var mk = x.r === 'got' ? '✓' : x.r === 'skip' ? '✗' : '⏱';
        return '<button type="button" class="pg-wi ' + x.r + '" data-act="ch-fix" data-i="' + i + '"><b>' + mk + '</b> ' + esc(x.w) + '</button>';
      }).join('') + '</div>' : '<p class="pg-c">No words this turn.</p>') +
      btn('ch-next', next, '', ' data-focus') + '</div>';
  }
  function overHtml(list, isTeams, rows, extra) {
    var st = standings(list), w = st.filter(function (x) { return x.rank === 1; });
    var head = w.length > 1 ? 'It\'s a tie!' : (isTeams ? 'Team ' : '') + esc(w[0].name) + ' wins!';
    return '<div class="pg-card">' + title('GAME OVER') +
      '<pre class="pg-art win" aria-hidden="true">  ___________\n \'._==_==_=_.\'\n .-\\:      /-.\n| (|:.     |) |\n \'-|:.     |-\'\n   \\::.    /\n    \'::. .\'\n      ) (\n    _.\' \'._\n   `"""""""`</pre>' +
      '<div class="pg-win">' + head + '</div>' + scoreTable(list, isTeams) + (rows || '') + (extra || '') +
      '<div class="pg-btns">' + btn('home', 'Home', 'alt') + btn('again', 'Play again ▸', '', ' data-focus') + '</div></div>';
  }
  function chOverHtml() {
    var g = S.g, b = g.best;
    var rows = '<div class="pg-stats">' + g.teams.map(function (t, i) { return '<div>' + teamTag(i, t.name) + '<span>' + plural(t.got, 'word') + ' got · ' + t.skip + ' skipped</span></div>'; }).join('') +
      (b && b.got ? '<div class="pg-note">best turn: ' + plural(b.got, 'word') + ' by ' + esc(g.teams[b.team].name) + '</div>' : '') + '</div>';
    return overHtml(g.teams, true, rows, S.newRecs && S.newRecs.length ? '<div class="pg-new">new record: ' + esc(S.newRecs.join(', ')) + '</div>' : '');
  }

  // ---------- Fishbowl ----------
  function fbSetupHtml() {
    var c = S.save.cfg.fb;
    return '<div class="pg-card wide">' + title('FISHBOWL') +
      sec('Teams', teamsEditor(c.teams, 2, 4, 'fb-team')) +
      '<div class="pg-two">' +
      sec('Players', stepper('fb-players', c.players, 4, MAX_PLAYERS)) +
      sec('Slips each', stepper('fb-slips', c.slips, 2, 5)) + '</div>' +
      '<div class="pg-two">' +
      sec('Turn timer', '<div class="pg-seg">' + FB_SECS.map(function (s) { return chip('fb-secs', s, s + 's', c.secs === s); }).join('') + '</div>') +
      sec('Skips per turn', '<div class="pg-seg">' + FB_SKIPS.map(function (s) { return chip('fb-skips', s, s < 0 ? '∞' : String(s), c.skips === s); }).join('') + '</div>') + '</div>' +
      sec('The bowl', '<div class="pg-seg">' + chip('fb-deck', '0', '✍ Write our own', !c.deck) + chip('fb-deck', '1', '🎲 Fill from the deck', c.deck) + '</div>' +
        '<div class="pg-note">' + (c.deck ? plural(c.players * c.slips, 'slip') + ' from the charades deck — no writing, start now.' : 'Each player writes ' + plural(c.slips, 'slip') + ' in secret: ' + plural(c.players * c.slips, 'slip') + ' in all.') + '</div>') +
      '<div class="pg-btns">' + btn('home', 'Back', 'alt') + btn('fb-start', 'Next ▸', '', ' data-focus') + '</div></div>';
  }
  function stepper(f, v, min, max) {
    return '<div class="pg-step"><button type="button" class="pg-chip" data-act="' + f + '" data-v="-1" aria-label="fewer"' + (v <= min ? ' disabled' : '') + '>−</button>' +
      '<b>' + v + '</b><button type="button" class="pg-chip" data-act="' + f + '" data-v="1" aria-label="more"' + (v >= max ? ' disabled' : '') + '>+</button></div>';
  }
  function fbPassHtml() {
    var g = S.g, i = g.entry, t = fbTeamOf(i, g.T);
    return '<div class="pg-card pass">' + title('PASS') +
      '<div class="pg-sub">Slips: player ' + (i + 1) + ' of ' + g.cfg.players + '</div>' +
      '<div class="pg-bowl" aria-hidden="true">' + bowlArt(g.slips.length) + '</div>' +
      '<p class="pg-c">Hand the phone to the next player' + (i ? '' : ' — anyone can go first') + '.<br>Write your slips where nobody can see.</p>' +
      '<div class="pg-pass-team">' + teamTag(t, g.teams[t].name) + '</div>' +
      btn('fb-write', 'I\'m ready — show me', 'big', ' data-focus') +
      '<div class="pg-foot"><button type="button" class="pg-lnk" data-act="quit">quit game</button><span>' + plural(g.slips.length, 'slip') + ' in the bowl</span></div></div>';
  }
  function bowlArt(n) {
    var dots = Math.min(13, Math.ceil(n / 3)), fill = new Array(dots + 1).join('o') + new Array(14 - dots).join(' ');
    return '<pre class="pg-art">\\' + fill + '/\n \\___________/</pre>';
  }
  function fbEntryHtml() {
    var g = S.g, e = S.entry, i = g.entry;
    var slips = '';
    for (var k = 0; k < g.cfg.slips; k++) {
      slips += '<div class="pg-slip"><span class="pg-sn">' + (k + 1) + '</span><input class="pg-in" type="text" maxlength="' + SLIP_MAX + '" data-f="slip" data-i="' + k + '" value="' + esc(e.words[k] || '') + '" placeholder="a person, place or thing" autocomplete="off" autocapitalize="sentences" enterkeyhint="next"' + (e.bad === k ? ' aria-invalid="true"' : '') + '>' +
        '<button type="button" class="pg-x dice" data-act="fb-dice" data-i="' + k + '" title="Random idea" aria-label="Random idea for slip ' + (k + 1) + '">🎲</button></div>';
    }
    return '<div class="pg-card wide">' + title('YOUR SLIPS') +
      '<div class="pg-sub">Player ' + (i + 1) + ' of ' + g.cfg.players + ' · keep them secret</div>' +
      sec('Your name', '<input class="pg-in" type="text" maxlength="' + NAME_MAX + '" data-f="pname" value="' + esc(e.name) + '" placeholder="Player ' + (i + 1) + '" autocomplete="off" autocapitalize="words" enterkeyhint="next" data-focus>') +
      sec('Your team', '<div class="pg-seg">' + g.teams.map(function (t, j) { return chip('fb-pteam', j, esc(t.name), e.team === j, ' data-tc="' + (j % 6) + '"'); }).join('') + '</div>') +
      sec('Slips <i>the same ones are used in all 3 rounds</i>', slips) +
      '<div class="pg-btns">' + btn('fb-cancel-entry', 'Back', 'alt') + btn('fb-drop', 'Into the bowl ▸') + '</div></div>';
  }
  function fbBowlHtml() {
    var g = S.g;
    var per = g.teams.map(function (t, j) { return '<div>' + teamTag(j, t.name) + '<span>' + fbDescribers(g, j).map(function (p) { return esc(g.players[p].name); }).join(', ') + '</span></div>'; }).join('');
    return '<div class="pg-card">' + title('BOWL READY') +
      '<div class="pg-bowl" aria-hidden="true">' + bowlArt(g.slips.length) + '</div>' +
      '<div class="pg-big">' + g.slips.length + '</div><div class="pg-sub">slips in the bowl</div>' +
      '<div class="pg-stats">' + per + '</div>' + btn('fb-round-go', 'Start round 1 ▸', '', ' data-focus') + '</div>';
  }
  function fbRoundIntroHtml() {
    var g = S.g, r = FB_ROUNDS[g.round];
    return '<div class="pg-card pass">' + title('ROUND ' + (g.round + 1)) +
      '<div class="pg-round">' + esc(r.name.toUpperCase()) + '</div><p class="pg-c">' + esc(r.rule) + '</p>' +
      (g.carry > 0 ? '<p class="pg-c pg-tip">' + teamTag(g.ti, g.teams[g.ti].name) + ' carries over <b>' + g.carry + 's</b> from the last round.</p>' : '') +
      btn('fb-ready', 'Continue ▸', '', ' data-focus') + '</div>';
  }
  function fbReadyHtml() {
    var g = S.g, ds = fbDescribers(g, g.ti), p = g.carryP >= 0 ? g.carryP : ds[g.pn[g.ti] % ds.length];
    return '<div class="pg-card pass">' + title('PASS') +
      '<div class="pg-sub">Round ' + (g.round + 1) + ': ' + esc(FB_ROUNDS[g.round].name) + ' · ' + plural(g.bowl.length, 'slip') + ' left</div>' +
      '<div class="pg-pass-team">' + teamTag(g.ti, g.teams[g.ti].name) + '</div>' +
      '<div class="pg-round">' + esc(g.players[p].name) + '</div>' +
      '<p class="pg-c">' + esc(FB_ROUNDS[g.round].rule) + '<br>Your team guesses — everyone else, hush!</p>' +
      btn('fb-go', 'Tap when ready' + (g.carry > 0 ? ' (' + g.carry + 's)' : ''), 'big', ' data-focus') +
      scoreTable(g.teams, true, g.ti) +
      '<div class="pg-foot"><button type="button" class="pg-lnk" data-act="quit">quit game</button><span>' + g.cfg.secs + 's turns</span></div></div>';
  }
  function fbReviewHtml() {
    var e = S.lastTurn, g = S.g, team = g.teams[e.team];
    var why = e.end === 'bowl' ? (e.carry > 0 ? 'The bowl is empty! ' + e.carry + 's carry into the next round.' : 'The bowl is empty!') : 'Time!';
    var nx = g.over ? 'See results ▸' : e.roundOver ? 'Round ' + (g.round + 1) + ' ▸' : 'Next: ' + esc(g.teams[g.ti].name) + ' ▸';
    return '<div class="pg-card">' + title(e.end === 'bowl' ? 'EMPTY BOWL' : 'TIME!') +
      '<div class="pg-pass-team">' + teamTag(e.team, team.name) + ' <span class="pg-who">' + esc(g.players[e.player].name) + '</span></div>' +
      '<div class="pg-big">+' + e.got + '</div><div class="pg-sub">' + why + '</div>' +
      (S.lastWords.length ? '<div class="pg-words">' + S.lastWords.map(function (w) { return '<span class="pg-wi got"><b>✓</b> ' + esc(w) + '</span>'; }).join('') + '</div>' : '') +
      (e.roundOver ? '<div class="pg-h c">round ' + (e.round + 1) + ' scores</div><div class="pg-stats">' + g.teams.map(function (t, j) { return '<div>' + teamTag(j, t.name) + '<span>+' + t.rs[e.round] + ' this round · ' + t.score + ' total</span></div>'; }).join('') + '</div>' : '') +
      btn('fb-next', nx, '', ' data-focus') + '</div>';
  }
  function fbOverHtml() {
    var g = S.g, b = g.best;
    var rows = '<div class="pg-stats">' + g.teams.map(function (t, j) { return '<div>' + teamTag(j, t.name) + '<span>' + t.rs.join(' / ') + '</span></div>'; }).join('') +
      '<div class="pg-note">points per round: describe / one word / act</div>' +
      (b && b.got ? '<div class="pg-note">best turn: ' + plural(b.got, 'slip') + ' — ' + esc(g.players[b.player].name) + '</div>' : '') + '</div>';
    return overHtml(g.teams, true, rows, S.newRecs && S.newRecs.length ? '<div class="pg-new">new record: ' + esc(S.newRecs.join(', ')) + '</div>' : '');
  }

  // ---------- Hot Seat ----------
  function hsSetupHtml() {
    var c = S.save.cfg.hs, filled = c.players.length;
    return '<div class="pg-card wide">' + title('HOT SEAT') +
      sec('Players <i>' + filled + ' · ' + HS_MIN + ' to ' + HS_MAX + '</i>', '<div class="pg-teams">' + c.players.map(function (n, i) {
        return '<div class="pg-team"><span class="pg-sn">' + (i + 1) + '</span><input class="pg-in" type="text" maxlength="' + NAME_MAX + '" data-f="hs-player" data-i="' + i + '" value="' + esc(n) + '" placeholder="Player ' + (i + 1) + '" autocomplete="off" autocapitalize="words" enterkeyhint="next"' + (i ? '' : ' data-focus') + '>' +
          (c.players.length > HS_MIN ? '<button type="button" class="pg-x" data-act="hs-del" data-i="' + i + '" aria-label="Remove player ' + (i + 1) + '">×</button>' : '') + '</div>';
      }).join('') + (c.players.length < HS_MAX ? '<button type="button" class="pg-lnk add" data-act="hs-add">+ add player</button>' : '') + '</div>') +
      sec('Question decks', '<div class="pg-chips">' + HS_DECKS.map(function (d) { return chip('hs-deck', d, d.charAt(0).toUpperCase() + d.slice(1) + ' <i>' + ((DATA.hotseat[d] || []).length) + '</i>', c.decks.indexOf(d) >= 0); }).join('') + '</div>') +
      '<div class="pg-two">' +
      sec('Turns each', '<div class="pg-seg">' + [1, 2, 3].map(function (l) { return chip('hs-laps', l, String(l), c.laps === l); }).join('') + '</div>') +
      sec('Answers', '<div class="pg-seg">' + chip('hs-secret', '1', 'Typed', c.secret) + chip('hs-secret', '0', 'Out loud', !c.secret) + '</div>') + '</div>' +
      '<div class="pg-btns">' + btn('home', 'Back', 'alt') + btn('hs-start', 'Start ▸') + '</div></div>';
  }
  function hsPassHtml() {
    var g = S.g, p = g.players[hsSeat(g)];
    return '<div class="pg-card pass">' + title('HOT SEAT') +
      '<div class="pg-sub">Turn ' + (g.oi + 1) + ' of ' + g.order.length + '</div>' +
      '<div class="pg-round">' + esc(p.name) + '</div>' +
      '<p class="pg-c">' + (g.cfg.secret ? 'Pass the phone to <b>' + esc(p.name) + '</b>.<br>Only they look at the next screen!' : '<b>' + esc(p.name) + '</b> is in the hot seat.<br>Read the question out loud.') + '</p>' +
      btn('hs-show', g.cfg.secret ? 'I\'m ' + esc(p.name) + ' — show me' : 'Show the question', 'big', ' data-focus') +
      scoreTable(g.players, false, hsSeat(g)) +
      '<div class="pg-foot"><button type="button" class="pg-lnk" data-act="quit">quit game</button><span>' + plural(g.players.length, 'player') + '</span></div></div>';
  }
  function hsSecretHtml() {
    var g = S.g, p = g.players[hsSeat(g)];
    return '<div class="pg-card">' + title('SECRET') +
      '<div class="pg-sub">' + esc(p.name) + ', only you!</div>' +
      '<div class="pg-q">' + esc(g.q) + '</div>' +
      '<input class="pg-in big" type="text" maxlength="' + ANSWER_MAX + '" data-f="hs-ans" value="' + esc(S.ans || '') + '" placeholder="your answer" autocomplete="off" enterkeyhint="done" data-focus>' +
      '<div class="pg-btns">' + btn('hs-newq', 'Other question', 'alt') + btn('hs-lock', 'Lock it in ▸') + '</div></div>';
  }
  function hsAskHtml() {
    var g = S.g, p = g.players[hsSeat(g)];
    return '<div class="pg-card">' + title('GUESS') +
      '<div class="pg-sub">Show everyone · ' + esc(p.name) + ' is in the hot seat</div>' +
      '<div class="pg-q">' + esc(g.q) + '</div>' +
      '<p class="pg-c">' + (g.cfg.secret ? 'Everybody else: what did <b>' + esc(p.name) + '</b> answer? Go round and guess out loud.' : 'Everybody else guesses first — then <b>' + esc(p.name) + '</b> says the real answer.') + '</p>' +
      '<div class="pg-btns">' + (g.cfg.secret ? '' : btn('hs-newq2', 'Other question', 'alt')) + btn('hs-reveal', g.cfg.secret ? 'Reveal ▸' : 'Who got it? ▸', '', ' data-focus') + '</div></div>';
  }
  function hsRevealHtml() {
    var g = S.g, seat = hsSeat(g), p = g.players[seat];
    return '<div class="pg-card">' + title('REVEAL') +
      '<div class="pg-sub">' + esc(g.q) + '</div>' +
      (g.cfg.secret ? '<div class="pg-ans">' + (g.answer ? esc(g.answer) : '<i>(no answer typed — ' + esc(p.name) + ', tell them!)</i>') + '</div>' : '') +
      '<p class="pg-c">' + esc(p.name) + ': tap everyone who got it right.</p>' +
      '<div class="pg-chips c">' + g.players.map(function (q, i) { return i === seat ? '' : chip('hs-pick', i, esc(q.name), S.picks.indexOf(i) >= 0); }).join('') + '</div>' +
      '<div class="pg-note pg-hsnote">' + (S.picks.length ? '+1 each · +1 for ' + esc(p.name) : 'nobody? then nobody scores') + '</div>' +
      btn('hs-score', 'Score & next ▸', '', ' data-focus') + '</div>';
  }
  function hsOverHtml() {
    var g = S.g;
    return overHtml(g.players, false, '', S.newRecs && S.newRecs.length ? '<div class="pg-new">new record: ' + esc(S.newRecs.join(', ')) + '</div>' : '');
  }

  // ---------- quick decks ----------
  function deckList(kind) { return kind === 'wyr' ? DATA.wyr : kind === 'nhie' ? DATA.nhie : DATA.mlt; }
  function deckHtml() {
    var d = S.deck, list = deckList(d.kind), idx = d.order[d.i], m = MODES.filter(function (x) { return x.id === d.kind; })[0];
    var body;
    if (d.kind === 'wyr') {
      var q = parseWyr(list[idx]), tot = d.a + d.b;
      body = '<div class="pg-q sm">Would you rather…</div><div class="pg-wyr">' +
        ['a', 'b'].map(function (k) {
          var n = d[k], pct = tot ? Math.round(100 * n / tot) : 0;
          return '<button type="button" class="pg-opt ' + k + (tot && n === Math.max(d.a, d.b) && d.a !== d.b ? ' lead' : '') + '" data-act="wyr-vote" data-v="' + k + '">' +
            '<span class="pg-ol">' + k.toUpperCase() + '</span><span class="pg-ot">' + esc(q[k]) + '</span>' +
            '<span class="pg-oc">' + (tot ? n + ' · ' + pct + '%' : 'tap per hand') + '</span><span class="pg-ob" style="width:' + pct + '%"></span></button>';
        }).join('<div class="pg-or">or</div>') + '</div>' +
        (tot ? '<button type="button" class="pg-lnk" data-act="wyr-clear">clear the count</button>' : '');
    } else if (d.kind === 'nhie') {
      body = '<div class="pg-q sm">Never have I ever…</div><div class="pg-word deck ' + wordSize(list[idx]) + '">' + esc(list[idx]) + '</div>' +
        '<button type="button" class="pg-go big" data-act="nhie-have">I have! <b>' + d.a + '</b></button>';
    } else {
      body = '<div class="pg-q sm">Who\'s most likely to…</div><div class="pg-word deck ' + wordSize(list[idx]) + '">' + esc(list[idx]) + '?</div>' +
        '<div class="pg-mltcd" aria-live="assertive"></div>' +
        '<button type="button" class="pg-go big" data-act="mlt-count">3 · 2 · 1 · point!</button>';
    }
    return '<div class="pg-card deck">' + title(m.name.toUpperCase()) +
      '<div class="pg-deckbody">' + body + '</div>' +
      '<div class="pg-btns">' + btn('deck-prev', '◂ Back', 'alt', d.i ? '' : ' disabled') + btn('deck-next', 'Next card ▸', '', ' data-focus') + '</div>' +
      '<div class="pg-foot"><button type="button" class="pg-lnk" data-act="home">all games</button><span>card ' + (d.i + 1) + ' / ' + list.length + '</span><button type="button" class="pg-lnk" data-act="deck-shuffle">shuffle</button></div></div>';
  }

  function loadingHtml() { return '<div class="pg-card">' + title('LOADING') + '<p class="pg-c">Shuffling the decks…</p></div>'; }
  function errorHtml() { return '<div class="pg-card">' + title('OOPS') + '<p class="pg-c">The word decks could not be loaded. Check your connection once, then they work offline.</p>' + btn('retry', 'Try again') + '</div>'; }

  var SCREENS = {
    loading: loadingHtml, error: errorHtml, home: homeHtml, help: helpHtml,
    'ch-setup': chSetupHtml, 'ch-ready': chReadyHtml, 'ch-turn': function () { return turnHtml('ch'); }, 'ch-review': chReviewHtml, 'ch-over': chOverHtml,
    'fb-setup': fbSetupHtml, 'fb-pass': fbPassHtml, 'fb-entry': fbEntryHtml, 'fb-bowl': fbBowlHtml, 'fb-round': fbRoundIntroHtml,
    'fb-ready': fbReadyHtml, 'fb-turn': function () { return turnHtml('fb'); }, 'fb-review': fbReviewHtml, 'fb-over': fbOverHtml,
    'hs-setup': hsSetupHtml, 'hs-pass': hsPassHtml, 'hs-secret': hsSecretHtml, 'hs-ask': hsAskHtml, 'hs-reveal': hsRevealHtml, 'hs-over': hsOverHtml,
    deck: deckHtml
  };

  // ================= the turn clock =================
  function inTurn() { return !!S && (S.scr === 'ch-turn' || S.scr === 'fb-turn') && S.g && S.g.turn && !S.g.turn.done; }
  function running() { return inTurn() && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!running()) return;
    var dt = S.last ? Math.min(0.25, (ts - S.last) / 1000) : 0;
    S.last = ts;
    var g = S.g, t = g.turn;
    if (S.cd > 0) {
      var before = Math.ceil(S.cd);
      S.cd -= dt;
      if (S.cd <= 0) { S.cd = 0; sfx('go'); buzz(20); }
      else if (Math.ceil(S.cd) !== before) sfx('count');
    } else {
      var prev = Math.ceil(t.left);
      var up = g.kind === 'fishbowl' ? fbTick(g, dt) : chTick(g, dt);
      if (up) { timeUp(); return; }
      var c = Math.ceil(t.left);
      if (c !== prev && c <= 5 && c > 0) { sfx('tick'); buzz(4); }
    }
    paintTurn();
    S.raf = requestAnimationFrame(frame);
  }
  function startTurnClock() {
    S.cd = S.rm ? 1 : 3; S.paused = false;
    S.turnTotal = S.g.turn.left;
    sfx('count');
    if (S.g.kind === 'charades' && S.g.cfg.tilt && S.canTilt) startTilt();
    kick();
  }
  function timeUp() {
    stopTilt();
    sfx('buzz'); buzz(60);
    var card = S.main.querySelector('.pg-wcard');
    if (card) card.classList.add('bad');
    paintTurn();
    var g = S.g;
    S.lock = true;
    setTimeout(function () { if (S) { S.lock = false; afterTurn(); } }, S.rm ? 300 : 900);
    if (g.kind === 'fishbowl') saveGame();
  }
  function afterTurn() {
    var g = S.g;
    if (!g || !g.turn || !g.turn.done) return;
    if (g.kind === 'charades') go('ch-review');
    else {
      S.lastWords = g.turn.got.slice();
      var e = fbCommit(g);
      S.lastTurn = e;
      if (e && recordTurn(S.save, 'fb', e.got, g.players[e.player].name)) { toast('New record turn: ' + plural(e.got, 'slip') + '!', 'success'); persist(); }
      saveGame();
      go('fb-review');
    }
  }
  function mark(res) {
    if (!inTurn() || S.paused || S.cd > 0 || S.lock) return;
    var g = S.g, ok;
    if (g.kind === 'fishbowl') {
      if (res === 'got') { ok = fbGot(g) != null; } else { ok = fbSkip(g); if (!ok) { sfx('tap'); flashBtn('skip', 'no'); return; } }
    } else ok = !!chMark(g, res);
    if (!ok) return;
    if (res === 'got') { sfx('got'); buzz(12); pop('+1', 'got'); } else { sfx('skip'); buzz(6); pop(g.kind === 'charades' && g.cfg.penalty ? '-1' : 'skip', 'skip'); }
    flashBtn(res, 'on');
    if (g.kind === 'fishbowl' && g.turn.done) { paintTurn(); stopTilt(); sfx('win'); S.lock = true; setTimeout(function () { if (S) { S.lock = false; afterTurn(); } }, S.rm ? 200 : 700); return; }
    paintTurn();
  }
  function flashBtn(k, cls) {
    var b = S.main.querySelector('[data-k="' + k + '"]');
    if (!b) return;
    b.classList.remove(cls); void b.offsetWidth; b.classList.add(cls);
    setTimeout(function () { if (b) b.classList.remove(cls); }, 220);
  }
  function pop(txt, cls) {
    var card = S.main.querySelector('.pg-wcard');
    if (!card || S.rm) return;
    var el = document.createElement('div');
    el.className = 'pg-pop ' + cls; el.textContent = txt;
    card.appendChild(el);
    setTimeout(function () { el.remove(); }, 700);
    card.classList.remove('good', 'meh'); void card.offsetWidth; card.classList.add(cls === 'got' ? 'good' : 'meh');
  }
  function confetti() {
    if (S.rm) return;
    var fx = S.fx, chars = '*+o.x#~', cls = ['pg-c0', 'pg-c1', 'pg-c2', 'pg-c3', 'pg-c4', 'pg-c5'];
    for (var i = 0; i < 46; i++) {
      var s = document.createElement('span');
      s.className = 'pg-conf ' + cls[i % 6];
      s.textContent = chars.charAt(i % chars.length);
      s.style.left = (Math.random() * 100) + '%';
      s.style.animationDelay = (Math.random() * 0.6) + 's';
      s.style.animationDuration = (1.6 + Math.random() * 1.4) + 's';
      s.style.setProperty('--dx', (Math.random() * 80 - 40) + 'px');
      fx.appendChild(s);
    }
    clearTimeout(S.confT);
    S.confT = setTimeout(function () { if (S) S.fx.innerHTML = ''; }, 3600);
  }
  function pause() {
    if (!S || !inTurn() || S.paused) return;
    S.paused = true; stopLoop(); stopTilt(); paintTurn(); syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    if (S.g.kind === 'charades' && S.g.cfg.tilt && S.canTilt) startTilt();
    paintTurn(); syncHead(); kick();
  }

  // ---- tilt ----
  function startTilt() {
    if (!S || S.tilt) return;
    S.tilt = { st: tiltNew(), live: false, t0: now() };
    S.onOri = function (e) {
      if (!S || !S.tilt) return;
      if (e.beta == null) return;
      if (!S.tilt.live) { S.tilt.live = true; paintTurn(); }
      if (S.cd > 0 || S.paused || S.lock) { S.tilt.st.armed = false; tiltStep(S.tilt.st, e.beta, e.gamma); return; }
      var r = tiltStep(S.tilt.st, e.beta, e.gamma);
      if (r) mark(r);
    };
    window.addEventListener('deviceorientation', S.onOri);
    clearTimeout(S.tiltT);
    S.tiltT = setTimeout(function () { if (S && S.tilt && !S.tilt.live && inTurn()) toast('No tilt sensor answered — use the buttons'); }, 2500);
  }
  function stopTilt() {
    if (!S || !S.tilt) return;
    window.removeEventListener('deviceorientation', S.onOri);
    clearTimeout(S.tiltT);
    S.tilt = null;
  }
  // iOS asks for motion permission; it must be requested inside the tap.
  function askTilt(cb) {
    var D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === 'function') {
      try {
        D.requestPermission().then(function (r) { if (r !== 'granted') toast('Tilt not allowed — use the buttons'); cb(); }, function () { cb(); });
      } catch (e) { cb(); }
    } else cb();
  }

  // ================= actions =================
  function newGameFrom(kind) {
    var cfg = S.save.cfg;
    if (kind === 'ch') {
      var pool = buildPool(S.cats, cfg.ch.cats, cfg.ch.diff, S.save.used, { rs: seed() });
      if (!pool.length) { toast('No words for that mix — pick more categories'); return; }
      S.g = newCharades(cfg.ch, pool, seed());
      S.newRecs = null; saveGame(); go('ch-ready');
    } else if (kind === 'fb') {
      S.g = newFishbowl(cfg.fb, seed());
      S.newRecs = null;
      if (cfg.fb.deck) {
        var words = [];
        S.cats.forEach(function (c) { if (c.id !== 'actions' && c.id !== 'feelings' && c.id !== 'phrases') c.words.forEach(function (x) { if (x.d > 1) words.push(x.w); }); });
        fbFillFromDeck(S.g, words);
        fbBegin(S.g); saveGame(); go('fb-bowl');
      } else { saveGame(); S.entry = null; go('fb-pass'); }
    } else if (kind === 'hs') {
      var qs = hotseatPool(DATA, cfg.hs.decks, { rs: seed() });
      S.g = newHotSeat(cfg.hs, qs, seed());
      S.newRecs = null; hsQuestion(S.g); saveGame(); go('hs-pass');
    }
  }
  function finish() {
    var g = S.g;
    S.newRecs = recordGame(S.save, g);
    persist();
    sdel(GAME_KEY);
    sfx('win'); buzz(30);
    go(g.kind === 'charades' ? 'ch-over' : g.kind === 'fishbowl' ? 'fb-over' : 'hs-over');
    confetti();
  }
  function resumeSaved() {
    var g = S.saved;
    S.saved = null;
    if (!g) return;
    S.g = g; S.newRecs = null;
    if (g.over) { finish(); return; }
    if (g.kind === 'charades') go('ch-ready');
    else if (g.kind === 'fishbowl') {
      if (g.phase === 'entry') {
        S.entry = null;
        if (g.entry >= g.cfg.players && !fbBegin(g)) fbUndoLast(g);
        go(g.phase === 'play' ? 'fb-bowl' : 'fb-pass');
      }
      else go('fb-ready');
    } else { hsQuestion(g); go('hs-pass'); }
  }
  function openDeck(kind) {
    var list = deckList(kind);
    S.deck = { kind: kind, order: deckOrder(list.length, seed()), i: 0, a: 0, b: 0 };
    go('deck');
  }
  function deckStep(d) {
    var dk = S.deck, n = deckList(dk.kind).length;
    if (dk.i + d < 0) return;
    dk.i += d;
    if (dk.i >= n) { dk.order = deckOrder(n, seed()); dk.i = 0; toast('Deck shuffled — round two!'); }
    dk.a = 0; dk.b = 0;
    clearInterval(S.mltT); S.mltT = 0;
    sfx('tap');
    render();
    var c = S.main.querySelector('.pg-deckbody');
    if (c && !S.rm) { c.classList.remove('in'); void c.offsetWidth; c.classList.add('in'); }
  }
  function mltCount() {
    if (S.mltT) return;
    var el = S.main.querySelector('.pg-mltcd'), n = 3;
    if (!el) return;
    function show() {
      if (!S || !el.isConnected) { clearInterval(S && S.mltT); if (S) S.mltT = 0; return; }
      el.textContent = n > 0 ? String(n) : 'POINT!';
      el.className = 'pg-mltcd on' + (n > 0 ? '' : ' point');
      if (n > 0) sfx('count'); else { sfx('go'); buzz(25); clearInterval(S.mltT); S.mltT = 0; }
      n--;
    }
    show();
    S.mltT = setInterval(show, S.rm ? 500 : 800);
  }

  // Take the last player's slips back out of the bowl (they rewrite them on another team).
  function fbUndoLast(g) {
    var pi = g.players.length - 1;
    if (pi < 0) return;
    g.phase = 'entry'; g.players.pop(); g.entry = g.players.length;
    g.slips = g.slips.filter(function (x) { return x.by !== pi; });
  }
  function readEntryInputs() {
    if (!S.entry) return;
    S.main.querySelectorAll('[data-f="slip"]').forEach(function (inp) { S.entry.words[+inp.getAttribute('data-i')] = inp.value; });
    var n = S.main.querySelector('[data-f="pname"]');
    if (n) S.entry.name = n.value;
  }
  function randomIdea(exclude) {
    var all = [];
    S.cats.forEach(function (c) { if (c.id !== 'feelings') c.words.forEach(function (x) { if (x.d > 1) all.push(x.w); }); });
    for (var k = 0; k < 40; k++) {
      var w = all[Math.floor(Math.random() * all.length)];
      if (!fbHas(S.g, w) && exclude.indexOf(wordKey(w)) < 0) return w;
    }
    return all[0];
  }

  function act(a, b) {
    if (!S) return;
    var v = b.getAttribute('data-v'), i = int(b.getAttribute('data-i'), -1), cfg = S.save.cfg, g = S.g;
    S.snd.ensure();
    switch (a) {
      case 'retry': start(); return;
      case 'home': S.g = null; S.deck = null; S.saved = normGame(loadJSON(GAME_KEY)); go('home'); return;
      case 'mode':
        sfx('tap');
        if (v === 'ch') go('ch-setup'); else if (v === 'fb') go('fb-setup'); else if (v === 'hs') go('hs-setup'); else openDeck(v);
        return;
      case 'help-close': go(S.helpBack || 'home'); return;
      case 'resume-game': sfx('tap'); resumeSaved(); return;
      case 'drop-game': S.saved = null; sdel(GAME_KEY); render(); return;
      case 'again':
        if (!g) return go('home');
        newGameFrom(g.kind === 'charades' ? 'ch' : g.kind === 'fishbowl' ? 'fb' : 'hs'); return;
      case 'quit':
        if (S.quitArm) {
          S.quitArm = false; stopLoop(); stopTilt(); S.paused = false;
          sdel(GAME_KEY); S.g = null; S.saved = null; go('home'); return;
        }
        S.quitArm = true; b.textContent = 'tap again to quit'; b.classList.add('danger');
        setTimeout(function () { if (S) S.quitArm = false; if (b.isConnected) { b.textContent = 'quit game'; b.classList.remove('danger'); } }, 2500);
        return;

      // charades setup
      case 'ch-team-add': cfg.ch.teams.push(TEAM_NAMES[cfg.ch.teams.length % 6]); persist(); render(); focusLast('ch-team'); return;
      case 'ch-team-del': cfg.ch.teams.splice(i, 1); persist(); render(); return;
      case 'ch-cat-all': cfg.ch.cats = []; persist(); render(); return;
      case 'ch-cat':
        var k = cfg.ch.cats.indexOf(v);
        if (k >= 0) cfg.ch.cats.splice(k, 1); else cfg.ch.cats.push(v);
        if (cfg.ch.cats.length === S.cats.length) cfg.ch.cats = [];
        persist(); render(); return;
      case 'ch-diff': cfg.ch.diff = v; persist(); render(); return;
      case 'ch-secs': cfg.ch.secs = +v; persist(); render(); return;
      case 'ch-rounds': cfg.ch.rounds = +v; persist(); render(); return;
      case 'ch-penalty': cfg.ch.penalty = !cfg.ch.penalty; persist(); render(); return;
      case 'ch-tilt': cfg.ch.tilt = !cfg.ch.tilt; persist(); render(); return;
      case 'ch-start': S.save.cfg.ch = normChCfg(cfg.ch); persist(); sfx('go'); newGameFrom('ch'); return;
      case 'ch-go':
        if (!g || g.kind !== 'charades') return;
        var begin = function () { if (!S || S.g !== g) return; chStart(g); go('ch-turn'); startTurnClock(); };
        if (g.cfg.tilt && S.canTilt) askTilt(begin); else begin();
        return;
      case 'ch-fix': chToggle(g.turn, i); sfx('tap'); render(); return;
      case 'ch-next':
        var t = g.turn, words = [];
        t.items.forEach(function (x) { words.push(x.w); });
        var tname = g.teams[t.team].name;
        var e = chCommit(g);
        noteUsed(S.save, words);
        if (e && recordTurn(S.save, 'ch', e.got, tname)) toast('New record turn: ' + plural(e.got, 'word') + '!', 'success');
        persist(); saveGame();
        if (g.over) finish(); else go('ch-ready');
        return;
      case 'end-turn':
        if (!inTurn()) return;
        if (S.endArm) { S.endArm = false; S.paused = false; stopLoop(); if (g.kind === 'fishbowl') fbEndEarly(g); else chEndEarly(g); timeUp(); return; }
        S.endArm = true; b.textContent = 'tap again to end the turn'; b.classList.add('danger');
        setTimeout(function () { if (S) S.endArm = false; if (b.isConnected) { b.textContent = 'end turn'; b.classList.remove('danger'); } }, 2500);
        return;
      case 'resume': resume(); return;

      // fishbowl
      case 'fb-team-add': cfg.fb.teams.push(TEAM_NAMES[cfg.fb.teams.length % 6]); persist(); render(); focusLast('fb-team'); return;
      case 'fb-team-del': cfg.fb.teams.splice(i, 1); persist(); render(); return;
      case 'fb-players': cfg.fb.players = clamp(cfg.fb.players + (+v), 4, MAX_PLAYERS); persist(); render(); return;
      case 'fb-slips': cfg.fb.slips = clamp(cfg.fb.slips + (+v), 2, 5); persist(); render(); return;
      case 'fb-secs': cfg.fb.secs = +v; persist(); render(); return;
      case 'fb-skips': cfg.fb.skips = +v; persist(); render(); return;
      case 'fb-deck': cfg.fb.deck = v === '1'; persist(); render(); return;
      case 'fb-start':
        if (cfg.fb.players < cfg.fb.teams.length * 2) { toast('Need at least 2 players per team'); return; }
        S.save.cfg.fb = normFbCfg(cfg.fb); persist(); sfx('go'); newGameFrom('fb'); return;
      case 'fb-write':
        S.entry = { name: '', team: fbTeamOf(g.entry, g.T), words: [], bad: -1 };
        sfx('tap'); go('fb-entry'); return;
      case 'fb-pteam': readEntryInputs(); S.entry.team = +v; render(); return;
      case 'fb-dice':
        readEntryInputs();
        var ex = S.entry.words.map(wordKey);
        S.entry.words[i] = randomIdea(ex); S.entry.bad = -1;
        sfx('tap'); render();
        return;
      case 'fb-cancel-entry': S.entry = null; go('fb-pass'); return;
      case 'fb-drop':
        readEntryInputs();
        var ws = [];
        for (var wi = 0; wi < g.cfg.slips; wi++) ws.push(S.entry.words[wi] || '');
        var res = fbAddPlayer(g, S.entry.name, S.entry.team, ws);
        if (!res.ok) {
          S.entry.bad = res.at != null ? res.at : -1;
          toast(res.err === 'dup' ? 'That one is already in the bowl — try another' : 'Fill in every slip (🎲 for an idea)');
          sfx('skip'); render();
          var bad = S.main.querySelector('[aria-invalid="true"]');
          if (bad) try { bad.focus(); } catch (er) {}
          return;
        }
        S.entry = null; sfx('got'); buzz(10);
        if (g.entry >= g.cfg.players) {
          if (!fbBegin(g)) { fbUndoLast(g); saveGame(); toast('Every team needs a player — last player, pick the empty team'); go('fb-pass'); return; }
          saveGame(); go('fb-bowl');
        } else { saveGame(); go('fb-pass'); }
        return;
      case 'fb-round-go': go('fb-round'); return;
      case 'fb-ready': go('fb-ready'); return;
      case 'fb-go':
        if (!g || g.kind !== 'fishbowl') return;
        fbStart(g); go('fb-turn'); startTurnClock(); return;
      case 'fb-next':
        if (g.over) { finish(); return; }
        if (S.lastTurn && S.lastTurn.roundOver) go('fb-round'); else go('fb-ready');
        return;

      // hot seat
      case 'hs-add': cfg.hs.players.push(''); persist(); render(); focusLast('hs-player'); return;
      case 'hs-del': cfg.hs.players.splice(i, 1); persist(); render(); return;
      case 'hs-deck':
        var dk = cfg.hs.decks.indexOf(v);
        if (dk >= 0) { if (cfg.hs.decks.length > 1) cfg.hs.decks.splice(dk, 1); } else cfg.hs.decks.push(v);
        persist(); render(); return;
      case 'hs-laps': cfg.hs.laps = +v; persist(); render(); return;
      case 'hs-secret': cfg.hs.secret = v === '1'; persist(); render(); return;
      case 'hs-start':
        if (cfg.hs.players.length < HS_MIN) { toast('Need at least ' + HS_MIN + ' players'); return; }
        S.save.cfg.hs = normHsCfg(cfg.hs); persist(); sfx('go'); newGameFrom('hs'); return;
      case 'hs-show': S.ans = ''; S.picks = []; sfx('tap'); go(g.cfg.secret ? 'hs-secret' : 'hs-ask'); return;
      case 'hs-newq': case 'hs-newq2': hsQuestion(g); S.ans = ''; sfx('tap'); render(); return;
      case 'hs-lock':
        var inp = S.main.querySelector('[data-f="hs-ans"]');
        hsSetAnswer(g, inp ? inp.value : S.ans);
        if (!g.answer) { toast('Type an answer first (or pick another question)'); if (inp) try { inp.focus(); } catch (er) {} return; }
        try { if (document.activeElement) document.activeElement.blur(); } catch (er) {}
        sfx('got'); go('hs-ask'); return;
      case 'hs-reveal': S.picks = []; sfx('reveal'); buzz(15); go('hs-reveal'); return;
      case 'hs-pick':
        var pk = S.picks.indexOf(+v);
        if (pk >= 0) S.picks.splice(pk, 1); else S.picks.push(+v);
        sfx('tap');
        b.classList.toggle('on', pk < 0); b.setAttribute('aria-pressed', pk < 0 ? 'true' : 'false');
        var hn = S.main.querySelector('.pg-hsnote');
        if (hn) hn.textContent = S.picks.length ? '+1 each · +1 for ' + g.players[hsSeat(g)].name : 'nobody? then nobody scores';
        return;
      case 'hs-score':
        var r = hsAward(g, S.picks);
        if (r && r.ok.length) { sfx('got'); buzz(12); } else sfx('skip');
        S.picks = [];
        if (g.over) { finish(); return; }
        hsQuestion(g); saveGame(); go('hs-pass'); return;

      // decks
      case 'deck-next': deckStep(1); return;
      case 'deck-prev': deckStep(-1); return;
      case 'deck-shuffle': S.deck.order = deckOrder(S.deck.order.length, seed()); S.deck.i = 0; S.deck.a = S.deck.b = 0; sfx('tap'); render(); toast('Shuffled'); return;
      case 'wyr-vote': S.deck[v === 'b' ? 'b' : 'a']++; sfx('tap'); buzz(5); render(); return;
      case 'wyr-clear': S.deck.a = S.deck.b = 0; render(); return;
      case 'nhie-have': S.deck.a++; sfx('tap'); buzz(5); render(); return;
      case 'mlt-count': mltCount(); return;
    }
  }
  function focusLast(f) {
    var ins = S.main.querySelectorAll('[data-f="' + f + '"]');
    var el = ins[ins.length - 1];
    if (el) { try { el.focus(); if (el.select) el.select(); } catch (e) {} }
  }
  function onInput(e) {
    var t = e.target, f = t.getAttribute && t.getAttribute('data-f');
    if (!f || !S) return;
    var i = int(t.getAttribute('data-i'), 0), cfg = S.save.cfg;
    if (f === 'ch-team') { cfg.ch.teams[i] = t.value.slice(0, NAME_MAX); persistSoon(); }
    else if (f === 'fb-team') { cfg.fb.teams[i] = t.value.slice(0, NAME_MAX); persistSoon(); }
    else if (f === 'hs-player') {
      cfg.hs.players[i] = t.value.slice(0, NAME_MAX); persistSoon();
      var hd = S.main.querySelector('.pg-sec .pg-h i');
    }
    else if (f === 'slip' && S.entry) { S.entry.words[i] = t.value; if (S.entry.bad === i) { S.entry.bad = -1; t.removeAttribute('aria-invalid'); } }
    else if (f === 'pname' && S.entry) S.entry.name = t.value;
    else if (f === 'hs-ans') S.ans = t.value;
  }
  function persistSoon() { clearTimeout(S.persistT); S.persistT = setTimeout(persist, 300); }
  // Enter in a field moves to the next field (or presses the main button).
  function onFieldKey(e) {
    if (e.key !== 'Enter' || e.isComposing) return;
    var t = e.target;
    if (!t || !t.matches || !t.matches('input.pg-in')) return;
    e.preventDefault();
    var ins = Array.prototype.slice.call(S.main.querySelectorAll('input.pg-in')), k = ins.indexOf(t);
    if (k >= 0 && k < ins.length - 1) { try { ins[k + 1].focus(); } catch (er) {} return; }
    if (/-setup$/.test(S.scr)) { try { t.blur(); } catch (er) {} return; }
    var main = S.main.querySelector('.pg-btns .pg-go:not(.alt)');
    if (main) main.click();
  }

  // ================= keys =================
  function typing(el) { return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable); }
  function onKey(e) {
    if (!S || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;     // parked in the dock: keys belong to the editor
    var ae = document.activeElement;
    if (typing(e.target) || typing(ae)) return;
    // only when the panel (or nothing) has focus — never steal the editor's typing
    if (ae && ae !== document.body && !S.panel.contains(ae)) return;
    var k = e.key;
    if (inTurn()) {
      if (k === 'p' || k === 'P' || k === 'Escape') { e.preventDefault(); if (S.paused) resume(); else pause(); return; }
      if (S.paused) { if (k === ' ' || k === 'Enter') { e.preventDefault(); resume(); } return; }
      if (k === 'ArrowRight' || k === 'Enter' || k === ' ') { e.preventDefault(); mark('got'); return; }
      if (k === 'ArrowLeft' || k === 's' || k === 'S' || k === 'Backspace') { e.preventDefault(); mark('skip'); return; }
      return;
    }
    if (S.scr === 'deck') {
      if (k === 'ArrowRight' || (k === ' ' && !(ae && ae.tagName === 'BUTTON'))) { e.preventDefault(); deckStep(1); return; }
      if (k === 'ArrowLeft') { e.preventDefault(); deckStep(-1); return; }
      if (S.deck.kind === 'wyr' && (k === 'a' || k === 'b')) { e.preventDefault(); S.deck[k]++; sfx('tap'); render(); }
    }
  }

  // ================= header =================
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]'), hm = S.head.querySelector('[data-h="home"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = !inTurn();
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
    hm.disabled = S.scr === 'home' || S.scr === 'loading';
  }
  function helpKey() {
    var s = S.scr;
    if (s === 'deck') return S.deck.kind;
    if (s.indexOf('ch-') === 0) return 'ch';
    if (s.indexOf('fb-') === 0) return 'fb';
    if (s.indexOf('hs-') === 0) return 'hs';
    return 'home';
  }

  // ================= open / close =================
  function teardown() {
    if (!S) return;
    var s = S;
    stopTilt();
    try { settleTurn(); } catch (e) {}
    S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.persistT); clearTimeout(s.confT); clearInterval(s.mltT);
    try { s.save && sset(SAVE_KEY, JSON.stringify(s.save)); } catch (e) {}
    document.removeEventListener('keydown', s.onKey);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    s.snd.close();
  }
  // Closing on a turn's review screen: bank that turn, so reopening carries on with the next team.
  function settleTurn() {
    var g = S.g, t = g && g.turn;
    if (!t || !t.done || g.over) return;
    if (g.kind === 'charades') {
      noteUsed(S.save, t.items.map(function (x) { return x.w; }));
      var tn = g.teams[t.team].name, e = chCommit(g);
      if (e) recordTurn(S.save, 'ch', e.got, tn);
    } else if (g.kind === 'fishbowl') {
      var fe = fbCommit(g);
      if (fe) recordTurn(S.save, 'fb', fe.got, g.players[fe.player].name);
    } else return;
    if (g.over) { recordGame(S.save, g); sdel(GAME_KEY); } else saveGame();
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
  }
  function start() {
    S.scr = 'loading'; render();
    loadData().then(function () {
      if (!S) return;
      S.cats = parseCharades(DATA);
      S.saved = normGame(loadJSON(GAME_KEY));
      if (S.firstRun) { S.helpFor = 'home'; S.helpBack = 'home'; go('help'); }
      else go('home');
    }, function () { if (S) go('error'); });
  }

  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="pg"><div class="pg-main"></div><div class="pg-fx" aria-hidden="true"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🎉 Party Games', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'pg-hb';
    hb.innerHTML = '<button type="button" data-h="home" title="All games" aria-label="All games">' + IC_HOME + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var rawSave = loadJSON(SAVE_KEY), mm = window.matchMedia;
    var coarse = !!(mm && mm('(pointer: coarse)').matches);
    S = {
      panel: p, head: hb, main: p.querySelector('.pg-main'), fx: p.querySelector('.pg-fx'),
      save: normSave(rawSave), firstRun: !rawSave, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: coarse,
      canTilt: coarse && typeof window.DeviceOrientationEvent !== 'undefined',
      scr: 'loading', g: null, deck: null, entry: null, saved: null, cats: [], picks: [], ans: '',
      paused: false, cd: 0, raf: 0, last: 0, lock: false, tilt: null, barCols: 30, lastWords: []
    };
    if (S.firstRun) persist();
    p._onClose = teardown;

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { pause(); };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) { pause(); stopLoop(); } });
    p.addEventListener('cade-panel-restore', function () { if (S && S.panel === p) render(); });

    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); sfx('tap');
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') {
        if (S.scr === 'help') { go(S.helpBack || 'home'); }
        else if (inTurn()) { pause(); toast('Paused — ' + (HELP[helpKey()] || HELP.home)[0].toLowerCase() + ': got it → / skip ←'); }
        else if (S.scr !== 'loading' && S.scr !== 'error') { S.helpFor = helpKey(); S.helpBack = S.scr; go('help'); }
      } else if (h === 'home') {
        if (S.scr === 'home' || S.scr === 'loading') return;
        if (S.g && !S.g.over) {
          if (inTurn()) pause();
          if (!S.homeArm) { S.homeArm = true; toast('Tap home again to leave — your game is kept'); setTimeout(function () { if (S) S.homeArm = false; }, 2500); return; }
          S.homeArm = false; stopLoop(); stopTilt(); S.paused = false;
          if (S.g.turn) S.g.turn = null;
          saveGame();
        }
        S.g = null; S.deck = null; S.saved = normGame(loadJSON(GAME_KEY)); go('home');
      }
      try { b.blur(); } catch (er) {}
    });

    // Rapid tapping must never zoom, select, magnify or open a callout (CSS does
    // most of it). The Got it / Skip pad answers on pointerdown and cancels its
    // touches; the panel swallows gesture / dblclick events.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    function onPlaySurface(e) { return e.target.closest && e.target.closest('[data-k], .pg-wcard, .pg-opt, .pg-mltcd'); }
    S.main.addEventListener('touchstart', function (e) { if (onPlaySurface(e)) noTouch(e); }, { passive: false });
    S.main.addEventListener('touchend', function (e) {
      var el = onPlaySurface(e);
      if (!el) return;
      noTouch(e);
      // a cancelled touchend makes no click: fire the tap ourselves for vote buttons
      var b = e.target.closest('[data-act]');
      if (b && !b.disabled && el === b) act(b.getAttribute('data-act'), b);
    }, { passive: false });
    S.main.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-k]') : null;
      if (!b || e.button > 0 || b.disabled) return;
      e.preventDefault();
      S.snd.ensure();
      mark(b.getAttribute('data-k'));
    });
    S.main.addEventListener('contextmenu', function (e) { if (onPlaySurface(e)) e.preventDefault(); });
    S.main.addEventListener('click', function (e) {
      if (!S) return;
      var k = e.target.closest ? e.target.closest('[data-k]') : null;
      if (k) { if (e.detail === 0) mark(k.getAttribute('data-k')); return; }    // keyboard activation
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b || b.disabled) return;
      act(b.getAttribute('data-act'), b);
    });
    S.main.addEventListener('input', onInput);
    S.main.addEventListener('keydown', onFieldKey);

    // Colours are theme CSS variables only (no canvas), so a [data-theme] switch needs no work here.
    start();
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Charades, Fishbowl, Hot Seat and quick decks — teams, timers and scores; pass the phone around',
    icon: '🎉',
    tags: 'game,party,charades,fishbowl,hot seat,would you rather,never have i ever,most likely to,group,teams,timer,family',
    open: open,
    _engine: ENGINE
  });
})();
