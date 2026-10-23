/* Random Picker — fair random choices without leaving the note.
 *
 *  - Wheel: spin a colourful wheel built from a list (one item per line, or
 *    "a, b, c"); "Alice x3" weights an entry 3x. The winner is drawn FIRST
 *    with crypto.getRandomValues, then the wheel eases (quartic deceleration)
 *    onto a random spot inside the winner's slice, so the animation never
 *    biases the result. Optional tick sound (WebAudio, off by default),
 *    light confetti, "remove winner", history.
 *  - Teams: N teams or teams of K, sizes differ by at most one; weights act as
 *    skill ratings and are balanced greedily (strongest first onto the team
 *    with the lowest total). Reshuffle, copy / insert as Markdown.
 *  - Coin: animated flip, streak / best streak, heads-tails tally.
 *  - Number: integers or decimals in a range, N at once (optionally unique,
 *    sorted), and dice shortcuts d4 ... d100.
 *  - Shuffle: shuffle the list or pick N (weighted when weights are given).
 *
 * The list comes from a multi-line selection when the panel opens, otherwise
 * the remembered one; the last few lists, wheel history and coin stats are
 * remembered (small caps). Every result can be copied or inserted.
 * Pure logic is exposed as widget._lib for node unit checks. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('picker.css');
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'picker-panel';
  var KEY = 'cade-picker-state';
  var MAX_LIST_CHARS = 8000, MAX_RECENT = 5, MAX_HIST = 20, MAX_ITEMS = 500, MAX_COUNT = 1000;
  var TABS = [['wheel', 'Wheel'], ['teams', 'Teams'], ['coin', 'Coin'], ['number', 'Number'], ['shuffle', 'Shuffle']];
  var TAU = Math.PI * 2;

  // ======================================================================
  // Randomness: crypto.getRandomValues (buffered), unbiased integer ranges
  // ======================================================================
  var CR = (typeof crypto !== 'undefined' && crypto && crypto.getRandomValues) ? crypto : null;
  var rbuf = null, rpos = 0;
  function u32() {
    if (CR) {
      if (!rbuf || rpos >= rbuf.length) { rbuf = new Uint32Array(64); CR.getRandomValues(rbuf); rpos = 0; }
      return rbuf[rpos++];
    }
    return Math.floor(Math.random() * 4294967296);
  }
  // Uniform float in [0, 1) with 53 random bits.
  function rand01() { return (u32() * 2097152 + (u32() >>> 11)) / 9007199254740992; }
  // Uniform integer in [0, n) by rejection sampling (no modulo bias), n <= 2^53.
  function randBelow(n) {
    n = Math.floor(n);
    if (!(n > 1)) return 0;
    var x, lim;
    if (n <= 4294967296) {
      lim = 4294967296 - 4294967296 % n;
      do { x = u32(); } while (x >= lim);
      return x % n;
    }
    lim = 9007199254740992 - 9007199254740992 % n;
    do { x = u32() * 2097152 + (u32() >>> 11); } while (x >= lim);
    return x % n;
  }
  // rng (optional, for tests) returns [0,1); default is the crypto source.
  function ri(n, rng) { return rng ? Math.min(n - 1, Math.floor(rng() * n)) : randBelow(n); }

  // ======================================================================
  // Pure logic
  // ======================================================================
  // "Alice x3" / "Bob ×2" / "Carol *1.5" -> weight; bullets / numbers / task
  // boxes are ignored; a single line with commas is a comma list.
  function parseList(text) {
    var lines = String(text || '').split(/\r?\n/);
    var nonEmpty = lines.filter(function (l) { return l.trim(); });
    var comma = nonEmpty.length === 1 && /[,;]/.test(nonEmpty[0]);
    var raw = comma ? nonEmpty[0].split(/[,;]/) : lines;
    var items = [];
    for (var i = 0; i < raw.length && items.length < MAX_ITEMS; i++) {
      var s = String(raw[i]).replace(/^\s*(?:[-*+\u2022]|\d{1,3}[.)])\s+/, '').replace(/^\s*\[[ xX]\]\s+/, '').trim();
      if (!s) continue;
      var w = 1, m = /^(.*\S)\s+[x\u00d7*]\s*(\d+(?:\.\d+)?)$/i.exec(s);
      if (m) { s = m[1]; w = parseFloat(m[2]); }
      if (!(w > 0)) continue;
      items.push({ name: s, w: Math.min(w, 1000), src: i });
    }
    return { items: items, comma: comma };
  }
  // Remove the entry that came from raw index `src` and return the new text.
  function removeEntry(text, src, comma) {
    if (comma) {
      var line = String(text || '').split(/\r?\n/).filter(function (l) { return l.trim(); })[0] || '';
      var parts = line.split(/[,;]/);
      parts.splice(src, 1);
      return parts.map(function (x) { return x.trim(); }).filter(Boolean).join(', ');
    }
    var lines = String(text || '').split(/\r?\n/);
    lines.splice(src, 1);
    return lines.join('\n');
  }
  function totalWeight(items) { var t = 0; for (var i = 0; i < items.length; i++) t += items[i].w; return t; }
  // Weighted pick: r in [0,1) -> index.
  function weightedIndex(items, r) {
    var x = r * totalWeight(items);
    for (var i = 0; i < items.length; i++) { x -= items[i].w; if (x < 0) return i; }
    return items.length - 1;
  }
  // Wheel slices clockwise from the pointer: [{a0, a1}] in radians, by weight.
  function segments(items) {
    var tot = totalWeight(items), a = 0, out = [];
    for (var i = 0; i < items.length; i++) {
      var span = tot > 0 ? items[i].w / tot * TAU : 0;
      out.push({ a0: a, a1: i === items.length - 1 ? TAU : a + span });
      a += span;
    }
    return out;
  }
  function mod(a, m) { return ((a % m) + m) % m; }
  function segmentAt(segs, phi) {
    phi = mod(phi, TAU);
    for (var i = 0; i < segs.length; i++) if (phi >= segs[i].a0 && phi < segs[i].a1) return i;
    return segs.length - 1;
  }
  // Where in a slice the pointer stops: away from the edges so it's never ambiguous.
  function landing(seg, u) { return seg.a0 + (0.1 + 0.8 * u) * (seg.a1 - seg.a0); }
  // Extra rotation from `rot` so the wheel point `phi` ends under the pointer
  // (the pointer sees wheel angle -rot) after `turns` full turns.
  function spinDelta(rot, phi, turns) { return turns * TAU + mod(-phi - rot, TAU); }
  function easeOut(t) { return 1 - Math.pow(1 - t, 4); }

  function shuffle(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = ri(i + 1, rng), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  // Random order; with weights, heavier items tend to come first
  // (Efraimidis-Spirakis keys u^(1/w)), so "pick N" is a weighted draw
  // without replacement.
  function weightedOrder(items, rng) {
    var weighted = items.some(function (x) { return x.w !== 1; });
    if (!weighted) return shuffle(items, rng);
    return items.map(function (x) {
      var u = rng ? rng() : rand01();
      return { x: x, k: Math.log(Math.max(u, 1e-300)) / x.w };
    }).sort(function (a, b) { return b.k - a.k; }).map(function (o) { return o.x; });
  }
  // Split into teams. mode 'n' = val teams, 'k' = teams of about val. Sizes
  // differ by at most one. Weighted items are balanced: strongest first,
  // each onto the open team with the lowest total (ties: fewer members, then
  // random), where "open" respects the size caps.
  function makeTeams(items, mode, val, rng) {
    var n = items.length;
    if (!n) return [];
    val = Math.max(1, Math.floor(val) || 1);
    var T = mode === 'k' ? Math.ceil(n / val) : Math.min(val, n);
    var base = Math.floor(n / T), extra = n % T, big = 0;
    var teams = [], tot = [], i;
    for (i = 0; i < T; i++) { teams.push([]); tot.push(0); }
    var order = shuffle(items, rng);
    var weighted = items.some(function (x) { return x.w !== 1; });
    if (!weighted) {
      // deal like cards; random team order so the +1 teams aren't always first
      var tOrder = shuffle(teams.map(function (_, k) { return k; }), rng);
      for (i = 0; i < n; i++) teams[tOrder[i % T]].push(order[i]);
      return teams;
    }
    order.sort(function (a, b) { return b.w - a.w; }); // stable sort keeps the shuffle among equals
    for (i = 0; i < n; i++) {
      var best = -1, ties = [];
      for (var t = 0; t < T; t++) {
        var sz = teams[t].length;
        if (!(sz < base || (sz === base && big < extra))) continue;
        if (best < 0 || tot[t] < tot[best] - 1e-9 || (Math.abs(tot[t] - tot[best]) < 1e-9 && sz < teams[best].length)) { best = t; ties = [t]; }
        else if (Math.abs(tot[t] - tot[best]) < 1e-9 && sz === teams[best].length) ties.push(t);
      }
      var pick = ties.length > 1 ? ties[ri(ties.length, rng)] : best;
      if (teams[pick].length === base) big++;
      teams[pick].push(order[i]);
      tot[pick] += order[i].w;
    }
    return teams;
  }
  function teamsMarkdown(teams) {
    var weighted = teams.some(function (t) { return t.some(function (x) { return x.w !== 1; }); });
    return teams.map(function (t, i) {
      var sum = t.reduce(function (s, x) { return s + x.w; }, 0);
      return '### Team ' + (i + 1) + (weighted ? ' (' + fmtNum(sum) + ')' : '') + '\n' +
        t.map(function (x) { return '- ' + x.name; }).join('\n');
    }).join('\n\n');
  }
  function fmtNum(v) { return String(Math.round(v * 100) / 100); }

  // count random values in [min, max] with `dec` decimal places (decimals are
  // integers in a scaled range, so "unique" works for them too).
  function randomNumbers(min, max, dec, count, unique, rng) {
    dec = Math.max(0, Math.min(6, Math.floor(dec) || 0));
    var f = Math.pow(10, dec);
    if (!isFinite(min) || !isFinite(max)) return { err: 'Enter a range' };
    if (min > max) { var t = min; min = max; max = t; }
    var lo = Math.ceil(min * f - 1e-7), hi = Math.floor(max * f + 1e-7);
    if (lo > hi) return { err: 'No ' + (dec ? 'values' : 'whole numbers') + ' in that range' };
    var size = hi - lo + 1;
    if (size > 9007199254740991) return { err: 'Range too large' };
    count = Math.max(1, Math.min(MAX_COUNT, Math.floor(count) || 1));
    if (unique && count > size) return { err: 'Only ' + size + ' unique value' + (size === 1 ? '' : 's') + ' in that range' };
    var vals = [], k;
    if (unique && count * 2 > size) {
      // dense: partial Fisher-Yates over the whole (small) range
      var all = [];
      for (k = 0; k < size; k++) all.push(lo + k);
      for (k = 0; k < count; k++) { var j = k + ri(size - k, rng), tmp = all[k]; all[k] = all[j]; all[j] = tmp; vals.push(all[k]); }
    } else if (unique) {
      var seen = {};
      while (vals.length < count) { var v = lo + ri(size, rng); if (!seen[v]) { seen[v] = 1; vals.push(v); } }
    } else {
      for (k = 0; k < count; k++) vals.push(lo + ri(size, rng));
    }
    return { vals: vals.map(function (v) { return v / f; }), dec: dec };
  }
  function rollDice(count, sides, rng) {
    var out = [];
    for (var i = 0; i < count; i++) out.push(1 + ri(sides, rng));
    return out;
  }

  // ======================================================================
  // State
  // ======================================================================
  var DEF = {
    tab: 'wheel', list: '', recent: [], hist: [], rmWin: false, sound: false,
    tMode: 'n', tN: 2, tK: 3,
    nMin: 1, nMax: 100, nDec: 0, nCount: 1, nUnique: true, nSort: false,
    sN: 0, sFmt: 'lines',
    coin: { h: 0, t: 0, side: '', streak: 0, best: 0, last: '' },
  };
  var ST = null;
  var saveT = 0;
  function loadState() {
    var s = {};
    try { s = JSON.parse(Cade.store.get(KEY) || '{}') || {}; } catch (e) { s = {}; }
    ST = {};
    for (var k in DEF) {
      var d = DEF[k], v = s[k];
      ST[k] = v !== undefined && v !== null && typeof v === typeof d && Array.isArray(v) === Array.isArray(d) ? v : JSON.parse(JSON.stringify(d));
    }
    if (!TABS.some(function (t) { return t[0] === ST.tab; })) ST.tab = 'wheel';
    ST.list = String(ST.list).slice(0, MAX_LIST_CHARS);
    ST.recent = ST.recent.filter(function (x) { return typeof x === 'string'; }).slice(0, MAX_RECENT);
    ST.hist = ST.hist.filter(function (x) { return x && typeof x.n === 'string'; }).slice(0, MAX_HIST);
    var c = ST.coin;
    ['h', 't', 'streak', 'best'].forEach(function (k) { c[k] = +c[k] || 0; });
    c.last = String(c.last || '').slice(-30);
  }
  function save(now) {
    clearTimeout(saveT);
    var w = function () { try { Cade.store.set(KEY, JSON.stringify(ST)); } catch (e) {} };
    if (now) w(); else saveT = setTimeout(w, 400);
  }
  function rememberList(text) {
    text = String(text || '').trim();
    if (!text) return;
    var t = text.slice(0, 2000);
    ST.recent = [t].concat(ST.recent.filter(function (x) { return x.trim() !== t; })).slice(0, MAX_RECENT);
  }

  // ======================================================================
  // UI plumbing
  // ======================================================================
  function panel() { return document.getElementById(PANEL_ID); }
  function q(sel) { var p = panel(); return p ? p.querySelector(sel) : null; }
  function reducedMotion() { return false; }
  function toast(m, t, ms) { Cade.showToast(m, t || 'info', ms || 2000); }
  function copyText(text) {
    var done = function () { toast('Copied', 'success', 1200); };
    var fail = function () { toast('Copy failed', 'error'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      ta.remove();
    }
  }
  function insertText(text) {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error'); return; }
    ed.dispatch(ed.state.replaceSelection(text), { userEvent: 'input', scrollIntoView: true });
    toast('Inserted', 'success', 1000);
  }
  var ACT2 = function (key) {
    return '<button class="rp-ib" data-copy="' + key + '" title="Copy" aria-label="Copy">⧉</button>' +
      '<button class="rp-ib" data-ins="' + key + '" title="Insert at cursor" aria-label="Insert at cursor">↵</button>';
  };
  var OUT = {}; // key -> text for copy / insert buttons
  function items() { return parseList(ST.list); }

  // ---- sound (opt-in; context made on the gesture that needs it, closed on close) ----
  var actx = null, lastTick = 0;
  function audio() {
    if (!ST.sound) return null;
    try {
      if (!actx) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; actx = new AC(); }
      if (actx.state === 'suspended') actx.resume();
    } catch (e) { return null; }
    return actx;
  }
  function blip(freq, dur, vol) {
    if (!ST.sound || !actx) return;
    try {
      var t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
      o.type = 'triangle'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(actx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) {}
  }
  function tick() {
    var now = performance.now();
    if (now - lastTick < 28) return; // fast spins would otherwise buzz
    lastTick = now;
    blip(1700, 0.035, 0.18);
  }
  function chime() { blip(880, 0.25, 0.2); setTimeout(function () { blip(1320, 0.35, 0.16); }, 90); }

  // ======================================================================
  // Wheel
  // ======================================================================
  var W = { rot: 0, segs: [], items: [], win: -1, spin: null, raf: 0, off: null, offKey: '' };
  function segColor(i) {
    var h = (i * 137.508 + 178) % 360;
    return { fill: 'hsl(' + h.toFixed(1) + ', 68%, 52%)', ink: inkFor(h, 0.68, 0.52) };
  }
  // Text colour for a slice: dark on light hues (yellows / greens), white otherwise.
  function inkFor(h, s, l) {
    var k = function (n) { var kk = (n + h / 30) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(kk - 3, 9 - kk, 1)); };
    var lin = function (v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    var Y = 0.2126 * lin(k(0)) + 0.7152 * lin(k(8)) + 0.0722 * lin(k(4));
    return Y > 0.33 ? '#1c1917' : '#ffffff';
  }
  function fontFamily() {
    try { return getComputedStyle(panel()).getPropertyValue('--font-body').trim() || 'sans-serif'; } catch (e) { return 'sans-serif'; }
  }
  // Pre-render the wheel (slices + labels) once per list / size; frames just rotate it.
  function buildWheel(cv, css, dpr) {
    var it = W.items, segs = W.segs;
    var key = css + '|' + dpr + '|' + it.map(function (x) { return x.name + '*' + x.w; }).join('\n');
    if (W.off && W.offKey === key) return W.off;
    var off = document.createElement('canvas');
    off.width = off.height = Math.round(css * dpr);
    var c = off.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var R = css / 2 - 3, cx = css / 2, fam = fontFamily();
    var sep = getComputedStyle(panel()).getPropertyValue('--surface').trim() || '#fff';
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i], col = segColor(i);
      c.beginPath(); c.moveTo(cx, cx);
      c.arc(cx, cx, R, s.a0 - Math.PI / 2, s.a1 - Math.PI / 2);
      c.closePath();
      c.fillStyle = col.fill; c.fill();
      if (segs.length > 1) { c.strokeStyle = sep; c.lineWidth = segs.length > 40 ? 0.75 : 1.5; c.stroke(); }
      var arc = (s.a1 - s.a0) * R * 0.7;
      if (arc < 9) continue; // too thin for a label
      var fs = Math.max(9, Math.min(16, arc * 0.55, R * 0.11));
      c.save();
      c.translate(cx, cx);
      c.rotate((s.a0 + s.a1) / 2 - Math.PI / 2);
      c.font = '600 ' + fs.toFixed(1) + 'px ' + fam;
      c.textAlign = 'right'; c.textBaseline = 'middle'; c.fillStyle = col.ink;
      var max = R * 0.66, t = it[i].name;
      if (c.measureText(t).width > max) {
        var lo = 0, hi = t.length;
        while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (c.measureText(t.slice(0, mid) + '…').width <= max) lo = mid; else hi = mid - 1; }
        t = t.slice(0, lo) + '…';
      }
      c.fillText(t, R - 10, 0);
      c.restore();
    }
    W.off = off; W.offKey = key;
    return off;
  }
  function drawWheel() {
    var cv = q('.rp-wheel');
    if (!cv || !cv.clientWidth) return;
    var css = cv.clientWidth, dpr = Math.min(2, window.devicePixelRatio || 1), px = Math.round(css * dpr);
    if (cv.width !== px) { cv.width = cv.height = px; }
    var c = cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, px, px);
    var R = css / 2 - 3, cx = css / 2;
    if (!W.segs.length) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.beginPath(); c.arc(cx, cx, R, 0, TAU);
      c.fillStyle = 'rgba(127,127,127,0.12)'; c.fill();
      c.strokeStyle = 'rgba(127,127,127,0.35)'; c.lineWidth = 2; c.setLineDash([6, 6]); c.stroke(); c.setLineDash([]);
      return;
    }
    var off = buildWheel(cv, css, dpr);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.translate(px / 2, px / 2);
    c.rotate(W.rot);
    c.drawImage(off, -px / 2, -px / 2);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (W.win >= 0 && !W.spin && W.segs[W.win]) {
      var s = W.segs[W.win];
      c.beginPath(); c.moveTo(cx, cx);
      c.arc(cx, cx, R, s.a0 + W.rot - Math.PI / 2, s.a1 + W.rot - Math.PI / 2);
      c.closePath();
      c.fillStyle = 'rgba(255,255,255,0.16)'; c.fill();
      c.strokeStyle = '#fff'; c.lineWidth = 3; c.stroke();
    }
  }
  function syncWheel() {
    if (W.spin) return; // the spinning wheel keeps its slices until it stops
    var parsed = items();
    W.items = parsed.items;
    W.segs = segments(parsed.items);
    if (W.win >= W.items.length) W.win = -1;
    drawWheel();
  }
  function spin() {
    if (W.spin) return;
    syncWheel();
    if (!W.items.length) { toast('Add some items to the list first'); var ta = q('.rp-list'); if (ta) ta.focus(); return; }
    rememberList(ST.list);
    audio();
    var wi = weightedIndex(W.items, rand01());
    var phi = landing(W.segs[wi], rand01());
    var rm = reducedMotion();
    var turns = rm ? 1 : 4 + randBelow(3);
    W.win = -1;
    W.spin = {
      from: W.rot, delta: spinDelta(W.rot, phi, turns), t0: performance.now(), dur: rm ? 700 : 4300 + randBelow(1300),
      wi: wi, last: segmentAt(W.segs, -W.rot), item: W.items[wi], src: ST.list,
    };
    var p = panel(); if (p) p.classList.add('rp-spinning');
    q('[data-res="wheel"]').innerHTML = '<div class="rp-res-wait">Spinning…</div>';
    W.raf = requestAnimationFrame(spinFrame);
  }
  function spinFrame(ts) {
    W.raf = 0;
    var s = W.spin;
    if (!s || !panel()) return;
    var t = Math.min(1, Math.max(0, (ts - s.t0) / s.dur));
    W.rot = s.from + s.delta * easeOut(t);
    var cur = segmentAt(W.segs, -W.rot);
    if (cur !== s.last) {
      s.last = cur;
      tick();
      var ptr = q('.rp-pointer');
      if (ptr) { ptr.classList.remove('kick'); void ptr.offsetWidth; ptr.classList.add('kick'); }
    }
    drawWheel();
    if (t < 1) { W.raf = requestAnimationFrame(spinFrame); return; }
    W.rot = mod(W.rot, TAU);
    W.spin = null;
    var p = panel(); if (p) p.classList.remove('rp-spinning');
    finishSpin(s);
  }
  function finishSpin(s) {
    var it = s.item;
    W.lastSpin = s;
    if (ST.list !== s.src) syncWheel(); // the list was edited mid-spin: show the new wheel
    else { W.win = s.wi; drawWheel(); }
    ST.hist.unshift({ n: it.name, ts: Date.now() });
    ST.hist = ST.hist.slice(0, MAX_HIST);
    OUT.wheel = it.name;
    q('[data-res="wheel"]').innerHTML =
      '<div class="rp-res-main"><span class="rp-res-k">Winner</span><b class="rp-pop">' + esc(it.name) + '</b></div>' +
      '<div class="rp-res-acts">' + ACT2('wheel') +
      '<button class="rp-btn sm" data-act="remove-win" title="Remove this entry from the list">Remove</button></div>';
    Cade.haptic(20);
    chime();
    confetti(it, s.wi);
    if (ST.rmWin) removeWinner(s);
    renderHist();
    save();
  }
  // Remove the winning entry (only if the list still has it where it was).
  function removeWinner(s) {
    s = s || W.lastSpin;
    if (!s) return;
    var parsed = items();
    var still = parsed.items.filter(function (x) { return x.src === s.item.src && x.name === s.item.name; })[0];
    if (!still) { toast('That entry is no longer in the list'); return; }
    ST.list = removeEntry(ST.list, still.src, parsed.comma);
    var ta = q('.rp-list'); if (ta) ta.value = ST.list;
    W.win = -1;
    W.lastSpin = null;
    updateCount();
    syncWheel();
    var b = q('[data-act="remove-win"]'); if (b) { b.disabled = true; b.textContent = 'Removed'; }
    save();
  }

  // ---- confetti-lite: ~70 flakes for 1.6 s on a canvas over the panel ----
  var CF = null;
  function confetti(it, wi) {
    if (reducedMotion()) return;
    var p = panel(); if (!p) return;
    stopConfetti();
    var cv = document.createElement('canvas');
    cv.className = 'rp-confetti';
    var w = p.clientWidth, h = p.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    p.appendChild(cv);
    var wheel = q('.rp-wheel'), pr = p.getBoundingClientRect(), ox = w / 2, oy = h / 3;
    if (wheel) { var r = wheel.getBoundingClientRect(); ox = r.left - pr.left + r.width / 2; oy = r.top - pr.top + r.height / 2; }
    var parts = [];
    for (var i = 0; i < 70; i++) {
      var a = rand01() * TAU, v = 120 + rand01() * 260;
      parts.push({
        x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 180, r: rand01() * TAU, vr: (rand01() - 0.5) * 12,
        s: 4 + rand01() * 5, c: segColor(i % 7 === 0 ? wi : randBelow(12)).fill,
      });
    }
    CF = { cv: cv, parts: parts, t0: 0, last: 0, raf: 0, dpr: dpr, w: w, h: h };
    CF.raf = requestAnimationFrame(confettiFrame);
  }
  function confettiFrame(ts) {
    var f = CF; if (!f) return;
    f.raf = 0;
    if (!f.t0) { f.t0 = ts; f.last = ts; }
    var dt = Math.min(0.05, (ts - f.last) / 1000), age = (ts - f.t0) / 1000;
    f.last = ts;
    var c = f.cv.getContext('2d');
    c.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
    c.clearRect(0, 0, f.w, f.h);
    c.globalAlpha = Math.max(0, Math.min(1, (1.6 - age) / 0.5));
    for (var i = 0; i < f.parts.length; i++) {
      var o = f.parts[i];
      o.vy += 620 * dt; o.vx *= 0.99; o.x += o.vx * dt; o.y += o.vy * dt; o.r += o.vr * dt;
      c.save(); c.translate(o.x, o.y); c.rotate(o.r); c.fillStyle = o.c; c.fillRect(-o.s / 2, -o.s / 4, o.s, o.s / 2); c.restore();
    }
    if (age < 1.6) f.raf = requestAnimationFrame(confettiFrame);
    else stopConfetti();
  }
  function stopConfetti() {
    if (!CF) return;
    if (CF.raf) cancelAnimationFrame(CF.raf);
    CF.cv.remove();
    CF = null;
  }

  function renderHist() {
    var box = q('.rp-hist');
    if (!box) return;
    if (!ST.hist.length) { box.innerHTML = '<span class="rp-faint">Winners show up here</span>'; return; }
    OUT.hist = ST.hist.map(function (h) { return h.n; }).join('\n');
    box.innerHTML = '<div class="rp-hhead"><span class="rp-sub">History</span>' + ACT2('hist') +
      '<button class="rp-ib" data-act="hist-clear" title="Clear history" aria-label="Clear history">✕</button></div>' +
      '<div class="rp-chips">' + ST.hist.map(function (h) { return '<span class="rp-chip">' + esc(h.n) + '</span>'; }).join('') + '</div>';
  }

  // ======================================================================
  // Teams / Coin / Number / Shuffle
  // ======================================================================
  function doTeams() {
    var it = items().items;
    var box = q('.rp-teams');
    if (it.length < 2) {
      box.innerHTML = '<div class="rp-empty">Add at least two names to the list</div>';
      OUT.teams = ''; q('[data-out="teams"]').hidden = true;
      return;
    }
    rememberList(ST.list);
    var val = ST.tMode === 'k' ? ST.tK : ST.tN;
    var teams = makeTeams(it, ST.tMode, val);
    var weighted = it.some(function (x) { return x.w !== 1; });
    OUT.teams = teamsMarkdown(teams);
    box.innerHTML = teams.map(function (t, i) {
      var sum = t.reduce(function (s, x) { return s + x.w; }, 0);
      return '<div class="rp-team" style="--rp-c:' + segColor(i).fill + '"><div class="rp-thead"><b>Team ' + (i + 1) + '</b>' +
        '<span>' + t.length + (weighted ? ' · Σ ' + fmtNum(sum) : '') + '</span></div><ul>' +
        t.map(function (x) { return '<li>' + esc(x.name) + (x.w !== 1 ? ' <small>×' + fmtNum(x.w) + '</small>' : '') + '</li>'; }).join('') +
        '</ul></div>';
    }).join('');
    q('[data-out="teams"]').hidden = false;
    save();
  }

  var coinDeg = 0, coinBusy = false;
  function flip() {
    if (coinBusy) return;
    var side = randBelow(2) === 0 ? 'H' : 'T';
    var coin = q('.rp-coin'), wrap = q('.rp-coinwrap');
    var rm = reducedMotion();
    // Keep spinning forward; land with heads (0°) or tails (180°) facing.
    var target = coinDeg - mod(coinDeg, 360) + (rm ? 360 : 360 * (4 + randBelow(3))) + (side === 'T' ? 180 : 0);
    coinDeg = target;
    coinBusy = true;
    audio();
    if (coin) coin.style.transform = 'rotateY(' + coinDeg + 'deg)';
    if (wrap && !rm) { wrap.classList.remove('toss'); void wrap.offsetWidth; wrap.classList.add('toss'); }
    q('[data-res="coin"]').innerHTML = '<div class="rp-res-wait">…</div>';
    setTimeout(function () {
      coinBusy = false;
      if (!panel()) return;
      var c = ST.coin;
      if (side === 'H') c.h++; else c.t++;
      c.streak = c.side === side ? c.streak + 1 : 1;
      c.side = side;
      c.best = Math.max(c.best, c.streak);
      c.last = (c.last + side).slice(-30);
      blip(side === 'H' ? 990 : 660, 0.18, 0.18);
      Cade.haptic(15);
      renderCoin(true);
      save();
    }, rm ? 120 : 1150);
  }
  function renderCoin(fresh) {
    var c = ST.coin, res = q('[data-res="coin"]'), stats = q('.rp-cstats');
    if (!res) return;
    var name = c.side === 'H' ? 'Heads' : c.side === 'T' ? 'Tails' : '';
    OUT.coin = name;
    res.innerHTML = name
      ? '<div class="rp-res-main"><b class="' + (fresh ? 'rp-pop' : '') + '">' + name + '</b>' +
        (c.streak > 1 ? '<span class="rp-streak">' + c.streak + ' in a row</span>' : '') + '</div>' +
        '<div class="rp-res-acts">' + ACT2('coin') + '</div>'
      : '<div class="rp-faint">Tap the coin or press Flip</div>';
    var n = c.h + c.t;
    stats.innerHTML = n
      ? '<span><b>' + c.h + '</b> heads</span><span><b>' + c.t + '</b> tails</span>' +
        '<span>' + Math.round(c.h / n * 100) + '% heads</span><span>best streak <b>' + c.best + '</b></span>' +
        '<div class="rp-trail">' + c.last.split('').map(function (x) { return '<i class="' + x + '">' + x + '</i>'; }).join('') + '</div>'
      : '';
    var coin = q('.rp-coin');
    if (coin && !fresh) { coinDeg = c.side === 'T' ? 180 : 0; coin.style.transition = 'none'; coin.style.transform = 'rotateY(' + coinDeg + 'deg)'; void coin.offsetWidth; coin.style.transition = ''; }
  }

  function fmtVal(v, dec) { return dec ? v.toFixed(dec) : String(v); }
  function doNumbers() {
    var r = randomNumbers(ST.nMin, ST.nMax, ST.nDec, ST.nCount, ST.nUnique);
    var box = q('[data-res="number"]');
    if (r.err) { box.innerHTML = '<div class="rp-err">' + esc(r.err) + '</div>'; OUT.number = ''; return; }
    var vals = r.vals.slice();
    if (ST.nSort) vals.sort(function (a, b) { return a - b; });
    var strs = vals.map(function (v) { return fmtVal(v, r.dec); });
    OUT.number = strs.join(', ');
    box.innerHTML = (strs.length === 1
      ? '<div class="rp-res-main"><b class="rp-pop rp-big">' + esc(strs[0]) + '</b></div>'
      : '<div class="rp-nums">' + strs.map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('') + '</div>') +
      '<div class="rp-res-acts">' + ACT2('number') + '</div>';
    Cade.haptic(10);
    save();
  }
  function doDice(sides) {
    var n = Math.max(1, Math.min(100, Math.floor(ST.nCount) || 1));
    var rolls = rollDice(n, sides);
    var sum = rolls.reduce(function (a, b) { return a + b; }, 0);
    var text = n + 'd' + sides + ': ' + (n > 1 ? rolls.join(' + ') + ' = ' + sum : String(sum));
    OUT.number = text;
    q('[data-res="number"]').innerHTML =
      '<div class="rp-res-main"><span class="rp-res-k">' + n + 'd' + sides + '</span><b class="rp-pop rp-big">' + sum + '</b></div>' +
      (n > 1 ? '<div class="rp-nums">' + rolls.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</div>' : '') +
      '<div class="rp-res-acts">' + ACT2('number') + '</div>';
    Cade.haptic(10);
  }

  var lastShuffle = null;
  function shuffleText(names) {
    var f = ST.sFmt;
    return f === 'comma' ? names.join(', ')
      : names.map(function (s, i) { return (f === 'numbered' ? (i + 1) + '. ' : f === 'bullets' ? '- ' : '') + s; }).join('\n');
  }
  function doShuffle() {
    var it = items().items;
    var box = q('.rp-sout');
    if (!it.length) { box.innerHTML = '<div class="rp-empty">The list is empty</div>'; OUT.shuffle = ''; return; }
    rememberList(ST.list);
    var order = weightedOrder(it);
    var n = ST.sN > 0 ? Math.min(ST.sN, order.length) : order.length;
    var names = order.slice(0, n).map(function (x) { return x.name; });
    lastShuffle = names;
    OUT.shuffle = shuffleText(names);
    box.innerHTML = '<ol class="rp-olist">' + names.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<div class="rp-res-acts"><span class="rp-faint">' + (n < order.length ? 'Picked ' + n + ' of ' + order.length : 'All ' + n + ', shuffled') + '</span>' + ACT2('shuffle') + '</div>';
    save();
  }

  // ======================================================================
  // Panel
  // ======================================================================
  function bodyHtml() {
    var tabs = TABS.map(function (t) { return '<button class="rp-tab" role="tab" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('');
    var dice = [4, 6, 8, 10, 12, 20, 100].map(function (d) { return '<button class="rp-chip btn" data-die="' + d + '">d' + d + '</button>'; }).join('');
    var decs = [0, 1, 2, 3].map(function (d) { return '<option value="' + d + '">' + (d ? d + ' decimal' + (d > 1 ? 's' : '') : 'Whole numbers') + '</option>'; }).join('');
    return '<div class="rp-tabs" role="tablist">' + tabs + '</div>' +
      '<div class="rp-scroll">' +
      '<section class="rp-listbox">' +
        '<div class="rp-lhead"><span class="rp-lcount"></span>' +
          '<button class="rp-btn sm" data-act="from-sel" title="Use the lines selected in the note">From selection</button>' +
          '<select class="rp-in rp-recent" aria-label="Recent lists"></select>' +
          '<button class="rp-ib" data-act="clear-list" title="Clear the list" aria-label="Clear the list">✕</button></div>' +
        '<textarea class="rp-in rp-list" rows="5" spellcheck="false" autocomplete="off" ' +
          'placeholder="One per line, or a, b, c — add x3 to weight an entry (Alice x3)"></textarea>' +
      '</section>' +
      // wheel
      '<section class="rp-pane" data-pane="wheel">' +
        '<div class="rp-wheelwrap"><canvas class="rp-wheel" width="300" height="300"></canvas>' +
          '<div class="rp-pointer" aria-hidden="true"></div>' +
          '<button class="rp-spin" data-act="spin" title="Spin (Space)">SPIN</button></div>' +
        '<div class="rp-res" data-res="wheel"><div class="rp-faint">Tap SPIN — the winner is drawn with your device\'s secure random source</div></div>' +
        '<div class="rp-opts"><label class="rp-check"><input type="checkbox" data-k="rmWin"> Remove winner after each spin</label>' +
          '<button class="rp-btn sm rp-sound" data-act="sound" aria-pressed="false"></button></div>' +
        '<div class="rp-hist"></div>' +
      '</section>' +
      // teams
      '<section class="rp-pane" data-pane="teams">' +
        '<div class="rp-row"><div class="rp-seg" data-seg="tMode"><button data-v="n">Number of teams</button><button data-v="k">Team size</button></div>' +
          '<input class="rp-in rp-num" data-k="tVal" type="number" inputmode="numeric" min="1" max="500" aria-label="Teams or size"></div>' +
        '<div class="rp-acts"><button class="rp-btn primary" data-act="teams">Make teams</button>' +
          '<span class="rp-out" data-out="teams" hidden>' + ACT2('teams') + '</span></div>' +
        '<div class="rp-teams"><div class="rp-faint">Weights (Alice x3) count as skill: teams are balanced by total.</div></div>' +
      '</section>' +
      // coin
      '<section class="rp-pane" data-pane="coin">' +
        '<div class="rp-coinwrap"><button class="rp-coin" data-act="flip" aria-label="Flip the coin">' +
          '<span class="rp-face h">H</span><span class="rp-face t">T</span></button></div>' +
        '<div class="rp-res" data-res="coin"></div>' +
        '<div class="rp-acts center"><button class="rp-btn primary" data-act="flip">Flip</button>' +
          '<button class="rp-btn" data-act="coin-reset">Reset stats</button></div>' +
        '<div class="rp-cstats"></div>' +
      '</section>' +
      // number
      '<section class="rp-pane" data-pane="number">' +
        '<div class="rp-grid">' +
          '<label class="rp-f"><span>From</span><input class="rp-in" data-k="nMin" type="number" step="any"></label>' +
          '<label class="rp-f"><span>To</span><input class="rp-in" data-k="nMax" type="number" step="any"></label>' +
          '<label class="rp-f"><span>How many</span><input class="rp-in" data-k="nCount" type="number" inputmode="numeric" min="1" max="' + MAX_COUNT + '"></label>' +
          '<label class="rp-f"><span>Precision</span><select class="rp-in" data-k="nDec">' + decs + '</select></label>' +
        '</div>' +
        '<div class="rp-opts"><label class="rp-check"><input type="checkbox" data-k="nUnique"> No repeats</label>' +
          '<label class="rp-check"><input type="checkbox" data-k="nSort"> Sorted</label></div>' +
        '<div class="rp-acts"><button class="rp-btn primary" data-act="gen">Generate</button></div>' +
        '<div class="rp-res" data-res="number"></div>' +
        '<div class="rp-sub">Dice <span class="rp-faint">— rolls “How many” dice</span></div>' +
        '<div class="rp-chips">' + dice + '</div>' +
      '</section>' +
      // shuffle
      '<section class="rp-pane" data-pane="shuffle">' +
        '<div class="rp-grid">' +
          '<label class="rp-f"><span>Pick (blank = all)</span><input class="rp-in" data-k="sN" type="number" inputmode="numeric" min="1" placeholder="all"></label>' +
          '<label class="rp-f"><span>Copy / insert as</span><select class="rp-in" data-k="sFmt">' +
            '<option value="lines">Lines</option><option value="numbered">1. Numbered</option><option value="bullets">- Bullets</option><option value="comma">a, b, c</option></select></label>' +
        '</div>' +
        '<div class="rp-acts"><button class="rp-btn primary" data-act="shuffle">Shuffle</button></div>' +
        '<div class="rp-sout"></div>' +
      '</section>' +
      '</div>';
  }

  function updateCount() {
    var el = q('.rp-lcount'); if (!el) return;
    var p = items(), n = p.items.length, wsum = totalWeight(p.items);
    el.textContent = n ? n + ' item' + (n === 1 ? '' : 's') + (wsum !== n ? ' · weight ' + fmtNum(wsum) : '') : 'List';
  }
  function renderRecent() {
    var sel = q('.rp-recent'); if (!sel) return;
    var opts = '<option value="">Recent lists…</option>';
    ST.recent.forEach(function (t, i) {
      var p = parseList(t).items, label = p.slice(0, 3).map(function (x) { return x.name; }).join(', ');
      if (label.length > 34) label = label.slice(0, 33) + '…';
      opts += '<option value="' + i + '">' + esc(label + (p.length > 3 ? '… (' + p.length + ')' : '')) + '</option>';
    });
    sel.innerHTML = opts;
    sel.disabled = !ST.recent.length;
  }
  function setList(text, keepOld) {
    if (keepOld && ST.list.trim() && ST.list.trim() !== String(text).trim()) rememberList(ST.list);
    ST.list = String(text || '').slice(0, MAX_LIST_CHARS);
    var ta = q('.rp-list'); if (ta) ta.value = ST.list;
    W.win = -1;
    updateCount(); renderRecent(); syncWheel(); save();
  }
  function selectionList() {
    try {
      var st = Cade.editor.state, sel = st.selection.main;
      if (sel.empty) return '';
      var t = st.sliceDoc(sel.from, Math.min(sel.to, sel.from + MAX_LIST_CHARS));
      return parseList(t).items.length >= 2 ? t : '';
    } catch (e) { return ''; }
  }

  function showTab(t) {
    var p = panel(); if (!p) return;
    ST.tab = t;
    p.querySelectorAll('.rp-tab').forEach(function (b) {
      var on = b.getAttribute('data-tab') === t;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    p.querySelectorAll('.rp-pane').forEach(function (s) { s.hidden = s.getAttribute('data-pane') !== t; });
    p.querySelector('.rp-listbox').hidden = !(t === 'wheel' || t === 'teams' || t === 'shuffle');
    if (t === 'wheel') syncWheel();
    save();
  }
  function syncInputs() {
    var p = panel(); if (!p) return;
    p.querySelector('[data-k="rmWin"]').checked = !!ST.rmWin;
    p.querySelector('[data-k="nUnique"]').checked = !!ST.nUnique;
    p.querySelector('[data-k="nSort"]').checked = !!ST.nSort;
    p.querySelector('[data-k="nMin"]').value = ST.nMin;
    p.querySelector('[data-k="nMax"]').value = ST.nMax;
    p.querySelector('[data-k="nCount"]').value = ST.nCount;
    p.querySelector('[data-k="nDec"]').value = String(ST.nDec);
    p.querySelector('[data-k="sN"]').value = ST.sN > 0 ? ST.sN : '';
    p.querySelector('[data-k="sFmt"]').value = ST.sFmt;
    p.querySelector('[data-k="tVal"]').value = ST.tMode === 'k' ? ST.tK : ST.tN;
    p.querySelectorAll('[data-seg="tMode"] button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === ST.tMode); });
    var sb = p.querySelector('[data-act="sound"]');
    sb.textContent = ST.sound ? '🔊 Sound on' : '🔇 Sound off';
    sb.classList.toggle('on', !!ST.sound);
    sb.setAttribute('aria-pressed', ST.sound ? 'true' : 'false');
  }

  function mainAction() {
    switch (ST.tab) {
      case 'wheel': spin(); break;
      case 'teams': doTeams(); break;
      case 'coin': flip(); break;
      case 'number': doNumbers(); break;
      case 'shuffle': doShuffle(); break;
    }
  }

  var listT = 0;
  function onInput(e) {
    var t = e.target, k = t.getAttribute('data-k');
    if (t.classList.contains('rp-list')) {
      ST.list = t.value.slice(0, MAX_LIST_CHARS);
      clearTimeout(listT);
      listT = setTimeout(function () { W.win = -1; updateCount(); if (ST.tab === 'wheel') syncWheel(); save(); }, 150);
      return;
    }
    if (!k) return;
    var num = parseFloat(String(t.value).replace(',', '.'));
    switch (k) {
      case 'rmWin': case 'nUnique': case 'nSort': ST[k] = t.checked; break;
      case 'nMin': case 'nMax': if (isFinite(num)) ST[k] = num; break;
      case 'nCount': if (num >= 1) ST.nCount = Math.min(MAX_COUNT, Math.floor(num)); break;
      case 'nDec': ST.nDec = +t.value || 0; break;
      case 'sN': ST.sN = num >= 1 ? Math.floor(num) : 0; break;
      case 'sFmt': ST.sFmt = t.value; if (lastShuffle) OUT.shuffle = shuffleText(lastShuffle); break;
      case 'tVal': if (num >= 1) { if (ST.tMode === 'k') ST.tK = Math.floor(num); else ST.tN = Math.floor(num); } break;
      default: return;
    }
    save();
  }

  function onClick(e) {
    var t = e.target.closest ? e.target : null;
    if (!t) return;
    var b;
    if ((b = t.closest('.rp-tab'))) { showTab(b.getAttribute('data-tab')); return; }
    if ((b = t.closest('[data-copy]'))) { var v = OUT[b.getAttribute('data-copy')]; if (v) copyText(v); return; }
    if ((b = t.closest('[data-ins]'))) { var w = OUT[b.getAttribute('data-ins')]; if (w) insertText(w); return; }
    if ((b = t.closest('[data-die]'))) { doDice(+b.getAttribute('data-die')); return; }
    if ((b = t.closest('[data-seg] button'))) {
      ST.tMode = b.getAttribute('data-v');
      syncInputs(); save();
      return;
    }
    if ((b = t.closest('[data-act]'))) {
      switch (b.getAttribute('data-act')) {
        case 'spin': spin(); break;
        case 'remove-win': removeWinner(W.lastSpin); break;
        case 'sound': ST.sound = !ST.sound; if (ST.sound) audio(); syncInputs(); save(); break;
        case 'hist-clear': ST.hist = []; renderHist(); save(); break;
        case 'teams': doTeams(); break;
        case 'flip': flip(); break;
        case 'coin-reset': ST.coin = { h: 0, t: 0, side: '', streak: 0, best: 0, last: '' }; renderCoin(false); save(); break;
        case 'gen': doNumbers(); break;
        case 'shuffle': doShuffle(); break;
        case 'from-sel': {
          var s = selectionList();
          if (s) { setList(s, true); toast('List from selection', 'success', 1200); }
          else toast('Select two or more lines (or a, b, c) in the note first');
          break;
        }
        case 'clear-list':
          if (ST.list.trim()) { rememberList(ST.list); setList(''); toast('List cleared — it\'s under Recent lists'); }
          break;
      }
    }
  }

  function close() {
    var p = panel();
    if (!p) return;
    p.remove();
    if (p._onClose) p._onClose();
  }

  function open() {
    Cade.closeAllMenus();
    if (panel()) { close(); return; }
    loadState();
    // Reset anything a previous session left behind (e.g. a panel removed mid-spin).
    if (W.raf) cancelAnimationFrame(W.raf);
    W.raf = 0; W.spin = null; W.lastSpin = null; W.win = -1;
    stopConfetti();
    coinBusy = false; lastShuffle = null; OUT = {};
    var fromSel = selectionList();
    if (fromSel) {
      if (ST.list.trim() && ST.list.trim() !== fromSel.trim()) rememberList(ST.list);
      ST.list = fromSel;
    }
    var p = Cade.mkPanel(PANEL_ID, '🎲 Random Picker', bodyHtml());
    var ta = p.querySelector('.rp-list');
    ta.value = ST.list;
    p.addEventListener('input', onInput);
    p.addEventListener('change', function (e) {
      if (e.target.classList.contains('rp-recent')) {
        var i = e.target.value;
        if (i !== '' && ST.recent[+i] != null) { setList(ST.recent[+i], true); toast('Loaded a recent list', 'success', 1000); }
        e.target.value = '';
        return;
      }
      if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') onInput(e);
    });
    p.addEventListener('click', onClick);
    p.addEventListener('keydown', function (e) {
      var tag = e.target.tagName;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      var typing = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT';
      if (!typing && tag !== 'BUTTON' && (e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); mainAction(); }
      else if (tag === 'INPUT' && e.key === 'Enter' && e.target.type !== 'checkbox') { e.preventDefault(); mainAction(); }
      e.stopPropagation(); // keep editor / app shortcuts out of the panel
    });
    p._onClose = function () {
      if (W.raf) { cancelAnimationFrame(W.raf); W.raf = 0; }
      if (W.spin) { W.rot = W.spin.from + W.spin.delta; W.spin = null; }
      stopConfetti();
      clearTimeout(listT);
      if (actx) { try { actx.close(); } catch (e) {} actx = null; }
      W.off = null; W.offKey = '';
      coinBusy = false;
      window.removeEventListener('resize', onResize);
      if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = 0; }
      save(true);
    };
    syncInputs();
    updateCount();
    renderRecent();
    renderHist();
    renderCoin(false);
    showTab(ST.tab);
    window.addEventListener('resize', onResize);
  }
  // The panel can change width (rotation, window resize): redraw the wheel at its new size.
  var resizeRaf = 0;
  function onResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(function () { resizeRaf = 0; if (panel() && ST.tab === 'wheel' && !W.spin) drawWheel(); });
  }

  Cade.registerWidget({
    name: 'Random Picker',
    description: 'Spin a wheel, make teams, flip a coin, roll dice, random numbers, shuffle a list',
    icon: '🎲',
    tags: 'random,picker,wheel,spin,raffle,draw,lottery,winner,team,teams,group,coin,flip,dice,roll,d20,number,generator,shuffle,choose,decide',
    open: open,
    _lib: {
      parseList: parseList, removeEntry: removeEntry, weightedIndex: weightedIndex, segments: segments, segmentAt: segmentAt,
      landing: landing, spinDelta: spinDelta, mod: mod, shuffle: shuffle, weightedOrder: weightedOrder, makeTeams: makeTeams,
      teamsMarkdown: teamsMarkdown, randomNumbers: randomNumbers, rollDice: rollDice, randBelow: randBelow, rand01: rand01,
      easeOut: easeOut,
    },
  });
})();
