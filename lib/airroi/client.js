// lib/airroi/client.js — LE SEUL POINT DE CONTACT AVEC AIRROI. Serveur seulement.
// Cadrage : docs/kb/chantier-nouveau-bien.md (§5 regles 9-10, §6 arbitrage 6, §7).
//
// ⚠ LA CLE EST UN SECRET SERVEUR (regle 9). Elle est lue dans
// `process.env.AIRROI_API_KEY` AU MOMENT D'UN APPEL RESEAU, jamais avant :
//   - aucune valeur par defaut, aucune cle en dur, aucune cle dans un test ;
//   - elle n'entre ni dans la cle de cache, ni dans le journal, ni dans un
//     message d'erreur, ni dans un log ;
//   - absente, l'appel ECHOUE BRUYAMMENT — un cache frais, lui, se sert sans
//     cle (il ne coute rien et ne revele rien).
//
// ⚠ AUCUN APPEL PAYANT SANS CACHE (regle 10), dans cet ordre :
//   1. cache frais -> servi, rien ne part, rien n'est paye ;
//   2. garde-fous de cout (lib/airroi/cout.js) -> refus AVANT le reseau ;
//   3. appel ; la reponse est rangee AVANT d'etre rendue (relancer ne repaie
//      pas) ; la depense est journalisee, meme en erreur HTTP (on ne sait pas
//      si AirROI facture un 4xx : on compte comme si).
//
// ⚠ ON LUI PREND SA DONNEE, JAMAIS SES PRIX : `price-recommendation/*` n'est
// pas tarife ici, donc refuse (§8).

const { lireJson } = require('./json')
const { TARIFS, FRAICHEUR_JOURS, tarif, jugerAppel } = require('./cout')

const BASE = 'https://api.airroi.com'

// La cle de cache : methode, chemin, parametres metier TRIES. Deux appels
// identiques a l'ordre pres partagent la meme ligne.
function cleCanonique (endpoint, params) {
  const trie = v => Array.isArray(v) ? v.map(trie)
    : (v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, trie(v[k])])) : v)
  return `${endpoint} ${JSON.stringify(trie(params || {}))}`
}

/**
 * @param {Object} o
 *   - depot      lib/airroi/depot.js (supabase ou fichier)
 *   - fetch      injectable (tests) ; par defaut le fetch global
 *   - maintenant () => Date, injectable
 *   - alerter    async (type, detail) => void — alarme fondateur (80 % du budget)
 *   - gardes     surcharge des garde-fous (tests)
 */
function creerClient ({ depot, fetch: f = globalThis.fetch, maintenant = () => new Date(), alerter = null, gardes = {} } = {}) {
  if (!depot) throw new Error('[airroi] client : depot requis (aucun appel payant sans cache)')
  const depense = { usd: 0, appels: [] }

  async function appeler (endpoint, params = {}, { userId = null, propertyId = null } = {}) {
    if (!(endpoint in TARIFS)) throw new Error(`[airroi] endpoint refuse : ${endpoint}`)
    const cle = cleCanonique(endpoint, params)
    const now = maintenant()
    const cache = await depot.lireCache(cle)
    if (cache) {
      const ageJours = (now - new Date(cache.recupere_le)) / 86400000
      if (ageJours <= FRAICHEUR_JOURS[endpoint]) {
        return { donnees: lireJson(cache.reponse), depuisCache: true, recupereLe: cache.recupere_le, cout: 0 }
      }
    }
    // Les garde-fous, avant tout reseau.
    const iso = d => d.toISOString()
    const debutMois = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const verdict = jugerAppel({
      endpoint, userId, propertyId, gardes,
      duMois: await depot.appelsDepuis({ depuis: iso(debutMois) }),
      duCompte30: userId ? await depot.appelsDepuis({ depuis: iso(new Date(now - 30 * 86400000)), userId }) : [],
      duBien90: propertyId ? await depot.appelsDepuis({ depuis: iso(new Date(now - 90 * 86400000)), propertyId }) : []
    })
    // La cle, maintenant et seulement maintenant.
    const cleApi = process.env.AIRROI_API_KEY
    if (!cleApi) {
      throw new Error('[airroi] AIRROI_API_KEY absente de l environnement : aucun appel possible. '
        + 'Elle se pose dans les variables Vercel, jamais dans le code.')
    }
    const [methode, chemin] = endpoint.split(' ')
    let url = `${BASE}${chemin}`
    const init = { method: methode, headers: { 'x-api-key': cleApi, Accept: 'application/json' } }
    if (methode === 'GET') {
      const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
      url += `?${q}`
    } else {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(params)
    }
    const cout = tarif(endpoint)
    let r
    try { r = await f(url, init) } catch (e) {
      // Reseau : rien n'est parti de facon sure — on journalise quand meme a
      // cout plein, par prudence budgetaire.
      await depot.journaliser({ endpoint, cle, cout, userId, propertyId, statut: 'erreur', http: null, le: now.toISOString() })
      throw new Error(`[airroi] ${endpoint} : reseau (${e.message})`)
    }
    const texte = await r.text()
    const le = maintenant().toISOString()
    depense.usd += cout
    depense.appels.push({ endpoint, cout, http: r.status })
    if (!r.ok) {
      await depot.journaliser({ endpoint, cle, cout, userId, propertyId, statut: 'erreur', http: r.status, le })
      // Le corps d'erreur d'AirROI ne contient pas la cle ; on le tronque.
      throw new Error(`[airroi] ${endpoint} : HTTP ${r.status} ${texte.slice(0, 200)}`)
    }
    const donnees = lireJson(texte)   // leve si la reponse n'est pas du JSON : rien n'est range
    await depot.ecrireCache({ cle, endpoint, parametres: params, reponse: texte, cout, recupereLe: le })
    await depot.journaliser({ endpoint, cle, cout, userId, propertyId, statut: 'ok', http: r.status, le })
    if (verdict.alerte && alerter) {
      try { await alerter('airroi_budget', `Budget AirROI du mois à 80 % ou plus après ${endpoint}.`) } catch (e) {}
    }
    return { donnees, depuisCache: false, recupereLe: le, cout }
  }

  return {
    appeler,
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

module.exports = { creerClient, cleCanonique, BASE }
