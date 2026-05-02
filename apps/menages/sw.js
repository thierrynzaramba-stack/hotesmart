// HôteSmart Clean - Service Worker
// Strategie: network-first avec fallback cache
// Bumper CACHE_VERSION a chaque deploiement majeur force le refresh
const CACHE_VERSION = 'hotesmart-clean-v1';
const OFFLINE_URLS = [
  './public.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(OFFLINE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Pas de cache pour les appels API ou Supabase
  if (req.url.includes('/api/') || req.url.includes('supabase.co')) {
    return;
  }
  // Pour les autres ressources (HTML/CSS/JS/icones): network-first
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./public.html')))
  );
});
