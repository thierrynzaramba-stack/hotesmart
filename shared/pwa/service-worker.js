/* ============================================================
   HôteSmart — service worker de l'appli hôte (PWA lot 1)
   KB : docs/kb/pwa.md · Tests : tests/pwa-service-worker.test.js

   Servi à l'adresse /sw.js par api/pwa.js?f=sw, qui remplace le jeton
   de VERSION ci-dessous par le SHA du déploiement. Chaque déploiement
   produit donc un service worker différent octet par octet — c'est le
   seul signal qui fasse se réinstaller un service worker, et c'est lui
   qui purge le cache du déploiement d'avant.

   CE QU'IL FAIT, ET RIEN D'AUTRE :
   1. PAGES HTML (navigations) : RÉSEAU UNIQUEMENT. Jamais lues ni
      écrites dans le cache. La recette voit toujours la production
      réelle, et une page déployée s'affiche au premier chargement.
      Seulement si le réseau échoue : la page hors-ligne.
   2. /api/, Supabase, et tout ce qui n'est pas dans la liste positive :
      il ne s'en mêle pas (pas de respondWith). Le navigateur fait
      exactement comme s'il n'y avait pas de service worker.
   3. LISTE POSITIVE de fichiers statiques — charte, icônes, logo,
      i18n, police — : RÉSEAU D'ABORD, copie en cache pour le
      hors-ligne seulement. En ligne, rien n'est servi depuis le cache.
   4. À l'activation : purge des caches des déploiements précédents et
      de celui de l'ancien service worker « HoteSmart Tarifs », qui
      vivait à la même adresse et mettait les pages HTML en cache.
   AUCUNE notification push dans ce lot. Aucun texte affiché, aucun hexa.

   ⚠ LE CACHE STORAGE EST PARTAGÉ PAR TOUTE L'ORIGINE. L'appli
   prestataire (apps/menages/sw.js) y a le sien, `hotesmart-clean-*` :
   on ne touche qu'aux noms qui commencent par PREFIXE, plus l'héritage
   nommé. Et comme SON activation efface tous les caches qui ne sont pas
   le sien, le nôtre se reconstitue après chaque navigation réussie
   (`reconstituer`) — sinon la page hors-ligne disparaîtrait en silence.
   ============================================================ */
'use strict'

const VERSION = '__HS_VERSION__'
const PREFIXE = 'hotesmart-pwa-'
const CACHE = PREFIXE + VERSION
const HERITES = ['hotesmart-shell-v1']

const PAGE_HORS_LIGNE = '/shared/pwa/hors-ligne'
// La MÊME adresse que la feuille de police des pages V5 (tests le vérifient) :
// une autre adresse serait une autre entrée de cache, jamais retrouvée.
const POLICE = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap'
const ORIGINES_POLICE = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']

// ⚠ LA SEULE LISTE DE CE QUI PEUT ENTRER DANS LE CACHE. Des fichiers du
// dépôt, identiques pour tout le monde : aucune donnée de compte ne peut y
// vivre. Ajouter une ligne ici, c'est ajouter un fichier au hors-ligne.
const STATIQUES = [
  '/shared/theme.css',
  '/shared/ui.css',
  '/shared/icons.svg',
  '/shared/logo.svg',
  '/shared/i18n/i18n.js',
  '/shared/i18n/langues.json',
  '/shared/i18n/fr.json',
  '/shared/i18n/en.json',
  '/shared/i18n/es.json'
]

function estHtml (res) {
  return /text\/html/i.test(res.headers.get('Content-Type') || '')
}

// Une requête que le service worker a le droit de servir depuis le cache.
// Pour l'origine du site : la liste positive, et aucun paramètre d'URL
// sinon `v` (la version des dictionnaires) — un jeton glissé dans une
// adresse n'entre jamais dans une clé de cache.
function estCachable (url) {
  if (url.origin === self.location.origin) {
    return STATIQUES.includes(url.pathname) && [...url.searchParams.keys()].every(k => k === 'v')
  }
  return ORIGINES_POLICE.includes(url.origin)
}

