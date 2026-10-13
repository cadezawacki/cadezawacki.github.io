/* Shared location helper for the Weather and Sun & Moon widgets.
 *
 * Both widgets read/write ONE saved location (Cade.store 'cade-geo-location',
 * JSON { name, lat, lon, tz, source, admin?, country?, cc? }) plus a short
 * list of saved places, so picking a city in one shows up in the other. A
 * 'cade-geo-change' window event tells an open sibling panel to follow.
 *
 * Network (only on explicit user action):
 *  - city search: Open-Meteo geocoding (GET, no key, CORS *)
 *  - "Use my location": navigator.geolocation (asked on button press only),
 *    then BigDataCloud's free client-side reverse geocoder for a place name +
 *    IANA time zone (falls back to coordinates + the device zone).
 *
 * The app's service worker serves every GET stale-while-revalidate and keeps
 * it; these lookups are one-offs, so we ask for no-store and delete our own
 * entries from the SW cache afterwards (sweep) so nothing accumulates.
 *
 * Loaded by <script> injection from either widget; idempotent. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__cadeGeo) return;
  var Cade = window.Cade;

  var KEY = 'cade-geo-location';
  var PLACES_KEY = 'cade-geo-places';
  var MAX_PLACES = 8;
  var GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
  var REVERSE = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

  function store() { return Cade && Cade.store; }
  function readJSON(k, d) {
    try { var v = JSON.parse(store().get(k) || 'null'); return v == null ? d : v; } catch (e) { return d; }
  }
  function writeJSON(k, v) { try { store().set(k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return Cade && Cade.escapeHtml ? Cade.escapeHtml(String(s == null ? '' : s)) : String(s); }

  function deviceTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
  }
  function validTz(tz) {
    if (!tz || typeof tz !== 'string') return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true; } catch (e) { return false; }
  }
  function lang() { return ((navigator.language || 'en').split('-')[0] || 'en').toLowerCase(); }

  function norm(loc) {
    if (!loc) return null;
    var lat = +loc.lat, lon = +loc.lon;
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    var o = {
      name: String(loc.name || (lat.toFixed(2) + ', ' + lon.toFixed(2))).slice(0, 80),
      lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4,
      tz: validTz(loc.tz) ? loc.tz : '',
      source: loc.source || 'search',
    };
    if (loc.admin) o.admin = String(loc.admin).slice(0, 60);
    if (loc.country) o.country = String(loc.country).slice(0, 60);
    if (loc.cc) o.cc = String(loc.cc).slice(0, 2).toUpperCase();
    return o;
  }
  function keyOf(loc) { return loc ? (+loc.lat).toFixed(2) + ',' + (+loc.lon).toFixed(2) : ''; }
  function same(a, b) { return !!a && !!b && keyOf(a) === keyOf(b); }

  function get() { return norm(readJSON(KEY, null)); }
  function places() {
    var a = readJSON(PLACES_KEY, []);
    return Array.isArray(a) ? a.map(norm).filter(Boolean) : [];
  }
  function addPlace(loc) {
    var list = places().filter(function (p) { return !same(p, loc); });
    list.unshift(loc);
    writeJSON(PLACES_KEY, list.slice(0, MAX_PLACES));
  }
  function removePlace(loc) {
    writeJSON(PLACES_KEY, places().filter(function (p) { return !same(p, loc); }));
  }
  // Save as THE location (+ remember it); tell any other open panel.
  function set(loc, from) {
    var n = norm(loc);
    if (!n) return null;
    writeJSON(KEY, n);
    addPlace(n);
    try { window.dispatchEvent(new CustomEvent('cade-geo-change', { detail: { loc: n, from: from || '' } })); } catch (e) {}
    return n;
  }
  // Fill in a missing time zone learned later (e.g. from the forecast reply).
  function patchTz(loc, tz) {
    if (!loc || !validTz(tz) || loc.tz === tz) return loc;
    loc.tz = tz;
    var cur = get();
    if (same(cur, loc)) { cur.tz = tz; writeJSON(KEY, cur); }
    var list = places();
    list.forEach(function (p) { if (same(p, loc)) p.tz = tz; });
    writeJSON(PLACES_KEY, list);
    return loc;
  }

  function flag(cc) {
    if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return '';
    cc = cc.toUpperCase();
    return String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65, 0x1F1E6 + cc.charCodeAt(1) - 65);
  }
  function label(loc) { return loc ? loc.name : ''; }
  function sublabel(loc) {
    if (!loc) return '';
    var parts = [];
    if (loc.admin && loc.admin !== loc.name) parts.push(loc.admin);
    if (loc.country) parts.push(loc.country);
    return parts.join(', ');
  }

  // Remove our one-off GETs from the service worker's cache (see header).
  // The SW stores a response only after reading its whole body, which can
  // land just after we're done with it — so sweep now and once more shortly.
  var sweepTimer = 0;
  function sweep(bases) {
    sweepNow(bases);
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(function () { sweepNow(bases); }, 3000);
  }
  function sweepNow(bases) {
    try {
      if (!window.caches || !caches.keys) return;
      caches.keys().then(function (names) {
        names.forEach(function (n) {
          if (!/^cade-v\d+$/.test(n)) return;
          caches.open(n).then(function (c) {
            bases.forEach(function (b) { c.delete(b, { ignoreSearch: true, ignoreVary: true }).catch(function () {}); });
          }).catch(function () {});
        });
      }).catch(function () {});
    } catch (e) {}
  }

  function getJSON(url, signal, headers) {
    var opts = { cache: 'no-store', credentials: 'omit' };
    if (signal) opts.signal = signal;
    if (headers) opts.headers = headers;
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // City search → [{ name, admin, country, cc, lat, lon, tz, pop }]
  function search(q, signal) {
    q = String(q || '').trim();
    if (q.length < 2) return Promise.resolve([]);
    var url = GEOCODE + '?name=' + encodeURIComponent(q) + '&count=8&language=' + lang() + '&format=json';
    return getJSON(url, signal).then(function (d) {
      sweep([GEOCODE]);
      return (d && d.results || []).map(function (r) {
        return norm({
          name: r.name, admin: r.admin1 || r.admin2 || '', country: r.country || '', cc: r.country_code || '',
          lat: r.latitude, lon: r.longitude, tz: r.timezone, source: 'search',
        });
      }).filter(Boolean);
    });
  }

  function reverse(lat, lon) {
    var url = REVERSE + '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) + '&localityLanguage=' + lang();
    return getJSON(url).then(function (d) {
      sweep([REVERSE]);
      var tz = '';
      var inf = d && d.localityInfo && d.localityInfo.informative || [];
      for (var i = 0; i < inf.length; i++) {
        if (/time ?zone/i.test(inf[i].description || '') && validTz(inf[i].name)) { tz = inf[i].name; break; }
      }
      return {
        name: d.city || d.locality || d.principalSubdivision || '',
        admin: d.principalSubdivision || '', country: d.countryName || '', cc: d.countryCode || '', tz: tz,
      };
    });
  }

  // Browser geolocation (prompted only when the user presses the button).
  function locate() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) { reject(new Error('Location isn\u2019t available in this browser')); return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        var lat = pos.coords.latitude, lon = pos.coords.longitude;
        var base = { lat: lat, lon: lon, source: 'gps', tz: deviceTz() };
        reverse(lat, lon).then(function (r) {
          base.name = r.name || 'My location';
          base.admin = r.admin; base.country = r.country; base.cc = r.cc;
          if (r.tz) base.tz = r.tz;
          resolve(norm(base));
        }, function () {
          base.name = 'My location';
          resolve(norm(base));
        });
      }, function (err) {
        var msg = err && err.code === 1 ? 'Location permission denied \u2014 search for a city instead'
          : err && err.code === 3 ? 'Location timed out \u2014 try again or search'
          : 'Couldn\u2019t get your location';
        reject(new Error(msg));
      }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60000 });
    });
  }

  /* Location picker UI: search box with suggestions, "use my location", and
     the saved-places list. opts: { onPick(loc), current: loc, autofocus }.
     Returns { el, focus(), destroy() }. Styles live in geo.css. */
  function picker(opts) {
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'geo-pick';
    el.innerHTML =
      '<div class="geo-search"><span class="geo-ico" aria-hidden="true">\u2315</span>' +
      '<input class="geo-q" type="search" placeholder="Search for a city\u2026" autocomplete="off" autocorrect="off" ' +
      'autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Search for a city"></div>' +
      '<button class="geo-loc" type="button"><span class="geo-loc-ico" aria-hidden="true">\u25ce</span> Use my current location</button>' +
      '<div class="geo-res" role="listbox" aria-label="Search results"></div>' +
      '<div class="geo-saved"></div>';
    var q = el.querySelector('.geo-q'), res = el.querySelector('.geo-res'), saved = el.querySelector('.geo-saved');
    var locBtn = el.querySelector('.geo-loc');
    var ctrl = null, timer = null, results = [], sel = -1, dead = false;

    function row(loc, i, kind) {
      var cur = same(loc, opts.current);
      return '<div class="geo-item' + (kind === 'res' && i === sel ? ' sel' : '') + (cur ? ' cur' : '') + '" role="option" data-kind="' + kind + '" data-i="' + i + '" tabindex="-1">' +
        '<span class="geo-flag" aria-hidden="true">' + (flag(loc.cc) || (loc.source === 'gps' ? '\u25ce' : '\u2022')) + '</span>' +
        '<span class="geo-txt"><span class="geo-name">' + esc(loc.name) + '</span>' +
        '<span class="geo-sub">' + esc(sublabel(loc) || (loc.lat.toFixed(2) + ', ' + loc.lon.toFixed(2))) + '</span></span>' +
        (kind === 'saved' ? (cur ? '<span class="geo-cur">current</span>' : '') +
          '<button class="geo-x" type="button" data-i="' + i + '" title="Forget this place" aria-label="Forget ' + esc(loc.name) + '">\u00d7</button>' : '') +
        '</div>';
    }
    function renderSaved() {
      var list = places();
      saved.innerHTML = list.length
        ? '<div class="geo-sec">Saved places</div>' + list.map(function (p, i) { return row(p, i, 'saved'); }).join('')
        : '<div class="geo-hint">Places you pick are remembered here.</div>';
    }
    function renderRes(msg) {
      if (msg) { res.innerHTML = '<div class="geo-hint">' + esc(msg) + '</div>'; return; }
      res.innerHTML = results.map(function (r, i) { return row(r, i, 'res'); }).join('');
    }
    function pick(loc) { if (loc && opts.onPick) opts.onPick(loc); }

    function run() {
      var v = q.value.trim();
      if (ctrl) { try { ctrl.abort(); } catch (e) {} ctrl = null; }
      if (v.length < 2) { results = []; sel = -1; renderRes(''); return; }
      ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      renderRes('Searching\u2026');
      search(v, ctrl && ctrl.signal).then(function (list) {
        if (dead) return;
        results = list; sel = list.length ? 0 : -1;
        renderRes(list.length ? '' : 'No places found for \u201c' + v + '\u201d');
      }, function (e) {
        if (dead || (e && e.name === 'AbortError')) return;
        renderRes(navigator.onLine === false ? 'You\u2019re offline \u2014 saved places still work' : 'Search failed \u2014 try again');
      });
    }
    q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 300); });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); renderRes(''); }
      else if (e.key === 'ArrowUp' && results.length) { e.preventDefault(); sel = Math.max(0, sel - 1); renderRes(''); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (results[sel]) pick(results[sel]);
        else { clearTimeout(timer); run(); }
      }
    });
    el.addEventListener('click', function (e) {
      var x = e.target.closest && e.target.closest('.geo-x');
      if (x) {
        e.stopPropagation();
        var lp = places()[+x.getAttribute('data-i')];
        if (lp) removePlace(lp);
        renderSaved();
        return;
      }
      var it = e.target.closest && e.target.closest('.geo-item');
      if (it) {
        var i = +it.getAttribute('data-i');
        pick(it.getAttribute('data-kind') === 'res' ? results[i] : places()[i]);
      }
    });
    locBtn.addEventListener('click', function () {
      locBtn.disabled = true;
      locBtn.classList.add('busy');
      locBtn.lastChild.nodeValue = ' Locating\u2026';
      locate().then(function (loc) {
        if (dead) return;
        pick(loc);
      }, function (e) {
        if (dead) return;
        if (Cade && Cade.showToast) Cade.showToast(e.message, 'error', 3200);
      }).then(function () {
        if (dead) return;
        locBtn.disabled = false;
        locBtn.classList.remove('busy');
        locBtn.lastChild.nodeValue = ' Use my current location';
      });
    });
    renderSaved();
    return {
      el: el,
      focus: function () { try { q.focus(); } catch (e) {} },
      destroy: function () { dead = true; clearTimeout(timer); if (ctrl) { try { ctrl.abort(); } catch (e) {} } },
    };
  }

  window.__cadeGeo = {
    KEY: KEY, get: get, set: set, places: places, addPlace: addPlace, removePlace: removePlace,
    patchTz: patchTz, keyOf: keyOf, same: same, deviceTz: deviceTz, validTz: validTz,
    search: search, reverse: reverse, locate: locate, picker: picker, flag: flag,
    label: label, sublabel: sublabel, sweep: sweep, norm: norm,
  };
})();
