// lib/airroi/client.js — LE SEUL POINT DE CONTACT AVEC AIRROI. Serveur seulement.
// Cadrage : docs/kb/chantier-nouveau-bien.md (§5 regles 9-10, §6 arbitrage 6, §7).
//
// ⚠ LA CLE EST UN SECRET SERVEUR (regle 9). Elle est lue dans
// `process.env.AIRROI_API_KEY` AU MOMENT D'UN APPEL RESEAU, jamais avant :
//   - aucune valeur par defaut, aucune cle en dur, aucune cle dans un test ;
//   - elle n'entre ni dans la cle de cache, ni dans le journal, ni dans un log ;
//   - ⚠ ET JAMAIS DANS UN MESSAGE D'ERREUR, MEME RECOPIE PAR UN TIERS — releve
//     en review (24 septembre 2026, SECURITE) : une cle collee avec un retour
//     a la ligne est refusee par le `fetch` de Node, dont le message RECOPIE la
//     valeur de l'en-tete. Deux defenses : la cle est validee avant l'appel
//     (caracteres imprimables seulement, message sans la valeur), et tout texte
//     venu de l'exterieur (erreur reseau, corps d'erreur HTTP) est MASQUE avant
//     de sortir d'ici ;
//   - absente, l'appel ECHOUE BRUYAMMENT — un cache frais, lui, se sert sans
//     cle (il ne coute rien et ne revele rien).
//
// ⚠ AUCUN APPEL PAYANT SANS CACHE, ET AUCUN APPEL PAYE HORS DU JOURNAL (regle 10,
// review) — dans cet ordre :
//   1. parametres valides, sinon refus (un appel avec « undefined » serait paye
//      pour rien, et sa reponse vide mise en cache un an) ;
//   2. cache frais -> servi, rien ne part, rien n'est paye ;
//   3. garde-fous de cout (lib/airroi/cout.js) -> refus AVANT le reseau ;
//   4. la depense est RESERVEE au journal (statut « parti ») AVANT le reseau :
//      un appel paye puis interrompu (fonction tuee, reponse illisible, cache en
//      panne) reste compte par les garde-fous ;
//   5. appel, avec delai maximal ; la reponse n'est rangee que si c'est du JSON
//      de la forme attendue ; le journal passe a « ok » ou « erreur ».
//
// ⚠ DEUX APPELS IDENTIQUES SIMULTANES DANS UN MEME PROCESSUS partagent la meme
// promesse (review : dix appels paralleles payaient dix fois). Entre deux
// invocations Vercel distinctes, la course reste possible : la reservation au
// journal la rend au moins COMPTEE (dette ecrite au KB §12).
//
// ⚠ ON LUI PREND SA DONNEE, JAMAIS SES PRIX : `price-recommendation/*` n'est
// pas tarife ici, donc refuse (§8).

const { lireJson } = require('./json')
const { TARIFS, FRAICHEUR_JOURS, tarif, jugerAppel, RefusAirroi } = require('./cout')

const BASE = 'https://api.airroi.com'
const DELAI_MS = 30000

// La cle de cache : methode, chemin, parametres metier TRIES. Deux appels
// identiques a l'ordre pres partagent la meme ligne.
function cleCanonique (endpoint, params) {
  const trie = v => Array.isArray(v) ? v.map(trie)
    : (v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, trie(v[k])])) : v)
  return `${endpoint} ${JSON.stringify(trie(params || {}))}`
}

// ─── Validation des parametres, par endpoint (review, C5) ───────────────────
const finiDans = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const idAnnonce = v => /^[0-9]{1,24}$/.test(String(v ?? ''))
const marcheValide = m => !!(m && typeof m === 'object' && ['country', 'region', 'locality']
  .every(k => typeof m[k] === 'string' && m[k].trim()))
const VALIDER = {
  'GET /markets/lookup': p => finiDans(p.lat, -90, 90) && finiDans(p.lng, -180, 180),
  'POST /markets/metrics/all': p => marcheValide(p.market) && Number.isInteger(p.num_months) && p.num_months >= 1 && p.num_months <= 60,
  'POST /markets/metrics/future/pacing': p => marcheValide(p.market),
  'GET /listings/comparables': p => finiDans(p.latitude, -90, 90) && finiDans(p.longitude, -180, 180) &&
    [p.bedrooms, p.baths, p.guests].every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0),
  'GET /listings/metrics/all': p => idAnnonce(p.listing_id),
  'GET /listings': p => idAnnonce(p.listing_id)
}
// La FORME attendue d'une reponse rangeable : une reponse 200 vide ou d'erreur
// n'entre pas au cache pour un an (review).
const FORME = {
  'GET /markets/lookup': d => !!(d && typeof d === 'object' && Object.keys(d).length && !d.error),
  'POST /markets/metrics/all': d => !!(d && Array.isArray(d.results)),
  'POST /markets/metrics/future/pacing': d => !!(d && typeof d === 'object' && Object.keys(d).length && !d.error),
  'GET /listings/comparables': d => !!(d && Array.isArray(d.listings)),
  'GET /listings/metrics/all': d => !!(d && Array.isArray(d.results)),
  'GET /listings': d => !!(d && d.listing_info)
}

