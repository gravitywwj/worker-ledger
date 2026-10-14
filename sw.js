const CACHE_NAME = 'worker-ledger-v33';
const APP_SHELL = [
  './',
  './src/product-prices.mjs',
  './src/product-ui.mjs',
  './src/product-backup.mjs',
  './src/transaction-history.mjs',
  './agent/periodic-review.mjs',
  './index.html',
  './src/styles.css?v=21',
  './src/app.js?v=37',
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
  const isAppAsset = requestUrl.origin === self.location.origin && /\/(?:|index\.html|src\/(?:app\.js|styles\.css|transaction-history\.mjs|product-(?:backup|prices|ui)\.mjs)|sw\.js|manifest\.webmanifest|favicon\.svg|style\.css|Phosphor\.woff2)$/.test(requestUrl.pathname);
  const isOcrAsset = requestUrl.origin === self.location.origin && /^\/node_modules\/(?:tesseract\.js\/dist\/(?:tesseract\.esm\.min\.js|worker\.min\.js)|tesseract\.js-core\/tesseract-core-lstm\.wasm(?:\.js)?|@tesseract\.js-data\/chi_sim\/4\.0\.0_best_int\/chi_sim\.traineddata\.gz)$/.test(requestUrl.pathname);
  if (isOcrAsset) {
    event.respondWith((async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) {
        try { await (await caches.open(CACHE_NAME)).put(event.request, response.clone()); } catch {}
      }
      return response;
    })());
    return;
  }
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
