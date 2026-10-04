// lib/marche/profil-bien.js — LE PROFIL DU BIEN DECRIT PAR L'HOTE (etape A de
// « Choisir vos comparables », spec §20.2 de docs/kb/chantier-nouveau-bien.md).
//
// ⚠ WRITER UNIQUE de `bien_profil` (table V2 neuve) : rien n'est ecrit dans
// `properties` (decision du 25 septembre 2026).
// ⚠ AUCUN PRIX : adresse, position, taille, equipements.
// ⚠ CHAMBRES = VRAIES chambres : une piece separee avec une porte. Un canape-lit
// dans le salon n'est pas une chambre (« 1 chambre + 1 salon avec couchage »
// vaut 1 chambre, pas 2).
// Le geocodage passe par l'API Adresse de l'Etat (gratuite, sans cle), appelee
// par le SERVEUR ; le `fetch` est injectable pour les tests (aucun reseau).

const TABLE = 'bien_profil'

// Les equipements qui impactent le prix (decision de Thierry du 5 octobre 2026).
const EQUIPEMENTS = {
  terrasse: 'Terrasse',
  spa: 'Jacuzzi ou spa',
  jardin: 'Jardin',
  piscine: 'Piscine',
  parking: 'Parking',
  vue: 'Vue exceptionnelle',
  climatisation: 'Climatisation',
}

const BORNES = {
  voyageurs: [1, 30],
  chambres: [0, 20],
  pieces: [1, 30],
  salles_de_bain: [0, 10],
}
const ADRESSE_MAX = 200

// Valide la saisie de l'hote. Rend { profil } ou { erreur } (message pour l'hote).
function validerProfil (saisie) {
  const s = saisie || {}
  if (s.adresse != null && typeof s.adresse !== 'string') return { erreur: 'L’adresse est illisible.' }
  const adresse = String(s.adresse == null ? '' : s.adresse).trim()
  if (!adresse) return { erreur: 'Indiquez l’adresse du logement.' }
  // L'API Adresse refuse une requete de moins de 3 caracteres (HTTP 400).
  if (adresse.length < 3) return { erreur: 'Adresse trop courte : précisez le numéro, la rue et la commune.' }
  if (adresse.length > ADRESSE_MAX) return { erreur: 'L’adresse est trop longue.' }
  const profil = { adresse }
  const LIBELLES = { voyageurs: 'Le nombre de voyageurs', chambres: 'Le nombre de chambres', pieces: 'Le nombre de pièces', salles_de_bain: 'Le nombre de salles de bain' }
  for (const [cle, [min, max]] of Object.entries(BORNES)) {
    // Un nombre saisi en texte : des CHIFFRES seulement (review : « 0x10 »,
    // « 1e1 » ou « 4.0 » passaient par Number()).
    const v = typeof s[cle] === 'string' ? (/^\s*\d+\s*$/.test(s[cle]) ? Number(s[cle]) : NaN) : s[cle]
    if (!Number.isInteger(v) || v < min || v > max) return { erreur: `${LIBELLES[cle]} doit être un nombre entier entre ${min} et ${max}.` }
    profil[cle] = v
  }
  if (profil.pieces < profil.chambres) return { erreur: 'Le nombre de pièces ne peut pas être inférieur au nombre de chambres.' }
  if (s.equipements != null && !Array.isArray(s.equipements)) return { erreur: 'La liste des équipements est illisible.' }
  const eq = Array.isArray(s.equipements) ? s.equipements : []
  const inconnus = eq.filter(e => !Object.prototype.hasOwnProperty.call(EQUIPEMENTS, e))
  if (inconnus.length) return { erreur: 'Un équipement coché est inconnu.' }
  profil.equipements = Object.keys(EQUIPEMENTS).filter(e => eq.includes(e))
  return { profil }
}

// ─── Le geocodage : l'API Adresse de l'Etat ─────────────────────────────────
const URL_ADRESSE = 'https://api-adresse.data.gouv.fr/search/'
const SCORE_MIN = 0.5
const DELAI_MS = 8000
// Une adresse precise : un numero, une rue ou un lieu-dit. Une commune seule
// (« municipality ») mettrait le bien a la mairie (review de a52b3e4).
const TYPES_PRECIS = ['housenumber', 'street', 'locality']

