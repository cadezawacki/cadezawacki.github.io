/* Tower Defense V2 — "Glyph Defense": the expanded ASCII tower defense for
 * Cade.txt. 40 towers (three upgrades, then one of three final branches), 74
 * glyph enemies (a–z, A–Z, digits, ? and !, and ten bosses), 35 maps over seven
 * regions — each region ends in an ULTRA map you pan and zoom around.
 *
 * This file is the UI; the pure engine (td2-engine.js), the catalog
 * (td2-data.js) and the maps (td2-maps.js) load on first open. The map is drawn
 * as monospace glyphs on a canvas like the original Tower Defense: terrain and
 * towers are cached in 8x8-cell chunks at the current zoom, each frame adds only
 * what moves, and the frame loop runs only while a wave is live and the panel is
 * visible. Progress, perks, the codex and a game in progress persist. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('td2.css');
  // resolve now, while the loader's module context is ours
  var URLS = [Cade.asset('td2-maps.js'), Cade.asset('td2-data.js'), Cade.asset('td2-engine.js')];

  var PANEL_ID = 'towerdefense2-panel', TITLE = '🏯 Tower Defense V2';
  var PROG_KEY = 'cade-td2-progress', SAVE_KEY = 'cade-td2-save';
  var CELL = 30, CH = 8;                                  // logical units per cell; chunk size in cells
  var BRACKETS = [['[', ']'], ['[', ']'], ['{', '}'], ['«', '»'], ['«', '»']], PIPS = ['', '·', '··', '···'];
  var SPEEDS = [1, 2, 3, 4];
  var E = null, S = null, loading = null;

  function loadScript(url) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('Could not load ' + url.split('/').pop())); };
      document.head.appendChild(s);
    });
  }
  function loadEngine() {
    if (E) return Promise.resolve(E);
    if (loading) return loading;
    loading = (window.__TD2Maps ? Promise.resolve() : loadScript(URLS[0]))
      .then(function () { return window.__TD2Data ? 0 : loadScript(URLS[1]); })
      .then(function () { return window.__TD2Engine ? 0 : loadScript(URLS[2]); })
      .then(function () {
        if (!window.__TD2Engine) throw new Error('engine missing');
        E = window.__TD2Engine;
        return E;
      }, function (e) { loading = null; throw e; });
    return loading;
  }

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function sdel(k) { try { Cade.store.remove(k); } catch (e) {} }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"]/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function perfNow() { return (window.performance && performance.now ? performance.now() : Date.now()) / 1000; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ---------------- progress ----------------
  // { maps: {id: {best, stars}}, perks, sound, loadout: [keys], seen: 'glyphs', tutorial }
  function loadProg() {
    var p = null;
    try { p = JSON.parse(sget(PROG_KEY) || 'null'); } catch (e) { p = null; }
    if (!p || typeof p !== 'object') p = {};
    var maps = {};
    for (var i = 0; i < E.MAPS.length; i++) {
      var m = (p.maps && p.maps[E.MAPS[i].id]) || {};
      maps[E.MAPS[i].id] = { best: Math.max(0, m.best | 0), stars: clamp(m.stars | 0, 0, 3) };
    }
    var prog = { maps: maps, sound: !!p.sound, perks: E.cleanPerks(p.perks), loadout: Array.isArray(p.loadout) ? p.loadout.slice(0, 12) : null,
      seen: typeof p.seen === 'string' ? p.seen : '', region: p.region | 0, codexTab: p.codexTab || 'towers' };
    if (E.perkCost(prog.perks) > starsEarned(prog)) prog.perks = {};
    return prog;
  }
  function saveProg() { if (S) sset(PROG_KEY, JSON.stringify(S.prog)); }
  function starsEarned(prog) { var n = 0; for (var i = 0; i < E.MAPS.length; i++) n += prog.maps[E.MAPS[i].id].stars; return n; }
  function starsFree() { return starsEarned(S.prog) - E.perkCost(S.prog.perks); }
  function mapWon(i) { return S.prog.maps[E.MAPS[i].id].stars > 0; }
  function mapOpen(i) { return i === 0 || mapWon(i - 1); }
  // Towers you own: the starting eight plus one per map won.
  function ownedTowers() {
    var o = {}, i;
    for (i = 0; i < E.D.START_TOWERS.length; i++) o[E.TKEY[E.D.START_TOWERS[i]]] = 1;
    for (i = 0; i < E.MAPS.length; i++) if (mapWon(i) && E.MAPS[i].unlock) o[E.TKEY[E.MAPS[i].unlock]] = 1;
    return o;
  }
  function seen(k) { return S.prog.seen.indexOf(k) >= 0; }
  function markSeen(k) { if (!seen(k)) { S.prog.seen += k; S.seenDirty = true; } }
  function loadSave() {
    try {
      var o = JSON.parse(sget(SAVE_KEY) || 'null');
      return o && o.v === 1 && o.g && o.g.v === 2 ? o : null;
    } catch (e) { return null; }
  }
  function saveGame() {
    if (!S || !S.g) return;
    var g = S.g;
    if (g.phase === 'lost' || (g.phase === 'build' && !g.towers.length)) { sdel(SAVE_KEY); return; }
    sset(SAVE_KEY, JSON.stringify({ v: 1, g: E.serialize(g), speed: S.speed, cam: { x: S.cam.x, y: S.cam.y, z: S.cam.z } }));
    if (S.seenDirty) { S.seenDirty = false; saveProg(); }
  }

  // ---------------- sound: a tiny WebAudio voice, off by default ----------------
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
      g.gain.exponentialRampToValueAtTime(vol || 0.04, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);

  // ---------------- theme colours ----------------
  function parseCol(s, d) {
    s = (s || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    return m ? [+m[1], +m[2], +m[3]] : d;
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function css(c, a) {
    var r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
    return a == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  // Each region's look: a tint over the whole ground, its scatter marks and terrain colours.
  var BIOMES = {
    meadow: { tint: [34, 160, 80], ta: 0.025, grass: [34, 150, 74], marks: ['"', ',', '\'', '`'], ridge: [120, 113, 108], water: [56, 140, 220], high: [140, 150, 60], lava: [230, 90, 40] },
    dunes: { tint: [220, 160, 60], ta: 0.07, grass: [196, 146, 62], marks: ['.', ',', '`', '·'], ridge: [176, 120, 70], water: [40, 160, 190], high: [196, 140, 80], lava: [230, 90, 40] },
    tundra: { tint: [150, 195, 235], ta: 0.07, grass: [120, 170, 210], marks: ['*', '·', '\'', '.'], ridge: [110, 130, 160], water: [60, 170, 225], high: [140, 165, 195], lava: [230, 90, 40] },
    marsh: { tint: [90, 125, 60], ta: 0.07, grass: [96, 132, 58], marks: ['"', ',', 'ı', '\''], ridge: [112, 100, 80], water: [50, 135, 125], high: [124, 124, 70], lava: [230, 90, 40] },
    cinder: { tint: [190, 70, 50], ta: 0.055, grass: [150, 118, 108], marks: ['.', '`', ',', '·'], ridge: [112, 92, 92], water: [60, 120, 170], high: [160, 104, 80], lava: [245, 96, 30] },
    sky: { tint: [120, 170, 235], ta: 0.06, grass: [140, 175, 225], marks: ['°', '·', '\'', '.'], ridge: [140, 150, 185], water: [80, 150, 230], high: [168, 180, 225], lava: [230, 90, 40] },
    archive: { tint: [145, 110, 195], ta: 0.06, grass: [150, 128, 185], marks: ['·', '-', '.', '\''], ridge: [125, 100, 155], water: [90, 120, 200], high: [165, 140, 195], lava: [230, 90, 40], ridgeCh: '‖' }
  };
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n, d) { return parseCol(cs.getPropertyValue(n), d); }
    var bg = v('--bg', [250, 250, 249]), tx = v('--text', [28, 25, 23]);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    function pal(n, l, d) { return v(n, dark ? d : l); }
    var green = pal('--tok-str', [21, 128, 61], [134, 239, 172]), blue = pal('--tok-fn', [2, 132, 199], [125, 211, 252]);
    var amber = pal('--tok-num', [180, 83, 9], [252, 211, 77]), purple = pal('--tok-kw', [124, 58, 237], [196, 181, 253]);
    var pink = pal('--tok-tag', [190, 24, 93], [249, 168, 212]), teal = pal('--tok-bui', [13, 148, 136], [94, 234, 212]);
    var red = pal('--error', [220, 38, 38], [248, 113, 113]), orange = pal('--ws-orange-fg', [194, 65, 12], [253, 186, 116]);
    var ac = v('--accent', [15, 149, 152]), mu = v('--text-muted', [120, 113, 108]);
    S.dark = dark; S.bgc = bg; S.txc = tx;
    S.col = {
      font: (cs.getPropertyValue('--font-mono') || '').trim() || 'ui-monospace, monospace',
      bg: css(bg), text: css(tx), muted: css(mu), accent: css(ac), accentFill: css(ac, 0.1), faint: css(mix(bg, tx, 0.3)),
      lane: css(mix(bg, pink, dark ? 0.36 : 0.32)), gate: css(ac), base: css(red),
      enemy: css(tx), flyer: css(pink), boss: css(red), hit: css(mix(bg, tx, 0.35)), frost: css(blue), zap: css(purple), heal: css(green),
      shadow: css(mix(bg, tx, 0.22)), hpBack: css(mix(bg, tx, dark ? 0.22 : 0.16)), hpHi: css(green), hpMid: css(amber), hpLo: css(red),
      shield: css(dark ? [120, 220, 255] : [8, 120, 190]), gold: css(amber), bad: css(red), boom: css(orange), tracer: css(teal), ring: css(ac),
      beam: css(pink), rocket: css(pink), flame: css(red), acid: css(dark ? [190, 230, 80] : [100, 140, 10]),
      shade: css(bg, 0.88), tipBorder: css(mix(bg, tx, 0.45)), green: css(green), blue: css(blue), purple: css(purple), teal: css(teal), amber: css(amber),
      dt: [css(mix(tx, bg, 0.15)), css(orange), css(blue), css(purple), css(dark ? [190, 230, 80] : [100, 140, 10]), css(teal), css(pink)],
      tc: [], tdim: [], tile: []
    };
    for (var i = 0; i < E.TOWERS.length; i++) {
      var c = parseCol(E.TOWERS[i].col, [128, 128, 128]);
      c = dark ? mix(c, [255, 255, 255], 0.28) : mix(c, [0, 0, 0], 0.12);
      S.col.tc.push(css(c));
      S.col.tdim.push(css(mix(bg, c, 0.6)));
      S.col.tile.push([css(mix(bg, c, 0.08)), css(mix(bg, c, 0.13)), css(mix(bg, c, 0.19)), css(mix(bg, c, 0.25)), css(mix(bg, c, 0.3))]);
    }
    S.tcRaw = [];
    readBiome();
    fitFont();
    dropChunks();
  }
  // Colours for the current map's region (the ground tint makes each region its own colour).
  function readBiome() {
    var M = E.MAPS[curMap()], B = BIOMES[M.biome] || BIOMES.meadow, bg = S.bgc, tx = S.txc, dark = S.dark;
    var ground = mix(bg, B.tint, B.ta * (dark ? 1.6 : 1));
    S.bp = {
      B: B, ground: css(ground), groundRaw: ground,
      mark: css(mix(ground, B.grass, dark ? 0.42 : 0.4)), mark2: css(mix(ground, B.grass, dark ? 0.26 : 0.24)),
      shore: css(mix(ground, B.water, 0.06)), shoreMark: css(mix(ground, [200, 170, 110], dark ? 0.35 : 0.32)),
      road: css(mix(ground, tx, dark ? 0.075 : 0.06)), gravel: css(mix(ground, tx, dark ? 0.3 : 0.26)), edge: css(mix(ground, tx, dark ? 0.17 : 0.14)),
      ridgeFill: css(mix(ground, tx, 0.04)), ridge: css(mix(ground, B.ridge, dark ? 0.62 : 0.6)),
      waterFill: css(mix(ground, B.water, dark ? 0.13 : 0.11)), water: css(mix(ground, B.water, dark ? 0.62 : 0.55)),
      highFill: css(mix(ground, B.high, dark ? 0.09 : 0.08)), high: css(mix(ground, B.high, dark ? 0.5 : 0.46)),
      lavaFill: css(mix(ground, B.lava, dark ? 0.24 : 0.16)), lava: css(mix(ground, B.lava, dark ? 0.8 : 0.7)),
      voidFill: css(dark ? mix(bg, [0, 0, 0], 0.45) : mix(bg, tx, 0.1)), voidMark: css(mix(bg, tx, dark ? 0.18 : 0.22)),
      pad: css(mix(ground, [120, 150, 70], dark ? 0.2 : 0.16))
    };
  }

  // ---------------- fonts: glyphs fitted to the mono font's real advance, 3 per cell ----------------
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '600 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    function fnt(w, advUnits) { return w + ' ' + (advUnits / adv).toFixed(2) + 'px ' + f; }
    S.fG = fnt(600, CELL / 3);
    S.fTower = fnt(800, CELL / 3 * 1.08);
    S.fE = [fnt(800, CELL / 3 * 0.95), fnt(800, CELL / 3 * 1.05), fnt(800, CELL / 3 * 1.15), fnt(800, CELL / 3 * 1.42), fnt(800, CELL / 3 * 1.75)];
    S.fSm = fnt(600, 7.2); S.fSmB = fnt(700, 7.2); S.fTiny = fnt(700, 5.6); S.fBan = fnt(800, 12); S.fMid = fnt(700, 9);
    S.tipAdv = 7.2;
    S.wcache = {}; S.tipKey = '';
  }
  var SIZE_I = { S: 0, M: 1, L: 2, XL: 3, B: 4 };

  // ---------------- camera ----------------
  // cam: x, y = world cell coordinate at the top-left of the view; z = CSS px per cell.
  function curMap() { return S.g ? S.g.map : S.viewMap; }
  function fitZ() { var md = E.mapData(curMap()); return Math.min(S.vw / md.w, S.vh / md.h); }
  function minZ() { return Math.min(fitZ(), 22); }
  function maxZ() { return Math.max(fitZ() * 1.05, S.coarse ? 52 : 60); }
  function clampCam() {
    var md = E.mapData(curMap()), c = S.cam, vwC = S.vw / c.z, vhC = S.vh / c.z;
    if (vwC >= md.w) c.x = (md.w - vwC) / 2; else c.x = clamp(c.x, -0.5, md.w - vwC + 0.5);
    if (vhC >= md.h) c.y = (md.h - vhC) / 2; else c.y = clamp(c.y, -0.5, md.h - vhC + 0.5);
  }
  function setZoom(z, sx, sy) {                           // zoom about a screen point (CSS px in the stage)
    var c = S.cam, old = c.z;
    z = clamp(z, minZ(), maxZ());
    if (Math.abs(z - old) < 1e-4) return;
    if (sx == null) { sx = S.vw / 2; sy = S.vh / 2; }
    var wx = c.x + sx / old, wy = c.y + sy / old;
    c.z = z; c.x = wx - sx / z; c.y = wy - sy / z;
    clampCam();
    S.zoomT = perfNow();
    schedChunkRefresh();
  }
  function centerOn(x, y) { S.cam.x = x - S.vw / S.cam.z / 2; S.cam.y = y - S.vh / S.cam.z / 2; clampCam(); }
  function defaultCam() {
    var md = E.mapData(curMap()), M = E.MAPS[curMap()], f = fitZ();
    var z = M.ultra || f < (S.coarse ? 21 : 24) ? Math.max(f, S.coarse ? 28 : 32) : f;
    S.cam.z = clamp(z, minZ(), maxZ());
    if (S.cam.z <= f + 1e-6) { S.cam.x = 0; S.cam.y = 0; clampCam(); return; }
    // start near the first gate, looking inward
    var R = md.routes[0], p = E.routePos(R, Math.min(R.len, 6), 0, {});
    centerOn(p.x, p.y);
  }
  function fitsWhole() { var md = E.mapData(curMap()); return S.vw / S.cam.z >= md.w - 0.01 && S.vh / S.cam.z >= md.h - 0.01; }
  // device px per logical unit, and the world→device transform
  function kNow() { return S.dpr * S.cam.z / CELL; }
  function toWorld(cx, cy) { return { x: S.cam.x + cx / S.cam.z, y: S.cam.y + cy / S.cam.z }; }

  // ---------------- static layer: terrain + towers, cached in chunks ----------------
  function dropChunks() { S.chunks = {}; S.chunkN = 0; S.chunkK = 0; }
  function dirtyCell(c, r) { var k = Math.floor(c / CH) + ',' + Math.floor(r / CH); if (S.chunks[k]) S.chunks[k].dirty = true; }
  function dirtyAll() { for (var k in S.chunks) S.chunks[k].dirty = true; }
  function schedChunkRefresh() {
    clearTimeout(S.chunkT);
    S.chunkT = setTimeout(function () { if (S) { S.chunkT = 0; S.chunkK = 0; redraw(); } }, 160);
  }
  function hash(a, b, c) { var h = (a * 73856093) ^ (b * 19349663) ^ (c * 83492791); h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); return (h ^ (h >>> 15)) >>> 0; }
  function getChunk(cx, cy, k) {
    var key = cx + ',' + cy, ch = S.chunks[key];
    if (ch && !ch.dirty && ch.k === k) { ch.used = S.frameNo; return ch; }
    var px = Math.ceil(CH * CELL * k);
    if (!ch) {
      // LRU: keep the cache to ~40 MB of pixels (canvases are memory-heavy on phones)
      var cap = Math.max(9, Math.min(40, Math.floor(40e6 / (px * px * 4))));
      while (S.chunkN >= cap) {
        var old = null, ok = null;
        for (var q in S.chunks) if (!old || S.chunks[q].used < old.used) { old = S.chunks[q]; ok = q; }
        if (!old || old.used >= S.frameNo) break;
        old.cv.width = old.cv.height = 0; delete S.chunks[ok]; S.chunkN--;
      }
      ch = S.chunks[key] = { cv: document.createElement('canvas'), k: 0, dirty: true, used: 0 };
      S.chunkN++;
    }
    if (ch.cv.width !== px) { ch.cv.width = px; ch.cv.height = px; }
    renderChunk(ch, cx, cy, k);
    ch.k = k; ch.dirty = false; ch.used = S.frameNo;
    return ch;
  }
  function renderChunk(ch, cx, cy, k) {
    var c = ch.cv.getContext('2d'), mi = curMap(), md = E.mapData(mi), grid = md.grid, w = md.w, h = md.h, bp = S.bp, B = bp.B, T = E.TL;
    var g = S.g, pads = g ? g.pads : {};
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, ch.cv.width, ch.cv.height);
    c.setTransform(k, 0, 0, k, -cx * CH * CELL * k, -cy * CH * CELL * k);
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = S.fG;
    var lod = k * CELL < 12;                                     // far out: fills only
    var i0 = cx * CH, j0 = cy * CH, i1 = Math.min(w, i0 + CH), j1 = Math.min(h, j0 + CH), i, j, s;
    c.fillStyle = bp.ground; c.fillRect(i0 * CELL, j0 * CELL, (i1 - i0) * CELL + 1, (j1 - j0) * CELL + 1);
    for (j = j0; j < j1; j++) for (i = i0; i < i1; i++) {
      var t = grid[j * w + i], x0 = i * CELL, y0 = j * CELL, hh = hash(i + 1, j + 1, mi + 1);
      if (pads[j * w + i]) {
        c.fillStyle = bp.pad; c.fillRect(x0 + 1, y0 + 1, CELL - 2, CELL - 2);
        if (!lod) { c.fillStyle = bp.mark; c.fillText('▫', x0 + 5, y0 + 6); c.fillText('▫', x0 + 25, y0 + 24); }
        continue;
      }
      if (t === T.ROAD) {
        c.fillStyle = bp.road; c.fillRect(x0, y0, CELL, CELL);
        if (!lod) { c.fillStyle = bp.gravel; for (s = 0; s < 6; s++) if (((hh >>> (s * 3)) & 7) < 3) c.fillText('·', x0 + 5 + (s % 3) * 10, y0 + 7.5 + (s > 2 ? 15 : 0)); }
      } else if (t === T.RIDGE) {
        c.fillStyle = bp.ridgeFill; c.fillRect(x0, y0, CELL, CELL);
        if (!lod) {
          c.fillStyle = bp.ridge; var rc = B.ridgeCh || '^', pat = hh & 3;
          for (s = 0; s < 3; s++) {
            if ((pat + s) % 3 !== 1) c.fillText(rc, x0 + 5 + s * 10, y0 + 9);
            if ((pat + s) % 2 === 0 || s === 1) c.fillText(rc, x0 + 5 + s * 10, y0 + 22);
          }
        } else { c.fillStyle = bp.ridge; c.globalAlpha = 0.35; c.fillRect(x0, y0, CELL, CELL); c.globalAlpha = 1; }
      } else if (t === T.WATER) {
        c.fillStyle = bp.waterFill; c.fillRect(x0, y0, CELL, CELL);
        if (!lod) { c.fillStyle = bp.water; var odd = (i + j) & 1; for (s = 0; s < 3; s++) c.fillText('~', x0 + 5 + s * 10, (s + odd) % 2 === 0 ? y0 + 8 : y0 + 22); }
      } else if (t === T.LAVA) {
        c.fillStyle = bp.lavaFill; c.fillRect(x0, y0, CELL, CELL);
        if (!lod) { c.fillStyle = bp.lava; var od2 = (i + j) & 1; for (s = 0; s < 3; s++) c.fillText(s === 1 ? '≈' : '~', x0 + 5 + s * 10, (s + od2) % 2 === 0 ? y0 + 9 : y0 + 21); }
      } else if (t === T.VOID) {
        c.fillStyle = bp.voidFill; c.fillRect(x0, y0, CELL, CELL);
        if (!lod && (hh & 7) === 0) { c.fillStyle = bp.voidMark; c.fillText('·', x0 + 6 + (hh >>> 4 & 15), y0 + 6 + (hh >>> 9 & 15)); }
      } else if (t === T.HIGH) {
        c.fillStyle = bp.highFill; c.fillRect(x0, y0, CELL, CELL);
        if (!lod) { c.fillStyle = bp.high; for (s = 0; s < 4; s++) if (((hh >>> (s * 2)) & 3) !== 0) c.fillText(':', x0 + 7.5 + (s % 2) * 15, y0 + 7.5 + (s > 1 ? 15 : 0)); }
      } else if (!lod) {
        var shore = t === T.SHORE;
        for (s = 0; s < 6; s++) {
          var b = (hh >>> (s * 4)) & 15;
          if (b < (shore ? 4 : 3)) {
            c.fillStyle = shore ? bp.shoreMark : (b ? bp.mark2 : bp.mark);
            c.fillText(shore ? (b & 1 ? ',' : '.') : B.marks[(hh >>> (s + 7)) & 3], x0 + 5 + (s % 3) * 10, y0 + 7.5 + (s > 2 ? 15 : 0));
          }
        }
      }
    }
    // road edges
    c.fillStyle = bp.edge;
    for (j = j0; j < j1; j++) for (i = i0; i < i1; i++) {
      if (grid[j * w + i] !== T.ROAD) continue;
      var x = i * CELL, y = j * CELL;
      if (j > 0 && grid[(j - 1) * w + i] !== T.ROAD) c.fillRect(x, y, CELL, 1);
      if (j < h - 1 && grid[(j + 1) * w + i] !== T.ROAD) c.fillRect(x, y + CELL - 1, CELL, 1);
      if (i > 0 && grid[j * w + i - 1] !== T.ROAD) c.fillRect(x, y, 1, CELL);
      if (i < w - 1 && grid[j * w + i + 1] !== T.ROAD) c.fillRect(x + CELL - 1, y, 1, CELL);
    }
    // flyer lanes (faint dotted), gates and exits
    if (!lod) {
      c.fillStyle = S.col.lane; c.font = S.fTiny;
      for (i = 0; i < md.air.length; i++) {
        var F = md.air[i];
        for (var sg = 0; sg < F.n - 1; sg++) {
          var ax = F.x[sg], ay = F.y[sg], bx = F.x[sg + 1], by = F.y[sg + 1], L = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)), n = Math.floor(L * 3);
          for (s = 1; s < n; s++) {
            var fx = ax + (bx - ax) * s / n, fy = ay + (by - ay) * s / n, ci = Math.floor(fx), cj = Math.floor(fy);
            if (ci < i0 || cj < j0 || ci >= i1 || cj >= j1 || grid[cj * w + ci] === T.ROAD) continue;
            c.fillText('·', fx * CELL, fy * CELL);
          }
        }
      }
    }
    c.font = S.fTower;
    var G = E.MAPS[mi].geo;
    for (i = 0; i < G.paths.length; i++) {
      var pts = G.paths[i], first = md.gates[i], last = md.exits[i], fc = first % w, fr = Math.floor(first / w), lc = last % w, lr = Math.floor(last / w);
      if (fc >= i0 && fc < i1 && fr >= j0 && fr < j1) {
        var dx = pts[1][0] - pts[0][0], dy = pts[1][1] - pts[0][1];
        c.fillStyle = S.col.gate;
        c.fillText(dx > 0 ? '→' : dx < 0 ? '←' : dy > 0 ? '↓' : '↑', fc * CELL + CELL / 2, fr * CELL + CELL / 2);
      }
      if (lc >= i0 && lc < i1 && lr >= j0 && lr < j1) { c.fillStyle = S.col.base; c.fillText('⌂', lc * CELL + CELL / 2, lr * CELL + CELL / 2); }
    }
    if (g) for (i = 0; i < g.towers.length; i++) {
      var tw = g.towers[i];
      if (tw.c >= i0 && tw.c < i1 && tw.r >= j0 && tw.r < j1) drawTower(c, tw, 1);
    }
  }
  function drawTower(c, t, solid) {
    var k = S.col, Tw = E.TOWERS[t.type], x0 = t.c * CELL, y0 = t.r * CELL, cx = x0 + CELL / 2, cy = y0 + CELL / 2 - 2.5, br = BRACKETS[t.lvl];
    if (solid) {
      c.fillStyle = k.tile[t.type][Math.min(t.lvl, 4)]; c.fillRect(x0 + 1, y0 + 1, CELL - 2, CELL - 2);
      if (t.lvl >= 4) { c.strokeStyle = k.tc[t.type]; c.lineWidth = 1; c.strokeRect(x0 + 1.5, y0 + 1.5, CELL - 3, CELL - 3); }
    }
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = S.fG; c.fillStyle = t.lvl >= 2 ? k.tc[t.type] : k.tdim[t.type];
    c.fillText(br[0], cx - 9.5, cy); c.fillText(br[1], cx + 9.5, cy);
    c.font = S.fTower; c.fillStyle = k.tc[t.type];
    c.fillText(Tw.g, cx, cy);
    c.font = S.fTiny;
    c.fillText(t.lvl >= 4 ? 'ABC'.charAt(t.br) : PIPS[t.lvl], cx, y0 + CELL - 5.5);
  }

  // ---------------- per-frame drawing ----------------
  function setFont(c, f) { if (S.curFont !== f) { c.font = f; S.curFont = f; } }
  function ring(c, cx, cy, rad, color, fill) {
    if (fill) { c.fillStyle = fill; c.beginPath(); c.arc(cx, cy, rad, 0, 6.2832); c.fill(); }
    var n = Math.max(20, Math.floor(rad * 6.2832 / 7)), i;
    c.fillStyle = color;
    for (i = 0; i < n; i++) { var a = i / n * 6.2832; c.fillText('·', cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); }
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  var ARC_CH = ['-', '\\', '|', '/'];
  function lineChar(dx, dy) { var a = Math.atan2(dy, dx); if (a < 0) a += Math.PI; return ARC_CH[Math.round(a / (Math.PI / 4)) % 4]; }
  // visible world rect (cells), with a margin
  function viewRect(m) { var c = S.cam; return { x0: c.x - m, y0: c.y - m, x1: c.x + S.vw / c.z + m, y1: c.y + S.vh / c.z + m }; }

  function draw(alpha) {
    if (!S || !S.ctx || !S.col) return;
    var c = S.ctx, g = S.g, a = alpha == null ? 1 : alpha, k = kNow();
    S.frameNo = (S.frameNo || 0) + 1;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = S.col.bg; c.fillRect(0, 0, S.cv.width, S.cv.height);
    drawBase(c, k);
    c.setTransform(k, 0, 0, k, -S.cam.x * CELL * k, -S.cam.y * CELL * k);
    c.textAlign = 'center'; c.textBaseline = 'middle'; S.curFont = null;
    if (!g) { drawNotes(c, null); return; }
    var vr = viewRect(1.5);
    drawZones(c, g, vr);
    drawSel(c, g);
    drawMines(c, g, vr);
    drawEnemies(c, g, a, vr);
    drawShots(c, g, a, vr);
    drawTowerFx(c, g, a, vr);
    if (g.fx.length) drawFx(c, g, vr);
    drawTip(c);
    c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    S.curFont = null;
    drawEdge(c, g);
    drawNotes(c, g);
    if (S.miniOn) { var showM = !fitsWhole(); if (S.miniShown !== showM) { S.miniShown = showM; S.mini.style.display = showM ? '' : 'none'; } if (showM) drawMini(); }
  }
  function drawBase(c, k) {
    // While zooming, reuse chunks rendered at the old scale (stretched), re-render once it settles.
    var useK = S.chunkK && S.zoomT && perfNow() - S.zoomT < 0.16 ? S.chunkK : k;
    if (!S.chunkK || (!S.chunkT && S.chunkK !== k)) { S.chunkK = k; useK = k; }
    var md = E.mapData(curMap()), cw = CH * CELL * k, nx = Math.ceil(md.w / CH), ny = Math.ceil(md.h / CH);
    var ox = -S.cam.x * CELL * k, oy = -S.cam.y * CELL * k, W = S.cv.width, H = S.cv.height;
    var cx0 = Math.max(0, Math.floor(-ox / cw)), cy0 = Math.max(0, Math.floor(-oy / cw));
    var cx1 = Math.min(nx - 1, Math.floor((W - ox) / cw)), cy1 = Math.min(ny - 1, Math.floor((H - oy) / cw));
    for (var cy = cy0; cy <= cy1; cy++) for (var cx = cx0; cx <= cx1; cx++) {
      var ch = getChunk(cx, cy, useK);
      var x0 = Math.round(ox + cx * cw), y0 = Math.round(oy + cy * cw), x1 = Math.round(ox + (cx + 1) * cw), y1 = Math.round(oy + (cy + 1) * cw);
      var src = CH * CELL * useK;
      c.drawImage(ch.cv, 0, 0, src, src, x0, y0, x1 - x0, y1 - y0);
    }
  }
  // selection, range rings, support links, build preview, towers that just fired
  function drawSel(c, g) {
    var i, t = S.selT, sel = S.sel, armed = S.armed, k = S.col;
    if (t) {
      var st = E.stats(g, t), sh = st.shape, rr = sh === 'mint' || sh === 'bank' ? 0 : E.isAttack(t.type) ? E.effRange(t) : st.range;
      if (rr > 0) ring(c, t.x * CELL, t.y * CELL, rr * CELL, k.ring, k.accentFill);
      if (sh === 'orbit') ring(c, t.x * CELL, t.y * CELL, (rr - (st.orbitW || 0.5)) * CELL, k.faint, null);
      if (st.minR) ring(c, t.x * CELL, t.y * CELL, st.minR * CELL, k.bad, null);
      if (t.links && t.links.length) {                 // a support: the towers it lifts
        c.strokeStyle = k.tc[t.type]; c.lineWidth = 1;
        for (i = 0; i < g.towers.length; i++) { var o = g.towers[i]; if (t.links.indexOf(o.id) >= 0) c.strokeRect(o.c * CELL + 3.5, o.r * CELL + 3.5, CELL - 7, CELL - 7); }
      }
      if (sh === 'terra') {
        c.strokeStyle = k.tc[t.type]; c.lineWidth = 1;
        var md = E.mapData(g.map);
        for (var key in g.pads) if (g.pads[key] === t.id) { var cc = +key % md.w, rw = Math.floor(+key / md.w); c.strokeRect(cc * CELL + 2.5, rw * CELL + 2.5, CELL - 5, CELL - 5); }
      }
      c.strokeStyle = k.accent; c.lineWidth = 1.5; c.strokeRect(t.c * CELL + 0.75, t.r * CELL + 0.75, CELL - 1.5, CELL - 1.5);
    }
    var pc = sel || (armed >= 0 ? S.hover : null);
    if (pc && !E.towerAt(g, pc.c, pc.r)) {
      var ok = armed >= 0 ? E.canPlace(g, pc.c, pc.r, armed) : !!E.landOf(g, pc.c, pc.r);
      if (armed >= 0 && ok) {
        var s0 = E.towerStat(armed, 0), sh0 = s0.shape, r0 = sh0 === 'mint' || sh0 === 'bank' ? 0 : s0.range * g.mod.range;
        if (r0 > 0) ring(c, (pc.c + 0.5) * CELL, (pc.r + 0.5) * CELL, r0 * CELL, k.ring, k.accentFill);
        c.globalAlpha = 0.75;
        S.ghost.type = armed; S.ghost.c = pc.c; S.ghost.r = pc.r;
        drawTower(c, S.ghost, false);
        c.globalAlpha = 1; S.curFont = null;
      }
      if (sel === pc) { c.strokeStyle = ok ? k.accent : k.bad; c.lineWidth = 1.5; c.strokeRect(pc.c * CELL + 0.75, pc.r * CELL + 0.75, CELL - 1.5, CELL - 1.5); }
    }
    for (i = 0; i < g.towers.length; i++) {
      var tw = g.towers[i];
      if (tw.fireT > 0.06 && E.TOWERS[tw.type].shape !== 'beam') { setFont(c, S.fTower); c.fillStyle = k.text; c.fillText(E.TOWERS[tw.type].g, tw.x * CELL, tw.y * CELL - 2.5); }
      if (tw.jamT > 0 || tw.yowlT > 0) { setFont(c, S.fTiny); c.fillStyle = k.bad; c.fillText(tw.jamT > 0 ? '⇲' : '~', tw.x * CELL + 11, tw.y * CELL - 10); }
      if (tw.nullT > 0) { setFont(c, S.fTiny); c.fillStyle = k.bad; c.fillText('ø', tw.x * CELL + 11, tw.y * CELL - 10); }
    }
  }
  function drawZones(c, g, vr) {
    var zs = g.zones, k = S.col, i, j;
    for (i = 0; i < zs.length; i++) {
      var z = zs[i], q = z.t / z.life;
      if (z.kind === 'barr') {
        var md = E.mapData(g.map), R = md.routes[z.ri];
        setFont(c, S.fSmB); c.fillStyle = k.tc[E.TKEY.barricade]; c.globalAlpha = 0.85 - q * 0.5;
        for (var d = Math.max(0, z.d0); d <= Math.min(R.len, z.d1); d += 0.34) { var p = E.routePos(R, d, 0, S.pt); c.fillText('=', p.x * CELL, p.y * CELL); }
        c.globalAlpha = 1;
        continue;
      }
      if (z.x < vr.x0 - z.r || z.x > vr.x1 + z.r || z.y < vr.y0 - z.r || z.y > vr.y1 + z.r) continue;
      setFont(c, S.fTiny);
      if (z.kind === 'grav') { c.globalAlpha = 0.9 - q * 0.4; ring(c, z.x * CELL, z.y * CELL, z.r * CELL * (0.92 + 0.08 * Math.sin(g.t * 6)), k.tc[E.TKEY.gravity], css(S.bgc, 0)); c.globalAlpha = 1; }
      else if (z.kind === 'crater') { c.globalAlpha = 0.8 - q * 0.5; ring(c, z.x * CELL, z.y * CELL, z.r * CELL, k.boom, null); c.globalAlpha = 1; }
      else if (z.kind === 'slick') { c.globalAlpha = 0.6 - q * 0.4; ring(c, z.x * CELL, z.y * CELL, z.r * CELL, k.muted, null); c.globalAlpha = 1; }
      else if (z.kind === 'wake') {
        c.globalAlpha = 0.7 - q * 0.5; c.fillStyle = k.flame; setFont(c, S.fSm);
        var half = z.ang * Math.PI / 360, a0 = Math.atan2(z.uy, z.ux);
        for (j = 0; j < 7; j++) { var aa = a0 - half + 2 * half * j / 6, rr = z.len * (0.35 + 0.6 * ((j * 37 + Math.floor(g.t * 8)) % 5) / 5); c.fillText(j & 1 ? ',' : '\'', (z.x + Math.cos(aa) * rr) * CELL, (z.y + Math.sin(aa) * rr) * CELL); }
        c.globalAlpha = 1;
      }
    }
  }
  function drawMines(c, g, vr) {
    if (!g.mines.length) return;
    setFont(c, S.fSmB);
    for (var i = 0; i < g.mines.length; i++) {
      var m = g.mines[i];
      if (m.x < vr.x0 || m.x > vr.x1 || m.y < vr.y0 || m.y > vr.y1) continue;
      c.fillStyle = m.supT > 0 ? S.col.faint : m.armT > 0 ? S.col.muted : S.col.tc[E.TKEY.mine];
      c.fillText(m.supT > 0 ? '+' : '×', m.x * CELL, m.y * CELL);
    }
  }
  // enemies: ground first, flyers above
  function drawEnemies(c, g, a, vr) {
    var en = g.enemies, k = S.col, pass, i, j;
    for (pass = 0; pass < 2; pass++) {
      for (i = 0; i < en.length; i++) {
        var e = en[i];
        if (!e.alive) continue;
        var air = E.layerOf(e) === 2 || (e.fly && e.landT <= 0);
        if ((air ? 1 : 0) !== pass) continue;
        var x = lerp(e.px, e.x, a), y = lerp(e.py, e.y, a);
        if (x < vr.x0 || x > vr.x1 || y < vr.y0 || y > vr.y1) continue;
        var D = E.ENEMIES[e.k], ex = x * CELL, ey = y * CELL, si = SIZE_I[D.size] || 0, hidden = E.isHidden(e) && !(e.revealT > 0);
        if (air) {
          setFont(c, S.fTiny); c.fillStyle = k.shadow; c.fillText('·', ex, ey + 6);
          ey -= (e.high ? 10 : 6) + Math.sin(g.t * 6 + e.id) * 1.5;
        }
        var alpha = 1;
        if (hidden) alpha = e.k === '?' ? 0.22 : 0.3;
        if (e.buried) alpha = e.revealT > 0 ? 0.6 : 0.3;
        if (e.revT > 0) alpha = 0.35 + 0.3 * Math.sin(g.t * 20);
        if (e.prot > 0) alpha = 0.5;
        c.globalAlpha = alpha;
        setFont(c, S.fE[si]);
        c.fillStyle = e.flash > 0 ? k.hit : e.stunT > 0 ? k.zap : e.burnT > 0 ? k.boom : e.corT > 0 ? k.acid : e.slowT > 0 ? k.frost :
          D.boss ? k.boss : D.air ? k.flyer : (e.k === 'h' || e.k === 'H') ? k.heal : k.enemy;
        var ch = e.k;
        if (e.k === '?' && !hidden) ch = '?';
        if (e.dodT > 0) { c.fillText(ch, ex - 2.5, ey); c.globalAlpha = alpha * 0.4; c.fillText(ch, ex + 2.5, ey); c.globalAlpha = alpha; }
        else c.fillText(ch, ex, ey);
        if (e.buried) { setFont(c, S.fSmB); c.fillText('_', ex, ey + 6); }
        if (e.sh > 0) {                                 // shield: brackets, brighter when full
          setFont(c, S.fE[Math.min(4, si + 1)]); c.fillStyle = k.shield; c.globalAlpha = alpha * (0.45 + 0.55 * Math.min(1, e.sh / (e.shMax || 1)));
          var sw = 6 + si * 2.2; c.fillText('(', ex - sw, ey); c.fillText(')', ex + sw, ey);
          c.globalAlpha = alpha;
        }
        c.globalAlpha = 1;
        if (hidden && e.k !== '?') continue;
        // status marks above
        var top = ey - (si >= 4 ? 17 : si === 3 ? 14 : 11), mk = '';
        if (e.warnT > 0) mk = e.k === '7' ? '»' : '!';
        else if (e.k === '9' && e.count > 0) mk = String(e.count);
        else if (e.k === '!' && e.abT < 3 && e.silT <= 0) mk = '!';
        else if (e.silT > 0) mk = 'ø';
        else if (e.markT > 0) mk = '⊓';
        else if (e.k === '※' && e.prevT > 0) mk = ['A', 'C', 'V'][e.mode];
        if (mk) { setFont(c, S.fSmB); c.fillStyle = e.warnT > 0 || mk === '!' ? k.bad : k.muted; c.fillText(mk, ex + 7 + si, top - 3); }
        if (e.hp < e.maxHp || e.sh > 0) {               // segmented HP bar: ▬▬▬▭▭
          var segs = si >= 4 ? 10 : si === 3 ? 7 : 5, sw2 = 3.1, w = segs * sw2, bx = ex - w / 2, by = top, f = e.hp / e.maxHp, on = Math.ceil(f * segs);
          c.fillStyle = f > 0.6 ? k.hpHi : f > 0.3 ? k.hpMid : k.hpLo;
          for (j = 0; j < on; j++) c.fillRect(bx + j * sw2, by, sw2 - 0.9, 2.4);
          c.fillStyle = k.hpBack;
          for (; j < segs; j++) c.fillRect(bx + j * sw2, by, sw2 - 0.9, 2.4);
          if (e.sh > 0) { c.fillStyle = k.shield; c.fillRect(bx, by - 2.2, w * Math.min(1, e.sh / (e.shMax || 1)), 1.4); }
          if (D.split) { c.fillStyle = k.muted; for (j = 0; j < D.split; j++) c.fillRect(bx + j * 2.2, by + 3.4, 1.2, 1.2); }
        }
        if (S.selE === e.id) { c.strokeStyle = k.accent; c.lineWidth = 1; c.strokeRect(ex - 9, ey - 10, 18, 20); }
      }
    }
  }
  function drawShots(c, g, a, vr) {
    var pr = g.proj, k = S.col, i;
    for (i = 0; i < pr.length; i++) {
      var p = pr[i], x = lerp(p.px, p.x, a), y = lerp(p.py, p.y, a);
      if (x < vr.x0 || x > vr.x1 || y < vr.y0 || y > vr.y1) continue;
      var qx = x * CELL, qy = y * CELL, ty = p.t ? p.t.type : 0;
      if (p.kind === 1) { setFont(c, S.fSmB); c.fillStyle = k.tc[ty]; c.fillText('∘', qx, qy); }
      else if (p.kind === 2) { setFont(c, S.fTiny); c.fillStyle = k.shield; c.fillText('∞', qx, qy); }
      else if (p.kind === 3) { setFont(c, S.fTiny); c.fillStyle = k.tc[ty]; c.fillText('•', qx, qy); }
      else {
        var key = E.TOWERS[ty].key;
        if (key === 'frost') { setFont(c, S.fSmB); c.fillStyle = k.frost; c.fillText('*', qx, qy); }
        else if (key === 'diamond') { setFont(c, S.fTiny); c.fillStyle = k.tc[ty]; c.fillText('♦', qx, qy); }
        else if (key === 'acid') { setFont(c, S.fSmB); c.fillStyle = k.acid; c.fillText('·', qx, qy); }
        else if (key === 'gatling') { setFont(c, S.fTiny); c.fillStyle = k.tc[ty]; c.fillText('·', qx, qy); }
        else { setFont(c, S.fG); c.fillStyle = k.tc[ty]; c.fillText(lineChar(p.x - p.px, p.y - p.py), qx, qy); }
      }
    }
  }
  // beams, orbit blades, swarms
  function drawTowerFx(c, g, a, vr) {
    var tw = g.towers, k = S.col, i, j, byId = null;
    for (i = 0; i < tw.length; i++) {
      var t = tw[i], st = t.st;
      if (!st || t.x < vr.x0 - 5 || t.x > vr.x1 + 5 || t.y < vr.y0 - 5 || t.y > vr.y1 + 5) continue;
      if (st.shape === 'beam' && t.beamId) {
        if (!byId) { byId = {}; for (j = 0; j < g.enemies.length; j++) byId[g.enemies[j].id] = g.enemies[j]; }
        var e = byId[t.beamId];
        if (!e || !e.alive) continue;
        var q = st.focusT ? Math.min(1, t.beamT / st.focusT) : 1, x0 = t.x * CELL, y0 = t.y * CELL - 2.5;
        var dx = lerp(e.px, e.x, a) * CELL - x0, dy = lerp(e.py, e.y, a) * CELL - y0, L = Math.sqrt(dx * dx + dy * dy), n = Math.max(2, Math.floor(L / 5.5));
        if (st.pen) { var ext = (st.range * CELL) / (L || 1); dx *= ext; dy *= ext; n = Math.floor(n * ext); }
        setFont(c, q > 0.6 ? S.fSmB : S.fSm); c.fillStyle = k.tc[t.type]; c.globalAlpha = 0.35 + 0.65 * q;
        for (j = 1; j < n; j++) { var wob = Math.sin(j * 0.9 + g.t * 14) * 1.6; c.fillText('~', x0 + dx * j / n - dy / (L || 1) * wob, y0 + dy * j / n + dx / (L || 1) * wob); }
        c.globalAlpha = 1;
      } else if (st.shape === 'orbit' && t.fireT > 0) {
        setFont(c, S.fSmB); c.fillStyle = k.tc[t.type];
        var R = (E.effRange(t) - (st.orbitW || 0.5) / 2) * CELL;
        for (var b = 0; b < (st.blades || 1); b++) {
          var an = t.ang + b * Math.PI;
          for (j = 0; j < 3; j++) { var aj = an - j * 0.16; c.globalAlpha = 1 - j * 0.3; c.fillText(j ? '·' : '∩', t.x * CELL + Math.cos(aj) * R, t.y * CELL + Math.sin(aj) * R); }
        }
        c.globalAlpha = 1;
      } else if (st.shape === 'swarm' && t.swId && t.swArr <= 0) {
        if (!byId) { byId = {}; for (j = 0; j < g.enemies.length; j++) byId[g.enemies[j].id] = g.enemies[j]; }
        var se = byId[t.swId];
        if (!se || !se.alive) continue;
        setFont(c, S.fTiny); c.fillStyle = k.tc[t.type];
        var nd = st.drones || 5;
        for (j = 0; j < nd; j++) { var aa = g.t * 7 + j * 6.283 / nd; c.fillText('\'', (se.x + Math.cos(aa) * 0.35) * CELL, (se.y + Math.sin(aa) * 0.3) * CELL); }
      }
    }
  }
  function drawFx(c, g, vr) {
    var fx = g.fx, k = S.col, i, j;
    for (i = 0; i < fx.length; i++) {
      var F = fx[i], q = F.t / F.life, fxx = F.x * CELL, fyy = F.y * CELL, n2, r2;
      if (F.x < vr.x0 - 4 || F.x > vr.x1 + 4 || F.y < vr.y0 - 4 || F.y > vr.y1 + 4) continue;
      c.globalAlpha = Math.max(0, 1 - q);
      switch (F.kind) {
        case 1:                                          // blast ring
          setFont(c, S.fG); c.fillStyle = F.txt === 'f' ? k.flyer : F.txt === 'x' ? k.muted : k.boom; r2 = F.a * CELL * (0.3 + 0.7 * q);
          for (j = 0; j < 8; j++) c.fillText(j & 1 ? '·' : '*', fxx + Math.cos(j * 0.785) * r2, fyy + Math.sin(j * 0.785) * r2);
          if (q < 0.4) c.fillText('#', fxx, fyy);
          break;
        case 2:                                          // lightning
          setFont(c, S.fSmB); c.fillStyle = k.zap;
          var lx = F.x2 * CELL - fxx, ly = F.y2 * CELL - fyy, L = Math.sqrt(lx * lx + ly * ly), ch2 = lineChar(lx, ly);
          n2 = Math.max(2, Math.floor(L / 5));
          for (j = 1; j < n2; j++) { var jit = ((j * 7 + Math.floor(F.t * 40)) % 5 - 2) * 0.9; c.fillText(j % 3 === 1 ? '~' : ch2, fxx + lx * j / n2 - ly / (L || 1) * jit, fyy + ly * j / n2 + lx / (L || 1) * jit); }
          break;
        case 3:                                          // tracer (sniper) / prism ray
          setFont(c, S.fTiny); c.fillStyle = F.a ? k.dt[F.c] : k.tracer;
          var tx2 = F.x2 * CELL - fxx, ty2 = F.y2 * CELL - fyy, L2 = Math.sqrt(tx2 * tx2 + ty2 * ty2);
          n2 = Math.max(2, Math.floor(L2 / (F.a ? 4 : 7)));
          for (j = 1; j <= n2; j++) c.fillText(F.a ? '-' : '·', fxx + tx2 * j / n2, fyy + ty2 * j / n2);
          if (!F.a) { setFont(c, S.fG); c.fillText('×', F.x2 * CELL, F.y2 * CELL); }
          break;
        case 4:                                          // pulse ring with a glyph
          setFont(c, S.fSm); c.fillStyle = F.txt === '≈' ? k.tc[E.TKEY.sonic] : F.txt === '!' ? k.bad : k.accent; r2 = F.a * CELL * (0.25 + 0.75 * q);
          n2 = Math.max(8, Math.floor(r2 * 6.28 / 12));
          var gl = F.txt && F.txt.length === 1 ? F.txt : '*';
          for (j = 0; j < n2; j++) c.fillText(j % 2 ? '·' : gl, fxx + Math.cos(j / n2 * 6.283) * r2, fyy + Math.sin(j / n2 * 6.283) * r2);
          break;
        case 5:                                          // +gold / -lives popups
          setFont(c, S.fSmB); c.fillStyle = F.a ? k.bad : k.gold;
          c.fillText(F.txt, fxx, fyy - 6 - q * 12);
          break;
        case 6:                                          // death puff
          setFont(c, S.fSm); c.fillStyle = k.muted; r2 = 3 + q * 9 * (F.a || 0.5) * 2;
          c.fillText(':', fxx - r2, fyy); c.fillText(':', fxx + r2, fyy); c.fillText('·', fxx, fyy - r2); c.fillText('·', fxx, fyy + r2);
          break;
        case 7: case 11:                                 // flame cone / crosswind gust
          setFont(c, S.fSmB);
          var a0 = Math.atan2(F.y2, F.x2), half = (+F.txt || 60) * Math.PI / 360, R7 = F.a * CELL * (0.35 + 0.65 * q);
          n2 = 7;
          for (j = 0; j < n2; j++) {
            var aa = a0 - half + 2 * half * j / (n2 - 1);
            c.fillStyle = F.kind === 11 ? k.blue : (j & 1 ? k.boom : k.flame);
            c.fillText(F.kind === 11 ? '~' : (j % 3 ? '^' : ','), fxx + Math.cos(aa) * R7, fyy + Math.sin(aa) * R7);
          }
          break;
        case 8:                                          // heal / cleanse ring
          setFont(c, S.fSmB); c.fillStyle = F.txt === '*' ? k.muted : F.txt === '@' ? k.bad : k.heal; r2 = F.a * CELL * (0.2 + 0.8 * q);
          for (j = 0; j < 8; j++) c.fillText(F.txt === '@' ? '·' : '+', fxx + Math.cos(j * 0.785) * r2, fyy + Math.sin(j * 0.785) * r2);
          break;
        case 9:                                          // a lobbed shell in flight
          c.globalAlpha = 1;
          var px = lerp(F.x, F.x2, q), py = lerp(F.y, F.y2, q) - Math.sin(q * Math.PI) * 1.2;
          setFont(c, S.fSmB); c.fillStyle = k.boom; c.fillText(F.txt || '•', px * CELL, py * CELL);
          setFont(c, S.fTiny); c.fillStyle = k.shadow; c.fillText('·', px * CELL, lerp(F.y, F.y2, q) * CELL + 4);
          break;
        case 10:                                         // rail line
          setFont(c, S.fSmB); c.fillStyle = k.tc[E.TKEY.rail];
          var rx = F.x2 * CELL - fxx, ry = F.y2 * CELL - fyy, RL = Math.sqrt(rx * rx + ry * ry);
          n2 = Math.max(2, Math.floor(RL / 6));
          for (j = 0; j <= n2; j++) c.fillText('=', fxx + rx * j / n2, fyy + ry * j / n2);
          break;
        case 12:                                         // miss
          setFont(c, S.fTiny); c.fillStyle = k.muted; c.fillText(F.txt, fxx, fyy - 8 - q * 8);
          break;
        case 13:                                         // enemy ability warning ring
          setFont(c, S.fTiny); c.globalAlpha = 0.7 * (1 - q); ring(c, fxx, fyy, F.a * CELL, k.bad, null);
          break;
        case 14:                                         // suppression link / marker
          setFont(c, S.fSmB); c.fillStyle = k.bad;
          if (F.txt) c.fillText(F.txt, fxx, fyy - 10);
          else { var sx = F.x2 * CELL - fxx, sy = F.y2 * CELL - fyy, SL = Math.sqrt(sx * sx + sy * sy); n2 = Math.max(2, Math.floor(SL / 6)); setFont(c, S.fTiny); for (j = 1; j < n2; j += 2) c.fillText('·', fxx + sx * j / n2, fyy + sy * j / n2); }
          break;
        case 15:                                         // boomerang out and back
          c.globalAlpha = 1;
          var u = q < 0.5 ? q * 2 : 2 - q * 2;
          setFont(c, S.fSmB); c.fillStyle = k.tc[E.TKEY.boomer];
          c.fillText(Math.floor(F.t * 12) & 1 ? '‹' : '›', lerp(F.x, F.x2, u) * CELL, lerp(F.y, F.y2, u) * CELL);
          break;
      }
    }
    c.globalAlpha = 1;
  }
  // Off-screen threats: arrows at the view's edge pointing to enemies outside it.
  function drawEdge(c, g) {
    if (fitsWhole() || !g.enemies.length) return;
    var vr = viewRect(0), cx = (vr.x0 + vr.x1) / 2, cy = (vr.y0 + vr.y1) / 2, bins = {}, i;
    for (i = 0; i < g.enemies.length; i++) {
      var e = g.enemies[i];
      if (!e.alive || (e.x >= vr.x0 && e.x <= vr.x1 && e.y >= vr.y0 && e.y <= vr.y1)) continue;
      var ang = Math.atan2(e.y - cy, e.x - cx), b = Math.round(ang / (Math.PI / 8));
      var B2 = bins[b] || (bins[b] = { n: 0, boss: 0, rem: 1e9, ang: ang });
      B2.n++; if (E.ENEMIES[e.k].boss) B2.boss = 1; if (e.rem < B2.rem) B2.rem = e.rem;
    }
    setFont(c, S.fSmB);
    for (var key in bins) {
      var B = bins[key], ux = Math.cos(B.ang), uy = Math.sin(B.ang), m = 12;
      var tX = ux > 0 ? (S.vw / 2 - m) / ux : ux < 0 ? (-S.vw / 2 + m) / ux : 1e9, tY = uy > 0 ? (S.vh / 2 - m) / uy : uy < 0 ? (-S.vh / 2 + m) / uy : 1e9, tt = Math.min(tX, tY);
      var px = S.vw / 2 + ux * tt, py = S.vh / 2 + uy * tt;
      c.fillStyle = S.col.shade; c.fillRect(px - 11, py - 7, 22, 14);
      c.fillStyle = B.boss || B.rem < 6 ? S.col.bad : S.col.muted;
      c.fillText((['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'])[((Math.round(B.ang / (Math.PI / 4)) % 8) + 8) % 8] + B.n, px, py);
    }
  }
  // wave banner, messages and hints (screen space, CSS px)
  function drawNotes(c, g) {
    var now = perfNow(), cx = S.vw / 2;
    if (S.banner && now < S.banner.until) {
      c.globalAlpha = Math.min(1, (S.banner.until - now) / 0.4);
      label(c, S.banner.txt, cx, S.vh * 0.34, S.fBan, S.banner.boss ? S.col.bad : S.col.text, true, 1.25);
      if (S.banner.sub) label(c, S.banner.sub, cx, S.vh * 0.34 + 26, S.fSmB, S.col.gold, false, 1.25);
      c.globalAlpha = 1;
    }
    if (!g) return;
    var y = S.vh - 14;
    if (S.msg && now < S.msg.until) label(c, S.msg.txt, cx, y, S.fSmB, S.msg.bad ? S.col.bad : S.col.text, false, 1.25);
    else if (!S.selT && !S.sel && S.armed < 0 && g.phase === 'build' && !g.towers.length) label(c, S.coarse ? 'tap a tile, then a tower below' : 'click a tile, then a tower below', cx, y, S.fSmB, S.col.muted, false, 1.25);
    else if (S.armed >= 0 && !S.sel) label(c, (S.coarse ? 'tap a tile for the ' : 'click a tile for the ') + E.TOWERS[S.armed].name, cx, y, S.fSmB, S.col.muted, false, 1.25);
  }
  function textW(c, s, font) { var m = S.wcache[font] || (S.wcache[font] = {}); return m[s] != null ? m[s] : (m[s] = c.measureText(s).width); }
  function label(c, s, x, y, font, color, frame, scale) {
    c.save(); c.translate(x, y); if (scale) c.scale(scale, scale);
    c.font = font; c.textAlign = 'center'; c.textBaseline = 'middle';
    var w = textW(c, s, font), h = frame ? 26 : 14;
    c.fillStyle = S.col.shade; c.fillRect(-w / 2 - 8, -h / 2, w + 16, h);
    if (frame) { c.strokeStyle = color; c.lineWidth = 1; c.strokeRect(-w / 2 - 7.5, -h / 2 + 0.5, w + 15, h - 1); }
    c.fillStyle = color; c.fillText(s, 0, 0.5);
    c.restore(); S.curFont = null;
  }

  // ---------------- minimap (ULTRA maps, or whenever the map doesn't fit) ----------------
  function drawMini() {
    var m = S.mini, mc = S.mctx, md = E.mapData(curMap()), g = S.g, now = perfNow();
    if (!m || !mc) return;
    if (S.miniBase !== curMap() + ':' + S.frameTheme) buildMiniBase();
    if (S.miniLast && now - S.miniLast < 0.12 && !S.miniForce) return;
    S.miniLast = now; S.miniForce = false;
    var s = S.miniS, W = m.width, H = m.height;
    mc.setTransform(1, 0, 0, 1, 0, 0);
    mc.drawImage(S.miniBg, 0, 0);
    if (g) {
      for (var i = 0; i < g.towers.length; i++) { var t = g.towers[i]; mc.fillStyle = S.col.tc[t.type]; mc.fillRect(t.c * s, t.r * s, Math.max(1, s), Math.max(1, s)); }
      for (i = 0; i < g.enemies.length; i++) { var e = g.enemies[i]; if (!e.alive) continue; mc.fillStyle = E.ENEMIES[e.k].boss ? S.col.bad : E.ENEMIES[e.k].air ? S.col.flyer : S.col.text; mc.fillRect(e.x * s - 1, e.y * s - 1, 2.2, 2.2); }
    }
    var c = S.cam;
    mc.strokeStyle = S.col.accent; mc.lineWidth = 1.5;
    mc.strokeRect(Math.max(0, c.x * s) + 0.5, Math.max(0, c.y * s) + 0.5, Math.min(W - 1, S.vw / c.z * s), Math.min(H - 1, S.vh / c.z * s));
  }
  function buildMiniBase() {
    var md = E.mapData(curMap()), s = S.miniS, cv = S.miniBg || (S.miniBg = document.createElement('canvas'));
    cv.width = S.mini.width; cv.height = S.mini.height;
    var c = cv.getContext('2d'), T = E.TL, bp = S.bp;
    c.fillStyle = bp.ground; c.fillRect(0, 0, cv.width, cv.height);
    for (var j = 0; j < md.h; j++) for (var i = 0; i < md.w; i++) {
      var t = md.grid[j * md.w + i];
      c.fillStyle = t === T.ROAD ? bp.gravel : t === T.RIDGE ? bp.ridge : t === T.WATER ? bp.water : t === T.LAVA ? bp.lava : t === T.VOID ? bp.voidFill : t === T.HIGH ? bp.high : bp.ground;
      if (t !== T.GRASS && t !== T.SHORE) c.fillRect(i * s, j * s, Math.ceil(s), Math.ceil(s));
    }
    S.miniBase = curMap() + ':' + S.frameTheme;
  }

  // ---------------- ASCII tooltip: the selected tower / enemy / what you're about to build ----------------
  function fmt(n) { return n % 1 ? (+n).toFixed(n < 1 ? 2 : 1).replace(/\.?0+$/, '') : String(n); }
  function num(n) { return n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n >= 100 ? String(Math.round(n)) : fmt(Math.round(n * 10) / 10); }
  function pct(x) { return Math.round(x * 100) + '%'; }
  var DTN = ['phys', 'fire', 'frost', 'shock', 'acid', 'sonic', 'arcane'];
  // One line of headline numbers for a tower's stats.
  function statLine(type, st, t) {
    var sh = st.shape, Tw = E.TOWERS[type];
    if (sh === 'mint') return '+$' + st.income + ' after each wave' + (st.relief ? ' +12/life lost' : '') + (st.bonds ? ' · +$' + st.bonds + ' boss waves' : '');
    if (sh === 'bank') return 'holds up to $' + st.bankCap + ' · ' + pct(st.bankRate) + ' (max $' + st.bankMax + ')' + (st.dividend ? ' +$' + st.dividend : '');
    if (sh === 'bounty') return st.marks + ' marks · $' + st.markPay + '/kill (max ' + st.markMax + ' a wave)';
    if (sh === 'salvage') return '$' + st.salvage + '/kill in r ' + fmt(st.range) + ' (max ' + st.salvageMax + ')';
    if (sh === 'reveal') return 'reveals in r ' + fmt(+st.range.toFixed(1)) + ' · lingers ' + fmt(st.linger) + 's';
    if (sh === 'haste') return (st.cap) + ' tower' + (st.cap > 1 ? 's' : '') + ' in r ' + fmt(st.range) + ': +' + pct(st.haste) + ' rate' + (st.dmgB ? ' +' + pct(st.dmgB) + ' dmg' : '');
    if (sh === 'amp') return st.cap + ' towers in r ' + fmt(st.range) + ': +' + pct(st.dmgB) + ' dmg' + (st.armIgnore ? ', −' + st.armIgnore + ' armor' : '');
    if (sh === 'survey') return st.cap + ' towers in r ' + fmt(st.range) + ': +' + pct(st.rangeB) + ' range' + (st.pspdB ? ', 2× shot speed' : '');
    if (sh === 'relay') return st.cap + ' towers in r ' + fmt(st.range) + ': jams/yowls −' + pct(st.supRed);
    if (sh === 'echo') return st.cap + ' tower' + (st.cap > 1 ? 's' : '') + ': echo ' + pct(st.echo) + ' every ' + fmt(st.echoCd) + 's';
    if (sh === 'terra') return st.pads + ' pads within r ' + fmt(st.range);
    var r = ' · r ' + fmt(+(t ? E.effRange(t) : st.range).toFixed(1));
    var rate = ' · ' + fmt(+(t ? E.effInt(t) : st.int).toFixed(2)) + 's';
    if (sh === 'etch') return '−' + st.armBreak + ' armor ' + fmt(st.armBreakDur) + 's · ' + st.maxT + ' foes' + rate + r;
    if (sh === 'mute') return 'silence ' + fmt(st.silence) + 's · ' + st.maxT + ' foe' + (st.maxT > 1 ? 's' : '') + rate + r;
    if (sh === 'grav') return 'field r ' + fmt(st.field) + ' · slow ' + pct(st.slow) + ' ' + fmt(st.fieldDur) + 's' + rate + r;
    if (sh === 'gate') return 'sends ' + (st.maxT > 1 ? st.maxT + ' foes ' : '') + fmt(st.tele) + ' tiles back' + rate + r;
    if (sh === 'barr') return (st.strips || 1) + '× ' + fmt(st.strip) + '-tile strip · slow ' + pct(st.slow) + rate + r;
    if (sh === 'tide') return 'wet: +' + pct(st.wet) + ' shock taken ' + fmt(st.wetDur) + 's' + rate + r;
    if (sh === 'wind') return 'gust: slow ' + pct(st.slow) + ' ' + fmt(st.slowDur) + 's' + rate + r;
    if (sh === 'drain') return 'drains ' + st.drain + ' shield' + (st.multi > 1 ? ' ×' + st.multi : '') + rate + r;
    if (sh === 'chrono') return (st.delay ? 'delay abilities ' + fmt(st.delay) + 's' : 'stop ' + fmt(st.stun) + 's') + ' · ' + st.maxT + ' foes' + rate + r;
    var d = num(st.dmg) + (st.sec ? '/' + num(st.sec) : '');
    return DTN[E.D.DTI[Tw.type] != null ? E.D.DTI[Tw.type] : 0] + ' ' + d + (sh === 'swarm' ? '×' + (st.drones || 5) : '') + rate + r;
  }
  // What else it does, or ''.
  function effectLine(st) {
    var b = [], sh = st.shape;
    if (st.multi > 1 && sh !== 'drain') b.push(st.multi + ' targets');
    if (st.splash) b.push('blast ' + fmt(st.splash) + (st.maxT ? ' (' + st.maxT + ')' : ''));
    else if (st.maxT && (sh === 'ring' || sh === 'cone')) b.push('hits ' + st.maxT);
    if (st.cone && sh === 'cone') b.push(st.cone + '° cone');
    if (st.chain) b.push((st.chains > 1 ? '2 chains ' : '') + st.chain + ' jumps');
    if (st.pen && sh !== 'beam') b.push('pierces ' + st.pen);
    if (st.pen && sh === 'beam') b.push('beam through ' + st.pen);
    if (st.lines === 2) b.push('crossed lines');
    if (st.fan > 1) b.push(st.fan + ' boomerangs');
    if (st.retMul > 1) b.push('return ×' + st.retMul);
    if (st.pierce) b.push('ignores ' + pct(st.pierce) + ' armor');
    if (st.slow && sh !== 'grav' && sh !== 'barr' && sh !== 'wind') b.push('slow ' + pct(st.slow));
    if (st.freezeN) b.push('freeze every ' + st.freezeN + 'rd hit');
    if (st.brittle) b.push('+' + pct(st.brittle) + ' phys taken');
    if (st.burn) b.push('burn ' + num(st.burn) + '/s');
    if (st.corrode) b.push('corrode ' + num(st.corrode) + '/s');
    if (st.armRed) b.push('armor −' + st.armRed);
    if (st.resCut) b.push('fire/shock resist −' + pct(st.resCut));
    if (st.stun && sh === 'chain') b.push('stun ' + fmt(st.stun) + 's');
    if (st.silence && sh === 'ring') b.push('silence ' + fmt(st.silence) + 's');
    if (st.focusB) b.push('focus +' + pct(st.focusB) + ' after ' + fmt(st.focusT) + 's');
    if (st.every5) b.push('every 5th +' + st.every5);
    if (st.execute) b.push('+' + pct(st.execute) + ' under 30% HP');
    if (st.ghostB) b.push('+' + pct(st.ghostB) + ' vs ghosts');
    if (st.resPen) b.push('ignores ' + pct(st.resPen) + ' resist');
    if (st.det) b.push('true sight');
    if (st.revealHit) b.push('hits reveal ' + st.revealHit + 's');
    if (st.shieldMul > 1) b.push('shields ×' + st.shieldMul);
    if (st.minR) b.push('min range ' + st.minR);
    if (st.crater) b.push('crater slow ' + pct(st.crater));
    if (st.after) b.push('2nd blast ' + num(st.after));
    if (st.cluster) b.push('6 sub-blasts ' + num(st.cluster));
    if (st.wake) b.push('burning ground');
    if (st.mines) b.push(st.mines + ' mines');
    if (st.groundMul) b.push('ground ' + pct(st.groundMul));
    if (st.auto) b.push('auto element');
    if (st.xfer) b.push('jumps on a kill');
    if (st.blades > 1) b.push('2 blades');
    if (st.pull) b.push('pulls ' + st.pull + ' back');
    if (st.land) b.push('grounds flyers ' + st.land + 's');
    if (st.lockSh) b.push('locks shields');
    if (st.noRegen) b.push('stops regen');
    if (st.exSlow) b.push('slows ghosts');
    if (st.cleanse) b.push('clears jams');
    if (st.anyPad) b.push('pads take any tower');
    if (st.padRange) b.push('pad towers +' + pct(st.padRange) + ' range');
    if (st.ric) b.push('echo ricochets');
    if (st.markElite) b.push('elites only');
    if (st.markVuln) b.push('marked take +' + pct(st.markVuln));
    if (st.leakPay) b.push('+$' + st.leakPay + ' per leak');
    if (st.wetSlow) b.push('wet slow ' + pct(st.wetSlow));
    return b.join(' · ');
  }
  function enemyLines(e) {
    var D = E.ENEMIES[e.k], L = [], tr = [];
    L.push(e.k + '  ' + D.name + (D.boss ? '  (boss)' : D.cap ? '  (capital)' : ''));
    L.push('hp ' + num(e.hp) + '/' + num(e.maxHp) + (e.sh > 0 ? ' +' + num(e.sh) + ' shield' : '') + ' · armor ' + D.ar + ' · ' + fmt(D.spd) + ' t/s · ♥' + D.lives);
    var w = D.weak >= 0 ? 'weak: ' + DTN[D.weak] : '';
    var rs = [];
    for (var i = 0; i < 7; i++) if (D.res[i]) rs.push(DTN[i] + ' ' + pct(D.res[i]));
    if (w || rs.length) L.push((w ? w : '') + (w && rs.length ? ' · ' : '') + (rs.length ? 'resists ' + rs.join(', ') : ''));
    if (e.burnT > 0) tr.push('burning'); if (e.corT > 0) tr.push('corroding'); if (e.slowT > 0) tr.push('slowed ' + pct(e.slowF));
    if (e.stunT > 0) tr.push('stunned'); if (e.silT > 0) tr.push('silenced'); if (e.revealT > 0 && E.isHidden(e)) tr.push('revealed');
    if (e.markT > 0) tr.push('marked'); if (e.wetT > 0) tr.push('wet'); if (e.etchT > 0 || e.armRT > 0) tr.push('armor broken');
    if (tr.length) L.push(tr.join(' · '));
    var note = D.note, out = [], line = '';
    note.split(' ').forEach(function (wd) { if ((line + ' ' + wd).trim().length > 42) { out.push(line.trim()); line = wd; } else line += ' ' + wd; });
    if (line.trim()) out.push(line.trim());
    return L.concat(out);
  }
  function tipLines() {
    var g = S.g, t = S.selT, L = [], Tw, x;
    if (S.selE) {
      var e = E.enemyById(g, S.selE);
      if (!e) { S.selE = 0; return null; }
      return enemyLines(e);
    }
    if (t) {
      Tw = E.TOWERS[t.type];
      var st = E.stats(g, t), br = t.lvl >= 4 ? Tw.brs[t.br] : null;
      L.push((br ? br.name + ' (' + Tw.name + ')' : Tw.name) + '  ' + (t.lvl >= 4 ? 'final' : 'lv ' + (t.lvl + 1) + '/4'));
      L.push(statLine(t.type, st, t));
      x = effectLine(st); if (x) L.push(x);
      var buffs = [];
      if (t.bDmg) buffs.push('+' + pct(Math.min(0.5, t.bDmg)) + ' dmg'); if (t.bHaste) buffs.push('+' + pct(Math.min(0.5, t.bHaste)) + ' rate');
      if (t.bRange) buffs.push('+' + pct(t.bRange) + ' range'); if (t.high && E.DIRECT[st.shape]) buffs.push('highland +15%'); if (t.echoF) buffs.push('echo');
      if (t.jamT > 0) buffs.push('JAMMED'); if (t.yowlT > 0) buffs.push('YOWLED'); if (t.nullT > 0) buffs.push('NULLED');
      if (buffs.length) L.push('buffs: ' + buffs.join(' · '));
      if (E.isAttack(t.type)) L.push((E.aims(t) ? 'aim ' + E.MODES[t.mode] : 'all around') + ' · ' + t.kills + ' kill' + (t.kills === 1 ? '' : 's') + ' · ' + num(t.dmg) + ' dmg');
      else if (st.shape === 'bank') L.push(t.principal ? '$' + t.principal + ' locked this wave' : (t.bankOn ? 'deposits as each wave starts' : 'deposits paused'));
      else if (E.aims(t)) L.push('aim ' + E.MODES[t.mode]);
      if (Tw.shape === 'prism') L.push('element: ' + DTN[E.PRISM_T[t.ptype]] + (st.auto ? ' (auto)' : ''));
      if (t.lvl < 3) L.push('next: ' + statLine(t.type, E.towerStat(t.type, t.lvl + 1)));
      else if (t.lvl === 3) for (var b = 0; b < 3; b++) L.push('ABC'.charAt(b) + ' ' + Tw.brs[b][0] + ': ' + Tw.brs[b][2]);
      else L.push(br[2]);
      return L;
    }
    if (S.armed >= 0 && S.sel) {
      Tw = E.TOWERS[S.armed];
      var why = E.placeWhy(g, S.sel.c, S.sel.r, S.armed), cb = E.canBuildType(g, S.armed);
      L.push(Tw.name + '  $' + Tw.cost);
      L.push(Tw.role);
      L.push(statLine(S.armed, E.towerStat(S.armed, 0)));
      x = effectLine(E.towerStat(S.armed, 0)); if (x) L.push(x);
      L.push(why || cb ? (why || cb) : g.gold >= Tw.cost ? (S.coarse ? 'tap again to build' : 'click / enter to build') : 'need $' + (Tw.cost - g.gold) + ' more');
      return L;
    }
    if (S.sel) {
      var land = E.landOf(g, S.sel.c, S.sel.r);
      L.push({ G: 'grass', H: 'highland (+15% direct range)', S: 'shore', W: 'water', P: 'build pad' }[land] || 'can\'t build here');
      L.push('pick a tower below');
      return L;
    }
    return null;
  }
  // Word-wrap tooltip lines to at most n characters (continuations indented).
  function wrapLines(L, n) {
    if (!L) return L;
    var out = [];
    for (var i = 0; i < L.length; i++) {
      var s = L[i];
      while (s.length > n) {
        var cut = s.lastIndexOf(' ', n);
        if (cut < n * 0.5) cut = n;
        out.push(s.slice(0, cut));
        s = '  ' + s.slice(cut).replace(/^ +/, '');
      }
      out.push(s);
    }
    return out;
  }
  function drawTip(c) {
    var t = S.selT, sel = S.sel, key, g = S.g;
    if (S.selE) { var e = E.enemyById(g, S.selE); if (!e) { S.selE = 0; return; } key = 'e' + e.id + ':' + Math.round(e.hp / e.maxHp * 40) + ':' + Math.round(e.sh) + ':' + (e.slowT > 0) + (e.burnT > 0) + (e.stunT > 0) + (e.silT > 0) + (e.markT > 0); }
    else if (t) key = t.id + ':' + t.lvl + ':' + t.mode + ':' + t.ptype + ':' + S.stamp + ':' + t.kills + ':' + Math.round(t.dmg / 50) + ':' + (t.jamT > 0) + (t.yowlT > 0) + (t.nullT > 0) + t.principal + t.bankOn;
    else if (sel) key = 's' + sel.c + ':' + sel.r + ':' + S.armed + ':' + (S.armed >= 0 && g.gold >= E.TOWERS[S.armed].cost);
    else return;
    var sc = S.coarse ? 1.05 : 1.2, maxC = Math.max(20, Math.floor((S.vw - 8) / (S.tipAdv * sc)) - 4);
    if (key !== S.tipKey || S.tipMax !== maxC) {
      S.tipKey = key; S.tipMax = maxC; S.tip = wrapLines(tipLines(), maxC); S.tipW = 0;
      if (S.tip) { for (var m = 0; m < S.tip.length; m++) S.tipW = Math.max(S.tipW, S.tip[m].length); S.tipBar = '+' + new Array(S.tipW + 3).join('-') + '+'; }
    }
    var L = S.tip;
    if (!L || !L.length) return;
    var ax, ay;
    if (S.selE) { var e2 = E.enemyById(g, S.selE); ax = e2.x; ay = e2.y - 0.5; }
    else { var cc = t || sel; ax = cc.c + 0.5; ay = cc.r; }
    // the tip is drawn in screen space at a fixed size, so it stays readable at any zoom
    c.save();
    c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    var w = S.tipW, adv = S.tipAdv * sc, lh = 12 * sc, bw = (w + 4) * adv, bh = (L.length + 2) * lh;
    var px = (ax - S.cam.x) * S.cam.z, py = (ay - S.cam.y) * S.cam.z;
    var bx = clamp(px - bw / 2, 2, S.vw - bw - 2), by = py - bh - 6;
    if (by < 2) by = py + S.cam.z + 6;
    if (by + bh > S.vh - 2) by = Math.max(2, S.vh - bh - 2);
    c.fillStyle = S.col.shade; c.fillRect(bx, by, bw, bh);
    c.textAlign = 'left'; c.textBaseline = 'middle';
    c.scale(sc, sc);
    var X = bx / sc, Y = by / sc, LH = 12, A = S.tipAdv;
    c.font = S.fSm; c.fillStyle = S.col.tipBorder;
    c.fillText(S.tipBar, X, Y + LH / 2);
    c.fillText(S.tipBar, X, Y + bh / sc - LH / 2);
    for (var i = 0; i < L.length; i++) {
      var yy = Y + LH * (i + 1.5);
      c.font = S.fSm; c.fillStyle = S.col.tipBorder; c.fillText('|', X, yy); c.fillText('|', X + (w + 3) * A, yy);
      c.font = i === 0 ? S.fSmB : S.fSm;
      c.fillStyle = i === 0 ? (S.selT ? S.col.tc[S.selT.type] : S.selE ? S.col.text : S.armed >= 0 ? S.col.tc[S.armed] : S.col.text) : i === L.length - 1 && L.length > 2 ? S.col.muted : S.col.text;
      c.fillText(L[i], X + 2 * A, yy);
    }
    c.restore();
    S.curFont = null;
  }

  // ---------------- loop: only while a wave is live, unpaused and visible ----------------
  function running() {
    return !!(S && S.g && S.g.phase === 'wave' && !S.paused && !S.ovlKind && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)));
  }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function redraw() {
    if (!S) return;
    if (S.raf) return;                                    // the loop draws anyway
    if (S.drawQ) return;
    S.drawQ = requestAnimationFrame(function () { if (S) { S.drawQ = 0; draw(1); } });
  }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    var alpha = E.advance(S.g, dt, S.speed);
    handleEvents();
    syncHud();
    draw(alpha);
    if (!S) return;
    if (S.g.phase === 'won' || S.g.phase === 'lost') { endGame(); return; }
    if (running()) S.raf = requestAnimationFrame(frame);
  }
  function handleEvents() {
    var g = S.g, ev = g.events, snd = S.snd, k = S.played, i;
    for (i = 0; i < 16; i++) k[i] = 0;
    for (i = 0; i < ev.length; i++) {
      var x = ev[i];
      if (x.charAt(0) === 's' && x.slice(0, 5) === 'seen:') { markSeen(x.slice(5)); if (!S.firstSeen[x.slice(5)]) { S.firstSeen[x.slice(5)] = 1; } continue; }
      switch (x) {
        case 'build': case 'upgrade': case 'spec': case 'sell': case 'pads':
          dirtyAll(); S.stamp++; S.miniForce = true;
          if (!k[0]++) {
            if (x === 'build') { snd.tone(520, 0.08, 'triangle', 0.05, 780); Cade.haptic(10); }
            else if (x === 'upgrade') { snd.tone(660, 0.07, 'triangle', 0.05); snd.tone(990, 0.1, 'triangle', 0.04, 0, 0.06); Cade.haptic(12); }
            else if (x === 'spec') { snd.tone(523, 0.1, 'triangle', 0.05); snd.tone(784, 0.1, 'triangle', 0.05, 0, 0.08); snd.tone(1046, 0.18, 'triangle', 0.05, 0, 0.16); Cade.haptic(20); }
            else if (x === 'sell') snd.tone(700, 0.12, 'sine', 0.04, 350);
          }
          break;
        case 'shot': case 'gat': case 'drone': if (!k[1]++) snd.tone(1400, 0.025, 'square', 0.007); break;
        case 'boom': case 'mine': if (!k[2]++) snd.tone(130, 0.14, 'square', 0.028, 55); break;
        case 'zap': if (!k[3]++) snd.tone(900, 0.06, 'sawtooth', 0.014, 1700); break;
        case 'snipe': case 'rail': if (!k[4]++) snd.tone(1800, 0.05, 'square', 0.014, 600); break;
        case 'pulse': case 'flame': case 'slash': if (!k[5]++) snd.tone(x === 'flame' ? 180 : 420, 0.1, 'sawtooth', 0.01, x === 'flame' ? 90 : 300); break;
        case 'beam': case 'prism': if (!k[4]++) snd.tone(1200, 0.08, 'sine', 0.01, 1500); break;
        case 'heal': case 'cleanse': if (!k[10]++) snd.tone(660, 0.12, 'sine', 0.012, 990); break;
        case 'split': case 'summon': case 'unmask': if (!k[11]++) snd.tone(240, 0.08, 'square', 0.012, 160); break;
        case 'kill': if (!k[6]++) snd.tone(880, 0.05, 'sine', 0.022, 1200); break;
        case 'bosskill': snd.tone(220, 0.3, 'square', 0.04, 880); Cade.haptic(30); break;
        case 'leak': if (!k[7]++) { snd.tone(160, 0.2, 'sawtooth', 0.035, 90); Cade.haptic(25); } break;
        case 'clear': if (!k[8]++) { snd.tone(1046, 0.1, 'triangle', 0.03); if (g.lastClear) S.clearMsg = { txt: 'wave ' + g.lastClear.w + ' clear · +$' + (g.lastClear.pay + g.lastClear.inc), until: perfNow() + 1.6 }; } break;
        case 'steal': flash('a 5 stole credits — kill it to get them back', true); break;
        case 'jam': case 'yowl': case 'null': if (!k[12]++) snd.tone(300, 0.1, 'triangle', 0.012, 200); break;
        case 'wave': case 'boss': onWaveStart(x === 'boss'); break;
        case 'win': snd.tone(523, 0.12, 'triangle', 0.05); snd.tone(659, 0.12, 'triangle', 0.05, 0, 0.12); snd.tone(784, 0.25, 'triangle', 0.05, 0, 0.24); break;
        case 'lose': snd.tone(330, 0.3, 'sawtooth', 0.04, 110); Cade.haptic(60); break;
      }
    }
    ev.length = 0;
    if (S.clearMsg && !S.msg) { S.msg = S.clearMsg; S.clearMsg = null; }
  }
  function onWaveStart(boss) {
    var g = S.g, m = S.prog.maps[E.MAPS[g.map].id], spec = E.waveSpec(g.map, g.wave);
    var sub = g.bonusLast > 0 ? '+$' + g.bonusLast + ' early bonus' : spec.fresh ? 'new: ' + spec.fresh + ' ' + E.ENEMIES[spec.fresh].name : '';
    S.banner = { txt: 'WAVE ' + g.wave + (boss ? '  ·  BOSS ' + spec.boss : ''), sub: sub, until: perfNow() + 1.8, boss: boss };
    g.bonusLast = 0;
    S.snd.tone(boss ? 147 : 392, boss ? 0.5 : 0.12, boss ? 'sawtooth' : 'triangle', 0.04, boss ? 110 : 0);
    if (!boss) S.snd.tone(523, 0.14, 'triangle', 0.04, 0, 0.1);
    if (g.wave > m.best && !g.endless) { m.best = g.wave; saveProg(); }
    S.live.textContent = 'Wave ' + g.wave + (boss ? ', boss wave' : '') + ' started.';
    saveGame();
  }

  // ---------------- HUD rows (HTML): touched only when a value changes ----------------
  function setDis(el, d) { d = !!d; if (el.disabled !== d) el.disabled = d; }
  function previewText(g) {
    var n = g.wave + 1, M = E.MAPS[g.map];
    if (!g.endless && n > M.waves) return '';
    var s = E.waveSpec(g.map, n), parts = [];
    for (var i = 0; i < s.groups.length && parts.length < 5; i++) parts.push(s.groups[i].k + s.groups[i].n);
    return '▸ ' + parts.join(' ') + (s.groups.length > 5 ? ' …' : '');
  }
  function syncHud() {
    if (!S || !S.g) return;
    var g = S.g, h = S.hud, M = E.MAPS[g.map];
    if (h.lv !== g.lives) { h.lv = g.lives; h.lives.textContent = '♥ ' + g.lives; h.livesBox.classList.toggle('low', g.lives <= Math.max(3, g.maxLives * 0.2)); }
    var gk = g.gold * 10000 + (g.bankHeld | 0);
    if (h.gd !== gk) { h.gd = gk; h.gold.textContent = '$ ' + g.gold + (g.bankHeld ? ' (+' + g.bankHeld + '≡)' : ''); }
    var wk = g.wave * 2 + (g.endless ? 1 : 0) + (g.phase === 'build' ? 0.5 : 0);
    if (h.wv !== wk) {
      h.wv = wk;
      h.wave.textContent = (g.endless ? 'wave ' + g.wave + ' · free play' : 'wave ' + g.wave + '/' + M.waves) + ' ' + previewText(g);
    }
    var can = E.canCallWave(g) && !S.paused && !S.ovlKind, st, a = 0, b = 0;
    if (g.phase === 'build') st = 1;
    else if (g.phase !== 'wave') st = g.phase === 'won' ? 2 : 3;
    else if (!E.moreWaves(g)) { st = 4; a = g.enemies.length + g.spawners.length * 1000; }
    else if (g.spawners.length >= E.MAX_SPAWNERS) { st = 5; a = g.wave; }
    else { st = 6; a = g.wave * 10000 + E.earlyBonus(g); b = Math.ceil(E.timeToNext(g)); }
    var boss = (st === 1 || st === 5 || st === 6) && E.isBossWave(g.map, g.wave + 1);
    var nk = ((st * 1e7 + a) * 1000 + b) * 4 + (can ? 2 : 0) + (boss ? 1 : 0);
    if (h.nk !== nk) {
      h.nk = nk;
      var l1 = '', l2 = '';
      if (st === 1) { l1 = '▶ Wave ' + (g.wave + 1); l2 = g.wave ? 'start' : 'start'; }
      else if (st === 2 || st === 3) l1 = st === 2 ? 'Victory' : 'Defeat';
      else if (st === 4) { l1 = 'Final wave'; l2 = g.spawners.length ? 'incoming' : g.enemies.length + ' left'; }
      else if (st === 5) { l1 = '▶▶ Wave ' + (g.wave + 1); l2 = 'wait…'; }
      else { l1 = '▶▶ Wave ' + (g.wave + 1); l2 = '+$' + (a % 10000) + ' · ' + b + 's'; }
      h.next1.textContent = l1; h.next2.textContent = l2;
      setDis(h.next, !can);
      h.next.classList.toggle('boss', boss);
    }
    if (h.sp !== S.speed) { h.sp = S.speed; h.speed.textContent = S.speed + '×'; }
    var pk = S.paused || S.ovlKind === 'menu' ? 1 : 0;
    if (h.pauseK !== pk) { h.pauseK = pk; h.pause.innerHTML = pk ? IC_PLAY : IC_PAUSE; h.pause.title = pk ? 'Resume (P)' : 'Pause / menu (P)'; h.pause.setAttribute('aria-label', h.pause.title); }
    syncCtx();
  }
  // Row B: the loadout palette, or the selected tower's actions.
  function syncCtx() {
    var g = S.g, t = S.selT, mode = t ? 'tower' : 'build', h = S.hud, i;
    if (S.ctxMode !== mode || (mode === 'build' && h.loKey !== g.loadout.join(','))) {
      S.ctxMode = mode;
      h.loKey = g.loadout.join(',');
      h.ctx.innerHTML = mode === 'build' ? paletteHtml() : towerMenuHtml();
      h.ctx.className = 'td2-ctx td2-ctx-' + mode;
      if (mode === 'build') h.ctx.style.setProperty('--n', Math.max(6, g.loadout.length));
      h.ctxKey = '';
    }
    if (mode === 'build') {
      var key = g.gold * 100 + (S.armed + 1) * 10 + (S.sel ? 1 : 0) + ':' + g.towers.length;
      if (h.ctxKey === key) return;
      h.ctxKey = key;
      var bs = h.ctx.querySelectorAll('[data-t]');
      for (i = 0; i < bs.length; i++) {
        var ti = +bs[i].getAttribute('data-t'), on = S.armed === ti, why = E.canBuildType(g, ti);
        bs[i].classList.toggle('armed', on);
        bs[i].classList.toggle('poor', g.gold < E.TOWERS[ti].cost);
        bs[i].classList.toggle('capped', !!why);
        bs[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      return;
    }
    var Tw = E.TOWERS[t.type], fork = t.lvl === 3, top = t.lvl >= 4, sv = E.sellValue(g, t), arm = S.sellArm && perfNow() < S.sellArm;
    var c0 = top ? 0 : E.upgradeCost(g, t, 0), c1 = fork ? E.upgradeCost(g, t, 1) : 0, c2 = fork ? E.upgradeCost(g, t, 2) : 0;
    var key2 = [t.id, t.lvl, t.mode, t.ptype, t.bankOn, g.gold >= c0, g.gold >= c1, g.gold >= c2, !!arm, t.principal].join(':');
    if (h.ctxKey === key2) return;
    h.ctxKey = key2;
    var q = function (a) { return h.ctx.querySelector('[data-act="' + a + '"]'); };
    var ub = q('up'), bA = q('b0'), bB = q('b1'), bC = q('b2'), mb = q('mode'), sb = q('sell');
    h.ctx.classList.toggle('fork', fork);
    if (fork) {
      [bA, bB, bC].forEach(function (bt, j) {
        var cst = [c0, c1, c2][j];
        bt.querySelector('b').textContent = 'ABC'.charAt(j) + ' ' + Tw.brs[j][0];
        bt.querySelector('span').textContent = '$' + cst;
        bt.title = Tw.brs[j][0] + ' — ' + Tw.brs[j][2] + ' (' + 'UIO'.charAt(j) + ')';
        bt.classList.toggle('poor', g.gold < cst);
      });
    } else {
      ub.querySelector('b').textContent = top ? '★ ' + Tw.brs[t.br][0] : '▲ Upgrade';
      ub.querySelector('span').textContent = top ? 'final form' : '$' + c0 + ' · lv ' + (t.lvl + 2);
      ub.title = top ? Tw.brs[t.br][2] : 'Upgrade (U)';
      setDis(ub, top);
      ub.classList.toggle('poor', !top && g.gold < c0);
    }
    var sh = E.stats(g, t).shape, aim = E.aims(t);
    if (Tw.shape === 'prism' && !E.stats(g, t).auto) { mb.querySelector('b').textContent = '◇ ' + DTN[E.PRISM_T[t.ptype]]; mb.querySelector('span').textContent = 'aim ' + E.MODES[t.mode]; setDis(mb, false); }
    else if (sh === 'bank') { mb.querySelector('b').textContent = t.bankOn ? '≡ Saving' : '≡ Paused'; mb.querySelector('span').textContent = t.principal ? '$' + t.principal + ' held' : 'tap to toggle'; setDis(mb, false); }
    else { mb.querySelector('b').textContent = aim ? '⌖ Aim' : E.isAttack(t.type) ? '* Area' : '· ' + E.D.CAT[Tw.cat]; mb.querySelector('span').textContent = aim ? E.MODES[t.mode] : E.isAttack(t.type) ? 'all around' : 'passive'; setDis(mb, !aim); }
    sb.querySelector('b').textContent = arm ? 'Sure?' : '$ Sell';
    sb.querySelector('span').textContent = '+$' + sv;
    sb.classList.toggle('arm', !!arm);
  }
  var DIGITS = '1234567890';
  function paletteHtml() {
    var s = '', lo = S.g.loadout;
    for (var i = 0; i < lo.length; i++) {
      var T = E.TOWERS[lo[i]];
      s += '<button type="button" class="td2-tw" data-t="' + lo[i] + '" title="' + esc(T.name + ' — ' + T.role + ' ($' + T.cost + ')' + (i < 10 ? ' · key ' + DIGITS.charAt(i) : '')) + '" aria-label="' + esc(T.name + ', $' + T.cost) + '" aria-pressed="false">' +
        '<b style="color:' + S.col.tc[lo[i]] + '">' + esc(T.g) + '</b><span>$' + T.cost + '</span></button>';
    }
    return s;
  }
  function towerMenuHtml() {
    return '<button type="button" class="td2-act td2-up" data-act="up" title="Upgrade (U)"><b></b><span></span></button>' +
      '<button type="button" class="td2-act td2-br" data-act="b0"><b></b><span></span></button>' +
      '<button type="button" class="td2-act td2-br" data-act="b1"><b></b><span></span></button>' +
      '<button type="button" class="td2-act td2-br" data-act="b2"><b></b><span></span></button>' +
      '<button type="button" class="td2-act td2-mode" data-act="mode" title="Aim (T)"><b></b><span></span></button>' +
      '<button type="button" class="td2-act td2-sell" data-act="sell" title="Sell (S)"><b></b><span></span></button>' +
      '<button type="button" class="td2-act td2-x" data-act="desel" title="Close (Esc)" aria-label="Deselect"><b>✕</b></button>';
  }

  // ---------------- overlays ----------------
  function starStr(n) { var s = ''; for (var i = 0; i < 3; i++) s += i < n ? '★' : '☆'; return s; }
  // A small ASCII thumbnail (downsampled for big maps).
  function miniMap(mi) {
    var md = E.mapData(mi), T = E.TL, step = Math.max(1, Math.ceil(Math.max(md.w / 18, md.h / 22))), out = '', i, j;
    for (j = 0; j < md.h; j += step) {
      for (i = 0; i < md.w; i += step) {
        var road = 0, kind = -1;
        for (var y = j; y < Math.min(md.h, j + step); y++) for (var x = i; x < Math.min(md.w, i + step); x++) { var t = md.grid[y * md.w + x]; if (t === T.ROAD) road = 1; else if (t !== T.GRASS && t !== T.SHORE && kind < 0) kind = t; }
        out += road ? '<b>#</b>' : kind === T.RIDGE ? '<i>^</i>' : kind === T.WATER ? '<u>~</u>' : kind === T.LAVA ? '<s>%</s>' : kind === T.VOID ? ' ' : kind === T.HIGH ? '<em>:</em>' : '.';
      }
      out += '\n';
    }
    return out.replace(/\n$/, '');
  }
  function traitChips(M) {
    var s = '';
    if (M.ultra) s += '<span class="td2-chip ultra" title="Too big for one screen: drag to pan, pinch or scroll to zoom">ULTRA</span>';
    for (var i = 0; i < M.traits.length; i++) { var T = E.D.TRAITS[M.traits[i]]; if (T) s += '<span class="td2-chip" title="' + esc(T.desc) + '">' + esc(T.name) + '</span>'; }
    if (M.only && M.only.note) s += '<span class="td2-chip lim" title="Tower catalog limit">' + esc(M.only.note) + '</span>';
    if (M.slots) s += '<span class="td2-chip lim">' + M.slots + ' slots</span>';
    return s;
  }
  function overlayHtml(kind) {
    var g = S.g, i, s = '';
    if (kind === 'loading') return '<div class="td2-card"><div class="td2-title">GLYPH DEFENSE</div><div class="td2-sub">loading…</div></div>';
    if (kind === 'title') {
      var sv = loadSave(), free = starsFree(), R = E.REGIONS, ri = clamp(S.prog.region | 0, 0, R.length - 1);
      s += '<div class="td2-card td2-card-title"><div class="td2-title">GLYPH DEFENSE</div>';
      if (sv) { var sm = E.MAPS.filter(function (m) { return m.id === sv.g.mapId; })[0] || E.MAPS[sv.g.map]; if (sm) s += '<button type="button" class="td2-go" data-act="continue">▶ Continue ' + esc(sm.name) + ' · wave ' + sv.g.wave + ' · ♥ ' + sv.g.lives + '</button>'; }
      s += '<div class="td2-regions" role="tablist">';
      for (i = 0; i < R.length; i++) {
        var maps = E.MAPS.filter(function (m) { return m.region === i; }), first = maps.length ? maps[0].i : 0, open = mapOpen(first), st = 0;
        maps.forEach(function (m) { st += S.prog.maps[m.id].stars; });
        s += '<button type="button" class="td2-reg' + (i === ri ? ' on' : '') + (open ? '' : ' locked') + '" data-act="region" data-i="' + i + '" role="tab" aria-selected="' + (i === ri) + '" title="' + esc(R[i].name + ' — ' + (R[i].blurb || '')) + '">' +
          '<b>' + (i + 1) + '</b><span>' + st + '★</span></button>';
      }
      s += '</div><div class="td2-regname">' + esc(R[ri].name) + ' <small>' + esc(R[ri].blurb || '') + '</small></div><div class="td2-maps">';
      E.MAPS.forEach(function (M) {
        if (M.region !== ri) return;
        var pm = S.prog.maps[M.id], open = mapOpen(M.i);
        s += '<button type="button" class="td2-map' + (open ? '' : ' locked') + (M.ultra ? ' ultra' : '') + '" data-act="map" data-i="' + M.i + '" title="' + esc(M.name + ' — ' + M.blurb) + '"' + (open ? '' : ' aria-disabled="true"') + '>' +
          '<pre class="td2-mini td2-bio-' + M.biome + '" aria-hidden="true">' + miniMap(M.i) + '</pre>' +
          '<span class="td2-mname">' + esc(M.name) + '</span>' +
          '<span class="td2-mdiff">' + (M.ultra ? 'ULTRA · ' : '') + M.waves + ' waves</span>' +
          (open ? '<span class="td2-stars">' + starStr(pm.stars) + '</span><span class="td2-mbest">' + (pm.best ? 'best ' + pm.best : 'new') + '</span>'
            : '<span class="td2-lock">locked</span>') + '</button>';
      });
      s += '</div><div class="td2-row"><button type="button" class="td2-btn" data-act="codex">codex</button>' +
        '<button type="button" class="td2-btn td2-armbtn" data-act="armory">armory ★' + free + '</button>' +
        '<button type="button" class="td2-btn" data-act="help">help</button>' +
        '<button type="button" class="td2-btn" data-act="sound">♪ ' + (S.snd.on ? 'on' : 'off') + '</button></div></div>';
      return s;
    }
    if (kind === 'brief') return briefHtml();
    if (kind === 'codex') return codexHtml();
    if (kind === 'armory') {
      var have = starsEarned(S.prog), left = starsFree(), pk = S.prog.perks;
      s += '<div class="td2-card td2-card-scroll"><div class="td2-title">ARMORY</div>' +
        '<div class="td2-sub">★ ' + left + ' to spend · ' + have + ' earned' + (have ? '' : ' — win maps for stars') + '</div><div class="td2-list">';
      for (i = 0; i < E.D.PERKS.length; i++) {
        var P = E.D.PERKS[i], r = pk[P.id] | 0, pips = '';
        for (var j = 0; j < P.max; j++) pips += j < r ? '●' : '○';
        s += '<div class="td2-perk' + (r ? ' on' : '') + '"><div class="td2-pk"><b>' + esc(P.name) + '</b><span>' + esc(P.desc) + (P.max > 1 ? ' · up to ×' + P.max : '') + '</span></div>' +
          '<span class="td2-pips" aria-label="' + r + ' of ' + P.max + '">' + pips + '</span>' +
          '<button type="button" class="td2-pb" data-act="perk-" data-p="' + P.id + '"' + (r ? '' : ' disabled') + ' aria-label="Refund ' + esc(P.name) + '">−</button>' +
          '<button type="button" class="td2-pb td2-pb-buy" data-act="perk+" data-p="' + P.id + '"' + (r < P.max && left >= P.cost ? '' : ' disabled') + ' aria-label="Buy ' + esc(P.name) + ' for ' + P.cost + ' stars">★' + P.cost + '</button></div>';
      }
      s += '</div><div class="td2-note">perks apply to maps you start from now on · refunds are free</div>' +
        '<div class="td2-row"><button type="button" class="td2-btn" data-act="perkreset"' + (E.perkCost(pk) ? '' : ' disabled') + '>refund all</button>' +
        '<button type="button" class="td2-go" data-act="back">done</button></div></div>';
      return s;
    }
    if (kind === 'help') {
      return '<div class="td2-card td2-card-scroll"><div class="td2-title">HOW TO PLAY</div><div class="td2-help">' +
        '<p>Glyphs march down the <b>·</b> road from a gate <b class="td2-acc">↓</b> to an exit <b class="td2-bad">⌂</b>; each one that gets through costs <b>♥</b>. Hold out for every wave to win the map — stars for lives left — and unlock the next map and a new tower.</p>' +
        '<p><b>Letters rank by strength</b>: a is weakest, z strongest; <b>capitals</b> are tougher and split into their lowercase when they fall. Digits, <b>?</b> ghosts and <b>!</b> bells have tricks of their own, and the ten <b class="td2-bad">bosses</b> (@ Ω ₩ ₼ ₷ &amp; % ¶ ¤ ※) need real counters. Tap any enemy to read it; the <b>codex</b> lists all 74.</p>' +
        '<p><b>Before each map</b> you pick a <b>loadout</b> — the towers you can build there (some maps limit the catalog or the slots). ' + (S.coarse ? 'Tap' : 'Click') + ' a tile, pick a tower, ' + (S.coarse ? 'tap' : 'click') + ' again to build. Towers upgrade three times, then take <b>one of three final forms</b> (A, B or C).</p>' +
        '<p><b>Terrain</b>: grass <b>"</b>, highland <b>:</b> (+15% range for direct fire), shore <b>,</b> and water <b>~</b> (only some towers float). Ridges <b>^</b> block line of sight for direct fire; arcs, pulses and fields go over them.</p>' +
        '<p><b>Damage types</b>: physical (armor subtracts per hit), fire, frost, shock, acid, sonic, arcane. Weaknesses take ×1.5. Shields soak damage first. Hidden ghosts and burrowers need <b>true sight</b> (Sonic, Diamond) or a <b>Lantern</b>. Flyers follow the faint dotted lane and need anti-air.</p>' +
        '<p><b>ULTRA maps</b> are bigger than the screen: drag to pan, pinch or scroll to zoom, ⤢ to see it all; arrows at the edge point to foes out of view.</p>' +
        '<p><b>▶▶ Wave</b> calls the next wave early for bonus gold; each cleared wave pays. Speeds 1×–4×. The game pauses when you leave and is saved.</p>' +
        (S.coarse ? '' : '<p class="td2-keys">Keys: 1–9, 0 loadout · Enter build · arrows move · U upgrade · U/I/O final A/B/C · S sell · T aim · E element · Space next wave · F speed · +/− zoom · P pause · Esc back</p>') +
        '</div><button type="button" class="td2-go" data-act="back">back</button></div>';
    }
    if (kind === 'pause' || kind === 'menu') {
      var M2 = E.MAPS[g.map];
      return '<div class="td2-card"><div class="td2-title">' + (kind === 'pause' ? 'PAUSED' : 'MENU') + '</div>' +
        '<div class="td2-sub">' + esc(M2.name) + ' · wave ' + g.wave + (g.endless ? ' (free play)' : '/' + M2.waves) + ' · ♥ ' + g.lives + '</div>' +
        '<button type="button" class="td2-go" data-act="resume">' + (kind === 'pause' ? '▶ resume' : 'back to the map') + '</button>' +
        '<div class="td2-row"><button type="button" class="td2-btn" data-act="restart">restart</button><button type="button" class="td2-btn" data-act="maps">maps</button></div>' +
        '<div class="td2-row"><button type="button" class="td2-btn" data-act="codex">codex</button><button type="button" class="td2-btn" data-act="help">help</button>' +
        '<button type="button" class="td2-btn" data-act="sound">♪ ' + (S.snd.on ? 'on' : 'off') + '</button></div>' +
        '<div class="td2-note">saved automatically</div></div>';
    }
    if (kind === 'won') {
      var nx = g.map + 1 < E.MAPS.length ? E.MAPS[g.map + 1] : null, un = E.MAPS[g.map].unlock;
      return '<div class="td2-card"><div class="td2-title">VICTORY</div>' +
        '<div class="td2-bigstars">' + starStr(S.lastStars || 1) + '</div>' +
        '<div class="td2-sub">' + esc(E.MAPS[g.map].name) + ' held · ♥ ' + g.lives + '/' + g.maxLives + ' left</div>' +
        (S.newStars ? '<div class="td2-new">** new best **</div>' : '') +
        (S.newTower ? '<div class="td2-unlock">new tower: <b style="color:' + S.col.tc[E.TKEY[un]] + '">' + esc(E.TOWERS[E.TKEY[un]].g) + '</b> ' + esc(E.TOWERS[E.TKEY[un]].name) + '</div>' : '') +
        (nx && S.newMap ? '<div class="td2-note">' + esc(nx.name) + ' unlocked' + (nx.region !== E.MAPS[g.map].region ? ' — a new region: ' + esc(E.REGIONS[nx.region].name) : '') + '</div>' : '') +
        (starsFree() > 0 ? '<div class="td2-note">★ ' + starsFree() + ' to spend in the Armory</div>' : '') +
        '<button type="button" class="td2-go" data-act="endless">keep going — free play</button>' +
        '<div class="td2-row">' + (nx ? '<button type="button" class="td2-btn" data-act="nextmap">next map →</button>' : '') +
        '<button type="button" class="td2-btn" data-act="maps">maps</button></div></div>';
    }
    if (kind === 'lost') {
      var bm = S.prog.maps[E.MAPS[g.map].id], lk = [], keys = Object.keys(g.leakBy || {}).sort(function (a, b) { return g.leakBy[b] - g.leakBy[a]; });
      for (i = 0; i < keys.length && i < 6; i++) lk.push('<b>' + esc(keys[i]) + '</b>×' + g.leakBy[keys[i]]);
      return '<div class="td2-card"><div class="td2-title">' + (g.endless ? 'FREE PLAY OVER' : 'DEFEAT') + '</div>' +
        '<div class="td2-sub">' + esc(E.MAPS[g.map].name) + ' fell at wave ' + g.wave + '</div>' +
        (lk.length ? '<div class="td2-leaks">lives lost to ' + lk.join(' · ') + '</div>' : '') +
        '<div class="td2-sub">best: wave ' + bm.best + ' · ' + starStr(bm.stars) + '</div>' +
        '<button type="button" class="td2-go" data-act="retry">try again</button>' +
        '<div class="td2-row"><button type="button" class="td2-btn" data-act="brief">change loadout</button><button type="button" class="td2-btn" data-act="maps">maps</button></div></div>';
    }
    if (kind === 'preview') return previewHtml();
    return '';
  }
  // The briefing: the map, what comes, and the loadout picker (the catalog lives here).
  function briefHtml() {
    var mi = S.briefMap, M = E.MAPS[mi], md = E.mapData(mi), own = ownedTowers(), lo = S.lo, slots = E.slotsFor(mi, S.prog.perks), i;
    var gates = md.routes.length, exits = {}, pool = '';
    md.exits.forEach(function (x) { exits[x] = 1; });
    M.pool.forEach(function (k) { pool += glyphChip(k); });
    M.bosses.forEach(function (k) { if (pool.indexOf('data-g="' + k + '"') < 0) pool += glyphChip(k, true); });
    var s = '<div class="td2-card td2-card-brief td2-card-scroll"><div class="td2-title">' + esc(M.name.toUpperCase()) + '</div>' +
      '<div class="td2-sub">' + esc(E.REGIONS[M.region].name) + ' · ' + M.w + '×' + M.h + ' · ' + gates + ' gate' + (gates > 1 ? 's' : '') + ' · ' + Object.keys(exits).length + ' exit' + (Object.keys(exits).length > 1 ? 's' : '') + '</div>' +
      '<div class="td2-blurb">' + esc(M.blurb) + '</div>' +
      '<div class="td2-chips">' + traitChips(M) + '</div>' +
      '<div class="td2-facts"><span>' + M.waves + ' waves</span><span>♥ ' + (M.lives + E.mods(S.prog.perks, M).lives) + '</span><span>$ ' + Math.round(E.startGold(mi) * E.mods(S.prog.perks, M).gold) + '</span>' +
      (M.unlock && !mapWon(mi) ? '<span title="Win to unlock">unlocks <b style="color:' + S.col.tc[E.TKEY[M.unlock]] + '">' + esc(E.TOWERS[E.TKEY[M.unlock]].g) + '</b></span>' : '') + '</div>' +
      '<div class="td2-h">enemies here</div><div class="td2-glyphs">' + pool + '</div>' +
      '<div class="td2-h">loadout <small>' + lo.length + '/' + slots + ' · tap a tower to read it, again to add or remove</small></div><div class="td2-slots">';
    for (i = 0; i < slots; i++) {
      var t = lo[i];
      s += t != null ? '<button type="button" class="td2-slot" data-act="lo-" data-t="' + t + '" title="' + esc(E.TOWERS[t].name) + ' — remove"><b style="color:' + S.col.tc[t] + '">' + esc(E.TOWERS[t].g) + '</b><span>$' + E.TOWERS[t].cost + '</span></button>'
        : '<span class="td2-slot empty">·</span>';
    }
    s += '</div><div class="td2-cat">';
    ['atk', 'ctl', 'sup', 'eco'].forEach(function (cat) {
      s += '<div class="td2-catrow"><span class="td2-catname">' + E.D.CAT[cat] + '</span><div class="td2-catgrid">';
      for (var ti = 0; ti < E.TOWERS.length; ti++) {
        var T = E.TOWERS[ti];
        if (T.cat !== cat) continue;
        var has = !!own[ti], ok = E.allowed(mi, ti), inLo = lo.indexOf(ti) >= 0;
        s += '<button type="button" class="td2-ct' + (inLo ? ' on' : '') + (S.briefPick === ti ? ' pick' : '') + (has ? '' : ' locked') + (ok ? '' : ' banned') + '" data-act="lo+" data-t="' + ti + '"' +
          ' title="' + esc(T.name + (has ? '' : ' (locked — win more maps)') + (ok ? '' : ' (not allowed on this map)') + ' — ' + T.role + ' · $' + T.cost) + '"' + (has && ok ? '' : ' aria-disabled="true"') + '>' +
          '<b style="color:' + (has ? S.col.tc[ti] : '') + '">' + (has ? esc(T.g) : '?') + '</b></button>';
      }
      s += '</div></div>';
    });
    s += '</div><div class="td2-pick" id="td2-pickinfo">' + pickInfo(S.briefPick) + '</div>' +
      '<div class="td2-row td2-sticky"><button type="button" class="td2-btn" data-act="maps">← maps</button><button type="button" class="td2-btn" data-act="lo-auto">auto</button>' +
      '<button type="button" class="td2-go" data-act="deploy"' + (lo.length ? '' : ' disabled') + '>▶ deploy</button></div></div>';
    return s;
  }
  function glyphChip(k, boss) {
    var D = E.ENEMIES[k], known = seen(k);
    return '<button type="button" class="td2-gl' + (D.boss ? ' boss' : '') + (known ? '' : ' new') + '" data-act="enemy" data-g="' + esc(k) + '" title="' + esc(D.name + ' — ' + D.note) + '">' + esc(k) + '</button>';
  }
  function pickInfo(ti) {
    if (ti == null || ti < 0) return '<span class="td2-note">tap a tower in the catalog to read it; tap again to add or remove it</span>';
    var T = E.TOWERS[ti], st = E.towerStat(ti, 0);
    return '<b style="color:' + S.col.tc[ti] + '">' + esc(T.g) + ' ' + esc(T.name) + '</b> <span>$' + T.cost + ' · ' + esc(T.role) + '</span><br><small>' + esc(statLine(ti, st)) + (effectLine(st) ? ' · ' + esc(effectLine(st)) : '') +
      ' · builds on ' + esc(landWords(T.land)) + '</small><br><small class="td2-brs">' + T.brs.map(function (b, j) { return 'ABC'.charAt(j) + ' ' + esc(b[0]) + ': ' + esc(b[2]); }).join(' · ') + '</small>';
  }
  function landWords(s) { var n = { G: 'grass', H: 'highland', S: 'shore', W: 'water' }, o = []; for (var i = 0; i < s.length; i++) o.push(n[s.charAt(i)]); return o.join(', '); }
  // A sensible loadout: what you own and the map allows, covering detection / anti-air as needed.
  function autoLoadout(mi) {
    var own = ownedTowers(), M = E.MAPS[mi], pool = M.pool.join('') + M.bosses.join(''), slots = E.slotsFor(mi, S.prog.perks), out = [];
    var order = ['arrow', 'cannon', 'frost', 'lightning', 'sniper', 'mortar', 'acid', 'flame', 'gatling', 'rail', 'diamond', 'sonic', 'flak', 'lantern', 'amp', 'metronome', 'drone', 'beam', 'prism', 'mint', 'etcher', 'gravity'];
    function add(k) { var ti = E.TKEY[k]; if (out.length < slots && own[ti] && E.allowed(mi, ti) && out.indexOf(ti) < 0) out.push(ti); }
    if (/[?tT¤※]/.test(pool)) { add('sonic'); add('lantern'); add('diamond'); }
    if (/[fFwW₩]/.test(pool)) add('flak');
    order.forEach(add);
    return out;
  }
  function codexHtml() {
    var tab = S.prog.codexTab || 'towers', s = '<div class="td2-card td2-card-codex td2-card-scroll"><div class="td2-title">CODEX</div><div class="td2-tabs" role="tablist">';
    [['towers', 'towers'], ['enemies', 'enemies'], ['rules', 'rules']].forEach(function (t) { s += '<button type="button" class="td2-tab' + (tab === t[0] ? ' on' : '') + '" data-act="ctab" data-tab="' + t[0] + '" role="tab">' + t[1] + '</button>'; });
    s += '</div><div class="td2-codex">';
    if (tab === 'towers') {
      var own = ownedTowers();
      ['atk', 'ctl', 'sup', 'eco'].forEach(function (cat) {
        s += '<div class="td2-h">' + E.D.CAT[cat] + '</div><div class="td2-catgrid">';
        for (var ti = 0; ti < E.TOWERS.length; ti++) {
          var T = E.TOWERS[ti]; if (T.cat !== cat) continue;
          s += '<button type="button" class="td2-ct' + (S.codexPick === 't' + ti ? ' on' : '') + (own[ti] ? '' : ' locked') + '" data-act="cpick" data-k="t' + ti + '" title="' + esc(T.name) + '"><b style="color:' + S.col.tc[ti] + '">' + esc(T.g) + '</b></button>';
        }
        s += '</div>';
      });
      s += '<div class="td2-detail">' + (S.codexPick && S.codexPick.charAt(0) === 't' ? towerDetail(+S.codexPick.slice(1)) : '<span class="td2-note">tap a tower</span>') + '</div>';
    } else if (tab === 'enemies') {
      var known = 0;
      E.D.EGROUPS.forEach(function (G) {
        s += '<div class="td2-h">' + G.name + '</div><div class="td2-glyphs">';
        for (var i = 0; i < G.g.length; i++) {
          var k = G.g.charAt(i);
          if (!E.ENEMIES[k]) continue;
          var sn = seen(k); if (sn) known++;
          s += '<button type="button" class="td2-gl' + (E.ENEMIES[k].boss ? ' boss' : '') + (sn ? '' : ' unseen') + (S.codexPick === 'e' + k ? ' on' : '') + '" data-act="cpick" data-k="e' + esc(k) + '">' + (sn ? esc(k) : '·') + '</button>';
        }
        s += '</div>';
      });
      s += '<div class="td2-note">' + known + ' of ' + E.D.EORDER.length + ' met</div>';
      s += '<div class="td2-detail">' + (S.codexPick && S.codexPick.charAt(0) === 'e' ? enemyDetail(S.codexPick.slice(1)) : '<span class="td2-note">tap a glyph</span>') + '</div>';
    } else {
      s += '<div class="td2-help">' +
        '<p><b>Damage</b> resolves as: detection, then geometry, then shields. Physical armor subtracts per hit (never below 1); every other type ignores armor. Weakness ×1.5; resistances multiply. Tower buffs and enemy vulnerabilities together add at most +50%.</p>' +
        '<p><b>Burn and corrode</b> tick every 0.5 s; the strongest of each kind wins and refreshes. <b>Slows</b>: strongest only, at most 60% (bosses 25%). <b>Stuns</b>: at most 1.5 s, then 4 s of immunity; bosses can\'t be stunned or moved.</p>' +
        '<p><b>Hidden</b> foes (ghosts ?, buried tunnelers) can only be hit by towers with true sight or once revealed by a Lantern or a revealing hit — not even by splash. <b>Flyers</b> follow their dotted lane; a Wavewing flying low can be hit from the ground.</p>' +
        '<p><b>Capitals</b> pay their bounty once and split into their lowercase (worth nothing) — a leaked capital doesn\'t split. <b>Line of sight</b>: ridges block bolts, beams, lines, cones and chains; arcs, pulses, fields and orbits ignore them. Highland gives direct fire +15% range.</p>' +
        '<p><b>Economy</b>: at most one of each economy tower and two in all. Mints pay after each wave you owned them from its start; Banks lock credits for a wave for interest. Selling returns ' + Math.round(E.mods(S.prog.perks).sell * 100) + '%.</p>' +
        '<p><b>Supports</b> lift the nearest few attack towers in reach (same kind: strongest only). Rate +50%, range +40%, damage +50% at most. Jammers, Yowlers and Nullifiers suppress towers briefly; a Signal Relay shortens that.</p></div>';
    }
    s += '</div><button type="button" class="td2-go" data-act="back">back</button></div>';
    return s;
  }
  function towerDetail(ti) {
    var T = E.TOWERS[ti], s = '<div class="td2-dhead"><b style="color:' + S.col.tc[ti] + '">' + esc(T.g) + '</b> ' + esc(T.name) + ' <small>' + E.D.CAT[T.cat] + ' · ' + (T.type === 'none' ? 'no damage' : T.type) + ' · targets ' + (T.tgt === 'ally' ? 'towers' : T.tgt === 'none' ? '—' : T.tgt) + ' · ' + esc(landWords(T.land)) + '</small></div>';
    s += '<div class="td2-drole">' + esc(T.role) + '</div><table class="td2-dt">';
    for (var l = 0; l < 4; l++) {
      var st = E.towerStat(ti, l);
      s += '<tr><td>' + (l ? 'U' + l : 'T0') + '</td><td>$' + (l ? T.ups[l - 1][0] : T.cost) + '</td><td>' + esc(statLine(ti, st)) + (effectLine(st) ? '<br><small>' + esc(effectLine(st)) + '</small>' : '') + '</td></tr>';
    }
    for (var b = 0; b < 3; b++) {
      var sb = E.towerStat(ti, 4, b);
      s += '<tr class="br"><td>' + 'ABC'.charAt(b) + '</td><td>$' + T.brs[b][1] + '</td><td><b>' + esc(T.brs[b][0]) + '</b> — ' + esc(T.brs[b][2]) + '<br><small>' + esc(statLine(ti, sb)) + (effectLine(sb) ? ' · ' + esc(effectLine(sb)) : '') + '</small></td></tr>';
    }
    return s + '</table>';
  }
  function enemyDetail(k) {
    var D = E.ENEMIES[k];
    if (!seen(k)) return '<span class="td2-note">not met yet — it\'s out there somewhere</span>';
    var rs = [];
    for (var i = 0; i < 7; i++) if (D.res[i]) rs.push(DTN[i] + ' ' + pct(D.res[i]));
    var where = E.MAPS.filter(function (M) { return M.pool.indexOf(k) >= 0 || M.bosses.indexOf(k) >= 0; }).map(function (M) { return M.name; });
    return '<div class="td2-dhead"><b class="td2-eg' + (D.boss ? ' boss' : '') + '">' + esc(k) + '</b> ' + esc(D.name) + ' <small>' + (D.boss ? 'boss' : D.cap ? 'capital' : /[0-9]/.test(k) ? 'digit' : /[a-z]/.test(k) ? 'letter' : 'special') + (D.air ? ' · flies' : '') + '</small></div>' +
      '<div class="td2-facts"><span>HP ' + D.hp + '</span><span>armor ' + D.ar + '</span><span>' + D.spd + ' t/s</span><span>♥ ' + D.lives + '</span><span>$' + D.bounty + '</span>' + (D.split ? '<span>splits ' + D.split + '× ' + esc(D.lower) + '</span>' : '') + '</div>' +
      '<p>' + esc(D.note) + '</p>' +
      '<p><small>' + (D.weak >= 0 ? 'weak to <b>' + DTN[D.weak] + '</b>' : 'no weakness') + (rs.length ? ' · resists ' + esc(rs.join(', ')) : '') + '</small></p>' +
      (where.length ? '<p><small>found on: ' + esc(where.slice(0, 8).join(', ')) + (where.length > 8 ? '…' : '') + '</small></p>' : '');
  }
  function previewHtml() {
    var g = S.g, M = E.MAPS[g.map], s = '<div class="td2-card td2-card-scroll"><div class="td2-title">COMING UP</div><div class="td2-list">';
    for (var w = g.wave + 1; w <= Math.min(g.wave + 4, g.endless ? g.wave + 4 : M.waves); w++) {
      var sp = E.waveSpec(g.map, w);
      s += '<div class="td2-wrow"><b>wave ' + w + (sp.boss ? ' · boss' : '') + '</b><div class="td2-glyphs">';
      sp.groups.forEach(function (G) { s += '<span class="td2-gl' + (E.ENEMIES[G.k].boss ? ' boss' : '') + '" title="' + esc(E.ENEMIES[G.k].name + ' — ' + E.ENEMIES[G.k].note) + '">' + esc(G.k) + '<small>×' + G.n + '</small></span>'; });
      s += '</div>' + (sp.fresh ? '<small>new: ' + esc(sp.fresh) + ' ' + esc(E.ENEMIES[sp.fresh].name) + ' — ' + esc(E.ENEMIES[sp.fresh].note) + '</small>' : '') + '</div>';
    }
    if (!E.moreWaves(g)) s += '<div class="td2-note">no more waves — finish them off</div>';
    return s + '</div><button type="button" class="td2-go" data-act="back">back</button></div>';
  }
  function showOverlay(kind, keepFocus) {
    if (!S) return;
    var sc = S.ovl.querySelector('.td2-card-scroll'), keep = kind && kind === S.ovlKind && sc ? sc.scrollTop : 0;
    if (kind && kind !== S.ovlKind && kind !== 'help' && kind !== 'codex' && kind !== 'armory' && kind !== 'preview') S.ovlFrom = null;
    S.ovlKind = kind;
    S.ovl.innerHTML = kind ? overlayHtml(kind) : '';
    if (keep) { var sc2 = S.ovl.querySelector('.td2-card-scroll'); if (sc2) sc2.scrollTop = keep; }
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind);
    S.root.classList.toggle('td2-blocked', !!kind);
    var nog = !S.g || kind === 'title' || kind === 'brief' || kind === 'loading';
    if (S.root.classList.contains('td2-nogame') !== nog) { S.root.classList.toggle('td2-nogame', nog); layout(); }
    S.zoomBox.style.display = !kind && S.g && !fitsWholeAtFit() ? '' : 'none';
    S.mini.style.display = !kind && S.g && S.miniOn && !fitsWhole() ? '' : 'none'; S.miniShown = S.mini.style.display === '';
    if (kind) {
      S.sel = null; S.selT = null; S.armed = -1; S.selE = 0;
      if (!keepFocus) { var f = S.ovl.querySelector('.td2-go'); if (f && !S.coarse) { try { f.focus({ preventScroll: true }); } catch (e) {} } }
    }
    if (S.g) syncHud();
    redraw();
  }
  function fitsWholeAtFit() { return S.g && !E.MAPS[S.g.map].ultra && fitZ() >= (S.coarse ? 21 : 24); }

  // ---------------- actions ----------------
  function flash(txt, bad) {
    if (S.ovlKind && Cade.showToast) { Cade.showToast(txt, bad ? 'error' : 'info', 1600); return; }   // a card covers the map
    S.msg = { txt: txt, bad: !!bad, until: perfNow() + 1.8 }; redraw(); later(1900);
  }
  function later(ms) { clearTimeout(S.laterT); S.laterT = setTimeout(function () { if (S) { S.laterT = 0; redraw(); } }, ms); }
  function deselect() { S.sel = null; S.selT = null; S.armed = -1; S.sellArm = 0; S.selE = 0; syncHud(); redraw(); }
  function selectCell(c, r) { S.sel = { c: c, r: r }; S.selT = null; S.selE = 0; S.sellArm = 0; syncHud(); redraw(); }
  function selectTower(t) { S.selT = t; S.sel = null; S.selE = 0; S.armed = -1; S.sellArm = 0; S.tipKey = ''; syncHud(); redraw(); ensureVisible(t.c + 0.5, t.r + 0.5); }
  function act() { if (S) S.snd.ensure(); }
  function ensureVisible(x, y) {
    if (fitsWhole()) return;
    var c = S.cam, vw = S.vw / c.z, vh = S.vh / c.z, m = 1.2;
    if (x < c.x + m) c.x = x - m; else if (x > c.x + vw - m) c.x = x - vw + m;
    if (y < c.y + m) c.y = y - m; else if (y > c.y + vh - m) c.y = y - vh + m;
    clampCam();
  }
  function tryBuild(keepArmed) {
    var g = S.g, sel = S.sel, type = S.armed;
    if (!sel || type < 0) return false;
    var why = E.canBuildType(g, type) || E.placeWhy(g, sel.c, sel.r, type);
    if (why) { flash(why, true); return false; }
    var cost = E.TOWERS[type].cost;
    if (g.gold < cost) { flash('need $' + (cost - g.gold) + ' more', true); return false; }
    var t = E.build(g, sel.c, sel.r, type);
    if (!t) return false;
    handleEvents();
    S.sel = null; S.selT = null; S.armed = keepArmed ? type : -1;
    syncHud(); redraw();
    return true;
  }
  function armTower(ti) {
    if (!S.g || S.ovlKind || ti == null || ti < 0) return;
    S.selT = null; S.selE = 0;
    if (S.armed === ti && S.sel) { tryBuild(false); return; }
    S.armed = S.armed === ti && !S.sel ? -1 : ti;
    syncHud(); redraw();
  }
  function tapAt(px, py, mouse, shift) {
    var g = S.g;
    if (!g) return;
    var w = toWorld(px, py), c = Math.floor(w.x), r = Math.floor(w.y);
    var t = E.towerAt(g, c, r);
    if (t) { if (S.selT === t) deselect(); else selectTower(t); return; }
    var e = E.enemyNear(g, w.x, w.y, 0.55);
    if (e && !(S.armed >= 0 && E.canPlace(g, c, r, S.armed))) { S.selE = e.id; S.sel = null; S.selT = null; S.armed = -1; S.tipKey = ''; syncHud(); redraw(); return; }
    if (c < 0 || r < 0 || c >= E.mapData(g.map).w || r >= E.mapData(g.map).h) { deselect(); return; }
    var land = E.landOf(g, c, r);
    if (land) {
      var same = S.sel && S.sel.c === c && S.sel.r === r;
      if (S.armed >= 0 && (same || mouse)) { S.sel = { c: c, r: r }; tryBuild(mouse && shift); return; }
      if (same && S.armed < 0) { deselect(); return; }
      selectCell(c, r);
      return;
    }
    S.sel = null; S.selT = null; S.sellArm = 0; S.selE = 0;
    var tt = E.tileAt(g, c, r);
    if (tt === E.TL.ROAD) flash('that\'s the road — build beside it', true);
    else if (tt === E.TL.RIDGE) flash('ridges block building (and sight)', true);
    syncHud(); redraw();
  }
  // b: final branch (0..2) at level 3; ignored below it.
  function doUpgrade(b) {
    var t = S.selT;
    if (!t) return;
    if (t.lvl >= 4) { flash('final form already'); return; }
    if (t.lvl < 3) b = undefined; else if (!(b === 0 || b === 1 || b === 2)) { flash('pick a final form: A, B or C'); return; }
    if (!E.upgrade(S.g, t, b)) { flash('need $' + (E.upgradeCost(S.g, t, b) - S.g.gold) + ' more', true); return; }
    if (t.lvl === 4) flash(E.TOWERS[t.type].brs[t.br][0] + '!');
    handleEvents(); S.tipKey = ''; syncHud(); redraw();
  }
  function doSell() {
    var t = S.selT;
    if (!t) return;
    var now = perfNow();
    if (!S.sellArm || now > S.sellArm) {
      S.sellArm = now + 2.5; syncHud();
      clearTimeout(S.sellT);
      S.sellT = setTimeout(function () { if (S) { S.sellArm = 0; S.hud.ctxKey = ''; syncHud(); } }, 2600);
      return;
    }
    var v = E.sell(S.g, t);
    if (v < 0) { flash('empty its pads first', true); S.sellArm = 0; syncHud(); return; }
    handleEvents();
    S.selT = null; S.sellArm = 0;
    flash('sold for $' + v);
    syncHud(); redraw();
  }
  function doMode() {
    var t = S.selT;
    if (!t) return;
    var st = E.stats(S.g, t);
    if (st.shape === 'bank') { t.bankOn = t.bankOn ? 0 : 1; flash(t.bankOn ? 'the bank saves each wave' : 'deposits paused'); S.tipKey = ''; syncHud(); redraw(); return; }
    if (E.TOWERS[t.type].shape === 'prism' && !st.auto) { E.cyclePrism(t); S.tipKey = ''; syncHud(); redraw(); return; }
    if (!E.aims(t)) return;
    E.cycleMode(t); S.tipKey = ''; syncHud(); redraw();
  }
  function doAim() { var t = S.selT; if (t && E.aims(t)) { E.cycleMode(t); S.tipKey = ''; syncHud(); redraw(); } }
  function doNext() {
    var g = S.g;
    if (!g || S.ovlKind) return;
    var now = perfNow();
    if (now - (S.nextAt || 0) < 0.45) return;
    S.nextAt = now;
    if (S.paused) { resume(); return; }
    if (E.nextWave(g) < 0) return;
    handleEvents(); syncHud(); kick(); redraw();
  }
  function cycleSpeed() { var i = SPEEDS.indexOf(S.speed); S.speed = SPEEDS[(i + 1) % SPEEDS.length]; syncHud(); }
  function pause() {
    if (!S || !S.g || S.paused || S.g.phase !== 'wave' || S.ovlKind) return;
    S.paused = true;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    saveGame();
    showOverlay('pause');
  }
  function resume() { if (!S || !S.paused) return; S.paused = false; showOverlay(null); kick(); }
  function togglePause() {
    if (!S || !S.g) return;
    if (S.paused) { resume(); return; }
    if (S.g.phase === 'wave' && !S.ovlKind) { pause(); return; }
    if (S.ovlKind === 'menu') { showOverlay(null); return; }
    if (!S.ovlKind) showOverlay('menu');
  }
  function endGame() {
    var g = S.g, m = S.prog.maps[E.MAPS[g.map].id];
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    if (g.phase === 'won') {
      var st = E.starsFor(g.lives, g.maxLives), was = m.stars;
      S.lastStars = st; S.newStars = st > m.stars;
      S.newTower = !was && !!E.MAPS[g.map].unlock; S.newMap = !was;
      m.stars = Math.max(m.stars, st); m.best = Math.max(m.best, g.wave);
      saveProg(); saveGame();
      S.live.textContent = 'Victory! ' + st + ' star' + (st > 1 ? 's' : '') + '.';
      showOverlay('won');
    } else {
      m.best = Math.max(m.best, g.wave);
      saveProg(); sdel(SAVE_KEY);
      S.live.textContent = 'Defeat at wave ' + g.wave + '.';
      showOverlay('lost');
    }
  }
  // Open the briefing for map i (loadout picker), or a toast if it's still locked.
  function openBrief(i) {
    if (!mapOpen(i)) { if (Cade.showToast) Cade.showToast('Win ' + E.MAPS[i - 1].name + ' to unlock ' + E.MAPS[i].name, 'info', 1800); return; }
    S.briefMap = i; S.briefPick = -1;
    var own = ownedTowers(), slots = E.slotsFor(i, S.prog.perks), lo = [];
    (S.prog.loadout || []).forEach(function (k) { var ti = E.TKEY[k]; if (ti != null && own[ti] && E.allowed(i, ti) && lo.length < slots && lo.indexOf(ti) < 0) lo.push(ti); });
    // top up what carried over (a map may ban some of it) with sensible picks
    autoLoadout(i).forEach(function (ti) { if (lo.length < slots && lo.indexOf(ti) < 0) lo.push(ti); });
    S.lo = lo;
    S.viewMap = i;
    if (!S.g) { readBiome(); dropChunks(); layout(); defaultCam(); }
    showOverlay('brief');
  }
  function deploy() {
    var i = S.briefMap;
    if (!S.lo.length) return;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    S.prog.loadout = S.lo.map(function (ti) { return E.TOWERS[ti].key; }); saveProg();
    S.g = E.newGame(i, S.prog.perks, S.lo); S.viewMap = i; S.paused = false;
    S.sel = null; S.selT = null; S.armed = -1; S.selE = 0; S.banner = null; S.msg = null; S.ctxMode = '';
    sdel(SAVE_KEY);
    showOverlay(null);
    readBiome(); dropChunks(); S.cam.z = 0; layout(); defaultCam(); redraw();
    if (E.MAPS[i].ultra && !S.prog.ultraHint) { S.prog.ultraHint = 1; saveProg(); flash(S.coarse ? 'drag to pan · pinch to zoom' : 'drag to pan · scroll to zoom'); }
  }
  function continueSave() {
    var sv = loadSave(), g = sv ? E.restore(sv.g) : null;
    if (!g) { sdel(SAVE_KEY); showOverlay('title'); return; }
    S.g = g; S.viewMap = g.map; S.speed = SPEEDS.indexOf(sv.speed) >= 0 ? sv.speed : 1;
    S.ctxMode = ''; S.banner = null; S.selE = 0;
    readBiome(); dropChunks(); S.cam.z = 0; layout();
    if (sv.cam && sv.cam.z) { S.cam.x = sv.cam.x; S.cam.y = sv.cam.y; S.cam.z = clamp(sv.cam.z, minZ(), maxZ()); clampCam(); } else defaultCam();
    if (g.phase === 'won') { S.lastStars = E.starsFor(g.lives, g.maxLives); S.newStars = false; S.newTower = false; S.newMap = false; showOverlay('won'); return; }
    if (g.phase === 'wave') { S.paused = true; showOverlay('pause'); return; }
    S.paused = false;
    showOverlay(null);
  }
  function back() {
    var to = S.ovlFrom || (S.g ? (S.g.phase === 'won' ? 'won' : S.g.phase === 'lost' ? 'lost' : S.paused ? 'pause' : null) : 'title');
    S.ovlFrom = null;
    showOverlay(to);
  }
  function sub(kind) { var from = S.ovlKind; showOverlay(kind); S.ovlFrom = from; }
  function onOverlayClick(e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !S) return;
    act();
    var a = b.getAttribute('data-act'), ti = +b.getAttribute('data-t'), i;
    switch (a) {
      case 'region': S.prog.region = +b.getAttribute('data-i'); saveProg(); showOverlay('title'); break;
      case 'map': openBrief(+b.getAttribute('data-i')); break;
      case 'continue': continueSave(); break;
      case 'lo+':
        if (b.getAttribute('aria-disabled')) { S.briefPick = ti; refreshBrief(); flash(!ownedTowers()[ti] ? 'locked — win more maps to unlock it' : 'not allowed on this map'); break; }
        if (S.briefPick !== ti) { S.briefPick = ti; refreshBrief(); break; }      // first tap reads, the next one toggles
        i = S.lo.indexOf(ti);
        if (i >= 0) S.lo.splice(i, 1);
        else if (S.lo.length < E.slotsFor(S.briefMap, S.prog.perks)) S.lo.push(ti);
        else { if (Cade.showToast) Cade.showToast('Loadout full — remove one first', 'info', 1400); }
        S.briefPick = ti; refreshBrief(); break;
      case 'lo-': i = S.lo.indexOf(ti); if (i >= 0) S.lo.splice(i, 1); S.briefPick = ti; refreshBrief(); break;
      case 'lo-auto': S.lo = autoLoadout(S.briefMap); refreshBrief(); break;
      case 'lo-clear': S.lo = []; refreshBrief(); break;
      case 'deploy': deploy(); break;
      case 'enemy': S.prog.codexTab = 'enemies'; S.codexPick = 'e' + b.getAttribute('data-g'); if (!seen(b.getAttribute('data-g'))) { flash('not met yet'); break; } sub('codex'); break;
      case 'codex': sub('codex'); break;
      case 'ctab': S.prog.codexTab = b.getAttribute('data-tab'); S.codexPick = ''; saveProg(); showOverlay('codex', true); break;
      case 'cpick':
        S.codexPick = b.getAttribute('data-k'); showOverlay('codex', true);
        var dt = S.ovl.querySelector('.td2-detail'); if (dt && dt.scrollIntoView) { try { dt.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (er) { dt.scrollIntoView(false); } }
        break;
      case 'help': sub('help'); break;
      case 'armory': sub('armory'); break;
      case 'back': back(); break;
      case 'sound':
        S.snd.on = !S.snd.on; S.prog.sound = S.snd.on; saveProg();
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        b.textContent = '♪ ' + (S.snd.on ? 'on' : 'off');
        break;
      case 'resume': if (S.paused) resume(); else showOverlay(null); break;
      case 'restart':
        if (b.getAttribute('data-sure')) { S.briefMap = S.g.map; S.lo = S.g.loadout.slice(); deploy(); }
        else { b.setAttribute('data-sure', '1'); b.textContent = 'tap again'; b.classList.add('arm'); }
        break;
      case 'maps': saveGame(); S.paused = false; S.g = null; if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } layout(); showOverlay('title'); break;
      case 'brief': var mi2 = S.g ? S.g.map : S.briefMap; S.g = null; layout(); openBrief(mi2); break;
      case 'endless': E.goEndless(S.g); saveGame(); showOverlay(null); kick(); break;
      case 'nextmap': var cur = S.g ? S.g.map : S.viewMap; saveGame(); S.g = null; layout(); openBrief(Math.min(E.MAPS.length - 1, cur + 1)); break;
      case 'retry': S.briefMap = S.g.map; S.lo = S.g.loadout.slice(); deploy(); break;
      case 'perk+': case 'perk-':
        var id = b.getAttribute('data-p'), P = null, pk = S.prog.perks;
        for (i = 0; i < E.D.PERKS.length; i++) if (E.D.PERKS[i].id === id) P = E.D.PERKS[i];
        if (!P) return;
        var r = pk[id] | 0;
        if (a === 'perk+' && r < P.max && starsFree() >= P.cost) pk[id] = r + 1;
        else if (a === 'perk-' && r > 0) { if (r > 1) pk[id] = r - 1; else delete pk[id]; }
        else return;
        saveProg(); S.snd.tone(a === 'perk+' ? 880 : 520, 0.06, 'triangle', 0.04);
        showOverlay('armory', true);
        break;
      case 'perkreset': S.prog.perks = {}; saveProg(); showOverlay('armory', true); break;
    }
  }
  function refreshBrief() { showOverlay('brief', true); }

  // ---------------- input: drag to pan, pinch / wheel to zoom, tap to act ----------------
  function local(e) { var r = S.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function onDown(e) {
    if (!S || !S.g || S.ovlKind || (e.button != null && e.button > 0)) return;
    e.preventDefault();
    act();
    try { S.cv.setPointerCapture(e.pointerId); } catch (er) {}
    var p = local(e);
    S.ptrs[e.pointerId] = { x: p.x, y: p.y };
    var ids = Object.keys(S.ptrs);
    if (ids.length === 1) S.drag = { x0: p.x, y0: p.y, cx: S.cam.x, cy: S.cam.y, moved: false, mouse: e.pointerType === 'mouse', shift: e.shiftKey };
    else if (ids.length === 2) {
      var a = S.ptrs[ids[0]], b = S.ptrs[ids[1]];
      S.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: S.cam.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      if (S.drag) S.drag.moved = true;
    }
  }
  function onMove(e) {
    if (!S || !S.g) return;
    var p = local(e);
    if (S.ptrs[e.pointerId]) {
      S.ptrs[e.pointerId].x = p.x; S.ptrs[e.pointerId].y = p.y;
      var ids = Object.keys(S.ptrs);
      if (ids.length >= 2 && S.pinch) {
        var a = S.ptrs[ids[0]], b = S.ptrs[ids[1]], d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        setZoom(S.pinch.z0 * d / S.pinch.d0, mx, my);
        S.cam.x -= (mx - S.pinch.mx) / S.cam.z; S.cam.y -= (my - S.pinch.my) / S.cam.z; clampCam();
        S.pinch.mx = mx; S.pinch.my = my;
        redraw();
        return;
      }
      var D = S.drag;
      if (D) {
        var dx = p.x - D.x0, dy = p.y - D.y0;
        if (!D.moved && dx * dx + dy * dy > (D.mouse ? 25 : 81)) D.moved = true;
        if (D.moved && !fitsWhole()) { S.cam.x = D.cx - dx / S.cam.z; S.cam.y = D.cy - dy / S.cam.z; clampCam(); S.miniForce = true; redraw(); }
      }
      return;
    }
    if (e.pointerType === 'mouse') {
      var w = toWorld(p.x, p.y), h = S.hover, c = Math.floor(w.x), r = Math.floor(w.y);
      if (!h || h.c !== c || h.r !== r) { S.hover = { c: c, r: r }; if (S.armed >= 0 && !S.sel) redraw(); }
    }
  }
  function onUp(e) {
    if (!S) return;
    var had = S.ptrs[e.pointerId];
    delete S.ptrs[e.pointerId];
    try { S.cv.releasePointerCapture(e.pointerId); } catch (er) {}
    S.snd.ensure();
    if (Object.keys(S.ptrs).length < 2) S.pinch = null;
    var D = S.drag;
    if (!Object.keys(S.ptrs).length) {
      S.drag = null;
      if (had && D && !D.moved && e.type === 'pointerup' && S.g && !S.ovlKind) tapAt(had.x, had.y, D.mouse, D.shift);
    }
  }
  function onLeave() { if (S && S.hover) { S.hover = null; if (S.armed >= 0) redraw(); } }
  function onWheel(e) {
    if (!S || !S.g || S.ovlKind) return;
    e.preventDefault();
    var p = local(e), dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1), dx = e.deltaX * (e.deltaMode === 1 ? 33 : 1);
    var zoom = e.ctrlKey || (Math.abs(dy) >= 50 && !dx) || e.deltaMode === 1;
    if (zoom) setZoom(S.cam.z * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)), p.x, p.y);
    else if (!fitsWhole()) { S.cam.x += dx / S.cam.z; S.cam.y += dy / S.cam.z; clampCam(); }
    S.miniForce = true;
    redraw();
  }
  function onMini(e) {
    if (!S || !S.g) return;
    e.preventDefault(); e.stopPropagation();
    var r = S.mini.getBoundingClientRect(), md = E.mapData(S.g.map);
    centerOn((e.clientX - r.left) / r.width * md.w, (e.clientY - r.top) / r.height * md.h);
    S.miniForce = true; redraw();
  }
  function onZoomBtn(e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !S || !S.g) return;
    var a = b.getAttribute('data-z');
    if (a === '+') setZoom(S.cam.z * 1.35); else if (a === '-') setZoom(S.cam.z / 1.35);
    else if (a === 'fit') { if (fitsWhole()) defaultCam(); else { setZoom(minZ()); S.cam.x = 0; S.cam.y = 0; clampCam(); } }
    else if (a === 'go') {                               // jump to the enemy nearest an exit
      var best = null;
      S.g.enemies.forEach(function (en) { if (en.alive && (!best || en.rem < best.rem)) best = en; });
      if (best) centerOn(best.x, best.y); else flash('no foes on the field');
    }
    S.miniForce = true; redraw();
  }
  function onCtxClick(e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !S || !S.g || S.ovlKind) return;
    act();
    var tt = b.getAttribute('data-t');
    if (tt != null) { armTower(+tt); return; }
    var a = b.getAttribute('data-act');
    if (a === 'up') doUpgrade(); else if (a === 'b0') doUpgrade(0); else if (a === 'b1') doUpgrade(1); else if (a === 'b2') doUpgrade(2);
    else if (a === 'mode') doMode(); else if (a === 'sell') doSell(); else if (a === 'desel') deselect();
  }
  function onBarClick(e) {
    var b = e.target.closest ? e.target.closest('button,[data-act]') : null;
    if (!b || !S) return;
    act();
    var a = b.getAttribute('data-act');
    if (a === 'pause') togglePause();
    else if (a === 'speed') cycleSpeed();
    else if (a === 'next') doNext();
    else if (a === 'preview' && S.g && !S.ovlKind) { if (S.g.phase === 'wave' && !S.paused) { S.paused = true; if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } } sub('preview'); S.ovlFrom = S.paused ? 'pause' : null; }
    try { if (S.coarse) b.blur(); } catch (er) {}
  }
  function moveSel(dc, dr) {
    var md = E.mapData(S.g.map), base = S.selT || S.sel || { c: Math.floor(S.cam.x + S.vw / S.cam.z / 2), r: Math.floor(S.cam.y + S.vh / S.cam.z / 2) };
    var c = clamp(base.c + dc, 0, md.w - 1), r = clamp(base.r + dr, 0, md.h - 1), t = E.towerAt(S.g, c, r);
    if (t) selectTower(t); else { selectCell(c, r); ensureVisible(c + 0.5, r + 0.5); }
  }
  var KEYCODE = { ' ': 'Space', enter: 'Enter', escape: 'Escape', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight' };
  function onKey(e) {
    if (!S || !E || e.ctrlKey || e.metaKey || e.altKey) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var tg = e.target;
    if (tg && tg !== document.body && !S.panel.contains(tg) && (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) || tg.isContentEditable)) return;
    if (tg && tg !== document.body && !S.panel.contains(tg) && document.activeElement && document.activeElement.closest && document.activeElement.closest('.cm-editor')) return;
    var key = (e.key || '').toLowerCase(), code = e.code || KEYCODE[key] || '';
    if (code === 'Escape') {
      e.preventDefault();
      if (S.ovlKind === 'help' || S.ovlKind === 'codex' || S.ovlKind === 'armory' || S.ovlKind === 'preview') { back(); return; }
      if (S.ovlKind === 'brief') { showOverlay('title'); return; }
      if (S.ovlKind === 'pause') { resume(); return; }
      if (S.ovlKind === 'menu') { showOverlay(null); return; }
      if (S.g && !S.ovlKind && (S.sel || S.selT || S.armed >= 0 || S.selE)) { deselect(); return; }
      if (running()) { pause(); return; }
      closePanel();
      return;
    }
    if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) togglePause(); return; }
    if (!S.g || (S.ovlKind && S.ovlKind !== 'pause')) return;
    if (S.ovlKind === 'pause') {
      if ((code === 'Space' || code === 'Enter') && !(tg && tg.tagName === 'BUTTON' && S.ovl.contains(tg))) { e.preventDefault(); if (!e.repeat) resume(); }
      return;
    }
    if (e.repeat && !/^Arrow/.test(code)) { if (/^(Space|Enter|Digit|Key)/.test(code)) e.preventDefault(); return; }
    var dg = /^(Digit|Numpad)([0-9])$/.exec(code);
    if (dg) { e.preventDefault(); act(); armTower(S.g.loadout[DIGITS.indexOf(dg[2])]); return; }
    switch (code) {
      case 'Space': case 'KeyN': e.preventDefault(); act(); doNext(); return;
      case 'Enter': case 'NumpadEnter': e.preventDefault(); act(); if (S.armed >= 0 && S.sel) tryBuild(false); return;
      case 'KeyU': e.preventDefault(); doUpgrade(S.selT && S.selT.lvl === 3 ? 0 : undefined); return;
      case 'KeyI': e.preventDefault(); if (S.selT && S.selT.lvl === 3) doUpgrade(1); return;
      case 'KeyO': e.preventDefault(); if (S.selT && S.selT.lvl === 3) doUpgrade(2); return;
      case 'KeyS': e.preventDefault(); doSell(); return;
      case 'KeyT': e.preventDefault(); doAim(); return;
      case 'KeyE': e.preventDefault(); doMode(); return;
      case 'KeyF': e.preventDefault(); cycleSpeed(); return;
      case 'Equal': case 'NumpadAdd': e.preventDefault(); setZoom(S.cam.z * 1.25); redraw(); return;
      case 'Minus': case 'NumpadSubtract': e.preventDefault(); setZoom(S.cam.z / 1.25); redraw(); return;
      case 'ArrowUp': e.preventDefault(); moveSel(0, -1); return;
      case 'ArrowDown': e.preventDefault(); moveSel(0, 1); return;
      case 'ArrowLeft': e.preventDefault(); moveSel(-1, 0); return;
      case 'ArrowRight': e.preventDefault(); moveSel(1, 0); return;
    }
  }

  // ---------------- layout: fit the stage to the visible viewport ----------------
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height) return vh - (vw <= 560 ? 250 : 270);
    var ft = document.querySelector('.footer'), fr = ft && ft.getBoundingClientRect();
    if (fr && fr.height && fr.top > vh * 0.6) vh = Math.min(vh, fr.top);
    var head = S.panel.querySelector('.cade-panel-head'), body = S.panel.querySelector('.cade-panel-body');
    var bs = body ? getComputedStyle(body) : null;
    var chrome = (head ? head.offsetHeight : 36) + (bs ? (parseFloat(bs.paddingTop) || 0) + (parseFloat(bs.paddingBottom) || 0) : 20) +
      (S.root.offsetHeight - (S.stage.offsetHeight || 0)) + 2;
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 6;
  }
  function layout() {
    if (!S) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var body = S.panel.querySelector('.cade-panel-body');
    if (body) body.scrollTop = 0;
    var aw = vw <= 560 ? vw - 26 : Math.min(780, vw - 60);
    var ah = Math.max(240, Math.min(availH(vw, vh), 960));
    var W = aw, H = ah, M = S.g ? E.MAPS[S.g.map] : null;
    if (M) {
      var md = E.mapData(M.i), z = Math.min(aw / md.w, ah / md.h);
      if (z >= (S.coarse ? 21 : 24) && !M.ultra) { z = Math.min(z, 44); W = Math.max(Math.round(md.w * z), Math.min(aw, 330)); H = Math.round(md.h * z); }
    } else if (!S.g) { W = Math.min(aw, 560); }
    var dpr = Math.min(2, window.devicePixelRatio || 1), wasFit = S.vw && fitsWhole();
    S.vw = W; S.vh = H; S.dpr = dpr;
    S.cv.style.width = W + 'px'; S.cv.style.height = H + 'px';
    S.stage.style.width = W + 'px'; S.stage.style.height = H + 'px';
    S.root.style.width = W + 'px';
    var bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    if (S.cv.width !== bw) S.cv.width = bw;
    if (S.cv.height !== bh) S.cv.height = bh;
    if (S.g || S.viewMap != null) {
      if (wasFit || !S.cam.z) { S.cam.z = 0; }
      if (!S.cam.z) defaultCam(); else { S.cam.z = clamp(S.cam.z, minZ(), maxZ()); clampCam(); }
      // the minimap: for maps that don't fit at a comfortable size
      var mdd = E.mapData(curMap()), need = (E.MAPS[curMap()].ultra || fitZ() < (S.coarse ? 21 : 24)) && !!S.g;
      S.miniOn = need;
      if (need) {
        var ms = Math.min(96 / mdd.w, 96 / mdd.h, 4);
        S.mini.style.width = Math.round(mdd.w * ms) + 'px'; S.mini.style.height = Math.round(mdd.h * ms) + 'px';
        S.mini.width = Math.round(mdd.w * ms * dpr); S.mini.height = Math.round(mdd.h * ms * dpr);
        S.miniS = ms * dpr; S.miniBase = ''; S.miniForce = true;
      }
      S.mini.style.display = need && !S.ovlKind ? '' : 'none';
      S.zoomBox.style.display = need && !S.ovlKind ? '' : 'none';
    }
    S.chunkK = 0;
  }

  // ---------------- open / close ----------------
  function teardown() {
    if (!S) return;
    saveGame();
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    if (s.drawQ) cancelAnimationFrame(s.drawQ);
    clearTimeout(s.resizeT); clearTimeout(s.laterT); clearTimeout(s.sellT); clearTimeout(s.chunkT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.panel.removeEventListener('cade-panel-minimize', s.onMin);
    s.panel.removeEventListener('cade-panel-restore', s.onRestore);
    s.snd.close();
    for (var k in s.chunks) { s.chunks[k].cv.width = 0; s.chunks[k].cv.height = 0; }
    s.chunks = null; s.g = null;
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { closePanel(); return; }
    var body = '<div class="td2 td2-nogame">' +
      '<div class="td2-stage"><canvas class="td2-cv" aria-label="Glyph Defense map"></canvas>' +
      '<canvas class="td2-minimap" style="display:none" aria-label="Minimap — tap to jump"></canvas>' +
      '<div class="td2-zoom" style="display:none"><button type="button" data-z="+" title="Zoom in (+)" aria-label="Zoom in">+</button><button type="button" data-z="-" title="Zoom out (−)" aria-label="Zoom out">−</button><button type="button" data-z="fit" title="Whole map" aria-label="Whole map">⤢</button><button type="button" data-z="go" title="Jump to the front-most foe" aria-label="Jump to the front-most foe">◎</button></div>' +
      '<div class="td2-ovl"></div></div>' +
      '<div class="td2-ctx" role="toolbar" aria-label="Build"></div>' +
      '<div class="td2-bar">' +
      '<div class="td2-stats" data-act="preview" title="Coming up"><div><span class="td2-lives"></span><span class="td2-gold"></span></div><div class="td2-wave"></div></div>' +
      '<button type="button" class="td2-ib" data-act="pause"></button>' +
      '<button type="button" class="td2-ib td2-spd" data-act="speed" title="Game speed (F)" aria-label="Game speed"></button>' +
      '<button type="button" class="td2-next" data-act="next" title="Next wave (Space)"><b></b><span></span></button>' +
      '</div><div class="td2-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, TITLE, body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var ovl = p.querySelector('.td2-ovl');
    ovl.innerHTML = '<div class="td2-card"><div class="td2-title">GLYPH DEFENSE</div><div class="td2-sub">loading…</div></div>';
    loadEngine().then(function () {
      if (!p.isConnected || document.getElementById(PANEL_ID) !== p) return;
      init(p);
    }, function (err) {
      ovl.innerHTML = '<div class="td2-card"><div class="td2-title">GLYPH DEFENSE</div><div class="td2-sub">' + esc(err && err.message || 'could not load') + '</div></div>';
    });
  }
  function init(p) {
    var mm = window.matchMedia;
    S = {
      panel: p, root: p.querySelector('.td2'), stage: p.querySelector('.td2-stage'), cv: p.querySelector('.td2-cv'), ovl: p.querySelector('.td2-ovl'),
      mini: p.querySelector('.td2-minimap'), zoomBox: p.querySelector('.td2-zoom'), live: p.querySelector('.td2-live'),
      coarse: !!(mm && mm('(pointer: coarse)').matches), g: null, viewMap: 0, speed: 1, paused: false, ovlKind: null,
      sel: null, selT: null, selE: 0, armed: -1, hover: null, ghost: { type: 0, lvl: 0, br: -1, c: 0, r: 0 }, played: [],
      raf: 0, drawQ: 0, last: 0, cam: { x: 0, y: 0, z: 0 }, vw: 0, vh: 0, dpr: 1, chunks: {}, chunkN: 0, chunkK: 0, frameNo: 0,
      ptrs: {}, drag: null, pinch: null, lo: [], briefMap: -1, briefPick: -1, codexPick: '', firstSeen: {}, stamp: 0, pt: {},
      tipKey: '', tip: null, curFont: null, frameTheme: 0, miniOn: false, ctxMode: ''
    };
    if (window.__TD2_TEST) window.__TD2_TEST.S = S;     // headless checks only (set by the test page)
    S.prog = loadProg();
    S.snd = new Snd(S.prog.sound);
    S.ctx = S.cv.getContext('2d');
    S.mctx = S.mini.getContext('2d');
    var q = function (sel) { return p.querySelector(sel); };
    S.hud = {
      ctx: q('.td2-ctx'), lives: q('.td2-lives'), gold: q('.td2-gold'), wave: q('.td2-wave'), livesBox: q('.td2-stats'),
      next: q('.td2-next'), next1: q('.td2-next b'), next2: q('.td2-next span'), speed: q('.td2-spd'), pause: q('[data-act="pause"]'), pauseK: -1, ctxKey: ''
    };
    S.viewMap = 0;
    for (var i = 0; i < E.MAPS.length; i++) if (mapOpen(i)) S.viewMap = i;
    S.onMin = function () { if (S && S.panel === p) { pause(); if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } saveGame(); } };
    S.onRestore = function () { if (S && S.panel === p) { layout(); redraw(); kick(); } };
    p._onClose = teardown;
    layout();
    readTheme();
    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { pause(); };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', S.onMin);
    p.addEventListener('cade-panel-restore', S.onRestore);
    S.onResize = function () { if (!S) return; clearTimeout(S.resizeT); S.resizeT = setTimeout(function () { if (S) { layout(); redraw(); } }, 120); };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () { if (S) { S.frameTheme++; readTheme(); S.ctxMode = ''; if (S.g) syncHud(); if (S.ovlKind) showOverlay(S.ovlKind, true); redraw(); } });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}
    S.cv.addEventListener('pointerdown', onDown);
    S.cv.addEventListener('pointermove', onMove);
    S.cv.addEventListener('pointerup', onUp);
    S.cv.addEventListener('pointercancel', onUp);
    S.cv.addEventListener('pointerleave', onLeave);
    S.cv.addEventListener('wheel', onWheel, { passive: false });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.mini.addEventListener('pointerdown', onMini);
    S.zoomBox.addEventListener('click', onZoomBtn);
    S.ovl.addEventListener('click', onOverlayClick);
    S.hud.ctx.addEventListener('click', onCtxClick);
    p.querySelector('.td2-bar').addEventListener('click', onBarClick);
    showOverlay('title');
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('600 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); dropChunks(); redraw(); } }, function () {});
      }
    } catch (e) {}
    whenStyled(p, 0);
  }
  function whenStyled(p, n) {
    if (!S || S.panel !== p) return;
    var ok = getComputedStyle(S.root).display === 'flex';
    if (ok || n > 90) { layout(); layout(); if (S.ovlKind) showOverlay(S.ovlKind, true); redraw(); return; }
    requestAnimationFrame(function () { whenStyled(p, n + 1); });
  }

  Cade.registerWidget({
    name: 'Tower Defense V2',
    description: 'Glyph Defense — 40 towers with three final forms, 74 glyph enemies including 10 bosses, 35 maps over 7 regions with pan-and-zoom ULTRA maps, loadouts, codex and armory',
    icon: '🏯',
    tags: 'game,strategy,tower defense,td,td2,glyph defense,towers,waves,defense,ascii,fun,bosses,maps',
    open: open
  });
})();
