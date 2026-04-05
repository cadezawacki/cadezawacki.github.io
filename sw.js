// ============================================
// Cade.txt Service Worker
// Strategy: Network-first for pages, stale-while-revalidate for assets
// ============================================

const CACHE_VERSION = 1;
const CACHE_NAME = `cade-v${CACHE_VERSION}`;

// Same-origin pages to precache on install
const PRECACHE = ['./txt.html'];

// CDN assets to precache (opaque, no-cors)
const PRECACHE_CDN = [
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
];

// ---- Install: precache critical resources ----
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE).catch(() => {});
    // CDN scripts require no-cors (opaque responses still serve offline)
    await Promise.allSettled(
      PRECACHE_CDN.map(url =>
        fetch(url, { mode: 'no-cors' }).then(r => cache.put(url, r))
      )
    );
  })());
  self.skipWaiting();
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

// ---- Fetch strategies ----
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Ignore non-http(s), Firebase realtime / API calls, and font requests
  // (fonts are cross-origin with CORS headers, they cache fine via browser)
  if (!url.protocol.startsWith('http')) return;
  if (url.hostname.includes('firebaseio.com')) return;
  if (url.hostname.includes('fontshare.com')) return;

  // Navigation (the HTML page): network-first
  if (request.mode === 'navigate') {
    e.respondWith(networkFirst(request));
    return;
  }

  // CDN scripts: stale-while-revalidate
  e.respondWith(staleWhileRevalidate(request));
});

// ---- Message channel ----
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'CACHE_BUST') {
    caches.open(CACHE_NAME).then(cache =>
      cache.keys().then(keys =>
        Promise.all(keys.map(k => cache.delete(k)))
      )
    );
  }
});

// ---- Strategy: network-first ----
// Try network; on success, cache the fresh response. On failure, serve cache.
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request) || await caches.match('./txt.html');
    return cached || new Response('Offline — no cached version available', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

// ---- Strategy: stale-while-revalidate ----
// Serve from cache immediately if available; refresh cache in background.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const networkPromise = fetch(request).then(response => {
    if (response.ok || response.type === 'opaque') {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  return cached || await networkPromise || new Response('', { status: 504 });
}
