/* ═══════════════════════════════════════════════════════════════
   SERVICE WORKER — Offline caching for Cade.project
   Caches CDN libraries and app shell for full offline use
   ═══════════════════════════════════════════════════════════════ */

const CACHE_NAME = 'cade-project-v9';
const CDN_CACHE = 'cade-cdn-v9';

// App shell — local files
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './state.js',
  './sync.js',
  './bridge.js',
  './charts.js',
  './timers.js',
  './palette.js',
  './manifest.json',
];

// CDN resources to cache
const CDN_RESOURCES = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://unpkg.com/lucide@latest/dist/umd/lucide.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js',
  'https://api.fontshare.com/v2/css?f[]=general-sans@300,400,500,600,700&display=swap',
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap',
];

// Install — cache app shell and CDN resources
self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)),
      caches.open(CDN_CACHE).then(cache =>
        Promise.allSettled(
          CDN_RESOURCES.map(url =>
            // no-cors: fontshare/google CSS don't send a wildcard
            // Access-Control-Allow-Origin, so a cors-mode fetch is blocked.
            // Opaque responses still serve <link>/<script> loads offline.
            fetch(url, { mode: 'no-cors' }).then(res => {
              if (res.ok || res.type === 'opaque') cache.put(url, res.clone());
            }).catch(() => {})
          )
        )
      ),
    ])
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          // Cache Storage is shared origin-wide with the root site's service
          // worker (../sw.js) — only ever delete caches from THIS app's family.
          .filter(key => (key.startsWith('cade-project-') || key.startsWith('cade-cdn-')) &&
            key !== CACHE_NAME && key !== CDN_CACHE)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch — cache-first for CDN, network-first for app shell
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET
  if (event.request.method !== 'GET') return;

  // Skip cross-origin requests that aren't CDN resources
  const isCDN = CDN_RESOURCES.some(r => url.href.startsWith(r)) ||
    url.hostname === 'cdn.jsdelivr.net' ||
    url.hostname === 'unpkg.com' ||
    url.hostname === 'www.gstatic.com' ||
    url.hostname === 'api.fontshare.com' ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com';

  if (isCDN) {
    // Cache-first for CDN
    event.respondWith(
      caches.open(CDN_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const res = await fetch(event.request);
          if (res.ok || res.type === 'opaque') cache.put(event.request, res.clone());
          return res;
        } catch (e) {
          return cached || new Response('', { status: 408 });
        }
      })
    );
  } else {
    // Network-first for app shell
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        try {
          const res = await fetch(event.request);
          if (res.ok && url.origin === location.origin) {
            cache.put(event.request, res.clone());
          }
          return res;
        } catch (e) {
          const cached = await cache.match(event.request);
          if (cached) return cached;
          // Fallback to index.html for navigation requests
          if (event.request.mode === 'navigate') {
            return cache.match('./index.html');
          }
          return new Response('', { status: 408 });
        }
      })
    );
  }
});
