// sw.js - Service worker PWA HoteSmart Tarifs
// Strategie : network-first pour la navigation et les API, cache de secours pour la coquille.
// On ne met JAMAIS en cache les reponses /api/ (donnees tarifaires fraiches obligatoires).

const CACHE = 'hotesmart-shell-v1'
const SHELL = [
  '/m/calendrier',
  '/shared/supabase.js',
  '/shared/api-client.js',
  '/shared/logger.js',
  '/shared/config.js',
  '/manifest.webmanifest'
]

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(()=>{})))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  )
  self.clients.claim()
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  // Ne jamais intercepter/cacher les appels API : toujours le reseau
  if (url.pathname.startsWith('/api/')) return
  // Pour le reste : network-first, fallback cache
  e.respondWith(
    fetch(e.request).then(res => {
      if (e.request.method === 'GET' && res.ok && url.origin === self.location.origin) {
        const copy = res.clone()
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{})
      }
      return res
    }).catch(() => caches.match(e.request))
  )
})
