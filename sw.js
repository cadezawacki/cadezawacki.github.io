// ============================================
// Cade.txt Service Worker
// Strategy:
//   - HTML + manifest: stale-while-revalidate (instant offline, updates in bg)
//   - Fontshare CSS + font files: stale-while-revalidate
//   - CDN scripts (firebase, jszip, typo.js): stale-while-revalidate (opaque OK)
//   - Spell-check dictionary (.aff/.dic): precached CORS-readable so the
//     page can read them with fetch().text() while offline
//   - Firebase realtime DB: bypass (live data, needs network)
// ============================================

const CACHE_VERSION = 91;
const CACHE_NAME = `cade-v${CACHE_VERSION}`;

// Same-origin pages to precache on install.
// Note: we use absolute paths so the cache keys match navigation requests.
const PRECACHE = [
  './txt.html',
  './gif.html',
  './photo.html',
  './manifest.webmanifest',
];

// Cross-origin assets to precache (opaque, no-cors).
// IMPORTANT: the fontshare stylesheet must be cached or the page can
// stall / render unstyled when offline on iOS.
const PRECACHE_CROSS_ORIGIN = [
  'https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600&f[]=jetbrains-mono@400,500&display=swap',
  // IBM Plex (Google Fonts) — used by gif.html / index.html. Caching the CSS
  // lets the font load offline; the referenced gstatic font files get cached
  // on first use via the stale-while-revalidate fetch handler below.
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,100..700;1,100..700&family=IBM+Plex+Mono:wght@400;500&display=swap',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,100..700;1,100..700&display=swap',
  'https://fonts.googleapis.com/css2?family=Anton&family=Archivo+Black&family=Bebas+Neue&family=Caveat:wght@400;700&family=Cormorant+Garamond:ital,wght@0,400;0,700;1,400&family=Dancing+Script:wght@400;700&family=DM+Sans:ital,wght@0,400;0,700;1,400&family=DM+Serif+Display:ital@0;1&family=Fira+Code:wght@400;700&family=Great+Vibes&family=Inter:wght@100;300;400;500;700;900&family=JetBrains+Mono:ital,wght@0,400;0,700;1,400&family=Lato:ital,wght@0,400;0,700;0,900;1,400&family=Lobster&family=Lora:ital,wght@0,400;0,700;1,400&family=Merriweather:ital,wght@0,400;0,700;1,400&family=Montserrat:ital,wght@0,400;0,700;0,900;1,400&family=Nunito:ital,wght@0,400;0,700;0,900;1,400&family=Open+Sans:ital,wght@0,400;0,700;1,400&family=Oswald:wght@400;700&family=Pacifico&family=Permanent+Marker&family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=Poppins:ital,wght@0,400;0,700;0,900;1,400&family=Roboto:ital,wght@0,400;0,700;0,900;1,400&family=Shadows+Into+Light&family=Work+Sans:ital,wght@0,400;0,700;1,400&display=swap',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  // Spell-checker library — loaded via <script>, so an opaque cache entry is fine.
  'https://cdn.jsdelivr.net/npm/typo-js@1.2.5/typo.js',
];

// Cross-origin assets the PAGE reads as text via fetch().text(). These must be
// cached CORS-readable (NOT opaque) or the text comes back empty offline.
// jsDelivr serves Access-Control-Allow-Origin:* so a 'cors' fetch succeeds.
const PRECACHE_CORS = [
  'https://cdn.jsdelivr.net/npm/typo-js@1.2.5/dictionaries/en_US/en_US.aff',
  'https://cdn.jsdelivr.net/npm/typo-js@1.2.5/dictionaries/en_US/en_US.dic',
];

// ---- Install: precache critical resources (best-effort, per-URL) ----
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Same-origin: fetch individually so one failure doesn't kill all.
    await Promise.allSettled(
      PRECACHE.map(async (url) => {
        try {
          const r = await fetch(url, { cache: 'reload' });
          if (r.ok) await cache.put(url, r);
        } catch {}
      })
    );

    // Cross-origin: opaque responses still serve offline via <script>/<link>.
    await Promise.allSettled(
      PRECACHE_CROSS_ORIGIN.map(async (url) => {
        try {
          const r = await fetch(url, { mode: 'no-cors' });
          await cache.put(url, r);
        } catch {}
      })
    );

    // Cross-origin but CORS-readable (dictionary): must stay non-opaque so the
    // page can read them with fetch().text() while offline.
    await Promise.allSettled(
      PRECACHE_CORS.map(async (url) => {
        try {
          const r = await fetch(url, { mode: 'cors' });
          if (r.ok) await cache.put(url, r);
        } catch {}
      })
    );

    // Feature modules: read ./txt/manifest.json and precache every module's
    // entry + css + listed assets so they're available offline (stale-while-
    // revalidate alone only caches a module AFTER it's been fetched online once).
    // The manifest is the single source of truth — no duplicate list here.
    await precacheModules(cache);

    await self.skipWaiting();
  })());
});

