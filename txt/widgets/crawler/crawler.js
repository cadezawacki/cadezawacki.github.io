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
  function saveNow(force) {
    if (!S || !S.R) return;
    S.dirty = false;
    if (S.G && S.G.mode === 'story') E.syncHero(S.G);
    var h = S.R.slots[S.R.active]; if (h) { h.rev = (h.rev || 1) + 1; h.updated = Date.now(); h.client = S.client; }
    S.R.rev = (S.R.rev || 0) + 1; S.R.client = S.client;
    var json = JSON.stringify(S.R);
    sset(K_ROSTER, json);
    var db = fbDb(); if (!db) return;
    // mid-delve the cloud copy is refreshed at most every 15 s (and always on the way out)
    var tnow = Date.now();
    if (!force && S.G && S.lastFb && tnow - S.lastFb < 15000) { if (!S.fbT) S.fbT = setTimeout(function () { if (S) { S.fbT = 0; saveNow(true); } }, 15000 - (tnow - S.lastFb)); return; }
    S.lastFb = tnow; if (S.fbT) { clearTimeout(S.fbT); S.fbT = 0; }
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
      snap.savedAt = Date.now();
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
      fog: dk ? [8, 8, 12] : mix(bg, [96, 80, 60], 0.3),
      floor: dk ? hsl(B.hue, B.sat, 21) : hsl(B.hue, B.sat * 0.6 + 10, 90),
      floor2: dk ? hsl(B.hue, B.sat, 24) : hsl(B.hue, B.sat * 0.6 + 10, 86),
      speck: dk ? hsl(B.hue, B.sat, 31) : hsl(B.hue, B.sat * 0.5 + 8, 74),
      wall: dk ? hsl(B.wallHue, B.sat * 0.8, 34) : hsl(B.wallHue, B.sat * 0.5 + 8, 40),
      wallTop: dk ? hsl(B.wallHue, B.sat * 0.8, 42) : hsl(B.wallHue, B.sat * 0.5 + 8, 46),
      wallFace: dk ? hsl(B.wallHue, B.sat * 0.8, 24) : hsl(B.wallHue, B.sat * 0.5 + 8, 30),
      line: dk ? hsl(B.wallHue, B.sat * 0.8, 16) : hsl(B.wallHue, B.sat * 0.5 + 8, 30),
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
    var ts = clamp(Math.floor(W / (phone ? 13 : 17)), 24, 44);
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
    if (S.G && !S.screen) draw(dt, t);
    if (S.sceneCv && S.sceneCv.isConnected) drawIdle(S.sceneCv, t);
    S.raf = requestAnimationFrame(frame);
  }
  function startLoop() { if (S && !S.raf) { S.lastT = 0; S.raf = requestAnimationFrame(frame); } }

  function drawIdle(cv, t) {
    // the town / title backdrop: a starry rim, the Sunstone, the shaft
    var c = cv.getContext('2d'), dpr = S.dpr, W = cv.width / dpr, H = cv.height / dpr, dk = S.th.dark;
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
    // the tower + Sunstone
    var sil = dk ? '#06070c' : rgb(mix(S.th.bg, [40, 40, 60], 0.6)), hz = H * 0.8;
    c.fillStyle = sil; c.fillRect(gx - 7, gy + 6, 14, hz - gy); c.beginPath(); c.moveTo(gx - 11, gy + 8); c.lineTo(gx, gy - 4); c.lineTo(gx + 11, gy + 8); c.fill();
    c.beginPath(); c.arc(gx, gy, 6 + Math.sin(t / 400) * 1.2, 0, 7); c.fillStyle = 'rgba(255,236,170,' + (0.7 + glow * 0.3) + ')'; c.fill();
    // rooftops, leaving a gap for the shaft
    c.fillStyle = sil; c.beginPath(); c.moveTo(0, H);
    var bx = 0; for (i = 0; bx < W; i++) { var bw = 18 + th(i, 1) * 26, bh = H * (0.08 + th(i, 2) * 0.16); if (Math.abs(bx + bw / 2 - gx) < W * 0.12) bh *= 0.4; c.lineTo(bx, hz - bh); c.lineTo(bx + bw * 0.5, hz - bh - 8); c.lineTo(bx + bw, hz - bh); bx += bw; }
    c.lineTo(W, H); c.fill();
    for (i = 0; i < 16; i++) { var wx = th(i, 5) * W; if (Math.abs(wx - gx) < W * 0.12) continue; var wy = hz - 6 - th(i, 6) * H * 0.12; c.fillStyle = 'rgba(255,200,110,' + (0.55 + 0.35 * Math.sin(t / 700 + i)) + ')'; c.fillRect(wx, wy, 2.5, 3.5); }
    // the shaft: a black mouth with a faint glow from below
    var sg = c.createRadialGradient(gx, H * 0.93, 2, gx, H * 0.93, W * 0.2); sg.addColorStop(0, '#000'); sg.addColorStop(0.7, 'rgba(0,0,0,0.9)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = sg; c.beginPath(); c.ellipse(gx, H * 0.93, W * 0.2, H * 0.07, 0, 0, 7); c.fill();
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
      if (!seen[j]) a2 = 1; else if (!vis[j]) a2 = fogA; else { var dd = Math.sqrt((x - vp.x) * (x - vp.x) + (y - vp.y) * (y - vp.y)); a2 = clamp((dd - L * 0.55) / (L * 0.9), 0, 1) * 0.36; }
      if (a2 <= 0.01) continue;
      c.fillStyle = rgb(P.fog, a2); c.fillRect(Math.floor(ox + x * ts), Math.floor(oy + y * ts), Math.ceil(ts) + 1, Math.ceil(ts) + 1);
    }
    drawFx(c, G, ox, oy, ts, t, dt);
    drawEdgeArrows(c, G, ox, oy, ts, t);
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (S.set.mini) drawMini();
  }
  // visible enemies outside the view get a pointer at the stage edge
  function drawEdgeArrows(c, G, ox, oy, s, t) {
    var W = S.cw, H = S.chh, m = 12;
    G.mons.forEach(function (mo) {
      if (mo.ally || !E.monVisible(G, mo)) return;
      var x = ox + (mo.x + 0.5) * s, y = oy + (mo.y + 0.5) * s;
      if (x >= 0 && x <= W && y >= 0 && y <= H) return;
      var cx = W / 2, cy = H / 2, dx = x - cx, dy = y - cy, k = Math.min((W / 2 - m) / Math.abs(dx || 1e-6), (H / 2 - m) / Math.abs(dy || 1e-6));
      var ax = cx + dx * k, ay = cy + dy * k, a = Math.atan2(dy, dx);
      c.save(); c.translate(ax, ay); c.rotate(a);
      c.fillStyle = mo.boss ? '#ffd86a' : mo.intent ? '#ff4040' : '#e86050'; c.globalAlpha = 0.75 + 0.25 * Math.sin(t / 200);
      c.beginPath(); c.moveTo(9, 0); c.lineTo(-5, -6); c.lineTo(-5, 6); c.closePath(); c.fill();
      c.restore(); c.globalAlpha = 1;
    });
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

  // ---- effects ---------------------------------------------------------------------
  function burst(x, y, col, n, spd, life, size, grav) {
    for (var i = 0; i < (n || 8); i++) {
      var a = Math.random() * Math.PI * 2, v = (spd || 2.5) * (0.4 + Math.random() * 0.8);
      S.fx.parts.push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (grav ? 1.5 : 0), life: 0, max: (life || 0.5) * (0.7 + Math.random() * 0.6), col: col, size: size || 0.08, g: grav || 0 });
    }
    if (S.fx.parts.length > 400) S.fx.parts.splice(0, S.fx.parts.length - 400);
  }
  function floatText(x, y, s, col, big) { S.fx.texts.push({ x: x + 0.5 + (Math.random() - 0.5) * 0.3, y: y + 0.2, s: s, col: col, life: 0, max: big ? 1.4 : 0.9, big: !!big }); if (S.fx.texts.length > 40) S.fx.texts.shift(); }
  function ring(x, y, r, col, dur) { S.fx.rings.push({ x: x + 0.5, y: y + 0.5, r: r || 1, col: col, t0: S.time, dur: dur || 380 }); }
  function areaFlash(tiles, col, dur) { S.fx.areas.push({ tiles: tiles, col: col, t0: S.time, dur: dur || 320 }); }
  function banner(title, sub, dur) { S.fx.banner = { title: title, sub: sub || '', t0: S.time, dur: dur || 2600 }; }
  var ELEM_COL = { fire: '#ff8a3a', frost: '#9fdcff', shock: '#bfe0ff', holy: '#ffe08a', void: '#c08aff', poison: '#7ae07a', burn: '#ff8a3a', bleed: '#e04a4a', wave: '#6ab0ff', blood: '#e04a4a', trap: '#e0e0e0' };
  var PROJ_COL = { fire: '#ff8a3a', arrow: '#e8d8b0', bigarrow: '#ffe08a', zap: '#bfe0ff', holy: '#ffe08a', bone: '#e8e0d0', knife: '#d0d0e0', drain: '#e04a6a', heal: '#7fe0a0', bomb: '#404048', beam: '#d0b0ff' };
  function drainEvents() {
    var G = S.G; if (!G || !G.ev.length) return;
    var evs = G.ev; G.ev = [];
    for (var i = 0; i < evs.length; i++) handleEvent(evs[i]);
  }
  function handleEvent(e) {
    var G = S.G, snd = S.snd, vis = function (x, y) { return G.vis && G.vis[y * G.w + x]; };
    switch (e.t) {
      case 'log': addLog(e.s, e.c); break;
      case 'dmg':
        if (!vis(e.x, e.y) && !e.p) break;
        var col = e.p ? '#ff6a5a' : e.crit ? '#ffe06a' : (ELEM_COL[e.elem] || (S.th.dark ? '#ffffff' : '#ffffff'));
        floatText(e.x, e.y, (e.crit ? e.n + '!' : String(e.n)), col, e.crit);
        if (e.ab) floatText(e.x, e.y - 0.3, '(' + e.ab + ')', '#9fd8ff');
        var a = G.p.x === e.x && G.p.y === e.y ? 0 : null; G.mons.forEach(function (m) { if (m.x === e.x && m.y === e.y) a = m.id; });
        if (a != null) S.flash[a] = S.time;
        burst(e.x, e.y, ELEM_COL[e.elem] || (e.p ? '#e04a4a' : '#e8d0b0'), e.crit ? 12 : 5, e.crit ? 3.5 : 2.2, 0.4, 0.07);
        if (e.p) { snd.play('hurt'); S.shake = Math.max(S.shake, e.crit ? 7 : 4); Cade.haptic && Cade.haptic(15); S.hurtT = S.time; }
        else snd.play(e.crit ? 'crit' : 'hit');
        if (e.crit && !e.p) S.shake = Math.max(S.shake, 3);
        break;
      case 'miss': if (vis(e.x, e.y)) { floatText(e.x, e.y, 'miss', '#b0b0b0'); snd.play('miss'); } break;
      case 'block': floatText(e.x, e.y, 'block', '#9fd8ff'); snd.play('miss'); break;
      case 'immune': floatText(e.x, e.y, 'immune', '#9fdcff'); break;
      case 'heal': if (!e.quiet || e.n >= 3) floatText(e.x, e.y, '+' + e.n, '#7fe0a0'); if (!e.quiet) { burst(e.x, e.y, '#7fe0a0', 8, 1.5, 0.6, 0.07, -0.5); snd.play('heal'); } break;
      case 'atk': S.lunge[e.id] = { dx: Math.sign(e.tx - e.x), dy: Math.sign(e.ty - e.y), t0: S.time }; if (e.id === 0) snd.play('swing'); break;
      case 'proj':
        S.fx.projs.push({ x0: e.x0 + 0.5, y0: e.y0 + 0.5, x1: e.x1 + 0.5, y1: e.y1 + 0.5, t0: S.time + (e.delay || 0), dur: Math.max(90, Math.hypot(e.x1 - e.x0, e.y1 - e.y0) * 28), k: e.k, col: PROJ_COL[e.k] || '#ffffff' });
        snd.play(e.k === 'fire' ? 'fire' : e.k === 'zap' ? 'zap' : e.k === 'holy' || e.k === 'heal' ? 'holy' : e.k === 'drain' || e.k === 'beam' ? 'dark' : 'bow');
        break;
      case 'die':
        S.fx.ghosts.push({ x: e.x, y: e.y, ch: e.ch, col: e.col, t0: S.time, dur: e.boss ? 1400 : 420, big: e.boss });
        if (vis(e.x, e.y) || e.boss) { burst(e.x, e.y, e.col, e.boss ? 60 : 14, e.boss ? 5 : 3, e.boss ? 1.4 : 0.6, 0.09, 3); snd.play(e.boss ? 'boom' : 'kill'); }
        break;
      case 'fx': fxEvent(e); break;
      case 'area':
        var ac = e.k === 'boom' ? 'rgba(255,140,50,' : e.k === 'gas' ? 'rgba(120,230,90,' : e.k === 'wave' ? 'rgba(90,170,255,' : e.k === 'void' ? 'rgba(180,110,255,' : 'rgba(255,90,70,';
        areaFlash(e.tiles, ac, 380);
        e.tiles.forEach(function (q, ix) { if (ix % 2 === 0 && vis(q[0], q[1])) burst(q[0], q[1], ac + '1)', 4, 2.4, 0.4, 0.08); });
        if (!e.small) snd.play(e.k === 'boom' ? 'boom' : e.k === 'wave' ? 'frost' : e.k === 'void' ? 'dark' : 'hit');
        break;
      case 'shake': S.shake = Math.max(S.shake, e.n); break;
      case 'level': ring(G.p.x, G.p.y, 2, '#ffe08a', 700); burst(G.p.x, G.p.y, '#ffe08a', 30, 3, 1.1, 0.08, -0.5); banner('LEVEL ' + e.lvl, 'You grow stronger.', 1800); snd.play('level'); refreshBars(); break;
      case 'floor': S.vis = {}; S.snapCam = true; S.tilesDirty = true; S.fx.parts = []; S.fx.projs = []; S.fx.areas = []; snd.play('stairs'); S.auto = null; break;
      case 'act':
        var A = D.STORY.acts[e.act - 1]; if (A) banner(A.name.toUpperCase(), D.BIOMES[e.biome].name, 3600); break;
      case 'intent': var m = mon(e.id); if (m && vis(m.x, m.y)) snd.play('warn'); stopAuto(); break;
      case 'alert': if (vis(e.x, e.y)) floatText(e.x, e.y - 0.2, '!', '#ffd040', true); break;
      case 'spot': stopAuto('spot'); break;
      case 'status': if (vis(e.x, e.y) && (e.k === 'stun' || e.k === 'frozen' || e.k === 'root' || e.k === 'mark')) floatText(e.x, e.y - 0.3, e.k === 'frozen' ? 'frozen' : e.k === 'mark' ? 'marked' : e.k + 'ed', '#d0d0ff'); break;
      case 'pick':
        if (e.k === 'gold') { floatText(e.x, e.y, '+' + e.n + 'g', '#f0c840'); snd.play('gold'); }
        else if (e.k === 'item') { snd.play(e.rarity === 'common' || e.rarity === 'magic' ? 'pick' : 'rare'); if (e.rarity !== 'common' && e.rarity !== 'magic') { ring(e.x, e.y, 1, rarCol(e.rarity), 500); burst(e.x, e.y, rarCol(e.rarity), 16, 2.5, 0.8, 0.07, -0.5); } }
        else snd.play('pick');
        break;
      case 'cast': break;
      case 'boss': snd.play('boss'); S.shake = 6; break;
      case 'phase': banner(e.name.toUpperCase(), e.line, 3000); snd.play('boss'); break;
      case 'bounty': snd.play('solve'); break;
      case 'snd': snd.play(e.k === 'push' ? 'door' : e.k); break;
      case 'dash': for (var k = 0; k <= 6; k++) { var tx = e.x0 + (e.x1 - e.x0) * k / 6, ty = e.y0 + (e.y1 - e.y0) * k / 6; burst(tx, ty, '#e0d0b0', 2, 1, 0.35, 0.07); } snd.play('swing'); break;
      case 'bump': break;
    }
  }
  function mon(id) { var G = S.G; for (var i = 0; i < G.mons.length; i++) if (G.mons[i].id === id) return G.mons[i]; return null; }
  function fxEvent(e) {
    var snd = S.snd;
    switch (e.k) {
      case 'nova': ring(e.x, e.y, e.r + 0.5, e.col, 420); burst(e.x, e.y, e.col, 24, 4, 0.5, 0.07); snd.play(e.col === '#9fdcff' ? 'frost' : 'holy'); break;
      case 'boom': ring(e.x, e.y, (e.r || 1) + 0.5, e.col, 380); burst(e.x, e.y, e.col, 30, 4.5, 0.6, 0.1); burst(e.x, e.y, '#555', 10, 2, 0.9, 0.12, -0.3); snd.play('boom'); break;
      case 'sweep': ring(e.x, e.y, 1.5, e.col, 260); snd.play('swing'); break;
      case 'smoke': burst(e.x, e.y, 'rgba(160,160,170,0.8)', 26, 1.6, 1.0, 0.18, -0.6); break;
      case 'blink': burst(e.x, e.y, '#c0a0ff', 16, 2.5, 0.5, 0.06); snd.play('zap'); break;
      case 'sparkle': burst(e.x, e.y, e.col || '#ffe08a', 12, 2, 0.6, 0.06, -0.5); snd.play('chest'); break;
      case 'heal': ring(e.x, e.y, 1, '#7fe0a0', 400); break;
      case 'shield': ring(e.x, e.y, 0.9, e.col || '#ffe08a', 500); snd.play('holy'); break;
      case 'shieldbreak': burst(e.x, e.y, '#9fd8ff', 14, 3, 0.5, 0.07); break;
      case 'raise': burst(e.x, e.y, e.col || '#a8e0c8', 16, 1.8, 0.8, 0.07, -0.8); snd.play('dark'); break;
      case 'rain': var tl = []; for (var y = e.y - e.r; y <= e.y + e.r; y++) for (var x = e.x - e.r; x <= e.x + e.r; x++) tl.push([x, y]); areaFlash(tl, 'rgba(230,215,170,', 300); snd.play('bow'); break;
      case 'meteor': ring(e.x, e.y, e.r + 1, '#ff8a3a', 500); burst(e.x, e.y, '#ff8a3a', 50, 5, 0.9, 0.12); burst(e.x, e.y, '#ffe08a', 20, 3, 0.6, 0.08); snd.play('boom'); break;
      case 'flash': S.fx.flash = { col: e.col, t0: S.time, dur: 450 }; break;
      case 'gate': burst(e.x, e.y, '#d0d0d8', 10, 2, 0.6, 0.06); snd.play('solve'); break;
      case 'rune': ring(e.x, e.y, 0.8, '#9fdcff', 400); snd.play('holy'); break;
      case 'trap': burst(e.x, e.y, '#e05050', 12, 2.5, 0.5, 0.07); snd.play('bad'); break;
      case 'revive': ring(e.x, e.y, 2, '#ffe08a', 800); burst(e.x, e.y, '#ffe08a', 40, 3.5, 1.2, 0.08, -0.6); snd.play('level'); break;
      case 'steal': burst(e.x, e.y, '#f0c840', 10, 2.5, 0.6, 0.06); break;
    }
  }
  function drawFx(c, G, ox, oy, s, t, dt) {
    var fx = S.fx;
    fx.areas = fx.areas.filter(function (a) {
      var k = (t - a.t0) / a.dur; if (k >= 1) return false;
      c.fillStyle = a.col + (0.55 * (1 - k)) + ')';
      a.tiles.forEach(function (q) { c.fillRect(ox + q[0] * s, oy + q[1] * s, s, s); });
      return true;
    });
    fx.ghosts = fx.ghosts.filter(function (g) {
      var k = (t - g.t0) / g.dur; if (k >= 1) return false;
      c.globalAlpha = 1 - k; drawToken(c, ox + g.x * s, oy + g.y * s - k * s * 0.3, s, g.col, g.ch, { big: g.big }); c.globalAlpha = 1; return true;
    });
    fx.rings = fx.rings.filter(function (r) {
      var k = (t - r.t0) / r.dur; if (k >= 1) return false;
      c.strokeStyle = r.col; c.globalAlpha = 1 - k; c.lineWidth = 3 * (1 - k) + 1;
      c.beginPath(); c.arc(ox + r.x * s, oy + r.y * s, Math.max(1, r.r * s * (0.3 + 0.7 * k)), 0, 7); c.stroke(); c.globalAlpha = 1; return true;
    });
    fx.projs = fx.projs.filter(function (p) {
      if (t < p.t0) return true;
      var k = (t - p.t0) / p.dur; if (k >= 1) { burst(p.x1 - 0.5, p.y1 - 0.5, p.col, 6, 2, 0.35, 0.06); return false; }
      var x = p.x0 + (p.x1 - p.x0) * k, y = p.y0 + (p.y1 - p.y0) * k, tx = p.x0 + (p.x1 - p.x0) * Math.max(0, k - 0.25), ty = p.y0 + (p.y1 - p.y0) * Math.max(0, k - 0.25);
      c.strokeStyle = p.col; c.lineWidth = p.k === 'bigarrow' || p.k === 'beam' ? 4 : 2.5; c.lineCap = 'round';
      if (p.k === 'zap') { c.beginPath(); c.moveTo(ox + p.x0 * s, oy + p.y0 * s); for (var j = 1; j <= 5; j++) { var f = j / 5 * k; c.lineTo(ox + (p.x0 + (p.x1 - p.x0) * f + (Math.random() - 0.5) * 0.3) * s, oy + (p.y0 + (p.y1 - p.y0) * f + (Math.random() - 0.5) * 0.3) * s); } c.stroke(); }
      else { c.beginPath(); c.moveTo(ox + tx * s, oy + ty * s); c.lineTo(ox + x * s, oy + y * s); c.stroke(); }
      c.fillStyle = p.col; c.beginPath(); c.arc(ox + x * s, oy + y * s, p.k === 'fire' || p.k === 'bomb' ? s * 0.14 : s * 0.07, 0, 7); c.fill();
      if (p.k === 'fire' && Math.random() < 0.6) burst(x - 0.5, y - 0.5, '#ffb050', 1, 0.5, 0.3, 0.06);
      return true;
    });
    for (var i = fx.parts.length - 1; i >= 0; i--) {
      var q = fx.parts[i]; q.life += dt; if (q.life >= q.max) { fx.parts.splice(i, 1); continue; }
      q.x += q.vx * dt; q.y += q.vy * dt; q.vy += q.g * dt; q.vx *= 0.92; q.vy *= 0.92;
      c.globalAlpha = 1 - q.life / q.max; c.fillStyle = q.col; var ps = q.size * s; c.fillRect(ox + q.x * s - ps / 2, oy + q.y * s - ps / 2, ps, ps);
    }
    c.globalAlpha = 1;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    fx.texts = fx.texts.filter(function (x) {
      x.life += dt; if (x.life >= x.max) return false;
      var k = x.life / x.max, yy = oy + (x.y - k * 0.9) * s, sz = s * (x.big ? 0.52 : 0.38) * (k < 0.15 ? 0.7 + k * 2 : 1);
      c.font = glyphFont(sz, true); c.globalAlpha = 1 - Math.max(0, k - 0.6) / 0.4;
      c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,0.7)'; c.strokeText(x.s, ox + x.x * s, yy); c.fillStyle = x.col; c.fillText(x.s, ox + x.x * s, yy);
      c.globalAlpha = 1; return true;
    });
    // hurt vignette
    if (S.hurtT && t - S.hurtT < 350) { var hk = 1 - (t - S.hurtT) / 350; var gw = c.createRadialGradient(S.cw / 2, S.chh / 2, Math.min(S.cw, S.chh) * 0.3, S.cw / 2, S.chh / 2, Math.max(S.cw, S.chh) * 0.7); gw.addColorStop(0, 'rgba(200,0,0,0)'); gw.addColorStop(1, 'rgba(200,0,0,' + 0.35 * hk + ')'); c.fillStyle = gw; c.fillRect(0, 0, S.cw, S.chh); }
    var s2 = E.stats(G.hero, G);
    if (G.p.hp < s2.maxHp * 0.25) { var lw = 0.18 + 0.1 * Math.sin(t / 250); var gl = c.createRadialGradient(S.cw / 2, S.chh / 2, Math.min(S.cw, S.chh) * 0.35, S.cw / 2, S.chh / 2, Math.max(S.cw, S.chh) * 0.75); gl.addColorStop(0, 'rgba(150,0,0,0)'); gl.addColorStop(1, 'rgba(150,0,0,' + lw + ')'); c.fillStyle = gl; c.fillRect(0, 0, S.cw, S.chh); }
    if (fx.flash) { var fk = (t - fx.flash.t0) / fx.flash.dur; if (fk >= 1) fx.flash = null; else { c.globalAlpha = 0.5 * (1 - fk); c.fillStyle = fx.flash.col; c.fillRect(0, 0, S.cw, S.chh); c.globalAlpha = 1; } }
    if (fx.banner) {
      var bk = (t - fx.banner.t0) / fx.banner.dur;
      if (bk >= 1) fx.banner = null;
      else {
        var al = bk < 0.12 ? bk / 0.12 : bk > 0.8 ? (1 - bk) / 0.2 : 1;
        c.globalAlpha = al * 0.8; c.fillStyle = S.th.dark ? '#000' : rgb(S.th.bg); c.fillRect(0, S.chh * 0.36, S.cw, S.chh * 0.22);
        c.globalAlpha = al; c.fillStyle = rgb(S.th.accent); c.font = glyphFont(Math.min(22, S.cw / (fx.banner.title.length * 0.7 + 2)), true);
        c.fillText(fx.banner.title, S.cw / 2, S.chh * 0.44);
        c.fillStyle = S.th.dark ? '#e8e8e8' : rgb(S.th.text); c.font = glyphFont(12, false);
        wrapText(c, fx.banner.sub, S.cw / 2, S.chh * 0.52, S.cw - 30, 15);
        c.globalAlpha = 1;
      }
    }
  }
  function wrapText(c, s, x, y, maxW, lh) {
    var words = String(s).split(' '), line = '', lines = [];
    words.forEach(function (w) { var tst = line ? line + ' ' + w : w; if (c.measureText(tst).width > maxW && line) { lines.push(line); line = w; } else line = tst; });
    if (line) lines.push(line);
    lines.slice(0, 3).forEach(function (l, i) { c.fillText(l, x, y + i * lh); });
  }
  function drawMini() {
    var G = S.G, mc = S.mini; if (!mc) return;
    var cell = S.cw < 420 ? 2 : 3, w = G.w * cell, h = G.h * cell;
    if (mc.width !== w * S.dpr) { mc.width = w * S.dpr; mc.height = h * S.dpr; mc.style.width = w + 'px'; mc.style.height = h + 'px'; }
    var c = mc.getContext('2d'); c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = S.th.dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.65)'; c.fillRect(0, 0, w, h);
    var P = S.pal, fl = S.th.dark ? 'rgba(200,190,170,0.55)' : 'rgba(80,70,60,0.45)';
    for (var y = 0; y < G.h; y++) for (var x = 0; x < G.w; x++) {
      var i = y * G.w + x; if (!G.seen[i]) continue;
      var t = G.t[i];
      if (t === T.WALL || t === T.CRACK) continue;
      c.fillStyle = t === T.STAIRS ? '#ffd040' : t === T.WATER || t === T.DEEP ? '#4a90d0' : t === T.LAVA ? '#ff6a2a' : t === T.CHASM ? '#000' : t === T.GATE ? '#c0c0c8' : t === T.PORTAL ? '#9fd0ff' : fl;
      c.fillRect(x * cell, y * cell, cell, cell);
    }
    G.objs.forEach(function (o) {
      if (!G.seen[o.y * G.w + o.x]) return;
      var col = o.k === 'chest' ? '#c9a23a' : o.k === 'event' && !o.used ? '#c070ff' : o.k === 'lever' && !o.on ? '#70d0ff' : o.k === 'item' ? rarCol(o.it.rarity) : o.k === 'lore' || o.k === 'quest' ? '#ffe08a' : null;
      if (col) { c.fillStyle = col; c.fillRect(o.x * cell, o.y * cell, cell, cell); }
    });
    G.mons.forEach(function (m) { if (E.monVisible(G, m)) { c.fillStyle = m.ally ? '#7fe0a0' : m.boss ? '#ff3030' : '#e05050'; c.fillRect(m.x * cell - 0.5, m.y * cell - 0.5, cell + 1, cell + 1); } });
    c.fillStyle = rgb(S.th.accent); c.fillRect(G.p.x * cell - 1, G.p.y * cell - 1, cell + 2, cell + 2);
  }

  // ===========================================================================
  //  HUD, ability bar, log
  // ===========================================================================
  function svg(path, fill) { return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>'; }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_MENU = svg('<path d="M4 7h16M4 12h16M4 17h16"/>');
  var ART = [
    '╔╦╗╔═╗╔═╗╔═╗╔╦╗╔═╗╦  ╦  ╦╔═╗',
    ' ║║║╣ ║╣ ╠═╝ ║║║╣ ║  ╚╗╔╝║╣ ',
    '═╩╝╚═╝╚═╝╩  ═╩╝╚═╝╩═╝ ╚╝ ╚═╝'].join('\n');

  function hero() { return S.G ? S.G.hero : S.hero; }
  function refreshHud() { refreshBars(); refreshAbil(); refreshChips(); }
  function refreshBars() {
    if (!S) return;
    var h = hero(); if (!h) return;
    var G = S.G, s = E.stats(h, G), cr = D.CLASSES[h.cls].res;
    var hp = G ? G.p.hp : h.hp, res = G ? G.p.res : h.res;
    S.hpFill.style.width = clamp(hp / s.maxHp * 100, 0, 100) + '%';
    S.hpLbl.textContent = 'HP ' + Math.max(0, Math.round(hp)) + '/' + s.maxHp;
    S.hpEl.classList.toggle('low', hp < s.maxHp * 0.3);
    S.resFill.style.width = clamp(res / s.maxRes * 100, 0, 100) + '%';
    S.resFill.style.background = cr.color;
    S.resLbl.textContent = cr.name + ' ' + Math.round(res) + '/' + s.maxRes;
    S.xpFill.style.width = (h.level >= E.LEVEL_CAP ? 100 : clamp(h.xp / E.xpForLevel(h.level) * 100, 0, 100)) + '%';
    var where;
    if (G) where = (G.mode === 'daily' ? '☀ ' : '') + 'B' + G.depth + ' · ' + D.BIOMES[G.biome].short;
    else where = 'Lanternfall';
    S.whereEl.textContent = where;
    S.goldEl.innerHTML = G && G.mode === 'daily' ? 'score <b>' + E.dailyScore(G) + '</b>' : 'Lv <b>' + h.level + '</b> · <b>' + h.gold + '</b>g';
    // boss bar
    var boss = G && G.mons.filter(function (m) { return m.boss && m.aware; })[0];
    if (boss) { S.bossEl.hidden = false; S.bossName.textContent = boss.name + (boss.phase ? ' — phase ' + (boss.phase + 1) : ''); S.bossFill.style.width = clamp(boss.hp / boss.maxHp * 100, 0, 100) + '%'; }
    else S.bossEl.hidden = true;
    S.stage.classList.toggle('boss', !S.bossEl.hidden);
  }
  function refreshChips() {
    if (!S || !S.G) { if (S) S.chipsEl.innerHTML = ''; return; }
    var G = S.G, h = G.hero, out = [];
    (h.bless || []).forEach(function (b) { var B = D.BLESSINGS[b.id]; out.push('<span class="cr-chip ' + (B.good ? 'good' : 'bad') + '" title="' + esc(B.name + ': ' + B.desc + ' (' + b.n + ' floors)') + '">' + B.icon + '<i>' + b.n + '</i></span>'); });
    var st = G.p.st, map = { poison: ['☠', 'bad'], burn: ['🔥', 'bad'], bleed: ['🩸', 'bad'], stun: ['✶', 'bad'], frozen: ['❄', 'bad'], root: ['⛓', 'bad'], slow: ['🐌', 'bad'], weaken: ['↓', 'bad'], dark: ['🌑', 'bad'], invis: ['👁', 'good'], unbreak: ['🛡', 'good'], inv: ['✧', 'good'], haste: ['⚡', 'good'], regen: ['✚', 'good'], shield: ['🔰', 'good'], sanct: ['✺', 'good'] };
    for (var k in st) {
      var m = map[k]; if (!m) continue;
      var v = st[k], n = typeof v === 'number' ? v : v.t != null ? (v.t > 900 ? '' : v.t) : '';
      out.push('<span class="cr-chip ' + m[1] + '" title="' + k + '">' + m[0] + '<i>' + n + '</i></span>');
    }
    if (G.p.st.ramp) out.push('<span class="cr-chip good" title="Rampage">⚔<i>' + G.p.st.ramp.n + '</i></span>');
    var html = out.join('');
    if (html !== S.chipsHtml) { S.chipsHtml = html; S.chipsEl.innerHTML = html; }
  }
  function refreshAbil() {
    if (!S) return;
    var h = hero(); if (!h) { S.abilEl.innerHTML = ''; return; }
    var G = S.G, list = E.abilitiesFor(h), html = '';
    list.forEach(function (a, i) {
      var A = D.ABILITIES[a.id], st = G ? E.abilityState(G, a.id) : { ok: a.known }, cost = G ? E.abilityCost(G, a.id) : A.cost;
      var cls = 'cr-ab' + (!a.known ? ' locked' : st.cd ? ' cd' : st.short ? ' short' : '') + (S.tgt && S.tgt.id === a.id ? ' on' : '');
      html += '<button type="button" class="' + cls + '" data-act="ab" data-id="' + a.id + '" title="' + esc(A.name + ' — ' + A.desc) + '">' +
        '<span class="cr-abk">' + (i + 1) + '</span><span class="cr-abi">' + (a.known ? A.icon : '🔒') + '</span>' +
        '<span class="cr-abc">' + (!a.known ? 'Lv' + a.lvl : st.cd ? st.cd + 't' : cost ? cost : 'free') + '</span>' +
        (st.cd ? '<span class="cr-abcd"></span>' : '') + '</button>';
    });
    var pots = h.cons.potion || 0;
    html += '<button type="button" class="cr-ab pot' + (pots ? '' : ' short') + '" data-act="potion" title="Health Potion (Q)"><span class="cr-abk">Q</span><span class="cr-abi">🧪</span><span class="cr-abc">×' + pots + '</span></button>';
    if (html !== S.abilHtml) { S.abilHtml = html; S.abilEl.innerHTML = html; }
  }
  function addLog(s, c) {
    if (!S) return;
    S.logLines.push({ s: s, c: c || '' }); if (S.logLines.length > 150) S.logLines.shift();
    var el = document.createElement('div');
    el.className = 'cr-ln ' + String(c || '').replace(/[^a-z:]/g, '').replace(':', ' r-');
    el.textContent = s;
    S.logEl.appendChild(el);
    while (S.logEl.children.length > 4) S.logEl.removeChild(S.logEl.firstChild);
    setTimeout(function () { el.classList.add('old'); }, 5000);
  }

  // ===========================================================================
  //  actions — every player turn goes through here
  // ===========================================================================
  function doAct(a) {
    if (!S || !S.G || S.G.over || S.G.modal) return false;
    S.snd.ensure();
    var hpBefore = S.G.p.hp;
    var ok = E.act(S.G, a);
    afterAct();
    if (S && S.auto && S.G && S.G.p.hp < hpBefore) stopAuto();
    return ok;
  }
  function afterAct() {
    if (!S || !S.G) return;
    S.tilesDirty = true;
    drainEvents();
    if (!S.G) return;
    refreshHud();
    if (S.G.over) { finishRun(); return; }
    if (S.G.modal) { stopAuto(); showModal(); }
    saveRunSoon();
  }
  function move(dx, dy) {
    if (S.tgt) { moveCursor(dx, dy); return; }
    stopAuto();
    doAct({ t: 'move', dx: dx, dy: dy });
  }
  function useKey() { if (S.tgt) { confirmTarget(); return; } stopAuto(); doAct({ t: 'use' }); }
  function restKey() {
    if (S.tgt) { confirmTarget(); return; }
    if (S.auto) { stopAuto(); return; }
    var G = S.G; if (!G) return;
    if (E.hostilesVisible(G).length) { doAct({ t: 'wait' }); return; }
    var s = E.stats(G.hero, G), cr = D.CLASSES[G.hero.cls].res;
    var resFull = cr.decay ? true : G.p.res >= s.maxRes;
    if (G.p.hp >= s.maxHp && resFull) { doAct({ t: 'wait' }); return; }
    S.auto = { k: 'rest', n: 0, next: 0 };
    addLog('You rest… (any key to stop)', 'info');
  }
  function usePotion() { stopAuto(); if (S.G) doAct({ t: 'cons', id: 'potion' }); }

  // ---- auto: travel / explore / rest -------------------------------------------------
  function stopAuto(why) { if (S && S.auto) { S.auto = null; } }
  function startTravel(x, y) {
    var path = E.travelPath(S.G, x, y);
    if (!path || !path.length) return false;
    S.auto = { k: 'path', path: path, next: 0 };
    return true;
  }
  function startExplore() {
    var G = S.G; if (!G) return;
    var near = E.hostilesVisible(G).filter(function (m) { return !m.asleep && Math.max(Math.abs(m.x - G.p.x), Math.abs(m.y - G.p.y)) <= 8; });
    if (near.length) { addLog('Not with ' + E.displayName(near[0]).toLowerCase() + ' in sight.', 'warn'); return; }
    S.auto = { k: 'explore', next: 0 };
  }
  function tickAuto(t) {
    var A = S.auto, G = S.G;
    if (!A || !G) return;
    if (G.over || G.modal || S.ovlOpen || S.screen) { S.auto = null; return; }
    if (t < A.next) return;
    A.next = t + (A.k === 'rest' ? 28 : 72);
    if (A.k === 'rest') {
      var s = E.stats(G.hero, G), cr = D.CLASSES[G.hero.cls].res;
      if (E.hostilesVisible(G).length || A.n++ > 150) { S.auto = null; return; }
      if (G.p.hp >= s.maxHp && (cr.decay || G.p.res >= s.maxRes)) { S.auto = null; addLog('You feel rested.', 'good'); return; }
      doAct({ t: 'wait' }); return;
    }
    if (A.k === 'explore') {
      var path = E.explorePath(G);
      if (!path || !path.length) {
        S.auto = null;
        addLog(G.stairs && G.seen[G.stairs[1] * G.w + G.stairs[0]] ? 'Nothing left to explore here. The stairs are on your map.' : 'Nothing more to explore that you can reach.', 'info');
        if (G.stairs && G.seen[G.stairs[1] * G.w + G.stairs[0]]) startTravel(G.stairs[0], G.stairs[1]);
        return;
      }
      var st = path[0];
      if (!doAct({ t: 'move', dx: st[0] - G.p.x, dy: st[1] - G.p.y })) S.auto = null;
      return;
    }
    if (A.k === 'path') {
      var q = A.path.shift();
      if (!q) { S.auto = null; return; }
      if (Math.abs(q[0] - G.p.x) + Math.abs(q[1] - G.p.y) !== 1) { S.auto = null; return; }
      var last = !A.path.length;
      var ok = doAct({ t: 'move', dx: q[0] - G.p.x, dy: q[1] - G.p.y });
      if (!ok || last) S.auto = null;
    }
  }

  // ---- abilities & targeting ---------------------------------------------------------
  function abilityPress(id) {
    var G = S.G; if (!G) return;
    stopAuto();
    if (S.tgt && S.tgt.id === id) { confirmTarget(); return; }
    var st = E.abilityState(G, id);
    if (!st.ok) { addLog(st.why, 'info'); S.snd.play('bad'); return; }
    var A = D.ABILITIES[id];
    if (A.target === 'self') { doAct({ t: 'ability', id: id }); return; }
    var tg = E.abilityTargets(G, id);
    if (!tg.list.length) { addLog(A.target === 'corpse' ? 'No corpse within reach.' : A.target === 'enemy' ? 'No target in range.' : 'Nowhere to aim.', 'info'); S.snd.play('bad'); return; }
    if (A.target === 'enemy' && S.set.quick && tg.def) { doAct({ t: 'ability', id: id, x: tg.def.x, y: tg.def.y }); return; }
    S.tgt = { id: id, list: tg.list, cur: tg.def || tg.list[0], radius: A.target === 'tile' || A.target === 'corpse' ? (id === 'corpseboom' ? (A.radius || 1) : (A.radius || 0)) : 0, line: A.target === 'line', range: E.abilityRange(G, id), enemy: A.target === 'enemy' };
    showTgtBar(A.name);
    refreshAbil();
  }
  function bombPress() {
    var G = S.G; if (!G || !G.hero.cons.bomb) { addLog('No bombs.', 'info'); return; }
    var list = [];
    for (var y = G.p.y - 4; y <= G.p.y + 4; y++) for (var x = G.p.x - 4; x <= G.p.x + 4; x++) if (E.visible(G, x, y) && !E.OPAQUE[E.tile(G, x, y)]) list.push({ x: x, y: y });
    var foes = E.hostilesVisible(G).filter(function (m) { return Math.max(Math.abs(m.x - G.p.x), Math.abs(m.y - G.p.y)) <= 4; });
    S.tgt = { id: 'bomb', list: list, cur: foes[0] ? { x: foes[0].x, y: foes[0].y } : list[0], radius: 1 };
    showTgtBar('Fire Bomb');
  }
  function showTgtBar(name) {
    S.tgtEl.hidden = false;
    S.tgtEl.innerHTML = '<span>◎ <b>' + esc(name) + '</b> — ' + (S.coarse ? 'tap a target' : 'arrows aim · Enter casts') + '</span><button type="button" data-act="tgtgo">Cast</button><button type="button" data-act="tgtx">✕</button>';
  }
  function cancelTarget() { S.tgt = null; S.tgtEl.hidden = true; refreshAbil(); }
  function confirmTarget(x, y) {
    var tg = S.tgt; if (!tg) return;
    if (x != null) tg.cur = { x: x, y: y };
    var ok = tg.cur && tg.list.some(function (q) { return q.x === tg.cur.x && q.y === tg.cur.y; });
    if (!ok) { addLog('Out of range.', 'info'); S.snd.play('bad'); return; }
    var id = tg.id, cx = tg.cur.x, cy = tg.cur.y;
    cancelTarget();
    if (id === 'bomb') doAct({ t: 'cons', id: 'bomb', x: cx, y: cy });
    else doAct({ t: 'ability', id: id, x: cx, y: cy });
  }
  function moveCursor(dx, dy) {
    var tg = S.tgt; if (!tg || !tg.cur) return;
    if (tg.enemy) {
      // jump to the nearest valid target in that direction
      var best = null, bd = 1e9;
      tg.list.forEach(function (q) { var vx = q.x - tg.cur.x, vy = q.y - tg.cur.y; if (vx * dx + vy * dy <= 0) return; var d = Math.abs(vx) + Math.abs(vy) + Math.abs(dx ? vy : vx) * 2; if (d < bd) { bd = d; best = q; } });
      if (best) tg.cur = best;
      return;
    }
    for (var k = 1; k <= 3; k++) {
      var nx = tg.cur.x + dx * k, ny = tg.cur.y + dy * k;
      if (tg.list.some(function (q) { return q.x === nx && q.y === ny; })) { tg.cur = { x: nx, y: ny }; return; }
    }
  }
  function cycleTarget() {
    var G = S.G; if (!G) return;
    if (S.tgt && S.tgt.enemy) { var l = S.tgt.list, i = 0; for (var k = 0; k < l.length; k++) if (l[k].x === S.tgt.cur.x && l[k].y === S.tgt.cur.y) i = k; S.tgt.cur = l[(i + 1) % l.length]; return; }
    var hv = E.hostilesVisible(G); if (!hv.length) return;
    hv.sort(function (a, b) { return Math.abs(a.x - G.p.x) + Math.abs(a.y - G.p.y) - Math.abs(b.x - G.p.x) - Math.abs(b.y - G.p.y); });
    var ix = 0; for (var j = 0; j < hv.length; j++) if (hv[j].id === G.p.target) ix = j + 1;
    G.p.target = hv[ix % hv.length].id;
  }

  // ===========================================================================
  //  screens (full panel) and overlays (modal cards)
  // ===========================================================================
  function B(act, label, extra, cls) { return '<button type="button" class="' + (cls || 'cr-b') + '" data-act="' + act + '"' + (extra || '') + '>' + label + '</button>'; }
  function dat(k, v) { return ' data-' + k + '="' + esc(v) + '"'; }
  function tok(col, ch, big) { return '<span class="cr-tok' + (big ? ' big' : '') + '" style="--c:' + col + '">' + esc(ch) + '</span>'; }
  function actName(h) {
    if (h.story.ended) return 'Story complete' + (h.story.ng ? ' · NG+' + h.story.ng : '');
    return 'Act ' + ['I', 'II', 'III', 'IV', 'V'][Math.min(4, h.story.cleared)] + (h.story.ng ? ' · NG+' + h.story.ng : '');
  }
  function heroChip(h, extra) {
    var c = D.CLASSES[h.cls];
    return '<div class="cr-hchip">' + tok(c.color, h.needsClass ? '?' : '@', true) + '<div><b>' + esc(h.name) + '</b><span>' +
      (h.needsClass ? 'Lv ' + h.level + ' Veteran' : 'Lv ' + h.level + ' ' + c.name) + ' · ' + actName(h) + ' · deepest B' + (h.story.deepest || 0) + ' · ' + D.DIFFICULTIES[h.difficulty].name + '</span>' + (extra || '') + '</div></div>';
  }
  function showScreen(name) { var was = S.screen; S.screen = name; S.scrEl.hidden = false; if (was !== name) S.scrEl.scrollTop = 0; S.ovlOpen = false; S.ovlEl.hidden = true; S.ov = null; renderScreen(); }
  function hideScreen() { S.screen = null; S.scrEl.hidden = true; S.scrEl.innerHTML = ''; S.sceneCv = null; }
  function renderScreen() {
    if (!S || !S.screen) return;
    var fk = focusKey(S.scrEl), html = '';
    switch (S.screen) {
      case 'loading': html = '<div class="cr-card"><pre class="cr-art">' + esc(ART) + '</pre><p class="cr-p cr-c">Lighting the torches…</p></div>'; break;
      case 'error': html = '<div class="cr-card"><p class="cr-p">Couldn\'t load the dungeon (offline before it was ever cached?).</p>' + B('retry', 'Try again', '', 'cr-go') + '</div>'; break;
      case 'title': html = scrTitle(); break;
      case 'roster': html = scrRoster(); break;
      case 'create': html = scrCreate(); break;
      case 'town': html = scrTown(); break;
      case 'death': html = scrDeath(); break;
      case 'daily': html = scrDaily(); break;
      case 'dailyover': html = scrDailyOver(); break;
      case 'ending': html = scrEnding(); break;
    }
    S.scrEl.innerHTML = html;
    S.sceneCv = S.scrEl.querySelector('.cr-scene');
    if (S.sceneCv) sizeScene();
    restoreFocus(S.scrEl, fk);
  }
  function sizeScene() {
    var cv = S.sceneCv, w = Math.max(200, S.scrEl.clientWidth - 24), h = Math.round(Math.min(150, w * 0.36));
    cv.style.width = w + 'px'; cv.style.height = h + 'px'; cv.width = Math.round(w * S.dpr); cv.height = Math.round(h * S.dpr);
  }
  function focusKey(root) { var a = document.activeElement; return a && root.contains(a) ? (a.getAttribute('data-act') || '') + '|' + (a.getAttribute('data-id') || a.getAttribute('data-uid') || a.getAttribute('data-i') || a.getAttribute('data-t') || '') : null; }
  function restoreFocus(root, fk) {
    if (!S.kbd) return;
    var els = root.querySelectorAll('button:not([disabled])'), pick = null;
    if (fk) for (var i = 0; i < els.length; i++) { var e = els[i], k = (e.getAttribute('data-act') || '') + '|' + (e.getAttribute('data-id') || e.getAttribute('data-uid') || e.getAttribute('data-i') || e.getAttribute('data-t') || ''); if (k === fk) { pick = e; break; } }
    if (!pick) pick = root.querySelector('.cr-go:not([disabled])') || els[0];
    if (pick) try { pick.focus({ preventScroll: false }); } catch (e2) {}
  }
  function openOvl(k, o) { S.ov = o || {}; S.ov.k = k; S.ovlOpen = true; S.ovlEl.hidden = false; stopAuto(); if (S.tgt) cancelTarget(); renderOvl(true); }
  function closeOvl() {
    if (!S.ovlOpen) return;
    var ov = S.ov; S.ovlOpen = false; S.ovlEl.hidden = true; S.ovlEl.innerHTML = ''; S.ov = null;
    if (ov && ov.onClose) ov.onClose();
    if (S.screen) { renderScreen(); }
    else { refreshHud(); try { S.cv.focus({ preventScroll: true }); } catch (e) {} if (S.G && S.G.modal) showModal(); }
  }
  function renderOvl(first) {
    if (!S.ovlOpen || !S.ov) return;
    var fk = first ? null : focusKey(S.ovlEl), k = S.ov.k, html;
    if (k.indexOf('npc:') === 0) html = ovNpc(k.slice(4));
    else html = ({ sheet: ovSheet, event: ovEvent, dialog: ovDialog, tablet: ovTablet, lore: ovLore, found: ovFound, dshop: ovDShop, map: ovMap, log: ovLog, menu: ovMenu, help: ovHelp, stash: ovStash, prologue: ovPrologue, msg: ovMsg }[k] || ovMsg)();
    var scroll = S.ovlEl.firstChild ? S.ovlEl.firstChild.scrollTop : 0;
    S.ovlEl.innerHTML = '<div class="cr-card cr-ovc' + (S.ov.wide ? ' wide' : '') + '">' + html + '</div>';
    if (!first && S.ovlEl.firstChild) S.ovlEl.firstChild.scrollTop = scroll;
    if (k === 'map') drawBigMap();
    restoreFocus(S.ovlEl, fk);
  }
  function msg(title, text, onClose) { openOvl('msg', { title: title, text: text, onClose: onClose }); }
  function ovMsg() { return '<div class="cr-title">' + esc(S.ov.title || '') + '</div><div class="cr-p">' + S.ov.text + '</div>' + B('close', 'Continue', '', 'cr-go'); }

  // ---- title ------------------------------------------------------------------------
  function runSnapFor(h) {
    var s = jget(K_RUN + h.id); if (!s || s.heroId !== h.id) return null;
    if (h.client && h.client !== S.client && (h.updated || 0) > (s.savedAt || 0)) return null;   // another device played on since
    return s;
  }
  function setRow() {
    var st = S.set;
    return '<div class="cr-sets">' + B('set', (st.sound ? '🔊' : '🔇') + ' Sound', dat('k', 'sound'), 'cr-chipb' + (st.sound ? ' on' : '')) +
      B('set', '⚡ Quick-cast', dat('k', 'quick'), 'cr-chipb' + (st.quick ? ' on' : '')) + B('set', '▦ Minimap', dat('k', 'mini'), 'cr-chipb' + (st.mini ? ' on' : '')) + '</div>';
  }
  function scrTitle() {
    var R = S.R, h = R.slots[R.active], html = '<div class="cr-card cr-titlec"><canvas class="cr-scene"></canvas><pre class="cr-art">' + esc(ART) + '</pre><div class="cr-sub">— the descent beneath Lanternfall —</div>';
    if (h) {
      var snap = runSnapFor(h);
      html += heroChip(h) + B('continue', h.needsClass ? '▶ A veteran returns — choose a calling' : snap ? '▶ Resume the delve — floor ' + snap.depth : '▶ Enter Lanternfall', '', 'cr-go');
    } else html += '<p class="cr-p cr-c">Six callings. Five acts. One hollow king.</p>' + B('new', '▶ Create your hero', '', 'cr-go');
    var dinfo = E.dailyInfo(today()), dd = R.daily.days[today()];
    html += '<div class="cr-row">' + B('heroes', '⇄ Heroes ' + R.order.length + '/' + E.ROSTER_MAX) + B('daily', '☀ Daily' + (dd ? ' · ' + dd.best : '')) + B('help', '? How to play') + '</div>';
    html += setRow() + '<div class="cr-note">Heroes sync across devices when Cade.txt cloud sync is on.</div></div>';
    return html;
  }
  // ---- roster -------------------------------------------------------------------------
  function scrRoster() {
    var R = S.R, html = '<div class="cr-card"><div class="cr-title">HEROES</div>';
    if (!R.order.length) html += '<p class="cr-p cr-c">No heroes yet.</p>';
    R.order.forEach(function (id) {
      var h = R.slots[id], armed = S.delArm === id;
      html += '<div class="cr-slot' + (id === R.active ? ' on' : '') + '">' + heroChip(h) + '<div class="cr-row">' + B('pick', id === R.active ? 'Selected ▶' : 'Play ▶', dat('id', id), 'cr-b pri') +
        B('del', armed ? 'Really delete?' : 'Delete', dat('id', id), 'cr-b' + (armed ? ' danger' : '')) + '</div></div>';
    });
    if (R.order.length < E.ROSTER_MAX) html += B('new', '+ New hero', '', 'cr-go');
    html += '<div class="cr-note">Up to ' + E.ROSTER_MAX + ' heroes. They share one stash in Lanternfall.</div>' + B('back', '← Back') + '</div>';
    return html;
  }
  // ---- create -------------------------------------------------------------------------
  function scrCreate() {
    var cr = S.create, vet = cr.vet, html = '<div class="cr-card"><div class="cr-title">' + (vet ? 'A VETERAN RETURNS' : 'CHOOSE A CALLING') + '</div>';
    if (vet) html += '<p class="cr-p">' + esc(vet.name) + ' (level ' + vet.level + ') has delved before — but the Deep has changed, and so must they. Choose a calling; your old gear is reforged to match it.</p>';
    html += '<div class="cr-classes">';
    D.CLASS_ORDER.forEach(function (k) { var c = D.CLASSES[k]; html += '<button type="button" class="cr-cls' + (cr.cls === k ? ' on' : '') + '" data-act="cls" data-id="' + k + '" style="--c:' + c.color + '"><span class="cr-clsi">' + c.icon + '</span><b>' + c.name + '</b><i>' + c.res.name + '</i></button>'; });
    html += '</div>';
    var C = D.CLASSES[cr.cls];
    if (C) {
      var tmp = E.newHero(cr.cls, 'x', 'normal', E.rng(1)), st = E.stats(tmp);
      html += '<div class="cr-clsinfo" style="--c:' + C.color + '"><p class="cr-p"><b>' + C.name + '.</b> ' + esc(C.blurb) + '</p><p class="cr-p">' + esc(C.play) + '</p>' +
        '<div class="cr-kv"><span>Health <b>' + st.maxHp + '</b></span><span>Power <b>' + Math.round(st.pow) + '</b></span><span>Armor <b>' + Math.round(st.arm) + '</b></span><span>' + C.res.name + ' <b>' + st.maxRes + '</b></span></div><ul class="cr-abl">';
      C.abilities.forEach(function (id, i) { var A = D.ABILITIES[id]; html += '<li><span>' + A.icon + '</span><b>' + A.name + '</b> <i>Lv ' + D.ABILITY_LEVELS[i] + '</i> — ' + esc(A.desc) + '</li>'; });
      html += '</ul></div>';
    }
    if (!vet) {
      html += '<div class="cr-h">Name</div><div class="cr-namebox">' + (cr.typing ? '<input class="cr-in" maxlength="18" value="' + esc(cr.name) + '" aria-label="Hero name">' : '<b>' + esc(cr.name) + '</b>') +
        B('rname', '🎲', ' title="Random name"', 'cr-sq') + (cr.typing ? '' : B('tname', '✎', ' title="Type a name"', 'cr-sq')) + '</div>';
      html += '<div class="cr-h">Difficulty</div><div class="cr-sets">';
      D.DIFF_ORDER.forEach(function (k) { html += B('diff', D.DIFFICULTIES[k].name, dat('id', k), 'cr-chipb' + (cr.diff === k ? ' on' : '')); });
      html += '</div><p class="cr-note">' + esc(D.DIFFICULTIES[cr.diff].desc) + '</p>';
    }
    html += '<div class="cr-row">' + B('back', '← Back') + B('begin', vet ? 'Choose this calling ▶' : 'Begin the descent ▶', C ? '' : ' disabled', 'cr-go') + '</div></div>';
    return html;
  }
  // ---- town ---------------------------------------------------------------------------
  var SUN = ['The Sunstone gutters, barely brighter than a candle.', 'The Sunstone flickers — a little steadier tonight.', 'The Sunstone burns amber over the rooftops.', 'The Sunstone is bright enough to read by.', 'The Sunstone blazes; the shaft below has gone quiet.', 'The Sunstone burns white. Lanternfall sleeps.', 'The Sunstone burns white. The Deep, patient, dreams again.'];
  function placeBadge(h, id) {
    if (id === 'board') return h.quests.board.some(function (b) { return b.done; }) ? '<i class="cr-bdg">!</i>' : '';
    var sq = E.sideOffers(h, id);
    if (sq.some(function (q) { return q.state === 'new' || q.state === 'found'; })) return '<i class="cr-bdg">!</i>';
    return '';
  }
  function scrTown() {
    var h = S.hero, st = E.storyStage(h), html = '<div class="cr-town"><canvas class="cr-scene"></canvas>';
    html += '<div class="cr-townh"><b>LANTERNFALL</b><span>' + esc(SUN[st]) + '</span></div>';
    html += heroChip(h, '<span class="cr-mats">◆ ' + h.gold + 'g · ⚙ ' + h.mats.scrap + ' · ✨ ' + h.mats.dust + ' · 🔥 ' + h.mats.soul + '</span>');
    html += '<div class="cr-places">';
    D.TOWN_ORDER.forEach(function (id) { var N = D.NPCS[id]; html += '<button type="button" class="cr-place" data-act="place" data-id="' + id + '"><span class="cr-pi">' + N.icon + '</span><b>' + esc(N.place) + '</b><i>' + esc(id === 'board' ? N.role : N.name + ', ' + N.role) + '</i>' + placeBadge(h, id) + '</button>'; });
    html += '<button type="button" class="cr-place" data-act="place" data-id="stash"><span class="cr-pi">🧰</span><b>Shared Stash</b><i>' + S.R.stash.length + '/' + E.STASH_MAX + ' items</i></button>';
    html += '<button type="button" class="cr-place" data-act="sheet"><span class="cr-pi">🎒</span><b>' + esc(h.name) + '</b><i>gear, talents, journal</i>' + (E.talentPoints(h) ? '<i class="cr-bdg">★</i>' : '') + '</button>';
    html += '</div><div class="cr-desc"><div class="cr-h">The Deepdelve</div><div class="cr-sets">';
    var wps = h.story.waypoints.slice();
    if (S.wp == null || wps.indexOf(S.wp) < 0) S.wp = wps[wps.length - 1];
    wps.forEach(function (w) { html += B('wp', 'B' + w + ' · ' + D.BIOMES[E.biomeAt(w)].short, dat('id', w), 'cr-chipb' + (S.wp === w ? ' on' : '')); });
    html += '</div>';
    var b = D.BIOMES[E.biomeAt(S.wp)];
    html += B('descend', '⬇ Descend — floor ' + S.wp + ' · ' + b.name, '', 'cr-go');
    if (h.story.ended && !h.story.ng && false) html += '';
    if (h.story.ended) html += '<div class="cr-row">' + B('ngplus', S.ngArm ? 'Really begin New Game+?' : '✦ New Game+', '', 'cr-b' + (S.ngArm ? ' danger' : '')) + '</div><div class="cr-note">The Endless Descent continues past floor 25 (waypoints every 5 floors). New Game+ restarts the story with far deadlier foes — and far better loot.</div>';
    html += '</div><div class="cr-row">' + B('heroes', '⇄ Heroes') + B('daily', '☀ Daily') + B('help', '? Help') + '</div></div>';
    return html;
  }
  // ---- NPCs -----------------------------------------------------------------------------
  function npcHead(id) {
    var N = D.NPCS[id], h = S.hero;
    if (!S.ov.line) S.ov.line = E.npcLine(h, id, E.rng(Date.now() & 0xffff));
    return '<div class="cr-npc">' + tok(N.col, N.ch, true) + '<div><b>' + esc(N.name) + '</b><i>' + esc(N.role) + '</i></div>' + B('close', '✕', ' aria-label="Close"', 'cr-x') + '</div><p class="cr-quote">' + esc(S.ov.line) + '</p>';
  }
  function sideBox(id) {
    var h = S.hero, out = '';
    E.sideOffers(h, id).forEach(function (q) {
      var SQ = D.SIDEQUESTS[q.id];
      if (q.state === 'new') out += '<div class="cr-quest"><b>' + esc(SQ.name) + '</b><p>' + esc(SQ.text) + '</p>' + B('sq-accept', 'Accept', dat('id', q.id), 'cr-b pri') + '</div>';
      else if (q.state === 'active') out += '<div class="cr-quest dim"><b>' + esc(SQ.name) + '</b><p>Find the ' + esc(SQ.item) + ' in ' + D.BIOMES[D.BIOME_ORDER[SQ.act - 1]].name + '.</p></div>';
      else if (q.state === 'found') out += '<div class="cr-quest"><b>' + esc(SQ.name) + '</b><p>You have the ' + esc(SQ.item) + '.</p>' + B('sq-turn', 'Hand it over', dat('id', q.id), 'cr-b pri') + '</div>';
    });
    return out;
  }
  function tabs(list, cur) { return '<div class="cr-tabs">' + list.map(function (t) { return B('otab', t[1], dat('t', t[0]), cur === t[0] ? 'on' : ''); }).join('') + '</div>'; }
  function itemRow(it, opts) {
    opts = opts || {};
    var R = D.RARITIES[it.rarity], B_ = D.BASES[it.base], main = B_.main ? Math.round(E.mainValue(it)) + (B_.main === 'pow' ? ' pow' : ' arm') : '';
    var sel = S.ov && S.ov.sel === it.uid;
    return '<button type="button" class="cr-it r-' + it.rarity + (sel ? ' on' : '') + '" data-act="' + (opts.act || 'isel') + '" data-uid="' + it.uid + '">' +
      '<span class="cr-iti">' + ({ weapon: '/', armor: '[', helm: '^', charm: '"' }[it.slot]) + '</span><span class="cr-itn">' + esc(it.name) + (it.plus ? ' +' + it.plus : '') + (it.fresh ? ' <em>new</em>' : '') + '</span>' +
      '<span class="cr-itm">' + (opts.right != null ? opts.right : main + ' · i' + it.ilvl) + '</span></button>';
  }
  function compareLines(it, h) {
    var cur = h.equip[it.slot]; if (!cur || cur === it) return '';
    var a = E.itemStats(it), b = E.itemStats(cur), keys = {}, out = [];
    for (var k in a) keys[k] = 1; for (k in b) keys[k] = 1;
    for (k in keys) {
      var d = (a[k] || 0) - (b[k] || 0); if (Math.abs(d) < 0.005) continue;
      var A = D.AFFIXES[k], txt;
      if (k === 'pow' || k === 'arm') txt = (d > 0 ? '+' : '') + Math.round(d) + ' ' + (k === 'pow' ? 'power' : 'armor');
      else if (A && A.pct) txt = (d > 0 ? '+' : '') + Math.round(d * 100) + '% ' + A.name.toLowerCase();
      else txt = (d > 0 ? '+' : '') + Math.round(d) + ' ' + (A ? A.name.toLowerCase() : k);
      out.push('<span class="' + (d > 0 ? 'up' : 'dn') + '">' + txt + '</span>');
    }
    var ds = E.itemScore(it, h.cls) - E.itemScore(cur, h.cls);
    return '<div class="cr-cmp"><i>vs ' + esc(cur.name) + ':</i> ' + (out.join(' ') || 'same stats') + ' <b class="' + (ds >= 0 ? 'up' : 'dn') + '">' + (ds >= 0 ? '▲' : '▼') + '</b></div>';
  }
  function itemDetail(it, h, actions) {
    var R = D.RARITIES[it.rarity], lines = E.itemLines(it), extra = '';
    if (it.uq) extra = '<p class="cr-lore">' + esc(D.UNIQUES[it.uq].lore) + '</p>';
    if (it.set) { var Sx = D.SETS[it.set], n = E.setCounts(h)[it.set] || 0; extra = '<p class="cr-set">' + esc(Sx.name) + ' (' + n + '/3 worn) — 2: ' + esc(Sx.b2.desc) + ' · 3: ' + esc(Sx.b3.desc) + '</p>'; }
    var warn = it.slot === 'weapon' && !E.canWield(h, it) ? '<p class="cr-warn">Your class can\'t wield this.</p>' : '';
    return '<div class="cr-idet r-' + it.rarity + '"><b>' + esc(it.name) + (it.plus ? ' +' + it.plus : '') + '</b><i>' + R.name + ' ' + D.SLOT_NAMES[it.slot].toLowerCase() + ' · item level ' + it.ilvl + ' · worth ' + E.itemValue(it) + 'g</i><ul>' +
      lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' + extra + warn + compareLines(it, h) + '<div class="cr-row">' + (actions || '') + '</div></div>';
  }
  function ovNpc(id) {
    var h = S.hero, ov = S.ov, html;
    if (id === 'stash') return ovStash();
    html = npcHead(id) + sideBox(id);
    if (id === 'maren') {
      html += '<div class="cr-row">' + B('story', '📖 The story so far') + B('rest', '🛏 Rest (free)') + '</div>';
      if (ov.story) html += '<div class="cr-story">' + storyRecap(h) + '</div>';
      if (ov.rested) html += '<p class="cr-note">You sleep like the dead. (Fully restored — you always are, back in town.)</p>';
    } else if (id === 'torvald') {
      ov.tab = ov.tab || 'up';
      html += tabs([['up', 'Upgrade'], ['ref', 'Reforge'], ['salv', 'Salvage'], ['craft', 'Craft']], ov.tab);
      html += '<div class="cr-note">◆ ' + h.gold + 'g · ⚙ ' + h.mats.scrap + ' scrap · ✨ ' + h.mats.dust + ' dust · 🔥 ' + h.mats.soul + ' soul embers</div>';
      if (ov.flash) html += '<p class="cr-flash">' + esc(ov.flash) + '</p>';
      var items = D.SLOTS.map(function (s) { return h.equip[s]; }).filter(Boolean).concat(h.bag);
      if (ov.tab === 'craft') {
        html += '<p class="cr-p">Torvald forges a random piece at your deepest item level.</p>';
        ['rare', 'epic'].forEach(function (kind) {
          var c = E.craftCost(kind), costTxt = c.gold + 'g ' + Object.keys(c.mats).map(function (m) { return c.mats[m] + ' ' + D.MATERIALS[m].name; }).join(', ');
          html += '<div class="cr-h">' + (kind === 'rare' ? 'Rare' : 'Epic') + ' piece — ' + costTxt + '</div><div class="cr-row">';
          D.SLOTS.forEach(function (sl) { html += B('craft', D.SLOT_NAMES[sl], dat('id', sl) + dat('t', kind) + (E.hasMats(h, c) && h.bag.length < E.BAG_MAX ? '' : ' disabled')); });
          html += '</div>';
        });
      } else {
        items.forEach(function (it) {
          var right, ok = true;
          if (ov.tab === 'up') { var c = E.upgradeCost(h, it); if ((it.plus || 0) >= E.maxPlus(h)) { right = 'max +' + E.maxPlus(h); ok = false; } else { right = c.gold + 'g ' + matTxt(c.mats); ok = E.hasMats(h, c); } }
          else if (ov.tab === 'ref') { if (it.uq || it.rarity === 'common') { right = '—'; ok = false; } else { var c2 = E.reforgeCost(h, it); right = c2.gold + 'g ' + matTxt(c2.mats); ok = E.hasMats(h, c2); } }
          else { if (D.SLOTS.some(function (s) { return h.equip[s] === it; })) { right = 'equipped'; ok = false; } else right = '→ ' + matTxt(E.salvageYield(it)); }
          html += itemRow(it, { right: right });
          if (ov.sel === it.uid) html += itemDetail(it, h, ok ? B(ov.tab === 'up' ? 'up' : ov.tab === 'ref' ? 'ref' : 'salv', ov.tab === 'up' ? '⚒ Upgrade to +' + ((it.plus || 0) + 1) : ov.tab === 'ref' ? '🔮 Reforge affixes' : '♻ Salvage', dat('uid', it.uid), 'cr-b pri') : '');
        });
      }
    } else if (id === 'pip') {
      ov.tab = ov.tab || 'buy';
      if (!S.stock) S.stock = E.shopStock(h);
      html += tabs([['buy', 'Buy'], ['sell', 'Sell']], ov.tab) + '<div class="cr-note">◆ ' + h.gold + ' gold · pack ' + h.bag.length + '/' + E.BAG_MAX + '</div>';
      if (ov.flash) html += '<p class="cr-flash">' + esc(ov.flash) + '</p>';
      if (ov.tab === 'buy') {
        S.stock.cons.forEach(function (e, i) { var C_ = D.CONSUMABLES[e.cons]; html += '<div class="cr-cons"><span>' + C_.icon + '</span><div><b>' + C_.name + '</b> <i>×' + (h.cons[e.cons] || 0) + '</i><p>' + esc(C_.desc) + '</p></div>' + B('buy', e.price + 'g', dat('i', 'c' + i) + (h.gold >= e.price ? '' : ' disabled'), 'cr-b pri') + '</div>'; });
        html += '<div class="cr-h">Wares</div>';
        S.stock.items.forEach(function (e, i) {
          if (e.sold) return;
          html += itemRow(e.it, { right: e.price + 'g' });
          if (ov.sel === e.it.uid) html += itemDetail(e.it, h, B('buy', 'Buy for ' + e.price + 'g', dat('i', 'i' + i) + (h.gold >= e.price ? '' : ' disabled'), 'cr-b pri'));
        });
      } else {
        if (!h.bag.length) html += '<p class="cr-p">Your pack is empty.</p>';
        else html += B('sellcommons', 'Sell all Common items', '', 'cr-b');
        h.bag.forEach(function (it) { html += itemRow(it, { right: E.itemValue(it) + 'g' }); if (ov.sel === it.uid) html += itemDetail(it, h, B('sell', 'Sell for ' + E.itemValue(it) + 'g', dat('uid', it.uid), 'cr-b pri')); });
      }
    } else if (id === 'ilse') {
      var tc = E.templeCosts(h), curses = (h.bless || []).filter(function (b) { return !D.BLESSINGS[b.id].good; });
      if (ov.flash) html += '<p class="cr-flash">' + esc(ov.flash) + '</p>';
      html += '<div class="cr-h">Curses</div>' + (curses.length ? curses.map(function (b) { return '<p class="cr-p">' + D.BLESSINGS[b.id].icon + ' ' + esc(D.BLESSINGS[b.id].name) + ' — ' + esc(D.BLESSINGS[b.id].desc) + ' (' + b.n + ' floors)</p>'; }).join('') + B('uncurse', 'Lift all curses — ' + tc.uncurse + 'g', h.gold >= tc.uncurse ? '' : ' disabled', 'cr-b pri') : '<p class="cr-note">You carry no curses.</p>');
      html += '<div class="cr-h">Blessings for your next descent (3 floors) — ' + tc.bless + 'g</div><div class="cr-row wrap">';
      ['might', 'ward', 'fortune', 'vigor', 'swift', 'clarity'].forEach(function (b) { var Bl = D.BLESSINGS[b]; html += B('bless', Bl.icon + ' ' + Bl.desc, dat('id', b) + (h.gold >= tc.bless ? '' : ' disabled')); });
      html += '</div><div class="cr-h">Retrace your path</div><p class="cr-note">Forget every talent you have chosen and choose again. ' + tc.respec + 'g</p>' + B('respec', S.respecArm ? 'Really forget all talents?' : 'Respec talents — ' + tc.respec + 'g', h.gold >= tc.respec && h.talents.some(Boolean) ? '' : ' disabled', 'cr-b' + (S.respecArm ? ' danger' : ''));
    } else if (id === 'odo') {
      ov.tab = ov.tab || 'lore';
      html += tabs([['lore', 'Lore ' + h.lore.length + '/' + D.LORE.length], ['beast', 'Bestiary'], ['rec', 'Records']], ov.tab);
      if (ov.tab === 'lore') {
        for (var a = 1; a <= 5; a++) {
          html += '<div class="cr-h">' + D.STORY.acts[a - 1].name + '</div>';
          D.LORE.forEach(function (L, i) {
            if (L.act !== a) return;
            if (h.lore.indexOf(i) < 0) { html += '<p class="cr-note">— a missing page —</p>'; return; }
            html += B('lore', '📜 ' + esc(L.title), dat('i', i), 'cr-lnk');
            if (ov.page === i) html += '<p class="cr-lore">' + esc(L.text) + '</p>';
          });
        }
      } else if (ov.tab === 'beast') {
        var seen = Object.keys(h.bestiary);
        if (!seen.length) html += '<p class="cr-note">Nothing recorded yet. Go and meet something.</p>';
        seen.sort(function (a2, b2) { return h.bestiary[b2] - h.bestiary[a2]; }).forEach(function (k) {
          var isB = k.indexOf('boss:') === 0, M = isB ? D.BOSSES[k.slice(5)] : D.MONSTERS[k]; if (!M) return;
          html += '<div class="cr-beast">' + tok(M.col, M.ch) + '<b>' + esc(M.name) + '</b><i>' + (isB ? 'defeated ' : 'slain ') + h.bestiary[k] + '×</i></div>';
        });
      } else {
        var s = h.stats;
        html += '<div class="cr-kv col"><span>Kills <b>' + s.kills + '</b></span><span>Elites <b>' + s.elites + '</b></span><span>Bosses <b>' + s.bosses + '</b></span><span>Deaths <b>' + s.deaths + '</b></span><span>Floors <b>' + s.floors + '</b></span><span>Delves <b>' + s.runs + '</b></span><span>Puzzles <b>' + s.puzzles + '</b></span><span>Shrines <b>' + s.events + '</b></span><span>Gold found <b>' + s.gold + '</b></span><span>Bounties <b>' + h.quests.done + '</b></span><span>Turns <b>' + s.turns + '</b></span><span>Deepest <b>B' + h.story.deepest + '</b></span></div>';
      }
    } else if (id === 'board') {
      if (ov.flash) html += '<p class="cr-flash">' + esc(ov.flash) + '</p>';
      h.quests.board.forEach(function (b) {
        html += '<div class="cr-quest' + (b.done ? ' done' : '') + '"><b>' + esc(b.name) + '</b><p>' + esc(b.text) + '</p><div class="cr-prog"><i style="width:' + Math.round(b.have / b.need * 100) + '%"></i><span>' + (b.tpl === 'depth' ? (b.done ? 'done' : 'not yet') : b.have + '/' + b.need) + '</span></div>' +
          '<p class="cr-note">Reward: ' + b.reward.gold + 'g, ' + b.reward.xp + ' XP</p>' + (b.done ? B('claim', 'Claim reward', dat('id', b.id), 'cr-b pri') : '') + '</div>';
      });
      var sides = Object.keys(h.quests.side).filter(function (q) { return h.quests.side[q] !== 'done'; });
      if (sides.length) { html += '<div class="cr-h">Errands</div>'; sides.forEach(function (q) { var SQ = D.SIDEQUESTS[q]; html += '<p class="cr-p">' + esc(SQ.name) + ' — ' + (h.quests.side[q] === 'found' ? 'return to ' + D.NPCS[SQ.giver].name : 'search ' + D.BIOMES[D.BIOME_ORDER[SQ.act - 1]].name) + '</p>'; }); }
    }
    html += B('close', 'Leave', '', 'cr-b');
    return html;
  }
  function matTxt(m) { var o = []; for (var k in m) if (m[k]) o.push(m[k] + D.MATERIALS[k].icon); return o.join(' '); }
  function storyRecap(h) {
    var out = D.STORY.prologue.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('');
    for (var a = 1; a <= h.story.cleared; a++) out += '<div class="cr-h">' + esc(D.STORY.acts[a - 1].name) + '</div>' + (D.STORY.cleared[a] || []).map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('');
    if (h.story.ended) out += D.STORY.ending.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('');
    return out;
  }
  function ovStash() {
    var h = S.hero, R = S.R, html = '<div class="cr-npc">' + tok('#c0a070', '▤', true) + '<div><b>Shared Stash</b><i>every hero in your roster can use it</i></div>' + B('close', '✕', ' aria-label="Close"', 'cr-x') + '</div>';
    html += '<div class="cr-h">Your pack ' + h.bag.length + '/' + E.BAG_MAX + ' — tap to store</div>';
    if (!h.bag.length) html += '<p class="cr-note">Empty.</p>';
    h.bag.forEach(function (it) { html += itemRow(it, { act: 'stash-put', right: R.stash.length < E.STASH_MAX ? '→ stash' : 'full' }); });
    html += '<div class="cr-h">Stash ' + R.stash.length + '/' + E.STASH_MAX + ' — tap to take</div>';
    if (!R.stash.length) html += '<p class="cr-note">Empty.</p>';
    R.stash.forEach(function (it) { html += itemRow(it, { act: 'stash-take', right: h.bag.length < E.BAG_MAX ? '→ pack' : 'pack full' }); });
    return html + B('close', 'Done', '', 'cr-b');
  }

  // ---- the hero sheet: gear / talents / skills / stats / journal -------------------------
  function ovSheet() {
    var h = hero(), ov = S.ov, G = S.G, s = E.stats(h, G), c = D.CLASSES[h.cls];
    ov.tab = ov.tab || 'gear';
    var tp = E.talentPoints(h);
    var html = '<div class="cr-npc">' + tok(c.color, '@', true) + '<div><b>' + esc(h.name) + '</b><i>Level ' + h.level + ' ' + c.name + ' · ' + h.xp + '/' + E.xpForLevel(h.level) + ' XP</i></div>' + B('close', '✕', ' aria-label="Close"', 'cr-x') + '</div>';
    html += tabs([['gear', 'Gear'], ['tal', 'Talents' + (tp ? ' ★' : '')], ['skills', 'Skills'], ['stats', 'Stats'], ['jour', 'Journal']], ov.tab);
    if (ov.flash) html += '<p class="cr-flash">' + esc(ov.flash) + '</p>';
    if (ov.tab === 'gear') {
      D.SLOTS.forEach(function (sl) {
        var it = h.equip[sl];
        if (!it) { html += '<div class="cr-it empty"><span class="cr-iti">·</span><span class="cr-itn">' + D.SLOT_NAMES[sl] + ' — empty</span></div>'; return; }
        html += itemRow(it);
        if (ov.sel === it.uid) html += itemDetail(it, h, sl === 'helm' || sl === 'charm' ? B('unequip', 'Take off', dat('id', sl)) : '');
      });
      html += '<div class="cr-h">Pack ' + h.bag.length + '/' + E.BAG_MAX + (G ? ' · ◆ ' + h.gold + 'g' : '') + '</div>';
      if (!h.bag.length) html += '<p class="cr-note">Nothing in your pack. Monsters, chests and vaults drop gear.</p>';
      var bag = h.bag.slice().sort(function (a, b) { return D.SLOTS.indexOf(a.slot) - D.SLOTS.indexOf(b.slot) || E.itemScore(b, h.cls) - E.itemScore(a, h.cls); });
      bag.forEach(function (it) {
        var better = E.canWield(h, it) && E.itemScore(it, h.cls) > E.itemScore(h.equip[it.slot], h.cls);
        html += itemRow(it, { right: (better ? '▲ ' : '') + (D.BASES[it.base].main ? Math.round(E.mainValue(it)) + (D.BASES[it.base].main === 'pow' ? ' pow' : ' arm') : '') + ' · i' + it.ilvl });
        if (ov.sel === it.uid) html += itemDetail(it, h, (E.canWield(h, it) ? B('equip', 'Equip', dat('uid', it.uid), 'cr-b pri') : '') + B('drop', S.dropArm === it.uid ? 'Really discard?' : 'Discard', dat('uid', it.uid), 'cr-b' + (S.dropArm === it.uid ? ' danger' : '')));
      });
      var cons = D.CONS_ORDER.filter(function (k) { return h.cons[k]; });
      if (cons.length) { html += '<div class="cr-h">Consumables</div><div class="cr-row wrap">'; cons.forEach(function (k) { var C_ = D.CONSUMABLES[k]; html += G ? B('usecons', C_.icon + ' ' + C_.name + ' ×' + h.cons[k], dat('id', k) + ' title="' + esc(C_.desc) + '"') : '<span class="cr-pill" title="' + esc(C_.desc) + '">' + C_.icon + ' ' + C_.name + ' ×' + h.cons[k] + '</span>'; }); html += '</div>'; }
      html += '<div class="cr-note">Materials: ⚙ ' + h.mats.scrap + ' · ✨ ' + h.mats.dust + ' · 🔥 ' + h.mats.soul + '</div>';
    } else if (ov.tab === 'tal') {
      html += '<p class="cr-note">One talent per tier. Choices are permanent — Sister Ilse in Lanternfall can help you respec.</p>';
      D.TALENTS[h.cls].forEach(function (tier, ti) {
        var lv = D.TALENT_LEVELS[ti], chosen = h.talents[ti], open = h.level >= lv;
        html += '<div class="cr-h">Tier ' + (ti + 1) + ' · level ' + lv + (open && !chosen ? ' — choose one!' : '') + '</div><div class="cr-tal">';
        tier.forEach(function (t) {
          var on = chosen === t.id, armed = S.talArm === t.id;
          html += '<button type="button" class="cr-talb' + (on ? ' on' : '') + (chosen && !on ? ' off' : '') + '" data-act="talent" data-i="' + ti + '" data-id="' + t.id + '"' + (open && !chosen ? '' : ' disabled') + '><b>' + esc(t.name) + (armed ? ' — tap again' : '') + '</b><span>' + esc(t.desc) + '</span></button>';
        });
        html += '</div>';
      });
    } else if (ov.tab === 'skills') {
      E.abilitiesFor(h).forEach(function (a, i) {
        var A = D.ABILITIES[a.id];
        html += '<div class="cr-skill' + (a.known ? '' : ' dim') + '"><span class="cr-ski">' + A.icon + '</span><div><b>' + (i + 1) + '. ' + A.name + '</b> <i>' + (a.known ? (A.cost ? A.cost + ' ' + c.res.name.toLowerCase() : 'free') + (A.cd ? ' · ' + A.cd + ' turn cooldown' : '') : 'unlocks at level ' + a.lvl) + '</i><p>' + esc(A.desc) + '</p></div></div>';
      });
      html += '<p class="cr-note">' + esc(c.res.name) + ': ' + esc(resHelp(h.cls)) + '</p>';
    } else if (ov.tab === 'stats') {
      var row = function (k, v) { return '<span>' + k + ' <b>' + v + '</b></span>'; }, pc = function (v) { return Math.round(v * 100) + '%'; };
      html += '<div class="cr-kv col">' + row('Health', s.maxHp) + row('Power', Math.round(s.pow)) + row('Armor', Math.round(s.arm)) + row(c.res.name, s.maxRes) + row('Crit chance', pc(s.crit)) + row('Crit damage', '+' + pc(0.5 + s.critDmg)) +
        row('Dodge', pc(s.dodge)) + (s.block ? row('Block', pc(s.block)) : '') + (s.lifesteal ? row('Lifesteal', pc(s.lifesteal)) : '') + (s.regen ? row('Regen', s.regen + '/4t') : '') + row(c.res.name + ' regen', s.resRegen + '/t') +
        (s.thorns ? row('Thorns', pc(s.thorns)) : '') + (s.abilPct ? row('Ability dmg', '+' + pc(s.abilPct)) : '') + (s.goldFind ? row('Gold find', '+' + pc(s.goldFind)) : '') + (s.magicFind ? row('Magic find', '+' + pc(s.magicFind)) : '') +
        (s.resist ? row('Resilience', pc(s.resist)) : '') + (s.elite ? row('vs elites', '+' + pc(s.elite)) : '') + row('Light', (D.BIOMES[G ? G.biome : 'crypt'].light + s.light)) + '</div>';
      var sc = E.setCounts(h); for (var sid in sc) html += '<p class="cr-set">' + esc(D.SETS[sid].name) + ' ' + sc[sid] + '/3</p>';
    } else {
      html += '<div class="cr-h">Story</div><p class="cr-p">' + esc(actName(h)) + '. ' + (h.story.ended ? 'The Hollow King has fallen.' : 'Next: ' + D.BOSSES[D.BIOMES[D.BIOME_ORDER[Math.min(4, h.story.cleared)]].boss].name + ', at the bottom of ' + D.BIOMES[D.BIOME_ORDER[Math.min(4, h.story.cleared)]].name + ' (floor ' + (Math.min(4, h.story.cleared) + 1) * 5 + ').') + '</p>';
      html += '<div class="cr-h">Bounties</div>';
      h.quests.board.forEach(function (b) { html += '<p class="cr-p">' + (b.done ? '✔ ' : '· ') + esc(b.name) + ' — ' + esc(b.text) + ' <i>' + (b.tpl === 'depth' ? '' : b.have + '/' + b.need) + '</i></p>'; });
      var sides = Object.keys(h.quests.side).filter(function (q) { return h.quests.side[q] !== 'done'; });
      if (sides.length) { html += '<div class="cr-h">Errands</div>'; sides.forEach(function (q) { var SQ = D.SIDEQUESTS[q]; html += '<p class="cr-p">' + esc(SQ.name) + ' — ' + (h.quests.side[q] === 'found' ? 'bring the ' + SQ.item + ' to ' + D.NPCS[SQ.giver].name : 'find the ' + SQ.item + ' in ' + D.BIOMES[D.BIOME_ORDER[SQ.act - 1]].name) + '</p>'; }); }
      var bl = h.bless || [];
      if (bl.length) { html += '<div class="cr-h">Blessings & curses</div>'; bl.forEach(function (b) { var Bl = D.BLESSINGS[b.id]; html += '<p class="cr-p">' + Bl.icon + ' ' + esc(Bl.name) + ' — ' + esc(Bl.desc) + ' <i>(' + b.n + ' floors)</i></p>'; }); }
    }
    return html + B('close', 'Close', '', 'cr-b');
  }
  function resHelp(cls) {
    return { warrior: 'builds as you hit and get hit; drains away when no enemy is in sight.', rogue: 'refills quickly every turn.', mage: 'trickles back slowly; kills and tonics restore it.', ranger: 'builds each turn, much faster when you stand your ground.', cleric: 'builds each turn and with every blow you land.', necro: 'flows in when anything dies near you.' }[cls];
  }

  // ---- dungeon modals ---------------------------------------------------------------------
  function showModal() {
    var G = S.G, md = G && G.modal; if (!md || S.ovlOpen) return;
    stopAuto(); if (S.tgt) cancelTarget();
    if (md.k === 'event') openOvl('event', { id: md.id });
    else if (md.k === 'dialog') openOvl('dialog', { who: md.who, lines: md.lines, i: 0, ending: md.ending, onClose: function () { E.closeModal(G); if (md.ending) toEnding(); } });
    else if (md.k === 'tablet') openOvl('tablet', { pz: md.pz, onClose: function () { E.closeModal(G); } });
    else if (md.k === 'lore') openOvl('lore', { idx: md.idx, onClose: function () { E.closeModal(G); } });
    else if (md.k === 'found') openOvl('found', { q: md.q, onClose: function () { E.closeModal(G); } });
    else if (md.k === 'shop') openOvl('dshop', { onClose: function () { E.closeModal(G); } });
  }
  function ovEvent() {
    var ov = S.ov, EV = D.EVENTS[ov.id], html = '<div class="cr-npc">' + tok(EV.col, EV.ch, true) + '<div><b>' + esc(EV.name) + '</b><i>' + esc(D.BIOMES[S.G.biome].name) + '</i></div></div>';
    if (ov.result) {
      html += '<p class="cr-quote">' + esc(ov.result.text) + '</p>';
      if (ov.result.gains && ov.result.gains.length) html += '<p class="cr-gain">' + ov.result.gains.map(esc).join(' · ') + '</p>';
      return html + B('evdone', 'Continue', '', 'cr-go');
    }
    html += '<p class="cr-quote">' + esc(EV.text) + '</p>';
    if (ov.err) html += '<p class="cr-warn">' + esc(ov.err) + '</p>';
    EV.choices.forEach(function (ch, i) {
      var cost = ch.ops && ch.ops.pay ? ' (' + Math.round(ch.ops.pay * (1 + 0.3 * (S.G.ml - 1))) + 'g)' : '';
      html += B('evc', esc(ch.label) + cost, dat('i', i), 'cr-choice');
    });
    return html;
  }
  function ovDialog() {
    var ov = S.ov, who = ov.who, Bs = D.BOSSES[who], N = D.NPCS[who], name = Bs ? Bs.name : N ? N.name : (ov.name || ''), col = Bs ? Bs.col : N ? N.col : '#c0c0c0', ch = Bs ? Bs.ch : N ? N.ch : '?';
    var html = '<div class="cr-npc">' + tok(col, ch, true) + '<div><b>' + esc(name) + '</b><i>' + esc(Bs ? Bs.title : '') + '</i></div></div>';
    html += '<p class="cr-quote big">' + esc(ov.lines[ov.i] || '') + '</p><div class="cr-dots">' + ov.lines.map(function (_, i) { return '<i class="' + (i === ov.i ? 'on' : '') + '"></i>'; }).join('') + '</div>';
    return html + B('dlgnext', ov.i < ov.lines.length - 1 ? 'Continue ▸' : (ov.ending ? 'The end…' : 'Face it'), '', 'cr-go');
  }
  function ovTablet() {
    var P = S.G.pz[S.ov.pz];
    return '<div class="cr-title">RUNE TABLET</div><p class="cr-quote">Four glyphs are carved here, worn but legible. Beneath them: <i>“Walk the order, or burn.”</i></p><div class="cr-runes">' +
      (P ? P.order.map(function (s) { return '<span>' + RUNE_SYM[s] + '</span>'; }).join('<b>→</b>') : '') + '</div><p class="cr-note">Step on the floor runes in this order. A wrong step resets them — painfully.</p>' + B('close', 'Got it', '', 'cr-go');
  }
  function ovLore() { var L = D.LORE[S.ov.idx]; return '<div class="cr-title">LORE</div><div class="cr-h">' + esc(L.title) + '</div><p class="cr-lore big">' + esc(L.text) + '</p><p class="cr-note">Added to Odo\'s archive (' + hero().lore.length + '/' + D.LORE.length + ').</p>' + B('close', 'Continue', '', 'cr-go'); }
  function ovFound() { var SQ = D.SIDEQUESTS[S.ov.q]; return '<div class="cr-title">FOUND</div><p class="cr-quote">' + esc(SQ.ch) + ' ' + esc(SQ.item) + '</p><p class="cr-p">Bring it back to ' + esc(D.NPCS[SQ.giver].name) + ' in Lanternfall.</p>' + B('close', 'Continue', '', 'cr-go'); }
  function ovDShop() {
    var G = S.G, md = G.modal, h = G.hero, html = '<div class="cr-npc">' + tok('#f0d060', '$', true) + '<div><b>Wandering Peddler</b><i>“Prices are steep down here.”</i></div>' + B('close', '✕', ' aria-label="Close"', 'cr-x') + '</div><div class="cr-note">◆ ' + h.gold + ' gold</div>';
    if (S.ov.flash) html += '<p class="cr-flash">' + esc(S.ov.flash) + '</p>';
    (md && md.stock || []).forEach(function (e, i) {
      if (e.sold) return;
      if (e.it) { html += itemRow(e.it, { right: e.price + 'g' }); if (S.ov.sel === e.it.uid) html += itemDetail(e.it, h, B('dbuy', 'Buy for ' + e.price + 'g', dat('i', i) + (h.gold >= e.price ? '' : ' disabled'), 'cr-b pri')); }
      else { var C_ = D.CONSUMABLES[e.cons]; html += '<div class="cr-cons"><span>' + C_.icon + '</span><div><b>' + C_.name + '</b><p>' + esc(C_.desc) + '</p></div>' + B('dbuy', e.price + 'g', dat('i', i) + (h.gold >= e.price ? '' : ' disabled'), 'cr-b pri') + '</div>'; }
    });
    return html + B('close', 'Leave', '', 'cr-b');
  }
  function ovMap() { return '<div class="cr-title">FLOOR ' + S.G.depth + ' — ' + esc(D.BIOMES[S.G.biome].name.toUpperCase()) + '</div><canvas class="cr-bigmap"></canvas><p class="cr-note">◆ you · red: foes · gold: stairs / chests · violet: shrines · cyan: levers</p>' + B('close', 'Close', '', 'cr-go'); }
  function drawBigMap() {
    var cv = S.ovlEl.querySelector('.cr-bigmap'); if (!cv || !S.G) return;
    var G = S.G, w = Math.min(S.cw - 40, 520), cell = Math.max(3, Math.floor(w / G.w)), W = cell * G.w, H = cell * G.h;
    cv.width = W * S.dpr; cv.height = H * S.dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    var c = cv.getContext('2d'); c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    c.fillStyle = S.th.dark ? '#08080c' : rgb(mix(S.th.bg, [0, 0, 0], 0.06)); c.fillRect(0, 0, W, H);
    var fl = S.th.dark ? 'rgba(200,190,170,0.5)' : 'rgba(80,70,60,0.4)';
    for (var y = 0; y < G.h; y++) for (var x = 0; x < G.w; x++) {
      var i = y * G.w + x; if (!G.seen[i]) continue; var t = G.t[i];
      if (t === T.WALL || t === T.CRACK) { c.fillStyle = S.th.dark ? 'rgba(120,110,100,0.35)' : 'rgba(60,50,40,0.25)'; }
      else c.fillStyle = t === T.STAIRS ? '#ffd040' : t === T.WATER || t === T.DEEP ? '#4a90d0' : t === T.LAVA ? '#ff6a2a' : t === T.CHASM ? '#000' : t === T.GATE ? '#c0c0c8' : t === T.PORTAL ? '#9fd0ff' : fl;
      c.fillRect(x * cell, y * cell, cell, cell);
    }
    G.objs.forEach(function (o) { if (!G.seen[o.y * G.w + o.x]) return; var col = o.k === 'chest' ? '#c9a23a' : o.k === 'event' && !o.used ? '#c070ff' : o.k === 'lever' && !o.on ? '#70d0ff' : o.k === 'lore' || o.k === 'quest' ? '#ffe08a' : o.k === 'item' ? rarCol(o.it.rarity) : null; if (col) { c.fillStyle = col; c.fillRect(o.x * cell, o.y * cell, cell, cell); } });
    G.mons.forEach(function (m) { if (E.monVisible(G, m)) { c.fillStyle = m.ally ? '#7fe0a0' : '#e05050'; c.fillRect(m.x * cell, m.y * cell, cell, cell); } });
    c.fillStyle = rgb(S.th.accent); c.beginPath(); c.arc(G.p.x * cell + cell / 2, G.p.y * cell + cell / 2, cell, 0, 7); c.fill();
  }
  function ovLog() { return '<div class="cr-title">LOG</div><div class="cr-logall">' + S.logLines.slice(-80).map(function (l) { return '<div class="cr-ln ' + esc(String(l.c).replace(/[^a-z:]/g, '').replace(':', ' r-')) + '">' + esc(l.s) + '</div>'; }).join('') + '</div>' + B('close', 'Close', '', 'cr-go'); }
  function ovMenu() {
    var G = S.G, h = hero(), html = '<div class="cr-title">PAUSED</div>';
    html += B('close', '▶ Resume', '', 'cr-go');
    html += '<div class="cr-row wrap">' + B('m-sheet', '🎒 Hero (C)') + B('m-map', '🗺 Map (M)') + B('m-log', '📜 Log (L)') + B('help', '? Help') + '</div>';
    if (G && G.mode === 'story') html += B('m-recall', '📜 Read a Recall Scroll (' + (h.cons.recall || 0) + ') — back to town', h.cons.recall ? '' : ' disabled');
    if (G && G.mode === 'daily') html += B('m-abandon', S.abArm ? 'Really end the challenge?' : '☀ End the daily challenge', '', 'cr-b' + (S.abArm ? ' danger' : ''));
    html += setRow();
    html += B('m-title', '⏏ Save & quit to title') + '<p class="cr-note">Your delve is saved — you\'ll resume right here.</p>';
    return html;
  }
  function ovHelp() {
    return '<div class="cr-title">HOW TO PLAY</div>' +
      '<p class="cr-p">Descend beneath Lanternfall, floor by floor. Every fifth floor holds a boss; beat it to open a portal home and unlock a waypoint. Monsters move when you move — the game is turn-based, so think.</p>' +
      '<div class="cr-keys"><span><b>Arrows / WASD / D-pad / swipe</b> move &amp; attack (bump)</span><span><b>Tap a tile</b> travel there · <b>tap a foe</b> target it (tap again to attack)</span><span><b>Enter / E / ✋</b> use: stairs, levers, chests, shrines</span><span><b>Space / ⏳</b> wait a turn — with no foes in sight, rest until healed</span><span><b>1–5</b> abilities · <b>Q</b> potion · <b>B</b> bomb · <b>Tab</b> cycle target</span><span><b>X / 🧭</b> auto-explore · <b>C</b> hero · <b>M</b> map · <b>L</b> log · <b>Esc</b> menu</span></div>' +
      '<div class="cr-h">Read the danger</div><p class="cr-p">Red tiles are an attack winding up — it lands next turn. Step out! A number on the tiles means more turns of warning. Stunning or freezing a monster interrupts it. Glowing vents burst on a rhythm.</p>' +
      '<div class="cr-h">Elites</div><p class="cr-p">Ringed monsters are champions with affixes (vampiric, shielded, splitting, hasted…). They hit harder and always drop loot.</p>' +
      '<div class="cr-h">Puzzles</div><p class="cr-p">Sealed gates open with levers somewhere on the floor, boulders pushed onto plates (a red-knobbed lever resets them), or runes stepped in the order shown on a nearby tablet. Every puzzle is solvable.</p>' +
      '<div class="cr-h">Death</div><p class="cr-p">You wake in Lanternfall, lighter of purse; unequipped loot found that trip is lost (except on Relaxed). Read a Recall Scroll to bring everything home safely.</p>' +
      B('close', 'Got it', '', 'cr-go');
  }
  function ovPrologue() {
    var ov = S.ov, lines = D.STORY.prologue;
    return '<div class="cr-title">' + (ov.i === 0 ? 'LANTERNFALL' : '…') + '</div><p class="cr-quote big">' + esc(lines[ov.i]) + '</p><div class="cr-dots">' + lines.map(function (_, i) { return '<i class="' + (i === ov.i ? 'on' : '') + '"></i>'; }).join('') + '</div>' + B('prolnext', ov.i < lines.length - 1 ? 'Continue ▸' : 'Enter Lanternfall', '', 'cr-go');
  }

  // ---- end-of-run screens -----------------------------------------------------------------
  function scrDeath() {
    var d = S.death || {}, html = '<div class="cr-card"><pre class="cr-art red">  YOU HAVE FALLEN  </pre><p class="cr-quote">Slain by ' + esc(d.killer || 'the Deep') + ' on floor ' + d.depth + '.</p>';
    html += '<div class="cr-kv col"><span>Kills <b>' + d.kills + '</b></span><span>Gold found <b>' + d.gold + '</b></span><span>Floors <b>' + d.floors + '</b></span></div>';
    html += '<p class="cr-p">You wake in the Lantern Inn, aching. ' + (d.lost.gold ? 'Your purse is ' + d.lost.gold + ' gold lighter. ' : '') + (d.lost.items.length ? 'Lost in the dark: ' + d.lost.items.map(esc).join(', ') + '.' : 'Your pack made it back with you.') + '</p>';
    return html + B('totown', 'Return to Lanternfall', '', 'cr-go') + '</div>';
  }
  function scrDaily() {
    var info = E.dailyInfo(today()), R = S.R, dd = R.daily.days[info.date], C_ = D.CLASSES[info.cls], M = D.DAILY_MODS[info.mod], snap = jget(K_RUN + 'daily');
    var html = '<div class="cr-card"><div class="cr-title">DAILY CHALLENGE</div><p class="cr-quote">' + info.date + ' — the same dungeon for everyone today.</p>';
    html += '<div class="cr-hchip">' + tok(C_.color, '@', true) + '<div><b>' + C_.name + '</b><span>level 3 · starting kit</span></div></div>';
    html += '<div class="cr-h">Today\'s twist: ' + esc(M.name) + '</div><p class="cr-p">' + esc(M.desc) + '</p>';
    html += '<p class="cr-p">Dive as deep as you can. Score = depth, kills, elites, bosses and gold. Death ends the run.</p>';
    html += '<div class="cr-kv col"><span>Best today <b>' + (dd ? dd.best : '—') + '</b></span><span>Tries <b>' + (dd ? dd.tries : 0) + '</b></span><span>All-time <b>' + (R.daily.best ? R.daily.best.score + ' (' + R.daily.best.date + ')' : '—') + '</b></span></div>';
    if (snap && snap.daily && snap.daily.date === info.date) html += B('dresume', '▶ Resume today\'s run — floor ' + snap.depth, '', 'cr-go');
    html += B('dstart', snap && snap.daily && snap.daily.date === info.date ? 'Start over' : '▶ Begin', '', snap && snap.daily && snap.daily.date === info.date ? 'cr-b' : 'cr-go');
    return html + B('back', '← Back') + '</div>';
  }
  function scrDailyOver() {
    var d = S.dres || {}, html = '<div class="cr-card"><div class="cr-title">CHALLENGE OVER</div><div class="cr-big">' + d.score + '</div><p class="cr-quote">' + esc(d.why) + ' on floor ' + d.depth + '.</p>';
    if (d.rec && d.rec.allTime) html += '<p class="cr-new">★ New all-time best!</p>'; else if (d.rec && d.rec.best) html += '<p class="cr-new">★ New best today!</p>';
    html += '<div class="cr-kv col"><span>Kills <b>' + d.kills + '</b></span><span>Elites <b>' + d.elites + '</b></span><span>Bosses <b>' + d.bosses + '</b></span><span>Gold <b>' + d.gold + '</b></span></div>';
    return html + B('totitle', 'Back to the title', '', 'cr-go') + '</div>';
  }
  function scrEnding() {
    var h = S.hero, html = '<div class="cr-card"><canvas class="cr-scene"></canvas><div class="cr-title">THE SUNSTONE BURNS</div>';
    D.STORY.ending.forEach(function (l) { html += '<p class="cr-p">' + esc(l) + '</p>'; });
    html += '<div class="cr-kv col"><span>Level <b>' + h.level + '</b></span><span>Kills <b>' + h.stats.kills + '</b></span><span>Deaths <b>' + h.stats.deaths + '</b></span><span>Lore <b>' + h.lore.length + '/' + D.LORE.length + '</b></span></div>';
    return html + B('totown', 'Return to Lanternfall', '', 'cr-go') + '<p class="cr-note">From town: keep descending past floor 25 (the Endless Descent), or begin New Game+.</p></div>';
  }

  // ===========================================================================
  //  flows: town ⇄ dungeon
  // ===========================================================================
  function setMode(dungeon) {
    S.root.classList.toggle('in-town', !dungeon);
    if (dungeon) { layout(); }
    refreshHud();
  }
  function goTown(opts) {
    opts = opts || {};
    S.G = null; S.tgt = null; S.auto = null; S.stock = null;
    S.hero = S.R.slots[S.R.active];
    if (!S.hero) { showScreen('title'); return; }
    if (S.hero.needsClass) { S.create = { vet: S.hero, cls: null }; showScreen('create'); return; }
    if (opts.arrive) E.townArrive(S.hero);
    setMode(false);
    showScreen('town');
    markDirty();
  }
  function startDelve(depth) {
    var h = S.hero; if (!h) return;
    S.snd.ensure();
    clearRun('story', h.id);
    S.G = E.startRun(h, depth);
    enterDungeon();
    markDirty();
  }
  function enterDungeon() {
    hideScreen(); S.vis = {}; S.snapCam = true; S.tilesDirty = true; S.logEl.innerHTML = ''; S.logLines = []; S.fx = newFx();
    setMode(true);
    (S.G.log || []).slice(-3).forEach(function (l) { addLog(l.s, l.c); });
    S.G.ev = S.G.ev.filter(function (e) { return e.t !== 'log'; });
    drainEvents(); refreshHud();
    if (S.G.modal) showModal();
    try { S.cv.focus({ preventScroll: true }); } catch (e) {}
    if (S.set.hints && !S.hintShown && S.G.depth === 1 && S.hero && S.hero.stats.runs <= 1) { S.hintShown = true; addLog('Tip: tap a tile to walk there, tap a foe to target it. 🧭 explores for you.', 'info'); }
  }
  function resumeRun(h) {
    var snap = runSnapFor(h); if (!snap) return false;
    var G = E.loadRun(snap, h); if (!G) { clearRun('story', h.id); return false; }
    S.G = G; S.hero = h; enterDungeon(); addLog('You pick up where you left off.', 'info');
    return true;
  }
  function finishRun() {
    var G = S.G, h = G.hero;
    saveNowRun(false);
    if (G.mode === 'daily') {
      var info = G.daily, score = E.dailyScore(G), rec = E.recordDaily(S.R, info, score, G.depth);
      S.dres = { score: score, rec: rec, depth: G.depth, kills: G.run.kills, elites: G.run.elites, bosses: G.run.bosses, gold: G.run.gold, why: G.over === 'dead' ? 'Slain by ' + (G.killer || 'the Deep') : 'You walked away' };
      clearRun('daily'); S.G = null; markDirty(); setMode(false); S.snd.play(G.over === 'dead' ? 'death' : 'solve');
      setTimeout(function () { if (S) showScreen('dailyover'); }, G.over === 'dead' ? 900 : 0);
      return;
    }
    E.syncHero(G);
    clearRun('story', h.id);
    if (G.over === 'dead') {
      var lost = E.applyDeath(G);
      S.death = { killer: G.killer, depth: G.depth, kills: G.run.kills, gold: G.run.gold, floors: G.run.floors, lost: lost };
      S.snd.play('death');
      E.townArrive(h); S.G = null; markDirty();
      setTimeout(function () { if (S) { setMode(false); showScreen('death'); } }, 1000);
      return;
    }
    // recall / portal: safe return with everything
    var ended = !!G.ending;
    S.snd.play('stairs');
    S.G = null; E.townArrive(h); markDirty();
    if (ended) { setMode(false); showScreen('ending'); return; }
    goTown();
    var got = G.run.items ? G.run.items + ' item' + (G.run.items > 1 ? 's' : '') + ', ' : '';
    setTimeout(function () { if (S && S.screen === 'town') msg('BACK IN LANTERNFALL', 'You return with ' + got + G.run.gold + ' gold and ' + G.run.kills + ' kills from ' + (G.run.floors + 1) + ' floor' + (G.run.floors ? 's' : '') + '. You are fully restored.'); }, 50);
  }
  function saveNowRun(keep) { if (S.runT) { clearTimeout(S.runT); S.runT = 0; } if (keep !== false) saveRunNow(); }
  function toEnding() { /* the outro dialog closed: the portal still has to be used — just nudge */ addLog('A portal home shimmers in the arena. Use it to return to Lanternfall.', 'good'); }

  // ===========================================================================
  //  clicks (all buttons delegate here)
  // ===========================================================================
  function onClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b || !S || !S.root.contains(b) || b.disabled) return;
    S.snd.ensure();
    var a = b.getAttribute('data-act'), id = b.getAttribute('data-id'), uid = b.getAttribute('data-uid'), ix = b.getAttribute('data-i'), tt = b.getAttribute('data-t');
    if (a !== 'd' && a !== 'ab' && a !== 'potion') S.snd.play('ui');
    var h = S.hero, R = S.R, ov = S.ov;
    if (a !== 'del') S.delArm = null;
    if (a !== 'drop') S.dropArm = null;
    if (a !== 'talent') S.talArm = null;
    if (a !== 'respec') S.respecArm = false;
    if (a !== 'ngplus') S.ngArm = false;
    if (a !== 'm-abandon') S.abArm = false;
    switch (a) {
      // --- title / roster / create
      case 'retry': boot(); break;
      case 'continue':
        if (!h) break;
        if (h.needsClass) { S.create = { vet: h, cls: null }; showScreen('create'); break; }
        if (!resumeRun(h)) goTown();
        break;
      case 'heroes': S.G = null; showScreen('roster'); break;
      case 'new': S.create = { cls: null, name: E.randomName(E.rng(Date.now() & 0xffffff)), diff: 'normal' }; showScreen('create'); break;
      case 'pick': R.active = id; S.hero = R.slots[id]; markDirty(); showScreen('title'); break;
      case 'del':
        if (S.delArm !== id) { S.delArm = id; renderScreen(); break; }
        S.delArm = null; delete R.slots[id]; R.deleted[id] = Date.now(); R.order = R.order.filter(function (x) { return x !== id; });
        clearRun('story', id); if (R.active === id) R.active = R.order[0] || null; S.hero = R.slots[R.active] || null; markDirty(); renderScreen(); break;
      case 'back': showScreen(S.screen === 'create' && S.create && S.create.vet ? 'title' : S.screen === 'daily' ? 'title' : S.screen === 'create' ? 'title' : 'title'); break;
      case 'cls': S.create.cls = id; renderScreen(); break;
      case 'diff': S.create.diff = id; renderScreen(); break;
      case 'rname': S.create.name = E.randomName(E.rng((Date.now() ^ (Math.random() * 1e9)) >>> 0)); S.create.typing = false; renderScreen(); break;
      case 'tname': S.create.typing = true; renderScreen(); var inp = S.scrEl.querySelector('.cr-in'); if (inp) { inp.focus(); inp.select(); inp.addEventListener('input', function () { S.create.name = inp.value; }); inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); S.create.name = E.cleanName(inp.value); S.create.typing = false; renderScreen(); } }); } break;
      case 'begin':
        var cr = S.create; if (!cr || !cr.cls) break;
        if (cr.vet) { E.setClass(cr.vet, cr.cls); S.hero = cr.vet; markDirty(); goTown({ arrive: true }); msg('WELCOME BACK', 'The Deep has changed since your last descent — and so have you. Your old gear has been reforged for a ' + D.CLASSES[cr.cls].name + ' (check your pack), your progress carried over as waypoints. Lanternfall remembers you.'); break; }
        var nh = E.newHero(cr.cls, E.cleanName(cr.name), cr.diff, E.rng((Date.now() ^ (Math.random() * 1e9)) >>> 0));
        R.slots[nh.id] = nh; R.order.push(nh.id); R.active = nh.id; S.hero = nh; markDirty();
        goTown({ arrive: true }); openOvl('prologue', { i: 0 }); break;
      case 'prolnext': if (ov.i < D.STORY.prologue.length - 1) { ov.i++; renderOvl(); } else closeOvl(); break;
      case 'set':
        S.set[id || b.getAttribute('data-k')] = !S.set[id || b.getAttribute('data-k')]; saveSettings();
        if ((id || b.getAttribute('data-k')) === 'sound') { S.snd.on = S.set.sound; S.snd.ensure(); syncHead(); }
        if (S.mini) S.mini.hidden = !S.set.mini;
        if (S.ovlOpen) renderOvl(); else renderScreen(); break;
      case 'help': openOvl('help'); break;
      case 'daily': S.G = null; showScreen('daily'); break;
      case 'dstart': var info = E.dailyInfo(today()), dh = E.dailyHero(info); clearRun('daily'); S.G = E.startRun(dh, 1, { daily: info, seed: info.seed }); S.G.daily = info; enterDungeon(); addLog('Daily twist: ' + D.DAILY_MODS[info.mod].name + ' — ' + D.DAILY_MODS[info.mod].desc, 'warn'); break;
      case 'dresume': var snap = jget(K_RUN + 'daily'), G2 = snap && E.loadRun(snap, null); if (G2) { S.G = G2; enterDungeon(); } else { clearRun('daily'); renderScreen(); } break;
      case 'totitle': showScreen('title'); break;
      case 'totown': goTown(); break;
      // --- town
      case 'wp': S.wp = +id; renderScreen(); break;
      case 'descend': startDelve(S.wp || 1); break;
      case 'ngplus': if (!S.ngArm) { S.ngArm = true; renderScreen(); break; } S.ngArm = false; E.newGamePlus(h); S.wp = 1; markDirty(); renderScreen(); msg('NEW GAME+', 'The Deep remembers you — and it has been preparing. Every foe is far deadlier now; every treasure far richer. Begin again at floor 1.'); break;
      case 'place': if (id === 'stash') openOvl('stash', { wide: true }); else openOvl('npc:' + id, { wide: true }); break;
      case 'sheet': openOvl('sheet', { wide: true, tab: E.talentPoints(hero()) ? 'tal' : 'gear' }); break;
      case 'close': closeOvl(); break;
      case 'otab': ov.tab = tt; ov.sel = null; ov.flash = null; renderOvl(); break;
      case 'tab': ov.tab = tt; renderOvl(); break;
      case 'story': ov.story = !ov.story; renderOvl(); break;
      case 'rest': ov.rested = true; S.snd.play('heal'); renderOvl(); break;
      case 'sq-accept': E.acceptSide(h, id); ov.line = D.SIDEQUESTS[id].text; markDirty(); renderOvl(); break;
      case 'sq-turn': var got = E.turnInSide(h, id); if (got) { ov.line = D.SIDEQUESTS[id].done; ov.flash = 'Reward: ' + got.join(', '); S.snd.play('solve'); markDirty(); } renderOvl(); refreshHud(); break;
      case 'isel': ov.sel = ov.sel === uid ? null : uid; renderOvl(); break;
      case 'up': var ur = E.upgradeItem(h, uid); ov.flash = ur.ok ? ur.it.name + ' is now +' + ur.it.plus + '!' : ur.msg; if (ur.ok) { S.snd.play('solve'); markDirty(); } renderOvl(); break;
      case 'ref': var rf = E.reforgeItem(h, uid, E.rng((Date.now() ^ (Math.random() * 1e9)) >>> 0)); ov.flash = rf.ok ? 'Reforged into ' + rf.it.name + '.' : rf.msg; if (rf.ok) { S.snd.play('rare'); markDirty(); } renderOvl(); break;
      case 'salv': var y = E.salvageItem(h, uid); if (y) { ov.flash = 'Salvaged for ' + matTxt(y) + '.'; ov.sel = null; S.snd.play('chest'); markDirty(); } renderOvl(); break;
      case 'craft': var ci = E.craftItem(h, id, tt, E.rng((Date.now() ^ (Math.random() * 1e9)) >>> 0)); ov.flash = ci ? 'Torvald hands you: ' + ci.name + '.' : 'Not enough materials.'; if (ci) { S.snd.play('rare'); markDirty(); } renderOvl(); break;
      case 'buy':
        if (!S.stock) break;
        var entry = ix.charAt(0) === 'c' ? S.stock.cons[+ix.slice(1)] : S.stock.items[+ix.slice(1)], br = E.buy(h, entry);
        ov.flash = br.ok ? 'Bought ' + (entry.it ? entry.it.name : D.CONSUMABLES[entry.cons].name) + '.' : br.msg; if (br.ok) { S.snd.play('gold'); ov.sel = null; markDirty(); } renderOvl(); break;
      case 'sell': var v = E.sellItem(h, uid); if (v) { ov.flash = 'Sold for ' + v + 'g.'; ov.sel = null; S.snd.play('gold'); markDirty(); } renderOvl(); break;
      case 'sellcommons': var tot = 0; h.bag.slice().forEach(function (it) { if (it.rarity === 'common') tot += E.sellItem(h, it.uid); }); ov.flash = tot ? 'Sold the junk for ' + tot + 'g.' : 'No common items to sell.'; if (tot) { S.snd.play('gold'); markDirty(); } renderOvl(); break;
      case 'uncurse': if (E.uncurse(h)) { ov.flash = 'The curses lift.'; S.snd.play('holy'); markDirty(); } renderOvl(); break;
      case 'bless': if (E.buyBlessing(h, id)) { ov.flash = D.BLESSINGS[id].name + ' — it will last your next 3 floors.'; S.snd.play('holy'); markDirty(); } renderOvl(); break;
      case 'respec': if (!S.respecArm) { S.respecArm = true; renderOvl(); break; } S.respecArm = false; if (E.respec(h)) { ov.flash = 'Your talents are yours to choose again.'; markDirty(); } renderOvl(); break;
      case 'lore': ov.page = ov.page === +ix ? null : +ix; renderOvl(); break;
      case 'claim': var rw = E.claimBounty(h, id); if (rw) { ov.flash = 'Claimed ' + rw.gold + 'g and ' + rw.xp + ' XP.'; S.snd.play('gold'); markDirty(); } renderOvl(); break;
      case 'stash-put': if (E.stashPut(R, h, uid)) { markDirty(); S.snd.play('pick'); } renderOvl(); break;
      case 'stash-take': if (E.stashTake(R, h, uid)) { markDirty(); S.snd.play('pick'); } renderOvl(); break;
      // --- hero sheet
      case 'equip': if (E.equip(hero(), uid)) { ov.sel = null; S.snd.play('pick'); markDirty(); if (S.G) S.G._ps = null; } renderOvl(); refreshHud(); break;
      case 'unequip': if (E.unequip(hero(), id)) { markDirty(); } else ov.flash = 'Your pack is full.'; renderOvl(); refreshHud(); break;
      case 'drop': if (S.dropArm !== uid) { S.dropArm = uid; renderOvl(); break; } var hf = E.findItem(hero(), uid); if (hf && hf.where === 'bag') hero().bag.splice(hf.idx, 1); S.dropArm = null; ov.sel = null; markDirty(); renderOvl(); break;
      case 'talent': if (S.talArm !== id) { S.talArm = id; renderOvl(); break; } S.talArm = null; if (E.chooseTalent(hero(), +ix, id)) { S.snd.play('level'); ov.flash = 'Talent learned.'; if (S.G) S.G._ps = null; markDirty(); } renderOvl(); refreshHud(); break;
      case 'usecons': closeOvl(); if (id === 'bomb') bombPress(); else doAct({ t: 'cons', id: id }); break;
      // --- dungeon
      case 'ab': abilityPress(id); break;
      case 'potion': usePotion(); break;
      case 'tgtgo': confirmTarget(); break;
      case 'tgtx': cancelTarget(); break;
      case 'pad': padAction(id); break;
      case 'evc':
        var res = E.eventChoice(S.G, +ix);
        if (!res) break;
        if (res.shop) { closeOvlQuiet(); showModal(); break; }
        if (!res.ok) { ov.err = res.text; renderOvl(); break; }
        if (!res.done) { closeOvlQuiet(); afterAct(); break; }
        ov.result = res; S.tilesDirty = true; drainEvents(); refreshHud(); renderOvl(); markDirty(); break;
      case 'evdone': closeOvlQuiet(); afterAct(); break;
      case 'dlgnext': if (ov.i < ov.lines.length - 1) { ov.i++; renderOvl(); } else closeOvl(); break;
      case 'dbuy':
        var md = S.G.modal, en = md && md.stock[+ix];
        if (en) { var bb = E.buy(hero(), en); if (bb.ok && en.cons) en.sold = true; ov.flash = bb.ok ? 'Bought.' : bb.msg; if (bb.ok) { S.snd.play('gold'); markDirty(); } }
        renderOvl(); refreshHud(); break;
      case 'm-sheet': S.ov = null; openOvl('sheet', { wide: true }); break;
      case 'm-map': openOvl('map', { wide: true }); break;
      case 'm-log': openOvl('log'); break;
      case 'm-recall': closeOvlQuiet(); doAct({ t: 'cons', id: 'recall' }); break;
      case 'm-abandon': if (!S.abArm) { S.abArm = true; renderOvl(); break; } S.abArm = false; closeOvlQuiet(); S.G.over = 'quit'; finishRun(); break;
      case 'm-title': closeOvlQuiet(); saveNowRun(); saveNow(); S.G = null; setMode(false); showScreen('title'); break;
    }
  }
  function closeOvlQuiet() { S.ovlOpen = false; S.ovlEl.hidden = true; S.ovlEl.innerHTML = ''; S.ov = null; }
  function padAction(id) {
    if (!S.G) return;
    if (id === 'use') useKey();
    else if (id === 'rest') restKey();
    else if (id === 'explore') { stopAuto(); if (S.tgt) cancelTarget(); startExplore(); }
    else if (id === 'sheet') openOvl('sheet', { wide: true, tab: E.talentPoints(hero()) ? 'tal' : 'gear' });
    else if (id === 'map') openOvl('map', { wide: true });
    else if (id === 'menu') openOvl('menu');
  }

  // ===========================================================================
  //  input
  // ===========================================================================
  function isTyping(e) {
    var t = e.target; if (!t || !t.tagName) return false;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return true;
    return !!(t.closest && t.closest('.cm-editor'));
  }
  var DIR = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1], a: [-1, 0], d: [1, 0], w: [0, -1], s: [0, 1], h: [-1, 0], l: [1, 0], k: [0, -1], j: [0, 1] };
  function onKey(e) {
    if (!S || !S.panel.isConnected) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    if (isTyping(e)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    S.kbd = true; S.snd.ensure();
    if (S.ovlOpen || S.screen) { navKey(e, S.ovlOpen ? S.ovlEl : S.scrEl); return; }
    if (!S.G) return;
    var kl = k.length === 1 ? k.toLowerCase() : k;
    if (S.tgt) {
      var dd = DIR[k] || (k.length === 1 && 'wasd'.indexOf(kl) >= 0 ? DIR[kl] : null);
      if (dd) { e.preventDefault(); moveCursor(dd[0], dd[1]); return; }
      if (k === 'Enter' || k === ' ' || kl === 'e') { e.preventDefault(); confirmTarget(); return; }
      if (k === 'Escape') { e.preventDefault(); cancelTarget(); return; }
      if (k === 'Tab') { e.preventDefault(); cycleTarget(); return; }
      if (k >= '1' && k <= '5') { e.preventDefault(); var ab0 = E.abilitiesFor(S.G.hero)[+k - 1]; if (ab0) abilityPress(ab0.id); return; }
      if (kl === 'b' && S.tgt.id === 'bomb') { e.preventDefault(); confirmTarget(); return; }
      return;
    }
    var handled = true;
    if (S.auto && k !== 'Shift') { stopAuto(); if (k === ' ' || k === 'x') { e.preventDefault(); return; } }
    var dir = DIR[k] || ('wasd'.indexOf(kl) >= 0 && kl.length === 1 ? DIR[kl] : null);
    if (dir) move(dir[0], dir[1]);
    else if (k === 'Enter' || kl === 'e' || kl === 'g') useKey();
    else if (k === ' ' || k === '.') restKey();
    else if (k >= '1' && k <= '5') { var ab = E.abilitiesFor(S.G.hero)[+k - 1]; if (ab) abilityPress(ab.id); }
    else if (kl === 'q') usePotion();
    else if (kl === 'b') bombPress();
    else if (kl === 'c' || kl === 'i') padAction('sheet');
    else if (kl === 'm') padAction('map');
    else if (kl === 'l') openOvl('log');
    else if (kl === 'x') padAction('explore');
    else if (kl === 'r') { if (S.G.hero.cons.tonic) doAct({ t: 'cons', id: 'tonic' }); }
    else if (k === 'Tab') cycleTarget();
    else if (k === 'Escape' || kl === 'p') padAction('menu');
    else if (k === '?') openOvl('help');
    else handled = false;
    if (handled) e.preventDefault();
  }
  function navKey(e, root) {
    var k = e.key;
    if (e.target && e.target.classList && e.target.classList.contains('cr-in')) return;
    var els = Array.prototype.filter.call(root.querySelectorAll('button:not([disabled])'), function (b) { return b.offsetParent !== null; });
    if (!els.length) return;
    var cur = els.indexOf(document.activeElement) >= 0 ? document.activeElement : null;
    var d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[k];
    if (d) {
      e.preventDefault();
      if (!cur) { focusEl(root.querySelector('.cr-go:not([disabled])') || els[0]); return; }
      var r0 = cur.getBoundingClientRect(), x0 = r0.left + r0.width / 2, y0 = r0.top + r0.height / 2, best = null, bd = 1e9;
      els.forEach(function (b) {
        if (b === cur) return;
        var r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, vx = x - x0, vy = y - y0;
        var along = vx * d[0] + vy * d[1]; if (along <= 4) return;
        var across = Math.abs(vx * d[1]) + Math.abs(vy * d[0]), sc = along + across * 2.2;
        if (sc < bd) { bd = sc; best = b; }
      });
      if (best) focusEl(best);
      return;
    }
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      var tgt = cur || root.querySelector('.cr-go:not([disabled])') || els[0];
      if (tgt) tgt.click();
      return;
    }
    if (k === 'Tab') { e.preventDefault(); var i = cur ? els.indexOf(cur) : -1; focusEl(els[(i + (e.shiftKey ? -1 : 1) + els.length) % els.length]); return; }
    if (k === 'Escape') {
      e.preventDefault();
      if (S.ovlOpen) { if (S.ov && (S.ov.k === 'event' && !S.ov.result)) return; if (S.ov && S.ov.k === 'dialog') { root.querySelector('[data-act="dlgnext"]').click(); return; } if (S.ov && S.ov.k === 'prologue') { closeOvl(); return; } if (S.ov && S.ov.k === 'event') { root.querySelector('[data-act="evdone"]').click(); return; } closeOvl(); return; }
      if (S.screen === 'roster' || S.screen === 'daily' || S.screen === 'create') showScreen('title');
    }
  }
  function focusEl(b) { if (!b) return; try { b.focus({ preventScroll: true }); b.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  function screenToTile(cx, cy) {
    var r = S.cv.getBoundingClientRect(), lx = (cx - r.left) * (S.cw / r.width), ly = (cy - r.top) * (S.chh / r.height);
    return { x: Math.floor((lx - S.ox) / S.ts), y: Math.floor((ly - S.oy) / S.ts) };
  }
  function tapTile(tx, ty) {
    var G = S.G; if (!G || tx < 0 || ty < 0 || tx >= G.w || ty >= G.h) return;
    stopAuto();
    var p = G.p, dx = tx - p.x, dy = ty - p.y, md = Math.abs(dx) + Math.abs(dy);
    if (!md) { useKey(); return; }
    var m = E.monAt(G, tx, ty);
    if (m && !m.ally && E.monVisible(G, m) && !m.disguised) {
      if (md === 1) { doAct({ t: 'move', dx: dx, dy: dy }); return; }
      if (G.p.target !== m.id) {
        G.p.target = m.id;
        addLog('◎ ' + E.displayName(m) + ' — ' + m.hp + '/' + m.maxHp + ' HP' + (m.elite ? ' · ' + m.elite.map(function (a) { return D.ELITE[a].desc; }).join(', ') : '') + (m.asleep ? ' · asleep' : '') + '. Tap again to close in.', 'info');
        refreshAbil(); return;
      }
      if (!startTravel(tx, ty)) addLog('No clear path.', 'info');
      return;
    }
    if (md === 1) { doAct({ t: 'move', dx: dx, dy: dy }); return; }
    if (!G.seen[ty * G.w + tx]) { addLog('You don\'t know the way there yet.', 'info'); return; }
    if (!startTravel(tx, ty)) addLog('No safe path there.', 'info');
  }
  function bindCanvas() {
    var cv = S.cv, st = null;
    cv.addEventListener('pointerdown', function (e) {
      if (!S || !S.G) return;
      e.preventDefault(); S.snd.ensure();
      try { cv.setPointerCapture(e.pointerId); } catch (er) {}
      st = { x: e.clientX, y: e.clientY, id: e.pointerId };
      S.kbd = false;
    });
    cv.addEventListener('pointerup', function (e) {
      if (!S || !st || st.id !== e.pointerId) return;
      var dx = e.clientX - st.x, dy = e.clientY - st.y; st = null;
      if (!S.G || S.screen || S.ovlOpen) return;
      if (Math.abs(dx) > 26 || Math.abs(dy) > 26) {
        var d = Math.abs(dx) > Math.abs(dy) ? [dx > 0 ? 1 : -1, 0] : [0, dy > 0 ? 1 : -1];
        move(d[0], d[1]); return;
      }
      var t = screenToTile(e.clientX, e.clientY);
      if (S.tgt) {
        if (S.tgt.list.some(function (q) { return q.x === t.x && q.y === t.y; })) confirmTarget(t.x, t.y);
        else { S.tgt.cur = { x: t.x, y: t.y }; addLog('Out of range — tap a highlighted tile.', 'info'); }
        return;
      }
      tapTile(t.x, t.y);
    });
    cv.addEventListener('pointercancel', function () { st = null; });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }
  function bindPad() {
    var dp = S.padEl.querySelector('.cr-dpad');
    function dirAct(id) {
      if (!S || !S.G || S.screen || S.ovlOpen) return;
      if (id === 'w') { restKey(); return; }
      var d = { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] }[id];
      if (d) move(d[0], d[1]);
    }
    function stop() { if (S && S.hold) { clearTimeout(S.hold.t); clearInterval(S.hold.iv); S.hold = null; } }
    dp.addEventListener('pointerdown', function (e) {
      var b = e.target.closest('[data-act="d"]'); if (!b) return;
      e.preventDefault(); S.snd.ensure(); S.kbd = false;
      try { b.setPointerCapture(e.pointerId); } catch (er) {}
      stop();
      var id = b.getAttribute('data-id');
      Cade.haptic && Cade.haptic(5);
      dirAct(id);
      if (id !== 'w') S.hold = { t: setTimeout(function () { if (S && S.hold) S.hold.iv = setInterval(function () { dirAct(id); }, 150); }, 320) };
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) { dp.addEventListener(ev, stop); });
  }
  function syncHead() {
    if (!S) return;
    var b = S.head.querySelector('[data-h="sound"]');
    b.innerHTML = S.set.sound ? IC_SND_ON : IC_SND_OFF; b.title = S.set.sound ? 'Sound on' : 'Sound off'; b.classList.toggle('on', S.set.sound);
  }

  // ===========================================================================
  //  open / close
  // ===========================================================================
  function newFx() { return { parts: [], texts: [], projs: [], rings: [], areas: [], ghosts: [], banner: null, flash: null }; }
  function teardown() {
    if (!S) return;
    try { if (S.G && !S.G.over) saveRunNow(); if (S.R) saveNow(true); } catch (e) {}
    clearTimeout(S.fbT);
    detachFb();
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.saveT); clearTimeout(s.runT); clearTimeout(s.resizeT);
    if (s.hold) { clearTimeout(s.hold.t); clearInterval(s.hold.iv); }
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('resize', s.onResize);
    window.removeEventListener('orientationchange', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.ro) s.ro.disconnect();
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    [s.cv, s.layer, s.mini].forEach(function (c) { if (c) { c.width = 0; c.height = 0; } });
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }
  function boot() {
    showScreen('loading');
    loadAll().then(function () {
      if (!S) return;
      T = E.T;
      loadRoster(function (R) {
        if (!S) return;
        S.R = R; S.hero = R.slots[R.active] || null;
        sset(K_ROSTER, JSON.stringify(R));
        attachFb();
        showScreen('title');
      });
    }).catch(function () { if (S) showScreen('error'); });
  }
  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel(); return;
    }
    var pad = '<div class="cr-dpad">' +
      '<button type="button" class="cr-d u" data-act="d" data-id="u" aria-label="Up">▲</button><button type="button" class="cr-d l" data-act="d" data-id="l" aria-label="Left">◀</button>' +
      '<button type="button" class="cr-d w" data-act="d" data-id="w" aria-label="Wait">⏳</button><button type="button" class="cr-d r" data-act="d" data-id="r" aria-label="Right">▶</button>' +
      '<button type="button" class="cr-d dn" data-act="d" data-id="d" aria-label="Down">▼</button></div>' +
      '<div class="cr-acts">' + [['use', '✋', 'Use'], ['explore', '🧭', 'Explore'], ['sheet', '🎒', 'Hero'], ['rest', '💤', 'Rest'], ['map', '🗺', 'Map'], ['menu', '☰', 'Menu']].map(function (a) {
        return '<button type="button" class="cr-pa' + (a[0] === 'use' ? ' main' : '') + '" data-act="pad" data-id="' + a[0] + '"><span>' + a[1] + '</span><i>' + a[2] + '</i></button>';
      }).join('') + '</div>';
    var body = '<div class="cr in-town">' +
      '<div class="cr-hud"><div class="cr-bars"><div class="cr-bar cr-hpb"><i></i><span></span></div><div class="cr-bar cr-resb"><i></i><span></span></div><div class="cr-xpb"><i></i></div></div>' +
      '<div class="cr-meta"><b class="cr-where"></b><span class="cr-gold"></span></div></div>' +
      '<div class="cr-stage"><canvas class="cr-cv" tabindex="0" aria-label="Dungeon"></canvas><canvas class="cr-mini" aria-hidden="true"></canvas><div class="cr-chips"></div>' +
      '<div class="cr-bossb" hidden><b></b><div><i></i></div></div><div class="cr-log" aria-live="polite"></div><div class="cr-tgtbar" hidden></div></div>' +
      '<div class="cr-abil"></div><div class="cr-pad">' + pad + '</div>' +
      '<div class="cr-scr" hidden></div><div class="cr-ovl" hidden></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '⚔ Dungeon Crawler', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'cr-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button><button type="button" data-h="sound"></button><button type="button" data-h="menu" title="Menu (Esc)" aria-label="Menu">' + IC_MENU + '</button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-popbtn') || p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var set = loadSettings(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, root: p.querySelector('.cr'), hudEl: p.querySelector('.cr-hud'), stage: p.querySelector('.cr-stage'), cv: p.querySelector('.cr-cv'), mini: p.querySelector('.cr-mini'),
      chipsEl: p.querySelector('.cr-chips'), bossEl: p.querySelector('.cr-bossb'), logEl: p.querySelector('.cr-log'), tgtEl: p.querySelector('.cr-tgtbar'), abilEl: p.querySelector('.cr-abil'), padEl: p.querySelector('.cr-pad'),
      scrEl: p.querySelector('.cr-scr'), ovlEl: p.querySelector('.cr-ovl'),
      hpEl: p.querySelector('.cr-hpb'), hpFill: p.querySelector('.cr-hpb i'), hpLbl: p.querySelector('.cr-hpb span'), resFill: p.querySelector('.cr-resb i'), resLbl: p.querySelector('.cr-resb span'), xpFill: p.querySelector('.cr-xpb i'),
      whereEl: p.querySelector('.cr-where'), goldEl: p.querySelector('.cr-gold'), bossName: p.querySelector('.cr-bossb b'), bossFill: p.querySelector('.cr-bossb i'),
      set: set, snd: new Snd(set.sound), client: clientId(), coarse: !!(mm && mm('(pointer: coarse)').matches),
      R: null, hero: null, G: null, screen: null, ov: null, ovlOpen: false, vis: {}, lunge: {}, flash: {}, fx: newFx(), shake: 0, logLines: [], tgt: null, auto: null, kbd: false,
      ts: 32, cw: 360, chh: 400, dpr: 1, ox: 0, oy: 0, layerKey: '', tilesDirty: true, tilesSig: ''
    };
    S.ctx = S.cv.getContext('2d');
    S.mini.hidden = !set.mini;
    p._onClose = teardown;
    readTheme();
    layout();
    syncHead();
    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (!S) return; if (document.hidden) { if (S.G) saveRunNow(); saveNow(true); } else startLoop(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onResize = function () {
      if (!S) return; clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); if (S.sceneCv) sizeScene(); if (S.ovlOpen && S.ov && S.ov.k === 'map') drawBigMap(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    window.addEventListener('orientationchange', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try { S.ro = new ResizeObserver(function () { if (S && S.panel === p) requestAnimationFrame(relayoutIfMoved); }); S.ro.observe(S.hudEl); S.ro.observe(S.padEl); S.ro.observe(S.abilEl); } catch (e) {}
    try { S.themeObs = new MutationObserver(function () { if (S) { readTheme(); if (S.screen) renderScreen(); } }); S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] }); } catch (e) {}
    p.addEventListener('cade-panel-minimize', function () { if (!S || S.panel !== p) return; stopAuto(); if (S.G) saveRunNow(); saveNow(); });
    p.addEventListener('cade-panel-restore', function () { if (!S || S.panel !== p) return; requestAnimationFrame(function () { if (!S) return; readTheme(); layout(); startLoop(); }); });
    S.root.addEventListener('click', onClick);
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null; if (!b || !S) return;
      var hh = b.getAttribute('data-h');
      if (hh === 'sound') { S.set.sound = !S.set.sound; S.snd.on = S.set.sound; saveSettings(); S.snd.ensure(); S.snd.play('ui'); syncHead(); if (S.screen) renderScreen(); }
      else if (hh === 'help') openOvl('help');
      else if (hh === 'menu') { if (S.G && !S.screen) openOvl('menu'); else if (S.R) { if (S.ovlOpen) closeOvl(); showScreen('title'); } }
    });
    bindCanvas(); bindPad();
    startLoop();
    boot();
  }

  Cade.registerWidget({
    name: 'Dungeon Crawler',
    description: 'Deepdelve — a story roguelite: 6 classes, 5 acts and bosses, loot, puzzles, a daily challenge, synced heroes',
    icon: '⚔',
    tags: 'game,roguelike,dungeon,crawler,rpg,adventure,puzzle,action,deepdelve,classes,loot,boss,daily,story,train,fun',
    open: open
  });
})();
