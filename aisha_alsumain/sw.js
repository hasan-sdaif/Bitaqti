
const CACHE_VERSION = 'v4';
const CACHE_NAME = 'aisha-cv-' + CACHE_VERSION;
const OFFLINE_URL = './index.html';

// Core app shell — pre-cached on install so the app works offline immediately
const CORE_ASSETS = [
  './',
  './index.html',
  './portfolio.html',
  './manifest.webmanifest',
  './sw.js',
  './robots.txt'
];

// Optional assets that may fail (photo.jpg may not exist yet) — fail silently
const OPTIONAL_ASSETS = [
  './photo.jpg'
];

// ═══════════════════════════════════════════════════════════════════
// INSTALL — pre-cache the app shell
// ═══════════════════════════════════════════════════════════════════
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // Cache core assets (fail-fast: if any fails, install fails)
      await cache.addAll(CORE_ASSETS);

      // Cache optional assets (fail silently)
      await Promise.all(
        OPTIONAL_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'reload' });
            if (res && res.ok) await cache.put(url, res);
          } catch (e) { /* ignore */ }
        })
      );

      // Pre-cache Google Fonts CSS + font files for offline use
      try {
        const fontCssUrls = [
          'https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&family=Source+Sans+3:wght@300;400;500;600;700;800&family=Amiri:wght@400;700&family=Tajawal:wght@300;400;500;700;800;900&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap'
        ];
        for (const url of fontCssUrls) {
          const res = await fetch(url);
          if (res && res.ok) {
            await cache.put(url, res.clone());
            // Also cache the actual font files referenced in the CSS
            const css = await res.text();
            const fontUrlMatches = css.match(/https:\/\/fonts\.gstatic\.com\/[^)]+/g) || [];
            for (const fontUrl of fontUrlMatches) {
              try {
                const fontRes = await fetch(fontUrl);
                if (fontRes && fontRes.ok) await cache.put(fontUrl, fontRes);
              } catch (e) { /* ignore individual font failures */ }
            }
          }
        }
      } catch (e) { /* fonts are nice-to-have, not critical */ }

      // Activate immediately without waiting for old SW to release
      await self.skipWaiting();
    })()
  );
});

// ═══════════════════════════════════════════════════════════════════
// ACTIVATE — clean up old caches & take control
// ═══════════════════════════════════════════════════════════════════
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Delete all caches that don't match the current version
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );

      // Take control of all clients immediately
      await self.clients.claim();

      // Notify clients that a new SW has activated (so they can prompt reload)
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(client => {
        client.postMessage({ type: 'SW_ACTIVATED', version: CACHE_VERSION });
      });
    })()
  );
});

// ═══════════════════════════════════════════════════════════════════
// FETCH — offline-first routing
// ═══════════════════════════════════════════════════════════════════
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET requests
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // ── Strategy 1: Navigation requests → network-first with offline fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          // Try network first
          const networkRes = await fetch(req);
          // Cache the latest version
          const cache = await caches.open(CACHE_NAME);
          cache.put('./index.html', networkRes.clone());
          return networkRes;
        } catch (e) {
          // Network failed — try the requested URL in cache
          const cached = await caches.match(req);
          if (cached) return cached;
          // Then try the offline fallback
          const offline = await caches.match(OFFLINE_URL);
          if (offline) return offline;
          // Last resort: cached root
          const root = await caches.match('./');
          return root || Response.error();
        }
      })()
    );
    return;
  }

  // ── Strategy 2: Same-origin assets → cache-first, then network
  if (sameOrigin) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;

        try {
          const networkRes = await fetch(req);
          if (networkRes && networkRes.status === 200 && networkRes.type !== 'opaque') {
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, networkRes.clone());
          }
          return networkRes;
        } catch (e) {
          // Network failed and not in cache
          return cached || Response.error();
        }
      })()
    );
    return;
  }

  // ── Strategy 3: Cross-origin (Google Fonts, etc.) → stale-while-revalidate
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);

      // Revalidate in background
      const networkResPromise = fetch(req)
        .then(res => {
          if (res && res.status === 200) {
            cache.put(req, res.clone());
          }
          return res;
        })
        .catch(() => null);

      // Return cached immediately if available, otherwise wait for network
      return cached || (await networkResPromise) || Response.error();
    })()
  );
});

// ═══════════════════════════════════════════════════════════════════
// MESSAGE — handle messages from clients
// ═══════════════════════════════════════════════════════════════════
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_VERSION });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PERIODIC SYNC — (future-ready) refresh cache when browser supports it
// ═══════════════════════════════════════════════════════════════════
if ('periodicSync' in self) {
  self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'refresh-content') {
      event.waitUntil(refreshCache());
    }
  });
}

async function refreshCache() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    await Promise.all(
      requests.map(async (req) => {
        try {
          const res = await fetch(req);
          if (res && res.status === 200) {
            await cache.put(req, res);
          }
        } catch (e) { /* ignore */ }
      })
    );
  } catch (e) { /* ignore */ }
}
