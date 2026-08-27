const CACHE_NAME = 'worker-ledger-v26';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=16',
  './app.js?v=25',
  './assets/phosphor/style.css?v=1',
  './assets/phosphor/Phosphor.woff2',
  './manifest.webmanifest',
  './favicon.svg?v=8',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  const isAppAsset = requestUrl.origin === self.location.origin && /\/(?:|index\.html|styles\.css|app\.js|sw\.js|manifest\.webmanifest|favicon\.svg|style\.css|Phosphor\.woff2)$/.test(requestUrl.pathname);
  if (isAppAsset) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
