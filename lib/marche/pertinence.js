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
const LIBELLES_AIRBNB = {
  terrasse: /\bpatio or balcony\b/i,
  spa: /\b(hot tub|sauna)\b/i,
  jardin: /\b(backyard|garden)\b(?! view)/i,
  piscine: /\bpool\b/i,
  parking: /(parking on premises|\bgarage\b)/i,
  vue: /\b(mountain|sea|ocean|lake|river|beach|valley)\s+view\b/i,
  climatisation: /\bair conditioning\b/i,
}
const CLES = Object.keys(LIBELLES_AIRBNB)

function equipementsDeFiche (amenities) {
  const liste = Array.isArray(amenities) ? amenities.map(a => String(a)) : []
  return CLES.filter(k => liste.some(a => LIBELLES_AIRBNB[k].test(a)))
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

// Le score : moyenne ponderee des composantes MESUREES (une composante non
// mesurable ne compte ni pour ni contre).
function score (c) {
  const parts = [[c.zone, POIDS.zone], [c.ouvertureScore, POIDS.ouverture], [c.equipementsScore, POIDS.equipements], [c.capacite, POIDS.capacite]]
    .filter(([v]) => v !== null)
  const poids = parts.reduce((s, [, p]) => s + p, 0)
  return poids ? parts.reduce((s, [v, p]) => s + v * p, 0) / poids : 0
}

// Une carte : LISTE BLANCHE, aucun prix.
function carte (fiche, profil) {
  const li = fiche.listing_info || {}
  const pd = fiche.property_details || {}
  const loc = fiche.location_info || {}
  const c = composantes(fiche, profil)
  const photo = typeof li.cover_photo_url === 'string' && /^https:\/\//.test(li.cover_photo_url) ? li.cover_photo_url : null
  return {
    listing_id: String(li.listing_id),
    nom: typeof li.listing_name === 'string' ? li.listing_name : '',
    photo,
    voyageurs: nombre(pd.guests),
    chambres: nombre(pd.bedrooms),
    equipements: c.equipements,
    ouvert_toute_annee: c.ouverture === null ? null : c.ouverture >= OUVERT_TOUTE_ANNEE,
    distance_km: c.km === null ? null : Math.round(c.km * 10) / 10,
    position_approchee: loc.exact_location !== true,
    ressemblance: Math.round(score(c) * 100),
  }
}

// Les cartes triees par ressemblance decroissante ; a egalite, l'ordre d'AirROI.
function trierComparables (fiches, profil) {
  if (!profil || !Number.isFinite(profil.latitude) || !Number.isFinite(profil.longitude)) throw new Error('[pertinence] profil sans position')
  const valides = (Array.isArray(fiches) ? fiches : []).filter(f => f && f.listing_info && /^[0-9]{1,24}$/.test(String(f.listing_info.listing_id)))
  return valides.map((f, i) => ({ c: carte(f, profil), i }))
    .sort((a, b) => b.c.ressemblance - a.c.ressemblance || a.i - b.i)
    .map(x => x.c)
}

module.exports = { trierComparables, carte, equipementsDeFiche, distanceKm, composantes, score, POIDS, DISTANCE_NULLE_KM, OUVERT_TOUTE_ANNEE, LIBELLES_AIRBNB }
