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

// Verifie le choix contre la DERNIERE liste AirROI du profil. Rend { ids } ou
// { erreur } (message pour l'hote).
function validerChoix (listingIds, listeAirroi) {
  if (!Array.isArray(listingIds)) return { erreur: 'Choix illisible.' }
  const ids = [...new Set(listingIds.map(v => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')))]
  if (ids.some(id => !ID.test(id))) return { erreur: 'Choix illisible.' }
  if (ids.length < MIN_RETENUS) return { erreur: `Choisissez au moins ${MIN_RETENUS} biens comparables.` }
  if (ids.length > MAX_RETENUS) return { erreur: 'Trop de biens choisis.' }
  const proposes = new Set((Array.isArray(listeAirroi) ? listeAirroi : [])
    .map(f => f && f.listing_info && String(f.listing_info.listing_id)).filter(Boolean))
  // ⚠ Un identifiant hors de la liste proposee est REFUSE : l'hote choisit
  // parmi ce qu'on lui a montre, pas un bien arbitraire.
  if (ids.some(id => !proposes.has(id))) return { erreur: 'Un des biens choisis ne fait plus partie de la liste proposée : relancez la recherche.' }
  return { ids }
}

// ⚠ LES CHOIX DU FONDATEUR SONT PRESERVES (review de 4f19d8b, C1) : valider
// (1) ajoute les biens nouveaux au nom du proprietaire, sans toucher une ligne
// existante ; (2) reactive les biens coches, en gardant leur provenance ;
// (3) ne desactive que les anciens choix DU PROPRIETAIRE. Une ligne posee par le
// fondateur, absente des 25 proposes, reste active : la decision de la retirer
// revient a Thierry.
// ⚠ DETTE (§20.6) : ces trois ecritures ne sont pas une transaction. Deux
// validations simultanees du meme bien peuvent s'entrelacer.
async function enregistrerChoix (supabase, { userId, propertyId, ids }) {
  if (!userId || !propertyId) throw new Error('[choix-comparables] compte et bien requis')
  if (!Array.isArray(ids) || ids.length < MIN_RETENUS || ids.some(id => !ID.test(id))) throw new Error('[choix-comparables] choix invalide')
  const lignes = ids.map(id => ({ user_id: userId, property_id: propertyId, listing_id: id, retenu_par: 'proprietaire', actif: true }))
  const a = await supabase.from('comparables_retenus').upsert(lignes, { onConflict: 'property_id,listing_id', ignoreDuplicates: true })
  if (a.error) throw new Error(`[choix-comparables] ecriture : ${a.error.message}`)
  const liste = `(${ids.join(',')})`
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
const QUOTA = { parBienJour: 3, parCompteJour: 5, parCompte30j: 10, budgetMoisUsd: 5 }
const MESSAGE_QUOTA = {
  bien: 'Plusieurs recherches ont déjà été lancées pour ce logement aujourd’hui. Réessayez demain.',
  compte: 'Plusieurs recherches ont déjà été lancées aujourd’hui. Réessayez demain.',
  compte_mois: 'Le nombre de recherches de ce mois est atteint pour votre compte. Réessayez plus tard.',
  mois: 'La recherche des biens du marché est momentanément indisponible. Réessayez plus tard.',
}

// ─── La recherche complementaire par equipement (§21.2) ─────────────────────
// Les equipements RARES du profil, en identifiants AirROI filtrables. Terrasse,
// parking et climatisation sont courants : la liste de base les departage. La
// vue montagne n'existe pas dans le filtre AirROI.
const RARES_AIRROI = {
  spa: ['hot_tub', 'sauna'],
  piscine: ['pool'],
  jardin: ['backyard'],
  vue: ['ocean_view', 'river_view', 'waterfront', 'lake_access'],
}
function equipementsRares (profil) {
  const eq = Array.isArray(profil && profil.equipements) ? profil.equipements : []
  return Object.keys(RARES_AIRROI).filter(k => eq.includes(k)).flatMap(k => RARES_AIRROI[k])
}
// Le corps EXACT de la recherche (une seule construction : la cle de cache de
// la route et l'appel du client en derivent). null si aucun equipement rare.
function corpsRechercheEquipements (profil) {
  const any = equipementsRares(profil)
  if (!any.length) return null
  return {
    latitude: Number(profil.latitude), longitude: Number(profil.longitude), radius_miles: 3,
    filter: { amenities: { any }, guests: { range: [Math.max(1, profil.voyageurs - 2), profil.voyageurs + 2] } },
    pagination: { page_size: 10, offset: 0 },
  }
}

// Les couts reserves au quota (§21.3), en dollars : ceux du tarif AirROI.
const COUTS = { base: 0.10, equipements: 0.50 }

module.exports = { rechercheDuProfil, validerChoix, enregistrerChoix, equipementsRares, corpsRechercheEquipements, RARES_AIRROI, COUTS, QUOTA, MESSAGE_QUOTA, MIN_RETENUS, MAX_RETENUS }