/** Masquer la cle dans un texte venu de l'exterieur (erreur reseau, corps HTTP). */
function masquer (texte, cle) {
  let t = String(texte ?? '')
  if (cle) t = t.split(cle).join('[clé masquée]')
  return t
}

/**
 * @param {Object} o
 *   - depot      lib/airroi/depot.js (supabase ou fichier)
 *   - fetch      injectable (tests) ; par defaut le fetch global
 *   - maintenant () => Date, injectable
 *   - alerter    async (type, detail) => void — ALARME FONDATEUR. Par defaut :
 *                `reportIncident` (lib/founder-notify.js, anti-spam horaire
 *                inclus). `null` pour la couper (tests seulement).
 *   - gardes     surcharge des garde-fous (valeurs finies > 0, sinon refus)
 */
function creerClient ({ depot, fetch: f = globalThis.fetch, maintenant = () => new Date(), alerter, gardes = {} } = {}) {
  if (!depot) throw new Error('[airroi] client : depot requis (aucun appel payant sans cache)')
  const alarme = alerter === undefined
    ? async (type, detail) => { const { reportIncident } = require('../founder-notify'); await reportIncident(type, { detail, threshold: 1 }) }
    : alerter
  const sonner = async (type, detail) => { if (alarme) { try { await alarme(type, detail) } catch (e) { /* l'alarme ne bloque jamais */ } } }
  const depense = { usd: 0, appels: [] }
  const enCours = new Map()

  async function appelerUneFois (endpoint, params, cle, { userId = null, propertyId = null, horsCompte = false }) {
    const now = maintenant()
    const cache = await depot.lireCache(cle)
    if (cache) {
      const ageJours = (now - new Date(cache.recupere_le)) / 86400000
      if (ageJours <= FRAICHEUR_JOURS[endpoint]) {
        return { donnees: lireJson(cache.reponse), depuisCache: true, recupereLe: cache.recupere_le, cout: 0 }
      }
    }
    // Les garde-fous, avant tout reseau. Un appel sans compte ni bien doit le
    // dire (`horsCompte`, scripts de verification) : sinon les plafonds par
    // compte et par bien seraient sautes en silence (review, C4).
    if (!userId && !propertyId && !horsCompte) {
      throw new Error('[airroi] appel sans compte ni bien : passer { userId, propertyId }, ou { horsCompte: true } pour un script')
    }
    const iso = d => d.toISOString()
    const debutMois = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    let verdict
    try {
      verdict = jugerAppel({
        endpoint, userId, propertyId, gardes,
        duMois: await depot.appelsDepuis({ depuis: iso(debutMois) }),
        duCompte30: userId ? await depot.appelsDepuis({ depuis: iso(new Date(now - 30 * 86400000)), userId }) : [],
        duBien90: propertyId ? await depot.appelsDepuis({ depuis: iso(new Date(now - 90 * 86400000)), propertyId }) : []
      })
    } catch (e) {
      if (e instanceof RefusAirroi && e.motif === 'budget_mensuel') await sonner('airroi_budget', e.message)
      throw e
    }
    // La cle, maintenant et seulement maintenant — et validee SANS la montrer.
    const cleApi = process.env.AIRROI_API_KEY
    if (!cleApi) {
      throw new Error('[airroi] AIRROI_API_KEY absente de l environnement : aucun appel possible. '
        + 'Elle se pose dans les variables Vercel, jamais dans le code.')
    }
    if (!/^[\x21-\x7e]+$/.test(cleApi)) {
      throw new Error('[airroi] AIRROI_API_KEY mal formee (espace, retour a la ligne ou caractere non imprimable) : aucun appel parti.')
    }
    const [methode, chemin] = endpoint.split(' ')
    let url = `${BASE}${chemin}`
    const init = { method: methode, headers: { 'x-api-key': cleApi, Accept: 'application/json' } }
    if (methode === 'GET') url += `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`
    else { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(params) }
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(DELAI_MS)
    const cout = tarif(endpoint)

    // La depense RESERVEE avant le reseau (review, C1).
    const reservation = await depot.reserver({ endpoint, cle, cout, userId, propertyId, le: now.toISOString() })
    depense.usd += cout
    depense.appels.push({ endpoint, cout })
    let r
    try { r = await f(url, init) } catch (e) {
      await depot.terminer(reservation, { statut: 'erreur', http: null })
      throw new Error(`[airroi] ${endpoint} : reseau (${masquer(e && e.message, cleApi).slice(0, 200)})`)
    }
    const texte = await r.text().catch(() => '')
    if (!r.ok) {
      await depot.terminer(reservation, { statut: 'erreur', http: r.status })
      throw new Error(`[airroi] ${endpoint} : HTTP ${r.status} ${masquer(texte, cleApi).slice(0, 200)}`)
    }
    let donnees
    try { donnees = lireJson(texte) } catch (e) {
      await depot.terminer(reservation, { statut: 'erreur', http: r.status })
      throw new Error(`[airroi] ${endpoint} : reponse illisible (HTTP ${r.status}), rien n'est range`)
    }
    if (!FORME[endpoint](donnees)) {
      await depot.terminer(reservation, { statut: 'erreur', http: r.status })
      throw new Error(`[airroi] ${endpoint} : reponse inattendue (${masquer(texte, cleApi).slice(0, 120)}), rien n'est range`)
    }
    const le = maintenant().toISOString()
    await depot.ecrireCache({ cle, endpoint, parametres: params, reponse: texte, cout, recupereLe: le })
    await depot.terminer(reservation, { statut: 'ok', http: r.status })
    if (verdict.alerte) await sonner('airroi_budget', `Budget AirROI du mois à 80 % ou plus après ${endpoint}.`)
    return { donnees, depuisCache: false, recupereLe: le, cout }
  }

  async function appeler (endpoint, params = {}, ctx = {}) {
    if (!Object.hasOwn(TARIFS, endpoint)) throw new Error(`[airroi] endpoint refuse : ${endpoint}`)
    if (!VALIDER[endpoint](params || {})) {
      throw new Error(`[airroi] ${endpoint} : parametres invalides ou manquants — aucun appel parti`)
    }
    const cle = cleCanonique(endpoint, params)
    if (enCours.has(cle)) return enCours.get(cle)
    const p = appelerUneFois(endpoint, params, cle, ctx || {}).finally(() => enCours.delete(cle))
    enCours.set(cle, p)
    return p
  }

  // Ce que couterait une liste d'appels : la somme des tarifs de ceux que le
  // cache ne sert pas (review : juger une ETUDE avant son premier appel,
  // plutot que la couper au milieu apres avoir paye).
  async function estimer (appels) {
    const now = maintenant()
    let usd = 0
    for (const { endpoint, params } of appels) {
      const c = await depot.lireCache(cleCanonique(endpoint, params))
      const frais = c && (now - new Date(c.recupere_le)) / 86400000 <= FRAICHEUR_JOURS[endpoint]
      if (!frais) usd += tarif(endpoint)
    }
    return Math.round(usd * 1000) / 1000
  }

  return {
    appeler,
    estimer,
    depense,
    // Les appels du cadrage, parametres documentes (spec publique AirROI).
    trouverMarche: (lat, lng, ctx) => appeler('GET /markets/lookup', { lat, lng }, ctx),
    metriquesMarche: (market, numMonths = 60, ctx) =>
      appeler('POST /markets/metrics/all', { market, num_months: numMonths, currency: 'native' }, ctx),
    pacingMarche: (market, ctx) =>
      appeler('POST /markets/metrics/future/pacing', { market, currency: 'native' }, ctx),
    comparables: ({ latitude, longitude, bedrooms, baths, guests }, ctx) =>
      appeler('GET /listings/comparables', { latitude, longitude, bedrooms, baths, guests, currency: 'native' }, ctx),
    metriquesAnnonce: (listingId, ctx) =>
      appeler('GET /listings/metrics/all', { listing_id: String(listingId), num_months: 60, currency: 'native' }, ctx),
    annonce: (listingId, ctx) =>
      appeler('GET /listings', { listing_id: String(listingId), currency: 'native' }, ctx)
  }
}

module.exports = { creerClient, cleCanonique, masquer, BASE, DELAI_MS }
