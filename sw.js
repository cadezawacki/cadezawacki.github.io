const CACHE = 'cade-txt-v1';
const PRECACHE_SAME_ORIGIN = ['./txt.html'];
const PRECACHE_CROSS_ORIGIN = [
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Same-origin: normal cache add
    await cache.addAll(PRECACHE_SAME_ORIGIN).catch(() => {});
    // Cross-origin: fetch with no-cors so we get opaque responses that still load offline
    await Promise.all(PRECACHE_CROSS_ORIGIN.map(url =>
      fetch(url, { mode: 'no-cors' })
        .then(r => cache.put(url, r))
        .catch(() => {})
    ));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // For navigation requests (the HTML page itself), use network-first so updates are picked up
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return r;
        })
        .catch(() => caches.match('./txt.html'))
    );
    return;
  }
  // For everything else: cache-first, update in background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request)
        .then(r => {
          if (r.ok || r.type === 'opaque') {
            caches.open(CACHE).then(c => c.put(e.request, r.clone()));
          }
          return r;
        })
        .catch(() => {});
      return cached || networkFetch;
    })
  );
});