// Precache module files enumerated by ./txt/manifest.json (best-effort).
async function precacheModules(cache) {
  try {
    const mr = await fetch('./txt/manifest.json', { cache: 'reload' });
    if (!mr.ok) return;
    await cache.put('./txt/manifest.json', mr.clone());
    const manifest = await mr.json();
    const files = [];
    for (const m of (manifest.modules || [])) {
      if (m.entry) files.push('./txt/' + m.entry);
      if (m.css) files.push('./txt/' + m.css);
      for (const f of (m.precache || [])) files.push('./txt/' + f);
    }
    await Promise.allSettled(files.map(async (u) => {
      try { const r = await fetch(u, { cache: 'reload' }); if (r.ok) await cache.put(u, r); } catch {}
    }));
  } catch {}
}

// ---- Activate: purge old caches, claim clients ----
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// ---- Fetch handler ----
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle http(s)
  if (!url.protocol.startsWith('http')) return;

  // Firebase realtime DB needs live network; never intercept.
  if (url.hostname.includes('firebaseio.com')) return;
  // Bypass Google APIs (Firebase, etc.) for live data — but DO cache Google Fonts.
  if (url.hostname.includes('googleapis.com') && !url.hostname.startsWith('fonts.')) return;

  // Navigation (the HTML page itself): stale-while-revalidate with offline fallback.
  if (request.mode === 'navigate') {
    e.respondWith(navigationHandler(request));
    return;
  }

  // Everything else (CSS/JS/fonts): stale-while-revalidate.
  e.respondWith(staleWhileRevalidate(request));
});

// ---- Message channel ----
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data && e.data.type === 'CLEAR_PHOTO_CACHE') {
    caches.open(CACHE_NAME).then(async (cache) => {
      const keys = await cache.keys();
      await Promise.all(keys.map((req) => {
        const u = new URL(req.url);
        const isPhoto = /(^|\/)photo\.html$/.test(u.pathname) || u.hostname.includes('fonts.googleapis.com') || u.hostname.includes('fonts.gstatic.com') || u.hostname.includes('huggingface.co') || u.hostname.includes('cdn.jsdelivr.net') || u.hostname.includes('unpkg.com');
        return isPhoto ? cache.delete(req) : Promise.resolve(false);
      }));
    });
  }
  if (e.data === 'REFRESH_CACHE') {
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.allSettled(
        [...PRECACHE, ...PRECACHE_CROSS_ORIGIN].map(async (url) => {
          try {
            const mode = url.startsWith('http') && !url.includes(self.location.host)
              ? 'no-cors' : 'same-origin';
            const r = await fetch(url, { mode, cache: 'reload' });
            if (mode === 'no-cors' || r.ok) await cache.put(url, r);
          } catch {}
        })
      );
      // Dictionary stays CORS-readable.
      await Promise.allSettled(
        PRECACHE_CORS.map(async (url) => {
          try {
            const r = await fetch(url, { mode: 'cors', cache: 'reload' });
            if (r.ok) await cache.put(url, r);
          } catch {}
        })
      );
      // Refresh feature modules from the manifest too (reconnect without a bump).
      await precacheModules(cache);
    });
  }
});

// ---- Strategy: navigation (HTML) ----
// Serve cached HTML instantly, revalidate in background. Cache under the
// requested URL (never under a hard-coded key) so sibling pages at the
// SW's root scope can't overwrite the txt.html offline shell.
// Only txt.html itself is used as the offline fallback.
async function navigationHandler(request) {
  const cache = await caches.open(CACHE_NAME);
  const url = new URL(request.url);
  const isAppShell =
    url.origin === self.location.origin &&
    /(^|\/)txt\.html$/.test(url.pathname);

  const cached = await cache.match(request);

  const networkPromise = fetch(request).then((response) => {
    if (response && response.ok) {
      // Cache under the exact request, not a shared key.
      cache.put(request, response.clone());
      // Also keep a canonical './txt.html' copy in sync, but ONLY when
      // the request actually IS txt.html.
      if (isAppShell) cache.put('./txt.html', response.clone());
    }
    return response;
  }).catch(() => null);

  if (cached) {
    networkPromise; // fire-and-forget refresh
    return cached;
  }

  const network = await networkPromise;
  if (network) return network;

  // Offline and no cache for this exact URL.
  // Only fall back to the txt.html shell if that's what was requested.
  if (isAppShell) {
    const shell = await cache.match('./txt.html');
    if (shell) return shell;
  }

  return new Response(
    '<!doctype html><meta charset=utf-8><title>Offline</title>' +
    '<body style="font-family:system-ui;padding:2rem;background:#111;color:#eee">' +
    '<h1>Offline</h1><p>Open the app once while online so it can cache itself.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

// ---- Strategy: stale-while-revalidate ----
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const networkPromise = fetch(request).then((response) => {
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  return cached || await networkPromise || new Response('', { status: 504 });
}
