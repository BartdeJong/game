const CACHE_PREFIX = 'skyline-dice-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v1`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const scopeUrl = new URL(self.registration.scope);
    await cache.addAll([
      scopeUrl.href,
      new URL('index.html', scopeUrl).href,
      new URL('manifest.webmanifest', scopeUrl).href,
      new URL('icons/favicon.svg', scopeUrl).href,
      new URL('icons/favicon-32.png', scopeUrl).href,
      new URL('icons/icon-192.png', scopeUrl).href,
      new URL('icons/icon-512.png', scopeUrl).href,
      new URL('icons/apple-touch-icon.png', scopeUrl).href,
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const scopeUrl = new URL(self.registration.scope);
  const requestUrl = new URL(request.url);
  if (
    request.method !== 'GET' ||
    requestUrl.origin !== scopeUrl.origin ||
    !requestUrl.pathname.startsWith(scopeUrl.pathname)
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        return await cache.match(request) ?? await cache.match(scopeUrl.href);
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
