/* Solitaire — Klondike and Spider in one panel. The header's "Klondike | Spider"
 * switch picks the game; the last one is remembered, and each keeps its own
 * game in progress, statistics and settings (switching never ends a game).
 *
 * KLONDIKE ("normal" solitaire): 52 cards, seven columns of 1..7 cards (top
 * card face-up), stock, waste and four foundations built A→K by suit. Build
 * columns down in alternating colours; any valid face-up run moves; only a
 * King (or a run headed by one) goes into an empty column; a face-down card
 * that ends up on top turns over by itself (part of that move, so undo puts it
 * back). Draw 1 or Draw 3 is chosen per deal (New game menu); passes through
 * the stock are unlimited. Foundation cards may come back down. When every
 * card is face-up and the stock and waste are empty, the rest go home on
 * their own (setting) or with Auto (A). Standard scoring, never below 0:
 * waste→column +5, to a foundation +10, card turned over +5, foundation→
 * column −15, recycling the waste −100 (Draw 1) / −20 (Draw 3).
 *
 * SPIDER: two decks, ten columns, build K→A in one suit; 1, 2 or 4 suits.
 * 54 cards dealt (columns 1-4 get 6, the rest 5, only the top card face-up);
 * move a same-suit descending sequence (any single card) onto a card one rank
 * higher of any suit, or into an empty column; a complete K→A run of one suit
 * goes to the foundation automatically; the stock deals one card to every
 * column (classic rule, optional: not while a column is empty).
 * Score = 500 − moves (undo/redo count as moves) + 100 per run.
 *
 * ENGINES: SpiderCore() and KlondikeCore() are pure (no DOM, no outer
 * references). A game is fully described by (deal number, suits / draw count,
 * list of move tokens): the table is rebuilt by replaying the tokens, which
 * makes the save tiny and undo/redo unlimited and exact (undo = replay all but
 * the last token; a few hundred tokens replay in well under a millisecond).
 * Every deal has a number you can replay.
 *   Spider tokens: "D" = deal a row, otherwise from-pile, to-pile, card count
 *   (base 36), e.g. "37a".
 *   Klondike tokens: "D" = draw, "R" = turn the waste back into the stock,
 *   otherwise from, to, count (base 36) where a place is one character:
 *   "0"-"6" columns, "w" waste, "a"-"d" foundations — e.g. "w31" (waste → column
 *   3), "253" (three cards, column 2 → 5), "4a1" (column 4 → a foundation).
 *
 * PLAY: drag cards (mouse or touch), or tap: by default a tap sends the cards
 * to their best spot (Klondike: a single card goes to its foundation first);
 * a setting switches to "tap to select, tap the target". Double-click /
 * double-tap also auto-moves. Tap the stock to draw / deal.
 * Keys: Ctrl+Z / Ctrl+Y undo/redo, H hint (repeat to cycle), N new game,
 * Esc close; Spider: D deal; Klondike: D or Space draw, A auto-finish.
 *
 * Storage: Spider keeps cade-spider-save/-stats/-prefs (unchanged from the
 * Spider-only widget, so its games carry over), Klondike uses
 * cade-klondike-save/-stats/-prefs, and cade-solitaire-mode is the last mode.
 *
 * Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('spider.css');

  // ---- pure engine: Spider -----------------------------------------------------
  function SpiderCore() {
    // Card ids 0..103: rank = id % 13 + 1, "set" = id / 13 (8 sets of 13).
    // Which suit each set gets depends on the suit count.
    var SETS = { 1: [0, 0, 0, 0, 0, 0, 0, 0], 2: [0, 1, 0, 1, 0, 1, 0, 1], 4: [0, 1, 2, 3, 0, 1, 2, 3] };
    function R(id) { return id % 13 + 1; }
    function rng(seed) {                        // mulberry32: tiny, fast, good enough for shuffles
      var a = seed >>> 0;
      return function () {
        a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function deal(dealNo, suits) {
      suits = SETS[suits] ? suits : 1;
      var r = rng(Math.imul((dealNo >>> 0) ^ 0x5bd1e995, 0x9E3779B1) ^ 0x2545F491), ids = [], i;
      for (i = 0; i < 104; i++) ids.push(i);
      for (i = 103; i > 0; i--) { var j = (r() * (i + 1)) | 0, t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
      var S = [];
      for (i = 0; i < 104; i++) S.push(SETS[suits][(i / 13) | 0]);
      var st = { suits: suits, S: S, piles: [], down: [], stock: ids.slice(54), found: [] };
      for (i = 0; i < 10; i++) { st.piles.push([]); st.down.push(0); }
      for (i = 0; i < 54; i++) st.piles[i % 10].push(ids[i]);
      for (i = 0; i < 10; i++) st.down[i] = st.piles[i].length - 1;
      return st;
    }
    // Index where the top same-suit descending face-up run of pile p starts.
    function runStart(st, p) {
      var pile = st.piles[p], i = pile.length - 1;
      if (i < 0) return -1;
      while (i > st.down[p]) {
        var a = pile[i - 1], b = pile[i];
        if (st.S[a] !== st.S[b] || R(a) !== R(b) + 1) break;
        i--;
      }
      return i;
    }
    function canMoveFrom(st, p, i) {
      var len = st.piles[p] ? st.piles[p].length : 0;
      return i >= 0 && i < len && i >= st.down[p] && i >= runStart(st, p);
    }
    function accepts(st, q, id) {
      var pile = st.piles[q];
      return !pile.length || R(pile[pile.length - 1]) === R(id) + 1;
    }
    function legal(st, p, n, q) {
      if (p === q || !st.piles[p] || !st.piles[q] || n < 1) return false;
      var i = st.piles[p].length - n;
      return canMoveFrom(st, p, i) && accepts(st, q, st.piles[p][i]);
    }
    function flipTop(st, p) {
      var len = st.piles[p].length;
      if (!len) { st.down[p] = 0; return false; }
      if (st.down[p] >= len) { st.down[p] = len - 1; return true; }
      return false;
    }
    function moveRaw(st, p, n, q) {
      var cards = st.piles[p].splice(st.piles[p].length - n, n);
      for (var k = 0; k < cards.length; k++) st.piles[q].push(cards[k]);
      return flipTop(st, p);
    }
    // A full K→A run of one suit on top of pile p?
    function completeAt(st, p) {
      var pile = st.piles[p], len = pile.length, i = len - 13;
      return len >= 13 && i >= st.down[p] && R(pile[i]) === 13 && runStart(st, p) <= i;
    }
    function collect(st, p) {
      if (!completeAt(st, p)) return false;
      st.found.push(st.piles[p].splice(st.piles[p].length - 13, 13));
      flipTop(st, p);
      return true;
    }
    function collectAll(st) { var got = []; for (var p = 0; p < 10; p++) if (collect(st, p)) got.push(p); return got; }
    function canDeal(st, classic) {
      if (st.stock.length < 10) return false;
      if (classic) for (var p = 0; p < 10; p++) if (!st.piles[p].length) return false;
      return true;
    }
    function dealRaw(st) { var ids = []; for (var p = 0; p < 10; p++) { var id = st.stock.pop(); st.piles[p].push(id); ids.push(id); } return ids; }
    function token(p, n, q) { return '' + p + q + n.toString(36); }
    function apply(st, tok) {
      if (tok === 'D') { if (!canDeal(st, false)) return false; dealRaw(st); collectAll(st); return true; }
      if (!/^[0-9][0-9][1-9a-d]$/.test(tok)) return false;
      var p = +tok[0], q = +tok[1], n = parseInt(tok[2], 36);
      if (!legal(st, p, n, q)) return false;
      moveRaw(st, p, n, q);
      collect(st, q);
      return true;
    }
    function replay(dealNo, suits, toks) {
      var st = deal(dealNo, suits);
      for (var i = 0; i < toks.length; i++) if (!apply(st, toks[i])) return { st: st, bad: i };
      return { st: st, bad: -1 };
    }
    function won(st) { return st.found.length === 8; }
    function top(st, q) { var pile = st.piles[q]; return pile.length ? pile[pile.length - 1] : -1; }
    function topRunLen(st, q) { var i = runStart(st, q); return i < 0 ? 0 : st.piles[q].length - i; }

    // Ranked useful moves: completing runs > same-suit builds > exposing
    // face-down cards > emptying columns; pointless shuffles are left out.
    function hints(st, classic) {
      var out = [], S = st.S;
      for (var p = 0; p < 10; p++) {
        var pile = st.piles[p], len = pile.length;
        if (!len) continue;
        var i = runStart(st, p), id = pile[i], n = len - i;
        var under = i > 0 ? pile[i - 1] : -1, underUp = i - 1 >= st.down[p];
        var natural = i > 0 && underUp && R(under) === R(id) + 1;
        var usedEmpty = false;
        for (var q = 0; q < 10; q++) {
          if (q === p || !accepts(st, q, id)) continue;
          var t = top(st, q), empty = t < 0, sameT = !empty && S[t] === S[id];
          if (empty && (i === 0 || usedEmpty)) continue;   // whole column to an empty one / one empty target is enough
          if (natural && !sameT) continue;                 // already sits on a valid card
          var sc = n;
          if (sameT) {
            var rl = topRunLen(st, q);
            sc += rl + n >= 13 && R(st.piles[q][st.piles[q].length - rl]) === 13 ? 1000 : 100 + rl + n;
          }
          if (i > 0 && !underUp) sc += 200 + (8 - st.down[p]) * 4;
          else if (i === 0) sc += 150;
          else if (!natural) sc += 30;
          if (empty) { sc -= 120; usedEmpty = true; }
          out.push({ p: p, n: n, q: q, sc: sc });
        }
      }
      out.sort(function (a, b) { return b.sc - a.sc; });
      if (canDeal(st, classic)) out.push({ deal: true, sc: -1000 });
      return out;
    }
    // Where should the cards from (p, i) go when tapped / double-clicked?
    function bestTarget(st, p, i) {
      if (!canMoveFrom(st, p, i)) return -1;
      var id = st.piles[p][i], best = -1, bestSc = -1e9;
      for (var q = 0; q < 10; q++) {
        if (q === p || !accepts(st, q, id)) continue;
        var t = top(st, q), sc;
        if (t < 0) sc = 10;
        else if (st.S[t] === st.S[id]) {
          var rl = topRunLen(st, q);
          sc = rl + (st.piles[p].length - i) >= 13 ? 2000 : 300 + rl;
        } else sc = 100 + topRunLen(st, q);
        sc -= Math.abs(q - p) * 0.01;
        if (sc > bestSc) { bestSc = sc; best = q; }
      }
      return best;
    }

    return {
      R: R, deal: deal, runStart: runStart, canMoveFrom: canMoveFrom, accepts: accepts, legal: legal,
      moveRaw: moveRaw, completeAt: completeAt, collect: collect, collectAll: collectAll, canDeal: canDeal,
      dealRaw: dealRaw, token: token, apply: apply, replay: replay, won: won, hints: hints, bestTarget: bestTarget
    };
  }

  // ---- pure engine: Klondike ---------------------------------------------------
  function KlondikeCore() {
    // Card ids 0..51: suit = id / 13 (0 ♠, 1 ♥, 2 ♣, 3 ♦ — odd suits are red),
    // rank = id % 13 + 1. A place is one character: "0"-"6" columns, "w" waste,
    // "a"-"d" foundations, "s" stock. Arrays are bottom → top.
    var FND = 'abcd';
    var TOK = /^[0-6wa-d][0-6a-d][1-9a-d]$/;
    function R(id) { return id % 13 + 1; }
    function S(id) { return (id / 13) | 0; }
    function red(id) { return (S(id) & 1) === 1; }
    function isT(c) { return typeof c === 'string' && c.length === 1 && c >= '0' && c <= '6'; }
    function isF(c) { return typeof c === 'string' && c.length === 1 && FND.indexOf(c) !== -1; }
    function rng(seed) {                        // mulberry32
      var a = seed >>> 0;
      return function () {
        a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    // st: { draw, piles[7], down[7] (face-down count = index of the first
    // face-up card), stock, waste, wfan (waste cards fanned: the last draw),
    // found[4], score, passes }.
    function deal(dealNo, draw) {
      draw = draw === 3 ? 3 : 1;
      var r = rng(Math.imul((dealNo >>> 0) ^ 0x1b873593, 0x85EBCA6B) ^ 0x7F4A7C15), ids = [], i, p;
      for (i = 0; i < 52; i++) ids.push(i);
      for (i = 51; i > 0; i--) { var j = (r() * (i + 1)) | 0, t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
      var st = { draw: draw, piles: [], down: [], stock: null, waste: [], wfan: 0, found: [[], [], [], []], score: 0, passes: 0 };
      for (p = 0; p < 7; p++) { st.piles.push([]); st.down.push(p); }
      var k = 0;
      for (var row = 0; row < 7; row++) for (p = row; p < 7; p++) st.piles[p].push(ids[k++]);
      st.stock = ids.slice(28);
      return st;
    }
    function pileOf(st, c) {
      return isT(c) ? st.piles[+c] : c === 'w' ? st.waste : isF(c) ? st.found[FND.indexOf(c)] : c === 's' ? st.stock : null;
    }
    function top(a) { return a && a.length ? a[a.length - 1] : -1; }
    // Can the cards from index i of place c (up to its top) be picked up?
    function canMoveFrom(st, c, i) {
      var a = pileOf(st, c);
      if (!a || c === 's' || i < 0 || i >= a.length) return false;
      if (!isT(c)) return i === a.length - 1;
      if (i < st.down[+c]) return false;
      for (var k = i + 1; k < a.length; k++) if (R(a[k - 1]) !== R(a[k]) + 1 || red(a[k - 1]) === red(a[k])) return false;
      return true;
    }
    function acceptsT(st, q, id) {
      var t = top(st.piles[q]);
      return t < 0 ? R(id) === 13 : R(t) === R(id) + 1 && red(t) !== red(id);
    }
    function acceptsF(st, f, id) {
      var t = top(st.found[f]);
      return t < 0 ? R(id) === 1 : S(t) === S(id) && R(id) === R(t) + 1;
    }
    function legal(st, from, n, to) {
      if (from === to || !(n >= 1)) return false;
      var a = pileOf(st, from);
      if (!a || !canMoveFrom(st, from, a.length - n)) return false;
      var id = a[a.length - n];
      if (isT(to)) return acceptsT(st, +to, id);
      if (isF(to)) return n === 1 && !isF(from) && acceptsF(st, FND.indexOf(to), id);
      return false;
    }
    // The foundation a card can go to now (an Ace takes the first empty one), or -1.
    function foundFor(st, id) {
      for (var f = 0; f < 4; f++) if (acceptsF(st, f, id)) return f;
      return -1;
    }
    function addScore(st, n) { st.score = Math.max(0, st.score + n); }
    // Moves cards (no checks); returns true when a face-down card turned over.
    function moveRaw(st, from, n, to) {
      var a = pileOf(st, from), b = pileOf(st, to), cards = a.splice(a.length - n, n), flipped = false;
      for (var k = 0; k < cards.length; k++) b.push(cards[k]);
      if (isT(from)) {
        var p = +from;
        if (!a.length) st.down[p] = 0;
        else if (st.down[p] >= a.length) { st.down[p] = a.length - 1; flipped = true; }
      } else if (from === 'w') st.wfan = a.length ? Math.max(1, st.wfan - 1) : 0;
      addScore(st, (isF(to) ? 10 : from === 'w' ? 5 : isF(from) ? -15 : 0) + (flipped ? 5 : 0));
      return flipped;
    }
    function drawRaw(st) {                      // turn up to `draw` cards onto the waste
      var n = Math.min(st.draw, st.stock.length);
      for (var k = 0; k < n; k++) st.waste.push(st.stock.pop());
      st.wfan = n;
      return n;
    }
    function canRecycle(st) { return !st.stock.length && st.waste.length > 0; }
    function recycleRaw(st) {                   // turn the waste over: it becomes the stock again
      st.stock = st.waste.reverse();
      st.waste = []; st.wfan = 0; st.passes++;
      addScore(st, st.draw === 1 ? -100 : -20);
    }
    function token(from, to, n) { return '' + from + to + n.toString(36); }
    function apply(st, tok) {
      if (tok === 'D') { if (!st.stock.length) return false; drawRaw(st); return true; }
      if (tok === 'R') { if (!canRecycle(st)) return false; recycleRaw(st); return true; }
      if (!TOK.test(tok)) return false;
      var from = tok[0], to = tok[1], n = parseInt(tok[2], 36);
      if (!legal(st, from, n, to)) return false;
      moveRaw(st, from, n, to);
      return true;
    }
    function replay(dealNo, draw, toks) {
      var st = deal(dealNo, draw);
      for (var i = 0; i < toks.length; i++) if (!apply(st, toks[i])) return { st: st, bad: i };
      return { st: st, bad: -1 };
    }
    function homeCount(st) { return st.found[0].length + st.found[1].length + st.found[2].length + st.found[3].length; }
    function won(st) { return homeCount(st) === 52; }
    // Everything face-up, stock and waste empty: the rest can simply go home.
    function canAutoFinish(st) {
      if (st.stock.length || st.waste.length || won(st)) return false;
      for (var p = 0; p < 7; p++) if (st.down[p] > 0) return false;
      return true;
    }
    // The next card to send home (lowest rank first), as a token, or ''.
    function nextHome(st) {
      var best = '', bestR = 99, f, id = top(st.waste);
      if (id >= 0 && (f = foundFor(st, id)) >= 0) { best = token('w', FND[f], 1); bestR = R(id); }
      for (var p = 0; p < 7; p++) {
        id = top(st.piles[p]);
        if (id >= 0 && R(id) < bestR && (f = foundFor(st, id)) >= 0) { best = token(String(p), FND[f], 1); bestR = R(id); }
      }
      return best;
    }
    // Sends every card it can home (st is updated); returns the tokens applied.
    function autoFinish(st) {
      var toks = [], tok;
      while ((tok = nextHome(st)) && apply(st, tok)) toks.push(tok);
      return toks;
    }

    // Ranked useful moves: to a foundation > uncovering a face-down card >
    // freeing a card for its foundation > waste to a column > emptying a
    // column for a waiting King; then draw / recycle. Pointless shuffles
    // (a run that already sits on a valid card) are left out.
    function hints(st) {
      var out = [], p, q, f, i, id, a, len, w = top(st.waste);
      function push(from, n, to, sc) { out.push({ from: from, n: n, to: to, sc: sc }); }
      var kingWaiting = w >= 0 && R(w) === 13;
      for (p = 0; p < 7 && !kingWaiting; p++) {
        var d0 = st.down[p];
        if (d0 > 0 && st.piles[p].length > d0 && R(st.piles[p][d0]) === 13) kingWaiting = true;
      }
      if (w >= 0 && (f = foundFor(st, w)) >= 0) push('w', 1, FND[f], 600 - R(w));
      for (p = 0; p < 7; p++) {
        a = st.piles[p]; len = a.length;
        if (!len) continue;
        id = a[len - 1];
        if ((f = foundFor(st, id)) >= 0) push(String(p), 1, FND[f], (st.down[p] && st.down[p] === len - 1 ? 700 : 500) - R(id));
      }
      for (p = 0; p < 7; p++) {
        a = st.piles[p]; len = a.length;
        var d = st.down[p];
        for (i = d; i < len; i++) {
          id = a[i];
          var sc;
          if (i === d && d > 0) sc = 300 + d * 10;                       // uncovers a face-down card
          else if (i === 0) { if (!kingWaiting || R(id) === 13) continue; sc = 120; }   // empties the column for a King
          else if (foundFor(st, a[i - 1]) >= 0) sc = 250;                 // frees the card beneath for its foundation
          else continue;                                                  // just shuffling
          var usedEmpty = false;
          for (q = 0; q < 7; q++) {
            if (q === p || !acceptsT(st, q, id)) continue;
            var empty = !st.piles[q].length;
            if (empty && (i === 0 || usedEmpty)) continue;
            if (empty) usedEmpty = true;
            push(String(p), len - i, String(q), sc - (empty ? 20 : 0));
          }
        }
      }
      if (w >= 0) {
        var usedW = false;
        for (q = 0; q < 7; q++) {
          if (!acceptsT(st, q, w)) continue;
          var emptyW = !st.piles[q].length;
          if (emptyW && usedW) continue;
          if (emptyW) usedW = true;
          push('w', 1, String(q), emptyW ? 180 : 200);
        }
      }
      out.sort(function (x, y) { return y.sc - x.sc; });
      if (st.stock.length) out.push({ draw: true, sc: -1000 });
      else if (st.waste.length > 1) out.push({ recycle: true, sc: -1000 });
      return out;
    }
    // No useful move on the table and no card in the stock or waste fits
    // anywhere: cycling the stock can't help.
    function stuck(st) {
      if (won(st)) return false;
      var h = hints(st);
      for (var k = 0; k < h.length; k++) if (!h[k].draw && !h[k].recycle) return false;
      var pool = st.stock.concat(st.waste);
      for (k = 0; k < pool.length; k++) {
        if (foundFor(st, pool[k]) >= 0) return false;
        for (var q = 0; q < 7; q++) if (acceptsT(st, q, pool[k])) return false;
      }
      return true;
    }
    // Where should the card(s) from index i of place c go when tapped? A single
    // card goes home when it can; otherwise the best column ('' = nowhere).
    function bestTarget(st, c, i, colsOnly) {
      if (!canMoveFrom(st, c, i)) return '';
      var a = pileOf(st, c), id = a[i], n = a.length - i, f;
      if (!colsOnly && n === 1 && !isF(c) && (f = foundFor(st, id)) >= 0) return FND[f];
      var p = isT(c) ? +c : -1, ref = p >= 0 ? p : isF(c) ? 3 + FND.indexOf(c) : 1, best = '', bestSc = -1e9;
      for (var q = 0; q < 7; q++) {
        if (q === p || !acceptsT(st, q, id)) continue;
        var empty = !st.piles[q].length;
        if (empty && p >= 0 && i === 0) continue;                      // a whole column into an empty one changes nothing
        var sc = (empty ? 10 : 100) - Math.abs(q - ref) * 0.01;
        if (sc > bestSc) { bestSc = sc; best = String(q); }
      }
      return best;
    }

    return {
      FND: FND, R: R, S: S, red: red, isT: isT, isF: isF, deal: deal, pileOf: pileOf, canMoveFrom: canMoveFrom,
      acceptsT: acceptsT, acceptsF: acceptsF, legal: legal, foundFor: foundFor, moveRaw: moveRaw, drawRaw: drawRaw,
      canRecycle: canRecycle, recycleRaw: recycleRaw, token: token, apply: apply, replay: replay, homeCount: homeCount,
      won: won, canAutoFinish: canAutoFinish, nextHome: nextHome, autoFinish: autoFinish, hints: hints, stuck: stuck,
      bestTarget: bestTarget
    };
  }

  // ---- shared: constants + small helpers -----------------------------------------
  var PANEL_ID = 'spider-panel';
  var ICON = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='5' width='11' height='15' rx='1.8' transform='rotate(-10 8.5 12.5)'/><rect x='9' y='3.5' width='11' height='15' rx='1.8' fill='var(--surface, #fff)'/><path d='M14.5 7.4c-1.6 1.6-3 2.6-3 4a1.6 1.6 0 0 0 3 .8 1.6 1.6 0 0 0 3-.8c0-1.4-1.4-2.4-3-4z' fill='currentColor' stroke='none'/><path d='M14.5 12.4l-.8 2.3h1.6z' fill='currentColor' stroke='none'/></svg>";
  // U+FE0E (text presentation) keeps iOS from drawing the suits as emoji.
  var GLYPH = ['♠︎', '♥︎', '♣︎', '♦︎'];
  var RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

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
  function randomDeal() { return 1 + Math.floor(Math.random() * 999999); }
  function setXY(el, x, y) { el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)'; }
  function flipFx(el, delay) {
    var inner = el.firstChild;
    if (!inner || !inner.animate) return;
    try { inner.animate([{ transform: 'scaleX(0.05)' }, { transform: 'scaleX(1)' }], { duration: 200, delay: delay + 80, easing: 'ease-out', fill: 'backwards' }); } catch (e) {}
  }
  function shake(el) {
    if (!el) return;
    var t = el.firstChild && el.classList.contains('sp-c') ? el.firstChild : el;
    t.classList.remove('sp-shake'); void t.offsetWidth; t.classList.add('sp-shake');
    haptic(15);
  }

  // Win cascade: the classic bouncing cards, drawn on a canvas with trails.
  // `queue` = card ids in launch order (consumed), faceOf(id) = { r, s }.
  function cascadeFx(ui, queue, faceOf, done) {
    if (!ui || reduced() || !ui.L || !queue.length) { done(); return; }
    var L = ui.L, W = ui.table.clientWidth, H = ui.table.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    var cv = document.createElement('canvas');
    cv.className = 'sp-fx';
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ui.table.appendChild(cv);
    var ctx = cv.getContext('2d');
    if (!ctx) { cv.remove(); done(); return; }
    ctx.scale(dpr, dpr);
    // Colours from a real (face-up) card, so the canvas matches the theme.
    var probe = ui.cards[queue[0]].firstChild, cs = getComputedStyle(probe);
    var face = cs.backgroundColor, ink = cs.color, edge = cs.borderTopColor, red = ink;
    for (var id = 0; id < ui.cards.length; id++) if (ui.cards[id].classList.contains('red')) { red = getComputedStyle(ui.cards[id].firstChild).color; break; }
    var sprites = {}, cw = L.cw, ch = L.ch;
    function sprite(cid) {
      var fc = faceOf(cid), key = fc.r + ':' + fc.s;
      if (sprites[key]) return sprites[key];
      var c = document.createElement('canvas'), g;
      c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr);
      g = c.getContext('2d'); g.scale(dpr, dpr);
      g.fillStyle = face; g.strokeStyle = edge; g.lineWidth = 1;
      g.fillRect(0.5, 0.5, cw - 1, ch - 1); g.strokeRect(0.5, 0.5, cw - 1, ch - 1);
      var s = fc.s, fs = Math.min(cw * 0.42, 22);
      g.fillStyle = s === 1 || s === 3 ? red : ink;
      g.textBaseline = 'top';
      g.font = '700 ' + fs + 'px system-ui, -apple-system, sans-serif';
      g.fillText(RANKS[fc.r] + GLYPH[s], cw * 0.07, 2);
      g.font = (cw * 0.55) + 'px system-ui, -apple-system, sans-serif';
      g.textBaseline = 'bottom'; g.textAlign = 'right';
      g.fillText(GLYPH[s], cw * 0.92, ch * 0.95);
      return (sprites[key] = c);
    }
    var live = [], last = 0, acc = 0, sc = Math.max(0.6, cw / 50), floor = H - ch, t0 = 0;
    var fx = ui.fx = { raf: 0, cv: cv, done: done };
    function launch() {
      var cid = queue.shift(), P = ui.pos[cid];
      ui.cards[cid].style.visibility = 'hidden';
      live.push({
        id: cid, x: P.x, y: P.y, vx: (0.1 + Math.random() * 0.22) * sc * (Math.random() < 0.5 ? -1 : 1),
        vy: -Math.random() * 0.35 * sc, img: sprite(cid)
      });
    }
    function frame(ts) {
      if (ui.fx !== fx) return;
      if (!last) { last = ts; t0 = ts; }
      var dt = Math.min(32, ts - last);
      last = ts; acc += dt;
      while (queue.length && acc >= 55) { acc -= 55; launch(); }
      for (var k = live.length - 1; k >= 0; k--) {
        var c = live[k];
        c.vy += 0.0016 * sc * dt;
        c.x += c.vx * dt; c.y += c.vy * dt;
        if (c.y > floor) { c.y = floor; c.vy = -c.vy * 0.72; if (Math.abs(c.vy) < 0.05) c.vy = -0.25 * sc; }
        if (c.x < -cw || c.x > W) { live.splice(k, 1); continue; }
        ctx.drawImage(c.img, c.x, c.y, cw, ch);
      }
      if ((!queue.length && !live.length) || ts - t0 > 14000) { finishFxOf(ui); return; }
      fx.raf = requestAnimationFrame(frame);
    }
    fx.raf = requestAnimationFrame(frame);
  }
  function stopFxOf(ui) {
    if (!ui || !ui.fx) return;
    cancelAnimationFrame(ui.fx.raf);
    if (ui.fx.cv.parentNode) ui.fx.cv.parentNode.removeChild(ui.fx.cv);
    ui.fx = null;
    for (var id = 0; id < ui.cards.length; id++) ui.cards[id].style.visibility = '';
  }
  function finishFxOf(ui) {
    if (!ui || !ui.fx) return;
    var done = ui.fx.done;
    stopFxOf(ui);
    done();
  }
  // A menu can be taller than a short table (a phone in portrait): while one is
  // open the table grows to fit the whole card, so its buttons aren't cut off.
  function fitOverlay(ui) {
    var card = ui.ov.firstElementChild;
    ui.table.style.minHeight = '';
    if (!card) return;
    var need = card.offsetHeight + 36;           // .sp-ov's top + bottom padding
    if (need > ui.table.offsetHeight) ui.table.style.minHeight = need + 'px';
  }
  function toolHtml(act, icon, label, title, extra) {
    return '<button class="sp-tool" data-tool="' + act + '" title="' + title + '"><span class="sp-ti">' + icon + (extra || '') + '</span><span class="sp-tl">' + label + '</span></button>';
  }

  // =================================================================================
  // SPIDER — one instance; mount() builds the table into the panel, unmount() tears
  // it down (listeners, timers, animation frames) and saves.
  // =================================================================================
  function SpiderMode(shell) {
    var SAVE_KEY = 'cade-spider-save', STATS_KEY = 'cade-spider-stats', PREFS_KEY = 'cade-spider-prefs';
    var SUITS = [1, 2, 4];
    var SUIT_LABEL = { 1: '1 suit', 2: '2 suits', 4: '4 suits' };
    var SUIT_LEVEL = { 1: 'Beginner', 2: 'Intermediate', 4: 'Expert' };
    var COLLECT_MS = 280;           // a finished run rests on its column this long before flying home

    var core = null, st = null;     // engine + live tableau (derived from game.toks)
    var game = null;                // { suits, deal, toks[], redo[], mv, t, done, counted, started }
    var stats = {}, prefs = { suits: 1, classic: true, tap: 'auto' };
    var ui = null;
    var runSince = 0, tickIv = 0;

    function score() { return game ? 500 - game.mv + 100 * st.found.length : 500; }

    // ---- persistence ------------------------------------------------------------
    function loadState() {
      var p = readJSON(PREFS_KEY, {});
      if (p && typeof p === 'object') {
        if (SUITS.indexOf(p.suits) !== -1) prefs.suits = p.suits;
        if (typeof p.classic === 'boolean') prefs.classic = p.classic;
        if (p.tap === 'auto' || p.tap === 'select') prefs.tap = p.tap;
      }
      stats = readJSON(STATS_KEY, {});
      if (!stats || typeof stats !== 'object') stats = {};
      var s = readJSON(SAVE_KEY, null);
      game = null;
      if (s && typeof s === 'object' && SUITS.indexOf(s.suits) !== -1 && s.deal > 0) {
        var toks = String(s.toks || '').split(',').filter(Boolean);
        var r = core.replay(s.deal, s.suits, toks);
        if (r.bad >= 0) toks = toks.slice(0, r.bad);          // corrupt tail: keep what replays
        game = {
          suits: s.suits, deal: s.deal >>> 0, toks: toks, redo: r.bad >= 0 ? [] : String(s.redo || '').split(',').filter(Boolean),
          mv: +s.mv || 0, t: +s.t || 0, done: s.done ? 1 : 0, counted: s.counted ? 1 : 0, started: s.started ? 1 : 0
        };
        st = r.st;
        if (core.won(st)) game.done = 1;
      }
    }
    function persist() {
      if (!game) return;
      foldClock();
      writeJSON(SAVE_KEY, {
        suits: game.suits, deal: game.deal, toks: game.toks.join(','), redo: game.redo.join(','),
        mv: game.mv, t: Math.round(game.t), done: game.done, counted: game.counted, started: game.started
      });
    }
    function savePrefs() { writeJSON(PREFS_KEY, prefs); }
    function saveStats() { writeJSON(STATS_KEY, stats); }
    function stat(s) { return stats[s] = stats[s] || {}; }

    // ---- clock: runs from the first move, only while the table is visible -------
    function elapsed() { return game ? game.t + (runSince ? now() - runSince : 0) : 0; }
    function foldClock() { if (runSince && game) { var n = now(); game.t += n - runSince; runSince = n; } }
    function stopClock() { foldClock(); runSince = 0; }
    function canRun() { return !!(ui && game && game.started && !game.done && !ui.ovKind && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(ui.panel))); }
    function syncClock() { if (canRun()) { if (!runSince) runSince = now(); } else stopClock(); paintHud(); }

    // ---- game flow ----------------------------------------------------------------
    function newGame(suits, dealNo) {
      if (game && game.counted && !game.done) { stat(game.suits).cs = 0; saveStats(); }   // abandoned = streak over
      stopClock();
      game = { suits: suits, deal: dealNo || randomDeal(), toks: [], redo: [], mv: 0, t: 0, done: 0, counted: 0, started: 0 };
      st = core.deal(game.deal, suits);
      prefs.suits = suits; savePrefs();
      persist();
      if (!ui) return;
      stopFx();
      hideOverlay();
      resetTransient();
      paintFaces();
      // Deal animation: every card starts on the stock, then flies to its column.
      var stagger = {}, order = 0;
      for (var i = 0; i < 6; i++) for (var p = 0; p < 10; p++) if (st.piles[p][i] !== undefined) stagger[st.piles[p][i]] = (order++) * 14;
      if (!reduced()) {
        place(false, null, true);
        void ui.table.offsetWidth;
      }
      place(true, stagger);
      lockFor(order * 14 + 260);
      syncClock();
    }
    function begin() {
      if (!game.started) { game.started = 1; syncClock(); }
      if (!game.counted) { game.counted = 1; stat(game.suits).p = (stat(game.suits).p || 0) + 1; saveStats(); }
    }
    function afterChange() {
      ui.hints = null; ui.stuckShown = false;
      persist();
      paintHud();
    }
    function lockFor(ms) { if (ui) ui.lockUntil = Math.max(ui.lockUntil || 0, now() + ms); }
    function busy() { return !ui || now() < (ui.lockUntil || 0) || !!ui.fx; }
    function playable() { return !!(ui && game && !game.done && !busy() && !ui.ovKind); }

    function doMove(p, n, q) {
      if (!playable() || !core.legal(st, p, n, q)) return false;
      begin();
      clearSel(); clearHint();
      core.moveRaw(st, p, n, q);
      game.toks.push(core.token(p, n, q)); game.redo = []; game.mv++;
      haptic(8);
      place(true);
      if (core.completeAt(st, q)) {
        lockFor(COLLECT_MS + 60);
        ui.collectTimer = setTimeout(function () {
          if (!ui) return;
          core.collect(st, q);
          haptic(20);
          place(true);
          afterChange();
          checkWin();
          maybeStuck();
        }, reduced() ? 0 : COLLECT_MS);
      } else maybeStuck();
      afterChange();
      return true;
    }
    function deal() {
      if (!playable()) return;
      clearSel(); clearHint();
      if (!st.stock.length) { toast('The stock is empty'); return; }
      if (!core.canDeal(st, prefs.classic)) {
        toast('Fill every empty column before dealing');
        // Slots are positioned by transform, so flash them rather than shake.
        for (var p = 0; p < 10; p++) if (!st.piles[p].length) ui.slots[p].classList.add('sp-ht');
        clearTimeout(ui.hintTimer);
        ui.hintTimer = setTimeout(clearHint, 1200);
        haptic(15);
        return;
      }
      begin();
      var ids = core.dealRaw(st), stagger = {};
      for (var k = 0; k < ids.length; k++) stagger[ids[k]] = k * 45;
      game.toks.push('D'); game.redo = []; game.mv++;
      place(true, stagger);
      var full = false;
      for (p = 0; p < 10; p++) if (core.completeAt(st, p)) full = true;
      lockFor(10 * 45 + 200);
      if (full) {
        lockFor(10 * 45 + COLLECT_MS + 260);
        ui.collectTimer = setTimeout(function () {
          if (!ui) return;
          core.collectAll(st);
          place(true);
          afterChange();
          checkWin();
          maybeStuck();
        }, reduced() ? 0 : 10 * 45 + COLLECT_MS);
      } else maybeStuck();
      afterChange();
    }
    function undo() {
      if (!playable() || !game.toks.length) return;
      clearSel(); clearHint();
      game.redo.push(game.toks.pop());
      game.mv++;
      st = core.replay(game.deal, game.suits, game.toks).st;
      place(true);
      afterChange();
    }
    function redo() {
      if (!playable() || !game.redo.length) return;
      clearSel(); clearHint();
      var tok = game.redo.pop();
      if (!core.apply(st, tok)) { game.redo = []; paintHud(); return; }
      game.toks.push(tok); game.mv++;
      place(true);
      afterChange();
      checkWin();
    }
    function restart() {
      if (!game) return;
      if (game.started && !game.done && !window.confirm('Restart deal #' + game.deal + ' from the beginning?')) return;
      newGame(game.suits, game.deal);
    }
    function autoMove(p, i) {
      if (!playable()) return;
      var pile = st.piles[p];
      if (!core.canMoveFrom(st, p, i)) { shake(ui.cards[pile[i]]); return; }
      var q = core.bestTarget(st, p, i);
      if (q < 0) { for (var k = i; k < pile.length; k++) shake(ui.cards[pile[k]]); return; }
      ui.lastAuto = { id: pile[i], p: p, t: now() };
      doMove(p, pile.length - i, q);
    }
    function maybeStuck() {
      if (!ui || game.done || ui.stuckShown || st.stock.length) return;
      if (core.hints(st, prefs.classic).length) return;
      ui.stuckShown = true;
      setTimeout(function () { if (ui && !game.done) toast('No useful moves left — try Undo or a new deal'); }, 500);
    }

    function checkWin() {
      if (!game || game.done || !core.won(st)) return;
      stopClock();
      game.done = 1;
      var s = stat(game.suits), sc = score(), t = Math.round(game.t), bestT = false, bestS = false;
      s.w = (s.w || 0) + 1;
      s.cs = (s.cs || 0) + 1; s.ms = Math.max(s.ms || 0, s.cs);
      if (!s.bt || t < s.bt) { bestT = !!s.bt; s.bt = t; }
      if (s.bs == null || sc > s.bs) { bestS = s.bs != null; s.bs = sc; }
      saveStats(); persist(); paintHud();
      haptic(40);
      var html = '<div class="sp-card"><div class="sp-big">🎉</div><b class="sp-title">You won!</b>' +
        '<div class="sp-sub">' + SUIT_LABEL[game.suits] + ' · deal #' + game.deal + '</div>' +
        '<div class="sp-winrow"><div><b>' + sc + '</b><span>score</span></div><div><b>' + fmtTime(t) + '</b><span>time</span></div><div><b>' + game.mv + '</b><span>moves</span></div></div>' +
        '<div class="sp-sub">' + (s.w === 1 ? 'First win with ' + SUIT_LABEL[game.suits] + '!' : bestS && bestT ? 'New best score and time!' : bestS ? 'New best score!' : bestT ? 'New best time!' : 'Best ' + s.bs + ' · ' + fmtTime(s.bt)) +
        (s.cs > 1 ? ' · streak ' + s.cs : '') + '</div>' +
        '<div class="sp-acts"><button class="sp-primary" data-act="newsame">New game</button><button data-act="newmenu">Change suits</button><button data-act="stats">Stats</button></div></div>';
      cascade(function () { if (ui && game.done) showOverlay('win', html); });
    }

    // ---- layout + rendering -------------------------------------------------------------
    // L = metrics in px: card width/height, column x, offsets for face-down/face-up cards.
    function layout() {
      if (!ui) return false;
      var W = ui.table.clientWidth;
      if (!W) return false;
      var gap = W < 400 ? 2 : W < 520 ? 3 : 6;
      var cw = Math.min(84, Math.floor((W - gap * 11) / 10));
      var ch = Math.round(cw * 1.4);
      var x0 = Math.round((W - (cw * 10 + gap * 9)) / 2), xs = [];
      for (var p = 0; p < 10; p++) xs.push(x0 + p * (cw + gap));
      var vh = window.innerHeight || 600;
      if (window.visualViewport && window.visualViewport.height) vh = Math.min(vh, window.visualViewport.height);
      var top = ui.table.getBoundingClientRect().top, below = ui.tools.offsetHeight + 22;
      var pilesY = gap + ch + Math.max(8, gap * 2);
      var L = {
        W: W, gap: gap, cw: cw, ch: ch, xs: xs, pilesY: pilesY,
        fu: Math.max(17, Math.round(ch * 0.27)), fd: Math.max(5, Math.round(ch * 0.11)),
        maxH: Math.max(pilesY + ch * 3.4, vh - top - below)
      };
      ui.L = L;
      ui.table.style.setProperty('--cw', cw + 'px');
      ui.table.style.setProperty('--ch', ch + 'px');
      for (p = 0; p < 10; p++) setXY(ui.slots[p], xs[p], pilesY);
      setXY(ui.foundSlot, xs[0], gap);
      setXY(ui.stockSlot, xs[9], gap);
      return true;
    }

    // Positions of every card for the current state; `allAtStock` puts them all
    // on the stock (the starting frame of the deal animation).
    function computePos(allAtStock) {
      var L = ui.L, pos = [], loc = [], p, i, k, bottom = L.pilesY + L.ch * 3.2;
      var stockX = L.xs[9], sOff = Math.max(4, Math.round(L.cw * 0.2)), G = st.stock.length / 10;
      if (allAtStock) {
        for (k = 0; k < 104; k++) { pos[k] = { x: stockX, y: L.gap, z: 300 + k, up: false }; loc[k] = { k: 's' }; }
        return { pos: pos, loc: loc, h: bottom };
      }
      for (k = 0; k < st.stock.length; k++) {
        var gi = (k / 10) | 0;
        pos[st.stock[k]] = { x: stockX - (G - 1 - gi) * sOff, y: L.gap, z: 300 + k, up: false };
        loc[st.stock[k]] = { k: 's' };
      }
      var span = 5 * (L.cw + L.gap) - L.gap - L.cw, fOff = Math.min(L.cw + L.gap, Math.floor(span / 7));
      for (var f = 0; f < st.found.length; f++) {
        var run = st.found[f];
        for (k = 0; k < run.length; k++) {           // K on top, as it was the column's base
          pos[run[k]] = { x: L.xs[0] + f * fOff, y: L.gap, z: 100 + f * 13 + (12 - k), up: true };
          loc[run[k]] = { k: 'f' };
        }
      }
      var avail = L.maxH - L.pilesY - L.ch - 4;
      for (p = 0; p < 10; p++) {
        var pile = st.piles[p], down = Math.min(st.down[p], pile.length), up = pile.length - down;
        var fd = L.fd, fu = L.fu;
        // Long columns squeeze to fit the screen: face-down cards first, then face-up.
        if (down * fd + Math.max(0, up - 1) * fu > avail) {
          fd = Math.min(fd, 3);
          if (up > 1 && down * fd + (up - 1) * fu > avail) fu = Math.max(7, Math.floor((avail - down * fd) / (up - 1)));
        }
        var y = L.pilesY;
        for (i = 0; i < pile.length; i++) {
          pos[pile[i]] = { x: L.xs[p], y: y, z: 10 + i, up: i >= down };
          loc[pile[i]] = { k: 'p', p: p, i: i };
          y += i < down ? fd : fu;
        }
        if (pile.length) bottom = Math.max(bottom, y - (pile.length - 1 < down ? fd : fu) + L.ch);
      }
      return { pos: pos, loc: loc, h: bottom };
    }

    function place(animate, stagger, allAtStock) {
      if (!ui || !ui.L || !st) return;
      var anim = animate && !reduced();
      var r = computePos(allAtStock), pos = r.pos, prev = ui.pos || [], moved = [], maxDelay = 0;
      if (!anim) ui.table.classList.add('sp-noanim');
      for (var id = 0; id < 104; id++) {
        var P = pos[id], O = prev[id], el = ui.cards[id];
        if (!P) continue;
        if (!O || O.x !== P.x || O.y !== P.y) {
          var d = stagger && stagger[id] ? stagger[id] : 0;
          if (d > maxDelay) maxDelay = d;
          el.style.transitionDelay = anim && d ? d + 'ms' : '';
          // While flying, a card rides above everything; real z comes back after.
          el.style.zIndex = anim && O ? 1000 + P.z : P.z;
          if (anim && O) moved.push(id);
          el.style.transform = 'translate3d(' + P.x + 'px,' + P.y + 'px,0)';
        } else if (O.z !== P.z) el.style.zIndex = P.z;
        if (!O || O.up !== P.up) {
          el.classList.toggle('dn', !P.up);
          if (anim && O && P.up) flipFx(el, stagger && stagger[id] ? stagger[id] : 0);
        }
      }
      ui.pos = pos; ui.loc = r.loc;
      ui.table.style.height = Math.ceil(Math.max(r.h + 6, ui.L.pilesY + ui.L.ch * 3.2)) + 'px';
      ui.stockSlot.classList.toggle('empty', !st.stock.length);
      if (!anim) { void ui.table.offsetWidth; ui.table.classList.remove('sp-noanim'); }
      if (moved.length) {
        clearTimeout(ui.zTimer);
        var settle = ui.settle || [];
        ui.settle = settle.concat(moved);
        ui.zTimer = setTimeout(function () {
          if (!ui) return;
          ui.settle.forEach(function (k) { var Q = ui.pos[k]; ui.cards[k].style.zIndex = Q ? Q.z : ''; ui.cards[k].style.transitionDelay = ''; });
          ui.settle = [];
        }, maxDelay + 320);
      }
    }
    function paintFaces() {
      if (!ui) return;
      var S = st.S;
      if (ui.facesFor === game.suits) return;
      ui.facesFor = game.suits;
      for (var id = 0; id < 104; id++) {
        var r = core.R(id), g = GLYPH[S[id]];
        var el = ui.cards[id];
        el.className = 'sp-c' + (S[id] === 1 || S[id] === 3 ? ' red' : '') + (ui.pos && ui.pos[id] && !ui.pos[id].up ? ' dn' : (ui.pos ? '' : ' dn'));
        el.firstChild.innerHTML = '<span class="sp-cr' + (r === 10 ? ' ten' : '') + '"><b>' + RANKS[r] + '</b><i>' + g + '</i></span><span class="sp-pip">' + g + '</span>';
      }
    }
    function paintHud() {
      if (!ui || !game) return;
      var set = function (el, v) { v = String(v); if (el.textContent !== v) el.textContent = v; };
      set(ui.hudScore, score());
      set(ui.hudMoves, game.mv);
      set(ui.hudTime, fmtTime(elapsed()));
      set(ui.hudDeal, SUIT_LABEL[game.suits] + ' · #' + game.deal);
      var left = st.stock.length / 10;
      set(ui.dealBadge, left);
      ui.dealBtn.disabled = !left || !!game.done;
      ui.undoBtn.disabled = !game.toks.length || !!game.done;
      ui.redoBtn.disabled = !game.redo.length || !!game.done;
      ui.hintBtn.disabled = !!game.done;
      set(ui.stockCount, left ? String(left) : '');
    }

    // ---- selection + hints --------------------------------------------------------------
    function clearSel() {
      if (!ui || !ui.sel) return;
      ui.sel.ids.forEach(function (id) { ui.cards[id].classList.remove('sp-sel'); });
      ui.sel = null;
    }
    function select(p, i) {
      clearSel();
      var ids = st.piles[p].slice(i);
      ids.forEach(function (id) { ui.cards[id].classList.add('sp-sel'); });
      ui.sel = { p: p, i: i, ids: ids };
    }
    function clearHint() {
      if (!ui) return;
      clearTimeout(ui.hintTimer);
      var on = ui.table.querySelectorAll('.sp-hs, .sp-ht');
      for (var k = 0; k < on.length; k++) on[k].classList.remove('sp-hs', 'sp-ht');
    }
    function hint() {
      if (!playable()) return;
      clearSel();
      if (!ui.hints) { ui.hints = core.hints(st, prefs.classic); ui.hintIdx = 0; }
      if (!ui.hints.length) { toast(st.stock.length ? 'Fill the empty columns, then deal' : 'No useful moves left — try Undo or a new deal'); return; }
      var h = ui.hints[ui.hintIdx++ % ui.hints.length];
      clearHint();
      if (h.deal) {
        ui.stockSlot.classList.add('sp-ht');
        st.stock.slice(-10).forEach(function (id) { ui.cards[id].classList.add('sp-ht'); });
      } else {
        var pile = st.piles[h.p], tq = st.piles[h.q];
        pile.slice(pile.length - h.n).forEach(function (id) { ui.cards[id].classList.add('sp-hs'); });
        if (tq.length) ui.cards[tq[tq.length - 1]].classList.add('sp-ht'); else ui.slots[h.q].classList.add('sp-ht');
      }
      ui.hintTimer = setTimeout(clearHint, 1700);
    }

    // ---- pointer: drag, tap, double-tap -------------------------------------------------
    function hitTest(e) {
      var t = e.target, card = t.closest ? t.closest('.sp-c') : null;
      if (card && ui.loc) {
        var id = +card.getAttribute('data-id'), l = ui.loc[id];
        if (l && l.k === 'p') return { k: 'p', p: l.p, i: l.i, id: id };
        if (l && l.k === 's') return { k: 's' };
        return null;
      }
      if (t.closest && t.closest('.sp-stock')) return { k: 's' };
      // Empty column / felt below a column = that column.
      var r = ui.table.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, L = ui.L;
      if (y < L.pilesY - L.gap) return null;
      for (var p = 0; p < 10; p++) if (x >= L.xs[p] - L.gap / 2 && x < L.xs[p] + L.cw + L.gap / 2) return { k: 'p', p: p, i: -1 };
      return null;
    }
    function onDown(e) {
      if (!ui || (e.button && e.button > 0)) return;
      if (ui.fx) { e.preventDefault(); finishFx(); return; }
      // A drag whose pointerup never arrived (lost capture, second finger) is cancelled.
      if (ui.drag) onUp({ pointerId: ui.drag.id }, true);
      if (ui.ovKind || !game || game.done) return;
      e.preventDefault();
      try { ui.root.focus({ preventScroll: true }); } catch (x) {}
      ui.drag = { hit: hitTest(e), x0: e.clientX, y0: e.clientY, id: e.pointerId, started: false };
      try { ui.table.setPointerCapture(e.pointerId); } catch (x) {}
    }
    function onMove(e) {
      var d = ui && ui.drag;
      if (!d || d.id !== e.pointerId) return;
      var dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      if (!d.started) {
        if (dx * dx + dy * dy < 64) return;
        var h = d.hit;
        if (!h || h.k !== 'p' || h.i < 0 || busy() || !core.canMoveFrom(st, h.p, h.i)) { d.dead = true; return; }
        d.started = true;
        clearSel(); clearHint();
        d.ids = st.piles[h.p].slice(h.i);
        d.ids.forEach(function (id, k) { var el = ui.cards[id]; el.classList.add('sp-drag'); el.style.zIndex = 3000 + k; el.style.transitionDelay = ''; });
      }
      d.dx = dx; d.dy = dy;
      if (!d.raf) d.raf = requestAnimationFrame(function () {
        d.raf = 0;
        if (!ui || ui.drag !== d) return;
        d.ids.forEach(function (id) { var P = ui.pos[id]; ui.cards[id].style.transform = 'translate3d(' + (P.x + d.dx) + 'px,' + (P.y + d.dy) + 'px,0)'; });
        var q = dropTarget(d);
        if (q !== d.over) {
          clearHint();
          d.over = q;
          if (q >= 0) { var tq = st.piles[q]; (tq.length ? ui.cards[tq[tq.length - 1]] : ui.slots[q]).classList.add('sp-ht'); }
        }
      });
    }
    // The legal column the dragged cards overlap most (or the one under the pointer).
    function dropTarget(d) {
      var L = ui.L, P = ui.pos[d.ids[0]], x = P.x + d.dx, n = d.ids.length, best = -1, bestOv = 0;
      for (var q = 0; q < 10; q++) {
        if (!core.legal(st, d.hit.p, n, q)) continue;
        var ov = L.cw - Math.abs(L.xs[q] - x);
        if (ov > bestOv) { bestOv = ov; best = q; }
      }
      return best;
    }
    function onUp(e, cancel) {
      var d = ui && ui.drag;
      if (!d || d.id !== e.pointerId) return;
      ui.drag = null;
      if (d.raf) cancelAnimationFrame(d.raf);
      if (d.started) {
        clearHint();
        var q = cancel ? -1 : dropTarget(d);
        d.ids.forEach(function (id) { ui.cards[id].classList.remove('sp-drag'); if (ui.pos[id]) ui.pos[id] = { x: NaN, y: NaN, z: ui.pos[id].z, up: ui.pos[id].up }; });
        if (q < 0 || !doMove(d.hit.p, d.ids.length, q)) place(true);    // snap back
        return;
      }
      if (!cancel && !d.dead) tap(d.hit);
    }
    function tap(hit) {
      if (!playable()) return;
      if (!hit) { clearSel(); return; }
      if (hit.k === 's') { deal(); return; }
      var t = now();
      var dbl = ui.lastTap && ui.lastTap.id === hit.id && hit.i >= 0 && t - ui.lastTap.t < 380;
      ui.lastTap = { id: hit.id, t: t };
      if (prefs.tap === 'auto') {
        // A double-click's second click lands on the card that just moved (or on
        // the one it uncovered): ignore it rather than move again.
        if (ui.lastAuto && (ui.lastAuto.id === hit.id || ui.lastAuto.p === hit.p) && t - ui.lastAuto.t < 420) return;
        if (hit.i >= 0) autoMove(hit.p, hit.i); else clearSel();
        return;
      }
      // Select mode: tap cards, then tap the destination column.
      var s = ui.sel;
      if (s) {
        if (hit.p === s.p) {
          if (dbl || hit.i === s.i) { clearSel(); autoMove(hit.p, hit.i >= 0 ? hit.i : s.i); return; }
          if (hit.i >= 0 && core.canMoveFrom(st, hit.p, hit.i)) select(hit.p, hit.i); else clearSel();
          return;
        }
        var n = st.piles[s.p].length - s.i;
        if (core.legal(st, s.p, n, hit.p)) { doMove(s.p, n, hit.p); return; }
        if (hit.i >= 0 && core.canMoveFrom(st, hit.p, hit.i)) { select(hit.p, hit.i); return; }
        s.ids.forEach(function (id) { shake(ui.cards[id]); });
        clearSel();
        return;
      }
      if (hit.i < 0) return;
      if (core.canMoveFrom(st, hit.p, hit.i)) select(hit.p, hit.i);
      else shake(ui.cards[hit.id]);
    }

    // ---- win cascade (shared) ---------------------------------------------------------
    function cascade(done) {
      if (!ui) { done(); return; }
      var queue = [];
      for (var lvl = 0; lvl < 13; lvl++) for (var f = 0; f < st.found.length; f++) queue.push(st.found[f][lvl]);
      cascadeFx(ui, queue, function (cid) { return { r: core.R(cid), s: st.S[cid] }; }, done);
    }
    function stopFx() { stopFxOf(ui); }
    function finishFx() { finishFxOf(ui); }

    // ---- overlays -----------------------------------------------------------------------
    function showOverlay(kind, html) {
      if (!ui) return;
      ui.ovKind = kind;
      ui.ov.className = 'sp-ov show';
      ui.ov.innerHTML = html;
      fitOverlay(ui);
      clearSel();
      syncClock();
    }
    function hideOverlay() {
      if (!ui) return;
      ui.ovKind = '';
      ui.ov.className = 'sp-ov';
      ui.ov.innerHTML = '';
      ui.table.style.minHeight = '';
      syncClock();
    }
    function suitIcons(s) { return s === 1 ? GLYPH[0] : s === 2 ? GLYPH[0] + GLYPH[1] : GLYPH.join(''); }
    function newMenu() {
      var rows = '';
      SUITS.forEach(function (s) {
        var x = stats[s] || {};
        rows += '<button class="sp-pick" data-act="new" data-suits="' + s + '"><b><span class="sp-pk-s">' + suitIcons(s) + '</span>' + SUIT_LABEL[s] +
          '</b><span>' + SUIT_LEVEL[s] + (x.p ? ' · won ' + (x.w || 0) + '/' + x.p : '') + '</span></button>';
      });
      showOverlay('menu', '<div class="sp-card"><b class="sp-title">New game</b><div class="sp-list">' + rows + '</div>' +
        '<div class="sp-acts">' + (game ? '<button data-act="replay">↺ Replay #' + game.deal + '</button>' : '') +
        '<button data-act="dealno">Deal number…</button>' + (game ? '<button data-act="hide">Cancel</button>' : '') + '</div></div>');
    }
    function moreMenu() {
      showOverlay('menu', '<div class="sp-card"><b class="sp-title">Spider</b><div class="sp-list">' +
        '<button data-act="restart">↺ Restart this deal</button>' +
        '<button data-act="stats">📊 Statistics</button>' +
        '<button data-act="classic" class="sp-tog' + (prefs.classic ? ' on' : '') + '">' + (prefs.classic ? '☑' : '☐') + ' Deal only when no column is empty</button>' +
        '<button data-act="tapmode" class="sp-tog' + (prefs.tap === 'select' ? ' on' : '') + '">' + (prefs.tap === 'select' ? '☑' : '☐') + ' Tap to select, then tap the target</button>' +
        '</div><div class="sp-hint">' + (prefs.tap === 'select' ? 'Double-tap a card to send it to its best spot.' : 'Tap (or double-click) a card to send it to its best spot.') +
        ' Drag works too.<br>Keys: Ctrl+Z / Ctrl+Y undo/redo · H hint · D deal · N new game · Esc close</div>' +
        '<div class="sp-acts"><button class="sp-primary" data-act="hide">Close</button></div></div>');
    }
    function statsMenu() {
      var rows = '';
      SUITS.forEach(function (s) {
        var x = stats[s] || {};
        rows += '<tr><td>' + SUIT_LABEL[s] + '</td><td>' + (x.w || 0) + '/' + (x.p || 0) + '</td><td>' + (x.p ? Math.round(100 * (x.w || 0) / x.p) + '%' : '—') +
          '</td><td>' + (x.bt ? fmtTime(x.bt) : '—') + '</td><td>' + (x.bs != null ? x.bs : '—') + '</td><td>' + (x.ms || 0) + '</td></tr>';
      });
      showOverlay('stats', '<div class="sp-card"><b class="sp-title">Statistics</b>' +
        '<table class="sp-stats"><thead><tr><th></th><th>Won</th><th>%</th><th>Best time</th><th>Best score</th><th>Streak</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div class="sp-acts"><button data-act="resetstats">Reset</button><button class="sp-primary" data-act="hide">Close</button></div></div>');
    }
    function onOverlayClick(e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      var act = b.getAttribute('data-act');
      var abandon = function () { return !game || !game.started || game.done || window.confirm('Abandon the game in progress?'); };
      if (act === 'hide') { if (game) hideOverlay(); }
      else if (act === 'new') { if (abandon()) newGame(+b.getAttribute('data-suits'), 0); }
      else if (act === 'newsame') newGame(game ? game.suits : prefs.suits, 0);
      else if (act === 'newmenu') newMenu();
      else if (act === 'replay') { if (abandon()) newGame(game.suits, game.deal); }
      else if (act === 'restart') restart();
      else if (act === 'dealno') {
        var v = window.prompt('Deal number (1–999999):', game ? String(game.deal) : '');
        if (v == null) return;
        var n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
        if (!(n >= 1 && n <= 999999)) { toast('Enter a number from 1 to 999999', 'error'); return; }
        if (abandon()) newGame(game ? game.suits : prefs.suits, n);
      }
      else if (act === 'stats') statsMenu();
      else if (act === 'classic') { prefs.classic = !prefs.classic; savePrefs(); ui.hints = null; moreMenu(); }
      else if (act === 'tapmode') { prefs.tap = prefs.tap === 'select' ? 'auto' : 'select'; savePrefs(); clearSel(); moreMenu(); }
      else if (act === 'resetstats') { if (window.confirm('Reset all Spider statistics?')) { stats = {}; saveStats(); statsMenu(); } }
    }

    // ---- table DOM -----------------------------------------------------------------------
    function buildHtml() {
      var cards = '', slots = '';
      for (var id = 0; id < 104; id++) cards += '<div class="sp-c dn" data-id="' + id + '"><div class="sp-in"></div></div>';
      for (var p = 0; p < 10; p++) slots += '<div class="sp-slot" data-p="' + p + '"></div>';
      return '<div class="sp" tabindex="-1">' +
        '<div class="sp-top"><button class="sp-btn sp-deal" data-tool="new" title="New game"></button>' +
          '<span class="sp-hud">Score <b class="sp-score"></b></span><span class="sp-hud">Moves <b class="sp-moves"></b></span>' +
          '<span class="sp-time"></span></div>' +
        '<div class="sp-wrap"><div class="sp-table">' + slots +
          '<div class="sp-slot sp-found"></div><div class="sp-slot sp-stock"><span class="sp-stock-n"></span></div>' + cards +
        '</div><div class="sp-ov"></div></div>' +
        '<div class="sp-tools">' +
          toolHtml('undo', '↶', 'Undo', 'Undo (Ctrl+Z)') + toolHtml('redo', '↷', 'Redo', 'Redo (Ctrl+Y)') +
          toolHtml('hint', '💡', 'Hint', 'Show a move (H) — press again for the next one') +
          toolHtml('deal', '🂠', 'Deal', 'Deal a row from the stock (D)', '<span class="sp-badge"></span>') +
          toolHtml('new', '✚', 'New', 'New game (N)') + toolHtml('more', '⋯', 'More', 'Options and statistics') +
        '</div></div>';
    }

    function resetTransient() {
      if (!ui) return;
      clearSel(); clearHint();
      ui.hints = null; ui.drag = null; ui.lastTap = null; ui.lastAuto = null; ui.stuckShown = false;
      clearTimeout(ui.collectTimer);
    }
    function relayout() {
      if (!ui || ui.relayoutRaf) return;
      ui.relayoutRaf = requestAnimationFrame(function () {
        if (!ui) return;
        ui.relayoutRaf = 0;
        var w = ui.table.clientWidth;
        if (!layout()) return;
        if (ui.fx && w !== ui.lastW) finishFx();
        ui.lastW = w;
        place(false);
      });
    }

    function close() { shell.close(); }
    function unmount() {
      if (!ui) return;
      stopFx();
      clearTimeout(ui.readyTimer);
      stopClock();
      clearTimeout(ui.collectTimer); clearTimeout(ui.zTimer); clearTimeout(ui.hintTimer);
      if (ui.relayoutRaf) cancelAnimationFrame(ui.relayoutRaf);
      if (ui.drag && ui.drag.raf) cancelAnimationFrame(ui.drag.raf);
      // A run that was about to fly home is already part of the saved move list.
      persist();
      clearInterval(tickIv); tickIv = 0;
      document.removeEventListener('keydown', ui.onKey, true);
      document.removeEventListener('visibilitychange', ui.onVis);
      ui.panel.removeEventListener('cade-panel-minimize', ui.onMin);
      ui.panel.removeEventListener('cade-panel-restore', ui.onVis);
      window.removeEventListener('pagehide', ui.onHide);
      window.removeEventListener('resize', relayout);
      if (ui.ro) ui.ro.disconnect();
      ui = null;
    }

    function mount(host, p) {
      core = core || SpiderCore();
      loadState();
      host.innerHTML = buildHtml();
      var root = host.querySelector('.sp');
      ui = {
        panel: p, root: root, table: root.querySelector('.sp-table'), ov: root.querySelector('.sp-ov'),
        tools: root.querySelector('.sp-tools'), cards: [], slots: [],
        foundSlot: root.querySelector('.sp-found'), stockSlot: root.querySelector('.sp-stock'),
        stockCount: root.querySelector('.sp-stock-n'),
        hudScore: root.querySelector('.sp-score'), hudMoves: root.querySelector('.sp-moves'),
        hudTime: root.querySelector('.sp-time'), hudDeal: root.querySelector('.sp-deal'),
        dealBtn: root.querySelector('[data-tool="deal"]'), dealBadge: root.querySelector('.sp-badge'),
        undoBtn: root.querySelector('[data-tool="undo"]'), redoBtn: root.querySelector('[data-tool="redo"]'),
        hintBtn: root.querySelector('[data-tool="hint"]'),
        ovKind: '', pos: null, loc: null, L: null, facesFor: 0
      };
      root.querySelectorAll('.sp-c').forEach(function (el) { ui.cards[+el.getAttribute('data-id')] = el; });
      root.querySelectorAll('.sp-slot[data-p]').forEach(function (el) { ui.slots[+el.getAttribute('data-p')] = el; });

      ui.onKey = onKey;
      ui.onVis = function () { if (!ui) return; if (document.hidden) persist(); syncClock(); };
      ui.onHide = function () { persist(); };
      // Minimized to the dock counts as hidden: the clock stops until restore.
      ui.onMin = function () { if (!ui) return; persist(); syncClock(); };
      p.addEventListener('cade-panel-minimize', ui.onMin);
      p.addEventListener('cade-panel-restore', ui.onVis);
      document.addEventListener('keydown', ui.onKey, true);
      document.addEventListener('visibilitychange', ui.onVis);
      window.addEventListener('pagehide', ui.onHide);
      window.addEventListener('resize', relayout);
      if (typeof ResizeObserver !== 'undefined') {
        ui.ro = new ResizeObserver(function () { if (ui && ui.table.clientWidth !== ui.lastW) relayout(); });
        ui.ro.observe(ui.table);
      }

      var table = ui.table;
      table.addEventListener('pointerdown', onDown);
      table.addEventListener('pointermove', onMove);
      table.addEventListener('pointerup', function (e) { onUp(e, false); });
      table.addEventListener('pointercancel', function (e) { onUp(e, true); });
      table.addEventListener('lostpointercapture', function (e) { if (ui && ui.drag && ui.drag.id === e.pointerId) onUp(e, true); });
      root.addEventListener('click', function (e) {
        if (!ui) return;
        var t = e.target;
        if (ui.ov.contains(t)) { onOverlayClick(e); return; }
        var tl = t.closest ? t.closest('[data-tool]') : null;
        if (!tl || tl.disabled) return;
        var a = tl.getAttribute('data-tool');
        if (a === 'undo') undo();
        else if (a === 'redo') redo();
        else if (a === 'hint') hint();
        else if (a === 'deal') deal();
        else if (a === 'new') newMenu();
        else if (a === 'more') moreMenu();
      });

      try { root.focus({ preventScroll: true }); } catch (e) {}
      tickIv = setInterval(function () { if (ui && runSince) paintHud(); }, 500);
      // Card metrics come from the table's width: on the very first open the
      // stylesheet may still be loading, so wait (briefly) until it applies.
      var tries = 0;
      (function start() {
        if (!ui) return;
        if (getComputedStyle(ui.table).position !== 'relative' && tries++ < 40) { ui.readyTimer = setTimeout(start, 50); return; }
        layout();
        ui.lastW = ui.table.clientWidth;
        if (!game) newGame(prefs.suits, 0);
        else {
          paintFaces();
          place(false);
          paintHud();
          syncClock();
          if (game.done) checkWinOverlay();
        }
      })();
    }
    function checkWinOverlay() {
      var s = stats[game.suits] || {};
      showOverlay('win', '<div class="sp-card"><div class="sp-big">🏆</div><b class="sp-title">Deal #' + game.deal + ' won</b>' +
        '<div class="sp-sub">Score ' + score() + ' · ' + fmtTime(game.t) + ' · ' + game.mv + ' moves</div>' +
        '<div class="sp-sub">Best ' + (s.bs != null ? s.bs : '—') + ' · ' + (s.bt ? fmtTime(s.bt) : '—') + '</div>' +
        '<div class="sp-acts"><button class="sp-primary" data-act="newsame">New game</button><button data-act="newmenu">Change suits</button></div></div>');
    }

    function onKey(e) {
      if (!ui) return;
      if (Cade.isMinimized && Cade.isMinimized(ui.panel)) return; // parked in the dock: keys belong to the editor
      var ae = document.activeElement;
      if (ae && ae !== document.body && !ui.panel.contains(ae) && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) return;
      var k = e.key, mod = e.ctrlKey || e.metaKey, handled = true;
      if (k === 'Escape') {
        if (ui.fx) finishFx();
        else if (ui.ovKind && game && ui.ovKind !== 'win') hideOverlay();
        else if (ui.sel) clearSel();
        else close();
      } else if (mod && !e.altKey && (k === 'z' || k === 'Z')) { if (e.shiftKey) redo(); else undo(); }
      else if (mod && !e.altKey && (k === 'y' || k === 'Y')) redo();
      else if (mod || e.altKey) handled = false;
      else if (ui.ovKind) handled = false;
      else if (k === 'h' || k === 'H') hint();
      else if (k === 'd' || k === 'D') deal();
      else if (k === 'u' || k === 'U') undo();
      else if (k === 'n' || k === 'N') newMenu();
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }

    return { mount: mount, unmount: unmount };
  }

  // =================================================================================
  // KLONDIKE — same shape as Spider: mount() / unmount(), state replayed from tokens.
  // =================================================================================
  function KlondikeMode(shell) {
    var SAVE_KEY = 'cade-klondike-save', STATS_KEY = 'cade-klondike-stats', PREFS_KEY = 'cade-klondike-prefs';
    var DRAWS = [1, 3];
    var DRAW_LABEL = { 1: 'Draw 1', 3: 'Draw 3' };
    var DRAW_LEVEL = { 1: 'One card at a time', 3: 'Three at a time · classic' };
    var FND = 'abcd';
    var DRAW_MS = 70;               // stagger between cards turned from the stock
    var HOME_MS = 60;               // stagger between cards flying home on auto-finish

    var core = null, st = null;     // engine + live table (derived from game.toks)
    var game = null;                // { draw, deal, toks[], redo[], mv, t, done, counted, started }
    var stats = {}, prefs = { draw: 1, tap: 'auto', auto: true };
    var ui = null;
    var runSince = 0, tickIv = 0;

    function isT(k) { return typeof k === 'string' && k.length === 1 && k >= '0' && k <= '6'; }
    function isF(k) { return typeof k === 'string' && k.length === 1 && FND.indexOf(k) !== -1; }
    function pile(k) { return core.pileOf(st, k); }

    // ---- persistence ------------------------------------------------------------
    function loadState() {
      var p = readJSON(PREFS_KEY, {});
      if (p && typeof p === 'object') {
        if (DRAWS.indexOf(p.draw) !== -1) prefs.draw = p.draw;
        if (p.tap === 'auto' || p.tap === 'select') prefs.tap = p.tap;
        if (typeof p.auto === 'boolean') prefs.auto = p.auto;
      }
      stats = readJSON(STATS_KEY, {});
      if (!stats || typeof stats !== 'object') stats = {};
      var s = readJSON(SAVE_KEY, null);
      game = null;
      if (s && typeof s === 'object' && DRAWS.indexOf(s.draw) !== -1 && s.deal > 0) {
        var toks = String(s.toks || '').split(',').filter(Boolean);
        var r = core.replay(s.deal, s.draw, toks);
        if (r.bad >= 0) toks = toks.slice(0, r.bad);          // corrupt tail: keep what replays
        game = {
          draw: s.draw, deal: s.deal >>> 0, toks: toks, redo: r.bad >= 0 ? [] : String(s.redo || '').split(',').filter(Boolean),
          mv: +s.mv || 0, t: +s.t || 0, done: s.done ? 1 : 0, counted: s.counted ? 1 : 0, started: s.started ? 1 : 0
        };
        st = r.st;
        if (core.won(st)) game.done = 1;
      }
    }
    function persist() {
      if (!game) return;
      foldClock();
      writeJSON(SAVE_KEY, {
        draw: game.draw, deal: game.deal, toks: game.toks.join(','), redo: game.redo.join(','),
        mv: game.mv, t: Math.round(game.t), done: game.done, counted: game.counted, started: game.started
      });
    }
    function savePrefs() { writeJSON(PREFS_KEY, prefs); }
    function saveStats() { writeJSON(STATS_KEY, stats); }
    function stat(d) { return stats[d] = stats[d] || {}; }

    // ---- clock: runs from the first move, only while the table is visible -------
    function elapsed() { return game ? game.t + (runSince ? now() - runSince : 0) : 0; }
    function foldClock() { if (runSince && game) { var n = now(); game.t += n - runSince; runSince = n; } }
    function stopClock() { foldClock(); runSince = 0; }
    function canRun() { return !!(ui && game && game.started && !game.done && !ui.ovKind && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(ui.panel))); }
    function syncClock() { if (canRun()) { if (!runSince) runSince = now(); } else stopClock(); paintHud(); }

    // ---- game flow ----------------------------------------------------------------
    function newGame(draw, dealNo) {
      if (game && game.counted && !game.done) { stat(game.draw).cs = 0; saveStats(); }   // abandoned = streak over
      stopClock();
      game = { draw: draw, deal: dealNo || randomDeal(), toks: [], redo: [], mv: 0, t: 0, done: 0, counted: 0, started: 0 };
      st = core.deal(game.deal, draw);
      prefs.draw = draw; savePrefs();
      persist();
      if (!ui) return;
      stopFx();
      hideOverlay();
      resetTransient();
      // Deal animation: every card starts on the stock, then flies out row by row.
      var stagger = {}, order = 0;
      for (var row = 0; row < 7; row++) for (var p = row; p < 7; p++) stagger[st.piles[p][row]] = (order++) * 22;
      if (!reduced()) {
        place(false, null, true);
        void ui.table.offsetWidth;
      }
      place(true, stagger);
      lockFor(order * 22 + 260);
      syncClock();
    }
    function begin() {
      if (!game.started) { game.started = 1; syncClock(); }
      if (!game.counted) { game.counted = 1; stat(game.draw).p = (stat(game.draw).p || 0) + 1; saveStats(); }
    }
    function afterChange() {
      ui.hints = null; ui.stuckShown = false;
      persist();
      paintHud();
    }
    function lockFor(ms) { if (ui) ui.lockUntil = Math.max(ui.lockUntil || 0, now() + ms); }
    function busy() { return !ui || now() < (ui.lockUntil || 0) || !!ui.fx; }
    function playable() { return !!(ui && game && !game.done && !busy() && !ui.ovKind); }

    // A forward move: apply, record, animate.
    function commit(tok, stagger) {
      if (!core.apply(st, tok)) return false;
      begin();
      clearSel(); clearHint();
      clearTimeout(ui.autoTimer);
      game.toks.push(tok); game.redo = []; game.mv++;
      place(true, stagger);
      afterChange();
      return true;
    }
    // After a forward move: a win, an auto-finish, or maybe nothing left to do.
    function afterForward() {
      if (!ui || game.done) return;
      if (core.won(st)) { checkWin(320); return; }
      if (prefs.auto && core.canAutoFinish(st)) { ui.autoTimer = setTimeout(autoFinishSoon, 300); return; }
      maybeStuck();
    }
    function doMove(from, n, to) {
      if (!playable() || !core.legal(st, from, n, to)) return false;
      if (!commit(core.token(from, to, n))) return false;
      haptic(isF(to) ? 12 : 8);
      afterForward();
      return true;
    }
    function draw() {
      if (!playable()) return;
      clearSel(); clearHint();
      if (st.stock.length) {
        var n = Math.min(st.draw, st.stock.length), ids = st.stock.slice(-n).reverse(), stagger = {};
        for (var k = 0; k < ids.length; k++) stagger[ids[k]] = k * DRAW_MS;
        commit('D', stagger);
        haptic(6);
      } else if (st.waste.length) {
        commit('R');
        haptic(10);
      } else { toast('The stock is empty'); return; }
      afterForward();
    }
    function undo() {
      if (!playable() || !game.toks.length) return;
      clearSel(); clearHint();
      clearTimeout(ui.autoTimer);
      game.redo.push(game.toks.pop());
      game.mv++;
      st = core.replay(game.deal, game.draw, game.toks).st;
      place(true);
      afterChange();
    }
    function redo() {
      if (!playable() || !game.redo.length) return;
      clearSel(); clearHint();
      var tok = game.redo.pop();
      if (!core.apply(st, tok)) { game.redo = []; paintHud(); return; }
      game.toks.push(tok); game.mv++;
      place(true);
      afterChange();
      afterForward();
    }
    function restart() {
      if (!game) return;
      if (game.started && !game.done && !window.confirm('Restart deal #' + game.deal + ' from the beginning?')) return;
      newGame(game.draw, game.deal);
    }
    // Every card face-up, stock and waste empty: send everything home, lowest first.
    function autoFinish() {
      if (!playable() || !core.canAutoFinish(st)) return false;
      begin();
      clearSel(); clearHint();
      clearTimeout(ui.autoTimer);
      var stagger = {}, k = 0, tok;
      while ((tok = core.nextHome(st))) {
        var a = pile(tok[0]), id = a[a.length - 1];
        if (!core.apply(st, tok)) break;
        stagger[id] = (k++) * HOME_MS;
        game.toks.push(tok); game.mv++;
      }
      game.redo = [];
      place(true, stagger);
      afterChange();
      haptic(12);
      checkWin(k * HOME_MS + 320);
      return true;
    }
    function autoFinishSoon() {
      if (!ui || !game || game.done || !prefs.auto || !core.canAutoFinish(st)) return;
      // Wait for a drag, an animation or an open menu to finish first.
      if (busy() || ui.ovKind || (ui.drag && ui.drag.started)) { ui.autoTimer = setTimeout(autoFinishSoon, 250); return; }
      autoFinish();
    }
    function autoMove(k, i) {
      if (!playable()) return;
      var a = pile(k);
      if (!core.canMoveFrom(st, k, i)) { shake(ui.cards[a[i]]); return; }
      var to = core.bestTarget(st, k, i);
      if (!to) { for (var j = i; j < a.length; j++) shake(ui.cards[a[j]]); return; }
      ui.lastAuto = { id: a[i], k: k, t: now() };
      doMove(k, a.length - i, to);
    }
    function maybeStuck() {
      if (!ui || game.done || ui.stuckShown) return;
      if (!core.stuck(st)) return;
      ui.stuckShown = true;
      setTimeout(function () { if (ui && game && !game.done) toast('No more moves — try Undo or a new deal'); }, 500);
    }

    // Stats are booked the moment the last card goes home; the celebration
    // follows once the cards have landed (`delay` ms).
    function checkWin(delay) {
      if (!ui || !game || game.done || !core.won(st)) return;
      stopClock();
      game.done = 1;
      var s = stat(game.draw), sc = st.score, t = Math.round(game.t), bestT = false, bestS = false;
      s.w = (s.w || 0) + 1;
      s.cs = (s.cs || 0) + 1; s.ms = Math.max(s.ms || 0, s.cs);
      if (!s.bt || t < s.bt) { bestT = !!s.bt; s.bt = t; }
      if (s.bs == null || sc > s.bs) { bestS = s.bs != null; s.bs = sc; }
      saveStats(); persist(); paintHud();
      haptic(40);
      var html = '<div class="sp-card"><div class="sp-big">🎉</div><b class="sp-title">You won!</b>' +
        '<div class="sp-sub">' + DRAW_LABEL[game.draw] + ' · deal #' + game.deal + '</div>' +
        '<div class="sp-winrow"><div><b>' + sc + '</b><span>score</span></div><div><b>' + fmtTime(t) + '</b><span>time</span></div><div><b>' + game.mv + '</b><span>moves</span></div></div>' +
        '<div class="sp-sub">' + (s.w === 1 ? 'First win with ' + DRAW_LABEL[game.draw] + '!' : bestS && bestT ? 'New best score and time!' : bestS ? 'New best score!' : bestT ? 'New best time!' : 'Best ' + s.bs + ' · ' + fmtTime(s.bt)) +
        (s.cs > 1 ? ' · streak ' + s.cs : '') + '</div>' +
        '<div class="sp-acts"><button class="sp-primary" data-act="newsame">New game</button><button data-act="newmenu">Change draw</button><button data-act="stats">Stats</button></div></div>';
      var go = function () { if (ui) cascade(function () { if (ui && game.done) showOverlay('win', html); }); };
      if (delay && !reduced()) { lockFor(delay); clearTimeout(ui.winTimer); ui.winTimer = setTimeout(go, delay); }
      else go();
    }

    // ---- layout + rendering -------------------------------------------------------------
    // Top row: stock, waste (fanned for Draw 3), gap, four foundations; columns below.
    function layout() {
      if (!ui) return false;
      var W = ui.table.clientWidth;
      if (!W) return false;
      var gap = W < 400 ? 3 : W < 520 ? 4 : 8;
      var cw = Math.min(84, Math.floor((W - gap * 8) / 7));
      var ch = Math.round(cw * 1.4);
      var x0 = Math.round((W - (cw * 7 + gap * 6)) / 2), xs = [];
      for (var p = 0; p < 7; p++) xs.push(x0 + p * (cw + gap));
      var vh = window.innerHeight || 600;
      if (window.visualViewport && window.visualViewport.height) vh = Math.min(vh, window.visualViewport.height);
      var top = ui.table.getBoundingClientRect().top, below = ui.tools.offsetHeight + 22;
      var pilesY = gap + ch + Math.max(10, gap * 2);
      var L = {
        W: W, gap: gap, cw: cw, ch: ch, xs: xs, pilesY: pilesY,
        fu: Math.max(20, Math.round(ch * 0.33)), fd: Math.max(5, Math.round(ch * 0.12)),
        wOff: Math.floor((cw + gap) / 2),        // a fan of three ends where the foundations begin
        maxH: Math.max(pilesY + ch * 3.4, vh - top - below)
      };
      ui.L = L;
      ui.table.style.setProperty('--cw', cw + 'px');
      ui.table.style.setProperty('--ch', ch + 'px');
      for (p = 0; p < 7; p++) setXY(ui.slots[p], xs[p], pilesY);
      for (var f = 0; f < 4; f++) setXY(ui.fslots[f], xs[3 + f], gap);
      setXY(ui.stockSlot, xs[0], gap);
      setXY(ui.wasteSlot, xs[1], gap);
      return true;
    }

    // Positions of every card for the current state; `allAtStock` puts them all
    // on the stock (the starting frame of the deal animation).
    function computePos(allAtStock) {
      var L = ui.L, pos = [], loc = [], p, i, k, bottom = L.pilesY + L.ch * 3.2;
      var sx = L.xs[0], sy = L.gap;
      if (allAtStock) {
        for (k = 0; k < 52; k++) { pos[k] = { x: sx, y: sy, z: 300 + k, up: false }; loc[k] = { k: 's' }; }
        return { pos: pos, loc: loc, h: bottom };
      }
      var n = st.stock.length;
      for (k = 0; k < n; k++) {                  // a hint of thickness: deeper cards peek out up-left
        var g = Math.min(2, ((n - 1 - k) / 8) | 0);
        pos[st.stock[k]] = { x: sx - g, y: sy - g, z: 300 + k, up: false };
        loc[st.stock[k]] = { k: 's' };
      }
      var w = st.waste, f0 = w.length - Math.min(st.wfan, w.length);
      for (k = 0; k < w.length; k++) {
        pos[w[k]] = { x: L.xs[1] + Math.max(0, k - f0) * L.wOff, y: sy, z: 200 + k, up: true };
        loc[w[k]] = { k: 'w', i: k };
      }
      for (var f = 0; f < 4; f++) {
        var a = st.found[f];
        for (k = 0; k < a.length; k++) { pos[a[k]] = { x: L.xs[3 + f], y: sy, z: 100 + k, up: true }; loc[a[k]] = { k: FND[f], i: k }; }
      }
      var avail = L.maxH - L.pilesY - L.ch - 4;
      for (p = 0; p < 7; p++) {
        var col = st.piles[p], down = Math.min(st.down[p], col.length), up = col.length - down;
        var fd = L.fd, fu = L.fu;
        // Long columns squeeze to fit the screen: face-down cards first, then face-up.
        if (down * fd + Math.max(0, up - 1) * fu > avail) {
          fd = Math.min(fd, 4);
          if (up > 1 && down * fd + (up - 1) * fu > avail) fu = Math.max(10, Math.floor((avail - down * fd) / (up - 1)));
        }
        var y = L.pilesY;
        for (i = 0; i < col.length; i++) {
          pos[col[i]] = { x: L.xs[p], y: y, z: 10 + i, up: i >= down };
          loc[col[i]] = { k: String(p), i: i };
          y += i < down ? fd : fu;
        }
        if (col.length) bottom = Math.max(bottom, y - (col.length - 1 < down ? fd : fu) + L.ch);
      }
      return { pos: pos, loc: loc, h: bottom };
    }

    function place(animate, stagger, allAtStock) {
      if (!ui || !ui.L || !st) return;
      var anim = animate && !reduced();
      var r = computePos(allAtStock), pos = r.pos, prev = ui.pos || [], moved = [], maxDelay = 0;
      if (!anim) ui.table.classList.add('sp-noanim');
      for (var id = 0; id < 52; id++) {
        var P = pos[id], O = prev[id], el = ui.cards[id];
        if (!P) continue;
        if (!O || O.x !== P.x || O.y !== P.y) {
          var d = stagger && stagger[id] ? stagger[id] : 0;
          if (d > maxDelay) maxDelay = d;
          el.style.transitionDelay = anim && d ? d + 'ms' : '';
          // While flying, a card rides above everything; real z comes back after.
          el.style.zIndex = anim && O ? 1000 + P.z : P.z;
          if (anim && O) moved.push(id);
          el.style.transform = 'translate3d(' + P.x + 'px,' + P.y + 'px,0)';
        } else if (O.z !== P.z) el.style.zIndex = P.z;
        if (!O || O.up !== P.up) {
          el.classList.toggle('dn', !P.up);
          if (anim && O && P.up) flipFx(el, stagger && stagger[id] ? stagger[id] : 0);
        }
      }
      ui.pos = pos; ui.loc = r.loc;
      ui.table.style.height = Math.ceil(Math.max(r.h + 6, ui.L.pilesY + ui.L.ch * 3.2)) + 'px';
      ui.stockSlot.classList.toggle('empty', !st.stock.length);
      ui.stockSlot.classList.toggle('spent', !st.stock.length && !st.waste.length);
      if (!anim) { void ui.table.offsetWidth; ui.table.classList.remove('sp-noanim'); }
      if (moved.length) {
        clearTimeout(ui.zTimer);
        var settle = ui.settle || [];
        ui.settle = settle.concat(moved);
        ui.zTimer = setTimeout(function () {
          if (!ui) return;
          ui.settle.forEach(function (k) { var Q = ui.pos[k]; ui.cards[k].style.zIndex = Q ? Q.z : ''; ui.cards[k].style.transitionDelay = ''; });
          ui.settle = [];
        }, maxDelay + 320);
      }
    }
    function paintFaces() {
      for (var id = 0; id < 52; id++) {
        var r = core.R(id), s = core.S(id), g = GLYPH[s], el = ui.cards[id];
        el.className = 'sp-c dn' + (core.red(id) ? ' red' : '');
        el.firstChild.innerHTML = '<span class="sp-cr' + (r === 10 ? ' ten' : '') + '"><b>' + RANKS[r] + '</b><i>' + g + '</i></span><span class="sp-pip">' + g + '</span>';
      }
    }
    function paintHud() {
      if (!ui || !game) return;
      var set = function (el, v) { v = String(v); if (el.textContent !== v) el.textContent = v; };
      set(ui.hudScore, st.score);
      set(ui.hudMoves, game.mv);
      set(ui.hudTime, fmtTime(elapsed()));
      set(ui.hudDeal, DRAW_LABEL[game.draw] + ' · #' + game.deal);
      set(ui.stockCount, st.stock.length ? String(st.stock.length) : '');
      ui.undoBtn.disabled = !game.toks.length || !!game.done;
      ui.redoBtn.disabled = !game.redo.length || !!game.done;
      ui.hintBtn.disabled = !!game.done;
      ui.autoBtn.disabled = !!game.done || !core.canAutoFinish(st);
    }

    // ---- selection + hints --------------------------------------------------------------
    function slotOf(k) { return isT(k) ? ui.slots[+k] : isF(k) ? ui.fslots[FND.indexOf(k)] : k === 'w' ? ui.wasteSlot : ui.stockSlot; }
    function clearSel() {
      if (!ui || !ui.sel) return;
      ui.sel.ids.forEach(function (id) { ui.cards[id].classList.remove('sp-sel'); });
      ui.sel = null;
    }
    function select(k, i) {
      clearSel();
      var ids = pile(k).slice(i);
      ids.forEach(function (id) { ui.cards[id].classList.add('sp-sel'); });
      ui.sel = { k: k, i: i, ids: ids };
    }
    function clearHint() {
      if (!ui) return;
      clearTimeout(ui.hintTimer);
      var on = ui.table.querySelectorAll('.sp-hs, .sp-ht');
      for (var k = 0; k < on.length; k++) on[k].classList.remove('sp-hs', 'sp-ht');
    }
    function markTarget(k) {
      var a = pile(k);
      (a.length ? ui.cards[a[a.length - 1]] : slotOf(k)).classList.add('sp-ht');
    }
    function hint() {
      if (!playable()) return;
      clearSel();
      if (core.stuck(st)) { toast('No more moves — try Undo or a new deal'); return; }
      if (!ui.hints) { ui.hints = core.hints(st); ui.hintIdx = 0; }
      if (!ui.hints.length) { toast('No more moves — try Undo or a new deal'); return; }
      var h = ui.hints[ui.hintIdx++ % ui.hints.length];
      clearHint();
      if (h.draw || h.recycle) {
        ui.stockSlot.classList.add('sp-ht');
        if (st.stock.length) ui.cards[st.stock[st.stock.length - 1]].classList.add('sp-ht');
      } else {
        var a = pile(h.from);
        a.slice(a.length - h.n).forEach(function (id) { ui.cards[id].classList.add('sp-hs'); });
        markTarget(h.to);
      }
      ui.hintTimer = setTimeout(clearHint, 1700);
    }

    // ---- pointer: drag, tap, double-tap -------------------------------------------------
    // A hit is { k: place, i: card index (-1 = the empty place), id }; the waste and
    // foundations only ever offer their top card.
    function hitTest(e) {
      var t = e.target, card = t.closest ? t.closest('.sp-c') : null;
      if (card && ui.loc) {
        var id = +card.getAttribute('data-id'), l = ui.loc[id];
        if (!l) return null;
        if (l.k === 's') return { k: 's' };
        if (l.k === 'w' || isF(l.k)) { var a = pile(l.k); return { k: l.k, i: a.length - 1, id: a[a.length - 1] }; }
        return { k: l.k, i: l.i, id: id };
      }
      if (t.closest && t.closest('.sp-stock')) return { k: 's' };
      var fs = t.closest ? t.closest('.kl-fslot') : null;
      if (fs) return { k: FND[+fs.getAttribute('data-f')], i: -1 };
      // Empty column / felt below a column = that column.
      var r = ui.table.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, L = ui.L;
      if (y < L.pilesY - L.gap) return null;
      for (var p = 0; p < 7; p++) if (x >= L.xs[p] - L.gap / 2 && x < L.xs[p] + L.cw + L.gap / 2) return { k: String(p), i: -1 };
      return null;
    }
    function onDown(e) {
      if (!ui || (e.button && e.button > 0)) return;
      if (ui.fx) { e.preventDefault(); finishFx(); return; }
      // A drag whose pointerup never arrived (lost capture, second finger) is cancelled.
      if (ui.drag) onUp({ pointerId: ui.drag.id }, true);
      if (ui.ovKind || !game || game.done) return;
      e.preventDefault();
      try { ui.root.focus({ preventScroll: true }); } catch (x) {}
      ui.drag = { hit: hitTest(e), x0: e.clientX, y0: e.clientY, id: e.pointerId, started: false };
      try { ui.table.setPointerCapture(e.pointerId); } catch (x) {}
    }
    function onMove(e) {
      var d = ui && ui.drag;
      if (!d || d.id !== e.pointerId) return;
      var dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      if (!d.started) {
        if (dx * dx + dy * dy < 64) return;
        var h = d.hit;
        if (!h || h.k === 's' || h.i < 0 || busy() || !core.canMoveFrom(st, h.k, h.i)) { d.dead = true; return; }
        d.started = true;
        clearSel(); clearHint();
        d.ids = pile(h.k).slice(h.i);
        d.ids.forEach(function (id, k) { var el = ui.cards[id]; el.classList.add('sp-drag'); el.style.zIndex = 3000 + k; el.style.transitionDelay = ''; });
      }
      d.dx = dx; d.dy = dy;
      if (!d.raf) d.raf = requestAnimationFrame(function () {
        d.raf = 0;
        if (!ui || ui.drag !== d) return;
        d.ids.forEach(function (id) { var P = ui.pos[id]; ui.cards[id].style.transform = 'translate3d(' + (P.x + d.dx) + 'px,' + (P.y + d.dy) + 'px,0)'; });
        var q = dropTarget(d);
        if (q !== d.over) {
          clearHint();
          d.over = q;
          if (q) markTarget(q);
        }
      });
    }
    // The legal place the dragged cards overlap most: a column (its whole
    // length counts) or, for a single card, a foundation.
    function dropTarget(d) {
      var L = ui.L, P = ui.pos[d.ids[0]], x = P.x + d.dx, y = P.y + d.dy, n = d.ids.length, best = '', bestOv = 0;
      function consider(k, tx, ty, th) {
        if (!core.legal(st, d.hit.k, n, k)) return;
        var ox = L.cw - Math.abs(tx - x), oy = Math.min(y + L.ch, ty + th) - Math.max(y, ty);
        if (ox > 0 && oy > 0 && ox * oy > bestOv) { bestOv = ox * oy; best = k; }
      }
      for (var q = 0; q < 7; q++) {
        var a = st.piles[q], ty = a.length && ui.pos[a[a.length - 1]] ? ui.pos[a[a.length - 1]].y : L.pilesY;
        consider(String(q), L.xs[q], L.pilesY, ty - L.pilesY + L.ch * 1.6);
      }
      if (n === 1) for (var f = 0; f < 4; f++) consider(FND[f], L.xs[3 + f], L.gap, L.ch);
      return best;
    }
    function onUp(e, cancel) {
      var d = ui && ui.drag;
      if (!d || d.id !== e.pointerId) return;
      ui.drag = null;
      if (d.raf) cancelAnimationFrame(d.raf);
      if (d.started) {
        clearHint();
        var q = cancel ? '' : dropTarget(d);
        d.ids.forEach(function (id) { ui.cards[id].classList.remove('sp-drag'); if (ui.pos[id]) ui.pos[id] = { x: NaN, y: NaN, z: ui.pos[id].z, up: ui.pos[id].up }; });
        if (!q || !doMove(d.hit.k, d.ids.length, q)) place(true);       // snap back
        return;
      }
      if (!cancel && !d.dead) tap(d.hit);
    }
    function tap(hit) {
      if (!playable()) return;
      if (!hit) { clearSel(); return; }
      if (hit.k === 's') { draw(); return; }
      var t = now();
      var dbl = ui.lastTap && ui.lastTap.id === hit.id && hit.i >= 0 && t - ui.lastTap.t < 380;
      ui.lastTap = { id: hit.id, t: t };
      if (prefs.tap === 'auto') {
        // A double-click's second click lands on the card that just moved (or on
        // the one it uncovered): ignore it rather than move again.
        if (ui.lastAuto && (ui.lastAuto.id === hit.id || ui.lastAuto.k === hit.k) && t - ui.lastAuto.t < 420) return;
        if (hit.i >= 0) autoMove(hit.k, hit.i); else clearSel();
        return;
      }
      // Select mode: tap cards, then tap the destination (column or foundation).
      var s = ui.sel;
      if (s) {
        if (hit.k === s.k) {
          if (dbl || hit.i === s.i) { clearSel(); autoMove(hit.k, hit.i >= 0 ? hit.i : s.i); return; }
          if (hit.i >= 0 && core.canMoveFrom(st, hit.k, hit.i)) select(hit.k, hit.i); else clearSel();
          return;
        }
        var n = pile(s.k).length - s.i, to = hit.k;
        // Any foundation will do for a card that has one to go to.
        if (isF(to) && !core.legal(st, s.k, n, to) && n === 1) { var f = core.foundFor(st, pile(s.k)[s.i]); if (f >= 0) to = FND[f]; }
        if (to !== 'w' && core.legal(st, s.k, n, to)) { doMove(s.k, n, to); return; }
        if (hit.i >= 0 && core.canMoveFrom(st, hit.k, hit.i)) { select(hit.k, hit.i); return; }
        s.ids.forEach(function (id) { shake(ui.cards[id]); });
        clearSel();
        return;
      }
      if (hit.i < 0) return;
      if (core.canMoveFrom(st, hit.k, hit.i)) select(hit.k, hit.i);
      else shake(ui.cards[hit.id]);
    }

    // ---- win cascade (shared): Kings first, as in the original -----------------------
    function cascade(done) {
      if (!ui) { done(); return; }
      var queue = [];
      for (var lvl = 12; lvl >= 0; lvl--) for (var f = 0; f < 4; f++) if (st.found[f][lvl] !== undefined) queue.push(st.found[f][lvl]);
      cascadeFx(ui, queue, function (cid) { return { r: core.R(cid), s: core.S(cid) }; }, done);
    }
    function stopFx() { stopFxOf(ui); }
    function finishFx() { finishFxOf(ui); }

    // ---- overlays -----------------------------------------------------------------------
    function showOverlay(kind, html) {
      if (!ui) return;
      ui.ovKind = kind;
      ui.ov.className = 'sp-ov show';
      ui.ov.innerHTML = html;
      fitOverlay(ui);
      clearSel();
      syncClock();
    }
    function hideOverlay() {
      if (!ui) return;
      ui.ovKind = '';
      ui.ov.className = 'sp-ov';
      ui.ov.innerHTML = '';
      ui.table.style.minHeight = '';
      syncClock();
    }
    function newMenu() {
      var rows = '';
      DRAWS.forEach(function (d) {
        var x = stats[d] || {};
        rows += '<button class="sp-pick" data-act="new" data-draw="' + d + '"><b><span class="sp-pk-s">' + (d === 1 ? '🂠' : '🂠🂠🂠') + '</span>' + DRAW_LABEL[d] +
          '</b><span>' + DRAW_LEVEL[d] + (x.p ? ' · won ' + (x.w || 0) + '/' + x.p : '') + '</span></button>';
      });
      showOverlay('menu', '<div class="sp-card"><b class="sp-title">New game</b><div class="sp-list">' + rows + '</div>' +
        '<div class="sp-acts">' + (game ? '<button data-act="replay">↺ Replay #' + game.deal + '</button>' : '') +
        '<button data-act="dealno">Deal number…</button>' + (game ? '<button data-act="hide">Cancel</button>' : '') + '</div></div>');
    }
    function moreMenu() {
      showOverlay('menu', '<div class="sp-card"><b class="sp-title">Klondike</b><div class="sp-list">' +
        '<button data-act="restart">↺ Restart this deal</button>' +
        '<button data-act="stats">📊 Statistics</button>' +
        '<button data-act="autofin" class="sp-tog' + (prefs.auto ? ' on' : '') + '">' + (prefs.auto ? '☑' : '☐') + ' Finish by itself once every card is face-up</button>' +
        '<button data-act="tapmode" class="sp-tog' + (prefs.tap === 'select' ? ' on' : '') + '">' + (prefs.tap === 'select' ? '☑' : '☐') + ' Tap to select, then tap the target</button>' +
        '</div><div class="sp-hint">' + (prefs.tap === 'select' ? 'Double-tap a card to send it to its best spot.' : 'Tap (or double-click) a card to send it to its best spot — a foundation first.') +
        ' Drag works too; tap the stock to draw. Draw 1 / Draw 3 is picked under New.' +
        '<br>Keys: Ctrl+Z / Ctrl+Y undo/redo · H hint · D or Space draw · A auto-finish · N new game · Esc close</div>' +
        '<div class="sp-acts"><button class="sp-primary" data-act="hide">Close</button></div></div>');
    }
    function statsMenu() {
      var rows = '';
      DRAWS.forEach(function (d) {
        var x = stats[d] || {};
        rows += '<tr><td>' + DRAW_LABEL[d] + '</td><td>' + (x.w || 0) + '/' + (x.p || 0) + '</td><td>' + (x.p ? Math.round(100 * (x.w || 0) / x.p) + '%' : '—') +
          '</td><td>' + (x.bt ? fmtTime(x.bt) : '—') + '</td><td>' + (x.bs != null ? x.bs : '—') + '</td><td>' + (x.ms || 0) + '</td></tr>';
      });
      showOverlay('stats', '<div class="sp-card"><b class="sp-title">Statistics</b>' +
        '<table class="sp-stats"><thead><tr><th></th><th>Won</th><th>%</th><th>Best time</th><th>Best score</th><th>Streak</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div class="sp-acts"><button data-act="resetstats">Reset</button><button class="sp-primary" data-act="hide">Close</button></div></div>');
    }
    function onOverlayClick(e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      var act = b.getAttribute('data-act');
      var abandon = function () { return !game || !game.started || game.done || window.confirm('Abandon the game in progress?'); };
      if (act === 'hide') { if (game) hideOverlay(); }
      else if (act === 'new') { if (abandon()) newGame(+b.getAttribute('data-draw'), 0); }
      else if (act === 'newsame') newGame(game ? game.draw : prefs.draw, 0);
      else if (act === 'newmenu') newMenu();
      else if (act === 'replay') { if (abandon()) newGame(game.draw, game.deal); }
      else if (act === 'restart') restart();
      else if (act === 'dealno') {
        var v = window.prompt('Deal number (1–999999):', game ? String(game.deal) : '');
        if (v == null) return;
        var n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
        if (!(n >= 1 && n <= 999999)) { toast('Enter a number from 1 to 999999', 'error'); return; }
        if (abandon()) newGame(game ? game.draw : prefs.draw, n);
      }
      else if (act === 'stats') statsMenu();
      else if (act === 'autofin') {
        prefs.auto = !prefs.auto; savePrefs(); moreMenu();
        if (prefs.auto && core.canAutoFinish(st)) ui.autoTimer = setTimeout(autoFinishSoon, 300);
      }
      else if (act === 'tapmode') { prefs.tap = prefs.tap === 'select' ? 'auto' : 'select'; savePrefs(); clearSel(); moreMenu(); }
      else if (act === 'resetstats') { if (window.confirm('Reset all Klondike statistics?')) { stats = {}; saveStats(); statsMenu(); } }
    }

    // ---- table DOM -----------------------------------------------------------------------
    function buildHtml() {
      var cards = '', slots = '', f;
      for (var id = 0; id < 52; id++) cards += '<div class="sp-c dn" data-id="' + id + '"><div class="sp-in"></div></div>';
      for (var p = 0; p < 7; p++) slots += '<div class="sp-slot kl-col" data-p="' + p + '"></div>';
      for (f = 0; f < 4; f++) slots += '<div class="sp-slot kl-fslot" data-f="' + f + '"></div>';
      return '<div class="sp kl" tabindex="-1">' +
        '<div class="sp-top"><button class="sp-btn sp-deal" data-tool="new" title="New game"></button>' +
          '<span class="sp-hud">Score <b class="sp-score"></b></span><span class="sp-hud">Moves <b class="sp-moves"></b></span>' +
          '<span class="sp-time"></span></div>' +
        '<div class="sp-wrap"><div class="sp-table">' + slots +
          '<div class="sp-slot kl-waste"></div>' +
          '<div class="sp-slot sp-stock kl-stock" title="Draw (D)"><span class="kl-recycle">↻</span><span class="sp-stock-n"></span></div>' + cards +
        '</div><div class="sp-ov"></div></div>' +
        '<div class="sp-tools">' +
          toolHtml('undo', '↶', 'Undo', 'Undo (Ctrl+Z)') + toolHtml('redo', '↷', 'Redo', 'Redo (Ctrl+Y)') +
          toolHtml('hint', '💡', 'Hint', 'Show a move (H) — press again for the next one') +
          toolHtml('auto', '⚡', 'Auto', 'Send every card home (A) — once all are face-up and the stock is empty') +
          toolHtml('new', '✚', 'New', 'New game (N)') + toolHtml('more', '⋯', 'More', 'Options and statistics') +
        '</div></div>';
    }

    function resetTransient() {
      if (!ui) return;
      clearSel(); clearHint();
      ui.hints = null; ui.drag = null; ui.lastTap = null; ui.lastAuto = null; ui.stuckShown = false;
      clearTimeout(ui.autoTimer); clearTimeout(ui.winTimer);
    }
    function relayout() {
      if (!ui || ui.relayoutRaf) return;
      ui.relayoutRaf = requestAnimationFrame(function () {
        if (!ui) return;
        ui.relayoutRaf = 0;
        var w = ui.table.clientWidth;
        if (!layout()) return;
        if (ui.fx && w !== ui.lastW) finishFx();
        ui.lastW = w;
        place(false);
      });
    }

    function close() { shell.close(); }
    function unmount() {
      if (!ui) return;
      stopFx();
      clearTimeout(ui.readyTimer);
      stopClock();
      clearTimeout(ui.zTimer); clearTimeout(ui.hintTimer); clearTimeout(ui.autoTimer); clearTimeout(ui.winTimer);
      if (ui.relayoutRaf) cancelAnimationFrame(ui.relayoutRaf);
      if (ui.drag && ui.drag.raf) cancelAnimationFrame(ui.drag.raf);
      persist();
      clearInterval(tickIv); tickIv = 0;
      document.removeEventListener('keydown', ui.onKey, true);
      document.removeEventListener('visibilitychange', ui.onVis);
      ui.panel.removeEventListener('cade-panel-minimize', ui.onMin);
      ui.panel.removeEventListener('cade-panel-restore', ui.onVis);
      window.removeEventListener('pagehide', ui.onHide);
      window.removeEventListener('resize', relayout);
      if (ui.ro) ui.ro.disconnect();
      ui = null;
    }

    function mount(host, p) {
      core = core || KlondikeCore();
      loadState();
      host.innerHTML = buildHtml();
      var root = host.querySelector('.sp');
      ui = {
        panel: p, root: root, table: root.querySelector('.sp-table'), ov: root.querySelector('.sp-ov'),
        tools: root.querySelector('.sp-tools'), cards: [], slots: [], fslots: [],
        stockSlot: root.querySelector('.kl-stock'), wasteSlot: root.querySelector('.kl-waste'),
        stockCount: root.querySelector('.sp-stock-n'),
        hudScore: root.querySelector('.sp-score'), hudMoves: root.querySelector('.sp-moves'),
        hudTime: root.querySelector('.sp-time'), hudDeal: root.querySelector('.sp-deal'),
        undoBtn: root.querySelector('[data-tool="undo"]'), redoBtn: root.querySelector('[data-tool="redo"]'),
        hintBtn: root.querySelector('[data-tool="hint"]'), autoBtn: root.querySelector('[data-tool="auto"]'),
        ovKind: '', pos: null, loc: null, L: null
      };
      root.querySelectorAll('.sp-c').forEach(function (el) { ui.cards[+el.getAttribute('data-id')] = el; });
      root.querySelectorAll('.kl-col').forEach(function (el) { ui.slots[+el.getAttribute('data-p')] = el; });
      root.querySelectorAll('.kl-fslot').forEach(function (el) { ui.fslots[+el.getAttribute('data-f')] = el; });
      paintFaces();

      ui.onKey = onKey;
      ui.onVis = function () { if (!ui) return; if (document.hidden) persist(); syncClock(); };
      ui.onHide = function () { persist(); };
      // Minimized to the dock counts as hidden: the clock stops until restore.
      ui.onMin = function () { if (!ui) return; persist(); syncClock(); };
      p.addEventListener('cade-panel-minimize', ui.onMin);
      p.addEventListener('cade-panel-restore', ui.onVis);
      document.addEventListener('keydown', ui.onKey, true);
      document.addEventListener('visibilitychange', ui.onVis);
      window.addEventListener('pagehide', ui.onHide);
      window.addEventListener('resize', relayout);
      if (typeof ResizeObserver !== 'undefined') {
        ui.ro = new ResizeObserver(function () { if (ui && ui.table.clientWidth !== ui.lastW) relayout(); });
        ui.ro.observe(ui.table);
      }

      var table = ui.table;
      table.addEventListener('pointerdown', onDown);
      table.addEventListener('pointermove', onMove);
      table.addEventListener('pointerup', function (e) { onUp(e, false); });
      table.addEventListener('pointercancel', function (e) { onUp(e, true); });
      table.addEventListener('lostpointercapture', function (e) { if (ui && ui.drag && ui.drag.id === e.pointerId) onUp(e, true); });
      root.addEventListener('click', function (e) {
        if (!ui) return;
        var t = e.target;
        if (ui.ov.contains(t)) { onOverlayClick(e); return; }
        var tl = t.closest ? t.closest('[data-tool]') : null;
        if (!tl || tl.disabled) return;
        var a = tl.getAttribute('data-tool');
        if (a === 'undo') undo();
        else if (a === 'redo') redo();
        else if (a === 'hint') hint();
        else if (a === 'auto') autoFinish();
        else if (a === 'new') newMenu();
        else if (a === 'more') moreMenu();
        // Keep keyboard focus on the table (Space draws; it mustn't re-press this button).
        if (ui && !ui.ovKind) try { ui.root.focus({ preventScroll: true }); } catch (x) {}
      });

      try { root.focus({ preventScroll: true }); } catch (e) {}
      tickIv = setInterval(function () { if (ui && runSince) paintHud(); }, 500);
      // Card metrics come from the table's width: on the very first open the
      // stylesheet may still be loading, so wait (briefly) until it applies.
      var tries = 0;
      (function start() {
        if (!ui) return;
        if (getComputedStyle(ui.table).position !== 'relative' && tries++ < 40) { ui.readyTimer = setTimeout(start, 50); return; }
        layout();
        ui.lastW = ui.table.clientWidth;
        if (!game) newGame(prefs.draw, 0);
        else {
          place(false);
          paintHud();
          syncClock();
          if (game.done) checkWinOverlay();
          else if (prefs.auto && core.canAutoFinish(st)) ui.autoTimer = setTimeout(autoFinishSoon, 400);
        }
      })();
    }
    function checkWinOverlay() {
      var s = stats[game.draw] || {};
      showOverlay('win', '<div class="sp-card"><div class="sp-big">🏆</div><b class="sp-title">Deal #' + game.deal + ' won</b>' +
        '<div class="sp-sub">' + DRAW_LABEL[game.draw] + ' · score ' + st.score + ' · ' + fmtTime(game.t) + ' · ' + game.mv + ' moves</div>' +
        '<div class="sp-sub">Best ' + (s.bs != null ? s.bs : '—') + ' · ' + (s.bt ? fmtTime(s.bt) : '—') + '</div>' +
        '<div class="sp-acts"><button class="sp-primary" data-act="newsame">New game</button><button data-act="newmenu">Change draw</button></div></div>');
    }

    function onKey(e) {
      if (!ui) return;
      if (Cade.isMinimized && Cade.isMinimized(ui.panel)) return; // parked in the dock: keys belong to the editor
      var ae = document.activeElement;
      if (ae && ae !== document.body && !ui.panel.contains(ae) && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) return;
      var k = e.key, mod = e.ctrlKey || e.metaKey, handled = true;
      if (k === 'Escape') {
        if (ui.fx) finishFx();
        else if (ui.ovKind && game && ui.ovKind !== 'win') hideOverlay();
        else if (ui.sel) clearSel();
        else close();
      } else if (mod && !e.altKey && (k === 'z' || k === 'Z')) { if (e.shiftKey) redo(); else undo(); }
      else if (mod && !e.altKey && (k === 'y' || k === 'Y')) redo();
      else if (mod || e.altKey) handled = false;
      else if (ui.ovKind) handled = false;
      else if (k === 'h' || k === 'H') hint();
      else if (k === 'd' || k === 'D' || k === ' ') draw();
      else if (k === 'a' || k === 'A') {
        if (game && !game.done && !core.canAutoFinish(st)) toast('Auto-finish needs every card face-up and the stock used up');
        else autoFinish();
      }
      else if (k === 'u' || k === 'U') undo();
      else if (k === 'n' || k === 'N') newMenu();
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }

    return { mount: mount, unmount: unmount };
  }

  // =================================================================================
  // SHELL — the panel, the "Klondike | Spider" switch in its header, the active mode.
  // =================================================================================
  var MODE_KEY = 'cade-solitaire-mode';
  var MODES = { klondike: { label: 'Klondike', make: KlondikeMode }, spider: { label: 'Spider', make: SpiderMode } };
  var ORDER = ['klondike', 'spider'];
  var shellApi = { close: close };
  var modeInst = {};               // one instance per mode, created on first use
  var shell = null;                // { panel, host, seg, mode, inst } while open

  function pickMode() {
    var m = null;
    try { m = Cade.store.get(MODE_KEY); } catch (e) {}
    if (MODES[m]) return m;
    // First open after Spider became part of Solitaire: a Spider game in
    // progress opens where it was left; otherwise start with Klondike.
    var s = readJSON('cade-spider-save', null);
    return s && typeof s === 'object' && s.started && !s.done ? 'spider' : 'klondike';
  }
  function switchMode(m) {
    if (!shell || !MODES[m] || m === shell.mode) return;
    if (shell.inst) shell.inst.unmount();
    shell.host.innerHTML = '';
    shell.mode = m;
    try { Cade.store.set(MODE_KEY, m); } catch (e) {}
    var btns = shell.seg.querySelectorAll('[data-mode]');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-mode') === m;
      btns[i].classList.toggle('on', on);
      btns[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    shell.inst = modeInst[m] || (modeInst[m] = MODES[m].make(shellApi));
    shell.inst.mount(shell.host, shell.panel);
  }
  function teardown() {
    if (!shell) return;
    var s = shell;
    shell = null;
    if (s.inst) s.inst.unmount();
  }
  function close() {
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    teardown();
    try { Cade.editor.focus(); } catch (e) {}
  }
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    var p = Cade.mkPanel(PANEL_ID, '♠ Solitaire', '<div class="sol-host"></div>');
    try { Cade.markGamePanel(p); } catch (e) {}
    var seg = document.createElement('div');
    seg.className = 'sol-seg';
    seg.setAttribute('role', 'tablist');
    seg.setAttribute('aria-label', 'Game');
    seg.innerHTML = ORDER.map(function (m) { return '<button type="button" role="tab" data-mode="' + m + '">' + MODES[m].label + '</button>'; }).join('');
    var head = p.querySelector('.cade-panel-head');
    if (head) head.insertBefore(seg, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    else p.insertBefore(seg, p.firstChild);
    // The header drags the panel; the switch is a control, not a handle.
    seg.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    seg.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-mode]') : null;
      if (b) switchMode(b.getAttribute('data-mode'));
    });
    shell = { panel: p, host: p.querySelector('.sol-host'), seg: seg, mode: '', inst: null };
    p._onClose = teardown;
    switchMode(pickMode());
  }

  Cade.registerWidget({
    name: 'Solitaire',
    description: 'Klondike (draw 1 or 3) and Spider (1, 2 or 4 suits) — numbered deals, undo & hints',
    icon: ICON,
    tags: 'game,cards,solitaire,klondike,spider,patience,card game,windows solitaire,draw 3,puzzle,fun,train',
    open: open,
    _core: function () { return SpiderCore(); },       // exposed for headless tests
    _klondike: function () { return KlondikeCore(); }  // exposed for headless tests
  });
})();
