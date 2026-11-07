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
   5. NOTIFICATIONS PUSH (lot 2a) : chaque message reçu AFFICHE une
      notification, toujours — Safari retire l'abonnement d'un service
      worker qui en reçoit une sans rien montrer. Le message est au
      format déclaratif (`web_push: 8030`), écrit par le serveur
      (lib/push/envoyer.js) : le texte affiché vient de lui. Au toucher,
      on ouvre l'écran visé, jamais hors du site. Un abonnement
      renouvelé par le navigateur est refait ici, mais rien n'est écrit
      côté serveur (pas de session ici) : c'est la page qui le renvoie.
   Aucun hexa. Aucun texte affiché, sinon le nom « HôteSmart » quand le
   message reçu est illisible.

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
// `url` : l'adresse demandée (une réponse construite n'en porte pas toujours).
function rangeable (res, url) {
  if (!res || res.status !== 200) return false
  // Jamais d'opaque : on ne sait pas ce qu'il contient (et son statut est 0).
  if (res.type !== 'basic' && res.type !== 'cors') return false
  if (estHtml(res)) return false
  const cc = res.headers.get('Cache-Control') || ''
  if (/no-store/i.test(cc)) return false
  // ⚠ `private` EST REFUSÉ PARTOUT SAUF CHEZ GOOGLE FONTS (constat de review) :
  // sa feuille de police est servie `private` parce qu'elle varie selon le
  // NAVIGATEUR, pas selon un compte. Refusée, la police n'atteignait jamais le
  // hors-ligne. Sur l'origine du site, `private` reste une donnée de compte.
  if (/private/i.test(cc) && !ORIGINES_POLICE.includes(url.origin)) return false
  return true
}

async function precharger (cache) {
  await Promise.all([PAGE_HORS_LIGNE, ...STATIQUES].map(async (url) => {
    // `reload` : jamais la copie du cache HTTP — les dictionnaires y sont
    // gardés un an, et sans version dans l'URL on relirait l'ancien.
    const res = await fetch(new Request(url, { cache: 'reload' }))
    // La page hors-ligne est la SEULE réponse HTML admise dans le cache.
    const admise = url === PAGE_HORS_LIGNE ? (res.status === 200 && estHtml(res)) : rangeable(res, new URL(url, self.location.origin))
    if (!admise) throw new Error('précache refusé : ' + url)
    await cache.put(url, res)
  }))
  // La police est un confort : sans elle, la page retombe sur system-ui.
  try {
    const res = await fetch(new Request(POLICE, { mode: 'cors', cache: 'reload' }))
    if (rangeable(res, new URL(POLICE))) await cache.put(POLICE, res)
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
    if (rangeable(res, new URL(req.url))) {
      const copie = res.clone()
      // Clé = l'ADRESSE seule, pas l'objet requête de la page et ses en-têtes.
      event.waitUntil(caches.open(CACHE).then(c => c.put(req.url, copie)).catch(() => {}))
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

// ─── Notifications push (lot 2a) ─────────────────────────────────────────────

const ACCUEIL = '/dashboard'
const ICONE = '/shared/pwa/icone-192.png'

function chaine (v, max) {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

// Un chemin du site, et rien d'autre : sinon l'accueil. Même règle que le
// serveur (lib/push/envoyer.js) et que la page de connexion (`next`).
function cheminSur (brut) {
  const s = typeof brut === 'string' ? brut : ''
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\')) return ACCUEIL
  try {
    const u = new URL(s, self.location.origin)
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : ACCUEIL
  } catch (_) { return ACCUEIL }
}

function lireMessage (event) {
  try {
    const m = event.data ? event.data.json() : null
    return m && typeof m === 'object' && m.notification && typeof m.notification === 'object' ? m.notification : {}
  } catch (_) { return {} }
}

// ⚠ AFFICHE TOUJOURS, MÊME SUR UN MESSAGE ILLISIBLE. Un push qui ne montre
// rien fait retirer l'abonnement par Safari (« silent push penalties ») : on
// préfère une notification nue à un appareil qui ne reçoit plus rien.
function afficher (event) {
  const n = lireMessage(event)
  const titre = chaine(n.title, 120) || 'HôteSmart'
  const tag = chaine(n.tag, 64)
  const options = {
    body: chaine(n.body, 300),
    icon: ICONE,
    lang: chaine(n.lang, 5) || 'fr',
    dir: n.dir === 'rtl' ? 'rtl' : 'ltr',
    data: { chemin: cheminSur(n.navigate) }
  }
  if (tag) {
    options.tag = tag
    options.renotify = n.renotify === true
  }
  return self.registration.showNotification(titre, options)
}

async function ouvrir (chemin) {
  const cible = new URL(cheminSur(chemin), self.location.origin).href
  const fenetres = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const f of fenetres) {
    if (new URL(f.url).origin !== self.location.origin) continue
    try {
      const ouverte = f.navigate ? await f.navigate(cible) : null
      if (ouverte && ouverte.focus) return ouverte.focus()
      if (f.focus) return f.focus()
    } catch (_) { /* fenêtre non contrôlée : on en ouvre une */ }
  }
  return self.clients.openWindow(cible)
}

self.addEventListener('push', (event) => {
  event.waitUntil(afficher(event))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  event.waitUntil(ouvrir(data.chemin))
})

// Le navigateur a renouvelé l'abonnement : on se réabonne avec la même clé.
// ⚠ RIEN N'EST ÉCRIT CÔTÉ SERVEUR : le service worker n'a pas de session. La
// page, à sa prochaine ouverture, compare et renvoie l'abonnement par le POST
// de /api/push, avec tous ses contrôles (shared/push-appareil.js).
self.addEventListener('pushsubscriptionchange', (event) => {
  const avant = event.oldSubscription && event.oldSubscription.options
  if (!avant || !avant.applicationServerKey) return
  event.waitUntil(self.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: avant.applicationServerKey
  }).catch(() => {}))
})
