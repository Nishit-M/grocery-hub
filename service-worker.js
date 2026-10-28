/* Grocery Hub service worker.
   - Precaches the app shell under a cache name that includes APP_VERSION.
   - Serves the shell cache-first so the app opens offline.
   - Never touches Firebase / Google API traffic (Firestore keeps its own offline copy). */
importScripts('config.js');

const VERSION = (self.GH_CONFIG && self.GH_CONFIG.APP_VERSION) || '0';
const CACHE = 'grocery-hub-' + VERSION;
const FIREBASE_SDK = '10.14.1'; // keep in sync with the imports at the top of app.js

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'config.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png'
];
const SDK = ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js']
  .map(f => `https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/${f}`);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    // The SDK is cached too so the app starts offline; a failure here must not block install.
    await Promise.all(SDK.map(url =>
      cache.add(new Request(url, { mode: 'cors' })).catch(() => null)));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('grocery-hub-') && k !== CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Same-origin app shell: cache first, network fallback.
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        return (await cache.match('index.html')) || fetch(req);
      })());
      return;
    }
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      return hit || fetch(req);
    })());
    return;
  }

  // Firebase SDK files (static, versioned URLs): cache first.
  if (url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
  }
  // Everything else (Firestore, sign-in, Google APIs) goes straight to the network, never cached.
});
