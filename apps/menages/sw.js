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
// ⚠ BUMPE LE 15 OCTOBRE 2026, ET C'EST CE QUI FAIT ARRIVER LA REFONTE V5
// jusqu'à une PWA installée (constat de la revue de 41d4afe). Sans bump, le
// `install` ne se rejoue pas — sw.js n'aurait pas changé — et l'entrée
// `./public.html` du cache précédent reste celle figée la veille. Or les
// navigations de la prestataire portent TOUJOURS un jeton, donc le handler
// `fetch` ne les remet jamais en cache (`avecJeton`, plus bas) : ouverte hors
// ligne, elle aurait vu l'ancienne page indéfiniment, même après dix passages
// en ligne.
// ⚠ REBUMPE LE 16 OCTOBRE 2026 : `public.html` a changé deux fois depuis
// (modernisation, puis vignettes et vert du jour courant), et le mécanisme
// décrit juste au-dessus vaut à chaque fois — sans bump, une PWA installée
// ouverte hors ligne sert indéfiniment l'entrée précachée de la veille. Un
// seul bump couvre les commits d'un même lot ; ce qui ne se rattrape pas,
// c'est de l'oublier avant la mise en production.
const CACHE_VERSION = 'hotesmart-clean-v6-vignettes';
// ⚠ LES DEUX FEUILLES DE STYLE SONT DANS LA COQUILLE DEPUIS LA CHARTE V5
// (constat de la revue de 41d4afe). `public.html` remappe les seize variables
// de `public/style.css` SUR les tokens de `theme.css` : sans `theme.css`, les
// valeurs de repli de l'ancienne feuille sont détruites elles aussi, et
// l'écran ne se contente pas d'être dépouillé — il devient inutilisable
// (fonds transparents, `min-height: var(--control)` à `auto`, tailles de
// police initiales). Une dépendance dont l'absence casse l'écran se précache.
// La police, elle, reste dehors : son absence fait retomber sur `system-ui`,
// ce qui est une dégradation, pas une panne.
const OFFLINE_URLS = [
  './public.html',
  '/shared/theme.css',
  '/public/style.css',
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
  // personne atterrit dans le cache de l'hote.
  //
  // ⚠ ON NE CACHE PAS, MAIS ON REPOND QUAND MEME. Un `return` sec rendait la
  // main au navigateur : il supprimait du meme coup le REPLI HORS LIGNE pour
  // ces URL — c'est-a-dire pour TOUTES les navigations de la prestataire, dont
  // le `start_url` de sa PWA installee, qui porte toujours son jeton. Le mode
  // hors ligne, qui est la raison d'etre de cette application, tombait a 100 %
  // des lancements (constat de la re-revue de e528ca1). Le repli sert
  // `./public.html` — la coquille sans parametre, deja en cache — et le jeton
  // est relu depuis le stockage local.
  const avecJeton = req.url.includes('token=') || req.url.includes('apercu=1');
  // Pour les autres ressources (HTML/CSS/JS/icones): network-first
  // ⚠ LE REPLI SUR LA COQUILLE NE VAUT QUE POUR UNE NAVIGATION (constat de la
  // revue de 41d4afe). Il répondait `public.html` à N'IMPORTE QUELLE requête
  // ratée — donc à `/shared/theme.css` sur un premier chargement en réseau
  // faible : le navigateur recevait du `text/html` pour une feuille de style,
  // la refusait, et la page tombait sans aucune de ses variables. Une
  // sous-ressource qui manque doit échouer comme elle échouerait sans service
  // worker ; le document, lui, garde son repli — c'est la raison d'être de
  // cette application.
  const navigation = req.mode === 'navigate';
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (!avecJeton) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(avecJeton && navigation ? './public.html' : req)
        .then((cached) => {
          if (cached) return cached;
          if (navigation) return caches.match('./public.html');
          return Response.error();
        }))
  );
});
