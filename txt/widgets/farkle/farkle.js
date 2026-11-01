/* Farkle — push-your-luck dice for Cade.txt.
 * Two games in one panel:
 *  - FARKLE: six dice. Roll, set aside at least one scoring die (1s, 5s,
 *    three-or-more of a kind, a 1-6 straight, three pairs ...), then roll the
 *    rest again or bank the turn's points. A roll with nothing that scores is a
 *    FARKLE and the turn's points are lost. Score with all six and you have HOT
 *    DICE: roll all six again. First to the target (10,000) sets the final
 *    round; everyone else gets one more turn to beat it. House rules (the
 *    scoring table, an entry minimum, the three-farkle penalty) live in Rules.
 *  - PIG: one die. Roll as often as you like, adding each roll; roll a 1 and
 *    the turn is gone. Hold to bank. First to 100 wins.
 * Seats: you vs 1-5 computer players (cautious / balanced / reckless, playing
 * expected-value heuristics), or 2-6 people pass-and-play, or any mix.
 * Drawn as monospace ASCII dice in the DOM; the dice tumble when rolled.
 * The game in progress, rules, records and the sound toggle persist in
 * Cade.store (cade-farkle-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var RISKS = ['cautious', 'balanced', 'reckless'];
  // mul: how much a CPU trusts the value of rolling on (EV of rolling × mul vs banking).
  var RISK = {
    cautious: { name: 'Cautious', mul: 0.86, edge: 60, pig: 15 },
    balanced: { name: 'Balanced', mul: 1.0, edge: 0, pig: 20 },
    reckless: { name: 'Reckless', mul: 1.22, edge: -60, pig: 27 }
  };
  var DEF_RULES = {
    target: 10000, entry: 0, triple1: 1000, multi: 'double', straight: 1500, threePairs: 1500,
    fourPair: 0, twoTriples: 0, penalty: 1000, pigTarget: 100
  };
  var RULE_OPTS = {
    target: [2500, 5000, 10000], entry: [0, 350, 500, 1000], triple1: [1000, 300], multi: ['double', 'add', 'fixed'],
    straight: [1500, 1000, 2500, 0], threePairs: [1500, 750, 500, 0], fourPair: [0, 1500], twoTriples: [0, 2500],
    penalty: [0, 500, 1000], pigTarget: [50, 100, 200]
  };
  var RULE_KEYS = Object.keys(DEF_RULES);
  var MAX_PLAYERS = 6;

  function normRules(r) {
    var o = {};
    r = r && typeof r === 'object' ? r : {};
    RULE_KEYS.forEach(function (k) { o[k] = RULE_OPTS[k].indexOf(r[k]) >= 0 ? r[k] : DEF_RULES[k]; });
    return o;
  }
  function ruleSig(R) { return RULE_KEYS.map(function (k) { return R[k]; }).join('|'); }

  // Small seeded PRNG (mulberry32); the state lives in the game so a save resumes exactly.
  function rngStep(s) {
    var a = (s + 0x6D2B79F5) | 0, t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return { s: a >>> 0, v: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
  }
  function rnd(g) { var r = rngStep(g.rs); g.rs = r.s; return r.v; }
  function d6(g) { return 1 + Math.floor(rnd(g) * 6); }

  function counts(vals) {
    var c = [0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < vals.length; i++) c[vals[i]]++;
    return c;
  }
  function kindScore(f, n, R) {
    var base = f === 1 ? R.triple1 : f * 100;
    if (n === 3) return base;
    if (R.multi === 'add') return base * (n - 2);
    if (R.multi === 'fixed') return (n - 3) * 1000;
    return base * Math.pow(2, n - 3);
  }

  // The best way to score EVERY die in a count vector, or null if some die can't score.
  // Parts: { k: 'one'|'kind'|'straight'|'pairs'|'fourpair'|'triples', f, n, s }.
  var MEMO = {};
  function memoFor(R) { var k = ruleSig(R); return MEMO[k] || (MEMO[k] = { dec: {}, tab: null }); }
  function decompose(c, R) { return dec(c.slice(), R, memoFor(R).dec); }
  function dec(c, R, memo) {
    var key = c.join(''), f, n, r, tot = 0;
    if (key in memo) return memo[key];
    for (f = 1; f <= 6; f++) tot += c[f];
    var best = null;
    function consider(s, parts) { if (!best || s > best.s) best = { s: s, p: parts }; }
    if (tot === 0) best = { s: 0, p: [] };
    else {
      if (tot === 6) {
        var sh = c.slice(1).filter(function (x) { return x; }).sort(function (a, b) { return b - a; }).join('');
        if (sh === '111111' && R.straight) consider(R.straight, [{ k: 'straight', s: R.straight }]);
        if (sh === '222' && R.threePairs) consider(R.threePairs, [{ k: 'pairs', s: R.threePairs }]);
        if (sh === '42' && R.fourPair) consider(R.fourPair, [{ k: 'fourpair', s: R.fourPair }]);
        if (sh === '33' && R.twoTriples) consider(R.twoTriples, [{ k: 'triples', s: R.twoTriples }]);
      }
      f = 1; while (!c[f]) f++;
      if (f === 1 || f === 5) {
        c[f]--; r = dec(c, R, memo); c[f]++;
        if (r) consider(r.s + (f === 1 ? 100 : 50), [{ k: 'one', f: f, s: f === 1 ? 100 : 50 }].concat(r.p));
      }
      for (n = 3; n <= c[f]; n++) {
        c[f] -= n; r = dec(c, R, memo); c[f] += n;
        if (r) { var ks = kindScore(f, n, R); consider(r.s + ks, [{ k: 'kind', f: f, n: n, s: ks }].concat(r.p)); }
      }
    }
    memo[key] = best;
    return best;
  }
  function scoreVals(vals, R) { var d = decompose(counts(vals), R); return d ? d.s : 0; }
  // Does anything in this roll score?
  function anyScore(c, R) {
    var tot = 0, f;
    if (c[1] || c[5]) return true;
    for (f = 1; f <= 6; f++) { if (c[f] >= 3) return true; tot += c[f]; }
    if (tot !== 6) return false;
    var pairs = 0, ones = 0;
    for (f = 1; f <= 6; f++) { if (c[f] === 2) pairs++; if (c[f] === 1) ones++; }
    return (ones === 6 && !!R.straight) || (pairs === 3 && !!R.threePairs);
  }
  // Every scoring sub-multiset of a roll: [{ k: counts, n, s, p }], best score first.
  function options(c, R) {
    var out = [], k = [0, 0, 0, 0, 0, 0, 0];
    (function rec(f) {
      if (f > 6) {
        var n = k[1] + k[2] + k[3] + k[4] + k[5] + k[6];
        if (!n) return;
        var d = decompose(k, R);
        if (d && d.s > 0) out.push({ k: k.slice(), n: n, s: d.s, p: d.p });
        return;
      }
      for (var i = 0; i <= c[f]; i++) { k[f] = i; rec(f + 1); }
      k[f] = 0;
    })(1);
    out.sort(function (a, b) { return b.s - a.s || a.n - b.n; });
    return out;
  }
  // Exact odds per number of dice: pF[n] = P(farkle), g[n] = E[best take | it scores].
  function tables(R) {
    var m = memoFor(R);
    if (m.tab) return m.tab;
    var pF = [1], g = [0], fact = [1, 1, 2, 6, 24, 120, 720];
    for (var n = 1; n <= 6; n++) {
      var pf = 0, gs = 0, c = [0, 0, 0, 0, 0, 0, 0];
      (function rec(f, left) {
        if (f === 6) {
          c[6] = left;
          var w = fact[n];
          for (var q = 1; q <= 6; q++) w /= fact[c[q]];
          w /= Math.pow(6, n);
          if (!anyScore(c, R)) pf += w;
          else { var o = options(c, R); gs += w * o[0].s; }
          return;
        }
        for (var i = 0; i <= left; i++) { c[f] = i; rec(f + 1, left - i); }
        c[f] = 0;
      })(1, n);
      pF.push(pf); g.push(pf < 1 ? gs / (1 - pf) : 0);
    }
    m.tab = { pF: pF, g: g };
    return m.tab;
  }

  // ---- a game ----
  function newPlayer(p) {
    return {
      name: String((p && p.name) || 'Player').slice(0, 12), cpu: p && RISK[p.cpu] ? p.cpu : '',
      score: 0, on: false, fk: 0, last: '', st: { turns: 0, farkles: 0, hot: 0, best: 0, rolls: 0 }
    };
  }
  function newTurn(g) { return { pts: 0, dice: [], sel: [], avail: g.mode === 'pig' ? 1 : 6, rolled: false, kept: [], hot: 0, rolls: 0, res: '', gain: 0 }; }
  function newGame(o) {
    o = o || {};
    var g = {
      v: 1, mode: o.mode === 'pig' ? 'pig' : 'farkle', rules: normRules(o.rules),
      players: (o.players && o.players.length ? o.players : [{ name: 'You' }, { name: 'CPU', cpu: 'balanced' }]).slice(0, MAX_PLAYERS).map(newPlayer),
      cur: 0, phase: 'turn', final: -1, winner: -1, round: 1, rs: (o.seed >>> 0) || 1, t: null
    };
    if (g.players.length < 2) g.players.push(newPlayer({ name: 'CPU', cpu: 'balanced' }));
    g.t = newTurn(g);
    return g;
  }
  function target(g) { return g.mode === 'pig' ? g.rules.pigTarget : g.rules.target; }
  function selVals(g) {
    var t = g.t, v = [];
    for (var i = 0; i < t.dice.length; i++) if (t.sel[i]) v.push(t.dice[i]);
    return v;
  }
  // The current selection: { n, s, ok, p } (ok: every selected die scores).
  function selInfo(g) {
    var v = selVals(g);
    if (!v.length) return { n: 0, s: 0, ok: false, p: [] };
    var d = decompose(counts(v), g.rules);
    return d ? { n: v.length, s: d.s, ok: true, p: d.p } : { n: v.length, s: 0, ok: false, p: [] };
  }
  function live(g) { return g.phase === 'turn' && !g.t.res; }
  function canRoll(g) {
    if (!live(g)) return false;
    if (!g.t.rolled || g.mode === 'pig') return true;
    return selInfo(g).ok;
  }
  function canBank(g) {
    if (!live(g) || !g.t.rolled) return false;
    if (g.mode === 'pig') return g.t.pts > 0;
    var si = selInfo(g);
    if (!si.ok) return false;
    return g.players[g.cur].on || g.t.pts + si.s >= g.rules.entry;
  }
  function toggle(g, i) {
    var t = g.t;
    if (g.mode === 'pig' || !live(g) || !t.rolled || i < 0 || i >= t.dice.length) return false;
    t.sel[i] = !t.sel[i];
    return true;
  }
  function setSel(g, idx) {
    var t = g.t;
    t.sel = t.dice.map(function () { return false; });
    idx.forEach(function (i) { if (i >= 0 && i < t.dice.length) t.sel[i] = true; });
  }
  // Indices of the dice matching a count vector (for picking an option out of a roll).
  function idxFor(dice, k) {
    var need = k.slice(), out = [];
    for (var i = 0; i < dice.length; i++) if (need[dice[i]] > 0) { need[dice[i]]--; out.push(i); }
    return out;
  }
  function commitSel(g, banking) {
    var t = g.t, si = selInfo(g), ev = [];
    if (!si.ok) return ev;
    t.pts += si.s;
    t.kept.push({ v: selVals(g).sort(), s: si.s, p: si.p });
    t.avail -= si.n;
    if (t.avail === 0) {
      t.avail = 6;
      if (!banking) { t.hot++; g.players[g.cur].st.hot++; ev.push({ e: 'hot' }); }   // banking all six is not a hot-dice re-roll
    }
    t.dice = []; t.sel = [];
    return ev;
  }
  // Roll the free dice (setting aside the selection first). Returns events.
  function roll(g) {
    if (!canRoll(g)) return [];
    var t = g.t, P = g.players[g.cur], ev = [], i;
    if (g.mode === 'pig') {
      var v = d6(g);
      t.dice = [v]; t.sel = [false]; t.rolled = true; t.rolls++; P.st.rolls++;
      if (v === 1) { ev.push({ e: 'farkle', lost: t.pts }); bust(g, ev); }
      else { t.pts += v; t.gain = v; ev.push({ e: 'roll', v: v }); }
      return ev;
    }
    if (t.rolled) ev = commitSel(g);
    t.dice = []; t.sel = [];
    for (i = 0; i < t.avail; i++) { t.dice.push(d6(g)); t.sel.push(false); }
    t.rolled = true; t.rolls++; P.st.rolls++;
    if (!anyScore(counts(t.dice), g.rules)) { ev.push({ e: 'farkle', lost: t.pts, n: t.avail }); bust(g, ev); }
    else ev.push({ e: 'roll' });
    return ev;
  }
  function bust(g, ev) {
    var P = g.players[g.cur], t = g.t;
    t.res = 'farkle'; t.gain = 0;
    P.fk++; P.st.farkles++; P.st.turns++;
    P.last = 'farkle';
    if (g.mode === 'farkle' && g.rules.penalty && P.fk >= 3) {
      var was = P.score;
      P.score = Math.max(0, P.score - g.rules.penalty);
      P.fk = 0;
      ev.push({ e: 'penalty', n: was - P.score });
      P.last = 'penalty';
    }
  }
  function bank(g) {
    if (!canBank(g)) return [];
    var t = g.t, P = g.players[g.cur], ev = [];
    if (g.mode === 'farkle') ev = commitSel(g, true);
    P.score += t.pts; P.on = true; P.fk = 0; P.st.turns++;
    if (t.pts > P.st.best) P.st.best = t.pts;
    t.res = 'bank'; t.gain = t.pts; P.last = '+' + t.pts;
    ev.push({ e: 'bank', n: t.pts });
    if (P.score >= target(g)) {
      if (g.mode === 'pig') { g.phase = 'over'; g.winner = g.cur; ev.push({ e: 'win', who: g.cur }); }
      else if (g.final < 0) { g.final = g.cur; ev.push({ e: 'final', who: g.cur }); }
    }
    return ev;
  }
  // Highest score; ties go to the player who set the final round (others must BEAT it).
  function leader(g) {
    var b = g.final >= 0 && g.final < g.players.length ? g.final : 0;
    for (var i = 0; i < g.players.length; i++) if (g.players[i].score > g.players[b].score) b = i;
    return b;
  }
  // After a bank / farkle: next seat (or the end of the game).
  function next(g) {
    if (g.phase === 'over') return [];
    if (!g.t.res) return [];
    var n = g.players.length, ev = [];
    g.cur = (g.cur + 1) % n;
    if (g.cur === 0) g.round++;
    if (g.final >= 0 && g.cur === g.final) {
      g.phase = 'over'; g.winner = leader(g);
      ev.push({ e: 'win', who: g.winner });
    }
    g.t = newTurn(g);
    if (g.phase === 'over') g.t.res = 'over';
    return ev;
  }

  // ---- computer players: expected-value heuristics shaded by a risk profile ----
  function cpuPlan(g) {
    var P = g.players[g.cur], risk = RISK[P.cpu] || RISK.balanced, t = g.t, R = g.rules, T = target(g);
    if (!live(g)) return null;
    if (!t.rolled) return { act: 'roll', keep: [] };
    var others = 0, i;
    for (i = 0; i < g.players.length; i++) if (i !== g.cur) others = Math.max(others, g.players[i].score);
    if (g.mode === 'pig') {
      var need = T - P.score, hold = risk.pig;
      if (t.pts >= need) return { act: 'bank', keep: [] };
      if (others >= T - 20 && others > P.score + t.pts) hold = Math.max(hold, Math.min(need, others - P.score + 1));   // they'll win next turn: chase
      else if (others > P.score + 20) hold += Math.round((others - P.score) / 8);
      else if (P.score > others + 30) hold -= 3;
      return { act: t.pts >= hold ? 'bank' : 'roll', keep: [] };
    }
    var tab = tables(R), opts = options(counts(t.dice), R), best = null;
    var mul = risk.mul, finalRace = g.final >= 0 && g.final !== g.cur;
    if (!finalRace && others >= T - 1500 && others > P.score + 1000) mul += 0.12;   // far behind near the end: push
    if (P.score > others + 3000) mul -= 0.06;
    for (i = 0; i < opts.length; i++) {
      var o = opts[i], Tp = t.pts + o.s, rem = t.avail - o.n;
      if (rem === 0) rem = 6;
      var canB = P.on || Tp >= R.entry, bankV = canB ? Tp : -Infinity;
      if (finalRace && P.score + Tp <= others) bankV = -Infinity;          // banking loses anyway
      else if (!finalRace && P.score + Tp >= T) bankV += 400;             // banking sets the final round
      if (finalRace && P.score + Tp > others) bankV += 1e6;               // take the win
      // rolling on: survive with prob 1-pF, then on average gain g; an extra
      // share of g stands for the option to keep going after that.
      var rollV = (1 - tab.pF[rem]) * (Tp + tab.g[rem] * 1.15) * mul - risk.edge;
      var v = Math.max(bankV, rollV), act = bankV >= rollV ? 'bank' : 'roll';
      if (!best || v > best.v + 1e-9 || (Math.abs(v - best.v) < 1e-9 && o.n < best.o.n)) best = { v: v, act: act, o: o };
    }
    if (!best) return null;
    return { act: best.act, keep: idxFor(t.dice, best.o.k), s: best.o.s, p: best.o.p };
  }
  // Play one CPU decision (select + roll/bank). Returns events.
  function cpuStep(g) {
    var pl = cpuPlan(g);
    if (!pl) return [];
    if (g.mode === 'farkle' && g.t.rolled) setSel(g, pl.keep);
    return pl.act === 'bank' && canBank(g) ? bank(g) : roll(g);
  }
  // Headless: everyone plays as a CPU until the game ends (tests, balance checks).
  function simulate(g, maxSteps) {
    for (var s = 0; s < (maxSteps || 200000) && g.phase !== 'over'; s++) {
      if (g.t.res) { next(g); continue; }
      var P = g.players[g.cur], was = P.cpu;
      if (!was) P.cpu = 'balanced';
      cpuStep(g);
      P.cpu = was;
    }
    return g;
  }

  // ---- labels ----
  var NUMW = ['', 'one', 'two', 'three', 'four', 'five', 'six'];
  function partLabel(p) {
    if (p.k === 'kind') return NUMW[p.n] + ' ' + p.f + 's';
    if (p.k === 'straight') return 'straight';
    if (p.k === 'pairs') return 'three pairs';
    if (p.k === 'fourpair') return 'four + pair';
    if (p.k === 'triples') return 'two triples';
    return p.f === 1 ? '1' : '5';
  }
  function label(parts) {
    var ones = { 1: 0, 5: 0 }, out = [];
    (parts || []).forEach(function (p) { if (p.k === 'one') ones[p.f]++; else out.push(partLabel(p)); });
    [1, 5].forEach(function (f) { if (ones[f]) out.push(ones[f] > 1 ? f + ' ×' + ones[f] : String(f)); });
    return out.join(' + ');
  }
  function bigCombo(parts) {
    for (var i = 0; i < (parts || []).length; i++) {
      var p = parts[i];
      if (p.k !== 'one' && (p.k !== 'kind' || p.n >= 4)) return partLabel(p);
    }
    return '';
  }

  // ---- saves ----
  function newStats() { return { games: 0, wins: 0, cpu: { cautious: [0, 0], balanced: [0, 0], reckless: [0, 0] }, pp: 0, best: 0, bestGame: 0, farkles: 0, hot: 0, turns: 0, rolls: 0 }; }
  function newSave() {
    return {
      v: 1, rules: normRules(null), mode: 'farkle', speed: 'normal',
      seats: [{ name: 'You', cpu: '' }, { name: 'Ada', cpu: 'balanced' }],
      stats: { farkle: newStats(), pig: newStats() }, game: null
    };
  }
  function num(v, d) { v = +v; return isFinite(v) && v >= 0 ? Math.floor(v) : d; }
  function normStats(s) {
    var o = newStats();
    if (!s || typeof s !== 'object') return o;
    ['games', 'wins', 'pp', 'best', 'bestGame', 'farkles', 'hot', 'turns', 'rolls'].forEach(function (k) { o[k] = num(s[k], 0); });
    RISKS.forEach(function (r) {
      var a = s.cpu && s.cpu[r];
      if (a && a.length === 2) { o.cpu[r] = [num(a[0], 0), num(a[1], 0)]; if (o.cpu[r][1] > o.cpu[r][0]) o.cpu[r][1] = o.cpu[r][0]; }
    });
    if (o.wins > o.games) o.wins = o.games;
    return o;
  }
  function normSeats(a) {
    if (!Array.isArray(a)) return null;
    var out = a.slice(0, MAX_PLAYERS).map(function (s, i) {
      s = s && typeof s === 'object' ? s : {};
      var nm = typeof s.name === 'string' ? s.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 12) : '';
      return { name: nm || 'Player ' + (i + 1), cpu: RISK[s.cpu] ? s.cpu : '' };
    });
    return out.length >= 2 ? out : null;
  }
  function normGame(o) {
    if (!o || typeof o !== 'object' || !Array.isArray(o.players) || o.players.length < 2 || o.players.length > MAX_PLAYERS) return null;
    if (!o.t || typeof o.t !== 'object') return null;
    var g = newGame({ mode: o.mode, rules: o.rules, players: normSeats(o.players), seed: num(o.rs, 1) });
    g.rs = num(o.rs, 1) >>> 0;
    g.players.forEach(function (P, i) {
      var q = o.players[i] || {}, st = q.st || {};
      P.score = num(q.score, 0); P.on = !!q.on || P.score > 0; P.fk = Math.min(2, num(q.fk, 0));
      P.last = typeof q.last === 'string' ? q.last.slice(0, 12) : '';
      ['turns', 'farkles', 'hot', 'best', 'rolls'].forEach(function (k) { P.st[k] = num(st[k], 0); });
    });
    var n = g.players.length;
    g.cur = Math.min(n - 1, num(o.cur, 0));
    g.round = Math.max(1, num(o.round, 1));
    g.final = typeof o.final === 'number' && o.final >= 0 && o.final < n ? o.final : -1;
    if (o.phase === 'over') return null;          // a finished game is not resumed
    // The turn in progress: dice must be 1-6, the free-dice count consistent.
    var t = o.t, nt = newTurn(g), max = g.mode === 'pig' ? 1 : 6;
    var dice = Array.isArray(t.dice) ? t.dice.filter(function (v) { return v === (v | 0) && v >= 1 && v <= 6; }).slice(0, max) : [];
    nt.avail = Math.max(1, Math.min(max, num(t.avail, max)));
    nt.pts = num(t.pts, 0); nt.rolls = num(t.rolls, 0); nt.hot = num(t.hot, 0);
    nt.kept = Array.isArray(t.kept) ? t.kept.filter(function (k) { return k && Array.isArray(k.v); }).slice(0, 40).map(function (k) {
      var v = k.v.filter(function (x) { return x === (x | 0) && x >= 1 && x <= 6; }).slice(0, 6);
      return { v: v, s: num(k.s, 0), p: Array.isArray(k.p) ? k.p : [] };
    }) : [];
    if (t.rolled && dice.length === (g.mode === 'pig' ? 1 : nt.avail) && !t.res) {
      nt.dice = dice; nt.rolled = true;
      nt.sel = dice.map(function (_, i) { return !!(t.sel && t.sel[i]); });
      if (g.mode === 'farkle' && !anyScore(counts(dice), g.rules)) nt = newTurn(g);   // impossible state: restart the turn
    } else if (t.rolled || t.res) nt = newTurn(g);   // corrupt / finished turn: hand on cleanly
    g.t = nt;
    // A turn that already ended (banked or farkled; its score is applied) moves on
    // to the next seat — otherwise reopening the panel would replay the same turn.
    if (t.res === 'bank' || t.res === 'farkle') { g.t.res = t.res; next(g); }
    return g;
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    s.rules = normRules(o.rules);
    s.mode = o.mode === 'pig' ? 'pig' : 'farkle';
    s.speed = o.speed === 'fast' ? 'fast' : 'normal';
    s.seats = normSeats(o.seats) || s.seats;
    if (o.stats && typeof o.stats === 'object') { s.stats.farkle = normStats(o.stats.farkle); s.stats.pig = normStats(o.stats.pig); }
    try { s.game = normGame(o.game); } catch (e) { s.game = null; }
    return s;
  }
  // Fold a finished game into the records (humans only). Returns what changed.
  function settle(save, g) {
    if (!g || g.phase !== 'over' || g.settled) return null;
    g.settled = true;
    var st = save.stats[g.mode], humans = [], cpus = [], out = { win: false, best: false, bestGame: false };
    g.players.forEach(function (P, i) { (P.cpu ? cpus : humans).push(i); });
    if (!humans.length) return out;
    var hardest = '';
    cpus.forEach(function (i) { var r = g.players[i].cpu; if (RISKS.indexOf(r) > RISKS.indexOf(hardest)) hardest = r; });
    st.games++;
    if (!cpus.length) st.pp++;
    var won = humans.indexOf(g.winner) >= 0;
    if (cpus.length && won) st.wins++;
    if (hardest) { st.cpu[hardest][0]++; if (won) st.cpu[hardest][1]++; }
    out.win = won && cpus.length > 0;
    humans.forEach(function (i) {
      var P = g.players[i];
      st.farkles += P.st.farkles; st.hot += P.st.hot; st.turns += P.st.turns; st.rolls += P.st.rolls;
      if (P.st.best > st.best) { st.best = P.st.best; out.best = true; }
      if (P.score > st.bestGame) { st.bestGame = P.score; out.bestGame = true; }
    });
    return out;
  }

  var ENGINE = {
    RISKS: RISKS, RISK: RISK, DEF_RULES: DEF_RULES, RULE_OPTS: RULE_OPTS, MAX_PLAYERS: MAX_PLAYERS,
    normRules: normRules, counts: counts, kindScore: kindScore, decompose: decompose, scoreVals: scoreVals, anyScore: anyScore,
    options: options, tables: tables, newGame: newGame, target: target, selInfo: selInfo, canRoll: canRoll, canBank: canBank,
    toggle: toggle, setSel: setSel, idxFor: idxFor, roll: roll, bank: bank, next: next, leader: leader,
    cpuPlan: cpuPlan, cpuStep: cpuStep, simulate: simulate, label: label, bigCombo: bigCombo, partLabel: partLabel,
    newSave: newSave, normSave: normSave, normGame: normGame, normStats: normStats, settle: settle, rngStep: rngStep
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('farkle.css');

  var PANEL_ID = 'farkle-panel', NAME = 'Farkle';
  var KEY = 'cade-farkle-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var CPU_NAMES = ['Ada', 'Bix', 'Cleo', 'Dot', 'Ezra', 'Fen', 'Gus', 'Hob'];
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.farkle = { live: function () { return S; }, render: function () { render(); } };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() {
    if (!S) return;
    var sv = S.save;
    sv.game = S.g && S.g.phase !== 'over' ? S.g : null;
    sset(SAVE_KEY, JSON.stringify(sv));
  }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function fmt(n) {
    n = Math.round(n);
    var s = String(Math.abs(n)), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }

  // ---- sound: a tiny WebAudio voice, created on a user gesture, off by default ----
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
    tick: function () { S && S.snd.tone(660 + Math.random() * 120, 0.03, 'square', 0.018); },
    clack: function (d) { S && S.snd.tone(180 + Math.random() * 160, 0.04, 'triangle', 0.05, 90, d || 0); },
    pick: function (on) { S && S.snd.tone(on ? 880 : 520, 0.05, 'sine', 0.035); },
    bad: function () { S && S.snd.tone(200, 0.08, 'square', 0.025); },
    bank: function () { if (!S) return; S.snd.tone(784, 0.08, 'triangle', 0.05); S.snd.tone(1047, 0.1, 'triangle', 0.05, 0, 0.07); S.snd.tone(1319, 0.16, 'triangle', 0.045, 0, 0.14); },
    farkle: function () { if (!S) return; S.snd.tone(330, 0.22, 'sawtooth', 0.04, 110); S.snd.tone(165, 0.3, 'square', 0.025, 80, 0.12); },
    hot: function () { if (!S) return; [523, 659, 784, 1047, 1319].forEach(function (f, i) { S.snd.tone(f, 0.09, 'square', 0.03, 0, i * 0.05); }); },
    combo: function () { if (!S) return; S.snd.tone(988, 0.08, 'square', 0.03); S.snd.tone(1480, 0.14, 'square', 0.025, 0, 0.07); },
    win: function () { if (!S) return; [523, 659, 784, 1047, 784, 1047, 1319].forEach(function (f, i) { S.snd.tone(f, 0.14, 'triangle', 0.05, 0, i * 0.1); }); },
    lose: function () { if (!S) return; [392, 330, 262, 196].forEach(function (f, i) { S.snd.tone(f, 0.18, 'triangle', 0.045, 0, i * 0.14); }); }
  };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_MENU = svg('<path d="M4 7h16M4 12h16M4 17h16"/>');

  // ---- ASCII dice ----
  var PIPS = { 0: [], 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  function dieArt(v) {
    var on = {}, rows = ['┌───────┐'], r, c;
    (PIPS[v] || []).forEach(function (k) { on[k] = 1; });
    for (r = 0; r < 3; r++) {
      var line = '│';
      for (c = 0; c < 3; c++) line += ' ' + (on[r * 3 + c] ? '<i>●</i>' : (v ? ' ' : (r === 1 && c === 1 ? '<u>?</u>' : ' ')));
      rows.push(line + ' │');
    }
    rows.push('└───────┘');
    return rows.join('\n');
  }

  // ---- rendering ----
  function cur() { return S.g.players[S.g.cur]; }
  function humanTurn() { return S.g && S.g.phase === 'turn' && !cur().cpu; }
  function humans() { return S.g.players.filter(function (p) { return !p.cpu; }).length; }
  // "Ada banks" but "You bank"
  function vb(P, v) { return /^you$/i.test(P.name) ? v.replace(/es$/, 'e').replace(/s$/, '') : v; }
  function riskTag(r) { return r ? RISK[r].name : ''; }
  function bar(score, tgt, extra) {
    var N = 10, a = Math.min(N, Math.floor(N * score / tgt)), b = Math.min(N - a, Math.floor(N * (score + extra) / tgt) - a), s = '';
    for (var i = 0; i < N; i++) s += i < a ? '<b>■</b>' : i < a + b ? '<i>■</i>' : '·';
    return s;
  }
  function renderBoard() {
    var g = S.g, T = target(g), h = '', lead = leader(g);
    g.players.forEach(function (P, i) {
      var me = i === g.cur && g.phase === 'turn', extra = me && !g.t.res ? g.t.pts : 0;
      var last = P.last === 'farkle' ? '<em class="bad">farkle</em>' : P.last === 'penalty' ? '<em class="bad">−' + fmt(g.rules.penalty) + '</em>' : P.last ? '<em>' + esc(/^\+\d+$/.test(P.last) ? '+' + fmt(+P.last.slice(1)) : P.last) + '</em>' : '';
      var tag = P.cpu ? '<span class="fk-tag">' + esc(riskTag(P.cpu)) + '</span>' : '';
      var fks = g.mode === 'farkle' && g.rules.penalty && P.fk ? '<span class="fk-fk" title="farkles in a row">' + new Array(P.fk + 1).join('✗') + '</span>' : '';
      var crown = g.phase === 'over' ? i === g.winner : g.final === i;
      crown = crown ? '<span class="fk-crown">' + (g.phase === 'over' ? '★' : '⚑') + '</span>' : '';
      h += '<div class="fk-seat' + (me ? ' on' : '') + (i === lead && P.score > 0 ? ' lead' : '') + '">' +
        '<div class="fk-sn"><span class="fk-arrow">' + (me ? '▶' : '') + '</span><span class="fk-nm">' + esc(P.name) + '</span>' + crown + tag + '</div>' +
        '<div class="fk-sc"><b>' + fmt(P.score) + '</b>' + (extra ? '<span class="fk-plus">+' + fmt(extra) + '</span>' : '') + '</div>' +
        '<div class="fk-bar">' + bar(P.score, T, extra) + '</div>' +
        '<div class="fk-last">' + (g.mode === 'farkle' && !P.on && g.rules.entry ? '<i>needs ' + g.rules.entry + '</i> ' : '') + last + fks + '</div></div>';
    });
    S.board.innerHTML = h;
    S.board.className = 'fk-board n' + g.players.length;
  }
  function renderKept() {
    var g = S.g, t = g.t, h = '';
    if (g.mode === 'farkle') {
      t.kept.forEach(function (k) {
        h += '<span class="fk-grp" title="' + esc(label(k.p)) + '">';
        k.v.forEach(function (v) { h += '<span class="fk-mini">' + v + '</span>'; });
        h += '<small>' + fmt(k.s) + '</small></span>';
      });
      if (t.hot) h += '<span class="fk-hotn">🔥×' + t.hot + '</span>';
    } else if (t.rolls) {
      h += '<span class="fk-pigrolls">' + t.rolls + ' roll' + (t.rolls === 1 ? '' : 's') + '</span>';
    }
    var tp = t.res === 'farkle' ? '<s>' + fmt(t.pts) + '</s>' : fmt(t.pts);
    S.kept.innerHTML = '<div class="fk-tray">' + (h || '<span class="fk-empty">' + (g.mode === 'pig' ? 'roll a 1 and the turn is lost' : 'set-aside dice land here') + '</span>') + '</div>' +
      '<div class="fk-turn"><i>turn</i><b>' + tp + '</b></div>';
  }
  function renderDice() {
    var g = S.g, t = g.t, h = '', n = g.mode === 'pig' ? 1 : 6, i, held = humanTurn() && t.rolled && !t.res && g.mode === 'farkle';
    var cnt = t.rolled ? t.dice.length : t.avail;
    for (i = 0; i < n; i++) {
      var has = i < cnt, v = has && t.rolled ? t.dice[i] : 0, sel = has && t.sel[i];
      var cls = 'fk-die' + (has ? '' : ' gone') + (sel ? ' sel' : '') + (t.res === 'farkle' && has ? ' dead' : '') + (held && has ? ' tap' : '') + (S.cpuSel && S.cpuSel[i] ? ' cpusel' : '');
      h += '<button type="button" class="' + cls + '" data-d="' + i + '"' + (held && has ? '' : ' tabindex="-1"') +
        ' aria-label="' + (has ? (v ? 'die ' + v + (sel ? ', set aside' : '') : 'die') : 'set aside') + '"' + (has ? '' : ' aria-hidden="true"') + '>' +
        '<pre>' + (has ? dieArt(v) : dieArt(0).replace(/<u>\?<\/u>/, ' ')) + '</pre></button>';
    }
    S.dice.innerHTML = h;
    S.dice.className = 'fk-dice' + (g.mode === 'pig' ? ' pig' : '');
    fitDice();
  }
  // Dice size follows the table's width: six in a row, or two rows of three when narrow.
  function fitDice() {
    if (!S) return;
    var W = S.dice.clientWidth || S.table.clientWidth - 16;
    if (!W) return;
    var pig = S.dice.classList.contains('pig'), cols = pig ? 1 : W < 430 ? 3 : 6, gap = 6;
    var fs = Math.floor(((W - gap * (cols - 1)) / cols - 8) / (9 * 0.62));
    fs = Math.max(10, Math.min(pig ? 34 : cols === 3 ? 24 : 22, fs));
    S.dice.classList.toggle('c3', cols === 3);
    S.root.style.setProperty('--fk-ds', fs + 'px');
  }
  // A card taller than the table grows the panel instead of being clipped.
  function fitCard() {
    if (!S) return;
    var c = S.ovl.firstChild;
    S.root.style.minHeight = S.cardKind && c ? (c.offsetHeight + 14) + 'px' : '';
  }
  function renderMsg() {
    var g = S.g, t = g.t, P = cur(), m = '', cls = '';
    if (g.phase === 'over') {
      var W = g.players[g.winner];
      m = '★ ' + esc(W.name) + ' ' + vb(W, 'wins') + ' with ' + fmt(W.score) + ' ★'; cls = 'good';
    } else if (t.res === 'farkle') { m = g.mode === 'pig' ? 'Rolled a 1 — ' + esc(P.name) + ' ' + vb(P, 'loses') + ' ' + fmt(t.pts) : 'FARKLE — ' + esc(P.name) + ' ' + vb(P, 'loses') + ' ' + fmt(t.pts); cls = 'bad'; }
    else if (t.res === 'bank') { m = esc(P.name) + ' ' + vb(P, 'banks') + ' ' + fmt(t.pts); cls = 'good'; }
    else if (P.cpu) m = S.cpuMsg || esc(P.name) + ' is thinking…';
    else if (!t.rolled) {
      m = (humans() > 1 || g.players.length > 2 ? esc(P.name) + ' — ' : '') + (t.hot ? 'hot dice! roll all six' : 'roll ' + (g.mode === 'pig' ? 'the die' : t.avail + ' dice'));
      if (g.final >= 0 && g.final !== g.cur) { var need = g.players[leader(g)].score - P.score + (g.mode === 'pig' ? 1 : 50); m = 'Final turn — beat ' + fmt(g.players[leader(g)].score) + ' (need ' + fmt(Math.max(0, need)) + ')'; cls = 'warn'; }
    } else if (g.mode === 'pig') m = 'Rolled ' + t.dice[0] + ' — roll again or hold ' + fmt(t.pts);
    else {
      var si = selInfo(g);
      if (!si.n) m = 'Tap scoring dice to set them aside';
      else if (!si.ok) { m = 'Not all of those score'; cls = 'bad'; }
      else {
        m = '<b>+' + fmt(si.s) + '</b> ' + esc(label(si.p));
        if (!P.on && t.pts + si.s < g.rules.entry) m += ' <i>· ' + fmt(g.rules.entry) + ' to get on the board</i>';
        cls = 'good';
      }
    }
    S.msg.innerHTML = m;
    S.msg.className = 'fk-msg ' + cls;
  }
  function renderPad() {
    var g = S.g, t = g.t, h;
    if (g.phase === 'over') {
      h = '<button type="button" class="fk-act" data-a="again">play again</button><button type="button" class="fk-act alt" data-a="menu">menu</button>';
    } else if (!humanTurn() || S.anim) {
      var cp = cur().cpu && !S.anim;
      h = '<button type="button" class="fk-act wait" disabled>' + (cp ? esc(cur().name) + '’s turn' : 'rolling…') + '</button>' +
        (cp ? '<button type="button" class="fk-act alt" data-a="ff" title="Faster (F)">' + (S.ff ? '▸▸ fast' : '▸▸') + '</button>' : '');
    } else if (t.res) {
      h = '<button type="button" class="fk-act" data-a="next">next ▸</button>';
    } else if (g.mode === 'pig') {
      h = '<button type="button" class="fk-act" data-a="roll"' + (canRoll(g) ? '' : ' disabled') + '>roll<small>R / Space</small></button>' +
        '<button type="button" class="fk-act bank" data-a="bank"' + (canBank(g) ? '' : ' disabled') + '>hold ' + (t.pts ? '+' + fmt(t.pts) : '') + '<small>B / Enter</small></button>';
    } else {
      var si = selInfo(g), rem = t.rolled ? t.avail - (si.ok ? si.n : 0) : t.avail;
      if (rem === 0) rem = 6;
      var rl = !t.rolled ? 'roll ' + t.avail : 'roll ' + rem + (t.rolled && si.ok && si.n === t.avail ? ' 🔥' : '');
      var bv = t.pts + (si.ok ? si.s : 0);
      h = '<button type="button" class="fk-act" data-a="roll"' + (canRoll(g) ? '' : ' disabled') + '>' + rl + '<small>R / Space</small></button>' +
        '<button type="button" class="fk-act bank" data-a="bank"' + (canBank(g) ? '' : ' disabled') + '>bank' + (t.rolled && bv ? ' +' + fmt(bv) : '') + '<small>B / Enter</small></button>';
      if (t.rolled && !t.res) h += '<button type="button" class="fk-act alt sm" data-a="best" title="Select every scoring die (A)">all<small>A</small></button>';
    }
    S.pad.innerHTML = h;
  }
  function render() {
    if (!S || !S.g) return;
    renderBoard(); renderKept(); if (!S.anim) renderDice(); renderMsg(); renderPad();
    syncHead();
  }
  function syncHead() {
    if (!S) return;
    var b = S.head.querySelector('[data-h="sound"]');
    b.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    b.classList.toggle('on', S.snd.on);
    b.title = S.snd.on ? 'Sound on' : 'Sound off';
    b.setAttribute('aria-label', b.title);
  }
  function say(t) { if (S && S.live) S.live.textContent = t; }

  // ---- juice: floating text, ASCII sparks, a shake ----
  function pop(text, cls) {
    if (!S) return;
    var el = document.createElement('div');
    el.className = 'fk-pop ' + (cls || '');
    el.textContent = text;
    S.table.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1300);
  }
  function sparks(n, cls) {
    if (!S || S.rm) return;
    var ch = '*+.·o×', r = S.table.getBoundingClientRect();
    for (var i = 0; i < n; i++) {
      var el = document.createElement('span'), a = Math.random() * Math.PI * 2, d = 50 + Math.random() * Math.min(160, r.width / 2.4);
      el.className = 'fk-spark ' + (cls || '');
      el.textContent = ch[Math.floor(Math.random() * ch.length)];
      el.style.setProperty('--dx', Math.round(Math.cos(a) * d) + 'px');
      el.style.setProperty('--dy', Math.round(Math.sin(a) * d * 0.7 - 20) + 'px');
      el.style.animationDelay = Math.round(Math.random() * 120) + 'ms';
      S.table.appendChild(el);
      (function (e) { setTimeout(function () { if (e.parentNode) e.parentNode.removeChild(e); }, 1200); })(el);
    }
  }
  function shake() {
    if (!S || S.rm) return;
    S.table.classList.remove('shake'); void S.table.offsetWidth; S.table.classList.add('shake');
  }

  // ---- timers (all cleared on close / pause) ----
  function later(fn, ms) {
    if (!S) return 0;
    var id = setTimeout(function () {
      if (!S) return;
      S.timers = S.timers.filter(function (x) { return x !== id; });
      fn();
    }, ms);
    S.timers.push(id);
    return id;
  }
  function clearTimers() { if (!S) return; S.timers.forEach(clearTimeout); S.timers = []; if (S.animT) { clearInterval(S.animT); S.animT = 0; } }
  function pace(ms) { return S.ff || S.save.speed === 'fast' ? Math.round(ms * 0.4) : ms; }

  // ---- the roll animation: faces flicker, the dice tumble and stop one by one ----
  function animateRoll(done) {
    var g = S.g, t = g.t, n = t.dice.length, els, stopAt = [], start = Date.now(), base = S.rm ? 120 : pace(420), step = S.rm ? 0 : pace(90);
    S.anim = true;
    renderDice();
    renderPad();
    els = S.dice.querySelectorAll('.fk-die');
    for (var i = 0; i < n; i++) { stopAt.push(base + i * step); if (els[i]) { els[i].classList.add('roll'); els[i].style.setProperty('--rot', (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 8) + 'deg'); } }
    SFX.clack(0); SFX.clack(0.05);
    function frame() {
      if (!S) return;
      var el = Date.now() - start, all = true;
      for (var j = 0; j < n; j++) {
        var e = els[j]; if (!e) continue;
        if (el < stopAt[j]) { all = false; e.querySelector('pre').innerHTML = dieArt(1 + Math.floor(Math.random() * 6)); }
        else if (e.classList.contains('roll')) { e.classList.remove('roll'); e.querySelector('pre').innerHTML = dieArt(t.dice[j]); SFX.clack(); }
      }
      if (all) { clearInterval(S.animT); S.animT = 0; S.anim = false; done(); }
    }
    S.animT = setInterval(frame, 55);
    frame();
  }

  // ---- turn flow ----
  function handle(ev) {
    var g = S.g;
    ev.forEach(function (x) {
      if (x.e === 'hot') { pop('HOT DICE!', 'hot'); sparks(22, 'hot'); SFX.hot(); Cade.haptic && Cade.haptic(15); }
      else if (x.e === 'penalty') { later(function () { pop('3 FARKLES −' + fmt(x.n), 'bad'); }, 650); }
      else if (x.e === 'final') { later(function () { pop('FINAL ROUND', 'gold'); }, 500); }
    });
  }
  function afterRoll(ev) {
    var g = S.g, t = g.t, fk = ev.some(function (x) { return x.e === 'farkle'; });
    if (fk) {
      var big = t.pts >= 1000 || (ev[0] && ev[0].n === 6);
      pop(g.mode === 'pig' ? 'PIGGED OUT' : 'FARKLE!', 'bad' + (big ? ' big' : ''));
      shake(); SFX.farkle(); Cade.haptic && Cade.haptic(30);
      say((g.mode === 'pig' ? 'Rolled a 1. ' : 'Farkle. ') + cur().name + ' ' + vb(cur(), 'loses') + ' ' + t.pts);
    } else if (g.mode === 'pig') {
      say('Rolled ' + t.dice[0] + '. Turn total ' + t.pts);
      if (t.dice[0] === 6) pop('+6', 'good small');
    } else {
      var best = options(counts(t.dice), g.rules)[0];
      say('Rolled ' + t.dice.join(' ') + '. Best take ' + best.s);
      var bc = bigCombo(best.p);
      if (bc && (best.s >= 1000 || best.p.some(function (p) { return p.k !== 'kind' && p.k !== 'one'; }))) { pop(bc.toUpperCase() + '!', 'gold'); sparks(12, 'gold'); SFX.combo(); }
    }
    render();
    persist();
    if (t.res) endTurnSoon();
    else if (cur().cpu) later(cpuThink, pace(500));
  }
  function doRoll() {
    var g = S.g;
    if (!S.g || S.anim || !canRoll(g)) { if (S.g && g.t.rolled && !g.t.res && !S.anim) { SFX.bad(); nudge(); } return; }
    var ev = roll(g);
    if (!ev.length) return;
    persist();   // the outcome is saved before the reveal: closing mid-tumble can't undo a farkle
    handle(ev);
    renderBoard(); renderKept(); renderMsg();
    animateRoll(function () { afterRoll(ev); });
  }
  function doBank() {
    var g = S.g;
    if (!g || S.anim || !canBank(g)) {
      if (g && live(g) && g.t.rolled && g.mode === 'farkle' && selInfo(g).ok && !cur().on) { pop('need ' + fmt(g.rules.entry), 'bad small'); SFX.bad(); }
      else if (g && live(g) && g.t.rolled) { SFX.bad(); nudge(); }
      return;
    }
    var ev = bank(g);
    handle(ev);
    pop('+' + fmt(g.t.pts), 'good');
    if (g.t.pts >= 2000) sparks(16, 'gold');
    SFX.bank();
    say(cur().name + ' ' + vb(cur(), 'banks') + ' ' + g.t.pts + ', total ' + cur().score);
    render();
    persist();
    if (g.phase === 'over') finish();
    else endTurnSoon();
  }
  function nudge() {
    var el = S.msg; el.classList.remove('nudge'); void el.offsetWidth; el.classList.add('nudge');
  }
  // A finished turn: show it for a moment, then move on (a human's own result waits for a tap only on farkle).
  function endTurnSoon() {
    var g = S.g, wasCpu = !!cur().cpu, fk = g.t.res === 'farkle';
    later(advance, pace(wasCpu ? (fk ? 1400 : 1150) : (fk ? 1500 : 900)));
  }
  function advance() {
    var g = S.g;
    if (!g || g.phase === 'over' || !g.t.res) return;
    if (S.paused || S.cardKind) { S.advPending = true; return; }
    var ev = next(g);
    S.cpuMsg = ''; S.cpuSel = null; S.ff = false;
    persist();
    if (g.phase === 'over') { render(); finish(); return; }
    render();
    if (ev.length) handle(ev);
    var P = cur();
    if (P.cpu) later(cpuThink, pace(700));
    else {
      if (humans() > 1 && S.lastHuman !== g.cur) showCard('pass');
      S.lastHuman = g.cur;
    }
  }

  // ---- the computer's turn, one decision at a time ----
  function cpuThink() {
    if (!S || S.paused || S.cardKind) { if (S) S.cpuPending = true; return; }
    var g = S.g;
    if (!g || g.phase !== 'turn' || !cur().cpu || g.t.res || S.anim) return;
    var pl = cpuPlan(g);
    if (!pl) return;
    if (!g.t.rolled) { S.cpuMsg = esc(cur().name) + ' rolls ' + g.t.avail + (g.mode === 'pig' ? '' : ' dice'); renderMsg(); doRoll(); return; }
    if (g.mode === 'pig') {
      S.cpuMsg = esc(cur().name) + (pl.act === 'bank' ? ' holds' : ' rolls again');
      renderMsg();
      later(function () { if (pl.act === 'bank') doBank(); else doRoll(); }, pace(450));
      return;
    }
    // show the dice it keeps, then act
    setSel(g, pl.keep);
    S.cpuSel = null;
    var rem = g.t.avail - pl.keep.length;
    S.cpuMsg = esc(cur().name) + ' keeps ' + esc(label(pl.p)) + ' <b>+' + fmt(pl.s) + '</b> · ' + (pl.act === 'bank' ? 'banks' : rem === 0 ? 'hot dice!' : 'rolls ' + rem);
    render();
    SFX.pick(true);
    later(function () { if (pl.act === 'bank') doBank(); else doRoll(); }, pace(1000));
  }
  function resumeCpu() {
    if (!S || !S.g || S.paused || S.cardKind) return;
    if (S.cpuPending) { S.cpuPending = false; if (cur().cpu && !S.anim) later(cpuThink, pace(400)); }
  }

  function finish() {
    var g = S.g, out = settle(S.save, g);
    persist();
    var W = g.players[g.winner], hum = !W.cpu;
    if (hum) { SFX.win(); sparks(30, 'gold'); } else if (humans()) SFX.lose(); else SFX.win();
    later(function () { showCard('over', out); }, pace(900));
  }

  // ---- player actions ----
  function tapDie(i) {
    var g = S.g;
    if (!humanTurn() || S.anim || g.mode !== 'farkle' || !g.t.rolled || g.t.res) return;
    if (i >= g.t.dice.length) return;
    toggle(g, i);
    var on = g.t.sel[i], si = selInfo(g);
    SFX.pick(on);
    if (on && !si.ok && si.n === 1 && !singleCanScore(g, i)) { SFX.bad(); }
    renderDice(); renderMsg(); renderPad(); renderBoard();
  }
  // Can this die be part of SOME scoring selection?
  function singleCanScore(g, i) {
    var v = g.t.dice[i], o = options(counts(g.t.dice), g.rules);
    return o.some(function (x) { return x.k[v] > 0; });
  }
  function selectBest() {
    var g = S.g;
    if (!humanTurn() || S.anim || g.mode !== 'farkle' || !g.t.rolled || g.t.res) return;
    var o = options(counts(g.t.dice), g.rules)[0];
    var all = idxFor(g.t.dice, o.k), same = all.every(function (i) { return g.t.sel[i]; }) && selInfo(g).n === all.length;
    setSel(g, same ? [] : all);
    SFX.pick(!same);
    renderDice(); renderMsg(); renderPad(); renderBoard();
  }
  
  // ---- cards (menu / rules / help / records / pass / results) ----
  function hideCard() {
    if (!S) return;
    S.cardKind = null;
    S.ovl.style.display = 'none'; S.ovl.innerHTML = '';
    S.root.classList.remove('dim');
    fitCard();
    if (!S.g) { showCard('menu'); return; }
    render();
    if (S.advPending && !S.paused) { S.advPending = false; later(advance, 300); }
    else resumeCpu();
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
  }
  function chips(key, opts, val, fmtFn) {
    return '<div class="fk-chips">' + opts.map(function (o) {
      return '<button type="button" class="fk-chip' + (o === val ? ' on' : '') + '" data-k="' + key + '" data-v="' + esc(String(o)) + '">' + esc(fmtFn ? fmtFn(o) : String(o)) + '</button>';
    }).join('') + '</div>';
  }
  function scoreTable(R) {
    var rows = [['single 1', 100], ['single 5', 50], ['three 1s', R.triple1]];
    rows.push(['three 2s … 6s', '200 … 600']);
    var four = R.multi === 'double' ? '×2 the three' : R.multi === 'add' ? '+1 three per die' : '1,000';
    rows.push(['four of a kind', R.multi === 'fixed' ? '1,000' : four + ' (' + fmt(kindScore(2, 4, R)) + ' for 2s)']);
    rows.push(['five of a kind', R.multi === 'fixed' ? '2,000' : fmt(kindScore(2, 5, R)) + ' for 2s']);
    rows.push(['six of a kind', R.multi === 'fixed' ? '3,000' : fmt(kindScore(2, 6, R)) + ' for 2s']);
    if (R.straight) rows.push(['straight 1-6', R.straight]);
    if (R.threePairs) rows.push(['three pairs', R.threePairs]);
    if (R.fourPair) rows.push(['four + a pair', R.fourPair]);
    if (R.twoTriples) rows.push(['two triples', R.twoTriples]);
    return '<pre class="fk-tab">' + rows.map(function (r) {
      var a = r[0], b = typeof r[1] === 'number' ? fmt(r[1]) : r[1];
      return '<b>' + esc(a) + '</b>' + new Array(Math.max(2, 16 - a.length)).join(' ') + '<span>' + esc(b) + '</span>';
    }).join('\n') + '</pre>';
  }
  function seatRows() {
    var seats = S.save.seats, h = '';
    seats.forEach(function (s, i) {
      h += '<div class="fk-srow"><span class="fk-sidx">' + (i + 1) + '</span>' +
        '<input class="fk-in" data-seat="' + i + '" maxlength="12" value="' + esc(s.name) + '" aria-label="Seat ' + (i + 1) + ' name" spellcheck="false" autocomplete="off">' +
        '<button type="button" class="fk-chip kind' + (s.cpu ? ' cpu' : '') + '" data-kind="' + i + '" title="Tap to change">' + (s.cpu ? '◆ ' + RISK[s.cpu].name.toLowerCase() + ' CPU' : '☺ human') + '</button>' +
        (seats.length > 2 ? '<button type="button" class="fk-x" data-del="' + i + '" aria-label="Remove seat ' + (i + 1) + '">×</button>' : '<span class="fk-x ph"></span>') + '</div>';
    });
    return h;
  }
  function showCard(kind, data) {
    if (!S) return;
    var h = '', sv = S.save, R = sv.rules, g = S.g, mode = sv.mode;
    S.cardKind = kind;
    if (kind === 'menu') {
      var resume = g && g.phase === 'turn';
      h = '<div class="fk-title">' + (mode === 'pig' ? 'PIG' : 'FARKLE') + '</div>' +
        '<div class="fk-tabs" role="tablist"><button type="button" data-mode="farkle" class="' + (mode === 'farkle' ? 'on' : '') + '">⚅ Farkle <i>6 dice</i></button>' +
        '<button type="button" data-mode="pig" class="' + (mode === 'pig' ? 'on' : '') + '">⚀ Pig <i>1 die</i></button></div>' +
        '<p class="fk-sub">' + (mode === 'pig' ? 'Roll one die as often as you dare — a 1 loses the turn. First to ' + R.pigTarget + '.' : 'Set aside scoring dice, roll on or bank. No score = Farkle. First to ' + fmt(R.target) + '.') + '</p>' +
        '<div class="fk-h">players</div>' +
        '<div class="fk-chips pre"><button type="button" class="fk-chip" data-pre="cpu1">vs CPU</button><button type="button" class="fk-chip" data-pre="cpu3">vs 3 CPUs</button>' +
        '<button type="button" class="fk-chip" data-pre="pp2">2 players</button><button type="button" class="fk-chip" data-pre="pp4">4 players</button></div>' +
        '<div class="fk-seats">' + seatRows() + '</div>' +
        (sv.seats.length < MAX_PLAYERS ? '<button type="button" class="fk-lnk" data-act="add">+ add a seat</button>' : '') +
        '<div class="fk-h">rules</div>' +
        '<div class="fk-rsum">' + (mode === 'pig' ? 'target ' + R.pigTarget : 'to ' + fmt(R.target) + (R.entry ? ' · entry ' + R.entry : '') + ' · three 1s ' + fmt(R.triple1) + (R.penalty ? ' · 3 farkles −' + fmt(R.penalty) : '')) +
        ' <button type="button" class="fk-lnk" data-act="rules">house rules ›</button></div>' +
        '<div class="fk-h">cpu speed</div>' + chips('speed', ['normal', 'fast'], sv.speed) +
        '<div class="fk-btns">' + (resume ? '<button type="button" class="fk-go" data-act="resume">continue</button>' : '') +
        '<button type="button" class="fk-go' + (resume ? ' alt' : '') + '" data-act="start">' + (resume ? 'new game' : 'start') + '</button></div>' +
        '<div class="fk-foot"><button type="button" class="fk-lnk" data-act="help">how to play</button><button type="button" class="fk-lnk" data-act="records">records</button></div>';
      if (S.confirmNew) h = '<div class="fk-title">NEW GAME?</div><p class="fk-sub">The game in progress will be abandoned.</p><div class="fk-btns"><button type="button" class="fk-go" data-act="start-yes">new game</button><button type="button" class="fk-go alt" data-act="start-no">keep playing</button></div>';
    } else if (kind === 'rules') {
      h = '<div class="fk-title">HOUSE RULES</div>' +
        (mode === 'pig' ? '<div class="fk-h">pig target</div>' + chips('pigTarget', RULE_OPTS.pigTarget, R.pigTarget) :
          '<div class="fk-h">target</div>' + chips('target', RULE_OPTS.target, R.target, fmt) +
          '<div class="fk-h">to get on the board</div>' + chips('entry', RULE_OPTS.entry, R.entry, function (v) { return v ? fmt(v) : 'any'; }) +
          '<div class="fk-h">three 1s</div>' + chips('triple1', RULE_OPTS.triple1, R.triple1, fmt) +
          '<div class="fk-h">4+ of a kind</div>' + chips('multi', RULE_OPTS.multi, R.multi, function (v) { return v === 'double' ? 'doubles' : v === 'add' ? 'adds' : '1k/2k/3k'; }) +
          '<div class="fk-h">straight</div>' + chips('straight', RULE_OPTS.straight, R.straight, function (v) { return v ? fmt(v) : 'off'; }) +
          '<div class="fk-h">three pairs</div>' + chips('threePairs', RULE_OPTS.threePairs, R.threePairs, function (v) { return v ? fmt(v) : 'off'; }) +
          '<div class="fk-h">four + a pair</div>' + chips('fourPair', RULE_OPTS.fourPair, R.fourPair, function (v) { return v ? fmt(v) : 'off'; }) +
          '<div class="fk-h">two triples</div>' + chips('twoTriples', RULE_OPTS.twoTriples, R.twoTriples, function (v) { return v ? fmt(v) : 'off'; }) +
          '<div class="fk-h">three farkles in a row</div>' + chips('penalty', RULE_OPTS.penalty, R.penalty, function (v) { return v ? '−' + fmt(v) : 'no penalty'; }) +
          '<div class="fk-h">scoring</div>' + scoreTable(R)) +
        (g && g.phase === 'turn' ? '<p class="fk-note">Changes apply to the next new game.</p>' : '') +
        '<div class="fk-btns"><button type="button" class="fk-go" data-act="menu">done</button><button type="button" class="fk-go alt" data-act="defaults">classic</button></div>';
    } else if (kind === 'help') {
      var Rg = g ? g.rules : R;
      h = '<div class="fk-title">HOW TO PLAY</div>' +
        '<p><b>Farkle.</b> Roll six dice. Tap the scoring dice you want to set aside (at least one), then <b>roll</b> the rest again or <b>bank</b> the turn. ' +
        'A roll with nothing that scores is a <b>FARKLE</b>: the turn’s points are gone. Score with all six dice and you have <b>hot dice</b> — roll all six again and keep building.</p>' +
        '<p>Reach ' + fmt(Rg.target) + ' and everyone else gets <b>one final turn</b> to beat you.' + (Rg.entry ? ' You need ' + fmt(Rg.entry) + ' in one turn to get on the board.' : '') + (Rg.penalty ? ' Three farkles in a row cost ' + fmt(Rg.penalty) + '.' : '') + '</p>' +
        '<div class="fk-h">scoring (this game)</div>' + scoreTable(Rg) +
        '<p class="fk-tip">Dice only score in the roll they came up in. Selected dice are added together, so 1 + 5 + three 4s is one take.</p>' +
        '<p><b>Pig.</b> One die. Each roll adds to your turn; a <b>1</b> wipes it. <b>Hold</b> to bank. First to ' + Rg.pigTarget + ' wins.</p>' +
        '<div class="fk-keys"><span><b>1–6</b> pick a die · <b>A</b> all scoring</span><span><b>R / Space</b> roll · <b>B / Enter</b> bank</span><span><b>F</b> speed up the CPU · <b>Esc</b> menu</span></div>' +
        '<p class="fk-tip">CPU players: <b>cautious</b> banks early, <b>balanced</b> plays the odds, <b>reckless</b> pushes its luck. All weigh the chance of a farkle with the dice left.</p>' +
        '<div class="fk-btns"><button type="button" class="fk-go" data-act="' + (g ? 'close' : 'menu') + '">' + (g ? 'back to the game' : 'got it') + '</button></div>';
    } else if (kind === 'records') {
      var tab = S.recTab || mode, st = sv.stats[tab];
      var rate = function (a) { return a[0] ? a[1] + '/' + a[0] + ' (' + Math.round(100 * a[1] / a[0]) + '%)' : '—'; };
      var cpuG = st.cpu.cautious[0] + st.cpu.balanced[0] + st.cpu.reckless[0];
      h = '<div class="fk-title">RECORDS</div>' +
        '<div class="fk-tabs"><button type="button" data-rt="farkle" class="' + (tab === 'farkle' ? 'on' : '') + '">Farkle</button><button type="button" data-rt="pig" class="' + (tab === 'pig' ? 'on' : '') + '">Pig</button></div>' +
        '<pre class="fk-tab">' +
        '<b>games played</b>    ' + st.games + '\n' +
        '<b>wins vs CPU</b>     ' + (cpuG ? st.wins + '/' + cpuG + ' (' + Math.round(100 * st.wins / cpuG) + '%)' : '—') + '\n' +
        '<i>  cautious</i>      ' + rate(st.cpu.cautious) + '\n' +
        '<i>  balanced</i>      ' + rate(st.cpu.balanced) + '\n' +
        '<i>  reckless</i>      ' + rate(st.cpu.reckless) + '\n' +
        '<b>pass-and-play</b>   ' + st.pp + '\n' +
        '<b>best turn</b>       <span class="g">' + fmt(st.best) + '</span>\n' +
        '<b>best game score</b> ' + fmt(st.bestGame) + '\n' +
        '<b>turns</b>           ' + fmt(st.turns) + '\n' +
        '<b>' + (tab === 'pig' ? 'pigged out' : 'farkles') + '</b>' + (tab === 'pig' ? '      ' : '         ') + fmt(st.farkles) + (st.turns ? ' <i>(' + Math.round(100 * st.farkles / st.turns) + '% of turns)</i>' : '') +
        (tab === 'farkle' ? '\n<b>hot dice</b>        ' + fmt(st.hot) : '') + '</pre>' +
        '<p class="fk-note">Records count human seats only.</p>' +
        (S.resetArm ? '<div class="fk-btns"><button type="button" class="fk-go danger" data-act="reset-yes">erase records</button><button type="button" class="fk-go alt" data-act="reset-no">keep</button></div>' :
          '<div class="fk-btns"><button type="button" class="fk-go" data-act="menu">back</button></div><div class="fk-foot"><span></span><button type="button" class="fk-lnk" data-act="reset">reset records</button></div>');
    } else if (kind === 'pass') {
      var P = cur();
      h = '<div class="fk-title">PASS</div><div class="fk-big">' + esc(P.name) + '</div>' +
        '<p class="fk-sub">Pass the device to <b>' + esc(P.name) + '</b> — tap when ready.</p>' +
        '<p class="fk-note">' + fmt(P.score) + ' banked · ' + (g.final >= 0 && g.final !== g.cur ? 'FINAL TURN' : 'round ' + g.round) + '</p>' +
        '<div class="fk-btns"><button type="button" class="fk-go" data-act="close">ready</button></div>';
    } else if (kind === 'over') {
      var W = g.players[g.winner], order = g.players.map(function (p, i) { return i; }).sort(function (a, b) { return g.players[b].score - g.players[a].score; });
      var youWin = !W.cpu, anyHuman = humans() > 0, solo = humans() === 1;
      h = '<div class="fk-title">' + (solo ? (youWin ? 'YOU WIN' : 'GAME OVER') : 'WINNER') + '</div>' +
        '<pre class="fk-art">' + (youWin ? '  \\o/  \n   |   \n  / \\  ' : '  [x]  \n  /|\\  \n  / \\  ') + '</pre>' +
        '<div class="fk-big">' + esc(W.name) + '</div>' +
        '<pre class="fk-tab">' + order.map(function (i, k) {
          var p = g.players[i];
          return (k === 0 ? '<span class="g">★ ' : '  ') + '<b>' + esc(p.name) + '</b>' + new Array(Math.max(2, 14 - p.name.length)).join(' ') + new Array(Math.max(1, 8 - fmt(p.score).length)).join(' ') + fmt(p.score) + (k === 0 ? '</span>' : '') +
            '  <i>best ' + fmt(p.st.best) + '</i>';
        }).join('\n') + '</pre>' +
        (data && data.best ? '<div class="fk-new">new best turn!</div>' : '') +
        (data && data.bestGame ? '<div class="fk-new">new best game score!</div>' : '') +
        (anyHuman ? '' : '<p class="fk-note">CPU-only game — not recorded.</p>') +
        '<div class="fk-btns"><button type="button" class="fk-go" data-act="again">play again</button><button type="button" class="fk-go alt" data-act="menu">menu</button></div>';
    }
    S.ovl.innerHTML = '<div class="fk-card ' + kind + '">' + h + '</div>';
    S.ovl.style.display = '';
    S.ovl.scrollTop = 0;
    S.root.classList.add('dim');
    fitCard();
    syncHead();
    var go = S.ovl.querySelector('.fk-go');
    if (go && !S.coarse && kind !== 'menu') { try { go.focus({ preventScroll: true }); } catch (e) {} }
  }

  function applyPreset(p) {
    var sv = S.save, me = (sv.seats.filter(function (s) { return !s.cpu; })[0] || { name: 'You' }).name;
    var risk = (sv.seats.filter(function (s) { return s.cpu; })[0] || { cpu: 'balanced' }).cpu;
    if (p === 'cpu1') sv.seats = [{ name: me, cpu: '' }, { name: CPU_NAMES[0], cpu: risk }];
    else if (p === 'cpu3') sv.seats = [{ name: me, cpu: '' }, { name: CPU_NAMES[0], cpu: 'cautious' }, { name: CPU_NAMES[1], cpu: 'balanced' }, { name: CPU_NAMES[2], cpu: 'reckless' }];
    else {
      var n = p === 'pp4' ? 4 : 2, out = [];
      for (var i = 0; i < n; i++) out.push({ name: i === 0 ? me : 'Player ' + (i + 1), cpu: '' });
      sv.seats = out;
    }
  }
  function cycleKind(i) {
    var s = S.save.seats[i], order = ['', 'cautious', 'balanced', 'reckless'], k = (order.indexOf(s.cpu) + 1) % order.length;
    var wasCpuName = s.cpu && CPU_NAMES.indexOf(s.name) >= 0;
    s.cpu = order[k];
    if (s.cpu && !wasCpuName && /^(Player \d|You)$/.test(s.name)) s.name = freeCpuName();
    if (!s.cpu && CPU_NAMES.indexOf(s.name) >= 0) s.name = 'Player ' + (i + 1);
  }
  function freeCpuName() {
    var used = S.save.seats.map(function (s) { return s.name; });
    for (var i = 0; i < CPU_NAMES.length; i++) if (used.indexOf(CPU_NAMES[i]) < 0) return CPU_NAMES[i];
    return 'CPU';
  }
  function readNames() {
    if (!S) return;
    Array.prototype.forEach.call(S.ovl.querySelectorAll('.fk-in'), function (inp) {
      var i = +inp.getAttribute('data-seat'), s = S.save.seats[i];
      if (s) s.name = inp.value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 12) || (s.cpu ? freeCpuName() : 'Player ' + (i + 1));
    });
  }
  function startGame() {
    readNames();
    var sv = S.save;
    clearTimers();
    S.anim = false; S.cpuMsg = ''; S.cpuSel = null; S.ff = false; S.confirmNew = false; S.cpuPending = false;
    S.g = newGame({ mode: sv.mode, rules: sv.rules, players: sv.seats, seed: (Math.random() * 4294967295) >>> 0 });
    S.lastHuman = null;
    persist();
    S.cardKind = null;
    S.ovl.style.display = 'none'; S.ovl.innerHTML = ''; S.root.classList.remove('dim');
    fitCard();
    render();
    var P = cur();
    if (P.cpu) later(cpuThink, pace(600));
    else { S.lastHuman = 0; if (humans() > 1) showCard('pass'); }
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
  }

  function onOvlClick(e) {
    if (!S) return;
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    S.snd.ensure();
    var a = b.getAttribute('data-act'), k = b.getAttribute('data-k'), md = b.getAttribute('data-mode'), pre = b.getAttribute('data-pre'),
      kd = b.getAttribute('data-kind'), del = b.getAttribute('data-del'), rt = b.getAttribute('data-rt'), sv = S.save;
    if (S.cardKind === 'menu') readNames();
    if (md) { sv.mode = md; SFX.tick(); persist(); showCard('menu'); }
    else if (rt) { S.recTab = rt; S.resetArm = false; SFX.tick(); showCard('records'); }
    else if (pre) { applyPreset(pre); SFX.tick(); persist(); showCard('menu'); }
    else if (kd != null) { cycleKind(+kd); SFX.tick(); persist(); showCard('menu'); }
    else if (del != null) { sv.seats.splice(+del, 1); SFX.tick(); persist(); showCard('menu'); }
    else if (k) {
      var v = b.getAttribute('data-v');
      if (k === 'speed') sv.speed = v === 'fast' ? 'fast' : 'normal';
      else { var cand = {}; cand[k] = isNaN(+v) ? v : +v; var r2 = {}; for (var q in sv.rules) r2[q] = sv.rules[q]; r2[k] = cand[k]; sv.rules = normRules(r2); }
      SFX.tick(); persist(); showCard(S.cardKind);
    }
    else if (a === 'add') { if (sv.seats.length < MAX_PLAYERS) sv.seats.push({ name: freeCpuName(), cpu: 'balanced' }); SFX.tick(); persist(); showCard('menu'); }
    else if (a === 'rules') showCard('rules');
    else if (a === 'defaults') { var pt = sv.rules.pigTarget; sv.rules = normRules(null); sv.rules.pigTarget = pt; persist(); showCard('rules'); }
    else if (a === 'menu') { S.resetArm = false; S.confirmNew = false; showCard('menu'); }
    else if (a === 'help') showCard('help');
    else if (a === 'records') { S.recTab = sv.mode; showCard('records'); }
    else if (a === 'start') { if (S.g && S.g.phase === 'turn' && (S.g.round > 1 || S.g.t.rolled)) { S.confirmNew = true; showCard('menu'); } else startGame(); }
    else if (a === 'start-yes') startGame();
    else if (a === 'start-no') { S.confirmNew = false; showCard('menu'); }
    else if (a === 'again') startGame();
    else if (a === 'resume' || a === 'close') hideCard();
    else if (a === 'reset') { S.resetArm = true; showCard('records'); }
    else if (a === 'reset-no') { S.resetArm = false; showCard('records'); }
    else if (a === 'reset-yes') {
      sv.stats = { farkle: normStats(null), pig: normStats(null) }; S.resetArm = false; persist();
      Cade.showToast && Cade.showToast('Records reset', 'info', 1600);
      showCard('records');
    }
  }

  // ---- keys: only while the panel has focus or nothing else does ----
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && (t.isContentEditable || (t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) {
      if (t.tagName === 'INPUT' && S.panel.contains(t) && (e.key === 'Enter')) { e.preventDefault(); try { t.blur(); } catch (er) {} }
      return;
    }
    var ae = document.activeElement;
    if (ae && ae !== document.body && !S.panel.contains(ae)) return;
    var code = e.code || '';
    if (code === 'Escape') {
      e.preventDefault();
      if (S.cardKind === 'menu' && S.g && S.g.phase === 'turn') hideCard();
      else if (S.cardKind && S.cardKind !== 'menu' && S.cardKind !== 'over') { if (S.cardKind === 'pass') hideCard(); else if (S.g && (S.cardKind === 'help')) hideCard(); else showCard('menu'); }
      else if (!S.cardKind) showCard('menu');
      return;
    }
    if (S.cardKind) {
      if ((code === 'Enter' || code === 'Space') && !(t && t.tagName === 'BUTTON')) {
        e.preventDefault();
        if (S.cardKind === 'pass') hideCard();
        else if (S.cardKind === 'over') startGame();
      }
      return;
    }
    if (e.repeat) return;
    if (code === 'KeyF') { e.preventDefault(); S.ff = true; renderPad(); return; }
    if (code === 'KeyH' || code === 'Slash') { e.preventDefault(); showCard('help'); return; }
    if (!humanTurn()) {
      if ((code === 'Space' || code === 'Enter') && S.g && S.g.phase === 'over') { e.preventDefault(); showCard('over'); }
      return;
    }
    if (S.g.t.res) { if (code === 'Space' || code === 'Enter') { e.preventDefault(); advanceNow(); } return; }
    var dm = /^(Digit|Numpad)([1-6])$/.exec(code);
    if (dm) { e.preventDefault(); tapDie(+dm[2] - 1); return; }
    if (code === 'KeyA') { e.preventDefault(); selectBest(); return; }
    if (code === 'KeyR' || code === 'Space') {
      if (code === 'Space' && t && t.tagName === 'BUTTON' && S.panel.contains(t) && !t.classList.contains('fk-die')) return;
      e.preventDefault(); doRoll(); return;
    }
    if (code === 'KeyB' || code === 'Enter' || code === 'NumpadEnter') {
      if (code !== 'KeyB' && t && t.tagName === 'BUTTON' && S.panel.contains(t) && !t.classList.contains('fk-die')) return;
      e.preventDefault(); doBank();
    }
  }
  function advanceNow() { clearTimers(); advance(); }

  // ---- pause on hide / minimize (the CPU waits) ----
  function pause() { if (!S || S.paused) return; S.paused = true; if (S.timers.length && S.g && cur().cpu) S.cpuPending = true; S.timers.forEach(clearTimeout); S.timers = []; if (S.g && S.g.t.res && S.g.phase === 'turn') S.advPending = true; }
  function unpause() {
    if (!S || !S.paused) return;
    S.paused = false;
    if (S.anim && !S.animT) S.anim = false;
    if (S.advPending) { S.advPending = false; later(advance, 400); return; }
    if (S.g && S.g.phase === 'turn' && cur().cpu) S.cpuPending = true;
    resumeCpu();
    render();
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S;
    clearTimers();
    S = null;
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('resize', s.onResize);
    clearTimeout(s.resizeT);
    if (s.ro) s.ro.disconnect();
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    if (S) persist();
    teardown();
    if (p) p.remove();
  }
  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="fk" tabindex="-1"><div class="fk-board"></div>' +
      '<div class="fk-table"><div class="fk-kept"></div><div class="fk-dice"></div><div class="fk-msg"></div></div>' +
      '<div class="fk-pad"></div><div class="fk-ovl" style="display:none"></div><div class="fk-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🎲 Farkle', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'fk-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="menu" title="Menu, rules &amp; records" aria-label="Menu, rules and records">' + IC_MENU + '</button>' +
      '<button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, root: p.querySelector('.fk'), board: p.querySelector('.fk-board'), table: p.querySelector('.fk-table'),
      kept: p.querySelector('.fk-kept'), dice: p.querySelector('.fk-dice'), msg: p.querySelector('.fk-msg'), pad: p.querySelector('.fk-pad'),
      ovl: p.querySelector('.fk-ovl'), live: p.querySelector('.fk-live'),
      save: ld.save, g: ld.save.game, snd: new Snd(sget(SOUND_KEY) === '1'), timers: [], animT: 0, anim: false,
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      cardKind: null, cpuMsg: '', cpuSel: null, ff: false, paused: false, cpuPending: false, lastHuman: null
    };
    p._onClose = function () { if (S && S.panel === p) persist(); teardown(); };

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (!S) return; if (document.hidden) pause(); else if (!(Cade.isMinimized && Cade.isMinimized(S.panel))) unpause(); };
    document.addEventListener('visibilitychange', S.onVis);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) pause(); });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { fitDice(); fitCard(); } }, 100);
    };
    window.addEventListener('resize', S.onResize);
    try { S.ro = new ResizeObserver(S.onResize); S.ro.observe(S.table); } catch (e) {}
    p.addEventListener('cade-panel-restore', function () { if (S && S.panel === p) requestAnimationFrame(function () { if (S) { unpause(); render(); } }); });

    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        syncHead();
      } else if (h === 'help') { if (S.cardKind === 'help') { if (S.g) hideCard(); else showCard('menu'); } else showCard('help'); }
      else if (h === 'menu') { if (S.cardKind === 'menu' && S.g && S.g.phase === 'turn') hideCard(); else { S.confirmNew = false; showCard('menu'); } }
      try { b.blur(); } catch (er) {}
    });

    // fast taps must never zoom, select or open callouts (text inputs keep working)
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (tp) { p.addEventListener(tp, noTouch, { passive: false }); });
    // A tap on the play surface: we cancel the touch (no double-tap zoom, no
    // 300 ms wait) and deliver the click ourselves; a drag is not a tap.
    var t0 = null;
    function playTouch(e) {
      if (!e.cancelable || !S) return;
      var tg = e.target, ch = e.changedTouches && e.changedTouches[0];
      if (tg && tg.closest && tg.closest('input')) return;
      e.preventDefault();
      if (!t0 || !ch || Math.abs(ch.clientX - t0.x) > 12 || Math.abs(ch.clientY - t0.y) > 12) return;
      var b = tg && tg.closest ? tg.closest('button') : null;
      if (b) { if (!b.disabled) b.click(); }
      else if (S.table.contains(tg) && S.g && S.g.phase === 'turn' && cur().cpu) { S.ff = true; renderPad(); }
    }
    [S.table, S.pad, S.ovl].forEach(function (el) {
      el.addEventListener('touchstart', function (e) {
        if (!S) return;
        S.snd.ensure();
        var ch = e.touches[0]; t0 = ch ? { x: ch.clientX, y: ch.clientY } : null;
        if (e.touches.length > 1) noTouch(e);
      }, { passive: false });
      if (el !== S.ovl) el.addEventListener('touchend', playTouch, { passive: false });
      el.addEventListener('contextmenu', noTouch);
    });

    S.dice.addEventListener('click', function (e) {
      if (!S) return;
      S.snd.ensure();
      var b = e.target.closest ? e.target.closest('[data-d]') : null;
      if (b) { tapDie(+b.getAttribute('data-d')); return; }
    });
    S.table.addEventListener('click', function (e) {
      if (!S || !S.g) return;
      if (e.target.closest && e.target.closest('[data-d]')) return;
      if (S.g.phase === 'turn' && cur().cpu) { S.ff = true; renderPad(); }   // tap the table: hurry the CPU
    });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S || b.disabled) return;
      S.snd.ensure();
      var a = b.getAttribute('data-a');
      if (a === 'roll') doRoll();
      else if (a === 'bank') doBank();
      else if (a === 'best') selectBest();
      else if (a === 'next') advanceNow();
      else if (a === 'ff') { S.ff = !S.ff; renderPad(); }
      else if (a === 'again') startGame();
      else if (a === 'menu') showCard('menu');
      try { if (S && S.coarse) b.blur(); } catch (er) {}
    });
    S.ovl.addEventListener('click', onOvlClick);
    S.ovl.addEventListener('touchend', function (e) {
      // card buttons: no double-tap zoom; a scroll is not a tap; inputs keep native behaviour
      var tg = e.target, ch = e.changedTouches && e.changedTouches[0];
      if (!e.cancelable || !tg.closest || tg.closest('input')) return;
      var b = tg.closest('button');
      if (!b) return;
      e.preventDefault();
      if (t0 && ch && Math.abs(ch.clientX - t0.x) <= 12 && Math.abs(ch.clientY - t0.y) <= 12 && !b.disabled) b.click();
    }, { passive: false });
    S.ovl.addEventListener('input', function (e) { if (e.target && e.target.classList.contains('fk-in')) { readNames(); persist(); } });

    try {
      S.themeObs = new MutationObserver(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) render(); });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    if (S.g && S.g.phase === 'over') {
      // the saved game ended with its last turn (resolved on load): show the result
      render();
      finish();
    } else if (S.g) {
      render();
      S.lastHuman = cur().cpu ? null : S.g.cur;
      persist();   // the load may have moved a finished turn on
      if (S.g.t.res) later(advance, 600);
      else if (cur().cpu) later(cpuThink, 700);
      else if (humans() > 1 && !S.g.t.rolled) showCard('pass');   // pass-and-play: whose turn it is
    } else {
      // an empty table behind the menu
      S.g = null;
      S.board.innerHTML = ''; S.kept.innerHTML = '';
      S.dice.className = 'fk-dice';
      S.dice.innerHTML = [1, 2, 3, 4, 5, 6].map(function (v) { return '<button type="button" class="fk-die idle" tabindex="-1" aria-hidden="true"><pre>' + dieArt(v) + '</pre></button>'; }).join('');
      S.pad.innerHTML = '';
      fitDice();
      syncHead();
      showCard(ld.fresh ? 'help' : 'menu');
    }
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Push-your-luck dice — Farkle and Pig, vs CPU or pass-and-play',
    icon: '🎲',
    tags: 'game,dice,farkle,pig,push your luck,2 player,cpu,pass and play,ascii',
    open: open,
    _engine: ENGINE
  });
})();
