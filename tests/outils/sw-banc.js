// tests/outils/sw-banc.js
//
// LE BANC DU SERVICE WORKER HÔTE (PWA lot 1). Il exécute le VRAI code de
// shared/pwa/service-worker.js — version injectée par lib/pwa.js, exactement
// ce que sert /sw.js — dans un faux navigateur : CacheStorage en mémoire,
// réseau scripté, événements install / activate / fetch.
//
// ⚠ CE QU'IL NE SIMULE PAS, dit plutôt que tu : le cache HTTP du navigateur,
// la mise à jour du service worker par le navigateur (on charge la nouvelle
// version à la main), les en-têtes `Vary`. La recette sur téléphone couvre le
// reste — docs/kb/pwa.md §Recette.
const vm = require('node:vm')
const { serviceWorker } = require('../../lib/pwa')

const ORIGINE = 'https://hotesmart.test'

// Un CacheStorage en mémoire, PARTAGEABLE entre deux versions du service
// worker (un déploiement puis le suivant, sur le même téléphone).
function creerStockage () {
  const caches = new Map() // nom → Map(url → entrée)
  const lireCle = (req) => (typeof req === 'string' ? new URL(req, ORIGINE).href : req.url)
  const sansRecherche = (u) => { const x = new URL(u); x.search = ''; return x.href }

  function ouvrir (nom) {
    if (!caches.has(nom)) caches.set(nom, new Map())
    const entrees = caches.get(nom)
    return {
      async put (req, res) {
        const url = lireCle(req)
        const corps = Buffer.from(await res.arrayBuffer())
        entrees.set(url, { url, statut: res.status, entetes: [...res.headers], corps })
      },
      async match (req, opts = {}) {
        const url = lireCle(req)
        let e = entrees.get(url)
        if (!e && opts.ignoreSearch) e = [...entrees.values()].find(x => sansRecherche(x.url) === sansRecherche(url))
        return e ? new Response(e.corps, { status: e.statut, headers: e.entetes }) : undefined
      },
      async keys () { return [...entrees.keys()].map(u => new Request(u)) },
      async delete (req) { return entrees.delete(lireCle(req)) }
    }
  }

  return {
    caches,
    api: {
      async open (nom) { return ouvrir(nom) },
      async keys () { return [...caches.keys()] },
      async has (nom) { return caches.has(nom) },
      async delete (nom) { return caches.delete(nom) },
      async match (req, opts) {
        for (const nom of caches.keys()) {
          const r = await ouvrir(nom).match(req, opts)
          if (r) return r
        }
        return undefined
      }
    },
    // L'inventaire COMPLET : chaque entrée de chaque cache, corps compris.
    inventaire () {
      const out = []
      for (const [nom, entrees] of caches) {
        for (const e of entrees.values()) {
          const h = new Headers(e.entetes)
          out.push({
            cache: nom,
            url: e.url,
            type: h.get('content-type') || '',
            cacheControl: h.get('cache-control') || '',
            corps: e.corps.toString('utf8')
          })
        }
      }
      return out
    }
  }
}

// Une réponse « du réseau » : le type (basic / cors / opaque) est posé à la
// main, un Response construit par Node rendant toujours « default ».
// ⚠ UNE RÉPONSE OPAQUE EST CELLE D'UN VRAI NAVIGATEUR (constat de review) :
// statut 0, aucun en-tête lisible, aucun corps. Le banc la faisait 200 avec
// ses en-têtes, ce qui laissait croire la garde de type tenue par un test.
function reponse ({ statut = 200, type = 'basic', entetes = {}, corps = '' } = {}) {
  const r = type === 'opaque'
    ? Response.error()
    : new Response(statut === 204 ? null : corps, { status: statut, headers: entetes })
  Object.defineProperty(r, 'type', { value: type })
  return r
}

// Charge une version du service worker. `reseau(requete)` rend une description
// de réponse, ou LÈVE pour simuler l'absence de réseau.
function chargerServiceWorker ({ version = 'abc1234', source, stockage = creerStockage(), reseau }) {
  const code = source !== undefined ? source : serviceWorker(version)
  const ecouteurs = {}
  let precharge = false
  const appelsReseau = []

  class RequeteSW extends Request {
    constructor (entree, init) {
      super(typeof entree === 'string' ? new URL(entree, ORIGINE).href : entree, init)
    }
  }

  async function fetchFaux (entree, init) {
    const req = entree instanceof Request ? entree : new RequeteSW(entree, init)
    appelsReseau.push(req.url)
    const d = await reseau(req)
    return reponse(d)
  }

  const contexte = {
    console,
    URL,
    Headers,
    Response,
    Request: RequeteSW,
    Promise,
    fetch: fetchFaux,
    caches: stockage.api,
    location: new URL('/sw.js', ORIGINE),
    registration: { navigationPreload: { async enable () { precharge = true } } },
    clients: { async claim () {} },
    skipWaiting: async () => {},
    addEventListener (type, f) { (ecouteurs[type] = ecouteurs[type] || []).push(f) }
  }
  contexte.self = contexte
  vm.runInNewContext(code, contexte, { filename: 'service-worker.js' })

  function declencher (type, extra = {}) {
    const attentes = []
    let reponduAvec = null
    const ev = {
      ...extra,
      waitUntil (p) { attentes.push(Promise.resolve(p)) },
      respondWith (p) { reponduAvec = Promise.resolve(p) }
    }
    for (const f of ecouteurs[type] || []) f(ev)
    return { attentes, reponduAvec: () => reponduAvec }
  }

  async function cycleDeVie () {
    for (const type of ['install', 'activate']) {
      const { attentes } = declencher(type)
      await Promise.all(attentes)
    }
  }

  // Une requête vue par le service worker. Rend :
  //   { interceptee: false }                         → le navigateur fait seul
  //   { interceptee: true, reponse } ou { …, erreur } → réponse du service worker
  async function requete (url, { methode = 'GET', navigation = false, mode } = {}) {
    const req = new RequeteSW(url, { method: methode, ...(mode ? { mode } : {}) })
    if (navigation) Object.defineProperty(req, 'mode', { value: 'navigate' })
    const extra = { request: req }
    if (navigation) {
      // Préchargement de navigation : la requête part pendant le réveil.
      extra.preloadResponse = precharge ? fetchFaux(req) : Promise.resolve(undefined)
      extra.preloadResponse.catch(() => {})
    }
    const { attentes, reponduAvec } = declencher('fetch', extra)
    const p = reponduAvec()
    if (!p) { await Promise.all(attentes); return { interceptee: false } }
    let resultat
    try { resultat = { interceptee: true, reponse: await p } } catch (erreur) { resultat = { interceptee: true, erreur } }
    // Les copies en cache partent en `waitUntil` : on les attend toutes.
    await Promise.all(attentes.map(a => a.catch(() => {})))
    return resultat
  }

  return {
    stockage,
    globale: contexte,
    cycleDeVie,
    requete,
    appelsReseau,
    ecouteurs: () => Object.keys(ecouteurs).sort(),
    get prechargeActif () { return precharge }
  }
}

module.exports = { ORIGINE, creerStockage, chargerServiceWorker, reponse }
