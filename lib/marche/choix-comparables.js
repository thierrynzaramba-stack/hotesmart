// lib/marche/choix-comparables.js — LE CHOIX DES COMPARABLES PAR L'HOTE (etape B
// de « Choisir vos comparables », spec §20.3 de docs/kb/chantier-nouveau-bien.md).
//
// ⚠ WRITER UNIQUE des comparables retenus PAR LE PROPRIETAIRE dans
// `comparables_retenus` (table V2 existante, lue par lib/marche/etude.js).
// Valider rend actifs les biens coches et desactive les autres : on ne supprime
// rien, l'historique du choix reste.
// ⚠ PIPELINE DU MARCHE EMPRUNTE : rien ici ne touche l'historique des ventes.

const MIN_RETENUS = 3
const MAX_RETENUS = 25
const ID = /^[0-9]{1,24}$/

// Les parametres de la recherche AirROI, tires du profil decrit par l'hote.
function rechercheDuProfil (profil) {
  return {
    latitude: Number(profil.latitude),
    longitude: Number(profil.longitude),
    bedrooms: profil.chambres,
    baths: profil.salles_de_bain,
    guests: profil.voyageurs,
  }
}

// §22.1 : la position de l'hote par rapport a un comparable — de PETITES
// nuances entre biens de meme valeur percue.
const POSITIONS = ['dessous', 'equivalent', 'dessus']

// Verifie le choix contre la DERNIERE liste AirROI du profil. `choix` :
// [{ listing_id, position }]. Rend { ids, positions } ou { erreur } (message
// pour l'hote).
function validerChoix (choix, listeAirroi) {
  if (!Array.isArray(choix)) return { erreur: 'Choix illisible.' }
  // Une Map garde l'ordre de l'hote (un objet trierait les identifiants
  // numeriques).
  const parId = new Map()
  for (const c of choix) {
    const id = c && (typeof c.listing_id === 'string' || typeof c.listing_id === 'number') ? String(c.listing_id) : ''
    if (!ID.test(id) || !POSITIONS.includes(c.position)) return { erreur: 'Choix illisible.' }
    if (parId.has(id) && parId.get(id) !== c.position) return { erreur: 'Choix illisible.' }
    parId.set(id, c.position)
  }
  const ids = [...parId.keys()]
  const positions = Object.fromEntries(parId)
  if (ids.length < MIN_RETENUS) return { erreur: `Choisissez au moins ${MIN_RETENUS} biens comparables.` }
  if (ids.length > MAX_RETENUS) return { erreur: 'Trop de biens choisis.' }
  const proposes = new Set((Array.isArray(listeAirroi) ? listeAirroi : [])
    .map(f => f && f.listing_info && String(f.listing_info.listing_id)).filter(Boolean))
  // ⚠ Un identifiant hors de la liste proposee est REFUSE : l'hote choisit
  // parmi ce qu'on lui a montre, pas un bien arbitraire.
  if (ids.some(id => !proposes.has(id))) return { erreur: 'Un des biens choisis ne fait plus partie de la liste proposée : relancez la recherche.' }
  return { ids, positions }
}

