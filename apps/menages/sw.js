// HôteSmart Clean - Service Worker
// Strategie: network-first avec fallback cache
// Bumper CACHE_VERSION a chaque deploiement majeur force le refresh
// ⚠ BUMPE A LA REFONTE v2 (17 septembre 2026). La strategie est network-first,
// donc un navigateur EN LIGNE ne sert jamais d'ancien code — mais une PWA
// installee, ouverte hors ligne puis revenue, garde l'ancienne coquille dans
// l'ancien cache. Bumper force son eviction a l'activation.
// ⚠ BUMPE LE 14 OCTOBRE 2026, ET CE N'EST PAS COSMETIQUE : les caches deja
// crees peuvent contenir des entrees dont la CLE porte un jeton (voir le
// filtre du `fetch` ci-dessous). L'activation supprime toute version qui n'est
// pas celle-ci : changer le nom est ce qui les EVINCE.
const CACHE_VERSION = 'hotesmart-clean-v4-sans-jeton';
const OFFLINE_URLS = [
  './public.html',
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
  // ⚠ UNE URL QUI PORTE UN JETON NE SE MET PAS EN CACHE (constat de securite
  // de la revue de 6d007f3). La CLE du cache est l'URL complete : un document
  // mis en cache sous `public.html?token=…` range le jeton dans le Cache
  // Storage, et il y reste. Le cas qui l'a fait voir : l'hote ouvre la page de
  // sa prestataire dans un cadre (mode apercu), sur un navigateur ou CE service
  // worker est deja installe — le scope l'intercepte, et le jeton d'une tierce
  // personne atterrit dans le cache de l'hote. Ne rien cacher ici ne coute
  // rien : le repli hors ligne sert `./public.html` (sans parametre), et le
  // jeton est relu depuis le stockage local.
  if (req.url.includes('token=') || req.url.includes('apercu=1')) {
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
