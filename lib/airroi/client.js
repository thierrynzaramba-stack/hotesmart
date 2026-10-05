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
// ⚠ ON LUI PREND SA DONNEE, JAMAIS SES PRIX (§8). UNE SEULE EXCEPTION,
// ETROITE (Thierry, 30 septembre 2026) : `calendar-prices`, pour sa
// DECOMPOSITION jour par jour (saisonnalite, jour de semaine, fetes,
// demande) — et SEULEMENT avec `base_price` = 100, pour que ses pourcentages
// soient des facteurs et jamais le prix d'un logement. `base-price` et tout
// autre `price-recommendation/*` restent refuses (non tarifes).

const { lireJson } = require('./json')
const { TARIFS, FRAICHEUR_JOURS, GARDES, tarif, jugerAppel, RefusAirroi } = require('./cout')

const BASE = 'https://api.airroi.com'
// Le prix de base impose a `calendar-prices` : 100, pour lire des FACTEURS.
const BASE_FACTEURS = 100
const JOURS_FACTEURS_MAX = 730
// ⚠ `calendar-prices` N'ACCEPTE PAS `native` (HTTP 422 du 30 septembre 2026,
// non facture) : un code ISO 4217 en MAJUSCULES, verifie ICI, avant l'envoi —
// on ne decouvre pas un format d'API en payant.
const DEVISE_ISO = /^[A-Z]{3}$/
// Une date qui EXISTE (2026-02-30 ou 2026-99-99 ne passent pas).
const jourReel = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
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
  'GET /listings': p => idAnnonce(p.listing_id),
  // Corps FIGE jusque dans `market` (review de f40ee9e : trois champs, pas un
  // de plus — un `district` ou autre ferait une autre cle de cache et un corps
  // que personne n'a valide).
  'POST /markets/metrics/occupancy': p => marcheValide(p.market) && Object.keys(p.market).length === 3 &&
    // 0 a 60 (contrat de l'API, defaut 12) : 0 est admis pour l'essai du
    // 30 septembre 2026 (Thierry) — un mois zero dirait s'il existe une
    // granularite cachee.
    Number.isInteger(p.num_months) && p.num_months >= 0 &&
    p.num_months <= 60 && p.currency === 'native' && Object.keys(p).length === 3,
  // Corps FIGE, a tous les niveaux (review de f13526c : `location` acceptait
  // des champs en plus). Le calendrier part du 1er d'un mois (la cle de cache
  // ne change qu'une fois par mois : sinon chaque jour payait un nouvel appel)
  // et dure au plus 730 jours.
  'POST /price-recommendation/calendar-prices': p => !!(p.location && typeof p.location === 'object' &&
    Object.keys(p.location).length === 2 && finiDans(p.location.latitude, -90, 90) &&
    finiDans(p.location.longitude, -180, 180)) && p.base_price === BASE_FACTEURS && DEVISE_ISO.test(String(p.currency)) && typeof p.currency === 'string' &&
    jourReel(p.start_date) && jourReel(p.end_date) && p.start_date.slice(8) === '01' &&
    p.start_date <= p.end_date && (Date.parse(p.end_date) - Date.parse(p.start_date)) / 86400000 <= JOURS_FACTEURS_MAX - 1 &&
    Object.keys(p).length === 5
}
// §21.2 : les identifiants d'equipements AirROI qu'une recherche peut filtrer
// (vocabulaire de la documentation, 5 octobre 2026). Liste FERMEE : un autre
// identifiant ferait un corps que personne n'a valide.
const EQUIPEMENTS_FILTRABLES = new Set(['hot_tub', 'sauna', 'pool', 'backyard', 'ocean_view', 'river_view', 'waterfront', 'lake_access'])
VALIDER['POST /listings/search/radius'] = p => {
  if (!p || Object.keys(p).sort().join(',') !== 'filter,latitude,longitude,pagination,radius_miles') return false
  if (!finiDans(p.latitude, -90, 90) || !finiDans(p.longitude, -180, 180)) return false
  if (!(typeof p.radius_miles === 'number' && p.radius_miles >= 1 && p.radius_miles <= 10)) return false
  const f = p.filter
  if (!f || typeof f !== 'object' || Object.keys(f).sort().join(',') !== 'amenities,guests') return false
  const a = f.amenities
  if (!a || Object.keys(a).join(',') !== 'any' || !Array.isArray(a.any) || !a.any.length || a.any.length > EQUIPEMENTS_FILTRABLES.size ||
      new Set(a.any).size !== a.any.length || !a.any.every(x => EQUIPEMENTS_FILTRABLES.has(x))) return false
  const g = f.guests
  if (!g || Object.keys(g).join(',') !== 'range' || !Array.isArray(g.range) || g.range.length !== 2 ||
      !g.range.every(x => Number.isInteger(x) && x >= 1 && x <= 32) || g.range[0] > g.range[1]) return false
  const pg = p.pagination
  return !!(pg && Object.keys(pg).sort().join(',') === 'offset,page_size' && pg.page_size === 10 && pg.offset === 0)
}