// ⚠ LES CHOIX DU FONDATEUR SONT PRESERVES (review de 4f19d8b, C1) : valider
// (1) ajoute les biens nouveaux au nom du proprietaire, sans toucher une ligne
// existante ; (2) reactive les biens coches, en gardant leur provenance ;
// (3) ne desactive que les anciens choix DU PROPRIETAIRE. Une ligne posee par le
// fondateur, absente des 25 proposes, reste active : la decision de la retirer
// revient a Thierry.
// ⚠ DETTE (§20.6) : ces trois ecritures ne sont pas une transaction. Deux
// validations simultanees du meme bien peuvent s'entrelacer.
async function enregistrerChoix (supabase, { userId, propertyId, ids, positions = {} }) {
  if (!userId || !propertyId) throw new Error('[choix-comparables] compte et bien requis')
  if (!Array.isArray(ids) || ids.length < MIN_RETENUS || ids.some(id => !ID.test(id))) throw new Error('[choix-comparables] choix invalide')
  if (ids.some(id => !POSITIONS.includes(positions[id]))) throw new Error('[choix-comparables] position invalide')
  const lignes = ids.map(id => ({ user_id: userId, property_id: propertyId, listing_id: id, retenu_par: 'proprietaire', actif: true, position: positions[id] }))
  const a = await supabase.from('comparables_retenus').upsert(lignes, { onConflict: 'property_id,listing_id', ignoreDuplicates: true })
  if (a.error) throw new Error(`[choix-comparables] ecriture : ${a.error.message}`)
  const liste = `(${ids.join(',')})`
  // §22.1 : la position de l'hote, par groupe, AVANT la reactivation (review de
  // 1e64a2b : un echec au milieu laissait une ligne reactivee avec sa position
  // d'avant) ; jamais sur un retenu de l'equipe (position nulle).
  for (const pos of POSITIONS) {
    const ceux = ids.filter(id => positions[id] === pos)
    if (!ceux.length) continue
    const d = await supabase.from('comparables_retenus').update({ position: pos })
      .eq('property_id', propertyId).eq('retenu_par', 'proprietaire').in('listing_id', ceux)
    if (d.error) throw new Error(`[choix-comparables] position : ${d.error.message}`)
  }
  const b = await supabase.from('comparables_retenus').update({ actif: true })
    .eq('property_id', propertyId).in('listing_id', ids)
  if (b.error) throw new Error(`[choix-comparables] reactivation : ${b.error.message}`)
  const c = await supabase.from('comparables_retenus').update({ actif: false })
    .eq('property_id', propertyId).eq('retenu_par', 'proprietaire').not('listing_id', 'in', liste)
  if (c.error) throw new Error(`[choix-comparables] desactivation : ${c.error.message}`)
  return ids.length
}

// ─── Le quota des recherches NOUVELLES (reviews de 4f19d8b et 7ace057,
// SECURITE) ──────────────────────────────────────────────────────────────────
// Sans lui, un hote qui change son profil a chaque recherche paie 0,10 $ a
// chaque fois et peut vider le budget AirROI GLOBAL (10 $ par mois). Le quota
// est tenu par la fonction SQL `reserver_recherche_comparables` (migration
// 2026-10-05-comparables-recherches.sql) : elle COMPTE et RESERVE dans une meme
// transaction, sous verrou — lire puis payer ne l'etait pas, et 60 requetes
// paralleles passaient toutes. Compteur distinct du journal AirROI : les etudes
// du fondateur n'y entrent pas.
// §21.3 : le plafond mensuel est en DOLLARS (somme des couts reserves).
// §22.5 : les calendriers des comparables ont leur plafond, par bien sur 90 jours.
// Decisions de Thierry (5 octobre 2026) : 10 calendriers servent au calcul d'un
// bien ; le plafond SQL en laisse 15 sur 90 jours (marge pour un releve paye
// mais perdu) ; budget des hotes 25 $ par mois pour octobre 2026 (etait 15 $,
// decision du 6 octobre), toute la plateforme, a reevaluer (dette 53).
const CALENDRIERS_PAR_BIEN = 10
// §22.10 : une PAGE de la recherche des actifs = une recherche ; un bien en
// charge 5 au plus. Le plafond en dollars reste le garde-fou principal.
const QUOTA = { parBienJour: 5, parCompteJour: 10, parCompte30j: 20, calendriersBien90j: 15, budgetMoisUsd: 25 }
const MESSAGE_QUOTA = {
  bien: 'Plusieurs recherches ont déjà été lancées pour ce logement aujourd’hui. Réessayez demain.',
  compte: 'Plusieurs recherches ont déjà été lancées aujourd’hui. Réessayez demain.',
  compte_mois: 'Le nombre de recherches de ce mois est atteint pour votre compte. Réessayez plus tard.',
  mois: 'La recherche des biens du marché est momentanément indisponible. Réessayez plus tard.',
  calendriers: 'Les prix de vos comparables ont déjà été relevés plusieurs fois ce trimestre pour ce logement.',
}

