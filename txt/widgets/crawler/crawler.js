/* ============================================================================
 * DEEPDELVE — Dungeon Crawler (Cade.txt widget, id "crawler", panel #crawler-panel)
 * ----------------------------------------------------------------------------
 * A story-driven roguelite: six classes (Warrior, Rogue, Mage, Ranger, Cleric,
 * Necromancer) each with their own resource, five abilities and a talent tree;
 * five acts of descent beneath Lanternfall (crypts → fungal hollows → drowned
 * archive → cinder forge → the abyss), multi-phase bosses, telegraphed attacks,
 * elite affixes, traps and hazards, puzzle rooms, shrines and strangers, a
 * town of recurring characters, bounties, side quests, lore, loot with rarity,
 * affixes, uniques and sets, a smith, a shared stash, New Game+, the Endless
 * Descent and a daily seeded challenge.
 *
 * Files (all in this folder):
 *   crawler-data.js    content tables (pure data)       → window.__cadeCrawlerData
 *   crawler-engine.js  the pure, node-testable engine  → window.__cadeCrawlerEngine
 *   crawler.js         this file: loader, persistence, canvas renderer, UI, input
 *   crawler.test.js    node tests for the engine
 *
 * Persistence: a roster of up to four heroes (+ shared stash + daily records)
 * in Cade.store (cade-crawler-roster) mirrored to Firebase at
 * rooms/__cade_dungeon/roster (merged per hero, most-progressed copy wins).
 * The old single hero (rooms/__cade_dungeon/hero, cade-dungeon-save) migrates
 * into the roster as a veteran on first open. A delve in progress is saved
 * locally (cade-crawler-run-<hero>) and resumes where you left it.
 * ========================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Cade) return;
  var Cade = window.Cade;
  Cade.loadCSS('crawler.css');
  var DATA_URL = Cade.asset('crawler-data.js'), ENGINE_URL = Cade.asset('crawler-engine.js');
  var PANEL_ID = 'crawler-panel';
  var E = null, D = null;          // engine + data, once loaded
  var S = null;                    // everything that lives while the panel is open

  // ---- storage keys -------------------------------------------------------------
  var K_ROSTER = 'cade-crawler-roster', K_SET = 'cade-crawler-settings', K_RUN = 'cade-crawler-run-', K_CLIENT = 'cade-dungeon-client';
  var K_LEGACY = 'cade-dungeon-save';
  var FB_ROSTER = 'rooms/__cade_dungeon/roster', FB_LEGACY = 'rooms/__cade_dungeon/hero', FB_LEGACY_OLD = 'rooms/_dungeon/hero';

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function sdel(k) { try { if (Cade.store.remove) Cade.store.remove(k); else Cade.store.set(k, ''); } catch (e) {} }
  function jget(k) { try { var s = sget(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

  // ---- loading the data + engine scripts -------------------------------------------
  var loading = null;
  function loadScript(url) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = url; s.async = true;
      s.onload = function () { res(); }; s.onerror = function () { s.remove(); rej(new Error('load ' + url)); };
      document.head.appendChild(s);
    });
  }
  function loadAll() {
    if (E) return Promise.resolve();
    if (loading) return loading;
    loading = (window.__cadeCrawlerData ? Promise.resolve() : loadScript(DATA_URL))
      .then(function () { return window.__cadeCrawlerEngine ? null : loadScript(ENGINE_URL); })
      .then(function () {
        E = window.__cadeCrawlerEngine; D = E && E.D;
        if (!E || !D) throw new Error('engine missing');
      })
      .catch(function (e) { loading = null; throw e; });
    return loading;
  }

  // ---- settings -----------------------------------------------------------------
  function loadSettings() { var s = jget(K_SET) || {}; return { sound: s.sound !== false, quick: s.quick !== false, mini: s.mini !== false, hints: s.hints !== false }; }
  function saveSettings() { if (S) sset(K_SET, JSON.stringify(S.set)); }

  // ===========================================================================
  //  persistence: local roster + Firebase mirror
  // ===========================================================================
  function clientId() {
    var c = sget(K_CLIENT);
    if (!c) { c = 'c' + Math.random().toString(36).slice(2, 9) + (Date.now() % 100000); sset(K_CLIENT, c); }
    return c;
  }
  function fbDb() {
    try {
      if (typeof firebase === 'undefined' || !firebase.database) return null;
      var url = sget('cade-firebase-url'); if (!url) return null;
      var app;
      try { app = firebase.app('cade-dungeon'); } catch (e) { app = firebase.initializeApp({ databaseURL: url }, 'cade-dungeon'); }
      return firebase.database(app);
    } catch (e) { return null; }
  }
  // load: local roster ⊕ remote roster; if neither exists, migrate the legacy hero.
  function loadRoster(done) {
    var local = jget(K_ROSTER), db = fbDb(), settled = false;
    function finish(remote, legacyRemote) {
      if (settled) return; settled = true;
      var R = local ? E.normRoster(local) : null;
      if (remote) R = R ? E.mergeRoster(R, remote) : E.normRoster(remote);
      if (!R) R = E.newRoster();
      // legacy migration (only once: a flag in the roster remembers)
      if (!R.migrated) {
        var old = legacyRemote || jget(K_LEGACY), localOld = jget(K_LEGACY);
        if (localOld && legacyRemote && (localOld.rev || 0) > (legacyRemote.rev || 0)) old = localOld;
        if (old && !Object.keys(R.slots).some(function (id) { return R.slots[id].flags && R.slots[id].flags.veteran; })) {
          var h = E.migrateLegacy(old);
          if (h && R.order.length < E.ROSTER_MAX) { R.slots[h.id] = h; R.order.unshift(h.id); R.active = h.id; S && (S.migratedNow = h.id); }
        }
        R.migrated = 1;
      }
      done(R);
    }
    if (!db) { finish(null, null); return; }
    try {
      db.ref(FB_ROSTER).once('value').then(function (snap) {
        var v = snap.val();
        if (v || local) { finish(v, null); return; }
        db.ref(FB_LEGACY).once('value').then(function (s2) {
          var lv = s2.val();
          if (lv) { finish(null, lv); return; }
          db.ref(FB_LEGACY_OLD).once('value').then(function (s3) { finish(null, s3.val()); }).catch(function () { finish(null, null); });
        }).catch(function () { finish(null, null); });
      }).catch(function () { finish(null, null); });
    } catch (e) { finish(null, null); }
    setTimeout(function () { finish(null, null); }, 4000);
  }
  function attachFb() {
    detachFb();
    var db = fbDb(); if (!db || !S) return;
    try {
      S.fbRef = db.ref(FB_ROSTER);
      S.fbCb = function (snap) {
        var v = snap.val(); if (!v || !S || !S.R) return;
        if (v.client === S.client && (v.rev || 0) <= (S.R.rev || 0)) return;   // our own echo
        var inRun = !!S.G && S.G.mode === 'story', keep = inRun ? S.G.hero : null;
        var merged = E.mergeRoster(S.R, v);
        merged.migrated = 1;
        if (keep) { merged.slots[keep.id] = keep; }
        var activeBefore = S.R.active;
        S.R = merged; S.R.active = S.R.slots[activeBefore] ? activeBefore : S.R.active;
        sset(K_ROSTER, JSON.stringify(S.R));
        if (!inRun && S.screen === 'town') { S.hero = S.R.slots[S.R.active] || S.hero; renderScreen(); }
        else if (!inRun && (S.screen === 'title' || S.screen === 'roster')) renderScreen();
      };
      S.fbRef.on('value', S.fbCb);
    } catch (e) {}
  }
  function detachFb() { try { if (S && S.fbRef && S.fbCb) S.fbRef.off('value', S.fbCb); } catch (e) {} if (S) { S.fbRef = null; S.fbCb = null; } }
  function markDirty() { if (!S) return; S.dirty = true; if (!S.saveT) S.saveT = setTimeout(function () { if (S) { S.saveT = 0; saveNow(); } }, 1800); }
  function saveNow() {
    if (!S || !S.R) return;
    S.dirty = false;
    if (S.G && S.G.mode === 'story') E.syncHero(S.G);
    var h = S.R.slots[S.R.active]; if (h) { h.rev = (h.rev || 1) + 1; h.updated = Date.now(); }
    S.R.rev = (S.R.rev || 0) + 1; S.R.client = S.client;
    var json = JSON.stringify(S.R);
    sset(K_ROSTER, json);
    var db = fbDb(); if (!db) return;
    var mine = JSON.parse(json);
    try {
      db.ref(FB_ROSTER).transaction(function (cur) {
        var m = cur ? E.mergeRoster(mine, cur) : mine;
        m.migrated = 1; m.client = S ? S.client : mine.client; m.rev = Math.max(mine.rev || 0, (cur && cur.rev) || 0) + 1;
        return JSON.parse(JSON.stringify(m));
      }, undefined, false);
    } catch (e) { try { db.ref(FB_ROSTER).set(mine); } catch (e2) {} }
  }
  function runKey() { if (!S || !S.G) return null; return K_RUN + (S.G.mode === 'daily' ? 'daily' : S.G.heroId); }
  function saveRunSoon() { if (!S || !S.G) return; if (!S.runT) S.runT = setTimeout(function () { if (S) { S.runT = 0; saveRunNow(); } }, 700); }
  function saveRunNow() {
    if (!S || !S.G || S.G.over) return;
    try {
      var snap = E.serializeRun(S.G);
      if (S.G.mode === 'story') snap.heroRev = S.G.hero.rev || 0;
      sset(runKey(), JSON.stringify(snap));
    } catch (e) {}
    if (S.G.mode === 'story') { E.syncHero(S.G); markDirty(); }
  }
  function clearRun(mode, heroId) { sdel(K_RUN + (mode === 'daily' ? 'daily' : heroId)); }

  // ===========================================================================
  //  sound — tiny WebAudio blips, created on the first gesture
  // ===========================================================================
  function Snd(on) { this.on = !!on; this.ac = null; this.last = {}; }
  Snd.prototype.ensure = function () {
    if (!this.on) return;
    if (!this.ac) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; try { this.ac = new AC(); } catch (e) { this.ac = null; return; } }
    if (this.ac.state === 'suspended') { try { this.ac.resume(); } catch (e) {} }
  };
  Snd.prototype.tone = function (f, dur, type, vol, slide, delay) {
    var ac = this.ac; if (!this.on || !ac || ac.state === 'closed') return;
    try {
      var t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.noise = function (dur, vol, hp, delay) {
    var ac = this.ac; if (!this.on || !ac || ac.state === 'closed') return;
    try {
      var n = Math.floor(ac.sampleRate * dur), b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      var s = ac.createBufferSource(), g = ac.createGain(), f = ac.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = hp || 600;
      s.buffer = b; g.gain.value = vol || 0.05; s.connect(f); f.connect(g); g.connect(ac.destination);
      s.start(ac.currentTime + (delay || 0));
    } catch (e) {}
  };
  Snd.prototype.play = function (k) {
    if (!this.on || !this.ac) return;
    var t = now(); if (this.last[k] && t - this.last[k] < 45) return; this.last[k] = t;
    switch (k) {
      case 'step': this.tone(140, 0.03, 'triangle', 0.012); break;
      case 'hit': this.noise(0.06, 0.06, 900); this.tone(220, 0.06, 'square', 0.025, 110); break;
      case 'crit': this.noise(0.09, 0.09, 700); this.tone(520, 0.12, 'sawtooth', 0.04, 160); break;
      case 'hurt': this.tone(160, 0.14, 'sawtooth', 0.05, 70); break;
      case 'miss': this.tone(900, 0.05, 'sine', 0.02, 1300); break;
      case 'kill': this.tone(330, 0.08, 'square', 0.03, 520); this.tone(660, 0.08, 'triangle', 0.025, 0, 0.06); break;
      case 'gold': this.tone(1320, 0.05, 'triangle', 0.03); this.tone(1760, 0.07, 'triangle', 0.025, 0, 0.05); break;
      case 'pick': this.tone(880, 0.06, 'triangle', 0.03, 1320); break;
      case 'rare': [880, 1108, 1318, 1760].forEach(function (f, i) { this.tone(f, 0.12, 'triangle', 0.03, 0, i * 0.06); }, this); break;
      case 'level': [523, 659, 784, 1046].forEach(function (f, i) { this.tone(f, 0.16, 'square', 0.03, 0, i * 0.09); }, this); break;
      case 'fire': this.noise(0.18, 0.05, 300); this.tone(300, 0.15, 'sawtooth', 0.025, 120); break;
      case 'frost': this.tone(1600, 0.2, 'sine', 0.03, 600); break;
      case 'zap': this.noise(0.08, 0.05, 2500); this.tone(1200, 0.1, 'square', 0.02, 300); break;
      case 'holy': this.tone(880, 0.25, 'sine', 0.035); this.tone(1320, 0.25, 'sine', 0.025, 0, 0.05); break;
      case 'dark': this.tone(110, 0.25, 'sawtooth', 0.035, 55); break;
      case 'bow': this.tone(420, 0.05, 'triangle', 0.03, 900); break;
      case 'swing': this.noise(0.08, 0.04, 1800); break;
      case 'boom': this.noise(0.35, 0.1, 120); this.tone(80, 0.3, 'sine', 0.06, 40); break;
      case 'heal': this.tone(660, 0.18, 'sine', 0.03, 990); break;
      case 'door': this.tone(200, 0.08, 'triangle', 0.025, 150); break;
      case 'stairs': [392, 330, 262, 196].forEach(function (f, i) { this.tone(f, 0.12, 'triangle', 0.03, 0, i * 0.08); }, this); break;
      case 'chest': this.tone(500, 0.08, 'square', 0.025, 700); this.tone(1000, 0.12, 'triangle', 0.025, 0, 0.08); break;
      case 'solve': [523, 784, 1046, 1568].forEach(function (f, i) { this.tone(f, 0.18, 'triangle', 0.035, 0, i * 0.1); }, this); break;
      case 'lever': this.tone(180, 0.1, 'square', 0.03, 90); break;
      case 'boss': this.tone(70, 0.8, 'sawtooth', 0.06, 50); this.tone(105, 0.8, 'sawtooth', 0.04, 70); break;
      case 'death': [330, 262, 196, 131].forEach(function (f, i) { this.tone(f, 0.3, 'sawtooth', 0.04, 0, i * 0.18); }, this); break;
      case 'warn': this.tone(740, 0.07, 'square', 0.02); this.tone(740, 0.07, 'square', 0.02, 0, 0.12); break;
      case 'ui': this.tone(660, 0.03, 'triangle', 0.02); break;
      case 'bad': this.tone(220, 0.12, 'square', 0.025, 160); break;
    }
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  // ===========================================================================
  //  theme → canvas palette
  // ===========================================================================
  function parseCol(s, d) {
    s = (s || '').trim();
    var m = s.match(/^#([0-9a-f]{3,8})$/i);
    if (m) { var h = m[1]; if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
    m = s.match(/rgba?\(([^)]+)\)/); if (m) { var p = m[1].split(/[ ,/]+/).map(parseFloat); return [p[0], p[1], p[2]]; }
    return d;
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rgb(c, a) { return a == null ? 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')' : 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + a + ')'; }
  function hsl(h, s, l) {
    s /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; }, a = s * Math.min(l, 1 - l);
    var f = function (n) { return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }
  function lum(c) { return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
  function readTheme() {
    if (!S) return;
    var cs = getComputedStyle(S.panel), v = function (n) { return cs.getPropertyValue(n); };
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var dark = lum(bg) < 0.45;
    S.th = { dark: dark, bg: bg, text: tx, accent: ac, font: (v('--font-mono') || '').trim() || 'ui-monospace, Menlo, Consolas, monospace' };
    S.layerKey = '';
  }
  function biomePal(biome) {
    var B = D.BIOMES[biome] || D.BIOMES.crypt, dk = S.th.dark, bg = S.th.bg;
    var P = {
      fog: dk ? [8, 8, 12] : mix(bg, [60, 50, 40], 0.08),
      floor: dk ? hsl(B.hue, B.sat, 15) : hsl(B.hue, B.sat * 0.7, 84),
      floor2: dk ? hsl(B.hue, B.sat, 18) : hsl(B.hue, B.sat * 0.7, 80),
      speck: dk ? hsl(B.hue, B.sat, 24) : hsl(B.hue, B.sat * 0.6, 70),
      wall: dk ? hsl(B.wallHue, B.sat * 0.8, 30) : hsl(B.wallHue, B.sat * 0.6, 52),
      wallTop: dk ? hsl(B.wallHue, B.sat * 0.8, 38) : hsl(B.wallHue, B.sat * 0.6, 62),
      wallFace: dk ? hsl(B.wallHue, B.sat * 0.8, 20) : hsl(B.wallHue, B.sat * 0.6, 40),
      line: dk ? hsl(B.wallHue, B.sat * 0.8, 16) : hsl(B.wallHue, B.sat * 0.6, 36),
      water: dk ? [26, 70, 104] : [120, 180, 220], deep: dk ? [12, 34, 66] : [60, 120, 180],
      lava: [226, 88, 30], lava2: [255, 190, 70], chasm: dk ? [2, 2, 6] : [40, 34, 50],
      fungus: dk ? hsl(300, 40, 40) : hsl(300, 40, 55), fungus2: dk ? hsl(160, 50, 45) : hsl(160, 45, 40),
      door: dk ? [120, 82, 46] : [150, 104, 60], gate: dk ? [150, 150, 165] : [80, 80, 95],
      accent: parseCol(B.accent, [200, 180, 100])
    };
    return P;
  }

  // ===========================================================================
  //  layout — size the stage from the room the panel has
  // ===========================================================================
  function layout() {
    if (!S) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.width && vv.scale <= 1.01) vw = Math.min(vw, vv.width);
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 600, solo = S.panel.classList.contains('cade-solo-panel');
    var W = Math.floor(Math.min(vw - (phone ? (solo ? 16 : 26) : 48), solo ? 760 : 600));
    W = Math.max(280, W);
    S.panel.style.setProperty('--cr-w', W + 'px');
    var r = S.panel.getBoundingClientRect();
    var top = r.height ? Math.min(Math.max(0, r.top), 140) : 60;
    var mx = getComputedStyle(S.panel).maxHeight, mh = /px$/.test(mx) ? parseFloat(mx) : 0;
    var room = vh - top - 8; if (mh > 0) room = Math.min(room, mh);
    var head = S.panel.querySelector('.cade-panel-head'), hh = head ? head.getBoundingClientRect().height || 36 : 36;
    var chrome = hh + (S.hudEl.offsetHeight || 40) + (S.abilEl.offsetHeight || 54) + (S.padEl.offsetHeight || 140) + 30;
    var H = Math.floor(Math.max(200, Math.min(room - chrome, W * 1.35)));
    if (!phone) H = Math.max(260, Math.min(H, 560));
    var dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    var ts = clamp(Math.floor(W / (phone ? 11 : 15)), 26, 44);
    S.cw = W; S.chh = H; S.dpr = dpr; S.ts = ts;
    S.cv.style.width = W + 'px'; S.cv.style.height = H + 'px';
    S.stage.style.height = H + 'px';
    S.cv.width = Math.round(W * dpr); S.cv.height = Math.round(H * dpr);
    S.layerKey = '';
    S.lay = { chrome: chrome };
  }
  function relayoutIfMoved() {
    if (!S || !S.lay || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var head = S.panel.querySelector('.cade-panel-head'), hh = head ? head.getBoundingClientRect().height || 36 : 36;
    var chrome = hh + (S.hudEl.offsetHeight || 40) + (S.abilEl.offsetHeight || 54) + (S.padEl.offsetHeight || 140) + 30;
    if (Math.abs(chrome - S.lay.chrome) > 2) layout();
  }

  // ===========================================================================
  //  renderer
  // ===========================================================================
  function th(x, y) { var h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  var T = null;  // tile codes (from the engine)
  function buildLayer() {
    var G = S.G, ts = S.ts, dpr = S.dpr, tp = Math.round(ts * dpr);
    var key = G.biome + '|' + tp + '|' + (S.th.dark ? 1 : 0) + '|' + S.tilesSig;
    if (S.layerKey === key && S.layer) return;
    S.layerKey = key;
    if (!S.layer) S.layer = document.createElement('canvas');
    var L = S.layer; L.width = G.w * tp; L.height = G.h * tp;
    var c = L.getContext('2d'), P = biomePal(G.biome); S.pal = P;
    c.fillStyle = rgb(P.fog); c.fillRect(0, 0, L.width, L.height);
    for (var y = 0; y < G.h; y++) for (var x = 0; x < G.w; x++) drawTile(c, G, P, x, y, tp);
  }
  function tileAt(G, x, y) { return x < 0 || y < 0 || x >= G.w || y >= G.h ? 0 : G.t[y * G.w + x]; }
  function drawFloor(c, P, x, y, s) {
    var X = x * s, Y = y * s, r = th(x, y);
    c.fillStyle = rgb(r < 0.5 ? P.floor : P.floor2); c.fillRect(X, Y, s, s);
    c.fillStyle = rgb(P.speck, 0.55);
    for (var i = 0; i < 3; i++) { var rx = th(x * 3 + i, y * 7 - i), ry = th(y * 5 + i, x * 11 + i); if (rx < 0.75) c.fillRect(X + rx * s * 0.9, Y + ry * s * 0.9, Math.max(1, s * 0.05), Math.max(1, s * 0.05)); }
    c.strokeStyle = rgb(P.speck, 0.25); c.lineWidth = Math.max(1, s * 0.03); c.strokeRect(X + 0.5, Y + 0.5, s - 1, s - 1);
  }
  function drawTile(c, G, P, x, y, s) {
    var t = tileAt(G, x, y), X = x * s, Y = y * s;
    if (t === T.WALL || t === T.CRACK) {
      var below = tileAt(G, x, y + 1), open = below !== T.WALL && below !== T.CRACK && y + 1 < G.h;
      var near = false; for (var k = 0; k < 8 && !near; k++) { var d = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]][k], nt = tileAt(G, x + d[0], y + d[1]); if (nt !== T.WALL && nt !== T.CRACK && x + d[0] >= 0 && y + d[1] >= 0 && x + d[0] < G.w && y + d[1] < G.h) near = true; }
      if (!near) { c.fillStyle = rgb(P.fog); c.fillRect(X, Y, s, s); return; }
      c.fillStyle = rgb(P.wallTop); c.fillRect(X, Y, s, s);
      // bricks
      c.strokeStyle = rgb(P.line, 0.7); c.lineWidth = Math.max(1, s * 0.04);
      var rows = 3, bh = s / rows;
      for (var rr = 0; rr < rows; rr++) {
        var yy = Y + rr * bh; c.beginPath(); c.moveTo(X, yy); c.lineTo(X + s, yy); c.stroke();
        var off = (rr + x) % 2 ? s / 2 : 0; c.beginPath(); c.moveTo(X + off + s / 4, yy); c.lineTo(X + off + s / 4, yy + bh); c.stroke();
      }
      if (open) { c.fillStyle = rgb(P.wallFace); c.fillRect(X, Y + s * 0.62, s, s * 0.38); c.fillStyle = rgb(P.line, 0.5); c.fillRect(X, Y + s * 0.62, s, Math.max(1, s * 0.05)); }
      if (t === T.CRACK) { c.strokeStyle = rgb(P.fog, 0.9); c.lineWidth = Math.max(1, s * 0.06); c.beginPath(); c.moveTo(X + s * 0.3, Y + s * 0.1); c.lineTo(X + s * 0.5, Y + s * 0.45); c.lineTo(X + s * 0.38, Y + s * 0.6); c.lineTo(X + s * 0.62, Y + s * 0.9); c.stroke(); }
      return;
    }
    if (t === T.CHASM) {
      c.fillStyle = rgb(P.chasm); c.fillRect(X, Y, s, s);
      if (tileAt(G, x, y - 1) !== T.CHASM) { var gr = c.createLinearGradient(0, Y, 0, Y + s * 0.5); gr.addColorStop(0, rgb(P.wallFace, 0.9)); gr.addColorStop(1, rgb(P.chasm, 0)); c.fillStyle = gr; c.fillRect(X, Y, s, s * 0.5); }
      return;
    }
    if (t === T.DEEP) { c.fillStyle = rgb(P.deep); c.fillRect(X, Y, s, s); return; }
    if (t === T.WATER) { c.fillStyle = rgb(P.water); c.fillRect(X, Y, s, s); return; }
    if (t === T.LAVA) { c.fillStyle = rgb(P.lava); c.fillRect(X, Y, s, s); return; }
    drawFloor(c, P, x, y, s);
    if (t === T.STAIRS) {
      for (var i = 0; i < 4; i++) { var ins = s * (0.12 + i * 0.09); c.fillStyle = rgb(mix(P.floor, P.fog, 0.25 + i * 0.2)); c.fillRect(X + ins, Y + ins, s - ins * 2, s - ins * 2); }
      c.strokeStyle = rgb(P.accent); c.lineWidth = Math.max(1, s * 0.05); c.strokeRect(X + s * 0.12, Y + s * 0.12, s * 0.76, s * 0.76);
    } else if (t === T.DOOR || t === T.ODOOR) {
      var hz = tileAt(G, x - 1, y) === T.WALL && tileAt(G, x + 1, y) === T.WALL;
      c.fillStyle = rgb(P.wallFace);
      if (hz) { c.fillRect(X, Y, s * 0.14, s); c.fillRect(X + s * 0.86, Y, s * 0.14, s); } else { c.fillRect(X, Y, s, s * 0.14); c.fillRect(X, Y + s * 0.86, s, s * 0.14); }
      if (t === T.DOOR) {
        c.fillStyle = rgb(P.door);
        if (hz) c.fillRect(X + s * 0.14, Y + s * 0.18, s * 0.72, s * 0.64); else c.fillRect(X + s * 0.18, Y + s * 0.14, s * 0.64, s * 0.72);
        c.strokeStyle = rgb(mix(P.door, [0, 0, 0], 0.4)); c.lineWidth = Math.max(1, s * 0.04);
        for (var j = 1; j < 3; j++) { c.beginPath(); if (hz) { c.moveTo(X + s * 0.14 + j * s * 0.24, Y + s * 0.18); c.lineTo(X + s * 0.14 + j * s * 0.24, Y + s * 0.82); } else { c.moveTo(X + s * 0.18, Y + s * 0.14 + j * s * 0.24); c.lineTo(X + s * 0.82, Y + s * 0.14 + j * s * 0.24); } c.stroke(); }
        c.fillStyle = rgb([230, 200, 120]); c.beginPath(); c.arc(X + s * (hz ? 0.7 : 0.5), Y + s * (hz ? 0.5 : 0.7), s * 0.05, 0, 7); c.fill();
      }
    } else if (t === T.GATE || t === T.OGATE) {
      c.strokeStyle = rgb(P.gate); c.lineWidth = Math.max(1.5, s * 0.08);
      var n = 4;
      for (var b = 0; b < n; b++) { var bx = X + s * (0.15 + b * 0.7 / (n - 1)); c.beginPath(); c.moveTo(bx, Y + (t === T.OGATE ? s * 0.02 : s * 0.05)); c.lineTo(bx, Y + (t === T.OGATE ? s * 0.2 : s * 0.95)); c.stroke(); }
      if (t === T.GATE) { c.beginPath(); c.moveTo(X + s * 0.08, Y + s * 0.3); c.lineTo(X + s * 0.92, Y + s * 0.3); c.moveTo(X + s * 0.08, Y + s * 0.7); c.lineTo(X + s * 0.92, Y + s * 0.7); c.stroke(); }
    } else if (t === T.FUNGUS) {
      for (var f = 0; f < 3; f++) {
        var fx = X + s * (0.2 + th(x + f, y * 3) * 0.6), fy = Y + s * (0.35 + th(y + f, x * 5) * 0.45), fr = s * (0.12 + th(x * f, y) * 0.12);
        c.fillStyle = rgb(mix(P.floor, [240, 230, 220], 0.4)); c.fillRect(fx - fr * 0.25, fy, fr * 0.5, fr * 1.2);
        c.fillStyle = rgb(f % 2 ? P.fungus : P.fungus2); c.beginPath(); c.arc(fx, fy, fr, Math.PI, 0); c.fill();
      }
    }
  }

  // ---- per-frame -----------------------------------------------------------------
  function camTarget() {
    var G = S.G, vp = S.vis[0] || { x: G.p.x, y: G.p.y }, cols = S.cw / S.ts, rows = S.chh / S.ts;
    var cx = vp.x + 0.5 - cols / 2, cy = vp.y + 0.5 - rows / 2;
    if (G.w <= cols) cx = (G.w - cols) / 2; else cx = clamp(cx, -0.5, G.w - cols + 0.5);
    if (G.h <= rows) cy = (G.h - rows) / 2; else cy = clamp(cy, -0.5, G.h - rows + 0.5);
    return { x: cx, y: cy };
  }
  function updateVis(dt) {
    var G = S.G, k = 1 - Math.exp(-dt * 20), seen = {};
    function upd(id, x, y) {
      seen[id] = 1;
      var v = S.vis[id];
      if (!v || Math.abs(v.x - x) + Math.abs(v.y - y) > 6) { S.vis[id] = { x: x, y: y }; return; }
      v.x += (x - v.x) * k; v.y += (y - v.y) * k;
      if (Math.abs(v.x - x) < 0.01) v.x = x; if (Math.abs(v.y - y) < 0.01) v.y = y;
    }
    upd(0, G.p.x, G.p.y);
    G.mons.forEach(function (m) { upd(m.id, m.x, m.y); });
    for (var id in S.vis) if (!seen[id]) delete S.vis[id];
  }
  function frame(t) {
    if (!S) return;
    S.raf = 0;
    if (!S.cv.isConnected) return;
    if (document.hidden || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var dt = S.lastT ? Math.min(0.05, (t - S.lastT) / 1000) : 0.016; S.lastT = t;
    S.time = t;
    tickAuto(t);
    if (S.G) draw(dt, t); else drawIdle(dt, t);
    S.raf = requestAnimationFrame(frame);
  }
  function startLoop() { if (S && !S.raf) { S.lastT = 0; S.raf = requestAnimationFrame(frame); } }

  function drawIdle(dt, t) {
    // the town / title backdrop: a starry rim, the Sunstone, the shaft
    var c = S.ctx, W = S.cw, H = S.chh, dpr = S.dpr, dk = S.th.dark;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var sky = c.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, dk ? '#0b1020' : rgb(mix(S.th.bg, [120, 150, 200], 0.25)));
    sky.addColorStop(1, dk ? '#1a1424' : rgb(mix(S.th.bg, [230, 190, 140], 0.35)));
    c.fillStyle = sky; c.fillRect(0, 0, W, H);
    for (var i = 0; i < 60; i++) { var sx = th(i, 3) * W, sy = th(i, 9) * H * 0.55, tw = 0.4 + 0.6 * Math.abs(Math.sin(t / 900 + i)); c.fillStyle = dk ? 'rgba(255,255,240,' + (0.25 + 0.5 * tw) + ')' : 'rgba(255,255,255,' + 0.5 * tw + ')'; c.fillRect(sx, sy, 1.5, 1.5); }
    var hero = S.hero, cleared = hero ? (hero.story.ended ? 5 : hero.story.cleared) : 0, glow = 0.35 + cleared * 0.13;
    var gx = W * 0.5, gy = H * 0.3, R = Math.min(W, H) * (0.25 + cleared * 0.03);
    var gr = c.createRadialGradient(gx, gy, 0, gx, gy, R);
    gr.addColorStop(0, 'rgba(255,230,150,' + glow + ')'); gr.addColorStop(1, 'rgba(255,200,100,0)');
    c.fillStyle = gr; c.fillRect(0, 0, W, H);
    // town silhouette
    c.fillStyle = dk ? '#06070c' : rgb(mix(S.th.bg, [40, 40, 60], 0.55));
    c.beginPath(); c.moveTo(0, H * 0.72);
    var bx = 0; for (i = 0; bx < W; i++) { var bw = 24 + th(i, 1) * 40, bh = 30 + th(i, 2) * 50; c.lineTo(bx, H * 0.72 - bh); c.lineTo(bx + bw * 0.5, H * 0.72 - bh - 14); c.lineTo(bx + bw, H * 0.72 - bh); bx += bw; }
    c.lineTo(W, H); c.lineTo(0, H); c.fill();
    // the tower + Sunstone
    c.fillRect(gx - 9, gy, 18, H * 0.5); c.beginPath(); c.arc(gx, gy, 8 + Math.sin(t / 400) * 1.5, 0, 7); c.fillStyle = 'rgba(255,236,170,' + (0.6 + glow * 0.4) + ')'; c.fill();
    // windows
    for (i = 0; i < 18; i++) { var wx = th(i, 5) * W, wy = H * 0.72 - 10 - th(i, 6) * 40; c.fillStyle = 'rgba(255,200,110,' + (0.5 + 0.4 * Math.sin(t / 700 + i)) + ')'; c.fillRect(wx, wy, 3, 4); }
    // the shaft
    c.fillStyle = '#000'; c.beginPath(); c.ellipse(W * 0.5, H * 0.9, W * 0.22, H * 0.05, 0, 0, 7); c.fill();
  }

  function draw(dt, t) {
    var G = S.G, c = S.ctx, dpr = S.dpr, ts = S.ts, W = S.cw, H = S.chh;
    if (S.tilesDirty) { S.tilesSig = G.t.join(''); S.tilesDirty = false; }
    buildLayer();
    updateVis(dt);
    var ct = camTarget();
    if (!S.cam || S.snapCam) { S.cam = { x: ct.x, y: ct.y }; S.snapCam = false; }
    var kc = 1 - Math.exp(-dt * 10); S.cam.x += (ct.x - S.cam.x) * kc; S.cam.y += (ct.y - S.cam.y) * kc;
    var shx = 0, shy = 0;
    if (S.shake > 0.1) { shx = (Math.random() - 0.5) * S.shake; shy = (Math.random() - 0.5) * S.shake; S.shake *= Math.pow(0.002, dt); } else S.shake = 0;
    var ox = -S.cam.x * ts + shx, oy = -S.cam.y * ts + shy;
    S.ox = ox; S.oy = oy;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var P = S.pal;
    c.fillStyle = rgb(P.fog); c.fillRect(0, 0, W, H);
    // static layer
    var tp = Math.round(ts * dpr), sx = -ox / ts * tp, sy = -oy / ts * tp;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(S.layer, Math.round(-sx), Math.round(-sy));
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var x0 = Math.max(0, Math.floor(S.cam.x - 1)), y0 = Math.max(0, Math.floor(S.cam.y - 1)), x1 = Math.min(G.w - 1, Math.ceil(S.cam.x + W / ts + 1)), y1 = Math.min(G.h - 1, Math.ceil(S.cam.y + H / ts + 1));
    var vis = G.vis, seen = G.seen, w = G.w;
    // animated terrain + ground effects
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
      var i = y * w + x; if (!seen[i]) continue;
      var tt = G.t[i], X = ox + x * ts, Y = oy + y * ts;
      if (tt === T.WATER || tt === T.DEEP) {
        c.strokeStyle = S.th.dark ? 'rgba(160,210,255,0.22)' : 'rgba(255,255,255,0.5)'; c.lineWidth = 1;
        var ph = t / 700 + x * 0.7 + y * 0.4;
        for (var wv = 0; wv < 2; wv++) { var wy = Y + ts * (0.3 + wv * 0.4) + Math.sin(ph + wv) * ts * 0.06; c.beginPath(); c.moveTo(X + ts * 0.15, wy); c.quadraticCurveTo(X + ts * 0.5, wy - ts * 0.1, X + ts * 0.85, wy); c.stroke(); }
      } else if (tt === T.LAVA) {
        var pl = 0.5 + 0.5 * Math.sin(t / 500 + x * 1.3 + y * 0.7);
        c.fillStyle = 'rgba(255,200,80,' + (0.25 + pl * 0.35) + ')';
        c.beginPath(); c.arc(X + ts * (0.3 + th(x, y) * 0.4), Y + ts * (0.3 + th(y, x) * 0.4), ts * (0.12 + pl * 0.1), 0, 7); c.fill();
      } else if (tt === T.PORTAL) {
        var a = t / 300;
        for (var ring = 0; ring < 3; ring++) { c.strokeStyle = 'rgba(160,200,255,' + (0.8 - ring * 0.22) + ')'; c.lineWidth = 2; c.beginPath(); c.arc(X + ts / 2, Y + ts / 2, ts * (0.15 + ring * 0.12), a + ring, a + ring + 4.4); c.stroke(); }
      }
      if (!vis[i]) continue;
      var gz = G.gas[i]; if (gz) { c.fillStyle = 'rgba(130,220,90,' + Math.min(0.5, 0.15 + gz.t * 0.07) + ')'; c.beginPath(); c.arc(X + ts / 2 + Math.sin(t / 600 + x) * ts * 0.1, Y + ts / 2 + Math.cos(t / 700 + y) * ts * 0.1, ts * 0.55, 0, 7); c.fill(); }
      var fi = G.fire[i]; if (fi) { var fl = 0.6 + 0.4 * Math.sin(t / 90 + x * 3 + y); c.fillStyle = 'rgba(255,' + Math.round(120 + fl * 80) + ',40,' + (0.35 + 0.2 * fl) + ')'; c.beginPath(); c.moveTo(X + ts * 0.2, Y + ts * 0.9); c.quadraticCurveTo(X + ts * 0.5, Y + ts * (0.1 + 0.2 * fl), X + ts * 0.8, Y + ts * 0.9); c.fill(); }
      var hy = G.holy[i]; if (hy) { c.fillStyle = 'rgba(255,230,140,' + (0.18 + 0.08 * Math.sin(t / 300 + x + y)) + ')'; c.fillRect(X + 1, Y + 1, ts - 2, ts - 2); }
    }
    // deco + objects
    G.deco.forEach(function (d) { var i2 = d.y * w + d.x; if (seen[i2] && d.x >= x0 && d.x <= x1 && d.y >= y0 && d.y <= y1) drawDeco(c, d, ox + d.x * ts, oy + d.y * ts, ts); });
    G.objs.forEach(function (o) {
      if (o.x < x0 || o.x > x1 || o.y < y0 || o.y > y1) return;
      var i3 = o.y * w + o.x; if (!seen[i3]) return;
      var lootish = o.k === 'item' || o.k === 'gold' || o.k === 'cons' || o.k === 'corpse' || o.k === 'snare';
      if (lootish && !vis[i3] && !G.mapped) return;
      if (o.k === 'trap' && o.hidden) return;
      drawObj(c, G, o, ox + o.x * ts, oy + o.y * ts, ts, t, !!vis[i3]);
    });
    // telegraphs (danger tiles)
    drawTelegraphs(c, G, ox, oy, ts, t);
    // targeting
    if (S.tgt) drawTargeting(c, G, ox, oy, ts, t);
    // actors
    var list = G.mons.filter(function (m) { return E.monVisible(G, m) || m.ally && vis[m.y * w + m.x]; });
    list.sort(function (a, b) { return a.y - b.y; });
    list.forEach(function (m) { drawActor(c, G, m, ox, oy, ts, t); });
    drawPlayer(c, G, ox, oy, ts, t);
    // fog + torchlight
    var L = E.lightRadius(G), vp = S.vis[0] || G.p, fogA = S.th.dark ? 0.62 : 0.55;
    for (y = y0; y <= y1; y++) for (x = x0; x <= x1; x++) {
      var j = y * w + x, a2;
      if (!seen[j]) a2 = 1; else if (!vis[j]) a2 = fogA; else { var dd = Math.sqrt((x - vp.x) * (x - vp.x) + (y - vp.y) * (y - vp.y)); a2 = clamp((dd - L * 0.45) / (L * 0.9), 0, 1) * 0.42; }
      if (a2 <= 0.01) continue;
      c.fillStyle = rgb(P.fog, a2); c.fillRect(Math.floor(ox + x * ts), Math.floor(oy + y * ts), Math.ceil(ts) + 1, Math.ceil(ts) + 1);
    }
    drawFx(c, G, ox, oy, ts, t, dt);
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (S.set.mini) drawMini();
  }
  function glyphFont(px, bold) { return (bold ? '700 ' : '') + Math.round(px) + 'px ' + S.th.font; }
  function drawDeco(c, d, X, Y, s) {
    var dk = S.th.dark, ink = dk ? 'rgba(230,220,200,0.28)' : 'rgba(60,50,40,0.35)';
    c.fillStyle = ink; c.strokeStyle = ink; c.lineWidth = Math.max(1, s * 0.05);
    switch (d.k) {
      case 'bones': c.beginPath(); c.moveTo(X + s * 0.25, Y + s * 0.7); c.lineTo(X + s * 0.7, Y + s * 0.55); c.moveTo(X + s * 0.35, Y + s * 0.5); c.lineTo(X + s * 0.6, Y + s * 0.78); c.stroke(); break;
      case 'urn': case 'ingot': case 'books': c.fillRect(X + s * 0.38, Y + s * 0.45, s * 0.24, s * 0.32); break;
      case 'coffin': c.strokeRect(X + s * 0.3, Y + s * 0.2, s * 0.4, s * 0.62); break;
      case 'candle': case 'brazier': c.fillStyle = 'rgba(255,200,90,' + (0.5 + 0.3 * Math.sin(S.time / 200 + X)) + ')'; c.beginPath(); c.arc(X + s * 0.5, Y + s * 0.45, s * 0.08, 0, 7); c.fill(); c.fillStyle = ink; c.fillRect(X + s * 0.46, Y + s * 0.52, s * 0.08, s * 0.25); break;
      case 'shroom': c.fillStyle = 'rgba(220,120,220,0.45)'; c.beginPath(); c.arc(X + s * 0.5, Y + s * 0.6, s * 0.16, Math.PI, 0); c.fill(); break;
      case 'spores': case 'crystal': c.fillStyle = d.k === 'crystal' ? 'rgba(180,140,255,0.5)' : 'rgba(150,230,150,0.4)'; for (var i = 0; i < 3; i++) { c.beginPath(); c.arc(X + s * (0.3 + i * 0.2), Y + s * (0.4 + (i % 2) * 0.25), s * 0.06, 0, 7); c.fill(); } break;
      case 'openchest': c.strokeStyle = dk ? 'rgba(200,160,90,0.45)' : 'rgba(120,80,30,0.5)'; c.strokeRect(X + s * 0.22, Y + s * 0.42, s * 0.56, s * 0.36); break;
      default: c.beginPath(); c.arc(X + s * 0.5, Y + s * 0.6, s * 0.08, 0, 7); c.fill();
    }
  }
  var RUNE_SYM = ['◆', '▲', '●', '■'];
  function rarCol(r) { return (D.RARITIES[r] || D.RARITIES.common).col; }
  function drawObj(c, G, o, X, Y, s, t, lit) {
    var cx = X + s / 2, cy = Y + s / 2;
    switch (o.k) {
      case 'chest':
        c.fillStyle = o.vault ? '#c9a23a' : '#8a5a2a'; c.fillRect(X + s * 0.2, Y + s * 0.38, s * 0.6, s * 0.42);
        c.fillStyle = o.vault ? '#e8c860' : '#a8703a'; c.fillRect(X + s * 0.2, Y + s * 0.3, s * 0.6, s * 0.16);
        c.fillStyle = '#e8d070'; c.fillRect(X + s * 0.46, Y + s * 0.44, s * 0.08, s * 0.12);
        c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 1; c.strokeRect(X + s * 0.2, Y + s * 0.3, s * 0.6, s * 0.5);
        if (lit && o.vault) { c.fillStyle = 'rgba(255,230,120,' + (0.25 + 0.2 * Math.sin(t / 300)) + ')'; c.beginPath(); c.arc(cx, cy, s * 0.5, 0, 7); c.fill(); }
        break;
      case 'boulder':
        var g = c.createRadialGradient(cx - s * 0.12, cy - s * 0.12, s * 0.05, cx, cy, s * 0.42); g.addColorStop(0, '#b8b0a8'); g.addColorStop(1, '#5a544e');
        c.fillStyle = g; c.beginPath(); c.arc(cx, cy, s * 0.4, 0, 7); c.fill(); break;
      case 'plate':
        c.fillStyle = o.on ? rgb(S.th.accent) : (S.th.dark ? '#4a4a52' : '#9a9aa4'); c.fillRect(X + s * 0.18, Y + s * 0.18, s * 0.64, s * 0.64);
        c.strokeStyle = 'rgba(0,0,0,0.4)'; c.strokeRect(X + s * 0.18, Y + s * 0.18, s * 0.64, s * 0.64); break;
      case 'lever':
        c.fillStyle = '#6a6a72'; c.fillRect(X + s * 0.3, Y + s * 0.62, s * 0.4, s * 0.18);
        c.strokeStyle = o.on ? rgb(S.th.accent) : '#c0b090'; c.lineWidth = Math.max(2, s * 0.08); c.beginPath(); c.moveTo(cx, Y + s * 0.66); c.lineTo(cx + (o.on ? s * 0.22 : -s * 0.22), Y + s * 0.24); c.stroke();
        c.fillStyle = o.reset ? '#e07050' : '#d0d0d8'; c.beginPath(); c.arc(cx + (o.on ? s * 0.22 : -s * 0.22), Y + s * 0.24, s * 0.08, 0, 7); c.fill(); break;
      case 'rune':
        c.fillStyle = o.lit ? 'rgba(150,220,255,0.35)' : 'rgba(120,120,160,0.18)'; c.beginPath(); c.arc(cx, cy, s * 0.4, 0, 7); c.fill();
        c.fillStyle = o.lit ? '#bfe8ff' : (S.th.dark ? '#7a7aa0' : '#5a5a80'); c.font = glyphFont(s * 0.5, true); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(RUNE_SYM[o.sym], cx, cy + 1); break;
      case 'tablet':
        c.fillStyle = S.th.dark ? '#8a8a96' : '#7a7a86'; c.fillRect(X + s * 0.25, Y + s * 0.15, s * 0.5, s * 0.7);
        c.fillStyle = 'rgba(0,0,0,0.35)'; for (var l = 0; l < 3; l++) c.fillRect(X + s * 0.32, Y + s * (0.3 + l * 0.16), s * 0.36, s * 0.05); break;
      case 'event':
        var EV = D.EVENTS[o.id];
        c.fillStyle = o.used ? 'rgba(120,120,120,0.3)' : 'rgba(' + parseCol(EV.col, [200, 200, 200]).join(',') + ',' + (0.22 + 0.12 * Math.sin(t / 400)) + ')';
        c.beginPath(); c.arc(cx, cy, s * 0.46, 0, 7); c.fill();
        c.fillStyle = o.used ? '#888' : EV.col; c.font = glyphFont(s * 0.6, true); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(EV.ch, cx, cy + 1); break;
      case 'lore': case 'quest':
        c.fillStyle = o.k === 'quest' ? '#ffd86a' : '#e8dcc0'; c.fillRect(X + s * 0.28, Y + s * 0.25, s * 0.44, s * 0.5);
        c.fillStyle = 'rgba(80,60,30,0.6)'; for (var l2 = 0; l2 < 3; l2++) c.fillRect(X + s * 0.33, Y + s * (0.35 + l2 * 0.12), s * 0.34, s * 0.04);
        c.strokeStyle = 'rgba(255,230,150,' + (0.4 + 0.3 * Math.sin(t / 300)) + ')'; c.lineWidth = 2; c.strokeRect(X + s * 0.24, Y + s * 0.21, s * 0.52, s * 0.58); break;
      case 'trap':
        c.strokeStyle = '#e05050'; c.lineWidth = Math.max(1.5, s * 0.07); c.beginPath();
        for (var k = 0; k < 3; k++) { var bx = X + s * (0.22 + k * 0.2); c.moveTo(bx, Y + s * 0.7); c.lineTo(bx + s * 0.1, Y + s * 0.4); c.lineTo(bx + s * 0.2, Y + s * 0.7); } c.stroke(); break;
      case 'vent':
        var warn = o.ph === 2, col = o.kind === 'flame' ? '255,120,40' : o.kind === 'gas' ? '130,220,90' : o.kind === 'void' ? '180,120,255' : '220,220,220';
        c.fillStyle = S.th.dark ? '#2a2a30' : '#8a8a90'; c.fillRect(X + s * 0.2, Y + s * 0.2, s * 0.6, s * 0.6);
        c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 1; for (var v = 1; v < 4; v++) { c.beginPath(); c.moveTo(X + s * 0.2, Y + s * (0.2 + v * 0.15)); c.lineTo(X + s * 0.8, Y + s * (0.2 + v * 0.15)); c.stroke(); }
        if (warn && lit) { c.fillStyle = 'rgba(' + col + ',' + (0.35 + 0.25 * Math.sin(t / 80)) + ')'; c.fillRect(X, Y, s, s); c.strokeStyle = 'rgba(' + col + ',0.9)'; c.lineWidth = 2; c.strokeRect(X + 1, Y + 1, s - 2, s - 2); }
        break;
      case 'snare':
        c.strokeStyle = '#c0a060'; c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, s * 0.25, 0, 7); c.stroke(); c.beginPath(); c.moveTo(cx - s * 0.25, cy); c.lineTo(cx + s * 0.25, cy); c.stroke(); break;
      case 'corpse':
        c.globalAlpha = 0.35; c.fillStyle = o.col; c.font = glyphFont(s * 0.55, true); c.textAlign = 'center'; c.textBaseline = 'middle';
        c.save(); c.translate(cx, cy + s * 0.1); c.rotate(1.2); c.fillText(o.ch, 0, 0); c.restore(); c.globalAlpha = 1; break;
      case 'gold':
        c.fillStyle = '#f0c840'; for (var gi = 0; gi < 3; gi++) { c.beginPath(); c.ellipse(X + s * (0.38 + gi * 0.12), Y + s * (0.62 - gi * 0.06), s * 0.12, s * 0.07, 0, 0, 7); c.fill(); }
        c.strokeStyle = '#9a7a10'; c.lineWidth = 1; c.stroke(); break;
      case 'cons':
        c.fillStyle = o.id === 'potion' ? '#e05050' : o.id === 'tonic' ? '#5080e0' : o.id === 'bomb' ? '#404048' : o.id === 'recall' || o.id === 'mapping' ? '#e8dcc0' : '#70d0a0';
        c.beginPath(); c.arc(cx, cy + s * 0.08, s * 0.18, 0, 7); c.fill(); c.fillRect(cx - s * 0.06, cy - s * 0.22, s * 0.12, s * 0.16); break;
      case 'item':
        var rc = rarCol(o.it.rarity);
        c.fillStyle = 'rgba(' + parseCol(rc, [200, 200, 200]).join(',') + ',' + (0.2 + 0.15 * Math.sin(t / 250 + o.x)) + ')'; c.beginPath(); c.arc(cx, cy, s * 0.42, 0, 7); c.fill();
        c.fillStyle = rc; c.font = glyphFont(s * 0.5, true); c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText({ weapon: '/', armor: '[', helm: '^', charm: '"' }[o.it.slot] || '*', cx, cy + 1); break;
    }
  }
  function tokenColors(col) { var cc = parseCol(col, [200, 200, 200]); return { fill: cc, ink: lum(cc) > 0.55 ? '#141414' : '#fafafa', edge: rgb(mix(cc, [0, 0, 0], 0.55)) }; }
  function actorPos(id, x, y) {
    var v = S.vis[id] || { x: x, y: y }, l = S.lunge[id], dx = 0, dy = 0;
    if (l) { var k = (S.time - l.t0) / 160; if (k >= 1) delete S.lunge[id]; else { var a = Math.sin(k * Math.PI) * 0.32; dx = l.dx * a; dy = l.dy * a; } }
    return { x: v.x + dx, y: v.y + dy };
  }
  function drawToken(c, X, Y, s, col, ch, o) {
    o = o || {};
    var tc = tokenColors(col), r = s * (o.big ? 0.5 : 0.4), cx = X + s / 2, cy = Y + s / 2 + (o.bob || 0);
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.beginPath(); c.ellipse(cx, Y + s * 0.86, r * 0.85, r * 0.3, 0, 0, 7); c.fill();
    if (o.ring) { c.strokeStyle = o.ring; c.lineWidth = Math.max(2, s * 0.08); c.beginPath(); c.arc(cx, cy, r + s * 0.06, 0, 7); c.stroke(); }
    if (o.ring2) { c.strokeStyle = o.ring2; c.lineWidth = Math.max(1.5, s * 0.05); c.beginPath(); c.arc(cx, cy, r + s * 0.13, 0, 7); c.stroke(); }
    var g = c.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
    g.addColorStop(0, rgb(mix(tc.fill, [255, 255, 255], 0.35))); g.addColorStop(1, rgb(tc.fill));
    c.fillStyle = o.flash ? '#ffffff' : g; c.beginPath(); c.arc(cx, cy, r, 0, 7); c.fill();
    c.strokeStyle = tc.edge; c.lineWidth = Math.max(1, s * 0.05); c.stroke();
    if (o.dashed) { c.setLineDash([3, 3]); c.strokeStyle = '#7fe0a0'; c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, r + 3, 0, 7); c.stroke(); c.setLineDash([]); }
    c.fillStyle = o.flash ? '#000' : tc.ink; c.font = glyphFont(r * 1.25, true); c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(ch, cx, cy + r * 0.06);
  }
  function hpBar(c, X, Y, s, frac, col, sh) {
    var w = s * 0.76, x = X + s * 0.12, y = Y + s * 0.92;
    c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(x - 1, y - 1, w + 2, 5);
    c.fillStyle = col; c.fillRect(x, y, w * clamp(frac, 0, 1), 3);
    if (sh) { c.fillStyle = '#9fd8ff'; c.fillRect(x, y - 3, w * clamp(sh, 0, 1), 2); }
  }
  function statusDots(c, a, X, Y, s, t) {
    var st = a.st, cols = [], k;
    if (st.poison) cols.push('#7ae07a'); if (st.burn) cols.push('#ff8a3a'); if (st.bleed) cols.push('#e04a4a'); if (st.frozen) cols.push('#9fdcff');
    if (st.stun) cols.push('#ffe06a'); if (st.root) cols.push('#c0a060'); if (st.weaken) cols.push('#a08ac0'); if (st.mark) cols.push('#ff5a9a'); if (st.slow) cols.push('#6a8ad0');
    for (k = 0; k < cols.length; k++) { c.fillStyle = cols[k]; c.beginPath(); c.arc(X + s * 0.15 + k * s * 0.14, Y + s * 0.1, s * 0.06, 0, 7); c.fill(); }
    if (st.frozen) { c.fillStyle = 'rgba(160,220,255,0.35)'; c.fillRect(X + s * 0.1, Y + s * 0.1, s * 0.8, s * 0.8); }
    if (st.stun) { c.fillStyle = '#ffe06a'; c.font = glyphFont(s * 0.3, true); c.fillText('✶', X + s * 0.5 + Math.sin(t / 150) * s * 0.2, Y + s * 0.02); }
  }
  function drawActor(c, G, m, ox, oy, s, t) {
    var p = actorPos(m.id, m.x, m.y), X = ox + p.x * s, Y = oy + p.y * s;
    var flash = S.flash[m.id] && S.time - S.flash[m.id] < 110;
    var ring = null, ring2 = null;
    if (m.elite) { ring = D.ELITE[m.elite[0]].col; if (m.elite[1]) ring2 = D.ELITE[m.elite[1]].col; }
    if (m.boss) { ring = '#ffd86a'; ring2 = '#b04040'; }
    var bob = (m.asleep ? 0 : Math.sin(t / 260 + m.id) * s * 0.025);
    if (m.k === 'shade' && !m.revealed) c.globalAlpha = 0.6;
    drawToken(c, X, Y, s, m.col, m.ch, { ring: ring, ring2: ring2, big: !!m.boss, flash: flash, bob: bob, dashed: m.ally });
    c.globalAlpha = 1;
    if (m.st.shield && m.st.shield.v > 0) { c.strokeStyle = 'rgba(140,200,255,0.8)'; c.lineWidth = 2; c.beginPath(); c.arc(X + s / 2, Y + s / 2, s * 0.52, 0, 7); c.stroke(); }
    if (m.hp < m.maxHp || m.elite || m.boss) hpBar(c, X, Y, s, m.hp / m.maxHp, m.ally ? '#7fe0a0' : m.elite ? '#ffb040' : '#e04a4a');
    statusDots(c, m, X, Y, s, t);
    if (m.asleep) { c.fillStyle = S.th.dark ? '#c0c8ff' : '#5060a0'; c.font = glyphFont(s * 0.3, true); c.textAlign = 'center'; c.fillText('z', X + s * 0.85, Y + s * 0.1 - ((t / 40) % 10) * 0.6); }
    if (m.intent) { c.fillStyle = '#ff4040'; c.font = glyphFont(s * 0.45, true); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('!', X + s * 0.85, Y + s * 0.05 + Math.sin(t / 90) * 2); }
    if (S.G.p.target === m.id && !m.ally) { c.strokeStyle = rgb(S.th.accent); c.lineWidth = 2; var q = s * 0.08, e = s * 0.25; [[X + q, Y + q, 1, 1], [X + s - q, Y + q, -1, 1], [X + q, Y + s - q, 1, -1], [X + s - q, Y + s - q, -1, -1]].forEach(function (b) { c.beginPath(); c.moveTo(b[0], b[1] + e * b[3]); c.lineTo(b[0], b[1]); c.lineTo(b[0] + e * b[2], b[1]); c.stroke(); }); }
  }
  function drawPlayer(c, G, ox, oy, s, t) {
    var p = actorPos(0, G.p.x, G.p.y), X = ox + p.x * s, Y = oy + p.y * s, cls = D.CLASSES[G.hero.cls];
    // torch glow under the hero
    var gl = c.createRadialGradient(X + s / 2, Y + s / 2, 0, X + s / 2, Y + s / 2, s * 1.6);
    gl.addColorStop(0, S.th.dark ? 'rgba(255,200,120,0.16)' : 'rgba(255,220,150,0.18)'); gl.addColorStop(1, 'rgba(255,200,120,0)');
    c.fillStyle = gl; c.fillRect(X - s * 1.2, Y - s * 1.2, s * 3.4, s * 3.4);
    if (G.p.st.invis) c.globalAlpha = 0.45;
    var flash = S.flash[0] && S.time - S.flash[0] < 110;
    drawToken(c, X, Y, s, cls.color, '@', { flash: flash, ring: G.p.st.unbreak ? '#ffb070' : G.p.st.inv ? '#9fdcff' : null, bob: Math.sin(t / 300) * s * 0.02 });
    c.globalAlpha = 1;
    // facing pip
    var f = G.p.face || [0, 1]; c.fillStyle = cls.color; c.beginPath(); c.arc(X + s / 2 + f[0] * s * 0.48, Y + s / 2 + f[1] * s * 0.48, s * 0.06, 0, 7); c.fill();
    if (G.p.st.shield && G.p.st.shield.v > 0) { c.strokeStyle = 'rgba(255,230,140,' + (0.6 + 0.3 * Math.sin(t / 200)) + ')'; c.lineWidth = 2.5; c.beginPath(); c.arc(X + s / 2, Y + s / 2, s * 0.54, 0, 7); c.stroke(); }
    statusDots(c, G.p, X, Y, s, t);
  }
  function drawTelegraphs(c, G, ox, oy, s, t) {
    var pulse = 0.5 + 0.5 * Math.sin(t / 110);
    G.mons.forEach(function (m) {
      if (!m.intent) return;
      var col = m.ally ? '120,220,140' : m.intent.elem === 'poison' ? '120,220,80' : m.intent.elem === 'wave' ? '80,170,255' : m.intent.elem === 'void' ? '180,110,255' : '255,60,50';
      m.intent.tiles.forEach(function (q) {
        if (!G.seen[q[1] * G.w + q[0]]) return;
        var X = ox + q[0] * s, Y = oy + q[1] * s;
        c.fillStyle = 'rgba(' + col + ',' + (0.18 + 0.22 * pulse) + ')'; c.fillRect(X + 1, Y + 1, s - 2, s - 2);
        c.strokeStyle = 'rgba(' + col + ',0.85)'; c.lineWidth = 1.5; c.strokeRect(X + 2, Y + 2, s - 4, s - 4);
        if (m.intent.t > 1) { c.fillStyle = 'rgba(' + col + ',0.95)'; c.font = glyphFont(s * 0.36, true); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(m.intent.t), X + s / 2, Y + s / 2); }
      });
    });
    G.delayed.forEach(function (e) {
      for (var y = e.y - e.rad; y <= e.y + e.rad; y++) for (var x = e.x - e.rad; x <= e.x + e.rad; x++) {
        var X = ox + x * s, Y = oy + y * s;
        c.fillStyle = 'rgba(255,150,40,' + (0.2 + 0.2 * pulse) + ')'; c.fillRect(X + 1, Y + 1, s - 2, s - 2);
      }
    });
  }
  function drawTargeting(c, G, ox, oy, s, t) {
    var tg = S.tgt;
    tg.list.forEach(function (q) { var X = ox + q.x * s, Y = oy + q.y * s; c.fillStyle = rgb(S.th.accent, 0.13); c.fillRect(X + 1, Y + 1, s - 2, s - 2); });
    if (!tg.cur) return;
    var rad = tg.radius || 0, ok = tg.list.some(function (q) { return q.x === tg.cur.x && q.y === tg.cur.y; });
    for (var y = tg.cur.y - rad; y <= tg.cur.y + rad; y++) for (var x = tg.cur.x - rad; x <= tg.cur.x + rad; x++) {
      var X = ox + x * s, Y = oy + y * s; c.fillStyle = ok ? rgb(S.th.accent, 0.28) : 'rgba(200,60,60,0.25)'; c.fillRect(X + 1, Y + 1, s - 2, s - 2);
    }
    if (tg.line) { var ln = lineTo(G, tg.cur.x, tg.cur.y, tg.range); c.fillStyle = rgb(S.th.accent, 0.25); ln.forEach(function (q) { c.fillRect(ox + q[0] * s + 2, oy + q[1] * s + 2, s - 4, s - 4); }); }
    var X2 = ox + tg.cur.x * s, Y2 = oy + tg.cur.y * s, pad = 2 + Math.sin(t / 150) * 2;
    c.strokeStyle = ok ? rgb(S.th.accent) : '#e04040'; c.lineWidth = 2.5; c.strokeRect(X2 - pad, Y2 - pad, s + pad * 2, s + pad * 2);
  }
  function lineTo(G, tx, ty, R) {
    var out = [], x0 = G.p.x, y0 = G.p.y, dx = tx - x0, dy = ty - y0, n = Math.max(Math.abs(dx), Math.abs(dy));
    if (!n) return out;
    for (var i = 1; i <= R; i++) { var x = Math.round(x0 + dx / n * i), y = Math.round(y0 + dy / n * i); if (x < 0 || y < 0 || x >= G.w || y >= G.h || E.OPAQUE[G.t[y * G.w + x]]) break; out.push([x, y]); }
    return out;
  }
