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

async function enregistrerChoix (supabase, { userId, propertyId, ids }) {
  if (!userId || !propertyId) throw new Error('[choix-comparables] compte et bien requis')
  if (!Array.isArray(ids) || ids.length < MIN_RETENUS || ids.some(id => !ID.test(id))) throw new Error('[choix-comparables] choix invalide')
  const lignes = ids.map(id => ({ user_id: userId, property_id: propertyId, listing_id: id, retenu_par: 'proprietaire', actif: true }))
  const a = await supabase.from('comparables_retenus').upsert(lignes, { onConflict: 'property_id,listing_id' })
  if (a.error) throw new Error(`[choix-comparables] ecriture : ${a.error.message}`)
  // Les autres biens de ce logement ne sont plus retenus (desactives, gardes).
  const b = await supabase.from('comparables_retenus').update({ actif: false })
    .eq('property_id', propertyId).not('listing_id', 'in', `(${ids.join(',')})`)
  if (b.error) throw new Error(`[choix-comparables] desactivation : ${b.error.message}`)
  return ids.length
}

module.exports = { rechercheDuProfil, validerChoix, enregistrerChoix, MIN_RETENUS, MAX_RETENUS }