// ─── La recherche des biens ACTIFS de meme valeur percue (§22.10) ──────────
// Les equipements RARES du profil, en identifiants AirROI filtrables. Terrasse,
// parking et climatisation sont courants : la liste des voisins les departage.
// La vue montagne n'existe pas dans le filtre AirROI.
// ⚠ VALEUR PERCUE IDENTIQUE (decision de Thierry) : jacuzzi = jacuzzi, un sauna
// seul ne compte pas. Chaque equipement est EXIGE (`all`) — sauf la vue, un
// GROUPE (mer, riviere, bord de l'eau, lac) dont un seul suffit (`any`).
const RARES_AIRROI = {
  spa: ['hot_tub'],
  piscine: ['pool'],
  jardin: ['backyard'],
  vue: ['ocean_view', 'river_view', 'waterfront', 'lake_access'],
}
const GROUPE_ANY = 'vue'
function equipementsRares (profil) {
  const eq = Array.isArray(profil && profil.equipements) ? profil.equipements : []
  return Object.keys(RARES_AIRROI).filter(k => eq.includes(k)).flatMap(k => RARES_AIRROI[k])
}

const PAGE = 10                 // AirROI refuse plus (HTTP 422 du 5 octobre 2026)
const PAGES_INITIALES = 2       // « Chercher » : 20 biens, 1 $
const PAGES_MAX = 5             // « Voir 10 de plus » : jusqu'a 50 biens
const RAYON_MILES = 6.2         // 10 km
// La ZONE : la position arrondie au centieme de degre (~1 km), pour que deux
// hotes voisins aient la MEME cle de cache (partagee, 90 jours, tous comptes).
const zone = v => Math.round(Number(v) * 100) / 100

// Le corps EXACT d'une page (une seule construction : la cle de cache de la
// route et l'appel du client en derivent). null si aucun equipement rare.
// Aucune donnee de compte : la cle se partage.
function corpsRechercheActifs (profil, page = 0) {
  const eq = Array.isArray(profil && profil.equipements) ? profil.equipements : []
  const all = Object.keys(RARES_AIRROI).filter(k => k !== GROUPE_ANY && eq.includes(k)).flatMap(k => RARES_AIRROI[k])
  const any = eq.includes(GROUPE_ANY) ? RARES_AIRROI[GROUPE_ANY] : []
  if (!all.length && !any.length) return null
  if (!(Number.isInteger(page) && page >= 0 && page < PAGES_MAX)) throw new Error(`[choix-comparables] page invalide : ${page}`)
  const amenities = {}
  if (all.length) amenities.all = all
  if (any.length) amenities.any = any
  return {
    latitude: zone(profil.latitude), longitude: zone(profil.longitude), radius_miles: RAYON_MILES,
    filter: {
      amenities,
      bedrooms: { eq: profil.chambres },
      guests: { range: [Math.max(1, profil.voyageurs - 2), profil.voyageurs + 2] },
      room_type: { eq: 'entire_home' },
      ttm_days_booked: { gte: 10 },
      l90d_available_days: { gte: 1 },
    },
    sort: { ttm_revenue: 'desc' },
    pagination: { page_size: PAGE, offset: page * PAGE },
  }
}

// Les couts reserves au quota (§21.3), en dollars : ceux du tarif AirROI.
const COUTS = { base: 0.10, page: 0.50, calendrier: 0.10 }

module.exports = { CALENDRIERS_PAR_BIEN, POSITIONS, rechercheDuProfil, validerChoix, enregistrerChoix, equipementsRares, corpsRechercheActifs, RARES_AIRROI, PAGE, PAGES_INITIALES, PAGES_MAX, RAYON_MILES, COUTS, QUOTA, MESSAGE_QUOTA, MIN_RETENUS, MAX_RETENUS }
