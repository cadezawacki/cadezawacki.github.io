/* Geography Quiz — flags, capitals, continents, country shapes and "which
 * country is highlighted?" on a map, plus flash cards for learning.
 *
 * DATA: geo-data.js (~25 KB, precached) is loaded on first open: 197 sovereign
 * states (193 UN members + Vatican City, Palestine, Kosovo, Taiwan) and 28
 * dependent territories that only appear with "Include territories" on. Flags
 * are emoji built from the ISO code (regional-indicator pairs); where the
 * platform can't draw flag emoji (Windows) a small Twemoji flag font is pulled
 * from jsDelivr.
 *
 * SHAPES / MAP: Natural Earth 1:110m countries (public domain) as TopoJSON from
 * world-atlas@2.0.2 on jsDelivr, fetched only when a Shapes / Map / card round
 * needs it (~39 KB compressed; the service worker keeps it for offline). Decoded
 * by a tiny TopoJSON reader; silhouettes use a Lambert azimuthal equal-area
 * projection centred on the country (so Russia, Fiji and the USA with Alaska,
 * which straddle the antimeridian, come out whole), the world map uses Equal
 * Earth and the close-up map an orthographic globe centred on the country.
 * Crimea, drawn inside Russia by Natural Earth, is shown as part of Ukraine;
 * Somaliland and Northern Cyprus are shown as part of Somalia and Cyprus.
 * Countries too small for that scale get a pin at their capital instead.
 *
 * ANSWERS: multiple choice (wrong answers from the same sub-region, or from
 * look-alike flags) or typed with fuzzy matching: accents, case, punctuation,
 * "St." and a leading "The" don't matter, aliases count (USA, Czech Republic,
 * Ivory Coast, Swaziland, Burma, Turkey…), and small typos are forgiven unless
 * another country is just as close (Austria / Australia, Niger / Nigeria).
 *
 * Keyboard: 1–6 / A–F pick, Enter = next, Space flips a card, Esc closes. Keys
 * are taken (document, capture phase) only while the quiz "has focus" — from
 * opening until a press outside the panel — so the editor stays usable. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('geoquiz.css');
  var DATA_URL = Cade.asset('geo-data.js'); // resolve now, while the loader context is ours
  var ATLAS_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json';
  // Twemoji country flags as a font (MIT code / CC-BY 4.0 art, by TalkJS) — only
  // fetched where the system has no flag emoji.
  var FLAG_FONT_URL = 'https://cdn.jsdelivr.net/npm/country-flag-emoji-polyfill@0.1.8/dist/TwemojiCountryFlags.woff2';
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'geoquiz-panel';
  var PREFS_KEY = 'cade-geoquiz-prefs';
  var STATS_KEY = 'cade-geoquiz-stats';
  var MAX_MISS = 80;      // per-country miss counters kept
  var RECENT = 40;        // countries asked recently are picked less often (this session)

  var CONTS = [['AF', 'Africa'], ['AS', 'Asia'], ['EU', 'Europe'], ['NA', 'North America'], ['SA', 'South America'], ['OC', 'Oceania']];
  var CONT_NAME = {};
  CONTS.forEach(function (c) { CONT_NAME[c[0]] = c[1]; });
  var MODES = [
    ['flags', 'Flags'], ['capitals', 'Capitals'], ['continents', 'Continents'],
    ['shapes', 'Shapes'], ['map', 'Map'], ['learn', 'Learn'],
  ];
  var MODE_INFO = {
    flags: 'Name the country from its flag — or, reversed, pick the flag for a country.',
    capitals: 'Name the capital of a country — or, reversed, the country a capital belongs to.',
    continents: 'Which continent is each country in? Countries that span two accept both.',
    shapes: 'Recognise countries from their outline (Natural Earth 1:110m).',
    map: 'Which country is highlighted? Switch between the world map and a close-up.',
    learn: 'Flash cards: look, think, flip. “Again” brings a card back later.',
  };
  var KEYS = 'abcdef';

  // ---- pure helpers (no DOM; unit-checked in node) ----------------------------
  function flagEmoji(iso) {
    if (!/^[A-Z]{2}$/.test(iso)) return '';
    return String.fromCodePoint(0x1F1E6 + iso.charCodeAt(0) - 65, 0x1F1E6 + iso.charCodeAt(1) - 65);
  }

  function parseData(d) {
    var list = [], byIso = {}, byNum = {};
    d.rows.forEach(function (row) {
      var f = row.split('|');
      var caps = f[4] ? f[4].split(';').map(function (c) { return c.split('/'); }) : [];
      var ll = f[9] ? f[9].split(',').map(Number) : null;
      var c = {
        iso: f[0], num: f[1], name: f[2], aliases: f[3] ? f[3].split(';') : [],
        caps: caps, cap: caps.length ? caps[0][0] : '',
        conts: f[5].split('/'), sub: f[6],
        terr: f[7].indexOf('t') !== -1, partial: f[7].indexOf('p') !== -1,
        nocap: f[7].indexOf('x') !== -1 || !caps.length,
        note: f[8] || '', ll: ll && ll.length === 2 && !isNaN(ll[0]) && !isNaN(ll[1]) ? ll : null,
        flag: flagEmoji(f[0]),
      };
      c.cont = c.conts[0];
      list.push(c);
      byIso[c.iso] = c;
      if (c.num) byNum[c.num] = c;
    });
    var sim = {};
    (d.similarFlags || []).forEach(function (g) {
      var isos = g.split(' ');
      isos.forEach(function (i) {
        sim[i] = (sim[i] || []).concat(isos.filter(function (j) { return j !== i && byIso[j]; }));
      });
    });
    return { list: list, byIso: byIso, byNum: byNum, sim: sim };
  }

  // Loose form for comparing typed answers: no accents/case/punctuation,
  // "&" = "and", "St." = "Saint", no leading "The".
  function norm(s) {
    s = String(s == null ? '' : s).toLowerCase();
    if (s.normalize) s = s.normalize('NFD');
    return s.replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ø/g, 'o')
      .replace(/[đð]/g, 'd').replace(/ł/g, 'l').replace(/ı/g, 'i').replace(/þ/g, 'th')
      .replace(/&/g, ' and ')
      .replace(/['`´‘’ʻʼ.]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim()
      .replace(/\bst\b/g, 'saint').replace(/\bste\b/g, 'sainte')
      .replace(/^the /, '');
  }
  function compact(s) { return norm(s).replace(/ /g, ''); }

  // Optimal-string-alignment distance (Levenshtein + adjacent swaps), bailing
  // out early once it can't come in under `max`.
  function editDist(a, b, max) {
    var n = a.length, m = b.length, i, j;
    if (max == null) max = Math.max(n, m);
    if (Math.abs(n - m) > max) return max + 1;
    var d = [];
    for (i = 0; i <= n; i++) d[i] = [i];
    for (j = 1; j <= m; j++) d[0][j] = j;
    for (i = 1; i <= n; i++) {
      var rowMin = d[i][0];
      for (j = 1; j <= m; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        var v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
          v = Math.min(v, d[i - 2][j - 2] + 1);
        }
        d[i][j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
    }
    return d[n][m];
  }
  // Typos forgiven, by answer length: short names must be exact (Iran / Iraq).
  function tolerance(len) { return len <= 4 ? 0 : len <= 7 ? 1 : len <= 12 ? 2 : 3; }

  function answerKeys(c, kind) {
    var k = c._keys || (c._keys = {});
    if (!k[kind]) {
      var raw = [];
      if (kind === 'capital') c.caps.forEach(function (sp) { raw = raw.concat(sp); });
      else raw = [c.name].concat(c.aliases);
      var seen = {};
      k[kind] = raw.map(compact).filter(function (s) { if (!s || seen[s]) return false; seen[s] = 1; return true; });
    }
    return k[kind];
  }

  // Judge a typed answer. Returns {ok} plus: exact (spelled right), other (it
  // IS another place's name), near (a typo that fits another place equally
  // well — ask again rather than mark it wrong), empty.
  function judge(input, target, all, kind) {
    var q = compact(input);
    if (!q) return { ok: false, empty: true };
    var keys = answerKeys(target, kind), i, j, k;
    if (keys.indexOf(q) !== -1) return { ok: true, exact: true };
    for (i = 0; i < all.length; i++) {
      if (all[i] === target) continue;
      k = answerKeys(all[i], kind);
      for (j = 0; j < k.length; j++) if (k[j] === q) return { ok: false, other: all[i] };
    }
    var best = Infinity;
    for (j = 0; j < keys.length; j++) {
      var tol = tolerance(keys[j].length), dd = editDist(q, keys[j], tol);
      if (dd <= tol && dd < best) best = dd;
    }
    if (best === Infinity) return { ok: false };
    for (i = 0; i < all.length; i++) {
      if (all[i] === target) continue;
      k = answerKeys(all[i], kind);
      for (j = 0; j < k.length; j++) if (editDist(q, k[j], best) <= best) return { ok: false, near: all[i] };
    }
    return { ok: true, exact: false };
  }

  function shuffle(a, rnd) {
    rnd = rnd || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // Two places whose capital (any spelling) reads the same — e.g. Georgetown
  // (Guyana) and George Town (Cayman Islands) — must never meet in one question.
  function capClash(a, b) {
    var ka = answerKeys(a, 'capital'), kb = answerKeys(b, 'capital');
    for (var i = 0; i < ka.length; i++) if (kb.indexOf(ka[i]) !== -1) return true;
    return false;
  }

  // Plausible wrong answers: look-alike flags first (flag rounds, at most two),
  // then the same sub-region, the same continent, anywhere.
  function pickDistractors(target, pool, n, mode, rnd, sim) {
    var simList = mode === 'flags' && sim ? (sim[target.iso] || []) : [];
    var tiers = [[], [], [], []];
    pool.forEach(function (c) {
      if (c === target || c.iso === target.iso) return;
      if ((mode === 'capitals' || mode === 'capitals-rev') && c.nocap) return;
      if (mode === 'capitals' && capClash(c, target)) return;
      var t = simList.indexOf(c.iso) !== -1 ? 0 : c.sub === target.sub ? 1 : c.cont === target.cont ? 2 : 3;
      tiers[t].push(c);
    });
    var out = [];
    for (var t = 0; t < tiers.length && out.length < n; t++) {
      var tier = shuffle(tiers[t].slice(), rnd), cap = t === 0 ? Math.min(2, n) : n;
      for (var i = 0, took = 0; i < tier.length && out.length < n && took < cap; i++, took++) out.push(tier[i]);
    }
    return out;
  }

  // Weighted pick without replacement: often-missed places come up more,
  // recently asked ones less.
  function pickRound(pool, n, missMap, recent, rnd) {
    rnd = rnd || Math.random;
    var items = pool.map(function (c) {
      var w = 1 + Math.min(4, (missMap && missMap[c.iso]) || 0) * 0.75;
      if (recent && recent.indexOf(c.iso) !== -1) w *= 0.25;
      // Efraimidis–Spirakis: key = u^(1/w), take the largest keys.
      return { c: c, k: Math.pow(rnd() || 1e-9, 1 / w) };
    });
    items.sort(function (a, b) { return b.k - a.k; });
    return items.slice(0, Math.min(n, items.length)).map(function (x) { return x.c; });
  }

  // ---- TopoJSON + projections ---------------------------------------------------
  var RAD = Math.PI / 180;

  // Decode one geometry collection: arcs are delta-encoded and quantised
  // (transform), a negative arc index means the arc reversed (~i).
  function decodeTopo(topo, objName) {
    var tf = topo.transform;
    var sx = tf ? tf.scale[0] : 1, sy = tf ? tf.scale[1] : 1, tx = tf ? tf.translate[0] : 0, ty = tf ? tf.translate[1] : 0;
    var arcs = topo.arcs.map(function (a) {
      var x = 0, y = 0, out = new Array(a.length);
      for (var i = 0; i < a.length; i++) {
        if (tf) { x += a[i][0]; y += a[i][1]; out[i] = [x * sx + tx, y * sy + ty]; }
        else out[i] = [a[i][0], a[i][1]];
      }
      return out;
    });
    function ring(ids) {
      var pts = [];
      for (var k = 0; k < ids.length; k++) {
        var id = ids[k], a = id < 0 ? arcs[~id].slice().reverse() : arcs[id];
        for (var j = k ? 1 : 0; j < a.length; j++) pts.push(a[j]); // arcs share their end points
      }
      return pts;
    }
    var obj = topo.objects[objName];
    return (obj && obj.geometries || []).map(function (g) {
      var polys = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : [];
      return { id: g.id == null ? '' : String(g.id), name: g.properties && g.properties.name || '', polys: polys.map(function (p) { return p.map(ring); }) };
    });
  }

  // Make longitudes continuous along a ring (a ring crossing the antimeridian
  // jumps 180 -> -180); the result may run past ±180.
  function unwrapRing(r) {
    var out = new Array(r.length), off = 0, prev = null;
    for (var i = 0; i < r.length; i++) {
      var lon = r[i][0] + off;
      if (prev !== null) {
        while (lon - prev > 180) { off -= 360; lon -= 360; }
        while (lon - prev < -180) { off += 360; lon += 360; }
      }
      out[i] = [lon, r[i][1]];
      prev = lon;
    }
    return out;
  }
  function toVec(lon, lat) {
    var p = lat * RAD, l = lon * RAD, cp = Math.cos(p);
    return [cp * Math.cos(l), cp * Math.sin(l), Math.sin(p)];
  }
  function fromVec(v) {
    var r = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
    return [Math.atan2(v[1], v[0]) / RAD, Math.asin(Math.max(-1, Math.min(1, v[2] / r))) / RAD];
  }
  function angDist(a, b) {
    var u = toVec(a[0], a[1]), v = toVec(b[0], b[1]);
    return Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))) / RAD;
  }
  function ringCenter(r) {
    var s = [0, 0, 0];
    for (var i = 0; i < r.length; i++) { var v = toVec(r[i][0], r[i][1]); s[0] += v[0]; s[1] += v[1]; s[2] += v[2]; }
    return fromVec(s);
  }
  // Approximate area in deg² (sinusoidal — equal-area — then the shoelace formula).
  function ringArea(r) {
    var a = 0, n = r.length;
    var x = r.map(function (p) { return p[0] * Math.cos(p[1] * RAD); });
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      a += x[i] * r[j][1] - x[j] * r[i][1];
    }
    return Math.abs(a / 2);
  }

  // Natural Earth features without an ISO numeric id that belong to a quiz country.
  var NAME_ISO = { 'Kosovo': 'XK', 'Somaliland': 'SO', 'N. Cyprus': 'CY' };

  function buildAtlas(topo, byNum) {
    var feats = decodeTopo(topo, 'countries');
    var geo = {}, land = [];
    feats.forEach(function (f) {
      if (f.id === '010') return; // Antarctica: no quiz country, cropped from the maps
      var c = f.id && byNum[f.id];
      var iso = c ? c.iso : NAME_ISO[f.name] || '';
      var polys = f.polys.map(function (p) { return p.map(unwrapRing); });
      polys.forEach(function (p) {
        var own = iso;
        var ctr = ringCenter(p[0]);
        // Crimea: internationally part of Ukraine (UN GA res. 68/262).
        if (iso === 'RU' && ctr[0] > 32 && ctr[0] < 37 && ctr[1] > 44 && ctr[1] < 46.5) own = 'UA';
        var poly = { rings: p, center: ctr, area: ringArea(p[0]), iso: own };
        land.push(poly);
        if (own) (geo[own] || (geo[own] = { polys: [] })).polys.push(poly);
      });
    });
    return { geo: geo, land: land };
  }

  // A country's polygons for its silhouette / close-up: the largest polygon,
  // big parts within 60° (Alaska) and the islands near either; far-flung parts
  // (French Guiana for France, Hawaii for the USA) are left out. Cached.
  function shapeOf(atlas, iso) {
    var g = atlas && atlas.geo[iso];
    if (!g || !g.polys.length) return null;
    if (g.shape) return g.shape;
    var main = g.polys[0];
    g.polys.forEach(function (p) { if (p.area > main.area) main = p; });
    var radius = 0;
    main.rings[0].forEach(function (pt) { var d = angDist(main.center, pt); if (d > radius) radius = d; });
    // Big parts not too far away (Alaska) anchor their own nearby islands too.
    var anchors = g.polys.filter(function (p) {
      return p === main || (p.area >= main.area * 0.1 && angDist(main.center, p.center) <= 60);
    });
    var keep = g.polys.filter(function (p) {
      if (angDist(main.center, p.center) <= Math.max(40, radius)) return true;
      return anchors.some(function (a) { return angDist(a.center, p.center) <= 15; });
    });
    var s = [0, 0, 0], pts = 0;
    keep.forEach(function (p) {
      var v = toVec(p.center[0], p.center[1]);
      s[0] += v[0] * p.area; s[1] += v[1] * p.area; s[2] += v[2] * p.area;
      pts += p.rings[0].length;
    });
    g.shape = { polys: keep, center: fromVec(s), main: main.center, points: pts };
    return g.shape;
  }

  // Lambert azimuthal equal-area, centred on (lon0, lat0); y grows downwards.
  function laea(lon0, lat0) {
    var s0 = Math.sin(lat0 * RAD), c0 = Math.cos(lat0 * RAD);
    return function (lon, lat) {
      var l = (lon - lon0) * RAD, p = lat * RAD, sp = Math.sin(p), cp = Math.cos(p), cl = Math.cos(l);
      var k = Math.sqrt(2 / Math.max(1e-9, 1 + s0 * sp + c0 * cp * cl));
      return [k * cp * Math.sin(l), -k * (c0 * sp - s0 * cp * cl)];
    };
  }
  // Orthographic (a globe seen from above (lon0, lat0)); third value > 0 = visible side.
  function ortho(lon0, lat0) {
    var s0 = Math.sin(lat0 * RAD), c0 = Math.cos(lat0 * RAD);
    return function (lon, lat) {
      var l = (lon - lon0) * RAD, p = lat * RAD, cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l);
      return [cp * Math.sin(l), -(c0 * sp - s0 * cp * cl), s0 * sp + c0 * cp * cl];
    };
  }
  // Equal Earth (Šavrič, Patterson & Jenny 2018); y grows downwards.
  var EE_A1 = 1.340264, EE_A2 = -0.081106, EE_A3 = 0.000893, EE_A4 = 0.003796, EE_M = Math.sqrt(3) / 2;
  function equalEarth(lon, lat) {
    var l = lon * RAD, th = Math.asin(EE_M * Math.sin(lat * RAD)), t2 = th * th, t6 = t2 * t2 * t2;
    return [l * Math.cos(th) / (EE_M * (EE_A1 + 3 * EE_A2 * t2 + t6 * (7 * EE_A3 + 9 * EE_A4 * t2))),
      -th * (EE_A1 + EE_A2 * t2 + t6 * (EE_A3 + EE_A4 * t2))];
  }
  function r1(v) { return Math.round(v * 10) / 10; }
  function ringPath(pts) {
    var d = 'M';
    for (var i = 0; i < pts.length; i++) d += (i ? 'L' : '') + r1(pts[i][0]) + ',' + r1(pts[i][1]);
    return d + 'Z';
  }

  // Silhouette: project around the country's own centre and fit the box.
  function silhouettePath(shape, W, H, pad) {
    var P = laea(shape.center[0], shape.center[1]);
    var rings = [], minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    shape.polys.forEach(function (p) {
      p.rings.forEach(function (r) {
        var pr = r.map(function (pt) {
          var q = P(pt[0], pt[1]);
          if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0];
          if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1];
          return q;
        });
        rings.push(pr);
      });
    });
    var k = Math.min((W - 2 * pad) / Math.max(1e-9, maxx - minx), (H - 2 * pad) / Math.max(1e-9, maxy - miny));
    var ox = (W - (maxx - minx) * k) / 2 - minx * k, oy = (H - (maxy - miny) * k) / 2 - miny * k;
    return rings.map(function (r) {
      return ringPath(r.map(function (q) { return [q[0] * k + ox, q[1] * k + oy]; }));
    }).join('');
  }

  // Orthographic ring: hidden vertices are pushed out onto the globe's rim, with
  // the exact rim crossing inserted, so polygons cut by the horizon close along
  // it. null when nothing is on the visible side.
  function limb(x, y) { var m = Math.sqrt(x * x + y * y) || 1; return [x / m, y / m]; }
  function orthoRing(r, P) {
    var out = [], prev = null, vis = false;
    for (var i = 0; i < r.length; i++) {
      var q = P(r[i][0], r[i][1]);
      if (prev && (prev[2] >= 0) !== (q[2] >= 0)) {
        var t = prev[2] / (prev[2] - q[2]);
        out.push(limb(prev[0] + t * (q[0] - prev[0]), prev[1] + t * (q[1] - prev[1])));
      }
      if (q[2] >= 0) { out.push([q[0], q[1]]); vis = true; } else out.push(limb(q[0], q[1]));
      prev = q;
    }
    return vis ? out : null;
  }

  // ---- persistence --------------------------------------------------------------
  function readJSON(key, dflt) {
    try { var v = JSON.parse(Cade.store.get(key) || 'null'); return v == null ? dflt : v; } catch (e) { return dflt; }
  }
  function writeJSON(key, v) { try { Cade.store.set(key, JSON.stringify(v)); } catch (e) {} }

  var prefs = { mode: 'flags', rev: { flags: false, capitals: false }, input: 'mc', region: 'all', len: 10, terr: false, view: 'world', deck: 'flags', auto: true };
  var stats = { modes: {}, miss: {} };
  function loadPrefs() {
    var p = readJSON(PREFS_KEY, {}) || {};
    if (MODES.some(function (m) { return m[0] === p.mode; })) prefs.mode = p.mode;
    if (p.rev && typeof p.rev === 'object') prefs.rev = { flags: !!p.rev.flags, capitals: !!p.rev.capitals };
    prefs.input = p.input === 'type' ? 'type' : 'mc';
    prefs.region = p.region === 'all' || CONT_NAME[p.region] ? p.region : 'all';
    prefs.len = p.len === 20 || p.len === 0 ? p.len : 10;
    prefs.terr = !!p.terr;
    prefs.view = p.view === 'zoom' ? 'zoom' : 'world';
    prefs.deck = ['flags', 'capitals', 'shapes', 'map'].indexOf(p.deck) !== -1 ? p.deck : 'flags';
    prefs.auto = p.auto !== false;
    var s = readJSON(STATS_KEY, {}) || {};
    stats = { modes: s.modes && typeof s.modes === 'object' ? s.modes : {}, miss: s.miss && typeof s.miss === 'object' ? s.miss : {} };
  }
  function savePrefs() { writeJSON(PREFS_KEY, prefs); }
  function saveStats() {
    var keys = Object.keys(stats.miss);
    if (keys.length > MAX_MISS) {
      keys.sort(function (a, b) { return stats.miss[a] - stats.miss[b]; }).slice(0, keys.length - MAX_MISS)
        .forEach(function (k) { delete stats.miss[k]; });
    }
    writeJSON(STATS_KEY, stats);
  }
  function modeStats(key) {
    var m = stats.modes[key];
    if (!m || typeof m !== 'object') m = stats.modes[key] = { r: 0, a: 0, c: 0, bs: 0, best: 0 };
    return m;
  }

  // ---- loading ------------------------------------------------------------------
  var data = null, dataLoading = null;
  var atlas = null, atlasLoading = null;
  function loadData() {
    if (data) return Promise.resolve();
    if (window.__cadeGeoData) { data = parseData(window.__cadeGeoData); return Promise.resolve(); }
    if (dataLoading) return dataLoading;
    dataLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = DATA_URL;
      s.onload = function () {
        if (window.__cadeGeoData) { data = parseData(window.__cadeGeoData); resolve(); }
        else { dataLoading = null; reject(new Error('no data')); }
      };
      s.onerror = function () { dataLoading = null; reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
    return dataLoading;
  }
  function loadAtlas() {
    if (atlas) return Promise.resolve();
    if (atlasLoading) return atlasLoading;
    atlasLoading = fetch(ATLAS_URL).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (topo) {
      atlas = buildAtlas(topo, data.byNum);
    }, function (e) { atlasLoading = null; throw e; });
    return atlasLoading;
  }
  function hasShape(c) { var s = atlas && shapeOf(atlas, c.iso); return !!(s && s.points >= 10); }
  function onMap(c) { return !!((atlas && atlas.geo[c.iso]) || c.ll); }

  // Windows has no flag emoji: detect (a colour glyph draws the same whatever
  // the fill colour) and add the Twemoji flag font for the flag code points only.
  var flagFontDone = false;
  function ensureFlagFont() {
    if (flagFontDone) return;
    flagFontDone = true;
    try {
      var cv = document.createElement('canvas');
      cv.width = cv.height = 1;
      var ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.textBaseline = 'top';
      ctx.font = '100px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      ctx.scale(0.01, 0.01);
      var px = function (t, col) {
        ctx.clearRect(0, 0, 100, 100); ctx.fillStyle = col; ctx.fillText(t, 0, 0);
        return Array.prototype.join.call(ctx.getImageData(0, 0, 1, 1).data, ',');
      };
      var colour = function (t) { var a = px(t, '#fff'), b = px(t, '#000'); return a === b && b.indexOf('0,0,0,') !== 0; };
      if (colour('😊') && !colour(flagEmoji('CH'))) {
        var st = document.createElement('style');
        st.id = 'gq-flag-font';
        st.textContent = '@font-face{font-family:"Twemoji Country Flags";unicode-range:U+1F1E6-1F1FF;' +
          'src:url("' + FLAG_FONT_URL + '") format("woff2");font-display:swap;}';
        document.head.appendChild(st);
      }
    } catch (e) {}
  }

  // ---- map / shape SVG ----------------------------------------------------------
  var svgSeq = 0;
  var world = null; // cached Equal Earth land paths (rebuilt only after reopening)

  function eePolyPath(rings, S) {
    var minL = Infinity, maxL = -Infinity, d = '';
    rings[0].forEach(function (p) { if (p[0] < minL) minL = p[0]; if (p[0] > maxL) maxL = p[0]; });
    // Rings running past ±180 (Fiji, Chukotka) are drawn twice, 360° apart; the
    // sphere clip trims both copies at the map edge.
    var shifts = [0];
    if (maxL > 180) shifts.push(-360);
    if (minL < -180) shifts.push(360);
    shifts.forEach(function (sh) {
      rings.forEach(function (r) {
        d += ringPath(r.map(function (p) { var q = equalEarth(p[0] + sh, p[1]); return [q[0] * S, q[1] * S]; }));
      });
    });
    return d;
  }
  function worldBase() {
    if (world) return world;
    var S = 100, land = '';
    atlas.land.forEach(function (p) { land += eePolyPath(p.rings, S); });
    var out = [], lat;
    for (lat = -90; lat <= 90; lat += 3) out.push(equalEarth(180, lat));
    for (lat = 90; lat >= -90; lat -= 3) out.push(equalEarth(-180, lat));
    var top = equalEarth(0, 84)[1] * S, bottom = equalEarth(0, -58)[1] * S, half = equalEarth(180, 0)[0] * S;
    world = {
      S: S, land: land,
      outline: ringPath(out.map(function (q) { return [q[0] * S, q[1] * S]; })),
      vb: [r1(-half - 2), r1(top), r1(2 * half + 4), r1(bottom - top)],
    };
    return world;
  }
  function pinSvg(x, y, s) {
    return '<g class="gq-pin" transform="translate(' + r1(x) + ',' + r1(y) + ') scale(' + (Math.round(s * 1000) / 1000) + ')">' +
      '<path d="M0,0C-3,-6 -8,-10 -8,-16A8,8 0 1 1 8,-16C8,-10 3,-6 0,0Z"/><circle cx="0" cy="-16" r="3"/></g>';
  }
  function targetCenter(c) {
    var s = atlas && shapeOf(atlas, c.iso);
    return s ? s.main : c.ll ? [c.ll[1], c.ll[0]] : [0, 0];
  }

  function worldSvg(c, small) {
    var w = worldBase(), S = w.S, id = 'gq-clip' + (++svgSeq);
    var g = atlas.geo[c.iso], hit = '';
    if (g) g.polys.forEach(function (p) { hit += eePolyPath(p.rings, S); });
    var ctr = targetCenter(c), cq = equalEarth(ctr[0], ctr[1]);
    var cx = cq[0] * S, cy = cq[1] * S;
    // Tiny targets get a ring so they can be found at world scale.
    var s = atlas && shapeOf(atlas, c.iso), big = false;
    if (s) {
      var minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      s.polys.forEach(function (p) {
        p.rings[0].forEach(function (pt) {
          var q = equalEarth(pt[0], pt[1]);
          if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0];
          if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1];
        });
      });
      big = Math.max(maxx - minx, maxy - miny) * S > 14;
    }
    var unit = w.vb[2] / 400;
    return '<svg class="gq-map gq-world' + (small ? ' gq-mini' : '') + '" viewBox="' + w.vb.join(' ') + '" aria-hidden="true">' +
      '<defs><clipPath id="' + id + '"><path d="' + w.outline + '"/></clipPath></defs>' +
      '<path class="gq-sea" d="' + w.outline + '"/>' +
      '<g clip-path="url(#' + id + ')"><path class="gq-land" d="' + w.land + '"/>' +
      (hit ? '<path class="gq-hit" d="' + hit + '"/>' : '') + '</g>' +
      (big ? '' : '<circle class="gq-ring" cx="' + r1(cx) + '" cy="' + r1(cy) + '" r="' + r1(unit * (small ? 9 : 8)) + '"/>') +
      (small ? '' : pinSvg(cx, cy, unit * 1.1)) + '</svg>';
  }

  function zoomSvg(c) {
    var ctr = targetCenter(c), P = ortho(ctr[0], ctr[1]), S = 1000;
    var s = atlas && shapeOf(atlas, c.iso), ex = 0, ey = 0;
    if (s) {
      s.polys.forEach(function (p) {
        p.rings[0].forEach(function (pt) {
          var q = P(pt[0], pt[1]);
          if (q[2] < 0) { ex = ey = 1; return; }
          if (Math.abs(q[0]) > ex) ex = Math.abs(q[0]);
          if (Math.abs(q[1]) > ey) ey = Math.abs(q[1]);
        });
      });
    }
    // Show some neighbouring land: widen until the nearest other land is in view
    // (Fiji gets Vanuatu, a mid-ocean pin isn't just blue).
    var near = 35;
    atlas.land.forEach(function (p) { if (p.iso !== c.iso) { var d = angDist(ctr, p.center); if (d < near) near = d; } });
    var hw = Math.min(1.08, Math.max(ex * 1.7, ey * 1.7 / 0.75, 0.13, Math.sin(Math.min(35, near * 1.2) * RAD)) + 0.02), hh = hw * 0.75;
    if (hw >= 1.08) hh = 1.08;
    var land = '', hit = '';
    atlas.land.forEach(function (p) {
      var d = '';
      p.rings.forEach(function (r) {
        var pr = orthoRing(r, P);
        if (!pr) return;
        var mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
        pr.forEach(function (q) {
          if (q[0] < mnx) mnx = q[0]; if (q[0] > mxx) mxx = q[0];
          if (q[1] < mny) mny = q[1]; if (q[1] > mxy) mxy = q[1];
        });
        if (mxx < -hw || mnx > hw || mxy < -hh || mny > hh) return; // off screen
        d += ringPath(pr.map(function (q) { return [q[0] * S, q[1] * S]; }));
      });
      if (p.iso === c.iso) hit += d; else land += d;
    });
    // Places too small for the 1:110m map (Caribbean and Pacific islands, Malta…) as dots.
    var dots = '';
    data.list.forEach(function (o) {
      if (!o.ll || o === c || (o.terr && !prefs.terr)) return;
      var dq = P(o.ll[1], o.ll[0]);
      if (dq[2] < 0 || Math.abs(dq[0]) > hw || Math.abs(dq[1]) > hh) return;
      dots += '<circle cx="' + Math.round(dq[0] * S) + '" cy="' + Math.round(dq[1] * S) + '" r="' + Math.round(2 * hw * S / 400 * 2.5) + '"/>';
    });
    var tiny = !s || Math.max(ex, ey) < hw * 0.07, unit = 2 * hw * S / 400;
    return '<svg class="gq-map gq-zoom" viewBox="' + Math.round(-hw * S) + ' ' + Math.round(-hh * S) + ' ' + Math.round(2 * hw * S) + ' ' + Math.round(2 * hh * S) + '" aria-hidden="true">' +
      '<circle class="gq-sea" cx="0" cy="0" r="' + S + '"/>' +
      '<path class="gq-land" d="' + land + '"/>' + (dots ? '<g class="gq-dot">' + dots + '</g>' : '') + (hit ? '<path class="gq-hit" d="' + hit + '"/>' : '') +
      (tiny ? '<circle class="gq-ring" cx="0" cy="0" r="' + Math.round(unit * 14) + '"/>' : '') +
      (tiny ? pinSvg(0, 0, unit * 1.1) : '') + '</svg>';
  }

  function shapeSvg(c) {
    var s = shapeOf(atlas, c.iso);
    if (!s) return '';
    return '<svg class="gq-shape" viewBox="0 0 320 220" aria-hidden="true"><path fill-rule="evenodd" d="' +
      silhouettePath(s, 320, 220, 12) + '"/></svg>';
  }

  function mapSvg(c) { return prefs.view === 'zoom' ? zoomSvg(c) : worldSvg(c); }

  // ---- game state -----------------------------------------------------------------
  var P = null;          // panel element
  var game = null;       // current round
  var learn = null;      // flash-card deck
  var sheet = '';        // '' | 'stats'
  var active = false;    // keyboard captured
  var openedAt = 0;
  var recent = [];       // isos asked lately (this session)
  var timers = [];
  var resetArmed = 0;
  var gameSeq = 0;

  function q(sel) { return P && P.querySelector(sel); }
  function later(fn, ms) { var t = setTimeout(fn, ms); timers.push(t); return t; }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }

  function modeKey(mode) {
    if (mode === 'flags' || mode === 'capitals') return mode + (prefs.rev[mode] ? '-rev' : '');
    return mode;
  }
  function needsAtlas(mode) { return mode === 'shapes' || mode === 'map'; }
  // Type-in is offered where the answer is a name.
  function canType(key) { return key !== 'flags-rev' && key !== 'continents'; }

  function basePool() {
    return data.list.filter(function (c) { return !c.terr || prefs.terr; });
  }
  function inRegion(c) { return prefs.region === 'all' || c.conts.indexOf(prefs.region) !== -1; }
  function poolFor(key) {
    var all = basePool();
    var list = all.filter(inRegion);
    if (key === 'capitals' || key === 'capitals-rev') {
      list = list.filter(function (c) {
        if (c.nocap) return false;
        if (key !== 'capitals-rev') return true;
        // "Mexico City is the capital of…?" gives itself away; capitals shared
        // by two places can't be asked backwards.
        var cc = compact(c.cap), cn = compact(c.name);
        if (cc.indexOf(cn) !== -1 || cn.indexOf(cc) !== -1) return false;
        return !all.some(function (o) { return o !== c && !o.nocap && capClash(o, c); });
      });
    }
    if (key === 'shapes') list = list.filter(hasShape);
    if (key === 'map') list = list.filter(onMap);
    return list;
  }

  function buildQuestion(c, key, pool) {
    var qn = { c: c, key: key, done: false, ok: false, given: '' };
    if (key === 'continents') {
      qn.opts = CONTS.map(function (x) { return x[0]; });
      return qn;
    }
    if (prefs.input === 'type' && canType(key)) { qn.type = true; return qn; }
    var mode = key === 'flags' || key === 'flags-rev' ? 'flags' : key === 'capitals' ? 'capitals' : key === 'capitals-rev' ? 'capitals-rev' : key;
    var wrong = pickDistractors(c, pool.length >= 8 ? pool : basePool(), 3, mode, Math.random, data.sim);
    qn.opts = shuffle([c].concat(wrong));
    return qn;
  }

  function startRound(list) {
    clearTimers();
    var key = modeKey(prefs.mode);
    var pool = poolFor(key);
    if (pool.length < 4) { Cade.showToast('Not enough places for this filter — try another region', 'error', 2600); return; }
    var picked = list || pickRound(pool, prefs.len || pool.length, stats.miss, recent);
    var distractorPool = basePool().filter(inRegion);
    if (key === 'shapes') distractorPool = distractorPool.filter(hasShape);
    game = {
      id: ++gameSeq, key: key, mode: prefs.mode, i: 0, score: 0, streak: 0, best: 0,
      qs: picked.map(function (c) { return buildQuestion(c, key, distractorPool); }),
    };
    sheet = '';
    paint();
    focusInput();
  }

  function current() { return game && game.qs[game.i]; }

  function noteRecent(iso) {
    recent = recent.filter(function (x) { return x !== iso; });
    recent.push(iso);
    if (recent.length > RECENT) recent.shift();
  }

  function settle(qn, ok, given) {
    qn.done = true; qn.ok = ok; qn.given = given;
    noteRecent(qn.c.iso);
    if (ok) {
      game.score++; game.streak++;
      if (game.streak > game.best) game.best = game.streak;
      if (stats.miss[qn.c.iso]) { stats.miss[qn.c.iso]--; if (!stats.miss[qn.c.iso]) delete stats.miss[qn.c.iso]; }
    } else {
      game.streak = 0;
      stats.miss[qn.c.iso] = (stats.miss[qn.c.iso] || 0) + 1;
    }
    var m = modeStats(game.key);
    m.a++; if (ok) m.c++;
    if (game.best > m.bs) m.bs = game.best;
    saveStats();
    try { Cade.haptic && Cade.haptic(ok ? 8 : 30); } catch (e) {}
    paint();
    if (ok && prefs.auto) {
      var g = game, at = g.i;
      later(function () { if (game === g && g.i === at) next(); }, 1100);
    }
  }

  function choose(idx) {
    var qn = current();
    if (!qn || qn.done || qn.type || !qn.opts || idx < 0 || idx >= qn.opts.length) return;
    var pick = qn.opts[idx], ok;
    if (game.key === 'continents') ok = qn.c.conts.indexOf(pick) !== -1;
    else ok = pick === qn.c;
    qn.pickIdx = idx;
    settle(qn, ok, game.key === 'continents' ? CONT_NAME[pick] : pick.name);
  }

  function submitTyped() {
    var qn = current(), inp = q('.gq-input');
    if (!qn || qn.done || !qn.type || !inp) return;
    var kind = game.key === 'capitals' ? 'capital' : 'country';
    var res = judge(inp.value, qn.c, data.list, kind);
    var fb = q('.gq-fb');
    if (res.empty) { if (fb) fb.innerHTML = '<span class="gq-muted">Type an answer — or “Don’t know”</span>'; return; }
    if (res.near) {
      if (fb) fb.innerHTML = '<span class="gq-warn">Close to more than one ' + (kind === 'capital' ? 'capital' : 'country') + ' — check the spelling</span>';
      shake(inp);
      return;
    }
    qn.other = res.other || null;
    qn.fuzzy = res.ok && !res.exact;
    settle(qn, res.ok, inp.value.trim());
  }
  function giveUp() {
    var qn = current();
    if (!qn || qn.done) return;
    settle(qn, false, '');
  }
  function shake(el) {
    el.classList.remove('gq-shake');
    void el.offsetWidth; // restart the animation
    el.classList.add('gq-shake');
  }

  function next() {
    if (!game) return;
    var qn = current();
    if (qn && !qn.done) return;
    clearTimers();
    game.i++;
    if (game.i >= game.qs.length) finishRound();
    else { paint(); focusInput(); }
  }

  function finishRound() {
    var m = modeStats(game.key);
    m.r++;
    var pct = game.qs.length ? Math.round(game.score / game.qs.length * 100) : 0;
    if (game.qs.length >= 10 && pct > (m.best || 0)) m.best = pct;
    saveStats();
    game.over = true;
    paint();
  }

  // ---- learn (flash cards) ---------------------------------------------------------
  function deckPool(deck) { return poolFor(deck); }
  function startLearn(list) {
    clearTimers();
    var pool = list || shuffle(deckPool(prefs.deck).slice());
    learn = { deck: prefs.deck, cards: pool, i: 0, flipped: false, known: 0, total: pool.length, again: 0 };
    game = null;
    paint();
  }
  function flip() { if (learn && learn.cards.length) { learn.flipped = !learn.flipped; paint(); } }
  function grade(knew) {
    if (!learn || !learn.cards.length) return;
    var c = learn.cards.shift();
    if (knew) {
      learn.known++;
      if (stats.miss[c.iso]) { stats.miss[c.iso]--; if (!stats.miss[c.iso]) delete stats.miss[c.iso]; saveStats(); }
    } else {
      // Back in a few cards (not straight away, not at the very end).
      var at = Math.min(learn.cards.length, 3 + Math.floor(Math.random() * 3));
      learn.cards.splice(at, 0, c);
      learn.again++;
    }
    learn.flipped = false;
    paint();
  }

  // ---- rendering ---------------------------------------------------------------------
  function flagHtml(c, cls) { return '<span class="gq-flag' + (cls ? ' ' + cls : '') + '">' + c.flag + '</span>'; }
  function capsText(c) {
    if (!c.caps.length) return '—';
    return c.caps.map(function (sp) { return sp[0]; }).join(' / ');
  }
  function contText(c) { return c.conts.map(function (k) { return CONT_NAME[k]; }).join(' / '); }
  function infoHtml(c) {
    return '<div class="gq-info">' + flagHtml(c, 'gq-flag-sm') + '<div><b>' + esc(c.name) + '</b>' +
      (c.terr ? ' <span class="gq-tag">territory</span>' : c.partial ? ' <span class="gq-tag">partly recognised</span>' : '') +
      '<div class="gq-muted">Capital: ' + esc(capsText(c)) + ' · ' + esc(contText(c)) + '</div>' +
      (c.note ? '<div class="gq-note">' + esc(c.note) + '</div>' : '') + '</div></div>';
  }

  function needAtlasHtml() {
    return '<div class="gq-center gq-muted gq-pad">' + (atlasLoading ? 'Loading map data…' :
      'Couldn’t load the map data' + (navigator.onLine === false ? ' — it needs one online load to cache' : '') +
      '<div class="gq-acts"><button class="gq-btn" data-act="retry-atlas">Try again</button></div>') + '</div>';
  }

  function promptHtml(qn) {
    var c = qn.c, key = qn.key;
    if (key === 'flags') return '<div class="gq-ask">Which country’s flag is this?</div>' + flagHtml(c, 'gq-flag-xl');
    if (key === 'flags-rev') return '<div class="gq-ask">Which is the flag of <b>' + esc(c.name) + '</b>?</div>';
    if (key === 'capitals') return '<div class="gq-ask">What is the capital of</div><div class="gq-big">' + flagHtml(c) + ' ' + esc(c.name) + '</div>';
    if (key === 'capitals-rev') return '<div class="gq-big">' + esc(c.cap) + '</div><div class="gq-ask">is the capital of which ' + (c.terr ? 'country or territory' : 'country') + '?</div>';
    if (key === 'continents') return '<div class="gq-ask">Which continent is this in?</div><div class="gq-big">' + flagHtml(c) + ' ' + esc(c.name) + '</div>';
    if (key === 'shapes') return '<div class="gq-ask">Which ' + (c.terr ? 'place' : 'country') + ' has this shape?</div><div class="gq-art">' + shapeSvg(c) + '</div>';
    if (key === 'map') {
      return '<div class="gq-ask">Which ' + (c.terr ? 'place' : 'country') + ' is highlighted?</div><div class="gq-art gq-art-map">' + mapSvg(c) +
        '<button class="gq-view" data-act="view" title="Switch between world map and close-up">' + (prefs.view === 'zoom' ? 'World' : 'Zoom') + '</button></div>';
    }
    return '';
  }

  function optionLabel(qn, o) {
    if (qn.key === 'continents') return esc(CONT_NAME[o]);
    if (qn.key === 'flags-rev') return flagHtml(o, 'gq-flag-opt');
    if (qn.key === 'capitals') return esc(o.cap);
    return esc(o.name);
  }

  function optionsHtml(qn) {
    var html = '<div class="gq-opts' + (qn.key === 'flags-rev' ? ' gq-opts-flags' : '') + (qn.opts.length > 4 ? ' gq-opts-6' : '') + '">';
    qn.opts.forEach(function (o, i) {
      var cls = 'gq-opt';
      if (qn.done) {
        var right = qn.key === 'continents' ? qn.c.conts.indexOf(o) !== -1 : o === qn.c;
        if (right) cls += ' ok'; else if (i === qn.pickIdx) cls += ' bad'; else cls += ' dim';
      }
      html += '<button class="' + cls + '" data-opt="' + i + '"' + (qn.done ? ' tabindex="-1"' : '') + '>' +
        '<span class="gq-key">' + (i + 1) + '</span><span class="gq-ol">' + optionLabel(qn, o) + '</span></button>';
    });
    return html + '</div>';
  }

  function answerText(qn) {
    var c = qn.c;
    if (qn.key === 'capitals') return capsText(c);
    if (qn.key === 'continents') return contText(c);
    return c.name;
  }

  function feedbackHtml(qn) {
    if (!qn.done) return '';
    var c = qn.c, html;
    if (qn.ok) {
      html = '<span class="gq-good">✓ Correct' + (qn.fuzzy ? ' — ' + esc(answerText(qn)) : '') + '</span>';
      if (qn.key === 'continents' && c.conts.length > 1) html += ' <span class="gq-muted">(' + esc(c.name) + ' spans ' + esc(contText(c)) + ')</span>';
    } else {
      html = '<span class="gq-badc">✗ ' + (qn.given ? 'It’s ' : 'Answer: ') + esc(answerText(qn)) + '</span>';
      if (qn.other) {
        html += ' <span class="gq-muted">— ' + esc(qn.given) + (game.key === 'capitals' ? ' is the capital of ' + esc(qn.other.name) : ' is a different place') + '</span>';
      }
    }
    return html;
  }

  function hudHtml() {
    return '<div class="gq-hud"><span>' + (game.i + 1) + ' / ' + game.qs.length + '</span>' +
      '<span class="gq-score">✓ ' + game.score + '</span>' +
      '<span class="gq-streak' + (game.streak >= 3 ? ' hot' : '') + '" title="Streak">🔥 ' + game.streak + '</span>' +
      '<span class="gq-sp"></span><button class="gq-link" data-act="quit" title="End this round">End</button></div>';
  }
  function afterHtml(qn) {
    var html = '<div class="gq-fbrow"><div class="gq-fb">' + feedbackHtml(qn) + '</div>' +
      (qn.done ? '<button class="gq-btn primary gq-next" data-act="next">' + (game.i + 1 >= game.qs.length ? 'Results' : 'Next') + ' <span class="gq-kbd">↵</span></button>' : '') + '</div>';
    if (qn.done) html += infoHtml(qn.c);
    if (qn.done && qn.key === 'shapes' && atlas) html += '<div class="gq-locator">' + worldSvg(qn.c, true) + '</div>';
    return html;
  }
  function quizHtml() {
    var qn = current();
    if (needsAtlas(game.mode) && !atlas) return needAtlasHtml();
    var html = hudHtml() + '<div class="gq-prompt">' + promptHtml(qn) + '</div>';
    if (qn.type) {
      html += '<div class="gq-typerow' + (qn.done ? ' done' : '') + '" data-g="' + game.id + '"><input class="gq-input" type="text" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" enterkeyhint="go" placeholder="' +
        (game.key === 'capitals' ? 'Capital city…' : 'Country…') + '" aria-label="Your answer" data-q="' + game.i + '" value="' + esc(qn.given || '') + '">' +
        '<button class="gq-btn primary" data-act="check">Check</button><button class="gq-btn" data-act="giveup" title="Show the answer">Don’t know</button></div>';
    } else html += optionsHtml(qn);
    return html + '<div class="gq-after">' + afterHtml(qn) + '</div>';
  }
  // Type-in rounds update around the answer box instead of rebuilding it, so it
  // keeps focus — and a phone keeps its keyboard up for the whole round.
  function paintQuizInPlace() {
    var qn = current(), row = q('.gq-typerow');
    if (!qn || !qn.type || !row || row.getAttribute('data-g') !== String(game.id)) return false;
    var hud = q('.gq-hud'), pr = q('.gq-prompt'), af = q('.gq-after'), inp = row.querySelector('.gq-input');
    if (!hud || !pr || !af || !inp) return false;
    hud.outerHTML = hudHtml();
    if (inp.getAttribute('data-q') !== String(game.i)) {
      pr.innerHTML = promptHtml(qn);
      inp.value = '';
      inp.setAttribute('data-q', String(game.i));
    }
    row.classList.toggle('done', !!qn.done);
    af.innerHTML = afterHtml(qn);
    return true;
  }

  function reviewHtml() {
    var n = game.qs.length, pct = n ? Math.round(game.score / n * 100) : 0;
    var html = '<div class="gq-result"><div class="gq-result-big">' + game.score + ' / ' + n + '</div>' +
      '<div class="gq-muted">' + pct + '% · best streak ' + game.best + '</div></div><div class="gq-review">';
    game.qs.forEach(function (qn, i) {
      if (!qn.done) return;
      var c = qn.c, label;
      if (qn.key === 'capitals') label = esc(c.name) + ' → <b>' + esc(capsText(c)) + '</b>';
      else if (qn.key === 'capitals-rev') label = esc(c.cap) + ' → <b>' + esc(c.name) + '</b>';
      else if (qn.key === 'continents') label = esc(c.name) + ' → <b>' + esc(contText(c)) + '</b>';
      else label = '<b>' + esc(c.name) + '</b>';
      html += '<div class="gq-rv ' + (qn.ok ? 'ok' : 'bad') + '"><span class="gq-rv-n">' + (i + 1) + '</span>' + flagHtml(c, 'gq-flag-sm') +
        '<span class="gq-rv-t">' + label + (!qn.ok && qn.given ? ' <span class="gq-muted">(you: ' + esc(qn.given) + ')</span>' : '') + '</span>' +
        '<span class="gq-rv-m">' + (qn.ok ? '✓' : '✗') + '</span></div>';
    });
    html += '</div><div class="gq-acts"><button class="gq-btn primary" data-act="again">Play again <span class="gq-kbd">↵</span></button>';
    if (game.qs.some(function (x) { return x.done && !x.ok; })) html += '<button class="gq-btn" data-act="cards-miss">Study misses as cards</button>';
    html += '<button class="gq-btn" data-act="home">Change mode</button></div>';
    return html;
  }

  function startHtml() {
    var key = modeKey(prefs.mode), m = modeStats(key);
    var pool = data ? poolFor(key) : [];
    var html = '<div class="gq-start"><div class="gq-desc">' + esc(MODE_INFO[prefs.mode]) + '</div>';
    if (needsAtlas(prefs.mode) && !atlas) return html + needAtlasHtml() + '</div>';
    html += '<div class="gq-muted gq-small">' + pool.length + ' ' + (prefs.terr ? 'places' : 'countries') +
      (prefs.region !== 'all' ? ' in ' + esc(CONT_NAME[prefs.region]) : '') + '</div>';
    html += '<div class="gq-acts"><button class="gq-btn primary gq-go" data-act="start"' + (pool.length < 4 ? ' disabled' : '') + '>Start round <span class="gq-kbd">↵</span></button></div>';
    if (m.a) {
      html += '<div class="gq-mini-stats"><span><b>' + m.r + '</b> rounds</span><span><b>' + Math.round(m.c / m.a * 100) + '%</b> correct</span>' +
        '<span><b>' + m.bs + '</b> best streak</span>' + (m.best ? '<span><b>' + m.best + '%</b> best round</span>' : '') + '</div>';
    }
    return html + '</div>';
  }

  function learnHtml() {
    if (!learn) {
      var pool = data ? deckPool(prefs.deck) : [];
      var html = '<div class="gq-start"><div class="gq-desc">' + esc(MODE_INFO.learn) + '</div>' +
        '<div class="gq-seg gq-deck" role="group" aria-label="Cards">' +
        [['flags', 'Flags'], ['capitals', 'Capitals'], ['shapes', 'Shapes'], ['map', 'Map']].map(function (d) {
          return '<button class="gq-segb' + (prefs.deck === d[0] ? ' on' : '') + '" data-deck="' + d[0] + '">' + d[1] + '</button>';
        }).join('') + '</div>';
      if (needsAtlas(prefs.deck) && !atlas) return html + needAtlasHtml() + '</div>';
      return html + '<div class="gq-muted gq-small">' + pool.length + ' cards' + (prefs.region !== 'all' ? ' in ' + esc(CONT_NAME[prefs.region]) : '') + '</div>' +
        '<div class="gq-acts"><button class="gq-btn primary gq-go" data-act="learn"' + (pool.length ? '' : ' disabled') + '>Start cards <span class="gq-kbd">↵</span></button></div></div>';
    }
    if (needsAtlas(learn.deck) && !atlas) return needAtlasHtml();
    if (!learn.cards.length) {
      return '<div class="gq-result"><div class="gq-result-big">Done!</div><div class="gq-muted">' + learn.total + ' cards · ' +
        learn.again + ' repeat' + (learn.again === 1 ? '' : 's') + '</div></div>' +
        '<div class="gq-acts"><button class="gq-btn primary" data-act="learn">Shuffle again <span class="gq-kbd">↵</span></button><button class="gq-btn" data-act="home">Back</button></div>';
    }
    var c = learn.cards[0], front;
    if (learn.deck === 'flags') front = flagHtml(c, 'gq-flag-xl');
    else if (learn.deck === 'capitals') front = '<div class="gq-big">' + flagHtml(c) + ' ' + esc(c.name) + '</div><div class="gq-ask">capital?</div>';
    else if (learn.deck === 'shapes') front = '<div class="gq-art">' + shapeSvg(c) + '</div>';
    else front = '<div class="gq-art gq-art-map">' + mapSvg(c) + '<button class="gq-view" data-act="view">' + (prefs.view === 'zoom' ? 'World' : 'Zoom') + '</button></div>';
    var back = learn.deck === 'capitals'
      ? '<div class="gq-big">' + esc(capsText(c)) + '</div>' + (c.note ? '<div class="gq-note">' + esc(c.note) + '</div>' : '')
      : infoHtml(c);
    return '<div class="gq-hud"><span>' + learn.known + ' known</span><span>' + learn.cards.length + ' left</span><span class="gq-sp"></span>' +
      '<button class="gq-link" data-act="home">End</button></div>' +
      '<div class="gq-card' + (learn.flipped ? ' flipped' : '') + '" data-act="flip" role="button" tabindex="-1" aria-label="Flip card">' +
      '<div class="gq-card-front">' + front + '</div>' +
      (learn.flipped ? '<div class="gq-card-back">' + back + '</div>' : '<div class="gq-muted gq-small gq-center">Tap or press Space to flip</div>') + '</div>' +
      '<div class="gq-acts">' + (learn.flipped
        ? '<button class="gq-btn" data-act="again-card">↺ Again <span class="gq-kbd">1</span></button><button class="gq-btn primary" data-act="knew">✓ Got it <span class="gq-kbd">2</span></button>'
        : '<button class="gq-btn primary" data-act="flip">Flip <span class="gq-kbd">Space</span></button>') + '</div>';
  }

  function statsHtml() {
    var rows = '';
    [['flags', 'Flags'], ['flags-rev', 'Flags (reversed)'], ['capitals', 'Capitals'], ['capitals-rev', 'Capitals (reversed)'],
      ['continents', 'Continents'], ['shapes', 'Shapes'], ['map', 'Map']].forEach(function (k) {
      var m = stats.modes[k[0]];
      if (!m || !m.a) return;
      rows += '<tr><td>' + k[1] + '</td><td>' + m.r + '</td><td>' + Math.round(m.c / m.a * 100) + '%</td><td>' + m.bs + '</td><td>' + (m.best ? m.best + '%' : '—') + '</td></tr>';
    });
    var html = '<div class="gq-sheet-title">Statistics</div>';
    html += rows ? '<table class="gq-table"><tr><th>Mode</th><th>Rounds</th><th>Correct</th><th>Streak</th><th>Best</th></tr>' + rows + '</table>'
      : '<div class="gq-muted gq-center gq-pad">No rounds yet.</div>';
    var miss = Object.keys(stats.miss).filter(function (k) { return data && data.byIso[k]; })
      .sort(function (a, b) { return stats.miss[b] - stats.miss[a]; }).slice(0, 12);
    if (miss.length) {
      html += '<div class="gq-sheet-sub">Most missed</div><div class="gq-chips">' + miss.map(function (k) {
        var c = data.byIso[k];
        return '<span class="gq-chip">' + flagHtml(c, 'gq-flag-sm') + esc(c.name) + ' <span class="gq-muted">×' + stats.miss[k] + '</span></span>';
      }).join('') + '</div><div class="gq-acts"><button class="gq-btn" data-act="cards-missed">Study these as cards</button></div>';
    }
    html += '<div class="gq-sheet-sub">Settings</div>' +
      setRow('terr', 'Include territories', 'Greenland, Puerto Rico, Hong Kong, Bermuda, the Faroes… (28 more places)') +
      setRow('auto', 'Next question after a right answer', 'Wrong answers always wait for you') +
      '<div class="gq-acts"><button class="gq-btn danger" data-act="reset">' + (resetArmed ? 'Tap again to reset' : 'Reset statistics') + '</button></div>' +
      '<div class="gq-muted gq-small gq-center">197 sovereign states: the 193 UN members, Vatican City, Palestine, Kosovo and Taiwan.</div>';
    return html;
  }
  function setRow(k, label, hint) {
    return '<div class="gq-set"><div><div class="gq-set-l">' + label + '</div><div class="gq-muted gq-small">' + hint + '</div></div>' +
      '<button class="gq-sw' + (prefs[k] ? ' on' : '') + '" data-set="' + k + '" role="switch" aria-checked="' + (prefs[k] ? 'true' : 'false') + '" aria-label="' + label + '"><i></i></button></div>';
  }

  function barHtml() {
    var key = modeKey(prefs.mode);
    var html = '<div class="gq-tabs" role="tablist">' + MODES.map(function (m) {
      return '<button class="gq-tab' + (prefs.mode === m[0] ? ' on' : '') + '" data-mode="' + m[0] + '" role="tab">' + m[1] + '</button>';
    }).join('') + '</div><div class="gq-optsbar">';
    if (prefs.mode === 'flags' || prefs.mode === 'capitals') {
      html += '<button class="gq-chipb' + (prefs.rev[prefs.mode] ? ' on' : '') + '" data-act="rev" title="Ask the other way round">⇄ Reverse</button>';
    }
    if (prefs.mode !== 'learn' && canType(key)) {
      html += '<div class="gq-seg" role="group" aria-label="Answer style"><button class="gq-segb' + (prefs.input === 'mc' ? ' on' : '') + '" data-input="mc">Choices</button>' +
        '<button class="gq-segb' + (prefs.input === 'type' ? ' on' : '') + '" data-input="type">Type</button></div>';
    }
    html += '<select class="gq-sel" data-pref="region" aria-label="Region"><option value="all">World</option>' +
      CONTS.map(function (c) { return '<option value="' + c[0] + '"' + (prefs.region === c[0] ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') + '</select>';
    if (prefs.mode !== 'learn') {
      html += '<select class="gq-sel" data-pref="len" aria-label="Questions per round">' + [[10, '10 Qs'], [20, '20 Qs'], [0, 'All']].map(function (o) {
        return '<option value="' + o[0] + '"' + (prefs.len === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select>';
    }
    html += '<span class="gq-sp"></span><button class="gq-ic' + (sheet === 'stats' ? ' on' : '') + '" data-act="stats" title="Statistics & settings" aria-label="Statistics and settings">📊</button></div>';
    return html;
  }

  function paint() {
    if (!P) return;
    var bar = q('.gq-bar'), stage = q('.gq-stage'), foot = q('.gq-foot');
    bar.innerHTML = barHtml();
    if (data && !sheet && prefs.mode !== 'learn' && game && game.mode === prefs.mode && !game.over && paintQuizInPlace()) return;
    var html;
    if (!data) html = '<div class="gq-center gq-muted gq-pad">Loading…</div>';
    else if (sheet === 'stats') html = '<div class="gq-sheet">' + statsHtml() + '</div>';
    else if (prefs.mode === 'learn') html = learnHtml();
    else if (game && game.mode === prefs.mode && !game.over) html = quizHtml();
    else if (game && game.mode === prefs.mode && game.over) html = reviewHtml();
    else html = startHtml();
    stage.innerHTML = html;
    var showMap = prefs.mode === 'shapes' || prefs.mode === 'map' || (prefs.mode === 'learn' && needsAtlas(prefs.deck));
    foot.innerHTML = showMap ? 'Map data: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a> (public domain)' : '';
  }

  function focusInput() {
    var inp = q('.gq-input');
    if (!inp) return;
    // Desktop: type straight away. Phones: only once the user has tapped into it
    // (focus() from a tap handler keeps the keyboard up between questions).
    if (document.activeElement === inp) return;
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (!coarse || P.classList.contains('gq-typing')) { try { inp.focus(); } catch (e) {} }
  }

  // ---- events ----------------------------------------------------------------------
  function setMode(m) {
    if (prefs.mode === m) return;
    prefs.mode = m;
    savePrefs();
    sheet = '';
    if (game && game.mode !== m) game = null;
    if (m !== 'learn') learn = null;
    ensureAtlasFor();
    paint();
  }
  function ensureAtlasFor() {
    var need = needsAtlas(prefs.mode) || (prefs.mode === 'learn' && needsAtlas(prefs.deck));
    if (!need || atlas) return;
    var p = P;
    loadAtlas().then(function () { if (P === p) paint(); }, function () { if (P === p) paint(); });
  }

  function onClick(e) {
    var t = e.target;
    if (!t || !t.closest || !data) return;
    var b;
    if ((b = t.closest('[data-mode]'))) { setMode(b.getAttribute('data-mode')); return; }
    if ((b = t.closest('[data-opt]'))) { choose(+b.getAttribute('data-opt')); return; }
    if ((b = t.closest('[data-input]'))) {
      prefs.input = b.getAttribute('data-input'); savePrefs();
      game = null;
      paint(); return;
    }
    if ((b = t.closest('[data-deck]'))) { prefs.deck = b.getAttribute('data-deck'); savePrefs(); ensureAtlasFor(); paint(); return; }
    if ((b = t.closest('[data-set]'))) {
      var k = b.getAttribute('data-set');
      prefs[k] = !prefs[k]; savePrefs();
      if (k === 'terr') { game = null; learn = null; }
      paint(); return;
    }
    if (!(b = t.closest('[data-act]'))) return;
    var act = b.getAttribute('data-act');
    if (act === 'start' || act === 'again') startRound();
    else if (act === 'next') next();
    else if (act === 'check') { P.classList.add('gq-typing'); submitTyped(); }
    else if (act === 'giveup') giveUp();
    else if (act === 'quit') { if (game) { if (game.qs.some(function (x) { return x.done; })) { game.qs = game.qs.filter(function (x) { return x.done; }); finishRound(); } else { game = null; paint(); } } }
    else if (act === 'home') { game = null; learn = null; paint(); }
    else if (act === 'rev') { prefs.rev[prefs.mode] = !prefs.rev[prefs.mode]; savePrefs(); game = null; paint(); }
    else if (act === 'stats') { sheet = sheet === 'stats' ? '' : 'stats'; resetArmed = 0; paint(); }
    else if (act === 'view') { prefs.view = prefs.view === 'zoom' ? 'world' : 'zoom'; savePrefs(); paint(); }
    else if (act === 'retry-atlas') { ensureAtlasFor(); paint(); }
    else if (act === 'learn') startLearn();
    else if (act === 'flip') flip();
    else if (act === 'knew') grade(true);
    else if (act === 'again-card') grade(false);
    else if (act === 'cards-miss' || act === 'cards-missed') {
      var list = act === 'cards-miss'
        ? game.qs.filter(function (x) { return x.done && !x.ok; }).map(function (x) { return x.c; })
        : Object.keys(stats.miss).map(function (k) { return data.byIso[k]; }).filter(Boolean);
      var deck = game && (game.mode === 'shapes' || game.mode === 'map' || game.mode === 'capitals') ? game.mode : 'flags';
      prefs.mode = 'learn'; prefs.deck = act === 'cards-miss' ? deck : 'flags'; savePrefs();
      sheet = ''; game = null;
      startLearn(shuffle(list.slice()));
    } else if (act === 'reset') {
      if (!resetArmed) { resetArmed = 1; paint(); later(function () { resetArmed = 0; if (sheet === 'stats') paint(); }, 3000); return; }
      stats = { modes: {}, miss: {} }; saveStats(); resetArmed = 0;
      Cade.showToast('Statistics reset', 'success', 1500);
      paint();
    }
  }

  function onChange(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var k = t.getAttribute('data-pref');
    if (!k) return;
    if (k === 'region') prefs.region = t.value;
    else if (k === 'len') prefs.len = +t.value;
    savePrefs();
    game = null; learn = null;
    paint();
  }

  function onInputKey(e) {
    if (!e.target.classList || !e.target.classList.contains('gq-input')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      P.classList.add('gq-typing');
      var qn = current();
      if (qn && qn.done) next(); else submitTyped();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.target.blur();
    }
    e.stopPropagation(); // keep editor/global shortcuts out of the answer box
  }

  function onKey(e) {
    if (!P || !P.isConnected || !active) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    var k = e.key, kl = k.length === 1 ? k.toLowerCase() : k;
    if (k === 'Escape') {
      if (sheet) { sheet = ''; paint(); } else close();
    } else if (sheet) {
      return;
    } else if (prefs.mode === 'learn' && learn && learn.cards.length) {
      if (k === ' ' || k === 'Enter') { if (learn.flipped && k === 'Enter') grade(true); else flip(); }
      else if (learn.flipped && (kl === '1' || k === 'ArrowLeft')) grade(false);
      else if (learn.flipped && (kl === '2' || k === 'ArrowRight')) grade(true);
      else return;
    } else if (k === 'Enter' || k === ' ' || k === 'ArrowRight') {
      var qn = current();
      if (prefs.mode === 'learn') { if (k === 'Enter') startLearn(); else return; }
      else if (!game || game.mode !== prefs.mode) { if (k === 'Enter') startRound(); else return; }
      else if (game.over) { if (k === 'Enter') startRound(); else return; }
      else if (qn && qn.done) next();
      else if (qn && qn.type) { var inp = q('.gq-input'); if (inp) inp.focus(); }
      else return;
    } else if (game && !game.over && game.mode === prefs.mode && /^[1-6a-f]$/.test(kl)) {
      var cur = current();
      if (!cur || cur.done || !cur.opts) return;
      var idx = /\d/.test(kl) ? +kl - 1 : KEYS.indexOf(kl);
      if (idx >= cur.opts.length) return;
      choose(idx);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // A press inside the panel arms keyboard capture; a press anywhere else
  // (the editor, another panel) or focus moving elsewhere hands it back.
  function setActive(on) {
    if (!P || on === active) return;
    active = on;
    P.classList.toggle('gq-idle', !active);
    if (active) blurEditor();
  }
  function onDocPointer(e) { if (P) setActive(P.contains(e.target)); }
  function onDocFocus(e) {
    if (!P || P.contains(e.target)) return;
    // Focus settling right after opening (palette closing, editor refocusing)
    // must not hand the keyboard straight back.
    if (Date.now() - openedAt < 600) { blurEditor(); return; }
    setActive(false);
  }
  function blurEditor() {
    try { if (Cade.editor && Cade.editor.hasFocus) Cade.editor.contentDOM.blur(); } catch (e) {}
  }

  function cleanup() {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('focusin', onDocFocus, true);
    clearTimers();
    P = null; game = null; learn = null; sheet = ''; active = false; resetArmed = 0;
    world = null; // the big path string; rebuilt from `atlas` on demand
  }
  function close() {
    var p = P;
    cleanup();
    if (p) p.remove();
  }

  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    loadPrefs();
    P = Cade.mkPanel(PANEL_ID, '🌍 Geography Quiz',
      '<div class="gq-bar"></div><div class="gq-stage" aria-live="polite"></div><div class="gq-foot"></div>');
    P._onClose = cleanup;
    active = true; openedAt = Date.now();
    blurEditor();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('focusin', onDocFocus, true);
    P.addEventListener('click', onClick);
    P.addEventListener('change', onChange);
    P.addEventListener('keydown', onInputKey);
    // Buttons mustn't steal focus from the answer box or start text selection.
    P.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('button, .gq-card')) e.preventDefault();
    });
    P.addEventListener('pointerdown', function (e) {
      if (e.target.classList && e.target.classList.contains('gq-input')) P.classList.add('gq-typing');
    });
    ensureFlagFont();
    paint();
    var p = P;
    loadData().then(function () {
      if (P !== p) return;
      ensureAtlasFor();
      paint();
    }, function () {
      if (P !== p) return;
      var st = q('.gq-stage');
      if (st) st.innerHTML = '<div class="gq-center gq-muted gq-pad">Couldn’t load the country list' + (navigator.onLine === false ? ' — it needs one online load to cache' : '') + '</div>';
    });
  }

  Cade.registerWidget({
    name: 'Geography Quiz',
    description: 'Flags, capitals, continents, country shapes & map quiz — with flash cards',
    icon: '🌍',
    tags: 'game,quiz,geography,flags,flag,capitals,capital,countries,country,continents,map,world,shapes,learn,flash cards,trivia,fun',
    open: open,
    // Pure logic, exposed for tests / tooling (no side effects).
    _logic: {
      flagEmoji: flagEmoji, parseData: parseData, norm: norm, compact: compact, editDist: editDist, judge: judge,
      pickDistractors: pickDistractors, pickRound: pickRound, capClash: capClash, decodeTopo: decodeTopo,
      unwrapRing: unwrapRing, buildAtlas: buildAtlas, shapeOf: shapeOf, laea: laea, ortho: ortho, equalEarth: equalEarth,
      silhouettePath: silhouettePath, orthoRing: orthoRing, angDist: angDist,
    },
  });
})();
