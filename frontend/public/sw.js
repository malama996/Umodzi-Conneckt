/**
 * Umodzi Connect service worker (V0.2).
 *
 * Registered in production builds only (see components/ServiceWorkerRegistration).
 * Low-data strategy:
 * - The app shell (HTML routes) is precached at install time.
 * - Large hero images in /images/ are NEVER precached; they use a runtime
 *   stale-while-revalidate strategy so they are only downloaded when visited.
 * - Hashed static assets under /_next/static/ use a cache-first strategy (they are
 *   content-hashed and immutable).
 * - Navigations are network-first so new deployments never serve stale HTML;
 *   the cached shell is an offline fallback only.
 * - Caches are versioned and old caches are purged on activation.
 */
const SHELL_CACHE = 'umodzi-shell-v1';
const RUNTIME_CACHE = 'umodzi-runtime-v1';

const SHELL_URLS = ['/', '/matching', '/login', '/register', '/dashboard'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Network-first: never serve stale HTML from a previous deployment.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('/')))
    );
    return;
  }

  if (url.pathname.startsWith('/_next/static/')) {
    // Content-hashed immutable assets: cache-first.
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
            return response;
          })
      )
    );
    return;
  }

  if (url.pathname.startsWith('/images/')) {
    // Runtime stale-while-revalidate: images are never precached.
    event.respondWith(
      caches.match(request).then((hit) => {
        const refresh = fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
            return response;
          })
          .catch(() => hit);
        return hit || refresh;
      })
    );
  }
});

/**
 * Web Push (Task 28.2C — triggers wired since Task 28.2D/33.4).
 * No caching changes above this line.
 *
 * A push payload is a convenience, never a contract: the handler works
 * with an empty/missing payload too. Only same-origin relative URLs are
 * honoured for notification clicks (a payload can never redirect the user
 * off-site). The backend pushes event notifications (chat messages,
 * request/offer events) with a generic title/body and ids only — never
 * message text or personal data.
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  if (payload === null || typeof payload !== 'object') payload = {};
  const title =
    typeof payload.title === 'string' && payload.title ? payload.title : 'Umodzi Connect';
  const url =
    typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/';
  const options = { data: { url } };
  if (typeof payload.body === 'string' && payload.body) options.body = payload.body;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = event.notification && event.notification.data ? event.notification.data.url : '/';
  const url = typeof raw === 'string' && raw.startsWith('/') ? raw : '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => {
        for (const client of windows) {
          if (client.url === self.location.origin + url && 'focus' in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(url);
        }
        return undefined;
      })
  );
});
