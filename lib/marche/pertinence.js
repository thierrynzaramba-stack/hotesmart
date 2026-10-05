// lib/marche/pertinence.js — LES 25 COMPARABLES D'AIRROI, EN CARTES SANS PRIX,
// TRIES PAR RESSEMBLANCE AU PROFIL DU BIEN (etape B de « Choisir vos
// comparables », spec §20.3 de docs/kb/chantier-nouveau-bien.md).
//
// ⚠ FONCTIONS PURES : ni base, ni reseau, ni horloge.
// ⚠ ON PREND A AIRROI SA DONNEE, JAMAIS SES PRIX : une carte est construite par
// LISTE BLANCHE de champs. Aucun prix, revenu ou occupation n'entre dans une
// carte ni dans le score (le critere « prix variable » est retire, decision de
// Thierry du 5 octobre 2026).

// Poids, dans l'ordre d'importance donne par Thierry.
const POIDS = { zone: 0.40, ouverture: 0.25, equipements: 0.20, capacite: 0.15 }
const DISTANCE_NULLE_KM = 10
const OUVERT_TOUTE_ANNEE = 0.9

// Les libelles Airbnb (anglais) de chaque equipement du profil (§20.3).
// Review de a52b3e4 : « Pool table » (billard) et « Pool view » ne sont pas une
// piscine ; un parking ou un garage compte s'il est SUR PLACE (« on premises »),
// un « carport » aussi ; la climatisation split s'ecrit « AC - split type… ».
const LIBELLES_AIRBNB = {
  terrasse: /\bpatio or balcony\b/i,
  spa: /\b(hot tub|sauna)\b/i,
  jardin: /\b(backyard|garden)\b(?! view)/i,
  piscine: /\bpool\b(?!\s*(table|view))/i,
  parking: /\b(parking|garage|carport)\b.*\bon premises\b/i,
  vue: /\b((mountain|sea|ocean|lake|river|beach|valley|bay|harbor|canal)\s+view|waterfront)\b/i,
  // « Air conditioning » sans casse ; « AC » en MAJUSCULES seulement, et pas la
  // borne de recharge « EV charger - AC » (re-review de 65d6cc7).
  climatisation: { test: a => /\bair conditioning\b/i.test(a) || (/\bAC\b/.test(a) && !/\bcharger\b/i.test(a)) },
}
const CLES = Object.keys(LIBELLES_AIRBNB)

function equipementsDeFiche (amenities) {
  const liste = Array.isArray(amenities) ? amenities.map(a => String(a)) : []
  return CLES.filter(k => liste.some(a => LIBELLES_AIRBNB[k].test(a)))
}

// ⚠ LA PHOTO, PAR LISTE BLANCHE (review de a52b3e4, SECURITE) : un lien venu
// d'AirROI peut porter un autre domaine ou des caracteres qui cassent un
// attribut. On n'accepte que https sur le domaine des photos d'Airbnb
// (muscache.com), et l'URL est RESERIALISEE.
function photoSure (brut) {
  if (typeof brut !== 'string' || brut.length > 2000) return null
  let u
  try { u = new URL(brut) } catch (e) { return null }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
  if (!(u.hostname === 'muscache.com' || u.hostname.endsWith('.muscache.com'))) return null
  return u.href
}

// Distance a vol d'oiseau (haversine), en kilometres.
function distanceKm (a, b) {
  const rad = d => d * Math.PI / 180
  const dLat = rad(b.latitude - a.latitude)
  const dLng = rad(b.longitude - a.longitude)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

const nombre = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const borne01 = v => Math.max(0, Math.min(1, v))

// Les composantes du score, chacune de 0 a 1 (null si non mesurable).
function composantes (fiche, profil) {
  const loc = fiche.location_info || {}
  const pd = fiche.property_details || {}
  const pm = fiche.performance_metrics || {}
  const lat = nombre(loc.latitude)
  const lng = nombre(loc.longitude)
  const km = lat !== null && lng !== null ? distanceKm(profil, { latitude: lat, longitude: lng }) : null
  const bloques = nombre(pm.ttm_blocked_days)
  const ouverture = bloques !== null ? borne01((365 - bloques) / 365) : null
  const sesEq = equipementsDeFiche(pd.amenities)
  const mesEq = Array.isArray(profil.equipements) ? profil.equipements : []
  const union = new Set([...sesEq, ...mesEq])
  const communs = sesEq.filter(e => mesEq.includes(e))
  const guests = nombre(pd.guests)
  const chambres = nombre(pd.bedrooms)
  const ecarts = []
  if (guests !== null) ecarts.push(Math.abs(guests - profil.voyageurs) / Math.max(1, profil.voyageurs))
  if (chambres !== null) ecarts.push(Math.abs(chambres - profil.chambres) / Math.max(1, profil.chambres))
  return {
    km,
    ouverture,
    equipements: sesEq,
    zone: km === null ? null : borne01(1 - km / DISTANCE_NULLE_KM),
    ouvertureScore: ouverture,
    equipementsScore: union.size ? communs.length / union.size : 1,
    capacite: ecarts.length ? borne01(1 - ecarts.reduce((s, x) => s + x, 0) / ecarts.length) : null,
  }
}

// Le score : somme ponderee des composantes. ⚠ UNE COMPOSANTE NON MESURABLE
// COMPTE 0 (review de a52b3e4) : renormaliser les poids donnait 100 % a une
// fiche vide, devant des voisins mesures a 300 m.
function score (c) {
  return [[c.zone, POIDS.zone], [c.ouvertureScore, POIDS.ouverture], [c.equipementsScore, POIDS.equipements], [c.capacite, POIDS.capacite]]
    .reduce((s, [v, p]) => s + (v === null ? 0 : v * p), 0)
}

// §21.6 : toutes les photos disponibles, jusqu'a 30.
const PHOTOS_MAX = 30
// Les equipements RARES : ceux de la recherche complementaire (§21.2).
const RARES = Object.keys(require('./choix-comparables').RARES_AIRROI)

// Un texte venu d'AirROI : une chaine, bornee en longueur (jamais un objet).
const texte = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null)
const bool = v => (typeof v === 'boolean' ? v : null)
// Une note : de plus de 0 a 5. Zero, c'est « pas de note » (review de 05223a1 :
// un bien a 2 avis portait 0 partout).
const note = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 5 ? Math.round(v * 100) / 100 : null)
const entier = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null)
const nombreBorne = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null)

