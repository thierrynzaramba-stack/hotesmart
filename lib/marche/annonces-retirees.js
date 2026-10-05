// lib/marche/annonces-retirees.js — LES ANNONCES RETIREES D'AIRBNB (spec §22.9
// de docs/kb/chantier-nouveau-bien.md). WRITER UNIQUE de
// `airroi_annonces_retirees`.
//
// Une annonce dont le calendrier en ligne repond 404 chez AirROI n'existe plus
// (recette du 5 octobre 2026 : Airbnb repondait 410 sur la meme annonce). Elle
// l'est pour TOUS les biens : elle ne s'affiche plus, ne se choisit plus, ne
// compte plus, ne se releve plus. Aucun prix.

const TABLE = 'airroi_annonces_retirees'
const ID = /^[0-9]{1,24}$/
// ⚠ Un constat VIEILLIT (review de b83823a, SECURITE) : au-dela de 30 jours,
// l'annonce redevient visible et se re-verifie au prochain releve (gratuit si
// elle est toujours introuvable). Un 404 passager d'AirROI ne cache donc pas
// une annonce vivante pour toujours.
const VALIDITE_JOURS = 30

// Les annonces retirees parmi `ids` : un Set. Les identifiants sont numeriques
// (valides ici), donc sans guillemet ni virgule pour `.in()`.
async function annoncesRetirees (supabase, ids, maintenant = new Date()) {
  const sures = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(id => ID.test(id)))]
  if (!sures.length) return new Set()
  const { data, error } = await supabase.from('airroi_annonces_retirees').select('listing_id').in('listing_id', sures)
    .gte('constatee_le', new Date(maintenant - VALIDITE_JOURS * 86400000).toISOString())
  if (error) throw new Error(`${TABLE} : ${error.message}`)
  return new Set((data || []).map(l => String(l.listing_id)))
}

// Le constat. Deja note : la date est rafraichie (le constat repart pour 30 jours).
async function noterRetiree (supabase, listingId, http, maintenant = new Date()) {
  const id = String(listingId)
  if (!ID.test(id) || !(Number.isInteger(http) && http >= 400 && http <= 499)) return false
  const { error } = await supabase.from('airroi_annonces_retirees').upsert({ listing_id: id, http, constatee_le: maintenant.toISOString() }, { onConflict: 'listing_id' })
  if (error) throw new Error(`${TABLE} : ${error.message}`)
  return true
}

// L'identifiant d'une fiche AirROI (liste de base ou recherche par equipement).
const idFiche = f => (f && f.listing_info && f.listing_info.listing_id != null ? String(f.listing_info.listing_id) : null)

// Une liste de fiches, sans les annonces retirees. null reste null (« a faire »).
async function sansRetirees (supabase, fiches) {
  if (!Array.isArray(fiches)) return fiches
  const retirees = await annoncesRetirees(supabase, fiches.map(idFiche).filter(Boolean))
  return retirees.size ? fiches.filter(f => !retirees.has(idFiche(f))) : fiches
}

module.exports = { annoncesRetirees, noterRetiree, sansRetirees, TABLE, VALIDITE_JOURS }
