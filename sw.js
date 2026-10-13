/* NakaKgolo service worker.
   Caches the app shell so the app opens and runs with no connection.
   Stale-while-revalidate: cached files load instantly and are refreshed in the background.
   Bump CACHE_VERSION when you change the shell's file list so old caches are removed. */
const CACHE_VERSION = 'nakakgolo-v1';
const SHELL = [
  '', 'index.html', 'styles.css', 'app.js', 'chart.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

const urlFor = path => new URL(path, self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(SHELL.map(urlFor)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req, { ignoreSearch: true });

    const network = fetch(req)
      .then(res => {
        if (res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      })
      .catch(() => undefined);

    if (cached) {
      network; // keep the cache fresh in the background
      return cached;
    }
    const fresh = await network;
    return fresh || cache.match(urlFor('index.html'));
  })());
});