// La description, texte libre de l'hote Airbnb : les retours a la ligne gardes,
// TOUTE balise retiree (la page l'affiche en texte), et tout MONTANT masque —
// « aucun prix affiche » vaut aussi pour un « supplement de 20 € » ecrit par
// l'hote (§21.6).
// Un nombre : des chiffres, un separateur . ou , SUIVI de chiffres, ou un espace
// de milliers (« 1 500 ») — jamais au-dela d'une virgule suivie d'un espace.
// Une devise AVANT (€, $, £, EUR, USD, CHF, GBP) ou APRES le nombre (memes
// devises, euros, dollars, balles, « 20,-€ ») — review de 05223a1. « 20E » :
// E MAJUSCULE seulement (« 2e etage » n'est pas un montant). Reste non masque :
// un montant ecrit en LETTRES (« vingt euros »).
const NB = String.raw`\d+(?:[.,]\d+|[\s ]\d{3}(?!\d))*`
const MONTANT = new RegExp(
  String.raw`(?:(?:[€$£]|\b(?:eur|usd|chf|gbp)(?=\s?\d))\s?${NB})` +
  String.raw`|(?:${NB}(?:,-)?\s?(?:[€$£]|(?:eur(?:o?s)?|usd|chf|gbp|dollars?|balles)\b))`, 'gi')