// Une réponse que le service worker a le droit de COPIER dans le cache.
function rangeable (res) {
  if (!res || res.status !== 200) return false
  // Jamais d'opaque : on ne sait pas ce qu'il contient.
  if (res.type !== 'basic' && res.type !== 'cors') return false
  if (estHtml(res)) return false
  const cc = res.headers.get('Cache-Control') || ''
  if (/no-store|private/i.test(cc)) return false
  return true
}

async function precharger (cache) {
  await Promise.all([PAGE_HORS_LIGNE, ...STATIQUES].map(async (url) => {
    // `reload` : jamais la copie du cache HTTP — les dictionnaires y sont
    // gardés un an, et sans version dans l'URL on relirait l'ancien.
    const res = await fetch(new Request(url, { cache: 'reload' }))
    // La page hors-ligne est la SEULE réponse HTML admise dans le cache.
    const admise = url === PAGE_HORS_LIGNE ? (res.status === 200 && estHtml(res)) : rangeable(res)
    if (!admise) throw new Error('précache refusé : ' + url)
    await cache.put(url, res)
  }))
  // La police est un confort : sans elle, la page retombe sur system-ui.
  try {
    const res = await fetch(new Request(POLICE, { mode: 'cors', cache: 'reload' }))
    if (rangeable(res)) await cache.put(POLICE, res)
  } catch (_) {}
}

async function reconstituer () {
  const cache = await caches.open(CACHE)
  if (await cache.match(PAGE_HORS_LIGNE)) return
  await precharger(cache).catch(() => {})
}

async function pageHorsLigne () {
  const cache = await caches.open(CACHE)
  const enCache = await cache.match(PAGE_HORS_LIGNE)
  if (!enCache) return null
  // Réponse RECONSTRUITE : celle du cache peut porter l'indicateur
  // « redirigée », qu'un navigateur refuse pour une navigation.
  return new Response(await enCache.blob(), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  })
}

async function naviguer (event) {
  try {
    const avance = await event.preloadResponse
    const res = avance || await fetch(event.request)
    event.waitUntil(reconstituer())
    return res
  } catch (erreur) {
    const page = await pageHorsLigne()
    if (page) return page
    throw erreur
  }
}

async function depuisLeCache (req) {
  const cache = await caches.open(CACHE)
  const exacte = await cache.match(req, { ignoreVary: true })
  if (exacte) return exacte
  // Les dictionnaires sont demandés avec `?v=<version>` et préchargés sans :
  // même fichier, même déploiement.
  if (new URL(req.url).origin === self.location.origin) {
    return cache.match(req, { ignoreSearch: true, ignoreVary: true })
  }
  return undefined
}

async function reseauDAbord (event) {
  const req = event.request
  try {
    const res = await fetch(req)
    if (rangeable(res)) {
      const copie = res.clone()
      event.waitUntil(caches.open(CACHE).then(c => c.put(req, copie)).catch(() => {}))
    }
    return res
  } catch (erreur) {
    const enCache = await depuisLeCache(req)
    if (enCache) return enCache
    throw erreur
  }
}

function aPurger (nom) {
  return (nom.startsWith(PREFIXE) && nom !== CACHE) || HERITES.includes(nom)
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(precharger).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const noms = await caches.keys()
    await Promise.all(noms.filter(aPurger).map(n => caches.delete(n)))
    // La requête de la page part pendant que le service worker démarre :
    // le réseau seul ne coûte pas son temps de réveil.
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable() } catch (_) {}
    }
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  if (req.mode === 'navigate') {
    event.respondWith(naviguer(event))
    return
  }
  if (!estCachable(new URL(req.url))) return
  event.respondWith(reseauDAbord(event))
})
