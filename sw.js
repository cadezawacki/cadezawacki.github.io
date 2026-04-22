// ============================================
// Cade.txt Service Worker
// Strategy:
//   - HTML + manifest: stale-while-revalidate (instant offline, updates in bg)
//   - Fontshare CSS + font files: stale-while-revalidate
//   - CDN scripts (firebase, jszip): stale-while-revalidate (opaque OK)
//   - Firebase realtime DB: bypass (live data, needs network)
// ============================================

const CACHE_VERSION = 5;
const CACHE_NAME = `cade-v${CACHE_VERSION}`;

// Same-origin pages to precache on install.
// Note: we use absolute paths so the cache keys match navigation requests.
const PRECACHE = [
  './txt.html',
  './manifest.webmanifest',
];

// Cross-origin assets to precache (opaque, no-cors).
// IMPORTANT: the fontshare stylesheet must be cached or the page can
// stall / render unstyled when offline on iOS.
const PRECACHE_CROSS_ORIGIN = [
  'https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600&f[]=jetbrains-mono@400,500&display=swap',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
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

    await self.skipWaiting();
  })());
});

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
  if (url.hostname.includes('googleapis.com')) return;

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