// Rend { latitude, longitude, adresse_trouvee, geocode_score } ou { erreur }.
async function geocoder (adresse, { fetch: f = globalThis.fetch, delaiMs = DELAI_MS } = {}) {
  const url = `${URL_ADRESSE}?q=${encodeURIComponent(adresse)}&limit=1`
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const minuterie = ctrl ? setTimeout(() => ctrl.abort(), delaiMs) : null
  let corps
  try {
    const r = await f(url, ctrl ? { signal: ctrl.signal } : {})
    if (!r || !r.ok) return { erreur: 'Le service des adresses ne répond pas. Réessayez dans un instant.', technique: `http ${r && r.status}` }
    corps = await r.json()
  } catch (e) {
    return { erreur: 'Le service des adresses ne répond pas. Réessayez dans un instant.', technique: e && e.name }
  } finally {
    if (minuterie) clearTimeout(minuterie)
  }
  const meilleur = corps && Array.isArray(corps.features) ? corps.features[0] : null
  const coords = meilleur && meilleur.geometry && Array.isArray(meilleur.geometry.coordinates) ? meilleur.geometry.coordinates : null
  const p = (meilleur && meilleur.properties) || {}
  const lng = coords ? Number(coords[0]) : NaN
  const lat = coords ? Number(coords[1]) : NaN
  const score = Number(p.score)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 ||
      !Number.isFinite(score) || score < SCORE_MIN || typeof p.label !== 'string' || !p.label) {
    return { erreur: 'Adresse introuvable : précisez-la (numéro, rue, commune).' }
  }
  if (!TYPES_PRECIS.includes(p.type)) {
    return { erreur: 'Adresse trop vague : indiquez le numéro et la rue (ou le lieu-dit), pas seulement la commune.' }
  }
  return {
    latitude: Math.round(lat * 1e6) / 1e6,
    longitude: Math.round(lng * 1e6) / 1e6,
    adresse_trouvee: String(p.label).slice(0, ADRESSE_MAX),
    geocode_score: Math.round(Math.min(1, score) * 1000) / 1000,
  }
}

// ─── Lecture et ecriture ────────────────────────────────────────────────────
const COLONNES = 'adresse, adresse_trouvee, latitude, longitude, geocode_score, voyageurs, chambres, pieces, salles_de_bain, equipements, maj_le'

async function lireProfil (supabase, propertyId) {
  const { data, error } = await supabase.from('bien_profil').select(COLONNES).eq('property_id', propertyId).limit(1)
  if (error) throw new Error(`[profil-bien] lecture : ${error.message}`)
  const l = (data || [])[0]
  if (!l) return null
  return { ...l, latitude: Number(l.latitude), longitude: Number(l.longitude), geocode_score: Number(l.geocode_score), equipements: Array.isArray(l.equipements) ? l.equipements : [] }
}

// Une ligne par bien : l'enregistrement remplace le profil precedent.
async function enregistrerProfil (supabase, { userId, propertyId, profil, geo }) {
  if (!userId || !propertyId) throw new Error('[profil-bien] compte et bien requis')
  const ligne = {
    user_id: userId, property_id: propertyId,
    adresse: profil.adresse, adresse_trouvee: geo.adresse_trouvee,
    latitude: geo.latitude, longitude: geo.longitude, geocode_score: geo.geocode_score,
    voyageurs: profil.voyageurs, chambres: profil.chambres, pieces: profil.pieces,
    salles_de_bain: profil.salles_de_bain, equipements: profil.equipements,
    maj_le: new Date().toISOString(),
  }
  const { error } = await supabase.from('bien_profil').upsert(ligne, { onConflict: 'property_id' })
  if (error) throw new Error(`[profil-bien] ecriture : ${error.message}`)
  return ligne
}

module.exports = { EQUIPEMENTS, BORNES, validerProfil, geocoder, lireProfil, enregistrerProfil, SCORE_MIN, TYPES_PRECIS, URL_ADRESSE, TABLE }