// §22.3 : le calendrier en ligne d'une annonce — corps FIGE (l'identifiant et la
// devise native, rien d'autre).
VALIDER['GET /listings/live/calendar'] = p => !!(p && Object.keys(p).sort().join(',') === 'currency,listing_id' && idAnnonce(p.listing_id) && p.currency === 'native')

// La FORME attendue d'une reponse rangeable : une reponse 200 vide ou d'erreur
// n'entre pas au cache pour un an (review).
const FORME = {
  'GET /markets/lookup': d => !!(d && typeof d === 'object' && Object.keys(d).length && !d.error),
  'POST /markets/metrics/all': d => !!(d && Array.isArray(d.results)),
  'POST /markets/metrics/future/pacing': d => !!(d && typeof d === 'object' && Object.keys(d).length && !d.error),
  'GET /listings/comparables': d => !!(d && Array.isArray(d.listings)),
  'GET /listings/metrics/all': d => !!(d && Array.isArray(d.results)),
  'GET /listings': d => !!(d && d.listing_info),
  'POST /listings/search/radius': d => !!(d && Array.isArray(d.results) && !d.error),
  // Au moins une nuit DATEE : un 200 vide ou d'erreur n'entre pas au cache.
  // Au moins une nuit DATEE avec un PRIX numerique (review de f37b7da, C6 : un
  // champ autrement nomme serait range 90 jours sans prix exploitable).
  'GET /listings/live/calendar': d => !!(d && !d.error && Array.isArray(d.results) && d.results.some(x => x && /^\d{4}-\d{2}-\d{2}$/.test(String(x.date)) && typeof x.rate === 'number' && x.rate > 0)),
  // La forme n'est pas supposee (la doc dit « quotidien, mensuel et agrege »,
  // son exemple est mensuel) : au moins un point DATE (AAAA-MM), dans un
  // tableau au premier niveau ou un niveau plus bas ; ni `error` ni `errors`
  // (review de f40ee9e : un 200 « quota » entrait au cache pour un an).
  'POST /markets/metrics/occupancy': d => !!(d && typeof d === 'object' && !Array.isArray(d) && !d.error && !d.errors &&
    [...Object.values(d), ...Object.values(d).filter(v => v && typeof v === 'object' && !Array.isArray(v)).flatMap(Object.values)]
      .some(v => Array.isArray(v) && v.some(x => x && typeof x === 'object' && /^\d{4}-\d{2}/.test(String(x.date || x.month || ''))))),
  // Au moins un jour date (review : un 200 « quota » ou une liste vide entrait
  // au cache pour 30 jours). Le nom du tableau n'est pas suppose.
  'POST /price-recommendation/calendar-prices': d => !!(d && typeof d === 'object' && !d.error &&
    Object.values(d).some(v => Array.isArray(v) && v.some(x => x && typeof x === 'object' && /^\d{4}-\d{2}-\d{2}/.test(String(x.date || '')))))
}

