// Minimal service worker for offline support
const CACHE_NAME = 'm3-svelte-cache-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Clean up old caches if needed in future versions
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => (key !== CACHE_NAME ? caches.delete(key) : Promise.resolve()))
      );
      await self.clients.claim();
      if ('periodicSync' in registration) {
        try {
          // Request a periodic sync every 15 minutes for background tasks
          // Name: 'gmail-sync' (ops flush + snooze processing delegated to client via postMessage)
          await registration.periodicSync.register('gmail-sync', { minInterval: 15 * 60 * 1000 });
        } catch {}
      }
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;

      try {
        const response = await fetch(request);
        if (response && response.status === 200 && response.type === 'basic') {
          cache.put(request, response.clone());
        }
        return response;
      } catch {
        return cached || Response.error();
      }
    })()
  );
});

// Notify clients periodically to trigger background processing in the app
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'gmail-sync') {
    event.waitUntil(
      (async () => {
        const allClients = await self.clients.matchAll({ type: 'window' });
        for (const c of allClients) c.postMessage({ type: 'SYNC_TICK' });
      })()
    );
  }
});


