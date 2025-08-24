// Minimal service worker for offline support
const CACHE_NAME = 'Jmail-v1.0.8';

self.addEventListener('install', () => {
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
        } catch (_) {
          // ignore
        }
      }
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Never cache navigations; always go to network to avoid serving stale index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match(request);
          return cached || Response.error();
        }
      })()
    );
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

// Basic notification helper for due snoozes; app triggers show via postMessage
self.addEventListener('message', async (event) => {
  const data = event.data || {};
  if (data && data.type === 'SHOW_NOTIFICATION' && self.registration?.showNotification) {
    const { title, body, tag, data: extra, actions } = data.payload || {};
    try {
      await self.registration.showNotification(title || 'Update', {
        body: body || '',
        tag: tag || undefined,
        data: extra || undefined,
        actions: actions || [
          { action: 'archive', title: 'Archive' },
          { action: 'snooze1h', title: '+1h' }
        ]
      });
    } catch (_) {
      // ignore
    }
  }
});

self.addEventListener('notificationclick', (event) => {
  const action = event.action;
  const ndata = event.notification?.data || {};
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window' });
    const url = ndata.threadId ? `/viewer/${ndata.threadId}` : '/';
    const client = (all[0] && 'focus' in all[0]) ? all[0] : await self.clients.openWindow(url);
    if (client && 'postMessage' in client) {
      client.postMessage({ type: 'NOTIFICATION_ACTION', action, data: ndata });
      client.focus && client.focus();
    }
  })());
});