/** Masquer la cle dans un texte venu de l'exterieur (erreur reseau, corps HTTP). */
function masquer (texte, cle) {
  let t = String(texte ?? '')
  // Aussi ses formes encodees (URL, JSON) : une reponse d'erreur qui la
  // recopierait encodee ne la laisse pas passer (re-review du 24 septembre).
  if (cle) for (const v of new Set([cle, encodeURIComponent(cle), JSON.stringify(cle).slice(1, -1)])) t = t.split(v).join('[clé masquée]')
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

  // Le journal des trois fenetres des garde-fous : mois civil (tous comptes),
  // 30 jours du compte, 90 jours du bien. Une seule lecture pour `jugerAppel`
  // et pour `marge` : deux lectures differentes finiraient par diverger.
  async function journal (now, { userId = null, propertyId = null } = {}) {
    const iso = d => d.toISOString()
    const debutMois = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    return {
      duMois: await depot.appelsDepuis({ depuis: iso(debutMois) }),
      duCompte30: userId ? await depot.appelsDepuis({ depuis: iso(new Date(now - 30 * 86400000)), userId }) : [],
      duBien90: propertyId ? await depot.appelsDepuis({ depuis: iso(new Date(now - 90 * 86400000)), propertyId }) : []
    }
  }

  // ⚠ Toute erreur levee APRES le depart de la requete est « peut-etre
  // facturee » (re-review de 0fab219) : une panne du cache ou du journal apres
  // un 200 ne doit pas rendre une reservation qu'AirROI a deja facturee. Seuls
  // les refus avant le reseau et les reponses HTTP d'erreur liberent le cout.
  async function appelerUneFois (endpoint, params, cle, ctx) {
    let parti = false
    try {
      return await appelerUneFoisSansMarque(endpoint, params, cle, ctx, () => { parti = true })
    } catch (e) {
      if (e && typeof e === 'object' && e.coutLibere === undefined) e.coutLibere = !parti
      throw e
    }
  }
  async function appelerUneFoisSansMarque (endpoint, params, cle, { userId = null, propertyId = null, horsCompte = false }, depart) {
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
    let verdict
    try {
      verdict = jugerAppel({ endpoint, userId, propertyId, gardes, ...(await journal(now, { userId, propertyId })) })
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
    depart()
    try { r = await f(url, init) } catch (e) {
      await depot.terminer(reservation, { statut: 'erreur', http: null })
      throw Object.assign(new Error(`[airroi] ${endpoint} : reseau (${masquer(e && e.message, cleApi).slice(0, 200)})`), { peutEtreFacture: true })
    }
    const texte = await r.text().catch(() => '')
    if (!r.ok) {
      // ⚠ UNE REQUETE REFUSEE PAR LE SERVEUR N'EST PAS FACTUREE (AirROI facture
      // les requetes REUSSIES) : la reservation est LIBEREE, sinon le budget se
      // vide sur des appels qui n'ont jamais eu lieu (HTTP 422 du 30 septembre
      // 2026). Une coupure reseau, elle, reste comptee : on ne sait pas si
      // l'appel a ete facture.
      await depot.terminer(reservation, { statut: 'erreur', http: r.status, cout: 0 })
      depense.usd -= cout
      depense.appels.pop()
      throw Object.assign(new Error(`[airroi] ${endpoint} : HTTP ${r.status} ${masquer(texte, cleApi).slice(0, 200)}`), { coutLibere: true })
    }
    let donnees
    try { donnees = lireJson(texte) } catch (e) {
      await depot.terminer(reservation, { statut: 'erreur', http: r.status })
      throw Object.assign(new Error(`[airroi] ${endpoint} : reponse illisible (HTTP ${r.status}), rien n'est range`), { peutEtreFacture: true })
    }
    if (!FORME[endpoint](donnees)) {
      await depot.terminer(reservation, { statut: 'erreur', http: r.status })
      throw Object.assign(new Error(`[airroi] ${endpoint} : reponse inattendue (${masquer(texte, cleApi).slice(0, 120)}), rien n'est range`), { peutEtreFacture: true })
    }
    const le = maintenant().toISOString()
    await depot.ecrireCache({ cle, endpoint, parametres: params, reponse: texte, cout, recupereLe: le })
    await depot.terminer(reservation, { statut: 'ok', http: r.status })
    if (verdict.alerte) await sonner('airroi_budget', `Budget AirROI du mois à 80 % ou plus après ${endpoint}.`)
    return { donnees, depuisCache: false, recupereLe: le, cout }
  }

  // ⚠ CHAQUE ERREUR DIT SI LE COUT EST LIBERE (review de f37b7da, SECURITE) :
  // `coutLibere = true` quand rien n'a ete facture (refus avant le reseau,
  // reponse d'erreur du serveur) ; `false` des que la requete a pu partir.
  // Une erreur NON marquee vaut `false` (re-review de 0fab219) : dans le doute,
  // on garde la reservation. Un appelant qui tient son propre quota ne RAND sa
  // reservation que si `coutLibere === true`.
  async function appeler (endpoint, params = {}, ctx = {}) {
    try { return await appelerSansMarque(endpoint, params, ctx) } catch (e) {
      if (e && typeof e === 'object' && e.coutLibere === undefined) e.coutLibere = false
      throw e
    }
  }
  async function appelerSansMarque (endpoint, params = {}, ctx = {}) {
    if (!Object.hasOwn(TARIFS, endpoint)) throw Object.assign(new Error(`[airroi] endpoint refuse : ${endpoint}`), { coutLibere: true })
    if (!VALIDER[endpoint](params || {})) {
      throw Object.assign(new Error(`[airroi] ${endpoint} : parametres invalides ou manquants — aucun appel parti`), { coutLibere: true })
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

  // ⚠ CE QUI RESTE A DEPENSER pour ce compte et ce bien, le plus petit des
  // trois garde-fous (review du 24 septembre) : une etude se juge contre CETTE
  // marge, pas contre le plafond brut — sinon un compte qui a deja depense
  // passe l'estimation, puis `plafond_compte` tombe au milieu, apres paiement.
  async function marge (ctx = {}) {
    const g = { ...GARDES, ...gardes }
    const j = await journal(maintenant(), ctx)
    const somme = l => (l || []).reduce((t, x) => t + Number(x.cout_usd || 0), 0)
    const restes = [g.budgetMensuelUsd - somme(j.duMois)]
    if (ctx.userId) restes.push(g.plafondCompte30jUsd - somme(j.duCompte30))
    if (ctx.propertyId) restes.push(g.plafondBien90jUsd - somme(j.duBien90))
    return Math.round(Math.min(...restes) * 1000) / 1000
  }

  return {
    appeler,
    estimer,
    marge,
    depense,
    // Les appels du cadrage, parametres documentes (spec publique AirROI).
    trouverMarche: (lat, lng, ctx) => appeler('GET /markets/lookup', { lat, lng }, ctx),
    metriquesMarche: (market, numMonths = 60, ctx) =>
      appeler('POST /markets/metrics/all', { market, num_months: numMonths, currency: 'native' }, ctx),
    // Les FACTEURS jour par jour du modele d'AirROI (base 100), jamais un prix.
    reliefCalendrier: ({ latitude, longitude, debut, fin, devise = 'EUR' }, ctx) =>
      appeler('POST /price-recommendation/calendar-prices', { location: { latitude, longitude },
        currency: devise, base_price: BASE_FACTEURS, start_date: debut, end_date: fin }, ctx),
    occupationMarche: (market, numMonths, ctx) =>
      appeler('POST /markets/metrics/occupancy', { market, num_months: numMonths, currency: 'native' }, ctx),
    pacingMarche: (market, ctx) =>
      appeler('POST /markets/metrics/future/pacing', { market, currency: 'native' }, ctx),
    comparables: ({ latitude, longitude, bedrooms, baths, guests }, ctx) =>
      appeler('GET /listings/comparables', { latitude, longitude, bedrooms, baths, guests, currency: 'native' }, ctx),
    metriquesAnnonce: (listingId, ctx) =>
      appeler('GET /listings/metrics/all', { listing_id: String(listingId), num_months: 60, currency: 'native' }, ctx),
    annonce: (listingId, ctx) =>
      appeler('GET /listings', { listing_id: String(listingId), currency: 'native' }, ctx),
    // §21.2 : jusqu'a 10 biens proches qui ont AU MOINS UN des equipements. Le
    // corps est construit par lib/marche/choix-comparables.js (corpsRechercheEquipements),
    // une seule fois : la cle de cache ne peut pas diverger ; il est VALIDE ici.
    rechercheEquipements: (corps, ctx) => appeler('POST /listings/search/radius', corps, ctx),
    // §22.3 : les prix affiches d'une annonce, nuit par nuit, sur 12 mois.
    calendrierAnnonce: (listingId, ctx) => appeler('GET /listings/live/calendar', { listing_id: String(listingId), currency: 'native' }, ctx)
  }
}

module.exports = { creerClient, cleCanonique, masquer, BASE, DELAI_MS, EQUIPEMENTS_FILTRABLES }
