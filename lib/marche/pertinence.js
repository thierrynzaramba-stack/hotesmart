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

const PHOTOS_MAX = 8

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

module.exports = { trierComparables, reunirEtTrier, carte, PHOTOS_MAX, equipementsDeFiche, distanceKm, composantes, score, photoSure, POIDS, DISTANCE_NULLE_KM, OUVERT_TOUTE_ANNEE, LIBELLES_AIRBNB }