const MONTANT_E = new RegExp(String.raw`\b${NB}E\b`, 'g')
// Les entites HTML d'une devise, decodees AVANT le masquage.
const ENTITES = { '&euro;': '€', '&#8364;': '€', '&#x20ac;': '€', '&dollar;': '$', '&#36;': '$', '&pound;': '£', '&#163;': '£', '&nbsp;': ' ', '&#160;': ' ', '&amp;': '&' }
function descriptionPropre (v) {
  if (typeof v !== 'string') return null
  const t = v.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(?:euro|dollar|pound|nbsp|amp|#8364|#x20ac|#36|#163|#160);/gi, e => ENTITES[e.toLowerCase()] || e)
    .replace(MONTANT, '…').replace(MONTANT_E, '…').replace(/\n{3,}/g, '\n\n').trim()
  return t ? t.slice(0, 3000) : null
}

// §21.6 : TOUTE l'information du bien, SAUF l'argent. Liste blanche : jamais
// `pricing_info` (frais de menage, supplement voyageur), jamais
// `performance_metrics` (prix moyen, revenu, occupation, RevPAR).
function details (fiche) {
  const li = fiche.listing_info || {}
  const pd = fiche.property_details || {}
  const hi = fiche.host_info || {}
  const bs = fiche.booking_settings || {}
  const r = fiche.ratings || {}
  return {
    description: descriptionPropre(li.description),
    type: texte(li.listing_type, 80),
    logement_entier: li.room_type === 'entire_home' ? true : (typeof li.room_type === 'string' ? false : null),
    lits: entier(pd.beds, 50),
    salles_de_bain: nombreBorne(pd.baths, 20),
    note: note(r.rating_overall),
    avis: entier(r.num_reviews, 100000),
    notes: {
      proprete: note(r.rating_cleanliness), exactitude: note(r.rating_accuracy), arrivee: note(r.rating_checkin),
      communication: note(r.rating_communication), emplacement: note(r.rating_location), rapport_qualite: note(r.rating_value),
    },
    coup_de_coeur: bool(li.guest_favorite),
    hote: texte(hi.host_name, 60),
    superhote: bool(hi.superhost),
    gestion_pro: bool(hi.professional_management),
    reservation_instantanee: bool(bs.instant_book),
    sejour_min: entier(bs.min_nights, 365),
    annulation: texte(bs.cancellation_policy, 40),
    arrivee: texte(li.checkin_time, 20),
    depart: texte(li.checkout_time, 20),
    equipements_airbnb: (Array.isArray(pd.amenities) ? pd.amenities : []).filter(a => typeof a === 'string').map(a => a.trim().slice(0, 80)).filter(Boolean).slice(0, 150),
    nb_photos: entier(li.photos_count, 1000),
  }
}

// Une carte : LISTE BLANCHE, aucun prix. `source` : 'voisins' (liste de base)
// ou 'equipements' (recherche complementaire, §21.2).
function carte (fiche, profil, source = 'voisins') {
  const li = fiche.listing_info || {}
  const pd = fiche.property_details || {}
  const loc = fiche.location_info || {}
  const c = composantes(fiche, profil)
  // Les photos : la couverture d'abord, puis les autres, chacune par photoSure.
  const photos = [...new Set([li.cover_photo_url, ...(Array.isArray(li.photo_urls) ? li.photo_urls : [])]
    .map(photoSure).filter(Boolean))].slice(0, PHOTOS_MAX)
  const lat = nombre(loc.latitude)
  const lng = nombre(loc.longitude)
  return {
    listing_id: String(li.listing_id),
    nom: typeof li.listing_name === 'string' ? li.listing_name : '',
    photo: photoSure(li.cover_photo_url),
    voyageurs: nombre(pd.guests),
    chambres: nombre(pd.bedrooms),
    equipements: c.equipements,
    ouvert_toute_annee: c.ouverture === null ? null : c.ouverture >= OUVERT_TOUTE_ANNEE,
    distance_km: c.km === null ? null : Math.round(c.km * 10) / 10,
    position_approchee: loc.exact_location !== true,
    // La position PUBLIQUE de l'annonce (souvent approchee), pour la carte.
    latitude: lat !== null && lat >= -90 && lat <= 90 ? lat : null,
    longitude: lng !== null && lng >= -180 && lng <= 180 ? lng : null,
    photos,
    source: source === 'equipements' ? 'equipements' : 'voisins',
    details: details(fiche),
    // §21.6 : le bien a-t-il l'un des equipements RARES de l'hote ? Calcule ICI
    // (une seule liste des rares, celle de la recherche complementaire).
    a_vos_equipements: c.equipements.some(e => RARES.includes(e) && Array.isArray(profil.equipements) && profil.equipements.includes(e)),
    // §22.1 : les equipements RARES qui different — un ecart de valeur, que la
    // page signale (avertissement, jamais blocage : une fiche est parfois
    // incomplete).
    rares_manquants: RARES.filter(e => Array.isArray(profil.equipements) && profil.equipements.includes(e) && !c.equipements.includes(e)),
    rares_en_plus: RARES.filter(e => c.equipements.includes(e) && !(Array.isArray(profil.equipements) && profil.equipements.includes(e))),
    ressemblance: Math.round(score(c) * 100),
  }
}
const scoreBrut = (fiche, profil) => score(composantes(fiche, profil))

// Les deux listes reunies : la liste de base d'abord (elle gagne un doublon),
// puis les biens trouves par equipement, tries ensemble.
function reunirEtTrier (voisins, parEquipements, profil) {
  const marques = [
    ...(Array.isArray(voisins) ? voisins : []).map(f => ({ f, source: 'voisins' })),
    ...(Array.isArray(parEquipements) ? parEquipements : []).map(f => ({ f, source: 'equipements' })),
  ]
  return trierMarques(marques, profil)
}

// Les cartes triees par ressemblance decroissante ; a egalite, l'ordre d'AirROI.
function trierComparables (fiches, profil) {
  return trierMarques((Array.isArray(fiches) ? fiches : []).map(f => ({ f, source: 'voisins' })), profil)
}

function trierMarques (marques, profil) {
  if (!profil || !Number.isFinite(profil.latitude) || !Number.isFinite(profil.longitude)) throw new Error('[pertinence] profil sans position')
  // Un identifiant en double n'est garde qu'une fois (deux cartes identiques
  // fausseraient le « au moins 3 »).
  const vus = new Set()
  const valides = marques.filter(({ f }) => {
    const id = f && f.listing_info && String(f.listing_info.listing_id)
    if (!id || !/^[0-9]{1,24}$/.test(id) || vus.has(id)) return false
    vus.add(id)
    return true
  })
  // Tri sur le score BRUT (review : l'arrondi affiche creait des egalites) ; a
  // egalite exacte, l'ordre d'AirROI.
  return valides.map(({ f, source }, i) => ({ c: carte(f, profil, source), s: scoreBrut(f, profil), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.c)
}

module.exports = { trierComparables, reunirEtTrier, carte, descriptionPropre, PHOTOS_MAX, equipementsDeFiche, distanceKm, composantes, score, photoSure, POIDS, DISTANCE_NULLE_KM, OUVERT_TOUTE_ANNEE, LIBELLES_AIRBNB }
